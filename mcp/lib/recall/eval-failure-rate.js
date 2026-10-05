// eval-failure-rate.js — WU2-eval-harness-failure-rate (Phase 0).
//
// The contextual-retrieval gate metric. This is the ONLY computer of the
// "Top-K failure rate" that gates every contextual-retrieval tier, framed to
// match Anthropic's Contextual Retrieval writeup so the numbers are directly
// comparable:
//
//   Anthropic reported "top-20-chunk retrieval failure rate" dropping
//   5.7% -> 2.9% when contextual embeddings + contextual BM25 were added,
//   and 2.9% -> 1.9% with a reranker. We compute the SAME primary metric:
//   the fraction of gold queries whose golden_fact_id is NOT in the top-K
//   (K=20) of the retrieval result. Lower is better. This module makes our
//   tiers measurable on the identical axis.
//
// PRIMARY METRIC
//   top_k_failure_rate = |{ q : golden(q) ∉ topK(recall(q)) }| / |goldset|
//   (K defaults to 20 — Anthropic's operating point.)
//
// SECONDARY (diagnostic) METRICS
//   recall_at_5 / recall_at_10 / recall_at_20 = fraction of gold queries whose
//   golden is within the top-{5,10,20}. (Single-golden-per-query, so recall@k
//   here is the hit-rate@k = 1 - failure_rate@k.)
//
// ATTRIBUTION
//   per_stratum : the same metrics sliced by gold stratum. The set of strata is
//                 NOT enumerated here — this metric partitions per_stratum
//                 DYNAMICALLY off each gold row's `stratum` field, and a row
//                 with no usable stratum lands in "unspecified". The generator
//                 (mcp/scripts/build-contextual-eval-goldset.mjs) is what
//                 decides which families exist, and it currently emits four,
//                 including semantic_paraphrase — the headroom stratum a frozen
//                 three-name list here silently denied. Slicing an open set is
//                 the point: we can see WHICH probe family a tier helps without
//                 this module having to be taught the family first.
//   per_leg     : the same metrics computed independently for each retrieval
//                 leg the recallFn exposes (bm25 | dense | fused) so we can
//                 attribute the win to the sparse leg, the dense leg, or the
//                 fusion — exactly the BM25-only vs contextual-BM25 vs fused
//                 decomposition Anthropic's ablation reports.
//
// recallFn CONTRACT
//   recallFn(query) -> either
//     (a) an ORDERED array of memory_ids (strings), highest-rank first; OR
//     (b) an ORDERED array of { memory_id } objects; OR
//     (c) an object whose keys are leg names and whose values are ordered
//         arrays as in (a)/(b):  { bm25: [...], dense: [...], fused: [...] }.
//   Form (c) drives per_leg. Forms (a)/(b) populate a single implicit "fused"
//   leg. recallFn may be async (returns a Promise); we await it.
//
// DEFENSIVE DISCIPLINE
//   - A recallFn that throws on one query does NOT poison the run: that query
//     is counted as a FAILURE for every leg (a leg that errors retrieved
//     nothing), and the error is recorded in `errors`.
//   - Malformed gold rows (missing query / golden_fact_id) are skipped and
//     counted in `skipped`.
//   - All ranking inputs are coerced to a flat memory_id[] defensively; nulls,
//     non-strings, and duplicates are dropped (first occurrence wins for rank).
//
// THESIS #1: pure computation over derived projections. Never mutates a fact
// row; never touches the ledger. Given the same (goldset, recallFn) it returns
// identical metrics.

export const EVAL_FAILURE_RATE_VERSION = "eval-failure-rate@1.0.0";

// The Anthropic-comparable operating point. K=20 is the primary gate; 5 and 10
// are the standard diagnostic cutoffs. Frozen so downstream gates pin them.
export const FAILURE_RATE_CAPS = Object.freeze({
  PRIMARY_K: 20,
  RECALL_KS: Object.freeze([5, 10, 20]),
});

// ---------------------------------------------------------------------------
// Coercion: turn whatever a leg returned into an ordered memory_id[].
// ---------------------------------------------------------------------------
function toOrderedIds(result) {
  if (!Array.isArray(result)) return [];
  const out = [];
  const seen = new Set();
  for (const item of result) {
    let id = null;
    if (typeof item === "string") id = item;
    else if (item && typeof item === "object") {
      if (typeof item.memory_id === "string") id = item.memory_id;
      else if (typeof item.id === "string") id = item.id;
    }
    if (id == null || id.length === 0) continue;
    if (seen.has(id)) continue; // keep first (best) rank only
    seen.add(id);
    out.push(id);
  }
  return out;
}

// Normalize a recallFn return value into a { legName -> orderedIds[] } map.
// Array form → a single implicit "fused" leg.
function toLegMap(result) {
  if (Array.isArray(result)) {
    return { fused: toOrderedIds(result) };
  }
  if (result && typeof result === "object") {
    const legs = {};
    for (const [leg, val] of Object.entries(result)) {
      if (typeof leg !== "string" || leg.length === 0) continue;
      legs[leg] = toOrderedIds(val);
    }
    return legs;
  }
  return { fused: [] };
}

// rankOf(goldenId, orderedIds) → 0-indexed rank, or -1 if absent.
function rankOf(goldenId, orderedIds) {
  for (let i = 0; i < orderedIds.length; i++) {
    if (orderedIds[i] === goldenId) return i;
  }
  return -1;
}

// Build the zeroed accumulator for one slice (a leg, a stratum, or overall).
function newAccumulator() {
  return {
    n: 0,
    // hits@k counts (golden within top-k, 0-indexed rank < k)
    hits: { 5: 0, 10: 0, 20: 0 },
  };
}

function tallyRank(acc, rank) {
  acc.n += 1;
  if (rank < 0) return; // miss everywhere
  for (const k of FAILURE_RATE_CAPS.RECALL_KS) {
    if (rank < k) acc.hits[k] += 1;
  }
}

// Materialize an accumulator into the reported metric block.
function finalize(acc, primaryK = FAILURE_RATE_CAPS.PRIMARY_K) {
  const n = acc.n;
  const recall_at = {};
  for (const k of FAILURE_RATE_CAPS.RECALL_KS) {
    recall_at[k] = n === 0 ? 0 : acc.hits[k] / n;
  }
  const top_k_failure_rate = n === 0 ? 0 : 1 - (acc.hits[primaryK] ?? 0) / n;
  return {
    n,
    top_k_failure_rate,
    recall_at_5: recall_at[5],
    recall_at_10: recall_at[10],
    recall_at_20: recall_at[20],
  };
}

/**
 * Compute the Top-K failure rate (and diagnostic recall@k) over a gold query
 * set, with per-stratum and per-leg attribution.
 *
 * @param {object} opts
 * @param {Array<{query: string, golden_fact_id: string, stratum?: string}>} opts.goldset
 *        The gold query set. Rows missing `query` or `golden_fact_id` are
 *        skipped (counted in `skipped`). A leading meta row
 *        (kind === "contextual_eval_goldset_meta") is ignored.
 * @param {(query: string) => (string[] | {memory_id:string}[] | Record<string, string[]>) | Promise<...>}
 *        opts.recallFn
 *        Retrieval function. See module header for the return contract. May be
 *        async.
 * @param {number} [opts.k=20] Primary failure-rate cutoff (Anthropic = 20).
 * @returns {Promise<{
 *   version: string,
 *   k: number,
 *   n_total: number,
 *   skipped: number,
 *   errors: number,
 *   top_k_failure_rate: number,
 *   recall_at_5: number,
 *   recall_at_10: number,
 *   recall_at_20: number,
 *   per_stratum: Record<string, object>,
 *   per_leg: Record<string, object>,
 * }>}
 */
export async function computeFailureRate({ goldset, recallFn, k = FAILURE_RATE_CAPS.PRIMARY_K } = {}) {
  if (!Array.isArray(goldset)) {
    const e = new Error("computeFailureRate: goldset must be an array");
    e.code = "EVAL_FAILURE_RATE_BAD_ARGS";
    throw e;
  }
  if (typeof recallFn !== "function") {
    const e = new Error("computeFailureRate: recallFn must be a function");
    e.code = "EVAL_FAILURE_RATE_BAD_ARGS";
    throw e;
  }
  const primaryK = Number.isInteger(k) && k > 0 ? k : FAILURE_RATE_CAPS.PRIMARY_K;

  // Overall accumulator is keyed per-leg (so the top-level numbers are reported
  // for the "fused"/primary leg below); we keep one accumulator per (leg) and
  // per (leg, stratum). The discovered leg set grows as we observe recallFn
  // outputs — but a query that errors must still be tallied as a miss for every
  // leg we have seen, so we re-tally known legs lazily.
  const legAcc = new Map();              // leg -> accumulator
  const legStratumAcc = new Map();       // `${leg}\u0000${stratum}` -> accumulator

  function legAccFor(leg) {
    let a = legAcc.get(leg);
    if (!a) { a = newAccumulator(); legAcc.set(leg, a); }
    return a;
  }
  function legStratumAccFor(leg, stratum) {
    const key = `${leg}\u0000${stratum}`;
    let a = legStratumAcc.get(key);
    if (!a) { a = newAccumulator(); legStratumAcc.set(key, a); }
    return a;
  }

  let n_total = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of goldset) {
    if (row == null || typeof row !== "object") { skipped += 1; continue; }
    if (row.kind === "contextual_eval_goldset_meta") continue; // header row
    const query = row.query;
    const golden = row.golden_fact_id;
    if (typeof query !== "string" || query.length === 0 ||
        typeof golden !== "string" || golden.length === 0) {
      skipped += 1;
      continue;
    }
    const stratum = typeof row.stratum === "string" && row.stratum.length > 0
      ? row.stratum
      : "unspecified";

    n_total += 1;

    let legMap;
    let errored = false;
    try {
      const result = await recallFn(query);
      legMap = toLegMap(result);
    } catch (_e) {
      errored = true;
      errors += 1;
      legMap = null;
    }

    if (errored || legMap == null) {
      // Error → miss for every leg observed so far (and the implicit fused leg
      // so the metric is well-defined even if this is the first row).
      const legs = legAcc.size > 0 ? [...legAcc.keys()] : ["fused"];
      for (const leg of legs) {
        tallyRank(legAccFor(leg), -1);
        tallyRank(legStratumAccFor(leg, stratum), -1);
      }
      continue;
    }

    const legNames = Object.keys(legMap);
    const effectiveLegs = legNames.length > 0 ? legNames : ["fused"];
    for (const leg of effectiveLegs) {
      const ids = legMap[leg] || [];
      const rank = rankOf(golden, ids);
      tallyRank(legAccFor(leg), rank);
      tallyRank(legStratumAccFor(leg, stratum), rank);
    }
  }

  // Choose the "primary" leg for the top-level numbers: prefer "fused", else
  // the single leg present, else the first leg discovered. (Anthropic's headline
  // number is the fused/full-pipeline failure rate.)
  let primaryLeg = "fused";
  if (!legAcc.has("fused")) {
    const keys = [...legAcc.keys()];
    primaryLeg = keys.length === 1 ? keys[0] : (keys[0] ?? "fused");
  }
  const primaryFinal = finalize(legAccFor(primaryLeg), primaryK);

  // per_leg block.
  const per_leg = {};
  for (const [leg, acc] of legAcc.entries()) {
    per_leg[leg] = finalize(acc, primaryK);
  }

  // per_stratum block — computed against the PRIMARY leg (the headline slice),
  // plus an inner per-leg breakdown so attribution survives the slice.
  const per_stratum = {};
  const strataSeen = new Set();
  for (const key of legStratumAcc.keys()) {
    strataSeen.add(key.split("\u0000")[1]);
  }
  for (const stratum of strataSeen) {
    const primAcc = legStratumAcc.get(`${primaryLeg}\u0000${stratum}`);
    const block = primAcc ? finalize(primAcc, primaryK) : { n: 0, top_k_failure_rate: 0, recall_at_5: 0, recall_at_10: 0, recall_at_20: 0 };
    const byLeg = {};
    for (const leg of legAcc.keys()) {
      const a = legStratumAcc.get(`${leg}\u0000${stratum}`);
      if (a) byLeg[leg] = finalize(a, primaryK);
    }
    block.per_leg = byLeg;
    per_stratum[stratum] = block;
  }

  return {
    version: EVAL_FAILURE_RATE_VERSION,
    k: primaryK,
    primary_leg: primaryLeg,
    n_total,
    skipped,
    errors,
    top_k_failure_rate: primaryFinal.top_k_failure_rate,
    recall_at_5: primaryFinal.recall_at_5,
    recall_at_10: primaryFinal.recall_at_10,
    recall_at_20: primaryFinal.recall_at_20,
    per_stratum,
    per_leg,
  };
}

// Test/diagnostic exports.
export const _internals = { toOrderedIds, toLegMap, rankOf, finalize, tallyRank, newAccumulator };
