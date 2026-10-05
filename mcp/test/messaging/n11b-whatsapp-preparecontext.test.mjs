// n11b-whatsapp-preparecontext.test.mjs — WORKUNIT N11b gate.
//
// N11b adds an OPTIONAL, GENERIC `prepareContext()` to the L1 adapter contract.
// The catch-up surface (L5) calls `adapter.prepareContext?.()` ONCE per registry
// adapter — with NO platform branch — and threads the returned object as the
// `ctx` (opts) into every `toEnvelope(row, ctx)` for that adapter. The WhatsApp
// adapter (the ONLY one that names ChatStorage) exports prepareContext(): it opens
// the local ChatStorage.sqlite READ-ONLY and builds the three name sidecars
// `_toEnvelope` already consumes ({ partnerByJid, pushByJid, memberNames }). The
// result: a 1:1 @lid DM whose name the DB genuinely knows resolves to that REAL
// name at catch-up time; the best-effort floor label fires ONLY when the DB
// truly lacks the name. Telegram / mail / iMessage export no prepareContext, so
// the generic loop feeds them {} and they map exactly as before.
//
// LIGHT + HERMETIC: node:test + node:assert/strict, >=12 assertions. Builds a
// SMALL temp ChatStorage.sqlite via node:sqlite (the ONLY write — to a throwaway
// tmp fixture DB, never the operator's source ledger or fact rows), opens it
// READ-ONLY through prepareContext. SAMPLES one real row from
// storage/sources/whatsapp.jsonl WHEN PRESENT (a single representative @lid 1:1
// inbound), degrading to a synthetic in-memory row otherwise. NO embed, NO full
// suite, NO daemon, NO network. Runs well under 2s.
//
// What this proves (mapped to the N11b GATE):
//   1. prepareContext builds { partnerByJid, pushByJid, memberNames } correctly
//      from the read-only DB (the two new builders output the right Maps).
//   2. a 1:1 @lid inbound row + the partnerByJid/pushByJid ctx -> a REAL name
//      (NOT the "WhatsApp user <last4>" floor).
//   3. WITHOUT the ctx the SAME row falls to the documented floor (the ctx is
//      load-bearing — it is what makes the real name reach the surface).
//   4. prepareContext is MEMOIZED per process (the DB build runs at most once).
//   5. the catch-up registry carries the preparer as a CAPABILITY (no platform
//      branch); buildCatchup threads the ctx so an @lid DM surfaces a real name.
//   6. telegram / mail adapters export NO prepareContext -> {} -> unchanged.
//   7. L5 (catchup.js) carries ZERO platform tokens (the abstraction invariant).
//   8. a real whatsapp.jsonl @lid 1:1 row (or a synthetic fallback) validates and
//      surfaces a NON-RAW name through the prepared ctx.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  _toEnvelope as waToEnvelope,
  PLATFORM as WA_PLATFORM,
  prepareContext as waPrepareContext,
  __resetPrepareContextMemo,
} from "../../lib/messaging/adapters/whatsapp.js";
import * as telegram from "../../lib/messaging/adapters/telegram.js";
import * as mail from "../../lib/messaging/adapters/mail.js";
import {
  buildPartnerAndPushNameMapsFromDb,
  buildGroupMemberNamesFromDb,
} from "../../lib/connectors/whatsapp-sender-index.js";
import { validateEnvelope } from "../../lib/messaging/envelope.js";
import {
  buildAdapterRegistry,
  buildCatchup,
  loadEnvelopesFromSources,
} from "../../lib/messaging/catchup.js";
import { grepPlatformTokens, L2to5_SOURCES } from "../../lib/messaging/n10-invariant-eval.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../..");
const WA_LEDGER = path.join(REPO, "storage", "sources", "whatsapp.jsonl");

// ---------------------------------------------------------------------------
// Build a SMALL temp ChatStorage.sqlite fixture with the three side-tables the
// WhatsApp name builders read. The ONLY write in this suite, and it targets a
// throwaway tmp DB — never the operator's source ledger or any fact row.
// ---------------------------------------------------------------------------
async function makeTempChatStorage() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null; // node:sqlite unavailable — caller degrades to ctx-less assertions.
  }
  const dir = mkdtempSync(path.join(tmpdir(), "n11b-cs-"));
  const dbPath = path.join(dir, "ChatStorage.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE ZWACHATSESSION (Z_PK INTEGER, ZCONTACTJID TEXT, ZPARTNERNAME TEXT, ZSESSIONTYPE INTEGER)",
  );
  db.exec("CREATE TABLE ZWAPROFILEPUSHNAME (ZJID TEXT, ZPUSHNAME TEXT)");
  db.exec(
    "CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER, ZMEMBERJID TEXT, ZCONTACTNAME TEXT, ZFIRSTNAME TEXT)",
  );
  // A 1:1 @lid partner whose ZPARTNERNAME is a SAVED contact name.
  db.prepare("INSERT INTO ZWACHATSESSION VALUES (?,?,?,?)").run(1, "111111@lid", "Alice Saved", 0);
  // A 1:1 @lid partner whose ZPARTNERNAME is ONLY a formatted phone -> excluded
  // from partnerByJid; the pushByJid fallback names them (the WU N3 gap fix path).
  db.prepare("INSERT INTO ZWACHATSESSION VALUES (?,?,?,?)").run(2, "222222@lid", "+1 (650) 555-1212", 0);
  db.prepare("INSERT INTO ZWAPROFILEPUSHNAME VALUES (?,?)").run("222222@lid", "Bob Push");
  // A push-name row for a contact that has NO session partner name (push-only).
  db.prepare("INSERT INTO ZWAPROFILEPUSHNAME VALUES (?,?)").run("333333@lid", "Carol Push");
  // A group member with a saved contact name + one with only a first name.
  db.prepare("INSERT INTO ZWAGROUPMEMBER VALUES (?,?,?,?)").run(1, "444@s.whatsapp.net", "Dave Member", null);
  db.prepare("INSERT INTO ZWAGROUPMEMBER VALUES (?,?,?,?)").run(2, "555@s.whatsapp.net", null, "Eve");
  db.close();
  return { dir, dbPath };
}

// A synthetic 1:1 @lid INBOUND row in the retained whatsapp.jsonl shape.
function syntheticLidRow(jid) {
  return {
    id: `wa:synthetic:${jid}`,
    ts: "2026-06-20T12:00:00.000Z",
    source: "whatsapp",
    source_msg_id: `synthetic-${jid}`,
    parties: [jid, "user"],
    raw_content: {
      text: "hey are we still on for tomorrow?",
      from_jid: jid,
      to_jid: null,
      session_jid: jid,
      is_from_me: 0,
      session_type: 0,
    },
  };
}

// Read ONE real @lid 1:1 inbound row from the local ledger, or null when absent.
function realLidRow() {
  if (!existsSync(WA_LEDGER)) return null;
  try {
    const lines = readFileSync(WA_LEDGER, "utf8").split("\n");
    for (const ln of lines) {
      if (!ln.includes("@lid")) continue;
      let row;
      try { row = JSON.parse(ln); } catch { continue; }
      const rc = row && row.raw_content;
      if (!rc) continue;
      if (rc.is_from_me !== 0) continue;
      if (typeof rc.text !== "string" || rc.text.length === 0) continue;
      if (!String(rc.session_jid || "").endsWith("@lid")) continue;
      return row;
    }
  } catch { /* degrade to synthetic */ }
  return null;
}

// ---------------------------------------------------------------------------
// 1 — the two NEW read-only DB builders output the correct Maps.
// ---------------------------------------------------------------------------
test("N11b-1: buildPartnerAndPushNameMapsFromDb returns the resolved partner + push maps", async () => {
  const fixture = await makeTempChatStorage();
  if (fixture === null) { assert.ok(true, "node:sqlite unavailable — skipped"); return; }
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      const { partnerByJid, pushByJid } = buildPartnerAndPushNameMapsFromDb(db);
      assert.ok(partnerByJid instanceof Map && pushByJid instanceof Map, "both sidecars are Maps");
      // A SAVED name is retained; a bare formatted-phone ZPARTNERNAME is excluded.
      assert.equal(partnerByJid.get("111111@lid"), "Alice Saved", "saved 1:1 name kept");
      assert.equal(partnerByJid.has("222222@lid"), false, "a formatted-phone partner name is excluded");
      // The push-name cache carries the self-set names.
      assert.equal(pushByJid.get("222222@lid"), "Bob Push", "push name recovered for the phone-only partner");
      assert.equal(pushByJid.get("333333@lid"), "Carol Push", "push-only contact recovered");
    } finally {
      db.close();
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("N11b-2: buildGroupMemberNamesFromDb returns member_jid -> resolved display name", async () => {
  const fixture = await makeTempChatStorage();
  if (fixture === null) { assert.ok(true, "node:sqlite unavailable — skipped"); return; }
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      const memberNames = buildGroupMemberNamesFromDb(db);
      assert.ok(memberNames instanceof Map, "memberNames is a Map");
      assert.equal(memberNames.get("444@s.whatsapp.net"), "Dave Member", "ZCONTACTNAME wins");
      assert.equal(memberNames.get("555@s.whatsapp.net"), "Eve", "ZFIRSTNAME fallback resolves");
    } finally {
      db.close();
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// The builders are TOTAL: a null / non-DB handle yields empty Maps (never throws).
test("N11b-3: the DB builders degrade to empty Maps on a null/invalid handle", () => {
  const a = buildPartnerAndPushNameMapsFromDb(null);
  assert.ok(a.partnerByJid instanceof Map && a.partnerByJid.size === 0, "null -> empty partnerByJid");
  assert.ok(a.pushByJid instanceof Map && a.pushByJid.size === 0, "null -> empty pushByJid");
  const b = buildGroupMemberNamesFromDb({});
  assert.ok(b instanceof Map && b.size === 0, "non-DB object -> empty memberNames");
});

// ---------------------------------------------------------------------------
// 4 — prepareContext builds the three sidecars from the read-only DB.
// ---------------------------------------------------------------------------
test("N11b-4: prepareContext builds { partnerByJid, pushByJid, memberNames } from the read-only DB", async () => {
  const fixture = await makeTempChatStorage();
  if (fixture === null) { assert.ok(true, "node:sqlite unavailable — skipped"); return; }
  try {
    __resetPrepareContextMemo();
    const ctx = await waPrepareContext({ chatStoragePath: fixture.dbPath, noMemo: true });
    assert.ok(ctx.partnerByJid instanceof Map, "ctx.partnerByJid is a Map");
    assert.ok(ctx.pushByJid instanceof Map, "ctx.pushByJid is a Map");
    assert.ok(ctx.memberNames instanceof Map, "ctx.memberNames is a Map");
    assert.equal(ctx.partnerByJid.get("111111@lid"), "Alice Saved", "partner name surfaced via prepareContext");
    assert.equal(ctx.pushByJid.get("222222@lid"), "Bob Push", "push name surfaced via prepareContext");
  } finally {
    __resetPrepareContextMemo();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// prepareContext degrades to {} when the DB path is missing (no throw, floor path).
test("N11b-5: prepareContext degrades to {} when ChatStorage is absent", async () => {
  __resetPrepareContextMemo();
  const ctx = await waPrepareContext({ chatStoragePath: "/nonexistent/ChatStorage.sqlite", noMemo: true });
  assert.deepEqual(ctx, {}, "absent DB -> empty context (graceful degradation)");
  __resetPrepareContextMemo();
});

// ---------------------------------------------------------------------------
// 6 — THE CORE CLAIM: a 1:1 @lid inbound row + the prepared ctx -> a REAL name,
// NOT the floor. Without the ctx the SAME row falls to the documented floor.
// ---------------------------------------------------------------------------
test("N11b-6: an @lid 1:1 DM resolves to a REAL name with ctx (and the floor without it)", async () => {
  const fixture = await makeTempChatStorage();
  if (fixture === null) { assert.ok(true, "node:sqlite unavailable — skipped"); return; }
  try {
    __resetPrepareContextMemo();
    const ctx = await waPrepareContext({ chatStoragePath: fixture.dbPath, noMemo: true });

    // (a) saved-name partner -> the saved name (not the floor).
    const rowA = syntheticLidRow("111111@lid");
    const envA = waToEnvelope(rowA, ctx);
    assert.equal(envA.sender.name, "Alice Saved", "saved partner name reaches the envelope");
    assert.ok(!/@lid/.test(envA.sender.name), "the real name is NOT a raw @lid jid");

    // (b) phone-only partner -> the PUSH name (the WU N3 1:1 gap fix path).
    const rowB = syntheticLidRow("222222@lid");
    const envB = waToEnvelope(rowB, ctx);
    assert.equal(envB.sender.name, "Bob Push", "push-name fallback names the phone-only @lid partner");

    // (c) WITHOUT ctx the same phone-only row falls to the documented floor.
    const envBNoCtx = waToEnvelope(rowB);
    assert.ok(/^WhatsApp user /.test(envBNoCtx.sender.name), "no-ctx @lid falls to the floor label");
    assert.notEqual(envBNoCtx.sender.name, envB.sender.name, "ctx changed the resolved name (load-bearing)");

    // Both envelopes validate against the frozen N1 contract.
    assert.equal(validateEnvelope(envA).ok, true, "ctx-resolved envelope validates");
    assert.equal(validateEnvelope(envB).ok, true, "push-resolved envelope validates");
  } finally {
    __resetPrepareContextMemo();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7 — prepareContext is MEMOIZED per process (the read-only build runs once).
// ---------------------------------------------------------------------------
test("N11b-7: prepareContext is memoized — repeated calls return the SAME context", async () => {
  const fixture = await makeTempChatStorage();
  if (fixture === null) { assert.ok(true, "node:sqlite unavailable — skipped"); return; }
  try {
    __resetPrepareContextMemo();
    // First call (memoized) seeds the per-process cache from the fixture DB.
    const first = await waPrepareContext({ chatStoragePath: fixture.dbPath });
    // A second call WITHOUT a path must return the cached promise's value — the
    // SAME object reference — proving the DB build did not run again.
    const second = await waPrepareContext();
    assert.equal(first, second, "memoized: identical object reference on the second call");
    assert.equal(second.partnerByJid.get("111111@lid"), "Alice Saved", "memoized context carries the built maps");
  } finally {
    __resetPrepareContextMemo();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8 — the catch-up REGISTRY carries the preparer as a CAPABILITY (no platform
// branch), and buildCatchup threads the ctx so an @lid DM surfaces a real name.
// ---------------------------------------------------------------------------
test("N11b-8: the adapter registry carries prepareContext as a capability; buildCatchup threads ctx", async () => {
  const fixture = await makeTempChatStorage();
  if (fixture === null) { assert.ok(true, "node:sqlite unavailable — skipped"); return; }
  try {
    __resetPrepareContextMemo();
    // A registry whose WhatsApp entry's prepareContext is bound to the fixture DB
    // (the live default path is the operator's real DB; we inject the tmp fixture).
    const waMod = {
      PLATFORM: WA_PLATFORM,
      _toEnvelope: waToEnvelope,
      prepareContext: () => waPrepareContext({ chatStoragePath: fixture.dbPath, noMemo: true }),
    };
    const registry = buildAdapterRegistry([waMod, telegram, mail]);
    const entry = registry.get(WA_PLATFORM);
    assert.equal(typeof entry.prepareContext, "function", "WhatsApp registry entry carries prepareContext");

    // Two @lid DMs from two distinct partners, both unanswered + recent.
    const now = Date.parse("2026-06-20T12:05:00.000Z");
    const sources = {
      [WA_PLATFORM]: [syntheticLidRow("111111@lid"), syntheticLidRow("222222@lid")],
    };
    const res = await buildCatchup({ sources, now, registry, min_score: 0.3 });

    // Every surfaced row carries a real name; none is a raw @lid jid.
    let rawLid = 0;
    const names = [];
    for (const r of res.rows) {
      if (typeof r.person_name === "string") names.push(r.person_name);
      if (typeof r.person_name === "string" && /@lid/.test(r.person_name)) rawLid += 1;
    }
    assert.equal(rawLid, 0, "no surfaced row shows a raw @lid jid");
    assert.ok(names.includes("Alice Saved") || names.includes("Bob Push"),
      "a DB-resolved real name reached the catch-up surface");
  } finally {
    __resetPrepareContextMemo();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9 — telegram / mail export NO prepareContext: the registry entry's preparer is
// null and the generic load feeds them {} (telegram/mail unaffected).
// ---------------------------------------------------------------------------
test("N11b-9: telegram / mail adapters have no prepareContext -> {} -> unchanged", async () => {
  assert.equal(typeof telegram.prepareContext, "undefined", "telegram exports no prepareContext");
  assert.equal(typeof mail.prepareContext, "undefined", "mail exports no prepareContext");
  const registry = buildAdapterRegistry([telegram, mail]);
  for (const [, entry] of registry.entries()) {
    assert.equal(entry.prepareContext, null, "a preparer-less adapter carries prepareContext=null in the registry");
  }
  // The generic load over preparer-less adapters returns envelopes (empty here —
  // no rows supplied) WITHOUT ever invoking a preparer. It must not throw.
  const envelopes = await loadEnvelopesFromSources({}, registry);
  assert.ok(Array.isArray(envelopes), "load over preparer-less adapters returns an array");
});

// ---------------------------------------------------------------------------
// 10 — the abstraction invariant: L5 (catchup.js) carries ZERO platform tokens.
// The prepareContext wiring is GENERIC — it adds no platform name to L2-5.
// ---------------------------------------------------------------------------
test("N11b-10: L2-5 carry ZERO platform tokens after the N11b wiring", () => {
  const { count, matches } = grepPlatformTokens();
  assert.equal(count, 0, `expected 0 platform tokens in L2-5, got ${count}: ${JSON.stringify(matches.slice(0, 5))}`);
  // Five since f5-catchup-seam registered lib/messaging/ledger-retain.js (the
  // retain leaf carved out of catchup.js to break the catchup <-> projection
  // import cycle) — the gate WIDENED with the move, it did not shrink.
  assert.equal(L2to5_SOURCES.length, 5, "the grep scans exactly the five L2-5 sources");
});

// ---------------------------------------------------------------------------
// 11 — a REAL whatsapp.jsonl @lid 1:1 row (or a synthetic fallback) validates and
// surfaces a NON-RAW name through the prepared ctx. LIGHT: ONE sampled row.
// ---------------------------------------------------------------------------
test("N11b-11: a real (or synthetic) @lid 1:1 row surfaces a NON-RAW name via ctx", async () => {
  const fixture = await makeTempChatStorage();
  if (fixture === null) { assert.ok(true, "node:sqlite unavailable — skipped"); return; }
  try {
    __resetPrepareContextMemo();
    const ctx = await waPrepareContext({ chatStoragePath: fixture.dbPath, noMemo: true });
    // Prefer a real sampled row; degrade to the synthetic saved-name row so the
    // suite passes on any host. The ctx only names our synthetic jids, so for a
    // real row we assert the NON-RAW floor (the documented degradation), and for
    // the synthetic row we assert the genuine DB-resolved name.
    const real = realLidRow();
    const row = real || syntheticLidRow("111111@lid");
    const env = waToEnvelope(row, ctx);
    const v = validateEnvelope(env);
    assert.equal(v.ok, true, `the sampled @lid envelope validates: ${JSON.stringify(v.errors)}`);
    assert.equal(env.platform, "whatsapp", "the envelope stamps its platform as DATA");
    assert.ok(typeof env.sender.name === "string" && env.sender.name.length > 0, "a name is present");
    assert.ok(!/@lid/.test(env.sender.name), "the surfaced name is NEVER a raw @lid jid");
    if (!real) {
      assert.equal(env.sender.name, "Alice Saved", "the synthetic saved name resolves via ctx");
    }
  } finally {
    __resetPrepareContextMemo();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 12 — THESIS #1: prepareContext never widens the write surface. It opens the DB
// read-only and the build is a pure projection — a row mapped WITH ctx differs
// from the same row mapped WITHOUT ctx ONLY in the resolved sender name, never in
// platform / thread / is_from_me / source_msg_id (no source mutation).
// ---------------------------------------------------------------------------
test("N11b-12: ctx enrichment touches ONLY the sender name, not the rest of the envelope", async () => {
  const fixture = await makeTempChatStorage();
  if (fixture === null) { assert.ok(true, "node:sqlite unavailable — skipped"); return; }
  try {
    __resetPrepareContextMemo();
    const ctx = await waPrepareContext({ chatStoragePath: fixture.dbPath, noMemo: true });
    const row = syntheticLidRow("111111@lid");
    const withCtx = waToEnvelope(row, ctx);
    const without = waToEnvelope(row);
    assert.equal(withCtx.platform, without.platform, "platform unchanged by ctx");
    assert.equal(withCtx.thread_id, without.thread_id, "thread_id unchanged by ctx");
    assert.equal(withCtx.thread_type, without.thread_type, "thread_type unchanged by ctx");
    assert.equal(withCtx.is_from_me, without.is_from_me, "is_from_me unchanged by ctx");
    assert.equal(withCtx.source_msg_id, without.source_msg_id, "source_msg_id unchanged by ctx");
    assert.equal(withCtx.ts, without.ts, "ts unchanged by ctx");
    // The raw input row object is itself never mutated by the mapper.
    assert.equal(row.raw_content.from_jid, "111111@lid", "the input row is not mutated");
  } finally {
    __resetPrepareContextMemo();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
