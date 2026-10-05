// persona-derive-identity.test.mjs — the IDENTITY-facet DERIVER gate.
//
// Proves deriveIdentity is the PURE, TOTAL, DETERMINISTIC, NON-MUTATING,
// platform-OPAQUE projection the spec demands. It derives ONE person's
//     identity { display_name, handles[], platforms[] }
// from a pre-built PersonIndex + saved-contact maps, wrapped in the canonical
// normalizePersona SHAPE (every other facet neutral). The assertions are
// non-tautological — each pins a behavior the spec names:
//   - display_name precedence: saved contact (phone OR email) > envelope names[0] > null
//   - handles = dedup UNION of ids[].sender_id + cross_links[].norm + handlesForPerson
//   - platforms = distinct & OPAQUE (swap-invariant: no branch on a platform value)
//   - TOTAL/defensive over null/odd/missing/malformed input (never throws)
//   - determinism, input non-mutation, deeply-frozen normalizePersona shape
//   - ABSTRACTION INVARIANT: zero platform-name tokens in the deriver source,
//     excluding the legitimately-reused _imessage-name-recovery connector path
//     (the same carve-out contacts-anchor.js relies on).
//
// ESM, node:test + node:assert/strict. HERMETIC: no network, no DB, no fs writes.
// The ONLY fs op is readFileSync of the deriver's own bytes for the token grep,
// mirroring persona-contract.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { deriveIdentity } from "../../lib/messaging/persona-derive-identity.js";
import { NEUTRAL_PERSONA } from "../../lib/messaging/persona.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DERIVER_SRC = path.resolve(
  __dirname,
  "../../lib/messaging/persona-derive-identity.js",
);

// ---------------------------------------------------------------------------
// Fixture helpers — build a getPerson-shaped index ENTIRELY in memory.
// getPerson only needs index.persons to be a Map<person_id, PersonRecord> with
// PersonRecord = { person_id, ids:[{platform,sender_id}], cross_links:[{kind,norm}],
// names:[], is_operator }. Platform tokens are FAKE/opaque ('PLAT_A', ...).
// ---------------------------------------------------------------------------
function makeIndex(records) {
  const persons = new Map();
  for (const r of records) persons.set(r.person_id, r);
  return { persons, lookup: new Map() };
}

// The neutral (gate-OFF) values for every facet OTHER than identity — used to
// prove the deriver populates identity ONLY and leaves the rest byte-neutral.
const NEUTRAL_NON_IDENTITY = {
  relationship: { tier: null, reciprocity_strength: 0, cadence: null },
  role: null,
  topics: [],
  salient: [],
  arc: { last_ts: null, gist: null, trend: null },
};

function assertNonIdentityNeutral(p, label) {
  assert.deepEqual(p.relationship, NEUTRAL_NON_IDENTITY.relationship, `${label}: relationship neutral`);
  assert.equal(p.role, NEUTRAL_NON_IDENTITY.role, `${label}: role neutral`);
  assert.deepEqual(p.topics, NEUTRAL_NON_IDENTITY.topics, `${label}: topics neutral`);
  assert.deepEqual(p.salient, NEUTRAL_NON_IDENTITY.salient, `${label}: salient neutral`);
  assert.deepEqual(p.arc, NEUTRAL_NON_IDENTITY.arc, `${label}: arc neutral`);
}

// ===========================================================================
// (a) PHONE saved-contact hit — display_name from phoneToName, beating envelope.
//     The contactMaps key is UN-normalized ('+1 (555) 123-4567') to prove the
//     normalizer-fold match (normalizePhone collapses it to the lookup key).
// ===========================================================================
test("display_name: saved phone-contact name WINS over the envelope names[0]", () => {
  const index = makeIndex([
    {
      person_id: "person:phone",
      ids: [{ platform: "PLAT_A", sender_id: "+15551234567" }],
      cross_links: [],
      names: ["Envelope Name"], // present, but must LOSE to the saved contact
      is_operator: false,
    },
  ]);
  const contactMaps = {
    phoneToName: new Map([["+1 (555) 123-4567", "Saved Phone Name"]]),
    emailToName: new Map(),
  };
  const handlesByPerson = new Map([["person:phone", []]]); // suppress soft-fallback

  const p = deriveIdentity("person:phone", { index, contactMaps, handlesByPerson });
  assert.equal(p.identity.display_name, "Saved Phone Name");
  // Non-tautological: it is NOT merely echoing the envelope name.
  assert.notEqual(p.identity.display_name, "Envelope Name");
  assert.deepEqual(p.identity.handles, ["+15551234567"]);
  assert.deepEqual(p.identity.platforms, ["PLAT_A"]);
  assert.equal(p.person_id, "person:phone");
});

// ===========================================================================
// (b) EMAIL saved-contact hit — display_name from emailToName. The key is raw
//     ('Jane@Example.com ' — mixed case + trailing space) to prove normalizeEmail
//     (lower+trim) folds it to the same lookup key as the handle.
// ===========================================================================
test("display_name: saved email-contact name WINS over the envelope names[0]", () => {
  const index = makeIndex([
    {
      person_id: "person:email",
      ids: [{ platform: "PLAT_B", sender_id: "jane@example.com" }],
      cross_links: [],
      names: ["Envelope Name"],
      is_operator: false,
    },
  ]);
  const contactMaps = {
    phoneToName: new Map(),
    emailToName: new Map([["Jane@Example.com ", "Saved Email Name"]]),
  };
  const handlesByPerson = new Map([["person:email", []]]);

  const p = deriveIdentity("person:email", { index, contactMaps, handlesByPerson });
  assert.equal(p.identity.display_name, "Saved Email Name");
  assert.notEqual(p.identity.display_name, "Envelope Name");
  assert.deepEqual(p.identity.handles, ["jane@example.com"]);
});

// ===========================================================================
// (c) No saved contact, but an envelope name present => names[0].
// ===========================================================================
test("display_name: with no saved contact, falls back to the envelope names[0]", () => {
  const index = makeIndex([
    {
      person_id: "person:env",
      ids: [{ platform: "PLAT_A", sender_id: "+15559990000" }],
      cross_links: [],
      names: ["Envelope Only", "Second Name"], // [0] wins
      is_operator: false,
    },
  ]);
  // contactMaps present but with a NON-matching key — proves the contact branch
  // is genuinely missed (not absent), so the names[0] fallback is exercised.
  const contactMaps = {
    phoneToName: new Map([["+19998887777", "Someone Else"]]),
    emailToName: new Map(),
  };
  const handlesByPerson = new Map([["person:env", []]]);

  const p = deriveIdentity("person:env", { index, contactMaps, handlesByPerson });
  assert.equal(p.identity.display_name, "Envelope Only");
});

// ===========================================================================
// (d) Neither a saved contact NOR an envelope name => null.
// ===========================================================================
test("display_name: with neither contact nor envelope name, is null", () => {
  const index = makeIndex([
    {
      person_id: "person:anon",
      ids: [{ platform: "PLAT_A", sender_id: "+15550001111" }],
      cross_links: [],
      names: [], // no envelope name
      is_operator: false,
    },
  ]);
  const handlesByPerson = new Map([["person:anon", []]]);
  const p = deriveIdentity("person:anon", { index, contactMaps: {}, handlesByPerson });
  assert.equal(p.identity.display_name, null);
});

// ===========================================================================
// (e) handles = the dedup UNION of ids[].sender_id + cross_links[].norm +
//     handlesForPerson(handlesByPerson). A duplicate ACROSS sources collapses;
//     the union order is ids, then cross_links, then handlesByPerson.
// ===========================================================================
test("handles: dedup union across ids + cross_links + handlesByPerson (cross-source dup collapses)", () => {
  const index = makeIndex([
    {
      person_id: "person:union",
      ids: [
        { platform: "PLAT_A", sender_id: "h1" },
        { platform: "PLAT_A", sender_id: "h2" },
      ],
      cross_links: [
        { kind: "phone", norm: "h2" }, // duplicate of an ids handle -> collapses
        { kind: "email", norm: "h3" },
      ],
      names: [],
      is_operator: false,
    },
  ]);
  // handlesByPerson contributes a dup ('h3') and a genuinely new handle ('h4').
  const handlesByPerson = new Map([["person:union", ["h3", "h4"]]]);

  const p = deriveIdentity("person:union", { index, contactMaps: {}, handlesByPerson });
  assert.deepEqual(p.identity.handles, ["h1", "h2", "h3", "h4"]);
  // Non-tautological: every member is unique (true dedup, not a concat).
  assert.equal(new Set(p.identity.handles).size, p.identity.handles.length);
  // And every source's UNIQUE contribution survives (superset of each source).
  for (const h of ["h1", "h2", "h3", "h4"]) {
    assert.ok(p.identity.handles.includes(h), `union must contain ${h}`);
  }
});

// ===========================================================================
// (f) platforms = distinct, and OPAQUE / SWAP-INVARIANT. The derivation must
//     NOT branch on a platform value: relabel every platform token and ONLY the
//     platforms[] strings change — display_name and handles are byte-identical.
// ===========================================================================
test("platforms: distinct, and the derivation is OPAQUE/swap-invariant under platform relabeling", () => {
  const baseRec = (pA, pB) => ({
    person_id: "person:opaque",
    ids: [
      { platform: pA, sender_id: "+15551112222" },
      { platform: pB, sender_id: "user@host.com" },
      { platform: pA, sender_id: "dupHandleNotPlatform" }, // pA repeats -> distinct collapses it
    ],
    cross_links: [],
    names: ["Held Name"],
    is_operator: false,
  });
  const handlesByPerson = new Map([["person:opaque", []]]);

  const p1 = deriveIdentity("person:opaque", {
    index: makeIndex([baseRec("PLAT_A", "PLAT_B")]),
    contactMaps: {},
    handlesByPerson,
  });
  assert.deepEqual(p1.identity.platforms, ["PLAT_A", "PLAT_B"]); // distinct, first-seen order

  // Relabel: PLAT_A -> ZZZ_9, PLAT_B -> ZZZ_1 (arbitrary opaque tokens).
  const p2 = deriveIdentity("person:opaque", {
    index: makeIndex([baseRec("ZZZ_9", "ZZZ_1")]),
    contactMaps: {},
    handlesByPerson,
  });
  assert.deepEqual(p2.identity.platforms, ["ZZZ_9", "ZZZ_1"]);

  // SWAP-INVARIANCE: only the platform strings differ; handles & name identical.
  assert.deepEqual(p2.identity.handles, p1.identity.handles);
  assert.equal(p2.identity.display_name, p1.identity.display_name);
  assert.notDeepEqual(p2.identity.platforms, p1.identity.platforms);
});

// ===========================================================================
// (g) null / empty / non-string person_id => the shared NEUTRAL_PERSONA; never throws.
// ===========================================================================
test("TOTAL: null/empty/non-string person_id yields NEUTRAL_PERSONA and never throws", () => {
  const index = makeIndex([]);
  for (const bad of [null, undefined, "", 123, {}, [], true]) {
    let out;
    assert.doesNotThrow(() => {
      out = deriveIdentity(bad, { index });
    });
    assert.equal(out, NEUTRAL_PERSONA, `person_id=${String(bad)} -> the shared NEUTRAL_PERSONA`);
  }
});

// ===========================================================================
// (h) missing / non-Map index => no throw; identity facet empty, others neutral.
//     handlesByPerson=>[] suppresses the handlesForPerson soft-fallback so the
//     facet is genuinely EMPTY (the documented soft-fallback gotcha).
// ===========================================================================
test("TOTAL: a missing / non-Map index degrades to an EMPTY identity facet, no throw", () => {
  const suppress = new Map([["person:ghost", []]]);
  for (const badIndex of [undefined, null, {}, "nope", 7, { persons: [] }]) {
    let p;
    assert.doesNotThrow(() => {
      p = deriveIdentity("person:ghost", { index: badIndex, handlesByPerson: suppress });
    });
    assert.equal(p.identity.display_name, null);
    assert.deepEqual(p.identity.handles, []);
    assert.deepEqual(p.identity.platforms, []);
    assert.equal(p.person_id, "person:ghost"); // shape carries the queried id
    assertNonIdentityNeutral(p, `badIndex=${String(badIndex)}`);
  }
});

// ===========================================================================
// (i) malformed-but-PRESENT record (ids is not an array) => no throw. getPerson
//     would throw on rec.ids.map(...); the deriver's safeGetPerson treats it as
//     "no record" and degrades to an empty facet.
// ===========================================================================
test("TOTAL: a malformed-but-present record (ids not an array) degrades, no throw (safeGetPerson)", () => {
  const index = {
    persons: new Map([
      [
        "person:bad",
        { person_id: "person:bad", ids: "not-an-array", cross_links: [], names: ["x"] },
      ],
    ]),
    lookup: new Map(),
  };
  const suppress = new Map([["person:bad", []]]);
  let p;
  assert.doesNotThrow(() => {
    p = deriveIdentity("person:bad", { index, contactMaps: {}, handlesByPerson: suppress });
  });
  assert.deepEqual(p.identity.handles, []);
  assert.deepEqual(p.identity.platforms, []);
  assert.equal(p.identity.display_name, null);
});

// ===========================================================================
// (j) DETERMINISM: identical inputs => deep-equal output across repeat calls.
// ===========================================================================
test("DETERMINISTIC: identical inputs produce deep-equal output across repeat calls", () => {
  const mk = () => ({
    index: makeIndex([
      {
        person_id: "person:det",
        ids: [
          { platform: "PLAT_A", sender_id: "+15551234567" },
          { platform: "PLAT_B", sender_id: "det@host.com" },
        ],
        cross_links: [{ kind: "email", norm: "alias@host.com" }],
        names: ["Det Name"],
        is_operator: false,
      },
    ]),
    contactMaps: { phoneToName: new Map([["+1 (555) 123-4567", "Det Saved"]]), emailToName: new Map() },
    handlesByPerson: new Map([["person:det", ["extra-handle"]]]),
  });
  const a = deriveIdentity("person:det", mk());
  const b = deriveIdentity("person:det", mk());
  assert.deepEqual(a, b);
  // And on the SAME inputs object too (no hidden per-call state).
  const args = mk();
  assert.deepEqual(deriveIdentity("person:det", args), deriveIdentity("person:det", args));
});

// ===========================================================================
// (k) NON-MUTATION: inputs (index persons Map, PersonRecord arrays, contactMaps,
//     handlesByPerson) are never written back. Snapshot via structuredClone and
//     assert deep-equal after the call.
// ===========================================================================
test("NON-MUTATING: index, PersonRecord arrays, contactMaps, handlesByPerson are untouched", () => {
  const rec = {
    person_id: "person:imm",
    ids: [{ platform: "PLAT_A", sender_id: "+15551234567" }],
    cross_links: [{ kind: "email", norm: "imm@host.com" }],
    names: ["Imm Name"],
    is_operator: false,
  };
  const index = makeIndex([rec]);
  const contactMaps = {
    phoneToName: new Map([["+1 (555) 123-4567", "Imm Saved"]]),
    emailToName: new Map(),
  };
  const handlesByPerson = new Map([["person:imm", ["extra"]]]);

  // Deep snapshots of everything observable.
  const recSnap = structuredClone(rec);
  const personsSnap = new Map([...index.persons].map(([k, v]) => [k, structuredClone(v)]));
  const contactSnap = {
    phoneToName: new Map(contactMaps.phoneToName),
    emailToName: new Map(contactMaps.emailToName),
  };
  const hbpSnap = new Map([...handlesByPerson].map(([k, v]) => [k, [...v]]));

  deriveIdentity("person:imm", { index, contactMaps, handlesByPerson });

  assert.deepEqual(rec, recSnap, "PersonRecord (and its arrays) unchanged");
  assert.deepEqual([...index.persons], [...personsSnap], "index.persons Map unchanged");
  assert.deepEqual([...contactMaps.phoneToName], [...contactSnap.phoneToName], "phoneToName unchanged");
  assert.deepEqual([...contactMaps.emailToName], [...contactSnap.emailToName], "emailToName unchanged");
  assert.deepEqual([...handlesByPerson], [...hbpSnap], "handlesByPerson unchanged");
});

// ===========================================================================
// (l) SHAPE: output is normalizePersona-shaped, deeply frozen, with EVERY
//     non-identity facet byte-identical to NEUTRAL_PERSONA.
// ===========================================================================
test("SHAPE: output is normalizePersona-shaped, deeply frozen, non-identity facets neutral", () => {
  const index = makeIndex([
    {
      person_id: "person:shape",
      ids: [{ platform: "PLAT_A", sender_id: "+15551234567" }],
      cross_links: [],
      names: ["Shape Name"],
      is_operator: false,
    },
  ]);
  const p = deriveIdentity("person:shape", {
    index,
    contactMaps: {},
    handlesByPerson: new Map([["person:shape", []]]),
  });

  // Deeply frozen root + identity + its arrays.
  assert.equal(Object.isFrozen(p), true, "root frozen");
  assert.equal(Object.isFrozen(p.identity), true, "identity frozen");
  assert.equal(Object.isFrozen(p.identity.handles), true, "identity.handles frozen");
  assert.equal(Object.isFrozen(p.identity.platforms), true, "identity.platforms frozen");
  assert.equal(Object.isFrozen(p.relationship), true, "relationship frozen");
  assert.equal(Object.isFrozen(p.arc), true, "arc frozen");

  // Exactly the canonical persona keys (normalizePersona-shaped).
  assert.deepEqual(Object.keys(p).sort(), [
    "arc",
    "identity",
    "person_id",
    "relationship",
    "role",
    "salient",
    "topics",
  ]);
  // identity populated; everything else byte-neutral.
  assert.equal(p.identity.display_name, "Shape Name");
  assertNonIdentityNeutral(p, "shape");
});

// ===========================================================================
// ABSTRACTION INVARIANT — ZERO platform-name tokens in the deriver source.
// Carve out the legitimately-reused _imessage-name-recovery connector path
// (import line + comment) — the SAME reuse contacts-anchor.js performs — then
// assert no platform token remains. Tokens are matched on WORD BOUNDARIES so the
// KIND token 'email' (which contains the substring 'mail') does NOT false-fail:
// 'email' is a handle-kind namespace, not a platform name.
// ===========================================================================
test("ABSTRACTION INVARIANT: deriver source carries ZERO platform tokens (connector path carved out)", () => {
  const src = readFileSync(DERIVER_SRC, "utf8");
  // Carve out every line that references the reused connector module path.
  const carved = src
    .split("\n")
    .filter((line) => !line.includes("_imessage-name-recovery"))
    .join("\n");

  // Sanity: the carve removed the connector references but kept the body — the
  // gate is non-vacuous (the deriver's own logic is still under inspection).
  assert.ok(carved.includes("deriveIdentity"), "carve must retain the deriver body");
  assert.equal(carved.includes("_imessage-name-recovery"), false, "connector path fully carved");

  const tokens = [
    "whatsapp",
    "imessage",
    "telegram",
    "slack",
    "signal",
    "gmail",
    "outlook",
    "sms",
    "discord",
    "mail",
  ];
  for (const tok of tokens) {
    const re = new RegExp(`\\b${tok}\\b`, "i");
    assert.equal(
      re.test(carved),
      false,
      `deriver source must not name the platform token "${tok}" (outside the reused connector path)`,
    );
  }
});
