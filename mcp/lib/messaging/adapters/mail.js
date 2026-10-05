// adapters/mail.js — WORKUNIT N5: the Email (Mail) adapter for the messaging
// attention hypergraph.
//
// _toEnvelope(raw_mail_row) -> Envelope, conforming EXACTLY to the N1 frozen
// contract (../envelope.js, validateEnvelope()). This is a PURE, READ-ONLY
// projection (Thesis #1): it reads a retained mail source/ledger row and
// returns a NEW Envelope object. It mutates nothing, writes nothing, opens no
// DB handle, performs no network I/O. Operator identity is read from the
// operator-identity module, which loads its config ONCE at import, never per-call.
//
// WHY MAIL IS SPECIAL — the live proof of the capabilities{} keystone:
//   Mail is the ONLY current platform that can set
//   capabilities.addressing_first_class = true. The "is the operator addressed?"
//   question is read DIRECTLY off To:/Cc: membership — it is not inferred. This
//   adapter therefore demonstrates the L1 invariant: per-platform PROMOTION
//   (addressing is first-class here) lives in capabilities{} DATA stamped by the
//   adapter, NOT in a platform branch inside the L2 classifier. L2 reads
//   capabilities.addressing_first_class and lets addressed_to_me dominate; it
//   never says `if (platform === "mail")`.
//
// ABSTRACTION INVARIANT: every mail-specific reality (seconds->ms, Apple
// Envelope-Index column names, the In-Reply-To/References threading, the
// curated-vs-full headers gap) lives HERE and surfaces upward ONLY as the
// agnostic Envelope + capabilities{}. The EMITTED envelope carries no
// mail-specific key outside the frozen contract (no mailbox_url, no dkim_*).

import { extractEmails } from "../../connectors/mail.js";
import { isOperator } from "../../identity/operator-identity.js";
import { classifyStructural } from "../sender-kind.js";

// ---------------------------------------------------------------------------
// platform slug + capabilities{} — THE KEYSTONE (declared once, here).
// ---------------------------------------------------------------------------

const PLATFORM = "mail";

// Raw source-row fields read by _content(), in precedence order. The adapter
// registry exposes this declaration to shared content classification.
export const CONTENT_FIELD_SPEC = Object.freeze({
  fields: Object.freeze(["text", "body_text"]),
  metadata: Object.freeze([]),
});

// The four-key keystone block, EXACTLY the contract shape. Frozen so a
// downstream consumer can never mutate the shared literal.
//   reply_to_available     = true  — In-Reply-To / References give a real reply target
//   structured_mentions    = false — email has no @mention primitive
//   self_identity_reliable = true  — operator emails are exact, unmasked, case-insensitive
//   addressing_first_class = true  — To:/Cc: membership IS the addressing signal
const MAIL_CAPABILITIES = Object.freeze({
  reply_to_available: true,
  structured_mentions: false,
  self_identity_reliable: true,
  addressing_first_class: true,
});

// ---------------------------------------------------------------------------
// Operator identity — the canonical isOperator(., "mail") helper alone. It
// reads the per-host operator-identity config file (see
// ../../identity/operator-identity.js); this adapter ships no addresses and
// loads no identity file of its own, so identifications cannot drift from the
// connector's.
// ---------------------------------------------------------------------------

// isOperatorEmail — canonical isOperator with the "mail" source hint
// (SOURCE_LOOKUP.mail = {emails:true}), on the lowercased address. It does NOT
// re-implement the email-parsing regex (that is reused via extractEmails).
function isOperatorEmail(email) {
  if (typeof email !== "string" || email.length === 0) return false;
  const lc = email.toLowerCase();
  if (isOperator(lc, "mail")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Header access — resolves the MAP-M3 curated-vs-full headers GAP.
//
// The connector's raw_content.headers is a CURATED subset of the full
// lowercased map that _mime-body-extractor.js produces (parseEmail.headers).
// As of G2 that subset DOES carry "in-reply-to" and "references" — present and
// null when the source header is absent — so reply linkage now resolves from
// the connector's canonical row with no snake_case fallback needed. This
// accessor still prefers the richest available map and stays tolerant of every
// shape we may receive:
//   1. raw_mail_row.headers / raw_mail_row.extracted.headers — full map (best)
//   2. raw_mail_row.raw_content.headers — connector's curated subset
//   3. raw_mail_row.raw_content top-level snake_case keys (from/to/cc/
//      in_reply_to/references) — the N1 stub-fixture / hand-built shape
// All header lookups go through here; keys are matched case-insensitively.
//
// RESOLVED in G2 (was a FOLLOW-UP Finding filed by N5): the mail connector now
// surfaces "in-reply-to" and "references" on raw_content.headers
// (lib/connectors/mail.js _buildLedgerRow). Nothing changed in THIS file's
// logic — _headersMap already merges rc.headers, so the adapter started
// resolving reply linkage from real connector rows with zero code change here.
// Do not re-file the Finding.
//
// RUNTIME-CENSUS: run mcp/scripts/verify-mail-reply-linkage.mjs for the dated
// body-resolution ceiling, linkage rate, and storage-cost measurements. Keep
// the output with the investigation; do not copy it into source.
//
// The projection emits both keys, using null to represent unavailable values,
// because omitting them would erase the difference between "we read the message
// and it had no In-Reply-To" and "we never resolved a body, so we do not know".
// That distinction is the reason to pay the measured additive storage cost.
// Missing linkage is dominated by unresolved bodies; repairing it belongs to
// the .emlx index / body-resolution path, not this projection.
function _headersMap(raw) {
  const rc = (raw && raw.raw_content) || {};
  // Collect from every available header source, lowest-precedence first so the
  // richest map wins on conflict:
  //   1. raw_content.headers — the connector's CURATED subset (from/to/cc/...).
  //   2. extracted.headers / raw.headers — the FULL extractor map (adds
  //      in-reply-to/references the curated subset omits). Highest precedence.
  // Merging BOTH (not preferring one exclusively) is what lets a real connector
  // row — curated from/to/cc PLUS a full map carrying the reply linkage —
  // resolve completely.
  const sources = [
    rc.headers,
    raw && raw.extracted && raw.extracted.headers,
    raw && raw.headers,
  ];

  const out = {};
  for (const src of sources) {
    if (src && typeof src === "object") {
      for (const [k, v] of Object.entries(src)) {
        if (typeof k === "string" && v != null) out[k.toLowerCase()] = v;
      }
    }
  }
  // Merge top-level raw_content snake_case keys as a fallback (stub/hand-built
  // rows that carry from/to/cc/in_reply_to/references/message_id directly).
  const ALIASES = {
    from: "from",
    to: "to",
    cc: "cc",
    in_reply_to: "in-reply-to",
    "in-reply-to": "in-reply-to",
    references: "references",
    message_id: "message-id",
    "message-id": "message-id",
    subject: "subject",
  };
  for (const [src, dst] of Object.entries(ALIASES)) {
    if (out[dst] == null && rc[src] != null) out[dst] = rc[src];
  }
  return out;
}

function _header(headers, name) {
  const v = headers[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// Display-name extraction — "Foo Bar <foo@example.com>" -> "Foo Bar".
// Returns null when there is no readable display name (bare-address form).
// Purely structural; no platform branch.
// ---------------------------------------------------------------------------
function _displayName(headerValue, email) {
  if (typeof headerValue !== "string") return null;
  // Take only the first address-spec segment (before the first comma that is
  // not inside angle brackets — good enough for the leading From address).
  const angle = headerValue.indexOf("<");
  if (angle > 0) {
    let name = headerValue.slice(0, angle).trim();
    // Strip surrounding RFC 2822 quotes.
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
      name = name.slice(1, -1).trim();
    }
    if (name.length > 0 && name.toLowerCase() !== email) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// thread_id — mail has NO native thread-id column. Derive a STABLE key from the
// reply-chain ROOT so a reply and its parent share a thread_id (L4 thread state
// groups them):
//   1. FIRST id in References:  (the chain root) — preferred
//   2. In-Reply-To:             (immediate parent, when no References)
//   3. this message's own Message-Id (a thread of one)
//   4. source_msg_id            (last-resort stable key; never empty)
// This heuristic is mail-specific and lives ONLY in this adapter.
// ---------------------------------------------------------------------------
function _messageIds(value) {
  if (typeof value !== "string") return [];
  const ids = value.match(/<[^<>]+>/g);
  return ids ? ids.map((s) => s.trim()) : [];
}

function _threadId(headers, ownMessageId, sourceMsgId) {
  const refs = _messageIds(_header(headers, "references"));
  if (refs.length > 0) return refs[0];
  const inReplyTo = _messageIds(_header(headers, "in-reply-to"));
  if (inReplyTo.length > 0) return inReplyTo[0];
  if (typeof ownMessageId === "string" && ownMessageId.length > 0) {
    return ownMessageId;
  }
  return sourceMsgId;
}

// reply_to_id — In-Reply-To (preferred) else the LAST id in References (the
// immediate parent, References being oldest-first). null when neither present.
function _replyToId(headers) {
  const inReplyTo = _messageIds(_header(headers, "in-reply-to"));
  if (inReplyTo.length > 0) return inReplyTo[0];
  const refs = _messageIds(_header(headers, "references"));
  if (refs.length > 0) return refs[refs.length - 1];
  return null;
}

// ---------------------------------------------------------------------------
// ts — the Apple Envelope Index stores date_received in unix SECONDS
// (mail.js:104-111). The L1 contract REQUIRES integer MILLISECONDS, so we
// multiply by 1000. We also tolerate a row that already carries an ISO ts (the
// ledger-row shape: row.ts is ISO) or an integer-ms ts. The output is ALWAYS an
// integer ms (or null if unresolvable — which validateEnvelope will then flag).
// ---------------------------------------------------------------------------
function _resolveTsMs(raw) {
  // 1. Explicit unix-seconds field (Envelope Index column).
  if (raw && typeof raw.date_received === "number" && Number.isFinite(raw.date_received)) {
    return Math.round(raw.date_received * 1000);
  }
  const rc = (raw && raw.raw_content) || {};
  if (typeof rc.date_received === "number" && Number.isFinite(rc.date_received)) {
    return Math.round(rc.date_received * 1000);
  }
  // 2. Ledger-row ISO ts (row.ts is ISO per mail.js:577-580).
  if (raw && typeof raw.ts === "string") {
    const ms = Date.parse(raw.ts);
    if (Number.isFinite(ms)) return ms;
  }
  // 3. Already integer ms.
  if (raw && typeof raw.ts === "number" && Number.isInteger(raw.ts)) {
    return raw.ts;
  }
  return null;
}

// content — prefer raw_content.text (connector) else raw_content.body_text
// (stub). null is legal (media/placeholder).
function _content(raw) {
  const rc = (raw && raw.raw_content) || {};
  if (typeof rc.text === "string") return rc.text;
  if (typeof rc.body_text === "string") return rc.body_text;
  return null;
}

// source_msg_id — the row's document_id, with the connector's rowid:<n>
// fallback (mail.js:433-435) honored when a row arrives pre-stamped or carries a
// bare rowid.
function _sourceMsgId(raw) {
  if (raw && typeof raw.source_msg_id === "string" && raw.source_msg_id.length > 0) {
    return raw.source_msg_id;
  }
  if (raw && typeof raw.document_id === "string" && raw.document_id.length > 0) {
    return raw.document_id;
  }
  if (raw && (typeof raw.rowid === "number" || typeof raw.rowid === "string")) {
    return `rowid:${raw.rowid}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// _toEnvelope — the single public projection. PURE + READ-ONLY.
// ---------------------------------------------------------------------------

/**
 * Project a retained mail source/ledger row into the frozen N1 Envelope.
 *
 * Reads (tolerant of both the connector's raw_content.headers curated shape and
 * a full extractor headers map / stub snake_case shape). Mutates nothing.
 *
 * @param {object} raw - a mail source/ledger row.
 * @returns {import("../envelope.js").Envelope}
 */
export function _toEnvelope(raw) {
  const headers = _headersMap(raw);

  // Sender ← first From: address. id = email (lowercased by extractEmails),
  // name = display name || null.
  const fromHeader = _header(headers, "from");
  const fromEmails = extractEmails(fromHeader || "");
  const senderId = fromEmails.length > 0 ? fromEmails[0] : null;
  // sender.kind (N11, A2 / P1): a mail From: address carries the STRUCTURAL
  // role-address signal — a local-part like no-reply / support / notifications /
  // billing denotes an automated role channel, not a two-way human counterparty
  // (and an RBM/RCS agent domain is a business service surface). The shared
  // GENERIC classifyStructural (../sender-kind.js) reads this by the local-part
  // SHAPE, domain-agnostic, never a vendor denylist, and returns "service" or
  // null. Null => default "person": an ordinary personal address is never dropped.
  // is_from_me overrides to "person" below (the operator is always a person).
  // is_from_me ← operator authored (From: matches an operator identity).
  const is_from_me = senderId ? isOperatorEmail(senderId) : false;

  // The operator is ALWAYS a person; only an INBOUND From: address is classified
  // by the structural role-address/business signal.
  const structuralKind =
    senderId && !is_from_me
      ? classifyStructural({ id: senderId, email: senderId })
      : null;

  // BROADCAST-ORIGIN signal. classifyStructural reads only the From: LOCAL-PART
  // shape, so it catches no-reply@/support@ but not a newsletter sent from an
  // ordinary-looking address (news@…, hello@…), which is why the catch-up
  // surface re-surfaced every newsletter as a person awaiting reply (measured
  // 2026-07-31: 32 of 40 slots).
  //
  // CRITICAL CONSTRAINT, learned the hard way. `sender.kind` is NOT a soft
  // signal here: a non-person inbound envelope is DROPPED at
  // messaging/attention.js:273 (isExcludedInbound) before an attention record
  // exists, and again at messaging/catchup.js:763. Both precede the contact
  // anchor, which is not consulted until catchup.js:825 and can only multiply a
  // score UPWARD (clamp at catchup.js:476). So marking a sender "service" is a
  // HARD DROP that no contact vouch can reverse — it cannot be justified by
  // "the spine will protect saved contacts", because the spine never sees it.
  //
  // Therefore this MUST NOT key on list membership alone. A human replying on a
  // Google Group / mailman thread posts from their own personal address on a
  // List-Id-bearing message; treating that as bulk would silently delete a real
  // person from the surface, violating the invariant this subsystem states
  // everywhere (sender-kind.js:231 "we default to PERSON — never hard-drop a
  // human"; contacts-anchor.js:26; catchup.js:150/468; attention.js:349).
  //
  // The discriminator is ORIGIN, not channel: a true broadcast is sent BY the
  // list (sender domain == list domain — news@dailybrief.example.com via
  // List-Id dailybrief.example.com), whereas a person merely posts THROUGH one
  // (alice@acme.com via List-Id group.googlegroups.com). Only the former is
  // classified.
  // Ambiguity resolves to "person" — the codebase's stated default.
  const rc = (raw && raw.raw_content) || {};
  const listId = _header(headers, "list-id") || "";
  const senderDomain = senderId && senderId.includes("@")
    ? senderId.slice(senderId.lastIndexOf("@") + 1).toLowerCase()
    : "";
  // Registrable-ish suffix compare: the List-Id value embeds a domain
  // (e.g. "<newsletter.dailybrief.example.com>"), so test containment both
  // ways to tolerate list/sender subdomain differences on the SAME organisation.
  const listDomain = (String(listId).match(/[\w.-]+\.[a-z]{2,}/i) || [""])[0].toLowerCase();
  const sameOrigin =
    senderDomain !== "" && listDomain !== "" &&
    (senderDomain === listDomain ||
      senderDomain.endsWith("." + listDomain) ||
      listDomain.endsWith("." + senderDomain));
  const isBroadcastOrigin = listDomain !== "" && sameOrigin;

  const sender = {
    id: senderId,
    name: senderId ? _displayName(fromHeader, senderId) : null,
    kind: is_from_me ? "person" : (structuralKind ?? (isBroadcastOrigin ? "service" : "person")),
  };

  // Recipients ← To: ∪ Cc: (deduplicated, lowercased). Person-ref strings per
  // the contract (recipients[] is string[], not {id,name}).
  const recipSet = new Set();
  for (const e of extractEmails(_header(headers, "to") || "")) recipSet.add(e);
  for (const e of extractEmails(_header(headers, "cc") || "")) recipSet.add(e);
  const recipients = Array.from(recipSet);

  // addressed_to_me ← operator is a first-class addressee (To: ∪ Cc:). THE
  // distinguishing signal — read directly off membership, never inferred.
  const addressed_to_me = recipients.some((r) => isOperatorEmail(r));

  // reply linkage + thread root.
  const reply_to_id = _replyToId(headers);
  const ownMessageId = _header(headers, "message-id");
  const source_msg_id = _sourceMsgId(raw);
  const thread_id = _threadId(headers, ownMessageId, source_msg_id);

  // directed_at_me_signals — raw EVIDENCE only; N5 never SCORES (that is L2/N2).
  //   mention_me     : false — email has no structured-mention primitive.
  //   reply_to_me    : false — the HONEST per-row value. We emit reply_to_id but
  //                    cannot resolve the parent message's sender at L1 (L4 owns
  //                    thread state); we do NOT fake the signal from
  //                    reply_to_id's mere presence.
  //   addressed_to_me: computed from To:/Cc: membership above.
  const directed_at_me_signals = {
    mention_me: false,
    reply_to_me: false,
    addressed_to_me,
  };

  // thread_type — mail rows normalize to "dm" at L1. Apple's Envelope Index has
  // no native dm/group/channel column; audience BREADTH is carried by
  // recipients[], and "directedness" is computed by L2 from addressed_to_me —
  // NOT by promoting a multi-recipient mail to "group". (Deliberate per N5
  // REVIEW R3: prevents double-counting audience and keeps the L1 invariant.)
  const env = {
    platform: PLATFORM,
    thread_id,
    thread_type: "dm",
    sender,
    recipients,
    is_from_me,
    ts: _resolveTsMs(raw),
    content: _content(raw),
    reply_to_id,
    mentions: [], // email has no structured mention primitive.
    directed_at_me_signals,
    capabilities: { ...MAIL_CAPABILITIES },
    source_msg_id,
  };
  return env;
}

// Public alias matching the sibling adapters' `toEnvelope` export name; the N5
// spec names `_toEnvelope` — both point at the one impl.
export const toEnvelope = _toEnvelope;

// Re-exported for tests / the gate (read-only introspection of the keystone).
export { MAIL_CAPABILITIES, PLATFORM, isOperatorEmail };

export default _toEnvelope;
