// imessage-connector.test.mjs — Phase 2b iMessage connector unit tests.
//
// Exercises lib/connectors/imessage.js against a synthetic chat.db built
// from test/fixtures/imessage-fixture.sql. NEVER reads the real macOS
// ~/Library/Messages/chat.db.
//
// Edge cases covered (one per round-20 classifier rule + structural cases):
//   T1: outbound (is_from_me=1) → first_party
//   T2: inbound 1:1 → second_party_dm
//   T3: inbound group (cache_roomnames + participant_count=3) → third_party_inferred
//   T4: business iMessage (handle.id BIZ:42, service=BusinessChat) → third_party_inferred
//   T5: tapback (associated_message_type=2000) → kind:reaction, derived_from set
//   T6: reply (thread_originator_guid set) → raw_content.in_reply_to set;
//       consent NOT inherited (still classified by THIS message's is_from_me)
//   T7: cursor restart — runOnce twice; second appends 0 (dedupe on guid).
//   T8: pollOnce against an absent chat.db → graceful error, errors=1.
//   T9: attributedBody-only inbound + outbound rows decoded via
//       parseTypedstream; raw_content.text == known plaintext (byte-exact);
//       raw_content.text_source === "attributedBody".
//   T10: corrupt attributedBody → decoder returns null; raw_content.text
//        falls back to legacy m.text; raw_content.attributedBody_decode_error
//        === true.
//
// HERMETICITY: TEST_ROOT under mkdtempSync, env vars before dynamic import.
// The live install's paths are pre-snapshot'd to
// confirm no leak.

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

import { skipIfDaemonActive } from "./_hermetic-daemon-skip.mjs";
skipIfDaemonActive("imessage-connector");

// ---------------------------------------------------------------------------
// Hermetic root + env wiring — MUST precede dynamic imports.
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "imessage-conn-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage", "sources"), { recursive: true });
mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.CONNECTORS_BASE_DIR = join(TEST_ROOT, "connectors");
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
const { IMessageConnector, decodeAttributedBody, classifyRow } = await import(
  "../lib/connectors/imessage.js"
);
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

// Build a synthetic chat.db at the given path from the SQL fixture.
function buildFixtureDb(dbPath) {
  const sql = readFileSync(
    new URL("./fixtures/imessage-fixture.sql", import.meta.url),
    "utf8",
  );
  if (existsSync(dbPath)) rmSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(sql);
  db.close();
}

// Helper to read the source ledger file as parsed rows.
function readLedger(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// Standard fixture-poll harness used by T1-T6. Builds the fixture, runs
// pollOnce, returns the ledger rows by source_msg_id.
async function runFixturePoll(dbName = "chat.db") {
  const dbPath = join(TEST_ROOT, dbName);
  buildFixtureDb(dbPath);
  const c = new IMessageConnector({ chatDbPath: dbPath });
  const result = await c.pollOnce();
  const ledgerPath = join(TEST_ROOT, "storage", "sources", "imessage.jsonl");
  const rows = readLedger(ledgerPath);
  const byGuid = Object.fromEntries(rows.map((r) => [r.source_msg_id, r]));
  return { c, result, rows, byGuid, ledgerPath };
}

// ===========================================================================
// T0 — decodeAttributedBody handles a hand-crafted NSKeyedArchiver blob.
// (Bonus unit test for the decoder; the fixture rows all have non-null text.)
// ===========================================================================
console.log("\n--- T0: decodeAttributedBody single-byte length ---");
{
  // Build a synthetic blob: header bytes + "NSString" marker + 0x81 0x05
  // + "hello" + trailing junk. The decoder should extract "hello".
  const text = "hello world";
  const lenByte = text.length; // < 0x80 so single-byte length prefix works
  const blob = Buffer.concat([
    Buffer.from([0x04, 0x0b, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]), // bogus framing
    Buffer.from("NSString", "utf8"),
    Buffer.from([0x86, 0x84]), // class signature framing
    Buffer.from([0x01]), // type code
    Buffer.from([lenByte]), // single-byte length
    Buffer.from(text, "utf8"),
    Buffer.from([0x86, 0x84, 0x00]), // trailing junk
  ]);
  const decoded = decodeAttributedBody(blob);
  check("T0.a decodeAttributedBody extracts text from single-byte-len blob",
    decoded === text, `got=${JSON.stringify(decoded)}`);

  // Junk blob → null
  const junk = Buffer.from([0xff, 0xff, 0xff, 0xff]);
  const junkDecoded = decodeAttributedBody(junk);
  check("T0.b decodeAttributedBody returns null on junk", junkDecoded === null);

  // Empty / null
  check("T0.c decodeAttributedBody handles null", decodeAttributedBody(null) === null);
  check("T0.d decodeAttributedBody handles empty buffer",
    decodeAttributedBody(Buffer.alloc(0)) === null);
}

// ===========================================================================
// T1 — outbound is first_party
// ===========================================================================
console.log("\n--- T1: outbound 1:1 → first_party ---");
{
  const { result, byGuid } = await runFixturePoll("chat-t1.db");
  // Fixture has 15 rows: 6 classifier edge-cases + 3 attributedBody rows
  // (round source-fidelity-spec § 2) + 5 R23 production-edge rows + 1 R27
  // HIGH-E business-without-BIZ-prefix row.
  check("T1.a pollOnce appended 15 rows", result.appended === 15, `appended=${result.appended}`);
  check("T1.b errors=0", result.errors === 0);
  const row = byGuid["guid-msg-1"];
  check("T1.c row for guid-msg-1 exists", row != null);
  check("T1.d source_policy.consent_basis === first_party",
    row?.source_policy?.consent_basis === "first_party",
    `got=${row?.source_policy?.consent_basis}`);
  check("T1.e source_policy.deletion_semantics === full_excise",
    row?.source_policy?.deletion_semantics === "full_excise");
  check("T1.f text preserved", row?.raw_content?.text === "hello from me (outbound 1:1)");
  check("T1.g parties has user first (outbound)",
    Array.isArray(row?.parties) && row.parties[0] === "user");
}

// ===========================================================================
// T2 — inbound 1:1 → second_party_dm
// ===========================================================================
console.log("\n--- T2: inbound 1:1 → second_party_dm ---");
{
  const { byGuid } = await runFixturePoll("chat-t2.db");
  const row = byGuid["guid-msg-2"];
  check("T2.a row for guid-msg-2 exists", row != null);
  check("T2.b consent_basis === second_party_dm",
    row?.source_policy?.consent_basis === "second_party_dm",
    `got=${row?.source_policy?.consent_basis}`);
  check("T2.c is_from_me === 0", row?.raw_content?.is_from_me === 0);
  check("T2.d cache_roomnames is null", row?.raw_content?.cache_roomnames === null);
  // chat_handle_join stores OTHER parties only; the connector adds +1 to
  // include the operator. A 1:1 DM therefore yields participant_count === 2.
  check("T2.e participant_count === 2 (operator + other party)",
    row?.raw_content?.participant_count === 2,
    `count=${row?.raw_content?.participant_count}`);
}

// ===========================================================================
// T3 — inbound group → third_party_inferred
// ===========================================================================
console.log("\n--- T3: inbound group → third_party_inferred ---");
{
  const { byGuid } = await runFixturePoll("chat-t3.db");
  const row = byGuid["guid-msg-3"];
  check("T3.a row for guid-msg-3 exists", row != null);
  check("T3.b consent_basis === third_party_inferred",
    row?.source_policy?.consent_basis === "third_party_inferred",
    `got=${row?.source_policy?.consent_basis}`);
  check("T3.c cache_roomnames preserved",
    row?.raw_content?.cache_roomnames === "weekend-trip");
  // Group has 3 OTHERS in chat_handle_join + operator → participant_count = 4.
  check("T3.d participant_count >= 4 (3 others + operator)",
    (row?.raw_content?.participant_count || 0) >= 4,
    `count=${row?.raw_content?.participant_count}`);
}

// ===========================================================================
// T4 — business iMessage → third_party_inferred
// ===========================================================================
console.log("\n--- T4: business iMessage → third_party_inferred ---");
{
  const { byGuid } = await runFixturePoll("chat-t4.db");
  const row = byGuid["guid-msg-4"];
  check("T4.a row for guid-msg-4 exists", row != null);
  check("T4.b consent_basis === third_party_inferred",
    row?.source_policy?.consent_basis === "third_party_inferred",
    `got=${row?.source_policy?.consent_basis}`);
  check("T4.c handle_id matches BIZ:42", row?.raw_content?.handle_id === "BIZ:42");
  check("T4.d service is BusinessChat", row?.raw_content?.service === "BusinessChat");
}

// ===========================================================================
// T5 — tapback emits kind:"reaction" with derived_from
// ===========================================================================
console.log("\n--- T5: tapback (associated_message_type=2000) ---");
{
  const { byGuid } = await runFixturePoll("chat-t5.db");
  const row = byGuid["guid-msg-5"];
  check("T5.a row for guid-msg-5 exists", row != null);
  check("T5.b kind === reaction", row?.kind === "reaction",
    `kind=${row?.kind}`);
  check("T5.c derived_from carries the target guid",
    Array.isArray(row?.derived_from) && row.derived_from[0] === "guid-msg-2",
    `derived_from=${JSON.stringify(row?.derived_from)}`);
  // Outbound tapback → first_party (reactor's authorship trumps audience).
  check("T5.d outbound tapback is first_party",
    row?.source_policy?.consent_basis === "first_party",
    `got=${row?.source_policy?.consent_basis}`);
  check("T5.e associated_message_type preserved",
    row?.raw_content?.associated_message_type === 2000);
}

// ===========================================================================
// T6 — reply sets in_reply_to; consent NOT inherited from originator
// ===========================================================================
console.log("\n--- T6: reply (thread_originator_guid set) ---");
{
  const { byGuid } = await runFixturePoll("chat-t6.db");
  const row = byGuid["guid-msg-6"];
  check("T6.a row for guid-msg-6 exists", row != null);
  check("T6.b raw_content.in_reply_to is set",
    row?.raw_content?.in_reply_to === "guid-msg-2",
    `in_reply_to=${row?.raw_content?.in_reply_to}`);
  check("T6.c thread_originator_guid preserved",
    row?.raw_content?.thread_originator_guid === "guid-msg-2");
  // Reply is OUTBOUND in our fixture → first_party (NOT inheriting the
  // originator's classification, which would be second_party_dm).
  check("T6.d outbound reply classified by ITS own is_from_me → first_party",
    row?.source_policy?.consent_basis === "first_party",
    `got=${row?.source_policy?.consent_basis}`);
}

// ===========================================================================
// T7 — cursor restart: second runOnce appends 0 (idempotent on guid)
// ===========================================================================
console.log("\n--- T7: cursor restart is idempotent ---");
{
  const dbPath = join(TEST_ROOT, "chat-t7.db");
  buildFixtureDb(dbPath);
  // Fresh cursor + fresh ledger for this test.
  const ledgerPath = join(TEST_ROOT, "storage", "sources", "imessage-t7.jsonl");
  const cursorPath = join(TEST_ROOT, "connectors", "imessage-t7", "state.json");
  const c = new IMessageConnector({
    chatDbPath: dbPath,
    sourceLedgerPath: ledgerPath,
    cursorPath: cursorPath,
  });
  const r1 = await c.runOnce();
  check("T7.a first runOnce appended 15 rows", r1.appended === 15,
    `appended=${r1.appended}`);
  const lineCount1 = readLedger(ledgerPath).length;
  check("T7.b ledger has 15 lines after first run", lineCount1 === 15);

  // Construct a fresh connector pointing at the same paths (simulates
  // process restart). Cursor on disk has last_message_rowid=14; restart
  // should SELECT zero new rows.
  const c2 = new IMessageConnector({
    chatDbPath: dbPath,
    sourceLedgerPath: ledgerPath,
    cursorPath: cursorPath,
  });
  const r2 = await c2.runOnce();
  check("T7.c second runOnce appended 0", r2.appended === 0,
    `appended=${r2.appended}`);
  const lineCount2 = readLedger(ledgerPath).length;
  check("T7.d ledger still has 15 lines after second run", lineCount2 === 15);

  // Verify cursor persisted.
  const cursorState = JSON.parse(readFileSync(cursorPath, "utf8"));
  check("T7.e cursor.last_message_rowid is 15 after pollOnce",
    cursorState.last_message_rowid === 15,
    `cursor=${JSON.stringify(cursorState)}`);
}

// ===========================================================================
// T8 — pollOnce against an absent chat.db is a graceful error.
// ===========================================================================
console.log("\n--- T8: absent chat.db ---");
{
  const missingDb = join(TEST_ROOT, "definitely-not-here.db");
  const ledgerPath = join(TEST_ROOT, "storage", "sources", "imessage-t8.jsonl");
  const cursorPath = join(TEST_ROOT, "connectors", "imessage-t8", "state.json");
  const c = new IMessageConnector({
    chatDbPath: missingDb,
    sourceLedgerPath: ledgerPath,
    cursorPath: cursorPath,
  });
  const r = await c.pollOnce();
  check("T8.a pollOnce did not throw and reports errors=1", r.errors === 1,
    `result=${JSON.stringify(r)}`);
  check("T8.b appended=0", r.appended === 0);
  check("T8.c latest_message_rowid is null", r.latest_message_rowid === null);
  // tagError should have been called → error_count >= 1 in cursor.
  const cursorState = existsSync(cursorPath)
    ? JSON.parse(readFileSync(cursorPath, "utf8"))
    : null;
  check("T8.d tagError persisted to cursor", cursorState?.error_count === 1,
    `cursorState=${JSON.stringify(cursorState)}`);
  check("T8.e last_error_kind === chat_db_absent",
    cursorState?.last_error_kind === "chat_db_absent",
    `kind=${cursorState?.last_error_kind}`);
}

// ===========================================================================
// T9 — attributedBody decoder: byte-exact decode for inbound + outbound rows.
// ===========================================================================
console.log("\n--- T9: attributedBody decode (typedstream) ---");
{
  const { byGuid } = await runFixturePoll("chat-t9.db");

  // T9.a — inbound 1:1 attributedBody-only row decoded.
  const inbound = byGuid["guid-msg-7"];
  check("T9.a inbound attributedBody row exists", inbound != null);
  const expectedInbound = "the sample contact is Robin; they work in Dayton";
  check("T9.a1 raw_content.text decoded byte-exact from typedstream",
    inbound?.raw_content?.text === expectedInbound,
    `got=${JSON.stringify(inbound?.raw_content?.text)}`);
  check("T9.a2 raw_content.text length matches plaintext (48 bytes)",
    (inbound?.raw_content?.text || "").length === expectedInbound.length);

  // T9.b — raw_content.text_source === "attributedBody"
  check("T9.b text_source === 'attributedBody'",
    inbound?.raw_content?.text_source === "attributedBody",
    `got=${inbound?.raw_content?.text_source}`);

  // T9.c — attributedBody_decode_error absent on success.
  check("T9.c attributedBody_decode_error is absent on successful decode",
    !("attributedBody_decode_error" in (inbound?.raw_content || {})),
    `got keys=${Object.keys(inbound?.raw_content || {}).join(",")}`);

  // T9.d — outbound attributedBody row decoded.
  const outbound = byGuid["guid-msg-8"];
  check("T9.d outbound attributedBody row exists", outbound != null);
  const expectedOutbound = "outbound test message from user partner via attributedBody";
  check("T9.d1 outbound raw_content.text decoded byte-exact",
    outbound?.raw_content?.text === expectedOutbound,
    `got=${JSON.stringify(outbound?.raw_content?.text)}`);
  check("T9.d2 outbound is_from_me === 1", outbound?.raw_content?.is_from_me === 1);
  check("T9.d3 outbound consent_basis === first_party",
    outbound?.source_policy?.consent_basis === "first_party");
  check("T9.d4 outbound text_source === 'attributedBody'",
    outbound?.raw_content?.text_source === "attributedBody");

  // T9.e — inbound classifier still applies to attributedBody-decoded rows.
  check("T9.e inbound 1:1 attributedBody row classified as second_party_dm",
    inbound?.source_policy?.consent_basis === "second_party_dm",
    `got=${inbound?.source_policy?.consent_basis}`);
}

// ===========================================================================
// T10 — corrupt attributedBody → legacy text fallback + decode_error flag.
// ===========================================================================
console.log("\n--- T10: corrupt attributedBody → legacy fallback ---");
{
  const { byGuid } = await runFixturePoll("chat-t10.db");
  const row = byGuid["guid-msg-9"];
  check("T10.a row for guid-msg-9 exists", row != null);
  // Legacy text column carries the fallback string the connector must use
  // when parseTypedstream returns null.
  check("T10.b raw_content.text === legacy m.text fallback",
    row?.raw_content?.text === "legacy fallback text",
    `got=${JSON.stringify(row?.raw_content?.text)}`);
  check("T10.c raw_content.attributedBody_decode_error === true",
    row?.raw_content?.attributedBody_decode_error === true,
    `got=${row?.raw_content?.attributedBody_decode_error}`);
  // Even on decode failure, the row is still emitted with full policy.
  check("T10.d row still classified (second_party_dm)",
    row?.source_policy?.consent_basis === "second_party_dm",
    `got=${row?.source_policy?.consent_basis}`);
}

// ===========================================================================
// T11 — message.date > Number.MAX_SAFE_INTEGER (Phase A1 CRIT-A).
// ===========================================================================
console.log("\n--- T11: BigInt-safe message.date conversion ---");
{
  const { byGuid } = await runFixturePoll("chat-t11.db");
  const row = byGuid["guid-msg-10"];
  check("T11.a row for guid-msg-10 exists", row != null);
  // date_apple should be the exact 800000000123000000 string (CAST AS TEXT
  // preserved precision; the connector did not silently truncate).
  check("T11.b raw_content.date_apple preserved as string",
    row?.raw_content?.date_apple === "800000000123000000",
    `got=${row?.raw_content?.date_apple}`);
  // Connector ts must be a valid ISO and parse to a 2026-era ms-precision
  // date. The BigInt path divides 800000000123000000 ns by 1e6 ns/ms =
  // 800000000123 ms past Mac epoch = 1778307200123 ms past unix epoch =
  // 2026-05-09T06:13:20.123Z.
  check("T11.c row.ts is a valid ISO string",
    typeof row?.ts === "string" && !Number.isNaN(Date.parse(row?.ts || "")),
    `ts=${row?.ts}`);
  const tsMs = Date.parse(row?.ts || "");
  check("T11.d row.ts decodes to 2026-05-09T06:13:20.123Z",
    row?.ts === "2026-05-09T06:13:20.123Z",
    `ts=${row?.ts}`);
  check("T11.e tsMs is in the 2026 calendar year",
    tsMs >= Date.parse("2026-01-01T00:00:00Z") &&
    tsMs < Date.parse("2027-01-01T00:00:00Z"),
    `tsMs=${tsMs}`);
}

// ===========================================================================
// T12 — both text=NULL AND attributedBody=NULL (Phase A1 CRIT-B).
// ===========================================================================
console.log("\n--- T12: text=NULL AND attributedBody=NULL ---");
{
  const { byGuid } = await runFixturePoll("chat-t12.db");
  const row = byGuid["guid-msg-11"];
  check("T12.a row for guid-msg-11 exists", row != null);
  check("T12.b raw_content.text === null", row?.raw_content?.text === null,
    `got=${JSON.stringify(row?.raw_content?.text)}`);
  check("T12.c text_source absent (null path)",
    !("text_source" in (row?.raw_content || {})),
    `keys=${Object.keys(row?.raw_content || {}).join(",")}`);
  check("T12.d attributedBody_decode_error absent",
    !("attributedBody_decode_error" in (row?.raw_content || {})));
  // Row still emitted with policy.
  check("T12.e consent_basis classified (inbound 1:1 → second_party_dm)",
    row?.source_policy?.consent_basis === "second_party_dm",
    `got=${row?.source_policy?.consent_basis}`);
}

// ===========================================================================
// T13 — RCS handle service (Phase A1 CRIT-C).
// ===========================================================================
console.log("\n--- T13: inbound 1:1 RCS → second_party_dm ---");
{
  const { byGuid } = await runFixturePoll("chat-t13.db");
  const row = byGuid["guid-msg-12"];
  check("T13.a row for guid-msg-12 exists", row != null);
  check("T13.b service === RCS", row?.raw_content?.service === "RCS",
    `service=${row?.raw_content?.service}`);
  check("T13.c consent_basis === second_party_dm",
    row?.source_policy?.consent_basis === "second_party_dm",
    `got=${row?.source_policy?.consent_basis}`);
}

// ===========================================================================
// T14 — 3-person group, NO room name (Phase A1 HIGH-H).
// ===========================================================================
console.log("\n--- T14: 3-person group, room_name=NULL ---");
{
  const { byGuid } = await runFixturePoll("chat-t14.db");
  const row = byGuid["guid-msg-13"];
  check("T14.a row for guid-msg-13 exists", row != null);
  check("T14.b cache_roomnames === null (room_name NULL in fixture)",
    row?.raw_content?.cache_roomnames === null,
    `got=${row?.raw_content?.cache_roomnames}`);
  // participant_count for chat 4 = 2 others + operator = 3 (> 2).
  check("T14.c participant_count === 3",
    row?.raw_content?.participant_count === 3,
    `count=${row?.raw_content?.participant_count}`);
  // Classifier must take Rule 3 via participant_count > 2 alone.
  check("T14.d consent_basis === third_party_inferred",
    row?.source_policy?.consent_basis === "third_party_inferred",
    `got=${row?.source_policy?.consent_basis}`);
}

// ===========================================================================
// T15 — U+FFFC placeholder scrub (Phase A1 HIGH-I).
// ===========================================================================
console.log("\n--- T15: U+FFFC placeholder text scrubbed to null ---");
{
  const { byGuid } = await runFixturePoll("chat-t15.db");
  const row = byGuid["guid-msg-14"];
  check("T15.a row for guid-msg-14 exists", row != null);
  // The legacy m.text column is exactly U+FFFC; the attributedBody is
  // corrupt so the decoder returns null. The connector must NOT leak the
  // U+FFFC placeholder into raw_content.text — it scrubs to null.
  check("T15.b raw_content.text === null (U+FFFC placeholder scrubbed)",
    row?.raw_content?.text === null,
    `got=${JSON.stringify(row?.raw_content?.text)}`);
  check("T15.c attributedBody_decode_error === true",
    row?.raw_content?.attributedBody_decode_error === true,
    `got=${row?.raw_content?.attributedBody_decode_error}`);
  // text_source absent because no usable text source landed.
  check("T15.d text_source absent (no usable source)",
    !("text_source" in (row?.raw_content || {})),
    `keys=${Object.keys(row?.raw_content || {}).join(",")}`);
}

// ===========================================================================
// T4b — BusinessChat merchant WITHOUT `BIZ:` prefix (R27 HIGH-E).
//
// Real chat.db on the operator's machine has zero handles matching /^BIZ:/.
// The `BIZ:`-prefix branch of classifyRow is dead code; the service signal
// (service === "BusinessChat") is what actually identifies business
// merchants in production. Without this fixture row, dropping the OR-branch
// would silently mis-classify every prod BusinessChat row as second_party_dm
// (Rule 2). This block locks the service-only signal into the regression net.
// ===========================================================================
console.log("\n--- T4b: BusinessChat (service-only signal, no BIZ: prefix) ---");
{
  const { byGuid } = await runFixturePoll("chat-t4b.db");
  const row = byGuid["guid-msg-15"];
  check("T4b.a row for guid-msg-15 exists", row != null);
  check("T4b.b handle_id === applepay@business.apple (no BIZ: prefix)",
    row?.raw_content?.handle_id === "applepay@business.apple",
    `got=${row?.raw_content?.handle_id}`);
  check("T4b.c service === BusinessChat",
    row?.raw_content?.service === "BusinessChat",
    `got=${row?.raw_content?.service}`);
  // Service-only signal MUST carry classification to third_party_inferred.
  check("T4b.d consent_basis === third_party_inferred via service-only signal",
    row?.source_policy?.consent_basis === "third_party_inferred",
    `got=${row?.source_policy?.consent_basis}`);
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
console.log(`\nAll imessage-connector assertions passed.`);
