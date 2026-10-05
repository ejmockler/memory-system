// reembed-drain.mjs — R4 automatic drain of policy/re-embed-sweep.jsonl.
//
// The watermark cascade promotes facts with embedding=null when the local
// embed server (port 8359) is down, appending {fact_id, ts} rows — JSONL,
// one JSON object per line — to policy/re-embed-sweep.jsonl
// (appendReEmbedSweep in daemons/watermark.js). Nothing drained that file
// automatically; this scheduled drainer consumes it in bounded batches via a
// byte-offset cursor and hands the ids to the PROVEN repair script.
//
// REUSE OVER REBUILD: all embed/chunk/retry/non-finite-validation logic lives
// exclusively in mcp/scripts/reembed-local-4096.mjs. This file spawns that
// script with `--ids-file <tmp>` plus the two R7 THROTTLE flags that script
// already implements (`--batch-texts` / `--pause-ms`; see buildRepairChildArgs
// for the measured derivation and REEMBED_THROTTLE=0 for the kill switch) —
// and nothing else. It duplicates zero embedding code and never edits the
// script.
//
// NULL-MARKER: NOT-CLEARED — the drain writes vectors ONLY to the
// sidecar/index; the immutable fact row keeps its null-embed marker forever.
// The R5 hydrated-index-vector precedence fix LANDED at
// mcp/lib/recall/multi-feature-score.js:742-798: a hydrated index vector WINS
// over the row's null marker via the s_emb_full3072 !== 0 guard (the marker
// only forces the additive-only fallback when there is NO vector anywhere,
// i.e. s_emb_full3072 === 0; a nonzero cosine alongside the marker can only
// originate from an index-hydrated vector, so the scorer trusts it and
// reports embedding_source / had_embedding_at_recall telemetry accordingly).
//
// Consequence: the sidecar vector this drainer produces restores Layer-1
// dense kNN input AND is scored at Layer-2 on the next recall — no read-path
// change is pending. The drainer must still:
//   - NOT attempt marker-clearing: fact rows in ledgers/memory.jsonl are
//     immutable (thesis #1). No ledger append, no row mutation, ever.
//   - NOT rebuild the HNSW index. (Historical HNSW-RACE, R1: the backend
//     once saved hnsw.bin IN-PLACE, racing the live watermark writer. Post
//     memperf-S3 every writer publishes through publishGeneration under the
//     flush lease — tmp+rename members, checksummed manifest — so the RACE
//     rationale is obsolete. The `--build-hnsw` prohibition is KEPT as
//     serialization policy: multi-hour GPU rebuilds remain a deliberate,
//     serialized operator action, not a drain side effect.)
//   - NOT pass `--contextual` and to detect a CAPS.CONTEXTUAL_DENSE_ENABLED
//     retarget (reembed-local-4096.mjs:64-69): a child whose stderr says
//     "CONTEXTUAL dense:" wrote to the -contextual tree, not the baseline
//     indices/qwen3-embedding-8b-fp16/ tree — treated as FAILURE, cursor
//     not advanced.
//
// Cursor discipline: byte offset persisted at policy/re-embed-sweep.cursor
// as JSON {offset}, written atomically (tmp + O_EXCL|O_NOFOLLOW 0600 + fsync
// + rename + dir-fsync — the mcp/lib/connectors/index.js writeCursor idiom).
// The cursor advances ONLY after a repair that both returned success AND was
// PROVED by the parent's own measurement of the sidecar (R6; see the WORK
// PROOF block — measureBatchWork / classifyWorkProof). A child exit status is
// no longer sufficient, because a child can exit 0 having written nothing.
// (Plus deliberately skipped malformed bytes.) A stuck or replayed cursor is
// idempotent: the child's own loadDoneIds (reembed-local-4096.mjs:92-101)
// streams the sidecar and skips already-embedded ids, so re-running a failed
// batch is free.
// Self-heal: an offset beyond the current sweep size resets to 0 (the
// _agg-checkpoint idiom, mcp/lib/synthesis/_agg-checkpoint.js).
//
// The sweep file itself is opened READ-ONLY (createReadStream) — it stays
// append-only with daemons/watermark.js appendReEmbedSweep as its sole
// writer; drain progress lives exclusively in the external cursor file.
//
// Lock discipline: policy/reembed-drain.lock per the watermark.js:529-644
// idiom — O_CREAT|O_EXCL|O_NOFOLLOW 0600, JSON {pid, ts} body, fsync,
// nlink===1 check; stale-reclaim when the recorded pid is dead or the lock
// mtime is very old. Lock contention (a slow batch still running when
// launchd's StartInterval fires again) is a clean no-op: exit 0, no cursor
// read, no repair.
//
// Scheduling: com.user.memory-system.reembed-drain.plist. READ from the
// installed ~/Library/LaunchAgents copy in this node (not relayed): it is now
// LOADED and LIVE — StartInterval 900, RunAtLoad TRUE, KeepAlive false,
// ThrottleInterval 60, WorkingDirectory + MEMORY_ROOT = the checkout root,
// REEMBED_BATCH 1000, and ProgramArguments points at THIS working-tree file.
// So an edit here goes live, unreviewed, within 15 minutes: it must never throw
// on the hot path and must never do unbounded work on the common path.

import {
  closeSync,
  createReadStream,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  constants as fsConstants,
} from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path"; import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

// e2 LEDGER WORK-SET MODE (default OFF — see `workSetMode` in runDrain). The
// derivation, its refusals and its cursor all live in that module; nothing is
// re-implemented here. The import is a CYCLE (embed-work-set.js ->
// embed-population-census.js -> this file, for the single definition of the
// `${id}#${k}` rule) and is safe because every binding either module reads
// across the cycle is read inside a function body, never at module-evaluation
// time. Importing costs a 3-module parse and starts nothing.
import {
  deriveWorkSetBatch,
  readWorkSetCursor,
  readWorkSetExclusions,
  writeWorkSetCursor,
} from "../mcp/lib/recall/embed-work-set.js";

const REPO = process.env.MEMORY_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE_MODE = 0o600;
const LOCK_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
// Generous: a full batch (sidecar done-scan streams ~10GB + embed retries)
// can legitimately hold the lock for many minutes without a heartbeat. The
// primary reclaim signal is a dead pid; mtime age is the backstop.
const STALE_LOCK_SECONDS = Number(process.env.REEMBED_DRAIN_STALE_LOCK_SECONDS || 6 * 3600);
const HEALTH_TIMEOUT_MS = Number(process.env.REEMBED_HEALTH_TIMEOUT_MS || 10_000);
const EMBED_URL = process.env.LOCAL_EMBED_URL || "http://127.0.0.1:8359";

// Guard list, run by buildRepairChildArgs over the ASSEMBLED argv before the
// spawn (not merely documented — see the loop there). These flags are
// PROHIBITED as child args:
//   --build-hnsw  the historical HNSW-RACE is obsolete post memperf-S3
//                 publishGeneration — see the header above; the prohibition is
//                 KEPT as serialization policy so multi-hour GPU rebuilds stay
//                 a deliberate, serialized operator action.
//   --contextual  retargets the output tree away from the baseline
//                 indices/qwen3-embedding-8b-fp16/.
//   --slice       TWO independent grounds. (1) COMPLETENESS:
//                 reembed-local-4096.mjs's own header states the contract this
//                 drainer relies on — a flag-absent child drains its ENTIRE
//                 ids-file batch. A sliced child exits 0 half-drained; the R6
//                 work proof would now catch that as `repair-no-work` rather
//                 than strand ids silently, but a drain that refuses every run
//                 is still a wedge, so the flag stays prohibited.
//                 --batch-texts and --pause-ms are safe precisely because they
//                 NARROW batches without dropping items; --slice drops items.
//                 (2) At slice end the child calls
//                 sliceBoundaryHygiene, which kickstarts the embed server —
//                 the drain must never acquire the power to signal a live
//                 daemon by proxy.
// Comments and this guard are the only mentions in this file — they are never
// spawn args.
const PROHIBITED_CHILD_ARGS = ["--build-hnsw", "--contextual", "--slice"];

// ---------------------------------------------------------------------------
// Small primitives (idioms copied from the cited seams; kept local because
// watermark.js and connectors/index.js do not export them).
// ---------------------------------------------------------------------------

function nowIsoOf(now) {
  return (typeof now === "function" ? now() : new Date()).toISOString();
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "ESRCH") return false;
    if (err && err.code === "EPERM") return true; // exists, not signalable
    return false;
  }
}

// fsync a directory so a rename inside it is durable (connectors/index.js
// fsyncDir idiom; EISDIR/EINVAL tolerated on platforms that refuse dir fsync).
function fsyncDir(dirPath) {
  let dirFd = -1;
  try {
    dirFd = openSync(dirPath, fsConstants.O_RDONLY);
    fsyncSync(dirFd);
  } catch (err) {
    if (err && err.code !== "EISDIR" && err.code !== "EINVAL") throw err;
  } finally {
    if (dirFd !== -1) {
      try { closeSync(dirFd); } catch { /* ignore */ }
    }
  }
}

function writeAllSync(fd, body) {
  const buf = Buffer.from(body, "utf8");
  let written = 0;
  while (written < buf.length) {
    written += writeSync(fd, buf, written, buf.length - written);
  }
}

// ---------------------------------------------------------------------------
// Lockfile (watermark.js:529-644 idiom).
// ---------------------------------------------------------------------------

function readLockBody(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
    if (parsed && typeof parsed === "object" && Number.isInteger(parsed.pid)) return parsed;
  } catch { /* missing / unreadable / malformed -> no body */ }
  return null;
}

function writeLockBodyOnFd(fd, now) {
  writeAllSync(fd, JSON.stringify({ pid: process.pid, ts: nowIsoOf(now) }));
  fsyncSync(fd);
}

function acquireLock(lockPath, now) {
  try {
    const fd = openSync(lockPath, LOCK_FLAGS, FILE_MODE);
    try {
      const st = fstatSync(fd);
      if (st.nlink !== 1) throw new Error("reembed-drain lock has unexpected nlink");
      writeLockBodyOnFd(fd, now);
    } finally {
      closeSync(fd);
    }
    return { acquired: true, reclaimed_prior_pid: null };
  } catch (err) {
    if (err && err.code !== "EEXIST") throw err;
  }
  // Lock exists. Check reclaim eligibility (dead pid OR very old mtime).
  const body = readLockBody(lockPath);
  let stMtimeMs = 0;
  try { stMtimeMs = statSync(lockPath).mtimeMs; } catch { stMtimeMs = 0; }
  const ageSec = (Date.parse(nowIsoOf(now)) - stMtimeMs) / 1000;
  const priorPid = body ? body.pid : null;
  const ownerAlive = priorPid != null && isPidAlive(priorPid);
  if (!ownerAlive || ageSec > STALE_LOCK_SECONDS) {
    try {
      unlinkSync(lockPath);
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
    try {
      const fd = openSync(lockPath, LOCK_FLAGS, FILE_MODE);
      try {
        const st = fstatSync(fd);
        if (st.nlink !== 1) throw new Error("reembed-drain lock has unexpected nlink (reclaim)");
        writeLockBodyOnFd(fd, now);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      if (err && err.code === "EEXIST") return { acquired: false, reclaimed_prior_pid: null };
      throw err;
    }
    return { acquired: true, reclaimed_prior_pid: priorPid };
  }
  return { acquired: false, reclaimed_prior_pid: null };
}

function releaseLock(lockPath) {
  // Only remove the lock if the body still records our pid (defensive
  // against a stale-reclaim that happened under us).
  const body = readLockBody(lockPath);
  if (body == null || body.pid !== process.pid) return;
  try { unlinkSync(lockPath); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Cursor (connectors/index.js writeCursor idiom; JSON {offset}).
// ---------------------------------------------------------------------------

function readCursorOffset(cursorPath) {
  let raw;
  try {
    raw = readFileSync(cursorPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return 0;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    const n = parsed && typeof parsed === "object" ? Number(parsed.offset) : NaN;
    if (Number.isInteger(n) && n >= 0) return n;
  } catch { /* corrupt -> treat as absent; next write re-creates it */ }
  return 0;
}

/**
 * writeCursorFile — THE atomic cursor writer, tree-wide: tmp +
 * O_EXCL|O_NOFOLLOW 0600 + fsync + rename + dir-fsync (the
 * mcp/lib/connectors/index.js writeCursor idiom). EXPORTED so
 * mcp/lib/recall/embed-work-set.js persists its own cursor through THIS
 * function instead of growing a second copy of the sequence — one atomic
 * cursor writer is a bound invariant of the e2 node.
 *
 * `body` is any JSON-serialisable object; `writeCursorOffset` below is the
 * `{offset}` spelling every pre-existing caller uses and its bytes are
 * unchanged (JSON.stringify(value, null, 2) + "\n").
 */
export function writeCursorFile(cursorPath, body) {
  const dir = dirname(cursorPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = cursorPath + ".tmp." + randomBytes(6).toString("hex");
  const fd = openSync(
    tmpPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    FILE_MODE
  );
  try {
    writeAllSync(fd, JSON.stringify(body, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  renameSync(tmpPath, cursorPath);
  fsyncDir(dir);
}

function writeCursorOffset(cursorPath, offset) {
  writeCursorFile(cursorPath, { offset });
}

// ---------------------------------------------------------------------------
// Structured log (append-only, best-effort — a log failure never breaks the
// drain; the fact-of-record is the cursor + the sidecar).
// ---------------------------------------------------------------------------

function appendLog(logPath, record) {
  try {
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify(record) + "\n";
    const fd = openSync(
      logPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND,
      FILE_MODE
    );
    try {
      writeAllSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Batch collection — stream the sweep READ-ONLY from a byte offset, gathering
// up to `batch` DISTINCT fact_ids. Byte accounting is exact: a line is only
// consumed when its trailing "\n" was observed (appendReEmbedSweep always
// writes one, watermark.js:168; a torn final line without "\n" is left for
// the next run rather than mis-counted). Malformed complete lines are
// skipped + logged but their bytes ARE included in the candidate new offset
// — never wedge on a bad row.
// ---------------------------------------------------------------------------

async function collectBatch({ sweepPath, startOffset, batch, onMalformed }) {
  const ids = new Set();
  let offset = startOffset;
  let skippedMalformed = 0;
  const stream = createReadStream(sweepPath, { start: startOffset });
  let remainder = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      remainder = remainder.length === 0 ? chunk : Buffer.concat([remainder, chunk]);
      let nl;
      while ((nl = remainder.indexOf(0x0a)) !== -1) {
        const lineBuf = remainder.subarray(0, nl);
        const lineBytes = nl + 1; // include the "\n"
        remainder = remainder.subarray(nl + 1);
        const line = lineBuf.toString("utf8");
        let factId = null;
        if (line.trim().length > 0) {
          try {
            const o = JSON.parse(line);
            if (o && typeof o.fact_id === "string" && o.fact_id.length > 0) factId = o.fact_id;
          } catch { /* malformed */ }
        }
        if (factId == null) {
          if (line.trim().length > 0) {
            skippedMalformed += 1;
            if (typeof onMalformed === "function") {
              onMalformed({ at_offset: offset, snippet: line.slice(0, 120) });
            }
          }
          offset += lineBytes; // blank/malformed bytes are consumed regardless
        } else {
          ids.add(factId);
          offset += lineBytes;
        }
        if (ids.size >= batch) {
          stream.destroy();
          return { ids: [...ids], newOffset: offset, skippedMalformed };
        }
      }
    }
  } catch (err) {
    // Premature close from stream.destroy() is expected; anything else is real.
    if (!err || err.code !== "ERR_STREAM_PREMATURE_CLOSE") throw err;
  }
  return { ids: [...ids], newOffset: offset, skippedMalformed };
}

// ---------------------------------------------------------------------------
// Production health check — GET ${EMBED_URL}/health, require ok:true
// (route shape: local-embedder/embed_server.py:113-119).
// ---------------------------------------------------------------------------

async function defaultHealthCheck() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${EMBED_URL}/health`, { signal: ctl.signal });
    if (!res.ok) return false;
    const body = await res.json();
    return body != null && body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// R7 THROTTLE — bound the SHAPE of the child's requests to the embed server.
//
// Measured in this node (2026-08-17T18:00-18:10Z), not relayed:
//   - 10 of the 12 `repair-failed` records land within +/-0.7s of a
//     `phase 1: pid=N exited` line in daemons/logs/embed-watchdog.log. The
//     interrupter is the watchdog's own SIGTERM, which is CORRECT machine-
//     safety behaviour and is not to be suppressed.
//   - The last 40 `drain started (...)` reasons in the embed server's stdout
//     are 40/40 `signal 15`. ZERO are `recycle after 128 requests`. The
//     recycle valve is not what interrupts these drains.
//   - REEMBED_BATCH=1000 is exonerated: two `drained=1000 failed=0` records at
//     13:20:27Z and 13:42:30Z, same day, same code, between the failures.
// So the fix must stop the footprint REACHING the ceiling, and the only lever
// this drainer legitimately owns is the request shape it asks the child for.
// Both flags already exist in the proven child script; this file only passes
// them, and edits that script not at all.
//
// --batch-texts N derivation (BOTH bounds checked, neither guessed):
//   Bound 1, the forward pass. The child caps a request at
//   N * MODEL_CONTEXT_TOKENS (2048) padded tokens; the server's own per-pass
//   budget is EMBED_MAX_BATCH_TOKENS=16384 (default, and NOT overridden in the
//   live embed-server plist, so _batch_size_for is in force). N=8 makes
//   8*2048 = 16384 — exactly one server forward pass per HTTP request, so
//   _maybe_empty_mps_cache fires once per pass (it runs after _MODEL.encode()
//   RETURNS in _encode_locked, i.e. once per request, never between the
//   internal batches of one encode).
//   Bound 2, the counter-pressure. Replaying the child's own batching loop
//   (its exported chunksFor + batchSizeForCharLen) over the MEASURED length
//   distribution of the stuck window's 1000 fact ids -> 1025 chunk items:
//       N absent -> 15 requests, 31 forward passes, max 48,816 padded tokens
//       N=8      -> 129 requests  <-- CROSSES EMBED_RECYCLE_AFTER_REQUESTS=128
//       N=16     ->  67 requests,  69 forward passes, max 21,600 padded tokens
//   N=8 wins bound 1 and LOSES bound 2 by one request: it would start firing
//   the recycle mid-batch and manufacture the exact drain/hang-up shape this
//   change exists to remove. N=16 is the largest value that satisfies both —
//   it holds ~1.03 forward passes per request (69/67) and leaves 61 requests
//   of headroom under the recycle for the other clients sharing the server.
// --pause-ms 250: the child's documented purpose for the flag is to let MPS
//   allocator pressure settle between batches. At 67 requests it adds ~17s to
//   a batch whose successful runs took ~22 min end to end.
const REPAIR_THROTTLE_DEFAULTS = Object.freeze({ batchTexts: 16, pauseMs: 250 });

// Env values are OPERATOR INPUT and are treated as hostile: only a positive
// integer is accepted, so no env value can smuggle a flag (e.g. "--slice")
// into the argv through a value slot. Anything else falls back to the default
// and says so; it is never passed through.
export function parsePositiveIntEnv(raw, fallback, name, onWarn) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const s = String(raw);
  // Reject anything flag-shaped up front, before Number() gets a chance to be
  // clever about it.
  if (s.startsWith("-") || !/^[0-9]+$/.test(s.trim())) {
    if (onWarn) onWarn(`${name}: refusing invalid value ${JSON.stringify(s)}; using ${fallback}`);
    return fallback;
  }
  const n = Number(s.trim());
  if (!Number.isSafeInteger(n) || n <= 0) {
    if (onWarn) onWarn(`${name}: refusing invalid value ${JSON.stringify(s)}; using ${fallback}`);
    return fallback;
  }
  return n;
}

// ---------------------------------------------------------------------------
// buildRepairChildArgs — PURE. The full child argv, so the spawn arguments are
// testable at all (every auto-drain.test.mjs case injects `repair`, so the
// real argv was previously covered by nothing).
//
// Kill switch: REEMBED_THROTTLE=0 returns the byte-identical PRE-THROTTLE argv
// (asserted in auto-drain.test.mjs, not claimed here). Default is ON, because
// a default-off flag repairs nothing on a drain that is currently failing
// every scheduled run — and because this file goes live unreviewed on the next
// launchd tick, the OFF path has to be the provable no-op, not the ON path.
// ---------------------------------------------------------------------------
export function buildRepairChildArgs({ idsFile, env = process.env, onWarn } = {}) {
  if (typeof idsFile !== "string" || idsFile.length === 0) {
    throw new Error("buildRepairChildArgs: idsFile must be a non-empty string");
  }
  const script = join("mcp", "scripts", "reembed-local-4096.mjs");
  const argv = ["--max-old-space-size=8192", script, "--ids-file", idsFile];

  if (String(env.REEMBED_THROTTLE ?? "1") !== "0") {
    const batchTexts = parsePositiveIntEnv(
      env.REEMBED_BATCH_TEXTS, REPAIR_THROTTLE_DEFAULTS.batchTexts, "REEMBED_BATCH_TEXTS", onWarn);
    const pauseMs = parsePositiveIntEnv(
      env.REEMBED_PAUSE_MS, REPAIR_THROTTLE_DEFAULTS.pauseMs, "REEMBED_PAUSE_MS", onWarn);
    argv.push("--batch-texts", String(batchTexts), "--pause-ms", String(pauseMs));
  }

  // The guard is LOAD-BEARING: it runs over the assembled argv (flags AND
  // value slots), so a prohibited flag cannot reach the child through either.
  for (const arg of argv) {
    if (PROHIBITED_CHILD_ARGS.includes(arg)) {
      throw new Error(`prohibited child arg: ${arg}`);
    }
  }
  return argv;
}

// ---------------------------------------------------------------------------
// R6 WORK PROOF — the cursor may only advance on MEASURED work.
//
// The defect this closes: before R6 the cursor advanced on the child's EXIT
// STATUS alone (`repairOk` from `res.status === 0` plus the `CONTEXTUAL dense:`
// stderr guard, and nothing else). The child can legitimately exit 0 having
// written NOTHING, through production doors that are all reachable:
//   - main()'s per-vector validation loop skips every vector whose shape is
//     wrong: `Array.isArray(v) && v.length === 4096 && v.every(Number.isFinite)`
//     (reembed-local-4096.mjs, the `SKIP non-finite/badshape vector` branch).
//     A degraded server returning wrong-dim or NaN vectors makes that loop skip
//     ALL of them: `embedded=0`, sidecar untouched, exit 0.
//   - the empty/whitespace-only chunk filter (`dropped N empty/whitespace-only
//     chunks (zero-vector/NaN guard)`) can empty `items` outright.
//   - `collectContents` resolving zero rows for the batch (an id present in the
//     sweep but absent from ledgers/memory.jsonl) leaves `items` empty too.
// In every one of those the old drain wrote the cursor and logged
// `drained: N` — reporting health it had not measured (GOAL #1: absence is
// never a verdict).
//
// The blast radius is bounded on the promote side: appendReEmbedSweep is called
// from the watermark cascade only after the fact row is durable AND only when
// `hadContent` is true, so a swept id always has content to re-embed. That
// bounds it; it does not make the exit-status gate sound.
//
// The proof is the PARENT's own measurement of the child's output file, never
// the child's claim about itself:
//   measureBatchWork()      READ-ONLY stat + tail read of the sidecar
//   parseChildWorkEvidence() the child's own counts, used only to ROUTE
//   classifyWorkProof()      pure, three buckets, one of which is "I cannot tell"
// Zero edits to mcp/scripts/reembed-local-4096.mjs was R6's SCOPE: the child
// already printed every number the parent needed, and the parent measures the
// file itself. E3 2026-09 amended that by ONE added child line —
// `pending after item-level resume: N facts`, a chunksFor completeness count —
// so `pending` no longer over-counts a fully-embedded chunked giant. The parent
// still measures the file; the child's line only routes / corroborates.
// ---------------------------------------------------------------------------

// The sidecar the child writes. Derived by MIRRORING the child's own
// derivation (reembed-local-4096.mjs: `MODEL_VERSION = env.
// ACTIVE_EMBED_MODEL_VERSION || "qwen3-embedding-8b-fp16"`, then `INDEX_DIR =
// join(REPO, "indices", OUTPUT_MODEL_VERSION)`, `SIDECAR = join(INDEX_DIR,
// "vectors.jsonl")`) rather than by importing CAPS from validation.js — the
// child reads the env var, so mirroring the env var is the only way parent and
// child can never disagree about which file to measure.
// The `-contextual` retarget is NOT mirrored on purpose: --contextual is in
// PROHIBITED_CHILD_ARGS and defaultRepair refuses any child whose stderr says
// "CONTEXTUAL dense:" BEFORE any proof runs, so a retargeted child is rejected
// for the retarget reason, never measured against the wrong tree.
//
// The env-var read itself is `defaultModelVersion`, extracted so the sidecar,
// the hnsw meta and the e2 work set all mirror the child through ONE symbol.
export function defaultModelVersion(env = process.env) {
  return env.ACTIVE_EMBED_MODEL_VERSION || "qwen3-embedding-8b-fp16";
}

export function defaultSidecarPath(env = process.env) {
  return join(REPO, "indices", defaultModelVersion(env), "vectors.jsonl");
}

// The live vector index's meta, derived from `defaultSidecarPath` by DIRNAME
// rather than by building a second `indices/<model>/` path: parent, child,
// census and work set then cannot disagree about which tree is being measured,
// and the r7 `indices/` path-constructor census (T15 in
// mcp/test/rebuild-target-retarget.test.mjs) keeps exactly one site for this
// file. Used only by the e2 LEDGER work-set mode (default OFF); the 3.9 MB
// meta.json is parsed directly and hnsw.bin (2.1 GB) is never opened.
export function defaultHnswMetaPath(env = process.env) {
  return join(dirname(defaultSidecarPath(env)), "hnsw.bin.meta.json");
}

// Bytes of a sidecar line decoded for the id fast path. The child writes
// `JSON.stringify({ id: slice[k].id, v })`, so `id` is the FIRST key and a
// `mem_<16 hex>` id (optionally `#<k>`) sits inside the first ~30 bytes; 256 is
// generous headroom. The rest of the line — 4096 floats, ~80 KB — is never
// decoded on the fast path.
const ID_HEAD_BYTES = 256;

// Chunked facts write ONLY `${factId}#${k}` sidecar lines
// (reembed-local-4096.mjs: `factsWritten.add(slice[k].id.replace(/#\d+$/, ""))`).
// Strip exactly as the child does so a chunked fact counts ONCE.
export function stripChunkSuffix(id) {
  return id.replace(/#\d+$/, "");
}

// Extract the fact id from one sidecar line buffer. Fast path first (no full
// decode of an ~80 KB line); JSON.parse fallback so a line written with a
// different key order is still counted — the fallback is exercised by
// auto-drain.test.mjs's KEY-ORDER case, not merely asserted here.
export function sidecarLineId(lineBuf) {
  if (lineBuf.length === 0) return null;
  const head = lineBuf.subarray(0, Math.min(lineBuf.length, ID_HEAD_BYTES)).toString("utf8");
  if (head.startsWith('{"id":"')) {
    const close = head.indexOf('"', 7);
    // A backslash inside the slice means JSON escaping the fast path must not
    // guess at; fall through to the real parser.
    if (close > 7 && !head.slice(7, close).includes("\\")) {
      return stripChunkSuffix(head.slice(7, close));
    }
  }
  try {
    const o = JSON.parse(lineBuf.toString("utf8"));
    if (o && typeof o.id === "string" && o.id.length > 0) return stripChunkSuffix(o.id);
  } catch { /* not a sidecar line */ }
  return null;
}

// Stream a byte range of the sidecar READ-ONLY and report which of `wanted` it
// contains. Newline-split INCREMENTALLY with the collectBatch idiom — a full
// batch tail is 1000 facts x 4096 floats (~80 MB of line text) and must never
// be buffered whole; peak retention here is one chunk plus one partial line.
// A final line with no trailing "\n" is deliberately NOT counted: the child
// appends whole lines, so an unterminated tail is a write in flight.
async function streamSidecarIdMatches({ sidecarPath, start, end, wanted, earlyExit }) {
  const found = new Set();
  if (wanted.size === 0) return found;
  const streamOpts = { start };
  if (Number.isInteger(end)) streamOpts.end = end;
  const stream = createReadStream(sidecarPath, streamOpts);
  let remainder = Buffer.alloc(0);
  let satisfied = false;
  try {
    for await (const chunk of stream) {
      remainder = remainder.length === 0 ? chunk : Buffer.concat([remainder, chunk]);
      let nl;
      while ((nl = remainder.indexOf(0x0a)) !== -1) {
        const lineBuf = remainder.subarray(0, nl);
        remainder = remainder.subarray(nl + 1);
        const id = sidecarLineId(lineBuf);
        if (id !== null && wanted.has(id)) {
          found.add(id);
          if (earlyExit === true && found.size === wanted.size) { satisfied = true; break; }
        }
      }
      if (satisfied) { stream.destroy(); break; }
    }
  } catch (err) {
    // Premature close from stream.destroy() is expected; anything else is real
    // and must surface as UNMEASURABLE rather than as a short count.
    if (!err || err.code !== "ERR_STREAM_PREMATURE_CLOSE") throw err;
  }
  return found;
}

// measureBatchWork — did THIS run append a vector for each batch id?
//
// STRICTLY READ-ONLY: statSync + createReadStream over the appended tail only.
// Never mkdirSync, never an open-for-write, never create-if-missing — the
// sidecar is the child's file and `appendReEmbedSweep`-style append-only
// discipline applies to it as well.
//
// measurable:false (never a count, never a verdict) when:
//   - the sidecar is missing / unstattable, or sizeBefore was never captured;
//   - sizeAfter < sizeBefore — truncated, rotated or replaced under us, so the
//     tail is unattributable to this batch;
//   - any read error while streaming the tail.
export async function measureBatchWork({ sidecarPath, sizeBefore, ids } = {}) {
  const idList = Array.isArray(ids) ? ids : [];
  const unmeasurable = (sizeAfter) => ({
    measurable: false,
    sizeAfter: sizeAfter === undefined ? null : sizeAfter,
    matched: 0,
    matchedIds: [],
    unmatchedCount: idList.length,
  });
  if (typeof sidecarPath !== "string" || sidecarPath.length === 0) return unmeasurable();
  if (!Number.isInteger(sizeBefore) || sizeBefore < 0) return unmeasurable();

  let sizeAfter;
  try {
    sizeAfter = statSync(sidecarPath).size;
  } catch {
    return unmeasurable();
  }
  if (sizeAfter < sizeBefore) return unmeasurable(sizeAfter);

  // ids arrive deduped from collectBatch (a Set), so wanted.size === ids.length.
  const wanted = new Set(idList);
  if (sizeAfter === sizeBefore || wanted.size === 0) {
    return { measurable: true, sizeAfter, matched: 0, matchedIds: [], unmatchedCount: wanted.size };
  }
  let found;
  try {
    found = await streamSidecarIdMatches({
      sidecarPath,
      start: sizeBefore,
      end: sizeAfter - 1,
      wanted,
      earlyExit: true,
    });
  } catch {
    return unmeasurable(sizeAfter);
  }
  return {
    measurable: true,
    sizeAfter,
    matched: found.size,
    matchedIds: [...found],
    unmatchedCount: wanted.size - found.size,
  };
}

// scanSidecarForIds — the AUTHORITATIVE already-embedded check: does the WHOLE
// sidecar contain a vector for each batch id, no matter which run wrote it?
//
// COST, MEASURED IN THIS NODE against the real file (2026-08-18, three runs,
// vendor/node v24.15.0, this exact streaming + 256-byte-head idiom):
//   12,376,243,035 B / 151,924 lines in 2.27 / 2.25 / 2.24 s
//   => 5.45 - 5.52 GB/s, i.e. ~0.25% of the drain's StartInterval=900 cadence.
// Affordable, so this branch MEASURES instead of estimating. It is NOT on the
// common path: it runs only when the tail measured zero new writes AND the
// child reported `pending after done-filter: 0 facts`. Early exit stops the
// scan as soon as every batch id is found.
//
// Never stalls a genuine redo: the child's own `pending` is computed from
// loadDoneIds over THIS SAME FILE before the batch, and the file only grows, so
// `pending === 0` implies every batch id is already present for this scan to
// find. (The child's done-set holds chunk ids too; stripChunkSuffix makes this
// scan's match set a superset of the child's, never a subset.)
export async function scanSidecarForIds({ sidecarPath, ids } = {}) {
  const idList = Array.isArray(ids) ? ids : [];
  if (typeof sidecarPath !== "string" || sidecarPath.length === 0) {
    return { measurable: false, matched: 0, matchedIds: [], unmatchedCount: idList.length };
  }
  try {
    statSync(sidecarPath);
  } catch {
    return { measurable: false, matched: 0, matchedIds: [], unmatchedCount: idList.length };
  }
  const wanted = new Set(idList);
  let found;
  try {
    found = await streamSidecarIdMatches({ sidecarPath, start: 0, wanted, earlyExit: true });
  } catch {
    return { measurable: false, matched: 0, matchedIds: [], unmatchedCount: idList.length };
  }
  return {
    measurable: true,
    matched: found.size,
    matchedIds: [...found],
    unmatchedCount: wanted.size - found.size,
  };
}

// The child's own work counts, lifted from stderr beside lastChildProgressLine.
// PREMISE, verified against reembed-local-4096.mjs rather than assumed: both
// lines render their numbers with toLocaleString(), i.e. THOUSANDS SEPARATORS —
//   pending after done-filter: 1,000 facts
//   DONE embedded=1,000 facts=1,000 in 21.4min sidecar=/.../vectors.jsonl
// so a `\d+` parser is wrong at n >= 1000, which is exactly the live
// REEMBED_BATCH=1000 case. Hence [\d,]+ and a comma-strip.
//
// All fields are null when the lines are absent — which is precisely the
// shape of the accident this node closes: a child that never reached main()'s
// embed loop printed neither line, and nothing may be inferred from that.
//
// E3 2026-09 — the child now also prints, after item-level resume,
//   pending after item-level resume: 1 facts
// a chunksFor COMPLETENESS count (a fact whose every chunk id is already in the
// sidecar is not pending). `pending` prefers that line, because the bare-id
// done-filter line cannot see `${id}#k` lines and over-counts a fully-embedded
// chunked giant (the r6-4 stall: 599 refused ticks at offset 7092821). For an
// older child's stderr without the line, `pending` falls back to the
// done-filter count, so the existing log census stays readable by this parser.
// `pending_before_resume` keeps the done-filter count so a record shows both.
export function parseChildWorkEvidence(stderr) {
  const none = { completed: null, embedded: null, facts: null, pending: null, pending_before_resume: null };
  if (typeof stderr !== "string" || stderr.length === 0) return none;
  const toInt = (s) => {
    const n = Number(String(s).replace(/,/g, ""));
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  };
  const pendingM = /^pending after done-filter: ([\d,]+) facts$/m.exec(stderr);
  const resumeM = /^pending after item-level resume: ([\d,]+) facts$/m.exec(stderr);
  const doneM = /^DONE embedded=([\d,]+) facts=([\d,]+)\b/m.exec(stderr);
  if (!pendingM && !resumeM && !doneM) return none;
  const pendingBeforeResume = pendingM ? toInt(pendingM[1]) : null;
  return {
    completed: doneM != null,
    embedded: doneM ? toInt(doneM[1]) : null,
    facts: doneM ? toInt(doneM[2]) : null,
    pending: resumeM ? toInt(resumeM[1]) : pendingBeforeResume,
    pending_before_resume: pendingBeforeResume,
  };
}

// The three verdict buckets. F72: an UNMEASURABLE state gets its own bucket and
// may never assert health — it is neither success nor failure, and it must not
// be collapsed onto either.
export const WORK_VERDICT = Object.freeze({
  VERIFIED: "verified",
  UNPROVEN: "unproven",
  UNMEASURABLE: "unmeasurable",
});

// Evidence classes. Each names HOW the bucket was reached, so a log census can
// tell a measured verification from a routed one.
export const WORK_EVIDENCE = Object.freeze({
  TAIL: "sidecar-tail",                                  // parent counted NEW writes
  FULL_SCAN: "sidecar-full-scan",                        // parent counted PRE-EXISTING vectors
  CHILD_ALREADY_EMBEDDED: "child-reported-already-embedded", // routing label only; runDrain upgrades it
  TAIL_SHORTFALL: "sidecar-tail-shortfall",              // measured negative
  FULL_SCAN_SHORTFALL: "sidecar-full-scan-shortfall",    // measured negative
  UNMEASURABLE: "unmeasurable",
});

// Evidence classes whose question the TAIL cannot answer, so runDrain escalates
// them to the whole-file scan. Routing is the CONSUMER's job: classifyWorkProof
// stays pure and keeps its three buckets, and this set is the only thing that
// decides which of its labels earns a second, wider measurement.
//
// TAIL_SHORTFALL was once routed here too (r6 round 2; REVERTED 2026-08-18 —
// see the note above the CHILD_ALREADY_EMBEDDED route in runDrain). A
// shortfall asks a different question than the tail can answer — "does a
// vector exist for it AT ALL?" — but scanSidecarForIds answers only chunk
// PRESENCE, so the route was unsafe. The case that forced it was an
// already-embedded chunked fact: the child's done-filter was bare-id and could
// not see `${id}#k` lines, so it counted the fact in `pending` while
// item-level resume wrote nothing for it. The tail was then permanently 0
// against a permanently non-zero `pending`, and refusing on that stalled the
// drain forever on a state the child treats as normal.
//
// E3 2026-09 closed that case in the CHILD, not by widening this route: the
// child now reports `pending` after a chunksFor completeness count (every
// chunk id of a fact present in the sidecar => not pending), so a
// chunk-complete giant no longer inflates `pending`, and rule (2) below
// reconciles on the ids that were really written this run. The parent still
// cannot measure completeness itself and still never routes a shortfall to
// the presence-only scan; a shortfall that survives the child's count is a
// real one (an unresolvable ledger row, or a chunk genuinely missing).

// classifyWorkProof — PURE. Returns exactly one bucket plus the evidence class
// that produced it.
//
// The child's evidence may only ROUTE to a measurement or CORROBORATE one. It
// may never by itself grant `verified` for an id that has no vector: every
// `verified` below is backed by a parent-side count, and the one branch that
// starts from the child's word (CHILD_ALREADY_EMBEDDED) is a routing label that
// runDrain replaces with the result of a real scan.
export function classifyWorkProof({ idsCount, matched, measurable, childEvidence } = {}) {
  const n = Number.isInteger(idsCount) && idsCount >= 0 ? idsCount : 0;
  const m = Number.isInteger(matched) && matched >= 0 ? matched : 0;
  const pending =
    childEvidence && typeof childEvidence === "object" && Number.isInteger(childEvidence.pending)
      ? childEvidence.pending
      : null;

  // (5a) Nothing was measurable at all — never a verdict about the work.
  if (measurable !== true) {
    return { verdict: WORK_VERDICT.UNMEASURABLE, work_evidence: WORK_EVIDENCE.UNMEASURABLE };
  }
  // (1) Every batch id got a NEW vector in this run's tail.
  if (m === n) {
    return { verdict: WORK_VERDICT.VERIFIED, work_evidence: WORK_EVIDENCE.TAIL };
  }
  // (5b) A short count with NO child evidence to reconcile against: we cannot
  // tell an idempotent redo from a silent no-op. Refuse without accusing.
  if (pending === null) {
    return { verdict: WORK_VERDICT.UNMEASURABLE, work_evidence: WORK_EVIDENCE.UNMEASURABLE };
  }
  // (2) RECONCILED PARTIAL: the parent's independent count of NEW writes equals
  // the child's own pending count, so the unmatched ids were already embedded
  // before this run. This is the branch that keeps an idempotent redo moving.
  if (m > 0 && m === pending) {
    return { verdict: WORK_VERDICT.VERIFIED, work_evidence: WORK_EVIDENCE.TAIL };
  }
  // (3) Child says there was nothing left to do. ROUTE to the full scan; see
  // scanSidecarForIds for the measured cost that makes that affordable.
  if (m === 0 && pending === 0) {
    return {
      verdict: WORK_VERDICT.VERIFIED,
      work_evidence: WORK_EVIDENCE.CHILD_ALREADY_EMBEDDED,
    };
  }
  // (4) MEASURED NEGATIVE — measurable, but the counts do not reconcile
  // (includes matched < pending: the child meant to write more than it did).
  return { verdict: WORK_VERDICT.UNPROVEN, work_evidence: WORK_EVIDENCE.TAIL_SHORTFALL };
}

// A refusal record carries at most this many unproven ids, so one record stays
// readable while still naming the wedge.
const UNPROVEN_SAMPLE_MAX = 10;

// Read the embed server's pid the way daemons/embed-watchdog.sh does — the
// `launchctl list | awk '$3 == label { print $1 }'` idiom. READ-ONLY: this
// never signals, kickstarts, loads or unloads anything.
const EMBED_SERVER_LABEL =
  process.env.EMBED_SERVER_LABEL || "com.user.memory-system.embed-server";

export function parseLaunchctlPid(stdout, label) {
  if (typeof stdout !== "string") return null;
  for (const line of stdout.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || f[2] !== label) continue;
    const pid = Number(f[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null; // "-" => not running
  }
  return null;
}

function readEmbedServerPid() {
  try {
    const res = spawnSync("/bin/launchctl", ["list"], { encoding: "utf8", timeout: 5_000 });
    if (res.error || res.status !== 0) return null;
    return parseLaunchctlPid(res.stdout || "", EMBED_SERVER_LABEL);
  } catch {
    return null;
  }
}

// The child's last `+N (bs=... maxchars=... Xs) total=... rate=... remaining=N`
// progress line. Without it the only evidence in a repair-failed record is a
// 500-char tail of retry noise, which says nothing about how far the batch got.
export function lastChildProgressLine(stderr) {
  if (typeof stderr !== "string" || stderr.length === 0) return null;
  let found = null;
  for (const line of stderr.split("\n")) {
    if (/^\+\d+ \(bs=/.test(line)) found = line.trim();
  }
  return found;
}

// Lift whichever attribution fields the repair result carries onto the log
// record. An INJECTED repair (every test) carries none, so nothing is
// fabricated; a spawned repair carries all four.
const ATTRIBUTION_KEYS = [
  "server_pid_before",
  "server_pid_after",
  "server_restarted_during_batch",
  "child_last_progress",
  // R6: the child's own work counts (parseChildWorkEvidence). Present only on a
  // SPAWNED repair; an injected repair that does not set it carries none, so
  // the existing repairAttribution contract keeps anything from being
  // fabricated on its behalf.
  "child_work_evidence",
];

function repairAttribution(repairResult) {
  const out = {};
  if (!repairResult || typeof repairResult !== "object") return out;
  for (const k of ATTRIBUTION_KEYS) {
    if (k in repairResult) out[k] = repairResult[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Production repair — REUSE-BY-SPAWN of the proven script, zero edits to it.
// Writes the deduped ids to a tmp ids-file and spawns the argv that
// buildRepairChildArgs assembles, with cwd = REPO. The child's own loadDoneIds
// (reembed-local-4096.mjs:92-101) makes re-runs of a failed batch free —
// already-written ids are skipped — which is exactly why leaving the cursor
// stuck on failure is safe.
// Returns { ok, exitCode, detail, server_pid_before, server_pid_after,
//           server_restarted_during_batch, child_last_progress }.
// ---------------------------------------------------------------------------

function defaultRepair(ids) {
  const nodeBin = join(REPO, "vendor", "node", "bin", "node");
  const tmpDir = mkdtempSync(join(tmpdir(), "reembed-drain-ids-"));
  const idsFile = join(tmpDir, "ids.txt");
  try {
    writeFileSync(idsFile, ids.join("\n") + "\n", { mode: FILE_MODE });
    let finalArgs;
    try {
      finalArgs = buildRepairChildArgs({
        idsFile,
        onWarn: (m) => process.stderr.write(`reembed-drain: ${m}\n`),
      });
    } catch (err) {
      return { ok: false, exitCode: null, detail: String((err && err.message) || err) };
    }
    // Kill attribution: the pid on both sides of the spawn, so the NEXT
    // occurrence is diagnosable from the log alone instead of costing another
    // investigation. Read-only launchctl list; no signal is ever sent.
    const serverPidBefore = readEmbedServerPid();
    const res = spawnSync(nodeBin, finalArgs, {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const serverPidAfter = readEmbedServerPid();
    const attribution = {
      server_pid_before: serverPidBefore,
      server_pid_after: serverPidAfter,
      // null on either side means launchctl could not be read; that is unknown,
      // not "no restart", so it stays null rather than collapsing to false.
      server_restarted_during_batch:
        serverPidBefore == null || serverPidAfter == null
          ? null
          : serverPidBefore !== serverPidAfter,
      child_last_progress: lastChildProgressLine(res.stderr || ""),
      // R6: routing evidence for the work proof. The parent still measures the
      // sidecar itself — this only ever routes or corroborates.
      child_work_evidence: parseChildWorkEvidence(res.stderr || ""),
    };
    const stderr = res.stderr || "";
    // CAPS.CONTEXTUAL_DENSE_ENABLED retarget detection
    // (reembed-local-4096.mjs:64-69, :400): the baseline tree was NOT written.
    if (stderr.includes("CONTEXTUAL dense:")) {
      return {
        ok: false,
        exitCode: res.status,
        detail: "child retargeted to -contextual tree (CONTEXTUAL dense: in stderr)",
        ...attribution,
      };
    }
    if (res.error) {
      return { ok: false, exitCode: null, detail: String(res.error.message || res.error), ...attribution };
    }
    if (res.status !== 0) {
      return { ok: false, exitCode: res.status, detail: stderr.slice(-500), ...attribution };
    }
    return { ok: true, exitCode: 0, detail: null, ...attribution };
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// runDrain — the whole drain pass, all effects injectable for tests.
// Returns { exitCode, reason, offsetBefore, offsetAfter, drained,
//           skippedMalformed, failed }, plus — on the three records that
// reached the R6 proof step only — vectorsWritten / workEvidence / unproven.
// ---------------------------------------------------------------------------

export async function runDrain(opts = {}) {
  const sweepPath = opts.sweepPath ?? join(REPO, "policy", "re-embed-sweep.jsonl");
  const sidecarPath = opts.sidecarPath ?? defaultSidecarPath();
  const cursorPath = opts.cursorPath ?? join(REPO, "policy", "re-embed-sweep.cursor");
  const lockPath = opts.lockPath ?? join(REPO, "policy", "reembed-drain.lock");
  const logPath = opts.logPath ?? join(REPO, "daemons", "logs", "reembed-drain.log");
  const batch = Number.isInteger(opts.batch) && opts.batch > 0
    ? opts.batch
    : Math.max(1, Number(process.env.REEMBED_BATCH || 200) || 200);
  const healthCheck = opts.healthCheck ?? defaultHealthCheck;
  const repair = opts.repair ?? defaultRepair;
  const now = opts.now; // optional () => Date, for tests

  // e2 — WORK-SET MODE. "sweep" (the default) is EXACTLY today's behaviour:
  // the sweep queue, its cursor, its record shapes, its reason spellings. In
  // "ledger" mode steps (3)-(4) below are replaced by the DERIVED work set
  // (mcp/lib/recall/embed-work-set.js) over ledgers/memory.jsonl, and steps
  // (5)-(7) — sidecar size capture, repair, measureBatchWork, classifyWorkProof,
  // the CHILD_ALREADY_EMBEDDED full-scan route, both refusal records, cursor
  // write only on VERIFIED — are reached UNCHANGED.
  //
  // DEFAULT OFF, VERIFIED READ-ONLY RATHER THAN ASSERTED (2026-08-19).
  // `REEMBED_WORK_SET` is ABSENT from the installed plist at
  //   ~/Library/LaunchAgents/com.user.memory-system.reembed-drain.plist
  // whose entire <EnvironmentVariables> dict is HOME, MEMORY_ROOT, PATH and
  // REEMBED_BATCH=1000 (StartInterval 900, RunAtLoad true, KeepAlive false;
  // file mtime 2026-07-29, i.e. predating this work). This single fact is the
  // whole safety argument for shipping a WIRED drain: with the key absent the
  // `workSetMode` ternary below resolves to "sweep" and the live 900 s tick is
  // byte-identical to what it was. Enabling a walk over e1's 1,388,515
  // P-NEEDS-EMBED candidates (against an hnsw maxElements of 1,000,000) stays
  // an operator decision gated on e4/e5. `mcp/test/auto-drain.test.mjs` arm
  // e2 (e) pins the OFF behaviour key-for-key; it cannot pin the plist, so the
  // plist is cited by path and was read, not assumed.
  //
  // =========================================================================
  // e3 KEEP-DISPOSITION (2026-08-19) — the sweep queue STAYS; retirement is
  // BLOCKED. This block is the seam where the two mechanisms meet, so the
  // decision is recorded HERE rather than only in a document. It is
  // COMMENT-ONLY: not one statement, record key, `reason` spelling or argv
  // changed with it, and arm e2 (e) is still green key-for-key.
  //
  // OUTCOME: **KEEP AS A FAST PATH**, with retirement BLOCKED on the derived
  // path being proven LIVE (it never has been — `REEMBED_WORK_SET` is absent
  // from the installed plist, so ledger mode has run in tests and in the
  // read-only gate, and nowhere else). Retiring a queue on the strength of a
  // passing test is how the l5 revert happened.
  //
  // (1) WHAT EACH MECHANISM COSTS, ONE TOOL, ONE FOOTING.
  //     `node mcp/scripts/verify-embed-work-set.mjs --batch=1000 --sample=3
  //        --sweep=<MEMORY_ROOT>/policy/re-embed-sweep.jsonl`
  //     times both in one process (its `--sweep` arm is e3's; it writes
  //     nothing). Measured on the live tree, 3 runs, 2026-08-19:
  //
  //       QUEUE  idle common path (statSync + cursor read, NO scan)
  //                              0.051-0.065 ms, 0 rows, 0 B  <- the live tick
  //              batch=1000 from a cold cursor
  //                              0.456-0.473 ms, 1,000 rows, 67,000 B
  //              whole-file walk 24.4-25.7 ms, 65,707 rows, 4,402,369 B,
  //                              65,707 distinct ids
  //       DERIVED  id_map read   48.0-54.9 ms (hnsw meta, 4,014,852 B on
  //                              2026-08-19; read EVERY tick)
  //              batch=1000 at cursor 0
  //                              32.5-34.1 ms, 10,774 rows, 16,667,316 B
  //              whole tick      107-113 ms elapsed, peak RSS ~173 MB
  //       DERIVED, from embed-work-set.js's own header (2026-08-18):
  //              96.8 ms whole tick at cursor 0; 12.43 ms for batch 49 at
  //              cursor 120,111,058; 10,515 ms for the `reachedEof` full walk.
  //
  //     BOTH ARE AFFORDABLE ON A 900 s TICK — the derived path's worst case is
  //     1.18 % of one. On the path the daemon actually takes today the queue is
  //     roughly three orders of magnitude cheaper (0.05-0.07 ms against the
  //     derived path's 90-113 ms whole tick), and that is a fact about I/O, not
  //     an argument by itself.
  //
  // (2) WHY KEEP: THE FAST PATH IS REAL, AND NOW EXECUTABLE. Arm e3 (a) pins
  //     it: an id appended to the sweep is drained on the NEXT tick with the
  //     ledger path pointed at a file that does not exist — so the queue's
  //     latency provably does not depend on where in a 3.4 GB append-only
  //     ledger the row sits. The same id in ledger mode is INVISIBLE until the
  //     cursor walks to its offset: 4 ticks in the fixture, and against e1's
  //     1,388,515 P-NEEDS-EMBED candidates at REEMBED_BATCH=1000 a cursor
  //     starting at 0 needs ~1,389 ticks (~14.5 days) to sweep the ledger once.
  //     A freshly-failed embed does not wait 14 days behind a backlog.
  //
  // (3) THE DUPLICATION'S FAILURE MODES, STATED NOT SMOOTHED OVER.
  //     - BARE-ID DONE-FILTER vs `${id}#k` SIDECAR LINES. The child's
  //       `loadDoneIds` (mcp/scripts/reembed-local-4096.mjs) keys on the RAW
  //       sidecar `id`, while a chunked fact writes only `${id}#k` lines, so
  //       the filter never skips a giant. That asymmetry is what makes the
  //       CHILD_ALREADY_EMBEDDED route safe (it requires pending === 0, i.e.
  //       every id already passed the BARE filter) and what makes
  //       TAIL_SHORTFALL unsafe to route there — see the reverted-2026-08-18
  //       note further down this file.
  //     - THE QUEUE'S RESOLVABILITY GUARANTEE THE DERIVED PREDICATE LACKS.
  //       `appendReEmbedSweep`'s SOLE call site (daemons/watermark.js) is
  //       `if (hadContent) appendReEmbedSweep(...)`, so every queued id had
  //       resolvable content when enqueued. The derived predicate is
  //       `readRowEmbedInputs(row).embedState === TRUE` and reads NEITHER
  //       `kind` NOR `content`, so it can hand this drain ids the child's own
  //       `collectContents` will drop (`r.kind !== "fact"`, `c.length === 0`).
  //       Arm e3 (c) drives it: the batch stalls loudly with `repair-no-work` /
  //       `sidecar-tail-shortfall`, the cursor freezes, the ids are named —
  //       the SAFE direction, but it also stalls the resolvable facts sharing
  //       that batch. This is a KEEP argument the e3 spec did not make.
  //     - THE QUEUE CANNOT RETRACT. An id embedded after it was enqueued still
  //       costs a child spawn plus the parent's whole-file `scanSidecarForIds`
  //       proof (vectors.jsonl was 12,622,226,832 B on 2026-08-19). The derived
  //       path answers the same question from the id_map it already read. Arm
  //       e3 (b) pins both sides.
  //     - TWO CURSORS, TWO KEY SPACES. The sweep cursor is a byte offset into
  //       a queue; the work-set cursor is `{v, offset, pin}` into the ledger.
  //       They cannot be reconciled and must never be confused; keeping both
  //       mechanisms means keeping both, and their self-heal rules differ (the
  //       sweep self-heals to 0 on a shrunk file, the work set REFUSES).
  //
  // (4) THE RESIDUALS KEEP KEEPS ALIVE — honestly, not as a footnote:
  //     - r6-4, THE CHUNKED-GIANT STALL. CLOSED IN THE CHILD (E3 2026-09):
  //       reembed-local-4096.mjs planEmbedItems counts a fact complete when
  //       every chunksFor chunk id is in the sidecar and reports `pending
  //       after item-level resume`, which parseChildWorkEvidence prefers.
  //       Ledger mode inherits the fix the same way arm e2 (d) proved it
  //       inherited the stall (a 1.39M-row walk instead of a nearly-empty
  //       queue). The PARENT still cannot measure completeness —
  //       `scanSidecarForIds` answers chunk PRESENCE, not COMPLETENESS — and
  //       still never routes a shortfall to it.
  //     - r6-2, THE FULL SIDECAR SCAN ON A 900 s TIMER. Still open, and also
  //       NOT retired by retiring the queue: embed-work-set.js's L1 note routes
  //       up to 27,072 P-EMBEDDED-SIDECAR-ONLY rows onto this exact
  //       CHILD_ALREADY_EMBEDDED scan, deliberately, because excluding them
  //       would cost a whole-sidecar read per tick (L1 says 12.4 GB; the file
  //       measured 12,622,226,832 B on 2026-08-19 — it only grows).
  //     - THE WORK-PROOF APPARATUS (measureBatchWork, scanSidecarForIds,
  //       classifyWorkProof, the three verdict buckets). Kept in full. It
  //       guards against a CHILD that exits 0 having written nothing, which is
  //       a property of the child, not of where the ids came from — so no
  //       work-set decision can retire it.
  //
  // (5) THE RETIREMENT PROCEDURE EXISTS AND WAS NOT RUN:
  //     it is an operator runbook kept outside this repository. Every
  //     precondition there is falsifiable, and every step is an OPERATOR
  //     action. Nothing under policy/ was deleted, moved or written by e3.
  // =========================================================================
  const workSetMode =
    typeof opts.workSetMode === "string" && opts.workSetMode.length > 0
      ? opts.workSetMode
      : (typeof process.env.REEMBED_WORK_SET === "string" && process.env.REEMBED_WORK_SET.length > 0
        ? process.env.REEMBED_WORK_SET
        : "sweep");
  const ledgerMode = workSetMode === "ledger";
  const ledgerPath = opts.ledgerPath ?? join(REPO, "ledgers", "memory.jsonl");
  const workSetCursorPath =
    opts.workSetCursorPath ?? join(REPO, "policy", "re-embed-work-set.cursor");
  const hnswMetaPath = opts.hnswMetaPath ?? defaultHnswMetaPath();
  const modelVersion = opts.modelVersion ?? defaultModelVersion();

  // BACKLOG REPORTING — how far behind dense coverage actually is, on every
  // record, for zero extra I/O: sweepSize and offsetBefore are already computed
  // below. One rule, so the arithmetic is checkable: sweep_size / bytes_behind
  // are populated exactly when the cursor was read, and are null otherwise.
  // The two pre-cursor reasons keep the keys with null values —
  // `lock-contention` because this file's own contract is that contention
  // performs NO cursor read, and `server-down` for the same symmetry.
  const base = () => ({
    ts: nowIsoOf(now),
    event: "reembed-drain",
    offset_before: null,
    offset_after: null,
    drained: 0,
    skipped_malformed: 0,
    failed: 0,
    sweep_size: null,
    bytes_behind: null,
  });

  // (1) Lock FIRST — contention is a clean no-op: no cursor read, no repair.
  const lock = acquireLock(lockPath, now);
  if (!lock.acquired) {
    appendLog(logPath, { ...base(), reason: "lock-contention" });
    return { exitCode: 0, reason: "lock-contention", offsetBefore: null, offsetAfter: null, drained: 0, skippedMalformed: 0, failed: 0, sweepSize: null, bytesBehind: null };
  }

  try {
    // (2) Health gate — server down is a clean no-op: cursor untouched.
    let healthy = false;
    try { healthy = (await healthCheck()) === true; } catch { healthy = false; }
    if (!healthy) {
      appendLog(logPath, { ...base(), reason: "server-down" });
      return { exitCode: 0, reason: "server-down", offsetBefore: null, offsetAfter: null, drained: 0, skippedMalformed: 0, failed: 0, sweepSize: null, bytesBehind: null };
    }

    // Mode-dependent state produced by steps (3)-(4). `modeKeys` is EMPTY in
    // sweep mode, so every sweep-mode record below keeps its exact current key
    // set and spelling; `commitCursor` is the single VERIFIED-only cursor write
    // step (7) performs, pointed at whichever cursor this mode owns.
    let sweepSize = null;
    let bytesBehind = null;
    let offsetBefore = 0;
    let selfHealed = false;
    let ids;
    let newOffset;
    let skippedMalformed = 0;
    let backlog;
    let modeKeys = {};
    let commitCursor;

    if (ledgerMode) {
      // (3L)-(4L) LEDGER WORK SET — derived, not read from a queue. The whole
      // derivation lives in mcp/lib/recall/embed-work-set.js; this seam only
      // chooses it and turns its refusals into a loud record. Nothing is
      // measured a second time here.
      let storedOffset = null;
      let derived = null;
      try {
        const stored = readWorkSetCursor(workSetCursorPath);
        storedOffset = stored.offset;
        const exclusions = readWorkSetExclusions({ hnswMetaPath, modelVersion });
        derived = deriveWorkSetBatch({
          ledgerPath,
          cursor: stored.offset,
          batch,
          excludeIds: exclusions.excludeIds,
          pin: stored.pin,
        });
      } catch (err) {
        // ABSENCE IS NEVER A VERDICT: an underivable work set is a REFUSAL with
        // a stable code and a FROZEN cursor — never `nothing-to-drain`, never
        // an empty batch, never a zero that reads as health. Repair is not
        // called and no cursor is written on this path.
        const code = err && typeof err.code === "string" ? err.code : "work_set_unexpected_error";
        appendLog(logPath, {
          ...base(),
          reason: "work-set-unmeasurable",
          offset_before: storedOffset,
          offset_after: storedOffset,
          sweep_size: null,
          bytes_behind: null,
          work_set_mode: "ledger",
          ledger_cursor_before: storedOffset,
          ledger_cursor_after: storedOffset,
          rows_scanned: null,
          candidates: null,
          duplicate_rows: null,
          derive_ms: null,
          work_set_error_code: code,
          detail: err && err.message ? String(err.message).slice(0, 500) : null,
        });
        return {
          exitCode: 1, reason: "work-set-unmeasurable", offsetBefore: storedOffset,
          offsetAfter: storedOffset, drained: 0, skippedMalformed: 0, failed: 0,
          sweepSize: null, bytesBehind: null, workSetMode: "ledger", workSetErrorCode: code,
        };
      }

      offsetBefore = derived.fromOffset;
      newOffset = derived.nextOffset;
      ids = derived.ids;
      backlog = { sweep_size: null, bytes_behind: null };
      modeKeys = {
        work_set_mode: "ledger",
        ledger_cursor_before: derived.fromOffset,
        ledger_cursor_after: derived.nextOffset,
        rows_scanned: derived.rowsScanned,
        candidates: derived.candidateRows,
        // SURFACED, not merely returned. `duplicateRows` is the counter that
        // distinguishes "this window held N facts" from "this window held N
        // rows"; before it reached the log the re-append case that froze the
        // cursor forever was invisible to the operator reading these records.
        // Sweep-mode records are untouched: `modeKeys` is `{}` there.
        duplicate_rows: derived.duplicateRows,
        derive_ms: derived.deriveMs,
      };
      commitCursor = () => {
        writeWorkSetCursor(workSetCursorPath, { offset: newOffset, pin: derived.nextPin });
      };

      if (ids.length === 0) {
        // MEASURED empty, not an unmeasured one: the window really was walked
        // (rows_scanned / reached_eof say how far) and it contained no
        // candidate. The cursor is NOT advanced — it advances only on a
        // parent-measured VERIFIED work proof, and inventing a proof-free
        // advance here would be the one door through which this mode could
        // skip a row. Deliberately its own spelling: `nothing-to-drain` is a
        // SWEEP-mode reason and stays one.
        // RESIDUAL, stated rather than hidden: this is the ONE ledger-mode path
        // whose cost is bounded by the distance to eof rather than by `batch`,
        // because a walk that found no candidate necessarily read to the head
        // pin. It is reached only once the derivation has drained everything
        // ahead of the cursor; deciding what should advance then (and whether
        // this mode keeps a cursor at all) belongs to e3/e4, not here.
        appendLog(logPath, {
          ...base(),
          reason: "nothing-to-derive",
          offset_before: offsetBefore,
          offset_after: offsetBefore,
          ...backlog,
          ...modeKeys,
          ledger_cursor_after: offsetBefore,
          reached_eof: derived.reachedEof,
          excluded: derived.excluded,
        });
        return {
          exitCode: 0, reason: "nothing-to-derive", offsetBefore, offsetAfter: offsetBefore,
          drained: 0, skippedMalformed: 0, failed: 0, sweepSize: null, bytesBehind: null,
          workSetMode: "ledger", rowsScanned: derived.rowsScanned,
          candidates: derived.candidateRows, deriveMs: derived.deriveMs,
        };
      }
    } else {
    // (3) Cursor + self-heal (offset > current sweep size -> 0, the
    // _agg-checkpoint idiom; a truncated-and-regrown or replaced sweep can
    // only over-read from 0, never crash).
    sweepSize = 0;
    try { sweepSize = statSync(sweepPath).size; } catch { sweepSize = 0; }
    offsetBefore = readCursorOffset(cursorPath);
    if (offsetBefore > sweepSize) {
      offsetBefore = 0;
      selfHealed = true;
    }
    // Computed AFTER the self-heal so bytes_behind can never be negative and
    // always matches the offset_before the same record reports.
    bytesBehind = sweepSize - offsetBefore;
    backlog = { sweep_size: sweepSize, bytes_behind: bytesBehind };
    commitCursor = () => { writeCursorOffset(cursorPath, newOffset); };

    if (sweepSize === 0 || offsetBefore >= sweepSize) {
      appendLog(logPath, {
        ...base(),
        reason: "nothing-to-drain",
        offset_before: offsetBefore,
        offset_after: offsetBefore,
        ...backlog,
        self_healed: selfHealed,
      });
      return { exitCode: 0, reason: "nothing-to-drain", offsetBefore, offsetAfter: offsetBefore, drained: 0, skippedMalformed: 0, failed: 0, sweepSize, bytesBehind };
    }

    // (4) Collect up to `batch` DISTINCT fact_ids; malformed lines are
    // skipped + logged but their bytes count toward the candidate offset.
    const malformedEvents = [];
    const collected = await collectBatch({
      sweepPath,
      startOffset: offsetBefore,
      batch,
      onMalformed: (ev) => {
        malformedEvents.push(ev);
        appendLog(logPath, { ts: nowIsoOf(now), event: "malformed-line", ...ev });
      },
    });
    ids = collected.ids;
    newOffset = collected.newOffset;
    skippedMalformed = collected.skippedMalformed;

    if (ids.length === 0) {
      // Only blank/malformed bytes in the window: persist the advance so a
      // bad region is never re-scanned forever, but call no repair.
      if (newOffset > offsetBefore) writeCursorOffset(cursorPath, newOffset);
      appendLog(logPath, {
        ...base(),
        reason: "no-valid-rows",
        offset_before: offsetBefore,
        offset_after: newOffset,
        skipped_malformed: skippedMalformed,
        ...backlog,
        self_healed: selfHealed,
      });
      return { exitCode: 0, reason: "no-valid-rows", offsetBefore, offsetAfter: newOffset, drained: 0, skippedMalformed, failed: 0, sweepSize, bytesBehind };
    }
    } // end sweep mode. Its body is deliberately left at its original
      // indentation so the diff shows the wrapping and nothing else: not one
      // sweep-mode statement, record key or reason spelling changed here.

    // (5) Repair via the proven script (or the injected fake).
    // The sidecar size is captured with ONE statSync immediately before the
    // repair: everything appended past this offset is attributable to this
    // batch. A missing/unstattable sidecar leaves it null, which
    // measureBatchWork reads as UNMEASURABLE — never as zero.
    let sidecarSizeBefore = null;
    try { sidecarSizeBefore = statSync(sidecarPath).size; } catch { sidecarSizeBefore = null; }

    let repairResult;
    try {
      repairResult = await repair(ids);
    } catch (err) {
      repairResult = { ok: false, exitCode: null, detail: String((err && err.message) || err) };
    }
    const repairOk = repairResult === true || (repairResult && repairResult.ok === true);

    // (6) Cursor advances ONLY on repair success; on failure leave it
    // untouched and exit 1 (redo is idempotent — child loadDoneIds skips
    // already-embedded ids).
    if (!repairOk) {
      appendLog(logPath, {
        ...base(),
        reason: "repair-failed",
        offset_before: offsetBefore,
        offset_after: offsetBefore,
        skipped_malformed: skippedMalformed,
        failed: ids.length,
        ...backlog,
        ...modeKeys,
        // Kill attribution, so the next occurrence is self-diagnosing. Absent
        // when the repair was injected (tests) rather than spawned.
        ...repairAttribution(repairResult),
        detail: repairResult && repairResult.detail ? String(repairResult.detail).slice(0, 500) : null,
      });
      return { exitCode: 1, reason: "repair-failed", offsetBefore, offsetAfter: offsetBefore, drained: 0, skippedMalformed, failed: ids.length, sweepSize, bytesBehind };
    }

    // (7) R6 WORK PROOF — the child returned success; now MEASURE it.
    //
    // One rule, so a log census stays checkable: `vectors_written` and
    // `work_evidence` appear on exactly the three records that reached this
    // step and nowhere else (the five pre-proof reasons — lock-contention,
    // server-down, nothing-to-drain, no-valid-rows, repair-failed — keep their
    // exact pre-R6 key sets). `unproven` appears on exactly the two refusal
    // records, because a verified record has nothing unproven by construction.
    let proof;
    try {
      proof = await measureBatchWork({ sidecarPath, sizeBefore: sidecarSizeBefore, ids });
    } catch {
      // The proof path must never throw on the hot path: an unexpected failure
      // is UNMEASURABLE, which refuses safely rather than crashing a live drain.
      proof = { measurable: false, sizeAfter: null, matched: 0, matchedIds: [], unmatchedCount: ids.length };
    }
    const childEvidence =
      repairResult && typeof repairResult === "object" && repairResult.child_work_evidence
        ? repairResult.child_work_evidence
        : null;

    let verdict = classifyWorkProof({
      idsCount: ids.length,
      matched: proof.matched,
      measurable: proof.measurable,
      childEvidence,
    });
    // `vectors_written` counts NEW writes in this run's tail — the full scan
    // below proves PRE-EXISTING vectors and can never raise this number.
    const vectorsWritten = verdict.verdict === WORK_VERDICT.UNMEASURABLE ? null : proof.matched;
    const tailMatched = new Set(proof.matchedIds);
    let unmatchedIds = ids.filter((id) => !tailMatched.has(id));

    // FULL-SCAN ROUTE: the tail could not answer the question this verdict
    // actually raises — either the child reported nothing left to do (its word,
    // never proof), or the tail came up short. Replace both with the same
    // parent-side measurement over the WHOLE file: a full sidecar scan with
    // early exit, measured affordable in scanSidecarForIds' header.
    // REVERTED 2026-08-18 by the orchestrator. r6 round 2 widened this route
    // to include TAIL_SHORTFALL. That is UNSAFE: scanSidecarForIds answers
    // "does ANY line whose id strips to this fact exist?" — chunk PRESENCE,
    // not chunk COMPLETENESS. The CHILD_ALREADY_EMBEDDED route is safe on that
    // looseness only because it requires pending === 0, i.e. every batch id
    // already passed the child's bare-id done-filter and therefore has a BARE
    // line; the chunk-stripping superset never decides anything there.
    // TAIL_SHORTFALL is reached only when pending > 0 — the child positively
    // asserting work remained — so routing it here dropped the corroborating
    // condition while keeping the loose matcher. Measured consequence: a fact
    // chunked into five with only `${id}#0` on disk MATCHES, the cursor
    // ADVANCES, and the remaining four chunks are permanently skipped.
    // A silent permanent skip is worse than the visible stall it replaced,
    // so the stall is restored until a completeness check exists (r6-4).
    // E3 2026-09: that check now exists in the CHILD (planEmbedItems ->
    // `pending after item-level resume`); this route stays narrow because the
    // parent still cannot measure completeness.
    if (verdict.work_evidence === WORK_EVIDENCE.CHILD_ALREADY_EMBEDDED) {
      let scan = null;
      try { scan = await scanSidecarForIds({ sidecarPath, ids }); } catch { scan = null; }
      if (!scan || scan.measurable !== true) {
        // An unmeasurable scan may only take away evidence we did not already
        // hold. On the CHILD_ALREADY_EMBEDDED route the tail measured zero and
        // the child's word was the only evidence, so UNMEASURABLE is the honest
        // answer. On the TAIL_SHORTFALL route we ALREADY MEASURED a shortfall:
        // relabelling it would report LESS than we know and null out a
        // vectors_written we actually counted. Keep the measured verdict — it
        // refuses either way, so no batch is advanced on weaker evidence.
        verdict = { verdict: WORK_VERDICT.UNMEASURABLE, work_evidence: WORK_EVIDENCE.UNMEASURABLE };
      } else if (scan.matched === ids.length) {
        verdict = { verdict: WORK_VERDICT.VERIFIED, work_evidence: WORK_EVIDENCE.FULL_SCAN };
        unmatchedIds = [];
      } else {
        // An id in this batch has NO vector anywhere in the sidecar, in any
        // form. A measured negative, not a redo — and the authoritative one,
        // so it supersedes whichever label routed us here.
        verdict = { verdict: WORK_VERDICT.UNPROVEN, work_evidence: WORK_EVIDENCE.FULL_SCAN_SHORTFALL };
        const scanned = new Set(scan.matchedIds);
        unmatchedIds = ids.filter((id) => !scanned.has(id));
      }
    }

    // UNMEASURABLE — F72: absence is never a verdict. Cursor NOT written, and
    // the count goes nowhere near `failed` (the child may well have succeeded).
    if (verdict.verdict === WORK_VERDICT.UNMEASURABLE) {
      appendLog(logPath, {
        ...base(),
        reason: "work-unmeasurable",
        offset_before: offsetBefore,
        offset_after: offsetBefore,
        skipped_malformed: skippedMalformed,
        ...backlog,
        ...modeKeys,
        self_healed: selfHealed,
        vectors_written: null,
        work_evidence: verdict.work_evidence,
        unproven: null,
        sidecar_path: sidecarPath,
        sidecar_size_before: sidecarSizeBefore,
        sidecar_size_after: proof.sizeAfter,
        ...repairAttribution(repairResult),
      });
      return { exitCode: 1, reason: "work-unmeasurable", offsetBefore, offsetAfter: offsetBefore, drained: 0, skippedMalformed, failed: 0, sweepSize, bytesBehind, vectorsWritten: null, workEvidence: verdict.work_evidence, unproven: null };
    }

    // UNPROVEN — measured, and the measurement says the work is not there.
    if (verdict.verdict === WORK_VERDICT.UNPROVEN) {
      appendLog(logPath, {
        ...base(),
        reason: "repair-no-work",
        offset_before: offsetBefore,
        offset_after: offsetBefore,
        skipped_malformed: skippedMalformed,
        ...backlog,
        ...modeKeys,
        self_healed: selfHealed,
        vectors_written: vectorsWritten,
        work_evidence: verdict.work_evidence,
        unproven: unmatchedIds.length,
        unproven_sample: unmatchedIds.slice(0, UNPROVEN_SAMPLE_MAX),
        ...repairAttribution(repairResult),
      });
      return { exitCode: 1, reason: "repair-no-work", offsetBefore, offsetAfter: offsetBefore, drained: 0, skippedMalformed, failed: 0, sweepSize, bytesBehind, vectorsWritten, workEvidence: verdict.work_evidence, unproven: unmatchedIds.length };
    }

    // VERIFIED — unchanged pre-R6 behaviour, plus the two additive proof keys.
    // `commitCursor` is the sweep-mode `writeCursorOffset(cursorPath, newOffset)`
    // verbatim, or the ledger mode's {v, offset, pin} write through that SAME
    // atomic writer. It is still reached on VERIFIED and nowhere else.
    commitCursor();
    appendLog(logPath, {
      ...base(),
      reason: "drained",
      offset_before: offsetBefore,
      offset_after: newOffset,
      drained: ids.length,
      skipped_malformed: skippedMalformed,
      ...backlog,
      ...modeKeys,
      self_healed: selfHealed,
      vectors_written: vectorsWritten,
      work_evidence: verdict.work_evidence,
    });
    return { exitCode: 0, reason: "drained", offsetBefore, offsetAfter: newOffset, drained: ids.length, skippedMalformed, failed: 0, sweepSize, bytesBehind, vectorsWritten, workEvidence: verdict.work_evidence, unproven: null };
  } finally {
    releaseLock(lockPath);
  }
}

// ---------------------------------------------------------------------------
// CLI entry — auto-run only when invoked directly (the
// reembed-local-4096.mjs:519-525 idiom), so tests can import runDrain
// without firing a drain.
// ---------------------------------------------------------------------------

// Main-module check that survives spaces and symlinks in the invocation path:
// compare real filesystem paths, never a hand-built file:// string.
const INVOKED_DIRECTLY = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (INVOKED_DIRECTLY) {
  runDrain()
    .then((res) => {
      process.stderr.write(
        // R6 appends its tokens AFTER the existing ones, preserving their order
        // and spelling exactly — an operator string must not change shape under
        // a change that could not see it. Pre-proof reasons print null (they
        // never reached the proof step), never a fabricated 0.
        `reembed-drain: ${res.reason} drained=${res.drained} failed=${res.failed}` +
        ` sweep_size=${res.sweepSize} bytes_behind=${res.bytesBehind}` +
        ` vectors_written=${res.vectorsWritten ?? null} work_evidence=${res.workEvidence ?? null}\n`,
      );
      process.exit(res.exitCode);
    })
    .catch((e) => {
      process.stderr.write(`reembed-drain FATAL: ${e && e.message}\n`);
      process.exit(1);
    });
}
