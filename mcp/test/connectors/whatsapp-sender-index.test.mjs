// whatsapp-sender-index.test.mjs — WORKUNIT wa-sender-names.
//
// Exercises lib/connectors/whatsapp-sender-index.js (the pure sender resolver +
// the DERIVED source_msg_id -> {sender_jid, sender_name} projection) and the
// recall.js surfacing seam, against a synthetic ChatStorage.sqlite built from
// test/fixtures/whatsapp-fixture.sql. NEVER reads the real
// ~/Library/Group Containers/.../ChatStorage.sqlite.
//
// Coverage (>=12 assertions across the WU's required cases):
//   - group message resolves to member sender name (firstname) + jid
//   - group message with NO saved name resolves via pushname fallback
//   - 1:1 inbound resolves to the partner name (session_label)
//   - outbound resolves to "user"
//   - ZGROUPMEMBER-null (1:1) path does NOT mis-route through the group branch
//   - derived-index rebuild over the fixture DB; lookup HIT + MISS
//   - cache persist + loadFromCacheSync round-trip; schema-mismatch -> null
//   - recall provenance.parties carries sender_name (new raw_content path)
//   - recall provenance.parties carries sender via the derived index (backfill)
//   - Thesis #1: the index is a sidecar; the (synthetic) fact row is unchanged.
//
// HERMETICITY: TEST_ROOT under mkdtempSync; env vars set before dynamic import.
// The recall surfacing test injects the sender index directly via the exported
// test seam so it never touches the filesystem sidecar / ~/Library.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { skipIfDaemonActive } from "../_hermetic-daemon-skip.mjs";
skipIfDaemonActive("whatsapp-sender-index");

// ---------------------------------------------------------------------------
// Hermetic root + env wiring — MUST precede dynamic imports.
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "wa-sender-idx-test-"));
mkdirSync(join(TEST_ROOT, "connectors", "whatsapp"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.CONNECTORS_BASE_DIR = join(TEST_ROOT, "connectors");
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Dynamic imports.
// ---------------------------------------------------------------------------
const senderIndex = await import("../../lib/connectors/whatsapp-sender-index.js");
const {
  resolveSenderForRow,
  resolveSenderName,
  buildSenderIndexFromDb,
  rebuildSenderIndex,
  persistSenderIndex,
  loadSenderIndexFromCacheSync,
  lookupSender,
  serializeSenderEntries,
  deserializeSenderEntries,
  SELF_PARTY,
  SENDER_INDEX_SCHEMA_VERSION,
} = senderIndex;
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
    new URL("../fixtures/whatsapp-fixture.sql", import.meta.url),
    "utf8",
  );
  if (existsSync(dbPath)) rmSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(sql);
  db.close();
}

// ===========================================================================
// 1 — resolveSenderForRow: the four authoritative cases (pure, no DB).
// ===========================================================================
console.log("\n--- 1: resolveSenderForRow pure cases ---");
{
  const pushByJid = new Map([["9999999999@s.whatsapp.net", "Group Member Pushname"]]);

  // Group inbound, firstname resolution.
  const grpFirst = resolveSenderForRow({
    is_from_me: 0,
    session_type: 1,
    from_jid: "8888888888@s.whatsapp.net",
    member_jid: "8888888888@s.whatsapp.net",
    member_contact_name: null,
    member_first_name: "Member Firstname",
  }, { pushByJid });
  check("1.a group firstname → sender_name",
    grpFirst.sender_name === "Member Firstname", JSON.stringify(grpFirst));
  check("1.b group firstname → sender_jid is member jid",
    grpFirst.sender_jid === "8888888888@s.whatsapp.net");

  // Group inbound, pushname fallback (no saved name).
  const grpPush = resolveSenderForRow({
    is_from_me: 0,
    session_type: 1,
    from_jid: "9999999999@s.whatsapp.net",
    member_jid: "9999999999@s.whatsapp.net",
    member_contact_name: null,
    member_first_name: null,
  }, { pushByJid });
  check("1.c group pushname fallback → sender_name",
    grpPush.sender_name === "Group Member Pushname", JSON.stringify(grpPush));

  // Group inbound, NOTHING resolves → name null, jid still present.
  const grpNone = resolveSenderForRow({
    is_from_me: 0,
    session_type: 1,
    from_jid: "7777777777@s.whatsapp.net",
    member_jid: "7777777777@s.whatsapp.net",
    member_contact_name: null,
    member_first_name: null,
  }, { pushByJid });
  check("1.d group unresolved → sender_name null but sender_jid present",
    grpNone.sender_name === null && grpNone.sender_jid === "7777777777@s.whatsapp.net",
    JSON.stringify(grpNone));

  // Group inbound, ZCONTACTNAME wins over firstname.
  const grpContact = resolveSenderForRow({
    is_from_me: 0,
    session_type: 1,
    member_jid: "5555555555@s.whatsapp.net",
    member_contact_name: "Saved Contact",
    member_first_name: "Ignored First",
  }, { pushByJid });
  check("1.e ZCONTACTNAME wins over ZFIRSTNAME",
    grpContact.sender_name === "Saved Contact", JSON.stringify(grpContact));

  // 1:1 inbound, partner name via session_label.
  const dm = resolveSenderForRow({
    is_from_me: 0,
    session_type: 0,
    from_jid: "1234567890@s.whatsapp.net",
    session_label: "Alex Placeholder",
  });
  check("1.f 1:1 inbound → sender_name is session_label",
    dm.sender_name === "Alex Placeholder" && dm.sender_jid === "1234567890@s.whatsapp.net",
    JSON.stringify(dm));

  // 1:1 inbound, session_label is a phone string → NOT a name.
  const dmPhone = resolveSenderForRow({
    is_from_me: 0,
    session_type: 0,
    from_jid: "1234567890@s.whatsapp.net",
    session_label: "+1 (650) 555-1212",
  });
  check("1.g 1:1 inbound phone-only label → sender_name null (jid kept)",
    dmPhone.sender_name === null && dmPhone.sender_jid === "1234567890@s.whatsapp.net",
    JSON.stringify(dmPhone));

  // Outbound → "user".
  const out = resolveSenderForRow({ is_from_me: 1, session_type: 1, to_jid: "group-1234@g.us" });
  check("1.h outbound → sender_jid/sender_name === user",
    out.sender_jid === SELF_PARTY && out.sender_name === SELF_PARTY, JSON.stringify(out));

  // ZGROUPMEMBER-null 1:1 must NOT mis-route through the group branch (no member
  // jid + session_type 0): it resolves as a 1:1, NOT a group-member lookup.
  const dmNoMember = resolveSenderForRow({
    is_from_me: 0,
    session_type: 0,
    from_jid: "1234567890@s.whatsapp.net",
    member_jid: null,
    member_first_name: "should-not-be-used",
  });
  check("1.i 1:1 (member_jid null) ignores stray member_first_name",
    dmNoMember.sender_name === null, JSON.stringify(dmNoMember));

  // Malformed row → safe descriptor, no throw.
  const bad = resolveSenderForRow(null);
  check("1.j null row → {null,null} (no throw)",
    bad.sender_jid === null && bad.sender_name === null);

  // resolveSenderName direct: order contact -> first -> pushname.
  check("1.k resolveSenderName pushname fallback",
    resolveSenderName({
      contactName: null, firstName: null, memberJid: "9999999999@s.whatsapp.net", pushByJid,
    }) === "Group Member Pushname");
  check("1.l resolveSenderName phone-string rejected",
    resolveSenderName({ contactName: "+1 (212) 555-0000", firstName: null }) === null);
}

// ===========================================================================
// 2 — DERIVED index: rebuild over the fixture DB; lookup HIT + MISS.
// ===========================================================================
console.log("\n--- 2: derived sender-index rebuild + lookup ---");
let liveIndex;
{
  const dbPath = join(TEST_ROOT, "chat-idx.sqlite");
  buildFixtureDb(dbPath);

  // buildSenderIndexFromDb directly (pure, open handle).
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let direct;
  try { direct = buildSenderIndexFromDb(db); } finally { db.close(); }
  check("2.a buildSenderIndexFromDb returns a Map", direct instanceof Map);

  // group firstname row (stanza-msg-4 → member 1).
  const g4 = direct.get("stanza-msg-4");
  check("2.b index group firstname row",
    g4 && g4.sender_name === "Member Firstname" &&
    g4.sender_jid === "8888888888@s.whatsapp.net", JSON.stringify(g4));

  // group pushname-fallback row (stanza-msg-8 → member 2).
  const g8 = direct.get("stanza-msg-8");
  check("2.c index group pushname-fallback row",
    g8 && g8.sender_name === "Group Member Pushname", JSON.stringify(g8));

  // 1:1 inbound (stanza-msg-2) → partner name.
  const d2 = direct.get("stanza-msg-2");
  check("2.d index 1:1 inbound partner name",
    d2 && d2.sender_name === "Alex Placeholder", JSON.stringify(d2));

  // outbound (stanza-msg-1) → user.
  const o1 = direct.get("stanza-msg-1");
  check("2.e index outbound → user",
    o1 && o1.sender_jid === "user" && o1.sender_name === "user", JSON.stringify(o1));

  // rebuildSenderIndex (the async public entry).
  liveIndex = await rebuildSenderIndex({ chatStoragePath: dbPath });
  check("2.f rebuildSenderIndex bySourceMsgId is a Map",
    liveIndex.bySourceMsgId instanceof Map && liveIndex.bySourceMsgId.size > 0);

  // lookupSender HIT.
  const hit = lookupSender(liveIndex, "stanza-msg-4");
  check("2.g lookupSender HIT", hit && hit.sender_name === "Member Firstname");

  // lookupSender MISS (unknown source_msg_id).
  check("2.h lookupSender MISS → null",
    lookupSender(liveIndex, "stanza-msg-DOES-NOT-EXIST") === null);

  // lookupSender on garbage → null (no throw).
  check("2.i lookupSender bad args → null",
    lookupSender(null, "x") === null && lookupSender(liveIndex, "") === null);

  // rebuild on absent DB degrades to empty (no throw).
  const empty = await rebuildSenderIndex({ chatStoragePath: join(TEST_ROOT, "nope.sqlite") });
  check("2.j rebuild absent DB → empty index",
    empty.bySourceMsgId instanceof Map && empty.bySourceMsgId.size === 0);
}

// ===========================================================================
// 3 — cache persist + loadFromCacheSync round-trip + schema mismatch.
// ===========================================================================
console.log("\n--- 3: sidecar persist / load round-trip ---");
{
  const cachePath = join(TEST_ROOT, "connectors", "whatsapp", "sender-index.json");
  persistSenderIndex(liveIndex, cachePath);
  check("3.a sidecar written", existsSync(cachePath));

  const loaded = loadSenderIndexFromCacheSync({ cachePath });
  check("3.b loadFromCacheSync round-trips entries",
    loaded && loaded.bySourceMsgId.get("stanza-msg-4")?.sender_name === "Member Firstname",
    JSON.stringify(loaded && [...loaded.bySourceMsgId.entries()].slice(0, 1)));

  // schema-mismatch → null.
  const badSchemaPath = join(TEST_ROOT, "bad-schema.json");
  writeFileSync(badSchemaPath, JSON.stringify({ schema_version: "v0", entries: {} }));
  check("3.c schema mismatch → null", loadSenderIndexFromCacheSync({ cachePath: badSchemaPath }) === null);

  // absent cache → null.
  check("3.d absent cache → null",
    loadSenderIndexFromCacheSync({ cachePath: join(TEST_ROOT, "ghost.json") }) === null);

  // corrupt JSON → null (no throw).
  const corruptPath = join(TEST_ROOT, "corrupt.json");
  writeFileSync(corruptPath, "{ not json ");
  check("3.e corrupt cache → null", loadSenderIndexFromCacheSync({ cachePath: corruptPath }) === null);

  // serialize/deserialize symmetry; drops fully-empty descriptors.
  const m = new Map([
    ["a", { sender_jid: "j@x", sender_name: "Nm" }],
    ["b", { sender_jid: null, sender_name: null }], // dropped
  ]);
  const round = deserializeSenderEntries(serializeSenderEntries(m));
  check("3.f serialize/deserialize keeps populated + drops empty",
    round.size === 1 && round.get("a").sender_name === "Nm");
  check("3.g schema constant pinned", SENDER_INDEX_SCHEMA_VERSION === "v1");
}

// ===========================================================================
// 4 — recall.js surfacing: provenance.parties carries the sender.
// ===========================================================================
console.log("\n--- 4: recall surfacing of sender_name ---");
{
  const recall = await import("../../lib/tools/recall.js");
  const { __setWhatsAppSenderIndexForTest, __resolveWhatsAppSenderParties } = recall;

  // Inject the derived index so the BACKFILL path is active for the recall seam.
  __setWhatsAppSenderIndexForTest(liveIndex);

  // EXISTING fact (no raw_content; mirrors the live corpus) → the recall helper
  // joins source_refs[0].source_msg_id to the derived index and surfaces the
  // sender as provenance.parties = [sender_name, "user"].
  const existingFact = {
    id: "fact-existing",
    source: "whatsapp",
    source_refs: [{ source: "whatsapp", source_msg_id: "stanza-msg-4" }],
  };
  const existingParties = __resolveWhatsAppSenderParties(existingFact);
  check("4.a recall surfaces EXISTING-fact sender via index",
    Array.isArray(existingParties) &&
    existingParties[0] === "Member Firstname" && existingParties[1] === "user",
    JSON.stringify(existingParties));

  // NEW fact path: raw_content carries the forward-stamped sender; the helper
  // prefers it over the index (and works even when the smid is not in the index).
  const newFact = {
    id: "fact-new",
    source: "whatsapp",
    source_refs: [{ source: "whatsapp", source_msg_id: "brand-new-not-in-index" }],
    raw_content: { sender_name: "Forward Stamped", sender_jid: "abc@s.whatsapp.net" },
  };
  const newParties = __resolveWhatsAppSenderParties(newFact);
  check("4.b recall surfaces NEW-fact sender from raw_content",
    newParties[0] === "Forward Stamped" && newParties[1] === "user",
    JSON.stringify(newParties));

  // Non-WhatsApp fact → empty parties[] (additive; legacy shape preserved).
  const otherFact = {
    id: "fact-im",
    source: "imessage",
    source_refs: [{ source: "imessage", source_msg_id: "x" }],
  };
  check("4.c non-WhatsApp fact → empty parties[]",
    Array.isArray(__resolveWhatsAppSenderParties(otherFact)) &&
    __resolveWhatsAppSenderParties(otherFact).length === 0);

  // WhatsApp fact whose smid is NOT in the index AND has no raw_content → [].
  const missFact = {
    id: "fact-miss",
    source: "whatsapp",
    source_refs: [{ source: "whatsapp", source_msg_id: "no-such-stanza" }],
  };
  check("4.d index MISS + no raw_content → empty parties[]",
    __resolveWhatsAppSenderParties(missFact).length === 0);

  // Absent index → the backfill path degrades to [] (no throw, legacy shape).
  __setWhatsAppSenderIndexForTest(null);
  check("4.e absent index → EXISTING-fact backfill degrades to []",
    __resolveWhatsAppSenderParties(existingFact).length === 0);
  // ...but the NEW fact still surfaces from its own raw_content.
  check("4.f absent index → NEW fact still surfaces from raw_content",
    __resolveWhatsAppSenderParties(newFact)[0] === "Forward Stamped");

  // null / malformed fact row → [] (no throw).
  check("4.g null fact row → [] (no throw)",
    __resolveWhatsAppSenderParties(null).length === 0);

  // Restore.
  __setWhatsAppSenderIndexForTest(liveIndex);
}

// ===========================================================================
// 5 — THESIS #1: the sender-index is a sidecar; rebuilding it does not mutate
// the (synthetic) source ChatStorage rows nor any fact row.
// ===========================================================================
console.log("\n--- 5: Thesis #1 (no fact mutation) ---");
{
  const dbPath = join(TEST_ROOT, "chat-thesis.sqlite");
  buildFixtureDb(dbPath);

  // Snapshot a representative ZWAMESSAGE row before + after a rebuild.
  function snapshot() {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(
        "SELECT ZSTANZAID AS s, ZTEXT AS t, ZGROUPMEMBER AS g FROM ZWAMESSAGE WHERE Z_PK=4",
      ).get();
    } finally { db.close(); }
  }
  const before = snapshot();
  await rebuildSenderIndex({ chatStoragePath: dbPath, cachePath: join(TEST_ROOT, "thesis-idx.json") });
  const after = snapshot();
  check("5.a source ZWAMESSAGE row unchanged after rebuild",
    before.s === after.s && before.t === after.t && before.g === after.g,
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

  // A synthetic "existing fact" object is never written to by any index op.
  const fact = Object.freeze({
    id: "fact-frozen",
    source_refs: [{ source: "whatsapp", source_msg_id: "stanza-msg-4" }],
  });
  const idx = loadSenderIndexFromCacheSync({ cachePath: join(TEST_ROOT, "thesis-idx.json") });
  const hit = lookupSender(idx, fact.source_refs[0].source_msg_id);
  check("5.b lookup over a frozen fact does not throw + resolves sender",
    hit && hit.sender_name === "Member Firstname");
  assert.ok(Object.isFrozen(fact), "fact stayed frozen (no in-place stamping)");
  check("5.c fact object stayed frozen (sender projected, not stamped)",
    Object.isFrozen(fact) && !("raw_content" in fact));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll whatsapp-sender-index assertions passed.`);
