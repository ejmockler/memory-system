// project-aggregator.js — Wave 13 BEHAVIOR tier.
// (F-SYN-BEHAVIOR-project-aggregation)
//
// MIRROR OF W12's thread-aggregator, but PROJECT-grain instead of THREAD-
// grain. Where thread-aggregator collapses chat threads / per-day commit
// runs into a single reconstructed memory ("operator chatted with X
// today"), project-aggregator collapses a week of repo activity by one
// author into a single reconstructed memory ("operator worked on repo X
// the week of YYYY-WW producing N commits + M events").
//
// SCOPE — what's IN, what's OUT:
//   IN  : git-log (per-repo commits) + github-events (per-repo activity).
//         Both carry repo + author identity strong enough to bucket on.
//   OUT : iMessage, screentime, chat-claude-code. Those are thread-grain;
//         the thread-aggregator owns them.
//
// AUTHORITATIVE SPEC:
//   - docs/specs/synthesis/reconstructed-trigger.md § AM4 (daemon path) +
//     § M5 (daemon-path wiring) + § O4 (admission gates owned by this node)
//   - W8 § S5 idempotency-key fix:
//       sha256(canonical_json({domain:"daemon", aggregator_name, bucket_key,
//                              content_hash}))
//     The emitter computes this from input.aggregator_name + input.bucket_key
//     + sha256(input.content). § S5 example uses
//       repo:<repo_root>:author:<email>:week:<isoweek>
//     verbatim — this aggregator implements that bucket shape.
//
// DESIGN INVARIANTS (mirror thread-aggregator):
//   - Daemon path emit (mode:"daemon", no token).
//   - aggregator_name :: "daemon:project-aggregator" (single-producer per
//     policy kind — the CI grep enforces no other producer with this name).
//   - bucket_key      :: "repo:<repo>:author:<author>:week:<YYYY-WW>"
//   - TIME_WINDOW_MS  :: 7 * 24h (week grain vs thread's day grain)
//   - MIN_FACTS       :: 2  (a single commit is too small; 2+ in a week
//                            promotes to a "project session")
//   - MAX_FACTS       :: 16 (== RECONSTRUCT_PARENTS_MAX structural floor)
//
// HOT PATH DISCIPLINE:
//   - Defensive try/catch on every emitter call; an emit failure logs and
//     continues. The daemon's idle tick MUST NOT crash on a malformed parent
//     row or an emitter validation reject.
//   - One ledger scan per invocation; projects are built in memory then
//     emitted serially.
//
// CONTRACT:
//   aggregateProjects({ledgerPath, sinceMs, now?, sourcesFilter?, emitterCtx?})
//     → {projects_processed, reconstructed_emitted, errors}
//
//   - ledgerPath: required string; the memory ledger to scan + emit into.
//   - sinceMs: required number; only facts with ts >= (now - sinceMs) are
//     considered. Caller (watermark idle tick) passes 7d.
//   - now: optional Date | ISO string | epoch-ms (test injector); default
//     Date.now().
//   - sourcesFilter: optional Array<string>; when present, only facts whose
//     source matches are considered. Default: PROJECT_BEARING_SOURCES.
//   - emitterCtx: optional object forwarded to emitReconstruction's ctx
//     (used by tests to inject `now` / `ulid` / `logger`). The ledgerPath
//     in emitterCtx is overridden with the caller's ledgerPath.

// WU-B1 — stream-filter ledger reads. The previous parseLedgerLines
// path did readFileSync of the full 308MB memory.jsonl on every cascade
// tick. Project-aggregator's window is 7d so it retains a slightly
// larger working set than thread-aggregator (24h), but still <5% of
// the ledger by row count — streaming + filtering bounds the heap
// proportional to the filtered set rather than the on-disk file size.
// WU-emitter-string-cap-fix — streamLedgerLines added so the legacy
// parseLedgerLines test-surface helper below no longer whole-file reads
// (see its comment for the class invariant).
import { join } from "node:path";

import { statSync } from "node:fs";

import {
  streamLedgerLines,
  streamLedgerLinesWithOffset,
  streamLedgerRowsInTimeWindow,
  ledgerSizeOrZero,
} from "./_ledger-stream.js";

import {
  emitReconstruction,
  RECONSTRUCT_PARENTS_MAX,
} from "./reconstruction-emitter.js";

// Incremental-aggregation deps (design.md D1). The CKPT primitive is READ-ONLY
// here: the aggregator resolves the persisted byte-offset checkpoint at COLD
// START for the self-heal predicate (design.md §D-3.4) and RETURNS
// checkpoint_offset in its envelope; the DAEMON (WIRE node, watermark.js) owns
// the atomic write of that offset. CAPS gates the whole machine (default OFF).
import { resolveStartOffset } from "./_agg-checkpoint.js";
import { CAPS } from "../validation.js";
import { STORAGE_DIR } from "../config.js";

// ---------------------------------------------------------------------------
// PUBLIC CONSTANTS
// ---------------------------------------------------------------------------

export const PROJECT_AGGREGATOR_VERSION = "project-aggregator@0.1.0";

// Sources we attempt to bucket by repo+author. iMessage / screentime /
// chat-claude-code lack a stable (repo, author) identity, so they are
// silently skipped (the thread-aggregator owns them). The list is frozen
// + exported so tests + the daemon assert the surface is stable.
export const PROJECT_BEARING_SOURCES = Object.freeze([
  "git-log",
  "github-events",
]);

export const PROJECT_AGGREGATOR_CAPS = Object.freeze({
  // Week-grain window (vs thread-aggregator's 24h). Spec § S5 example
  // explicitly uses "...:week:<isoweek>".
  TIME_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
  // Admission gates (spec § O4 — owned by this behavior node). A single
  // commit in a week is too small to call a "project session"; 2+ commits
  // means the operator returned to the repo.
  MIN_FACTS_PER_PROJECT: 2,
  // Structural floor — matches RECONSTRUCT_PARENTS_MAX (16). The emitter
  // rejects derived_from[] arrays longer than this, so we cap here too.
  MAX_FACTS_PER_PROJECT: 16,
  // Content-summary cap. The first N chars of the concatenated project
  // activity becomes the reconstructed.content. The emitter's
  // RECONSTRUCT_CONTENT_MAX_CHARS (16384) is far above; this is a
  // behavior-tier presentation choice consistent with W12.
  CONTENT_SUMMARY_MAX_CHARS: 500,
  // The aggregator_name field stamped into the S5 preimage. The agent_id
  // form is "daemon:project-aggregator" — single-producer per policy kind
  // (CI grep enforces no sibling producer with this name).
  AGGREGATOR_NAME: "daemon:project-aggregator",
  // Mirror the sources allowlist on the CAPS surface so callers can read
  // one frozen object instead of importing two symbols.
  PROJECT_BEARING_SOURCES,
});

// ---------------------------------------------------------------------------
// INTERNAL: ledger scan (mirrors thread-aggregator)
// ---------------------------------------------------------------------------

// parseLedgerLines — LEGACY helper, exported via __internal ONLY; nothing on
// the hot path calls it (the cascade tick uses streamLedgerRowsInTimeWindow —
// that was the WU-B1 fix). Rebased onto the streamer as part of
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
// depend on). Mirrors _ledger-stream.js's window filter (row.ts ||
// row.created_at). Without this a production fact survives the stream window
// filter but is then silently dropped by the bucketer's ts-presence guard.
// Returns the ISO string (ts wins, then created_at) or null when neither is
// present.
function resolveRowTs(row) {
  if (row == null || typeof row !== "object") return null;
  if (typeof row.ts === "string" && row.ts.length > 0) return row.ts;
  if (typeof row.created_at === "string" && row.created_at.length > 0) {
    return row.created_at;
  }
  return null;
}

// ISO-8601 week bucket "YYYY-WW" — deterministic, timezone-stable, matches
// spec § S5 example "...:week:<isoweek>". ISO weeks run Mon..Sun; week 1
// is the week containing the year's first Thursday. We compute that here
// rather than depend on an external date library so the daemon stays
// dependency-free.
function isoWeekBucket(tsIso) {
  if (typeof tsIso !== "string" || tsIso.length === 0) return "unknown";
  const ms = Date.parse(tsIso);
  if (!Number.isFinite(ms)) return "unknown";
  // Operate in UTC throughout so the bucket is stable regardless of the
  // machine's local timezone.
  const d = new Date(ms);
  // Algorithm: shift the day-of-week so Monday=1..Sunday=7, jump to the
  // nearest Thursday (anchor of the ISO week), compute the year of that
  // anchor, then count weeks since week 1 of that year.
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // Mon=1..Sun=7
  // Move to the Thursday of this ISO week.
  const thursday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
  thursday.setUTCDate(thursday.getUTCDate() + (4 - day));
  const year = thursday.getUTCFullYear();
  // Jan 4 is always in ISO week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  // Monday of ISO week 1.
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  // Diff in ms / ms-per-week → integer week index (0-based) → +1 for ISO.
  const diffMs = thursday.getTime() - week1Monday.getTime();
  const weekNum = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;
  const weekStr = String(weekNum).padStart(2, "0");
  return `${year}-W${weekStr}`;
}

// ---------------------------------------------------------------------------
// INTERNAL: project-key extraction
//
// For git-log + github-events the connector row shapes give us:
//   - git-log: raw_content.repo_path + raw_content.author_email
//   - github-events: raw_content.repo + raw_content.actor_login
// We accept any of the common synonyms (matches the connector contracts on
// disk in mcp/lib/connectors/{git-log-local,github-events}.js).
//
// The returned `bucket_key` is the value the spec § S5 preimage hashes over;
// it MUST be deterministic across re-runs so idempotency holds.
// ---------------------------------------------------------------------------

function extractProjectKey(fact) {
  if (fact == null || typeof fact !== "object") return null;
  const src = typeof fact.source === "string" ? fact.source : null;
  if (src === null) return null;
  // Only git-log + github-events carry stable (repo, author) identity. iMessage
  // / screentime / chat-claude-code fall through to null and are skipped.
  if (src !== "git-log" && src !== "github-events") return null;

  // FIX-1 (N7b) — week-bucket from ts (source-ledger) OR created_at (promoted).
  const week = isoWeekBucket(resolveRowTs(fact));
  if (week === "unknown") return null;

  const rc = readRawContent(fact);

  // Repo identity — try every synonym seen in the connector contracts.
  // git-log writes raw_content.repo_path; github-events writes
  // raw_content.repo. We also accept repo_name + repo_full_name for
  // forward-compat with future connectors.
  const repo =
    (rc && typeof rc.repo_path === "string" && rc.repo_path) ||
    (rc && typeof rc.repo === "string" && rc.repo) ||
    (rc && typeof rc.repo_name === "string" && rc.repo_name) ||
    (rc && typeof rc.repo_full_name === "string" && rc.repo_full_name) ||
    null;

  // Author identity — git-log writes author_email; github-events writes
  // actor_login. Either is fine for the bucket key, but the two must NEVER
  // collide for the SAME repo (different identity spaces) — so we PREFIX
  // the value with the field so an email "foo" and a login "foo" produce
  // distinct bucket keys.
  let author = null;
  if (rc && typeof rc.author_email === "string" && rc.author_email) {
    author = `email:${rc.author_email}`;
  } else if (rc && typeof rc.actor_login === "string" && rc.actor_login) {
    author = `login:${rc.actor_login}`;
  } else if (rc && typeof rc.author === "string" && rc.author) {
    author = `email:${rc.author}`;
  } else if (rc && typeof rc.author_name === "string" && rc.author_name) {
    author = `name:${rc.author_name}`;
  }

  if (!repo || !author) return null;
  return {
    source: src,
    project_id: `${repo}::${author}`,
    week,
    bucket_key: `repo:${repo}:author:${author}:week:${week}`,
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
    if (
      ref0 &&
      typeof ref0 === "object" &&
      ref0.raw_content &&
      typeof ref0.raw_content === "object"
    ) {
      return ref0.raw_content;
    }
  }
  if (fact.features && typeof fact.features === "object") {
    // features.raw_content is a fallback some test fixtures use.
    const rc = fact.features.raw_content;
    if (rc && typeof rc === "object") return rc;
    // FIX-2 (N7b) — PRIMARY production path. The promoter (distill-promote-
    // fact.js, CASCADE_THREAD_KEYS_ENABLED) STRIPS raw_content from the fact
    // row and forwards ONLY the closed identity subset onto
    // features.thread_keys: {chat_guid, chat_identifier, repo_path,
    // author_email, actor_login, repo, conversation_id}. For project grain the
    // relevant fields are repo_path / repo / author_email / actor_login —
    // exactly what extractProjectKey reads off `rc`. Read AFTER raw_content /
    // source_refs so legacy fixtures are unaffected.
    const tk = fact.features.thread_keys;
    if (tk && typeof tk === "object" && !Array.isArray(tk)) return tk;
  }
  return null;
}

// ---------------------------------------------------------------------------
// INTERNAL: project bucketing
// ---------------------------------------------------------------------------

function buildProjects(rows, { minTs, sourcesFilter }) {
  const filterSet =
    sourcesFilter instanceof Set
      ? sourcesFilter
      : Array.isArray(sourcesFilter) && sourcesFilter.length > 0
        ? new Set(sourcesFilter)
        : null;
  const projects = new Map(); // bucket_key -> {source, bucket_key, facts:[{id,ts,content}]}
  for (const row of rows) {
    if (row == null || typeof row !== "object") continue;
    if (row.kind !== "fact") continue;
    if (typeof row.id !== "string" || row.id.length === 0) continue;
    if (typeof row.content !== "string" || row.content.length === 0) continue;
    // FIX-1 (N7b) — accept ts (source-ledger rows) OR created_at (promoted
    // facts). Mirrors _ledger-stream.js's window filter so a fact that
    // survived the stream is not silently dropped here. The resolved value
    // feeds both the in-window check and the week-bucket derivation.
    const rowTs = resolveRowTs(row);
    if (rowTs === null) continue;
    const factMs = Date.parse(rowTs);
    if (!Number.isFinite(factMs)) continue;
    if (factMs < minTs) continue;
    const src = typeof row.source === "string" ? row.source : null;
    if (filterSet !== null && (src === null || !filterSet.has(src))) continue;

    let key;
    try {
      key = extractProjectKey(row);
    } catch {
      key = null;
    }
    if (key === null) continue;

    let bucket = projects.get(key.bucket_key);
    if (bucket === undefined) {
      bucket = {
        source: key.source,
        project_id: key.project_id,
        bucket_key: key.bucket_key,
        week: key.week,
        facts: [],
      };
      projects.set(key.bucket_key, bucket);
    }
    bucket.facts.push({
      id: row.id,
      ts: rowTs,
      content: row.content,
    });
  }
  return projects;
}

// Stable content-summary builder. Sorts facts by ts then id for determinism
// (idempotency depends on the content hash being stable across re-runs).
function buildSummary(project, capChars) {
  const sorted = project.facts.slice().sort((a, b) => {
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
// INCREMENTAL FOLD (design.md D1) — CAPS-gated, default OFF.
//
// The incremental path replaces the FULL-LEDGER-RESCAN
// (streamLedgerRowsInTimeWindow reads to EOF every tick) with an offset-
// checkpointed fold that reads only [state.offset, EOF) on warm ticks. The
// running windowed bucket state is IN-PROCESS ONLY (module-level Map keyed by
// ledgerPath) — never serialized (design.md §D-1.2); the disk checkpoint holds
// only the byte offset + fingerprint and is a WIRE-owned crash-observability
// anchor. Correctness of the window never depends on the persisted offset
// surviving a restart — a restart pays a one-time COLD-START window-rescan
// bootstrap (design.md §D-3.4). Flag OFF is byte-for-byte the old path.
// ---------------------------------------------------------------------------

// Checkpoint aggregator name / default location (design.md §D-1.1:
// storage/aggregator-state/project.json). WIRE passes an explicit checkpointPath
// (config.aggregatorCheckpointPath("project")); this default keeps the module
// self-contained and points at the SAME location. STORAGE_DIR honors
// STORAGE_BASE_DIR so hermetic tests are isolated for free.
const PROJECT_CHECKPOINT_NAME = "project";
function defaultCheckpointPath() {
  return join(STORAGE_DIR, "aggregator-state", `${PROJECT_CHECKPOINT_NAME}.json`);
}
function resolveCheckpointPath(explicit) {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return defaultCheckpointPath();
}

// resolveIncremental (design.md §D-4.2): explicit boolean arg WINS (tests /
// hermetic overrides); otherwise the env-driven-at-load CAPS flag decides. When
// WIRE has not yet added CAPS.INCREMENTAL_AGGREGATION_ENABLED the read is
// `undefined === true` → false → OFF, so this module is safe to land ahead of
// the WIRE CAPS entry.
function resolveIncremental(argValue) {
  if (typeof argValue === "boolean") return argValue;
  return !!(CAPS && CAPS.INCREMENTAL_AGGREGATION_ENABLED === true);
}

function toFilterSet(sourcesFilter) {
  return sourcesFilter instanceof Set
    ? sourcesFilter
    : Array.isArray(sourcesFilter) && sourcesFilter.length > 0
      ? new Set(sourcesFilter)
      : null;
}

// In-process windowed bucket state, keyed by ledgerPath (design.md §D-3.1).
//   state = { offset, buckets: Map<bucket_key, {
//     source, project_id, bucket_key, week,
//     facts: Map<fact_id, { id, ts, content, factMs }>   // factMs = per-fact
//   }> }
// factMs per fact is the crux of PER-FACT eviction (design.md §D-3.3). Facts are
// keyed by id in a Map so a re-read torn line that later terminates cannot
// double-count and distinct ids each fold once (equivalent to buildProjects'
// one-push-per-line under the ledger's unique-id invariant).
const _incrementalStateByPath = new Map();

// ledgerStat — size + inode for the cold-start / warm-run self-heal predicate
// (design.md §D-1.4). Missing/unreadable → {size:0, ino:null}; never throws.
// Mirrors thread-aggregator.js's ledgerStat so the two aggregators self-heal on
// an inode change (compaction / restore-from-backup) identically.
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

// Fold ONE parsed row into the windowed state. Replicates buildProjects' per-row
// gate EXACTLY (kind/id/content/ts/factMs/source/extractProjectKey) MINUS the
// upper bound: the fold applies ONLY the lower bound (factMs >= minTs) so a
// future-ts backfill/clock-skew row is RETAINED for a later run whose window
// reaches it (design.md §D-3.2 / §X-1). The emit-time filter re-applies the
// [minTs, nowEpoch] ceiling. Row-local: every decision comes from the row's own
// fields, so an incremental tail-merge is identical to a full rescan.
function foldRowIntoState(state, row, minTs, filterSet) {
  if (row == null || typeof row !== "object") return;
  if (row.kind !== "fact") return;
  if (typeof row.id !== "string" || row.id.length === 0) return;
  if (typeof row.content !== "string" || row.content.length === 0) return;
  const rowTs = resolveRowTs(row);
  if (rowTs === null) return;
  const factMs = Date.parse(rowTs);
  if (!Number.isFinite(factMs)) return;
  if (factMs < minTs) return; // lower bound only — retain future-ts
  const src = typeof row.source === "string" ? row.source : null;
  if (filterSet !== null && (src === null || !filterSet.has(src))) return;

  let key;
  try {
    key = extractProjectKey(row);
  } catch {
    key = null;
  }
  if (key === null) return;

  let bucket = state.buckets.get(key.bucket_key);
  if (bucket === undefined) {
    bucket = {
      source: key.source,
      project_id: key.project_id,
      bucket_key: key.bucket_key,
      week: key.week,
      facts: new Map(),
    };
    state.buckets.set(key.bucket_key, bucket);
  }
  bucket.facts.set(row.id, {
    id: row.id,
    ts: rowTs,
    content: row.content,
    factMs,
  });
}

// ---------------------------------------------------------------------------
// SHARED EMIT DRIVER (design.md §D-3.5).
//
// The pipeline AFTER "gather buckets" — min/max caps, ctx build, bucket-sort by
// bucket_key, per-bucket admission + sort + cap + buildSummary + emitReconstruction
// + tally — is a SINGLE code path fed by EITHER gatherer (flag-OFF full-rescan
// buildProjects, or flag-ON incremental transient map). This is what guarantees
// byte-identical reconstructed rows: the only difference between the two paths is
// row PROVENANCE, never the transform. This body reproduces the old inline emit
// tail verbatim; `ctx.useParentIndex` is propagated from emitterCtx so the flag-ON
// caller (which merges useParentIndex:true) selects the emitter's PIDX path while
// flag-OFF leaves it unset (old scanLedgerLines path). Mutates `result`.
// ---------------------------------------------------------------------------
async function emitProjectBuckets(projectsMap, { ledgerPath, emitterCtx, result }) {
  const min = PROJECT_AGGREGATOR_CAPS.MIN_FACTS_PER_PROJECT;
  // The emitter's RECONSTRUCT_PARENTS_MAX (16) is the hard structural cap on
  // derived_from[] length. We take the MIN of the behavior-tier preference
  // (MAX_FACTS_PER_PROJECT) and the structural floor so we never hand the
  // emitter a parent set it would reject with INVALID_PARENTS. The
  // intersection-min discipline mirrors thread-aggregator's W12 contract.
  const max = Math.min(
    PROJECT_AGGREGATOR_CAPS.MAX_FACTS_PER_PROJECT,
    RECONSTRUCT_PARENTS_MAX,
  );
  const ctx = {
    ...(emitterCtx && typeof emitterCtx === "object" ? emitterCtx : {}),
    ledgerPath,
  };
  const logger =
    emitterCtx &&
    emitterCtx.logger &&
    typeof emitterCtx.logger.error === "function"
      ? emitterCtx.logger
      : { error: () => {} };

  // Deterministic iteration order — Map preserves insertion order, but
  // re-sorting by bucket_key makes test assertions trivially stable.
  const buckets = [...projectsMap.values()].sort((a, b) =>
    a.bucket_key < b.bucket_key ? -1 : a.bucket_key > b.bucket_key ? 1 : 0,
  );

  for (const project of buckets) {
    if (!Array.isArray(project.facts) || project.facts.length < min) {
      // Below admission floor — silently skip (single-commit weeks are not
      // project sessions).
      continue;
    }
    result.projects_processed += 1;

    // Cap at MAX_FACTS_PER_PROJECT. Sort by ts then id so the chosen subset
    // is deterministic across re-runs (idempotency relies on identical
    // content + parent set).
    const sortedFacts = project.facts.slice().sort((a, b) => {
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
    const cappedProject = { ...project, facts: cappedFacts };
    let summary;
    try {
      summary = buildSummary(
        cappedProject,
        PROJECT_AGGREGATOR_CAPS.CONTENT_SUMMARY_MAX_CHARS,
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
    const bucketKey = project.bucket_key;
    const conversationId = `daemon:project:${bucketKey}`;

    let emitRes;
    try {
      emitRes = await emitReconstruction(
        {
          mode: "daemon",
          agent_id: PROJECT_AGGREGATOR_CAPS.AGGREGATOR_NAME,
          aggregator_name: PROJECT_AGGREGATOR_CAPS.AGGREGATOR_NAME,
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
          `project-aggregator: emitReconstruction threw for bucket ${bucketKey}: ${
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
          `project-aggregator: emitReconstruction rejected bucket ${bucketKey}: ${
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
 * aggregateProjects — daemon-side project aggregator (W13 + D1 incremental).
 *
 * @param {object} args
 *   - ledgerPath: string                   memory.jsonl
 *   - sinceMs: number                      lookback window in ms (default 7d)
 *   - now?: Date|string|number             test-only injector
 *   - sourcesFilter?: string[]|Set<string> optional source allowlist
 *   - emitterCtx?: object                  forwarded to emitReconstruction
 *   - incremental?: boolean                explicit override of the CAPS flag
 *                                          (design.md §D-4.2; tests / WIRE).
 *                                          Omitted → CAPS.INCREMENTAL_AGGREGATION_ENABLED.
 *   - checkpointPath?: string              hermetic checkpoint-path override
 *                                          (design.md module map). Default:
 *                                          storage/aggregator-state/project.json.
 *
 * @returns {Promise<{projects_processed:number, reconstructed_emitted:number,
 *   errors:number, checkpoint_offset?:number, bytes_scanned?:number,
 *   resume_offset?:number}>}
 *   checkpoint_offset/bytes_scanned/resume_offset are present ONLY on the
 *   incremental (flag-ON) path.
 */
export async function aggregateProjects({
  ledgerPath,
  sinceMs,
  now,
  sourcesFilter,
  emitterCtx,
  incremental,
  checkpointPath,
} = {}) {
  const result = {
    projects_processed: 0,
    reconstructed_emitted: 0,
    errors: 0,
  };

  // Defensive arg checks. Bad args → return zeros; do NOT throw (the watermark
  // daemon's idle tick must not crash on misconfiguration).
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    return result;
  }
  if (
    typeof sinceMs !== "number" ||
    !Number.isFinite(sinceMs) ||
    sinceMs <= 0
  ) {
    sinceMs = PROJECT_AGGREGATOR_CAPS.TIME_WINDOW_MS;
  }

  const nowEpoch = nowMs(now);
  const minTs = nowEpoch - sinceMs;

  // Default source filter: only project-bearing connectors. Callers can
  // pass null to disable filtering (used by some tests).
  const effectiveFilter =
    sourcesFilter === undefined
      ? new Set(PROJECT_BEARING_SOURCES)
      : sourcesFilter === null
        ? null
        : sourcesFilter;

  // -------------------------------------------------------------------------
  // FLAG OFF (default) — byte-identical full-rescan path. This is the EXISTING
  // W13 behavior verbatim, only rerouted through the shared emit driver so the
  // extraction is invisible to flag-OFF (design.md §X-3).
  // -------------------------------------------------------------------------
  if (!resolveIncremental(incremental)) {
    // WU-B1 — stream-filter at parse time. Only kind="fact" rows in the
    // 7d window enter the heap; policy / recall / out-of-window facts
    // never get materialized as JS objects.
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

    let projects;
    try {
      projects = buildProjects(rows, { minTs, sourcesFilter: effectiveFilter });
    } catch {
      return result;
    }

    await emitProjectBuckets(projects, { ledgerPath, emitterCtx, result });
    return result;
  }

  // -------------------------------------------------------------------------
  // FLAG ON — offset-checkpointed incremental fold (design.md §D-3).
  // Reads ONLY [state.offset, EOF) on warm ticks; a cold start (or self-heal
  // trip) pays a one-time bounded window-rescan bootstrap. The transient emit
  // map is fed to the SAME shared driver so the emitted rows are identical to
  // the flag-OFF path on the same ledger snapshot at the same `now`.
  // -------------------------------------------------------------------------
  result.checkpoint_offset = 0;
  result.bytes_scanned = 0;

  try {
    const cpPath = resolveCheckpointPath(checkpointPath);
    const filterSet = toFilterSet(effectiveFilter);
    const { size: ledgerSize, ino: ledgerIno } = ledgerStat(ledgerPath);

    let state = _incrementalStateByPath.get(ledgerPath);

    // In-process self-heal (design.md §D-1.4): drop stale state + cold-rescan on
    //   (a) a persisted offset PAST the current EOF — ledger truncated/rebuilt-smaller; OR
    //   (b) an INODE CHANGE — the ledger was rewritten under a new inode
    //       (compaction, or a restore-from-backup/out-of-band replacement that
    //       does NOT shrink below the working offset, which (a) would miss).
    // Mirrors thread-aggregator.js's needBootstrap so both aggregators are
    // equivalent to the full-rescan across an inode-changing rewrite.
    if (
      state != null &&
      (state.offset > ledgerSize ||
        (state.ino != null && ledgerIno != null && state.ino !== ledgerIno))
    ) {
      _incrementalStateByPath.delete(ledgerPath);
      state = null;
    }

    if (state == null) {
      // COLD START (or self-heal trip) — bounded ONE-SIDED window-rescan
      // bootstrap (design.md §D-3.4). Read the disk checkpoint via CKPT for the
      // self-heal predicate ONLY (exposed as resume_offset); the window-rescan
      // below is AUTHORITATIVE — the append-ordered ledger has no byte offset
      // that bounds the ts-window, so the persisted offset can never be used to
      // skip the window across a restart.
      result.resume_offset = resolveStartOffset(cpPath, ledgerPath, {
        aggregator: PROJECT_CHECKPOINT_NAME,
      });

      state = {
        offset: ledgerSize,
        ino: ledgerIno != null ? ledgerIno : null,
        buckets: new Map(),
      };
      // ONE-SIDED (Infinity ceiling) so future-ts rows survive the scan — the
      // emit-time [minTs, nowEpoch] filter (below) drops them from THIS emit but
      // a later `now` will include them, exactly as a full-rescan at that later
      // `now` would (design.md §D-3.4 future-ts hole).
      let rows = [];
      try {
        rows = streamLedgerRowsInTimeWindow(ledgerPath, minTs, Infinity, {
          kind: "fact",
        }).rows;
      } catch {
        rows = [];
      }
      result.bytes_scanned = ledgerSize;
      for (const row of rows) foldRowIntoState(state, row, minTs, filterSet);
      _incrementalStateByPath.set(ledgerPath, state);
    } else {
      // WARM — fold ONLY the appended bytes [state.offset, EOF). The safe resume
      // offset advances only across NEWLINE-TERMINATED lines: a torn trailing
      // line (daemon mid-append) leaves the offset BEFORE it so it is re-read
      // once its "\n" lands (crash-safety, design.md §D-3.2). Never fold this
      // run's own emitted reconstructed/policy rows as facts (kind gate skips
      // them; design.md §X-2).
      let newOffset = state.offset;
      const counts = streamLedgerLinesWithOffset(
        ledgerPath,
        (text, byteOffset, byteLength, terminated) => {
          if (terminated !== true) return;
          const end = byteOffset + byteLength + 1; // +1 for the "\n"
          if (end > newOffset) newOffset = end;
          let row;
          try {
            row = JSON.parse(text);
          } catch {
            return; // torn / malformed — skip (streamer torn-tolerance)
          }
          foldRowIntoState(state, row, minTs, filterSet);
        },
        { startOffset: state.offset },
      );
      result.bytes_scanned = counts.bytesScanned;
      if (newOffset > state.offset) state.offset = newOffset;
      // Refresh the tracked inode so a warm run observes the current ledger
      // identity (mirrors thread-aggregator.js) — the next tick's inode-change
      // self-heal compares against this.
      if (ledgerIno != null) state.ino = ledgerIno;
    }

    // PER-FACT EVICTION (design.md §D-3.3) — every run, even a re-run with ZERO
    // new appends: permanently drop facts that aged out below the (only-ever-
    // increasing) minTs, and delete now-empty buckets. This is what makes a
    // no-new-append re-run stop re-emitting aged-out buckets and shrink still-
    // live ones. NEVER whole-bucket eviction — a single UTC-week bucket can hold
    // facts both inside and outside the rolling window.
    for (const [bk, bucket] of state.buckets) {
      for (const [id, f] of bucket.facts) {
        if (f.factMs < minTs) bucket.facts.delete(id);
      }
      if (bucket.facts.size === 0) state.buckets.delete(bk);
    }

    result.checkpoint_offset = state.offset;

    // EMIT pass — build the transient Map<bucket_key, {..., facts:[{id,ts,content}]}>
    // where each bucket's facts are filtered to minTs <= factMs <= nowEpoch
    // (BOTH bounds — the upper bound drops future-ts facts THIS run exactly as
    // streamLedgerRowsInTimeWindow's nowMsCeil does in the flag-OFF path). The
    // shared driver then sorts/caps/summarizes/emits identically to flag-OFF.
    const transient = new Map();
    for (const bucket of state.buckets.values()) {
      const facts = [];
      for (const f of bucket.facts.values()) {
        if (f.factMs >= minTs && f.factMs <= nowEpoch) {
          facts.push({ id: f.id, ts: f.ts, content: f.content });
        }
      }
      if (facts.length === 0) continue; // no in-window facts → no bucket (matches buildProjects)
      transient.set(bucket.bucket_key, {
        source: bucket.source,
        project_id: bucket.project_id,
        bucket_key: bucket.bucket_key,
        week: bucket.week,
        facts,
      });
    }

    // Select the emitter's PIDX path (design.md §D-2.6 / §D-4.3): the incremental
    // branch sets ctx.useParentIndex = true so emitReconstruction avoids the
    // whole-ledger scanLedgerLines byId rebuild. The MCP agent path never sets
    // it → agent path stays on the old scan. Merged into emitterCtx so the shared
    // driver propagates it onto ctx.
    const onEmitterCtx = {
      ...(emitterCtx && typeof emitterCtx === "object" ? emitterCtx : {}),
      useParentIndex: true,
    };
    await emitProjectBuckets(transient, {
      ledgerPath,
      emitterCtx: onEmitterCtx,
      result,
    });
  } catch {
    // Never throw out of the tick — mirror the flag-OFF defensive returns. On a
    // fold/state error the run yields whatever counts accumulated; the next tick
    // re-reads (warm) or a restart pays the cold rescan.
  }

  return result;
}

// Test-only surface (internal helpers exposed so the W13 suite can unit-test
// the bucketing pipeline without invoking the emitter). resetIncrementalStateForTest /
// getIncrementalStateForTest drive the in-process fold state hermetically
// (design.md module map).
function resetIncrementalStateForTest() {
  _incrementalStateByPath.clear();
}
function getIncrementalStateForTest(ledgerPath) {
  return _incrementalStateByPath.get(ledgerPath) || null;
}

export const __internal = Object.freeze({
  parseLedgerLines,
  isoWeekBucket,
  resolveRowTs,
  extractProjectKey,
  readRawContent,
  buildProjects,
  buildSummary,
  nowMs,
  foldRowIntoState,
  emitProjectBuckets,
  resolveIncremental,
  resolveCheckpointPath,
  resetIncrementalStateForTest,
  getIncrementalStateForTest,
});
