// adapters/imessage.js — WORKUNIT N4: the iMessage L1 adapter.
//
// A PURE, read-only projection: it maps ONE already-retained raw iMessage ledger
// row (the shape `_buildLedgerRow` emits in mcp/lib/connectors/imessage.js:1059-1196)
// onto N1's frozen, platform-agnostic Envelope. Thesis #1: this never writes,
// mutates, or re-queries a source/fact row, chat.db, or AddressBook — it only
// reshapes a row the frozen connector already produced (derived projection,
// joined at query time).
//
// THE ABSTRACTION INVARIANT: a new platform = ONE new adapter; layers 2..5 never
// learn the word "imessage". iMessage's degradation lives entirely in the declared
// `capabilities{}` block below, as DATA the classifier (N2) reads — never as a
// platform branch downstream. This file is the ONLY place that knows iMessage's
// limits.
//
// Imports NOTHING from mcp/lib/connectors/* (the frozen L1 connector layer) and
// names NO source surface (AddressBook / Contacts / chat.db / sqlite) in its own
// code — the N4 gate proves this mapper is a PURE projection over the row. The
// only cross-module dependencies are N1's validator (for the optional self-check
// helper `toEnvelopeChecked`) and the OPTIONAL context build, which lives in the
// adapter-layer sibling `_imessage-context.js` (re-exported below) so the AddressBook
// read it owns never lands in THIS pure file. The core `toEnvelope` does a pure,
// inline Map lookup of the contact maps `_imessage-context.js` supplies in `opts` —
// it opens nothing.

import { validateEnvelope } from "../envelope.js";
import { classifyStructural } from "../sender-kind.js";

// Re-export the OPTIONAL, GENERIC adapter-contract hook from the adapter-layer
// context sibling. The L5 catch-up surface reads `mod.prepareContext` off the
// adapter MODULE namespace (the registry barrel imports `* as imessage`), so a
// re-export here keeps the registry wiring unchanged while the AddressBook read
// stays out of this pure mapper. See _imessage-context.js for the read-only,
// memoized contact-map build.
export {
  prepareContext,
  __resetPrepareContextMemo,
} from "./_imessage-context.js";

// ---------------------------------------------------------------------------
// Platform truth — declared, NOT computed. This is the keystone for N4.
// ---------------------------------------------------------------------------
//
// iMessage's capability matrix (grounded against the real connector):
//   reply_to_available     = true  — chat.db stores thread_originator_guid, the
//                                    canonical reply target (imessage.js:1067-1069).
//                                    This is the live CONTRAST against WhatsApp's
//                                    false (ZPARENTMESSAGE null) that proves N2's
//                                    capability-degradation gate.
//   structured_mentions    = false — iMessage has no structured mention entities.
//   self_identity_reliable = true  — handle_id is an unmasked phone/email; the
//                                    operator self is the literal "user".
//   addressing_first_class = false — recipients are implicit (no To/Cc surface);
//                                    "addressed to me" is inferred, not explicit.
//
// EXACTLY these four keys (N1 rejects a missing OR a 5th key). Frozen as a literal
// so an accidental computed branch can never silently mutate the contract.
const IMESSAGE_CAPABILITIES = Object.freeze({
  reply_to_available: true,
  structured_mentions: false,
  self_identity_reliable: true,
  addressing_first_class: false,
});

export const PLATFORM = "imessage";

// Raw source-row fields whose values can carry the adapter's semantic payload.
// Consumers discover this declaration through adapters/registry.js; an adapter
// without this capability remains unmeasurable in the shared predicate.
export const CONTENT_FIELD_SPEC = Object.freeze({
  fields: Object.freeze(["text"]),
  metadata: Object.freeze(["attachments"]),
});

// The operator-self person-ref. iMessage stamps is_from_me=1 for the operator's
// own writes and carries no handle for self; the canonical self-ref is "user"
// (imessage.js:1131,1177 parties widening; outbound parties lead with "user").
const SELF_REF = "user";

// Group-chat heuristic — REPLICATED inline from isGroupChat (imessage.js:473-486),
// the documented source of truth. NOT imported: the adapter must be self-contained
// on the row, but the 3-way OR must agree with the connector byte-for-byte.
//   (1) cache_roomnames is a non-empty string                  => group
//   (2) participant_count > 2                                   => group
//   (3) chat_guid matches /;[+-];chat\d+/ (any;+;chatNNNN or
//       any;-;chatNNNN — the [+-] class covers both framings)   => group
//   else                                                        => dm
function deriveThreadType(rawContent) {
  if (rawContent == null || typeof rawContent !== "object") return "dm";

  if (
    typeof rawContent.cache_roomnames === "string" &&
    rawContent.cache_roomnames.length > 0
  ) {
    return "group";
  }

  const pc = Number(rawContent.participant_count);
  if (Number.isFinite(pc) && pc > 2) return "group";

  const chatGuid =
    typeof rawContent.chat_guid === "string" ? rawContent.chat_guid : "";
  if (/;[+-];chat\d+/.test(chatGuid)) return "group";

  return "dm";
}

// ts conversion: row.ts is an ISO-8601 string (macEpochNsToIso, imessage.js:1186).
// N1 demands integer-ms (> 0). Date.parse is lossless for the millisecond-precision
// ISO that macEpochNsToIso emits. Defensive: an unparseable / non-positive ts is a
// hard error — the Envelope must NEVER carry NaN (N1 would reject it, but failing
// loudly at the adapter boundary gives a precise diagnostic instead of a vague
// validation miss downstream).
function isoToEpochMs(isoTs) {
  const ms = Date.parse(isoTs);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new TypeError(
      `imessage adapter: unparseable or non-positive row.ts ${JSON.stringify(
        isoTs,
      )} (need ISO-8601 -> positive integer ms)`,
    );
  }
  return ms;
}

// ---------------------------------------------------------------------------
// Pure handle normalization + contact-map lookup. INLINED (no connector import)
// so this mapper stays a self-contained, source-read-free projection (N4 gate).
// These collapse a handle.id to the SAME key shape the contact maps are built
// under so the lookup is deterministic; they NEVER open a DB.
// ---------------------------------------------------------------------------

// A handle.id is an email iff it carries an '@' and is not a urn: business surface.
function handleIsEmail(h) {
  return typeof h === "string" && h.includes("@") && !h.startsWith("urn:");
}

// Phone key: strip non-digits, keep the last 10. Fewer than 10 digits (SMS
// shortcodes / malformed) -> null (never joins a contact). Mirrors the contact
// map's own normalization so "+15555550123" and "(555) 555-0123" collapse equal.
function handlePhoneKey(s) {
  if (typeof s !== "string") return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

// Email key: lower(trim()). Empty / non-string -> null.
function handleEmailKey(s) {
  if (typeof s !== "string") return null;
  const out = s.trim().toLowerCase();
  return out.length > 0 ? out : null;
}

/**
 * resolveSenderNameFromOpts — PURE Map lookup of an inbound handle's display name
 * from the contact maps the GENERIC `opts` (prepareContext) supplies.
 * Reads ONLY `opts.contactMaps` = { phoneToName, emailToName }. Email handles route
 * to emailToName; everything else normalizes as a phone. Returns a non-empty
 * contact name or null. Never opens a DB; never throws.
 *
 * @param {string|null} handleId
 * @param {object} [opts]
 * @returns {string|null}
 */
function resolveSenderNameFromOpts(handleId, opts) {
  if (typeof handleId !== "string" || handleId.length === 0) return null;
  const maps = opts && typeof opts === "object" ? opts.contactMaps : null;
  if (maps == null || typeof maps !== "object") return null;
  try {
    if (handleIsEmail(handleId)) {
      const key = handleEmailKey(handleId);
      if (key === null) return null;
      const v = maps.emailToName instanceof Map ? maps.emailToName.get(key) : null;
      return typeof v === "string" && v.length > 0 ? v : null;
    }
    const key = handlePhoneKey(handleId);
    if (key === null) return null;
    const v = maps.phoneToName instanceof Map ? maps.phoneToName.get(key) : null;
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * formatHandleFloor — the DISPLAY FLOOR (N11f). When NO contact name resolves for
 * an inbound handle, derive a readable, NON-NULL label from the handle itself so a
 * catch-up row NEVER falls to person:<hash> for an iMessage row that has a handle.
 * A genuine contact name (or a connector-stamped recovered_handle_name) ALWAYS
 * wins; this fills only a null. The floor is a stable function of the handle —
 * never a fabricated identity.
 *
 *   - E.164 / 10-digit phone (+15555550123, "(555) 555-0123"): a readable number.
 *       11-digit NANP (1 + area + line): "+1 555 555 0123".
 *       bare 10-digit:                   "(555) 555-0123".
 *       other lengths with >=10 digits:  "+<digits>" (E.164-ish, grouped tail).
 *   - email handle:                      the email as-is.
 *   - urn:biz / shortcode / other:       the raw handle (a short, stable label).
 *
 * Returns null only for an empty/non-string handle (then sender.name stays null
 * and the downstream person:<hash> fallback applies — the genuinely-handle-less row).
 *
 * @param {string|null} handleId
 * @returns {string|null}
 */
export function formatHandleFloor(handleId) {
  if (typeof handleId !== "string" || handleId.length === 0) return null;

  // Email handle -> show the email itself (already human-readable).
  if (handleIsEmail(handleId)) return handleId;

  // Phone-shaped handle -> a readable number grouped by NANP convention.
  const digits = handleId.replace(/\D/g, "");
  if (digits.length >= 10) {
    if (digits.length === 11 && digits.startsWith("1")) {
      // NANP with country code: +1 AAA PPP NNNN.
      const a = digits.slice(1, 4);
      const b = digits.slice(4, 7);
      const c = digits.slice(7, 11);
      return `+1 ${a} ${b} ${c}`;
    }
    if (digits.length === 10) {
      // Bare NANP: (AAA) PPP-NNNN.
      const a = digits.slice(0, 3);
      const b = digits.slice(3, 6);
      const c = digits.slice(6, 10);
      return `(${a}) ${b}-${c}`;
    }
    // Longer international number: E.164-ish "+<digits>" with the local tail
    // grouped for readability (keeps the country/area prefix intact).
    const head = digits.slice(0, digits.length - 7);
    const mid = digits.slice(digits.length - 7, digits.length - 4);
    const tail = digits.slice(digits.length - 4);
    return `+${head} ${mid} ${tail}`;
  }

  // urn:biz / SMS shortcode (e.g. "55501") / anything else with no 10-digit phone:
  // the raw handle is itself the most honest short, stable label.
  return handleId;
}

/**
 * toEnvelope — map a raw iMessage ledger row onto the frozen Envelope.
 *
 * PURE: no I/O, no mutation of the input, no source re-query. Defensive against
 * absent/null nested fields (real rows null out handle_id, chat_guid,
 * thread_originator_guid, recovered_handle_name, etc.).
 *
 * @param {object} row - a ledger row: { ts (ISO string), source_msg_id, parties[],
 *   raw_content { text, handle_id, chat_guid, cache_roomnames, is_from_me (0|1),
 *   thread_originator_guid, in_reply_to?, recovered_handle_name?, participant_count,
 *   parties_source? } }.
 * @param {object} [opts] - the OPTIONAL, GENERIC adapter context the L5 catch-up
 *   loop threads from `prepareContext()` (catchup.js:557-578). The fields this
 *   adapter reads are `opts.contactMaps` = { phoneToName, emailToName } — the
 *   READ-ONLY contact join the context sibling built — and the OPT-OUT flag
 *   `opts.handleNameFloor` (default ON). When the connector did not pre-stamp
 *   `recovered_handle_name` (the live ledger nulls it on most rows), the adapter
 *   resolves the inbound handle->name from the contact maps; when that misses it
 *   falls to the DISPLAY FLOOR (a formatted number / email / shortcode label) so
 *   sender.name is NEVER null for a handle-bearing inbound row. Absent opts => the
 *   contact-map step is a no-op and the floor still fires (default ON). The mapper
 *   itself NEVER opens a DB — the context sibling owns that read.
 * @returns {import("../envelope.js").Envelope}
 */
export function toEnvelope(row, opts = {}) {
  if (row == null || typeof row !== "object" || Array.isArray(row)) {
    throw new TypeError("imessage adapter: row must be a plain object");
  }
  const rc =
    row.raw_content != null && typeof row.raw_content === "object"
      ? row.raw_content
      : {};

  // is_from_me: connector stamps the integer 0|1 (imessage.js:1064). Coerce to a
  // STRICT boolean — N1 rejects 0/1.
  const isFromMe = rc.is_from_me === 1 || rc.is_from_me === true;

  // sender: outbound => the operator self ("user"); inbound => the handle_id, with
  // a display name resolved in PRECEDENCE order:
  //   1. the already-stamped recovered_handle_name (imessage.js:1093-1107) — when
  //      the connector pre-resolved it at poll time;
  //   2. else the AddressBook contactMaps the GENERIC `opts` (prepareContext) threads
  //      in (a pure Map lookup) — so a row whose connector-stamped name is null (the
  //      live ledger nulls it on most rows) STILL surfaces a REAL contact name at
  //      catch-up time instead of person:<hash>;
  //   3. else the DISPLAY FLOOR (N11f): a readable label DERIVED FROM THE HANDLE
  //      (a formatted phone number / the email / a short shortcode label) so the
  //      catch-up NEVER shows person:<hash> for an iMessage row that HAS a handle.
  //      iMessage carries no push-name, so ~94% of distinct inbound handles are not
  //      in Contacts and are inherently unnameable; the floor shows the NUMBER, the
  //      realistic gap closure (not "resolve more"). A genuine contact name (1/2)
  //      always wins; the floor only fills a null.
  //   4. else null — ONLY when there is no handle at all (genuinely handle-less),
  //      in which case the downstream person:<hash> fallback legitimately applies.
  // The FLOOR is OPT-OUT via opts.handleNameFloor:false (DEFAULT ON) — it is a
  // DISPLAY floor, not a resolution result, so a caller measuring genuine contact
  // resolution reads the unmasked null by passing handleNameFloor:false (mirrors the
  // WhatsApp lidNameFloor seam). The mapper itself MUST NOT open Contacts / chat.db:
  // prepareContext built the maps read-only ONCE; here we only do a pure Map lookup
  // + a pure string format. (Thesis #1: no source mutation, no re-query per row.)
  // sender.kind (N11, A2 / P1): iMessage carries no per-row bot account flag, but
  // the HANDLE itself carries cross-platform STRUCTURAL signals — an Apple
  // Business Chat urn:biz surface, a Google RBM (@rbm.goog) agent, an email whose
  // local-part is a role mailbox (no-reply / support / notifications), or an SMS
  // shortcode (3-6 digit numeric handle). The shared GENERIC classifyStructural
  // (../sender-kind.js) reads these by SHAPE, never by brand, and returns the
  // automated-channel kind "service" or null. Null => default "person" (a real
  // phone / contact / personal email is never dropped — high-recall exclusion).
  let sender;
  if (isFromMe) {
    sender = { id: SELF_REF, name: SELF_REF, kind: "person" };
  } else {
    const handleId =
      typeof rc.handle_id === "string" && rc.handle_id.length > 0
        ? rc.handle_id
        : null;
    const stampedName =
      typeof rc.recovered_handle_name === "string" &&
      rc.recovered_handle_name.length > 0
        ? rc.recovered_handle_name
        : null;
    const floorOn = !(opts && opts.handleNameFloor === false);
    const resolvedName =
      stampedName ?? resolveSenderNameFromOpts(handleId, opts);
    // The iMessage handle is BOTH the id and (when it carries an "@") an email,
    // so we pass it as handle/email/id and let the helper pick the right signal.
    const structuralKind = classifyStructural({
      id: handleId,
      handle: handleId,
      email: handleIsEmail(handleId) ? handleId : null,
    });
    sender = {
      id: handleId,
      name:
        resolvedName ?? (floorOn ? formatHandleFloor(handleId) : null),
      kind: structuralKind ?? "person",
    };
  }

  // thread_id: chat_guid is the canonical conversation key (imessage.js:1062).
  const threadId =
    typeof rc.chat_guid === "string" && rc.chat_guid.length > 0
      ? rc.chat_guid
      : null;

  const threadType = deriveThreadType(rc);

  // reply_to_id: thread_originator_guid is canonical; in_reply_to is its alias
  // (imessage.js:1127-1129). Null => no reply. Because reply_to_available=true we
  // ALWAYS emit the key (string|null) so downstream never confuses "platform can't
  // tell" (key absent) with "this message isn't a reply" (key present, null).
  const replyToId =
    (typeof rc.thread_originator_guid === "string" &&
    rc.thread_originator_guid.length > 0
      ? rc.thread_originator_guid
      : null) ??
    (typeof rc.in_reply_to === "string" && rc.in_reply_to.length > 0
      ? rc.in_reply_to
      : null);

  // recipients: derived from row.parties (already F7-widened by the connector for
  // outbound groups, imessage.js:1131-1181).
  //   inbound  => ["user"]            (the message reached the operator's mailbox)
  //   outbound => parties minus "user" (1:1 => [handle_id]; group => [h1,h2,…];
  //               legacy-empty F7 case parties===["user"] => []  — a documented,
  //               legitimate legacy shape, imessage.js:1169-1174).
  let recipients;
  const parties = Array.isArray(row.parties) ? row.parties : [];
  if (isFromMe) {
    recipients = parties.filter(
      (p) => typeof p === "string" && p.length > 0 && p !== SELF_REF,
    );
  } else {
    recipients = [SELF_REF];
  }

  // directed_at_me_signals — BOOLEAN EVIDENCE the adapter can ground from ONE row;
  // the classifier (N2) weights these by reading capabilities{}.
  //   mention_me      = false — iMessage has no structured mentions to detect.
  //   addressed_to_me = an inbound message landed in the operator's mailbox =>
  //                     the operator is a recipient. Outbound => the operator is
  //                     the AUTHOR, not addressed-to. (recipients includes "user"
  //                     iff inbound, by construction above.)
  //   reply_to_me     = false — whether the reply targets one of MY messages needs
  //                     the L4 thread-state engine (cross-row); UNKNOWN at single-
  //                     row scope. N1 requires a strict boolean here, so we emit
  //                     the conservative false (never fabricate true); N2
  //                     redistributes weight via capabilities. The richer null=
  //                     'cannot tell' lives in capabilities, not this strict block.
  const directedAtMeSignals = {
    mention_me: false,
    reply_to_me: false,
    addressed_to_me: !isFromMe,
  };

  // source_msg_id: the join key back to the raw row (guid or rowid:N, imessage.js:1190).
  const sourceMsgId =
    typeof row.source_msg_id === "string" && row.source_msg_id.length > 0
      ? row.source_msg_id
      : null;

  return {
    platform: PLATFORM,
    thread_id: threadId,
    thread_type: threadType,
    sender,
    recipients,
    is_from_me: isFromMe,
    ts: isoToEpochMs(row.ts),
    content: typeof rc.text === "string" ? rc.text : null,
    reply_to_id: replyToId,
    mentions: [], // iMessage has no structured mentions (capability false).
    directed_at_me_signals: directedAtMeSignals,
    capabilities: { ...IMESSAGE_CAPABILITIES },
    source_msg_id: sourceMsgId,
  };
}

// Convenience self-checking variant — builds the envelope then runs it through
// N1's validator, throwing with the full diagnostic list on any contract miss.
// Useful in tests / strict callers; the core `toEnvelope` stays validator-free so
// it remains a pure mapper.
export function toEnvelopeChecked(row) {
  const env = toEnvelope(row);
  const res = validateEnvelope(env);
  if (!res.ok) {
    throw new Error(
      `imessage adapter produced an invalid envelope: ${JSON.stringify(
        res.errors,
      )}`,
    );
  }
  return env;
}

// N1's adapter-registry convention may dispatch on `_toEnvelope`; alias it.
export const _toEnvelope = toEnvelope;

// prepareContext + __resetPrepareContextMemo are RE-EXPORTED at the top of this
// file from ./_imessage-context.js (the adapter-layer sibling that owns the
// read-only AddressBook build), so the registry barrel still finds them on this
// module's namespace while THIS pure mapper names no source surface.

export default toEnvelope;
