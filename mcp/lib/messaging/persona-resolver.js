// lib/messaging/persona-resolver.js — the PERSONA RESOLVER (assemble + inject).
//
// `makePersonaResolver(ctx)` returns a CACHED `(person_id) -> Persona` that folds
// the four facet derivers — IDENTITY, RELATIONSHIP, TOPICS, ARC — into ONE
// complete Persona per person, via the contract's additive-monotone mergePersona.
// `salient` is never folded: the contract's NEUTRAL_PERSONA already pins it to []
// (there is NO salient deriver to import — it was retired upstream).
//
// This module MIRRORS person-enrichment.js `makeEnricherFromIndex` (@330) and
// catchup.js `makeWhoMattersEnricher` (exported, @2220) /
// `buildWhoMattersEnricher` (module-PRIVATE since f5-catchup-seam, @2271 — its
// only caller is buildCatchupCore in the same file):
//   - a READ-ONLY, query-time PROJECTION built ONCE over the loaded corpus (the
//     person/handle/grouping indexes), Thesis #1 — never persisted, never mutated,
//     no live source read inside the per-person path;
//   - an injected, CACHED O(1)-per-person resolver (a Map memo);
//   - SOFT-guarded end to end: a throwing facet (or the whole fold) degrades that
//     ONE person to NEUTRAL_PERSONA — the resolver itself NEVER throws.
//
// With NO ctx (falsy / non-object) it returns the contract's
// `makeNeutralPersonaResolver()` (gate OFF): NEUTRAL_PERSONA for every id, byte-
// identical to today's surface. That neutral resolver is RE-EXPORTED here so the
// downstream persona-surface imports it from this single module.
//
// HARD CONSTRAINTS (non-negotiable, mirroring the contract + derivers):
//   - READ-ONLY / additive (Thesis #1): never mutates ctx, its envelopes, or any
//     facet; a Persona is derived DATA.
//   - PURE / TOTAL / DETERMINISTIC: never throws on odd input; same person_id =>
//     the SAME cached frozen object; built ONCE, O(1) per person.
//   - ZERO platform tokens: platform / person_id / handles flow as OPAQUE DATA;
//     this module names no platform and branches on none (the L2-5 abstraction).
//   - REUSE, NOT REDEFINE: it consumes mergePersona / NEUTRAL_PERSONA and the four
//     derivers, re-exports the contract's makeNeutralPersonaResolver, and defines
//     NO persona shape and NO derivation logic of its own.

// e9 — THE SECOND ARGUMENT IS NOW HONOURED. The catch-up row seat has ALREADY
// graded this row's reciprocity_strength (against a per-row floor) and classified
// its tier (from that row's enrichment), and it passes both on the per-row ctx.
// This module used to ignore that ctx and let the relationship deriver grade the
// quantity a SECOND time from the per-person projection — a duplicate derivation
// that provably disagreed with the row it rode on. It now hands the authoritative
// values to the deriver (which skips its own grading) and composes them onto the
// RETURNED persona OUTSIDE the memo, because the memo is keyed on person_id while
// the graded value is per-ROW: the same person on two threads with different counts
// must surface each row's own number, not whichever row resolved first.
//
// The composition is normalizePersona over a spread — NOT mergePersona: pickScalar
// and pickUnit are fill-only-if-absent and would refuse to overwrite the base's
// already-present tier / strength. The cached base is frozen and NEVER mutated;
// every composed persona is a fresh frozen object, and any failure composing
// returns the cached base rather than throwing.
import {
  mergePersona,
  normalizePersona,
  NEUTRAL_PERSONA,
  makeNeutralPersonaResolver,
} from "./persona.js";
import { deriveIdentity } from "./persona-derive-identity.js";
import { deriveRelationship } from "./persona-derive-relationship.js";
import { deriveTopics, tokenizeForTopics } from "./persona-derive-topics.js";
import { deriveArc } from "./persona-derive-arc.js";
import { buildHandlesByPerson, plausibleTs } from "./catchup.js";

// RE-EXPORT (do not redefine): persona-surface imports the gate-OFF resolver from
// here so the neutral default and the real resolver share one entry module.
export { makeNeutralPersonaResolver };

// ---------------------------------------------------------------------------
// Defensive readers (total over odd input; never throw). Mirror persona.js.
// ---------------------------------------------------------------------------
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// The EFFECTIVE person key for an inbound (platform, sender_id): the resolved N7
// person id when the injected resolver returns one, else the SOFT
// `${platform}:${sender_id}` fallback — byte-identical to the dedup key the catch-up
// rank loop computes, so a row's `dedupKey` resolves to the SAME grouped person.
// A throwing / absent resolver degrades to the soft key (never a throw).
function dedupKeyFor(platform, senderId, resolvePerson) {
  let personId = null;
  try {
    personId = resolvePerson(platform, senderId);
  } catch {
    personId = null;
  }
  if (typeof personId === "string" && personId.length > 0) return personId;
  return `${platform === null ? "" : platform}:${senderId === null ? "" : senderId}`;
}

// ---------------------------------------------------------------------------
// groupCorpus — the ONCE-built per-person projection over the loaded envelopes.
// Each INBOUND is attributed to ITS OWN sender's person key — the SAME resolved
// dedupKey the catch-up rank loop forms for a row (the LATEST inbound sender) — so
// a person's facets reflect ONLY that person's own messages. MY outbound in a
// thread is shared into EVERY inbound participant of that thread, so each
// counterparty keeps the two-way history the reciprocity / arc reads depend on. In
// a 1:1 the sole participant gathers the whole thread (byte-identical to grouping it
// under the single sender); in a multi-party thread participants no longer bleed
// into one another — an opener's topics exclude another sender's content. A
// threadless inbound is grouped directly by its own person key; a threadless or
// no-inbound outbound has no person anchor and is dropped. This MIRRORS the
// buildHandlesByPerson grouping (catchup.js:1293) + the rank loop's per-thread
// recovery: one read-only pass-pair, no mutation of any envelope.
//
// Returns:
//   - envelopesByPerson : Map<person_key, envelope[]>  (input order preserved —
//     ts-ascending when the corpus is loaded ascending; feeds topics/arc/relationship)
//   - scalarsByPerson   : Map<person_key, { last_ts, sender_kind }>  the per-person
//     opaque scalars (latest PLAUSIBLE inbound ts + that inbound's sender kind) the
//     relationship deriver reads when an explicit attribute is absent.
// ---------------------------------------------------------------------------
function groupCorpus(envelopes, resolvePerson, now) {
  const threadToParticipants = new Map(); // thread_id -> Set<person_key> (its inbound senders)
  const scalarsByPerson = new Map(); // person_key -> { last_ts, sender_kind }
  const envelopesByPerson = new Map(); // person_key -> envelope[]

  const inboundSender = (e) => {
    const sender = isPlainObject(e.sender) ? e.sender : null;
    const senderId = sender && typeof sender.id === "string" ? sender.id : null;
    const platform = typeof e.platform === "string" ? e.platform : null;
    const kind = sender && typeof sender.kind === "string" ? sender.kind : null;
    return { platform, senderId, kind };
  };
  const threadIdOf = (e) =>
    typeof e.thread_id === "string" && e.thread_id.length > 0 ? e.thread_id : null;

  // Pass 1 — record each thread's INBOUND participants (their resolved person keys);
  // fold the per-person opaque scalars (latest plausible inbound ts + its sender kind).
  for (const e of envelopes) {
    if (!isPlainObject(e)) continue;
    if (e.is_from_me === true) continue; // only an inbound carries a contact identity
    const { platform, senderId, kind } = inboundSender(e);
    if (senderId === null) continue;
    const key = dedupKeyFor(platform, senderId, resolvePerson);

    const threadId = threadIdOf(e);
    if (threadId !== null) {
      let participants = threadToParticipants.get(threadId);
      if (participants === undefined) {
        participants = new Set();
        threadToParticipants.set(threadId, participants);
      }
      participants.add(key);
    }

    const ts = plausibleTs(e.ts, now); // clamp a corrupt / ~epoch-0 ts to null
    const prev = scalarsByPerson.get(key);
    if (prev === undefined) {
      scalarsByPerson.set(key, { last_ts: ts, sender_kind: kind });
    } else {
      if (ts !== null && (prev.last_ts === null || ts > prev.last_ts)) {
        prev.last_ts = ts;
        if (kind !== null) prev.sender_kind = kind;
      } else if (prev.sender_kind === null && kind !== null) {
        prev.sender_kind = kind;
      }
    }
  }

  // Pass 2 — route each envelope to the RIGHT person key(s). An INBOUND lands on its
  // OWN sender key (the same dedupKey catch-up forms for the row), threaded or
  // threadless alike. MY outbound in a recognised thread is shared into EVERY inbound
  // participant of that thread, so each counterparty keeps the two-way history; a
  // threadless or no-inbound outbound has no person anchor and is dropped. Iterating
  // in the input (ts-ascending) order preserves per-key push order.
  const add = (key, e) => {
    let arr = envelopesByPerson.get(key);
    if (arr === undefined) {
      arr = [];
      envelopesByPerson.set(key, arr);
    }
    arr.push(e);
  };
  for (const e of envelopes) {
    if (!isPlainObject(e)) continue;
    if (e.is_from_me === true) {
      // My outbound: share it into each inbound participant of its thread so every
      // counterparty keeps the reciprocal arc; no thread / no participant => no anchor.
      const threadId = threadIdOf(e);
      if (threadId === null) continue;
      const participants = threadToParticipants.get(threadId);
      if (participants === undefined) continue;
      for (const key of participants) add(key, e);
      continue;
    }
    // An inbound is grouped directly by its OWN sender key (per-sender attribution).
    const { platform, senderId } = inboundSender(e);
    if (senderId === null) continue;
    add(dedupKeyFor(platform, senderId, resolvePerson), e);
  }

  return { envelopesByPerson, scalarsByPerson };
}

// ---------------------------------------------------------------------------
// buildTopicsCorpus — the ONCE-built cross-person distinctiveness table over the
// per-person projection (Thesis #1: built once, read-only, no per-person rescan, no
// live source read). One DOCUMENT per person = that person's concatenated content,
// tokenized via the SHARED topics pipeline (tokenizeForTopics) so its df is aligned
// with the terms deriveTopics ranks. Emits the deriveTopics-compatible lightweight
// { totalDocs, df:Map<term, #persons-using-it> } shape, so the distinctiveness
// down-weight ACTUALLY FIRES (it was inert while no corpus was passed). Read-only;
// never mutates the projection or its envelopes.
// ---------------------------------------------------------------------------
function buildTopicsCorpus(envelopesByPerson) {
  let totalDocs = 0;
  const df = new Map(); // term -> number of DISTINCT persons whose content uses it
  for (const envs of envelopesByPerson.values()) {
    totalDocs += 1;
    const seen = new Set(); // dedup a term within ONE person's document
    for (const e of envs) {
      if (!isPlainObject(e)) continue;
      const content = e.content;
      if (typeof content !== "string" || content.length === 0) continue;
      for (const term of tokenizeForTopics(content)) seen.add(term);
    }
    for (const term of seen) df.set(term, (df.get(term) || 0) + 1);
  }
  return { totalDocs, df };
}

/**
 * makePersonaResolver(ctx) -> (person_id, rowCtx?) => Persona  (cached, soft-guarded).
 *
 * e9 — the OPTIONAL 2nd argument is the caller's PER-ROW context. When it carries
 * `reciprocity_strength` (finite number) and/or `tier` (non-empty string), those
 * AUTHORITATIVE values are used for the returned persona's relationship facet
 * instead of being re-derived here, and the returned persona is composed fresh
 * outside the per-person memo. Omitted / malformed => the cached base, unchanged.
 *
 * THE DEFENSIVE CTX CONTRACT (every field optional; a missing / odd one degrades
 * to an empty input — NEVER a throw):
 *   - index            PersonIndex (from buildPersonIndex) — deriveIdentity input.
 *   - contactMaps      the saved-contact NAME maps — deriveIdentity input.
 *   - handlesByPerson  Map<person_key, handles[]>; else built ONCE from envelopes
 *                      + resolvePerson via buildHandlesByPerson.
 *   - envelopes        the loaded corpus (read-only) — grouped per person ONCE.
 *   - resolvePerson    (platform, sender_id) => person_id|null — the N7 join.
 *   - corpus           optional cross-person distinctiveness corpus — deriveTopics.
 *   - attrsByPerson    Map<person_key, { is_contact, feedback_score, sender_kind,
 *                      last_ts }> — the opaque relationship scalars per person.
 *   - now              injected wall clock (finite) — deriveArc / cadence.
 *
 * With ctx falsy / non-object => makeNeutralPersonaResolver() (gate OFF).
 */
export function makePersonaResolver(ctx) {
  // Gate OFF: no / odd ctx => the contract's NEUTRAL_PERSONA-for-every-id resolver.
  if (!isPlainObject(ctx)) return makeNeutralPersonaResolver();

  // Build the read-only projection ONCE (Thesis #1). Belt-and-suspenders: any
  // failure assembling it degrades to the neutral resolver (gate OFF), so the
  // resolver is always SAFE to construct.
  let identityOpts;
  let envelopesByPerson;
  let scalarsByPerson;
  let attrsByPerson;
  let corpus;
  let now;
  try {
    const envelopes = Array.isArray(ctx.envelopes) ? ctx.envelopes : [];
    const resolvePerson = typeof ctx.resolvePerson === "function" ? ctx.resolvePerson : () => null;
    now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
    attrsByPerson = ctx.attrsByPerson instanceof Map ? ctx.attrsByPerson : new Map();

    const handlesByPerson =
      ctx.handlesByPerson instanceof Map
        ? ctx.handlesByPerson
        : buildHandlesByPerson(envelopes, resolvePerson);

    // The deriveIdentity input bundle — assembled once, read-only.
    identityOpts = {
      index: ctx.index !== undefined ? ctx.index : null,
      contactMaps: isPlainObject(ctx.contactMaps) ? ctx.contactMaps : {},
      handlesByPerson,
    };

    const grouped = groupCorpus(envelopes, resolvePerson, now);
    envelopesByPerson = grouped.envelopesByPerson;
    scalarsByPerson = grouped.scalarsByPerson;

    // The cross-person distinctiveness corpus, built ONCE from the projection (no
    // per-person rescan). PRECEDENCE: an explicit ctx.corpus still wins (the injected-
    // corpus contract); else the built table; a build failure degrades to corpus=null
    // (deriveTopics' 2-arg form stays fully functional) — never a throw.
    if (ctx.corpus !== undefined) {
      corpus = ctx.corpus;
    } else {
      try {
        corpus = buildTopicsCorpus(envelopesByPerson);
      } catch {
        corpus = null;
      }
    }
  } catch {
    return makeNeutralPersonaResolver();
  }

  // e9 — read the AUTHORITATIVE per-row values off the ctx the caller already
  // passes as the resolver's 2nd argument. Absent / malformed => null (today's
  // behaviour: the deriver grades it itself). Total; never throws.
  const authoritativeOf = (rowCtx) => {
    if (!isPlainObject(rowCtx)) return null;
    const strength =
      typeof rowCtx.reciprocity_strength === "number" && Number.isFinite(rowCtx.reciprocity_strength)
        ? rowCtx.reciprocity_strength
        : null;
    const tier = typeof rowCtx.tier === "string" && rowCtx.tier.length > 0 ? rowCtx.tier : null;
    if (strength === null && tier === null) return null;
    return { strength, tier };
  };

  // The opaque relationship scalars for one person: an explicit attribute wins,
  // else the corpus-derived scalar, else absent (the deriver fills its neutral).
  // e9: when the caller supplied AUTHORITATIVE values they ride along as the
  // deriver's overrides, so the deriver does NOT re-grade the same quantity while
  // building the base — there is no second derivation to diverge, even discarded.
  const relOptsFor = (person_id, authoritative) => {
    const a = isPlainObject(attrsByPerson.get(person_id)) ? attrsByPerson.get(person_id) : {};
    const s = isPlainObject(scalarsByPerson.get(person_id)) ? scalarsByPerson.get(person_id) : {};
    const opts = {
      is_contact: a.is_contact,
      feedback_score: a.feedback_score,
      sender_kind: a.sender_kind ?? s.sender_kind ?? undefined,
      last_ts: a.last_ts ?? s.last_ts ?? undefined,
      now,
    };
    if (authoritative !== null) {
      if (authoritative.strength !== null) opts.reciprocity_strength = authoritative.strength;
      if (authoritative.tier !== null) opts.tier = authoritative.tier;
    }
    return opts;
  };

  // The per-resolver memo: person_id -> the SAME frozen BASE Persona on every hit
  // (the once-built four-facet fold; O(1) per person, no rescan — Thesis #1).
  const cache = new Map();

  // Build (or fetch) the cached BASE persona for one person. The authoritative
  // values, when present, are threaded into the base's relationship derivation so
  // the grader is never called twice for the same emitted row; the per-ROW value
  // is then re-composed below, outside this memo, so the base's identity as a
  // per-PERSON projection is preserved and the surfaced values are never
  // memo-order-dependent.
  const baseFor = (person_id, authoritative) => {
    const hit = cache.get(person_id);
    if (hit !== undefined) return hit;

    let persona;
    try {
      // The person's two-way thread (both directions); undefined => an empty input
      // each deriver degrades over (NEVER a content-filter on person_id).
      const thread = envelopesByPerson.get(person_id);

      // Fold the four facets monotonically over the contract's neutral base. Each
      // deriver's shape is adapted to a persona patch; mergePersona unions arrays
      // and fills scalars only-if-absent, so a present value is never overwritten.
      let acc = mergePersona(NEUTRAL_PERSONA, deriveIdentity(person_id, identityOpts));
      acc = mergePersona(acc, {
        relationship: deriveRelationship(thread, relOptsFor(person_id, authoritative)),
      });
      acc = mergePersona(acc, { topics: deriveTopics(thread, person_id, corpus) });

      // ARC SUPPRESSION (load-bearing): the arc deriver's no-data default carries
      // trend:'dormant' — a present string mergePersona WOULD write, leaking it past
      // the byte-identical gate. The deriver delegates the keep/drop to us: fold the
      // arc ONLY when it carries real recency (last_ts !== null); else contribute
      // nothing, leaving arc at the contract neutral (trend:null).
      const arc = deriveArc(thread, { now });
      if (arc && arc.last_ts !== null) acc = mergePersona(acc, { arc });

      // salient is NEVER folded — it rides the contract's neutral [] (no deriver).
      persona = acc;
    } catch {
      // SOFT-GUARD: any throw anywhere in the fold degrades THIS person to the
      // neutral default (never a partially-corrupt persona); the resolver, and
      // every other person, are untouched.
      persona = NEUTRAL_PERSONA;
    }

    // Results are already deeply frozen by mergePersona / NEUTRAL_PERSONA.
    cache.set(person_id, persona);
    return persona;
  };

  return function resolvePersona(person_id, rowCtx) {
    // Guard: an unresolved / odd id yields the shared NEUTRAL_PERSONA (no fold).
    if (typeof person_id !== "string" || person_id.length === 0) return NEUTRAL_PERSONA;

    const authoritative = authoritativeOf(rowCtx);
    const base = baseFor(person_id, authoritative);

    // No authoritative values => the cached base rides out unchanged (byte-identical
    // to the pre-e9 surface for every caller that passes no ctx).
    if (authoritative === null) return base;

    // COMPOSE OUTSIDE THE MEMO — a fresh frozen persona carrying THIS row's graded
    // values. The cached base is never mutated (it is frozen), and a second row for
    // the SAME person with different counts composes its own persona off the same
    // base. Soft-guard: any failure returns the cached base, never a throw.
    try {
      const relationship = { ...base.relationship };
      if (authoritative.strength !== null) relationship.reciprocity_strength = authoritative.strength;
      if (authoritative.tier !== null) relationship.tier = authoritative.tier;
      return normalizePersona({ ...base, relationship }, person_id);
    } catch {
      return base;
    }
  };
}

export default makePersonaResolver;
