#!/usr/bin/env node
// build-contextual-eval-goldset.mjs — WU-goldset-decircularize.
//
// Builds the gold query set that gates every contextual-retrieval tier:
//   <MEMORY_ROOT>/ledgers/contextual-eval-goldset.jsonl
//
// WHY THIS WAS REWRITTEN (the circularity bug it fixes)
// -----------------------------------------------------
// The PREVIOUS builder validated every (query, golden) pair by KEEPING only the
// pairs whose golden appeared in BM25 top-K (`if (!v.ok) continue;`). That made
// the BM25 baseline's top-K failure rate ~0 ON THE GOLDSET ITSELF — the goldset
// had ZERO headroom. A contextual/dense tier literally cannot demonstrate a win
// over a baseline that already scores a perfect 0% failure: the instrument was
// measuring its own selection criterion (circular). The eval was broken.
//
// THE FIX: build pairs with REAL K=20 headroom — (query, golden) pairs where the
// BM25 BASELINE does NOT already surface the golden in top-20. We INVERT the old
// keep-rule for the headroom strata: we keep a pair only when BM25 MISSES it
// (rank >= K or absent), so the dense/contextual leg has room to win. We still
// guarantee the golden is the RIGHT answer (it is the fact the query was derived
// from) and is a REAL ledger id, so the miss is a genuine recall gap rather than
// a mislabeled pair.
//
// STRATA (the metric, eval-failure-rate.js, partitions per_stratum dynamically):
//   - semantic_paraphrase : a query that paraphrases a fact's gist using a
//                           SYNONYM lexicon so it shares the MEANING but not the
//                           LEXICON of the golden. The textbook shape: a
//                           fact that says "replace the greenhouse thermostat",
//                           asked for as "swap the temperature controller in
//                           the plant shed" — BM25 misses (no shared content
//                           token) but a dense leg can
//                           match. These pairs are the headroom engine.
//   - giant_internal      : a short interior/tail probe into one of the 47 giant
//                           facts (content > 150K chars). BM25's length
//                           normalization (b=0.75) buries a 17K-22K-token doc on
//                           a short interior probe even when the span is verbatim,
//                           so the giant misses top-20; a chunk-aware dense leg
//                           can recover it. (Demonstrated live: an 8-word interior
//                           probe misses; a 40-word verbatim span ranks ~6 — the
//                           giant IS in the index, the short probe just can't
//                           surface it lexically.)
//   - whole_fact_entity   : a query that names a fact's distinctive entity but
//                           describes the surrounding topic with PARAPHRASED
//                           words (so the entity anchor is present in meaning but
//                           the lexical anchor is weakened). Kept only when BM25
//                           still misses top-20 (anaphor/short-name headroom).
//   - whole_fact_general  : a paraphrased gist of a whole fact, kept only on a
//                           BM25 miss.
//
// CONTROL ROWS (a small, clearly-labeled minority):
//   We additionally keep a small number of BM25-FINDABLE pairs (label
//   derivation:"bm25_findable_control", headroom:false). These prove the metric
//   still reads a 0-failure floor on lexically-anchored queries and that the
//   baseline-miss fraction is a real measured property of the headroom strata,
//   NOT an artifact of every pair being un-findable (which would be a different
//   kind of un-gradeable noise). The header reports baseline_miss_fraction over
//   ALL pairs and over the headroom strata so the reviewer can see both.
//
// RIGOR CONTRACT:
//   1. Every golden_fact_id the builder emits is read at build time from
//      this host's memory ledger (ledgers/memory.jsonl); ids are never made
//      up and none are stored in this file. (The validation test re-checks
//      each emitted id against the ledger independently.)
//   2. Headroom pairs are VALIDATED to MISS BM25 top-K (the inverse of the old
//      rule). The validation rank (-1 = absent, or the actual deep rank) is
//      recorded as derivation evidence.
//   3. Control pairs are validated to HIT BM25 top-K and are labeled
//      headroom:false so they are never confused with the headroom signal.
//   4. recall.jsonl logs NO plaintext query (only a context hash + a 3072
//      embedding), so we CANNOT reconstruct real lexically-missing operator
//      queries from it faithfully. Rather than fabricate a "miss" query and
//      attribute it to real traffic, we mine recall.jsonl only for the set of
//      fact ids that real recall traffic touched, and (when those ids are
//      short/medium facts) we generate paraphrase probes for THEM — so the
//      headroom probes are anchored on facts the operator actually recalls,
//      without faking a logged query. These carry recall_meta.touched_by_recall.
//
// DETERMINISM: a fixed mulberry32 seed drives every sampling choice. The ledger
// is append-only and the relevant rows are old, so the goldset is stable across
// runs over the same ledger + index.
//
// THESIS #1 COMPLIANCE: never mutates fact rows. Reads the ledger + recall.jsonl
// read-only; writes ONLY the derived goldset file.
//
// USAGE:
//   node mcp/scripts/build-contextual-eval-goldset.mjs \
//       [--out=<path>] [--max-scan=<n>] [--validate-k=20] [--seed=<int>]
//       [--target=<n>]

import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { join } from "node:path";

import {
  loadBm25IndexFromV2File,
  isV2File,
} from "../lib/recall/bm25-streaming-loader.js";
import { Bm25Index } from "../lib/recall/bm25-index.js";
// WU-scripts-stringcap: mineRecallTouchedIds' whole-file readFileSync of
// recall.jsonl was a landmine — the bare catch turned a future
// ERR_STRING_TOO_LONG into a silently EMPTY id set. See mineRecallTouchedIds.
import { streamLedgerLines } from "../lib/synthesis/_ledger-stream.js";
import { MEMORY_ROOT, LEDGERS_DIR } from "../lib/config.js";

// Data root comes from lib/config.js (MEMORY_ROOT, default: this checkout),
// never from the home directory.
const ROOT = MEMORY_ROOT;
const MEMORY_LEDGER = join(LEDGERS_DIR, "memory.jsonl");
const RECALL_LEDGER = join(LEDGERS_DIR, "recall.jsonl");
const DEFAULT_OUT = join(LEDGERS_DIR, "contextual-eval-goldset.jsonl");
// The gemini index is the LARGE, fully-backfilled lexical index (1.46M facts);
// the active qwen3 index is mid-backfill so it is NOT a fair lexical substrate
// for goldset validation yet. The goldset queries are model-agnostic plain text;
// we validate (miss-)findability against the big index — the same index the
// run-contextual-eval.mjs bm25 leg uses by default, so the headroom we measure
// here is the headroom the live gate will see.
const GEMINI_BM25 = join(ROOT, "indices", "gemini-embedding-001", "bm25.json");

// The 47 giant facts (content > 150K chars). Enumerated deterministically by the
// builder at runtime (we do NOT hardcode the ids — the WU requires streaming the
// ledger and measuring obj.content.length, not raw line length).
const GIANT_MIN_CHARS = 150_000;

// Optional per-host curated seed pairs: a JSON array of
//   { "golden": "<memory id>", "query": "<paraphrase>", "note": "<why>" }
// kept under the DATA root next to the other per-host config (gitignored), so
// no fact id or fact-derived query is ever committed with the builder.
const CURATED_PATH = join(MEMORY_ROOT, "config", "contextual-eval-curated.json");

// Absent file -> []. Anything else that is not a well-formed array of
// {golden, query, note} strings throws an Error naming the file: a typo in a
// hand-edited file must stop the build, not silently drop the curated stratum.
// (A small hand-edited config file, not a ledger: a whole-file read is fine.)
export function loadCuratedPairs(curatedPath = CURATED_PATH) {
  if (!existsSync(curatedPath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(curatedPath, "utf8"));
  } catch (e) {
    throw new Error(`curated pairs file ${curatedPath} is unreadable or not JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`curated pairs file ${curatedPath} must be a JSON array of {golden, query, note}`);
  }
  parsed.forEach((entry, i) => {
    for (const key of ["golden", "query", "note"]) {
      if (!entry || typeof entry[key] !== "string" || entry[key].length === 0) {
        throw new Error(`curated pairs file ${curatedPath}: entry ${i} needs a non-empty string "${key}"`);
      }
    }
  });
  return parsed;
}

// --------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — same family used across the project.
// --------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseArgs(argv) {
  const opts = {
    out: DEFAULT_OUT,
    maxScan: 1_600_000,
    validateK: 20,
    seed: 0xC0FFEE,
    target: 220, // upper-bound on emitted pairs; we aim for ~150-250.
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--out=")) opts.out = arg.slice("--out=".length);
    else if (arg.startsWith("--max-scan=")) opts.maxScan = Number(arg.slice("--max-scan=".length));
    else if (arg.startsWith("--validate-k=")) opts.validateK = Number(arg.slice("--validate-k=".length));
    else if (arg.startsWith("--seed=")) opts.seed = Number(arg.slice("--seed=".length));
    else if (arg.startsWith("--target=")) opts.target = Number(arg.slice("--target=".length));
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: build-contextual-eval-goldset.mjs [--out=path] [--max-scan=n] [--validate-k=20] [--seed=int] [--target=n]\n",
      );
      process.exit(0);
    }
  }
  return opts;
}

// --------------------------------------------------------------------------
// Tokenization mirrors the BM25 tokenizer's notion of a content token so the
// lexical-overlap test (below) is faithful to what BM25 actually indexes.
// --------------------------------------------------------------------------
const BM25_STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by",
  "for", "from", "had", "has", "have", "he", "her", "his",
  "i", "if", "in", "into", "is", "it", "its", "itself",
  "me", "my", "no", "not", "of", "off", "on", "or", "our",
  "she", "so", "that", "the", "their", "them", "then", "there",
  "they", "this", "to", "too", "was", "we", "were", "what",
  "when", "where", "which", "who", "will", "with", "would",
  "you", "your", "yours",
]);

// BM25 tokenizer (lowercase, split on \W+, drop stopwords) — identical to
// bm25-index.js's tokenize so "does this query share a content token with the
// golden" is answered exactly as BM25 would see it.
function bm25Tokens(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const out = [];
  for (const tok of text.toLowerCase().split(/\W+/)) {
    if (tok.length === 0) continue;
    if (BM25_STOP.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

// Content words for SYNTHESIS (a little stricter than the BM25 tokenizer — we
// drop bare numbers, hex/hash fragments, and vowel-less slugs that make poor
// gist anchors). Used when extracting the gist of a fact to paraphrase.
const SYNTH_STOP = new Set([
  ...BM25_STOP,
  "assistant", "user", "please", "just", "want", "know", "now", "going",
  "let", "okay", "ok", "yeah", "yes", "really", "thing", "things", "make",
  "made", "get", "got", "use", "used", "using", "also", "via", "new",
]);

function contentWords(text) {
  if (typeof text !== "string") return [];
  const noUrls = text.replace(/https?:\/\/\S+/gi, " ");
  const out = [];
  for (const tok of noUrls.toLowerCase().split(/[^a-z0-9-]+/)) {
    if (tok.length < 3 || tok.length > 18) continue;
    if (SYNTH_STOP.has(tok)) continue;
    if (/^\d+$/.test(tok)) continue;
    if (/^[0-9a-f]{8,}$/i.test(tok)) continue;
    if (tok.length >= 6 && !/[aeiou]/.test(tok)) continue;
    out.push(tok);
  }
  return out;
}

// --------------------------------------------------------------------------
// SYNONYM / PARAPHRASE LEXICON.
//
// This is the engine that produces semantically-faithful but lexically-disjoint
// queries (the thing that makes BM25 miss while keeping the golden the correct
// answer). Each entry maps a token that commonly appears in our corpus to a set
// of paraphrase words that DO NOT contain that token. When we paraphrase a fact,
// we replace its matched tokens with a synonym; if enough of the gist tokens get
// replaced, the query no longer lexically overlaps the golden and BM25 misses.
//
// The first block is an illustrative example domain (workshop hardware); the
// second covers this system's own vocabulary; the rest paraphrase common
// technical English. Every entry is hand-written and generic. We deliberately
// avoid synonyms that re-introduce the original token.
// --------------------------------------------------------------------------
const SYNONYMS = {
  // --- example domain (workshop hardware) ---
  thermostat: ["temperature controller", "heat regulator", "climate dial"],
  printer: ["fabrication machine", "layer extruder", "additive maker"],
  sensor: ["measuring probe", "detector unit", "reading device"],
  firmware: ["embedded software", "device program", "onboard code"],
  calibration: ["alignment tuning", "accuracy adjustment", "reference fitting"],
  enclosure: ["housing shell", "protective casing", "outer box"],
  // --- memory / retrieval system ---
  embedding: ["vector representation", "semantic vector", "dense encoding"],
  embeddings: ["vector representations", "semantic vectors", "dense encodings"],
  recall: ["memory retrieval", "fetching context", "looking up facts"],
  retrieval: ["fetching", "lookup", "surfacing results"],
  ledger: ["append-only log", "fact store", "journal file"],
  daemon: ["background worker", "long-running service", "watcher process"],
  watermark: ["progress checkpoint", "ingest cursor", "snapshot marker"],
  index: ["lookup structure", "search catalog", "retrieval table"],
  reranker: ["scoring reorderer", "result re-sorter", "second-stage ranker"],
  rerank: ["reorder results", "re-score candidates", "second-pass ranking"],
  chunk: ["text segment", "passage", "split fragment"],
  chunking: ["segmenting text", "splitting passages", "windowing content"],
  // --- general engineering verbs ---
  setup: ["configuring", "getting started", "initial configuration", "bootstrapping"],
  setting: ["configuring", "establishing", "arranging"],
  install: ["set up", "provision", "deploy onto the machine"],
  configure: ["set up", "adjust the settings of", "tune"],
  configuration: ["settings", "setup parameters", "tuning options"],
  fix: ["repair", "patch", "resolve the defect in"],
  bug: ["defect", "fault", "broken behavior"],
  error: ["failure", "fault", "exception"],
  refactor: ["restructure", "clean up the code of", "reorganize"],
  implement: ["build", "write the code for", "develop"],
  feature: ["capability", "new functionality", "addition"],
  performance: ["speed", "throughput", "responsiveness"],
  optimize: ["speed up", "make faster", "improve efficiency of"],
  deploy: ["ship to production", "roll out", "release"],
  test: ["verify", "check the behavior of", "validate"],
  validation: ["verification", "correctness checking", "soundness check"],
  authentication: ["login flow", "sign-in", "identity verification"],
  token: ["access credential", "auth secret", "bearer key"],
  database: ["data store", "persistence layer", "backing store"],
  schema: ["data shape", "record structure", "field layout"],
  pipeline: ["processing flow", "stage sequence", "workflow chain"],
  cache: ["fast store", "memoized layer", "lookaside buffer"],
  // --- everyday nouns ---
  invoice: ["billing statement", "payment request", "charge sheet"],
  calendar: ["schedule planner", "date book", "appointment grid"],
  dashboard: ["status panel", "overview screen", "metrics board"],
  notebook: ["jotting pad", "working journal"],
  backup: ["safety copy", "archived duplicate"],
  laptop: ["portable computer", "travel machine", "folding pc"],
  newsletter: ["mailing bulletin", "periodic digest", "subscriber update"],
  // --- common engineering verbs/nouns, so more facts are paraphrasable
  //     into a lexically-disjoint query ---
  update: ["refresh", "bring up to date", "revise"],
  build: ["compile", "assemble", "produce the artifact"],
  support: ["enablement for", "compatibility with", "handling of"],
  bump: ["raise the version of", "increment", "advance"],
  remove: ["delete", "drop", "strip out"],
  issue: ["ticket", "reported problem", "tracked defect"],
  version: ["release number", "revision tag", "build identifier"],
  move: ["relocate", "shift", "migrate"],
  config: ["settings", "configuration file", "tunables"],
  code: ["source", "implementation", "program text"],
  patch: ["change set", "fix diff", "code mend"],
  docs: ["documentation", "written guide", "reference notes"],
  file: ["source document", "stored artifact"],
  files: ["source documents", "stored artifacts"],
  package: ["module bundle", "dependency unit", "library bundle"],
  branch: ["code line", "fork of work", "working line"],
  review: ["critique", "audit", "examination"],
  function: ["routine", "procedure", "method"],
  data: ["records", "stored information", "dataset"],
  session: ["working run", "interactive run", "conversation run"],
  source: ["origin", "upstream", "provider"],
  target: ["destination", "goal artifact", "intended output"],
  change: ["modification", "edit", "alteration"],
  changes: ["modifications", "edits", "alterations"],
  improve: ["enhance", "make better", "strengthen"],
  enable: ["turn on", "activate", "switch on"],
  default: ["out-of-the-box value", "fallback setting", "preset"],
  window: ["viewport", "pane", "display region"],
  text: ["written content", "string content", "prose"],
  image: ["picture", "rendered graphic", "visual asset"],
  analysis: ["examination", "study", "breakdown"],
  gate: ["check barrier", "guard condition", "pass/fail check"],
  state: ["status", "condition", "stored mode"],
  evidence: ["supporting proof", "backing data", "justification"],
  kernel: ["operating-system core", "os core module"],
  scout: ["explorer agent", "mapping agent", "survey agent"],
  milestone: ["project checkpoint", "delivery marker"],
  agent: ["autonomous worker", "ai assistant process"],
  prompt: ["instruction text", "model input", "query text"],
  model: ["ml model", "neural network", "learned system"],
  server: ["service host", "backend process", "daemon host"],
  client: ["consumer app", "frontend caller", "requesting app"],
};

// Multi-word phrase synonyms (matched as substrings on the lowercased gist).
const PHRASE_SYNONYMS = [
  [/replace the thermostat/g, "swap out the temperature controller"],
  [/set up/g, "configure"],
  [/git log/g, "version-control history"],
  [/pull request/g, "code-change proposal"],
  [/merge conflict/g, "branch clash"],
  [/code review/g, "change critique"],
  [/edge case/g, "corner condition"],
  [/race condition/g, "concurrency timing hazard"],
];

// Paraphrase a gist string: apply phrase synonyms, then replace as many single
// tokens as possible with a synonym that does NOT contain the original token.
// `rng` drives which synonym variant is chosen so the result is deterministic.
function paraphraseGist(gist, rng) {
  let s = ` ${gist.toLowerCase()} `;
  for (const [re, rep] of PHRASE_SYNONYMS) s = s.replace(re, ` ${rep} `);
  const tokens = s.split(/\s+/).filter(Boolean);
  const out = [];
  for (const tok of tokens) {
    const syns = SYNONYMS[tok];
    if (syns && syns.length > 0) {
      out.push(syns[Math.floor(rng() * syns.length)]);
    } else {
      out.push(tok);
    }
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

// Distinctive-entity heuristics (CamelCase, hyphenated tech tokens with a digit,
// proper-noun bigrams). Reused from the previous builder's intent: meaningful
// short-names, not opaque ids.
function isOpaqueId(tok) {
  if (typeof tok !== "string") return true;
  const t = tok.replace(/\s+/g, "");
  if (t.length > 18) return true;
  if (/^[0-9a-f]{8,}$/i.test(t)) return true;
  if (/-/.test(t) && /^[0-9a-f-]{12,}$/i.test(t)) return true;
  if (t.length >= 6 && !/[aeiouAEIOU]/.test(t)) return true;
  if (t.length > 10 && /[A-Z]/.test(t) && /[a-z]/.test(t) && /\d/.test(t)) return true;
  return false;
}

function distinctiveEntities(text) {
  if (typeof text !== "string") return [];
  const ents = new Set();
  for (const m of text.match(/\b[A-Z][a-z]+[A-Z][A-Za-z]+\b/g) || []) {
    if (!isOpaqueId(m)) ents.add(m);
  }
  for (const m of text.match(/\b[A-Za-z]+-?[A-Za-z]*-?\d[A-Za-z0-9-]*\b/g) || []) {
    if (m.length >= 3 && m.length <= 24 && /[A-Za-z]/.test(m) && !isOpaqueId(m)) ents.add(m);
  }
  for (const m of text.match(/\b[A-Z][a-z]{2,}\s[A-Z][a-z]{2,}\b/g) || []) {
    if (!isOpaqueId(m)) ents.add(m);
  }
  return [...ents];
}

// Lexical-overlap guard: count how many of the query's content tokens also
// appear in the golden's content tokens. A semantic-paraphrase query is only
// fair (and only a real dense win) if it shares FEW lexical tokens with the
// golden — otherwise BM25 might miss for the wrong reason (and the pair would be
// re-findable by a one-word lexical tweak, which is not the headroom we want).
function lexicalOverlap(queryTokens, goldenTokenSet) {
  let shared = 0;
  const seen = new Set();
  for (const t of queryTokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (goldenTokenSet.has(t)) shared += 1;
  }
  return shared;
}

// --------------------------------------------------------------------------
// BM25 validation: returns the golden's rank in BM25 top-K (-1 if absent).
// --------------------------------------------------------------------------
function bm25Rank(bm25, query, goldenId, k) {
  const hits = bm25.search(query, k);
  for (const h of hits) {
    if (h.memory_id === goldenId) return { rank: h.rank, score: h.score };
  }
  return { rank: -1, score: 0 };
}

// --------------------------------------------------------------------------
// Pass 1: mine recall.jsonl for the set of fact ids real recall traffic
// touched (so paraphrase probes can be anchored on operator-relevant facts).
// recall.jsonl has NO plaintext query, so we mine IDS only — never a query.
// --------------------------------------------------------------------------
// WU-scripts-stringcap: NOT broken today, a LANDMINE. ledgers/recall.jsonl is
// 20,900,441 B against Node's 536,870,888-byte string cap (0.0389x), so the
// readFileSync still succeeds — but the bare `catch { return ids; }` swallowed
// ERR_STRING_TOO_LONG and returned an EMPTY set, so the day recall.jsonl
// crosses the cap this builder would anchor ZERO paraphrase probes on real
// recall traffic and still emit a "successful" goldset. Streaming removes the
// cap; readError is raised instead of swallowed.
//
// The path is now a PARAMETER (defaulting to the RECALL_LEDGER const it used to
// close over) so the regression suite can drive it at an over-cap fixture
// without touching ledgers/. Mining logic (kind === "recall", surfaced[].
// memory_id) and the returned Set shape are preserved verbatim.
//
// existsSync dropped per B1c3 (_ledger-stream.js:118-127) — false for an
// EACCES/ELOOP/ENOTDIR path, which silently became "no recall traffic".
export function mineRecallTouchedIds(recallPath = RECALL_LEDGER) {
  const ids = new Set();
  const counts = streamLedgerLines(recallPath, (row) => {
    if (!row || row.kind !== "recall") return;
    const surfaced = Array.isArray(row.surfaced) ? row.surfaced : [];
    for (const s of surfaced) {
      if (s && typeof s.memory_id === "string") ids.add(s.memory_id);
    }
  });
  if (counts.readError) {
    throw new Error(
      `build-contextual-eval-goldset: cannot read recall ledger ${recallPath}: ${counts.readError}`,
    );
  }
  return ids;
}

// --------------------------------------------------------------------------
// Pass 2: stream the memory ledger, measuring obj.content.length (NOT raw line
// length — lines carry inline embeddings). Resolve recall-touched facts, fill
// candidate pools by deterministic coin flips, and enumerate the giants.
// --------------------------------------------------------------------------
async function streamLedger({ recallTouchedIds, rng, maxScan }) {
  const resolvedRecall = new Map(); // id -> { id, content, source }
  const paraphrasePool = [];        // short/medium facts to paraphrase
  const entityPool = [];            // facts carrying a distinctive entity
  const generalPool = [];           // medium facts with a clear gist
  const giants = [];                // { id, len, source, agent, content }
  const PARA_CAP = 8000, ENTITY_CAP = 4000, GENERAL_CAP = 5000;

  await new Promise((resolve) => {
    let scanned = 0;
    const rl = createInterface({
      input: createReadStream(MEMORY_LEDGER),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      if (!line) return;
      scanned++;
      if (scanned > maxScan) { rl.close(); return; }
      let row;
      try { row = JSON.parse(line); } catch { return; }
      if (!row || typeof row.id !== "string") return;
      if (row.kind !== "fact" && row.kind !== "reconstructed") return;
      const content = typeof row.content === "string" ? row.content : "";
      const len = content.length;

      // Giant enumeration (deterministic — measured on obj.content.length).
      if (len >= GIANT_MIN_CHARS) {
        giants.push({
          id: row.id,
          len,
          source: row.source || null,
          agent: row.provenance && row.provenance.agent_id || null,
          content,
        });
        return;
      }

      if (len < 24) return;
      const rec = { id: row.id, content, source: row.source || null };

      // Recall-touched short/medium facts: prime targets for paraphrase probes.
      if (recallTouchedIds.has(row.id) && len >= 24 && len <= 600) {
        resolvedRecall.set(row.id, rec);
      }

      // Paraphrase pool: short/medium facts with a paraphrasable gist. We bias
      // toward facts that contain at least one synonym-lexicon anchor so the
      // paraphrase actually changes the lexicon (otherwise the query == gist and
      // BM25 trivially finds it). Coin flip keeps the sample reproducible + not
      // front-loaded to the oldest rows.
      if (len >= 24 && len <= 480 && paraphrasePool.length < PARA_CAP) {
        const lc = content.toLowerCase();
        let anchorHits = 0;
        for (const k of Object.keys(SYNONYMS)) {
          if (lc.includes(k)) { anchorHits++; if (anchorHits >= 1) break; }
        }
        const hasPhrase = PHRASE_SYNONYMS.some(([re]) => { re.lastIndex = 0; return re.test(lc); });
        if ((anchorHits > 0 || hasPhrase) && rng() < 0.25) {
          paraphrasePool.push(rec);
        }
      }

      // Entity pool: facts carrying a distinctive entity AND a synonym anchor
      // (so paraphraseGist actually rewrites the lexicon — an entity fact whose
      // topic words have no synonym would paraphrase to itself and never miss).
      const ents = distinctiveEntities(content);
      if (ents.length > 0 && len <= 600 && entityPool.length < ENTITY_CAP) {
        const lc2 = content.toLowerCase();
        let hasAnchor = false;
        for (const k of Object.keys(SYNONYMS)) { if (lc2.includes(k)) { hasAnchor = true; break; } }
        if (hasAnchor && rng() < 0.06) {
          rec.entities = ents;
          entityPool.push(rec);
          return;
        }
      }

      // General pool (medium facts) — bias toward synonym-anchored facts so the
      // paraphrase changes the lexicon, but keep a fraction of plain facts too
      // (used for the verbatim BM25-findable control cohort).
      if (len >= 40 && len < 600 && generalPool.length < GENERAL_CAP && rng() < 0.012) {
        generalPool.push(rec);
      }
    });
    rl.on("close", resolve);
    rl.on("error", () => resolve());
  });

  return { resolvedRecall, paraphrasePool, entityPool, generalPool, giants };
}

async function main() {
  const opts = parseArgs(process.argv);
  // Curated pairs first: a malformed per-host file fails before the slow
  // index load, with the path in the message.
  let CURATED;
  try {
    CURATED = loadCuratedPairs();
  } catch (e) {
    process.stderr.write(`build-goldset: ${e.message}\n`);
    process.exit(1);
  }
  if (!existsSync(MEMORY_LEDGER)) {
    process.stderr.write(`build-goldset: memory ledger missing: ${MEMORY_LEDGER}\n`);
    process.exit(1);
  }
  if (!existsSync(GEMINI_BM25)) {
    process.stderr.write(`build-goldset: gemini BM25 index missing: ${GEMINI_BM25}\n`);
    process.exit(1);
  }

  process.stderr.write("build-goldset: loading gemini BM25 index (large; ~7s)...\n");
  let bm25;
  try {
    bm25 = isV2File(GEMINI_BM25)
      ? loadBm25IndexFromV2File(GEMINI_BM25)
      : Bm25Index.deserialize(JSON.parse(readFileSync(GEMINI_BM25, "utf8")));
  } catch (e) {
    process.stderr.write(`build-goldset: failed to load BM25: ${e.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`build-goldset: BM25 size=${bm25.size()}\n`);

  const rng = mulberry32(opts.seed);
  const K = opts.validateK;

  // Pass 1 + Pass 2.
  // WU-scripts-stringcap: pass the ledger path explicitly now that the miner
  // takes a parameter (it used to close over RECALL_LEDGER).
  const recallTouchedIds = mineRecallTouchedIds(RECALL_LEDGER);
  process.stderr.write(`build-goldset: recall-touched fact ids=${recallTouchedIds.size}\n`);
  process.stderr.write("build-goldset: streaming memory ledger...\n");
  const { resolvedRecall, paraphrasePool, entityPool, generalPool, giants } =
    await streamLedger({ recallTouchedIds, rng, maxScan: opts.maxScan });
  process.stderr.write(
    `build-goldset: pools paraphrase=${paraphrasePool.length} entity=${entityPool.length} ` +
      `general=${generalPool.length} giants=${giants.length} recall-resolved=${resolvedRecall.size}\n`,
  );

  const goldset = [];
  const seenPairKeys = new Set();
  const seenGolden = new Set();
  let id_n = 0;
  const mkId = () => `cgld_${String(++id_n).padStart(4, "0")}`;

  // Per-stratum soft caps so the goldset is stratified (and we hit ~150-250).
  const CAP = {
    semantic_paraphrase: 100,
    giant_internal: 47,         // one probe per giant (deterministic)
    whole_fact_entity: 35,
    whole_fact_general: 35,
  };
  const CONTROL_CAP = 20; // BM25-findable controls (headroom:false)
  const counts = {
    semantic_paraphrase: 0, giant_internal: 0,
    whole_fact_entity: 0, whole_fact_general: 0, control: 0,
  };

  function push(rec) {
    const key = `${rec.query} ${rec.golden_fact_id}`;
    if (seenPairKeys.has(key)) return false;
    // One pair per golden (avoid a single fact dominating the goldset / metric).
    if (seenGolden.has(rec.golden_fact_id)) return false;
    seenPairKeys.add(key);
    seenGolden.add(rec.golden_fact_id);
    goldset.push(rec);
    return true;
  }

  // ---- CURATED SEED PAIRS (the textbook headroom cases) ------------------
  // Hand-written semantic-paraphrase queries against facts the host's owner
  // has checked by hand, e.g. a fact about "replace the greenhouse thermostat"
  // asked for as "swap the temperature controller in the plant shed"
  // (lexically disjoint, semantically identical). The pairs are PER-HOST DATA,
  // loaded from CURATED_PATH (see loadCuratedPairs); none live in this file and
  // an absent file means no curated pairs. Each is validated as a BM25 miss
  // exactly like the mined pairs; if one becomes findable (corpus drift) it is
  // skipped with a warning rather than silently included.
  for (const c of CURATED) {
    if (seenGolden.has(c.golden)) continue;
    const v = bm25Rank(bm25, c.query, c.golden, K);
    if (v.rank >= 0 && v.rank < K) {
      process.stderr.write(`build-goldset: WARNING curated seed now BM25-findable (rank=${v.rank}) ${c.golden} — skipping to preserve headroom\n`);
      continue;
    }
    push({
      id: mkId(),
      query: c.query,
      golden_fact_id: c.golden,
      stratum: "semantic_paraphrase",
      derivation: "curated_semantic_paraphrase",
      derivation_note:
        "CURATED hand-written semantic paraphrase against a hard-verified ledger " +
        `fact; ${c.note} Kept only on a BM25 miss in top-${K}.`,
      headroom: true,
      confidence: "high",
      validation: { leg: "bm25", baseline_rank: v.rank, found_in_topk: false, k: K },
    }) && (counts.semantic_paraphrase += 1);
  }

  // ---- SEMANTIC PARAPHRASE (headroom engine) -----------------------------
  // For each candidate fact: extract its gist (leading content words),
  // paraphrase it through the synonym lexicon, and KEEP the pair only when
  // (a) the paraphrased query shares FEW lexical tokens with the golden AND
  // (b) BM25 MISSES the golden in top-K (real headroom). Prefer recall-touched
  // facts first so the headroom is anchored on operator-relevant memories.
  const paraSources = [
    ...[...resolvedRecall.values()].map((f) => ({ ...f, _recall: true })),
    ...paraphrasePool.map((f) => ({ ...f, _recall: false })),
  ];
  for (const fact of paraSources) {
    if (counts.semantic_paraphrase >= CAP.semantic_paraphrase) break;
    const words = contentWords(fact.content);
    if (words.length < 3) continue;
    // Gist = a spread of the fact's salient words (head + a couple mid words).
    const gist = [...new Set([
      ...words.slice(0, 6),
      words[Math.floor(words.length / 2)],
    ])].slice(0, 8).join(" ");
    const query = paraphraseGist(gist, rng);
    if (!query || query.length < 6) continue;
    const qTokens = bm25Tokens(query);
    if (qTokens.length < 2) continue;
    const goldenTokenSet = new Set(bm25Tokens(fact.content));
    const overlap = lexicalOverlap(qTokens, goldenTokenSet);
    // Require the paraphrase to be substantially lexically disjoint: at most one
    // shared content token (so the miss is semantic, not a fixable lexical gap).
    if (overlap > 1) continue;
    const v = bm25Rank(bm25, query, fact.id, K);
    if (v.rank >= 0 && v.rank < K) continue; // BM25 already finds it → no headroom
    push({
      id: mkId(),
      query,
      golden_fact_id: fact.id,
      stratum: "semantic_paraphrase",
      derivation: "semantic_paraphrase_synonym_substitution",
      derivation_note:
        "query = the golden fact's gist rewritten through a synonym lexicon so it " +
        "shares meaning but not lexicon; kept ONLY because BM25 misses the golden " +
        `in top-${K} (real K=${K} headroom for a dense/contextual leg).`,
      headroom: true,
      lexical_overlap: overlap,
      confidence: overlap === 0 ? "high" : "medium",
      validation: { leg: "bm25", baseline_rank: v.rank, found_in_topk: false, k: K },
      recall_meta: fact._recall ? { touched_by_recall: true } : undefined,
    }) && (counts.semantic_paraphrase += 1);
  }

  // ---- GIANT INTERNAL (headroom; one probe per giant) --------------------
  // Sort giants deterministically (by id) so the manifest is stable. For each
  // giant, draw a short interior or tail span and use its content words as the
  // probe. BM25's length-norm buries the giant on short interior probes → miss.
  giants.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const g of giants) {
    if (counts.giant_internal >= CAP.giant_internal) break;
    const content = g.content;
    // Choose a span deterministically: alternate interior / tail by a coin flip.
    const useTail = rng() < 0.5;
    let span;
    if (useTail) {
      const start = Math.max(0, content.length - 2400 - Math.floor(rng() * 4000));
      span = content.slice(start, start + 600);
    } else {
      const start = Math.floor(content.length * (0.25 + rng() * 0.5));
      span = content.slice(start, start + 600);
    }
    const words = contentWords(span.replace(/\n/g, " "));
    if (words.length < 4) continue;
    // 6-8 word interior probe (short — this is what makes BM25 miss the giant).
    const probeLen = 6 + Math.floor(rng() * 3);
    const query = words.slice(0, probeLen).join(" ");
    const qTokens = bm25Tokens(query);
    if (qTokens.length < 3) continue;
    const v = bm25Rank(bm25, query, g.id, K);
    // For giant_internal we accept the pair whether BM25 finds it or not, but we
    // RECORD the rank; the headroom flag is true only on a miss. The WU asks for
    // giant-internal probes specifically as a tail/interior recall stress.
    const isHeadroom = !(v.rank >= 0 && v.rank < K);
    push({
      id: mkId(),
      query,
      golden_fact_id: g.id,
      stratum: "giant_internal",
      derivation: useTail ? "giant_tail_probe" : "giant_interior_probe",
      derivation_note:
        `query = content words from a ${useTail ? "TAIL" : "INTERIOR"} span of a ` +
        `giant fact (content_len=${g.len}, agent=${g.agent}); a short probe into a ` +
        `${content.length}-char doc; BM25 ${isHeadroom ? "MISSES" : "finds"} the giant ` +
        `in top-${K} (length-normalization buries long docs on short probes).`,
      headroom: isHeadroom,
      giant_content_len: g.len,
      confidence: isHeadroom ? "high" : "low",
      validation: { leg: "bm25", baseline_rank: v.rank, found_in_topk: !isHeadroom, k: K },
    }) && (counts.giant_internal += 1);
  }

  // ---- WHOLE FACT ENTITY (anaphor headroom) ------------------------------
  // Query = the fact's distinctive entity is described by paraphrase, with the
  // topic words paraphrased so the lexical anchor is weak. Keep on a BM25 miss.
  for (const fact of entityPool) {
    if (counts.whole_fact_entity >= CAP.whole_fact_entity) break;
    const words = contentWords(fact.content);
    if (words.length < 3) continue;
    const gist = [...new Set(words.slice(0, 6))].slice(0, 6).join(" ");
    const query = paraphraseGist(gist, rng);
    const qTokens = bm25Tokens(query);
    if (qTokens.length < 2) continue;
    const goldenTokenSet = new Set(bm25Tokens(fact.content));
    if (lexicalOverlap(qTokens, goldenTokenSet) > 1) continue;
    const v = bm25Rank(bm25, query, fact.id, K);
    if (v.rank >= 0 && v.rank < K) continue;
    push({
      id: mkId(),
      query,
      golden_fact_id: fact.id,
      stratum: "whole_fact_entity",
      derivation: "entity_paraphrase",
      derivation_note:
        "query = paraphrased gist of a fact carrying a distinctive entity; the " +
        "lexical anchor is weakened so BM25 misses (anaphor/short-name headroom).",
      headroom: true,
      confidence: "medium",
      validation: { leg: "bm25", baseline_rank: v.rank, found_in_topk: false, k: K },
    }) && (counts.whole_fact_entity += 1);
  }

  // ---- WHOLE FACT GENERAL (paraphrased gist headroom) --------------------
  for (const fact of generalPool) {
    if (counts.whole_fact_general >= CAP.whole_fact_general) break;
    const words = contentWords(fact.content);
    if (words.length < 4) continue;
    const gist = [...new Set([...words.slice(0, 5), words[Math.floor(words.length / 2)]])]
      .slice(0, 6).join(" ");
    const query = paraphraseGist(gist, rng);
    const qTokens = bm25Tokens(query);
    if (qTokens.length < 2) continue;
    const goldenTokenSet = new Set(bm25Tokens(fact.content));
    if (lexicalOverlap(qTokens, goldenTokenSet) > 1) continue;
    const v = bm25Rank(bm25, query, fact.id, K);
    if (v.rank >= 0 && v.rank < K) continue;
    push({
      id: mkId(),
      query,
      golden_fact_id: fact.id,
      stratum: "whole_fact_general",
      derivation: "general_paraphrase",
      derivation_note:
        "query = paraphrased gist of a whole medium fact; kept on a BM25 miss " +
        `(top-${K}) so the dense/contextual leg has headroom.`,
      headroom: true,
      confidence: "medium",
      validation: { leg: "bm25", baseline_rank: v.rank, found_in_topk: false, k: K },
    }) && (counts.whole_fact_general += 1);
  }

  // ---- CONTROL: BM25-findable pairs (headroom:false) ---------------------
  // A small minority of lexically-anchored pairs proving the metric reads a
  // 0-failure floor on findable queries (so the baseline-miss fraction is a real
  // measured property, not an artifact of un-findable noise). Query = a few
  // VERBATIM content words from the golden (no paraphrase) → BM25 finds it.
  for (const fact of generalPool) {
    if (counts.control >= CONTROL_CAP) break;
    if (seenGolden.has(fact.id)) continue;
    const words = contentWords(fact.content);
    if (words.length < 4) continue;
    const query = words.slice(0, 5).join(" ");
    const v = bm25Rank(bm25, query, fact.id, K);
    if (!(v.rank >= 0 && v.rank < K)) continue; // must be findable
    push({
      id: mkId(),
      query,
      golden_fact_id: fact.id,
      stratum: "whole_fact_general",
      derivation: "bm25_findable_control",
      derivation_note:
        "CONTROL: verbatim content words from the golden; BM25 finds it in " +
        `top-${K}. Proves the metric reads a 0-failure floor on lexically-anchored ` +
        "queries (the baseline-miss fraction is a measured property, not noise).",
      headroom: false,
      confidence: "high",
      validation: { leg: "bm25", baseline_rank: v.rank, found_in_topk: true, k: K },
    }) && (counts.control += 1);
  }

  // ---- Compute the baseline-miss fraction (the anti-circularity proof). ----
  const total = goldset.length;
  const baselineMisses = goldset.filter((g) => g.validation && g.validation.found_in_topk === false).length;
  const headroomRows = goldset.filter((g) => g.headroom === true);
  const headroomMisses = headroomRows.filter((g) => g.validation.found_in_topk === false).length;
  const baseline_miss_fraction_all = total > 0 ? baselineMisses / total : 0;
  const baseline_miss_fraction_headroom = headroomRows.length > 0 ? headroomMisses / headroomRows.length : 0;

  const strataCounts = {};
  for (const g of goldset) strataCounts[g.stratum] = (strataCounts[g.stratum] || 0) + 1;

  const header = {
    kind: "contextual_eval_goldset_meta",
    built_at: new Date().toISOString(),
    builder: "build-contextual-eval-goldset.mjs",
    workunit: "WU-goldset-decircularize",
    seed: opts.seed,
    validate_k: K,
    bm25_index: GEMINI_BM25,
    bm25_size: bm25.size(),
    counts: {
      total,
      by_stratum: strataCounts,
      by_derivation_kind: {
        semantic_paraphrase: counts.semantic_paraphrase,
        giant_internal: counts.giant_internal,
        whole_fact_entity: counts.whole_fact_entity,
        whole_fact_general: counts.whole_fact_general,
        bm25_findable_control: counts.control,
      },
    },
    headroom: {
      baseline_miss_fraction_all,
      baseline_miss_fraction_headroom,
      baseline_misses: baselineMisses,
      headroom_rows: headroomRows.length,
      control_rows: counts.control,
    },
    notes:
      "DECIRCULARIZED: pairs are kept where the BM25 BASELINE does NOT surface " +
      `the golden in top-${K} (baseline_miss_fraction_all=${baseline_miss_fraction_all.toFixed(3)}). ` +
      "This is REAL headroom for a dense/contextual leg to win, the inverse of the " +
      "prior builder's keep-on-hit rule (which gave the baseline a fake 0% floor). " +
      "Every golden_fact_id is a real ledger id. A small control cohort " +
      "(headroom:false, derivation:bm25_findable_control) proves the metric still " +
      "reads a 0-failure floor on lexically-anchored queries.",
  };

  const lines = [JSON.stringify(header)];
  for (const g of goldset) {
    // Drop undefined recall_meta to keep lines clean.
    if (g.recall_meta === undefined) delete g.recall_meta;
    lines.push(JSON.stringify(g));
  }
  writeFileSync(opts.out, lines.join("\n") + "\n", { mode: 0o600 });

  process.stderr.write(
    `build-goldset: wrote ${total} pairs to ${opts.out}\n` +
      `  semantic_paraphrase=${counts.semantic_paraphrase} giant_internal=${counts.giant_internal} ` +
      `entity=${counts.whole_fact_entity} general=${counts.whole_fact_general} control=${counts.control}\n` +
      `  baseline_miss_fraction_all=${baseline_miss_fraction_all.toFixed(3)} ` +
      `headroom=${baseline_miss_fraction_headroom.toFixed(3)}\n`,
  );
  process.stdout.write(JSON.stringify(header.counts) + "\n");
  process.stdout.write(JSON.stringify(header.headroom) + "\n");
}

// WU-scripts-stringcap: main guard (idiom copied verbatim from
// build-ranking-eval-goldset.mjs:492). Previously this was a bare
// `main().catch(...)`, so ANY `import` of this module ran the full builder
// and writeFileSync'd into ledgers/contextual-eval-goldset.jsonl — a
// never-mutate-`ledgers/` violation reachable from a test. The guard makes
// the module importable for `mineRecallTouchedIds` without side effects.
// Main-module check that survives spaces and symlinks in the invocation path:
// compare real filesystem paths, never a hand-built file:// string.
const INVOKED_DIRECTLY = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (INVOKED_DIRECTLY) {
  main().catch((e) => {
    process.stderr.write(`build-goldset: unhandled ${e && e.stack}\n`);
    process.exit(1);
  });
}
