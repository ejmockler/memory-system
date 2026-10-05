// W3 — close match-key memo staleness vector 2.
//
// Reproduces the production shape: loadOrRebuildIndex returns a wrapper around
// a module-cached entitiesByCanonicalId Map, then append-aware projection folds
// a new ledger tail into that SAME Map object. A flag-ON lookup memoized before
// the append must see the new cross-source id and re-derive exactly once.
//
// Hermetic: every read/write is under a fresh tmp directory. The live 2.9 GB
// memory.jsonl and live entity index are never opened or mutated.

import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "memsys-matchkey-invalidation-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
delete process.env.MEMORY_RECALL_ENTITY_MATCHKEY_LOOKUP;
delete process.env.ENTITY_INDEX_CHECKPOINT_CACHE;

process.on("exit", () => {
  delete process.env.MEMORY_RECALL_ENTITY_MATCHKEY_LOOKUP;
  delete process.env.ENTITY_INDEX_CHECKPOINT_CACHE;
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

const {
  __internal,
  _resetEntityIndexCache,
  loadOrRebuildIndex,
  lookupByEntity,
  lookupByEntityMatchKey,
  rebuildEntityIndex,
} = await import("../lib/synthesis/entity-index.js");

const ledgerPath = join(TEST_ROOT, "ledgers", "memory.jsonl");
const slug = "mcp/lib/tools/recall.js";
const queryId = `file:chat-claude-code:${slug}`;
const gitId = `file:git-log:${slug}`;
const telegramId = `file:telegram:${slug}`;

function row(id, canonicalId) {
  return `${JSON.stringify({
    id,
    features: { entities: [{ canonical_id: canonicalId }] },
  })}\n`;
}

function ok(name) {
  console.log(`ok - ${name}`);
}

// Start with one fact under a non-query source and populate the append-aware
// module cache. No disk-cache path is supplied: this isolates the in-memory
// projection/memo interaction reproduced by the reviewer.
_resetEntityIndexCache();
writeFileSync(ledgerPath, row("m1", gitId), { mode: 0o600 });
const first = await loadOrRebuildIndex({ ledgerPath });

// DEFAULT-OFF proof is byte-level, not merely semantic: the new lookup's JSON
// bytes are exactly the legacy exact-key lookup bytes, and no derived map is
// allocated.
const derivesBeforeFlagOff = __internal.matchKeyDeriveCount();
const legacyOffBytes = Buffer.from(JSON.stringify(lookupByEntity(first, gitId)));
const matchKeyOffBytes = Buffer.from(
  JSON.stringify(lookupByEntityMatchKey(first, gitId)),
);
assert.equal(
  Buffer.compare(matchKeyOffBytes, legacyOffBytes),
  0,
  "flag-OFF lookup bytes diverged from lookupByEntity",
);
assert.equal(
  __internal.matchKeyDeriveCount(),
  derivesBeforeFlagOff,
  "flag-OFF lookup must not build the retained +84.4 MB derived twin",
);
ok("flag OFF is byte-identical and allocates no derived map");

// Memoize the PRE-APPEND result, then prove a repeat hits the memo.
process.env.MEMORY_RECALL_ENTITY_MATCHKEY_LOOKUP = "1";
assert.deepEqual(lookupByEntityMatchKey(first, queryId), ["m1"]);
const derivesAfterFirst = __internal.matchKeyDeriveCount();
assert.deepEqual(lookupByEntityMatchKey(first, queryId), ["m1"]);
assert.equal(
  __internal.matchKeyDeriveCount(),
  derivesAfterFirst,
  "precondition failed: repeat lookup did not reuse the memo",
);
ok("precondition: flag-ON pre-append result is memoized");

// This second load takes append-aware-ledger-projection's warm grow branch and
// mutates first.entitiesByCanonicalId IN PLACE through applyRow -> pushEntry.
appendFileSync(ledgerPath, row("m2", telegramId));
const second = await loadOrRebuildIndex({ ledgerPath });
assert.strictEqual(
  second.entitiesByCanonicalId,
  first.entitiesByCanonicalId,
  "precondition failed: warm load did not reuse the same Map object",
);
assert.deepEqual(
  lookupByEntityMatchKey(second, queryId),
  ["m1", "m2"],
  "stale memo served the PRE-APPEND match-key result",
);
assert.equal(
  __internal.matchKeyDeriveCount(),
  derivesAfterFirst + 1,
  "post-append lookup must re-derive exactly once",
);
ok("warm same-Map tail merge invalidates and re-derives the match-key memo");

// Flag-off tail-merge output itself is byte-identical to a clean full rebuild,
// pinning that the unconditional no-memo delete changes no index bytes.
delete process.env.MEMORY_RECALL_ENTITY_MATCHKEY_LOOKUP;
const warmBytes = Buffer.from(
  JSON.stringify([...second.entitiesByCanonicalId.entries()]),
);
const rebuilt = await rebuildEntityIndex({ ledgerPath });
const rebuildBytes = Buffer.from(
  JSON.stringify([...rebuilt.entitiesByCanonicalId.entries()]),
);
assert.equal(
  Buffer.compare(warmBytes, rebuildBytes),
  0,
  "flag-OFF warm projection bytes diverged from a full rebuild",
);
ok("flag-OFF warm projection bytes equal full-rebuild bytes");

// The diagnostic hook shares production target validation. A mis-keyed or
// unavailable hand-off is a named programming error, never a silent no-op.
assert.throws(
  () => __internal.invalidateMatchKeyMemo({ entitiesByCanonicalID: new Map() }),
  (err) =>
    err instanceof TypeError &&
    err.message ===
      "invalidateMatchKeyMemo: index missing entitiesByCanonicalId Map",
);
ok("mis-keyed invalidation hand-off fails loud with a named TypeError");

console.log("\nall matchkey-memo-invalidation tests passed");
