// e17-time-term.test.mjs — the ACCEPTANCE GATE for e17: rankScore's TIME TERM,
// and the substance decision that moved with it.
//
// WHAT e17 CHANGED, so this file can be read without the diff:
//   (1) rankScore multiplied recencyFactor(lastInboundTs, now) by
//       stalenessFactor(ageMs). Those two arguments are THE SAME QUANTITY for a
//       they-spoke-last thread — attention.js computes `staleness.ms` as
//       `now - last_ts` over a thread whose LAST envelope is inbound, which is
//       `now - lastInboundTs` — so the product was a BAND-PASS in one variable:
//       exactly 0 at age 0, peaking near two days, decaying after. stalenessFactor
//       was DELETED from the product. It is still exported and still tested; it is
//       simply no longer a rank term.
//   (2) The substance drop moved from the top of the filter (where it saw the
//       text and nothing else) to below the enrichment / reciprocity / tier block,
//       where a row N8 graded a closer can be RESCUED on context — a saved-contact
//       vouch, or an inbound run that answers something the operator sent — kept,
//       and DOWN-RANKED by substanceFactor instead of dropped in silence.
//
// RED-FIRST, AND MEASURED ON BOTH SIDES. Against the pre-e17 checkout
// (git 72218a8, run from a `git archive HEAD` copy) this file cannot even LINK —
// `substanceFactor` does not exist there — so the exit code is 1 for a reason that
// says nothing about the cases. Stripped to the pre-e17 symbols it runs, and:
//     RED-1  FAIL   0.0095628 vs 0.5487713 — 57.4x the wrong way
//     RED-2  FAIL   the product rises with age up to ~2 days
//     RED-3  FAIL   a just-arrived directed message scores exactly 0
//     RED-4  FAIL   0.000168 vs 0.034966 through buildCatchupCore
//     GREEN-KEEP    PASS on both builds — the tier key was never the problem
// After the change all of them pass. GREEN-KEEP and RED-4 are deliberately two
// cases over the same pair of rows: one asserts the ORDER (invariant) and the
// other the SCORE (the thing that changed), and fusing them would have made a
// before/after regression look like a broken invariant. The substance cases (S-*)
// are red before in the plainest way — the rescued row is not in the result at all.
//
// HERMETIC: node:test only. No daemon, no network, no live ledger, no fs write.
// Every case runs over pure exported functions or over buildCatchupCore with
// hand-built envelopes and injected engines.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCatchupCore,
  rankScore,
  recencyFactor,
  stalenessFactor,
  substanceFactor,
  directednessFactor,
  CATCHUP_CAPS,
} from "../../lib/messaging/catchup.js";
import { computeAttention } from "../../lib/messaging/attention.js";
import { classifyDirectedAtMe } from "../../lib/messaging/classifier.js";
import { makeEnricherFromIndex, TIER } from "../../lib/messaging/person-enrichment.js";

const NOW = 1700010000000;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

// A full-reciprocity counts block: the deep two-way history reciprocityStrength
// saturates at RELATIONSHIP_MAX for. Used so the reciprocity term is EQUAL (and
// maximal) on both sides of every comparison — the isolation these cases need.
const FULL_RECIPROCITY = { turn_count: 174, outbound_count: 213, inbound_count: 144 };

// The scored row, expressed the way the surface expresses it: ONE age drives both
// arguments, because for a they-spoke-last thread they ARE one quantity. Passing
// `ageMs` here is deliberate — it pins that the shipped scorer ignores it.
function scoreAtAge(ageMs, extra = {}) {
  return rankScore({
    lastInboundTs: NOW - ageMs,
    ageMs,
    now: NOW,
    directed: 1,
    reciprocity: FULL_RECIPROCITY,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// RED-1 — THE OPERATOR'S OWN TEST. A message that arrived twenty minutes ago,
// addressed to them, unanswered, must out-score a thread from two days ago that
// they never replied to, when nothing else differs.
//
// ON THE PRE-e17 BUILD THIS FAILS, and by how much is the point: the 20-minute
// row scored 0.0095628 and the 2.2-day row 0.5487713 — 57.4x the WRONG WAY — because
// stalenessFactor(20 min) is 0.0096 while stalenessFactor(2.2 d) is 0.782. The
// fresher message was not ranked below the older one; it was very nearly not
// ranked at all.
// ---------------------------------------------------------------------------
test("RED-1 (e17): a 20-minute-old directed unanswered DM OUT-SCORES a 2.2-day-old never-answered one at equal directedness, reciprocity and anchor", () => {
  const fresh = scoreAtAge(20 * MINUTE);
  const stale = scoreAtAge(2.2 * DAY);
  assert.ok(
    fresh > stale,
    `the 20-minute-old row (${fresh}) must out-score the 2.2-day-old row (${stale}) — the pre-e17 product had this backwards by 57x`,
  );
  // And the isolation is real: every other factor is identical by construction, so
  // the whole difference is the time term. Stated as an exact PRODUCT identity on
  // each row — a ratio of two products only equals the ratio of their differing
  // factors up to rounding, and this claim is about the terms, not about floats.
  assert.equal(fresh, recencyFactor(NOW - 20 * MINUTE, NOW) * 1 * 1, "the fresh row IS its recency factor");
  assert.equal(stale, recencyFactor(NOW - 2.2 * DAY, NOW) * 1 * 1, "the stale row IS its recency factor");
});

// ---------------------------------------------------------------------------
// RED-2 — MONOTONE, WITH NO INTERIOR PEAK. The property the band-pass violated.
// Sampled at 61 ages from 0 to 30 days with every other input held fixed.
//
// WHY THE AGE DRIVES BOTH ARGUMENTS: holding `lastInboundTs` fixed while varying
// `ageMs` would be testing a call no caller can make — the two are the same
// quantity at the one seat that calls this function. Driving both from one age is
// what makes this a statement about the surface rather than about the signature.
// The pre-e17 product peaks at ~2 days under exactly this sampling.
// ---------------------------------------------------------------------------
test("RED-2 (e17): rankScore is MONOTONE NON-INCREASING in age, sampled at 61 ages from 0 to 30d — no interior peak", () => {
  const samples = [];
  const STEPS = 60;
  for (let i = 0; i <= STEPS; i += 1) {
    const age = (30 * DAY * i) / STEPS;
    samples.push({ age, score: scoreAtAge(age) });
  }
  assert.ok(samples.length >= 50, `at least 50 samples required, got ${samples.length}`);
  for (let i = 0; i + 1 < samples.length; i += 1) {
    assert.ok(
      samples[i].score >= samples[i + 1].score,
      `rankScore must not RISE with age: at ${(samples[i].age / DAY).toFixed(2)}d it is ${samples[i].score} and at ${(samples[i + 1].age / DAY).toFixed(2)}d it is ${samples[i + 1].score}`,
    );
  }
  // The maximum is at age 0 — an interior peak is exactly what the deleted product
  // had, and a monotone check alone would pass a curve that is flat then rises.
  const best = samples.reduce((a, b) => (b.score > a.score ? b : a), samples[0]);
  assert.equal(best.age, 0, `the maximum must be at age 0, not at ${(best.age / DAY).toFixed(2)}d`);

  // AND THE LITERAL READING OF THE SAME PROPERTY: with lastInboundTs held fixed,
  // varying `ageMs` alone moves NOTHING — the argument is accepted and ignored, so
  // the score is (trivially) non-increasing in it. Before e17 this same sweep was
  // strictly INCREASING, which is the defect stated in its plainest form.
  const fixed = NOW - 3 * DAY;
  const held = new Set();
  for (let i = 0; i <= 60; i += 1) {
    held.add(rankScore({ lastInboundTs: fixed, ageMs: (30 * DAY * i) / 60, now: NOW, directed: 1, reciprocity: FULL_RECIPROCITY }));
  }
  assert.equal(held.size, 1, `ageMs alone must not move the score; got ${held.size} distinct values`);
});

// ---------------------------------------------------------------------------
// RED-3 — A JUST-ARRIVED DIRECTED MESSAGE IS RANKABLE AT ALL. On the pre-e17
// build this is EXACTLY 0, because stalenessFactor(0) === 0 zeroes the product: a
// message that arrived this second was unrankable by construction, and the only
// thing keeping it on the list was that no other row could be at age 0 either.
// ---------------------------------------------------------------------------
test("RED-3 (e17): rankScore at age 0 with directed=1 and full reciprocity is STRICTLY greater than 0", () => {
  const s = scoreAtAge(0);
  assert.ok(s > 0, `a just-arrived directed message must be rankable, got ${s}`);
  // It is the top of the range, since every factor is at its maximum.
  assert.equal(s, 1, "at age 0 with directed=1, full reciprocity and a neutral anchor the score is exactly 1");
  // stalenessFactor is what used to zero it, and it is unchanged — the factor was
  // removed from the product, not weakened.
  assert.equal(stalenessFactor(0), 0, "stalenessFactor(0) is still exactly 0 — the function was not altered");
});

// ---------------------------------------------------------------------------
// The exported factor stays a factor: pure, total, monotone, in range. e17 removed
// a CALL, not a function, and the difference is worth pinning.
// ---------------------------------------------------------------------------
test("e17: stalenessFactor is still exported, monotone non-decreasing and in [0,1) — removed from the product, not from the module", () => {
  assert.equal(typeof stalenessFactor, "function", "still exported");
  let prev = -1;
  for (let d = 0; d <= 60; d += 1) {
    const v = stalenessFactor(d * DAY);
    assert.ok(v >= 0 && v <= 1, `staleness in [0,1] at ${d}d, got ${v}`);
    assert.ok(v >= prev, `staleness non-decreasing at ${d}d`);
    prev = v;
  }
  assert.equal(stalenessFactor(CATCHUP_CAPS.STALENESS_HALFLIFE_MS), 0.5, "half-life still halves it");
});

// ---------------------------------------------------------------------------
// GREEN-KEEP — TIER STAYS THE PRIMARY KEY. This passes before AND after; it is
// here because the cheapest wrong way to satisfy RED-1 would be to let the time
// term outrank the tier, and nothing else in this file would notice.
//
// A fresh UNKNOWN row (a stranger who messaged a minute ago) must still sort BELOW
// a stale RELATIONSHIP row (a saved contact from ten days ago) through the real
// buildCatchupCore with an enricher injected.
// ---------------------------------------------------------------------------
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
    ts: typeof ts === "number" ? ts : NOW - 60 * MINUTE + _mid * 1000,
    content,
    mentions: [],
    directed_at_me_signals: { mention_me: false, reply_to_me: false, addressed_to_me: false },
    capabilities: { reply_to_available: true, structured_mentions: true, self_identity_reliable: true, addressing_first_class: false },
    source_msg_id: `${platform}:${thread_id}:${_mid}`,
  };
}

// The injected N7 resolver + M1 enricher: `person:saved` is a saved contact,
// everyone else is cold. This is the same injection shape m1-person-enrichment
// uses — no live address book, no memoized index.
const RESOLVE = (platform, senderId) => {
  if (senderId === "+15551110000") return "person:saved";
  if (senderId === "+15552220000") return "person:stranger";
  return null;
};
const ENRICH_SAVED = makeEnricherFromIndex(
  { "person:saved": { is_contact: true, reciprocity_strength: 1, feedback_score: 0 } },
  (idx, id) => idx[id] || null,
);

function coreOver(envelopes, extra = {}) {
  return buildCatchupCore({
    envelopes,
    classify: classifyDirectedAtMe,
    attention: computeAttention,
    resolvePerson: RESOLVE,
    now: NOW,
    opts: { min_score: 0.3, limit: 50 },
    ...extra,
  });
}

test("GREEN-KEEP (e17): a FRESH unknown-tier row still sorts BELOW a STALE relationship-tier row — tier remains the primary key", () => {
  const envelopes = [
    // The saved contact, 10 days ago, one substantive unanswered question.
    env({
      thread_id: "dm_saved",
      sender_id: "+15551110000",
      sender_name: "Saved",
      content: "can you send me the notes from the meeting when you get a chance?",
      ts: NOW - 10 * DAY,
    }),
    // The stranger, one minute ago, an equally substantive unanswered question.
    env({
      thread_id: "dm_stranger",
      sender_id: "+15552220000",
      sender_name: "Stranger",
      content: "can you send me the notes from the meeting when you get a chance?",
      ts: NOW - 1 * MINUTE,
    }),
  ];
  const res = coreOver(envelopes, { enrichPerson: ENRICH_SAVED });
  const saved = res.rows.find((r) => r.person_id === "person:saved");
  const stranger = res.rows.find((r) => r.person_id === "person:stranger");
  assert.ok(saved && stranger, "both rows surface — the cold node is never dropped");
  assert.equal(saved.tier, TIER.RELATIONSHIP, "the saved contact is relationship tier");
  assert.equal(stranger.tier, TIER.UNKNOWN, "the stranger is the honest unknown tier");
  assert.ok(
    res.rows.indexOf(saved) < res.rows.indexOf(stranger),
    "the stale relationship outranks the fresh stranger: tier before score",
  );
});

// RED-4 — the same two rows, read on SCORE instead of on rank. This is the half
// of the pair that is red before: on the pre-e17 build the one-minute-old row
// scored 0.000168 against the ten-day-old row's 0.034966 — the band-pass rated a
// message that arrived a minute ago at a fiftieth of one from ten days ago. It is
// deliberately a SEPARATE case from GREEN-KEEP above, because the two make
// opposite claims and only one of them holds on both builds.
test("RED-4 (e17): through buildCatchupCore the FRESH row out-SCORES the stale one — while GREEN-KEEP holds the rank order", () => {
  const envelopes = [
    env({ thread_id: "dm_saved2", sender_id: "+15551110000", sender_name: "Saved", content: "can you send me the notes from the meeting when you get a chance?", ts: NOW - 10 * DAY }),
    env({ thread_id: "dm_stranger2", sender_id: "+15552220000", sender_name: "Stranger", content: "can you send me the notes from the meeting when you get a chance?", ts: NOW - 1 * MINUTE }),
  ];
  const res = coreOver(envelopes, { enrichPerson: ENRICH_SAVED });
  const saved = res.rows.find((r) => r.person_id === "person:saved");
  const stranger = res.rows.find((r) => r.person_id === "person:stranger");
  assert.ok(saved && stranger, "both rows surface");
  assert.ok(
    stranger.score > saved.score,
    `the fresh row must out-SCORE the stale one (${stranger.score} vs ${saved.score})`,
  );
});

// ===========================================================================
// THE SECOND SEAT — SUBSTANCE.
// ===========================================================================

test("e17: substanceFactor is total, monotone, bounded in [MIN,1] and never 0", () => {
  const MIN = CATCHUP_CAPS.SUBSTANCE_LOW_FACTOR_MIN;
  assert.ok(MIN > 0 && MIN < 1, "the floor is a soft down-rank, never a drop");
  assert.equal(substanceFactor(0), MIN, "the weakest text takes the strongest down-rank");
  assert.equal(substanceFactor(1), 1, "a full-substance score is a no-op multiplier");
  let prev = -1;
  for (let i = 0; i <= 20; i += 1) {
    const v = substanceFactor(i / 20);
    assert.ok(v >= MIN && v <= 1, `factor in [${MIN},1] at s=${i / 20}, got ${v}`);
    assert.ok(v >= prev, "monotone non-decreasing in the graded substance score");
    prev = v;
  }
  // TOTAL: nothing throws, nothing returns 0, nothing escapes the band.
  for (const bad of [undefined, null, Number.NaN, Infinity, -5, 42, "0.5", {}]) {
    const v = substanceFactor(bad);
    assert.ok(v >= MIN && v <= 1, `degenerate input ${String(bad)} stays in band, got ${v}`);
  }
});

// A closer thread: the operator wrote, they answered with a bare closer. The
// trailing inbound run is "ok" — N8 grades it isCloser, and `last_outbound_ts` is
// non-null because the run stops at the operator's message.
function answeredCloserThread(tid, senderId) {
  return [
    env({ thread_id: tid, sender_id: senderId, sender_name: "Peer", content: "are we still on for tomorrow at six?", ts: NOW - 3 * DAY }),
    env({ thread_id: tid, is_from_me: true, content: "yes — six works, I will send the address", ts: NOW - 2 * DAY }),
    env({ thread_id: tid, sender_id: senderId, sender_name: "Peer", content: "ok", ts: NOW - 1 * DAY }),
  ];
}

// A cold closer: one inbound closer, nothing else. No vouch, no outbound — the
// row e17 deliberately still drops (and the shape of n9-catchup's T5 fixture).
function coldCloserThread(tid, senderId) {
  return [env({ thread_id: tid, sender_id: senderId, sender_name: "Cold", content: "thanks!", ts: NOW - 1 * DAY })];
}

test("S-1 (e17): a closer that ANSWERS the operator's own message is KEPT, tagged low_substance, and ranked DOWN", () => {
  const envelopes = answeredCloserThread("dm_answered", "+15553330000");
  const res = coreOver(envelopes);
  const row = res.rows.find((r) => r.thread_id === "dm_answered");
  assert.ok(row, "the rescued row is on the surface (pre-e17 it was dropped in silence)");
  assert.ok(row.reasons.includes("low_substance"), "the row explains itself: low_substance");
  assert.ok(!row.reasons.includes("substantive"), "and does not also claim to be substantive");
  assert.ok(row.reciprocity.last_outbound_ts !== null, "the rescue key is the operator's own outbound, not the text");
  // The DOWN-RANK is real: the same row scored without the substance term would be
  // strictly higher, and the ratio is exactly substanceFactor of N8's graded score.
  const withoutTerm = rankScore({
    lastInboundTs: row.ts,
    now: NOW,
    directed: classifyDirectedAtMe(envelopes[envelopes.length - 1]).score,
    reciprocity: {
      turn_count: row.reciprocity.turn_count,
      outbound_count: row.reciprocity.outbound_count,
      inbound_count: row.reciprocity.inbound_count,
    },
  });
  assert.ok(row.score < withoutTerm, `the rescued row is ranked down (${row.score} < ${withoutTerm})`);
  assert.ok(row.score > 0, "and is never zeroed — no factor may drop a row");
  assert.equal(res.stats.dropped_low_substance, 0, "nothing was dropped: the one closer here was rescued");
});

test("S-2 (e17): a closer with NO context evidence is still dropped — and the drop is now COUNTED", () => {
  const envelopes = coldCloserThread("dm_cold", "+15554440000");
  const res = coreOver(envelopes);
  assert.equal(res.rows.length, 0, "an unvouched, unanswered closer stays off the list (unchanged behaviour)");
  assert.equal(res.stats.dropped_low_substance, 1, "the drop is measurable instead of invisible");
  assert.equal(res.stats.after_filter, 0, "after_filter stays honest: it counts rows that reached the surface");
});

test("S-3 (e17): the SAVED-CONTACT vouch rescues a closer the operator never answered", () => {
  const envelopes = [
    env({ thread_id: "dm_saved_closer", sender_id: "+15551110000", sender_name: "Saved", content: "ok", ts: NOW - 1 * DAY }),
  ];
  const cold = coreOver(envelopes);
  assert.equal(cold.rows.length, 0, "without the vouch the same row is dropped");
  assert.equal(cold.stats.dropped_low_substance, 1, "and counted");

  const vouched = coreOver(envelopes, { enrichPerson: ENRICH_SAVED });
  const row = vouched.rows.find((r) => r.thread_id === "dm_saved_closer");
  assert.ok(row, "with the saved-contact vouch the row is kept");
  assert.ok(row.reasons.includes("low_substance"), "kept, and labeled");
  assert.equal(row.enrichment.is_contact, true, "the rescue key is the vouch classifyTier already trusts");
  assert.equal(vouched.stats.dropped_low_substance, 0, "nothing dropped in the vouched build");
});

test("S-4 (e17): a rescued closer ranks BELOW an otherwise identical substantive row of the same tier", () => {
  const envelopes = [
    ...answeredCloserThread("dm_closer", "+15553330000"),
    // The same shape, same age, same reciprocity — but a real question.
    env({ thread_id: "dm_real", sender_id: "+15556660000", sender_name: "Peer2", content: "are we still on for tomorrow at six?", ts: NOW - 3 * DAY }),
    env({ thread_id: "dm_real", is_from_me: true, content: "yes — six works, I will send the address", ts: NOW - 2 * DAY }),
    env({ thread_id: "dm_real", sender_id: "+15556660000", sender_name: "Peer2", content: "could you also bring the signed copy with you?", ts: NOW - 1 * DAY }),
  ];
  const res = coreOver(envelopes);
  const closer = res.rows.find((r) => r.thread_id === "dm_closer");
  const real = res.rows.find((r) => r.thread_id === "dm_real");
  assert.ok(closer && real, "both rows surface");
  assert.equal(closer.tier, real.tier, "the comparison is within one tier");
  assert.ok(real.score > closer.score, `the substantive row out-scores the rescued closer (${real.score} > ${closer.score})`);
  assert.ok(
    res.rows.indexOf(real) < res.rows.indexOf(closer),
    "and out-ranks it on the emitted surface",
  );
});

test("S-5 (e17): stats gained ONLY an additive key — every pre-existing key keeps its name and meaning", () => {
  const res = coreOver(answeredCloserThread("dm_keys", "+15557770000"));
  for (const k of ["threads_considered", "after_filter", "after_dedup", "truncated", "platforms", "tiers"]) {
    assert.ok(k in res.stats, `pre-existing stats key ${k} is still present`);
  }
  assert.ok("dropped_low_substance" in res.stats, "the new key is present");
  assert.equal(typeof res.stats.dropped_low_substance, "number", "and is a count");
  // after_filter still means "rows that became candidates".
  assert.equal(res.stats.after_filter, res.stats.after_dedup + 0, "after_filter counts candidate rows (no dedup collapse in this fixture)");
});

// ---------------------------------------------------------------------------
// THE SEAT'S OWN ARITHMETIC, pinned so a later reader cannot mistake the rescue
// for a re-grade: the term applied is substanceFactor of N8's OWN graded score,
// and directednessFactor is untouched by any of this.
// ---------------------------------------------------------------------------
test("e17: the rescue applies substanceFactor to N8's graded score and re-grades nothing", () => {
  const envelopes = answeredCloserThread("dm_arith", "+15558880000");
  const records = computeAttention(envelopes, { now: NOW, classify: classifyDirectedAtMe });
  const rec = records.find((r) => r.thread_id === "dm_arith");
  assert.ok(rec, "the attention record exists");
  assert.equal(rec.substance.isCloser, true, "N8 grades this trailing run a closer — unchanged");
  const res = coreOver(envelopes);
  const row = res.rows.find((r) => r.thread_id === "dm_arith");
  // The directedness the seat used is N2's OWN score on the latest inbound
  // envelope — re-derived here with the same classifier rather than assumed, which
  // is the point: the substance term is the ONLY thing this seat adds on top.
  const latestInbound = envelopes.filter((e) => e.is_from_me !== true).slice(-1)[0];
  const directed = classifyDirectedAtMe(latestInbound).score;
  const expected = rankScore({
    lastInboundTs: row.ts,
    now: NOW,
    directed,
    reciprocity: {
      turn_count: row.reciprocity.turn_count,
      outbound_count: row.reciprocity.outbound_count,
      inbound_count: row.reciprocity.inbound_count,
    },
  }) * substanceFactor(rec.substance.score);
  assert.ok(
    Math.abs(row.score - expected) < 1e-12,
    `the emitted score is base x substanceFactor(N8's score): got ${row.score}, expected ${expected}`,
  );
  assert.equal(directednessFactor(1), 1, "directedness is untouched by the substance seat");
});
