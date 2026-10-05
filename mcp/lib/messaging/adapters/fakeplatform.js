// adapters/fakeplatform.js — WORKUNIT N10, the SYNTHETIC 5th adapter.
//
// This adapter is the LOAD-BEARING half of the N10 closure proof. It is a
// minimal, contract-faithful L1 mapper for a wholly MADE-UP platform
// ("fakeplatform") that never existed when N1-N9 were authored. Its sole reason
// to exist is to demonstrate the abstraction invariant mechanically:
//
//   Adding a brand-new platform costs EXACTLY ONE new adapter file (this one)
//   and ZERO edits to any layer above L1 (classifier.js / identity.js /
//   attention.js / catchup.js). The N10 eval records sha256 of those four L2-L5
//   sources BEFORE and AFTER routing this platform's rows through the full
//   classifier -> identity -> attention -> catchup chain, and asserts the diff
//   is EMPTY.
//
// CONTRACT FAITHFULNESS (the gate that makes the proof real — N10 R5):
//   _toEnvelope(rawRow[, opts]) -> Envelope. Same uniform signature as N3-N6.
//   It emits envelopes that pass the N1 validateEnvelope() unmodified, including
//   a POPULATED capabilities{} block — it does NOT emit a privileged shape that
//   skips validation. PURE (same row -> same envelope), defensive (a malformed
//   row degrades to a deliberately-invalid envelope the N1 validator rejects,
//   never a throw on the caller's path), ESM, Node stdlib only, no DB/network/fs.
//
// THE DISTINCT DEGRADATION PROFILE (why the classifier still degrades by DATA):
//   fakeplatform declares a capability profile UNLIKE any landed platform —
//     reply_to_available     = true   (it stores a reply target)
//     structured_mentions    = true   (mentions are a structured primitive)
//     self_identity_reliable = true   (the operator's own id is unmasked)
//     addressing_first_class = false  (no To/Cc envelope; addressing is implicit)
//   The classifier (N2) reads those booleans and weights the channels
//   accordingly — with ZERO knowledge that "fakeplatform" exists. That is the
//   whole point: a new platform's behaviour arrives as data in capabilities{},
//   never as an `if (platform === "fakeplatform")` branch anywhere above L1.
//
// NOT SHIPPED TO THE LIVE REGISTRY: this adapter is eval scaffolding. It is
// deliberately ABSENT from adapters/registry.js (the live barrel), so the live
// catch-up surface never serves fakeplatform rows. The N10 eval wires it into a
// FIXTURE registry only (the same generic buildAdapterRegistry path N9 uses),
// proving the registry loop is platform-agnostic without polluting production.

// The platform slug this adapter stamps. Single source of truth. A made-up id
// that collides with no real platform.
export const PLATFORM = "fakeplatform";

// The frozen thread_type enum the N1 contract recognizes. We classify a row's
// thread shape from a structural hint the row carries, defaulting to dm (the
// least-surprising one-to-one shape) — exactly the N3-N6 discipline.
const THREAD_TYPES = new Set(["dm", "group", "channel"]);

/** Non-empty string or null. */
function strOrNull(v) {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** True only for a strict boolean true (tolerant readers stay defensive). */
function isStrictTrue(v) {
  return v === true;
}

/**
 * toEpochMs — convert the row's `ts` to INTEGER milliseconds since epoch (the N1
 * contract: ts is integer-ms, NOT a string). Accepts an already-integer ms
 * (idempotent) OR an ISO-8601 string. Returns null on an unparseable value so
 * the validator catches the boundary failure rather than letting a string slip
 * downstream (where it would sort lexically and break staleness).
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

/**
 * classifyThreadType — map a row's `thread_type` hint to the FROZEN enum. An
 * unrecognized/absent hint defaults to dm. Keyed on the row's OWN structural
 * field — never on the platform name.
 *
 * @param {string|null} hint
 * @returns {"dm"|"group"|"channel"}
 */
export function classifyThreadType(hint) {
  if (typeof hint === "string" && THREAD_TYPES.has(hint)) return hint;
  return "dm";
}

/**
 * _toEnvelope — map ONE raw fakeplatform row to an N1 Envelope.
 *
 * Input row shape (a hand-authored fakeplatform.jsonl line): {
 *   id, ts (ISO-8601 OR integer-ms), thread_id, thread_type ("dm"|"group"|"channel"),
 *   from: { id, name }, to: [person-ref...], is_from_me (bool),
 *   text, source_msg_id,
 *   // optional structured directed-at-me evidence the platform CAN observe:
 *   reply_to_me (bool), mention_me (bool), addressed_to_me (bool),
 *   mentions: [{ id, name }...]
 * }
 *
 * @param {object} row
 * @param {object} [opts] — reserved for read-only name sidecars (unused here).
 * @returns {object} an Envelope (always returned; correctness judged by validateEnvelope).
 */
export function _toEnvelope(row, _opts = {}) {
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
      replyToId: undefined,
      mentions: [],
      signals: { mention_me: false, reply_to_me: false, addressed_to_me: false },
    });
  }

  const from = row.from && typeof row.from === "object" ? row.from : {};
  const outbound = isStrictTrue(row.is_from_me);

  // recipients: an array of person-ref strings (the platform carries an explicit
  // recipient list). Defensive: keep only non-empty strings.
  const recipients = Array.isArray(row.to)
    ? row.to.filter((r) => typeof r === "string" && r.length > 0)
    : [];

  // mentions: structured {id, name} entries (structured_mentions=true). Defensive
  // filter so a malformed mention never reaches the envelope as a non-conforming
  // shape (the validator would reject it; we drop it at the boundary instead).
  const mentions = Array.isArray(row.mentions)
    ? row.mentions
        .filter((m) => m && typeof m === "object" && typeof m.id === "string" && m.id.length > 0)
        .map((m) => ({ id: m.id, name: typeof m.name === "string" ? m.name : null }))
    : [];

  // reply_to_id: present only when the row carries a reply target (the platform
  // CAN store one — reply_to_available=true). Omitted entirely otherwise (the
  // honest encoding the N1 contract permits).
  const replyToId = strOrNull(row.reply_to_id);

  return buildEnvelope({
    threadId: strOrNull(row.thread_id),
    threadType: classifyThreadType(row.thread_type),
    senderId: strOrNull(from.id),
    senderName: strOrNull(from.name),
    recipients,
    isFromMe: outbound,
    ts: toEpochMs(row.ts),
    content: typeof row.text === "string" ? row.text : null,
    sourceMsgId: strOrNull(row.source_msg_id),
    replyToId: replyToId === null ? undefined : replyToId,
    mentions,
    signals: {
      mention_me: isStrictTrue(row.mention_me),
      reply_to_me: isStrictTrue(row.reply_to_me),
      addressed_to_me: isStrictTrue(row.addressed_to_me),
    },
  });
}

/**
 * buildEnvelope — assemble the FROZEN N1 Envelope from resolved parts. Every
 * fakeplatform envelope carries the SAME capability profile (the made-up
 * platform's declared limits), so the classifier degrades by reading these
 * booleans with no knowledge the platform exists.
 *
 * reply_to_id is OMITTED (not null) when absent — the contract makes it optional
 * and omission is the honest encoding for "no reply target on this row".
 */
function buildEnvelope({
  threadId,
  threadType,
  senderId,
  senderName,
  recipients,
  isFromMe: fromMe,
  ts,
  content,
  sourceMsgId,
  replyToId,
  mentions,
  signals,
}) {
  const env = {
    platform: PLATFORM,
    // thread_id must be a non-empty string; a null hint yields "" which the
    // validator correctly rejects (the deliberately-invalid fail-closed shape).
    thread_id: typeof threadId === "string" && threadId.length > 0 ? threadId : "",
    thread_type: threadType,
    sender: {
      id: typeof senderId === "string" && senderId.length > 0 ? senderId : "",
      name: typeof senderName === "string" && senderName.length > 0 ? senderName : null,
    },
    recipients: Array.isArray(recipients) ? recipients : [],
    is_from_me: fromMe === true,
    // ts: integer ms or 0 (0 is rejected by the validator -> surfaced).
    ts: typeof ts === "number" && Number.isInteger(ts) && ts > 0 ? ts : 0,
    content: typeof content === "string" ? content : null,
    mentions: Array.isArray(mentions) ? mentions : [],
    directed_at_me_signals: {
      mention_me: signals && signals.mention_me === true,
      reply_to_me: signals && signals.reply_to_me === true,
      addressed_to_me: signals && signals.addressed_to_me === true,
    },
    capabilities: {
      // The DISTINCT degradation profile — unlike any landed platform. The
      // classifier weights channels off THESE booleans, agnostic to the slug.
      reply_to_available: true,
      structured_mentions: true,
      self_identity_reliable: true,
      addressing_first_class: false,
    },
    source_msg_id: typeof sourceMsgId === "string" && sourceMsgId.length > 0 ? sourceMsgId : "",
  };
  // Attach reply_to_id ONLY when present (optional field; omission is honest).
  if (typeof replyToId === "string" && replyToId.length > 0) {
    env.reply_to_id = replyToId;
  }
  return env;
}

export default { _toEnvelope, PLATFORM, classifyThreadType, toEpochMs };
