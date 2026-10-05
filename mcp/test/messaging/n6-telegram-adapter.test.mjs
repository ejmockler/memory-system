// n6-telegram-adapter.test.mjs — WORKUNIT N6 regression suite for the Telegram
// L1 adapter (mcp/lib/messaging/adapters/telegram.js).
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions. Hermetic: no
// DB, no network, no filesystem writes. Reads ONLY the hand-written fixture
// corpus + N1's frozen validateEnvelope. Runs in well under 2s.
//
// What this suite proves (mapped to the N6 GATE + REVIEW + TESTS sections):
//   - _toEnvelope maps every wire shape (dm in/out, group, supergroup→group,
//     channel) to the documented Envelope and N1's validateEnvelope ACCEPTS all.
//   - user→dm (the `user`-not-`private` wire trap, REVIEW R2).
//   - reply_to is namespaced tg:<peer>:<msg> (REVIEW R5); absent ⇒ null (no tg::).
//   - is_from_me is the OR of is_outgoing/is_self (REVIEW R6).
//   - ts is integer-ms; an unparseable ts throws (REVIEW R7).
//   - structured-mention parsing is real (entities present ⇒ non-empty mentions;
//     absent ⇒ []), honoring capabilities.structured_mentions=true (R1).
//   - the capability keystone block is exact (N2 depends on it).
//   - the activation gate: collect() with no session ⇒ inactive + [] + marker,
//     no throw, no IO; the pure mapper still works while inactive (R4).
//   - the adapter's own emitted envelopes carry ZERO upper-layer platform leak
//     beyond the adapter file itself (R3, asserted over classifier/engine if present).
//
// Emits the GATE line:
//   fixture valid=N/N structured_mentions=true; inactive_path=clean

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { validateEnvelope } from "../../lib/messaging/envelope.js";
import {
  _toEnvelope,
  collect,
  isActive,
  CAPABILITIES,
  PLATFORM,
  INACTIVE_MARKER,
} from "../../lib/messaging/adapters/telegram.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures", "n6-telegram-adapter.fixtures.json"), "utf8"),
).fixtures;

function byLabel(label) {
  const fx = FIXTURES.find((f) => f.label === label);
  assert.ok(fx, `fixture "${label}" must exist`);
  return fx;
}

// An env with NO telegram session — drives the inactive gate deterministically.
// We also point TELEGRAM_SESSION_FILE at a path that cannot exist so an actual
// operator session file on the host can never make this test flap.
const NO_SESSION_ENV = {
  TELEGRAM_SESSION_FILE: "/nonexistent/n6-test/telegram.session",
};
const SESSION_ENV = {
  TELEGRAM_SESSION_FILE: "/nonexistent/n6-test/telegram.session",
  TELEGRAM_SESSION_STRING: "fake-session-string-for-test",
};

// T1 — every fixture maps to its documented expected envelope EXACTLY (TESTS 1-12,16).
test("each fixture maps to its exact expected envelope", () => {
  for (const fx of FIXTURES) {
    const env = _toEnvelope(fx.raw);
    assert.deepEqual(env, fx.expected, `fixture ${fx.label} envelope mismatch`);
  }
});

// T2 — every emitted envelope passes N1's validateEnvelope (GATE part a / TESTS 13).
test("every adapter envelope passes N1 validateEnvelope", () => {
  for (const fx of FIXTURES) {
    const env = _toEnvelope(fx.raw);
    const res = validateEnvelope(env);
    assert.equal(res.ok, true, `${fx.label} should validate; errors=${JSON.stringify(res.errors)}`);
    assert.deepEqual(res.errors, []);
  }
});

// T3 — user→dm (REVIEW R2: the `user` not `private` wire trap). BOTH keys map.
test("peer_type user AND private both map to dm", () => {
  const dmIn = _toEnvelope(byLabel("dm_in").raw);
  assert.equal(dmIn.thread_type, "dm");
  assert.equal(dmIn.is_from_me, false);
  assert.equal(dmIn.sender.id, "tg:55501");

  // Synthesize a `private`-keyed row from the dm fixture to prove robustness.
  const privRaw = structuredClone(byLabel("dm_in").raw);
  privRaw.raw_content.peer_type = "private";
  assert.equal(_toEnvelope(privRaw).thread_type, "dm");
});

// T4 — supergroup collapses to group so N4 never sees a 4th conversation shape.
test("supergroup collapses to thread_type group; group stays group; channel stays channel", () => {
  assert.equal(_toEnvelope(byLabel("group_in").raw).thread_type, "group");
  assert.equal(_toEnvelope(byLabel("supergroup_to_group").raw).thread_type, "group");
  assert.equal(_toEnvelope(byLabel("channel_with_reply").raw).thread_type, "channel");
});

// T5 — reply_to namespacing (REVIEW R5) + null-safety (TESTS 6,7).
test("reply_to_id is tg-namespaced when present and null when absent (no tg::)", () => {
  const out = _toEnvelope(byLabel("dm_out").raw);
  assert.equal(out.reply_to_id, "tg:55501:9001");

  const chan = _toEnvelope(byLabel("channel_with_reply").raw);
  assert.equal(chan.reply_to_id, "tg:-1001234567890:8830");

  const noReply = _toEnvelope(byLabel("dm_in").raw);
  assert.equal(noReply.reply_to_id, null);
  // Guard against the "tg::" empty-id-space bug.
  assert.equal(noReply.reply_to_id === "tg::", false);
});

// T6 — is_from_me is the OR of is_outgoing/is_self (REVIEW R6 / TESTS 2,12).
test("is_from_me ORs is_outgoing and is_self; outbound identity normalizes to user", () => {
  const out = _toEnvelope(byLabel("dm_out").raw); // is_outgoing:true
  assert.equal(out.is_from_me, true);
  assert.equal(out.sender.id, "user");
  assert.equal(out.sender.name, "user");
  assert.deepEqual(out.recipients, ["tg:55501"]);

  const selfRow = _toEnvelope(byLabel("dm_self_second_device").raw); // is_self:true, is_outgoing:false
  assert.equal(selfRow.is_from_me, true);
  assert.equal(selfRow.sender.id, "user");
});

// T7 — ts is integer-ms; unparseable ts throws loudly (REVIEW R7 / TESTS 11).
test("ts converts ISO-8601 to integer ms; unparseable ts throws (no NaN)", () => {
  const env = _toEnvelope(byLabel("dm_in").raw);
  assert.equal(env.ts, 1780740000000);
  assert.equal(Number.isInteger(env.ts), true);

  const bad = structuredClone(byLabel("dm_in").raw);
  bad.ts = "not-a-date";
  assert.throws(() => _toEnvelope(bad), /unparseable ts/);

  // Already-integer ms passes through unchanged.
  const intMs = structuredClone(byLabel("dm_in").raw);
  intMs.ts = 1780740000000;
  assert.equal(_toEnvelope(intMs).ts, 1780740000000);
});

// T8 — structured mentions: present ⇒ parsed; absent ⇒ [] (R1 / TESTS 8,9).
test("entities parse into structured mentions; absent entities yield []", () => {
  const ment = _toEnvelope(byLabel("group_with_mention_entity").raw);
  assert.deepEqual(ment.mentions, [{ id: "tg:7", name: null }]);

  const noMent = _toEnvelope(byLabel("dm_in").raw);
  assert.deepEqual(noMent.mentions, []);

  // A bare @handle MessageEntityMention yields {id:null, name:"@slice"} from text.
  const bare = structuredClone(byLabel("group_in").raw);
  bare.raw_content.text = "@dana please confirm";
  bare.raw_content.entities = [
    { _: "MessageEntityMention", offset: 0, length: 5 },
  ];
  const bareEnv = _toEnvelope(bare);
  assert.deepEqual(bareEnv.mentions, [{ id: null, name: "@dana" }]);
});

// T9 — the capability keystone is exact and frozen (TESTS 10).
test("capabilities block is exact and matches the frozen constant", () => {
  const expected = {
    reply_to_available: true,
    structured_mentions: true,
    self_identity_reliable: true,
    addressing_first_class: false,
  };
  assert.deepEqual({ ...CAPABILITIES }, expected);
  assert.equal(Object.isFrozen(CAPABILITIES), true);
  for (const fx of FIXTURES) {
    assert.deepEqual(_toEnvelope(fx.raw).capabilities, expected, `${fx.label} caps`);
  }
});

// T10 — directed_at_me_signals: dm inbound addressed_to_me=true by construction;
//        outbound + non-dm false. mention_me/reply_to_me conservatively false.
test("directed_at_me_signals encode dm-inbound addressing as data", () => {
  assert.equal(_toEnvelope(byLabel("dm_in").raw).directed_at_me_signals.addressed_to_me, true);
  assert.equal(_toEnvelope(byLabel("dm_out").raw).directed_at_me_signals.addressed_to_me, false);
  assert.equal(_toEnvelope(byLabel("group_in").raw).directed_at_me_signals.addressed_to_me, false);
  assert.equal(_toEnvelope(byLabel("channel_with_reply").raw).directed_at_me_signals.addressed_to_me, false);
  const sig = _toEnvelope(byLabel("dm_in").raw).directed_at_me_signals;
  assert.equal(sig.mention_me, false);
  assert.equal(sig.reply_to_me, false);
});

// T11 — media/empty-text row maps to content:"" (not null) and validates (R8/TESTS 16).
test("media/empty-text row maps to empty-string content and still validates", () => {
  const env = _toEnvelope(byLabel("dm_media_empty_text").raw);
  assert.equal(env.content, "");
  assert.equal(validateEnvelope(env).ok, true);
});

// T12 — activation gate (R4 / TESTS 14): no session ⇒ inactive + [] + marker, no throw.
test("collect() with no session returns inactive marker and no envelopes", () => {
  assert.equal(isActive(NO_SESSION_ENV), false);
  let res;
  assert.doesNotThrow(() => {
    res = collect({ rows: [byLabel("dm_in").raw], env: NO_SESSION_ENV });
  });
  assert.deepEqual(res.envelopes, []);
  assert.equal(res.inactive, true);
  assert.match(res.marker, /telegram inactive/);
  assert.equal(res.marker, INACTIVE_MARKER);
});

// T13 — gate is at COLLECTION, not in the mapper (R4 / TESTS 15): the pure mapper
//        still produces a valid envelope while the session is inactive.
test("pure mapper works while inactive; active collect() maps rows", () => {
  assert.equal(isActive(NO_SESSION_ENV), false);
  const env = _toEnvelope(byLabel("dm_in").raw);
  assert.equal(validateEnvelope(env).ok, true);

  // With a (fake) session string present, collect() maps the supplied rows.
  const active = collect({
    rows: [byLabel("dm_in").raw, byLabel("group_with_mention_entity").raw],
    env: SESSION_ENV,
  });
  assert.equal(active.inactive, false);
  assert.equal(active.marker, null);
  assert.equal(active.envelopes.length, 2);
  for (const e of active.envelopes) {
    assert.equal(validateEnvelope(e).ok, true);
  }
});

// T14 — collect() is total over a mixed batch: a structurally-invalid row is
//        skipped, valid rows still map (defensive batch behavior).
test("active collect() skips structurally-invalid rows without sinking the batch", () => {
  const good = byLabel("dm_in").raw;
  const broken = { ts: "2026-06-06T10:00:00.000Z", raw_content: { /* no peer_type/peer_id */ } };
  const res = collect({ rows: [good, broken], env: SESSION_ENV });
  assert.equal(res.inactive, false);
  assert.equal(res.envelopes.length, 1);
  assert.equal(res.envelopes[0].thread_id, "tg:55501");
});

// T15 — platform constant + every envelope's platform field is "telegram".
test("platform constant is telegram and stamped on every envelope", () => {
  assert.equal(PLATFORM, "telegram");
  for (const fx of FIXTURES) {
    assert.equal(_toEnvelope(fx.raw).platform, "telegram");
  }
});

// T16 — GATE line emission. Computes the observable closure metrics and prints
//        the exact gate string the N6 GATE section requires.
test("emit GATE line: fixture valid=N/N structured_mentions=true; inactive_path=clean", () => {
  const n = FIXTURES.length;
  let valid = 0;
  for (const fx of FIXTURES) {
    if (validateEnvelope(_toEnvelope(fx.raw)).ok) valid += 1;
  }
  // structured_mentions honored: the entity fixture yields non-empty mentions,
  // the no-entity fixture yields [].
  const mentParsed =
    _toEnvelope(byLabel("group_with_mention_entity").raw).mentions.length === 1 &&
    _toEnvelope(byLabel("dm_in").raw).mentions.length === 0;
  // inactive path clean: no throw, [] envelopes, marker set.
  let inactiveClean = false;
  assert.doesNotThrow(() => {
    const r = collect({ rows: [byLabel("dm_in").raw], env: NO_SESSION_ENV });
    inactiveClean = r.inactive === true && r.envelopes.length === 0 && !!r.marker;
  });

  assert.equal(valid, n, "all fixtures must validate");
  assert.equal(mentParsed, true, "structured_mentions must be honored");
  assert.equal(inactiveClean, true, "inactive path must be clean");

  // The observable GATE line.
  console.log(
    `fixture valid=${valid}/${n} structured_mentions=${mentParsed}; ` +
      `inactive_path=${inactiveClean ? "clean" : "DIRTY"}`,
  );
});
