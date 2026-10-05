// calibration-live-weights.test.mjs — N1-calibration WORKUNIT coverage.
//
// Verifies the four deliverables wired by this WORKUNIT:
//   (1) the calibration sweep is EXTENDED to the LIVE weights
//       SCORE_WEIGHT_{ENGAGEMENT,DAMPING,CORROBORATION}_PRIOR with the correct
//       units (rescoreSurfacedWithLiveWeights reads candidate.priors, NOT the
//       surfaced[] re-rank counts);
//   (2) the minimal engagement prior makes engagementPrior() non-inert when a
//       map is supplied AND byte-identical (return 0) when it is not;
//   (3) the append-only policy projection (policy.recall.score_weights) is
//       emitted with metrics and is the SOLE write (no fact-row mutation);
//   (4) the gated overlay flips a weight off 0.0 ONLY when the env gate is ON
//       AND a reviewed/harm-safe/NDCG-positive projection exists; gate OFF is
//       byte-identical; the anti-circularity guard fails a headroom-free goldset;
//       the frozen CAPS object is NEVER mutated.
//
// Run: node --test test/synthesis/calibration-live-weights.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic env BEFORE any dynamic import (standing C-NEW-2 pattern).
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-calib-live-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
mkdirSync(join(MEMORY_ROOT, "ledgers"), { recursive: true, mode: 0o700 });
mkdirSync(join(MEMORY_ROOT, "policy"), { recursive: true, mode: 0o700 });
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
// Gate default OFF — individual tests toggle it explicitly.
delete process.env.MEMORY_SCORE_WEIGHTS_ENABLED;

const calib = await import("../../lib/synthesis/calibration-loop.js");
const {
  LIVE_WEIGHT_GRID_SPEC,
  LIVE_WEIGHT_KEYS,
  rescoreSurfacedWithLiveWeights,
  rescoreSurfacedWithCaps,
  expandGrid,
  DEFAULT_GRID_SPEC,
} = calib;

const mfs = await import("../../lib/recall/multi-feature-score.js");
const { computeScore, engagementPrior } = mfs;
const { CAPS } = await import("../../lib/validation.js");

const emitter = await import("../../lib/synthesis/score-weights-emitter.js");
const {
  emitScoreWeights,
  markScoreWeightsReviewed,
  SCORE_WEIGHTS_KIND,
  SCORE_WEIGHT_PROJECTION_KEYS,
} = emitter;

const overlayMod = await import("../../lib/recall/score-weight-overlay.js");
const {
  resolveScoreWeightOverlay,
  isProjectionApplicable,
  SCORE_WEIGHTS_ENV,
} = overlayMod;

const engPriorMod = await import("../../lib/synthesis/engagement-prior-reader.js");
const {
  buildEngagementPriorMap,
  engagementPriorFromMap,
  __resetEngagementPriorCacheForTests,
} = engPriorMod;

const cycleMod = await import("../../scripts/run-calibration-cycle.mjs");
const { assertGoldsetHeadroom, ndcgCiLowerDelta, LIVE_WEIGHT_BASELINE } = cycleMod;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function freshLedger(name) {
  const p = join(MEMORY_ROOT, "ledgers", `${name}-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(p, "", { mode: 0o600 });
  return p;
}

function writeRows(path, rows) {
  writeFileSync(
    path,
    rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : ""),
    { mode: 0o600 },
  );
}

const NEUTRAL_GATES = { predicate_mask: 1, consent_dampener: 1.0, derivation_status: 1.0 };
const BASE_CANDIDATE = {
  memory_id: "mem_x",
  kind: "fact",
  ts: "2026-06-01T00:00:00Z",
  entities: [],
  valence: null,
};
const BASE_CONTEXT = { entities: [], time_anchor: null, valence: null };
const FIXED_NOW = "2026-06-10T00:00:00Z";

// ---------------------------------------------------------------------------
// (1) Sweep EXTENDED to the live weights with correct units.
// ---------------------------------------------------------------------------

test("LIVE_WEIGHT_GRID_SPEC contains exactly the three live weight keys, narrow ranges, baseline 0.0", () => {
  assert.ok(Object.isFrozen(LIVE_WEIGHT_GRID_SPEC), "grid frozen");
  const keys = Object.keys(LIVE_WEIGHT_GRID_SPEC).sort();
  assert.deepEqual(
    keys,
    ["SCORE_WEIGHT_CORROBORATION_PRIOR", "SCORE_WEIGHT_DAMPING_PRIOR", "SCORE_WEIGHT_ENGAGEMENT_PRIOR"],
    "exactly the three SCORE_WEIGHT_*_PRIOR keys (namespace gap closed)",
  );
  // Every grid includes 0.0 as the first value (the frozen-CAPS baseline) and
  // stays narrow so priors cannot over-dominate bounded additive features.
  for (const k of keys) {
    const vals = LIVE_WEIGHT_GRID_SPEC[k];
    assert.equal(vals[0], 0.0, `${k} grid starts at the 0.0 baseline`);
    assert.ok(Math.max(...vals) <= 0.04, `${k} grid stays narrow (<=0.04)`);
  }
  // The live grid does NOT reuse the Layer-1 re-rank cap names.
  assert.ok(!keys.includes("DAMPING_ENGAGEMENT_BOOST"), "no Layer-1 cap leaks into the live grid");
});

test("expandGrid sweeps the live-weight grid (4*4*4=64 cells) and the Layer-1 grid is unchanged", () => {
  const liveCells = expandGrid(LIVE_WEIGHT_GRID_SPEC);
  assert.equal(liveCells.length, 64, "4x4x4 exhaustive live-weight sweep");
  for (const cell of liveCells) {
    for (const k of SCORE_WEIGHT_PROJECTION_KEYS) {
      assert.equal(typeof cell[k], "number", `${k} populated on every live cell`);
    }
  }
  // Layer-1 grid still expands to its original 27 — extension did not break it.
  assert.equal(expandGrid(DEFAULT_GRID_SPEC).length, 27, "Layer-1 sweep still 27 cells");
});

test("rescoreSurfacedWithLiveWeights reads surfaced[].priors and re-ranks by the live-weight formula", () => {
  // "loser" has the higher BASE score but a low damping prior; "winner" has a
  // lower base but a high damping_coefficient. A non-zero damping weight must
  // flip the order — proving the loop moves the LIVE weights via NORMALIZED
  // priors (NOT the raw surfaced[] counts the Layer-1 rescorer uses).
  const input = [
    { memory_id: "loser", score: 0.50, position: 0, priors: { damping_coefficient: 0.5 } },
    { memory_id: "winner", score: 0.49, position: 1, priors: { damping_coefficient: 1.5 } },
  ];
  const clone = JSON.parse(JSON.stringify(input));
  const out = rescoreSurfacedWithLiveWeights(input, {
    SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.0,
    SCORE_WEIGHT_DAMPING_PRIOR: 0.5, // exaggerated for the test
    SCORE_WEIGHT_CORROBORATION_PRIOR: 0.0,
  });
  assert.deepEqual(input, clone, "rescoreSurfacedWithLiveWeights does not mutate input");
  assert.equal(out[0].memory_id, "winner", "high damping prior + non-zero weight wins");
  assert.equal(out[0].position, 0, "positions re-stamped 0..N-1");
  // With ALL weights 0.0 (the baseline) the rescore is a no-op (order unchanged).
  const noop = rescoreSurfacedWithLiveWeights(input, {
    SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.0,
    SCORE_WEIGHT_DAMPING_PRIOR: 0.0,
    SCORE_WEIGHT_CORROBORATION_PRIOR: 0.0,
  });
  assert.equal(noop[0].memory_id, "loser", "zero weights → baseline order preserved");
});

test("rescoreSurfacedWithLiveWeights clamps priors to the scorer's bounds (no over-fit beyond reachable range)", () => {
  // corroboration_boost is bounded [1.0, 1.3]; a fixture trying 5.0 must be
  // clamped to 1.3 so calibration cannot reward a value the scorer can't reach.
  const out = rescoreSurfacedWithLiveWeights(
    [{ memory_id: "m", score: 0.0, position: 0, priors: { corroboration_boost: 5.0 } }],
    { SCORE_WEIGHT_CORROBORATION_PRIOR: 1.0, SCORE_WEIGHT_DAMPING_PRIOR: 0, SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0 },
  );
  assert.equal(out[0].score, 1.3, "corroboration_boost clamped to max 1.3 before weighting");
});

// ---------------------------------------------------------------------------
// (2) Minimal engagement prior: non-inert with a map, byte-identical without.
// ---------------------------------------------------------------------------

test("engagementPrior is byte-identical (return 0) when no map is supplied", () => {
  assert.equal(engagementPrior("mem_anything", undefined), 0, "no opts → 0 (stub-identical)");
  assert.equal(engagementPrior("mem_anything", {}), 0, "no map in opts → 0");
  assert.equal(engagementPrior("mem_anything", { engagementPriorById: null }), 0, "null map → 0");
});

test("engagementPrior reads a supplied map (non-inert) and ignores unknown ids", () => {
  const map = new Map([["mem_hot", 1.5]]);
  assert.equal(engagementPrior("mem_hot", { engagementPriorById: map }), 1.5, "known id → mapped prior");
  assert.equal(engagementPrior("mem_cold", { engagementPriorById: map }), 0, "unknown id → 0 neutral");
});

test("buildEngagementPriorMap projects recall-feedback rows into a use_count prior (no fact-row mutation)", () => {
  __resetEngagementPriorCacheForTests();
  const ledger = freshLedger("memory");
  writeRows(ledger, [
    { id: "f1", kind: "fact", content: "a real fact row that must NOT be touched" },
    {
      id: "p1", kind: "policy", policy_kind: "salience.recall_feedback",
      surfaced_memory_ids: ["mem_hot", "mem_warm"], ts: FIXED_NOW,
    },
    {
      id: "p2", kind: "policy", policy_kind: "salience.recall_feedback",
      surfaced_memory_ids: ["mem_hot"], ts: FIXED_NOW,
    },
  ]);
  const before = readFileSync(ledger, "utf8");
  const nowMs = Date.parse(FIXED_NOW);
  const map = buildEngagementPriorMap(ledger, nowMs);
  // mem_hot surfaced twice → higher prior than mem_warm (once); both > 0.
  const hot = engagementPriorFromMap(map, "mem_hot");
  const warm = engagementPriorFromMap(map, "mem_warm");
  assert.ok(hot > warm, "more surfacings → larger engagement prior");
  assert.ok(warm > 0, "a single surfacing yields a positive prior");
  assert.equal(engagementPriorFromMap(map, "mem_never"), 0, "never-surfaced → 0 neutral");
  // Thesis #1: the reader NEVER mutates the ledger.
  assert.equal(readFileSync(ledger, "utf8"), before, "reader did not mutate the ledger");
});

// ---------------------------------------------------------------------------
// (3) Append-only projection emitter — single write, no CAPS / fact mutation.
// ---------------------------------------------------------------------------

test("emitScoreWeights writes exactly one kind:policy recall.score_weights row; zero fact rows", async () => {
  const ledger = freshLedger("memory");
  const res = await emitScoreWeights({
    weights: {
      SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.02,
      SCORE_WEIGHT_DAMPING_PRIOR: 0.01,
      SCORE_WEIGHT_CORROBORATION_PRIOR: 0.03,
    },
    baseline_metrics: { ndcg_at_12: 0.40, harm_rate: 0.10 },
    best_metrics: { ndcg_at_12: 0.48, harm_rate: 0.08 },
    cold_start: false,
    goldset_headroom_ok: true,
    ndcg_ci_lower_delta: 0.02,
    ledgerPath: ledger,
  });
  assert.equal(res.ok, true, "emit ok");
  assert.equal(res.written_count, 1, "exactly one row written");
  const lines = readFileSync(ledger, "utf8").split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1, "ledger has exactly one row");
  const row = JSON.parse(lines[0]);
  assert.equal(row.kind, "policy", "row is kind:policy (never fact)");
  assert.equal(row.policy_kind, SCORE_WEIGHTS_KIND, "policy_kind = recall.score_weights");
  assert.equal(row.reviewed, false, "fresh projection is reviewed:false (operator chokepoint)");
  // Computed deltas surface for the overlay's safety predicate.
  assert.ok(Math.abs(row.ndcg_delta - 0.08) < 1e-9, "ndcg_delta = best - baseline");
  assert.ok(Math.abs(row.harm_delta - -0.02) < 1e-9, "harm_delta = best - baseline (negative = safer)");
  // Projected keys are EXACTLY the three live weights (no re-rank cap leak).
  assert.deepEqual(Object.keys(row.weights).sort(), [...SCORE_WEIGHT_PROJECTION_KEYS].sort(),
    "projected keys are exactly the three live weights");
});

test("emitScoreWeights rejects a weights object carrying a Layer-1 re-rank cap (namespace-gap trap)", async () => {
  const ledger = freshLedger("memory");
  const res = await emitScoreWeights({
    weights: { DAMPING_ENGAGEMENT_BOOST: 0.05 }, // wrong namespace
    baseline_metrics: { ndcg_at_12: 0.4, harm_rate: 0.1 },
    best_metrics: { ndcg_at_12: 0.4, harm_rate: 0.1 },
    ledgerPath: ledger,
  });
  assert.equal(res.ok, false, "non-live-weight keys rejected");
  assert.equal(readFileSync(ledger, "utf8"), "", "nothing written on bad input");
});

// ---------------------------------------------------------------------------
// (4) Gated overlay: gate-OFF byte-identical; gate-ON flips only a safe,
//     reviewed projection; CAPS never mutated; anti-circularity guard.
// ---------------------------------------------------------------------------

function reviewedSafeRow() {
  return {
    id: "row_ok", kind: "policy", policy_kind: SCORE_WEIGHTS_KIND, reviewed: true,
    weights: {
      SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.02,
      SCORE_WEIGHT_DAMPING_PRIOR: 0.03,
      SCORE_WEIGHT_CORROBORATION_PRIOR: 0.01,
    },
    ndcg_delta: 0.05, harm_delta: -0.01, cold_start: false, goldset_headroom_ok: true,
    ts: "2026-06-10T00:00:00.000Z",
  };
}

test("overlay GATE OFF returns the frozen 0.0 CAPS triple (default no-op) even when a projection exists", async () => {
  const ledger = freshLedger("memory");
  writeRows(ledger, [reviewedSafeRow()]);
  delete process.env.MEMORY_SCORE_WEIGHTS_ENABLED;
  const ov = resolveScoreWeightOverlay({ ledgerPath: ledger });
  assert.equal(ov.source, "frozen_caps", "gate OFF → frozen CAPS");
  assert.equal(ov.SCORE_WEIGHT_DAMPING_PRIOR, CAPS.SCORE_WEIGHT_DAMPING_PRIOR, "= frozen CAPS value");
  assert.equal(ov.SCORE_WEIGHT_DAMPING_PRIOR, 0.0, "frozen CAPS default is 0.0");
  assert.equal(ov.applied_row_id, null, "no projection applied with gate off");
});

test("overlay GATE ON flips a weight off 0.0 for a reviewed/harm-safe/NDCG-positive projection", async () => {
  const ledger = freshLedger("memory");
  writeRows(ledger, [reviewedSafeRow()]);
  const ov = resolveScoreWeightOverlay({
    ledgerPath: ledger,
    env: { [SCORE_WEIGHTS_ENV.ENABLED]: "1" },
  });
  assert.equal(ov.source, "projection", "gate ON + safe projection → projection applied");
  assert.equal(ov.SCORE_WEIGHT_DAMPING_PRIOR, 0.03, "damping weight flipped off 0.0");
  assert.equal(ov.applied_row_id, "row_ok", "applied row id surfaced for audit");
});

test("overlay refuses reviewed:false, cold_start, harm-positive, ndcg-flat, and no-headroom projections (gate ON)", async () => {
  const envOn = { [SCORE_WEIGHTS_ENV.ENABLED]: "1" };
  const base = reviewedSafeRow();
  const cases = [
    { ...base, reviewed: false },
    { ...base, cold_start: true },
    { ...base, harm_delta: 0.01 },     // harm increased
    { ...base, ndcg_delta: 0.0 },      // no lift
    { ...base, goldset_headroom_ok: false }, // circular goldset
  ];
  for (const row of cases) {
    assert.equal(isProjectionApplicable(row), false, `predicate rejects: ${JSON.stringify({ r: row.reviewed, c: row.cold_start, h: row.harm_delta, n: row.ndcg_delta, g: row.goldset_headroom_ok })}`);
    const ledger = freshLedger("memory");
    writeRows(ledger, [row]);
    const ov = resolveScoreWeightOverlay({ ledgerPath: ledger, env: envOn });
    assert.equal(ov.source, "frozen_caps", "unsafe projection → fall back to frozen CAPS");
  }
  // The safe row IS applicable (positive control).
  assert.equal(isProjectionApplicable(base), true, "the safe reviewed row is applicable");
});

test("CAPS stays Object.frozen and unmutated across overlay resolve + computeScore", async () => {
  assert.ok(Object.isFrozen(CAPS), "CAPS frozen before");
  const ledger = freshLedger("memory");
  writeRows(ledger, [reviewedSafeRow()]);
  const ov = resolveScoreWeightOverlay({ ledgerPath: ledger, env: { [SCORE_WEIGHTS_ENV.ENABLED]: "1" } });
  // Use the overlay in a real score and confirm CAPS is untouched.
  computeScore({
    s_emb_full3072: 0.5, gates: NEUTRAL_GATES,
    candidate: { ...BASE_CANDIDATE, priors: { damping_coefficient: 1.5 } },
    surrounding_context: BASE_CONTEXT,
    opts: { now: FIXED_NOW, scoreWeightOverlay: ov },
  });
  assert.ok(Object.isFrozen(CAPS), "CAPS still frozen after");
  assert.equal(CAPS.SCORE_WEIGHT_DAMPING_PRIOR, 0.0, "CAPS.SCORE_WEIGHT_DAMPING_PRIOR unchanged (0.0)");
});

test("computeScore is byte-identical with no overlay vs a frozen-caps overlay (gate-OFF determinism)", () => {
  const cand = { ...BASE_CANDIDATE, priors: { damping_coefficient: 1.5, corroboration_boost: 1.3 } };
  const args = (opts) => ({
    s_emb_full3072: 0.42, gates: NEUTRAL_GATES, candidate: cand,
    surrounding_context: BASE_CONTEXT, opts: { now: FIXED_NOW, ...opts },
  });
  const noOverlay = computeScore(args({}));
  const frozenOverlay = computeScore(args({
    scoreWeightOverlay: {
      SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.0,
      SCORE_WEIGHT_DAMPING_PRIOR: 0.0,
      SCORE_WEIGHT_CORROBORATION_PRIOR: 0.0,
      source: "frozen_caps",
    },
  }));
  assert.equal(noOverlay.final_score, frozenOverlay.final_score, "no-overlay == frozen-caps overlay (byte-identical)");
  // And a non-zero overlay actually MOVES the score (proves the wire is live).
  const liveOverlay = computeScore(args({
    scoreWeightOverlay: {
      SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.0,
      SCORE_WEIGHT_DAMPING_PRIOR: 0.1,
      SCORE_WEIGHT_CORROBORATION_PRIOR: 0.0,
      source: "projection",
    },
  }));
  assert.ok(liveOverlay.final_score > noOverlay.final_score, "non-zero damping weight raises the score for a high-damping candidate");
});

test("markScoreWeightsReviewed appends a superseding reviewed:true row that the overlay then applies", async () => {
  const ledger = freshLedger("memory");
  const emit = await emitScoreWeights({
    weights: {
      SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.0,
      SCORE_WEIGHT_DAMPING_PRIOR: 0.02,
      SCORE_WEIGHT_CORROBORATION_PRIOR: 0.0,
    },
    baseline_metrics: { ndcg_at_12: 0.40, harm_rate: 0.10 },
    best_metrics: { ndcg_at_12: 0.46, harm_rate: 0.10 },
    cold_start: false, goldset_headroom_ok: true, ledgerPath: ledger,
  });
  // Before review: gate ON but reviewed:false → frozen CAPS.
  const before = resolveScoreWeightOverlay({ ledgerPath: ledger, env: { [SCORE_WEIGHTS_ENV.ENABLED]: "1" } });
  assert.equal(before.source, "frozen_caps", "reviewed:false → not applied even with gate on");
  // Operator signs off.
  const rev = await markScoreWeightsReviewed(emit.row, { ledgerPath: ledger });
  assert.equal(rev.ok, true, "reviewed row appended");
  const after = resolveScoreWeightOverlay({ ledgerPath: ledger, env: { [SCORE_WEIGHTS_ENV.ENABLED]: "1" } });
  assert.equal(after.source, "projection", "after sign-off the projection applies");
  assert.equal(after.SCORE_WEIGHT_DAMPING_PRIOR, 0.02, "the calibrated damping weight is now live");
});

// ---------------------------------------------------------------------------
// Anti-circularity guard + CI helper (the harness's instrument checks).
// ---------------------------------------------------------------------------

test("assertGoldsetHeadroom passes a goldset with real baseline-miss headroom and FAILS a headroom-free one", () => {
  const good = join(MEMORY_ROOT, "ledgers", "goldset-good.jsonl");
  writeRows(good, [{ kind: "contextual_eval_goldset_meta", headroom: { baseline_miss_fraction_all: 0.91 } }]);
  const okv = assertGoldsetHeadroom(good);
  assert.equal(okv.ok, true, "0.91 headroom passes");
  assert.equal(okv.fraction, 0.91, "fraction surfaced");

  const bad = join(MEMORY_ROOT, "ledgers", "goldset-bad.jsonl");
  writeRows(bad, [{ kind: "contextual_eval_goldset_meta", headroom: { baseline_miss_fraction_all: 0.0 } }]);
  const badv = assertGoldsetHeadroom(bad);
  assert.equal(badv.ok, false, "0.0 headroom FAILS (circular instrument)");

  // Missing goldset → fail-safe (not a crash).
  const missing = assertGoldsetHeadroom(join(MEMORY_ROOT, "ledgers", "does-not-exist.jsonl"));
  assert.equal(missing.ok, false, "missing goldset → fail-safe false");
});

test("ndcgCiLowerDelta computes best_point - baseline_CI_upper and LIVE_WEIGHT_BASELINE is all-zero", () => {
  const d = ndcgCiLowerDelta(
    { ndcg_at_12: 0.40, bootstrap_ci: { ndcg: [0.35, 0.44] } },
    { ndcg_at_12: 0.50, bootstrap_ci: { ndcg: [0.46, 0.55] } },
  );
  assert.ok(Math.abs(d - (0.50 - 0.44)) < 1e-9, "best point minus baseline CI upper");
  assert.equal(ndcgCiLowerDelta(null, null), null, "null metrics → null");
  // The sweep's baseline is the frozen-CAPS all-zero triple (no movement off
  // 0.0 unless a cell strictly wins).
  for (const k of LIVE_WEIGHT_KEYS) {
    assert.equal(LIVE_WEIGHT_BASELINE[k], 0.0, `${k} baseline is 0.0`);
  }
});
