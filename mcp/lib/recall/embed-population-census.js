// embed-population-census.js — e1 (embed-population hypergraph).
//
// WHAT THIS MEASURES
// ------------------
// One question, answered by THREE INDEPENDENT INSTRUMENTS over a PINNED
// prefix of the append-only ledger, and never by a queue cursor:
//
//   how many distinct ledger row ids carry a vector, by what evidence,
//   and how many are UNMEASURABLE?
//
// The instruments are deliberately not folded into one number:
//
//   INSTRUMENT 1  indices/<model>/hnsw.bin.meta.json  -> id_map membership
//                 (the ids the live vector index can actually return).
//   INSTRUMENT 2  indices/<model>/vectors.jsonl       -> sidecar presence
//                 (a vector was WRITTEN, whether or not it was indexed).
//   INSTRUMENT 2b indices/<model>/embeddings-sidecar.jsonl — a SECOND,
//                 differently-keyed sidecar; censused under its own key and
//                 reported, but deliberately NOT bucket-bearing (see below).
//   INSTRUMENT 3  ledgers/memory.jsonl [0, eof)       -> the row predicate
//                 (inline vector / features.embed_state / neither).
//
// THE DENOMINATOR IS PINNED, NOT STAT-ED
// --------------------------------------
// `ledgers/memory.jsonl` grows under live writers — it grew during the very
// analysis that produced this file (3,379,527,997 B at 16:53 local, then
// 3,379,534,593 B at 16:57; `ls -la ledgers/`, 2026-08-18). Every count here
// is keyed on a NEWLINE-SAFE `eof` captured by `captureCheckpoint`
// (mcp/lib/synthesis/ledger-checkpoint.js), and the stream is
// `readAppended(path, emptyCheckpoint(), pinned, onLine)` — the same
// replay-from-byte-0 form `mcp/scripts/pin-ledger-snapshot.mjs` counts with,
// and the only primitive that respects the pinned boundary. `stat.size` is
// reported as an OBSERVATION, never as a denominator, and the torn final
// line past `eof` is excluded by construction (that hazard is measured in
// pin-ledger-snapshot.mjs's header: `wc -l` 1,516,636 vs `grep -c` 1,516,637).
//
// CARRIED CAVEAT, VERBATIM (readAppended's own contract)
// -----------------------------------------------------
// Blank and over-cap lines are COUNTED but never delivered to `onLine`. So
// `lines_seen` and `rows_classified` are separate figures and their
// difference is reported, never absorbed. When `error === null` the
// accounting identity holds: bytes + skipped_oversized_bytes + skipped_blank
// === eof; this module asserts it and refuses if it fails.
//
// DEDUPE BY ID, LATEST-WRITE-WINS
// -------------------------------
// A fact id may be re-appended; counting occurrences would inflate the
// population. One `Map<string, packedInt>` keyed on `row.id` holds the LAST
// row's classification inputs — the streamLedgerRowsById latest-write-wins
// semantics applied at census scale (E4 2026-09: the helper only implements
// that semantics since its first-seen short-circuit was removed; before E4 it
// returned a re-appended id's FIRST row). Parsed rows are NEVER retained; the
// value is a single SMI packing embed_state (2 bits), inline-vector kind
// (2), created_at-vs-wipe (2), is_seed_row (2), interned `kind` (6) and
// interned TOP-LEVEL `source` (7) = 21 bits.
//
// COST AND PEAK RETENTION — MEASURED, NOT ESTIMATED (2026-08-18, this repo,
// node v24 via `node -e`, commands in each parenthesis; true-as-of only, the
// ledger grows):
//   ledger parse throughput 485.4 MB/s over a 200 MB window at offset
//     2.4e9 (3,754 lines, 412 ms) — a full 3.38 GB pass is seconds, not
//     minutes. (bench: positioned readSync + JSON.parse over [2.4e9, +200MB))
//   vectors.jsonl 12,376,658,893 B / 151,924 lines in 2.24-2.27 s
//     (measured by scanSidecarForIds' own header, same streaming idiom).
//   embeddings-sidecar.jsonl 129,423,401 B / 1,468 lines, keys
//     [memory_id, embedding_4096, embedding_model_version, embedded_at],
//     all 1,468 stamped "qwen3-embedding-8b-fp16" (streamed 2026-08-18).
//   hnsw.bin.meta.json 3,979,012 B: format 2, dims 4096, nextId 127,235,
//     id_map 127,235, tombstones 0, maxElements 1,000,000 (JSON.parse) — of
//     which 8,129 entries are CHUNK ids (`${id}#${k}`) over 3,831 parent
//     facts, i.e. 122,937 distinct BARE ids. Measured 2026-08-18 by parsing
//     the meta and folding with the drain's chunk rule; see
//     readHnswMembership, which takes membership over the BARE set.
//   The live run's peak RSS is REPORTED in the payload (`peak_rss_bytes`,
//   sampled at phase boundaries) — this module's one affordable
//   extravagance, declared rather than discovered.
//
// COMPARE IDENTITY, NOT NAMES
// ---------------------------
//   - every path is reported with dev + ino + size + mtime, not just its
//     spelling;
//   - the two sidecars are distinguished by their KEY: vectors.jsonl is
//     keyed `id` (chunked as `${id}#${k}`), embeddings-sidecar.jsonl is
//     keyed `memory_id`. A scanner probing only `id` would score the second
//     as ZERO — the name-vs-identity trap this module refuses to fall into;
//   - the source axis reads the TOP-LEVEL `source` field. Verified live:
//     `provenance` holds {agent_id, conversation_id, confidence} and NO
//     `source`, so a census keyed on provenance.source reports undefined
//     for every row;
//   - the HNSW instrument is ACCEPTED ONLY when its
//     `embedding_model_version` equals the requested model and `format`
//     is 2. A silently mismatched instrument is the defect class this
//     module exists to close, so that is a REFUSAL, never a degrade.
//
// FAIL IN THE SAFE DIRECTION
// --------------------------
// Presence of a chunk vector proves PRESENCE, not COMPLETENESS: a giant
// with some `${id}#k` vectors is reported in `chunked_parent_ids` /
// `chunk_vectors` so it is visible, never silently promoted to "complete".
// The same rule governs tombstones: a bare id leaves the INDEXED membership
// set only when EVERY one of its raw id_map entries is tombstoned, so a
// tombstoned chunk never demotes a parent that still has a live chunk vector.
// A DRIFTED PINNED PREFIX IS UNMEASURABLE, never a permit: verifyPrefix is
// read on BOTH sides of the counting pass and each reading BRANCHES —
// `census_prefix_drifted` — because readAppended's own caller contract says
// "a delta over a drifted prefix is meaningless". That code is deliberately
// NOT an instrument-invariant code: the CLI routes it to exit 2 (nothing
// could be measured) with a census-free payload, not to exit 3.
// The `${id}#${k}` rule itself has EXACTLY ONE definition reachable from
// here: `stripChunkSuffix`, imported from daemons/reembed-drain.mjs (which
// in turn mirrors reembed-local-4096.mjs's `chunksFor`). Importing that
// module fires no drain — its CLI is behind the INVOKED_DIRECTLY guard,
// as auto-drain.test.mjs's header already establishes.
//
// WHY 2b IS NOT BUCKET-BEARING (stated, and made falsifiable)
// ----------------------------------------------------------
// `embeddings-sidecar.jsonl` is a superseded 2026-06-21 artifact that no
// live reader consumes; its 1,468 rows ARE stamped with the active model,
// so excluding them is a CHOICE, not an oversight. The choice is made
// falsifiable rather than argued: `legacy_sidecar.bucket_impact_if_counted`
// reports, per bucket, exactly how many ids would move if it were counted.
//
// ABSENCE IS NEVER A VERDICT
// --------------------------
// Every unreadable instrument, malformed meta, mismatched model, drifted
// pinned prefix, broken accounting identity or non-partitioning bucket set
// throws `EmbedPopulationCensusError` with a stable `code`. Nothing degrades
// to a zero, no path returns a census that did not measure all three
// bucket-bearing instruments, and NO path publishes a population computed
// over a prefix that is not byte-identical to its pin.
//
// STRICTLY READ-ONLY
// ------------------
// This FILE contains no member of the write family (write / append / mkdir
// / rename / rm / unlink / truncate / createWriteStream / openSync with a
// write flag). It opens files "r" (statSync, readFileSync, createReadStream)
// only. HONEST TRANSITIVE STATEMENT: `daemons/reembed-drain.mjs` DOES
// contain mutators (lock files, cursor writes, log appends) — but the only
// symbols imported here are `stripChunkSuffix` and `sidecarLineId`, two pure
// string/Buffer functions, and no mutator is reachable on this runtime path.
// `mcp/lib/synthesis/ledger-checkpoint.js` is pure-read by its own contract.
// Nothing here imports queryd, the embed server, or hnsw-index.js — that
// last one matters: instantiating its loader would read the 2.1 GB hnsw.bin
// and touch the live index, so the 3.9 MB meta.json is parsed DIRECTLY.
//
// NO CAMPAIGN. This module computes a number. It starts no embedding work,
// enqueues nothing, and proposes nothing.

import { createReadStream, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  captureCheckpoint,
  emptyCheckpoint,
  readAppended,
  serializeCheckpoint,
  verifyPrefix,
} from "../synthesis/ledger-checkpoint.js";
// The chunk-id rule lives in exactly one place, tree-wide.
import { sidecarLineId, stripChunkSuffix } from "../../../daemons/reembed-drain.mjs";

/** Payload schema version. */
export const CENSUS_VERSION = 1;

/**
 * The CLOSED, NAMED bucket enum. Every distinct ledger row id in the pinned
 * prefix lands in EXACTLY ONE of these, and the counts partition the
 * population — asserted in code, re-checkable by hand from the payload.
 */
export const EMBED_POPULATION_BUCKETS = Object.freeze([
  // in the live index's id_map: recall can actually return it
  "P-EMBEDDED-INDEXED",
  // a vector exists in vectors.jsonl but the index does not hold the id
  "P-EMBEDDED-SIDECAR-ONLY",
  // an inline features.embedding_* array on the row, in NEITHER index
  "P-INLINE-ONLY",
  // features.embed_state === true and no vector by any instrument
  "P-NEEDS-EMBED",
  // features.embed_state === false yet no vector anywhere — the flag lies
  "P-EMBED-STATE-FALSE-NO-VECTOR",
  // no `embed_state` KEY at all and no vector: UNMEASURABLE, never "embedded"
  "P-UNMEASURABLE-NO-EMBED-STATE",
]);

/** The one bucket that is a statement of IGNORANCE, not of embedding. */
export const UNMEASURABLE_BUCKET = "P-UNMEASURABLE-NO-EMBED-STATE";

/** Human-readable predicate for each bucket, emitted with the counts. */
export const BUCKET_DEFINITIONS = Object.freeze({
  "P-EMBEDDED-INDEXED": "id present in hnsw.bin.meta.json id_map",
  "P-EMBEDDED-SIDECAR-ONLY":
    "bare id present in vectors.jsonl but ABSENT from the id_map (embedded, unindexed)",
  "P-INLINE-ONLY":
    "row carries a non-empty features.embedding_4096 / _3072 / _mrl_768 array and is in neither index",
  "P-NEEDS-EMBED": "features.embed_state === true and no vector by any instrument",
  "P-EMBED-STATE-FALSE-NO-VECTOR":
    "features.embed_state === false yet no vector by any instrument — the flag lies",
  "P-UNMEASURABLE-NO-EMBED-STATE":
    "no features.embed_state KEY at all and no vector — UNMEASURABLE, never counted as embedded",
});

/**
 * The corpus wipe boundary the operator-facing corpus is dated from. Rows
 * created before it are overwhelmingly the git-log backfill; the axis is
 * emitted so the two populations are never conflated.
 */
export const WIPE_THRESHOLD = "2026-06-03T03:57:00Z";

/** vectors.jsonl is keyed `id`; embeddings-sidecar.jsonl is keyed `memory_id`. */
export const SIDECAR_ID_KEY = "id";
export const LEGACY_SIDECAR_ID_KEY = "memory_id";

export const POPULATION_UNIT = "distinct_ledger_row_ids";

const UNITS_BOUND =
  "population = DISTINCT ids over rows carrying a non-empty string `id` in the PINNED " +
  "prefix [0, eof), latest-write-wins (a re-appended id counts ONCE, in its LAST row's " +
  "bucket). It is NOT a line count and NOT a queue length. kind/source cross-tabs are " +
  "emitted so any narrower population (kind === 'fact', source !== 'git-log', post-wipe) " +
  "is recoverable by subtraction from this payload alone.";

// Bytes of the pinned prefix treated as "the tail" when re-deriving the
// GOAL's 200 MB tail premise. Rows are attributed by their byte offset, so
// this costs NO extra I/O.
export const TAIL_WINDOW_BYTES = 200 * 1024 * 1024;

/** Bounded label cardinality: 6 bits of kind, 7 bits of source. */
const MAX_KIND_LABELS = 64;
const MAX_SOURCE_LABELS = 128;
const MAX_LABEL_BYTES = 64;

const MISSING_LABEL = "<missing>";
const NON_STRING_LABEL = "<non-string>";
const OVERSIZED_LABEL = "<oversized>";
const OTHER_LABEL = "<other>";

// packed-value field codes.
//
// The embed_state and inline-vector code spaces are NOT declared here. They are
// declared ONCE, below, as the exported `EMBED_STATE` / `INLINE_VECTOR` tables
// that this module's own comparisons read. They used to be declared twice — a
// private numeric const per code here, and the public table below built from
// it — so the module published one spelling and compared against the other.
// That is a bypass waiting to drift, not an abbreviation. The remaining private
// codes below have no public counterpart and so are declared here, once.
const CREATED_BEFORE_WIPE = 0;
const CREATED_AT_OR_AFTER_WIPE = 1;
const CREATED_UNPARSEABLE = 2;
const CREATED_LABELS = ["before_wipe_threshold", "at_or_after_wipe_threshold", "unparseable_or_absent"];

const SEED_FALSE = 0;
const SEED_TRUE = 1;
const SEED_NON_BOOLEAN = 2;
const SEED_LABELS = ["false_or_absent", "true", "non_boolean"];

/** How many ids each reconciliation difference lists as evidence. */
const SAMPLE_LIMIT = 5;

// ---------------------------------------------------------------------------
// THE ROW PREDICATE — ONE DEFINITION, TREE-WIDE
//
// `readRowEmbedInputs` is the row-level classification that WAS inlined in
// censusEmbedPopulation's readAppended callback. It is extracted here as a
// pure exported symbol so that the derived work set
// (mcp/lib/recall/embed-work-set.js) asks THE SAME QUESTION of a row that the
// census does, by importing this function rather than re-spelling
// `features.embed_state === true`. A second spelling of that predicate is
// exactly how this program got a queue that disagrees with the ledger; there
// is now one place to change it and one place to be wrong.
//
// PURE: no I/O, no allocation beyond the returned object, no throw. It reports
// the NON-BOOLEAN case as its own code rather than collapsing it into
// true/false — "no embed_state KEY" and "an embed_state that is not a boolean"
// are different statements, and the census REFUSES on the latter.
// ---------------------------------------------------------------------------

/** embed_state codes as returned by `readRowEmbedInputs().embedState`. */
export const EMBED_STATE = Object.freeze({
  ABSENT: 0,
  TRUE: 1,
  FALSE: 2,
  NON_BOOLEAN: 3,
});

/** inline-vector codes as returned by `readRowEmbedInputs().inlineKind`. */
export const INLINE_VECTOR = Object.freeze({
  NONE: 0,
  EMBEDDING_4096: 1,
  EMBEDDING_3072: 2,
  EMBEDDING_MRL_768: 3,
});

/**
 * Human-readable name of an inlineKind code, INDEX-ALIGNED with INLINE_VECTOR:
 * position i is the label for the code whose value is i. This is the ONLY
 * label array for that code space; the census's own cross-tab reads it.
 */
export const INLINE_VECTOR_LABELS = Object.freeze([
  "none",
  "embedding_4096",
  "embedding_3072",
  "embedding_mrl_768",
]);

/**
 * readRowEmbedInputs — the row predicate, in one place.
 *
 * @param {object} row a PARSED ledger row (the caller owns JSON.parse and the
 *   non-object / missing-id rejections; those are population questions, not
 *   embed-state questions).
 * @returns {{embedState: number, inlineKind: number, inlineUnexpectedLength: boolean}}
 *   `embedState` is one of EMBED_STATE.*; `inlineKind` is one of
 *   INLINE_VECTOR.* (first non-empty array wins, in 4096 -> 3072 -> mrl_768
 *   order); `inlineUnexpectedLength` is true when the winning inline array's
 *   length disagrees with its name's dimension.
 */
export function readRowEmbedInputs(row) {
  const f =
    row !== null && typeof row === "object" && !Array.isArray(row) &&
    row.features !== null && typeof row.features === "object" && !Array.isArray(row.features)
      ? row.features
      : null;

  let embedState = EMBED_STATE.ABSENT;
  if (f !== null && Object.prototype.hasOwnProperty.call(f, "embed_state")) {
    if (f.embed_state === true) embedState = EMBED_STATE.TRUE;
    else if (f.embed_state === false) embedState = EMBED_STATE.FALSE;
    else embedState = EMBED_STATE.NON_BOOLEAN;
  }

  let inlineKind = INLINE_VECTOR.NONE;
  let inlineUnexpectedLength = false;
  if (f !== null) {
    if (Array.isArray(f.embedding_4096) && f.embedding_4096.length > 0) {
      inlineKind = INLINE_VECTOR.EMBEDDING_4096;
      inlineUnexpectedLength = f.embedding_4096.length !== 4096;
    } else if (Array.isArray(f.embedding_3072) && f.embedding_3072.length > 0) {
      inlineKind = INLINE_VECTOR.EMBEDDING_3072;
      inlineUnexpectedLength = f.embedding_3072.length !== 3072;
    } else if (Array.isArray(f.embedding_mrl_768) && f.embedding_mrl_768.length > 0) {
      inlineKind = INLINE_VECTOR.EMBEDDING_MRL_768;
      inlineUnexpectedLength = f.embedding_mrl_768.length !== 768;
    }
  }

  return { embedState, inlineKind, inlineUnexpectedLength };
}

/**
 * Named error for every refusal. `code` is stable and is what the CLI maps
 * to an exit code; `details` always carries the numbers a caller needs to
 * self-diagnose without a debugger. Mirrors Bm25CoverageProbeError.
 */
export class EmbedPopulationCensusError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "EmbedPopulationCensusError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Codes that mean "an instrument invariant broke" (a census-grade refusal)
 * as opposed to "nothing could be measured". The CLI maps the first set to
 * exit 3 and everything else to exit 2.
 */
// `census_prefix_drifted` is DELIBERATELY ABSENT from this list. A drifted
// prefix means nothing could be measured (exit 2), not that a measured
// instrument disagreed with itself (exit 3) — absence is never a verdict, and
// a measured-grade refusal would overstate what the run knows.
export const INSTRUMENT_INVARIANT_CODES = Object.freeze([
  "census_hnsw_model_mismatch",
  "census_hnsw_format_unsupported",
  "census_hnsw_id_map_inconsistent",
  "census_ledger_accounting_violation",
  "census_embed_state_non_boolean",
  "census_buckets_do_not_partition",
]);

// ---------------------------------------------------------------------------
// small read-only helpers
// ---------------------------------------------------------------------------

function requirePathArg(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new EmbedPopulationCensusError(
      "census_bad_arguments",
      `censusEmbedPopulation: ${name} must be a non-empty string path (no default exists in this module)`,
      { [name]: value === undefined ? null : String(value) },
    );
  }
  return value;
}

/** statSync throws on ENOENT/EACCES; convert that into a named refusal. */
function statOrThrow(path, code, what) {
  let st;
  try {
    st = statSync(path);
  } catch (e) {
    const errno = e && e.code ? e.code : null;
    throw new EmbedPopulationCensusError(
      code,
      `${what} is unreadable at ${path}` + (errno ? ` (${errno})` : "") +
        `: ${e && e.message ? e.message : String(e)}`,
      { path, errno },
    );
  }
  if (!st.isFile()) {
    throw new EmbedPopulationCensusError(code, `${what} at ${path} is not a regular file`, {
      path,
      errno: null,
    });
  }
  return st;
}

/** Identity by dev+ino, not by path spelling. */
export function fileIdentity(path, st) {
  return {
    path,
    dev: typeof st.dev === "number" ? st.dev : null,
    ino: typeof st.ino === "number" ? st.ino : null,
    size: st.size,
    mtime_ms: typeof st.mtimeMs === "number" ? st.mtimeMs : null,
    identity: `${st.dev}:${st.ino}`,
  };
}

function statIdentityOrNull(path) {
  try {
    return fileIdentity(path, statSync(path));
  } catch {
    return null;
  }
}

function interner(cap) {
  const index = new Map();
  const labels = [];
  let overflowed = false;
  return {
    labels,
    overflowed: () => overflowed,
    idx(rawLabel) {
      const label =
        Buffer.byteLength(rawLabel, "utf8") > MAX_LABEL_BYTES ? OVERSIZED_LABEL : rawLabel;
      const hit = index.get(label);
      if (hit !== undefined) return hit;
      if (labels.length >= cap - 1) {
        overflowed = true;
        let o = index.get(OTHER_LABEL);
        if (o === undefined) {
          o = labels.length;
          labels.push(OTHER_LABEL);
          index.set(OTHER_LABEL, o);
        }
        return o;
      }
      const i = labels.length;
      labels.push(label);
      index.set(label, i);
      return i;
    },
  };
}

function labelOf(row, field) {
  const v = row[field];
  if (typeof v === "string") return v.length === 0 ? MISSING_LABEL : v;
  if (v === undefined || v === null) return MISSING_LABEL;
  return NON_STRING_LABEL;
}

/** Deterministic key order so two runs over the same prefix serialize alike. */
function sortedCounts(counts) {
  const out = Object.create(null);
  for (const k of Object.keys(counts).sort()) out[k] = counts[k];
  return out;
}

function bump(obj, key) {
  obj[key] = (obj[key] === undefined ? 0 : obj[key]) + 1;
}

function emptyBucketMap(make) {
  const out = Object.create(null);
  for (const b of EMBED_POPULATION_BUCKETS) out[b] = make();
  return out;
}

// ---------------------------------------------------------------------------
// INSTRUMENT 1 — HNSW id_map membership (cheap: a 3.9 MB JSON.parse).
//
// hnsw-index.js's loader is deliberately NOT imported: instantiating it reads
// the 2.1 GB hnsw.bin and touches the live index. The meta file is parsed
// directly, and its acceptance conditions are REFUSALS, not degrades.
// ---------------------------------------------------------------------------
export function readHnswMembership({ hnswMetaPath, modelVersion } = {}) {
  requirePathArg(hnswMetaPath, "hnswMetaPath");
  requirePathArg(modelVersion, "modelVersion");
  const st = statOrThrow(hnswMetaPath, "census_hnsw_meta_unreadable", "hnsw meta");

  let meta;
  try {
    meta = JSON.parse(readFileSync(hnswMetaPath, "utf8"));
  } catch (e) {
    throw new EmbedPopulationCensusError(
      "census_hnsw_meta_unreadable",
      `hnsw meta at ${hnswMetaPath} does not parse: ${e && e.message ? e.message : String(e)}`,
      { path: hnswMetaPath },
    );
  }
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    throw new EmbedPopulationCensusError(
      "census_hnsw_meta_unreadable",
      `hnsw meta at ${hnswMetaPath} is not a JSON object`,
      { path: hnswMetaPath },
    );
  }
  if (meta.format !== 2) {
    throw new EmbedPopulationCensusError(
      "census_hnsw_format_unsupported",
      `hnsw meta at ${hnswMetaPath} declares format ${JSON.stringify(meta.format)}; ` +
        `this census reads format 2 only (id_map as [id, label] pairs). REFUSING rather than ` +
        `guessing at an unknown layout.`,
      { path: hnswMetaPath, format: meta.format === undefined ? null : meta.format },
    );
  }
  if (meta.embedding_model_version !== modelVersion) {
    throw new EmbedPopulationCensusError(
      "census_hnsw_model_mismatch",
      `hnsw meta at ${hnswMetaPath} is stamped embedding_model_version=` +
        `${JSON.stringify(meta.embedding_model_version)} but the census was asked for ` +
        `${JSON.stringify(modelVersion)}. A silently mismatched instrument is the defect ` +
        `class this census exists to close — REFUSING.`,
      {
        path: hnswMetaPath,
        meta_model_version:
          meta.embedding_model_version === undefined ? null : meta.embedding_model_version,
        requested_model_version: modelVersion,
      },
    );
  }
  if (!Array.isArray(meta.id_map)) {
    throw new EmbedPopulationCensusError(
      "census_hnsw_meta_unreadable",
      `hnsw meta at ${hnswMetaPath} has no id_map array`,
      { path: hnswMetaPath },
    );
  }
  const tombstones = Array.isArray(meta.tombstones) ? meta.tombstones : [];
  const nextId = Number.isInteger(meta.nextId) ? meta.nextId : null;

  // THE INVARIANT IS DERIVED FROM THE WRITER, not from arithmetic that merely
  // looks plausible. In mcp/lib/recall/hnsw-index.js:
  //   HnswIndex.add()    allocates `const id = this._nextId++` EXACTLY ONCE per
  //                      newly-mapped memory_id and then sets _idForMemoryId;
  //                      re-adding a TOMBSTONED id resurrects it (deletes the
  //                      tombstone) and allocates NOTHING.
  //   HnswIndex.remove() only does `this._tombstones.add(memory_id)`, and
  //                      early-returns when !_idForMemoryId.has(memory_id). It
  //                      NEVER deletes from _idForMemoryId.
  //   HnswIndex.save()   persists `id_map: Array.from(this._idForMemoryId.entries())`
  //                      ALONGSIDE `tombstones: Array.from(this._tombstones)`.
  // So the two things the writer actually guarantees are
  //   (1) id_map.length === nextId        — one map entry per allocated id;
  //   (2) tombstones is a SUBSET of the id_map KEYS — remove() cannot tombstone
  //       an id it never mapped.
  // The identity this module checked before — id_map.length === nextId minus
  // tombstones.length — was FALSE about that writer: a tombstone removes
  // nothing from id_map, so ANY saved index that had ever seen a remove() was
  // refused as "inconsistent". Only these two genuine self-disagreements refuse.
  if (nextId === null || meta.id_map.length !== nextId) {
    throw new EmbedPopulationCensusError(
      "census_hnsw_id_map_inconsistent",
      `hnsw meta at ${hnswMetaPath}: id_map length ${meta.id_map.length} !== nextId ` +
        `${String(nextId)}. HnswIndex.add() (mcp/lib/recall/hnsw-index.js) allocates ` +
        `\`const id = this._nextId++\` exactly once per newly-mapped memory_id and ` +
        `HnswIndex.save() persists \`id_map: Array.from(this._idForMemoryId.entries())\`, so a ` +
        `writer-produced meta always has one id_map entry per allocated id. The instrument ` +
        `disagrees with itself; a membership set taken from it would be unfalsifiable.`,
      {
        path: hnswMetaPath,
        id_map_entries: meta.id_map.length,
        next_id: nextId,
        tombstones: tombstones.length,
        invariant: "id_map.length === nextId (HnswIndex.add/save)",
      },
    );
  }

  // MEASURED DISCOVERY (2026-08-18, `node -e` over the live meta, recorded here
  // because it falsifies the obvious reading of this file): THE id_map KEYS
  // CHUNKED FACTS BY THEIR CHUNK ID. 8,129 of the 127,235 entries are spelled
  // `${id}#${k}` across 3,831 parent facts, leaving 122,937 DISTINCT BARE ids.
  // Membership is therefore compared on BARE ids, by the SAME imported chunk
  // rule the sidecar scanner uses — comparing raw id_map spellings against
  // ledger row ids would have scored every chunked giant as unindexed and
  // reported 8,129 "id_map ids with no ledger row" that are simply chunks of
  // rows that are right there. Both figures are published: raw entries AND the
  // bare set that membership is actually taken over.
  const ids = new Set();
  const rawIds = new Set();
  const chunkedParents = new Set();
  // e2: ids whose id_map entry is spelled EXACTLY bare — never reached only
  // via a `${id}#k` entry. See the `bareEntryIds` note on the return value.
  const bareSpelledEntries = new Set();
  let nonStringEntries = 0;
  let chunkEntries = 0;
  for (const entry of meta.id_map) {
    const id = Array.isArray(entry) ? entry[0] : entry;
    if (typeof id !== "string" || id.length === 0) {
      nonStringEntries += 1;
      continue;
    }
    rawIds.add(id);
    const bare = stripChunkSuffix(id);
    if (bare !== id) {
      chunkEntries += 1;
      chunkedParents.add(bare);
    } else {
      bareSpelledEntries.add(id);
    }
    ids.add(bare);
  }
  // (2) tombstones ⊆ keys(id_map). HnswIndex.remove() early-returns unless
  // `this._idForMemoryId.has(memory_id)`, so a tombstone naming an id the map
  // never held cannot have come from that writer — that is the GENUINE
  // self-disagreement case, and it is still a refusal, never a shrug.
  const tombstonesNotInIdMap = [];
  const tombstonedRaw = new Set();
  for (const t of tombstones) {
    if (typeof t === "string" && t.length > 0 && rawIds.has(t)) {
      tombstonedRaw.add(t);
      continue;
    }
    if (tombstonesNotInIdMap.length < SAMPLE_LIMIT) {
      tombstonesNotInIdMap.push(typeof t === "string" ? t : String(t));
    }
  }
  if (tombstonesNotInIdMap.length > 0) {
    throw new EmbedPopulationCensusError(
      "census_hnsw_id_map_inconsistent",
      `hnsw meta at ${hnswMetaPath}: ${tombstonesNotInIdMap.length}+ tombstone(s) (e.g. ` +
        `${JSON.stringify(tombstonesNotInIdMap)}) are NOT keys of id_map. ` +
        `HnswIndex.remove() (mcp/lib/recall/hnsw-index.js) returns early unless ` +
        `\`this._idForMemoryId.has(memory_id)\` and only ever does ` +
        `\`this._tombstones.add(memory_id)\`, so every tombstone a writer emits is an id_map ` +
        `key. The instrument disagrees with itself; a membership set taken from it would be ` +
        `unfalsifiable.`,
      {
        path: hnswMetaPath,
        id_map_entries: meta.id_map.length,
        next_id: nextId,
        tombstones: tombstones.length,
        tombstones_not_in_id_map_sample: tombstonesNotInIdMap,
        invariant: "tombstones ⊆ keys(id_map) (HnswIndex.remove/save)",
      },
    );
  }

  // LIVE MEMBERSHIP BY SET DIFFERENCE, mirroring the writer's own liveness
  // symbols: HnswIndex.size() is `_idForMemoryId.size - _tombstones.size` and
  // HnswIndex.has() is `_idForMemoryId.has(id) && !_tombstones.has(id)`. A bare
  // id leaves the INDEXED set only when EVERY one of its raw id_map entries is
  // tombstoned — a chunked parent with one live `#k` entry is still returnable,
  // so it stays INDEXED. Presence proves PRESENCE, never COMPLETENESS.
  const rawEntriesPerBare = new Map();
  for (const raw of rawIds) {
    const bare = stripChunkSuffix(raw);
    rawEntriesPerBare.set(bare, (rawEntriesPerBare.get(bare) === undefined ? 0 : rawEntriesPerBare.get(bare)) + 1);
  }
  const tombstonedPerBare = new Map();
  const tombstoned = new Set();
  for (const t of tombstonedRaw) {
    const bare = stripChunkSuffix(t);
    tombstoned.add(bare);
    tombstonedPerBare.set(bare, (tombstonedPerBare.get(bare) === undefined ? 0 : tombstonedPerBare.get(bare)) + 1);
  }
  const fullyTombstoned = new Set();
  const partiallyTombstoned = new Set();
  for (const [bare, dead] of tombstonedPerBare) {
    if (rawEntriesPerBare.get(bare) === dead) fullyTombstoned.add(bare);
    else partiallyTombstoned.add(bare);
  }
  const indexed = new Set();
  for (const bare of ids) if (!fullyTombstoned.has(bare)) indexed.add(bare);

  // e2 — THE COMPLETENESS-SAFE MEMBERSHIP SET (additive; `ids` / `bareIds` /
  // `tombstoned` and every pre-existing instrument field keep their meaning).
  //
  // `bareEntryIds` holds the ids that the id_map maps under their EXACT BARE
  // SPELLING, minus any whose bare entry is itself tombstoned. It exists
  // because PRESENCE IS NOT COMPLETENESS and the two sets answer different
  // questions:
  //   `ids` (indexed membership) answers "can recall return anything for this
  //          fact?" — a chunked giant with ONE live `#k` entry qualifies;
  //   `bareEntryIds` answers "was this fact embedded as ONE COMPLETE vector?"
  //          — chunked facts write ONLY `${factId}#k` lines
  //          (mcp/scripts/reembed-local-4096.mjs), so a BARE entry can only
  //          have come from a single-vector embed, while a chunked parent is
  //          absent from this set and therefore stays a CANDIDATE.
  // It is the ONLY membership set mcp/lib/recall/embed-work-set.js is allowed
  // to exclude on. Excluding chunked parents on `ids` would be the drain's own
  // presence-vs-completeness defect (the r6-2 trap, see the FULL-SCAN ROUTE
  // comment in daemons/reembed-drain.mjs) wearing a new hat.
  // MEASURED PREMISE (2026-08-18, live meta, this node): id_map 127,235 raw
  // entries -> 122,937 distinct bare ids, of which 8,129 entries are chunk ids
  // over 3,831 parents; tombstones 0, so bareEntryIds is 119,106 today
  // (122,937 - 3,831 chunk-only parents) and the tombstone subtraction below is
  // currently a no-op. RESIDUAL: a bare entry proves a vector was INDEXED under
  // that id; it does not re-verify the vector's dimensionality or the model it
  // came from — the meta's `embedding_model_version` gate above is what carries
  // that, and it is a REFUSAL, not a degrade.
  const bareEntryIds = new Set();
  let bareEntriesTombstoned = 0;
  for (const id of bareSpelledEntries) {
    if (tombstonedRaw.has(id)) {
      bareEntriesTombstoned += 1;
      continue;
    }
    bareEntryIds.add(id);
  }

  return {
    ids: indexed,
    bareIds: ids,
    bareEntryIds,
    tombstoned,
    instrument: {
      instrument: "hnsw_id_map",
      path: hnswMetaPath,
      file: fileIdentity(hnswMetaPath, st),
      embedding_model_version: meta.embedding_model_version,
      format: meta.format,
      backend: typeof meta.backend === "string" ? meta.backend : null,
      dims: Number.isInteger(meta.dims) ? meta.dims : null,
      id_map_entries: meta.id_map.length,
      id_map_distinct_raw_ids: rawIds.size,
      id_map_distinct_bare_ids: ids.size,
      id_map_chunk_entries: chunkEntries,
      id_map_chunked_parent_ids: chunkedParents.size,
      id_map_duplicate_raw_entries: meta.id_map.length - rawIds.size - nonStringEntries,
      id_map_non_string_entries: nonStringEntries,
      id_map_bare_ids_fully_tombstoned: fullyTombstoned.size,
      id_map_bare_ids_partially_tombstoned: partiallyTombstoned.size,
      indexed_membership_bare_ids: indexed.size,
      // e2, additive: the COMPLETENESS-SAFE set — ids mapped under their exact
      // bare spelling and not tombstoned there. Always <= id_map_distinct_bare_ids;
      // the difference is exactly the chunk-only parents.
      id_map_bare_entry_ids: bareEntryIds.size,
      id_map_bare_entry_ids_tombstoned: bareEntriesTombstoned,
      bare_entry_unit:
        "ids present in id_map under their EXACT BARE spelling (NOT reached only via " +
        "`${id}#k`), minus those whose bare entry is tombstoned. A bare entry means a COMPLETE " +
        "single-vector embed (chunked facts write only `${factId}#k`), so a chunked parent is " +
        "deliberately ABSENT here and stays a candidate for re-embedding. This is the set " +
        "mcp/lib/recall/embed-work-set.js excludes on; indexed_membership_bare_ids is NOT.",
      membership_unit:
        "BARE ids (stripChunkSuffix applied — the id_map keys chunked facts by chunk id) MINUS " +
        "the bare ids whose EVERY raw id_map entry is tombstoned. This mirrors HnswIndex.size() " +
        "(`_idForMemoryId.size - _tombstones.size`) and HnswIndex.has() (`_idForMemoryId.has(id) " +
        "&& !_tombstones.has(id)`) in mcp/lib/recall/hnsw-index.js. id_map_distinct_bare_ids is " +
        "the bare set BEFORE that difference; indexed_membership_bare_ids is the set membership " +
        "is actually taken over.",
      tombstones: tombstones.length,
      tombstones_distinct: tombstoned.size,
      next_id: nextId,
      max_elements: Number.isInteger(meta.maxElements) ? meta.maxElements : null,
      id_map_identity_checked:
        "id_map.length === nextId AND tombstones ⊆ keys(id_map) — derived from the WRITING " +
        "symbols in mcp/lib/recall/hnsw-index.js (GOAL invariant #4: never write an unverified " +
        "claim into a comment). HnswIndex.add() allocates `this._nextId++` exactly once per " +
        "newly-mapped memory_id; HnswIndex.remove() only adds to `_tombstones` and never deletes " +
        "from `_idForMemoryId`; HnswIndex.save() persists both side by side.",
    },
  };
}

// ---------------------------------------------------------------------------
// INSTRUMENT 2 / 2b — sidecar ENUMERATION.
//
// `streamSidecarIdMatches` in the drain is match-set-and-earlyExit shaped and
// CANNOT enumerate, so this is a small enumerating scanner in the same proven
// idiom: incremental newline split, one chunk plus one partial line resident,
// and a FINAL LINE WITH NO "\n" deliberately not counted (a write in flight).
// The bare id comes from the drain's own `sidecarLineId` for the `id` key, so
// the `${id}#${k}` rule has exactly one definition; chunkedness is decided by
// `stripChunkSuffix(raw) !== raw` on the raw head id, using that SAME imported
// rule.
// ---------------------------------------------------------------------------

const ID_HEAD_BYTES = 256;

/** Raw (UNSTRIPPED) id under `key`, or null. Fast head path, parse fallback. */
function rawSidecarLineId(lineBuf, key) {
  if (lineBuf.length === 0) return null;
  const head = lineBuf.subarray(0, Math.min(lineBuf.length, ID_HEAD_BYTES)).toString("utf8");
  const prefix = `{"${key}":"`;
  if (head.startsWith(prefix)) {
    const from = prefix.length;
    const close = head.indexOf('"', from);
    if (close > from && !head.slice(from, close).includes("\\")) return head.slice(from, close);
  }
  try {
    const o = JSON.parse(lineBuf.toString("utf8"));
    if (o !== null && typeof o === "object" && typeof o[key] === "string" && o[key].length > 0) {
      return o[key];
    }
  } catch {
    /* not a sidecar line */
  }
  return null;
}

/**
 * Enumerate DISTINCT bare ids in a sidecar. Read-only; peak retention is one
 * chunk + one partial line + the id set.
 *
 * @returns {{ids:Set<string>, chunkedParents:Set<string>, instrument:object}}
 */
export async function scanSidecarPopulation({ sidecarPath, key = SIDECAR_ID_KEY, errorCode = "census_sidecar_unreadable" } = {}) {
  requirePathArg(sidecarPath, "sidecarPath");
  const st = statOrThrow(sidecarPath, errorCode, `sidecar (key=${key})`);

  const ids = new Set();
  const chunkedParents = new Set();
  let rawLines = 0;
  let idLines = 0;
  let chunkVectors = 0;
  let unparseableLines = 0;
  let tailBytes = 0;

  const stream = createReadStream(sidecarPath);
  let remainder = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      remainder = remainder.length === 0 ? chunk : Buffer.concat([remainder, chunk]);
      let nl;
      while ((nl = remainder.indexOf(0x0a)) !== -1) {
        const lineBuf = remainder.subarray(0, nl);
        remainder = remainder.subarray(nl + 1);
        rawLines += 1;
        const raw = rawSidecarLineId(lineBuf, key);
        if (raw === null) {
          unparseableLines += 1;
          continue;
        }
        // ONE chunk rule, imported. Never re-implemented here.
        const bare = key === SIDECAR_ID_KEY ? sidecarLineId(lineBuf) : stripChunkSuffix(raw);
        if (bare === null) {
          unparseableLines += 1;
          continue;
        }
        idLines += 1;
        if (stripChunkSuffix(raw) !== raw) {
          chunkVectors += 1;
          chunkedParents.add(bare);
        }
        ids.add(bare);
      }
    }
  } catch (e) {
    throw new EmbedPopulationCensusError(
      errorCode,
      `sidecar at ${sidecarPath} failed mid-stream: ${e && e.message ? e.message : String(e)}`,
      { path: sidecarPath, key },
    );
  }
  tailBytes = remainder.length;

  return {
    ids,
    chunkedParents,
    instrument: {
      instrument: key === SIDECAR_ID_KEY ? "vectors_sidecar" : `sidecar_key_${key}`,
      path: sidecarPath,
      id_key: key,
      file: fileIdentity(sidecarPath, st),
      raw_lines: rawLines,
      id_bearing_lines: idLines,
      unparseable_lines: unparseableLines,
      distinct_bare_ids: ids.size,
      chunked_parent_ids: chunkedParents.size,
      chunk_vectors: chunkVectors,
      unterminated_tail_bytes: tailBytes,
      presence_bound:
        "a chunk vector proves PRESENCE, not COMPLETENESS: chunked_parent_ids are reported " +
        "separately and are never promoted to 'fully embedded'.",
    },
  };
}

// ---------------------------------------------------------------------------
// queue_visibility — a QUEUE figure, and labelled as one everywhere.
// ---------------------------------------------------------------------------
async function readSweepIds(sweepPath) {
  if (sweepPath === null || sweepPath === undefined) {
    return { ids: new Set(), rawLines: 0, error: "not supplied", file: null };
  }
  let st;
  try {
    st = statSync(sweepPath);
  } catch (e) {
    return { ids: new Set(), rawLines: 0, error: e && e.code ? e.code : String(e), file: null };
  }
  const ids = new Set();
  let rawLines = 0;
  try {
    const stream = createReadStream(sweepPath);
    let remainder = Buffer.alloc(0);
    for await (const chunk of stream) {
      remainder = remainder.length === 0 ? chunk : Buffer.concat([remainder, chunk]);
      let nl;
      while ((nl = remainder.indexOf(0x0a)) !== -1) {
        const lineBuf = remainder.subarray(0, nl);
        remainder = remainder.subarray(nl + 1);
        rawLines += 1;
        const raw = rawSidecarLineId(lineBuf, "fact_id");
        if (raw !== null) ids.add(stripChunkSuffix(raw));
      }
    }
  } catch (e) {
    return { ids, rawLines, error: e && e.message ? e.message : String(e), file: fileIdentity(sweepPath, st) };
  }
  return { ids, rawLines, error: null, file: fileIdentity(sweepPath, st) };
}

// ---------------------------------------------------------------------------
// THE CENSUS
// ---------------------------------------------------------------------------

/**
 * censusEmbedPopulation — count the embed population over a PINNED ledger
 * prefix, by three independent instruments. Strictly read-only.
 *
 * Every path is injectable and NONE has a default here: defaults belong to
 * the CLI (mcp/scripts/verify-embed-population-census.mjs), so a test can
 * drive this over mkdtemp fixtures without ever naming a production path.
 *
 * @param {object} opts
 * @param {string} opts.ledgerPath        REQUIRED.
 * @param {string} opts.hnswMetaPath      REQUIRED (instrument 1).
 * @param {string} opts.sidecarPath       REQUIRED (instrument 2).
 * @param {string} opts.modelVersion      REQUIRED; the HNSW meta must match it.
 * @param {string|null} [opts.legacySidecarPath]  instrument 2b; when the path
 *        is supplied AND readable it is censused, when supplied and unreadable
 *        the census REFUSES, when null it is reported as not supplied.
 * @param {boolean} [opts.legacySidecarOptional=false]  a MISSING default-path
 *        legacy sidecar is reported as absent rather than refused (it is not
 *        bucket-bearing, so its absence moves no count).
 * @param {object|null} [opts.checkpoint]  a pre-pinned checkpoint; captured here when null.
 * @param {string|null} [opts.sweepPath]   read-only, QUEUE figures only.
 * @param {boolean} [opts.verifyDigest=false]  full sha256 over [0, eof) — one
 *        EXTRA full read of the prefix; the method is named in the payload.
 * @param {string} [opts.wipeThreshold=WIPE_THRESHOLD]
 * @param {number} [opts.maxLineBytes]     forwarded to readAppended.
 * @returns {Promise<object>} the census payload.
 * @throws {EmbedPopulationCensusError}
 */
export async function censusEmbedPopulation(opts = {}) {
  const t0 = Date.now();
  const o = opts === null || opts === undefined ? {} : opts;
  const ledgerPath = requirePathArg(o.ledgerPath, "ledgerPath");
  const hnswMetaPath = requirePathArg(o.hnswMetaPath, "hnswMetaPath");
  const sidecarPath = requirePathArg(o.sidecarPath, "sidecarPath");
  const modelVersion = requirePathArg(o.modelVersion, "modelVersion");
  const legacySidecarPath =
    typeof o.legacySidecarPath === "string" && o.legacySidecarPath.length > 0
      ? o.legacySidecarPath
      : null;
  const legacySidecarOptional = o.legacySidecarOptional === true;
  const sweepPath = typeof o.sweepPath === "string" && o.sweepPath.length > 0 ? o.sweepPath : null;
  const verifyDigest = o.verifyDigest === true;
  const wipeThreshold =
    typeof o.wipeThreshold === "string" && o.wipeThreshold.length > 0
      ? o.wipeThreshold
      : WIPE_THRESHOLD;
  const wipeMs = Date.parse(wipeThreshold);
  if (!Number.isFinite(wipeMs)) {
    throw new EmbedPopulationCensusError(
      "census_bad_arguments",
      `wipeThreshold ${JSON.stringify(wipeThreshold)} is not a parseable ISO timestamp`,
      { wipeThreshold },
    );
  }

  let peakRss = process.memoryUsage().rss;
  const rssSamples = Object.create(null);
  const sampleRss = (phase) => {
    const rss = process.memoryUsage().rss;
    rssSamples[phase] = rss;
    if (rss > peakRss) peakRss = rss;
    return rss;
  };

  // --- PIN THE DENOMINATOR FIRST -----------------------------------------
  const ledgerStatBefore = statOrThrow(ledgerPath, "census_ledger_unreadable", "ledger");
  let checkpoint = o.checkpoint === undefined ? null : o.checkpoint;
  let pinSource = "supplied";
  if (checkpoint === null) {
    checkpoint = captureCheckpoint(ledgerPath);
    pinSource = "captured_by_census";
  }
  if (checkpoint === null || !Number.isInteger(checkpoint.eof)) {
    throw new EmbedPopulationCensusError(
      "census_checkpoint_failed",
      `captureCheckpoint returned no usable checkpoint for ${ledgerPath} — the pinned ` +
        `denominator could not be established, so nothing is counted`,
      { ledgerPath },
    );
  }
  const eof = checkpoint.eof;

  // --- GATE THE PREFIX BEFORE ANYTHING IS COUNTED -------------------------
  // readAppended's own caller contract says it, verbatim (JSDoc NOTE on
  // `readAppended` in mcp/lib/synthesis/ledger-checkpoint.js): "readAppended
  // does NOT itself re-verify the prefix. Callers compose
  // `verifyPrefix(path, fromCheckpoint)` first and full-rebuild on failure — a
  // delta over a drifted prefix is meaningless." This census IS a delta over
  // [0, eof), so a drifted prefix makes every figure below meaningless: it is
  // UNMEASURABLE, and publishing it with a `prefix_verified: false` flag
  // attached would be exactly the "absence is a verdict" error. Refusing HERE
  // rather than after the pass also declines to stream 3.4 GB over a prefix
  // already known to be meaningless; the gate itself costs only the sampled
  // witness re-read (<= 128 x 64 KiB), never a second full pass.
  const pvPre = verifyPrefix(ledgerPath, checkpoint);
  if (!pvPre.ok) {
    throw new EmbedPopulationCensusError(
      "census_prefix_drifted",
      `the pinned prefix of ${ledgerPath} [0, ${eof}) is NOT byte-identical to the pin ` +
        `(verifyPrefix reason ${JSON.stringify(pvPre.reason)}, pin_source ${pinSource}, phase ` +
        `pre_pass). readAppended's caller contract in mcp/lib/synthesis/ledger-checkpoint.js ` +
        `states it: "Callers compose verifyPrefix(path, fromCheckpoint) first and full-rebuild ` +
        `on failure — a delta over a drifted prefix is meaningless." NOTHING is counted: this ` +
        `is UNMEASURABLE, never a permit.`,
      { ledgerPath, eof, reason: pvPre.reason, pin_source: pinSource, phase: "pre_pass" },
    );
  }

  // --- INSTRUMENT 1 -------------------------------------------------------
  const hnsw = readHnswMembership({ hnswMetaPath, modelVersion });
  sampleRss("after_hnsw");

  // --- INSTRUMENT 2 -------------------------------------------------------
  const sidecar = await scanSidecarPopulation({ sidecarPath, key: SIDECAR_ID_KEY });
  sampleRss("after_sidecar");

  // --- INSTRUMENT 2b (never bucket-bearing) -------------------------------
  let legacy = null;
  let legacyInstrument = {
    instrument: "legacy_embeddings_sidecar",
    id_key: LEGACY_SIDECAR_ID_KEY,
    path: legacySidecarPath,
    measured: false,
    status: legacySidecarPath === null ? "not_supplied" : "unmeasured",
    excluded_from_buckets: true,
    excluded_reason:
      "keyed `memory_id` (NOT `id`) and superseded: no live reader consumes it. Presence there " +
      "is reported and its bucket impact is quantified (bucket_impact_if_counted), but it never " +
      "promotes a row to an embedded bucket — presence proves a vector EXISTED, not that the " +
      "active index or vectors.jsonl holds one.",
  };
  if (legacySidecarPath !== null) {
    try {
      legacy = await scanSidecarPopulation({
        sidecarPath: legacySidecarPath,
        key: LEGACY_SIDECAR_ID_KEY,
        errorCode: "census_legacy_sidecar_unreadable",
      });
      legacyInstrument = {
        ...legacy.instrument,
        measured: true,
        status: "measured",
        excluded_from_buckets: true,
        excluded_reason: legacyInstrument.excluded_reason,
      };
    } catch (e) {
      if (!legacySidecarOptional) throw e;
      legacy = null;
      legacyInstrument = {
        ...legacyInstrument,
        measured: false,
        status: "absent_at_default_path",
        error_code: e && e.code ? e.code : null,
        error: e && e.message ? e.message : String(e),
        absence_note:
          "NOT bucket-bearing, so its absence moves no count; it is reported as unmeasured, " +
          "never as zero. Passing this path explicitly makes an unreadable file a REFUSAL.",
      };
    }
  }
  sampleRss("after_legacy_sidecar");

  // --- queue file, read BEFORE classification so the intersection is free --
  const sweep = await readSweepIds(sweepPath);

  // --- INSTRUMENT 3: one bounded pass over [0, eof) -----------------------
  const byId = new Map(); // id -> packed SMI (latest write wins)
  const kinds = interner(MAX_KIND_LABELS);
  const sources = interner(MAX_SOURCE_LABELS);

  let unparseableRows = 0;
  let nonObjectRows = 0;
  let rowsWithoutId = 0;
  let idBearingRows = 0;
  let inlineUnexpectedLength = 0;
  let embedStateNonBoolean = 0;
  const embedStateNonBooleanSamples = [];

  // GOAL premise (a): re-derived over the last TAIL_WINDOW_BYTES of the
  // PINNED prefix, attributed by byte offset — no extra I/O.
  const tailStart = Math.max(0, eof - TAIL_WINDOW_BYTES);
  let tailIdRows = 0;
  let tailEmbedStateTrue = 0;
  let tailEmbedStateFalse = 0;
  let tailEmbedStateAbsent = 0;
  let tailInlineVector = 0;

  const stats = readAppended(
    ledgerPath,
    emptyCheckpoint(),
    checkpoint,
    (text, byteOffset) => {
      let row;
      try {
        row = JSON.parse(text);
      } catch {
        unparseableRows += 1;
        return;
      }
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        nonObjectRows += 1;
        return;
      }
      if (typeof row.id !== "string" || row.id.length === 0) {
        rowsWithoutId += 1;
        return;
      }
      idBearingRows += 1;

      // THE ROW PREDICATE, from the one symbol that defines it. The census's
      // COUNTERS stay here (they are census bookkeeping, not predicate); the
      // classification itself is `readRowEmbedInputs` — the same function
      // mcp/lib/recall/embed-work-set.js imports, so the derived work set and
      // this census can never disagree about what an unembedded row is.
      const inputs = readRowEmbedInputs(row);
      const es = inputs.embedState;
      const inline = inputs.inlineKind;
      if (es === EMBED_STATE.NON_BOOLEAN) {
        embedStateNonBoolean += 1;
        if (embedStateNonBooleanSamples.length < SAMPLE_LIMIT) {
          embedStateNonBooleanSamples.push({
            id: row.id,
            embed_state: String(row.features.embed_state),
          });
        }
      }
      if (inputs.inlineUnexpectedLength) inlineUnexpectedLength += 1;

      const createdMs = typeof row.created_at === "string" ? Date.parse(row.created_at) : NaN;
      const created = !Number.isFinite(createdMs)
        ? CREATED_UNPARSEABLE
        : createdMs < wipeMs
          ? CREATED_BEFORE_WIPE
          : CREATED_AT_OR_AFTER_WIPE;

      const prov =
        row.provenance !== null && typeof row.provenance === "object" && !Array.isArray(row.provenance)
          ? row.provenance
          : null;
      let seed = SEED_FALSE;
      if (prov !== null && Object.prototype.hasOwnProperty.call(prov, "is_seed_row")) {
        if (prov.is_seed_row === true) seed = SEED_TRUE;
        else if (prov.is_seed_row === false) seed = SEED_FALSE;
        else seed = SEED_NON_BOOLEAN;
      }

      const kindIdx = kinds.idx(labelOf(row, "kind"));
      // TOP-LEVEL `source`. provenance.source does not exist on these rows.
      const sourceIdx = sources.idx(labelOf(row, "source"));

      byId.set(
        row.id,
        es | (inline << 2) | (created << 4) | (seed << 6) | (kindIdx << 8) | (sourceIdx << 14),
      );

      if (byteOffset >= tailStart) {
        tailIdRows += 1;
        if (es === EMBED_STATE.TRUE) tailEmbedStateTrue += 1;
        else if (es === EMBED_STATE.FALSE) tailEmbedStateFalse += 1;
        else if (es === EMBED_STATE.ABSENT) tailEmbedStateAbsent += 1;
        if (inline !== INLINE_VECTOR.NONE) tailInlineVector += 1;
      }
    },
    o.maxLineBytes === undefined ? {} : { maxLineBytes: o.maxLineBytes },
  );
  sampleRss("after_ledger_pass");

  if (stats.error !== null) {
    throw new EmbedPopulationCensusError(
      "census_ledger_read_error",
      `readAppended over ${ledgerPath} [0, ${eof}) failed: ${stats.error}. Counters reflect ` +
        `progress only; NOTHING is certified from a failed delta.`,
      { ledgerPath, eof, readAppendedError: stats.error, stats },
    );
  }
  const identityLhs = stats.bytes + stats.skipped_oversized_bytes + stats.skipped_blank;
  if (identityLhs !== eof) {
    throw new EmbedPopulationCensusError(
      "census_ledger_accounting_violation",
      `readAppended accounting identity broke over ${ledgerPath}: bytes ${stats.bytes} + ` +
        `skipped_oversized_bytes ${stats.skipped_oversized_bytes} + skipped_blank ` +
        `${stats.skipped_blank} = ${identityLhs} !== eof ${eof}`,
      { ledgerPath, eof, stats },
    );
  }
  if (embedStateNonBoolean > 0) {
    throw new EmbedPopulationCensusError(
      "census_embed_state_non_boolean",
      `${embedStateNonBoolean} row(s) carry a NON-BOOLEAN features.embed_state (e.g. ` +
        `${JSON.stringify(embedStateNonBooleanSamples)}). CAPS.EMBED_STATE_VALUES documents the ` +
        `on-disk shape as a BOOLEAN (true<->pending, false<->ready, absent<->pre-W2 legacy); the ` +
        `closed bucket enum has no honest slot for a third shape, and "no embed_state KEY" is a ` +
        `different statement from "an embed_state whose value is not a boolean". REFUSING.`,
      { count: embedStateNonBoolean, samples: embedStateNonBooleanSamples },
    );
  }

  // --- CLASSIFY into the closed enum + cross-tab in one sweep -------------
  const bucketCounts = Object.create(null);
  for (const b of EMBED_POPULATION_BUCKETS) bucketCounts[b] = 0;
  const byKind = emptyBucketMap(() => Object.create(null));
  const bySource = emptyBucketMap(() => Object.create(null));
  const byCreated = emptyBucketMap(() => Object.create(null));
  const bySeed = emptyBucketMap(() => Object.create(null));
  const byInline = emptyBucketMap(() => Object.create(null));
  const popByKind = Object.create(null);
  const popBySource = Object.create(null);
  const popByCreated = Object.create(null);
  const popBySeed = Object.create(null);

  let needsEmbedInSweep = 0;
  let needsEmbedNotInSweep = 0;
  let legacyOnlyWithLedgerRow = 0;
  const legacyBucketImpact = Object.create(null);
  for (const b of EMBED_POPULATION_BUCKETS) legacyBucketImpact[b] = 0;

  const idMapIdsSeenOnLedger = new Set();
  const sidecarIdsSeenOnLedger = new Set();

  for (const [id, code] of byId) {
    const es = code & 3;
    const inline = (code >> 2) & 3;
    const created = (code >> 4) & 3;
    const seed = (code >> 6) & 3;
    const kindLabel = kinds.labels[(code >> 8) & 63];
    const sourceLabel = sources.labels[(code >> 14) & 127];

    const inHnsw = hnsw.ids.has(id);
    const inSidecar = sidecar.ids.has(id);
    if (inHnsw) idMapIdsSeenOnLedger.add(id);
    if (inSidecar) sidecarIdsSeenOnLedger.add(id);

    let bucket;
    if (inHnsw) bucket = "P-EMBEDDED-INDEXED";
    else if (inSidecar) bucket = "P-EMBEDDED-SIDECAR-ONLY";
    else if (inline !== INLINE_VECTOR.NONE) bucket = "P-INLINE-ONLY";
    else if (es === EMBED_STATE.TRUE) bucket = "P-NEEDS-EMBED";
    else if (es === EMBED_STATE.FALSE) bucket = "P-EMBED-STATE-FALSE-NO-VECTOR";
    else bucket = UNMEASURABLE_BUCKET;

    bucketCounts[bucket] += 1;
    bump(byKind[bucket], kindLabel);
    bump(bySource[bucket], sourceLabel);
    bump(byCreated[bucket], CREATED_LABELS[created]);
    bump(bySeed[bucket], SEED_LABELS[seed]);
    bump(byInline[bucket], INLINE_VECTOR_LABELS[inline]);
    bump(popByKind, kindLabel);
    bump(popBySource, sourceLabel);
    bump(popByCreated, CREATED_LABELS[created]);
    bump(popBySeed, SEED_LABELS[seed]);

    if (bucket === "P-NEEDS-EMBED") {
      if (sweep.ids.has(id)) needsEmbedInSweep += 1;
      else needsEmbedNotInSweep += 1;
    }
    if (legacy !== null && legacy.ids.has(id)) {
      legacyOnlyWithLedgerRow += 1;
      legacyBucketImpact[bucket] += 1;
    }
  }
  sampleRss("after_classification");

  const population = byId.size;
  let bucketSum = 0;
  for (const b of EMBED_POPULATION_BUCKETS) bucketSum += bucketCounts[b];
  if (bucketSum !== population) {
    throw new EmbedPopulationCensusError(
      "census_buckets_do_not_partition",
      `bucket counts sum to ${bucketSum} but the distinct-id population is ${population}; the ` +
        `buckets do not partition the population, so no count from this run may be published`,
      { bucket_sum: bucketSum, population, bucket_counts: { ...bucketCounts } },
    );
  }

  // --- RECONCILE: every difference gets a COUNT (and a sample) ------------
  const diff = (a, b) => {
    let n = 0;
    const sample = [];
    for (const id of a) {
      if (!b.has(id)) {
        n += 1;
        if (sample.length < SAMPLE_LIMIT) sample.push(id);
      }
    }
    return { count: n, sample };
  };

  const idMapWithoutRow = diff(hnsw.ids, new Set(idMapIdsSeenOnLedger));
  const sidecarWithoutRow = diff(sidecar.ids, new Set(sidecarIdsSeenOnLedger));
  const sidecarNotInIdMap = diff(sidecar.ids, hnsw.ids);
  const idMapNotInSidecar = diff(hnsw.ids, sidecar.ids);
  let tombstonedWithRow = 0;
  for (const id of hnsw.tombstoned) if (byId.has(id)) tombstonedWithRow += 1;

  const legacyIds = legacy === null ? null : legacy.ids;
  const legacyRecon =
    legacyIds === null
      ? null
      : {
          distinct_ids: legacyIds.size,
          ids_with_ledger_row: legacyOnlyWithLedgerRow,
          ids_without_ledger_row: diff(legacyIds, byId),
          ids_absent_from_id_map: diff(legacyIds, hnsw.ids),
          ids_absent_from_vectors_sidecar: diff(legacyIds, sidecar.ids),
          bucket_impact_if_counted: sortedCounts(legacyBucketImpact),
          bucket_impact_note:
            "how many ids would MOVE bucket if this deliberately-excluded instrument were treated " +
            "as bucket-bearing. Ids already in an embedded bucket move nothing.",
        };

  // --- VERIFICATION -------------------------------------------------------
  // The post-pass call stays, and is now LOAD-BEARING: it is the only thing
  // that can catch a prefix that drifted DURING the counting pass (the pre-pass
  // gate above cannot see the future). Same code, different phase — both
  // observations are published rather than absorbed, and there is no exit-0
  // path on which either is false.
  const pv = verifyPrefix(ledgerPath, checkpoint);
  if (!pv.ok) {
    throw new EmbedPopulationCensusError(
      "census_prefix_drifted",
      `the pinned prefix of ${ledgerPath} [0, ${eof}) drifted DURING the counting pass ` +
        `(verifyPrefix reason ${JSON.stringify(pv.reason)}, pin_source ${pinSource}, phase ` +
        `post_pass). Per readAppended's caller contract in ` +
        `mcp/lib/synthesis/ledger-checkpoint.js, "a delta over a drifted prefix is ` +
        `meaningless" — the counts this pass produced are DISCARDED, not published with a ` +
        `flag. UNMEASURABLE, never a permit.`,
      { ledgerPath, eof, reason: pv.reason, pin_source: pinSource, phase: "post_pass" },
    );
  }
  let sha256Prefix = null;
  let digestError = null;
  if (verifyDigest) {
    try {
      sha256Prefix = await hashPrefix(ledgerPath, eof);
    } catch (e) {
      digestError = e && e.message ? e.message : String(e);
    }
  }
  const ledgerStatAfter = statOrThrow(ledgerPath, "census_ledger_unreadable", "ledger (post-pass re-stat)");
  const verificationMethod = verifyDigest
    ? "full-prefix-sha256-post-pass+sampled-witness+stat-identity"
    : "sampled-witness+stat-identity";

  // --- OFFSETS SIDECAR: checked, NEVER read ------------------------------
  const offsetsPath = `${ledgerPath}.offsets`;
  const offsetsStat = statIdentityOrNull(offsetsPath);
  const offsets = {
    path: offsetsPath,
    checked: true,
    read: false,
    present: offsetsStat !== null,
    mtime_ms: offsetsStat === null ? null : offsetsStat.mtime_ms,
    size: offsetsStat === null ? null : offsetsStat.size,
    ledger_mtime_ms: ledgerStatBefore.mtimeMs,
    stale:
      offsetsStat === null
        ? null
        : offsetsStat.mtime_ms < ledgerStatBefore.mtimeMs,
    reason:
      "stat-ed for staleness ONLY. This census never reads it: an offsets sidecar older than the " +
      "ledger it indexes cannot bound a prefix it has not seen.",
  };

  sampleRss("end");

  return {
    census_version: CENSUS_VERSION,
    measured_at: new Date().toISOString(),
    census_ms: Date.now() - t0,
    node_version: process.version,

    model_version: modelVersion,
    population,
    population_unit: POPULATION_UNIT,
    units_bound: UNITS_BOUND,

    buckets: sortedCounts(bucketCounts),
    bucket_enum: [...EMBED_POPULATION_BUCKETS],
    bucket_definitions: { ...BUCKET_DEFINITIONS },
    bucket_sum: bucketSum,
    partition_ok: bucketSum === population,
    partition_check: "sum(buckets) === population, asserted in code and re-checkable by hand",

    ledger: {
      ...fileIdentity(ledgerPath, ledgerStatBefore),
      size_at_start: ledgerStatBefore.size,
      size_at_end: ledgerStatAfter.size,
      identity_after: `${ledgerStatAfter.dev}:${ledgerStatAfter.ino}`,
      grew_during_census: ledgerStatAfter.size > ledgerStatBefore.size,
      pinned_eof: eof,
      // Bytes of the file PAST the pin. With a freshly captured pin this is the
      // torn final line (a partial append caught mid-write); with a pin handed
      // in from an earlier run it is every byte appended since. Either way the
      // census counts NONE of them, and the figure is published rather than
      // absorbed so a reader can see how much of the file was excluded.
      bytes_beyond_pin_at_start: ledgerStatBefore.size - eof,
      bytes_beyond_pin_at_end: ledgerStatAfter.size - eof,
      pin_source: pinSource,
      checkpoint: serializeCheckpoint(checkpoint),
      pin_note:
        "every count is over bytes [0, eof). stat.size is an OBSERVATION and is never a denominator; " +
        "the file grows under live writers and the pin does not move.",
    },

    verification: {
      method: verificationMethod,
      // Kept by name and meaning (backward compatibility). Both are now
      // provably true/null on every exit-0 path: a false reading is a REFUSAL
      // (census_prefix_drifted), never a published flag.
      prefix_verified: pv.ok,
      prefix_verify_reason: pv.reason,
      prefix_verified_pre_pass: pvPre.ok,
      prefix_verified_post_pass: pv.ok,
      prefix_gate:
        "verifyPrefix is read on BOTH sides of the counting pass and BRANCHES on both: !ok " +
        "throws census_prefix_drifted (pre_pass / post_pass). readAppended's caller contract: " +
        "\"a delta over a drifted prefix is meaningless.\"",
      witness_blocks: Array.isArray(checkpoint.witness) ? checkpoint.witness.length : null,
      sha256_prefix: sha256Prefix,
      digest_error: digestError,
      residual: verifyDigest
        ? "the witness was re-read BEFORE the pass (a drifted prefix refuses without counting) and " +
          "sha256 over [0, eof) was recomputed AFTER it. NOT detected: a change made and reverted " +
          "entirely inside the window between the pin and that hash."
        : "only the sampled witness (<=128 x 64 KiB) was re-read, on BOTH sides of the counting " +
          "pass; either reading false is a REFUSAL (census_prefix_drifted — UNMEASURABLE, never a " +
          "permit). NOT detected: a change confined to unsampled interior blocks. Pass " +
          "verifyDigest to hash the whole prefix (one EXTRA full read).",
    },

    offsets_sidecar: offsets,

    instruments: {
      hnsw_id_map: hnsw.instrument,
      vectors_sidecar: sidecar.instrument,
      legacy_embeddings_sidecar: legacyInstrument,
      ledger_predicate: {
        instrument: "ledger_predicate",
        path: ledgerPath,
        pinned_eof: eof,
        lines_seen: stats.lines + stats.skipped_blank + stats.skipped_oversized,
        lines_delivered: stats.lines,
        lines_not_delivered: stats.skipped_blank + stats.skipped_oversized,
        skipped_blank: stats.skipped_blank,
        skipped_oversized: stats.skipped_oversized,
        skipped_oversized_bytes: stats.skipped_oversized_bytes,
        bytes_delivered: stats.bytes,
        bytes_scanned: stats.bytes_scanned,
        accounting_identity_ok: identityLhs === eof,
        rows_classified: idBearingRows,
        unparseable_rows: unparseableRows,
        non_object_rows: nonObjectRows,
        rows_without_id: rowsWithoutId,
        distinct_ids: population,
        duplicate_id_rows: idBearingRows - population,
        inline_unexpected_length_rows: inlineUnexpectedLength,
        embed_state_non_boolean_rows: embedStateNonBoolean,
        kind_label_overflow: kinds.overflowed(),
        source_label_overflow: sources.overflowed(),
        caveat:
          "readAppended COUNTS blank and over-cap lines but NEVER delivers them to onLine. " +
          "lines_seen and rows_classified are therefore separate figures and their difference is " +
          "reported here, never absorbed.",
      },
    },
    instruments_measured: [
      "hnsw_id_map",
      "vectors_sidecar",
      "ledger_predicate",
      ...(legacyInstrument.measured === true ? ["legacy_embeddings_sidecar"] : []),
    ],

    cross_tabs: {
      axes_note:
        "the source axis reads the TOP-LEVEL `source` field; `provenance` on these rows holds " +
        "{agent_id, conversation_id, confidence} and NO source, so a provenance-keyed census would " +
        "report undefined for every row.",
      wipe_threshold: wipeThreshold,
      population_by_kind: sortedCounts(popByKind),
      population_by_source: sortedCounts(popBySource),
      population_by_created_at_vs_wipe: sortedCounts(popByCreated),
      population_by_is_seed_row: sortedCounts(popBySeed),
      bucket_by_kind: mapBuckets(byKind),
      bucket_by_source: mapBuckets(bySource),
      bucket_by_created_at_vs_wipe: mapBuckets(byCreated),
      bucket_by_is_seed_row: mapBuckets(bySeed),
      bucket_by_inline_vector: mapBuckets(byInline),
    },

    unmeasurable_bucket_shape: {
      bucket: UNMEASURABLE_BUCKET,
      count: bucketCounts[UNMEASURABLE_BUCKET],
      is_embedded: false,
      statement:
        "rows carrying NO features.embed_state key and no vector by any instrument. This is a " +
        "statement of IGNORANCE about those rows, never a claim that they are embedded.",
      by_kind: sortedCounts(byKind[UNMEASURABLE_BUCKET]),
      by_source: sortedCounts(bySource[UNMEASURABLE_BUCKET]),
      by_created_at_vs_wipe: sortedCounts(byCreated[UNMEASURABLE_BUCKET]),
      by_is_seed_row: sortedCounts(bySeed[UNMEASURABLE_BUCKET]),
    },

    reconciliation: {
      id_map_ids_without_ledger_row: idMapWithoutRow,
      vectors_sidecar_ids_without_ledger_row: sidecarWithoutRow,
      vectors_sidecar_ids_absent_from_id_map: sidecarNotInIdMap,
      id_map_ids_absent_from_vectors_sidecar: idMapNotInSidecar,
      tombstoned_ids: hnsw.tombstoned.size,
      tombstoned_ids_with_ledger_row: tombstonedWithRow,
      inline_vector_but_unindexed: bucketCounts["P-INLINE-ONLY"],
      chunked_parent_ids_in_vectors_sidecar: sidecar.instrument.chunked_parent_ids,
      legacy_embeddings_sidecar: legacyRecon,
      note: "no discrepancy is reported without a count; samples are capped at 5 ids each.",
    },

    queue_visibility: {
      is_population: false,
      unit: "QUEUE ids (entries in the re-embed sweep file) — NOT a population, NOT a coverage",
      sweep_path: sweepPath,
      sweep_file: sweep.file,
      sweep_raw_lines: sweep.rawLines,
      sweep_distinct_ids: sweep.ids.size,
      needs_embed_ids_present_in_sweep: needsEmbedInSweep,
      needs_embed_ids_absent_from_sweep: needsEmbedNotInSweep,
      error: sweep.error,
      note:
        "a CEILING on how many P-NEEDS-EMBED ids the sweep queue could ever have seen. The queue's " +
        "scope is not the system's state: this number may not be reported as a population, a " +
        "coverage, or a backlog of the ledger.",
    },

    premises: {
      goal_tail_embed_state_true_89_6_pct: {
        claim:
          "GOAL: 18,891 of 21,089 rows in a 200 MB tail carry embed_state === true (89.6%)",
        status: "re-derived",
        window: {
          unit: "LINES (rows), not distinct ids — matching the claim's own unit",
          tail_bytes: eof - tailStart,
          tail_start_offset: tailStart,
          pinned_eof: eof,
          sampled: true,
          sampling_note:
            "a TAIL WINDOW of the pinned prefix, stated as sampled. It is never presented as a " +
            "population — the population figures are the bucket counts over [0, eof).",
        },
        measured: {
          id_bearing_rows: tailIdRows,
          embed_state_true: tailEmbedStateTrue,
          embed_state_false: tailEmbedStateFalse,
          embed_state_absent: tailEmbedStateAbsent,
          inline_vector_rows: tailInlineVector,
          embed_state_true_pct:
            tailIdRows === 0 ? null : Math.round((tailEmbedStateTrue / tailIdRows) * 1e4) / 1e2,
        },
      },
      goal_1_410_113: {
        claim:
          "GOAL: '~1.41M facts have no vector' / the carried figure 1,410,113, which arrives " +
          "with NO predicate naming which rows it counted",
        status: "refused_as_stated_and_re_derived_by_predicate",
        reason:
          "as stated the figure is not re-derivable: 'has no vector' is a predicate this census " +
          "measures three ways, and the inherited number matches NONE of them. It is therefore " +
          "NOT restated as fact. What the census publishes instead are the predicates themselves.",
        census_population: population,
        census_needs_embed: bucketCounts["P-NEEDS-EMBED"],
        // no vector by ANY instrument = needs-embed + flag-lying + unmeasurable.
        // P-INLINE-ONLY is EXCLUDED: those rows carry a vector, just not one any
        // index holds — folding them in would be the "absence is a verdict" error.
        census_no_vector_by_any_instrument:
          bucketCounts["P-NEEDS-EMBED"] +
          bucketCounts["P-EMBED-STATE-FALSE-NO-VECTOR"] +
          bucketCounts[UNMEASURABLE_BUCKET],
        census_rows_created_before_wipe_threshold:
          popByCreated[CREATED_LABELS[CREATED_BEFORE_WIPE]] === undefined
            ? 0
            : popByCreated[CREATED_LABELS[CREATED_BEFORE_WIPE]],
        observed_exact_match_with_a_different_predicate:
          "the integer 1,410,113 is reproduced EXACTLY by this census's " +
          "population_by_created_at_vs_wipe.before_wipe_threshold — a predicate about DATE, not " +
          "about vectors. That is an OBSERVATION about two numbers, NOT a claim about where the " +
          "inherited figure came from; its derivation is unrecorded and is not reconstructed here.",
      },
      offsets_sidecar_currency: {
        claim: "ledgers/memory.jsonl.offsets is current enough to bound the prefix",
        status: offsets.stale === null ? "unmeasurable" : offsets.stale ? "refuted" : "not_refuted",
        detail: offsets,
      },
      embed_state_is_boolean: {
        claim: "CAPS.EMBED_STATE_VALUES: features.embed_state persists as a BOOLEAN",
        enforcing_symbol: "mcp/lib/validation.js CAPS.EMBED_STATE_VALUES (documentation only)",
        status: "re-derived",
        non_boolean_rows: embedStateNonBoolean,
        note: "a non-zero count here is a REFUSAL (census_embed_state_non_boolean), not a bucket.",
      },
    },

    peak_rss_bytes: peakRss,
    rss_samples: sortedCounts(rssSamples),
    retention_note:
      "peak retention is one Map<id, packed SMI> over the distinct population plus the id_map, " +
      "vectors.jsonl and sweep id sets. Parsed rows are never retained.",
  };
}

function mapBuckets(perBucket) {
  const out = Object.create(null);
  for (const b of EMBED_POPULATION_BUCKETS) out[b] = sortedCounts(perBucket[b]);
  return out;
}

/** sha256 over EXACTLY bytes [0, eof). Read-only; opt-in (an extra full read). */
function hashPrefix(path, eof) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    if (eof === 0) {
      resolve(hash.digest("hex"));
      return;
    }
    const rs = createReadStream(path, { start: 0, end: eof - 1 });
    let got = 0;
    rs.on("data", (chunk) => {
      got += chunk.length;
      hash.update(chunk);
    });
    rs.on("error", reject);
    rs.on("end", () => {
      if (got !== eof) {
        reject(new Error(`short-read: hashed ${got} of ${eof} bytes`));
        return;
      }
      resolve(hash.digest("hex"));
    });
  });
}
