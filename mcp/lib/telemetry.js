// L3 bounded per-call telemetry. One content-free NDJSON line per executeTool
// call, written fire-and-forget to <MEMORY_ROOT>/telemetry/telemetry.ndjson
// (size-rotated, active + one ".1" sibling, exactly 2 files).
//
// HARD RULES (see nodes/L3 spec):
//   - NOTHING sync, NOTHING awaited, NO fsync on the request path. The only
//     request-path cost is clock reads, process.memoryUsage.rss(), object
//     build, and an in-memory enqueue. Do NOT reproduce the
//     recall-log.js appendRecallEvent sync-fsync anti-pattern here.
//   - NO message content, platform tokens, query text, or free-text error
//     strings in any emitted field. Enforced STRUCTURALLY by the annotate()
//     allowlist + slug regexes — slugs and numbers only.
//   - No process lifecycle handlers (exit/SIGTERM are node L1's territory;
//     lost tail lines on hard exit are acceptable by design). No timers that
//     keep the event loop alive (none are created at all — the write path is
//     a serialized promise chain).
//   - A telemetry failure can never fail, slow, or alter a tool call: every
//     link of the write chain is .catch'ed; overflow/write errors are
//     drop-and-count, surfaced as dropped_since_last on the next good line.
//
// Line schema (ONLY these keys; optionals omitted when absent):
//   { ts, tool, total_ms, ok, degraded_reason?, cold_start?, bytes_scanned?,
//     stage_ms?, rss_delta_kb, pid, corr_id, dropped_since_last? }

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";

import { TELEMETRY_DIR, telemetryPath } from "./config.js";

const als = new AsyncLocalStorage();

// Rotation cap for the active file. Read once at module init (tests pin the
// env var before their dynamic import). Default 32 MiB — the watermark
// daemon's 81.8MB unrotated stderr log is the standing counterexample that
// makes rotation a hard requirement.
const MAX_BYTES = (() => {
  const n = Number(process.env.TELEMETRY_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 32 * 1024 * 1024;
})();

// Bounded pending-line budget: when the serialized write chain has this many
// lines in flight, new lines are dropped-and-counted instead of growing heap.
// Env-overridable (tests), same pattern as MAX_BYTES above.
const MAX_PENDING = (() => {
  const n = Number(process.env.TELEMETRY_MAX_PENDING);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1024;
})();

// Byte twin of MAX_PENDING (L3b defect 3): a count-only bound still lets a
// stalled writer pin ~unbounded heap if lines are large. Default 1 MiB.
const MAX_PENDING_BYTES = (() => {
  const n = Number(process.env.TELEMETRY_MAX_PENDING_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1024 * 1024;
})();

// Re-anchor the in-memory size accumulator with a real stat() every N
// appends — other server processes append to the same file, so the local
// accumulator alone would under-count and defer rotation forever.
const STAT_EVERY = 64;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let coldStartPending = true; // latch: first emitted line gets cold_start:true
let emitted = 0; // lines successfully appended
let dropped = 0; // lines lost (queue overflow or write failure)
let droppedSinceLast = 0; // drops not yet surfaced on a successful line
let pendingCount = 0; // lines currently in the write chain
let pendingBytes = 0; // estimated serialized bytes currently in the write chain
let dirEnsured = false; // mkdir-recursive latch (reset on write failure)
let approxSize = -1; // active-file size accumulator; -1 = unknown, stat next
let appendsSinceStat = 0;
let rotateFailures = 0; // non-ENOENT rename failures (never resets on success)
let rotateEscalated = false; // per-streak stderr latch; cleared on successful rotation
let writeChain = Promise.resolve(); // single serialized, unbreakable chain

// ---------------------------------------------------------------------------
// Request path (hot): withTelemetry + annotate. No I/O of any kind here.
// ---------------------------------------------------------------------------

/**
 * Run `fn` inside a per-call telemetry context, then emit exactly one NDJSON
 * line. `fn`'s result (or throw) passes through untouched — a throw still
 * emits (ok:false) and rethrows, so dispatch's catch semantics are unchanged.
 */
export async function withTelemetry(toolName, fn) {
  const ctx = { corr_id: randomUUID(), annotations: {} };
  const t0 = performance.now();
  const rss0 = process.memoryUsage.rss(); // cheap accessor, NOT memoryUsage()
  let result;
  let threw = false;
  let thrown;
  try {
    result = await als.run(ctx, fn);
  } catch (e) {
    threw = true;
    thrown = e;
  }
  const totalMs = Math.round(performance.now() - t0);
  const rssDeltaKb = Math.round((process.memoryUsage.rss() - rss0) / 1024);

  const a = ctx.annotations;
  const line = {
    ts: new Date().toISOString(),
    // Clamp at emit (L3b defect 2): executeTool's `name` comes from the MCP
    // client and reaches this line raw on the NOT_FOUND path — an arbitrary
    // string must never hit disk. Slug charset + length only.
    tool:
      typeof toolName === "string" && TOOL_NAME_RE.test(toolName)
        ? toolName
        : "invalid_tool_name",
    total_ms: totalMs,
    // ok derives from the returned envelope's .ok (envelope.js); a thrown fn
    // counts as ok:false. Never re-classify beyond the boolean.
    ok: !threw && result != null && result.ok === true,
  };
  if (a.degraded_reason !== undefined) line.degraded_reason = a.degraded_reason;
  if (coldStartPending || a.cold_start === true) line.cold_start = true;
  coldStartPending = false;
  if (a.bytes_scanned !== undefined) line.bytes_scanned = a.bytes_scanned;
  if (a.stage_ms !== undefined) line.stage_ms = a.stage_ms;
  line.rss_delta_kb = rssDeltaKb;
  line.pid = process.pid;
  line.corr_id = ctx.corr_id;

  enqueue(line); // fire-and-forget: never awaited, never throws

  if (threw) throw thrown;
  return result;
}

const SLUG_RE = /^[a-z0-9_.:-]{1,64}$/;
const STAGE_KEY_RE = /^[a-z0-9_]{1,32}$/;
// Tool names allow uppercase (MCP convention permits it) but stay slug-shaped.
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Merge ALLOWLISTED fields into the current call's telemetry line. Silent
 * no-op outside any withTelemetry context; never throws. Unknown keys and
 * invalid values are silently dropped — the allowlist is the structural
 * content-leak barrier (slugs and numbers only, no free text can pass).
 */
export function annotate(fields) {
  try {
    const store = als.getStore();
    if (!store || fields == null || typeof fields !== "object") return;
    const a = store.annotations;
    if (
      typeof fields.bytes_scanned === "number" &&
      Number.isFinite(fields.bytes_scanned)
    ) {
      a.bytes_scanned = fields.bytes_scanned;
    }
    if (typeof fields.cold_start === "boolean") {
      a.cold_start = fields.cold_start;
    }
    if (
      typeof fields.degraded_reason === "string" &&
      SLUG_RE.test(fields.degraded_reason)
    ) {
      a.degraded_reason = fields.degraded_reason;
    }
    if (
      fields.stage_ms != null &&
      typeof fields.stage_ms === "object" &&
      !Array.isArray(fields.stage_ms)
    ) {
      for (const [k, v] of Object.entries(fields.stage_ms)) {
        if (STAGE_KEY_RE.test(k) && typeof v === "number" && Number.isFinite(v)) {
          if (a.stage_ms === undefined) a.stage_ms = {};
          a.stage_ms[k] = v;
        }
      }
    }
  } catch {
    // annotate must never throw.
  }
}

// ---------------------------------------------------------------------------
// Write path (cold): serialized async chain, all-async fs, drop-and-count.
// ---------------------------------------------------------------------------

function enqueue(line) {
  // Byte estimate for the queue bound (double-stringify vs writeOne is
  // microseconds; the case-f overhead gate polices it). +1 for the newline.
  const est = Buffer.byteLength(JSON.stringify(line)) + 1;
  if (pendingCount >= MAX_PENDING || pendingBytes + est > MAX_PENDING_BYTES) {
    dropped += 1;
    droppedSinceLast += 1;
    return;
  }
  pendingCount += 1;
  pendingBytes += est;
  // Every link is .catch'ed so one failure can never break the chain for
  // subsequent lines. writeOne itself never rejects; belt and suspenders.
  writeChain = writeChain
    .then(() => writeOne(line))
    .catch(() => {})
    .finally(() => {
      pendingCount -= 1;
      pendingBytes -= est;
    });
}

async function writeOne(line) {
  try {
    if (droppedSinceLast > 0) line.dropped_since_last = droppedSinceLast;
    const text = JSON.stringify(line) + "\n";
    const bytes = Buffer.byteLength(text);

    if (!dirEnsured) {
      await fsp.mkdir(TELEMETRY_DIR, { recursive: true });
      dirEnsured = true;
    }
    if (approxSize < 0 || appendsSinceStat >= STAT_EVERY) {
      try {
        approxSize = (await fsp.stat(telemetryPath())).size;
      } catch {
        approxSize = 0; // no active file yet
      }
      appendsSinceStat = 0;
    }
    if (approxSize >= MAX_BYTES) {
      // Keep exactly 2 files: rename active -> .1, clobbering any prior .1.
      // Errno-aware (L3b defect 1): ENOENT is benign (a concurrent rotator
      // won the race); any other errno increments rotate_failures, escalates
      // to stderr ONCE per failure streak (errno slug only — never message
      // text or paths), and leaves approxSize=-1 so the next writeOne
      // re-stats, sees over-cap, and retries the rename — rotation is never
      // permanently disabled. The append below still proceeds either way:
      // losing lines because rotation failed is worse than a temporarily
      // oversized file.
      try {
        await fsp.rename(telemetryPath(), telemetryPath() + ".1");
        approxSize = 0;
        rotateEscalated = false; // streak over; a new streak escalates again
      } catch (e) {
        if (e && e.code === "ENOENT") {
          approxSize = 0;
        } else {
          rotateFailures += 1;
          if (!rotateEscalated) {
            rotateEscalated = true;
            try {
              process.stderr.write(
                `[telemetry] rotation failed code=${(e && e.code) || "unknown"} retrying-each-flush\n`,
              );
            } catch {}
          }
          approxSize = -1; // re-stat + retry the rename on every flush
        }
      }
    }
    await fsp.appendFile(telemetryPath(), text);
    // Keep -1 sticky after a failed rotation so the retry path re-stats.
    if (approxSize >= 0) approxSize += bytes;
    appendsSinceStat += 1;
    emitted += 1;
    if (line.dropped_since_last) {
      // Only subtract what this line actually reported — drops that landed
      // while this append was in flight stay pending for the next line.
      droppedSinceLast -= line.dropped_since_last;
    }
  } catch {
    dropped += 1;
    droppedSinceLast += 1;
    dirEnsured = false; // dir may have vanished; retry mkdir next time
    approxSize = -1; // size cache is untrustworthy; re-stat next time
  }
}

// ---------------------------------------------------------------------------
// Test-only exports (underscore-prefixed; not for production callers).
// ---------------------------------------------------------------------------

/** Test-only: resolves when every line enqueued so far has been settled. */
export function _flushTelemetry() {
  return writeChain.then(() => undefined);
}

/** Test-only: running counters. */
export function _telemetryStats() {
  return { emitted, dropped, rotate_failures: rotateFailures };
}

