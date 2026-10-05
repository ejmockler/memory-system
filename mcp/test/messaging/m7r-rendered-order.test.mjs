// m7r-rendered-order.test.mjs — regression guards for the approach-revisit hand-edit
// pass. Two production fixes the honest (rendered-order) gate forced:
//   (1) plausibleTs: clamp a corrupt/implausible ts at read time so a ~epoch-0 parse
//       artifact can't silently floor a real contact's recency.
//   (2) TIER-BANDED diversity interleave: the cross-platform weave must run WITHIN each
//       tier band, never across — so an UNKNOWN can never render ABOVE a RELATIONSHIP.
// These protect the user-VISIBLE rendered order (the thing the old raw-score precision
// metric never measured). Hermetic; no live fs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatchup, plausibleTs, MIN_PLAUSIBLE_TS_MS } from "../../lib/messaging/catchup.js";
import { TIER } from "../../lib/messaging/person-enrichment.js";
import { buildPersonIndex, lookup as personLookup } from "../../lib/messaging/identity.js";

const NOW = 1_750_000_000_000; // a fixed, plausible "now" (2025-06).
const DAY = 24 * 60 * 60 * 1000;

function env({ platform, sid, ts, content }) {
  return {
    platform, thread_id: `${platform}-${sid}`, thread_type: "dm",
    sender: { id: sid, name: sid, kind: "person" }, recipients: [],
    is_from_me: false, ts, content, mentions: [],
    directed_at_me_signals: { mention_me: false, reply_to_me: false, addressed_to_me: true },
    capabilities: { reply_to_available: false, structured_mentions: false, self_identity_reliable: true, addressing_first_class: false },
    source_msg_id: `${platform}-${sid}-1`,
  };
}

test("plausibleTs: clamps corrupt timestamps, passes real ones", () => {
  assert.equal(plausibleTs(0, NOW), null, "epoch-0 is a parse artifact => null");
  assert.equal(plausibleTs(MIN_PLAUSIBLE_TS_MS - 1, NOW), null, "pre-2008 => null");
  assert.equal(plausibleTs(NOW + 5 * DAY, NOW), null, "far-future skew => null");
  assert.equal(plausibleTs(NaN, NOW), null, "NaN => null");
  assert.equal(plausibleTs("123", NOW), null, "non-number => null");
  assert.equal(plausibleTs(NOW - DAY, NOW), NOW - DAY, "a recent real ts passes through");
  assert.equal(plausibleTs(MIN_PLAUSIBLE_TS_MS, NOW), MIN_PLAUSIBLE_TS_MS, "the floor itself is plausible");
});

test("TIER-BANDED interleave: an UNKNOWN never renders above a RELATIONSHIP across platforms", async () => {
  // Platform A: a fresh, high-scoring UNKNOWN stranger. Platform B: an OLDER (lower raw
  // score) RELATIONSHIP (flagged is_contact via the injected enricher). Under a naive
  // cross-platform round-robin the fresh unknown (A's #1) would precede the relationship
  // (B's #1). Tier-banding must keep ALL relationships above ALL unknowns.
  const extraEnvelopes = [
    env({ platform: "pa", sid: "stranger", ts: NOW - 1 * DAY, content: "hey can you help with the report?" }),
    env({ platform: "pb", sid: "friend", ts: NOW - 20 * DAY, content: "miss you, can you call me back?" }),
  ];
  // The pipeline resolves a HASHED person_id (N7), so flag the friend by their RESOLVED
  // id (built over the same envelopes the pipeline indexes) — not the raw handle.
  const idx = buildPersonIndex(extraEnvelopes);
  const friendId = personLookup(idx, "pb", "friend");
  // Inject an enricher: flag the friend as a saved contact (=> RELATIONSHIP tier, anchor up).
  const enrichPerson = (dedupKey) => {
    const isFriend = dedupKey === friendId;
    return {
      person_id: dedupKey,
      is_contact: isFriend,
      reciprocity_strength: 0,
      feedback_score: 0,
      anchor_factor: isFriend ? 1.5 : 1.0,
    };
  };
  const res = await buildCatchup({
    sources: [], extraEnvelopes, enrichPerson,
    now: NOW, min_score: 0.0, limit: 50, max_per_platform: 1,
  });

  assert.ok(res.rows.length >= 2, "both candidates surface");
  const idxFriend = res.rows.findIndex((r) => r.person_id === friendId);
  const idxStranger = res.rows.findIndex((r) => r.person_id !== friendId);
  assert.ok(idxFriend >= 0 && idxStranger >= 0, "both rows present");
  assert.equal(res.rows[idxFriend].tier, TIER.RELATIONSHIP, "the contact is RELATIONSHIP tier");
  assert.equal(res.rows[idxStranger].tier, TIER.UNKNOWN, "the stranger is UNKNOWN tier");
  // The friend (relationship) must render ABOVE the stranger (unknown) despite a lower
  // raw recency score and the round-robin weave.
  assert.ok(idxFriend < idxStranger, "relationship renders above unknown");

  // e7/F7-6 — EMITTED ORDER IS NOT RAW SCORE-DESC. The surprise this pins as
  // executable: reading the surface top-down and expecting descending `score` is
  // wrong by design. compareDesc keys on tierRank FIRST, then the M5b saved-contact
  // sub-key (isContactRow), and only THEN score/ts/thread_id; the TIER-BANDED
  // diversifyByPlatform weave then re-orders within each band. Here the friend
  // renders ABOVE the stranger while carrying a strictly LOWER raw score — so a
  // score-desc reading of the emitted rows is falsified on this very fixture.
  //
  // PRE-EXISTING, DEMONSTRATED — NOT ASSERTED. This assertion was written during
  // e7 and it is fair to ask whether e7's own vouch lift CAUSED the non-descending
  // order. It did not, and that was checked by RUNNING it, not by reasoning:
  //
  //   git show HEAD:mcp/lib/messaging/catchup.js > $SCR/mcp/lib/messaging/catchup.js
  //   # $SCR mirrors mcp/ by symlink, with ONLY catchup.js replaced by HEAD's copy
  //   node --test $SCR/mcp/test/messaging/m7r-rendered-order.test.mjs
  //   # => tests 3 / pass 3 / fail 0
  //
  // This assertion PASSES against the pre-e7 catchup.js. The non-score-descending
  // emitted order is therefore a property of compareDesc's key precedence plus the
  // tier-banded weave as they already shipped — not a defect e7 introduced. What
  // e7 adds is that the property is now executable instead of folklore.
  assert.ok(
    res.rows[idxFriend].score < res.rows[idxStranger].score,
    `emitted order is compareDesc-then-weave, NOT raw score-desc: the higher-ranked row's score (${res.rows[idxFriend].score}) is BELOW the lower-ranked row's (${res.rows[idxStranger].score})`,
  );

  // Structural invariant: scanning the rendered order, no relationship appears after an
  // unknown (tier bands are contiguous and relationship-first).
  let seenUnknown = false;
  for (const r of res.rows) {
    if (r.tier === TIER.UNKNOWN) seenUnknown = true;
    else if (r.tier === TIER.RELATIONSHIP) {
      assert.equal(seenUnknown, false, "a RELATIONSHIP must not follow an UNKNOWN in the rendered order");
    }
  }
});

test("TIER-BANDED interleave: byte-identical to pure-rank when a single tier is present", async () => {
  // All-unknown corpus: tier-banding is a no-op vs the prior weave (one band).
  const extraEnvelopes = [
    env({ platform: "pa", sid: "a1", ts: NOW - 1 * DAY, content: "can you send the contract today?" }),
    env({ platform: "pb", sid: "b1", ts: NOW - 2 * DAY, content: "are we still meeting thursday?" }),
    env({ platform: "pa", sid: "a2", ts: NOW - 3 * DAY, content: "did you get a chance to review it?" }),
  ];
  const res = await buildCatchup({ sources: [], extraEnvelopes, now: NOW, min_score: 0.0, limit: 50, max_per_platform: 1 });
  assert.ok(res.rows.every((r) => r.tier === TIER.UNKNOWN), "all unknown (no enricher => neutral)");
  assert.ok(res.rows.length === 3, "all three surface, none dropped");
});

// ---------------------------------------------------------------------------
// f7 — THE OPT NEVER REACHED THE ENGINE. Both tests above pass `max_per_platform`
// to buildCatchup, and neither one could ever have observed it: buildCatchup did
// not destructure the key, so it was dropped on the floor and the core always ran
// at the CAPS default. That made this suite VACUOUS on that opt — it is the file
// that should have caught it, so the guard lands here.
//
// The property under test is the WEAVE SEAM, stated without naming a platform: a
// caller who asks for a different interleave quantum must get a DIFFERENT emitted
// platform sequence. One tier band, one dominant bucket + one minority bucket, and
// three settings that must disagree: absent (the shipped derived/CAPS default), an
// explicit 1 (strict round-robin), and the `false` sentinel (pure rank).
//
// AT HEAD (before the forwarding fix) all three emitted the IDENTICAL sequence,
// because all three resolved to the same default inside the core.
// ---------------------------------------------------------------------------
// 8 rows on one platform token + 1 on another, all UNKNOWN (no enricher => ONE
// tier band), the minority row ranked LAST by recency. Shared by the two tests
// below: one reads it through a window that SPILLS, the other through one that FITS.
function weaveFixture() {
  const extraEnvelopes = [];
  for (let i = 0; i < 8; i++) {
    extraEnvelopes.push(env({
      platform: "pa", sid: `a${i}`, ts: NOW - (i + 1) * 60 * 60 * 1000,
      content: "can you take a look at the draft and let me know?",
    }));
  }
  extraEnvelopes.push(env({
    platform: "pb", sid: "b0", ts: NOW - 30 * DAY,
    content: "are we still on for the review next week?",
  }));
  return extraEnvelopes;
}

// The emitted platform sequence, as a string of one char per row. Generic tokens
// only — the assertions below never name a real platform.
async function platformSeq({ extraEnvelopes, limit, max_per_platform }) {
  const args = { sources: [], extraEnvelopes, now: NOW, min_score: 0.0, limit };
  if (max_per_platform !== undefined) args.max_per_platform = max_per_platform;
  const res = await buildCatchup(args);
  assert.ok(res.rows.every((r) => r.tier === TIER.UNKNOWN), "fixture is one tier band");
  return res.rows.map((r) => r.platform.slice(-1)).join("");
}

test("weave seam: the max_per_platform opt reaches the engine (three settings, three orders)", async () => {
  const extraEnvelopes = weaveFixture();
  // limit 6 against a 9-row band: the window SPILLS, so the weave is live and the
  // three settings must disagree. (At a limit that fits the whole band the derived
  // default deliberately declines to weave — that is the next test, not this one.)
  const seq = (max_per_platform) => platformSeq({ extraEnvelopes, limit: 6, max_per_platform });

  const sDefault = await seq(undefined);   // shipped default (budget-derived)
  const sRoundRobin = await seq(1);        // strict round-robin
  const sPureRank = await seq(false);      // interleave disabled

  assert.notEqual(sDefault, sRoundRobin,
    `an explicit perRound=1 must change the emitted order vs the default (both "${sDefault}")`);
  assert.notEqual(sDefault, sPureRank,
    `the false sentinel (pure rank) must change the emitted order vs the default (both "${sDefault}")`);
  assert.notEqual(sRoundRobin, sPureRank,
    `strict round-robin and pure rank must differ (both "${sRoundRobin}")`);

  // Pin each setting exactly. Round-robin lifts the minority bucket's #1 to index 1;
  // pure rank buries it below the cut entirely; the derived default (budget 6 over
  // 2 buckets => 3) surfaces it at index 3 — inside the window, without inverting
  // more of the dominant bucket's rank order than it has to.
  assert.equal(sRoundRobin, "abaaaa", "perRound=1 => the minority bucket's #1 is second");
  assert.equal(sPureRank, "aaaaaa", "pure rank => the minority row never reaches the window");
  assert.equal(sDefault, "aaabaa", "derived => floor(budget 6 / 2 buckets) = 3 before the yield");
});

test("weave seam: a tier band that FITS inside the window is NOT woven (pure rank, no peer inversion)", async () => {
  // The same 9-row band read through a window with room for all 9. Nothing is
  // hidden, so the interleave has nothing to protect and the derived default must
  // decline to run: weaving here would invert adjacent peers (emit a lower-scoring
  // row above a higher-scoring one) and buy no visibility at all.
  //
  // This is the f7 objective-3 decision made executable. On the measured population
  // the higher-priority tier band fits inside EVERY limit swept, so the previous
  // fixed-quantum default paid its widest score inversions there at every limit for
  // zero rows gained.
  const extraEnvelopes = weaveFixture();
  const sDefault = await platformSeq({ extraEnvelopes, limit: 9 });
  const sPureRank = await platformSeq({ extraEnvelopes, limit: 9, max_per_platform: false });

  assert.equal(sDefault.length, 9, "the whole band is emitted (the band fits)");
  assert.equal(sDefault, sPureRank,
    `a band that fits its budget must be emitted in pure rank order (got "${sDefault}" vs "${sPureRank}")`);
  assert.equal(sDefault, "aaaaaaaab", "pure rank: the minority row sits last, where its score puts it");

  // An EXPLICIT quantum still wins verbatim — the fits-guard is part of DERIVING a
  // default, never an override of a caller that named the weave it wants.
  const sExplicit = await platformSeq({ extraEnvelopes, limit: 9, max_per_platform: 1 });
  assert.equal(sExplicit, "abaaaaaaa", "an explicit perRound=1 weaves even when the band fits");
});
