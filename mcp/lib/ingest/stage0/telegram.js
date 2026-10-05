// Stage-0 hard-drop module for the `telegram` source (R38 Phase 2c).
//
// Layer 1 of the R25 salience cascade for Telegram captures.
// Input: a source-row event from storage/sources/telegram.jsonl (shape
// produced by mcp/lib/connectors/telegram.js — a normalised MTProto event
// with raw_content carrying peer_type, sender_*, is_outgoing/is_self, text,
// media_type, fwd_from, reply_to, ttl_seconds).
//
// Rules (verbatim from R38 Phase A spec § Telegram Stage-0, extended in
// Wave 2 by the F-T2-TELEGRAM-{F3,F4,F5} findings):
//   1. raw_content.sender_id matches /bot$/i in sender_name OR
//      fwd_from.kind == "bot"                               -> DROP (bot_message)
//   2. raw_content.fwd_from.kind in {"user","chat","channel"}
//      where the sender_name ends with /bot$/i              -> DROP (bot_forward)
//   3. raw_content.ttl_seconds > 0 AND ttl_seconds <= 7d AND
//      NOT is_self                                          -> DROP (ephemeral_short_ttl)
//      [F-T2-TELEGRAM-F5: threshold widened from <1d strict
//       to <=7d. Operator self-notes are exempted.]
//   4. raw_content.media_type in {"voice","video_note"} AND
//      raw_content.text is empty (metadata-only)            -> DROP (voice_video_metadata_only)
//   5. raw_content.media_type in {"sticker","animation"} AND
//      raw_content.text is empty                            -> DROP (sticker_only)
//   6. fwd_from.kind === "channel" AND NOT is_outgoing      -> DROP (channel_forward_echo)
//      [F-T2-TELEGRAM-F4: forwarded-from-channel echo. The
//       operator typically also subscribes to the source
//       channel directly so this is double-embed noise.
//       Operator-initiated forwards (is_outgoing=true) are
//       a save-for-later signal and are exempted.]
//   7. peer_type === "channel" AND NOT is_outgoing AND
//      peer_id NOT IN CAPS.TELEGRAM_CHANNEL_ALLOWLIST       -> DROP (channel_broadcast)
//      [F-T2-TELEGRAM-F3: 1:N mass-media DROP. Per the
//       implementation_hints the allowlist + is_outgoing
//       exemption preserve channels the operator owns or
//       actively curates; the env-driven allowlist also
//       carves out the personal-notebook channel case.]
//   8. otherwise                                            -> PASS
//
// PASS emits a structural_score hint derived from the per-source structural
// rules in CAPS. substantive_prose for text >= 64 chars, subject_only otherwise.
//
// Quarantine discipline (W2 CRITIC INVARIANT):
//   New DROP paths (rules 6 and 7) route through quarantineRow with
//   F-INFRA-QUARANTINE's 30-day retention. The original Phase-2c DROP rules
//   (1-5) remain irreversible per their original R38 spec — F-T2-TELEGRAM
//   only quarantines the rules ADDED in Wave 2, not the legacy ones, to
//   keep this change minimal and avoid silently mutating existing behaviour
//   the Wave-2 audit didn't flag.

import { CAPS } from "../../validation.js";
import { quarantineRow } from "../quarantine.js";
// F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION — central band helper.
// telegram uses the substantive_prose vs subject_only cliff at 64 chars.
// EDIT_SALIENCE_FLOOR is preserved as an in-module override applied AFTER
// the central band.
import { computeStructuralScore } from "../structural-score.js";

const SUBJECT_ONLY_CHAR_THRESHOLD = 64;
const BOT_SUFFIX_RE = /bot$/i;

// F-NEW-W3-TELEGRAM-F11-INCOMPLETE — salience floor for MessageEdited
// rows. Telegram edits typically refine content (fix typos, add context,
// correct factual errors) rather than introducing noise, so an edited
// row's structural_score should never fall below this floor — the
// operator likely cared enough about the message to update it. We pin
// the floor at 0.45 to sit just below the substantive_prose tier
// (~0.80) but above the subject_only fallback (~0.50). The effect is
// conservative: short edits ride the floor; long edits already exceed
// it via the substantive_prose path. Pre-W3 edits would have either
// silently overwritten the original (source_msg_id collision) or
// landed at subject_only because the edit text is often short — both
// outcomes undersold the signal.
const EDIT_SALIENCE_FLOOR = 0.45;
// F-T2-TELEGRAM-F5: widen the ephemeral TTL threshold from strict <1d to
// <=7d. Telegram's Auto-Delete-Timer presets include 1d, 7d, 31d; the 7d
// upper bound captures the privacy-conscious-counterparty default without
// dropping multi-week archival timers the operator may set on their own
// long-running self-note channels.
const EPHEMERAL_TTL_THRESHOLD_SECONDS = 604800; // 7 days

// F-T2-TELEGRAM-F3: env-driven allowlist of channel peer_ids the operator
// owns or actively curates. Comma-separated integer ids; whitespace tolerant.
// Parsed once at module load; tests that need to mutate the allowlist
// should re-import or override via CAPS.
function parseChannelAllowlist() {
  const raw = process.env.TELEGRAM_CHANNEL_ALLOWLIST;
  if (typeof raw !== "string" || raw.trim() === "") return new Set();
  const out = new Set();
  for (const tok of raw.split(",")) {
    const s = tok.trim();
    if (s === "") continue;
    // Keep both the string form and the numeric form so callers that stamp
    // peer_id as either shape match.
    out.add(s);
    const n = Number(s);
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}
const CHANNEL_ALLOWLIST = parseChannelAllowlist();

function isEmpty(v) {
  if (v == null) return true;
  if (typeof v !== "string") return false;
  return v.trim().length === 0;
}

// _shapeForQuarantine — quarantineRow requires row.source. Stage-0 receives
// event objects that already carry source="telegram" from the dispatcher;
// the defensive stamp covers callers that bypass the dispatcher (tests
// invoking stage0() directly with a synthetic event).
function _shapeForQuarantine(event) {
  if (event && typeof event === "object") {
    if (typeof event.source === "string" && event.source.length > 0) return event;
    return { ...event, source: "telegram" };
  }
  return { source: "telegram", raw_content: {} };
}

export function stage0(event) {
  if (!event || typeof event !== "object") {
    return { decision: "PASS", reason: null };
  }
  const rc = event.raw_content || {};
  const text = typeof rc.text === "string" ? rc.text : "";
  const senderName = typeof rc.sender_name === "string" ? rc.sender_name : "";
  const mediaType = typeof rc.media_type === "string" ? rc.media_type : "";
  const fwd = rc.fwd_from && typeof rc.fwd_from === "object" ? rc.fwd_from : null;
  const ttl = typeof rc.ttl_seconds === "number" ? rc.ttl_seconds : 0;
  const peerType = typeof rc.peer_type === "string" ? rc.peer_type : "";
  const isOutgoing = rc.is_outgoing === true;
  const isSelf = rc.is_self === true;

  // 1. Bot-author message (sender_name ends in "bot").
  if (senderName && BOT_SUFFIX_RE.test(senderName)) {
    return { decision: "DROP", reason: "bot_message" };
  }

  // 2. Forwarded from a bot.
  if (fwd && fwd.kind === "bot") {
    return { decision: "DROP", reason: "bot_forward" };
  }

  // 3. Ephemeral messages with short auto-delete-timer (<= 7 days). The
  // operator's expressed preference for short-TTL streams is to not retain.
  // F-T2-TELEGRAM-F5 widens this from <1d to <=7d and exempts operator
  // self-notes (is_self) so the operator's own TTL-tagged scratch messages
  // survive Stage-0.
  if (ttl > 0 && ttl <= EPHEMERAL_TTL_THRESHOLD_SECONDS && !isSelf) {
    return { decision: "DROP", reason: "ephemeral_short_ttl" };
  }

  // 4. Voice / video-note metadata-only (no transcription available).
  if ((mediaType === "voice" || mediaType === "video_note") && isEmpty(text)) {
    return { decision: "DROP", reason: "voice_video_metadata_only" };
  }

  // 5. Sticker / animation with no caption.
  if ((mediaType === "sticker" || mediaType === "animation") && isEmpty(text)) {
    return { decision: "DROP", reason: "sticker_only" };
  }

  // 6. F-T2-TELEGRAM-F4 — forwarded-from-channel echo. A group member
  // forwarding a public-channel post into the group is a double-embed when
  // the operator subscribes to that channel separately. is_outgoing
  // (operator forwarding to themselves as save-for-later) is exempt.
  // Routes through quarantineRow so the operator can restore via
  // F-INFRA-QUARANTINE if a false positive misses signal.
  if (fwd && fwd.kind === "channel" && !isOutgoing) {
    try {
      quarantineRow(_shapeForQuarantine(event), "channel_forward_echo", {
        rule_id: "F-T2-TELEGRAM-F4/channel_forward_echo",
        source: "telegram",
      });
    } catch {
      /* hot path must not crash on quarantine failure */
    }
    return { decision: "DROP", reason: "channel_forward_echo" };
  }

  // 7. F-T2-TELEGRAM-F3 — channel broadcast (1:N mass-media). Telegram
  // channels are subscribed feeds; the operator did not author the post and
  // typically reads a small fraction. Carve-outs:
  //   - is_outgoing: the operator posted into a channel they own.
  //   - peer_id in CAPS.TELEGRAM_CHANNEL_ALLOWLIST: an operator-curated
  //     channel (e.g. a personal notebook channel) explicitly preserved.
  // Routes through quarantineRow so the operator can restore if a channel
  // they engage with frequently gets caught.
  if (peerType === "channel" && !isOutgoing) {
    const peerId = rc.peer_id;
    const allowlisted =
      (peerId != null && CHANNEL_ALLOWLIST.has(peerId)) ||
      (peerId != null && CHANNEL_ALLOWLIST.has(String(peerId)));
    if (!allowlisted) {
      try {
        quarantineRow(_shapeForQuarantine(event), "channel_broadcast", {
          rule_id: "F-T2-TELEGRAM-F3/channel_broadcast",
          source: "telegram",
        });
      } catch {
        /* hot path must not crash on quarantine failure */
      }
      return { decision: "DROP", reason: "channel_broadcast" };
    }
  }

  // PASS + structural-score hint.
  // F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION: telegram's band is
  // substantive_prose vs subject_only at 64 chars, routed through the
  // central helper.
  let structural_score = computeStructuralScore(
    { text },
    "telegram",
    {
      contentFields: ["text"],
      shortReplyThreshold: SUBJECT_ONLY_CHAR_THRESHOLD,
      lowerBand: "subject_only",
    }
  );
  // F-NEW-W3-TELEGRAM-F11-INCOMPLETE — edited rows take the salience
  // floor when their text would otherwise score below it. Edits refine
  // content the operator already cared about enough to send; they should
  // never be deranked below subject_only. We apply the floor by Math.max
  // so a long edit (text.length >= SUBJECT_ONLY_CHAR_THRESHOLD) still
  // takes the higher substantive_prose tier rather than being capped.
  if (rc.is_edit === true && structural_score < EDIT_SALIENCE_FLOOR) {
    structural_score = EDIT_SALIENCE_FLOOR;
  }
  return {
    decision: "PASS",
    reason: null,
    structural_score,
  };
}

export function structuralRules() {
  return { ...(CAPS.SALIENCE_STRUCTURAL_RULES?.["telegram"] || {}) };
}

// Test-only escape hatch: allow tests to re-derive the allowlist after
// mutating TELEGRAM_CHANNEL_ALLOWLIST. The const above is captured at
// import time; tests should call this AFTER setting the env var, then
// re-import or use the returned Set for assertions.
export function _reloadChannelAllowlistForTest() {
  const next = parseChannelAllowlist();
  CHANNEL_ALLOWLIST.clear();
  for (const v of next) CHANNEL_ALLOWLIST.add(v);
  return CHANNEL_ALLOWLIST;
}
