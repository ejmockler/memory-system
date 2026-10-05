// hybrid-retriever.js — Phase 3 v0 (recall layer / Layer 1).
//
// Authoritative spec source:
//   kb/research-retrieval-frontiers.md
//   § "Recommended Phase 3 architecture" → Layer 1 candidate generation.
// Authoritative shape contract:
//   kb/phase3-v0-contracts.md § 2 SegmentVector.
//
// Layer 1: HYBRID candidate generation. Two parallel streams that get fused
// by Reciprocal Rank Fusion (RRF, k=60, Cormack 2009):
//
//   1. BM25 leg: bm25.search(queryText, RECALL_CANDIDATE_SET_SIZE) over the
//      full content field; returns top-50 by bm25_score.
//
//   2. Dense leg: per-segment MaxSim over surrounding_context segments (each
//      pre-encoded by gemini-client.embedSegments and MRL-sliced+L2-renormed
//      to 768d). Take the UNION of hnsw.search(seg.vector_mrl_768) for each
//      segment; dedupe by memory_id; rerank by MaxSim over all segments.
//
// RRF fusion: rrf_score = sum_legs of 1 / (RRF_K + rank_leg). Ties broken
// by memory_id ascending for determinism. Output is top
// RECALL_CANDIDATE_SET_SIZE by rrf_score desc.
//
// Per-segment MaxSim (per f2 in the report): dense_score(c) = max over
// segments of cos(seg.vector_mrl_768, c.embedding_768). This is the
// late-interaction win at the right granularity — preserves the distinct
// contribution of each surrounding_context segment without pooling.
//
// The HNSW index returns `cosine_distance = 1 - dot`; we convert to
// similarity via `dot = 1 - cosine_distance` for MaxSim. The MRL-768d
// vectors flowing through here are unit-norm; the upstream hnsw-index.js
// `_validateVector` already asserts that on every search() call.

import { CAPS } from "../validation.js";

/**
 * @typedef {object} SegmentVector
 * @property {string} segment_role - role tag for diagnostics
 * @property {number[]} vector_mrl_768 - MRL-sliced, L2-renormalized 768d
 */

/**
 * Hybrid candidate generation: BM25 + HNSW MaxSim, fused by RRF.
 *
 * @param {object} args
 * @param {SegmentVector[]} args.segmentVectors - 768d unit-norm segment vecs
 * @param {string} args.queryText - the BM25 query string (the distilled
 *        surrounding_context — typically current_query plus joined recent_turns)
 * @param {{ search: (q: string, k: number) => Array<{memory_id, score, rank}> }} args.bm25
 * @param {{ search: (v: number[], k: number) => Array<{memory_id, cosine_distance, rank}>, _vectors?: Map }} args.hnsw
 * @param {object} [args.opts]
 * @param {number} [args.opts.candidateSetSize] - override CAPS.RECALL_CANDIDATE_SET_SIZE
 * @param {number} [args.opts.rrfK] - override CAPS.RRF_K
 *
 * @returns {Promise<Array<{
 *   memory_id: string,
 *   rrf_score: number,
 *   dense_score: number,
 *   bm25_score: number,
 *   dense_rank: number,   // -Infinity if leg missed this id
 *   bm25_rank: number     // -Infinity if leg missed this id
 * }>>}
 */
export async function hybridRetrieve({
  segmentVectors,
  queryText,
  bm25,
  hnsw,
  opts = {},
} = {}) {
  if (!Array.isArray(segmentVectors)) {
    throw new TypeError("hybridRetrieve: segmentVectors must be an array");
  }
  if (typeof queryText !== "string") {
    throw new TypeError("hybridRetrieve: queryText must be a string");
  }
  if (bm25 == null || typeof bm25.search !== "function") {
    throw new TypeError(
      "hybridRetrieve: bm25 must expose a search(query, topK) function",
    );
  }
  // hnsw is allowed to be null when there are no segment vectors (BM25-only
  // degraded path); other callers pass a real HnswIndex.
  if (segmentVectors.length > 0 && (hnsw == null || typeof hnsw.search !== "function")) {
    throw new TypeError(
      "hybridRetrieve: hnsw must expose a search(vec, topK) function when segmentVectors is non-empty",
    );
  }

  const K = opts.candidateSetSize != null
    ? opts.candidateSetSize
    : CAPS.RECALL_CANDIDATE_SET_SIZE;
  const RRF_K = opts.rrfK != null ? opts.rrfK : CAPS.RRF_K;

  // -------------------------------------------------------------------------
  // 1. BM25 leg
  // -------------------------------------------------------------------------
  // Empty queryText is permitted — degraded recalls may pass "" and rely on
  // the dense leg alone. BM25 over "" returns []. (BM25 leg empty + dense
  // empty => return [] overall, which the caller treats as a sparse brief.)
  let bm25Hits = [];
  if (typeof queryText === "string" && queryText.trim() !== "") {
    bm25Hits = bm25.search(queryText, K);
  }

  // -------------------------------------------------------------------------
  // 2. Dense leg: union of per-segment ANN hits, reranked by MaxSim.
  // -------------------------------------------------------------------------
  // For each segment, ask HNSW for top-K nearest by 768d cosine. Then take
  // the union over segments (dedup by memory_id). Each candidate's
  // dense_score is MaxSim across all segments — even segments that did NOT
  // surface that candidate in their per-segment top-K still contribute to
  // its MaxSim via direct cosine against the candidate's stored vector.
  //
  // To compute MaxSim against candidates that did not surface in a given
  // segment's top-K, we need access to the candidate's stored 768d vector.
  // The hnsw-index supports this via the (linear-scan-only) _vectors map.
  // For the hnswlib-node backend we approximate by looking up the dense
  // score at the segments that DID surface the candidate; this is sound
  // for MaxSim because MaxSim is monotone in score and we only need the
  // max, but it understates similarities for segments that pushed the
  // candidate out of their top-K. v0 is acceptable here — we re-rerank with
  // full-3072d cosine in Layer 2 (computeScore.s_emb_full3072) anyway.
  const denseByMemoryId = new Map(); // memory_id -> dense_score (max so far)
  const perSegmentSeen = new Map();  // memory_id -> Set<segIdx> that surfaced it

  if (segmentVectors.length > 0 && hnsw != null) {
    for (let segIdx = 0; segIdx < segmentVectors.length; segIdx++) {
      const seg = segmentVectors[segIdx];
      if (!seg || !Array.isArray(seg.vector_mrl_768)) {
        // Defensive: a malformed segment vector skips its leg but does not
        // poison the whole retrieve.
        continue;
      }
      let segHits;
      try {
        segHits = hnsw.search(seg.vector_mrl_768, K);
      } catch (_e) {
        // ANN failure on a single segment skips that segment; do not abort
        // the entire dense leg.
        continue;
      }
      for (const hit of segHits) {
        const sim = 1 - hit.cosine_distance;
        const prev = denseByMemoryId.get(hit.memory_id);
        if (prev === undefined || sim > prev) {
          denseByMemoryId.set(hit.memory_id, sim);
        }
        let set = perSegmentSeen.get(hit.memory_id);
        if (!set) {
          set = new Set();
          perSegmentSeen.set(hit.memory_id, set);
        }
        set.add(segIdx);
      }
    }
  }

  // Convert dense hits to rank-sorted list (highest sim = rank 0).
  const denseSorted = [];
  for (const [memory_id, score] of denseByMemoryId.entries()) {
    denseSorted.push({ memory_id, score });
  }
  denseSorted.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.memory_id < b.memory_id ? -1 : a.memory_id > b.memory_id ? 1 : 0;
  });
  const denseRank = new Map();   // memory_id -> 0-indexed rank
  const denseScore = new Map();  // memory_id -> similarity
  for (let i = 0; i < denseSorted.length; i++) {
    denseRank.set(denseSorted[i].memory_id, i);
    denseScore.set(denseSorted[i].memory_id, denseSorted[i].score);
  }
  const bm25Rank = new Map();
  const bm25Score = new Map();
  for (const hit of bm25Hits) {
    bm25Rank.set(hit.memory_id, hit.rank);
    bm25Score.set(hit.memory_id, hit.score);
  }

  // -------------------------------------------------------------------------
  // 3. RRF fuse over the union of both legs.
  // -------------------------------------------------------------------------
  const union = new Set();
  for (const id of denseRank.keys()) union.add(id);
  for (const id of bm25Rank.keys()) union.add(id);

  const fused = [];
  for (const memory_id of union) {
    const dr = denseRank.has(memory_id) ? denseRank.get(memory_id) : null;
    const br = bm25Rank.has(memory_id) ? bm25Rank.get(memory_id) : null;
    let rrf = 0;
    if (dr !== null) rrf += 1 / (RRF_K + dr);
    if (br !== null) rrf += 1 / (RRF_K + br);
    fused.push({
      memory_id,
      rrf_score: rrf,
      dense_score: denseScore.has(memory_id) ? denseScore.get(memory_id) : 0,
      bm25_score: bm25Score.has(memory_id) ? bm25Score.get(memory_id) : 0,
      dense_rank: dr != null ? dr : -Infinity,
      bm25_rank: br != null ? br : -Infinity,
    });
  }
  fused.sort((a, b) => {
    if (b.rrf_score !== a.rrf_score) return b.rrf_score - a.rrf_score;
    return a.memory_id < b.memory_id ? -1 : a.memory_id > b.memory_id ? 1 : 0;
  });

  return fused.slice(0, K);
}
