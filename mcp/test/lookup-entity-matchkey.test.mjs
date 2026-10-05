// C4 (memory-recall hypergraph) — lookup must agree with SCORING on identity.
//
// Run: node test/lookup-entity-matchkey.test.mjs
// Prints `ok - <name>` per assertion; exits non-zero on the FIRST failure.
//
// WHAT THIS PINS
//   entitiesByCanonicalId is keyed on the exact `kind:source:slug` id, so
//   lookupByEntity("file:git-log:X") cannot see the same artifact stamped as
//   "file:telegram:X" — while multi-feature-score.js:577 (entityMatchKey)
//   already collapses source and scores the two as ONE entity. The recall
//   query side stamps a fixed source ("chat-claude-code"), so exact lookup was
//   structurally unable to reach the ~87% of facts that arrived through other
//   connectors. lookupByEntityMatchKey closes that, behind
//   MEMORY_RECALL_ENTITY_MATCHKEY_LOOKUP (default OFF).
//
//   Cases:
//     (a) an id stamped under a DIFFERENT source is found by match-key and NOT
//         by lookupByEntity;
//     (b) flag OFF => match-key lookup is deep-equal to lookupByEntity on that
//         same fixture, AND no derived map is constructed (build-counter probe);
//     (c) a malformed index throws TypeError from BOTH functions;
//     (d) ids duplicated across two source buckets appear once, in
//         first-occurrence (ledger) order;
//     (e) addToIndex after a memoized flag-ON lookup is reflected in the next
//         lookup — the memo is invalidated by the in-place mutation.
//
// HERMETICITY (standing C-NEW-2 discipline): MEMORY_ROOT + sub-dirs are set to
// mkdtemp paths BEFORE any dynamic import, so the transitive config.js import
// can never resolve at the real root. This suite otherwise touches NO fs at
// all: fixtures are hand-built in-memory Maps. The live 2.9 GB
// ledgers/memory.jsonl and the 33.7 MB storage/entity-index.cache.json are
// never opened, for read or write.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "memsys-matchkey-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.on("exit", () => {
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

// Start from a known flag state regardless of the caller's environment.
delete process.env.MEMORY_RECALL_ENTITY_MATCHKEY_LOOKUP;

const { addToIndex, lookupByEntity, lookupByEntityMatchKey, __internal } =
  await import("../lib/synthesis/entity-index.js");
const { entityMatchKey } = await import("../lib/recall/multi-feature-score.js");

// ---------------------------------------------------------------------------
// Fail-fast harness: print `ok - <name>` per assertion, exit 1 on the first
// failure so the offending case is the last thing on screen.
// ---------------------------------------------------------------------------
function run(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`not ok - ${name}`);
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
  console.log(`ok - ${name}`);
}

const flagOn = () => {
  process.env.MEMORY_RECALL_ENTITY_MATCHKEY_LOOKUP = "1";
};
const flagOff = () => {
  delete process.env.MEMORY_RECALL_ENTITY_MATCHKEY_LOOKUP;
};

// The recall query side hardcodes this source (recall.js), while fact-side ids
// carry whichever connector ingested the row.
const SLUG = "mcp/lib/tools/recall.js";
const QUERY_ID = `file:chat-claude-code:${SLUG}`;
const GITLOG_ID = `file:git-log:${SLUG}`;
const TELEGRAM_ID = `file:telegram:${SLUG}`;

/** A fresh index whose entity buckets are stamped under NON-query sources. */
function crossSourceIndex() {
  return {
    entitiesByCanonicalId: new Map([
      [GITLOG_ID, ["m1", "m2"]],
      ["person:telegram:alice", ["m3"]],
    ]),
  };
}

// ---------------------------------------------------------------------------
// Precondition: the fixture ids really do collapse onto one key, and really
// are distinct exact keys. If entityMatchKey ever stopped collapsing source,
// every case below would pass vacuously.
// ---------------------------------------------------------------------------
run("precondition: query id and git-log id share a match key but differ exactly", () => {
  assert.notEqual(QUERY_ID, GITLOG_ID);
  assert.equal(entityMatchKey(QUERY_ID), entityMatchKey(GITLOG_ID));
  assert.equal(entityMatchKey(QUERY_ID), `file:${SLUG}`);
});

// ---------------------------------------------------------------------------
// (a) Cross-source hit — the whole point of the node.
// ---------------------------------------------------------------------------
run("(a) flag ON: an id stamped under a DIFFERENT source is found by match key", () => {
  const index = crossSourceIndex();
  assert.deepEqual(
    lookupByEntity(index, QUERY_ID),
    [],
    "exact lookup must MISS the differently-sourced id (this is the defect)",
  );
  flagOn();
  try {
    assert.deepEqual(lookupByEntityMatchKey(index, QUERY_ID), ["m1", "m2"]);
  } finally {
    flagOff();
  }
});

run("(a2) flag ON: an unknown key still returns [] and never throws", () => {
  const index = crossSourceIndex();
  flagOn();
  try {
    assert.deepEqual(lookupByEntityMatchKey(index, "file:git-log:nope.js"), []);
    assert.deepEqual(lookupByEntityMatchKey(index, ""), []);
    assert.deepEqual(lookupByEntityMatchKey(index, null), []);
  } finally {
    flagOff();
  }
});

run("(a3) flag ON: the returned array is a defensive copy", () => {
  const index = crossSourceIndex();
  flagOn();
  try {
    const first = lookupByEntityMatchKey(index, QUERY_ID);
    first.push("MUTATED");
    assert.deepEqual(lookupByEntityMatchKey(index, QUERY_ID), ["m1", "m2"]);
  } finally {
    flagOff();
  }
});

// ---------------------------------------------------------------------------
// (b) Flag OFF is observationally identical to today, and costs nothing.
// ---------------------------------------------------------------------------
run("(b) flag OFF: match-key lookup deep-equals lookupByEntity, and builds NO derived map", () => {
  const index = crossSourceIndex();
  flagOff();
  const before = __internal.matchKeyDeriveCount();
  for (const id of [QUERY_ID, GITLOG_ID, "person:telegram:alice", "absent:x:y", "n1"]) {
    assert.deepEqual(
      lookupByEntityMatchKey(index, id),
      lookupByEntity(index, id),
      `flag-OFF divergence on ${id}`,
    );
  }
  assert.equal(
    __internal.matchKeyDeriveCount(),
    before,
    "flag-OFF path must not construct the derived match-key map",
  );
});

// ---------------------------------------------------------------------------
// (c) Guard parity with lookupByEntity.
// ---------------------------------------------------------------------------
run("(c) malformed index throws TypeError from BOTH functions, flag ON and OFF", () => {
  for (const bad of [null, undefined, {}, { entitiesByCanonicalId: {} }]) {
    assert.throws(() => lookupByEntity(bad, QUERY_ID), TypeError);
    flagOff();
    assert.throws(() => lookupByEntityMatchKey(bad, QUERY_ID), TypeError);
    flagOn();
    try {
      assert.throws(() => lookupByEntityMatchKey(bad, QUERY_ID), TypeError);
    } finally {
      flagOff();
    }
  }
});

// ---------------------------------------------------------------------------
// (d) Merge order + dedup across the source buckets that collapse onto one key.
// ---------------------------------------------------------------------------
run("(d) flag ON: ids duplicated across two sources appear once, in first-occurrence order", () => {
  // Insertion order IS ledger order (a bucket is created on first mention).
  // "m2" is shared; it must keep its git-log (earlier) position.
  const index = {
    entitiesByCanonicalId: new Map([
      [GITLOG_ID, ["m1", "m2"]],
      [TELEGRAM_ID, ["m2", "m3"]],
      [QUERY_ID, ["m4"]],
    ]),
  };
  flagOn();
  try {
    assert.deepEqual(lookupByEntityMatchKey(index, QUERY_ID), [
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    // Every exact source spelling resolves to the same merged bucket.
    assert.deepEqual(
      lookupByEntityMatchKey(index, TELEGRAM_ID),
      lookupByEntityMatchKey(index, QUERY_ID),
    );
  } finally {
    flagOff();
  }
});

// ---------------------------------------------------------------------------
// (e) Memo invalidation — the derived map is keyed on the source Map OBJECT,
// which addToIndex mutates IN PLACE.
// ---------------------------------------------------------------------------
run("(e) flag ON: addToIndex after a memoized lookup is reflected in the next lookup", () => {
  const index = crossSourceIndex();
  flagOn();
  try {
    // 1. Memoize.
    assert.deepEqual(lookupByEntityMatchKey(index, QUERY_ID), ["m1", "m2"]);
    const afterFirst = __internal.matchKeyDeriveCount();
    // 2. A repeat lookup must HIT the memo (no rebuild) — otherwise (e) would
    //    pass for the wrong reason.
    lookupByEntityMatchKey(index, QUERY_ID);
    assert.equal(
      __internal.matchKeyDeriveCount(),
      afterFirst,
      "repeat lookup must reuse the memo",
    );
    // 3. Mutate in place under a THIRD source, then look up again.
    addToIndex(index, "m9", [{ canonical_id: TELEGRAM_ID }]);
    assert.deepEqual(
      lookupByEntityMatchKey(index, QUERY_ID),
      ["m1", "m2", "m9"],
      "stale memo: addToIndex must invalidate the derived match-key map",
    );
    assert.equal(
      __internal.matchKeyDeriveCount(),
      afterFirst + 1,
      "the post-mutation lookup must have re-derived exactly once",
    );
  } finally {
    flagOff();
  }
});

console.log("\nall lookup-entity-matchkey tests passed");
