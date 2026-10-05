// valence-scorer.js — v0 lexicon-based valence/mood scorer.
//
// Implements F-SYN-SUBSTRATE-VALENCE-SCORER per spec
// docs/specs/synthesis/valence-provenance.md. v0 simplified surface (per
// WU-valence-scorer-impl): a single exported `scoreValence(text)` that returns
// {sign, magnitude, source, model_version}.
//
// Design notes:
// - Pure function. No I/O, no clock reads, no random draws. Lexicons are
//   frozen module-level constants.
// - Sign is the dominant polarity among lexicon hits. magnitude is the density
//   of valence-bearing hits normalized by sqrt(token-count) and clipped to
//   [0, 1]. Empty or hit-less input collapses to sign=0, magnitude=0.
// - Source is 'lexicon' for any v0 output (the user-requested taxonomy is
//   'lexicon'|'model'; the v1 swap to a classifier will return source='model').
// - model_version is a string tag identifying the lexicon snapshot. Bumps
//   trigger O6 restamp (see spec § 6.6).
//
// This module is deliberately small (~120 LOC). Phase-1 substrate may grow
// it with intensifier/negation bigram handling, structural signal fusion,
// and a JSON-on-disk lexicon. Until then, the inline constants below ARE
// the binding contract.

export const MODEL_VERSION = "lexicon-v1";

// Closed CAPS block. Per W2-W13 substrate discipline: bumping any value
// here REQUIRES a MODEL_VERSION bump because downstream consumers
// (multi-feature scorer's valence_compat, recall-feedback-emitter's
// scoring_weights snapshot) pin to the emitted version. Object.freeze
// enforces single-producer discipline at module load.
export const VALENCE_SCORER_CAPS = Object.freeze({
  // Magnitude floor below which (post normalization) we collapse to
  // sign=0 / magnitude=0. Closes the small-signal degenerate-sign reviewer
  // finding from the original spec § CAPS.VALENCE_SIGN_THRESHOLD.
  SIGN_THRESHOLD: 0.05,
  // Below this token count (post-stopword strip) the input is too short
  // to trust a magnitude — fall back to neutral.
  MIN_TOKEN_THRESHOLD: 2,
  // Structural override threshold (substrate-minor-polish item #2). When
  // an overlay lexicon supplies a structural signal (e.g. an explicit
  // signal_kind row from the damping-log carrying a high-confidence valence
  // override), the override only takes effect when its confidence meets
  // this floor. Previously hardcoded at 0.7 inline; promoted here so the
  // calibration loop can probe it.
  STRUCTURAL_OVERRIDE_THRESHOLD: 0.7,
});

// POSITIVE_WORDS / NEGATIVE_WORDS — surface-form English tokens (lowercase).
// Intentionally small + auditable. Operator-tunable in a later substrate
// pass when we move the lexicon to JSON.
const POSITIVE_WORDS = new Set([
  // affection / warmth
  "love", "loved", "loves", "loving", "adore", "adored",
  // joy / excitement
  "excited", "exciting", "happy", "joy", "joyful", "delighted", "delight",
  "thrilled", "ecstatic", "elated", "glad",
  // praise
  "great", "amazing", "awesome", "fantastic", "wonderful", "excellent",
  "brilliant", "perfect", "superb", "incredible", "outstanding",
  "good", "nice", "lovely", "beautiful", "fabulous", "fab",
  // gratitude / agreement
  "thanks", "thank", "grateful", "appreciate", "appreciated",
  "yes", "yeah", "yep", "yay", "woohoo",
  // success / win
  "win", "won", "winning", "success", "successful", "succeeded",
  "celebrate", "celebrating",
  // calm positive
  "enjoy", "enjoyed", "enjoying", "fun", "cool", "pleased", "pleasant",
  "smile", "smiling", "laugh", "laughing", "lol",
]);

const NEGATIVE_WORDS = new Set([
  // hatred / dislike
  "hate", "hated", "hates", "hating", "loathe", "despise", "disgusted",
  "dislike", "disliked",
  // anger
  "angry", "furious", "mad", "rage", "enraged", "pissed", "annoyed",
  "annoying", "irritated", "irritating",
  // frustration / sadness
  "frustrated", "frustrating", "frustration", "sad", "sadness",
  "depressed", "depressing", "miserable", "unhappy", "upset",
  "cry", "crying", "tears", "grief", "lonely",
  // fear / worry
  "afraid", "scared", "fear", "fearful", "worried", "worry",
  "anxious", "anxiety", "panic", "nervous", "stressed", "stress",
  // judgment / failure
  "wrong", "bad", "terrible", "horrible", "awful", "worst", "worse",
  "broken", "fail", "failed", "failure", "failing", "stupid", "dumb",
  "useless", "pointless", "hopeless", "ugly",
  // pain
  "pain", "painful", "hurt", "hurts", "hurting", "sick", "tired",
  "exhausted", "sucks", "sucked", "suck",
]);

// Tokens that carry no affect on their own but the scorer must not crash on.
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "at", "for", "is", "are",
  "was", "were", "be", "been", "being", "do", "does", "did", "and",
  "or", "but", "this", "that", "these", "those", "it", "its", "i",
  "you", "he", "she", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "our", "their",
]);

// Magnitude floor below which we collapse to sign=0 / magnitude=0. Closes
// the small-signal degenerate-sign reviewer finding (spec § CAPS.VALENCE_SIGN_THRESHOLD).
// Local alias of VALENCE_SCORER_CAPS.SIGN_THRESHOLD for readability in the
// hot path; CAPS remains the single source of truth.
const SIGN_THRESHOLD = VALENCE_SCORER_CAPS.SIGN_THRESHOLD;

// Below this token count (post-stopword strip) the input is too short to
// trust a magnitude — fall back to neutral.
const MIN_TOKEN_THRESHOLD = VALENCE_SCORER_CAPS.MIN_TOKEN_THRESHOLD;

// Module-level telemetry. Counts the two flavors of "sign=0" outcomes:
//   - true_neutral: post-tokenization the input was truly without affect
//     (no lexicon hits, OR balanced hits with normalized magnitude under
//     the SIGN_THRESHOLD). The downstream scorer can interpret this as
//     "this turn carried no mood signal".
//   - defaulted_neutral: the input was rejected upstream of the lexicon
//     pass (empty string, whitespace-only, too few meaningful tokens). The
//     downstream scorer should NOT interpret this as a confident neutral.
// Both produce sign=0 in the returned object but the operator-facing
// telemetry distinguishes them so dashboards can see the prevalence of
// "we had no chance to measure" vs "we measured and saw nothing."
const _telemetry = {
  neutral_bias_emit_true: 0,
  neutral_bias_emit_defaulted: 0,
  overlay_applied: 0,
  structural_override_applied: 0,
};

export function getValenceTelemetry() {
  return Object.freeze({
    neutral_bias_emit_true: _telemetry.neutral_bias_emit_true,
    neutral_bias_emit_defaulted: _telemetry.neutral_bias_emit_defaulted,
    overlay_applied: _telemetry.overlay_applied,
    structural_override_applied: _telemetry.structural_override_applied,
  });
}

export function resetValenceTelemetry() {
  _telemetry.neutral_bias_emit_true = 0;
  _telemetry.neutral_bias_emit_defaulted = 0;
  _telemetry.overlay_applied = 0;
  _telemetry.structural_override_applied = 0;
}

/**
 * overlayLexicons — documented helper. Merge a per-call overlay lexicon
 * into the base POSITIVE_WORDS / NEGATIVE_WORDS sets without mutating
 * either. The overlay shape mirrors the base sets:
 *
 *   { positive?: string[]|Set<string>, negative?: string[]|Set<string> }
 *
 * Discipline:
 *   - Inputs are NEVER mutated. Returns frozen { positive, negative } pair.
 *   - Overlay-side tokens are lowercased before the merge; the base sets
 *     are already lowercase.
 *   - If a token appears in both POSITIVE_WORDS and the overlay's
 *     `negative` set (or vice versa), the OVERLAY wins. Callers are
 *     trusted to know what they are doing when they supply an overlay
 *     (e.g. domain-specific corrections from the damping-log feedback
 *     loop). The overlay_applied telemetry counter increments once per
 *     non-empty overlay merge for operator visibility.
 *   - When overlay is null/undefined, returns the bare base sets (cheap;
 *     no copy).
 *
 * Single-producer note: scoreValence is the only caller in the substrate
 * today; callers outside the substrate should NOT consume this helper —
 * it is exported only so the test harness can exercise it directly.
 *
 * @param {{positive?: string[]|Set<string>, negative?: string[]|Set<string>}|null} overlay
 * @returns {{positive: Set<string>, negative: Set<string>}}
 */
export function overlayLexicons(overlay) {
  if (overlay == null || typeof overlay !== "object") {
    return { positive: POSITIVE_WORDS, negative: NEGATIVE_WORDS };
  }
  const overlayPos = overlay.positive;
  const overlayNeg = overlay.negative;
  const hasPos = overlayPos != null
    && (Array.isArray(overlayPos) || overlayPos instanceof Set);
  const hasNeg = overlayNeg != null
    && (Array.isArray(overlayNeg) || overlayNeg instanceof Set);
  if (!hasPos && !hasNeg) {
    return { positive: POSITIVE_WORDS, negative: NEGATIVE_WORDS };
  }
  // Build the overlay token sets (lowercased) so the merge is
  // case-insensitive in line with the base sets.
  const posOverlay = new Set();
  if (hasPos) {
    const iter = overlayPos instanceof Set ? overlayPos : overlayPos;
    for (const t of iter) {
      if (typeof t === "string") posOverlay.add(t.toLowerCase());
    }
  }
  const negOverlay = new Set();
  if (hasNeg) {
    const iter = overlayNeg instanceof Set ? overlayNeg : overlayNeg;
    for (const t of iter) {
      if (typeof t === "string") negOverlay.add(t.toLowerCase());
    }
  }
  // Compose: base ∪ overlay, with overlay winning on conflict (a token
  // appearing in the overlay's negative set is REMOVED from positive even
  // if the base treats it as positive).
  const positive = new Set(POSITIVE_WORDS);
  const negative = new Set(NEGATIVE_WORDS);
  for (const t of posOverlay) {
    positive.add(t);
    negative.delete(t);
  }
  for (const t of negOverlay) {
    negative.add(t);
    positive.delete(t);
  }
  if (posOverlay.size > 0 || negOverlay.size > 0) {
    _telemetry.overlay_applied += 1;
  }
  return { positive, negative };
}

/**
 * Tokenize: lowercase, strip non-letter chars, split on whitespace.
 * Apostrophes are stripped so "don't" → "dont" — keeps surface forms simple.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Score the valence of arbitrary text.
 *
 * @param {string} text — input prose. Empty string is valid (returns neutral).
 *   Non-string input throws TypeError per spec § F1.
 * @returns {{sign: -1 | 0 | 1, magnitude: number, source: 'lexicon' | 'model', model_version: string}}
 *   sign: dominant polarity of lexicon hits; 0 means no signal / balanced.
 *   magnitude: hit-density normalized to [0, 1]; 0 means no signal.
 *   source: always 'lexicon' in v0.
 *   model_version: snapshot tag for downstream cross-version reconciliation.
 */
export function scoreValence(text, opts = {}) {
  if (typeof text !== "string") {
    throw new TypeError(
      `scoreValence: expected string, got ${typeof text}`,
    );
  }

  // Neutral sentinel (returned for empty input, no hits, balanced, etc.).
  const NEUTRAL = {
    sign: 0,
    magnitude: 0,
    source: "lexicon",
    model_version: MODEL_VERSION,
  };

  // defaulted-neutral path (input rejected upstream of the lexicon pass).
  if (text.trim() === "") {
    _telemetry.neutral_bias_emit_defaulted += 1;
    return NEUTRAL;
  }

  const tokens = tokenize(text);
  if (tokens.length === 0) {
    _telemetry.neutral_bias_emit_defaulted += 1;
    return NEUTRAL;
  }

  const meaningful = tokens.filter((t) => !STOPWORDS.has(t));
  if (meaningful.length < MIN_TOKEN_THRESHOLD) {
    _telemetry.neutral_bias_emit_defaulted += 1;
    return NEUTRAL;
  }

  // Structural override path — when opts.structural carries a high-confidence
  // signed valence (e.g. from a damping-log signal_kind row), and its
  // confidence meets the STRUCTURAL_OVERRIDE_THRESHOLD CAPS knob, take its
  // sign+magnitude verbatim and bypass the lexicon pass. The override
  // counter increments so calibration can see how often it fires.
  if (opts.structural && typeof opts.structural === "object") {
    const c = opts.structural;
    if (
      typeof c.confidence === "number"
      && c.confidence >= VALENCE_SCORER_CAPS.STRUCTURAL_OVERRIDE_THRESHOLD
      && (c.sign === -1 || c.sign === 0 || c.sign === 1)
      && typeof c.magnitude === "number"
      && c.magnitude >= 0 && c.magnitude <= 1
    ) {
      _telemetry.structural_override_applied += 1;
      return {
        sign: c.sign,
        magnitude: c.magnitude,
        source: "lexicon",
        model_version: MODEL_VERSION,
      };
    }
  }

  // Compute the active lexicon sets (base ∪ opts.overlay). The helper
  // returns the bare base sets when opts.overlay is absent — no copy cost
  // on the common path.
  const { positive, negative } = overlayLexicons(opts.overlay ?? null);

  let posHits = 0;
  let negHits = 0;
  for (const t of meaningful) {
    if (positive.has(t)) posHits += 1;
    else if (negative.has(t)) negHits += 1;
  }

  const totalHits = posHits + negHits;
  if (totalHits === 0) {
    // True-neutral: we tokenized, stripped stopwords, walked the lexicon
    // and saw NO valence-bearing token. Distinguished from defaulted-
    // neutral above so the operator dashboard can see real coverage.
    _telemetry.neutral_bias_emit_true += 1;
    return NEUTRAL;
  }

  // Net signed hits, normalized by sqrt(meaningful-token count). sqrt is
  // the same normalization as the spec § 6.1 step 7 — keeps short bursts
  // from saturating and prevents long flat texts from compounding.
  const net = posHits - negHits;
  const netNormalized = net / Math.sqrt(meaningful.length);

  if (Math.abs(netNormalized) < SIGN_THRESHOLD) {
    // True-neutral: balanced positive/negative hits cancelled below the
    // sign threshold. We MEASURED a signal but it was too small.
    _telemetry.neutral_bias_emit_true += 1;
    return NEUTRAL;
  }

  const sign = netNormalized > 0 ? 1 : -1;
  const magnitude = Math.min(Math.abs(netNormalized), 1.0);

  return {
    sign,
    magnitude,
    source: "lexicon",
    model_version: MODEL_VERSION,
  };
}

/**
 * factValenceScalar — the SINGLE projection from a structured ValenceValue
 * object (as stamped on a fact's features.valence by the promote chokepoint)
 * down to the scalar ∈ [-1, +1] the index / scorer layer consumes.
 *
 * WORKUNIT A-promote-projection (MAP finding N2.4): two index write paths
 * previously diverged — index-cache.js (rebuild path) projected null when
 * features.valence was not already a number, while updateIndicesForFact
 * (incremental-add path) HARDCODED valence:null. Neither matched the
 * multi-feature scorer's valenceCompat contract (a number ∈ [-1,+1] or null).
 * This function is the one place that defines the projection so BOTH paths
 * apply it identically:
 *
 *   - object {sign, magnitude}     -> sign * clamp01(magnitude)   ∈ [-1, +1]
 *   - already a finite number      -> clamped to [-1, +1] (back-compat for a
 *                                     row that pre-projected the scalar)
 *   - null / absent / malformed    -> null   (no signal; valenceCompat -> 0)
 *
 * The sign*magnitude product (NOT bare sign) is chosen so a faint positive
 * ("good" once in a long technical commit) ranks below a strong positive
 * ("amazing wonderful thank you"); valenceCompat then measures emotion-axis
 * distance on the same continuous scale the query side is scored on.
 *
 * Pure, defensive, no I/O — safe to call from the durability-critical
 * appendFactRow path and from the recall index projection.
 *
 * @param {unknown} valence — a ValenceValue object, a number, or null.
 * @returns {number|null} scalar ∈ [-1, +1], or null when there is no signal.
 */
export function factValenceScalar(valence) {
  if (valence == null) return null;
  // Back-compat: a row that already carries a numeric scalar (legacy or a
  // future projection-at-write path) clamps straight through.
  if (typeof valence === "number") {
    if (!Number.isFinite(valence)) return null;
    return valence < -1 ? -1 : valence > 1 ? 1 : valence;
  }
  if (typeof valence !== "object") return null;
  const sign = valence.sign;
  const magnitude = valence.magnitude;
  // A scorer that produced source:'absent' (or any non-measuring sentinel) or
  // a neutral sign 0 carries no emotion-axis signal — project to null so
  // valenceCompat reads "no signal" rather than a confident 0.0 match.
  if (valence.source === "absent") return null;
  if (sign !== -1 && sign !== 0 && sign !== 1) return null;
  if (sign === 0) return null;
  if (typeof magnitude !== "number" || !Number.isFinite(magnitude)) return null;
  const mag = magnitude < 0 ? 0 : magnitude > 1 ? 1 : magnitude;
  if (mag === 0) return null;
  return sign * mag;
}
