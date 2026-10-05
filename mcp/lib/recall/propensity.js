// Plackett-Luce propensity distribution + deterministic jitter.
//
// Phase 3 v0 recall layer — propensity component. Spec source:
//   kb/research-retrieval-frontiers.md
//     § Recommended Phase 3 architecture, § Risks #11
//   kb/phase3-v0-contracts.md
//     § 5. Recall ledger event extension, propensity discipline
//
// Why this exists (load-bearing for v3 OPE):
//   Off-policy evaluation of future ranker upgrades requires an EXPLICIT
//   logging policy over the surfaced candidate set. Pure score jitter is
//   insufficient: without a logged propensity P_j, importance-weighted
//   estimators (IPS, SNIPS, DR) are biased. We therefore softmax the jittered
//   scores under temperature tau, log P_j alongside each surfaced item, and
//   add deterministic jitter so that replays of historical recalls produce
//   identical propensities (required for offline-evaluation reproducibility).
//
// The jitter is keyed by `jitter_seed` (typically the recall_id). Same seed +
// same candidate set => identical jitter vector => identical propensities.
//
// No new npm deps; uses node:crypto for SHA-256 only.

import { createHash } from "node:crypto";
import { CAPS } from "../validation.js";

// ---------------------------------------------------------------------------
// softmax(scores, tau)
// ---------------------------------------------------------------------------
// Numerically stable softmax. Subtract max before exp to avoid overflow with
// large positive scores; tau is the Plackett-Luce temperature. Throws on
// tau == 0 (the distribution would collapse to a point mass at argmax;
// callers must handle that case explicitly rather than silently dividing by
// zero).
export function softmax(scores, tau = 1.0) {
  if (!Array.isArray(scores)) {
    throw new TypeError("softmax: scores must be an array");
  }
  if (scores.length === 0) return [];
  if (typeof tau !== "number" || !Number.isFinite(tau)) {
    throw new TypeError("softmax: tau must be a finite number");
  }
  if (tau === 0) {
    throw new RangeError("softmax: tau must be non-zero");
  }
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (typeof s !== "number" || !Number.isFinite(s)) {
      throw new TypeError(`softmax: scores[${i}] must be a finite number`);
    }
  }

  const scaled = new Array(scores.length);
  for (let i = 0; i < scores.length; i++) {
    scaled[i] = scores[i] / tau;
  }

  let maxV = scaled[0];
  for (let i = 1; i < scaled.length; i++) {
    if (scaled[i] > maxV) maxV = scaled[i];
  }

  let sumExp = 0;
  const exps = new Array(scaled.length);
  for (let i = 0; i < scaled.length; i++) {
    exps[i] = Math.exp(scaled[i] - maxV);
    sumExp += exps[i];
  }

  // sumExp is bounded in (0, n] because at least one term is exp(0) = 1 and
  // all others are in (0, 1]; safe to divide.
  const out = new Array(scaled.length);
  for (let i = 0; i < scaled.length; i++) {
    out[i] = exps[i] / sumExp;
  }
  return out;
}

// ---------------------------------------------------------------------------
// deterministicJitter(seed, n, scale)
// ---------------------------------------------------------------------------
// SHA-256 of `seed`; expand to ceil(n*4 / 32) blocks by hashing
// seed||counter; interpret consecutive 4-byte little-endian uint32 windows
// as uniform(0, 2^32 - 1); map to uniform(-scale, +scale).
//
// Pure: identical (seed, n, scale) => identical output. Required for
// replayability of historical recalls so v3 OPE can re-derive the exact
// propensity any past surfaced brief was logged under.
//
// The SHA-256 expansion guarantees that the seed bits are mixed into every
// output sample; using just one hash digest would silently cap n at 8.
export function deterministicJitter(seed, n, scale) {
  if (typeof seed !== "string") {
    throw new TypeError("deterministicJitter: seed must be a string");
  }
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("deterministicJitter: n must be a non-negative integer");
  }
  if (typeof scale !== "number" || !Number.isFinite(scale)) {
    throw new TypeError("deterministicJitter: scale must be a finite number");
  }
  if (n === 0) return [];

  const bytesNeeded = n * 4;
  const blocksNeeded = Math.ceil(bytesNeeded / 32);
  const buf = Buffer.allocUnsafe(blocksNeeded * 32);
  for (let block = 0; block < blocksNeeded; block++) {
    const h = createHash("sha256");
    h.update(seed);
    // 8-byte little-endian counter so seed re-use across blocks is keyed
    // distinctly. Buffer.writeBigUInt64LE keeps the counter mapping cross-arch.
    const counter = Buffer.allocUnsafe(8);
    counter.writeBigUInt64LE(BigInt(block), 0);
    h.update(counter);
    h.digest().copy(buf, block * 32);
  }

  const out = new Array(n);
  // 2^32 - 1 = 4294967295. Mapping u/U_MAX gives [0, 1]; *2 - 1 gives [-1, 1];
  // *scale gives [-scale, +scale]. Inclusive endpoints are acceptable for the
  // 5% jitter use case (one in 2^32 collisions at the boundary).
  const U_MAX = 0xffffffff;
  for (let i = 0; i < n; i++) {
    const u = buf.readUInt32LE(i * 4);
    const unit = u / U_MAX;          // [0, 1]
    out[i] = (unit * 2 - 1) * scale; // [-scale, +scale]
  }
  return out;
}

// ---------------------------------------------------------------------------
// computePropensities({ candidate_scores, tau, jitter_seed })
// ---------------------------------------------------------------------------
// Returns Array<{ original_index, jittered_score, propensity }> in the same
// order as candidate_scores; sum(propensity) == 1.0 +/- 1e-6.
//
// Algorithm (per kb/phase3-v0-contracts.md § 5):
//   1. Deterministic jitter from `jitter_seed` (typically the recall_id),
//      one sample per candidate at scale PROPENSITY_JITTER_FRACTION * |s_i|.
//   2. jittered_score[i] = candidate_scores[i] + jitter[i].
//   3. softmax(jittered_score / tau) over the full candidate set.
//   4. P_j = softmaxed value for item j.
//
// The jitter scale is proportional to |score_i|, NOT a fixed value, so that
// candidates with very different absolute score magnitudes receive
// proportional perturbation. Pure-score jitter at fixed scale would either be
// negligible at the top or dominant at the bottom of a long-tailed scoring
// surface.
export function computePropensities({
  candidate_scores,
  tau = CAPS.PROPENSITY_TEMPERATURE_TAU_DEFAULT,
  jitter_seed,
}) {
  if (!Array.isArray(candidate_scores)) {
    throw new TypeError("computePropensities: candidate_scores must be an array");
  }
  if (typeof jitter_seed !== "string" || jitter_seed === "") {
    throw new TypeError(
      "computePropensities: jitter_seed must be a non-empty string",
    );
  }
  if (typeof tau !== "number" || !Number.isFinite(tau) || tau === 0) {
    throw new RangeError("computePropensities: tau must be a finite non-zero number");
  }
  if (candidate_scores.length === 0) return [];
  for (let i = 0; i < candidate_scores.length; i++) {
    const s = candidate_scores[i];
    if (typeof s !== "number" || !Number.isFinite(s)) {
      throw new TypeError(
        `computePropensities: candidate_scores[${i}] must be a finite number`,
      );
    }
  }

  const n = candidate_scores.length;
  const fraction = CAPS.PROPENSITY_JITTER_FRACTION;

  // Per-candidate scale: PROPENSITY_JITTER_FRACTION * |score|. A score of 0
  // yields zero jitter; that is acceptable since softmax already handles
  // identical inputs (uniform distribution).
  // We sample a single base jitter vector at scale=1 and rescale per index
  // so that jitter is deterministic w.r.t. (seed, n) and reproducible even
  // if scores change between replays of the same recall_id (a corner case;
  // in practice scores are part of the recall ledger and frozen).
  const baseJitter = deterministicJitter(jitter_seed, n, 1.0);

  const jitteredScores = new Array(n);
  for (let i = 0; i < n; i++) {
    const localScale = fraction * Math.abs(candidate_scores[i]);
    jitteredScores[i] = candidate_scores[i] + baseJitter[i] * localScale;
  }

  const propensities = softmax(jitteredScores, tau);

  // Invariant: sum of propensities == 1.0 within float epsilon.
  let sum = 0;
  for (let i = 0; i < n; i++) sum += propensities[i];
  if (Math.abs(sum - 1.0) > 1e-6) {
    throw new Error(
      `computePropensities: softmax sum invariant violated; got ${sum}`,
    );
  }

  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      original_index: i,
      jittered_score: jitteredScores[i],
      propensity: propensities[i],
    };
  }
  return out;
}
