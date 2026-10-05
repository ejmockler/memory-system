// p2-reciprocity.test.mjs — WORKUNIT P2: reciprocity, the FIRST PERSONA ATTRIBUTE.
//
// A relationship is TWO-WAY. reciprocity(thread) = have you EVER reciprocated —
// any outbound (is_from_me === true) from you to them. It is (1) the first persona
// attribute (existence + strength + recency of a relationship) AND (2) the
// behavioral signal that catches spam-that-looks-human (gibberish-domain emails,
// notification senders that are structurally person-shaped) which P1's STRUCTURAL
// gate cannot. CONSERVATIVE: reciprocity is a SOFT RANK signal — zero-reciprocity
// threads DOWN-RANK; they are NEVER hard-dropped. A genuine brand-new contact (0
// reciprocity, first message) still appears, just lower. NEVER drop a human.
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions. Hermetic: NO
// network, NO DB, NO filesystem writes. Reads only the L4/L5 source bytes (for the
// 0-platform-token grep gate) and runs the pure engines over hand-built rows.
//
// What this proves (mapped to the P2 GATE + WORKUNIT):
//   - reciprocity counts (outbound/inbound/turns/last_outbound_ts) correct on
//     fixtures; reciprocated true iff >=1 outbound ever.
//   - A RECIPROCATED thread out-ranks an equal-recency 0-reciprocity thread.
//   - A 0-reciprocity GENUINE (real new human) thread is NOT dropped — still in
//     output, just lower (NEVER drop a human).
//   - A 0-reciprocity SPAM-shaped thread sinks below reciprocated real people.
//   - CAPS floor honored: factor 1 when reciprocated, floor when not; an explicit
//     floor of 1 disables the down-rank (back-compat / pure rank).
//   - reciprocity is surfaced on the row (the first persona attribute).
//   - ZERO platform tokens in L4/L5 (the abstraction invariant holds).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  computeAttention,
  reciprocityOfThread,
  groupThreads,
} from "../../lib/messaging/attention.js";

import {
  buildCatchup,
  buildAdapterRegistry,
  reciprocityFactor,
  reciprocityStrength,
  recencyFactor,
  stalenessFactor,
  rankScore,
  CATCHUP_CAPS,
} from "../../lib/messaging/catchup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(__dirname, "../../lib/messaging");

// ---------------------------------------------------------------------------
// Fixtures. Minimal N1-shaped envelopes; DM threads. A DM trailing inbound run
// is structurally directed (DM prior >= the attention threshold), so a substantive
// inbound that they-spoke-last surfaces in catch-up. We pin `now` so staleness /
// recency are deterministic.
// ---------------------------------------------------------------------------
const NOW = 1700010000000;
let _mid = 0;
function env({ thread_id, platform = "source_a", is_from_me = false, content = "hi", ts, sender_id, sender_name = null }) {
  _mid += 1;
  return {
    platform,
    thread_id,
    thread_type: "dm",
    sender: { id: is_from_me ? "user" : (sender_id || `peer_${thread_id}`), name: is_from_me ? null : sender_name },
    recipients: ["user"],
    is_from_me,
    ts: typeof ts === "number" ? ts : NOW - 60 * 60 * 1000 + _mid * 1000,
    content,
    mentions: [],
    directed_at_me_signals: { mention_me: false, reply_to_me: false, addressed_to_me: false },
    capabilities: { reply_to_available: true, structured_mentions: true, self_identity_reliable: true, addressing_first_class: false },
    source_msg_id: `${platform}:${thread_id}:${_mid}`,
  };
}

// A FIXTURE adapter registry whose rows are ALREADY N1 envelopes (identity mapper).
function fixtureRegistry(platforms) {
  return buildAdapterRegistry(platforms.map((p) => ({ PLATFORM: p, _toEnvelope: (row) => row })));
}

// ---------------------------------------------------------------------------
// 1. reciprocityOfThread — the counts are correct.
// ---------------------------------------------------------------------------

test("P2: reciprocityOfThread counts outbound/inbound/turns and reciprocated flag", () => {
  // A real back-and-forth: in, out, in, out, in (they spoke last).
  const t = [
    env({ thread_id: "t", is_from_me: false, content: "hey are you around?", ts: NOW - 5000 }),
    env({ thread_id: "t", is_from_me: true, content: "yeah what's up", ts: NOW - 4000 }),
    env({ thread_id: "t", is_from_me: false, content: "can you review the deck?", ts: NOW - 3000 }),
    env({ thread_id: "t", is_from_me: true, content: "on it", ts: NOW - 2000 }),
    env({ thread_id: "t", is_from_me: false, content: "thanks, also what time tomorrow?", ts: NOW - 1000 }),
  ];
  const r = reciprocityOfThread(t);
  assert.equal(r.reciprocated, true, "reciprocated: >=1 outbound");
  assert.equal(r.outbound_count, 2, "two outbound");
  assert.equal(r.inbound_count, 3, "three inbound");
  // transitions: in->out, out->in, in->out, out->in = 4 turns.
  assert.equal(r.turn_count, 4, "four direction transitions");
  assert.equal(r.last_outbound_ts, NOW - 2000, "last_outbound_ts is the most-recent outbound ts");
});

test("P2: reciprocityOfThread on a PURE INBOUND monologue is zero-reciprocity, zero turns", () => {
  // A one-directional channel: they spoke 3x, you NEVER replied (spam-shaped).
  const t = [
    env({ thread_id: "s", is_from_me: false, content: "exclusive offer just for you", ts: NOW - 3000 }),
    env({ thread_id: "s", is_from_me: false, content: "limited time act now", ts: NOW - 2000 }),
    env({ thread_id: "s", is_from_me: false, content: "did you see my last message?", ts: NOW - 1000 }),
  ];
  const r = reciprocityOfThread(t);
  assert.equal(r.reciprocated, false, "never replied => not reciprocated");
  assert.equal(r.outbound_count, 0, "zero outbound");
  assert.equal(r.inbound_count, 3, "three inbound");
  assert.equal(r.turn_count, 0, "a monologue has zero turns");
  assert.equal(r.last_outbound_ts, null, "no outbound => null last_outbound_ts");
});

test("P2: reciprocityOfThread is total over degenerate input (empty / non-array)", () => {
  const z = reciprocityOfThread([]);
  assert.deepEqual(z, { reciprocated: false, outbound_count: 0, inbound_count: 0, turn_count: 0, last_outbound_ts: null });
  const z2 = reciprocityOfThread(null);
  assert.equal(z2.reciprocated, false, "null input is total, not thrown");
});

// ---------------------------------------------------------------------------
// 2. computeAttention attaches reciprocity to the AttentionRecord.
// ---------------------------------------------------------------------------

test("P2: computeAttention attaches a reciprocity block to each AttentionRecord", () => {
  const recip = [
    env({ thread_id: "rt", is_from_me: false, content: "hey", ts: NOW - 4000 }),
    env({ thread_id: "rt", is_from_me: true, content: "hi back", ts: NOW - 3000 }),
    env({ thread_id: "rt", is_from_me: false, content: "can you send the q3 deck?", ts: NOW - 1000 }),
  ];
  const cold = [
    env({ thread_id: "ct", is_from_me: false, content: "can you send the q3 deck?", ts: NOW - 1000 }),
  ];
  const records = computeAttention([...recip, ...cold], { now: NOW });
  const r = records.find((x) => x.thread_id === "rt");
  const c = records.find((x) => x.thread_id === "ct");
  assert.ok(r && r.reciprocity, "reciprocated record carries a reciprocity block");
  assert.equal(r.reciprocity.reciprocated, true, "rt reciprocated");
  assert.equal(r.reciprocity.outbound_count, 1, "rt one outbound");
  assert.ok(c && c.reciprocity, "cold record carries a reciprocity block");
  assert.equal(c.reciprocity.reciprocated, false, "ct never reciprocated");
  assert.equal(c.reciprocity.outbound_count, 0, "ct zero outbound");
});

// ---------------------------------------------------------------------------
// 3. reciprocityFactor — the SOFT down-rank multiplier; CAPS floor honored.
// ---------------------------------------------------------------------------

test("P2: reciprocityFactor is 1 when reciprocated, the CAPS floor when not", () => {
  assert.equal(reciprocityFactor(true), 1, "reciprocated => full weight 1");
  assert.equal(reciprocityFactor(false), CATCHUP_CAPS.RECIPROCITY_FLOOR, "not reciprocated => CAPS floor");
  assert.ok(CATCHUP_CAPS.RECIPROCITY_FLOOR > 0 && CATCHUP_CAPS.RECIPROCITY_FLOOR < 1, "floor is a soft (0,1) down-rank, never 0");
});

test("P2: reciprocityFactor honors a per-call floor; floor>=1 disables the down-rank", () => {
  assert.equal(reciprocityFactor(false, 0.5), 0.5, "explicit floor honored");
  assert.equal(reciprocityFactor(false, 1), 1, "floor of 1 disables the down-rank (pure rank)");
  assert.equal(reciprocityFactor(false, 2), 1, "floor clamps to 1");
  assert.equal(reciprocityFactor(false, -1), 0, "negative floor clamps to 0 (still never DROPS the row)");
});

test("P2: rankScore folds reciprocity in — a reciprocated thread out-scores an identical 0-reciprocity one", () => {
  const base = { lastInboundTs: NOW - 1000, directed: 0.9, ageMs: 1000, now: NOW };
  const sRecip = rankScore({ ...base, reciprocated: true });
  const sCold = rankScore({ ...base, reciprocated: false });
  assert.ok(sRecip > sCold, `reciprocated (${sRecip}) > zero-reciprocity (${sCold}) at equal recency and directedness (e17: staleness is no longer a term)`);
  assert.equal(sCold, sRecip * CATCHUP_CAPS.RECIPROCITY_FLOOR, "the only difference is the reciprocity factor");
});

// ---------------------------------------------------------------------------
// 4. END-TO-END through buildCatchup: a reciprocated real person OUT-RANKS an
//    equal-recency spam-shaped 0-reciprocity sender; the spam sinks but is NOT
//    dropped; a genuine new 0-reciprocity human still appears.
// ---------------------------------------------------------------------------

function spamAndReciprocatedSources() {
  // Reciprocated real person: a DEEP two-way history (turns >= TURN_RELATIONSHIP),
  // they spoke last (substantive). P2-REFINE grades this to full weight: an
  // established back-and-forth relationship, not a one-reply edge.
  const realPerson = [
    env({ thread_id: "dm_real", platform: "source_a", sender_id: "+15551112222", sender_name: "Alex Example", is_from_me: false, content: "morning!", ts: NOW - 16000 }),
    env({ thread_id: "dm_real", platform: "source_a", is_from_me: true, content: "morning, what's up", ts: NOW - 15000 }),
    env({ thread_id: "dm_real", platform: "source_a", sender_id: "+15551112222", sender_name: "Alex Example", is_from_me: false, content: "did you see the email?", ts: NOW - 14000 }),
    env({ thread_id: "dm_real", platform: "source_a", is_from_me: true, content: "yeah, replying now", ts: NOW - 13000 }),
    env({ thread_id: "dm_real", platform: "source_a", sender_id: "+15551112222", sender_name: "Alex Example", is_from_me: false, content: "great, thanks", ts: NOW - 12000 }),
    env({ thread_id: "dm_real", platform: "source_a", is_from_me: true, content: "np", ts: NOW - 11000 }),
    env({ thread_id: "dm_real", platform: "source_a", sender_id: "+15551112222", sender_name: "Alex Example", is_from_me: false, content: "can you review the q3 deck today?", ts: NOW - 1000 }),
  ];
  // Spam-shaped 0-reciprocity sender: structurally person-shaped (a real email),
  // they spoke last, substantive-looking ASK, but you NEVER replied. P1's
  // structural gate cannot catch this (it IS a valid email); P2 sinks it.
  const spam = [
    env({ thread_id: "dm_spam", platform: "source_a", sender_id: "pat.sample1854@example.com", sender_name: "Pat", is_from_me: false, content: "can you confirm your account details please?", ts: NOW - 1000 }),
  ];
  return { source_a: [...realPerson, ...spam] };
}

test("P2 (end-to-end): a reciprocated real person OUT-RANKS an equal-recency spam-shaped 0-reciprocity sender", async () => {
  const res = await buildCatchup({
    sources: spamAndReciprocatedSources(),
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0.3,
  });
  const real = res.rows.find((r) => r.thread_id === "dm_real");
  const spam = res.rows.find((r) => r.thread_id === "dm_spam");
  assert.ok(real, "the reciprocated real person surfaces");
  assert.ok(spam, "the spam-shaped 0-reciprocity sender STILL surfaces (NEVER hard-dropped)");
  assert.ok(real.score > spam.score, `real (${real.score}) out-ranks spam (${spam.score})`);
  // The real person ranks ABOVE the spam in the emitted order.
  const realIdx = res.rows.findIndex((r) => r.thread_id === "dm_real");
  const spamIdx = res.rows.findIndex((r) => r.thread_id === "dm_spam");
  assert.ok(realIdx < spamIdx, "real person appears before the spam row in the ranked output");
});

test("P2 (end-to-end): reciprocity is surfaced on each row (the first persona attribute)", async () => {
  const res = await buildCatchup({
    sources: spamAndReciprocatedSources(),
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0.3,
  });
  const real = res.rows.find((r) => r.thread_id === "dm_real");
  const spam = res.rows.find((r) => r.thread_id === "dm_spam");
  assert.ok(real.reciprocity && real.reciprocity.reciprocated === true, "real person row: reciprocated true");
  assert.ok(real.reasons.includes("reciprocated"), "real person reason includes 'reciprocated'");
  assert.equal(real.reciprocity.outbound_count, 3, "real person has 3 outbound on the row (deep history)");
  assert.equal(real.reciprocity.turn_count, 6, "real person has 6 turns (deep back-and-forth)");
  assert.ok(spam.reciprocity && spam.reciprocity.reciprocated === false, "spam row: reciprocated false");
  assert.ok(spam.reasons.includes("no_reciprocity"), "spam reason includes 'no_reciprocity'");
});

test("P2 (end-to-end): a GENUINE brand-new 0-reciprocity human is NOT dropped — still in output, lower", async () => {
  // ONLY a genuine new first-contact (0 reciprocity, real human, substantive ask).
  // With no reciprocated thread to out-rank it, it MUST still appear (never drop a human).
  const sources = {
    source_a: [
      env({ thread_id: "dm_new", platform: "source_a", sender_id: "+15559998888", sender_name: "Sam (new)", is_from_me: false, content: "hi, a mutual friend suggested I reach out — can we chat about the project?", ts: NOW - 1000 }),
    ],
  };
  const res = await buildCatchup({ sources, now: NOW, registry: fixtureRegistry(["source_a"]), min_score: 0.3 });
  const newRow = res.rows.find((r) => r.thread_id === "dm_new");
  assert.ok(newRow, "the genuine new human STILL appears (0-reciprocity is a down-rank, NOT a drop)");
  assert.equal(newRow.reciprocity.reciprocated, false, "flagged reciprocated=false ('new')");
  assert.ok(newRow.score > 0, "down-ranked but a positive, real score — present in the list");
});

test("P2: reciprocity_floor of 1 disables the down-rank (back-compat / pure rank order)", async () => {
  const sources = spamAndReciprocatedSources();
  const withFloor = await buildCatchup({ sources, now: NOW, registry: fixtureRegistry(["source_a"]), min_score: 0.3 });
  const noFloor = await buildCatchup({ sources, now: NOW, registry: fixtureRegistry(["source_a"]), min_score: 0.3, reciprocity_floor: 1 });
  const spamWith = withFloor.rows.find((r) => r.thread_id === "dm_spam");
  const spamNo = noFloor.rows.find((r) => r.thread_id === "dm_spam");
  assert.ok(spamWith && spamNo, "spam row present in both modes (never dropped either way)");
  assert.ok(spamNo.score > spamWith.score, `floor=1 lifts the 0-reciprocity score (${spamNo.score}) above the down-ranked one (${spamWith.score})`);
});

// ---------------------------------------------------------------------------
// 5. ABSTRACTION INVARIANT — the P2 changes add ZERO platform tokens to L4/L5.
// ---------------------------------------------------------------------------

test("P2: attention.js + catchup.js carry ZERO platform tokens after the reciprocity layer", () => {
  // The P2 diff touches ONLY L4 (attention.js) + L5 (catchup.js); assert those
  // stay token-free. (identity.js's `ids.imessage_handles` is a word-bounded seam
  // field explicitly whitelisted by the canonical n10 grep gate — NOT a leak — so
  // it is out of scope for THIS work unit's added-token check.)
  const files = ["attention.js", "catchup.js"].map((f) => path.join(LIB_DIR, f));
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");
    for (const tok of ["imessage", "telegram", "whatsapp", "\"mail\"", "'mail'", "rbm.goog", "urn:biz"]) {
      assert.equal(
        code.toLowerCase().includes(tok.toLowerCase()),
        false,
        `${path.basename(file)} must not contain the platform/structural token ${tok}`,
      );
    }
  }
});

test("P2: computeAttention is pure — inputs not mutated by the reciprocity computation", () => {
  const rows = [
    env({ thread_id: "p", is_from_me: false, content: "hi", ts: NOW - 2000 }),
    env({ thread_id: "p", is_from_me: true, content: "hey", ts: NOW - 1000 }),
  ];
  const snapshot = JSON.parse(JSON.stringify(rows));
  computeAttention(rows, { now: NOW });
  assert.deepEqual(rows, snapshot, "input envelopes are not mutated (Thesis #1 read-only)");
});

// ===========================================================================
// P2-REFINE — GRADED reciprocity (relationship STRENGTH, not binary "ever replied").
//
// The binary factor was gamed by A2P marketing: one outbound "STOP" against 45
// inbound (turns=1) flipped reciprocated=true and TOPPED the list. reciprocityStrength
// grades the COUNTS: turn_count is the PRIMARY signal (a friend turns=174 vs marketing
// turns=1); at LOW turns, INBOUND VOLUME discriminates a BROADCAST (high inbound,
// outbound<=1 -> floor) from a genuine NEW CONTACT (low inbound, just arrived ->
// neutral, SURVIVES). The factor is in [BROADCAST_FLOOR, RELATIONSHIP_MAX], CAPS-
// tunable, MONOTONE in turns, and SOFT (never a hard drop).
// ===========================================================================

test("P2r: A2P marketing (out=1, in=45, turns=1) grades to the BROADCAST_FLOOR (sinks)", () => {
  const f = reciprocityStrength({ turn_count: 1, outbound_count: 1, inbound_count: 45 });
  assert.equal(f, CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR, "the A2P broadcast pattern is pinned to the broadcast floor");
  assert.ok(f < CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL, "broadcast floor is STRICTLY below the new-contact neutral (a marketing channel ranks below a fresh human)");
});

test("P2r: a real friend (turns=174, balanced) grades to RELATIONSHIP_MAX (full weight)", () => {
  const f = reciprocityStrength({ turn_count: 174, outbound_count: 213, inbound_count: 144 });
  assert.equal(f, CATCHUP_CAPS.RECIPROCITY_RELATIONSHIP_MAX, "a deep two-way history earns full weight");
});

test("P2r: a turn_count >= TURN_RELATIONSHIP saturates at RELATIONSHIP_MAX", () => {
  const at = reciprocityStrength({ turn_count: CATCHUP_CAPS.RECIPROCITY_TURN_RELATIONSHIP, outbound_count: 3, inbound_count: 4 });
  const above = reciprocityStrength({ turn_count: CATCHUP_CAPS.RECIPROCITY_TURN_RELATIONSHIP + 50, outbound_count: 30, inbound_count: 30 });
  assert.equal(at, CATCHUP_CAPS.RECIPROCITY_RELATIONSHIP_MAX, "at the relationship threshold => full weight");
  assert.equal(above, CATCHUP_CAPS.RECIPROCITY_RELATIONSHIP_MAX, "above the threshold stays at full weight (saturated)");
});

test("P2r: a genuine NEW CONTACT (out=0, in=1, turns=0) grades to NEW_CONTACT_NEUTRAL (survives, NOT the broadcast floor)", () => {
  const f = reciprocityStrength({ turn_count: 0, outbound_count: 0, inbound_count: 1 });
  assert.equal(f, CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL, "a just-arrived first-contact human is conservatively neutral");
  assert.notEqual(f, CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR, "a new contact is NOT treated as a broadcast (never confuse a human with marketing)");
  assert.ok(f > CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR, "new-contact neutral is strictly above the broadcast floor");
});

test("P2r: spam-shaped first-contact (out=0, in=1, turns=0) SURVIVES-but-low (below reciprocated real people)", () => {
  // By reciprocity counts ALONE a first-contact spam is indistinguishable from a
  // genuine new contact (both out=0/in=1/turns=0) — CONSERVATIVE: both get neutral
  // and SURVIVE (the structural spam gate is P1's job). It is still strictly below
  // a deep relationship's full weight, so reciprocated real people out-rank it.
  const spam = reciprocityStrength({ turn_count: 0, outbound_count: 0, inbound_count: 1 });
  const friend = reciprocityStrength({ turn_count: 174, outbound_count: 213, inbound_count: 144 });
  assert.ok(spam > CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR, "first-contact spam survives above the broadcast floor (never drop a possible human)");
  assert.ok(spam < friend, "but it stays BELOW a reciprocated real relationship");
});

test("P2r: the broadcast pattern needs HIGH inbound — a low-volume monologue is NOT pinned to the floor", () => {
  const broadcast = reciprocityStrength({ turn_count: 1, outbound_count: 1, inbound_count: CATCHUP_CAPS.RECIPROCITY_BROADCAST_INBOUND_MIN });
  const lowVol = reciprocityStrength({ turn_count: 0, outbound_count: 0, inbound_count: 2 });
  assert.equal(broadcast, CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR, "inbound at the broadcast threshold => floor");
  assert.ok(lowVol > CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR, "a low-volume (in=2) thread is above the floor");
});

test("P2r: reciprocityStrength is MONOTONE non-decreasing in turn_count (balanced thread)", () => {
  let prev = -Infinity;
  for (const t of [0, 1, 2, 3, 4, 5, 6, 7, 10, 50, 174]) {
    const f = reciprocityStrength({ turn_count: t, outbound_count: Math.max(1, Math.ceil(t / 2)), inbound_count: Math.max(1, Math.ceil(t / 2)) });
    assert.ok(f >= prev - 1e-12, `factor at turns=${t} (${f}) is >= the previous (${prev}) — monotone in turns`);
    prev = f;
  }
});

test("P2r: in the graded middle (turns==0 monologue), factor is MONOTONE non-increasing in inbound volume", () => {
  // A growing one-directional run (turns 0, no outbound) trends DOWN toward the
  // broadcast floor as inbound volume climbs from the new-contact band to the edge.
  let prev = Infinity;
  for (const inb of [3, 4, 5, 6, 10]) {
    const f = reciprocityStrength({ turn_count: 0, outbound_count: 0, inbound_count: inb });
    assert.ok(f <= prev + 1e-12, `factor at in=${inb} (${f}) is <= the previous (${prev}) — higher volume sinks toward the floor`);
    prev = f;
  }
});

test("P2r: the factor is bounded in [BROADCAST_FLOOR, RELATIONSHIP_MAX] across a wide grid", () => {
  const F = CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR;
  const M = CATCHUP_CAPS.RECIPROCITY_RELATIONSHIP_MAX;
  for (const turns of [0, 1, 2, 5, 10, 200]) {
    for (const out of [0, 1, 5, 100]) {
      for (const inb of [0, 1, 3, 45, 500]) {
        const f = reciprocityStrength({ turn_count: turns, outbound_count: out, inbound_count: inb });
        assert.ok(f >= F - 1e-12 && f <= M + 1e-12, `factor for (t=${turns},o=${out},i=${inb}) = ${f} stays in [${F},${M}]`);
      }
    }
  }
});

test("P2r: CAPS honored — a per-call broadcast floor overrides; floor>=1 disables (pure rank)", () => {
  const a2p = { turn_count: 1, outbound_count: 1, inbound_count: 45 };
  assert.equal(reciprocityStrength(a2p, 0.1), 0.1, "per-call broadcast floor honored for the A2P case");
  assert.equal(reciprocityStrength(a2p, 1), CATCHUP_CAPS.RECIPROCITY_RELATIONSHIP_MAX, "floor of 1 disables the down-rank (every thread full weight)");
  assert.equal(reciprocityStrength(a2p, 2), CATCHUP_CAPS.RECIPROCITY_RELATIONSHIP_MAX, "floor clamps above 1 -> full weight");
  assert.equal(reciprocityStrength({ turn_count: 0, outbound_count: 0, inbound_count: 1 }, -1), CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL, "a negative floor clamps to 0 but a new contact is still neutral (never punished)");
});

test("P2r: reciprocityStrength is TOTAL over degenerate input (null / missing counts => new-contact neutral)", () => {
  assert.equal(reciprocityStrength(null), CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL, "null block => conservative new-contact neutral, not thrown");
  assert.equal(reciprocityStrength({}), CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL, "empty block => new-contact neutral");
  assert.equal(reciprocityStrength({ turn_count: "x", outbound_count: NaN, inbound_count: undefined }), CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL, "malformed counts => neutral");
});

test("P2r: rankScore folds the GRADED strength — A2P broadcast scores BELOW a deep relationship at equal recency and directedness", () => {
  const base = { lastInboundTs: NOW - 1000, directed: 0.9, ageMs: 1000, now: NOW };
  const friend = rankScore({ ...base, reciprocity: { turn_count: 174, outbound_count: 213, inbound_count: 144 } });
  const a2p = rankScore({ ...base, reciprocity: { turn_count: 1, outbound_count: 1, inbound_count: 45 } });
  const newContact = rankScore({ ...base, reciprocity: { turn_count: 0, outbound_count: 0, inbound_count: 1 } });
  assert.ok(friend > a2p, `deep relationship (${friend}) out-scores A2P broadcast (${a2p})`);
  assert.ok(newContact > a2p, `a genuine new contact (${newContact}) out-scores the A2P broadcast (${a2p}) — the gamed marketing channel SINKS below a fresh human`);
  assert.ok(friend > newContact, `the deep relationship (${friend}) still tops the new contact (${newContact})`);
});

test("P2r: rankScore back-compat — with NO counts block it falls back to the BINARY reciprocityFactor on the flag", () => {
  // n9-catchup and older callers pass only `reciprocated` (no counts). rankScore
  // must still grade them via the legacy binary factor, unchanged.
  const base = { lastInboundTs: NOW - 1000, directed: 0.9, ageMs: 1000, now: NOW };
  const recip = rankScore({ ...base, reciprocated: true });
  const cold = rankScore({ ...base, reciprocated: false });
  assert.ok(recip > cold, "binary fallback: reciprocated still out-scores zero-reciprocity");
  assert.equal(cold, recip * CATCHUP_CAPS.RECIPROCITY_FLOOR, "the binary fallback uses the legacy RECIPROCITY_FLOOR exactly (no counts => no grading)");
});

test("P2r (end-to-end): an A2P marketing broadcast SINKS below a fresh new contact through buildCatchup", async () => {
  // Hold recency/staleness EQUAL between the two threads (same latest-inbound ts)
  // so the ONLY differing rank factor is graded reciprocity — an honest isolation
  // of the down-rank (reciprocity is a SOFT factor; equalizing the rest lets it
  // decide). A2P's earlier blasts are spread before the shared latest ts.
  const LATEST = NOW - 1000;
  // BROADCAST: one early outbound "STOP", then the channel keeps blasting inbound
  // (out=1, in>=BROADCAST_INBOUND_MIN, turns=1, THEY spoke last). Exactly the gamed
  // A2P/marketing case (out=1, in=45, turns=1) the binary factor mis-ranked to top.
  const broadcast = [];
  broadcast.push(env({ thread_id: "dm_a2p", platform: "source_a", is_from_me: true, content: "STOP", ts: NOW - 50000 }));
  for (let i = 0; i < 8; i++) {
    broadcast.push(env({ thread_id: "dm_a2p", platform: "source_a", sender_id: "+18335550147", sender_name: "DEALS", is_from_me: false, content: `FLASH SALE deal #${i} just for you, act now`, ts: NOW - 9000 + i * 100 }));
  }
  broadcast.push(env({ thread_id: "dm_a2p", platform: "source_a", sender_id: "+18335550147", sender_name: "DEALS", is_from_me: false, content: "FLASH SALE last chance act now", ts: LATEST }));
  // A genuine brand-new contact: first message, real human ask (SAME latest ts).
  const newContact = [
    env({ thread_id: "dm_new", platform: "source_a", sender_id: "+15559998888", sender_name: "Priya (new)", is_from_me: false, content: "hi, a mutual friend suggested I reach out — can we chat about the project?", ts: LATEST }),
  ];
  const res = await buildCatchup({
    sources: { source_a: [...broadcast, ...newContact] },
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0,
    reciprocity_floor: undefined,
  });
  const a2p = res.rows.find((r) => r.thread_id === "dm_a2p");
  const fresh = res.rows.find((r) => r.thread_id === "dm_new");
  assert.ok(a2p, "the A2P broadcast STILL appears (never hard-dropped)");
  assert.ok(fresh, "the genuine new contact appears");
  assert.equal(a2p.reciprocity_strength, CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR, "the A2P broadcast row carries the broadcast-floor strength");
  assert.equal(fresh.reciprocity_strength, CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL, "the new contact row carries the new-contact-neutral strength");
  const a2pIdx = res.rows.findIndex((r) => r.thread_id === "dm_a2p");
  const freshIdx = res.rows.findIndex((r) => r.thread_id === "dm_new");
  assert.ok(freshIdx < a2pIdx, "the fresh human appears ABOVE the A2P marketing broadcast in the ranked output");
});

test("P2r (end-to-end): reciprocity_strength is surfaced on every row (a persona attribute)", async () => {
  const res = await buildCatchup({
    sources: spamAndReciprocatedSources(),
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0.3,
  });
  for (const r of res.rows) {
    assert.equal(typeof r.reciprocity_strength, "number", "every row carries a numeric reciprocity_strength");
    assert.ok(
      r.reciprocity_strength >= CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR - 1e-12 &&
      r.reciprocity_strength <= CATCHUP_CAPS.RECIPROCITY_RELATIONSHIP_MAX + 1e-12,
      "reciprocity_strength is bounded in [BROADCAST_FLOOR, RELATIONSHIP_MAX]",
    );
  }
  const real = res.rows.find((r) => r.thread_id === "dm_real");
  assert.equal(real.reciprocity_strength, CATCHUP_CAPS.RECIPROCITY_RELATIONSHIP_MAX, "the deep-history real person row carries full-weight strength");
});

test("P2r: the new graded CAPS exist and are sanely ordered (floor < neutral <= max)", () => {
  const F = CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR;
  const N = CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL;
  const M = CATCHUP_CAPS.RECIPROCITY_RELATIONSHIP_MAX;
  assert.ok(Number.isFinite(F) && Number.isFinite(N) && Number.isFinite(M), "all three caps are finite numbers");
  assert.ok(F > 0 && F < N, "broadcast floor is a soft (>0) down-rank strictly below the new-contact neutral");
  assert.ok(N <= M && M <= 1, "new-contact neutral <= relationship max <= 1");
  assert.ok(Number.isInteger(CATCHUP_CAPS.RECIPROCITY_TURN_RELATIONSHIP) && CATCHUP_CAPS.RECIPROCITY_TURN_RELATIONSHIP >= 2, "the relationship turn threshold is an integer >= 2");
  assert.ok(CATCHUP_CAPS.RECIPROCITY_BROADCAST_INBOUND_MIN > CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_INBOUND_MAX, "the broadcast inbound threshold is above the new-contact inbound ceiling (a clear gap)");
});

// ===========================================================================
// e7 — THE VOUCH OVERRIDES THE WINDOW.
//
// MEASURED DEFECT (production shape, 396 deduped threads, harness:
// e7-catchup-join-eval.mjs): the operator's father carries
// reciprocity_strength = RECIPROCITY_BROADCAST_FLOOR — the down-rank reserved
// for an A2P/marketing blast — while three retail newsletters carry
// RECIPROCITY_NEW_CONTACT_NEUTRAL. His counts in the loaded window are
// {turn_count:0, outbound_count:0, inbound_count:8, last_outbound_ts:null},
// which are BYTE-IDENTICAL to two unsaved bulk-SMS numbers in the same
// population. reciprocityStrength is a pure function of those counts, so no
// change to it can separate the two — the separating evidence is out-of-band:
// M2's address-book vouch (is_contact), which fires for the father and not for
// the bulk senders.
//
// The fix lives at the ONE seat holding both signals (buildCatchupCore, where
// `enrichment` and the reciprocity block are both in hand): a vouched person's
// per-row floor is raised to CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL — the
// constant the landed seat (`rowReciprocityFloor` in buildCatchupCore) actually
// uses, and the one every assertion below checks. NOT RELATIONSHIP_MAX: the vouch
// is evidence the sender is a real saved human, NOT evidence of measured history,
// so it buys the neutral ("a real human, no measured relationship history yet"),
// never the full-weight relationship value. Because it is applied as a FLOOR
// through reciprocityStrength's own floor parameter, a vouched person who DOES
// have measured history keeps the higher value their counts earned — the lift only
// moves rows the grader put BELOW the neutral (the broadcast and graded-middle
// verdicts), and moves them exactly to the neutral.
//
// F7-2 (the product decision, recorded once at the seat in catchup.js): the vouch
// is deliberately NOT restricted to individuals. An address-book-saved BUSINESS
// (the measured hotel row) is admitted to TIER.RELATIONSHIP by classifyTier's
// is_contact branch, which is the operator's own explicit act; this change does not
// second-guess it, and adds no sender-domain blocklist and no platform branch.
//
// These cases are hermetic: authored envelopes, an INJECTED contact map, an
// injected `now`. No live source, no memory_catchup run, no fixture ledger.
// ===========================================================================

// A group/channel envelope (the p2 `env` helper is DM-only). Group threads are
// NEVER person-merged by groupThreads, which is the property the round-1
// regression cases below pin.
function groupEnv({ thread_id, sender_id, sender_name = null, is_from_me = false, content = "hi", ts, platform = "source_a" }) {
  return { ...env({ thread_id, platform, is_from_me, content, ts, sender_id, sender_name }), thread_type: "group" };
}

// The saved-contact vouch, injected (never the real address book).
const VOUCH_DIGITS = "5551110000";
function vouchedContactMaps() {
  return { phoneToName: new Map([[VOUCH_DIGITS, "Dad"]]), emailToName: new Map() };
}
function vouchAnchor(maps = vouchedContactMaps()) {
  return { contacts: { contactMaps: maps, noMemo: true } };
}

// The measured shapes, at EQUAL recency.
//
// WHY EQUAL RECENCY: the per-factor decomposition (F7-4) shows recencyFactor
// saturates at RECENCY_FLOOR past RECENCY_WINDOW_MS, giving the 34-day-old row a
// ~14x time handicap the reciprocity term's entire dynamic range
// (RELATIONSHIP_MAX / BROADCAST_FLOOR ≈ 3.3x) cannot cover — pinned as an
// executable claim by the F7-4 case at the end of this section. Holding recency
// equal ISOLATES the reciprocity term, which is the factor under test; it is the
// same isolation the A2P end-to-end case above uses. (These fixtures hold the
// latest-inbound ts equal, which before e17 pinned recency AND staleness together
// and since e17 pins the whole time term — the isolation is unchanged, and its
// description no longer names a factor rankScore does not have.)
function vouchedVsNewslettersSources(LATEST) {
  const rows = [];
  // The VOUCHED relationship, in the measured shape: a DM, inbound-only inside the
  // window (turns=0, outbound=0, inbound >= BROADCAST_INBOUND_MIN), they spoke last.
  for (let i = 0; i < CATCHUP_CAPS.RECIPROCITY_BROADCAST_INBOUND_MIN + 3; i++) {
    rows.push(env({
      thread_id: "dm_vouched",
      sender_id: `+1${VOUCH_DIGITS}`,
      sender_name: "Dad",
      is_from_me: false,
      content: `checking in about the weekend plan number ${i}, let me know what works`,
      ts: LATEST - (CATCHUP_CAPS.RECIPROCITY_BROADCAST_INBOUND_MIN + 3 - i) * 1000,
    }));
  }
  rows.push(env({
    thread_id: "dm_vouched",
    sender_id: `+1${VOUCH_DIGITS}`,
    sender_name: "Dad",
    is_from_me: false,
    content: "Here is wishing you a happy birthday today! Time flies.",
    ts: LATEST,
  }));
  // Three bulk senders, in the measured shape: one inbound each (turns=0,
  // inbound < NEW_CONTACT_INBOUND_MAX => the new-contact neutral), SAME latest ts.
  for (const [tid, name, handle] of [
    ["dm_bulk_1", "Sporting Goods", "+18885550001"],
    ["dm_bulk_2", "Home Store", "+18885550002"],
    ["dm_bulk_3", "Morning Digest", "+18885550003"],
  ]) {
    rows.push(env({
      thread_id: tid,
      sender_id: handle,
      sender_name: name,
      is_from_me: false,
      content: "your exclusive offer ends tonight — can you confirm you still want these deals?",
      ts: LATEST,
    }));
  }
  return { source_a: rows };
}

test("e7: the vouched relationship and an unsaved bulk sender are COUNT-IDENTICAL — no pure function of the counts can separate them", () => {
  // The measured exhibit: the father's block and two bulk-SMS numbers in the same
  // 396-thread population all read {t:0, o:0, i:8, last_outbound_ts:null}.
  const measured = { turn_count: 0, outbound_count: 0, inbound_count: 8, last_outbound_ts: null };
  const bulk = { turn_count: 0, outbound_count: 0, inbound_count: 8, last_outbound_ts: null };
  assert.deepEqual(measured, bulk, "the two blocks are identical as DATA");
  assert.equal(
    reciprocityStrength(measured),
    reciprocityStrength(bulk),
    "identical counts => identical strength: the grader cannot distinguish them, so the fix cannot live in the grader",
  );
  assert.equal(
    reciprocityStrength(measured),
    CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR,
    "and the shared verdict is the BROADCAST FLOOR — the marketing down-rank, spent on a relationship",
  );
});

test("e7: gating the broadcast branch on 'no prior reciprocation' would change NOTHING — all measured broadcast rows already have outbound_count 0", () => {
  // Every c-branch row in the measured population had outbound_count === 0 and
  // last_outbound_ts === null, so a predicate keyed on prior reciprocation is
  // vacuous there. Pinned as a property of the grader: at outbound 0 the branch
  // fires on volume alone, which is precisely the case a reciprocation test cannot
  // reach.
  const noReply = { turn_count: 0, outbound_count: 0, inbound_count: CATCHUP_CAPS.RECIPROCITY_BROADCAST_INBOUND_MIN, last_outbound_ts: null };
  assert.equal(reciprocityStrength(noReply), CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR, "the floor is reached with NO prior reciprocation to test");
  // The one shape such a predicate WOULD exempt is the A2P blast it was meant to
  // sink (one "STOP" against a high-volume run) — which must stay at the floor.
  assert.equal(
    reciprocityStrength({ turn_count: 1, outbound_count: 1, inbound_count: 45, last_outbound_ts: NOW - 60 * 24 * 3600 * 1000 }),
    CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR,
    "a non-null last_outbound_ts does NOT lift the A2P blast off the floor",
  );
});

test("e7 (end-to-end): WITHOUT the address book, the relationship scores BELOW all three bulk senders (the defect — and the residual for UNSAVED people)", async () => {
  const LATEST = NOW - 1000;
  const res = await buildCatchup({
    sources: vouchedVsNewslettersSources(LATEST),
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0.3,
  });
  const dad = res.rows.find((r) => r.thread_id === "dm_vouched");
  const bulk = res.rows.filter((r) => r.thread_id.startsWith("dm_bulk_"));
  assert.ok(dad, "the relationship row surfaces");
  assert.equal(bulk.length, 3, "all three bulk senders surface");
  assert.equal(dad.enrichment.is_contact, false, "no address book wired => no vouch");
  assert.equal(dad.reciprocity_strength, CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR, "un-vouched, the relationship carries the MARKETING floor");
  for (const b of bulk) {
    assert.equal(b.reciprocity_strength, CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL, "each bulk sender carries the new-contact neutral");
    assert.ok(dad.score < b.score, `RED: relationship (${dad.score}) scores BELOW bulk sender ${b.thread_id} (${b.score})`);
  }
});

test("e7 (end-to-end): WITH the address-book vouch, the relationship scores ABOVE all three bulk senders (green)", async () => {
  const LATEST = NOW - 1000;
  const res = await buildCatchup({
    sources: vouchedVsNewslettersSources(LATEST),
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0.3,
    anchor: vouchAnchor(),
  });
  const dad = res.rows.find((r) => r.thread_id === "dm_vouched");
  const bulk = res.rows.filter((r) => r.thread_id.startsWith("dm_bulk_"));
  assert.ok(dad, "the relationship row surfaces");
  assert.equal(bulk.length, 3, "all three bulk senders STILL surface (never hard-dropped)");
  assert.equal(dad.enrichment.is_contact, true, "the saved-contact vouch fires");
  assert.equal(
    dad.reciprocity_strength,
    CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL,
    "the vouch raises the floor OFF the marketing floor to the new-contact neutral (a real human, no measured history)",
  );
  assert.ok(dad.anchor_factor > 1, `the M2 anchor also lifts the vouched row (anchor_factor=${dad.anchor_factor})`);
  // The anchor ALONE could not have done this: its lift is smaller than the
  // down-rank the same person was being multiplied by, so the floor change is
  // load-bearing, not cosmetic.
  assert.ok(
    dad.anchor_factor < CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL / CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR,
    `the anchor lift (${dad.anchor_factor}x) is smaller than the broadcast down-rank it had to overcome (${CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL / CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR}x)`,
  );
  for (const b of bulk) {
    assert.equal(b.reciprocity_strength, CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL, "the bulk senders are UNTOUCHED — no vouch, no lift");
    assert.ok(dad.score > b.score, `GREEN: relationship (${dad.score}) now scores ABOVE bulk sender ${b.thread_id} (${b.score})`);
    assert.ok(res.rows.findIndex((r) => r.thread_id === "dm_vouched") < res.rows.findIndex((r) => r.thread_id === b.thread_id), "and appears ABOVE it in the emitted order");
  }
});

test("e7: the lift is MONOTONE UP-RANK ONLY and cannot reach an unvouched row", async () => {
  const LATEST = NOW - 1000;
  const sources = vouchedVsNewslettersSources(LATEST);
  const before = await buildCatchup({ sources, now: NOW, registry: fixtureRegistry(["source_a"]), min_score: 0.3 });
  const after = await buildCatchup({ sources, now: NOW, registry: fixtureRegistry(["source_a"]), min_score: 0.3, anchor: vouchAnchor() });
  assert.equal(before.rows.length, after.rows.length, "same population — nothing dropped, nothing added");
  for (const b of before.rows) {
    const a = after.rows.find((r) => r.thread_id === b.thread_id);
    assert.ok(a, `${b.thread_id} still present`);
    assert.ok(a.reciprocity_strength >= b.reciprocity_strength - 1e-12, `${b.thread_id}: reciprocity_strength never decreases`);
    if (a.enrichment.is_contact !== true) {
      assert.equal(a.reciprocity_strength, b.reciprocity_strength, `${b.thread_id}: an UNVOUCHED row is byte-identical`);
    }
  }
});

test("e7: GATE-OFF byte-identity — with no anchor wired the rows are unchanged by this seam", async () => {
  const sources = spamAndReciprocatedSources();
  const a = await buildCatchup({ sources, now: NOW, registry: fixtureRegistry(["source_a"]), min_score: 0.3 });
  const b = await buildCatchup({ sources, now: NOW, registry: fixtureRegistry(["source_a"]), min_score: 0.3 });
  assert.deepEqual(a.rows, b.rows, "deterministic");
  for (const r of a.rows) {
    assert.equal(r.enrichment.is_contact, false, "the neutral enricher never vouches, so the vouch seam is inert");
  }
});

// ---------------------------------------------------------------------------
// e7 — THE ROUND-1 REGRESSION CASES. A previous attempt at this defect credited a
// GROUP thread's exchanges to whichever participant sorted FIRST in array order,
// promoting a stranger above real correspondents. These pin the guards that
// prevent it: groupThreads keys group/channel threads on thread_id (never a
// person), so no group message can contribute reciprocity to a participant's DM.
// ---------------------------------------------------------------------------

function groupAndStrangerSources(LATEST) {
  const rows = [];
  // A MULTI-PARTY GROUP thread. `zz_first_in_array` is deliberately the FIRST
  // envelope in array order and is NOT the thread's last inbound sender.
  rows.push(groupEnv({ thread_id: "grp", sender_id: "zz_first_in_array", sender_name: "First In Array", content: "kicking this off", ts: LATEST - 7000 }));
  rows.push(env({ thread_id: "grp", is_from_me: true, content: "sounds good to me", ts: LATEST - 6000 }));
  rows.push(groupEnv({ thread_id: "grp", sender_id: "stranger_1", sender_name: "Stranger", content: "+1 from me too", ts: LATEST - 5000 }));
  rows.push(env({ thread_id: "grp", is_from_me: true, content: "ok let us lock it in", ts: LATEST - 4000 }));
  rows.push(groupEnv({ thread_id: "grp", sender_id: "zz_first_in_array", sender_name: "First In Array", content: "can someone confirm the time please?", ts: LATEST }));
  // The STRANGER's own thread: ONE cold unanswered DM, plus the group post above.
  rows.push(env({ thread_id: "dm_stranger", sender_id: "stranger_1", sender_name: "Stranger", content: "hi, can you take a look at my proposal and confirm?", ts: LATEST }));
  // A REAL correspondent: a deep two-way DM history, they spoke last.
  for (let i = 0; i < 8; i++) {
    rows.push(env({ thread_id: "dm_real_corr", sender_id: "+15552223333", sender_name: "Alex Example", is_from_me: i % 2 === 0, content: `turn ${i}`, ts: LATEST - 20000 + i * 1000 }));
  }
  rows.push(env({ thread_id: "dm_real_corr", sender_id: "+15552223333", sender_name: "Alex Example", is_from_me: false, content: "can you review the deck today please?", ts: LATEST }));
  return { source_a: rows };
}

test("e7 (regression): a GROUP thread is keyed on thread_id, so no participant is credited its exchanges", () => {
  const LATEST = NOW - 1000;
  const rows = groupAndStrangerSources(LATEST).source_a;
  // The N7-style resolver every catch-up build injects (sender -> person key).
  const groups = groupThreads(rows, { resolvePerson: (s) => (s && typeof s.id === "string" ? s.id : null) });
  const keys = [...groups.keys()];
  assert.ok(keys.includes("thread:grp"), `the group thread stays keyed on its thread_id (keys: ${keys.join(", ")})`);
  for (const k of keys) {
    if (!k.startsWith("person:")) continue;
    const bucket = groups.get(k);
    assert.ok(bucket.every((e) => e.thread_type === "dm"), `${k} collapses ONLY dm envelopes — a group message never joins a person key`);
  }
  // The stranger's person-scoped bucket must contain ONLY the cold DM: the group
  // post and the operator's two group replies contribute nothing.
  const strangerKey = keys.find((k) => k === "person:stranger_1");
  assert.ok(strangerKey, "the stranger's DM is person-keyed");
  const strangerRecip = reciprocityOfThread(groups.get(strangerKey));
  assert.equal(strangerRecip.outbound_count, 0, "the operator's GROUP replies are NOT credited to the stranger's DM");
  assert.equal(strangerRecip.turn_count, 0, "no scoped turns from the group thread");
  assert.equal(strangerRecip.reciprocated, false, "the stranger remains unreciprocated");
});

test("e7 (regression, end-to-end): the stranger does NOT out-rank the real correspondent, with or without the vouch", async () => {
  const LATEST = NOW - 1000;
  const sources = groupAndStrangerSources(LATEST);
  for (const anchorOpt of [undefined, vouchAnchor()]) {
    const res = await buildCatchup({
      sources,
      now: NOW,
      registry: fixtureRegistry(["source_a"]),
      min_score: 0.3,
      ...(anchorOpt ? { anchor: anchorOpt } : {}),
    });
    const stranger = res.rows.find((r) => r.thread_id === "dm_stranger");
    const real = res.rows.find((r) => r.thread_id === "dm_real_corr");
    assert.ok(stranger, "the stranger STILL surfaces (never hard-dropped)");
    assert.ok(real, "the real correspondent surfaces");
    assert.ok(
      real.score > stranger.score,
      `real correspondent (${real.score}) out-ranks the stranger (${stranger.score})${anchorOpt ? " with the address book wired" : ""}`,
    );
    assert.ok(
      stranger.reciprocity_strength <= CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL,
      "the stranger earns at most the new-contact neutral — the group thread grants no scoped credit",
    );
  }
});

// ---------------------------------------------------------------------------
// e7 / F7-4 — the per-factor decomposition, as an executable claim. This is the
// reason the vouch cases above hold recency EQUAL, and the reason no recency CAPS
// value is touched in this change: the time term's handicap at the measured ages
// is larger than the reciprocity term's ENTIRE range, so a reciprocity change
// cannot (and must not pretend to) invert that pair.
// ---------------------------------------------------------------------------

test("e7 (F7-4): recencyFactor saturates at RECENCY_FLOOR past the window, and its ratio exceeds the reciprocity term's whole range", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const old = recencyFactor(NOW - 34 * DAY, NOW);
  const fresh = recencyFactor(NOW - 2 * DAY, NOW);
  assert.equal(old, CATCHUP_CAPS.RECENCY_FLOOR, "a 34-day-old inbound is past RECENCY_WINDOW_MS => pinned at RECENCY_FLOOR");
  assert.ok(fresh > old, "a 2-day-old inbound is above the floor");
  const timeRatio = fresh / old;
  const reciprocityRange = CATCHUP_CAPS.RECIPROCITY_RELATIONSHIP_MAX / CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR;
  assert.ok(timeRatio > 14 && timeRatio < 15, `recency ratio (${timeRatio}) is the ~14.6x measured in F7-4`);
  assert.ok(
    timeRatio > reciprocityRange,
    `the recency handicap (${timeRatio}x) exceeds the reciprocity term's entire range (${reciprocityRange}x) — the reciprocity fix cannot invert the measured pair, and no recency CAPS value is moved here to force it`,
  );
});

// e17 — THIS CASE'S SUBJECT CHANGED, AND THE PROSE IT CARRIED WAS FALSIFIED.
// It used to be titled "staleness and the anchor FAVOUR the older relationship —
// the time term is the dominant adverse factor", and that sentence described the
// COMPOSITE recency x staleness. e17 deleted stalenessFactor from rankScore's
// product (the two factors read the same age, so their product was a band-pass),
// so there is no longer a composite for the sentence to describe: the time term IS
// recencyFactor, and the F7-4 case above already pins its handicap.
//
// What survives is a true statement about the exported FUNCTION, which is
// unchanged and still consumed by the e7 harness's saturation bisection and
// time-term candidates. That is what this case now asserts — and it asserts, as
// the load-bearing part, that the function is no longer one of rankScore's terms.
test("e7/e17 (F7-4): stalenessFactor still favours the older row as a CURVE — but it is no longer a rankScore term", () => {
  const DAY = 24 * 60 * 60 * 1000;
  assert.ok(stalenessFactor(34 * DAY) > stalenessFactor(2 * DAY), "the older row is MORE overdue (the curve favours it)");
  assert.ok(
    stalenessFactor(34 * DAY) / stalenessFactor(2 * DAY) < CATCHUP_CAPS.RECIPROCITY_RELATIONSHIP_MAX / CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR,
    "and the advantage it would confer is far smaller than the recency handicap",
  );
  // THE e17 CLAIM, executable: two rows differing ONLY in age would, under the old
  // product, have been separated by BOTH factors. Under the shipped scorer the
  // whole ratio is recencyFactor's, so multiplying the staleness curve back in
  // would change the answer — which is exactly what it no longer does.
  const NOW_T = 1700010000000;
  const base = { directed: 0.9, now: NOW_T, reciprocated: true };
  const older = rankScore({ ...base, lastInboundTs: NOW_T - 34 * DAY, ageMs: 34 * DAY });
  const newer = rankScore({ ...base, lastInboundTs: NOW_T - 2 * DAY, ageMs: 2 * DAY });
  // Stated as an EXACT product identity rather than a ratio: a ratio of two
  // products is only equal to the ratio of their differing factors up to
  // rounding, and this claim is meant to be about the terms, not about floats.
  assert.equal(
    newer,
    recencyFactor(NOW_T - 2 * DAY, NOW_T) * 0.9 * 1,
    "the score is recency x directedness x reciprocity — no staleness term",
  );
  assert.equal(
    older,
    recencyFactor(NOW_T - 34 * DAY, NOW_T) * 0.9 * 1,
    "and the same for the 34-day-old row: stalenessFactor contributes nothing",
  );
});

test("e7: reciprocityStrength is MONOTONE NON-DECREASING in the floor — the property the vouch lift relies on", () => {
  // The vouch raises a row's floor. The comment at that seat claims every branch of
  // the grader is non-decreasing in the floor, so the lift can only ever raise a
  // row's term. That claim is enforced here rather than asserted in prose.
  const shapes = [
    { turn_count: 0, outbound_count: 0, inbound_count: 0 },   // degenerate
    { turn_count: 0, outbound_count: 0, inbound_count: 1 },   // (e) new contact
    { turn_count: 0, outbound_count: 0, inbound_count: 4 },   // (f) graded middle
    { turn_count: 0, outbound_count: 0, inbound_count: 8 },   // (c) broadcast
    { turn_count: 1, outbound_count: 1, inbound_count: 45 },  // (c) A2P
    { turn_count: 1, outbound_count: 1, inbound_count: 1 },   // (d) established low-turn
    { turn_count: 3, outbound_count: 2, inbound_count: 2 },   // (b) graded relationship
    { turn_count: 174, outbound_count: 213, inbound_count: 144 }, // (a) relationship
  ];
  for (const s of shapes) {
    let prev = -Infinity;
    for (const f of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
      const v = reciprocityStrength(s, f);
      assert.ok(
        v >= prev - 1e-12,
        `shape ${JSON.stringify(s)}: strength at floor=${f} (${v}) is >= the previous (${prev}) — non-decreasing in the floor`,
      );
      assert.ok(v <= CATCHUP_CAPS.RECIPROCITY_RELATIONSHIP_MAX + 1e-12, "and never exceeds RELATIONSHIP_MAX");
      prev = v;
    }
    // The specific step the vouch takes: raising the floor to the new-contact
    // neutral never lowers a shape's strength, and never exceeds the max.
    const base = reciprocityStrength(s, CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR);
    const lifted = reciprocityStrength(s, CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL);
    assert.ok(lifted >= base - 1e-12, `shape ${JSON.stringify(s)}: the vouch floor never lowers the strength`);
    assert.ok(lifted >= CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL - 1e-12, "a vouched row is never graded below the new-contact neutral");
  }
});

// ---------------------------------------------------------------------------
// e7 (F7-2) — THE RATIONALE AT THE VOUCH SEAM IS PINNED TO THE REGISTRY IT NAMES.
//
// The `vouched` comment block in buildCatchupCore now makes two CONCRETE claims
// about the world outside catchup.js:
//
//   1. enrichment.is_contact is supplied by EXACTLY three SPINE_SOURCES readers —
//      "address-book", "messaging-contacts" and "reply-history" — and the coverage
//      bounds it records (mail-only, connector-history-bounded) are reply-history's
//      bounds specifically.
//   2. reply-history admits a handle at ONE outbound message
//      (REPLY_HISTORY_MIN_MESSAGES === 1), which is why a hotel the operator
//      emailed 24 times is vouched without appearing in any address book at all.
//
// Round 2's failure mode was prose going quietly stale: a comment asserted the
// address book was the vouching source, nobody could tell it had stopped being
// true, and the claim shipped. Appending a fourth reader — or moving the
// threshold — would silently invalidate BOTH claims the same way. This makes that
// a RED GATE instead: the registry and the threshold cannot move without a
// registered suite failing and forcing the rationale to be re-derived.
//
// It deliberately asserts EQUALITY on the key list, not membership. A membership
// test ("reply-history is registered") keeps passing as sources are appended,
// which is exactly the drift being guarded against.
// ---------------------------------------------------------------------------
test("e7 (F7-2): SPINE_SOURCES and REPLY_HISTORY_MIN_MESSAGES match the rationale recorded at the vouch seam", async () => {
  const { SPINE_SOURCES, REPLY_HISTORY_MIN_MESSAGES } = await import(
    "../../lib/messaging/contact-spine.js"
  );

  // (1) EXACTLY the three keys the comment names, in the registry's own order.
  assert.deepEqual(
    SPINE_SOURCES.map((s) => s.key),
    ["address-book", "messaging-contacts", "reply-history"],
    "the vouch rationale in catchup.js names exactly these three saved-contact " +
      "sources; adding, removing or renaming one makes that rationale false — " +
      "re-derive it with the e7 join harness's --vouch-source mode before updating " +
      "this list",
  );

  // (2) The threshold the rationale quotes, and the decision table's shipped default.
  assert.equal(
    REPLY_HISTORY_MIN_MESSAGES,
    1,
    "the vouch rationale states REPLY_HISTORY_MIN_MESSAGES = 1 (one outbound " +
      "message is enough to enter the spine). Moving it changes who reaches " +
      "TIER.RELATIONSHIP: re-run the --min-messages decision table and update the " +
      "numbers recorded at the seam before changing this constant",
  );

  // The registry stays substitutable — the rationale assumes every source is read
  // the same way, so a reader that broke the contract would also break the claim.
  for (const s of SPINE_SOURCES) {
    assert.equal(typeof s.key, "string", "each source has a key");
    assert.equal(typeof s.read, "function", "each source exposes read()");
    assert.equal(typeof s.scoped, "boolean", "each source declares its scoping");
  }
});
