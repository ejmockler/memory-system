// adapters/whatsapp.js — WORKUNIT N3, the WhatsApp adapter for the messaging
// attention hypergraph (Wave-0, conforms to the N1 FROZEN Envelope contract).
//
// PURPOSE:
//   _toEnvelope(raw_whatsapp_row[, opts]) -> Envelope. A PURE, read-only mapper
//   from ONE retained WhatsApp source-ledger row (storage/sources/whatsapp.jsonl)
//   to the platform-agnostic Envelope shape every downstream layer reads. This is
//   the ONLY code in the stack that knows WhatsApp's limits; it encodes them once
//   into capabilities{} so the classifier (N2) and attention engine degrade by
//   reading booleans — never by branching on the platform name. (Thesis #1: this
//   layer NEVER mutates a source/fact row; it derives an in-memory projection.)
//
// THE WHATSAPP CAPABILITY PROFILE (all four FALSE — the maximally-degraded case):
//   reply_to_available     = false  ZPARENTMESSAGE is null on this host's schema;
//                                    WhatsApp Desktop does not retain a reply
//                                    target, so we can never know reply_to.
//   structured_mentions    = false  mentions are TEXT-embedded "@<digits>" — there
//                                    is no structured mention primitive to parse,
//                                    so mentions[] is ALWAYS empty (we do NOT scrape
//                                    the @digits text into mentions[]: a digit run
//                                    is not a resolvable {id,name} the contract can
//                                    trust, and capability=false already tells the
//                                    classifier not to weight mentions).
//   self_identity_reliable = false  the operator's own id is an @lid-masked linked
//                                    id, so "was I mentioned?" cannot be trusted.
//   addressing_first_class = false  no To/Cc envelope; addressing is implicit.
//   => because the platform CANNOT TELL, every directed_at_me_signals.* is false.
//
// SENDER RESOLUTION (reuses whatsapp-sender-index.js — the SAME pure resolver the
//   connector forward-stamp and the derived backfill index use, so the three paths
//   never drift). A retained row predates the forward stamp (no sender_* keys), so
//   the adapter resolves the sender via resolveSenderForRow() over the raw_content
//   fields, optionally enriched by a READ-ONLY name sidecar the caller passes:
//     opts.partnerByJid : Map<jid, ZPARTNERNAME>  (1:1 saved/display name)
//     opts.pushByJid    : Map<jid, ZPUSHNAME>     (self-set profile push name)
//     opts.memberNames  : Map<member_jid, name>   (group member display name)
//   These sidecars are deletable/rebuildable from the operator-owned, local
//   ChatStorage.sqlite; the adapter degrades to sender_name=null when absent.
//   The 1:1 partner-name GAP (WU N3) is FILLED in resolveSenderForRow: for a 1:1
//   inbound row whose ZPARTNERNAME is only a formatted phone string, the partner's
//   OWN push name (pushByJid[from_jid]) recovers the human label. Measured over
//   6239 real 1:1 inbound rows: sender_name null-rate 5.5% -> 0.4%.
//
// DISCIPLINE: ESM, defensive (never throws on a malformed row — degrades to a
//   best-effort envelope that the N1 validator then judges), Node stdlib only, no
//   DB, no network, no fs. Pure: same input -> same output.

import {
  resolveSenderForRow,
  SELF_PARTY,
  buildPartnerAndPushNameMapsFromDb,
  buildGroupMemberNamesFromDb,
} from "../../connectors/whatsapp-sender-index.js";
import { defaultChatStoragePath } from "../../connectors/whatsapp-name-recovery.js";

// The platform slug this adapter stamps. Single source of truth.
export const PLATFORM = "whatsapp";

// Raw source-row fields whose values can carry the adapter's semantic payload.
// Media metadata does not rescue an empty caption because Stage-0 treats that
// shape as content-free for scoring.
export const CONTENT_FIELD_SPEC = Object.freeze({
  fields: Object.freeze(["text"]),
  metadata: Object.freeze([]),
});

// ZSESSIONTYPE constants observed on this host's ChatStorage / retained ledger:
//   0 = one-on-one        -> dm
//   1 = group             -> group
//   3 = status / broadcast -> channel
//   4 = (announcement) group -> group
//   null / other          -> resolved by JID suffix instead (more reliable).
const SESSION_TYPE_DM = 0;
const SESSION_TYPE_GROUP = 1;
const SESSION_TYPE_STATUS = 3;
const SESSION_TYPE_ANNOUNCE_GROUP = 4;

/**
 * classifyThreadType — map a row to the FROZEN thread_type enum {dm,group,channel}.
 *
 * The JID SUFFIX is the primary, most-reliable signal (it survives a null/unknown
 * session_type); session_type is a corroborating fallback. This keeps the enum
 * EXHAUSTIVE over real data (the MAP probe's {0,1} was incomplete — session_type 3
 * and 4 and a null exist in the live ledger).
 *   @g.us                          -> group
 *   @s.whatsapp.net / @lid         -> dm
 *   @broadcast / @status / @lid.status -> channel (broadcast/status pseudo-chats)
 *   otherwise                      -> session_type fallback, default 'dm'.
 *
 * @param {string|null} sessionJid
 * @param {number|null} sessionType
 * @returns {"dm"|"group"|"channel"}
 */
export function classifyThreadType(sessionJid, sessionType) {
  if (typeof sessionJid === "string" && sessionJid.length > 0) {
    if (sessionJid.endsWith("@g.us")) return "group";
    if (sessionJid.endsWith("@s.whatsapp.net") || sessionJid.endsWith("@lid")) return "dm";
    if (
      sessionJid === "status@broadcast" ||
      sessionJid.endsWith("@status") ||
      sessionJid.endsWith("@lid.status") ||
      sessionJid.endsWith("@broadcast")
    ) {
      return "channel";
    }
  }
  // JID was null/unrecognized — fall back to the session_type integer.
  const st = Number.isInteger(sessionType) ? sessionType : null;
  if (st === SESSION_TYPE_GROUP || st === SESSION_TYPE_ANNOUNCE_GROUP) return "group";
  if (st === SESSION_TYPE_STATUS) return "channel";
  if (st === SESSION_TYPE_DM) return "dm";
  // Last-resort default: a one-to-one conversation (the least-surprising shape).
  return "dm";
}

/** Coerce a possibly-string session_type to an integer, or null. */
function sessionTypeOf(v) {
  if (Number.isInteger(v)) return v;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** True when the row is operator-authored (outbound). Tolerant of 1/true. */
function isFromMe(v) {
  return v === 1 || v === true;
}

/**
 * toEpochMs — convert the row's ISO-8601 `ts` (the literal shape the ledger
 * stamps) to INTEGER milliseconds since epoch (the N1 contract: ts is integer-ms,
 * NOT a string). Accepts an already-integer ms too (idempotent). Returns null on
 * an unparseable value so the validator catches the boundary failure rather than
 * letting a string slip downstream (where it would sort lexically).
 *
 * @param {string|number} ts
 * @returns {number|null}
 */
export function toEpochMs(ts) {
  if (typeof ts === "number" && Number.isInteger(ts) && ts > 0) return ts;
  if (typeof ts === "string" && ts.length > 0) {
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
}

/** Non-empty string or null. */
function strOrNull(v) {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * classifySenderKind — WhatsApp's L1 sender-kind stamp (N11, A2). System/broadcast
 * pseudo-senders (the status feed, status threads, broadcast lists) are NOT people;
 * they are stamped "system" so L2-5 exclude them by reading DATA. Everything else
 * on WhatsApp is a person (the platform has no bot/service account signal we can
 * read from a retained row). The signal is the channel/broadcast/status JID shape —
 * the SAME shapes classifyThreadType maps to "channel" and whatsapp-name-recovery's
 * classifyJid treats as status/broadcast noise.
 *
 * @param {string|null} sessionJid
 * @param {string|null} fromJid
 * @param {"dm"|"group"|"channel"} threadType
 * @returns {"person"|"system"}
 */
export function classifySenderKind(sessionJid, fromJid, threadType) {
  for (const jid of [sessionJid, fromJid]) {
    if (typeof jid !== "string" || jid.length === 0) continue;
    if (
      jid === "status@broadcast" ||
      jid.endsWith("@status") ||
      jid.endsWith("@lid.status") ||
      jid.endsWith("@broadcast")
    ) {
      return "system";
    }
  }
  // A channel-typed thread with no explicit broadcast/status jid is still a
  // broadcast surface (the JID suffix is the primary signal, threadType the
  // corroborating fallback — mirrors classifyThreadType's own precedence).
  if (threadType === "channel") return "system";
  return "person";
}

// Best-effort, NON-RAW label for a genuinely-unresolvable 1:1 @lid sender (N11,
// A1 floor). When neither the partner sidecar nor the push-name fallback names a
// 1:1 @lid partner, the catch-up surface must NOT show the raw "<digits>@lid" jid.
// We derive a stable, human-recognizable placeholder from the jid's local-part —
// "WhatsApp user <last-4>" — so the operator sees a labeled DM, not an opaque
// linked-id. This is a DOCUMENTED FLOOR: it is best-effort (a real push name
// supersedes it whenever the sidecar is available), never a fabricated identity.
// Returns null for a non-@lid jid (those resolve via the normal name paths).
export function bestEffortLidLabel(jid) {
  if (typeof jid !== "string" || !jid.endsWith("@lid")) return null;
  const local = jid.slice(0, -"@lid".length);
  const digits = local.replace(/[^0-9]/g, "");
  if (digits.length === 0) return null;
  const tail = digits.length >= 4 ? digits.slice(-4) : digits;
  return `WhatsApp user ${tail}`;
}

/**
 * _toEnvelope — map ONE retained WhatsApp source row to an N1 Envelope.
 *
 * Input row shape (storage/sources/whatsapp.jsonl line): {
 *   id, ts (ISO), source:"whatsapp", source_msg_id, parties[], raw_content:{
 *     text, from_jid, to_jid, session_jid, is_from_me(0|1), message_type,
 *     group_event_type, session_type, message_date_coredata, has_media,
 *     media_local_path, media_title, starred, low_signal_message_type, ...
 *     // NOTE: retained rows predate the forward stamp -> NO sender_jid /
 *     // sender_name / session_label / member_jid keys. The adapter tolerates
 *     // their absence and resolves the sender externally.
 *   }
 * }
 *
 * @param {object} row — a retained whatsapp.jsonl row.
 * @param {object} [opts]
 * @param {Map<string,string>} [opts.partnerByJid] — jid -> ZPARTNERNAME (1:1 name).
 * @param {Map<string,string>} [opts.pushByJid]    — jid -> ZPUSHNAME (push name).
 * @param {Map<string,string>} [opts.memberNames]  — member_jid -> display name.
 * @returns {object} an Envelope (always returned; correctness judged by validateEnvelope).
 */
export function _toEnvelope(row, opts = {}) {
  // Fail-closed: a non-object row yields a deliberately-INVALID envelope (empty
  // thread_id) the N1 validator rejects — never a throw on the caller's path.
  if (row == null || typeof row !== "object") {
    return buildEnvelope({
      threadId: null,
      threadType: "dm",
      senderId: null,
      senderName: null,
      recipients: [],
      isFromMe: false,
      ts: null,
      content: null,
      sourceMsgId: null,
    });
  }

  const rc = row.raw_content && typeof row.raw_content === "object" ? row.raw_content : {};

  const sessionJid = strOrNull(rc.session_jid);
  const sessionType = sessionTypeOf(rc.session_type);
  const fromJid = strOrNull(rc.from_jid);
  const toJid = strOrNull(rc.to_jid);
  const outbound = isFromMe(rc.is_from_me);

  const threadType = classifyThreadType(sessionJid, sessionType);

  // ---- sender resolution (reuse the shared pure resolver) -----------------
  // Build the optional read-only name sidecars into the row the resolver expects.
  // For a 1:1 row, session_label carries the resolved ZPARTNERNAME (the resolver
  // also applies the push-name fallback we added in WU N3). For a group row,
  // member_jid + member name feed the group branch.
  const partnerByJid = opts && opts.partnerByJid instanceof Map ? opts.partnerByJid : null;
  const pushByJid = opts && opts.pushByJid instanceof Map ? opts.pushByJid : null;
  const memberNames = opts && opts.memberNames instanceof Map ? opts.memberNames : null;

  // member_jid: a retained row lacks it; the resolver's group branch also accepts
  // session_type===group with a from_jid fallback. When a sidecar can name the
  // member, pass it through. (For a @g.us row, from_jid IS the group jid, not the
  // member — so member naming requires the caller's sidecar to be useful.)
  const memberJid = strOrNull(rc.member_jid);
  const memberName =
    memberNames != null && memberJid != null ? strOrNull(memberNames.get(memberJid)) : null;

  // session_label: the resolved 1:1 partner display name. Prefer an explicit
  // stamped session_label; else look it up in the partner sidecar by from_jid.
  let sessionLabel = strOrNull(rc.session_label);
  if (sessionLabel == null && partnerByJid != null && fromJid != null) {
    sessionLabel = strOrNull(partnerByJid.get(fromJid));
  }

  const { sender_jid: senderJid, sender_name: senderNameRaw } = resolveSenderForRow(
    {
      is_from_me: rc.is_from_me,
      from_jid: fromJid,
      session_type: sessionType,
      session_label: sessionLabel,
      member_contact_name: memberName,
      member_first_name: null,
      member_jid: memberJid,
    },
    pushByJid != null ? { pushByJid } : {},
  );

  // ---- 1:1 @lid name FLOOR (A1) -------------------------------------------
  // When the shared resolver could not name a 1:1 @lid INBOUND partner (no saved
  // ZPARTNERNAME, no push name in the sidecar), surface a best-effort NON-RAW
  // label instead of letting the raw @lid jid reach the catch-up. A genuinely
  // resolved name (from the sidecar) ALWAYS wins; this floor only fills a null.
  //
  // The floor is OPT-IN via opts.lidNameFloor (DEFAULT ON). It is a DISPLAY floor
  // for the catch-up surface — NOT a resolution result — so a caller measuring
  // genuine push-name resolution (the N3 metric) passes lidNameFloor:false to read
  // the unmasked null. The catch-up path leaves it on so no raw @lid is shown.
  const lidNameFloor = !(opts && opts.lidNameFloor === false);
  let senderName = strOrNull(senderNameRaw);
  if (lidNameFloor && senderName == null && !outbound && threadType === "dm") {
    senderName = bestEffortLidLabel(strOrNull(senderJid) || fromJid);
  }

  // ---- sender.kind (A2) ----------------------------------------------------
  // The operator's own outbound messages are a person ("user"); inbound senders
  // are person unless the thread is a system/broadcast surface.
  const senderKind = outbound
    ? "person"
    : classifySenderKind(sessionJid, fromJid, threadType);

  // ---- recipients ----------------------------------------------------------
  // Outbound: the recipient is the conversation partner (to_jid, else session_jid).
  // Inbound: the recipient is the operator (the SELF sentinel). Empty when unknown.
  let recipients;
  if (outbound) {
    const dest = toJid || sessionJid;
    recipients = dest != null ? [dest] : [];
  } else {
    recipients = [SELF_PARTY];
  }

  return buildEnvelope({
    threadId: sessionJid,
    threadType,
    senderId: strOrNull(senderJid),
    senderName,
    senderKind,
    recipients,
    isFromMe: outbound,
    ts: toEpochMs(row.ts),
    content: voiceContent(rc, threadType),
    sourceMsgId: resolveSourceMsgId(row),
  });
}

// ---------------------------------------------------------------------------
// Voice transcripts (STT). A voice note's transcript reaches the ledger two ways:
//   (a) in-band: the voice row itself carries raw_content.text +
//       raw_content.text_origin:"stt";
//   (b) late: a separate enrichment row { source_msg_id:"<stanza>#stt",
//       kind:"voice_transcript", derived_from:["<stanza>"], ts/parties copied
//       from the parent, raw_content = parent raw_content + text +
//       text_origin:"stt" + stt }.
// Both render as "[voice] <text>". The enrichment never becomes its own message:
// foldVoiceTranscripts (below) projects it onto the parent in memory, and an
// unfolded enrichment row still resolves to the PARENT stanza id (never "#stt").
// Legacy / non-STT rows map byte-identically to before.
// ---------------------------------------------------------------------------

const VOICE_PREFIX = "[voice] ";

/**
 * voiceContent — envelope content for a row's raw_content (pure). The "[voice] "
 * prefix is emitted ONLY for a 1:1 (dm) thread — defense in depth for the
 * 1:1-only STT decision: an in-band stt row in a group/channel keeps today's
 * plain-text content.
 */
function voiceContent(rc, threadType) {
  if (
    threadType === "dm" &&
    rc.text_origin === "stt" &&
    typeof rc.text === "string" &&
    rc.text.trim().length > 0
  ) {
    return VOICE_PREFIX + rc.text.trim();
  }
  return typeof rc.text === "string" ? rc.text : null;
}

const STT_SUFFIX = "#stt";

/**
 * enrichmentParentStanza — the parent stanza of a voice_transcript row, else null.
 * derived_from[0] wins; when it is missing/invalid/empty, a source_msg_id of the
 * form "<stanza>#stt" (non-empty stem) resolves to the stem, so no envelope id
 * ever ends in "#stt".
 */
function enrichmentParentStanza(row) {
  if (row == null || typeof row !== "object" || row.kind !== "voice_transcript") return null;
  const df = row.derived_from;
  if (Array.isArray(df) && typeof df[0] === "string" && df[0].length > 0) return df[0];
  const id = row.source_msg_id;
  if (typeof id === "string" && id.endsWith(STT_SUFFIX) && id.length > STT_SUFFIX.length) {
    return id.slice(0, -STT_SUFFIX.length);
  }
  return null;
}

/** rowRawContent — a row's raw_content object, else {} (pure). */
function rowRawContent(row) {
  return row != null && typeof row === "object" && row.raw_content && typeof row.raw_content === "object"
    ? row.raw_content
    : {};
}

/** rowThreadType — the row's thread_type via the SAME normalization the mapper uses. */
function rowThreadType(row) {
  const rc = rowRawContent(row);
  return classifyThreadType(strOrNull(rc.session_jid), sessionTypeOf(rc.session_type));
}

/** sameSession — both rows carry the SAME non-empty raw_content.session_jid. */
function sameSession(a, b) {
  const ja = rowRawContent(a).session_jid;
  const jb = rowRawContent(b).session_jid;
  return typeof ja === "string" && ja.length > 0 && ja === jb;
}

/** resolveSourceMsgId — parent stanza for an unfolded enrichment row, else the row's own id. */
function resolveSourceMsgId(row) {
  const parent = enrichmentParentStanza(row);
  return parent != null ? parent : strOrNull(row.source_msg_id);
}

/**
 * foldVoiceTranscripts — PURE in-memory projection of late voice_transcript
 * enrichment rows onto their parent voice rows (Thesis #1: never mutates the
 * input array or any row; returns a NEW array; never throws).
 *
 *  1. Enrichment rows (kind "voice_transcript" + a parent stanza from
 *     derived_from[0] or a "<stanza>#stt" id) in a 1:1 (dm) thread are keyed by
 *     parent stanza; the LAST in ledger order wins. An enrichment in a group or
 *     channel thread is ALWAYS dropped (1:1-only decision), parent or not.
 *  2. The FIRST parent row with a matching source_msg_id AND the same non-empty
 *     raw_content.session_jid is emitted as a shallow copy with raw_content =
 *     {...parent.raw_content, text, text_origin:"stt", stt} from the enrichment.
 *     Later duplicate parents of an ENRICHED stanza are dropped; every
 *     enrichment row is dropped. A parent whose session_jid does NOT match is
 *     emitted unchanged (the enrichment never alters it).
 *  3. An enrichment whose parent (any session) is absent from the window is
 *     emitted once as {...enrichment, source_msg_id: stanza} (at the
 *     enrichment's first position).
 *  4. Rows without a matching enrichment stay untouched and in place (incl.
 *     duplicates), preserving today's behavior.
 *
 * @param {Array<object>} rows
 * @returns {Array<object>}
 */
export function foldVoiceTranscripts(rows) {
  if (!Array.isArray(rows)) return rows;
  try {
    const enrichByStanza = new Map();
    let enrichmentCount = 0;
    for (const row of rows) {
      const stanza = enrichmentParentStanza(row);
      if (stanza == null) continue;
      enrichmentCount++;
      // 1:1-only: a group/channel enrichment never enters the map (dropped below).
      if (rowThreadType(row) !== "dm") continue;
      enrichByStanza.set(stanza, row);
    }
    if (enrichmentCount === 0) return rows.slice();

    // Which enriched stanzas have a parent row inside the window?
    const parentPresent = new Set();
    for (const row of rows) {
      if (row == null || typeof row !== "object" || enrichmentParentStanza(row) != null) continue;
      if (typeof row.source_msg_id === "string" && enrichByStanza.has(row.source_msg_id)) {
        parentPresent.add(row.source_msg_id);
      }
    }

    const emitted = new Set();
    const out = [];
    for (const row of rows) {
      const stanza = enrichmentParentStanza(row);
      if (stanza != null) {
        // Enrichment row: dropped, except a parentless dm stanza synthesizes ONE
        // row. A non-dm enrichment is not in the map and is always dropped; a
        // stanza whose parent is present (matching session or not) is handled.
        if (!enrichByStanza.has(stanza)) continue;
        if (!parentPresent.has(stanza) && !emitted.has(stanza)) {
          emitted.add(stanza);
          out.push({ ...enrichByStanza.get(stanza), source_msg_id: stanza });
        }
        continue;
      }
      const id = row != null && typeof row === "object" ? row.source_msg_id : undefined;
      if (typeof id === "string" && enrichByStanza.has(id)) {
        const enr = enrichByStanza.get(id);
        // Session mismatch: the enrichment never touches this parent (emitted as-is).
        if (!sameSession(enr, row)) {
          out.push(row);
          continue;
        }
        if (emitted.has(id)) continue; // later duplicate parent of an enriched stanza
        emitted.add(id);
        const erc = enr.raw_content && typeof enr.raw_content === "object" ? enr.raw_content : {};
        const prc = row.raw_content && typeof row.raw_content === "object" ? row.raw_content : {};
        out.push({
          ...row,
          raw_content: { ...prc, text: erc.text, text_origin: "stt", stt: erc.stt },
        });
        continue;
      }
      out.push(row);
    }
    return out;
  } catch {
    return rows.slice();
  }
}

/** foldRows — the generic, capability-named batch hook (alias of foldVoiceTranscripts). */
export const foldRows = foldVoiceTranscripts;

/**
 * buildEnvelope — assemble the FROZEN N1 Envelope from resolved parts. Every
 * WhatsApp envelope carries the SAME capability profile (all four FALSE) and,
 * consequently, all-false directed_at_me_signals (the platform cannot tell).
 *
 * reply_to_id is DELIBERATELY ABSENT (not null): WhatsApp never stores a reply
 * target, and the contract makes reply_to_id optional. Omitting it (rather than
 * stamping null) is the honest encoding of reply_to_available=false.
 */
function buildEnvelope({
  threadId,
  threadType,
  senderId,
  senderName,
  senderKind,
  recipients,
  isFromMe: fromMe,
  ts,
  content,
  sourceMsgId,
}) {
  return {
    platform: PLATFORM,
    // thread_id must be a non-empty string for the validator; a null sessionJid
    // (the 1 malformed row) yields "" which the validator correctly rejects.
    thread_id: typeof threadId === "string" && threadId.length > 0 ? threadId : "",
    thread_type: threadType,
    sender: {
      id: typeof senderId === "string" && senderId.length > 0 ? senderId : "",
      name: typeof senderName === "string" && senderName.length > 0 ? senderName : null,
      // sender.kind (N11, A2): stamped from platform signals. Defaults to
      // "person" (the common case) when the caller did not classify a kind.
      kind: senderKind === "bot" || senderKind === "service" || senderKind === "system"
        ? senderKind
        : "person",
    },
    recipients: Array.isArray(recipients) ? recipients : [],
    is_from_me: fromMe === true,
    // ts: integer ms or 0 (0 is rejected by isIntegerMs -> the validator surfaces it).
    ts: typeof ts === "number" && Number.isInteger(ts) && ts > 0 ? ts : 0,
    content: typeof content === "string" ? content : null,
    // mentions: ALWAYS empty — WhatsApp has no structured mention primitive
    // (structured_mentions=false). We never scrape @digits text into mentions[].
    mentions: [],
    directed_at_me_signals: {
      // All false: with every capability false, the platform cannot establish any
      // of these signals. The classifier reads capabilities{} and treats these as
      // "platform cannot tell", not as positive evidence of absence.
      mention_me: false,
      reply_to_me: false,
      addressed_to_me: false,
    },
    capabilities: {
      reply_to_available: false,
      structured_mentions: false,
      self_identity_reliable: false,
      addressing_first_class: false,
    },
    source_msg_id: typeof sourceMsgId === "string" && sourceMsgId.length > 0 ? sourceMsgId : "",
  };
}

// ---------------------------------------------------------------------------
// prepareContext — the OPTIONAL, GENERIC adapter-contract hook (N11b). The L5
// catch-up surface calls `adapter.prepareContext?.()` ONCE per registry adapter
// (with NO platform branch) and threads the returned object as `opts` into every
// `toEnvelope(row, opts)` for that adapter. Adapters that do not export it
// default to {} at the call site — so this is the ONLY adapter that needs it, and
// telegram/imessage/mail stay untouched.
//
// THIS adapter (L1, where platform identity legitimately lives) builds the three
// read-only name sidecars `_toEnvelope` already consumes — partnerByJid (1:1
// ZPARTNERNAME), pushByJid (ZPUSHNAME), memberNames (group member display name)
// — from the operator-owned, local ChatStorage.sqlite. So an @lid 1:1 DM whose
// name the DB genuinely knows resolves to that REAL name at catch-up time; the
// best-effort floor label fires ONLY when the DB truly lacks the name.
//
// THESIS #1: the DB is opened { readOnly:true } and CLOSED; this NEVER writes a
// source/fact row. Pure read-only projection.
//
// MEMOIZED per process: the build (a full read-only join over ChatStorage) runs
// AT MOST ONCE — the first call caches the resulting promise and every later call
// returns it. So a catch-up over N adapters opens the DB once, not once per row.
//
// DEFENSIVE: any failure (no FDA, missing DB, no node:sqlite, malformed schema)
// degrades to {} so the adapter falls back to the documented floor label rather
// than crashing the catch-up. NEVER throws to the generic L5 caller.
let _prepareContextPromise = null;

/**
 * prepareContext — build { partnerByJid, pushByJid, memberNames } once, memoized.
 * Generic signature (the L5 call site invokes it with no args). Returns {} on any
 * failure so the caller's generic `toEnvelope(row, ctx)` degrades gracefully.
 *
 * @param {object} [opts]
 * @param {string} [opts.chatStoragePath] — override the DB path (tests).
 * @param {boolean} [opts.noMemo] — bypass the per-process memo (tests).
 * @returns {Promise<{partnerByJid?: Map, pushByJid?: Map, memberNames?: Map}>}
 */
export async function prepareContext(opts = {}) {
  const useMemo = !(opts && opts.noMemo === true);
  if (useMemo && _prepareContextPromise !== null) return _prepareContextPromise;

  const run = (async () => {
    try {
      const chatStoragePath =
        opts && typeof opts.chatStoragePath === "string" && opts.chatStoragePath.length > 0
          ? opts.chatStoragePath
          : await defaultChatStoragePath();
      if (typeof chatStoragePath !== "string" || chatStoragePath.length === 0) return {};

      const { existsSync } = await import("node:fs");
      if (!existsSync(chatStoragePath)) return {};

      let DatabaseSync;
      try {
        ({ DatabaseSync } = await import("node:sqlite"));
      } catch {
        return {};
      }

      let db;
      try {
        db = new DatabaseSync(chatStoragePath, { readOnly: true });
      } catch {
        return {};
      }

      try {
        const { partnerByJid, pushByJid } = buildPartnerAndPushNameMapsFromDb(db);
        const memberNames = buildGroupMemberNamesFromDb(db);
        return { partnerByJid, pushByJid, memberNames };
      } finally {
        try { db.close(); } catch { /* ignore */ }
      }
    } catch {
      // Any unexpected failure degrades to the floor-label path.
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

export default {
  _toEnvelope,
  PLATFORM,
  classifyThreadType,
  classifySenderKind,
  bestEffortLidLabel,
  toEpochMs,
  prepareContext,
  foldVoiceTranscripts,
  foldRows,
};
