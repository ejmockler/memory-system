// Watermark daemon (cascade-only, post-R32.1). See kb/architecture.md for
// the row-by-row source-tier cascade contract.
//
// Env vars (opt-in test-mode overrides; production omits them):
//   WATERMARK_HEARTBEAT_OVERRIDE_SECONDS  integer >= 1 ; default = 5
//                                         Substitutes for the heartbeat
//                                         setInterval cadence so tests do not
//                                         need to wait the production cadence.
// CLI modes:
//   --check : print "ok\n" and exit 0   (probe for launchd/supervisord)
//   --once  : acquire lock, run ONE cascade tick (tickSourcesOnce), release
//             lock, exit 0 on success / 1 on error. The hermetic e2e
//             driver pattern.
//   no flag : long-lived setInterval loop (production).
//
// Long-lived, single instance per machine (enforced by lock file). Tails
// each bare-name source ledger under <MEMORY_ROOT>/storage/sources/ and
// promotes new rows through the cascade. Per-source cursor state lives in
// WATERMARK_STATE_DIR/<source>.json (one atomic file per source).
//
// HARD BOUNDARIES (what this daemon does NOT do):
//   - Does NOT hold or read the cascade signing key.
//   - Does NOT call memory_distill_promote_fact (or any MCP tool).
//   - Does NOT read the memory ledger.
//   - Does NOT classify salience.
//
// The historical conversational-batch pipeline (tickOnce + per-conversation
// idle-watermark + batch enqueue + supervisor handoff) was retired in
// R32.1; see kb/legacy-archive.md for the frozen schema text.

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { appendPolicyEvent, appendPolicyEventsBatch } from "../mcp/lib/policy-events.js";
import { shouldEmitDrop } from "../mcp/lib/ingest/drop-throttle.js";
// G1 (F-G1-WM-ERROR-ADVANCE): the ERROR branch of the source row walk
// advances the cursor past the poison row (deliberate — the cursor-park
// branch was removed so one bad row can never head-of-line-block a source).
// That makes the row UNRECOVERABLE: nothing on disk records what was skipped.
// REUSE, not reimplementation — the Stage-0 quarantine writer already owns
// the path scheme (storage/quarantine/<source>/<YYYY-MM-DD>.jsonl), the
// id+checksum stamping, the durable append and the restore path.
import { quarantineRow } from "../mcp/lib/ingest/quarantine.js";
import { serverTs } from "../mcp/lib/envelope.js";
import {
  STORAGE_DIR,
  POLICY_DIR,
  LEDGERS_DIR,
  distillationStateLockPath,
  watermarkStateDir,
  watermarkSourceCursorPath,
  aggregatorCheckpointPath,
  memoryLedgerPath,
} from "../mcp/lib/config.js";
import { CAPS } from "../mcp/lib/validation.js";
// WU2-inline-embed-and-remove-gemini-quota-machinery removed the
// ThrottledStructuralError import. It was used only to suppress per-row Gemini
// KeyPoolExhaustedError log spam in the (now-deleted) inline-embed fallback +
// the Gemini prefetch. The cascade now embeds via the local server, which has
// no key pool and throws a typed LocalEmbedUnavailableError on outage (caught
// in prefetchEmbeddings) instead of a structural-throttle storm.

// W10 — F-SYN-INTEGRATION-ENGAGEMENT-DETECTOR-WIRING BLOCKER closure.
// The watermark daemon's idle tick is the integration seam that drains the
// engagement queue (written by the UserPromptSubmit hook fire-and-forget),
// runs detectEngagement against each enqueued signal, and forwards every
// classified row into the damping log via damping-log.appendEngagement.
//
// HOOKS-NEVER-BLOCK contract (kb/agent-integration.md, architect review):
//   The hook itself does NOT classify or write to the damping log; it only
//   enqueues. The daemon's idle tick is the asynchronous classifier loop.
//   Without this wiring the queue file accumulates forever and the
//   engagement feedback loop is silently dead — the W9 spawn-finding
//   BLOCKER that this W10 keystone closes.
//
// Cadence: once per cascade tick (TICK_INTERVAL_MS = 15s in production).
// One queue drain per 15s is comfortably above the per-turn enqueue rate
// (~one enqueue per assistant turn boundary) and well below any timing
// boundary that would matter for the multi-feature scorer's engagement_prior
// axis (which decays over multiple turns, not seconds).
import {
  processEngagementQueue as __processEngagementQueue,
} from "../mcp/lib/synthesis/engagement-detector.js";
import {
  appendEngagement as __appendEngagement,
  computeTurnWindowId as __computeTurnWindowId,
  computeConversationIdHash as __computeConversationIdHash,
} from "../mcp/lib/synthesis/damping-log.js";

// W12 — F-SYN-BEHAVIOR-thread-aggregation. Daemon-side aggregator collapses
// N atomic facts (iMessage chat-thread, git-log commit run) into ONE
// reconstructed event per qualifying thread via emitReconstruction({mode:
// "daemon"}). Invoked in the idle tick after the engagement queue drain.
// Defensive: aggregateThreads catches its own errors and returns a counts
// envelope, never throws.
import {
  aggregateThreads as __aggregateThreads,
  THREAD_AGGREGATOR_CAPS as __THREAD_AGGREGATOR_CAPS,
} from "../mcp/lib/synthesis/thread-aggregator.js";

// W13 — F-SYN-BEHAVIOR-project-aggregation. Daemon-side aggregator collapses
// N git-log commits + github-events for a {repo, author, week} bucket into
// ONE reconstructed event per qualifying project session via
// emitReconstruction({mode:"daemon"}). Invoked in the idle tick AFTER the
// thread aggregator so project-grain synthesis runs on a steady-state ledger
// (the thread aggregator may have just emitted new reconstructed rows, but
// those carry kind:"reconstructed" not kind:"fact", so the project
// aggregator's "kind === fact" filter skips them — no feedback loop).
// Defensive: aggregateProjects catches its own errors and returns a counts
// envelope, never throws.
import {
  aggregateProjects as __aggregateProjects,
  PROJECT_AGGREGATOR_CAPS as __PROJECT_AGGREGATOR_CAPS,
} from "../mcp/lib/synthesis/project-aggregator.js";

// D1 incremental-aggregation checkpoint persist (WIRE node). CKPT primitive:
// atomic tmp+fsync+rename+dir-fsync, offset-as-string + {ino, ledger_size}
// fingerprint, self-heals on offset>size / inode-change (design.md §D-1). The
// aggregators READ the checkpoint internally (they are passed the path and call
// resolveStartOffset at cold start for the self-heal predicate ONLY); WIRE owns
// the WRITE — persisting the advanced offset AFTER a clean emit (design.md
// §D-3.4 "the disk checkpoint is WRITTEN every run by WIRE").
import { writeCheckpoint } from "../mcp/lib/synthesis/_agg-checkpoint.js";

// WU2-inline-embed-and-remove-gemini-quota-machinery. The cascade embeds
// INLINE via the local Qwen3 server (mcp/lib/local-embedder-client.js) over
// each tick's row contents. The async embed-backfill worker + its queue were
// deleted; on a local-server outage the cascade promotes with embedding=null
// and records the fact id to a SIMPLE re-embed sweep file (JSONL —
// appendReEmbedSweep appends one {fact_id, ts} JSON object per line to
// re-embed-sweep.jsonl) so a later drain can re-embed it. That sweep file is
// the ONLY remaining async path and it is minimal.
import {
  embedBatch as __localEmbedBatch,
  LocalEmbedUnavailableError as __LocalEmbedUnavailableError,
} from "../mcp/lib/local-embedder-client.js";
import { ACTIVE_EMBED_MODEL_VERSION } from "../mcp/lib/validation.js";
// Q3 (memperf) — salience KNN via the resident query daemon (queryd). The
// client is REUSED wholesale from the Q2 recall integration (one lazy unix-
// socket connection per process, structured QuerydUnavailableError, deadline
// discipline — nothing re-implemented here); probeSocketAlive + querydPaths
// keep the socket-path scheme single-sourced with the daemon. queryd.js's
// CLI is guarded, so this import is side-effect-free.
import {
  getQuerydClient as __getQuerydClient,
  _readModeEnv as __readModeEnv,
} from "../mcp/lib/recall/queryd-client.js";
import {
  probeSocketAlive as __probeQuerydSocket,
  querydPaths as __querydPaths,
} from "../mcp/daemon/queryd.js";
// WU-RR1 — BM25 full-rebuild trigger. Daemon idle-tick check (low cadence)
// fires a one-shot rebuild from the canonical ledger when N facts have
// accumulated since the last rebuild. The check itself is defensive; the
// rebuild call inside it is also defensive (rebuild failure leaves the
// existing bm25.json + state file in place, so recall continues to serve
// from the stale-but-functional index).
import { maybeRunBm25Rebuild as __maybeRunBm25Rebuild } from "../mcp/lib/recall/bm25-rebuild.js";

// WU2 — simple re-embed sweep file. When the local embed server is down at
// promote time the cascade promotes the row with embedding=null and records
// it here as JSONL: appendReEmbedSweep appends one {fact_id, ts} JSON object
// per line. This is the minimal replacement for the deleted async
// embed-backfill queue: an append-only file, no tombstones / dead-letter /
// compaction. The scheduled drainer daemons/reembed-drain.mjs consumes this
// file (byte-offset cursor, bounded batches) and re-embeds the rows whose
// embedding is still null. appendReEmbedSweep is fully defensive — a write
// failure never disturbs the cascade (the fact row is already durable).
const RE_EMBED_SWEEP_PATH = join(POLICY_DIR, "re-embed-sweep.jsonl");

function appendReEmbedSweep(factId, { now } = {}) {
  if (typeof factId !== "string" || factId.length === 0) return;
  try {
    const line = JSON.stringify({ fact_id: factId, ts: nowIso(now) }) + "\n";
    const fd = openSync(RE_EMBED_SWEEP_PATH, O_WRONLY | O_CREAT | fsConstants.O_APPEND, FILE_MODE);
    try {
      const buf = Buffer.from(line, "utf8");
      let written = 0;
      while (written < buf.length) {
        written += writeSync(fd, buf, written, buf.length - written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Best-effort: the fact row is already durable; a lost sweep line only
    // means this row won't be auto-re-embedded (recall still serves it via the
    // additive-only branch). Never throw into the cascade hot path.
  }
}

// ---------------------------------------------------------------------------
// Caps from SYMBOL_CONTRACT (kb/mcp-surface.md § Caps). Inlined here because
// validation.js's CAPS object does not export cascade-tier knobs; the spec
// text is the single point of truth.
//
// R32.1: removed DISTILLATION_IDLE_WATERMARK_SECONDS,
// DISTILLATION_BATCH_MAX_TURNS, POISON_THRESHOLD constants + the
// WATERMARK_IDLE_OVERRIDE_SECONDS env-var override. The conversational-batch
// pipeline they fed was retired (see kb/legacy-archive.md). Only cascade-tier
// timing knobs remain.
// ---------------------------------------------------------------------------

const STALE_LOCK_RECOVERY_SECONDS = 60;
// ---------------------------------------------------------------------------
// R37: TICK_INTERVAL_MS aligned to Gemini free-tier per-minute rate limit.
// gemini-embedding-001 free tier enforces 5 RPM per project. With 4 working
// keys (one per project) and up to ~5 embedBatch calls per tick (one per
// source in the pathological per-source dispatch path), a 1000ms tick
// saturates the per-minute bucket in <1s, all keys cool simultaneously for
// 60s, daemon parks, no useful work. A 15000ms tick yields 4 ticks/min ×
// 5 calls/tick = 20 RPM aggregate, matching the 4 keys × 5 RPM ceiling.
// Side effect: live-mode source-row latency rises from 1s to 15s
// (operationally invisible). M2 RPM tracker in gemini-client.js is the
// proactive complement to this tick-rate alignment.
// ---------------------------------------------------------------------------
const TICK_INTERVAL_MS = 15000;
const HEARTBEAT_INTERVAL_MS_DEFAULT = 5000;

// ---------------------------------------------------------------------------
// F-NEW-W7-CURSOR-LAG-ALARM. Periodic check (every N ticks): for each
// source, compute lag = (source_ledger_tail_ts - cursor.last_appended_ts).
// If lag > CURSOR_LAG_WARN_THRESHOLD_MS AND the source ledger has grown in
// the last hour, emit a one-line stderr WARN + bump the Stage-0 telemetry
// counter recordDrop(per-source (entry.source), "cursor_lag_warn", "WARN").
// The intent is observability, not enforcement — the alarm tells the
// operator that the daemon is parked while data continues to pile up at
// the connector tail. Each lagging source bumps its own counter so the
// per-source attribution survives the rotated JSONL telemetry sink.
//
// Cadence: every CURSOR_LAG_CHECK_EVERY_N_TICKS ticks. At TICK_INTERVAL_MS=
// 15s and N=20, the check runs every 5 minutes. Cheap: one statSync + one
// short read per source per check window.
//
// The 24h threshold matches the audit-finding spec language ("> 24h"). The
// 1h "ledger has grown" gate prevents false positives on sources that have
// genuinely stopped producing (e.g. an offline laptop with screentime
// paused) — a stuck cursor on a frozen source is not actionable.
// ---------------------------------------------------------------------------
const CURSOR_LAG_WARN_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h
const CURSOR_LAG_LEDGER_GROWTH_WINDOW_MS = 60 * 60 * 1000; // 1h
const CURSOR_LAG_CHECK_EVERY_N_TICKS = 20; // ~5 min at 15s/tick

// WU-RR1 — BM25 rebuild trigger cadence. The trigger itself is cheap when
// the ledger has not grown (statSync only); when it has grown the check
// counts facts via an S1-checkpoint delta (W2 memperf: storage/
// bm25-growth-check.json sidecar, countFactRowsCheckpointed in
// lib/recall/bm25-rebuild.js) — O(witness + appended rows), NOT the
// historical full-ledger stream (~2.18GB / several seconds per check).
// A full recount happens only when the sidecar is missing/invalid or the
// checkpoint's prefix-identity witness fails (rewrite/rotation/shrink).
// 80 ticks ≈ 20 min at 15s/tick keeps threshold crossings caught within
// a reasonable window. CAPS.BM25_REBUILD_THRESHOLD gates whether the
// rebuild actually fires (delta-since-last-rebuild ≥ threshold).
const BM25_REBUILD_CHECK_EVERY_N_TICKS = 80;

// W12/W13 — thread + project aggregation cadence. See maybeRunThreadAggregation
// / maybeRunProjectAggregation (near the runners below) for the full defect
// narrative (2026-07-06 5.9GB-RSS concurrent-full-ledger-scan pileup). Each
// aggregation streams + JSON.parses the ENTIRE ~1.9GB / ~1.5M-row memory.jsonl
// ledger to filter to its time window (the ledger is not time-indexed, so a
// windowed aggregation still reads the whole file). At 15s/tick, N=20 ticks
// ≈ 5 min — matching CURSOR_LAG_CHECK_EVERY_N_TICKS and landing at the spec's
// 300s idle floor the runner docstrings reference. No spec-pinned tick value
// exists; 20 is the established cursor-lag cadence and is the deliberate choice.
const AGGREGATION_CHECK_EVERY_N_TICKS = 20; // ~5 min at 15s/tick

// FIX-3 (N7b) — reconstruction emit observability. The thread/project
// aggregation runners return a counts envelope ({*_processed,
// reconstructed_emitted, errors}) that was previously discarded by a
// fire-and-forget `.catch()`-only — so a run that processed buckets but
// emitted ZERO reconstructed rows (the exact failure N7b fixes) left no trace.
// When this flag is on we log a one-line stderr breadcrumb whenever a runner
// processed ≥1 bucket but emitted 0 rows (the silent-zero blind spot), so the
// operator can SEE that consolidation is live but unproductive. Default-ON;
// flip to false to silence. Cheap (one string compare + conditional write per
// tick, only on the zero-emit-with-work edge).
const RECONSTRUCT_EMIT_OBSERVABILITY_ENABLED = true;

// Log the aggregation runner's counts envelope. Always emits a breadcrumb on a
// zero-emit-with-processed-buckets run (the observable failure); stays silent
// on a clean no-work tick (0 processed) so the steady-state log is quiet.
function logReconstructionCounts(label, counts) {
  if (!RECONSTRUCT_EMIT_OBSERVABILITY_ENABLED) return;
  if (counts == null || typeof counts !== "object") return;
  const processed =
    typeof counts.threads_processed === "number"
      ? counts.threads_processed
      : typeof counts.projects_processed === "number"
        ? counts.projects_processed
        : 0;
  const emitted =
    typeof counts.reconstructed_emitted === "number"
      ? counts.reconstructed_emitted
      : 0;
  const errors = typeof counts.errors === "number" ? counts.errors : 0;
  // Only surface the actionable signal: buckets were processed but nothing was
  // emitted (and it wasn't an error-driven zero). That is the zero-emit blind
  // spot. A run with emitted>0 is healthy; a run with processed=0 is a quiet
  // idle tick — neither needs a line.
  if (processed > 0 && emitted === 0 && errors === 0) {
    try {
      process.stderr.write(
        `watermark: ${label}: processed=${processed} emitted=0 ` +
          `(zero reconstructed rows despite ${processed} bucket(s) above floor; ` +
          `all idempotent re-fires OR below-floor skips)\n`,
      );
    } catch {
      // ignore
    }
  } else if (errors > 0) {
    try {
      process.stderr.write(
        `watermark: ${label}: processed=${processed} emitted=${emitted} ` +
          `errors=${errors}\n`,
      );
    } catch {
      // ignore
    }
  }
}

// WU2-inline-embed-and-remove-gemini-quota-machinery removed the
// WATERMARK_ADVANCE_PAST_DEFERRED escape valve. It existed only to unstick the
// KeyPoolExhausted-deadlock (every tick parks on EMBED_DEFERRED). With inline
// local embedding there is no EMBED_DEFERRED park — every visited row advances
// the cursor (promoting with a null embedding + sweep on a local outage), so
// the deadlock it guarded against cannot occur.

// Heartbeat env-var override (test-mode only; production omits it). Parse
// once at load. Math.max(1, ...) clamps absurd values; parseInt's NaN
// short-circuits the truthy raw-string check.
const __hbSecRaw = process.env.WATERMARK_HEARTBEAT_OVERRIDE_SECONDS;
const HEARTBEAT_SECONDS = __hbSecRaw
  ? Math.max(1, parseInt(__hbSecRaw, 10))
  : 5;
const HEARTBEAT_INTERVAL_MS = HEARTBEAT_SECONDS * 1000;

// ---------------------------------------------------------------------------
// Paths (canonical, per SYMBOL_CONTRACT)
//
// R32.1: removed the conversational-state file path + the QUEUE_DIR tree
// (the four QUEUE_*_DIR consts). The cascade-only daemon retains its lock
// file (one daemon per machine) — operator-deferred on whether to rename
// the on-disk filename; see kb/legacy-archive.md ambiguity #1.
// ---------------------------------------------------------------------------

const LOCK_PATH = distillationStateLockPath();
const SOURCES_DIR = join(STORAGE_DIR, "sources");

// Conventional ledger basename suffix; only the source-tier (bare-name)
// branch survives, and it appends ".jsonl" when building cursor paths.
const CHAT_FILE_SUFFIX = ".jsonl";

// R26 multi-source watermark.
// Per-source cursor state lives at WATERMARK_STATE_DIR/<source>.json. Each
// source has its own atomic cursor file (write tmp + rename + dir-fsync) so
// a parse failure on one source does not poison another. Schema (frozen
// for CAPS.WATERMARK_CURSOR_VERSION=1):
//
//   {
//     version: 1,
//     source: "<source>",
//     last_offset: "<bigint-as-string>",   // byte offset past last processed row
//     last_appended_ts: "<ISO-8601> | null",
//     last_event_id: "<string> | null",
//     error_count: <int>,                  // backoff counter; per-source isolated
//     muted_until: "<ISO-8601> | null"     // operator-clearable mute marker
//   }
//
// Source classification:
//   - Bare-name entries (imessage, screentime, git-log, github-events) route
//     to the row-by-row tail-and-cascade pipeline (tickSourcesOnce). Cursor
//     state lives in WATERMARK_STATE_DIR/<source>.json.
//   - The legacy "chat-*" wildcard branch (conversation/idle-watermark batch
//     pipeline) was retired in R32.1 along with tickOnce; see the retirement
//     notes below for the post-R32.1 single-tier shape.
const WATERMARK_STATE_DIR = watermarkStateDir();
const WATERMARK_CURSOR_VERSION = CAPS.WATERMARK_CURSOR_VERSION;
const WATERMARK_SOURCE_ERROR_THRESHOLD = CAPS.WATERMARK_SOURCE_ERROR_THRESHOLD;

// G1 — F-G1-WM-ERROR-ADVANCE. Rule id stamped onto every quarantine entry
// written from the cascade-ERROR branch, so an operator triaging
// storage/quarantine/<source>/ can tell a watermark cascade error apart from
// a Stage-0 policy drop (which carries its own Stage-0 rule id).
const ERROR_QUARANTINE_RULE_ID = "F-G1-WM-ERROR-ADVANCE";

// Default-OFF feature flag for the ERROR-branch quarantine write. Read at
// CALL time, not module load: the flag's own regression battery exercises
// both the OFF and the ON path inside ONE process (one module instance, one
// evaluation), so a module-load const would make the two tests mutually
// unsatisfiable. Semantics are identical to the module-load CAPS flags —
// exactly "1" enables, unset/anything else is byte-for-byte today's
// behavior — and the cost is one string compare per ERROR row, on a branch
// that is rare by construction.
function errorQuarantineEnabled() {
  return process.env.MEMORY_WATERMARK_ERROR_QUARANTINE_ENABLED === "1";
}

// Max bytes the source-tier tail reads from a single ledger per tick.
// Each tick allocates a Buffer of (snapSize - cursor.last_offset) bytes,
// then parses every JSON line in it. Without a cap, a fresh-cursor start
// against a 169MB git-log.jsonl tail allocates 169MB + ~5-10x V8 object
// overhead (~1.5GB live) per tick — the leak that surfaced in R25.x as
// the daemon climbed past 8GB heap in ~9 minutes. 2MB ≈ ~3000 typical
// source rows; cursor advances per row, so the next tick picks up
// where this one stopped. Setting this is a per-tick latency vs.
// memory-headroom knob — small values mean more ticks for the same
// backfill; large values mean bigger transient RSS spikes.
const WATERMARK_SOURCE_MAX_BYTES_PER_TICK = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Open flags. fs.constants (NOT os.constants — see nonce-store.js header note
// for why this distinction is load-bearing).
// ---------------------------------------------------------------------------

const O_WRONLY = fsConstants.O_WRONLY;
const O_CREAT = fsConstants.O_CREAT;
const O_EXCL = fsConstants.O_EXCL;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW;
const FILE_MODE = 0o600;
const LOCK_FLAGS = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;

// ---------------------------------------------------------------------------
// Time helpers. nowMs() and nowIso() are the override-for-test seams; production
// callers omit `now`, tests can pin "2026-05-31T00:00:00Z" for determinism.
// Per task-spec discipline: rely on the JS standard library current-time helper
// (Date / Date.now / new Date().toISOString() — the same path serverTs() uses).
// ---------------------------------------------------------------------------

function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "string") return Date.parse(now);
  if (typeof now === "number") return now;
  return Date.now();
}

function nowIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string") return now;
  if (typeof now === "number") return new Date(now).toISOString();
  return serverTs();
}

// Build an ISO string that is `offsetMs` ahead of the supplied (or current) now,
// via the standard helpers (epoch ms + offset -> Date -> toISOString). Used for
// "future timestamp" computations per task-spec discipline.
function isoOffsetMs(baseNow, offsetMs) {
  return new Date(nowMs(baseNow) + offsetMs).toISOString();
}

// round-15 H3 (memory-jsonl-fsync). fsyncDirSafe — open a directory in
// read-only mode + fsync its file descriptor, so the directory's metadata
// (newly added file entries, removed/renamed entries) is durable across crash.
// Without this, even careful atomic-rename paths (writeStateAtomic,
// enqueueBatchFile, all settleDone/settleFailed renames in the supervisor)
// can lose the rename in a power-cut between the inode update and the
// directory-block flush. Best-effort on platforms that refuse to fsync a
// directory (EISDIR / EINVAL surface as silent skips); errors otherwise
// propagate. macOS quirk: fsync on a directory is permitted but may not
// drive APFS all the way to platter — F_FULLFSYNC is the stronger primitive
// but Node has no API for fcntl(F_FULLFSYNC). fsyncSync is the portable
// best-effort here (correct on linux/bsd, journaled-best-effort on darwin).
function fsyncDirSafe(dirPath) {
  let fd = -1;
  try {
    fd = openSync(dirPath, fsConstants.O_RDONLY);
    fsyncSync(fd);
  } catch (err) {
    if (err && err.code !== "EISDIR" && err.code !== "EINVAL" && err.code !== "ENOENT") {
      throw err;
    }
  } finally {
    if (fd !== -1) {
      try { closeSync(fd); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// ULID generation. /dev/urandom-backed (via crypto.randomBytes) + base32
// Crockford encoding. Spec calls for "ulid via /dev/urandom + base32 encode".
// Format: 10 chars timestamp + 16 chars randomness = 26 chars total.
// Lex-sortable when generated in time order.
// ---------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeCrockford(buf, length) {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >> (bits - 5)) & 0x1f];
      bits -= 5;
    }
    if (out.length >= length) break;
  }
  while (out.length < length) {
    out += CROCKFORD[(value << (5 - bits)) & 0x1f];
    bits = 0;
  }
  return out.slice(0, length);
}

function timestampPart(ms) {
  // 48-bit big-endian timestamp -> 10 base32 chars.
  const buf = Buffer.alloc(6);
  buf.writeUIntBE(ms, 0, 6);
  return encodeCrockford(buf, 10);
}

function randomPart() {
  // 80 bits of randomness -> 16 base32 chars.
  return encodeCrockford(randomBytes(10), 16);
}

export function ulid(now) {
  return timestampPart(nowMs(now)) + randomPart();
}

// ---------------------------------------------------------------------------
// Directory setup. Idempotent; ensures all queue subdirs exist before tick 1.
// ---------------------------------------------------------------------------

function ensureDirs() {
  // R32.1: removed QUEUE_DIR + 4 QUEUE_*_DIR mkdir entries (root cause of the
  // queue-dir resurrection bug — every tick recreated the dead pipeline's
  // pending/in-flight/done/failed tree).
  for (const dir of [
    POLICY_DIR,
    SOURCES_DIR,
    WATERMARK_STATE_DIR,
    LEDGERS_DIR,
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

// ---------------------------------------------------------------------------
// Conversational state block (emptyState / convKey / readState /
// writeStateAtomic / preserveCorruptState + STATE_PATH + STATE_VERSION)
// was retired in R32.1 along with tickOnce. The cascade-only watermark
// daemon persists its per-source progress through individual cursor files
// under WATERMARK_STATE_DIR (see readSourceCursor / writeSourceCursorAtomic
// below); no monolithic state file remains. The lock file (LOCK_PATH) is
// retained as the daemon-process serialization primitive.
//
// Historical schema text moved to kb/legacy-archive.md.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Lock discipline. Same shape as nonce-store.js (M11 upgrade): create the
// lock via O_CREAT|O_EXCL|O_NOFOLLOW|0o600, verify nlink === 1 after open,
// fsync after writing the body. Stale-reclaim if recorded PID is dead OR
// mtime > STALE_LOCK_RECOVERY_SECONDS old. Heartbeat-side TOCTOU fix (H3):
// refreshHeartbeat first re-reads the lock body and confirms the recorded
// pid is still our own — if another process reclaimed the lock under us we
// must exit gracefully instead of continuing to enqueue.
// ---------------------------------------------------------------------------

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "ESRCH") return false;
    // EPERM = process exists but we cannot signal it; treat as alive.
    if (err && err.code === "EPERM") return true;
    return false;
  }
}

function readLockBody() {
  try {
    const raw = readFileSync(LOCK_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Number.isInteger(parsed.pid)) {
      return parsed;
    }
  } catch {
    // missing / unreadable / malformed -> treat as no body.
  }
  return null;
}

function writeLockBodyOnFd(fd, { now } = {}) {
  const body = JSON.stringify({ pid: process.pid, heartbeat_ts: nowIso(now) });
  const buf = Buffer.from(body, "utf8");
  let written = 0;
  while (written < buf.length) {
    written += writeSync(fd, buf, written, buf.length - written);
  }
  fsyncSync(fd);
}

// Re-write the lock body to refresh mtime. Used by the heartbeat path; opens,
// writes, fsyncs, closes. Critical-section bounded by try/finally close.
function rewriteLockBody({ now } = {}) {
  // Use a writeFile that does not truncate-then-write under O_EXCL (we want
  // to overwrite contents to update mtime). Open as write-truncate.
  const fd = openSync(LOCK_PATH, "w", FILE_MODE);
  try {
    writeLockBodyOnFd(fd, { now });
  } finally {
    closeSync(fd);
  }
}

// acquireLock(): returns {acquired, reclaimed_prior_pid|null}. side-effects:
// creates the lock file, writes the body, fsyncs.
function acquireLock({ now } = {}) {
  // First attempt: atomic create-or-fail.
  try {
    const fd = openSync(LOCK_PATH, LOCK_FLAGS, FILE_MODE);
    try {
      const st = fstatSync(fd);
      if (st.nlink !== 1) {
        throw new Error("watermark lock has unexpected nlink");
      }
      writeLockBodyOnFd(fd, { now });
    } finally {
      closeSync(fd);
    }
    return { acquired: true, reclaimed_prior_pid: null };
  } catch (err) {
    if (err && err.code !== "EEXIST") throw err;
  }
  // Lock exists. Check reclaim eligibility.
  const body = readLockBody();
  let stMtimeMs = 0;
  try {
    stMtimeMs = statSync(LOCK_PATH).mtimeMs;
  } catch {
    stMtimeMs = 0;
  }
  const ageSec = (nowMs(now) - stMtimeMs) / 1000;
  const priorPid = body ? body.pid : null;
  const ownerAlive = priorPid != null && isPidAlive(priorPid);
  if (!ownerAlive || ageSec > STALE_LOCK_RECOVERY_SECONDS) {
    try {
      unlinkSync(LOCK_PATH);
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
    try {
      const fd = openSync(LOCK_PATH, LOCK_FLAGS, FILE_MODE);
      try {
        const st = fstatSync(fd);
        if (st.nlink !== 1) {
          throw new Error("watermark lock has unexpected nlink (reclaim)");
        }
        writeLockBodyOnFd(fd, { now });
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      // Lost a race for the lock; back off and let next start try.
      if (err && err.code === "EEXIST") {
        return { acquired: false, reclaimed_prior_pid: null };
      }
      throw err;
    }
    return { acquired: true, reclaimed_prior_pid: priorPid };
  }
  return { acquired: false, reclaimed_prior_pid: null };
}

// refreshHeartbeat(): re-read the lock body FIRST (H3 TOCTOU fix). If the
// recorded pid is not ours, another process reclaimed the lock; return
// {still_ours:false} so the caller can shutdown gracefully. If we still own
// it, rewrite the body to bump mtime.
function refreshHeartbeat({ now } = {}) {
  const body = readLockBody();
  if (body == null || body.pid !== process.pid) {
    return { still_ours: false };
  }
  try {
    rewriteLockBody({ now });
    return { still_ours: true };
  } catch {
    // ignore — main loop will notice via stat failures next tick
    return { still_ours: true };
  }
}

function releaseLock() {
  // Only release if we still own it (don't blow away a successor's lock).
  const body = readLockBody();
  if (body == null || body.pid !== process.pid) return;
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// R32.1: listChatLedgers() + the chat-<runtime>.jsonl tail-and-batch entry
// point retired with tickOnce. The cascade tier (listSourceLedgers + per-
// source cursors) is now the sole watermark path.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// R26 multi-source watermark — source-tier ledger discovery + cursor state.
//
// Source classification (CAPS.WATERMARK_SOURCES):
//   - "chat-*" wildcard entries are deliberately excluded from
//     listSourceLedgers — those legacy ledgers fed the retired tickOnce
//     conversational-batch pipeline. They are skipped here.
//   - Bare-name entries (imessage, screentime, git-log, github-events,
//     chat-claude-code) are row-by-row tail-and-promote sources. Each has
//     its own atomic cursor file at WATERMARK_STATE_DIR/<source>.json.
//     F-T2-CHAT_CLAUDE-CODE-F7 promoted chat-claude-code from "wildcard-only"
//     (which the wildcard-skip above suppressed) to a bare-name entry so the
//     daemon actually tails storage/sources/chat-claude-code.jsonl.
//
// listSourceLedgers() returns [{ source, path }] for bare-name entries
// whose ledger file actually exists on disk. Missing-file is silent — the
// connector daemon may not have run yet; the watermark daemon should not
// require every source to be live before processing the ones that are.
// ---------------------------------------------------------------------------

function isWildcardSourceEntry(entry) {
  return typeof entry === "string" && entry.endsWith("*");
}

function listSourceLedgers() {
  if (!existsSync(SOURCES_DIR)) return [];
  const out = [];
  for (const entry of CAPS.WATERMARK_SOURCES) {
    if (typeof entry !== "string" || entry === "") continue;
    if (isWildcardSourceEntry(entry)) continue; // owned by listChatLedgers
    const path = join(SOURCES_DIR, entry + CHAT_FILE_SUFFIX);
    if (!existsSync(path)) continue;
    out.push({ source: entry, path });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-source cursor persistence. Atomic write tmp -> fsync -> rename. One
// file per source so a parse failure on one source does not poison another.
// ---------------------------------------------------------------------------

function emptyCursor(source, { now } = {}) {
  return {
    version: WATERMARK_CURSOR_VERSION,
    source,
    last_offset: "0",
    last_appended_ts: null,
    last_event_id: null,
    error_count: 0,
    muted_until: null,
    updated_at: nowIso(now),
  };
}

function readSourceCursor(source) {
  const path = watermarkSourceCursorPath(source);
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    return null;
  }
  if (raw === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.version !== WATERMARK_CURSOR_VERSION) return null;
  if (typeof parsed.source !== "string" || parsed.source !== source) return null;
  // last_offset is stored as a string so values > 2^53 survive JSON. We
  // hold it in memory as a BigInt-coercible string and coerce per use.
  if (typeof parsed.last_offset !== "string") {
    parsed.last_offset = String(parsed.last_offset || 0);
  }
  if (!Number.isInteger(parsed.error_count)) parsed.error_count = 0;
  if (parsed.last_appended_ts === undefined) parsed.last_appended_ts = null;
  if (parsed.last_event_id === undefined) parsed.last_event_id = null;
  if (parsed.muted_until === undefined) parsed.muted_until = null;
  return parsed;
}

function writeSourceCursorAtomic(cursor, { now } = {}) {
  cursor.updated_at = nowIso(now);
  const path = watermarkSourceCursorPath(cursor.source);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const json = JSON.stringify(cursor);
  const tmp = path + ".tmp." + process.pid + "." + randomBytes(4).toString("hex");
  const fd = openSync(tmp, "w", FILE_MODE);
  try {
    const buf = Buffer.from(json, "utf8");
    let written = 0;
    while (written < buf.length) {
      written += writeSync(fd, buf, written, buf.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDirSafe(dir);
}

// ---------------------------------------------------------------------------
// Source row parser. Source ledgers (imessage / screentime / git-log /
// github-events) follow the connector-base append shape:
//
//   { id, ts, source, source_msg_id, parties, raw_content, attachments,
//     source_policy, checksum, ... }
//
// Returns [{ event, offset_end, lineStart }] for every well-formed line.
// Parse failures are NOT silently skipped here (unlike readTurnsInRange);
// the caller needs the offset so it can advance the cursor past a bad row
// and bump error_count.
// ---------------------------------------------------------------------------

function readSourceRowsInRange(path, start, end) {
  const out = [];
  if (end <= start) return out;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(end - start);
    let read = 0;
    while (read < buf.length) {
      const chunk = readSync(fd, buf, read, buf.length - read, start + read);
      if (chunk === 0) break;
      read += chunk;
    }
    const text = buf.slice(0, read).toString("utf8");
    let cursor = 0;
    let offset = start;
    while (cursor < text.length) {
      const nl = text.indexOf("\n", cursor);
      if (nl < 0) break;
      const line = text.slice(cursor, nl);
      const lineByteLen = Buffer.byteLength(line, "utf8") + 1;
      const lineStartOffset = offset;
      const lineEndOffset = offset + lineByteLen;
      cursor = nl + 1;
      offset = lineEndOffset;
      if (line.trim() === "") {
        // Blank line — advance cursor but record nothing.
        continue;
      }
      let parsed;
      let parseErr = null;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        parseErr = err;
      }
      out.push({
        event: parsed,
        offset_end: lineEndOffset,
        offset_start: lineStartOffset,
        parse_error: parseErr ? (parseErr.message || "parse_error") : null,
      });
    }
  } finally {
    closeSync(fd);
  }
  return out;
}

// ---------------------------------------------------------------------------
// connector_revoke discovery. Streams the memory ledger for policy rows whose
// policy_kind == "connector_revoke" and returns the set of revoked
// target_sources. The connector_revoke event is the kill-switch: once a
// source is in this set, the watermark daemon STOPS tailing it and emits
// policy.salience.source_revoked so the downstream BFS can hide derived
// memories.
//
// F-WM-REVOKE-LEDGER-STREAM (DEFECT 4, Jul 2026). This function previously
// did readFileSync(path, "utf8") on the whole ledger. Node's maximum string
// length is ~536,870,888 bytes; the production memory.jsonl crossed that
// (1.84GB) around June 2 2026, so EVERY tick threw ERR_STRING_TOO_LONG into
// a silent catch and returned an EMPTY revoked set — connector revokes were
// silently unenforced at the tail loop for a month. This is the sixth
// occurrence of the readFileSync-on-a-growing-ledger bug class in this
// repo; never readFileSync("utf8") an append-only ledger. The fix:
//   1. fd-based chunked readSync loop (the same Buffer idiom as
//      readSourceRowsInRange above) that splits on the newline BYTE and
//      never materialises the whole ledger as one string. Lines are decoded
//      individually, so a multi-byte UTF-8 char split across chunk reads is
//      handled by carrying the post-last-newline remainder as BYTES.
//   2. An APPEND-ONLY incremental cache (per ledger path, module scope):
//      memory.jsonl only ever grows by appends, so after the first full
//      scan each tick reads only [cached_offset, current_size). The cache
//      is invalidated (full rescan from 0) when the inode changes (file
//      replaced, e.g. offline compaction) or the size shrinks (truncated).
//      Re-scanning already-seen rows is harmless — the accumulator
//      Set/Map operations are idempotent.
//   3. Read failures LOG to stderr (throttled to once per distinct error
//      message per daemon lifetime, so a persistent failure does not spam
//      one line per tick) instead of silently returning empty. The
//      returned set degrades to whatever the cache accumulated so far.
//
// Best-effort posture is unchanged: a missing ledger returns an empty set
// rather than crash the tick. The hard-gate path in recall is the actual
// enforcement boundary; this is only for tail-loop muting.
// ---------------------------------------------------------------------------

// Fixed chunk size for the streaming revoke scan. 4MB keeps the transient
// allocation trivially small next to WATERMARK_SOURCE_MAX_BYTES_PER_TICK
// while still crossing a 1.84GB ledger in ~470 reads on the (one-time)
// full scan.
const REVOKE_SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

// Per-ledger-path incremental scan state:
//   { ino, offset, revokedSources:Set, revokedEventIds:Map, rescindedEventIds:Set }
// offset is the byte position just past the last CONSUMED newline — a
// partial trailing line (writer mid-append) is left unconsumed and re-read
// next tick, mirroring readSourceRowsInRange's "break on missing \n" rule.
const __revokeScanCacheByPath = new Map();

// Once-per-distinct-message stderr throttle for revoke-scan read failures.
const __revokeScanFailuresLogged = new Set();

function logRevokeScanFailureOnce(err) {
  const msg = (err && err.message) || String(err);
  if (__revokeScanFailuresLogged.has(msg)) return;
  __revokeScanFailuresLogged.add(msg);
  try {
    process.stderr.write(
      "watermark: loadRevokedSources ledger scan failed (revoke set may be stale/incomplete this tick): " +
        msg + "\n",
    );
  } catch {
    // ignore
  }
}

// Fold one parsed ledger row into the revoke accumulator. Same decision
// logic as the pre-stream implementation; kept as a helper so the chunk
// loop below stays readable.
function foldRevokeRow(row, cache) {
  if (row == null || typeof row !== "object" || row.kind !== "policy") return;
  if (row.policy_kind === "connector_revoke") {
    if (typeof row.target_source === "string" && row.target_source !== "") {
      cache.revokedSources.add(row.target_source);
      if (typeof row.id === "string") {
        cache.revokedEventIds.set(row.id, row.target_source);
      }
    }
  } else if (row.policy_kind === "memory_rescind_policy") {
    // Best-effort rescind: target may be a single id or array. Track
    // rescissions: if a later row targets a connector_revoke event id,
    // the source is un-revoked. The rescind tool is the operator's undo
    // path.
    const tgt = row.target_policy_id || row.target_id || null;
    if (typeof tgt === "string" && tgt !== "") {
      cache.rescindedEventIds.add(tgt);
    } else if (Array.isArray(tgt)) {
      for (const t of tgt) {
        if (typeof t === "string") cache.rescindedEventIds.add(t);
      }
    }
  }
}

// Stream [cache.offset, endSize) of the ledger through the revoke
// accumulator. cache.offset advances chunk-by-chunk so a mid-scan throw
// preserves partial progress (re-folding a row on retry is idempotent).
function scanRevokeRowsIncremental(path, cache, endSize) {
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(
      Math.min(REVOKE_SCAN_CHUNK_BYTES, Math.max(1, endSize - cache.offset)),
    );
    // leftover holds the BYTES after the last consumed newline (invariant:
    // leftover covers exactly [cache.offset + consumedInLeftover... — i.e.
    // [lineStart, readPos)). Kept as a Buffer, NOT a string, so a UTF-8
    // sequence split across chunk boundaries never corrupts.
    let leftover = null;
    let readPos = cache.offset;
    while (readPos < endSize) {
      const want = Math.min(chunk.length, endSize - readPos);
      let got = 0;
      while (got < want) {
        const n = readSync(fd, chunk, got, want - got, readPos + got);
        if (n === 0) break; // file truncated under us — stop early
        got += n;
      }
      if (got === 0) break;
      readPos += got;
      let buf = chunk.subarray(0, got);
      if (leftover != null && leftover.length > 0) {
        buf = Buffer.concat([leftover, buf]);
      }
      const lastNl = buf.lastIndexOf(0x0a); // "\n"
      if (lastNl < 0) {
        // No complete line in this window — carry everything forward.
        // Copy: `chunk` is reused next iteration and subarray aliases it.
        leftover = Buffer.from(buf);
        continue;
      }
      const text = buf.subarray(0, lastNl).toString("utf8");
      leftover = Buffer.from(buf.subarray(lastNl + 1));
      for (const line of text.split("\n")) {
        if (line === "") continue;
        // Cheap pre-filter: only policy rows carry a policy_kind field, and
        // the ledger writer serialises via JSON.stringify (no key spacing).
        // Skipping the JSON.parse for the ~99.9% of rows that are facts is
        // what makes the one-time full scan of a multi-GB ledger tolerable.
        // False positives (a fact whose content embeds the literal) still
        // parse and are rejected by foldRevokeRow's kind check.
        if (!line.includes('"policy_kind"')) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        foldRevokeRow(row, cache);
      }
      // Advance the durable offset only past CONSUMED newlines; the
      // leftover bytes are re-read next call.
      cache.offset = readPos - leftover.length;
    }
  } finally {
    closeSync(fd);
  }
}

function loadRevokedSources() {
  const path = memoryLedgerPath();
  if (!existsSync(path)) {
    // Ledger gone (fresh install / hermetic tmp root) — drop any stale
    // cache entry so a later recreate rescans from 0.
    __revokeScanCacheByPath.delete(path);
    return new Set();
  }
  let st;
  try {
    st = statSync(path);
  } catch (err) {
    logRevokeScanFailureOnce(err);
    return new Set();
  }
  let cache = __revokeScanCacheByPath.get(path);
  if (cache == null || cache.ino !== st.ino || cache.offset > st.size) {
    // First scan, file replaced (compaction rewrites under a new inode),
    // or truncated — restart the accumulator from byte 0.
    cache = {
      ino: st.ino,
      offset: 0,
      revokedSources: new Set(),
      revokedEventIds: new Map(),
      rescindedEventIds: new Set(),
    };
    __revokeScanCacheByPath.set(path, cache);
  }
  if (st.size > cache.offset) {
    try {
      scanRevokeRowsIncremental(path, cache, st.size);
    } catch (err) {
      // NOT silent (the DEFECT-4 failure mode): log once per distinct
      // error and degrade to whatever the cache accumulated so far.
      logRevokeScanFailureOnce(err);
    }
  }
  // Fold rescissions at read-out time (not fold time) so a rescind row
  // that lands BEFORE its revoke row in a later append batch still works.
  const revoked = new Set(cache.revokedSources);
  for (const [eventId, source] of cache.revokedEventIds.entries()) {
    if (cache.rescindedEventIds.has(eventId)) {
      revoked.delete(source);
    }
  }
  return revoked;
}

// ---------------------------------------------------------------------------
// Salience cascade dispatch. The actual cascade (Stage-0 dropper, scorer,
// distill-promote-fact promote) is owned by sibling agents:
//   - mcp/lib/ingest/stage0/<source>.js
//   - mcp/lib/ingest/salience.js
//   - mcp/lib/tools/distill-promote-fact.js
// We invoke them via a lazy dynamic import so the watermark daemon does not
// hard-fail if those modules don't ship together. Each call site catches
// import + invocation errors and bumps the per-source error_count rather
// than poisoning other sources.
//
// Contract (per Phase A integration map):
//   - stage0/index.js exports dispatch(source, event, opts) -> {decision, reason}
//   - salience.js exports scoreCandidate(event, ctx, opts) -> {decision, components, score, ...}
//   - distill-promote-fact.js exports promoteSourceRow({event, source, salience}, opts)
//
// runSourceCascade returns { decision, reason } for caller bookkeeping. It
// never throws; errors are surfaced as decision="ERROR" with a reason
// string.
// ---------------------------------------------------------------------------

let __cascadeModulesPromise = null;

// F-WM-AUTOMUTE-SIGNAL (DEFECT 1): sources whose auto-mute (error_count >=
// WATERMARK_SOURCE_ERROR_THRESHOLD) has already been signalled this daemon
// lifetime. Gates the stderr line + policy.daemon.source_auto_muted event
// in tickSourcesOnce to once per mute WINDOW: membership is removed when
// the F-WM-BREAKER-RESET path clears error_count after a clean tick, so a
// later re-trip signals again.
const __autoMuteSignalledSources = new Set();

// WU2-inline-embed-and-remove-gemini-quota-machinery removed
// wrapEmbedderWithThrottle + the KeyPoolExhaustedError throttle state. That
// wrapper existed only to suppress per-row KeyPoolExhaustedError log spam from
// the Gemini-quota inline-embed fallback. The cascade now pre-fetches every
// tick's embeddings via the local server (no per-key quota, no exhaustion
// storm), so there is no per-row throw to throttle.

// Test-only forced-failure seam for loadCascadeModulesLazy. When set to an
// Error, the loader REJECTS with it (exercising the DEFECT-3 rejected-
// promise-eviction + tick-abort paths below) instead of importing the real
// modules. NEVER set in production code; only test files, via
// _setCascadeLoadFailureForTest. Mirrors the _setCascadeModsForTest idiom.
let __cascadeLoadFailureForTest = null;
export function _setCascadeLoadFailureForTest(err) {
  __cascadeLoadFailureForTest = err;
}

// R25.6: every cascade module is now loaded via loadModule() with an
// explicit expected-exports manifest. This converts the export-vs-lookup
// bug class (R25.5 CRIT-A: stage0/index.js exported stage0Dispatch but
// callers looked up `dispatch`) from a SILENT-fallthrough into a
// BOOT-TIME throw. The dispatcher catches per-module load failures so an
// unshipped module still degrades gracefully — but a name mismatch on
// an existing module is now loud at the boundary.
//
// F-WM-CASCADE-LOAD-RETRY (DEFECT 3a, Jul 2026): the memoised promise used
// to be cached UNCONDITIONALLY — including when it REJECTED. One transient
// module-load failure (e.g. an in-flight `git checkout` racing the dynamic
// import) therefore poisoned the loader for the entire process lifetime:
// every subsequent tick re-awaited the same rejected promise, every row
// surfaced as decision:"ERROR", and error_count marched to the auto-mute
// threshold (3,138 errors in one tick was observed). The rejection handler
// below evicts the cached promise so the NEXT tick retries the import.
// Successful loads stay memoised forever, as before.
async function loadCascadeModulesLazy() {
  if (__cascadeModulesPromise != null) return __cascadeModulesPromise;
  __cascadeModulesPromise = (async () => {
    if (__cascadeLoadFailureForTest != null) {
      // Test seam (see _setCascadeLoadFailureForTest above). Thrown INSIDE
      // the memoised async body so the rejected-promise eviction path is
      // exercised exactly as a real import failure would exercise it.
      throw __cascadeLoadFailureForTest;
    }
    const mods = {
      stage0: null,
      salience: null,
      promote: null,
      // WU2: the cascade pre-fetches the tick's embeddings via the local
      // server (localEmbedBatch) and consults the recall-layer HNSW cache so
      // scoreCandidate sees a real vector. Without these, scoreCandidate gets
      // a null vector + a null hnsw, Layer-3 corroboration is silently
      // skipped, and every watermark-path row PROMOTEs at novelty=0.5.
      localEmbedBatch: null,
      indexCache: null,
    };
    // Absolute URLs are REQUIRED — dynamic import inside lib-loader.js
    // resolves relative to lib-loader.js, not to this file. We build
    // every URL from this file's import.meta.url so the loader sees a
    // fully-qualified target.
    const { loadModule } = await import(
      new URL("../mcp/lib/lib-loader.js", import.meta.url).href
    );
    // R25.7 CRIT-A1: do NOT wrap loadModule in catch{}. The R25.6
    // structural defense throws a clear "missing expected export" at
    // boot when a provider/caller name drifts; the R25.6 catch{} here
    // silently swallowed that throw and preserved the original R25.5
    // silent-fallthrough failure mode. Fail-fast: if any cascade module
    // is missing an expected export, the daemon CRASHES at startup so
    // the operator sees the error, fixes the export, restarts.
    //
    // Note: a missing-on-disk module surfaces as a different error
    // class (ERR_MODULE_NOT_FOUND from dynamic import inside
    // loadModule). That ALSO propagates — every cascade module is
    // required to be present in production. The "module not yet
    // shipped" tolerance from R25.6 was only ever relevant during the
    // partial-deploy window which is now closed.
    mods.stage0 = await loadModule(
      new URL("../mcp/lib/ingest/stage0/index.js", import.meta.url).href,
      ["dispatch"],
    );
    mods.salience = await loadModule(
      new URL("../mcp/lib/ingest/salience.js", import.meta.url).href,
      ["scoreCandidate", "normalizeSourceEvent"],
    );
    mods.normalizeSourceEvent = mods.salience.normalizeSourceEvent;
    mods.promote = await loadModule(
      new URL("../mcp/lib/tools/distill-promote-fact.js", import.meta.url)
        .href,
      ["promoteSourceRow"],
    );
    // R25.7 CRIT-A2: gemini-client.embedSingle is the sync-embed entry
    // the cascade calls. loadIndices reuses the recall-layer
    // module-scope cache so warm starts skip disk I/O. Both throw at
    // boot if their expected exports drift, matching the lib-loader
    // discipline above.
    //
    // R25.X (Jun 2 2026 post-OOM): also load embedBatch + mrlSlice so
    // the tail loop can pre-fetch embeddings for the whole tick's row set
    // in one batched API call instead of one sync embedSingle per row.
    // 3000 rows × 100ms serial = 5 min/tick; 30 batched calls × 500ms
    // ≈ 15 sec/tick. The 100x latency win is what makes the 270k-row
    // backfill complete in tens of minutes instead of days, AND lets the
    // tick body return fast enough that the end-of-tick cursor write
    // actually fires.
    // WU2-inline-embed-and-remove-gemini-quota-machinery. The cascade now
    // embeds INLINE via the local Qwen3 server (full 4096-dim, no MRL slice,
    // no per-key quota). prefetchEmbeddings calls localEmbedBatch directly;
    // mods.localEmbedBatch is surfaced here so _setCascadeModsForTest can
    // inject a deterministic stub. The Gemini key-pool client is no longer
    // loaded on the cascade hot path.
    mods.localEmbedBatch = __localEmbedBatch;
    // R29.3 → WU2: hermetic test stub. When MEMORY_TEST_STUB_EMBEDDER=1 the
    // cascade swaps the real local embedder for a deterministic 4096-dim
    // unit-vector stub so hermetic tests that spawn the watermark daemon
    // exercise the SUCCESS path without a live embed server. It must NEVER be
    // set in production. Detection at the cascade boundary, not inside the
    // client, so the production module is unchanged.
    if (process.env.MEMORY_TEST_STUB_EMBEDDER === "1") {
      const STUB_VEC_4096 = new Array(4096);
      for (let i = 0; i < 4096; i++) STUB_VEC_4096[i] = i === 0 ? 1.0 : 0.0;
      mods.localEmbedBatch = async ({ items }) =>
        items.map((_t, i) => ({
          index: i,
          vector_4096: STUB_VEC_4096.slice(),
          embedding_model_version: ACTIVE_EMBED_MODEL_VERSION,
        }));
    }
    const cacheMod = await loadModule(
      new URL("../mcp/lib/recall/index-cache.js", import.meta.url).href,
      ["loadIndices", "evictModelIndices"],
    );
    mods.indexCache = cacheMod;
    // WU1-promote-time-content-dedup-gate. The EMBEDDING-FREE content-dedup
    // index. loadOrRebuildContentIndex builds/refreshes the
    // Map<content_hash, canonical_fact_id> from the canonical ledger
    // (streamed, mtime+size cached); addToContentIndex folds a just-promoted
    // fact's hash into the in-memory map so within-tick duplicates collapse.
    const contentIndexMod = await loadModule(
      new URL("../mcp/lib/synthesis/content-index.js", import.meta.url).href,
      ["loadOrRebuildContentIndex", "addToContentIndex"],
    );
    mods.contentIndex = contentIndexMod;
    return mods;
  })();
  // F-WM-CASCADE-LOAD-RETRY: evict a REJECTED promise from the memo so the
  // next call retries the import. The identity check guards the (unlikely)
  // interleave where another caller already replaced the memo before this
  // rejection handler ran — never clobber a newer attempt. The .catch here
  // also marks the rejection as handled for THIS branch; the promise
  // returned to the caller still rejects into the caller's try/catch.
  const loadAttempt = __cascadeModulesPromise;
  loadAttempt.catch(() => {
    if (__cascadeModulesPromise === loadAttempt) {
      __cascadeModulesPromise = null;
    }
  });
  return loadAttempt;
}

// Test-only override for the cascade modules surface. Set to a mock mods
// object via _setCascadeModsForTest to bypass the real loadCascadeModulesLazy
// (which would import the local embed client + HNSW caches). Hermetic tests
// inject a salience stub + a localEmbedBatch stub that returns deterministic
// vectors (or throws LocalEmbedUnavailableError to exercise the null+sweep
// fallback) without any real embed server or index. Resetting to null restores
// the production path. NEVER set in production code; only test files.
let __cascadeModsOverrideForTest = null;
export function _setCascadeModsForTest(mods) {
  __cascadeModsOverrideForTest = mods;
}

// WU1-promote-time-content-dedup-gate. Fold a just-promoted canonical fact's
// content hash into the in-tick content index so within-tick exact-content
// duplicates collapse to CORROBORATE on the NEXT row instead of re-promoting.
// Uses the SAME normalized content scoreCandidate consumed (via
// normalizeSourceEvent) so the in-tick hash matches the gate's lookup hash.
//
// FULLY DEFENSIVE: a failure here must never disturb the cascade — the fact
// row is already durable on disk; the in-tick registration is a best-effort
// optimization. Missing index / missing module / thrown normalize all
// degrade to "skip registration" silently.
function recordPromotedContentInIndex({ contentIndex, mods, event, source, pr }) {
  try {
    if (contentIndex == null || !(contentIndex.byContentHash instanceof Map)) return;
    if (mods == null || mods.contentIndex == null) return;
    const addFn = mods.contentIndex.addToContentIndex;
    if (typeof addFn !== "function") return;
    const factId =
      pr && typeof pr.memory_event_id === "string" ? pr.memory_event_id : null;
    if (factId === null) return;
    // Re-derive the same content scoreCandidate used. normalizeSourceEvent is
    // idempotent on rows that already carry a `content` string.
    let content = typeof event.content === "string" ? event.content : "";
    if (content.length === 0 && typeof mods.normalizeSourceEvent === "function") {
      try {
        const normalized = mods.normalizeSourceEvent({ ...event, source });
        content = typeof normalized.content === "string" ? normalized.content : "";
      } catch {
        content = "";
      }
    }
    if (content.length === 0) return; // empty content never dedups
    addFn(contentIndex, factId, content);
  } catch {
    // never throw into the cascade hot path
  }
}

// ---------------------------------------------------------------------------
// W3 — tick-scoped policy-event group-commit buffer.
//
// The per-row Stage-0 DROP/REDACT_DROP mirror emits (and the salience-layer
// emits threaded via ctx.policyEventSink) used to pay one lock+append+fsync
// EACH — ~1.06M tiny fsyncs in July 2026 from mail drop events alone. They
// now accumulate here and land via ONE appendPolicyEventsBatch call (one
// lock + one fsync per <=500 events).
//
// Crash-consistency discipline: the buffer is ALWAYS flushed before each
// writeSourceCursorAtomic — a cursor is never durably advanced past rows
// whose audit events exist only in memory (a crash may duplicate audit rows
// on re-tail, but never lose them for cursor-advanced rows) — plus a final
// flush in tickSourcesOnce's finally at tick end.
//
// Failure posture: a failed flush RESTORES the batch (unshifted, preserving
// emit order) and reports failure to its caller. Batching changed the blast
// radius of a swallowed error from one audit row to <=500, and the cursor
// advances past exactly the rows those rows describe — so unlike the pre-W3
// per-row emits, silently dropping is not acceptable here. Callers that are
// about to advance a cursor MUST NOT advance when this returns false.
// Rare-path emits (source_revoked, source_auto_muted, lock_reclaimed, bm25)
// stay as direct synchronous appendPolicyEvent calls.
// ---------------------------------------------------------------------------
const POLICY_EVENT_FLUSH_THRESHOLD = 500;
let __pendingPolicyEvents = [];

/**
 * Flush the tick-scoped policy-event buffer.
 * @returns {boolean} true iff the buffer is durably persisted (or was empty).
 *   On false the batch is restored to the head of the buffer for a later retry
 *   and the caller must not durably advance any cursor past those rows.
 */
function flushPendingPolicyEvents() {
  if (__pendingPolicyEvents.length === 0) return true;
  const batch = __pendingPolicyEvents;
  __pendingPolicyEvents = [];
  try {
    appendPolicyEventsBatch(batch);
    return true;
  } catch (err) {
    // Restore at the HEAD so emit order survives the retry, and so events
    // buffered after the failed flush still land behind their predecessors.
    __pendingPolicyEvents = batch.concat(__pendingPolicyEvents);
    try {
      process.stderr.write(
        "watermark: policy-event batch flush failed (" + batch.length +
          " audit events retained for retry; cursor will NOT advance): " +
          ((err && err.message) || String(err)) + "\n",
      );
    } catch {
      // ignore
    }
    return false;
  }
}

function bufferPolicyEvent(event) {
  __pendingPolicyEvents.push(event);
  // Bounded buffer: a huge cascade burst flushes every 500 events so the
  // in-memory backlog can never balloon.
  if (__pendingPolicyEvents.length >= POLICY_EVENT_FLUSH_THRESHOLD) {
    flushPendingPolicyEvents();
  }
}

// Sink handed to scoreCandidate (ctx.policyEventSink) so the salience-layer
// emitDropped/emitRedacted/emitCorroboration push into the tick buffer
// instead of paying a per-event fsync. MCP-process callers do not pass a
// sink and keep synchronous per-event durability.
const __tickPolicyEventSink = {
  push: (event) => bufferPolicyEvent(event),
};

// ---------------------------------------------------------------------------
// Q3 (memperf) — salience-KNN backend resolution: queryd vs in-process.
//
// The cascade's Layer-3 novelty/corroboration KNN used to deserialize its own
// full HNSW copy via mods.indexCache.loadIndices (2.6GB resident measured
// 2026-07-12). With a live queryd (Q1) the daemon-resident index answers the
// same searches over the unix socket, so post-cutover exactly ONE resident
// HNSW exists. Mode semantics (env MEMORY_QUERYD, Q2's vocabulary):
//   off      -> always in-process (today's loadIndices path, byte-identical);
//   required -> always daemon; a queryd outage degrades the tick to the
//               null-hnsw contract (novelty 0.5, no corroboration) — NEVER
//               an in-process index load;
//   auto     -> probe the queryd socket. UNLIKE Q2's per-process memoization
//               (deliberate for short-lived MCP sessions), this daemon is
//               LONG-LIVED: while in in-process mode the probe re-runs every
//               SALIENCE_QUERYD_REPROBE_TICKS ticks so an operator starting
//               queryd later is adopted without a watermark restart, and any
//               daemon-mode failure forces a re-probe on the NEXT tick (a
//               dead queryd falls back to in-process; a restarted one is
//               re-adopted).
//
// FAILURE DISCIPLINE (the herd ban, inherited from Q2): in daemon mode no
// failure path may reach loadIndices — the tick degrades loudly to hnsw=null
// (the exact contract of a loadIndices failure today) and the next tick
// re-probes. WRITE side (promote path via index-cache WAL/lease) is
// untouched — this seam is READ-only.
//
// LOGGING DISCIPLINE (inherited from queryd-client): no query text or
// vectors ever reach a log from this path; degrade lines carry transport/
// code messages only.
// ---------------------------------------------------------------------------
export const SALIENCE_QUERYD_REPROBE_TICKS = 40;
const SALIENCE_QUERYD_PROBE_TIMEOUT_MS = 50;

const __salienceQueryd = {
  mode: null, // null (never resolved) | "daemon" | "in-process"
  ticksSinceProbe: 0,
  forceReprobe: false,
  // Q3-herd-ban-parser (memperf): memoized queryd-client._readModeEnv() result
  // ("required"|"off"|"auto"). MEMORY_QUERYD is a deployment constant, so the
  // (loud, once-per-process) unrecognized-value warning fires only on the
  // first resolve/reset — never per tick.
  envMode: null,
};

// Test-only reset (codebase convention, cf. queryd-client._resetQuerydForTest)
// so hermetic tests can flip MEMORY_QUERYD / queryd lifecycles in-process.
// NEVER called by production code.
export function _resetSalienceQuerydForTest() {
  __salienceQueryd.mode = null;
  __salienceQueryd.ticksSinceProbe = 0;
  __salienceQueryd.forceReprobe = false;
  __salienceQueryd.envMode = null;
}

// Loud degrade breadcrumb (mirrors the in-process loadIndices-failure line)
// + arm the next-tick re-probe.
function __salienceQuerydDegrade(err) {
  __salienceQueryd.forceReprobe = true;
  try {
    process.stderr.write(
      "watermark: queryd unavailable for salience KNN (cascade degrades to " +
        "novelty=0.5, no corroboration this tick; re-probe next tick): " +
        ((err && err.message) || String(err)) + "\n",
    );
  } catch {
    // ignore
  }
}

// Q3-model-missing loud degrade (memperf): the queryd socket is HEALTHY but
// the daemon does NOT carry ACTIVE_EMBED_MODEL_VERSION (a deployment model
// mismatch). Mirrors recall's queryd_model_missing breadcrumb (recall.js) —
// name the missing active version and the versions the daemon actually serves,
// tagged degraded_reason=queryd_model_missing. DISTINCT from
// __salienceQuerydDegrade (a transport failure): NO forceReprobe is armed —
// a re-probe cannot fix a model mismatch on a live socket, so the next tick
// stays in daemon mode and degrades identically until the deployment is fixed.
// LOGGING DISCIPLINE: model versions only — never query text or vectors.
function __salienceQuerydModelMissing(models) {
  try {
    const served =
      Array.isArray(models) && models.length > 0
        ? models.map((e) => (e != null ? e.model_version : "?")).join(",")
        : "(none)";
    process.stderr.write(
      "watermark: queryd does not carry model_version " +
        ACTIVE_EMBED_MODEL_VERSION +
        " for salience KNN (daemon serves: " +
        served +
        "; cascade degrades to novelty=0.5, no corroboration this tick); " +
        "degraded_reason=queryd_model_missing\n",
    );
  } catch {
    // ignore
  }
}

// Per-tick queryd-backed ctx.hnsw handle. size() answers SYNCHRONOUSLY from
// the ONE status() response cached at tick start (the salience.js ctx.hnsw
// contract requires a sync size()); search() awaits hnsw_search and passes
// queryd's results through verbatim — queryd returns HnswIndex.search output
// unchanged ({memory_id, cosine_distance, rank}), so scoreCandidate sees the
// exact in-process shape. The FIRST failure marks the handle dead: the
// failing row degrades to knn-empty inside scoreCandidate's try/catch, and
// every later row this tick gets hnsw=null (the null-hnsw novelty-0.5
// contract) without a per-row reconnect storm.
function __makeQuerydSalienceHnsw(client, hnswSize) {
  let dead = false;
  return {
    size: () => (dead ? 0 : hnswSize),
    search: async (vector, k) => {
      if (dead) return [];
      let resp;
      try {
        resp = await client.hnswSearch(ACTIVE_EMBED_MODEL_VERSION, vector, k);
      } catch (err) {
        dead = true;
        __salienceQuerydDegrade(err);
        // Rethrow (never a silent Promise-shaped result): scoreCandidate's
        // try/catch treats THIS row as knn-empty; isDead() nulls the rest.
        throw err;
      }
      return Array.isArray(resp.results) ? resp.results : [];
    },
    isDead: () => dead,
  };
}

// Resolve the backend for THIS tick. Returns {mode, handle}: mode "daemon"
// with handle=null means "daemon mode but queryd unreachable this tick" —
// the cascade runs the null-hnsw degrade, never loadIndices.
async function __resolveSalienceHnswForTick(cascadeMods) {
  // Q3-herd-ban-parser (memperf): mode resolution is SINGLE-SOURCED from
  // queryd-client._readModeEnv (returns "required"|"off"|"auto") so an
  // unrecognized MEMORY_QUERYD value FAILS TOWARD the herd ban ("required"),
  // never a silent "auto" that would let a typo (MEMORY_QUERYD=requird)
  // re-enable in-process loadIndices. The pre-REG local parser here mapped any
  // unrecognized value to "auto" — the exact silent-auto hole _readModeEnv was
  // hardened to close. _readModeEnv emits exactly one stderr warning naming the
  // raw value; MEMORY_QUERYD is a deployment constant, so the resolved value is
  // memoized on __salienceQueryd.envMode (cleared by _resetSalienceQuerydForTest)
  // and the warning fires once per process/reset, not per tick.
  if (__salienceQueryd.envMode == null) {
    __salienceQueryd.envMode = __readModeEnv();
  }
  const envMode = __salienceQueryd.envMode;
  // Q3-evict-on-adoption (memperf): read the previous resolved mode BEFORE the
  // sole write of __salienceQueryd.mode below so the in-process -> daemon
  // adoption edge can be detected exactly (and only there).
  const prevMode = __salienceQueryd.mode;
  let mode;
  if (envMode === "off") {
    mode = "in-process";
    __salienceQueryd.ticksSinceProbe = 0;
    __salienceQueryd.forceReprobe = false;
  } else if (envMode === "required") {
    mode = "daemon";
    __salienceQueryd.forceReprobe = false;
  } else if (
    __salienceQueryd.mode === "daemon" &&
    !__salienceQueryd.forceReprobe
  ) {
    // Sticky while healthy: the per-tick status() below doubles as the
    // health check (the client budgets one reconnect per request), and a
    // failure arms forceReprobe so the next tick re-probes the socket.
    mode = "daemon";
  } else if (
    __salienceQueryd.mode === "in-process" &&
    !__salienceQueryd.forceReprobe &&
    __salienceQueryd.ticksSinceProbe < SALIENCE_QUERYD_REPROBE_TICKS
  ) {
    __salienceQueryd.ticksSinceProbe += 1;
    mode = "in-process";
  } else {
    let alive = false;
    try {
      alive = await __probeQuerydSocket(
        __querydPaths().socketPath,
        SALIENCE_QUERYD_PROBE_TIMEOUT_MS,
      );
    } catch {
      alive = false;
    }
    mode = alive ? "daemon" : "in-process";
    __salienceQueryd.ticksSinceProbe = 0;
    __salienceQueryd.forceReprobe = false;
  }
  __salienceQueryd.mode = mode;
  if (mode !== "daemon") {
    return { mode: "in-process", handle: null };
  }
  try {
    const client = __getQuerydClient();
    const status = await client.status();
    const models = Array.isArray(status.models) ? status.models : [];
    const m = models.find(
      (e) => e != null && e.model_version === ACTIVE_EMBED_MODEL_VERSION,
    );
    if (m == null) {
      // Q3-model-missing (memperf): the socket is healthy but the daemon does
      // NOT carry the active model version (deployment mismatch). Mirror
      // recall's queryd_model_missing discipline: degrade LOUDLY to the
      // null-hnsw contract (novelty=0.5, no corroboration) — NEVER fabricate a
      // silent size-0 KNN handle (__makeQuerydSalienceHnsw(client, 0)), which
      // would read as "index empty" and silently kill salience corroboration.
      // Do NOT fall back to in-process (that would break `required` mode's herd
      // ban) and do NOT evict — the in-process copy (if any) is the only
      // resident index for this model. See __salienceQuerydModelMissing (no
      // forceReprobe: a re-probe cannot fix a model mismatch).
      __salienceQuerydModelMissing(models);
      return { mode: "daemon", handle: null };
    }
    // Q3-evict-on-adoption (memperf): status() succeeded AND the daemon carries
    // the active model — this is the CONFIRMED in-process -> daemon adoption
    // edge iff the previous resolved mode was in-process. Release the multi-GB
    // module-global in-process HNSW copy so exactly ONE resident HNSW
    // (queryd's) survives the cutover. evictModelIndices is production-safe
    // (never touches on-disk index/manifest/WAL bytes, never throws, no-op on a
    // cold model; I8 WAL is the source of truth so a cancelled debounced save
    // replays on the next cold load). NEVER evict on the status-throw or
    // model-missing degrade branches — a later re-probe may return to
    // in-process and re-evicting there would thrash a reload.
    if (prevMode === "in-process") {
      cascadeMods?.indexCache?.evictModelIndices(ACTIVE_EMBED_MODEL_VERSION);
    }
    const hnswSize = Number.isInteger(m.hnsw_size) ? m.hnsw_size : 0;
    return {
      mode: "daemon",
      handle: __makeQuerydSalienceHnsw(client, hnswSize),
    };
  } catch (err) {
    __salienceQuerydDegrade(err);
    return { mode: "daemon", handle: null };
  }
}

async function runSourceCascade({ event, source, now, embedding_4096, contentIndex, salienceHnsw }) {
  if (event == null || typeof event !== "object") {
    return { decision: "DROP", reason: "non_object_event" };
  }
  let mods;
  if (__cascadeModsOverrideForTest != null) {
    mods = __cascadeModsOverrideForTest;
  } else {
    try {
      mods = await loadCascadeModulesLazy();
    } catch (err) {
      // R25.7 CRIT-A1: lib-loader's "missing expected export" throw is a
      // fatal structural error (export/lookup name drift). Re-throw so the
      // daemon crashes at startup rather than degrading silently per-event.
      // Other load errors (transient/IO) still degrade gracefully here.
      if (/missing expected export/.test(err && err.message || "")) throw err;
      return { decision: "ERROR", reason: "cascade_load_failed:" + (err.message || "unknown") };
    }
  }
  // Stage-0 hard-drop layer.
  //
  // R25.6: emit policy.salience.dropped / policy.salience.redacted at this
  // boundary too. Previously the watermark short-circuited on Stage-0 drop
  // without emitting any breadcrumb, so the operator had no signal that
  // Stage-0 was actually running. (When salience.js owns the call it emits
  // via emitDropped/emitRedacted; here the watermark short-circuits before
  // reaching salience, so we mirror the emit so downstream policy audits
  // still see the drop.)
  if (mods.stage0 && typeof mods.stage0.dispatch === "function") {
    try {
      const s0 = mods.stage0.dispatch(source, event, { now });
      if (s0 && s0.decision === "DROP") {
        const dropReason = s0.reason || "stage0";
        try {
          // W3: per-row hot path — buffered group-commit, not a per-event
          // fsync. Flushed before every cursor write + at tick end.
          //
          // Time-throttled through the SHARED helper so this mirror and
          // salience.js's emitDropped observe ONE window per (source, reason).
          // This is the dominant production path: the short-circuit here means
          // salience.js is never reached for a Stage-0 drop, so throttling only
          // there measured as a complete no-op (937 consecutive rows, zero
          // suppressed). See mcp/lib/ingest/drop-throttle.js.
          const { emit, suppressed } = shouldEmitDrop({
            source,
            reason: dropReason,
            nowIso: nowIso(now),
          });
          if (emit) {
            bufferPolicyEvent({
              kind: "policy.salience.dropped",
              source,
              source_msg_id:
                (event && typeof event.source_msg_id === "string"
                  ? event.source_msg_id
                  : null),
              reason: dropReason,
              ts: nowIso(now),
              suppressed_count: suppressed,
            });
          }
        } catch {
          // best-effort breadcrumb
        }
        return { decision: "DROP", reason: dropReason };
      }
      if (s0 && s0.decision === "REDACT_DROP") {
        try {
          // W3: per-row hot path — buffered group-commit (see above).
          bufferPolicyEvent({
            kind: "policy.salience.redacted",
            source,
            source_msg_id:
              (event && typeof event.source_msg_id === "string"
                ? event.source_msg_id
                : null),
            reason: s0.reason || "otp_pattern",
            ts: nowIso(now),
          });
        } catch {
          // best-effort breadcrumb
        }
        return { decision: "REDACT_DROP", reason: s0.reason || "stage0" };
      }
    } catch (err) {
      return { decision: "ERROR", reason: "stage0_throw:" + (err.message || "unknown") };
    }
  }
  // Salience scoring -> PROMOTE / CORROBORATE / DROP.
  //
  // CRIT-1a (R25.5): the `await` here is REQUIRED even though scoreCandidate
  // could in principle be made synchronous. salience.js:314 is `export async
  // function scoreCandidate` because Layer 1 (`loadStage0Dispatch`) does a
  // dynamic `import("./stage0/index.js")` on first call, AND so the
  // embed-batching future-path (R26+: queue several events, embed in one
  // gemini call) can land without breaking call sites. Removing the await
  // here returns a Promise instance that fails every subsequent `sc.decision
  // === "DROP"` string-compare (always falsy), so the function falls through
  // to the default `return PROMOTE` below — which is the exact bug-mask that
  // produced "163,200 rows decisioned PROMOTE, 0 written" in R25.
  if (mods.salience && typeof mods.salience.scoreCandidate === "function") {
    try {
      // WU2: the recall-layer HNSW for the ACTIVE local model version
      // (4096-dim) so Layer-3 corroboration fires against the same geometry
      // the cascade just embedded into. Q3 (memperf): the backend was
      // resolved ONCE per tick (salienceHnsw threaded from
      // tickSourcesOnceInner) — daemon mode serves searches from queryd's
      // resident index; in-process mode is today's loadIndices path,
      // byte-identically.
      let hnsw = null;
      if (salienceHnsw != null && salienceHnsw.mode === "daemon") {
        // Daemon mode: the per-tick queryd-backed handle. A null/dead handle
        // (queryd unreachable at tick start, or died mid-tick) degrades to
        // the null-hnsw contract — novelty=0.5, no corroboration. HERD BAN:
        // never loadIndices here; post-cutover exactly ONE resident HNSW
        // exists (queryd's).
        const h = salienceHnsw.handle;
        hnsw =
          h != null && !(typeof h.isDead === "function" && h.isDead())
            ? h
            : null;
      } else if (mods.indexCache && typeof mods.indexCache.loadIndices === "function") {
        // In-process mode: loadIndices is cheap on warm cache and degrades
        // to an empty index on first call.
        try {
          const idx = mods.indexCache.loadIndices(ACTIVE_EMBED_MODEL_VERSION);
          hnsw = idx && idx.hnsw ? idx.hnsw : null;
        } catch (err) {
          // Degrade open: cascade falls back to novelty=0.5 + no
          // corroboration. Log loudly so the operator notices.
          try {
            process.stderr.write(
              "watermark: loadIndices failed (cascade degrades to novelty=0.5): " +
                (err && err.message ? err.message : String(err)) + "\n",
            );
          } catch {}
        }
      }
      // WU2: the cascade pre-fetched the 4096-dim embedding for this row via
      // the local server (prefetchEmbeddings → ctx.embedding_4096). scoreCandidate
      // consumes it for the kNN novelty + corroboration AND surfaces it back on
      // the PROMOTE return so promoteSourceRow persists features.embedding_4096.
      // No ctx.embedder is wired on the production path — the local pre-fetch is
      // the single embed call site, so there is no per-row REST fallback (and no
      // Gemini-quota circuit-breaker to plumb).
      const ctx = {
        source,
        hnsw,
        now,
        // W3: route the salience-layer policy emits (dropped / redacted /
        // corroboration) into the tick's group-commit buffer instead of one
        // fsync per event. Callers without a sink (the MCP promote path)
        // keep synchronous per-event durability inside salience.js.
        policyEventSink: __tickPolicyEventSink,
      };
      // WU1-promote-time-content-dedup-gate. Thread the per-tick content index
      // so scoreCandidate's Layer-2.5 can CORROBORATE exact-content duplicates
      // WITHOUT an embedding (the Layer-3 path is dead when the local server is
      // down → null embedding). Absent contentIndex → gate skipped → normal
      // promote (degrade, never block). Defensive: only wire a real index.
      if (contentIndex != null && contentIndex.byContentHash instanceof Map) {
        ctx.contentIndex = contentIndex;
      }
      if (Array.isArray(embedding_4096) && embedding_4096.length > 0) {
        ctx.embedding_4096 = embedding_4096;
      }
      const sc = await mods.salience.scoreCandidate(
        event,
        ctx,
        { now },
      );
      if (sc && sc.decision === "DROP") {
        return { decision: "DROP", reason: sc.reason || "salience_drop" };
      }
      if (sc && sc.decision === "REDACT_DROP") {
        return { decision: "DROP", reason: sc.reason || "salience_redact_drop" };
      }
      if (sc && sc.decision === "CORROBORATE") {
        return { decision: "CORROBORATE", reason: sc.reason || "salience_corroborate" };
      }
      // PROMOTE — feed into the distill-promote pipeline. WU2: the cascade
      // always promotes (with embedding_4096 when the local server was up, or
      // with embedding=null when it was down). On the null-embed path the
      // caller (tickSourcesOnce) records the fact id to the re-embed sweep
      // file so a later tick re-embeds it.
      if (mods.promote && typeof mods.promote.promoteSourceRow === "function") {
        const pr = await mods.promote.promoteSourceRow(
          { event, source, salience: sc },
          { now },
        );
        // WU1: fold the just-promoted canonical into the in-tick content index
        // so subsequent identical rows in THIS batch collapse to CORROBORATE
        // instead of re-promoting. EARLIEST-wins inside addToContentIndex.
        recordPromotedContentInIndex({ contentIndex, mods, event, source, pr });
        // WU2: when the row promoted WITHOUT an embedding (local server down at
        // promote time) BUT it had embeddable content, record its fact id to
        // the simple re-embed sweep file so a later tick re-embeds it. Rows
        // with empty normalized content (nothing to embed) are NOT swept.
        const promotedWithoutEmbed =
          !(Array.isArray(sc.embedding_4096) && sc.embedding_4096.length > 0) &&
          !(Array.isArray(sc.embedding_mrl_768) && sc.embedding_mrl_768.length > 0);
        if (promotedWithoutEmbed && pr && typeof pr.memory_event_id === "string") {
          // Derive the normalized content the same way scoreCandidate did
          // (source rows carry text in raw_content; normalizeSourceEvent
          // canonicalizes it). Defensive: a throw here must not disturb the
          // already-durable fact row.
          let hadContent = false;
          try {
            if (typeof event.content === "string" && event.content.length > 0) {
              hadContent = true;
            } else if (typeof mods.normalizeSourceEvent === "function") {
              const normalized = mods.normalizeSourceEvent({ ...event, source });
              hadContent =
                typeof normalized.content === "string" && normalized.content.length > 0;
            }
          } catch {
            hadContent = false;
          }
          if (hadContent) appendReEmbedSweep(pr.memory_event_id, { now });
        }
      }
      return { decision: "PROMOTE", reason: null };
    } catch (err) {
      return { decision: "ERROR", reason: "salience_throw:" + (err.message || "unknown") };
    }
  }
  // Cascade modules absent — silent passthrough (watermark only advances
  // the cursor; downstream layers will pick up the rows when they ship).
  return { decision: "PASS", reason: "cascade_not_ready" };
}

// ---------------------------------------------------------------------------
// tickSourcesOnce — row-by-row tail-and-cascade across source-tier ledgers.
// One sweep per tick. Per-source isolation: a parse failure / cascade error
// on source A bumps A.error_count and advances A's cursor past the bad
// row; sources B/C/D are untouched.
//
// Connector_revoke discipline: a source whose target_source is in the
// loadRevokedSources() set is SKIPPED entirely this tick. We also emit
// policy.salience.source_revoked once per (source, tick) so the BFS in
// hard-gates.js can observe the kill-switch. Idempotency: the cursor is
// not advanced for revoked sources, so once the operator rescinds the
// revoke the daemon resumes from the same offset.
// ---------------------------------------------------------------------------

// WU2-inline-embed-and-remove-gemini-quota-machinery. Pre-fetch the FULL
// 4096-dim embeddings for an entire batch of source rows via the LOCAL Qwen3
// server in ONE round-trip (the client chunks at BATCH_CAP internally). The
// local server has no per-key quota and keeps pace with ingestion, so this is
// the cascade's single inline embed call site.
//
// Returns { embeddings, localUnavailable, reason, detail, items, elapsed_ms }:
//   - embeddings: Array<vector_4096 | null> parallel to rows[]. Rows with parse
//     errors / empty normalized content map to null and PROMOTE without an
//     embedding (the cursor still advances; the caller records the fact id to
//     the re-embed sweep file).
//   - localUnavailable: true when the local server threw
//     LocalEmbedUnavailableError (server down / mis-shaped). Every row then
//     gets a null embedding and the caller logs ONCE for the tick + records
//     each promoted fact id to the re-embed sweep file. Any OTHER throw also
//     degrades to all-null but is logged as an unexpected error. SEMANTICS
//     FROZEN — the single consumer below dispatches the degrade log on it.
//   - reason: classifyLocalEmbedFailure() code for the throw, or null on
//     success and on both early returns.
//   - detail: the raw error message (the caller sanitises + truncates it), or
//     null on success / early return.
//   - items: how many rows were actually handed to the embed call this tick.
//   - elapsed_ms: integer wall-clock of the embed call (0 when no call was
//     made). Measured on BOTH the success and the failure path so a slow
//     degrade is distinguishable from an instant one.
//
// W1 — WHY A REASON CODE EXISTS. LocalEmbedUnavailableError is ONE class over
// THIRTEEN construction sites in mcp/lib/local-embedder-client.js (transport
// :344, malformed fetch response :355, non-2xx :377, missing embeddings[] :384,
// embedSingle count :405, embedBatch count :447, and five _renormAndAssert
// vector-shape throws :269/:274/:280/:288/:297). The caller used to log a
// constant, causeless sentence and discard the error, so hundreds of
// production degrades were indistinguishable from one another.
//
// This deliberately does NOT key on err.statusCode the way
// mcp/lib/recall/rerank.js:385 does: LocalEmbedUnavailableError carries only
// { name, retryable, cause, url } (mcp/lib/local-embedder-client.js:121-132) —
// there is no statusCode field, and the HTTP status survives ONLY as the
// message substring `returned <status>:` (same file, :377-380).
//
// Cause is checked BEFORE the message on purpose: the transport site at :344
// interpolates netErr.message into its own text, so a message rule could
// otherwise shadow the real transport code.
function classifyLocalEmbedFailure(err) {
  if (!err) return "unknown";
  const cause = err.cause;
  if (cause) {
    if (cause.name === "AbortError" || cause.code === "ABORT_ERR") return "timeout";
    if (typeof cause.code === "string" && cause.code.length > 0) {
      return "conn_" + cause.code;
    }
  }
  const msg = typeof err.message === "string" ? err.message : "";
  // Status is DERIVED, not enumerated: 400/413/429/500/503 and anything else
  // the server grows all classify without another edit here.
  const status = msg.match(/returned (\d{3}):/);
  if (status) return "http_" + status[1];
  if (
    msg.includes("response missing embeddings[]") ||
    msg.includes("malformed fetch response from")
  ) {
    return "malformed_response";
  }
  if (/expected \d+ embeddings?, got \d+/.test(msg)) return "count_mismatch";
  if (
    msg.includes("is not a non-empty number[]") ||
    msg.includes(" dims; expected ") ||
    msg.includes("degenerate norm") ||
    msg.includes("not a finite number") ||
    msg.includes("unit-norm invariant violated")
  ) {
    return "bad_vector";
  }
  // A classifier with no escape hatch lies.
  return "unknown";
}

// E1 zero-norm-embedding-root-cause: Stage-0 telemetry for the per-row
// `embed_degenerate_vector` WARN. Obtained the way emitCursorLagAlarms gets
// its `tel`: a test-injected stub wins (cascadeMods.telemetry, a
// { recordDrop } object handed in via _setCascadeModsForTest), else the real
// module is dynamic-imported ONCE and cached — no new static import on the
// daemon's load path, and an import failure just means no counter.
let __stage0TelemetryMod = null;
async function resolveStage0Telemetry(cascadeMods) {
  if (
    cascadeMods &&
    cascadeMods.telemetry &&
    typeof cascadeMods.telemetry.recordDrop === "function"
  ) {
    return cascadeMods.telemetry;
  }
  if (__stage0TelemetryMod == null) {
    try {
      __stage0TelemetryMod = await import("../mcp/lib/ingest/stage0/telemetry.js");
    } catch {
      return null;
    }
  }
  return __stage0TelemetryMod;
}

async function prefetchEmbeddings(rows, source, cascadeMods) {
  const embeddings = new Array(rows.length).fill(null);
  if (
    !cascadeMods ||
    typeof cascadeMods.localEmbedBatch !== "function" ||
    typeof cascadeMods.normalizeSourceEvent !== "function"
  ) {
    return {
      embeddings,
      localUnavailable: false,
      reason: null,
      detail: null,
      items: 0,
      elapsed_ms: 0,
      degenerate: 0,
    };
  }
  const items = []; // [{idx, text}]
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.parse_error || row.event == null) continue;
    let text;
    try {
      const normalized = cascadeMods.normalizeSourceEvent({
        ...row.event,
        source,
      });
      text = typeof normalized.content === "string" ? normalized.content : "";
    } catch {
      text = "";
    }
    if (text.length === 0) continue;
    items.push({ idx: i, text });
  }
  if (items.length === 0) {
    return {
      embeddings,
      localUnavailable: false,
      reason: null,
      detail: null,
      items: 0,
      elapsed_ms: 0,
      degenerate: 0,
    };
  }
  let batch;
  // W1: time the call on BOTH paths — "unavailable in 3ms" (connection
  // refused) and "unavailable in 30000ms" (hung server, aborted) are different
  // operational stories that the old constant line could not tell apart.
  const embedStartedAt = process.hrtime.bigint();
  try {
    // Documents embed with is_query:false (the asymmetric Qwen3 instruction
    // prefix for retrieval documents; recall-time queries pass is_query:true).
    batch = await cascadeMods.localEmbedBatch({
      items: items.map((it) => it.text),
      isQuery: false,
    });
  } catch (err) {
    const elapsed_ms = Number(
      (process.hrtime.bigint() - embedStartedAt) / 1000000n,
    );
    const localUnavailable =
      err instanceof __LocalEmbedUnavailableError ||
      (err && err.name === "LocalEmbedUnavailableError");
    if (!localUnavailable) {
      // An UNEXPECTED throw (not a clean server-down signal) — log it; we still
      // degrade to all-null so the tick keeps capturing.
      try {
        process.stderr.write(
          "watermark: localEmbedBatch failed for source=" +
            source +
            " (promoting with null embedding + sweep): " +
            (err && err.message ? err.message : String(err)) +
            "\n",
        );
      } catch {
        // ignore
      }
    }
    return {
      embeddings,
      localUnavailable,
      reason: classifyLocalEmbedFailure(err),
      detail: err && err.message ? err.message : String(err),
      items: items.length,
      elapsed_ms,
      degenerate: 0,
    };
  }
  const embedElapsedMs = Number(
    (process.hrtime.bigint() - embedStartedAt) / 1000000n,
  );
  // Map batch result back to row index. The local client returns per-item
  // records carrying { index, vector_4096 } in input order. E1: a record
  // carrying `degenerate` is a ROW-SCOPED fault (the client already retried
  // that one text alone) — its row alone keeps embedding=null and reaches the
  // re-embed sweep via promotedWithoutEmbed; siblings keep their vectors.
  let degenerate = 0;
  for (let j = 0; j < batch.length && j < items.length; j++) {
    const result = batch[j];
    if (result && result.degenerate) degenerate += 1;
    if (!result || !Array.isArray(result.vector_4096)) continue;
    if (result.vector_4096.length === CAPS.EMBEDDING_DIM_4096) {
      embeddings[items[j].idx] = result.vector_4096;
    }
  }
  if (degenerate > 0) {
    // ONE line per (source, tick), a different prefix from the
    // "local embed server unavailable for source=" line, which must NOT fire
    // here: the server answered, one row was degenerate.
    try {
      process.stderr.write(
        "watermark: local embed degenerate vectors source=" + source +
          " count=" + degenerate +
          " items=" + items.length +
          " — row-scoped null embedding + re-embed sweep\n",
      );
    } catch {
      // ignore
    }
    const tel = await resolveStage0Telemetry(cascadeMods);
    if (tel && typeof tel.recordDrop === "function") {
      for (let k = 0; k < degenerate; k++) {
        try {
          tel.recordDrop(source, "embed_degenerate_vector", "WARN");
        } catch {
          // Telemetry never crashes the tick.
        }
      }
    }
  }
  return {
    embeddings,
    localUnavailable: false,
    reason: null,
    detail: null,
    items: items.length,
    elapsed_ms: embedElapsedMs,
    degenerate,
  };
}

async function tickSourcesOnce({ now } = {}) {
  // W3: final group-commit flush in a finally at tick end — buffered audit
  // events (stage0 mirrors + salience-sink emits) always land durably before
  // the tick settles, even when the walk throws or aborts early.
  try {
    return await tickSourcesOnceInner({ now });
  } finally {
    flushPendingPolicyEvents();
  }
}

async function tickSourcesOnceInner({ now } = {}) {
  const results = {
    sources_walked: 0,
    rows_read: 0,
    rows_promoted: 0,
    rows_corroborated: 0,
    rows_dropped: 0,
    rows_errored: 0,
    sources_revoked_skipped: 0,
    // F-WM-CASCADE-LOAD-TICK-ABORT (DEFECT 3b): true when the tick aborted
    // before walking any source because the cascade modules failed to load.
    cascade_load_failed: false,
  };
  const revoked = loadRevokedSources();
  const ledgers = listSourceLedgers();
  // R25.X: load cascade modules once upfront so prefetchEmbeddings has
  // direct access to embedBatch / mrlSlice / normalizeSourceEvent. The
  // promise is idempotent: subsequent runSourceCascade calls hit the same
  // cached promise. A missing-expected-export propagates here (per R25.7
  // CRIT-A1 fail-fast); other load errors degrade open (prefetch will
  // return all-null and per-row embedSingle takes over).
  let cascadeMods = null;
  if (__cascadeModsOverrideForTest != null) {
    // R29.3: tests inject a mock cascade mods bundle to bypass
    // gemini-client / HNSW loads. See _setCascadeModsForTest.
    cascadeMods = __cascadeModsOverrideForTest;
  } else {
    try {
      cascadeMods = await loadCascadeModulesLazy();
    } catch (err) {
      if (/missing expected export/.test((err && err.message) || "")) throw err;
      // F-WM-CASCADE-LOAD-TICK-ABORT (DEFECT 3b): a module-load failure is
      // a SYSTEMIC (non-row) fault — no row was actually judged, so no row
      // may be charged for it. The old behaviour fell through with
      // cascadeMods=null, every row then re-hit the loader inside
      // runSourceCascade, surfaced as per-row decision:"ERROR", bumped
      // error_count toward the auto-mute threshold, AND advanced the cursor
      // past rows the cascade never saw (unrecoverable data skip: the
      // cursor is the only record of what was processed). Instead: abort
      // the whole source walk for this tick — cursors pinned, error_count
      // untouched, ONE stderr line — and let the next tick retry the import
      // (the rejected loader promise was evicted; see
      // F-WM-CASCADE-LOAD-RETRY).
      results.cascade_load_failed = true;
      try {
        process.stderr.write(
          "watermark: cascade module load failed — aborting source walk this tick " +
            "(cursors NOT advanced, error_count NOT bumped; import retried next tick): " +
            ((err && err.message) || String(err)) + "\n",
        );
      } catch {
        // ignore
      }
      return results;
    }
  }
  // Promote-time content-dedup gate (the embedding-free corroboration gate).
  // Build/refresh the content index ONCE per tick and thread it into every
  // runSourceCascade call so identical-content rows CORROBORATE instead of
  // promoting duplicate facts — the fix for the ~95%-duplicate ledger when
  // Gemini is down and the embed-novelty gate defaults to neutral/admit.
  // Defensive: any failure leaves tickContentIndex null -> gate skipped ->
  // normal promote (capture is never blocked). CAPS-gated.
  let tickContentIndex = null;
  if (
    CAPS.CASCADE_CONTENT_DEDUP_ENABLED === true &&
    cascadeMods != null &&
    cascadeMods.contentIndex != null &&
    typeof cascadeMods.contentIndex.loadOrRebuildContentIndex === "function"
  ) {
    try {
      tickContentIndex = await cascadeMods.contentIndex.loadOrRebuildContentIndex({
        ledgerPath: memoryLedgerPath(),
        cachePath: join(STORAGE_DIR, "content-index.cache.json"),
      });
    } catch (err) {
      tickContentIndex = null;
      try {
        process.stderr.write(
          "watermark: content-index build failed (dedup gate skipped this tick): " +
            ((err && err.message) || String(err)) + "\n",
        );
      } catch {
        // ignore
      }
    }
  }
  // Q3 (memperf): resolve the salience-KNN backend ONCE per tick — "daemon"
  // (queryd socket live / MEMORY_QUERYD=required) builds a queryd-backed
  // ctx.hnsw handle whose size() is answered from ONE cached status()
  // response; "in-process" keeps today's per-row loadIndices path
  // byte-identically. See __resolveSalienceHnswForTick for the long-lived
  // re-probe cadence (deliberately NOT Q2's per-process memoization).
  const salienceHnswTick = await __resolveSalienceHnswForTick(cascadeMods);
  // WU2 removed the per-tick "skip inline embed" decision. That gate existed
  // only to hand the shared Gemini connection pool to the async embed-backfill
  // worker when keys were cooled or the queue was backlogged. The cascade now
  // embeds inline via the local server (no shared pool, no async worker), so it
  // ALWAYS embeds inline; on a local-server outage prefetchEmbeddings returns
  // all-null + localUnavailable and the row promotes with a null embedding.
  for (const { source, path } of ledgers) {
    results.sources_walked += 1;
    // Wave 9 — captured-only sources are NOT cascaded. The connector
    // daemon (lib/connectors/<source>.js) continues to tail the upstream
    // feed and append rows to storage/sources/<source>.jsonl; the
    // watermark daemon skips dispatch entirely so no Stage-0 module
    // fires, no cursor advances, and no error_count is bumped. This is
    // the explicit opt-in twin of the implicit "no Stage-0 module
    // shipped yet" pattern (telegram/slack/mail/whatsapp pre-ship).
    // Removing the source from CAPS.WATERMARK_CAPTURED_ONLY_SOURCES
    // (and likely clearing its cursor) re-activates full cascade
    // processing — the mode is reversible by design.
    if (
      Array.isArray(CAPS.WATERMARK_CAPTURED_ONLY_SOURCES) &&
      CAPS.WATERMARK_CAPTURED_ONLY_SOURCES.includes(source)
    ) {
      continue;
    }
    if (revoked.has(source)) {
      results.sources_revoked_skipped += 1;
      try {
        appendPolicyEvent({
          kind: "policy.salience.source_revoked",
          source,
          revoked_at: nowIso(now),
        });
      } catch {
        // best-effort breadcrumb
      }
      continue;
    }
    let cursor = readSourceCursor(source);
    if (cursor == null) {
      cursor = emptyCursor(source, { now });
    }
    if (cursor.muted_until != null) {
      // Operator-driven mute; skip.
      continue;
    }
    if (cursor.error_count >= WATERMARK_SOURCE_ERROR_THRESHOLD) {
      // Auto-mute after threshold; operator must clear error_count to resume
      // (the F-WM-BREAKER-RESET clean-tick reset below can only fire on a
      // source that is still being ticked, so a tripped breaker stays
      // tripped until the operator intervenes).
      //
      // F-WM-AUTOMUTE-SIGNAL (DEFECT 1, Jul 2026): this used to be a bare
      // `continue` — no stderr, no policy event, no cursor write. git-log
      // sat silently auto-muted for a MONTH because the only evidence was
      // a number inside a cursor file nobody reads. Emit one stderr line +
      // one policy.daemon.source_auto_muted audit event per mute window:
      // the module-level Set throttles to once per daemon lifetime per
      // source, and the F-WM-BREAKER-RESET path deletes the source from
      // the Set when its error_count resets, so a LATER re-trip logs again
      // (one signal per mute window, not one per tick, not one forever).
      if (!__autoMuteSignalledSources.has(source)) {
        __autoMuteSignalledSources.add(source);
        try {
          process.stderr.write(
            "watermark: source=" + source + " auto-muted error_count=" +
              cursor.error_count + " threshold=" +
              WATERMARK_SOURCE_ERROR_THRESHOLD +
              " (clear error_count in the cursor file to resume)\n",
          );
        } catch {
          // ignore
        }
        try {
          appendPolicyEvent({
            kind: "policy.daemon.source_auto_muted",
            source,
            error_count: cursor.error_count,
            threshold: WATERMARK_SOURCE_ERROR_THRESHOLD,
            muted_at: nowIso(now),
          });
        } catch {
          // best-effort breadcrumb
        }
      }
      continue;
    }
    let snapSize;
    try {
      snapSize = statSync(path).size;
    } catch {
      continue;
    }
    const startOffset = BigInt(cursor.last_offset || "0");
    const startNum = Number(startOffset);
    if (snapSize <= startNum) {
      // No new data.
      continue;
    }
    // R25.X (Jun 2 2026 post-OOM): cap the per-tick read so the daemon does
    // not allocate the entire remaining ledger tail in one Buffer + parse the
    // whole thing into live JS objects at once. Without this, processing
    // git-log (169MB tail) from a fresh cursor allocates ~1.5GB of live V8
    // state per tick — the cause of the 4GB+ OOM cycles observed during
    // post-R25.7 verification. The cursor advances per-row inside the loop
    // below, so the next tick picks up exactly where this one stopped.
    const tickEnd = Math.min(
      snapSize,
      startNum + WATERMARK_SOURCE_MAX_BYTES_PER_TICK,
    );
    const rows = readSourceRowsInRange(path, startNum, tickEnd);
    // WU2: pre-fetch all 4096-dim embeddings for this tick's row set in ONE
    // local-server round-trip (the client chunks internally). The local server
    // has no per-key quota, so this never throttles; on a server outage it
    // returns all-null + localUnavailable=true and every promoted row records
    // its fact id to the re-embed sweep file (logged once below).
    const {
      embeddings,
      localUnavailable,
      reason: embedFailReason,
      detail: embedFailDetail,
      items: embedItems,
      elapsed_ms: embedElapsedMs,
    } = await prefetchEmbeddings(rows, source, cascadeMods);
    if (localUnavailable) {
      // W1: ONE line per (source, tick), same as before — but it now NAMES the
      // failure. The leading "watermark: local embed server unavailable for
      // source=" prefix is byte-for-byte stable so existing operator greps keep
      // matching. `detail` is SERVER-CONTROLLED text (the client interpolates
      // the response body into `returned <status>: <apiMsg>`), so CR/LF are
      // folded to a single space BEFORE truncation — an unsanitised detail
      // would let the embed server forge a standalone log line and break the
      // one-line-per-tick invariant. The whole write stays inside try{}catch{}:
      // a logging failure must never propagate into the tick.
      try {
        const detailLine = String(embedFailDetail == null ? "" : embedFailDetail)
          .replace(/[\r\n]+/g, " ")
          .slice(0, 300);
        process.stderr.write(
          "watermark: local embed server unavailable for source=" + source +
            " reason=" + embedFailReason +
            " items=" + embedItems +
            " elapsed_ms=" + embedElapsedMs +
            " — promoting with null embedding + recording to re-embed sweep: " +
            detailLine + "\n",
        );
      } catch {
        // ignore
      }
    }
    let advanced = false;
    // F-WM-BREAKER-RESET (DEFECT 2, Jul 2026): per-tick tallies feeding the
    // consecutive-failure semantics of the circuit breaker. error_count used
    // to be LIFETIME-CUMULATIVE — it only ever went up, so one poisoned
    // batch (3,138 errors in a single tick from a transient module-load
    // failure) muted a source forever even after the cause was fixed, and
    // slow drips (chat-claude-code at 34/50 from transients) were a death
    // sentence on a delay. A tick that processes >= 1 row with ZERO errors
    // now resets error_count to 0 (see end of the row loop below), making
    // the threshold effectively "50 errors with no intervening clean tick".
    let tickRowsOk = 0;
    let tickRowErrors = 0;
    // R25.X: incremental cursor checkpoint. Per-row sync-embed makes a single
    // tick take minutes against thousands of rows; the existing end-of-loop
    // cursor write means an OOM-restart loses ALL progress for that tick.
    // Write the cursor every N rows so a crash mid-tick costs at most ~100
    // re-processed rows on resume.
    let rowsSinceCheckpoint = 0;
    const CHECKPOINT_INTERVAL = 100;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      results.rows_read += 1;
      if (row.parse_error != null) {
        cursor.error_count = (cursor.error_count || 0) + 1;
        cursor.last_offset = String(row.offset_end);
        results.rows_errored += 1;
        tickRowErrors += 1;
        try {
          process.stderr.write(
            "watermark: source=" + source + " parse error at offset " +
              row.offset_start + ": " + row.parse_error + "\n",
          );
        } catch {
          // ignore
        }
        advanced = true;
        rowsSinceCheckpoint += 1;
        continue;
      }
      let outcome;
      try {
        outcome = await runSourceCascade({
          // A1 (confirm-only): row.event is the VERBATIM parsed source-ledger
          // row (raw_content + parties intact). This passthrough is load-
          // bearing for attribution — promoteSourceRow extracts the closed-key
          // features.attribution subset + top-level parties[] from it. No
          // projection/whitelist strips raw_content before promote.
          event: row.event,
          source,
          now,
          embedding_4096: embeddings[i],
          contentIndex: tickContentIndex,
          salienceHnsw: salienceHnswTick,
        });
      } catch (err) {
        outcome = { decision: "ERROR", reason: "cascade_throw:" + (err.message || "unknown") };
      }
      if (
        outcome.decision === "ERROR" &&
        typeof outcome.reason === "string" &&
        outcome.reason.startsWith("cascade_load_failed")
      ) {
        // F-WM-CASCADE-LOAD-TICK-ABORT (DEFECT 3b), defensive per-row twin
        // of the tick-start abort above: a module-load failure is SYSTEMIC,
        // not a property of this row. Charging it per-row both (a) advanced
        // the cursor past rows the cascade never judged and (b) bumped
        // error_count toward auto-mute for a fault no operator-cleared
        // cursor could fix. Abort THIS source's row walk: cursor stays at
        // the last genuinely processed row (earlier rows in this tick keep
        // their legitimate advancement), error_count untouched, one stderr
        // line for the whole batch instead of one per row.
        try {
          process.stderr.write(
            "watermark: source=" + source + " cascade module load failed — " +
              "aborting this source's row walk (cursor pinned at offset " +
              cursor.last_offset + ", error_count NOT bumped): " +
              (outcome.reason || "unknown") + "\n",
          );
        } catch {
          // ignore
        }
        break;
      }
      if (outcome.decision === "ERROR") {
        // G1 (F-G1-WM-ERROR-ADVANCE) — quarantine BEFORE the cursor advance
        // below, so the row is durably recoverable at the instant the
        // watermark gives up its only pointer to it. This must stay the
        // first statement in the branch: it provably precedes both the
        // error_count bump and the last_offset write.
        //
        // Strictly best-effort and strictly additive:
        //   - default-off (see errorQuarantineEnabled)
        //   - the try/catch is load-bearing: ENOSPC / EACCES / ENOTDIR out
        //     of the quarantine layer must never escape the row loop and
        //     abort a tick, and must never head-of-line-block the source.
        //   - it contributes NO second error_count bump — the arithmetic
        //     below stays exactly +1 per ERROR row, so the auto-mute gate
        //     at WATERMARK_SOURCE_ERROR_THRESHOLD behaves identically.
        //   - `source` is passed explicitly: quarantineRow throws TypeError
        //     when it cannot resolve one, and row.event.source is not
        //     guaranteed to be present on a row the cascade just failed on.
        let quarantinePath = null;
        if (errorQuarantineEnabled()) {
          try {
            const q = quarantineRow(row.event, "watermark_cascade_error", {
              source,
              rule_id: ERROR_QUARANTINE_RULE_ID,
              now,
            });
            quarantinePath = q && q.path ? q.path : null;
          } catch {
            // Quarantine is recoverability, not correctness. A write
            // failure degrades to today's behavior (row skipped, cursor
            // advances) — it never aborts the tick.
          }
        }
        cursor.error_count = (cursor.error_count || 0) + 1;
        cursor.last_offset = String(row.offset_end);
        results.rows_errored += 1;
        tickRowErrors += 1;
        try {
          process.stderr.write(
            "watermark: source=" + source + " cascade error at offset " +
              row.offset_start + ": " + (outcome.reason || "unknown") +
              (quarantinePath ? " (quarantined: " + quarantinePath + ")" : "") + "\n",
          );
        } catch {
          // ignore
        }
        advanced = true;
        rowsSinceCheckpoint += 1;
        continue;
      }
      // WU2: the cascade no longer parks on embed failure. The local server
      // has no per-key quota; on a server outage the row PROMOTES with a null
      // embedding and the fact id is recorded to the re-embed sweep file (in
      // runSourceCascade). So there is no EMBED_DEFERRED / cursor-park branch —
      // every visited row advances the cursor.
      if (outcome.decision === "DROP") results.rows_dropped += 1;
      else if (outcome.decision === "CORROBORATE") results.rows_corroborated += 1;
      else if (outcome.decision === "PROMOTE") results.rows_promoted += 1;
      // Advance cursor + last-event metadata.
      cursor.last_offset = String(row.offset_end);
      if (row.event && typeof row.event.ts === "string") {
        cursor.last_appended_ts = row.event.ts;
      }
      if (row.event && typeof row.event.source_msg_id === "string") {
        cursor.last_event_id = row.event.source_msg_id;
      } else if (row.event && typeof row.event.id === "string") {
        cursor.last_event_id = row.event.id;
      }
      advanced = true;
      // F-WM-BREAKER-RESET: any non-ERROR outcome (PROMOTE / CORROBORATE /
      // DROP / REDACT_DROP / PASS) counts as a successfully processed row
      // for the clean-tick reset check below.
      tickRowsOk += 1;
      rowsSinceCheckpoint += 1;

      // Incremental cursor checkpoint. Atomic write (tmp + rename) so a
      // concurrent reader sees either the prior state or the new state, never
      // a torn write. Failures here do NOT halt the loop — the end-of-tick
      // write below will retry on a clean cursor.
      if (rowsSinceCheckpoint >= CHECKPOINT_INTERVAL) {
        try {
          // W3 crash-consistency: flush buffered policy events BEFORE the
          // cursor durably advances — a crash may duplicate audit rows on
          // re-tail but can never lose them for cursor-advanced rows. A FAILED
          // flush retains the batch, so skip the checkpoint entirely: advancing
          // here would strand up to 500 audit rows for rows we mark consumed.
          if (flushPendingPolicyEvents()) {
            writeSourceCursorAtomic(cursor, { now });
            rowsSinceCheckpoint = 0;
          }
        } catch {
          // best-effort; will retry at end-of-tick
        }
      }
    }
    // F-WM-BREAKER-RESET (DEFECT 2): a tick that processed at least one row
    // and charged ZERO errors proves the failure streak (if any) is over —
    // reset the breaker so old transients cannot accumulate into a mute.
    // Threshold semantics are otherwise unchanged: errors WITHIN a tick
    // still sum, and a source that only ever errors never resets. The
    // auto-mute signal throttle is also re-armed here so a future re-trip
    // of the breaker is signalled again (one signal per mute window).
    if (tickRowsOk >= 1 && tickRowErrors === 0) {
      if ((cursor.error_count || 0) > 0) {
        cursor.error_count = 0;
      }
      __autoMuteSignalledSources.delete(source);
    }
    if (advanced) {
      try {
        // W3 crash-consistency: same flush-before-cursor-advance discipline
        // as the incremental checkpoint above. On a failed flush the batch is
        // retained and the cursor is NOT advanced — the rows re-tail next tick
        // (duplicate audit rows are acceptable; lost ones are not).
        if (!flushPendingPolicyEvents()) {
          throw new Error(
            "policy-event flush failed; refusing to advance cursor for source=" + source,
          );
        }
        writeSourceCursorAtomic(cursor, { now });
      } catch (err) {
        try {
          process.stderr.write(
            "watermark: source=" + source + " cursor write failed: " +
              (err.message || String(err)) + "\n",
          );
        } catch {
          // ignore
        }
      }
    }
  }
  return results;
}

// R32.1: readTurnsInRange + getOrCreateConversation removed with tickOnce
// (they parsed chat-<runtime>.jsonl entries into per-conversation pending
// queues that the dead idle-watermark pipeline drained). The cascade tier
// uses readSourceRowsInRange + per-source cursors instead.

// ---------------------------------------------------------------------------
// F-NEW-W7-CURSOR-LAG-ALARM. Periodic check: for each source, compute the
// lag between the source ledger's tail row ts and the cursor's
// last_appended_ts. When the lag exceeds CURSOR_LAG_WARN_THRESHOLD_MS AND
// the source ledger has grown in CURSOR_LAG_LEDGER_GROWTH_WINDOW_MS, emit
// a one-line stderr WARN + bump the Stage-0 telemetry counter via
// recordDrop(entry.source, "cursor_lag_warn", "WARN"). Note the source is
// the LAGGING source (e.g. "imessage", "screentime"), not the literal
// string "watermark" — each source's counter increments independently so
// the operator can see which sources are stuck without parsing the body.
//
// Cheap: one statSync + one tail read per source. The tail read is bounded
// to TAIL_READ_BUDGET bytes; we walk backwards from EOF to find the
// last newline-terminated JSON row and parse only its `ts` field.
//
// Returns Array<{source, cursor_ts, tail_ts, lag_ms, ledger_size_bytes,
// ledger_mtime_ms, ledger_growing, warned}> so the caller can surface the
// full lag picture into health.js + connectors-list.js without re-walking.
// `ledger_growing` is derived from comparing ledger_mtime_ms against a
// CURSOR_LAG_LEDGER_GROWTH_WINDOW_MS window.
// ---------------------------------------------------------------------------

const CURSOR_LAG_TAIL_READ_BUDGET = 64 * 1024; // 64KiB — plenty for one row

function readLedgerTailTs(path) {
  // Read up to CURSOR_LAG_TAIL_READ_BUDGET bytes from the end of the file
  // and parse the last non-blank JSON line's `ts` field. Returns null on
  // any failure (missing file, parse error, missing ts) — caller treats
  // null as "no signal" rather than crashing the alarm path.
  let fd = -1;
  try {
    const st = statSync(path);
    if (!st || st.size <= 0) return { ts: null, size: 0, mtimeMs: 0 };
    const readSize = Math.min(st.size, CURSOR_LAG_TAIL_READ_BUDGET);
    const start = st.size - readSize;
    fd = openSync(path, "r");
    const buf = Buffer.alloc(readSize);
    let read = 0;
    while (read < buf.length) {
      const chunk = readSync(fd, buf, read, buf.length - read, start + read);
      if (chunk === 0) break;
      read += chunk;
    }
    const text = buf.slice(0, read).toString("utf8");
    // Trim trailing whitespace then take the final non-blank line.
    const trimmed = text.replace(/\s+$/g, "");
    const lastNl = trimmed.lastIndexOf("\n");
    const line = lastNl >= 0 ? trimmed.slice(lastNl + 1) : trimmed;
    if (line === "") return { ts: null, size: st.size, mtimeMs: st.mtimeMs };
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ts: null, size: st.size, mtimeMs: st.mtimeMs };
    }
    const ts = parsed && typeof parsed.ts === "string" ? parsed.ts : null;
    return { ts, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { ts: null, size: 0, mtimeMs: 0 };
  } finally {
    if (fd !== -1) {
      try { closeSync(fd); } catch {}
    }
  }
}

// computeCursorLagSnapshot — pure, side-effect-free. Walks every source
// ledger + cursor and returns lag entries. Exported so health.js / hermetic
// tests can call it directly without spinning the daemon.
export function computeCursorLagSnapshot({ now } = {}) {
  const ledgers = listSourceLedgers();
  const nowEpochMs = nowMs(now);
  const out = [];
  for (const { source, path } of ledgers) {
    // Wave 9 — captured-only sources cannot be "behind on cascade" by
    // definition (tickSourcesOnce never dispatches them, so the cursor
    // is never advanced and last_appended_ts never tracks the ledger
    // tail). Filtering here keeps the cursor-lag alarm + the
    // memory_connectors_list cursor_lag surface focused on actionable
    // cascade lag rather than spurious "captured-only never advances"
    // noise.
    if (
      Array.isArray(CAPS.WATERMARK_CAPTURED_ONLY_SOURCES) &&
      CAPS.WATERMARK_CAPTURED_ONLY_SOURCES.includes(source)
    ) {
      continue;
    }
    const tail = readLedgerTailTs(path);
    const cursor = readSourceCursor(source);
    const cursorTs =
      cursor && typeof cursor.last_appended_ts === "string"
        ? cursor.last_appended_ts
        : null;
    const cursorEpochMs = cursorTs ? Date.parse(cursorTs) : NaN;
    const tailEpochMs = tail.ts ? Date.parse(tail.ts) : NaN;
    let lagMs = null;
    if (Number.isFinite(tailEpochMs) && Number.isFinite(cursorEpochMs)) {
      lagMs = tailEpochMs - cursorEpochMs;
    }
    // "Ledger has grown in the last hour" → mtime within the growth
    // window. Falls back to true when mtime is unknown so the alarm
    // does not silently misfire on a stat failure.
    const ledgerGrowing =
      tail.mtimeMs > 0
        ? nowEpochMs - tail.mtimeMs < CURSOR_LAG_LEDGER_GROWTH_WINDOW_MS
        : true;
    const warned =
      lagMs != null &&
      lagMs > CURSOR_LAG_WARN_THRESHOLD_MS &&
      ledgerGrowing;
    out.push({
      source,
      cursor_ts: cursorTs,
      tail_ts: tail.ts,
      lag_ms: lagMs,
      ledger_size_bytes: tail.size,
      ledger_mtime_ms: tail.mtimeMs,
      ledger_growing: ledgerGrowing,
      warned,
    });
  }
  return out;
}

// emitCursorLagAlarms — wraps the pure snapshot in side effects (stderr
// WARN + per-source Stage-0 telemetry counter). Called every
// CURSOR_LAG_CHECK_EVERY_N_TICKS ticks from the main-loop driver.
//
// Test seam: `opts.snapshot` lets callers inject a pre-computed snapshot
// (skipping the real computeCursorLagSnapshot + listSourceLedgers walk).
// `opts.telemetry` lets callers inject a stub with a `recordDrop` method
// instead of dynamic-importing stage0/telemetry.js. Both default to the
// production paths when omitted, so the production call site is unchanged.
export async function emitCursorLagAlarms({ now, snapshot: injectedSnap, telemetry: injectedTel } = {}) {
  let snapshot = injectedSnap;
  if (snapshot == null) {
    try {
      snapshot = computeCursorLagSnapshot({ now });
    } catch (err) {
      try {
        process.stderr.write(
          "watermark: cursor-lag snapshot failed: " +
            (err && err.message ? err.message : String(err)) + "\n",
        );
      } catch {}
      return;
    }
  }
  let tel = injectedTel || null;
  if (tel == null) {
    try {
      tel = await import("../mcp/lib/ingest/stage0/telemetry.js");
    } catch {
      // Telemetry import failure must not crash the alarm path. The stderr
      // line below is still emitted so the operator sees the warning.
    }
  }
  for (const entry of snapshot) {
    if (!entry.warned) continue;
    const hours =
      typeof entry.lag_ms === "number"
        ? Math.round(entry.lag_ms / 3600000)
        : "unknown";
    try {
      process.stderr.write(
        "watermark: cursor_lag_warn source=" + entry.source +
          " lag_h=" + hours +
          " cursor_ts=" + (entry.cursor_ts || "null") +
          " tail_ts=" + (entry.tail_ts || "null") + "\n",
      );
    } catch {
      // ignore
    }
    if (tel && typeof tel.recordDrop === "function") {
      try {
        // F-NEW-W7-CURSOR-LAG-DOCSTRING-DRIFT: counter is per-source
        // (entry.source), NOT the literal "watermark" string. Each lagging
        // source bumps its own counter row in the rotated JSONL sink.
        tel.recordDrop(entry.source, "cursor_lag_warn", "WARN");
      } catch {
        // Telemetry never crashes the alarm path.
      }
    }
  }
}

let __cursorLagTickCounter = 0;
export function maybeRunCursorLagCheck({ now } = {}) {
  __cursorLagTickCounter += 1;
  if (__cursorLagTickCounter < CURSOR_LAG_CHECK_EVERY_N_TICKS) return false;
  __cursorLagTickCounter = 0;
  // Fire-and-forget; emitCursorLagAlarms swallows its own errors.
  emitCursorLagAlarms({ now }).catch(() => {});
  return true;
}

// Test-only: reset the cursor-lag tick counter so hermetic tests can
// drive maybeRunCursorLagCheck across a known number of ticks without
// inheriting state from prior cases.
export function _resetCursorLagTickCounterForTest() {
  __cursorLagTickCounter = 0;
}

// ---------------------------------------------------------------------------
// WU-RR1 — BM25 rebuild trigger. Tick-counter cadence (every
// BM25_REBUILD_CHECK_EVERY_N_TICKS ticks). The wrapped call is fully
// defensive: maybeRunBm25Rebuild never throws and the surrounding
// try/catch is belt-and-braces.
// ---------------------------------------------------------------------------
let __bm25RebuildTickCounter = 0;
export function maybeRunBm25RebuildCheck() {
  __bm25RebuildTickCounter += 1;
  if (__bm25RebuildTickCounter < BM25_REBUILD_CHECK_EVERY_N_TICKS) return false;
  __bm25RebuildTickCounter = 0;
  try {
    const res = __maybeRunBm25Rebuild();
    if (res && res.action === "rebuilt") {
      try {
        appendPolicyEvent({
          kind: "policy.bm25_index_rebuild",
          delta: res.delta,
          threshold: res.threshold,
          current_fact_count: res.current_fact_count,
          last_rebuild_fact_count: res.last_rebuild_fact_count,
          bytes_written: res.result && res.result.bytes_written,
          duration_ms: res.result && res.result.duration_ms,
          model_version: res.result && res.result.model_version,
          ts: nowIso(),
        });
      } catch {
        // Telemetry failure must not crash the tick.
      }
    } else if (res && res.action === "rebuild_failed") {
      // Operator-visible breadcrumb on failure. The OLD index is intact.
      try {
        process.stderr.write(
          "watermark: bm25 rebuild failed: " + (res.error || "<unknown>") + "\n",
        );
      } catch {
        // ignore
      }
    }
  } catch (err) {
    try {
      process.stderr.write(
        "watermark: maybeRunBm25RebuildCheck failed: " +
          (err && err.message ? err.message : String(err)) +
          "\n",
      );
    } catch {
      // ignore
    }
  }
  return true;
}

// Test-only: reset the BM25 rebuild tick counter for hermetic tests.
export function _resetBm25RebuildTickCounterForTest() {
  __bm25RebuildTickCounter = 0;
}

// ---------------------------------------------------------------------------
// W10 — Engagement-queue drain & classification, called once per cascade
// tick from the main idle loop (and once from the --once CLI path so the
// hermetic e2e harness exercises the same code path the long-lived daemon
// does).
//
// Contract:
//   - Drain the queue (atomic rename-to-tmp internal to drainEngagementQueue;
//     see the W10 spawn-finding closure on engagement-detector.js).
//   - For each {signal, results} tuple processEngagementQueue yields:
//       - Compute turn_window_id + conversation_id_hash from signal.
//       - For each classified row, call damping-log.appendEngagement.
//   - Defensive: every cross-module call is wrapped in try/catch with a
//     one-line stderr breadcrumb on error. A single bad row never poisons
//     the rest of the tick. Engagement signals are statistical, not
//     load-bearing — a failed append is a quality regression, not a
//     correctness one.
//
// The export is async so callers can await it in tests; in the production
// tick path the result is fire-and-forgotten via .catch().
// ---------------------------------------------------------------------------
export async function runEngagementQueueDrain() {
  let processed;
  try {
    processed = __processEngagementQueue();
  } catch (err) {
    try {
      process.stderr.write(
        "watermark: engagement-queue drain failed: " +
          (err && err.message ? err.message : String(err)) +
          "\n",
      );
    } catch {
      // ignore — logger failure must not crash the tick.
    }
    return { signals: 0, engagement_rows: 0, errors: 1 };
  }
  let engagementRows = 0;
  let errors = 0;
  // CAPS.RECALL_K_TURN_WINDOW is the canonical K-turn window size used to
  // bucket per-(memory_id, window) signals. damping-log's
  // computeTurnWindowId expects a base_turn_index already floored by this
  // size — we floor here, in the caller, exactly per the spec contract.
  let windowSize = 3;
  try {
    windowSize = Number.isInteger(CAPS.RECALL_K_TURN_WINDOW)
      ? CAPS.RECALL_K_TURN_WINDOW
      : 3;
  } catch {
    windowSize = 3;
  }
  for (const tuple of Array.isArray(processed) ? processed : []) {
    const signal = tuple && tuple.signal ? tuple.signal : null;
    const results = tuple && Array.isArray(tuple.results) ? tuple.results : [];
    if (!signal || typeof signal !== "object") continue;
    const conversationId =
      typeof signal.conversation_id === "string" ? signal.conversation_id : null;
    const priorRecallId =
      typeof signal.prior_recall_id === "string" ? signal.prior_recall_id : null;
    const turnIndex = Number.isInteger(signal.turn_index)
      ? signal.turn_index
      : null;
    if (
      conversationId === null ||
      priorRecallId === null ||
      turnIndex === null
    ) {
      // Cannot construct a canonical damping-log envelope without all three.
      // Skip silently — the hook's malformed enqueue is a hook bug, not a
      // daemon bug, and the next valid enqueue should still be processed.
      continue;
    }
    let turnWindowId;
    let conversationIdHash;
    try {
      turnWindowId = __computeTurnWindowId({
        conversation_id: conversationId,
        base_turn_index: Math.floor(turnIndex / windowSize),
        window_size: windowSize,
      });
      conversationIdHash = __computeConversationIdHash(conversationId);
    } catch (err) {
      errors += 1;
      try {
        process.stderr.write(
          "watermark: engagement turn_window_id build failed: " +
            (err && err.message ? err.message : String(err)) +
            "\n",
        );
      } catch {
        // ignore
      }
      continue;
    }
    for (const row of results) {
      if (row == null || typeof row !== "object") continue;
      try {
        await __appendEngagement({
          memory_id: row.memory_id,
          turn_window_id: turnWindowId,
          recall_id: priorRecallId,
          conversation_id_hash: conversationIdHash,
          engagement_class: row.engagement_class,
          engagement_weight: row.engagement_weight,
          evidence_span_hash:
            typeof row.evidence_span_hash === "string"
              ? row.evidence_span_hash
              : "",
          detector_version: row.detector_version,
        });
        engagementRows += 1;
      } catch (err) {
        errors += 1;
        try {
          process.stderr.write(
            "watermark: damping-log.appendEngagement failed: " +
              (err && err.message ? err.message : String(err)) +
              "\n",
          );
        } catch {
          // ignore
        }
      }
    }
  }
  return {
    signals: Array.isArray(processed) ? processed.length : 0,
    engagement_rows: engagementRows,
    errors,
  };
}

// ---------------------------------------------------------------------------
// F-WM-AGG-BUCKET-LOGGER (Jul 2026). The aggregator modules
// (mcp/lib/synthesis/thread-aggregator.js ~475, project-aggregator.js ~540)
// route per-bucket emit failures through emitterCtx.logger.error(msg) and
// DEFAULT the logger to {error: () => {}} when none is supplied. The
// runners below used to call them with no emitterCtx at all, so every
// per-bucket reject code (INVALID_PARENTS, validator blocks, emit throws)
// vanished into the no-op — the counts envelope said errors:N with zero
// clue as to WHY. Build a per-tick stderr logger instead.
//
// Rate limiting: one aggregation pass over a degraded ledger can reject
// hundreds of buckets with the SAME code. The aggregators' message format
// ends with ": <code>" (".. rejected bucket <key>: <code>" / ".. threw for
// bucket <key>: <msg>"), so dedupe on the substring after the last ": " —
// each DISTINCT code logs once per tick (the logger instance is created
// fresh per runner call, i.e. per tick).
// ---------------------------------------------------------------------------
function makeAggregationBucketLogger(runnerName) {
  const seenCodes = new Set();
  return {
    error(message) {
      try {
        const msg = typeof message === "string" ? message : String(message);
        const sep = msg.lastIndexOf(": ");
        const code = sep >= 0 ? msg.slice(sep + 2) : msg;
        if (seenCodes.has(code)) return;
        seenCodes.add(code);
        process.stderr.write(
          "watermark: " + runnerName + " bucket failure: " + msg + "\n",
        );
      } catch {
        // logger failures must never propagate into the aggregator
      }
    },
  };
}

// ---------------------------------------------------------------------------
// D1 (WIRE) — persist an aggregator's advanced byte-OFFSET checkpoint ATOMICALLY
// via the CKPT primitive (design.md §D-1.3). Called by the INCREMENTAL runner
// branch ONLY, and ONLY after a clean emit (res.errors===0, no throw) —
// emit-before-persist (design.md §D-3.4): a crash between the aggregator's emit
// and this persist re-reads those bytes on the next run and re-emits, collapsed
// by S5 idempotency; NEVER advance the offset on error/throw.
//
// The ledger statSync supplies the {ino, ledger_size} fingerprint CKPT's
// cold-start self-heal keys on (design.md §D-1.4 (a) offset>size, (b)
// inode-change). A stat failure degrades gracefully — the bare offset is
// persisted (readCheckpoint re-stats the ledger at read time, so the offset>size
// guard still fires). writeCheckpoint is defensive (returns false, never
// throws); the extra try/catch is belt-and-braces so a checkpoint-persist
// failure can never crash the tick.
function persistAggregatorCheckpoint({
  checkpointPath,
  ledgerPath,
  aggregator,
  offset,
  now,
}) {
  let ino;
  let ledgerSize;
  try {
    const st = statSync(ledgerPath);
    ino = st.ino;
    ledgerSize = st.size;
  } catch {
    // No fingerprint available — persist the bare offset (still self-heals on
    // offset>size at read time; the inode-change guard is simply skipped).
  }
  try {
    writeCheckpoint(checkpointPath, offset, { aggregator, ino, ledgerSize, now });
  } catch {
    // A checkpoint-persist failure must never crash the tick — the next run
    // re-reads the same bytes and re-emits, collapsed by S5 idempotency.
  }
}

// ---------------------------------------------------------------------------
// W12 — Thread-aggregation runner. Called once per cascade tick from the main
// idle loop (and once from the --once CLI path so the hermetic e2e harness
// exercises the same code path the long-lived daemon does).
//
// Defensive: aggregateThreads catches its own errors and returns a counts
// envelope; the outer try/catch here is belt-and-braces against a future
// regression that throws synchronously before the promise is constructed.
//
// Cadence: once per cascade tick (TICK_INTERVAL_MS = 15s production). The
// lookback window is 24h — re-runs over the same ledger collapse on the S5
// idempotency key (no duplicate reconstructed rows).
// ---------------------------------------------------------------------------
export async function runThreadAggregation({ now } = {}) {
  try {
    // F-WM-AGG-BUCKET-LOGGER: surface per-bucket reject codes to stderr (deduped
    // per distinct code per tick) instead of the aggregator's default no-op
    // logger. Shared by both branches so the emitterCtx is identical either way.
    const emitterCtx = {
      logger: makeAggregationBucketLogger("runThreadAggregation"),
    };
    let res;
    if (CAPS.INCREMENTAL_AGGREGATION_ENABLED) {
      // INCREMENTAL (design.md §D-3): the aggregator reads only [checkpoint, EOF)
      // on warm ticks (cold start pays a one-time bounded window-rescan), folds
      // into the 24h windowed state, emits via the PIDX-backed emitter, and
      // returns the advanced checkpoint_offset. The checkpointPath WIRE passes is
      // the SAME file the aggregator reads at cold start → read-path == write-path.
      const checkpointPath = aggregatorCheckpointPath("thread");
      res = await __aggregateThreads({
        ledgerPath: memoryLedgerPath(),
        sinceMs: __THREAD_AGGREGATOR_CAPS.TIME_WINDOW_MS,
        now,
        emitterCtx,
        checkpointPath,
      });
      // Emit-before-persist, clean-run-only (design.md §D-3.4). NEVER advance the
      // offset on errors!==0 / throw — the next run re-reads those bytes and
      // re-emits, collapsed by S5.
      if (res && res.errors === 0 && typeof res.checkpoint_offset === "number") {
        persistAggregatorCheckpoint({
          checkpointPath,
          ledgerPath: memoryLedgerPath(),
          aggregator: "thread",
          offset: res.checkpoint_offset,
          now,
        });
      }
    } else {
      // FULL-RESCAN — byte-for-byte the pre-incremental call (flag default OFF).
      res = await __aggregateThreads({
        ledgerPath: memoryLedgerPath(),
        sinceMs: __THREAD_AGGREGATOR_CAPS.TIME_WINDOW_MS,
        now,
        emitterCtx,
      });
    }
    return res || { threads_processed: 0, reconstructed_emitted: 0, errors: 0 };
  } catch (err) {
    try {
      process.stderr.write(
        "watermark: runThreadAggregation failed: " +
          (err && err.message ? err.message : String(err)) +
          "\n",
      );
    } catch {
      // logger failure must not crash the tick
    }
    return { threads_processed: 0, reconstructed_emitted: 0, errors: 1 };
  }
}

// WU2-inline-embed-and-remove-gemini-quota-machinery removed
// runEmbedBackfillDrain + its tick/once wiring. The async embed-backfill
// worker + its queue were deleted; the cascade embeds inline via the local
// server. The only residual async path is the simple re-embed sweep file
// (appendReEmbedSweep), which is consumed out-of-band, not on the tick.

// ---------------------------------------------------------------------------
// W13 — Project-aggregation runner. Called once per cascade tick AFTER the
// thread aggregator (matching execution-order discipline: thread-grain first,
// project-grain second). Both are idempotent on S5; ordering only affects
// the ledger row-interleave, not correctness.
//
// Defensive: aggregateProjects catches its own errors and returns a counts
// envelope; the outer try/catch here is belt-and-braces against a future
// regression that throws synchronously before the promise is constructed.
//
// Cadence: once per cascade tick (TICK_INTERVAL_MS = 15s production). The
// lookback window is 7d — re-runs over the same ledger collapse on the S5
// idempotency key (no duplicate reconstructed rows).
// ---------------------------------------------------------------------------
export async function runProjectAggregation({ now } = {}) {
  try {
    // F-WM-AGG-BUCKET-LOGGER: surface per-bucket reject codes to stderr (deduped
    // per distinct code per tick) instead of the aggregator's default no-op
    // logger. Shared by both branches so the emitterCtx is identical either way.
    const emitterCtx = {
      logger: makeAggregationBucketLogger("runProjectAggregation"),
    };
    let res;
    if (CAPS.INCREMENTAL_AGGREGATION_ENABLED) {
      // INCREMENTAL (design.md §D-3): the aggregator reads only [checkpoint, EOF)
      // on warm ticks (cold start pays a one-time bounded window-rescan), folds
      // into the 7d windowed state, emits via the PIDX-backed emitter, and
      // returns the advanced checkpoint_offset. The checkpointPath WIRE passes is
      // the SAME file the aggregator reads at cold start → read-path == write-path.
      const checkpointPath = aggregatorCheckpointPath("project");
      res = await __aggregateProjects({
        ledgerPath: memoryLedgerPath(),
        sinceMs: __PROJECT_AGGREGATOR_CAPS.TIME_WINDOW_MS,
        now,
        emitterCtx,
        checkpointPath,
      });
      // Emit-before-persist, clean-run-only (design.md §D-3.4). NEVER advance the
      // offset on errors!==0 / throw — the next run re-reads those bytes and
      // re-emits, collapsed by S5.
      if (res && res.errors === 0 && typeof res.checkpoint_offset === "number") {
        persistAggregatorCheckpoint({
          checkpointPath,
          ledgerPath: memoryLedgerPath(),
          aggregator: "project",
          offset: res.checkpoint_offset,
          now,
        });
      }
    } else {
      // FULL-RESCAN — byte-for-byte the pre-incremental call (flag default OFF).
      res = await __aggregateProjects({
        ledgerPath: memoryLedgerPath(),
        sinceMs: __PROJECT_AGGREGATOR_CAPS.TIME_WINDOW_MS,
        now,
        emitterCtx,
      });
    }
    return (
      res || { projects_processed: 0, reconstructed_emitted: 0, errors: 0 }
    );
  } catch (err) {
    try {
      process.stderr.write(
        "watermark: runProjectAggregation failed: " +
          (err && err.message ? err.message : String(err)) +
          "\n",
      );
    } catch {
      // logger failure must not crash the tick
    }
    return { projects_processed: 0, reconstructed_emitted: 0, errors: 1 };
  }
}

// ---------------------------------------------------------------------------
// W12/W13 — thread + project aggregation THROTTLE + RE-ENTRANCY GUARD.
//
// DEFECT (2026-07-06 production stall). runThreadAggregation /
// runProjectAggregation were invoked EVERY tick (~15s), fire-and-forget
// (un-awaited .then/.catch). Each call streams and JSON.parses the ENTIRE
// ~1.9GB / ~1.5M-row ledgers/memory.jsonl to filter to its time window
// (thread=24h, project=7d); the ledger is NOT time-indexed, so even a windowed
// aggregation reads the whole file. Because the calls were un-awaited and each
// now takes MINUTES, successive ticks launched NEW full-ledger scans while
// prior ones were still running — many concurrent multi-GB stream+parse passes
// piled up. Process sampling showed 5.9GB RSS against the 8GB
// --max-old-space-size ceiling, live CPU dominated by V8 JsonParser
// (ScanJsonString/ParseJsonObject) + Scavenger GC, the git-log cursor frozen
// (event loop blocked), and concurrent embed HTTP calls hitting their 60s
// client timeout ("local embed server unavailable").
//
// The OLD tick-body comment claimed the 15s cadence was "a no-op ... via S5
// idempotency" — that is WRONG: S5 idempotency collapses duplicate EMITS, not
// the full-ledger SCAN, which happens every time regardless.
//
// FIX — two parts, both required:
//   PART A — THROTTLE: fire aggregation only once per
//     AGGREGATION_CHECK_EVERY_N_TICKS ticks. Mirrors the maybeRunCursorLagCheck
//     / maybeRunBm25RebuildCheck tick-counter idiom (increment; if < threshold
//     return; reset; fire).
//   PART B — RE-ENTRANCY GUARD: a module-level in-flight flag per aggregator.
//     One full-ledger scan can easily exceed N ticks over a 1.9GB ledger, so
//     the throttle ALONE cannot prevent overlap. If a prior run is still
//     pending when the cadence next fires, SKIP this cycle. The flag is set
//     before the launch and cleared in .finally() — so a resolve, a reject, OR
//     a synchronous throw all clear it and it can NEVER wedge permanently (a
//     wedged guard would silently disable aggregation forever). This guarantees
//     AT MOST ONE full-ledger aggregation scan of each kind runs at a time,
//     regardless of cadence or ledger size — the direct fix for the pileup.
//
// When aggregation DOES fire, behavior is byte-for-byte what the un-throttled
// tick body did: same runThreadAggregation/runProjectAggregation({now:undefined})
// call, same .then(logReconstructionCounts) FIX-3 (N7b) surfacing, same
// defensive .catch stderr breadcrumb, same S5 idempotency. Only HOW OFTEN and
// WHETHER-OVERLAPPING they fire changed.
//
// NOTE: the --once CLI path does NOT go through these helpers — it awaits the
// raw runThreadAggregation/runProjectAggregation directly, so the throttle
// counter and in-flight guard never suppress the one-shot run.
// ---------------------------------------------------------------------------

// Test-only override for the aggregation runners. Default null → production
// path (the real runThreadAggregation / runProjectAggregation that stream the
// full ledger). Hermetic tests inject deferred-promise stubs so the throttle
// cadence AND the re-entrancy guard can be exercised without a real 1.9GB
// ledger. Mirrors the _setCascadeModsForTest idiom. NEVER set in production.
let __aggregationRunnersOverrideForTest = null;
export function _setAggregationRunnersForTest(runners) {
  __aggregationRunnersOverrideForTest = runners;
}
function resolveThreadAggRunner() {
  if (
    __aggregationRunnersOverrideForTest &&
    typeof __aggregationRunnersOverrideForTest.thread === "function"
  ) {
    return __aggregationRunnersOverrideForTest.thread;
  }
  return runThreadAggregation;
}
function resolveProjectAggRunner() {
  if (
    __aggregationRunnersOverrideForTest &&
    typeof __aggregationRunnersOverrideForTest.project === "function"
  ) {
    return __aggregationRunnersOverrideForTest.project;
  }
  return runProjectAggregation;
}

let __threadAggTickCounter = 0;
let __threadAggInFlight = false;
export function maybeRunThreadAggregation({ now } = {}) {
  // PART 0 — synthesis pause. During a bulk backlog drain the aggregators
  // re-scan the full 1.9GB ledger every cadence cycle and emit NOTHING
  // (processed=101 emitted=0 — every bucket is an idempotent re-fire), while
  // spiking RSS multi-GB and dominating tick wall-clock so the source cascade
  // crawls. MEMORY_WATERMARK_PAUSE_SYNTHESIS=1 suspends both aggregators so the
  // cascade can sprint; clear it (and reload) to restore synthesis once the
  // drain completes. The counter is NOT advanced while paused so cadence
  // resumes cleanly. Observed 2026-07-06.
  if (process.env.MEMORY_WATERMARK_PAUSE_SYNTHESIS === "1") return false;
  // PART A — throttle. Increment/threshold/reset mirrors maybeRunCursorLagCheck.
  __threadAggTickCounter += 1;
  if (__threadAggTickCounter < AGGREGATION_CHECK_EVERY_N_TICKS) return false;
  __threadAggTickCounter = 0;
  // PART B — re-entrancy guard. A run started on a prior cadence cycle can still
  // be streaming the 1.9GB ledger; launching a second overlapping scan is the
  // exact concurrent-scan pileup that drove RSS to 5.9GB / GC thrash / event-
  // loop starvation on 2026-07-06. Skip this cycle instead.
  if (__threadAggInFlight) {
    try {
      process.stderr.write(
        "watermark: runThreadAggregation still in flight, skipping this cycle\n",
      );
    } catch {
      // ignore — the skip breadcrumb is observability-only
    }
    return false;
  }
  __threadAggInFlight = true;
  let launched;
  try {
    // Invoke synchronously — matches the original tick body's semantics (an
    // async fn returns its promise immediately) so the launch is observable on
    // the same turn.
    launched = resolveThreadAggRunner()({ now });
  } catch (err) {
    // runThreadAggregation is async and cannot throw synchronously, but a
    // future refactor / injected test stub could. A synchronous throw must
    // clear the guard so it can NEVER wedge permanently (a wedged guard would
    // silently disable aggregation forever — worse than the pileup it prevents).
    __threadAggInFlight = false;
    try {
      process.stderr.write(
        "watermark: runThreadAggregation threw synchronously: " +
          (err && err.message ? err.message : String(err)) +
          "\n",
      );
    } catch {
      // ignore
    }
    return true;
  }
  Promise.resolve(launched)
    .then((counts) => {
      // Preserve the FIX-3 (N7b) zero-emit observability surfacing exactly as
      // the un-throttled tick body did.
      logReconstructionCounts("runThreadAggregation", counts);
    })
    .catch((err) => {
      try {
        process.stderr.write(
          "watermark: runThreadAggregation rejected: " +
            (err && err.message ? err.message : String(err)) +
            "\n",
        );
      } catch {
        // ignore
      }
    })
    .finally(() => {
      // Clear on BOTH resolve and reject — a rejection must never wedge the
      // guard. This is the whole point of PART B.
      __threadAggInFlight = false;
    });
  return true;
}

let __projectAggTickCounter = 0;
let __projectAggInFlight = false;
export function maybeRunProjectAggregation({ now } = {}) {
  // PART 0 — synthesis pause. See maybeRunThreadAggregation: the
  // MEMORY_WATERMARK_PAUSE_SYNTHESIS=1 escape hatch suspends aggregation during
  // a bulk drain so the cascade is not starved by zero-emit full-ledger scans.
  if (process.env.MEMORY_WATERMARK_PAUSE_SYNTHESIS === "1") return false;
  // PART A — throttle. Same tick-counter idiom as the thread aggregator.
  __projectAggTickCounter += 1;
  if (__projectAggTickCounter < AGGREGATION_CHECK_EVERY_N_TICKS) return false;
  __projectAggTickCounter = 0;
  // PART B — re-entrancy guard. See maybeRunThreadAggregation. A pending 7d
  // project scan over the 1.9GB ledger must not be overlapped by a second one.
  if (__projectAggInFlight) {
    try {
      process.stderr.write(
        "watermark: runProjectAggregation still in flight, skipping this cycle\n",
      );
    } catch {
      // ignore — the skip breadcrumb is observability-only
    }
    return false;
  }
  __projectAggInFlight = true;
  let launched;
  try {
    launched = resolveProjectAggRunner()({ now });
  } catch (err) {
    // Synchronous throw clears the guard so it can never wedge permanently.
    __projectAggInFlight = false;
    try {
      process.stderr.write(
        "watermark: runProjectAggregation threw synchronously: " +
          (err && err.message ? err.message : String(err)) +
          "\n",
      );
    } catch {
      // ignore
    }
    return true;
  }
  Promise.resolve(launched)
    .then((counts) => {
      logReconstructionCounts("runProjectAggregation", counts);
    })
    .catch((err) => {
      try {
        process.stderr.write(
          "watermark: runProjectAggregation rejected: " +
            (err && err.message ? err.message : String(err)) +
            "\n",
        );
      } catch {
        // ignore
      }
    })
    .finally(() => {
      __projectAggInFlight = false;
    });
  return true;
}

// Test-only: reset BOTH aggregation throttle counters + in-flight guards so
// hermetic tests can drive the cadence/guard from a known state without
// inheriting counter state from a prior case. Mirrors the
// _resetCursorLagTickCounterForTest / _resetBm25RebuildTickCounterForTest seams
// (one seam covers the pair introduced together).
export function _resetAggregationStateForTest() {
  __threadAggTickCounter = 0;
  __threadAggInFlight = false;
  __projectAggTickCounter = 0;
  __projectAggInFlight = false;
}

// ---------------------------------------------------------------------------
// R32.1 removal block. The conversational batch construction + enqueue,
// in_flight reconciliation, terminal-failure walk, overlap detection,
// tickOnce, rebuildStateFromLedgers, and stateForPersistence were retired
// here. The cascade tier (tickSourcesOnce + per-source cursors) is the
// sole watermark path; see kb/legacy-archive.md for the historical schema.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main loop. setInterval-driven; one tick per second, heartbeat every 5s.
// R32.1: the tick body is now tickSourcesOnce only — the per-conversation
// state read/write/rebuild path was retired with tickOnce. The lock file
// remains the daemon-process serialization primitive.
// ---------------------------------------------------------------------------

let __tickHandle = null;
let __heartbeatHandle = null;
let __shutdownRequested = false;

// ---------------------------------------------------------------------------
// W3 — tick reentrancy guard. The 15s setInterval used to fire
// tickSourcesOnce fire-and-forget with NO in-flight guard, so a slow sweep
// overlapped the next tick and the same cursor range was re-scanned and
// re-decided concurrently — 3.82 terminal decisions/row measured across
// July's 1.06M mail drop events (a prior overlap incident is acknowledged
// in the W12 comment below). runGuardedTick suppresses a tick while one is
// still in flight; the flag is cleared in .finally() so a throwing/rejecting
// tick can never wedge the daemon. ADDITIVE ONLY: the tick body itself is
// unrestructured — sub-runner launches keep their fire-and-forget semantics
// and their own guards/cadence counters (__threadAggInFlight,
// __projectAggInFlight, the *_EVERY_N_TICKS counters).
// ---------------------------------------------------------------------------
let __tickInFlight = false;

// Test-only injectable tick body. Mirrors the _setCascadeModsForTest idiom:
// hermetic tests inject a controllable promise so the guard is unit-testable
// without spawning the daemon. NEVER set in production code; only test files.
let __tickBodyOverrideForTest = null;
export function _setTickBodyForTest(fn) {
  __tickBodyOverrideForTest = fn;
}
export function _resetTickGuardForTest() {
  __tickInFlight = false;
  __tickBodyOverrideForTest = null;
}

// The former setInterval callback body, verbatim (minus the
// __shutdownRequested check, which stays loop-lifecycle in mainLoopStart).
// tickSourcesOnce is the awaited spine: the in-flight flag stays set until
// the cascade sweep settles. Launch order is unchanged from the pre-W3
// callback — the sub-runners fire after the sweep is LAUNCHED, not after it
// settles, exactly as before.
async function runTickBody({ now } = {}) {
  // R32.1: tickOnce + writeStateAtomic conversational-state branch removed;
  // tickSourcesOnce is now the sole tick body. Errors surface as cursor
  // error_count bumps within the cascade; the outer promise never rejects.
  const spine = tickSourcesOnce({ now }).catch((err) => {
    try {
      process.stderr.write(
        "watermark: tickSourcesOnce failed: " +
          (err && err.message ? err.message : String(err)) + "\n",
      );
    } catch {
      // ignore
    }
  });
  // F-NEW-W7-CURSOR-LAG-ALARM. Periodic check (every
  // CURSOR_LAG_CHECK_EVERY_N_TICKS ticks) for stuck cursors. The check
  // is fire-and-forget — emitCursorLagAlarms swallows its own errors,
  // so a stat / parse failure never poisons the tick loop.
  try {
    maybeRunCursorLagCheck({ now });
  } catch {
    // ignore — the check is observability-only
  }
  // W10 — engagement-queue drain (F-SYN-INTEGRATION-ENGAGEMENT-
  // DETECTOR-WIRING BLOCKER closure). Runs every tick (~15s). Fully
  // defensive — runEngagementQueueDrain catches its own errors and
  // returns a counts envelope; the .catch() here is belt-and-braces
  // against a future regression that throws synchronously before the
  // promise is constructed.
  runEngagementQueueDrain().catch((err) => {
    try {
      process.stderr.write(
        "watermark: runEngagementQueueDrain rejected: " +
          (err && err.message ? err.message : String(err)) +
          "\n",
      );
    } catch {
      // ignore
    }
  });
  // WU2 removed the embed-backfill drain from the tick loop (the cascade
  // embeds inline via the local server; the async worker + queue are gone).
  // W12 — thread-aggregation runner (F-SYN-BEHAVIOR-thread-aggregation).
  // THROTTLED + RE-ENTRANCY-GUARDED via maybeRunThreadAggregation. Was
  // invoked EVERY tick fire-and-forget; the old comment's claim that S5
  // idempotency made that "a no-op" was WRONG — idempotency collapses EMITS,
  // not the full-ledger SCAN, so every tick re-scanned the entire ~1.9GB
  // ledger and un-awaited overlapping scans piled up to 5.9GB RSS / GC thrash
  // (2026-07-06). Now fires at most once per AGGREGATION_CHECK_EVERY_N_TICKS
  // ticks AND never overlaps a prior run. The helper preserves the original
  // .then(logReconstructionCounts)/.catch(stderr) behavior for the tick where
  // it DOES fire. The outer try/catch is belt-and-braces; the helper is
  // internally defensive.
  try {
    maybeRunThreadAggregation({ now });
  } catch {
    // already defensive inside; belt-and-braces
  }
  // W13 — project-aggregation runner (F-SYN-BEHAVIOR-project-aggregation).
  // Same throttle + re-entrancy guard as W12 (see maybeRunProjectAggregation).
  // Runs AFTER the thread aggregator, preserving the thread-grain-first /
  // project-grain-second ordering discipline.
  try {
    maybeRunProjectAggregation({ now });
  } catch {
    // already defensive inside; belt-and-braces
  }
  // WU-RR1 — BM25 full-rebuild trigger. Tick-counter throttled (every
  // BM25_REBUILD_CHECK_EVERY_N_TICKS ticks). The check is cheap when
  // the ledger has not grown since the last rebuild; when it has grown it
  // costs O(witness + appended delta) via the growth-check sidecar (W2
  // memperf), not a full ledger stream — a full recount only on prefix-
  // drift/rotation/shrink. maybeRunBm25RebuildCheck catches its own
  // errors and never throws.
  try {
    maybeRunBm25RebuildCheck();
  } catch {
    // already defensive inside; this is belt-and-braces
  }
  await spine;
}

// runGuardedTick({ now } = {}) -> { ran: false } when a prior tick is still
// in flight (one stderr line, no work), or { ran: true, done } where `done`
// settles (never rejects) when the tick body has fully settled and the flag
// has been cleared. Exported for the daemon loop AND for hermetic tests.
function runGuardedTick({ now } = {}) {
  if (__tickInFlight) {
    try {
      process.stderr.write("watermark: tick overlap suppressed\n");
    } catch {
      // ignore
    }
    return { ran: false };
  }
  __tickInFlight = true;
  const body =
    __tickBodyOverrideForTest != null ? __tickBodyOverrideForTest : runTickBody;
  let settled;
  try {
    settled = Promise.resolve(body({ now }));
  } catch (err) {
    // A synchronously-throwing body must still clear the flag below.
    settled = Promise.reject(err);
  }
  const done = settled
    .catch((err) => {
      try {
        process.stderr.write(
          "watermark: guarded tick failed: " +
            (err && err.message ? err.message : String(err)) + "\n",
        );
      } catch {
        // ignore
      }
    })
    .finally(() => {
      __tickInFlight = false;
    });
  return { ran: true, done };
}

function mainLoopStart() {
  ensureDirs();
  const acq = acquireLock();
  if (!acq.acquired) {
    process.stderr.write("watermark: another daemon holds the lock; exiting\n");
    process.exit(1);
  }
  // Wave 9 — one-line stderr breadcrumb listing captured-only sources, so
  // an operator inspecting daemon logs sees which sources the cascade is
  // deliberately bypassing this run. Empty list (the deactivation mode)
  // logs an empty list, which is itself a useful signal.
  try {
    const capturedOnly = Array.isArray(CAPS.WATERMARK_CAPTURED_ONLY_SOURCES)
      ? Array.from(CAPS.WATERMARK_CAPTURED_ONLY_SOURCES)
      : [];
    process.stderr.write(
      "watermark: captured_only sources (cascade-skipped): [" +
        capturedOnly.join(", ") +
        "]\n",
    );
  } catch {
    // best-effort breadcrumb
  }
  if (acq.reclaimed_prior_pid != null) {
    appendPolicyEvent({
      kind: "policy.daemon.lock_reclaimed",
      prior_pid: acq.reclaimed_prior_pid,
      prior_mtime: nowIso(),
      reclaimed_at: nowIso(),
    });
  }

  __tickHandle = setInterval(() => {
    if (__shutdownRequested) return;
    // W3 — the former inline body lives verbatim in runTickBody; the guard
    // suppresses this tick (one stderr line) while a prior one is in flight
    // instead of re-scanning + re-deciding the same cursor range.
    runGuardedTick({ now: undefined });
  }, TICK_INTERVAL_MS);

  __heartbeatHandle = setInterval(() => {
    const r = refreshHeartbeat();
    if (!r.still_ours) {
      // Another process reclaimed our lock. Exit gracefully.
      process.stderr.write("watermark: lock was reclaimed by another process; exiting\n");
      __shutdownRequested = true;
      if (__tickHandle) clearInterval(__tickHandle);
      if (__heartbeatHandle) clearInterval(__heartbeatHandle);
      process.exit(2);
    }
  }, HEARTBEAT_INTERVAL_MS);

  const shutdown = (signal) => {
    if (__tickHandle) clearInterval(__tickHandle);
    if (__heartbeatHandle) clearInterval(__heartbeatHandle);
    releaseLock();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// ---------------------------------------------------------------------------
// --once: hermetic e2e driver. Acquire the lock with full discipline, run
// ONE cascade tick, release the lock, exit. Errors map to non-zero so the
// e2e harness sees the failure surface.
// ---------------------------------------------------------------------------

async function runOnceCli() {
  ensureDirs();
  const acq = acquireLock();
  if (!acq.acquired) {
    process.stderr.write("watermark --once: another daemon holds the lock\n");
    return 1;
  }
  try {
    if (acq.reclaimed_prior_pid != null) {
      try {
        appendPolicyEvent({
          kind: "policy.daemon.lock_reclaimed",
          prior_pid: acq.reclaimed_prior_pid,
          prior_mtime: nowIso(),
          reclaimed_at: nowIso(),
        });
      } catch {
        // Non-fatal — operator-visible breadcrumb only.
      }
    }
    // R32.1: cascade-only tick body. The conversational state load /
    // rebuild / reconcile path was retired with tickOnce.
    try {
      await tickSourcesOnce({ now: undefined });
    } catch (err) {
      process.stderr.write(
        "watermark --once: tickSourcesOnce failed: " +
          (err && err.message ? err.message : String(err)) + "\n",
      );
    }
    // W10 — same engagement-queue drain the long-lived loop runs, so the
    // hermetic e2e harness (which spawns `watermark.js --once`) exercises
    // the identical wiring. await here because runOnceCli's caller
    // process-exits on return; we want the drain to complete first.
    try {
      await runEngagementQueueDrain();
    } catch (err) {
      process.stderr.write(
        "watermark --once: runEngagementQueueDrain failed: " +
          (err && err.message ? err.message : String(err)) + "\n",
      );
    }
    // WU2 removed the embed-backfill drain (--once parity preserved: there is
    // no async embed worker any more; the cascade embeds inline).
    // W12 — thread-aggregation runner (matches the long-lived loop wiring so
    // hermetic --once harnesses exercise the identical code path).
    try {
      const tCounts = await runThreadAggregation({ now: undefined });
      // FIX-3 (N7b) — same zero-emit breadcrumb on the --once path.
      logReconstructionCounts("runThreadAggregation", tCounts);
    } catch (err) {
      process.stderr.write(
        "watermark --once: runThreadAggregation failed: " +
          (err && err.message ? err.message : String(err)) + "\n",
      );
    }
    // W13 — project-aggregation runner (matches the long-lived loop wiring so
    // hermetic --once harnesses exercise the identical code path).
    try {
      const pCounts = await runProjectAggregation({ now: undefined });
      // FIX-3 (N7b) — same zero-emit breadcrumb on the --once path.
      logReconstructionCounts("runProjectAggregation", pCounts);
    } catch (err) {
      process.stderr.write(
        "watermark --once: runProjectAggregation failed: " +
          (err && err.message ? err.message : String(err)) + "\n",
      );
    }
    // WU-RR1 — BM25 rebuild trigger (matches the long-lived loop wiring).
    // The tick-counter throttle still applies; --once usually does NOT
    // cross the counter threshold on a single invocation, so this is
    // primarily belt-and-braces for hermetic test surfaces that drive
    // the counter directly via _resetBm25RebuildTickCounterForTest.
    try {
      maybeRunBm25RebuildCheck();
    } catch {
      // already defensive inside
    }
    return 0;
  } catch (err) {
    process.stderr.write("watermark --once: " + (err && err.stack ? err.stack : err && err.message ? err.message : String(err)) + "\n");
    return 1;
  } finally {
    releaseLock();
  }
}

// ---------------------------------------------------------------------------
// CLI shim. `--check` -> "ok"; `--once` -> single tick + exit; default runs
// the long-lived setInterval loop.
// ---------------------------------------------------------------------------

const __isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (__isMain) {
  if (process.argv[2] === "--check") {
    process.stdout.write("ok\n");
    process.exit(0);
  }
  if (process.argv[2] === "--once") {
    runOnceCli().then(
      (code) => process.exit(code),
      (err) => {
        process.stderr.write(
          "watermark --once: unhandled rejection: " +
            (err && err.stack ? err.stack : err && err.message ? err.message : String(err)) +
            "\n",
        );
        process.exit(1);
      },
    );
  } else {
    mainLoopStart();
  }
}

// Exports for tests / cascade introspection.
// R32.1: dropped 19 exports tied to the conversational-state branch
// (STATE_PATH, QUEUE_*_DIR, emptyState, readState, writeStateAtomic,
// readTurnsInRange, listChatLedgers, listBatchIdsInDir, enqueueBatchFile,
// buildBatchObject, splitTurns, reconcileInFlight, reconcileTerminalFailures,
// convKey, STATE_VERSION, DISTILLATION_IDLE_WATERMARK_SECONDS,
// DISTILLATION_BATCH_MAX_TURNS, POISON_THRESHOLD). Cascade-only set retained.
export {
  LOCK_PATH,
  SOURCES_DIR,
  WATERMARK_STATE_DIR,
  WATERMARK_CURSOR_VERSION,
  WATERMARK_SOURCE_ERROR_THRESHOLD,
  STALE_LOCK_RECOVERY_SECONDS,
  CURSOR_LAG_WARN_THRESHOLD_MS,
  CURSOR_LAG_LEDGER_GROWTH_WINDOW_MS,
  CURSOR_LAG_CHECK_EVERY_N_TICKS,
  AGGREGATION_CHECK_EVERY_N_TICKS,
  CURSOR_LAG_TAIL_READ_BUDGET,
  acquireLock,
  refreshHeartbeat,
  releaseLock,
  listSourceLedgers,
  isoOffsetMs,
  emptyCursor,
  readSourceCursor,
  writeSourceCursorAtomic,
  readSourceRowsInRange,
  loadRevokedSources,
  tickSourcesOnce,
  runGuardedTick,
};

// W10 — engagement-queue drain seam exported for the hermetic end-to-end
// test (test/synthesis/engagement-loop-end-to-end.test.mjs). The seam is
// already exported above via `export async function runEngagementQueueDrain`
// at its definition site; this comment is documentation only.

// W12 — thread-aggregation runner seam exported for the hermetic test in
// test/synthesis/thread-aggregator.test.mjs. The seam is already exported
// above via `export async function runThreadAggregation` at its definition
// site; this comment is documentation only.
