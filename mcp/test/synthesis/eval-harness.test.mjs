// eval-harness.test.mjs — coverage for the offline-eval harness
// (F-SYN-OPERATIONAL-offline-eval-harness, Wave 11).
//
// Spec assertions verified here (held-out-labeled-set.md):
//   § 6.1 Recall@12          — including abstain-correct = 1.0
//   § 6.2 MRR-expected       — rank-1 = 1.0, none-found = 0
//   § 6.3 NDCG@12 graded     — +2/+1/0/-2 schedule; NEGATIVE NDCG allowed
//   § 6.4 Abstain F1         — mixed labels, binary F1
//   § 6.5 Harm rate          — ANY forbidden in surfaced[:K] triggers
//   § 6.6 Paired bootstrap   — [p_lower, p_upper] tuple
//   § 11 invariant 8         — BOOTSTRAP_RESAMPLES = 10000 pinned
//   § 11 invariant 7         — NDCG never clipped to zero
//
// Run: node --test test/synthesis/eval-harness.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic env per project convention: set MEMORY_ROOT before dynamic
// import so any future module-init side effect lands in the sandbox.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-eval-harness-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
mkdirSync(MEMORY_ROOT, { recursive: true, mode: 0o700 });
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");

const mod = await import("../../lib/synthesis/eval-harness.js");
const {
  EVAL_HARNESS_VERSION,
  EVAL_CAPS,
  evaluate,
  recallAtKForPair,
  mrrExpectedForPair,
  ndcgAtKForPair,
  abstainF1ForPairs,
  harmRateForPairs,
  bootstrapCI,
} = mod;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function ensureDir(p) {
  mkdirSync(p, { recursive: true, mode: 0o700 });
}

function writeJsonl(path, rows) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
}

function recallRow({ id, surfaced, density_flag = "ok" }) {
  return {
    id,
    ts: "2026-06-01T00:00:00Z",
    kind: "recall",
    query: { surrounding_context_hash: "deadbeef", context_embedding: [], embedding_model_version: "test" },
    surfaced: (surfaced || []).map((mid, idx) => ({
      memory_id: mid,
      score: 1.0 - idx * 0.01,
      position: idx,
      propensity: 0.1,
      rerank_score: null,
    })),
    candidates_pre_truncation: [],
    density_flag,
    degraded_recall: false,
    degraded_recall_layer3: false,
  };
}

function labelRow({
  id, recallId, expected, forbidden = [], abstain = false,
}) {
  return {
    id,
    ts: "2026-06-02T00:00:00Z",
    kind: "held_out_label",
    provenance: { agent_id: "operator:test", conversation_id: null, confidence: 1.0 },
    derived_from: [recallId],
    payload: {
      label_set_version: "v1",
      expected_ids: expected,
      forbidden_ids: forbidden,
      abstain,
      labeled_at: "2026-06-02T00:00:00Z",
      strata: {
        agent_role: "coding",
        time_of_day_bucket: "afternoon",
        recent_recall_density_bucket: "medium",
        tz: "UTC",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// T1: surface + CAPS pin
// ---------------------------------------------------------------------------
test("EVAL_CAPS pinned per spec § 6 + § 11 invariants", () => {
  assert.equal(typeof EVAL_HARNESS_VERSION, "string");
  assert.ok(EVAL_HARNESS_VERSION.startsWith("eval-harness@"), "version tagged");
  assert.equal(EVAL_CAPS.K, 12, "K = 12 per § 6.1");
  assert.equal(EVAL_CAPS.BOOTSTRAP_RESAMPLES, 10000, "10k resamples per § 11 inv 8");
  assert.equal(EVAL_CAPS.CI_LEVEL, 0.90, "90% CI per § 6.6");
  assert.equal(EVAL_CAPS.GRADED_GAIN.expected, 2, "+2 expected");
  assert.equal(EVAL_CAPS.GRADED_GAIN.neighbor, 1, "+1 neighbor");
  assert.equal(EVAL_CAPS.GRADED_GAIN.filler, 0, "0 filler");
  assert.equal(EVAL_CAPS.GRADED_GAIN.forbidden, -2, "-2 forbidden (asymmetric harm)");
  assert.ok(Object.isFrozen(EVAL_CAPS), "EVAL_CAPS frozen");
  assert.ok(Object.isFrozen(EVAL_CAPS.GRADED_GAIN), "GRADED_GAIN frozen");
});

// ---------------------------------------------------------------------------
// T2: end-to-end evaluate() with fixture labels + recall
// ---------------------------------------------------------------------------
test("evaluate() produces metrics in [-2, 1] over a tiny fixture set", async () => {
  const ws = join(TMP_ROOT, "ws-e2e");
  ensureDir(ws);
  const labelsPath = join(ws, "labels.jsonl");
  const recallPath = join(ws, "recall.jsonl");

  const recalls = [
    recallRow({ id: "rec_a", surfaced: ["m1", "m2", "m3"] }),
    recallRow({ id: "rec_b", surfaced: ["m4", "m5", "m6"] }),
    recallRow({ id: "rec_c", surfaced: [], density_flag: "abstain_emit" }),
  ];
  const labels = [
    labelRow({ id: "lab_a", recallId: "rec_a", expected: ["m1"] }),
    labelRow({ id: "lab_b", recallId: "rec_b", expected: ["m4"], forbidden: ["m6"] }),
    labelRow({ id: "lab_c", recallId: "rec_c", expected: [], abstain: true }),
  ];
  writeJsonl(recallPath, recalls);
  writeJsonl(labelsPath, labels);

  const result = await evaluate({ labelsPath, recallLogPath: recallPath });

  // Metrics are real numbers, n_labels_used joins all three.
  assert.equal(result.n_labels_used, 3, "all three labels joined");
  assert.ok(Number.isFinite(result.recall_at_12), "recall@12 finite");
  assert.ok(Number.isFinite(result.mrr_expected), "mrr finite");
  assert.ok(Number.isFinite(result.ndcg_at_12), "ndcg finite");
  assert.ok(result.recall_at_12 >= 0 && result.recall_at_12 <= 1, "recall@12 in [0,1]");
  // mrr_expected mean over scoreable events (a, b): both rank-1 → 1.0.
  assert.equal(result.mrr_expected, 1.0, "MRR=1 when expected at rank 1 in both");
  // recall_at_12 mean over scoreable events (a=1, b=1, c=abstain-correct=1) → 1.
  assert.equal(result.recall_at_12, 1.0, "all expected found and abstain correct");
  // Harm rate: rec_b surfaces forbidden m6 → 1/3.
  assert.ok(result.harm_rate > 0, "harm rate > 0 because m6 surfaced");
  assert.equal(result.harm_rate, 1 / 3, "harm rate = 1/3 (b has m6)");
  // Bootstrap CI tuple shape.
  assert.ok(Array.isArray(result.bootstrap_ci.recall), "bootstrap_ci.recall is tuple");
  assert.equal(result.bootstrap_ci.recall.length, 2, "CI is [lo, hi]");
  assert.ok(typeof result.built_at === "string" && result.built_at.endsWith("Z"));
  assert.equal(result.version, EVAL_HARNESS_VERSION);
});

// ---------------------------------------------------------------------------
// T3: Recall@12 — all expected found → 1.0; none found → 0
// ---------------------------------------------------------------------------
test("Recall@12 = 1.0 when all expected surfaced; = 0 when none found", () => {
  const label = labelRow({ id: "x", recallId: "r", expected: ["m1", "m2"] });
  // All expected in surfaced.
  const allFound = recallAtKForPair(label, ["m1", "m2", "m9"]);
  assert.equal(allFound, 1.0, "all expected found → 1.0");
  // None found.
  const noneFound = recallAtKForPair(label, ["m99", "m100"]);
  assert.equal(noneFound, 0.0, "none found → 0");
  // Partial.
  const halfFound = recallAtKForPair(label, ["m1", "m99"]);
  assert.equal(halfFound, 0.5, "half found → 0.5");
});

// ---------------------------------------------------------------------------
// T4: MRR-expected — rank-1 = 1.0; rank-3 = 1/3; none-found = 0
// ---------------------------------------------------------------------------
test("MRR-expected = 1.0 at rank 1, 1/3 at rank 3, 0 when missing", () => {
  const label = labelRow({ id: "x", recallId: "r", expected: ["target"] });
  assert.equal(mrrExpectedForPair(label, ["target", "other"]), 1.0, "rank-1 → 1.0");
  assert.equal(mrrExpectedForPair(label, ["a", "b", "target"]), 1 / 3, "rank-3 → 1/3");
  assert.equal(mrrExpectedForPair(label, ["a", "b", "c"]), 0, "absent → 0");
  // No expected at all → excluded (null).
  const abstainLabel = labelRow({ id: "z", recallId: "r", expected: [], abstain: true });
  assert.equal(mrrExpectedForPair(abstainLabel, ["x"]), null, "no expected → null (excluded)");
});

// ---------------------------------------------------------------------------
// T5: NDCG@12 — negative gain on forbidden (spec § 11 invariant 7)
// ---------------------------------------------------------------------------
test("NDCG produces NEGATIVE values when forbidden_ids surface alone", () => {
  const label = labelRow({
    id: "harm", recallId: "r",
    expected: ["good"],
    forbidden: ["bad1", "bad2"],
  });
  // Surface only forbidden — DCG = -2/log2(2) + -2/log2(3) = very negative.
  // IDCG = 2/log2(2) = 2. NDCG = (negative) / 2 → negative.
  const ndcg = ndcgAtKForPair(label, ["bad1", "bad2"], null);
  assert.ok(ndcg !== null, "ndcg defined when expected_ids present");
  assert.ok(ndcg < 0, `NDCG must go negative when forbidden surface; got ${ndcg}`);
  // Positive case sanity: expected at rank 1 → NDCG = 1.0.
  const positive = ndcgAtKForPair(label, ["good"], null);
  assert.equal(positive, 1.0, "expected at rank 1 → NDCG = 1.0");
});

// ---------------------------------------------------------------------------
// T6: NDCG with neighbor (+1) gain via derivation graph
// ---------------------------------------------------------------------------
test("NDCG awards +1 gain to derivation-graph 1-neighbors of expected", () => {
  const label = labelRow({
    id: "nbr", recallId: "r",
    expected: ["target"],
    forbidden: [],
  });
  // derivation graph: "target" has neighbor "near" (forward parent or reverse child).
  const derivationGraph = {
    forwardAdj: new Map([
      ["target", new Set(["near"])],
    ]),
    reverseAdj: new Map([
      ["near", new Set(["target"])],
    ]),
  };
  // Surface only the neighbor at rank 1 — gain = +1.
  // DCG = 1 / log2(2) = 1.0.
  // IDCG = 2 / log2(2) + 1 / log2(3) = 2 + 0.6309… ≈ 2.6309.
  const ndcg = ndcgAtKForPair(label, ["near"], derivationGraph);
  assert.ok(ndcg !== null, "ndcg defined");
  assert.ok(ndcg > 0 && ndcg < 1, `neighbor-only gain → 0<NDCG<1; got ${ndcg}`);
  // Sanity: filler-only ranking → NDCG = 0.
  const filler = ndcgAtKForPair(label, ["unrelated"], derivationGraph);
  assert.equal(filler, 0, "filler-only → NDCG = 0");
});

// ---------------------------------------------------------------------------
// T7: Abstain F1 — mixed abstain / non-abstain labels
// ---------------------------------------------------------------------------
test("Abstain F1 correctly classifies TP/FP/FN/TN", () => {
  const pairs = [
    // TP: abstain label + abstain_emit ranker.
    {
      label: labelRow({ id: "tp", recallId: "r1", expected: [], abstain: true }),
      recall: recallRow({ id: "r1", surfaced: [], density_flag: "abstain_emit" }),
    },
    // FN: abstain label but ranker surfaced things.
    {
      label: labelRow({ id: "fn", recallId: "r2", expected: [], abstain: true }),
      recall: recallRow({ id: "r2", surfaced: ["m1"] }),
    },
    // FP: non-abstain label but empty brief (predicted abstain).
    {
      label: labelRow({ id: "fp", recallId: "r3", expected: ["m1"], abstain: false }),
      recall: recallRow({ id: "r3", surfaced: [] }),
    },
    // TN: non-abstain label, ranker surfaced things.
    {
      label: labelRow({ id: "tn", recallId: "r4", expected: ["m1"], abstain: false }),
      recall: recallRow({ id: "r4", surfaced: ["m1", "m2"] }),
    },
  ];
  const f1Result = abstainF1ForPairs(pairs);
  assert.equal(f1Result.tp, 1, "1 TP");
  assert.equal(f1Result.fn, 1, "1 FN");
  assert.equal(f1Result.fp, 1, "1 FP");
  assert.equal(f1Result.tn, 1, "1 TN");
  // precision = 1/2, recall = 1/2, f1 = 0.5.
  assert.equal(f1Result.precision, 0.5);
  assert.equal(f1Result.recall, 0.5);
  assert.equal(f1Result.f1, 0.5);
});

// ---------------------------------------------------------------------------
// T8: Harm rate — ANY forbidden in brief triggers (spec § 6.5)
// ---------------------------------------------------------------------------
test("Harm rate counts ANY forbidden_id in surfaced[:K]", () => {
  const pairs = [
    {
      label: labelRow({ id: "ha", recallId: "r1", expected: ["m1"], forbidden: ["bad"] }),
      recall: recallRow({ id: "r1", surfaced: ["m1", "bad"] }),
    },
    {
      label: labelRow({ id: "hb", recallId: "r2", expected: ["m1"], forbidden: ["bad2"] }),
      recall: recallRow({ id: "r2", surfaced: ["m1", "m2"] }), // no forbidden
    },
    {
      label: labelRow({ id: "hc", recallId: "r3", expected: ["m1"], forbidden: ["bad3"] }),
      recall: recallRow({ id: "r3", surfaced: ["bad3"] }),
    },
  ];
  const rate = harmRateForPairs(pairs);
  assert.equal(rate, 2 / 3, "2 of 3 had forbidden surfaced");
  // All-clean case → 0.
  const clean = [
    {
      label: labelRow({ id: "z", recallId: "r", expected: ["m1"], forbidden: ["bad"] }),
      recall: recallRow({ id: "r", surfaced: ["m1"] }),
    },
  ];
  assert.equal(harmRateForPairs(clean), 0, "no forbidden surfaced → 0");
  // No forbidden labels at all → 0.
  const noLabels = [
    {
      label: labelRow({ id: "z2", recallId: "r", expected: ["m1"] }),
      recall: recallRow({ id: "r", surfaced: ["m1", "m2"] }),
    },
  ];
  assert.equal(harmRateForPairs(noLabels), 0, "no forbidden labels → 0");
});

// ---------------------------------------------------------------------------
// T9: Paired bootstrap CI — returns tuple, deterministic, bounded
// ---------------------------------------------------------------------------
test("bootstrapCI returns [lo, hi] tuple with lo <= hi for any vector", () => {
  // Use a small resample count to keep the test fast; the prod default
  // (10000) is asserted via EVAL_CAPS.
  const values = [0.8, 0.9, 0.7, 1.0, 0.6, 0.85];
  const ci = bootstrapCI(values, { resamples: 200, level: 0.90 });
  assert.equal(ci.length, 2, "tuple shape");
  assert.ok(ci[0] <= ci[1], "lo <= hi");
  // Determinism: same input → same output (seeded RNG).
  const ci2 = bootstrapCI(values, { resamples: 200, level: 0.90 });
  assert.equal(ci[0], ci2[0], "deterministic lo");
  assert.equal(ci[1], ci2[1], "deterministic hi");
  // Empty vector → [0, 0].
  const empty = bootstrapCI([], { resamples: 200 });
  assert.deepEqual(empty, [0, 0], "empty vector → [0, 0]");
  // Null-only vector → [0, 0] (filtered out).
  const nullsOnly = bootstrapCI([null, null], { resamples: 200 });
  assert.deepEqual(nullsOnly, [0, 0], "nulls-only → [0, 0]");
});

// ---------------------------------------------------------------------------
// T10: missing labels file → evaluate() throws with EVAL_HARNESS_FILE_MISSING
// ---------------------------------------------------------------------------
test("evaluate() throws when labels file does not exist", async () => {
  const ws = join(TMP_ROOT, "ws-missing");
  ensureDir(ws);
  const labelsPath = join(ws, "does-not-exist.jsonl");
  const recallPath = join(ws, "recall.jsonl");
  writeJsonl(recallPath, []);
  await assert.rejects(
    () => evaluate({ labelsPath, recallLogPath: recallPath }),
    (err) => err.code === "EVAL_HARNESS_FILE_MISSING",
  );
  // Bad-args paths.
  await assert.rejects(() => evaluate({}), (e) => e.code === "EVAL_HARNESS_BAD_ARGS");
  await assert.rejects(
    () => evaluate({ labelsPath: "x" }),
    (e) => e.code === "EVAL_HARNESS_BAD_ARGS",
  );
});

// ---------------------------------------------------------------------------
// T11: Recall@12 = 0 when none surfaced
// ---------------------------------------------------------------------------
test("Recall@12 = 0 across the set when nothing surfaced", async () => {
  const ws = join(TMP_ROOT, "ws-noneFound");
  ensureDir(ws);
  const labelsPath = join(ws, "labels.jsonl");
  const recallPath = join(ws, "recall.jsonl");
  const recalls = [
    recallRow({ id: "r1", surfaced: ["xx", "yy"] }),
    recallRow({ id: "r2", surfaced: ["pp", "qq"] }),
  ];
  const labels = [
    labelRow({ id: "l1", recallId: "r1", expected: ["m1"] }),
    labelRow({ id: "l2", recallId: "r2", expected: ["m2"] }),
  ];
  writeJsonl(recallPath, recalls);
  writeJsonl(labelsPath, labels);
  const result = await evaluate({ labelsPath, recallLogPath: recallPath });
  assert.equal(result.recall_at_12, 0, "no expected found across set → 0");
  assert.equal(result.mrr_expected, 0, "no expected found → MRR 0");
  assert.equal(result.harm_rate, 0, "no forbidden labels → harm 0");
  assert.equal(result.n_labels_used, 2);
});

// ---------------------------------------------------------------------------
// T12: Corrupt label rows are silently skipped (defensive)
// ---------------------------------------------------------------------------
test("evaluate() drops corrupt JSONL lines without throwing", async () => {
  const ws = join(TMP_ROOT, "ws-corrupt");
  ensureDir(ws);
  const labelsPath = join(ws, "labels.jsonl");
  const recallPath = join(ws, "recall.jsonl");
  writeJsonl(recallPath, [recallRow({ id: "r1", surfaced: ["m1"] })]);
  // Mix of valid + garbage lines.
  const validLabel = labelRow({ id: "l1", recallId: "r1", expected: ["m1"] });
  writeFileSync(
    labelsPath,
    JSON.stringify(validLabel) + "\n" +
    "{not-json\n" +
    JSON.stringify(validLabel) + "\n",
    { mode: 0o600 },
  );
  const result = await evaluate({ labelsPath, recallLogPath: recallPath });
  // Two valid labels joined; one corrupt line dropped.
  assert.equal(result.n_labels_used, 2, "valid lines parsed; corrupt skipped");
  assert.equal(result.recall_at_12, 1.0, "all expected found");
});

// ---------------------------------------------------------------------------
// T13: derivation-graph absence is non-fatal (NDCG still computes)
// ---------------------------------------------------------------------------
test("NDCG without derivationGraph still computes (no +1 neighbor boost)", () => {
  const label = labelRow({ id: "noGraph", recallId: "r", expected: ["e1"], forbidden: [] });
  const ndcg = ndcgAtKForPair(label, ["e1", "filler"], null);
  // expected at rank 1 → NDCG = 1.0 since IDCG = +2/log2(2) = 2,
  // DCG = +2/log2(2) = 2.
  assert.equal(ndcg, 1.0, "expected at rank-1 → 1.0 regardless of graph");
});
