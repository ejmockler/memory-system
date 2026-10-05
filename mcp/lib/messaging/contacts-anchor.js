// lib/messaging/contacts-anchor.js — WORKUNIT M2, the CONTACTS-ANCHOR SOURCE MODULE.
//
// MISSION (per TOPOLOGY.md + the M1 person-enrichment CONTRACT): produce the
// `is_contact` SIGNAL of the who-matters enrichment shape
//   {person_id, is_contact, reciprocity_strength, feedback_score, anchor_factor}.
// A person you have SAVED in your address book is an explicit human vouch — the
// strongest single structural signal that they matter (ANCHOR_CONTACT_LIFT, the
// largest single lift in person-enrichment's ANCHOR_CAPS). This module owns the
// READ-ONLY join that decides, for a given message sender's handles, whether any
// of them resolves to a saved contact name.
//
// THESIS #1 (read-only sources / append-only logs; derived projections):
//   This is a DERIVED PROJECTION joined at query time, NOT a mutable fact store.
//   The address-book read is READ-ONLY (the imported builder opens each source db
//   `{ readOnly:true }` (?mode=ro) and closes it). Nothing here writes, mutates,
//   or re-queries a source/fact row. The resulting handle-set is a query-time
//   index, never persisted.
//
// HARD CONSTRAINTS (from the brutalist falsification — non-negotiable):
//   - INJECTED / BOUNDED / CACHED: buildContactAnchorIndex() does the address-book
//     read AT MOST ONCE per process (memoized promise). The returned index exposes
//     an O(1) isContact(handles[]) — never a live db call inside the rank loop.
//   - MONOTONE UP-RANK ONLY: this module only ever sets is_contact=true (a LIFT).
//     It NEVER emits a down-rank. A miss is a ZERO-signal (is_contact=false),
//     which person-enrichment degrades to the neutral anchor_factor (1.0).
//   - NEVER HARD-DROP A HUMAN: a cold / unknown / unresolved sender => is_contact
//     =false => neutral. The person is NOT dropped from the surface, just
//     unanchored. Absence of an address book (no Full-Disk-Access, no sources, no
//     node:sqlite) DEGRADES to an empty index => everyone is_contact=false =>
//     ranking byte-identical to the gate-OFF default. NEVER throws to the caller.
//   - NOT THE FACT-LEDGER: the signal is sourced from the operator's address book
//     (saved humans), NOT the 86.8%-OSS-stranger git-log fact-ledger.
//   - ZERO PLATFORM TOKENS: this module names NO platform. It reads opaque handle
//     strings (phone / email) and an opaque person_id only; it never branches on a
//     platform name. The platform-specific address-book read lives behind the
//     imported, read-only builder (the connector layer), not in a branch here.
//
// NORMALIZATION: handles are normalized to the SAME key shape the contact maps are
//   built under (phone: strip non-digits, keep the last 10; email: lower(trim())),
//   so "+15555550123" / "(555) 555-0123" collapse equal and the join is
//   deterministic. The normalizers are re-used from the connector builder so the
//   index keys and the lookup keys can NEVER drift apart.
//
// ESM, DEFENSIVE, deterministic. PURE over its inputs except the single memoized,
// read-only address-book read (which is itself injectable + resettable for tests).

import {
  buildContactMaps,
  resolveAddressBookDbPaths,
  normalizePhone,
  normalizeEmail,
  isEmailHandle,
} from "../connectors/_imessage-name-recovery.js";
// The cross-source saved-contact spine: every readable saved-contact store the
// operator curated, merged into one person per shared handle. Which stores
// those are is the spine's concern, not this module's. Used ONLY to WIDEN the
// anchor handle set — see the union below for the monotone/fail-soft contract.
import { buildContactSpine } from "./contact-spine.js";

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Handle normalization -> the canonical dedup key the contact set is built under.
// Mirrors the contact-map builder's own normalization (re-used, not re-coded) so
// the index keys and the lookup keys are byte-identical.
// ---------------------------------------------------------------------------

/**
 * normalizeHandleKey — collapse one raw sender handle (a phone or an email) to the
 * canonical contact-set key. Email handles route to the email key (lower/trim);
 * everything else normalizes as a phone (last-10-digits). Returns null for a
 * handle that can never join a contact (empty, non-string, < 10 phone digits).
 *
 * @param {string|null|undefined} handle
 * @returns {string|null} a `phone:<digits>` / `email:<addr>` namespaced key, or null.
 */
export function normalizeHandleKey(handle) {
  if (typeof handle !== "string" || handle.length === 0) return null;
  try {
    if (isEmailHandle(handle)) {
      const key = normalizeEmail(handle);
      return key === null ? null : `email:${key}`;
    }
    const key = normalizePhone(handle);
    return key === null ? null : `phone:${key}`;
  } catch {
    return null;
  }
}

/**
 * buildHandleSetFromContactMaps — fold the { phoneToName, emailToName } contact
 * maps the read-only builder produced into a single Set of canonical contact
 * KEYS. Each key in the set is a SAVED handle: a phone/email that resolves to a
 * non-empty contact name. The set is the membership oracle isContact() consults.
 *
 * Defensive: a missing / non-Map input contributes nothing (empty set, never a
 * throw). A name-less entry is NOT a saved contact (the builder already drops
 * those, but we re-guard).
 *
 * @param {{phoneToName?: Map, emailToName?: Map}} [contactMaps]
 * @returns {Set<string>} canonical contact keys.
 */
export function buildHandleSetFromContactMaps(contactMaps) {
  const set = new Set();
  const maps = contactMaps && typeof contactMaps === "object" ? contactMaps : {};
  const fold = (map, prefix, normalize) => {
    if (!(map instanceof Map)) return;
    for (const [rawKey, name] of map) {
      // A contact is only "saved" if it carries a non-empty display name.
      if (typeof name !== "string" || name.trim().length === 0) continue;
      const key = normalize(rawKey);
      if (key === null) continue;
      set.add(`${prefix}:${key}`);
    }
  };
  fold(maps.phoneToName, "phone", normalizePhone);
  fold(maps.emailToName, "email", normalizeEmail);
  return set;
}

// ---------------------------------------------------------------------------
// The INDEX — a frozen, query-time membership oracle over the contact handle-set.
// ---------------------------------------------------------------------------

/**
 * makeContactAnchorIndex — wrap a precomputed contact handle-set into the frozen
 * index object the catch-up seam consumes. Exposes:
 *
 *   - isContact(handles[]) -> bool
 *       true IFF any of the sender's handles normalizes to a key in the saved
 *       contact set. O(handles) with O(1) per-handle membership. Total/defensive:
 *       a non-array / empty / all-unresolvable handle list => false (a miss is a
 *       zero-signal, never a throw, never a down-rank).
 *
 *   - contactStrength(handles[]) -> number in [0,1]
 *       The graded saved-name presence: 1 when a saved contact is matched, 0 on a
 *       miss. (A binary lift today — the saved-name IS the vouch; the field is the
 *       graded seam later waves can deepen, e.g. weighting org-only vs. named.)
 *
 *   - size — the count of saved contact keys (metadata / gate diagnostics).
 *
 * The set is captured by reference but never mutated; the index is frozen.
 *
 * @param {Set<string>} handleSet canonical contact keys (from buildHandleSetFromContactMaps).
 * @returns {{isContact: (handles:string[])=>boolean, contactStrength:(handles:string[])=>number, size:number}}
 */
export function makeContactAnchorIndex(handleSet) {
  const set = handleSet instanceof Set ? handleSet : new Set();

  function anyHandleSaved(handles) {
    if (!Array.isArray(handles)) {
      // A single string is a tolerated convenience input.
      if (typeof handles === "string") {
        const k = normalizeHandleKey(handles);
        return k !== null && set.has(k);
      }
      return false;
    }
    for (const h of handles) {
      const key = normalizeHandleKey(h);
      if (key !== null && set.has(key)) return true;
    }
    return false;
  }

  return Object.freeze({
    size: set.size,
    isContact(handles) {
      try {
        return anyHandleSaved(handles);
      } catch {
        return false; // a miss, never a throw — never a hard-drop.
      }
    },
    contactStrength(handles) {
      // Binary today: a saved-name match is full strength; a miss is zero.
      return anyHandleSaved(handles) ? 1 : 0;
    },
  });
}

// An EMPTY index — the degraded fallback when no address book is readable. Every
// query returns is_contact=false (neutral). This is what keeps the ranking
// byte-identical when there is no Full-Disk-Access / no sources / no node:sqlite.
export const EMPTY_CONTACT_ANCHOR_INDEX = makeContactAnchorIndex(new Set());

// ---------------------------------------------------------------------------
// The READ-ONLY, MEMOIZED address-book read -> a built index.
// ---------------------------------------------------------------------------

let _indexPromise = null;

/**
 * buildContactAnchorIndex — read the operator's saved contacts (READ-ONLY) ONCE
 * and return the membership index. MEMOIZED per process: the first call caches the
 * resulting promise; every later call returns it, so a catch-up over N adapters
 * does the address-book join AT MOST once, not once per row.
 *
 * DEGRADES to the EMPTY index (every is_contact=false => neutral, ranking
 * byte-identical) on ANY failure: no sources globbed, no node:sqlite, a locked /
 * malformed db, no Full-Disk-Access. NEVER throws to the caller.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.addressBookDbPaths] explicit *.abcddb paths (tests).
 * @param {string} [opts.addressBookSourcesDir] dir to glob *.abcddb from (tests).
 * @param {{phoneToName?:Map,emailToName?:Map}} [opts.contactMaps] pre-built maps
 *        (tests / the adapter-layer prepareContext): skip the db read entirely.
 * @param {boolean} [opts.noMemo] bypass the per-process memo (tests).
 * @returns {Promise<{isContact:Function, contactStrength:Function, size:number}>}
 */
export async function buildContactAnchorIndex(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const useMemo = !(o.noMemo === true);
  if (useMemo && _indexPromise !== null) return _indexPromise;

  const run = (async () => {
    try {
      // Fast path: caller already built the contact maps (the adapter-layer
      // prepareContext, or a test). No db read at all.
      if (
        o.contactMaps &&
        typeof o.contactMaps === "object" &&
        (o.contactMaps.phoneToName instanceof Map ||
          o.contactMaps.emailToName instanceof Map)
      ) {
        const set = buildHandleSetFromContactMaps(o.contactMaps);
        return makeContactAnchorIndex(set);
      }

      const dbPaths = Array.isArray(o.addressBookDbPaths)
        ? o.addressBookDbPaths
        : resolveAddressBookDbPaths(
            typeof o.addressBookSourcesDir === "string"
              ? o.addressBookSourcesDir
              : undefined,
          );
      if (!Array.isArray(dbPaths) || dbPaths.length === 0) {
        return EMPTY_CONTACT_ANCHOR_INDEX;
      }

      const { phoneToName, emailToName, sourcesRead } =
        await buildContactMaps(dbPaths);
      const set = buildHandleSetFromContactMaps({ phoneToName, emailToName });

      // CROSS-SOURCE WIDENING (./contact-spine.js). The default builder above
      // reads ONE saved-contact store, but its handles were used to anchor
      // threads from EVERY source — so a human the operator saved only in some
      // other store could never be recognised as a contact. Measured live
      // 2026-07-31: 6 of 60 catch-up rows anchored; the spine resolves 11.
      //
      // The spine unions every readable saved-contact store and merges records
      // that share any normalized handle, so a source-native opaque id anchors
      // to the same human as their phone number. Which stores exist, and which
      // are unreadable, is the spine's concern — this module stays source-
      // agnostic and consumes an opaque handle set (the ZERO-PLATFORM-TOKENS
      // invariant asserted by mcp/test/messaging/m2-contacts-anchor.test.mjs).
      //
      // MONOTONE + FAIL-SOFT, preserving this module's contract: the spine can
      // only ADD handles to the anchor set (never remove one), and any failure
      // leaves `set` exactly as the macOS-only build produced it. is_contact
      // remains a pure up-rank; a miss is still a neutral zero-signal.
      // HERMETICITY: when the caller PINS its sources (the test path, and any
      // scoped/offline build), the spine must honour exactly that scope — it
      // may not reach past the injection to whatever else exists on the
      // machine. We thread the same paths through and request a
      // pinned-sources-only build; which additional stores that suppresses is
      // the spine's concern, so this module names none. Unpinned (production)
      // callers get the full multi-store spine. Memoization is bypassed in the
      // pinned case so a scoped build can never serve, or poison, the
      // process-wide cache.
      const pinned =
        Array.isArray(o.addressBookDbPaths) ||
        typeof o.addressBookSourcesDir === "string";
      const spineOpts = isPlainObject(o.spine) ? { ...o.spine } : {};
      if (pinned) {
        spineOpts.addressBookDbPaths = dbPaths;
        spineOpts.pinnedSourcesOnly = true;
        spineOpts.force = true;
      }

      let spineHandles = 0;
      try {
        const spine = await buildContactSpine(spineOpts);
        if (spine && spine.personByHandle instanceof Map) {
          for (const h of spine.personByHandle.keys()) {
            if (typeof h !== "string" || h.length === 0) continue;
            // Re-normalize through THIS module's key function before adding.
            // The spine's internal key shape is its own business; the anchor
            // set and the isContact() lookup must agree by construction, or a
            // widened handle is an unreachable dead entry. (Observed exactly
            // that: the set grew by ~793 keys and none of them ever matched,
            // because the two layers keyed the same handle differently.)
            const key = normalizeHandleKey(h);
            if (key === null || set.has(key)) continue;
            set.add(key);
            spineHandles += 1;
          }
        }
      } catch {
        // Spine unavailable -> macOS-only anchoring, byte-identical to before.
      }

      // No source produced a single usable contact -> nothing to anchor on.
      if (
        sourcesRead === 0 &&
        phoneToName.size === 0 &&
        emailToName.size === 0 &&
        spineHandles === 0
      ) {
        return EMPTY_CONTACT_ANCHOR_INDEX;
      }
      return makeContactAnchorIndex(set);
    } catch {
      // Any unexpected failure degrades to the neutral empty index.
      return EMPTY_CONTACT_ANCHOR_INDEX;
    }
  })();

  if (useMemo) _indexPromise = run;
  return run;
}

// Test-only: reset the per-process memo so a test can re-drive the build.
export function __resetContactAnchorMemo() {
  _indexPromise = null;
}

// ---------------------------------------------------------------------------
// The M1 WIRING SEAM — (index, lookup) for makeEnricherFromIndex.
// ---------------------------------------------------------------------------

/**
 * handlesForPerson — extract the candidate handle strings for a person from an
 * optional person_id -> handles map (the N7 resolver's identity bundle, or a soft
 * `${platform}:${sender_id}` fallback whose tail is the raw handle). Defensive:
 * returns [] when nothing is known. NEVER branches on a platform name — it splits
 * on the first ':' only to recover the opaque handle tail of a soft dedup key.
 *
 * @param {string} person_id opaque id (a resolved person, or a soft platform:id key).
 * @param {Map<string,string[]>|object|null} [handlesByPerson] id -> handle list.
 * @returns {string[]}
 */
export function handlesForPerson(person_id, handlesByPerson) {
  if (typeof person_id !== "string" || person_id.length === 0) return [];
  // 1. Explicit handle bundle keyed by the person id (the N7 identity join).
  if (handlesByPerson instanceof Map) {
    const v = handlesByPerson.get(person_id);
    if (Array.isArray(v)) return v.filter((h) => typeof h === "string" && h.length > 0);
  } else if (handlesByPerson && typeof handlesByPerson === "object") {
    const v = handlesByPerson[person_id];
    if (Array.isArray(v)) return v.filter((h) => typeof h === "string" && h.length > 0);
  }
  // 2. Soft fallback: the dedup key `<source>:<handle>` carries the raw handle as
  //    its tail. Recover it (the source prefix is opaque; we never read it). The
  //    whole id is also offered as a handle (an id that IS a bare handle).
  const out = [person_id];
  const idx = person_id.indexOf(":");
  if (idx >= 0 && idx < person_id.length - 1) out.push(person_id.slice(idx + 1));
  return out;
}

/**
 * makeContactsLookup — build the `(index, person_id) -> {is_contact} | null` lookup
 * that person-enrichment's makeEnricherFromIndex expects. The `index` argument is
 * the contact-anchor index (from buildContactAnchorIndex); the optional
 * handlesByPerson resolves a person_id to its handle strings.
 *
 *   - Returns { is_contact:true } on a saved-contact hit.
 *   - Returns { is_contact:false } on a clean miss (a known person, no saved
 *     handle) — explicit zero-signal; makeEnricherFromIndex degrades it to neutral.
 *   - SOFT-guards any throw => null (which the enricher also degrades to neutral).
 *
 * The returned closure performs ONLY O(1) set lookups — no db, no scan.
 *
 * @param {Map<string,string[]>|object|null} [handlesByPerson]
 * @returns {(index:any, person_id:string)=>({is_contact:boolean}|null)}
 */
export function makeContactsLookup(handlesByPerson) {
  return function contactsLookup(index, person_id) {
    try {
      if (!index || typeof index.isContact !== "function") return null;
      const handles = handlesForPerson(person_id, handlesByPerson);
      return { is_contact: index.isContact(handles) === true };
    } catch {
      return null; // SOFT-guard: deterministic neutral fallback.
    }
  };
}
