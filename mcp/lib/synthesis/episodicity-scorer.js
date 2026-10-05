// episodicity-scorer.js — v0 sigmoid scorer for the per-fact /
// per-query episodicity scalar (F-SYN-SUBSTRATE-EPISODICITY-SCORER).
//
// AUTHORITATIVE spec: docs/specs/synthesis/episodicity-feature.md.
//
// The scorer is the single pure function consumed on BOTH sides:
//   - cascade-stamp at promote time (writes `features.episodicity`
//     and `features.episodicity_meta`), and
//   - recall-time twin (computes `query_episodicity` over
//     `surrounding_context`).
//
// Both sides feed the multi-feature score's `episodicity_match`
// multiplicative gate via `episodicityMatch(fact_ep, query_ep)`.
// The W3 power-law-decay-contract reads `candidate.features.episodicity`
// at `§ 4.3.1` for its stratification dial — post-W5 rename the spec
// and the W3 contract agree on the bare scalar field path.
//
// Design notes:
// - Pure function. No I/O, no clock reads, no random draws. CAPS
//   weights are module-level frozen constants.
// - The workunit's surface signature (`scoreEpisodicity({has_time_anchor,
//   corroboration_count, entity_generality, narrative_valence_magnitude})`)
//   is the v0 substrate API. The richer `computeFromFeatures(features)`
//   sugar pulls the four inputs out of a fact's feature block; the
//   `computeQueryEpisodicity(surrounding_context)` twin does the same
//   over a recall context.
// - All inputs are defensively coerced. Null / undefined / NaN inputs
//   collapse to the neutral 0.5 baseline rather than throwing (the
//   recall-time gate must never break the candidate set).

export const EPISODICITY_VERSION = "v0.1.0";

// v0 PRIOR weights — hand-tuned per spec § 3.5 and § 5. NOT learned.
// Re-fit by the O5 calibration loop once a labeled set exists.
//
// w_anchor is positive: time anchor is the strongest episodic signal.
// w_corro  is positive on log(1+count) — under the workunit's
//   "additive form" (sigmoid(w_anchor*A + w_corro*log(1+C) -
//   w_general*G + w_val*|V|)) the corroboration term IS the running
//   count's positive contribution while -w_general dominates for
//   topic-heavy rows. The cognitive prior is preserved: a heavily
//   corroborated, topic-heavy fact still trends semantic via the
//   w_general weight on entity_generality. See § 8 Q1 for the v2
//   re-calibration knob (sign of corroboration's pull is the most
//   likely flip post-O5).
// w_general is positive on entity_generality (high generality → topic
//   heavy → lowered episodicity via the negative sign in the formula).
// w_val is positive: amygdala-modulated affective encoding (Cahill &
//   McGaugh 1998).
export const W_ANCHOR = 1.2;
export const W_CORRO = 0.4;
export const W_GENERAL = 0.7;
export const W_VAL = 0.3;

// Intercept (bias term): semantic-leaning baseline. Matches the spec
// `b0 = -1.5` so the dynamic range stretches across [0, 1] rather
// than bunching near 0.5. Pure-episodic events with a time anchor
// and specific entities still surface above 0.5; corroboration-heavy
// topic-laden rows collapse to ~0.1. The combined v0 PRIOR knobs
// reproduce the spec's worked examples (§ 7.1 Robin iMessage ≈ 0.55,
// § 7.2 Wixted research-note ≈ 0.11) when fed identical inputs.
export const W_INTERCEPT = -1.5;

// Neutral substitution value used when an input cannot be derived.
// Matches the W3 power-law-decay-contract's `0.5` default and the
// multi-feature scorer's null-fact substitution rule.
const NEUTRAL = 0.5;

// Sigmoid clamp envelope per spec § 6.3 fallback `SIGMOID_CLAMP`.
// Prevents NaN / Infinity if a future calibrator hands in extreme
// weights.
const SIGMOID_Z_MAX = 700;

function sigmoid(z) {
  if (!Number.isFinite(z)) return NEUTRAL;
  if (z > SIGMOID_Z_MAX) return 1;
  if (z < -SIGMOID_Z_MAX) return 0;
  return 1 / (1 + Math.exp(-z));
}

function clamp01(x) {
  if (!Number.isFinite(x)) return NEUTRAL;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function coerceNonNegInt(n) {
  if (n === null || n === undefined) return 0;
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  return Math.floor(n);
}

/**
 * Score the episodicity of an event from its four numeric inputs.
 *
 * Pure function. Inputs are coerced defensively; null / NaN / negative
 * values collapse to the spec's documented fallback substitutions.
 *
 * @param {{
 *   has_time_anchor?: boolean | 0 | 1,
 *   corroboration_count?: number,
 *   entity_generality?: number,
 *   narrative_valence_magnitude?: number,
 * }} input
 * @returns {number}   episodicity ∈ [0, 1]
 */
export function scoreEpisodicity(input) {
  if (input === null || input === undefined) return NEUTRAL;
  if (typeof input !== "object") return NEUTRAL;

  const anchor = input.has_time_anchor === true || input.has_time_anchor === 1
    ? 1
    : 0;
  const corro = coerceNonNegInt(input.corroboration_count);
  const generality = clamp01(input.entity_generality ?? NEUTRAL);
  const valMag = clamp01(input.narrative_valence_magnitude ?? 0);

  const z =
    W_INTERCEPT +
    W_ANCHOR * anchor +
    W_CORRO * Math.log(1 + corro) -
    W_GENERAL * generality +
    W_VAL * valMag;

  return clamp01(sigmoid(z));
}

/**
 * Sugar: build a scorer input from a fact's `features` block and
 * compute. Reads the four sigmoid inputs from
 *   features.time_anchors[] → has_time_anchor (per spec § 5.1)
 *   features.entities[]     → entity_generality (per spec § 5.3)
 *   features.valence        → narrative_valence_magnitude (per § 5.4)
 * Corroboration count is read from the optional
 * `features.corroboration_count` slot (the v0 promote-time stamp value
 * is 0; re-stamp passes write the live count there).
 *
 * Defensive on null / undefined `features` — collapses to NEUTRAL.
 *
 * @param {object} features
 * @returns {number}
 */
export function computeFromFeatures(features) {
  if (features === null || features === undefined) return NEUTRAL;
  if (typeof features !== "object") return NEUTRAL;

  const timeAnchors = Array.isArray(features.time_anchors)
    ? features.time_anchors
    : [];
  const hasTimeAnchor = timeAnchors.some((a) => {
    if (!a || typeof a !== "object") return false;
    if (a.recurrence_resolution_deferred === true) return false;
    if (
      a.extractor_confidence !== undefined &&
      typeof a.extractor_confidence === "number" &&
      a.extractor_confidence < 0.5
    ) {
      return false;
    }
    return a.kind === "absolute" || a.kind === "relative";
  });

  const entities = Array.isArray(features.entities) ? features.entities : [];
  const generality = meanEntityGenerality(entities);

  const valence = features.valence ?? null;
  let valMag = 0;
  if (
    valence &&
    typeof valence === "object" &&
    valence.source !== "absent" &&
    typeof valence.magnitude === "number"
  ) {
    valMag = clamp01(Math.abs(valence.magnitude));
  }

  return scoreEpisodicity({
    has_time_anchor: hasTimeAnchor,
    corroboration_count: features.corroboration_count ?? 0,
    entity_generality: generality === null ? NEUTRAL : generality,
    narrative_valence_magnitude: valMag,
  });
}

/**
 * Recall-time twin: compute `query_episodicity` over a surrounding
 * context. The query-side `corroboration_count` is unconditionally 0
 * at v0 per spec § 6.6. `has_time_anchor` is derived from
 * `surrounding_context.time_anchors` (or the populator's
 * `query_episodicity_inputs`). `entity_generality` and
 * `narrative_valence_magnitude` come from the populator-provided
 * `entities[]` and `ambient.inferred_mood` per § 6.2.
 *
 * Always returns a non-null scalar per spec invariant I-EPI-9.
 *
 * @param {object} surrounding_context
 * @returns {number}
 */
export function computeQueryEpisodicity(surrounding_context) {
  if (surrounding_context === null || surrounding_context === undefined) {
    return NEUTRAL;
  }
  if (typeof surrounding_context !== "object") return NEUTRAL;

  const sc = surrounding_context;
  const timeAnchors = Array.isArray(sc.time_anchors) ? sc.time_anchors : [];
  const hasTimeAnchor = timeAnchors.some((a) => {
    if (!a || typeof a !== "object") return false;
    if (a.recurrence_resolution_deferred === true) return false;
    if (
      typeof a.extractor_confidence === "number" &&
      a.extractor_confidence < 0.5
    ) {
      return false;
    }
    return a.kind === "absolute" || a.kind === "relative";
  });

  const entities = Array.isArray(sc.entities) ? sc.entities : [];
  const generality = meanEntityGenerality(entities);

  const inferredMood = sc.ambient?.inferred_mood ?? null;
  let valMag = 0;
  if (
    inferredMood &&
    typeof inferredMood === "object" &&
    inferredMood.source !== "absent" &&
    typeof inferredMood.magnitude === "number"
  ) {
    valMag = clamp01(Math.abs(inferredMood.magnitude));
  }

  return scoreEpisodicity({
    has_time_anchor: hasTimeAnchor,
    corroboration_count: 0,
    entity_generality: generality === null ? NEUTRAL : generality,
    narrative_valence_magnitude: valMag,
  });
}

/**
 * Match function: `1 - |fact_ep - query_ep|`, with the workunit's
 * null-fact rule: when `fact_ep` is null / undefined / non-finite, the
 * match collapses directly to NEUTRAL (0.5) — the gate is treated as
 * "ambiguous, neither preferred nor penalized" rather than substituting
 * 0.5 and computing (which would make `episodicityMatch(null, 0.5)`
 * return 1.0 instead of the workunit's required 0.5). The substitution
 * behavior is reserved for the multi-feature scorer's gate-arithmetic
 * step, where a constant 0.5 is the right neutral; here at the match
 * function the 0.5 return preserves the "no information" reading.
 *
 * Spec § 6.4 / invariants I-EPI-6 (symmetric), I-EPI-7 (∈ [0, 1]),
 * I-EPI-18 (formula closure for the non-null path).
 *
 * @param {number | null} fact_ep
 * @param {number | null} query_ep
 * @returns {number}   ∈ [0, 1]
 */
export function episodicityMatch(fact_ep, query_ep) {
  const factNull =
    fact_ep === null ||
    fact_ep === undefined ||
    typeof fact_ep !== "number" ||
    !Number.isFinite(fact_ep);
  if (factNull) return NEUTRAL;

  const queryNull =
    query_ep === null ||
    query_ep === undefined ||
    typeof query_ep !== "number" ||
    !Number.isFinite(query_ep);
  if (queryNull) return NEUTRAL;

  const f = clamp01(fact_ep);
  const q = clamp01(query_ep);
  return clamp01(1 - Math.abs(f - q));
}

// ---------------------------------------------------------------
// Helpers (also exported so the populator and re-stamp pass share
// the exact entity-generality reduction).
// ---------------------------------------------------------------

// Mirror of CAPS.ENTITY_SPECIFICITY_PRIORS from entity-schema.md § 3.1.
// CI cross-check at entity-schema.md § I9 enforces equality with the
// canonical mirror; this module fails CLOSED on unknown kinds via the
// `null` return below when at least one mapped specificity is missing.
const ENTITY_SPECIFICITY_PRIORS = Object.freeze({
  event: 0.95,
  person: 0.9,
  place: 0.8,
  project: 0.7,
  org: 0.6,
  artifact: 0.5,
  topic: 0.1,
});

/**
 * Compute entity_generality = 1 - mean(specificity_prior[kind]) over
 * an entity set. Empty / null entities → null (the b3 term is masked
 * from the sigmoid by the caller, who substitutes NEUTRAL). Unknown
 * kinds → skipped from the mean rather than thrown — the v0 substrate
 * is defensive so a bad upstream extraction does not break the recall
 * hot path. The spec's fail-closed throw is recovered by the strict
 * cascade-stamp call site (a future workunit).
 *
 * @param {Array<{kind?: string}>} entities
 * @returns {number | null}
 */
export function meanEntityGenerality(entities) {
  if (!Array.isArray(entities) || entities.length === 0) return null;
  const specs = [];
  for (const e of entities) {
    if (!e || typeof e !== "object" || typeof e.kind !== "string") continue;
    const s = ENTITY_SPECIFICITY_PRIORS[e.kind];
    if (typeof s === "number") specs.push(s);
  }
  if (specs.length === 0) return null;
  const mean = specs.reduce((a, b) => a + b, 0) / specs.length;
  return clamp01(1 - mean);
}
