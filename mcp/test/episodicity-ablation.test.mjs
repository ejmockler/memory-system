// episodicity-ablation.test.mjs — D2. The default-off ablation gate on the
// `episodicity_match` multiplier in mcp/lib/recall/multi-feature-score.js.
//
// WHAT IS BEING TESTED, and why it is not circular
// -----------------------------------------------
// `episodicity_match` is a live MULTIPLICAND on the multiplicative branch
// (multi-feature-score.js, `const multiplicative = s_emb_for_branch *
// predicate_mask * consent_dampener * derivation_status * episodicity_match`).
// The synthesis-side match function is `1 - |fact_ep - query_ep|`
// (lib/synthesis/episodicity-scorer.js). Facts are stamped in [0.136, 0.461]
// and the recall-time populator emits query_episodicity = 0.1359 on 256/265
// logged recalls, so in production the multiplier is `1.1359 - f` — a term
// that FALLS as the candidate's own episodicity RISES. That anti-episodic
// prior was never calibrated; this flag lets the operator measure recall with
// it removed.
//
// The BASELINE literals below were captured from the PRE-EDIT module
// (sha256 9cc48453ce1bd207267128ab81d093abd1b553b1f437e77f92e952d464327085)
// before the gate was added, so asserting against them is a real regression
// test and not a snapshot of the code's current behaviour. Every fixture
// candidate carries `entities: []` and every context carries `entities: []`,
// which pins `entity_overlap_jaccard` to a constant 0 through the
// `either side is empty -> 0` early return that both the committed and the
// working-tree versions of entityOverlapJaccard share. The literals therefore
// hold identically at HEAD, in a worktree, and in the working tree that
// carries the uncommitted entityMatchKey diff. The test asserts that 0
// explicitly rather than assuming it.
//
// The independent, pre-existing proof that the DEFAULT path is unchanged is
// test/multi-feature-score.test.mjs, authored before this node.
//
// Hermetic discipline (C-NEW-2 pattern, standing): MEMORY_ROOT and the
// POLICY/STORAGE/LEDGERS dirs point at mkdtempSync paths set BEFORE any
// dynamic import of a memory-system module. computeScore is pure and does no
// I/O — this test must never open the live install's ledgers/ or
// index/, and the preamble is what keeps that true
// if the module ever grows a config.js dependency.
//
// Determinism: fixed fixtures, an explicit `opts.now`, no Date.now(), no
// Math.random(). Rankings are reproducible across runs and machines.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hermeticity: stake out tmp dirs and overwrite env BEFORE dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-episodicity-ablate-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");

// Dynamic imports AFTER env override.
const { computeScore, EPISODICITY_ABLATE_ENV } = await import(
  "../lib/recall/multi-feature-score.js"
);
// NOTE: the 2-arg synthesis match, deliberately NOT the same-named v0 stub
// that multi-feature-score.js also exports (that one returns a constant 1.0).
const { episodicityMatch: synthesisEpisodicityMatch } = await import(
  "../lib/synthesis/episodicity-scorer.js"
);

const FLAG = EPISODICITY_ABLATE_ENV.ENABLED;

// The live populator constant: 256/265 logged recalls carry exactly this.
const QUERY_EPISODICITY = 0.1359;
const FIXED_NOW = "2026-08-05T00:00:00.000Z";

function ctx(over = {}) {
  return {
    entities: [],
    time_anchor: null,
    valence: null,
    query_episodicity: QUERY_EPISODICITY,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Baseline fixtures. Byte-identical to the set the pre-edit capture ran.
// ---------------------------------------------------------------------------
const BASELINE_CASES = [
  {
    label: "synthesis-path-high-episodicity",
    s_emb_full3072: 0.82,
    gates: { predicate_mask: 1, consent_dampener: 1, derivation_status: 1 },
    candidate: {
      memory_id: "b0",
      kind: "fact",
      ts: "2026-07-01T00:00:00.000Z",
      entities: [],
      valence: null,
      features: { episodicity: 0.46 },
    },
    surrounding_context: ctx(),
  },
  {
    label: "synthesis-path-low-episodicity",
    s_emb_full3072: 0.8,
    gates: { predicate_mask: 1, consent_dampener: 1, derivation_status: 1 },
    candidate: {
      memory_id: "b1",
      kind: "fact",
      ts: "2026-07-01T00:00:00.000Z",
      entities: [],
      valence: null,
      features: { episodicity: 0.14 },
    },
    surrounding_context: ctx(),
  },
  {
    label: "stub-path-no-candidate-episodicity",
    s_emb_full3072: 0.77,
    gates: { predicate_mask: 1, consent_dampener: 1, derivation_status: 1 },
    candidate: {
      memory_id: "b2",
      kind: "fact",
      ts: "2026-06-15T00:00:00.000Z",
      entities: [],
      valence: null,
      features: {},
    },
    surrounding_context: ctx(),
  },
  {
    label: "stub-path-no-query-episodicity",
    s_emb_full3072: 0.7,
    gates: { predicate_mask: 1, consent_dampener: 1, derivation_status: 1 },
    candidate: {
      memory_id: "b3",
      kind: "fact",
      ts: "2026-05-01T00:00:00.000Z",
      entities: [],
      valence: null,
      features: { episodicity: 0.3 },
    },
    surrounding_context: ctx({ query_episodicity: null }),
  },
  {
    label: "predicate-masked-multiplicative-zero",
    s_emb_full3072: 0.95,
    gates: { predicate_mask: 0, consent_dampener: 1, derivation_status: 1 },
    candidate: {
      memory_id: "b4",
      kind: "fact",
      ts: "2026-07-20T00:00:00.000Z",
      entities: [],
      valence: 0.4,
      features: { episodicity: 0.42 },
    },
    surrounding_context: ctx({
      valence: 0.2,
      time_anchor: "2026-07-20T00:00:00.000Z",
    }),
  },
  {
    label: "synthesis-path-with-salience-and-anchor",
    s_emb_full3072: 0.61,
    gates: { predicate_mask: 1, consent_dampener: 0.5, derivation_status: 0.5 },
    candidate: {
      memory_id: "b5",
      kind: "fact",
      ts: "2026-08-01T00:00:00.000Z",
      entities: [],
      valence: -0.3,
      features: { episodicity: 0.2, salience: { score: 0.64 } },
    },
    surrounding_context: ctx({
      valence: 0.1,
      time_anchor: "2026-08-01T06:00:00.000Z",
    }),
  },
];

// PINNED from the PRE-EDIT module. Do not regenerate from the current code:
// regenerating turns this gate into a tautology.
const PINNED_FINAL_SCORES = Object.freeze({
  "synthesis-path-high-episodicity": 0.7294952043203595,
  "synthesis-path-low-episodicity": 0.9719772043203597,
  "stub-path-no-candidate-episodicity": 0.9358520153345269,
  "stub-path-no-query-episodicity": 0.8510447012661925,
  "predicate-masked-multiplicative-zero": 1.8761344656120982,
  "synthesis-path-with-salience-and-anchor": 1.6307034072556235,
});

function scoreBaselines(env) {
  const out = {};
  for (const c of BASELINE_CASES) {
    const opts = env === undefined ? { now: FIXED_NOW } : { now: FIXED_NOW, env };
    out[c.label] = computeScore({
      s_emb_full3072: c.s_emb_full3072,
      gates: c.gates,
      candidate: c.candidate,
      surrounding_context: c.surrounding_context,
      opts,
    });
  }
  return out;
}

function finalScores(env) {
  const rows = scoreBaselines(env);
  const out = {};
  for (const k of Object.keys(rows)) out[k] = rows[k].final_score;
  return out;
}

// ---------------------------------------------------------------------------
// A — the slope. The multiplier FALLS as the candidate's episodicity RISES.
// ---------------------------------------------------------------------------
test("A: at q=0.1359 episodicityMatch is 1.1359-f and strictly decreasing", () => {
  const fs = [0.14, 0.2, 0.3, 0.4, 0.46];
  const got = fs.map((f) => synthesisEpisodicityMatch(f, QUERY_EPISODICITY));

  for (let i = 0; i < fs.length; i++) {
    const expected = 1 + QUERY_EPISODICITY - fs[i];
    assert.ok(
      Math.abs(got[i] - expected) <= 1e-12,
      `f=${fs[i]}: match ${got[i]} != ${expected} (|d|=${Math.abs(got[i] - expected)})`,
    );
  }
  for (let i = 1; i < got.length; i++) {
    assert.ok(
      got[i] < got[i - 1],
      `not strictly decreasing at f=${fs[i]}: ${got[i]} >= ${got[i - 1]}`,
    );
  }
  // The measured live envelope: [0.6759, 0.9959] over the stamped range.
  assert.ok(Math.abs(got[0] - 0.9959) <= 1e-12, `f=0.14 -> ${got[0]}`);
  assert.ok(Math.abs(got[4] - 0.6759) <= 1e-12, `f=0.46 -> ${got[4]}`);
});

// ---------------------------------------------------------------------------
// B — OFF by default. Only the exact string "1" may change a score.
// ---------------------------------------------------------------------------
test("B: flag unset / \"0\" / other values leave every score bit-identical", () => {
  // The fixtures must be immune to the entity feature: if this ever becomes
  // nonzero the pinned literals stop being portable across trees.
  const rows = scoreBaselines({});
  for (const k of Object.keys(rows)) {
    assert.equal(
      rows[k].entity_overlap_jaccard,
      0,
      `${k}: fixture leaked entity signal`,
    );
  }

  // (i) explicit empty env override — flag absent.
  assert.deepStrictEqual(finalScores({}), PINNED_FINAL_SCORES);

  // (ii) every non-"1" value, including the near-misses.
  for (const v of ["0", "", "true", "yes", "01", " 1", "1 ", "TRUE", "2"]) {
    assert.deepStrictEqual(
      finalScores({ [FLAG]: v }),
      PINNED_FINAL_SCORES,
      `flag=${JSON.stringify(v)} changed a score`,
    );
  }

  // (iii) the real process.env path, with the key deleted and then "0".
  const saved = Object.prototype.hasOwnProperty.call(process.env, FLAG)
    ? process.env[FLAG]
    : undefined;
  try {
    delete process.env[FLAG];
    assert.deepStrictEqual(finalScores(undefined), PINNED_FINAL_SCORES);
    process.env[FLAG] = "0";
    assert.deepStrictEqual(finalScores(undefined), PINNED_FINAL_SCORES);
  } finally {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  }
});

// ---------------------------------------------------------------------------
// C — ON. The breakdown reports the value actually multiplied in.
// ---------------------------------------------------------------------------
test("C: flag=\"1\" forces episodicity_match to the stub's 1.0", () => {
  const c = BASELINE_CASES[0]; // features.episodicity = 0.46, q = 0.1359
  assert.equal(c.candidate.features.episodicity, 0.46);
  assert.equal(c.surrounding_context.query_episodicity, QUERY_EPISODICITY);

  const off = computeScore({
    s_emb_full3072: c.s_emb_full3072,
    gates: c.gates,
    candidate: c.candidate,
    surrounding_context: c.surrounding_context,
    opts: { now: FIXED_NOW, env: {} },
  });
  // Proves the candidate provably took the SYNTHESIS path, not the stub path.
  assert.ok(
    Math.abs(off.episodicity_match - 0.6759) <= 1e-12,
    `raw episodicity_match was ${off.episodicity_match}, expected 0.6759`,
  );

  const on = computeScore({
    s_emb_full3072: c.s_emb_full3072,
    gates: c.gates,
    candidate: c.candidate,
    surrounding_context: c.surrounding_context,
    opts: { now: FIXED_NOW, env: { [FLAG]: "1" } },
  });
  assert.equal(on.episodicity_match, 1.0);

  // Observability contract: the breakdown value is the one multiplied in.
  // The multiplicative branch is s_emb * masks * episodicity_match, and every
  // gate here is 1, so removing the multiplier must add exactly
  // s_emb * (1 - raw) * salience_multiplier to final_score.
  const delta = on.final_score - off.final_score;
  const expected =
    c.s_emb_full3072 * (1 - off.episodicity_match) * off.salience_multiplier;
  assert.ok(
    Math.abs(delta - expected) <= 1e-12,
    `final_score delta ${delta} != ${expected}`,
  );

  // A stub-path candidate is already at 1.0 and must be untouched either way.
  const stub = BASELINE_CASES[2];
  const stubOn = computeScore({
    s_emb_full3072: stub.s_emb_full3072,
    gates: stub.gates,
    candidate: stub.candidate,
    surrounding_context: stub.surrounding_context,
    opts: { now: FIXED_NOW, env: { [FLAG]: "1" } },
  });
  assert.equal(
    stubOn.final_score,
    PINNED_FINAL_SCORES["stub-path-no-candidate-episodicity"],
  );
});

// ---------------------------------------------------------------------------
// D — the flag actually moves rank. 36 deterministic candidates, s_emb in a
//     narrow band so the multiplier can reorder them.
// ---------------------------------------------------------------------------
const CHURN_GATES = Object.freeze({
  predicate_mask: 1,
  consent_dampener: 1,
  derivation_status: 1,
});

function churnCandidates() {
  const out = [];
  for (let i = 0; i < 36; i++) {
    out.push({
      memory_id: "m" + String(i).padStart(2, "0"),
      kind: "fact",
      ts: "2026-07-01T00:00:00.000Z",
      entities: [],
      valence: null,
      features: { episodicity: 0.14 + (0.32 * (i % 12)) / 11 },
      _s_emb: 0.6 + 0.004 * ((i * 7) % 36),
    });
  }
  return out;
}

function rank(env) {
  const cands = churnCandidates();
  return cands
    .map((c) => {
      const r = computeScore({
        s_emb_full3072: c._s_emb,
        gates: CHURN_GATES,
        candidate: c,
        surrounding_context: ctx(),
        opts: { now: FIXED_NOW, env },
      });
      return { id: c.memory_id, score: r.final_score, em: r.episodicity_match };
    })
    .sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

test("D: top-12 churn between flag-OFF and flag-ON is > 0, and is deterministic", () => {
  const off = rank({});
  const on = rank({ [FLAG]: "1" });

  assert.equal(off.length, 36);
  assert.ok(
    off.every((r) => r.em > 0.6 && r.em < 1),
    "OFF ranking should be on the synthesis path for every candidate",
  );
  assert.ok(on.every((r) => r.em === 1.0), "ON ranking should be fully ablated");

  const top12Off = off.slice(0, 12).map((r) => r.id);
  const top12On = on.slice(0, 12).map((r) => r.id);
  const onSet = new Set(top12On);
  const setChurn = top12Off.filter((id) => !onSet.has(id)).length;
  const orderChurn = top12Off.filter((id, i) => id !== top12On[i]).length;

  assert.ok(
    setChurn > 0,
    `top-12 set churn was ${setChurn}; OFF=${top12Off.join(",")} ON=${top12On.join(",")}`,
  );
  assert.ok(orderChurn > 0, `top-12 order churn was ${orderChurn}`);

  // Determinism: no RNG, no wall-clock. A second pass must be identical.
  assert.deepStrictEqual(rank({}), off);
  assert.deepStrictEqual(rank({ [FLAG]: "1" }), on);

  console.log(
    `  top-12 set churn=${setChurn} order churn=${orderChurn}\n` +
      `  OFF: ${top12Off.join(",")}\n  ON : ${top12On.join(",")}`,
  );
});
