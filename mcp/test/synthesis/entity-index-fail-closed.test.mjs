// entity-index-fail-closed.test.mjs — B1c3: entity-index mirror of the
// time-index B1c/B1c2 fail-closed policy (readError gate, skipped-row gate,
// statLedgerMtime errno separation).
//
// RED-RUN ISOLATION: every pre-fix reproduction below was executed against a
// scratchpad COPY of lib/synthesis/entity-index.js (plus its pre-fix
// _ledger-stream.js / append-aware-ledger-projection.js siblings), never by
// reverting the live tree.
//
// PRE-FIX FAILURES, recorded 2026-07-14 (this file run via `node --test`
// against the pre-fix scratchpad copy — readError and skipped ignored,
// statLedgerMtime swallowing every stat errno as null, maxLineBytes not
// injectable), verbatim:
//
//   ✔ leg (a): MISSING ledger yields an empty index without throwing (cold start preserved) (1.218417ms)
//   ✖ leg (b): parent-dir chmod 000 makes rebuild/loadOrRebuild reject, no cache persisted (1.076666ms)
//     AssertionError [ERR_ASSERTION]: Missing expected rejection: rebuildEntityIndex
//     resolved on an unreadable ledger (fail-open: poisoned empty index)
//       actual: undefined, expected: /ledger read failed/, operator: 'rejects'
//   ✖ leg (c): oversized valid row makes rebuildEntityIndex reject (no silent partial index) (0.594666ms)
//     AssertionError [ERR_ASSERTION]: Missing expected rejection: rebuildEntityIndex
//     resolved despite a skipped oversized row (silent partial index)
//       actual: undefined, expected: /refusing to project a partial index/, operator: 'rejects'
//   ✖ leg (d): statLedgerMtime returns null on ENOENT but throws on chmod-000 parent (0.109125ms)
//     AssertionError [ERR_ASSERTION]: entity-index must export __internal.statLedgerMtime for this gate
//       actual: undefined, expected: true, operator: '=='
//   ℹ tests 4 / pass 1 / fail 3
//   EXIT=1
//
// Companion pre-fix probe (same scratchpad copy, run separately since the
// assert.rejects legs abort before the poisoning is observable) proved the
// FULL chain — empty index resolved with ledgerMtime 0 AND persisted as a
// cache, and an oversized row silently dropped from a resolving rebuild:
//
//   rebuildEntityIndex resolved; entitiesByCanonicalId.size = 0 ; ledgerMtime = 0
//     (statLedgerMtime swallowed EACCES as null)
//   cache persisted: true ; cache bytes: {"schema_version":"v1","ledger_mtime_ms":0,
//     "entries":{},"built_at":"2026-07-14T09:37:12.388Z"}
//   oversized-row rebuild resolved; indexed canonical_ids = person:test:small ;
//     mem-oversized indexed: false
//   EXIT=0
//
// Four legs (mirroring test/time-index-stream.test.mjs legs (a)-(d)):
//   (a) BEHAVIOR PRESERVATION — a MISSING ledger still yields an empty index
//       with ledgerMtime 0, no throw (cold start; ENOENT ≠ unreadable).
//   (b) FAIL-CLOSED READ — an EXISTING ledger behind a chmod-000 parent makes
//       rebuildEntityIndex and loadOrRebuildIndex reject; NO cache file and no
//       *.tmp debris persisted. FAILED pre-fix (resolve-and-persist).
//   (c) SKIPPED-ROW GATE — a valid JSON line over an injected small
//       maxLineBytes must reject rather than silently drop (partial index).
//       FAILED pre-fix (silent drop).
//   (d) STAT-ERRNO GATE — __internal.statLedgerMtime returns null ONLY on
//       ENOENT; any other errno throws /ledger stat failed/. FAILED pre-fix
//       (every errno swallowed as null → ledgerMtime 0).
//
// Run: cd mcp && node --test test/synthesis/entity-index-fail-closed.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import * as EI from "../../lib/synthesis/entity-index.js";

const {
  rebuildEntityIndex,
  loadOrRebuildIndex,
  _resetEntityIndexCache,
} = EI;

// Hermetic temp root — the real ledger / real storage caches are NEVER touched.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "b1c3-entity-index-"));

after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** Write a JSONL ledger under TMP_ROOT (rows: objects stringified, raw strings
 *  verbatim). Returns the absolute path. */
function writeLedger(name, rows) {
  const dir = join(TMP_ROOT, "ledgers");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const text = rows
    .map((r) => (typeof r === "string" ? r : JSON.stringify(r)))
    .join("\n") + "\n";
  writeFileSync(path, text, "utf8");
  return path;
}

/** Build a fact row carrying features.entities[]. */
function makeRow(id, canonicalIds, extras = {}) {
  return {
    id,
    kind: "fact",
    ts: "2026-06-18T00:00:00Z",
    content: extras.content || `content for ${id}`,
    features: {
      entities: canonicalIds.map((cid) => ({ kind: "person", canonical_id: cid, surface: cid })),
    },
  };
}

// ---------------------------------------------------------------------------
// Leg (a) — behavior preservation: MISSING ledger stays a cold start
// ---------------------------------------------------------------------------

test("leg (a): MISSING ledger yields an empty index without throwing (cold start preserved)", async () => {
  const ledgerPath = join(TMP_ROOT, "ledgers", "does-not-exist.jsonl");
  assert.equal(existsSync(ledgerPath), false);

  const idx = await rebuildEntityIndex({ ledgerPath });
  assert.equal(idx.entitiesByCanonicalId.size, 0);
  assert.equal(idx.ledgerMtime, 0);
});

// ---------------------------------------------------------------------------
// Leg (b) — unreadable ledger (chmod-000 parent) must reject, persist NOTHING
// ---------------------------------------------------------------------------

test("leg (b): parent-dir chmod 000 makes rebuild/loadOrRebuild reject, no cache persisted", async () => {
  // Root guard: chmod 000 is a no-op for uid 0, which would make this gate
  // silently pass. A silently-passing gate is forbidden.
  if (process.getuid && process.getuid() === 0) {
    assert.fail("cannot run as root: chmod 000 is a no-op, gate would not gate");
  }

  const parentDir = join(TMP_ROOT, "locked-parent");
  mkdirSync(parentDir, { recursive: true });
  const ledgerPath = join(parentDir, "ledger.jsonl");
  writeFileSync(
    ledgerPath,
    JSON.stringify(makeRow("mem-behind-wall", ["person:test:walled"])) + "\n",
    "utf8",
  );
  const cacheDir = join(TMP_ROOT, "cache-leg-b");
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, "entity-index.cache.json");

  _resetEntityIndexCache();
  chmodSync(parentDir, 0o000);
  try {
    await assert.rejects(
      rebuildEntityIndex({ ledgerPath, cachePath }),
      /ledger read failed/,
      "rebuildEntityIndex resolved on an unreadable ledger (fail-open: poisoned empty index)",
    );
    // loadOrRebuildIndex reaches the same gates through the append-aware
    // projection's fullRebuild fallback (its swallow → null → rebuild path).
    await assert.rejects(
      loadOrRebuildIndex({ ledgerPath, cachePath }),
      /ledger read failed|ledger stat failed/,
      "loadOrRebuildIndex resolved on an unreadable ledger",
    );
    assert.equal(
      existsSync(cachePath),
      false,
      "cache file was persisted from an unreadable ledger (poisoned fingerprint-valid cache)",
    );
    const cacheBase = basename(cachePath);
    const tmpLeftovers = readdirSync(dirname(cachePath)).filter(
      (f) => f.startsWith(cacheBase) && f !== cacheBase,
    );
    assert.deepEqual(tmpLeftovers, [], "tmp-file debris left in cache dir");
  } finally {
    // Restore perms so the after() rmSync of TMP_ROOT can clean up, and drop
    // any module-scope projection state this leg created.
    chmodSync(parentDir, 0o700);
    _resetEntityIndexCache();
  }
});

// ---------------------------------------------------------------------------
// Leg (c) — oversized valid row under injected maxLineBytes must reject
// ---------------------------------------------------------------------------
//
// _ledger-stream.js counts an over-maxLineBytes line in counts.skipped WITHOUT
// setting readError, so pre-fix rebuildEntityIndex resolved with a
// fingerprint-VALID PARTIAL index. A small injected maxLineBytes makes the
// gate falsifiable without an >8MiB fixture asset (companion probe above
// proved the same drop at the real 8MiB default with a 9MB row).

test("leg (c): oversized valid row makes rebuildEntityIndex reject (no silent partial index)", async () => {
  const MAX_LINE_BYTES = 256;
  const bigRow = makeRow("mem-oversized", ["person:test:oversized"], {
    content: "x".repeat(MAX_LINE_BYTES * 2), // one VALID JSON line > cap
  });
  assert.ok(
    JSON.stringify(bigRow).length > MAX_LINE_BYTES,
    "fixture row must exceed the injected cap",
  );
  const ledgerPath = writeLedger("oversized.jsonl", [
    makeRow("mem-small", ["person:test:small"]),
    bigRow,
  ]);

  await assert.rejects(
    rebuildEntityIndex({ ledgerPath, maxLineBytes: MAX_LINE_BYTES }),
    /refusing to project a partial index/,
    "rebuildEntityIndex resolved despite a skipped oversized row (silent partial index)",
  );
});

// ---------------------------------------------------------------------------
// Leg (d) — statLedgerMtime errno separation (ENOENT null, others throw)
// ---------------------------------------------------------------------------
//
// In entity-index the stat runs AFTER the stream (the fingerprint must
// reflect the consumed state), so the public rebuild surface rejects on the
// readError gate first — the errno separation is therefore pinned directly
// via the __internal test hook (same precedent as time-index's __internal).

test("leg (d): statLedgerMtime returns null on ENOENT but throws on chmod-000 parent", () => {
  if (process.getuid && process.getuid() === 0) {
    assert.fail("cannot run as root: chmod 000 is a no-op, gate would not gate");
  }
  assert.ok(
    EI.__internal && typeof EI.__internal.statLedgerMtime === "function",
    "entity-index must export __internal.statLedgerMtime for this gate",
  );
  const { statLedgerMtime } = EI.__internal;

  // ENOENT: genuinely missing ledger stays the legal cold-start null.
  assert.equal(
    statLedgerMtime(join(TMP_ROOT, "ledgers", "nope.jsonl")),
    null,
    "ENOENT must keep returning null (cold start)",
  );

  // Any other errno (EACCES via unsearchable parent) must throw fail-closed.
  const parentDir = join(TMP_ROOT, "locked-parent-leg-d");
  mkdirSync(parentDir, { recursive: true });
  const ledgerPath = join(parentDir, "ledger.jsonl");
  writeFileSync(ledgerPath, "{}\n", "utf8");
  chmodSync(parentDir, 0o000);
  try {
    assert.throws(
      () => statLedgerMtime(ledgerPath),
      /ledger stat failed/,
      "statLedgerMtime swallowed a non-ENOENT errno as null (mtime-0 conflation)",
    );
  } finally {
    chmodSync(parentDir, 0o700);
  }
});
