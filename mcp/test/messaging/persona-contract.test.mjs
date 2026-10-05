// persona-contract.test.mjs — the PERSONA CONTRACT gate (the spine of the
// who-matters PERSON model). Proves the four invariants the contract exists to
// protect, mirroring the m1-person-enrichment gate:
//   - NEUTRAL_PERSONA is deeply frozen AND the byte-identical normalize default.
//   - normalizePersona is TOTAL over malformed input (null / number / string /
//     array-where-object-expected / non-string scalars / non-array arrays):
//     never throws, always returns a complete deeply-frozen shape.
//   - mergePersona is ADDITIVE-MONOTONE: every result array is the dedup union
//     (superset) of both inputs; a present base scalar is never overwritten by a
//     neutral/null patch scalar; an absent base scalar is filled from patch.
//   - Determinism, input-not-mutated, and a stateless default resolver.
//   - ZERO platform tokens in the module source (the abstraction invariant).
//
// ESM, node:test + node:assert/strict. Hermetic: NO network, NO DB, NO fs writes
// (reads only in-memory shapes + the lib bytes for the 0-platform-token grep).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  NEUTRAL_PERSONA,
  normalizePersona,
  mergePersona,
  makeNeutralPersonaResolver,
} from "../../lib/messaging/persona.js";

import * as personaModule from "../../lib/messaging/persona.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSONA_SRC = path.resolve(__dirname, "../../lib/messaging/persona.js");

// Assert every nested object + array in a persona is Object.frozen.
function assertDeeplyFrozen(p, label) {
  assert.equal(Object.isFrozen(p), true, `${label}: root frozen`);
  assert.equal(Object.isFrozen(p.identity), true, `${label}: identity frozen`);
  assert.equal(Object.isFrozen(p.identity.handles), true, `${label}: identity.handles frozen`);
  assert.equal(Object.isFrozen(p.identity.platforms), true, `${label}: identity.platforms frozen`);
  assert.equal(Object.isFrozen(p.relationship), true, `${label}: relationship frozen`);
  assert.equal(Object.isFrozen(p.arc), true, `${label}: arc frozen`);
  assert.equal(Object.isFrozen(p.topics), true, `${label}: topics frozen`);
  assert.equal(Object.isFrozen(p.salient), true, `${label}: salient frozen`);
}

// ===========================================================================
// 1. EXPORTS — exactly the four contract symbols.
// ===========================================================================
test("persona: exports exactly the four contract symbols", () => {
  const keys = Object.keys(personaModule).sort();
  assert.deepEqual(keys, [
    "NEUTRAL_PERSONA",
    "makeNeutralPersonaResolver",
    "mergePersona",
    "normalizePersona",
  ]);
});

// ===========================================================================
// 2. NEUTRAL_PERSONA — deeply frozen + the byte-identical default.
// ===========================================================================
test("persona: NEUTRAL_PERSONA is deeply frozen with the full empty/neutral shape", () => {
  assertDeeplyFrozen(NEUTRAL_PERSONA, "NEUTRAL_PERSONA");
  assert.deepEqual(NEUTRAL_PERSONA, {
    person_id: null,
    identity: { display_name: null, handles: [], platforms: [] },
    relationship: { tier: null, reciprocity_strength: 0, cadence: null },
    role: null,
    topics: [],
    salient: [],
    arc: { last_ts: null, gist: null, trend: null },
  });
});

test("persona: normalize of empty/missing input is byte-identical to NEUTRAL_PERSONA", () => {
  assert.equal(JSON.stringify(normalizePersona({})), JSON.stringify(NEUTRAL_PERSONA));
  assert.equal(JSON.stringify(normalizePersona(undefined)), JSON.stringify(NEUTRAL_PERSONA));
  assert.deepEqual(normalizePersona(null), NEUTRAL_PERSONA);
});

// ===========================================================================
// 3. normalize TOTALITY — over null / number / string / array-swapped / odd.
// ===========================================================================
test("persona: normalize is TOTAL over malformed inputs (never throws, complete frozen shape)", () => {
  const oddInputs = [null, undefined, 42, "a string", [], [1, 2, 3], true, NaN, () => {}];
  for (const bad of oddInputs) {
    let out;
    assert.doesNotThrow(() => {
      out = normalizePersona(bad);
    }, `normalizePersona(${String(bad)}) must not throw`);
    assertDeeplyFrozen(out, `normalize(${String(bad)})`);
    // Complete shape with every facet at neutral.
    assert.deepEqual(out, NEUTRAL_PERSONA);
  }
});

test("persona: normalize degrades array-where-object-expected and non-array-where-array-expected", () => {
  const out = normalizePersona({
    identity: ["not", "an", "object"], // object expected -> {} -> all neutral
    relationship: "nope", // object expected
    arc: 123, // object expected
    topics: "not-an-array", // array expected -> []
    salient: { not: "array" }, // array expected -> []
    handles: "stringHandles",
  });
  assert.deepEqual(out, NEUTRAL_PERSONA);
  assertDeeplyFrozen(out, "array-swapped");
});

test("persona: normalize dedups arrays (stable) and drops non-string / empty members", () => {
  const out = normalizePersona({
    identity: { handles: ["h1", "h1", "h2", 7, null, "", "h3", "h2"], platforms: ["p", "p"] },
    topics: ["t", "", "t", "u", false],
    salient: ["s1", "s1"],
  });
  assert.deepEqual(out.identity.handles, ["h1", "h2", "h3"]);
  assert.deepEqual(out.identity.platforms, ["p"]);
  assert.deepEqual(out.topics, ["t", "u"]);
  assert.deepEqual(out.salient, ["s1"]);
});

test("persona: normalize degrades non-string scalars to null and clamps reciprocity to [0,1]", () => {
  const hi = normalizePersona({
    identity: { display_name: 99 },
    relationship: { tier: {}, reciprocity_strength: 1.7, cadence: [] },
    role: 5,
    arc: { gist: true, trend: 3, last_ts: Infinity },
  });
  assert.equal(hi.identity.display_name, null);
  assert.equal(hi.relationship.tier, null);
  assert.equal(hi.relationship.cadence, null);
  assert.equal(hi.relationship.reciprocity_strength, 1); // clamped from 1.7
  assert.equal(hi.role, null);
  assert.equal(hi.arc.gist, null);
  assert.equal(hi.arc.trend, null);
  assert.equal(hi.arc.last_ts, null); // Infinity is not finite -> null

  const lo = normalizePersona({ relationship: { reciprocity_strength: -3 } });
  assert.equal(lo.relationship.reciprocity_strength, 0); // clamped from -3

  const mid = normalizePersona({ relationship: { reciprocity_strength: 0.42 }, arc: { last_ts: 1700000000000 } });
  assert.equal(mid.relationship.reciprocity_strength, 0.42);
  assert.equal(mid.arc.last_ts, 1700000000000);
});

test("persona: normalize person_id falls back from raw -> arg -> null", () => {
  assert.equal(normalizePersona({ person_id: "from-raw" }, "from-arg").person_id, "from-raw");
  assert.equal(normalizePersona({ person_id: "" }, "from-arg").person_id, "from-arg");
  assert.equal(normalizePersona({}, "from-arg").person_id, "from-arg");
  assert.equal(normalizePersona({}).person_id, null);
  assert.equal(normalizePersona({ person_id: 123 }, 456).person_id, null);
});

// ===========================================================================
// 4. mergePersona — ADDITIVE-MONOTONE (superset arrays, fill-only scalars).
// ===========================================================================
test("persona: merge unions+dedups every array into a SUPERSET of both inputs", () => {
  const base = {
    identity: { handles: ["a", "b"], platforms: ["p1"] },
    topics: ["t1", "t2"],
    salient: ["s1"],
  };
  const patch = {
    identity: { handles: ["b", "c"], platforms: ["p2"] },
    topics: ["t2", "t3"],
    salient: ["s2"],
  };
  const out = mergePersona(base, patch);
  assert.deepEqual(out.identity.handles, ["a", "b", "c"]); // base order first
  assert.deepEqual(out.identity.platforms, ["p1", "p2"]);
  assert.deepEqual(out.topics, ["t1", "t2", "t3"]);
  assert.deepEqual(out.salient, ["s1", "s2"]);

  // SUPERSET: every member of both inputs survives (never a drop).
  for (const h of ["a", "b", "c"]) assert.ok(out.identity.handles.includes(h));
});

test("persona: merge fills an ABSENT base scalar from patch", () => {
  const base = {}; // all scalars neutral
  const patch = {
    person_id: "pid",
    identity: { display_name: "Ada" },
    relationship: { tier: "relationship", reciprocity_strength: 0.8, cadence: "weekly" },
    role: "collaborator",
    arc: { last_ts: 1700000000000, gist: "kicked off the project", trend: "rising" },
  };
  const out = mergePersona(base, patch);
  assert.equal(out.person_id, "pid");
  assert.equal(out.identity.display_name, "Ada");
  assert.equal(out.relationship.tier, "relationship");
  assert.equal(out.relationship.reciprocity_strength, 0.8);
  assert.equal(out.relationship.cadence, "weekly");
  assert.equal(out.role, "collaborator");
  assert.equal(out.arc.last_ts, 1700000000000);
  assert.equal(out.arc.gist, "kicked off the project");
  assert.equal(out.arc.trend, "rising");
});

test("persona: merge NEVER overwrites a present base scalar with a neutral/null patch", () => {
  const base = {
    person_id: "pid-base",
    identity: { display_name: "Base Name" },
    relationship: { tier: "relationship", reciprocity_strength: 0.3, cadence: "daily" },
    role: "lead",
    arc: { last_ts: 100, gist: "base gist", trend: "steady" },
  };
  const patch = {}; // entirely neutral -> must NOT clobber any base scalar
  const out = mergePersona(base, patch);
  assert.equal(out.person_id, "pid-base");
  assert.equal(out.identity.display_name, "Base Name");
  assert.equal(out.relationship.tier, "relationship");
  assert.equal(out.relationship.reciprocity_strength, 0.3);
  assert.equal(out.relationship.cadence, "daily");
  assert.equal(out.role, "lead");
  assert.equal(out.arc.last_ts, 100);
  assert.equal(out.arc.gist, "base gist");
  assert.equal(out.arc.trend, "steady");
});

test("persona: merge does not overwrite a present base scalar even with a present patch value", () => {
  const base = { role: "x", relationship: { reciprocity_strength: 0.3 } };
  const patch = { role: "y", relationship: { reciprocity_strength: 0.9 } };
  const out = mergePersona(base, patch);
  assert.equal(out.role, "x"); // base wins (fill-only-if-absent)
  assert.equal(out.relationship.reciprocity_strength, 0.3); // base wins
});

test("persona: merge fills reciprocity when base is the 0 neutral", () => {
  const out = mergePersona({ relationship: { reciprocity_strength: 0 } }, { relationship: { reciprocity_strength: 0.5 } });
  assert.equal(out.relationship.reciprocity_strength, 0.5);
});

test("persona: merge result is deeply frozen", () => {
  const out = mergePersona({ topics: ["a"] }, { topics: ["b"] });
  assertDeeplyFrozen(out, "merge result");
});

test("persona: merge is deterministic (same inputs => deep-equal output)", () => {
  const base = { identity: { handles: ["a"] }, topics: ["t1"], role: "r" };
  const patch = { identity: { handles: ["b"] }, topics: ["t2"], relationship: { tier: "relationship" } };
  assert.deepEqual(mergePersona(base, patch), mergePersona(base, patch));
});

// ===========================================================================
// 5. INPUTS NOT MUTATED — deep-equal snapshot before vs after.
// ===========================================================================
test("persona: normalize and merge never mutate their inputs", () => {
  const raw = {
    person_id: "pid",
    identity: { display_name: "Ada", handles: ["a", "a", "b"], platforms: ["p"] },
    relationship: { tier: "relationship", reciprocity_strength: 0.5, cadence: "weekly" },
    role: "lead",
    topics: ["t1", "t1"],
    salient: ["s1"],
    arc: { last_ts: 100, gist: "g", trend: "rising" },
  };
  const snapshot = structuredClone(raw);
  normalizePersona(raw);
  assert.deepEqual(raw, snapshot, "normalize must not mutate input");

  const base = structuredClone(raw);
  const patch = { identity: { handles: ["c"] }, topics: ["t2"] };
  const baseSnap = structuredClone(base);
  const patchSnap = structuredClone(patch);
  mergePersona(base, patch);
  assert.deepEqual(base, baseSnap, "merge must not mutate base");
  assert.deepEqual(patch, patchSnap, "merge must not mutate patch");
});

// ===========================================================================
// 6. DEFAULT RESOLVER — pure, stateless, carries the id.
// ===========================================================================
test("persona: makeNeutralPersonaResolver is pure/stateless and carries the id", () => {
  const resolve = makeNeutralPersonaResolver();
  const a = resolve("pid-1");
  const b = resolve("pid-1");
  assert.deepEqual(a, b, "same id => deep-equal persona");
  assert.equal(a.person_id, "pid-1");
  assertDeeplyFrozen(a, "resolved persona");
  // Otherwise NEUTRAL-shaped (only the id differs).
  assert.deepEqual({ ...a, person_id: null }, NEUTRAL_PERSONA);

  // Empty/odd id => the shared NEUTRAL_PERSONA itself.
  assert.equal(resolve(""), NEUTRAL_PERSONA);
  assert.equal(resolve(null), NEUTRAL_PERSONA);
  assert.equal(resolve(42), NEUTRAL_PERSONA);

  // Closes over no mutable state: a fresh resolver yields the same output.
  const resolve2 = makeNeutralPersonaResolver();
  assert.deepEqual(resolve2("pid-1"), a);
});

// ===========================================================================
// 7. ABSTRACTION INVARIANT — ZERO platform tokens in the module source.
// ===========================================================================
test("persona: persona.js carries ZERO platform-name tokens (the abstraction invariant holds)", () => {
  const src = readFileSync(PERSONA_SRC, "utf8");
  const tokens = ["whatsapp", "imessage", "telegram", "slack", "signal", "mail", "gmail", "outlook"];
  for (const tok of tokens) {
    assert.equal(
      src.toLowerCase().includes(tok),
      false,
      `persona.js must not contain the platform token "${tok}"`,
    );
  }
});
