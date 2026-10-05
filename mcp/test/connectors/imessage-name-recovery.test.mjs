// imessage-name-recovery.test.mjs — WU-imessage-name-recovery.
//
// Guards the iMessage human-name recovery layer
// (lib/connectors/_imessage-name-recovery.js) and its wiring into
// conversation-index.js label derivation.
//
// What this suite proves (all against SYNTHETIC in-tmpdir sqlite DBs — the
// live ~/Library/Messages/chat.db + ~/Library/.../AddressBook are NEVER read
// by this suite):
//   A. NORMALIZATION: phone last-10 + email lower/trim collapse the >=5
//      Contacts formats and the E.164 handle.id onto one join key.
//   B. CONTACT MAP: buildContactMaps unions across multiple abcddb sources;
//      first non-null name wins; first+last vs organization fallback.
//   C. CHAT READ: chat_guid -> display_name; chat_guid -> participant handles.
//   D. LABEL ORDER: human group display_name > "Group: <names>(+N)" > DM
//      contact name > null (unresolved -> caller keeps opaque label).
//   E. APPLE AUTO-TOKEN GATE: hex/numeric/opaque tokens rejected; human
//      subjects (with a space, or a real word) accepted.
//   F. STATE CACHE: resolved label map persisted into state.json keyed by
//      source-db mtimes; a cache hit on unchanged mtimes; a re-resolve when an
//      mtime changes.
//   G. DEFENSIVE: missing chat.db / unresolved handle -> empty map / null
//      label, NEVER a throw.
//   H. WIRING: conversation-index deriveDescriptorFromSourceRow replaces the
//      opaque imessage label with the recovered name when the map resolves the
//      chat_guid; conversation_id stays byte-identical (no read-side drift).
//
// HERMETICITY: mkdtempSync root + env overrides BEFORE any dynamic import.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "imessage-name-recovery-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
process.env.CONNECTORS_BASE_DIR = join(MEMORY_ROOT, "connectors");
mkdirSync(join(MEMORY_ROOT, "connectors", "imessage"), { recursive: true });

const mod = await import("../../lib/connectors/_imessage-name-recovery.js");
const {
  recoverImessageLabels,
  buildContactMaps,
  readChatThreads,
  deriveChatLabel,
  resolveHandleName,
  contactFullName,
  isAppleAutoToken,
  normalizePhone,
  normalizeEmail,
  isEmailHandle,
  statMtimeMs,
  DEFAULT_ADDRESSBOOK_SOURCES_DIR,
  DEFAULT_CHAT_DB_PATH,
  NAME_RECOVERY_CAPS,
  NAME_RECOVERY_VERSION,
} = mod;

const convMod = await import("../../lib/synthesis/conversation-index.js");

// ---------------------------------------------------------------------------
// Fixture builders — synthetic chat.db + AddressBook abcddb.
// ---------------------------------------------------------------------------

let dbSeq = 0;
function freshPath(name) {
  dbSeq += 1;
  return join(TMP_ROOT, `${dbSeq}-${name}`);
}

/**
 * buildFixtureChatDb — a minimal Messages chat.db with chat / handle /
 * chat_handle_join. `chats` is [{guid, style, display_name, handles:[]}].
 */
function buildFixtureChatDb(chats) {
  const path = freshPath("chat.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, style INTEGER, display_name TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, PRIMARY KEY (chat_id, handle_id));
  `);
  const handleIds = new Map(); // id -> ROWID
  let nextHandle = 1;
  function handleRowid(id) {
    if (handleIds.has(id)) return handleIds.get(id);
    const rowid = nextHandle++;
    db.prepare("INSERT INTO handle (ROWID, id, service) VALUES (?, ?, 'iMessage')").run(rowid, id);
    handleIds.set(id, rowid);
    return rowid;
  }
  let nextChat = 1;
  for (const c of chats) {
    const cid = nextChat++;
    db.prepare("INSERT INTO chat (ROWID, guid, style, display_name) VALUES (?, ?, ?, ?)").run(
      cid,
      c.guid,
      c.style ?? null,
      c.display_name ?? null,
    );
    for (const h of c.handles || []) {
      const hid = handleRowid(h);
      db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)").run(cid, hid);
    }
  }
  db.close();
  return path;
}

/**
 * buildFixtureAddressBook — a minimal AddressBook abcddb with ZABCDRECORD /
 * ZABCDPHONENUMBER / ZABCDEMAILADDRESS. `records` is
 * [{first,last,org,phones:[],emails:[]}].
 */
function buildFixtureAddressBook(records) {
  const path = freshPath("AddressBook-v22.abcddb");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY AUTOINCREMENT, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT, ZNICKNAME TEXT);
    CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY AUTOINCREMENT, ZOWNER INTEGER, ZFULLNUMBER TEXT);
    CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY AUTOINCREMENT, ZOWNER INTEGER, ZADDRESS TEXT);
  `);
  let nextRec = 1;
  for (const r of records) {
    const pk = nextRec++;
    db.prepare(
      "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZNICKNAME) VALUES (?, ?, ?, ?, ?)",
    ).run(pk, r.first ?? null, r.last ?? null, r.org ?? null, r.nickname ?? null);
    for (const ph of r.phones || []) {
      db.prepare("INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?, ?)").run(pk, ph);
    }
    for (const em of r.emails || []) {
      db.prepare("INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS) VALUES (?, ?)").run(pk, em);
    }
  }
  db.close();
  return path;
}

// ---------------------------------------------------------------------------
// A. Normalization
// ---------------------------------------------------------------------------

test("A. phone normalization collapses every Contacts format to last-10", () => {
  assert.equal(normalizePhone("+15555550123"), "5555550123");
  assert.equal(normalizePhone("(555) 555-0123"), "5555550123");
  assert.equal(normalizePhone("555-555-0123"), "5555550123");
  assert.equal(normalizePhone("+1 555 555 0123"), "5555550123");
  // SMS shortcode -> too few digits -> null (never joins a contact).
  assert.equal(normalizePhone("55501"), null);
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone(null), null);
});

test("A. email normalization lower/trims", () => {
  assert.equal(normalizeEmail("  Friend@Example.COM "), "friend@example.com");
  assert.equal(normalizeEmail(""), null);
  assert.equal(normalizeEmail(42), null);
  assert.equal(isEmailHandle("a@b.com"), true);
  assert.equal(isEmailHandle("+15551234567"), false);
  assert.equal(isEmailHandle("urn:biz:abc"), false);
});

// ---------------------------------------------------------------------------
// B. Contact-map union + name assembly
// ---------------------------------------------------------------------------

test("B. buildContactMaps unions sources; first non-null name wins", async () => {
  const ab1 = buildFixtureAddressBook([
    { first: "Mom", phones: ["+15555550123"] },
    { org: "Acme Corp", emails: ["sales@acme.test"] },
  ]);
  const ab2 = buildFixtureAddressBook([
    // Duplicate phone with a DIFFERENT name — ab1 scanned first, so it wins.
    { first: "Not", last: "Mom", phones: ["555-555-0123"] },
    { first: "Dad", phones: ["(555) 555-0124"] },
  ]);
  const maps = await buildContactMaps([ab1, ab2]);
  assert.equal(maps.sourcesRead, 2);
  assert.equal(maps.sourcesFailed, 0);
  assert.equal(maps.phoneToName.get("5555550123"), "Mom"); // ab1 wins
  assert.equal(maps.phoneToName.get("5555550124"), "Dad");
  assert.equal(maps.emailToName.get("sales@acme.test"), "Acme Corp"); // org fallback
});

test("B. contactFullName prefers first+last, falls back to org then nickname", () => {
  assert.equal(contactFullName({ first: "Sam", last: "Sample" }), "Sam Sample");
  assert.equal(contactFullName({ first: "Robin" }), "Robin");
  assert.equal(contactFullName({ org: "Frontier Airlines" }), "Frontier Airlines");
  assert.equal(contactFullName({ nickname: "Buddy" }), "Buddy");
  assert.equal(contactFullName({}), null);
});

test("B. resolveHandleName routes email vs phone and misses cleanly", async () => {
  const ab = buildFixtureAddressBook([
    { first: "Riley", phones: ["+15555550125"] },
    { first: "Friend", emails: ["friend@example.com"] },
  ]);
  const maps = await buildContactMaps([ab]);
  assert.equal(resolveHandleName("+15555550125", maps), "Riley");
  assert.equal(resolveHandleName("friend@example.com", maps), "Friend");
  // miss: shortcode + unknown number + unknown email
  assert.equal(resolveHandleName("55501", maps), null);
  assert.equal(resolveHandleName("+10000000000", maps), null);
  assert.equal(resolveHandleName("nobody@nowhere.test", maps), null);
  assert.equal(resolveHandleName("", maps), null);
});

// ---------------------------------------------------------------------------
// C. chat.db read
// ---------------------------------------------------------------------------

test("C. readChatThreads returns guid -> display_name + participant handles", async () => {
  const chatDb = buildFixtureChatDb([
    { guid: "any;-;+15555550123", style: 45, handles: ["+15555550123"] },
    {
      guid: "any;+;chat0001",
      style: 43,
      display_name: "Family",
      handles: ["+15555550123", "+15555550124"],
    },
  ]);
  const threads = await readChatThreads(chatDb);
  assert.equal(threads.length, 2);
  const dm = threads.find((t) => t.guid === "any;-;+15555550123");
  assert.equal(dm.style, 45);
  assert.deepEqual(dm.handles, ["+15555550123"]);
  const grp = threads.find((t) => t.guid === "any;+;chat0001");
  assert.equal(grp.display_name, "Family");
  assert.equal(grp.handles.length, 2);
});

// ---------------------------------------------------------------------------
// D. Label order
// ---------------------------------------------------------------------------

test("D. label order: human group display_name wins over contacts", async () => {
  const ab = buildFixtureAddressBook([{ first: "Mom", phones: ["+15555550123"] }]);
  const maps = await buildContactMaps([ab]);
  const label = deriveChatLabel(
    { guid: "g", style: 43, display_name: "Soccer Parents", handles: ["+15555550123"] },
    maps,
  );
  assert.equal(label, "Soccer Parents");
});

test("D. label order: unnamed group -> 'Group: <names>(+N)'", async () => {
  const ab = buildFixtureAddressBook([
    { first: "Gale", phones: ["+11111111111"] },
    { first: "Alex", phones: ["+12222222222"] },
    { first: "Jo", last: "Sample", phones: ["+13333333333"] },
    { first: "Fourth", phones: ["+14444444444"] },
  ]);
  const maps = await buildContactMaps([ab]);
  // 4 resolved contacts, cap is 3 -> "(+1)"
  const label = deriveChatLabel(
    {
      guid: "g",
      style: 43,
      display_name: "b11550", // Apple auto-token -> gated out
      handles: ["+11111111111", "+12222222222", "+13333333333", "+14444444444"],
    },
    maps,
  );
  assert.ok(label.startsWith("Group: "), `got=${label}`);
  assert.ok(label.endsWith("(+1)"), `got=${label}`);
  assert.equal(label.split(", ").length, 3); // 3 names shown
});

test("D. label order: DM resolves to the single handle's contact name", async () => {
  const ab = buildFixtureAddressBook([{ first: "Sam", last: "Sample", phones: ["+15555550126"] }]);
  const maps = await buildContactMaps([ab]);
  const label = deriveChatLabel(
    { guid: "any;-;+15555550126", style: 45, handles: ["+15555550126"] },
    maps,
  );
  assert.equal(label, "Sam Sample");
});

test("D. label order: unresolved DM -> null (caller keeps opaque label)", async () => {
  const maps = await buildContactMaps([]); // no contacts
  const label = deriveChatLabel(
    { guid: "any;-;+19999999999", style: 45, handles: ["+19999999999"] },
    maps,
  );
  assert.equal(label, null);
  // unnamed group with no resolvable contacts -> null too
  const grpLabel = deriveChatLabel(
    { guid: "g", style: 43, display_name: "424484", handles: ["+18888888888"] },
    maps,
  );
  assert.equal(grpLabel, null);
});

// ---------------------------------------------------------------------------
// E. Apple auto-token gate
// ---------------------------------------------------------------------------

test("E. isAppleAutoToken rejects machine tokens, accepts human subjects", () => {
  // Machine-token shapes (short hex/base36, pure digits, digits+suffix).
  for (const t of ["wDYf", "BSLhO", "424484", "b11550", "15555550144_jsidet", "817.c", "a237576", ""]) {
    assert.equal(isAppleAutoToken(t), true, `expected auto-token: ${JSON.stringify(t)}`);
  }
  // Human-chosen subjects.
  for (const t of ["Family", "Soccer Parents", "Trip 2024", "Roommates"]) {
    assert.equal(isAppleAutoToken(t), false, `expected human subject: ${JSON.stringify(t)}`);
  }
});

// ---------------------------------------------------------------------------
// F. state.json cache (mtime-keyed)
// ---------------------------------------------------------------------------

test("F. recoverImessageLabels persists + reuses the label map; re-resolves on mtime bump", async () => {
  const chatDb = buildFixtureChatDb([
    { guid: "any;-;+15555550123", style: 45, handles: ["+15555550123"] },
  ]);
  const ab = buildFixtureAddressBook([{ first: "Mom", phones: ["+15555550123"] }]);
  const statePath = join(MEMORY_ROOT, "connectors", "imessage", "state-F.json");

  const first = await recoverImessageLabels({
    chatDbPath: chatDb,
    addressBookDbPaths: [ab],
    statePath,
  });
  assert.equal(first.fromCache, false);
  assert.equal(first.byChatGuid.get("any;-;+15555550123"), "Mom");
  assert.ok(existsSync(statePath), "state.json persisted");
  const persisted = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(persisted.name_recovery.schema_version, NAME_RECOVERY_CAPS.STATE_SCHEMA_VERSION);
  assert.equal(persisted.name_recovery.labels["any;-;+15555550123"], "Mom");

  // Second call, no source change -> cache HIT.
  const second = await recoverImessageLabels({
    chatDbPath: chatDb,
    addressBookDbPaths: [ab],
    statePath,
  });
  assert.equal(second.fromCache, true);
  assert.equal(second.byChatGuid.get("any;-;+15555550123"), "Mom");

  // Bump the chat.db mtime -> cache INVALIDATED -> re-resolve.
  const future = new Date(Date.now() + 60_000);
  utimesSync(chatDb, future, future);
  const third = await recoverImessageLabels({
    chatDbPath: chatDb,
    addressBookDbPaths: [ab],
    statePath,
  });
  assert.equal(third.fromCache, false);
  assert.equal(third.byChatGuid.get("any;-;+15555550123"), "Mom");
});

// ---------------------------------------------------------------------------
// G. Defensive degradation
// ---------------------------------------------------------------------------

test("G. missing chat.db / abcddb -> empty map, never throws", async () => {
  const r = await recoverImessageLabels({
    chatDbPath: join(TMP_ROOT, "does-not-exist.db"),
    addressBookDbPaths: [join(TMP_ROOT, "no-such.abcddb")],
    persist: false,
  });
  assert.equal(r.byChatGuid.size, 0);
  assert.equal(r.stats.chats_seen, 0);
  // readChatThreads on a bad path -> [] (no throw)
  const threads = await readChatThreads("/nonexistent/path/chat.db");
  assert.deepEqual(threads, []);
  // deriveChatLabel on garbage -> null (no throw)
  assert.equal(deriveChatLabel(null, await buildContactMaps([])), null);
  assert.equal(deriveChatLabel({}, await buildContactMaps([])), null);
});

// ---------------------------------------------------------------------------
// H. conversation-index wiring — enrich label, keep conversation_id identical
// ---------------------------------------------------------------------------

test("H. conversation-index replaces opaque imessage label when map resolves", () => {
  const { deriveDescriptorFromSourceRow } = convMod.__internal;
  const row = {
    source: "imessage",
    ts: "2026-06-17T12:00:00Z",
    raw_content: { chat_guid: "any;-;+15555550123" },
  };
  const opaque = deriveDescriptorFromSourceRow(row);
  assert.ok(opaque.thread_label.includes("any;-;+15555550123"));

  const map = new Map([["any;-;+15555550123", "Mom"]]);
  const enriched = deriveDescriptorFromSourceRow(row, { imessageLabelMap: map });
  assert.equal(enriched.thread_label, "Mom 2026-06-17");
  // conversation_id MUST be byte-identical (no read-side drift).
  assert.equal(enriched.conversation_id, opaque.conversation_id);

  // Group label flows through unchanged.
  const grow = {
    source: "imessage",
    ts: "2026-06-17T12:00:00Z",
    raw_content: { chat_guid: "any;+;chat0001" },
  };
  const gmap = new Map([["any;+;chat0001", "Group: Gale, Alex, Jo Sample"]]);
  const genriched = deriveDescriptorFromSourceRow(grow, { imessageLabelMap: gmap });
  assert.equal(genriched.thread_label, "Group: Gale, Alex, Jo Sample 2026-06-17");

  // Miss on the map -> falls back to the opaque chat_guid label, NOT a throw.
  const missRow = {
    source: "imessage",
    ts: "2026-06-17T12:00:00Z",
    raw_content: { chat_guid: "any;-;+10000000000" },
  };
  const missDesc = deriveDescriptorFromSourceRow(missRow, { imessageLabelMap: map });
  assert.ok(missDesc.thread_label.includes("any;-;+10000000000"));
});

// ---------------------------------------------------------------------------
// J. Public defaults + statMtimeMs utility
// ---------------------------------------------------------------------------

test("J. production default paths + statMtimeMs fingerprint", () => {
  // Defaults point at the operator's real Library — exported so the daemon /
  // build-script callers don't re-derive them (and the offline test asserts
  // their shape WITHOUT reading them).
  assert.match(DEFAULT_CHAT_DB_PATH, /Library\/Messages\/chat\.db$/);
  assert.match(DEFAULT_ADDRESSBOOK_SOURCES_DIR, /AddressBook\/Sources$/);
  // statMtimeMs returns a number for an existing file, null otherwise.
  const chatDb = buildFixtureChatDb([{ guid: "x", style: 45, handles: ["+15555550123"] }]);
  const m = statMtimeMs(chatDb);
  assert.equal(typeof m, "number");
  assert.equal(statMtimeMs("/no/such/file.db"), null);
});

// ---------------------------------------------------------------------------
// I. End-to-end orchestrator stats over a mixed fixture corpus
// ---------------------------------------------------------------------------

test("I. recoverImessageLabels stats account for named group / group-via-contacts / DM", async () => {
  const chatDb = buildFixtureChatDb([
    // DM resolved
    { guid: "dm1", style: 45, handles: ["+15555550123"] },
    // DM unresolved (no contact)
    { guid: "dm2", style: 45, handles: ["+10000000000"] },
    // group with human display_name
    { guid: "g1", style: 43, display_name: "Family", handles: ["+15555550123"] },
    // group unnamed but with a resolved contact
    { guid: "g2", style: 43, display_name: "b11550", handles: ["+15555550124", "+10000000000"] },
    // group fully unresolved
    { guid: "g3", style: 43, display_name: "424484", handles: ["+18888888888"] },
  ]);
  const ab = buildFixtureAddressBook([
    { first: "Mom", phones: ["+15555550123"] },
    { first: "Dad", phones: ["+15555550124"] },
  ]);
  const r = await recoverImessageLabels({ chatDbPath: chatDb, addressBookDbPaths: [ab], persist: false });
  assert.equal(r.stats.chats_seen, 5);
  assert.equal(r.stats.dms_resolved, 1);
  assert.equal(r.stats.named_groups, 1);
  assert.equal(r.stats.group_via_contacts, 1);
  assert.equal(r.stats.labeled, 3);
  assert.equal(r.byChatGuid.get("dm1"), "Mom");
  assert.equal(r.byChatGuid.get("g1"), "Family");
  assert.ok(r.byChatGuid.get("g2").startsWith("Group: Dad"));
  assert.equal(r.byChatGuid.has("dm2"), false);
  assert.equal(r.byChatGuid.has("g3"), false);
  // VERSION export is well-formed.
  assert.match(NAME_RECOVERY_VERSION, /^imessage-name-recovery@\d+\.\d+\.\d+$/);
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

test("ZZ cleanup", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  assert.ok(true);
});
