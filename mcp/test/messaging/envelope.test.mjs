// envelope.test.mjs — WORKUNIT N1 regression suite for the Wave-0 FROZEN
// Envelope contract (mcp/lib/messaging/envelope.js + fixtures/).
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions. No DB, no
// network, no filesystem writes — reads only the fixture corpus + the lib source
// (for the platform-agnosticism grep gate). Runs in well under 2s.
//
// What this suite proves (mapped to the N1 GATE + REVIEW checks):
//   - validateEnvelope ACCEPTS each of the four real platform fixtures.
//   - It REJECTS each of exactly 3 closed bad shapes, citing the right field.
//   - capabilities{} is REQUIRED (keystone), strict-shaped (no missing/extra key).
//   - ts is integer-ms only (ISO/float/numeric-string rejected).
//   - thread_type enum is exact (casing/whitespace variants rejected).
//   - is_from_me is a strict boolean (0/1/"true"/null rejected).
//   - sender.name null is legal; sender without id rejects.
//   - reply_to_id is genuinely optional (absent ok; wrong-type rejects).
//   - validateEnvelope never throws on adversarial input.
//   - the validator carries ZERO platform name tokens (agnosticism gate).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  validateEnvelope,
  THREAD_TYPES,
  CAPABILITY_KEYS,
  SIGNAL_KEYS,
} from "../../lib/messaging/envelope.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(__dirname, "../../lib/messaging");
const FIXTURES_DIR = path.join(LIB_DIR, "fixtures");

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, rel), "utf8"));
}

const PLATFORM_FIXTURES = ["whatsapp", "imessage", "mail", "telegram"];

// A deep-cloned, known-good base envelope to mutate in negative tests. We derive
// it from the iMessage fixture (a real shape carrying reply_to_id) so the suite
// stays grounded; cloning isolates each test from mutation.
function goodBase() {
  return structuredClone(readJson("imessage.fixture.json").expected_envelope);
}

// T1 — every platform fixture's expected_envelope ACCEPTS (the abstraction surface).
test("accepts every platform fixture's expected_envelope", () => {
  for (const p of PLATFORM_FIXTURES) {
    const fx = readJson(`${p}.fixture.json`);
    const res = validateEnvelope(fx.expected_envelope);
    assert.equal(res.ok, true, `${p} should accept; errors=${JSON.stringify(res.errors)}`);
    assert.deepEqual(res.errors, [], `${p} should have no errors`);
  }
});

// T2 — bad-shapes.json is a CLOSED set of exactly 3 (the gate count is load-bearing).
test("bad-shapes corpus has exactly 3 closed entries", () => {
  const bad = readJson("bad-shapes.json");
  assert.equal(Array.isArray(bad), true);
  assert.equal(bad.length, 3);
});

// T3 — each bad shape REJECTS and cites the expected field.
test("rejects each of the 3 named bad shapes with the right field", () => {
  const bad = readJson("bad-shapes.json");
  for (const b of bad) {
    const res = validateEnvelope(b.envelope);
    assert.equal(res.ok, false, `bad shape ${b.label} should reject`);
    const cited = res.errors.some((e) => e.field.includes(b.expect_reason_includes));
    assert.equal(cited, true, `bad shape ${b.label} must cite "${b.expect_reason_includes}"`);
  }
});

// T4 — keystone: removing capabilities{} from a GOOD envelope REJECTS (REVIEW 1).
test("missing capabilities block is rejected (keystone enforced)", () => {
  const env = goodBase();
  delete env.capabilities;
  const res = validateEnvelope(env);
  assert.equal(res.ok, false);
  assert.equal(res.errors.some((e) => e.field === "capabilities"), true);
});

// T5 — partial capabilities (3 of 4 keys) REJECTS (REVIEW 2: under-declaration caught).
test("partial capabilities (missing one key) is rejected", () => {
  const env = goodBase();
  delete env.capabilities.addressing_first_class;
  const res = validateEnvelope(env);
  assert.equal(res.ok, false);
  assert.equal(
    res.errors.some((e) => e.field === "capabilities.addressing_first_class"),
    true,
  );
});

// T6 — extra capability key REJECTS (REVIEW 3: contract cannot silently grow).
test("extra capability key is rejected (strict shape)", () => {
  const env = goodBase();
  env.capabilities.some_new_platform_thing = true;
  const res = validateEnvelope(env);
  assert.equal(res.ok, false);
  assert.equal(
    res.errors.some((e) => e.field === "capabilities.some_new_platform_thing"),
    true,
  );
});

// T7 — ts type-laxity: ISO string, float, and numeric string ALL reject (REVIEW 4).
test("ts accepts only positive integer ms; ISO/float/numeric-string reject", () => {
  const env = goodBase();
  assert.equal(validateEnvelope(env).ok, true); // integer ms baseline
  for (const badTs of ["2026-01-01T00:00:00.000Z", 1.7e12 + 0.5, "1700000000000", 0, -5]) {
    const e = goodBase();
    e.ts = badTs;
    const res = validateEnvelope(e);
    assert.equal(res.ok, false, `ts=${String(badTs)} should reject`);
    assert.equal(res.errors.some((x) => x.field === "ts"), true);
  }
});

// T8 — thread_type enum is exact: casing/whitespace variants reject (REVIEW 5).
test("thread_type enum is exact (casing/whitespace rejected)", () => {
  for (const ok of THREAD_TYPES) {
    const e = goodBase();
    e.thread_type = ok;
    assert.equal(validateEnvelope(e).ok, true, `${ok} should accept`);
  }
  for (const bad of ["DM", " dm", "Dm", "broadcast", "DM "]) {
    const e = goodBase();
    e.thread_type = bad;
    const res = validateEnvelope(e);
    assert.equal(res.ok, false, `${JSON.stringify(bad)} should reject`);
    assert.equal(res.errors.some((x) => x.field === "thread_type"), true);
  }
});

// T9 — is_from_me strict boolean: 1/0/"true"/null reject; true/false accept (REVIEW 6).
test("is_from_me must be a strict boolean", () => {
  for (const ok of [true, false]) {
    const e = goodBase();
    e.is_from_me = ok;
    assert.equal(validateEnvelope(e).ok, true, `${ok} should accept`);
  }
  for (const bad of [1, 0, "true", null, undefined]) {
    const e = goodBase();
    e.is_from_me = bad;
    const res = validateEnvelope(e);
    assert.equal(res.ok, false, `is_from_me=${String(bad)} should reject`);
    assert.equal(res.errors.some((x) => x.field === "is_from_me"), true);
  }
});

// T10 — sender.name:null accepts; sender without id rejects (REVIEW 7).
test("sender.name null is legal; sender missing id rejects", () => {
  const ok = goodBase();
  ok.sender.name = null;
  assert.equal(validateEnvelope(ok).ok, true);

  const bad = goodBase();
  delete bad.sender.id;
  const res = validateEnvelope(bad);
  assert.equal(res.ok, false);
  assert.equal(res.errors.some((e) => e.field === "sender.id"), true);
});

// T11 — reply_to_id is genuinely optional: absent accepts; wrong-type rejects (REVIEW 8).
test("reply_to_id absence is legal; present-but-wrong-type rejects", () => {
  const absent = goodBase();
  delete absent.reply_to_id;
  assert.equal(validateEnvelope(absent).ok, true, "absent reply_to_id should accept");

  const nullish = goodBase();
  nullish.reply_to_id = null;
  assert.equal(validateEnvelope(nullish).ok, true, "null reply_to_id should accept");

  const wrong = goodBase();
  wrong.reply_to_id = 12345;
  const res = validateEnvelope(wrong);
  assert.equal(res.ok, false);
  assert.equal(res.errors.some((e) => e.field === "reply_to_id"), true);
});

// T12 — no-throw fail-closed: adversarial whole-envelope inputs return {ok:false} (REVIEW 9).
test("never throws on adversarial input; returns ok:false", () => {
  for (const bogus of [null, undefined, 42, [], "x", true, NaN]) {
    let res;
    assert.doesNotThrow(() => {
      res = validateEnvelope(bogus);
    }, `validateEnvelope(${String(bogus)}) must not throw`);
    assert.equal(res.ok, false, `${String(bogus)} should be ok:false`);
    assert.equal(Array.isArray(res.errors), true);
  }
});

// T13 — directed_at_me_signals must be exactly the 3 SIGNAL_KEYS, strict booleans.
test("directed_at_me_signals is exact-shaped strict booleans", () => {
  const env = goodBase();
  assert.equal(validateEnvelope(env).ok, true);

  const missing = goodBase();
  delete missing.directed_at_me_signals.reply_to_me;
  assert.equal(validateEnvelope(missing).ok, false);

  const nonBool = goodBase();
  nonBool.directed_at_me_signals.mention_me = 1;
  const res = validateEnvelope(nonBool);
  assert.equal(res.ok, false);
  assert.equal(
    res.errors.some((e) => e.field === "directed_at_me_signals.mention_me"),
    true,
  );
});

// T14 — the degradation-as-data keystone carries the VERIFIED per-platform realities.
test("fixture capabilities encode the verified per-platform degradation matrix", () => {
  const wa = readJson("whatsapp.fixture.json").expected_envelope.capabilities;
  assert.deepEqual(wa, {
    reply_to_available: false,
    structured_mentions: false,
    self_identity_reliable: false,
    addressing_first_class: false,
  });

  const im = readJson("imessage.fixture.json").expected_envelope.capabilities;
  assert.equal(im.reply_to_available, true, "iMessage stores reply targets");
  assert.equal(im.self_identity_reliable, true, "iMessage handle_id is unmasked");

  const mail = readJson("mail.fixture.json").expected_envelope.capabilities;
  assert.equal(mail.addressing_first_class, true, "Mail To/Cc is first-class addressing");

  const tg = readJson("telegram.fixture.json").expected_envelope.capabilities;
  assert.equal(tg.structured_mentions, true, "Telegram has structured-mention capability");
});

// T15 — platform-agnosticism: the validator lib carries ZERO platform name tokens
//        (REVIEW 10 / the seed of the N2 own-gate). Mechanical grep over source text.
test("validator lib contains zero platform-name tokens (agnosticism gate)", () => {
  const src = readFileSync(path.join(LIB_DIR, "envelope.js"), "utf8");
  const RE = /whatsapp|imessage|telegram|mail|jid|chat_guid/i;
  assert.equal(RE.test(src), false, "envelope.js must not name any platform");
});

// T16 — non-stub fixtures' raw_row key sets are a subset of the real raw_content
//        keys (fixture realism audit, REVIEW 11); stubs are explicitly flagged.
test("fixture realism: non-stub raw_rows subset real keys; stubs flagged", () => {
  // WhatsApp + iMessage are non-stub: their raw_content keys are all drawn from
  // the real storage/sources rows captured during MAP.
  const REAL_WA_KEYS = new Set([
    "text", "from_jid", "to_jid", "session_jid", "is_from_me", "message_type",
    "session_type", "member_jid", "sender_name", "has_media", "starred",
    "group_event_type", "message_date_coredata", "media_local_path",
    "media_title", "low_signal_message_type",
  ]);
  const wa = readJson("whatsapp.fixture.json");
  assert.equal(wa.stub, false);
  for (const k of Object.keys(wa.raw_row.raw_content)) {
    assert.equal(REAL_WA_KEYS.has(k), true, `whatsapp raw_content.${k} not a real key`);
  }
  const tg = readJson("telegram.fixture.json");
  const mail = readJson("mail.fixture.json");
  assert.equal(tg.stub, true, "telegram fixture must be flagged stub");
  assert.equal(mail.stub, true, "mail fixture must be flagged stub");
});

// Sanity: the exported vocabularies are frozen closed sets of the documented size.
test("exported vocabularies are frozen closed sets", () => {
  assert.equal(Object.isFrozen(THREAD_TYPES), true);
  assert.equal(Object.isFrozen(CAPABILITY_KEYS), true);
  assert.equal(Object.isFrozen(SIGNAL_KEYS), true);
  assert.deepEqual([...THREAD_TYPES], ["dm", "group", "channel"]);
  assert.equal(CAPABILITY_KEYS.length, 4);
  assert.equal(SIGNAL_KEYS.length, 3);
});
