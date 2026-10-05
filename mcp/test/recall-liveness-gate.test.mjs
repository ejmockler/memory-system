// A1 — recall-liveness gate test. THIS SUITE EXITS 0.
//
// Five hermetic subtests pin the verdict algebra and the loud-absence
// contract. The sixth runs the gate against the LIVE
// <checkout>/ledgers/recall.jsonl, PRINTS the observed
// rate/sample/verdict, and asserts only that the result is WELL-FORMED.
//
// THE RED SIGNAL IS THE PRINTED LINE, NOT AN ASSERTION.
//   `[A1 LIVE DIAGNOSTIC] rate=... sample=... verdict=...` is the recorded
//   baseline. Today it reads verdict=red. The C-track populator fix is
//   expected to move it to green; the way to see that is to RE-RUN this
//   suite and re-read the line, not to make the suite fail.
//
// WHY THE LIVE SUBTEST ASSERTS NO COLOUR.
//   Asserting `green` fails today — and it fails for a defect this suite
//   exists to REPORT, not to cause. Asserting `red` would fail the day the
//   populator fix lands, i.e. the suite would go red on success. Either way
//   the suite would be lying about a different thing than the one it names.
//   A gate whose only exit is "the bug is still there" has no upper exit.
//   So the live case asserts well-formedness (a colour from the closed set,
//   a finite rate in [0,1], an integer sample, the declared denominator and
//   window, a frozen object) and prints the colour.
//
// DO NOT "fix" this suite by lowering `threshold`, lowering `minSample`, or
// accepting 'inconclusive' as a pass anywhere. A gate that cannot fail
// measures nothing, and 'inconclusive' means "we never found out". Those
// constants are pinned by subtests (1) and (3) and by the probe defaults;
// removing the colour claim from the LIVE case is the only weakening this
// file ever sanctioned.
//
// WHY NOTHING LIVE IS PINNED.
//   recall.jsonl is live and append-only: `rate` and `sample` move on every
//   single memory_recall. The A1 spec was written against 0.0189 / 265 and
//   those numbers were already stale before this file existed. Pinning them
//   would manufacture a false failure ("the constant drifted") and MASK the
//   real one ("the query side is dead"). So rate and sample are printed as
//   DIAGNOSTICS and never equality-asserted.
//
// LEDGER DISCIPLINE (standing hard-gates.test.mjs:6-12 pattern).
//   Synthetic fixtures live in mkdtempSync dirs and are removed on exit.
//   The one production file this suite touches — recall.jsonl — is READ
//   ONLY, via computeSynthesisCoverage's read-only stream. Nothing here
//   opens memory.jsonl at all: see the `ledgerPath` canary subtest, which
//   proves the probe never forwards a ledger path into the coverage scan.
//
// Run:
//   node test/recall-liveness-gate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Hermetic env BEFORE the dynamic import, per the standing C-NEW-2 pattern.
// The probe chain (recall-liveness-probe -> coverage-probe -> _ledger-stream)
// takes every path from its caller and never reaches through to config.js,
// but the env pins are kept so an accidental future reach-through lands in
// the temp tree instead of <checkout>.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "recall-liveness-"));
process.env.MEMORY_ROOT = join(TMP_ROOT, "memory-root");
process.env.LEDGERS_BASE_DIR = join(TMP_ROOT, "ledgers-base");
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage-base");
process.env.POLICY_BASE_DIR = join(TMP_ROOT, "policy-base");

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

const { evaluateRecallLiveness } = await import(
  "../lib/synthesis/recall-liveness-probe.js"
);

// The one production artifact this suite reads. Read-only, always. Anchored
// to this checkout (never to the temp-redirected MEMORY_ROOT above).
const CHECKOUT_RECALL_LOG = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "ledgers", "recall.jsonl",
);
// A fresh checkout has no recall log until its first memory_recall, and the
// gate and the reporter are both LOUD on absence (they throw — see subtests
// (5) and (11)). So the two LIVE arms read the checkout's own log when one exists and
// otherwise a small synthetic stand-in under TMP_ROOT. The same assertions run
// either way; nothing is skipped, and the printed diagnostic names the source.
function writeStandInRecallLog() {
  const abs = join(TMP_ROOT, "fresh-checkout-recall.jsonl");
  const nowMs = Date.now();
  const lines = [];
  for (let i = 0; i < 12; i += 1) {
    lines.push(
      JSON.stringify({
        kind: "recall",
        ts: new Date(nowMs - (i + 1) * 60_000).toISOString(),
        populator: { entities_count: i < 6 ? 2 : 0 },
      }),
    );
  }
  writeFileSync(abs, `${lines.join("\n")}\n`, { mode: 0o600 });
  return abs;
}
const LIVE_RECALL_LOG_IS_CHECKOUT = existsSync(CHECKOUT_RECALL_LOG);
const LIVE_RECALL_LOG = LIVE_RECALL_LOG_IS_CHECKOUT
  ? CHECKOUT_RECALL_LOG
  : writeStandInRecallLog();

// Pinned clock for the hermetic cases so `evaluated_at` (derived from the
// snapshot's clock anchor) is deterministic and byte-identity comparisons
// cannot straddle a millisecond.
const PINNED_NOW = new Date("2026-08-04T12:00:00.000Z");

/**
 * Write a synthetic recall.jsonl. `withEntities` rows carry a populator
 * block with entities_count > 0; the rest carry entities_count 0 — the
 * exact shape recall.js writes and coverage-probe.js:224 counts.
 */
function writeRecallFixture(dir, name, { total, withEntities }) {
  const abs = join(dir, name);
  const lines = [];
  for (let i = 0; i < total; i += 1) {
    lines.push(
      JSON.stringify({
        kind: "recall",
        // Inside the 3650-day window relative to PINNED_NOW, and in the past.
        ts: new Date(PINNED_NOW.getTime() - (i + 1) * 60_000).toISOString(),
        populator: { entities_count: i < withEntities ? 2 : 0 },
      }),
    );
  }
  writeFileSync(abs, lines.length > 0 ? `${lines.join("\n")}\n` : "", {
    mode: 0o600,
  });
  return abs;
}

// ---------------------------------------------------------------------------
// (1) GREEN — rate at or above threshold, sample at or above minSample.
// ---------------------------------------------------------------------------
test("(1) 6-of-10 populated recalls at minSample=1 -> green", async () => {
  const dir = mkdtempSync(join(TMP_ROOT, "green-"));
  const recallLogPath = writeRecallFixture(dir, "recall.jsonl", {
    total: 10,
    withEntities: 6,
  });

  const v = await evaluateRecallLiveness({
    recallLogPath,
    minSample: 1,
    now: PINNED_NOW,
  });

  assert.equal(v.verdict, "green");
  // pct() is a FRACTION (coverage-probe.js:130), not a percent: 6/10 = 0.6.
  assert.equal(v.rate, 0.6);
  assert.equal(v.sample, 10);
  assert.equal(v.threshold, 0.5, "the default threshold must not drift");
  assert.equal(v.denominator, "recalls_in_window");
  assert.equal(v.window_days, 3650);
  assert.ok(Object.isFrozen(v), "the verdict object must be frozen");
});

// ---------------------------------------------------------------------------
// (2) INCONCLUSIVE — zero rows. Never a green off a 0/0 divide.
// ---------------------------------------------------------------------------
test("(2) a 0-row recall log -> inconclusive, never green", async () => {
  const dir = mkdtempSync(join(TMP_ROOT, "empty-"));
  const recallLogPath = writeRecallFixture(dir, "recall.jsonl", {
    total: 0,
    withEntities: 0,
  });

  // minSample=1 is the smallest gate that can exist; 0 rows still fails it.
  const v = await evaluateRecallLiveness({
    recallLogPath,
    minSample: 1,
    now: PINNED_NOW,
  });

  assert.equal(v.verdict, "inconclusive");
  assert.equal(v.sample, 0);
  assert.equal(v.rate, 0);
  assert.notEqual(
    v.verdict,
    "green",
    "an empty ledger must never be laundered into a pass",
  );
});

// ---------------------------------------------------------------------------
// (3) INCONCLUSIVE — 100% rate but under minSample. Sample gates FIRST.
// ---------------------------------------------------------------------------
test("(3) 100% rate below minSample -> inconclusive (sample gates before threshold)", async () => {
  const dir = mkdtempSync(join(TMP_ROOT, "small-"));
  const recallLogPath = writeRecallFixture(dir, "recall.jsonl", {
    total: 5,
    withEntities: 5,
  });

  // Default minSample (100) applies; 5 rows at a perfect rate is not evidence.
  const v = await evaluateRecallLiveness({ recallLogPath, now: PINNED_NOW });

  assert.equal(v.rate, 1, "the fixture really is at a perfect rate");
  assert.equal(v.minSample, 100, "the default minSample must not drift");
  assert.equal(
    v.verdict,
    "inconclusive",
    "minSample must be evaluated BEFORE the threshold — a perfect rate off a " +
      "tiny sample is not liveness",
  );
});

// ---------------------------------------------------------------------------
// (4) CANARY — a supplied `ledgerPath` changes NOTHING.
//
// coverage-probe.js:322 gates the memory.jsonl scan on `if (ledgerPath)`.
// Production memory.jsonl is 2.9 GB and this probe runs at windowDays 3650,
// so forwarding the key would stream the whole ledger on the health path.
// The canary ledger here is chmod 000: coverage-probe's LOUD-FAILURE
// contract THROWS on an unreadable ledger, so if the probe ever starts
// forwarding `ledgerPath` this subtest fails with EACCES rather than
// silently getting slower.
// ---------------------------------------------------------------------------
test("(4) a passed ledgerPath is ignored — byte-identical result, no ledger read", async () => {
  const dir = mkdtempSync(join(TMP_ROOT, "canary-"));
  const recallLogPath = writeRecallFixture(dir, "recall.jsonl", {
    total: 10,
    withEntities: 6,
  });

  const unreadableLedger = join(dir, "memory.jsonl");
  writeFileSync(
    unreadableLedger,
    `${JSON.stringify({ kind: "fact", ts: PINNED_NOW.toISOString(), features: {} })}\n`,
    { mode: 0o600 },
  );
  chmodSync(unreadableLedger, 0o000);
  process.on("exit", () => {
    try {
      chmodSync(unreadableLedger, 0o600);
    } catch {
      // best-effort so the TMP_ROOT cleanup can unlink it
    }
  });

  const without = await evaluateRecallLiveness({
    recallLogPath,
    minSample: 1,
    now: PINNED_NOW,
  });
  const with_ = await evaluateRecallLiveness({
    recallLogPath,
    ledgerPath: unreadableLedger,
    minSample: 1,
    now: PINNED_NOW,
  });

  assert.deepEqual(
    with_,
    without,
    "supplying ledgerPath must not change the verdict object at all",
  );
  assert.equal(
    JSON.stringify(with_),
    JSON.stringify(without),
    "the two results must be byte-identical, not merely equivalent",
  );
});

// ---------------------------------------------------------------------------
// (5) LOUD ABSENCE — a path that was never created must REJECT.
//
// _ledger-stream.js:146 treats ENOENT as the one benign errno and returns
// zeros with readError null; coverage-probe.js:374 destructures only
// `{ rows }`, so that signal is gone before a caller can see it. Without the
// probe's own statSync a TYPO'D PATH produces sample 0 -> 'inconclusive',
// byte-identical to the genuinely-empty-window answer in subtest (2). Those
// are different facts about the world and must stay distinguishable: (2)
// writes a REAL 0-byte file and still gets 'inconclusive'; this one never
// creates the file at all and gets an exception naming the path.
// ---------------------------------------------------------------------------
test("(5) an absent recall log REJECTS loudly — never 'inconclusive'", async () => {
  const dir = mkdtempSync(join(TMP_ROOT, "absent-"));
  // Deliberately NOT created. This is the shape of a config typo.
  const missingPath = join(dir, "no-such-recall.jsonl");

  await assert.rejects(
    () => evaluateRecallLiveness({ recallLogPath: missingPath, minSample: 1, now: PINNED_NOW }),
    (err) => {
      assert.ok(err instanceof Error, "must reject with an Error");
      assert.match(
        err.message,
        /recall log|unreadable|absent/,
        "the message must say the recall log is unreadable or absent",
      );
      assert.ok(
        err.message.includes(missingPath),
        "the message must NAME the path so a typo is diagnosable from the note alone",
      );
      return true;
    },
  );

  // And the same probe on a path that DOES exist but holds no rows still
  // returns the third state — proving the two cases have not been merged.
  const realButEmpty = writeRecallFixture(dir, "recall.jsonl", { total: 0, withEntities: 0 });
  const v = await evaluateRecallLiveness({
    recallLogPath: realButEmpty,
    minSample: 1,
    now: PINNED_NOW,
  });
  assert.equal(v.verdict, "inconclusive");
  assert.equal(v.sample, 0);
});

// ---------------------------------------------------------------------------
// (6) LIVE — THE GATE. Prints the baseline; asserts well-formedness only.
//
// NO COLOUR IS ASSERTED HERE, deliberately. See "WHY THE LIVE SUBTEST
// ASSERTS NO COLOUR" in this file's header: `green` fails today for the very
// defect the gate reports, and `red` would fail the day the populator fix
// lands. The RED baseline is the PRINTED `[A1 LIVE DIAGNOSTIC]` line — re-run
// this suite after the C-track fix and re-read it. What IS asserted is that
// the gate really ran end-to-end over the live ledger and produced a verdict
// that means something: a colour from the closed set, a finite rate in [0,1],
// an integer sample, and the declared denominator/window it was measured on.
// ---------------------------------------------------------------------------
test("(6) LIVE recall.jsonl — gate runs and returns a well-formed verdict", async () => {
  const startedMs = Date.now();
  const v = await evaluateRecallLiveness({ recallLogPath: LIVE_RECALL_LOG });
  const elapsedMs = Date.now() - startedMs;

  console.log(
    `[A1 LIVE DIAGNOSTIC] source=${LIVE_RECALL_LOG_IS_CHECKOUT ? "checkout ledgers/recall.jsonl" : "synthetic stand-in (no recall log in this checkout yet)"}`,
  );

  console.log(
    `[A1 LIVE DIAGNOSTIC] rate=${v.rate} sample=${v.sample} ` +
      `denominator=${v.denominator} window_days=${v.window_days} ` +
      `threshold=${v.threshold} minSample=${v.minSample} ` +
      `verdict=${v.verdict} elapsed_ms=${elapsedMs}`,
  );
  console.log(
    "[A1 LIVE DIAGNOSTIC] rate is a FRACTION (coverage-probe.js:130), so " +
      `${v.rate} means ${(v.rate * 100).toFixed(2)}% of recalls carried >=1 entity.`,
  );

  assert.ok(
    ["green", "red", "inconclusive"].includes(v.verdict),
    `verdict must be one of the three declared states, got ${JSON.stringify(v.verdict)}`,
  );
  assert.ok(
    Number.isFinite(v.rate) && v.rate >= 0 && v.rate <= 1,
    `rate must be a finite FRACTION in [0,1], got ${JSON.stringify(v.rate)}`,
  );
  assert.ok(
    Number.isInteger(v.sample) && v.sample >= 0,
    `sample must be a non-negative integer, got ${JSON.stringify(v.sample)}`,
  );
  assert.equal(v.denominator, "recalls_in_window");
  assert.equal(v.rate_basis, "recall_population.non_empty_entities_pct");
  assert.equal(v.window_days, 3650, "the live gate must measure the whole ledger, not a slice");
  assert.equal(v.threshold, 0.5, "the default threshold must not drift");
  assert.equal(v.minSample, 100, "the default minSample must not drift");
  assert.ok(Object.isFrozen(v), "the verdict object must be frozen");
});

// ===========================================================================
// e5 ADDENDUM — computeRecallObservables (lib/recall/recall-observables.js).
//
// WHY THESE ARMS LIVE IN THIS FILE.
//   They exercise a REPORTER over the same substrate this suite's gate reads,
//   and suite parity in this repo is at drift 0 — a new .test.mjs would have
//   to be registered in run-all-tests.mjs to keep it there. Extending the
//   registered suite in place is the cheaper true move.
//
// WHAT IS PINNED AND WHAT IS NOT.
//   Arms (7)-(11) are hermetic: mkdtemp fixtures whose every count was worked
//   out by hand and is asserted EXACTLY, including each histogram bucket and
//   each percentile. Arm (12) reads the LIVE recall.jsonl and asserts only
//   well-formedness while PRINTING the envelope, for exactly the reason the
//   header above gives for arm (6): recall.jsonl is append-only and every
//   number in it moves on the next memory_recall. Arm (13) is the bounded-
//   memory canary and is env-opt-in because it writes a ~400 MB fixture.
//
// The reporter under test issues no judgement, so nothing below asserts a
// colour, a pass, or a failure — only counts, buckets and suppression flags.
// ===========================================================================

const { computeRecallObservables, DEFAULT_MIN_SAMPLE, UNATTRIBUTED } =
  await import("../lib/recall/recall-observables.js");

const E5_NOW = new Date("2026-08-04T12:00:00.000Z");
const E5_SINCE = new Date(E5_NOW.getTime() - 3600_000); // 1h window

/** ts helper: `k` minutes before E5_NOW. */
function e5Ts(minutesAgo) {
  return new Date(E5_NOW.getTime() - minutesAgo * 60_000).toISOString();
}

/**
 * One synthetic recall row. Shape mirrors the recall-event literal in
 * recall.js: `surfaced` / `candidates_pre_truncation` arrays, the
 * `degraded_recall` flag with its optional `degraded_reason`, the separate
 * Layer-3 pair, and the `populator` block whose own `degraded` boolean is the
 * second term of coverage-probe's degrade test.
 */
function e5Row(spec) {
  const row = {
    id: `rec_${spec.ts}`,
    ts: spec.ts,
    kind: "recall",
    query: { surrounding_context_hash: "deadbeef" },
    surfaced: new Array(spec.surfaced).fill(0).map((_, i) => ({ memory_id: `m${i}` })),
    candidates_pre_truncation: new Array(spec.candidates)
      .fill(0)
      .map((_, i) => ({ memory_id: `c${i}` })),
    degraded_recall: spec.degraded === true,
    rerank_attempted: true,
    rerank_failed_reason: spec.rerankReason ?? null,
    layer3_latency_ms: 1,
    degraded_recall_layer3: spec.layer3 === true,
    populator: { entities_count: 0, degraded: spec.populatorDegraded === true },
  };
  if (spec.reason != null) row.degraded_reason = spec.reason;
  return row;
}

function writeLines(dir, name, lines) {
  const abs = join(dir, name);
  writeFileSync(abs, lines.length > 0 ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
  return abs;
}

/**
 * THE FALSIFICATION FIXTURE. Ten in-window recall rows whose every observable
 * is hand-computable, plus three lines that must NOT reach any counter: a
 * recall row 100 days before the window, a non-recall row, and a malformed
 * line.
 *
 *   surfaced   lengths: 0 0 3 3 5 5 12 12 1 0
 *   candidate  lengths: 0 0 10 10 50 50 50 50 1 4
 *   degraded_recall flag on rows 1, 2, 8            -> 3
 *   populator.degraded only on row 7                -> wide = 4, flag = 3
 *   degraded_reason present on rows 2 and 8         -> "(unattributed)" = 1
 *   Layer-3 on rows 3, 4, 8                         -> 3, three distinct reasons
 */
function writeE5FalsificationFixture(dir, { flipRow5SurfacedToZero = false } = {}) {
  const specs = [
    { ts: e5Ts(10), surfaced: 0, candidates: 0, degraded: true },
    { ts: e5Ts(9), surfaced: 0, candidates: 0, degraded: true, reason: "index_generation_refused" },
    { ts: e5Ts(8), surfaced: 3, candidates: 10, layer3: true, rerankReason: "api_key_missing" },
    { ts: e5Ts(7), surfaced: 3, candidates: 10, layer3: true, rerankReason: "network" },
    { ts: e5Ts(6), surfaced: flipRow5SurfacedToZero ? 0 : 5, candidates: 50 },
    { ts: e5Ts(5), surfaced: 5, candidates: 50 },
    { ts: e5Ts(4), surfaced: 12, candidates: 50, populatorDegraded: true },
    {
      ts: e5Ts(3),
      surfaced: 12,
      candidates: 50,
      degraded: true,
      reason: "vector_prefetch_failed",
      layer3: true,
      rerankReason: "internal_error",
    },
    { ts: e5Ts(2), surfaced: 1, candidates: 1 },
    { ts: e5Ts(1), surfaced: 0, candidates: 4 },
  ];
  const lines = specs.map((s) => JSON.stringify(e5Row(s)));
  // Out of window: 100 days before the 1-hour window opens.
  lines.push(
    JSON.stringify(
      e5Row({ ts: new Date(E5_NOW.getTime() - 100 * 86_400_000).toISOString(), surfaced: 99, candidates: 99 }),
    ),
  );
  // Not a recall row at all.
  lines.push(JSON.stringify({ kind: "fact", ts: e5Ts(5), text: "not a recall" }));
  // Malformed — must be skipped by the parser, never counted as a recall.
  lines.push("{not json at all");
  return writeLines(dir, "recall.jsonl", lines);
}

// ---------------------------------------------------------------------------
// (7) FALSIFICATION — every hand-computed count reproduced EXACTLY.
// ---------------------------------------------------------------------------
test("(7) e5 falsification — synthetic log reproduces every count exactly", () => {
  const dir = mkdtempSync(join(TMP_ROOT, "e5-falsify-"));
  const recallLogPath = writeE5FalsificationFixture(dir);

  const env = computeRecallObservables({
    recallLogPath,
    since: E5_SINCE.toISOString(),
    until: E5_NOW.toISOString(),
    minSample: 1,
    now: E5_NOW,
  });

  // Envelope-level contracts.
  assert.equal(env.rate_scale, "fraction", "the scale is stamped once, as a fraction");
  assert.equal(env.min_sample, 1);
  assert.equal(env.recall_log_path, recallLogPath);
  assert.ok(Object.isFrozen(env), "the envelope must be frozen");
  assert.ok(Object.isFrozen(env.segments[0]), "segments must be frozen too");
  assert.equal(env.split_at, null, "no splitAt was supplied");
  assert.equal(env.segments.length, 1);
  assert.equal(env.segments[0].label, "all");

  // Scan bookkeeping: 13 non-empty lines, 12 of them parseable.
  assert.deepEqual(env.scan, {
    total_lines: 13,
    parsed_lines: 12,
    skipped: 0,
    recall_rows_seen: 11,
    in_window_rows: 10,
    out_of_window_rows: 1,
    non_recall_rows: 1,
  });

  const seg = env.segments[0];
  assert.equal(seg.n, 10);

  // surfaced: sorted 0 0 0 1 3 3 5 5 12 12
  assert.deepEqual(seg.surfaced, {
    count: 10,
    min: 0,
    max: 12,
    mean: 4.1,
    p50: 3,
    p90: 12,
    modes: [
      { value: 0, count: 3 },
      { value: 3, count: 2 },
      { value: 5, count: 2 },
      { value: 12, count: 2 },
      { value: 1, count: 1 },
    ],
    values: null,
    suppressed: null,
  });

  // candidates: sorted 0 0 1 4 10 10 50 50 50 50
  assert.deepEqual(seg.candidates_pre_truncation, {
    count: 10,
    min: 0,
    max: 50,
    mean: 22.5,
    p50: 10,
    p90: 50,
    modes: [
      { value: 50, count: 4 },
      { value: 0, count: 2 },
      { value: 10, count: 2 },
      { value: 1, count: 1 },
      { value: 4, count: 1 },
    ],
    values: null,
    suppressed: null,
  });

  assert.equal(seg.rows_without_surfaced_array, 0);
  assert.equal(seg.rows_without_candidates_array, 0);

  // The three emptiness counts are independent, and their coincidence is its
  // own number: row 10 has an empty surfaced list with 4 real candidates.
  assert.equal(seg.empty_surfaced_count, 3);
  assert.equal(seg.empty_candidate_count, 2);
  assert.equal(seg.empty_surfaced_and_candidate_count, 2);
  assert.deepEqual(seg.empty_surfaced_rate, { count: 3, pct: 0.3, suppressed: null });
  assert.deepEqual(seg.empty_candidate_rate, { count: 2, pct: 0.2, suppressed: null });

  // Axis (a) vs the dashboard's wider test: row 7 carries populator.degraded
  // only, so the two numbers MUST differ by exactly one and must be published
  // under distinct keys.
  assert.equal(seg.degraded_recall_flag_count, 3);
  assert.equal(seg.degraded_wide_count, 4);
  assert.deepEqual(seg.degraded_recall_flag_rate, { count: 3, pct: 0.3, suppressed: null });
  assert.deepEqual(seg.degraded_wide_rate, { count: 4, pct: 0.4, suppressed: null });

  // Axis (b): open histogram over observed values, with the explicit bucket
  // for a flagged row that names no cause.
  assert.deepEqual(seg.degrade_cause_histogram, {
    [UNATTRIBUTED]: 1,
    index_generation_refused: 1,
    vector_prefetch_failed: 1,
  });

  // Axis (c): Layer 3, never folded into (a).
  assert.equal(seg.degraded_recall_layer3_count, 3);
  assert.deepEqual(seg.layer3_reason_histogram, {
    api_key_missing: 1,
    network: 1,
    internal_error: 1,
  });
  assert.equal(seg.rerank_reason_without_layer3_count, 0);

  // `totals` covers the same window and must agree with the single segment.
  assert.equal(env.totals.n, 10);
  assert.equal(env.totals.degraded_recall_flag_count, seg.degraded_recall_flag_count);
  assert.equal(env.totals.degraded_wide_count, seg.degraded_wide_count);

  // MUTATION SENSITIVITY — flip ONE fixture value and exactly the
  // corresponding assertions move. Row 5's surfaced length 5 -> 0 adds one
  // empty-surfaced row and drags the median down; its candidate list is
  // untouched, so the coincidence count does NOT move.
  const flippedDir = mkdtempSync(join(TMP_ROOT, "e5-flip-"));
  const flipped = computeRecallObservables({
    recallLogPath: writeE5FalsificationFixture(flippedDir, { flipRow5SurfacedToZero: true }),
    since: E5_SINCE.toISOString(),
    until: E5_NOW.toISOString(),
    minSample: 1,
    now: E5_NOW,
  });
  const fseg = flipped.segments[0];
  assert.equal(fseg.empty_surfaced_count, 4, "the flip must move this count by exactly one");
  assert.equal(fseg.surfaced.p50, 1, "and must move the median off 3");
  assert.equal(fseg.empty_candidate_count, 2, "the candidate side must NOT move");
  assert.equal(
    fseg.empty_surfaced_and_candidate_count,
    2,
    "the coincidence count must NOT move — row 5 still had 50 candidates",
  );
  assert.equal(fseg.degraded_recall_flag_count, 3, "the degrade axes must NOT move");
});

// ---------------------------------------------------------------------------
// (8) SPLIT BOUNDARY — half-open, and a row exactly ON the boundary is `after`.
// ---------------------------------------------------------------------------
test("(8) e5 splitAt is half-open — a row exactly on the boundary lands in at_or_after", () => {
  const dir = mkdtempSync(join(TMP_ROOT, "e5-split-"));
  const boundary = new Date(E5_NOW.getTime() - 5 * 60_000);
  const boundaryIso = boundary.toISOString();

  const recallLogPath = writeLines(dir, "recall.jsonl", [
    JSON.stringify(e5Row({ ts: new Date(boundary.getTime() - 1).toISOString(), surfaced: 1, candidates: 1 })),
    JSON.stringify(e5Row({ ts: boundaryIso, surfaced: 2, candidates: 2 })),
    JSON.stringify(e5Row({ ts: new Date(boundary.getTime() + 1).toISOString(), surfaced: 3, candidates: 3 })),
  ]);

  const env = computeRecallObservables({
    recallLogPath,
    since: E5_SINCE.toISOString(),
    until: E5_NOW.toISOString(),
    splitAt: boundaryIso,
    minSample: 1,
    now: E5_NOW,
  });

  assert.equal(env.split_at, boundaryIso, "the boundary is stamped VERBATIM, never a constant");
  assert.equal(env.segments.length, 2);
  const [before, after] = env.segments;
  assert.equal(before.label, "before");
  assert.equal(after.label, "at_or_after");
  assert.equal(before.interval, "[since, split_at)");
  assert.equal(after.interval, "[split_at, until]");

  assert.equal(before.n, 1, "only the row strictly before the boundary");
  assert.equal(after.n, 2, "the boundary row itself plus the one after it");
  assert.equal(before.surfaced.max, 1, "the before segment holds the surfaced=1 row");
  assert.equal(after.surfaced.min, 2, "the boundary row (surfaced=2) is on the after side");

  // No double-count and no loss.
  assert.equal(before.n + after.n, env.scan.in_window_rows);
  assert.equal(env.totals.n, env.scan.in_window_rows);
});

// ---------------------------------------------------------------------------
// (9) SMALL-n HONESTY — n=1 renders as raw counts, never as a percentage.
// ---------------------------------------------------------------------------
test("(9) e5 small-n — a 1-row segment emits pct:null with an explicit suppression reason", () => {
  const dir = mkdtempSync(join(TMP_ROOT, "e5-smalln-"));
  const recallLogPath = writeLines(dir, "recall.jsonl", [
    JSON.stringify(e5Row({ ts: e5Ts(1), surfaced: 4, candidates: 33, degraded: true, layer3: true, rerankReason: "network" })),
  ]);

  const env = computeRecallObservables({
    recallLogPath,
    since: E5_SINCE.toISOString(),
    until: E5_NOW.toISOString(),
    now: E5_NOW,
  });

  assert.equal(env.min_sample, DEFAULT_MIN_SAMPLE, "the default floor is 30");
  const seg = env.segments[0];
  assert.equal(seg.n, 1);

  for (const key of [
    "empty_surfaced_rate",
    "empty_candidate_rate",
    "empty_surfaced_and_candidate_rate",
    "degraded_recall_flag_rate",
    "degraded_wide_rate",
    "degraded_recall_layer3_rate",
  ]) {
    assert.equal(seg[key].pct, null, `${key}.pct must be null at n=1`);
    assert.equal(seg[key].suppressed, "n<min_sample", `${key} must say WHY it is null`);
    assert.ok(Number.isInteger(seg[key].count), `${key}.count must still be a raw integer`);
  }

  // The raw counts survive suppression — the operator still learns everything
  // that was actually observed.
  assert.equal(seg.degraded_recall_flag_count, 1);
  assert.equal(seg.degraded_recall_layer3_count, 1);

  // Percentiles below the floor become the raw sorted sample, not a quantile.
  assert.equal(seg.surfaced.p50, null);
  assert.equal(seg.surfaced.p90, null);
  assert.deepEqual(seg.surfaced.values, [4]);
  assert.equal(seg.surfaced.suppressed, "n<min_sample");
  assert.deepEqual(seg.candidates_pre_truncation.values, [33]);
  assert.equal(seg.candidates_pre_truncation.mean, 33, "min/max/mean are still honest at n=1");
});

// ---------------------------------------------------------------------------
// (10) LAYER-3 NON-CONFLATION — a log of pure rerank degrades reports ZERO
// retrieval degrades. recall.js's `degraded_recall` is an OR over
// `degradedRecall`, `indexGenerationRefused`, `vectorPrefetchDegraded`,
// `denseSearchDegraded` and `indexUnservable`; `degradedRecallLayer3` is not
// a term in it, and this reporter must never add it.
// ---------------------------------------------------------------------------
test("(10) e5 Layer-3 is never folded into the retrieval-degrade number", () => {
  const dir = mkdtempSync(join(TMP_ROOT, "e5-l3-"));
  const lines = [];
  for (let i = 1; i <= 5; i += 1) {
    lines.push(
      JSON.stringify(
        e5Row({
          ts: e5Ts(i),
          surfaced: 6,
          candidates: 20,
          degraded: false,
          layer3: true,
          rerankReason: "api_key_missing",
        }),
      ),
    );
  }
  const recallLogPath = writeLines(dir, "recall.jsonl", lines);

  const env = computeRecallObservables({
    recallLogPath,
    since: E5_SINCE.toISOString(),
    until: E5_NOW.toISOString(),
    minSample: 1,
    now: E5_NOW,
  });
  const seg = env.segments[0];

  assert.equal(seg.n, 5);
  assert.equal(seg.degraded_recall_flag_count, 0, "no retrieval degrade may be manufactured");
  assert.equal(seg.degraded_wide_count, 0, "nor may the dashboard's wider test pick it up");
  assert.deepEqual(seg.degraded_recall_flag_rate, { count: 0, pct: 0, suppressed: null });
  assert.deepEqual(seg.degrade_cause_histogram, {}, "no cause bucket exists without a flag");

  assert.equal(seg.degraded_recall_layer3_count, 5);
  assert.deepEqual(seg.layer3_reason_histogram, { api_key_missing: 5 });
  assert.deepEqual(seg.degraded_recall_layer3_rate, { count: 5, pct: 1, suppressed: null });
  assert.equal(seg.rerank_reason_without_layer3_count, 0);
});

// ---------------------------------------------------------------------------
// (11) LOUD ABSENCE — a mis-pathed log THROWS; an unreadable one THROWS.
// Neither may come back as a zero-filled envelope, which is exactly what
// _ledger-stream's benign-ENOENT contract would produce on its own.
// ---------------------------------------------------------------------------
test("(11) e5 loud absence — missing and unreadable logs both THROW", () => {
  const dir = mkdtempSync(join(TMP_ROOT, "e5-absent-"));
  const missingPath = join(dir, "no-such-recall.jsonl");

  assert.throws(
    () => computeRecallObservables({ recallLogPath: missingPath, now: E5_NOW }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /unreadable or absent/);
      assert.ok(err.message.includes(missingPath), "the message must NAME the path");
      return true;
    },
  );

  assert.throws(
    () => computeRecallObservables({ recallLogPath: "", now: E5_NOW }),
    /unreadable or absent/,
  );

  // Exists, stats fine, cannot be OPENED: streamLedgerLines reports it on
  // counts.readError and the reporter refuses to publish a head-biased scan.
  const unreadable = writeLines(dir, "unreadable.jsonl", [
    JSON.stringify(e5Row({ ts: e5Ts(1), surfaced: 1, candidates: 1 })),
  ]);
  chmodSync(unreadable, 0o000);
  process.on("exit", () => {
    try {
      chmodSync(unreadable, 0o600);
    } catch {
      // best-effort so TMP_ROOT cleanup can unlink it
    }
  });
  assert.throws(
    () => computeRecallObservables({ recallLogPath: unreadable, now: E5_NOW }),
    (err) => {
      assert.match(err.message, /scan failed/);
      assert.match(err.message, /an unreadable log is NOT an empty log/);
      return true;
    },
  );

  // An unparseable boundary is also loud — silently dropping it would fold
  // two segments into one and change every number without saying so.
  const good = writeLines(dir, "good.jsonl", [
    JSON.stringify(e5Row({ ts: e5Ts(1), surfaced: 1, candidates: 1 })),
  ]);
  assert.throws(
    () => computeRecallObservables({ recallLogPath: good, splitAt: "not-a-date", now: E5_NOW }),
    /splitAt is not a parseable instant/,
  );
});

// ---------------------------------------------------------------------------
// (12) LIVE — read-only pass over the production recall.jsonl. PRINTS the
// envelope; asserts WELL-FORMEDNESS ONLY, never a value, for the reason arm
// (6) gives: this log is append-only and every number in it drifts.
// ---------------------------------------------------------------------------
test("(12) e5 LIVE recall.jsonl — reporter runs read-only and returns a well-formed envelope", () => {
  const startedMs = Date.now();
  const env = computeRecallObservables({ recallLogPath: LIVE_RECALL_LOG });
  const elapsedMs = Date.now() - startedMs;

  console.log(`[E5 LIVE DIAGNOSTIC] elapsed_ms=${elapsedMs} envelope=${JSON.stringify(env)}`);

  assert.equal(env.rate_scale, "fraction");
  assert.equal(env.recall_log_path, LIVE_RECALL_LOG);
  assert.ok(Object.isFrozen(env), "the envelope must be frozen");
  assert.equal(env.segments.length, 1, "no splitAt supplied -> exactly one segment");
  assert.equal(env.segments[0].label, "all");
  assert.ok(Number.isInteger(env.scan.in_window_rows) && env.scan.in_window_rows >= 0);
  assert.equal(env.segments[0].n, env.scan.in_window_rows);
  assert.equal(env.totals.n, env.scan.in_window_rows);

  for (const seg of [env.totals, ...env.segments]) {
    for (const [key, val] of Object.entries(seg)) {
      if (val != null && typeof val === "object" && "pct" in val) {
        assert.ok(
          val.pct === null || (Number.isFinite(val.pct) && val.pct >= 0 && val.pct <= 1),
          `${key}.pct must be null or a FRACTION in [0,1], got ${JSON.stringify(val.pct)}`,
        );
        assert.ok(Number.isInteger(val.count), `${key}.count must be an integer`);
      }
    }
    assert.ok(Number.isInteger(seg.degraded_recall_flag_count));
    assert.ok(Number.isInteger(seg.degraded_wide_count));
    assert.ok(Number.isInteger(seg.degraded_recall_layer3_count));
  }
});

// ---------------------------------------------------------------------------
// (13) BOUNDED MEMORY — env-opt-in (MEMSYS_PROBE_E5_MEMORY=1) because the
// fixture is ~400 MB. Row RETENTION of a 20x-live log would cost >130 MB of
// Float64 payload alone, so the cap below is falsifiable by exactly the
// defect it guards: any per-row retention blows it.
// ---------------------------------------------------------------------------
test("(13) e5 bounded memory over a 20x synthetic log", { skip: process.env.MEMSYS_PROBE_E5_MEMORY !== "1" }, () => {
  const dir = mkdtempSync(join(TMP_ROOT, "e5-mem-"));
  const abs = join(dir, "recall.jsonl");
  const rows = 5660; // 20x the live row count at the time this arm was added
  const chunks = [];
  for (let i = 0; i < rows; i += 1) {
    const row = e5Row({ ts: e5Ts((i % 50) + 1), surfaced: i % 13, candidates: i % 51 });
    row.query.context_embedding = new Array(3072).fill(0.0123456789);
    chunks.push(`${JSON.stringify(row)}\n`);
    if (chunks.length >= 100) {
      writeFileSync(abs, chunks.join(""), { flag: i < 100 ? "w" : "a", mode: 0o600 });
      chunks.length = 0;
    }
  }
  if (chunks.length > 0) writeFileSync(abs, chunks.join(""), { flag: "a", mode: 0o600 });

  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const env = computeRecallObservables({
    recallLogPath: abs,
    since: E5_SINCE.toISOString(),
    until: E5_NOW.toISOString(),
    minSample: 1,
    now: E5_NOW,
  });
  const delta = process.memoryUsage().heapUsed - before;
  console.log(`[E5 MEMORY DIAGNOSTIC] rows=${env.scan.in_window_rows} heap_delta_bytes=${delta}`);

  assert.equal(env.scan.in_window_rows, rows, "every row must have been counted");
  assert.ok(
    delta < 64 * 1024 * 1024,
    `heap delta must stay bounded; retention of ${rows} embedding rows cannot fit under 64 MB, got ${delta}`,
  );
});
