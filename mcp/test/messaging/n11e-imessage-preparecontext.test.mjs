// n11e-imessage-preparecontext.test.mjs — WORKUNIT N11e gate.
//
// N11e adds the OPTIONAL, GENERIC `prepareContext()` to the iMessage L1 adapter
// (mirroring the WhatsApp adapter, whatsapp.js:427-471). The L5 catch-up surface
// calls `adapter.prepareContext?.()` ONCE per registry adapter — with NO platform
// branch — and threads the returned object as `ctx` (opts) into every
// `toEnvelope(row, ctx)` for that adapter (catchup.js:557-578). The iMessage
// adapter's prepareContext builds the READ-ONLY AddressBook contact maps
// { phoneToName, emailToName } from the operator's local *.abcddb sources via
// `_imessage-name-recovery.js` (resolveAddressBookDbPaths + buildContactMaps). The
// adapter then resolves an inbound handle -> a REAL contact name when the connector
// never pre-stamped `recovered_handle_name` (the live ledger nulls it on ~all rows,
// so sender.name was null -> person:<hash> downstream). Telegram / mail export no
// prepareContext, so the generic loop feeds them {} and they map exactly as before.
//
// LIGHT + HERMETIC: node:test + node:assert/strict, >=12 assertions. Builds a
// SMALL temp AddressBook-v22.abcddb via node:sqlite (the ONLY write — to a throwaway
// tmp fixture DB, never the operator's source ledger / fact rows / real chat.db /
// real AddressBook), opens it READ-ONLY through buildContactMaps. Every inbound
// row is a synthetic in-memory row; no ledger is read. NO embed, NO full suite,
// NO daemon, NO network.
// Runs well under 2s.
//
// What this proves (mapped to the N11e GATE):
//   1. prepareContext builds { contactMaps:{phoneToName,emailToName} } from the
//      read-only AddressBook DB.
//   2. an inbound iMessage row with a NULL stamped name + the prepared ctx -> a
//      REAL sender.name (NOT null, NOT a person:<hash>).
//   3. WITHOUT the ctx the SAME row keeps sender.name=null (the ctx is load-bearing).
//   4. an already-stamped recovered_handle_name still WINS over the ctx maps
//      (precedence + backward-compat).
//   5. prepareContext is MEMOIZED per process (the DB build runs at most once).
//   6. prepareContext degrades to {} when the AddressBook sources are absent.
//   7. the catch-up registry carries the preparer as a CAPABILITY (no platform
//      branch); buildAdapterRegistry threads it; the generic loader resolves a name.
//   8. telegram / mail export NO prepareContext -> {} -> unchanged; whatsapp's own
//      preparer is untouched by this change.
//   9. L2-5 (classifier/identity/attention/catchup) carry ZERO platform tokens.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  toEnvelope as imToEnvelope,
  _toEnvelope as imToEnvelopeAlias,
  PLATFORM as IM_PLATFORM,
  prepareContext as imPrepareContext,
  __resetPrepareContextMemo,
} from "../../lib/messaging/adapters/imessage.js";
import * as whatsapp from "../../lib/messaging/adapters/whatsapp.js";
import * as telegram from "../../lib/messaging/adapters/telegram.js";
import * as mail from "../../lib/messaging/adapters/mail.js";
import { buildContactMaps } from "../../lib/connectors/_imessage-name-recovery.js";
import { validateEnvelope } from "../../lib/messaging/envelope.js";
import {
  buildAdapterRegistry,
  loadEnvelopesFromSources,
} from "../../lib/messaging/catchup.js";
import { grepPlatformTokens, L2to5_SOURCES } from "../../lib/messaging/n10-invariant-eval.mjs";

// The phone number + email the fixture AddressBook knows, in the canonical
// handle.id shapes chat.db emits (E.164 phone, lowercased email).
const FIXTURE_PHONE_HANDLE = "+15555550123";
const FIXTURE_PHONE_NAME = "Jane Contact";
const FIXTURE_EMAIL_HANDLE = "friend@example.com";
const FIXTURE_EMAIL_NAME = "Email Friend";

// ---------------------------------------------------------------------------
// Build a SMALL temp AddressBook-v22.abcddb fixture with the three side-tables
// buildContactMaps reads (ZABCDRECORD / ZABCDPHONENUMBER / ZABCDEMAILADDRESS).
// The ONLY write in this suite; it targets a throwaway tmp DB — never the
// operator's real AddressBook, source ledger, or any fact row.
// ---------------------------------------------------------------------------
async function makeTempAddressBook() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null; // node:sqlite unavailable — caller degrades to ctx-less assertions.
  }
  const dir = mkdtempSync(path.join(tmpdir(), "n11e-ab-"));
  const dbPath = path.join(dir, "AddressBook-v22.abcddb");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY AUTOINCREMENT, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT, ZNICKNAME TEXT);
    CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY AUTOINCREMENT, ZOWNER INTEGER, ZFULLNUMBER TEXT);
    CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY AUTOINCREMENT, ZOWNER INTEGER, ZADDRESS TEXT);
  `);
  // A phone contact: handle.id "+15555550123" normalizes to "5555550123".
  db.prepare(
    "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZNICKNAME) VALUES (1, 'Jane', 'Contact', NULL, NULL)",
  ).run();
  db.prepare("INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (1, ?)").run("(555) 555-0123");
  // An email contact.
  db.prepare(
    "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZNICKNAME) VALUES (2, 'Email', 'Friend', NULL, NULL)",
  ).run();
  db.prepare("INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS) VALUES (2, ?)").run(FIXTURE_EMAIL_HANDLE);
  db.close();
  return { dir, dbPath };
}

// A synthetic INBOUND iMessage row in the retained imessage.jsonl shape, with a
// NULL stamped recovered_handle_name (the live-ledger default).
function syntheticInboundRow(handle, { stampedName = null } = {}) {
  return {
    id: `im:synthetic:${handle}`,
    ts: "2026-06-20T12:00:00.000Z",
    source: "imessage",
    source_msg_id: `synthetic-${handle}`,
    parties: [handle, "user"],
    raw_content: {
      text: "hey are we still on for tomorrow?",
      handle_id: handle,
      chat_guid: `iMessage;-;${handle}`,
      cache_roomnames: null,
      is_from_me: 0,
      thread_originator_guid: null,
      participant_count: 2,
      recovered_handle_name: stampedName,
    },
  };
}

// ---------------------------------------------------------------------------
// 1 — the read-only AddressBook builder outputs the correct phone/email maps.
// ---------------------------------------------------------------------------
test("N11e-1: buildContactMaps returns the resolved phone + email name maps", async () => {
  const fixture = await makeTempAddressBook();
  if (fixture === null) { assert.ok(true, "node:sqlite unavailable — skipped"); return; }
  try {
    const { phoneToName, emailToName, sourcesRead } = await buildContactMaps([fixture.dbPath]);
    assert.ok(phoneToName instanceof Map && emailToName instanceof Map, "both maps are Maps");
    assert.equal(sourcesRead, 1, "the one readable source was read");
    // Phone normalizes to the last-10 digits regardless of stored format.
    assert.equal(phoneToName.get("5555550123"), FIXTURE_PHONE_NAME, "phone contact resolved");
    assert.equal(emailToName.get(FIXTURE_EMAIL_HANDLE), FIXTURE_EMAIL_NAME, "email contact resolved");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2 — prepareContext builds { contactMaps } from the read-only AddressBook DB.
// ---------------------------------------------------------------------------
test("N11e-2: prepareContext builds { contactMaps:{phoneToName,emailToName} } from the read-only DB", async () => {
  const fixture = await makeTempAddressBook();
  if (fixture === null) { assert.ok(true, "node:sqlite unavailable — skipped"); return; }
  try {
    __resetPrepareContextMemo();
    const ctx = await imPrepareContext({ addressBookDbPaths: [fixture.dbPath], noMemo: true });
    assert.ok(ctx.contactMaps && typeof ctx.contactMaps === "object", "ctx.contactMaps present");
    assert.ok(ctx.contactMaps.phoneToName instanceof Map, "ctx.contactMaps.phoneToName is a Map");
    assert.ok(ctx.contactMaps.emailToName instanceof Map, "ctx.contactMaps.emailToName is a Map");
    assert.equal(ctx.contactMaps.phoneToName.get("5555550123"), FIXTURE_PHONE_NAME, "phone name surfaced via prepareContext");
    assert.equal(ctx.contactMaps.emailToName.get(FIXTURE_EMAIL_HANDLE), FIXTURE_EMAIL_NAME, "email name surfaced via prepareContext");
  } finally {
    __resetPrepareContextMemo();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3 — THE CORE CLAIM: an inbound row with a NULL stamped name + the prepared ctx
// -> a REAL sender.name. WITHOUT the ctx the SAME row keeps sender.name=null.
// ---------------------------------------------------------------------------
test("N11e-3: an inbound row resolves to a REAL name with ctx (and null without it)", async () => {
  const fixture = await makeTempAddressBook();
  if (fixture === null) { assert.ok(true, "node:sqlite unavailable — skipped"); return; }
  try {
    __resetPrepareContextMemo();
    const ctx = await imPrepareContext({ addressBookDbPaths: [fixture.dbPath], noMemo: true });

    // (a) phone handle -> the AddressBook contact name (not null).
    const rowPhone = syntheticInboundRow(FIXTURE_PHONE_HANDLE);
    const envPhone = imToEnvelope(rowPhone, ctx);
    assert.equal(envPhone.sender.name, FIXTURE_PHONE_NAME, "phone contact name reaches the envelope");
    assert.equal(envPhone.sender.id, FIXTURE_PHONE_HANDLE, "sender.id is the raw handle (join key)");

    // (b) email handle -> the AddressBook email contact name.
    const rowEmail = syntheticInboundRow(FIXTURE_EMAIL_HANDLE);
    const envEmail = imToEnvelope(rowEmail, ctx);
    assert.equal(envEmail.sender.name, FIXTURE_EMAIL_NAME, "email contact name reaches the envelope");

    // (c) WITHOUT ctx the SAME phone row resolves to NO genuine contact name. We
    // read the genuine-resolution metric with handleNameFloor:false (the N11f
    // DISPLAY floor would otherwise fill the formatted number) — proving the ctx
    // contact map is what produced the REAL name, not the floor.
    const envNoCtx = imToEnvelope(rowPhone, { handleNameFloor: false });
    assert.equal(envNoCtx.sender.name, null, "no-ctx inbound has NO genuine contact name (floor off)");
    assert.notEqual(envNoCtx.sender.name, envPhone.sender.name, "ctx changed the resolved name (load-bearing)");
    // And with the floor ON (default), the SAME no-ctx row is NEVER null/hash — it
    // shows the readable number (the N11f guarantee).
    const envNoCtxFloored = imToEnvelope(rowPhone);
    assert.equal(envNoCtxFloored.sender.name, "+1 555 555 0123", "floor shows the number when no contact resolves");

    // Both ctx-resolved envelopes validate against the frozen N1 contract.
    assert.equal(validateEnvelope(envPhone).ok, true, "phone-resolved envelope validates");
    assert.equal(validateEnvelope(envEmail).ok, true, "email-resolved envelope validates");
  } finally {
    __resetPrepareContextMemo();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4 — a connector-stamped recovered_handle_name WINS over the ctx maps
// (precedence + backward-compat: the existing N4 read path is unchanged).
// ---------------------------------------------------------------------------
test("N11e-4: a stamped recovered_handle_name wins over the ctx contact maps", async () => {
  const fixture = await makeTempAddressBook();
  if (fixture === null) { assert.ok(true, "node:sqlite unavailable — skipped"); return; }
  try {
    __resetPrepareContextMemo();
    const ctx = await imPrepareContext({ addressBookDbPaths: [fixture.dbPath], noMemo: true });
    // Same phone handle the AddressBook would resolve to "Jane Contact", but the
    // connector already stamped a (newer, poll-time) name — the stamp must win.
    const row = syntheticInboundRow(FIXTURE_PHONE_HANDLE, { stampedName: "Stamped Name" });
    const env = imToEnvelope(row, ctx);
    assert.equal(env.sender.name, "Stamped Name", "stamped name wins over the ctx map");
    assert.notEqual(env.sender.name, FIXTURE_PHONE_NAME, "the ctx map did NOT override a stamped name");
  } finally {
    __resetPrepareContextMemo();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5 — prepareContext is MEMOIZED per process (the read-only build runs once).
// ---------------------------------------------------------------------------
test("N11e-5: prepareContext is memoized — repeated calls return the SAME context", async () => {
  const fixture = await makeTempAddressBook();
  if (fixture === null) { assert.ok(true, "node:sqlite unavailable — skipped"); return; }
  try {
    __resetPrepareContextMemo();
    // First call (memoized) seeds the per-process cache from the fixture DB.
    const first = await imPrepareContext({ addressBookDbPaths: [fixture.dbPath] });
    // A second call WITHOUT args must return the cached promise's value — the SAME
    // object reference — proving the DB build did not run again.
    const second = await imPrepareContext();
    assert.equal(first, second, "memoized: identical object reference on the second call");
    assert.equal(second.contactMaps.phoneToName.get("5555550123"), FIXTURE_PHONE_NAME, "memoized ctx carries the built maps");
  } finally {
    __resetPrepareContextMemo();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6 — prepareContext degrades to {} when the AddressBook sources are absent
// (no throw, the adapter falls back to the documented null-name path).
// ---------------------------------------------------------------------------
test("N11e-6: prepareContext degrades to {} when AddressBook sources are absent", async () => {
  __resetPrepareContextMemo();
  // An explicit empty path set (no sources discovered) -> {}.
  const empty = await imPrepareContext({ addressBookDbPaths: [], noMemo: true });
  assert.deepEqual(empty, {}, "no sources -> empty context");
  // A nonexistent path -> buildContactMaps skips it -> {} (sourcesRead 0, maps empty).
  const missing = await imPrepareContext({ addressBookDbPaths: ["/nonexistent/AddressBook-v22.abcddb"], noMemo: true });
  assert.deepEqual(missing, {}, "absent DB -> empty context (graceful degradation)");
  // A row mapped under the empty ctx resolves NO genuine contact name (no throw).
  // The genuine-resolution read (floor off) is null; the default (floor on) shows
  // the formatted number — never a hash.
  const env = imToEnvelope(syntheticInboundRow(FIXTURE_PHONE_HANDLE), { ...empty, handleNameFloor: false });
  assert.equal(env.sender.name, null, "empty ctx -> no genuine contact name (floor off)");
  const envFloored = imToEnvelope(syntheticInboundRow(FIXTURE_PHONE_HANDLE), empty);
  assert.equal(envFloored.sender.name, "+1 555 555 0123", "empty ctx -> the formatted-number floor (never null/hash)");
  __resetPrepareContextMemo();
});

// ---------------------------------------------------------------------------
// 7 — the catch-up REGISTRY carries the preparer as a CAPABILITY (no platform
// branch); the generic loader threads the ctx so an inbound DM surfaces a name.
// ---------------------------------------------------------------------------
test("N11e-7: the adapter registry carries prepareContext as a capability; the loader threads ctx", async () => {
  const fixture = await makeTempAddressBook();
  if (fixture === null) { assert.ok(true, "node:sqlite unavailable — skipped"); return; }
  try {
    __resetPrepareContextMemo();
    // A registry whose iMessage entry's prepareContext is bound to the fixture DB
    // (the live default globs the operator's real AddressBook; we inject the tmp one).
    const imMod = {
      PLATFORM: IM_PLATFORM,
      _toEnvelope: imToEnvelope,
      prepareContext: () => imPrepareContext({ addressBookDbPaths: [fixture.dbPath], noMemo: true }),
    };
    const registry = buildAdapterRegistry([imMod, telegram, mail]);
    const entry = registry.get(IM_PLATFORM);
    assert.equal(typeof entry.prepareContext, "function", "iMessage registry entry carries prepareContext");

    const sources = {
      [IM_PLATFORM]: [syntheticInboundRow(FIXTURE_PHONE_HANDLE), syntheticInboundRow(FIXTURE_EMAIL_HANDLE)],
    };
    const envelopes = await loadEnvelopesFromSources(sources, registry);
    const names = envelopes.map((e) => e.sender && e.sender.name);
    assert.ok(names.includes(FIXTURE_PHONE_NAME), "the AddressBook phone name reached the loaded envelopes");
    assert.ok(names.includes(FIXTURE_EMAIL_NAME), "the AddressBook email name reached the loaded envelopes");
    for (const e of envelopes) {
      assert.equal(validateEnvelope(e).ok, true, "every loaded envelope validates");
    }
  } finally {
    __resetPrepareContextMemo();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8 — telegram / mail export NO prepareContext (unaffected). WhatsApp's own
// preparer is untouched by this change (still present + a function).
// ---------------------------------------------------------------------------
test("N11e-8: telegram/mail have no prepareContext; whatsapp's preparer is unaffected", async () => {
  assert.equal(typeof telegram.prepareContext, "undefined", "telegram exports no prepareContext");
  assert.equal(typeof mail.prepareContext, "undefined", "mail exports no prepareContext");
  assert.equal(typeof whatsapp.prepareContext, "function", "whatsapp still exports its own prepareContext");
  // A preparer-less registry threads {} and never invokes a preparer (no throw).
  const registry = buildAdapterRegistry([telegram, mail]);
  for (const [, entry] of registry.entries()) {
    assert.equal(entry.prepareContext, null, "a preparer-less adapter carries prepareContext=null in the registry");
  }
  const envelopes = await loadEnvelopesFromSources({}, registry);
  assert.ok(Array.isArray(envelopes), "load over preparer-less adapters returns an array");
});

// ---------------------------------------------------------------------------
// 9 — the abstraction invariant: L2-5 carry ZERO platform tokens. The iMessage
// prepareContext lives in the L1 ADAPTER; it adds no platform name to L2-5.
// ---------------------------------------------------------------------------
test("N11e-9: L2-5 carry ZERO platform tokens after the N11e wiring", () => {
  const { count, matches } = grepPlatformTokens();
  assert.equal(count, 0, `expected 0 platform tokens in L2-5, got ${count}: ${JSON.stringify(matches.slice(0, 5))}`);
  // Five since f5-catchup-seam registered lib/messaging/ledger-retain.js (the
  // retain leaf carved out of catchup.js to break the catchup <-> projection
  // import cycle) — the gate WIDENED with the move, it did not shrink.
  assert.equal(L2to5_SOURCES.length, 5, "the grep scans exactly the five L2-5 sources");
});

// ---------------------------------------------------------------------------
// 10 — THESIS #1: ctx enrichment touches ONLY the sender name, not the rest of
// the envelope (read-only projection; the input row is never mutated).
// ---------------------------------------------------------------------------
test("N11e-10: ctx enrichment touches ONLY the sender name, not the rest of the envelope", async () => {
  const fixture = await makeTempAddressBook();
  if (fixture === null) { assert.ok(true, "node:sqlite unavailable — skipped"); return; }
  try {
    __resetPrepareContextMemo();
    const ctx = await imPrepareContext({ addressBookDbPaths: [fixture.dbPath], noMemo: true });
    const row = syntheticInboundRow(FIXTURE_PHONE_HANDLE);
    const withCtx = imToEnvelope(row, ctx);
    // Baseline reads the genuine-resolution metric (floor off) so the only delta is
    // the contact name (null -> resolved), not the display floor.
    const without = imToEnvelope(row, { handleNameFloor: false });
    assert.equal(withCtx.platform, without.platform, "platform unchanged by ctx");
    assert.equal(withCtx.thread_id, without.thread_id, "thread_id unchanged by ctx");
    assert.equal(withCtx.thread_type, without.thread_type, "thread_type unchanged by ctx");
    assert.equal(withCtx.is_from_me, without.is_from_me, "is_from_me unchanged by ctx");
    assert.equal(withCtx.source_msg_id, without.source_msg_id, "source_msg_id unchanged by ctx");
    assert.equal(withCtx.ts, without.ts, "ts unchanged by ctx");
    assert.equal(withCtx.reply_to_id, without.reply_to_id, "reply_to_id unchanged by ctx");
    // The only delta is the sender name (null -> resolved).
    assert.equal(without.sender.name, null, "baseline genuine name is null (floor off)");
    assert.equal(withCtx.sender.name, FIXTURE_PHONE_NAME, "ctx resolved the name");
    // The raw input row object is itself never mutated by the mapper.
    assert.equal(row.raw_content.recovered_handle_name, null, "the input row is not mutated");
  } finally {
    __resetPrepareContextMemo();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 11 — outbound rows are NEVER touched by the ctx (sender is always "user").
// ---------------------------------------------------------------------------
test("N11e-11: outbound rows ignore the ctx — sender stays the operator self", async () => {
  const fixture = await makeTempAddressBook();
  if (fixture === null) { assert.ok(true, "node:sqlite unavailable — skipped"); return; }
  try {
    __resetPrepareContextMemo();
    const ctx = await imPrepareContext({ addressBookDbPaths: [fixture.dbPath], noMemo: true });
    const outbound = {
      ...syntheticInboundRow(FIXTURE_PHONE_HANDLE),
      parties: ["user", FIXTURE_PHONE_HANDLE],
      raw_content: { ...syntheticInboundRow(FIXTURE_PHONE_HANDLE).raw_content, is_from_me: 1 },
    };
    const env = imToEnvelope(outbound, ctx);
    assert.equal(env.is_from_me, true, "row is outbound");
    assert.equal(env.sender.id, "user", "outbound sender.id is the operator self");
    assert.equal(env.sender.name, "user", "outbound sender.name is the operator self (ctx ignored)");
    assert.notEqual(env.sender.name, FIXTURE_PHONE_NAME, "the ctx map did NOT name the operator");
  } finally {
    __resetPrepareContextMemo();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 12 — a synthetic inbound row in the imessage.jsonl ledger-row shape validates
// and maps under the prepared ctx. LIGHT: ONE row. The `_toEnvelope` alias
// the registry dispatches on is the same function as `toEnvelope`.
// ---------------------------------------------------------------------------
test("N11e-12: a synthetic inbound row validates + maps under ctx; _toEnvelope alias matches", async () => {
  assert.equal(imToEnvelopeAlias, imToEnvelope, "_toEnvelope is the toEnvelope alias (registry dispatch key)");
  const fixture = await makeTempAddressBook();
  if (fixture === null) { assert.ok(true, "node:sqlite unavailable — skipped"); return; }
  try {
    __resetPrepareContextMemo();
    const ctx = await imPrepareContext({ addressBookDbPaths: [fixture.dbPath], noMemo: true });
    // The synthetic phone row (hermetic: no ledger is read). The ctx names our
    // synthetic handle, so we assert both that the envelope validates and that
    // the genuine DB-resolved name comes through.
    const row = syntheticInboundRow(FIXTURE_PHONE_HANDLE);
    const env = imToEnvelope(row, ctx);
    const v = validateEnvelope(env);
    assert.equal(v.ok, true, `the sampled inbound envelope validates: ${JSON.stringify(v.errors)}`);
    assert.equal(env.platform, "imessage", "the envelope stamps its platform as DATA");
    assert.equal(env.sender.name, FIXTURE_PHONE_NAME, "the synthetic handle resolves via ctx");
  } finally {
    __resetPrepareContextMemo();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
