// eval-failure-rate.test.mjs — WU2-eval-harness-failure-rate (Phase 0).
//
// Tests the Top-K failure-rate metric that gates every contextual-retrieval
// tier (mcp/lib/recall/eval-failure-rate.js). The metric is the Anthropic-
// comparable primary axis: fraction of gold queries whose golden_fact_id is not
// in the top-K of the retrieval result.
//
// HERMETICITY: pure unit test over a SYNTHETIC goldset + synthetic recallFn.
// Touches no ledger, no index, no fs, no network, no env. Deterministic.
//
// Run: node test/recall/eval-failure-rate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeFailureRate,
  FAILURE_RATE_CAPS,
  EVAL_FAILURE_RATE_VERSION,
  _internals,
} from "../../lib/recall/eval-failure-rate.js";

// ---------------------------------------------------------------------------
// Synthetic goldset: 10 queries across the three strata. The recallFn is a
// lookup table whose rankings we control exactly, so the expected failure rate
// is computable by hand.
// ---------------------------------------------------------------------------
function makeGoldset() {
  return [
    { query: "q1", golden_fact_id: "g1", stratum: "whole_fact_entity" },
    { query: "q2", golden_fact_id: "g2", stratum: "whole_fact_entity" },
    { query: "q3", golden_fact_id: "g3", stratum: "whole_fact_entity" },
    { query: "q4", golden_fact_id: "g4", stratum: "whole_fact_general" },
    { query: "q5", golden_fact_id: "g5", stratum: "whole_fact_general" },
    { query: "q6", golden_fact_id: "g6", stratum: "whole_fact_general" },
    { query: "q7", golden_fact_id: "g7", stratum: "whole_fact_general" },
    { query: "q8", golden_fact_id: "g8", stratum: "giant_internal" },
    { query: "q9", golden_fact_id: "g9", stratum: "giant_internal" },
    { query: "q10", golden_fact_id: "g10", stratum: "giant_internal" },
  ];
}

// A ranking table: query -> ordered memory_id[] (best first). We construct it so
// that a known subset of goldens fall outside top-20.
//   - q1..q5: golden at rank 0 (always a hit)
//   - q6:     golden at rank 4 (hit@5, hit@10, hit@20)
//   - q7:     golden at rank 9 (miss@5, hit@10, hit@20)
//   - q8:     golden at rank 19 (miss@5, miss@10, hit@20)
//   - q9:     golden at rank 25 (miss everywhere — outside top-20 => FAILURE)
//   - q10:    golden absent entirely (FAILURE)
function makeFusedRanking() {
  const table = new Map();
  const filler = (n, exclude) => {
    const out = [];
    let i = 0;
    while (out.length < n) {
      const id = `x${i++}`;
      if (id !== exclude) out.push(id);
    }
    return out;
  };
  const place = (golden, rank) => {
    const arr = filler(30, golden);
    if (rank >= 0) arr.splice(rank, 0, golden);
    return arr.slice(0, 30);
  };
  table.set("q1", place("g1", 0));
  table.set("q2", place("g2", 0));
  table.set("q3", place("g3", 0));
  table.set("q4", place("g4", 0));
  table.set("q5", place("g5", 0));
  table.set("q6", place("g6", 4));
  table.set("q7", place("g7", 9));
  table.set("q8", place("g8", 19));
  table.set("q9", place("g9", 25));
  table.set("q10", filler(30, "g10")); // golden absent
  return table;
}

// ===========================================================================
// 1. Primary metric: top-20 failure rate over the synthetic table.
// ===========================================================================
test("top-20 failure rate is computed exactly", async () => {
  const goldset = makeGoldset();
  const table = makeFusedRanking();
  const recallFn = (q) => table.get(q) || [];
  const m = await computeFailureRate({ goldset, recallFn, k: 20 });

  // 10 queries; q9 (rank 25) + q10 (absent) are outside top-20 => 2 failures.
  assert.equal(m.n_total, 10);
  assert.equal(m.skipped, 0);
  assert.equal(m.errors, 0);
  assert.ok(Math.abs(m.top_k_failure_rate - 0.2) < 1e-9, `expected 0.2 got ${m.top_k_failure_rate}`);
});

// ===========================================================================
// 2. recall@5 / recall@10 / recall@20 cutoffs.
// ===========================================================================
test("recall@k cutoffs are computed exactly", async () => {
  const goldset = makeGoldset();
  const table = makeFusedRanking();
  const recallFn = (q) => table.get(q) || [];
  const m = await computeFailureRate({ goldset, recallFn, k: 20 });

  // hits@5: q1..q5 (rank0) + q6 (rank4) = 6 / 10 = 0.6
  assert.ok(Math.abs(m.recall_at_5 - 0.6) < 1e-9, `recall@5 ${m.recall_at_5}`);
  // hits@10: above 6 + q7 (rank9) = 7 / 10 = 0.7
  assert.ok(Math.abs(m.recall_at_10 - 0.7) < 1e-9, `recall@10 ${m.recall_at_10}`);
  // hits@20: above 7 + q8 (rank19) = 8 / 10 = 0.8
  assert.ok(Math.abs(m.recall_at_20 - 0.8) < 1e-9, `recall@20 ${m.recall_at_20}`);
  // failure@20 == 1 - recall@20.
  assert.ok(Math.abs(m.top_k_failure_rate - (1 - m.recall_at_20)) < 1e-9);
});

// ===========================================================================
// 3. Per-stratum attribution.
// ===========================================================================
test("per-stratum failure rates partition the goldset", async () => {
  const goldset = makeGoldset();
  const table = makeFusedRanking();
  const recallFn = (q) => table.get(q) || [];
  const m = await computeFailureRate({ goldset, recallFn, k: 20 });

  assert.ok(m.per_stratum.whole_fact_entity, "entity stratum present");
  assert.ok(m.per_stratum.whole_fact_general, "general stratum present");
  assert.ok(m.per_stratum.giant_internal, "giant stratum present");

  // entity: q1,q2,q3 all rank0 → 0 failures.
  assert.equal(m.per_stratum.whole_fact_entity.n, 3);
  assert.equal(m.per_stratum.whole_fact_entity.top_k_failure_rate, 0);

  // general: q4,q5,q6,q7 all within top-20 → 0 failures.
  assert.equal(m.per_stratum.whole_fact_general.n, 4);
  assert.equal(m.per_stratum.whole_fact_general.top_k_failure_rate, 0);

  // giant: q8 (rank19,hit) + q9 (rank25,miss) + q10 (absent,miss) → 2/3 fail.
  assert.equal(m.per_stratum.giant_internal.n, 3);
  assert.ok(Math.abs(m.per_stratum.giant_internal.top_k_failure_rate - (2 / 3)) < 1e-9);

  // The stratum n's sum to the total.
  const sumN = m.per_stratum.whole_fact_entity.n +
    m.per_stratum.whole_fact_general.n +
    m.per_stratum.giant_internal.n;
  assert.equal(sumN, m.n_total);
});

// ===========================================================================
// 4. Golden-not-found is a failure (not an error / not skipped).
// ===========================================================================
test("golden absent from results counts as a top-k failure", async () => {
  const goldset = [
    { query: "qa", golden_fact_id: "ga", stratum: "whole_fact_general" },
    { query: "qb", golden_fact_id: "gb", stratum: "whole_fact_general" },
  ];
  // qa: golden present at rank 0; qb: golden absent.
  const recallFn = (q) => (q === "qa" ? ["ga", "z1", "z2"] : ["z1", "z2", "z3"]);
  const m = await computeFailureRate({ goldset, recallFn, k: 20 });
  assert.equal(m.n_total, 2);
  assert.equal(m.errors, 0);
  assert.equal(m.skipped, 0);
  assert.ok(Math.abs(m.top_k_failure_rate - 0.5) < 1e-9, `failure ${m.top_k_failure_rate}`);
});

// ===========================================================================
// 5. Per-leg separation: bm25-only vs dense-only vs fused attributed apart.
// ===========================================================================
test("per-leg separation attributes each retrieval leg independently", async () => {
  const goldset = [
    { query: "p1", golden_fact_id: "h1", stratum: "whole_fact_entity" },
    { query: "p2", golden_fact_id: "h2", stratum: "whole_fact_general" },
  ];
  // bm25 finds h1 (rank0) but misses h2. dense finds h2 (rank0) but misses h1.
  // fused finds both. This is the canonical "attribute the win" case.
  const recallFn = (q) => {
    if (q === "p1") {
      return { bm25: ["h1", "a", "b"], dense: ["c", "d", "e"], fused: ["h1", "c", "d"] };
    }
    return { bm25: ["a", "b", "c"], dense: ["h2", "x", "y"], fused: ["h2", "a", "b"] };
  };
  const m = await computeFailureRate({ goldset, recallFn, k: 20 });

  assert.ok(m.per_leg.bm25, "bm25 leg present");
  assert.ok(m.per_leg.dense, "dense leg present");
  assert.ok(m.per_leg.fused, "fused leg present");

  // bm25 alone: hits p1, misses p2 → 0.5 failure.
  assert.ok(Math.abs(m.per_leg.bm25.top_k_failure_rate - 0.5) < 1e-9, `bm25 ${m.per_leg.bm25.top_k_failure_rate}`);
  // dense alone: misses p1, hits p2 → 0.5 failure.
  assert.ok(Math.abs(m.per_leg.dense.top_k_failure_rate - 0.5) < 1e-9, `dense ${m.per_leg.dense.top_k_failure_rate}`);
  // fused: both hits → 0 failure. This is the attributable win.
  assert.equal(m.per_leg.fused.top_k_failure_rate, 0);
  // Top-level headline uses the fused leg.
  assert.equal(m.primary_leg, "fused");
  assert.equal(m.top_k_failure_rate, 0);
});

// ===========================================================================
// 6. Anthropic-comparable framing: 5.7% -> 2.9% reproduction.
// ===========================================================================
test("reproduces an Anthropic-style failure-rate delta across two arms", async () => {
  // 1000 queries. Baseline arm misses 57 (5.7%); contextual arm misses 29 (2.9%).
  const N = 1000;
  const goldset = [];
  for (let i = 0; i < N; i++) {
    goldset.push({ query: `aq${i}`, golden_fact_id: `ag${i}`, stratum: "whole_fact_general" });
  }
  const baselineMisses = new Set();
  for (let i = 0; i < 57; i++) baselineMisses.add(`aq${i}`);
  const contextualMisses = new Set();
  for (let i = 0; i < 29; i++) contextualMisses.add(`aq${i}`);

  const idxOf = (q) => Number(q.slice(2));
  const baselineFn = (q) => (baselineMisses.has(q) ? ["junk"] : [`ag${idxOf(q)}`]);
  const contextualFn = (q) => (contextualMisses.has(q) ? ["junk"] : [`ag${idxOf(q)}`]);

  const base = await computeFailureRate({ goldset, recallFn: baselineFn, k: 20 });
  const ctx = await computeFailureRate({ goldset, recallFn: contextualFn, k: 20 });

  assert.ok(Math.abs(base.top_k_failure_rate - 0.057) < 1e-9, `baseline ${base.top_k_failure_rate}`);
  assert.ok(Math.abs(ctx.top_k_failure_rate - 0.029) < 1e-9, `contextual ${ctx.top_k_failure_rate}`);
  // The improvement (the thing the gate measures).
  assert.ok(base.top_k_failure_rate > ctx.top_k_failure_rate, "contextual must reduce failure rate");
});

// ===========================================================================
// 7. recallFn that throws on a query → that query is a failure, recorded.
// ===========================================================================
test("a throwing recallFn counts the query as a failure and records the error", async () => {
  const goldset = [
    { query: "ok", golden_fact_id: "g_ok", stratum: "whole_fact_general" },
    { query: "boom", golden_fact_id: "g_boom", stratum: "whole_fact_general" },
  ];
  const recallFn = (q) => {
    if (q === "boom") throw new Error("synthetic retrieval failure");
    return ["g_ok"];
  };
  const m = await computeFailureRate({ goldset, recallFn, k: 20 });
  assert.equal(m.n_total, 2);
  assert.equal(m.errors, 1);
  assert.ok(Math.abs(m.top_k_failure_rate - 0.5) < 1e-9, `failure ${m.top_k_failure_rate}`);
});

// ===========================================================================
// 8. Malformed gold rows are skipped, not counted.
// ===========================================================================
test("malformed gold rows are skipped and excluded from n_total", async () => {
  const goldset = [
    { query: "good", golden_fact_id: "gg", stratum: "whole_fact_entity" },
    { query: "", golden_fact_id: "gx", stratum: "whole_fact_entity" }, // empty query
    { golden_fact_id: "gy", stratum: "whole_fact_entity" },            // no query
    { query: "noid", stratum: "whole_fact_entity" },                  // no golden
    { kind: "contextual_eval_goldset_meta", counts: {} },             // header row
    null,                                                              // junk
  ];
  const recallFn = () => ["gg"];
  const m = await computeFailureRate({ goldset, recallFn, k: 20 });
  assert.equal(m.n_total, 1, "only the one well-formed row counts");
  assert.equal(m.skipped, 4, "four malformed rows skipped (header is ignored, not skipped)");
  assert.equal(m.top_k_failure_rate, 0);
});

// ===========================================================================
// 9. Array and object recallFn return shapes both work.
// ===========================================================================
test("recallFn array form and {memory_id} object form coerce identically", async () => {
  const goldset = [{ query: "z", golden_fact_id: "zz", stratum: "whole_fact_general" }];
  const arrForm = await computeFailureRate({ goldset, recallFn: () => ["a", "zz", "b"], k: 20 });
  const objForm = await computeFailureRate({
    goldset,
    recallFn: () => [{ memory_id: "a" }, { memory_id: "zz" }, { memory_id: "b" }],
    k: 20,
  });
  assert.equal(arrForm.top_k_failure_rate, 0);
  assert.equal(objForm.top_k_failure_rate, 0);
  // Array form populates the implicit "fused" leg.
  assert.ok(arrForm.per_leg.fused, "array form creates a fused leg");
  assert.equal(arrForm.primary_leg, "fused");
});

// ===========================================================================
// 10. K parameter is honored (different cutoff changes the failure rate).
// ===========================================================================
test("the K cutoff parameter changes the primary failure rate", async () => {
  // golden at rank 7: a failure at k=5, a hit at k=20.
  const goldset = [{ query: "qk", golden_fact_id: "gk", stratum: "whole_fact_general" }];
  const ranking = ["a", "b", "c", "d", "e", "f", "g", "gk", "h"]; // gk at index 7
  const recallFn = () => ranking;
  const atK5 = await computeFailureRate({ goldset, recallFn, k: 5 });
  const atK20 = await computeFailureRate({ goldset, recallFn, k: 20 });
  assert.equal(atK5.top_k_failure_rate, 1, "rank 7 is a failure at k=5");
  assert.equal(atK20.top_k_failure_rate, 0, "rank 7 is a hit at k=20");
});

// ===========================================================================
// 11. Empty goldset → well-defined zeros, no throw.
// ===========================================================================
test("empty goldset returns zeroed metrics without throwing", async () => {
  const m = await computeFailureRate({ goldset: [], recallFn: () => [], k: 20 });
  assert.equal(m.n_total, 0);
  assert.equal(m.top_k_failure_rate, 0);
  assert.equal(m.recall_at_20, 0);
  assert.deepEqual(m.per_stratum, {});
});

// ===========================================================================
// 12. Bad-args guards and CAPS pinning.
// ===========================================================================
test("bad args throw typed errors and CAPS are pinned", async () => {
  await assert.rejects(
    () => computeFailureRate({ goldset: "notarray", recallFn: () => [] }),
    (e) => e.code === "EVAL_FAILURE_RATE_BAD_ARGS",
  );
  await assert.rejects(
    () => computeFailureRate({ goldset: [], recallFn: null }),
    (e) => e.code === "EVAL_FAILURE_RATE_BAD_ARGS",
  );
  assert.equal(FAILURE_RATE_CAPS.PRIMARY_K, 20, "primary K must match Anthropic's operating point");
  assert.deepEqual([...FAILURE_RATE_CAPS.RECALL_KS], [5, 10, 20]);
  assert.equal(typeof EVAL_FAILURE_RATE_VERSION, "string");
});

// ===========================================================================
// 13. Internal coercion helpers: dedupe + drop non-strings.
// ===========================================================================
test("_internals.toOrderedIds dedupes and drops non-strings (first rank wins)", () => {
  const ids = _internals.toOrderedIds(["a", "b", "a", null, 7, { memory_id: "c" }, { id: "d" }, "b"]);
  assert.deepEqual(ids, ["a", "b", "c", "d"]);
  // rankOf finds first occurrence.
  assert.equal(_internals.rankOf("c", ids), 2);
  assert.equal(_internals.rankOf("zzz", ids), -1);
});

// ===========================================================================
// 14. per_stratum carries an inner per_leg breakdown (attribution survives slicing).
// ===========================================================================
test("per_stratum exposes an inner per_leg breakdown", async () => {
  const goldset = [
    { query: "e1", golden_fact_id: "he1", stratum: "whole_fact_entity" },
    { query: "g1", golden_fact_id: "hg1", stratum: "whole_fact_general" },
  ];
  const recallFn = (q) => {
    if (q === "e1") return { bm25: ["he1"], dense: [], fused: ["he1"] };
    return { bm25: [], dense: ["hg1"], fused: ["hg1"] };
  };
  const m = await computeFailureRate({ goldset, recallFn, k: 20 });
  // entity stratum: bm25 hits, dense misses.
  assert.ok(m.per_stratum.whole_fact_entity.per_leg, "entity stratum has per_leg");
  assert.equal(m.per_stratum.whole_fact_entity.per_leg.bm25.top_k_failure_rate, 0);
  assert.equal(m.per_stratum.whole_fact_entity.per_leg.dense.top_k_failure_rate, 1);
  // general stratum: dense hits, bm25 misses.
  assert.equal(m.per_stratum.whole_fact_general.per_leg.dense.top_k_failure_rate, 0);
  assert.equal(m.per_stratum.whole_fact_general.per_leg.bm25.top_k_failure_rate, 1);
});
