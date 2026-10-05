// whatsapp-name-recovery.test.mjs — WU-whatsapp-name-recovery.
//
// Exercises lib/connectors/whatsapp-name-recovery.js against a SYNTHETIC
// ChatStorage.sqlite built in a tmpdir. NEVER reads the operator's real
// ~/Library/Group Containers/.../ChatStorage.sqlite.
//
// What this suite proves:
//   A. @g.us session       -> GROUP SUBJECT (ZWACHATSESSION.ZPARTNERNAME).
//   B. 1:1 @s.whatsapp.net  -> SAVED contact name (ZPARTNERNAME).
//   C. phone-only 1:1       -> ZWAPROFILEPUSHNAME.ZPUSHNAME fallback.
//   D. phone-only, no push  -> UNRESOLVED (map omits it; caller keeps JID).
//   E. status@broadcast     -> skipped entirely (noise).
//   F. isResolvedName       -> rejects formatted phone strings, accepts names.
//   G. cache round-trip      -> state.json persists + reloads keyed on db mtime;
//                              mtime bump invalidates -> rebuild.
//   H. WIRING: rebuildConversationIndex({ whatsappLabelMap }) renders the human
//      label in thread_label while keeping conversation_id byte-identical.
//
// HERMETICITY (standing): mkdtempSync root + env overrides BEFORE any dynamic
// import. Production <checkout>/* is never touched.

import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hermetic root + env wiring — MUST precede dynamic imports.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "wa-name-recovery-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
process.env.CONNECTORS_BASE_DIR = join(MEMORY_ROOT, "connectors");
mkdirSync(join(MEMORY_ROOT, "storage", "sources"), { recursive: true });
mkdirSync(join(MEMORY_ROOT, "ledgers"), { recursive: true });
mkdirSync(join(MEMORY_ROOT, "connectors", "whatsapp"), { recursive: true });
process.on("exit", () => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});

const { DatabaseSync } = await import("node:sqlite");
const recovery = await import("../lib/connectors/whatsapp-name-recovery.js");
const {
  buildLabelMapFromDb,
  loadOrBuildLabelMap,
  labelForSessionJid,
  isResolvedName,
  classifyJid,
  serializeLabelMap,
  deserializeLabelMap,
  NAME_LABEL_MAP_STATE_KEY,
  NAME_LABEL_MAP_MTIME_STATE_KEY,
} = recovery;
const convidx = await import("../lib/synthesis/conversation-index.js");

// ---------------------------------------------------------------------------
// Synthetic ChatStorage.sqlite — only the columns the recovery module reads.
// Placeholders only: no real phone numbers / names.
// ---------------------------------------------------------------------------
const FIXTURE_SQL = `
CREATE TABLE ZWACHATSESSION (
  Z_PK INTEGER PRIMARY KEY AUTOINCREMENT,
  ZSESSIONTYPE INTEGER,
  ZCONTACTJID TEXT,
  ZPARTNERNAME TEXT
);
CREATE TABLE ZWAPROFILEPUSHNAME (
  Z_PK INTEGER PRIMARY KEY AUTOINCREMENT,
  ZJID TEXT,
  ZPUSHNAME TEXT
);
-- A: group @g.us — ZPARTNERNAME holds the group SUBJECT.
INSERT INTO ZWACHATSESSION (Z_PK, ZSESSIONTYPE, ZCONTACTJID, ZPARTNERNAME)
  VALUES (1, 1, '120363000000000001@g.us', 'Soccer Parents');
-- B: 1:1 @s.whatsapp.net — ZPARTNERNAME holds the SAVED contact name.
INSERT INTO ZWACHATSESSION (Z_PK, ZSESSIONTYPE, ZCONTACTJID, ZPARTNERNAME)
  VALUES (2, 0, '15550001111@s.whatsapp.net', 'Alex Example');
-- C: phone-only 1:1 — ZPARTNERNAME is a formatted phone; pushname resolves it.
INSERT INTO ZWACHATSESSION (Z_PK, ZSESSIONTYPE, ZCONTACTJID, ZPARTNERNAME)
  VALUES (3, 0, '15550002222@s.whatsapp.net', '+1 (555) 000-2222');
-- D: phone-only 1:1 — no pushname row → stays UNRESOLVED.
INSERT INTO ZWACHATSESSION (Z_PK, ZSESSIONTYPE, ZCONTACTJID, ZPARTNERNAME)
  VALUES (4, 0, '15550003333@s.whatsapp.net', '+1 (555) 000-3333');
-- E: status broadcast — noise, must be skipped entirely.
INSERT INTO ZWACHATSESSION (Z_PK, ZSESSIONTYPE, ZCONTACTJID, ZPARTNERNAME)
  VALUES (5, 2, 'status@broadcast', NULL);
-- F: @lid session with a saved name (linked-id 1:1).
INSERT INTO ZWACHATSESSION (Z_PK, ZSESSIONTYPE, ZCONTACTJID, ZPARTNERNAME)
  VALUES (6, 0, '205000000000001@lid', 'Linked Friend');

INSERT INTO ZWAPROFILEPUSHNAME (Z_PK, ZJID, ZPUSHNAME)
  VALUES (1, '15550002222@s.whatsapp.net', 'Pushname Casey');
`;

function buildFixtureDb(dbPath) {
  if (existsSync(dbPath)) rmSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(FIXTURE_SQL);
  db.close();
}

// ===========================================================================
// A–F: buildLabelMapFromDb resolution rules.
// ===========================================================================
test("buildLabelMapFromDb resolves group subject / contact / pushname; skips noise", () => {
  const dbPath = join(TMP_ROOT, "chatstorage-a.sqlite");
  buildFixtureDb(dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let map;
  try {
    map = buildLabelMapFromDb(db);
  } finally {
    db.close();
  }

  // A: @g.us -> group subject.
  const g = map.get("120363000000000001@g.us");
  assert.equal(g.label, "Soccer Parents");
  assert.equal(g.kind, "group");

  // B: 1:1 -> saved contact name.
  const dm = map.get("15550001111@s.whatsapp.net");
  assert.equal(dm.label, "Alex Example");
  assert.equal(dm.kind, "contact");

  // C: phone-only 1:1 -> pushname fallback.
  const push = map.get("15550002222@s.whatsapp.net");
  assert.equal(push.label, "Pushname Casey");
  assert.equal(push.kind, "pushname");

  // D: phone-only, no push -> UNRESOLVED (absent from map).
  assert.equal(map.has("15550003333@s.whatsapp.net"), false);

  // E: status@broadcast -> skipped entirely.
  assert.equal(map.has("status@broadcast"), false);

  // F: @lid with a saved name resolves to contact.
  const lid = map.get("205000000000001@lid");
  assert.equal(lid.label, "Linked Friend");
  assert.equal(lid.kind, "contact");

  // Exactly the four resolvable sessions are in the map.
  assert.equal(map.size, 4);
});

// ===========================================================================
// classifyJid + isResolvedName unit rules.
// ===========================================================================
test("classifyJid + isResolvedName classify JID suffixes and reject phone strings", () => {
  assert.equal(classifyJid("120363@g.us"), "group");
  assert.equal(classifyJid("1555@s.whatsapp.net"), "dm");
  assert.equal(classifyJid("205@lid"), "lid");
  assert.equal(classifyJid("status@broadcast"), "status");
  assert.equal(classifyJid("x@broadcast"), "broadcast");
  assert.equal(classifyJid(null), "null");

  // Names accepted; formatted phone strings + empties rejected.
  assert.equal(isResolvedName("Alex Example"), true);
  assert.equal(isResolvedName("Mom"), true);
  assert.equal(isResolvedName("+1 (555) 000-2222"), false);
  assert.equal(isResolvedName("+15550002222"), false);
  assert.equal(isResolvedName("   "), false);
  assert.equal(isResolvedName(""), false);
  assert.equal(isResolvedName(null), false);

  // labelForSessionJid accessor.
  const m = new Map([["a@g.us", { label: "Crew", kind: "group" }]]);
  assert.equal(labelForSessionJid(m, "a@g.us"), "Crew");
  assert.equal(labelForSessionJid(m, "missing@g.us"), null);
  assert.equal(labelForSessionJid(null, "a@g.us"), null);
});

// ===========================================================================
// serialize / deserialize round-trip.
// ===========================================================================
test("serializeLabelMap / deserializeLabelMap round-trip preserves label + kind", () => {
  const src = new Map([
    ["g@g.us", { label: "Crew", kind: "group", resolved: true }],
    ["d@s.whatsapp.net", { label: "Pat", kind: "contact", resolved: true }],
  ]);
  const obj = serializeLabelMap(src);
  assert.equal(obj["g@g.us"].l, "Crew");
  assert.equal(obj["g@g.us"].k, "group");
  const back = deserializeLabelMap(obj);
  assert.equal(back.get("g@g.us").label, "Crew");
  assert.equal(back.get("d@s.whatsapp.net").kind, "contact");
  // Tampered entries are tolerated (dropped).
  const bad = deserializeLabelMap({ x: { l: "" }, y: null, z: { k: "group" } });
  assert.equal(bad.size, 0);
});

// ===========================================================================
// G: loadOrBuildLabelMap — cache into state.json keyed on db mtime; invalidate.
// ===========================================================================
test("loadOrBuildLabelMap caches into state.json and re-resolves on mtime change", async () => {
  const dbPath = join(TMP_ROOT, "chatstorage-g.sqlite");
  buildFixtureDb(dbPath);
  const statePath = join(MEMORY_ROOT, "connectors", "whatsapp", "state.json");
  // Seed an existing connector cursor so we can prove the merge preserves it.
  writeFileSync(statePath, JSON.stringify({ last_zpk: 4242 }), { mode: 0o600 });

  // First call: cache miss -> rebuild + persist.
  const r1 = await loadOrBuildLabelMap({ chatStoragePath: dbPath, statePath });
  assert.equal(r1.source, "rebuilt");
  assert.equal(labelForSessionJid(r1.map, "120363000000000001@g.us"), "Soccer Parents");

  // state.json now carries BOTH the cursor AND the label map + source mtime.
  const persisted = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(persisted.last_zpk, 4242); // cursor preserved (merge, not clobber)
  assert.ok(persisted[NAME_LABEL_MAP_STATE_KEY] != null);
  assert.equal(typeof persisted[NAME_LABEL_MAP_MTIME_STATE_KEY], "number");

  // Second call: cache HIT (same db mtime) -> no rebuild.
  const r2 = await loadOrBuildLabelMap({ chatStoragePath: dbPath, statePath });
  assert.equal(r2.source, "cache");
  assert.equal(labelForSessionJid(r2.map, "15550001111@s.whatsapp.net"), "Alex Example");

  // Bump the db mtime -> cache invalidates -> rebuild.
  const future = new Date(Date.now() + 10_000);
  utimesSync(dbPath, future, future);
  const r3 = await loadOrBuildLabelMap({ chatStoragePath: dbPath, statePath });
  assert.equal(r3.source, "rebuilt");

  // Missing DB -> empty map, never throws.
  const r4 = await loadOrBuildLabelMap({
    chatStoragePath: join(TMP_ROOT, "does-not-exist.sqlite"),
    statePath,
  });
  assert.equal(r4.map.size, 0);
  assert.equal(r4.source, "empty");
});

// ===========================================================================
// H: WIRING — conversation-index renders the human label, keeps conversation_id.
// ===========================================================================
test("conversation-index uses the recovered WhatsApp label (conversation_id byte-identical)", async () => {
  const DAY = "2026-06-01";
  const TS = `${DAY}T12:00:00.000Z`;
  const wsDir = join(TMP_ROOT, "ws-wiring");
  mkdirSync(join(wsDir, "sources"), { recursive: true });
  const ledgerPath = join(wsDir, "memory.jsonl");
  const sourceLedgerPath = (src) => join(wsDir, "sources", `${src}.jsonl`);

  // A whatsapp source row with the GROUP subject captured forward, and one with
  // ONLY a session_jid (historical row -> resolved via the injected label map).
  writeFileSync(
    sourceLedgerPath("whatsapp"),
    JSON.stringify({
      source: "whatsapp",
      source_msg_id: "WA-FWD",
      ts: TS,
      raw_content: {
        text: "ping",
        session_jid: "120363000000000001@g.us",
        session_label: "Soccer Parents",
      },
    }) + "\n" +
    JSON.stringify({
      source: "whatsapp",
      source_msg_id: "WA-BWD",
      ts: TS,
      raw_content: { text: "yo", session_jid: "15550001111@s.whatsapp.net" },
    }) + "\n",
    { mode: 0o600 },
  );

  writeFileSync(
    ledgerPath,
    [
      { kind: "fact", id: "fact-fwd", source: "whatsapp", ts: TS,
        source_refs: [{ source: "whatsapp", source_msg_id: "WA-FWD" }] },
      { kind: "fact", id: "fact-bwd", source: "whatsapp", ts: TS,
        source_refs: [{ source: "whatsapp", source_msg_id: "WA-BWD" }] },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n",
    { mode: 0o600 },
  );

  // Inject the backward recovery map (hermetic: no live DB touched).
  const labelMap = new Map([
    ["15550001111@s.whatsapp.net", { label: "Alex Example", kind: "contact" }],
  ]);

  const idx = await convidx.rebuildConversationIndex({
    ledgerPath,
    sourceLedgerPath,
    whatsappLabelMap: labelMap,
  });

  // Forward-captured row: label is the group subject; conversation_id keeps JID.
  const fwd = convidx.lookupConversation(idx, "fact-fwd");
  assert.equal(
    fwd.conversation_id,
    `daemon:thread:chat:120363000000000001@g.us:day:${DAY}`,
  );
  assert.equal(fwd.thread_label, `Soccer Parents ${DAY}`);

  // Backward (map) row: label is the contact name; conversation_id keeps JID.
  const bwd = convidx.lookupConversation(idx, "fact-bwd");
  assert.equal(
    bwd.conversation_id,
    `daemon:thread:chat:15550001111@s.whatsapp.net:day:${DAY}`,
  );
  assert.equal(bwd.thread_label, `Alex Example ${DAY}`);
});

// ===========================================================================
// H2: WIRING — with NO map and NO forward label, the WhatsApp thread_label
// degrades to the JID-based descriptor (strictly additive behavior).
// ===========================================================================
test("conversation-index falls back to the JID label when recovery resolves nothing", async () => {
  const DAY = "2026-06-02";
  const TS = `${DAY}T09:00:00.000Z`;
  const wsDir = join(TMP_ROOT, "ws-fallback");
  mkdirSync(join(wsDir, "sources"), { recursive: true });
  const ledgerPath = join(wsDir, "memory.jsonl");
  const sourceLedgerPath = (src) => join(wsDir, "sources", `${src}.jsonl`);

  writeFileSync(
    sourceLedgerPath("whatsapp"),
    JSON.stringify({
      source: "whatsapp",
      source_msg_id: "WA-RAW",
      ts: TS,
      raw_content: { text: "hi", session_jid: "15550009999@s.whatsapp.net" },
    }) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    ledgerPath,
    JSON.stringify({
      kind: "fact", id: "fact-raw", source: "whatsapp", ts: TS,
      source_refs: [{ source: "whatsapp", source_msg_id: "WA-RAW" }],
    }) + "\n",
    { mode: 0o600 },
  );

  // Empty map -> no resolution -> JID-based label.
  const idx = await convidx.rebuildConversationIndex({
    ledgerPath,
    sourceLedgerPath,
    whatsappLabelMap: new Map(),
  });
  const raw = convidx.lookupConversation(idx, "fact-raw");
  assert.equal(
    raw.conversation_id,
    `daemon:thread:chat:15550009999@s.whatsapp.net:day:${DAY}`,
  );
  assert.equal(raw.thread_label, `15550009999@s.whatsapp.net ${DAY}`);
});
