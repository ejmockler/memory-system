// attribution-e2e.test.mjs — Node A3 (msg-attribution hypergraph).
//
// END-TO-END hermetic proof that the attribution shape A1 stamps on the
// WRITE side survives promotion and that A2's READ-side projection surfaces
// it. Drives synthetic telegram (INCOMING) + imessage (OUTGOING) source rows
// through the REAL cascade promote chokepoint
//
//   promoteSourceRow (distill-promote-fact.js)
//     → normalizeSourceEvent (salience.js: content derivation)
//     → extractAttributionFromSourceRow (salience.js: bounded subset)
//     → appendFactRow (distill-promote-fact.js: stamps top-level parties[]
//        + features.attribution onto the on-disk fact row)
//
// then reads the just-appended hermetic ledger row back and asserts:
//   (i)   non-empty top-level `parties[]` == the source row's parties verbatim
//   (ii)  `features.attribution` keys ⊆ the closed 9-key allowlist (no raw
//         message body duplicated; top-level `raw_content` NOT re-attached)
//   (iii) normalized direction matches the source row's is_outgoing/is_self
//         (telegram) / is_from_me (imessage)
//   (iv)  A2's __resolveProvenanceAttribution(fact) surfaces
//         { parties non-empty, direction non-null, authored_by } with the
//         correct direction (telegram→incoming/sender, imessage→outgoing/user)
//   (v)   a legacy no-attribution fact degrades to
//         { parties:[], direction:null, authored_by:null }
//
// Bound names (from A1's + A2's LANDED diffs, verbatim — see the node's
// Evidence): top-level parties key = `parties`; attribution subset =
// `features.attribution`; closed allowlist = [sender_id, sender_name, peer_id,
// peer_name, peer_type, is_outgoing, is_self, reply_to, fwd_from]; direction
// inputs = is_outgoing / is_self (imessage is_from_me→is_outgoing normalized in
// extractAttributionFromSourceRow); A2 resolver =
// __resolveProvenanceAttribution(factRow) → { parties, direction, authored_by,
// chat_type, reply_to, fwd_from }.
//
// Run:
//   node --test test/attribution-e2e.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTRIBUTION_KEYS as ALLOWLIST } from "../lib/ingest/_attribution-keys.js";
import { streamLedgerLines } from "../lib/synthesis/_ledger-stream.js";

// -----------------------------------------------------------------------------
// Hermetic env. MUST be set BEFORE any dynamic import touches config.js.
// (Copied verbatim from test/synthesis/cascade-row-parties-as-entities.test.mjs
// lines 44-63 — isolates every write from the live install.)
// -----------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-attr-e2e-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.POLICY_BASE_DIR = join(TMP_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TMP_ROOT, "ledgers");
process.env.HOOKS_BASE_DIR = join(TMP_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(TMP_ROOT, "daemons");

for (const d of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  process.env.HOOKS_BASE_DIR,
  process.env.DAEMONS_BASE_DIR,
  join(process.env.STORAGE_BASE_DIR, "sources"),
  join(process.env.LEDGERS_BASE_DIR),
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

// Dynamic imports AFTER the hermetic env is set. Namespace imports (not
// destructured) so the no-orphan-test-imports scanner skips them.
const promote = await import("../lib/tools/distill-promote-fact.js");
const recall = await import("../lib/tools/recall.js");

const LEDGER_PATH = join(process.env.LEDGERS_BASE_DIR, "memory.jsonl");

// fakePromote — network-free degraded-embed PROMOTE decision. embedding_mrl_768
// null keeps promoteSourceRow off the local-embed server (embedOutput.ok=false,
// indexing skipped). Copied from cascade-row-parties-as-entities.test.mjs:79-98.
function fakePromote(extra = {}) {
  return {
    decision: "PROMOTE",
    score: 0.42,
    components: {
      recency: 0.5,
      authorship: 1.0,
      content_mass: 0.5,
      source_prior: 0.6,
      structural: 0.5,
      novelty: 1.0,
      last_retrieved_ts: 0,
      use_count: 0,
    },
    weights_hash: "test-weights-hash",
    version: "v1",
    embedding_mrl_768: null,
    ...extra,
  };
}

// Read the just-appended hermetic ledger row by id.
function factById(id) {
  let found = null;
  streamLedgerLines(LEDGER_PATH, (row) => {
    if (found === null && row && row.id === id) found = row;
  });
  return found;
}

// -----------------------------------------------------------------------------
// Synthetic source rows — mirror the REAL storage/sources/<src>.jsonl shapes.
// -----------------------------------------------------------------------------

// Telegram INCOMING (is_outgoing=false, is_self=false): a counterparty sent it.
const TELEGRAM_ROW = {
  source: "telegram",
  source_msg_id: "tg_e2e_incoming_1",
  ts: "2026-07-05T10:00:00Z",
  content: "ship the attribution fix by friday",
  parties: ["Alex Example", "Example Team"],
  source_policy: { consent_basis: "first_party" },
  raw_content: {
    text: "ship the attribution fix by friday",
    sender_id: "771234",
    sender_name: "Alex Example",
    peer_id: "-1001",
    peer_name: "Example Team",
    peer_type: "group",
    is_outgoing: false,
    is_self: false,
    reply_to: "tg_parent_9000",
    fwd_from: "Original Sender",
    message_id: 9001,
  },
};

// iMessage OUTGOING (is_from_me=1): the operator ("user") authored it.
const IMESSAGE_ROW = {
  source: "imessage",
  source_msg_id: "imsg_e2e_outgoing_1",
  ts: "2026-07-05T11:00:00Z",
  parties: ["user", "+14155550123"],
  source_policy: { consent_basis: "first_party" },
  raw_content: {
    text: "on it, pushing now",
    is_from_me: 1,
    handle_id: "+14155550123",
    chat_guid: "iMessage;-;+14155550123",
    chat_display_name: "",
    service: "iMessage",
  },
};

// -----------------------------------------------------------------------------
// T1 — Telegram INCOMING: write-side attribution on the promoted fact.
// -----------------------------------------------------------------------------
test("T1: telegram incoming — promoted fact carries parties + bounded attribution + incoming direction", async () => {
  const r = await promote.promoteSourceRow({
    event: TELEGRAM_ROW,
    source: "telegram",
    salience: fakePromote(),
  });
  assert.equal(r.ok, true, "promoteSourceRow returns ok:true");
  assert.equal(
    typeof r.memory_event_id,
    "string",
    "promoteSourceRow returns a string memory_event_id",
  );

  const fact = factById(r.memory_event_id);
  assert.ok(fact, "fact row located in hermetic ledger by memory_event_id");

  // (i) non-empty top-level parties[] == the source row's parties verbatim.
  assert.ok(
    Array.isArray(fact.parties) && fact.parties.length > 0,
    `fact.parties is a non-empty array, got ${JSON.stringify(fact.parties)}`,
  );
  assert.deepEqual(
    fact.parties,
    ["Alex Example", "Example Team"],
    "fact.parties deep-equals the telegram source row's parties",
  );

  // (ii) features.attribution is a plain object whose keys ⊆ the closed
  // allowlist — the "bounded, no raw-body duplication" invariant.
  const attr = fact.features && fact.features.attribution;
  assert.ok(
    attr && typeof attr === "object" && !Array.isArray(attr),
    "features.attribution is a plain object",
  );
  for (const k of Object.keys(attr)) {
    assert.ok(
      ALLOWLIST.includes(k),
      `attribution key '${k}' is within the closed 9-key allowlist`,
    );
  }
  // Verbatim connector identity forwarded for a telegram row.
  assert.equal(attr.sender_name, "Alex Example", "attribution.sender_name");
  assert.equal(attr.sender_id, "771234", "attribution.sender_id");
  assert.equal(attr.peer_name, "Example Team", "attribution.peer_name");
  assert.equal(attr.peer_type, "group", "attribution.peer_type");

  // No raw message body / full raw_content re-attached to the fact.
  assert.ok(
    fact.raw_content == null,
    "top-level raw_content is NOT re-attached (stays null/absent)",
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(attr, "text"),
    "attribution does not carry the message body ('text')",
  );

  // (iii) normalized direction reflects INCOMING (is_outgoing=false, is_self=false).
  assert.equal(attr.is_outgoing, false, "attribution.is_outgoing === false (incoming)");
  assert.equal(attr.is_self, false, "attribution.is_self === false");
});

// -----------------------------------------------------------------------------
// T2 — iMessage OUTGOING: write-side attribution on the promoted fact.
// -----------------------------------------------------------------------------
test("T2: imessage outgoing — promoted fact carries parties + bounded attribution + outgoing direction", async () => {
  const r = await promote.promoteSourceRow({
    event: IMESSAGE_ROW,
    source: "imessage",
    salience: fakePromote(),
  });
  assert.equal(r.ok, true, "promoteSourceRow returns ok:true");
  assert.equal(typeof r.memory_event_id, "string", "memory_event_id is a string");

  const fact = factById(r.memory_event_id);
  assert.ok(fact, "fact row located in hermetic ledger by memory_event_id");

  // (i) non-empty top-level parties[] == the source row's parties verbatim.
  assert.deepEqual(
    fact.parties,
    ["user", "+14155550123"],
    "fact.parties deep-equals the imessage source row's parties",
  );

  // (ii) features.attribution keys ⊆ closed allowlist.
  const attr = fact.features && fact.features.attribution;
  assert.ok(
    attr && typeof attr === "object" && !Array.isArray(attr),
    "features.attribution is a plain object",
  );
  for (const k of Object.keys(attr)) {
    assert.ok(
      ALLOWLIST.includes(k),
      `attribution key '${k}' is within the closed 9-key allowlist`,
    );
  }
  // imessage handle_id becomes sender_id; no sender_name/peer_* for imessage.
  assert.equal(attr.sender_id, "+14155550123", "attribution.sender_id ← handle_id");

  // No raw body re-attached.
  assert.ok(fact.raw_content == null, "top-level raw_content is NOT re-attached");
  assert.ok(
    !Object.prototype.hasOwnProperty.call(attr, "text"),
    "attribution does not carry the message body ('text')",
  );

  // (iii) direction reflects OUTGOING (is_from_me:1 → is_outgoing normalized true).
  assert.equal(
    attr.is_outgoing,
    true,
    "attribution.is_outgoing === true (imessage is_from_me:1 normalized)",
  );
  assert.equal(attr.is_self, false, "attribution.is_self === false");
});

// -----------------------------------------------------------------------------
// T3 — READ-side A2 projection over BOTH facts + the legacy degrade path.
// -----------------------------------------------------------------------------
test("T3: read-side __resolveProvenanceAttribution surfaces sender + direction; legacy degrades", async () => {
  // Re-promote both rows so this test is independent of T1/T2 ordering, then
  // read them back and project via A2's source-agnostic resolver.
  const tg = await promote.promoteSourceRow({
    event: TELEGRAM_ROW,
    source: "telegram",
    salience: fakePromote(),
  });
  const im = await promote.promoteSourceRow({
    event: IMESSAGE_ROW,
    source: "imessage",
    salience: fakePromote(),
  });
  const tgFact = factById(tg.memory_event_id);
  const imFact = factById(im.memory_event_id);
  assert.ok(tgFact && imFact, "both facts located in hermetic ledger");

  // Telegram INCOMING → direction "incoming", authored_by = sender_name.
  const tgA = recall.__resolveProvenanceAttribution(tgFact);
  assert.ok(
    Array.isArray(tgA.parties) && tgA.parties.length > 0,
    `telegram projection parties non-empty, got ${JSON.stringify(tgA.parties)}`,
  );
  assert.notEqual(tgA.direction, null, "telegram projection direction is non-null");
  assert.equal(tgA.direction, "incoming", "telegram projection direction === incoming");
  assert.equal(
    tgA.authored_by,
    "Alex Example",
    "telegram authored_by === sender_name (sender-name-first rule)",
  );
  // A4 — telegram peer_type "group" → normalized chat_type "group".
  assert.equal(tgA.chat_type, "group", "telegram projection chat_type === group");
  assert.equal(tgA.reply_to, "tg_parent_9000", "telegram projection reply_to surfaces");
  assert.equal(tgA.fwd_from, "Original Sender", "telegram projection fwd_from surfaces");

  // iMessage OUTGOING → direction "outgoing", authored_by "user".
  const imA = recall.__resolveProvenanceAttribution(imFact);
  assert.ok(
    Array.isArray(imA.parties) && imA.parties.length > 0,
    `imessage projection parties non-empty, got ${JSON.stringify(imA.parties)}`,
  );
  assert.notEqual(imA.direction, null, "imessage projection direction is non-null");
  assert.equal(imA.direction, "outgoing", "imessage projection direction === outgoing");
  assert.equal(imA.authored_by, "user", "imessage authored_by === 'user' (operator)");
  // A4 — IMESSAGE_ROW has no participant_count/cache_roomnames → dm.
  assert.equal(imA.chat_type, "dm", "imessage (1:1) projection chat_type === dm");

  // Negative/degrade — a legacy fact with NO top-level parties + NO attribution
  // + raw_content:null must degrade byte-compatibly (pins A1/A2 do not break the
  // pre-fix corpus). A4 extends the degrade shape with chat_type:null.
  const legacy = {
    id: "mem_legacy",
    kind: "fact",
    source: "telegram",
    source_refs: [{ source: "telegram", source_msg_id: "x" }],
    raw_content: null,
  };
  const degraded = recall.__resolveProvenanceAttribution(legacy);
  assert.deepEqual(
    degraded,
    { parties: [], direction: null, authored_by: null, chat_type: null, reply_to: null, fwd_from: null },
    "legacy no-attribution fact degrades to {parties:[],direction:null,authored_by:null,chat_type:null,reply_to:null,fwd_from:null}",
  );
});

// -----------------------------------------------------------------------------
// A4 fixtures — group/DM differentiation across whatsapp / imessage / mail.
// Each mirrors the REAL storage/sources/<src>.jsonl raw_content shape the
// connectors author (whatsapp session_jid/session_type; imessage
// participant_count/cache_roomnames/chat_guid; mail headers.from).
// -----------------------------------------------------------------------------

// WhatsApp GROUP (incoming, session_jid @g.us, session_type=1).
const WHATSAPP_GROUP_ROW = {
  source: "whatsapp",
  source_msg_id: "wa_e2e_group_1",
  ts: "2026-07-05T12:00:00Z",
  parties: ["Alice Groupmember", "user"],
  source_policy: { consent_basis: "third_party_inferred" },
  raw_content: {
    text: "who is bringing the projector?",
    is_from_me: 0,
    sender_jid: "15551230000@s.whatsapp.net",
    sender_name: "Alice Groupmember",
    session_jid: "120363000000000000@g.us",
    session_type: 1,
    to_jid: "120363000000000000@g.us",
    group_event_type: 0,
  },
};

// WhatsApp DM (incoming, session_jid @s.whatsapp.net, session_type=0).
const WHATSAPP_DM_ROW = {
  source: "whatsapp",
  source_msg_id: "wa_e2e_dm_1",
  ts: "2026-07-05T12:05:00Z",
  parties: ["Bob Direct", "user"],
  source_policy: { consent_basis: "second_party_dm" },
  raw_content: {
    text: "call me when you land",
    is_from_me: 0,
    sender_jid: "15559990000@s.whatsapp.net",
    sender_name: "Bob Direct",
    session_jid: "15559990000@s.whatsapp.net",
    session_type: 0,
    to_jid: "15559990000@s.whatsapp.net",
    group_event_type: 0,
  },
};

// iMessage GROUP (incoming, participant_count 5 + cache_roomnames set).
const IMESSAGE_GROUP_ROW = {
  source: "imessage",
  source_msg_id: "imsg_e2e_group_1",
  ts: "2026-07-05T12:10:00Z",
  parties: ["+14155550999", "user"],
  source_policy: { consent_basis: "third_party_inferred" },
  raw_content: {
    text: "dinner at 7 works for me",
    is_from_me: 0,
    handle_id: "+14155550999",
    chat_guid: "iMessage;+;chat10000000000000001",
    cache_roomnames: "Weekend Crew",
    participant_count: 5,
    service: "iMessage",
  },
};

// iMessage DM (incoming, participant_count 2, no cache_roomnames).
const IMESSAGE_DM_ROW = {
  source: "imessage",
  source_msg_id: "imsg_e2e_dm_1",
  ts: "2026-07-05T12:15:00Z",
  parties: ["+14155550123", "user"],
  source_policy: { consent_basis: "second_party_dm" },
  raw_content: {
    text: "see you there",
    is_from_me: 0,
    handle_id: "+14155550123",
    chat_guid: "iMessage;-;+14155550123",
    cache_roomnames: null,
    participant_count: 2,
    service: "iMessage",
  },
};

// Mail (no chat concept → no peer_type → chat_type null). From header parsed
// into sender_name + sender_id; no direction flag → incoming.
const MAIL_ROW = {
  source: "mail",
  source_msg_id: "mail_e2e_1",
  ts: "2026-07-05T12:20:00Z",
  parties: ["notifications@example.com"],
  source_policy: { consent_basis: "second_party_dm" },
  raw_content: {
    headers: { from: "Sam Sample <notifications@example.com>" },
    subject: "Re: attribution rollout",
    body: "landing the read-side change now.",
  },
};

// Telegram DM (1:1). Telethon's classify_peer returns peer_type "user" for a
// 1:1 DM (connectors/telegram/telegram_tail.py classify_peer → ("user",...)),
// NOT "dm". The connector forwards that native vocabulary VERBATIM, so the
// promoted fact stores features.attribution.peer_type "user" and the READ-side
// resolver is what normalizes it to chat_type "dm". This is the PRIMARY gap the
// A4 change originally shipped: recall.js had no "user" case, so a telegram DM
// resolved to chat_type null — indistinguishable from mail/legacy.
const TELEGRAM_DM_ROW = {
  source: "telegram",
  source_msg_id: "tg_e2e_dm_1",
  ts: "2026-07-05T12:25:00Z",
  parties: ["Jordan Example", "user"],
  source_policy: { consent_basis: "second_party_dm" },
  raw_content: {
    text: "lunch tomorrow?",
    sender_id: "551234",
    sender_name: "Jordan Example",
    peer_id: "551234",
    peer_name: "Jordan Example",
    peer_type: "user",
    is_outgoing: false,
    is_self: false,
    reply_to: null,
    fwd_from: null,
    message_id: 9200,
  },
};

// iMessage LEGACY GROUP: cache_roomnames NULLed + participant_count missing,
// but the chat_guid carries Apple's `chat<digits>` group suffix (isGroupChat
// rule-3 at connectors/imessage.js:484). This is the SECONDARY gap: without the
// chat_guid fallback in salience.js such a legacy group row misclassifies as dm.
const IMESSAGE_LEGACY_GROUP_ROW = {
  source: "imessage",
  source_msg_id: "imsg_e2e_legacy_group_1",
  ts: "2026-07-05T12:35:00Z",
  parties: ["+14155550777", "user"],
  source_policy: { consent_basis: "third_party_inferred" },
  raw_content: {
    text: "moving this to saturday",
    is_from_me: 0,
    handle_id: "+14155550777",
    chat_guid: "iMessage;+;chat123456789012345",
    cache_roomnames: null,
    // participant_count intentionally omitted (legacy chat.db row).
    service: "iMessage",
  },
};

// -----------------------------------------------------------------------------
// T4 — WhatsApp group + DM: write-side peer_type + read-side chat_type.
// -----------------------------------------------------------------------------
test("T4: whatsapp group/dm — peer_type stamped + resolver chat_type", async () => {
  const g = await promote.promoteSourceRow({
    event: WHATSAPP_GROUP_ROW,
    source: "whatsapp",
    salience: fakePromote(),
  });
  const d = await promote.promoteSourceRow({
    event: WHATSAPP_DM_ROW,
    source: "whatsapp",
    salience: fakePromote(),
  });
  const gFact = factById(g.memory_event_id);
  const dFact = factById(d.memory_event_id);
  assert.ok(gFact && dFact, "both whatsapp facts located in hermetic ledger");

  // Write-side: features.attribution.peer_type normalized to group/dm.
  assert.equal(
    gFact.features.attribution.peer_type,
    "group",
    "whatsapp @g.us row → attribution.peer_type === group",
  );
  assert.equal(
    dFact.features.attribution.peer_type,
    "dm",
    "whatsapp @s.whatsapp.net row → attribution.peer_type === dm",
  );
  // peer_id forwarded from session_jid; attribution keys stay in the allowlist.
  assert.equal(gFact.features.attribution.peer_id, "120363000000000000@g.us");
  for (const k of Object.keys(gFact.features.attribution)) {
    assert.ok(ALLOWLIST.includes(k), `whatsapp attr key '${k}' in allowlist`);
  }

  // Read-side: resolver normalizes chat_type.
  const gA = recall.__resolveProvenanceAttribution(gFact);
  const dA = recall.__resolveProvenanceAttribution(dFact);
  assert.equal(gA.chat_type, "group", "whatsapp group resolver chat_type === group");
  assert.equal(gA.direction, "incoming", "whatsapp group incoming");
  assert.equal(gA.authored_by, "Alice Groupmember", "whatsapp group authored_by === sender_name");
  assert.equal(gA.reply_to, null, "whatsapp group reply_to absent → null");
  assert.equal(gA.fwd_from, null, "whatsapp group fwd_from absent → null");
  assert.equal(dA.chat_type, "dm", "whatsapp dm resolver chat_type === dm");
  assert.equal(dA.direction, "incoming", "whatsapp dm incoming");
});

// -----------------------------------------------------------------------------
// T5 — iMessage group + DM: write-side peer_type + read-side chat_type.
// -----------------------------------------------------------------------------
test("T5: imessage group/dm — peer_type stamped + resolver chat_type", async () => {
  const g = await promote.promoteSourceRow({
    event: IMESSAGE_GROUP_ROW,
    source: "imessage",
    salience: fakePromote(),
  });
  const d = await promote.promoteSourceRow({
    event: IMESSAGE_DM_ROW,
    source: "imessage",
    salience: fakePromote(),
  });
  const gFact = factById(g.memory_event_id);
  const dFact = factById(d.memory_event_id);
  assert.ok(gFact && dFact, "both imessage facts located in hermetic ledger");

  // Write-side: participant_count>2 / cache_roomnames → group; 1:1 → dm.
  assert.equal(
    gFact.features.attribution.peer_type,
    "group",
    "imessage participant_count=5 + cache_roomnames → peer_type group",
  );
  assert.equal(
    gFact.features.attribution.peer_name,
    "Weekend Crew",
    "imessage group peer_name ← cache_roomnames",
  );
  assert.equal(
    gFact.features.attribution.peer_id,
    "iMessage;+;chat10000000000000001",
    "imessage group peer_id ← chat_guid",
  );
  assert.equal(
    dFact.features.attribution.peer_type,
    "dm",
    "imessage participant_count=2, no roomnames → peer_type dm",
  );
  for (const k of Object.keys(gFact.features.attribution)) {
    assert.ok(ALLOWLIST.includes(k), `imessage attr key '${k}' in allowlist`);
  }
  // No raw body leaked.
  assert.ok(gFact.raw_content == null, "imessage group: raw_content NOT re-attached");
  assert.ok(
    !Object.prototype.hasOwnProperty.call(gFact.features.attribution, "text"),
    "imessage group attribution carries no message body",
  );

  // Read-side chat_type.
  const gA = recall.__resolveProvenanceAttribution(gFact);
  const dA = recall.__resolveProvenanceAttribution(dFact);
  assert.equal(gA.chat_type, "group", "imessage group resolver chat_type === group");
  assert.equal(dA.chat_type, "dm", "imessage dm resolver chat_type === dm");
});

// -----------------------------------------------------------------------------
// T6 — Mail: no chat concept → no peer_type → chat_type null (incoming).
// -----------------------------------------------------------------------------
test("T6: mail — no peer_type; resolver chat_type null, direction incoming", async () => {
  const m = await promote.promoteSourceRow({
    event: MAIL_ROW,
    source: "mail",
    salience: fakePromote(),
  });
  const mFact = factById(m.memory_event_id);
  assert.ok(mFact, "mail fact located in hermetic ledger");

  const attr = mFact.features && mFact.features.attribution;
  assert.ok(attr && typeof attr === "object", "mail features.attribution present");
  assert.ok(
    !Object.prototype.hasOwnProperty.call(attr, "peer_type"),
    "mail attribution carries NO peer_type (no chat concept)",
  );
  assert.equal(attr.sender_name, "Sam Sample", "mail sender_name ← From display name");
  assert.equal(attr.sender_id, "notifications@example.com", "mail sender_id ← From addr-spec");

  const mA = recall.__resolveProvenanceAttribution(mFact);
  assert.equal(mA.chat_type, null, "mail resolver chat_type === null (no peer_type)");
  assert.equal(mA.direction, "incoming", "mail resolver direction === incoming (no direction flag)");
  assert.equal(mA.authored_by, "Sam Sample", "mail authored_by === sender_name");
  assert.equal(mA.reply_to, null, "mail reply_to absent → null");
  assert.equal(mA.fwd_from, null, "mail fwd_from absent → null");
});

// -----------------------------------------------------------------------------
// T7 — DECOUPLED read: valid features.attribution + EMPTY top-level parties[]
// still surfaces direction / authored_by / chat_type (parties stays []).
// Proves the A4 gate change: the attribution read is no longer conditioned on
// non-empty parties[].
// -----------------------------------------------------------------------------
test("T7: empty parties[] + valid attribution → direction/authored_by/chat_type still surface", async () => {
  // (a) Pure resolver assertion — hand-built fact with parties:[] but a valid
  // closed-key attribution subset (a whatsapp group message).
  const factNoParties = {
    id: "mem_no_parties",
    kind: "fact",
    source: "whatsapp",
    parties: [],
    features: {
      attribution: {
        sender_id: "15551230000@s.whatsapp.net",
        sender_name: "Carol Grouponly",
        peer_id: "120363111111111111@g.us",
        peer_type: "group",
        is_outgoing: false,
        is_self: false,
      },
    },
  };
  const a = recall.__resolveProvenanceAttribution(factNoParties);
  assert.deepEqual(a.parties, [], "parties stays [] (nothing to resolve)");
  assert.equal(a.direction, "incoming", "direction surfaces despite empty parties[]");
  assert.equal(a.authored_by, "Carol Grouponly", "authored_by surfaces despite empty parties[]");
  assert.equal(a.chat_type, "group", "chat_type surfaces despite empty parties[]");

  // (b) End-to-end — promote a telegram supergroup row with parties OMITTED so
  // the on-disk fact carries features.attribution but NO top-level parties[].
  const tgSupergroupNoParties = {
    source: "telegram",
    source_msg_id: "tg_e2e_supergroup_noparties_1",
    ts: "2026-07-05T12:30:00Z",
    // parties intentionally omitted → appendFactRow stamps no top-level parties.
    source_policy: { consent_basis: "first_party" },
    raw_content: {
      text: "supergroup announcement",
      sender_id: "88123",
      sender_name: "Dana Announcer",
      peer_id: "-1002000000000",
      peer_name: "Example Team supergroup",
      peer_type: "supergroup",
      is_outgoing: false,
      is_self: false,
      message_id: 9100,
    },
  };
  const r = await promote.promoteSourceRow({
    event: tgSupergroupNoParties,
    source: "telegram",
    salience: fakePromote(),
  });
  const fact = factById(r.memory_event_id);
  assert.ok(fact, "supergroup-no-parties fact located");
  // Top-level parties absent/empty; attribution present.
  assert.ok(
    !Array.isArray(fact.parties) || fact.parties.length === 0,
    `on-disk fact has empty/absent top-level parties, got ${JSON.stringify(fact.parties)}`,
  );
  assert.equal(
    fact.features.attribution.peer_type,
    "supergroup",
    "telegram native peer_type preserved verbatim write-side",
  );
  const e2e = recall.__resolveProvenanceAttribution(fact);
  assert.deepEqual(e2e.parties, [], "e2e: parties [] (none stamped)");
  assert.equal(e2e.direction, "incoming", "e2e: direction surfaces from attribution");
  assert.equal(e2e.authored_by, "Dana Announcer", "e2e: authored_by surfaces from attribution");
  assert.equal(e2e.chat_type, "group", "e2e: telegram supergroup normalizes to chat_type group");
});

// -----------------------------------------------------------------------------
// T8 — Telegram DM (PRIMARY gap): native peer_type "user" is stored VERBATIM
// write-side and the resolver normalizes it to chat_type "dm". Before the fix
// recall.js had no "user" case, so this resolved to chat_type null.
// -----------------------------------------------------------------------------
test("T8: telegram DM (peer_type=user) — write-side peer_type 'user' + resolver chat_type 'dm'", async () => {
  const d = await promote.promoteSourceRow({
    event: TELEGRAM_DM_ROW,
    source: "telegram",
    salience: fakePromote(),
  });
  const dFact = factById(d.memory_event_id);
  assert.ok(dFact, "telegram DM fact located in hermetic ledger");

  // Write-side: telegram's native peer_type "user" forwarded VERBATIM (the
  // connector never rewrites it to "dm"; normalization is the read side's job).
  assert.equal(
    dFact.features.attribution.peer_type,
    "user",
    "telegram DM stores native peer_type 'user' verbatim (not normalized write-side)",
  );
  for (const k of Object.keys(dFact.features.attribution)) {
    assert.ok(ALLOWLIST.includes(k), `telegram DM attr key '${k}' in allowlist`);
  }

  // Read-side: resolver normalizes peer_type "user" → chat_type "dm".
  const dA = recall.__resolveProvenanceAttribution(dFact);
  assert.equal(dA.chat_type, "dm", "telegram DM (peer_type=user) resolver chat_type === dm");
  assert.equal(dA.direction, "incoming", "telegram DM incoming");
  assert.equal(dA.authored_by, "Jordan Example", "telegram DM authored_by === sender_name");
});

// -----------------------------------------------------------------------------
// T9 — iMessage LEGACY GROUP (SECONDARY gap): chat_guid `;+;chat<digits>` suffix
// classifies as group even with cache_roomnames NULL + participant_count absent
// (isGroupChat rule-3). Before the fix salience.js omitted this fallback and the
// row misclassified as dm.
// -----------------------------------------------------------------------------
test("T9: imessage legacy group (chat_guid rule-3, no roomnames/participant_count) — chat_type group", async () => {
  const g = await promote.promoteSourceRow({
    event: IMESSAGE_LEGACY_GROUP_ROW,
    source: "imessage",
    salience: fakePromote(),
  });
  const gFact = factById(g.memory_event_id);
  assert.ok(gFact, "imessage legacy-group fact located in hermetic ledger");

  // Write-side: chat_guid `;+;chat<digits>` suffix → group (rule-3 fallback),
  // despite cache_roomnames NULL and participant_count omitted.
  assert.equal(
    gFact.features.attribution.peer_type,
    "group",
    "imessage legacy chat_guid `;+;chat...` → peer_type group (rule-3 fallback)",
  );
  // No cache_roomnames → no peer_name; peer_id still carries the chat_guid.
  assert.ok(
    !Object.prototype.hasOwnProperty.call(gFact.features.attribution, "peer_name"),
    "no cache_roomnames → attribution carries no peer_name",
  );
  assert.equal(
    gFact.features.attribution.peer_id,
    "iMessage;+;chat123456789012345",
    "imessage legacy group peer_id ← chat_guid",
  );

  // Read-side chat_type.
  const gA = recall.__resolveProvenanceAttribution(gFact);
  assert.equal(gA.chat_type, "group", "imessage legacy group resolver chat_type === group");
});

// -----------------------------------------------------------------------------
// T10 — g1-whatsapp-reply-linkage: WhatsApp quoted-reply `reply_to` survives
// extraction into features.attribution.
//
// The connector stamps raw_content.reply_to (the QUOTED-REPLY parent stanza id)
// on every row that has a ZPARENTMESSAGE, using the SAME canonical key telegram
// already emits. reply_to is already a member of the frozen 9-key allowlist, so
// this asserts pure reuse: the key crosses into attribution for whatsapp, the
// closed set does not grow, and a row WITHOUT a reply carries no key at all
// (absent, not present-and-null).
// -----------------------------------------------------------------------------
test("T10: whatsapp quoted reply — raw_content.reply_to → attribution.reply_to", async () => {
  const salience = await import("../lib/ingest/salience.js");

  const withReply = salience.extractAttributionFromSourceRow({
    source: "whatsapp",
    raw_content: {
      text: "replying to your message",
      sender_jid: "15551230000@s.whatsapp.net",
      sender_name: "Alice Groupmember",
      session_jid: "120363111111111111@g.us",
      session_type: 1,
      is_from_me: 0,
      // Emitted by the connector for a ZMESSAGETYPE=0 row carrying a parent.
      reply_to: "3BC373F79BC791AAB958",
      parent_stanza_id: "3BC373F79BC791AAB958",
    },
  });
  assert.equal(
    withReply.reply_to,
    "3BC373F79BC791AAB958",
    "whatsapp raw_content.reply_to → attribution.reply_to verbatim",
  );
  for (const k of Object.keys(withReply)) {
    assert.ok(ALLOWLIST.includes(k), `whatsapp attr key '${k}' in frozen allowlist`);
  }

  // No reply → key ABSENT, not present-and-null.
  const noReply = salience.extractAttributionFromSourceRow({
    source: "whatsapp",
    raw_content: {
      text: "a message that quotes nothing",
      sender_jid: "15551230000@s.whatsapp.net",
      sender_name: "Alice Groupmember",
      session_jid: "120363111111111111@g.us",
      session_type: 1,
      is_from_me: 0,
    },
  });
  assert.ok(
    !Object.prototype.hasOwnProperty.call(noReply, "reply_to"),
    `no-reply whatsapp row omits reply_to entirely, got ${JSON.stringify(noReply)}`,
  );

  // The parent_stanza_id forensic alias is NOT an attribution key — it stays in
  // raw_content and must never leak into the closed set.
  assert.ok(
    !Object.prototype.hasOwnProperty.call(withReply, "parent_stanza_id"),
    "source-native parent_stanza_id alias never enters features.attribution",
  );
});
