// health-reducers.test.mjs — H1 regression gate for the day-bucket health
// reducer library (mcp/lib/synthesis/health-reducers.js).
//
// WHAT THIS GUARDS (each suite can FAIL against a plausibly-wrong
// implementation):
//   (a) equivalence      — on a >=35-day mixed fixture (populated/empty axes,
//                          multi-version extractors, missing versions,
//                          non-fact rows, malformed lines, created_at
//                          fallbacks, future rows, out-of-ts-order appends)
//                          and >=3 pinned `now` values, computeCoverageFromState
//                          deepStrictEquals computeSynthesisCoverage RAW and
//                          computeDriftFromState equals detectDrift under
//                          canonicalizeDriftEnvelope (both sides).
//   (b) boundary exactness — rows minutes around now-7d / now-30d / now and a
//                          midnight-aligned cutoff; a day-bucket-only reducer
//                          provably yields DIFFERENT numbers (asserted via the
//                          naive whole-day sum), the shipped reducer matches
//                          the full scan; a row at exactly now-7d lands in
//                          drift CURRENT and inside coverage; now+1ms dropped.
//   (c) timestamp-rule divergence — created_at-only and empty-ts rows are
//                          counted by coverage and INVISIBLE to drift; a
//                          non-empty unparseable ts does NOT fall through to
//                          created_at (both skip); neither field => both skip.
//   (d) incremental append — after a full build, a small appended delta (plus
//                          a torn, invalid-JSON tail) folds with mode
//                          "incremental", exact linesApplied, and
//                          stats.bytesRead < 25% of the ~48MB file; the torn
//                          row is invisible until completed, then applied
//                          EXACTLY ONCE.
//   (e) prefix drift      — a byte flip in block 0 => mode "rebuild" with the
//                          verify reason recorded; outputs correct afterward.
//   (f) version bump      — tampered persisted reducer_version => rebuild
//                          (reason "reducer-version-mismatch"); corrupt /
//                          truncated / shape-invalid persisted JSON =>
//                          loadState null.
//   (g) loud compute-time drift — mutating the ledger after update makes the
//                          compute functions THROW (message naming the
//                          reason), never silently return stale numbers.
//   (h) persistence round-trip — saveState/loadState identity; identical
//                          compute results; atomic (no .tmp. litter).
//   (i) unterminated tail — a COMPLETE final JSON row with no trailing "\n"
//                          (crashed/mid-append writer) is excluded from the
//                          checkpoint but folded at COMPUTE time, matching
//                          the originals (pre-H1b this diverged 2-vs-3);
//                          once terminated it checkpoints exactly once.
//   (j) TOCTOU capture-fallback — a same-eof rewrite injected between
//                          updateOneFile's verifyPrefix and captureCheckpoint
//                          (via the __testHooks seam) forces mode "rebuild"
//                          reason "capture-fallback", never a green
//                          incremental checkpoint over stale aggregates.
//   (k) state validation hardening — loadState nulls: offset past
//                          checkpoint.eof, duplicate/non-ascending offsets,
//                          day keys "01"/"-0", null checkpoint + populated
//                          days; a SHAPE-VALID state with offset pairs
//                          swapped across day buckets throws
//                          state-offset-mismatch at compute (pre-H1b it
//                          silently double-counted one row and lost another).
//   (l) hostile version strings — extractor versions "constructor",
//                          "__proto__", "_missing_" count honestly in the
//                          state (pre-H1b: NaN-string histogram, saveState
//                          throw, rebuild-every-update loop), and the
//                          emitted envelopes still match the originals
//                          bit-for-bit (including the originals' own
//                          plain-object tick semantics).
//   (m) witness-budget overflow (S1c) — legitimate small appends drive the
//                          checkpoint witness past MAX_WITNESS_ENTRIES
//                          (128); the cap-crossing update must stay mode
//                          "incremental" with reason "witness-compacted"
//                          (captureCheckpoint's prefix-certified-by-prev
//                          resample), never a mislabeled "capture-fallback"
//                          full re-stream; suite (j)'s genuine same-eof
//                          rewrite keeps full-rebuilding.
//
// INDEPENDENT I/O ACCOUNTING: fs.readSync is wrapped (via createRequire,
// BEFORE the library modules are imported, so their ESM named-import
// bindings capture the wrapper) with a byte counter the tests toggle around
// specific calls. Suite (d)'s <25% no-full-rescan bound is asserted against
// this independent measure; the library's self-reported stats.bytesRead is
// kept as a secondary honesty check (self-reported >= independent).
//
// HERMETICITY: all fixtures under mkdtempSync; the production ledgers are
// NEVER read — their stats are snapshotted before and asserted unchanged
// after (pattern copied from ledger-checkpoint.test.mjs:44-64).
//
// Run: cd mcp && node test/synthesis/health-reducers.test.mjs

import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// node:fs is loaded via require so NO ESM facade for it exists yet; the
// wrapper below is installed before the first ESM import of node:fs
// (transitively, the library modules below), so their named-import bindings
// resolve to the counting wrapper. Do NOT add a static `import ... from
// "node:fs"` to this file — it would snapshot the un-wrapped readSync.
const _require = createRequire(import.meta.url);
const _fs = _require("node:fs");
const {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = _fs;

const _origReadSync = _fs.readSync;
let ioCounting = false;
let ioReadBytes = 0;
_fs.readSync = function countingReadSync(...args) {
  const n = _origReadSync.apply(this, args);
  if (ioCounting) ioReadBytes += n;
  return n;
};
/** Measure the actual bytes fs.readSync delivered while fn ran. */
function measureReadBytes(fn) {
  ioReadBytes = 0;
  ioCounting = true;
  try {
    fn();
  } finally {
    ioCounting = false;
  }
  return ioReadBytes;
}

// Finding 1 (verify-dedup): node:crypto.createHash is wrapped the same way as
// readSync above (BEFORE the library import, so ledger-checkpoint.js's ESM
// binding captures the counter). During the reducer compute path verifyPrefix
// is the ONLY hasher — boundary replay and tail folding use JSON.parse — so a
// createHash count is an exact per-witness-entry measure of sampled re-verify
// work. The verify memo must drive it to ZERO on an unchanged file.
const _crypto = _require("node:crypto");
const _origCreateHash = _crypto.createHash;
let hashCounting = false;
let hashCalls = 0;
_crypto.createHash = function countingCreateHash(...args) {
  if (hashCounting) hashCalls += 1;
  return _origCreateHash.apply(this, args);
};
/** Count node:crypto.createHash invocations while fn ran. */
function measureHashCalls(fn) {
  hashCalls = 0;
  hashCounting = true;
  try {
    fn();
  } finally {
    hashCounting = false;
  }
  return hashCalls;
}

// The checkout this suite runs from. Its default (un-overridden) ledgers,
// policy and indices are what the byte-identity guards below watch; the
// suite itself works under a temp MEMORY_ROOT.
const CHECKOUT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// ---------------------------------------------------------------------------
// Production-path snapshot BEFORE any work (hermeticity invariant).
// ---------------------------------------------------------------------------
const PROD_MEMORY_JSONL = join(CHECKOUT_ROOT, "ledgers", "memory.jsonl");
const PROD_RECALL_JSONL = join(CHECKOUT_ROOT, "ledgers", "recall.jsonl");
function snap(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const PROD_BEFORE_MEM = snap(PROD_MEMORY_JSONL);
const PROD_BEFORE_REC = snap(PROD_RECALL_JSONL);

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-health-reducers-"));
process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { computeSynthesisCoverage } = await import("../../lib/synthesis/coverage-probe.js");
const { detectDrift } = await import("../../lib/synthesis/drift-detector.js");
const {
  REDUCER_VERSION,
  RETENTION_WINDOW_DAYS,
  RETENTION_MARGIN_DAYS,
  createEmptyState,
  updateStateFromLedgers,
  pruneFileStateDays,
  loadState,
  saveState,
  computeCoverageFromState,
  computeDriftFromState,
  canonicalizeDriftEnvelope,
  __testHooks,
} = await import("../../lib/synthesis/health-reducers.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

let fixtureN = 0;
function fixtureDir() {
  fixtureN += 1;
  const d = join(TMP_ROOT, `fx-${fixtureN}`);
  mkdirSync(d);
  return d;
}

function writeLedger(path, lines) {
  writeFileSync(path, lines.join("\n") + "\n");
}

/**
 * The H2 equivalence contract: coverage compares deepStrictEqual RAW;
 * drift compares after canonicalizeDriftEnvelope applied to BOTH sides.
 */
async function assertEquivalent(state, paths, now, windowDays) {
  const covOpts = { ...paths, now };
  if (windowDays !== undefined) covOpts.windowDays = windowDays;
  const covMine = computeCoverageFromState(state, covOpts);
  const covReal = await computeSynthesisCoverage(covOpts);
  assert.deepStrictEqual(covMine, covReal);
  const drMine = computeDriftFromState(state, { ...paths, now });
  const drReal = await detectDrift({ ...paths, now });
  assert.deepStrictEqual(
    canonicalizeDriftEnvelope(drMine),
    canonicalizeDriftEnvelope(drReal),
  );
  return { covMine, covReal, drMine, drReal };
}

/**
 * What a NAIVE day-bucket-only reducer would report for facts_in_window:
 * include every overlapping day WHOLE. Suite (b) asserts this differs from
 * the exact value — proving the boundary fixtures have teeth.
 */
function naiveCoverageFacts(fileState, cutoffMs, nowMs) {
  let n = 0;
  for (const key of Object.keys(fileState.days)) {
    const d = Number(key);
    const lo = d * DAY;
    const hi = lo + DAY - 1;
    if (hi < cutoffMs || lo > nowMs) continue;
    const b = fileState.days[key];
    n += b.both.facts + b.covOnly.facts;
  }
  return n;
}

/** Small marker-carrying fixture shared by suites (e)/(f)/(g)/(h). */
function writeSmallFixture(dir, nowMs) {
  const ledgerPath = join(dir, "memory.jsonl");
  const recallLogPath = join(dir, "recall.jsonl");
  const memLines = [];
  for (let k = 0; k < 20; k++) {
    memLines.push(
      JSON.stringify({
        id: "s" + k,
        kind: "fact",
        ts: iso(nowMs - k * DAY - HOUR),
        pad: k === 0 ? "PADPADPAD" : "p",
        features: {
          entities: k % 2 === 0 ? ["alpha", "beta"] : [],
          valence: 0.5,
          episodicity: k % 3 === 0 ? 0.25 : null,
          time_anchors: k % 4 === 0 ? [{ kind: "day" }] : [],
          entity_extractor_version: "v1",
          episodicity_version: "e1",
          time_anchor_resolver_version: "t1",
          valence_model_version: "m1",
        },
      }),
    );
  }
  const recLines = [];
  for (let k = 0; k < 6; k++) {
    recLines.push(
      JSON.stringify({
        id: "sr" + k,
        kind: "recall",
        ts: iso(nowMs - k * DAY - 2 * HOUR),
        populator: {
          entities_count: 1,
          has_time_anchor: true,
          inferred_mood_sign: 0.5,
          query_episodicity: 0.25 * (k % 3),
          degraded: false,
        },
      }),
    );
  }
  writeLedger(ledgerPath, memLines);
  writeLedger(recallLogPath, recLines);
  return { ledgerPath, recallLogPath };
}

// ---------------------------------------------------------------------------
// (a) EQUIVALENCE — >=35-day mixed fixture, >=3 pinned nows
// ---------------------------------------------------------------------------
const NOW_A = Date.parse("2026-07-10T12:00:00Z");

test("(a) equivalence: mixed 35-day fixture matches the originals at 3 pinned nows", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "memory.jsonl");
  const recallLogPath = join(dir, "recall.jsonl");
  const paths = { ledgerPath, recallLogPath };

  // Written NEWEST FIRST (k ascending = days-ago ascending) so the file is
  // out of ts order — this makes the drift version arrays' file-first-seen
  // insertion order differ from lexicographic order, proving
  // canonicalizeDriftEnvelope is load-bearing.
  const memLines = [];
  for (let k = 0; k <= 34; k++) {
    const features = {};
    features.entities = k % 2 === 0 ? ["ent-" + k, "shared"] : [];
    if (k % 3 === 0) features.time_anchors = [{ kind: "day" }];
    if (k % 4 === 0) features.valence = k % 8 === 0 ? 0.5 : -0.25;
    if (k % 2 === 1) features.episodicity = 0.75;
    if (k % 3 === 0) features.entity_extractor_version = "zz-v9";
    else if (k % 3 === 1) features.entity_extractor_version = "aa-v1";
    features.episodicity_version = k % 2 === 0 ? "e2" : "e1";
    features.time_anchor_resolver_version = k < 10 ? "t2" : "t1";
    if (k % 7 !== 0) features.valence_model_version = "m1";
    memLines.push(
      JSON.stringify({
        id: "m" + k,
        kind: k % 9 === 0 ? "reconstructed_fact" : "fact",
        ts: iso(NOW_A - k * DAY - (k % 5) * HOUR),
        features,
      }),
    );
  }
  // A recall row leaked into the memory ledger WITH features: looksLikeFact
  // admits it in both originals — the reducer must agree.
  memLines.push(JSON.stringify({ id: "leak", kind: "recall", ts: iso(NOW_A - 2 * DAY + 2 * HOUR), features: { entities: ["leaked"] } }));
  // created_at fallback rows (coverage sees them; drift is blind).
  memLines.push(JSON.stringify({ id: "coA", kind: "fact", created_at: iso(NOW_A - 3 * DAY + HOUR), features: { entities: ["co"], entity_extractor_version: "aa-v1" } }));
  memLines.push(JSON.stringify({ id: "coB", kind: "fact", ts: "", created_at: iso(NOW_A - 4 * DAY), features: {} }));
  // Non-empty unparseable ts: NO fallthrough — both rules skip.
  memLines.push(JSON.stringify({ id: "badts", kind: "fact", ts: "not-a-timestamp", created_at: iso(NOW_A - 4 * DAY), features: { entities: ["never"] } }));
  memLines.push(JSON.stringify({ id: "nots", kind: "fact", features: { entities: ["never2"] } }));
  // Non-object features / missing features / non-fact / future / stale rows.
  memLines.push(JSON.stringify({ id: "weirdf", kind: "fact", ts: iso(NOW_A - 5 * DAY + HOUR), features: "weird" }));
  memLines.push(JSON.stringify({ id: "nofeat", kind: "fact", ts: iso(NOW_A - 6 * DAY + HOUR) }));
  memLines.push(JSON.stringify({ id: "policy", kind: "policy", ts: iso(NOW_A - DAY) }));
  memLines.push(JSON.stringify({ id: "fut", kind: "fact", ts: iso(NOW_A + 2 * DAY), features: { entities: ["future"] } }));
  memLines.push(JSON.stringify({ id: "old", kind: "fact", ts: iso(NOW_A - 45 * DAY), features: { entities: ["old"] } }));
  // Malformed lines + a blank line.
  memLines.push('{"id":"malformed","kind":"fact"');
  memLines.push("not json at all");
  memLines.push("");
  memLines.push(JSON.stringify({ id: "tail", kind: "fact", ts: iso(NOW_A - 30 * 60 * 1000), features: { entities: ["tail"] } }));
  writeLedger(ledgerPath, memLines);

  const recLines = [];
  for (let k = 0; k <= 33; k++) {
    const populator = {
      entities_count: k % 2,
      has_time_anchor: k % 3 === 0,
      time_anchors_count: k % 4,
      inferred_mood_sign: k % 3 === 0 ? 0 : k % 3 === 1 ? 0.5 : -1,
      degraded: k % 6 === 0,
    };
    // qe values are dyadic rationals so FP summation order cannot matter.
    if (k % 5 !== 0) populator.query_episodicity = (k % 4) * 0.25;
    recLines.push(
      JSON.stringify({ id: "r" + k, kind: "recall", ts: iso(NOW_A - k * DAY + HOUR), populator, degraded_recall: k % 7 === 0 }),
    );
  }
  recLines.push(JSON.stringify({ id: "rnp", kind: "recall", ts: iso(NOW_A - DAY + 2 * HOUR) }));
  recLines.push(JSON.stringify({ id: "rbadp", kind: "recall", ts: iso(NOW_A - DAY + 3 * HOUR), populator: 5 }));
  recLines.push(JSON.stringify({ id: "rco", kind: "recall", created_at: iso(NOW_A - 2 * DAY + HOUR), populator: { entities_count: 1, inferred_mood_sign: 1, query_episodicity: 0.5 } }));
  recLines.push(JSON.stringify({ id: "rfact", kind: "fact", ts: iso(NOW_A - 2 * DAY), features: { entities: ["x"] } }));
  recLines.push(JSON.stringify({ id: "rfut", kind: "recall", ts: iso(NOW_A + DAY), populator: { entities_count: 3, inferred_mood_sign: 1, query_episodicity: 1 } }));
  recLines.push('{"broken');
  writeLedger(recallLogPath, recLines);

  const { state, stats } = updateStateFromLedgers(createEmptyState(), paths);
  assert.equal(state.reducer_version, REDUCER_VERSION);
  assert.equal(stats.memory.mode, "rebuild");
  assert.equal(stats.recall.mode, "rebuild");
  assert.ok(stats.memory.linesApplied > 0);

  // Three pinned nows (number and Date forms) + a custom windowDays.
  for (const now of [NOW_A, NOW_A + 36 * HOUR, NOW_A - 5 * DAY + 1234567]) {
    await assertEquivalent(state, paths, now);
    await assertEquivalent(state, paths, now, 3);
    await assertEquivalent(state, paths, new Date(now));
  }

  // The fixture actually exercises the alert paths + canonicalization.
  const dr = computeDriftFromState(state, { ...paths, now: NOW_A });
  assert.ok(dr.alerts.some((a) => a.kind === "extractor_version_bump"));

  // Idempotent follow-up update: incremental, empty delta, same answers.
  const upd2 = updateStateFromLedgers(state, paths);
  assert.equal(upd2.stats.memory.mode, "incremental");
  assert.equal(upd2.stats.memory.linesApplied, 0);
  assert.equal(upd2.stats.recall.mode, "incremental");
  await assertEquivalent(upd2.state, paths, NOW_A);
});

// ---------------------------------------------------------------------------
// (b) BOUNDARY EXACTNESS — must FAIL for a day-bucket-only implementation
// ---------------------------------------------------------------------------
const NOW_B = Date.parse("2026-07-10T12:00:00Z");

test("(b) boundary days replay exactly at now-7d / now-30d / now and a midnight cutoff", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "memory.jsonl");
  const recallLogPath = join(dir, "recall.jsonl");
  const paths = { ledgerPath, recallLogPath };

  const feat = {
    entities: ["x", "y"],
    valence: 0.5,
    episodicity: 0.25,
    time_anchors: [{ kind: "day" }],
    entity_extractor_version: "v1",
    episodicity_version: "e1",
    time_anchor_resolver_version: "t1",
    valence_model_version: "m1",
  };
  const mk = (id, ts) => JSON.stringify({ id, kind: "fact", ts, features: feat });
  writeLedger(ledgerPath, [
    mk("r1", "2026-06-10T11:59:00.000Z"), // 1min before now-30d: outside
    mk("r2", "2026-06-10T12:00:00.000Z"), // exactly now-30d: baseline
    mk("r3", "2026-06-10T12:03:00.000Z"), // baseline
    mk("r4", "2026-07-03T11:58:00.000Z"), // 2min before now-7d: baseline, OUT of 7d coverage
    mk("r5", "2026-07-03T12:00:00.000Z"), // exactly now-7d: drift CURRENT + inside coverage
    mk("r6", "2026-07-03T12:02:00.000Z"), // current + coverage
    mk("r7", "2026-07-10T11:59:00.000Z"), // current + coverage
    mk("r8", "2026-07-10T12:00:00.000Z"), // exactly now: current + coverage
    mk("r9", "2026-07-10T12:00:00.001Z"), // now+1ms: dropped everywhere
    mk("r10", "2026-06-25T00:00:00.000Z"), // interior baseline day
    mk("r11", "2026-07-05T09:00:00.000Z"), // interior current day
    mk("r12", "2026-07-02T23:59:59.999Z"), // 1ms before the midnight cutoff below
    mk("r13", "2026-07-03T00:00:00.000Z"), // exactly ON the midnight cutoff below
  ]);
  writeLedger(recallLogPath, [
    JSON.stringify({ id: "q1", kind: "recall", ts: "2026-07-03T11:00:00.000Z", populator: { entities_count: 1, inferred_mood_sign: 1, query_episodicity: 0.25 } }),
    JSON.stringify({ id: "q2", kind: "recall", ts: "2026-07-03T13:00:00.000Z", populator: { entities_count: 1, inferred_mood_sign: 1, query_episodicity: 0.75 } }),
    JSON.stringify({ id: "q3", kind: "recall", ts: "2026-07-03T12:00:00.000Z", populator: { entities_count: 1, inferred_mood_sign: 1, query_episodicity: 0.5 } }),
  ]);

  const { state } = updateStateFromLedgers(null, paths);

  // --- anchor at NOW_B (12:00Z — both cutoffs fall mid-day) ---------------
  const { covMine, drMine } = await assertEquivalent(state, paths, NOW_B);
  // Exact expected values (hand-computed from the rows above):
  assert.equal(covMine.facts_in_window, 5); // r5 r6 r7 r8 r11
  assert.equal(drMine.baseline_facts, 6); // r2 r3 r4 r10 r12 r13
  assert.equal(drMine.current_facts, 5); // r5 r6 r7 r8 r11
  assert.equal(drMine.baseline_recalls, 1); // q1
  assert.equal(drMine.current_recalls, 2); // q3 (exactly now-7d) + q2

  // The fixture has TEETH: a day-bucket-only reducer (whole overlapping
  // days) reports a DIFFERENT facts_in_window.
  const naive = naiveCoverageFacts(state.memory, NOW_B - 7 * DAY, NOW_B);
  assert.equal(naive, 8); // day(07-03): r4 r5 r6 r13; day(07-05): r11; day(07-10): r7 r8 r9
  assert.notEqual(naive, covMine.facts_in_window);

  // --- midnight-aligned cutoff: now at 00:00:00.000Z exactly ---------------
  const nowMidnight = Date.parse("2026-07-10T00:00:00.000Z");
  const { covMine: covMid } = await assertEquivalent(state, paths, nowMidnight);
  assert.equal(covMid.facts_in_window, 5); // r4 r5 r6 r11 r13 (r13 exactly on the cutoff)
  const naiveMid = naiveCoverageFacts(state.memory, nowMidnight - 7 * DAY, nowMidnight);
  assert.equal(naiveMid, 8); // whole day(07-03) + day(07-05) + whole day(07-10)
  assert.notEqual(naiveMid, covMid.facts_in_window);
});

// ---------------------------------------------------------------------------
// (c) TIMESTAMP-RULE DIVERGENCE
// ---------------------------------------------------------------------------
const NOW_C = Date.parse("2026-03-15T06:30:00Z");

test("(c) coverage counts created_at fallbacks; drift is blind; no ts fallthrough", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "memory.jsonl");
  const recallLogPath = join(dir, "recall.jsonl");
  const paths = { ledgerPath, recallLogPath };

  // INTERIOR anchor (H1b fold-path teeth): ~3 days before NOW_C, mid-day —
  // these rows land on an INTERIOR day of the 7d window, where coverage is
  // summed straight off the day-bucket aggregates with NO boundary replay to
  // silently re-apply the correct rule. Mutation testing showed the original
  // boundary-day-only c-rows let a ts-fallthrough mutant in classifyRowTs
  // (the FOLD path) pass this suite; the interior duplicates make the fold
  // path itself load-bearing (a fallthrough mutant now folds c4i into an
  // interior covOnly bucket and facts_in_window comes out 6, not 5).
  const INT = NOW_C - 3 * DAY; // 2026-03-12T06:30Z, mid-day interior

  writeLedger(ledgerPath, [
    JSON.stringify({ id: "c1", kind: "fact", ts: iso(NOW_C - HOUR), features: { entities: ["a"] } }),
    JSON.stringify({ id: "c2", kind: "fact", created_at: iso(NOW_C - 2 * HOUR), features: {} }),
    JSON.stringify({ id: "c3", kind: "fact", ts: "", created_at: iso(NOW_C - 3 * HOUR), features: {} }),
    // Unparseable NON-EMPTY ts + valid created_at: BOTH rules skip.
    JSON.stringify({ id: "c4", kind: "fact", ts: "not-a-timestamp", created_at: iso(NOW_C - 4 * HOUR), features: { entities: ["never"] } }),
    // Neither field: both skip.
    JSON.stringify({ id: "c5", kind: "fact", features: {} }),
    // Interior-day duplicates of the c2..c5 patterns (H1b).
    JSON.stringify({ id: "c2i", kind: "fact", created_at: iso(INT - 2 * HOUR), features: {} }),
    JSON.stringify({ id: "c3i", kind: "fact", ts: "", created_at: iso(INT - 3 * HOUR), features: {} }),
    JSON.stringify({ id: "c4i", kind: "fact", ts: "still-not-a-timestamp", created_at: iso(INT - 4 * HOUR), features: { entities: ["never-interior"] } }),
    JSON.stringify({ id: "c5i", kind: "fact", features: { entities: ["no-ts-anywhere"] } }),
  ]);
  writeLedger(recallLogPath, [
    JSON.stringify({ id: "cr1", kind: "recall", ts: iso(NOW_C - HOUR), populator: { entities_count: 1, inferred_mood_sign: 1, query_episodicity: 0.5 } }),
    JSON.stringify({ id: "cr2", kind: "recall", created_at: iso(NOW_C - 2 * HOUR), populator: { entities_count: 1, inferred_mood_sign: 1, query_episodicity: 0.25 } }),
    // Interior-day created_at fallback + unparseable-ts recalls (H1b).
    JSON.stringify({ id: "cr2i", kind: "recall", created_at: iso(INT - HOUR), populator: { entities_count: 1, inferred_mood_sign: 1, query_episodicity: 0.75 } }),
    JSON.stringify({ id: "cr4i", kind: "recall", ts: "not-a-timestamp", created_at: iso(INT - 2 * HOUR), populator: { entities_count: 1, inferred_mood_sign: 1, query_episodicity: 1 } }),
  ]);

  const { state } = updateStateFromLedgers(null, paths);
  const { covMine, drMine } = await assertEquivalent(state, paths, NOW_C);

  // Coverage (rule A): c1 + c2/c2i (created_at) + c3/c3i (empty ts ->
  // created_at). c4/c4i (no fallthrough), c5/c5i (no fields) skip.
  assert.equal(covMine.facts_in_window, 5);
  // Recall side: cr1 + cr2 + cr2i (cr4i: no fallthrough).
  assert.equal(covMine.recall_population.recalls_in_window, 3);
  // Drift (rule B): ONLY c1 / cr1 — the rules provably diverge, on the
  // interior days as much as the boundary days.
  assert.equal(drMine.current_facts, 1);
  assert.equal(drMine.current_recalls, 1);
  assert.ok(covMine.facts_in_window > drMine.current_facts);

  // The interior rows really are interior: their day is strictly between
  // the window's cutoff day and day(now).
  const dInt = Math.floor((INT - 2 * HOUR) / DAY);
  assert.ok(dInt > Math.floor((NOW_C - 7 * DAY) / DAY) && dInt < Math.floor(NOW_C / DAY));
});

// ---------------------------------------------------------------------------
// (d) INCREMENTAL APPEND with torn tail + bytesRead bound
// ---------------------------------------------------------------------------
const NOW_D = Date.parse("2026-07-10T12:00:00Z");

test("(d) incremental update reads only the delta; torn tail applied exactly once", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "memory.jsonl");
  const recallLogPath = join(dir, "recall.jsonl");
  const paths = { ledgerPath, recallLogPath };

  // ~48MB memory ledger (760 rows x ~64KB padding) so the sampled witness
  // (<= ~65 x 64KiB blocks, verified twice per incremental update) plus the
  // tiny delta stays well under 25% of the file.
  const pad = "x".repeat(64000);
  const lines = [];
  for (let i = 0; i < 760; i++) {
    lines.push(
      JSON.stringify({
        id: "big-" + i,
        kind: "fact",
        ts: iso(NOW_D - (i % 12) * DAY - ((i % 7) + 1) * HOUR),
        features: {
          entities: i % 3 === 0 ? [] : ["a", "b"],
          valence: i % 2 === 0 ? 0.5 : null,
          episodicity: 0.25,
          time_anchors: i % 4 === 0 ? [] : [{}],
          entity_extractor_version: i % 2 === 0 ? "v1" : "v2",
          episodicity_version: "e1",
          time_anchor_resolver_version: "t1",
          valence_model_version: "m1",
        },
        pad,
      }),
    );
  }
  writeLedger(ledgerPath, lines);
  const recLines = [];
  for (let i = 0; i < 10; i++) {
    recLines.push(
      JSON.stringify({
        id: "dr" + i,
        kind: "recall",
        ts: iso(NOW_D - i * DAY - HOUR),
        populator: {
          entities_count: i % 2,
          has_time_anchor: i % 2 === 0,
          inferred_mood_sign: i % 3 === 0 ? 0 : 0.5,
          query_episodicity: (i % 4) * 0.25,
          degraded: false,
        },
      }),
    );
  }
  writeLedger(recallLogPath, recLines);

  let { state } = updateStateFromLedgers(null, paths);
  await assertEquivalent(state, paths, NOW_D);

  // Append 3 complete rows + a torn (mid-append, invalid-JSON) tail.
  const tornRow = JSON.stringify({
    id: "torn",
    kind: "fact",
    ts: iso(NOW_D - 3 * HOUR),
    features: {
      entities: ["t1", "t2"],
      valence: 0.25,
      episodicity: 0.5,
      time_anchors: [{}],
      entity_extractor_version: "v3",
      episodicity_version: "e1",
      time_anchor_resolver_version: "t1",
      valence_model_version: "m1",
    },
  });
  const cut = 40; // mid-object: the torn prefix is NOT valid JSON
  const appended = [
    JSON.stringify({ id: "app-1", kind: "fact", ts: iso(NOW_D - 2 * HOUR), features: { entities: ["n1"], valence: 1, episodicity: 1, time_anchors: [{}] } }),
    JSON.stringify({ id: "app-2", kind: "fact", ts: iso(NOW_D - 26 * HOUR), features: {} }),
    JSON.stringify({ id: "app-3", kind: "fact", created_at: iso(NOW_D - 8 * DAY), features: { entities: ["n3"] } }),
  ];
  appendFileSync(ledgerPath, appended.join("\n") + "\n" + tornRow.slice(0, cut));

  // Non-empty RECALL delta too (H1b — recall incremental folding used to
  // ship tested only with empty deltas): 2 complete rows on days of their
  // own + a torn recall tail.
  const tornRecall = JSON.stringify({
    id: "rtorn",
    kind: "recall",
    ts: iso(NOW_D - 21 * DAY - HOUR),
    populator: { entities_count: 2, has_time_anchor: true, inferred_mood_sign: 1, query_episodicity: 0.125 },
  });
  const recAppended = [
    JSON.stringify({ id: "rapp-1", kind: "recall", ts: iso(NOW_D - 20 * DAY - HOUR), populator: { entities_count: 1, inferred_mood_sign: 0.5, query_episodicity: 0.75 } }),
    JSON.stringify({ id: "rapp-2", kind: "recall", created_at: iso(NOW_D - 20 * DAY - 2 * HOUR), populator: { entities_count: 0, inferred_mood_sign: 0, query_episodicity: 0.25 } }),
  ];
  const recCut = 25; // mid-object: NOT valid JSON
  appendFileSync(recallLogPath, recAppended.join("\n") + "\n" + tornRecall.slice(0, recCut));

  // Independent I/O accounting (H1b): count the bytes fs.readSync actually
  // delivered during the incremental update — the no-full-rescan bound must
  // not rest on the implementation's own counter.
  let upd;
  const independentBytes = measureReadBytes(() => {
    upd = updateStateFromLedgers(state, paths);
  });
  state = upd.state;
  assert.equal(upd.stats.memory.mode, "incremental");
  assert.equal(upd.stats.memory.reason, null);
  assert.equal(upd.stats.memory.linesApplied, 3); // torn tail NOT applied
  assert.equal(upd.stats.recall.mode, "incremental");
  assert.equal(upd.stats.recall.reason, null);
  assert.equal(upd.stats.recall.linesApplied, 2); // torn recall tail NOT applied
  const fileBytes = statSync(ledgerPath).size;
  const totalBytes = fileBytes + statSync(recallLogPath).size;
  // PRIMARY gate: the independent measure.
  assert.ok(independentBytes > 0);
  assert.ok(
    independentBytes < 0.25 * totalBytes,
    `incremental actually read ${independentBytes} bytes; must be < 25% of ${totalBytes}`,
  );
  // SECONDARY honesty check: the library may not under-report what it read.
  const selfReported = upd.stats.memory.bytesRead + upd.stats.recall.bytesRead;
  assert.ok(
    selfReported >= independentBytes,
    `self-reported ${selfReported} must cover the independent measure ${independentBytes}`,
  );
  assert.ok(
    upd.stats.memory.bytesRead < 0.25 * fileBytes,
    `incremental bytesRead ${upd.stats.memory.bytesRead} must be < 25% of ${fileBytes}`,
  );
  assert.ok(upd.stats.memory.bytesRead > 0);
  // Torn tails invisible; outputs still equal the full-scan originals (the
  // torn prefixes are invalid JSON, so the originals skip them too).
  await assertEquivalent(state, paths, NOW_D);

  // Complete the torn rows: applied EXACTLY ONCE on the next update.
  appendFileSync(ledgerPath, tornRow.slice(cut) + "\n");
  appendFileSync(recallLogPath, tornRecall.slice(recCut) + "\n");
  const upd2 = updateStateFromLedgers(state, paths);
  state = upd2.state;
  assert.equal(upd2.stats.memory.mode, "incremental");
  assert.equal(upd2.stats.memory.linesApplied, 1);
  assert.equal(upd2.stats.recall.mode, "incremental");
  assert.equal(upd2.stats.recall.linesApplied, 1);
  const tornDay = Math.floor((NOW_D - 3 * HOUR) / DAY);
  const bucket = state.memory.days[String(tornDay)];
  assert.equal(bucket.both.versions.entity_extractor_version["v3"], 1); // exactly once
  const rtornDay = Math.floor((NOW_D - 21 * DAY - HOUR) / DAY);
  const rBucket = state.recall.days[String(rtornDay)];
  assert.equal(rBucket.both.recalls, 1); // exactly once (its own day)
  assert.equal(rBucket.both.qeSum, 0.125);
  const rappDay = Math.floor((NOW_D - 20 * DAY - HOUR) / DAY);
  const rappBucket = state.recall.days[String(rappDay)];
  assert.equal(rappBucket.both.recalls, 1); // rapp-1 (rule B)
  assert.equal(rappBucket.covOnly.recalls, 1); // rapp-2 (created_at fallback)
  const { covMine } = await assertEquivalent(state, paths, NOW_D);
  assert.equal(covMine.extractor_versions.entity_extractor_version["v3"], 1);
});

// ---------------------------------------------------------------------------
// (e) PREFIX DRIFT -> REBUILD with recorded reason
// ---------------------------------------------------------------------------
const NOW_E = Date.parse("2026-07-10T12:00:00Z");

test("(e) byte flip in block 0 => full rebuild with the verify reason", async () => {
  const dir = fixtureDir();
  const paths = writeSmallFixture(dir, NOW_E);

  const { state } = updateStateFromLedgers(null, paths);
  await assertEquivalent(state, paths, NOW_E);

  // Same-length in-place rewrite: size/mtime-based caching would MISS this.
  const raw = readFileSync(paths.ledgerPath, "utf8");
  assert.ok(raw.includes("PADPADPAD"));
  writeFileSync(paths.ledgerPath, raw.replace("PADPADPAD", "QADPADPAD"));

  const upd = updateStateFromLedgers(state, paths);
  assert.equal(upd.stats.memory.mode, "rebuild");
  assert.equal(upd.stats.memory.reason, "prefix-drift");
  assert.equal(upd.stats.recall.mode, "incremental"); // untouched file stays incremental
  await assertEquivalent(upd.state, paths, NOW_E); // correct on the mutated file
});

// ---------------------------------------------------------------------------
// (f) reducer_version BUMP -> REBUILD; corrupt persisted JSON -> null
// ---------------------------------------------------------------------------
const NOW_F = Date.parse("2026-07-10T12:00:00Z");

test("(f) tampered reducer_version rebuilds; corrupt state loads as null", async () => {
  const dir = fixtureDir();
  const paths = writeSmallFixture(dir, NOW_F);
  const statePath = join(dir, "health-reducer-state.json");

  const { state } = updateStateFromLedgers(null, paths);
  saveState(statePath, state);
  const raw = readFileSync(statePath, "utf8");

  // Tamper the persisted version: loadState still returns it (shape-valid),
  // update detects the mismatch and force-rebuilds with the reason recorded.
  const tampered = JSON.parse(raw);
  tampered.reducer_version = "v999.0.0";
  writeFileSync(statePath, JSON.stringify(tampered));
  const loaded = loadState(statePath);
  assert.notEqual(loaded, null);
  const upd = updateStateFromLedgers(loaded, paths);
  assert.equal(upd.stats.memory.mode, "rebuild");
  assert.equal(upd.stats.memory.reason, "reducer-version-mismatch");
  assert.equal(upd.stats.recall.mode, "rebuild");
  assert.equal(upd.stats.recall.reason, "reducer-version-mismatch");
  await assertEquivalent(upd.state, paths, NOW_F);
  // The compute functions refuse a version-mismatched state LOUDLY.
  assert.throws(
    () => computeCoverageFromState(loaded, { ...paths, now: NOW_F }),
    /reducer-version-mismatch/,
  );
  assert.throws(
    () => computeDriftFromState(loaded, { ...paths, now: NOW_F }),
    /reducer-version-mismatch/,
  );

  // Truncated JSON -> null.
  writeFileSync(statePath, raw.slice(0, Math.floor(raw.length / 2)));
  assert.equal(loadState(statePath), null);
  // Structurally invalid day bucket -> null (never partially applied).
  const bad = JSON.parse(raw);
  const dayKeys = Object.keys(bad.memory.days);
  assert.ok(dayKeys.length > 0);
  bad.memory.days[dayKeys[0]].both.facts = -1;
  writeFileSync(statePath, JSON.stringify(bad));
  assert.equal(loadState(statePath), null);
  // Shape-valid JSON missing the file states -> null.
  writeFileSync(statePath, JSON.stringify({ reducer_version: REDUCER_VERSION }));
  assert.equal(loadState(statePath), null);
  // Missing file -> null.
  assert.equal(loadState(join(dir, "does-not-exist.json")), null);
});

// ---------------------------------------------------------------------------
// (g) COMPUTE-TIME DRIFT IS LOUD
// ---------------------------------------------------------------------------
const NOW_G = Date.parse("2026-07-10T12:00:00Z");

test("(g) ledger mutated after update => compute throws naming the reason", async () => {
  const dir = fixtureDir();
  const paths = writeSmallFixture(dir, NOW_G);

  const { state } = updateStateFromLedgers(null, paths);
  // Sanity: computes fine pre-mutation.
  computeCoverageFromState(state, { ...paths, now: NOW_G });
  computeDriftFromState(state, { ...paths, now: NOW_G });

  const raw = readFileSync(paths.ledgerPath, "utf8");
  writeFileSync(paths.ledgerPath, raw.replace("PADPADPAD", "QADPADPAD"));

  // NEVER silently returns stale numbers — throws with the verify reason.
  assert.throws(
    () => computeCoverageFromState(state, { ...paths, now: NOW_G }),
    /prefix-drift/,
  );
  assert.throws(
    () => computeDriftFromState(state, { ...paths, now: NOW_G }),
    /prefix-drift/,
  );
});

// ---------------------------------------------------------------------------
// (h) SAVE/LOAD ROUND-TRIP identity + atomicity
// ---------------------------------------------------------------------------
const NOW_H = Date.parse("2026-07-10T12:00:00Z");

test("(h) saveState/loadState round-trip: identical state, identical answers, no tmp litter", async () => {
  const dir = fixtureDir();
  const paths = writeSmallFixture(dir, NOW_H);
  const statePath = join(dir, "state.json");

  const { state } = updateStateFromLedgers(null, paths);
  const covBefore = computeCoverageFromState(state, { ...paths, now: NOW_H });
  const drBefore = computeDriftFromState(state, { ...paths, now: NOW_H });

  saveState(statePath, state);
  const loaded = loadState(statePath);
  assert.notEqual(loaded, null);
  assert.deepStrictEqual(loaded, state); // the state IS a JSON-safe value
  assert.deepStrictEqual(JSON.parse(JSON.stringify(state)), loaded);

  const covAfter = computeCoverageFromState(loaded, { ...paths, now: NOW_H });
  const drAfter = computeDriftFromState(loaded, { ...paths, now: NOW_H });
  assert.deepStrictEqual(covAfter, covBefore);
  assert.deepStrictEqual(drAfter, drBefore);
  await assertEquivalent(loaded, paths, NOW_H);

  // Atomic write left no tmp file behind.
  assert.ok(readdirSync(dir).every((n) => !n.includes(".tmp.")));
});

// ---------------------------------------------------------------------------
// (i) UNTERMINATED COMPLETE TAIL ROW (crashed / mid-append writer)
//
// RED-FIRST RECORD (pre-H1b, 2026-07-14): on this exact fixture the reducer
// reported facts_in_window=2 / current_facts=2 while the originals reported
// 3/3 — the newline-safe checkpoint excludes the complete-but-unterminated
// final row that _ledger-stream.js:226-238 flushes at EOF. The chosen
// contract is compute-time tail folding (health-reducers.js module header):
// the H2 real-ledger equivalence gate can no longer flake when the prod
// ledger is mid-append or a writer crashed between JSON body and newline.
// ---------------------------------------------------------------------------
const NOW_I = Date.parse("2026-07-10T12:00:00Z");

test("(i) complete unterminated final row: folded at compute, checkpointed once terminated", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "memory.jsonl");
  const recallLogPath = join(dir, "recall.jsonl");
  const paths = { ledgerPath, recallLogPath };
  const statePath = join(dir, "state.json");

  const mk = (id, ms, v) =>
    JSON.stringify({ id, kind: "fact", ts: iso(ms), features: { entities: ["a", "b"], valence: 0.5, entity_extractor_version: v } });
  const tailRow = mk("tail-mem", NOW_I - 30 * 60 * 1000, "vTAIL");
  // Final line COMPLETE valid JSON with NO trailing newline (both files).
  writeFileSync(
    ledgerPath,
    mk("m1", NOW_I - HOUR, "v1") + "\n" + mk("m2", NOW_I - 2 * HOUR, "v1") + "\n" + tailRow,
  );
  const recTail = JSON.stringify({
    id: "tail-rec",
    kind: "recall",
    ts: iso(NOW_I - 45 * 60 * 1000),
    populator: { entities_count: 1, inferred_mood_sign: 1, query_episodicity: 0.5 },
  });
  writeFileSync(
    recallLogPath,
    JSON.stringify({ id: "r1", kind: "recall", ts: iso(NOW_I - HOUR), populator: { entities_count: 1, inferred_mood_sign: 1, query_episodicity: 0.25 } }) +
      "\n" +
      recTail,
  );

  let { state, stats } = updateStateFromLedgers(null, paths);
  // The tail rows are NOT checkpointed (newline-safe eof excludes them)...
  assert.equal(stats.memory.linesApplied, 2);
  assert.equal(stats.recall.linesApplied, 1);
  const memRowsInState = Object.values(state.memory.days).reduce(
    (n, b) => n + b.both.facts + b.covOnly.facts,
    0,
  );
  assert.equal(memRowsInState, 2);
  // ...but the computes fold them opportunistically and match the originals
  // (pre-H1b this was the pinned 2-vs-3 divergence on both envelopes).
  const { covMine, drMine } = await assertEquivalent(state, paths, NOW_I);
  assert.equal(covMine.facts_in_window, 3);
  assert.equal(covMine.extractor_versions.entity_extractor_version["vTAIL"], 1);
  assert.equal(drMine.current_facts, 3);
  assert.equal(drMine.current_recalls, 2);

  // Persistence round-trip with a tail-present state: same answers.
  saveState(statePath, state);
  const loaded = loadState(statePath);
  assert.notEqual(loaded, null);
  await assertEquivalent(loaded, paths, NOW_I);

  // A no-append follow-up update stays incremental and folds NOTHING (the
  // tail is still unterminated) — and answers stay equivalent.
  const updSame = updateStateFromLedgers(state, paths);
  assert.equal(updSame.stats.memory.mode, "incremental");
  assert.equal(updSame.stats.memory.linesApplied, 0);
  await assertEquivalent(updSame.state, paths, NOW_I);

  // Terminate the tails: the rows checkpoint EXACTLY ONCE...
  appendFileSync(ledgerPath, "\n");
  appendFileSync(recallLogPath, "\n");
  const upd2 = updateStateFromLedgers(state, paths);
  state = upd2.state;
  assert.equal(upd2.stats.memory.mode, "incremental");
  assert.equal(upd2.stats.memory.linesApplied, 1);
  assert.equal(upd2.stats.recall.mode, "incremental");
  assert.equal(upd2.stats.recall.linesApplied, 1);
  const tailDay = String(Math.floor((NOW_I - 30 * 60 * 1000) / DAY));
  assert.equal(state.memory.days[tailDay].both.versions.entity_extractor_version["vTAIL"], 1);
  // ...and the answers do not change (fold-at-compute vs fold-in-state).
  const after = await assertEquivalent(state, paths, NOW_I);
  assert.equal(after.covMine.facts_in_window, 3);
  assert.equal(after.covMine.extractor_versions.entity_extractor_version["vTAIL"], 1);
});

// ---------------------------------------------------------------------------
// (j) TOCTOU: same-eof rewrite between verifyPrefix and captureCheckpoint
//
// RED-FIRST RECORD (pre-H1b, 2026-07-14, scratch reproduction of the exact
// interleaving): captureCheckpoint({prev}) fell back to a FRESH witness over
// the rewritten file, newCp.eof === priorCp.eof made readAppended vacuous,
// and updateOneFile went "incremental" — a green checkpoint bound to STALE
// aggregates, verifying green on every later compute. The guard
// (witnessPrefixExtends) turns this window into a full rebuild.
// ---------------------------------------------------------------------------
const NOW_J = Date.parse("2026-07-10T12:00:00Z");

test("(j) same-eof rewrite in the verify->capture window => rebuild 'capture-fallback'", async () => {
  const dir = fixtureDir();
  const paths = writeSmallFixture(dir, NOW_J);

  const { state } = updateStateFromLedgers(null, paths);
  await assertEquivalent(state, paths, NOW_J);

  const raw = readFileSync(paths.ledgerPath, "utf8");
  assert.ok(raw.includes("PADPADPAD"));
  let fired = 0;
  try {
    __testHooks.beforeIncrementalCapture = ({ role, path }) => {
      if (role !== "memory") return;
      fired += 1;
      // Same-LENGTH in-place rewrite: eof unchanged, bytes changed — lands
      // exactly in the window AFTER updateOneFile's verifyPrefix passed and
      // BEFORE captureCheckpoint re-verifies.
      writeFileSync(path, raw.replace("PADPADPAD", "QADPADPAD"));
    };
    const upd = updateStateFromLedgers(state, paths);
    assert.equal(fired, 1);
    // NEVER a green incremental checkpoint over stale aggregates.
    assert.equal(upd.stats.memory.mode, "rebuild");
    assert.equal(upd.stats.memory.reason, "capture-fallback");
    // The untouched recall file is unaffected by the injected fault.
    assert.equal(upd.stats.recall.mode, "incremental");
    // The rebuilt state answers correctly for the REWRITTEN file.
    await assertEquivalent(upd.state, paths, NOW_J);
  } finally {
    __testHooks.beforeIncrementalCapture = null;
  }
});

// ---------------------------------------------------------------------------
// (k) STATE VALIDATION HARDENING: checkpoint-bound offsets, canonical day
//     keys, and the swapped-offsets double-count class
//
// RED-FIRST RECORD (pre-H1b, 2026-07-14): a saved state with two rows'
// offset pairs swapped across day buckets passed loadState AND saveState,
// and computeCoverageFromState silently reported extractor_versions
// {vINTER:2} where the full scan reports {vBOUND:1, vINTER:1} — the interior
// row double-counted (aggregate + boundary replay), the boundary row lost.
// Out-of-eof offsets, duplicate offsets, and day keys "01"/"-0" also loaded
// as valid ("01" then threw a TypeError mid-compute instead of rebuilding).
// ---------------------------------------------------------------------------
const NOW_K = Date.parse("2026-07-10T12:00:00Z");

test("(k) loadState nulls corrupt offsets/day-keys; swapped offsets never double-count", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "memory.jsonl");
  const recallLogPath = join(dir, "recall.jsonl");
  const paths = { ledgerPath, recallLogPath };
  const statePath = join(dir, "state.json");

  const mk = (id, ms, v) =>
    JSON.stringify({ id, kind: "fact", ts: iso(ms), features: { entities: ["a"], entity_extractor_version: v } });
  // Two rows on day(now) (a BOUNDARY day) + one row 3 days back (INTERIOR
  // for a 7d window anchored at NOW_K).
  writeLedger(ledgerPath, [
    mk("b1", NOW_K - HOUR, "vBOUND"),
    mk("b2", NOW_K - 2 * HOUR, "vBOUND"),
    mk("i1", NOW_K - 3 * DAY, "vINTER"),
  ]);
  writeLedger(recallLogPath, [
    JSON.stringify({ id: "q1", kind: "recall", ts: iso(NOW_K - HOUR), populator: { entities_count: 1, inferred_mood_sign: 1, query_episodicity: 0.5 } }),
  ]);

  const { state } = updateStateFromLedgers(null, paths);
  saveState(statePath, state);
  const raw = readFileSync(statePath, "utf8");
  const dBound = String(Math.floor((NOW_K - HOUR) / DAY));
  const dInter = String(Math.floor((NOW_K - 3 * DAY) / DAY));
  const reload = () => JSON.parse(raw);

  // Baseline: the untampered persisted state loads fine.
  assert.notEqual(loadState(statePath), null);

  const expectNull = (mutate, label) => {
    const s = reload();
    mutate(s);
    writeFileSync(statePath, JSON.stringify(s));
    assert.equal(loadState(statePath), null, `loadState must reject: ${label}`);
  };

  // Offset pair reaching past the checkpoint's eof.
  expectNull((s) => {
    s.memory.days[dBound].bothOff[0] = s.memory.checkpoint.eof;
  }, "offset past checkpoint.eof");
  // Duplicate offset pair (not strictly ascending) — silent double-count
  // fuel. Keep the pair count consistent so THIS check is what fires.
  expectNull((s) => {
    const off = s.memory.days[dBound].bothOff;
    off[2] = off[0];
    off[3] = off[1];
  }, "duplicate offset pair");
  // Non-canonical day keys: pre-H1b "01" loaded fine and THREW mid-compute.
  expectNull((s) => {
    s.memory.days["01"] = s.memory.days[dInter];
    delete s.memory.days[dInter];
  }, "day key '01'");
  expectNull((s) => {
    s.memory.days["-0"] = s.memory.days[dInter];
    delete s.memory.days[dInter];
  }, "day key '-0'");
  // Null checkpoint paired with non-empty days: semantically impossible.
  expectNull((s) => {
    s.memory.checkpoint = null;
  }, "null checkpoint + populated days");
  // Offset-count / row-count mismatch (tampered aggregates).
  expectNull((s) => {
    s.memory.days[dBound].both.facts += 1;
  }, "offset/row count mismatch");

  // SWAPPED ACROSS DAY BUCKETS: both offsets still point at valid JSON fact
  // lines inside the verified prefix, each bucket stays strictly ascending
  // and eof-bounded (b2 is the file's 2nd row, i1 its 3rd: swapping THOSE
  // keeps [b1, i1] and [b2] both ascending) — the state is SHAPE-VALID and
  // must load...
  const swapped = reload();
  const b2Pair = swapped.memory.days[dBound].bothOff.slice(2, 4);
  const interPair = swapped.memory.days[dInter].bothOff.slice(0, 2);
  swapped.memory.days[dBound].bothOff.splice(2, 2, ...interPair);
  swapped.memory.days[dInter].bothOff = b2Pair;
  writeFileSync(statePath, JSON.stringify(swapped));
  const loadedSwapped = loadState(statePath);
  assert.notEqual(loadedSwapped, null);
  // ...but compute must NEVER silently double-count off it: the boundary
  // replay binds every stored offset to its bucket's day and throws.
  assert.throws(
    () => computeCoverageFromState(loadedSwapped, { ...paths, now: NOW_K }),
    /state-offset-mismatch/,
  );
  assert.throws(
    () => computeDriftFromState(loadedSwapped, { ...paths, now: NOW_K }),
    /state-offset-mismatch/,
  );

  // The untampered state still computes and matches the originals.
  await assertEquivalent(state, paths, NOW_K);
});

// ---------------------------------------------------------------------------
// (l) HOSTILE VERSION STRINGS: "constructor", "__proto__", "_missing_"
//
// RED-FIRST RECORD (pre-H1b, 2026-07-14): one row with extractor version
// "constructor" turned the histogram count into the string
// "function Object() { [native code] }1" (inherited-prototype read),
// "__proto__" was silently dropped (inherited setter), the state failed its
// OWN isValidState => saveState threw AND every subsequent update rebuilt
// from scratch ("no-prior-state" forever); a literal "_missing_" version
// also collided with the missing-version sentinel, diverging drift's
// version sets from the original.
// ---------------------------------------------------------------------------
const NOW_L = Date.parse("2026-07-10T12:00:00Z");

test("(l) hostile extractor versions: honest state, no rebuild loop, exact envelopes", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "memory.jsonl");
  const recallLogPath = join(dir, "recall.jsonl");
  const paths = { ledgerPath, recallLogPath };
  const statePath = join(dir, "state.json");

  const mk = (id, ms, v) =>
    JSON.stringify({ id, kind: "fact", ts: iso(ms), features: { entities: ["a"], entity_extractor_version: v, episodicity_version: "e1" } });
  writeLedger(ledgerPath, [
    mk("h1", NOW_L - HOUR, "constructor"),
    mk("h2", NOW_L - 2 * HOUR, "__proto__"),
    mk("h3", NOW_L - 3 * HOUR, "_missing_"), // LITERAL version string
    mk("h4", NOW_L - 4 * HOUR, "constructor"),
    mk("h5", NOW_L - 5 * HOUR, "v1"),
    // Genuinely missing version — must merge with the literal "_missing_"
    // under coverage's sentinel yet stay OUT of drift's version sets.
    JSON.stringify({ id: "h6", kind: "fact", ts: iso(NOW_L - 6 * HOUR), features: { entities: ["a"], episodicity_version: "e1" } }),
    // Baseline-window row so the version-bump alert has a baseline set.
    mk("h7", NOW_L - 10 * DAY, "v0"),
  ]);
  writeLedger(recallLogPath, [
    JSON.stringify({ id: "q1", kind: "recall", ts: iso(NOW_L - HOUR), populator: { entities_count: 1, inferred_mood_sign: 1, query_episodicity: 0.5 } }),
  ]);

  const { state } = updateStateFromLedgers(null, paths);

  // The state survives its own validation: saveState does not throw, the
  // round trip is exact (own "__proto__"/"constructor" data properties
  // survive JSON round-trip AND structuredClone).
  saveState(statePath, state);
  const loaded = loadState(statePath);
  assert.notEqual(loaded, null);
  assert.deepStrictEqual(loaded, state);

  // The histogram counts are HONEST numbers under hostile keys.
  const dayH = String(Math.floor((NOW_L - HOUR) / DAY));
  const hist = state.memory.days[dayH].both.versions.entity_extractor_version;
  assert.equal(hist["constructor"], 2);
  assert.equal(Object.prototype.hasOwnProperty.call(hist, "__proto__"), true);
  assert.equal(hist["_missing_"], 1); // the LITERAL string only
  assert.equal(state.memory.days[dayH].both.vMissing.entity_extractor_version, 1); // h6

  // NO permanent rebuild-every-update loop (pre-H1b: "no-prior-state"
  // rebuild on every call because the state failed validation).
  const upd2 = updateStateFromLedgers(loaded, paths);
  assert.equal(upd2.stats.memory.mode, "incremental");
  assert.equal(upd2.stats.memory.linesApplied, 0);
  assert.equal(upd2.stats.recall.mode, "incremental");

  // Envelopes match the full-scan originals EXACTLY — including the
  // originals' own plain-object tick semantics ("constructor" degrades to
  // the same concatenated string; "__proto__" is absent from coverage's
  // histogram but PRESENT in drift's version sets).
  const { covMine, drMine } = await assertEquivalent(state, paths, NOW_L);
  const env = covMine.extractor_versions.entity_extractor_version;
  assert.equal(typeof env["constructor"], "string"); // original's degradation, replayed
  assert.equal(Object.prototype.hasOwnProperty.call(env, "__proto__"), false);
  assert.equal(env["_missing_"], 2); // literal + genuinely-missing merged
  assert.equal(env["v1"], 1);
  const bump = drMine.alerts.find(
    (a) => a.kind === "extractor_version_bump" && a.axis === "entity_extractor_version",
  );
  assert.ok(bump, "version-bump alert must fire");
  const curSet = bump.current.slice().sort();
  assert.deepStrictEqual(curSet, ["__proto__", "_missing_", "constructor", "v1"]);

  // And the reloaded state computes identically (incremental path included).
  await assertEquivalent(upd2.state, paths, NOW_L);
});

// ---------------------------------------------------------------------------
// (m) WITNESS-BUDGET OVERFLOW on legitimate appends stays incremental (S1c)
//
// Geometry: each small persisted append+update extends the witness by one
// same-block entry (short-final-block extension), so the state's witness
// reaches MAX_WITNESS_ENTRIES (128) within ~128 gaining updates;
// captureCheckpoint({prev}) then refuses a 129th entry and resamples FRESH
// with the prior prefix verified INSIDE the capture (non-enumerable
// prefixVerified). updateOneFile must consume that signal: the cap-crossing
// update keeps the incremental fold under the compacted witness — only a
// genuinely UNVERIFIED fresh sample (suite (j)) may full-rebuild.
//
// RED-FIRST RECORD (pre-S1c, 2026-07-14, scratchpad copy of the module tree
// with the S1c hunk reverted): append tick 128 reported mode "rebuild"
// reason "capture-fallback" — a full ledger re-stream roughly every ~63-128
// append-updates, mislabeled as the TOCTOU rewrite it is not. Quantified
// 2026-07-14 on a scratchpad COPY of the real 2.11GiB ledger (fresh witness
// 65 entries -> cap crossed at append tick 64): pre-fix cost is the 3.6s
// full rebuild; post-fix the cap-crossing update stayed incremental /
// "witness-compacted" at 155ms with 16MiB self-reported bytesRead (23x).
// ---------------------------------------------------------------------------
const NOW_M = Date.parse("2026-07-10T12:00:00Z");

test("(m) witness past MAX_WITNESS_ENTRIES via legitimate appends => incremental 'witness-compacted'", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "memory.jsonl");
  const recallLogPath = join(dir, "recall.jsonl");
  const paths = { ledgerPath, recallLogPath };

  const mk = (i) =>
    JSON.stringify({
      id: "wc" + i,
      kind: "fact",
      ts: iso(NOW_M - (i % 5) * HOUR),
      features: { entities: ["e" + i], valence: 0.5, entity_extractor_version: "v1" },
    });
  writeLedger(ledgerPath, [mk(0)]);
  writeLedger(recallLogPath, [
    JSON.stringify({ id: "r1", kind: "recall", ts: iso(NOW_M - HOUR), populator: { entities_count: 1, inferred_mood_sign: 1, query_episodicity: 0.5 } }),
  ]);

  let { state } = updateStateFromLedgers(null, paths);
  let compacted = 0;
  for (let i = 1; i <= 140; i++) {
    appendFileSync(ledgerPath, mk(i) + "\n");
    const upd = updateStateFromLedgers(state, paths);
    state = upd.state;
    const s = upd.stats.memory;
    // The core gate: a legitimate append must NEVER degrade to a full
    // re-stream, cap crossing included (pre-S1c: rebuild/capture-fallback
    // at tick 128).
    assert.equal(
      s.mode,
      "incremental",
      `append tick ${i}: got mode=${s.mode}${s.reason ? ` reason=${s.reason}` : ""}`,
    );
    assert.equal(s.linesApplied, 1, `append tick ${i}: exactly the one appended row folds`);
    if (s.reason === "witness-compacted") {
      compacted += 1;
      // The compacted (fresh, downsampled) witness is what got checkpointed —
      // NOT a 129-entry witness, NOT the prior saturated one.
      assert.ok(
        state.memory.checkpoint.witness.length < 128,
        "cap-crossing update must checkpoint the compacted witness",
      );
    } else {
      assert.equal(s.reason, null, `append tick ${i}: unexpected reason ${s.reason}`);
    }
  }
  assert.ok(compacted >= 1, "140 gaining updates must cross the 128-entry witness cap at least once");

  // The untouched recall file never compacts or rebuilds alongside.
  const updRec = updateStateFromLedgers(state, paths);
  assert.equal(updRec.stats.recall.mode, "incremental");
  assert.equal(updRec.stats.memory.mode, "incremental");
  assert.equal(updRec.stats.memory.reason, null, "post-compaction updates extend normally again");

  // Soundness of the compacted fold: answers match the full-scan originals
  // exactly (a hybrid/stale fold would diverge here).
  const { covMine } = await assertEquivalent(updRec.state, paths, NOW_M);
  assert.equal(covMine.facts_in_window, 141);
});

// ---------------------------------------------------------------------------
// (n) BOUNDED STATE (Finding 3): retention pruning drops OLD day buckets on
//     update while leaving every <=30d windowed output byte-identical to a
//     full-history rebuild at the SAME now.
//
// RED-FIRST RECORD: the pre-fix reducer retained O(total-ledger-history) day
// buckets — clone + serialize + fsync cost grew with lifetime rows and a tiny
// delta authorized a huge sync rewrite. Pruning bounds retained buckets to the
// window; this suite proves it is output-invariant (pruned deepStrictEquals a
// full rebuild) AND actually removes the far-past buckets.
// ---------------------------------------------------------------------------
const NOW_N = Date.parse("2026-07-10T12:00:00Z");

test("(n) retention pruning drops old buckets; windowed output identical to a full rebuild", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "memory.jsonl");
  const recallLogPath = join(dir, "recall.jsonl");
  const paths = { ledgerPath, recallLogPath };
  const statePath = join(dir, "pruned-state.json");

  // Fixture spanning >32 days (0..40 days ago), so a chunk is beyond the
  // 30d + 2d retention horizon anchored at NOW_N.
  const memLines = [];
  const recLines = [];
  for (let k = 0; k <= 40; k++) {
    memLines.push(
      JSON.stringify({
        id: "m" + k,
        kind: "fact",
        ts: iso(NOW_N - k * DAY - HOUR),
        features: {
          entities: k % 2 === 0 ? ["e" + k, "shared"] : [],
          valence: k % 3 === 0 ? 0.5 : null,
          episodicity: 0.25,
          time_anchors: k % 4 === 0 ? [{ kind: "day" }] : [],
          entity_extractor_version: "v1",
          episodicity_version: "e1",
          time_anchor_resolver_version: "t1",
          valence_model_version: "m1",
        },
      }),
    );
    recLines.push(
      JSON.stringify({
        id: "r" + k,
        kind: "recall",
        ts: iso(NOW_N - k * DAY - 2 * HOUR),
        populator: { entities_count: k % 2, inferred_mood_sign: 1, query_episodicity: (k % 4) * 0.25 },
      }),
    );
  }
  writeLedger(ledgerPath, memLines);
  writeLedger(recallLogPath, recLines);

  // Full rebuild WITHOUT a retention anchor (unpruned) vs WITH one at NOW_N.
  const full = updateStateFromLedgers(null, paths);
  const pruned = updateStateFromLedgers(null, { ...paths, retentionNowMs: NOW_N });

  const floorDay = Math.floor(NOW_N / DAY) - (RETENTION_WINDOW_DAYS + RETENTION_MARGIN_DAYS);
  for (const role of ["memory", "recall"]) {
    const fullDays = Object.keys(full.state[role].days).map(Number);
    const prunedDays = Object.keys(pruned.state[role].days).map(Number);
    assert.ok(fullDays.some((d) => d < floorDay), `${role}: fixture must include prunable days`);
    assert.ok(prunedDays.length < fullDays.length, `${role}: pruning must drop day buckets`);
    assert.ok(prunedDays.every((d) => d >= floorDay), `${role}: no retained day below the floor`);
    // Bounded by the window, not by history (all retained days fit the horizon).
    assert.ok(
      prunedDays.length <= RETENTION_WINDOW_DAYS + RETENTION_MARGIN_DAYS + 1,
      `${role}: retained ${prunedDays.length} buckets exceeds the window bound`,
    );
  }

  // The pruned state is still shape-valid: it round-trips saveState/loadState.
  saveState(statePath, pruned.state);
  assert.notEqual(loadState(statePath), null);

  // Windowed output is IDENTICAL to the full rebuild at the SAME now (coverage
  // 7d + a 30d window, drift 30d/7d) — pruning removed only unreadable buckets.
  for (const now of [NOW_N, NOW_N + 12 * HOUR]) {
    for (const windowDays of [undefined, 30]) {
      const covOpts = { ...paths, now };
      if (windowDays !== undefined) covOpts.windowDays = windowDays;
      assert.deepStrictEqual(
        computeCoverageFromState(pruned.state, covOpts),
        computeCoverageFromState(full.state, covOpts),
      );
    }
    assert.deepStrictEqual(
      computeDriftFromState(pruned.state, { ...paths, now }),
      computeDriftFromState(full.state, { ...paths, now }),
    );
  }

  // And still equivalent to the full-scan originals (the load-bearing gate).
  await assertEquivalent(pruned.state, paths, NOW_N);

  // pruneFileStateDays is a no-op without a finite anchor (the default path).
  const cloneDays = { ...full.state.memory.days };
  pruneFileStateDays(full.state.memory, undefined);
  assert.deepStrictEqual(Object.keys(full.state.memory.days).sort(), Object.keys(cloneDays).sort());
});

// ---------------------------------------------------------------------------
// (o) VERIFY MEMO (Finding 1): a per-call memo lets the compute functions
//     skip the redundant sampled re-verify of an UNCHANGED ledger — driving
//     the per-compute witness-hash work to zero — while (a) yielding identical
//     numbers and (b) keeping the default (no-memo) path fully loud, and a
//     stale memo self-invalidating on any stat change.
//
// RED-FIRST RECORD: pre-fix, one envelope-cache-miss health call re-ran
// verifyPrefix ~10x over the same two unchanged ledgers (planReducerFold, then
// per-file in update, then require+still inside BOTH computes). The memo
// removes the per-compute re-verifies; below, the compute-side hash count
// drops from >0 to exactly 0.
// ---------------------------------------------------------------------------
const NOW_O = Date.parse("2026-07-10T12:00:00Z");

test("(o) verify memo elides the sampled re-verify; identical output; default stays loud", async () => {
  const dir = fixtureDir();
  const ledgerPath = join(dir, "memory.jsonl");
  const recallLogPath = join(dir, "recall.jsonl");
  const paths = { ledgerPath, recallLogPath };

  // Multi-block fixture so verifyPrefix hashes several witness entries.
  const pad = "y".repeat(20000);
  const memLines = [];
  for (let i = 0; i < 30; i++) {
    memLines.push(
      JSON.stringify({
        id: "v" + i,
        kind: "fact",
        ts: iso(NOW_O - (i % 5) * HOUR),
        marker: i === 0 ? "MARKERMARKER" : "m",
        features: { entities: ["a"], entity_extractor_version: "v1", episodicity_version: "e1" },
        pad,
      }),
    );
  }
  writeLedger(ledgerPath, memLines);
  writeLedger(recallLogPath, [
    JSON.stringify({ id: "q1", kind: "recall", ts: iso(NOW_O - HOUR), populator: { entities_count: 1, inferred_mood_sign: 1, query_episodicity: 0.5 } }),
  ]);
  const { state } = updateStateFromLedgers(null, paths);

  // Build the memo exactly as the health handler's planReducerFold does:
  // record {checkpoint, size, mtimeMs} per verified ledger.
  const memo = new Map();
  for (const [role, p] of [["memory", ledgerPath], ["recall", recallLogPath]]) {
    const fsRole = state[role];
    if (fsRole.checkpoint === null) continue;
    const st = statSync(p);
    memo.set(p, { checkpoint: fsRole.checkpoint, size: st.size, mtimeMs: st.mtimeMs });
  }

  const hashNone = measureHashCalls(() => {
    computeCoverageFromState(state, { ...paths, now: NOW_O });
    computeDriftFromState(state, { ...paths, now: NOW_O });
  });
  const hashMemo = measureHashCalls(() => {
    computeCoverageFromState(state, { ...paths, now: NOW_O, verifyMemo: memo });
    computeDriftFromState(state, { ...paths, now: NOW_O, verifyMemo: memo });
  });
  assert.ok(hashNone > 0, "sanity: the default path hashes witness ranges to verify");
  assert.equal(hashMemo, 0, `the memo elides every compute-side re-verify (got ${hashMemo})`);

  // The numbers are byte-identical with and without the memo.
  assert.deepStrictEqual(
    computeCoverageFromState(state, { ...paths, now: NOW_O, verifyMemo: memo }),
    computeCoverageFromState(state, { ...paths, now: NOW_O }),
  );
  assert.deepStrictEqual(
    computeDriftFromState(state, { ...paths, now: NOW_O, verifyMemo: memo }),
    computeDriftFromState(state, { ...paths, now: NOW_O }),
  );

  // LOUDNESS: the memo is keyed on stat identity, so a real change (shrink a
  // marker) self-invalidates it — compute still verifies and THROWS rather
  // than emitting numbers off changed bytes, even WITH the (now stale) memo.
  const raw = readFileSync(ledgerPath, "utf8");
  assert.ok(raw.includes("MARKERMARKER"));
  writeFileSync(ledgerPath, raw.replace("MARKERMARKER", "M")); // size shrinks
  assert.throws(
    () => computeCoverageFromState(state, { ...paths, now: NOW_O, verifyMemo: memo }),
    /shrunk|prefix-drift/,
  );
});

// ---------------------------------------------------------------------------
// Hermeticity: the production ledgers were never touched (nor read via any
// path that would bump atime-relevant stats — we compare mtime+size).
// ---------------------------------------------------------------------------
test("prod ledger stat snapshots unchanged", () => {
  assert.equal(snap(PROD_MEMORY_JSONL), PROD_BEFORE_MEM);
  assert.equal(snap(PROD_RECALL_JSONL), PROD_BEFORE_REC);
});
