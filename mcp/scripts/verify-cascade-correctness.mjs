#!/usr/bin/env node
// verify-cascade-correctness.mjs
//
// Operator post-cooldown verification script for R29.4.
//
// WHAT THIS SCRIPT CAN AND CANNOT PROVE
// -------------------------------------
// The R29.3 guarantee, as stated in kb/api-key-pool.md, is "no row was
// promoted with a missing or malformed embedding". This script can only
// verify the MALFORMED half. Absence of an INLINE vector on a fact row is
// NOT evidence of a missing embedding, because vectors also live in a
// sidecar: indices/qwen3-embedding-8b-fp16/vectors.jsonl, measured
// 10,760,893,291 B with mtime 2026-08-11T21:32:56Z (re-stat'd unchanged at
// 2026-08-11T22:06:51Z) at census time. That
// path is `SIDECAR = join(INDEX_DIR, "vectors.jsonl")` with
// `MODEL_VERSION` defaulting to "qwen3-embedding-8b-fp16" in
// mcp/scripts/reembed-local-4096.mjs. (Do not confuse it with the stale
// sibling indices/qwen3-embedding-8b-fp16/embeddings-sidecar.jsonl,
// measured 129,423,401 B, mtime 2026-06-21T16:39:19Z.) A verdict of
// NO_INLINE_EMBEDDINGS or PARTIAL_INLINE_COVERAGE therefore says nothing
// bad about the corpus; only a corrupt fact row is a real defect here.
//
// CENSUS (node s8-cascade-verdict-shapes, measured 2026-08-11T22:06:03Z on
// ledgers/memory.jsonl at 3,068,082,670 B; one streaming pass, 1,519,012
// lines, 1,519,012 parsed, 0 skipped, readError null). Non-smoke rows: 108,899.
//
//   kind          fact 106,016 | reconstructed 1,832 | policy 1,051
//                 (no non-smoke row lacked a `kind`)
//   policy_kind   embedding_backfill 701 | salience.recall_feedback 267
//                 | feature_backfill 83
//
//   fact-row embedding keys, as measured over all 106,016 fact rows:
//     features.embedding_4096       array[4096] 12,120 | null 43,311 | missing 50,585
//     features.embedding_3072       null 93,893 | missing 12,123
//     features.embedding_mrl_768    array[768] 3 | null 93,893 | missing 12,120
//     embedding_mrl_768             missing 106,016
//     features.embedding            missing 106,016
//     embedding                     missing 106,016
//     features.embed_state          boolean 106,015 | missing 1
//   Every one of the 12,120 array[4096] values measured length 4096, all
//   elements finite, ||v|| within 1e-6 of 1.0. All 3 array[768] values
//   measured length 768, finite, unit-norm. ZERO malformed fact rows.
//   The fact buckets partition the population exactly:
//   12,120 + 3 + 93,893 = 106,016.
//   THREE buckets are emitted on this population, not four: every absent row
//   carries an explicit null under SOME probed key, so classifyRow's
//   `sawNull ? "F-NULL-MARKER" : "F-KEY-MISSING"` terminates at F-NULL-MARKER
//   for all 93,893. F-KEY-MISSING exists, is named, and has ZERO live
//   occurrences — it is reachable only by a row carrying no probed key at all.
//   (Corrected 2026-08-12 by the orchestrator: the prior text claimed a
//   four-way split and assigned ~50,582 rows to F-KEY-MISSING. A live run
//   emits fact_bucket_census keys {F-NULL-MARKER, F-VALID-4096, F-VALID-768}
//   only, and this file's own suite pins that at
//   mcp/test/cascade-verdict-shapes.test.mjs:493. The comment was the wrong
//   one of the two.)
//   The ledger grows continuously; these counts are true as of the stamp
//   above, and the SHAPES — not the counts — are what this script keys on.
//
// WHY THE PROBE WAS WIDENED: the previous four-key probe read only
// features.embedding_mrl_768, embedding_mrl_768, features.embedding and
// embedding, so it could not see the 12,120 valid inline 4096-dim vectors —
// the largest valid-vector population on the ledger. It reported them as
// "missing_or_wrong_length" and the corpus as FAIL (reproduced in-session
// against the committed pre-widening script: a corpus of 5 fact rows each
// carrying a valid unit-norm features.embedding_4096 emitted
// verdict FAIL / exit 1 with without_embedding === sampled === 5). Keys are
// probed 4096 -> 3072 -> features.embedding_mrl_768 -> embedding_mrl_768 ->
// features.embedding -> embedding, i.e. measured populations first
// (12,120, then 0-but-null-bearing, then 3), then the three keys that are
// absent on every live fact row and are retained only so the original
// four-key contract is not silently dropped.
//
// ABSENCE IS NOT CORRUPTION. An explicit `null` and a missing key BOTH mean
// ABSENT. This matches what recall actually does at dispatch: see
// mcp/lib/recall/multi-feature-score.js, whose `candidateEmbeddingNull` is
// `candidateFeatures.embed_state === true && candidateFeatures.embedding_4096
// == null && candidateFeatures.embedding_3072 == null`; when that holds AND
// nothing hydrated from the index (`s_emb_full3072 === 0`) recall sets
// `embedding_source = "none"` and takes the additive fallback. Loose `==`
// covers both live sub-shapes — the 43,311 rows carrying an explicit
// `embedding_4096: null` and the 50,582 rows that OMIT `embedding_4096` and
// carry `embedding_3072: null`. BOTH score F-NULL-MARKER: classifyRow sets
// sawNull on an explicit null under ANY probed key, so the bucket does not
// depend on WHICH key carries it. (Corrected 2026-08-12: the prior text said
// these were "counted separately (F-NULL-MARKER vs F-KEY-MISSING)", which the
// code contradicts and this file's own suite refutes at
// mcp/test/cascade-verdict-shapes.test.mjs:493.) (The remaining 3 of the
// 50,585 rows without an `embedding_4096` key carry a valid inline
// `features.embedding_mrl_768` and so score F-VALID-768, not absent.)
//
// POLICY AND RECONSTRUCTED ROWS ARE NEVER SCORED. All 701 embedding-bearing
// policy rows measured `policy_kind: "embedding_backfill"` carrying
// `embedding: {vector_3072: array[3072] finite unit-norm, vector_mrl_768:
// null}` (700 rows) or the same with `vector_mrl_768: array[768] finite
// unit-norm` (1 row, mem_0000000000000001). Per
// mcp/docs/specs/ccs/cascade-embedding-decoupling.md §5 that envelope's
// vector belongs to `target_fact_id` — a DIFFERENT row — so scoring the
// envelope as if it were its own embedding would be a category error. These
// rows are counted into `not_applicable` and excluded from the verdict.
//
// R29.5: strict checks (L2-norm within 1e-6 of 1.0, non-zero, all finite) are
// the DEFAULT. Pass --lenient to opt out of the NORM check only; the declared
// length and the all-finite checks still run in both modes. The legacy
// --strict flag is preserved as a no-op alias for back-compat.
//
// Pre-wipe smoke rows are filtered out via, in priority order:
//   (a) provenance.is_seed_row === true (R29.5 forward-looking marker), then
//   (b) legacy fallback: provenance.conversation_id === "conv_smoke" OR
//       content matching known smoke fixtures OR created_at < WIPE_THRESHOLD.
// WIPE_THRESHOLD is a convention; future wipes must bump it.
//
// READ PATH (WU-scripts-stringcap, preserved verbatim): the whole-ledger
// readFileSync crossed Node's max string length (in-session measured cap
// 536,870,888 bytes, i.e. buffer.constants.MAX_STRING_LENGTH, against a
// 3,068,082,670-byte ledger) and threw ERR_STRING_TOO_LONG
// before emitting anything. The script streams via streamLedgerLines in ONE
// pass and never materializes parsed rows. The census below runs INSIDE that
// same callback and retains counters only, so peak retention is
// O(distinct shapes) + O(SAMPLE_SIZE) regardless of ledger size.
//
// THE VERDICT IS A PURE FUNCTION OF THE FULL-CORPUS CENSUS, never of the
// reservoir sample. The sample survives only to populate `sampled` and
// `failed_ids_first_10`.
//
// Exit codes:
//   0 = PASS / NO_PRODUCTION_ROWS / NO_FACT_ROWS / NO_INLINE_EMBEDDINGS /
//       PARTIAL_INLINE_COVERAGE
//   1 = FAIL (>=1 malformed fact row) / UNKNOWN_ROW_KINDS (a kind outside
//       the censused set — never silently absorbed)
//   2 = ledger file not found / unreadable
//
// Usage:
//   node verify-cascade-correctness.mjs [--sample=100] [--lenient] [--ledger=PATH]

import { statSync } from "node:fs"; import { dirname, join, resolve } from "node:path"; import { fileURLToPath } from "node:url";

import { streamLedgerLines } from "../lib/synthesis/_ledger-stream.js";

// WIPE_THRESHOLD: most recent ledger wipe. Rows created before this are
// considered pre-wipe smoke and filtered out. Future wipes MUST bump this.
const WIPE_THRESHOLD = "2026-06-03T03:57:00Z";

const args = process.argv.slice(2);
const sampleArg = args.find((a) => a.startsWith("--sample="));
const ledgerArg = args.find((a) => a.startsWith("--ledger="));
const SAMPLE_SIZE = sampleArg ? parseInt(sampleArg.split("=")[1], 10) : 100;
const LENIENT = args.includes("--lenient");
// R29.5: strict is the default. --strict is preserved as a no-op alias for
// back-compat; emit a stderr note so operators learn the new default.
const STRICT = !LENIENT;
if (args.includes("--strict")) {
  process.stderr.write(
    "verify-cascade: note: --strict is the default since R29.5; flag is a no-op alias\n"
  );
}
const ledgerPath = ledgerArg
  ? ledgerArg.split("=")[1]
  : join(process.env.MEMORY_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "ledgers", "memory.jsonl");

// B1c3 (_ledger-stream.js:118-127): the former existsSync short-circuit
// returned false for a file behind EACCES / ELOOP / ENOTDIR, conflating
// "unreadable" with "missing". statSync classifies by errno instead, so a
// genuinely absent ledger keeps its historical exit 2 while an unreadable one
// says what actually went wrong.
try {
  statSync(ledgerPath);
} catch (e) {
  if (e && e.code === "ENOENT") {
    process.stderr.write("verify-cascade: " + ledgerPath + " not found\n");
  } else {
    process.stderr.write(
      "verify-cascade: " + ledgerPath + " unreadable: " + (e && e.message) + "\n"
    );
  }
  process.exit(2);
}

const KNOWN_SMOKE_CONTENT = new Set([
  "USER: hi\nASSISTANT: hello",
  "REPLAY-TEST-CONTENT-uniqueA1",
]);

function isSmoke(r) {
  // R29.5: priority (a) explicit is_seed_row marker; (b) legacy fallbacks.
  if (r?.provenance?.is_seed_row === true) return true;
  if (r?.provenance?.conversation_id === "conv_smoke") return true;
  if (typeof r?.content === "string" && KNOWN_SMOKE_CONTENT.has(r.content))
    return true;
  if (typeof r?.created_at === "string" && r.created_at < WIPE_THRESHOLD)
    return true;
  return false;
}

// CENSUSED_KINDS: the complete set of non-smoke `kind` values measured on
// ledgers/memory.jsonl on 2026-08-11T22:06:03Z (fact 106,016 / reconstructed 1,832 /
// policy 1,051; no non-smoke row lacked a `kind`). Anything outside this set
// is counted and NAMED via the UNKNOWN_ROW_KINDS verdict — silent absorption
// of a new row kind is exactly the pathology this script exists to close.
const CENSUSED_KINDS = new Set(["fact", "reconstructed", "policy"]);

// Fact-row embedding keys, in census-justified probe order (see header).
// `dim` is the declared dimension the value must match to be VALID.
// The last three carry dim 768 because that is the length contract the
// pre-existing four-key probe enforced on them; they are absent on all
// 106,016 live fact rows, so no census measurement contradicts or confirms it.
const EMBED_KEYS = [
  { label: "features.embedding_4096", inFeatures: true, prop: "embedding_4096", dim: 4096 },
  { label: "features.embedding_3072", inFeatures: true, prop: "embedding_3072", dim: 3072 },
  { label: "features.embedding_mrl_768", inFeatures: true, prop: "embedding_mrl_768", dim: 768 },
  { label: "embedding_mrl_768", inFeatures: false, prop: "embedding_mrl_768", dim: 768 },
  { label: "features.embedding", inFeatures: true, prop: "embedding", dim: 768 },
  { label: "embedding", inFeatures: false, prop: "embedding", dim: 768 },
];

// Buckets that mean "no inline vector here" — never corruption. Everything
// else in the partition is a real malformation.
const ABSENT_BUCKETS = new Set(["F-KEY-MISSING", "F-NULL-MARKER"]);
const isValidBucket = (b) => b.startsWith("F-VALID-");
const isCorruptBucket = (b) => !ABSENT_BUCKETS.has(b) && !isValidBucket(b);

// Classify ONE array value already known to sit under `key`.
function classifyArray(v, key, strict) {
  if (v.length !== key.dim) return "F-WRONGLEN:" + key.label + ":" + v.length;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (typeof x !== "number" || !Number.isFinite(x)) return "F-NONFINITE-" + key.dim;
  }
  if (strict) {
    let sq = 0;
    for (let i = 0; i < v.length; i++) sq += v[i] * v[i];
    const norm = Math.sqrt(sq);
    // Catches both the degenerate zero vector (norm 0) and any un-normalized
    // vector. Skipped under --lenient; length and finiteness are not.
    if (Math.abs(norm - 1.0) > 1e-6) return "F-BADNORM-" + key.dim;
  }
  return "F-VALID-" + key.dim;
}

// Exhaustive partition of a fact row into ONE explicitly named bucket. There
// is no default fall-through: a shape this function cannot name surfaces as
// F-UNKNOWN-SHAPE carrying the raw type it could not classify.
function classifyFactRow(r, strict) {
  let sawNull = false;
  for (const key of EMBED_KEYS) {
    const holder = key.inFeatures ? r?.features : r;
    if (holder === null || typeof holder !== "object") continue;
    if (!(key.prop in holder)) continue;
    const v = holder[key.prop];
    if (v === undefined) continue;
    if (v === null) {
      // The NULL MARKER. Keep scanning: a later key may carry a real vector.
      sawNull = true;
      continue;
    }
    if (Array.isArray(v)) return classifyArray(v, key, strict);
    if (typeof v === "object") {
      // A policy-style envelope parked on a fact row. Zero live occurrences;
      // named anyway so it can never be absorbed as "just an object".
      if ("vector_3072" in v || "vector_mrl_768" in v) return "F-ENVELOPE-ON-FACT";
      return "F-UNKNOWN-SHAPE:" + key.label + ":object:keys=" + Object.keys(v).length;
    }
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
      return "F-NOTARRAY:" + key.label + ":" + typeof v;
    }
    return "F-UNKNOWN-SHAPE:" + key.label + ":" + typeof v;
  }
  // No key carried a value. Absent either way; the two sub-shapes are counted
  // apart because they are physically different rows on the live ledger.
  return sawNull ? "F-NULL-MARKER" : "F-KEY-MISSING";
}

// WU-scripts-stringcap: single streaming pass. `sampled` is the ONLY row
// retention — parsed rows are never materialized. `productionRows` counts
// non-smoke rows and doubles as the reservoir index `i`, so the sampler below
// is the pre-existing algorithm with an identical index sequence.
//
// s8: the full-corpus census runs in this SAME callback and holds counters
// only (O(distinct shapes)), so the verdict is deterministic and no second
// read of the file is introduced.
const sampled = [];
let productionRows = 0;

const kindCensus = new Map();
const policyKindCensus = new Map();
const unknownKindCensus = new Map();
const factBuckets = new Map();
let factRows = 0;

const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

const counts = streamLedgerLines(ledgerPath, (r) => {
  if (isSmoke(r)) return;
  const i = productionRows;
  productionRows += 1;

  // --- full-corpus census (counters only) ---
  const kind = typeof r?.kind === "string" ? r.kind : "<missing>";
  bump(kindCensus, kind);
  if (!CENSUSED_KINDS.has(kind)) bump(unknownKindCensus, kind);
  if (kind === "fact") {
    factRows += 1;
    bump(factBuckets, classifyFactRow(r, STRICT));
  } else if (kind === "policy") {
    bump(policyKindCensus, typeof r?.policy_kind === "string" ? r.policy_kind : "<missing>");
  }

  // Reservoir sample of size SAMPLE_SIZE (verbatim from the pre-streaming
  // version; only its enclosing loop changed). Feeds `sampled` and
  // `failed_ids_first_10` ONLY — never the verdict.
  if (i < SAMPLE_SIZE) {
    sampled.push(r);
  } else {
    const j = Math.floor(Math.random() * (i + 1));
    if (j < SAMPLE_SIZE) sampled[j] = r;
  }
});

if (counts.readError) {
  process.stderr.write(
    "verify-cascade: read failed on " + ledgerPath + ": " + counts.readError + "\n"
  );
  process.exit(2);
}

// totalRows keeps its old meaning: non-blank lines seen. smokeRows is the
// complement of the non-smoke rows, exactly as before.
const totalRows = counts.totalLines;
const smokeRows = totalRows - productionRows;

if (productionRows === 0) {
  const summary = {
    verdict: "NO_PRODUCTION_ROWS",
    total_rows: totalRows,
    smoke_rows: smokeRows,
    production_rows: 0,
    sampled: 0,
    with_embedding: 0,
    without_embedding: 0,
    bad_norm: STRICT ? 0 : null,
    pct_with_embedding: null,
    failed_ids_first_10: [],
    strict_mode: STRICT,
    // s8 additive fields, emitted here too so the output schema is uniform
    // across every verdict.
    fact_rows: 0,
    corrupt_fact_rows: 0,
    absent_fact_rows: 0,
    fact_bucket_census: {},
    kind_census: {},
    unknown_kinds: {},
    not_applicable: { total: 0, reconstructed: 0, policy: 0, policy_by_kind: {} },
    census_basis: "full_corpus",
    note:
      "Ledger has no post-wipe production rows yet. Either the daemon has not promoted any rows since the last wipe, or all source rows were Stage-0 dropped. Wait for backfill progress and re-run.",
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.stderr.write(
    "verify-cascade: WARN NO_PRODUCTION_ROWS (total=" +
      totalRows +
      ", smoke=" +
      smokeRows +
      ")\n"
  );
  process.exit(0);
}

// --- roll the census up into the reported counts ---
// These are FULL-CORPUS counts over fact rows, so they are deterministic;
// they are no longer sample counts. The field names are unchanged.
let withEmbed = 0;
let withoutEmbed = 0;
let badNorm = 0;
let corruptFactRows = 0;
for (const [bucket, n] of factBuckets) {
  if (isValidBucket(bucket)) withEmbed += n;
  else if (ABSENT_BUCKETS.has(bucket)) withoutEmbed += n;
  else corruptFactRows += n;
  if (bucket.startsWith("F-BADNORM-")) badNorm += n;
}

const sortedObj = (m) =>
  Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));

const notApplicable = {
  total: productionRows - factRows,
  reconstructed: kindCensus.get("reconstructed") || 0,
  policy: kindCensus.get("policy") || 0,
  policy_by_kind: sortedObj(policyKindCensus),
};

// failed_ids_first_10 is drawn from the reservoir sample and lists only rows
// in a CORRUPT bucket — an absent inline vector is not a failure.
const failedIds = [];
for (const r of sampled) {
  if (failedIds.length >= 10) break;
  if (r?.kind !== "fact") continue;
  const bucket = classifyFactRow(r, STRICT);
  if (isCorruptBucket(bucket)) failedIds.push((r?.id || "?") + " (" + bucket + ")");
}

const pct = factRows > 0 ? (withEmbed / factRows) * 100 : null;

// --- verdict ladder (deterministic; computed from the census above) ---
let verdict;
let note = null;
if (unknownKindCensus.size > 0) {
  verdict = "UNKNOWN_ROW_KINDS";
  note =
    "Ledger contains non-smoke rows of kind(s) outside the censused set " +
    "[" + [...CENSUSED_KINDS].join(", ") + "] (censused 2026-08-11): " +
    [...unknownKindCensus.entries()].map(([k, n]) => k + " x" + n).join(", ") +
    ". Refusing to guess whether these rows should carry an inline embedding. " +
    "Re-census the ledger and extend CENSUSED_KINDS before trusting a verdict." +
    // Corruption is never masked by an unknown kind: both exit 1, and if fact
    // rows are ALSO malformed the operator is told so in the same breath.
    (corruptFactRows > 0
      ? " SEPARATELY AND INDEPENDENTLY: " + corruptFactRows + " of " + factRows +
        " fact row(s) carry a MALFORMED inline embedding — that is a real defect " +
        "on its own and would be FAIL even with no unknown kinds present."
      : "");
} else if (factRows === 0) {
  verdict = "NO_FACT_ROWS";
  note =
    "VACUOUS RESULT — NOT a pass. " + productionRows + " non-smoke row(s) exist but " +
    "NONE is kind:\"fact\", so there was nothing to verify. policy and " +
    "reconstructed rows are never scored: a policy.embedding_backfill envelope " +
    "carries the vector for its target_fact_id, a DIFFERENT row " +
    "(mcp/docs/specs/ccs/cascade-embedding-decoupling.md §5).";
} else if (corruptFactRows > 0) {
  verdict = "FAIL";
  note =
    corruptFactRows + " of " + factRows + " fact row(s) carry a MALFORMED inline " +
    "embedding. This is a real defect regardless of what else is in the corpus.";
} else if (withoutEmbed === 0) {
  verdict = "PASS";
} else if (withEmbed === 0) {
  verdict = "NO_INLINE_EMBEDDINGS";
  note =
    "Zero malformed fact rows. No fact row carries an inline vector — the " +
    "healthy sidecar shape, NOT a defect. Inline absence is not evidence of a " +
    "missing embedding; vectors also live in indices/<model>/vectors.jsonl.";
} else {
  verdict = "PARTIAL_INLINE_COVERAGE";
  note =
    "Zero malformed fact rows. " + withEmbed + " of " + factRows + " fact row(s) " +
    "carry a valid inline vector and " + withoutEmbed + " do not. Absence is not " +
    "corruption — the remaining vectors live in indices/<model>/vectors.jsonl.";
}

const summary = {
  verdict,
  total_rows: totalRows,
  smoke_rows: smokeRows,
  production_rows: productionRows,
  sampled: sampled.length,
  with_embedding: withEmbed,
  without_embedding: withoutEmbed,
  bad_norm: STRICT ? badNorm : null,
  pct_with_embedding: pct === null ? null : pct.toFixed(2) + "%",
  failed_ids_first_10: failedIds,
  strict_mode: STRICT,
  // --- s8 additive fields: the census the verdict is computed from ---
  fact_rows: factRows,
  corrupt_fact_rows: corruptFactRows,
  absent_fact_rows: withoutEmbed,
  fact_bucket_census: sortedObj(factBuckets),
  kind_census: sortedObj(kindCensus),
  unknown_kinds: sortedObj(unknownKindCensus),
  not_applicable: notApplicable,
  census_basis: "full_corpus",
  sample_note:
    "with_embedding / without_embedding / bad_norm are FULL-CORPUS census counts " +
    "over kind:\"fact\" rows. `sampled` and `failed_ids_first_10` are the only " +
    "sample-derived fields and never affect the verdict.",
  note,
};

process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.stderr.write(
  "verify-cascade: " +
    verdict +
    " -- fact_rows=" +
    factRows +
    " valid=" +
    withEmbed +
    " absent=" +
    withoutEmbed +
    " corrupt=" +
    corruptFactRows +
    (pct === null ? "" : " (" + pct.toFixed(1) + "% inline)") +
    "\n"
);
process.exit(verdict === "FAIL" || verdict === "UNKNOWN_ROW_KINDS" ? 1 : 0);
