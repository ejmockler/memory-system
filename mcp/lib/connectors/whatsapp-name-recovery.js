// whatsapp-name-recovery.js — WU-whatsapp-name-recovery.
//
// PURPOSE:
//   Recover a HUMAN-READABLE label for every WhatsApp thread keyed on the
//   identifier the connector already persists in raw_content.session_jid
//   (== ZWACHATSESSION.ZCONTACTJID). The github-events / iMessage connectors
//   emit opaque ids (a JID like `12025551234@s.whatsapp.net` or a group
//   `120363…@g.us`); this module joins those JIDs to the WhatsApp Desktop
//   ChatStorage.sqlite side-tables so the conversation-index can render a
//   name ("Mom", "Group: Soccer Parents") instead of a phone number.
//
// THESIS #1 (NEVER mutate fact rows): this is a DERIVED, READ-ONLY side-table
//   join. It opens ChatStorage.sqlite { readOnly:true }, builds a
//   session_jid -> { label, kind } map, and persists that map into the
//   WhatsApp connector's OWN state.json (the connector cursor file) under a
//   `name_label_map` key — NOT the fact ledger, NOT the conversation-index
//   cache, NOT WhatsApp's source DB. Deleting the map is always safe; the
//   next resolve rebuilds it from the (operator-owned, local) source DB.
//
// PII: recovered names are PII. They live ONLY in the local derived state
//   (connectors/whatsapp/state.json) and the local conversation-index. This
//   module never logs a name and never sends one anywhere.
//
// GROUNDING (verified against the live ChatStorage.sqlite on this host, 2026-06):
//   - ZWACHATSESSION.ZPARTNERNAME is the single label column for ALL JID
//     classes. For a @g.us session it holds the GROUP SUBJECT; for a 1:1
//     (@s.whatsapp.net / @lid) session it holds the contact's display /
//     saved name. ZWAGROUPINFO has NO name column — do NOT chase its FK.
//   - For phone-only 1:1 sessions where ZPARTNERNAME is just a formatted
//     phone string, fall through to ZWAPROFILEPUSHNAME (ZJID -> ZPUSHNAME),
//     the sender's self-set profile name (846 rows on this host).
//   - Measured: 109/133 real threads resolve directly via ZPARTNERNAME, +9
//     via the pushname fallback = 118/133 = 88.7%. The opaque ~11% carry
//     only a formatted phone string in both columns.
//
// SHAPE:
//   buildLabelMapFromDb(db) -> Map<session_jid, { label, kind, resolved }>
//       (pure: takes an OPEN node:sqlite DatabaseSync handle; never opens or
//        closes the DB itself — the caller owns the handle lifecycle.)
//   loadOrBuildLabelMap({ chatStoragePath, statePath }) -> {
//       map: Map<session_jid, descriptor>, source: "cache"|"rebuilt"|"empty",
//       sourceMtimeMs: number|null }
//       (caches into state.json keyed on the source DB mtime; re-resolves on
//        mtime change. Defensive — any failure degrades to an empty map.)
//   labelForSessionJid(map, sessionJid) -> string|null
//       (the read-side accessor the conversation-index uses; returns the human
//        label, or null when unresolved/absent so the caller keeps its current
//        JID-based fallback.)
//
// DISCIPLINE: ESM, defensive try/catch around every fs + sqlite op, Node
//   stdlib only (node:sqlite, node:fs). Never throws to a recall-time caller.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// State.json key under which the resolved map is persisted. Lives ALONGSIDE
// the connector cursor fields (last_zpk, …) in the same state.json object.
export const NAME_LABEL_MAP_STATE_KEY = "name_label_map";
// Companion key: the ChatStorage.sqlite mtimeMs the map was resolved against.
// Re-resolution is triggered when the live source DB mtime differs.
export const NAME_LABEL_MAP_MTIME_STATE_KEY = "name_label_map_source_mtime_ms";

// JID suffix classification — drives label `kind` and noise filtering.
//   @g.us            group (ZPARTNERNAME == group subject)
//   @s.whatsapp.net  1:1 phone-keyed
//   @lid             1:1 linked-id (privacy-preserving id)
//   @broadcast / status@broadcast  noise (status / broadcast lists)
export function classifyJid(jid) {
  if (typeof jid !== "string" || jid.length === 0) return "null";
  // Status / broadcast pseudo-chats are NOISE (status updates, broadcast lists),
  // never real conversations. WhatsApp encodes them several ways on this host:
  //   status@broadcast      — the aggregate status feed
  //   <num>@status          — a single contact's status thread
  //   <lid>@lid.status      — a linked-id status thread
  //   <x>@broadcast         — a broadcast list
  // All are skipped by the resolver so they never enter the label map.
  if (jid === "status@broadcast") return "status";
  if (jid.endsWith("@status") || jid.endsWith("@lid.status")) return "status";
  if (jid.endsWith("@broadcast")) return "broadcast";
  if (jid.endsWith("@g.us")) return "group";
  if (jid.endsWith("@s.whatsapp.net")) return "dm";
  if (jid.endsWith("@lid")) return "lid";
  return "other";
}

// A name candidate counts as "human/resolved" iff it is a non-empty string
// that is NOT merely a formatted phone number. WhatsApp stores the formatted
// phone (e.g. "+1 (555) 555-0134") in ZPARTNERNAME for unsaved contacts; we
// treat that as UNresolved so the caller keeps its JID/phone fallback.
//
// A phone-like string contains only +, digits, spaces, parens, dashes, dots.
const PHONE_LIKE_RE = /^\+?[\d\s()\-.]+$/;

export function isResolvedName(candidate) {
  if (typeof candidate !== "string") return false;
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return false;
  if (PHONE_LIKE_RE.test(trimmed)) return false;
  return true;
}

// Normalize a label to a single-line, whitespace-collapsed, bounded string so
// a pathological ZPARTNERNAME (newlines / 10KB) can never poison the index or
// a downstream prefix. Returns null when nothing survives.
const MAX_LABEL_LEN = 200;
function cleanLabel(s) {
  if (typeof s !== "string") return null;
  const out = s.replace(/\s+/g, " ").trim();
  if (out.length === 0) return null;
  return out.length > MAX_LABEL_LEN ? out.slice(0, MAX_LABEL_LEN) : out;
}

/**
 * buildLabelMapFromDb — PURE join over an already-open DatabaseSync handle.
 *
 * Resolution order per session_jid:
 *   1. ZWACHATSESSION.ZPARTNERNAME when isResolvedName() (group subject for
 *      @g.us; saved contact / display name for 1:1) — kind: "group" | "contact".
 *   2. ZWAPROFILEPUSHNAME.ZPUSHNAME keyed by the full session_jid, when (1)
 *      is only a formatted phone string — kind: "pushname".
 *   3. otherwise UNRESOLVED — not added to the map (caller keeps its JID
 *      fallback). status@broadcast / @broadcast sessions are skipped entirely.
 *
 * @param {object} db — node:sqlite DatabaseSync, opened read-only by caller.
 * @returns {Map<string, {label:string, kind:string, resolved:true}>}
 */
export function buildLabelMapFromDb(db) {
  const map = new Map();
  if (db == null || typeof db.prepare !== "function") return map;

  // Pushname cache: ZJID -> ZPUSHNAME. Wrapped defensively — a host whose
  // ChatStorage predates this table must still resolve via ZPARTNERNAME.
  const pushByJid = new Map();
  try {
    const rows = db
      .prepare("SELECT ZJID AS jid, ZPUSHNAME AS push FROM ZWAPROFILEPUSHNAME")
      .all();
    for (const r of rows) {
      if (typeof r.jid === "string" && typeof r.push === "string") {
        pushByJid.set(r.jid, r.push);
      }
    }
  } catch {
    // No pushname table / query failure — degrade to ZPARTNERNAME-only.
  }

  let sessions;
  try {
    sessions = db
      .prepare(
        `SELECT ZCONTACTJID AS jid,
                ZPARTNERNAME AS partner_name,
                ZSESSIONTYPE AS session_type
         FROM ZWACHATSESSION`,
      )
      .all();
  } catch {
    return map; // No sessions table / query failure — empty map.
  }

  for (const s of sessions) {
    try {
      const jid = typeof s.jid === "string" ? s.jid : null;
      if (jid === null) continue;
      const cls = classifyJid(jid);
      if (cls === "status" || cls === "broadcast" || cls === "null") continue;

      // (1) ZPARTNERNAME — group subject OR contact name.
      const partner = cleanLabel(s.partner_name);
      if (partner != null && isResolvedName(partner)) {
        map.set(jid, {
          label: partner,
          kind: cls === "group" ? "group" : "contact",
          resolved: true,
        });
        continue;
      }

      // (2) pushname fallback for phone-only 1:1 / @lid sessions.
      const push = cleanLabel(pushByJid.get(jid));
      if (push != null && isResolvedName(push)) {
        map.set(jid, { label: push, kind: "pushname", resolved: true });
        continue;
      }
      // (3) unresolved — leave out of the map.
    } catch {
      // A single malformed session row must never abort the resolve.
    }
  }

  return map;
}

/** Return {mtimeMs} for a path, or null when absent / unstatable. */
function safeMtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Read + JSON-parse a state.json, returning {} on any failure. */
function readState(statePath) {
  try {
    if (!existsSync(statePath)) return {};
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Serialize a Map<jid, descriptor> into a compact plain object for state.json. */
export function serializeLabelMap(map) {
  const out = {};
  if (!(map instanceof Map)) return out;
  for (const [jid, desc] of map) {
    if (desc == null || typeof desc.label !== "string") continue;
    out[jid] = { l: desc.label, k: typeof desc.kind === "string" ? desc.kind : "contact" };
  }
  return out;
}

/** Deserialize the compact object back into a Map. Tolerant of tampering. */
export function deserializeLabelMap(obj) {
  const map = new Map();
  if (obj == null || typeof obj !== "object") return map;
  for (const jid of Object.keys(obj)) {
    const v = obj[jid];
    if (v == null || typeof v !== "object") continue;
    const label = typeof v.l === "string" && v.l.length > 0 ? v.l : null;
    if (label === null) continue;
    map.set(jid, {
      label,
      kind: typeof v.k === "string" ? v.k : "contact",
      resolved: true,
    });
  }
  return map;
}

/**
 * loadOrBuildLabelMap — resolve the session_jid -> label map, caching it into
 * the connector's state.json keyed on the source DB mtime.
 *
 * Cache HIT iff: state.json carries a name_label_map AND its recorded source
 * mtime equals the live ChatStorage.sqlite mtime. On a miss (first run, or the
 * operator received new messages so WhatsApp rewrote the DB), re-open the DB
 * read-only, rebuild, and persist back into state.json (preserving the
 * connector's cursor fields via a merge).
 *
 * Always defensive: a missing DB, a missing node:sqlite, or any fs failure
 * degrades to an empty map (source:"empty") — the caller then keeps its
 * JID-based fallback for every thread.
 *
 * @param {object} opts
 * @param {string} opts.chatStoragePath — absolute path to ChatStorage.sqlite.
 * @param {string} opts.statePath — absolute path to connectors/whatsapp/state.json.
 * @returns {Promise<{map:Map, source:string, sourceMtimeMs:number|null}>}
 */
export async function loadOrBuildLabelMap({ chatStoragePath, statePath } = {}) {
  if (typeof chatStoragePath !== "string" || chatStoragePath.length === 0) {
    return { map: new Map(), source: "empty", sourceMtimeMs: null };
  }

  const liveMtime = safeMtimeMs(chatStoragePath);

  // Cache probe: only meaningful when we have a statePath AND a live mtime to
  // compare against (a missing DB cannot validate a cache, so we rebuild-attempt
  // which will itself degrade to empty).
  if (typeof statePath === "string" && statePath.length > 0 && liveMtime != null) {
    const state = readState(statePath);
    const cachedMtime = state[NAME_LABEL_MAP_MTIME_STATE_KEY];
    const cachedObj = state[NAME_LABEL_MAP_STATE_KEY];
    if (
      typeof cachedMtime === "number" &&
      cachedMtime === liveMtime &&
      cachedObj != null &&
      typeof cachedObj === "object"
    ) {
      return {
        map: deserializeLabelMap(cachedObj),
        source: "cache",
        sourceMtimeMs: liveMtime,
      };
    }
  }

  // Cache miss → rebuild from the source DB (read-only).
  if (!existsSync(chatStoragePath)) {
    return { map: new Map(), source: "empty", sourceMtimeMs: liveMtime };
  }

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return { map: new Map(), source: "empty", sourceMtimeMs: liveMtime };
  }

  let db;
  try {
    db = new DatabaseSync(chatStoragePath, { readOnly: true });
  } catch {
    return { map: new Map(), source: "empty", sourceMtimeMs: liveMtime };
  }

  let map;
  try {
    map = buildLabelMapFromDb(db);
  } catch {
    map = new Map();
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }

  // Persist into state.json (merge to preserve the connector's cursor fields).
  if (typeof statePath === "string" && statePath.length > 0) {
    try {
      persistLabelMapToState(statePath, map, liveMtime);
    } catch {
      // A persist failure must not fail the resolve — return the in-memory map.
    }
  }

  return { map, source: "rebuilt", sourceMtimeMs: liveMtime };
}

/**
 * persistLabelMapToState — merge the resolved map + its source mtime into the
 * existing state.json (atomic tmp + rename, mode 0600), preserving every other
 * key (the connector cursor: last_zpk, last_appended_ts, …).
 *
 * @param {string} statePath
 * @param {Map} map
 * @param {number|null} sourceMtimeMs
 */
export function persistLabelMapToState(statePath, map, sourceMtimeMs) {
  if (typeof statePath !== "string" || statePath.length === 0) {
    throw new TypeError("persistLabelMapToState: statePath required");
  }
  const state = readState(statePath);
  state[NAME_LABEL_MAP_STATE_KEY] = serializeLabelMap(map);
  if (typeof sourceMtimeMs === "number") {
    state[NAME_LABEL_MAP_MTIME_STATE_KEY] = sourceMtimeMs;
  }
  const dir = dirname(statePath);
  // Best-effort dir create — the connector normally created it already, but on
  // a first cold run the conversation-index may resolve names before the
  // WhatsApp connector has ever written its state.json.
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch { /* ignore — the writeFileSync below will surface a real failure */ }
  const tmpPath = `${statePath}.namemap.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmpPath, statePath);
}

/**
 * labelForSessionJid — read-side accessor. Returns the recovered human label
 * for a session_jid, or null when unresolved / absent (caller keeps its
 * JID-based fallback). Never throws.
 *
 * @param {Map|null} map
 * @param {string} sessionJid
 * @returns {string|null}
 */
export function labelForSessionJid(map, sessionJid) {
  if (!(map instanceof Map)) return null;
  if (typeof sessionJid !== "string" || sessionJid.length === 0) return null;
  const hit = map.get(sessionJid);
  if (hit == null || typeof hit.label !== "string" || hit.label.length === 0) {
    return null;
  }
  return hit.label;
}

// Default state path resolver — connectors/whatsapp/state.json under the
// configured connectors dir. Imported lazily so this module stays usable in a
// pure-DB (no config) test context.
export async function defaultWhatsAppStatePath() {
  try {
    const { connectorStatePath } = await import("../config.js");
    return connectorStatePath("whatsapp");
  } catch {
    return null;
  }
}

// Default ChatStorage path resolver — mirrors whatsapp.js defaultChatStoragePath.
export async function defaultChatStoragePath() {
  try {
    const { CAPS } = await import("../validation.js");
    if (
      typeof CAPS.WHATSAPP_CHATSTORAGE_PATH === "string" &&
      CAPS.WHATSAPP_CHATSTORAGE_PATH.length > 0
    ) {
      const { homedir } = await import("node:os");
      const p = CAPS.WHATSAPP_CHATSTORAGE_PATH;
      return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
    }
  } catch { /* fall through to the hard-coded default */ }
  const { homedir } = await import("node:os");
  return join(
    homedir(),
    "Library",
    "Group Containers",
    "group.net.whatsapp.WhatsApp.shared",
    "ChatStorage.sqlite",
  );
}

// Test-only internal surface.
export const __internal = Object.freeze({
  cleanLabel,
  safeMtimeMs,
  readState,
});
