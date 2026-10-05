// m1-person-enrichment.test.mjs — WORKUNIT M1 gate: the PERSON-ENRICHMENT SEAM,
// the W0 barrier / spine of the WHO-MATTERS attention model.
//
// What this proves (mapped to the M1 contract + the HARD CONSTRAINTS):
//   - The enrichment SHAPE is {person_id, is_contact, reciprocity_strength,
//     feedback_score, anchor_factor} and anchorFactor folds the signals into a
//     MONOTONE multiplier in [NEUTRAL, MAX].
//   - DEFAULT-NEUTRAL: makeNeutralEnricher returns anchor_factor=1.0 for every
//     person, so a buildCatchupCore built WITH it is BYTE-IDENTICAL to one built
//     WITHOUT any enrichPerson (the gate is OFF; ranking unchanged from pre-M1).
//   - anchorFactor is MONOTONE: more signals => >= factor; it NEVER returns below
//     the neutral floor (no hard-drop), and is clamped to the CAPS ceiling.
//   - The injected resolver is PURE / DETERMINISTIC (same id => same enrichment;
//     no mutable-store coupling — same result across repeated calls).
//   - END-TO-END: an ANCHORED person OUT-RANKS an equal-recency UNANCHORED one
//     when a signal is set, and the unanchored row is NEVER dropped.
//   - ZERO platform tokens in L2-5 (person-enrichment.js + catchup.js).
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions. Hermetic: NO
// network, NO DB, NO filesystem writes. Reads only in-memory rows + the lib bytes
// (for the 0-platform-token grep gate).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  ANCHOR_CAPS,
  NEUTRAL_ENRICHMENT,
  anchorFactor,
  normalizeEnrichment,
  makeNeutralEnricher,
  makeEnricherFromIndex,
} from "../../lib/messaging/person-enrichment.js";

import {
  buildCatchup,
  buildCatchupCore,
  buildAdapterRegistry,
  rankScore,
} from "../../lib/messaging/catchup.js";

import { computeAttention } from "../../lib/messaging/attention.js";
import { classifyDirectedAtMe } from "../../lib/messaging/classifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(__dirname, "../../lib/messaging");

// ---------------------------------------------------------------------------
// Fixtures. Minimal N1-shaped DM envelopes; `now` pinned for determinism.
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

function fixtureRegistry(platforms) {
  return buildAdapterRegistry(platforms.map((p) => ({ PLATFORM: p, _toEnvelope: (row) => row })));
}

// Two equal-recency, equal-everything-else genuine new contacts on the same
// platform; only the injected enrichment differs between them.
function twoEqualContacts() {
  return {
    source_a: [
      env({ thread_id: "dm_anchored", platform: "source_a", sender_id: "+15551110000", sender_name: "Anchored", is_from_me: false, content: "can you review the q3 deck today?", ts: NOW - 1000 }),
      env({ thread_id: "dm_cold", platform: "source_a", sender_id: "+15552220000", sender_name: "Cold", is_from_me: false, content: "can you review the q3 deck today?", ts: NOW - 1000 }),
    ],
  };
}

// ===========================================================================
// 1. The enrichment SHAPE + anchorFactor folding the signals.
// ===========================================================================

test("M1: the NEUTRAL enrichment shape is complete and anchor_factor is the neutral floor", () => {
  assert.deepEqual(Object.keys(NEUTRAL_ENRICHMENT).sort(), [
    "anchor_factor", "feedback_score", "is_contact", "person_id", "reciprocity_strength",
  ]);
  assert.equal(NEUTRAL_ENRICHMENT.anchor_factor, ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL, "neutral enrichment anchor is the neutral floor");
  assert.equal(NEUTRAL_ENRICHMENT.is_contact, false);
  assert.equal(NEUTRAL_ENRICHMENT.reciprocity_strength, 0);
  assert.equal(NEUTRAL_ENRICHMENT.feedback_score, 0);
});

test("M1: anchorFactor with NO signals returns the NEUTRAL factor (1.0, a no-op)", () => {
  assert.equal(anchorFactor({ is_contact: false, reciprocity_strength: 0, feedback_score: 0 }), ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL);
  assert.equal(anchorFactor({}), ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL, "empty enrichment is neutral");
  assert.equal(anchorFactor(null), ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL, "malformed/missing enrichment is total => neutral");
  assert.equal(anchorFactor(undefined), ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL);
});

test("M1: each signal LIFTS the anchor factor above neutral (is_contact / reciprocity / feedback)", () => {
  const NEUTRAL = ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL;
  assert.ok(anchorFactor({ is_contact: true }) > NEUTRAL, "is_contact lifts");
  assert.ok(anchorFactor({ reciprocity_strength: 1 }) > NEUTRAL, "reciprocity_strength lifts");
  assert.ok(anchorFactor({ feedback_score: 1 }) > NEUTRAL, "feedback_score lifts");
  // is_contact lift is exactly the CAPS lift above neutral.
  assert.equal(anchorFactor({ is_contact: true }), NEUTRAL + ANCHOR_CAPS.ANCHOR_CONTACT_LIFT);
});

// ===========================================================================
// 2. MONOTONE: more signals => >= factor; NEVER below the floor; clamped to MAX.
// ===========================================================================

test("M1: anchorFactor is MONOTONE — adding a signal never lowers the factor", () => {
  const none = anchorFactor({});
  const one = anchorFactor({ is_contact: true });
  const two = anchorFactor({ is_contact: true, reciprocity_strength: 1 });
  const three = anchorFactor({ is_contact: true, reciprocity_strength: 1, feedback_score: 1 });
  assert.ok(one >= none, "adding is_contact does not lower");
  assert.ok(two >= one, "adding reciprocity does not lower");
  assert.ok(three >= two, "adding feedback does not lower");
});

test("M1: anchorFactor is MONOTONE in a unit signal — a higher value never lowers the factor", () => {
  let prev = anchorFactor({ reciprocity_strength: 0 });
  for (const v of [0.1, 0.25, 0.5, 0.75, 1.0]) {
    const cur = anchorFactor({ reciprocity_strength: v });
    assert.ok(cur >= prev, `reciprocity_strength=${v} (${cur}) >= prev (${prev})`);
    prev = cur;
  }
});

test("M1: anchorFactor NEVER returns below the NEUTRAL floor (no hard-drop) and is clamped to MAX", () => {
  // Out-of-range / negative signals degrade to zero-signal => neutral, never below.
  assert.equal(anchorFactor({ reciprocity_strength: -5, feedback_score: -1 }), ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL, "negative signals => neutral, never below floor");
  assert.equal(anchorFactor({ reciprocity_strength: Number.NaN }), ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL, "NaN signal => neutral");
  // Every signal maxed must not exceed the CAPS ceiling.
  const maxed = anchorFactor({ is_contact: true, reciprocity_strength: 999, feedback_score: 999 });
  assert.ok(maxed <= ANCHOR_CAPS.ANCHOR_FACTOR_MAX, `maxed factor (${maxed}) clamped to MAX (${ANCHOR_CAPS.ANCHOR_FACTOR_MAX})`);
  assert.ok(maxed >= ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL, "and never below neutral");
});

test("M1: ANCHOR_CAPS is FROZEN (single-producer; weights are tunable DATA, not mutable refs)", () => {
  assert.equal(Object.isFrozen(ANCHOR_CAPS), true, "ANCHOR_CAPS frozen");
  assert.throws(() => { "use strict"; ANCHOR_CAPS.ANCHOR_FACTOR_MAX = 99; }, "cannot mutate a frozen CAPS weight");
});

// ===========================================================================
// 3. normalizeEnrichment + the resolvers are PURE / DETERMINISTIC.
// ===========================================================================

test("M1: normalizeEnrichment stamps the complete frozen shape and recomputes anchor_factor", () => {
  const e = normalizeEnrichment({ is_contact: true, reciprocity_strength: 0.5 }, "person:abc");
  assert.equal(e.person_id, "person:abc");
  assert.equal(e.is_contact, true);
  assert.equal(e.reciprocity_strength, 0.5);
  assert.equal(e.feedback_score, 0, "absent feedback degrades to 0");
  assert.equal(e.anchor_factor, anchorFactor(e), "anchor_factor is recomputed monotone from the signals");
  assert.equal(Object.isFrozen(e), true, "the shape is frozen (read-only projection)");
});

test("M1: makeNeutralEnricher returns anchor_factor=1.0 for EVERY person and is DETERMINISTIC", () => {
  const enrich = makeNeutralEnricher();
  const a = enrich("person:alice");
  const b = enrich("person:alice");
  assert.equal(a.anchor_factor, ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL, "neutral for a known id");
  assert.equal(enrich(null).anchor_factor, ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL, "neutral for a null id");
  assert.equal(enrich("person:bob").anchor_factor, ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL, "neutral for any other id");
  assert.deepEqual(a, b, "same id => identical enrichment (pure / deterministic, no mutable-store coupling)");
});

test("M1: makeEnricherFromIndex is PURE over a precomputed index and SOFT-guards a throwing lookup", () => {
  const index = { "person:vip": { is_contact: true, reciprocity_strength: 1, feedback_score: 1 } };
  const enrich = makeEnricherFromIndex(index, (idx, id) => idx[id] || null);
  const vip1 = enrich("person:vip");
  const vip2 = enrich("person:vip");
  assert.deepEqual(vip1, vip2, "same id => identical enrichment (deterministic)");
  assert.ok(vip1.anchor_factor > ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL, "an anchored person lifts above neutral");
  assert.equal(enrich("person:unknown").anchor_factor, ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL, "an unknown person => neutral (never a drop)");
  // A throwing lookup degrades to neutral (SOFT), never propagates.
  const boom = makeEnricherFromIndex(index, () => { throw new Error("boom"); });
  assert.equal(boom("person:vip").anchor_factor, ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL, "a throwing lookup degrades to neutral");
});

// ===========================================================================
// 4. rankScore folds the anchor in as a monotone UP-rank (neutral default no-op).
// ===========================================================================

test("M1: rankScore with anchor=1 (or absent) is BYTE-IDENTICAL to no anchor; anchor>1 lifts", () => {
  const base = { lastInboundTs: NOW - 1000, directed: 0.9, ageMs: 1000, now: NOW, reciprocated: true };
  const sNoAnchor = rankScore({ ...base });
  const sNeutral = rankScore({ ...base, anchor: 1 });
  const sAnchored = rankScore({ ...base, anchor: 1.5 });
  assert.equal(sNeutral, sNoAnchor, "anchor=1 is a no-op (byte-identical to absent anchor)");
  assert.ok(sAnchored > sNoAnchor, `anchor>1 (${sAnchored}) lifts the score above neutral (${sNoAnchor})`);
  // A <1 / non-finite anchor clamps to neutral 1.0 (never a hard-drop below base).
  assert.equal(rankScore({ ...base, anchor: 0.2 }), sNoAnchor, "an anchor<1 clamps to neutral (never down-ranks)");
  assert.equal(rankScore({ ...base, anchor: Number.NaN }), sNoAnchor, "a NaN anchor clamps to neutral");
});

// ===========================================================================
// 5. DEFAULT-NEUTRAL through buildCatchupCore => BYTE-IDENTICAL to pre-M1.
// ===========================================================================

test("M1: buildCatchupCore with the NEUTRAL enricher is BYTE-IDENTICAL to one with NO enrichPerson", () => {
  const sources = twoEqualContacts();
  const envelopes = sources.source_a;
  const core = (extra) => buildCatchupCore({
    envelopes,
    classify: classifyDirectedAtMe,
    attention: computeAttention,
    now: NOW,
    opts: { min_score: 0.3 },
    ...extra,
  });
  const withoutEnrich = core({});                                  // gate OFF (default)
  const withNeutral = core({ enrichPerson: makeNeutralEnricher() }); // explicit neutral
  assert.deepEqual(
    JSON.parse(JSON.stringify(withNeutral)),
    JSON.parse(JSON.stringify(withoutEnrich)),
    "explicit neutral enricher === absent enricher: ranking byte-identical (gate-OFF safety)",
  );
  // And every surfaced anchor_factor is exactly the neutral 1.0.
  for (const row of withoutEnrich.rows) {
    assert.equal(row.anchor_factor, ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL, "every row's anchor is neutral by default");
  }
});

test("M1: buildCatchup (the wired path) defaults to neutral => byte-identical rows", async () => {
  const sources = twoEqualContacts();
  const a = await buildCatchup({ sources, now: NOW, registry: fixtureRegistry(["source_a"]), min_score: 0.3 });
  const b = await buildCatchup({ sources, now: NOW, registry: fixtureRegistry(["source_a"]), min_score: 0.3, enrichPerson: makeNeutralEnricher() });
  assert.deepEqual(a.rows, b.rows, "default vs explicit-neutral enrichment are byte-identical via buildCatchup");
  assert.ok(a.rows.length >= 2, "both equal contacts surface");
  for (const row of a.rows) assert.equal(row.anchor_factor, ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL);
});

// ===========================================================================
// 6. END-TO-END: an ANCHORED person OUT-RANKS an equal-recency UNANCHORED one
//    when a signal is set; the unanchored row is NEVER dropped.
// ===========================================================================

test("M1 (end-to-end): an ANCHORED person OUT-RANKS an equal-recency UNANCHORED one; the unanchored row survives", async () => {
  const sources = twoEqualContacts();
  // Inject an N7 resolver so the person_id is a stable, KNOWN opaque id we can key
  // the enrichment index on (the enrichment is called on the SAME id used for
  // dedup). This mirrors the production wiring: resolvePerson (N7) -> person_id ->
  // enrichPerson (M1). We anchor ONLY the dm_anchored person.
  const resolvePerson = (platform, senderId) => {
    if (senderId === "+15551110000") return "person:anchored";
    if (senderId === "+15552220000") return "person:cold";
    return null;
  };
  const enrich = makeEnricherFromIndex(
    { "person:anchored": { is_contact: true, reciprocity_strength: 1, feedback_score: 1 } },
    (idx, id) => idx[id] || null,
  );
  const res = buildCatchupCore({
    envelopes: sources.source_a,
    classify: classifyDirectedAtMe,
    attention: computeAttention,
    resolvePerson,
    enrichPerson: enrich,
    now: NOW,
    opts: { min_score: 0.3 },
  });
  const anchored = res.rows.find((r) => r.thread_id === "dm_anchored");
  const cold = res.rows.find((r) => r.thread_id === "dm_cold");
  assert.ok(anchored, "the anchored person surfaces");
  assert.ok(cold, "the UNANCHORED person STILL surfaces (anchor is an up-rank, NEVER a hard-drop)");
  assert.ok(anchored.score > cold.score, `anchored (${anchored.score}) out-ranks equal-recency unanchored (${cold.score})`);
  assert.ok(anchored.anchor_factor > ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL, "anchored row carries a >neutral anchor_factor");
  assert.equal(cold.anchor_factor, ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL, "the unanchored row stays at the neutral floor");
  // The anchored person appears BEFORE the cold one in the ranked output.
  const ai = res.rows.findIndex((r) => r.thread_id === "dm_anchored");
  const ci = res.rows.findIndex((r) => r.thread_id === "dm_cold");
  assert.ok(ai < ci, "the anchored person appears before the unanchored one in the ranked output");
  // The who-matters signals are surfaced on the row (enrichment bundle).
  assert.equal(anchored.enrichment.is_contact, true, "is_contact surfaced on the anchored row");
});

// ===========================================================================
// 7. ABSTRACTION INVARIANT — M1 adds ZERO platform tokens to L2-5.
// ===========================================================================

test("M1: person-enrichment.js + catchup.js carry ZERO platform tokens (the abstraction invariant holds)", () => {
  const files = ["person-enrichment.js", "catchup.js"].map((f) => path.join(LIB_DIR, f));
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
