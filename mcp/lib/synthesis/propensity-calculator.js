// propensity-calculator.js — Wave 7 SYNTHESIS-tier convenience wrapper for
// F-SYN-OPERATIONAL-propensity-logging-soak.
//
// PURPOSE
//   Synthesis-tier facade over the recall-layer propensity primitive
//   (mcp/lib/recall/propensity.js). The recall pipeline writes propensities
//   onto every surfaced item before recall.jsonl is appended; this module
//   gives the synthesis tier a small, stable interface to compute the same
//   Plackett-Luce-with-temperature + 5%-of-|score| jitter distribution against
//   scored-candidate objects of the shape used downstream of multi-feature
//   scoring.
//
//   This module is a single-producer wrapper: it forwards to
//   `computeRawPropensities` from lib/recall/propensity.js so the on-disk
//   contract pinned by W7 (Plackett-Luce softmax with tau =
//   CAPS.PROPENSITY_TEMPERATURE_TAU_DEFAULT and 5%-of-|score| jitter seeded
//   by recall_id) stays in lock-step. The CAPS exported here are the
//   synthesis-tier soak prior (TAU = 1.0 for the soak-substrate default
//   per spec § 3.4 — kept distinct from the recall-runtime production prior
//   so soak-side analyses can pin a stable contract independent of any
//   future runtime tau retune).
//
// CONTRACT
//   computePropensities(scoredCandidates) -> Array<{memory_id, score, propensity}>
//     scoredCandidates: Array<{memory_id: string, score: number, ...}>
//       — order is preserved; one output row per input row.
//     options (second arg):
//       - tau?: number     (default PROPENSITY_CAPS.TEMPERATURE_TAU)
//       - jitter_seed?: string  (default "propensity-calculator-default")
//
//   Empty input -> empty output.
//   Single-candidate input -> propensity = 1.0 (degenerate softmax).
//   All other cases: propensity ∈ (0, 1), Σ propensity == 1.0 ± 1e-6.
//
//   Throws TypeError on malformed inputs (non-array, missing memory_id, NaN
//   score). Defensive degradation lives at the CALL SITE: a caller that
//   wants "best-effort" propensities should try/catch and fall back to a
//   neutral propensity vector (1/n each) — this module does NOT silently
//   swallow malformed inputs because doing so would write 0-propensity rows
//   to recall.jsonl and silently break OPE.
//
// WAVE-7 INVARIANTS (CI-enforceable, see propensity-logging-soak.md § 9)
//   I1. propensity ∈ (0, 1) for every surfaced row in the multi-candidate
//       case (single-candidate degenerate path returns 1.0).
//   I2. Σ propensity == 1.0 ± 1e-6 over the input set.
//   I3. Schema-version stability: PROPENSITY_VERSION + frozen
//       PROPENSITY_CAPS are the soak fingerprint; any bump resets the soak
//       window per spec § 5.5.
//
// NOT IN SCOPE (separate WUs)
//   - The recall-runtime call site (mcp/lib/tools/recall.js § j) already
//     calls lib/recall/propensity.js::computePropensities directly with the
//     production CAPS (tau = 0.3). This module's CAPS (TAU = 1.0) is the
//     soak-substrate prior; the runtime is unchanged. Spec § 6 confirms the
//     runtime wiring is OK end-to-end.
//   - memory_health.recall_log_health probe — out-of-scope follow-up F4.

import { computePropensities as computeRawPropensities } from "../recall/propensity.js";

// ---------------------------------------------------------------------------
// PUBLIC CONSTANTS — version + frozen CAPS. Bumping either is a schema event.
// ---------------------------------------------------------------------------

/** Schema version for the synthesis-tier propensity calculator. v0.1.0
 *  matches the W7 spec's initial provenance entry (2026-06-19). */
export const PROPENSITY_VERSION = "v0.1.0";

/** Frozen CAPS for the synthesis-tier Plackett-Luce softmax. v0 prior:
 *  TEMPERATURE_TAU = 1.0 (soak-substrate default; broader exploration for
 *  OPE viability per spec § 3.4 column "τ = 1.0"); JITTER_PCT = 0.05 (5% of
 *  |score|, the intervention-harvesting fraction pinned by spec § 3.3 and
 *  CAPS.PROPENSITY_JITTER_FRACTION in validation.js). */
export const PROPENSITY_CAPS = Object.freeze({
  TEMPERATURE_TAU: 1.0,
  JITTER_PCT: 0.05,
});

/** Default jitter seed used when no seed is passed. Soak-time call sites
 *  SHOULD pass the recall_id so replay produces bit-identical propensities;
 *  this default exists only for ad-hoc analyses and tests. */
const DEFAULT_JITTER_SEED = "propensity-calculator-default";

// ---------------------------------------------------------------------------
// computePropensities(scoredCandidates, options)
// ---------------------------------------------------------------------------
// Synthesis-tier facade. Maps {memory_id, score} objects to
// {memory_id, score, propensity} using the Plackett-Luce softmax with
// 5%-of-|score| deterministic jitter.
//
// Edge cases:
//   - Empty input  -> empty output (no softmax to compute).
//   - Single input -> propensity = 1.0 (the softmax of one element is
//     always 1.0; we short-circuit rather than ride through the
//     underlying lib/recall/propensity.js path so the contract is explicit).
//   - All-equal scores -> near-uniform (1/n ± jitter), as expected for the
//     Plackett-Luce softmax under tau > 0.
//
// Defensive shape:
//   - Throws TypeError on non-array input or any element missing memory_id /
//     having a non-finite score. The hot-path caller (recall.js) wraps the
//     call in try/catch and degrades to neutral propensities if needed; this
//     module never silently emits invalid propensities.
export function computePropensities(scoredCandidates, options = {}) {
  if (!Array.isArray(scoredCandidates)) {
    throw new TypeError(
      "computePropensities: scoredCandidates must be an array",
    );
  }
  if (scoredCandidates.length === 0) return [];

  // Validate every candidate up-front so a malformed tail row does not get
  // a propensity computed against a partially-validated head.
  for (let i = 0; i < scoredCandidates.length; i++) {
    const c = scoredCandidates[i];
    if (!c || typeof c !== "object") {
      throw new TypeError(
        `computePropensities: scoredCandidates[${i}] must be an object`,
      );
    }
    if (typeof c.memory_id !== "string" || c.memory_id === "") {
      throw new TypeError(
        `computePropensities: scoredCandidates[${i}].memory_id must be a non-empty string`,
      );
    }
    if (typeof c.score !== "number" || !Number.isFinite(c.score)) {
      throw new TypeError(
        `computePropensities: scoredCandidates[${i}].score must be a finite number`,
      );
    }
  }

  // Degenerate single-candidate case — softmax of one element is always 1.0.
  // Short-circuit so the contract is explicit (and so the underlying
  // lib/recall/propensity.js does not waste a SHA-256 expansion).
  if (scoredCandidates.length === 1) {
    return [
      {
        memory_id: scoredCandidates[0].memory_id,
        score: scoredCandidates[0].score,
        propensity: 1.0,
      },
    ];
  }

  const tau =
    typeof options.tau === "number" && Number.isFinite(options.tau) && options.tau !== 0
      ? options.tau
      : PROPENSITY_CAPS.TEMPERATURE_TAU;
  const jitterSeed =
    typeof options.jitter_seed === "string" && options.jitter_seed !== ""
      ? options.jitter_seed
      : DEFAULT_JITTER_SEED;

  const candidateScores = scoredCandidates.map((c) => c.score);

  // Forward to the recall-layer primitive. The recall-layer module is the
  // single source of truth for the Plackett-Luce softmax + 5%-of-|score|
  // jitter algorithm; this synthesis-tier wrapper exists to give the
  // synthesis pipeline a {memory_id, score, propensity} shape without
  // duplicating the math.
  const raw = computeRawPropensities({
    candidate_scores: candidateScores,
    tau,
    jitter_seed: jitterSeed,
  });

  const out = new Array(scoredCandidates.length);
  for (let i = 0; i < scoredCandidates.length; i++) {
    out[i] = {
      memory_id: scoredCandidates[i].memory_id,
      score: scoredCandidates[i].score,
      propensity: raw[i].propensity,
    };
  }
  return out;
}
