// thread-aggregator.js — Wave 12 BEHAVIOR tier.
// (F-SYN-BEHAVIOR-thread-aggregation)
//
// Authoritative spec:
//   - docs/specs/synthesis/reconstructed-trigger.md § AM4 (daemon path) +
//     § M5 (daemon-path wiring) + § O4 (admission gates owned by this node)
//   - W8 § S5 idempotency-key fix:
//       sha256(canonical_json({domain:"daemon", aggregator_name, bucket_key,
//                              content_hash}))
//     The emitter computes this from input.aggregator_name + input.bucket_key
//     + sha256(input.content) — this module merely supplies those fields.
//
// PURPOSE:
//   Daemon-side aggregator that groups N atomic facts by:
//     - iMessage : {chat_identifier, day-bucket}
//     - git-log  : {repo_path, author_email, day-bucket}
//     - other    : {source, conversation_id, day-bucket}  (best-effort)
//   and emits ONE reconstructed event per qualifying thread via
//   emitReconstruction({mode:"daemon"}). This collapses N atomic facts into
//   a coherent synthesized memory.
//
// HOT PATH DISCIPLINE:
//   - Defensive try/catch on every emitter call; an emit failure logs and
//     continues. The daemon's idle tick MUST NOT crash on a malformed parent
//     row or an emitter validation reject.
//   - One ledger scan per invocation; threads are built in memory then
//     emitted serially.
//
// CONTRACT:
//   aggregateThreads({ledgerPath, sinceMs, now?, sourcesFilter?, emitterCtx?})
//     → {threads_processed, reconstructed_emitted, errors}
//
//   - ledgerPath: required string; the memory ledger to scan + emit into.
//   - sinceMs: required number; only facts with ts >= (now - sinceMs) are
//     considered. Caller (watermark idle tick) passes 24h.
//   - now: optional Date | ISO string | epoch-ms (test injector); default
//     Date.now().
//   - sourcesFilter: optional Array<string>; when present, only facts whose
//     source matches are considered. Default: all known thread-bearing
//     sources (imessage, git-log, github-events, screentime, chat-claude-code).
//   - emitterCtx: optional object forwarded to emitReconstruction's ctx
//     (used by tests to inject `now` / `ulid` / `logger`). The ledgerPath
//     in emitterCtx is overridden with the caller's ledgerPath.

import { statSync } from "node:fs";
import {
  emitReconstruction,
  RECONSTRUCT_PARENTS_MAX,
} from "./reconstruction-emitter.js";
// INCREMENTAL-AGGREGATION (node THREAD, design.md §D-4). The CAPS flag
// INCREMENTAL_AGGREGATION_ENABLED (env MEMORY_INCREMENTAL_AGGREGATION_ENABLED=1,
// evaluated at module load, default OFF) gates the offset-checkpointed fold.
// Until WIRE lands the CAPS entry, CAPS.INCREMENTAL_AGGREGATION_ENABLED is
// undefined → resolveIncremental() defaults OFF (the required default). Tests
// pass an explicit `incremental` arg that OVERRIDES this (design.md §D-4.2).
import { CAPS } from "../validation.js";
// WU-B1 — stream-filter ledger reads. The previous parseLedgerLines
// path did readFileSync("memory.jsonl") + split("\n") + JSON.parse on
// the full 308MB ledger every cascade tick (15s). Per-tick RSS impact:
// ~1.5GB string + ~0.6GB parsed graph that gets thrown away after the
// 24h time-window filter discards >99% of it. Streaming + filtering
// at parse time keeps only rows with ts >= (now - 24h) and kind="fact"
// in memory.
// WU-emitter-string-cap-fix — streamLedgerLines added so the legacy
// parseLedgerLines test-surface helper below no longer whole-file reads
// (see its comment for the class invariant).
import {
  streamLedgerLines,
  streamLedgerLinesWithOffset,
  streamLedgerRowsInTimeWindow,
  ledgerSizeOrZero,
} from "./_ledger-stream.js";
// CKPT primitive (design.md §D-3.4). READ-ONLY here: the flag-ON cold-start path
// resolves the persisted byte-offset checkpoint to run the self-heal predicate
// and expose resume_offset; the window-rescan is authoritative and the WIRE node
// owns the atomic write. Mirrors the sibling project-aggregator's cold-start read.
import { resolveStartOffset } from "./_agg-checkpoint.js";

// ---------------------------------------------------------------------------
// PUBLIC CONSTANTS
// ---------------------------------------------------------------------------

export const THREAD_AGGREGATOR_VERSION = "thread-aggregator@0.1.0";

export const THREAD_AGGREGATOR_CAPS = Object.freeze({
  // Daily time-window granularity (spec § S5 example: "...:day:<YYYY-MM-DD>").
  TIME_WINDOW_MS: 24 * 60 * 60 * 1000,
  // Admission gates (spec § O4 — owned by this behavior node).
  MIN_FACTS_PER_THREAD: 3,
  MAX_FACTS_PER_THREAD: 20,
  // Content summary cap. The first 500 chars of the concatenated thread
  // becomes the reconstructed.content. The emitter's
  // RECONSTRUCT_CONTENT_MAX_CHARS (16384) is far above; this is a
  // behavior-tier presentation choice.
  CONTENT_SUMMARY_MAX_CHARS: 500,
  // The aggregator_name field stamped into the S5 preimage. The agent_id
  // form is "daemon:thread-aggregator" — spec § AM4 line 88.
  AGGREGATOR_NAME: "daemon:thread-aggregator",
  // Default sources we attempt to thread. iMessage + git-log are the spec
  // examples; chat-claude-code is the watermark's bare-name conversational
  // source. Sources not in this list are silently skipped (their facts may
  // not carry the fields needed to build a stable thread key).
  THREAD_BEARING_SOURCES: Object.freeze([
    "imessage",
    "git-log",
    "github-events",
    "chat-claude-code",
  ]),
});

// ---------------------------------------------------------------------------
// INTERNAL: ledger scan
// ---------------------------------------------------------------------------

// parseLedgerLines — LEGACY helper, exported via __internal ONLY; nothing on
// the hot path calls it (the cascade tick uses streamLedgerRowsInTimeWindow
// above — that was the WU-B1 fix). Rebased onto the streamer as part of
// WU-emitter-string-cap-fix: the old body did readFileSync(ledgerPath,
// "utf8") of the WHOLE ledger, and Node/V8's max string is ~536,870,888
// bytes — memory.jsonl is past 1.8 GB, so a whole-file read throws
// ERR_STRING_TOO_LONG unconditionally (this exact class has now bitten this
// repo 7 times; the latest was the reconstruction emitter's
// PARENT_NOT_FOUND-forever incident). A silently-broken exported helper
// invites reuse, so it is streamed rather than left as a landmine.
// Torn-tail / malformed lines are skipped inside the streamer — same
// discipline as before.
function parseLedgerLines(ledgerPath) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) return [];
  const out = [];
  streamLedgerLines(ledgerPath, (row) => {
    out.push(row);
  });
  return out;
}

function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "string") return Date.parse(now);
  if (typeof now === "number" && Number.isFinite(now)) return now;
  return Date.now();
}

// FIX-1 (N7b) — resolve the row's effective timestamp. Source-ledger rows carry
// a top-level `ts`; promoted FACT rows carry `created_at` (the promoter only
// mirrors it onto `ts` when CASCADE_TS_MIRROR_ENABLED is on, which N7b does NOT
// depend on). This mirrors the already-tolerant stream filter in
// _ledger-stream.js (streamLedgerRowsInTimeWindow resolves row.ts || row.created_at).
// Without this, a production fact survives the stream window filter but is then
// silently dropped by the bucketer's ts-presence guard. Returns the ISO string
// (ts wins, then created_at) or null when neither is present.
function resolveRowTs(row) {
  if (row == null || typeof row !== "object") return null;
  if (typeof row.ts === "string" && row.ts.length > 0) return row.ts;
  if (typeof row.created_at === "string" && row.created_at.length > 0) {
    return row.created_at;
  }
  return null;
}

// UTC day bucket "YYYY-MM-DD" — deterministic, timezone-stable, matches the
// spec example "chat:<chat_identifier>:day:<YYYY-MM-DD>".
function dayBucket(tsIso) {
  if (typeof tsIso !== "string" || tsIso.length === 0) return "unknown";
  // Date.parse accepts the ISO-8601 the ledger writes (serverTs() output).
  const ms = Date.parse(tsIso);
  if (!Number.isFinite(ms)) return "unknown";
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

// ---------------------------------------------------------------------------
// INTERNAL: thread-key extraction
//
// Each thread-bearing source has its own identity convention. The aggregator
// reads the raw_content fields where they survive promotion; falls back to
// provenance.conversation_id; and returns null when no stable key can be
// derived (the fact is skipped).
//
// The returned `bucket_key` is the value the spec § S5 preimage hashes over;
// it MUST be deterministic across re-runs so idempotency holds.
// ---------------------------------------------------------------------------

function extractThreadKey(fact) {
  if (fact == null || typeof fact !== "object") return null;
  const src = typeof fact.source === "string" ? fact.source : null;
  if (src === null) return null;

  // ts for the day-bucket comes from the fact's primary ts (source-ledger
  // append ts) OR its created_at (promoted-fact field). FIX-1 (N7b).
  const day = dayBucket(resolveRowTs(fact));
  if (day === "unknown") return null;

  // raw_content survives on the fact row when the connector emitted it inside
  // source_refs[0] or as a sibling field. Tests + production both stamp the
  // raw_content under `raw_content` or under `source_refs[0].raw_content`;
  // the aggregator reads both and the first hit wins.
  const rc = readRawContent(fact);

  if (src === "imessage") {
    // Spec § S5 example: "chat:<chat_identifier>:day:<YYYY-MM-DD>".
    // WU-forward-conversation-stamp: live source-ledger rows carry
    // raw_content.chat_guid (not chat_identifier — that field is NULL on
    // production rows, per the forward-stamp grounding map). Keep
    // chat_identifier winning when present (legacy fixtures + future
    // backfills) and fall back to chat_guid before the parties/provenance
    // fallbacks so the forward stamp and the W12 reconstruction path produce
    // byte-identical bucket_keys.
    const chatId =
      (rc && typeof rc.chat_identifier === "string" && rc.chat_identifier) ||
      (rc && typeof rc.chat_guid === "string" && rc.chat_guid) ||
      (rc && Array.isArray(rc.parties) && rc.parties.length > 0
        ? rc.parties.slice().sort().join(",")
        : null) ||
      (typeof fact.provenance?.conversation_id === "string"
        ? fact.provenance.conversation_id
        : null);
    if (!chatId) return null;
    return {
      source: src,
      thread_id: chatId,
      day,
      bucket_key: `chat:${chatId}:day:${day}`,
    };
  }

  if (src === "whatsapp") {
    // WU-forward-conversation-stamp: WhatsApp source rows thread on
    // raw_content.session_jid (the chat/session handle). No legacy fixture
    // exercised a whatsapp branch (it fell through to the generic
    // conversation_id fallback, which whatsapp rows never carry), so this is
    // purely additive coverage. Group subjects / push-names were never
    // retained at source and are out of scope per the grounding plan.
    const sessionJid =
      (rc && typeof rc.session_jid === "string" && rc.session_jid) ||
      (rc && Array.isArray(rc.parties) && rc.parties.length > 0
        ? rc.parties.slice().sort().join(",")
        : null) ||
      (typeof fact.provenance?.conversation_id === "string"
        ? fact.provenance.conversation_id
        : null);
    if (!sessionJid) return null;
    return {
      source: src,
      thread_id: sessionJid,
      day,
      bucket_key: `chat:${sessionJid}:day:${day}`,
    };
  }

  if (src === "git-log" || src === "github-events") {
    // Spec § S5 example: "repo:<repo_root>:author:<email>:week:<isoweek>".
    // We use day-bucket (matching THREAD_AGGREGATOR_CAPS.TIME_WINDOW_MS = 24h)
    // for symmetry with iMessage. The bucket_key still encodes both repo +
    // author so cross-repo commits never collide.
    const repo =
      (rc && typeof rc.repo_path === "string" && rc.repo_path) ||
      (rc && typeof rc.repo === "string" && rc.repo) ||
      (rc && typeof rc.repo_name === "string" && rc.repo_name) ||
      null;
    const author =
      (rc && typeof rc.author_email === "string" && rc.author_email) ||
      (rc && typeof rc.author === "string" && rc.author) ||
      null;
    if (!repo || !author) return null;
    return {
      source: src,
      thread_id: `${repo}::${author}`,
      day,
      bucket_key: `repo:${repo}:author:${author}:day:${day}`,
    };
  }

  // Generic fallback for any other thread-bearing source: conversation_id +
  // day bucket. The watermark's chat-claude-code source threads on
  // provenance.conversation_id.
  const convId =
    (typeof fact.provenance?.conversation_id === "string"
      ? fact.provenance.conversation_id
      : null) ||
    (rc && typeof rc.conversation_id === "string" ? rc.conversation_id : null);
  if (!convId) return null;
  return {
    source: src,
    thread_id: convId,
    day,
    bucket_key: `${src}:${convId}:day:${day}`,
  };
}

function readRawContent(fact) {
  // Direct sibling field is the simplest case.
  if (fact.raw_content && typeof fact.raw_content === "object") {
    return fact.raw_content;
  }
  // Some pipelines stash it inside source_refs[0].
  if (Array.isArray(fact.source_refs) && fact.source_refs.length > 0) {
    const ref0 = fact.source_refs[0];
    if (ref0 && typeof ref0 === "object" && ref0.raw_content && typeof ref0.raw_content === "object") {
      return ref0.raw_content;
    }
  }
  if (fact.features && typeof fact.features === "object") {
    // features.raw_content is a fallback some test fixtures use.
    const rc = fact.features.raw_content;
    if (rc && typeof rc === "object") return rc;
    // FIX-2 (N7b) — PRIMARY production path. The promoter (distill-promote-
    // fact.js, CASCADE_THREAD_KEYS_ENABLED) STRIPS raw_content from the fact
    // row (PII/body) and forwards ONLY the closed identity subset onto
    // features.thread_keys: {chat_guid, chat_identifier, repo_path,
    // author_email, actor_login, repo, conversation_id}. Those are exactly the
    // fields extractThreadKey reads off `rc`, so a production fact with
    // thread_keys (but no raw_content) resolves a stable bucket_key here. This
    // is the identity-forwarding integration A stamps for NEW facts; read it
    // AFTER raw_content / source_refs so legacy fixtures are unaffected.
    const tk = fact.features.thread_keys;
    if (tk && typeof tk === "object" && !Array.isArray(tk)) return tk;
  }
  return null;
}

// ---------------------------------------------------------------------------
// INTERNAL: thread bucketing
// ---------------------------------------------------------------------------

function buildThreads(rows, { minTs, sourcesFilter }) {
  const filterSet = sourcesFilter instanceof Set
    ? sourcesFilter
    : Array.isArray(sourcesFilter) && sourcesFilter.length > 0
      ? new Set(sourcesFilter)
      : null;
  const threads = new Map(); // bucket_key -> {source, bucket_key, facts:[{id,ts,content}]}
  for (const row of rows) {
    if (row == null || typeof row !== "object") continue;
    if (row.kind !== "fact") continue;
    if (typeof row.id !== "string" || row.id.length === 0) continue;
    if (typeof row.content !== "string" || row.content.length === 0) continue;
    // FIX-1 (N7b) — accept ts (source-ledger rows) OR created_at (promoted
    // facts). Mirrors _ledger-stream.js's window filter so a fact that
    // survived the stream is not silently dropped here. The resolved value
    // feeds both the in-window check and the day-bucket derivation.
    const rowTs = resolveRowTs(row);
    if (rowTs === null) continue;
    const factMs = Date.parse(rowTs);
    if (!Number.isFinite(factMs)) continue;
    if (factMs < minTs) continue;
    const src = typeof row.source === "string" ? row.source : null;
    if (filterSet !== null && (src === null || !filterSet.has(src))) continue;

    let key;
    try {
      key = extractThreadKey(row);
    } catch {
      key = null;
    }
    if (key === null) continue;

    let bucket = threads.get(key.bucket_key);
    if (bucket === undefined) {
      bucket = {
        source: key.source,
        thread_id: key.thread_id,
        bucket_key: key.bucket_key,
        day: key.day,
        facts: [],
      };
      threads.set(key.bucket_key, bucket);
    }
    bucket.facts.push({
      id: row.id,
      ts: rowTs,
      content: row.content,
    });
  }
  return threads;
}

// Stable content-summary builder. Sorts facts by ts then id for determinism
// (idempotency depends on the content hash being stable across re-runs).
function buildSummary(thread, capChars) {
  const sorted = thread.facts
    .slice()
    .sort((a, b) => {
      if (a.ts < b.ts) return -1;
      if (a.ts > b.ts) return 1;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
  const pieces = [];
  for (const f of sorted) {
    pieces.push(f.content);
  }
  const joined = pieces.join("\n");
  if (joined.length <= capChars) return joined;
  return joined.slice(0, capChars);
}

// ---------------------------------------------------------------------------
// INCREMENTAL AGGREGATION (design.md §D-3/§D-4) — offset-checkpointed fold.
//
// Flag-OFF (default): aggregateThreads keeps the exact full-ledger-rescan path
// (streamLedgerRowsInTimeWindow -> buildThreads -> emitThreadBuckets). Flag-ON:
// a MODULE-LEVEL running state keyed by ledgerPath folds only the bytes
// appended since the checkpoint offset into a windowed day-bucket state, evicts
// facts that have aged out of the sliding 24h window (every run, per-fact by
// factMs — NOT by UTC-day bucket, design.md §D-3.3), and emits through the SAME
// shared driver so the emit INPUTS (and therefore the emitted reconstructed
// rows) are byte-identical to flag-OFF whenever the bucket maps are set-equal
// (the state-equality invariant, design.md §D-3.6).
// ---------------------------------------------------------------------------

// Module-level running state, keyed by ledgerPath. In-process only (design.md
// §D-1.2: bucket state is NEVER serialized — a cold start rebuilds it via a
// bounded window-rescan, which is provably equal to a full window scan at the
// same `now`). Shape:
//   { offset:number, ino:number|null,
//     buckets: Map<bucket_key, { source, thread_id, bucket_key, day,
//                                facts: Map<fact_id, {id, ts, content, factMs}> }> }
const _incrementalStateByPath = new Map();

// resolveIncremental — explicit `incremental` arg wins (tests drive both paths
// in one process without env juggling); else the env-at-load CAPS flag decides
// (design.md §D-4.2). Undefined CAPS entry (WIRE not yet landed) → OFF.
function resolveIncremental(argValue) {
  if (typeof argValue === "boolean") return argValue;
  return CAPS.INCREMENTAL_AGGREGATION_ENABLED === true;
}

// ledgerStat — size + inode for the cold-start / warm-run self-heal predicate
// (design.md §D-1.4). Missing/unreadable → {size:0, ino:null}; never throws.
function ledgerStat(path) {
  try {
    const st = statSync(path);
    return {
      size: Number.isFinite(st.size) ? st.size : 0,
      ino: Number.isFinite(st.ino) ? st.ino : null,
    };
  } catch {
    return { size: 0, ino: null };
  }
}

// coldBootstrapThreads — the ONE whole-ledger read per process lifetime
// (design.md §D-3.4). ONE-SIDED window rescan: pass Infinity as the ceiling so
// streamLedgerRowsInTimeWindow's upper bound (tsMs > nowMsCeil) NEVER fires and
// future-ts backfill/clock-skew rows survive into state (the future-ts hole —
// a two-sided bootstrap would permanently drop them since they sit before the
// cold-start offset=EOF). buildThreads applies ONLY the lower bound
// (factMs >= minTs). The [minTs, nowEpoch] CEILING is applied ONLY at emit
// (buildTransientEmitMap), symmetric to the warm fold. Offset := EOF.
function coldBootstrapThreads({ ledgerPath, minTs, effectiveFilter, ledgerSize, ledgerIno }) {
  let rows = [];
  try {
    const r = streamLedgerRowsInTimeWindow(ledgerPath, minTs, Infinity, {
      kind: "fact",
    });
    rows = r.rows;
  } catch {
    rows = [];
  }
  let threads;
  try {
    threads = buildThreads(rows, { minTs, sourcesFilter: effectiveFilter });
  } catch {
    threads = new Map();
  }
  const buckets = new Map();
  for (const b of threads.values()) {
    const factMap = new Map();
    for (const f of b.facts) {
      // f.ts is the resolved rowTs buildThreads parsed; Date.parse(f.ts) here
      // reproduces the SAME factMs the row's window gate used.
      factMap.set(f.id, {
        id: f.id,
        ts: f.ts,
        content: f.content,
        factMs: Date.parse(f.ts),
      });
    }
    buckets.set(b.bucket_key, {
      source: b.source,
      thread_id: b.thread_id,
      bucket_key: b.bucket_key,
      day: b.day,
      facts: factMap,
    });
  }
  return {
    offset: ledgerSize,
    ino: ledgerIno != null ? ledgerIno : null,
    buckets,
  };
}

// foldNewRows — warm-run incremental fold of [state.offset, EOF) (design.md
// §D-3.2). Reads ONLY the appended bytes via streamLedgerLinesWithOffset.
// Folds ONLY terminated lines (a torn mid-append line is neither folded nor
// passed) and applies the EXACT buildThreads per-row gate + a LOWER-BOUND-ONLY
// window guard (future-ts rows are RETAINED for a later run whose window reaches
// them). The safe resume offset advances past EVERY terminated line — including
// non-fact rows this run's own emit appended (design.md §X-2) — so they are
// never re-folded.
function foldNewRows({ state, ledgerPath, minTs, effectiveFilter }) {
  const filterSet =
    effectiveFilter instanceof Set
      ? effectiveFilter
      : Array.isArray(effectiveFilter) && effectiveFilter.length > 0
        ? new Set(effectiveFilter)
        : null;
  const startOffset = state.offset;
  let newOffset = startOffset;
  const counts = streamLedgerLinesWithOffset(
    ledgerPath,
    (text, byteOffset, byteLength, terminated) => {
      // Never fold a torn mid-append line, never advance past it (re-read next
      // run once its "\n" lands).
      if (terminated !== true) return;
      // Advance the safe resume offset past this terminated line BEFORE the
      // fact-gate filtering — so a terminated non-fact / malformed line still
      // advances the offset and is not re-scanned forever.
      const end = byteOffset + byteLength + 1;
      if (end > newOffset) newOffset = end;

      let row;
      try {
        row = JSON.parse(text);
      } catch {
        return;
      }
      if (row == null || typeof row !== "object") return;
      if (row.kind !== "fact") return;
      if (typeof row.id !== "string" || row.id.length === 0) return;
      if (typeof row.content !== "string" || row.content.length === 0) return;
      const rowTs = resolveRowTs(row);
      if (rowTs === null) return;
      const factMs = Date.parse(rowTs);
      if (!Number.isFinite(factMs)) return;
      const src = typeof row.source === "string" ? row.source : null;
      if (filterSet !== null && (src === null || !filterSet.has(src))) return;
      // LOWER-BOUND guard only. minTs increases monotonically across runs, so a
      // fact below it can never re-enter the window (safe to drop permanently).
      // The upper bound is NOT applied here (future-ts retained, §D-3.2).
      if (factMs < minTs) return;

      let key;
      try {
        key = extractThreadKey(row);
      } catch {
        key = null;
      }
      if (key === null) return;

      let bucket = state.buckets.get(key.bucket_key);
      if (bucket === undefined) {
        bucket = {
          source: key.source,
          thread_id: key.thread_id,
          bucket_key: key.bucket_key,
          day: key.day,
          facts: new Map(),
        };
        state.buckets.set(key.bucket_key, bucket);
      }
      // Keyed by id: a re-read terminated line cannot double-count; distinct
      // ids each fold once (matching buildThreads' one-push-per-line for the
      // real unique-id ledger).
      bucket.facts.set(row.id, { id: row.id, ts: rowTs, content: row.content, factMs });
    },
    { startOffset },
  );
  // Never regress the offset.
  state.offset = Math.max(startOffset, newOffset);
  // Bytes read this warm fold = [startOffset, EOF) (design.md §D-5.4 cost proof):
  // the streamer accumulates readSync byte counts from startOffset, so this is
  // the delta, NOT the whole ledger. Returned for the aggregator's envelope.
  return counts && Number.isFinite(counts.bytesScanned) ? counts.bytesScanned : 0;
}

// evictAgedFacts — EVERY run (including a re-run with ZERO new rows): drop
// per-fact by factMs < minTs, then drop now-empty buckets (design.md §D-3.3).
// This is what makes a no-new-append re-run stop re-emitting aged-out buckets
// and shrink still-live buckets. Per-fact (NOT per-day-bucket) eviction is the
// load-bearing correctness point: a UTC-day bucket can hold facts both inside
// and outside the sliding [now-window, now]; only the in-window subset must
// survive, exactly as the full-rescan's two-sided window filter does.
function evictAgedFacts(state, minTs) {
  for (const [bucketKey, bucket] of state.buckets) {
    for (const [id, f] of bucket.facts) {
      if (f.factMs < minTs) bucket.facts.delete(id);
    }
    if (bucket.facts.size === 0) state.buckets.delete(bucketKey);
  }
}

// buildTransientEmitMap — the emit-pass projection (design.md §D-3.3). Each
// bucket's facts are filtered to BOTH bounds [minTs <= factMs <= nowEpoch] (the
// upper bound drops future-ts facts THIS run exactly as the full-rescan's
// streamLedgerRowsInTimeWindow ceiling does). Produces the SAME shape
// buildThreads returns: Map<bucket_key, {source, thread_id, bucket_key, day,
// facts:[{id,ts,content}]}> — so the shared emit driver's calls are identical.
function buildTransientEmitMap(state, minTs, nowEpoch) {
  const transient = new Map();
  for (const bucket of state.buckets.values()) {
    const facts = [];
    for (const f of bucket.facts.values()) {
      if (f.factMs >= minTs && f.factMs <= nowEpoch) {
        facts.push({ id: f.id, ts: f.ts, content: f.content });
      }
    }
    if (facts.length === 0) continue;
    transient.set(bucket.bucket_key, {
      source: bucket.source,
      thread_id: bucket.thread_id,
      bucket_key: bucket.bucket_key,
      day: bucket.day,
      facts,
    });
  }
  return transient;
}

// ---------------------------------------------------------------------------
// SHARED EMIT DRIVER (design.md §D-3.5) — the equivalence keystone.
//
// Extracted verbatim from the former aggregateThreads emit tail. BOTH paths
// (flag-OFF full-rescan and flag-ON incremental fold) feed it the SAME
// Map<bucket_key, {source, thread_id, bucket_key, day, facts:[{id,ts,content}]}>,
// so if the maps are set-equal the emitted rows are identical by construction.
//
// The ONLY behavioural difference between the two callers is the emitterCtx
// they pass: the incremental branch passes { ...emitterCtx, useParentIndex:true }
// so emitReconstruction uses the compact PIDX path (design.md §D-2.6); flag-OFF
// passes emitterCtx unchanged (no useParentIndex key) → the emitter's old
// scanLedgerLines path, byte-for-byte.
// ---------------------------------------------------------------------------
async function emitThreadBuckets(threadsMap, { ledgerPath, emitterCtx, result }) {
  const min = THREAD_AGGREGATOR_CAPS.MIN_FACTS_PER_THREAD;
  // The emitter's RECONSTRUCT_PARENTS_MAX (16) is the hard structural cap on
  // derived_from[] length. The behavior-tier MAX_FACTS_PER_THREAD (20) is the
  // aggregator's preference; we take the MIN of the two so we never hand the
  // emitter a parent set it would reject with INVALID_PARENTS. The
  // intersection-min discipline matches W7's stricter-wins consent-walk
  // ordering — the structural floor is authoritative over the behavior
  // preference.
  const max = Math.min(
    THREAD_AGGREGATOR_CAPS.MAX_FACTS_PER_THREAD,
    RECONSTRUCT_PARENTS_MAX,
  );
  const ctx = {
    ...(emitterCtx && typeof emitterCtx === "object" ? emitterCtx : {}),
    ledgerPath,
  };
  const logger =
    emitterCtx && emitterCtx.logger && typeof emitterCtx.logger.error === "function"
      ? emitterCtx.logger
      : { error: () => {} };

  // Deterministic iteration order — Map preserves insertion order, but
  // re-sorting by bucket_key makes test assertions trivially stable.
  const buckets = [...threadsMap.values()].sort((a, b) =>
    a.bucket_key < b.bucket_key ? -1 : a.bucket_key > b.bucket_key ? 1 : 0,
  );

  for (const thread of buckets) {
    if (!Array.isArray(thread.facts) || thread.facts.length < min) {
      // Below admission floor — silently skip.
      continue;
    }
    result.threads_processed += 1;

    // Cap at MAX_FACTS_PER_THREAD. Sort by ts ascending then id ascending so
    // the chosen subset is deterministic across re-runs (idempotency relies
    // on identical content + parent set).
    const sortedFacts = thread.facts.slice().sort((a, b) => {
      if (a.ts < b.ts) return -1;
      if (a.ts > b.ts) return 1;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    const cappedFacts =
      sortedFacts.length > max ? sortedFacts.slice(0, max) : sortedFacts;
    // Build the content summary over the SAME capped subset so content_hash
    // and parents track each other (defense against "max" rebalance drift).
    const cappedThread = { ...thread, facts: cappedFacts };
    let summary;
    try {
      summary = buildSummary(
        cappedThread,
        THREAD_AGGREGATOR_CAPS.CONTENT_SUMMARY_MAX_CHARS,
      );
    } catch {
      result.errors += 1;
      continue;
    }
    if (typeof summary !== "string" || summary.length === 0) {
      // No content to synthesize.
      continue;
    }

    const parents = cappedFacts.map((f) => f.id);
    const bucketKey = thread.bucket_key;
    const conversationId = `daemon:thread:${bucketKey}`;

    let emitRes;
    try {
      emitRes = await emitReconstruction(
        {
          mode: "daemon",
          agent_id: THREAD_AGGREGATOR_CAPS.AGGREGATOR_NAME,
          aggregator_name: THREAD_AGGREGATOR_CAPS.AGGREGATOR_NAME,
          bucket_key: bucketKey,
          conversation_id: conversationId,
          scope: "cross_session",
          content: summary,
          parents,
          confidence: 1.0,
        },
        ctx,
      );
    } catch (err) {
      result.errors += 1;
      try {
        logger.error(
          `thread-aggregator: emitReconstruction threw for bucket ${bucketKey}: ${
            err && err.message ? err.message : String(err)
          }`,
        );
      } catch {
        // logger throws must not propagate
      }
      continue;
    }
    if (emitRes && emitRes.ok === true) {
      if (emitRes.dedupe_action === "appended") {
        result.reconstructed_emitted += 1;
      }
      // dedupe_action === "rejected_idempotent" → not counted as a new
      // emission (idempotent re-fire), not counted as an error.
    } else {
      // emitter returned a structured reject (bad parents, validator block).
      // Count as error so the operator-facing metric surfaces it.
      result.errors += 1;
      try {
        logger.error(
          `thread-aggregator: emitReconstruction rejected bucket ${bucketKey}: ${
            emitRes && (emitRes.code || emitRes.drop_reason || emitRes.error)
              ? emitRes.code || emitRes.drop_reason || emitRes.error
              : "unknown"
          }`,
        );
      } catch {
        // logger throws must not propagate
      }
    }
  }
}

// ---------------------------------------------------------------------------
// PUBLIC ENTRY POINT
// ---------------------------------------------------------------------------

/**
 * aggregateThreads — daemon-side thread aggregator (W12) + incremental fold.
 *
 * @param {object} args
 *   - ledgerPath: string                   memory.jsonl
 *   - sinceMs: number                      lookback window in ms
 *   - now?: Date|string|number             test-only injector
 *   - sourcesFilter?: string[]|Set<string> optional source allowlist
 *   - emitterCtx?: object                  forwarded to emitReconstruction
 *   - incremental?: boolean                explicit override of the CAPS flag
 *                                          (design.md §D-4.2); undefined → env
 *   - checkpointPath?: string              WIRE's per-aggregator checkpoint file
 *                                          (self-heal anchor; the window never
 *                                          depends on it, design.md §D-3.4)
 *
 * @returns {Promise<{threads_processed:number, reconstructed_emitted:number,
 *   errors:number, checkpoint_offset?:number, bytes_scanned?:number,
 *   resume_offset?:number}>}
 *   checkpoint_offset/bytes_scanned/resume_offset are present ONLY on the
 *   incremental (flag-ON) path: checkpoint_offset is the new safe-resume byte
 *   offset for WIRE to persist; bytes_scanned is the cost-proof delta (whole
 *   ledger on cold start, appended bytes only on a warm tick, design.md §D-5.4);
 *   resume_offset is the CKPT-resolved persisted offset read at cold start for
 *   the self-heal predicate (design.md §D-3.4, symmetric with project-aggregator).
 */
export async function aggregateThreads({
  ledgerPath,
  sinceMs,
  now,
  sourcesFilter,
  emitterCtx,
  incremental,
  checkpointPath,
} = {}) {
  const result = {
    threads_processed: 0,
    reconstructed_emitted: 0,
    errors: 0,
  };

  // Defensive arg checks. Bad args → return zeros; do NOT throw (the watermark
  // daemon's idle tick must not crash on misconfiguration).
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    return result;
  }
  if (typeof sinceMs !== "number" || !Number.isFinite(sinceMs) || sinceMs <= 0) {
    sinceMs = THREAD_AGGREGATOR_CAPS.TIME_WINDOW_MS;
  }

  const nowEpoch = nowMs(now);
  const minTs = nowEpoch - sinceMs;

  // Default source filter: only thread-bearing connectors.
  const effectiveFilter =
    sourcesFilter === undefined
      ? new Set(THREAD_AGGREGATOR_CAPS.THREAD_BEARING_SOURCES)
      : sourcesFilter === null
        ? null
        : sourcesFilter;

  // -------------------------------------------------------------------------
  // FLAG-OFF (default): the exact full-ledger-rescan path. The shared driver
  // reproduces the former emit tail verbatim and receives emitterCtx WITHOUT a
  // useParentIndex key, so emitReconstruction stays on its old scanLedgerLines
  // path — byte-for-byte identical to the pre-incremental implementation.
  // -------------------------------------------------------------------------
  if (!resolveIncremental(incremental)) {
    // WU-B1 — stream-filter at parse time so we never materialize the full
    // ledger as a JS object graph. Only kind="fact" rows with ts in the 24h
    // window are kept; everything else (policy rows, recall rows, facts older
    // than the window) is dropped during the stream pass. Empirically the kept
    // set is ≤1k rows even on the live ledger → ~99.7% RSS reduction.
    let rows;
    try {
      const r = streamLedgerRowsInTimeWindow(ledgerPath, minTs, nowEpoch, {
        kind: "fact",
      });
      rows = r.rows;
    } catch {
      return result;
    }
    if (rows.length === 0) return result;

    let threads;
    try {
      threads = buildThreads(rows, { minTs, sourcesFilter: effectiveFilter });
    } catch {
      return result;
    }

    await emitThreadBuckets(threads, { ledgerPath, emitterCtx, result });
    return result;
  }

  // -------------------------------------------------------------------------
  // FLAG-ON: incremental offset-checkpointed fold (design.md §D-3). The WINDOW
  // never depends on the persisted checkpoint offset surviving a restart
  // (design.md §D-3.4) — a cold start rebuilds state via a bounded window-rescan
  // and the returned checkpoint_offset is what WIRE persists. checkpointPath IS
  // read at cold start (below) for the self-heal predicate → resume_offset, but
  // it is NEVER consulted to bound the window — the rescan is authoritative.
  // -------------------------------------------------------------------------
  const { size: ledgerSize, ino: ledgerIno } = ledgerStat(ledgerPath);
  // bytes_scanned + resume_offset are the flag-ON observability envelope
  // (design.md §D-5.4 cost proof + §D-3.4 self-heal), symmetric with the sibling
  // project-aggregator. Defaults for the no-append / no-checkpoint cases.
  result.bytes_scanned = 0;

  let state = _incrementalStateByPath.get(ledgerPath);
  // Cold-start / self-heal decision (design.md §D-1.4 + §D-3.4):
  //   - no in-process state (cold start / daemon restart)
  //   - working offset past EOF (truncate or rebuild-smaller)
  //   - inode change (compaction rewrote the ledger under a new inode)
  // Any of these → bounded window-rescan bootstrap (NOT an offset rewind: the
  // ledger is append-ordered, not ts-ordered, so no offset bounds the window).
  const needBootstrap =
    state === undefined ||
    state.offset > ledgerSize ||
    (state.ino != null && ledgerIno != null && state.ino !== ledgerIno);

  if (needBootstrap) {
    // Read the persisted checkpoint via CKPT for the self-heal predicate ONLY
    // (design.md §D-3.4) — exposed as resume_offset for WIRE/observability. The
    // one-sided window-rescan bootstrap below is AUTHORITATIVE: the append-ordered
    // ledger has no byte offset that bounds the ts-window, so the persisted offset
    // is NEVER used to skip the window across a restart. A poisoned offset (past
    // EOF, or a stale inode) resolves to 0 and changes NOTHING — the rescan reads
    // the whole window regardless.
    result.resume_offset =
      typeof checkpointPath === "string" && checkpointPath.length > 0
        ? resolveStartOffset(checkpointPath, ledgerPath, { aggregator: "thread" })
        : 0;
    state = coldBootstrapThreads({
      ledgerPath,
      minTs,
      effectiveFilter,
      ledgerSize,
      ledgerIno,
    });
    _incrementalStateByPath.set(ledgerPath, state);
    // Cold bootstrap streams the whole ledger once (design.md §D-1.5): the
    // window-rescan reads to EOF, so bytes_scanned ≈ the full ledger size.
    result.bytes_scanned = ledgerSize;
  } else {
    // Warm run: fold ONLY the appended bytes [state.offset, EOF). foldNewRows
    // returns the streamer's bytesScanned == the delta (design.md §D-5.4).
    result.bytes_scanned = foldNewRows({
      state,
      ledgerPath,
      minTs,
      effectiveFilter,
    });
    if (ledgerIno != null) state.ino = ledgerIno;
  }

  // Eviction — EVERY run, including a re-run with ZERO new rows (per-fact by
  // factMs, design.md §D-3.3). This is what stops a no-new-append re-run from
  // re-emitting aged-out buckets and shrinks still-live buckets.
  evictAgedFacts(state, minTs);

  // Emit pass — EVERY run: build the transient [minTs, nowEpoch] map and feed
  // it to the SAME shared driver, propagating useParentIndex so the emitter
  // uses the compact PIDX path (design.md §D-2.6). Do NOT early-return on zero
  // new rows: the full-rescan re-derives + re-emits every run, and eviction can
  // move a bucket across the MIN gate or change its content_hash.
  const transient = buildTransientEmitMap(state, minTs, nowEpoch);
  await emitThreadBuckets(transient, {
    ledgerPath,
    emitterCtx: {
      ...(emitterCtx && typeof emitterCtx === "object" ? emitterCtx : {}),
      useParentIndex: true,
    },
    result,
  });

  // WIRE persists this new safe-resume offset via CKPT (emit-before-persist;
  // never advanced on error/throw — a crash re-reads + re-emits, collapsed by S5).
  result.checkpoint_offset = state.offset;
  return result;
}

// Test-only surface (internal helpers exposed so the W12 suite can unit-test
// the bucketing pipeline without invoking the emitter).
//
// resetIncrementalStateForTest / getIncrementalStateForTest (design.md THREAD
// module map): the equivalence suite drives flag-ON across multiple ticks per
// fixture ledger deterministically — reset clears the module-level state map
// (simulating a daemon restart / cold start), inspect returns a ledger's state
// so a test can assert offset advance + bucket contents.
function resetIncrementalStateForTest() {
  _incrementalStateByPath.clear();
}

function getIncrementalStateForTest(ledgerPath) {
  return _incrementalStateByPath.get(ledgerPath);
}

export const __internal = Object.freeze({
  parseLedgerLines,
  dayBucket,
  resolveRowTs,
  extractThreadKey,
  readRawContent,
  buildThreads,
  buildSummary,
  nowMs,
  resolveIncremental,
  emitThreadBuckets,
  resetIncrementalStateForTest,
  getIncrementalStateForTest,
});
