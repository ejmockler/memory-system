// content-index.js — WU1-promote-time-content-dedup-gate.
//
// An EMBEDDING-FREE content-dedup index from
//   normalized-content-hash → canonical (EARLIEST / first-seen) fact_id.
//
// WHY THIS EXISTS (root cause, confirmed empirically):
//   The cascade persists ~1.33M duplicate noise facts because:
//     (a) cross-source-dedup is bounded to a 10k-entry LRU window, so
//         duplicates far apart in a 1.4M-row history escape;
//     (b) the novelty gate that would catch low-value content defaults to
//         0.5 (admit) when embeddings are null;
//     (c) W5 PROMOTE_WITHOUT_EMBED bypasses the embed-novelty gate when the
//         Gemini key pool is cooled.
//   Net: capture-everything, filter-nothing while Gemini is down.
//
//   The existing Layer-3 CORROBORATE decision (salience.js, emits
//   policy.corroboration, no new fact row) only fires via embed + kNN — dead
//   without Gemini. This module is the content-hash analog that works WITHOUT
//   embeddings: at promote time, if a candidate's normalized content already
//   maps to an earlier canonical fact id, the cascade CORROBORATEs against it
//   instead of writing a redundant fact row.
//
// W1 INCREMENTAL REDUCER (memperf):
//   The v1 cache was keyed on an EXACT ledger mtime+size fingerprint, so any
//   append invalidated it and forced a FULL re-stream of the multi-GB ledger
//   — once per watermark tick (15s), ~12.6TB/day of logical reads. v1 also
//   had a certify race: the fingerprint was stat'd AFTER the stream, so a row
//   appended between stream-EOF and stat was certified but never read.
//
//   v2 rebases validity + delta semantics onto the S1 checkpoint primitive
//   (ledger-checkpoint.js — newline-safe pinned EOF + sampled prefix-identity
//   witness). Every read path PINS ITS CHECKPOINT FIRST and then reads only
//   bytes at/below the pinned newline-safe EOF:
//     - loadOrRebuildContentIndex: captureCheckpoint({prev: cachedCp}) — one
//       O(witness) prefix verification per load, done INSIDE capture (W1b
//       dropped the older separate verifyPrefix call that doubled every
//       tick's witness reads) — then a caller-side witness-extension check
//       (non-extension = checkpoint discontinuity → full rebuild, never a
//       hybrid of old cached entries + new-file delta), then
//       readAppended(cachedCp, newCp) folds ONLY the appended delta rows
//       through the same applyRow fold as a full rebuild.
//     - rebuildContentIndex: captureCheckpoint FIRST, then
//       readAppended(emptyCheckpoint(), cp) reads exactly [0, cp.eof).
//   A torn (non-newline-terminated) tail is therefore never indexed and
//   never certified; it folds exactly once after its "\n" lands. Any prefix
//   drift / shrink / schema mismatch fails closed into a full rebuild — the
//   cache stays a derived, rebuildable projection, never authoritative.
//
// MIRRORS entity-index.js (per WU1) for everything else:
//   - on-disk cache at storage/content-index.cache.json, mode 0600,
//     tmp + rename atomic write;
//   - the derived-projection invariant: "indices are derived from the ledger,
//     never authoritative; treat as cache; rebuild from the ledger at any
//     time" (kb/architecture.md §5). NEVER readFileSync the multi-GB ledger —
//     all ledger reads stream through _ledger-stream.js via
//     ledger-checkpoint.js readAppended.
//
// MEMORY DISCIPLINE:
//   The on-disk + in-memory map holds ONLY unique-content entries
//   (~hundreds of thousands of distinct normalized contents), NOT one entry
//   per ledger row (~1.4M). Each unique content hash maps to a single string
//   fact_id (the earliest), so the heap cost is bounded by the cardinality of
//   distinct content, not by ledger length.
//
// CANONICAL = EARLIEST:
//   The rebuild streams the ledger top-to-bottom (ledger order == append /
//   created_at order under the append-only invariant) and records the FIRST
//   fact_id seen for each content hash. Later rows with the same hash are the
//   duplicates that the promote-time gate will collapse into a CORROBORATE.
//   The incremental fold preserves this automatically: cached entries are
//   already the earliest for their hash, and applyRow never overwrites.
//
// NORMALIZATION PARITY (load-bearing):
//   normalizeContent + contentHash MUST agree byte-for-byte with the
//   recall-time dedup key (recall.js _normalizeContentForDedup +
//   _dedupKeyForScored) so promote-time CORROBORATE and recall-time
//   collapse key the same content identically.
//
//   DUPLICATION NOTE (FUTURE UNIFY): recall.js DOES export
//   _normalizeContentForDedup, but importing recall.js here would pull the
//   ENTIRE recall dependency graph (gemini-client's boot-time AIza-key
//   validator, hybrid-retriever, hard-gates, mmr, rerank, …) into the
//   cascade hot path via salience.js → content-index.js. salience.js
//   deliberately does NOT import recall.js today; adding that edge would
//   make the cascade boot fail in any hermetic context without a GEMINI key
//   set, and risks an import cycle (recall.js already imports entity-index +
//   _ledger-stream from this same synthesis tier). So we DEFINE the
//   normalization IDENTICALLY here (trim + collapse /\s+/g to single space +
//   lowercase; non-string → ""). The hash format ("c:" + sha256 hex) also
//   matches recall.js _dedupKeyForScored verbatim. A future unify should
//   lift _normalizeContentForDedup into a tiny dependency-free module
//   (e.g. lib/synthesis/_content-normalize.js) that BOTH recall.js and this
//   module import — keep the two definitions byte-identical until then.

import { existsSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import {
  captureCheckpoint,
  deserializeCheckpoint,
  emptyCheckpoint,
  readAppended,
  serializeCheckpoint,
} from "./ledger-checkpoint.js";

// Normalize content for the dedup key. Returns "" for non-string / empty.
// MUST stay byte-identical to recall.js _normalizeContentForDedup (see the
// DUPLICATION NOTE above). trim → collapse ALL internal whitespace runs
// (incl. tabs/newlines) to a single space → lowercase.
function _normalizeContentForDedup(content) {
  if (typeof content !== "string") return "";
  return content.trim().replace(/\s+/g, " ").toLowerCase();
}

// ---------------------------------------------------------------------------
// Module identity (per WU1 discipline: export VERSION + frozen CAPS).
// ---------------------------------------------------------------------------

/** Module version. Bump on any behavioural change to the index contract.
 *  Pinned to "v1" by content-dedup-gate.test.mjs — the PUBLIC contract
 *  (exports, return shapes, lookup semantics) is unchanged by W1; only the
 *  on-disk cache schema (SCHEMA_VERSION below) moved to v2. */
export const CONTENT_INDEX_VERSION = "v1";

/** Frozen module-local caps. The cascade-tier enable flag lives in
 *  validation.js CAPS (CASCADE_CONTENT_DEDUP_ENABLED); these are the
 *  content-index's own structural constants. */
export const CONTENT_INDEX_CAPS = Object.freeze({
  // On-disk cache schema version. A mismatch on load triggers a full rebuild.
  // v2 (W1): payload adds a serialized ledger-checkpoint (newline-safe eof +
  // prefix witness); a legacy v1 cache (mtime+size only) full-rebuilds once.
  SCHEMA_VERSION: "v2",
  // Hash key prefix. Matches recall.js _dedupKeyForScored ("c:" + sha256 hex).
  HASH_PREFIX: "c:",
});

// Write policy (W1): on the incremental path, persist the cache ONLY when the
// fold gained at least one new unique-content entry OR the un-persisted delta
// since the cached checkpoint exceeds this byte cap. An unchanged 15s tick
// must never rewrite a multi-MB cache file; a long run of duplicate-only
// appends still re-checkpoints once per cap so re-parsed delta stays bounded.
const PERSIST_DELTA_BYTES_CAP = 32 * 1024 * 1024; // 32 MiB, frozen

// ---------------------------------------------------------------------------
// Public: normalization + hashing (parity with recall.js)
// ---------------------------------------------------------------------------

/**
 * Normalize content for the dedup key: trim + collapse internal whitespace
 * runs to a single space + lowercase. Delegates to recall.js's
 * _normalizeContentForDedup so promote-time and recall-time agree exactly.
 *
 * Non-string / empty input -> "" (the caller treats "" as "no usable
 * content" and never dedups it).
 *
 * @param {string} content
 * @returns {string}
 */
export function normalizeContent(content) {
  return _normalizeContentForDedup(content);
}

/**
 * Content hash for the dedup key: "c:" + sha256(normalizeContent(content)).
 *
 * Returns null for empty / missing content — meaning "never dedup an
 * empty-content fact" (distinct content-less facts must NOT collapse
 * together). This mirrors recall.js _dedupKeyForScored, which falls back to
 * keying by memory_id when the normalized content is empty.
 *
 * @param {string} content
 * @returns {string|null}
 */
export function contentHash(content) {
  const normalized = normalizeContent(content);
  if (normalized.length === 0) return null;
  return (
    CONTENT_INDEX_CAPS.HASH_PREFIX +
    createHash("sha256").update(normalized, "utf8").digest("hex")
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Apply a single ledger row to the in-progress content index. Tolerates rows
 * that are not fact rows, rows without a usable `content` string, and rows
 * without an `id`. Records ONLY the FIRST (earliest / first-seen in ledger
 * order) fact_id for each content hash — later duplicates are left for the
 * promote-time gate to collapse.
 */
function applyRow(byContentHash, row) {
  if (row == null || typeof row !== "object") return;
  // Only fact rows carry promote-time content we want to dedup. Policy /
  // recall / reconstructed rows are not capture candidates. (kind may be
  // absent on legacy rows; tolerate that by treating absent-kind rows that
  // DO carry a content string as facts — the content string is the gate.)
  if (typeof row.kind === "string" && row.kind !== "fact") return;
  const factId = row.id;
  if (typeof factId !== "string" || factId.length === 0) return;
  const content = typeof row.content === "string" ? row.content : "";
  const hash = contentHash(content);
  if (hash === null) return; // empty content -> never dedup
  // EARLIEST wins: only record if this hash has not been seen yet. The stream
  // visits the ledger top-to-bottom, so the first occurrence is the earliest.
  if (!byContentHash.has(hash)) {
    byContentHash.set(hash, factId);
  }
}

/**
 * Fold exactly the terminated ledger rows in [fromCp.eof, toCp.eof) into the
 * map via applyRow — the ONE row-semantics shared by full rebuild and the
 * incremental delta (only the byte range differs). readAppended delivers RAW
 * text lines; each is JSON.parsed inside a per-row try/catch so a single
 * malformed row never aborts the fold (same discipline as the old
 * streamLedgerIntoIndex). Returns { rows, error }: `rows` counts every
 * delivered (i.e. parse-attempted) line; `error` is readAppended's error
 * string or null. Never reads past toCp.eof — torn tails and concurrent
 * appends beyond the pinned checkpoint are structurally out of range.
 */
function foldAppendedRows(ledgerPath, fromCp, toCp, byContentHash) {
  let rows = 0;
  const res = readAppended(ledgerPath, fromCp, toCp, (text) => {
    rows += 1;
    try {
      applyRow(byContentHash, JSON.parse(text));
    } catch {
      // Defensive: a single malformed row never aborts the fold.
    }
  });
  return { rows, error: res.error };
}

/** Advisory fingerprint fields derived from a pinned checkpoint. Kept for
 *  cache-payload / return-shape compatibility (diagnostics only — validity
 *  is decided by verifyPrefix on the checkpoint witness, never by these). */
function fpFromCheckpoint(cp) {
  return {
    ledger_mtime_ms: typeof cp.mtimeMs === "number" ? cp.mtimeMs : 0,
    ledger_size_bytes: Number.isInteger(cp.size) ? cp.size : 0,
  };
}

/** Serialize a Map<string, string> into a plain object for JSON. Map
 *  iteration order is insertion order, keeping the on-disk file deterministic
 *  for a given ledger. */
function serializeEntries(byContentHash) {
  const out = {};
  for (const [k, v] of byContentHash) out[k] = v;
  return out;
}

/**
 * Does `newCp` EXTEND `prevCp` — i.e. is prevCp.witness a VERBATIM prefix
 * (same off/len/hash, element by element, in array order) of newCp.witness?
 *
 * captureCheckpoint({prev}) produces exactly this shape when — and only
 * when — its internal verifyPrefix(prev) passed and the combined witness
 * stayed under the entry cap; every other outcome (prefix drift, shrink,
 * atomic replacement, io-error, witness-cap overflow) falls back to a FRESH
 * sample whose entries do not replay prev's. A non-extension is therefore
 * the caller-visible signal that newCp does NOT certify the cached prefix,
 * and folding a delta over the cached entries would be unsound (S1's
 * captureCheckpoint API is owned elsewhere, so the discontinuity check
 * lives caller-side).
 *
 * Trivially true when prevCp.witness is empty (the origin cursor, eof 0).
 * A true result implies newCp.eof >= prevCp.eof: prev's final witness entry
 * ends exactly at prevCp.eof and isValidCheckpoint bounds every entry of
 * newCp by off + len <= newCp.eof.
 */
function witnessExtends(prevCp, newCp) {
  const pw = prevCp.witness;
  const nw = newCp.witness;
  if (nw.length < pw.length) return false;
  for (let i = 0; i < pw.length; i++) {
    if (
      pw[i].off !== nw[i].off ||
      pw[i].len !== nw[i].len ||
      pw[i].hash !== nw[i].hash
    ) {
      return false;
    }
  }
  return true;
}

/** Deserialize the cache file's `entries` object back into a Map. */
function deserializeEntries(entries) {
  const map = new Map();
  if (entries == null || typeof entries !== "object") return map;
  for (const k of Object.keys(entries)) {
    const v = entries[k];
    if (typeof v === "string" && v.length > 0) map.set(k, v);
  }
  return map;
}

/**
 * Best-effort persist for loadOrRebuildContentIndex paths: a persist failure
 * must NOT discard the built in-memory index (deliberate improvement over the
 * v1 behavior, where a cache-write throw destroyed a successful rebuild).
 * Logs exactly one stderr line and returns. Direct persistContentIndex calls
 * keep their throwing contract.
 */
async function persistOrWarn(index, cachePath) {
  if (typeof cachePath !== "string" || cachePath.length === 0) return;
  try {
    await persistContentIndex(index, cachePath);
  } catch (err) {
    try {
      const msg = err && err.message ? err.message : String(err);
      process.stderr.write(
        `[content-index] cache persist failed (serving in-memory index): ${msg}\n`,
      );
    } catch {
      // stderr itself failing must never take down the index.
    }
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Rebuild the content index from the ledger. Optionally persist to the cache
 * file at `cachePath`.
 *
 * PIN-FIRST (W1): the checkpoint is captured BEFORE any read, and the fold
 * reads exactly [0, checkpoint.eof) — a row appended mid-rebuild is neither
 * indexed nor certified (it folds on the next incremental load), and a torn
 * trailing line is never consumed. This kills the v1 certify race
 * (stream-then-stat). Missing ledger -> empty index + emptyCheckpoint()
 * (cold-start behavior preserved).
 *
 * @param {object} opts
 * @param {string} opts.ledgerPath — absolute path to memory.jsonl
 * @param {string} [opts.cachePath] — when provided, the rebuilt index is
 *        persisted via persistContentIndex before this function returns
 *        (errors propagate, as in v1).
 * @param {function} [opts.__afterPinForTest] — TEST-ONLY hook, invoked after
 *        the checkpoint is pinned and before the [0, eof) fold (T9
 *        fold-error hygiene gate). Never wired in production.
 * @returns {Promise<{
 *   byContentHash: Map<string, string>,
 *   fp: { ledger_mtime_ms: number, ledger_size_bytes: number },
 *   built_at: string,
 *   checkpoint: object,
 *   stats: { mode: string, rows_parsed: number },
 * }>}
 */
export async function rebuildContentIndex({
  ledgerPath,
  cachePath,
  __afterPinForTest,
} = {}) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    throw new TypeError("rebuildContentIndex: ledgerPath required");
  }
  let byContentHash = new Map();
  let checkpoint = emptyCheckpoint();
  let rowsParsed = 0;

  // PIN FIRST, then read only [0, cp.eof). captureCheckpoint returns null for
  // a missing/unreadable ledger — the cold-start case: empty index, nothing
  // certified.
  const cp = captureCheckpoint(ledgerPath);
  if (typeof __afterPinForTest === "function") {
    __afterPinForTest();
  }
  if (cp !== null) {
    // Fold into a SCRATCH map, committed only on a clean fold. A non-null
    // error IS reachable between pin and read — "truncated" / "io-error" /
    // "torn-boundary" fire when the file shrinks or is rewritten in that
    // window — and exactly then the partially-folded entries describe a file
    // that no longer exists. Retaining them under emptyCheckpoint would let
    // the next incremental load re-fold [0, eof) WITHOUT evicting them
    // (applyRow never overwrites) and then persist them under a fully valid
    // checkpoint — permanent stale canonical ids. A failed fold keeps
    // NOTHING: empty index, nothing certified, next load reads from byte 0.
    const scratch = new Map();
    const { rows, error } = foldAppendedRows(
      ledgerPath,
      emptyCheckpoint(),
      cp,
      scratch,
    );
    rowsParsed = rows;
    if (error === null) {
      byContentHash = scratch;
      checkpoint = cp;
    }
  }

  const index = {
    byContentHash,
    fp: fpFromCheckpoint(checkpoint),
    built_at: new Date().toISOString(),
    checkpoint,
    stats: { mode: "full-rebuild", rows_parsed: rowsParsed },
  };
  if (typeof cachePath === "string" && cachePath.length > 0) {
    await persistContentIndex(index, cachePath);
  }
  return index;
}

/**
 * Load the content index from the cache file if its checkpoint still
 * certifies a byte-identical prefix of the ledger; fold ONLY the appended
 * delta rows on top; otherwise full-rebuild (and persist when a cachePath is
 * provided).
 *
 * Validity (W1, replaces the v1 exact mtime+size match): (a) the cache file
 * exists and parses as JSON, (b) schema_version === "v2", (c) the embedded
 * checkpoint deserializes, and (d) the new checkpoint is PINNED FIRST via
 * captureCheckpoint({prev: cachedCp}) — whose INTERNAL verifyPrefix is the
 * one O(witness) prefix verification per load (<= 128 x 64KiB reads, never
 * the whole ledger) — and the caller-side witness-extension check confirms
 * the pin actually extended the cached witness. Non-extension (shrink,
 * rewrite, atomic replacement, witness-cap fallback) is a checkpoint
 * discontinuity: full rebuild, never a hybrid of cached entries + new-file
 * delta. Then readAppended folds exactly [cached.eof, pinned.eof) — a row
 * landing after the pin is neither indexed nor certified and folds next
 * load. Any divergence → full rebuild. Missing ledger with the persisted
 * origin cursor (eof 0) is an exact hit — the cache file is not rewritten
 * on every cold tick.
 *
 * stats.mode: "cache-hit-exact" (zero delta; cache file NOT rewritten) |
 * "incremental" | "full-rebuild" | "cache-stale-capture-failed" (S1c:
 * present-but-unreadable ledger — cached index served read-only, no
 * persist, self-heals on the next readable tick). stats.rows_parsed counts
 * exactly the rows JSON-parse was attempted on. An incremental load whose
 * capture re-baselined a cap-overflowed witness (prefix verified inside
 * capture) additionally carries stats.reason === "witness-rebaselined".
 *
 * @param {object} opts
 * @param {string} opts.ledgerPath
 * @param {string} [opts.cachePath]
 * @param {function} [opts.__afterPinForTest] — TEST-ONLY hook, invoked after
 *        the new checkpoint is pinned and before the delta read (T5
 *        certify-race gate). Never wired in production.
 * @param {function} [opts.__beforeCaptureForTest] — TEST-ONLY hook, invoked
 *        after the cached checkpoint validates and before the new checkpoint
 *        is pinned (T8 discontinuity seam gate). Never wired in production.
 * @returns {Promise<{ byContentHash: Map<string,string>, fp, built_at,
 *   checkpoint, stats }>}
 */
export async function loadOrRebuildContentIndex({
  ledgerPath,
  cachePath,
  __afterPinForTest,
  __beforeCaptureForTest,
} = {}) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    throw new TypeError("loadOrRebuildContentIndex: ledgerPath required");
  }

  // Full-rebuild fallback shared by every fail-closed branch. Persist is
  // best-effort here (persistOrWarn): a cache-write failure serves the
  // in-memory index rather than throwing away a successful rebuild.
  const fullRebuild = async (reason) => {
    const index = await rebuildContentIndex({ ledgerPath });
    if (typeof reason === "string" && reason.length > 0) {
      index.stats.reason = reason;
    }
    await persistOrWarn(index, cachePath);
    return index;
  };

  if (
    !(typeof cachePath === "string" && cachePath.length > 0) ||
    !existsSync(cachePath)
  ) {
    return fullRebuild("no-cache");
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    // Corrupt cache → rebuild. The cache is a derived projection; never
    // block on it.
    return fullRebuild("cache-corrupt");
  }
  if (
    parsed == null ||
    parsed.schema_version !== CONTENT_INDEX_CAPS.SCHEMA_VERSION
  ) {
    // Legacy v1 (mtime+size, no checkpoint) or unknown schema: one full
    // rebuild migrates the cache to v2.
    return fullRebuild("schema-migration");
  }
  const cachedCp = deserializeCheckpoint(parsed.checkpoint);
  if (cachedCp === null) {
    return fullRebuild("invalid-checkpoint");
  }

  if (typeof __beforeCaptureForTest === "function") {
    __beforeCaptureForTest();
  }

  // PIN FIRST: capture the new checkpoint BEFORE reading any delta bytes.
  // Rows appended after this pin are beyond newCp.eof — neither indexed nor
  // certified this call; they fold exactly once on the next load.
  // captureCheckpoint({prev}) re-verifies the cached prefix INTERNALLY and
  // extends the cached witness verbatim iff it still holds — the single
  // O(witness) verification per load (W1b dropped the separate verifyPrefix
  // call that used to run here too, halving per-tick witness reads).
  const newCp = captureCheckpoint(ledgerPath, { prev: cachedCp });
  if (newCp === null) {
    if (existsSync(ledgerPath)) {
      // Present-but-unreadable ledger (EACCES / transient I/O fault): serve
      // the CACHED index READ-ONLY (fail-static, S1c). Rebuilding here would
      // also capture null — an EMPTY index clobbering a previously valid
      // populated cache, plus a fresh built_at rewriting the cache file on
      // EVERY 15s tick for as long as the fault lasts. Mirror the eof===0
      // exact-hit branch's no-rewrite discipline instead: no persist, cached
      // entries + cached checkpoint returned as-is. Recovery is automatic —
      // the next readable tick re-enters the normal capture path below.
      return {
        byContentHash: deserializeEntries(parsed.entries),
        fp: fpFromCheckpoint(cachedCp),
        built_at:
          typeof parsed.built_at === "string"
            ? parsed.built_at
            : new Date().toISOString(),
        checkpoint: cachedCp,
        stats: { mode: "cache-stale-capture-failed", rows_parsed: 0 },
      };
    }
    // Missing ledger. Cold-start special case: the persisted origin cursor
    // (eof 0) over a still-absent ledger is EXACT — serve the cached empty
    // index and do NOT rewrite the cache file every 15s tick.
    if (cachedCp.eof === 0) {
      return {
        byContentHash: deserializeEntries(parsed.entries),
        fp: fpFromCheckpoint(cachedCp),
        built_at:
          typeof parsed.built_at === "string"
            ? parsed.built_at
            : new Date().toISOString(),
        checkpoint: cachedCp,
        stats: { mode: "cache-hit-exact", rows_parsed: 0 },
      };
    }
    return fullRebuild("missing");
  }

  // Checkpoint-discontinuity gate (fail closed). The delta fold below is
  // sound ONLY if newCp certifies a file whose [0, cachedCp.eof) prefix is
  // byte-identical to the cached one. A ledger shrunk, rewritten, or
  // atomically REPLACED right before the pin makes captureCheckpoint fall
  // back to a fresh sample over the NEW file — folding its delta over the
  // OLD file's cached entries would persist a hybrid index under a fully
  // valid checkpoint, and it would never self-heal. Non-extension of the
  // cached witness is that signal — EXCEPT (S1c) when captureCheckpoint
  // itself marked the fresh sample prefix-certified-by-prev
  // (newCp.prefixVerified, non-enumerable): the cached prefix verified
  // byte-identical INSIDE the capture call and the resample is purely a
  // witness-cap-overflow artifact, so the delta fold stays sound and the
  // cache re-baselines under the fresh compacted witness instead of paying
  // a full multi-GB re-stream (~every ~63 gaining ticks under sustained
  // appends). Unverified fresh samples (T8: rewrite/replacement/shrink)
  // still fail closed into a full rebuild.
  let witnessRebaselined = false;
  if (!witnessExtends(cachedCp, newCp)) {
    if (newCp.prefixVerified !== true) {
      return fullRebuild("checkpoint-discontinuity");
    }
    witnessRebaselined = true;
  }
  if (typeof __afterPinForTest === "function") {
    __afterPinForTest();
  }

  if (newCp.eof === cachedCp.eof) {
    // Exact hit: zero delta rows. Return the cached index untouched and DO
    // NOT rewrite the cache file (an unchanged 15s tick must not churn a
    // multi-MB file).
    return {
      byContentHash: deserializeEntries(parsed.entries),
      fp: fpFromCheckpoint(cachedCp),
      built_at:
        typeof parsed.built_at === "string"
          ? parsed.built_at
          : new Date().toISOString(),
      checkpoint: cachedCp,
      stats: { mode: "cache-hit-exact", rows_parsed: 0 },
    };
  }

  // Incremental: fold exactly [cachedCp.eof, newCp.eof) through the same
  // applyRow fold as a full rebuild. Cached entries pre-populate the Map, so
  // EARLIEST-wins is preserved automatically (applyRow never overwrites).
  const byContentHash = deserializeEntries(parsed.entries);
  const sizeBefore = byContentHash.size;
  const { rows, error } = foldAppendedRows(
    ledgerPath,
    cachedCp,
    newCp,
    byContentHash,
  );
  if (error !== null) {
    // Fail closed: a delta we could not read cleanly is never certified.
    return fullRebuild(`delta-read-${error}`);
  }

  const index = {
    byContentHash,
    fp: fpFromCheckpoint(newCp),
    built_at: new Date().toISOString(),
    checkpoint: newCp,
    stats: { mode: "incremental", rows_parsed: rows },
  };
  if (witnessRebaselined) {
    index.stats.reason = "witness-rebaselined";
  }

  // Write policy: persist only when the fold gained unique entries, when the
  // un-persisted delta has grown past the byte cap (bounds re-parse work
  // across duplicate-only append runs without churning the file every tick),
  // or when the witness re-baselined (S1c: the compacted fresh witness must
  // land on disk, or every subsequent tick re-overflows and re-folds the
  // same delta).
  const gainedEntries = byContentHash.size > sizeBefore;
  const deltaBytes = newCp.eof - cachedCp.eof;
  if (gainedEntries || witnessRebaselined || deltaBytes > PERSIST_DELTA_BYTES_CAP) {
    await persistOrWarn(index, cachePath);
  }
  return index;
}

/**
 * Lookup the canonical (earliest) fact_id whose content matches `content`.
 * Returns null on a miss OR when content is empty (empty content never
 * dedups). Never throws on a miss.
 *
 * @param {{byContentHash: Map<string,string>}} index
 * @param {string} content
 * @returns {string|null}
 */
export function lookupCanonical(index, content) {
  if (index == null || !(index.byContentHash instanceof Map)) {
    throw new TypeError("lookupCanonical: index missing byContentHash Map");
  }
  const hash = contentHash(content);
  if (hash === null) return null;
  const id = index.byContentHash.get(hash);
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * In-memory registration of a just-promoted canonical fact. Used by the
 * daemon to fold a newly-promoted fact's content hash into the in-tick index
 * so 5 identical commits in one batch collapse to 1 PROMOTE + 4 CORROBORATEs
 * rather than 5 fact rows. EARLIEST-wins: if the hash is already present (a
 * prior canonical), this is a no-op. Does NOT touch the cache file.
 *
 * @param {{byContentHash: Map<string,string>}} index
 * @param {string} factId — the canonical fact id just promoted
 * @param {string} content — the promoted fact's content
 * @returns {void}
 */
export function addToContentIndex(index, factId, content) {
  if (index == null || !(index.byContentHash instanceof Map)) {
    throw new TypeError("addToContentIndex: index missing byContentHash Map");
  }
  if (typeof factId !== "string" || factId.length === 0) return;
  const hash = contentHash(content);
  if (hash === null) return; // empty content -> never dedup
  if (!index.byContentHash.has(hash)) {
    index.byContentHash.set(hash, factId);
  }
}

/**
 * Persist the index to a cache file at `cachePath`.
 *
 * Write discipline (mirrors entity-index.js persistIndex):
 *   - tmp file + rename so a torn write never replaces a good cache file
 *     (node:fs/promises, so the I/O is off the event loop; the
 *     JSON.stringify is the irreducible sync cost, bounded by
 *     unique-content cardinality, NOT ledger length).
 *   - mode 0o600 — operator-only readable.
 *
 * v2 payload: adds `checkpoint` (serialized ledger-checkpoint — the actual
 * validity carrier) and KEEPS `entries` as a plain {hash -> fact_id string}
 * object plus the advisory ledger_mtime_ms / ledger_size_bytes fields
 * (reembed-local-4096.mjs reads the file raw and Object.values() the
 * entries — that contract survives).
 *
 * Errors propagate to direct callers (unchanged from v1);
 * loadOrRebuildContentIndex wraps this in persistOrWarn.
 *
 * @param {{byContentHash: Map<string,string>, fp: object, built_at: string,
 *          checkpoint?: object}} index
 * @param {string} cachePath — absolute path to the cache file
 * @returns {Promise<void>}
 */
export async function persistContentIndex(index, cachePath) {
  if (index == null || !(index.byContentHash instanceof Map)) {
    throw new TypeError("persistContentIndex: index missing byContentHash Map");
  }
  if (typeof cachePath !== "string" || cachePath.length === 0) {
    throw new TypeError("persistContentIndex: cachePath required");
  }
  const fp = index.fp && typeof index.fp === "object" ? index.fp : {};
  const checkpoint =
    serializeCheckpoint(index.checkpoint) ?? serializeCheckpoint(emptyCheckpoint());
  const payload = {
    schema_version: CONTENT_INDEX_CAPS.SCHEMA_VERSION,
    content_index_version: CONTENT_INDEX_VERSION,
    // Advisory diagnostics only — validity lives in `checkpoint`.
    ledger_mtime_ms:
      typeof fp.ledger_mtime_ms === "number" ? fp.ledger_mtime_ms : 0,
    ledger_size_bytes:
      typeof fp.ledger_size_bytes === "number" ? fp.ledger_size_bytes : 0,
    checkpoint,
    entries: serializeEntries(index.byContentHash),
    built_at:
      typeof index.built_at === "string"
        ? index.built_at
        : new Date().toISOString(),
  };
  const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
  const bytes = JSON.stringify(payload);
  try {
    await writeFile(tmpPath, bytes, { mode: 0o600 });
    await rename(tmpPath, cachePath);
  } catch (err) {
    // Best-effort tmp cleanup (W1b): without it, a sustained cache-dir fault
    // leaks one full-cache-sized tmp file per attempt — one per 15s tick.
    // The original error still propagates unchanged (direct-call contract).
    try {
      await rm(tmpPath, { force: true });
    } catch {
      // Cleanup is best-effort only; the primary error is what matters.
    }
    throw err;
  }
}
