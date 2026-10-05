// persona-derive-arc.test.mjs — the ARC DERIVER gate (the recent-arc facet).
//
// Proves the invariants deriveArc exists to protect, mirroring the persona-contract
// and sibling-deriver gates:
//   - PURE / TOTAL / DETERMINISTIC: a non-array / empty / junk-only / odd input
//     degrades to the byte-neutral default {last_ts:null, gist:'', trend:'dormant'}
//     and NEVER throws; the same input yields a deep-equal (fresh, frozen) facet.
//   - last_ts = the MAX plausibleTs-clamped INBOUND ts; outbound ts and a corrupt
//     ts < MIN_PLAUSIBLE_TS_MS (epoch-0 artifact) are excluded.
//   - gist = 'closer' (non-empty closer tail) / 'quiet' (empty-or-whitespace tail)
//     / a <=GIST_TOKEN_MAX leading-word slice of substantive prose; always a string.
//   - trend ∈ {new, accelerating, steady, cooling, dormant}: shrinking inbound gaps
//     -> accelerating, growing -> cooling, stable -> steady, a single recent
//     UN-reciprocated inbound (fresh cold open) -> new, and (<2 plausible inbound OR
//     an aged-out last inbound) -> dormant.
//   - now is INJECTED so trend/dormancy are deterministic under test.
//   - NON-MUTATING: the input envelopes' .ts (and whole shape) are byte-identical
//     before and after the call.
//   - ZERO platform tokens in the module source (the N10 abstraction half-gate).
//
// ESM, node:test + node:assert/strict. Hermetic: NO network, NO DB, NO fs writes
// (reads only in-memory shapes + the lib bytes for the 0-platform-token grep).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import deriveArcDefault, {
  deriveArc,
  _capsForTest,
  NEUTRAL_ARC,
  MIN_PLAUSIBLE_TS_MS,
} from "../../lib/messaging/persona-derive-arc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_SRC = path.resolve(__dirname, "../../lib/messaging/persona-derive-arc.js");

// --- fixtures -------------------------------------------------------------
const NOW = 1_750_000_000_000; // a fixed, well-above-floor 2025-era epoch ms
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TREND_ENUM = new Set(["new", "accelerating", "steady", "cooling", "dormant"]);

const inb = (ts, content) => ({ is_from_me: false, ts, content });
const out = (ts, content) => ({ is_from_me: true, ts, content });

// ===========================================================================
// 1. EXPORTS — named + default deriveArc, plus the test views.
// ===========================================================================
test("arc: exports a deriveArc function (named === default) + test views", () => {
  assert.equal(typeof deriveArc, "function");
  assert.equal(deriveArcDefault, deriveArc);
  assert.equal(Object.isFrozen(_capsForTest), true);
  assert.equal(Object.isFrozen(NEUTRAL_ARC), true);
  assert.equal(typeof MIN_PLAUSIBLE_TS_MS, "number");
});

// ===========================================================================
// 2. TOTAL — non-array / empty / junk-only / odd input -> neutral default.
// ===========================================================================
test("arc: non-array | empty | malformed -> neutral default, never throws", () => {
  const bads = [null, undefined, 42, "nope", NaN, {}, [], [1, 2, 3], [null, "x"], true];
  for (const bad of bads) {
    let r;
    assert.doesNotThrow(() => {
      r = deriveArc(bad, { now: NOW });
    }, `input ${JSON.stringify(bad)} must not throw`);
    assert.deepEqual(r, { last_ts: null, gist: "", trend: "dormant" });
    assert.deepEqual(r, NEUTRAL_ARC);
    assert.equal(Object.isFrozen(r), true);
  }
});

test("arc: NEUTRAL_ARC is the byte-neutral default shape", () => {
  assert.deepEqual(NEUTRAL_ARC, { last_ts: null, gist: "", trend: "dormant" });
});

test("arc: total even with no opts / odd opts (now falls back, never throws)", () => {
  assert.doesNotThrow(() => deriveArc([inb(NOW, "hi there friend")]));
  assert.doesNotThrow(() => deriveArc([inb(NOW, "hi there friend")], null));
  assert.doesNotThrow(() => deriveArc([inb(NOW, "hi there friend")], { now: Infinity }));
  assert.doesNotThrow(() => deriveArc([inb(NOW, "hi there friend")], { now: "x" }));
});

// ===========================================================================
// 3. last_ts — max plausible INBOUND ts; outbound + sub-floor excluded.
// ===========================================================================
test("arc: last_ts = max plausible INBOUND ts; outbound ts ignored", () => {
  const t = [inb(NOW - 2 * DAY, "a"), inb(NOW - DAY, "b"), out(NOW, "my later reply")];
  assert.equal(deriveArc(t, { now: NOW }).last_ts, NOW - DAY);
});

test("arc: all-inbound ts < MIN_PLAUSIBLE_TS_MS -> last_ts null (trend dormant)", () => {
  const t = [inb(0, "epoch"), inb(MIN_PLAUSIBLE_TS_MS - 1, "still below floor")];
  const r = deriveArc(t, { now: NOW });
  assert.equal(r.last_ts, null);
  assert.equal(r.trend, "dormant");
});

test("arc: last_ts clamps an implausible/epoch-0 ts (keeps the plausible one)", () => {
  const t = [inb(0, "corrupt epoch row"), inb(NOW - DAY, "real recent inbound")];
  assert.equal(deriveArc(t, { now: NOW }).last_ts, NOW - DAY);
});

// ===========================================================================
// 4. gist — closer / quiet / substantive leading-word slice; always a string.
// ===========================================================================
test("arc: closer trailing inbound run -> gist 'closer'", () => {
  const t = [out(NOW - 3 * HOUR, "here you go"), inb(NOW - 2 * HOUR, "sounds great thanks")];
  assert.equal(deriveArc(t, { now: NOW }).gist, "closer");
});

test("arc: empty/whitespace trailing inbound run -> gist 'quiet'", () => {
  // (a) I spoke last -> trailing inbound run is empty.
  const spokeLast = [inb(NOW - 3 * HOUR, "anything new?"), out(NOW - 2 * HOUR, "all handled")];
  assert.equal(deriveArc(spokeLast, { now: NOW }).gist, "quiet");
  // (b) the trailing inbound message is whitespace/media-only.
  const whitespace = [inb(NOW - HOUR, "   ")];
  assert.equal(deriveArc(whitespace, { now: NOW }).gist, "quiet");
});

test("arc: substantive tail -> gist is its leading words, <=GIST_TOKEN_MAX tokens", () => {
  const text =
    "Hey could you review the attached deck and the budget numbers before the board meeting tomorrow morning?";
  const r = deriveArc([inb(NOW - HOUR, text)], { now: NOW });
  const toks = r.gist.split(/\s+/).filter(Boolean);
  assert.ok(toks.length <= _capsForTest.GIST_TOKEN_MAX, "gist within GIST_TOKEN_MAX");
  assert.equal(toks.length, _capsForTest.GIST_TOKEN_MAX, "17-token tail sliced to the cap");
  assert.ok(r.gist.startsWith("Hey could you review the attached"), "keeps leading words");
  assert.notEqual(r.gist, "closer");
  assert.notEqual(r.gist, "quiet");
});

test("arc: gist is always a string", () => {
  const samples = [
    [inb(NOW, "sounds great thanks")],
    [inb(NOW, "   ")],
    [inb(NOW, "could you please send the revised plan today?")],
    [out(NOW, "I spoke last")],
  ];
  for (const t of samples) assert.equal(typeof deriveArc(t, { now: NOW }).gist, "string");
});

// ===========================================================================
// 5. trend — the 5-enum cadence / endpoint buckets.
// ===========================================================================
test("arc: shrinking inbound gaps -> 'accelerating'", () => {
  // gaps 8h, 4h, 2h (tightening).
  const t = [inb(NOW - 14 * HOUR, "x"), inb(NOW - 6 * HOUR, "x"), inb(NOW - 2 * HOUR, "x"), inb(NOW, "x")];
  assert.equal(deriveArc(t, { now: NOW }).trend, "accelerating");
});

test("arc: growing inbound gaps -> 'cooling'", () => {
  // gaps 2h, 4h, 8h (widening).
  const t = [inb(NOW - 14 * HOUR, "x"), inb(NOW - 12 * HOUR, "x"), inb(NOW - 8 * HOUR, "x"), inb(NOW, "x")];
  assert.equal(deriveArc(t, { now: NOW }).trend, "cooling");
});

test("arc: stable inbound gaps -> 'steady'", () => {
  // gaps 4h, 4h, 4h (holding).
  const t = [inb(NOW - 12 * HOUR, "x"), inb(NOW - 8 * HOUR, "x"), inb(NOW - 4 * HOUR, "x"), inb(NOW, "x")];
  assert.equal(deriveArc(t, { now: NOW }).trend, "steady");
});

test("arc: a single recent UN-reciprocated inbound (fresh cold open) -> 'new'", () => {
  const t = [inb(NOW - 2 * HOUR, "hey, would love to chat about your work sometime")];
  const r = deriveArc(t, { now: NOW });
  assert.equal(r.trend, "new");
  assert.equal(r.last_ts, NOW - 2 * HOUR);
});

test("arc: a single RECIPROCATED recent inbound is not 'new' -> 'dormant'", () => {
  const t = [inb(NOW - HOUR, "hi"), out(NOW, "hey back")];
  assert.equal(deriveArc(t, { now: NOW }).trend, "dormant");
});

test("arc: a single AGED-OUT inbound (no longer fresh) -> 'dormant'", () => {
  const t = [inb(NOW - 30 * DAY, "hey there, this was ages ago")];
  assert.equal(deriveArc(t, { now: NOW }).trend, "dormant");
});

test("arc: >=2 inbound but last inbound aged beyond the dormancy window -> 'dormant'", () => {
  const t = [inb(NOW - 20 * DAY, "x"), inb(NOW - 10 * DAY, "x")];
  const r = deriveArc(t, { now: NOW });
  assert.equal(r.trend, "dormant");
  assert.equal(r.last_ts, NOW - 10 * DAY); // last_ts still the max plausible inbound
});

test("arc: trend is ALWAYS one of the 5-enum across a battery", () => {
  const battery = [
    [],
    [inb(NOW, "hi")],
    [inb(NOW - DAY, "x"), inb(NOW, "y")],
    [inb(NOW - 14 * HOUR, "x"), inb(NOW - 6 * HOUR, "x"), inb(NOW, "x")],
    [inb(NOW - 40 * DAY, "x"), inb(NOW - 30 * DAY, "x")],
  ];
  for (const t of battery) assert.equal(TREND_ENUM.has(deriveArc(t, { now: NOW }).trend), true);
});

// ===========================================================================
// 6. injected now honored — the same thread reads active vs dormant by clock.
// ===========================================================================
test("arc: injected now is honored (active under one clock, dormant under a later one)", () => {
  const t = [inb(NOW - 12 * HOUR, "x"), inb(NOW - 8 * HOUR, "x"), inb(NOW - 4 * HOUR, "x"), inb(NOW, "x")];
  assert.equal(deriveArc(t, { now: NOW }).trend, "steady");
  assert.equal(deriveArc(t, { now: NOW + 30 * DAY }).trend, "dormant");
});

// ===========================================================================
// 7. DETERMINISM + NON-MUTATION.
// ===========================================================================
test("arc: deterministic — two calls deep-equal (but fresh, frozen objects)", () => {
  const t = [inb(NOW - 2 * DAY, "hi there friend"), out(NOW - DAY, "hey"), inb(NOW - HOUR, "cool see you?")];
  const a = deriveArc(t, { now: NOW });
  const b = deriveArc(t, { now: NOW });
  assert.deepEqual(a, b);
  assert.notEqual(a, b, "a fresh object each call");
  assert.equal(Object.isFrozen(a), true);
});

test("arc: NON-MUTATING — input envelopes (and .ts) are byte-identical after the call", () => {
  const t = [inb(0, "corrupt"), inb(NOW - 2 * DAY, "hi"), out(NOW - DAY, "hey"), inb(NOW - HOUR, "see you?")];
  const before = JSON.parse(JSON.stringify(t));
  const tsBefore = t.map((e) => e.ts);
  deriveArc(t, { now: NOW });
  assert.deepEqual(t, before, "whole thread unchanged");
  assert.deepEqual(t.map((e) => e.ts), tsBefore, ".ts values unchanged");
});

// ===========================================================================
// 8. N10 half-gate — ZERO platform tokens in the module source.
// ===========================================================================
test("arc: persona-derive-arc.js carries ZERO platform-name tokens", () => {
  const src = readFileSync(LIB_SRC, "utf8").toLowerCase();
  const tokens = ["whatsapp", "imessage", "telegram", "slack", "signal", "mail", "gmail", "outlook"];
  for (const tok of tokens) {
    assert.equal(src.includes(tok), false, `persona-derive-arc.js must not contain "${tok}"`);
  }
});
