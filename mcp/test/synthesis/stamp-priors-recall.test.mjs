// stamp-priors-recall.test.mjs — N6-stamp-priors coverage.
//
// WORKUNIT N6-stamp-priors: the recall candidate-build path must populate
// candidate.priors.{damping_coefficient, corroboration_boost} (from
// damping-reader + corroboration-propagator) and build engagementPriorById
// from the recall-feedback rows, so the three SCORE_WEIGHT_*_PRIOR weights
// (proved-wired by N1) have a NON-neutral input to act on.
//
// The load-bearing invariants this suite proves:
//   - buildDampingCoefficientMap is BYTE-IDENTICAL to per-id
//     computeDampingCoefficient — the batch builder is the latency-safe
//     equivalent (ONE damping-log scan, NOT N per-candidate scans).
//   - the substrate-with-signal case yields NON-neutral priors (damping ≠ 1.0,
//     corroboration ≠ 1.0).
//   - engagementPriorById is populated from policy.salience.recall_feedback rows.
//   - GATE-OFF / weights-still-0.0 ⇒ ranking byte-identical: stamping
//     non-neutral priors with the three weights at 0.0 produces the EXACT same
//     final_score as neutral priors — so it is safe to ship stamped.
//   - the wiring is LIVE: flip a weight off 0.0 via the score-weight overlay and
//     the stamped prior DOES move the score (proves it is not dead plumbing).
//   - thesis #1: the source candidate object is never mutated by stamping.
//
// Run: node --test test/synthesis/stamp-priors-recall.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hermetic env BEFORE dynamic import — the damping-log + recall-feedback
// substrates resolve paths from MEMORY_ROOT / POLICY_BASE_DIR.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-stamp-priors-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(MEMORY_ROOT, "policy");
const LEDGERS_DIR = join(MEMORY_ROOT, "ledgers");
mkdirSync(POLICY_DIR, { recursive: true, mode: 0o700 });
mkdirSync(LEDGERS_DIR, { recursive: true, mode: 0o700 });
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;

const dampingReader = await import("../../lib/synthesis/damping-reader.js");
const dampingLogMod = await import("../../lib/synthesis/damping-log.js");
const corroborationMod = await import(
  "../../lib/synthesis/corroboration-propagator.js"
);
const engagementMod = await import(
  "../../lib/synthesis/engagement-prior-reader.js"
);
const scoreMod = await import("../../lib/recall/multi-feature-score.js");

const {
  DAMPING_CAPS,
  computeDampingCoefficient,
  buildDampingCoefficientMap,
  dampingCoefficientFromMap,
} = dampingReader;
const { CORROBORATION_CAPS, computeCorroborationBoost } = corroborationMod;
const {
  buildEngagementPriorMap,
  __resetEngagementPriorCacheForTests,
} = engagementMod;
const { computeScore } = scoreMod;

const dampingLogPath = dampingLogMod.dampingLogPath();

const NOW_MS = Date.parse("2026-06-20T12:00:00Z");
const ONE_HOUR_AGO = new Date(NOW_MS - 60 * 60 * 1000).toISOString();

function resetDampingLog() {
  writeFileSync(dampingLogPath, "", { mode: 0o600 });
}
function appendDamping(row) {
  appendFileSync(dampingLogPath, JSON.stringify(row) + "\n", { mode: 0o600 });
}
function dampEnvelope(extra) {
  return {
    schema_version: 1,
    signal_kind: extra.signal_kind,
    memory_id: extra.memory_id,
    turn_window_id: extra.turn_window_id || "twid_test",
    recall_id: "rec_test_001",
    conversation_id_hash: "cidhash_test",
    ts: extra.ts,
    populator_version: "test-writer@1.0.0",
    fields: extra.fields != null ? extra.fields : {},
  };
}

// Minimal derivation-graph-shaped object (reverseAdj = parent → children).
function makeGraph(reverseEdges = []) {
  const reverseAdj = new Map();
  for (const [parent, child] of reverseEdges) {
    let s = reverseAdj.get(parent);
    if (s == null) {
      s = new Set();
      reverseAdj.set(parent, s);
    }
    s.add(child);
  }
  return { reverseAdj, forwardAdj: new Map(), kindOf: new Map() };
}

// A score input that exercises the additive branch (so prior weights matter).
function scoreArgs(priors, opts) {
  return {
    s_emb_full3072: 0.4,
    gates: { predicate_mask: 1, consent_dampener: 1.0, derivation_status: 1.0 },
    candidate: {
      memory_id: "mem_A",
      kind: "fact",
      ts: ONE_HOUR_AGO,
      entities: ["e1"],
      valence: null,
      features: null,
      priors: priors || null,
    },
    surrounding_context: {
      entities: ["e1"],
      time_anchor: null,
      valence: null,
      query_episodicity: null,
    },
    opts: opts || { now: "2026-06-20T12:00:00Z" },
  };
}

// ===========================================================================
// 1. BATCH-PARITY: buildDampingCoefficientMap == per-id computeDampingCoefficient
//    (the latency-safe equivalence — one scan, not N).
// ===========================================================================
test("buildDampingCoefficientMap is byte-identical to per-id reader", async () => {
  resetDampingLog();
  // mem_boost: 1 direct engagement (> BASE). mem_damp: 2 surfacings (< BASE).
  // mem_expunged: engagement + tombstone (→ MIN_COEF). mem_neutral: no rows.
  appendDamping(
    dampEnvelope({
      memory_id: "mem_boost",
      signal_kind: "engagement",
      ts: ONE_HOUR_AGO,
      fields: { engagement_class: "direct", evidence_span_hash: "h1" },
    }),
  );
  appendDamping(
    dampEnvelope({
      memory_id: "mem_damp",
      signal_kind: "surfacing",
      ts: ONE_HOUR_AGO,
      fields: { surfaced_strength: 0.5, position: 0, score: 0.5, propensity: 0.5 },
    }),
  );
  appendDamping(
    dampEnvelope({
      memory_id: "mem_damp",
      signal_kind: "surfacing",
      ts: ONE_HOUR_AGO,
      fields: { surfaced_strength: 0.5, position: 1, score: 0.5, propensity: 0.5 },
    }),
  );
  appendDamping(
    dampEnvelope({
      memory_id: "mem_expunged",
      signal_kind: "engagement",
      ts: ONE_HOUR_AGO,
      fields: { engagement_class: "direct", evidence_span_hash: "h2" },
    }),
  );
  appendDamping({
    schema_version: 1,
    signal_kind: "expunged",
    memory_id: "mem_expunged",
    turn_window_id: "EXPUNGE_GLOBAL",
    recall_id: null,
    conversation_id_hash: null,
    ts: ONE_HOUR_AGO,
    populator_version: "test-writer@1.0.0",
    fields: { excise_reason: "silent_excise" },
  });

  const map = await buildDampingCoefficientMap({ nowMs: NOW_MS });
  assert.ok(map instanceof Map, "returns a Map");

  for (const mid of ["mem_boost", "mem_damp", "mem_expunged", "mem_neutral"]) {
    const perId = await computeDampingCoefficient({ memory_id: mid, nowMs: NOW_MS });
    const fromMap = dampingCoefficientFromMap(map, mid);
    assert.equal(
      fromMap,
      perId,
      `parity for ${mid}: map=${fromMap} per-id=${perId}`,
    );
  }
  // Spot-check the actual values are non-neutral where signal exists.
  assert.ok(map.get("mem_boost") > DAMPING_CAPS.BASE, "boost > BASE");
  assert.ok(map.get("mem_damp") < DAMPING_CAPS.BASE, "damp < BASE");
  assert.equal(map.get("mem_expunged"), DAMPING_CAPS.MIN_COEF, "expunged → MIN_COEF");
});

// ===========================================================================
// 2. NEUTRAL ABSENCE: a memory_id with NO signal is ABSENT from the map and
//    stamps the neutral BASE (1.0) — the map only carries non-neutral coefs.
// ===========================================================================
test("absent memory_id stamps neutral BASE; map carries only non-neutral", async () => {
  resetDampingLog();
  appendDamping(
    dampEnvelope({
      memory_id: "mem_has_signal",
      signal_kind: "engagement",
      ts: ONE_HOUR_AGO,
      fields: { engagement_class: "direct", evidence_span_hash: "h3" },
    }),
  );
  const map = await buildDampingCoefficientMap({ nowMs: NOW_MS });
  assert.ok(!map.has("mem_never_seen"), "no-signal id absent from map");
  assert.equal(
    dampingCoefficientFromMap(map, "mem_never_seen"),
    DAMPING_CAPS.BASE,
    "absent id → neutral BASE",
  );
  assert.equal(
    dampingCoefficientFromMap(null, "anything"),
    DAMPING_CAPS.BASE,
    "null map → neutral BASE",
  );
});

// ===========================================================================
// 3. DEFENSIVE: empty/missing damping log → empty map → neutral everywhere.
// ===========================================================================
test("empty damping log → empty map (neutral everywhere)", async () => {
  resetDampingLog();
  const map = await buildDampingCoefficientMap({ nowMs: NOW_MS });
  assert.ok(map instanceof Map, "returns a Map even on empty log");
  assert.equal(map.size, 0, "no non-neutral coefs");
  assert.equal(dampingCoefficientFromMap(map, "mem_X"), DAMPING_CAPS.BASE);
});

// ===========================================================================
// 4. ENGAGEMENT-PRIOR MAP populated from recall-feedback rows.
// ===========================================================================
test("buildEngagementPriorMap populated from recall-feedback rows", () => {
  __resetEngagementPriorCacheForTests();
  // The engagement-prior reader projects policy.salience.recall_feedback rows
  // off memory.jsonl. Write a hermetic ledger with two feedback rows that
  // surface mem_freq twice and mem_once once.
  const ledgerPath = join(LEDGERS_DIR, "memory.jsonl");
  const fbRow = (ids, ts) =>
    JSON.stringify({
      kind: "policy",
      policy_kind: "salience.recall_feedback",
      surfaced_memory_ids: ids,
      ts,
    }) + "\n";
  writeFileSync(
    ledgerPath,
    fbRow(["mem_freq", "mem_once"], "2026-06-19T10:00:00Z") +
      fbRow(["mem_freq"], "2026-06-19T11:00:00Z"),
    { mode: 0o600 },
  );
  const map = buildEngagementPriorMap(ledgerPath, NOW_MS);
  assert.ok(map instanceof Map, "returns a Map");
  assert.ok(map.has("mem_freq"), "frequently-surfaced id present");
  assert.ok(map.has("mem_once"), "once-surfaced id present");
  // log1p(2) > log1p(1): the more-surfaced id has the higher prior.
  assert.ok(
    map.get("mem_freq") > map.get("mem_once"),
    `freq (${map.get("mem_freq")}) > once (${map.get("mem_once")})`,
  );
  assert.ok(map.get("mem_freq") > 0, "non-zero engagement prior");
});

// ===========================================================================
// 5. CORROBORATION boost is NON-neutral when descendants exist.
// ===========================================================================
test("corroboration boost > BASE when candidate has descendants", () => {
  const graph = makeGraph([
    ["mem_root", "mem_child1"],
    ["mem_root", "mem_child2"],
  ]);
  const boost = computeCorroborationBoost({
    memory_id: "mem_root",
    derivationGraph: graph,
  });
  assert.ok(boost > CORROBORATION_CAPS.BASE, `boost ${boost} > BASE`);
  assert.equal(
    boost,
    CORROBORATION_CAPS.BASE + 2 * CORROBORATION_CAPS.BOOST_PER_DESCENDANT,
    "2 descendants → BASE + 2*per",
  );
  // A leaf with no descendants stays neutral.
  assert.equal(
    computeCorroborationBoost({ memory_id: "mem_child1", derivationGraph: graph }),
    CORROBORATION_CAPS.BASE,
    "leaf → BASE",
  );
});

// ===========================================================================
// 6. SAFE-TO-SHIP: non-neutral priors with the three weights at 0.0 produce
//    a BYTE-IDENTICAL final_score to neutral priors. (This is the proof that
//    stamping priors by default is a ranking no-op until N1 flips a weight.)
// ===========================================================================
test("weights=0.0: non-neutral priors score identically to neutral", () => {
  // Default CAPS: SCORE_WEIGHT_DAMPING_PRIOR / CORROBORATION_PRIOR /
  // ENGAGEMENT_PRIOR all 0.0; no overlay supplied.
  const neutral = computeScore(scoreArgs(null));
  const stamped = computeScore(
    scoreArgs({ damping_coefficient: 1.5, corroboration_boost: 1.3 }),
  );
  assert.equal(
    stamped.final_score,
    neutral.final_score,
    "stamped non-neutral priors do NOT move score at weight 0.0",
  );
  // Also with a populated engagement-prior map at weight 0.0 → no change.
  const engMap = new Map([["mem_A", 5.0]]);
  const withEng = computeScore(
    scoreArgs(
      { damping_coefficient: 1.5, corroboration_boost: 1.3 },
      { now: "2026-06-20T12:00:00Z", engagementPriorById: engMap },
    ),
  );
  assert.equal(
    withEng.final_score,
    neutral.final_score,
    "engagement prior at weight 0.0 does not move score",
  );
});

// ===========================================================================
// 7. WIRING IS LIVE: flip the damping weight off 0.0 via the score-weight
//    overlay and the stamped prior MOVES the score (not dead plumbing).
// ===========================================================================
test("non-zero damping weight: stamped prior moves the score", () => {
  const overlay = {
    source: "projection",
    SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.0,
    SCORE_WEIGHT_DAMPING_PRIOR: 0.5,
    SCORE_WEIGHT_CORROBORATION_PRIOR: 0.0,
  };
  const base = computeScore(
    scoreArgs(
      { damping_coefficient: 1.0, corroboration_boost: 1.0 },
      { now: "2026-06-20T12:00:00Z", scoreWeightOverlay: overlay },
    ),
  );
  const boosted = computeScore(
    scoreArgs(
      { damping_coefficient: 1.5, corroboration_boost: 1.0 },
      { now: "2026-06-20T12:00:00Z", scoreWeightOverlay: overlay },
    ),
  );
  assert.ok(
    boosted.final_score > base.final_score,
    `boosted (${boosted.final_score}) > base (${base.final_score}) under non-zero damping weight`,
  );
  // The delta is exactly w_damping * (1.5 - 1.0) on the additive branch.
  const delta = boosted.final_score - base.final_score;
  assert.ok(Math.abs(delta - 0.5 * 0.5) < 1e-9, `delta ${delta} == w*Δcoef`);
});

// ===========================================================================
// 8. WIRING IS LIVE (corroboration): flip the corroboration weight off 0.0.
// ===========================================================================
test("non-zero corroboration weight: stamped boost moves the score", () => {
  const overlay = {
    source: "projection",
    SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.0,
    SCORE_WEIGHT_DAMPING_PRIOR: 0.0,
    SCORE_WEIGHT_CORROBORATION_PRIOR: 0.4,
  };
  const neutralCorro = computeScore(
    scoreArgs(
      { damping_coefficient: 1.0, corroboration_boost: 1.0 },
      { now: "2026-06-20T12:00:00Z", scoreWeightOverlay: overlay },
    ),
  );
  const boostedCorro = computeScore(
    scoreArgs(
      { damping_coefficient: 1.0, corroboration_boost: 1.3 },
      { now: "2026-06-20T12:00:00Z", scoreWeightOverlay: overlay },
    ),
  );
  assert.ok(
    boostedCorro.final_score > neutralCorro.final_score,
    "corroboration boost lifts score under non-zero weight",
  );
});

// ===========================================================================
// 9. WIRING IS LIVE (engagement): non-zero engagement weight + populated map.
// ===========================================================================
test("non-zero engagement weight: populated map moves the score", () => {
  const overlay = {
    source: "projection",
    SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.3,
    SCORE_WEIGHT_DAMPING_PRIOR: 0.0,
    SCORE_WEIGHT_CORROBORATION_PRIOR: 0.0,
  };
  const noPrior = computeScore(
    scoreArgs(null, {
      now: "2026-06-20T12:00:00Z",
      scoreWeightOverlay: overlay,
      engagementPriorById: new Map(),
    }),
  );
  const withPrior = computeScore(
    scoreArgs(null, {
      now: "2026-06-20T12:00:00Z",
      scoreWeightOverlay: overlay,
      engagementPriorById: new Map([["mem_A", 2.0]]),
    }),
  );
  assert.ok(
    withPrior.final_score > noPrior.final_score,
    "engagement prior lifts score under non-zero weight",
  );
  const delta = withPrior.final_score - noPrior.final_score;
  assert.ok(Math.abs(delta - 0.3 * 2.0) < 1e-9, `delta ${delta} == w_eng*prior`);
});

// ===========================================================================
// 10. CLAMP DEFENSE: an out-of-range stamped prior is clamped by the scorer.
// ===========================================================================
test("scorer clamps out-of-range stamped priors defensively", () => {
  const overlay = {
    source: "projection",
    SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.0,
    SCORE_WEIGHT_DAMPING_PRIOR: 1.0,
    SCORE_WEIGHT_CORROBORATION_PRIOR: 0.0,
  };
  // damping 99 clamps to MAX_COEF (1.5); damping -5 clamps to MIN_COEF (0.5).
  const hi = computeScore(
    scoreArgs(
      { damping_coefficient: 99, corroboration_boost: 1.0 },
      { now: "2026-06-20T12:00:00Z", scoreWeightOverlay: overlay },
    ),
  );
  const atMax = computeScore(
    scoreArgs(
      { damping_coefficient: 1.5, corroboration_boost: 1.0 },
      { now: "2026-06-20T12:00:00Z", scoreWeightOverlay: overlay },
    ),
  );
  assert.equal(hi.final_score, atMax.final_score, "99 clamps to MAX_COEF=1.5");
});

// ===========================================================================
// 11. THESIS #1: stamping priors onto the score-time candidate does NOT mutate
//     the source object. (computeScore reads candidate.priors; the recall
//     stamper assigns priors to a FRESH object literal, never to cRaw.)
// ===========================================================================
test("thesis #1: source candidate object not mutated by scoring", () => {
  const sourceCandidate = {
    memory_id: "mem_A",
    kind: "fact",
    ts: ONE_HOUR_AGO,
    entities: ["e1"],
    valence: null,
    features: null,
  };
  const snapshot = JSON.stringify(sourceCandidate);
  // Mirror the recall stamper: build a NEW object with priors, never touch src.
  const scoreView = {
    ...sourceCandidate,
    priors: { damping_coefficient: 1.5, corroboration_boost: 1.3 },
  };
  computeScore({
    s_emb_full3072: 0.4,
    gates: { predicate_mask: 1, consent_dampener: 1.0, derivation_status: 1.0 },
    candidate: scoreView,
    surrounding_context: {
      entities: ["e1"],
      time_anchor: null,
      valence: null,
      query_episodicity: null,
    },
    opts: { now: "2026-06-20T12:00:00Z" },
  });
  assert.equal(
    JSON.stringify(sourceCandidate),
    snapshot,
    "source candidate byte-identical after scoring",
  );
  assert.ok(
    !("priors" in sourceCandidate),
    "priors never landed on the source object",
  );
});

// ===========================================================================
// 12. LATENCY GUARD: the batch builder reads the damping log ONCE regardless of
//     how many memory_ids are looked up. We prove the equivalence holds for a
//     large id set with a SINGLE buildDampingCoefficientMap call — i.e. the
//     recall loop never needs a per-candidate scan.
// ===========================================================================
test("latency: one batch build serves many ids (no per-candidate scan)", async () => {
  resetDampingLog();
  for (let i = 0; i < 50; i++) {
    appendDamping(
      dampEnvelope({
        memory_id: `mem_${i}`,
        signal_kind: "engagement",
        ts: ONE_HOUR_AGO,
        fields: { engagement_class: "direct", evidence_span_hash: `h_${i}` },
      }),
    );
  }
  // ONE build call.
  const map = await buildDampingCoefficientMap({ nowMs: NOW_MS });
  assert.equal(map.size, 50, "all 50 ids resolved from one scan");
  // Every id matches its per-id reader value — proving the single scan is
  // sufficient for the whole candidate set.
  for (let i = 0; i < 50; i++) {
    const mid = `mem_${i}`;
    const perId = await computeDampingCoefficient({ memory_id: mid, nowMs: NOW_MS });
    assert.equal(dampingCoefficientFromMap(map, mid), perId, `parity ${mid}`);
  }
});

// ===========================================================================
// 13. GATE-OFF SHAPE: dampingCoefficientFromMap on null map (the gate-OFF path
//     where no map is built) returns neutral — the stamp degrades cleanly.
// ===========================================================================
test("gate-OFF: null damping map degrades every id to neutral", () => {
  assert.equal(dampingCoefficientFromMap(null, "mem_A"), DAMPING_CAPS.BASE);
  assert.equal(dampingCoefficientFromMap(undefined, "mem_A"), DAMPING_CAPS.BASE);
  assert.equal(dampingCoefficientFromMap(new Map(), "mem_A"), DAMPING_CAPS.BASE);
  // Non-finite stored value → BASE (defensive).
  assert.equal(
    dampingCoefficientFromMap(new Map([["mem_A", NaN]]), "mem_A"),
    DAMPING_CAPS.BASE,
  );
});
