// Stage-0 hard-drop module for the `imessage` source.
//
// Layer 1 of the R25 salience cascade (kb/salience-design.md § Layer 1).
// Input: a fully-formed source-row event (the JSON line from
// storage/sources/imessage.jsonl). Output: { decision, reason,
// structural_score? } where decision ∈ {"DROP","REDACT_DROP","PASS"}.
//
// Critic-modified rules (Wave 1, F-T1-IMESSAGE-F1 + F-T1-IMESSAGE-F2):
//   1. raw_content.associated_message_type ∈ [2000, 2004]  → DROP (tapback)
//      (the true binary icons: Love/Like/Dislike/Laugh/Emphasize).
//      Per R22 decoder: 2005, 2006, 2007 carry quoted prose and MUST NOT
//      be dropped here — they fall through to the OTP / A2P / PASS path
//      so the salience layer can use the quoted text. The "remove" range
//      [3000, 3007] is also NOT dropped here because the audit predicate
//      was overbroad; the salience layer can re-score them.
//   2. raw_content.handle_id starts with "urn:biz:" OR "BIZ:"
//                                                       → DROP (business_handle)
//   3. handle is a known bot actor (from F-INFRA-R43 bot-actors module)
//                                                       → DROP (bot_message)
//   4. classifyA2P(row) — branches per the critic-pinned decision table:
//        high   (shortcode + OTP regex + regulatory footer)
//                                                       → quarantine
//                                                          'imessage_a2p_shortcode_full',
//                                                          DROP (30d retention)
//        medium (shortcode + OTP regex, no footer)
//                                                       → quarantine
//                                                          'imessage_otp_strict',
//                                                          REDACT_DROP (30d)
//        low    (non-shortcode + OTP regex) + STRICT_ANCHOR present
//                                                       → quarantine
//                                                          'imessage_otp_strict',
//                                                          REDACT_DROP (30d)
//        low    (non-shortcode + OTP regex) without strict anchor
//                                                       → redact digit blocks
//                                                          in-place, PASS
//                                                          ('imessage_otp_redacted_kept')
//   5. shortcode-sender with NO OTP match — apply F-IMESSAGE-F2 critic logic:
//        shortcode + (regulatory footer OR marketing language)
//                                                       → quarantine
//                                                          'imessage_a2p_shortcode_full',
//                                                          DROP (30d)
//        shortcode alone (no OTP, no footer, no marketing)
//                                                       → redact digit blocks
//                                                          in-place, PASS
//                                                          ('imessage_shortcode_redacted_kept')
//   6. raw_content.text length < 2 chars                 → DROP (placeholder_residual)
//   7. otherwise                                         → PASS
//
// CRITIC-DRIVEN DESIGN:
//   * Pure shortcode-DROP and pure expanded-OTP-DROP were too aggressive
//     (lost lu.ma RSVPs, developer/meta conversations about codes).
//   * REDACT-then-PASS preserves the row in the ledger with the digit block
//     stripped so the cascade still sees conversational context.
//   * REDACT_DROP outputs are routed through F-INFRA-QUARANTINE so a 30-day
//     restore window protects against false positives.
//
// On PASS we additionally emit a structural_score hint derived from
// SALIENCE_STRUCTURAL_RULES.imessage.{substantive_prose, short_reply}.
// REDACT-and-PASS rows inherit the same structural-score logic — they
// remain conversational text after the digit block is removed.

import { CAPS } from "../../validation.js";
import { quarantineRow } from "../quarantine.js";
import {
  classifyA2P,
  hasRegulatoryFooter,
  isShortcodeSender,
} from "../../predicates/a2p.js";
import { isBotActor } from "../../identity/bot-actors.js";
// F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION — canonical band helper.
// All three PASS paths (OTP redact-and-keep, shortcode redact-and-keep,
// terminal PASS) route through computeStructuralScore so the
// substantive_prose vs short_reply cliff at SHORT_REPLY_CHAR_THRESHOLD
// is computed in one place.
import { computeStructuralScore } from "../structural-score.js";

// True binary tapback icons (per R22 decoder). 2005/2006/2007 carry quoted
// prose so are NOT dropped at Stage-0; the salience layer can score them.
const TAPBACK_DROP_LO = 2000;
const TAPBACK_DROP_HI = 2004;

const SHORT_REPLY_CHAR_THRESHOLD = 25;

// 30-day quarantine retention for all REDACT_DROP / shortcode-DROP rows.
// The retention window is driven by the global QUARANTINE_RETENTION_DAYS
// env knob (default 30d) — we record the intent here for forward-compat
// with a per-call override.
const QUARANTINE_RETENTION_DAYS = 30;

// Quarantine reasons. These MUST be present in
// lib/ingest/stage0/telemetry.js REASON_ALLOWLIST or the dispatcher will
// bucket them into "invalid_reason" and warn.
//
// REASON LITERALS (declared here so reconcileReasonAllowlist's static
// scanner sees them — it greps for the canonical `reason: <quoted string>`
// shape and would miss the constant-form usage otherwise; the comments
// below mirror the runtime emissions verbatim):
//   reason: "imessage_a2p_shortcode_full"        — F-T1-IMESSAGE-F2 DROP
//   reason: "imessage_shortcode_redacted_kept"   — F-T1-IMESSAGE-F2 PASS
//   reason: "imessage_otp_strict"                — F-T1-IMESSAGE-F1 STRICT
//   reason: "imessage_otp_redacted_kept"         — F-T1-IMESSAGE-F1 LOOSE
const REASON_A2P_SHORTCODE_FULL = "imessage_a2p_shortcode_full";
const REASON_SHORTCODE_REDACTED_KEPT = "imessage_shortcode_redacted_kept";
const REASON_OTP_STRICT = "imessage_otp_strict";
const REASON_OTP_REDACTED_KEPT = "imessage_otp_redacted_kept";
// F-T2-IMESSAGE-F3 — broader regulatory-footer DROP. Fires regardless of
// sender shape (full E.164 long-number A2P, business handle that slipped
// past the BIZ: prefix check, or shortcode without OTP match). The reason
// MUST appear in lib/ingest/stage0/telemetry.js REASON_ALLOWLIST or the
// dispatcher buckets it as "invalid_reason".
//   reason: "imessage_a2p_regulatory_footer"  — F-T2-IMESSAGE-F3 DROP
const REASON_A2P_REGULATORY_FOOTER = "imessage_a2p_regulatory_footer";
// F-T2-IMESSAGE-F9 — emitted when F-T2-IMESSAGE-F7 repaired parties[] for
// an outbound row via the chat_handle_join lookup. PASS-only reason so the
// operator can monitor the F7 fix-rate without conflating with normal
// outbound rows.
//   reason: "imessage_outbound_parties_repaired"  — F-T2-IMESSAGE-F9 PASS
const REASON_OUTBOUND_PARTIES_REPAIRED = "imessage_outbound_parties_repaired";
// F-NEW-W2-IMESSAGE-PARTIES-REPAIRED-COUNTER — disambiguates the F9 detection
// branch into two reasons. When the F7 lookup path executed (the connector
// stamped raw_content.parties_source = "chat_handle_join") but the
// chat_handle_join lookup yielded no other participants, parties collapses
// to ["user"] alone. That is semantically distinct from the success case
// (parties.length >= 2) — it represents a true zero-participant legacy
// chat.db edge (or a chat that genuinely has no other handles), NOT a
// successful repair. The empty-case bucket lets the operator monitor the
// F7 fix-rate vs the legacy zero-participant rate separately, and reduces
// false-positive risk on cross-producer parties-shape inference (Stage-0
// can no longer mistake a non-F7 ["user"]-only row for an F7 repair).
//   reason: "imessage_outbound_parties_repaired_empty"  — F-NEW-W2 PASS
//                                                        (F7 ran, empty result)
const REASON_OUTBOUND_PARTIES_REPAIRED_EMPTY =
  "imessage_outbound_parties_repaired_empty";
// F-NEW-W7-IMESSAGE-SERVICE-NOTIFICATION — transactional service shortcode
// notifications (food-delivery dispatch/delivery pings, laundry pickup-ready,
// rideshare "on the way"). The audit finding showed these PASSed via Rule 5b
// (imessage_shortcode_redacted_kept) at the default short_reply structural
// score (~0.5), wasting embed budget on ~low-signal recall-by-vendor traffic.
// Detection: shortcode sender + transactional phrase. We route them to PASS
// at structural_score=0.30 (below default substantive_prose) so they survive
// for "when did my order arrive" / "when did my food show up" recall
// queries but lose head-of-queue priority vs personal messages. Quarantine
// is NOT involved — these are PASS-with-downgrade rows.
//   reason: "imessage_service_transactional"  — F-NEW-W7 PASS+downgrade
const REASON_SERVICE_TRANSACTIONAL = "imessage_service_transactional";
const SERVICE_TRANSACTIONAL_STRUCTURAL_SCORE = 0.30;
// F-NEW-W7-IMESSAGE-F3-CONVERSATIONAL-OVERRIDE — conversational rescue
// for friend-forwarded spam. When BROAD_A2P_FOOTER_RE fires (Rule 5b)
// but the body carries casual conversational markers AND is short
// (<200 chars), the row is almost certainly a friend forwarding a spam
// screenshot mid-conversation rather than a real A2P delivery. We strip
// the marketing-footer suffix and PASS so the conversation context
// survives.
//   reason: "imessage_f3_conversational_rescue"  — F-NEW-W7 PASS
const REASON_F3_CONVERSATIONAL_RESCUE = "imessage_f3_conversational_rescue";

// WU-A4-IMESSAGE-STAGE0-SPAM-FILTER — three new spam pattern families that
// the audit found promoting past Stage-0 at high volume:
//
//   1. Promotional / scheduling SMS ("Hi {Name} - ExampleCo will be in
//      your area …", "reply Y by 5pm", "reply STOP"). Recurring pickup
//      notifications, gym promos, and similar 1-touch scheduling pings.
//      A single recurring vendor template can repeat dozens of times.
//      These slip past the regulatory-footer DROP because
//      "Please reply 'Y' by" is not on the CTIA/TCPA narrow allowlist; the
//      promotional shape is the durable signature.
//        reason: "imessage_promotional_sms"  — quarantine + DROP (30d)
//
//   2. Scam transfer / prize SMS (a "we just deposited <amount>" opening,
//      "claim your prize", "you have won"). Wire-transfer scam
//      preamble + lottery-style prize claims. These have zero recall value
//      and quarantine + DROP (30d) so a false-positive on a real bank
//      notification is restorable.
//        reason: "imessage_scam_sms"  — quarantine + DROP (30d)
//
//   3. Issuer-prefixed inverted OTP ("River Financial: 478291 is your
//      verification code"). The shipped INVERTED_OTP_ANCHOR_RE is anchored
//      at start-of-string and misses these; the shipped MODERN_OTP_REGEX
//      catches the digit block but routes to LOOSE (REDACT-and-PASS)
//      because the sender is non-shortcode. The new anchor extension
//      catches "NNNNNN is your <verification|confirmation|security|...>
//      code" appearing anywhere in the body, including after a short
//      issuer prefix, and routes it to STRICT (REDACT_DROP + quarantine)
//      because the canonical "is your verification code" phrasing is
//      unambiguous OTP regardless of position. Reuses the existing
//      REASON_OTP_STRICT bucket so the operator counter rolls up cleanly.
//
// The promotional + scam reasons MUST be added to lib/ingest/stage0/telemetry.js
// REASON_ALLOWLIST or the dispatcher will bucket them into "invalid_reason".
const REASON_PROMOTIONAL_SMS = "imessage_promotional_sms";
const REASON_SCAM_SMS = "imessage_scam_sms";

// URL-only PASS bucket. Operator-shared URLs in conversation are signal
// (a friend recommends an article, the operator forwards a link to
// themselves); we keep them with the entity-extractor downstream stamping
// the URL into features.entities[] as kind="artifact". A flat structural
// score of 0.35 keeps them below substantive_prose (~0.85) so personal
// conversation dominates the embed queue, but above short_reply (~0.4)
// is acceptable because the URL itself is the recallable artifact.
//   reason: "imessage_url_only"  — PASS at structural_score=0.35
const REASON_URL_ONLY = "imessage_url_only";
const URL_ONLY_STRUCTURAL_SCORE = 0.35;

// Strict OTP anchor — the unambiguous "is your X code: NNNNNN" / "verification
// code is NNNNNN" forms. Used to upgrade classifyA2P low-confidence matches
// to STRICT when the textual pattern is canonical enough to be unmistakable.
// Tight bounds: ≤3 modifier words between issuer and code, optional colon,
// 4-10 digit code. Case-insensitive.
// Anchor connective — matches the punctuation/word that joins "code" to the
// digit block in canonical OTP messages: " is: ", " is ", ": ", " ", or
// " is:". Bounded length so we don't overgreedy into prose.
const _ANCHOR = "(?:\\s+is\\s*:?|\\s*:)\\s*";

const STRICT_OTP_ANCHOR_RE = new RegExp(
  [
    // "is your <X> code <ANCHOR> NNNN"
    "\\bis\\s+your\\s+(?:[A-Za-z]+\\s+){0,3}code" + _ANCHOR + "\\d{4,10}\\b",
    // "your code <ANCHOR> NNNN" / "your <X> code <ANCHOR> NNNN"
    "\\byour\\s+(?:[A-Za-z]+\\s+){0,3}code" + _ANCHOR + "\\d{4,10}\\b",
    // "(verification|security|authentication|confirmation|access|login|one[-\\s]?time|sign[-\\s]?in) code <ANCHOR> NNNN"
    "\\b(?:verification|security|authentication|confirmation|access|login|one[-\\s]?time|sign[-\\s]?in)\\s+code" +
      _ANCHOR + "\\d{4,10}\\b",
    // "<issuer> [verification|security|...] code <ANCHOR> NNNN" — issuer
    // enumeration kept in sync with a2p.js. The optional class word between
    // issuer and "code" catches "Your OKX verification code is: 135790".
    "\\b(?:paypal|schwab|capital\\s+one|apple(?:\\s+id)?|stripe|anthropic|coinbase|okx)\\s+(?:(?:verification|security|authentication|confirmation|access|login)\\s+)?code" +
      _ANCHOR + "\\d{4,10}\\b",
    // Pure issuer prefix: "<issuer>: NNNN" or "<issuer> code NNNN".
    "\\b(?:paypal|schwab|capital\\s+one|apple(?:\\s+id)?|stripe|anthropic|coinbase|okx)\\s*:\\s*\\d{4,10}\\b",
    // "passcode: NNNN" / "passcode is NNNN" — the OTP regex catches this
    // via the generic family already, but we mirror it here so the strict
    // path covers messages classifyA2P misses (shortcode-without-issuer).
    "\\bpasscode" + _ANCHOR + "\\d{4,10}\\b",
    // "OTP: NNNN" / "OTP is NNNN" — same rationale as passcode.
    "\\botp" + _ANCHOR + "\\d{4,10}\\b",
    // "use code NNNN" — explicit issuer-action form.
    "\\buse\\s+code\\s+\\d{4,10}\\b",
  ].join("|"),
  "i"
);

// F-NEW-W7-IMESSAGE-INVERTED-OTP — inverted-order OTP anchor that catches
// the Facebook / Apple ID / generic "NNNNNN is your <issuer> confirmation
// code" form which MODERN_OTP_REGEX in predicates/a2p.js misses because
// that regex assumes the issuer/keyword precedes the digit block.
//
// Audit-observed forms (Layer 1 cascade missed all of these):
//   "<#> 123456 is your Facebook confirmation code"
//   "567890 is your Apple ID verification code"
//   "135790 is your OKX confirmation code"
//   "192847 is your Coinbase verification code"
//
// Bounded modifier-word allowance (≤2 words between issuer and "code") so
// we don't greedy-match into prose. Code token is 4-8 digits — the canonical
// OTP length range; a longer match would invite false positives on prose
// like "12345678 is your favorite number".
const INVERTED_OTP_ANCHOR_RE = new RegExp(
  "^\\s*(?:<#>\\s+)?\\d{4,8}\\s+is\\s+your\\s+(?:[A-Za-z]+\\s+){0,2}(?:confirmation\\s+|verification\\s+|security\\s+|authentication\\s+|access\\s+|login\\s+)?code\\b",
  "i",
);

// F-NEW-W7-IMESSAGE-SERVICE-NOTIFICATION — transactional-service phrase
// regex. Used in combination with isShortcodeSender(handle) to mark service
// notifications (delivery, laundry, rideshare-style) as PASS-with-downgrade rather
// than letting them through at the default short_reply score. The phrase
// list mirrors the audit predicate verbatim.
const SERVICE_TRANSACTIONAL_RE = new RegExp(
  [
    "\\bdispatched\\b",
    "\\bdelivered\\b",
    "\\bon\\s+the\\s+way\\b",
    "\\ben\\s+route\\b",
    "\\bpickup\\s+ready\\b",
    "\\barrived\\b",
    "\\bappointment\\b",
    "\\border\\s*#",
  ].join("|"),
  "i",
);

// F-NEW-W7-IMESSAGE-F3-CONVERSATIONAL-OVERRIDE — conversational marker
// detection for the friend-forwarded-spam rescue path. The audit observed
// that BROAD_A2P_FOOTER_RE was dropping rows where a friend forwarded a
// marketing screenshot with chat-style commentary ("lol look at this",
// "ha ha they sent this AGAIN"). Routing them through quarantine wastes
// the 30-day window AND loses conversation context.
//
// Detection: any of the canonical chat-register interjections AND the
// total text is short enough (< 200 chars) that the row is plausibly a
// forward-with-commentary, not a bulk A2P delivery. Long compliance-laden
// marketing emails (which can also contain "lol" in display copy) are NOT
// rescued — the length gate handles the gap.
const CONVERSATIONAL_MARKER_RE = /\b(lol|haha|ha\s+ha|forwarded|lmao|btw|wtf|omg)\b/i;
const CONVERSATIONAL_RESCUE_MAX_CHARS = 200;

// F-T2-IMESSAGE-F3 — broader regulatory-footer regex. Mirrors the audit
// predicate verbatim: "(reply|text) stop", "to opt[-\s]?out", "unsubscribe",
// "msg & data rates", "std msg & data rates", "msg freq(uency)". Used to
// catch A2P traffic from long-number senders (not just shortcodes) and
// business handles that slipped past the BIZ: prefix check.
//
// Rationale: shipped Wave 1 hasRegulatoryFooter() is intentionally narrow
// (Reply STOP / STOP to opt-out / msg&data rates / message and data rates
// / text HELP / reply HELP). The audit predicate enumerates additional
// canonical phrasings ("unsubscribe", "msg freq", "std msg & data rates"
// without spaces around the &) that the narrow predicate would miss.
//
// The rule fires AFTER the OTP cascade and AFTER the shortcode rule so
// shortcode + footer rows still route to REASON_A2P_SHORTCODE_FULL — the
// F3 path catches the residual long-number / unclassified senders.
//
// False-positive risk (per node spec): ~0.3% — friend forwarding a spam
// screenshot that quotes one of these phrases. Mitigated by routing
// through quarantineRow with 30d retention so restore is possible.
const BROAD_A2P_FOOTER_RE = new RegExp(
  [
    "\\b(?:reply|text)\\s+stop\\b",
    "\\bto\\s+opt[-\\s]?out\\b",
    "\\bunsubscribe\\b",
    "\\bmsg\\s*&?\\s*data\\s+rates\\b",
    "\\bstd\\.?\\s*(?:msg|message)?\\s*(?:&|and)?\\s*data\\s+rates\\b",
    "\\bmsg\\s+freq(?:uency)?\\b",
    "\\bmessage\\s+and\\s+data\\s+rates\\s+may\\s+apply\\b",
  ].join("|"),
  "i",
);

// WU-A4-IMESSAGE-STAGE0-SPAM-FILTER — promotional / scheduling SMS pattern
// regex. The detection is CONJUNCTIVE: the body must carry BOTH a
// promotional opener (canonical templated greeting / time-window / "we
// will be in your area" phrasing) AND a directive that mirrors the
// promotional reply convention ("reply Y", "reply YES", "reply N",
// "reply STOP", "to opt out", "to confirm"). The 2-of-2 gate keeps the
// false-positive rate near zero on real conversation:
//   - "Hi Alex, could you answer before lunch?"  has only one half (a
//     greeting, no reply directive) and PASSes.
//   - "Hi Alex - book your seasonal visit today. Reply YES to confirm."
//     hits both halves and DROPs.
//
// The greeting regex deliberately matches the "Hi <Name> -" / "Hi <Name>,"
// templated form (a leading "Hi " followed by a short capitalised proper-
// noun or first-name token + punctuation) and the marketing "we will be"
// scheduling preamble; both are durable across the dry-cleaning, gym,
// rideshare, and brand-loyalty promotional families the audit found.
const PROMOTIONAL_OPENER_RE = new RegExp(
  [
    // "Hi <Name> - " / "Hi <Name>, " / "Hi <Name>!" templated marketing
    // greeting. Bounded name length (1-20 chars) so it doesn't false-
    // positive on prose like "Hi i was wondering whether you got my msg".
    "^\\s*hi\\s+[A-Za-z][A-Za-z'\\-]{0,19}\\s*[,\\-!:]",
    // "will be in your area" / "will be in the area" — the canonical
    // dry-cleaning / mobile-service scheduling preamble.
    "\\bwill\\s+be\\s+in\\s+(?:your|the)\\s+area\\b",
    // "your scheduled" / "your appointment" / "your pickup" / "your delivery"
    // when paired with a window. These are the brand-loyalty / appointment
    // reminder shapes operators have flagged historically.
    "\\byour\\s+(?:scheduled|pickup|delivery)\\b",
    // "schedule your" / "book your" — outbound directive marketing.
    "\\b(?:schedule|book)\\s+your\\b",
  ].join("|"),
  "i",
);

// WU-A4-IMESSAGE-STAGE0-SPAM-FILTER — promotional reply directive. The
// canonical "reply Y", "reply YES", "reply N", "reply NO", "reply STOP",
// "to opt out", "to confirm" verbs. Matched independently of
// hasRegulatoryFooter / BROAD_A2P_FOOTER_RE so we don't fold this into
// the existing F3 path — the promotional shape is detected by the
// OPENER + DIRECTIVE 2-of-2 gate, not by the compliance footer alone.
const PROMOTIONAL_DIRECTIVE_RE = new RegExp(
  [
    "\\breply\\s+['\"]?[YN]['\"]?\\b",
    "\\breply\\s+(?:yes|no|stop|y\\s+to|n\\s+to)\\b",
    "\\bto\\s+confirm\\b",
    "\\bto\\s+opt[-\\s]?out\\b",
    "\\bto\\s+cancel\\b",
    "\\bto\\s+reschedul",
  ].join("|"),
  "i",
);

// WU-A4-IMESSAGE-STAGE0-SPAM-FILTER — scam transfer / prize claim regex.
// Single-hit DROP because each canonical phrase is by itself a near-
// unambiguous scam signature in the iMessage corpus. The deposit /
// transfer / claim / win family is well-attested in the audit and no
// legitimate family or 2FA message uses these phrases.
const SCAM_SMS_RE = new RegExp(
  [
    // "We have just deposited <N>" / "We just deposited <N>" — wire
    // transfer scam preamble.
    "\\bwe\\s+(?:have\\s+)?just\\s+deposited\\b",
    // "claim your prize" / "claim your reward" — lottery / sweepstakes
    // boilerplate.
    "\\bclaim\\s+your\\s+(?:prize|reward|winnings?|gift)\\b",
    // "you have won" / "you've won" — direct prize-announcement scams.
    // The 've / 'have contraction may attach to "you" with no whitespace,
    // so we allow either '\s+have' or "'ve" tightly bound to "you".
    "\\byou(?:\\s+have|['’]ve)\\s+won\\b",
    // "congratulations you have been selected" — sweepstakes preamble.
    // Same contraction handling for 've.
    "\\bcongratulations[!,.\\s]+you(?:\\s+have|['’]ve)\\s+been\\s+selected\\b",
    // "transfer of <$|>?<N>" + claim phrasing.
    "\\btransfer\\s+of\\s+\\$?\\d+\\s+(?:has\\s+been|to\\s+your)\\b",
  ].join("|"),
  "i",
);

// WU-A4-IMESSAGE-STAGE0-SPAM-FILTER — issuer-prefixed inverted OTP anchor.
// Catches "<Issuer>: NNNNNN is your <kind> code" when the digit block
// appears AFTER a short issuer prefix (e.g. "River Financial: 478291 is
// your verification code"). The shipped INVERTED_OTP_ANCHOR_RE is anchored
// at start-of-string so a leading issuer prefix breaks it; this anchor
// fires when the message STARTS with an issuer-like name (1-3 capitalised
// words OR a known issuer keyword) followed by a colon, then the digit
// block + "is your <kind> code" form.
//
// The leading-issuer requirement (capitalised word(s) + colon, or a
// known issuer keyword) is the FP guard: it keeps casual prose like "btw
// 938210 is your security code from the test rig" (lowercase chat
// register, no colon) out of the STRICT path so it falls through to
// LOOSE (REDACT-and-PASS) per the existing developer/meta exemption.
//
// The {0,3} word allowance between "your" and "code" accommodates
// "<kind>" variants ("verification", "confirmation", "security",
// "authentication", "one-time access", etc).
const ISSUER_PREFIXED_INVERTED_OTP_RE = new RegExp(
  "^\\s*(?:" +
    // Capitalised issuer prefix: 1-3 Title-Case words followed by colon.
    // Examples: "River Financial:", "OKX Exchange:", "Coinbase:".
    "[A-Z][A-Za-z]{1,19}(?:\\s+[A-Z][A-Za-z]{1,19}){0,2}\\s*:" +
    // OR a known issuer keyword (case-insensitive) — covers the
    // bracketed [Issuer] form and bare lower-case issuer prefixes the
    // colon-form would miss.
    "|\\[?(?:paypal|schwab|capital\\s*one|apple(?:\\s+id)?|stripe|anthropic|coinbase|okx|river\\s+financial|facebook)\\]?\\s*:?" +
    ")\\s*\\d{4,8}\\s+is\\s+your\\s+(?:[A-Za-z]+\\s+){0,3}(?:verification|confirmation|security|authentication|access|login|one[-\\s]?time|sign[-\\s]?in)\\s+code\\b",
  "i",
);

// WU-A4-IMESSAGE-STAGE0-SPAM-FILTER — URL-only message detector. After
// trimming whitespace, the body consists of a SINGLE URL (and optionally
// a small amount of surrounding whitespace). These are operator-shared
// links the cascade should preserve for "what was that podcast link"
// recall — but at a lowered structural score so they don't dominate the
// embed queue alongside substantive prose. The entity-extractor stage
// downstream stamps the URL into features.entities[] as kind="artifact".
//
// Detection is conservative: we require the ENTIRE trimmed body to be
// the URL (no surrounding prose). A message like "look at this
// https://… isn't it cool" is NOT a URL-only message — it has
// conversational content and flows through the terminal PASS at the
// default substantive_prose / short_reply band.
const URL_ONLY_RE = /^\s*https?:\/\/[^\s<>"')]+\s*$/i;

// Marketing-language signal — used in combination with shortcode to upgrade
// a shortcode-only row to a full quarantine DROP per F-IMESSAGE-F2 critic.
// Intentionally narrow: only matches phrases that are very unlikely in a
// 2FA-confirmation / civic-alert message (which we want to keep).
const MARKETING_LANG_RE = new RegExp(
  [
    "\\b\\d{1,3}%\\s+off\\b",
    "\\b(?:shop|buy)\\s+now\\b",
    "\\bsale\\b",
    "\\blimited\\s+time\\b",
    "\\bfree\\s+shipping\\b",
    "\\bclick\\s+here\\b",
    "\\bsave\\s+\\$?\\d+\\b",
    "\\bunsubscribe\\b",
    "\\bpromo\\s*code\\b",
    "\\bdeal\\b",
  ].join("|"),
  "i"
);

// Digit-block scrubber — replaces 4-10 contiguous digits with '[REDACTED]'.
// Used by the REDACT-and-PASS paths so the row stays in the ledger without
// the raw code. Conservative: we only touch digit runs ≥4 to avoid masking
// trivial numerics (times, dates, prices) that the salience layer needs.
const DIGIT_BLOCK_RE = /\b\d{4,10}\b/g;

function redactDigitBlocks(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  return text.replace(DIGIT_BLOCK_RE, "[REDACTED]");
}

// _shapeRowForQuarantine — the quarantine layer requires row.source. Stage-0
// receives event objects which already carry `source: "imessage"` from the
// dispatcher; defensive stamp in case a caller skips that envelope.
function _shapeForQuarantine(event) {
  if (event && typeof event === "object") {
    if (typeof event.source === "string" && event.source.length > 0) return event;
    return { ...event, source: "imessage" };
  }
  return { source: "imessage", raw_content: {} };
}

export function stage0(event) {
  if (!event || typeof event !== "object") {
    return { decision: "PASS", reason: null };
  }
  const rc = event.raw_content || {};

  // Rule 1 — tapback DROP (narrowed to true binary icons 2000-2004 per the
  // audit predicate. 2005-2007 carry quoted prose per R22 decoder so they
  // fall through to the standard PASS path.)
  const amt = rc.associated_message_type;
  if (
    typeof amt === "number" &&
    amt >= TAPBACK_DROP_LO &&
    amt <= TAPBACK_DROP_HI
  ) {
    return { decision: "DROP", reason: "tapback" };
  }

  // Rule 2 — business handle DROP.
  const handleId = typeof rc.handle_id === "string" ? rc.handle_id : "";
  if (handleId.startsWith("urn:biz:") || handleId.startsWith("BIZ:")) {
    return { decision: "DROP", reason: "business_handle" };
  }

  // Rule 3 — bot-actor handle DROP. Rare on iMessage but possible when an
  // email-shaped handle resolves to a known automation account (e.g.
  // dependabot@github.com forwarded via SMS-to-email). The handle is the
  // routing identifier the chat.db stamps, so we test it directly through
  // F-INFRA-R43.
  if (handleId.length > 0 && isBotActor(handleId)) {
    return { decision: "DROP", reason: "bot_message" };
  }

  const text = typeof rc.text === "string" ? rc.text : "";

  // Rule 4 — A2P / OTP classifier branch. We pass `rc` to classifyA2P which
  // already understands the imessage raw_content envelope (handle_id, text).
  //
  // The classifier's MODERN_OTP_REGEX has a known coverage gap: some issuer
  // forms ("Your OKX verification code is: 135790") slip past because the
  // anchor between "code" and the digit block has narrow flexibility. We
  // patch the gap locally with STRICT_OTP_ANCHOR_RE — when classifyA2P
  // returns no match but the strict anchor IS present, we treat the row as
  // a low-confidence OTP match (triggers ["otp_strict_anchor"]) so the
  // strict / loose decision table still fires.
  if (text.length > 0) {
    let verdict = classifyA2P({ handle_id: handleId, text });
    // F-NEW-W7-IMESSAGE-INVERTED-OTP — promote the inverted-order pattern
    // ("NNNNNN is your <issuer> confirmation code") to the same code path
    // as STRICT_OTP_ANCHOR_RE so the downstream STRICT/LOOSE table fires.
    // The MODERN_OTP_REGEX in predicates/a2p.js misses this shape because
    // it assumes the issuer keyword precedes the digit block. The inverted
    // anchor is treated as a strict-quality signal: when it fires from a
    // shortcode sender we route to STRICT (REDACT_DROP); from a non-shortcode
    // sender we treat it as low-confidence with the strict-anchor trigger
    // so the existing low-confidence STRICT_OTP_ANCHOR_RE branch picks it up.
    //
    // F-NEW-W7-IMESSAGE-INVERTED-OTP-OUTBOUND-FP — operator-authored
    // exemption. The inverted-order anchor false-positives on outbound
    // dev/test conversations where the operator wrote "1234 is your
    // testing code" while debugging an auth flow. The strict-anchor path
    // already exempts is_from_me messages downstream (4b/4c demote to
    // LOOSE redact-and-PASS); but the inverted anchor — being a narrower
    // / more recent signal — has zero legitimate inbound-spoof risk for
    // outbound rows. Gate the synthetic verdict on !is_from_me so an
    // outbound row that matches the inverted anchor (and nothing else)
    // falls through to the terminal PASS path (Rule 7) entirely
    // unredacted. Accept both boolean true and the chat.db sentinel 1.
    const isFromMe = rc.is_from_me === true || rc.is_from_me === 1;
    const invertedMatch =
      !verdict.match && !isFromMe && INVERTED_OTP_ANCHOR_RE.test(text);
    if (!verdict.match && (STRICT_OTP_ANCHOR_RE.test(text) || invertedMatch)) {
      verdict = {
        match: true,
        confidence: isShortcodeSender(handleId) ? "medium" : "low",
        suggested_action: isShortcodeSender(handleId)
          ? "REDACT_DROP"
          : "REDACT_PASS",
        triggers: [
          ...(isShortcodeSender(handleId) ? ["shortcode_sender"] : []),
          "otp_strict_anchor",
          ...(invertedMatch ? ["otp_inverted_anchor"] : []),
        ],
      };
    }
    // WU-A4-IMESSAGE-STAGE0-SPAM-FILTER — issuer-prefixed inverted OTP
    // upgrade. classifyA2P's MODERN_OTP_REGEX hits the digit block on
    // forms like "River Financial: 478291 is your verification code" but
    // routes the verdict to LOW (non-shortcode) → LOOSE (REDACT-and-PASS)
    // because the sender is a full E.164 number, not a shortcode. The
    // canonical "NNNNNN is your <verification|confirmation|...> code"
    // phrasing is unambiguous OTP regardless of sender shape, so we
    // upgrade the verdict to REDACT_DROP via the STRICT_OTP_ANCHOR_RE
    // pathway. Operator-authored rows still take the is_from_me exemption
    // downstream (4b/4c demote to LOOSE), so the operator can quote an
    // OTP in their own outbound prose without losing the row.
    if (
      verdict.match &&
      verdict.confidence === "low" &&
      !isFromMe &&
      ISSUER_PREFIXED_INVERTED_OTP_RE.test(text) &&
      !verdict.triggers.includes("otp_strict_anchor")
    ) {
      verdict = {
        ...verdict,
        triggers: [...verdict.triggers, "otp_strict_anchor", "otp_issuer_prefixed_inverted"],
      };
    }
    if (verdict.match) {
      const isShortcode = verdict.triggers.includes("shortcode_sender");
      const hasFooter = verdict.triggers.includes("regulatory_footer");

      // F-NEW-W1-IMESSAGE-OTP-OPERATOR-EXEMPT — operator-authored exemption.
      // The STRICT OTP branches false-positive on outbound messages where
      // the operator is DISCUSSING OTPs (debugging an auth flow, sending a
      // colleague a code excerpt, writing a meta message about the
      // "verification code is: NNNN" canonical anchor in a test fixture).
      // These are signal, not noise — operator authorship is the
      // distinguishing fact between "received an OTP" (third-party SMS we
      // want to scrub) and "wrote about an OTP" (operator prose worth
      // keeping). When rc.is_from_me is truthy we demote the STRICT
      // verdicts to the LOOSE (redact-and-PASS) path so the digits are
      // still scrubbed but the row stays in the ledger.
      // Accept both boolean true and the chat.db sentinel 1 (the connector
      // historically stamps the numeric form; the boolean form is the
      // forward-looking shape).
      const isOperatorAuthored =
        rc.is_from_me === true || rc.is_from_me === 1;

      // 4a — high confidence (shortcode + OTP + footer): F-T1-IMESSAGE-F2
      //      shortcode_full path → quarantine + DROP.
      if (verdict.confidence === "high") {
        try {
          quarantineRow(_shapeForQuarantine(event), REASON_A2P_SHORTCODE_FULL, {
            rule_id: "F-T1-IMESSAGE-F2/shortcode_full",
            source: "imessage",
          });
        } catch {
          // Quarantine failures must not crash the hot path; the dispatcher
          // still records the DROP for telemetry below.
        }
        return { decision: "DROP", reason: REASON_A2P_SHORTCODE_FULL };
      }

      // 4b — medium confidence (shortcode + OTP, no footer): strict OTP
      //      pathway per F-T1-IMESSAGE-F1 STRICT branch → quarantine +
      //      REDACT_DROP. We strip the digit block on the quarantined copy
      //      via a row-level rewrite before persisting so even the
      //      recoverable artifact carries no plaintext code.
      //      F-NEW-W1-IMESSAGE-OTP-OPERATOR-EXEMPT: operator-authored
      //      messages skip REDACT_DROP and fall through to the LOOSE
      //      redact-and-PASS branch below.
      if (verdict.confidence === "medium" && !isOperatorAuthored) {
        const redactedEvent = {
          ..._shapeForQuarantine(event),
          raw_content: { ...rc, text: redactDigitBlocks(text) },
        };
        try {
          quarantineRow(redactedEvent, REASON_OTP_STRICT, {
            rule_id: "F-T1-IMESSAGE-F1/otp_strict",
            source: "imessage",
          });
        } catch {
          /* hot path must not crash */
        }
        return { decision: "REDACT_DROP", reason: REASON_OTP_STRICT };
      }

      // 4c — low confidence (non-shortcode + OTP). Two sub-branches:
      //      strict anchor present → STRICT path (REDACT_DROP + quarantine);
      //      no strict anchor      → LOOSE path (REDACT-and-PASS, keep row).
      //      F-NEW-W1-IMESSAGE-OTP-OPERATOR-EXEMPT: when the strict anchor
      //      fires for an operator-authored message we demote to LOOSE
      //      rather than REDACT_DROP.
      if (verdict.confidence === "low") {
        // F-NEW-W7-IMESSAGE-INVERTED-OTP: treat the inverted-order anchor
        // as equivalent to STRICT for routing purposes. Either anchor type
        // satisfies the STRICT branch precondition; the rule_id surfaces
        // which anchor fired so the operator can monitor adoption.
        // WU-A4-IMESSAGE-STAGE0-SPAM-FILTER: the issuer-prefixed inverted
        // anchor (e.g. "River Financial: 478291 is your verification code")
        // is also a STRICT-quality signal — the canonical "is your
        // verification code" phrasing is unambiguous OTP even when the
        // digit block is floated after a short issuer prefix.
        const strictAnchorFired = STRICT_OTP_ANCHOR_RE.test(text);
        const invertedAnchorFired = INVERTED_OTP_ANCHOR_RE.test(text);
        const issuerPrefixedFired = ISSUER_PREFIXED_INVERTED_OTP_RE.test(text);
        if (
          (strictAnchorFired || invertedAnchorFired || issuerPrefixedFired) &&
          !isOperatorAuthored
        ) {
          const redactedEvent = {
            ..._shapeForQuarantine(event),
            raw_content: { ...rc, text: redactDigitBlocks(text) },
          };
          try {
            quarantineRow(redactedEvent, REASON_OTP_STRICT, {
              rule_id: issuerPrefixedFired
                ? "WU-A4-IMESSAGE-STAGE0-SPAM-FILTER/otp_issuer_prefixed_inverted"
                : invertedAnchorFired
                ? "F-NEW-W7-IMESSAGE-INVERTED-OTP/otp_inverted_anchor"
                : "F-T1-IMESSAGE-F1/otp_strict_anchor",
              source: "imessage",
            });
          } catch {
            /* hot path must not crash */
          }
          return { decision: "REDACT_DROP", reason: REASON_OTP_STRICT };
        }
      }

      // LOOSE: redact digit block, return PASS so the row stays in the
      // ledger. Covers:
      //   * low-confidence + no strict anchor (the original LOOSE path)
      //   * low-confidence + strict anchor + operator-authored (demoted)
      //   * medium-confidence + operator-authored (demoted)
      // F-NEW-W1-IMESSAGE-OTP-OPERATOR-EXEMPT also requires we CLONE
      // event.raw_content before mutating .text so we don't surprise
      // upstream callers that retained a reference to the original event.
      if (
        verdict.confidence === "low" ||
        (verdict.confidence === "medium" && isOperatorAuthored)
      ) {
        const redactedText = redactDigitBlocks(text);
        if (event.raw_content && typeof event.raw_content === "object") {
          // Clone before mutate — preserves the caller's original
          // raw_content object so any retained references see unredacted
          // text. Stage-0 downstream consumers see the redacted clone via
          // event.raw_content rebound below.
          event.raw_content = { ...event.raw_content, text: redactedText };
        }
        // F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION — central band
        // computation. Identical to the pre-W5 inline lookup.
        const score = computeStructuralScore(
          { text: redactedText },
          "imessage",
          {
            contentFields: ["text"],
            shortReplyThreshold: SHORT_REPLY_CHAR_THRESHOLD,
            lowerBand: "short_reply",
          }
        );
        return {
          decision: "PASS",
          reason: REASON_OTP_REDACTED_KEPT,
          structural_score: score ?? 0.5,
          // Diagnostic surface for operator tooling — confirms the redaction
          // path that fired. Optional; not part of the dispatcher contract.
          redaction: {
            applied: true,
            kind: isOperatorAuthored && verdict.confidence !== "low"
              ? "otp_operator_exempt"
              : "otp_loose",
            triggers: verdict.triggers,
          },
        };
      }
    }
  }

  // Rule 4b — WU-A4-IMESSAGE-STAGE0-SPAM-FILTER promotional / scam guard
  // that fires BEFORE the shortcode-sender branch so shortcode-delivered
  // promotional templates (pickup services / appointment reminders)
  // and shortcode-delivered prize scams DROP under the dedicated
  // promotional / scam buckets rather than the legacy
  // imessage_shortcode_redacted_kept PASS at the substantive_prose score.
  // Operator-authored rows are exempted (small-business / outbound use).
  if (text.length > 0) {
    const isFromMeForSpamEarly = rc.is_from_me === true || rc.is_from_me === 1;
    if (
      !isFromMeForSpamEarly &&
      PROMOTIONAL_OPENER_RE.test(text) &&
      PROMOTIONAL_DIRECTIVE_RE.test(text)
    ) {
      try {
        quarantineRow(_shapeForQuarantine(event), REASON_PROMOTIONAL_SMS, {
          rule_id: "WU-A4-IMESSAGE-STAGE0-SPAM-FILTER/promotional_sms",
          source: "imessage",
        });
      } catch {
        /* hot path must not crash */
      }
      return { decision: "DROP", reason: REASON_PROMOTIONAL_SMS };
    }
    if (!isFromMeForSpamEarly && SCAM_SMS_RE.test(text)) {
      try {
        quarantineRow(_shapeForQuarantine(event), REASON_SCAM_SMS, {
          rule_id: "WU-A4-IMESSAGE-STAGE0-SPAM-FILTER/scam_sms",
          source: "imessage",
        });
      } catch {
        /* hot path must not crash */
      }
      return { decision: "DROP", reason: REASON_SCAM_SMS };
    }
  }

  // Rule 5 — shortcode-sender F-T1-IMESSAGE-F2 path for NON-OTP shortcode
  // traffic (lu.ma RSVPs, civic alerts, brand pings). The critic split this
  // into two tiers:
  //   shortcode + (footer OR marketing) → full quarantine DROP
  //   shortcode + transactional phrase  → PASS with structural_score=0.30
  //                                       (F-NEW-W7-IMESSAGE-SERVICE-NOTIFICATION)
  //   shortcode alone                   → REDACT-and-PASS (keep metadata)
  if (isShortcodeSender(handleId) && text.length > 0) {
    const footer = hasRegulatoryFooter(text);
    const marketing = MARKETING_LANG_RE.test(text);
    if (footer || marketing) {
      try {
        quarantineRow(_shapeForQuarantine(event), REASON_A2P_SHORTCODE_FULL, {
          rule_id: "F-T1-IMESSAGE-F2/shortcode_marketing",
          source: "imessage",
        });
      } catch {
        /* hot path must not crash */
      }
      return { decision: "DROP", reason: REASON_A2P_SHORTCODE_FULL };
    }
    // F-NEW-W7-IMESSAGE-SERVICE-NOTIFICATION — transactional service
    // shortcode notifications (ExampleEats dispatched/delivered, a laundry
    // pickup ready, a ride on the way, appointment reminders). These carry
    // signal for "when did my order arrive" / "when did the food show up"
    // recall queries but should not occupy the head of the embed queue
    // alongside personal messages. PASS at a flat structural_score=0.30
    // (well below the substantive_prose default ~0.85) with the digit
    // blocks scrubbed so the recall-by-text path still resolves.
    // Detection requires the transactional phrase to be present on top of
    // the shortcode-sender shape so we don't downgrade plain shortcode
    // event reminders (lu.ma, civic alerts) — those still flow through
    // the Rule-5 "shortcode alone" PASS path below at the default score.
    if (SERVICE_TRANSACTIONAL_RE.test(text)) {
      const redactedText = redactDigitBlocks(text);
      // F-NEW-W7-IMESSAGE-MUTATION — defensive-copy violation fix. Clone
      // raw_content before rebinding event.raw_content so any caller that
      // retained a reference to the original raw_content object sees the
      // unredacted text. Mirrors the LOOSE-OTP path pattern above. Stage-0
      // must never mutate the input object's raw_content in place.
      if (event.raw_content && typeof event.raw_content === "object") {
        event.raw_content = { ...event.raw_content, text: redactedText };
      }
      return {
        decision: "PASS",
        reason: REASON_SERVICE_TRANSACTIONAL,
        structural_score: SERVICE_TRANSACTIONAL_STRUCTURAL_SCORE,
        redaction: {
          applied: true,
          kind: "service_transactional",
          sender: handleId,
        },
      };
    }
    // Shortcode alone — strip digit blocks, KEEP. Civic alerts and lu.ma
    // RSVPs from sc 61108 etc. survive with the digit body redacted.
    const redactedText = redactDigitBlocks(text);
    // F-NEW-W7-IMESSAGE-MUTATION — defensive-copy violation fix. Clone
    // raw_content before rebinding event.raw_content so any caller that
    // retained a reference to the original raw_content object sees the
    // unredacted text. Mirrors the LOOSE-OTP path pattern above.
    if (event.raw_content && typeof event.raw_content === "object") {
      event.raw_content = { ...event.raw_content, text: redactedText };
    }
    // F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION — central band
    // computation. Identical to the pre-W5 inline lookup.
    const score = computeStructuralScore(
      { text: redactedText },
      "imessage",
      {
        contentFields: ["text"],
        shortReplyThreshold: SHORT_REPLY_CHAR_THRESHOLD,
        lowerBand: "short_reply",
      }
    );
    return {
      decision: "PASS",
      reason: REASON_SHORTCODE_REDACTED_KEPT,
      structural_score: score ?? 0.5,
      redaction: {
        applied: true,
        kind: "shortcode_only",
        sender: handleId,
      },
    };
  }

  // Rule 5b — F-T2-IMESSAGE-F3 broader regulatory-footer DROP. Fires for
  // ANY sender (full E.164 long-number A2P, business handle that slipped
  // past the BIZ: prefix check, residual shortcode without OTP) when the
  // body carries the canonical CTIA / TCPA compliance footer or marketing-
  // frequency text. Quarantined with 30d retention so restore is possible.
  //
  // We route via quarantineRow (not true permanent DROP) so the 0.3%
  // false-positive case — a friend forwarding a spam screenshot that
  // happens to quote "Reply STOP" — is restorable from the quarantine
  // directory for the retention window.
  if (text.length > 0 && BROAD_A2P_FOOTER_RE.test(text)) {
    // F-NEW-W7-IMESSAGE-F3-CONVERSATIONAL-OVERRIDE — friend-forwarded-spam
    // rescue. When the body carries the regulatory footer BUT ALSO carries
    // conversational chat-register markers ("lol", "haha", "btw", "wtf",
    // "forwarded") AND the total length is short enough (< 200 chars) to
    // be a plausible forward-with-commentary, the row is almost certainly
    // a friend pasting a spam screenshot, not a real A2P delivery. We
    // strip the regulatory footer suffix and PASS so the conversation
    // context survives. Detection is conjunctive (markers AND length)
    // because long marketing emails can legitimately quote "lol" inside
    // brand voice; the length gate keeps the false-positive rate near zero.
    if (
      text.length < CONVERSATIONAL_RESCUE_MAX_CHARS &&
      CONVERSATIONAL_MARKER_RE.test(text)
    ) {
      // Strip the regulatory footer suffix in-place — every BROAD_A2P_FOOTER_RE
      // match is replaced with the [REDACTED_MARKETING] sentinel so the
      // post-rescue body is the conversational portion alone. We do this
      // GLOBALLY to catch repeated footer phrases.
      const rescuedText = text.replace(
        new RegExp(BROAD_A2P_FOOTER_RE.source, "gi"),
        "[REDACTED_MARKETING]",
      );
      // F-NEW-W7-IMESSAGE-MUTATION — defensive-copy violation fix. Clone
      // raw_content before rebinding event.raw_content so any caller that
      // retained a reference to the original raw_content object sees the
      // unrescued text. Mirrors the LOOSE-OTP path pattern above.
      if (event.raw_content && typeof event.raw_content === "object") {
        event.raw_content = { ...event.raw_content, text: rescuedText };
      }
      const score = computeStructuralScore(
        { text: rescuedText },
        "imessage",
        {
          contentFields: ["text"],
          shortReplyThreshold: SHORT_REPLY_CHAR_THRESHOLD,
          lowerBand: "short_reply",
        }
      );
      return {
        decision: "PASS",
        reason: REASON_F3_CONVERSATIONAL_RESCUE,
        structural_score: score ?? 0.5,
        redaction: {
          applied: true,
          kind: "f3_conversational_rescue",
        },
      };
    }
    try {
      quarantineRow(_shapeForQuarantine(event), REASON_A2P_REGULATORY_FOOTER, {
        rule_id: "F-T2-IMESSAGE-F3/regulatory_footer",
        source: "imessage",
      });
    } catch {
      /* hot path must not crash */
    }
    return { decision: "DROP", reason: REASON_A2P_REGULATORY_FOOTER };
  }

  // Rule 5e — WU-A4-IMESSAGE-STAGE0-SPAM-FILTER URL-only PASS at
  // downgraded structural_score. Body is a SINGLE URL (and surrounding
  // whitespace only). Operator-shared URLs in conversation are signal
  // (a friend recommends an article, the operator forwards a link to a
  // future self) and the entity-extractor downstream stamps the URL
  // into features.entities[] as kind="artifact" — the URL becomes the
  // recallable anchor. We PASS at structural_score=0.35 so these rows
  // survive recall but lose head-of-queue priority vs personal prose.
  //
  // Mixed messages ("look at this https://… isn't it cool") are NOT
  // URL-only — they flow through the terminal PASS at the default
  // substantive_prose / short_reply band per the regular path. The
  // anchored ^…$ regex enforces the SINGLE-URL invariant.
  if (text.length > 0 && URL_ONLY_RE.test(text)) {
    return {
      decision: "PASS",
      reason: REASON_URL_ONLY,
      structural_score: URL_ONLY_STRUCTURAL_SCORE,
    };
  }

  // Rule 6 — placeholder residual DROP. Trim because "  " is still empty
  // after the connector emits the chat.db NULL → "" sentinel.
  if (text.trim().length < 2) {
    return { decision: "DROP", reason: "placeholder_residual" };
  }

  // Rule 7 — PASS + structural-score hint.
  //
  // F-T2-IMESSAGE-F9 telemetry surface: when the connector
  // (F-T2-IMESSAGE-F7) repaired this row's parties[] via the
  // chat_handle_join lookup, surface the fact via the reason field so the
  // per-reason drop telemetry counter (stage0/index.js dispatcher wrapper)
  // can monitor the F7 fix-rate as a denominator.
  //
  // F-NEW-W2-IMESSAGE-PARTIES-REPAIRED-COUNTER: the detection now keys on
  // the connector-stamped marker raw_content.parties_source === "chat_handle_join"
  // (set by lib/connectors/imessage.js whenever the F7 lookup path executed
  // for the row, regardless of outcome). The legacy parties-shape inference
  // (is_from_me=1 AND handle_id==null AND parties[0]=='user' AND length>=2)
  // is retained as a fallback for ledger rows written before the connector
  // marker was added, but a missing marker is no longer required — the
  // marker is the authoritative signal because it cannot be forged by any
  // other producer.
  //
  // Two reasons are now emitted:
  //   - REASON_OUTBOUND_PARTIES_REPAIRED       : F7 ran AND found participants
  //     (parties has >=2 entries with "user" first) — success bucket.
  //   - REASON_OUTBOUND_PARTIES_REPAIRED_EMPTY : F7 ran but yielded only
  //     ["user"] — true zero-participant legacy chat (chat_handle_join row
  //     empty or table missing). Distinct bucket so the operator can see
  //     the legacy-DB rate without conflating it with successful repairs.
  // F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION — terminal PASS band.
  const structural_score = computeStructuralScore(
    { text },
    "imessage",
    {
      contentFields: ["text"],
      shortReplyThreshold: SHORT_REPLY_CHAR_THRESHOLD,
      lowerBand: "short_reply",
    }
  );
  const partiesArray = Array.isArray(event.parties) ? event.parties : null;
  const partiesIsUserOnly =
    partiesArray != null &&
    partiesArray.length === 1 &&
    partiesArray[0] === "user";
  const partiesIsUserPlus =
    partiesArray != null &&
    partiesArray.length >= 2 &&
    partiesArray[0] === "user";
  // Authoritative marker: connector stamped raw_content.parties_source on
  // the row when F7 executed. This is the primary signal.
  const f7MarkerPresent = rc.parties_source === "chat_handle_join";
  // Legacy fallback: pre-marker ledger rows must still bucket correctly,
  // so we infer F7 ran from the outbound + null-handle + user-first shape
  // when the marker is absent. The shape only requires user-first; the
  // length disambiguates success vs empty.
  const f7InferredFromShape =
    !f7MarkerPresent &&
    rc.is_from_me === 1 &&
    rc.handle_id == null &&
    (partiesIsUserOnly || partiesIsUserPlus);
  let partiesRepairedReason = null;
  if ((f7MarkerPresent || f7InferredFromShape) && rc.is_from_me === 1) {
    if (partiesIsUserPlus) {
      partiesRepairedReason = REASON_OUTBOUND_PARTIES_REPAIRED;
    } else if (partiesIsUserOnly) {
      partiesRepairedReason = REASON_OUTBOUND_PARTIES_REPAIRED_EMPTY;
    }
  }
  return {
    decision: "PASS",
    reason: partiesRepairedReason,
    structural_score: structural_score ?? 0.5,
  };
}

// Re-export the per-source structural-score table fragment so the salience
// core (or operator tooling) can read the canonical mapping without
// re-parsing CAPS. Source: CAPS.SALIENCE_STRUCTURAL_RULES.imessage.
export function structuralRules() {
  return { ...(CAPS.SALIENCE_STRUCTURAL_RULES?.imessage || {}) };
}

// Exported constants are test handles and operator-tooling read surfaces.
// They are deliberately not part of the runtime stage0() contract.
export const _F_T1_IMESSAGE = Object.freeze({
  REASON_A2P_SHORTCODE_FULL,
  REASON_SHORTCODE_REDACTED_KEPT,
  REASON_OTP_STRICT,
  REASON_OTP_REDACTED_KEPT,
  TAPBACK_DROP_LO,
  TAPBACK_DROP_HI,
  STRICT_OTP_ANCHOR_RE,
  MARKETING_LANG_RE,
  QUARANTINE_RETENTION_DAYS,
});

// Wave 2 test handle. Carries the new constants introduced by
// F-T2-IMESSAGE-F3 (broad regulatory-footer DROP) and F-T2-IMESSAGE-F9
// (per-reason telemetry visibility — the parties_repaired PASS bucket).
// F-NEW-W2-IMESSAGE-PARTIES-REPAIRED-COUNTER adds the empty-case bucket
// (REASON_OUTBOUND_PARTIES_REPAIRED_EMPTY) so the F7 fix-rate and the true
// zero-participant legacy edge are independently observable.
export const _F_T2_IMESSAGE = Object.freeze({
  REASON_A2P_REGULATORY_FOOTER,
  REASON_OUTBOUND_PARTIES_REPAIRED,
  REASON_OUTBOUND_PARTIES_REPAIRED_EMPTY,
  BROAD_A2P_FOOTER_RE,
});

// Wave 7 test handle. Carries the new constants introduced by
// F-NEW-W7-IMESSAGE-SERVICE-NOTIFICATION (transactional shortcode PASS at
// downgraded structural_score), F-NEW-W7-IMESSAGE-INVERTED-OTP (inverted-
// order Facebook/Apple OTP detection), and F-NEW-W7-IMESSAGE-F3-
// CONVERSATIONAL-OVERRIDE (friend-forward conversational rescue). Surfaced
// for tests so the regex shapes and structural_score floor can be asserted
// without re-parsing the module body.
export const _F_NEW_W7_IMESSAGE = Object.freeze({
  REASON_SERVICE_TRANSACTIONAL,
  REASON_F3_CONVERSATIONAL_RESCUE,
  SERVICE_TRANSACTIONAL_STRUCTURAL_SCORE,
  SERVICE_TRANSACTIONAL_RE,
  INVERTED_OTP_ANCHOR_RE,
  CONVERSATIONAL_MARKER_RE,
  CONVERSATIONAL_RESCUE_MAX_CHARS,
});

// WU-A4-IMESSAGE-STAGE0-SPAM-FILTER test handle. Surfaces the new spam-
// filter constants so tests can assert the regex shapes and the URL-only
// PASS structural-score floor without re-parsing the module body.
//   REASON_PROMOTIONAL_SMS               - Rule 5c quarantine DROP
//   REASON_SCAM_SMS                      - Rule 5d quarantine DROP
//   REASON_URL_ONLY                      - Rule 5e PASS @ 0.35
//   URL_ONLY_STRUCTURAL_SCORE            - the 0.35 floor literal
//   PROMOTIONAL_OPENER_RE                - 2-of-2 gate, opener half
//   PROMOTIONAL_DIRECTIVE_RE             - 2-of-2 gate, directive half
//   SCAM_SMS_RE                          - single-hit scam regex
//   ISSUER_PREFIXED_INVERTED_OTP_RE      - issuer-prefix OTP extension
//   URL_ONLY_RE                          - URL-only body detector
export const _WU_A4_IMESSAGE = Object.freeze({
  REASON_PROMOTIONAL_SMS,
  REASON_SCAM_SMS,
  REASON_URL_ONLY,
  URL_ONLY_STRUCTURAL_SCORE,
  PROMOTIONAL_OPENER_RE,
  PROMOTIONAL_DIRECTIVE_RE,
  SCAM_SMS_RE,
  ISSUER_PREFIXED_INVERTED_OTP_RE,
  URL_ONLY_RE,
});
