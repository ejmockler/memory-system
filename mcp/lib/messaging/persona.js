// lib/messaging/persona.js — the PERSONA CONTRACT (the spine of the who-matters
// PERSON model, the read-only/query-time projection consumed by derive-* and the
// persona-resolver).
//
// This module MIRRORS lib/messaging/person-enrichment.js: a frozen CAPS table,
// a frozen NEUTRAL default, a TOTAL normalize, and a stateless default resolver
// factory. It owns the single source of truth for the Persona SHAPE — every
// later wave (derive-identity / -relationship / -topics / -arc / -salient,
// persona-resolver, persona-fixture) consumes this shape and NEVER redefines it.
//
// THE CONTRACT (what this file IS):
//   (1) a PERSONA SHAPE — the read-only, per-person bundle of who-matters facets:
//         { person_id,
//           identity:     { display_name, handles[], platforms[] },
//           relationship: { tier, reciprocity_strength, cadence },
//           role,
//           topics[],
//           salient[],
//           arc:          { last_ts, gist, trend } }
//       It is DATA, derived at query time, never persisted, never mutated.
//   (2) NEUTRAL_PERSONA — a deeply-frozen, all-empty/neutral persona. It is the
//       gate-OFF default: a downstream catch-up row built over it is BYTE-
//       IDENTICAL to today's, so wiring real facets later cannot regress the
//       base surface.
//   (3) normalizePersona(raw, person_id) — TOTAL. Any malformed field degrades
//       to its neutral default (non-string scalar -> null, non-array -> [],
//       arrays deduped, reciprocity clamped to [0,1], arc.last_ts kept only if a
//       finite number). Returns a complete, deeply-frozen shape. Never throws,
//       never mutates the input (always constructs fresh objects/arrays).
//   (4) mergePersona(base, patch) — ADDITIVE-MONOTONE. Arrays union+dedup (base
//       order first); scalars fill ONLY-IF-ABSENT (a present base value is NEVER
//       overwritten by a neutral/null patch value). A persona only ever GROWS
//       richer across merges — never drops a facet. Returns a frozen shape.
//   (5) makeNeutralPersonaResolver() — the DEFAULT resolver: a pure, stateless
//       (person_id) -> Persona that yields a NEUTRAL_PERSONA-shaped persona
//       carrying the id. Closes over no mutable state; same id => deep-equal out.
//
// HARD CONSTRAINTS (non-negotiable):
//   - ZERO platform tokens: person_id, handles, and platforms are OPAQUE strings
//     (whatever an upstream resolver produced). This module names no platform and
//     never branches on one — the L2-5 abstraction invariant.
//   - PURE / TOTAL / DETERMINISTIC: no I/O, no persistence, no throw on odd
//     input; same input => same output; closes over no mutable state.
//   - NEVER-DROP / monotone merge: arrays union to a superset, scalars fill-only;
//     a present value is never overwritten with a neutral/null one.
//   - DEEP-FREEZE discipline: every exported constant and every returned shape
//     (including nested objects and arrays) is Object.freeze'd.

// ---------------------------------------------------------------------------
// PERSONA_CAPS — the single, frozen source of the persona's neutral constants.
// Object.freeze enforces single-producer discipline (all control is DATA, never
// a branch in a function body), mirroring person-enrichment.js's ANCHOR_CAPS.
// ---------------------------------------------------------------------------
const PERSONA_CAPS = Object.freeze({
  // The neutral reciprocity strength: an absent two-way relationship. A present
  // (non-zero) value is never overwritten by this on merge.
  RECIPROCITY_NEUTRAL: 0,
});

// ---------------------------------------------------------------------------
// Defensive readers (total over odd input; never throw). These mirror the
// person-enrichment.js readers; the unit clamp is renamed (its sibling's name
// carries a token that collides with a platform name) but the body is identical.
// ---------------------------------------------------------------------------

// Read a finite number in [0,1]; anything else => 0. Mirrors the [0,1] unit
// clamp in person-enrichment.js. Used for relationship.reciprocity_strength.
function clampUnit(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Read a non-empty string off a field; anything else => null (the scalar neutral).
function str(v) {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Read a finite number off a field; anything else => null. Used for arc.last_ts
// (a timestamp is opaque DATA, not a unit ratio — only finiteness is required).
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Read an array of non-empty strings, deduped via a stable Set (first occurrence
// wins, order preserved); a non-array => []. Drops every non-string / empty item.
function strArr(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const item of v) {
    if (typeof item === "string" && item.length > 0 && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

// Union two already-normalized string arrays, base order first, deduped (stable).
// The merge superset operator: the result contains every member of both inputs.
function unionArr(a, b) {
  const out = [];
  const seen = new Set();
  for (const v of a) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  for (const v of b) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

// fill-ONLY-IF-ABSENT for a string/number scalar whose neutral is null: keep a
// present base value; fill an absent (null) base from the patch. A present base
// is NEVER overwritten by a neutral/null patch value (the monotone invariant).
function pickScalar(baseVal, patchVal) {
  return baseVal !== null ? baseVal : patchVal;
}

// fill-ONLY-IF-ABSENT for reciprocity_strength, whose neutral is 0 (not null):
// keep a present (non-zero) base value; fill an absent (0) base from the patch.
function pickUnit(baseVal, patchVal) {
  return baseVal !== PERSONA_CAPS.RECIPROCITY_NEUTRAL ? baseVal : patchVal;
}

// Recursively Object.freeze an object graph (objects + arrays). Single-producer
// immutability mirroring person-enrichment.js's frozen-shape discipline.
function deepFreeze(o) {
  if (o !== null && typeof o === "object" && !Object.isFrozen(o)) {
    for (const k of Object.keys(o)) deepFreeze(o[k]);
    Object.freeze(o);
  }
  return o;
}

// ---------------------------------------------------------------------------
// NEUTRAL_PERSONA — the deeply-frozen, all-empty/neutral default. The gate-OFF
// persona: every facet absent (scalars null, arrays [], reciprocity neutral).
// A null person_id reads as "unresolved / unknown person" (the conservative
// reading). Deep-frozen root AND every nested object/array.
// ---------------------------------------------------------------------------
export const NEUTRAL_PERSONA = deepFreeze({
  person_id: null,
  identity: {
    display_name: null,
    handles: [],
    platforms: [],
  },
  relationship: {
    tier: null,
    reciprocity_strength: PERSONA_CAPS.RECIPROCITY_NEUTRAL,
    cadence: null,
  },
  role: null,
  topics: [],
  salient: [],
  arc: {
    last_ts: null,
    gist: null,
    trend: null,
  },
});

/**
 * normalizePersona(raw, person_id) -> a complete, deeply-frozen Persona shape.
 *
 * TOTAL: any malformed / missing field degrades to its neutral default, so the
 * returned shape is ALWAYS complete:
 *   - non-string scalar (display_name, tier, cadence, role, arc.gist, arc.trend)
 *     => null
 *   - non-array (handles, platforms, topics, salient) => []; arrays are deduped
 *     (stable) and stripped of non-string / empty members
 *   - relationship.reciprocity_strength => clamped to [0,1] (else 0)
 *   - arc.last_ts => kept only if a finite number (else null)
 *   - person_id => the raw's string id, else the `person_id` arg, else null
 *
 * Never throws. Never mutates the input — always constructs fresh objects/arrays.
 */
export function normalizePersona(raw, person_id = null) {
  const src = isPlainObject(raw) ? raw : {};
  const identitySrc = isPlainObject(src.identity) ? src.identity : {};
  const relationshipSrc = isPlainObject(src.relationship) ? src.relationship : {};
  const arcSrc = isPlainObject(src.arc) ? src.arc : {};

  const shape = {
    person_id: str(src.person_id) ?? str(person_id),
    identity: {
      display_name: str(identitySrc.display_name),
      handles: strArr(identitySrc.handles),
      platforms: strArr(identitySrc.platforms),
    },
    relationship: {
      tier: str(relationshipSrc.tier),
      reciprocity_strength: clampUnit(relationshipSrc.reciprocity_strength),
      cadence: str(relationshipSrc.cadence),
    },
    role: str(src.role),
    topics: strArr(src.topics),
    salient: strArr(src.salient),
    arc: {
      last_ts: num(arcSrc.last_ts),
      gist: str(arcSrc.gist),
      trend: str(arcSrc.trend),
    },
  };
  return deepFreeze(shape);
}

/**
 * mergePersona(base, patch) -> a frozen Persona that is the ADDITIVE-MONOTONE
 * fold of base then patch. Both inputs are normalized first.
 *
 *   - ARRAYS (handles, platforms, topics, salient) => the dedup UNION of both,
 *     base order first. The result is a SUPERSET of each input — never a drop.
 *   - SCALARS (person_id, display_name, tier, cadence, role, arc.last_ts,
 *     arc.gist, arc.trend, and reciprocity_strength whose neutral is 0) => fill
 *     ONLY-IF-ABSENT: a present base value is NEVER overwritten by a neutral/null
 *     patch value; an absent base value is filled from the patch.
 *
 * Deterministic. Inputs are never mutated. The result is deeply frozen.
 */
export function mergePersona(base, patch) {
  const nb = normalizePersona(base);
  const np = normalizePersona(patch);

  const merged = {
    person_id: pickScalar(nb.person_id, np.person_id),
    identity: {
      display_name: pickScalar(nb.identity.display_name, np.identity.display_name),
      handles: unionArr(nb.identity.handles, np.identity.handles),
      platforms: unionArr(nb.identity.platforms, np.identity.platforms),
    },
    relationship: {
      tier: pickScalar(nb.relationship.tier, np.relationship.tier),
      reciprocity_strength: pickUnit(
        nb.relationship.reciprocity_strength,
        np.relationship.reciprocity_strength,
      ),
      cadence: pickScalar(nb.relationship.cadence, np.relationship.cadence),
    },
    role: pickScalar(nb.role, np.role),
    topics: unionArr(nb.topics, np.topics),
    salient: unionArr(nb.salient, np.salient),
    arc: {
      last_ts: pickScalar(nb.arc.last_ts, np.arc.last_ts),
      gist: pickScalar(nb.arc.gist, np.arc.gist),
      trend: pickScalar(nb.arc.trend, np.arc.trend),
    },
  };
  return deepFreeze(merged);
}

/**
 * makeNeutralPersonaResolver() -> the DEFAULT (person_id) -> Persona resolver.
 *
 * Returns a NEUTRAL_PERSONA-shaped persona for EVERY person_id. With no real
 * facets wired this keeps the gate OFF: a downstream row built over it is byte-
 * identical to today's. The returned persona CARRIES the queried id (so a caller
 * can read it back) but is otherwise neutral; an empty/odd id yields the shared
 * NEUTRAL_PERSONA itself.
 *
 * PURE and DETERMINISTIC (same id => deep-equal persona), closing over NO mutable
 * state — the seam's deterministic-test invariant.
 */
export function makeNeutralPersonaResolver() {
  return function neutralPersona(person_id) {
    if (typeof person_id === "string" && person_id.length > 0) {
      // A fresh, deeply-frozen neutral shape carrying the id (constructed anew).
      return normalizePersona(null, person_id);
    }
    return NEUTRAL_PERSONA;
  };
}
