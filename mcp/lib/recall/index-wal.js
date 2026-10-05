// index-wal.js — S2: append-only sequenced WAL + single-writer flush lease
// for the BM25/HNSW index-mutation journal.
//
// DEFECT CLASS THIS MODULE CLOSES (see mcp/test/recall/index-wal.test.mjs T1):
//   The pre-S2 pending-adds.jsonl journal was truncated to empty at every
//   successful flush (index-cache.js pre-S2 :425-433). A record appended by
//   process B after process A began saving was ERASED: neither in A's saved
//   base nor in the journal afterward — a permanent multi-process lost
//   update. The WAL replaces truncation with a monotonic per-record `seq`
//   plus an "applied cursor" sidecar: flushing RETIRES records by advancing
//   the cursor, never by destroying bytes another process may still need.
//
// FILES (all inside the caller-passed indices/<modelVersion>/ dir — the
// per-model-version discipline of index-cache.js indexPathsFor):
//   index-wal.jsonl         — the WAL. One record per line:
//                             {"seq":N,"crc":"<8-hex>","rec":<payload>}
//                             crc = node:zlib crc32 (unsigned, lowercase hex,
//                             zero-padded to 8) over the EXACT serialized
//                             `rec` bytes as they sit on disk.
//   index-wal.applied.json  — applied cursor {applied_seq, applied_offset}.
//                             A plain JSON-safe value (S3's generation
//                             manifest embeds it verbatim; no hidden state).
//   index-wal.lock          — the flush lease (single-writer persist).
//   index-wal.append.lock   — append micro-lock (sub-ms hold; serializes
//                             seq assignment + torn-tail repair + append).
//   index-wal.quarantine.json — structured quarantine log (S2d): one event
//                             per quarantined WAL, surfaced by memory_health
//                             as an `index_wal_quarantined:` health_note.
//   index-wal.jsonl.corrupt-<epoch-ms> — a quarantined corrupt WAL (S2d).
//                             Quarantine RENAMES, never unlinks: every byte
//                             of a corrupt WAL is retained for operator
//                             repair; only the active stream is reset.
//   index-wal.corrupt-strike.json — persisted corruption strike (S2y). The
//                             flush path's first sighting of a WAL tail
//                             error records {error, ts, pid} here so a
//                             SECOND sighting of the same error in ANY
//                             process quarantines. Pre-S2y the 2-strike
//                             counter was process-memory only, and the
//                             per-session MCP spawn meant every session was
//                             forever "attempt #1" — the WAL grew unboundedly
//                             and quarantine never fired. Cleared on any
//                             successful quarantine and on the next clean
//                             flush-path tail read.
//
// LOCK DISCIPLINE — canonical acquireExclusiveLockFile, byte-for-byte:
//   kb/architecture.md § "acquireExclusiveLockFile (canonical lock
//   discipline)" (kb/architecture.md:233-249); reference implementation
//   mcp/lib/nonce-store.js acquireLock/reclaimStaleLockIfDead/releaseLock.
//   O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW create, body
//   JSON.stringify({pid, heartbeat_ts}) at 0600, post-open nlink===1 check,
//   stale reclaim = mtime age > ttl AND best-effort process.kill(pid,0) →
//   ESRCH, release = closeSync then unlinkSync tolerating ENOENT.
//   DOCUMENTED DEVIATION 1 (flush lease only): acquireFlushLease is a
//   NON-BLOCKING try-acquire — contention returns null (the caller skips the
//   flush; the WAL keeps the data) instead of retry-with-backoff. The append
//   micro-lock keeps the canonical bounded retry. ttl defaults to
//   CAPS.STALE_LOCK_RECOVERY_SECONDS * 1000, injectable for tests.
//   DOCUMENTED DEVIATION 2 (S2.2, flush lease only): canonical step 4
//   mandates a heartbeat every STALE_LOCK_RECOVERY_SECONDS/2 during long
//   holds; _flushPendingSaves (index-cache.js) heartbeats exactly ONCE,
//   immediately before saveIndices. A periodic interval CANNOT close this
//   gap: saveIndices is fully synchronous (writeSync loops + native
//   writeIndexSync), so no timer fires while it runs, and its internals are
//   contractually unchanged. MEASURED 2026-07-14 (Darwin/APFS, this host): a
//   production-scale save — 1,903,783,768 bytes, the exact size of the live
//   qwen3-embedding-8b-fp16/hnsw.bin — costs 0.83s wall for the dominant
//   write+fsync+rename, ~70x inside the 60s ttl; index growth (~30 MB/day)
//   keeps decades of margin. The gap is additionally only LATENT single-host:
//   stale reclaim requires mtime age > ttl AND a dead pid, and the flushing
//   process is alive mid-save, so the lease cannot be reclaimed under it.
//   CAVEAT (kb/architecture.md step 5): cross-host (NFS/containers) the pid
//   check is best-effort and mtime is the LOAD-BEARING predicate — if these
//   indices ever move to shared storage, this deviation must be closed by
//   threading heartbeats into the save itself. See kb/architecture.md
//   § acquireExclusiveLockFile, "Sanctioned deviations".
//
// FAIL-CLOSED CONTRACT: readWalTail stops at the FIRST crc-mismatched,
// unparseable, or seq-discontinuous record — it delivers nothing at or after
// the bad record and sets `error`; a corrupt record is never silently
// skipped, and callers must never advance the cursor past it. A torn final
// line (no trailing "\n" — a crashed append) is NOT an error: it is stopped
// before and excluded from lastOffset; the next appendWalRecord repairs it
// under the append micro-lock (the torn bytes were never acknowledged — the
// crashed append threw before returning, so the caller's index-failure
// handling already fired).
//
// SEQ IS MONOTONIC FOREVER: compactWal empties the WAL file once everything
// is applied, but applied_seq is NEVER reset — the next append continues at
// applied_seq + 1. S3's manifest activation binds to this invariant.
// S2y extends it across the APPEND-PATH QUARANTINE: quarantining a WAL whose
// FINAL record is corrupt (1) carries the valid unretired prefix forward into
// the fresh WAL and (2) reseeds the applied cursor at max(last good seq, the
// corrupt record's framed seq) so no seq is ever issued to two different
// facts — another process's warm {walSeq} marker can therefore never filter
// out a post-quarantine record as "already seen". applied_seq only ever moves
// FORWARD, and nothing above the reseeded floor is retired unpersisted: the
// carried records are re-appended ABOVE the floor before any of them could
// be considered retired. (The FLUSH-path quarantine is unchanged: it
// persists+retires the valid prefix first and parks everything at/after the
// corruption; records past a corruption were never delivered to any reader,
// so no live marker can sit above the retired floor there — except under
// post-absorption in-place bitrot, which the warm-marker inode re-bootstrap
// in index-cache.js _absorbWalTail heals on the quarantine's inode swap.)
//
// MODULE DISCIPLINE (mirrors mcp/lib/synthesis/ledger-checkpoint.js:57-63):
//   ESM, node stdlib only, no module-scope mutable state, pure functions
//   over a caller-passed dir. fs errors are RETURN VALUES, not throws — sole
//   exception: appendWalRecord throws, so the caller's existing
//   index-append-failure handling fires (the fact's ledger row is already
//   durable; backfill repairs later). This layer NEVER reads or writes
//   ledgers/memory.jsonl.

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  ftruncateSync,
  futimesSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { crc32 } from "node:zlib";
import { CAPS } from "../validation.js";

export const WAL_FILE = "index-wal.jsonl";
export const WAL_CURSOR_FILE = "index-wal.applied.json";
export const WAL_LEASE_FILE = "index-wal.lock";
export const WAL_APPEND_LOCK_FILE = "index-wal.append.lock";
// S2d — structured quarantine log; memory_health surfaces its events as
// health_notes so a quarantined WAL is operator-visible, not stderr-only.
export const WAL_QUARANTINE_NOTE_FILE = "index-wal.quarantine.json";
const WAL_QUARANTINE_NOTE_CAP = 20; // keep the newest N events (tiny file)

// Canonical lock caps (kb/architecture.md:249): STALE_LOCK_RECOVERY_SECONDS
// is both the bounded-retry budget and the stale threshold; 25ms backoff.
const LOCK_BACKOFF_MS = 25;

// Same fd discipline as index-cache.js's ledger/journal appends
// (pre-S2 :358-376): O_APPEND so the kernel serializes writes at the byte
// boundary, O_NOFOLLOW so we never write through a symlink, O_CREAT at 0o600
// for first touch. O_RDWR (not O_WRONLY) because the appender also reads the
// tail backward for seq assignment and repairs a torn tail via ftruncate.
const WAL_APPEND_FLAGS =
  fsConstants.O_RDWR |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_NOFOLLOW;

const LOCK_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  fsConstants.O_NOFOLLOW;

const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;

const READ_CHUNK = 256 * 1024; // records are ~40-80 KB; a chunk spans a few

// ---------------------------------------------------------------------------
// Line framing
// ---------------------------------------------------------------------------

// The writer emits EXACTLY this frame, so the reader can slice the exact
// `rec` byte range back out of the line for crc verification (JSON.parse +
// re-stringify is NOT byte-stable for numeric-like object keys).
const WAL_LINE_PREFIX_RE = /^\{"seq":(\d+),"crc":"([0-9a-f]{8})","rec":/;

function crcHex(buf) {
  return (crc32(buf) >>> 0).toString(16).padStart(8, "0");
}

// Build one framed WAL line (Buffer, WITH trailing "\n") for a payload at a
// given seq — the single definition of the on-disk frame, shared by
// appendWalRecord and the quarantine requeue path (S2y) so the two can never
// drift.
function walFrameLine(seq, payload) {
  const recStr = JSON.stringify(payload);
  return Buffer.from(
    `{"seq":${seq},"crc":"${crcHex(Buffer.from(recStr, "utf8"))}","rec":${recStr}}\n`,
    "utf8",
  );
}

// Parse one complete WAL line (WITHOUT its trailing "\n"). Returns
// {seq, rec} or {error: string}. crc is verified over the exact rec bytes.
function parseWalLine(line) {
  const m = WAL_LINE_PREFIX_RE.exec(line);
  if (m == null || line[line.length - 1] !== "}") {
    return { error: "unparseable WAL line (bad framing)" };
  }
  const seq = Number(m[1]);
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    return { error: `invalid seq ${m[1]}` };
  }
  const recStr = line.slice(m[0].length, line.length - 1);
  const got = crcHex(Buffer.from(recStr, "utf8"));
  if (got !== m[2]) {
    return { error: `crc mismatch at seq ${seq} (recorded ${m[2]}, computed ${got})` };
  }
  let rec;
  try {
    rec = JSON.parse(recStr);
  } catch (e) {
    return { error: `rec unparseable at seq ${seq}: ${e.message}` };
  }
  return { seq, rec };
}

// ---------------------------------------------------------------------------
// Lock primitives (canonical acquireExclusiveLockFile — see module header)
// ---------------------------------------------------------------------------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === "ESRCH") return false;
    return true; // EPERM etc: process exists
  }
}

function tryCreateLock(lockPath) {
  let fd;
  try {
    fd = openSync(lockPath, LOCK_FLAGS, 0o600);
  } catch (e) {
    if (e && e.code === "EEXIST") return { fd: null, busy: true };
    return { fd: null, busy: false, error: e.message };
  }
  try {
    // Post-open nlink===1 check: defeats swap-during-acquire (another
    // process unlink+recreate between our open and our write).
    if (fstatSync(fd).nlink !== 1) {
      closeSync(fd);
      return { fd: null, busy: true };
    }
    const body = Buffer.from(
      JSON.stringify({ pid: process.pid, heartbeat_ts: new Date().toISOString() }),
      "utf8",
    );
    let written = 0;
    while (written < body.length) {
      written += writeSync(fd, body, written, body.length - written);
    }
    fsyncSync(fd);
    return { fd, busy: false };
  } catch (e) {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
    return { fd: null, busy: false, error: e.message };
  }
}

// Stale reclaim (canonical step 5): mtime age > ttl AND best-effort pid-dead.
// Returns true iff the sidecar was removed.
function reclaimStaleLock(lockPath, ttlMs) {
  let st;
  try {
    st = statSync(lockPath);
  } catch (e) {
    return e && e.code === "ENOENT"; // already gone → effectively reclaimed
  }
  if (Date.now() - st.mtimeMs <= ttlMs) return false;
  let pid = null;
  try {
    const body = JSON.parse(readFileSync(lockPath, "utf8"));
    if (Number.isInteger(body.pid)) pid = body.pid;
  } catch {
    // unreadable body: best-effort pid check cannot pass — treat as dead
  }
  if (pid != null && pidAlive(pid)) return false;
  try {
    unlinkSync(lockPath);
  } catch (e) {
    if (!(e && e.code === "ENOENT")) return false;
  }
  return true;
}

function releaseLockFile(fd, lockPath) {
  try {
    closeSync(fd);
  } catch {
    // ignore
  }
  try {
    unlinkSync(lockPath);
  } catch (e) {
    if (!(e && e.code === "ENOENT")) {
      // Non-fatal: the next acquirer's stale-reclaim recovers. Never throw
      // out of a release path.
    }
  }
}

function defaultTtlMs(ttlMs) {
  return Number.isFinite(ttlMs) && ttlMs > 0
    ? ttlMs
    : CAPS.STALE_LOCK_RECOVERY_SECONDS * 1000;
}

// Append micro-lock: canonical bounded retry (budget = ttl wall-clock, 25ms
// backoff, stale reclaim between attempts). Holds are sub-millisecond, so
// contention is rare and short. Throws on budget exhaustion (append path is
// the one throwing surface of this module).
function acquireAppendLock(dir, ttlMs) {
  const lockPath = join(dir, WAL_APPEND_LOCK_FILE);
  const budget = defaultTtlMs(ttlMs);
  const start = Date.now();
  for (;;) {
    const r = tryCreateLock(lockPath);
    if (r.fd != null) return { fd: r.fd, path: lockPath };
    if (!r.busy) {
      throw new Error(`index-wal: append lock create failed: ${r.error}`);
    }
    reclaimStaleLock(lockPath, budget);
    if (Date.now() - start >= budget) {
      throw new Error("index-wal: could not acquire append lock within budget");
    }
    const deadline = Date.now() + LOCK_BACKOFF_MS;
    while (Date.now() < deadline) {
      // intentional short sync spin (matches nonce-store.js acquireLock) —
      // avoids event-loop hooks inside a tight sync acquisition path.
    }
  }
}

// ---------------------------------------------------------------------------
// Applied cursor sidecar
// ---------------------------------------------------------------------------

/**
 * readAppliedCursor(dir) → {applied_seq, applied_offset, error}
 * Missing sidecar → zeros (a fresh WAL). Malformed sidecar → error value;
 * callers MUST fail closed (serve/replay is still safe because replay is
 * idempotent, but retirement must not advance).
 */
export function readAppliedCursor(dir) {
  const p = join(dir, WAL_CURSOR_FILE);
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return { applied_seq: 0, applied_offset: 0, error: null };
    }
    return { applied_seq: 0, applied_offset: 0, error: `cursor read failed: ${e.message}` };
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    return { applied_seq: 0, applied_offset: 0, error: `cursor malformed: ${e.message}` };
  }
  if (
    j == null ||
    typeof j !== "object" ||
    !Number.isSafeInteger(j.applied_seq) ||
    j.applied_seq < 0 ||
    !Number.isSafeInteger(j.applied_offset) ||
    j.applied_offset < 0
  ) {
    return { applied_seq: 0, applied_offset: 0, error: "cursor malformed: bad shape" };
  }
  return { applied_seq: j.applied_seq, applied_offset: j.applied_offset, error: null };
}

/**
 * advanceAppliedCursor(dir, {applied_seq, applied_offset}) → {ok, error}
 * Atomic tmp + fsync + rename. The cursor is a plain JSON-safe value —
 * S3's generation manifest embeds it verbatim.
 */
export function advanceAppliedCursor(dir, { applied_seq, applied_offset } = {}) {
  if (
    !Number.isSafeInteger(applied_seq) ||
    applied_seq < 0 ||
    !Number.isSafeInteger(applied_offset) ||
    applied_offset < 0
  ) {
    return { ok: false, error: "invalid cursor value" };
  }
  const p = join(dir, WAL_CURSOR_FILE);
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    const bytes = Buffer.from(JSON.stringify({ applied_seq, applied_offset }), "utf8");
    const fd = openSync(
      tmp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      let written = 0;
      while (written < bytes.length) {
        written += writeSync(fd, bytes, written, bytes.length - written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, p);
    return { ok: true, error: null };
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort tmp cleanup
    }
    return { ok: false, error: `cursor write failed: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Corruption quarantine (S2d)
// ---------------------------------------------------------------------------

// Atomic small-file write: tmp + fsync + rename (same discipline as
// advanceAppliedCursor). Throws on failure — callers decide tolerance.
function writeSmallFileAtomic(p, bytes) {
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    const fd = openSync(
      tmp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      let written = 0;
      while (written < bytes.length) {
        written += writeSync(fd, bytes, written, bytes.length - written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, p);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort tmp cleanup
    }
    throw e;
  }
}

// Append one structured quarantine event to index-wal.quarantine.json
// (bounded to the newest WAL_QUARANTINE_NOTE_CAP events). Best-effort: a
// note-write failure must never block the quarantine recovery itself.
function appendQuarantineNote(dir, event) {
  const p = join(dir, WAL_QUARANTINE_NOTE_FILE);
  let events = [];
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (j != null && Array.isArray(j.events)) events = j.events;
  } catch {
    // missing/unreadable log: start fresh (the .corrupt-* files on disk
    // remain the ground truth; this log is the operator-visibility index)
  }
  events.push(event);
  if (events.length > WAL_QUARANTINE_NOTE_CAP) {
    events = events.slice(-WAL_QUARANTINE_NOTE_CAP);
  }
  try {
    writeSmallFileAtomic(p, Buffer.from(JSON.stringify({ events }), "utf8"));
  } catch (e) {
    console.error(`index-wal: quarantine note write failed: ${e.message}`);
  }
}

/**
 * readWalQuarantineNotes(dir) → {events: Array}
 * Never throws; missing/unreadable log → {events: []}. Each event is
 * {ts, reason, quarantined_file, applied_seq, pid}. memory_health surfaces
 * the newest event per model version as an `index_wal_quarantined:` note.
 */
export function readWalQuarantineNotes(dir) {
  try {
    const j = JSON.parse(readFileSync(join(dir, WAL_QUARANTINE_NOTE_FILE), "utf8"));
    if (j != null && Array.isArray(j.events)) return { events: j.events };
  } catch {
    // fall through
  }
  return { events: [] };
}

// ---------------------------------------------------------------------------
// S2y — persisted corruption strike (cross-process 2-strike)
// ---------------------------------------------------------------------------
// The flush path's "possibly transient, refuse once" policy needs its strike
// to OUTLIVE the process: the production MCP server is spawned per session,
// so an in-memory counter meant every session refused once and exited —
// attempt #1 forever, the WAL growing unboundedly, quarantine never firing.
// The sidecar records the exact error string; a second sighting of the SAME
// error in ANY process is treated as persistent corruption. (A complete,
// newline-terminated record with a crc mismatch is essentially never
// transient — torn tails are already non-errors in readWalTail — so one
// persisted confirmation is a conservative bar.)

export const WAL_CORRUPT_STRIKE_FILE = "index-wal.corrupt-strike.json";

/**
 * readCorruptStrike(dir) → {error, ts, pid} | null. Never throws; a
 * missing/unreadable/malformed sidecar reads as "no strike".
 */
export function readCorruptStrike(dir) {
  try {
    const j = JSON.parse(readFileSync(join(dir, WAL_CORRUPT_STRIKE_FILE), "utf8"));
    if (j != null && typeof j === "object" && typeof j.error === "string") {
      return j;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * recordCorruptStrike(dir, error) — persist the first sighting. Best-effort:
 * a strike-write failure must never turn a fail-closed refusal into a crash
 * (the in-process counter still provides the 2-strike within one lifetime).
 */
export function recordCorruptStrike(dir, error) {
  try {
    writeSmallFileAtomic(
      join(dir, WAL_CORRUPT_STRIKE_FILE),
      Buffer.from(
        JSON.stringify({
          error: String(error),
          ts: new Date().toISOString(),
          pid: process.pid,
        }),
        "utf8",
      ),
    );
  } catch (e) {
    console.error(`index-wal: corrupt-strike write failed: ${e.message}`);
  }
}

/**
 * clearCorruptStrike(dir) — remove a stale strike (after a successful
 * quarantine, or when a later flush reads the tail cleanly). Never throws.
 */
export function clearCorruptStrike(dir) {
  const p = join(dir, WAL_CORRUPT_STRIKE_FILE);
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    // best-effort; a leftover strike only ever accelerates a quarantine of
    // a WAL that reproduces the exact same error string
  }
}

// Quarantine worker — CALLER MUST HOLD THE APPEND MICRO-LOCK. Renames the
// corrupt WAL to index-wal.jsonl.corrupt-<epoch-ms> (NEVER unlinks — every
// byte is retained for operator repair) and resets the active stream: the
// cursor is rewritten to {floor, offset 0} FIRST (offset 0 never aliases a
// non-empty WAL — the compactWal ordering discipline), then the rename
// removes the corrupt file, then (S2y, append path only) the caller's
// carried valid-prefix records are re-appended to the fresh WAL as
// floor+1..; the next append seeds seq past them.
//
// S2y opts:
//   reseedSeq — advance the cursor floor to this seq (only ever FORWARD;
//     values <= applied_seq are ignored). The append path passes
//     max(last good seq, corrupt record's framed seq) so no issued seq is
//     ever reissued to a different fact.
//   requeue — the valid unretired records (seq > applied_seq, in order) to
//     carry forward into the fresh WAL above the reseeded floor. Nothing
//     above the floor is ever retired unpersisted: the floor covers only
//     seqs whose records are either retired, corrupt (parked in the
//     .corrupt file), or re-appended above it here.
//
// CRASH ORDERING (all points keep seq monotonic): a crash after the cursor
// rewrite but before the rename leaves the corrupt WAL under a {floor, 0}
// cursor — readers fail closed at the corruption and deliver nothing above
// the floor; the next append re-detects the corruption and retries (its
// requeue scan then finds nothing above the raised floor, so the carried
// records of THIS interrupted attempt remain operator-recoverable in the
// corrupt file only — the documented crash-window loss, identical to
// pre-S2y behavior). A crash after the rename but before the requeue writes
// leaves a fresh (possibly partial-prefix) WAL whose next append seeds from
// the floor/tail — no reuse, no gap.
function quarantineWalLocked(dir, reason, opts = {}) {
  const walPath = join(dir, WAL_FILE);
  const cursor = readAppliedCursor(dir);
  if (cursor.error != null) {
    return { quarantined: false, error: `cursor unreadable: ${cursor.error}` };
  }
  const floor =
    Number.isSafeInteger(opts.reseedSeq) && opts.reseedSeq > cursor.applied_seq
      ? opts.reseedSeq
      : cursor.applied_seq;
  const adv = advanceAppliedCursor(dir, {
    applied_seq: floor,
    applied_offset: 0,
  });
  if (adv.error != null) return { quarantined: false, error: adv.error };
  const dest = `${walPath}.corrupt-${Date.now()}`;
  try {
    renameSync(walPath, dest);
  } catch (e) {
    if (e && e.code === "ENOENT") {
      // Already gone (another process completed a quarantine) — nothing to do.
      return { quarantined: false, error: null };
    }
    return { quarantined: false, error: `quarantine rename failed: ${e.message}` };
  }
  // S2y: re-append the carried valid unretired prefix to the fresh WAL,
  // preserving relative order, as floor+1... Failure here is reported as a
  // breadcrumb, never an error: the quarantine itself succeeded, the bytes
  // are retained in the corrupt file, and the stream stays gap-free (the
  // written prefix is contiguous from floor+1).
  let requeued = 0;
  if (Array.isArray(opts.requeue) && opts.requeue.length > 0) {
    try {
      const fd = openSync(walPath, WAL_APPEND_FLAGS, 0o600);
      try {
        for (const rec of opts.requeue) {
          const line = walFrameLine(floor + requeued + 1, rec);
          let written = 0;
          while (written < line.length) {
            written += writeSync(fd, line, written, line.length - written);
          }
          requeued += 1;
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      console.error(
        `index-wal: requeue of ${opts.requeue.length - requeued} carried ` +
          `record(s) failed after quarantine: ${e.message} (bytes retained ` +
          `in ${basename(dest)})`,
      );
    }
  }
  // Any successful quarantine clears a persisted strike: the corrupt WAL the
  // strike described no longer exists on the active path.
  clearCorruptStrike(dir);
  const event = {
    ts: new Date().toISOString(),
    reason: String(reason),
    quarantined_file: basename(dest),
    applied_seq: cursor.applied_seq,
    reseed_seq: floor,
    requeued,
    pid: process.pid,
  };
  appendQuarantineNote(dir, event);
  console.error(
    `index-wal: quarantined corrupt WAL to ${dest} (reason: ${reason}); ` +
      `stream reseeded at applied_seq ${floor}` +
      (requeued > 0 ? ` with ${requeued} carried record(s)` : ""),
  );
  return { quarantined: true, error: null, quarantinedFile: dest, requeued };
}

/**
 * quarantineWal(dir, {reason, ttlMs}) → {quarantined, error, quarantinedFile?}
 *
 * S2d corruption operability: called on a PERSISTENT readWalTail crc/seq-gap
 * error (the flush path in index-cache.js) after the valid prefix has been
 * persisted and retired. Takes the append micro-lock so no append interleaves
 * with the rename. fs errors are return values; never throws.
 */
export function quarantineWal(dir, opts = {}) {
  let lock;
  try {
    lock = acquireAppendLock(dir, opts.ttlMs);
  } catch (e) {
    return { quarantined: false, error: e.message };
  }
  try {
    return quarantineWalLocked(dir, opts.reason || "unspecified corruption");
  } finally {
    releaseLockFile(lock.fd, lock.path);
  }
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

// Read exactly buf.length bytes at absolute offset `pos`. Throws on short
// read (append path — throwing surface).
function readFullyAt(fd, buf, pos) {
  let off = 0;
  while (off < buf.length) {
    const n = readSync(fd, buf, off, buf.length - off, pos + off);
    if (n === 0) throw new Error("index-wal: short read scanning WAL tail");
    off += n;
  }
}

// Backward tail scan: find the LAST complete (newline-terminated) record
// without ever reading the whole file. Returns
//   { lastSeq: number|null, appendAt: number, torn: number, corrupt: string|null }
// lastSeq null ⇔ no complete record; appendAt = offset just past the last
// "\n" (where the next record belongs); torn = trailing bytes with no "\n".
// S2d: an UNREADABLE last complete record no longer throws — it is reported
// as `corrupt` so callers can quarantine (appendWalRecord) or fail closed
// (readWalTail EOF check, compactWal) instead of bricking every append.
function scanWalTail(fd, size) {
  if (size === 0) return { lastSeq: null, appendAt: 0, torn: 0, corrupt: null };
  let start = size; // absolute offset of win[0]
  let win = Buffer.alloc(0);
  // Expand backward until the window holds two newlines (last complete line
  // fully delimited) or covers the whole file.
  for (;;) {
    let nl = 0;
    for (let i = 0; i < win.length; i++) if (win[i] === 0x0a) nl += 1;
    if (nl >= 2 || start === 0) break;
    const newStart = Math.max(0, start - READ_CHUNK);
    const part = Buffer.alloc(start - newStart);
    readFullyAt(fd, part, newStart);
    win = Buffer.concat([part, win]);
    start = newStart;
  }
  const lastNlRel = win.lastIndexOf(0x0a);
  if (lastNlRel < 0) {
    // Whole file is a single torn line — never a completed append.
    return { lastSeq: null, appendAt: 0, torn: size, corrupt: null };
  }
  const appendAt = start + lastNlRel + 1;
  let prevNlRel = -1;
  for (let i = lastNlRel - 1; i >= 0; i--) {
    if (win[i] === 0x0a) {
      prevNlRel = i;
      break;
    }
  }
  const line = win.subarray(prevNlRel + 1, lastNlRel).toString("utf8");
  const parsed = parseWalLine(line);
  if (parsed.error) {
    // S2y: even when the record is bad, its FRAMED seq (when the framing
    // still parses — the crc-mismatch case) is a previously-ISSUED seq the
    // quarantine reseed must never reissue. Report it as corruptSeq.
    const fm = WAL_LINE_PREFIX_RE.exec(line);
    const framedSeq = fm != null ? Number(fm[1]) : null;
    return {
      lastSeq: null,
      appendAt,
      torn: size - appendAt,
      corrupt: `last WAL record unreadable: ${parsed.error}`,
      corruptSeq: Number.isSafeInteger(framedSeq) && framedSeq > 0 ? framedSeq : null,
    };
  }
  return { lastSeq: parsed.seq, appendAt, torn: size - appendAt, corrupt: null };
}

/**
 * appendWalRecord(dir, payload, opts) → {seq, offset}
 *
 * Under the append micro-lock: assigns seq = last complete record's seq + 1
 * (backward tail read — never a full-file read; empty/missing WAL falls back
 * to readAppliedCursor().applied_seq + 1 so seq stays monotonic across
 * compaction), repairs a torn tail (ftruncate of never-acknowledged bytes),
 * then appends ONE frame line with a single write loop + single fsync.
 *
 * THROWS on any failure — the sole throwing surface of this module, so the
 * caller's existing index-append-failure handling fires (the fact's ledger
 * row is already durable). `offset` is the byte just past this record's
 * trailing "\n" (i.e. the applied_offset a consumer records after applying
 * this record).
 *
 * S2d: a corrupt FINAL record no longer throws forever (pre-S2d that bricked
 * every promote for the model version — seq assignment was impossible). The
 * corrupt WAL is quarantined (renamed, never unlinked; structured note
 * emitted) and the append proceeds on a fresh WAL seeded from the applied
 * cursor. Only a FAILED quarantine still throws.
 */
export function appendWalRecord(dir, payload, opts = {}) {
  if (payload == null || typeof payload !== "object") {
    throw new TypeError("appendWalRecord: payload object required");
  }
  const lock = acquireAppendLock(dir, opts.ttlMs);
  try {
    const walPath = join(dir, WAL_FILE);
    let fd = openSync(walPath, WAL_APPEND_FLAGS, 0o600);
    try {
      let size = fstatSync(fd).size;
      let tail = scanWalTail(fd, size);
      if (tail.corrupt != null) {
        // S2d quarantine path (we already hold the append micro-lock). Every
        // byte of the quarantined WAL stays retained in the
        // .corrupt-<epoch-ms> file.
        //
        // S2y: before the rename, forward-scan the corrupt WAL's VALID
        // UNRETIRED prefix (everything readWalTail would deliver: seq >
        // applied_seq, stopping fail-closed at the first bad record) so
        // quarantineWalLocked can carry those records into the fresh WAL —
        // pre-S2y they silently left the active stream and their seqs were
        // reissued to different facts. The reseed floor is max(last good
        // seq, corrupt record's framed seq): every previously-issued seq
        // stays issued forever (monotonic across quarantine — the identity
        // S3's manifest binds to).
        const cursor = readAppliedCursor(dir);
        let requeue = [];
        let reseedSeq = null;
        if (cursor.error == null) {
          let lastGood = cursor.applied_seq;
          try {
            const scan = scanRecords(
              fd,
              size,
              0,
              cursor.applied_seq,
              (rec) => requeue.push(rec),
              false,
            );
            if (Number.isSafeInteger(scan.lastSeq)) lastGood = scan.lastSeq;
          } catch (_e) {
            requeue = []; // unreadable prefix: carry nothing (fail-closed)
          }
          reseedSeq = Math.max(
            cursor.applied_seq,
            lastGood,
            Number.isSafeInteger(tail.corruptSeq) ? tail.corruptSeq : 0,
          );
        }
        const q = quarantineWalLocked(dir, `append: ${tail.corrupt}`, {
          reseedSeq,
          requeue,
        });
        if (q.error != null) {
          throw new Error(
            `index-wal: ${tail.corrupt}; quarantine failed: ${q.error}`,
          );
        }
        closeSync(fd);
        fd = openSync(walPath, WAL_APPEND_FLAGS, 0o600); // fresh WAL (carried prefix only)
        size = fstatSync(fd).size;
        tail = scanWalTail(fd, size);
      }
      if (tail.torn > 0) {
        // Torn-tail repair: those bytes belong to an append that crashed
        // before acknowledging (single write + fsync ordering), so no caller
        // ever saw them succeed. Removing them prevents the next record from
        // merging into an unparseable line.
        ftruncateSync(fd, tail.appendAt);
      }
      let seq;
      if (tail.lastSeq != null) {
        seq = tail.lastSeq + 1;
      } else {
        const cursor = readAppliedCursor(dir);
        if (cursor.error) {
          throw new Error(`appendWalRecord: cannot seed seq: ${cursor.error}`);
        }
        seq = cursor.applied_seq + 1;
      }
      const line = walFrameLine(seq, payload);
      let written = 0;
      while (written < line.length) {
        written += writeSync(fd, line, written, line.length - written);
      }
      fsyncSync(fd);
      return { seq, offset: tail.appendAt + line.length };
    } finally {
      try {
        closeSync(fd);
      } catch {
        // fd already closed on the quarantine reopen-failure path
      }
    }
  } finally {
    releaseLockFile(lock.fd, lock.path);
  }
}

// ---------------------------------------------------------------------------
// Tail read (replay)
// ---------------------------------------------------------------------------

/**
 * readWalTail(dir, {afterSeq, fromOffset}, onRecord)
 *   → {applied, lastSeq, lastOffset, error, ino}
 *
 * Delivers (via onRecord(rec, seq)) every record with seq > afterSeq, in
 * order. Fast path: seek to fromOffset and require the first record's
 * seq === afterSeq + 1 and contiguity thereafter. If the seek does not line
 * up (offset past EOF, mid-line garbage, or a first-seq mismatch — e.g.
 * after a compaction by another process), falls back ONCE to a full scan
 * from offset 0 delivering only seq > afterSeq (idempotent replay makes
 * over-delivery safe).
 *
 * FAIL-CLOSED: the first crc mismatch, unparseable line, or seq gap stops
 * the scan immediately — nothing at or after the bad record is delivered,
 * and `error` is set. lastSeq/lastOffset always describe the last GOOD
 * record (so a caller can retire up to, but never past, the corruption).
 * A torn final line (no "\n") is NOT an error: it is excluded from
 * lastOffset. Caller-callback throws propagate (a caller bug must be loud).
 *
 * S2y: `ino` is fstatSync(fd).ino of the fd this call ACTUALLY scanned
 * (null when the WAL is absent). Callers that pin an identity to the scan
 * result (index-cache.js's walCorruptIno / walIno markers) MUST pin THIS
 * value — a post-scan statSync of the path is a TOCTOU: a quarantine
 * landing between the scan and the stat would pin the FRESH WAL's inode
 * and freeze warm-hit absorption until the next inode swap.
 */
export function readWalTail(dir, { afterSeq = 0, fromOffset = 0 } = {}, onRecord) {
  if (typeof onRecord !== "function") {
    return { applied: 0, lastSeq: afterSeq, lastOffset: fromOffset, error: "invalid onRecord", ino: null };
  }
  const walPath = join(dir, WAL_FILE);
  let fd;
  try {
    fd = openSync(walPath, READ_FLAGS);
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return { applied: 0, lastSeq: afterSeq, lastOffset: 0, error: null, ino: null };
    }
    return { applied: 0, lastSeq: afterSeq, lastOffset: fromOffset, error: `open failed: ${e.message}`, ino: null };
  }
  try {
    let size;
    let ino = null;
    try {
      const st = fstatSync(fd);
      size = st.size;
      ino = st.ino;
    } catch (e) {
      return { applied: 0, lastSeq: afterSeq, lastOffset: fromOffset, error: `stat failed: ${e.message}`, ino: null };
    }
    if (fromOffset > 0 && fromOffset === size) {
      // Cursor is exactly at EOF — but S2c: byte-offset equality is NOT
      // identity. A compaction-crash + regrowth can alias the same size with
      // DIFFERENT, never-applied records (the ABA window T9a pins). Verify
      // the last complete record's seq === afterSeq (backward tail peek —
      // one bounded chunk read, never the whole file) before trusting EOF;
      // anything else falls through to the full scan (which delivers the
      // regrown records via the seq > afterSeq filter, or fails closed on
      // corruption).
      let tail = null;
      try {
        tail = scanWalTail(fd, size);
      } catch {
        tail = null; // short read etc: fall through to the full scan
      }
      if (tail != null && tail.corrupt == null && tail.lastSeq === afterSeq) {
        return { applied: 0, lastSeq: afterSeq, lastOffset: fromOffset, error: null, ino };
      }
      return { ...scanRecords(fd, size, 0, afterSeq, onRecord, false), ino };
    }
    if (fromOffset > 0 && fromOffset < size) {
      const fast = scanRecords(fd, size, fromOffset, afterSeq, onRecord, true);
      if (!fast.fallback) return { ...fast, ino };
      // fall through: ONE full scan from 0 (seq > afterSeq filter applies)
    }
    return { ...scanRecords(fd, size, 0, afterSeq, onRecord, false), ino };
  } finally {
    closeSync(fd);
  }
}

// Shared forward scanner. strict=true is the seek fast path: the FIRST
// record must have seq === afterSeq + 1 or we signal {fallback:true} WITHOUT
// having delivered anything. strict=false is the full scan: the first
// record's seq s0 must satisfy s0 <= afterSeq + 1 (no gap between the cursor
// and the head of the WAL), contiguity is required thereafter, and only
// records with seq > afterSeq are delivered.
function scanRecords(fd, size, startOffset, afterSeq, onRecord, strict) {
  let bufStart = startOffset; // absolute offset of buf[0]
  let buf = Buffer.alloc(0);
  let readPos = startOffset; // absolute offset of next byte to read
  let expected = null; // next expected seq (set from first record on full scan)
  let first = true;
  let applied = 0;
  let lastSeq = afterSeq;
  let lastOffset = startOffset;
  const out = () => ({ applied, lastSeq, lastOffset, error: null });

  for (;;) {
    let nl = buf.indexOf(0x0a);
    while (nl < 0 && readPos < size) {
      const len = Math.min(READ_CHUNK, size - readPos);
      const chunk = Buffer.alloc(len);
      let off = 0;
      while (off < len) {
        const n = readSync(fd, chunk, off, len - off, readPos + off);
        if (n === 0) {
          // File shrank under us (should not happen while the flush lease is
          // held); treat as truncated tail — stop cleanly at the last good
          // record.
          return out();
        }
        off += n;
      }
      readPos += len;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      nl = buf.indexOf(0x0a);
    }
    if (nl < 0) {
      // No further newline: any residue is a torn final line — not an error,
      // excluded from lastOffset.
      return out();
    }
    const line = buf.subarray(0, nl).toString("utf8");
    const lineEnd = bufStart + nl + 1;
    buf = buf.subarray(nl + 1);
    bufStart = lineEnd;

    const p = parseWalLine(line);
    if (p.error) {
      if (strict && first) return { fallback: true };
      return { applied, lastSeq, lastOffset, error: p.error };
    }
    if (first) {
      first = false;
      if (strict) {
        if (p.seq !== afterSeq + 1) return { fallback: true };
      } else if (p.seq > afterSeq + 1) {
        return {
          applied,
          lastSeq,
          lastOffset,
          error: `seq gap: WAL starts at ${p.seq}, cursor at ${afterSeq}`,
        };
      }
      expected = p.seq;
    }
    if (p.seq !== expected) {
      return {
        applied,
        lastSeq,
        lastOffset,
        error: `seq gap: expected ${expected}, found ${p.seq}`,
      };
    }
    expected += 1;
    if (p.seq > afterSeq) {
      onRecord(p.rec, p.seq);
      applied += 1;
    }
    lastSeq = p.seq;
    lastOffset = lineEnd;
  }
}

// ---------------------------------------------------------------------------
// Flush lease
// ---------------------------------------------------------------------------

/**
 * acquireFlushLease(dir, {ttlMs}) → handle | null
 *
 * Canonical acquireExclusiveLockFile (see module header) with the sole
 * documented deviation: NON-BLOCKING. Contention returns null — the caller
 * skips this flush (the WAL keeps the data; a later flush retires it). One
 * stale-reclaim attempt (mtime age > ttl AND best-effort pid-dead) is made
 * before giving up. Never throws; unexpected fs errors return null with a
 * stderr breadcrumb.
 */
export function acquireFlushLease(dir, { ttlMs } = {}) {
  const lockPath = join(dir, WAL_LEASE_FILE);
  const ttl = defaultTtlMs(ttlMs);
  let r = tryCreateLock(lockPath);
  if (r.fd != null) return { fd: r.fd, path: lockPath };
  if (!r.busy) {
    console.error(`index-wal: flush lease create failed: ${r.error}`);
    return null;
  }
  if (!reclaimStaleLock(lockPath, ttl)) return null;
  r = tryCreateLock(lockPath);
  if (r.fd != null) return { fd: r.fd, path: lockPath };
  if (!r.busy && r.error) {
    console.error(`index-wal: flush lease create failed: ${r.error}`);
  }
  return null;
}

/**
 * heartbeatLease(handle) → {ok, error}
 * Bumps the lock inode's mtime (canonical step 4: holders of long critical
 * sections MUST heartbeat every STALE_LOCK_RECOVERY_SECONDS / 2).
 */
export function heartbeatLease(handle) {
  if (handle == null || !Number.isInteger(handle.fd)) {
    return { ok: false, error: "invalid lease handle" };
  }
  try {
    const now = new Date();
    futimesSync(handle.fd, now, now);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * releaseLease(handle) — canonical step 7: closeSync then unlinkSync,
 * tolerating ENOENT (another process's stale-reclaim may have removed it).
 * Never throws.
 */
export function releaseLease(handle) {
  if (handle == null || !Number.isInteger(handle.fd)) return;
  releaseLockFile(handle.fd, handle.path);
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/**
 * compactWal(dir, opts) → {compacted, error}
 *
 * CALLER MUST HOLD THE FLUSH LEASE (single writer). Additionally takes the
 * append micro-lock so no append can interleave with the empty-file swap.
 * Iff the applied cursor covers the ENTIRE WAL (applied_offset ===
 * fstat(wal).size AND — S2c — the last complete record's seq ===
 * applied_seq; byte-offset equality alone is not identity, see the ABA
 * window T9b pins), rewrites the cursor to {applied_seq: unchanged,
 * applied_offset: 0} and THEN atomically replaces the WAL with an empty
 * file.
 *
 * S2.1 ORDER: cursor FIRST, swap second. Offset 0 never aliases a non-empty
 * WAL, so a crash after the cursor rewrite but before the swap is covered by
 * the full scan's seq > afterSeq filter (nothing re-delivered, nothing
 * lost). The pre-fix order (swap first) left a stale {applied_seq, S} cursor
 * over an empty WAL on crash — and a WAL regrown to exactly S bytes was then
 * skipped by replay and DESTROYED by the next compaction (T9a/T9b). If the
 * cursor rewrite fails, we return WITHOUT swapping.
 *
 * seq NEVER resets: the next append seeds from applied_seq + 1 (S3's binding
 * invariant — monotonic across compactions). fs errors are return values.
 */
export function compactWal(dir, opts = {}) {
  let lock;
  try {
    lock = acquireAppendLock(dir, opts.ttlMs);
  } catch (e) {
    return { compacted: false, error: e.message };
  }
  try {
    const cursor = readAppliedCursor(dir);
    if (cursor.error) return { compacted: false, error: cursor.error };
    const walPath = join(dir, WAL_FILE);
    let size;
    try {
      size = statSync(walPath).size;
    } catch (e) {
      if (e && e.code === "ENOENT") return { compacted: false, error: null };
      return { compacted: false, error: `stat failed: ${e.message}` };
    }
    if (size === 0) return { compacted: false, error: null }; // already empty
    if (cursor.applied_offset !== size) {
      // Unapplied tail exists (e.g. a record appended mid-save stayed
      // unretired) — never destroy it.
      return { compacted: false, error: null };
    }
    // S2c seq-identity verification: the record ENDING at applied_offset must
    // be the one the cursor retired. A regrown same-size WAL (or a corrupt
    // tail) fails this check and is never destroyed.
    let tail;
    try {
      const rfd = openSync(walPath, READ_FLAGS);
      try {
        tail = scanWalTail(rfd, size);
      } finally {
        closeSync(rfd);
      }
    } catch (e) {
      return { compacted: false, error: `tail verify failed: ${e.message}` };
    }
    if (tail.corrupt != null || tail.lastSeq !== cursor.applied_seq) {
      return {
        compacted: false,
        error:
          `refusing compaction: WAL tail seq ` +
          `${tail.corrupt != null ? `unreadable (${tail.corrupt})` : tail.lastSeq} ` +
          `!= applied_seq ${cursor.applied_seq}`,
      };
    }
    // S2.1: cursor first (see header). Failure → no swap, fail closed.
    const adv = advanceAppliedCursor(dir, {
      applied_seq: cursor.applied_seq,
      applied_offset: 0,
    });
    if (adv.error != null) {
      return { compacted: false, error: adv.error };
    }
    const tmp = `${walPath}.tmp-${process.pid}`;
    try {
      const fd = openSync(
        tmp,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, walPath);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort tmp cleanup
      }
      // Cursor already rewritten to {applied_seq, 0} but the WAL still holds
      // only fully-applied records: the full scan's seq > afterSeq filter
      // delivers nothing, and the next flush re-captures + retries compaction.
      return { compacted: false, error: `wal swap failed: ${e.message}` };
    }
    return { compacted: true, error: null };
  } finally {
    releaseLockFile(lock.fd, lock.path);
  }
}
