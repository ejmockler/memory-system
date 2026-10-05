// time-index-stream.test.mjs — B1c: time-index streaming + fail-closed read.
//
// PRE-FIX FAILURE, recorded 2026-07-12 (leg (b) run against the pre-fix
// readFileSync/swallow implementation of lib/synthesis/time-index.js):
//
//   ✔ leg (a): readable fixture ledger yields exact index contents and order (2.472958ms)
//   ✔ leg (a): MISSING ledger yields an empty index without throwing (T14 semantics) (0.196917ms)
//   ✖ leg (b): unreadable ledger rejects and persists NO cache (0.982208ms)
//   ℹ tests 3 / pass 2 / fail 1
//
//   test at test/time-index-stream.test.mjs:159:1
//   ✖ leg (b): unreadable ledger rejects and persists NO cache (0.982208ms)
//     AssertionError [ERR_ASSERTION]: Missing expected rejection: rebuildTimeIndex
//     resolved on an unreadable ledger (fail-open: poisoned empty index)
//         at async TestContext.<anonymous> (file:///<checkout>/mcp/test/time-index-stream.test.mjs:177:5)
//       actual: undefined, expected: /ledger read failed/, operator: 'rejects'
//   EXIT=1
//
// Companion pre-fix probe (same chmod-000 fixture, run separately since the
// first assert.rejects aborts the test) proved the full poisoning chain —
// empty index returned AND persisted as a fingerprint-VALID cache:
//
//   rebuildTimeIndex resolved; sortedByInstant.length = 0 ; ledger_size = 121
//   cache persisted: true ; cache bytes: {"schema_version":"v1",
//     "ledger_mtime_ms":1783851136550.8052,"ledger_size":121,
//     "built_at":"2026-07-12T10:12:16.550Z","sorted":[]}
//
// B1c2 PRE-FIX FAILURES, recorded 2026-07-13 (legs (c) and (d) run against
// the post-B1c / pre-B1c2 time-index.js — readError gated, but counts.skipped
// ignored and statLedger swallowing every stat errno as "absent"):
//
//   ✖ leg (c): oversized valid row makes rebuildTimeIndex reject (no silent partial index)
//     AssertionError [ERR_ASSERTION]: Missing expected rejection: rebuildTimeIndex
//     resolved despite a skipped oversized row (silent partial index)
//       actual: undefined, expected: /refusing to project a partial index/, operator: 'rejects'
//   ✖ leg (d): parent-dir chmod 000 makes rebuild/loadOrRebuild reject, no cache persisted
//     AssertionError [ERR_ASSERTION]: Missing expected rejection: rebuildTimeIndex
//     resolved behind an unsearchable parent (misclassified as missing ledger)
//       actual: undefined, expected: /ledger stat failed/, operator: 'rejects'
//   ℹ tests 5 / pass 3 / fail 2
//
// B1c3 PRE-FIX FAILURE, recorded 2026-07-14 (leg (e) probe run against a
// scratchpad COPY of the pre-fix lib/synthesis/_ledger-stream.js — RED-RUN
// ISOLATION, live tree never reverted): streamLedgerLines AND
// streamLedgerLinesWithOffset on an EXISTING fixture ledger behind a
// chmod-000 parent dir returned zero counts with readError null/absent —
// the existsSync(path) short-circuit classified unreadable-path as
// missing-ledger for every consumer. Verbatim probe output:
//
//   streamLedgerLines counts = {"totalLines":0,"parsedLines":0,"skipped":0,"readError":null} ; rows kept = 0
//   streamLedgerLines readError is null: true
//   streamLedgerLinesWithOffset counts = {"totalLines":0,"bytesScanned":0,"skipped":0} ; lines kept = 0
//   streamLedgerLinesWithOffset readError field: (absent from counts object)
//   EXIT=0
//
// Five legs:
//   (a) BEHAVIOR PRESERVATION — a readable fixture ledger (flat instant_iso
//       anchor, foundation parsed.iso anchor, anchorless row, malformed
//       non-JSON line, row missing a string id) produces exactly the same
//       sortedByInstant contents+order and byMemoryId keys as the pre-fix
//       code; a MISSING ledger yields an empty index without throwing
//       (pins T14 semantics: missing ≠ unreadable).
//   (b) FAIL-CLOSED — an UNREADABLE ledger (chmod 000) makes rebuildTimeIndex
//       and loadOrRebuildTimeIndex reject, and loadOrRebuildTimeIndex must
//       NOT persist a cache file nor leave *.tmp debris. This leg FAILED
//       against pre-fix code (see PRE-FIX FAILURE below), which swallowed the
//       read error, returned an empty index, and persisted it as a
//       fingerprint-valid cache.
//   (c) B1c2 SKIPPED-ROW GATE — a valid JSON line over an injected small
//       maxLineBytes must make rebuildTimeIndex reject rather than resolve
//       with a silently-partial (fingerprint-valid) index. FAILED pre-B1c2.
//   (d) B1c2 STAT-ERRNO GATE — an EXISTING ledger behind a chmod-000 parent
//       must reject (ledger stat failed), not resolve as a (0,0)-fingerprinted
//       empty "missing ledger" index; ENOENT stays legal per leg (a). FAILED
//       pre-B1c2.
//   (e) B1c3 STREAMER ERRNO GATE — streamLedgerLines / streamLedgerLinesWithOffset
//       THEMSELVES (not just time-index's statLedger shield) must report a
//       non-null counts.readError on a chmod-000-parent path while still never
//       throwing, and must keep returning zeros with readError null on ENOENT.
//       FAILED pre-B1c3 (see probe output above).
//
// Run: cd mcp && node test/time-index-stream.test.mjs

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

import {
  TIME_INDEX_VERSION,
  rebuildTimeIndex,
  loadOrRebuildTimeIndex,
} from "../lib/synthesis/time-index.js";
import {
  streamLedgerLines,
  streamLedgerLinesWithOffset,
} from "../lib/synthesis/_ledger-stream.js";

// Hermetic temp root — the real ledger / real storage caches are NEVER touched.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "b1c-time-index-"));

after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers (copied from test/synthesis/time-index.test.mjs:64-112 so
// this file stays self-contained; `writeLedger` extended to pass raw string
// lines through verbatim, for the malformed-line fixture).
// ---------------------------------------------------------------------------

/** Write a JSONL ledger under TMP_ROOT. Rows may be objects (stringified)
 *  or raw strings (written verbatim). Returns the absolute path. */
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

/** Build a sample row carrying features.time_anchors[]. */
function makeRow(id, anchors, extras = {}) {
  return {
    id,
    kind: extras.kind || "fact",
    created_at: extras.created_at || "2026-01-01T00:00:00Z",
    content: extras.content || `content for ${id}`,
    features: { time_anchors: anchors },
    ...extras,
  };
}

// Anchors in the resolver-substrate shape (flat instant_iso).
function flatAnchor(instant_iso, kind = "absolute") {
  return {
    kind,
    instant_iso,
    duration_ms: null,
    raw_phrase: `${instant_iso}`,
    span: [0, 0],
    confidence: 0.95,
  };
}

// Anchors in the foundation-schema shape (parsed.iso).
function schemaAnchor(parsedIso, kind = "relative") {
  return {
    kind,
    raw_phrase: `parsed at ${parsedIso}`,
    parsed: {
      iso: parsedIso,
      offset_from: "event_ts",
      offset_seconds: 0,
    },
    extractor_confidence: 0.92,
    extractor_version: "chrono-node@2.7.4+lex-v1",
  };
}

// ---------------------------------------------------------------------------
// Leg (a) — behavior preservation on readable ledgers
// ---------------------------------------------------------------------------

test("leg (a): readable fixture ledger yields exact index contents and order", async () => {
  const rowNoId = makeRow("ignored", [flatAnchor("2026-01-15T00:00:00Z")]);
  delete rowNoId.id;

  const ledgerPath = writeLedger("behavior.jsonl", [
    makeRow("mem-flat", [flatAnchor("2026-03-01T10:00:00Z", "absolute")]),
    makeRow("mem-schema", [schemaAnchor("2026-02-01T09:00:00Z", "relative")]),
    makeRow("mem-anchorless", []),
    "this is not json {{{",
    rowNoId,
  ]);

  const index = await rebuildTimeIndex({ ledgerPath });

  assert.equal(index.schema_version, TIME_INDEX_VERSION);
  assert.equal(TIME_INDEX_VERSION, "v1");

  // Exact contents + order: instant_ms ASC, memory_id ASC, kind ASC.
  assert.deepEqual(index.sortedByInstant, [
    { memory_id: "mem-schema", instant_iso: "2026-02-01T09:00:00Z", kind: "relative" },
    { memory_id: "mem-flat", instant_iso: "2026-03-01T10:00:00Z", kind: "absolute" },
  ]);

  // byMemoryId carries exactly the anchor-bearing well-formed rows.
  assert.deepEqual(
    [...index.byMemoryId.keys()].sort(),
    ["mem-flat", "mem-schema"],
  );
  assert.deepEqual(index.byMemoryId.get("mem-flat"), [
    { instant_iso: "2026-03-01T10:00:00Z", kind: "absolute" },
  ]);
  assert.deepEqual(index.byMemoryId.get("mem-schema"), [
    { instant_iso: "2026-02-01T09:00:00Z", kind: "relative" },
  ]);
});

test("leg (a): MISSING ledger yields an empty index without throwing (T14 semantics)", async () => {
  const ledgerPath = join(TMP_ROOT, "ledgers", "does-not-exist.jsonl");
  assert.equal(existsSync(ledgerPath), false);

  const index = await rebuildTimeIndex({ ledgerPath });
  assert.deepEqual(index.sortedByInstant, []);
  assert.equal(index.byMemoryId.size, 0);
  assert.equal(index.ledger_mtime_ms, 0);
  assert.equal(index.ledger_size, 0);
});

// ---------------------------------------------------------------------------
// Leg (b) — fail-closed on an UNREADABLE ledger (must FAIL pre-fix)
// ---------------------------------------------------------------------------

test("leg (b): unreadable ledger rejects and persists NO cache", async () => {
  // Root guard: chmod 000 is a no-op for uid 0, which would make this gate
  // silently pass. A silently-passing gate is forbidden.
  if (process.getuid && process.getuid() === 0) {
    assert.fail("cannot run as root: chmod 000 is a no-op, gate would not gate");
  }

  const ledgerPath = writeLedger("unreadable.jsonl", [
    makeRow("mem-poison", [flatAnchor("2026-04-01T12:00:00Z", "absolute")]),
  ]);
  const cacheDir = join(TMP_ROOT, "cache");
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, "time-index.cache.json");

  chmodSync(ledgerPath, 0o000);
  try {
    // rebuildTimeIndex must throw — the read failure must be LOUD, so
    // recall.js's time_index_load_failed degrade reason can fire.
    await assert.rejects(
      rebuildTimeIndex({ ledgerPath }),
      /ledger read failed/,
      "rebuildTimeIndex resolved on an unreadable ledger (fail-open: poisoned empty index)",
    );

    // loadOrRebuildTimeIndex must also reject and must NOT persist a cache.
    await assert.rejects(
      loadOrRebuildTimeIndex({ ledgerPath, cachePath }),
      /ledger read failed/,
      "loadOrRebuildTimeIndex resolved on an unreadable ledger",
    );
    assert.equal(
      existsSync(cachePath),
      false,
      "cache file was persisted from an unreadable ledger (poisoned fingerprint-valid cache)",
    );
    const cacheBase = basename(cachePath);
    const tmpLeftovers = readdirSync(dirname(cachePath)).filter(
      (f) => f.startsWith(cacheBase) && f.endsWith(".tmp"),
    );
    assert.deepEqual(tmpLeftovers, [], "tmp-file debris left in cache dir");
  } finally {
    // Restore perms so the after() rmSync of TMP_ROOT can clean up.
    chmodSync(ledgerPath, 0o600);
  }
});

// ---------------------------------------------------------------------------
// Leg (c) — B1c2: oversized-row silent drop (must FAIL pre-fix)
// ---------------------------------------------------------------------------
//
// _ledger-stream.js increments counts.skipped for a line exceeding
// maxLineBytes WITHOUT setting readError, so pre-fix rebuildTimeIndex
// (which gated readError only) resolved with a fingerprint-VALID PARTIAL
// index — the same failure shape B1c killed, via a different counter.
// A small injected maxLineBytes makes the gate falsifiable without an
// >8MiB fixture asset.

test("leg (c): oversized valid row makes rebuildTimeIndex reject (no silent partial index)", async () => {
  const MAX_LINE_BYTES = 256;
  const bigRow = makeRow(
    "mem-oversized",
    [flatAnchor("2026-05-01T08:00:00Z", "absolute")],
    { content: "x".repeat(MAX_LINE_BYTES * 2) }, // one VALID JSON line > cap
  );
  assert.ok(
    JSON.stringify(bigRow).length > MAX_LINE_BYTES,
    "fixture row must exceed the injected cap",
  );
  const ledgerPath = writeLedger("oversized.jsonl", [
    makeRow("mem-small", [flatAnchor("2026-05-02T08:00:00Z", "absolute")]),
    bigRow,
  ]);

  // Pre-fix: resolved with ONLY mem-small indexed (mem-oversized silently
  // dropped, readError null). Post-fix: counts.skipped > 0 is LOUD.
  await assert.rejects(
    rebuildTimeIndex({ ledgerPath, maxLineBytes: MAX_LINE_BYTES }),
    /refusing to project a partial index/,
    "rebuildTimeIndex resolved despite a skipped oversized row (silent partial index)",
  );
});

// ---------------------------------------------------------------------------
// Leg (d) — B1c2: parent-dir unreadable must NOT read as 'missing ledger'
// ---------------------------------------------------------------------------
//
// Pre-fix, statLedger swallowed EVERY stat error as null (the missing-file
// answer) and streamLedgerLines' existsSync guard returned zeros with
// readError null on an unsearchable parent — so an EXISTING ledger behind a
// chmod-000 parent produced a (0,0)-fingerprinted EMPTY index that resolved
// cleanly. ENOENT (genuinely missing ledger) must stay legal — pinned by
// the leg (a) MISSING-ledger test above.

test("leg (d): parent-dir chmod 000 makes rebuild/loadOrRebuild reject, no cache persisted", async () => {
  // Root guard (same rationale as leg (b)): chmod 000 is a no-op for uid 0.
  if (process.getuid && process.getuid() === 0) {
    assert.fail("cannot run as root: chmod 000 is a no-op, gate would not gate");
  }

  const parentDir = join(TMP_ROOT, "locked-parent");
  mkdirSync(parentDir, { recursive: true });
  const ledgerPath = join(parentDir, "ledger.jsonl");
  writeFileSync(
    ledgerPath,
    JSON.stringify(makeRow("mem-behind-wall", [flatAnchor("2026-06-01T00:00:00Z")])) + "\n",
    "utf8",
  );
  const cacheDir = join(TMP_ROOT, "cache-leg-d");
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, "time-index.cache.json");

  chmodSync(parentDir, 0o000);
  try {
    await assert.rejects(
      rebuildTimeIndex({ ledgerPath }),
      /ledger stat failed/,
      "rebuildTimeIndex resolved behind an unsearchable parent (misclassified as missing ledger)",
    );
    await assert.rejects(
      loadOrRebuildTimeIndex({ ledgerPath, cachePath }),
      /ledger stat failed/,
      "loadOrRebuildTimeIndex resolved behind an unsearchable parent",
    );
    assert.equal(
      existsSync(cachePath),
      false,
      "cache file was persisted from an unstat-able ledger ((0,0)-fingerprinted empty index)",
    );
  } finally {
    // Restore perms so the after() rmSync of TMP_ROOT can clean up.
    chmodSync(parentDir, 0o700);
  }
});

// ---------------------------------------------------------------------------
// Leg (e) — B1c3: the STREAMER itself must classify errno (shared contract)
// ---------------------------------------------------------------------------
//
// Legs (b)/(d) only prove time-index is shielded by its own statLedger throw,
// which happens to run BEFORE the stream. Every OTHER streamLedgerLines
// consumer streams without a prior stat and inherited the conflation: the
// pre-B1c3 existsSync(path) short-circuit returned zero counts with readError
// null for an EXISTING ledger behind an EACCES parent (existsSync is false
// for unreachable paths). Post-fix, the openSync errno decides: ENOENT →
// zeros with readError null; anything else → readError set, still no throw.

test("leg (e): streamLedgerLines/WithOffset report readError behind a chmod-000 parent, never throw", () => {
  // Root guard (same rationale as leg (b)): chmod 000 is a no-op for uid 0.
  if (process.getuid && process.getuid() === 0) {
    assert.fail("cannot run as root: chmod 000 is a no-op, gate would not gate");
  }

  const parentDir = join(TMP_ROOT, "locked-parent-leg-e");
  mkdirSync(parentDir, { recursive: true });
  const ledgerPath = join(parentDir, "ledger.jsonl");
  writeFileSync(ledgerPath, JSON.stringify({ id: "row-1", kind: "fact" }) + "\n", "utf8");

  chmodSync(parentDir, 0o000);
  try {
    // streamLedgerLines: never throws, readError NON-null, no rows delivered.
    const rows = [];
    const c1 = streamLedgerLines(ledgerPath, (r) => rows.push(r));
    assert.equal(rows.length, 0);
    assert.equal(c1.totalLines, 0);
    assert.notEqual(
      c1.readError,
      null,
      "streamLedgerLines returned readError null for an EXISTING unreadable ledger (conflated with missing)",
    );

    // streamLedgerLinesWithOffset: same classification on its counts object.
    const lines = [];
    const c2 = streamLedgerLinesWithOffset(ledgerPath, (l) => lines.push(l));
    assert.equal(lines.length, 0);
    assert.equal(c2.totalLines, 0);
    assert.notEqual(
      c2.readError,
      null,
      "streamLedgerLinesWithOffset returned readError null/absent for an EXISTING unreadable ledger",
    );
  } finally {
    // Restore perms so the after() rmSync of TMP_ROOT can clean up.
    chmodSync(parentDir, 0o700);
  }

  // ENOENT stays benign for BOTH streamers: zeros, readError null, no throw.
  const missing = join(TMP_ROOT, "ledgers", "leg-e-does-not-exist.jsonl");
  assert.equal(existsSync(missing), false);
  const m1 = streamLedgerLines(missing, () => {});
  assert.deepEqual(m1, { totalLines: 0, parsedLines: 0, skipped: 0, readError: null });
  const m2 = streamLedgerLinesWithOffset(missing, () => {});
  assert.deepEqual(m2, { totalLines: 0, bytesScanned: 0, skipped: 0, readError: null });
});
