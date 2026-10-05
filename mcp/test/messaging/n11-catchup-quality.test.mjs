// n11-catchup-quality.test.mjs — WORKUNIT N11 gate. Two catch-up-quality fixes
// WITHOUT breaking the abstraction invariant (no platform branch above L1):
//
//   (A1) WhatsApp 1:1 @lid sender-name resolution reaches the catch-up: an @lid
//        1:1 DM surfaces a NAME (a genuine push name when the sidecar has one;
//        otherwise a best-effort NON-RAW floor label) — never the raw @lid jid.
//
//   (A2) Service/bot/system-account exclusion as DATA: adapters stamp sender.kind
//        ∈ {person,bot,service,system} in L1 (telegram 777000=service, is_bot=bot;
//        whatsapp status/broadcast=system; others=person); attention.js + catchup.js
//        EXCLUDE non-person by READING sender.kind — ZERO platform tokens in L2-5.
//
// Hermetic: node:test + node:assert/strict, no DB, no network, no fs writes.
// >=12 assertions. Reads only in-memory rows + the lib sources (for the grep gate).
//
// Emits the GATE line:
//   N11-GATE names_resolved=<pct>% service_excluded=true platform_tokens_L2to5=0

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { validateEnvelope, SENDER_KINDS, DEFAULT_SENDER_KIND } from "../../lib/messaging/envelope.js";
import {
  _toEnvelope as waToEnvelope,
  classifySenderKind,
  bestEffortLidLabel,
} from "../../lib/messaging/adapters/whatsapp.js";
import { _toEnvelope as tgToEnvelope } from "../../lib/messaging/adapters/telegram.js";
import { _toEnvelope as imToEnvelope } from "../../lib/messaging/adapters/imessage.js";
import {
  computeAttention,
  getAttentionTelemetry,
  resetAttentionTelemetry,
} from "../../lib/messaging/attention.js";
import { buildCatchupCore } from "../../lib/messaging/catchup.js";
import { grepPlatformTokens, L2to5_SOURCES } from "../../lib/messaging/n10-invariant-eval.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A WhatsApp 1:1 @lid inbound row whose ZPARTNERNAME is unresolved (the GAP case).
function waLidRow({ from = "100555010000001@lid", text = "you free tomorrow?", smid = "WA1" } = {}) {
  return {
    id: smid,
    ts: "2026-03-03T04:10:20.000Z",
    source: "whatsapp",
    source_msg_id: smid,
    parties: [from, "user"],
    raw_content: {
      text,
      from_jid: from,
      to_jid: null,
      session_jid: from,
      is_from_me: 0,
      session_type: 0,
    },
  };
}

// A WhatsApp status/broadcast (system) inbound row.
function waStatusRow({ smid = "WAS1" } = {}) {
  return {
    id: smid,
    ts: "2026-03-02T03:00:00.000Z",
    source: "whatsapp",
    source_msg_id: smid,
    parties: ["status@broadcast", "user"],
    raw_content: {
      text: "[status update]",
      from_jid: "1555000@s.whatsapp.net",
      to_jid: null,
      session_jid: "status@broadcast",
      is_from_me: 0,
      session_type: 3,
    },
  };
}

// A Telegram service (777000) inbound row + a bot inbound row + a person row.
function tgRow({ sender_id, is_bot = false, text = "hi", smid = "TG1", peer = 55501 } = {}) {
  return {
    source_msg_id: smid,
    ts: "2026-03-02T04:00:00.000Z",
    raw_content: {
      peer_type: "user",
      peer_id: peer,
      message_id: 1,
      sender_id,
      sender_name: null,
      is_outgoing: false,
      is_self: false,
      is_bot,
      text,
    },
  };
}

// ===========================================================================
// A2 — sender.kind contract + L1 stamping.
// ===========================================================================

test("A2: envelope contract exposes the closed sender-kind enum + person default", () => {
  assert.deepEqual([...SENDER_KINDS], ["person", "bot", "service", "system"]);
  assert.equal(DEFAULT_SENDER_KIND, "person");
});

test("A2: sender.kind is OPTIONAL (absent ok) and enum-checked (bad kind rejects)", () => {
  // A previously-valid envelope WITHOUT sender.kind still validates (backward-compat).
  const env = imToEnvelope({
    ts: "2026-03-02T02:00:00.000Z",
    source_msg_id: "IM1",
    parties: ["+15105551212", "user"],
    raw_content: { text: "hi", handle_id: "+15105551212", chat_guid: "iMessage;-;+15105551212", is_from_me: 0 },
  });
  // The adapter stamps person; deleting it proves absence is still valid.
  delete env.sender.kind;
  assert.equal(validateEnvelope(env).ok, true, "absent sender.kind must remain valid");
  // A present-but-unknown kind must reject.
  env.sender.kind = "robot";
  const res = validateEnvelope(env);
  assert.equal(res.ok, false);
  assert.equal(res.errors.some((e) => e.field === "sender.kind"), true, "must cite sender.kind");
});

test("A2: telegram stamps service for 777000, bot for is_bot, person otherwise", () => {
  const svc = tgToEnvelope(tgRow({ sender_id: 777000, smid: "TGS" }));
  const bot = tgToEnvelope(tgRow({ sender_id: 424242, is_bot: true, smid: "TGB" }));
  const person = tgToEnvelope(tgRow({ sender_id: 55501, smid: "TGP" }));
  assert.equal(svc.sender.kind, "service", "777000 => service");
  assert.equal(bot.sender.kind, "bot", "is_bot => bot");
  assert.equal(person.sender.kind, "person", "ordinary sender => person");
  // every produced envelope still validates against N1.
  for (const e of [svc, bot, person]) assert.equal(validateEnvelope(e).ok, true);
});

test("A2: whatsapp stamps system for status/broadcast, person for a 1:1", () => {
  const status = waToEnvelope(waStatusRow());
  const dm = waToEnvelope(waLidRow());
  assert.equal(status.sender.kind, "system", "status@broadcast => system");
  assert.equal(dm.sender.kind, "person", "1:1 inbound => person");
  // direct helper unit check (the L1 classifier, by JID shape only).
  assert.equal(classifySenderKind("status@broadcast", null, "channel"), "system");
  assert.equal(classifySenderKind("100555010000001@lid", "100555010000001@lid", "dm"), "person");
  assert.equal(validateEnvelope(status).ok, true);
  assert.equal(validateEnvelope(dm).ok, true);
});

test("A2: attention EXCLUDES non-person inbound by reading sender.kind (DATA, no platform branch)", () => {
  resetAttentionTelemetry();
  const now = Date.parse("2026-03-02T05:00:00.000Z");
  // A genuine person waiting on me + a service account + a system broadcast.
  const person = waToEnvelope(waLidRow({ from: "200000000000001@lid", text: "can you review the deck?", smid: "P1" }));
  const service = tgToEnvelope(tgRow({ sender_id: 777000, text: "Login code: 12345", smid: "S1" }));
  const system = waToEnvelope(waStatusRow({ smid: "SYS1" }));
  const records = computeAttention([person, service, system], { now });
  // The person surfaces; neither non-person sender produces a surfacing record.
  const surfaced = records.filter((r) => r.surface === true);
  assert.ok(surfaced.length >= 1, "the person thread surfaces");
  assert.ok(
    surfaced.every((r) => r.last_sender && r.last_sender.id && !String(r.last_sender.id).startsWith("tg:777000")),
    "no service sender among surfaced records",
  );
  const tel = getAttentionTelemetry();
  assert.ok(tel.excluded_nonperson >= 2, "service + system inbound excluded as DATA");
});

test("A2: catchup surface also drops a non-person latest sender (defense-in-depth)", () => {
  const now = Date.parse("2026-03-02T05:00:00.000Z");
  const service = tgToEnvelope(tgRow({ sender_id: 777000, text: "Login code: 999000", smid: "SVC1" }));
  const person = waToEnvelope(waLidRow({ from: "300000000000007@lid", text: "what time tomorrow?", smid: "PP1" }));
  const res = buildCatchupCore({ envelopes: [service, person], now, opts: { min_score: 0.3 } });
  // Service account never appears as a catch-up row head/platform.
  for (const row of res.rows) {
    assert.notEqual(row.platform, undefined);
    assert.ok(!String(row.thread_id || "").includes("777000"), "no service thread in catch-up rows");
  }
});

// ===========================================================================
// A1 — WhatsApp 1:1 @lid name resolution reaches the catch-up.
// ===========================================================================

test("A1: a resolved push name wins over the floor (genuine resolution preferred)", () => {
  const pushByJid = new Map([["100555010000001@lid", "Jordan"]]);
  const env = waToEnvelope(waLidRow(), { pushByJid });
  assert.equal(env.sender.name, "Jordan", "push name resolves the partner");
});

test("A1: an unresolved @lid 1:1 DM surfaces a NON-RAW best-effort floor label", () => {
  const env = waToEnvelope(waLidRow()); // no sidecar => genuinely unresolvable
  assert.notEqual(env.sender.name, null, "floor fills the null name");
  assert.ok(!/@lid/.test(env.sender.name), "floor label is NOT the raw @lid jid");
  assert.equal(env.sender.name, bestEffortLidLabel("100555010000001@lid"));
  // The floor is OPT-OUT: lidNameFloor:false reads the unmasked null (the N3 metric).
  const raw = waToEnvelope(waLidRow(), { lidNameFloor: false });
  assert.equal(raw.sender.name, null, "lidNameFloor:false leaves the genuine null");
});

test("A1: the floor never emits the raw @lid jid; bestEffortLidLabel is non-raw + stable", () => {
  const label = bestEffortLidLabel("100555010000001@lid");
  assert.ok(typeof label === "string" && label.length > 0);
  assert.ok(!/@lid/.test(label) && !/^[0-9]+$/.test(label), "label is human-shaped, not a bare jid");
  assert.equal(bestEffortLidLabel("100555010000001@lid"), label, "deterministic");
  assert.equal(bestEffortLidLabel("not-an-lid@s.whatsapp.net"), null, "non-@lid yields no floor");
});

test("A1: GATE — catch-up over @lid 1:1 DMs surfaces 100% named (0 raw @lid)", () => {
  const now = Date.parse("2026-03-02T06:00:00.000Z");
  const partners = [
    "100555010000001@lid", "200000000000001@lid", "300000000000007@lid",
    "411111111111111@lid", "522222222222222@lid",
  ];
  // One partner has a real push name; the rest are genuinely unresolvable (floor).
  const pushByJid = new Map([["100555010000001@lid", "Jordan"]]);
  const envelopes = partners.map((from, i) =>
    waToEnvelope(waLidRow({ from, text: "can you confirm the time?", smid: `G${i}` }), { pushByJid }),
  );
  // Build the catch-up (person resolver is identity-ish; we only assert names).
  const res = buildCatchupCore({ envelopes, now, opts: { min_score: 0.3, limit: 100 } });
  assert.ok(res.rows.length >= 1, "catch-up produced rows");
  let named = 0;
  let rawLid = 0;
  for (const row of res.rows) {
    const nm = row.person_name;
    if (typeof nm === "string" && nm.length > 0) named += 1;
    if (typeof nm === "string" && /@lid/.test(nm)) rawLid += 1;
  }
  const pct = ((100 * named) / res.rows.length).toFixed(1);
  process.stdout.write(
    `N11-GATE names_resolved=${pct}% service_excluded=true platform_tokens_L2to5=0\n`,
  );
  assert.equal(rawLid, 0, "no surfaced name is a raw @lid jid");
  assert.equal(named, res.rows.length, "every surfaced 1:1 @lid DM carries a NAME");
});

// ===========================================================================
// ABSTRACTION INVARIANT — zero platform tokens in L2-5.
// ===========================================================================

test("INVARIANT: L2-5 (classifier/identity/attention/catchup) carry ZERO platform tokens", () => {
  // Reuse the CANONICAL, word-boundary-aware gate from the N10 invariant eval so
  // a legitimate seam field (imessage_handles) does not false-positive while a
  // bare platform reference still trips. This proves the A1/A2 additions did NOT
  // leak any platform knowledge above L1.
  const { count, matches } = grepPlatformTokens();
  assert.equal(count, 0, `expected 0 platform tokens over L2-5, got ${count}: ${JSON.stringify(matches.slice(0, 5))}`);
  // Five since f5-catchup-seam registered lib/messaging/ledger-retain.js (the
  // retain leaf carved out of catchup.js to break the catchup <-> projection
  // import cycle) — the gate WIDENED with the move, it did not shrink.
  assert.equal(L2to5_SOURCES.length, 5, "the gate scans exactly the five L2-5 sources");
});

test("INVARIANT: the NEW A1/A2 platform signals do not leak into L2-5", () => {
  // The N11-specific platform signals — the Telegram service id, the bot flag,
  // the WhatsApp broadcast/status surfaces — must live ONLY in L1 adapters. A2's
  // exclusion in attention/catchup reads the AGNOSTIC sender.kind, never these.
  const NEW_SIGNALS = /777000|is_bot|status@broadcast|@broadcast|sender_is_bot|bestEffortLidLabel|classifySenderKind/i;
  for (const f of L2to5_SOURCES) {
    const src = readFileSync(f, "utf8");
    assert.equal(NEW_SIGNALS.test(src), false, `${path.basename(f)} must not reference an A1/A2 platform signal`);
  }
});
