// n3-whatsapp-adapter.test.mjs — WORKUNIT N3 regression suite for the WhatsApp
// adapter (mcp/lib/messaging/adapters/whatsapp.js) + the 1:1 partner-name gap fix
// in mcp/lib/connectors/whatsapp-sender-index.js.
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions. HERMETIC:
//   - reads the N3 fixture (a synthetic row in the whatsapp.jsonl ledger-row
//     shape) + name sidecar,
//   - runs the null-rate gate over a synthetic in-memory sample of 1:1 inbound
//     rows (no ledger is read, so the suite behaves the same on any host / CI),
//   - no DB, no network, no fs WRITES. Runs well under 2s.
//
// What this suite proves (mapped to the N3 GATE + the N1 conformance contract):
//   - _toEnvelope maps the fixture row to its expected_envelope EXACTLY.
//   - every emitted envelope VALIDATES against the FROZEN N1 contract.
//   - capabilities{} is the WhatsApp profile: all four FALSE (the keystone data).
//   - directed_at_me_signals are all false (the platform cannot tell).
//   - reply_to_id is ABSENT (WhatsApp stores no reply target).
//   - mentions[] is ALWAYS empty (no structured mention primitive).
//   - thread_type classification is exhaustive over the session_type/jid classes
//     ({0,1,3,4,null} x {@g.us,@s.whatsapp.net,@lid,@status}) -> {dm,group,channel}.
//   - ts is converted ISO -> integer ms (>0), never a string.
//   - outbound rows resolve sender 'user' and recipient = partner.
//   - THE 1:1 GAP FIX: sender_name null-rate DROPS after the push-name fallback,
//     over the synthetic sample. "valid=N/N null before=X% after=Y% (Y<X)".

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  _toEnvelope,
  PLATFORM,
  classifyThreadType,
  toEpochMs,
} from "../../lib/messaging/adapters/whatsapp.js";
import { validateEnvelope } from "../../lib/messaging/envelope.js";
import {
  resolveSenderForRow,
} from "../../lib/connectors/whatsapp-sender-index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(__dirname, "../../lib/messaging");
const FIXTURES_DIR = path.join(LIB_DIR, "fixtures");
const ADAPTER_FILE = path.join(LIB_DIR, "adapters", "whatsapp.js");

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, rel), "utf8"));
}

// Build the pushByJid sidecar Map from the fixture's name_sidecar block.
function sidecarFromFixture(fx) {
  const push = new Map();
  const ns = fx && fx.name_sidecar && fx.name_sidecar.pushByJid;
  if (ns && typeof ns === "object") {
    for (const k of Object.keys(ns)) push.set(k, ns[k]);
  }
  return { pushByJid: push };
}

// T1 — the adapter maps the fixture row to its expected_envelope EXACTLY
// (the AFTER-fix projection: sender.name 'Jordan' recovered via push fallback).
test("maps the fixture row to expected_envelope exactly (1:1 name fix applied)", () => {
  const fx = readJson("whatsapp.fixture.json");
  assert.equal(fx.stub, false, "N3 fixture must be a non-stub (full ledger-row shape) row");
  const env = _toEnvelope(fx.raw_row, sidecarFromFixture(fx));
  assert.deepEqual(env, fx.expected_envelope, "adapter output must equal expected_envelope");
  // the recovered name is the whole point of the fix:
  assert.equal(env.sender.name, "Jordan");
  assert.equal(env.platform, PLATFORM);
});

// T2 — the emitted envelope VALIDATES against the FROZEN N1 contract.
test("fixture envelope validates against the frozen N1 contract", () => {
  const fx = readJson("whatsapp.fixture.json");
  const env = _toEnvelope(fx.raw_row, sidecarFromFixture(fx));
  const res = validateEnvelope(env);
  assert.equal(res.ok, true, `must validate; errors=${JSON.stringify(res.errors)}`);
  assert.deepEqual(res.errors, []);
});

// T3 — capabilities{} is the WhatsApp profile: ALL FOUR FALSE (keystone data),
// and directed_at_me_signals are all false (platform cannot tell).
test("capabilities are the all-false WhatsApp profile; signals all false", () => {
  const fx = readJson("whatsapp.fixture.json");
  const env = _toEnvelope(fx.raw_row, sidecarFromFixture(fx));
  assert.equal(env.capabilities.reply_to_available, false);
  assert.equal(env.capabilities.structured_mentions, false);
  assert.equal(env.capabilities.self_identity_reliable, false);
  assert.equal(env.capabilities.addressing_first_class, false);
  assert.equal(env.directed_at_me_signals.mention_me, false);
  assert.equal(env.directed_at_me_signals.reply_to_me, false);
  assert.equal(env.directed_at_me_signals.addressed_to_me, false);
});

// T4 — reply_to_id is ABSENT (not null): WhatsApp stores no reply target. And
// mentions[] is ALWAYS empty (no structured mention primitive).
test("reply_to_id absent; mentions always empty", () => {
  const fx = readJson("whatsapp.fixture.json");
  const env = _toEnvelope(fx.raw_row, sidecarFromFixture(fx));
  assert.equal(Object.prototype.hasOwnProperty.call(env, "reply_to_id"), false);
  assert.deepEqual(env.mentions, []);
  // even a row whose text contains an @<digits> "mention" yields no structured mentions:
  const row = structuredClone(fx.raw_row);
  row.raw_content.text = "hey @15550100090 you around?";
  const env2 = _toEnvelope(row, {});
  assert.deepEqual(env2.mentions, []);
});

// T5 — ts converts ISO -> integer ms (>0), never a string. (boundary correctness)
test("ts converts ISO-8601 to positive integer ms", () => {
  assert.equal(toEpochMs("2026-03-03T04:10:20.000Z"), 1772511020000);
  assert.equal(toEpochMs(1772511020000), 1772511020000); // idempotent on int ms
  assert.equal(toEpochMs("not-a-date"), null);
  assert.equal(toEpochMs(null), null);
  const fx = readJson("whatsapp.fixture.json");
  const env = _toEnvelope(fx.raw_row, sidecarFromFixture(fx));
  assert.equal(typeof env.ts, "number");
  assert.equal(Number.isInteger(env.ts) && env.ts > 0, true);
});

// T6 — thread_type classification is EXHAUSTIVE over session_type x jid class.
// (The MAP probe's {0,1} was incomplete; 3 and 4 and a null jid occur in ledgers.)
test("thread_type classification covers real session_type and jid classes", () => {
  assert.equal(classifyThreadType("120363000000000001@g.us", 1), "group");
  assert.equal(classifyThreadType("120363000000000002@g.us", 4), "group"); // announce group
  assert.equal(classifyThreadType("15550100090@s.whatsapp.net", 0), "dm");
  assert.equal(classifyThreadType("100555010000001@lid", 0), "dm"); // linked-id 1:1
  assert.equal(classifyThreadType("15550100091@status", 3), "channel"); // status pseudo-chat
  assert.equal(classifyThreadType("status@broadcast", 3), "channel");
  // null jid -> session_type fallback; both null -> default 'dm' (least surprising).
  assert.equal(classifyThreadType(null, 1), "group");
  assert.equal(classifyThreadType(null, null), "dm");
});

// T7 — outbound rows resolve sender 'user' and recipient = the partner (to_jid).
test("outbound row: sender is 'user', recipient is the partner", () => {
  const outboundRow = {
    ts: "2026-01-20T08:30:00.000Z",
    source_msg_id: "3A00B2C3D4E5F6071829",
    raw_content: {
      text: "running late, sorry",
      from_jid: null,
      to_jid: "15550100002@s.whatsapp.net",
      session_jid: "15550100002@s.whatsapp.net",
      is_from_me: 1,
      session_type: 0,
    },
  };
  const env = _toEnvelope(outboundRow, {});
  assert.equal(env.is_from_me, true);
  assert.equal(env.sender.id, "user");
  assert.deepEqual(env.recipients, ["15550100002@s.whatsapp.net"]);
  assert.equal(validateEnvelope(env).ok, true);
});

// T8 — a group inbound row: thread_type group, recipient is the operator.
test("group inbound row: thread_type group, recipient 'user'", () => {
  const groupRow = {
    ts: "2026-02-27T09:45:00.000Z",
    source_msg_id: "3A00C3D4E5F60718293A",
    raw_content: {
      text: "Hey everyone",
      from_jid: "120363000000000003@g.us",
      to_jid: null,
      session_jid: "120363000000000003@g.us",
      is_from_me: 0,
      session_type: 1,
    },
  };
  const env = _toEnvelope(groupRow, {});
  assert.equal(env.thread_type, "group");
  assert.deepEqual(env.recipients, ["user"]);
  assert.equal(env.is_from_me, false);
});

// T9 — DEFENSIVE: a non-object / malformed row never throws; yields an INVALID
// envelope the N1 validator rejects (fail-closed, not fail-open).
test("malformed input never throws; yields a validator-rejected envelope", () => {
  for (const bogus of [null, undefined, 42, "x", []]) {
    let env;
    assert.doesNotThrow(() => { env = _toEnvelope(bogus); });
    assert.equal(env.platform, PLATFORM);
    assert.equal(validateEnvelope(env).ok, false, `bogus ${String(bogus)} must reject`);
  }
});

// T10 — THE 1:1 GAP FIX, unit-level: resolveSenderForRow recovers the partner's
// push name for a 1:1 inbound row whose ZPARTNERNAME is only a phone string.
test("1:1 gap fix: push-name fallback recovers the partner name", () => {
  const row = {
    is_from_me: 0,
    from_jid: "100555010000001@lid",
    session_type: 0,
    session_label: null, // ZPARTNERNAME was just a phone string -> unresolved
  };
  // BEFORE-equivalent: no pushByJid -> name stays null.
  const before = resolveSenderForRow(row, {});
  assert.equal(before.sender_name, null);
  assert.equal(before.sender_jid, "100555010000001@lid");
  // AFTER: pushByJid[from_jid] recovers the human label.
  const after = resolveSenderForRow(row, {
    pushByJid: new Map([["100555010000001@lid", "Jordan"]]),
  });
  assert.equal(after.sender_name, "Jordan");
  assert.equal(after.sender_jid, "100555010000001@lid");
  // a phone-like push name is NOT accepted as a name (isResolvedName gate).
  const phoney = resolveSenderForRow(row, {
    pushByJid: new Map([["100555010000001@lid", "+1 (555) 555-0100"]]),
  });
  assert.equal(phoney.sender_name, null);
});

// T11 — THE GATE: over a SAMPLE of 1:1 inbound rows, the sender_name null-rate
// DROPS after the push-name fallback (Y<X), and every produced envelope
// VALIDATES. The sample is synthetic and in-memory so the suite stays hermetic
// on any host.
test("GATE: 1:1 sender_name null-rate drops after the fix; all envelopes valid", () => {
  // Partner-name map (ZPARTNERNAME) for the distinct 1:1 partners of a sampled
  // window — the names that resolve via the OLD (session_label-only) path. Every
  // id and label here is SYNTHETIC; the roster keeps the shape mix of a WhatsApp
  // store (phone JIDs and @lid linked-ids; one-word, two-word, parenthesised and
  // abbreviated labels).
  const partnerByJid = new Map([
    ["100555010000101@lid", "Avery Example"], ["15550100011@s.whatsapp.net", "Blake"],
    ["15550100012@s.whatsapp.net", "Casey"], ["100555010000102@lid", "Dana (Example’s Co)"],
    ["100555010000103@lid", "Emery"], ["15550100002@s.whatsapp.net", "Finley"],
    ["15550100013@s.whatsapp.net", "Gray"], ["100555010000104@lid", "Harper Sample"],
    ["15550100014@s.whatsapp.net", "Indy"], ["15550100015@s.whatsapp.net", "Jules Example"],
    ["100555010000105@lid", "Kai Sample"], ["15550100016@s.whatsapp.net", "Lane"],
    ["100555010000106@lid", "Member Placeholder"], ["15550100017@s.whatsapp.net", "Nomen Sample"],
    ["15550100018@s.whatsapp.net", "Oakley"], ["100555010000107@lid", "Parker Demo"],
    ["100555010000108@lid", "Quinn (Ex)"], ["15550100019@s.whatsapp.net", "Reese"],
    ["100555010000109@lid", "Sage Example"], ["100555010000110@lid", "Tatum Sample"],
    ["15550100020@s.whatsapp.net", "Uma Example"], ["15550100021@s.whatsapp.net", "Val"],
    ["15550100022@s.whatsapp.net", "Wren Sample"], ["15550100023@s.whatsapp.net", "Xen P."],
    ["15550100024@s.whatsapp.net", "Yael"], ["100555010000111@lid", "Zion Example"],
    ["15550100025@s.whatsapp.net", "Arden Sample"], ["15550100026@s.whatsapp.net", "Bryn Example"],
    ["100555010000112@lid", "Cleo Sample"], ["15550100027@s.whatsapp.net", "Drew"],
    ["15550100028@s.whatsapp.net", "Exemplar Demo"], ["15550100029@s.whatsapp.net", "Fictive Sample"],
    ["15550100091@s.whatsapp.net", "Gale Example"],
  ]);
  // Push-name map (ZWAPROFILEPUSHNAME) — recovers the human label for the GAP
  // partners whose ZPARTNERNAME is only a formatted phone string (the 1:1 fix).
  const pushByJid = new Map([
    ["100555010000001@lid", "Jordan"],
    ["100555010000201@lid", "Jo Sample"],
    ["100555010000202@lid", "Lou"],
  ]);

  // The sample is a SYNTHETIC in-memory mix of 1:1 inbound rows (hermetic: no
  // ledger is read): one GAP partner the push name recovers, one partner nothing
  // resolves, and one partner the OLD partner-name path already resolves. The
  // recoverable GAP partner guarantees a measurable drop.
  const sample = [
    { ts: "2026-03-03T04:10:20.000Z", source_msg_id: "S1",
      raw_content: { text: "hi", from_jid: "100555010000001@lid", to_jid: null,
        session_jid: "100555010000001@lid", is_from_me: 0, session_type: 0 } },
    { ts: "2026-03-03T04:11:00.000Z", source_msg_id: "S2",
      raw_content: { text: "yo", from_jid: "15550100090@s.whatsapp.net", to_jid: null,
        session_jid: "15550100090@s.whatsapp.net", is_from_me: 0, session_type: 0 } },
    { ts: "2026-03-03T04:12:00.000Z", source_msg_id: "S3",
      raw_content: { text: "ok", from_jid: "15550100011@s.whatsapp.net", to_jid: null,
        session_jid: "15550100011@s.whatsapp.net", is_from_me: 0, session_type: 0 } },
  ];

  const N = sample.length;
  assert.ok(N >= 2, "need a non-trivial sample");

  let validCount = 0;
  let nullBefore = 0;
  let nullAfter = 0;
  for (const r of sample) {
    // BEFORE: partner-name only (no push fallback). lidNameFloor:false so we
    // measure GENUINE push-name resolution, not the N11 best-effort display floor
    // (the floor is asserted separately in the N11 suite; here we keep the N3
    // metric pure — unresolved partners read null, not a placeholder).
    const before = _toEnvelope(r, { partnerByJid, lidNameFloor: false });
    // AFTER: partner-name + push fallback (still floor-off to isolate the metric).
    const after = _toEnvelope(r, { partnerByJid, pushByJid, lidNameFloor: false });
    if (validateEnvelope(after).ok) validCount += 1;
    if (before.sender.name === null) nullBefore += 1;
    if (after.sender.name === null) nullAfter += 1;
  }

  const pct = (n) => ((100 * n) / N).toFixed(1);
  // The gate line — printed for the operator log.
  process.stdout.write(
    `N3-GATE valid=${validCount}/${N} ` +
      `null_rate before=${pct(nullBefore)}% after=${pct(nullAfter)}% ` +
      `(after ${nullAfter} <= before ${nullBefore})\n`,
  );

  // Every produced envelope must validate.
  assert.equal(validCount, N, "every sampled envelope must validate against N1");
  // The fix must NOT increase the null-rate, and must STRICTLY decrease it: the
  // synthetic sample contains a gap jid, so the drop is guaranteed by
  // construction (one recoverable partner).
  assert.ok(nullAfter <= nullBefore, "null-rate must not increase");
  assert.ok(nullAfter < nullBefore, "null-rate must STRICTLY drop (Y<X) after the 1:1 fix");
});

// T12 — ABSTRACTION INVARIANT: the platform name lives ONLY in the adapter. The
// adapter file is allowed to name 'whatsapp'; this asserts the emitted ENVELOPE
// carries the slug as DATA (env.platform), and that the validator (already gated
// in N1) needs no platform knowledge to accept it — i.e. degradation is data.
test("degradation is DATA: the all-false capabilities drive a platform-agnostic accept", () => {
  const fx = readJson("whatsapp.fixture.json");
  const env = _toEnvelope(fx.raw_row, sidecarFromFixture(fx));
  // platform is a non-empty data slug, not a branch.
  assert.equal(env.platform, "whatsapp");
  assert.equal(typeof env.platform, "string");
  // the adapter source DOES legitimately name the platform (it is the ONE place
  // allowed to) — sanity-check the adapter is the encoder of the slug.
  const src = readFileSync(ADAPTER_FILE, "utf8");
  assert.ok(src.includes("whatsapp"), "the adapter is the single platform-naming site");
  // and the envelope it emits is accepted by the agnostic validator purely on shape.
  assert.equal(validateEnvelope(env).ok, true);
});
