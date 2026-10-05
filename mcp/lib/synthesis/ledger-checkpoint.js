// ledger-checkpoint.js — S1: newline-safe pinned-EOF checkpoint primitive.
//
// DEFECT CLASS THIS MODULE CLOSES (once, for every ledger reducer):
//
//   The derived caches checkpoint their position in the append-only JSONL
//   ledger using (size, mtime), which has two proven failure modes:
//
//   (a) TORN-FINAL-LINE WATERMARK ADVANCE. A writer mid-append leaves a
//       trailing line with no "\n". Recording raw stat.size as the resume
//       cursor skips that row forever once it completes:
//         - append-aware-ledger-projection.js:287 — fullRebuild records
//           `safeOffset = st.size` with no proof the final line was
//           newline-terminated.
//         - ledger-offset-index.js:351,381 — resumes `_scanInto` from raw
//           `cached.size` / records raw `st.size`.
//
//   (b) SIZE+MTIME-AS-PREFIX-PROOF. Growth in size with a non-regressing
//       mtime does not prove the already-applied prefix is byte-identical —
//       an in-place rewrite or rotation that also grows the file serves a
//       corrupt incremental:
//         - ledger-offset-index.js:350-354 — grow branch accepts
//           `st.size > cached.size && st.mtimeMs >= cached.mtimeMs` with NO
//           prefix witness at all.
//         - derivation-graph.js:375-379 — disk cache accepted on exact
//           `ledger_mtime_ms` equality (mtime proves nothing about bytes).
//         - append-aware-ledger-projection.js:66,250-254 — the 256-byte
//           BOUNDARY_GUARD witnesses only the last 256 bytes before
//           safeOffset; an earlier-prefix rewrite that grows the file
//           passes undetected.
//
//   THE FIX. A checkpoint pins a NEWLINE-SAFE EOF (`eof` = the byte just
//   past the last "\n" at or before stat.size — torn tail bytes [eof, size)
//   are never covered, so the completed row is replayed exactly once), plus
//   a sampled-block PREFIX-IDENTITY WITNESS: sha256 hashes over up to ~64
//   sampled 64 KiB blocks of [0, eof), always including block 0 and the
//   (possibly short) final block. verifyPrefix() re-reads ONLY the witness
//   ranges (<= 128 x 64 KiB) — never the whole prefix — and readAppended()
//   is a DIRECT bounded reader over exactly [from.eof, to.eof): positioned
//   BLOCK_BYTES-chunk reads, never one byte past to.eof (it does NOT sit on
//   streamLedgerLinesWithOffset, whose early-stop discards counts, hides
//   blank/oversized skips, and scans to file EOF).
//
//   FAIL-CLOSED CONTRACT (S1b). Consumers certify "delta applied, coverage
//   complete" from readAppended's return value, so every byte of the delta
//   NOT delivered is reported and every file-level anomaly is a non-null
//   error. readAppended errors (exact strings): "invalid-callback",
//   "invalid-checkpoint", "from-after-to", "missing" (open failed),
//   "truncated" (EOF before to.eof), "torn-boundary" (no "\n" at to.eof-1),
//   "io-error" (read threw). When error === null the accounting identity
//   holds: bytes + skipped_oversized_bytes + skipped_blank
//   === to.eof - from.eof. On a non-null error, counters reflect progress
//   only — consumers MUST NOT certify delta coverage; verifyPrefix +
//   full-rebuild is the recovery path. Likewise isValidCheckpoint enforces
//   witness density (block-0 + final-block coverage, alignment, ordering,
//   <= 128 entries) so verifyPrefix can never vacuously succeed on an
//   empty-or-hostile witness when eof > 0.
//
//   Related-but-different: _agg-checkpoint.js:89-174 is an atomically
//   persisted cursor FILE (persistence machinery, no newline safety, no
//   prefix witness). This module deliberately has NO persistence: a
//   checkpoint is a plain JSON-safe VALUE the caller embeds in its own
//   cache files via serializeCheckpoint / deserializeCheckpoint.
//
// HONEST LIMITATIONS:
//   The sampled witness deterministically catches any change to block 0,
//   the final block, and every sampled block (stride = ceil(nBlocks/64)).
//   Changes confined ENTIRELY to un-sampled interior blocks are NOT caught.
//   This is strictly stronger than size+mtime and the 256-byte boundary
//   guard, but it is not a cryptographic whole-prefix guarantee — a
//   consumer needing more must sample denser (or hash the whole prefix,
//   which this module refuses to do by design: cost must stay O(witness)
//   regardless of file size).
//
// DISCIPLINE (matches _ledger-stream.js):
//   - ESM, Node stdlib only (node:fs, node:crypto).
//   - Pure and read-only: no module-scope mutable cache, no file writes,
//     no locks; every function opens its own fd and closes it in finally.
//   - Library functions never throw on fs errors (captureCheckpoint ->
//     null, verifyPrefix -> {ok:false, reason}, readAppended -> {error}).
//     Caller-callback throws DO propagate — a caller bug should be loud.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

/** Checkpoint schema version. */
export const CHECKPOINT_VERSION = 1;

/** Witness block size. Blocks are aligned from byte 0 of the file. */
export const BLOCK_BYTES = 64 * 1024;

// Hard cap on witness entries. verifyPrefix cost is bounded by
// MAX_WITNESS_ENTRIES * BLOCK_BYTES bytes read (<= 8 MiB), regardless of
// ledger size. Incremental capture falls back to a fresh sample rather
// than exceed this.
const MAX_WITNESS_ENTRIES = 128;

// Target number of sampled blocks in a fresh capture (plus the always-
// included final block).
const TARGET_SAMPLES = 64;

const HEX64_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read exactly `len` bytes at file offset `off` into `buf` (from buf[0]).
 * Returns "ok" | "short" | "error". Never throws.
 */
function readExact(fd, buf, off, len) {
  let got = 0;
  while (got < len) {
    let n;
    try {
      n = readSync(fd, buf, got, len - got, off + got);
    } catch {
      return "error";
    }
    if (n === 0) return "short";
    got += n;
  }
  return "ok";
}

/**
 * sha256 (lowercase hex) of exactly bytes [off, off+len) of the open fd.
 * Returns the hex string, or null on any read failure / short read.
 */
function hashRange(fd, off, len) {
  const hash = createHash("sha256");
  const buf = Buffer.alloc(Math.min(len, BLOCK_BYTES));
  let remaining = len;
  let pos = off;
  while (remaining > 0) {
    const want = Math.min(remaining, buf.length);
    if (readExact(fd, buf, pos, want) !== "ok") return null;
    hash.update(buf.subarray(0, want));
    remaining -= want;
    pos += want;
  }
  return hash.digest("hex");
}

/**
 * Newline-safe EOF: the byte offset just PAST the last 0x0a at or before
 * `size`. Scans BACKWARD from `size` in 64 KiB windows via positioned
 * reads — never reads the whole file. A file with no newline yields 0; a
 * file ending in "\n" yields `size`. Returns -1 on read failure.
 */
function findNewlineSafeEof(fd, size) {
  if (size === 0) return 0;
  const buf = Buffer.alloc(Math.min(size, BLOCK_BYTES));
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - buf.length);
    const want = end - start;
    if (readExact(fd, buf, start, want) !== "ok") return -1;
    const idx = buf.subarray(0, want).lastIndexOf(0x0a);
    if (idx >= 0) return start + idx + 1;
    end = start;
  }
  return 0;
}

/**
 * Ascending sampled block indices over blocks [firstBlock, nBlocks):
 * firstBlock, firstBlock+stride, ... with stride = max(1, ceil(count /
 * TARGET_SAMPLES)), ALWAYS additionally including the final block
 * (nBlocks - 1) — the sampled-final-block rule subsumes and strengthens
 * the old 256-byte boundary guard.
 */
function sampleBlockIndices(firstBlock, nBlocks) {
  if (nBlocks <= firstBlock) return [];
  const count = nBlocks - firstBlock;
  const stride = Math.max(1, Math.ceil(count / TARGET_SAMPLES));
  const idxs = new Set();
  for (let i = firstBlock; i < nBlocks; i += stride) idxs.add(i);
  idxs.add(nBlocks - 1);
  return [...idxs].sort((a, b) => a - b);
}

/**
 * Hash witness entries for the given block indices over prefix [0, eof).
 * Returns the entry array, or null on any read failure.
 */
function buildWitnessEntries(fd, blockIndices, eof) {
  const entries = [];
  for (const i of blockIndices) {
    const off = i * BLOCK_BYTES;
    const len = Math.min(BLOCK_BYTES, eof - off);
    if (len < 1) continue; // defensive; cannot happen for valid indices
    const hash = hashRange(fd, off, len);
    if (hash === null) return null;
    entries.push({ off, len, hash });
  }
  return entries;
}

/**
 * Strict shape AND density validation. Returns true iff `cp` is a
 * well-formed v1 checkpoint object. This single gate hardens every entry
 * point (captureCheckpoint's prev, verifyPrefix, readAppended,
 * serializeCheckpoint, deserializeCheckpoint). Never throws.
 *
 * Density rules (S1b — reject vacuous/hostile witnesses):
 *   - witness.length <= MAX_WITNESS_ENTRIES (bounds verifyPrefix reads);
 *   - eof === 0  <=>  witness.length === 0 (no vacuous verify over data);
 *   - when eof > 0, some entry has off === 0 AND some entry has
 *     off + len === eof (block-0 + final-block coverage);
 *   - every entry: off % BLOCK_BYTES === 0, 1 <= len <= BLOCK_BYTES,
 *     off + len <= eof;
 *   - offsets NON-DECREASING in array order. Deliberately NOT strictly
 *     increasing: incremental capture stacks the previous short final-block
 *     entry and its full-block extension at the SAME off
 *     (Math.floor(prev.eof / BLOCK_BYTES) in captureCheckpoint) — a
 *     strictly-increasing rule would make captured checkpoints
 *     self-invalidating (guarded by test (l)).
 */
function isValidCheckpoint(cp) {
  if (cp === null || typeof cp !== "object" || Array.isArray(cp)) return false;
  if (cp.v !== CHECKPOINT_VERSION) return false;
  if (cp.algo !== "sha256") return false;
  if (!Number.isInteger(cp.size) || cp.size < 0) return false;
  if (!Number.isInteger(cp.eof) || cp.eof < 0) return false;
  if (cp.eof > cp.size) return false;
  if (!(cp.mtimeMs === null || (typeof cp.mtimeMs === "number" && Number.isFinite(cp.mtimeMs)))) {
    return false;
  }
  if (!(cp.ino === null || (typeof cp.ino === "number" && Number.isFinite(cp.ino)))) {
    return false;
  }
  if (!Array.isArray(cp.witness)) return false;
  if (cp.witness.length > MAX_WITNESS_ENTRIES) return false;
  if ((cp.eof === 0) !== (cp.witness.length === 0)) return false;
  let hasBlockZero = false;
  let hasFinal = false;
  let prevOff = -1;
  for (const e of cp.witness) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) return false;
    if (!Number.isInteger(e.off) || e.off < 0) return false;
    if (!Number.isInteger(e.len) || e.len < 1) return false;
    if (e.off + e.len > cp.eof) return false;
    if (typeof e.hash !== "string" || !HEX64_RE.test(e.hash)) return false;
    if (e.off % BLOCK_BYTES !== 0) return false;
    if (e.len > BLOCK_BYTES) return false;
    if (e.off < prevOff) return false; // non-decreasing (see docblock)
    prevOff = e.off;
    if (e.off === 0) hasBlockZero = true;
    if (e.off + e.len === cp.eof) hasFinal = true;
  }
  if (cp.eof > 0 && (!hasBlockZero || !hasFinal)) return false;
  return true;
}

/** Deep copy of a (pre-validated) checkpoint into a fresh plain object. */
function copyCheckpoint(cp) {
  return {
    v: cp.v,
    algo: cp.algo,
    size: cp.size,
    eof: cp.eof,
    mtimeMs: cp.mtimeMs,
    ino: cp.ino,
    witness: cp.witness.map((e) => ({ off: e.off, len: e.len, hash: e.hash })),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * captureCheckpoint — snapshot the file's newline-safe EOF plus a sampled
 * prefix-identity witness over [0, eof).
 *
 * @param {string} path — absolute file path.
 * @param {object} [opts]
 * @param {object} [opts.prev] — an earlier checkpoint of the SAME file.
 *   When supplied and still a verified prefix, its witness is reused
 *   verbatim and only NEW sample blocks in the appended region are hashed
 *   (cheap incremental extension; the previous witness is a prefix of the
 *   new one). Falls back to a fresh full sample (still only ~64 block
 *   reads, never a full-file read) if the combined witness would exceed
 *   128 entries or `prev` fails verification.
 * @param {number} [opts.upTo] — ADDITIVE, OPT-IN upper bound on the pinned
 *   region: the newline-safe eof is searched backward from
 *   `min(stat.size, upTo)` instead of from `stat.size`, so the returned
 *   checkpoint pins the genuine prefix `[0, eof)` with `eof <= upTo`. It is
 *   NOT a claim that `upTo` is a line boundary: when `upTo` falls mid-line the
 *   eof lands EARLIER, at the last "\n" at or before it, and the caller is
 *   expected to compare `eof` against the offset it asked for rather than
 *   assume they match. `size` still reports the CURRENT stat.size (so
 *   `eof <= size` and verifyPrefix's "shrunk" test keep their meanings), and
 *   the witness still covers block 0 and the final block OF THE BOUNDED
 *   PREFIX. Omitting it reproduces the previous behaviour byte-for-byte —
 *   every pre-existing caller is unchanged. Added for
 *   mcp/lib/recall/embed-work-set.js, which needs a checkpoint whose `eof` IS
 *   its stored cursor so `readAppended(path, cursorPin, head, …)` can resume a
 *   bounded derivation at that byte without a second ledger walk.
 * @returns {object|null} `{ v: 1, algo: "sha256", size, eof, mtimeMs, ino,
 *   witness: [{ off, len, hash }] }`, or null if the file is missing /
 *   unstatable / unreadable. `mtimeMs` and `ino` are advisory diagnostics
 *   only — verification never trusts them. Bytes [eof, size) are a torn
 *   tail and are NOT covered by the checkpoint.
 *
 * PREFIX-CERTIFIED-BY-PREV SIGNAL (S1c). When `prev` was supplied AND its
 * prefix verified inside THIS capture call, the returned checkpoint carries
 * exactly one NON-ENUMERABLE, in-memory-only boolean flag:
 *   - `extendedPrev: true`  — prev's witness was reused verbatim (the
 *     verbatim-extension path; prev.witness is an array-prefix of witness);
 *   - `prefixVerified: true` — prev verified but the combined witness would
 *     have exceeded MAX_WITNESS_ENTRIES (or hashing the appended sample
 *     blocks failed), so the witness is a FRESH downsampled resample over
 *     [0, eof). The caller may still trust an incremental fold of
 *     [prev.eof, eof): the [0, prev.eof) prefix was verified byte-identical
 *     within this call, so non-extension here is a capacity artifact, NOT a
 *     discontinuity.
 * BOTH flags are absent on unverified fresh samples (no prev, prev invalid,
 * prev.eof > eof, or prev failed verification — rewrite/replacement/shrink).
 * Non-enumerable keeps every persisted shape byte-identical:
 * serializeCheckpoint / deserializeCheckpoint / JSON never see the flags —
 * the signal exists only on the freshly captured in-memory object.
 *
 * Never throws.
 */
export function captureCheckpoint(path, opts = {}) {
  if (typeof path !== "string" || path.length === 0) return null;
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }

  const prev =
    opts && isValidCheckpoint(opts.prev) ? opts.prev : null;

  let fd = -1;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    // `upTo` bounds ONLY the newline-safe-eof search; `size` below is still
    // the current stat.size, so nothing about the shrunk/torn-tail contract
    // moves. A non-integer / negative / absent value is ignored outright.
    const limit =
      opts !== null && typeof opts === "object" && Number.isInteger(opts.upTo) && opts.upTo >= 0
        ? Math.min(st.size, opts.upTo)
        : st.size;
    const eof = findNewlineSafeEof(fd, limit);
    if (eof < 0) return null;
    const nBlocks = Math.ceil(eof / BLOCK_BYTES);

    let witness = null;
    let prevVerified = false;
    let extendedPrev = false;

    // Incremental path: reuse prev's witness verbatim, hash only the new
    // sample blocks in the appended region [prev.eof-aligned block, eof).
    if (prev !== null && prev.eof <= eof) {
      const pv = verifyPrefix(path, prev);
      if (pv.ok) {
        prevVerified = true;
        let newEntries = [];
        if (eof > prev.eof) {
          const firstNewBlock = Math.floor(prev.eof / BLOCK_BYTES);
          const idxs = sampleBlockIndices(firstNewBlock, nBlocks);
          newEntries = buildWitnessEntries(fd, idxs, eof);
        }
        if (
          newEntries !== null &&
          prev.witness.length + newEntries.length <= MAX_WITNESS_ENTRIES
        ) {
          witness = prev.witness
            .map((e) => ({ off: e.off, len: e.len, hash: e.hash }))
            .concat(newEntries);
          extendedPrev = true;
        }
      }
    }

    // Fresh full sample (also the fallback path).
    if (witness === null) {
      const idxs = sampleBlockIndices(0, nBlocks);
      witness = buildWitnessEntries(fd, idxs, eof);
      if (witness === null) return null;
    }

    const cp = {
      v: CHECKPOINT_VERSION,
      algo: "sha256",
      size: st.size,
      eof,
      mtimeMs: typeof st.mtimeMs === "number" ? st.mtimeMs : null,
      ino: typeof st.ino === "number" ? st.ino : null,
      witness,
    };
    // Prefix-certified-by-prev signal (S1c, see docblock): NON-ENUMERABLE so
    // no persisted/serialized shape changes; in-memory only. `extendedPrev`
    // marks the verbatim-extension path; `prefixVerified` marks the
    // verified-prev resample path (witness-cap overflow / appended-sample
    // hash failure). Unverified fresh samples carry neither.
    if (extendedPrev) {
      Object.defineProperty(cp, "extendedPrev", { value: true });
    } else if (prevVerified) {
      Object.defineProperty(cp, "prefixVerified", { value: true });
    }
    return cp;
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

/**
 * verifyPrefix — is `checkpoint` still a byte-identical prefix of `path`?
 *
 * Cost is O(witness): reads ONLY the witness byte ranges (<= 128 x 64 KiB),
 * never the whole prefix, regardless of file size or how much was appended.
 *
 * @returns {{ ok: boolean, reason: string|null }} reasons (exact strings):
 *   "invalid-checkpoint" — checkpoint fails shape/density validation;
 *   "budget-exceeded"    — witness byte total over the verification budget;
 *   "missing"            — the file cannot be stat'd;
 *   "shrunk"             — stat.size < checkpoint.eof;
 *   "prefix-drift"       — a witness range re-hash mismatches or reads short;
 *   "io-error"           — open/read failure.
 *
 * Never throws.
 */
export function verifyPrefix(path, checkpoint) {
  if (!isValidCheckpoint(checkpoint)) {
    return { ok: false, reason: "invalid-checkpoint" };
  }
  // Byte budget (defense-in-depth): post-validation this is normally
  // unreachable — <= MAX_WITNESS_ENTRIES entries of <= BLOCK_BYTES each make
  // the cap a theorem — but it is kept as an explicit guard against future
  // schema drift re-opening read amplification.
  let witnessBytes = 0;
  for (const e of checkpoint.witness) witnessBytes += e.len;
  if (witnessBytes > MAX_WITNESS_ENTRIES * BLOCK_BYTES) {
    return { ok: false, reason: "budget-exceeded" };
  }
  if (typeof path !== "string" || path.length === 0) {
    return { ok: false, reason: "missing" };
  }
  let st;
  try {
    st = statSync(path);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (st.size < checkpoint.eof) {
    return { ok: false, reason: "shrunk" };
  }
  // Empty witness is only reachable for eof === 0 (isValidCheckpoint
  // enforces eof === 0 <=> empty witness): the origin cursor's empty prefix
  // is genuinely vacuous-true against any existing file.
  if (checkpoint.witness.length === 0) {
    return { ok: true, reason: null };
  }

  let fd = -1;
  try {
    fd = openSync(path, "r");
  } catch {
    return { ok: false, reason: "io-error" };
  }
  try {
    const buf = Buffer.alloc(BLOCK_BYTES);
    for (const e of checkpoint.witness) {
      let remaining = e.len;
      let pos = e.off;
      const hash = createHash("sha256");
      while (remaining > 0) {
        const want = Math.min(remaining, buf.length);
        const r = readExact(fd, buf, pos, want);
        if (r === "error") return { ok: false, reason: "io-error" };
        if (r === "short") return { ok: false, reason: "prefix-drift" };
        hash.update(buf.subarray(0, want));
        remaining -= want;
        pos += want;
      }
      if (hash.digest("hex") !== e.hash) {
        return { ok: false, reason: "prefix-drift" };
      }
    }
    return { ok: true, reason: null };
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

/**
 * readAppended — iterate exactly the delta rows between two checkpoints.
 *
 * DIRECT bounded reader (S1b): positioned BLOCK_BYTES-chunk reads over
 * exactly [from.eof, to.eof) — never one byte past to.eof, so cost is
 * O(delta) with bytes_scanned <= to.eof - from.eof regardless of how much
 * was appended after `to` was captured. `from.eof` is a line boundary by
 * construction; the region is split on raw 0x0a and
 * `onLine(text, byteOffset, byteLength)` fires for each non-blank,
 * non-oversized line — the line whose "\n" is byte `to.eof - 1` IS
 * included; anything at/after `to.eof` is NOT.
 *
 * FAIL-CLOSED error taxonomy (exact strings):
 *   "invalid-callback"   — onLine is not a function;
 *   "invalid-checkpoint" — either checkpoint fails validation;
 *   "from-after-to"      — from.eof > to.eof;
 *   "missing"            — the file cannot be opened;
 *   "truncated"          — EOF before to.eof (file shrank below the delta);
 *   "torn-boundary"      — the region does not end in "\n" (no line
 *                          boundary at to.eof in the CURRENT file — the
 *                          caller must verifyPrefix and full-rebuild);
 *   "io-error"           — a positioned read threw mid-delta.
 *
 * @param {string} path
 * @param {object} fromCheckpoint
 * @param {object} toCheckpoint
 * @param {function} onLine — (utf8Text, absoluteByteOffset,
 *   byteLengthExclNewline). Throws propagate (caller bug should be loud).
 * @param {object} [opts]
 * @param {number} [opts.maxLineBytes=8388608] — positive integer cap on a
 *   single line's content bytes (default 8 MiB, parity with
 *   _ledger-stream.js). Longer lines are counted, never buffered past the
 *   cap: resident memory stays <= maxLineBytes + BLOCK_BYTES.
 *
 * @returns {{ lines: number, bytes: number, skipped_oversized: number,
 *   skipped_oversized_bytes: number, skipped_blank: number,
 *   bytes_scanned: number, error: string|null }}
 *   `lines`/`bytes` keep their exact S1 meaning: delivered line count and
 *   delivered bytes including each terminating "\n". `skipped_blank` counts
 *   zero-length lines (1 byte each); `skipped_oversized` counts lines over
 *   maxLineBytes with `skipped_oversized_bytes` their bytes including each
 *   "\n"; `bytes_scanned` is bytes actually read. ACCOUNTING IDENTITY: when
 *   error === null, bytes + skipped_oversized_bytes + skipped_blank
 *   === to.eof - from.eof (every delta byte is accounted for). A
 *   from.eof === to.eof delta is vacuous-true: all-zero counters,
 *   error null, NO I/O. On any non-null error the counters reflect progress
 *   made, but consumers MUST NOT certify delta coverage from them —
 *   fail-closed means only error === null certifies the delta.
 *
 * NOTE: readAppended does NOT itself re-verify the prefix. Callers compose
 * `verifyPrefix(path, fromCheckpoint)` first and full-rebuild on failure —
 * a delta over a drifted prefix is meaningless.
 *
 * Never throws on fs errors; `onLine` throws DO propagate.
 */
export function readAppended(path, fromCheckpoint, toCheckpoint, onLine, opts = {}) {
  const res = {
    lines: 0,
    bytes: 0,
    skipped_oversized: 0,
    skipped_oversized_bytes: 0,
    skipped_blank: 0,
    bytes_scanned: 0,
    error: null,
  };
  if (typeof onLine !== "function") {
    res.error = "invalid-callback";
    return res;
  }
  if (!isValidCheckpoint(fromCheckpoint) || !isValidCheckpoint(toCheckpoint)) {
    res.error = "invalid-checkpoint";
    return res;
  }
  const fromEof = fromCheckpoint.eof;
  const toEof = toCheckpoint.eof;
  if (fromEof > toEof) {
    res.error = "from-after-to";
    return res;
  }
  if (fromEof === toEof) return res; // vacuous-true empty delta: no I/O

  const maxLineBytes =
    opts !== null &&
    typeof opts === "object" &&
    Number.isInteger(opts.maxLineBytes) &&
    opts.maxLineBytes > 0
      ? opts.maxLineBytes
      : 8 * 1024 * 1024;

  let fd = -1;
  try {
    fd = openSync(path, "r");
  } catch {
    res.error = "missing";
    return res;
  }
  try {
    const chunk = Buffer.alloc(Math.min(BLOCK_BYTES, toEof - fromEof));
    // Current line state across chunk boundaries. `lineBytes` is the TRUE
    // content length; pendingBufs holds copies ONLY while the line is still
    // within maxLineBytes (oversized lines are counted, never buffered past
    // the cap: resident memory <= maxLineBytes + BLOCK_BYTES).
    let pendingBufs = [];
    let pendingBytes = 0;
    let lineBytes = 0;
    let lineStart = fromEof;
    let pos = fromEof;

    while (pos < toEof) {
      const want = Math.min(chunk.length, toEof - pos); // never past to.eof
      let n;
      try {
        n = readSync(fd, chunk, 0, want, pos);
      } catch {
        res.error = "io-error";
        return res;
      }
      if (n === 0) {
        // EOF before to.eof: the file no longer contains the full delta.
        res.error = "truncated";
        return res;
      }
      res.bytes_scanned += n;
      let cursor = 0;
      while (cursor < n) {
        const nl = chunk.indexOf(0x0a, cursor); // raw "\n"
        if (nl < 0 || nl >= n) {
          // No newline in the rest of this chunk — carry the tail over.
          const sliceLen = n - cursor;
          if (lineBytes + sliceLen <= maxLineBytes) {
            pendingBufs.push(Buffer.from(chunk.subarray(cursor, n)));
            pendingBytes += sliceLen;
          } else {
            pendingBufs = []; // over the cap: keep counting, stop buffering
            pendingBytes = 0;
          }
          lineBytes += sliceLen;
          break;
        }
        const tailLen = nl - cursor;
        const contentLen = lineBytes + tailLen;
        if (contentLen === 0) {
          res.skipped_blank += 1; // blank line: exactly 1 byte (its "\n")
        } else if (contentLen > maxLineBytes) {
          res.skipped_oversized += 1;
          res.skipped_oversized_bytes += contentLen + 1; // + its "\n"
        } else {
          let lineBuf;
          if (pendingBytes === 0) {
            lineBuf = chunk.subarray(cursor, nl); // no copy; consumed now
          } else {
            pendingBufs.push(Buffer.from(chunk.subarray(cursor, nl)));
            lineBuf = Buffer.concat(pendingBufs, contentLen);
          }
          res.lines += 1;
          res.bytes += contentLen + 1; // + terminating "\n"
          onLine(lineBuf.toString("utf8"), lineStart, contentLen);
        }
        pendingBufs = [];
        pendingBytes = 0;
        lineBytes = 0;
        lineStart = pos + nl + 1;
        cursor = nl + 1;
      }
      pos += n;
    }
    if (lineBytes > 0) {
      // The region [from.eof, to.eof) did not end in "\n": byte to.eof - 1
      // is not a line boundary in the CURRENT file. to.eof was newline-safe
      // when captured, so the file was rewritten under us — fail closed.
      res.error = "torn-boundary";
      return res;
    }
    return res;
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

/**
 * serializeCheckpoint — validated, deep-copied, JSON-safe plain object
 * suitable for the CALLER to embed in its own cache file. Returns null on
 * invalid input. Never throws.
 */
export function serializeCheckpoint(cp) {
  if (!isValidCheckpoint(cp)) return null;
  return copyCheckpoint(cp);
}

/**
 * deserializeCheckpoint — accepts the object form or a JSON string;
 * strictly validates (v === 1, algo === "sha256", non-negative-integer
 * size/eof, eof <= size, witness entries { off, len, hash } with
 * non-negative-integer off/len, len >= 1, off + len <= eof, hash a 64-char
 * lowercase hex string). Returns a fresh checkpoint object, or null on
 * anything malformed. Never throws.
 */
export function deserializeCheckpoint(value) {
  let cp = value;
  if (typeof cp === "string") {
    try {
      cp = JSON.parse(cp);
    } catch {
      return null;
    }
  }
  if (!isValidCheckpoint(cp)) return null;
  return copyCheckpoint(cp);
}

/**
 * emptyCheckpoint — the origin cursor. verifyPrefix on it succeeds against
 * ANY existing file (empty prefix, empty witness), and
 * `readAppended(path, emptyCheckpoint(), cp, onLine)` replays every
 * terminated row from byte 0.
 */
export function emptyCheckpoint() {
  return {
    v: CHECKPOINT_VERSION,
    algo: "sha256",
    size: 0,
    eof: 0,
    mtimeMs: null,
    ino: null,
    witness: [],
  };
}
