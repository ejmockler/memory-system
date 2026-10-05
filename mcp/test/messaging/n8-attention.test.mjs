// n8-attention.test.mjs — WORKUNIT N8 regression suite for the L4 attention /
// response-state engine (mcp/lib/messaging/attention.js).
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions. No DB, no
// network, no daemon, no filesystem writes — reads only the N8 labeled corpus
// fixture + the attention source text (for the agnosticism grep). Hermetic and
// fast (<3s); imports the synthesis scorers + N2 classifier read-only, NO
// adapter (proving N8 is authorable/testable with no connector on disk).
//
// What this suite proves (mapped to N8 TESTS 1-16 + REVIEW R1-R9):
//   T1  isUnanswered true when last msg inbound (they-spoke-last).
//   T2  isUnanswered false when last msg is_from_me (answered drops).
//   T3  isUnanswered false for all-mine thread (no false unanswered).
//   T4  staleness.ms === now - lastTs exactly, pinned now (clock injection).
//   T5  staleness bucket boundaries monotone (fresh<1h, today<24h, stale<7d, dead).
//   T6  substanceOfLastInboundRun isCloser=true for "thanks!"/"ah cool!"/"👍".
//   T7  substanceOfLastInboundRun isCloser=false for "can you send me the q3 deck?".
//   T8  GATE NEGATIVE CONTROL: they-spoke-last + directed + closer -> surface=false.
//   T9  GATE POSITIVE CONTROL: they-spoke-last + directed + substantive -> surface=true.
//   T10 directedGate false for undirected group trailing message.
//   T11 directedGate true for a 1:1 DM trailing message.
//   T12 mutation guard: input fixtures deep-equal a pre-call snapshot (Thesis #1).
//   T13 N7 soft-edge: identity stub keeps DMs separate; cross-platform resolver dedups.
//   T14 platform-token grep over attention.js === 0 (abstraction invariant).
//   T15 precision/recall over the labeled corpus meet the documented floor.
//   T16 determinism: JSON.stringify(computeAttention) equal across two pinned runs.
//   T4b closer-then-question ordering (last substantive run wins) / question-then-closer.
//   T17 throws TypeError on non-array; skips (counts) malformed envelopes.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  computeAttention,
  groupThreads,
  isUnanswered,
  staleness,
  substanceOfLastInboundRun,
  directedGate,
  ATTENTION_CAPS,
  MODEL_VERSION,
  getAttentionTelemetry,
  resetAttentionTelemetry,
} from "../../lib/messaging/attention.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ATTENTION_SRC = path.resolve(__dirname, "../../lib/messaging/attention.js");
const CORPUS_PATH = path.join(__dirname, "fixtures", "n8-attention-corpus.json");

const CORPUS = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
const NOW = CORPUS.meta.pinned_now_ts;

// The documented gate floor for the seed corpus (see N8.md GATE).
const P_FLOOR = 0.9;
const R_FLOOR = 0.9;

// Minimal valid-ish envelope builder for the unit tests (not routed through the
// N1 validator on purpose; N8 must be total over the looser input domain).
let _mid = 0;
function env({
  thread_id = "t1",
  thread_type = "dm",
  is_from_me = false,
  content = "hi",
  ts,
  sender_id,
  mention_me = false,
  reply_to_me = false,
  addressed_to_me = false,
  reply_to_available = true,
  structured_mentions = true,
  self_identity_reliable = true,
  addressing_first_class = false,
} = {}) {
  _mid += 1;
  return {
    platform: "source_x",
    thread_id,
    thread_type,
    sender: { id: is_from_me ? "user" : (sender_id || `peer_${thread_id}`), name: null },
    recipients: ["user"],
    is_from_me,
    ts: typeof ts === "number" ? ts : 1700000000000 + _mid * 60000,
    content,
    mentions: [],
    directed_at_me_signals: { mention_me, reply_to_me, addressed_to_me },
    capabilities: {
      reply_to_available,
      structured_mentions,
      self_identity_reliable,
      addressing_first_class,
    },
    source_msg_id: `smid_${_mid}`,
  };
}

// Single-record helper: feed one thread's envelopes, get its lone record.
function recordFor(thread) {
  const recs = computeAttention(thread.envelopes, { now: NOW });
  return recs[0];
}

// ---------------------------------------------------------------------------
// T1-T3 — isUnanswered (they-spoke-last detection).
// ---------------------------------------------------------------------------
test("T1: isUnanswered true when last msg is inbound (they spoke last)", () => {
  const t = [env({ is_from_me: false, ts: 1 }), env({ is_from_me: false, ts: 2 })];
  assert.equal(isUnanswered(t), true);
});

test("T2: isUnanswered false when last msg is_from_me (answered drops)", () => {
  const t = [env({ is_from_me: false, ts: 1 }), env({ is_from_me: true, ts: 2 })];
  assert.equal(isUnanswered(t), false);
});

test("T3: isUnanswered false for an all-mine thread + empty thread", () => {
  const allMine = [env({ is_from_me: true, ts: 1 }), env({ is_from_me: true, ts: 2 })];
  assert.equal(isUnanswered(allMine), false);
  assert.equal(isUnanswered([]), false, "empty thread is defensively answered");
});

// ---------------------------------------------------------------------------
// T4 / T5 — staleness ms exactness + bucket monotonicity.
// ---------------------------------------------------------------------------
test("T4: staleness.ms === now - lastTs exactly (clock injection / determinism)", () => {
  const lastTs = 1700000000000;
  const t = [env({ ts: lastTs - 1000 }), env({ ts: lastTs })];
  const s = staleness(t, lastTs + 5000);
  assert.equal(s.ms, 5000);
});

test("T5: staleness bucket boundaries are monotone (fresh/today/stale/dead)", () => {
  const HOUR = 3600000, DAY = 24 * HOUR, WEEK = 7 * DAY;
  const at = (age) => {
    const lastTs = 1700000000000;
    return staleness([env({ ts: lastTs })], lastTs + age).bucket;
  };
  assert.equal(at(30 * 60 * 1000), "fresh", "<1h => fresh");
  assert.equal(at(HOUR), "today", "=1h boundary => today (next bucket)");
  assert.equal(at(5 * HOUR), "today", "<24h => today");
  assert.equal(at(DAY), "stale", "=24h boundary => stale");
  assert.equal(at(3 * DAY), "stale", "<7d => stale");
  assert.equal(at(WEEK), "dead", "=7d boundary => dead (terminal)");
  assert.equal(at(30 * DAY), "dead", ">7d => dead");
  // Monotonicity: bucket index never decreases as age grows.
  const order = ["fresh", "today", "stale", "dead"];
  const ages = [0, HOUR / 2, HOUR, DAY / 2, DAY, WEEK / 2, WEEK, 30 * DAY];
  let prev = -1;
  for (const a of ages) {
    const idx = order.indexOf(at(a));
    assert.ok(idx >= prev, `bucket index non-decreasing at age ${a} (got ${idx} < ${prev})`);
    prev = idx;
  }
});

// ---------------------------------------------------------------------------
// T6 / T7 — substance discriminator (closer vs substantive).
// ---------------------------------------------------------------------------
test("T6: substanceOfLastInboundRun isCloser=true for closers", () => {
  for (const c of ["thanks!", "ah cool!", "👍", "perfect, thank you", "sounds good", ""]) {
    const t = [env({ is_from_me: true, content: "here", ts: 1 }),
      env({ is_from_me: false, content: c, ts: 2 })];
    const s = substanceOfLastInboundRun(t);
    assert.equal(s.isCloser, true, `"${c}" should be a closer (score ${s.score})`);
  }
});

test("T7: substanceOfLastInboundRun isCloser=false for substantive asks", () => {
  for (const c of [
    "can you send me the q3 deck?",
    "what time tomorrow?",
    "need your sign-off before EOD",
    "the client escalated the billing issue and wants a full breakdown by morning",
  ]) {
    const t = [env({ is_from_me: false, content: c, ts: 1 })];
    const s = substanceOfLastInboundRun(t);
    assert.equal(s.isCloser, false, `"${c}" should be substantive (score ${s.score})`);
  }
});

// ---------------------------------------------------------------------------
// T8 / T9 — the headline gate: negative + positive control from the corpus.
// ---------------------------------------------------------------------------
test("T8: GATE NEGATIVE CONTROL — they-spoke-last + directed + closer -> surface=false", () => {
  const neg = CORPUS.threads.find((t) => t.id === "dm_c2"); // "...ah cool!"
  assert.ok(neg, "dm_c2 negative-control thread present");
  const r = recordFor(neg);
  assert.equal(r.unanswered, true, "they spoke last");
  assert.equal(r.directed, true, "directed (DM)");
  assert.equal(r.substance.isCloser, true, "trailing run is a closer");
  assert.equal(r.surface, false, "CLOSER-only thread must NOT surface");
});

test("T9: GATE POSITIVE CONTROL — they-spoke-last + directed + substantive -> surface=true", () => {
  const pos = CORPUS.threads.find((t) => t.id === "dm_q2"); // "can you send me the q3 deck?"
  assert.ok(pos, "dm_q2 positive-control thread present");
  const r = recordFor(pos);
  assert.equal(r.unanswered, true);
  assert.equal(r.directed, true);
  assert.equal(r.substance.isCloser, false);
  assert.equal(r.surface, true, "substantive ask must surface");
});

test("T8b: closer vs substantive — ONLY content differs, surface flips", () => {
  const base = (content) => [
    env({ thread_id: "x", thread_type: "dm", is_from_me: true, content: "here you go", ts: 1 }),
    env({ thread_id: "x", thread_type: "dm", is_from_me: false, content, ts: 2 }),
  ];
  const closer = computeAttention(base("thanks!"), { now: NOW })[0];
  const ask = computeAttention(base("can you send the file?"), { now: NOW })[0];
  assert.equal(closer.surface, false, "closer tail drops");
  assert.equal(ask.surface, true, "substantive tail surfaces");
});

// ---------------------------------------------------------------------------
// T4b — closer-then-question ordering (last substantive run wins) and the
// reverse (question-then-closer where the closer is genuinely last drops).
// ---------------------------------------------------------------------------
test("T4b: trailing-run extraction respects order (closer-then-question vs reverse)", () => {
  const cq = CORPUS.threads.find((t) => t.id === "dm_cq1"); // thanks! then "actually wait..."
  const qc = CORPUS.threads.find((t) => t.id === "dm_qc1"); // question, mine, then "perfect thanks"
  assert.equal(recordFor(cq).surface, true, "closer-then-question surfaces (last substantive wins)");
  assert.equal(recordFor(qc).surface, false, "question-then-closer drops (closer genuinely last)");
});

// ---------------------------------------------------------------------------
// T10 / T11 — directed gate in groups vs DMs.
// ---------------------------------------------------------------------------
test("T10: directedGate false for an undirected group trailing message", () => {
  const t = [env({
    thread_type: "group",
    is_from_me: false,
    content: "lol that meeting ran long",
    mention_me: false, reply_to_me: false, addressed_to_me: false,
    addressing_first_class: false,
  })];
  assert.equal(directedGate(t), false);
});

test("T11: directedGate true for a 1:1 DM trailing message regardless of mention", () => {
  const t = [env({ thread_type: "dm", is_from_me: false, content: "hey", mention_me: false })];
  assert.equal(directedGate(t), true, "DM prior makes direction structural");
});

// ---------------------------------------------------------------------------
// T12 — mutation guard (Thesis #1: inputs never mutated).
// ---------------------------------------------------------------------------
test("T12: computeAttention does not mutate input envelopes", () => {
  const all = [];
  for (const t of CORPUS.threads) for (const e of t.envelopes) all.push(e);
  const snapshot = JSON.parse(JSON.stringify(all));
  computeAttention(all, { now: NOW });
  assert.deepEqual(all, snapshot, "input fixtures unchanged after computeAttention");
});

// ---------------------------------------------------------------------------
// T13 — N7 soft-edge: identity stub keeps DMs separate; a cross-platform
// resolver merges two senders into one person -> dedups two DM threads into one.
// ---------------------------------------------------------------------------
test("T13: N7 soft-edge — identity stub separates, cross-platform resolver dedups", () => {
  // Two DM threads on two different platforms with the SAME person behind them.
  const a = env({ thread_id: "wa-thread", thread_type: "dm", is_from_me: false, sender_id: "personA@platA", content: "can you call me?", ts: 10 });
  const b = env({ thread_id: "tg-thread", thread_type: "dm", is_from_me: false, sender_id: "personA_platB", content: "are you free later?", ts: 20 });

  // Identity stub (default): distinct sender ids -> two separate threads.
  const idGroups = groupThreads([a, b], {}); // default resolvePerson = s => s.id
  assert.equal(idGroups.size, 2, "identity stub keeps the two DMs separate");

  // Cross-platform resolver: both ids map to ONE canonical person.
  const merge = (s) => (s.id === "personA@platA" || s.id === "personA_platB" ? "person_A" : s.id);
  const mergedGroups = groupThreads([a, b], { resolvePerson: merge });
  assert.equal(mergedGroups.size, 1, "cross-platform resolver dedups into one thread");

  // And the merged record is a single coherent thread.
  const recs = computeAttention([a, b], { now: NOW, resolvePerson: merge });
  assert.equal(recs.length, 1, "one merged AttentionRecord");
  assert.equal(recs[0].person_id, "person_A");

  // Soft-edge robustness: a resolver that throws never crashes N8.
  const boom = () => { throw new Error("resolver exploded"); };
  assert.doesNotThrow(() => computeAttention([a, b], { now: NOW, resolvePerson: boom }));
});

// ---------------------------------------------------------------------------
// T14 — platform-token grep over attention.js === 0 (abstraction invariant).
// ---------------------------------------------------------------------------
test("T14: attention.js contains ZERO platform tokens (agnosticism gate)", () => {
  const src = readFileSync(ATTENTION_SRC, "utf8");
  const re = /whatsapp|imessage|telegram|gmail|\bjid\b|chat_guid|@g\.us|@s\.whatsapp|@lid|s\.whatsapp|cache_roomnames/gi;
  const matches = src.match(re) || [];
  assert.equal(matches.length, 0, `attention.js must carry no platform token; found: ${JSON.stringify(matches)}`);
  // No adapter/connector import either.
  assert.equal(/from\s+['"][^'"]*adapters[^'"]*['"]/i.test(src), false, "no adapters import");
  assert.equal(/from\s+['"][^'"]*connectors[^'"]*['"]/i.test(src), false, "no connectors import");
});

// ---------------------------------------------------------------------------
// T15 — precision/recall over the labeled corpus meet the documented floor.
// ---------------------------------------------------------------------------
test("T15: precision/recall over the labeled corpus meet the gate floor", () => {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const t of CORPUS.threads) {
    const r = recordFor(t);
    const got = r.surface, exp = t.label.expect_surface;
    if (got && exp) tp += 1;
    else if (got && !exp) fp += 1;
    else if (!got && exp) fn += 1;
    else tn += 1;
  }
  const P = tp / (tp + fp || 1);
  const R = tp / (tp + fn || 1);
  assert.ok(CORPUS.meta.count >= 40, `corpus must be >=40 threads (got ${CORPUS.meta.count})`);
  assert.ok(P >= P_FLOOR, `precision ${P.toFixed(4)} >= ${P_FLOOR}`);
  assert.ok(R >= R_FLOOR, `recall ${R.toFixed(4)} >= ${R_FLOOR}`);
});

// ---------------------------------------------------------------------------
// T15b — every sub-label (unanswered/directed/closer) matches the engine, so
// the corpus is a faithful labeled ground truth (not just surface-coincidence).
// ---------------------------------------------------------------------------
test("T15b: every corpus sub-label matches the engine", () => {
  for (const t of CORPUS.threads) {
    const r = recordFor(t);
    assert.equal(r.unanswered, t.label.expect_unanswered, `${t.id} unanswered`);
    assert.equal(r.directed, t.label.expect_directed, `${t.id} directed`);
    assert.equal(r.substance.isCloser, t.label.expect_closer, `${t.id} closer`);
  }
});

// ---------------------------------------------------------------------------
// T16 — determinism: byte-identical JSON across two pinned-now runs.
// ---------------------------------------------------------------------------
test("T16: determinism — pinned now yields byte-identical AttentionRecord[] JSON", () => {
  const all = [];
  for (const t of CORPUS.threads) for (const e of t.envelopes) all.push(e);
  const j1 = JSON.stringify(computeAttention(all, { now: NOW }));
  const j2 = JSON.stringify(computeAttention(all, { now: NOW }));
  assert.equal(j1, j2);
});

// ---------------------------------------------------------------------------
// T17 — defensive contract: TypeError on non-array; malformed rows skipped+counted.
// ---------------------------------------------------------------------------
test("T17: throws TypeError on non-array; skips and counts malformed envelopes", () => {
  assert.throws(() => computeAttention(null), TypeError);
  assert.throws(() => computeAttention("nope"), TypeError);
  resetAttentionTelemetry();
  const good = env({ is_from_me: false, content: "can you review this?" });
  const malformed = [
    null,
    42,
    { thread_id: "" }, // empty thread_id
    { thread_id: "t", ts: "not-int", sender: { id: "x" } }, // bad ts
    { thread_id: "t", ts: 1700000000000, sender: {} }, // no sender.id
  ];
  const recs = computeAttention([good, ...malformed], { now: NOW });
  assert.equal(recs.length, 1, "only the well-formed envelope produces a record");
  const tel = getAttentionTelemetry();
  assert.equal(tel.skipped, malformed.length, "all malformed envelopes counted as skipped");
  resetAttentionTelemetry();
});

// ---------------------------------------------------------------------------
// T18 — degenerate threads never crash (empty content, all-mine, empty group).
// ---------------------------------------------------------------------------
test("T18: degenerate threads are total (no throw / NaN)", () => {
  // all-mine thread -> not unanswered, never surfaces.
  const allMine = computeAttention([
    env({ thread_id: "m", thread_type: "dm", is_from_me: true, content: "hello?", ts: 1 }),
  ], { now: NOW })[0];
  assert.equal(allMine.unanswered, false);
  assert.equal(allMine.surface, false);
  assert.ok(Number.isFinite(allMine.staleness.ms));

  // empty-content trailing inbound -> treated as closer, not a crash.
  const emptyTail = computeAttention([
    env({ thread_id: "e", thread_type: "dm", is_from_me: true, content: "here", ts: 1 }),
    env({ thread_id: "e", thread_type: "dm", is_from_me: false, content: "", ts: 2 }),
  ], { now: NOW })[0];
  assert.equal(emptyTail.substance.isCloser, true);
  assert.equal(emptyTail.surface, false);
});

// ---------------------------------------------------------------------------
// T19 — record shape conformance + model_version stamp.
// ---------------------------------------------------------------------------
test("T19: AttentionRecord carries the documented shape + model_version", () => {
  const r = recordFor(CORPUS.threads.find((t) => t.id === "dm_q1"));
  for (const k of [
    "thread_key", "thread_id", "thread_type", "person_id", "unanswered",
    "directed", "staleness", "substance", "surface", "last_ts", "last_sender",
    "n_inbound_trailing", "source_msg_ids",
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, k), `record has key ${k}`);
  }
  assert.equal(r.model_version, MODEL_VERSION);
  assert.equal(typeof r.surface, "boolean");
  assert.equal(typeof r.staleness.ms, "number");
  assert.ok(Array.isArray(r.source_msg_ids));
  assert.ok(ATTENTION_CAPS.SUBSTANCE_FLOOR >= 0 && ATTENTION_CAPS.SUBSTANCE_FLOOR <= 1);
});
