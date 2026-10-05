// lib/messaging/person-enrichment.js — WORKUNIT M1, the PERSON-ENRICHMENT SEAM
// (the W0 barrier / spine of the WHO-MATTERS attention model).
//
// MISSION (per TOPOLOGY.md): invert the catch-up surface from a DENYLIST (detect
// + exclude noise — exhausted at the single-shot wall) to a POSITIVE "who
// matters" anchor. Rank people you have a relationship with ABOVE unanchored
// strangers; NEVER separate spam from a genuine new contact (undecidable in the
// message) — both stay in an honest UNKNOWN tier at the existing NEW_CONTACT
// floor. This module owns the CONTRACT that later waves (M2 contacts, M3
// feedback, M5 anchoring) fill in with real signals.
//
// THE CONTRACT (what this file IS):
//   (1) an ENRICHMENT SHAPE — the read-only, per-person bundle of who-matters
//       signals: {person_id, is_contact, reciprocity_strength, feedback_score,
//       anchor_factor}. It is DATA, derived at query time, never persisted.
//   (2) anchorFactor(enrichment) -> a MONOTONE multiplier in (0, 1+]. Each
//       positive signal (is_contact, feedback_score, reciprocity_strength) only
//       ever LIFTS the factor; NO signal present => 1.0 (neutral). It NEVER
//       returns below 1.0 — anchored people UP-rank; cold/unknown people stay at
//       the existing NEW_CONTACT floor (a hard-drop is structurally impossible
//       here, by the clamp). This is the HARD CONSTRAINT: monotone UP-rank only.
//   (3) makeNeutralEnricher() — the DEFAULT resolver. It returns a NEUTRAL
//       enrichment (anchor_factor === 1.0) for EVERY person, so when no real
//       signals are wired the ranking is BYTE-IDENTICAL to today (gate-OFF
//       safety). This is the resolver buildCatchupCore injects by default.
//   (4) the INJECTION CONTRACT — an `enrichPerson(person_id) -> Enrichment`
//       resolver, injected at buildCatchupCore EXACTLY like resolvePerson (N7):
//       built ONCE at buildCatchup over the loaded envelopes, soft-guarded to the
//       neutral enrichment on any error, threaded into the rank loop as a
//       CACHED O(1) lookup, never a live call inside the loop, never coupled to a
//       mutable store. Determinism for unit tests is preserved.
//
// HARD CONSTRAINTS (from the brutalist falsification — non-negotiable):
//   - The enrichment is sourced from L1 envelopes (contacts / reciprocity /
//     feedback), NOT the fact-ledger (86.8% git-log OSS strangers + slugified
//     noise — it models "who your code touches", not who matters socially).
//   - anchorFactor is MONOTONE in (0, 1+]; cold/unknown => 1.0 neutral; NEVER a
//     hard-drop (the floor is the existing reciprocity NEW_CONTACT floor, owned
//     by catchup's reciprocityStrength — this module only ever multiplies UP).
//   - DEFAULT resolver returns NEUTRAL (anchor_factor === 1.0), so the gate is
//     OFF by default and the base ranking is unchanged byte-for-byte.
//   - ZERO platform tokens: this module names no platform. The person_id is an
//     OPAQUE string (whatever N7 / the injected resolver produced); it is never
//     branched on by platform.
//
// PURE: no I/O, no mutation, no throw on odd input. Same input => same output
// (deterministic — the unit-test invariant the seam exists to protect).

// ---------------------------------------------------------------------------
// ANCHOR_CAPS — the single, frozen source of every anchor-weight magic number.
// Object.freeze enforces single-producer discipline; later waves (M2/M3/M5) tune
// HERE (DATA), never by branching on a signal in a function body. The brutalist
// gate: all control is DATA. Every weight is documented + bounded.
// ---------------------------------------------------------------------------
export const ANCHOR_CAPS = Object.freeze({
  // The NEUTRAL anchor factor: a no-op multiplier in rankScore's product. This is
  // the floor of anchorFactor — cold / unknown / no-signal people earn EXACTLY
  // this, so their rank is unchanged from today. anchorFactor never returns below
  // it (monotone UP-rank only; never a hard-drop).
  ANCHOR_FACTOR_NEUTRAL: 1.0,
  // The CEILING a fully-anchored person can earn (defends the projection: an
  // anchor signal lifts, but cannot blow past every other ranking factor). The
  // factor is clamped to [NEUTRAL, MAX].
  ANCHOR_FACTOR_MAX: 2.0,

  // ----- per-signal LIFTS (each adds to the factor above NEUTRAL; all >= 0) -----
  // is_contact: an explicit human vouch (M2 AddressBook). The strongest single
  // structural signal that a person matters — a binary lift.
  ANCHOR_CONTACT_LIFT: 0.5,
  // reciprocity_strength in [0,1] (the P2r relationship-strength factor, already
  // computed) scaled by this weight. A deep two-way relationship lifts the most.
  // Behavioral, already-have signal; the second pillar of who-matters.
  ANCHOR_RECIPROCITY_WEIGHT: 0.5,
  // feedback_score in [0,1] (M3 open/reply/dismiss/flag, read-side) scaled by this
  // weight. The unblocker signal: the operator's own triage, learned over time.
  ANCHOR_FEEDBACK_WEIGHT: 0.5,

  // ----- M5 TIER thresholds (the honest UNKNOWN/first-contact classification) -----
  // A surfaced row is one of TWO first-class tiers (NEVER a hard-drop — both are
  // surfaced; the UNKNOWN tier is ranked/grouped BELOW + LABELED, not deleted):
  //   - "relationship": a person you have a RELATIONSHIP with — an explicit saved
  //     contact (is_contact), OR positive operator feedback (feedback_score above
  //     TIER_FEEDBACK_MIN), OR a deep HIGH-turn two-way history with a PERSON sender
  //     (reciprocity_strength at/above the HIGH RELATIONSHIP_RECIP_MIN injected from
  //     CATCHUP_CAPS, AND sender.kind === "person"). At least ONE structural vouch.
  //     M5c: a MODERATE-reciprocity business (≈0.77, no contact, no feedback) is
  //     DEMOTED to "unknown" — reciprocity alone no longer crosses at the neutral.
  //   - "unknown": NONE of those. The honest first-contact/stranger tier — a cold
  //     node. A GENUINE brand-new contact lives here next to spam/business; the
  //     message alone cannot tell them apart, so M5 NEVER drops it — it surfaces it
  //     below the relationship tier, labeled, for the operator to decide.
  //
  // TIER_RECIPROCITY_MIN: the FALLBACK reciprocity threshold for classifyTier when
  //   the caller injects no `recip_min`. M5c moved the PRODUCTION threshold to a
  //   HIGH value owned by CATCHUP_CAPS.RELATIONSHIP_RECIP_MIN (≈0.9): a moderate-
  //   reciprocity business (≈0.77) is DEMOTED to "unknown", only a deep two-way
  //   PERSON history (at/above the high threshold) earns "relationship". This
  //   default (0.7, the new-contact neutral) is retained as the module's standalone
  //   fallback. Sourced from reciprocity, NOT the fact-ledger.
  TIER_RECIPROCITY_MIN: 0.7,
  // TIER_FEEDBACK_MIN: any positive feedback (>0) is the operator's own vouch — an
  //   explicit "this matters". The 0 floor is the never-triaged / net-negative
  //   neutral (stays "unknown").
  TIER_FEEDBACK_MIN: 0,
});

// The two first-class who-matters TIERS. RELATIONSHIP rows out-rank UNKNOWN rows
// (a coarse primary grouping ABOVE the fine-grained rankScore); UNKNOWN is the
// honest cold-node tier — surfaced + labeled, NEVER dropped.
export const TIER = Object.freeze({
  RELATIONSHIP: "relationship",
  UNKNOWN: "unknown",
});

// Sort rank of a tier (lower sorts FIRST). RELATIONSHIP before UNKNOWN. An
// unrecognized tier sorts as UNKNOWN (the conservative, never-promote default).
export const TIER_ORDER = Object.freeze({
  [TIER.RELATIONSHIP]: 0,
  [TIER.UNKNOWN]: 1,
});

// A frozen NEUTRAL enrichment: the byte-identical-ranking default. anchor_factor
// is exactly the neutral no-op multiplier; every signal is absent/zero. A null
// person_id means "unresolved / unknown person" (the conservative reading) — it
// still earns the neutral factor (NEVER a drop).
export const NEUTRAL_ENRICHMENT = Object.freeze({
  person_id: null,
  is_contact: false,
  reciprocity_strength: 0,
  feedback_score: 0,
  anchor_factor: ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL,
});

// ---------------------------------------------------------------------------
// Defensive readers (total over odd input; never throw).
// ---------------------------------------------------------------------------

// Read a finite number in [0,1] off an enrichment field; anything else => 0.
function unitSignal(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * anchorFactor(enrichment) -> a MONOTONE multiplier in [NEUTRAL, MAX].
 *
 * Each positive signal LIFTS the factor above the neutral baseline; NO signal
 * present => NEUTRAL (1.0, a no-op in rankScore's product). The factor NEVER
 * dips below NEUTRAL — this module only ever UP-ranks anchored people; cold /
 * unknown people stay at the existing NEW_CONTACT floor (a hard-drop is
 * structurally impossible here — the clamp guarantees it).
 *
 * MONOTONE: adding a signal (or raising a unit signal's value) only ever raises
 * (never lowers) the returned factor. The unit-test invariant: more signals =>
 * >= factor, never < the neutral floor.
 *
 * Total / defensive: a malformed / missing enrichment reads as zero-signal =>
 * NEUTRAL. Never throws.
 */
export function anchorFactor(enrichment) {
  const NEUTRAL = ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL;
  const MAX = ANCHOR_CAPS.ANCHOR_FACTOR_MAX;
  if (!isPlainObject(enrichment)) return NEUTRAL;

  // Each signal contributes a NON-NEGATIVE lift above the neutral baseline.
  const contactLift = enrichment.is_contact === true ? ANCHOR_CAPS.ANCHOR_CONTACT_LIFT : 0;
  const reciprocityLift = unitSignal(enrichment.reciprocity_strength) * ANCHOR_CAPS.ANCHOR_RECIPROCITY_WEIGHT;
  const feedbackLift = unitSignal(enrichment.feedback_score) * ANCHOR_CAPS.ANCHOR_FEEDBACK_WEIGHT;

  const factor = NEUTRAL + contactLift + reciprocityLift + feedbackLift;

  // Clamp to [NEUTRAL, MAX]: never below the floor (no hard-drop), never past the
  // ceiling (defends the projection). The product of non-negative lifts already
  // guarantees >= NEUTRAL; the Math.max is belt-and-suspenders for any future lift
  // that could be configured negative in CAPS.
  if (factor < NEUTRAL) return NEUTRAL;
  if (factor > MAX) return MAX;
  return factor;
}

/**
 * normalizeEnrichment(raw, person_id) -> a complete, frozen Enrichment shape with
 * its anchor_factor computed from anchorFactor(). Total: any malformed field
 * degrades to its neutral default, so the returned shape is ALWAYS complete and
 * the anchor_factor ALWAYS in [NEUTRAL, MAX]. Used by resolvers (and tests) to
 * stamp the canonical shape from partial signals.
 */
export function normalizeEnrichment(raw, person_id = null) {
  const src = isPlainObject(raw) ? raw : {};
  const shape = {
    person_id:
      typeof src.person_id === "string" && src.person_id.length > 0
        ? src.person_id
        : (typeof person_id === "string" && person_id.length > 0 ? person_id : null),
    is_contact: src.is_contact === true,
    reciprocity_strength: unitSignal(src.reciprocity_strength),
    feedback_score: unitSignal(src.feedback_score),
  };
  shape.anchor_factor = anchorFactor(shape);
  return Object.freeze(shape);
}

/**
 * makeNeutralEnricher() -> the DEFAULT enrichPerson resolver.
 *
 * Returns a NEUTRAL enrichment (anchor_factor === 1.0) for EVERY person_id. This
 * is the gate-OFF default injected at buildCatchupCore: with no real signals
 * wired, anchorFactor multiplies ×1.0 into every rankScore, so the ranking is
 * BYTE-IDENTICAL to the pre-M1 surface. The returned enrichment carries the
 * queried person_id (so a caller can still read it back) but is otherwise the
 * frozen NEUTRAL bundle.
 *
 * The resolver is PURE and DETERMINISTIC (same person_id => same enrichment),
 * and closes over NO mutable state — the seam's deterministic-test invariant.
 */
export function makeNeutralEnricher() {
  return function neutralEnrichPerson(person_id) {
    if (typeof person_id === "string" && person_id.length > 0) {
      // Carry the id back; all signals neutral, anchor_factor === 1.0.
      return Object.freeze({
        person_id,
        is_contact: false,
        reciprocity_strength: 0,
        feedback_score: 0,
        anchor_factor: ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL,
      });
    }
    return NEUTRAL_ENRICHMENT;
  };
}

/**
 * makeEnricherFromIndex(index, lookup) -> an enrichPerson resolver backed by a
 * PRECOMPUTED, CACHED index (the W1 wiring pattern M2/M3/M5 will use).
 *
 * `index` is any precomputed structure built ONCE at buildCatchup over the loaded
 * envelopes (NOT a live store — a query-time projection, Thesis #1). `lookup` is
 * `(index, person_id) -> partial-enrichment | null`. This factory:
 *   - SOFT-guards lookup: any throw, or a null/non-object result, degrades to the
 *     NEUTRAL enrichment (NEVER a hard-drop; deterministic fallback).
 *   - NORMALIZES the partial signals into the complete frozen shape (so the
 *     anchor_factor is always recomputed monotone from the signals — a resolver
 *     can never inject an out-of-band factor).
 *   - is a CACHED O(1) lookup per person (no scan in the rank loop).
 *
 * With a default/absent index+lookup this returns the neutral enricher, keeping
 * the gate OFF and the ranking byte-identical.
 */
/**
 * classifyTier({is_contact, reciprocity_strength, feedback_score, sender_kind}, opts) -> TIER.
 *
 * The M5/M5c honest UNKNOWN/first-contact classification. Reads ONLY the who-
 * matters enrichment signals (NEVER a platform name, NEVER the fact-ledger).
 * Returns TIER.RELATIONSHIP when ONE of these structural vouches holds:
 *   (a) is_contact === true — an explicit saved-human vouch (M2 AddressBook); OR
 *   (b) feedback_score > TIER_FEEDBACK_MIN — the operator's own positive triage (M3); OR
 *   (c) reciprocity_strength >= recip_min AND sender_kind === "person" — a deep,
 *       HIGH-turn two-way history with a PERSON (not a bot/service/system sender).
 * Otherwise => TIER.UNKNOWN (DEMOTED — surfaced + labeled + ranked below
 * relationships, NEVER dropped).
 *
 * M5c TIGHTENING (the brutalist regression): the reciprocity-only gate (c) now
 * requires a HIGH threshold (`recip_min`, the caller's CATCHUP_CAPS.RELATIONSHIP_-
 * RECIP_MIN ≈ 0.9) AND a PERSON sender. A MODERATE-reciprocity business (e.g. a
 * taxi/booking service that auto-replies, reciprocity ≈ 0.77) NO LONGER qualifies
 * as a relationship on reciprocity alone — it is DEMOTED to UNKNOWN (still
 * surfaced, never dropped). A genuine reciprocated PERSON with a deep history
 * (reciprocity at/above the high threshold) STILL qualifies. This is MONOTONE in
 * the recall sense: a demoted row is reclassified down a tier, never hard-dropped.
 *
 * UNKNOWN is the HONEST cold-node tier: a genuine brand-new contact, spam, a
 * moderate-reciprocity business, and an auto-replying service all land here
 * together (the message alone cannot separate them) — surfaced + labeled + ranked
 * below relationships, NEVER dropped.
 *
 * Total / defensive: a malformed / missing input reads as zero-signal => UNKNOWN
 * (the conservative, never-promote default). A missing/odd `recip_min` falls back
 * to the module default (ANCHOR_CAPS.TIER_RECIPROCITY_MIN). A missing/odd
 * `sender_kind` is read as "person" (backward-compat, matching catchup's
 * isPersonSender default). Never throws.
 *
 * @param {{is_contact?:boolean, reciprocity_strength?:number, feedback_score?:number, sender_kind?:string}} signals
 * @param {{recip_min?:number}} [opts] — inject the HIGH reciprocity threshold (CATCHUP_CAPS.RELATIONSHIP_RECIP_MIN).
 * @returns {string} TIER.RELATIONSHIP | TIER.UNKNOWN
 */
export function classifyTier(signals, opts) {
  const s = isPlainObject(signals) ? signals : {};
  const o = isPlainObject(opts) ? opts : {};
  const isContact = s.is_contact === true;
  const reciprocity = unitSignal(s.reciprocity_strength);
  const feedback = unitSignal(s.feedback_score);
  // The HIGH reciprocity threshold for the reciprocity-only relationship gate.
  // Injected by the caller (CATCHUP_CAPS.RELATIONSHIP_RECIP_MIN); a missing/odd
  // value degrades to the module default (the new-contact neutral).
  const recipMin = (typeof o.recip_min === "number" && Number.isFinite(o.recip_min))
    ? o.recip_min
    : ANCHOR_CAPS.TIER_RECIPROCITY_MIN;
  // sender_kind absent/odd => "person" (backward-compat with catchup's
  // isPersonSender default; a bot/service/system kind must NOT earn the
  // reciprocity-only relationship via an auto-reply loop).
  const senderKind = typeof s.sender_kind === "string" ? s.sender_kind : "person";
  const isPerson = !(senderKind === "bot" || senderKind === "service" || senderKind === "system");

  // (a) saved contact — the strongest single vouch.
  if (isContact) return TIER.RELATIONSHIP;
  // (b) positive operator feedback — the explicit "this matters".
  if (feedback > ANCHOR_CAPS.TIER_FEEDBACK_MIN) return TIER.RELATIONSHIP;
  // (c) HIGH reciprocity with a PERSON sender — a deep two-way history. M5c: the
  // moderate-reciprocity business (e.g. 0.77 < recipMin) is DEMOTED to UNKNOWN.
  if (reciprocity >= recipMin && isPerson) return TIER.RELATIONSHIP;
  return TIER.UNKNOWN;
}

/**
 * tierRank(tier) -> a sort key (lower sorts FIRST). RELATIONSHIP (0) before
 * UNKNOWN (1). An unrecognized / missing tier sorts as UNKNOWN — the conservative
 * default (a cold node is never silently promoted above a relationship).
 */
export function tierRank(tier) {
  const r = TIER_ORDER[tier];
  return typeof r === "number" ? r : TIER_ORDER[TIER.UNKNOWN];
}

export function makeEnricherFromIndex(index, lookup) {
  if (typeof lookup !== "function") return makeNeutralEnricher();
  return function enrichPerson(person_id) {
    if (!(typeof person_id === "string" && person_id.length > 0)) return NEUTRAL_ENRICHMENT;
    let raw = null;
    try {
      raw = lookup(index, person_id);
    } catch {
      raw = null;
    }
    if (!isPlainObject(raw)) {
      return Object.freeze({
        person_id,
        is_contact: false,
        reciprocity_strength: 0,
        feedback_score: 0,
        anchor_factor: ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL,
      });
    }
    return normalizeEnrichment(raw, person_id);
  };
}
