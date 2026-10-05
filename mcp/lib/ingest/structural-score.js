// Central structural_score band computation.
//
// F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION: per-source structural-band
// logic was re-implemented in 9 Stage-0 modules (imessage, mail, telegram,
// whatsapp, githubevents, gitlog, screentime, codex-cli, chat-claude-code).
// Each module computed effectively the same f(content_length, source_prior)
// → 0..1 band, with slightly different shapes. The result: a tweak to the
// short_reply / substantive_prose cliff required editing 9 places, and
// per-source bands could drift silently from one another.
//
// This module exports a single canonical helper, computeStructuralScore,
// that walks the standard band shape used by the Stage-0 cascade:
//
//   1. Pick the longest content field in `contentFields` (falling back to
//      the first declared field if all are empty).
//   2. Compare its char length against SHORT_REPLY_CHAR_THRESHOLD.
//   3. Resolve the rule table at CAPS.SALIENCE_STRUCTURAL_RULES[sourcePrior]
//      (or accept an explicit rules table via options.rules).
//   4. Return rules.substantive_prose when length >= threshold, else
//      rules.short_reply (or rules.subject_only when the source uses that
//      lower-band name).
//   5. Default cliff: 200 chars for mail/dense-prose sources, 25 chars for
//      chat-style sources (override via options.shortReplyThreshold).
//
// Per-source overrides (operator-flag boosts, edit-floor, html-discount,
// pushevent downgrade, system-prompt-replay) remain in the per-source
// modules — they are defense-in-depth applied on top of the central
// computation. The central call is the canonical *band* interface; the
// per-source overrides are the canonical *exception* interface.
//
// Critic invariant: this module does NOT enforce the MIN_PROMOTE_STRUCTURAL_SCORE
// floor. The floor is a salience-layer concern (lib/caps.js) and is gated
// by the env flag MEMORY_STRUCTURAL_FLOOR_ENABLED — applying it inside
// Stage-0 would silently lift drop reasons into PASS. The floor is
// consulted by the salience cascade after Stage-0 emits its hint.

import { CAPS } from "../validation.js";

// Default char thresholds — the cliff value below which a row is treated
// as a "short reply" vs "substantive prose". 25 is the chat-source parity
// shared by imessage/telegram/whatsapp/slack; 200 is the dense-prose
// cliff used by mail. Callers can override per-call via
// options.shortReplyThreshold.
export const DEFAULT_CHAT_CLIFF_CHARS = 25;
export const DEFAULT_PROSE_CLIFF_CHARS = 200;

// computeStructuralScore — central band helper.
//
// Arguments:
//   rawContent   the row's raw_content object. The helper reads only the
//                content-field declared in `contentFields`; non-content
//                metadata (handle ids, timestamps) is ignored.
//   sourcePrior  the source name key into CAPS.SALIENCE_STRUCTURAL_RULES
//                (e.g. "imessage", "mail", "telegram", "github-events").
//                Used only to look up the per-source band table; the
//                computation itself is source-agnostic.
//   options      {
//                  contentFields:        string[] of raw_content keys to
//                                        consider as content. The longest
//                                        non-empty string among them is
//                                        used. Default: ["text"].
//                  shortReplyThreshold:  char cliff for short_reply vs
//                                        substantive_prose. Default:
//                                        DEFAULT_CHAT_CLIFF_CHARS.
//                  rules:                explicit rule table override.
//                                        When provided, sourcePrior lookup
//                                        is skipped — used by whatsapp.js
//                                        which keeps a local table.
//                  lowerBand:            override the "short" band name.
//                                        Default: "short_reply". Pass
//                                        "subject_only" for git-log /
//                                        codex-cli / chat-claude-code which
//                                        use that band name.
//                  fieldLengthCap:       optional cap on per-field length
//                                        considered for the cliff
//                                        comparison. Reserved for future
//                                        very-long-field smell detection;
//                                        unused at v1.
//                }
//
// Returns: a number in [0, 1]. The caller is responsible for any
// downstream overrides (boost / floor / multiplier).
export function computeStructuralScore(rawContent, sourcePrior, options = {}) {
  const {
    contentFields = ["text"],
    shortReplyThreshold = DEFAULT_CHAT_CLIFF_CHARS,
    rules: explicitRules,
    lowerBand = "short_reply",
  } = options;

  const rules = explicitRules
    ? explicitRules
    : (CAPS.SALIENCE_STRUCTURAL_RULES?.[sourcePrior] || {});

  const length = longestContentFieldLength(rawContent, contentFields);

  const upper = rules.substantive_prose;
  const lower = rules[lowerBand];

  if (length >= shortReplyThreshold) {
    return typeof upper === "number" ? upper : 0.85;
  }
  return typeof lower === "number" ? lower : 0.4;
}

// longestContentFieldLength — read the declared content fields from
// rawContent, take the longest string value, return its char length.
// Non-string / null fields contribute 0. Used by computeStructuralScore
// and exported for the per-source modules that want to assert against
// the same length measurement.
export function longestContentFieldLength(rawContent, contentFields) {
  if (!rawContent || typeof rawContent !== "object") return 0;
  if (!Array.isArray(contentFields) || contentFields.length === 0) return 0;
  let best = 0;
  for (const field of contentFields) {
    if (typeof field !== "string") continue;
    const v = rawContent[field];
    if (typeof v !== "string") continue;
    if (v.length > best) best = v.length;
  }
  return best;
}

// resolveBand — look up an explicit rule by name on the per-source table.
// Used by per-source modules that need to consult e.g. rules.starred or
// rules.html_only_discount without re-reading CAPS. Returns undefined
// when the name is absent (caller decides the fallback).
export function resolveBand(sourcePrior, name, explicitRules) {
  const rules = explicitRules
    ? explicitRules
    : (CAPS.SALIENCE_STRUCTURAL_RULES?.[sourcePrior] || {});
  return rules[name];
}
