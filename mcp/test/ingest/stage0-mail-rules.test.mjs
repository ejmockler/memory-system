// stage0-mail-rules.test.mjs — hermetic unit tests for the WU-mail-rules
// (Wave 3) Stage-0 mail rule changes + the W2 follow-up coverage gap
// (F-NEW-W2-MAIL-RULE0-TEST-COVERAGE).
//
// Covers:
//   F-T2-MAIL-F2  — RFC 2047 encoded-word decoder for Subject + From.
//   F-T2-MAIL-F3  — expanded OTP regex (Stripe/Twilio/Apple/Google/MS/GitHub
//                   email-2FA shapes via CAPS.SALIENCE_OTP_REGEX).
//   F-T2-MAIL-F4  — MARKETING_PLATFORM_RE expansion + DKIM d= /
//                   Authentication-Results d= signal usage.
//   F-T2-MAIL-F5  — subject-anchored OOO / [SPAM] / [EXTERNAL] DROPs;
//                   connector captures Subject header.
//   F-T2-MAIL-F9  — text/calendar (.ics) fallback extraction (parseEmail
//                   synthesises a text body from SUMMARY / DTSTART /
//                   LOCATION / ORGANIZER).
//   F-T2-MAIL-F11 — operator_junk_folder rule (Rule 0; Wave 2 introduced it
//                   but did NOT ship tests; this file closes that gap per
//                   F-NEW-W2-MAIL-RULE0-TEST-COVERAGE).
//
// HERMETIC: hand-built event objects + decoder calls; no SQLite. Rules 0 / 8 /
// 9a / 9b DROP *via quarantine* (quarantineRow in lib/ingest/quarantine.js),
// so this suite DOES write — 43 rows per run — and those writes MUST land in
// a mkdtemp scratch, never in storage/quarantine/mail/<day>.jsonl. Measured
// before A10 (memory-roots, 2026-09-15): a bare run appended 43 rows with
// source_msg_id null to the LIVE file (17 marketing_platform, 12
// subject_autoreply, 8 subject_bracket_noise, 6 operator_junk_folder).
//
// A10 (hermetic-stage0-tests): MEMORY_ROOT / STORAGE_BASE_DIR /
// QUARANTINE_BASE_DIR are pinned to the scratch BEFORE any ../../lib import
// evaluates — the same pattern as test/stage0-mail-passrate.test.mjs:35-48.
// ESM hoists static imports ahead of every body statement, so the four lib
// imports are dynamic `await import(...)` (top-level await, cf.
// test/ingest/salience-cascade.test.mjs:45-46); lib/config.js reads the env
// at module evaluation and quarantine.js reads QUARANTINE_BASE_DIR at call
// time — both now see the scratch. The (viii) child spawns with
// `env: { ...process.env, ... }` and inherits the pin. Tests assert
// decisions, reasons, that quarantine reasons are registered in
// REASON_ALLOWLIST, and (HERMETIC_POST_CHECK, tail) that the 43 rows are in
// the scratch and no fixture-marked bytes reached the live sinks.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// --- HERMETIC_POST_CHECK live-sink tripwire: snapshot BEFORE the env pin ----
// Two candidate live sinks are watched: (a) the storage/ tree next to this
// checkout (what nodes/A10.md's Verify stats), and (b) whatever lib/config.js
// WOULD resolve from the caller's environment before we pin it — by default
// the default MEMORY_ROOT storage, which is the LIVE store even when this file runs
// from a worktree that has no storage/ of its own. Sizes are taken now; the
// tail asserts nothing fixture-marked was appended. Raw size / mtime
// identity is deliberately NOT the gate: the mail connector and telemetry
// flushes append to these files concurrently (cf. test/_hermetic-daemon-skip.mjs
// header), so an equality check would be flaky under run-all-tests
// REQUIRE_HERMETIC=1. The gate is "grew AND the appended bytes carry one of
// this suite's synthetic fixture strings".
const UTC_DAY = new Date().toISOString().slice(0, 10);
const REPO_STORAGE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "storage"
);
const CALLER_STORAGE =
  process.env.STORAGE_BASE_DIR ||
  join(process.env.MEMORY_ROOT || join(homedir(), "memory-system"), "storage");
const CALLER_QUARANTINE =
  process.env.QUARANTINE_BASE_DIR || join(CALLER_STORAGE, "quarantine");
const LIVE_SINKS = [
  ...new Set([
    join(REPO_STORAGE, "quarantine", "mail", `${UTC_DAY}.jsonl`),
    join(CALLER_QUARANTINE, "mail", `${UTC_DAY}.jsonl`),
    join(REPO_STORAGE, "telemetry", `stage0_counters_${UTC_DAY}.jsonl`),
    join(CALLER_STORAGE, "telemetry", `stage0_counters_${UTC_DAY}.jsonl`),
  ]),
];
function sizeOf(p) {
  try {
    return statSync(p).size;
  } catch {
    return 0; // absent → 0 (a worktree without storage/, or a fresh day)
  }
}
const LIVE_SIZES_BEFORE = new Map(LIVE_SINKS.map((p) => [p, sizeOf(p)]));
// Fixture-unique strings that appear verbatim in every row this suite
// quarantines (rule 0 / 8 / 9a / 9b bodies + the Rule-0 mailbox url). None
// of them can occur in real captured mail or in a telemetry snapshot.
const FIXTURE_MARKERS = Object.freeze([
  "would otherwise PASS substantive prose long enough to clear threshold",
  "imap://user@x/INBOX/Junk",
  "newsletter body of substantial length to ensure structural threshold is moot",
  "newsletter body content with no marketing return-path",
  "I will return June 20",
  "body content goes here",
]);
function appendedTail(p, from) {
  const size = sizeOf(p);
  if (size <= from) return "";
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
function liveSinkLeaks() {
  const leaks = [];
  for (const [p, before] of LIVE_SIZES_BEFORE) {
    const tail = appendedTail(p, before);
    const marker = FIXTURE_MARKERS.find((m) => tail.includes(m));
    if (marker) leaks.push({ path: p, before, after: sizeOf(p), marker });
  }
  return leaks;
}

// --- Hermetic env MUST be set before any import touches config.js ----------
// Mirrors test/stage0-mail-passrate.test.mjs:35-48.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-stage0-mail-rules-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.QUARANTINE_BASE_DIR = join(TMP_ROOT, "quarantine");
// Operator identity is resolved once at module load
// (lib/identity/operator-identity.js): pin the synthetic identity file here,
// before the first lib import, so no operator value is hardcoded below.
process.env.MEMORY_OPERATOR_IDENTITY_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "operator-identity.synthetic.json"
);
mkdirSync(process.env.STORAGE_BASE_DIR, { recursive: true, mode: 0o700 });
mkdirSync(process.env.QUARANTINE_BASE_DIR, { recursive: true, mode: 0o700 });
process.on("exit", (code) => {
  // Re-arm the tripwire at exit so a write that happens AFTER the body's
  // post-check (telemetry.js flushes counters on beforeExit) is still caught.
  if (code === 0) {
    const leaks = liveSinkLeaks();
    if (leaks.length > 0) {
      console.error(
        `FAIL HERMETIC_POST_CHECK (at exit): fixture-marked bytes reached a live sink ${JSON.stringify(leaks)}`
      );
      process.exitCode = 1;
    }
  }
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort scratch cleanup */
  }
});

// Dynamic imports: everything under ../../lib/ is loaded AFTER the pin so
// lib/config.js (MEMORY_ROOT / STORAGE_DIR at :34 / :40) and
// lib/ingest/stage0/telemetry.js (STORAGE_DIR bound at :63) evaluate with
// the scratch root.
const { stage0: mailStage0, isPersonSenderExempt } = await import(
  "../../lib/ingest/stage0/mail.js"
);
const { decodeEncodedWord, icsToText, parseEmail } = await import(
  "../../lib/connectors/_mime-body-extractor.js"
);
const { CAPS } = await import("../../lib/validation.js");
const { REASON_ALLOWLIST } = await import(
  "../../lib/ingest/stage0/telemetry.js"
);

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  ok ${label}`);
}

// ===========================================================================
// F-NEW-W2-MAIL-RULE0-TEST-COVERAGE — operator_junk_folder (Rule 0)
// Wave-2 shipped the rule (F-T2-MAIL-F11) but did NOT add tests; this block
// is the test-coverage backfill.
// ===========================================================================
console.log("# F-T2-MAIL-F11 — Rule 0 operator_junk_folder coverage backfill");

// Canonical English folder names: Junk / Spam / Trash / Bulk Mail /
// Deleted Messages. The mailbox_url is supplied by the connector's
// LEFT JOIN against the mailboxes table; we exercise each canonical name.
for (const url of [
  "imap://user@x/INBOX/Junk",
  "imap://user@x/[Gmail]/Spam",
  "mbox://Trash",
  "ews://Bulk Mail",
  "imap://user@x/Deleted Messages",
]) {
  const r = mailStage0({
    source: "mail",
    raw_content: {
      mailbox_url: url,
      text: "would otherwise PASS substantive prose long enough to clear threshold",
      headers: {},
    },
  });
  assert.strictEqual(r.decision, "DROP", `url=${url}`);
  assert.strictEqual(r.reason, "operator_junk_folder", `url=${url}`);
}
ok("Rule 0 fires for canonical Junk / Spam / Trash / Bulk Mail / Deleted Messages");

// Word-boundary anchor: "Junkyard" / "Trashcan" custom folders must NOT fire.
for (const url of [
  "imap://user@x/INBOX/Junkyard",
  "imap://user@x/INBOX/Trashcan",
  "imap://user@x/INBOX/Inbox",
]) {
  const r = mailStage0({
    source: "mail",
    raw_content: {
      mailbox_url: url,
      text: "substantive prose body that should pass through cleanly",
      headers: {},
    },
  });
  assert.notStrictEqual(r.reason, "operator_junk_folder", `url=${url}`);
}
ok("Rule 0 does NOT fire on 'Junkyard' / 'Trashcan' / 'Inbox' (word boundary)");

// Rule 0 precedes header rules: even with list-unsubscribe present, the
// operator's folder decision wins so telemetry attributes the drop to
// operator_junk_folder rather than list_unsubscribe.
{
  const r = mailStage0({
    source: "mail",
    raw_content: {
      mailbox_url: "imap://user@x/INBOX/Junk",
      headers: { "list-unsubscribe": "<mailto:u@example.com>" },
      text: "newsletter body",
    },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "operator_junk_folder");
}
ok("Rule 0 wins over list_unsubscribe (operator curation is highest priority)");

// Defensive: missing / non-string mailbox_url falls through.
{
  const r = mailStage0({
    source: "mail",
    raw_content: { mailbox_url: null, text: "ok body content " + "x".repeat(220), headers: {} },
  });
  assert.strictEqual(r.decision, "PASS");
}
ok("Rule 0 with null mailbox_url → PASS (falls through)");

// REASON_ALLOWLIST registration sanity.
assert.ok(REASON_ALLOWLIST.has("operator_junk_folder"));
ok("operator_junk_folder is registered in REASON_ALLOWLIST");

// ===========================================================================
// F-T2-MAIL-F2 — RFC 2047 encoded-word decoder
// ===========================================================================
console.log("# F-T2-MAIL-F2 — RFC 2047 encoded-word decoder");

assert.strictEqual(decodeEncodedWord("=?utf-8?B?SGVsbG8gV29ybGQ=?="), "Hello World");
ok("base64 utf-8 encoded-word decodes");

assert.strictEqual(decodeEncodedWord("=?utf-8?Q?Hello=20World?="), "Hello World");
ok("Q-encoded utf-8 decodes");

// Mixed: one encoded word, rest plain.
assert.ok(
  decodeEncodedWord("Re: =?utf-8?B?SGVsbG8=?= world").includes("Hello"),
);
ok("mixed encoded + plain decodes the encoded segments only");

// Malformed encoded-word passes through unchanged.
assert.strictEqual(decodeEncodedWord("=?utf-8?X?broken?="), "=?utf-8?X?broken?=");
ok("malformed encoded-word passes through (defensive)");

// Latin-1 / ISO-8859-1.
assert.strictEqual(
  decodeEncodedWord("=?iso-8859-1?Q?Caf=E9?="),
  "Café",
);
ok("ISO-8859-1 Q-encoded decodes Café glyph");

// CJK base64 round-trip — exercises non-ASCII charset best-effort.
{
  const cjkB64 = Buffer.from("漢字", "utf8").toString("base64");
  const got = decodeEncodedWord(`=?utf-8?B?${cjkB64}?=`);
  assert.strictEqual(got, "漢字");
}
ok("CJK (utf-8 base64) round-trips");

// No-op when no encoded-word marker present.
assert.strictEqual(decodeEncodedWord("plain subject"), "plain subject");
ok("plain text passes through unchanged");

// parseEmail decodes Subject header inline so Stage-0 / structural-threshold
// see the decoded glyphs.
{
  const raw = [
    "From: =?utf-8?B?44GT44KT44Gr44Gh44Gv?= <hi@example.com>",
    "To: alex@example.com",
    "Subject: =?utf-8?B?SGVsbG8gV29ybGQ=?=",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "body",
  ].join("\r\n");
  const parsed = parseEmail(Buffer.from(raw, "utf8"));
  assert.strictEqual(parsed.headers.subject, "Hello World");
  // The From display-name encoded segment must be decoded too (Japanese
  // "konnichiwa" greeting glyphs).
  assert.ok(parsed.headers.from.includes("こんにちは"));
}
ok("parseEmail decodes encoded Subject + From display-name");

// ===========================================================================
// F-T2-MAIL-F3 — expanded OTP regex coverage (shared CAPS.SALIENCE_OTP_REGEX)
// ===========================================================================
console.log("# F-T2-MAIL-F3 — expanded OTP regex");

const otpRe = new RegExp(CAPS.SALIENCE_OTP_REGEX, "i");

// New shapes the original regex missed.
const otpHits = [
  "123456 is your verification code",
  "654321 is your sign-in code",
  "98765 is your security PIN",
  "Use this code: 555111",
  "Enter code: 444222",
  "Enter this code: 111000",
  "Your one-time passcode is 987654",
  "Your PIN is 1234",
  "Your one time password is 444555",
  "OTP: 123456",
  "PIN: 9999",
];
for (const t of otpHits) {
  assert.ok(otpRe.test(t), `expected hit: ${JSON.stringify(t)}`);
}
ok(`OTP regex matches the ${otpHits.length} expanded email-2FA shapes`);

// Original shapes still match (regression guard for iMessage path).
for (const t of [
  "your verification code is 654321",
  "OKX login attempt",
  "Coinbase code: 4242",
  "Your security code is 8888",
]) {
  assert.ok(otpRe.test(t), `original shape regressed: ${JSON.stringify(t)}`);
}
ok("Original iMessage OTP shapes still match");

// Stage-0 emits REDACT_DROP on an expanded match.
{
  const r = mailStage0({
    source: "mail",
    raw_content: {
      headers: { subject: "Login" },
      text: "123456 is your verification code",
    },
  });
  assert.strictEqual(r.decision, "REDACT_DROP");
  assert.strictEqual(r.reason, "otp_pattern");
}
ok("Stage-0 emits REDACT_DROP/otp_pattern on the new bare-digit shape");

// ===========================================================================
// F-T2-MAIL-F4 — MARKETING_PLATFORM_RE expansion + DKIM d= /
// Authentication-Results d= signal usage.
// ===========================================================================
console.log("# F-T2-MAIL-F4 — marketing-platform domain expansion");

// New ESPs from the expanded list.
for (const espDomain of [
  "klaviyomail.com",
  "customeriomail.com",
  "postmarkapp.com",
  "mailgun.net",
  "mailgun.com",
  "sendgrid.com",
  "iterable.com",
  "braze.com",
  "constantcontact.com",
  "cmail19.com",
  "mailerlite.com",
  "resend.com",
  "loops.so",
  "brevo.com",
  "sendinblue.com",
]) {
  const r = mailStage0({
    source: "mail",
    raw_content: {
      headers: { "return-path": `<bounces@${espDomain}>` },
      text: "newsletter body of substantial length to ensure structural threshold is moot",
    },
  });
  assert.strictEqual(r.decision, "DROP", `domain=${espDomain}`);
  assert.strictEqual(r.reason, "marketing_platform", `domain=${espDomain}`);
}
ok("Expanded ESP list (klaviyo / customer.io / postmark / mailgun.* / ...) → marketing_platform DROP");

// DKIM d= signal alone (no Return-Path match).
{
  const r = mailStage0({
    source: "mail",
    raw_content: {
      headers: { "return-path": "<bounces@customer.com>" },
      dkim_d_domain: "sendgrid.net",
      text: "newsletter body content with no marketing return-path",
    },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "marketing_platform");
}
ok("DKIM d= signal fires marketing_platform even when Return-Path is benign");

// Authentication-Results d= signal alone.
{
  const r = mailStage0({
    source: "mail",
    raw_content: {
      headers: { "return-path": "<bounces@customer.com>" },
      auth_results_d_domain: "klaviyomail.com",
      text: "newsletter body content",
    },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "marketing_platform");
}
ok("Authentication-Results d= signal fires marketing_platform");

// Negative: regular customer.com domain in all three slots → PASS.
{
  const r = mailStage0({
    source: "mail",
    raw_content: {
      headers: { "return-path": "<reply@customer.com>" },
      dkim_d_domain: "customer.com",
      auth_results_d_domain: "customer.com",
      text: "personal email of substantial length not from an esp at all" + " x".repeat(160),
    },
  });
  assert.strictEqual(r.decision, "PASS");
}
ok("Non-ESP domain in all three signals → PASS");

// ===========================================================================
// F-T2-MAIL-F5 — Subject-anchored OOO / [SPAM] / [EXTERNAL] DROPs
// ===========================================================================
console.log("# F-T2-MAIL-F5 — subject-anchored DROP rules");

// SUBJECT_AUTOREPLY_RE hits.
for (const subj of [
  "Out of office until June 20",
  "OOO: back next week",
  "Auto-reply: thanks for your message",
  "Auto reply: out of office",
  "[Auto-reply] from Bob",
  "[Out of office] returning Monday",
  "Automatic reply: thanks",
  "Vacation responder enabled",
  "Away from office",
  "I am currently out of office",
  "Re: Auto-reply: still away",
  "Fwd: out of office",
]) {
  const r = mailStage0({
    source: "mail",
    raw_content: {
      headers: { subject: subj },
      text: "I will return June 20",
    },
  });
  assert.strictEqual(r.decision, "DROP", `subject=${subj}`);
  assert.strictEqual(r.reason, "subject_autoreply", `subject=${subj}`);
}
ok("SUBJECT_AUTOREPLY_RE fires on OOO / vacation / auto-reply shapes");

// SUBJECT_BRACKET_NOISE_RE hits.
for (const subj of [
  "[SPAM] cheap watches",
  "[EXTERNAL] from outside the org",
  "[Junk] phishing attempt",
  "[Bulk] promo blast",
  "[BOUNCED] delivery failure",
  "[Delivery Status] notification",
  "[Delivery Failure] could not deliver",
  "[Undeliverable] returned mail",
]) {
  const r = mailStage0({
    source: "mail",
    raw_content: {
      headers: { subject: subj },
      text: "body content goes here",
    },
  });
  assert.strictEqual(r.decision, "DROP", `subject=${subj}`);
  assert.strictEqual(r.reason, "subject_bracket_noise", `subject=${subj}`);
}
ok("SUBJECT_BRACKET_NOISE_RE fires on [SPAM] / [EXTERNAL] / [DELIVERY *] shapes");

// Negative: prose subjects that LOOK similar but don't open with the
// anchor must NOT fire.
for (const subj of [
  "Discussing out of office policies",
  "How to write an auto-reply",
  "What is OOO short for",
  "Email about a [SPAM] folder feature",
]) {
  const r = mailStage0({
    source: "mail",
    raw_content: {
      headers: { subject: subj },
      text: "discussing the topic in earnest with substantial prose " + "x".repeat(200),
    },
  });
  assert.notStrictEqual(r.reason, "subject_autoreply", `subject=${subj}`);
  assert.notStrictEqual(r.reason, "subject_bracket_noise", `subject=${subj}`);
}
ok("Prose subjects discussing OOO / [SPAM] do NOT fire (anchor at start)");

// Allowlist registration.
assert.ok(REASON_ALLOWLIST.has("subject_autoreply"));
assert.ok(REASON_ALLOWLIST.has("subject_bracket_noise"));
ok("subject_autoreply + subject_bracket_noise registered in REASON_ALLOWLIST");

// ===========================================================================
// F-T2-MAIL-F9 — text/calendar (.ics) fallback extraction
// ===========================================================================
console.log("# F-T2-MAIL-F9 — text/calendar (.ics) extraction");

// icsToText: standard REQUEST invite.
{
  const ics = [
    "BEGIN:VCALENDAR",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "SUMMARY:Team standup",
    "DTSTART:20260615T140000Z",
    "DTEND:20260615T143000Z",
    "LOCATION:Zoom Room A",
    "ORGANIZER;CN=Alice:mailto:alice@example.com",
    "DESCRIPTION:Weekly sync on the project",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const out = icsToText(ics);
  assert.ok(out.includes("Subject: Team standup"));
  assert.ok(out.includes("When: 20260615T140000Z"));
  assert.ok(out.includes("Where: Zoom Room A"));
  assert.ok(out.includes("From: alice@example.com"));
  assert.ok(out.includes("Description: Weekly sync"));
}
ok("icsToText extracts SUMMARY / DTSTART / LOCATION / ORGANIZER / DESCRIPTION");

// METHOD:CANCEL gets the [CANCELLED] prefix.
{
  const ics = [
    "BEGIN:VCALENDAR",
    "METHOD:CANCEL",
    "BEGIN:VEVENT",
    "SUMMARY:Cancelled meeting",
    "DTSTART:20260615T140000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const out = icsToText(ics);
  assert.ok(out.startsWith("[CANCELLED]"));
}
ok("METHOD:CANCEL → '[CANCELLED]' prefix");

// RFC 5545 line unfolding — a property value that wraps across multiple
// physical lines (CRLF + LWSP-char) is unfolded before extraction.
{
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "SUMMARY:Very long subject that spans",
    " across two physical lines via folding",
    "DTSTART:20260615T140000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const out = icsToText(ics);
  assert.ok(out.includes("Subject: Very long subject that spansacross two physical lines via folding"));
}
ok("RFC 5545 § 3.1 line unfolding works (continuation lines joined)");

// parseEmail falls back to text/calendar when no text/plain or text/html.
{
  const boundary = "calbnd";
  const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Project Sync\r\nDTSTART:20260615T140000Z\r\nLOCATION:Conf Room 3\r\nORGANIZER:mailto:bob@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const raw = [
    "From: Calendar <invites@example.com>",
    "To: alex@example.com",
    "Subject: Invitation: Project Sync",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/calendar; method=REQUEST; charset=utf-8",
    "",
    ics,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const parsed = parseEmail(Buffer.from(raw, "utf8"));
  assert.ok(parsed.hasCalendar);
  assert.ok(typeof parsed.text === "string" && parsed.text.includes("Subject: Project Sync"));
  assert.ok(parsed.text.includes("Where: Conf Room 3"));
}
ok("parseEmail synthesises body text from text/calendar when no plain/html");

// Stage-0 PASSes a calendar invite (now has substantive text rather than
// placeholder_residual).
{
  const calText = "Subject: Project Sync\nWhen: 20260615T140000Z\nWhere: Conf Room 3\nFrom: bob@example.com\nDescription: Discussing milestones for the project including detailed agenda items.";
  const r = mailStage0({
    source: "mail",
    raw_content: {
      headers: { subject: "Invitation: Project Sync" },
      text: calText,
      has_calendar: true,
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.notStrictEqual(r.reason, "placeholder_residual");
}
ok("Stage-0 PASSes a calendar invite with synthesised text (no longer placeholder_residual)");

// ===========================================================================
// A2 (memory-roots mail-admission-fix) — Rule 9 person-sender exemption.
// Apple stamps automated_conversation=2 on any conversation with no reply
// yet, so an unconditional Rule 9 dropped every human thread opener. The
// exemption (isPersonSenderExempt) lets first_party rows and person-shaped
// senders FALL THROUGH to 9a-11 + PASS; everything else keeps the exact
// DROP/apple_automated attribution. Flag OFF is exercised through the
// predicate's `enabled` option and a child process with the env
// kill-switch — CAPS is frozen and is never mutated here.
// ===========================================================================
console.log("# A2 — Rule 9 person-sender exemption");

const A2_PROSE =
  "Hi Alex, following up on the conversation we had at the open house " +
  "last week about the microfluidics work. I have written up the protocol " +
  "we discussed and would love to get your read on the two open questions " +
  "before I send it to the rest of the group. Are you free for a call this " +
  "Thursday or Friday afternoon? Happy to work around your schedule.";
assert.ok(A2_PROSE.length >= 200, "A2 prose fixture must clear the 200-char cliff");

// Event builder: automated_conversation=2 (the production opener shape),
// every list / noreply / ESP signal zeroed, so ONLY Rule 9 (and whatever
// the exemption falls through to) can decide the row.
function a2Event(headers, extra = {}) {
  return {
    source: "mail",
    raw_content: {
      text: A2_PROSE,
      headers: {
        subject: "Open house follow-up",
        ...headers,
      },
      unsubscribe_type: 0,
      list_id_hash: null,
      automated_conversation: 2,
      has_plain: true,
      has_html: false,
      body_resolved: true,
      mailbox_url: "imap://fixture-operator@mail.fixture-host.example/INBOX",
    },
    ...extra,
  };
}

const A2_EVENT_I = a2Event({
  from: "Sam Sample <sam@example.org>",
  "return-path": "<SRS0=x=y=example.org=sam@operator.example>",
});

// (i) unquoted person-shaped From + SRS0 Return-Path + >=200-char body → PASS.
{
  const r = mailStage0(A2_EVENT_I);
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, null);
  assert.strictEqual(typeof r.structural_score, "number");
}
ok("(i) ac=2 + person-shaped From + SRS0 Return-Path → PASS, reason null");

// (ii) first_party consent_basis + bare-address From → PASS (branch A).
{
  const r = mailStage0(
    a2Event({ from: "alex.example@example.org" }, {
      source_policy: { consent_basis: "first_party" },
    })
  );
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, null);
}
ok("(ii) ac=2 + consent_basis first_party + bare-address From → PASS");

// Bare-address From WITHOUT first_party is not person-shaped → DROP.
{
  const r = mailStage0(a2Event({ from: "alex.example@example.org" }));
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "apple_automated");
}
ok("bare-address From without first_party → DROP/apple_automated");

// (iii) role mailbox with a person-shaped-but-branded display name → DROP.
{
  const r = mailStage0(a2Event({
    from: "Example Receipts <receipts@pay.example>",
    "return-path": "<receipts@pay.example>",
  }));
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "apple_automated");
}
ok("(iii) ac=2 + `Example Receipts <receipts@…>` → DROP/apple_automated");

// (iv) quoted brand display name → DROP even though the words are
// person-shaped and Return-Path local == From local.
{
  const r = mailStage0(a2Event({
    from: "\"Example Airlines\" <onlineticket@mail.exampleair.example>",
    "return-path": "<onlineticket@mail.exampleair.example>",
  }));
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "apple_automated");
}
ok("(iv) ac=2 + quoted `\"Example Airlines\" <onlineticket@…>` → DROP/apple_automated");

// (iv-b) UNQUOTED brand token in a person-shaped name → DROP.
{
  const r = mailStage0(a2Event({
    from: "Example School <es@es.example>",
    "return-path": "<es@es.example>",
  }));
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "apple_automated");
}
ok("(iv-b) ac=2 + unquoted brand token `Example School <es@…>` → DROP/apple_automated");

// (iv-c) `no_reply` local-part (underscore form NOREPLY_RE at Rule 7 does
// not match) → DROP at Rule 9.
{
  const r = mailStage0(a2Event({
    from: "Apple Support <no_reply@email.apple.example>",
    "return-path": "<no_reply@email.apple.example>",
  }));
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "apple_automated");
}
ok("(iv-c) ac=2 + `Apple Support <no_reply@…>` → DROP/apple_automated");

// (v) person-shaped From but a VERP/bounce envelope → DROP.
{
  const r = mailStage0(a2Event({
    from: "Sam Sample <sam@example.org>",
    "return-path": "<bounces@esp.example>",
  }));
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "apple_automated");
}
ok("(v) person-shaped From + `return-path: <bounces@…>` → DROP/apple_automated");

// (vi) cascade order preserved: list-unsubscribe fires BEFORE Rule 9, so a
// person-shaped sender on a list still drops with list_unsubscribe.
{
  const r = mailStage0(a2Event({
    from: "Sam Sample <sam@example.org>",
    "return-path": "<sam@example.org>",
    "list-unsubscribe": "<mailto:unsub@example.org>",
  }));
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "list_unsubscribe");
}
ok("(vi) person-shaped + list-unsubscribe → DROP/list_unsubscribe (rules 0-8 still fire first)");

// (vii) fall-through preserved: an exempt row with an OTP body reaches
// Rule 10 and is REDACT_DROPped, not PASSed early.
{
  const ev = a2Event({
    from: "Sam Sample <sam@example.org>",
    "return-path": "<sam@example.org>",
  });
  ev.raw_content.text = "123456 is your verification code";
  const r = mailStage0(ev);
  assert.strictEqual(r.decision, "REDACT_DROP");
  assert.strictEqual(r.reason, "otp_pattern");
}
ok("(vii) person-shaped + OTP body → REDACT_DROP/otp_pattern (no early PASS)");

// (vii-b) fall-through preserved: exempt row with an empty body reaches
// Rule 11.
{
  const ev = a2Event({
    from: "Sam Sample <sam@example.org>",
    "return-path": "<sam@example.org>",
  });
  ev.raw_content.text = "";
  const r = mailStage0(ev);
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "placeholder_residual");
}
ok("(vii-b) person-shaped + empty body → DROP/placeholder_residual (Rule 11 still applies)");

// Predicate edge cases: matching Return-Path is case-insensitive; a
// missing Return-Path counts as empty; all-caps / one-word names are not
// person-shaped (ACMEXYZ stays dropped).
{
  assert.strictEqual(
    isPersonSenderExempt(a2Event({
      from: "Sam Sample <Sam@Example.org>",
      "return-path": "<sam@example.org>",
    })),
    true
  );
  assert.strictEqual(
    isPersonSenderExempt(a2Event({ from: "Sam Sample <sam@example.org>" })),
    true
  );
  assert.strictEqual(
    isPersonSenderExempt(a2Event({
      from: "ACMEXYZ <ops@acmexyz.example>",
      "return-path": "<ops@acmexyz.example>",
    })),
    false
  );
  assert.strictEqual(
    isPersonSenderExempt(a2Event({
      from: "Sam <sam@example.org>",
      "return-path": "<sam@example.org>",
    })),
    false
  );
  assert.strictEqual(
    isPersonSenderExempt(a2Event({
      from: "Zoë Ångström Példa <zoe.ap@example.org>",
      "return-path": "<zoe.ap@example.org>",
    })),
    true
  );
  // "No Reply" is two capitalised words with a non-role local-part and
  // Rule 7's NOREPLY_RE has no spaced form — the `reply` brand token is
  // what keeps it dropped (census leak, FINDINGS.md FA2-3).
  assert.strictEqual(
    isPersonSenderExempt(a2Event({
      from: "No Reply <user-0a1b2c3d@mailer.example>",
    })),
    false
  );
  assert.strictEqual(isPersonSenderExempt(null), false);
}
ok("predicate: case-insensitive envelope match, missing Return-Path ok, all-caps / one-word / `No Reply` / null rejected, Unicode names accepted");

// (viii) flag OFF: predicate option, CAPS default, and an end-to-end child
// process with the env kill-switch (CAPS is frozen; never mutated here).
{
  assert.strictEqual(isPersonSenderExempt(A2_EVENT_I, { enabled: false }), false);
  assert.strictEqual(isPersonSenderExempt(A2_EVENT_I, { enabled: true }), true);
  assert.strictEqual(CAPS.MAIL_STAGE0_PERSON_SENDER_EXEMPT_ENABLED, true);
  assert.ok(Object.isFrozen(CAPS));

  const mailJsPath = fileURLToPath(
    new URL("../../lib/ingest/stage0/mail.js", import.meta.url)
  );
  const childScript =
    `const ev = ${JSON.stringify(A2_EVENT_I)};` +
    `import(${JSON.stringify(mailJsPath)}).then((m) => {` +
    `  const r = m.stage0(ev);` +
    `  process.stdout.write(JSON.stringify({ r, flag: m.isPersonSenderExempt(ev) }));` +
    `});`;
  const out = execFileSync(process.execPath, ["-e", childScript], {
    env: { ...process.env, MEMORY_MAIL_STAGE0_PERSON_SENDER_EXEMPT_ENABLED: "0" },
    encoding: "utf8",
  });
  const child = JSON.parse(out);
  assert.strictEqual(child.flag, false);
  assert.strictEqual(child.r.decision, "DROP");
  assert.strictEqual(child.r.reason, "apple_automated");
}
ok("(viii) flag OFF → predicate false; env kill-switch child DROPs event (i) at Rule 9 end-to-end; CAPS default true and frozen");

// ===========================================================================
// HERMETIC_POST_CHECK — A10 hermetic-stage0-tests (memory-roots).
// (1) Positive proof: the 43 quarantine rows this suite produces exist in
//     the scratch, so the pin is proven effective rather than assumed.
// (2) Live tripwire: nothing fixture-marked was appended to the live sinks
//     (see the snapshot block at the top for why size identity is not used).
// ===========================================================================
console.log("# HERMETIC_POST_CHECK — A10 hermetic-stage0-tests");
{
  assert.ok(
    process.env.QUARANTINE_BASE_DIR.startsWith(TMP_ROOT) &&
      process.env.STORAGE_BASE_DIR.startsWith(TMP_ROOT) &&
      process.env.MEMORY_ROOT === TMP_ROOT,
    "env pin must point at the scratch root"
  );
  const mailDir = join(TMP_ROOT, "quarantine", "mail");
  const files = readdirSync(mailDir).sort();
  const todayNow = `${new Date().toISOString().slice(0, 10)}.jsonl`;
  assert.ok(
    files.includes(todayNow) || files.includes(`${UTC_DAY}.jsonl`),
    `scratch quarantine/mail must hold today's jsonl, got ${JSON.stringify(files)}`
  );
  let lines = 0;
  for (const f of files) {
    const rows = readFileSync(join(mailDir, f), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    lines += rows.length;
    for (const l of rows) assert.strictEqual(JSON.parse(l).source, "mail");
  }
  assert.strictEqual(
    lines,
    43,
    `expected exactly 43 scratch quarantine rows (17 marketing_platform + 12 subject_autoreply + 8 subject_bracket_noise + 6 operator_junk_folder), got ${lines}`
  );
}
ok("HERMETIC_POST_CHECK positive proof: 43 rows landed in <scratch>/quarantine/mail/<utc-day>.jsonl, env pinned to the scratch root");
{
  const leaks = liveSinkLeaks();
  assert.deepStrictEqual(
    leaks,
    [],
    `fixture-marked bytes reached a live sink: ${JSON.stringify(leaks)}`
  );
  for (const [p, before] of LIVE_SIZES_BEFORE) {
    console.log(`    live sink ${p}: ${before} -> ${sizeOf(p)} bytes`);
  }
}
ok("HERMETIC_POST_CHECK live tripwire: no fixture-marked bytes appended to the live quarantine/telemetry sinks during this run");

// ===========================================================================
// Done.
// ===========================================================================
console.log(`\nPASS ${passed} assertions`);
