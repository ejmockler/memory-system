// whatsapp-sender-index.js — WORKUNIT wa-sender-names.
//
// PURPOSE:
//   WhatsApp facts must surface WHO said a thing. The connector historically
//   stamped parties[] = [from_jid, "user"]; for a @g.us message that from_jid
//   is the GROUP'S jid, not the sender — so a recall could never show the
//   member who actually spoke. This module owns two read-only surfaces:
//
//   (1) resolveSenderForRow(dbRow, { pushByJid }) — a PURE per-row resolver the
//       connector calls at INGEST time to stamp raw_content.sender_jid +
//       raw_content.sender_name onto NEW source rows (forward capture):
//         - group inbound  : sender_jid = ZMEMBERJID,
//                            sender_name = ZCONTACTNAME || ZFIRSTNAME ||
//                                          pushname[ZMEMBERJID] || null
//         - 1:1 inbound    : sender_jid = from_jid,
//                            sender_name = session_label (name-recovery) || null
//         - outbound (me)  : sender_jid = "user", sender_name = "user"
//
//   (2) a DERIVED sender-index projection (source_msg_id -> {sender_jid,
//       sender_name}) built READ-ONLY from the live ChatStorage.sqlite, mirroring
//       conversation-index.js (rebuild / loadFromCacheSync / lookup + sidecar
//       cache). This backfills EXISTING facts whose source rows predate the
//       forward stamp: recall.js joins fact -> source_msg_id -> this index so a
//       historical group fact still surfaces its sender.
//
// THESIS #1 (NEVER mutate fact rows): both surfaces are derived + read-only.
//   The forward stamp writes NEW source-ledger rows only (never an existing fact
//   row). The sender-index is a sidecar projection keyed by source_msg_id; it is
//   deletable/rebuildable from the (operator-owned, local) ChatStorage.sqlite.
//   recall.js LEFT-JOINs it at read time — it never writes back to memory.jsonl.
//
// PII: recovered sender names are PII. They live ONLY in the local derived
//   source ledger + the local sender-index sidecar. This module never logs a
//   name and never sends one anywhere.
//
// SCHEMA GROUNDING (the WhatsApp desktop ChatStorage.sqlite layout):
//   - ZWAMESSAGE.ZGROUPMEMBER (INTEGER FK) -> ZWAGROUPMEMBER.Z_PK on group
//     (@g.us) messages; NULL on 1:1 messages.
//   - ZWAGROUPMEMBER.{ZCONTACTNAME (saved name; may be null for every row),
//     ZFIRSTNAME (often only partly populated), ZMEMBERJID (always populated)}.
//   - ZWAPROFILEPUSHNAME (ZJID -> ZPUSHNAME) recovers the sender's self-set
//     push name for members lacking any saved name, keyed on ZMEMBERJID. So
//     the resolver order is contact -> first -> pushname -> null, with the
//     member jid ALWAYS available as the stable sender_jid.
//
// DISCIPLINE: ESM, defensive try/catch around every fs + sqlite op, Node stdlib
//   only (node:sqlite, node:fs). Never throws to a recall-time caller path.

import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";

import { isResolvedName } from "./whatsapp-name-recovery.js";

// ZSESSIONTYPE = 1 marks a group chat (mirrors whatsapp.js ZSESSIONTYPE_GROUP).
const SESSION_TYPE_GROUP = 1;

// The "self" sentinel the connector uses for the operator on outbound rows.
export const SELF_PARTY = "user";

// Cache file schema version. Bump on any structural change to the sidecar shape.
export const SENDER_INDEX_SCHEMA_VERSION = "v1";

export const SENDER_INDEX_VERSION = "whatsapp-sender-index@0.1.0";

// Max sender-name length — defends the index/recall surface from a pathological
// ZCONTACTNAME (newlines / 10KB). Mirrors whatsapp-name-recovery's MAX_LABEL_LEN.
const MAX_SENDER_NAME_LEN = 200;

/** Collapse whitespace + bound length; null when nothing survives. */
function cleanName(s) {
  if (typeof s !== "string") return null;
  const out = s.replace(/\s+/g, " ").trim();
  if (out.length === 0) return null;
  return out.length > MAX_SENDER_NAME_LEN ? out.slice(0, MAX_SENDER_NAME_LEN) : out;
}

/** Coerce a possibly-string session_type to an integer, or null. */
function sessionTypeOf(v) {
  if (Number.isInteger(v)) return v;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** True when the row is an operator-authored (outbound) message. */
function isFromMe(v) {
  return v === 1 || v === true;
}

/**
 * resolveSenderName — pure name resolver shared by the forward stamp AND the
 * derived index. Resolution order for a GROUP member:
 *   1. ZCONTACTNAME (saved display name)        — isResolvedName()
 *   2. ZFIRSTNAME (first-name fallback)          — isResolvedName()
 *   3. ZWAPROFILEPUSHNAME[ZMEMBERJID] (push name) — isResolvedName()
 *   4. otherwise null (caller keeps the bare sender_jid)
 *
 * Each candidate is cleaned + gated through isResolvedName so a formatted phone
 * string ("+1 (650) …") never poses as a name (mirrors the name-recovery rule).
 *
 * @param {object} args
 * @param {string|null} args.contactName  — ZWAGROUPMEMBER.ZCONTACTNAME
 * @param {string|null} args.firstName    — ZWAGROUPMEMBER.ZFIRSTNAME
 * @param {string|null} args.memberJid    — ZWAGROUPMEMBER.ZMEMBERJID (push key)
 * @param {Map<string,string>} [args.pushByJid] — ZJID -> ZPUSHNAME
 * @returns {string|null}
 */
export function resolveSenderName({ contactName, firstName, memberJid, pushByJid } = {}) {
  const contact = cleanName(contactName);
  if (contact != null && isResolvedName(contact)) return contact;
  const first = cleanName(firstName);
  if (first != null && isResolvedName(first)) return first;
  if (pushByJid instanceof Map && typeof memberJid === "string" && memberJid.length > 0) {
    const push = cleanName(pushByJid.get(memberJid));
    if (push != null && isResolvedName(push)) return push;
  }
  return null;
}

/**
 * resolveSenderForRow — derive {sender_jid, sender_name} for ONE message row.
 * Pure; used by BOTH the connector forward stamp and the index rebuild so the
 * two paths can never drift. NEVER throws — a malformed row degrades to a
 * jid-only descriptor (sender_name null).
 *
 * The row may be a DB-join row (member_contact_name / member_first_name /
 * member_jid + from_jid + session_type + is_from_me + session_label) OR a
 * retained source-ledger raw_content (carrying the SAME field names the forward
 * stamp wrote). The descriptor shape is identical either way.
 *
 * @param {object} row
 * @param {object} [opts]
 * @param {Map<string,string>} [opts.pushByJid] — ZJID -> ZPUSHNAME push cache.
 * @returns {{sender_jid: string|null, sender_name: string|null}}
 */
export function resolveSenderForRow(row, opts = {}) {
  if (row == null || typeof row !== "object") {
    return { sender_jid: null, sender_name: null };
  }
  const pushByJid = opts && opts.pushByJid instanceof Map ? opts.pushByJid : null;

  // Outbound — the operator is the sender.
  if (isFromMe(row.is_from_me)) {
    return { sender_jid: SELF_PARTY, sender_name: SELF_PARTY };
  }

  const sessionType = sessionTypeOf(row.session_type);
  const fromJid = typeof row.from_jid === "string" && row.from_jid.length > 0 ? row.from_jid : null;
  const memberJid =
    typeof row.member_jid === "string" && row.member_jid.length > 0 ? row.member_jid : null;

  // Group inbound — the sender is the GROUP MEMBER, not the group jid.
  // We treat a row as group-sender-bearing iff it carries a member jid OR the
  // session is explicitly group-typed (defensive: some retained rows may carry
  // member_* without a session_type).
  if (memberJid != null || sessionType === SESSION_TYPE_GROUP) {
    const senderName = resolveSenderName({
      contactName: row.member_contact_name,
      firstName: row.member_first_name,
      memberJid,
      pushByJid,
    });
    // sender_jid prefers the member jid; falls back to from_jid (which, for a
    // group inbound row, is also the member jid on this host's schema).
    return { sender_jid: memberJid || fromJid, sender_name: senderName };
  }

  // 1:1 inbound — the sender is the partner. The human name resolves in order:
  //   1. session_label (the recovered ZPARTNERNAME the name-recovery module
  //      already resolved — a saved contact / display name).
  //   2. pushByJid[from_jid] — the partner's OWN self-set profile push name.
  //      (THE 1:1 GAP FIX, WU N3: ZPARTNERNAME can be just a formatted phone
  //      string for some inbound 1:1 partners; their push name still recovers
  //      the human label. The partner's jid IS a valid pushByJid key — the
  //      same table the group branch already consults, so this step cuts the
  //      sender_name null-rate for 1:1 inbound rows.)
  //   3. otherwise null (caller keeps the bare from_jid).
  const sessionLabel = cleanName(row.session_label);
  if (sessionLabel != null && isResolvedName(sessionLabel)) {
    return { sender_jid: fromJid, sender_name: sessionLabel };
  }
  if (pushByJid != null && fromJid != null) {
    const push = cleanName(pushByJid.get(fromJid));
    if (push != null && isResolvedName(push)) {
      return { sender_jid: fromJid, sender_name: push };
    }
  }
  return { sender_jid: fromJid, sender_name: null };
}

// ---------------------------------------------------------------------------
// DERIVED sender-index projection (source_msg_id -> {sender_jid, sender_name})
//
// Built read-only from ChatStorage.sqlite by joining ZWAMESSAGE (the stable
// ZSTANZAID source_msg_id) to ZWACHATSESSION + ZWAGROUPMEMBER + the pushname
// cache, then running resolveSenderForRow over each row. Mirrors the
// conversation-index sidecar lifecycle (rebuild / persist / loadFromCacheSync /
// lookup) so recall can backfill EXISTING facts whose source rows predate the
// forward stamp.
// ---------------------------------------------------------------------------

/** Return {mtimeMs, size} for a path, or null when absent / unstatable. */
function statFingerprint(path) {
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size || 0 };
  } catch {
    return null;
  }
}

/**
 * buildSenderIndexFromDb — PURE join over an already-open DatabaseSync handle.
 * Returns Map<source_msg_id (== ZSTANZAID), {sender_jid, sender_name}>.
 *
 * Only ENTRIES with a resolvable sender_jid OR sender_name are retained (a pure
 * jid-less / nameless miss adds nothing the caller could not already infer).
 * The caller owns the DB handle lifecycle (never opened/closed here).
 *
 * @param {object} db — node:sqlite DatabaseSync, opened read-only by caller.
 * @returns {Map<string, {sender_jid: string|null, sender_name: string|null}>}
 */
export function buildSenderIndexFromDb(db) {
  const out = new Map();
  if (db == null || typeof db.prepare !== "function") return out;

  // Pushname cache (ZJID -> ZPUSHNAME). Defensive: degrade to {} when absent.
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
    // No pushname table — group members lacking a saved name resolve to jid-only.
  }

  let rows;
  try {
    rows = db
      .prepare(
        `SELECT
           m.ZSTANZAID       AS stanza_id,
           m.ZISFROMME       AS is_from_me,
           m.ZFROMJID        AS from_jid,
           s.ZSESSIONTYPE    AS session_type,
           s.ZPARTNERNAME    AS session_partner_name,
           gm.ZCONTACTNAME   AS member_contact_name,
           gm.ZFIRSTNAME     AS member_first_name,
           gm.ZMEMBERJID     AS member_jid
         FROM ZWAMESSAGE m
         LEFT JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION
         LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER`,
      )
      .all();
  } catch {
    return out; // No joinable table — empty index.
  }

  for (const r of rows) {
    try {
      const stanzaId = typeof r.stanza_id === "string" && r.stanza_id.length > 0 ? r.stanza_id : null;
      if (stanzaId === null) continue;
      // For a 1:1 inbound row the human name lives in ZPARTNERNAME (== the
      // session_label the name-recovery module resolves); pass it through so the
      // resolver renders the partner name without re-opening the session table.
      const sessionLabel =
        typeof r.session_partner_name === "string" && isResolvedName(r.session_partner_name)
          ? r.session_partner_name
          : null;
      const desc = resolveSenderForRow(
        {
          is_from_me: r.is_from_me,
          from_jid: r.from_jid,
          session_type: r.session_type,
          session_label: sessionLabel,
          member_contact_name: r.member_contact_name,
          member_first_name: r.member_first_name,
          member_jid: r.member_jid,
        },
        { pushByJid },
      );
      if (desc.sender_jid == null && desc.sender_name == null) continue;
      out.set(stanzaId, desc);
    } catch {
      // A single malformed row must never abort the rebuild.
    }
  }

  return out;
}

/**
 * buildPartnerAndPushNameMapsFromDb — PURE join over an already-open DatabaseSync
 * handle. Returns the two jid->name sidecars the WhatsApp ADAPTER consumes for a
 * 1:1 row: { partnerByJid, pushByJid }.
 *
 *   partnerByJid : Map<session_jid, ZPARTNERNAME>  — the per-session saved /
 *                  display name (only RESOLVED names; a bare formatted-phone
 *                  ZPARTNERNAME is excluded so a phone string never poses as a
 *                  name — mirrors isResolvedName in the per-row resolver).
 *   pushByJid    : Map<jid, ZPUSHNAME>             — the self-set profile push
 *                  name, the SAME table the per-row resolver's 1:1 + group
 *                  branches consult (recovers a human label when ZPARTNERNAME is
 *                  only a phone string).
 *
 * READ-ONLY, pure, total: a missing table / malformed row degrades to an empty
 * Map for that source — never throws. The caller owns the DB handle lifecycle.
 *
 * @param {object} db — node:sqlite DatabaseSync, opened read-only by caller.
 * @returns {{partnerByJid: Map<string,string>, pushByJid: Map<string,string>}}
 */
export function buildPartnerAndPushNameMapsFromDb(db) {
  const partnerByJid = new Map();
  const pushByJid = new Map();
  if (db == null || typeof db.prepare !== "function") return { partnerByJid, pushByJid };

  // pushByJid — ZJID -> ZPUSHNAME (the profile push-name cache).
  try {
    const rows = db
      .prepare("SELECT ZJID AS jid, ZPUSHNAME AS push FROM ZWAPROFILEPUSHNAME")
      .all();
    for (const r of rows) {
      if (typeof r.jid !== "string" || r.jid.length === 0) continue;
      const push = cleanName(r.push);
      if (push != null && isResolvedName(push)) pushByJid.set(r.jid, push);
    }
  } catch {
    // No pushname table — partnerByJid alone still names saved 1:1 contacts.
  }

  // partnerByJid — ZCONTACTJID (session jid) -> ZPARTNERNAME (saved/display name).
  try {
    const rows = db
      .prepare("SELECT ZCONTACTJID AS jid, ZPARTNERNAME AS name FROM ZWACHATSESSION")
      .all();
    for (const r of rows) {
      if (typeof r.jid !== "string" || r.jid.length === 0) continue;
      const name = cleanName(r.name);
      if (name != null && isResolvedName(name)) partnerByJid.set(r.jid, name);
    }
  } catch {
    // No sessions table — degrade to push-name-only resolution.
  }

  return { partnerByJid, pushByJid };
}

/**
 * buildGroupMemberNamesFromDb — PURE join over an already-open DatabaseSync
 * handle. Returns Map<member_jid, display_name> for group members, resolving the
 * name in the SAME order resolveSenderName uses (ZCONTACTNAME -> ZFIRSTNAME ->
 * ZWAPROFILEPUSHNAME[member_jid]). Only members with a RESOLVED name are retained.
 *
 * READ-ONLY, pure, total: a missing table degrades to an empty Map. The caller
 * owns the DB handle lifecycle.
 *
 * @param {object} db — node:sqlite DatabaseSync, opened read-only by caller.
 * @returns {Map<string, string>} member_jid -> display name.
 */
export function buildGroupMemberNamesFromDb(db) {
  const out = new Map();
  if (db == null || typeof db.prepare !== "function") return out;

  // Push-name cache so a member lacking ZCONTACTNAME/ZFIRSTNAME still resolves.
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
    // No pushname table — members resolve via ZCONTACTNAME/ZFIRSTNAME only.
  }

  let rows;
  try {
    rows = db
      .prepare(
        `SELECT ZMEMBERJID   AS member_jid,
                ZCONTACTNAME  AS contact_name,
                ZFIRSTNAME    AS first_name
         FROM ZWAGROUPMEMBER`,
      )
      .all();
  } catch {
    return out; // No group-member table — empty map.
  }

  for (const r of rows) {
    try {
      const memberJid =
        typeof r.member_jid === "string" && r.member_jid.length > 0 ? r.member_jid : null;
      if (memberJid === null) continue;
      const name = resolveSenderName({
        contactName: r.contact_name,
        firstName: r.first_name,
        memberJid,
        pushByJid,
      });
      if (name != null) out.set(memberJid, name);
    } catch {
      // A single malformed member row must never abort the build.
    }
  }

  return out;
}

/**
 * rebuildSenderIndex — open ChatStorage.sqlite read-only, build the
 * source_msg_id -> sender descriptor map, optionally persist to cachePath.
 * Every failure mode (no DB, FDA denied, node:sqlite unavailable) degrades to an
 * EMPTY index — a recall must NEVER fail because sender recovery could not run.
 *
 * @param {object} opts
 * @param {string} opts.chatStoragePath — absolute path to ChatStorage.sqlite.
 * @param {string} [opts.cachePath] — when set, the rebuilt index is persisted.
 * @returns {Promise<{bySourceMsgId: Map, sourceMtime: number, sourceSize: number, built_at: string}>}
 */
export async function rebuildSenderIndex({ chatStoragePath, cachePath } = {}) {
  const empty = () => ({
    bySourceMsgId: new Map(),
    sourceMtime: 0,
    sourceSize: 0,
    built_at: new Date().toISOString(),
  });

  if (typeof chatStoragePath !== "string" || chatStoragePath.length === 0) {
    return empty();
  }
  if (!existsSync(chatStoragePath)) return empty();

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return empty();
  }

  let db;
  try {
    db = new DatabaseSync(chatStoragePath, { readOnly: true });
  } catch {
    return empty();
  }

  let bySourceMsgId;
  try {
    bySourceMsgId = buildSenderIndexFromDb(db);
  } catch {
    bySourceMsgId = new Map();
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }

  const fp = statFingerprint(chatStoragePath);
  const index = {
    bySourceMsgId,
    sourceMtime: fp ? fp.mtimeMs : 0,
    sourceSize: fp ? fp.size : 0,
    built_at: new Date().toISOString(),
  };

  if (typeof cachePath === "string" && cachePath.length > 0) {
    try {
      persistSenderIndex(index, cachePath);
    } catch {
      // A persist failure must not fail the rebuild — return the in-memory map.
    }
  }
  return index;
}

/**
 * persistSenderIndex — atomic tmp + rename, mode 0600. Short keys j/n keep the
 * on-disk projection compact across tens of thousands of messages.
 */
export function persistSenderIndex(index, cachePath) {
  if (index == null || !(index.bySourceMsgId instanceof Map)) {
    throw new TypeError("persistSenderIndex: index missing bySourceMsgId Map");
  }
  if (typeof cachePath !== "string" || cachePath.length === 0) {
    throw new TypeError("persistSenderIndex: cachePath required");
  }
  const payload = {
    schema_version: SENDER_INDEX_SCHEMA_VERSION,
    builder_version: SENDER_INDEX_VERSION,
    source_mtime_ms: typeof index.sourceMtime === "number" ? index.sourceMtime : 0,
    source_size_bytes: typeof index.sourceSize === "number" ? index.sourceSize : 0,
    built_at: typeof index.built_at === "string" ? index.built_at : new Date().toISOString(),
    entries: serializeSenderEntries(index.bySourceMsgId),
  };
  const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
  renameSync(tmpPath, cachePath);
}

/**
 * loadSenderIndexFromCacheSync — SYNCHRONOUS, CACHE-ONLY load (recall reads it
 * inside a sync path). NEVER rebuilds (the out-of-band build script owns the
 * full DB join). Returns the deserialized index, or null when the cache is
 * absent / corrupt / schema-mismatched / (when requireFresh) fingerprint-stale,
 * so the caller degrades to its non-indexed behavior.
 *
 * @param {object} opts
 * @param {string} opts.cachePath
 * @param {string} [opts.chatStoragePath] — for the optional freshness check.
 * @param {boolean} [opts.requireFresh=false] — when true, the cache is rejected
 *        unless its recorded source mtime+size match the live ChatStorage.sqlite.
 *        Defaults to FALSE: a stale-but-valid sender map is still useful for the
 *        historical facts it covers (sender names do not change), so recall
 *        prefers a stale hit over no hit.
 * @returns {{bySourceMsgId: Map, sourceMtime:number, sourceSize:number, built_at:string} | null}
 */
export function loadSenderIndexFromCacheSync({ cachePath, chatStoragePath, requireFresh = false } = {}) {
  if (typeof cachePath !== "string" || cachePath.length === 0) return null;
  if (!existsSync(cachePath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || parsed.schema_version !== SENDER_INDEX_SCHEMA_VERSION) return null;
  if (requireFresh) {
    const fp =
      typeof chatStoragePath === "string" && chatStoragePath.length > 0
        ? statFingerprint(chatStoragePath)
        : null;
    const mtimeOk = fp != null && parsed.source_mtime_ms === fp.mtimeMs;
    const sizeOk = fp != null && parsed.source_size_bytes === fp.size;
    if (!(mtimeOk && sizeOk)) return null;
  }
  return {
    bySourceMsgId: deserializeSenderEntries(parsed.entries),
    sourceMtime: typeof parsed.source_mtime_ms === "number" ? parsed.source_mtime_ms : 0,
    sourceSize: typeof parsed.source_size_bytes === "number" ? parsed.source_size_bytes : 0,
    built_at: typeof parsed.built_at === "string" ? parsed.built_at : new Date().toISOString(),
  };
}

/**
 * lookupSender — resolve a source_msg_id to its sender descriptor. Returns null
 * on a miss (never throws on a miss). Defensive copy.
 *
 * @param {{bySourceMsgId: Map}} index
 * @param {string} sourceMsgId
 * @returns {{sender_jid: string|null, sender_name: string|null} | null}
 */
export function lookupSender(index, sourceMsgId) {
  if (index == null || !(index.bySourceMsgId instanceof Map)) return null;
  if (typeof sourceMsgId !== "string" || sourceMsgId.length === 0) return null;
  const hit = index.bySourceMsgId.get(sourceMsgId);
  if (hit == null) return null;
  return {
    sender_jid: typeof hit.sender_jid === "string" ? hit.sender_jid : null,
    sender_name: typeof hit.sender_name === "string" ? hit.sender_name : null,
  };
}

/** Serialize Map<source_msg_id, {sender_jid, sender_name}> -> compact object. */
export function serializeSenderEntries(bySourceMsgId) {
  const out = {};
  if (!(bySourceMsgId instanceof Map)) return out;
  for (const [smid, desc] of bySourceMsgId) {
    if (desc == null || typeof desc !== "object") continue;
    const j = typeof desc.sender_jid === "string" ? desc.sender_jid : null;
    const n = typeof desc.sender_name === "string" ? desc.sender_name : null;
    if (j === null && n === null) continue;
    out[smid] = { j, n };
  }
  return out;
}

/** Deserialize the compact object back into a Map. Tolerant of tampering. */
export function deserializeSenderEntries(entries) {
  const map = new Map();
  if (entries == null || typeof entries !== "object") return map;
  for (const smid of Object.keys(entries)) {
    const v = entries[smid];
    if (v == null || typeof v !== "object") continue;
    const j = typeof v.j === "string" && v.j.length > 0 ? v.j : null;
    const n = typeof v.n === "string" && v.n.length > 0 ? v.n : null;
    if (j === null && n === null) continue;
    map.set(smid, { sender_jid: j, sender_name: n });
  }
  return map;
}

// Default sender-index cache path — connectors/whatsapp/sender-index.json under
// the configured connectors dir. Imported lazily so this module stays usable in
// a pure-DB (no config) test context.
export async function defaultSenderIndexCachePath() {
  try {
    const { connectorStatePath } = await import("../config.js");
    const statePath = connectorStatePath("whatsapp");
    // Sit the sidecar ALONGSIDE state.json (…/connectors/whatsapp/sender-index.json).
    return statePath.replace(/state\.json$/, "sender-index.json");
  } catch {
    return null;
  }
}

// Test-only internal surface.
export const __internal = Object.freeze({
  cleanName,
  statFingerprint,
  SESSION_TYPE_GROUP,
});
