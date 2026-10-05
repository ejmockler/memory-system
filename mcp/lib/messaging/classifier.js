// classifier.js — L2 addressing classifier: `directed_at_me`, degradation-aware.
//
// classifyDirectedAtMe(envelope) -> { score, directed, reasons, signals,
// weights_used, model_version }. It answers ONE question for the attention
// engine and catch-up surface: "is this message directed at the operator?" —
// as a continuous score plus a small, auditable explanation.
//
// THE INVARIANT (the live proof of the abstraction): this file imports NO
// adapter and contains ZERO platform names. Every platform's degradation is
// already encoded by its adapter into the envelope's `capabilities{}` block;
// this scorer degrades by reading those booleans, never by branching on a
// platform identity. There is no `if (platform === ...)` anywhere — the scorer
// does not even read `envelope.platform` (it is DATA the surface displays, not
// control flow). A grep for any platform token over this file returns 0; that
// is half the node's gate.
//
// THE MECHANISM (degrade-via-data, weight-conserving): the evidence channels
// (`addressed_to_me`, `reply_to_me`, `mention_me`) carry NOMINAL weights that
// sum to a constant W. At score time each channel is either ACTIVE (its
// capability permits it AND its signal is a usable boolean) or DEAD (capability
// false, or signal null/absent — "the platform cannot tell"). The dead
// channels' nominal weight is REDISTRIBUTED proportionally across the active
// channels, re-normalizing them back to W. Consequences:
//   - absence of a capability never silently reads as "not directed at me"
//     (a dead channel contributes nothing AND drags nothing down — its weight
//     moves to surviving evidence, it is not scored as a zero);
//   - flipping a single capability bit (e.g. reply_to_available) moves a
//     channel between the active/dead partitions, which re-normalizes every
//     other channel's EFFECTIVE weight — so the score measurably moves from
//     DATA alone. That measurable delta is the other half of the node's gate.
//
// PURITY (Thesis #1, read-only projection): pure and synchronous. No I/O, no
// clock read, no random draw, no mutation of the input envelope or anything
// else. `envelope -> score`. All numbers live in one Object.freeze'd
// CLASSIFIER_CAPS tagged by MODEL_VERSION; changing a weight requires a version
// bump. Modeled on the pure-function / frozen-CAPS / telemetry discipline of
// lib/synthesis/valence-scorer.js.

export const MODEL_VERSION = "directed-at-me-v1";

// ---------------------------------------------------------------------------
// CLASSIFIER_CAPS — the single, frozen source of every magic number. Bumping
// ANY value here REQUIRES a MODEL_VERSION bump because downstream consumers
// (the attention engine, the catch-up surface) pin to the emitted version and
// audit `weights_used`. Object.freeze enforces single-producer discipline at
// module load; the nested blocks are frozen too so a caller cannot mutate a
// weight through a reference.
// ---------------------------------------------------------------------------
export const CLASSIFIER_CAPS = Object.freeze({
  // Nominal evidence-channel weights. These sum to W (see W, asserted at load).
  // `addressed_to_me` carries the LARGEST nominal weight: when first-class
  // addressing is available it is the strongest, most explicit "this is for
  // you" signal a platform can give (a structured To/Cc membership fact).
  WEIGHTS: Object.freeze({
    addressed_to_me: 0.5,
    reply_to_me: 0.3,
    mention_me: 0.2,
  }),

  // The thread-shape prior. A dm inherently directs BOTH participants, so a
  // bare dm with no positive signal still carries a meaningful baseline. A
  // group/channel directs no one in particular — it needs a positive
  // mention/reply/addressing signal to score. This prior is ADDED to the
  // (weight-conserving) evidence score and the sum is clamped to [0, 1].
  DM_PRIOR: 0.5,
  GROUP_PRIOR: 0.0,
  CHANNEL_PRIOR: 0.0,

  // Down-weight knobs for WEAK evidence. Both are multiplicative discounts on
  // the `mention_me` channel's contribution, applied to its EFFECTIVE weight:
  //   - SELF_UNRELIABLE_MENTION_FACTOR: applied when self-identity is not
  //     reliable (a masked self-id means an @-mention cannot be trusted to be
  //     "me" — it may be a false positive or a missed match).
  //   - UNSTRUCTURED_MENTION_FACTOR: applied when mentions are not structured
  //     (a text-scanned @token is weaker than a structured mention field).
  // Both can compound (unreliable self-id AND unstructured mentions => weakest).
  SELF_UNRELIABLE_MENTION_FACTOR: 0.4,
  UNSTRUCTURED_MENTION_FACTOR: 0.7,

  // A boolean evidence signal that is TRUE contributes its channel's full
  // effective weight; a signal that is FALSE (known-negative, distinct from
  // null/unknown) contributes nothing AND keeps its weight in the active set,
  // so it lowers the normalized score of the surviving TRUE channels. This is
  // the `false` vs `null` distinction made concrete: `false` is evidence
  // against (stays active, scores 0), `null` is no-evidence (goes dead,
  // redistributes). FALSE_SIGNAL_VALUE makes that "scores 0" explicit/tunable.
  FALSE_SIGNAL_VALUE: 0.0,

  // PARTIAL redistribution fraction ∈ (0,1]. When a channel goes DEAD (its
  // capability is false, or its signal is null/unknown), only this FRACTION of
  // its nominal weight is redistributed to the surviving active channels; the
  // remainder is FORFEIT (it shrinks the attainable score ceiling for that
  // envelope). This is the keystone of the degradation gate:
  //   - A platform that genuinely CANNOT observe a channel has less total
  //     evidence capacity than one that can — so an all-positive message on the
  //     degraded platform scores slightly LOWER (the measurable capability-flip
  //     delta A4 demands), reflecting "we are less able to know here".
  //   - Yet the surviving channels still ABSORB most of the dead weight, so a
  //     can't-tell channel is NEVER scored as a negative: a redistributed
  //     mention beats the same mention sitting next to a KNOWN-negative reply
  //     (A5). Absence (null) ≠ evidence-against (false).
  // At 1.0 this collapses to full conservation (and the all-positive delta
  // vanishes); strictly < 1.0 makes capability loss a real, measurable cost.
  REDISTRIBUTION_FRACTION: 0.6,

  // directed = score >= DIRECTED_THRESHOLD. Set at the DM_PRIOR so a bare dm is
  // exactly on the boundary of "directed" — a dm with any corroborating signal
  // is directed; a bare group/channel with no signal is not.
  DIRECTED_THRESHOLD: 0.5,

  // Float comparison epsilon for the weight-conservation invariant (tests +
  // internal guards). Not a behavioural knob.
  EPSILON: 1e-9,
});

// W — the constant total of the nominal evidence weights. Computed from CAPS so
// it can never drift from the WEIGHTS block. Frozen by value (a number).
export const W = Object.values(CLASSIFIER_CAPS.WEIGHTS).reduce(
  (a, b) => a + b,
  0,
);

// Load-time self-check: WEIGHTS must be a positive, finite partition summing to
// a positive W. This is a construction guard (not runtime control flow); if it
// fails, the module is mis-specified and we fail loudly at import rather than
// silently produce garbage scores.
if (!(W > 0) || !Number.isFinite(W)) {
  throw new Error(
    `classifier.js: CLASSIFIER_CAPS.WEIGHTS must sum to a positive finite W (got ${W})`,
  );
}

// The agnostic reason-token vocabulary. Frozen so the set is auditable and
// closed; NONE of these is a platform name (that is enforced by the grep gate).
export const REASONS = Object.freeze({
  IS_FROM_ME_SHORTCIRCUIT: "is_from_me_shortcircuit",
  DM_PRIOR: "dm",
  ADDRESSED_TO_ME: "addressed_to_me",
  REPLY_TO_ME: "reply_to_me",
  MENTION_ME: "mention_me",
  REPLY_TO_UNAVAILABLE_REDISTRIBUTED: "reply_to_unavailable_redistributed",
  ADDRESSING_UNAVAILABLE_REDISTRIBUTED: "addressing_unavailable_redistributed",
  SELF_IDENTITY_UNRELIABLE_DOWNWEIGHTED: "self_identity_unreliable_downweighted",
  UNSTRUCTURED_MENTION_DOWNWEIGHTED: "unstructured_mention_downweighted",
  ALL_CHANNELS_DEAD: "all_channels_dead_thread_prior_only",
});

// ---------------------------------------------------------------------------
// Module-level telemetry. Counts the degradation paths the scorer takes so an
// operator dashboard can see how often real corpora hit each degraded branch.
// Reading/resetting is explicit; the hot path only increments. (Telemetry is
// an OBSERVATION side-channel, not part of the pure score — the same envelope
// always yields the same score regardless of telemetry state.)
// ---------------------------------------------------------------------------
const _telemetry = {
  is_from_me_shortcircuit: 0,
  reply_to_redistributed: 0,
  addressing_redistributed: 0,
  self_identity_downweighted: 0,
  unstructured_downweighted: 0,
  all_channels_dead: 0,
};

export function getClassifierTelemetry() {
  return Object.freeze({ ..._telemetry });
}

export function resetClassifierTelemetry() {
  for (const k of Object.keys(_telemetry)) _telemetry[k] = 0;
}

// ---------------------------------------------------------------------------
// Defensive readers. The classifier conforms to N1 but does NOT assume the
// caller pre-validated: a malformed or partial envelope must yield a safe,
// finite score, never a throw or NaN (total-function safety, tests A12). These
// helpers normalize the two input blocks into a known shape with safe defaults.
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// A signal channel is USABLE only when it is a strict boolean. Anything else
// (null = "platform cannot tell", or absent/garbage = defensive unknown) is
// treated as null/unknown -> the channel goes DEAD and its weight redistributes.
// This is where `false` (a usable boolean: evidence-against) is kept distinct
// from `null` (unusable: no evidence).
function readSignal(block, key) {
  if (!isPlainObject(block)) return null;
  const v = block[key];
  return v === true || v === false ? v : null;
}

// A capability defaults to FALSE (the most degraded, most conservative reading)
// when missing or non-boolean: an absent capability must never grant a channel
// MORE trust than an explicit one. Defensive by construction.
function readCapability(block, key) {
  if (!isPlainObject(block)) return false;
  return block[key] === true;
}

// ---------------------------------------------------------------------------
// classifyDirectedAtMe — the single public scorer.
// ---------------------------------------------------------------------------

/**
 * Score whether an envelope is directed at the operator.
 *
 * Pure, synchronous, throws nothing, mutates nothing. Degrades by reading
 * `capabilities{}` booleans; contains and branches on ZERO platform names.
 *
 * @param {*} envelope - an Envelope (any type; non-objects degrade safely).
 * @returns {{
 *   score: number,            // ∈ [0,1]
 *   directed: boolean,        // score >= DIRECTED_THRESHOLD
 *   reasons: string[],        // agnostic tokens (REASONS vocabulary)
 *   signals: { mention_me: (boolean|null), reply_to_me: (boolean|null), addressed_to_me: (boolean|null) },
 *   weights_used: Object,     // effective weights per channel + thread prior (audit)
 *   model_version: string
 * }}
 */
export function classifyDirectedAtMe(envelope) {
  const env = isPlainObject(envelope) ? envelope : {};

  // --- Short-circuit: a message I sent is never "directed at me" / waiting on
  // me. This fires BEFORE any channel math, regardless of every other signal.
  if (env.is_from_me === true) {
    _telemetry.is_from_me_shortcircuit += 1;
    return {
      score: 0,
      directed: false,
      reasons: [REASONS.IS_FROM_ME_SHORTCIRCUIT],
      signals: { mention_me: null, reply_to_me: null, addressed_to_me: null },
      weights_used: {},
      model_version: MODEL_VERSION,
    };
  }

  const sig = env.directed_at_me_signals;
  const caps = env.capabilities;

  const mentionMe = readSignal(sig, "mention_me");
  const replyToMe = readSignal(sig, "reply_to_me");
  const addressedToMe = readSignal(sig, "addressed_to_me");

  const replyToAvailable = readCapability(caps, "reply_to_available");
  const structuredMentions = readCapability(caps, "structured_mentions");
  const selfIdentityReliable = readCapability(caps, "self_identity_reliable");
  const addressingFirstClass = readCapability(caps, "addressing_first_class");

  const reasons = [];

  // --- Build the channel table. Each channel records:
  //   nominal      : its CAPS weight (the slice of W it would carry if active);
  //   active       : capability permits it AND its signal is a usable boolean;
  //   value        : when active, the signal's contribution fraction in [0,1]
  //                  (TRUE -> 1, FALSE -> FALSE_SIGNAL_VALUE);
  //   factor       : multiplicative discount on the EFFECTIVE weight (mentions
  //                  only — self-id / structured down-weights).
  // A DEAD channel (active=false) is dropped from the active partition and its
  // nominal weight is redistributed across the survivors (see below).
  const W_ = CLASSIFIER_CAPS.WEIGHTS;
  const channels = {
    addressed_to_me: {
      nominal: W_.addressed_to_me,
      // Gated by first-class addressing: when the platform has no first-class
      // addressing, `addressed_to_me` contributes ZERO — the channel is dead
      // and its weight redistributes (it must NOT dominate, or even count,
      // without the capability).
      active: addressingFirstClass && addressedToMe !== null,
      value: addressedToMe === true ? 1 : CLASSIFIER_CAPS.FALSE_SIGNAL_VALUE,
      factor: 1,
    },
    reply_to_me: {
      nominal: W_.reply_to_me,
      // Gated by reply availability: when the platform cannot store a reply
      // target the channel is unknown -> dead -> redistributed (absence is NOT
      // scored as a negative).
      active: replyToAvailable && replyToMe !== null,
      value: replyToMe === true ? 1 : CLASSIFIER_CAPS.FALSE_SIGNAL_VALUE,
      factor: 1,
    },
    mention_me: {
      nominal: W_.mention_me,
      // Always permitted when the signal is a usable boolean (every platform
      // can carry SOME notion of a mention). Its TRUST is what degrades, via
      // the factor below — not its presence.
      active: mentionMe !== null,
      value: mentionMe === true ? 1 : CLASSIFIER_CAPS.FALSE_SIGNAL_VALUE,
      factor: 1,
    },
  };

  // Down-weight the mention channel for weak evidence. These shrink its
  // EFFECTIVE weight (not its nominal), so the shrunk remainder is itself
  // redistributable mass — weak evidence yields less score AND lets stronger
  // surviving channels absorb the slack. Only emit a reason when the mention
  // channel is actually active AND positive (a discount on a dead/false-channel
  // is invisible and should not pollute the explanation).
  const mentionPositiveActive =
    channels.mention_me.active && mentionMe === true;
  if (!selfIdentityReliable) {
    channels.mention_me.factor *= CLASSIFIER_CAPS.SELF_UNRELIABLE_MENTION_FACTOR;
    if (mentionPositiveActive) {
      reasons.push(REASONS.SELF_IDENTITY_UNRELIABLE_DOWNWEIGHTED);
      _telemetry.self_identity_downweighted += 1;
    }
  }
  if (!structuredMentions) {
    channels.mention_me.factor *= CLASSIFIER_CAPS.UNSTRUCTURED_MENTION_FACTOR;
    if (mentionPositiveActive) {
      reasons.push(REASONS.UNSTRUCTURED_MENTION_DOWNWEIGHTED);
      _telemetry.unstructured_downweighted += 1;
    }
  }

  // Redistribution reasons: a DEAD gated channel announces that its weight was
  // redistributed (so a downstream auditor sees "this platform could not tell,
  // its weight moved" rather than inferring a silent zero).
  if (!replyToAvailable) {
    reasons.push(REASONS.REPLY_TO_UNAVAILABLE_REDISTRIBUTED);
    _telemetry.reply_to_redistributed += 1;
  }
  if (!addressingFirstClass) {
    reasons.push(REASONS.ADDRESSING_UNAVAILABLE_REDISTRIBUTED);
    _telemetry.addressing_redistributed += 1;
  }

  // --- Weight conservation / redistribution. Partition into active vs dead.
  // The active channels' nominal weights are RE-NORMALIZED so they sum back to
  // W exactly (the dead channels' nominal mass is shared proportionally). These
  // renormalized weights are what `weights_used` reports and what the
  // conservation invariant asserts: Σ active weights_used === W. This is the
  // mechanism that makes the gate delta appear — toggling a capability moves a
  // channel between active/dead, re-normalizing every survivor's weight.
  //
  // The mention TRUST discount (`factor`) is applied SEPARATELY, ON TOP of the
  // conserved weight, only when computing the score contribution. It is a
  // genuine trust reduction (weak evidence earns less score) and is reported
  // out-of-band in `trust_factors` so the conserved partition stays clean:
  // weights are conserved (Σ = W); trust is a per-channel multiplier in [0,1].
  const activeKeys = Object.keys(channels).filter((k) => channels[k].active);
  const activeNominalSum = activeKeys.reduce(
    (s, k) => s + channels[k].nominal,
    0,
  );
  // Dead nominal mass = the slice of W carried by channels that went dead
  // (capability false or signal null). Only REDISTRIBUTION_FRACTION of it is
  // recoverable; the rest is a real, measurable loss of evidence capacity.
  const deadNominalSum = W - activeNominalSum;
  const recoverable =
    deadNominalSum * CLASSIFIER_CAPS.REDISTRIBUTION_FRACTION;
  // The conserved total the active partition re-normalizes UP to. ≤ W, equal to
  // W only when nothing is dead (or REDISTRIBUTION_FRACTION === 1). This is the
  // exact quantity the conservation invariant (A8) asserts the active
  // weights_used sum to.
  const conservedTotal = activeNominalSum + recoverable;

  const weights_used = {};
  const trust_factors = {};
  let evidenceScore = 0;

  if (activeKeys.length === 0 || activeNominalSum <= CLASSIFIER_CAPS.EPSILON) {
    // Degenerate guard: every channel dead (all signals null/gated). No
    // divide-by-zero; the evidence score is 0 and the result rests entirely on
    // the thread prior below. Record it so the explanation is honest.
    reasons.push(REASONS.ALL_CHANNELS_DEAD);
    _telemetry.all_channels_dead += 1;
  } else {
    // Renormalize the active nominal mass UP to conservedTotal (each survivor
    // grows proportionally, absorbing the recoverable share of the dead mass).
    const renorm = conservedTotal / activeNominalSum;
    for (const k of activeKeys) {
      const ch = channels[k];
      // Conserved weight (sums to conservedTotal across active channels — the
      // A8 invariant). Reported as weights_used for downstream audit.
      const conservedWeight = ch.nominal * renorm;
      weights_used[k] = conservedWeight;
      trust_factors[k] = ch.factor;
      // Score contribution applies the trust discount on top of the conserved
      // weight. A discounted channel earns less score; the discounted mass is
      // NOT redistributed (trust loss is real, not transferable).
      evidenceScore += conservedWeight * ch.factor * ch.value;
      // Emit the positive-evidence reason token (only when the signal is TRUE
      // and meaningfully contributing — a FALSE active channel stays in the
      // active set to depress the normalized score but is not "a reason this is
      // directed at me").
      if (ch.value > CLASSIFIER_CAPS.FALSE_SIGNAL_VALUE) {
        if (k === "addressed_to_me") reasons.push(REASONS.ADDRESSED_TO_ME);
        else if (k === "reply_to_me") reasons.push(REASONS.REPLY_TO_ME);
        else if (k === "mention_me") reasons.push(REASONS.MENTION_ME);
      }
    }
  }

  // Normalize the evidence score from the W scale into [0, 1]. W is the maximum
  // attainable evidence mass — every channel ACTIVE and TRUE with full trust —
  // so dividing by W yields a clean [0,1] evidence fraction. A degraded
  // envelope (channels dead) re-normalizes only to conservedTotal ≤ W, so its
  // all-positive ceiling is < 1: capability loss is a measurable score cost.
  const evidenceFraction = evidenceScore / W;

  // --- Thread-shape prior. dm adds DM_PRIOR; group/channel add their prior
  // (0 by default). The prior is agnostic top-level data (thread_type enum),
  // never a platform field.
  let prior = CLASSIFIER_CAPS.GROUP_PRIOR;
  if (env.thread_type === "dm") {
    prior = CLASSIFIER_CAPS.DM_PRIOR;
    reasons.push(REASONS.DM_PRIOR);
  } else if (env.thread_type === "channel") {
    prior = CLASSIFIER_CAPS.CHANNEL_PRIOR;
  } else {
    // group OR any unrecognized/missing thread_type -> the conservative
    // group prior (0). No throw on a bad enum (total-function safety).
    prior = CLASSIFIER_CAPS.GROUP_PRIOR;
  }

  // Combine prior + evidence and clamp to [0, 1]. The prior occupies the
  // baseline; evidence raises the score toward 1. We blend so that a bare dm
  // sits at DM_PRIOR and positive evidence pushes it up, while a bare group
  // sits at ~0 until evidence arrives.
  // evidenceFraction ∈ [0,1] is mapped into the remaining headroom above the
  // prior, so prior + evidenceFraction*(1-prior) ∈ [prior, 1].
  let score = prior + evidenceFraction * (1 - prior);

  // Defensive clamp + NaN/Infinity guard (total-function safety, tests A12).
  if (!Number.isFinite(score)) score = 0;
  if (score < 0) score = 0;
  if (score > 1) score = 1;

  const directed = score >= CLASSIFIER_CAPS.DIRECTED_THRESHOLD;

  // Record the thread prior in weights_used too (auditors see the full
  // decomposition: per-channel effective weights + the prior contribution).
  weights_used.thread_prior = prior;

  return {
    score,
    directed,
    reasons,
    signals: {
      mention_me: mentionMe,
      reply_to_me: replyToMe,
      addressed_to_me: addressedToMe,
    },
    weights_used,
    trust_factors,
    model_version: MODEL_VERSION,
  };
}
