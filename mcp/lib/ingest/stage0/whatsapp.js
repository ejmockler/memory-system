// Stage-0 hard-drop module for the `whatsapp` source (R39 Phase 3b).
//
// Layer 1 of the R25 salience cascade. Input: a fully-formed source-row
// event from storage/sources/whatsapp.jsonl (shape produced by the WhatsApp
// connector — see kb/connectors-phase3.md § whatsapp_row_shape).
//
// Rules (Phase A inventory + WU-whatsapp findings):
//   0. raw_content.cross_source_duplicate === true
//      AND text normalised length >= 25                       → DROP (whatsapp_cross_source_duplicate)
//      [F-T2-WHATSAPP-F9: cross-source dedup vs iMessage.
//       The connector / pre-embed probe stamps the flag when
//       (normalize_e164(peer_jid), normalize_text, 5min) matches
//       an iMessage ledger row. Quarantined (30d).]
//   1. event.kind === "reaction" AND no remote-link-preview
//      evidence                                                → DROP (reaction)
//   2. Preserve raw_content.group_event_type as provenance; classify with
//      the content-declared rules below.
//   3. raw_content.session_type === 2 (broadcast list)       → DROP (broadcast)
//   4. producer marker OR matching identifier-body shape       → DROP (identifier_body_placeholder)
//   5. legacy raw_content.low_signal_message_type marker       → DROP (low_signal_message_type)
//   6. F-T2-WHATSAPP-F1 — deleted-message boilerplate text.
//      DROP via quarantine when the body matches a known
//      localized "this message was deleted" string.
//   7. raw_content.has_media === true AND no text caption    → DROP (media_no_caption)
//   8. text matches CAPS.SALIENCE_OTP_REGEX                  → REDACT_DROP (otp_pattern)
//   9. text.length < 2                                       → DROP (placeholder_residual)
//  10. otherwise                                             → PASS
//      [F-T2-WHATSAPP-F6: when raw_content.starred === true
//       the structural_score is forced to 0.95 — the strongest
//       in-source operator signal currently available.]
//
// On PASS we emit a structural_score hint per the salience structural-rule
// table; we register CAPS.SALIENCE_STRUCTURAL_RULES.whatsapp from a local
// table inside structuralRules() so the impact on the frozen CAPS dict is
// zero. The salience scorer reads `structural_score` if provided, else
// falls back to its source-prior + default.
//
// SHORT_REPLY_CHAR_THRESHOLD set to 25 — iMessage parity per Phase A.
//
// Quarantine discipline (W2/W3 CRITIC INVARIANT):
//   The new DROP rules added by WU-whatsapp (F1, F2, F9) route through
//   quarantineRow so the 30-day retention window covers them and the
//   F-INFRA-QUARANTINE restore tool can recover false positives. The
//   legacy Phase-3b rules (reaction, broadcast,
//   media_no_caption, otp_pattern, placeholder_residual) keep their
//   original irreversible-DROP semantics — WU-whatsapp does not change
//   their disposition.

import { CAPS } from "../../validation.js";
import { quarantineRow } from "../quarantine.js";
// F-NEW-W4-WHATSAPP-F9-XSRC-DEDUP-CONTRACT — consume-side wiring for the
// whatsapp <-> imessage cross-source dedup contract. Substrate owns the
// lookup against the imessage ledger (canonical peer-phone + normalised-text
// + +/-5min window per CONTRACT_WHATSAPP_IMESSAGE); Stage-0 here owns the
// DROP decision through quarantineRow so the 30d window covers restorability.
import { checkCrossSourceDuplicate } from "../cross-source-dedup.js";
// F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION — canonical band helper.
// whatsapp keeps its rule table local (STRUCTURAL_RULES below) so the
// frozen CAPS dict is unchanged; the central helper accepts an explicit
// `rules` override for exactly this case. The `starred` boost remains an
// in-module override applied BEFORE the central band call (highest-priority
// operator signal short-circuits the cliff).
import { computeStructuralScore } from "../structural-score.js";
import {
  isWhatsAppIdentifierBodyPlaceholder,
} from "../../predicates/whatsapp-content-shape.js";

const ZSESSIONTYPE_BROADCAST = 2;
const SHORT_REPLY_CHAR_THRESHOLD = 25;

// F-T2-WHATSAPP-F9 — minimum normalised-text length for the cross-source
// dedup DROP. Same defang as slack F6: short replies ("ok", "lol", "haha")
// collide too easily across sources for the (peer, text, 5min) tuple to be
// a reliable duplicate signal.
const CROSS_SOURCE_DUP_MIN_TEXT_CHARS = 25;

// F-T2-WHATSAPP-F1 — localized "this message was deleted" boilerplate.
// The regex is anchored at start/end and ignores trailing punctuation plus
// optional surrounding whitespace.
const DELETED_BOILERPLATE_REGEX =
  /^\s*(this message was deleted|you deleted this message|tu eliminaste este mensaje|este mensaje fue eliminado|ce message a été supprimé|vous avez supprimé ce message|diese nachricht wurde gelöscht|du hast diese nachricht gelöscht|esta mensagem foi apagada|você apagou esta mensagem)\.?\s*$/i;

// Local structural-rule table. Kept in this module rather than CAPS so the
// frozen CAPS dict is unchanged (the salience scorer reads via the rule
// table function below).
//
// F-T2-WHATSAPP-F6 adds `starred: 0.95` for operator-flagged rows. The
// PASS path forces this score above substantive_prose so Layer-2 selection
// favours starred rows even when they are short replies.
const STRUCTURAL_RULES = Object.freeze({
  reaction: 0.05,
  broadcast: 0.0,
  media_no_caption: 0.10,
  otp_pattern: 0.0,
  placeholder_residual: 0.0,
  substantive_prose: 0.85,
  short_reply: 0.40,
  // F-T2-WHATSAPP-F6 — operator-flagged in-app star. Highest in-source
  // first-party signal currently available.
  starred: 0.95,
  // Retained for rows whose producer already stamped the legacy marker.
  low_signal_message_type: 0.0,
  identifier_body_placeholder: 0.0,
  // F-T2-WHATSAPP-F1 — localized deleted-message boilerplate. DROP via
  // quarantine; entry retained here for the operator-tooling readback.
  whatsapp_deleted_boilerplate: 0.0,
  // F-T2-WHATSAPP-F9 — cross-source dedup vs iMessage. DROP via
  // quarantine; entry retained for readback parity.
  whatsapp_cross_source_duplicate: 0.0,
});

// _shapeForQuarantine — quarantineRow requires row.source. Stage-0 receives
// event objects that already carry source="whatsapp" from the dispatcher;
// the defensive stamp covers callers that bypass the dispatcher (tests
// invoking stage0() directly with a synthetic event).
function _shapeForQuarantine(event) {
  if (event && typeof event === "object") {
    if (typeof event.source === "string" && event.source.length > 0) return event;
    return { ...event, source: "whatsapp" };
  }
  return { source: "whatsapp", raw_content: {} };
}

// _normaliseText — light normaliser for the cross-source-duplicate length
// gate. Collapses runs of whitespace + strips leading/trailing whitespace
// so the gate isn't defeated by formatting drift between sources.
function _normaliseText(s) {
  if (typeof s !== "string") return "";
  return s.replace(/\s+/g, " ").trim();
}

// A remote link preview is authored content, not a reaction event. Prefer the
// producer's direct media_url signal; accept media_title as backward-compatible
// evidence on an older row shape. Both forms require non-empty authored text
// and no downloaded local asset, so a captioned local attachment cannot use the
// exemption. This content-derived rule deliberately does not assign semantics
// to any numeric message_type.
function _hasRemoteLinkPreviewEvidence(rc, text) {
  const hasRemoteUrl =
    typeof rc.media_url === "string" && rc.media_url.trim().length > 0;
  const hasRemoteTitle =
    typeof rc.media_title === "string" && rc.media_title.trim().length > 0;
  const hasLocalAsset =
    typeof rc.media_local_path === "string"
    && rc.media_local_path.trim().length > 0;
  return text.trim().length > 0
    && !hasLocalAsset
    && (hasRemoteUrl || hasRemoteTitle);
}

export function stage0(event) {
  if (!event || typeof event !== "object") {
    return { decision: "PASS", reason: null };
  }
  const rc = event.raw_content || {};
  const messageType = typeof rc.message_type === "number" ? rc.message_type : 0;
  const sessionType = typeof rc.session_type === "number" ? rc.session_type : null;
  const hasMedia = rc.has_media === true;
  const text = typeof rc.text === "string" ? rc.text : "";
  const starred = rc.starred === true;
  const hasRemoteLinkPreview = _hasRemoteLinkPreviewEvidence(rc, text);
  const identifierBodyPlaceholder =
    rc.identifier_body_placeholder === true
    || isWhatsAppIdentifierBodyPlaceholder(rc);
  const lowSignalMarker = rc.low_signal_message_type === true;

  // 0a. F-NEW-W4-WHATSAPP-F9-XSRC-DEDUP-CONTRACT — canonical cross-source
  //     dedup via the generic Layer-1.5 substrate at
  //     lib/ingest/cross-source-dedup.js (Contract D: whatsapp <-> imessage).
  //     The substrate owns the lookup against the imessage ledger (canonical
  //     peer-phone + normalised-text + +/-5min window); Stage-0 here owns
  //     the DROP decision through quarantineRow so the 30d window covers
  //     restorability. Gated on the 25-char normalised-text threshold
  //     (same defang as slack F6 / iMessage parity) to suppress short-
  //     phrase collisions ("ok", "lol", "haha") that would otherwise
  //     pair across sources via the (peer, text, 5min) tuple. The
  //     substrate's extract_a already returns null for non-1:1 sessions,
  //     so group/broadcast rows never incur the cache lookup.
  if (_normaliseText(text).length >= CROSS_SOURCE_DUP_MIN_TEXT_CHARS) {
    let xsrc;
    try {
      xsrc = checkCrossSourceDuplicate(event, "whatsapp");
    } catch {
      // Substrate is fail-open by contract; this catch is defense-in-
      // depth so any thrown error here never crashes Stage-0.
      xsrc = { is_dup: false };
    }
    if (xsrc && xsrc.is_dup === true) {
      const reason =
        typeof xsrc.reason === "string" && xsrc.reason.length > 0
          ? xsrc.reason
          : "whatsapp_cross_source_duplicate";
      try {
        quarantineRow(_shapeForQuarantine(event), reason, {
          rule_id: "F-NEW-W4-WHATSAPP-F9-XSRC-DEDUP-CONTRACT/substrate",
          source: "whatsapp",
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

  // 0b. F-T2-WHATSAPP-F9 (legacy) — connector-stamped cross_source_duplicate
  //    flag. Retained as defense-in-depth for any upstream pre-embed probe
  //    that stamps raw_content.cross_source_duplicate directly (e.g. a
  //    future probe path independent of the Layer-1.5 substrate). The
  //    canonical wiring lives in 0a above; this branch is no-op in the
  //    healthy production flow because the connector does not stamp this
  //    flag today.
  if (
    rc.cross_source_duplicate === true &&
    _normaliseText(text).length >= CROSS_SOURCE_DUP_MIN_TEXT_CHARS
  ) {
    try {
      quarantineRow(_shapeForQuarantine(event), "whatsapp_cross_source_duplicate", {
        rule_id: "F-T2-WHATSAPP-F9/cross_source_duplicate",
        source: "whatsapp",
      });
    } catch {
      /* hot path must not crash on quarantine failure */
    }
    return { decision: "DROP", reason: "whatsapp_cross_source_duplicate" };
  }

  // 1. Reactions are producer-declared semantic events. A stale producer may
  //    have stamped a remote link preview as kind="reaction", so content-
  //    derived preview evidence takes precedence over that stamp.
  if (event.kind === "reaction" && !hasRemoteLinkPreview) {
    return { decision: "DROP", reason: "reaction" };
  }

  // 2. Preserve group_event_type as provenance. Do not use it to classify;
  //    route on the independently interpretable message, session, media, and
  //    text fields below.

  // 3. Broadcast lists — status-style one-to-many. Out of scope for
  //    personal-memory ingest.
  if (sessionType === ZSESSIONTYPE_BROADCAST) {
    return { decision: "DROP", reason: "broadcast" };
  }

  // 4. A producer marker or the shared fallback predicate identifies an
  //    identifier-body placeholder instead of prose. The
  //    rule reads message/body shape and does not classify group-event values.
  if (identifierBodyPlaceholder) {
    try {
      quarantineRow(_shapeForQuarantine(event), "identifier_body_placeholder", {
        rule_id: "WHATSAPP/identifier_body_placeholder",
        source: "whatsapp",
      });
    } catch {
      /* hot path safety */
    }
    return { decision: "DROP", reason: "identifier_body_placeholder" };
  }

  // 5. Honor the connector's legacy boolean marker on already captured rows.
  //    New classification does not reconstruct its old numeric membership.
  if (lowSignalMarker) {
    try {
      quarantineRow(_shapeForQuarantine(event), "low_signal_message_type", {
        rule_id: "F-T2-WHATSAPP-F2/low_signal_message_type",
        source: "whatsapp",
      });
    } catch {
      /* hot path safety */
    }
    return { decision: "DROP", reason: "low_signal_message_type" };
  }

  // 6. F-T2-WHATSAPP-F1 — localized deleted-message boilerplate text.
  //    Quarantine keeps a false positive recoverable by operator tooling.
  if (text.length > 0 && DELETED_BOILERPLATE_REGEX.test(text)) {
    try {
      quarantineRow(_shapeForQuarantine(event), "whatsapp_deleted_boilerplate", {
        rule_id: "F-T2-WHATSAPP-F1/deleted_boilerplate",
        source: "whatsapp",
      });
    } catch {
      /* hot path safety */
    }
    return { decision: "DROP", reason: "whatsapp_deleted_boilerplate" };
  }

  // 7. Media-only attachments with no caption text. The salience cascade
  //    has nothing to score; drop. Note: a captioned image/video PASSes
  //    because the text carries the signal.
  if (hasMedia && text.trim().length === 0) {
    return { decision: "DROP", reason: "media_no_caption" };
  }

  // 8. OTP / verification-code redaction.
  if (text.length > 0) {
    const otpRe = new RegExp(CAPS.SALIENCE_OTP_REGEX, "i");
    if (otpRe.test(text)) {
      return { decision: "REDACT_DROP", reason: "otp_pattern" };
    }
  }

  // 9. Placeholder residual (single-char or empty body that slipped past
  //    the media check — defence-in-depth).
  if (text.length < 2) {
    return { decision: "DROP", reason: "placeholder_residual" };
  }

  // PASS + structural-score hint.
  // F-T2-WHATSAPP-F6 — ZSTARRED=1 forces the highest in-source score so
  // Layer-2 selection prefers the row even when it would otherwise be a
  // short_reply. Operator's explicit in-app flag is treated as a hard
  // boost.
  // F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION: starred boost stays as
  // a pre-band override (operator's explicit in-app flag short-circuits
  // the cliff); the substantive_prose vs short_reply cliff itself routes
  // through the central helper with the local STRUCTURAL_RULES table.
  let structural_score;
  if (starred) {
    structural_score = STRUCTURAL_RULES.starred;
  } else {
    structural_score = computeStructuralScore(
      { text },
      "whatsapp",
      {
        contentFields: ["text"],
        shortReplyThreshold: SHORT_REPLY_CHAR_THRESHOLD,
        lowerBand: "short_reply",
        rules: STRUCTURAL_RULES,
      }
    );
  }
  return {
    decision: "PASS",
    reason: null,
    structural_score,
  };
}

// Re-export the per-source structural-score table fragment so the salience
// core (or operator tooling) can read the canonical mapping without
// re-parsing CAPS. Sourced from the local STRUCTURAL_RULES table because
// CAPS does not (yet) carry a whatsapp entry — keeping the impact on the
// frozen CAPS dict zero.
export function structuralRules() {
  return { ...STRUCTURAL_RULES };
}
