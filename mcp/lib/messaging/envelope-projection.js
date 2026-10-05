// envelope-projection.js — WORKUNIT C1: cache the PARSE, not the answer.
//
// PROBLEM. memory_catchup re-streamed EVERY source ledger from byte 0 on every
// call (~338MB across the registry; measured 0.7-1.1s warm, 2026-07-12). The
// answer must stay 100% query-time (THESIS #1: identity/persona/ranking are
// never persisted), but the PARSE of an append-only ledger's unchanged prefix
// is pure waste: only the appended bytes are new information.
//
// FIX. One projection file per source under <root>/storage/catchup-projection/
// <source-key>.json holding:
//   { schema_version, source_key, checkpoint, tail_complete, rows, stats }
// where `checkpoint` is a serialized S1 ledger checkpoint (newline-safe pinned
// EOF + sampled prefix-identity witness — lib/synthesis/ledger-checkpoint.js,
// REUSED, never reimplemented) and `rows` is the bounded raw-row tail of the
// ledger in the SAME shape the reader's in-memory ring holds, bounded by the
// reader's own LEDGER_RETAIN_CEILING (imported from the leaf ledger-retain.js
// — one constant, one owner). `tail_complete` is true iff `rows` covers the
// ledger from byte 0 (the ring never evicted) — the serve-equivalence
// certificate below needs it.
//
// SERVE PATH (tryServeSourceFromProjection), called per source inside
// loadSourcesFromLedgers BEFORE the full stream:
//   1. take the in-memory entry for this ledger, else read + strictly validate
//      the projection file (schema_version, checkpoint shape, rows all plain
//      objects) — ANY doubt returns null (fail-closed => full re-stream);
//   2. captureCheckpoint(ledger, { prev }) — the S1c contract runs verifyPrefix
//      on `prev` INSIDE the capture; only a checkpoint carrying the
//      extendedPrev/prefixVerified certificate is trusted. A rewrite, rotation,
//      truncation, or witness drift loses the certificate => null;
//   3. readAppended(prev -> cur): fold ONLY the appended rows. Any non-null
//      readAppended error ("truncated", "torn-boundary", ...) => null;
//   4. re-bound the stored tail (old rows ++ delta rows) through the SAME
//      makeLedgerRetainFold lambda the full stream uses (cutoff=null,
//      cap=LEDGER_RETAIN_CEILING — the parameter-INDEPENDENT tail; since/limit
//      are query-time and are never baked into the stored projection);
//   5. run the caller's query-time fold (cutoff, retainCap) over the tail, plus
//      the torn-tail parity read (below), and serve ONLY when the equivalence
//      certificate holds: the fold saw >= retainCap passing rows, OR the tail
//      is complete. Otherwise the full stream might legitimately surface older
//      rows the stored tail evicted — unprovable, so we fail closed to it.
//
// TORN-TAIL PARITY. The legacy full stream parses a trailing line with no "\n"
// (a writer mid-append) when it happens to be valid JSON. An S1 checkpoint
// deliberately never covers bytes past the last "\n", so the serve path
// re-reads the (tiny) uncovered byte range [eof, size) each call and folds a
// parseable value through the same lambda — WITHOUT ever storing it (the next
// checkpoint replays it exactly once when the "\n" lands). This keeps the
// projection path byte-identical to the full stream even mid-append.
//
// EQUIVALENCE CERTIFICATE (why step 5 is sound, with NO ordering assumption):
// the stored tail is the last-K-rows suffix of the ledger's parsed rows. The
// query fold retains the last `retainCap` rows that PASS the since-filter, in
// file order. If the fold over the suffix saw >= retainCap passing rows, the
// last retainCap passing rows of the WHOLE ledger all lie inside the suffix
// (anything earlier would have been evicted by the ring anyway) — identical
// result. If the tail is complete, the suffix IS the whole ledger. Every other
// case falls back to the full stream.
//
// WRITE DISCIPLINE (the ONLY writes this module performs):
//   - projection files under <root>/storage/catchup-projection/ exclusively;
//     source ledgers are opened O_RDONLY, always;
//   - atomic tmp+rename, mode 0600 (the conversation-index.js persist pattern);
//   - AFTER the rows were returned (setImmediate), best-effort (failures are
//     swallowed; the next call simply re-folds a slightly larger delta);
//   - size-gated: a re-persist is queued only when the un-persisted delta
//     crossed PERSIST_MIN_DELTA_BYTES (small appends ride on the previous
//     file's checkpoint), and a payload past PROJECTION_MAX_FILE_BYTES is
//     refused outright;
//   - NEVER from doubted bytes: the fallback path's rebuild does its own fresh
//     captureCheckpoint + readAppended(origin -> cur) pass, so what lands on
//     disk is exactly what a fresh checkpoint certifies.
//
// ABSTRACTION INVARIANT: ZERO platform-name tokens in this module. The source
// key is registry DATA (each adapter's self-declared id) threaded through as an
// opaque string; nothing here compares it against any literal. The N10 grep
// gate runs over this file explicitly (catchup-projection.test.mjs).
//
// HONEST LIMITATIONS:
//   - the S1 witness is sampled: a rewrite confined ENTIRELY to un-sampled
//     interior blocks passes verifyPrefix (documented S1 limitation; strictly
//     stronger than the size+mtime checks it replaced);
//   - the legacy stream caps line length in JS CHARS while the S1 delta reader
//     caps in BYTES: a single line between 8MiB bytes and 8Mi chars (heavily
//     multi-byte) diverges. Real rows are ~1-4KB; the equivalence gate over the
//     real ledgers arbitrates.

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  captureCheckpoint,
  readAppended,
  serializeCheckpoint,
  deserializeCheckpoint,
  emptyCheckpoint,
} from "../synthesis/ledger-checkpoint.js";

// The retain primitive, from the LEAF that owns it (ledger-retain.js imports
// nothing). This module used to import these two bindings back from catchup.js
// while catchup.js imported this module — a cycle that resolved only because
// both files happened to dereference the other's bindings inside function
// bodies, never at module eval. That was a convention, not a guarantee: one
// module-scope dereference would have become a load-order-dependent TDZ
// ReferenceError. The edge now points DOWN, the messaging graph is a strict
// DAG, and every load order resolves by construction — see
// test/messaging/no-static-import-cycles.test.mjs.
import { LEDGER_RETAIN_CEILING, makeLedgerRetainFold } from "./ledger-retain.js";

// ---------------------------------------------------------------------------
// Constants (single producer; the ring bound itself is IMPORTED, not owned).
// ---------------------------------------------------------------------------

/** Projection file schema version. Any mismatch => discard + full re-stream. */
export const PROJECTION_SCHEMA_VERSION = 1;

// Re-persist only after this many un-persisted appended bytes accumulated —
// small appends keep riding the previous file's checkpoint (the serve path
// re-folds them from the delta each call, which is cheap by construction).
const PERSIST_MIN_DELTA_BYTES = 4 * 1024 * 1024;

// Refuse to write a projection payload past this size (sanity valve; at the
// LEDGER_RETAIN_CEILING row bound real tails sit far below it).
const PROJECTION_MAX_FILE_BYTES = 512 * 1024 * 1024;

// Torn-tail parity read cap — mirrors the streams' 8 MiB per-line cap.
const TORN_TAIL_MAX_BYTES = 8 * 1024 * 1024;

// In-memory entries are per-ledger-path; a long-lived process cycling many
// temp roots (the test suites) must not grow without bound.
const MEM_CACHE_MAX_SOURCES = 32;

// ---------------------------------------------------------------------------
// Module state: the in-memory tier (a cache OF the projection, revalidated
// against the ledger via the SAME checkpoint certificate on every serve — it
// can never serve bytes the current file does not witness), plus scheduling
// and diagnostics state.
// ---------------------------------------------------------------------------

const _memCache = new Map(); // ledgerAbsPath -> entry
const _pending = new Set(); // in-flight scheduled tasks (persists + rebuilds)
const _persistQueued = new Set(); // ledgerAbsPath with a persist queued
const _rebuildQueued = new Set(); // ledgerAbsPath with a rebuild queued
const _serveModes = new Map(); // sourceKey -> { mode, reason, cache, delta_rows }
const _rebuildResults = new Map(); // sourceKey -> { ok, reason }

function isPlainObjectValue(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function recordServe(sourceKey, mode, reason, extra = null) {
  _serveModes.set(sourceKey, {
    mode,
    reason: reason ?? null,
    cache: extra && extra.cache ? extra.cache : null,
    delta_rows: extra && Number.isInteger(extra.delta_rows) ? extra.delta_rows : null,
  });
}

function memCacheSet(key, entry) {
  if (_memCache.has(key)) _memCache.delete(key);
  _memCache.set(key, entry);
  while (_memCache.size > MEM_CACHE_MAX_SOURCES) {
    const oldest = _memCache.keys().next().value;
    _memCache.delete(oldest);
  }
}

function _schedule(task) {
  let release;
  const marker = new Promise((resolve) => {
    release = resolve;
  });
  _pending.add(marker);
  setImmediate(() => {
    try {
      task();
    } catch {
      // best-effort by contract: a projection write failure must never surface
    } finally {
      _pending.delete(marker);
      release();
    }
  });
}

// ---------------------------------------------------------------------------
// Paths + disk I/O
// ---------------------------------------------------------------------------

/**
 * projectionFilePath — <root>/storage/catchup-projection/<source-key>.json.
 * The source key is registry DATA; a key that is not a plain path-safe token
 * yields null (defensive — never a thrown path traversal).
 */
export function projectionFilePath(root, sourceKey) {
  if (typeof root !== "string" || root.length === 0) return null;
  if (typeof sourceKey !== "string" || sourceKey.length === 0) return null;
  if (/[/\\]|\.\./.test(sourceKey)) return null;
  return join(root, "storage", "catchup-projection", `${sourceKey}.json`);
}

/**
 * Strictly read + validate a projection file into a fresh in-memory entry.
 * ANY doubt — unreadable, unparseable, wrong schema_version, invalid
 * checkpoint, rows not an array of plain objects, rows over the ring bound —
 * returns null (the caller then full-streams). Never throws.
 */
function readProjectionFromDisk(root, sourceKey) {
  const p = projectionFilePath(root, sourceKey);
  if (p === null) return null;
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObjectValue(parsed)) return null;
  if (parsed.schema_version !== PROJECTION_SCHEMA_VERSION) return null;
  if (parsed.source_key !== sourceKey) return null;
  const checkpoint = deserializeCheckpoint(parsed.checkpoint);
  if (checkpoint === null) return null;
  const rows = parsed.rows;
  if (!Array.isArray(rows)) return null;
  if (rows.length > LEDGER_RETAIN_CEILING) return null;
  for (const r of rows) {
    if (!isPlainObjectValue(r)) return null;
  }
  return {
    root,
    sourceKey,
    checkpoint,
    rows,
    tailComplete: parsed.tail_complete === true,
    unpersistedDeltaBytes: 0,
    persisted: true,
  };
}

/**
 * Persist an entry atomically (tmp + rename, mode 0600) under the entry's own
 * root. Size-gated. Marks the entry persisted on success. Never throws.
 */
function persistProjectionEntry(entry) {
  const p = projectionFilePath(entry.root, entry.sourceKey);
  if (p === null) return { ok: false, reason: "bad-source-key" };
  const payload = {
    schema_version: PROJECTION_SCHEMA_VERSION,
    source_key: entry.sourceKey,
    checkpoint: entry.checkpoint,
    tail_complete: entry.tailComplete === true,
    rows: entry.rows,
    stats: {
      row_count: entry.rows.length,
      ledger_eof: entry.checkpoint.eof,
      tail_complete: entry.tailComplete === true,
      built_at: new Date().toISOString(),
    },
  };
  let bytes;
  try {
    bytes = JSON.stringify(payload);
  } catch {
    return { ok: false, reason: "serialize-failed" };
  }
  if (bytes.length > PROJECTION_MAX_FILE_BYTES) {
    return { ok: false, reason: "size-gate" };
  }
  const tmpPath = `${p}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(tmpPath, bytes, { mode: 0o600 });
    renameSync(tmpPath, p);
  } catch {
    return { ok: false, reason: "write-failed" };
  }
  entry.persisted = true;
  entry.unpersistedDeltaBytes = 0;
  return { ok: true, reason: null };
}

function maybeSchedulePersist(ledgerAbsPath, entry) {
  const due =
    entry.persisted !== true || entry.unpersistedDeltaBytes >= PERSIST_MIN_DELTA_BYTES;
  if (!due) return;
  if (_persistQueued.has(ledgerAbsPath)) return;
  _persistQueued.add(ledgerAbsPath);
  _schedule(() => {
    _persistQueued.delete(ledgerAbsPath);
    const cur = _memCache.get(ledgerAbsPath);
    if (cur) persistProjectionEntry(cur);
  });
}

// ---------------------------------------------------------------------------
// Torn-tail parity read (see module header).
// ---------------------------------------------------------------------------

/**
 * Read the uncovered byte range [eof, size) — a trailing line with no "\n" at
 * checkpoint time — and JSON-parse it. Returns the parsed value, or undefined
 * on any doubt (unreadable, short read, a "\n" appeared inside the range —
 * meaning the file moved under us — or unparseable bytes). `undefined` is a
 * safe sentinel: JSON can never parse to it. Never throws.
 */
function readTornTailValue(path, eof, size) {
  const len = size - eof;
  if (!Number.isInteger(len) || len <= 0 || len > TORN_TAIL_MAX_BYTES) return undefined;
  let fd = -1;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      let n;
      try {
        n = readSync(fd, buf, got, len - got, eof + got);
      } catch {
        return undefined;
      }
      if (n === 0) return undefined;
      got += n;
    }
    if (buf.includes(0x0a)) return undefined;
    try {
      return JSON.parse(buf.toString("utf8"));
    } catch {
      return undefined;
    }
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The serve path.
// ---------------------------------------------------------------------------

/**
 * tryServeSourceFromProjection — serve one source's bounded raw-row window
 * from (verified projection + delta fold), or return null to make the caller
 * full-stream (fail-closed on ANY doubt; see module header for the exact
 * fallback taxonomy, recorded per source for the harnesses).
 *
 * @param {object} args
 * @param {string} args.root — the memory root (projection files live under it).
 * @param {string} args.sourceKey — the registry key (opaque DATA).
 * @param {string} args.ledgerAbsPath — absolute source-ledger path (O_RDONLY).
 * @param {number|null} args.cutoff — the caller's since-window floor (epoch ms).
 * @param {number} args.retainCap — the caller's ring capacity for this query.
 * @returns {object[]|null} rows in chronological order, or null => full stream.
 */
export function tryServeSourceFromProjection({
  root,
  sourceKey,
  ledgerAbsPath,
  cutoff = null,
  retainCap,
} = {}) {
  if (typeof ledgerAbsPath !== "string" || ledgerAbsPath.length === 0) return null;
  if (typeof sourceKey !== "string" || sourceKey.length === 0) return null;
  if (!Number.isInteger(retainCap) || retainCap <= 0) return null;

  let entry = _memCache.get(ledgerAbsPath) || null;
  let cacheTier = entry !== null ? "memory" : null;
  if (entry === null) {
    entry = readProjectionFromDisk(root, sourceKey);
    if (entry !== null) cacheTier = "disk";
  }
  if (entry === null) {
    recordServe(sourceKey, "full-stream", "no-projection");
    return null;
  }

  // S1c certificate: captureCheckpoint verifies `prev` as a byte-identical
  // prefix INSIDE this capture (extendedPrev / prefixVerified). No certificate
  // — rewrite, rotation, shrink, witness drift, capture failure — no serve.
  const prevCp = entry.checkpoint;
  const cur = captureCheckpoint(ledgerAbsPath, { prev: prevCp });
  if (cur === null || (cur.extendedPrev !== true && cur.prefixVerified !== true)) {
    _memCache.delete(ledgerAbsPath);
    recordServe(sourceKey, "full-stream", "checkpoint-unverified");
    return null;
  }

  // Delta fold: ONLY the appended, newline-terminated bytes. Parse tolerance
  // mirrors the full stream (an unparseable line is skipped, never fatal);
  // any file-level anomaly is a non-null error and we fail closed.
  const deltaRows = [];
  if (cur.eof > prevCp.eof) {
    const r = readAppended(ledgerAbsPath, prevCp, cur, (line) => {
      try {
        deltaRows.push(JSON.parse(line));
      } catch {
        // skipped — same tolerance as the full stream
      }
    });
    if (r.error !== null) {
      _memCache.delete(ledgerAbsPath);
      recordServe(sourceKey, "full-stream", `delta-${r.error}`);
      return null;
    }
  }

  // Re-bound the parameter-independent stored tail through the SAME fold
  // lambda the full stream uses (cutoff=null: since/limit stay query-time).
  let rows = entry.rows;
  let tailComplete = entry.tailComplete === true;
  if (deltaRows.length > 0) {
    const stored = makeLedgerRetainFold(null, LEDGER_RETAIN_CEILING);
    for (const row of rows) stored.push(row);
    for (const row of deltaRows) stored.push(row);
    rows = stored.rows();
    tailComplete = tailComplete && !stored.wrapped();
  }

  // Query-time fold (the caller's cutoff/retainCap) + torn-tail parity.
  const serve = makeLedgerRetainFold(cutoff, retainCap);
  for (const row of rows) serve.push(row);
  if (cur.size > cur.eof) {
    const torn = readTornTailValue(ledgerAbsPath, cur.eof, cur.size);
    if (torn !== undefined) serve.push(torn);
  }

  // Serve-equivalence certificate (module header). Unprovable => full stream.
  // The projection itself is still valid for other windows — keep it cached.
  if (serve.count() < retainCap && tailComplete !== true) {
    recordServe(sourceKey, "full-stream", "window-insufficient");
    return null;
  }

  const nextCp = serializeCheckpoint(cur);
  if (nextCp === null) {
    _memCache.delete(ledgerAbsPath);
    recordServe(sourceKey, "full-stream", "checkpoint-invalid");
    return null;
  }
  const next = {
    root,
    sourceKey,
    checkpoint: nextCp,
    rows,
    tailComplete,
    unpersistedDeltaBytes:
      (Number.isInteger(entry.unpersistedDeltaBytes) ? entry.unpersistedDeltaBytes : 0) +
      (cur.eof - prevCp.eof),
    persisted: entry.persisted === true,
  };
  memCacheSet(ledgerAbsPath, next);
  maybeSchedulePersist(ledgerAbsPath, next);
  recordServe(sourceKey, "projection", null, {
    cache: cacheTier,
    delta_rows: deltaRows.length,
  });
  return serve.rows();
}

// ---------------------------------------------------------------------------
// The rebuild path (after a full-stream serve; also the harness prebuild).
// ---------------------------------------------------------------------------

/**
 * rebuildProjectionForSource — synchronously rebuild one source's projection
 * from a FRESH checkpointed read (captureCheckpoint + readAppended over the
 * whole certified prefix [0, eof)), seed the in-memory tier, and persist.
 * Best-effort: every failure is a typed { ok:false, reason } — never a throw,
 * never a partial file (atomic rename). Source ledger opened O_RDONLY only.
 */
export function rebuildProjectionForSource({ root, sourceKey, ledgerAbsPath } = {}) {
  if (typeof ledgerAbsPath !== "string" || ledgerAbsPath.length === 0) {
    return { ok: false, reason: "bad-args" };
  }
  if (typeof sourceKey !== "string" || sourceKey.length === 0) {
    return { ok: false, reason: "bad-args" };
  }
  const cp = captureCheckpoint(ledgerAbsPath);
  if (cp === null) {
    _rebuildResults.set(sourceKey, { ok: false, reason: "capture-failed" });
    return { ok: false, reason: "capture-failed" };
  }
  const fold = makeLedgerRetainFold(null, LEDGER_RETAIN_CEILING);
  const r = readAppended(ledgerAbsPath, emptyCheckpoint(), cp, (line) => {
    try {
      fold.push(JSON.parse(line));
    } catch {
      // skipped — same tolerance as the full stream
    }
  });
  if (r.error !== null) {
    _rebuildResults.set(sourceKey, { ok: false, reason: `read-${r.error}` });
    return { ok: false, reason: `read-${r.error}` };
  }
  const cpSer = serializeCheckpoint(cp);
  if (cpSer === null) {
    _rebuildResults.set(sourceKey, { ok: false, reason: "checkpoint-invalid" });
    return { ok: false, reason: "checkpoint-invalid" };
  }
  const entry = {
    root,
    sourceKey,
    checkpoint: cpSer,
    rows: fold.rows(),
    tailComplete: !fold.wrapped(),
    unpersistedDeltaBytes: 0,
    persisted: false,
  };
  memCacheSet(ledgerAbsPath, entry);
  const w = persistProjectionEntry(entry);
  const res = { ok: w.ok, reason: w.reason };
  _rebuildResults.set(sourceKey, res);
  return res;
}

/**
 * scheduleProjectionRebuild — queue rebuildProjectionForSource off the critical
 * path (setImmediate), deduped per ledger path so a burst of calls costs one
 * rebuild. Best-effort; never throws.
 */
export function scheduleProjectionRebuild({ root, sourceKey, ledgerAbsPath } = {}) {
  if (typeof ledgerAbsPath !== "string" || ledgerAbsPath.length === 0) return;
  if (_rebuildQueued.has(ledgerAbsPath)) return;
  _rebuildQueued.add(ledgerAbsPath);
  _schedule(() => {
    _rebuildQueued.delete(ledgerAbsPath);
    rebuildProjectionForSource({ root, sourceKey, ledgerAbsPath });
  });
}

// ---------------------------------------------------------------------------
// Test/harness seams (no production caller).
// ---------------------------------------------------------------------------

/** Await every scheduled rebuild/persist currently in flight. */
export async function _awaitPendingProjectionPersists() {
  while (_pending.size > 0) {
    await Promise.all([..._pending]);
  }
}

/** Drop the in-memory tier + diagnostics (forces the disk-or-stream path). */
export function _clearProjectionMemoryCacheForTests() {
  _memCache.clear();
  _serveModes.clear();
  _rebuildResults.clear();
}

/** Last serve mode per source key + last rebuild results (diagnostics). */
export function _peekProjectionDiagnosticsForTests() {
  return {
    serves: Object.fromEntries(_serveModes),
    rebuilds: Object.fromEntries(_rebuildResults),
  };
}

/** Shape summary of the in-memory entry for one ledger path (or null). */
export function _peekProjectionMemEntryForTests(ledgerAbsPath) {
  const e = _memCache.get(ledgerAbsPath);
  if (!e) return null;
  return {
    source_key: e.sourceKey,
    row_count: e.rows.length,
    tail_complete: e.tailComplete === true,
    checkpoint_eof: e.checkpoint.eof,
    unpersisted_delta_bytes: e.unpersistedDeltaBytes,
    persisted: e.persisted === true,
  };
}
