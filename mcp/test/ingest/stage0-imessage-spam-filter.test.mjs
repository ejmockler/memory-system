// stage0-imessage-spam-filter.test.mjs — WU-A4-IMESSAGE-STAGE0-SPAM-FILTER
//
// Per-pattern unit tests for the iMessage Stage-0 spam-filter rules
// introduced by WU-A4 to close the audit gap where promotional /
// scheduling SMS, scam transfer / prize-claim SMS, issuer-prefixed
// inverted OTPs ("Example Bank: NNNNNN is your verification code"),
// and URL-only messages were either promoting past Stage-0 entirely or
// landing at the default substantive_prose structural score.
//
// HERMETIC: synthetic event objects only; no real chat.db reads, no
// filesystem touches. Stage-0 modules are pure functions of the event
// envelope + CAPS, so the test surface is the decision-table itself.
//
// REASON-ALLOWLIST ASSURANCE: each new reason key is asserted present in
// telemetry.REASON_ALLOWLIST so a future allowlist regression cannot
// silently bucket the WU-A4 buckets into "invalid_reason".
//
// FIXTURES: every spam-pattern fixture is SYNTHETIC — invented text that
// keeps the structural triggers of each template family (a recurring
// mobile-service scheduling template, an issuer-prefixed OTP, a "We have
// just deposited" scam, a news-link URL-only body). No vendor, sender
// number or link in this file belongs to a real account. Negative-case
// fixtures cover ordinary family conversation, operator-authored
// exemptions, and plausibly-promotional but actually-personal prose so
// the FP gate stays visible.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// HERMETICITY: the quarantine writer and the Stage-0 telemetry sink resolve
// their paths through config.js at load, so MEMORY_ROOT points at a fresh temp
// root BEFORE the first library import — the suite never writes
// storage/quarantine or storage/telemetry into the install it runs in.
const TEST_ROOT = mkdtempSync(join(tmpdir(), "memsys-imessage-spam-filter-"));
process.env.MEMORY_ROOT = TEST_ROOT;
// Synthetic operator identity, resolved once at operator-identity.js load, so
// it is set before the first library import.
process.env.MEMORY_OPERATOR_IDENTITY_FILE = fileURLToPath(
  new URL("../fixtures/operator-identity.synthetic.json", import.meta.url),
);
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

const { stage0: imessageStage0, _WU_A4_IMESSAGE } = await import("../../lib/ingest/stage0/imessage.js");
const { stage0Dispatch } = await import("../../lib/ingest/stage0/index.js");
const { REASON_ALLOWLIST } = await import("../../lib/ingest/stage0/telemetry.js");

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  ok ${msg}`);
}

// ---------------------------------------------------------------------------
// 0. Test-handle plumbing + REASON_ALLOWLIST registration.
// ---------------------------------------------------------------------------
console.log("# WU-A4-IMESSAGE-STAGE0-SPAM-FILTER — test handle + telemetry");

assert.ok(_WU_A4_IMESSAGE && typeof _WU_A4_IMESSAGE === "object",
  "_WU_A4_IMESSAGE test handle must be exported");
ok("imessage.js exports _WU_A4_IMESSAGE handle");

assert.strictEqual(_WU_A4_IMESSAGE.REASON_PROMOTIONAL_SMS, "imessage_promotional_sms");
assert.strictEqual(_WU_A4_IMESSAGE.REASON_SCAM_SMS, "imessage_scam_sms");
assert.strictEqual(_WU_A4_IMESSAGE.REASON_URL_ONLY, "imessage_url_only");
assert.strictEqual(_WU_A4_IMESSAGE.URL_ONLY_STRUCTURAL_SCORE, 0.35);
ok("_WU_A4_IMESSAGE reason constants + URL_ONLY_STRUCTURAL_SCORE pinned");

// REASON_ALLOWLIST coverage — without these the dispatcher would bucket
// the counters into "invalid_reason" and emit a one-shot stderr warning.
assert.ok(REASON_ALLOWLIST.has("imessage_promotional_sms"),
  "REASON_ALLOWLIST must include imessage_promotional_sms");
assert.ok(REASON_ALLOWLIST.has("imessage_scam_sms"),
  "REASON_ALLOWLIST must include imessage_scam_sms");
assert.ok(REASON_ALLOWLIST.has("imessage_url_only"),
  "REASON_ALLOWLIST must include imessage_url_only");
ok("REASON_ALLOWLIST registers all three WU-A4 reason buckets");

// ---------------------------------------------------------------------------
// 1. Promotional / scheduling SMS — recurring mobile-service template (synthetic).
// ---------------------------------------------------------------------------
console.log("# Rule 5c — promotional / scheduling SMS DROP");

{
  // Synthetic fixture: the recurring mobile-service scheduling template
  // shape that promoted past Stage-0 at the default substantive_prose
  // score. Long-number sender. DROP via quarantine, reason
  // imessage_promotional_sms.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "Hi Alex - Acme Wash will be in your area from 6pm-9pm tonight. Please reply 'Y' by 4pm to confirm.",
      handle_id: "+15555550123",
    },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "imessage_promotional_sms");
}
ok("synthetic mobile-service template (long handle) → DROP imessage_promotional_sms");

{
  // Same template but from a shortcode sender — must still DROP under
  // imessage_promotional_sms, NOT under imessage_shortcode_redacted_kept.
  // This is the audit-finding behaviour: the early-fire promotional
  // guard runs BEFORE the shortcode-only PASS path.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "Hi Alex - Acme Wash will be in your area from 6pm-9pm tonight. Please reply 'Y' by 4pm to confirm.",
      handle_id: "55512",
    },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "imessage_promotional_sms");
}
ok("mobile-service template (shortcode handle) → DROP imessage_promotional_sms (early-fire wins over shortcode PASS)");

{
  // Scheduling-template variant: "your scheduled pickup" + "to confirm".
  // Different brand, same shape; both halves of the 2-of-2 gate hit.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "Hi Alex - your scheduled pickup is tomorrow at 10am. Reply YES to confirm or NO to reschedule.",
      handle_id: "+15555550100",
    },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "imessage_promotional_sms");
}
ok("scheduling-template variant ('your scheduled pickup' + 'reply YES to confirm') → DROP imessage_promotional_sms");

// ---------------------------------------------------------------------------
// 1b. Promotional DROP — operator-authored exemption.
// ---------------------------------------------------------------------------
{
  // Operator running a small business may DRAFT a promotional reply.
  // is_from_me=true exempts the row so outbound promotional drafts
  // stay in the ledger. PASS (default substantive_prose score), reason
  // null — falls through to the terminal PASS path.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "Hi Jordan - book your spring tune-up visit this week and the travel fee is waived. Reply YES to confirm.",
      handle_id: "+15555550101",
      is_from_me: true,
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.notStrictEqual(r.reason, "imessage_promotional_sms");
}
ok("operator-authored promotional-shape (is_from_me=true) → PASS (operator-business exemption)");

{
  // is_from_me=1 (chat.db numeric sentinel form) takes the same exemption.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "Hi Alex - your scheduled pickup is ready. Please reply Y to confirm.",
      handle_id: "+15555550101",
      is_from_me: 1,
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.notStrictEqual(r.reason, "imessage_promotional_sms");
}
ok("operator-authored promotional-shape (is_from_me=1 numeric) → PASS (operator-business exemption)");

// ---------------------------------------------------------------------------
// 2. Scam transfer / prize SMS — single-hit regex.
// ---------------------------------------------------------------------------
console.log("# Rule 5d — scam transfer / prize SMS DROP");

{
  // Synthetic fixture: the "we just deposited <amount>" opening.
  // Wire-transfer scam preamble.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "Notice: we just deposited a refund of 320 into the wallet linked to this number. Open https://pay.example.com to release the funds.",
      handle_id: "+15551234567",
    },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "imessage_scam_sms");
}
ok("synthetic 'we just deposited <amount>' preamble → DROP imessage_scam_sms");

{
  // Prize-claim sibling pattern from the WU prompt.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "You have won! Claim your prize at https://example.com/claim",
      handle_id: "+15551234567",
    },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "imessage_scam_sms");
}
ok("'you have won' + 'claim your prize' → DROP imessage_scam_sms");

{
  // Sweepstakes "you've been selected" variant (apostrophe form).
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "Congratulations! You've been selected for a $500 reward. Click to claim.",
      handle_id: "+15551234567",
    },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "imessage_scam_sms");
}
ok("'congratulations you've been selected' → DROP imessage_scam_sms");

{
  // Operator-authored scam quote (forwarded to a friend with commentary)
  // must PASS — is_from_me exemption applies to scam DROP too.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "look at this scammer: 'we have just deposited 1000 to your account'",
      handle_id: "+15551234567",
      is_from_me: 1,
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.notStrictEqual(r.reason, "imessage_scam_sms");
}
ok("operator-authored scam quote (is_from_me=1) → PASS (operator-quote exemption)");

// ---------------------------------------------------------------------------
// 3. Issuer-prefixed inverted OTP — promotes LOOSE to STRICT.
// ---------------------------------------------------------------------------
console.log("# Rule 4 extension — issuer-prefixed inverted OTP");

{
  // Synthetic fixture: the issuer-prefixed OTP form.
  // The shipped INVERTED_OTP_ANCHOR_RE is anchored at start-of-string so
  // the "Example Bank: " prefix breaks it; the shipped MODERN_OTP_REGEX
  // catches the digit block but routes to LOOSE (non-shortcode). WU-A4
  // promotes this to STRICT (REDACT_DROP + quarantine) via the new
  // ISSUER_PREFIXED_INVERTED_OTP_RE anchor.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "Example Bank: 305718 is your verification code.",
      handle_id: "+15551234567",
    },
  });
  assert.strictEqual(r.decision, "REDACT_DROP");
  assert.strictEqual(r.reason, "imessage_otp_strict");
}
ok("synthetic 'Example Bank: NNNNNN is your verification code' (long handle) → REDACT_DROP imessage_otp_strict (issuer-prefix anchor promotes LOOSE→STRICT)");

{
  // Generic issuer-prefixed inverted form — confirmation code.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "Acme Exchange: 192847 is your confirmation code. Do not share.",
      handle_id: "+15551234567",
    },
  });
  assert.strictEqual(r.decision, "REDACT_DROP");
  assert.strictEqual(r.reason, "imessage_otp_strict");
}
ok("'<issuer>: NNNNNN is your confirmation code' (non-shortcode) → REDACT_DROP imessage_otp_strict");

{
  // Operator-authored issuer-prefixed OTP (debug / quote) → LOOSE PASS,
  // not REDACT_DROP. is_from_me exemption preserves outbound dev prose.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "Example Bank: 305718 is your verification code.",
      handle_id: "+15551234567",
      is_from_me: 1,
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, "imessage_otp_redacted_kept");
}
ok("operator-authored issuer-prefixed OTP (is_from_me=1) → LOOSE PASS imessage_otp_redacted_kept (operator exemption)");

// ---------------------------------------------------------------------------
// 4. URL-only PASS at downgraded structural score.
// ---------------------------------------------------------------------------
console.log("# Rule 5e — URL-only PASS at structural_score=0.35");

{
  // Synthetic fixture: a URL-only news-link forward. Keep as fact (the
  // operator shared it) but downgrade.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "https://news.example.com/a/Zx81QkLm20PqRtUvW3y",
      handle_id: "+15551234567",
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, "imessage_url_only");
  assert.strictEqual(r.structural_score, 0.35);
}
ok("synthetic 'https://news.example.com/…' (URL-only body) → PASS imessage_url_only @ 0.35");

{
  // Whitespace-padded URL-only — still URL-only.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "   https://www.youtube.com/watch?v=abc123XYZ   ",
      handle_id: "+15555550100",
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, "imessage_url_only");
  assert.strictEqual(r.structural_score, 0.35);
}
ok("URL surrounded by whitespace → PASS imessage_url_only @ 0.35 (whitespace-trim)");

{
  // URL + conversational prose is NOT URL-only — must take the terminal
  // PASS at default substantive_prose, NOT the 0.35 downgrade. The
  // anchored ^…$ regex enforces the SINGLE-URL invariant.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "look at this article: https://example.com/foo isn't it cool",
      handle_id: "+15551234567",
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.notStrictEqual(r.reason, "imessage_url_only");
}
ok("URL + conversational prose → PASS terminal (NOT url_only — anchored regex enforces SINGLE-URL invariant)");

{
  // Two URLs on the same line is NOT URL-only (the URL_ONLY_RE
  // permits no whitespace inside the URL or trailing content).
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "https://a.example.com https://b.example.com",
      handle_id: "+15551234567",
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.notStrictEqual(r.reason, "imessage_url_only");
}
ok("two URLs space-separated → PASS terminal (not url_only — SINGLE-URL invariant)");

// ---------------------------------------------------------------------------
// 5. Negative tests — ordinary family conversation must NOT be dropped.
// ---------------------------------------------------------------------------
console.log("# Negative cases — ordinary family conversation must NOT DROP");

{
  // Casual greeting + reply verb (no promotional opener phrase, no time
  // window, no "will be in your area" preamble). Only one half of the
  // promotional 2-of-2 gate would even consider firing. Must PASS.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "hi mom, please reply by 5pm if you need anything from the store",
      handle_id: "+15551234567",
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.notStrictEqual(r.reason, "imessage_promotional_sms");
  assert.notStrictEqual(r.reason, "imessage_scam_sms");
}
ok("'hi mom, please reply by 5pm if you need anything' → PASS (no promotional opener)");

{
  // Ordinary family message — "are you coming to dinner tonight". No spam
  // patterns at all; substantive prose.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "are you coming to dinner tonight? grandma is making lasagna",
      handle_id: "+15551234567",
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, null);
  assert.ok(r.structural_score >= 0.7, `expected substantive_prose band, got ${r.structural_score}`);
}
ok("'are you coming to dinner tonight' → PASS terminal (substantive_prose, NOT spam-bucketed)");

{
  // Short affectionate message — must NOT trigger any spam pattern.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "love you sweetie",
      handle_id: "+15551234567",
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, null);
}
ok("'love you sweetie' → PASS terminal (no spam false-positive)");

{
  // "Hi <name>" alone without a reply directive must NOT DROP — the
  // 2-of-2 conjunctive gate guards against this false-positive.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "Hi Alex what's up I haven't heard from you in a while",
      handle_id: "+15551234567",
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.notStrictEqual(r.reason, "imessage_promotional_sms");
}
ok("'Hi Alex what's up' (greeting only, no directive) → PASS (2-of-2 conjunctive gate guards FP)");

{
  // Casual message containing "deposited" but NOT in the scam preamble
  // shape. "I deposited the check today" must NOT match SCAM_SMS_RE
  // (which requires "we (have )?just deposited" specifically).
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "I deposited the check today, should clear by Friday",
      handle_id: "+15551234567",
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.notStrictEqual(r.reason, "imessage_scam_sms");
}
ok("'I deposited the check today' → PASS (no 'we just deposited' preamble — no scam FP)");

// ---------------------------------------------------------------------------
// 6. Dispatcher round-trip — full Stage-0 cascade visibility.
// ---------------------------------------------------------------------------
console.log("# Dispatcher round-trip");

{
  // The dispatcher must echo the per-source reasons cleanly (no
  // bucket-into-invalid_reason). source field is stamped on the result.
  const r = stage0Dispatch({
    source: "imessage",
    raw_content: {
      text: "Hi Alex - Acme Wash will be in your area from 6pm-9pm tonight. Please reply 'Y' by 4pm to confirm.",
      handle_id: "+15555550123",
    },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "imessage_promotional_sms");
  assert.strictEqual(r.source, "imessage");
}
ok("dispatcher round-trip: promotional DROP → reason imessage_promotional_sms, source echoed");

{
  const r = stage0Dispatch({
    source: "imessage",
    raw_content: {
      text: "https://news.example.com/a/Zx81QkLm20PqRtUvW3y",
      handle_id: "+15551234567",
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, "imessage_url_only");
  assert.strictEqual(r.structural_score, 0.35);
  assert.strictEqual(r.source, "imessage");
}
ok("dispatcher round-trip: URL-only PASS → reason imessage_url_only @ 0.35, source echoed");

console.log(`\nPASS ${passed} assertions`);
