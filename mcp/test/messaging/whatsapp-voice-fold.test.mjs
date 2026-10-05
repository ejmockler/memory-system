// whatsapp-voice-fold.test.mjs — voice transcripts (STT) in the WhatsApp
// catch-up adapter: in-band "[voice] " prefix + pure in-memory fold of late
// kind:"voice_transcript" enrichment rows onto their parent voice rows.
// Pure in-memory fixtures: no fs, no ChatStorage, prepareContext never called.

import { test } from "node:test";
import assert from "node:assert/strict";

import whatsapp, {
  _toEnvelope,
  foldVoiceTranscripts,
  foldRows,
} from "../../lib/messaging/adapters/whatsapp.js";
import { validateEnvelope } from "../../lib/messaging/envelope.js";
import {
  ADAPTER_REGISTRY,
  buildAdapterRegistry,
  loadEnvelopesFromSources,
  loadEnvelopesFromSourcesSync,
} from "../../lib/messaging/catchup.js";

const DM_JID = "15551230000@s.whatsapp.net";
const GROUP_JID = "120363000000000000@g.us";
const STANZA = "3EB0VOICE0001";
const PARENT_TS = "2026-09-20T10:00:00.000Z";
const PARENT_TS_MS = Date.parse(PARENT_TS);

function parentRow(overrides = {}) {
  return {
    id: "row-parent-1",
    ts: PARENT_TS,
    source: "whatsapp",
    source_msg_id: STANZA,
    parties: [DM_JID],
    raw_content: {
      text: null,
      from_jid: DM_JID,
      to_jid: null,
      session_jid: DM_JID,
      is_from_me: 0,
      message_type: 3,
      session_type: 0,
      has_media: 1,
      media_local_path: "Media/voice.opus",
    },
    ...overrides,
  };
}

function enrichmentRow(text = "hello there", overrides = {}) {
  const p = parentRow();
  return {
    id: "row-enrich-1",
    ts: PARENT_TS,
    source: "whatsapp",
    source_msg_id: `${STANZA}#stt`,
    kind: "voice_transcript",
    derived_from: [STANZA],
    parties: [DM_JID],
    raw_content: {
      ...p.raw_content,
      text,
      text_origin: "stt",
      stt: { model: "whisper", lang: "en" },
    },
    ...overrides,
  };
}

function mapAll(rows) {
  return foldVoiceTranscripts(rows).map((r) => _toEnvelope(r, { lidNameFloor: true }));
}

test("exports: foldVoiceTranscripts/foldRows named + on default export", () => {
  assert.equal(typeof foldVoiceTranscripts, "function");
  assert.equal(foldRows, foldVoiceTranscripts);
  assert.equal(whatsapp.foldVoiceTranscripts, foldVoiceTranscripts);
  assert.equal(whatsapp.foldRows, foldVoiceTranscripts);
  assert.equal(typeof whatsapp._toEnvelope, "function");
  assert.equal(typeof whatsapp.prepareContext, "function");
});

test("(a) in-band stt row renders '[voice] <text>' and validates", () => {
  const row = parentRow();
  row.raw_content = { ...row.raw_content, text: "  on my way  ", text_origin: "stt" };
  const env = _toEnvelope(row);
  assert.equal(env.content, "[voice] on my way");
  assert.equal(env.source_msg_id, STANZA);
  const v = validateEnvelope(env);
  assert.equal(v.ok, true, JSON.stringify(v));
});

test("(b) parent + enrichment fold to exactly 1 envelope with parent id/ts", () => {
  const envs = mapAll([parentRow(), enrichmentRow("call me back")]);
  assert.equal(envs.length, 1);
  assert.equal(envs[0].source_msg_id, STANZA);
  assert.equal(envs[0].ts, PARENT_TS_MS);
  assert.equal(envs[0].content, "[voice] call me back");
});

test("(b') enrichment BEFORE parent in ledger order still folds to 1 envelope", () => {
  const envs = mapAll([enrichmentRow("x"), parentRow()]);
  assert.equal(envs.length, 1);
  assert.equal(envs[0].source_msg_id, STANZA);
  assert.equal(envs[0].content, "[voice] x");
});

test("last enrichment in ledger order wins", () => {
  const envs = mapAll([parentRow(), enrichmentRow("first"), enrichmentRow("second")]);
  assert.equal(envs.length, 1);
  assert.equal(envs[0].content, "[voice] second");
});

test("(c) enrichment with no parent yields 1 envelope keyed on the parent stanza", () => {
  const envs = mapAll([enrichmentRow("orphan")]);
  assert.equal(envs.length, 1);
  assert.equal(envs[0].source_msg_id, STANZA);
  assert.ok(!envs[0].source_msg_id.endsWith("#stt"));
  assert.equal(envs[0].content, "[voice] orphan");
  assert.equal(envs[0].ts, PARENT_TS_MS);
});

test("(d) two duplicate parents + one enrichment yield 1 envelope", () => {
  const envs = mapAll([parentRow(), parentRow({ id: "row-parent-dup" }), enrichmentRow("dup")]);
  assert.equal(envs.length, 1);
  assert.equal(envs[0].content, "[voice] dup");
});

test("duplicate parents WITHOUT enrichment stay untouched (today's behavior)", () => {
  const rows = [parentRow(), parentRow({ id: "row-parent-dup" })];
  const folded = foldVoiceTranscripts(rows);
  assert.equal(folded.length, 2);
  assert.equal(folded[0], rows[0]);
  assert.equal(folded[1], rows[1]);
});

test("(e) legacy media row (no text, no text_origin) maps deep-equal to pre-change output", () => {
  const row = parentRow();
  const env = _toEnvelope(row);
  // Pre-change _toEnvelope output for this row (content from rc.text only).
  assert.deepEqual(env, {
    platform: "whatsapp",
    thread_id: DM_JID,
    thread_type: "dm",
    sender: { id: DM_JID, name: null, kind: "person" },
    recipients: ["user"],
    is_from_me: false,
    ts: PARENT_TS_MS,
    content: null,
    mentions: [],
    directed_at_me_signals: { mention_me: false, reply_to_me: false, addressed_to_me: false },
    capabilities: {
      reply_to_available: false,
      structured_mentions: false,
      self_identity_reliable: false,
      addressing_first_class: false,
    },
    source_msg_id: STANZA,
  });
  assert.equal(env.content, null);
  // Folding a window without enrichments is the identity projection.
  const folded = foldVoiceTranscripts([row]);
  assert.deepEqual(_toEnvelope(folded[0]), env);
});

test("(f) group row with text and no text_origin keeps thread_type and content", () => {
  const row = {
    id: "row-group-1",
    ts: PARENT_TS,
    source: "whatsapp",
    source_msg_id: "3EB0GROUP0001",
    parties: [GROUP_JID],
    raw_content: {
      text: "[voice] literal text, not stt",
      from_jid: GROUP_JID,
      session_jid: GROUP_JID,
      is_from_me: 0,
      message_type: 0,
      session_type: 1,
    },
  };
  const before = _toEnvelope(row);
  const [after] = mapAll([row]);
  assert.equal(after.thread_type, "group");
  assert.equal(after.content, "[voice] literal text, not stt");
  assert.deepEqual(after, before);
});

test("(g) fold is pure: input array and rows deep-equal before/after; new array", () => {
  const rows = [
    parentRow(),
    parentRow({ id: "row-parent-dup" }),
    enrichmentRow("pure"),
    enrichmentRow("orphan", { derived_from: ["3EB0ORPHAN"], source_msg_id: "3EB0ORPHAN#stt" }),
  ];
  const snapshot = structuredClone(rows);
  const out = foldVoiceTranscripts(rows);
  assert.notEqual(out, rows);
  assert.deepEqual(rows, snapshot);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.source_msg_id), [STANZA, "3EB0ORPHAN"]);
  // Deterministic.
  assert.deepEqual(foldVoiceTranscripts(rows), out);
});

test("malformed input never throws", () => {
  assert.equal(foldVoiceTranscripts(null), null);
  assert.equal(foldVoiceTranscripts(undefined), undefined);
  const weird = [null, 7, "x", { kind: "voice_transcript", derived_from: [] }, enrichmentRow("ok")];
  assert.doesNotThrow(() => foldVoiceTranscripts(weird));
});

test("(h) unfolded enrichment row passed straight to _toEnvelope uses parent stanza", () => {
  const env = _toEnvelope(enrichmentRow("raw"));
  assert.equal(env.source_msg_id, STANZA);
  assert.equal(env.content, "[voice] raw");
});

test("no envelope ever carries a '#stt' source_msg_id", () => {
  const envs = mapAll([
    enrichmentRow("a"),
    parentRow(),
    enrichmentRow("b", { derived_from: ["3EB0OTHER"], source_msg_id: "3EB0OTHER#stt" }),
  ]);
  for (const e of envs) assert.ok(!e.source_msg_id.endsWith("#stt"), e.source_msg_id);
  assert.equal(envs.length, 2);
});

// ---------------------------------------------------------------------------
// V4 hardening: (a) "#stt" stem fallback, (b) session_jid match, (c) dm-only.
// ---------------------------------------------------------------------------

function groupParent(overrides = {}) {
  const p = parentRow();
  return {
    ...p,
    parties: [GROUP_JID],
    raw_content: { ...p.raw_content, session_jid: GROUP_JID, from_jid: GROUP_JID, session_type: 1 },
    ...overrides,
  };
}

function groupEnrichment(text = "group words") {
  const e = enrichmentRow(text);
  return {
    ...e,
    parties: [GROUP_JID],
    raw_content: { ...e.raw_content, session_jid: GROUP_JID, from_jid: GROUP_JID, session_type: 1 },
  };
}

test("V4(a) enrichment WITHOUT derived_from + 'S#stt' folds onto parent 'S'", () => {
  const enr = enrichmentRow("stem fold");
  delete enr.derived_from;
  const envs = mapAll([parentRow(), enr]);
  assert.equal(envs.length, 1);
  assert.equal(envs[0].source_msg_id, STANZA);
  assert.equal(envs[0].content, "[voice] stem fold");
});

test("V4(a) unfolded enrichment with invalid derived_from maps to the stem, never '#stt'", () => {
  for (const df of [undefined, [], [""], [7], "nope"]) {
    const enr = enrichmentRow("raw stem", { derived_from: df });
    const env = _toEnvelope(enr);
    assert.equal(env.source_msg_id, STANZA);
    assert.ok(!env.source_msg_id.endsWith("#stt"));
    const [solo] = mapAll([enr]);
    assert.equal(solo.source_msg_id, STANZA);
  }
  // A bare "#stt" (empty stem) is NOT an enrichment: it maps as its own row.
  const bare = enrichmentRow("x", { derived_from: undefined, source_msg_id: "#stt" });
  assert.equal(foldVoiceTranscripts([bare])[0], bare);
});

test("V4(b) enrichment with a mismatched session_jid is dropped; parent unchanged", () => {
  const parent = parentRow();
  const enr = enrichmentRow("wrong chat");
  enr.raw_content = { ...enr.raw_content, session_jid: "19998887777@s.whatsapp.net" };
  const before = _toEnvelope(parent);
  const folded = foldVoiceTranscripts([parent, enr]);
  assert.equal(folded.length, 1);
  assert.equal(folded[0], parent);
  const envs = mapAll([enr, parent]);
  assert.equal(envs.length, 1);
  assert.deepEqual(envs[0], before);
  assert.equal(envs[0].content, null);
});

test("V4(b) missing session_jid on either side never folds", () => {
  const parent = parentRow();
  parent.raw_content = { ...parent.raw_content, session_jid: null };
  const enr = enrichmentRow("no session");
  enr.raw_content = { ...enr.raw_content, session_jid: null };
  const folded = foldVoiceTranscripts([parent, enr]);
  assert.equal(folded.length, 1);
  assert.equal(folded[0], parent);
});

test("V4(c) group enrichment + parent: one envelope, no '[voice]', content unchanged", () => {
  const parent = groupParent();
  const before = _toEnvelope(parent);
  const envs = mapAll([parent, groupEnrichment()]);
  assert.equal(envs.length, 1);
  assert.equal(envs[0].thread_type, "group");
  assert.deepEqual(envs[0], before);
  assert.ok(!String(envs[0].content).startsWith("[voice]"));
});

test("V4(c) group enrichment without a parent yields zero envelopes", () => {
  assert.equal(foldVoiceTranscripts([groupEnrichment()]).length, 0);
  assert.equal(mapAll([groupEnrichment()]).length, 0);
});

test("V4(c) channel enrichment is dropped too", () => {
  const e = enrichmentRow("status");
  e.raw_content = { ...e.raw_content, session_jid: "status@broadcast", session_type: 3 };
  assert.equal(foldVoiceTranscripts([e]).length, 0);
});

test("V4(c) in-band stt row in a group keeps plain text (no '[voice]')", () => {
  const row = groupParent();
  row.raw_content = { ...row.raw_content, text: "group stt", text_origin: "stt" };
  const env = _toEnvelope(row);
  assert.equal(env.thread_type, "group");
  assert.equal(env.content, "group stt");
});

test("V4(c) no group/channel envelope ever starts with '[voice]'", () => {
  const inband = groupParent({ source_msg_id: "3EB0INBAND" });
  inband.raw_content = { ...inband.raw_content, text: "t", text_origin: "stt" };
  const envs = mapAll([groupParent(), groupEnrichment(), inband, parentRow(), enrichmentRow("dm")]);
  for (const e of envs) {
    if (e.thread_type !== "dm") assert.ok(!String(e.content).startsWith("[voice]"), e.content);
  }
  assert.equal(envs.filter((e) => e.thread_type === "dm")[0].content, "[voice] dm");
});

// ---------------------------------------------------------------------------
// V4 catch-up wiring: the loaders apply foldRows by CAPABILITY.
// ---------------------------------------------------------------------------

// Context-free fixture registry over the REAL adapter mapper + fold (no
// prepareContext, so no ChatStorage side-load in tests).
function fixtureRegistry(fold = foldRows) {
  return buildAdapterRegistry([{ PLATFORM: "whatsapp", _toEnvelope, foldRows: fold }]);
}

test("V4 default registry carries the adapter's foldRows capability", () => {
  assert.equal(ADAPTER_REGISTRY.get("whatsapp").foldRows, foldRows);
  assert.equal(fixtureRegistry().get("whatsapp").foldRows, foldRows);
  assert.equal(buildAdapterRegistry([{ PLATFORM: "x", _toEnvelope }]).get("x").foldRows, null);
});

test("V4 loadEnvelopesFromSources: parent(no text) + '#stt' enrichment => 1 '[voice]' envelope", async () => {
  const rows = [parentRow(), enrichmentRow("catch-up words")];
  const snapshot = structuredClone(rows);
  const envs = await loadEnvelopesFromSources({ whatsapp: rows }, fixtureRegistry());
  assert.equal(envs.length, 1);
  assert.ok(envs[0].content.startsWith("[voice] "));
  assert.equal(envs[0].content, "[voice] catch-up words");
  assert.equal(envs[0].source_msg_id, STANZA);
  assert.deepEqual(rows, snapshot); // input never mutated
});

test("V4 loadEnvelopesFromSourcesSync sees the same folded population", () => {
  const envs = loadEnvelopesFromSourcesSync(
    { whatsapp: [parentRow(), enrichmentRow("sync words")] },
    fixtureRegistry(),
  );
  assert.equal(envs.length, 1);
  assert.equal(envs[0].content, "[voice] sync words");
  assert.equal(envs[0].source_msg_id, STANZA);
});

test("V4 a throwing / non-array foldRows falls back to the raw rows", async () => {
  const rows = [parentRow(), enrichmentRow("raw fallback")];
  const expected = rows.map((r) => _toEnvelope(r));
  for (const bad of [() => { throw new Error("boom"); }, () => null, () => "nope"]) {
    const reg = fixtureRegistry(bad);
    const a = await loadEnvelopesFromSources({ whatsapp: rows }, reg);
    const s = loadEnvelopesFromSourcesSync({ whatsapp: rows }, reg);
    assert.equal(a.length, 2);
    assert.deepEqual(a, s);
    assert.deepEqual(a.map((e) => e.source_msg_id), expected.map((e) => e.source_msg_id));
    for (const e of a) assert.ok(!e.source_msg_id.endsWith("#stt"));
  }
});
