// persona-live-wiring.test.mjs — the LIVE-WIRING gate for memory_catchup personas.
//
// persona-surface built the OPTIONAL personaResolver injection seam; this node turns
// it ON in the shipped handler. The teeth this gate bites, all through the REAL
// `memory_catchup` handler() (validate -> source-load -> buildCatchup -> core):
//
//   (a) ON BY DEFAULT — handler({}) over a fixture reciprocal corpus: EVERY surfaced
//       row carries a `persona` key, and a known person's row carries REAL facets
//       (identity.display_name set, topics.length>0, relationship.reciprocity_strength>0).
//   (b) OFF / ADDITIVE-ONLY — handler({ persona:false }) over the SAME fixture: NO row
//       carries a `persona` key, and the rows deep-equal the persona-STRIPPED ON rows
//       (order + every score byte-identical — persona never enters rank/dedup).
//   (c) SOFT-GUARD — buildCatchupCore with a THROWING personaResolver yields rows with
//       no persona key and never throws; handler({ persona:true }) over an empty /
//       degenerate corpus never throws (a build failure simply omits personas).
//   (d) ABSTRACTION — catchup.js still carries ZERO platform-name string literals after
//       the live wiring (the half of the N10 gate this file owns), and adds no 'signal'.
//   (e) ONE GRADED QUANTITY PER ROW — a row's relationship grading appears in TWO
//       places (top-level reciprocity_strength/tier, and persona.relationship). They
//       must be the SAME value because ONE seat produced it, not because two seats
//       happened to agree. Three cases: the vouched broadcast fixture, the same
//       person collapsed across two threads with different counts, and the real
//       handler surface. See the block above the (e) tests for the RED measurement.
//
// ESM, node:test + node:assert/strict. The handler is driven over the
// setDefaultSourceLoader seam feeding a PASSTHROUGH fixture adapter (an opaque,
// non-real platform slug) registered into ADAPTER_REGISTRY for the test and removed
// in finally — so the handler's real registry loop maps the authored envelopes
// verbatim. Date.now is pinned so the two handler calls share one clock (the rank's
// staleness/recency are time-derived); restored in finally. No network, no DB, no fs
// writes (the anchor's real address-book / feedback reads degrade to neutral and are
// identical across the ON/OFF calls, so they cancel in the additive-equality check).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  handler,
  buildCatchupCore,
  setDefaultSourceLoader,
  resetDefaultSourceLoader,
  ADAPTER_REGISTRY,
} from "../../lib/messaging/catchup.js";
// e9 — section (e) drives the REAL resolver (not a stub): the divergence it pins
// only exists when an actual persona derivation runs against an actual row.
import { makePersonaResolver } from "../../lib/messaging/persona-resolver.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_SRC = path.resolve(__dirname, "../../lib/messaging/catchup.js");

const NOW = 1_750_000_000_000; // a fixed, well-above-floor 2025-era epoch ms
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// An OPAQUE, non-real platform slug (DATA, never a branch). The fixture adapter is a
// PASSTHROUGH (toEnvelope: row => row) so authored L1 envelopes flow through the
// handler's real registry loop unchanged. Not one of the N10 platform tokens.
const FIX_PLATFORM = "fixwire";
const ADA = "+15557654321";
const BEN = "+15550009999";

// A minimal valid L1 envelope (the loadEnvelopesFromSources output shape). thread_type
// "dm" makes it inherently directed-at-me, so the classifier scores it above the
// default min_score without platform-specific mention plumbing. Mirrors the proven
// shape from persona-surface.test.mjs. 0 platform tokens beyond the opaque label.
//
// e9 — `ttype` and `mention` are OPTIONAL and default to exactly today's values, so
// every existing call site emits a byte-identical envelope. Section (e2) needs a
// non-DM thread_type: the attention layer keys a DM group on the RESOLVED PERSON
// (the cross-platform DM collapse), so two DM threads with one counterparty never
// reach the catch-up dedup as two members. A `mention` carries the directedness a
// DM gets for free.
function mkEnv({ tid, sid, name, fromMe, ts, content, smid, ttype = "dm", mention = false }) {
  return {
    platform: FIX_PLATFORM,
    thread_id: tid,
    thread_type: ttype,
    sender: fromMe
      ? { id: "self", name: "me", kind: "person" }
      : { id: sid, name: name ?? sid, kind: "person" },
    recipients: [],
    is_from_me: fromMe === true,
    ts,
    content,
    mentions: [],
    directed_at_me_signals: {
      mention_me: mention === true && fromMe !== true,
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

// Ada — a DEEP two-way reciprocal thread (she spoke last => surfaces unanswered), so
// the relationship facet folds to a real graded strength and the topics facet mines
// real terms. Ben — a single inbound new contact, a SECOND surfaced row proving the
// persona key rides on EVERY surfaced row. Built fresh per call (no shared mutation).
function makeFixtureCorpus() {
  return [
    mkEnv({ tid: "t-ada", sid: ADA, name: "Ada Lovelace", fromMe: false, ts: NOW - 10 * DAY, content: "Hey, can you review the contract draft today?", smid: "ada-1" }),
    mkEnv({ tid: "t-ada", sid: ADA, name: "Ada Lovelace", fromMe: true, ts: NOW - 10 * DAY + HOUR, content: "Sure, looking at the draft now.", smid: "ada-2" }),
    mkEnv({ tid: "t-ada", sid: ADA, name: "Ada Lovelace", fromMe: false, ts: NOW - 8 * DAY, content: "Thanks. What about the dataset schema?", smid: "ada-3" }),
    mkEnv({ tid: "t-ada", sid: ADA, name: "Ada Lovelace", fromMe: true, ts: NOW - 8 * DAY + HOUR, content: "The schema is attached.", smid: "ada-4" }),
    mkEnv({ tid: "t-ada", sid: ADA, name: "Ada Lovelace", fromMe: false, ts: NOW - 6 * DAY, content: "Great, can we schedule the review meeting?", smid: "ada-5" }),
    mkEnv({ tid: "t-ada", sid: ADA, name: "Ada Lovelace", fromMe: true, ts: NOW - 6 * DAY + HOUR, content: "Thursday works for the review.", smid: "ada-6" }),
    mkEnv({ tid: "t-ada", sid: ADA, name: "Ada Lovelace", fromMe: false, ts: NOW - 1 * DAY, content: "Perfect, see you thursday for the contract review.", smid: "ada-7" }),
    mkEnv({ tid: "t-ben", sid: BEN, name: "Ben Stranger", fromMe: false, ts: NOW - 2 * DAY, content: "hi, can you help me with the quarterly report?", smid: "ben-1" }),
  ];
}

// Register the passthrough fixture adapter + pin the source loader and the clock, run
// the async body, and FULLY restore every seam in finally (registry key, loader,
// Date.now). Keeps each test hermetic and order-independent.
async function withFixtureEnv(corpusFn, body) {
  const realNow = Date.now;
  Date.now = () => NOW;
  ADAPTER_REGISTRY.set(FIX_PLATFORM, {
    toEnvelope: (row) => row,
    prepareContext: null,
    ledgerPath: `storage/sources/${FIX_PLATFORM}.jsonl`,
  });
  setDefaultSourceLoader(() => ({ [FIX_PLATFORM]: corpusFn() }));
  try {
    return await body();
  } finally {
    resetDefaultSourceLoader();
    ADAPTER_REGISTRY.delete(FIX_PLATFORM);
    Date.now = realNow;
  }
}

// Drop the top-level `persona` key from every row (only head rows can carry it;
// also_waiting_on entries never do), so an additive ON run compares to the OFF run.
function stripPersona(rows) {
  return rows.map((r) => {
    const { persona, ...rest } = r;
    return rest;
  });
}

// ===========================================================================
// (a) ON BY DEFAULT — handler({}) renders row.persona with REAL facets.
// ===========================================================================
test("handler ON by default: every surfaced row carries persona; a known row has real facets", async () => {
  await withFixtureEnv(makeFixtureCorpus, async () => {
    const res = await handler({});
    assert.equal(res.ok, true, "handler returns an ok envelope");
    const rows = res.data.rows;
    assert.ok(rows.length >= 1, "the fixture surfaces at least one row");

    // Personas are LIVE: every surfaced row carries a persona (the gate is ON).
    for (const r of rows) {
      assert.ok("persona" in r, `surfaced row ${r.person_name} must carry a persona`);
      assert.ok(r.persona && typeof r.persona === "object", "the persona is an object");
    }

    // The known deep-relationship person's row carries REAL (non-neutral) facets.
    const ada = rows.find((r) => r.persona && r.persona.identity && r.persona.identity.display_name === "Ada Lovelace");
    assert.ok(ada, "Ada surfaces (she spoke last) and her persona identity is derived");
    assert.ok(typeof ada.persona.identity.display_name === "string" && ada.persona.identity.display_name.length > 0, "identity.display_name set");
    assert.ok(Array.isArray(ada.persona.topics) && ada.persona.topics.length > 0, "topics facet mined from the thread content");
    assert.ok(ada.persona.relationship.reciprocity_strength > 0, "the reciprocal two-way thread folds to a >0 graded strength");
  });
});

// ===========================================================================
// (b) OFF / ADDITIVE-ONLY — handler({persona:false}) => no persona key, and the rows
//     deep-equal the persona-stripped ON rows (order + scores byte-identical).
// ===========================================================================
test("handler persona:false: no persona key; rows deep-equal the persona-stripped ON rows", async () => {
  await withFixtureEnv(makeFixtureCorpus, async () => {
    const on = await handler({});
    const off = await handler({ persona: false });

    const onRows = on.data.rows;
    const offRows = off.data.rows;

    // OFF attaches NOTHING.
    for (const r of offRows) {
      assert.equal("persona" in r, false, "persona:false attaches no persona key");
    }
    // ON attaches to every surfaced row.
    for (const r of onRows) {
      assert.equal("persona" in r, true, "default ON attaches a persona to every row");
    }

    // ADDITIVE-ONLY: order (by person id) and every score are byte-identical; stripping
    // the additive persona from the ON rows yields rows deep-equal to the OFF rows.
    assert.deepEqual(onRows.map((r) => r.person_id), offRows.map((r) => r.person_id), "row order unchanged");
    assert.deepEqual(onRows.map((r) => r.score), offRows.map((r) => r.score), "every score unchanged");
    assert.deepStrictEqual(stripPersona(onRows), offRows, "persona is purely additive — strip => the OFF rows");
  });
});

// ===========================================================================
// (c) SOFT-GUARD — a throwing resolver and a degenerate corpus never crash catchup.
// ===========================================================================
test("soft-guard: buildCatchupCore with a throwing personaResolver yields no persona key and never throws", () => {
  let res;
  assert.doesNotThrow(() => {
    res = buildCatchupCore({
      envelopes: makeFixtureCorpus(),
      now: NOW,
      opts: { min_score: 0.0, limit: 50 },
      personaResolver: () => {
        throw new Error("boom");
      },
    });
  }, "a throwing resolver must not propagate out of buildCatchupCore");
  assert.ok(res.rows.length >= 1, "rows still surface");
  for (const r of res.rows) {
    assert.equal("persona" in r, false, "a throwing resolver attaches no persona key");
  }
});

test("soft-guard: handler({persona:true}) over an empty/degenerate corpus never throws", async () => {
  const realNow = Date.now;
  Date.now = () => NOW;
  setDefaultSourceLoader(() => ({})); // no sources => no envelopes => degenerate build
  try {
    let res;
    await assert.doesNotReject(async () => {
      res = await handler({ persona: true });
    }, "the live persona build over an empty corpus must never throw");
    assert.equal(res.ok, true, "handler still returns an ok envelope");
    assert.equal(res.data.rows.length, 0, "an empty corpus surfaces no rows");
  } finally {
    resetDefaultSourceLoader();
    Date.now = realNow;
  }
});

// ===========================================================================
// (d) ABSTRACTION — catchup.js still carries ZERO platform-name LITERALS, and the
//     live wiring added no 'signal' token (the N10 abstraction invariant this file owns).
// ===========================================================================
test("abstraction: catchup.js carries zero platform-name literals after live persona wiring", () => {
  const src = readFileSync(LIB_SRC, "utf8");
  // Non-vacuous: the live persona wiring is genuinely present in the inspected source.
  assert.ok(src.includes('await import("./persona-resolver.js")'), "the dynamic persona-resolver import is wired (no static cycle)");
  assert.ok(/persona\s*=\s*false/.test(src), "the buildCatchup persona flag defaults OFF for direct callers");
  assert.equal(/^\s*import\s+[^\n]*persona-resolver/m.test(src), false, "NO static import of persona-resolver.js (it imports catchup => cycle)");

  const platformTokens = ["whatsapp", "imessage", "telegram", "slack", "signal", "gmail", "outlook", "discord"];
  for (const tok of platformTokens) {
    // A QUOTED literal (single or double quote) is the only form that can drive a
    // platform branch. Comment prose mentioning a platform is allowed.
    const re = new RegExp(`['"]${tok}['"]`, "i");
    assert.equal(re.test(src), false, `catchup.js must not contain the platform literal "${tok}"`);
  }
});

// ===========================================================================
// (e) ONE GRADED QUANTITY PER ROW — the e9 gate.
//
// A row carries its relationship grading TWICE: once as the top-level
// `reciprocity_strength` / `tier` the rank loop computed, and once inside
// `persona.relationship`. Those two used to be produced by two different seats
// from two different inputs, and they DISAGREED.
//
// RED, MEASURED BEFORE THE FIX, on the vouched broadcast fixture below (8 inbound
// / 0 outbound from one sender, resolved through the REAL makePersonaResolver with
// an enrichPerson returning is_contact:true):
//
//     row.reciprocity_strength 0.7           persona...reciprocity_strength 0.3
//     row.tier                 "relationship"  persona.relationship.tier    "unknown"
//
// The non-vouched control read 0.3 / 0.3 and "unknown" / "unknown" on the SAME
// fixture — i.e. the contact vouch was the discriminator: it raises the rank loop's
// per-row reciprocity floor, and the persona seat re-graded the same person without
// that floor and without that row's enrichment.
//
// (e2) was RED for a DIFFERENT reason, which is why it is a separate case: with the
// same person collapsed across two threads, the persona surfaced 1 where the head
// row read 0.7 — i.e. the FIRST-RESOLVED member's grading, frozen by a memo keyed on
// person_id while the graded value is per-ROW. Any fix that only threads a floor
// into the cached resolver still fails this one. (e3) was GREEN before the fix:
// hermetically the anchor degrades to neutral, so no row is vouched and the two
// gradings coincide. It is kept as a SHAPE gate on the production path, not as a
// second copy of (e1)'s teeth.
//
// The fix is SINGLE PRODUCER, not reconciliation: the rank loop grades once and
// hands the RESULT to the resolver on the per-row ctx it already passed. The three
// cases below pin that from three directions.
//
//   (e1) the vouched broadcast fixture: every row carrying a persona agrees with
//        its own row, and the non-vouched control is unchanged (the fix moved the
//        copy that was wrong, not the grading);
//   (e2) the SAME person on TWO threads with DIFFERENT counts, so the person
//        collapses through the dedup: the surfaced persona values must be the
//        MAX-SCORE member's, not the first-resolved member's. This is the case a
//        naive "thread the floor into the cached resolver" fix fails — the memo is
//        keyed on person_id alone while the graded value is per-ROW;
//   (e3) the same per-row equality loop over the REAL handler({}) rows, as a
//        general surface invariant rather than a fixture special case.
// ===========================================================================

// One inbound-only BROADCAST run: N inbound from ONE sender, no outbound at all —
// the grader's broadcast branch, whose strength is the floor (raised to the
// new-contact neutral when the sender is vouched).
function makeBroadcastCorpus({ sid, tid, n, base, ttype = "dm", mention = false }) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(mkEnv({
      tid,
      sid,
      name: "Vouched Sender",
      fromMe: false,
      ts: base - (n - i) * HOUR,
      content: `update number ${i} about the schedule`,
      smid: `${tid}-${i}`,
      ttype,
      mention,
    }));
  }
  return out;
}

// A deep, genuinely two-way thread with the SAME sender id — enough turns to reach
// the grader's relationship branch, so its strength differs from the broadcast run's.
function makeReciprocalCorpus({ sid, tid, turns, base, ttype = "dm", mention = false }) {
  const out = [];
  for (let i = 0; i < turns; i += 1) {
    out.push(mkEnv({ tid, sid, name: "Vouched Sender", fromMe: false, ts: base - (turns - i) * 2 * HOUR, content: `question ${i} about the contract draft`, smid: `${tid}-in-${i}`, ttype, mention }));
    out.push(mkEnv({ tid, sid, name: "Vouched Sender", fromMe: true, ts: base - (turns - i) * 2 * HOUR + HOUR, content: `answer ${i} on the contract draft`, smid: `${tid}-out-${i}`, ttype, mention }));
  }
  // The counterparty speaks last so the thread surfaces as unanswered.
  out.push(mkEnv({ tid, sid, name: "Vouched Sender", fromMe: false, ts: base, content: "one more thing on the contract draft", smid: `${tid}-in-last`, ttype, mention }));
  return out;
}

// The deterministic N7 stand-in: the dedup key surfaces as row.person_id.
const SELF_RESOLVE = (platform, senderId) =>
  typeof senderId === "string" && senderId.length > 0 ? senderId : null;

// A VOUCHING enrichment — is_contact:true is the exact signal that raises the rank
// loop's per-row reciprocity floor and admits the row to the relationship tier.
const vouchingEnrichPerson = (person_id) => ({
  person_id,
  is_contact: true,
  reciprocity_strength: 0,
  feedback_score: 0,
  anchor_factor: 1,
});

// THE INVARIANT ITSELF, applied to one row set: for EVERY row carrying a persona,
// the persona's relationship grading is the row's own grading — identically, not
// approximately. Returns the number of rows actually checked (so a caller can prove
// the loop was not vacuous).
function assertOneGradedQuantityPerRow(rows, label) {
  let checked = 0;
  for (const r of rows) {
    if (r.persona == null) continue;
    checked += 1;
    assert.equal(
      r.persona.relationship.reciprocity_strength,
      r.reciprocity_strength,
      `${label}: ${r.person_id} — persona reciprocity_strength must BE the row's, not a second grading`,
    );
    assert.equal(
      r.persona.relationship.tier,
      r.tier,
      `${label}: ${r.person_id} — persona tier must BE the row's, not a second classification`,
    );
  }
  return checked;
}

test("(e1) vouched broadcast row: persona relationship IS the row's grading; the non-vouched control is unchanged", () => {
  const SID = "+15550000009";
  const corpus = () => makeBroadcastCorpus({ sid: SID, tid: "t-broadcast", n: 8, base: NOW });
  const coreOpts = { min_score: 0.0, limit: 50 };

  const runWith = (extra) => {
    const envelopes = corpus();
    return buildCatchupCore({
      envelopes,
      resolvePerson: SELF_RESOLVE,
      now: NOW,
      opts: coreOpts,
      personaResolver: makePersonaResolver({ envelopes, resolvePerson: SELF_RESOLVE, now: NOW }),
      ...extra,
    });
  };

  const vouched = runWith({ enrichPerson: vouchingEnrichPerson });
  const control = runWith({});

  assert.equal(vouched.rows.length, 1, "the fixture surfaces exactly the one broadcast sender");
  assert.equal(control.rows.length, 1, "the control surfaces the same single row");

  // NON-VACUOUS: the personas are actually attached and actually checked.
  assert.equal(assertOneGradedQuantityPerRow(vouched.rows, "vouched"), 1);
  assert.equal(assertOneGradedQuantityPerRow(control.rows, "control"), 1);

  const v = vouched.rows[0];
  const c = control.rows[0];

  // The vouch is still the discriminator — the fix changed the wrong COPY, not the
  // grading. (Pre-fix these same two rows read 0.7-on-row / 0.3-on-persona and
  // "relationship"-on-row / "unknown"-on-persona.)
  assert.ok(v.reciprocity_strength > c.reciprocity_strength, "the contact vouch still raises the row's floor");
  assert.equal(v.tier, "relationship", "a vouched sender is still admitted to the relationship tier");
  assert.equal(c.tier, "unknown", "the non-vouched control is still the honest unknown");
  assert.equal(c.persona.relationship.reciprocity_strength, c.reciprocity_strength, "control persona strength unmoved");
  assert.equal(c.persona.relationship.tier, c.tier, "control persona tier unmoved");
});

test("(e2) same person, two threads, different counts: the surfaced persona is the MAX-SCORE member's", () => {
  const SID = "+15550000009";
  // Both threads are non-DM (`ttype:"group"` + an explicit mention for
  // directedness): the attention layer collapses two DM threads sharing ONE
  // counterparty into a single group before the catch-up dedup ever sees them, so a
  // DM pair could not produce two members for one dedup key.
  //
  // The RECIPROCAL thread is authored FIRST — it is therefore the FIRST-RESOLVED
  // member, the one a memo keyed on person_id alone would freeze into the cache.
  // The BROADCAST thread carries the HIGHER score; both are vouched, so both sit in
  // the SAME tier and the dedup head is decided on score alone. Head = broadcast,
  // first-resolved = reciprocal: the two are different members, which is what makes
  // this non-vacuous.
  //
  // e17 — WHY THE TWO `base` VALUES ARE THE OTHER WAY ROUND THAN THEY WERE. This
  // fixture needs the broadcast thread to out-SCORE the reciprocal one, and it used
  // to buy that by making the broadcast thread OLDER: rankScore multiplied recency
  // by staleness, so at these ages "older" meant "higher". e17 deleted the
  // staleness factor (the two read the same age, and their product was a band-pass
  // that scored a just-arrived message at ~0), so the time term is recencyFactor
  // alone and FRESHER now means higher. The ages are swapped to keep the fixture
  // discriminating; the assertions below are untouched, because the property they
  // pin — the head is the max-score member, not the first-resolved one — never
  // depended on which member that was.
  const shape = { ttype: "group", mention: true };
  const broadcast = () => makeBroadcastCorpus({ sid: SID, tid: "t-broadcast", n: 8, base: NOW - 1 * HOUR, ...shape });
  const reciprocal = () => makeReciprocalCorpus({ sid: SID, tid: "t-reciprocal", turns: 4, base: NOW - 5 * DAY, ...shape });
  const coreOpts = { min_score: 0.0, limit: 50 };

  const run = (envelopes) =>
    buildCatchupCore({
      envelopes,
      resolvePerson: SELF_RESOLVE,
      now: NOW,
      opts: coreOpts,
      enrichPerson: vouchingEnrichPerson,
      personaResolver: makePersonaResolver({ envelopes, resolvePerson: SELF_RESOLVE, now: NOW }),
    });

  // Each thread ALONE, to learn what that member's own grading is.
  const bAlone = run(broadcast()).rows[0];
  const rAlone = run(reciprocal()).rows[0];
  assert.ok(bAlone && rAlone, "each thread surfaces on its own");
  assert.notEqual(
    bAlone.reciprocity_strength,
    rAlone.reciprocity_strength,
    "the fixture is discriminating: the two threads grade to DIFFERENT strengths",
  );
  assert.equal(bAlone.tier, rAlone.tier, "both members share a tier, so the head is chosen on SCORE");
  assert.ok(bAlone.score > rAlone.score, "the FRESHER broadcast thread is the max-score member (e17: the time term is recency alone)");

  // Both threads together, RECIPROCAL FIRST — the person collapses to ONE row.
  const combined = run([...reciprocal(), ...broadcast()]);
  assert.equal(combined.rows.length, 1, "the same person on two threads collapses to one row");
  const head = combined.rows[0];
  assert.equal(head.also_waiting_on.length, 1, "the losing thread is attached, not dropped");
  assert.ok(head.score >= head.also_waiting_on[0].score, "the head IS the max-score member");
  assert.equal(head.thread_id, "t-broadcast", "the head is the broadcast thread (max score), not the first-resolved one");

  // The head carries the BROADCAST (max-score) member's grading...
  assert.equal(head.reciprocity_strength, bAlone.reciprocity_strength, "head grading is the max-score member's");
  assert.notEqual(head.reciprocity_strength, rAlone.reciprocity_strength, "and NOT the first-resolved member's");

  // ...and so does its persona. This is the assertion a memo keyed on person_id
  // alone fails: it would surface the FIRST-RESOLVED (reciprocal) member's number,
  // because the floor/value is per-ROW while the memo key is per-PERSON.
  assert.equal(assertOneGradedQuantityPerRow(combined.rows, "collapsed"), 1);
  assert.equal(
    head.persona.relationship.reciprocity_strength,
    bAlone.reciprocity_strength,
    "the persona surfaced the max-score member's strength, not whichever resolved first",
  );
  assert.notEqual(
    head.persona.relationship.reciprocity_strength,
    rAlone.reciprocity_strength,
    "the first-resolved member's strength did NOT leak through the per-person memo",
  );
  assert.equal(head.persona.relationship.tier, head.tier, "the persona tier tracks the head's (post-promotion) tier");
});

test("(e3) handler({}) surface invariant: every persona-carrying row agrees with its own row", async () => {
  await withFixtureEnv(makeFixtureCorpus, async () => {
    const res = await handler({});
    assert.equal(res.ok, true, "handler returns an ok envelope");
    const checked = assertOneGradedQuantityPerRow(res.data.rows, "handler");
    assert.ok(checked >= 1, "the production path surfaced at least one persona-carrying row to check");
  });
});
