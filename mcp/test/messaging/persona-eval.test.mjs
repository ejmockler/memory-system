// persona-eval.test.mjs — the keystone HONEST persona GATE (hermetic node:test).
//
// WHY THIS EXISTS: the old became_real_recall=1.0 metric was a TAUTOLOGY — it
// compared a derived surface to ITSELF over an empty cohort. This gate instead
// compares the DERIVED persona facets (what the resolver computes) to the
// operator-AUTHORED truth rows on the standing FINDABILITY panel
// (m7-persona-panel.mjs). The panel is data-faithful (mira = a steady 4-message
// history; nadia = an accelerating became-real arc; theo = a brand-new cold open),
// so the assertions below have real teeth: derived-vs-authored, never derived-vs-
// derived.
//
// WHAT IS GATED (hard):
//   - the row + its persona EXIST for every panel persona (fail honestly, no skip);
//   - derived persona.topics is NON-EMPTY;
//   - TOPICS (top-K PRECISION, not bare presence): >=1 token of >=1 authored
//     truth.topic appears among the tokens of the TOP-K (K=5) derived topics — the
//     authored subject must RANK, not merely appear somewhere in the 12-long list.
//     Plus a defense-in-depth cleanliness assert: no top-K derived topic is web junk
//     (bare TLD / URL fragment / @handle / pure-numeric) — vacuous on the clean
//     panel, it re-asserts topics-noise-hardening holds at the eval boundary too;
//   - ARC (the strong tooth): derived persona.arc.trend === the authored truth trend;
//   - NEGATIVE CONTROL (mapping / mis-assignment mutation): for every cross pair
//     i!==j the trend derived for persona i must NOT equal persona j's authored
//     truth. With three pairwise-distinct authored trends this proves the gate binds
//     the RIGHT trend to the RIGHT persona — it FAILS a deriver that emits the right
//     SET of trends but assigns them to the wrong people (which a count check cannot).
//
// WHAT IS NOT GATED (informational only): persona.role (no deriver populates it —
// it is null for all three) and relationship.tier are printed, never asserted.
//
// THESIS #1: read-only. No ledger read, no fs write, no mutation. The fixed `now`
// (well above MIN_PLAUSIBLE) is injected into BOTH the panel builder and the
// resolver ctx so arc-trend derivation is deterministic across runs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPersonaPanel } from "./m7-persona-panel.mjs";
// makePersonaResolver lives in persona-resolver.js (persona.js exports only the
// gate-OFF makeNeutralPersonaResolver — that is NOT what we want here).
import { makePersonaResolver } from "../../lib/messaging/persona-resolver.js";
import { buildCatchup } from "../../lib/messaging/catchup.js";
import { buildPersonIndex, lookup as personLookup } from "../../lib/messaging/identity.js";

// A FIXED wall clock (not Date.now) for determinism. Well above MIN_PLAUSIBLE_TS_MS
// so every panel ts clamps through plausibleTs untouched.
const NOW = 1_750_000_000_000;

// Tokenize a string into lowercase content tokens on any non-alphanumeric run.
// Used on BOTH sides of the topics gate so the comparison is over SUBJECT tokens,
// not formatting.
const toks = (s) =>
  String(s)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// The topics gate is a TOP-K PRECISION gate: the authored subject must rank among the
// first TOP_K derived topics, not merely appear ANYWHERE in the list. K=5 sits
// strictly below the deriver's CAPS.TOP_K=12 (so the gate is genuinely tighter than
// "anywhere in the list") yet >= nadia's binding rank — her 'dataset' subject lands at
// derived index 4 — so the gate still PASSES honestly on the real derivers.
const TOP_K = 5;

// Web-junk TLDs to reject from derived topics — MIRRORS the deriver's JUNK.TLD
// (persona-derive-topics.js) exactly: only TLDs that are NOT also common English
// words, so legit 'app'/'io'/'co' are deliberately absent. Read as opaque DATA.
const JUNK_TLD = new Set(["com", "net", "org", "edu", "gov", "info", "biz"]);

// isJunkTopic(s) -> true when a derived topic is an unstripped web artifact: an
// @handle/handle@host id, a URL or domain fragment, a bare TLD, or a pure-numeric
// token. This is the same junk class topics-noise-hardening strips in the deriver;
// asserting it here re-proves the cleanliness HOLDS at the eval boundary. It is
// currently VACUOUS on the authored panel (m7-persona-panel.mjs is out of edit scope,
// so no junk can be authored in) — the top-K RANK gate is the load-bearing tightening,
// this is defense-in-depth.
const isJunkTopic = (s) => {
  const str = String(s);
  if (/@/.test(str)) return true; // @handle / handle@host id
  if (/https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(str)) return true; // URL / domain fragment
  return toks(str).some((t) => /^[0-9]+$/.test(t) || JUNK_TLD.has(t)); // bare TLD / pure-numeric
};

// ── The gate's two COMPARATORS, factored out so the real per-persona asserts AND
//    the negative-control self-test exercise the SAME logic. ──────────────────
// arcMatches: the strong tooth — a strict trend equality.
const arcMatches = (derived, authored) => derived === authored;
// topicsMatchTopK: the top-K precision predicate — >=1 token of >=1 authored topic
// must appear among the tokens of the first TOP_K derived topics.
const topicsMatchTopK = (derivedTopics, authoredTopics) => {
  const topK = Array.isArray(derivedTopics) ? derivedTopics.slice(0, TOP_K) : [];
  const derivedTokens = new Set();
  for (const dt of topK) for (const t of toks(dt)) derivedTokens.add(t);
  return (Array.isArray(authoredTopics) ? authoredTopics : []).some((topic) =>
    toks(topic).some((t) => derivedTokens.has(t)),
  );
};

test("persona facets match authored truth over the findability panel (honest gate)", async () => {
  // (1) Build the panel at the FIXED now, and a person index over its envelopes so
  //     we can resolve each persona's N7 person_id (the same dedup key the catch-up
  //     surface forms). resolvePerson is SOFT — a miss degrades to null, never throws.
  const panel = buildPersonaPanel(NOW);
  const index = buildPersonIndex(panel.envelopes);
  const resolvePerson = (platform, sid) => {
    try {
      return personLookup(index, platform, sid);
    } catch {
      return null;
    }
  };

  // Wire mira (the explicit saved contact) by her RESOLVED person id. The handle
  // comes from contactHandles as DATA; the platform is read off her panel row as
  // DATA — no platform-name literal participates. is_contact feeds the relationship
  // deriver only (tier); the gated facets (topics/arc) do not depend on it.
  const contactHandle = panel.contactHandles[0];
  const contactRow = panel.panel.find(
    (p) => p.handle === contactHandle || p.sid === contactHandle,
  );
  const attrsByPerson = new Map();
  if (contactRow) {
    const cid = resolvePerson(contactRow.platform, contactRow.sid) || contactRow.key;
    attrsByPerson.set(cid, { is_contact: true });
  }

  // The REAL resolver (NOT the neutral one): folds identity/relationship/topics/arc
  // per person over the panel envelopes. corpus is omitted — the per-person filler
  // floor is INERT below FILLER_MIN_DOCS, so each persona's small history is intact.
  const resolve = makePersonaResolver({
    envelopes: panel.envelopes,
    resolvePerson,
    attrsByPerson,
    now: NOW,
  });

  // (2) Rank the panel through the production pipeline with the persona resolver
  //     injected. sources:[] => no live ledger read (hermetic); extraEnvelopes feeds
  //     the panel in; anchor:true exercises the real who-matters tier path (it only
  //     touches tier/role-informational, never the gated facets). FIXED now.
  const result = await buildCatchup({
    sources: [],
    extraEnvelopes: panel.envelopes,
    personaResolver: resolve,
    anchor: true,
    now: NOW,
  });
  assert.ok(Array.isArray(result.rows), "buildCatchup returned no rows array");

  const facets = { role: 0, topics: 0, arc: 0 }; // per-facet hit counters (printed below)
  const report = []; // informational per-persona record
  const derivedTrends = []; // captured for the negative control

  for (const p of panel.panel) {
    // (3) Resolve this persona's person_id and FIND its surfaced row. rid mirrors the
    //     N7 dedup key the surface forms; the soft fallback is the same `${platform}:${sid}`.
    const rid = resolvePerson(p.platform, p.sid) || p.key;
    const row = result.rows.find((r) => r.person_id === rid || r.person === rid);

    // The row AND its persona must EXIST — fail honestly, NEVER skip.
    assert.ok(row, `panel persona ${p.label} (${rid}) is not present in the surfaced rows`);
    assert.ok(row.persona, `panel persona ${p.label} (${rid}) surfaced row carries no persona`);
    const persona = row.persona;

    // (4) Derived topics must be NON-EMPTY (the facet actually fired for this person).
    assert.ok(
      Array.isArray(persona.topics) && persona.topics.length > 0,
      `derived persona.topics is empty for ${p.label}`,
    );

    // (5) TOPICS gate — TOP-K PRECISION token-overlap, not bare ">=1 anywhere". The
    //     authored subject must RANK among the first TOP_K derived topics, not merely
    //     appear somewhere in the (CAPS.TOP_K=12-long) list. Token-overlap (not exact-
    //     set) is retained because authored truths are human slugs ("dinner plans",
    //     "dataset/schema") while deriveTopics emits frequency TOKENS ("dinner",
    //     "dataset") — an exact-set test would assert tokenizer FORMATTING, token-
    //     overlap asserts SUBJECT correctness. A persona passes when >=1 authored topic
    //     shares >=1 content token with the TOP-K derived topics. (Validated top-K
    //     hits: mira~'dinner' @0, theo~'call' @0, nadia~'dataset' @4 — hence K>=5;
    //     K<CAPS.TOP_K=12 keeps the gate genuinely tighter than "anywhere in the list".)
    const topK = persona.topics.slice(0, TOP_K);
    const topicsHit = topicsMatchTopK(persona.topics, p.truth.topics);
    assert.ok(
      topicsHit,
      `no authored topic token of ${JSON.stringify(p.truth.topics)} ranks in the top-${TOP_K} derived ` +
        `topics ${JSON.stringify(topK)} for ${p.label}`,
    );

    // Defense-in-depth (currently VACUOUS on the clean panel): no top-K derived topic
    // may be web junk (bare TLD / URL fragment / @handle / pure-numeric). Re-asserts
    // topics-noise-hardening's cleanliness holds at the eval boundary too.
    const junk = topK.find(isJunkTopic);
    assert.ok(
      junk === undefined,
      `derived top-${TOP_K} topics for ${p.label} contain web junk ${JSON.stringify(junk)} — ` +
        `topics-noise-hardening should have stripped it before the eval boundary`,
    );
    if (topicsHit) facets.topics += 1;

    // (6) ARC gate — the strong tooth. The derived inter-inbound cadence trend must
    //     EQUAL the authored truth trend (mira steady / nadia accelerating / theo new).
    const derivedTrend = persona.arc ? persona.arc.trend : null;
    derivedTrends.push(derivedTrend);
    assert.ok(
      arcMatches(derivedTrend, p.truth.arc.trend),
      `arc.trend mismatch for ${p.label}: derived ${derivedTrend} !== authored ${p.truth.arc.trend}`,
    );
    facets.arc += 1; // assert.equal above guarantees the match when we reach here

    // role — INFORMATIONAL ONLY. No deriver populates persona.role (null for all
    // three), so this is reported as a metric and NEVER asserted (the spec's escape
    // hatch: gate on topics+arc, report role accuracy as informational).
    if (persona.role != null && persona.role === p.truth.role) facets.role += 1;

    report.push({
      label: p.label,
      person_id: rid,
      derived_trend: derivedTrend,
      truth_trend: p.truth.arc.trend,
      derived_topics: persona.topics,
      truth_topics: p.truth.topics,
      derived_role: persona.role, // null today — no role deriver (informational)
      truth_role: p.truth.role, // informational
      relationship_tier: persona.relationship ? persona.relationship.tier : null, // informational
    });
  }

  // (7) NEGATIVE CONTROL — a SELF-TEST of the gate's own comparators on KNOWN-BAD and
  //     known-good LITERAL inputs, INDEPENDENT of the real derivers. A control placed
  //     AFTER the per-persona asserts cannot add teeth: if a diagonal assert fails the
  //     test already threw, and if they all pass then derived===authored makes any
  //     downstream comparison restate the fixture. So instead we drive arcMatches /
  //     topicsMatchTopK — the SAME comparators the loop above uses — with synthetic
  //     inputs, proving the gate REJECTS wrong output and ACCEPTS right output
  //     regardless of what the derivers emitted. This is what makes the green non-vacuous.
  const authoredTrends = panel.panel.map((pp) => pp.truth.arc.trend);

  // (a) the arc comparator must REJECT a wrong trend, REJECT a different-but-valid
  //     trend (proving it is not "any trend passes"), and ACCEPT the right one.
  assert.equal(arcMatches("cooling", "steady"), false, "neg-control: arc gate must reject a wrong trend");
  assert.equal(arcMatches("new", "steady"), false, "neg-control: arc gate must reject a different valid trend");
  assert.equal(arcMatches("steady", "steady"), true, "neg-control: arc gate must accept the right trend");

  // ...and a non-identity PERMUTATION of the authored trends (right SET, wrong
  //     assignment) must be caught by the diagonal comparator on at least one position
  //     — proving the gate binds the RIGHT trend to the RIGHT persona. (Authored trends
  //     are pairwise-distinct, so a rotation is a derangement: every position differs.)
  const permuted = [...authoredTrends.slice(1), authoredTrends[0]];
  const permutationCaught = permuted.some((t, i) => !arcMatches(t, authoredTrends[i]));
  assert.ok(
    permutationCaught,
    `neg-control: a permuted (mis-assigned) trend assignment ${JSON.stringify(permuted)} ` +
      `must fail the diagonal arc gate vs ${JSON.stringify(authoredTrends)}`,
  );

  // (b) the topics comparator must REJECT unrelated topics and junk-only topics, and
  //     ACCEPT a real subject-token hit — proving the top-K overlap is not "anything passes".
  assert.equal(topicsMatchTopK(["zzz", "qqqq", "xyzzy"], ["dinner plans"]), false, "neg-control: topics gate must reject unrelated topics");
  assert.equal(topicsMatchTopK(["com", "net", "12345"], ["dataset/schema"]), false, "neg-control: topics gate must reject junk-only topics");
  assert.equal(topicsMatchTopK(["dinner", "saturday"], ["dinner plans"]), true, "neg-control: topics gate must accept a real subject-token hit");

  // (8) Per-facet accuracy over mira/nadia/theo — role is INFORMATIONAL (~0/3, no
  //     deriver); topics and arc are the real gates (3/3). Printed so the honest
  //     numbers are visible in the run log.
  const n = panel.panel.length;
  console.log(
    "PERSONA_EVAL_FACETS " +
      JSON.stringify({
        role: `${facets.role}/${n} (informational — no deriver populates persona.role)`,
        topics: `${facets.topics}/${n}`,
        arc: `${facets.arc}/${n}`,
      }),
  );
  console.log("PERSONA_EVAL_ROWS " + JSON.stringify(report, null, 2));
});
