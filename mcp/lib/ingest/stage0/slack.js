// Stage-0 hard-drop module for the `slack` source (R38 Phase 2c).
//
// Layer 1 of the R25 salience cascade for Slack source-rows. Input: a fully-
// formed source-row event from storage/sources/slack.jsonl (shape produced
// by the Slack connector — see lib/connectors/slack.js buildRow).
//
// Rules (verbatim from R38 Phase A inventory § Slack Stage-0, plus
// F-T2-SLACK-F3/F4/F6/F7/F10 wave-2 extensions):
//   0. raw_content.cross_source_duplicate === true              → DROP
//      (slack_cross_source_duplicate; via quarantine, 30d retention).
//      Set by the cross-source dedup probe (F-T2-SLACK-F6) when the
//      normalised text hash matches a recent imessage/github-events/mail
//      entry within a 30-minute window. The slack row is the duplicate;
//      the earlier source is canonical.
//   1. raw_content.is_bot === true                              → DROP
//      (bot_message; via quarantine, 30d retention).
//   2. raw_content.user === "USLACKBOT"                         → DROP
//      (slackbot_system; F-T2-SLACK-F10. Captures Slackbot reminders,
//      /remind output, and Workflow Builder run notifications). Routes
//      through quarantine (30d) so legitimate self-reminders are
//      restorable per the critic invariant on new DROP paths.
//   3. raw_content.subtype ∈ CHANNEL_LIFECYCLE_SUBTYPES          → DROP
//      (channel_lifecycle; F-T2-SLACK-F3 expands the set to include
//      pinned_item, unpinned_item, reminder_add, reminder_delete,
//      file_comment, huddle_thread, message_replied, message_deleted,
//      tombstone, etc.). Routes through quarantine (30d).
//   4. raw_content.subtype === "thread_broadcast" AND no text   → DROP
//      (thread_broadcast_empty; via quarantine, 30d).
//   5. raw_content.subtype === "file_share" AND no text         → DROP
//      (file_share_no_text; via quarantine, 30d).
//   6. raw_content.subtype === "bot_message"                    → DROP
//      (bot_message; via quarantine, 30d).
//   7. raw_content.subtype === "message_changed"                → see
//      F-T2-SLACK-F4. The connector promotes msg.message.text into
//      raw_content.text and stamps raw_content.previous_text. We
//      compare the two normalised strings (whitespace-trimmed); when
//      they match (or the new text is empty), the edit carries no new
//      content (reaction-only edit, attachment-only reorder) and we
//      DROP via quarantine with reason "edit_no_change". Otherwise
//      PASS — the edit is the operator updating their own message and
//      the corroboration value of the diff justifies retention.
//   8. raw_content.text empty/whitespace AND has_files == false → DROP
//      (empty_message; via quarantine, 30d).
//   9. otherwise                                                → PASS
//
// On PASS we emit a structural_score hint derived from
// CAPS.SALIENCE_STRUCTURAL_RULES.slack. Substantive prose wins when the
// message has body text; short_reply / subject_only fall back for very
// short messages (Slack reactions surface as separate events that the
// connector does not currently emit, so they cannot land here).
//
// CRITIC INVARIANTS (every new DROP path obeys):
//   - Every DROP routes through quarantineRow (30d retention) so the
//     operator can restore a misclassified row through the F-INFRA-
//     QUARANTINE restore tool. The Stage-0 decision still surfaces via
//     the dispatcher's recordDrop telemetry so per-reason counters stay
//     accurate.
//   - Every reason string lives in REASON_ALLOWLIST
//     (mcp/lib/ingest/stage0/telemetry.js). F-T2-SLACK-F10 added
//     "slackbot_system", F-T2-SLACK-F4 added "edit_no_change", F-T2-
//     SLACK-F6 added "slack_cross_source_duplicate" so this module's
//     novel reasons survive the static reconcileReasonAllowlist check.
//
// F-T2-SLACK-F6 cross-source dedup substrate:
//   The actual content-hash lookup against (imessage, github-events, mail)
//   is owned by an upstream probe (memory_lookup or pre-embed pipeline)
//   that the connector or a salience-cascade Layer-1.5 module runs before
//   stage0Dispatch. That probe is the canonical place for the SQL keyed on
//   (operator, content_hash, ts_window). When the probe finds a match it
//   stamps raw_content.cross_source_duplicate=true on the slack row; this
//   Stage-0 module then DROPs the row through quarantine. Until the probe
//   ships (Phase 2c is INACTIVE), the flag is never set and Rule 0 is a
//   no-op — but the wiring is in place so the activation flip is purely a
//   probe-on-or-off decision, not a Stage-0 schema change. The 30-char
//   text-length gate the predicate mandates ("len(normalize(text)) >= 30")
//   is enforced HERE as a defensive guard: even if the upstream probe
//   stamps the flag on a short message, Rule 0 ignores it. That keeps the
//   short-reply false-positive risk ("ok", "thanks") off the activation
//   path.

import { CAPS } from "../../validation.js";
import { quarantineRow } from "../quarantine.js";
import { checkCrossSourceDuplicate } from "../cross-source-dedup.js";

const CHANNEL_LIFECYCLE_SUBTYPES = new Set([
  // Original R38 Phase A set.
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "channel_shared",
  "channel_unshared",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
  // F-T2-SLACK-F3 (Wave 2) — non-conversational subtype rows that the
  // original set missed. message_changed is NOT here — it gets its own
  // dedicated Rule 7 (F-T2-SLACK-F4) so edited content is preserved when
  // the diff is meaningful.
  "pinned_item",
  "unpinned_item",
  "reminder_add",
  "reminder_delete",
  "file_comment",
  "huddle_thread",
  "message_replied",
  "message_deleted",
  "tombstone",
]);

const SUBSTANTIVE_PROSE_CHAR_THRESHOLD = 25;

// F-T2-SLACK-F6: minimum normalised text length required for the cross-
// source duplicate flag to take effect. Mirrors the predicate's
// "len(normalize(text)) >= 30 chars" gate. Short replies like "ok" /
// "thanks" should NOT be deduped across sources even if their hash
// coincides — the chance of a hash collision on common short replies is
// not negligible at corpus scale.
const CROSS_SOURCE_DUP_MIN_TEXT_CHARS = 30;

// Defensive source stamping for quarantineRow. Stage-0 receives event
// objects that already carry source="slack" from the dispatcher; this
// shim ensures direct callers (unit tests that bypass the dispatcher)
// still produce a well-formed quarantine entry.
function _shapeForQuarantine(event) {
  if (event && typeof event === "object") {
    if (typeof event.source === "string" && event.source.length > 0) return event;
    return { ...event, source: "slack" };
  }
  return { source: "slack", raw_content: {} };
}

function isEmpty(v) {
  if (v == null) return true;
  if (typeof v !== "string") return false;
  return v.trim().length === 0;
}

// F-T2-SLACK-F4: normalise text for edit-diff comparison. Whitespace-trim
// only — we do NOT collapse internal whitespace because that would mask
// edits that change paragraph structure (a common operator pattern when
// reformatting a long message). Emoji are preserved verbatim; a Slack
// reaction-only edit does not alter msg.message.text so they cancel
// naturally without explicit emoji-stripping logic.
function _normaliseEditText(v) {
  if (typeof v !== "string") return "";
  return v.trim();
}

export function stage0(event) {
  if (!event || typeof event !== "object") {
    return { decision: "PASS", reason: null };
  }
  const rc = event.raw_content || {};
  const text = typeof rc.text === "string" ? rc.text : "";
  const subtype = typeof rc.subtype === "string" ? rc.subtype : null;
  const isBot = rc.is_bot === true;
  const hasFiles = rc.has_files === true;
  const user = typeof rc.user === "string" ? rc.user : "";

  // 0a. F-NEW-W3-SLACK-F6-XSRC-PROBE-IMPLEMENT — cross-source dedup via
  //     the generic Layer-1.5 substrate at lib/ingest/cross-source-dedup.js.
  //     This is the canonical path: the substrate owns the lookup against
  //     (imessage, github-events, mail) ledgers; Stage-0 here owns the
  //     DROP decision. Gated on the same >=30-char threshold as Rule 0
  //     to defang hash collisions on short replies. The substrate today
  //     ships contracts for screentime/imessage, chat-cc/codex, and
  //     github-events/git-log; a slack contract added to
  //     CROSS_SOURCE_CONTRACTS will activate this path with no Stage-0
  //     schema change.
  if (_normaliseEditText(text).length >= CROSS_SOURCE_DUP_MIN_TEXT_CHARS) {
    let xsrc;
    try {
      xsrc = checkCrossSourceDuplicate(event, "slack");
    } catch {
      // Substrate is fail-open by contract; this catch is defense-in-
      // depth so any thrown error here never crashes Stage-0.
      xsrc = { is_dup: false };
    }
    if (xsrc && xsrc.is_dup === true) {
      const reason =
        typeof xsrc.reason === "string" && xsrc.reason.length > 0
          ? xsrc.reason
          : "slack_cross_source_duplicate";
      try {
        quarantineRow(_shapeForQuarantine(event), reason, {
          rule_id: "F-NEW-W3-SLACK-F6-XSRC-PROBE-IMPLEMENT/substrate",
          source: "slack",
          paired_source: xsrc.paired_source,
          paired_id: xsrc.paired_id,
          contract: xsrc.contract,
        });
      } catch {
        /* hot path safety — never crash Stage-0 on quarantine write */
      }
      return { decision: "DROP", reason };
    }
  }

  // 0b. F-T2-SLACK-F6 — legacy connector-stamped cross-source duplicate
  //    flag. Retained as defense-in-depth for any upstream probe that
  //    stamps raw_content.cross_source_duplicate directly (e.g. a future
  //    pre-embed pipeline) instead of relying on the Layer-1.5 substrate.
  //    Drops through quarantine (30d) so the operator can restore if the
  //    canonical-source promotion was wrong. Gated on the 30-char
  //    threshold per the predicate to defang hash collisions on short
  //    replies.
  if (
    rc.cross_source_duplicate === true &&
    _normaliseEditText(text).length >= CROSS_SOURCE_DUP_MIN_TEXT_CHARS
  ) {
    try {
      quarantineRow(_shapeForQuarantine(event), "slack_cross_source_duplicate", {
        rule_id: "F-T2-SLACK-F6/cross_source_duplicate",
        source: "slack",
      });
    } catch {
      // Quarantine failures must NOT crash the Stage-0 hot path.
    }
    return { decision: "DROP", reason: "slack_cross_source_duplicate" };
  }

  // 1 + 6. Bot-author rows (legacy bot_id OR the bot_message subtype).
  if (isBot || subtype === "bot_message") {
    try {
      quarantineRow(_shapeForQuarantine(event), "bot_message", {
        rule_id: "slack/bot_message",
        source: "slack",
      });
    } catch {
      /* hot path safety */
    }
    return { decision: "DROP", reason: "bot_message" };
  }

  // 2. F-T2-SLACK-F10 — Slackbot-authored system messages (reminders,
  //    /remind output, Workflow Builder runs). The user_id "USLACKBOT" is
  //    the canonical Slackbot identity stamped on every Workspace-internal
  //    Slackbot delivery. We DROP via quarantine because legitimate
  //    /remind self-reminders may carry operator-authored content; the
  //    operator can restore through the F-INFRA-QUARANTINE tool. The
  //    Phase-1 default is strict drop per the node's risk note.
  if (user === "USLACKBOT") {
    try {
      quarantineRow(_shapeForQuarantine(event), "slackbot_system", {
        rule_id: "F-T2-SLACK-F10/slackbot_system",
        source: "slack",
      });
    } catch {
      /* hot path safety */
    }
    return { decision: "DROP", reason: "slackbot_system" };
  }

  // 3. F-T2-SLACK-F3 — expanded channel lifecycle subtypes. No signal
  //    value for memory; quarantined so pinned_item events (which the
  //    review_question flags as potentially forensic) are recoverable.
  if (subtype && CHANNEL_LIFECYCLE_SUBTYPES.has(subtype)) {
    try {
      quarantineRow(_shapeForQuarantine(event), "channel_lifecycle", {
        rule_id: "F-T2-SLACK-F3/channel_lifecycle",
        source: "slack",
      });
    } catch {
      /* hot path safety */
    }
    return { decision: "DROP", reason: "channel_lifecycle" };
  }

  // 4. Empty thread_broadcast notifications.
  if (subtype === "thread_broadcast" && isEmpty(text)) {
    try {
      quarantineRow(_shapeForQuarantine(event), "thread_broadcast_empty", {
        rule_id: "slack/thread_broadcast_empty",
        source: "slack",
      });
    } catch {
      /* hot path safety */
    }
    return { decision: "DROP", reason: "thread_broadcast_empty" };
  }

  // 5. File-share notifications with no text body.
  if (subtype === "file_share" && isEmpty(text)) {
    try {
      quarantineRow(_shapeForQuarantine(event), "file_share_no_text", {
        rule_id: "slack/file_share_no_text",
        source: "slack",
      });
    } catch {
      /* hot path safety */
    }
    return { decision: "DROP", reason: "file_share_no_text" };
  }

  // 7. F-T2-SLACK-F4 — message_changed without a meaningful diff.
  //    The Slack connector promotes msg.message.text into raw_content.text
  //    (so the empty_message rule below doesn't fire first) and stamps
  //    msg.previous_message.text into raw_content.previous_text. When the
  //    new text equals the previous text (whitespace-trimmed) OR the new
  //    text is empty, the edit is reaction-only / attachment-reorder and
  //    carries no new corroborative value. Drop via quarantine.
  //
  //    Risk notes (from review_questions):
  //      Q1 "Is the text-diff comparison normalised (whitespace, emoji)?"
  //        — Yes for leading/trailing whitespace via _normaliseEditText.
  //          NOT for internal whitespace (operator paragraph reflow is a
  //          meaningful edit). NOT for emoji (an edit that swaps an emoji
  //          for words IS a meaningful diff).
  //      Q2 "Are message_changed events that ONLY add attachments handled?"
  //        — They DROP here too. raw_content.text is the new message body;
  //          if the body did not change and only the attachment list did,
  //          the operator's intent landed in the file-share row, not in
  //          the message_changed event. We don't have a recall signal for
  //          attachment-only edits and would over-retain noise. The
  //          attachment metadata still lives in the original message row
  //          (or its file_share row), so the corroboration value is
  //          preserved upstream.
  if (subtype === "message_changed") {
    const newText = _normaliseEditText(text);
    const prevText = _normaliseEditText(
      typeof rc.previous_text === "string" ? rc.previous_text : ""
    );
    if (newText === "" || newText === prevText) {
      try {
        quarantineRow(_shapeForQuarantine(event), "edit_no_change", {
          rule_id: "F-T2-SLACK-F4/edit_no_change",
          source: "slack",
        });
      } catch {
        /* hot path safety */
      }
      return { decision: "DROP", reason: "edit_no_change" };
    }
    // Real edit with a diff — PASS, fall through to structural-score path.
  }

  // 8. Empty message with no files.
  if (isEmpty(text) && !hasFiles) {
    try {
      quarantineRow(_shapeForQuarantine(event), "empty_message", {
        rule_id: "slack/empty_message",
        source: "slack",
      });
    } catch {
      /* hot path safety */
    }
    return { decision: "DROP", reason: "empty_message" };
  }

  // PASS + structural-score hint.
  const rules = CAPS.SALIENCE_STRUCTURAL_RULES?.slack || {};
  const structural_score = text.length >= SUBSTANTIVE_PROSE_CHAR_THRESHOLD
    ? (rules.substantive_prose ?? 0.85)
    : (rules.short_reply ?? 0.45);
  return {
    decision: "PASS",
    reason: null,
    structural_score,
  };
}

export function structuralRules() {
  return { ...(CAPS.SALIENCE_STRUCTURAL_RULES?.slack || {}) };
}
