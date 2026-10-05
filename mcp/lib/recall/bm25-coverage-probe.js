// bm25-coverage-probe.js — B1 (memory-recall hypergraph).
//
// WHAT THIS MEASURES
// ------------------
// One ratio, and it is deliberately asymmetric:
//
//   numerator   = loadBm25IndexFromV2File(indexPath).size()
//                 → Bm25Index#size() is `this._docLen.size` (bm25-index.js:93),
//                   i.e. the count of DISTINCT DOC IDS the on-disk index holds.
//   denominator = countFactRowsStreamed(ledgerPath).fact_count
//                 → the count of eligible LEDGER LINES: every parsed line with
//                   a non-empty string `id` AND a non-empty string `content`
//                   (bm25-rebuild.js:512-518). This is LINES, not distinct ids.
//
// The asymmetry is STAMPED in the result (`numerator_unit`,
// `denominator_unit`, `units_bound`) rather than hidden. Duplicate ids on the
// ledger would inflate the denominator and depress coverage. That is bounded
// as measured-negligible, not proven zero: the B1 map's 50 MB tail sample
// found 826 eligible rows at a 1.0 duplicate ratio, and A3's live pin (F11b)
// found `id_row_count === line_count` over the whole 2.9 GB file. If the
// ledger ever grows a real duplicate population, this probe under-reports
// coverage — it never over-reports it.
//
// UNITS
// -----
// `coverage_pct` is a PERCENT in [0,100] — 40 means 40%, not 0.4. This is
// stated because a sibling gets it wrong: `mcp/lib/synthesis/coverage-probe.js`
// `pct()` (:130-135) returns a FRACTION (0.0189 for 1.89%). That helper is
// deliberately NOT reused here. `coverage_pct` can only exceed 100 if the
// index holds doc ids the ledger's eligible set no longer contains — the
// rebuilder derives doc ids FROM those rows, so >100 is a real anomaly worth
// surfacing, and is therefore not clamped away.
//
// ABSENCE IS LOUD (the F20 defect, relocated to the denominator side)
// -------------------------------------------------------------------
// `countFactRowsStreamed` CANNOT report a bad ledger:
//   - `streamLedgerLines` returns all-zero counts with `readError: null` on
//     ENOENT (_ledger-stream.js:140-148);
//   - `ledgerSize` returns 0 from a bare `catch` (bm25-rebuild.js:467-473);
//   - `countFactRowsStreamed` DROPS `readError` from its return object
//     entirely (bm25-rebuild.js:519-523).
// So a missing / unreadable ledger would silently read as "0 eligible rows",
// i.e. as infinite starvation — indistinguishable from the finding this probe
// exists to measure. Mitigation: `statSync` the ledger BEFORE streaming (that
// throws on ENOENT/EACCES), cross-check the streamer's own `ledger_size`
// against it, and throw a named error when `eligible_rows === 0`. No path in
// this module can return NaN or Infinity coverage.
//
// THE LOADER'S SILENT-DEGRADATION BOUND (stated, not assumed)
// -----------------------------------------------------------
// "An unreadable index throws" is only half true. `openSync` throws on
// ENOENT/EACCES and a missing/unparseable HEADER line throws
// (bm25-streaming-loader.js:131-133) — but a mid-file read error breaks the
// loop (`catch { break; }`, :63-67) and every malformed line is silently
// skipped (:102-104). A TRUNCATED or CORRUPT bm25.json therefore loads
// PARTIALLY and returns a low `size()` with NO error, which is exactly the
// starvation signature this probe reports. That cannot be fixed read-only, so
// it is made VISIBLE instead:
//   - `index_stat_identity` / `index_stat_identity_after` /
//     `index_moved_during_load` — the active dir republishes live (manifest
//     generation 64 with `index-wal.jsonl` advancing), so the race is real;
//   - `index_integrity` — a read-only cross-check of the file against the
//     sibling `index-manifest.json`'s declared `members.bm25 {file,size,sha256}`.
//
// STRICTLY READ-ONLY
// ------------------
// This module writes NOTHING. It never touches `indices/`, `storage/` or the
// ledger. Two neighbouring helpers are deliberately NOT used, and their names
// are kept OUT of this file so the node's acceptance greps stay exact:
//   - index-manifest.js:127 (the publish-time member checksum) calls :231
//     (the verified-digest recorder), which WRITES `index-digest-cache.json`
//     INTO the live per-model index dir. Only `sha256File` (:101),
//     `readActiveManifest` (:349) and `memberStatIdentity` (:165) are reused;
//     all three are pure reads.
//   - bm25-rebuild.js:667 (the checkpointed row counter) WRITES the
//     `storage/bm25-growth-check.json` sidecar and would move the rebuild
//     daemon's growth trigger. That sidecar is read-only INPUT here; the
//     streaming counter at :509 is the one that touches nothing.
// Note: importing the streaming counter transitively loads the index cache
// module (bm25-rebuild.js:96 imports `publishGeneration` from it). Nothing
// here imports or calls that module directly, and it has no import-time side
// effects.
//
// NO DISPATCH. This module has no call site in the recall path. It is the
// measurement substrate B2/B3/B4 bind their thresholds to, via the single
// threshold home `assertCoverageFloor`.

import { readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";

import { countFactRowsStreamed } from "./bm25-rebuild.js";
import {
  memberStatIdentity,
  readActiveManifest,
  sha256File,
} from "./index-manifest.js";
import { loadBm25IndexFromV2File } from "./bm25-streaming-loader.js";
import { ACTIVE_EMBED_MODEL_VERSION } from "../validation.js";

/** Stamped on every result so consumers never have to guess the units. */
export const NUMERATOR_UNIT = "distinct_doc_ids";
export const DENOMINATOR_UNIT = "eligible_lines";

const UNITS_BOUND =
  "numerator = distinct doc ids in the index (Bm25Index#size() = _docLen.size); " +
  "denominator = eligible LINES on the ledger (non-empty string id AND non-empty " +
  "string content), NOT distinct ids. Duplicate ids on the ledger would inflate " +
  "the denominator and DEPRESS coverage; measured negligible (50MB tail: 826 rows, " +
  "dup ratio 1.0; A3 live pin: id_row_count === line_count), not proven zero.";

/**
 * Named error for every refusal this module makes. `code` is stable; the
 * message always carries the numbers a caller needs to self-diagnose.
 */
export class Bm25CoverageProbeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "Bm25CoverageProbeError";
    this.code = code;
    this.details = details;
  }
}

function requirePathArg(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Bm25CoverageProbeError(
      "probe_bad_arguments",
      `probeBm25Coverage: ${name} must be a non-empty string path (no default exists)`,
      { [name]: value },
    );
  }
  return value;
}

/**
 * statOrThrow — the LOUD-absence primitive. `statSync` throws on ENOENT and
 * EACCES; we convert that into a named, coded error rather than letting a
 * downstream zero stand in for it.
 */
function statOrThrow(path, code, what) {
  let st;
  try {
    st = statSync(path);
  } catch (e) {
    const errno = e && e.code ? e.code : null;
    throw new Bm25CoverageProbeError(
      code,
      `${what} is unreadable at ${path}` + (errno ? ` (${errno})` : "") +
        `: ${e && e.message ? e.message : String(e)}`,
      { path, errno },
    );
  }
  if (!st.isFile()) {
    throw new Bm25CoverageProbeError(code, `${what} at ${path} is not a regular file`, {
      path,
      errno: null,
    });
  }
  return st;
}

/**
 * indexIntegrity — read-only cross-check of the bm25 file against the sibling
 * `index-manifest.json`. NEVER writes; hashes with `sha256File` only.
 *
 * status ∈ {
 *   manifest-verified   — declared size AND sha256 both match the bytes on disk
 *   size-verified       — size matches; sha skipped via {verifyIndexDigest:false}
 *   size-mismatch       — declared size ≠ on-disk size (a truncated index lands here)
 *   sha-mismatch        — size matches, content does not
 *   member-not-declared — manifest exists but does not declare THIS file as members.bm25
 *   no-manifest         — no sibling index-manifest.json (pre-adoption / fixture dir)
 *   manifest-unreadable — manifest present but malformed (readActiveManifest error)
 *   sha-unreadable      — hashing failed mid-read (file replaced under us)
 * }
 */
function indexIntegrity(indexPath, st, verifyIndexDigest) {
  const dir = dirname(indexPath);
  const file = basename(indexPath);
  const { manifest, error } = readActiveManifest(dir);
  if (error) {
    return { status: "manifest-unreadable", detail: `${error.code}: ${error.message}` };
  }
  if (manifest == null) {
    return { status: "no-manifest", detail: null };
  }
  const declared = manifest.members && manifest.members.bm25;
  if (declared == null || declared.file !== file) {
    return {
      status: "member-not-declared",
      detail: `manifest generation ${manifest.generation} declares members.bm25=${
        declared == null ? "null" : JSON.stringify(declared.file)
      }, probed file is ${JSON.stringify(file)}`,
    };
  }
  if (declared.size !== st.size) {
    return {
      status: "size-mismatch",
      detail: `manifest declares size ${declared.size}, on-disk size is ${st.size}`,
    };
  }
  if (!verifyIndexDigest) {
    return {
      status: "size-verified",
      detail: "sha256 skipped by {verifyIndexDigest:false}",
    };
  }
  let sha;
  try {
    sha = sha256File(indexPath);
  } catch (e) {
    return {
      status: "sha-unreadable",
      detail: e && e.message ? e.message : String(e),
    };
  }
  if (sha !== declared.sha256) {
    return {
      status: "sha-mismatch",
      detail: `manifest declares sha256 ${declared.sha256}, on-disk bytes hash to ${sha}`,
    };
  }
  return { status: "manifest-verified", detail: null };
}

/**
 * growthWitness — read + parse `storage/bm25-growth-check.json`, the daemon's
 * PERSISTED count under the same eligibility predicate (equivalence contract
 * documented at bm25-rebuild.js:528-547). Read-only and non-fatal: any problem
 * degrades to a null witness with a stated reason. The checkpointed counter at
 * bm25-rebuild.js:667 is never called — it would rewrite this sidecar.
 */
function growthWitness(path) {
  if (path == null) {
    return { fact_count: null, eof: null, error: "not supplied" };
  }
  if (typeof path !== "string" || path.length === 0) {
    return { fact_count: null, eof: null, error: "growthCheckPath must be a non-empty string" };
  }
  let j;
  try {
    j = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { fact_count: null, eof: null, error: e && e.message ? e.message : String(e) };
  }
  if (j == null || typeof j !== "object" || !Number.isInteger(j.fact_count)) {
    return { fact_count: null, eof: null, error: "bad sidecar shape" };
  }
  const eof =
    j.checkpoint != null && Number.isInteger(j.checkpoint.eof) ? j.checkpoint.eof : null;
  return { fact_count: j.fact_count, eof, error: null };
}

/**
 * snapshotWitness — A3's `ledgers/snapshots/latest.json` is a DRIFT WITNESS
 * ONLY. Accepts the parsed payload or a path to it.
 *
 * Its `line_count` / `id_row_count` are NEVER substituted for `eligible_rows`:
 * A3 pins ID-BEARING lines while BM25 eligibility ALSO requires a non-empty
 * `content`. Those predicates differ by ~1.2k rows today, so substituting
 * would silently inflate the denominator with a different predicate.
 */
function snapshotWitness(snapshot) {
  if (snapshot == null) return { eof: null, line_count: null, id_row_count: null, error: null };
  let payload = snapshot;
  if (typeof snapshot === "string") {
    try {
      payload = JSON.parse(readFileSync(snapshot, "utf8"));
    } catch (e) {
      return {
        eof: null,
        line_count: null,
        id_row_count: null,
        error: e && e.message ? e.message : String(e),
      };
    }
  }
  if (payload == null || typeof payload !== "object") {
    return { eof: null, line_count: null, id_row_count: null, error: "bad snapshot shape" };
  }
  return {
    eof: Number.isInteger(payload.eof) ? payload.eof : null,
    line_count: Number.isInteger(payload.line_count) ? payload.line_count : null,
    id_row_count: Number.isInteger(payload.id_row_count) ? payload.id_row_count : null,
    error: null,
  };
}

/**
 * probeBm25Coverage — measure how much of the eligible ledger the active BM25
 * index actually holds. Strictly read-only.
 *
 * @param {object} opts
 * @param {string} opts.indexPath        Absolute path to a v2 bm25.json. REQUIRED, no default.
 * @param {string} opts.ledgerPath       Absolute path to the ledger. REQUIRED, no default.
 * @param {object|string} [opts.snapshot]        A3 pin payload, or a path to it. Drift witness only.
 * @param {string} [opts.growthCheckPath]        Path to storage/bm25-growth-check.json. Read-only witness.
 * @param {boolean} [opts.verifyIndexDigest=true] Set false to skip the manifest sha256
 *                                                (a 20MB hash is ~50ms; a 724MB one ~1-2s).
 * @returns {object} the stamped measurement (see fields below).
 * @throws {Bm25CoverageProbeError} on a missing/unreadable index or ledger, on a
 *         ledger with zero eligible rows, or on any non-finite ratio.
 */
export function probeBm25Coverage(opts = {}) {
  const t0 = Date.now();
  const o = opts == null ? {} : opts;
  const indexPath = requirePathArg(o.indexPath, "indexPath");
  const ledgerPath = requirePathArg(o.ledgerPath, "ledgerPath");
  const verifyIndexDigest = o.verifyIndexDigest !== false;

  // --- LOUD absence, both sides, BEFORE any counting ----------------------
  const indexStatBefore = statOrThrow(indexPath, "probe_index_unreadable", "bm25 index");
  const ledgerStat = statOrThrow(ledgerPath, "probe_ledger_unreadable", "ledger");

  // --- numerator: DISTINCT DOC IDS ---------------------------------------
  const idx = loadBm25IndexFromV2File(indexPath);
  const indexed_docs = idx.size();
  const indexStatAfter = statOrThrow(
    indexPath,
    "probe_index_unreadable",
    "bm25 index (post-load re-stat)",
  );

  // --- denominator: ELIGIBLE LINES ---------------------------------------
  const counted = countFactRowsStreamed(ledgerPath);
  const eligible_rows = counted.fact_count;

  if (!Number.isInteger(eligible_rows) || eligible_rows < 0) {
    throw new Bm25CoverageProbeError(
      "probe_ledger_read_anomaly",
      `countFactRowsStreamed returned a non-integer fact_count (${String(eligible_rows)}) for ${ledgerPath}`,
      { ledgerPath, counted },
    );
  }
  // countFactRowsStreamed's own ledger_size comes from a bare catch that
  // yields 0 (bm25-rebuild.js:467-473). Our stat already proved the file is
  // there, so a 0 here means the streamer could not read what we just stat-ed.
  if (counted.ledger_size === 0 && ledgerStat.size > 0) {
    throw new Bm25CoverageProbeError(
      "probe_ledger_read_anomaly",
      `ledger at ${ledgerPath} stats to ${ledgerStat.size} bytes but the row streamer saw 0 — ` +
        `the streamer's read failed silently (it drops readError)`,
      { ledgerPath, stat_size: ledgerStat.size, streamed_size: counted.ledger_size },
    );
  }
  if (eligible_rows === 0) {
    throw new Bm25CoverageProbeError(
      "probe_ledger_no_eligible_rows",
      `ledger at ${ledgerPath} (${ledgerStat.size} bytes, ${counted.total_lines} lines) yielded ZERO ` +
        `rows eligible for BM25 (non-empty string id AND non-empty string content). ` +
        `Refusing to report coverage against an empty denominator — this is absence, not 100% starvation.`,
      { ledgerPath, ledger_size: ledgerStat.size, total_lines: counted.total_lines },
    );
  }

  // --- the ratio, as a PERCENT -------------------------------------------
  const rawPct = (indexed_docs / eligible_rows) * 100;
  if (!Number.isFinite(rawPct)) {
    throw new Bm25CoverageProbeError(
      "probe_coverage_not_finite",
      `coverage is not finite: indexed_docs=${indexed_docs} eligible_rows=${eligible_rows}`,
      { indexed_docs, eligible_rows },
    );
  }
  const coverage_pct = Math.round(rawPct * 1e4) / 1e4;

  // --- witnesses ----------------------------------------------------------
  const integrity = indexIntegrity(indexPath, indexStatAfter, verifyIndexDigest);
  const witness = growthWitness(o.growthCheckPath == null ? null : o.growthCheckPath);
  const snap = snapshotWitness(o.snapshot == null ? null : o.snapshot);

  const model_version = basename(dirname(indexPath));

  return {
    // ---- the three numbers ----
    model_version,
    indexed_docs,
    eligible_rows,
    coverage_pct,

    // ---- units, stated never assumed ----
    numerator_unit: NUMERATOR_UNIT,
    denominator_unit: DENOMINATOR_UNIT,
    coverage_pct_unit: "percent",
    units_bound: UNITS_BOUND,
    indexed_docs_exceeds_eligible_rows: indexed_docs > eligible_rows,

    // ---- model identity (never hard-coded) ----
    active_model_version: ACTIVE_EMBED_MODEL_VERSION,
    is_active_model: model_version === ACTIVE_EMBED_MODEL_VERSION,

    // ---- paths ----
    index_path: indexPath,
    ledger_path: ledgerPath,

    // ---- index witness (the loader's partial-load bound, made visible) ----
    index_size: indexStatAfter.size,
    index_stat_identity: memberStatIdentity(indexStatBefore),
    index_stat_identity_after: memberStatIdentity(indexStatAfter),
    index_moved_during_load:
      memberStatIdentity(indexStatBefore) !== memberStatIdentity(indexStatAfter),
    index_integrity: integrity.status,
    index_integrity_detail: integrity.detail,
    index_digest_verified: verifyIndexDigest,

    // ---- ledger witness ----
    ledger_size: ledgerStat.size,
    ledger_size_streamed: counted.ledger_size,
    ledger_total_lines: counted.total_lines,
    ledger_stat_identity: memberStatIdentity(ledgerStat),

    // ---- daemon's persisted denominator witness (read-only) ----
    eligible_rows_witness: witness.fact_count,
    witness_delta: witness.fact_count == null ? null : eligible_rows - witness.fact_count,
    witness_stale_bytes: witness.eof == null ? null : ledgerStat.size - witness.eof,
    witness_error: witness.error,

    // ---- A3 snapshot drift witness (NEVER the denominator) ----
    snapshot_eof: snap.eof,
    snapshot_line_count: snap.line_count,
    snapshot_id_row_count: snap.id_row_count,
    ledger_grew_since_snapshot: snap.eof == null ? null : ledgerStat.size > snap.eof,
    snapshot_error: snap.error,

    probe_ms: Date.now() - t0,
    probed_at: new Date().toISOString(),
  };
}

/**
 * assertCoverageFloor — the ONE home for a coverage threshold. B2/B3/B4 bind
 * theirs here; nothing else in the tree may pin a number against live data.
 *
 * Returns the result when `result.coverage_pct >= minPct`; otherwise throws
 * with all three numbers plus `model_version` in the message, so a sibling's
 * failing gate is self-diagnosing without a debugger.
 *
 * @param {object} result  a probeBm25Coverage() return value
 * @param {number} minPct  the floor, as a PERCENT (50 means 50%, not 0.5)
 * @returns {object} result
 * @throws {Bm25CoverageProbeError}
 */
export function assertCoverageFloor(result, minPct) {
  if (result == null || typeof result !== "object") {
    throw new Bm25CoverageProbeError(
      "probe_bad_arguments",
      "assertCoverageFloor: result must be a probeBm25Coverage() object",
      { result },
    );
  }
  if (typeof minPct !== "number" || !Number.isFinite(minPct)) {
    throw new Bm25CoverageProbeError(
      "probe_bad_arguments",
      `assertCoverageFloor: minPct must be a finite number of PERCENT, got ${String(minPct)}`,
      { minPct },
    );
  }
  const c = result.coverage_pct;
  if (typeof c !== "number" || !Number.isFinite(c)) {
    throw new Bm25CoverageProbeError(
      "probe_bad_arguments",
      `assertCoverageFloor: result.coverage_pct is not a finite number (${String(c)})`,
      { coverage_pct: c },
    );
  }
  if (c >= minPct) return result;
  throw new Bm25CoverageProbeError(
    "bm25_coverage_below_floor",
    `BM25 candidate coverage ${c}% is below the ${minPct}% floor for ` +
      `model_version=${result.model_version}: ${result.indexed_docs} distinct doc ids indexed ` +
      `vs ${result.eligible_rows} eligible ledger lines ` +
      `(index=${result.index_path}, ledger=${result.ledger_path}, ` +
      `index_integrity=${result.index_integrity})`,
    {
      coverage_pct: c,
      min_pct: minPct,
      indexed_docs: result.indexed_docs,
      eligible_rows: result.eligible_rows,
      model_version: result.model_version,
      index_integrity: result.index_integrity,
    },
  );
}
