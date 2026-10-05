// persona-derive-relationship.test.mjs — gate for the RELATIONSHIP facet deriver.
//
// Proves deriveRelationship is a PURE, TOTAL, DETERMINISTIC projection that
// REUSES (never reimplements) the shipped tiering / graded-reciprocity / recency /
// ts-guard rules, and emits exactly { tier, reciprocity_strength, cadence }.
//
// What this proves (mapped to the node acceptance):
//   (a) REUSE is real — a deep two-way PERSON thread folds via reciprocityOfThread,
//       saturates reciprocityStrength to 1, classifies "relationship", recent ts ->
//       "recent"; and the output MATCHES classifyTier/reciprocityStrength run
//       directly on the shared inputs.
//   (b) M5c demotion — a moderate-reciprocity business/service stays "unknown";
//       the sender_kind PERSON gate is load-bearing (a high-reciprocity service is
//       still demoted, the same bundle as a person is promoted).
//   (c) is_contact -> "relationship" regardless of reciprocity.
//   (d) cadence bands recent/regular/dormant by last_ts vs now.
//   (e) implausible / epoch-0 ts is guarded by plausibleTs -> "dormant".
//   (f) TOTALITY — null/undefined/{}/garbage -> {unknown, ~0, dormant}, never throws.
//   (g) DETERMINISM — same input twice deep-equal.
//   (h) NON-MUTATION — a passed envelopes array / bundle object is unchanged.
//   (i) the conservative new-contact NEUTRAL (0.7) is preserved for a real empty
//       thread (the ~0 short-circuit is reserved strictly for unresolved input).
//   (j) ZERO platform tokens in the module source; the reused rules are IMPORTED,
//       not locally redefined.
//
// ESM, node:test + node:assert/strict. Hermetic: NO network, NO DB, NO fs writes
// (reads only in-memory shapes + the lib bytes for the 0-platform-token grep).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import deriveRelationshipDefault, {
  deriveRelationship,
  _capsForTest,
} from "../../lib/messaging/persona-derive-relationship.js";

import { classifyTier } from "../../lib/messaging/person-enrichment.js";
import { reciprocityOfThread } from "../../lib/messaging/attention.js";
import {
  reciprocityStrength,
  recencyFactor,
  plausibleTs,
  MIN_PLAUSIBLE_TS_MS,
  CATCHUP_CAPS,
} from "../../lib/messaging/catchup.js";
import { NEUTRAL_PERSONA } from "../../lib/messaging/persona.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_SRC = path.resolve(
  __dirname,
  "../../lib/messaging/persona-derive-relationship.js",
);

const NOW = 1700010000000; // 2023-11, a plausible message time
const DAY = 24 * 60 * 60 * 1000;

// Build a ts-ascending DM thread from a list of directions (is_from_me booleans),
// the last message landing `endOffsetMs` before `now`.
function thread(directions, now = NOW, endOffsetMs = 1000) {
  const n = directions.length;
  return directions.map((fromMe, i) => ({
    is_from_me: fromMe === true,
    ts: now - endOffsetMs - (n - 1 - i) * 1000,
    content: "hi",
  }));
}

// A deep two-way PERSON history: alternating in/out, 6 turns, last touch ~recent.
const DEEP_DIRECTIONS = [false, true, false, true, false, true, false];

// The exact facet a derived relationship must shape-match.
function assertFacetShape(facet, label) {
  assert.deepEqual(
    Object.keys(facet).sort(),
    ["cadence", "reciprocity_strength", "tier"],
    `${label}: exactly {tier, reciprocity_strength, cadence}`,
  );
  assert.equal(Object.isFrozen(facet), true, `${label}: facet is frozen`);
  assert.equal(
    typeof facet.tier === "string" && facet.tier.length > 0,
    true,
    `${label}: tier is a non-empty string`,
  );
  assert.equal(
    ["relationship", "unknown"].includes(facet.tier),
    true,
    `${label}: tier in {relationship, unknown}`,
  );
  assert.equal(
    ["recent", "regular", "dormant"].includes(facet.cadence),
    true,
    `${label}: cadence in {recent, regular, dormant}`,
  );
  assert.equal(
    typeof facet.reciprocity_strength === "number" &&
      Number.isFinite(facet.reciprocity_strength) &&
      facet.reciprocity_strength >= 0 &&
      facet.reciprocity_strength <= 1,
    true,
    `${label}: reciprocity_strength is finite in [0,1]`,
  );
}

// ---------------------------------------------------------------------------
// (a) REUSE — a deep two-way PERSON thread tiers "relationship", strength -> 1,
//     recent ts -> "recent", and the output MATCHES the reused functions exactly.
// ---------------------------------------------------------------------------
test("deep two-way PERSON thread -> relationship/1/recent; output matches reused fns", () => {
  const envelopes = thread(DEEP_DIRECTIONS);
  const out = deriveRelationship(envelopes, { sender_kind: "person", now: NOW });
  assertFacetShape(out, "deep-person");

  assert.equal(out.tier, "relationship", "deep PERSON history tiers relationship");
  assert.equal(out.reciprocity_strength, 1, "deep history saturates strength to 1");
  assert.equal(out.cadence, "recent", "a fresh last touch is recent");

  // Reuse is REAL: the deriver's numbers are exactly what the shipped functions
  // produce on the SAME inputs — not an independent reimplementation.
  const bundle = reciprocityOfThread(envelopes);
  assert.equal(bundle.turn_count, 6, "reciprocityOfThread folds 6 turns");
  const expectStrength = reciprocityStrength(bundle);
  const expectTier = classifyTier(
    {
      is_contact: undefined,
      reciprocity_strength: expectStrength,
      feedback_score: undefined,
      sender_kind: "person",
    },
    { recip_min: CATCHUP_CAPS.RELATIONSHIP_RECIP_MIN },
  );
  assert.equal(out.reciprocity_strength, expectStrength, "strength == reciprocityStrength(bundle)");
  assert.equal(out.tier, expectTier, "tier == classifyTier(...) on shared inputs");

  // The {envelopes:[...]} wrapper folds identically.
  const wrapped = deriveRelationship({ envelopes }, { sender_kind: "person", now: NOW });
  assert.deepEqual(wrapped, out, "{envelopes:[...]} folds identically to a raw array");

  // A pre-folded counts bundle reaches the same place as the raw envelopes.
  const fromBundle = deriveRelationship(bundle, { sender_kind: "person", now: NOW });
  assert.deepEqual(fromBundle, out, "a counts bundle derives identically to its envelopes");
});

// ---------------------------------------------------------------------------
// (b) M5c — a moderate-reciprocity business/service stays "unknown"; the
//     sender_kind PERSON gate is load-bearing.
// ---------------------------------------------------------------------------
test("moderate-reciprocity service -> unknown (M5c demotion)", () => {
  const moderate = {
    turn_count: 3,
    outbound_count: 2,
    inbound_count: 2,
    last_outbound_ts: NOW - 1000,
  };
  const out = deriveRelationship(moderate, { sender_kind: "service", now: NOW });
  assertFacetShape(out, "moderate-service");

  assert.equal(out.tier, "unknown", "moderate reciprocity below the high gate -> unknown");
  // strength sits in the graded band: above the new-contact neutral, below the gate.
  assert.equal(out.reciprocity_strength > 0.7, true, "moderate strength above neutral");
  assert.equal(
    out.reciprocity_strength < CATCHUP_CAPS.RELATIONSHIP_RECIP_MIN,
    true,
    "moderate strength below the M5c high gate (0.9)",
  );
});

test("sender_kind gate is load-bearing: a HIGH-reciprocity service is still demoted", () => {
  const deep = {
    turn_count: 8,
    outbound_count: 5,
    inbound_count: 6,
    last_outbound_ts: NOW - 1000,
  };
  const asService = deriveRelationship(deep, { sender_kind: "service", now: NOW });
  const asPerson = deriveRelationship(deep, { sender_kind: "person", now: NOW });

  assert.equal(asService.reciprocity_strength, 1, "deep history saturates regardless of kind");
  assert.equal(asPerson.reciprocity_strength, 1, "same bundle, same strength");
  assert.equal(asService.tier, "unknown", "a service is demoted even at full reciprocity");
  assert.equal(asPerson.tier, "relationship", "the same bundle as a PERSON is a relationship");
});

// ---------------------------------------------------------------------------
// (c) is_contact -> relationship regardless of reciprocity.
// ---------------------------------------------------------------------------
test("is_contact:true -> relationship regardless of reciprocity", () => {
  const out = deriveRelationship({}, { is_contact: true, now: NOW });
  assertFacetShape(out, "is-contact");
  assert.equal(out.tier, "relationship", "an explicit saved-contact vouch tiers relationship");
  assert.equal(out.reciprocity_strength, 0, "unresolved input keeps strength at 0");

  // Positive operator feedback is also a vouch (no reciprocity, no contact flag).
  const byFeedback = deriveRelationship({}, { feedback_score: 1, now: NOW });
  assert.equal(byFeedback.tier, "relationship", "positive feedback tiers relationship");
});

// ---------------------------------------------------------------------------
// (d) cadence bands recent / regular / dormant from last_ts vs now.
// ---------------------------------------------------------------------------
test("cadence bands recent / regular / dormant by last_ts vs now", () => {
  const recent = deriveRelationship({}, { last_ts: NOW, now: NOW });
  const regular = deriveRelationship({}, { last_ts: NOW - 4 * DAY, now: NOW });
  const dormant = deriveRelationship({}, { last_ts: NOW - 30 * DAY, now: NOW });

  assert.equal(recent.cadence, "recent", "a same-instant touch is recent");
  assert.equal(regular.cadence, "regular", "a mid-window touch is regular");
  assert.equal(dormant.cadence, "dormant", "a long-decayed touch is dormant");

  // The bands are a faithful coarsening of the REUSED recencyFactor.
  assert.equal(recencyFactor(NOW, NOW) >= _capsForTest.RECENT_MIN, true, "recent band tracks recencyFactor");
  assert.equal(
    recencyFactor(NOW - 30 * DAY, NOW) <= _capsForTest.DORMANT_MAX,
    true,
    "dormant band tracks recencyFactor",
  );
  // The dormant edge sits just above the shared recency floor (so an absent ts,
  // pinned to the floor, always lands dormant) — provenance, not a second copy.
  assert.equal(_capsForTest.DORMANT_MAX > _capsForTest.RECENCY_FLOOR, true, "dormant edge above the recency floor");
  assert.equal(_capsForTest.RECENCY_FLOOR, CATCHUP_CAPS.RECENCY_FLOOR, "reuses the catchup recency floor");
  assert.equal(_capsForTest.MIN_PLAUSIBLE_TS_MS, MIN_PLAUSIBLE_TS_MS, "reuses the catchup plausibility floor");
});

// ---------------------------------------------------------------------------
// (e) implausible / epoch-0 ts is guarded by plausibleTs -> dormant.
// ---------------------------------------------------------------------------
test("implausible / epoch-0 ts is guarded -> dormant", () => {
  for (const badTs of [0, -1, MIN_PLAUSIBLE_TS_MS - 1, Number.NaN, NOW + 10 * DAY]) {
    const out = deriveRelationship({}, { last_ts: badTs, now: NOW });
    assert.equal(out.cadence, "dormant", `ts ${String(badTs)} guarded to dormant`);
    // The guard the deriver uses IS the shipped plausibleTs.
    assert.equal(plausibleTs(badTs, NOW), null, `plausibleTs rejects ${String(badTs)}`);
  }
  // A bundle whose only ts is epoch-0 also reads dormant (guard, not a literal).
  const out = deriveRelationship(
    { turn_count: 2, outbound_count: 1, inbound_count: 1, last_outbound_ts: 0 },
    { now: NOW },
  );
  assert.equal(out.cadence, "dormant", "a bundle's epoch-0 last_outbound_ts -> dormant");
});

// ---------------------------------------------------------------------------
// (f) TOTALITY — null/undefined/{}/garbage -> {unknown, ~0, dormant}, never throws.
// ---------------------------------------------------------------------------
test("totality: unresolved input -> {unknown, 0, dormant}, never throws", () => {
  const NEUTRAL = { tier: "unknown", reciprocity_strength: 0, cadence: "dormant" };
  const unresolved = [
    null,
    undefined,
    {},
    42,
    "garbage",
    true,
    { foo: "bar" }, // a plain object with NO count fields
    Number.NaN,
  ];
  for (const input of unresolved) {
    let out;
    assert.doesNotThrow(() => {
      out = deriveRelationship(input);
    }, `deriveRelationship(${String(input)}) must not throw`);
    assertFacetShape(out, `unresolved:${String(input)}`);
    assert.deepEqual(out, NEUTRAL, `unresolved ${String(input)} -> {unknown, 0, dormant}`);
  }
  // Odd opts must also be tolerated (never throws, neutral cadence).
  assert.doesNotThrow(() => deriveRelationship(null, 7));
  assert.doesNotThrow(() => deriveRelationship(null, null));
  assert.deepEqual(deriveRelationship(null, "x"), NEUTRAL, "odd opts -> neutral facet");

  // The default export is the same function.
  assert.equal(deriveRelationshipDefault, deriveRelationship, "default export === named export");
});

// ---------------------------------------------------------------------------
// (i) Conservative new-contact NEUTRAL (0.7) preserved for a REAL empty thread —
//     the ~0 short-circuit is reserved strictly for UNRESOLVED input.
// ---------------------------------------------------------------------------
test("a real empty/zero thread keeps the new-contact NEUTRAL (0.7), distinct from unresolved 0", () => {
  // An empty envelopes ARRAY is a real (if empty) thread -> RESOLVED -> the reused
  // reciprocityStrength returns the conservative NEW_CONTACT neutral, NOT 0.
  const emptyThread = deriveRelationship([], { sender_kind: "person", now: NOW });
  assert.equal(
    emptyThread.reciprocity_strength,
    reciprocityStrength(reciprocityOfThread([])),
    "empty thread strength == reciprocityStrength(zero bundle) (the NEUTRAL, ~0.7)",
  );
  assert.equal(emptyThread.reciprocity_strength > 0, true, "a real empty thread is NOT ~0");
  assert.equal(emptyThread.tier, "unknown", "a brand-new contact is still honestly unknown");

  // A genuine first-contact bundle (one inbound, no turns) keeps the neutral too.
  const newContact = deriveRelationship(
    { turn_count: 0, outbound_count: 0, inbound_count: 1 },
    { sender_kind: "person", now: NOW },
  );
  assert.equal(
    newContact.reciprocity_strength,
    CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL,
    "first-contact bundle keeps the new-contact neutral",
  );

  // Contrast: UNRESOLVED input (a non-thread) is the ONLY thing that yields ~0.
  assert.equal(deriveRelationship({}).reciprocity_strength, 0, "unresolved {} -> strength 0");
});

// ---------------------------------------------------------------------------
// (g) DETERMINISM — same input twice deep-equal.
// ---------------------------------------------------------------------------
test("determinism: same input twice -> deep-equal output", () => {
  const envelopes = thread(DEEP_DIRECTIONS);
  const a = deriveRelationship(envelopes, { sender_kind: "person", now: NOW });
  const b = deriveRelationship(envelopes, { sender_kind: "person", now: NOW });
  assert.deepEqual(a, b, "envelopes input is deterministic");

  const bundle = { turn_count: 3, outbound_count: 2, inbound_count: 2, last_outbound_ts: NOW - 2 * DAY };
  assert.deepEqual(
    deriveRelationship(bundle, { sender_kind: "service", now: NOW }),
    deriveRelationship(bundle, { sender_kind: "service", now: NOW }),
    "bundle input is deterministic",
  );
});

// ---------------------------------------------------------------------------
// (h) NON-MUTATION — a passed envelopes array / bundle object is unchanged.
// ---------------------------------------------------------------------------
test("non-mutation: inputs are never mutated", () => {
  const envelopes = thread(DEEP_DIRECTIONS);
  const envBefore = structuredClone(envelopes);
  deriveRelationship(envelopes, { sender_kind: "person", now: NOW });
  assert.deepEqual(envelopes, envBefore, "envelopes array unchanged after the call");

  const bundle = { turn_count: 3, outbound_count: 2, inbound_count: 2, last_outbound_ts: NOW - 2 * DAY };
  const bundleBefore = structuredClone(bundle);
  deriveRelationship(bundle, { sender_kind: "service", now: NOW });
  assert.deepEqual(bundle, bundleBefore, "bundle object unchanged after the call");

  const opts = { sender_kind: "person", is_contact: true, last_ts: NOW, now: NOW };
  const optsBefore = structuredClone(opts);
  deriveRelationship(bundle, opts);
  assert.deepEqual(opts, optsBefore, "opts object unchanged after the call");
});

// ---------------------------------------------------------------------------
// Contract conformance: the facet shape matches NEUTRAL_PERSONA.relationship.
// ---------------------------------------------------------------------------
test("facet shape matches NEUTRAL_PERSONA.relationship", () => {
  const out = deriveRelationship({}, { now: NOW });
  assert.deepEqual(
    Object.keys(out).sort(),
    Object.keys(NEUTRAL_PERSONA.relationship).sort(),
    "facet keys == NEUTRAL_PERSONA.relationship keys",
  );
});

// ---------------------------------------------------------------------------
// (j) ZERO platform tokens; the reused rules are IMPORTED, not redefined.
// ---------------------------------------------------------------------------
test("module carries ZERO platform tokens (the abstraction invariant holds)", () => {
  const src = readFileSync(MODULE_SRC, "utf8");
  const tokens = ["whatsapp", "imessage", "telegram", "slack", "signal", "mail", "gmail", "outlook"];
  for (const tok of tokens) {
    assert.equal(
      src.toLowerCase().includes(tok),
      false,
      `persona-derive-relationship.js must not contain the platform token "${tok}"`,
    );
  }
});

test("the tiering / reciprocity / recency / ts-guard rules are IMPORTED, not reimplemented", () => {
  const src = readFileSync(MODULE_SRC, "utf8");
  // Imported from their source modules.
  assert.match(src, /import\s*\{\s*classifyTier\s*\}\s*from\s*"\.\/person-enrichment\.js"/, "classifyTier imported");
  assert.match(src, /import\s*\{\s*reciprocityOfThread\s*\}\s*from\s*"\.\/attention\.js"/, "reciprocityOfThread imported");
  assert.match(src, /reciprocityStrength/, "reciprocityStrength referenced (imported from catchup)");
  assert.match(src, /recencyFactor/, "recencyFactor referenced (imported from catchup)");
  assert.match(src, /plausibleTs/, "plausibleTs referenced (imported from catchup)");
  assert.match(src, /MIN_PLAUSIBLE_TS_MS/, "MIN_PLAUSIBLE_TS_MS referenced (imported from catchup)");
  assert.match(src, /CATCHUP_CAPS/, "CATCHUP_CAPS referenced (imported from catchup)");
  // NOT locally redefined (no second copy of any rule).
  for (const fn of ["classifyTier", "reciprocityStrength", "recencyFactor", "reciprocityOfThread", "plausibleTs"]) {
    assert.equal(
      new RegExp(`function\\s+${fn}\\b`).test(src),
      false,
      `${fn} must NOT be locally redefined`,
    );
  }
});
