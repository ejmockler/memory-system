// ledger-offset-index.js — WU-recall-latency-fix.
//
// AUTHORITATIVE problem statement (measured grounding plan):
//   "dominant cost is ledger row resolution not hnsw load ... loadLedgerRowsByIds
//    at index-cache.js streams the 1.8 GB ledger per query 5.2s 83 percent."
//   recommended_fix: "index cache fix seek ledger rows by offset via sidecar not
//    full stream"; implementation: "rewrite loadLedgerRowsByIds to seek rows by
//    byte offset via a sidecar or tail merge mtime cache".
//
// WHAT THIS MODULE DOES:
//   Maintains a `memory_id -> { offset, len }` map ("the offset index") over the
//   APPEND-ONLY memory.jsonl ledger. With it, recall candidate resolution becomes
//   K random-access fs.read seeks (K = the few-hundred fused candidate ids)
//   instead of one full 1.8 GB stream. The plan's dominant cost (5.2s -> ~0)
//   collapses.
//
// WHY AN OFFSET SIDECAR IS SAFE (thesis #1 — never mutate fact rows; indices are
// derived, model-versioned projections):
//   - The ledger is strictly APPEND-ONLY: rows are written newline-terminated
//     and never rewritten in place, so a row's byte offset is STABLE for the life
//     of the file. New facts only append AFTER the current end-of-file.
//   - The offset index is a DERIVED projection of the ledger bytes. It is never
//     authoritative: every seek re-reads + re-parses the actual ledger bytes at
//     the recorded offset and is validated (the parsed row.id must equal the
//     wanted id) before use. A stale/wrong offset NEVER returns a wrong row — it
//     returns null for that id, and the caller's verification catches it.
//
// CACHE + TAIL-MERGE (the "tail merge mtime cache" in the plan):
//   - Module-scope cache keyed on the ledger's (size, mtimeMs).
//   - First build: ONE pass over the whole file recording every row's offset.
//     (This is the same single stream the old resolver did per-query — but now it
//     happens ONCE per process, amortized across all subsequent queries.)
//   - The daemon appends to the ledger every tick (the cascade is hot). On the
//     next recall the file is LARGER (size grew) but its existing-prefix bytes are
//     byte-identical (append-only). We TAIL-MERGE: re-scan ONLY the bytes from the
//     previously-indexed size to the new EOF, adding the new rows' offsets. No
//     full re-stream. Latest-write-wins: a later row for an id overwrites its
//     earlier offset (matches loadLedger's Map.set semantics).
//   - DEFENSIVE rebuild trigger: if the file SHRANK (size < indexed size) or its
//     mtime moved backward, the append-only invariant is violated (truncation /
//     rotation / restore-from-backup). We discard the cache and rebuild from 0.
//
// PERSISTENCE (sidecar on disk, optional):
//   buildOffsetIndex caches in-process; an optional on-disk sidecar
//   (`<ledger>.offsets`) lets a FRESH process skip the cold full-scan.
//   v3 (R2/WI2): the sidecar is a SECTIONED BINARY projection — a small JSON
//   header line (format, size, mtimeMs, count, ids_bytes, checkpoint), then
//   8-byte-aligned sections: the id string table (ids joined by "\n"),
//   a Float64 offsets array and a Uint32 lens array, one slot per id. The v2
//   NDJSON sidecar paid one JSON.parse per entry on every cold load — 990 ms
//   measured 2026-07-16 on the production 1.5M-entry sidecar vs ~600 ms for
//   v3 (the residual is the irreducible 1.5M-entry Map population). Writers:
//   the explicit writeOffsetSidecar() entrypoint (the Gate / a build script)
//   and — Q4 (memperf) — an OFF-CRITICAL-PATH scheduled write after a cold
//   full scan or a size-gated delta fold, so a fresh process actually finds a
//   sidecar. The scheduled write is fire-and-forget, never awaited on the
//   recall path, and never runs on an exact-eof hit. v3 sidecars embed an
//   S1 checkpoint that is re-verified FAIL-CLOSED on load before byId is
//   trusted; if absent/legacy(v1/v2)/drifted the cold path falls back to the
//   full scan — correctness is identical, only the cold latency differs — and
//   ONE full scan migrates a legacy sidecar to v3.
//
// DISCIPLINE: ESM, defensive try/catch around every fs op, Node stdlib only.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { open as openAsync, rename as renameAsync, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Buffer } from "node:buffer";
import {
  streamLedgerLinesWithOffset,
  readLedgerRowAtOffset,
} from "../synthesis/_ledger-stream.js";
// Q4 (memperf) — the v1 sidecar header carried only (size, mtimeMs), which the
// S1 defect list (ledger-checkpoint.js, items (a)/(b)) names explicitly: raw
// size as a resume cursor skips a torn final line forever, and size+mtime
// growth is NO prefix proof — an in-place rewrite that grows the file served a
// corrupt incremental. v2 embeds a serialized S1 checkpoint (newline-safe
// pinned EOF + sampled prefix-identity witness) in the header; on load the
// prefix is re-verified FAIL-CLOSED before byId is trusted, and the tail folds
// via readAppended between checkpoints.
import {
  captureCheckpoint,
  deserializeCheckpoint,
  emptyCheckpoint,
  readAppended,
  serializeCheckpoint,
} from "../synthesis/ledger-checkpoint.js";

// Sidecar format version. Bump if the section layout OR header shape changes.
// v2 (Q4): header gained `checkpoint`; a v1 sidecar (no prefix witness) is
// ignored entirely — one full scan migrates it.
// v3 (R2/WI2): sectioned binary body (id string table + Float64 offsets +
// Uint32 lens) replaces the per-entry NDJSON; v1/v2 sidecars are ignored
// entirely — one full scan migrates them.
const SIDECAR_FORMAT_VERSION = 3;
// Section alignment for the v3 binary body (Float64Array views need 8).
const SIDECAR_ALIGN = 8;
function _sidecarPad(n) {
  return (SIDECAR_ALIGN - (n % SIDECAR_ALIGN)) % SIDECAR_ALIGN;
}
// Size-gated sidecar rewrite on the cold delta-fold path: rewriting a ~50 MB
// projection for a 50-row delta is wasteful churn; deltas below the cap
// stay un-persisted (a fresh process re-folds at most this many bytes).
const SIDECAR_PERSIST_DELTA_BYTES_CAP = 32 * 1024 * 1024; // 32 MiB, frozen

// ---------------------------------------------------------------------------
// Module-scope cache.
//   { byId: Map<id, {offset,len}>, size, mtimeMs }
// Keyed implicitly by the resolved ledger path passed in (one ledger per
// process in production; tests pass their hermetic path).
// ---------------------------------------------------------------------------
const _cacheByPath = new Map(); // path -> { byId, size, mtimeMs }

// Test-only injection seam (null in production). buildOffsetIndex invokes this
// AFTER it captures the pre-scan stat but BEFORE the cache lookup/scan, so a
// test can deterministically interleave a concurrent daemon append into the
// exact window the warm grow-merge races on (that interleave is otherwise only
// reachable from inside the function). Mirrors the _resetOffsetCaches /
// _peekCachedIndex test-only export discipline; the setter lives below.
let _afterStatHookForTests = null;

function statOf(path) {
  try {
    const s = statSync(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

// Extract just the id off a raw NDJSON ledger line WITHOUT a full JSON.parse of
// the (potentially large) row. We look for the `"id":"..."` field. The ledger
// writer canonicalizes rows so "id" is reliably present; if the cheap scan
// misses we fall back to JSON.parse for that one line (correctness over speed).
//
// Returns the id string, or null if the line carries no string id.
const _ID_RE = /"id"\s*:\s*"((?:[^"\\]|\\.)*)"/;
export function _extractIdFromLine(line) {
  if (typeof line !== "string" || line.length === 0) return null;
  const m = _ID_RE.exec(line);
  if (m && typeof m[1] === "string" && m[1].length > 0) {
    // Unescape the minimal JSON string escapes we might have matched.
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      // fall through to the full-parse fallback
    }
  }
  try {
    const o = JSON.parse(line);
    return o && typeof o.id === "string" && o.id.length > 0 ? o.id : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sidecar path + persistence.
// ---------------------------------------------------------------------------
export function offsetSidecarPath(ledgerPath) {
  return `${ledgerPath}.offsets`;
}

// Load a persisted sidecar (v3 sectioned binary). Returns { byId, size,
// mtimeMs, checkpoint } where `checkpoint` is the deserialized S1 checkpoint
// the sidecar was built FOR (the validity carrier — size/mtimeMs are advisory
// diagnostics only), or null if the sidecar is absent/unreadable/malformed/
// legacy v1-v2 (no witness / NDJSON body → never trusted; one full scan
// migrates it). The whole file is read in one Buffer (~50 MB in production —
// transient; only the byId Map is retained) and the sections are decoded
// with ONE utf8 string-table split + two typed-array views instead of the v2
// per-entry JSON.parse.
function loadOffsetSidecar(ledgerPath) {
  const sidecar = offsetSidecarPath(ledgerPath);
  let buf;
  try {
    buf = readFileSync(sidecar);
  } catch {
    return null;
  }
  try {
    const nl = buf.indexOf(0x0a);
    if (nl <= 0) return null;
    let header;
    try {
      header = JSON.parse(buf.toString("utf8", 0, nl));
    } catch {
      return null;
    }
    const checkpoint =
      header != null ? deserializeCheckpoint(header.checkpoint) : null;
    if (
      !header ||
      header.format !== SIDECAR_FORMAT_VERSION ||
      typeof header.size !== "number" ||
      typeof header.mtimeMs !== "number" ||
      !Number.isSafeInteger(header.count) ||
      header.count < 0 ||
      !Number.isSafeInteger(header.ids_bytes) ||
      header.ids_bytes < 0 ||
      checkpoint === null
    ) {
      return null; // bad/legacy(v1-v2 NDJSON) header -> ignore sidecar entirely
    }
    const n = header.count;
    let off = nl + 1;
    off += _sidecarPad(off);
    if (off + header.ids_bytes > buf.length) return null;
    const ids =
      n > 0 ? buf.toString("utf8", off, off + header.ids_bytes).split("\n") : [];
    if (ids.length !== n) return null;
    off += header.ids_bytes;
    off += _sidecarPad(off);
    if (off + n * 8 > buf.length) return null;
    const offByte = buf.byteOffset + off;
    const offsets =
      offByte % 8 === 0
        ? new Float64Array(buf.buffer, offByte, n)
        : new Float64Array(buf.buffer.slice(offByte, offByte + n * 8));
    off += n * 8;
    off += _sidecarPad(off);
    if (off + n * 4 > buf.length) return null;
    const lenByte = buf.byteOffset + off;
    const lens =
      lenByte % 4 === 0
        ? new Uint32Array(buf.buffer, lenByte, n)
        : new Uint32Array(buf.buffer.slice(lenByte, lenByte + n * 4));
    const byId = new Map();
    for (let i = 0; i < n; i++) {
      const o = offsets[i];
      // A non-integer offset means a corrupt section — fail closed (the
      // caller falls back to the full scan). Per-row id verification in
      // seekLedgerRowsByIds remains the authoritative guard either way.
      if (!Number.isSafeInteger(o) || o < 0) return null;
      byId.set(ids[i], { offset: o, len: lens[i] });
    }
    return { byId, size: header.size, mtimeMs: header.mtimeMs, checkpoint };
  } catch {
    return null;
  }
}

// Pack the v3 sidecar body. Returns an ordered array of Buffers (header line,
// alignment pads, id table, offsets, lens) or null when the index cannot be
// represented (null checkpoint, or an id embedding "\n" — writing it would
// corrupt the string table; callers treat null as "write nothing", which is
// correct-but-slow: the next cold load full-scans).
function _packSidecarV3(byId, checkpoint, size, mtimeMs) {
  if (checkpoint == null) return null;
  const n = byId.size;
  const ids = new Array(n);
  const offsets = new Float64Array(n);
  const lens = new Uint32Array(n);
  let i = 0;
  for (const [id, ent] of byId.entries()) {
    if (typeof id !== "string" || id.indexOf("\n") !== -1) return null;
    ids[i] = id;
    offsets[i] = ent.offset;
    lens[i] = ent.len;
    i += 1;
  }
  const idsBuf = Buffer.from(ids.join("\n"), "utf8");
  const head = Buffer.from(
    JSON.stringify({
      format: SIDECAR_FORMAT_VERSION,
      size,
      mtimeMs,
      count: n,
      ids_bytes: idsBuf.length,
      checkpoint: serializeCheckpoint(checkpoint),
    }) + "\n",
    "utf8",
  );
  const parts = [head];
  let off = head.length;
  const push = (b) => {
    const p = _sidecarPad(off);
    if (p) {
      parts.push(Buffer.alloc(p));
      off += p;
    }
    parts.push(b);
    off += b.length;
  };
  push(idsBuf);
  push(Buffer.from(offsets.buffer, offsets.byteOffset, offsets.byteLength));
  push(Buffer.from(lens.buffer, lens.byteOffset, lens.byteLength));
  return parts;
}

/**
 * writeOffsetSidecar — persist the current in-memory offset index to disk
 * (atomic tmp+rename, fsync). Streams one {id,o,l} line per entry so a
 * multi-million-row index never materializes a whole-file JS string.
 *
 * Q4 v2: the checkpoint is captured (pinned) BEFORE the index build/merge, so
 * the header's checkpoint UNDERSTATES the byId coverage at worst (rows that
 * landed between pin and build are in byId AND inside the delta a cold loader
 * re-folds — Map.set latest-wins is idempotent, so re-folding them is exact).
 * Overstating — a checkpoint claiming rows byId lacks — is structurally
 * impossible this way. Returns -1 when no checkpoint can be captured (missing
 * or unreadable ledger): a v2 sidecar without a witness would be untrustable.
 *
 * Callers: the Gate / build script (scripts/build-ledger-offset-sidecar.mjs)
 * and Q4's off-critical-path cold write below. Returns the number of entries
 * written, or -1 on failure (never throws).
 */
export function writeOffsetSidecar(ledgerPath) {
  const checkpoint = captureCheckpoint(ledgerPath); // PIN FIRST
  if (checkpoint == null) return -1;
  const built = buildOffsetIndex(ledgerPath);
  if (built == null) return -1;
  return _writeSidecarSync(ledgerPath, built.byId, checkpoint, built.size, built.mtimeMs);
}

// Shared synchronous sidecar writer (atomic tmp+rename, fsync, 0600).
function _writeSidecarSync(ledgerPath, byId, checkpoint, size, mtimeMs) {
  const parts = _packSidecarV3(byId, checkpoint, size, mtimeMs);
  if (parts == null) return -1;
  const sidecar = offsetSidecarPath(ledgerPath);
  const dir = dirname(sidecar);
  try {
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* openSync below will surface the failure */
  }
  const tmp = `${sidecar}.tmp-${process.pid}-${Date.now()}`;
  let fd = -1;
  const written = byId.size;
  try {
    fd = openSync(tmp, "w", 0o600);
    for (const part of parts) _writeAll(fd, part);
    fsyncSync(fd);
  } catch {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      fd = -1;
    }
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return -1;
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  try {
    renameSync(tmp, sidecar);
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return -1;
  }
  return written;
}

// ---------------------------------------------------------------------------
// Q4 — off-critical-path sidecar writer.
// ---------------------------------------------------------------------------
// The re-scoped Q4 node sanctions writing the sidecar from the recall process
// AFTER a cold full scan or a delta fold (verified 2026-07-15: no sidecar
// exists next to ledgers/memory.jsonl, so every fresh process paid the full
// scan). The write is scheduled fire-and-forget (never awaited on the recall
// path), packs the v3 sections up front and writes them through a fs/promises
// FileHandle (the writes run on the libuv pool — the event loop stays
// responsive), and lands atomically via tmp+rename with mode 0600.
// Serializing the LIVE byId Map at write time is safe: Map.set latest-wins is
// idempotent, so entries beyond the pinned checkpoint only UNDERSTATE the
// checkpoint's claim (re-folded exactly on the next cold load). One write in
// flight per ledger path; errors swallowed.
const _pendingSidecarWrites = new Map(); // ledgerPath -> Promise

/** Await every in-flight scheduled sidecar write (tests + scripts). */
export async function _awaitPendingSidecarWrites() {
  while (_pendingSidecarWrites.size > 0) {
    await Promise.all([..._pendingSidecarWrites.values()]);
  }
}

async function _writeSidecarAsync(ledgerPath, byId, checkpoint, size, mtimeMs) {
  const parts = _packSidecarV3(byId, checkpoint, size, mtimeMs);
  if (parts == null) return;
  const sidecar = offsetSidecarPath(ledgerPath);
  const tmp = `${sidecar}.tmp-${process.pid}-${Date.now()}`;
  let fh = null;
  try {
    fh = await openAsync(tmp, "w", 0o600);
    for (const part of parts) await fh.write(part);
    await fh.sync();
    await fh.close();
    fh = null;
    await renameAsync(tmp, sidecar);
  } catch {
    // Best-effort: swallow and clean the tmp file; the in-memory index is
    // authoritative-enough (a fresh process falls back to a full scan).
    try {
      if (fh !== null) await fh.close();
    } catch {
      /* ignore */
    }
    try {
      await rm(tmp, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function _scheduleSidecarWrite(ledgerPath, byId, checkpoint, size, mtimeMs) {
  if (checkpoint == null) return;
  if (_pendingSidecarWrites.has(ledgerPath)) return; // one in flight per path
  const p = new Promise((resolve) => setImmediate(resolve))
    .then(() => _writeSidecarAsync(ledgerPath, byId, checkpoint, size, mtimeMs))
    .catch(() => {
      /* best-effort */
    })
    .finally(() => {
      _pendingSidecarWrites.delete(ledgerPath);
    });
  _pendingSidecarWrites.set(ledgerPath, p);
}

function _writeAll(fd, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  let off = 0;
  while (off < buf.length) {
    off += writeSync(fd, buf, off, buf.length - off);
  }
}

// ---------------------------------------------------------------------------
// Core: build / refresh the offset index.
// ---------------------------------------------------------------------------

// The ONE per-row absorb shared by every index-build path (in-process tail
// scan, checkpoint delta fold, full checkpoint fold) so all paths apply
// identical semantics: extract the id, record the row's offset+len,
// latest-write-wins (Map.set).
function _absorbLedgerLine(byId, line, offset, len) {
  const id = _extractIdFromLine(line);
  if (id == null) return false; // rows with no string id (some policy rows) skipped
  byId.set(id, { offset, len });
  return true;
}

// Scan [startOffset, EOF) recording each NEWLINE-TERMINATED row's offset into
// byId. Latest-write-wins (Map.set). Returns { scanned, safeOffset } where
// safeOffset is the byte position past the LAST TERMINATED line (or
// startOffset if none) — the only sound resume cursor.
//
// FIX CYCLE 2: this scan now honors streamLedgerLinesWithOffset's `terminated`
// flag. Before, a torn trailing row was absorbed (its id regex can match a
// fragment, recording a MID-ROW offset) and the caller recorded raw st.size as
// the resume cursor — the next grow resumed mid-row, so the completed row's
// offset was wrong-or-missing for the life of the process (every seek missed;
// S1 defect (a) re-introduced on the warm path). A torn tail is now never
// absorbed and never advances safeOffset, so it is re-read in full once its
// "\n" lands. A malformed-but-terminated line still advances safeOffset
// (permanent skip, matching the checkpoint fold's tolerance).
function _scanInto(byId, ledgerPath, startOffset) {
  let scanned = 0;
  let safeOffset = startOffset;
  streamLedgerLinesWithOffset(
    ledgerPath,
    (line, offset, len, terminated) => {
      if (terminated !== true) return; // torn tail: not durable yet
      if (_absorbLedgerLine(byId, line, offset, len)) scanned += 1;
      safeOffset = offset + len + 1; // +1 for the terminating "\n"
    },
    { startOffset },
  );
  return { scanned, safeOffset };
}

// Fold exactly the terminated rows in [fromCp.eof, toCp.eof) into byId via the
// SAME per-row absorb as the full scan. Returns readAppended's error (null on
// a clean, fully-accounted delta).
function _foldOffsetsBetween(byId, ledgerPath, fromCp, toCp) {
  const res = readAppended(ledgerPath, fromCp, toCp, (text, offset, len) => {
    _absorbLedgerLine(byId, text, offset, len);
  });
  return res.error;
}

/**
 * buildOffsetIndex — return a fresh-or-cached offset index for `ledgerPath`.
 *
 * @param {string} ledgerPath
 * @returns {{ byId: Map<string,{offset:number,len:number}>, size:number,
 *            mtimeMs:number } | null} — null only if the ledger is missing.
 *
 * Behavior:
 *   - cache HIT (size+mtimeMs unchanged): return cached index.
 *   - file GREW (append-only): TAIL-MERGE — scan only [cachedSize, newSize).
 *   - cache MISS / file SHRANK / mtime regressed: full rebuild (try sidecar
 *     first, then full scan).
 */
export function buildOffsetIndex(ledgerPath) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) return null;
  const st = statOf(ledgerPath);
  if (st == null) return null; // missing ledger -> caller falls back to stream

  // Test-only seam (null in production → one guarded branch, negligible cost):
  // fire AFTER the pre-scan stat (`st`) but BEFORE the cache lookup/scan so a
  // test can interleave a concurrent append into the warm grow-merge's race
  // window deterministically.
  if (_afterStatHookForTests) _afterStatHookForTests();

  // R2/WI3 (pin-after-scan mtime): `st.mtimeMs` was captured BEFORE the scan /
  // checkpoint pin below. A daemon append landing in between advances the
  // file's mtime past st.mtimeMs; pairing that stale pre-scan mtime with a
  // POST-scan size (safeOffset / cp.eof) yields an INCOHERENT (size, mtimeMs)
  // fingerprint. Recording mtime from a POST-scan stat keeps the pair
  // internally consistent so the next build takes an exact hit or a correct
  // growth/rebuild — never a spurious full rebuild. Hoisted here so BOTH the
  // warm growth branch and the cold branch share it (closure refs only
  // st / ledgerPath / statOf, all in scope at this point).
  const _postPinMtime = () => {
    const stNow = statOf(ledgerPath);
    return stNow != null ? stNow.mtimeMs : st.mtimeMs;
  };

  const cached = _cacheByPath.get(ledgerPath);
  if (cached != null) {
    if (cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      return cached; // exact hit
    }
    // Append-only growth: same prefix bytes, file got longer. Tail-merge.
    if (st.size > cached.size && st.mtimeMs >= cached.mtimeMs) {
      // FIX CYCLE 2: record the scan's SAFE offset (past the last terminated
      // line), never raw st.size — a torn tail stays un-indexed and is
      // re-read by the next grow once its "\n" lands. While the tail stays
      // torn, cached.size < st.size keeps routing here (cheap re-scan of the
      // torn fragment only). R2/WI3: pair that post-scan safeOffset with a
      // POST-scan mtime (_postPinMtime), never the pre-scan st.mtimeMs — an
      // append interleaved between the stat and the scan would otherwise leave
      // an incoherent (safeOffset, stale-mtime) fingerprint that forces a
      // spurious full rebuild on the next call instead of an exact hit.
      const { safeOffset } = _scanInto(cached.byId, ledgerPath, cached.size);
      cached.size = safeOffset;
      cached.mtimeMs = _postPinMtime();
      return cached;
    }
    // Otherwise the append-only invariant was violated (shrink / mtime
    // regression). Fall through to a full rebuild.
  }

  // Cold path (Q4, format v3 since R2/WI2): try the on-disk sidecar first (a fresh process can skip
  // the full scan) — but FAIL-CLOSED: the sidecar's embedded checkpoint must
  // re-verify as a byte-identical prefix of the CURRENT ledger before byId is
  // trusted. captureCheckpoint({prev}) runs that one O(witness) verification
  // internally; the S1c flags (extendedPrev / prefixVerified) are the caller-
  // visible soundness signal. The old v1 acceptance (sc.size <= st.size &&
  // sc.mtimeMs <= st.mtimeMs) had NO prefix witness at all — an in-place
  // rewrite that grew the file served a corrupt incremental (S1 defect (b)).
  // The tail then folds via readAppended between checkpoints, so a torn final
  // line is never absorbed from a stale cursor and never skipped (S1 defect
  // (a): the v1 path resumed from raw header.size).
  // R2/WI3 (stat-before-pin mirror): `st` above was captured BEFORE the
  // checkpoint pin below. A daemon append landing in between advances the
  // file's mtime past st.mtimeMs while the pinned eof becomes the recorded
  // size — the cached (size=cp.eof, STALE mtimeMs) pair then churns the warm
  // branches: the next call sees size equal but mtime "moved", which is
  // neither an exact hit nor growth, and falls into a spurious full rebuild.
  // Fix: record mtimeMs via the hoisted _postPinMtime() (a POST-pin stat) so
  // the pair is coherent — the helper is defined at the top of this function.
  let index = null;
  const sc = loadOffsetSidecar(ledgerPath);
  if (sc != null && sc.byId instanceof Map && sc.checkpoint != null) {
    const newCp = captureCheckpoint(ledgerPath, { prev: sc.checkpoint }); // PIN FIRST
    if (
      newCp !== null &&
      (newCp.extendedPrev === true || newCp.prefixVerified === true)
    ) {
      if (newCp.eof === sc.checkpoint.eof) {
        // Exact hit: zero delta, zero disk writes. size records the pinned
        // newline-safe eof so a torn tail (bytes [eof, st.size)) is re-read
        // by the next grow merge, never skipped.
        index = { byId: sc.byId, size: newCp.eof, mtimeMs: _postPinMtime() };
      } else {
        const err = _foldOffsetsBetween(sc.byId, ledgerPath, sc.checkpoint, newCp);
        if (err === null) {
          index = { byId: sc.byId, size: newCp.eof, mtimeMs: _postPinMtime() };
          // Off-critical-path rewrite, size-gated (see the writer above).
          if (newCp.eof - sc.checkpoint.eof > SIDECAR_PERSIST_DELTA_BYTES_CAP ||
              newCp.extendedPrev !== true) {
            _scheduleSidecarWrite(ledgerPath, sc.byId, newCp, newCp.eof, index.mtimeMs);
          }
        }
        // Fold error (shrink/rewrite between pin and read): fall through to
        // the full scan — never serve a partially-trusted projection.
      }
    }
    // Discontinuity / legacy sidecar / capture failure → full scan below
    // (correct, slow, and it re-persists a fresh v3 sidecar).
  }
  if (index == null) {
    // Full scan from byte 0 — pin-first checkpoint fold so the persisted
    // sidecar carries an exact-coverage witness; if no checkpoint can be
    // captured (unreadable / raced file) fall back to the tolerant legacy
    // stream and persist nothing.
    const byId = new Map();
    const cp = captureCheckpoint(ledgerPath);
    if (cp !== null && _foldOffsetsBetween(byId, ledgerPath, emptyCheckpoint(), cp) === null) {
      index = { byId, size: cp.eof, mtimeMs: _postPinMtime() };
      if (byId.size > 0 || cp.eof > 0) {
        _scheduleSidecarWrite(ledgerPath, byId, cp, cp.eof, index.mtimeMs);
      }
    } else {
      byId.clear();
      // FIX CYCLE 2: the tolerant fallback also records the SAFE offset — a
      // torn tail at cold-scan time must be re-read by the next grow, never
      // sealed under a raw-size cursor. Post-scan stat for the same mtime-
      // coherence reason as above.
      const { safeOffset } = _scanInto(byId, ledgerPath, 0);
      index = { byId, size: safeOffset, mtimeMs: _postPinMtime() };
    }
  }

  _cacheByPath.set(ledgerPath, index);
  return index;
}

// ---------------------------------------------------------------------------
// Core: resolve rows by id via byte-offset seeks.
// ---------------------------------------------------------------------------

/**
 * seekLedgerRowsByIds — resolve the wanted ids by SEEKING to each row's byte
 * offset (no full stream). This is the WU-recall-latency-fix replacement for the
 * full-ledger scan in the recall hot path.
 *
 * @param {string} ledgerPath
 * @param {Set<string>|string[]} idSet
 * @returns {{ byId: Map<string,object>, fp: string, hits:number, misses:number,
 *            indexed:boolean }}
 *
 * Returns indexed=false (and an EMPTY byId) when the offset index could not be
 * built (missing ledger). The caller (loadLedgerRowsByIds) treats that as a
 * signal to fall back to the legacy scoped stream so correctness is never at the
 * mercy of the index. Per-id VERIFICATION: every seeked row's parsed id must
 * equal the wanted id; a mismatch (stale offset) is a miss, never a wrong row.
 */
export function seekLedgerRowsByIds(ledgerPath, idSet) {
  const wanted =
    idSet instanceof Set
      ? idSet
      : new Set(Array.isArray(idSet) ? idSet : []);
  const index = buildOffsetIndex(ledgerPath);
  const st = statOf(ledgerPath);
  const fp = st ? `${st.mtimeMs}:${st.size}` : "missing";
  const byId = new Map();
  if (index == null) {
    return { byId, fp, hits: 0, misses: wanted.size, indexed: false };
  }
  if (wanted.size === 0) {
    return { byId, fp, hits: 0, misses: 0, indexed: true };
  }
  let hits = 0;
  let misses = 0;
  let fd = -1;
  try {
    fd = openSync(ledgerPath, "r");
  } catch {
    return { byId, fp, hits: 0, misses: wanted.size, indexed: false };
  }
  try {
    for (const id of wanted) {
      const ent = index.byId.get(id);
      if (ent == null) {
        misses += 1;
        continue;
      }
      const row = readLedgerRowAtOffset(fd, ent.offset);
      // VERIFICATION: the parsed row's id MUST equal the wanted id. A stale or
      // wrong offset yields a row whose id differs (or null) -> treat as a miss,
      // never return a wrong row. Thesis #1: the index is a derived projection;
      // the ledger bytes are authoritative and re-checked here.
      if (row == null || typeof row.id !== "string" || row.id !== id) {
        misses += 1;
        continue;
      }
      byId.set(id, row);
      hits += 1;
    }
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  return { byId, fp, hits, misses, indexed: true };
}

// Test-only reset hook (mirrors index-cache._resetCaches discipline).
export function _resetOffsetCaches() {
  _cacheByPath.clear();
}

// Test-only inspection hook.
export function _peekCachedIndex(ledgerPath) {
  return _cacheByPath.get(ledgerPath) || null;
}

// Test-only: install (or clear, with null) the after-stat interleave hook used
// to reproduce the warm grow-merge append race deterministically. Declared with
// the module state up top; see the _afterStatHookForTests comment there.
export function _setAfterStatHookForTests(fn) {
  _afterStatHookForTests = typeof fn === "function" ? fn : null;
}
