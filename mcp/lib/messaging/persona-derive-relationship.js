// lib/messaging/persona-derive-relationship.js — the RELATIONSHIP facet deriver.
//
// A PURE, read-only, query-time projection of ONE person's relationship facet
// from a per-thread reciprocity bundle (or the raw thread envelopes) plus a few
// opaque scalar attributes. It answers a single question for one person:
//
//     relationship { tier, reciprocity_strength, cadence }
//
//   - tier ............ "relationship" | "unknown" (the M5/M5c honest tiering)
//   - reciprocity_strength  a finite ratio in [0,1] (graded two-way strength)
//   - cadence ......... "recent" | "regular" | "dormant" (coarse recency band)
//
// and returns it as the contract-clean `relationship` sub-object (deeply frozen,
// shape-identical to NEUTRAL_PERSONA.relationship), so the persona-resolver can
// fold this slice into a persona via the existing additive-monotone merge without
// ever regressing the gate-OFF surface.
//
// REUSE, NOT DUPLICATE — this module owns NO tiering rule, NO graded reciprocity
// rule, NO recency curve, and NO timestamp-plausibility guard. It consumes the
// SHIPPED single sources of truth:
//   - classifyTier .............. lib/messaging/person-enrichment.js
//       (the M5/M5c tier: saved-contact / positive-feedback / HIGH-reciprocity-
//        with-a-PERSON-sender -> "relationship", else the honest "unknown")
//   - reciprocityOfThread ....... lib/messaging/attention.js
//       (folds raw thread envelopes -> the {turn_count, outbound_count,
//        inbound_count, last_outbound_ts, reciprocated} counts bundle)
//   - reciprocityStrength ....... lib/messaging/catchup.js
//       (the GRADED two-way strength in [BROADCAST_FLOOR, 1])
//   - recencyFactor ............. lib/messaging/catchup.js  (newer-is-higher,
//        [RECENCY_FLOOR, 1]; the cadence band is a coarsening of THIS output)
//   - plausibleTs / MIN_PLAUSIBLE_TS_MS  lib/messaging/catchup.js  (the shared
//        read-time timestamp guard: a corrupt ~epoch-0 ts is rejected so it can
//        not masquerade as a real, ancient message time)
//   - CATCHUP_CAPS .............. lib/messaging/catchup.js  (RELATIONSHIP_RECIP_MIN
//        is INJECTED as classifyTier's recip_min — the M5c high threshold)
//   - normalizePersona / NEUTRAL_PERSONA  lib/messaging/persona.js  (the contract)
//
// HARD CONSTRAINTS (non-negotiable, mirroring persona.js / the sibling derivers):
//   - PURE / TOTAL / DETERMINISTIC: no I/O, no persistence, never throws on
//     null/odd input, same input => deep-equal output. The reciprocity bundle and
//     the opts are READ-ONLY (never mutated); every working structure is fresh.
//   - ZERO platform tokens: sender_kind and every other platform-derived attribute
//     flow only as OPAQUE DATA, passed straight through to the reused classifier —
//     this module names no platform and branches on no platform literal (L2-5).
//   - SINGLE-PRODUCER CAPS: the only constants this module owns are the two cadence
//     band edges, frozen in RELATIONSHIP_CADENCE_CAPS; no bare literal lives in the
//     function body, and the tier / strength / recency rules are NOT re-copied here.
//
// e9 — A CALLER THAT HAS ALREADY GRADED THE QUANTITY HANDS THE RESULT IN.
// Two ADDITIVE, optional overrides ride on `opts`: `reciprocity_strength` (a
// pre-graded finite number) and `tier` (a non-empty string). When either is
// supplied and well-formed this module USES IT INSTEAD OF re-deriving it — the
// corresponding reciprocityStrength / classifyTier call is not made at all. When
// absent or malformed the derivation below runs verbatim, so every direct caller
// (and the whole direct-call contract in persona-derive-relationship.test.mjs) is
// unchanged.
//
// WHY THE OVERRIDE EXISTS RATHER THAN A SECOND DERIVATION. The catch-up rank loop
// grades a row's reciprocity_strength against a PER-ROW floor and classifies that
// row's tier from the row's own enrichment. Re-deriving either here — from the
// per-person thread and the per-person scalars, without that floor and without
// that enrichment — produces a SECOND number for the same emitted row, and two
// derivations of one quantity can disagree (they did: a vouched broadcast row read
// 0.7 on the row and 0.3 on its persona, `relationship` on the row and `unknown` on
// its persona). A duplicate derivation that does not exist cannot diverge. The
// override keeps this module PURE / TOTAL / DETERMINISTIC: it consumes a value, it
// does not read a source.

import { classifyTier } from "./person-enrichment.js";
import { reciprocityOfThread } from "./attention.js";
import {
  reciprocityStrength,
  recencyFactor,
  plausibleTs,
  MIN_PLAUSIBLE_TS_MS,
  CATCHUP_CAPS,
} from "./catchup.js";
import { normalizePersona, NEUTRAL_PERSONA } from "./persona.js";

// ---------------------------------------------------------------------------
// RELATIONSHIP_CADENCE_CAPS — the ONLY thresholds this module owns: the two band
// edges that coarsen the REUSED recencyFactor output (which lives in
// [CATCHUP_CAPS.RECENCY_FLOOR, 1]) into the three cadence labels. Frozen so all
// control is DATA (single-producer discipline, mirroring persona.js PERSONA_CAPS);
// no bare literal ever appears in the function body.
// ---------------------------------------------------------------------------
const RELATIONSHIP_CADENCE_CAPS = Object.freeze({
  // At/above this recencyFactor the last touch is fresh -> "recent". With the
  // reused one-week recency window this is roughly the last ~2.5 days.
  RECENT_MIN: 0.66,
  // At/below this the touch has decayed to (essentially) the recency floor ->
  // "dormant". Sits one epsilon ABOVE CATCHUP_CAPS.RECENCY_FLOOR (0.05) so an
  // absent / implausible ts — which recencyFactor pins to exactly the floor —
  // always lands in the dormant band. Between the two edges => "regular".
  DORMANT_MAX: 0.06,
});

// Cadence labels (DATA, not control): the three coarse recency bands.
const CADENCE = Object.freeze({
  RECENT: "recent",
  REGULAR: "regular",
  DORMANT: "dormant",
});

// The count fields that mark a plain object as an ALREADY-FOLDED reciprocity
// bundle (vs. a bag of scalars). Presence of any one as a finite number is enough
// to treat the object as a bundle and read it directly (no re-fold).
const BUNDLE_COUNT_FIELDS = Object.freeze([
  "turn_count",
  "outbound_count",
  "inbound_count",
]);

// ---------------------------------------------------------------------------
// Defensive helpers (total over odd input; never throw). Mirror persona.js.
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// True iff `o` already carries a finite count field — i.e. it is a folded
// reciprocity bundle we can read directly rather than a bag of scalars.
function carriesCounts(o) {
  for (const f of BUNDLE_COUNT_FIELDS) {
    const v = o[f];
    if (typeof v === "number" && Number.isFinite(v)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// resolveBundle(input) -> { bundle, resolved }
//
// Resolve the per-thread reciprocity bundle from the polymorphic `input`:
//   - an envelopes ARRAY  (or { envelopes: [...] })  => fold via the REUSED
//     reciprocityOfThread (the single source of truth for the counts);
//   - a plain object already CARRYING count fields    => use it directly;
//   - anything else (null / number / string / {} / garbage) => UNRESOLVED.
//
// A resolved zero-history bundle (e.g. an empty thread) is still RESOLVED — its
// conservative new-contact reading is owned by reciprocityStrength downstream.
// UNRESOLVED is reserved strictly for input we cannot read as a bundle at all.
// ---------------------------------------------------------------------------
function resolveBundle(input) {
  if (Array.isArray(input)) {
    return { bundle: reciprocityOfThread(input), resolved: true };
  }
  if (isPlainObject(input)) {
    if (Array.isArray(input.envelopes)) {
      return { bundle: reciprocityOfThread(input.envelopes), resolved: true };
    }
    if (carriesCounts(input)) {
      return { bundle: input, resolved: true };
    }
  }
  return { bundle: null, resolved: false };
}

// ---------------------------------------------------------------------------
// cadenceFor(tsCandidate, now) -> a CADENCE label.
//
// Guards the candidate ts via the REUSED plausibleTs (a corrupt ~epoch-0 or
// future ts -> null), folds it through the REUSED recencyFactor (a null ts pins
// to exactly CATCHUP_CAPS.RECENCY_FLOOR), then coarsens that [floor,1] factor into
// the three cadence bands. An absent / implausible ts therefore always -> dormant.
// ---------------------------------------------------------------------------
function cadenceFor(tsCandidate, now) {
  const guardedTs = plausibleTs(tsCandidate, now);
  const rf = recencyFactor(guardedTs, now);
  if (rf >= RELATIONSHIP_CADENCE_CAPS.RECENT_MIN) return CADENCE.RECENT;
  if (rf <= RELATIONSHIP_CADENCE_CAPS.DORMANT_MAX) return CADENCE.DORMANT;
  return CADENCE.REGULAR;
}

/**
 * deriveRelationship(input, opts) -> { tier, reciprocity_strength, cadence }
 *
 * PURE deriver of the persona.relationship facet. `input` is a per-thread
 * reciprocity bundle, a raw thread-envelopes array, or { envelopes:[...] }; the
 * opaque scalar attributes ride on `opts`:
 *
 *   @param {Array|object|null} input  envelopes | {envelopes:[...]} | counts bundle
 *   @param {{is_contact?:boolean, feedback_score?:number, sender_kind?:string,
 *            last_ts?:number, now?:number,
 *            reciprocity_strength?:number, tier?:string}} [opts]
 *            — the last two are the e9 AUTHORITATIVE OVERRIDES: a caller that has
 *            ALREADY graded the quantity for THIS emitted row passes the RESULT,
 *            and the matching derivation below is skipped entirely.
 *   @returns {{tier:string, reciprocity_strength:number, cadence:string}}
 *            a deeply-frozen facet (reciprocity_strength clamped to [0,1]).
 *
 * Steps:
 *   (1) resolve the reciprocity bundle (fold envelopes via reciprocityOfThread,
 *       or read a counts bundle directly; else UNRESOLVED);
 *   (2) reciprocity_strength = the caller's AUTHORITATIVE value when one was
 *       supplied as a finite number; else reciprocityStrength(bundle) for a
 *       RESOLVED bundle (default BROADCAST_FLOOR). For UNRESOLVED input set it to 0
 *       DIRECTLY — we do NOT pass a zero bundle through reciprocityStrength (that
 *       would return the conservative new-contact NEUTRAL 0.7, which is correct for
 *       a real but empty thread, yet wrong for null/odd input that is not a thread
 *       at all);
 *   (3) tier = the caller's AUTHORITATIVE value when one was supplied as a
 *       non-empty string; else classifyTier({is_contact, reciprocity_strength,
 *       feedback_score, sender_kind}, {recip_min:
 *       CATCHUP_CAPS.RELATIONSHIP_RECIP_MIN}) — the M5c high-threshold,
 *       PERSON-gated tiering, sender_kind passed through unchanged;
 *   (4) cadence = coarse band on the recency of the latest plausible ts
 *       (opts.last_ts, else the bundle's last_outbound_ts), guarded by plausibleTs.
 *       Cadence has NO override — no other seat computes it.
 *
 * TOTAL: null / undefined / {} / garbage -> { tier:"unknown",
 * reciprocity_strength:0, cadence:"dormant" }. Never throws, never mutates input,
 * same input => deep-equal output.
 */
export function deriveRelationship(input, opts = {}) {
  // Null-tolerant unpack of the opaque scalar attributes.
  const o = isPlainObject(opts) ? opts : {};
  const { is_contact, feedback_score, sender_kind, last_ts, now } = o;

  // e9 — the AUTHORITATIVE OVERRIDES, read defensively. `null` means "the caller
  // supplied nothing usable", which is exactly today's behaviour (derive below).
  const givenStrength =
    typeof o.reciprocity_strength === "number" && Number.isFinite(o.reciprocity_strength)
      ? o.reciprocity_strength
      : null;
  const givenTier = typeof o.tier === "string" && o.tier.length > 0 ? o.tier : null;

  // (1) Resolve the per-thread reciprocity bundle (or mark it unresolved).
  const { bundle, resolved } = resolveBundle(input);

  // (2) Graded two-way strength. An AUTHORITATIVE value wins outright — the grader
  //     is not called at all, so no second number for this row can be produced here.
  //     Otherwise: UNRESOLVED -> 0 DIRECTLY (the no-data reading); a RESOLVED bundle
  //     (even a real empty thread) goes through the reused reciprocityStrength,
  //     preserving its conservative new-contact NEUTRAL.
  const reciprocity_strength =
    givenStrength !== null ? givenStrength : resolved ? reciprocityStrength(bundle) : 0;

  // (3) Tier. An AUTHORITATIVE tier wins outright (the classifier is not called);
  //     otherwise via the REUSED classifier, injecting the M5c high reciprocity
  //     gate. sender_kind is OPAQUE DATA, handed straight through (never branched
  //     on here) so the PERSON-only reciprocity path stays intact.
  const tier =
    givenTier !== null
      ? givenTier
      : classifyTier(
          { is_contact, reciprocity_strength, feedback_score, sender_kind },
          { recip_min: CATCHUP_CAPS.RELATIONSHIP_RECIP_MIN },
        );

  // (4) Cadence from the latest plausible ts: an explicit opts.last_ts wins,
  //     else the bundle's most-recent outbound ts; a null/odd one -> dormant.
  const fromBundle = bundle && typeof bundle === "object" ? bundle.last_outbound_ts : undefined;
  const tsCandidate = last_ts ?? fromBundle;
  const cadence = cadenceFor(tsCandidate, now);

  // Route the facet through the persona contract (clamps reciprocity to [0,1],
  // validates tier/cadence to strings, deep-freezes), then return just the
  // relationship sub-object — mirroring how persona-derive-topics returns .topics.
  return normalizePersona({ relationship: { tier, reciprocity_strength, cadence } }).relationship;
}

// Test-only view: the cadence band edges this module owns PLUS the reused floors
// they are defined against, so a test can confirm the dormant edge sits just above
// the shared recency floor and that the deriver guards with the SAME plausibility
// floor (MIN_PLAUSIBLE_TS_MS) as catchup — provenance, not a second copy.
export const _capsForTest = Object.freeze({
  RECENT_MIN: RELATIONSHIP_CADENCE_CAPS.RECENT_MIN,
  DORMANT_MAX: RELATIONSHIP_CADENCE_CAPS.DORMANT_MAX,
  RECENCY_FLOOR: CATCHUP_CAPS.RECENCY_FLOOR,
  MIN_PLAUSIBLE_TS_MS,
  NEUTRAL_RELATIONSHIP: NEUTRAL_PERSONA.relationship,
});

export default deriveRelationship;
