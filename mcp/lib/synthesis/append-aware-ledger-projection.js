// append-aware-ledger-projection.js — WU-incrementalize-recall-recomputes.
//
// PROBLEM (measured grounding plan):
//   Three recall warm-path projections each recompute the FULL 1.82 GB /
//   1.46 M-row ledger on every query because their cache keys invalidate on
//   every daemon append (mtime + size both move each tick):
//
//     - derivation-graph  loadOrRebuildDerivationGraph (~5.2 s warm)
//     - backfill overlay  buildLatestBackfillMap        (~4.5 s warm)
//     - entity-index      loadOrRebuildIndex            (153 s cold)
//
//   The daemon appends to memory.jsonl every tick; the existing disk-cache key
//   (ledger_mtime_ms) misses on every production query, so each projection
//   falls through to a full streamLedgerLines scan of the whole ledger.
//
// FIX (this module): the SAME append-aware tail-merge already shipped in
//   mcp/lib/recall/ledger-offset-index.js (buildOffsetIndex, lines 339-386),
//   extracted into ONE audited helper so all three projections share a single
//   tail-merge rather than three copies. Module-scope cache keyed on the ledger
//   path holding { struct, safeOffset, size, mtimeMs } with three branches:
//
//     (1) EXACT HIT      (size + mtimeMs unchanged)            -> return struct
//     (2) APPEND GROWTH  (st.size > size && st.mtimeMs >= mtimeMs)
//                        -> stream ONLY [safeOffset .. EOF) and replay the
//                           appended rows through the per-projection merge.
//     (3) SHRINK / mtime-regression / cold -> FULL rebuild from byte 0.
//
// WHY THIS IS CORRECT (the tail-merge must be byte-identical to a full rebuild):
//   - The ledger is strictly APPEND-ONLY: existing-prefix bytes never change,
//     so replaying ONLY the appended tail into the cached struct yields exactly
//     what a fresh full scan over the whole file would (the prefix rows were
//     already applied on the previous pass; latest-wins / set-add merges are
//     order-preserving because the tail rows are visited in ledger order after
//     the prefix rows).
//   - TORN FINAL LINE: the daemon may be mid-append when we stat the file, so
//     the last bytes can be a half-written row with no terminating "\n". We
//     track `safeOffset` = the byte position PAST the last newline-terminated
//     line, and ALWAYS resume the next grow-merge from `safeOffset`, never from
//     the raw EOF `size`. A torn trailing line is therefore NEVER applied (it
//     is not newline-terminated) and is re-read in full once its "\n" lands.
//     No row is ever applied twice (safeOffset only advances past terminated
//     lines; torn lines never advance it).
//   - SHRINK / mtime REGRESSION (truncation / rotation / restore-from-backup)
//     violates the append-only invariant -> we discard the cache and rebuild
//     from 0. This guards against a compaction ever serving a corrupt
//     incremental projection.
//
// DISCIPLINE: ESM, defensive try/catch around every fs op, Node stdlib only.
// THESIS #1: fact rows are never mutated; this projection is a derived,
// in-memory tail-merged cache rebuilt from the ledger bytes at any time.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { Buffer } from "node:buffer";
import { streamLedgerLinesWithOffset } from "./_ledger-stream.js";

// PREFIX-DRIFT GUARD — size+mtime growing is NECESSARY but not SUFFICIENT to
// prove append-only. An in-place rewrite (a test fixture re-seed, or a
// log-compaction that happens to grow the file) can grow size AND bump mtime
// while CHANGING the prefix bytes the cache already applied. Before trusting a
// grow tail-merge we re-read a small "boundary guard" window of bytes ending
// exactly at the cached safe offset and compare it to the window captured at
// build time. If the prefix bytes drifted, the append-only invariant is broken
// and we FULL-rebuild. This makes the incremental SELF-VERIFYING (mirroring how
// the offset-index re-reads + verifies each seeked row) so correctness never
// depends on a caller wiring a cache-reset hook.
const BOUNDARY_GUARD_BYTES = 256;

// Module-scope cache. One entry per (resolved ledger path, namespace) — the
// namespace separates the three projections so a single test that drives all
// three over the same hermetic ledger does not collide.
//   key -> { struct, safeOffset, size, mtimeMs, guard }
//   guard: { offset, hex } — the bytes [offset, safeOffset) at build time.
const _cache = new Map();

function _cacheKey(namespace, ledgerPath) {
  return `${namespace}\x00${ledgerPath}`;
}

/**
 * FIX CYCLE 2 — unwrap a fullRebuild result. The wrapped shape
 * `{ struct, resumeOffset }` lets a checkpoint-seeded rebuild report its EXACT
 * byte coverage (cp.eof) so the helper never records a resume offset past the
 * last row the rebuild actually applied. A bare struct (legacy shape — none of
 * the known bare structs carry a `struct` key) yields `resumeOffset: null`,
 * which the cold branch maps to raw st.size (the historical behavior).
 */
function _unwrapRebuildResult(res) {
  if (
    res != null &&
    typeof res === "object" &&
    !(res instanceof Map) &&
    Object.prototype.hasOwnProperty.call(res, "struct")
  ) {
    const off = res.resumeOffset;
    return {
      struct: res.struct,
      resumeOffset: Number.isSafeInteger(off) && off >= 0 ? off : null,
    };
  }
  return { struct: res, resumeOffset: null };
}

function _statOf(ledgerPath) {
  try {
    const s = statSync(ledgerPath);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Read the boundary-guard window: up to BOUNDARY_GUARD_BYTES bytes ENDING at
 * `endOffset` (the trailing bytes of the already-applied prefix). Returns
 * `{ offset, hex }` (offset = window start; hex = bytes as hex), or null on any
 * failure / short read. An empty prefix (endOffset<=0) returns an empty window
 * that always verifies. Never throws.
 */
function _readBoundaryGuard(ledgerPath, endOffset) {
  if (!Number.isInteger(endOffset) || endOffset <= 0) {
    return { offset: 0, hex: "" };
  }
  const start = Math.max(0, endOffset - BOUNDARY_GUARD_BYTES);
  const len = endOffset - start;
  if (len <= 0) return { offset: start, hex: "" };
  let fd = -1;
  try {
    fd = openSync(ledgerPath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      let n;
      try {
        n = readSync(fd, buf, got, len - got, start + got);
      } catch {
        return null;
      }
      if (n <= 0) break;
      got += n;
    }
    if (got < len) return null; // file shorter than expected -> treat as drift
    return { offset: start, hex: buf.toString("hex") };
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * True iff the cached boundary guard still matches the ledger bytes — i.e. the
 * bytes [guard.offset, safeOffset) are byte-identical to what was captured at
 * build time. A mismatch (or any read failure) means the applied prefix drifted
 * and the caller MUST full-rebuild.
 */
function _boundaryGuardHolds(ledgerPath, cached) {
  if (cached == null || cached.guard == null) return false;
  const now = _readBoundaryGuard(ledgerPath, cached.safeOffset);
  if (now == null) return false;
  return now.offset === cached.guard.offset && now.hex === cached.guard.hex;
}

/**
 * Scan [startOffset, EOF) of the ledger, replaying each NEWLINE-TERMINATED row
 * through `applyParsedRow(struct, row)`. Returns the SAFE resume offset — the
 * byte position past the last newline-terminated line we saw (or `startOffset`
 * if none) — so a torn trailing line is excluded and re-read next time.
 *
 * A torn trailing line (terminated === false) is NOT applied and does NOT
 * advance the safe offset.
 */
function _scanTailInto(struct, ledgerPath, startOffset, applyParsedRow) {
  let safeOffset = startOffset;
  streamLedgerLinesWithOffset(
    ledgerPath,
    (line, offset, len, terminated) => {
      // Only newline-terminated lines are durable rows. Skip a torn tail.
      if (terminated !== true) return;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        // A malformed-but-terminated line is a permanent skip (matches the
        // streamLedgerLines tolerance the full rebuild uses); still advance
        // the safe offset past it so we don't re-read it forever.
        safeOffset = offset + len + 1; // +1 for the consumed "\n"
        return;
      }
      try {
        applyParsedRow(struct, row);
      } catch {
        // Defensive: a single bad row never aborts the merge.
      }
      safeOffset = offset + len + 1; // +1 for the terminating "\n"
    },
    { startOffset },
  );
  return safeOffset;
}

/**
 * appendAwareLedgerProjection — return a fresh-or-tail-merged projection over
 * the append-only ledger, recomputing ONLY the appended bytes on the common
 * daemon-append path.
 *
 * @param {object} opts
 * @param {string} opts.ledgerPath       — absolute path to memory.jsonl
 * @param {string} opts.namespace        — projection id (cache partition)
 * @param {() => any} opts.makeEmpty     — build a fresh empty struct
 * @param {(struct:any,row:object)=>void} opts.applyParsedRow — merge one row
 * @param {(ledgerPath:string)=>any} [opts.fullRebuild] — OPTIONAL: build the
 *        struct from scratch (e.g. seeded from a disk cache). When provided it
 *        is used for the cold / shrink / mtime-regression branch INSTEAD of the
 *        internal stream rebuild. Two return shapes are accepted:
 *          - `{ struct, resumeOffset }` (FIX CYCLE 2): `resumeOffset` is the
 *            EXACT byte coverage of the rebuild (a pinned checkpoint eof / the
 *            last-terminated-line offset). The helper records safeOffset =
 *            resumeOffset so a row TORN at seed time — occupying
 *            [resumeOffset, st.size) — is re-read by the next grow-merge once
 *            its "\n" lands, never permanently skipped.
 *          - a bare struct (legacy): the helper records safeOffset = current
 *            raw size. ONLY sound when the rebuild provably covered every byte
 *            of the current file (no checkpoint to under-cover it); callers
 *            with a pinned checkpoint MUST use the wrapped shape.
 *        Most callers omit fullRebuild entirely and let the helper
 *        stream-rebuild internally so the cold path and the grow path share
 *        identical row semantics (that internal path is torn-tail-exact).
 * @param {(struct:any, branch:"cold"|"grow", coverage:{safeOffset:number|null})=>void} [opts.onChanged] — OPTIONAL:
 *        invoked AFTER a cold rebuild ("cold") or an append-growth tail-merge
 *        ("grow") materially changes the projection. NOT invoked on an exact
 *        hit (no change). Callers use this to re-persist a disk cache; the
 *        common warm-path projections omit it so the recall hot path never
 *        writes disk. `coverage.safeOffset` is the exact newline-safe byte
 *        coverage of `struct`, so a persistence callback can stamp a witness
 *        without certifying bytes that have not been folded. It is null only
 *        on the fail-closed shrink seam where the rebuild's claimed coverage
 *        exceeds the post-rebuild file size. A throw from onChanged is
 *        swallowed (non-fatal).
 * @returns {any | null} the projection struct, or null if the ledger is missing
 *          AND no fullRebuild was supplied (callers treat null as cold-empty).
 */
export function appendAwareLedgerProjection({
  ledgerPath,
  namespace,
  makeEmpty,
  applyParsedRow,
  fullRebuild,
  onChanged,
} = {}) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) return null;
  if (typeof namespace !== "string" || namespace.length === 0) return null;
  if (typeof makeEmpty !== "function") return null;
  if (typeof applyParsedRow !== "function") return null;

  const key = _cacheKey(namespace, ledgerPath);
  const st = _statOf(ledgerPath);

  if (st == null) {
    // Missing ledger. If a fullRebuild was supplied (it may return an empty
    // struct for the cold-start case) honor it; otherwise return null.
    if (typeof fullRebuild === "function") {
      try {
        return _unwrapRebuildResult(fullRebuild(ledgerPath)).struct;
      } catch {
        return null;
      }
    }
    return null;
  }

  const cached = _cache.get(key);
  if (cached != null) {
    // (1) EXACT HIT — file unchanged since the last build.
    if (cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      return cached.struct;
    }
    // (2) APPEND GROWTH — file got longer AND mtime advanced. This is NECESSARY
    // but not sufficient for append-only; verify the applied prefix bytes did
    // not drift (PREFIX-DRIFT GUARD) before trusting the tail-merge. A drift
    // (in-place rewrite / compaction) falls through to a full rebuild.
    if (
      st.size > cached.size &&
      st.mtimeMs >= cached.mtimeMs &&
      _boundaryGuardHolds(ledgerPath, cached)
    ) {
      // Tail-merge from the SAFE offset (past the last terminated line), not the
      // raw EOF size, so a previously-torn final line is re-read, not skipped.
      cached.safeOffset = _scanTailInto(
        cached.struct,
        ledgerPath,
        cached.safeOffset,
        applyParsedRow,
      );
      cached.size = st.size;
      cached.mtimeMs = st.mtimeMs;
      cached.guard = _readBoundaryGuard(ledgerPath, cached.safeOffset);
      if (typeof onChanged === "function") {
        try {
          onChanged(cached.struct, "grow", { safeOffset: cached.safeOffset });
        } catch {
          // Non-fatal — the in-memory projection is valid regardless.
        }
      }
      return cached.struct;
    }
    // (3) Otherwise the append-only invariant was violated (shrink / mtime
    // regression / prefix drift) — fall through to a full rebuild.
  }

  // COLD / shrink / mtime-regression / prefix-drift -> full rebuild from byte 0.
  let struct;
  let safeOffset;
  let recordSize = st.size;
  let recordMtimeMs = st.mtimeMs;
  if (typeof fullRebuild === "function") {
    // FIX CYCLE 2 (torn-tail seam): a checkpoint-seeded rebuild reports its
    // ACTUAL coverage via { struct, resumeOffset } — the pinned checkpoint eof.
    // Recording safeOffset = raw st.size here was the CONFIRMED regression: a
    // row torn at seed time occupied [cp.eof, st.size), was excluded from the
    // fold, and the next grow-merge resumed MID-ROW at st.size — the completed
    // row was permanently lost for the process (torn rescind kept an orphan;
    // torn excise under-applied the privacy gate).
    const r = _unwrapRebuildResult(fullRebuild(ledgerPath));
    struct = r.struct;
    if (r.resumeOffset != null) {
      // R2/WI3 (stat-before-pin seam): `st` was captured BEFORE fullRebuild
      // ran, but a checkpoint-seeded rebuild pins its coverage AFTER — a
      // daemon append landing in between makes resumeOffset legitimately
      // exceed the stale st.size. The old clamp min(resumeOffset, st.size)
      // recorded a safeOffset BELOW the seed's actual coverage, so the next
      // grow merge RE-FOLDED the seed-covered rows (double-apply for
      // non-idempotent reducers — hard-gates exciseRows is an array push;
      // RED-RUN 2026-07-16, scratchpad r2-red: `c` folded twice pre-fix).
      // Fix: re-stat AFTER the rebuild. The ledger is append-only, so
      // resumeOffset > post-rebuild size is the only GENUINE shrink — a
      // coverage claim over bytes that no longer exist. Fail closed: serve
      // the struct but cache nothing (the next call full-rebuilds).
      const stAfter = _statOf(ledgerPath) ?? st;
      if (r.resumeOffset > stAfter.size) {
        if (typeof onChanged === "function") {
          try {
            onChanged(struct, "cold", { safeOffset: null });
          } catch {
            // Non-fatal.
          }
        }
        return struct;
      }
      safeOffset = r.resumeOffset;
      // Record size = the seed's exact coverage (never the raw file size):
      // bytes [safeOffset, actual size) — a tail torn at pin time or rows
      // appended during the rebuild — must route the NEXT call into the grow
      // branch, which folds them exactly once from safeOffset. Pair it with a
      // POST-rebuild mtime so a quiescent file yields an exact hit instead of
      // a stale-mtime full-rebuild churn.
      recordSize = safeOffset;
      recordMtimeMs = stAfter.mtimeMs;
    } else {
      // Legacy bare-struct shape: the rebuild provably covered every byte of
      // the file it saw; keep the historical raw-size resume.
      safeOffset = st.size;
    }
  } else {
    struct = makeEmpty();
    safeOffset = _scanTailInto(struct, ledgerPath, 0, applyParsedRow);
  }

  _cache.set(key, {
    struct,
    safeOffset,
    size: recordSize,
    mtimeMs: recordMtimeMs,
    guard: _readBoundaryGuard(ledgerPath, safeOffset),
  });
  if (typeof onChanged === "function") {
    try {
      onChanged(struct, "cold", { safeOffset });
    } catch {
      // Non-fatal.
    }
  }
  return struct;
}

/** Test-only: clear the module-scope cache so a fixture rebuild starts cold. */
export function _resetAppendAwareProjectionCache() {
  _cache.clear();
}

/** Test-only inspection hook. */
export function _peekAppendAwareProjection(namespace, ledgerPath) {
  return _cache.get(_cacheKey(namespace, ledgerPath)) || null;
}
