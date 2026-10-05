// mail-connector.test.mjs — R39 Phase 3 mail connector unit tests.
//
// Exercises lib/connectors/mail.js + lib/connectors/_mime-body-extractor.js +
// lib/ingest/stage0/mail.js against a synthetic Envelope Index (SQLite) and
// hand-written .emlx fixture bodies. NEVER reads the real
// ~/Library/Mail/V<N>/MailData/Envelope Index.
//
// Hermetic: TEST_ROOT under mkdtempSync; env vars set before dynamic import.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { skipIfDaemonActive } from "./_hermetic-daemon-skip.mjs";
skipIfDaemonActive("mail-connector");

// ---------------------------------------------------------------------------
// Hermetic root + env wiring — MUST precede dynamic imports.
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "mail-conn-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage", "sources"), { recursive: true });
mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.CONNECTORS_BASE_DIR = join(TEST_ROOT, "connectors");
// Operator identity is resolved once at module load: point it at the synthetic
// identity file before the dynamic imports below, and derive the operator
// address from that file instead of hardcoding one.
const IDENTITY_FILE = fileURLToPath(
  new URL("./fixtures/operator-identity.synthetic.json", import.meta.url),
);
process.env.MEMORY_OPERATOR_IDENTITY_FILE = IDENTITY_FILE;
const OPERATOR_EMAIL = JSON.parse(readFileSync(IDENTITY_FILE, "utf8")).emails[0];
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

// Production-safety snapshot.
const PROD_LEDGER = join(homedir(), "memory-system", "ledgers", "memory.jsonl");
let prodBefore = null;
try {
  const st = statSync(PROD_LEDGER);
  prodBefore = { mtimeMs: st.mtimeMs, size: st.size };
} catch {}

// ---------------------------------------------------------------------------
// Dynamic imports.
// ---------------------------------------------------------------------------
const {
  MailConnector,
  REFERENCES_MAX_CHARS,
  boundReferences,
  classifyMailRow,
  extractEmails,
  readEmlxBody,
} = await import("../lib/connectors/mail.js");
const {
  parseEmail,
  stripSignature,
  stripQuotedThread,
  htmlToText,
} = await import("../lib/connectors/_mime-body-extractor.js");
const { stage0: mailStage0 } = await import("../lib/ingest/stage0/mail.js");
const { runtimeCensusConvention } = await import("../scripts/audit-source-claims.mjs");
const { DatabaseSync } = await import("node:sqlite");

// ---------------------------------------------------------------------------
// Test harness.
// ---------------------------------------------------------------------------
let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const MAIL_SOURCE = new URL("../lib/connectors/mail.js", import.meta.url);
const mailCommentAudit = runtimeCensusConvention(
  readFileSync(MAIL_SOURCE, "utf8"),
  "lib/connectors/mail.js",
);
check(
  "mail source has a RUNTIME-CENSUS convention marker",
  mailCommentAudit.paragraphs.length > 0,
);
check(
  "mail RUNTIME-CENSUS comments name a producer and capture no result",
  mailCommentAudit.violations.length === 0,
  JSON.stringify(mailCommentAudit.violations),
);

const FIXTURE_SQL_PATH = new URL("./fixtures/mail-fixture-sql.sql", import.meta.url);
const FIXTURE_BODIES_DIR = new URL("./fixtures/mail-fixture-bodies/", import.meta.url);

function buildFixtureDb(dbPath) {
  const sql = readFileSync(FIXTURE_SQL_PATH, "utf8");
  if (existsSync(dbPath)) rmSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(sql);
  db.close();
}

function fixtureBodyResolver(documentId) {
  // map "msg-N" → fixtures/mail-fixture-bodies/msg-N.emlx
  // join(), not new URL(id, base): a production-shaped id like "rowid:16"
  // would parse as an absolute URL with its own scheme.
  const path = join(fileURLToPath(FIXTURE_BODIES_DIR), documentId + ".emlx");
  return existsSync(path) ? path : null;
}

function readLedger(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

async function runFixturePoll(dbName = "envelope.db") {
  const dbPath = join(TEST_ROOT, dbName);
  buildFixtureDb(dbPath);
  const ledgerPath = join(TEST_ROOT, "storage", "sources", `mail-${dbName}.jsonl`);
  const cursorPath = join(TEST_ROOT, "connectors", `mail-${dbName}`, "state.json");
  const c = new MailConnector({
    envelopeIndexPath: dbPath,
    sourceLedgerPath: ledgerPath,
    cursorPath,
    bodyResolver: fixtureBodyResolver,
  });
  const result = await c.pollOnce();
  const rows = readLedger(ledgerPath);
  const byMsgId = Object.fromEntries(rows.map((r) => [r.source_msg_id, r]));
  return { c, result, rows, byMsgId, ledgerPath, cursorPath };
}

// ===========================================================================
// T0 — extractor unit tests (signature strip, quote strip, html → text).
// ===========================================================================
console.log("\n--- T0: extractor unit tests ---");
{
  // Signature strip (RFC 3676).
  const sigInput = "Hello there\nMore content\n-- \nName\nemail@example.com";
  const sigOut = stripSignature(sigInput);
  check("T0.a stripSignature removes RFC 3676 sig block",
    sigOut === "Hello there\nMore content",
    `got=${JSON.stringify(sigOut)}`);

  // Quoted-text strip with introducer.
  const quoteInput =
    "I agree.\n\nOn Mon, 1 Jun 2026, alice wrote:\n> original message\n> another quoted line\n";
  const quoteOut = stripQuotedThread(quoteInput);
  check("T0.b stripQuotedThread removes introducer + quoted block",
    quoteOut === "I agree.",
    `got=${JSON.stringify(quoteOut)}`);

  // HTML → text.
  const htmlIn = "<p>Hello <strong>world</strong></p><ul><li>one</li><li>two</li></ul>";
  const htmlOut = htmlToText(htmlIn);
  check("T0.c htmlToText preserves list + paragraph structure",
    htmlOut.includes("Hello world") && htmlOut.includes("- one") && htmlOut.includes("- two"),
    `got=${JSON.stringify(htmlOut)}`);

  // extractEmails handles angle-bracket + bare forms.
  const emails = extractEmails('"Foo Bar" <foo@example.com>, baz@example.com');
  check("T0.d extractEmails parses both forms",
    emails.includes("foo@example.com") && emails.includes("baz@example.com"),
    `got=${JSON.stringify(emails)}`);
}

// ===========================================================================
// T1 — newsletter with Apple unsubscribe_type=1 → Stage-0 DROP via Apple signal.
//      Also verify the RFC List-Unsubscribe header path works in stage0.
// ===========================================================================
console.log("\n--- T1: newsletter Stage-0 DROP ---");
{
  const { result, byMsgId } = await runFixturePoll("env-t1.db");
  check("T1.a pollOnce appended 19 rows", result.appended === 19,
    `appended=${result.appended}`);
  const row = byMsgId["msg-1"];
  check("T1.b row for msg-1 exists", row != null);
  // The Apple unsubscribe_type column is the fast-path drop signal.
  check("T1.c raw_content.unsubscribe_type === 1",
    row?.raw_content?.unsubscribe_type === 1,
    `got=${row?.raw_content?.unsubscribe_type}`);
  // Verify the List-Unsubscribe header survived MIME extraction.
  check("T1.d headers.list-unsubscribe present",
    typeof row?.raw_content?.headers?.["list-unsubscribe"] === "string" &&
      row.raw_content.headers["list-unsubscribe"].length > 0);
  // Stage-0 must drop it.
  const decision = mailStage0(row);
  check("T1.e Stage-0 decision === DROP", decision.decision === "DROP");
  check("T1.f Stage-0 reason === list_unsubscribe",
    decision.reason === "list_unsubscribe", `got=${decision.reason}`);

  // Independent RFC-only path: synthesize a stripped row with no Apple signal
  // but a list-unsubscribe header. Stage-0 must still DROP.
  const rfcOnly = {
    source: "mail",
    raw_content: {
      text: "newsletter body",
      unsubscribe_type: 0,
      list_id_hash: null,
      automated_conversation: 0,
      headers: { "list-unsubscribe": "<mailto:u@example.com>" },
    },
  };
  const rfcDecision = mailStage0(rfcOnly);
  check("T1.g Stage-0 list-unsubscribe header alone triggers DROP",
    rfcDecision.decision === "DROP" && rfcDecision.reason === "list_unsubscribe",
    `got=${JSON.stringify(rfcDecision)}`);
}

// ===========================================================================
// T2 — 1:1 personal email (alice → operator) → second_party_dm.
// ===========================================================================
console.log("\n--- T2: 1:1 personal email → second_party_dm ---");
{
  const { byMsgId } = await runFixturePoll("env-t2.db");
  const row = byMsgId["msg-2"];
  check("T2.a row for msg-2 exists", row != null);
  check("T2.b consent_basis === second_party_dm",
    row?.source_policy?.consent_basis === "second_party_dm",
    `got=${row?.source_policy?.consent_basis}`);
  check("T2.c deletion_semantics === full_excise",
    row?.source_policy?.deletion_semantics === "full_excise");
  // Body text was extracted and stripped.
  check("T2.d raw_content.text contains the operator-new content",
    typeof row?.raw_content?.text === "string" &&
      row.raw_content.text.includes("coffee tomorrow at 10am"),
    `got=${JSON.stringify(row?.raw_content?.text)}`);
  // Stage-0 should PASS (no marketing signals).
  const decision = mailStage0(row);
  check("T2.e Stage-0 decision === PASS", decision.decision === "PASS",
    `got=${JSON.stringify(decision)}`);
  // Honest gate: body bytes were read AND parsed, so body_resolved is true.
  check("T2.f body_resolved true (body actually read + parsed)",
    row?.raw_content?.body_resolved === true,
    `got=${row?.raw_content?.body_resolved}`);
}

// ===========================================================================
// T3 — marketing email with mailchimp Return-Path → Stage-0 DROP.
// ===========================================================================
console.log("\n--- T3: mailchimp Return-Path → marketing_platform DROP ---");
{
  const { byMsgId } = await runFixturePoll("env-t3.db");
  const row = byMsgId["msg-3"];
  check("T3.a row for msg-3 exists", row != null);
  check("T3.b headers.return-path matches mailchimp",
    typeof row?.raw_content?.headers?.["return-path"] === "string" &&
      row.raw_content.headers["return-path"].includes("mailchimp.com"),
    `got=${row?.raw_content?.headers?.["return-path"]}`);
  const decision = mailStage0(row);
  check("T3.c Stage-0 decision === DROP", decision.decision === "DROP");
  check("T3.d Stage-0 reason === marketing_platform",
    decision.reason === "marketing_platform", `got=${decision.reason}`);
}

// ===========================================================================
// T4 — legitimate reply with quoted thread → operator-new text only.
// ===========================================================================
console.log("\n--- T4: reply with quoted thread → strip preserves new content ---");
{
  const { byMsgId } = await runFixturePoll("env-t4.db");
  const row = byMsgId["msg-4"];
  check("T4.a row for msg-4 exists", row != null);
  const text = row?.raw_content?.text || "";
  check("T4.b operator-new content preserved",
    text.includes("I agree with the proposed approach"),
    `got=${JSON.stringify(text)}`);
  check("T4.c quoted block stripped (no '> Here is the design')",
    !text.includes("> Here is the design") && !text.includes("Here is the design proposal"),
    `got=${JSON.stringify(text)}`);
  check("T4.d introducer 'On ... wrote:' stripped",
    !text.includes("On Sun, 31 May 2026"),
    `got=${JSON.stringify(text)}`);
}

// ===========================================================================
// T5 — RFC 3676 signature stripped.
// ===========================================================================
console.log("\n--- T5: RFC 3676 signature stripped ---");
{
  const { byMsgId } = await runFixturePoll("env-t5.db");
  const row = byMsgId["msg-5"];
  check("T5.a row for msg-5 exists", row != null);
  const text = row?.raw_content?.text || "";
  check("T5.b operator-new content preserved",
    text.includes("Are we still targeting end of"),
    `got=${JSON.stringify(text)}`);
  check("T5.c signature stripped (no 'Charlie Example' line)",
    !text.includes("+1-555-0100") && !text.includes("Charlie Example"),
    `got=${JSON.stringify(text)}`);
}

// ===========================================================================
// T6 — outbound from operator → first_party (identity-map canonical match).
//      Also assert deterministic source_msg_id (document_id is the stable id).
// ===========================================================================
console.log("\n--- T6: outbound from operator → first_party + deterministic id ---");
{
  const { byMsgId } = await runFixturePoll("env-t6.db");
  const row = byMsgId["msg-6"];
  check("T6.a row for msg-6 exists", row != null);
  check("T6.b consent_basis === first_party (the fixture From: is a registered operator address)",
    row?.source_policy?.consent_basis === "first_party",
    `got=${row?.source_policy?.consent_basis}`);
  check("T6.c source_msg_id === document_id (deterministic)",
    row?.source_msg_id === "msg-6",
    `got=${row?.source_msg_id}`);
  // Fixture date_received = 1780005000 (unix seconds, 2026-05-28T21:50:00Z).
  // The connector must convert via unix-seconds * 1000 → ISO.
  check("T6.d ts is the date_received converted to ISO",
    typeof row?.ts === "string" && row.ts === "2026-05-28T21:50:00.000Z",
    `got=${row?.ts}`);
}

// ===========================================================================
// T7-T14 — Stage-0 rule coverage extension (R39.1 F5).
// Each fixture row exercises one of the 11 Stage-0 rules; T1-T3 already
// covered rules 1+3, 2, and 8 (mailchimp). T7-T14 fill in the remaining
// 8: Auto-Submitted, Precedence:bulk, list-id-only, automated_conversation,
// noreply From, OTP regex, sendgrid Return-Path, and placeholder_residual
// from a calendar invite. Each assertion (a) confirms the row reached the
// ledger from a hermetic fixture poll and (b) confirms Stage-0 emits DROP
// (or REDACT_DROP for OTP) with the documented reason. Drop semantics is
// enforced at the salience layer; we verify the decision contract here so
// the salience scorer can rely on it.
// ===========================================================================
console.log("\n--- T7: Auto-Submitted: auto-replied → auto_submitted DROP ---");
{
  const { byMsgId } = await runFixturePoll("env-t7.db");
  const row = byMsgId["msg-7"];
  check("T7.a row for msg-7 exists", row != null);
  check("T7.b headers.auto-submitted starts with 'auto-'",
    typeof row?.raw_content?.headers?.["auto-submitted"] === "string" &&
      /^auto-/i.test(row.raw_content.headers["auto-submitted"]),
    `got=${row?.raw_content?.headers?.["auto-submitted"]}`);
  const decision = mailStage0(row);
  check("T7.c Stage-0 decision === DROP", decision.decision === "DROP");
  check("T7.d Stage-0 reason === auto_submitted",
    decision.reason === "auto_submitted", `got=${decision.reason}`);
}

console.log("\n--- T8: Precedence: bulk → bulk_precedence DROP ---");
{
  const { byMsgId } = await runFixturePoll("env-t8.db");
  const row = byMsgId["msg-8"];
  check("T8.a row for msg-8 exists", row != null);
  check("T8.b headers.precedence === 'bulk'",
    row?.raw_content?.headers?.["precedence"] === "bulk",
    `got=${row?.raw_content?.headers?.["precedence"]}`);
  const decision = mailStage0(row);
  check("T8.c Stage-0 decision === DROP", decision.decision === "DROP");
  check("T8.d Stage-0 reason === bulk_precedence",
    decision.reason === "bulk_precedence", `got=${decision.reason}`);
}

console.log("\n--- T9: List-Id only (no List-Unsubscribe) → list_id DROP ---");
{
  const { byMsgId } = await runFixturePoll("env-t9.db");
  const row = byMsgId["msg-9"];
  check("T9.a row for msg-9 exists", row != null);
  check("T9.b headers.list-id present",
    typeof row?.raw_content?.headers?.["list-id"] === "string" &&
      row.raw_content.headers["list-id"].length > 0,
    `got=${row?.raw_content?.headers?.["list-id"]}`);
  check("T9.c headers.list-unsubscribe absent",
    row?.raw_content?.headers?.["list-unsubscribe"] == null,
    `got=${row?.raw_content?.headers?.["list-unsubscribe"]}`);
  check("T9.d Apple list_id_hash null (exercises RFC path, not shortcut)",
    row?.raw_content?.list_id_hash === null,
    `got=${row?.raw_content?.list_id_hash}`);
  const decision = mailStage0(row);
  check("T9.e Stage-0 decision === DROP", decision.decision === "DROP");
  check("T9.f Stage-0 reason === list_id",
    decision.reason === "list_id", `got=${decision.reason}`);
}

console.log("\n--- T10: automated_conversation flag → apple_automated DROP ---");
{
  const { byMsgId } = await runFixturePoll("env-t10.db");
  const row = byMsgId["msg-10"];
  check("T10.a row for msg-10 exists", row != null);
  check("T10.b raw_content.automated_conversation === 1",
    row?.raw_content?.automated_conversation === 1,
    `got=${row?.raw_content?.automated_conversation}`);
  const decision = mailStage0(row);
  check("T10.c Stage-0 decision === DROP", decision.decision === "DROP");
  check("T10.d Stage-0 reason === apple_automated",
    decision.reason === "apple_automated", `got=${decision.reason}`);
}

console.log("\n--- T11: noreply From: → noreply_sender DROP ---");
{
  const { byMsgId } = await runFixturePoll("env-t11.db");
  const row = byMsgId["msg-11"];
  check("T11.a row for msg-11 exists", row != null);
  check("T11.b headers.from contains 'noreply'",
    typeof row?.raw_content?.headers?.["from"] === "string" &&
      /noreply/i.test(row.raw_content.headers["from"]),
    `got=${row?.raw_content?.headers?.["from"]}`);
  const decision = mailStage0(row);
  check("T11.c Stage-0 decision === DROP", decision.decision === "DROP");
  check("T11.d Stage-0 reason === noreply_sender",
    decision.reason === "noreply_sender", `got=${decision.reason}`);
}

console.log("\n--- T12: OTP / verification code → otp_pattern REDACT_DROP ---");
{
  const { byMsgId } = await runFixturePoll("env-t12.db");
  const row = byMsgId["msg-12"];
  check("T12.a row for msg-12 exists", row != null);
  check("T12.b raw_content.text contains 'verification code'",
    typeof row?.raw_content?.text === "string" &&
      /verification code/i.test(row.raw_content.text),
    `got=${JSON.stringify(row?.raw_content?.text)}`);
  const decision = mailStage0(row);
  check("T12.c Stage-0 decision === REDACT_DROP",
    decision.decision === "REDACT_DROP", `got=${decision.decision}`);
  check("T12.d Stage-0 reason === otp_pattern",
    decision.reason === "otp_pattern", `got=${decision.reason}`);
}

console.log("\n--- T13: sendgrid Return-Path → marketing_platform DROP ---");
{
  const { byMsgId } = await runFixturePoll("env-t13.db");
  const row = byMsgId["msg-13"];
  check("T13.a row for msg-13 exists", row != null);
  check("T13.b headers.return-path matches sendgrid",
    typeof row?.raw_content?.headers?.["return-path"] === "string" &&
      /sendgrid\.net/i.test(row.raw_content.headers["return-path"]),
    `got=${row?.raw_content?.headers?.["return-path"]}`);
  const decision = mailStage0(row);
  check("T13.c Stage-0 decision === DROP", decision.decision === "DROP");
  check("T13.d Stage-0 reason === marketing_platform",
    decision.reason === "marketing_platform", `got=${decision.reason}`);
}

console.log("\n--- T14: multipart/calendar empty body → placeholder_residual DROP ---");
{
  const { byMsgId } = await runFixturePoll("env-t14.db");
  const row = byMsgId["msg-14"];
  check("T14.a row for msg-14 exists", row != null);
  check("T14.b headers.content-type starts with 'multipart/calendar'",
    typeof row?.raw_content?.headers?.["content-type"] === "string" &&
      /^multipart\/calendar/i.test(row.raw_content.headers["content-type"]),
    `got=${row?.raw_content?.headers?.["content-type"]}`);
  const text = row?.raw_content?.text || "";
  check("T14.c body text trims to < 2 chars",
    text.trim().length < 2, `text=${JSON.stringify(text)}`);
  const decision = mailStage0(row);
  check("T14.d Stage-0 decision === DROP", decision.decision === "DROP");
  check("T14.e Stage-0 reason === placeholder_residual",
    decision.reason === "placeholder_residual", `got=${decision.reason}`);
}

// ===========================================================================
// T15 — cursor restart is idempotent (deterministic dedup on document_id).
// ===========================================================================
console.log("\n--- T15: cursor restart idempotent ---");
{
  const dbPath = join(TEST_ROOT, "env-t15.db");
  buildFixtureDb(dbPath);
  const ledgerPath = join(TEST_ROOT, "storage", "sources", "mail-t15.jsonl");
  const cursorPath = join(TEST_ROOT, "connectors", "mail-t15", "state.json");
  const c1 = new MailConnector({
    envelopeIndexPath: dbPath,
    sourceLedgerPath: ledgerPath,
    cursorPath,
    bodyResolver: fixtureBodyResolver,
  });
  const r1 = await c1.runOnce();
  check("T15.a first runOnce appended 19 rows", r1.appended === 19,
    `appended=${r1.appended}`);
  const c2 = new MailConnector({
    envelopeIndexPath: dbPath,
    sourceLedgerPath: ledgerPath,
    cursorPath,
    bodyResolver: fixtureBodyResolver,
  });
  const r2 = await c2.runOnce();
  check("T15.b second runOnce appended 0", r2.appended === 0,
    `appended=${r2.appended}`);
  const cursorState = JSON.parse(readFileSync(cursorPath, "utf8"));
  check("T15.c cursor.last_message_rowid === 19",
    cursorState.last_message_rowid === 19,
    `cursor=${JSON.stringify(cursorState)}`);
}

// ===========================================================================
// T16 — pollOnce against an absent Envelope Index → graceful error.
// ===========================================================================
console.log("\n--- T16: absent Envelope Index ---");
{
  const missingDb = join(TEST_ROOT, "does-not-exist.db");
  const ledgerPath = join(TEST_ROOT, "storage", "sources", "mail-t16.jsonl");
  const cursorPath = join(TEST_ROOT, "connectors", "mail-t16", "state.json");
  const c = new MailConnector({
    envelopeIndexPath: missingDb,
    sourceLedgerPath: ledgerPath,
    cursorPath,
    bodyResolver: fixtureBodyResolver,
  });
  const r = await c.pollOnce();
  check("T16.a pollOnce did not throw and reports errors=1", r.errors === 1,
    `result=${JSON.stringify(r)}`);
  check("T16.b appended=0", r.appended === 0);
  const cursorState = existsSync(cursorPath)
    ? JSON.parse(readFileSync(cursorPath, "utf8"))
    : null;
  check("T16.c last_error_kind === envelope_index_absent",
    cursorState?.last_error_kind === "envelope_index_absent",
    `kind=${cursorState?.last_error_kind}`);
}

// ===========================================================================
// T17 — readEmlxBody slices via leading byte-count header.
// ===========================================================================
console.log("\n--- T17: readEmlxBody slices via byte-count header ---");
{
  const bodyPath = fixtureBodyResolver("msg-2");
  check("T17.a fixture body resolves", typeof bodyPath === "string");
  const sliced = readEmlxBody(bodyPath);
  check("T17.b sliced is a Buffer", Buffer.isBuffer(sliced));
  // The sliced region MUST start with "From: " (the RFC 5322 first header)
  // and MUST NOT contain the binary <?xml plist trailer.
  const str = sliced.toString("utf8");
  check("T17.c sliced starts with 'From: '",
    str.startsWith("From: "), `prefix=${JSON.stringify(str.slice(0, 16))}`);
  check("T17.d sliced does NOT contain plist trailer",
    !str.includes("<?xml") && !str.includes("<plist"),
    "trailer leaked into RFC 5322 region");
  // parseEmail on the sliced bytes round-trips to the operator-new content.
  const parsed = parseEmail(sliced);
  check("T17.e parseEmail extracts body text",
    parsed.text != null && parsed.text.includes("coffee tomorrow"),
    `got=${JSON.stringify(parsed.text)}`);
}

// ===========================================================================
// T18 — classifyMailRow inheritance check (group-To → third_party_inferred).
// ===========================================================================
console.log("\n--- T18: classifyMailRow group-To → third_party_inferred ---");
{
  const identityMap = {
    canonical: "operator@example.com",
    aliases: new Set(["operator@example.com", "operator.alias@example.org"]),
  };
  // operator + alice are both in To: → group, classify as third_party_inferred.
  const group = classifyMailRow(
    { from: "bob@example.com", to: "operator@example.com, alice@example.com", cc: "" },
    identityMap,
  );
  check("T18.a group inbound → third_party_inferred",
    group.consent_basis === "third_party_inferred",
    `got=${group.consent_basis}`);
  // Operator-only To: → second_party_dm.
  const dm = classifyMailRow(
    { from: "bob@example.com", to: "operator@example.com", cc: "" },
    identityMap,
  );
  check("T18.b solo inbound → second_party_dm",
    dm.consent_basis === "second_party_dm",
    `got=${dm.consent_basis}`);
  // Operator From: → first_party (regardless of To: shape).
  const out = classifyMailRow(
    { from: "operator.alias@example.org", to: "alice@example.com, bob@example.com", cc: "" },
    identityMap,
  );
  check("T18.c operator From: → first_party",
    out.consent_basis === "first_party",
    `got=${out.consent_basis}`);
}

// ===========================================================================
// T19 — 64-bit list_id_hash overflow row (L29/L30 regression coverage).
// Fixture ROWID 15 carries a list_id_hash >= 2^53 (a 19-digit value, the shape
// that overflows a JS safe integer). Pre-fix, node:sqlite's
// stmt.all() threw ERR_OUT_OF_RANGE on the FIRST batch containing any such
// row, the cursor never advanced, and the connector never appended anything
// (error_count 3,886+ opaque envelope_index_query_run_failed). The connector
// now CASTs the column AS TEXT (L30); this block proves the poll survives
// the overflow row AND that Stage-0 Rule 2 still fires on the Number()-coerced
// (lossy-but-nonzero) value.
// ===========================================================================
console.log("\n--- T19: list_id_hash >= 2^53 survives poll → list_id DROP ---");
{
  const { result, byMsgId } = await runFixturePoll("env-t19.db");
  // The batch containing the overflow row must not throw — every fixture
  // row lands, not just the ones below 2^53.
  check("T19.a pollOnce survived the >= 2^53 row (appended 19, errors 0)",
    result.appended === 19 && result.errors === 0,
    `result=${JSON.stringify(result)}`);
  const row = byMsgId["msg-15"];
  check("T19.b row for msg-15 exists", row != null);
  // Number() of that 19-digit TEXT value is lossy above 2^53 but finite + nonzero —
  // exactly what Stage-0's null/zero/nonzero boolean check needs.
  check("T19.c raw_content.list_id_hash is a finite nonzero number",
    typeof row?.raw_content?.list_id_hash === "number" &&
      Number.isFinite(row.raw_content.list_id_hash) &&
      row.raw_content.list_id_hash !== 0,
    `got=${row?.raw_content?.list_id_hash} (${typeof row?.raw_content?.list_id_hash})`);
  check("T19.d list_id_hash magnitude preserved (>= 2^53)",
    row?.raw_content?.list_id_hash >= 2 ** 53,
    `got=${row?.raw_content?.list_id_hash}`);
  const decision = mailStage0(row);
  check("T19.e Stage-0 decision === DROP", decision.decision === "DROP",
    `got=${JSON.stringify(decision)}`);
  check("T19.f Stage-0 reason === list_id",
    decision.reason === "list_id", `got=${decision.reason}`);
  // Honest gate: msg-15 has no .emlx fixture on purpose — body_resolved
  // must be false (previously it could only be false when the PATH was
  // missing; now it is false whenever no body was actually extracted).
  check("T19.g body_resolved honestly false for the orphan envelope",
    row?.raw_content?.body_resolved === false,
    `got=${row?.raw_content?.body_resolved}`);
}

// ===========================================================================
// T20 — production-shaped document_id (NULL / BLOB) + defaultBodyResolver.
// In the real Envelope Index (verified read-only 2026-07-10) document_id is
// NULL on 277,815/277,920 rows and a 16-byte binary BLOB on the rest — the
// friendly-TEXT ids used by T1-T19 never occur in production. .emlx
// basenames are the messages.ROWID (123,104/278,516 real files are
// `<n>.partial.emlx`). This block runs a poll with NO injected bodyResolver:
// opts.mailRoot points at a synthetic V10-shaped tree so the connector's own
// defaultBodyResolver must map 'rowid:<n>' → <n>.emlx / <n>.partial.emlx.
//   (A) ROWID 16, NULL document_id, on-disk 16.emlx (+ decoy 16.partial.emlx)
//       → body_resolved true, non-empty text, full file preferred.
//   (B) ROWID 18, NULL document_id, no file on disk → body_resolved false,
//       no throw, row still appended with JOIN-synthesized From.
//   (C) ROWID 17, BLOB document_id, ONLY 17.partial.emlx on disk → resolves.
//   (D) BLOB behaves exactly like NULL: source_msg_id is 'rowid:17'.
// ===========================================================================
console.log("\n--- T20: NULL/BLOB document_id resolve bodies via defaultBodyResolver ---");
{
  const dbPath = join(TEST_ROOT, "env-t20.db");
  buildFixtureDb(dbPath);
  const ledgerPath = join(TEST_ROOT, "storage", "sources", "mail-t20.jsonl");
  const cursorPath = join(TEST_ROOT, "connectors", "mail-t20", "state.json");

  // Synthetic V10-shaped tree:
  //   <mailRoot>/<acct-uuid>/INBOX.mbox/<uuid>/Data/<sharded>/Messages/<ROWID>.emlx
  // Valid byte-count-header .emlx bytes: "<count>\n<RFC 5322>\n<plist>".
  function makeEmlx(message) {
    const body = Buffer.from(message, "utf8");
    const trailer = Buffer.from(
      '\n<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict/></plist>\n',
      "utf8",
    );
    return Buffer.concat([Buffer.from(`${body.length}\n`, "ascii"), body, trailer]);
  }
  const mailRoot = join(TEST_ROOT, "mail-root-t20");
  const mboxData = join(
    mailRoot,
    "AAAAAAAA-0000-0000-0000-000000000000",
    "INBOX.mbox",
    "BBBBBBBB-1111-2222-3333-444444444444",
    "Data",
  );
  const messagesA = join(mboxData, "0", "Messages");
  const messagesB = join(mboxData, "7", "1", "Messages");
  mkdirSync(messagesA, { recursive: true });
  mkdirSync(messagesB, { recursive: true });
  writeFileSync(join(messagesA, "16.emlx"), makeEmlx(
    "From: Dana Example <dana@example.com>\n" +
    `To: ${OPERATOR_EMAIL}\n` +
    "Subject: Production-shaped NULL document id\n" +
    "Date: Wed, 10 Jun 2026 09:00:00 +0000\n" +
    "Message-ID: <rowid-16@example.com>\n" +
    "Content-Type: text/plain; charset=utf-8\n" +
    "\n" +
    "Full emlx body resolved by ROWID basename.\n",
  ));
  // Decoy partial variant for the SAME rowid — the full .emlx must win.
  writeFileSync(join(messagesA, "16.partial.emlx"), makeEmlx(
    "From: Dana Example <dana@example.com>\n" +
    `To: ${OPERATOR_EMAIL}\n` +
    "Subject: Production-shaped NULL document id\n" +
    "Content-Type: text/plain; charset=utf-8\n" +
    "\n" +
    "PARTIAL-VARIANT decoy body that must NOT be preferred.\n",
  ));
  // ROWID 17 exists ONLY as a .partial.emlx, in a different shard dir.
  writeFileSync(join(messagesB, "17.partial.emlx"), makeEmlx(
    "From: Evan Example <evan@example.com>\n" +
    `To: ${OPERATOR_EMAIL}\n` +
    "Subject: Production-shaped BLOB document id\n" +
    "Date: Wed, 10 Jun 2026 10:00:00 +0000\n" +
    "Message-ID: <rowid-17@example.com>\n" +
    "Content-Type: text/plain; charset=utf-8\n" +
    "\n" +
    "Partial emlx body resolved for a BLOB document id row.\n",
  ));

  // NO bodyResolver injected — the connector must build its own from mailRoot.
  const c = new MailConnector({
    envelopeIndexPath: dbPath,
    sourceLedgerPath: ledgerPath,
    cursorPath,
    mailRoot,
  });
  const result = await c.pollOnce();
  const rows = readLedger(ledgerPath);
  const byMsgId = Object.fromEntries(rows.map((r) => [r.source_msg_id, r]));

  check("T20.a poll appended all 19 rows with 0 errors (no throw on NULL/BLOB)",
    result.appended === 19 && result.errors === 0,
    `result=${JSON.stringify(result)}`);

  // (A) NULL document_id + on-disk <ROWID>.emlx.
  const r16 = byMsgId["rowid:16"];
  check("T20.b NULL document_id → source_msg_id 'rowid:16' (idempotency key intact)",
    r16 != null, `ids=${JSON.stringify(rows.map((r) => r.source_msg_id))}`);
  check("T20.c body_resolved true via ROWID-basename .emlx",
    r16?.raw_content?.body_resolved === true,
    `got=${r16?.raw_content?.body_resolved}`);
  const text16 = r16?.raw_content?.text || "";
  check("T20.d non-empty text extracted from 16.emlx",
    text16.includes("Full emlx body resolved by ROWID basename"),
    `got=${JSON.stringify(text16)}`);
  check("T20.e full .emlx preferred over the .partial.emlx decoy",
    !text16.includes("PARTIAL-VARIANT"), `got=${JSON.stringify(text16)}`);

  // (C)+(D) BLOB document_id behaves like NULL; .partial.emlx-only resolves.
  const r17 = byMsgId["rowid:17"];
  check("T20.f BLOB document_id → source_msg_id 'rowid:17' (same fallback as NULL)",
    r17 != null, `ids=${JSON.stringify(rows.map((r) => r.source_msg_id))}`);
  check("T20.g .partial.emlx-only body resolves (body_resolved true)",
    r17?.raw_content?.body_resolved === true,
    `got=${r17?.raw_content?.body_resolved}`);
  check("T20.h text extracted from 17.partial.emlx",
    (r17?.raw_content?.text || "").includes("Partial emlx body resolved"),
    `got=${JSON.stringify(r17?.raw_content?.text)}`);

  // (B) NULL document_id, no file on disk → honest false, row still lands.
  const r18 = byMsgId["rowid:18"];
  check("T20.i missing .emlx → row still appended (no throw)", r18 != null,
    `ids=${JSON.stringify(rows.map((r) => r.source_msg_id))}`);
  check("T20.j missing .emlx → body_resolved honestly false",
    r18?.raw_content?.body_resolved === false,
    `got=${r18?.raw_content?.body_resolved}`);
  check("T20.k From synthesized from the addresses JOIN",
    typeof r18?.raw_content?.headers?.from === "string" &&
      r18.raw_content.headers.from.includes("orphan@example.com"),
    `got=${r18?.raw_content?.headers?.from}`);
}

// ---------------------------------------------------------------------------
// T21 — RECIPIENT RECOVERY: an operator-authored row with NO body still
// carries its To:/Cc: counterparties.
//
// Regression. To:/Cc: were read only from the parsed .emlx body, but Sent mail
// almost never resolves one — 2,728 of 2,744 operator-authored rows on the real
// store had body_resolved=false. So headers.to was absent, parties[] collapsed
// to the sender alone, and only 0.5% of outbound mail carried any counterparty:
// the entire outbound half of the correspondence graph was missing. Recovering
// recipients from the envelope DB lifted that to 99.7% and surfaced 448 distinct
// correspondents where 6 were visible before.
//
// ROWID 18 is the orphan-envelope row — no .emlx body at all, which is the
// production shape for Sent mail. Its From: was already synthesised from the
// addresses JOIN; To:/Cc: are the other half of that same gap.
// ---------------------------------------------------------------------------
{
  const { rows, byMsgId } = await runFixturePoll("envelope-recipients.db");
  const outbound = byMsgId["rowid:18"];
  check("T21.a no-body row present", outbound != null,
    `ids=${rows.map((r) => r.source_msg_id).join(",")}`);
  if (outbound) {
    const parties = outbound.parties || [];
    check("T21.b body did NOT resolve (the condition this fixes)",
      outbound.raw_content?.body_resolved === false,
      `body_resolved=${outbound.raw_content?.body_resolved}`);
    check("T21.c To: recipient recovered into parties",
      parties.includes("alice@example.com"), `parties=${JSON.stringify(parties)}`);
    check("T21.d Cc: recipient recovered into parties",
      parties.includes("bob@example.com"), `parties=${JSON.stringify(parties)}`);
    check("T21.e sender still present (no regression)",
      parties.includes("orphan@example.com"), `parties=${JSON.stringify(parties)}`);
  }
}

// ---------------------------------------------------------------------------
// T22 — THREAD REPLY LINKAGE: In-Reply-To / References reach raw_content.
//
// Regression + capability. splitHeadersAndBody (_mime-body-extractor.js) has
// always folded and collected EVERY header line into a complete lowercased
// map, and parseEmail returns it — so In-Reply-To and References were FETCHED
// AND DISCARDED, not never-requested: _buildLedgerRow copied a hand-written
// allowlist into raw_content.headers and dropped the rest. The consequence was
// that no mail row carried thread linkage, and lib/messaging/adapters/mail.js
// (_threadId / _replyToId) had nothing to resolve against on a real connector
// row. Measured on the live ledger tail before the change: 0 of 2,826 rows
// carried either field.
//
// The keys must be PRESENT-AND-NULL when the source header is absent (never
// omitted), including on the body_resolved=false orphan-envelope path, which
// is 97.45% of the real ledger.
// ---------------------------------------------------------------------------
console.log("\n--- T22: In-Reply-To / References surfaced on raw_content.headers ---");
{
  const { byMsgId } = await runFixturePoll("env-t22.db");

  // (1) The reply row: both fields land, verbatim, beside the message-id.
  const reply = byMsgId["msg-19"];
  check("T22.a reply row for msg-19 exists", reply != null);
  check("T22.b body resolved (the reply headers really came from the .emlx)",
    reply?.raw_content?.body_resolved === true,
    `got=${reply?.raw_content?.body_resolved}`);
  check("T22.c headers['in-reply-to'] === the parent Message-ID",
    reply?.raw_content?.headers?.["in-reply-to"] === "<msg-19-parent@example.com>",
    `got=${JSON.stringify(reply?.raw_content?.headers?.["in-reply-to"])}`);
  // The fixture folds References across two physical lines; splitHeadersAndBody
  // rejoins continuations with a single space, so the chain arrives whole and
  // oldest-first (root then immediate parent).
  check("T22.d headers['references'] === the folded two-id chain, oldest first",
    reply?.raw_content?.headers?.["references"] ===
      "<msg-19-root@example.com> <msg-19-parent@example.com>",
    `got=${JSON.stringify(reply?.raw_content?.headers?.["references"])}`);
  check("T22.e headers['message-id'] still populated (no regression on the key beside it)",
    reply?.raw_content?.headers?.["message-id"] === "<msg-19-child@example.com>",
    `got=${JSON.stringify(reply?.raw_content?.headers?.["message-id"])}`);

  // (2) FAIL-SOFT on a body-resolved row with NO reply headers: null, not absent.
  const plain = byMsgId["msg-2"];
  check("T22.f non-reply row exists and its body resolved",
    plain != null && plain.raw_content?.body_resolved === true,
    `got=${plain?.raw_content?.body_resolved}`);
  const plainHeaders = plain?.raw_content?.headers || {};
  check("T22.g non-reply row: in-reply-to is PRESENT and null",
    "in-reply-to" in plainHeaders && plainHeaders["in-reply-to"] === null,
    `present=${"in-reply-to" in plainHeaders} value=${JSON.stringify(plainHeaders["in-reply-to"])}`);
  check("T22.h non-reply row: references is PRESENT and null",
    "references" in plainHeaders && plainHeaders["references"] === null,
    `present=${"references" in plainHeaders} value=${JSON.stringify(plainHeaders["references"])}`);

  // (3) FAIL-SOFT on the ORPHAN-ENVELOPE path — no .emlx at all, headers
  // synthesized from the addresses/recipients joins. 97.45% of real rows.
  const orphan = byMsgId["rowid:18"];
  check("T22.i orphan-envelope row exists with body_resolved false",
    orphan != null && orphan.raw_content?.body_resolved === false,
    `got=${orphan?.raw_content?.body_resolved}`);
  const orphanHeaders = orphan?.raw_content?.headers || {};
  check("T22.j orphan row: in-reply-to PRESENT and null (never implies body resolution)",
    "in-reply-to" in orphanHeaders && orphanHeaders["in-reply-to"] === null,
    `present=${"in-reply-to" in orphanHeaders} value=${JSON.stringify(orphanHeaders["in-reply-to"])}`);
  check("T22.k orphan row: references PRESENT and null",
    "references" in orphanHeaders && orphanHeaders["references"] === null,
    `present=${"references" in orphanHeaders} value=${JSON.stringify(orphanHeaders["references"])}`);

  // (4) ADDITIVE ROW SHAPE — the pre-existing 13 keys are still all there and
  // the header object is a strict SUPERSET. Downstream readers that enumerate
  // it (stage0/mail.js, adapters/mail.js _headersMap) must never see a
  // different set, only a larger one.
  const PRE_EXISTING_KEYS = [
    "from", "to", "cc", "subject", "message-id", "list-id", "list-unsubscribe",
    "auto-submitted", "precedence", "return-path", "content-type",
    "dkim-signature", "authentication-results",
  ];
  const missing = PRE_EXISTING_KEYS.filter((k) => !(k in plainHeaders));
  check("T22.l all 13 pre-existing header keys still present (superset, not a new set)",
    missing.length === 0, `missing=${JSON.stringify(missing)}`);
  const extra = Object.keys(plainHeaders)
    .filter((k) => !PRE_EXISTING_KEYS.includes(k))
    .sort();
  check("T22.m exactly two keys added",
    extra.length === 2 && extra[0] === "in-reply-to" && extra[1] === "references",
    `extra=${JSON.stringify(extra)}`);
}

// ---------------------------------------------------------------------------
// T23 — boundReferences: References is the one header that grows without
// bound (every reply appends its parent id), so it is capped. Truncation must
// preserve BOTH ENDS, because adapters/mail.js reads the chain from opposite
// directions: _threadId takes refs[0] (thread ROOT) and _replyToId takes
// refs[refs.length-1] (immediate PARENT). A naive head- or tail-slice breaks
// exactly one of the two, silently.
// ---------------------------------------------------------------------------
console.log("\n--- T23: boundReferences preserves root AND parent ---");
{
  check("T23.a absent header → null (fail-soft, never throws)",
    boundReferences(undefined) === null && boundReferences(null) === null &&
      boundReferences("") === null,
    `got=${JSON.stringify([boundReferences(undefined), boundReferences(null), boundReferences("")])}`);

  // Under the cap: byte-identical pass-through. This is every real row today
  // (measured max References length on the live tail: 134 chars).
  const short = "<root@example.com> <mid@example.com> <parent@example.com>";
  check("T23.b under the cap → passed through unchanged",
    boundReferences(short) === short, `got=${JSON.stringify(boundReferences(short))}`);

  // Over the cap: build a chain long enough to trip REFERENCES_MAX_CHARS.
  const ids = [];
  for (let i = 0; i < 400; i += 1) ids.push(`<chain-${String(i).padStart(4, "0")}@example.com>`);
  const deep = ids.join(" ");
  check("T23.c the synthetic deep chain really exceeds the cap",
    deep.length > REFERENCES_MAX_CHARS, `len=${deep.length}`);
  const bounded = boundReferences(deep);
  check("T23.d bounded value is shorter than the input",
    bounded.length < deep.length, `len=${bounded.length} of ${deep.length}`);

  // The load-bearing property: BOTH ends survive.
  const boundedIds = bounded.match(/<[^<>]+>/g) || [];
  check("T23.e FIRST id preserved → _threadId (thread ROOT) still resolves",
    boundedIds[0] === ids[0], `got=${JSON.stringify(boundedIds[0])} want=${ids[0]}`);
  check("T23.f LAST id preserved → _replyToId (immediate PARENT) still resolves",
    boundedIds[boundedIds.length - 1] === ids[ids.length - 1],
    `got=${JSON.stringify(boundedIds[boundedIds.length - 1])} want=${ids[ids.length - 1]}`);
  check("T23.g only the interior was dropped",
    boundedIds.length > 1 && boundedIds.length < ids.length,
    `kept=${boundedIds.length} of ${ids.length}`);

  // Over the cap but with nothing parseable: still bounded, still no throw.
  const junk = "x".repeat(REFERENCES_MAX_CHARS + 500);
  const junkOut = boundReferences(junk);
  check("T23.h unparseable over-cap value is bounded, not thrown on",
    typeof junkOut === "string" && junkOut.length === REFERENCES_MAX_CHARS,
    `len=${junkOut && junkOut.length}`);
}

// ---------------------------------------------------------------------------
// PROD-SAFETY: production memory.jsonl unchanged.
// ---------------------------------------------------------------------------
let prodAfter = null;
try {
  const st = statSync(PROD_LEDGER);
  prodAfter = { mtimeMs: st.mtimeMs, size: st.size };
} catch {}
if (prodBefore != null && prodAfter != null) {
  const intact = prodBefore.mtimeMs === prodAfter.mtimeMs &&
    prodBefore.size === prodAfter.size;
  check("PROD-SAFETY production memory.jsonl mtime+size unchanged", intact,
    `before=${JSON.stringify(prodBefore)} after=${JSON.stringify(prodAfter)}`);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll mail-connector assertions passed.`);
