// adapters/telegram.js — WORKUNIT N6. The Telegram L1 adapter (Wave-1).
//
// Layer 1 of the messaging attention hypergraph: the ONLY code that knows the
// string "telegram". It maps a retained Telegram source row into the frozen N1
// Envelope (mcp/lib/messaging/envelope.js) and encodes every Telegram-specific
// degradation as DATA in capabilities{} — so layers 2..5 (classifier, identity,
// attention engine, catch-up surface) NEVER learn a platform name. A new
// platform = ONE new adapter; the upper layers do not change.
//
// THESIS #1 (immutability). This module is a READ-ONLY derived projection. It
// NEVER writes storage/sources/telegram.jsonl, never mutates a source/fact row,
// never touches the connector's cursor, and opens NO network socket. The
// existing connector (mcp/lib/connectors/telegram.js) OWNS writes; N6 only reads
// already-written rows (and hand-written fixtures) and emits envelopes at query
// time.
//
// ACTIVATION GATE. The live MTProto subscription requires an operator login
// (telegram_login.py writes ~/.config/memory-system/telegram.session). That is
// NOT yet active. So the adapter SHIPS but its collection entry point collect()
// returns [] + an explicit `inactive` marker until a session exists. The PURE
// _toEnvelope mapper works on any row regardless of session state — the gate
// sits at the COLLECTION boundary, never inside the mapper.
//
// CAPABILITY HONESTY (the keystone). structured_mentions=true reflects platform
// NATURE (Telegram has native message_entities) AND adapter readiness (this
// mapper parses entities when present). The upstream staging pipeline does not
// yet EXTRACT entities (telegram_tail.py event_to_record emits no `entities`
// field — telegram_tail.py:275-294), so mentions=[] today. The correct fix is to
// land message.get_entities() extraction in telegram_tail.py, NOT to flip the
// capability to false (which would corrupt N2's platform-agnostic weighting).

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// -----------------------------------------------------------------------------
// Frozen platform constants.
// -----------------------------------------------------------------------------

export const PLATFORM = "telegram";

// Raw source-row fields read by _toEnvelope(), in precedence order. The first
// lives in raw_content; the second is the connector wrapper's fallback.
export const CONTENT_FIELD_SPEC = Object.freeze({
  fields: Object.freeze(["text", "content"]),
  metadata: Object.freeze([]),
});

// The id-space namespace. Every Telegram-derived id (thread_id, sender.id,
// reply_to_id, mention ids) is prefixed so it can NEVER be mistaken for a
// WhatsApp jid / iMessage chat_guid / mail Message-Id by N4's thread join.
const NS = "tg:";

// The capability block — THE KEYSTONE. Degradation as DATA. N2 reads these
// booleans (never the platform name) to weight directed_at_me_signals.
//   reply_to_available     true  — Telegram stores reply_to.reply_to_msg_id (int).
//                                   (Contrast WhatsApp ZPARENTMESSAGE always null.)
//   structured_mentions    true  — native message_entities exist; parsed when present.
//                                   (Pipeline extraction is a telegram_tail.py gap.)
//   self_identity_reliable true  — is_self keyed off cached get_me() numeric id,
//                                   not an @lid mask. (Contrast WhatsApp self @lid.)
//   addressing_first_class false — no To/Cc envelope; recipients implicit in
//                                   chat membership. (Contrast Mail.)
export const CAPABILITIES = Object.freeze({
  reply_to_available: true,
  structured_mentions: true,
  self_identity_reliable: true,
  addressing_first_class: false,
});

// thread_type map (MAP Q1). The WIRE value for a 1:1 is `user` (NOT `private`),
// confirmed at telegram_tail.py:142-150 classify_peer() and telegram.js:280
// default. We accept BOTH `user` and `private` to be robust to the spec prose,
// and collapse supergroup→group so N4 never sees a 4th conversation shape. Kept
// as a single object literal: a new Telegram peer kind = one entry, not a code
// path.
const THREAD_TYPE_BY_PEER = Object.freeze({
  user: "dm",
  private: "dm",
  group: "group",
  supergroup: "group",
  channel: "channel",
});

// The literal sender id the contract uses for the operator's own messages
// (parity with whatsapp/imessage outbound rows).
const SELF_ID = "user";

// Telegram's reserved SERVICE user id (777000 = "Telegram", the login-code /
// official-notification account). Messages from it are platform service traffic,
// not a human counterparty (N11, A2). Matched as the numeric id OR its string form
// so it is stamped sender.kind="service" and excluded by L2-5 as DATA.
const TELEGRAM_SERVICE_ID = "777000";

/**
 * classifyTelegramSenderKind — Telegram's L1 sender-kind stamp (N11, A2).
 *   - the 777000 service account (by peer OR sender id) => "service".
 *   - an is_bot sender                                  => "bot".
 *   - otherwise                                          => "person".
 * Pure; reads only DATA off the row's raw_content. The numeric/string id forms
 * both normalize through idStr so the wire shape (number) and a stringified id match.
 *
 * @param {object} rc - the row's raw_content (already isPlainObject-checked).
 * @returns {"person"|"bot"|"service"}
 */
function classifyTelegramSenderKind(rc) {
  const senderId = idStr(rc.sender_id);
  const peerId = idStr(rc.peer_id);
  if (senderId === TELEGRAM_SERVICE_ID || peerId === TELEGRAM_SERVICE_ID) {
    return "service";
  }
  if (rc.is_bot === true || rc.sender_is_bot === true) return "bot";
  return "person";
}

// -----------------------------------------------------------------------------
// Small pure helpers (no IO, no throw on optional-field absence).
// -----------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Coerce a peer/sender/message numeric-or-string id to a stable string. Telegram
// ids arrive as numbers (e.g. -1001234567890) OR strings; we stringify so the
// envelope id is always a non-empty string. Returns null for null/undefined.
function idStr(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v !== "") return v;
  return null;
}

// Parse the source ISO-8601 ts into integer-ms. The N1 contract REQUIRES
// integer-ms (rejects ISO strings, floats, numeric strings). An unparseable ts
// must FAIL LOUDLY rather than emit NaN downstream (REVIEW R7).
function toEpochMs(ts) {
  if (typeof ts === "number" && Number.isInteger(ts) && ts > 0) return ts;
  if (typeof ts === "string" && ts !== "") {
    const ms = Date.parse(ts);
    if (Number.isInteger(ms) && ms > 0) return ms;
  }
  throw new TypeError(
    `telegram adapter: unparseable ts ${JSON.stringify(ts)} (need ISO-8601 or integer-ms)`,
  );
}

// Parse Telegram message_entities into structured mentions (MAP Q4). We support
// the two mention entity kinds Telethon surfaces, by the _ discriminator the
// MTProto to_dict() shape uses, with tolerant fallbacks for a plain `type`
// string. We DO NOT regex @handles out of free text — that is the WhatsApp
// degradation path; Telegram's contract is structured, so we keep the parser
// exact and the capability honest.
//   MessageEntityMentionName -> { id: "tg:"+user_id, name: null }   (resolved id)
//   MessageEntityMention     -> { id: null,          name: "@slice" } (text @handle)
function parseMentions(entities, text) {
  if (!Array.isArray(entities)) return [];
  const out = [];
  for (const e of entities) {
    if (!isPlainObject(e)) continue;
    const kind = e._ || e.type || e.className || null;
    if (kind === "MessageEntityMentionName" || kind === "messageEntityMentionName") {
      const uid = idStr(e.user_id);
      out.push({ id: uid ? NS + uid : null, name: null });
    } else if (kind === "MessageEntityMention" || kind === "messageEntityMention") {
      // Bare @handle: id unresolved, name is the text slice (best-effort).
      let name = null;
      if (
        typeof text === "string" &&
        Number.isInteger(e.offset) &&
        Number.isInteger(e.length) &&
        e.offset >= 0 &&
        e.offset + e.length <= text.length
      ) {
        name = text.slice(e.offset, e.offset + e.length);
      }
      out.push({ id: null, name });
    }
    // Other entity kinds (bold, url, ...) are not mentions; ignore.
  }
  return out;
}

// -----------------------------------------------------------------------------
// _toEnvelope — the PURE mapper. No IO, no session read. Same input ⇒ same
// envelope. Throws ONLY when the row is structurally invalid (no peer_type /
// no peer_id / unparseable ts) — never on a merely-absent OPTIONAL field.
// -----------------------------------------------------------------------------

/**
 * Map a retained Telegram source row into the frozen N1 Envelope.
 *
 * Accepts EITHER the connector's row wrapper
 *   { source_msg_id, ts, parties, raw_content:{...}, content }
 * OR a bare staging event of the same raw_content field set (the mapper reads
 * raw_content when present, otherwise treats the row itself as raw_content).
 *
 * @param {object} row - a Telegram source row (see telegram.js buildRow shape).
 * @returns {import("../envelope.js").Envelope}
 */
export function _toEnvelope(row) {
  if (!isPlainObject(row)) {
    throw new TypeError("telegram adapter: row must be an object");
  }
  // The connector wraps raw_content; a bare staging event carries the fields at
  // top level. Support both without a platform branch leaking upward.
  const rc = isPlainObject(row.raw_content) ? row.raw_content : row;

  const peerType = rc.peer_type;
  if (typeof peerType !== "string" || peerType === "") {
    throw new TypeError("telegram adapter: row missing peer_type");
  }
  const thread_type = THREAD_TYPE_BY_PEER[peerType];
  if (thread_type === undefined) {
    throw new TypeError(`telegram adapter: unknown peer_type ${JSON.stringify(peerType)}`);
  }

  const peerIdStr = idStr(rc.peer_id);
  if (peerIdStr === null) {
    throw new TypeError("telegram adapter: row missing peer_id");
  }
  const thread_id = NS + peerIdStr;

  // is_from_me — the DUAL signal (REVIEW R6). is_self covers the operator's own
  // message seen via a second device path even when is_outgoing is false.
  const is_from_me = !!(rc.is_outgoing || rc.is_self);

  // sender — operator-own rows normalize to the literal "user"; others namespace
  // the numeric sender id. name is null when unresolved (no throw). kind (N11,A2)
  // is stamped from platform signals: the operator's own messages are a person;
  // inbound senders classify the 777000 service account / is_bot accounts.
  let sender;
  if (is_from_me) {
    sender = { id: SELF_ID, name: SELF_ID, kind: "person" };
  } else {
    const sid = idStr(rc.sender_id);
    sender = {
      id: sid ? NS + sid : NS + peerIdStr, // fall back to peer id (a 1:1 sender)
      name: typeof rc.sender_name === "string" ? rc.sender_name : null,
      kind: classifyTelegramSenderKind(rc),
    };
  }

  // recipients — DERIVED (Telegram has no To/Cc; MAP Q6). Inbound is addressed
  // to the operator; outbound is addressed to the thread peer. Parity with the
  // whatsapp/imessage adapters.
  const recipients = is_from_me ? [thread_id] : [SELF_ID];

  // ts — ISO-8601 string → integer-ms (REVIEW R7). Prefer the wrapper ts; fall
  // back to a raw_content-level ts if a bare event carries it.
  const ts = toEpochMs(row.ts !== undefined ? row.ts : rc.ts);

  // content — string, may be "" for media rows (REVIEW R8). The adapter does NOT
  // apply Stage-0 drops; that is the connector's job upstream.
  let content;
  if (typeof rc.text === "string") content = rc.text;
  else if (typeof row.content === "string") content = row.content;
  else content = null;

  // reply_to_id — namespaced (REVIEW R5). The wire value is a BARE int
  // message_id; we namespace it as "tg:<peer>:<msg>" so N4 never collides it with
  // a WhatsApp/iMessage reply target. Absent ⇒ null (NOT "tg::").
  const replyRaw = idStr(rc.reply_to);
  const reply_to_id = replyRaw !== null ? `${NS}${peerIdStr}:${replyRaw}` : null;

  // mentions — structured parse of entities when present; [] otherwise (MAP Q4).
  const mentions = parseMentions(rc.entities, content);

  // directed_at_me_signals — the L2 INPUT surface (boolean evidence, not scores).
  //   mention_me      true iff any parsed mention id resolves to the operator.
  //                   Operator id is not yet wired into this layer; conservatively
  //                   false until identity resolution (N3) provides the self id.
  //   reply_to_me     conservatively false: reply_to is a bare message_id with no
  //                   per-message authorship index yet (the join to "did the
  //                   operator author the replied-to message?" is a later node).
  //                   capabilities.reply_to_available stays TRUE so N2 treats the
  //                   signal as KNOWN-but-negative, not unknown.
  //   addressed_to_me for a dm INBOUND row it is true by construction (a 1:1 is
  //                   addressed to the operator); false otherwise. Encoded as DATA
  //                   here, never as a platform branch leaking into N2.
  const directed_at_me_signals = {
    mention_me: false,
    reply_to_me: false,
    addressed_to_me: thread_type === "dm" && !is_from_me,
  };

  // source_msg_id — passthrough join key back to the raw source row. Fall back to
  // the namespaced peer:msg composite if a bare event lacks the wrapper field.
  let source_msg_id;
  if (typeof row.source_msg_id === "string" && row.source_msg_id !== "") {
    source_msg_id = row.source_msg_id;
  } else {
    const mid = idStr(rc.message_id);
    source_msg_id = mid !== null ? `${NS}${peerIdStr}:${mid}` : thread_id;
  }

  return {
    platform: PLATFORM,
    thread_id,
    thread_type,
    sender,
    recipients,
    is_from_me,
    ts,
    content,
    reply_to_id,
    mentions,
    directed_at_me_signals,
    // Spread a fresh copy so a caller can never mutate the frozen constant.
    capabilities: { ...CAPABILITIES },
    source_msg_id,
  };
}

// -----------------------------------------------------------------------------
// Activation gate.
// -----------------------------------------------------------------------------

// The marker the inactive collection path returns (and logs). Stable string so a
// test / operator dashboard can match it.
export const INACTIVE_MARKER =
  "telegram inactive: login not active (run telegram_login.py)";

// Resolve the session-file path (MAP Q8): TELEGRAM_SESSION_FILE override, else
// the documented default ~/.config/memory-system/telegram.session — the SAME
// path telegram_login.py / telegram_tail.py use.
function sessionFilePath(env) {
  const override = env.TELEGRAM_SESSION_FILE;
  if (typeof override === "string" && override !== "") return override;
  return path.join(os.homedir(), ".config", "memory-system", "telegram.session");
}

/**
 * Is a Telegram login active? Keys off the SAME signals the Python helper uses
 * (MAP Q8): a TELEGRAM_SESSION_STRING env var OR an on-disk session file. Pure
 * predicate — reads only env + file EXISTENCE (never the session bytes), opens
 * no socket. Injectable env for hermetic tests.
 *
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
export function isActive(env = process.env) {
  if (typeof env.TELEGRAM_SESSION_STRING === "string" && env.TELEGRAM_SESSION_STRING !== "") {
    return true;
  }
  try {
    return existsSync(sessionFilePath(env));
  } catch {
    return false;
  }
}

/**
 * The gated collection entry point. When no session is active it returns
 * { envelopes: [], inactive: true, marker } WITHOUT throwing and WITHOUT any
 * network IO. When active it maps the supplied source rows through _toEnvelope.
 *
 * NOTE: even when active this function does NOT read the live network or the
 * source ledger itself — the caller supplies already-retained rows via
 * opts.rows. This keeps the adapter a pure read-only projection (Thesis #1): it
 * never races the connector's owned write/cursor path.
 *
 * @param {object} [opts]
 * @param {object[]} [opts.rows]  - retained Telegram source rows to map.
 * @param {object}   [opts.env]   - env for the activation predicate (tests).
 * @returns {{ envelopes: import("../envelope.js").Envelope[], inactive: boolean, marker: string|null }}
 */
export function collect(opts = {}) {
  const env = isPlainObject(opts.env) ? opts.env : process.env;
  if (!isActive(env)) {
    return { envelopes: [], inactive: true, marker: INACTIVE_MARKER };
  }
  const rows = Array.isArray(opts.rows) ? opts.rows : [];
  const envelopes = [];
  for (const row of rows) {
    // Defensive: a single malformed row never sinks the whole batch. The pure
    // mapper throws on structural invalidity; we skip-and-continue so collect()
    // is total over a mixed batch (the connector already Stage-0-filtered).
    try {
      envelopes.push(_toEnvelope(row));
    } catch {
      // skip structurally-invalid row
    }
  }
  return { envelopes, inactive: false, marker: null };
}
