// persona-surface.test.mjs — the persona INJECTION SEAM gate (catchup.js).
//
// persona-surface threads an OPTIONAL `personaResolver` into buildCatchupCore /
// buildCatchup ALONGSIDE the M1 enrichPerson seam, attaching the resolved Persona
// as `row.persona`. The teeth this gate bites:
//
//   (a) GOLDEN — buildCatchupCore over a fixed corpus with NO personaResolver: NO
//       row carries a `persona` key (the gate-OFF / production default).
//   (b) BYTE-IDENTICAL — the same corpus with `personaResolver: () => null` is
//       JSON.stringify-equal AND deepStrictEqual to the golden (an explicitly
//       absent persona attaches nothing — identical rows/order/scores).
//   (b2) NEUTRAL RESOLVER — makeNeutralPersonaResolver() DOES attach (it returns a
//       non-null neutral Persona), so each row.persona deep-equals the resolver's
//       output for that row.dedup_key, while row order + each row.score are the
//       golden's (persona never enters the rank or the dedup).
//   (c) STUB — a resolver returning a fixed Persona attaches it to EVERY row;
//       order + scores stay the golden's; stripping persona is deepStrictEqual golden.
//   (d) SOFT — a throwing resolver attaches NO persona (the null path) and never
//       throws out of buildCatchupCore (byte-identical to the golden).
//   (e) buildCatchup TEETH — the wired path over the extraEnvelopes seam + an
//       m7-style fixture: gate-OFF has no persona key; an injected
//       makePersonaResolver(ctx) attaches a row.persona carrying the RIGHT facets
//       for a known person, with row order + scores unchanged vs the gate-OFF run.
//   (f) ABSTRACTION — catchup.js still carries ZERO platform-name literals.
//
// ESM, node:test + node:assert/strict. Hermetic: NO network, NO DB, NO fs writes
// (reads only in-memory shapes + the lib bytes for the 0-platform-token grep).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildCatchup, buildCatchupCore } from "../../lib/messaging/catchup.js";
import {
  makeNeutralPersonaResolver,
  NEUTRAL_PERSONA,
} from "../../lib/messaging/persona.js";
import { makePersonaResolver } from "../../lib/messaging/persona-resolver.js";
import { buildPersonIndex, lookup as personLookup } from "../../lib/messaging/identity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_SRC = path.resolve(__dirname, "../../lib/messaging/catchup.js");

const NOW = 1_750_000_000_000; // a fixed, well-above-floor 2025-era epoch ms
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// A minimal valid L1 envelope (the adapter / loadEnvelopesFromSources output shape).
// thread_type "dm" makes it inherently directed-at-me, so the classifier scores it
// without platform-specific mention plumbing. `tid` and `fromMe` are explicit so a
// reciprocal two-way thread can be authored. 0 platform tokens beyond opaque labels.
function mkEnv({ platform, tid, sid, name, fromMe, ts, content, smid }) {
  return {
    platform,
    thread_id: tid,
    thread_type: "dm",
    sender: fromMe
      ? { id: "self", name: "me", kind: "person" }
      : { id: sid, name: name ?? sid, kind: "person" },
    recipients: [],
    is_from_me: fromMe === true,
    ts,
    content,
    mentions: [],
    directed_at_me_signals: {
      mention_me: false,
      reply_to_me: false,
      addressed_to_me: fromMe !== true, // an inbound DM is addressed to me
    },
    capabilities: {
      reply_to_available: false,
      structured_mentions: false,
      self_identity_reliable: true,
      addressing_first_class: false,
    },
    source_msg_id: smid,
  };
}

// Three unanswered, directed inbound DMs across two opaque platforms — each its own
// person => three independent surfaced rows. Built fresh per call (no shared state).
function makeCorpus() {
  return [
    mkEnv({ platform: "pa", tid: "pa-ann", sid: "+15550000001", name: "Ann", fromMe: false, ts: NOW - 1 * DAY, content: "can you review the contract draft today?", smid: "ann-1" }),
    mkEnv({ platform: "pb", tid: "pb-ben", sid: "+15550000002", name: "Ben", fromMe: false, ts: NOW - 2 * DAY, content: "are we still meeting on thursday?", smid: "ben-1" }),
    mkEnv({ platform: "pa", tid: "pa-cleo", sid: "+15550000003", name: "Cleo", fromMe: false, ts: NOW - 3 * DAY, content: "could you send over the venue floor plan?", smid: "cleo-1" }),
  ];
}

const CORE_OPTS = { min_score: 0.0, limit: 50, max_per_platform: 1 };

// A deterministic N7 stand-in so each row's dedup_key (the Map key, not a row field)
// surfaces as `row.person_id` — letting assertions recover the exact key the persona
// resolver was called with (the soft `${platform}:${sid}` fallback otherwise hides it).
const SELF_RESOLVE = (platform, senderId) =>
  typeof senderId === "string" && senderId.length > 0 ? senderId : null;

// Run the pure core over a fresh corpus; `extra` injects e.g. { personaResolver }.
function runCore(extra = {}) {
  return buildCatchupCore({ envelopes: makeCorpus(), resolvePerson: SELF_RESOLVE, now: NOW, opts: CORE_OPTS, ...extra });
}

// Drop the top-level `persona` key from every row (only head rows can carry it;
// also_waiting_on entries never do), so an additive run can be compared to the golden.
function stripPersona(res) {
  return {
    ...res,
    rows: res.rows.map((r) => {
      const { persona, ...rest } = r;
      return rest;
    }),
  };
}

// ===========================================================================
// (a) GOLDEN — no personaResolver => no `persona` key on any row.
// ===========================================================================
test("golden: buildCatchupCore with NO personaResolver attaches no persona key", () => {
  const golden = runCore();
  assert.ok(golden.rows.length >= 2, "the fixed corpus surfaces multiple rows");
  for (const r of golden.rows) {
    assert.equal("persona" in r, false, `row ${r.person_id} must have NO persona key`);
  }
});

// ===========================================================================
// (b) BYTE-IDENTICAL — `() => null` attaches nothing: stringify- AND deep-equal.
// ===========================================================================
test("byte-identical: personaResolver:() => null is JSON- and deep-equal to the golden", () => {
  const golden = runCore();
  const withNull = runCore({ personaResolver: () => null });
  assert.equal(JSON.stringify(withNull), JSON.stringify(golden), "stringify-equal");
  assert.deepStrictEqual(withNull, golden, "deep-equal (no persona key anywhere)");
  for (const r of withNull.rows) {
    assert.equal("persona" in r, false, "a null-returning resolver adds no key");
  }
});

// ===========================================================================
// (b2) NEUTRAL RESOLVER — makeNeutralPersonaResolver() returns a NON-null neutral
//      Persona, so it DOES attach: each row.persona deep-equals the resolver's
//      output for that row.dedup_key, while order + scores stay the golden's.
//      (Correcting the spec: the neutral resolver is NOT byte-identical — it
//      attaches; only its EFFECT on rank/dedup is the no-op.)
// ===========================================================================
test("neutral resolver attaches its neutral persona per dedup_key; order + scores unchanged", () => {
  const golden = runCore();
  const neutral = makeNeutralPersonaResolver();
  const run = runCore({ personaResolver: neutral });

  // Row order (by person_id == dedup_key) and each score are IDENTICAL to the golden.
  assert.deepEqual(run.rows.map((r) => r.person_id), golden.rows.map((r) => r.person_id));
  assert.deepEqual(run.rows.map((r) => r.score), golden.rows.map((r) => r.score));

  // Every row carries the neutral resolver's persona FOR THAT ROW's dedup_key
  // (recovered via person_id under the SELF_RESOLVE stand-in).
  for (const r of run.rows) {
    assert.ok("persona" in r, "neutral resolver attaches a persona");
    assert.deepStrictEqual(r.persona, neutral(r.person_id));
    // A real dedup_key is a non-empty string => the carried id, not the shared neutral.
    assert.equal(r.persona.person_id, r.person_id);
  }

  // Stripping the additive persona leaves a row set deep-equal to the golden.
  assert.deepStrictEqual(stripPersona(run), golden);
});

// ===========================================================================
// (c) STUB — a fixed Persona attaches to EVERY row; rank + dedup are untouched.
// ===========================================================================
test("stub resolver: every row.persona deep-equals the stub; order + scores unchanged", () => {
  const golden = runCore();
  const STUB = Object.freeze({
    person_id: "stub-person",
    identity: Object.freeze({ display_name: "Stub", handles: Object.freeze([]), platforms: Object.freeze([]) }),
    relationship: Object.freeze({ tier: "relationship", reciprocity_strength: 1, cadence: "recent" }),
    role: "tester",
    topics: Object.freeze(["alpha", "beta"]),
    salient: Object.freeze([]),
    arc: Object.freeze({ last_ts: NOW, gist: null, trend: "steady" }),
  });
  const run = runCore({ personaResolver: () => STUB });

  assert.ok(run.rows.length >= 2, "rows still surface");
  for (const r of run.rows) {
    assert.deepStrictEqual(r.persona, STUB, "the injected stub rides on the row");
  }
  // Persona enters NEITHER rankScore NOR compareDesc: order + scores are the golden's.
  assert.deepEqual(run.rows.map((r) => r.person_id), golden.rows.map((r) => r.person_id));
  assert.deepEqual(run.rows.map((r) => r.score), golden.rows.map((r) => r.score));
  assert.deepStrictEqual(stripPersona(run), golden, "additive-only: strip => golden");
});

// ===========================================================================
// (d) SOFT — a throwing resolver attaches NOTHING (null path) and never throws.
// ===========================================================================
test("soft-guard: a throwing resolver degrades to no persona and never crashes catchup", () => {
  const golden = runCore();
  let run;
  assert.doesNotThrow(() => {
    run = runCore({
      personaResolver: () => {
        throw new Error("boom");
      },
    });
  }, "buildCatchupCore must NOT propagate a resolver throw");

  for (const r of run.rows) {
    assert.equal("persona" in r, false, "a throwing resolver attaches no persona key");
  }
  // The whole result is byte-identical to the golden (throw => null => no attach).
  assert.deepStrictEqual(run, golden);
});

// ===========================================================================
// (e) buildCatchup TEETH — the wired path over the extraEnvelopes seam.
//     Gate-OFF has no persona key; an injected makePersonaResolver(ctx) attaches a
//     persona carrying the RIGHT facets for a known person, order + scores unchanged.
// ===========================================================================

// A known person (Ada) with a reciprocal, topical, UNANSWERED thread (they spoke
// last => surfaces), plus an unrelated stranger so the list has multiple rows.
const ADA = "+15557654321";
function adaCorpus() {
  return [
    mkEnv({ platform: "pa", tid: "pa-ada", sid: ADA, name: "Ada Lovelace", fromMe: false, ts: NOW - 5 * DAY, content: "Can you send the contract draft and the dataset schema?", smid: "ada-1" }),
    mkEnv({ platform: "pa", tid: "pa-ada", sid: ADA, name: "Ada Lovelace", fromMe: true, ts: NOW - 5 * DAY + HOUR, content: "Sure, sending it now.", smid: "ada-2" }),
    mkEnv({ platform: "pa", tid: "pa-ada", sid: ADA, name: "Ada Lovelace", fromMe: false, ts: NOW - 1 * DAY, content: "Thanks — can we schedule the review meeting on thursday?", smid: "ada-3" }),
    mkEnv({ platform: "pb", tid: "pb-stranger", sid: "+15550009999", name: "Stranger", fromMe: false, ts: NOW - 2 * DAY, content: "hi, can you help me with the report?", smid: "str-1" }),
  ];
}

test("buildCatchup gate-OFF: no personaResolver => no persona key on any row", async () => {
  const res = await buildCatchup({ sources: [], extraEnvelopes: adaCorpus(), now: NOW, min_score: 0.0, limit: 50, max_per_platform: 1 });
  assert.ok(res.rows.length >= 1, "the fixture surfaces at least one row");
  for (const r of res.rows) {
    assert.equal("persona" in r, false, "production/handler path attaches no persona");
  }
});

test("buildCatchup with makePersonaResolver(ctx): real facets attached, order + scores unchanged", async () => {
  const extraEnvelopes = adaCorpus();

  // Rebuild the N7 resolver EXACTLY as buildCatchup does internally (deterministic
  // buildPersonIndex over the same envelope set), so the resolver's grouping keys
  // match the dedup_key buildCatchup computes for each surfaced row.
  const idx = buildPersonIndex(extraEnvelopes);
  const resolvePerson = (platform, senderId) => {
    try {
      return personLookup(idx, platform, senderId);
    } catch {
      return null;
    }
  };
  const adaId = resolvePerson("pa", ADA);
  assert.ok(typeof adaId === "string" && adaId.length > 0, "Ada resolves to a person id");

  const personaResolver = makePersonaResolver({
    envelopes: extraEnvelopes,
    resolvePerson,
    index: idx,
    now: NOW,
  });

  const off = await buildCatchup({ sources: [], extraEnvelopes, now: NOW, min_score: 0.0, limit: 50, max_per_platform: 1 });
  const on = await buildCatchup({ sources: [], extraEnvelopes, personaResolver, now: NOW, min_score: 0.0, limit: 50, max_per_platform: 1 });

  // ADDITIVE-ONLY: order + scores identical; stripping persona => the gate-OFF run.
  assert.deepEqual(on.rows.map((r) => r.person_id), off.rows.map((r) => r.person_id));
  assert.deepEqual(on.rows.map((r) => r.score), off.rows.map((r) => r.score));
  assert.deepStrictEqual(stripPersona(on), off, "persona is purely additive to the rows");

  // The known person's row carries a REAL persona (not the neutral default).
  const adaRow = on.rows.find((r) => r.person_id === adaId);
  assert.ok(adaRow, "Ada surfaces (they spoke last)");
  assert.ok(adaRow.persona, "Ada's row carries a persona");
  assert.equal(adaRow.persona.person_id, adaId, "persona keyed on the row's person id");
  assert.equal(adaRow.persona.identity.display_name, "Ada Lovelace", "identity facet derived");
  assert.ok(adaRow.persona.topics.length > 0, "topics facet mined from the thread content");
  assert.ok(
    adaRow.persona.relationship.reciprocity_strength > 0,
    "the reciprocal two-way thread folds to a >0 graded strength",
  );
  assert.notDeepStrictEqual(adaRow.persona, NEUTRAL_PERSONA, "a real person is NOT the neutral persona");
});

// ===========================================================================
// (f) ABSTRACTION — catchup.js still carries ZERO platform-name LITERALS (the half
//     of the N10 gate this file owns): it never compares against a quoted platform
//     string. (Bare platform WORDS may appear in prose comments — e.g. the
//     pre-existing "Adding Slack/Signal is ONE registry import" — which is DATA-as-
//     illustration, not a branch. The gate is on STRING LITERALS used in code.)
//     persona threading added no platform branch and no new platform literal.
// ===========================================================================
test("abstraction: catchup.js carries zero platform-name literals after persona threading", () => {
  const src = readFileSync(LIB_SRC, "utf8");
  // Non-vacuous: the persona seam is genuinely present in the inspected source.
  assert.ok(src.includes("personaResolver"), "the persona seam is wired into catchup.js");
  assert.ok(src.includes("personaFn"), "the gate-off persona default is present");

  const platformTokens = [
    "whatsapp",
    "imessage",
    "telegram",
    "slack",
    "signal",
    "gmail",
    "outlook",
    "discord",
  ];
  for (const tok of platformTokens) {
    // A QUOTED literal (single or double quote) — the only form that can drive a
    // platform branch. Comment prose mentioning a platform is allowed.
    const re = new RegExp(`['"]${tok}['"]`, "i");
    assert.equal(re.test(src), false, `catchup.js must not contain the platform literal "${tok}"`);
  }
});
