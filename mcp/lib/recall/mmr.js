// MMR (Maximal Marginal Relevance) diversification + density_flag emission.
//
// Phase 3 v0, Layer 4 of the recall pipeline. Authoritative shape contract:
// kb/phase3-v0-contracts.md. Spec source: kb/research-retrieval-frontiers.md.
//
// Algorithm: Carbonell & Goldstein 1998. At each step, the next item selected
// is argmax over the remaining candidates of:
//
//     lambda * score(c) - (1 - lambda) * max_pairwise_cos(c, already_selected)
//
// lambda = 0.7 per the research report (NOT LangChain's 0.5 default).
//
// Inputs use embedding_3072 (the full-3072d vector). gemini-embedding-001
// returns unit-norm vectors at 3072d, so dot product equals cosine for these.
// This module does NOT renormalize; the upstream pipeline is responsible for
// the L2 invariant. (Sliced 768d vectors must be renormalized BEFORE entering
// MMR — but v0 MMR runs on 3072d, so this is moot here.)
//
// Exports:
//   mmrSelect({ candidates, K, lambda })
//   emitDensityFlag({ selected, candidates_at_similar_scores })
//   enforceBriefCaps(selected, opts)
//   _avgPairwiseCosine(vectors)   // exported for white-box tests

import { CAPS } from "../validation.js";

/**
 * Cosine similarity between two equal-length vectors. Assumes both are
 * unit-norm (||v|| = 1 +/- 1e-6); cosine then reduces to dot product. No
 * defensive renorm here — the pipeline-wide invariant enforces unit norm at
 * every layer.
 *
 * Accepts Float32Array OR plain Array<number>.
 */
function dotProduct(a, b) {
  if (a.length !== b.length) {
    throw new Error(
      `mmr: vector length mismatch (a=${a.length}, b=${b.length})`,
    );
  }
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    s += a[i] * b[i];
  }
  return s;
}

/**
 * Average pairwise cosine over a set of unit-norm embedding vectors.
 *
 * Computation:
 *   Let N = vectors.length. There are C(N, 2) = N*(N-1)/2 unordered pairs.
 *   avg = ( sum over i<j of cos(v_i, v_j) ) / C(N, 2)
 *
 * For N < 2 returns 0 (no pairs).
 *
 * This is exported for tests; the public surface uses it inside
 * emitDensityFlag.
 */
export function _avgPairwiseCosine(vectors) {
  const n = vectors.length;
  if (n < 2) return 0;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      sum += dotProduct(vectors[i], vectors[j]);
      pairs += 1;
    }
  }
  return sum / pairs;
}

/**
 * MMR selection.
 *
 * @param {object} args
 * @param {Array<{memory_id: string, score: number, embedding_3072: number[]|Float32Array}>} args.candidates
 *        The post-Layer-2 candidate set with full multi-feature scores.
 *        Order is irrelevant; this function selects greedily.
 * @param {number} args.K - max items to select (default CAPS.RECALL_BRIEF_MAX_ITEMS)
 * @param {number} [args.lambda=0.7] - relevance vs. diversity trade.
 *        1.0 = pure relevance (score-only). 0.0 = pure diversity.
 *        Default 0.7 per the research report.
 *
 * @returns {Array<{memory_id: string, score: number, position: number}>}
 *        Items in selection order. position = 0-based index in this list.
 *        score is the input relevance score (unchanged by MMR).
 */
export function mmrSelect({
  candidates,
  K = CAPS.RECALL_BRIEF_MAX_ITEMS,
  lambda = CAPS.MMR_LAMBDA_DEFAULT,
}) {
  if (!Array.isArray(candidates)) {
    throw new Error("mmrSelect: candidates must be an array");
  }
  if (typeof K !== "number" || K < 0 || !Number.isFinite(K)) {
    throw new Error(`mmrSelect: K must be a non-negative finite number (got ${K})`);
  }
  if (typeof lambda !== "number" || lambda < 0 || lambda > 1) {
    throw new Error(
      `mmrSelect: lambda must be in [0, 1] (got ${lambda})`,
    );
  }
  if (candidates.length === 0 || K === 0) return [];

  // Working copy of "remaining" candidates; we splice as we select.
  // Each entry: { idx, memory_id, score, embedding_3072 }
  const remaining = candidates.map((c, idx) => {
    if (!c || typeof c.memory_id !== "string") {
      throw new Error(`mmrSelect: candidate[${idx}].memory_id must be a string`);
    }
    if (typeof c.score !== "number" || !Number.isFinite(c.score)) {
      throw new Error(
        `mmrSelect: candidate[${idx}].score must be a finite number`,
      );
    }
    if (!c.embedding_3072 || typeof c.embedding_3072.length !== "number") {
      throw new Error(
        `mmrSelect: candidate[${idx}].embedding_3072 must be an array-like`,
      );
    }
    return {
      memory_id: c.memory_id,
      score: c.score,
      embedding_3072: c.embedding_3072,
    };
  });

  const selected = [];
  const targetK = Math.min(K, remaining.length);

  while (selected.length < targetK && remaining.length > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i += 1) {
      const cand = remaining[i];
      let maxSimToSelected = 0;
      if (selected.length > 0) {
        for (let j = 0; j < selected.length; j += 1) {
          const sim = dotProduct(
            cand.embedding_3072,
            selected[j].embedding_3072,
          );
          if (sim > maxSimToSelected) maxSimToSelected = sim;
        }
      }
      const mmr = lambda * cand.score - (1 - lambda) * maxSimToSelected;
      // Deterministic tie-break: first occurrence wins (lower original idx).
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) break; // defensive; should be unreachable
    const picked = remaining.splice(bestIdx, 1)[0];
    selected.push(picked);
  }

  return selected.map((s, position) => ({
    memory_id: s.memory_id,
    score: s.score,
    position,
  }));
}

/**
 * Emit density_flag for the surfaced brief.
 *
 *   "crowded" if avg pairwise cosine over selected > DENSITY_FLAG_PAIRWISE_COSINE_THRESHOLD
 *             OR candidates_at_similar_scores > 6
 *   "sparse"  if selected.length < 3
 *   "ok"      otherwise
 *
 * Order of precedence: "crowded" beats "sparse" (a 2-item brief whose pair is
 * near-duplicate is more usefully labeled crowded). This matches the spec
 * intent: the flag exists so downstream callers can ask for more diversity
 * OR more breadth — crowded is the more actionable signal when both apply.
 *
 * @param {object} args
 * @param {Array<{embedding_3072: number[]|Float32Array}>} args.selected
 * @param {number} args.candidates_at_similar_scores
 * @returns {"ok"|"crowded"|"sparse"}
 */
export function emitDensityFlag({ selected, candidates_at_similar_scores }) {
  if (!Array.isArray(selected)) {
    throw new Error("emitDensityFlag: selected must be an array");
  }
  if (
    typeof candidates_at_similar_scores !== "number" ||
    !Number.isFinite(candidates_at_similar_scores) ||
    candidates_at_similar_scores < 0
  ) {
    throw new Error(
      "emitDensityFlag: candidates_at_similar_scores must be a non-negative finite number",
    );
  }

  const vectors = selected.map((s) => s.embedding_3072).filter((v) => v);
  const avgCos = _avgPairwiseCosine(vectors);

  if (
    avgCos > CAPS.DENSITY_FLAG_PAIRWISE_COSINE_THRESHOLD ||
    candidates_at_similar_scores > 6
  ) {
    return "crowded";
  }
  if (selected.length < 3) return "sparse";
  return "ok";
}

/**
 * Enforce per-item and total char budgets on the surfaced brief.
 *
 * @param {Array<{memory_id: string, content_excerpt?: string, content?: string, ...}>} selected
 * @param {object} [opts]
 * @param {number} [opts.maxItems=CAPS.RECALL_BRIEF_MAX_ITEMS]
 * @param {number} [opts.maxCharsTotal=CAPS.RECALL_BRIEF_MAX_CHARS_TOTAL]
 * @param {number} [opts.maxCharsPerItem=CAPS.RECALL_BRIEF_MAX_CHARS_PER_ITEM]
 *
 * Truncates each item's content_excerpt to maxCharsPerItem. Then walks the
 * list in order, accumulating chars until maxCharsTotal would be exceeded;
 * remaining items are dropped. Preserves input order. Also caps item count
 * at maxItems.
 *
 * If an input item has `content` but no `content_excerpt`, this function
 * copies it into `content_excerpt` before truncation (convenience for
 * callers that haven't projected yet).
 *
 * @returns {Array<...>} a NEW array of trimmed items (does not mutate input).
 */
export function enforceBriefCaps(selected, opts = {}) {
  if (!Array.isArray(selected)) {
    throw new Error("enforceBriefCaps: selected must be an array");
  }
  const maxItems = opts.maxItems ?? CAPS.RECALL_BRIEF_MAX_ITEMS;
  const maxCharsTotal = opts.maxCharsTotal ?? CAPS.RECALL_BRIEF_MAX_CHARS_TOTAL;
  const maxCharsPerItem =
    opts.maxCharsPerItem ?? CAPS.RECALL_BRIEF_MAX_CHARS_PER_ITEM;

  const out = [];
  let totalChars = 0;

  for (let i = 0; i < selected.length; i += 1) {
    if (out.length >= maxItems) break;
    const item = selected[i];
    const srcExcerpt =
      typeof item.content_excerpt === "string"
        ? item.content_excerpt
        : typeof item.content === "string"
          ? item.content
          : "";
    const truncated =
      srcExcerpt.length > maxCharsPerItem
        ? srcExcerpt.slice(0, maxCharsPerItem)
        : srcExcerpt;
    if (totalChars + truncated.length > maxCharsTotal) {
      // Try to fit a partial of this item before dropping.
      const remaining = maxCharsTotal - totalChars;
      if (remaining > 0) {
        const partial = truncated.slice(0, remaining);
        out.push({ ...item, content_excerpt: partial });
        totalChars += partial.length;
      }
      break;
    }
    out.push({ ...item, content_excerpt: truncated });
    totalChars += truncated.length;
  }

  return out;
}
