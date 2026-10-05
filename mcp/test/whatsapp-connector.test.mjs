// whatsapp-connector.test.mjs — R39 Phase 3b WhatsApp connector unit tests.
//
// Exercises lib/connectors/whatsapp.js against a synthetic ChatStorage.sqlite
// built from test/fixtures/whatsapp-fixture.sql. NEVER reads the real
// ~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite.
//
// Tests:
//   T1: outbound 1:1 → first_party
//   T2: inbound 1:1 → second_party_dm
//   T3: outbound group → first_party
//   T4: inbound group → third_party_inferred
//   T5: link preview (ZMESSAGETYPE=7) → no reaction kind; media_url projected;
//                                        Stage-0 dispatches PASS
//   T6: inbound broadcast → consent third_party_inferred + Stage-0 DROP
//   T7: media row with NULL ZTEXT → Stage-0 DROP("media_no_caption")
//   T8: ZGROUPEVENTTYPE is provenance, not a Stage-0 classifier
//   T9: deterministic source_msg_id (== ZSTANZAID, byte-exact)
//   T10: cursor restart idempotent (second runOnce appends 0).
//
// HERMETICITY: TEST_ROOT under mkdtempSync, env vars before dynamic import.
// Production <checkout>/* paths are pre-snapshot'd to
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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { skipIfDaemonActive } from "./_hermetic-daemon-skip.mjs";
skipIfDaemonActive("whatsapp-connector");

// ---------------------------------------------------------------------------
// Hermetic root + env wiring — MUST precede dynamic imports.
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "whatsapp-conn-test-"));
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
// Checkout root, derived from this file's location (never from the home dir
// or the environment, which the suite may redirect to a temp tree).
const CHECKOUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROD_LEDGER = join(CHECKOUT_ROOT, "ledgers", "memory.jsonl");
// Snapshot as "missing" when absent, so a run that CREATES the ledger fails
// the guard too (a fresh checkout has no ledgers/memory.jsonl).
function snap(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const prodBefore = snap(PROD_LEDGER);

// ---------------------------------------------------------------------------
// Dynamic imports.
// ---------------------------------------------------------------------------
const { WhatsAppConnector, classifyRow } = await import(
  "../lib/connectors/whatsapp.js"
);
const { extractQuotedStanzaId } = await import(
  "../lib/connectors/whatsapp-context-info.js"
);
const { stage0: whatsappStage0 } = await import(
  "../lib/ingest/stage0/whatsapp.js"
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

function buildFixtureDb(dbPath) {
  const sql = readFileSync(
    new URL("./fixtures/whatsapp-fixture.sql", import.meta.url),
    "utf8",
  );
  if (existsSync(dbPath)) rmSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(sql);
  db.close();
}

function readLedger(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

async function runFixturePoll(dbName = "chatstorage.sqlite") {
  const dbPath = join(TEST_ROOT, dbName);
  buildFixtureDb(dbPath);
  const c = new WhatsAppConnector({ chatStoragePath: dbPath });
  const result = await c.pollOnce();
  const ledgerPath = join(TEST_ROOT, "storage", "sources", "whatsapp.jsonl");
  const rows = readLedger(ledgerPath);
  const byStanza = Object.fromEntries(rows.map((r) => [r.source_msg_id, r]));
  return { c, result, rows, byStanza, ledgerPath };
}

// ===========================================================================
// T1 — outbound 1:1 → first_party
// ===========================================================================
console.log("\n--- T1: outbound 1:1 → first_party ---");
{
  const { result, byStanza } = await runFixturePoll("chat-t1.sqlite");
  check("T1.a pollOnce appended 8 rows", result.appended === 8,
    `appended=${result.appended}`);
  check("T1.b errors=0", result.errors === 0);
  const row = byStanza["stanza-msg-1"];
  check("T1.c row for stanza-msg-1 exists", row != null);
  check("T1.d source_policy.consent_basis === first_party",
    row?.source_policy?.consent_basis === "first_party",
    `got=${row?.source_policy?.consent_basis}`);
  check("T1.e source_policy.deletion_semantics === full_excise",
    row?.source_policy?.deletion_semantics === "full_excise");
  check("T1.f text preserved",
    row?.raw_content?.text === "outbound 1:1 message body");
  check("T1.g parties has user first (outbound)",
    Array.isArray(row?.parties) && row.parties[0] === "user");
  check("T1.h ts is ISO string",
    typeof row?.ts === "string" && !Number.isNaN(Date.parse(row.ts || "")));
}

// ===========================================================================
// T2 — inbound 1:1 → second_party_dm
// ===========================================================================
console.log("\n--- T2: inbound 1:1 → second_party_dm ---");
{
  const { byStanza } = await runFixturePoll("chat-t2.sqlite");
  const row = byStanza["stanza-msg-2"];
  check("T2.a row for stanza-msg-2 exists", row != null);
  check("T2.b consent_basis === second_party_dm",
    row?.source_policy?.consent_basis === "second_party_dm",
    `got=${row?.source_policy?.consent_basis}`);
  check("T2.c is_from_me === 0", row?.raw_content?.is_from_me === 0);
  check("T2.d session_type === 0 (1:1)", row?.raw_content?.session_type === 0);
  check("T2.e parties has from_jid first (inbound)",
    Array.isArray(row?.parties) && row.parties[0] === "1234567890@s.whatsapp.net");
}

// ===========================================================================
// T3 — outbound group → first_party
// ===========================================================================
console.log("\n--- T3: outbound group → first_party ---");
{
  const { byStanza } = await runFixturePoll("chat-t3.sqlite");
  const row = byStanza["stanza-msg-3"];
  check("T3.a row for stanza-msg-3 exists", row != null);
  check("T3.b consent_basis === first_party (operator wrote it)",
    row?.source_policy?.consent_basis === "first_party",
    `got=${row?.source_policy?.consent_basis}`);
  check("T3.c session_type === 1 (group)", row?.raw_content?.session_type === 1);
  check("T3.d malformed metadata emits no reply_to",
    !Object.prototype.hasOwnProperty.call(row?.raw_content || {}, "reply_to"),
    `raw_content=${JSON.stringify(row?.raw_content)}`);
}

// ===========================================================================
// T4 — inbound group → third_party_inferred
// ===========================================================================
console.log("\n--- T4: inbound group → third_party_inferred ---");
{
  const { byStanza } = await runFixturePoll("chat-t4.sqlite");
  const row = byStanza["stanza-msg-4"];
  check("T4.a row for stanza-msg-4 exists", row != null);
  check("T4.b consent_basis === third_party_inferred",
    row?.source_policy?.consent_basis === "third_party_inferred",
    `got=${row?.source_policy?.consent_basis}`);
  check("T4.c session_type === 1 (group)", row?.raw_content?.session_type === 1);
  check("T4.d from_jid preserved",
    row?.raw_content?.from_jid === "8888888888@s.whatsapp.net");
  check("T4.e contextInfo field 5 emits the quoted stanza id",
    row?.raw_content?.reply_to === "3A001122334455667788",
    `reply_to=${JSON.stringify(row?.raw_content?.reply_to)}`);
  check("T4.f contextInfo linkage retains the forensic alias",
    row?.raw_content?.parent_stanza_id === "3A001122334455667788",
    `parent_stanza_id=${JSON.stringify(row?.raw_content?.parent_stanza_id)}`);
}

// ===========================================================================
// T5 — link preview (ZMESSAGETYPE=7) → direct URL + no reaction classification
// ===========================================================================
console.log("\n--- T5: type-7 link preview → media_url + no reaction kind ---");
{
  const { byStanza } = await runFixturePoll("chat-t5.sqlite");
  const row = byStanza["stanza-msg-5"];
  check("T5.a row for stanza-msg-5 exists", row != null);
  check("T5.b reaction kind is absent",
    !Object.prototype.hasOwnProperty.call(row || {}, "kind"),
    `kind=${JSON.stringify(row?.kind)}`);
  check("T5.c reaction-derived linkage is absent",
    !Object.prototype.hasOwnProperty.call(row || {}, "derived_from"),
    `derived_from=${JSON.stringify(row?.derived_from)}`);
  check("T5.d message_type preserved", row?.raw_content?.message_type === 7);
  check("T5.e direct media_url projected",
    row?.raw_content?.media_url === "https://lu.ma/fixture-event",
    `media_url=${JSON.stringify(row?.raw_content?.media_url)}`);
  check("T5.f remote preview has no local asset",
    row?.raw_content?.media_local_path === null,
    `media_local_path=${JSON.stringify(row?.raw_content?.media_local_path)}`);
  // Stage-0 dispatch for a remote link preview → PASS.
  const decision = whatsappStage0({ source: "whatsapp", ...row });
  check("T5.g Stage-0 decision === PASS", decision.decision === "PASS",
    `decision=${JSON.stringify(decision)}`);
  check("T5.h Stage-0 reason is null", decision.reason === null,
    `reason=${decision.reason}`);
}

// ===========================================================================
// T6 — broadcast (session_type=2) → consent third_party_inferred + Stage-0 DROP
// ===========================================================================
console.log("\n--- T6: broadcast → Stage-0 DROP ---");
{
  const { byStanza } = await runFixturePoll("chat-t6.sqlite");
  const row = byStanza["stanza-msg-6"];
  check("T6.a row for stanza-msg-6 exists", row != null);
  check("T6.b consent_basis === third_party_inferred (broadcast)",
    row?.source_policy?.consent_basis === "third_party_inferred",
    `got=${row?.source_policy?.consent_basis}`);
  check("T6.c session_type === 2 (broadcast)",
    row?.raw_content?.session_type === 2);
  const decision = whatsappStage0({ source: "whatsapp", ...row });
  check("T6.d Stage-0 DROP", decision.decision === "DROP",
    `decision=${JSON.stringify(decision)}`);
  check("T6.e Stage-0 reason === broadcast", decision.reason === "broadcast",
    `reason=${decision.reason}`);
}

// ===========================================================================
// T7 — media row with NULL ZTEXT → Stage-0 DROP("media_no_caption")
// ===========================================================================
console.log("\n--- T7: media-no-caption → Stage-0 DROP ---");
{
  const { byStanza } = await runFixturePoll("chat-t7.sqlite");
  const row = byStanza["stanza-msg-7"];
  check("T7.a row for stanza-msg-7 exists", row != null);
  check("T7.b text === null", row?.raw_content?.text === null,
    `got=${JSON.stringify(row?.raw_content?.text)}`);
  check("T7.c has_media === true", row?.raw_content?.has_media === true,
    `got=${row?.raw_content?.has_media}`);
  check("T7.d attachments has media item",
    Array.isArray(row?.attachments) && row.attachments.length === 1 &&
    row.attachments[0].kind === "whatsapp_media");
  const decision = whatsappStage0({ source: "whatsapp", ...row });
  check("T7.e Stage-0 DROP", decision.decision === "DROP",
    `decision=${JSON.stringify(decision)}`);
  check("T7.f Stage-0 reason === media_no_caption",
    decision.reason === "media_no_caption",
    `reason=${decision.reason}`);
}

// ===========================================================================
// T8 — ZGROUPEVENTTYPE is provenance, not a Stage-0 classifier.
//
// Pin the rule instead of a measured value set: ordinary text reaches the
// content gates, while independently identifiable low-signal rows still drop
// for their own reason.
// ===========================================================================
console.log("\n--- T8: group_event_type is not a classifier ---");
{
  const { byStanza } = await runFixturePoll("chat-t8.sqlite");
  const row = byStanza["stanza-msg-8"];
  check("T8.a row for stanza-msg-8 exists", row != null);
  check("T8.b group_event_type is preserved as provenance",
    row?.raw_content?.group_event_type === 1,
    `got=${row?.raw_content?.group_event_type}`);
  const decision = whatsappStage0({ source: "whatsapp", ...row });
  check("T8.c independently empty fixture row still DROPs",
    decision.decision === "DROP",
    `decision=${JSON.stringify(decision)}`);
  check("T8.d fixture row drops for placeholder_residual",
    decision.reason === "placeholder_residual",
    `reason=${decision.reason}`);

  for (const groupEventType of [1, 2]) {
    const ordinary = whatsappStage0({
      source: "whatsapp",
      raw_content: {
        text: "ordinary human-authored message",
        message_type: 0,
        group_event_type: groupEventType,
        session_type: groupEventType === 1 ? 0 : 1,
        has_media: false,
      },
    });
    check(`T8 ordinary text with group_event_type=${groupEventType} PASSes`,
      ordinary.decision === "PASS",
      `decision=${JSON.stringify(ordinary)}`);
  }
}

// ===========================================================================
// T9 — deterministic source_msg_id (== ZSTANZAID, byte-exact).
// ===========================================================================
console.log("\n--- T9: deterministic source_msg_id from ZSTANZAID ---");
{
  const { rows } = await runFixturePoll("chat-t9.sqlite");
  const ids = rows.map((r) => r.source_msg_id);
  // All synthetic stanza ids are "stanza-msg-N"; assert each is present.
  const expected = ["stanza-msg-1", "stanza-msg-2", "stanza-msg-3",
                    "stanza-msg-4", "stanza-msg-5", "stanza-msg-6",
                    "stanza-msg-7", "stanza-msg-8"];
  for (const e of expected) {
    check(`T9.${e} present in ledger`, ids.includes(e), `ids=${ids.join(",")}`);
  }
}

// ===========================================================================
// T10 — cursor restart: second runOnce appends 0 (idempotent on stanza_id).
// ===========================================================================
console.log("\n--- T10: cursor restart is idempotent ---");
{
  const dbPath = join(TEST_ROOT, "chat-t10.sqlite");
  buildFixtureDb(dbPath);
  const ledgerPath = join(TEST_ROOT, "storage", "sources", "whatsapp-t10.jsonl");
  const cursorPath = join(TEST_ROOT, "connectors", "whatsapp-t10", "state.json");
  const c = new WhatsAppConnector({
    chatStoragePath: dbPath,
    sourceLedgerPath: ledgerPath,
    cursorPath: cursorPath,
  });
  const r1 = await c.runOnce();
  check("T10.a first runOnce appended 8 rows", r1.appended === 8,
    `appended=${r1.appended}`);
  const c2 = new WhatsAppConnector({
    chatStoragePath: dbPath,
    sourceLedgerPath: ledgerPath,
    cursorPath: cursorPath,
  });
  const r2 = await c2.runOnce();
  check("T10.b second runOnce appended 0", r2.appended === 0,
    `appended=${r2.appended}`);
  const cursorState = JSON.parse(readFileSync(cursorPath, "utf8"));
  check("T10.c cursor.last_zpk === 8 after pollOnce",
    cursorState.last_zpk === 8,
    `cursor=${JSON.stringify(cursorState)}`);
}

// ===========================================================================
// T11 — pollOnce against an absent DB → graceful error.
// ===========================================================================
console.log("\n--- T11: absent ChatStorage.sqlite ---");
{
  const missingDb = join(TEST_ROOT, "definitely-not-here.sqlite");
  const ledgerPath = join(TEST_ROOT, "storage", "sources", "whatsapp-t11.jsonl");
  const cursorPath = join(TEST_ROOT, "connectors", "whatsapp-t11", "state.json");
  const c = new WhatsAppConnector({
    chatStoragePath: missingDb,
    sourceLedgerPath: ledgerPath,
    cursorPath: cursorPath,
  });
  const r = await c.pollOnce();
  check("T11.a pollOnce did not throw and reports errors=1", r.errors === 1,
    `result=${JSON.stringify(r)}`);
  check("T11.b appended=0", r.appended === 0);
  check("T11.c latest_zpk is null", r.latest_zpk === null);
  const cursorState = existsSync(cursorPath)
    ? JSON.parse(readFileSync(cursorPath, "utf8"))
    : null;
  check("T11.d tagError persisted to cursor",
    cursorState?.error_count === 1,
    `cursorState=${JSON.stringify(cursorState)}`);
  check("T11.e last_error_kind === chat_db_absent",
    cursorState?.last_error_kind === "chat_db_absent",
    `kind=${cursorState?.last_error_kind}`);
}

// ===========================================================================
// T12 — classifyRow unit tests (no DB).
// ===========================================================================
console.log("\n--- T12: classifyRow unit ---");
{
  const a = classifyRow({ is_from_me: 1, session_type: 0 });
  check("T12.a outbound 1:1 → first_party",
    a.consent_basis === "first_party");

  const b = classifyRow({ is_from_me: 0, session_type: 0 });
  check("T12.b inbound 1:1 → second_party_dm",
    b.consent_basis === "second_party_dm");

  const c2 = classifyRow({ is_from_me: 0, session_type: 1 });
  check("T12.c inbound group → third_party_inferred",
    c2.consent_basis === "third_party_inferred");

  const d = classifyRow({
    is_from_me: 1, session_type: 0, message_type: 7,
    parent_stanza_id: "stanza-target",
  });
  check("T12.d type 7 emits no reaction kind",
    !Object.prototype.hasOwnProperty.call(d, "kind"));
  check("T12.e type 7 emits no reaction-derived linkage",
    !Object.prototype.hasOwnProperty.call(d, "derived_from"));

  const e = classifyRow({ is_from_me: 0, session_type: null });
  check("T12.f unknown session_type → third_party_inferred (conservative)",
    e.consent_basis === "third_party_inferred");
}

// ===========================================================================
// T14 — g1-whatsapp-reply-linkage: quoted-reply parent passthrough.
//
// Treat ZPARENTMESSAGE as quoted-reply linkage, not as evidence of reaction
// semantics. The former passthrough was gated on classified.kind ===
// "reaction". These assertions pin the decoupled behaviour:
//   T14.a/b a quoted reply (message_type=0 + parent) emits BOTH the canonical
//           reply_to and the source-native parent_stanza_id alias
//   T14.c/d a row with NO parent emits NEITHER key (absent, not null)
//   T14.e/f/g a type-7 row is not treated as a reaction; quoted linkage remains
// ===========================================================================
console.log("\n--- T14: quoted-reply parent passthrough (reply_to) ---");
{
  // _buildLedgerRow is pure w.r.t. the DB — no connection needed. The
  // constructor path is the same one T11 exercises against an absent store.
  const conn = new WhatsAppConnector({
    chatStoragePath: join(TEST_ROOT, "definitely-not-here.sqlite"),
    sourceLedgerPath: join(TEST_ROOT, "storage", "sources", "whatsapp-t14.jsonl"),
    cursorPath: join(TEST_ROOT, "connectors", "whatsapp-t14", "state.json"),
  });

  // A real quoted reply as it appears in the store: a NORMAL message
  // (ZMESSAGETYPE=0, ZGROUPEVENTTYPE=2) whose ZPARENTMESSAGE resolves to the
  // quoted row's ZSTANZAID.
  const replyRow = {
    zpk: 1001,
    stanza_id: "child-stanza",
    parent_stanza_id: "parent-stanza",
    text: "replying to your message",
    message_type: 0,
    group_event_type: 2,
    session_type: 1,
    is_from_me: 0,
    from_jid: "15551230000@s.whatsapp.net",
    to_jid: "120363111111111111@g.us",
    session_jid: "120363111111111111@g.us",
    message_date: 776000000,
  };
  const built = conn._buildLedgerRow(replyRow);
  check("T14.a quoted reply emits raw_content.reply_to === parent stanza id",
    built?.raw_content?.reply_to === "parent-stanza",
    `got=${JSON.stringify(built?.raw_content?.reply_to)}`);
  check("T14.b quoted reply retains raw_content.parent_stanza_id alias",
    built?.raw_content?.parent_stanza_id === "parent-stanza",
    `got=${JSON.stringify(built?.raw_content?.parent_stanza_id)}`);
  check("T14.c quoted reply is NOT reclassified as a reaction",
    built.kind === undefined,
    `kind=${JSON.stringify(built.kind)}`);

  // No parent → NEITHER key present. Absent, not present-and-null: a null
  // would propagate into raw_content and the attribution sweep.
  const noParentRow = { ...replyRow, zpk: 1002, stanza_id: "lonely-stanza" };
  delete noParentRow.parent_stanza_id;
  const builtNoParent = conn._buildLedgerRow(noParentRow);
  check("T14.d no parent → reply_to key ABSENT (not null)",
    !Object.prototype.hasOwnProperty.call(builtNoParent.raw_content, "reply_to"),
    `raw_content=${JSON.stringify(builtNoParent.raw_content)}`);
  check("T14.e no parent → parent_stanza_id key ABSENT (not null)",
    !Object.prototype.hasOwnProperty.call(
      builtNoParent.raw_content, "parent_stanza_id"),
    `raw_content=${JSON.stringify(builtNoParent.raw_content)}`);

  // Empty-string parent is treated as absent by the linkage's explicit
  // non-empty-string test rather than a bare truthiness check.
  const emptyParentRow = { ...replyRow, zpk: 1003, stanza_id: "empty-parent", parent_stanza_id: "" };
  const builtEmpty = conn._buildLedgerRow(emptyParentRow);
  check("T14.f empty-string parent → reply_to ABSENT",
    !Object.prototype.hasOwnProperty.call(builtEmpty.raw_content, "reply_to"),
    `raw_content=${JSON.stringify(builtEmpty.raw_content)}`);

  // Type 7 does not declare reaction semantics. Relational quoted linkage is
  // still projected independently when a source row carries a parent.
  const type7Row = {
    ...replyRow, zpk: 1004, stanza_id: "type7-stanza",
    message_type: 7, text: null,
  };
  const builtType7 = conn._buildLedgerRow(type7Row);
  check("T14.g type-7 row yields no reaction kind",
    !Object.prototype.hasOwnProperty.call(builtType7, "kind"),
    `kind=${JSON.stringify(builtType7.kind)}`);
  check("T14.h type-7 row yields no reaction-derived linkage",
    !Object.prototype.hasOwnProperty.call(builtType7, "derived_from"),
    `derived_from=${JSON.stringify(builtType7.derived_from)}`);
  check("T14.i type-7 row retains the reply_to/parent alias pair",
    builtType7.raw_content.reply_to === "parent-stanza"
      && builtType7.raw_content.parent_stanza_id === "parent-stanza",
    `raw_content=${JSON.stringify(builtType7.raw_content)}`);
}

// ===========================================================================
// T-CONTEXTINFO — the private protobuf decoder is narrow and fail-soft.
// A planted candidate followed by corruption must be rejected: finding the
// bytes is insufficient unless the complete outer message validates.
// ===========================================================================
console.log("\n--- T-CONTEXTINFO: narrow fail-soft protobuf extraction ---");
{
  const stanza = "3A001122334455667788";
  const valid = Buffer.concat([
    Buffer.from([0x08, 0x01]),                         // field 1, varint
    Buffer.from([0x11, 0, 0, 0, 0, 0, 0, 0, 0]),    // field 2, fixed64
    Buffer.from([0x1d, 0, 0, 0, 0]),                 // field 3, fixed32
    Buffer.from([0x2a, stanza.length]),               // field 5, length
    Buffer.from(stanza, "ascii"),
    Buffer.from([0x9a, 0x01, 0x02, 0x08, 0x01]),     // opaque field 19
  ]);
  check("TCI.a valid outer protobuf extracts field 5",
    extractQuotedStanzaId(valid) === stanza);
  check("TCI.b Uint8Array input is accepted",
    extractQuotedStanzaId(new Uint8Array(valid)) === stanza);

  const malformed = [
    null,
    "not bytes",
    Buffer.alloc(0),
    Buffer.from([0x00]),                              // field number zero
    Buffer.from([0x80]),                              // truncated key
    Buffer.from([0x2a, 0x80]),                        // truncated length
    Buffer.from([0x2a, 0x20, 0x41]),                  // length overflow
    Buffer.from([0x2b, 0x2c]),                        // unsupported group
    Buffer.from([0x2d, 0x00]),                        // truncated fixed32
    Buffer.concat([valid, Buffer.from([0x80])]),      // trailing corruption
    Buffer.concat([valid, Buffer.from([0x2a, stanza.length]),
      Buffer.from(stanza, "ascii")]),                // duplicate field 5
    Buffer.concat([Buffer.from([0x2a, 0x14]),
      Buffer.from("3a001122334455667788", "ascii")]), // lowercase id
    Buffer.concat([Buffer.from([0x2a, 0x13]),
      Buffer.from("3A00112233445566778", "ascii")]), // below shape floor
    Buffer.alloc((64 * 1024) + 1, 0x01),              // decoder work cap
  ];
  let threw = false;
  const results = [];
  for (const blob of malformed) {
    try { results.push(extractQuotedStanzaId(blob)); }
    catch { threw = true; }
  }
  check("TCI.c malformed and unexpected inputs never throw", !threw);
  check("TCI.d malformed and unexpected inputs yield no linkage",
    results.every((value) => value === null),
    `results=${JSON.stringify(results)}`);
  check("TCI.e unrelated protobuf yields no linkage",
    extractQuotedStanzaId(Buffer.from([0x08, 0x01])) === null);
}

// ===========================================================================
// T13 — Missing content is classified from text/media shape, without assigning
// meaning to the numeric message type. The cases vary media and caption fields
// while holding that provenance value fixed.
// ===========================================================================
console.log("\n--- T13: empty body classification is content-derived ---");
{
  // Synthetic Stage-0 event; no DB or producer marker is required.
  const evNoMedia = {
    source: "whatsapp",
    raw_content: {
      text: "",
      message_type: 8,
      has_media: false,
      low_signal_message_type: false,
    },
  };
  const d1 = whatsappStage0(evNoMedia);
  check("T13.a type=8 + !hasMedia + no text → DROP", d1.decision === "DROP",
    `decision=${JSON.stringify(d1)}`);
  check("T13.b reason === placeholder_residual",
    d1.reason === "placeholder_residual",
    `reason=${d1.reason}`);

  // With media but no caption, the media-content rule applies.
  const evWithMedia = {
    source: "whatsapp",
    raw_content: {
      text: "",
      message_type: 8,
      has_media: true,
      low_signal_message_type: false,
    },
  };
  const d2 = whatsappStage0(evWithMedia);
  check("T13.c media + empty caption → DROP media_no_caption",
    d2.decision === "DROP" && d2.reason === "media_no_caption",
    `decision=${JSON.stringify(d2)}`);

  // With a caption, the row carries prose and passes.
  const evCaptioned = {
    source: "whatsapp",
    raw_content: {
      text: "look at this animated gif of a cat I found yesterday morning",
      message_type: 8,
      has_media: true,
      low_signal_message_type: false,
    },
  };
  const d3 = whatsappStage0(evCaptioned);
  check("T13.d media + caption → PASS",
    d3.decision === "PASS", `decision=${JSON.stringify(d3)}`);
}

// ===========================================================================
// T15 — identifier-body placeholders are classified by observable shape.
//
// A connector-produced marker and the Stage-0 fallback must use the same pure
// predicate. Numeric group-event provenance is deliberately varied below: the
// body shape decides, while ordinary prose at the same message/group shape
// continues through the content gates.
// ===========================================================================
console.log("\n--- T15: identifier-body placeholder shape ---");
{
  const conn = new WhatsAppConnector({
    chatStoragePath: join(TEST_ROOT, "definitely-not-here.sqlite"),
    sourceLedgerPath: join(TEST_ROOT, "storage", "sources", "whatsapp-t15.jsonl"),
    cursorPath: join(TEST_ROOT, "connectors", "whatsapp-t15", "state.json"),
  });
  const built = conn._buildLedgerRow({
    zpk: 1501,
    stanza_id: "identifier-placeholder-stanza",
    text: "123456789012345@lid",
    message_type: 10,
    group_event_type: 58,
    session_type: 1,
    is_from_me: 0,
    from_jid: "group-1234@g.us",
    to_jid: "group-1234@g.us",
    session_jid: "group-1234@g.us",
    message_date: 776000000,
  });
  check("T15.a connector stamps the content-shape marker",
    built.raw_content.identifier_body_placeholder === true,
    `raw_content=${JSON.stringify(built.raw_content)}`);
  check("T15.b connector retains the legacy compatibility marker",
    built.raw_content.low_signal_message_type === true,
    `raw_content=${JSON.stringify(built.raw_content)}`);

  const fallback = whatsappStage0({
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
  check("T15.c unmarked bare username DROPs by observable shape",
    fallback.decision === "DROP"
      && fallback.reason === "identifier_body_placeholder",
    `decision=${JSON.stringify(fallback)}`);

  for (const groupEventType of [58, 69]) {
    const ordinary = whatsappStage0({
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
    check(`T15.d ordinary prose at group event ${groupEventType} PASSes`,
      ordinary.decision === "PASS",
      `decision=${JSON.stringify(ordinary)}`);
  }

  const unmarkedNumeric = whatsappStage0({
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
  check("T15.e an unmarked numeric type is not assigned semantics",
    unmarkedNumeric.decision === "PASS",
    `decision=${JSON.stringify(unmarkedNumeric)}`);
}

// ===========================================================================
// T-GROUP-MEMBER — WORKUNIT wa-sender-names. The connector LEFT JOINs
// ZWAGROUPMEMBER and FORWARD-stamps raw_content.sender_jid + sender_name, and
// parties[] carries the real GROUP-MEMBER sender (not the group jid). Three
// resolution paths + the outbound + 1:1 cases.
// ===========================================================================
console.log("\n--- T-GROUP-MEMBER: forward sender stamping ---");
{
  const { byStanza } = await runFixturePoll("chat-sender.sqlite");

  // (a) Group inbound, member resolves via ZFIRSTNAME (ROWID 4 → member 1).
  const g1 = byStanza["stanza-msg-4"];
  check("TGM.a group inbound row exists", g1 != null);
  check("TGM.b sender_name === ZFIRSTNAME (Member Firstname)",
    g1?.raw_content?.sender_name === "Member Firstname",
    `got=${JSON.stringify(g1?.raw_content?.sender_name)}`);
  check("TGM.c sender_jid === member jid",
    g1?.raw_content?.sender_jid === "8888888888@s.whatsapp.net",
    `got=${g1?.raw_content?.sender_jid}`);
  check("TGM.d parties[0] is the member sender (NOT the group jid)",
    Array.isArray(g1?.parties) && g1.parties[0] === "8888888888@s.whatsapp.net",
    `parties=${JSON.stringify(g1?.parties)}`);
  check("TGM.e parties[1] === user",
    Array.isArray(g1?.parties) && g1.parties[1] === "user");

  // (b) Group inbound, NO saved name → ZWAPROFILEPUSHNAME fallback (ROWID 8 →
  // member 2). Stage-0 drops it but the connector row still carries the sender.
  const g2 = byStanza["stanza-msg-8"];
  check("TGM.f pushname-fallback row exists", g2 != null);
  check("TGM.g sender_name resolves via member pushname",
    g2?.raw_content?.sender_name === "Group Member Pushname",
    `got=${JSON.stringify(g2?.raw_content?.sender_name)}`);
  check("TGM.h sender_jid === member jid (pushname path)",
    g2?.raw_content?.sender_jid === "9999999999@s.whatsapp.net",
    `got=${g2?.raw_content?.sender_jid}`);

  // (c) 1:1 inbound → sender is the partner; sender_name == session_label.
  const dm = byStanza["stanza-msg-2"];
  check("TGM.i 1:1 inbound sender_name === session_label (Alex Placeholder)",
    dm?.raw_content?.sender_name === "Alex Placeholder",
    `got=${JSON.stringify(dm?.raw_content?.sender_name)}`);
  check("TGM.j 1:1 inbound sender_jid === from_jid",
    dm?.raw_content?.sender_jid === "1234567890@s.whatsapp.net",
    `got=${dm?.raw_content?.sender_jid}`);

  // (d) Outbound → sender is "user".
  const out = byStanza["stanza-msg-1"];
  check("TGM.k outbound sender_jid === user",
    out?.raw_content?.sender_jid === "user",
    `got=${out?.raw_content?.sender_jid}`);
  check("TGM.l outbound sender_name === user",
    out?.raw_content?.sender_name === "user");
  check("TGM.m outbound parties unchanged (user first)",
    Array.isArray(out?.parties) && out.parties[0] === "user");
}

// ===========================================================================
// T-CURSOR-RECOVERY — a rebuild page must drain before adopting MAX(Z_PK).
// The fixture derives the expected membership from ZWAMESSAGE itself. A limit
// smaller than that declared population forces more than one recovery page.
// ===========================================================================
console.log("\n--- T-CURSOR-RECOVERY: rebuild pagination drains before max adoption ---");
{
  const dbPath = join(TEST_ROOT, "chat-cursor-recovery.sqlite");
  buildFixtureDb(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE Z_METADATA (Z_UUID TEXT)");
  db.prepare("INSERT INTO Z_METADATA VALUES (?)").run("replacement-store");
  const expectedIds = db.prepare(
    "SELECT ZSTANZAID AS id FROM ZWAMESSAGE ORDER BY Z_PK",
  ).all().map((row) => row.id);
  const expectedMaxZpk = db.prepare(
    "SELECT MAX(Z_PK) AS value FROM ZWAMESSAGE",
  ).get().value;
  db.close();

  const ledgerPath = join(
    TEST_ROOT, "storage", "sources", "whatsapp-cursor-recovery.jsonl",
  );
  const cursorPath = join(
    TEST_ROOT, "connectors", "whatsapp-cursor-recovery", "state.json",
  );
  mkdirSync(join(TEST_ROOT, "connectors", "whatsapp-cursor-recovery"), {
    recursive: true,
  });
  writeFileSync(cursorPath, JSON.stringify({
    last_zpk: expectedMaxZpk + expectedIds.length,
    last_message_date: 769999000,
    store_uuid: "prior-store",
  }));

  const c = new WhatsAppConnector({
    chatStoragePath: dbPath,
    sourceLedgerPath: ledgerPath,
    cursorPath,
  });
  const limit = Math.max(1, Math.floor(expectedIds.length / 2));
  await c.pollOnce({ limit });
  const midState = JSON.parse(readFileSync(cursorPath, "utf8"));
  check("TCR.a recovery does not adopt store max while a later page exists",
    midState.last_zpk !== expectedMaxZpk,
    `state=${JSON.stringify(midState)}`);

  for (let poll = 0; poll <= expectedIds.length; poll += 1) {
    const state = JSON.parse(readFileSync(cursorPath, "utf8"));
    if (!Object.keys(state).some((key) => key.startsWith("recovery_"))) break;
    await c.pollOnce({ limit });
  }
  const actualIds = readLedger(ledgerPath).map((row) => row.source_msg_id);
  const finalState = JSON.parse(readFileSync(cursorPath, "utf8"));
  check("TCR.b every fixture-declared stanza id is captured",
    JSON.stringify(actualIds) === JSON.stringify(expectedIds),
    `actual=${JSON.stringify(actualIds)} expected=${JSON.stringify(expectedIds)}`);
  check("TCR.c store max is adopted after the recovery pages drain",
    finalState.last_zpk === expectedMaxZpk,
    `state=${JSON.stringify(finalState)}`);
  check("TCR.d recovery pagination fields are cleared after the drain",
    !Object.keys(finalState).some((key) => key.startsWith("recovery_")),
    `state=${JSON.stringify(finalState)}`);
}

// ===========================================================================
// T-CURSOR-ROW-ERROR — fail-soft must mean retry, not skip-past.
// Plant one append failure at a fixture-derived id. The poll still returns an
// error result; the following poll must retry that id before advancing beyond
// it, so the final ledger membership equals the fixture declaration.
// ===========================================================================
console.log("\n--- T-CURSOR-ROW-ERROR: failed row is retried before advance ---");
{
  const dbPath = join(TEST_ROOT, "chat-cursor-row-error.sqlite");
  buildFixtureDb(dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const expected = db.prepare(
    "SELECT Z_PK AS zpk, ZSTANZAID AS id FROM ZWAMESSAGE ORDER BY Z_PK",
  ).all();
  db.close();
  const planted = expected[Math.floor(expected.length / 2)];

  const ledgerPath = join(
    TEST_ROOT, "storage", "sources", "whatsapp-cursor-row-error.jsonl",
  );
  const cursorPath = join(
    TEST_ROOT, "connectors", "whatsapp-cursor-row-error", "state.json",
  );
  const c = new WhatsAppConnector({
    chatStoragePath: dbPath,
    sourceLedgerPath: ledgerPath,
    cursorPath,
  });
  const append = c.appendLedgerRow.bind(c);
  let plantArmed = true;
  c.appendLedgerRow = async (row) => {
    if (plantArmed && row.source_msg_id === planted.id) {
      throw new Error("PLANTED append failure");
    }
    return append(row);
  };

  const first = await c.pollOnce();
  const afterFailure = JSON.parse(readFileSync(cursorPath, "utf8"));
  plantArmed = false;
  const second = await c.pollOnce();
  const actualIds = readLedger(ledgerPath)
    .map((row) => row.source_msg_id)
    .sort();
  const expectedIds = expected.map((row) => row.id).sort();

  check("TCRE.a planted failure remains fail-soft", first.errors === 1,
    `result=${JSON.stringify(first)}`);
  check("TCRE.b cursor stops before the failed row",
    afterFailure.last_zpk < planted.zpk,
    `state=${JSON.stringify(afterFailure)} planted_zpk=${planted.zpk}`);
  check("TCRE.c retry poll succeeds", second.errors === 0,
    `result=${JSON.stringify(second)}`);
  check("TCRE.d retry restores fixture-declared ledger membership",
    JSON.stringify(actualIds) === JSON.stringify(expectedIds),
    `actual=${JSON.stringify(actualIds)} expected=${JSON.stringify(expectedIds)}`);
}

// ===========================================================================
// T-RECOVERY-STALL-VISIBILITY — a recovery-page failure must remain fail-soft,
// must not move either progress sensor, and must become visible to health.
// The planted first row keeps failing through the connector's declared health
// threshold. Once unblocked, recovery must still capture the declared fixture
// membership; no later row may have been skipped past the failed row.
// ===========================================================================
console.log("\n--- T-RECOVERY-STALL-VISIBILITY: persistent poison row is visible ---");
{
  const dbPath = join(TEST_ROOT, "chat-recovery-stall.sqlite");
  buildFixtureDb(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE Z_METADATA (Z_UUID TEXT)");
  db.prepare("INSERT INTO Z_METADATA VALUES (?)").run("replacement-store");
  const ordered = db.prepare(
    `SELECT Z_PK AS zpk, ZSTANZAID AS id, ZMESSAGEDATE AS message_date
     FROM ZWAMESSAGE
     ORDER BY CAST(ZMESSAGEDATE AS REAL) ASC, Z_PK ASC`,
  ).all();
  const expectedMaxZpk = db.prepare(
    "SELECT MAX(Z_PK) AS value FROM ZWAMESSAGE",
  ).get().value;
  db.close();
  const planted = ordered[0];
  const recoveryFloor = Number(planted.message_date) - 1;

  const ledgerPath = join(
    TEST_ROOT, "storage", "sources", "whatsapp-recovery-stall.jsonl",
  );
  const cursorPath = join(
    TEST_ROOT, "connectors", "whatsapp-recovery-stall", "state.json",
  );
  mkdirSync(join(TEST_ROOT, "connectors", "whatsapp-recovery-stall"), {
    recursive: true,
  });
  const seededTs = "2000-01-01T00:00:00.000Z";
  const seededTuple = {
    recovery_message_date_floor: recoveryFloor,
    recovery_after_message_date: recoveryFloor,
    recovery_after_zpk: -1,
  };
  writeFileSync(cursorPath, JSON.stringify({
    last_zpk: expectedMaxZpk + ordered.length,
    last_message_date: recoveryFloor,
    store_uuid: "prior-store",
    last_appended_ts: seededTs,
    last_cursor_advance_ts: seededTs,
    error_count: 0,
    ...seededTuple,
  }));

  let clockMs = Date.now();
  const c = new WhatsAppConnector({
    chatStoragePath: dbPath,
    sourceLedgerPath: ledgerPath,
    cursorPath,
    now: () => new Date(clockMs).toISOString(),
  });
  const append = c.appendLedgerRow.bind(c);
  let plantArmed = true;
  c.appendLedgerRow = async (row) => {
    if (plantArmed && row.source_msg_id === planted.id) {
      throw new Error("PLANTED persistent recovery append failure");
    }
    return append(row);
  };

  const attempts = [];
  for (let attempt = 0; attempt < c.errorThreshold; attempt += 1) {
    attempts.push(await c.pollOnce());
    clockMs += 60_000;
  }
  const stalledState = JSON.parse(readFileSync(cursorPath, "utf8"));
  const stalledHealth = c.reportHealth();

  check("TRSV.a every planted attempt remains fail-soft",
    attempts.every((result) => result.errors === 1),
    `results=${JSON.stringify(attempts)}`);
  check("TRSV.b no row is appended past the planted first row",
    readLedger(ledgerPath).length === 0,
    `rows=${JSON.stringify(readLedger(ledgerPath).map((row) => row.source_msg_id))}`);
  check("TRSV.c recovery tuple does not move while its first row fails",
    Object.entries(seededTuple).every(([key, value]) => stalledState[key] === value),
    `state=${JSON.stringify(stalledState)} seeded=${JSON.stringify(seededTuple)}`);
  check("TRSV.d last_appended_ts does not refresh without an append",
    stalledState.last_appended_ts === seededTs,
    `state=${JSON.stringify(stalledState)}`);
  check("TRSV.e last_cursor_advance_ts does not refresh without cursor movement",
    stalledState.last_cursor_advance_ts === seededTs,
    `state=${JSON.stringify(stalledState)}`);
  check("TRSV.f persistent row failure reaches the declared health threshold",
    stalledState.error_count >= c.errorThreshold,
    `state=${JSON.stringify(stalledState)} threshold=${c.errorThreshold}`);
  check("TRSV.g row failure kind is stable and non-PII",
    stalledState.last_error_kind === "chat_db_row_processing_failed",
    `state=${JSON.stringify(stalledState)}`);
  check("TRSV.h stalled connector health is non-ok",
    stalledHealth.status !== "ok",
    `health=${JSON.stringify(stalledHealth)}`);

  plantArmed = false;
  for (let poll = 0; poll <= ordered.length; poll += 1) {
    const state = JSON.parse(readFileSync(cursorPath, "utf8"));
    if (!Object.keys(state).some((key) => key.startsWith("recovery_"))) break;
    await c.pollOnce();
  }
  const actualIds = readLedger(ledgerPath)
    .map((row) => row.source_msg_id)
    .sort();
  const expectedIds = ordered.map((row) => row.id).sort();
  check("TRSV.i unblocked recovery captures fixture-declared membership",
    JSON.stringify(actualIds) === JSON.stringify(expectedIds),
    `actual=${JSON.stringify(actualIds)} expected=${JSON.stringify(expectedIds)}`);
}

// ===========================================================================
// T-RECOVERY-DEDUP-TIMESTAMPS — cursor progress and append progress are
// separate signals. A recovery page made entirely of already-ledgered rows may
// move its recovery cursor, but must carry last_appended_ts forward.
// ===========================================================================
console.log("\n--- T-RECOVERY-DEDUP-TIMESTAMPS: dedup-only is not append ---");
{
  const dbPath = join(TEST_ROOT, "chat-recovery-dedup.sqlite");
  buildFixtureDb(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE Z_METADATA (Z_UUID TEXT)");
  db.prepare("INSERT INTO Z_METADATA VALUES (?)").run("replacement-store");
  const ordered = db.prepare(
    `SELECT Z_PK AS zpk, ZMESSAGEDATE AS message_date
     FROM ZWAMESSAGE
     ORDER BY CAST(ZMESSAGEDATE AS REAL) ASC, Z_PK ASC`,
  ).all();
  const expectedMaxZpk = db.prepare(
    "SELECT MAX(Z_PK) AS value FROM ZWAMESSAGE",
  ).get().value;
  db.close();

  const ledgerPath = join(
    TEST_ROOT, "storage", "sources", "whatsapp-recovery-dedup.jsonl",
  );
  const cursorPath = join(
    TEST_ROOT, "connectors", "whatsapp-recovery-dedup", "state.json",
  );
  let nowTs = "2026-01-01T00:00:00.000Z";
  const c = new WhatsAppConnector({
    chatStoragePath: dbPath,
    sourceLedgerPath: ledgerPath,
    cursorPath,
    now: () => nowTs,
  });
  const initial = await c.pollOnce();
  const capturedState = JSON.parse(readFileSync(cursorPath, "utf8"));
  const recoveryFloor = Number(ordered[0].message_date) - 1;
  const seededAdvanceTs = capturedState.last_cursor_advance_ts;
  await c.writeCursor({
    ...capturedState,
    last_zpk: expectedMaxZpk + ordered.length,
    store_uuid: "prior-store",
    recovery_message_date_floor: recoveryFloor,
    recovery_after_message_date: recoveryFloor,
    recovery_after_zpk: -1,
  });
  nowTs = "2026-01-01T00:01:00.000Z";
  const dedupOnly = await c.pollOnce();
  const after = JSON.parse(readFileSync(cursorPath, "utf8"));

  check("TRDT.a fixture was captured before the dedup-only recovery",
    initial.appended === ordered.length,
    `initial=${JSON.stringify(initial)} declared=${ordered.length}`);
  check("TRDT.b recovery page appends no duplicate row",
    dedupOnly.appended === 0,
    `result=${JSON.stringify(dedupOnly)}`);
  check("TRDT.c dedup-only recovery carries last_appended_ts forward",
    after.last_appended_ts === capturedState.last_appended_ts,
    `before=${JSON.stringify(capturedState)} after=${JSON.stringify(after)}`);
  check("TRDT.d dedup-only recovery still stamps real cursor progress",
    after.last_cursor_advance_ts !== seededAdvanceTs,
    `before=${seededAdvanceTs} after=${after.last_cursor_advance_ts}`);
}

// ---------------------------------------------------------------------------
// PROD-SAFETY: production memory.jsonl unchanged.
// ---------------------------------------------------------------------------
const prodAfter = snap(PROD_LEDGER);
check("PROD-SAFETY production memory.jsonl mtime+size unchanged", prodBefore === prodAfter,
  `before=${prodBefore} after=${prodAfter}`);

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll whatsapp-connector assertions passed.`);
