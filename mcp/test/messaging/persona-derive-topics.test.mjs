// persona-derive-topics.test.mjs — the TOPICS-DERIVER gate (the CONTENT premise
// scout for the who-matters PERSON model). Proves the invariants deriveTopics
// exists to protect, mirroring the sibling persona-contract gate:
//   - SALIENT-ABOVE-FILLER: a substantive thread surfaces its real SUBJECTS
//     (contract draft / dataset schema / deck / climate grant) and ranks them
//     above any conversational filler that leaks through the stopword list.
//   - NEUTRAL degradation: a pure-filler / sparse / media-only / odd input
//     degrades to [] (the saliency floor) — byte-identical to the neutral facet.
//   - PURE / TOTAL / DETERMINISTIC: never throws on odd input, never mutates the
//     envelopes, same input => same output.
//   - DROP-not-DEMOTE filler floor: a near-universal term (df>=0.8 across a
//     person's threads, or across PEOPLE when a corpus is supplied) is dropped,
//     while a legitimately RECURRING salient subject is preserved.
//   - REUSE: the deriver imports the recall layer's tokenizer/stopwords and the
//     persona contract's normalizer; this test introduces NO new tokenizer or
//     stopword set of its own.
//   - ZERO platform tokens in the module source (incl. the forbidden "signal").
//
// ESM, node:test + node:assert/strict. Hermetic: NO network, NO DB, NO fs writes
// (reads only in-memory shapes + the lib bytes for the 0-platform-token grep).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  deriveTopics,
  tokenizeForTopics,
  _capsForTest,
} from "../../lib/messaging/persona-derive-topics.js";

// The existing recall-layer index — used ONLY as the optional cross-person
// distinctiveness corpus in the corpus-form test. No new tokenizer is defined.
import { Bm25Index } from "../../lib/recall/bm25-index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DERIVER_SRC = path.resolve(
  __dirname,
  "../../lib/messaging/persona-derive-topics.js",
);

// A rich, single-person fixture: four threads, each about a distinct SUBJECT,
// with conversational filler ("thanks" / "got it" / "ok") sprinkled in.
const RICH = [
  { thread_id: "tA", content: "Can you send over the contract draft?" },
  { thread_id: "tA", content: "I reviewed the contract draft, looks solid." },
  { thread_id: "tA", content: "thanks" },
  { thread_id: "tB", content: "The dataset schema needs a new column." },
  { thread_id: "tB", content: "Updated the dataset schema this morning." },
  { thread_id: "tB", content: "got it" },
  { thread_id: "tC", content: "Let's finalize the deck before Friday." },
  { thread_id: "tC", content: "The deck looks great, nice work on the deck." },
  { thread_id: "tD", content: "We should apply for the climate grant." },
  { thread_id: "tD", content: "The climate grant deadline is soon." },
  { thread_id: "tD", content: "ok thanks" },
];

// ===========================================================================
// 1. CONTRACT SURFACE — deriveTopics is a function; CAPS is the frozen table.
// ===========================================================================
test("topics: exports a deriveTopics function and a frozen _capsForTest table", () => {
  assert.equal(typeof deriveTopics, "function");
  assert.equal(Object.isFrozen(_capsForTest), true, "CAPS must be frozen");
  // The thresholds the facet promises (cap, floor) are present and sane.
  assert.equal(_capsForTest.TOP_K, 12);
  assert.ok(_capsForTest.MIN_SALIENT >= 1);
  assert.ok(_capsForTest.FILLER_DF_FRAC > 0 && _capsForTest.FILLER_DF_FRAC <= 1);
  // The AGGRESSIVE cross-person df cutoff is present, frozen DATA, and a sane
  // document fraction in (0, 1].
  assert.ok(
    _capsForTest.MAX_DOC_FRACTION > 0 && _capsForTest.MAX_DOC_FRACTION <= 1,
    "MAX_DOC_FRACTION is a sane document fraction",
  );
  // ...and it is genuinely the aggressive cutoff: strictly stricter than the
  // lenient per-person-thread floor (so universal filler is dropped well before a
  // recurring personal subject would be).
  assert.ok(
    _capsForTest.MAX_DOC_FRACTION < _capsForTest.FILLER_DF_FRAC,
    "MAX_DOC_FRACTION is stricter than the lenient per-person-thread FILLER_DF_FRAC",
  );
});

// ===========================================================================
// 2. SALIENT-ABOVE-FILLER — real subjects surface and outrank leaked filler.
// ===========================================================================
test("topics: salient subjects surface and rank above leaked filler", () => {
  const out = deriveTopics(RICH, "p");
  assert.ok(Array.isArray(out));
  assert.ok(out.length >= 3, "a rich thread clears the saliency floor");

  // The real SUBJECTS of the conversation are present...
  for (const subj of [
    "deck",
    "contract",
    "dataset",
    "schema",
    "contract draft",
    "dataset schema",
    "climate grant",
  ]) {
    assert.ok(out.includes(subj), `expected subject "${subj}" to surface`);
  }

  // ...the single highest-frequency subject leads the ranking...
  assert.equal(out[0], "deck", "the most-discussed subject ranks first");

  // ...the high-confidence chat filler "thanks" is now DROPPED outright (it is a
  // member of the CHAT_FILLER set), not merely demoted — precision over recall.
  assert.ok(!out.includes("thanks"), "high-confidence chat filler 'thanks' is DROPPED");

  // ...while a generic word that leaks past BOTH the stopword list AND the
  // chat-filler set ("looks", as in 'looks solid' / 'looks great') is still present
  // but ranked strictly BELOW every named subject. This is the DROP-not-DEMOTE
  // invariant: the floor only ever DROPS or demotes filler, it never promotes it
  // above a real subject.
  assert.ok(out.includes("looks"), "a non-chat-filler leaked word is present (df-floor inert)");
  for (const subj of ["deck", "contract", "dataset", "climate", "grant", "climate grant"]) {
    assert.ok(
      out.indexOf(subj) < out.indexOf("looks"),
      `subject "${subj}" must outrank leaked filler "looks"`,
    );
  }

  // The facet is a deduped string array.
  assert.equal(new Set(out).size, out.length, "no duplicate topics");
  for (const t of out) assert.equal(typeof t, "string");
});

// ===========================================================================
// 3. NEUTRAL FLOOR — a single all-filler thread degrades to [].
// ===========================================================================
test("topics: a single all-filler thread degrades to [] via the saliency floor", () => {
  const allFiller = [
    { thread_id: "f1", content: "thanks" },
    { thread_id: "f1", content: "got it" },
    { thread_id: "f1", content: "👍" },
  ];
  assert.deepEqual(deriveTopics(allFiller, "p"), []);
});

// ===========================================================================
// 4. NEUTRAL FLOOR — sparse / null / media-only / non-string content => [].
// ===========================================================================
test("topics: sparse, null, media-only, and non-string content degrade to []", () => {
  const sparse = [
    { thread_id: "s1", content: null }, // media/placeholder per envelope.js
    { thread_id: "s1", content: "" }, // empty
    { thread_id: "s1", content: 123 }, // non-string
    { thread_id: "s1", content: {} }, // non-string
    { thread_id: "s1" }, // absent content
  ];
  assert.deepEqual(deriveTopics(sparse, "p"), []);
  assert.deepEqual(deriveTopics([], "p"), []);
});

// ===========================================================================
// 5. TOTALITY — odd top-level inputs never throw and degrade to [].
// ===========================================================================
test("topics: deriveTopics is TOTAL over odd input (never throws, returns [])", () => {
  for (const bad of [null, undefined, 42, "a string", {}, true, NaN, () => {}]) {
    let out;
    assert.doesNotThrow(() => {
      out = deriveTopics(bad, "p");
    }, `deriveTopics(${String(bad)}) must not throw`);
    assert.deepEqual(out, [], `deriveTopics(${String(bad)}) must be []`);
  }
  // personId itself is opaque: an odd personId never throws either.
  assert.doesNotThrow(() => deriveTopics(RICH, null));
  assert.doesNotThrow(() => deriveTopics(RICH, 42));
});

// ===========================================================================
// 6. NO MUTATION — envelopes are read-only (deep-equal snapshot).
// ===========================================================================
test("topics: deriveTopics never mutates the envelopes it reads", () => {
  const snapshot = structuredClone(RICH);
  deriveTopics(RICH, "p");
  assert.deepEqual(RICH, snapshot, "envelopes must be untouched after derive");
});

// ===========================================================================
// 7. DETERMINISM — same input => deep-equal output across calls.
// ===========================================================================
test("topics: deriveTopics is deterministic (same input => deep-equal output)", () => {
  assert.deepEqual(deriveTopics(RICH, "p"), deriveTopics(RICH, "p"));
});

// ===========================================================================
// 8. CAP + DEDUP — the facet is capped to TOP_K with no duplicate strings.
// ===========================================================================
test("topics: the facet caps to TOP_K and never repeats a string", () => {
  // Many distinct salient unigrams in one thread (per-person df-floor inert at
  // a single thread) with descending frequency for a deterministic ranking.
  const words = [
    "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf",
    "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar",
  ];
  const many = words.map((w, i) => ({
    thread_id: "m1",
    content: (w + " ").repeat(words.length - i).trim(),
  }));
  const out = deriveTopics(many, "p");
  assert.equal(out.length, _capsForTest.TOP_K, "output is capped to TOP_K");
  assert.ok(out.length <= 12);
  assert.equal(new Set(out).size, out.length, "no duplicate topics");
});

// ===========================================================================
// 9. BIGRAM SURFACING — an adjacent two-word subject surfaces as one topic.
// ===========================================================================
test("topics: an adjacent bigram subject surfaces (e.g. 'climate grant')", () => {
  const out = deriveTopics(RICH, "p");
  assert.ok(out.includes("climate grant"), "the adjacent bigram surfaces");
  // The bigram is distinct from its constituent unigrams (which also surface).
  assert.ok(out.includes("climate"));
  assert.ok(out.includes("grant"));
});

// ===========================================================================
// 10. DROP-not-DEMOTE — a near-universal filler is dropped; a recurring
//     salient subject across >=4 threads is preserved.
// ===========================================================================
test("topics: filler floor DROPS near-universal filler but PRESERVES a recurring subject", () => {
  // Five threads. "proposal" recurs in 3/5 threads (df 0.6 < 0.8) as the real
  // subject; "thanks" appears in ALL 5 threads (df 1.0 >= 0.8) — near-universal
  // filler the stopword list misses. The floor must DROP "thanks", not demote
  // the recurring subject.
  const fixture = [
    { thread_id: "p1", content: "proposal budget proposal numbers" },
    { thread_id: "p1", content: "thanks" },
    { thread_id: "p2", content: "the proposal timeline proposal" },
    { thread_id: "p2", content: "thanks" },
    { thread_id: "p3", content: "proposal scope proposal" },
    { thread_id: "p3", content: "thanks" },
    { thread_id: "p4", content: "unrelated chatter here today" },
    { thread_id: "p4", content: "thanks" },
    { thread_id: "p5", content: "another random note here" },
    { thread_id: "p5", content: "thanks" },
  ];
  const out = deriveTopics(fixture, "p");
  assert.ok(out.includes("proposal"), "recurring salient subject is preserved");
  assert.equal(out[0], "proposal", "the recurring subject is NOT demoted");
  assert.ok(!out.includes("thanks"), "near-universal filler is DROPPED");
});

// ===========================================================================
// 11. OPTIONAL-CORPUS DISTINCTIVENESS — a term near-universal across PEOPLE is
//     dropped; the 2-arg form still works with no corpus.
// ===========================================================================
test("topics: an optional corpus drops a cross-person-universal term; 2-arg form still works", () => {
  // For this one person, "widget" is the most frequent term...
  const fixture = [
    { thread_id: "c1", content: "widget widget widget roadmap roadmap milestone" },
    { thread_id: "c2", content: "widget roadmap milestone backlog" },
  ];

  // ...so the 2-arg form (no corpus) surfaces it as a topic.
  const noCorpus = deriveTopics(fixture, "p");
  assert.ok(noCorpus.includes("widget"), "without a corpus, widget surfaces");
  assert.ok(noCorpus.includes("roadmap"));

  // Plain df-table corpus: widget is near-universal across 100 docs (df 0.95).
  const plain = deriveTopics(fixture, "p", { totalDocs: 100, df: { widget: 95 } });
  assert.ok(!plain.includes("widget"), "corpus drops the cross-person filler");
  assert.ok(plain.includes("roadmap"), "the distinctive subject survives");
  assert.ok(plain.includes("milestone"));

  // Bm25Index corpus duck-type: same outcome via the real recall-layer index.
  const idx = new Bm25Index();
  for (let i = 0; i < 100; i++) {
    idx.add({ memory_id: "d" + i, content: i < 95 ? "widget here" : "roadmap here" });
  }
  const viaIndex = deriveTopics(fixture, "p", idx);
  assert.ok(!viaIndex.includes("widget"), "Bm25Index corpus drops near-universal term");
  assert.ok(viaIndex.includes("roadmap"));

  // An odd corpus shape is ignored (falls back to the 2-arg behaviour), never throws.
  assert.doesNotThrow(() => deriveTopics(fixture, "p", 12345));
  assert.deepEqual(deriveTopics(fixture, "p", null), noCorpus);
});

// ===========================================================================
// 11b. JUNK FILTER — a thread carrying a URL, a handle@host id, an @-mention, a
//      pure-numeric token, an over-long opaque id, and 1-char tokens yields topics
//      WITHOUT any of them (nor their fragments), and NO junk-seeded bigram — while
//      the clean recurring subject still surfaces. Junk is dropped BEFORE pairing.
// ===========================================================================
test("topics: the junk filter drops URL/@handle/numeric/long-id/1-char tokens (and their fragments + bigrams)", () => {
  const JUNKY = [
    { thread_id: "j1", content: "check https://app.example.com/projects?id=42 about the dataset roadmap please" },
    { thread_id: "j2", content: "ping 12345@lid and @founder re dataset roadmap 1234567890" },
    { thread_id: "j3", content: "ref pfbid0jn2vufzzdtqokx4wb42m5pkwyme1fdfxhxv4 x t dataset roadmap milestone" },
  ];
  const out = deriveTopics(JUNKY, "p");

  // The clean recurring SUBJECT survives — the gate is surgical, not blunt.
  assert.ok(out.length >= 3, "the clean subjects still clear the saliency floor");
  assert.ok(out.includes("dataset"), "the distinctive subject survives");
  assert.ok(out.includes("roadmap"));
  assert.ok(out.includes("dataset roadmap"), "a clean adjacent bigram still surfaces");

  // NONE of the junk fragments survive — neither as a whole topic nor as a token of
  // any bigram (junk is dropped BEFORE pairing, so no junk-seeded bigram forms).
  const FRAGMENTS = [
    "https", "http", "www", "com", "org", // URL fragments
    "app", "example", "projects", "id", "42", // the link's host / path pieces
    "founder", "lid", "12345", // @-mention + handle@host pieces
    "1234567890", // pure-numeric
    "pfbid0jn2vufzzdtqokx4wb42m5pkwyme1fdfxhxv4", // over-long opaque id
    "x", "t", // 1-char tokens
  ];
  for (const topic of out) {
    for (const sub of topic.split(" ")) {
      assert.equal(FRAGMENTS.includes(sub), false, `junk fragment "${sub}" leaked via topic "${topic}"`);
      assert.equal(/^\d+$/.test(sub), false, `pure-numeric token "${sub}" leaked via "${topic}"`);
      assert.ok(sub.length >= _capsForTest.MIN_TOKEN_LEN, `too-short token "${sub}" leaked via "${topic}"`);
      assert.ok(sub.length <= _capsForTest.MAX_TOKEN_LEN, `over-long token "${sub}" leaked via "${topic}"`);
    }
  }
});

// ===========================================================================
// 11c. CHAT-FILLER STRIP — a thread that is MOSTLY conversational filler with one
//      real subject yields ONLY the subject's tokens, with not a single chat-filler
//      word leaking (the high-confidence CHAT_FILLER set fires even with no corpus).
// ===========================================================================
test("topics: a mostly-filler thread with one real subject yields only the subject, no filler", () => {
  // Seven messages: FIVE are pure conversational filler (each isolated to a single
  // filler token so no filler-only bigram can form), TWO carry the real subject
  // "merger memo valuation". With no corpus passed, the only thing that can strip
  // the filler is the static STOPWORDS + CHAT_FILLER baseline.
  const fixture = [
    { thread_id: "t1", content: "thanks" },
    { thread_id: "t1", content: "ok" },
    { thread_id: "t1", content: "lol" },
    { thread_id: "t1", content: "got it" },
    { thread_id: "t1", content: "just" },
    { thread_id: "t1", content: "the merger memo valuation" },
    { thread_id: "t1", content: "merger memo valuation" },
  ];
  const out = deriveTopics(fixture, "p");

  // The real subject survives in full (its unigrams + the clean adjacent bigrams).
  assert.ok(out.includes("merger"), "real subject 'merger' surfaces");
  assert.ok(out.includes("memo"), "real subject 'memo' surfaces");
  assert.ok(out.includes("valuation"), "real subject 'valuation' surfaces");

  // ...and EVERY surfaced token is a subject token — NOT ONE filler word leaks
  // (neither as a unigram nor inside a bigram).
  const SUBJECT = new Set(["merger", "memo", "valuation"]);
  for (const topic of out) {
    for (const tok of topic.split(" ")) {
      assert.ok(SUBJECT.has(tok), `non-subject token "${tok}" leaked via topic "${topic}"`);
    }
  }
  // Explicit: the high-confidence chat filler is wholly absent from the output.
  for (const f of ["thanks", "ok", "lol", "got", "just"]) {
    assert.ok(!out.includes(f), `chat filler "${f}" must not surface`);
  }
});

// ===========================================================================
// 11d. CROSS-PERSON DF CUTOFF (boundary) — a term in MORE than MAX_DOC_FRACTION of
//      the corpus's persons is DROPPED (the cutoff is inclusive at the boundary),
//      while a rare subject just BELOW the cutoff SURVIVES — even though both are
//      frequent for THIS one person (only the cross-person df can separate them).
// ===========================================================================
test("topics: the cross-person df cutoff drops a high-person-fraction term but keeps a rare subject (boundary)", () => {
  const cutoff = _capsForTest.MAX_DOC_FRACTION; // 0.12
  // One person's content; ALL of standup/edge/helios are frequent for THIS person.
  // The corpus places them at df fractions straddling the cutoff:
  //   standup 20/100 = 0.20  (> cutoff) -> dropped
  //   edge    12/100 = 0.12  (== cutoff, inclusive >=) -> dropped (boundary)
  //   helios  11/100 = 0.11  (< cutoff) -> SURVIVES (the rare distinctive subject)
  const fixture = [
    { thread_id: "x1", content: "helios helios roadmap helios" },
    { thread_id: "x2", content: "helios milestone notes" },
    { thread_id: "x3", content: "standup" },
    { thread_id: "x4", content: "standup" },
    { thread_id: "x5", content: "edge" },
    { thread_id: "x6", content: "edge" },
  ];
  const corpus = {
    totalDocs: 100,
    df: { standup: 20, edge: 12, helios: 11, roadmap: 3, milestone: 2, notes: 4 },
  };
  const out = deriveTopics(fixture, "p", corpus);

  assert.ok(!out.includes("standup"), `a term in 0.20 of persons (> ${cutoff}) is dropped`);
  assert.ok(!out.includes("edge"), `a term at exactly ${cutoff} of persons is dropped (cutoff is inclusive)`);
  assert.ok(out.includes("helios"), `a rare subject in 0.11 of persons (< ${cutoff}) survives`);
  assert.equal(out[0], "helios", "the surviving distinctive subject leads the ranking");

  // Non-tautology: the per-person-thread floor cannot explain the drop — standup
  // appears in only 2/6 of THIS person's threads (well under FILLER_DF_FRAC), so the
  // cross-person df cutoff is the ONLY thing dropping it.
});

// ===========================================================================
// 11e. COMPREHENSIVE FUNCTION-WORD STRIP vs SUBJECT SURVIVAL — the principled
//      topic-quality fix. ROOT CAUSE: common conversational filler and common real
//      subjects INTERLEAVE in the same cross-person df band, so the df cutoff alone
//      cannot separate them — only a LINGUISTIC function-word list can. This proves
//      it from BOTH sides at once: a basket of ~20 English function words is fully
//      stripped (as a unigram AND inside any bigram) while a basket of real named
//      subjects that live in the SAME df band ALL survive (the precision invariant).
//
//      NON-VACUOUS: most of the function-word basket (know/good/back/over/much/may/
//      most/think/take/well/right/really/maybe/sure/also/soon/yet) is NOT in the thin
//      60-word bm25 STOPWORDS — it is stripped ONLY by the CHAT_FILLER function-word
//      additions. Revert those additions and those words surface as candidates (each
//      occurs twice per fixture, out-ranking the freq-1 anchors), failing the strip
//      assertions. So the test binds the new DATA, not tokenisation in general.
// ===========================================================================
test("topics: a comprehensive function-word basket is stripped while real subjects survive", () => {
  // ~20 English function words — pronouns/quantifiers/adverbs/light-verbs/the modal
  // 'may'. The first 17 are NOT in the bm25 STOPWORDS (so they exercise the new DATA);
  // here/there/around were already covered (kept for breadth). NONE is ever a subject.
  const FUNCTION_WORDS = [
    "know", "good", "back", "over", "much", "may", "most", "think",
    "take", "well", "right", "really", "maybe", "sure", "also", "soon",
    "yet", "here", "there", "around",
  ];
  // Example subject vocabulary: content words of the kind that share a cross-person
  // df band with the filler — the must-survive set. NOT ONE may be stripped.
  const EXAMPLE_SUBJECTS = [
    "data", "team", "code", "frontier", "floor", "nadia", "car", "insurance",
    "visa", "china", "superai", "afterparty", "dinner", "dataset", "climate",
  ];
  const filler = FUNCTION_WORDS.join(" ");
  for (const subj of EXAMPLE_SUBJECTS) {
    // The subject dominates; two neutral content anchors ("project"/"notes"/"roadmap"
    // — themselves never filler) clear the saliency floor; the ENTIRE function-word
    // basket is sprinkled across both threads so each filler word recurs.
    const fixture = [
      { thread_id: "h1", content: `${subj} ${subj} ${subj} project notes ${filler}` },
      { thread_id: "h2", content: `more on the ${subj} roadmap ${filler}` },
    ];
    const out = deriveTopics(fixture, "p");

    // The real subject SURVIVES (precision: a content word in the filler's df band).
    assert.ok(out.includes(subj), `real subject "${subj}" must survive the filter`);

    // NOT ONE function word leaks — neither as a standalone topic NOR inside a bigram
    // (the seed-filler gate stops a filler token from riding into a surviving bigram).
    for (const f of FUNCTION_WORDS) {
      assert.ok(!out.includes(f), `function word "${f}" must be stripped (subject=${subj})`);
      for (const topic of out) {
        assert.ok(
          !topic.split(" ").includes(f),
          `function word "${f}" leaked via bigram "${topic}" (subject=${subj})`,
        );
      }
    }
  }
});

// ===========================================================================
// 12. ABSTRACTION INVARIANT — ZERO platform tokens in the module source,
//     INCLUDING the forbidden "signal".
// ===========================================================================
test("topics: the deriver source carries ZERO platform tokens (and no 'signal')", () => {
  const src = readFileSync(DERIVER_SRC, "utf8").toLowerCase();
  const tokens = [
    "whatsapp", "imessage", "telegram", "slack", "signal",
    "mail", "gmail", "outlook", "messenger", "discord",
  ];
  for (const tok of tokens) {
    assert.equal(
      src.includes(tok),
      false,
      `persona-derive-topics.js must not contain the platform token "${tok}"`,
    );
  }
  // The forbidden platform token "signal" must not appear as a word anywhere.
  assert.equal(/\bsignal\b/.test(src), false, "the word 'signal' is forbidden");
});

// ===========================================================================
// 13. VOICE-NOTE ENVELOPE MARKER — a leading "[voice] " is stripped so a
//     transcribed voice note yields the same topics as its unprefixed text;
//     genuine "voice" vocabulary survives; a non-leading marker is untouched.
// ===========================================================================
test("topics: a leading '[voice] ' marker tokenizes identically to the unprefixed text", () => {
  const x = "The dentist moved my appointment";
  const prefixed = tokenizeForTopics("[voice] " + x);
  assert.deepEqual(prefixed, tokenizeForTopics(x));
  assert.equal(prefixed.includes("voice"), false, "the marker never becomes a token");
  assert.ok(prefixed.includes("dentist"), "the substantive body survives");
});

test("topics: deriveTopics over voice-prefixed envelopes equals the unprefixed derivation", () => {
  const voiced = RICH.map((e) => ({ ...e, content: "[voice] " + e.content }));
  const plain = deriveTopics(RICH, "p");
  const out = deriveTopics(voiced, "p");
  assert.deepEqual(out, plain);
  assert.ok(out.length > 0, "the fixture yields topics");
  for (const term of out) {
    assert.notEqual(term, "voice", "the marker never becomes a topic");
    assert.equal(term.split(" ").includes("voice"), false, "nor part of a bigram");
  }
});

test("topics: a genuine 'voice' word in the body is kept, prefixed or not", () => {
  const body = "my voice is hoarse after the choir rehearsal";
  assert.ok(tokenizeForTopics(body).includes("voice"), "unprefixed body keeps 'voice'");
  assert.ok(
    tokenizeForTopics("[voice] " + body).includes("voice"),
    "a prefixed body still keeps its own 'voice'",
  );
});

test("topics: a '[voice] ' that is not at the start of content is not stripped", () => {
  assert.ok(tokenizeForTopics("see [voice] later").includes("voice"));
});
