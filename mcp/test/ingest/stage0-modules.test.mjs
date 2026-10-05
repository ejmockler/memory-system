// stage0-modules.test.mjs — unit tests for the four R25 Stage-0 modules
// (mcp/lib/ingest/stage0/{imessage,screentime,gitlog,githubevents}.js) +
// the dispatcher (mcp/lib/ingest/stage0/index.js).
//
// HERMETIC: synthetic event objects only; no real chat.db / knowledgeC.db
// reads. Each module is a pure function of the event payload + CAPS, so the
// test surface is the decision-table itself — but DROP arms quarantine and
// the dispatcher records telemetry, so the suite DOES write; those writes go
// to a mkdtemp scratch (HERMETIC_TMP below), never under storage/.
//
// One assertion per branch of each module's decision tree + dispatcher
// round-trip + structural-score hint plumbing.

import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join as pathJoin } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

// --- HERMETIC_POST_CHECK live-sink tripwire: snapshot BEFORE the env pin ----
// Same shape as test/ingest/stage0-mail-rules.test.mjs. Two candidate live
// sinks: (a) the storage/ tree next to this checkout (what nodes/A10.md's
// Verify stats), and (b) whatever lib/config.js WOULD resolve from the
// caller's environment before we pin it — by default the default MEMORY_ROOT storage,
// the LIVE store even when this file runs from a worktree with no storage/.
// Raw size / mtime identity is deliberately NOT the gate: the mail connector
// and telemetry flushes append to these files concurrently (cf.
// test/_hermetic-daemon-skip.mjs header), so equality would be flaky under
// run-all-tests REQUIRE_HERMETIC=1. The gate is "grew AND the appended bytes
// carry a fixture-unique marker" — `fake-source-no-module` is a source name
// that exists only in this file.
const UTC_DAY = new Date().toISOString().slice(0, 10);
const REPO_STORAGE = pathJoin(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "storage"
);
const CALLER_STORAGE =
  process.env.STORAGE_BASE_DIR ||
  pathJoin(process.env.MEMORY_ROOT || pathJoin(homedir(), "memory-system"), "storage");
const CALLER_QUARANTINE =
  process.env.QUARANTINE_BASE_DIR || pathJoin(CALLER_STORAGE, "quarantine");
const LIVE_SINKS = [
  ...new Set([
    pathJoin(REPO_STORAGE, "quarantine", "mail", `${UTC_DAY}.jsonl`),
    pathJoin(CALLER_QUARANTINE, "mail", `${UTC_DAY}.jsonl`),
    pathJoin(REPO_STORAGE, "telemetry", `stage0_counters_${UTC_DAY}.jsonl`),
    pathJoin(CALLER_STORAGE, "telemetry", `stage0_counters_${UTC_DAY}.jsonl`),
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
const FIXTURE_MARKERS = Object.freeze(["fake-source-no-module"]);
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

// F-E6-CODEX-PROCESS-NARRATION — TEST HYGIENE, file scope.
//
// Several arms of this suite (imessage, git-log, github-events and — as of
// F-E6 — codex-cli) call stage0() on rows that DROP, and every DROP routes
// through quarantineScaffoldRow → quarantineRow. quarantineBaseDir() in
// lib/ingest/quarantine.js resolves process.env.QUARANTINE_BASE_DIR at CALL
// time, so redirecting it here — before any assertion runs — is sufficient
// to keep the suite off the live storage/quarantine/ tree however it is
// invoked. Measured before this redirect existed: a bare run of this file
// appended 4,168 bytes to storage/quarantine/codex-cli/<today>.jsonl.
//
// A10 (memory-roots hermetic-stage0-tests) — the former "KNOWN RESIDUAL"
// (telemetry.js binds STORAGE_DIR from lib/config.js at IMPORT time, so a
// bare run appended one `fake-source-no-module` snapshot row per run to
// storage/telemetry/stage0_counters_<today>.jsonl; 13 such rows on
// 2026-09-15 before this fix) is CLOSED BY IMPORT ORDERING: this env block
// now runs first, all three roots are pinned to HERMETIC_TMP, and every
// ../../lib import below is a dynamic `await import(...)` (top-level await,
// cf. test/ingest/salience-cascade.test.mjs:45-46) so lib/config.js
// (MEMORY_ROOT / STORAGE_DIR at :34 / :40) and telemetry.js (:63) evaluate
// with the scratch root. The HERMETIC_POST_CHECK at the tail proves it.
const HERMETIC_TMP = mkdtempSync(pathJoin(tmpdir(), "stage0-modules-"));
process.env.MEMORY_ROOT = HERMETIC_TMP;
process.env.STORAGE_BASE_DIR = pathJoin(HERMETIC_TMP, "storage");
process.env.QUARANTINE_BASE_DIR = pathJoin(HERMETIC_TMP, "quarantine");
// Operator identity: resolved ONCE at module load by
// lib/identity/operator-identity.js, so the synthetic identity file must be
// pinned here, before the first lib import. No operator value is hardcoded
// in this suite — the fixture is the single source.
const SYNTHETIC_IDENTITY_FILE = pathJoin(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "operator-identity.synthetic.json"
);
process.env.MEMORY_OPERATOR_IDENTITY_FILE = SYNTHETIC_IDENTITY_FILE;
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
    rmSync(HERMETIC_TMP, { recursive: true, force: true });
  } catch {
    /* best-effort scratch cleanup */
  }
});

// Dynamic imports — AFTER the pin (see the A10 note above).
const { stage0: imessageStage0 } = await import("../../lib/ingest/stage0/imessage.js");
const { stage0: screentimeStage0 } = await import("../../lib/ingest/stage0/screentime.js");
const { stage0: gitlogStage0 } = await import("../../lib/ingest/stage0/gitlog.js");
const { stage0: githubeventsStage0, _operatorOwnedGhNamespacesForTest } = await import(
  "../../lib/ingest/stage0/githubevents.js"
);
const { stage0: whatsappStage0 } = await import("../../lib/ingest/stage0/whatsapp.js");
// R28 Phase 2a / R28.1 — agent-runtime hook stage0 modules (codex-cli only).
// F-E6-CODEX-PROCESS-NARRATION — the widened Tier-1 alternation, its tighter
// cap, and the Tier-2 next-action shape are asserted directly so the length
// cliff and the `^` anchor are pinned by symbol rather than by example alone.
const { stage0: codexCliStage0, _internals: codexCliInternals } = await import(
  "../../lib/ingest/stage0/codex-cli.js"
);
const { stage0Dispatch, listSources, getStructuralRules } = await import(
  "../../lib/ingest/stage0/index.js"
);
const { CAPS } = await import("../../lib/validation.js");
const { currentSinkPath, flushCounters } = await import(
  "../../lib/ingest/stage0/telemetry.js"
);

let passed = 0;
function ok(msg) { passed++; console.log(`  ok ${msg}`); }

// ---------------------------------------------------------------------------
// CAPS additions present.
// ---------------------------------------------------------------------------
console.log("# CAPS — salience layer-1 additions");
assert.ok(typeof CAPS.SALIENCE_OTP_REGEX === "string" && CAPS.SALIENCE_OTP_REGEX.length > 10);
ok("CAPS.SALIENCE_OTP_REGEX is a non-trivial string");
assert.ok(typeof CAPS.SALIENCE_BOT_AUTHOR_REGEX_GIT === "string");
ok("CAPS.SALIENCE_BOT_AUTHOR_REGEX_GIT is a string");
assert.ok(typeof CAPS.SALIENCE_BOT_AUTHOR_REGEX_GH === "string");
ok("CAPS.SALIENCE_BOT_AUTHOR_REGEX_GH is a string");
assert.ok(CAPS.SALIENCE_STRUCTURAL_RULES && typeof CAPS.SALIENCE_STRUCTURAL_RULES === "object");
ok("CAPS.SALIENCE_STRUCTURAL_RULES is a populated object");
for (const src of ["imessage", "screentime", "git-log", "github-events",
                   "codex-cli", "telegram"]) {
  // R39 Phase 3 (mail, whatsapp): structural rules live in the per-source
  // stage0 module rather than CAPS, so they are NOT in this CAPS-presence
  // check. R38 Phase 2c added telegram to CAPS but slack uses module-local
  // rules. The omitted entries are still covered by getStructuralRules in
  // the listSources assertion below.
  assert.ok(CAPS.SALIENCE_STRUCTURAL_RULES[src], `missing rules for ${src}`);
  ok(`SALIENCE_STRUCTURAL_RULES has ${src}`);
}
// Hard-zero invariants for Stage-0 droppers.
assert.strictEqual(CAPS.SALIENCE_STRUCTURAL_RULES.imessage.otp_pattern, 0.0);
assert.strictEqual(CAPS.SALIENCE_STRUCTURAL_RULES.imessage.placeholder_residual, 0.0);
assert.strictEqual(CAPS.SALIENCE_STRUCTURAL_RULES["git-log"].bot_commit, 0.0);
assert.strictEqual(CAPS.SALIENCE_STRUCTURAL_RULES["github-events"].low_signal_event, 0.0);
ok("Stage-0 dropper rules carry structural_score = 0.0 sentinel");

// ---------------------------------------------------------------------------
// imessage.js
// ---------------------------------------------------------------------------
console.log("# stage0/imessage.js");

// 1. tapback — F-T1-IMESSAGE (critic-modified): only DROP true binary
// icons [2000, 2004]. 2005-2007 carry quoted prose per R22 decoder and
// MUST fall through to PASS, not DROP at Stage-0.
{
  const ev = { source: "imessage", raw_content: { text: "❤️", associated_message_type: 2000 } };
  const r = imessageStage0(ev);
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "tapback");
}
ok("associated_message_type=2000 → DROP tapback");
{
  // F-T1-IMESSAGE (critic-modified): 2004 is now the upper DROP bound;
  // [2005, 2007] are quoted-prose carriers and fall through to PASS.
  const r = imessageStage0({ source: "imessage", raw_content: { text: "x", associated_message_type: 2004 } });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "tapback");
}
ok("associated_message_type=2004 (new upper bound) → DROP tapback");
{
  // 2005-2007 carry quoted prose — must NOT be DROPped at Stage-0 anymore.
  const r = imessageStage0({ source: "imessage", raw_content: { text: "hello there long enough sentence to pass", associated_message_type: 2005, handle_id: "+15551234567" } });
  assert.strictEqual(r.decision, "PASS");
}
ok("associated_message_type=2005 (quoted prose) → PASS (NOT dropped)");
{
  const r = imessageStage0({ source: "imessage", raw_content: { text: "hello there friend", associated_message_type: 0 } });
  assert.strictEqual(r.decision, "PASS");
}
ok("associated_message_type=0 is NOT tapback");

// 2. business handle
{
  const r = imessageStage0({
    source: "imessage",
    raw_content: { text: "Hello from Apple's automated assistant.", handle_id: "urn:biz:00000000-0000-4000-8000-0000000000a1" },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "business_handle");
}
ok("handle_id starting with 'urn:biz:' → DROP business_handle");
{
  const r = imessageStage0({ source: "imessage", raw_content: { text: "code stuff", handle_id: "BIZ:42" } });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "business_handle");
}
ok("handle_id starting with 'BIZ:' → DROP business_handle");

// 3. OTP / verification code — F-T1-IMESSAGE-F1 (critic-modified): the
// flat "otp_pattern" reason is replaced with a STRICT/LOOSE split.
// STRICT path → REDACT_DROP + reason "imessage_otp_strict" + quarantine
// for 30d. LOOSE path → PASS + reason "imessage_otp_redacted_kept" with
// the digit block scrubbed in place.
{
  const r = imessageStage0({ source: "imessage", raw_content: { text: "Your OKX verification code is: 135790", handle_id: "+15551234567" } });
  assert.strictEqual(r.decision, "REDACT_DROP");
  assert.strictEqual(r.reason, "imessage_otp_strict");
}
ok("'OKX verification code is: NNNN' → REDACT_DROP imessage_otp_strict (STRICT anchor)");
{
  // 'Coinbase code: 192847' — generic issuer code-colon-number form. The
  // STRICT anchor regex covers issuer + (code|:) + digits.
  const r = imessageStage0({ source: "imessage", raw_content: { text: "Coinbase code: 192847. Don't share this.", handle_id: "Coinbase" } });
  assert.strictEqual(r.decision, "REDACT_DROP");
  assert.strictEqual(r.reason, "imessage_otp_strict");
}
ok("'Coinbase code: 192847' → REDACT_DROP imessage_otp_strict");
{
  // 'Your Stripe code is 938210' — STRICT issuer + code + anchor + digits.
  const r = imessageStage0({ source: "imessage", raw_content: { text: "Your Stripe code is 938210 for login", handle_id: "+15551234567" } });
  assert.strictEqual(r.decision, "REDACT_DROP");
  assert.strictEqual(r.reason, "imessage_otp_strict");
}
ok("'Your Stripe code is 938210' → REDACT_DROP imessage_otp_strict (STRICT)");
{
  // Non-OTP benign text — must PASS (no false-positive on 'your … code').
  const r = imessageStage0({ source: "imessage", raw_content: { text: "Hey, your dinner is ready at 6pm.", handle_id: "+15551234567" } });
  assert.strictEqual(r.decision, "PASS");
}
ok("benign text resembling 'your … code' but no digits → PASS");
{
  // LOOSE path: classifyA2P matches OTP regex (low confidence, no
  // shortcode), but text lacks the canonical "code <anchor> N" form so
  // STRICT_OTP_ANCHOR_RE misses → REDACT-and-PASS, keep row.
  const r = imessageStage0({ source: "imessage", raw_content: { text: "btw 938210 is your security code from the test rig", handle_id: "+15551234567" } });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, "imessage_otp_redacted_kept");
}
ok("LOOSE OTP (non-shortcode, no strict anchor) → PASS imessage_otp_redacted_kept");

// 3a-EXEMPT. F-NEW-W1-IMESSAGE-OTP-OPERATOR-EXEMPT — operator-authored
// (is_from_me=true) messages that LOOK like canonical OTPs are the operator
// DISCUSSING / debugging / quoting OTPs, not RECEIVING them. The STRICT
// REDACT_DROP path must be demoted to LOOSE (redact-and-PASS) so these rows
// stay in the ledger while still scrubbing the digit block. We also assert
// that mutating the redaction does NOT clobber a retained reference to the
// caller's original raw_content (the LOOSE path must clone before mutate).
{
  const originalRC = {
    text: "Your OKX verification code is: 135790",
    handle_id: "+15551234567",
    is_from_me: true,
  };
  const ev = { source: "imessage", raw_content: originalRC };
  const r = imessageStage0(ev);
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, "imessage_otp_redacted_kept");
  // The caller's retained originalRC must still hold the unredacted text
  // — the LOOSE path clones before mutating so upstream consumers that
  // captured a reference are not surprised.
  assert.strictEqual(originalRC.text, "Your OKX verification code is: 135790");
  // The event's raw_content (rebound to the clone) carries the redaction.
  assert.ok(
    ev.raw_content.text.includes("[REDACTED]"),
    "ev.raw_content.text should carry the scrubbed digit block",
  );
}
ok("operator-authored STRICT anchor (is_from_me=true) → LOOSE PASS, raw_content cloned");
{
  // is_from_me=1 (chat.db numeric sentinel form) must take the same exemption.
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "Coinbase code: 192847. Don't share this.",
      handle_id: "Coinbase",
      is_from_me: 1,
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, "imessage_otp_redacted_kept");
}
ok("operator-authored STRICT anchor (is_from_me=1 numeric) → LOOSE PASS");

// 3b. F-T1-IMESSAGE-F2 (critic-modified): shortcode-sender heuristic
// split. shortcode + (footer OR marketing) → DROP imessage_a2p_shortcode_full
// + 30d quarantine. shortcode alone → PASS imessage_shortcode_redacted_kept
// with digit block scrubbed (lu.ma RSVPs etc. survive).
{
  const r = imessageStage0({ source: "imessage", raw_content: { text: "Your verification code is 123456. Reply STOP to opt out.", handle_id: "12345" } });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "imessage_a2p_shortcode_full");
}
ok("shortcode + OTP + regulatory footer → DROP imessage_a2p_shortcode_full");
{
  const r = imessageStage0({ source: "imessage", raw_content: { text: "Shop now and save $25 on your next order! Limited time deal.", handle_id: "61108" } });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "imessage_a2p_shortcode_full");
}
ok("shortcode + marketing language → DROP imessage_a2p_shortcode_full");
{
  const r = imessageStage0({ source: "imessage", raw_content: { text: "Lu.ma event reminder: dinner with friends tonight at 7pm", handle_id: "61108" } });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, "imessage_shortcode_redacted_kept");
}
ok("shortcode alone (lu.ma-style) → PASS imessage_shortcode_redacted_kept");

// 3c. F-INFRA-R43 bot-actor wiring at Stage-0: if the handle resolves to a
// known automation account (rare on imessage; via SMS-to-email gateways),
// route to DROP with reason "bot_message".
{
  const r = imessageStage0({ source: "imessage", raw_content: { text: "PR opened: foo", handle_id: "dependabot[bot]@users.noreply.github.com" } });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "bot_message");
}
ok("bot-actor handle (dependabot[bot]@...) → DROP bot_message");

// 4. placeholder residual
{
  const r = imessageStage0({ source: "imessage", raw_content: { text: "", handle_id: "+15551234567" } });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "placeholder_residual");
}
ok("text='' → DROP placeholder_residual");
{
  const r = imessageStage0({ source: "imessage", raw_content: { text: "y", handle_id: "+15551234567" } });
  assert.strictEqual(r.decision, "DROP");
}
ok("text length 1 → DROP placeholder_residual");

// 5. PASS + structural hint
{
  const r = imessageStage0({
    source: "imessage",
    raw_content: { text: "yeah for the meeting tuesday i was thinking 2-4", handle_id: "+15551234567" },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, null);
  assert.strictEqual(r.structural_score, CAPS.SALIENCE_STRUCTURAL_RULES.imessage.substantive_prose);
}
ok("substantive prose → PASS + substantive_prose structural score");
{
  const r = imessageStage0({
    source: "imessage",
    raw_content: { text: "ok thanks", handle_id: "+15551234567" },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.structural_score, CAPS.SALIENCE_STRUCTURAL_RULES.imessage.short_reply);
}
ok("short reply → PASS + short_reply structural score");

// ---------------------------------------------------------------------------
// F-NEW-W7-IMESSAGE-* — Wave 7 additions.
// ---------------------------------------------------------------------------
console.log("# stage0/imessage.js — F-NEW-W7 rules");

// F-NEW-W7-IMESSAGE-INVERTED-OTP — Facebook-style inverted-order OTP forms
// the predicates/a2p.js MODERN_OTP_REGEX misses because it assumes the
// issuer keyword precedes the digit block. The "<#>" Facebook app-hash
// prefix is the strongest signal but we also catch the plain inverted
// form for Apple ID / OKX / Coinbase.
{
  // Shortcode sender + "<#> NNNNNN is your Facebook confirmation code" —
  // shortcode upgrades the inverted anchor to medium-confidence STRICT
  // (REDACT_DROP + quarantine), matching the shipped STRICT_OTP_ANCHOR_RE
  // behaviour for issuer-prefixed forms.
  const r = imessageStage0({
    source: "imessage",
    raw_content: { text: "<#> 123456 is your Facebook confirmation code", handle_id: "80146" },
  });
  assert.strictEqual(r.decision, "REDACT_DROP");
  assert.strictEqual(r.reason, "imessage_otp_strict");
}
ok("F-NEW-W7 INVERTED OTP: '<#> NNNNNN is your Facebook confirmation code' (shortcode) → REDACT_DROP imessage_otp_strict");
{
  // Non-shortcode sender + inverted OTP — low-confidence STRICT path with
  // the inverted-anchor trigger.
  const r = imessageStage0({
    source: "imessage",
    raw_content: { text: "567890 is your Apple ID verification code", handle_id: "+15551234567" },
  });
  assert.strictEqual(r.decision, "REDACT_DROP");
  assert.strictEqual(r.reason, "imessage_otp_strict");
}
ok("F-NEW-W7 INVERTED OTP: 'NNNNNN is your Apple ID verification code' (long handle) → REDACT_DROP imessage_otp_strict");
{
  // Non-canonical inverted form — issuer-only without a code-modifier word
  // ("1234 is your number") must NOT match. Length too short (1234)
  // legitimate prose like "1234 is your favorite number"-style benign
  // text must PASS so we don't false-positive on numerics in prose.
  const r = imessageStage0({
    source: "imessage",
    raw_content: { text: "1234 is your favorite number i guess", handle_id: "+15551234567" },
  });
  assert.strictEqual(r.decision, "PASS");
}
ok("F-NEW-W7 INVERTED OTP false-positive guard: no 'code' word → PASS");

// F-NEW-W7-IMESSAGE-SERVICE-NOTIFICATION — transactional service shortcode
// notifications (food delivery, laundry, rideshare). PASS at structural_score=0.30
// with reason='imessage_service_transactional' so they survive for recall
// but lose head-of-queue priority.
{
  const r = imessageStage0({
    source: "imessage",
    raw_content: { text: "Your DoorDash order has been dispatched. Track at https://...", handle_id: "44444" },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, "imessage_service_transactional");
  assert.strictEqual(r.structural_score, 0.30);
}
ok("F-NEW-W7 SERVICE: shortcode + 'dispatched' → PASS imessage_service_transactional @ 0.30");
{
  const r = imessageStage0({
    source: "imessage",
    raw_content: { text: "Acme Wash: Your dry cleaning has been delivered.", handle_id: "55512" },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, "imessage_service_transactional");
  assert.strictEqual(r.structural_score, 0.30);
}
ok("F-NEW-W7 SERVICE: shortcode + 'delivered' → PASS imessage_service_transactional @ 0.30");
{
  const r = imessageStage0({
    source: "imessage",
    raw_content: { text: "Your Uber is on the way", handle_id: "89203" },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, "imessage_service_transactional");
}
ok("F-NEW-W7 SERVICE: shortcode + 'on the way' → PASS imessage_service_transactional");
{
  // shortcode WITHOUT transactional phrase → existing shortcode-only PASS
  // (NOT downgraded to service_transactional). Must keep the legacy reason.
  const r = imessageStage0({
    source: "imessage",
    raw_content: { text: "Lu.ma event reminder: dinner with friends tonight at 7pm", handle_id: "61108" },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, "imessage_shortcode_redacted_kept");
}
ok("F-NEW-W7 SERVICE: shortcode-only (no transactional) keeps imessage_shortcode_redacted_kept (no false-positive)");

// F-NEW-W7-IMESSAGE-F3-CONVERSATIONAL-OVERRIDE — friend-forwarded-spam
// rescue. BROAD_A2P_FOOTER_RE fires + conversational marker present +
// length < 200 → strip the marketing footer and PASS instead of DROP.
{
  // Friend forwarding a spam screenshot with "lol" commentary; total < 200
  // chars. Must rescue: PASS with imessage_f3_conversational_rescue.
  const ev = {
    source: "imessage",
    raw_content: {
      text: "lol look at this one they sent: Reply STOP to opt out",
      handle_id: "+15555550100",
    },
  };
  const r = imessageStage0(ev);
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, "imessage_f3_conversational_rescue");
  // The marketing footer suffix must have been stripped in place on
  // raw_content.text so downstream cascade consumers see the conversational
  // portion alone.
  assert.ok(
    !/reply\s+stop/i.test(ev.raw_content.text),
    "rescued text must not contain the regulatory footer phrase",
  );
  assert.ok(
    ev.raw_content.text.includes("[REDACTED_MARKETING]"),
    "rescued text must carry the [REDACTED_MARKETING] sentinel",
  );
}
ok("F-NEW-W7 F3 RESCUE: 'lol look at this … Reply STOP to opt out' (<200 chars) → PASS imessage_f3_conversational_rescue");
{
  // Same regulatory footer BUT no conversational marker → DROP imessage_a2p_regulatory_footer
  // (legacy F-T2-IMESSAGE-F3 behaviour preserved).
  const r = imessageStage0({
    source: "imessage",
    raw_content: {
      text: "Your statement is ready. Reply STOP to opt out.",
      handle_id: "+15555550100",
    },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "imessage_a2p_regulatory_footer");
}
ok("F-NEW-W7 F3 RESCUE guard: footer but no conversational marker → DROP imessage_a2p_regulatory_footer (legacy)");
{
  // Long marketing email-style text WITH "lol" in display copy must NOT
  // be rescued — the length gate guards against false-positives.
  const longText =
    "Hey hey lol this brand voice ".repeat(10) +
    "Subscribe today and save big! Reply STOP to opt out. Msg & Data rates may apply.";
  const r = imessageStage0({
    source: "imessage",
    raw_content: { text: longText, handle_id: "+15555550100" },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "imessage_a2p_regulatory_footer");
}
ok("F-NEW-W7 F3 RESCUE guard: long text (>=200 chars) with 'lol' still DROPs (no false rescue)");

// ---------------------------------------------------------------------------
// whatsapp.js
// ---------------------------------------------------------------------------
console.log("# stage0/whatsapp.js");

// A remote link preview is content, even when an older producer stamped the
// row as kind="reaction". Prefer the direct URL discriminator; accept the
// title as backward-compatible evidence on rows whose producer did not expose
// media_url. Both forms require authored text and no downloaded local asset.
{
  const r = whatsappStage0({
    source: "whatsapp",
    kind: "reaction",
    raw_content: {
      text: "Event details: https://lu.ma/example",
      message_type: 7,
      session_type: 1,
      has_media: false,
      media_local_path: null,
      media_url: "https://lu.ma/example",
      media_title: "Example event - Luma",
      low_signal_message_type: false,
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, null);
}
ok("remote link preview with URL + no local path -> PASS despite stale reaction stamp");
{
  const r = whatsappStage0({
    source: "whatsapp",
    kind: "reaction",
    raw_content: {
      text: "Event details: https://partiful.com/e/example",
      message_type: 7,
      session_type: 1,
      has_media: false,
      media_local_path: null,
      media_title: "Example gathering - Partiful",
      low_signal_message_type: false,
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, null);
}
ok("older remote link preview with title + no local path -> PASS");
{
  const r = whatsappStage0({
    source: "whatsapp",
    kind: "reaction",
    raw_content: {
      text: "👍",
      message_type: 0,
      session_type: 1,
      has_media: false,
      media_local_path: null,
      media_title: null,
      low_signal_message_type: false,
    },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "reaction");
}
ok("producer-declared reaction without remote-preview evidence -> DROP reaction");

{
  const r = whatsappStage0({
    source: "whatsapp",
    raw_content: {
      text: "synthetic_username",
      message_type: 10,
      group_event_type: 69,
      session_type: 1,
      has_media: false,
      low_signal_message_type: false,
    },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "identifier_body_placeholder");
}
ok("identifier-body placeholder -> DROP by observable shape");
{
  for (const groupEventType of [58, 69]) {
    const r = whatsappStage0({
      source: "whatsapp",
      raw_content: {
        text: "ordinary human-authored message",
        message_type: 10,
        group_event_type: groupEventType,
        session_type: 1,
        has_media: false,
        low_signal_message_type: false,
      },
    });
    assert.strictEqual(r.decision, "PASS");
  }
}
ok("ordinary prose at each observed group-event provenance -> PASS");
{
  const r = whatsappStage0({
    source: "whatsapp",
    raw_content: {
      text: "ordinary human-authored message",
      message_type: 6,
      group_event_type: 1,
      session_type: 1,
      has_media: false,
      low_signal_message_type: false,
    },
  });
  assert.strictEqual(r.decision, "PASS");
}
ok("unmarked numeric type receives no inferred semantics");
{
  const r = whatsappStage0({
    source: "whatsapp",
    raw_content: {
      text: "identifier_token",
      message_type: Symbol("malformed"),
      group_event_type: 69,
      session_type: 1,
      has_media: false,
    },
  });
  assert.strictEqual(r.decision, "PASS");
}
ok("malformed message-type coercion degrades fail-open without throwing");

// ---------------------------------------------------------------------------
// screentime.js
// ---------------------------------------------------------------------------
console.log("# stage0/screentime.js");
{
  const r = screentimeStage0({ source: "screentime", raw_content: { stream: "/discoverability/signals", signal: "com.apple.screencapture.invoke" } });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "discoverability_signals");
}
ok("stream=/discoverability/signals → DROP");
{
  // Defensive fallback for ZSTREAMNAME shape.
  const r = screentimeStage0({ source: "screentime", raw_content: { ZSTREAMNAME: "/discoverability/signals" } });
  assert.strictEqual(r.decision, "DROP");
}
ok("ZSTREAMNAME defensive field also DROPs");
{
  const r = screentimeStage0({ source: "screentime", raw_content: { stream: "/app/usage", signal: "com.foo.bar" } });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(typeof r.structural_score, "number");
}
ok("stream=/app/usage → PASS with structural score");

// ---------------------------------------------------------------------------
// gitlog.js
// ---------------------------------------------------------------------------
console.log("# stage0/gitlog.js");
{
  // F-NEW-W2-GIT-LOG-STAGE0-INITIAL-COMMIT: reason renamed from the
  // legacy "initial_commit" to "git_log_initial_commit_drop" (the
  // distinct Stage-0 layer reason vs the connector-layer
  // "git_log_initial_commit_variant" — see telemetry.js allowlist).
  // F-NEW-W7-GIT-LOG-RULE1-TIGHTEN: now also requires parents=[] OR
  // is_initial_commit hint, so the test fixture includes parents=[].
  const r = gitlogStage0({ source: "git-log", raw_content: { subject: "Initial commit", parents: [], author_email: "sam@example.com", body: null } });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "git_log_initial_commit_drop");
}
ok("subject='Initial commit' + parents=[] → DROP");
{
  // F-NEW-W7-GIT-LOG-RULE1-TIGHTEN: "Initial commit" subject WITHOUT
  // parents=[] (e.g. real commit named that way) is no longer dropped.
  const r = gitlogStage0({ source: "git-log", raw_content: { subject: "Initial commit", parents: ["abc"], author_email: "sam@example.com", body: null } });
  assert.strictEqual(r.decision, "PASS");
}
ok("F-NEW-W7-GIT-LOG-RULE1-TIGHTEN: subject='Initial commit' WITH parents=['abc'] → PASS");
{
  // F-NEW-W7-GIT-LOG-RULE1-TIGHTEN: synthetic-node parents=[] with a
  // substantive subject (e.g. stash-snapshot, "sync workspace sources") is
  // no longer dropped by the parents=[]-alone branch.
  const r = gitlogStage0({ source: "git-log", raw_content: { subject: "sync workspace sources", parents: [], author_email: "sam@example.com", body: "6500 LOC ML work" } });
  assert.strictEqual(r.decision, "PASS");
}
ok("F-NEW-W7-GIT-LOG-RULE1-TIGHTEN: substantive subject + parents=[] → PASS (audit fix)");
{
  // F-NEW-W7-GIT-LOG-COLON-SUFFIX-CARVEOUT: "Initial commit: <long suffix>"
  // PASSes at structural_score=0.55 with reason 'git_log_initial_commit_with_suffix'.
  const r = gitlogStage0({ source: "git-log", raw_content: { subject: "Initial commit: sample curriculum outline and notes", parents: [], author_email: "sam@example.com" } });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, "git_log_initial_commit_with_suffix");
  assert.strictEqual(r.structural_score, 0.55);
}
ok("F-NEW-W7-GIT-LOG-COLON-SUFFIX-CARVEOUT: 'Initial commit: <substantive suffix>' → PASS @ 0.55");
{
  // F-NEW-W7-GIT-LOG-COLON-SUFFIX-CARVEOUT: short suffix does NOT carve out.
  const r = gitlogStage0({ source: "git-log", raw_content: { subject: "Initial commit: foo", parents: [], author_email: "sam@example.com" } });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "git_log_initial_commit_drop");
}
ok("F-NEW-W7-GIT-LOG-COLON-SUFFIX-CARVEOUT: short suffix → falls through to DROP");
{
  // F-NEW-W7-GIT-LOG-AUTHOR-SELF: operator-authored commit PASSes at
  // structural_score=max(0.7, suggested) with reason
  // 'git_log_operator_authored_passthrough', AHEAD of upstream-only /
  // initial-commit / bot rules.
  const r = gitlogStage0({ source: "git-log", raw_content: { subject: "anything", parents: ["abc"], author_email: "alex@example.com", body: "real prose" } });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, "git_log_operator_authored_passthrough");
  assert.ok(r.structural_score >= 0.7, `expected >=0.7, got ${r.structural_score}`);
}
ok("F-NEW-W7-GIT-LOG-AUTHOR-SELF: operator email → PASS @ >=0.7");
{
  // F-NEW-W7-GIT-LOG-AUTHOR-SELF: operator-authored overrides upstream-only downgrade.
  const r = gitlogStage0({ source: "git-log", raw_content: { subject: "fix", parents: ["abc"], author_email: "alex@example.com", repo_classification: "upstream_only", suggested_structural_score: 0.10 } });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, "git_log_operator_authored_passthrough");
  assert.strictEqual(r.structural_score, 0.7);
}
ok("F-NEW-W7-GIT-LOG-AUTHOR-SELF: operator in upstream_only repo → PASS @ 0.7 (override)");
{
  const r = gitlogStage0({ source: "git-log", raw_content: { subject: "Merge branch 'main' into feature/x", author_email: "sam@example.com", body: null } });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "merge_only");
}
ok("Merge branch + empty body → DROP merge_only");
{
  const r = gitlogStage0({ source: "git-log", raw_content: { subject: "Merge pull request #42 from foo/bar", author_email: "sam@example.com", body: "" } });
  assert.strictEqual(r.decision, "DROP");
}
ok("Merge pull request + empty body → DROP merge_only");
{
  const r = gitlogStage0({ source: "git-log", raw_content: { subject: "Merge tag 'v1.2.3'", author_email: "sam@example.com", body: "   \n  " } });
  assert.strictEqual(r.decision, "DROP");
}
ok("Merge tag + whitespace-only body → DROP merge_only");
{
  const r = gitlogStage0({ source: "git-log", raw_content: { subject: "Merge branch 'release'", author_email: "sam@example.com", body: "Real release notes here." } });
  assert.strictEqual(r.decision, "PASS");
}
ok("Merge subject WITH body → PASS (not merge-only)");
{
  // F-T1-GIT_LOG-F8 (W7 Rule 2c): version-bump subjects matching
  // /^(Bump|chore\(deps\)|update to latest)/i + bot author route through
  // the dedicated version-bump bucket AHEAD of the generic bot_commit
  // rule, so the operator can monitor F8 fire-rate independently. The
  // critic-mandated reason is 'git_log_version_bump_bot'.
  const r = gitlogStage0({ source: "git-log", raw_content: { subject: "bump foo from 1.0 to 1.1", author_email: "49699333+dependabot[bot]@users.noreply.github.com" } });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "git_log_version_bump_bot");
}
ok("dependabot author + version-bump subject → DROP git_log_version_bump_bot (F-T1-GIT_LOG-F8)");
{
  // Regression: dependabot author with a NON-version-bump subject still
  // routes through Rule 3 (generic bot_commit). This pins the
  // distinction between Rule 2c (version-bump bucket) and Rule 3
  // (catch-all bot bucket) so a future refactor cannot silently merge
  // them.
  const r = gitlogStage0({ source: "git-log", raw_content: { subject: "Refactor dispatcher", author_email: "49699333+dependabot[bot]@users.noreply.github.com" } });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "bot_commit");
}
ok("dependabot author + non-version-bump subject → DROP bot_commit (Rule 3 catch-all)");
{
  const r = gitlogStage0({ source: "git-log", raw_content: { subject: "chore: upgrade deps", author_email: "29139614+renovate-bot@users.noreply.github.com" } });
  assert.strictEqual(r.decision, "DROP");
}
ok("renovate-bot author email → DROP bot_commit");
{
  const r = gitlogStage0({ source: "git-log", raw_content: { subject: "ci: rebuild", author_email: "actions@github.com" } });
  assert.strictEqual(r.decision, "PASS"); // 'actions@github.com' does not match 'github-actions'
}
ok("'actions@github.com' (no 'github-actions') → PASS");
{
  const r = gitlogStage0({ source: "git-log", raw_content: { subject: "wip", author_email: "github-actions[bot]@users.noreply.github.com" } });
  assert.strictEqual(r.decision, "DROP");
}
ok("github-actions bot → DROP bot_commit");
{
  const r = gitlogStage0({ source: "git-log", raw_content: { subject: "R23: harden HNSW backfill", author_email: "sam@example.com", body: "Fixes the kNN drift on cold-start." } });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.structural_score, CAPS.SALIENCE_STRUCTURAL_RULES["git-log"].substantive_prose);
}
ok("substantive commit → PASS + substantive_prose structural score");

// ---------------------------------------------------------------------------
// githubevents.js
// ---------------------------------------------------------------------------
console.log("# stage0/githubevents.js");
{
  const r = githubeventsStage0({ source: "github-events", raw_content: { event_type: "WatchEvent", actor_login: "alice" } });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "low_signal_event");
}
ok("WatchEvent → DROP low_signal_event");
{
  const r = githubeventsStage0({ source: "github-events", raw_content: { event_type: "ForkEvent", actor_login: "alice" } });
  assert.strictEqual(r.decision, "DROP");
}
ok("ForkEvent → DROP low_signal_event");
{
  const r = githubeventsStage0({ source: "github-events", raw_content: { event_type: "PullRequestEvent", actor_login: "dependabot[bot]", action: "opened" } });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "bot_event");
}
ok("dependabot actor → DROP bot_event");
{
  const r = githubeventsStage0({ source: "github-events", raw_content: { event_type: "PullRequestEvent", actor_login: "renovate[bot]", action: "opened" } });
  assert.strictEqual(r.decision, "DROP");
}
ok("renovate actor → DROP bot_event");
{
  // legacy event uses pr_author field (current ledger shape doesn't carry actor_login)
  const r = githubeventsStage0({ source: "github-events", raw_content: { event_type: "PullRequestEvent", pr_author: "dependabot[bot]" } });
  assert.strictEqual(r.decision, "DROP");
}
ok("legacy pr_author dependabot → DROP bot_event");
{
  const r = githubeventsStage0({ source: "github-events", raw_content: { event_type: "PullRequestEvent", actor_login: "sam-sample", action: "merged", repo: "sam-sample/example-repo" } });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(typeof r.structural_score, "number");
}
ok("PullRequestEvent by human actor → PASS");
{
  const r = githubeventsStage0({ source: "github-events", raw_content: { event_type: "IssueCommentEvent", actor_login: "alex-example", repo: "alex-example/memory-system" } });
  assert.strictEqual(r.decision, "PASS");
}
ok("IssueCommentEvent by human → PASS");

// ---------------------------------------------------------------------------
// Operator-owned gh namespaces derive ONLY from the operator identity
// (github_usernames + github_orgs). The module compiles in no login: the
// pinned synthetic identity yields exactly its three namespaces, and a
// process with NO identity file gets an empty set, so every empty PushEvent
// is third-party there.
// ---------------------------------------------------------------------------
{
  const expected = JSON.parse(readFileSync(SYNTHETIC_IDENTITY_FILE, "utf8"));
  assert.deepStrictEqual(
    _operatorOwnedGhNamespacesForTest().slice().sort(),
    ["alex-example", "example-labs", "example-org"]
  );
  assert.deepStrictEqual(
    _operatorOwnedGhNamespacesForTest().slice().sort(),
    [...expected.github_usernames, ...expected.github_orgs].map((s) => s.toLowerCase()).sort()
  );
}
ok("operator-owned gh namespaces == identity github_usernames + github_orgs, nothing compiled in");
{
  // Case-insensitive owner compare; operator-owned empty push keeps the F1
  // downgrade, a third-party empty push quarantines.
  const own = githubeventsStage0({ source: "github-events", raw_content: { event_type: "PushEvent", commits: 0, first_message: null, repo: "Alex-Example/example-repo" } });
  assert.strictEqual(own.decision, "PASS");
  assert.strictEqual(own.reason, "empty_pushevent_downgrade");
  assert.strictEqual(own.structural_score, 0.10);
  const org = githubeventsStage0({ source: "github-events", raw_content: { event_type: "PushEvent", commits: 0, first_message: null, repo: "example-labs/example-repo" } });
  assert.strictEqual(org.reason, "empty_pushevent_downgrade");
  const other = githubeventsStage0({ source: "github-events", raw_content: { event_type: "PushEvent", commits: 0, first_message: null, repo: "sam-sample/example-repo" } });
  assert.strictEqual(other.decision, "DROP");
  assert.strictEqual(other.reason, "gh_empty_push_third_party");
}
ok("empty PushEvent: identity-owned repo → PASS empty_pushevent_downgrade @ 0.10; third-party repo → DROP gh_empty_push_third_party");
{
  // Empty identity (MEMORY_OPERATOR_IDENTITY_FILE names a file that does not
  // exist). Identity is resolved at module load, so this needs a fresh
  // process; it inherits the HERMETIC_TMP roots pinned above.
  const missing = pathJoin(HERMETIC_TMP, "no-such-operator-identity.json");
  assert.strictEqual(existsSync(missing), false);
  const modUrl = pathToFileURL(
    pathJoin(dirname(fileURLToPath(import.meta.url)), "..", "..", "lib", "ingest", "stage0", "githubevents.js")
  ).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(modUrl)});
       const r = m.stage0({ source: "github-events", raw_content: { event_type: "PushEvent", commits: 0, first_message: null, repo: "alex-example/example-repo" } });
       process.stdout.write(JSON.stringify({ namespaces: m._operatorOwnedGhNamespacesForTest(), decision: r.decision, reason: r.reason }));`,
    ],
    { encoding: "utf8", env: { ...process.env, MEMORY_OPERATOR_IDENTITY_FILE: missing } }
  );
  assert.strictEqual(child.status, 0, `child exited ${child.status}: ${child.stderr}`);
  const out = JSON.parse(child.stdout);
  assert.deepStrictEqual(out.namespaces, []);
  assert.strictEqual(out.decision, "DROP");
  assert.strictEqual(out.reason, "gh_empty_push_third_party");
}
ok("empty operator identity → _operatorOwnedGhNamespacesForTest() == [] and every empty PushEvent is third-party");

// ---------------------------------------------------------------------------
// codex-cli.js (R28 Phase 2a)
// ---------------------------------------------------------------------------
console.log("# stage0/codex-cli.js");

// T-codex-1: empty turn → DROP
{
  const r = codexCliStage0({
    source: "codex-cli",
    raw_content: { conversation_id: "sess-1", turn_index: 0, user_text: null, assistant_text: null },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "empty_turn");
}
ok("T-codex empty turn (both null) → DROP empty_turn");
{
  const r = codexCliStage0({
    source: "codex-cli",
    raw_content: { conversation_id: "sess-1", turn_index: 1, user_text: "   ", assistant_text: "" },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "empty_turn");
}
ok("T-codex whitespace-only both sides → DROP empty_turn");

// T-codex-2: <environment_context> user turn with no assistant.
// F-T1-CODEX_CLI-F1: unflagged historical row → fallback regex fires →
// DROP codex_scaffold_regex_fallback (quarantined for 14 days).
{
  const r = codexCliStage0({
    source: "codex-cli",
    source_msg_id: "codex:sess-1:0",
    raw_content: {
      conversation_id: "sess-1",
      turn_index: 0,
      user_text: "<environment_context>\n  <cwd>/Users/[REDACTED]/repo</cwd>\n</environment_context>",
      assistant_text: "",
    },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "codex_scaffold_regex_fallback");
}
ok("T-codex environment_context boilerplate user turn + no assistant → DROP codex_scaffold_regex_fallback (F-T1-CODEX_CLI-F1)");

// T-codex-2b (F-T1-CODEX_CLI-F1 PRIMARY path): connector-tagged
// auto_injected user turn with no assistant → DROP
// codex_scaffold_auto_injected. The flag is set by the connector at
// write-time so Stage-0 trusts it without re-running the regex.
{
  const r = codexCliStage0({
    source: "codex-cli",
    source_msg_id: "codex:sess-1:0b",
    raw_content: {
      conversation_id: "sess-1",
      turn_index: 0,
      user_text: "<system_prompt>You are a helpful assistant.</system_prompt>",
      assistant_text: "",
      auto_injected: true,
    },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "codex_scaffold_auto_injected");
}
ok("T-codex auto_injected flagged + no assistant → DROP codex_scaffold_auto_injected (F-T1-CODEX_CLI-F1 primary)");

// T-codex-2c: auto_injected scaffold WITH a substantive assistant reply
// → PASS. The assistant response IS signal; we keep the row even though
// the user half is auto-injected scaffold.
{
  const r = codexCliStage0({
    source: "codex-cli",
    raw_content: {
      conversation_id: "sess-1",
      turn_index: 1,
      user_text: "<system_prompt>You are a helpful assistant.</system_prompt>",
      assistant_text: "Understood. I'll act per those instructions.",
      auto_injected: true,
    },
  });
  assert.strictEqual(r.decision, "PASS");
}
ok("T-codex auto_injected + assistant reply → PASS (F-T1-CODEX_CLI-F1 keeps the dialogue half)");

// T-codex-2d: operator mentions a scaffold token mid-sentence (no
// anchored prefix) → PASS. The anchored ^\s* guard keeps real operator
// discussion out of the scaffold bucket.
{
  const r = codexCliStage0({
    source: "codex-cli",
    raw_content: {
      conversation_id: "sess-1",
      turn_index: 2,
      user_text: "Tell me what the <system_prompt> tag does in this rollout format.",
      assistant_text: "",
    },
  });
  assert.strictEqual(r.decision, "PASS");
}
ok("T-codex mid-sentence scaffold mention (not anchored) → PASS (no false positive)");
{
  // Same context BUT with an assistant reply → PASS (real conversation)
  const r = codexCliStage0({
    source: "codex-cli",
    raw_content: {
      conversation_id: "sess-1",
      turn_index: 0,
      user_text: "<environment_context>\n  <cwd>/x</cwd>\n</environment_context>",
      assistant_text: "Acknowledged. I will respect this cwd for subsequent commands.",
    },
  });
  assert.strictEqual(r.decision, "PASS");
}
ok("T-codex environment_context + non-empty assistant → PASS");
{
  // F-A6-CODEX-RECOMMENDED-PLUGINS — the harness plugin list envelope WITH
  // an assistant reply → PASS (the isEmpty(assistantText) guard preserves
  // the dialogue half exactly as it does for environment_context).
  const r = codexCliStage0({
    source: "codex-cli",
    raw_content: {
      conversation_id: "sess-1",
      turn_index: 0,
      user_text:
        "<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n\n- Airtable (airtable@openai-curated-remote)\n</recommended_plugins>",
      assistant_text:
        "Noted the available plugins. None are needed for this task; proceeding with the ledger read in mcp/lib/ingest/watermark.js.",
    },
  });
  assert.strictEqual(r.decision, "PASS");
}
ok("F-A6-CODEX-RECOMMENDED-PLUGINS: <recommended_plugins> + non-empty assistant → PASS");

// T-codex-3: substantive turn → PASS + substantive_prose score
{
  const r = codexCliStage0({
    source: "codex-cli",
    raw_content: {
      conversation_id: "sess-1",
      turn_index: 2,
      user_text: "Refactor the watermark daemon to use the new cursor schema.",
      assistant_text: "Reading daemons/watermark.js to identify the cursor write sites.",
    },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, null);
  assert.strictEqual(r.structural_score, CAPS.SALIENCE_STRUCTURAL_RULES["codex-cli"].substantive_prose);
}
ok("T-codex substantive turn → PASS + substantive_prose score");

// T-codex-4: short turn falls back to subject_only
{
  const r = codexCliStage0({
    source: "codex-cli",
    raw_content: { conversation_id: "sess-1", turn_index: 3, user_text: "yes", assistant_text: "ok" },
  });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.structural_score, CAPS.SALIENCE_STRUCTURAL_RULES["codex-cli"].subject_only);
}
ok("T-codex short turn → PASS + subject_only score");

// F-T1-CODEX_CLI-F1 — old Rule 4 (codex_slash_command) was REMOVED.
// The audit found zero matches across 38k codex-cli rows; the Codex CLI
// intercepts /init, /clear, /compact before the response_item write so
// they never surface as user_text in the rollout JSONL. These tests now
// pin the new behaviour: a bare "/init" survives as PASS so the dispatch
// layer's denominator is honest.
{
  const r = codexCliStage0({
    source: "codex-cli",
    raw_content: { conversation_id: "sess-1", turn_index: 4, user_text: "/init", assistant_text: "" },
  });
  assert.strictEqual(r.decision, "PASS");
}
ok("T-codex-slash-init: '/init' → PASS (Rule 4 removed in F-T1-CODEX_CLI-F1)");
{
  const r = codexCliStage0({
    source: "codex-cli",
    raw_content: { conversation_id: "sess-1", turn_index: 7, user_text: "init the project with the new config", assistant_text: "" },
  });
  assert.strictEqual(r.decision, "PASS");
}
ok("T-codex-slash-not-a-slash: 'init the project' → PASS");

// F-NEW-W7-CODEX-INTERRUPT-TOKENS — interrupt-class envelope tokens
// (<turn_aborted>, <session_aborted>, <tool_use_error>,
// <command_interrupted>) are part of SCAFFOLD_USER_RE. The harness
// threads them in as pseudo-user turns when a tool call is aborted
// mid-stream; they are not operator content. Each should route through
// codex_scaffold_regex_fallback (the unflagged path) when no assistant
// reply follows, and through PASS when the operator merely DISCUSSES
// the token mid-sentence (the anchored ^\s* guard).
for (const token of [
  "turn_aborted",
  "session_aborted",
  "tool_use_error",
  "command_interrupted",
  // F-A6-CODEX-RECOMMENDED-PLUGINS — harness "plugins available but not
  // installed" list; same envelope class, same fallback path.
  "recommended_plugins",
]) {
  {
    // Anchored interrupt envelope, no assistant reply → DROP via fallback.
    const r = codexCliStage0({
      source: "codex-cli",
      source_msg_id: `codex:sess-interrupt:${token}`,
      ts: "2026-01-05T00:00:00.000Z",
      parties: ["operator"],
      raw_content: {
        conversation_id: "sess-interrupt",
        turn_index: 0,
        user_text: `<${token}>\n  reason="cancelled"\n</${token}>`,
        assistant_text: "",
      },
    });
    assert.strictEqual(r.decision, "DROP");
    assert.strictEqual(r.reason, "codex_scaffold_regex_fallback");
  }
  ok(`F-NEW-W7-CODEX-INTERRUPT-TOKENS: <${token}> envelope user turn + no assistant → DROP codex_scaffold_regex_fallback`);
  {
    // Mid-sentence operator mention (not anchored) → PASS.
    const r = codexCliStage0({
      source: "codex-cli",
      raw_content: {
        conversation_id: "sess-interrupt",
        turn_index: 1,
        user_text: `Why did the harness emit a <${token}> envelope last night?`,
        assistant_text: "",
      },
    });
    assert.strictEqual(r.decision, "PASS");
  }
  ok(`F-NEW-W7-CODEX-INTERRUPT-TOKENS: mid-sentence <${token}> mention (not anchored) → PASS (no false positive)`);
}

// ---------------------------------------------------------------------------
// F-E6-CODEX-PROCESS-NARRATION — content-free process narration.
//
// Defect: a recall for "what am I currently working on, what commitments are
// open" returned five assistant self-narration lines in its top ten. Those
// rows are admitted by Stage-0 today. This block is the red-first gate.
//
// TEST HYGIENE — the DROP arms below route through quarantineScaffoldRow, and
// quarantineBaseDir() in lib/ingest/quarantine.js reads QUARANTINE_BASE_DIR at
// CALL time. We redirect it (and STORAGE_BASE_DIR, defensively) at a tmpdir
// for the duration of this block so calling stage0() on a dropping row never
// writes under the live storage/quarantine/ tree, then restore.
//
// RED-FIRST NOTE, stated honestly: the DROP / downgrade / constant assertions
// below all FAIL on the unmodified tree (NARRATION_STRICT_MAX_CHARS and
// NEXT_ACTION_NARRATION_RE do not exist there, and the five gate strings all
// PASS at full score). The three FALSE-POSITIVE guards are green on BOTH
// trees BY DESIGN — they exist to prove the new predicate did not eat real
// content, so "unchanged before and after" is exactly the property asserted.
// ---------------------------------------------------------------------------
console.log("# stage0/codex-cli.js — F-E6-CODEX-PROCESS-NARRATION");
{
  // The DROP arms below quarantine. HERMETIC_TMP (file scope, above) already
  // points QUARANTINE_BASE_DIR at a tmpdir; assert it rather than assume it,
  // so this block can never be the thing that writes under storage/.
  assert.ok(
    typeof process.env.QUARANTINE_BASE_DIR === "string" &&
      process.env.QUARANTINE_BASE_DIR.startsWith(HERMETIC_TMP),
    "QUARANTINE_BASE_DIR must be redirected before any DROP assertion"
  );
  ok("F-E6 hygiene: QUARANTINE_BASE_DIR redirected off the live storage tree");

  const CODEX_RULES = CAPS.SALIENCE_STRUCTURAL_RULES["codex-cli"];
  // Assistant-only turn: user_text blank, assistant_text carries the row.
  const assistantOnly = (assistantText, turnIndex) =>
    codexCliStage0({
      source: "codex-cli",
      source_msg_id: `codex:e6:${turnIndex}`,
      ts: "2026-08-18T00:00:00.000Z",
      parties: ["operator"],
      raw_content: {
        conversation_id: "sess-e6",
        turn_index: turnIndex,
        user_text: "",
        assistant_text: assistantText,
      },
    });

  try {
    // -- (b) the two tight-band gate strings DROP -----------------------------
    // Both are invented strings in the shape the rule targets: both are
    // under NARRATION_STRICT_MAX_CHARS and open with a pure-narration family
    // that the pre-existing STATUS_PING_RE alternation never named.
    for (const [i, narration] of [
      "Still green and progressing; nothing further to report for now.",
      "Still quiet on the runner. I’ll hold until the report shows up.",
    ].entries()) {
      const r = assistantOnly(narration, 100 + i);
      assert.strictEqual(r.decision, "DROP");
      assert.strictEqual(r.reason, "codex_assistant_status_ping");
      ok(`F-E6: tight-band narration → DROP codex_assistant_status_ping [${i}]`);
    }

    // -- (c) the three ambiguous gate strings PASS, downgraded ----------------
    // REFUSED PREMISE, recorded here as executable evidence: the node spec
    // demanded this family be DROPped. The three invented strings below are
    // in the first-person next-action family, and a census of the corpus
    // (72,748 assistant-only codex-cli rows) found short I'll/I'm openers to
    // be 122 rows / 120 distinct — 0.17% — of which 93 name a concrete
    // artifact, file, symbol or decision. Dropping that family buys 0.17% and
    // destroys exactly the open-commitment content the failing recall asked
    // for. So they PASS at the `boilerplate` rung instead, mirroring the
    // system_prompt_replay downgrade in the same function.
    for (const [i, narration] of [
      "The exporter is running now and has a long queue ahead of it. I’ll leave it alone and look again once the queue is empty.",
      "I’ll pull the latest schedule file so the summary lists what is actually pending rather than what I assume is pending.",
      "I’ll sanity-check the lockfile and the open branch before replying, so I don’t describe a stale layout or clobber a pending edit.",
    ].entries()) {
      const r = assistantOnly(narration, 110 + i);
      assert.strictEqual(r.decision, "PASS");
      assert.strictEqual(r.reason, "process_narration");
      assert.strictEqual(r.structural_score, 0.30);
      ok(`F-E6: next-action narration → PASS process_narration @ boilerplate [${i}]`);
    }

    // The 0.30 above is not a literal invented for this rule — it is the
    // already-frozen `boilerplate` rung, previously referenced by no rule.
    assert.strictEqual(CODEX_RULES.boilerplate, 0.30);
    ok("F-E6: downgrade rung IS CAPS.SALIENCE_STRUCTURAL_RULES['codex-cli'].boilerplate (no new table key)");

    // -- (a) the two fact-bearing strings PASS at UNCHANGED score -------------
    // These are the false-positive gate. A length threshold alone cuts the
    // first; an "I'll"/"Still" keyword blocklist cuts fact-bearing
    // first-person content. Both must survive at the score they had before the change.
    {
      const r = assistantOnly("My landlord confirmed our lease renewal through next March", 120);
      assert.strictEqual(r.decision, "PASS");
      assert.strictEqual(r.reason, null);
      assert.strictEqual(r.structural_score, CODEX_RULES.subject_only);
    }
    ok("F-E6 false-positive gate: 'My landlord confirmed...' → PASS at unchanged subject_only");
    {
      const r = assistantOnly(
        "The bm25 index was rebuilt to 1.54M docs and the gate permits at 99.99%",
        121
      );
      assert.strictEqual(r.decision, "PASS");
      assert.strictEqual(r.reason, null);
      assert.strictEqual(r.structural_score, CODEX_RULES.substantive_prose);
    }
    ok("F-E6 false-positive gate: bm25 rebuild fact → PASS at unchanged substantive_prose");

    // -- (d) a long turn that OPENS with narration keeps its full score --------
    // 250+ chars: over BOTH caps, so neither the Tier-1 DROP nor the Tier-2
    // downgrade may touch it. This is what the two length cliffs buy.
    {
      const longTurn =
        "Still running. The bm25 projection now covers 1.54M docs and the coverage " +
        "probe reports 99.99 percent, so the rebuild target is met and the gate can " +
        "permit at the configured floor without a manual override. The remaining " +
        "work is the entity alias overlay, which is unblocked.";
      assert.ok(longTurn.length >= 250, "fixture must exceed 250 chars");
      const r = assistantOnly(longTurn, 122);
      assert.strictEqual(r.decision, "PASS");
      assert.strictEqual(r.reason, null);
      assert.strictEqual(r.structural_score, CODEX_RULES.substantive_prose);
    }
    ok("F-E6: 250-char turn OPENING with 'Still running.' → PASS at full substantive_prose");

    // -- (e) the `^` anchor holds ---------------------------------------------
    // A row that DISCUSSES the narration phrase mid-sentence must not match.
    {
      const r = assistantOnly(
        "The operator asked whether the 'still running' narration was ever dropped; it was not, and that is the defect this node fixes.",
        123
      );
      assert.strictEqual(r.decision, "PASS");
      assert.strictEqual(r.reason, null);
      assert.strictEqual(r.structural_score, CODEX_RULES.substantive_prose);
    }
    ok("F-E6: mid-sentence mention of the narration phrase → PASS (^ anchor holds)");

    // -- the length cliff itself ----------------------------------------------
    // Two caps, not one: the pre-existing alternation keeps 200, the widened
    // families get 80. Measured: at <200 the new families take 1,689 rows and
    // a hand audit of 40 distinct strings from the 80..200 band found 6
    // fact-bearing; at <80 they take 1,223 rows / 620 distinct and a hand
    // audit of 30 distinct found 0.
    assert.strictEqual(codexCliInternals.NARRATION_STRICT_MAX_CHARS, 80);
    assert.ok(
      codexCliInternals.NARRATION_STRICT_MAX_CHARS <
        codexCliInternals.STATUS_PING_MAX_CHARS
    );
    ok("F-E6: NARRATION_STRICT_MAX_CHARS (80) is a SECOND, tighter cap under STATUS_PING_MAX_CHARS (200)");
    {
      // An invented turn in the 80..200 band: it matches the widened
      // alternation but states facts in its trailing clause, so the
      // tight cliff must spare it.
      const banded =
        "Still clean: the linter reports nothing. Unit and integration jobs have finished; the docs build and the packaging job are still executing, neither queued nor stuck.";
      assert.ok(banded.length >= codexCliInternals.NARRATION_STRICT_MAX_CHARS);
      assert.ok(codexCliInternals.NARRATION_PING_RE.test(banded));
      const r = assistantOnly(banded, 124);
      assert.strictEqual(r.decision, "PASS");
    }
    ok("F-E6: 80..200 band narration matches the regex but is SPARED by the tight cliff → PASS");

    // -- the pre-existing rule keeps its wide cap ------------------------------
    // Regression guard: widening must not have shrunk STATUS_PING_RE's band.
    {
      const wide =
        "Checks are running. I will report the exact failure list once the suite exits and not before, so the record stays honest.";
      assert.ok(wide.length > codexCliInternals.NARRATION_STRICT_MAX_CHARS);
      assert.ok(wide.length < codexCliInternals.STATUS_PING_MAX_CHARS);
      const r = assistantOnly(wide, 125);
      assert.strictEqual(r.decision, "DROP");
      assert.strictEqual(r.reason, "codex_assistant_status_ping");
    }
    ok("F-E6: pre-existing STATUS_PING_RE family still DROPs across the full 200-char band");

    // -- a user turn is never narration ----------------------------------------
    // Every new arm keeps the isEmpty(userText) guard: operator dialogue that
    // happens to open with a narration phrase is untouched.
    {
      const r = codexCliStage0({
        source: "codex-cli",
        raw_content: {
          conversation_id: "sess-e6",
          turn_index: 126,
          user_text: "Still waiting on the invoice from the contractor?",
          assistant_text: "",
        },
      });
      assert.strictEqual(r.decision, "PASS");
    }
    ok("F-E6: narration phrase in USER text → PASS (isEmpty(userText) guard preserved)");
  } finally {
    // HERMETIC_TMP is process-scoped and intentionally NOT restored: any
    // later arm added to this suite inherits the redirect.
  }
}

// ---------------------------------------------------------------------------
// Dispatcher round-trip + degenerate cases
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// F-W-CODEX-TOOL-CALL-BLOCK — assistant-only rows that are nothing but
// bracketed tool envelopes DROP (quarantined, reason codex_tool_call_block);
// the same envelope with prose outside it, or with operator words on the
// user side, PASSes. Both regex anchors are pinned by symbol.
// ---------------------------------------------------------------------------
console.log("# stage0/codex-cli.js — F-W-CODEX-TOOL-CALL-BLOCK");
{
  assert.ok(
    typeof process.env.QUARANTINE_BASE_DIR === "string" &&
      process.env.QUARANTINE_BASE_DIR.startsWith(HERMETIC_TMP),
    "QUARANTINE_BASE_DIR must be redirected before any DROP assertion"
  );
  const row = (userText, assistantText, turnIndex) =>
    codexCliStage0({
      source: "codex-cli",
      source_msg_id: `codex:toolblock:${turnIndex}`,
      ts: "2026-09-08T00:00:00.000Z",
      parties: ["operator"],
      raw_content: {
        conversation_id: "sess-toolblock",
        turn_index: turnIndex,
        user_text: userText,
        assistant_text: assistantText,
      },
    });
  const CALL =
    "[external_agent_tool_call: Bash]\ndescription: List fixture files and count rows per table\ncommand: cd /srv/example/sandbox; ls fixtures | wc -l\n[/external_agent_tool_call]";
  const RESULT =
    "[external_agent_tool_result]\n# Sample Inventory Report\n\n## Summary\n\n**Widgets in stock (bin A):** 14 crates.\n[/external_agent_tool_result]";

  assert.ok(codexCliInternals.TOOL_BLOCK_RE instanceof RegExp);
  ok("F-W-TOOLBLOCK: TOOL_BLOCK_RE exported via _internals");

  {
    const r = row("", CALL, 1);
    assert.strictEqual(r.decision, "DROP");
    assert.strictEqual(r.reason, "codex_tool_call_block");
  }
  ok("F-W-TOOLBLOCK: pure tool_call envelope, blank user → DROP codex_tool_call_block");
  {
    const r = row("", RESULT, 2);
    assert.strictEqual(r.decision, "DROP");
    assert.strictEqual(r.reason, "codex_tool_call_block");
  }
  ok("F-W-TOOLBLOCK: pure tool_result envelope → DROP");
  {
    const r = row("", `\n${CALL}\n\n${RESULT}\n${CALL}\n`, 3);
    assert.strictEqual(r.decision, "DROP");
    assert.strictEqual(r.reason, "codex_tool_call_block");
  }
  ok("F-W-TOOLBLOCK: several envelopes back to back, surrounding whitespace → DROP");
  {
    const r = row("", `Checking the fixture inventory before touching the loader:\n\n${CALL}`, 4);
    assert.strictEqual(r.decision, "PASS");
  }
  ok("F-W-TOOLBLOCK: prose BEFORE the envelope → PASS (start anchor)");
  {
    const r = row("", `${RESULT}\n\nThe report shows bin A is stocked, so the loader change can go ahead.`, 5);
    assert.strictEqual(r.decision, "PASS");
  }
  ok("F-W-TOOLBLOCK: prose AFTER the envelope → PASS (end anchor)");
  {
    const r = row("please list the open items in the changelog and say which ones we can close", CALL, 6);
    assert.strictEqual(r.decision, "PASS");
  }
  ok("F-W-TOOLBLOCK: operator words on the user side → PASS (isEmpty(userText) guard)");
  {
    const r = row("", "[external_agent_tool_call: Bash]\ncommand: ls\n", 7);
    assert.notStrictEqual(r.reason, "codex_tool_call_block");
  }
  ok("F-W-TOOLBLOCK: an unterminated envelope is not a block");
}

console.log("# stage0/index.js (dispatcher)");
{
  const ev = { source: "imessage", raw_content: { text: "yeah for the meeting tuesday i was thinking 2-4", handle_id: "+15551234567" } };
  const r = stage0Dispatch(ev);
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.source, "imessage");
}
ok("dispatch imessage → matching module result");
{
  // F-NEW-W7-GIT-LOG-RULE1-TIGHTEN: subject prefix now requires
  // corroboration (parents=[] or is_initial_commit hint).
  const r = stage0Dispatch({ source: "git-log", raw_content: { subject: "Initial commit", parents: [] } });
  assert.strictEqual(r.decision, "DROP");
  // F-NEW-W2-GIT-LOG-STAGE0-INITIAL-COMMIT: see comment above on rename.
  assert.strictEqual(r.reason, "git_log_initial_commit_drop");
  assert.strictEqual(r.source, "git-log");
}
ok("dispatch git-log → matching module result");
{
  const r = stage0Dispatch({ source: "screentime", raw_content: { stream: "/discoverability/signals" } });
  assert.strictEqual(r.decision, "DROP");
}
ok("dispatch screentime → matching module result");
{
  const r = stage0Dispatch({ source: "github-events", raw_content: { event_type: "WatchEvent", actor_login: "x" } });
  assert.strictEqual(r.decision, "DROP");
}
ok("dispatch github-events → matching module result");
{
  // R28 Phase 2a — dispatcher routes codex-cli (sole agent-runtime hook source).
  const r = stage0Dispatch({ source: "codex-cli", raw_content: { user_text: null, assistant_text: null } });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "empty_turn");
  assert.strictEqual(r.source, "codex-cli");
}
ok("dispatch codex-cli → matching module result");
{
  // unknown source → PASS with reason "unknown_source"
  // F-NEW-W4-VERIFY-TEST-PIN: chat-claude-code is now a registered source-tier
  // module (Wave-2 wired it into the REGISTRY), so it is no longer "unknown".
  // Use a deliberately non-existent source name so this test continues to
  // exercise the dispatcher's unknown_source fallback invariant even as new
  // connectors land in the REGISTRY.
  const r = stage0Dispatch({ source: "fake-source-no-module", raw_content: { text: "hi" } });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.reason, "unknown_source");
  assert.strictEqual(r.source, "fake-source-no-module");
}
ok("unknown source → PASS unknown_source (forward-compat for non-source-tier connectors)");
{
  const r = stage0Dispatch(null);
  assert.strictEqual(r.decision, "PASS");
}
ok("null event → PASS (defensive)");
{
  const r = stage0Dispatch({ raw_content: {} });
  assert.strictEqual(r.decision, "PASS");
  assert.strictEqual(r.source, null);
}
ok("event without source field → PASS");
{
  const sources = listSources();
  // Source-tier stage0 modules (alphabetically sorted) — R25 baseline plus
  // every Phase 2/3 connector wired into the dispatcher. Future connectors
  // append here as they land in mcp/lib/ingest/stage0/index.js.
  const got = sources.slice().sort();
  // Required baseline: every entry here MUST be present. Additional entries
  // (e.g. mail after B1 wires it in) are allowed without failing the test.
  const required = [
    "codex-cli", "git-log", "github-events",
    "imessage", "screentime",
    "slack", "telegram", "whatsapp",
  ];
  for (const src of required) {
    assert.ok(got.includes(src),
      `listSources missing required source ${src}; got=${JSON.stringify(got)}`);
  }
}
ok("listSources returns the R25 (4) + R28/R28.1 (1) + R38 (2) + R39 (2) source-tier modules");
{
  const rules = getStructuralRules("imessage");
  assert.strictEqual(rules.substantive_prose, 0.85);
  assert.strictEqual(rules.tapback, 0.05);
  assert.deepStrictEqual(getStructuralRules("unknown"), {});
}
ok("getStructuralRules round-trips per-source rule table");

// ---------------------------------------------------------------------------
// Fixture round-trip — replay one representative row per ledger shape.
// Every row below is SYNTHETIC: invented ids, hashes, senders and subjects
// in the shape the Phase 2b connectors write to storage/sources/*.jsonl.
// No ledger file is read; the assertions document the expected stage0
// verdict per row shape.
// ---------------------------------------------------------------------------
console.log("# fixture replay (synthetic rows in ledger-row shape)");
{
  // imessage ledger shape: urn:biz business-chat automated assistant.
  const ev = JSON.parse(`{"id":"ulid_EXAMPLE0IMESSAGE00001","ts":"2026-01-01T00:00:00.000Z","source":"imessage","source_msg_id":"00000000-0000-4000-8000-000000000001","raw_content":{"text":"Hello, I'm Apple's automated assistant.","handle_id":"urn:biz:00000000-0000-4000-8000-0000000000a1","associated_message_type":0}}`);
  assert.strictEqual(stage0Dispatch(ev).decision, "DROP");
}
ok("fixture: Apple urn:biz assistant DM → DROP");
{
  // screentime ledger shape: discoverability/signals.
  const ev = JSON.parse(`{"id":"ulid_EXAMPLE0SCREENTIME001","source":"screentime","source_msg_id":"screentime:100001","raw_content":{"stream":"/discoverability/signals","signal":"com.apple.screencapture.invoke"}}`);
  assert.strictEqual(stage0Dispatch(ev).decision, "DROP");
}
ok("fixture: screentime discoverability_signals → DROP");
{
  // git-log ledger shape: a repository's initial commit.
  // F-NEW-W7-GIT-LOG-AUTHOR-SELF: operator-authored commits PASS at
  // structural_score >= 0.7 ahead of the initial-commit rule. This row's
  // author_email is in the operator identity the suite pins (the synthetic
  // identity file), so the row PASSes via the author-self pass-through
  // rather than dropping as an initial-commit variant. To exercise the
  // legacy DROP path, the test below uses a non-operator author email for
  // the same row shape.
  const evOperator = JSON.parse(`{"id":"ulid_EXAMPLE0GITLOG0000001","source":"git-log","source_msg_id":"git:1111111111111111111111111111111111111111","raw_content":{"subject":"Initial commit","author_email":"alex@example.com","parents":[]}}`);
  const operatorRes = stage0Dispatch(evOperator);
  assert.strictEqual(operatorRes.decision, "PASS");
  assert.strictEqual(operatorRes.reason, "git_log_operator_authored_passthrough");
}
ok("fixture: git-log 'Initial commit' by operator (synthetic row) → PASS via F-NEW-W7-GIT-LOG-AUTHOR-SELF");
{
  // Non-operator author with the same Initial commit + parents=[]
  // shape still routes through the legacy DROP path.
  const ev = JSON.parse(`{"id":"ulid_EXAMPLE0GITLOG0000001","source":"git-log","source_msg_id":"git:1111111111111111111111111111111111111111","raw_content":{"subject":"Initial commit","author_email":"someone-else@example.com","parents":[]}}`);
  assert.strictEqual(stage0Dispatch(ev).decision, "DROP");
}
ok("fixture: git-log 'Initial commit' (non-operator) → DROP");
{
  // git-log ledger shape: substantive follow-up commit.
  const ev = JSON.parse(`{"id":"ulid_EXAMPLE0GITLOG0000002","source":"git-log","source_msg_id":"git:2222222222222222222222222222222222222222","raw_content":{"subject":"uploading example-project to version control","author_email":"alex@example.com","parents":["1111111111111111111111111111111111111111"]}}`);
  assert.strictEqual(stage0Dispatch(ev).decision, "PASS");
}
ok("fixture: git-log substantive commit (synthetic row) → PASS");
{
  // github-events ledger shape: PullRequestEvent merged. The connector
  // row carries no actor_login; the module is defensive and PASSes when
  // the actor is unknown.
  const ev = JSON.parse(`{"id":"ulid_EXAMPLE0GHEVENTS00001","source":"github-events","source_msg_id":"gh-event:1000000001","raw_content":{"event_type":"PullRequestEvent","action":"merged","pr_number":6,"pr_title":null,"pr_author":null,"repo":"sam-sample/example-repo"}}`);
  const r = stage0Dispatch(ev);
  assert.strictEqual(r.decision, "PASS");
}
ok("fixture: PullRequestEvent merged row (no actor_login) → PASS");

// ---------------------------------------------------------------------------
// HERMETIC_POST_CHECK — A10 hermetic-stage0-tests (memory-roots).
// (1) Positive proof that the telemetry sink rebound to the scratch: the
//     dispatcher arm above recorded `fake-source-no-module`; flush it now
//     (the production path flushes on beforeExit, after this body has
//     finished) and read it back from <HERMETIC_TMP>/storage/telemetry/.
//     Flushing here also empties COUNTERS, so the beforeExit flush is a
//     no-op and the exit-time tripwire sees the complete picture.
// (2) Live tripwire: nothing fixture-marked was appended to the live sinks
//     (see the snapshot block at the top for why size identity is not used).
// ---------------------------------------------------------------------------
console.log("# HERMETIC_POST_CHECK — A10 hermetic-stage0-tests");
{
  assert.ok(
    process.env.MEMORY_ROOT === HERMETIC_TMP &&
      process.env.STORAGE_BASE_DIR.startsWith(HERMETIC_TMP) &&
      process.env.QUARANTINE_BASE_DIR.startsWith(HERMETIC_TMP),
    "all three roots must be pinned to HERMETIC_TMP"
  );
  const sink = currentSinkPath();
  assert.ok(
    sink.startsWith(HERMETIC_TMP),
    `telemetry sink must resolve under HERMETIC_TMP, got ${sink}`
  );
  const flushed = flushCounters({ flush_kind: "tick" });
  assert.strictEqual(flushed.wrote, true, "counters recorded by this run must flush");
  const expected = pathJoin(
    HERMETIC_TMP,
    "storage",
    "telemetry",
    `stage0_counters_${new Date().toISOString().slice(0, 10)}.jsonl`
  );
  assert.ok(existsSync(expected), `expected scratch telemetry file ${expected}`);
  const rows = readFileSync(expected, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  assert.ok(rows.length >= 1, "scratch telemetry file must hold >= 1 snapshot row");
  assert.ok(
    rows.some((l) => l.includes('"fake-source-no-module"')),
    "scratch telemetry snapshot must carry the fake-source-no-module counter"
  );
}
ok("HERMETIC_POST_CHECK positive proof: telemetry sink rebound to <HERMETIC_TMP>/storage/telemetry/stage0_counters_<utc-day>.jsonl and holds fake-source-no-module");
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

console.log(`\nPASS ${passed} assertions`);
