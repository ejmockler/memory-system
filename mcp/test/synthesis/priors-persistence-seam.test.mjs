// priors-persistence-seam.test.mjs — N10-priors-persistence-seam coverage.
//
// WORKUNIT N10-priors-persistence: persist candidate.priors{
//   damping_coefficient, corroboration_boost, engagement_prior } into the
// recall.jsonl surfaced[] emission so run-calibration-cycle.mjs's
// rescoreSurfacedWithLiveWeights reads REAL priors instead of degrading every
// row to NEUTRAL.
//
// The seam: the live recall scorer (multi-feature-score.computeScore) already
// COMPUTES all three priors and returns them on score_components. But the
// surfaced[] projection in recall.js historically dropped damping/corro and
// only mirrored engagement_prior into feature_breakdown — it never emitted the
// top-level `priors` dict that the OFFLINE calibration rescorer reads
// (calibration-loop.rescoreSurfacedWithLiveWeights:312-325). With no .priors
// the rescorer fell back to neutral (eng 0.0 / damp 1.0 / corro 1.0) on EVERY
// row → the additive term was a rank-invariant constant → ndcg_delta=0 across
// the whole 64-cell weight grid (the N1/N6 inertness finding).
//
// The load-bearing invariants this suite proves:
//   - _projectSurfacedPriors emits a TOP-LEVEL priors dict with exactly the
//     three keys the rescorer reads, sourced from score_components.
//   - the projection round-trips: computeScore → score_components →
//     _projectSurfacedPriors → surfaced[i].priors → rescoreSurfacedWithLiveWeights
//     re-scores with the SAME non-neutral priors the live scorer used.
//   - the rescorer reads surfaced[i].priors (NOT feature_breakdown) and the
//     three keys are exactly engagement_prior / damping_coefficient /
//     corroboration_boost.
//   - NON-neutral priors actually MOVE the rank when a weight is off 0.0
//     (proves the seam is live plumbing, not dead) and flip the order in the
//     direction the prior pushes.
//   - all-zero weights (the frozen-CAPS baseline) are a no-op even with
//     non-neutral persisted priors — safe to ship.
//   - null / missing score_components → null priors → rescorer falls back to
//     neutral, BYTE-identical to the pre-N10 behaviour.
//   - non-finite components are dropped (key absent → neutral), never poison
//     the rescore with NaN.
//   - thesis #1: projecting priors mutates neither the score_components input
//     nor the surfaced rows the rescorer is handed.
//
// Run: node --test test/synthesis/priors-persistence-seam.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const recallMod = await import("../../lib/tools/recall.js");
const { _projectSurfacedPriors } = recallMod;

const calib = await import("../../lib/synthesis/calibration-loop.js");
const { rescoreSurfacedWithLiveWeights } = calib;

const mfs = await import("../../lib/recall/multi-feature-score.js");
const { computeScore } = mfs;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NEUTRAL_GATES = {
  predicate_mask: 1,
  consent_dampener: 1.0,
  derivation_status: 1.0,
};
const BASE_CONTEXT = { entities: [], time_anchor: null, valence: null };
const FIXED_NOW = "2026-06-10T00:00:00Z";

// A non-degenerate score_components shape: only the three priors are relevant
// to the projection; the rest stand in for the other feature_breakdown fields.
function fbWith({ engagement_prior, damping_coefficient, corroboration_boost }) {
  return {
    s_emb_full3072: 0.5,
    predicate_mask: 1,
    consent_dampener: 1.0,
    derivation_status: 1.0,
    episodicity_match: 0.5,
    entity_overlap_jaccard: 0.0,
    time_anchor_match: 0.0,
    power_law_decay: 0.5,
    valence_compat: 0.5,
    engagement_prior,
    damping_coefficient,
    corroboration_boost,
    final_score: 0.5,
  };
}

// Build the surfaced[] row exactly as recall.js does at persist: top-level
// priors from _projectSurfacedPriors(score_components).
function surfacedRow(memory_id, score, position, scoreComponents) {
  return {
    memory_id,
    score,
    position,
    propensity: 0,
    rerank_score: null,
    priors: _projectSurfacedPriors(scoreComponents),
    feature_breakdown: scoreComponents,
  };
}

// ---------------------------------------------------------------------------
// (1) _projectSurfacedPriors shape — exactly the three keys the rescorer reads
// ---------------------------------------------------------------------------

test("_projectSurfacedPriors emits a top-level priors dict with the three rescorer keys from score_components", () => {
  const fb = fbWith({
    engagement_prior: 2.5,
    damping_coefficient: 0.74,
    corroboration_boost: 1.25,
  });
  const p = _projectSurfacedPriors(fb);
  assert.ok(p && typeof p === "object", "priors dict produced");
  assert.deepEqual(
    Object.keys(p).sort(),
    ["corroboration_boost", "damping_coefficient", "engagement_prior"],
    "exactly the three keys rescoreSurfacedWithLiveWeights reads",
  );
  assert.equal(p.engagement_prior, 2.5, "engagement_prior carried from fb");
  assert.equal(p.damping_coefficient, 0.74, "damping_coefficient carried from fb");
  assert.equal(p.corroboration_boost, 1.25, "corroboration_boost carried from fb");
});

test("_projectSurfacedPriors returns null when score_components is null/undefined (degraded recall) → rescorer neutral fallback", () => {
  assert.equal(_projectSurfacedPriors(null), null, "null fb → null priors");
  assert.equal(_projectSurfacedPriors(undefined), null, "undefined fb → null priors");
  assert.equal(_projectSurfacedPriors("nope"), null, "non-object fb → null priors");
});

test("_projectSurfacedPriors drops non-finite components (absent key → neutral) and never emits NaN", () => {
  const fb = fbWith({
    engagement_prior: Number.NaN,
    damping_coefficient: Infinity,
    corroboration_boost: 1.2,
  });
  const p = _projectSurfacedPriors(fb);
  assert.ok(!("engagement_prior" in p), "NaN engagement dropped");
  assert.ok(!("damping_coefficient" in p), "Infinity damping dropped");
  assert.equal(p.corroboration_boost, 1.2, "finite corroboration kept");
  // No value in the projection is non-finite.
  for (const v of Object.values(p)) {
    assert.ok(Number.isFinite(v), "every persisted prior is finite");
  }
});

test("_projectSurfacedPriors does NOT mutate the score_components input (thesis #1 spirit — derived projection)", () => {
  const fb = fbWith({
    engagement_prior: 1.0,
    damping_coefficient: 0.9,
    corroboration_boost: 1.1,
  });
  const clone = JSON.parse(JSON.stringify(fb));
  _projectSurfacedPriors(fb);
  assert.deepEqual(fb, clone, "input score_components untouched");
});

// ---------------------------------------------------------------------------
// (2) The rescorer READS surfaced[i].priors — not feature_breakdown
// ---------------------------------------------------------------------------

test("rescoreSurfacedWithLiveWeights reads the PERSISTED top-level priors (a feature_breakdown-only row degrades to neutral)", () => {
  // Two rows, identical base score. One carries persisted .priors with a high
  // damping; the other carries the same value ONLY in feature_breakdown (no
  // top-level .priors). With a positive damping weight, only the row whose
  // priors were PERSISTED at the seam should move.
  const persisted = {
    memory_id: "persisted",
    score: 0.50,
    position: 0,
    priors: { damping_coefficient: 1.5 },
  };
  const fbOnly = {
    memory_id: "fb_only",
    score: 0.50,
    position: 1,
    // damping lives only in feature_breakdown; the rescorer must NOT read it.
    feature_breakdown: { damping_coefficient: 1.5 },
  };
  const out = rescoreSurfacedWithLiveWeights([persisted, fbOnly], {
    SCORE_WEIGHT_DAMPING_PRIOR: 0.1,
  });
  const byId = new Map(out.map((r) => [r.memory_id, r]));
  // persisted: 0.50 + 0.1*1.5 = 0.65 ; fb_only: 0.50 + 0.1*1.0(neutral) = 0.60
  assert.ok(
    Math.abs(byId.get("persisted").score - 0.65) < 1e-9,
    "persisted .priors damping applied (0.65)",
  );
  assert.ok(
    Math.abs(byId.get("fb_only").score - 0.60) < 1e-9,
    "feature_breakdown-only damping IGNORED → neutral 1.0 (0.60)",
  );
  assert.equal(out[0].memory_id, "persisted", "persisted row ranks first");
});

// ---------------------------------------------------------------------------
// (3) End-to-end round-trip: computeScore → project → rescore reads same priors
// ---------------------------------------------------------------------------

test("round-trip: a computeScore candidate with non-neutral priors projects into surfaced[].priors the rescorer re-reads", () => {
  const candidate = {
    memory_id: "mem_rt",
    kind: "fact",
    ts: "2026-06-01T00:00:00Z",
    entities: [],
    valence: null,
    priors: { damping_coefficient: 0.6, corroboration_boost: 1.3 },
  };
  const sc = computeScore({
    s_emb_full3072: 0.5,
    gates: NEUTRAL_GATES,
    candidate,
    surrounding_context: BASE_CONTEXT,
    opts: {
      now: FIXED_NOW,
      // engagement map → non-neutral engagement_prior on score_components.
      engagementPriorById: new Map([["mem_rt", 2.0]]),
    },
  });
  // The scorer's score_components carry all three (damping/corro clamped into
  // bounds; engagement from the map).
  assert.ok(sc.damping_coefficient >= 0.5 && sc.damping_coefficient <= 1.5);
  assert.equal(sc.corroboration_boost, 1.3, "corroboration on score_components");
  assert.equal(sc.engagement_prior, 2.0, "engagement from map on score_components");

  const row = surfacedRow("mem_rt", sc.final_score, 0, sc);
  assert.deepEqual(
    Object.keys(row.priors).sort(),
    ["corroboration_boost", "damping_coefficient", "engagement_prior"],
    "all three priors persisted onto the surfaced row",
  );
  // The rescorer re-reads EXACTLY these persisted values (weights chosen so the
  // delta is the sum of each weight*prior).
  const out = rescoreSurfacedWithLiveWeights([row], {
    SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.01,
    SCORE_WEIGHT_DAMPING_PRIOR: 0.02,
    SCORE_WEIGHT_CORROBORATION_PRIOR: 0.03,
  });
  const expected =
    sc.final_score +
    0.01 * sc.engagement_prior +
    0.02 * sc.damping_coefficient +
    0.03 * sc.corroboration_boost;
  assert.ok(
    Math.abs(out[0].score - expected) < 1e-9,
    "rescorer used the persisted priors verbatim",
  );
});

// ---------------------------------------------------------------------------
// (4) Non-neutral priors MOVE the rank — the seam is live, not dead plumbing
// ---------------------------------------------------------------------------

test("persisted non-neutral DAMPING flips order when the damping weight is off 0.0", () => {
  // loser starts ahead on base score but has LOW damping; winner has HIGH.
  const loser = surfacedRow(
    "loser",
    0.50,
    0,
    fbWith({ engagement_prior: 0.0, damping_coefficient: 0.5, corroboration_boost: 1.0 }),
  );
  const winner = surfacedRow(
    "winner",
    0.49,
    1,
    fbWith({ engagement_prior: 0.0, damping_coefficient: 1.5, corroboration_boost: 1.0 }),
  );
  const out = rescoreSurfacedWithLiveWeights([loser, winner], {
    SCORE_WEIGHT_DAMPING_PRIOR: 0.05,
  });
  // loser: 0.50 + 0.05*0.5 = 0.525 ; winner: 0.49 + 0.05*1.5 = 0.565
  assert.equal(out[0].memory_id, "winner", "high-damping row overtook on the prior");
  assert.equal(out[0].position, 0, "positions recomputed");
  assert.equal(out[1].memory_id, "loser");
});

test("persisted non-neutral ENGAGEMENT moves the score when the engagement weight is off 0.0", () => {
  const hot = surfacedRow(
    "hot",
    0.40,
    0,
    fbWith({ engagement_prior: 3.0, damping_coefficient: 1.0, corroboration_boost: 1.0 }),
  );
  const cold = surfacedRow(
    "cold",
    0.45,
    1,
    fbWith({ engagement_prior: 0.0, damping_coefficient: 1.0, corroboration_boost: 1.0 }),
  );
  const out = rescoreSurfacedWithLiveWeights([hot, cold], {
    SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.02,
  });
  // hot: 0.40 + 0.02*3.0 = 0.46 ; cold: 0.45 + 0.02*0 = 0.45
  assert.equal(out[0].memory_id, "hot", "engagement prior lifted the hot row past cold");
});

test("persisted non-neutral CORROBORATION moves the score when the corroboration weight is off 0.0", () => {
  const corroborated = surfacedRow(
    "corr",
    0.40,
    0,
    fbWith({ engagement_prior: 0.0, damping_coefficient: 1.0, corroboration_boost: 1.3 }),
  );
  const lonely = surfacedRow(
    "lonely",
    0.43,
    1,
    fbWith({ engagement_prior: 0.0, damping_coefficient: 1.0, corroboration_boost: 1.0 }),
  );
  const out = rescoreSurfacedWithLiveWeights([corroborated, lonely], {
    SCORE_WEIGHT_CORROBORATION_PRIOR: 0.3,
  });
  // corr: 0.40 + 0.3*1.3 = 0.79 ; lonely: 0.43 + 0.3*1.0 = 0.73
  assert.equal(out[0].memory_id, "corr", "corroboration prior overtook on the prior");
});

// ---------------------------------------------------------------------------
// (5) All-zero (frozen-CAPS baseline) weights are a no-op even with non-neutral
//     persisted priors — safe to ship.
// ---------------------------------------------------------------------------

test("all-zero weights are byte-identical even with non-neutral PERSISTED priors (safe-to-ship baseline)", () => {
  const a = surfacedRow(
    "a",
    0.50,
    0,
    fbWith({ engagement_prior: 5.0, damping_coefficient: 0.5, corroboration_boost: 1.3 }),
  );
  const b = surfacedRow(
    "b",
    0.49,
    1,
    fbWith({ engagement_prior: 0.0, damping_coefficient: 1.5, corroboration_boost: 1.0 }),
  );
  const out = rescoreSurfacedWithLiveWeights([a, b], {
    SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.0,
    SCORE_WEIGHT_DAMPING_PRIOR: 0.0,
    SCORE_WEIGHT_CORROBORATION_PRIOR: 0.0,
  });
  assert.equal(out[0].memory_id, "a", "order preserved at baseline");
  assert.ok(Math.abs(out[0].score - 0.50) < 1e-12, "a score unchanged");
  assert.ok(Math.abs(out[1].score - 0.49) < 1e-12, "b score unchanged");
});

// ---------------------------------------------------------------------------
// (6) Pre-N10 parity — a row with null priors degrades to neutral identically
// ---------------------------------------------------------------------------

test("a surfaced row with null priors (degraded recall) re-scores BYTE-identical to the pre-N10 neutral path", () => {
  // Pre-N10: no .priors at all. The rescorer must read neutral.
  const preN10 = { memory_id: "old", score: 0.50, position: 0 };
  // A row whose score_components was null (degraded) → _projectSurfacedPriors
  // returns null → same neutral fallback.
  const degraded = surfacedRow("deg", 0.50, 0, null);
  assert.equal(degraded.priors, null, "null score_components → null priors");

  const w = {
    SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.03,
    SCORE_WEIGHT_DAMPING_PRIOR: 0.03,
    SCORE_WEIGHT_CORROBORATION_PRIOR: 0.03,
  };
  const a = rescoreSurfacedWithLiveWeights([preN10], w);
  const b = rescoreSurfacedWithLiveWeights([degraded], w);
  // Both: 0.50 + 0.03*0(eng) + 0.03*1.0(damp) + 0.03*1.0(corro) = 0.56
  assert.ok(Math.abs(a[0].score - 0.56) < 1e-9, "pre-N10 null-priors neutral path");
  assert.ok(Math.abs(b[0].score - 0.56) < 1e-9, "null score_components neutral path");
  assert.equal(a[0].score, b[0].score, "byte-identical neutral fallback");
});

// ---------------------------------------------------------------------------
// (7) Out-of-bound persisted priors are re-clamped by the rescorer (defence in
//     depth — the persisted value is a passthrough, the rescorer owns bounds)
// ---------------------------------------------------------------------------

test("rescorer re-clamps a persisted prior beyond the scorer bounds (no over-fit past reachable range)", () => {
  // corroboration_boost bound is [1.0, 1.3]; persist 5.0 and confirm clamp.
  const row = surfacedRow(
    "m",
    0.0,
    0,
    fbWith({ engagement_prior: 0.0, damping_coefficient: 1.0, corroboration_boost: 5.0 }),
  );
  assert.equal(row.priors.corroboration_boost, 5.0, "persisted verbatim (5.0)");
  const out = rescoreSurfacedWithLiveWeights([row], {
    SCORE_WEIGHT_CORROBORATION_PRIOR: 1.0,
  });
  // clamped to 1.3 → 0.0 + 1.0*1.3 = 1.3 (NOT 5.0)
  assert.ok(Math.abs(out[0].score - 1.3) < 1e-9, "rescorer clamped 5.0 → 1.3");
});

// ---------------------------------------------------------------------------
// (8) Thesis #1 — rescoring does not mutate the surfaced rows it is handed
// ---------------------------------------------------------------------------

test("rescoreSurfacedWithLiveWeights does not mutate the input surfaced rows (thesis #1: derived, append-only substrate)", () => {
  const rows = [
    surfacedRow("x", 0.5, 0, fbWith({ engagement_prior: 1.0, damping_coefficient: 0.8, corroboration_boost: 1.2 })),
    surfacedRow("y", 0.4, 1, fbWith({ engagement_prior: 2.0, damping_coefficient: 1.1, corroboration_boost: 1.0 })),
  ];
  const clone = JSON.parse(JSON.stringify(rows));
  rescoreSurfacedWithLiveWeights(rows, {
    SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.02,
    SCORE_WEIGHT_DAMPING_PRIOR: 0.02,
    SCORE_WEIGHT_CORROBORATION_PRIOR: 0.02,
  });
  assert.deepEqual(rows, clone, "input surfaced rows untouched (new array returned)");
});

// ---------------------------------------------------------------------------
// (9) Multi-row sweep differentiates cells — the inertness gap is closed
// ---------------------------------------------------------------------------

test("two weight cells produce DIFFERENT rankings once priors are persisted (closes the rank-invariant ndcg_delta=0 trap)", () => {
  // Three rows whose base order would be A > B > C, but whose damping priors
  // are inverted (C highest). At weight 0.0 the order is base; at a high
  // damping weight the order flips — proving persisted priors make the grid
  // non-degenerate (the exact failure N1/N6 diagnosed when priors were neutral).
  const rows = () => [
    surfacedRow("A", 0.52, 0, fbWith({ engagement_prior: 0, damping_coefficient: 0.5, corroboration_boost: 1.0 })),
    surfacedRow("B", 0.51, 1, fbWith({ engagement_prior: 0, damping_coefficient: 1.0, corroboration_boost: 1.0 })),
    surfacedRow("C", 0.50, 2, fbWith({ engagement_prior: 0, damping_coefficient: 1.5, corroboration_boost: 1.0 })),
  ];
  const cell0 = rescoreSurfacedWithLiveWeights(rows(), { SCORE_WEIGHT_DAMPING_PRIOR: 0.0 });
  const cell1 = rescoreSurfacedWithLiveWeights(rows(), { SCORE_WEIGHT_DAMPING_PRIOR: 0.05 });
  const order0 = cell0.map((r) => r.memory_id);
  const order1 = cell1.map((r) => r.memory_id);
  assert.deepEqual(order0, ["A", "B", "C"], "baseline cell keeps base order");
  // C: 0.50 + 0.05*1.5 = 0.575 ; A: 0.52 + 0.05*0.5 = 0.545 ; B: 0.51+0.05 = 0.56
  assert.deepEqual(order1, ["C", "B", "A"], "high-damping cell reorders by prior");
  assert.notDeepEqual(order0, order1, "the two cells are NOT rank-identical");
});
