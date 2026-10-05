// persona-derive-topics.js — the TOPICS facet deriver (CONTENT premise scout).
//
// A PURE, read-only projection: deriveTopics(envelopes, personId, corpus?) ->
// string[] of the salient SUBJECTS discussed with a person, mined from message
// CONTENT. It tokenises content, ranks unigrams + adjacent bigrams PRIMARILY by
// total term-frequency, and applies distinctiveness as a FILLER FLOOR — it drops
// the near-universal conversational filler the reused stopword list misses
// (thanks / got it / done / ok) rather than as a demoting idf. A frequency-only
// ranker WOULD surface that filler, so the floor is the thing that keeps the
// facet discriminative; but it only ever DROPS the near-universal, never demotes
// a legitimately RECURRING subject for recurring. Below a saliency floor (sparse
// / filler-only people) it degrades to [] — the neutral topics facet, byte-
// identical to today's catch-up surface.
//
// CONTRACT ALIGNMENT:
//   - Tokenisation + the stopword set are REUSED from the recall layer's single
//     source of truth (recall/bm25-index.js _internals): lowercase, split, drop
//     stopwords. This module writes NO new tokenizer and NO new stopword set.
//   - A junk filter wraps that reused tokenizer (it does NOT fork it): a content
//     PRE-SANITIZER cleans tokenize's INPUT (strips whole URL spans, @-mentions and
//     handle@host ids before they fragment) and a post-tokenize DROP gate cleans its
//     OUTPUT (drops too-short / over-long opaque / mostly-numeric tokens). Both are
//     DATA-driven via the frozen CAPS / JUNK tables — NOT a new tokenizer, NOT a new
//     stopword set. tokenizeForTopics is the single shared stream the resolver also
//     consumes to build its cross-person corpus, so df stays aligned with the terms
//     this deriver actually ranks.
//   - The returned slice is run through persona.js normalizePersona so the output
//     is exactly the deduped, contract-clean string[] the topics facet promises.
//
// HARD CONSTRAINTS (non-negotiable, mirroring persona.js):
//   - PURE / TOTAL / DETERMINISTIC: no I/O, no persistence, never throws on odd
//     input, same input => same output. Envelopes are READ-ONLY (never mutated);
//     every working structure is built fresh.
//   - ZERO platform tokens: content is OPAQUE DATA. The deriver branches on no
//     source identity and on no personId identity. personId is an opaque resolver
//     id, NOT a sender handle — envelopes arrive already person-scoped, so it is
//     NEVER used to content-filter them (doing so would zero out real input).

import { _internals } from "../recall/bm25-index.js";
import { normalizePersona } from "./persona.js";

// REUSE-not-duplicate: the single tokeniser + stopword source of truth.
const { tokenize, STOPWORDS } = _internals;

// ---------------------------------------------------------------------------
// CAPS — the single, frozen source of every threshold (all control is DATA, no
// magic number in a function body), mirroring persona.js PERSONA_CAPS discipline.
// ---------------------------------------------------------------------------
const CAPS = Object.freeze({
  // Max topics returned (the facet cap).
  TOP_K: 12,
  // Min distinct terms that must clear the filler floor; below it => [].
  MIN_SALIENT: 3,
  // Max adjacent bigrams formed per content (caps a long message's spread).
  MAX_BIGRAM: 8,
  // A term whose document-fraction reaches this is treated as near-universal
  // filler. This is the LENIENT floor: it gates the PER-PERSON-THREAD df (a
  // recurring subject in one small personal history is never dropped merely for
  // recurring) and is deliberately NOT lowered.
  FILLER_DF_FRAC: 0.8,
  // The AGGRESSIVE cross-person distinctiveness cutoff: a term appearing in MORE
  // than this fraction of the PASSED corpus's persons is DROPPED (not merely
  // down-weighted) as non-distinctive conversational filler. Far stricter than
  // FILLER_DF_FRAC because a term shared across even a tenth of a large population
  // is connective tissue (can / get / just / here / out), while a real subject is
  // shared by a handful of people (df well below this). Tuned on the real corpus:
  // the most-shared real subject observed sits at ~0.067 person-fraction, so 0.12
  // keeps real subjects with margin while the universal filler (>=0.13) vanishes.
  // Applies ONLY to the cross-person corpus reading — the per-person-thread floor
  // keeps the lenient FILLER_DF_FRAC.
  MAX_DOC_FRACTION: 0.12,
  // The filler floor is INERT below this many documents — for the per-person-thread
  // df (a recurring subject in a small history is never dropped merely for
  // recurring) AND for the cross-person corpus df (a 1-3 person corpus is a
  // degenerate distinctiveness reading where every term reads as df 1.0), so both
  // floors only engage once there is enough population to mean something.
  FILLER_MIN_DOCS: 4,
  // --- Junk-token thresholds (DATA — no bare literal in a function body) ---
  // Drop tokens shorter than this. 2 kills the dominant 1-char contraction noise
  // (t / s / u) while keeping real 2-char subjects (ai / ml / vc) that the
  // cross-person floor handles; every gated subject (dinner/dataset/climate) is >=3.
  MIN_TOKEN_LEN: 2,
  // Drop tokens longer than this — opaque identifiers (pfbid-style ids, long hashes)
  // that are never a real subject.
  MAX_TOKEN_LEN: 20,
  // Drop a token whose digit fraction reaches this — pure-numeric and mostly-numeric
  // ids (long numeric handles, 30pm) that survive splitting but carry no subject.
  MAX_DIGIT_FRAC: 0.5,
});

// ---------------------------------------------------------------------------
// JUNK — the frozen content PRE-SANITIZER span set (all control is DATA, mirroring
// CAPS). Each span is removed WHOLE from the raw content BEFORE the reused tokenizer
// sees it, so the entire opaque run vanishes rather than fragmenting into "topics"
// (a link's https/com, a handle's host). Applied left-to-right with .replace (which
// resets a global regex's lastIndex each call, so reuse stays deterministic).
// ---------------------------------------------------------------------------
const JUNK = Object.freeze({
  SPANS: Object.freeze([
    // TAPBACK / reaction system-text (a generic messaging reaction, named by no
    // platform): strip the leading reaction MARKER ("Reacted 🔥 to ", "Loved ",
    // "Liked ", "Disliked ", "Laughed at ", "Emphasized ", "Questioned ") — a
    // system verb that is never a conversation subject. The QUOTED original it
    // references is left intact (its smart-quotes are tokenizer delimiters), so a
    // real subject inside it survives (e.g. Emphasized "Parcel delayed" -> the
    // "parcel" subject is kept). Whole-message prefixes, so anchored at start.
    // The transcribed voice-note envelope marker: an exact, case-sensitive
    // literal "[voice] " at the START of content only (a system envelope tag,
    // never a subject). Genuine "voice" vocabulary in the body is kept, and a
    // "[voice] " anywhere but the start is left for the tokenizer. Placed first
    // so a prefixed body sanitizes exactly like the same unprefixed body.
    /^\[voice\] /,
    /^\s*reacted\b[^"“”]*?\bto\s+/i, // "Reacted <emoji> to " / "Reacted to "
    /^\s*(loved|liked|disliked|laughed at|emphasized|questioned)\s+/i,
    /https?:\/\/\S+/gi, // scheme URLs — the whole link
    /www\.\S+/gi, // bare www links
    /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+\/\S*/gi, // bare domain.tld/path
    /\S+@\S+/g, // handle@host ids + address-style tokens (e.g. a chat platform's 12345@lid)
    /@\S+/g, // @-mentions
  ]),
  // Top-level-domain tokens left behind when a PATH-LESS domain (crypto.com,
  // amazon.com) escapes the SPANS regex above (which requires a trailing /path),
  // fragments on the period in the reused tokenizer, and leaves a bare TLD. These
  // are never a real subject. Restricted to TLDs that are NOT also common English
  // words (so 'app'/'io'/'co' are left alone). Dropped in isJunk BEFORE bigram
  // pairing, so the standalone 'com' AND the 'crypto com' bigram both vanish.
  TLD: Object.freeze(new Set(["com", "net", "org", "edu", "gov", "info", "biz"])),
  // The COMPREHENSIVE English FUNCTION-WORD stopword set — universal conversational
  // connective tissue (a classic NLTK-style ~175-word list of pronouns / auxiliaries
  // / modals / prepositions / conjunctions / determiners / generic adverbs, PLUS the
  // conversational filler that the classic list misses) that is NEVER a subject and
  // that the reused 60-word bm25 STOPWORDS list does not cover.
  //
  // WHY A LIST, NOT A LOWER df CUTOFF (root cause, verified on the real corpus): the
  // cross-person MAX_DOC_FRACTION cutoff CANNOT separate common filler from common
  // real subjects — they INTERLEAVE in the SAME person-fraction band (filler
  // know=0.104 / need=0.111 / good=0.067 / back=0.067 / may=0.069 sit right next to
  // subjects data=0.067 / team=0.076 / code=0.096 / frontier=0.031).
  // Lowering the df cutoff would strip the real subjects too. The ONLY separator is
  // LINGUISTIC: this function-word list. The MAX_DOC_FRACTION cutoff is kept as a
  // BACKSTOP for the high-frequency filler this list might still miss; this set is
  // what catches the filler a SPARSE corpus leaves below that cutoff (and it fires
  // even in the 2-arg / no-corpus form).
  //
  // PRECISION-FIRST: a token is added only when it is DOMINANTLY filler — its
  // overwhelming usage is conversational connective tissue, not a subject. The
  // example subjects that live in this very df band are deliberately
  // ABSENT — NO data / team / code / work / help / event(s) / frontier / floor / nadia
  // / car / insurance / visa / china / superai / afterparty / dinner / dataset /
  // schema / climate / june / tower / california / wellness / minutes here. CAVEAT
  // (honest): a few entries are lowercase HOMOGRAPHS of a name/month (e.g. "may",
  // "will") — kept because the modal/auxiliary usage dominates; the rare genuine
  // "May"-the-month subject is an accepted, bounded loss, not a claim it can never
  // be a subject. The df backstop + per-person floor still surface a word that is
  // genuinely distinctive for one person.
  CHAT_FILLER: Object.freeze(new Set([
    // modals — never a subject.
    "can", "cant", "could", "should", "might", "must",
    // light/generic verbs + the wants/needs of intent
    "get", "gets", "got", "getting", "need", "needs", "want", "wants",
    "do", "did", "see", "make", "gonna", "wanna",
    // particles / adverbs / prepositions the stopword list misses
    "just", "here", "there", "up", "out", "more", "around",
    // acknowledgements + interjections + chat tokens + contraction fragments
    "im", "ur", "re", "lol", "lmao", "bro", "bruh", "dude", "mm", "hmm",
    "ok", "okay", "yeah", "yep", "nope", "thanks", "thank", "thx", "pls",
    "please", "oh", "ah", "uh", "um",
    // laughter (the bm25 list has none) — never a subject
    "haha", "hahaha", "hehe", "heh", "lmfao", "rofl",
    // contraction STEMS left when an apostrophe splits the token (don't -> don+t,
    // I'll -> i+ll, you've -> you+ve). Precision-safe: none is a plausible subject.
    "don", "didn", "doesn", "isn", "arent", "aren", "wasn", "weren", "hasn",
    "haven", "hadn", "couldn", "shouldn", "wouldn", "won", "dont", "didnt",
    "wont", "ll", "ve", "youre", "theyre", "ive", "thats", "whats",
    "mightn", "mustn", "needn",
    // --- COMPREHENSIVE function-word extension (the classic stopword list the thin
    //     60-word bm25 set misses, PLUS the conversational filler it never had) ---
    // classic stopword PRONOUNS the bm25 set misses (never a subject)
    "myself", "ourselves", "ours", "yourself", "yourselves", "him", "himself",
    "hers", "herself", "theirs", "themselves", "whom", "these", "those",
    // auxiliary / be / do forms the bm25 set misses
    "am", "been", "being", "having", "does", "doing",
    // prepositions / particles the bm25 set misses
    "about", "against", "between", "through", "during", "before", "after",
    "above", "below", "down", "under", "again", "further", "over", "without",
    // conjunctions / subordinators
    "because", "than", "while", "until",
    // determiners / quantifiers
    "all", "any", "both", "each", "few", "most", "other", "some", "such",
    "nor", "same", "only", "own", "many",
    // generic adverbs / qualifiers (no subject value)
    "once", "why", "how", "very", "now", "well", "right", "really", "actually",
    "maybe", "sure", "back", "much", "yet", "still", "even", "also", "soon",
    // light / generic verbs of conversation (intent + action, never a subject)
    "know", "think", "take", "come", "go", "say", "find", "give", "ask",
    "use", "put", "move", "made", "making", "used", "wanted",
    // generic adjectives / vague qualifiers (never a subject)
    "good", "great", "nice", "cool", "lot", "better", "big", "hard", "done",
    "quick", "high", "new", "first", "last", "next",
    // vague placeholder pro-nouns
    "thing", "things", "way", "man", "someone", "something", "anyone",
    "everyone", "everything",
    // RELATIVE time deixis — never a subject. NB the asymmetry vs concrete dates:
    // the month 'june' is a must-survive SUBJECT (a real calendar event), but a
    // relative "today / tonight / tomorrow" is connective tissue.
    "today", "tonight", "tomorrow",
    // affirmations / weak determiners the stopword list misses (never a subject)
    "yes", "another", "already",
    // the MODAL "may". NB the may-vs-june asymmetry: 'june' is kept as a SUBJECT (a
    // concrete calendar month), yet 'may' is added as filler — in chat 'may' is
    // overwhelmingly the modal verb ("I may", "you may"), it was a measured leaker
    // (df 0.069) the cross-person df cutoff could NOT separate from real subjects in
    // its band, and the probe's subject-survival columns show no real "May" subject
    // vanishing when it is stripped. Precision is preserved: a distinctive concrete
    // month/date survives via the bigram path and the surrounding content.
    "may",
  ])),
});

// Single shared document key for envelopes carrying no usable thread_id; keeps
// the deriver total when the conversation key is absent.
const THREADLESS_DOC = "\u0000__no_thread__";

// ---------------------------------------------------------------------------
// Defensive helpers (total over odd input; never throw). Mirror persona.js.
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Accumulate one occurrence of a term: bump its total frequency and record the
// thread-document it occurred in (the Set dedups repeats within a thread).
function bump(tf, threadsByTerm, term, threadKey) {
  tf.set(term, (tf.get(term) || 0) + 1);
  let docs = threadsByTerm.get(term);
  if (!docs) {
    docs = new Set();
    threadsByTerm.set(term, docs);
  }
  docs.add(threadKey);
}

// Content PRE-SANITIZER: strip every JUNK span WHOLE from raw content before the
// reused tokenizer sees it. Total over odd input (a non-string => ""); .replace
// never throws and the regexes carry no nested quantifier, so this is linear.
function sanitizeContent(content) {
  if (typeof content !== "string") return "";
  let s = content;
  // Remove (NOT space-replace) zero-width / format / placeholder chars FIRST:
  // the object-replacement char (U+FFFC, an attachment placeholder), zero-width
  // spaces/joiners (U+200B-U+200D), bidi marks/controls (U+200E-U+200F, U+202A-
  // U+202E), word-joiner (U+2060) and the BOM (U+FEFF). Left in, they fragment a
  // real word at the tokenizer (e.g. "s￼afety" -> "s"+"afety"); removing them
  // rejoins it ("safety").
  s = s.replace(/[￼​-‏‪-‮⁠﻿]/g, "");
  for (const re of JUNK.SPANS) s = s.replace(re, " ");
  return s;
}

// The post-tokenize JUNK DROP gate (a sibling of isFiller — DROP-only, never a tf
// reweight): a term is junk when it is too short, too long, or mostly numeric.
// Covers pure-numeric (digit fraction 1.0) as a special case of mostly-numeric.
function isJunk(term) {
  const len = term.length;
  if (len < CAPS.MIN_TOKEN_LEN) return true;
  if (len > CAPS.MAX_TOKEN_LEN) return true;
  // A bare top-level-domain left behind by a path-less domain mention.
  if (JUNK.TLD.has(term)) return true;
  const digits = (term.match(/[0-9]/g) || []).length;
  return digits / len >= CAPS.MAX_DIGIT_FRAC;
}

/**
 * tokenizeForTopics(content) -> string[]
 *
 * The SINGLE shared topics token stream: PRE-SANITIZE the raw content, run the
 * REUSED recall tokenizer (lowercase / split / drop stopwords), then DROP junk
 * tokens. The deriver ranks over this stream and the resolver builds its
 * cross-person df corpus over this same stream, so the corpus df stays aligned with
 * the terms the deriver actually ranks. TOTAL: odd input degrades to []. This is
 * NOT a new tokenizer — it wraps the reused one's input and output.
 */
export function tokenizeForTopics(content) {
  const raw = tokenize(sanitizeContent(content));
  const out = [];
  for (const tok of raw) {
    if (isJunk(tok)) continue;
    out.push(tok);
  }
  return out;
}

// Cross-person distinctiveness when a corpus is supplied — returns the term's
// document-fraction across the corpus, or null when no corpus reading applies
// (so the caller falls back to the per-person-thread floor). Total over any odd
// corpus shape: anything unrecognised reads as null, never throws.
function corpusDocFraction(corpus, term) {
  if (corpus === null || typeof corpus !== "object") return null;
  // Bm25Index duck-type: an inverted-index Map keyed by term + a doc count. The
  // cross-person floor is INERT below FILLER_MIN_DOCS docs (a 1-3 person corpus is a
  // degenerate distinctiveness reading), mirroring the per-person-thread floor.
  if (corpus._postings instanceof Map && typeof corpus.size === "function") {
    const n = corpus.size();
    if (!Number.isFinite(n) || n < CAPS.FILLER_MIN_DOCS) return null;
    const postings = corpus._postings.get(term);
    const df = postings && typeof postings.size === "number" ? postings.size : 0;
    return df / n;
  }
  // Plain df table: { totalDocs:number, df:Map|object<term,count> }. Same inertness
  // floor: below FILLER_MIN_DOCS docs the corpus reading does not apply.
  const total = Number(corpus.totalDocs);
  if (
    Number.isFinite(total) &&
    total >= CAPS.FILLER_MIN_DOCS &&
    corpus.df !== null &&
    corpus.df !== undefined
  ) {
    let df = 0;
    if (corpus.df instanceof Map) {
      const v = corpus.df.get(term);
      df = Number.isFinite(v) ? v : 0;
    } else if (typeof corpus.df === "object") {
      const v = corpus.df[term];
      df = Number.isFinite(v) ? v : 0;
    }
    return df / total;
  }
  return null;
}

// Static, corpus-INDEPENDENT seed-filler: a term that may seed NEITHER a unigram
// NOR a bigram — the reused bm25 STOPWORDS plus the frozen CHAT_FILLER function
// words. The unigram filter (isFiller) already drops these as candidates; this
// guard additionally stops a filler word from RIDING into the output INSIDE a
// surviving bigram (e.g. "let know" -> a measure that splits bigrams would recover
// "know"). A bigram is only worth forming from two CONTENT tokens. Deliberately
// does NOT consult the cross-person df floor: a word that is common across people
// can still be part of a genuinely distinctive MULTIWORD subject, so df-gating the
// bigram seed would over-strip real subjects (precision over recall).
function isSeedFiller(term) {
  return STOPWORDS.has(term) || JUNK.CHAT_FILLER.has(term);
}

// The FILLER FLOOR: true when a term is near-universal filler that must be
// dropped from candidates. Distinctiveness here is a DROP gate, never a demoting
// weight on the tf ranking.
function isFiller(term, ctx) {
  // Static stopword baseline (the inert-floor fallback): the reused stopword set
  // is always filler, independent of corpus / thread count. (tokenize already
  // strips these; kept as an explicit guard so the ranker can never surface a
  // static stopword should tokenisation later change.)
  if (STOPWORDS.has(term)) return true;
  // High-confidence chat-filler particles (DATA): universal conversational
  // connective tissue the bm25 STOPWORDS list misses (can/get/just/here/ok/...).
  // Checked AFTER the stopwords and BEFORE the df reads so it fires even when no
  // corpus is supplied or the corpus is too sparse for a particle to cross the
  // cutoff. Precision-first: this set holds no plausible subject.
  if (JUNK.CHAT_FILLER.has(term)) return true;
  // Principled cross-person distinctiveness when a corpus is supplied: a term
  // shared across more than MAX_DOC_FRACTION of PEOPLE is non-distinctive filler
  // even if frequent for this one; a recurring subject distinctive across people
  // has low corpus df and survives.
  const cf = corpusDocFraction(ctx.corpus, term);
  if (cf !== null) return cf >= CAPS.MAX_DOC_FRACTION;
  // Per-person-thread fallback floor: INERT below FILLER_MIN_DOCS threads, so a
  // recurring salient subject is never dropped merely for recurring.
  if (ctx.totalThreads < CAPS.FILLER_MIN_DOCS) return false;
  const docs = ctx.threadsByTerm.get(term);
  const frac = docs ? docs.size / ctx.totalThreads : 0;
  return frac >= CAPS.FILLER_DF_FRAC;
}

/**
 * deriveTopics(envelopes, personId, corpus?) -> string[]
 *
 * PURE deriver of the persona.topics[] facet: the salient subjects you discuss
 * with a person, ranked by tf and gated by a filler floor. personId is OPAQUE
 * (never used to filter); envelopes are treated as already person-scoped and
 * BOTH inbound and is_from_me content count (topics are the shared subject). The
 * optional corpus refines distinctiveness; the 2-arg form is fully functional.
 *
 * TOTAL: a non-array, malformed, sparse, or filler-only input degrades to [].
 * Never throws. Never mutates the input. Same input => same output.
 */
export function deriveTopics(envelopes, personId, corpus) {
  // TOTAL guard: a non-array degrades to the neutral facet.
  const list = Array.isArray(envelopes) ? envelopes : [];

  const tf = new Map(); // term -> total term-frequency across the person's content
  const threadsByTerm = new Map(); // term -> Set<threadKey> (its document-frequency)
  const threadKeys = new Set(); // distinct thread-documents seen

  for (const env of list) {
    if (!isPlainObject(env)) continue;
    const content = env.content;
    // null = media/placeholder per envelope.js; any non-string is skipped too.
    if (typeof content !== "string" || content.length === 0) continue;

    const threadKey =
      typeof env.thread_id === "string" && env.thread_id.length > 0
        ? env.thread_id
        : THREADLESS_DOC;
    threadKeys.add(threadKey);

    // SHARED pipeline: pre-sanitize (strip whole URL/@handle spans), REUSED
    // tokeniser (lowercase / split / drop stopwords), then DROP junk tokens — so junk
    // never seeds a unigram NOR a bigram below.
    const tokens = tokenizeForTopics(content);
    for (const tok of tokens) {
      bump(tf, threadsByTerm, tok, threadKey);
    }
    // Adjacent bigrams from the sanitized, junk-filtered stream, capped per content.
    // A bigram only forms from two CONTENT tokens: if either side is static
    // seed-filler the pair is skipped, so a filler word can never ride into the
    // output inside a surviving bigram (the unigram filter alone could not catch
    // this). The position cap still bounds a long message's spread.
    const bigramLimit = Math.min(tokens.length - 1, CAPS.MAX_BIGRAM);
    for (let i = 0; i < bigramLimit; i++) {
      const a = tokens[i];
      const b = tokens[i + 1];
      if (isSeedFiller(a) || isSeedFiller(b)) continue;
      bump(tf, threadsByTerm, a + " " + b, threadKey);
    }
  }

  const ctx = { corpus, totalThreads: threadKeys.size, threadsByTerm };

  // Candidates = terms that clear the filler floor (distinctiveness as a DROP).
  const candidates = [];
  for (const [term, freq] of tf) {
    if (isFiller(term, ctx)) continue;
    candidates.push({ term, freq });
  }

  // SALIENCE FLOOR: too few salient terms (sparse / filler-only / empty) => [].
  if (candidates.length < CAPS.MIN_SALIENT) return [];

  // Deterministic order: descending freq, then ascending lexical — mirroring the
  // Bm25Index.search tie-break.
  candidates.sort((a, b) => {
    if (b.freq !== a.freq) return b.freq - a.freq;
    return a.term < b.term ? -1 : a.term > b.term ? 1 : 0;
  });

  const capped = candidates.slice(0, CAPS.TOP_K).map((c) => c.term);
  // Hand the slice through the persona contract so the output is exactly the
  // deduped, contract-clean topics[] string array the facet promises.
  return normalizePersona({ topics: capped }).topics;
}

// Test-only view of the frozen thresholds; the function body branches on CAPS,
// never on a bare literal.
export const _capsForTest = CAPS;
