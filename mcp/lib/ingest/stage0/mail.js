// Stage-0 hard-drop module for the `mail` source (R39 Phase 3).
//
// Layer 1 of the R25 salience cascade for Apple Mail captures. Input: a
// fully-formed source-row event from storage/sources/mail.jsonl. The
// connector stamps `raw_content.headers` with a lowercased-key subset
// (list-unsubscribe, list-id, auto-submitted, precedence, return-path,
// from, content-type) plus Apple-derived columns (unsubscribe_type,
// list_id_hash, automated_conversation, brand_indicator). Stage-0 reads
// from BOTH sources: Apple's own classifier signals get first say (cheap
// integer checks; Apple already detects ~70% of bulk mail), then RFC
// header rules catch what Apple misses (or what a non-Apple ingest
// pipeline emits with these headers).
//
// Rules (per R39 Phase A inventory § Stage-0 rule table, extended by
// F-T2-MAIL-F11 with Rule 0 — operator-classified Junk folder):
//   0. raw_content.mailbox_url matches /(Junk|Spam|Trash|Bulk Mail|
//        Deleted Messages)\b/i                          → DROP (operator_junk_folder)
//                                                          via quarantine (30d)
//   1. raw_content.unsubscribe_type > 0                  → DROP (list_unsubscribe)
//   2. raw_content.list_id_hash != null                  → DROP (list_id)
//   3. headers.list-unsubscribe present                  → DROP (list_unsubscribe)
//   4. headers.list-id present                           → DROP (list_id)
//   5. headers.auto-submitted matches /auto/i            → DROP (auto_submitted)
//   6. headers.precedence matches /bulk|junk|list/i      → DROP (bulk_precedence)
//   7. headers.from matches /noreply|no-reply|donotreply/i → DROP (noreply_sender)
//   8. F-T2-MAIL-F4: marketing-platform domain match on Return-Path OR
//        raw_content.dkim_d_domain OR raw_content.auth_results_d_domain
//        against the expanded MARKETING_PLATFORM_RE                → DROP
//                                                          (marketing_platform)
//                                                          via quarantine (30d)
//   9. raw_content.automated_conversation > 0 AND NOT
//        isPersonSenderExempt(event) (A2: first_party OR
//        person-shaped From + envelope; exempt rows FALL
//        THROUGH to 9a-11, no early PASS)                  → DROP (apple_automated)
//   9a. F-T2-MAIL-F5: subject matches SUBJECT_AUTOREPLY_RE → DROP
//                                                          (subject_autoreply)
//                                                          via quarantine (30d)
//   9b. F-T2-MAIL-F5: subject matches SUBJECT_BRACKET_NOISE_RE → DROP
//                                                          (subject_bracket_noise)
//                                                          via quarantine (30d)
//  10. raw_content.text matches OTP regex                → REDACT_DROP (otp_pattern)
//  11. raw_content.text trim length < 2                  → DROP (placeholder_residual)
//  12. otherwise                                        → PASS
//
// F-T2-MAIL-F11 rationale: Apple Mail's per-message mailbox membership
// is the operator's own classifier — when the row sits in Junk/Spam/
// Trash/Bulk Mail/Deleted Messages, the human already deemed it
// unwanted. We honour that decision BEFORE running any header-based
// rule so the operator's curation is the highest-priority signal in
// the cascade. The regex is anchored to a word boundary so partial
// matches (e.g. "Junkyard" as a custom folder) do not fire. Per the
// W2 critic invariants, the DROP routes through quarantineRow (30-day
// retention) rather than irreversible drop — the operator can restore
// if a legitimate row was misfiled.
//
// On PASS:
//   - html_only_discount: hasHtml && !hasPlain → halve structural_score
//   - mostly_quoted: not currently computable from raw_content alone
//     (the connector already strips quoted text); structural reflects
//     the residual content
//
// Default structural threshold: text >= 200 chars → substantive_prose,
// else short_reply (200 is operator-mail-scale; iMessage uses 25).

import { CAPS } from "../../validation.js";
import { quarantineRow } from "../quarantine.js";
// F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION — canonical band helper.
// mail uses the substantive_prose vs short_reply cliff at 200 chars
// (dense-prose cliff). html_only_discount remains an in-module override
// applied AFTER the central band — it is a defense-in-depth multiplier
// for the html-only structural smell that is not part of the central
// band shape.
import { computeStructuralScore, resolveBand } from "../structural-score.js";

const SHORT_REPLY_CHAR_THRESHOLD = 200;

const NOREPLY_RE = /noreply|no-reply|donotreply|do-not-reply/i;

// A2 (memory-roots node mail-admission-fix) — Rule 9 person-sender
// exemption. Apple's automated_conversation column is NOT an auto-
// responder flag: Apple stamps 2 on any conversation that has no reply
// yet (ac=2 on 91% of the ledger; A1 census maps/mail-admission-census.md
// FA1-2), so an unconditional Rule 9 kills every thread OPENER from a new
// human sender while the "Re:" replies come back ac=0 and PASS — the
// cascade kept the answer and dropped the question. The four regexes
// below feed isPersonSenderExempt(); they gate ONLY Rule 9.
//
// PERSON_NAME_RE: 2-4 words, each Capitalised-then-lowercase, Unicode
// aware ("Zoë Ångström Példa" passes; all-caps "ACMEXYZ", bare
// addresses and one-word names do not). Same regex A1 scored with
// (mail_census_replay.mjs:84). Double-quoted display names ("Example
// Airlines") are rejected BEFORE this regex runs — brands quote, people
// rarely do; A1's quote-stripping variant admitted airline itinerary
// rows plus cloud-vendor OTP mail.
const PERSON_NAME_RE = /^\p{Lu}[\p{Ll}'’.\-]+(?:\s+\p{Lu}[\p{Ll}'’.\-]+){1,3}$/u;
// ROLE_LOCAL_RE: From local-parts that are role mailboxes, not people.
// The spec's role list plus the no_reply / bounce / survey /
// customerservice / reservations / bookings / tickets / invoices /
// payments forms from A1's TRANSACTIONAL_LOCAL_RE (replay :89); the
// `no[-_.]?reply` form is what closes `Apple Support <no_reply@…>`
// (NOREPLY_RE at Rule 7 has no underscore variant).
const ROLE_LOCAL_RE =
  /^(?:service|support|no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|receipts?|billing|alerts?|news(?:letter)?|hello|info|team|sales|marketing|posts?|bounces?|bounce|mailer|postmaster|updates?|help|contact|admin|reminders?|jobs?|careers?|community|events?|feedback|orders?|shop|store|welcome|security|verify|accounts?|intake|studies|mail|mailer-daemon|survey|customerservice|reservations|bookings?|tickets?|invoices?|payments?)$/i;
// BRAND_TOKEN_RE: an UNQUOTED display name that is person-shaped but
// carries a brand/service word ("Example School", "Acme Support",
// "Example Receipts") is a brand, not a person. Subset of A1's
// replay :81 list plus the tokens the census leaks needed (school,
// cloud, airlines, official, foundation, institute, university) and
// `reply` — "No Reply <user-…@mailer.example.org>" is two
// capitalised words with a non-role local-part, and Rule 7's NOREPLY_RE
// has no spaced form (FINDINGS.md FA2-3).
const BRAND_TOKEN_RE =
  /\b(?:team|support|service|services|notifications?|billing|orders?|accounts?|info|news|newsletter|updates?|alerts?|customer|care|help|sales|marketing|store|shop|bank|payments?|receipts?|invoice|security|verify|verification|digest|community|contact|admin|mailer|robot|bot|system|automated|reply|inc|llc|ltd|corp|group|labs?|studio|club|events|network|cloud|school|airlines?|official|foundation|institute|university|rewards|offers|deals)\b/i;
// SRS_RE: forwarder Sender-Rewriting-Scheme envelopes (SRS0=/SRS1=) keep
// the original sender's identity in the local-part, so a Return-Path of
// `<SRS0=x=y=example.org=sam@forwarder>` still counts as "the sender's
// own envelope". VERP/BATV forms (`bounces+…`, `bounce-…`, `prvs=`) are
// ESP envelopes and are NOT accepted — A1's first draft that accepted
// them rescued neighbourhood-digest and card-issuer bulk mail.
const SRS_RE = /^srs[01]=/i;
// F-T2-MAIL-F4: expanded ESP coverage. The list covers the modern
// transactional + marketing email service provider landscape (Klaviyo,
// Customer.io, Postmark, Mailgun .net/.com variants, Iterable, Braze,
// ActiveCampaign, ConvertKit, Drip, Constant Contact, Campaign Monitor
// (cmail*), MailerLite, Resend, Loops, Brevo/Sendinblue, Moosend,
// GetResponse, SendPulse, SMTP2Go, Mandrill, plus the original mailchimp /
// sendgrid (.net AND .com) / mailgun / sparkpost / amazonses set). The
// regex is matched against three signals (Return-Path, DKIM d=,
// Authentication-Results d=) in priority order; the d= variants are more
// reliable because customer-domain Return-Path forgery is common.
//
// False-positive risk acknowledged: legitimate transactional emails from
// these ESPs (e.g. Postmark password resets) WILL drop. That is the
// expected_impact trade — operators who want transactional retention can
// add a downstream allow-list keyed on header.subject. The unsubscribe_type
// + list_id_hash fast-paths still PASS one-off transactional confirmations
// that lack list-mail markers.
const MARKETING_PLATFORM_RE =
  /mailchimp\.com|sendgrid\.net|sendgrid\.com|mailgun\.(?:org|net|com)|sparkpostmail\.com|amazonses\.com|amazonaws\.com|klaviyomail\.com|mkt\.com|marketo\.com|hubspotemail\.net|hubspot\.com|pardot\.com|iterable\.com|customeriomail\.com|postmarkapp\.com|mandrillapp\.com|mcsv\.net|braze\.com|activecampaign\.com|convertkit-mail\.com|drip\.com|constantcontact\.com|cmail\d*\.com|mailerlite\.com|resend\.com|loops\.so|brevo\.com|sendinblue\.com|moosend\.com|getresponse\.com|sendpulse\.com|smtp2go\.net/i;
const AUTO_SUBMITTED_RE = /^auto-/i;
const BULK_PRECEDENCE_RE = /\b(bulk|junk|list)\b/i;

// F-T2-MAIL-F5: subject-anchored OOO / auto-reply / vacation responder
// patterns the RFC 3834 Auto-Submitted header misses (older Exchange and
// pre-2022 Gmail vacation responders typically OMIT Auto-Submitted but
// stamp the subject with the localized "Out of office" / "OOO" / "Auto
// reply" prefix). Anchored at subject start (with optional Re:/Fwd:
// prefix) so legitimate prose subjects that happen to mention "out of
// office" later in the line don't fire.
const SUBJECT_AUTOREPLY_RE =
  /^\s*(?:re:\s*|fwd?:\s*)?(?:\[(?:auto[- ]?reply|out of office|ooo|automatic reply|vacation|away)\]|auto[- ]?reply:|out of office|ooo:|automatic reply|vacation responder|away from office|i am (?:currently )?out)/i;

// F-T2-MAIL-F5: carrier / MTA / spam-filter bracket tags. Personal mail
// virtually never opens with "[SPAM]" or "[EXTERNAL]". Match at the very
// start so subject prose that contains a similarly-bracketed acronym
// (e.g. mid-line "[SPAM] is funny") does not fire.
const SUBJECT_BRACKET_NOISE_RE =
  /^\s*\[(?:spam|external|junk|bulk|bounced|delivery (?:status|failure)|undeliverable)\]/i;

// F-T2-MAIL-F11 (WU-mail-extend): operator-curated spam folders. The
// regex matches against the mailbox URL the Apple Mail Envelope Index
// stores per message (e.g. imap://user@x/INBOX/Junk,
// imap://user@x/[Gmail]/Spam, ews://Bulk%20Mail, mbox://Trash). The
// folder names are case-insensitive and word-boundary anchored so
// "Junkyard" or "Trashcan" custom folders do NOT fire. Apple's
// localized folder names (e.g. "Pourriel" for fr-FR, "Papierkorb" for
// de-DE) are NOT covered here — operator localization is rare on the
// captured stream and would dilute precision; the audit predicate
// (F-T2-MAIL-F11) explicitly scopes Rule 0 to the canonical English
// names.
const OPERATOR_JUNK_FOLDER_RE =
  /\/(Junk|Spam|Trash|Bulk Mail|Deleted Messages)\b/i;

// isOperatorJunkFolder — Rule 0's folder test as a PURE predicate (B6,
// memory-roots): true iff mailboxUrl is a string matching
// OPERATOR_JUNK_FOLDER_RE. The regex has this one definition; stage0()
// Rule 0 below keeps testing it directly (no decision or reason change).
// Consumed by lib/identity/alias-candidates.js so the name_token key never
// counts a sole-recipient row the operator already classified as junk. No
// fs, no quarantine side effect.
export function isOperatorJunkFolder(mailboxUrl) {
  return typeof mailboxUrl === "string" && OPERATOR_JUNK_FOLDER_RE.test(mailboxUrl);
}

// Defensive source stamping for quarantineRow. Stage-0 receives event
// objects which already carry source="mail" from the dispatcher; this
// shim ensures direct callers (unit tests that bypass the dispatcher)
// still produce a well-formed quarantine entry.
function _shapeForQuarantine(event) {
  if (event && typeof event === "object") {
    if (typeof event.source === "string" && event.source.length > 0) return event;
    return { ...event, source: "mail" };
  }
  return { source: "mail", raw_content: {} };
}

function nonEmpty(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// listDropReason — Stage-0 mail rules 1-4 as a PURE predicate (B2,
// memory-roots). Returns the reason string rules 1-4 would DROP on, in their
// existing order, or null when none fires:
//   1. Apple's own unsubscribe_type column (>0 = bulk-mail bucket; Apple's
//      classifier already detects it — the fast path that catches ~70%
//      before we touch any header)         -> "list_unsubscribe"
//   2. Apple's list_id_hash column          -> "list_id"
//   3. RFC List-Unsubscribe header          -> "list_unsubscribe"
//   4. RFC List-ID header                   -> "list_id"
// Extracted so a read-only probe (lib/identity/alias-candidates.js, the
// "direct non-list mail" tally) can ask "is this a list mail?" without
// calling stage0(), whose rule 0 has a write side effect (quarantineRow).
// stage0() calls this in place; decisions and reason strings are unchanged
// and REASON_ALLOWLIST (telemetry.js) is untouched.
export function listDropReason(rc, headers) {
  const r = rc && typeof rc === "object" ? rc : {};
  const h = headers && typeof headers === "object" ? headers : {};
  // 1. Apple's own unsubscribe_type column.
  if (typeof r.unsubscribe_type === "number" && r.unsubscribe_type > 0) {
    return "list_unsubscribe";
  }
  // 2. Apple's list_id_hash column.
  if (r.list_id_hash != null && r.list_id_hash !== 0) {
    return "list_id";
  }
  // 3. RFC List-Unsubscribe header.
  if (nonEmpty(h["list-unsubscribe"])) {
    return "list_unsubscribe";
  }
  // 4. RFC List-ID header.
  if (nonEmpty(h["list-id"])) {
    return "list_id";
  }
  return null;
}

// A2 — local `<...>` extractor, the same 3-line shape as A1's
// mail_census_replay.mjs:155-159 so the shipped predicate scores the
// ledger exactly as the census did. A bare address (no angle brackets)
// is returned whole; a null envelope `<>` yields "<>" (neither empty nor
// equal nor SRS, so a DSN-shaped envelope is never exempt).
function _addrOf(v) {
  const m = /<([^>]+)>/.exec(v || "");
  return (m ? m[1] : (v || "")).trim().toLowerCase();
}
function _localPart(addr) {
  const i = addr.indexOf("@");
  return i < 0 ? addr : addr.slice(0, i);
}
// Display name = everything before the first "<", trimmed, quotes KEPT
// (the caller rejects a double-quoted name); "" for a bare address.
function _displayName(from) {
  const i = from.indexOf("<");
  return i < 0 ? "" : from.slice(0, i).trim();
}

// A2 — pure predicate gating the Rule 9 exemption. True iff `enabled`
// AND either
//   (A) event.source_policy.consent_basis === "first_party" (the
//       connector stamps it when From is an operator alias — the
//       operator's own outgoing openers; read defensively, fixtures lack
//       it), or
//   (B) all of: From display name present, NOT double-quoted, matches
//       PERSON_NAME_RE, no BRAND_TOKEN_RE hit; From local-part not
//       ROLE_LOCAL_RE; Return-Path local-part empty, equal to the From
//       local-part (case-insensitive — both sides are lowercased by
//       _addrOf), or an SRS0=/SRS1= rewrite.
// `enabled` defaults to the CAPS flag (env-at-import lever, frozen) and
// is overridable per call so tests can exercise the OFF path without
// mutating CAPS. Reads only; writes nothing on the event.
export function isPersonSenderExempt(
  event,
  { enabled = CAPS.MAIL_STAGE0_PERSON_SENDER_EXEMPT_ENABLED } = {}
) {
  if (!enabled) return false;
  if (!event || typeof event !== "object") return false;
  if (event.source_policy?.consent_basis === "first_party") return true;
  const headers = (event.raw_content || {}).headers || {};
  const from = nonEmpty(headers["from"]) ? headers["from"] : "";
  if (from.length === 0) return false;
  const name = _displayName(from);
  if (name.length === 0 || name.startsWith('"')) return false;
  if (!PERSON_NAME_RE.test(name) || BRAND_TOKEN_RE.test(name)) return false;
  const fromLocal = _localPart(_addrOf(from));
  if (fromLocal.length === 0 || ROLE_LOCAL_RE.test(fromLocal)) return false;
  const rpLocal = nonEmpty(headers["return-path"])
    ? _localPart(_addrOf(headers["return-path"]))
    : "";
  return rpLocal === "" || rpLocal === fromLocal || SRS_RE.test(rpLocal);
}

export function stage0(event) {
  if (!event || typeof event !== "object") {
    return { decision: "PASS", reason: null };
  }
  const rc = event.raw_content || {};
  const headers = rc.headers || {};

  // 0. F-T2-MAIL-F11 — operator-curated Junk/Spam/Trash/Bulk Mail/
  //    Deleted Messages folder placement is the highest-priority
  //    Stage-0 signal: the operator has already classified the message
  //    by moving it into one of these folders. We route through
  //    quarantineRow (30-day restore window) so a misfile is
  //    recoverable; the DROP decision still surfaces via the
  //    dispatcher's recordDrop telemetry under reason
  //    "operator_junk_folder".
  const mailboxUrl = typeof rc.mailbox_url === "string" ? rc.mailbox_url : "";
  if (mailboxUrl.length > 0 && OPERATOR_JUNK_FOLDER_RE.test(mailboxUrl)) {
    try {
      quarantineRow(_shapeForQuarantine(event), "operator_junk_folder", {
        rule_id: "F-T2-MAIL-F11/operator_junk_folder",
        source: "mail",
      });
    } catch {
      // Quarantine failures must NOT crash the Stage-0 hot path; the
      // dispatcher still records the DROP for telemetry below.
    }
    return { decision: "DROP", reason: "operator_junk_folder" };
  }

  // 1-4. List-mail signals (Apple unsubscribe_type, Apple list_id_hash, RFC
  // List-Unsubscribe, RFC List-ID) — evaluated in that order by the pure
  // listDropReason above; the decision and reason string are exactly what
  // the four inline blocks it replaced returned.
  const listReason = listDropReason(rc, headers);
  if (listReason) return { decision: "DROP", reason: listReason };
  // 5. Auto-Submitted (RFC 3834).
  if (nonEmpty(headers["auto-submitted"]) && AUTO_SUBMITTED_RE.test(headers["auto-submitted"])) {
    return { decision: "DROP", reason: "auto_submitted" };
  }
  // 6. Precedence: bulk / junk / list.
  if (nonEmpty(headers["precedence"]) && BULK_PRECEDENCE_RE.test(headers["precedence"])) {
    return { decision: "DROP", reason: "bulk_precedence" };
  }
  // 7. noreply sender.
  if (nonEmpty(headers["from"]) && NOREPLY_RE.test(headers["from"])) {
    return { decision: "DROP", reason: "noreply_sender" };
  }
  // 8. Marketing platform. F-T2-MAIL-F4 (Wave 3): expanded ESP list +
  // priority check against Return-Path, DKIM d=, and the
  // Authentication-Results header.d= / smtp.mailfrom= domain. The d=
  // signals are more reliable than Return-Path because ESPs commonly forge
  // a customer-domain Return-Path while signing with their own d= domain.
  // The DROP is quarantined (30d) per the WU-mail-rules CRITIC INVARIANT
  // so misfires on legitimate transactional ESP mail can be restored.
  const returnPath = nonEmpty(headers["return-path"]) ? headers["return-path"] : "";
  const dkimDomain = typeof rc.dkim_d_domain === "string" ? rc.dkim_d_domain : "";
  const authResultsDomain = typeof rc.auth_results_d_domain === "string"
    ? rc.auth_results_d_domain : "";
  const marketingHit =
    (returnPath.length > 0 && MARKETING_PLATFORM_RE.test(returnPath)) ||
    (dkimDomain.length > 0 && MARKETING_PLATFORM_RE.test(dkimDomain)) ||
    (authResultsDomain.length > 0 && MARKETING_PLATFORM_RE.test(authResultsDomain));
  if (marketingHit) {
    try {
      quarantineRow(_shapeForQuarantine(event), "marketing_platform", {
        rule_id: "F-T2-MAIL-F4/marketing_platform",
        source: "mail",
      });
    } catch {
      /* never crash hot path on quarantine I/O */
    }
    return { decision: "DROP", reason: "marketing_platform" };
  }
  // 9. Apple's automated_conversation flag — NOT an auto-responder
  //    signal. Apple stamps ac=2 on any conversation without a reply yet
  //    (91% of the ledger), so the unconditional form of this rule killed
  //    every human thread opener (a correspondent's first message on a
  //    new subject, with no "Re:" prefix, as well as the operator's
  //    own outgoing openers) while their "Re:" replies PASSed. A2: a first_party row
  //    or a person-shaped sender (unquoted person-shaped display name with
  //    no brand token + non-role local-part + own-envelope Return-Path,
  //    see isPersonSenderExempt) FALLS THROUGH to 9a/9b/10/11 and the
  //    normal PASS path — no early PASS, so the OTP and placeholder rules
  //    still apply. The rejected quote-stripped variant of the display
  //    name test admitted airline itinerary and cloud-vendor OTP
  //    rows; the brand-token + no_reply tightenings close
  //    `Apple Support <no_reply@…>` and `Example School <es@…>`.
  //    Kill-switch: CAPS.MAIL_STAGE0_PERSON_SENDER_EXEMPT_ENABLED (env
  //    MEMORY_MAIL_STAGE0_PERSON_SENDER_EXEMPT_ENABLED=0) restores the
  //    unconditional DROP.
  if (
    typeof rc.automated_conversation === "number" &&
    rc.automated_conversation > 0 &&
    !isPersonSenderExempt(event)
  ) {
    return { decision: "DROP", reason: "apple_automated" };
  }

  // 9a. F-T2-MAIL-F5 — Subject-anchored OOO / auto-reply prefix. Catches
  // pre-RFC-3834 vacation responders (older Exchange / Gmail) that lack
  // Auto-Submitted. Quarantined (30d) so a misfire on a personal mail that
  // happens to lead with "I am out" prose is restorable.
  const subj = nonEmpty(headers["subject"]) ? headers["subject"] : "";
  if (subj.length > 0 && SUBJECT_AUTOREPLY_RE.test(subj)) {
    try {
      quarantineRow(_shapeForQuarantine(event), "subject_autoreply", {
        rule_id: "F-T2-MAIL-F5/subject_autoreply",
        source: "mail",
      });
    } catch {
      /* never crash hot path on quarantine I/O */
    }
    return { decision: "DROP", reason: "subject_autoreply" };
  }
  // 9b. F-T2-MAIL-F5 — Carrier/MTA bracket tags ([SPAM], [EXTERNAL],
  // [DELIVERY FAILURE], etc.) at subject start. Quarantined for the same
  // reason as 9a.
  if (subj.length > 0 && SUBJECT_BRACKET_NOISE_RE.test(subj)) {
    try {
      quarantineRow(_shapeForQuarantine(event), "subject_bracket_noise", {
        rule_id: "F-T2-MAIL-F5/subject_bracket_noise",
        source: "mail",
      });
    } catch {
      /* never crash hot path on quarantine I/O */
    }
    return { decision: "DROP", reason: "subject_bracket_noise" };
  }

  const text = typeof rc.text === "string" ? rc.text : "";

  // 10. OTP / verification-code pattern. Shared regex with iMessage.
  if (text.length > 0) {
    const otpRe = new RegExp(CAPS.SALIENCE_OTP_REGEX, "i");
    if (otpRe.test(text)) {
      return { decision: "REDACT_DROP", reason: "otp_pattern" };
    }
  }

  // 11. Placeholder residual.
  if (text.trim().length < 2) {
    return { decision: "DROP", reason: "placeholder_residual" };
  }

  // PASS + structural-score hint.
  // F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION: route the band lookup
  // through the central helper. The cliff (200 chars) and the lower band
  // name ("short_reply") match the pre-W5 inline logic.
  let structural_score = computeStructuralScore(
    { text },
    "mail",
    {
      contentFields: ["text"],
      shortReplyThreshold: SHORT_REPLY_CHAR_THRESHOLD,
      lowerBand: "short_reply",
    }
  );
  // html_only_discount: a part with text/html but no text/plain is a
  // structural smell (newsletters / brand templates abuse html-only). Apply
  // a 0.5x multiplier without dropping. Preserved as an in-module override
  // ON TOP of the central computation per the W5 invariant ("per-source
  // defense-in-depth rules are preserved").
  if (rc.has_html === true && rc.has_plain === false) {
    const discount = resolveBand("mail", "html_only_discount");
    structural_score *= typeof discount === "number" ? discount : 0.5;
  }
  return {
    decision: "PASS",
    reason: null,
    structural_score,
  };
}

export function structuralRules() {
  return { ...(CAPS.SALIENCE_STRUCTURAL_RULES?.mail || {}) };
}
