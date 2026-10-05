// persona-resolver.test.mjs — the PERSONA RESOLVER gate.
//
// Proves makePersonaResolver is the assemble+inject seam the spec demands:
//   (1) ASSEMBLY — a full ctx (saved contact + reciprocal history + topical thread
//       + recent inbound) resolves a COMPLETE Persona whose identity.display_name,
//       relationship.tier, topics, and arc are all populated, folded via the
//       contract's mergePersona; salient stays [] (no deriver, rides the neutral).
//   (2) CACHE — the same person_id returns the SAME frozen object (O(1) memo).
//   (3) GATE OFF — no/odd ctx => makeNeutralPersonaResolver(): byte-identical to the
//       contract neutral for every id; an empty/non-string id => NEUTRAL_PERSONA.
//   (4) SOFT-GUARD — a ctx crafted so one deriver THROWS degrades that person to
//       NEUTRAL_PERSONA without the resolver throwing (and other persons survive).
//   (5) ARC SUPPRESSION (load-bearing) — a person with no PLAUSIBLE inbound has the
//       arc deriver's trend:'dormant' default SUPPRESSED to the neutral arc
//       (trend:null), proving the last_ts!==null gate; and an empty/odd id under a
//       FULL ctx => deepStrictEqual NEUTRAL_PERSONA (the byte-identical / gate-off).
//   (6) NON-MUTATION of ctx + DETERMINISM (two resolvers, equal output) + a tolerated
//       2nd call argument (persona-surface calls personaFn(dedupKey, {...})).
//   (7) ABSTRACTION — zero platform-name tokens, the forbidden 'signal' word absent,
//       and NO import of a salient deriver.
//
// ESM, node:test + node:assert/strict. Hermetic: NO network, NO DB, NO fs writes
// (reads only in-memory shapes + the lib bytes for the 0-platform-token grep).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import makePersonaResolverDefault, {
  makePersonaResolver,
  makeNeutralPersonaResolver,
} from "../../lib/messaging/persona-resolver.js";
import { NEUTRAL_PERSONA } from "../../lib/messaging/persona.js";
import { deriveArc } from "../../lib/messaging/persona-derive-arc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_SRC = path.resolve(__dirname, "../../lib/messaging/persona-resolver.js");

// --- fixtures -------------------------------------------------------------
const NOW = 1_750_000_000_000; // a fixed, well-above-floor 2025-era epoch ms
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const ALICE = "person:alice";
const ALICE_HANDLE = "+15551234567";

// A getPerson-shaped index built ENTIRELY in memory (the identity-deriver pattern).
function makeIndex(records) {
  const persons = new Map();
  for (const r of records) persons.set(r.person_id, r);
  return { persons, lookup: new Map() };
}

// The full Alice ctx: a saved phone-contact, a reciprocal 3-message thread (2 in /
// 1 out, last inbound ~recent), topical content, and an explicit is_contact attr.
// Built FRESH per call so non-mutation / determinism can use independent copies.
function makeAliceCtx() {
  const resolvePerson = (platform, senderId) => (senderId === ALICE_HANDLE ? ALICE : null);
  const index = makeIndex([
    {
      person_id: ALICE,
      ids: [{ platform: "PLAT_A", sender_id: ALICE_HANDLE }],
      cross_links: [],
      names: ["Alice Envelope"], // present, but must LOSE to the saved contact
      is_operator: false,
    },
  ]);
  const contactMaps = {
    phoneToName: new Map([["+1 (555) 123-4567", "Alice Saved"]]),
    emailToName: new Map(),
  };
  const envelopes = [
    {
      platform: "PLAT_A",
      thread_id: "tA",
      is_from_me: false,
      sender: { id: ALICE_HANDLE, name: "Alice", kind: "person" },
      ts: NOW - 3 * DAY,
      content: "Can you send the contract draft?",
    },
    {
      platform: "PLAT_A",
      thread_id: "tA",
      is_from_me: true,
      sender: { id: "me", kind: "person" },
      ts: NOW - 2 * DAY,
      content: "Sure, sending the contract draft now.",
    },
    {
      platform: "PLAT_A",
      thread_id: "tA",
      is_from_me: false,
      sender: { id: ALICE_HANDLE, name: "Alice", kind: "person" },
      ts: NOW - HOUR,
      content: "Thanks. Also the dataset schema and the deck please.",
    },
  ];
  const attrsByPerson = new Map([[ALICE, { is_contact: true }]]);
  return { index, contactMaps, envelopes, resolvePerson, attrsByPerson, now: NOW };
}

// ===========================================================================
// 0. EXPORTS — named === default, plus the re-exported neutral resolver.
// ===========================================================================
test("resolver: exports makePersonaResolver (named === default) + re-exported neutral resolver", () => {
  assert.equal(typeof makePersonaResolver, "function");
  assert.equal(makePersonaResolverDefault, makePersonaResolver);
  assert.equal(typeof makeNeutralPersonaResolver, "function");
});

// ===========================================================================
// 1. ASSEMBLY — a full ctx folds EVERY available facet into one Persona.
//    Non-tautological: each assertion pins the RIGHT value a specific deriver +
//    the monotone merge must produce (not merely "non-empty").
// ===========================================================================
test("assembly: a full ctx merges identity + relationship + topics + arc into one Persona", () => {
  const resolve = makePersonaResolver(makeAliceCtx());
  const p = resolve(ALICE);

  // person_id carried; identity from the SAVED contact (beats the envelope name).
  assert.equal(p.person_id, ALICE);
  assert.equal(p.identity.display_name, "Alice Saved");
  assert.notEqual(p.identity.display_name, "Alice Envelope"); // saved contact WINS
  assert.deepEqual(p.identity.handles, [ALICE_HANDLE]);
  assert.deepEqual(p.identity.platforms, ["PLAT_A"]);

  // relationship: is_contact => the honest "relationship" tier; the reciprocal
  // thread folds to a non-zero graded strength; a recent last inbound => "recent".
  assert.equal(p.relationship.tier, "relationship");
  assert.ok(p.relationship.reciprocity_strength > 0, "reciprocal thread => >0 strength");
  assert.equal(p.relationship.cadence, "recent");

  // topics: the salient subjects mined from CONTENT (assembly really ran the deriver).
  assert.ok(p.topics.length >= 3, "topical thread surfaces several subjects");
  assert.ok(p.topics.includes("contract"), "contract subject surfaced");
  assert.ok(p.topics.includes("draft"), "draft subject surfaced");

  // arc: a plausible recent inbound => last_ts populated (the gate let it fold) and
  // a populated trend (2 inbound, recent).
  assert.equal(p.arc.last_ts, NOW - HOUR);
  assert.ok(typeof p.arc.trend === "string" && p.arc.trend.length > 0, "trend populated");

  // salient never folds — it rides the contract neutral [].
  assert.deepEqual(p.salient, []);

  // deeply frozen, canonical persona shape.
  assert.equal(Object.isFrozen(p), true);
  assert.deepEqual(Object.keys(p).sort(), [
    "arc",
    "identity",
    "person_id",
    "relationship",
    "role",
    "salient",
    "topics",
  ]);
});

// ===========================================================================
// 2. CACHE — same person_id returns the SAME object reference (single merge).
// ===========================================================================
test("cache: the same person_id returns the SAME frozen object reference", () => {
  const resolve = makePersonaResolver(makeAliceCtx());
  const a = resolve(ALICE);
  const b = resolve(ALICE);
  assert.equal(a === b, true, "cached: identical reference, not just deep-equal");
  assert.equal(Object.isFrozen(a), true);
  // A DIFFERENT id is a distinct entry (the cache keys on person_id).
  const ghost = resolve("person:ghost");
  assert.notEqual(ghost, a);
  assert.equal(resolve("person:ghost") === ghost, true, "ghost is itself cached");
});

// ===========================================================================
// 3. GATE OFF — no/odd ctx => makeNeutralPersonaResolver(): byte-identical to the
//    contract neutral for every id; empty/odd id => the shared NEUTRAL_PERSONA.
// ===========================================================================
test("gate off: no/odd ctx yields the neutral resolver, byte-identical to the contract", () => {
  const neutral = makeNeutralPersonaResolver();
  for (const oddCtx of [undefined, null, 123, "nope", true, [], () => {}]) {
    const off = makePersonaResolver(oddCtx);
    for (const id of ["a", ALICE, "person:zzz", "anything"]) {
      assert.deepStrictEqual(off(id), neutral(id), `off(${id}) byte-identical to neutral`);
    }
    // an empty / non-string id => the shared NEUTRAL_PERSONA (person_id null).
    for (const bad of ["", null, undefined, 0, {}]) {
      assert.deepStrictEqual(off(bad), NEUTRAL_PERSONA, `off(${String(bad)}) => NEUTRAL_PERSONA`);
    }
  }
});

// ===========================================================================
// 4. SOFT-GUARD — a ctx crafted so a deriver THROWS degrades THAT person to
//    NEUTRAL_PERSONA; the resolver never throws and keeps serving other persons.
//    The throw is forced by an "evil corpus" whose size() throws while the topics
//    deriver reads cross-person distinctiveness — a real, deriver-internal escape.
// ===========================================================================
test("soft-guard: a throwing facet degrades that person to NEUTRAL_PERSONA, no crash", () => {
  const ctx = makeAliceCtx();
  ctx.corpus = {
    _postings: new Map(),
    size() {
      throw new Error("evil corpus boom");
    },
  };
  const resolve = makePersonaResolver(ctx);

  let out;
  assert.doesNotThrow(() => {
    out = resolve(ALICE);
  }, "the resolver must NOT propagate a deriver throw");
  assert.deepStrictEqual(out, NEUTRAL_PERSONA, "the throwing person degrades to neutral");

  // The resolver itself is unharmed: a DIFFERENT person (no topical content -> no
  // corpus read -> no throw) still resolves without error.
  assert.doesNotThrow(() => resolve("person:ghost"), "resolver survives, other ids work");
});

// ===========================================================================
// 5a. ARC SUPPRESSION — a person with NO plausible inbound (corrupt ~epoch-0 ts)
//     must NOT leak the arc deriver's trend:'dormant' default: the resolver gates
//     the fold on last_ts!==null, leaving the contract neutral arc (trend:null).
//     Non-tautological: deriveArc on the SAME thread DOES return 'dormant'.
// ===========================================================================
test("arc suppression: a no-plausible-inbound person keeps the neutral arc (trend NOT leaked)", () => {
  const CAROL = "person:carol";
  const resolvePerson = (platform, senderId) => (senderId === "+15559998888" ? CAROL : null);
  const envelopes = [
    {
      platform: "PLAT_A",
      thread_id: "tC",
      is_from_me: false,
      sender: { id: "+15559998888", kind: "person" },
      ts: 1000, // implausible ~epoch-0 => plausibleTs => null => no recency anchor
      content: "hey",
    },
  ];
  const resolve = makePersonaResolver({ envelopes, resolvePerson, now: NOW });
  const p = resolve(CAROL);

  // The arc is the contract neutral — trend is NULL, not the deriver's 'dormant'.
  assert.deepStrictEqual(p.arc, NEUTRAL_PERSONA.arc);
  assert.equal(p.arc.trend, null);
  assert.equal(p.arc.last_ts, null);

  // PROVENANCE (non-tautology): the raw deriver WOULD have leaked 'dormant' here;
  // the resolver's last_ts gate is the thing suppressing it.
  assert.equal(deriveArc(envelopes, { now: NOW }).trend, "dormant");
});

// ===========================================================================
// 5b. BYTE-IDENTICAL / GATE-OFF under a FULL ctx — an empty/odd id short-circuits
//     to the shared NEUTRAL_PERSONA before any fold (no facet, no leak), and
//     salient is always [].
// ===========================================================================
test("byte-identical: an empty/odd id under a full ctx => deepStrictEqual NEUTRAL_PERSONA", () => {
  const resolve = makePersonaResolver(makeAliceCtx());
  for (const bad of ["", null, undefined, 123, {}, [], true]) {
    let out;
    assert.doesNotThrow(() => {
      out = resolve(bad);
    });
    assert.deepStrictEqual(out, NEUTRAL_PERSONA, `id=${String(bad)} => NEUTRAL_PERSONA`);
    assert.deepEqual(out.salient, []);
  }
});

// ===========================================================================
// 6a. NON-MUTATION — resolving people never writes back into ctx (envelopes,
//     index, contactMaps, attrsByPerson are byte-identical before/after).
// ===========================================================================
test("non-mutation: ctx (envelopes, index, contactMaps, attrs) is untouched by resolution", () => {
  const ctx = makeAliceCtx();
  const envSnap = structuredClone(ctx.envelopes);
  const personsSnap = new Map(
    [...ctx.index.persons].map(([k, v]) => [k, structuredClone(v)]),
  );
  const phoneSnap = new Map(ctx.contactMaps.phoneToName);
  const attrsSnap = new Map([...ctx.attrsByPerson].map(([k, v]) => [k, { ...v }]));

  const resolve = makePersonaResolver(ctx);
  resolve(ALICE);
  resolve("person:ghost");
  resolve(""); // odd id too
  resolve(ALICE); // cached re-read

  assert.deepEqual(ctx.envelopes, envSnap, "envelopes unchanged");
  assert.deepEqual([...ctx.index.persons], [...personsSnap], "index.persons unchanged");
  assert.deepEqual([...ctx.contactMaps.phoneToName], [...phoneSnap], "phoneToName unchanged");
  assert.deepEqual([...ctx.attrsByPerson], [...attrsSnap], "attrsByPerson unchanged");
});

// ===========================================================================
// 6b. DETERMINISM — two independent resolvers over equal ctx produce deep-equal
//     personas for the same id (no hidden per-instance state).
// ===========================================================================
test("determinism: two resolvers over equal ctx give deep-equal personas", () => {
  const r1 = makePersonaResolver(makeAliceCtx());
  const r2 = makePersonaResolver(makeAliceCtx());
  assert.deepEqual(r1(ALICE), r2(ALICE));
  assert.deepEqual(r1("person:ghost"), r2("person:ghost"));
});

// ===========================================================================
// 6c. TOLERATES A 2ND ARG — persona-surface calls personaFn(dedupKey, {...}); the
//     extra argument is ignored (all per-person data rides the once-built ctx).
// ===========================================================================
test("tolerates a 2nd call argument (the persona-surface options bag is ignored)", () => {
  const resolve = makePersonaResolver(makeAliceCtx());
  const base = resolve(ALICE);
  let withExtra;
  assert.doesNotThrow(() => {
    withExtra = resolve(ALICE, { dedupKey: ALICE, whatever: true });
  });
  assert.equal(withExtra, base, "2nd arg ignored => the SAME cached object");
});

// ===========================================================================
// 6d. GROUP ATTRIBUTION (per-sender, not per-opener) — a SINGLE group thread with
//     two DISTINCT inbound senders must yield two DISTINCT, correctly-attributed
//     personas: each person's facets derive from THAT person's OWN inbound (keyed
//     by the same dedupKey catch-up forms — the latest inbound sender), with MY
//     outbound shared into each participant's two-way history. The non-opener is
//     NON-neutral; the opener's topics EXCLUDE the other sender's distinctive
//     content (no cross-participant bleed). DM attribution stays unchanged because
//     a single-participant thread still gathers its whole run under that sender.
// ===========================================================================
test("group attribution: two inbound senders in one thread => two distinct, un-bled personas", () => {
  const ANN = "person:ann";
  const BOB = "person:bob";
  const ANN_HANDLE = "+15551110001"; // opener
  const BOB_HANDLE = "+15552220002"; // later, distinct inbound sender

  // A lowercase content tokenizer (split on any non-alphanumeric run) — used to
  // form the set of B's distinctive tokens and to scan the opener's topics.
  const toks = (s) =>
    String(s)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);

  const A_CONTENT = "quarterly budget forecast spreadsheet review";
  const B_CONTENT = "kubernetes deployment pipeline rollout staging";
  const B_ONLY = new Set(toks(B_CONTENT)); // tokens exclusive to B's inbound message

  const resolvePerson = (platform, senderId) =>
    senderId === ANN_HANDLE ? ANN : senderId === BOB_HANDLE ? BOB : null;

  const index = makeIndex([
    {
      person_id: ANN,
      ids: [{ platform: "PLAT_A", sender_id: ANN_HANDLE }],
      cross_links: [],
      names: ["Ann"],
      is_operator: false,
    },
    {
      person_id: BOB,
      ids: [{ platform: "PLAT_A", sender_id: BOB_HANDLE }],
      cross_links: [],
      names: ["Bob"],
      is_operator: false,
    },
  ]);

  // ONE group thread 'tG': Ann opens, Bob speaks LATER, then I reply once. Bob is a
  // non-opener — under the OLD first-inbound-opens-the-whole-thread rule his row
  // resolved to the neutral persona and Ann's topics absorbed his content.
  const B_TS = NOW - 2 * DAY; // Bob's (the latest) inbound ts
  const envelopes = [
    {
      platform: "PLAT_A",
      thread_id: "tG",
      thread_type: "group",
      is_from_me: false,
      sender: { id: ANN_HANDLE, name: "Ann", kind: "person" },
      ts: NOW - 5 * DAY,
      content: A_CONTENT,
    },
    {
      platform: "PLAT_A",
      thread_id: "tG",
      thread_type: "group",
      is_from_me: false,
      sender: { id: BOB_HANDLE, name: "Bob", kind: "person" },
      ts: B_TS,
      content: B_CONTENT,
    },
    {
      platform: "PLAT_A",
      thread_id: "tG",
      thread_type: "group",
      is_from_me: true,
      sender: { id: "me", kind: "person" },
      ts: NOW - 1 * DAY,
      content: "noted thanks for the update",
    },
  ];

  const resolve = makePersonaResolver({ index, envelopes, resolvePerson, now: NOW });
  const ann = resolve(ANN);
  const bob = resolve(BOB);

  // (1) The NON-opener (Bob) is correctly attributed and NON-neutral: his own
  //     distinctive subject surfaces AND his latest inbound ts anchors the arc.
  assert.notDeepStrictEqual(bob, NEUTRAL_PERSONA, "the non-opener must NOT degrade to neutral");
  assert.ok(bob.topics.includes("kubernetes"), "Bob's own subject is surfaced");
  assert.equal(bob.arc.last_ts, B_TS, "Bob's arc anchors to HIS latest inbound ts");

  // (2) The opener (Ann) carries her OWN subject and NONE of Bob's distinctive
  //     tokens — no cross-participant topic bleed.
  assert.ok(ann.topics.includes("budget"), "Ann's own subject is surfaced");
  for (const topic of ann.topics) {
    for (const t of toks(topic)) {
      assert.equal(B_ONLY.has(t), false, `Ann's topics must not include Bob-only token "${t}"`);
    }
  }

  // (3) The two personas are DISTINCT (different identity + topics), each its own sender.
  assert.equal(ann.person_id, ANN);
  assert.equal(bob.person_id, BOB);
  assert.notDeepStrictEqual(ann, bob, "the opener and non-opener resolve to distinct personas");
});

// ===========================================================================
// 6e. CROSS-PERSON CORPUS (the down-weight FIRES) — the resolver builds a cross-
//     person distinctiveness corpus ONCE over the projection and passes it to
//     deriveTopics, so a term near-universal ACROSS persons is dropped below a
//     person's distinctive subject WITHOUT any explicit ctx.corpus. Non-tautology:
//     person A's history is too small for the per-person floor (it is inert below
//     the doc threshold), so the ONLY thing that can drop the near-universal term
//     is the cross-person corpus the resolver now builds.
// ===========================================================================
test("cross-person corpus: a near-universal term is dropped below a distinctive subject (built, no explicit ctx.corpus)", () => {
  // TEN persons (>= the cross-person inertness floor). EVERY person's content uses
  // the near-universal term "weekly"; only PERSON A also discusses the distinctive
  // subject "kubernetes". With only A's TWO threads the per-person floor is INERT, so
  // absent a cross-person corpus "weekly" (higher tf) would surface. The resolver
  // must BUILD a corpus from the projection and PASS it so "weekly" (df 10/10 across
  // persons => fraction 1.0) is dropped by the aggressive MAX_DOC_FRACTION cutoff,
  // while "kubernetes" (df 1/10 => fraction 0.10, BELOW the cutoff) survives + leads.
  const handles = [
    "+15550000001", "+15550000002", "+15550000003", "+15550000004", "+15550000005",
    "+15550000006", "+15550000007", "+15550000008", "+15550000009", "+15550000010",
  ];
  const persons = handles.map((_, i) => `person:${i}`);
  const resolvePerson = (platform, sid) => {
    const i = handles.indexOf(sid);
    return i >= 0 ? persons[i] : null;
  };
  const inbound = (sid, thread, content) => ({
    platform: "PLAT_A",
    thread_id: thread,
    is_from_me: false,
    sender: { id: sid, kind: "person" },
    ts: NOW - DAY,
    content,
  });

  const envelopes = [
    // Person A: two threads (per-person floor inert), kubernetes the dominant subject.
    inbound(handles[0], "a1", "kubernetes kubernetes rollout weekly cadence"),
    inbound(handles[0], "a2", "kubernetes pipeline weekly review"),
    // Persons B..J: each uses "weekly", making it near-universal ACROSS persons (its
    // person-fraction is 1.0, far above the MAX_DOC_FRACTION cutoff).
    ...persons.slice(1).map((_, i) =>
      inbound(handles[i + 1], `p${i + 1}`, "weekly status update from the team")),
  ];

  // NO explicit ctx.corpus — the resolver must build + pass one itself.
  const resolve = makePersonaResolver({ envelopes, resolvePerson, now: NOW });
  const a = resolve(persons[0]);

  assert.ok(a.topics.includes("kubernetes"), "A's distinctive subject survives the cross-person floor");
  assert.equal(a.topics[0], "kubernetes", "the distinctive subject leads the ranking");
  assert.ok(
    !a.topics.includes("weekly"),
    "the cross-person-universal term is dropped (the built corpus fired, no explicit ctx.corpus)",
  );
});

// ===========================================================================
// 7. ABSTRACTION — zero platform-name tokens, no forbidden 'signal' word, and NO
//    import of a salient deriver (it was retired upstream; salient rides neutral).
// ===========================================================================
test("abstraction: source carries zero platform tokens, no 'signal', no salient deriver import", () => {
  const src = readFileSync(LIB_SRC, "utf8");

  // Non-vacuous: the resolver body is genuinely under inspection.
  assert.ok(src.includes("makePersonaResolver"), "the resolver body is present");
  assert.ok(src.includes("mergePersona"), "consumes the contract merge (reuse, not redefine)");

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
    assert.equal(re.test(src), false, `source must not name the platform token "${tok}"`);
  }

  // The forbidden 'signal' word (the W0 clampUnit-rename discipline) — anywhere.
  assert.equal(/signal/i.test(src), false, "the word 'signal' must not appear");

  // The salient deriver was KILLED upstream — it must NOT be imported.
  assert.equal(
    /persona-derive-salient/.test(src),
    false,
    "must not import a salient deriver (it does not exist)",
  );
});
