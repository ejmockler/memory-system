// lib/messaging/persona-derive-identity.js — the IDENTITY facet deriver.
//
// A PURE, read-only, query-time projection of ONE person's identity facet from a
// pre-built PersonIndex (the person clustering N7 already minted) plus the saved
// address-book contact maps. It answers a single question for one person_id:
//
//     identity { display_name, handles[], platforms[] }
//
// and returns it wrapped in the canonical persona SHAPE (every other facet left
// neutral), so the persona-resolver can fold this slice into a persona without
// ever regressing the gate-OFF surface.
//
// REUSE, NOT DUPLICATE — this module owns NO clustering, NO contact-map reading,
// NO key normalization, and NO persona shape. It consumes:
//   - getPerson .................. lib/messaging/identity.js  (the PersonRecord)
//   - handlesForPerson ........... lib/messaging/contacts-anchor.js (handle set)
//   - normalizeHandleKey ......... lib/messaging/contacts-anchor.js (lookup key)
//   - normalizePhone/normalizeEmail  lib/connectors/_imessage-name-recovery.js
//       (so the NAME-map keys are built with the SAME normalizers as the lookup
//        keys and therefore can NEVER drift apart)
//   - normalizePersona/NEUTRAL_PERSONA  lib/messaging/persona.js  (the contract)
//
// HARD CONSTRAINTS (non-negotiable):
//   - READ-ONLY: no I/O, no DB, no network. Reads only its arguments. Produces
//     query-time DATA; never persists or mutates a source/fact row.
//   - TOTAL / DEFENSIVE: a null/odd person_id, a missing/odd index, a non-Map
//     contact map — every one degrades to NEUTRAL_PERSONA or an empty facet. The
//     function NEVER throws.
//   - DETERMINISTIC: same inputs => deep-equal output. handles order is stable
//     because getPerson returns ids/cross_links already sorted by buildPersonIndex.
//   - NON-MUTATING: builds fresh arrays/Map; never writes back into any input.
//   - ZERO PLATFORM TOKENS: `platform` is carried as OPAQUE DATA. This module
//     names no platform and never branches on a platform value. The 'phone:' /
//     'email:' namespaces below are KIND tokens (mirroring normalizeHandleKey),
//     NOT platform names — the L2-5 abstraction invariant holds.

import { getPerson } from "./identity.js";
import { handlesForPerson, normalizeHandleKey } from "./contacts-anchor.js";
import { normalizePhone, normalizeEmail } from "../connectors/_imessage-name-recovery.js";
import { normalizePersona, NEUTRAL_PERSONA } from "./persona.js";

// ---------------------------------------------------------------------------
// safeGetPerson — getPerson returns a defensive copy or null, but it does not
// itself guard a malformed-but-PRESENT record (e.g. a Map holding a record whose
// ids is not an array). We keep this deriver TOTAL by treating any such throw as
// "no record". This guards EXTERNAL malformed input only; it adds no logic of
// our own and so cannot hide a bug in the derivation below.
// ---------------------------------------------------------------------------
function safeGetPerson(index, person_id) {
  try {
    return getPerson(index, person_id);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// buildNameMapFromContactMaps — fold { phoneToName, emailToName } into a single
// canonical-key -> NAME map. This MIRRORS contacts-anchor.js's
// buildHandleSetFromContactMaps (same fold, same prefixes, same normalizers) but
// stores the saved NAME as the value instead of mere set membership — the set
// helper can't be reused directly because it returns membership, not names.
//
// Each key is namespaced with the SAME KIND prefix + the SAME normalizer that
// normalizeHandleKey applies, so a handle's lookup key and this map's key are
// byte-identical and cannot drift. ('phone' / 'email' are KIND tokens.)
//
// Defensive: a missing / non-Map input contributes nothing (never a throw). A
// name-less entry is NOT a saved contact (re-guarded). First non-empty name for
// a key wins (deterministic over the map's own iteration order).
// ---------------------------------------------------------------------------
function buildNameMapFromContactMaps(contactMaps) {
  const nameMap = new Map();
  const maps = contactMaps && typeof contactMaps === "object" ? contactMaps : {};
  const fold = (map, prefix, normalize) => {
    if (!(map instanceof Map)) return;
    for (const [rawKey, name] of map) {
      // A contact is "saved" only if it carries a non-empty display name.
      if (typeof name !== "string" || name.trim().length === 0) continue;
      const key = normalize(rawKey);
      if (key === null) continue;
      const namespaced = `${prefix}:${key}`;
      if (!nameMap.has(namespaced)) nameMap.set(namespaced, name);
    }
  };
  fold(maps.phoneToName, "phone", normalizePhone);
  fold(maps.emailToName, "email", normalizeEmail);
  return nameMap;
}

/**
 * deriveIdentity(person_id, opts) -> a normalizePersona-shaped persona whose
 * ONLY populated facet is `identity { display_name, handles[], platforms[] }`;
 * every other facet is left neutral so the slice is byte-neutral under merge.
 *
 * @param {string} person_id opaque cluster id (whatever N7 minted).
 * @param {{index?:object, contactMaps?:{phoneToName?:Map,emailToName?:Map}, handlesByPerson?:Map|object}} [opts]
 * @returns {object} deeply-frozen persona shape (from normalizePersona).
 *
 * Precedence for display_name: saved contact name (from contactMaps, matched on
 * the person's handles in order) > PersonRecord names[0] > null.
 *
 * TOTAL: returns NEUTRAL_PERSONA on a null/odd person_id and never throws on any
 * missing/odd input. DETERMINISTIC and NON-MUTATING.
 */
export function deriveIdentity(person_id, opts = {}) {
  // Guard first: an unresolved / odd person_id yields the shared neutral default.
  if (typeof person_id !== "string" || person_id.length === 0) {
    return NEUTRAL_PERSONA;
  }

  // Null-tolerant unpack — opts (and each map within) may be missing/odd.
  const safeOpts = opts && typeof opts === "object" ? opts : {};
  const { index, contactMaps, handlesByPerson } = safeOpts;

  // The PersonRecord (defensive copy) — may be null when the index is missing or
  // odd, or when this person was never seen. ids/cross_links arrive pre-sorted.
  const rec = safeGetPerson(index, person_id);
  const recIds = Array.isArray(rec?.ids) ? rec.ids : [];
  const recCrossLinks = Array.isArray(rec?.cross_links) ? rec.cross_links : [];

  // -----------------------------------------------------------------------
  // handles: the dedup UNION (order-preserving) of
  //   1. PersonRecord ids[].sender_id      (sorted by buildPersonIndex)
  //   2. PersonRecord cross_links[].norm   (sorted by buildPersonIndex)
  //   3. handlesForPerson(person_id, handlesByPerson)
  // dropping every non-string / empty member.
  // -----------------------------------------------------------------------
  const handles = [];
  const seenHandles = new Set();
  const pushHandle = (h) => {
    if (typeof h === "string" && h.length > 0 && !seenHandles.has(h)) {
      seenHandles.add(h);
      handles.push(h);
    }
  };
  for (const id of recIds) pushHandle(id?.sender_id);
  for (const cl of recCrossLinks) pushHandle(cl?.norm);
  for (const h of handlesForPerson(person_id, handlesByPerson)) pushHandle(h);

  // -----------------------------------------------------------------------
  // platforms: the distinct set of ids[].platform. Each platform value is OPAQUE
  // DATA — we dedup by identity and NEVER compare it to or branch on a literal.
  // -----------------------------------------------------------------------
  const platforms = [];
  const seenPlatforms = new Set();
  for (const id of recIds) {
    const p = id?.platform;
    if (typeof p === "string" && p.length > 0 && !seenPlatforms.has(p)) {
      seenPlatforms.add(p);
      platforms.push(p);
    }
  }

  // -----------------------------------------------------------------------
  // display_name: saved contact name (first handle, in order, whose canonical
  // key is a saved contact) > PersonRecord names[0] > null.
  // -----------------------------------------------------------------------
  let display_name = null;
  const nameMap = buildNameMapFromContactMaps(contactMaps);
  for (const h of handles) {
    const key = normalizeHandleKey(h);
    if (key !== null && nameMap.has(key)) {
      display_name = nameMap.get(key);
      break;
    }
  }
  if (display_name === null) {
    const n0 = rec?.names?.[0];
    display_name = typeof n0 === "string" && n0.length > 0 ? n0 : null;
  }

  // Wrap in the canonical persona shape (all other facets neutral). normalizePersona
  // re-dedups, fills neutrals, and DEEP-FREEZES the returned slice.
  return normalizePersona(
    { person_id, identity: { display_name, handles, platforms } },
    person_id,
  );
}

export default deriveIdentity;
