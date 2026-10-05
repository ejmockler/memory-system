// adapters/_imessage-context.js — the iMessage adapter's OPTIONAL context build.
//
// This is an L1 ADAPTER-LAYER sibling of imessage.js — NOT a frozen connector and
// NOT one of the four L2-5 "above L1" sources. It exists to keep the PURE row->
// Envelope mapper (imessage.js) free of any source-read import: the N4 gate greps
// imessage.js for `_imessage-name-recovery|AddressBook|Contacts|chat.db|sqlite`
// and requires ZERO matches (the adapter must be a pure projection over the row).
// The AddressBook read that prepareContext performs legitimately names those
// surfaces, so it lives HERE — imessage.js merely RE-EXPORTS prepareContext from
// this module, threading the resulting contactMaps into its pure Map-lookup.
//
// THIS module is the ONLY place the iMessage adapter layer reaches the frozen
// connector (_imessage-name-recovery.js) — and it does so READ-ONLY:
// resolveAddressBookDbPaths globs the operator's *.abcddb sources, buildContactMaps
// opens each `{ readOnly:true }` (?mode=ro) and closes it. THESIS #1: writes no
// source/fact row; a pure read-only projection joined at query time.
//
// MEMOIZED per process: the build (a full read-only join over every AddressBook
// source) runs AT MOST ONCE — the first call caches the resulting promise and
// every later call returns it. So a catch-up over N adapters opens the DBs once,
// not once per row.
//
// DEFENSIVE: any failure (no FDA, missing sources, no node:sqlite, malformed
// schema) degrades to {} so the adapter falls back to the documented number-floor
// path rather than crashing the catch-up. NEVER throws to the generic L5 caller.

import {
  buildContactMaps,
  resolveAddressBookDbPaths,
} from "../../connectors/_imessage-name-recovery.js";

let _prepareContextPromise = null;

/**
 * prepareContext — build { contactMaps: { phoneToName, emailToName } } once,
 * memoized. Generic signature (the L5 call site invokes it with no args). Returns
 * {} on any failure so the caller's generic `toEnvelope(row, ctx)` degrades
 * gracefully (sender.name falls to the formatted-number floor, exactly as before
 * this hook existed when a contact lookup misses).
 *
 * @param {object} [opts]
 * @param {string[]} [opts.addressBookDbPaths] — explicit *.abcddb paths (tests).
 * @param {string} [opts.addressBookSourcesDir] — dir to glob *.abcddb from (tests).
 * @param {boolean} [opts.noMemo] — bypass the per-process memo (tests).
 * @returns {Promise<{contactMaps?: {phoneToName: Map, emailToName: Map}}>}
 */
export async function prepareContext(opts = {}) {
  const useMemo = !(opts && opts.noMemo === true);
  if (useMemo && _prepareContextPromise !== null) return _prepareContextPromise;

  const run = (async () => {
    try {
      const dbPaths = Array.isArray(opts && opts.addressBookDbPaths)
        ? opts.addressBookDbPaths
        : resolveAddressBookDbPaths(
            opts && typeof opts.addressBookSourcesDir === "string"
              ? opts.addressBookSourcesDir
              : undefined,
          );
      if (!Array.isArray(dbPaths) || dbPaths.length === 0) return {};

      const { phoneToName, emailToName, sourcesRead } =
        await buildContactMaps(dbPaths);
      // No source produced a single usable contact -> nothing to enrich with.
      if (sourcesRead === 0 && phoneToName.size === 0 && emailToName.size === 0) {
        return {};
      }
      return { contactMaps: { phoneToName, emailToName } };
    } catch {
      // Any unexpected failure degrades to the number-floor path.
      return {};
    }
  })();

  if (useMemo) _prepareContextPromise = run;
  return run;
}

// Test-only: reset the per-process memo so a test can re-drive prepareContext.
export function __resetPrepareContextMemo() {
  _prepareContextPromise = null;
}
