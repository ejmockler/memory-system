// _ledger-stream.js — WU-B1-daemon-rss-bloat-fix.
//
// PROBLEM (WU-B1):
//   The watermark daemon's RSS climbed from 53MB to 4.2GB in 20 minutes
//   after the cascade went hot and memory.jsonl crossed 300MB. Per-tick
//   diagnostic on the live 308MB / 220k-row ledger:
//
//     readFileSync("memory.jsonl", "utf8")           -> RSS 1.5 GB
//     readFileSync + split("\n") + JSON.parse        -> RSS 2.1 GB
//     3 concurrent full-loads (one per consumer)     -> RSS 4.6 GB
//
//   The consumers that run every cascade tick (15s):
//     - thread-aggregator.aggregateThreads   — full readFileSync
//     - project-aggregator.aggregateProjects — full readFileSync
//     - the since-deleted embed-backfill-worker's loadLedgerById — full
//       readFileSync into a Map<fact_id,row> even when its queue had 0
//       entries to drain (historical; the worker no longer exists — its
//       successor reader is scripts/reembed-local-4096.mjs collectContents)
//
//   Each consumer was independently writing the same "load the whole
//   file, split, parse every line, hold it all in memory" pattern. With
//   220k rows × ~5x V8 object overhead the working set quickly exceeded
//   any reasonable cap; the daemon was running with
//   --max-old-space-size=8192 to compensate but RSS still climbed.
//
// FIX (this module):
//   Two primitives that replace readFileSync-the-whole-ledger:
//
//     1. streamLedgerLines(path, onRow, opts) — true line-by-line read via
//        fs.read into a small buffer. Never holds the whole file in
//        memory. Each parsed row is delivered to onRow(row, lineNo) which
//        may keep it (push into a filtered array) or drop it. The caller
//        decides what to retain — most consumers only need a small slice
//        (e.g. ts >= cutoff, or row.id in idSet).
//
//     2. getCachedLedgerById(path, idSet) — when the caller only needs
//        rows whose `id` is in a small set (e.g. embed-backfill queue
//        entries), this streams once and materializes ONLY those rows
//        into a Map. Even on a 220k-row ledger, the returned Map holds
//        ≤ idSet.size entries; the rest of the ledger never enters the
//        heap as parsed objects.
//
// CACHING:
//   None at this layer. Caching has subtle correctness implications
//   (the daemon's own appends to memory.jsonl invalidate any in-memory
//   row cache, and mtime granularity on macOS HFS+ is 1s) and the
//   primary RSS win comes from "stream + filter" rather than from
//   "cache + reuse". The existing recall/index-cache.js handles the
//   recall-side ledger cache where it makes sense; the daemon's
//   aggregators and backfill worker do streaming filtered reads.
//
// DISCIPLINE:
//   - ESM, defensive try/catch around every fs op.
//   - Node stdlib only (no readline dep — using fs.read into a 64KB
//     buffer is the lightest possible approach and avoids the Readable
//     stream object graph entirely).
//   - The streaming reader NEVER throws to the caller: I/O errors and
//     parse errors are silently skipped, mirroring the existing
//     "torn-tail tolerant" parsing discipline in the other ledger
//     consumers (thread-aggregator, project-aggregator,
//     scripts/reembed-local-4096.mjs collectContents).
//     WU-emitter-string-cap-fix amendment: fs errors are still swallowed
//     (never thrown) but are now REPORTED on the returned counts object
//     as `readError`, because the reconstruction emitter must be able to
//     tell "empty ledger" apart from "unreadable ledger" — the silent-[]
//     conflation of those two states is exactly what let the emitter run
//     PARENT_NOT_FOUND-forever against a ledger that had merely crossed
//     Node's ~536,870,888-byte max-string cap.

import { closeSync, openSync, readSync, statSync } from "node:fs";
// WU-emitter-string-cap-fix: StringDecoder carries a multi-byte UTF-8
// codepoint split across two chunk boundaries into the next write() call
// instead of emitting U+FFFD replacement chars at the seam. The original
// WU-B1 code accepted the seam-corruption risk as a "known limitation"
// because its consumers (time-window aggregators) only kept a filtered
// slice; the reconstruction emitter now streams the FULL row set through
// this primitive and must parse every row byte-exactly.
import { StringDecoder } from "node:string_decoder";

// 64 KiB is the sweet spot for read-loop throughput vs allocation churn:
// large enough that the per-read syscall cost is amortized across many
// JSON lines, small enough that the RSS impact is bounded to a single
// chunk per concurrent reader.
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * streamLedgerLines — read a JSONL file line-by-line, invoking `onRow`
 * with each parsed object. Never materializes the full file. Returns
 * `{ totalLines, parsedLines, skipped }` for caller diagnostics.
 *
 * Contract:
 *   - path: string absolute filesystem path. Missing-file -> returns
 *           zeros (matches the existing "best-effort tolerant" pattern
 *           in coverage-probe.js and thread-aggregator.js).
 *   - onRow: function(row, lineNumber) -> void. Called for every well-
 *           formed JSON line. The function may keep `row` (push into an
 *           array, into a Map) or drop it. Parse failures and blank
 *           lines do NOT invoke onRow.
 *   - opts.maxLineBytes: optional cap on a single line's size. A line
 *           larger than this is skipped (without invoking onRow) and
 *           counted in `skipped`. Default 8 MiB. Guards against a
 *           pathological row blowing the heap.
 *
 * Returns: `{ totalLines, parsedLines, skipped, readError }`.
 *
 * Defensive: any fs / parse error is silently swallowed; the function
 * never throws. The caller's onRow may throw — that DOES propagate, by
 * design, so a caller bug surfaces visibly.
 *
 * readError (WU-emitter-string-cap-fix): null when the file was read to
 * EOF cleanly; otherwise the message of the fs error that aborted the
 * scan (openSync failure, or a readSync failure mid-stream). The
 * function STILL never throws — but callers that must distinguish "the
 * ledger is empty" from "the ledger could not be read" (the
 * reconstruction emitter's parent-existence check, where the two cases
 * demand opposite conclusions) can inspect this field and log loudly.
 * Pre-existing callers destructure only the count fields and are
 * unaffected.
 *
 * B1c3 errno classification: the former existsSync(path) short-circuit
 * conflated "unreadable path" with "missing ledger" — existsSync returns
 * false for a file behind an EACCES parent dir, a symlink loop, or an
 * ENOTDIR component, so every consumer other than time-index (protected
 * by its own statLedger throw) saw zero counts with readError null and
 * projected an empty result from a ledger that EXISTS. Now the openSync
 * errno decides: ENOENT → zeros with readError null (missing-ledger →
 * empty is preserved for all consumers); any other errno (EACCES /
 * ELOOP / ENOTDIR / ...) → counts.readError is set. Still never throws.
 */
export function streamLedgerLines(path, onRow, opts = {}) {
  const counts = { totalLines: 0, parsedLines: 0, skipped: 0, readError: null };
  if (typeof path !== "string" || path.length === 0) return counts;
  if (typeof onRow !== "function") return counts;
  const maxLineBytes =
    Number.isInteger(opts.maxLineBytes) && opts.maxLineBytes > 0
      ? opts.maxLineBytes
      : 8 * 1024 * 1024;

  let fd = -1;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    // B1c3: ENOENT is the one benign errno — a genuinely missing ledger
    // keeps the historical "zeros, readError null" cold-start contract.
    // Everything else is an EXISTING-but-unreadable path and must be
    // reported (see readError contract above) while preserving the
    // never-throws discipline.
    if (e && e.code === "ENOENT") return counts;
    counts.readError = e && e.message ? e.message : String(e);
    return counts;
  }

  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  // Accumulator for the in-progress line. We hold AT MOST one line's
  // worth of bytes here (plus the trailing partial of the current chunk
  // until the next newline arrives). Capped by maxLineBytes — beyond
  // that we abandon the current line, count it as skipped, and
  // re-synchronize on the next newline.
  let pending = "";
  let lineNo = 0;
  let abandonLine = false;
  let position = 0;
  // Stateful UTF-8 decoder: a multi-byte codepoint straddling two chunk
  // boundaries is buffered inside the decoder and completed on the next
  // write() instead of being mangled into U+FFFD at the seam. (The WU-B1
  // original decoded each chunk independently and documented the seam
  // corruption as a known limitation; the emitter's full-row-set consumer
  // made that untenable — see module header.)
  const decoder = new StringDecoder("utf8");

  try {
    // Loop forever; readSync returning 0 == EOF.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let bytesRead;
      try {
        bytesRead = readSync(fd, chunk, 0, chunk.length, position);
      } catch (e) {
        // I/O error mid-stream: stop, return whatever we got — but record
        // the failure so callers can tell a truncated scan from a clean EOF.
        counts.readError = e && e.message ? e.message : String(e);
        break;
      }
      if (bytesRead === 0) break;
      position += bytesRead;
      // Decode this chunk into a string via the stateful decoder (trailing
      // partial multi-byte sequences carry over to the next iteration).
      const text = decoder.write(chunk.subarray(0, bytesRead));
      let cursor = 0;
      while (cursor < text.length) {
        const nl = text.indexOf("\n", cursor);
        if (nl < 0) {
          // No newline in the remainder; buffer it for the next chunk.
          if (!abandonLine) {
            if (pending.length + (text.length - cursor) > maxLineBytes) {
              abandonLine = true;
              pending = "";
              counts.skipped += 1;
            } else {
              pending += text.slice(cursor);
            }
          }
          break;
        }
        // Found end-of-line at offset nl.
        if (abandonLine) {
          // We were skipping; reset for the next line.
          abandonLine = false;
        } else {
          if (pending.length + (nl - cursor) > maxLineBytes) {
            counts.skipped += 1;
            pending = "";
          } else {
            const line = pending + text.slice(cursor, nl);
            pending = "";
            if (line.length > 0) {
              lineNo += 1;
              counts.totalLines += 1;
              let parsed;
              try {
                parsed = JSON.parse(line);
              } catch {
                cursor = nl + 1;
                continue;
              }
              counts.parsedLines += 1;
              // onRow throws propagate — caller bug should be loud.
              onRow(parsed, lineNo);
            }
          }
        }
        cursor = nl + 1;
      }
    }
    // EOF — drain any partial multi-byte sequence still buffered in the
    // decoder (a file truncated mid-codepoint yields replacement chars
    // here; the JSON.parse below then skips the torn line as before).
    if (!abandonLine) {
      pending += decoder.end();
    }
    // EOF — flush a trailing line without newline, if any.
    if (!abandonLine && pending.length > 0) {
      lineNo += 1;
      counts.totalLines += 1;
      let parsed;
      try {
        parsed = JSON.parse(pending);
        counts.parsedLines += 1;
        onRow(parsed, lineNo);
      } catch {
        // skip
      }
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
  return counts;
}

/**
 * streamLedgerLinesWithOffset — WU-recall-latency-fix.
 *
 * Like streamLedgerLines, but invokes onLine(line, byteOffset, byteLength)
 * with the RAW (un-parsed) line text AND its starting byte offset in the
 * file. This is the primitive the ledger byte-offset index (ledger-offset-
 * index.js) uses to build a `memory_id -> byte offset` sidecar: the index
 * builder needs the exact byte position where each row begins so a later
 * recall can fs.read JUST that row instead of re-streaming the whole 1.8 GB
 * file (the WU-recall-latency-fix dominant cost).
 *
 * Contract differences vs streamLedgerLines:
 *   - The callback receives the raw line STRING (not a parsed object). The
 *     index builder parses only the row.id off it (cheap) and discards the
 *     rest; full parsing of 1.45M rows would defeat the point.
 *   - byteOffset is the offset of the FIRST byte of the line within the file
 *     (the byte after the previous line's terminating "\n"). byteLength is
 *     the line's length in BYTES (UTF-8), EXCLUDING the terminating newline.
 *   - opts.startOffset (default 0): begin reading at this byte offset. Used by
 *     the incremental TAIL-MERGE path — when the ledger only grew, re-scan ONLY
 *     the appended bytes. The caller guarantees startOffset sits on a line
 *     boundary (it passes the previous file size, and the ledger is append-
 *     only with newline-terminated rows).
 *
 * Offsets/lengths are tracked in BYTES (not JS string length) so multi-byte
 * UTF-8 content (non-ASCII memory_ids/content) yields offsets a later
 * fs.read(position) honors exactly. We count bytes per chunk slice rather
 * than per decoded char.
 *
 * Defensive: never throws on fs/parse error (mirrors streamLedgerLines).
 * onLine throws DO propagate (caller bug should be loud).
 *
 * B1c3: same errno classification as streamLedgerLines — the former
 * existsSync(path) short-circuit conflated unreadable-path with
 * missing-ledger, and the openSync catch swallowed every errno. Now
 * ENOENT → zeros with readError null; any other errno sets
 * counts.readError. Pre-existing callers (ledger-offset-index,
 * append-aware-ledger-projection's tail scan) destructure only the
 * count/offset fields and are unaffected.
 */
export function streamLedgerLinesWithOffset(path, onLine, opts = {}) {
  const counts = { totalLines: 0, bytesScanned: 0, skipped: 0, readError: null };
  if (typeof path !== "string" || path.length === 0) return counts;
  if (typeof onLine !== "function") return counts;
  const maxLineBytes =
    Number.isInteger(opts.maxLineBytes) && opts.maxLineBytes > 0
      ? opts.maxLineBytes
      : 8 * 1024 * 1024;
  let position =
    Number.isInteger(opts.startOffset) && opts.startOffset >= 0
      ? opts.startOffset
      : 0;

  let fd = -1;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    // B1c3: identical classification to streamLedgerLines — ENOENT keeps
    // the missing-ledger → zeros contract; any other errno is an
    // existing-but-unreadable path, reported via readError, never thrown.
    if (e && e.code === "ENOENT") return counts;
    counts.readError = e && e.message ? e.message : String(e);
    return counts;
  }

  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  // Pending line bytes (Buffer pieces) accumulated across chunk boundaries.
  let pendingBufs = [];
  let pendingBytes = 0;
  // Byte offset (in the file) where the current pending line STARTS.
  let lineStartOffset = position;
  let abandonLine = false;

  function flushLine(lineBuf, startOffset, terminated) {
    const lineLen = lineBuf.length;
    if (lineLen === 0) return;
    counts.totalLines += 1;
    const text = lineBuf.toString("utf8");
    // onLine(text, byteOffset, byteLength, terminated). `terminated` is true
    // when the line ended with a "\n" in the file, false for a torn trailing
    // line at EOF (the daemon may have been mid-append). The incremental
    // tail-merge cache uses this to record a SAFE resume offset: it resumes
    // only past newline-terminated lines, never into a half-written row.
    // onLine throws propagate by design. Extra arg is back-compat (existing
    // callers ignore it).
    onLine(text, startOffset, lineLen, terminated === true);
  }

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let bytesRead;
      try {
        bytesRead = readSync(fd, chunk, 0, chunk.length, position);
      } catch (e) {
        // B1c3: mid-stream I/O failure — stop, return what we got, but
        // record it so callers can tell a truncated scan from a clean EOF
        // (mirrors streamLedgerLines' mid-stream readError contract).
        counts.readError = e && e.message ? e.message : String(e);
        break;
      }
      if (bytesRead === 0) break;
      counts.bytesScanned += bytesRead;
      let cursor = 0;
      while (cursor < bytesRead) {
        const nl = chunk.indexOf(0x0a, cursor); // 0x0a === "\n"
        if (nl < 0 || nl >= bytesRead) {
          // No newline in the remainder of this chunk — buffer the tail.
          const sliceLen = bytesRead - cursor;
          if (!abandonLine) {
            if (pendingBytes + sliceLen > maxLineBytes) {
              abandonLine = true;
              pendingBufs = [];
              pendingBytes = 0;
              counts.skipped += 1;
            } else {
              // Copy: chunk is reused on the next read.
              pendingBufs.push(Buffer.from(chunk.subarray(cursor, bytesRead)));
              pendingBytes += sliceLen;
            }
          }
          break;
        }
        // Newline found within this chunk at byte `position + nl`.
        if (abandonLine) {
          abandonLine = false;
          // The next line begins after this newline.
          lineStartOffset = position + nl + 1;
        } else {
          const tailLen = nl - cursor;
          if (pendingBytes + tailLen > maxLineBytes) {
            counts.skipped += 1;
            pendingBufs = [];
            pendingBytes = 0;
          } else {
            let lineBuf;
            if (pendingBytes === 0) {
              lineBuf = chunk.subarray(cursor, nl); // no copy needed; consumed now
            } else {
              pendingBufs.push(Buffer.from(chunk.subarray(cursor, nl)));
              lineBuf = Buffer.concat(pendingBufs, pendingBytes + tailLen);
            }
            flushLine(lineBuf, lineStartOffset, true);
            pendingBufs = [];
            pendingBytes = 0;
          }
          lineStartOffset = position + nl + 1;
        }
        cursor = nl + 1;
      }
      position += bytesRead;
    }
    // EOF — flush a trailing line with no terminating newline, if any. This
    // line is NOT newline-terminated (terminated=false) so the tail-merge
    // cache will NOT advance its safe resume offset past it: a daemon mid-
    // append leaves exactly such a torn line, and re-reading it next tick
    // (once the "\n" lands) is the correctness guarantee.
    if (!abandonLine && pendingBytes > 0) {
      flushLine(Buffer.concat(pendingBufs, pendingBytes), lineStartOffset, false);
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
  return counts;
}

/**
 * readLedgerRowAtOffset — WU-recall-latency-fix.
 *
 * Read ONE ledger row by seeking to its byte offset and reading until the
 * next newline (or EOF). Returns the parsed row object, or null on any
 * failure (bad offset, parse error, truncated read). Never throws.
 *
 * The read is bounded: we read in fixed windows starting at `offset` until
 * we hit a "\n" or maxLineBytes. For the append-only ledger a row is one
 * line, so the first window almost always contains the whole row.
 *
 * @param {number} fd       — an OPEN file descriptor (caller owns its lifecycle).
 * @param {number} offset   — byte offset of the row's first byte.
 * @param {object} [opts]
 * @param {number} [opts.maxLineBytes] — cap on a single row's bytes (default 8 MiB).
 * @returns {object|null}
 */
export function readLedgerRowAtOffset(fd, offset, opts = {}) {
  if (typeof fd !== "number" || fd < 0) return null;
  if (!Number.isInteger(offset) || offset < 0) return null;
  const maxLineBytes =
    Number.isInteger(opts.maxLineBytes) && opts.maxLineBytes > 0
      ? opts.maxLineBytes
      : 8 * 1024 * 1024;
  const WINDOW = READ_CHUNK_BYTES;
  const buf = Buffer.alloc(WINDOW);
  const pieces = [];
  let total = 0;
  let pos = offset;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let bytesRead;
      try {
        bytesRead = readSync(fd, buf, 0, WINDOW, pos);
      } catch {
        return null;
      }
      if (bytesRead === 0) break; // EOF before a newline — accept the tail.
      const nl = buf.indexOf(0x0a, 0);
      if (nl >= 0 && nl < bytesRead) {
        pieces.push(Buffer.from(buf.subarray(0, nl)));
        total += nl;
        break;
      }
      pieces.push(Buffer.from(buf.subarray(0, bytesRead)));
      total += bytesRead;
      pos += bytesRead;
      if (total > maxLineBytes) return null; // pathological / wrong offset
    }
  } catch {
    return null;
  }
  if (total === 0) return null;
  let text;
  try {
    text = Buffer.concat(pieces, total).toString("utf8");
  } catch {
    return null;
  }
  try {
    const row = JSON.parse(text);
    return row && typeof row === "object" ? row : null;
  } catch {
    return null;
  }
}

/**
 * streamLedgerRowsInTimeWindow — convenience helper for the daemon-tick
 * aggregators (thread-aggregator, project-aggregator). Streams the
 * ledger and returns ONLY the rows whose `ts` (or `created_at` fallback,
 * matching coverage-probe.js's field tolerance) is within the requested
 * window. Rows older than `cutoffMs` or in the future are dropped
 * without ever being held in memory.
 *
 * Args:
 *   path        — absolute ledger path
 *   cutoffMs    — minimum ts (rows with tsMs < cutoffMs are dropped)
 *   nowMsCeil   — maximum ts (rows with tsMs > nowMsCeil are dropped)
 *   opts.kind   — optional string; if set, only rows whose row.kind ===
 *                 opts.kind are kept (the aggregators filter to
 *                 "fact" rows; passing this here skips the heap-alloc
 *                 for policy/recall rows entirely).
 *   opts.maxRows — optional cap on the returned array size. The stream
 *                 stops once this many rows have been kept (the file is
 *                 fully consumed regardless to leave the fd in a clean
 *                 state — cheap relative to the rss win). Default
 *                 Infinity.
 *
 * Returns `{ rows, totalLines, parsedLines, kept }`.
 */
export function streamLedgerRowsInTimeWindow(
  path,
  cutoffMs,
  nowMsCeil,
  opts = {},
) {
  const rows = [];
  const kindFilter = typeof opts.kind === "string" ? opts.kind : null;
  const maxRows =
    Number.isInteger(opts.maxRows) && opts.maxRows > 0
      ? opts.maxRows
      : Infinity;
  let kept = 0;
  let truncated = false;

  const counts = streamLedgerLines(path, (row) => {
    if (truncated) return;
    if (row == null || typeof row !== "object") return;
    if (kindFilter !== null && row.kind !== kindFilter) return;
    const tsField =
      (typeof row.ts === "string" && row.ts) ||
      (typeof row.created_at === "string" && row.created_at) ||
      null;
    if (tsField === null) return;
    const tsMs = Date.parse(tsField);
    if (!Number.isFinite(tsMs)) return;
    if (tsMs < cutoffMs) return;
    if (tsMs > nowMsCeil) return;
    rows.push(row);
    kept += 1;
    if (kept >= maxRows) truncated = true;
  });

  return {
    rows,
    totalLines: counts.totalLines,
    parsedLines: counts.parsedLines,
    kept,
    truncated,
  };
}

/**
 * streamLedgerRowsById — the reader behind scripts/reembed-local-4096.mjs
 * collectContents (its sole live call site) and the latest-write-wins
 * semantics lib/recall/embed-population-census.js:49 cites without calling
 * it. Streams the WHOLE ledger and returns ONLY the rows with
 * kind === "fact" and a string `id` that is in the supplied `idSet`.
 *
 * LATEST-WRITE-WINS: a fact id may be re-appended (a later row with the same
 * id). The Map holds the LAST such fact row — later lines overwrite earlier
 * ones via Map.set, matching the retired loadLedgerById reader it replaced.
 * Non-fact rows for a
 * wanted id never reach the Map, so this is latest-FACT-write-wins.
 *
 * E4 2026-09 — the helper previously kept a countdown of unseen wanted ids
 * and returned early from the callback once every id had been seen ONCE, which made
 * a re-appended id resolve to its FIRST row and the latest-write-wins claim
 * above false (observed: [a:OLD, b, a:NEW] => a:OLD). The short-circuit is
 * removed. It bought nothing: streamLedgerLines already JSON.parses every
 * line before invoking the callback, so an early return saved only the
 * callback body, never the parse or the read. Pinned by
 * test/synthesis/ledger-stream-by-id.test.mjs.
 *
 * HEAP BOUND (daemon-rss-bloat-fix T3/T4) unchanged: the returned Map still
 * holds at most idSet.size entries, and a parsed row that is not wanted is
 * dropped as soon as the callback returns — the rest of the ledger never
 * enters the heap as a retained object.
 *
 * Args:
 *   path  — absolute ledger path
 *   idSet — Set<string> of fact_ids to look up. Empty / non-Set returns
 *           an empty Map without opening the file.
 *
 * Returns `Map<string, row>`.
 */
export function streamLedgerRowsById(path, idSet) {
  const out = new Map();
  if (!(idSet instanceof Set) || idSet.size === 0) return out;
  streamLedgerLines(path, (row) => {
    if (row == null || typeof row !== "object") return;
    if (row.kind !== "fact") return;
    if (typeof row.id !== "string") return;
    if (!idSet.has(row.id)) return;
    // Latest-write-wins: a later row for the same id overwrites the earlier
    // one. No early exit — see the E4 note in the docstring.
    out.set(row.id, row);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Module-scope cache for ledger size — used by callers that want to decide
// whether to even attempt a read. statSync is cheap (~10us) but exposed as
// a helper here so the caller doesn't need to import statSync separately.
// ---------------------------------------------------------------------------
export function ledgerSizeOrZero(path) {
  try {
    const st = statSync(path);
    return st.size || 0;
  } catch {
    return 0;
  }
}
