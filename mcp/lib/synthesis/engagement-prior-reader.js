// engagement-prior-reader.js — N1-calibration WORKUNIT item (2): the minimal
// engagement prior that makes engagementPrior() non-inert.
//
// CONTEXT
//   multi-feature-score.engagementPrior(memory_id, opts) shipped as a v0 stub
//   (`return 0`). Its weight SCORE_WEIGHT_ENGAGEMENT_PRIOR is 0.0, so even a
//   non-zero weight bought nothing — the leg was doubly inert. To let the
//   calibration loop measure a real lift from the engagement weight, the prior
//   has to read SOMETHING. The cheapest in-scope substrate already exists: the
//   `policy.salience.recall_feedback` rows (single-producer
//   recall-feedback-emitter.js; 145 rows on the live ledger) carry, per recall,
//   the surfaced_memory_ids[] and a ts. A memory's `use_count` is simply how
//   many times it has appeared across those rows; `last_retrieved` is the max
//   ts. That is the classic use_count / last_retrieved engagement prior the
//   salience-design.md §R24.5 columns were reserved for.
//
//   This module is a READER, never a writer — it projects the EXISTING
//   recall-feedback rows into a Map<memory_id, engagement_prior>. No new
//   policy_kind, no fact-row mutation (thesis #1). It reuses the shared
//   append-aware tail-merge so the projection costs only the appended bytes on
//   the warm path, mirroring buildLatestBackfillMap.
//
// PRIOR FORMULA (bounded, recency-weighted; mirrors damping-reader discipline)
//   raw_count(m)   = # recall-feedback rows whose surfaced_memory_ids[] ⊇ {m}
//   recency(m)     = 1.0 if last_retrieved within WINDOW_DAYS, else linearly
//                    decays to RECENCY_FLOOR at 2*WINDOW_DAYS and stays there.
//   engagement_prior(m) = log1p(raw_count) * recency(m)
//
//   log1p compresses the count so a memory surfaced 50x does not get 50x the
//   weight of one surfaced once (a Plackett-Luce / doubly-robust estimator is
//   the v3 successor per the research report — this is the minimal v0 wire).
//   A memory never surfaced returns the NEUTRAL prior 0.0, so the scorer is
//   byte-identical when no map is provided OR a candidate is absent from it.
//
// DEFENSIVE DEGRADATION
//   Any read/parse failure → empty map → engagement_prior 0.0 everywhere. The
//   recall hot path is NEVER blocked by a recall-feedback-log fault (mirrors
//   damping-reader / corroboration-propagator).

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  appendAwareLedgerProjection,
  _resetAppendAwareProjectionCache,
} from "./append-aware-ledger-projection.js";
// Q4 FIX CYCLE 2 (memperf) — FIFTH PROJECTION: buildEngagementPriorMap was the
// last recall-path projection still full-scanning the multi-GB ledger on every
// fresh process (the remaining 2500ms blocker). The raw aggregate
// Map<memory_id, {count, last_ms}> is now persisted to a checkpoint-validated
// cache (S1 primitive) under STORAGE_DIR; a fresh process cold-seeds from it
// and folds ONLY the appended delta rows through the SAME _mergeFeedbackRow
// reducer (identical semantics by construction; equivalence gates prove it).
import {
  captureCheckpoint,
  deserializeCheckpoint,
  emptyCheckpoint,
  readAppended,
  serializeCheckpoint,
} from "./ledger-checkpoint.js";
import { STORAGE_DIR, memoryLedgerPath } from "../config.js";
import { RECALL_FEEDBACK_KIND } from "./recall-feedback-emitter.js";

/** Module version. Bump on any structural change. */
export const ENGAGEMENT_PRIOR_READER_VERSION = "v0.1.0";

/** Frozen CAPS for the engagement prior. v0 tunables; the calibration loop
 *  owns the SCORE_WEIGHT_ENGAGEMENT_PRIOR version-bump path (NOT these — these
 *  shape the prior itself, not its rank-time weight). */
export const ENGAGEMENT_PRIOR_CAPS = Object.freeze({
  NEUTRAL: 0.0,
  WINDOW_DAYS: 30,
  RECENCY_FLOOR: 0.25,
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Cache-partition id for the shared append-aware projection helper. Distinct
// from the feature-backfill namespace so the two projections never collide.
const ENGAGEMENT_PRIOR_PROJECTION_NS = "engagement-prior-reader";

/** Merge ONE ledger row into the raw-aggregate Map (pure; mutates the Map).
 *  Non-recall-feedback rows are ignored. For each surfaced memory_id we bump a
 *  count and track the latest ts. Returns true iff the row was a feedback row
 *  that mutated the map (the persist fold-guard's change signal). */
function _mergeFeedbackRow(map, row) {
  if (
    row == null ||
    row.kind !== "policy" ||
    row.policy_kind !== RECALL_FEEDBACK_KIND ||
    !Array.isArray(row.surfaced_memory_ids)
  ) {
    return false;
  }
  const ts = typeof row.ts === "string" ? row.ts : null;
  const tsMs = ts != null ? Date.parse(ts) : NaN;
  for (const mid of row.surfaced_memory_ids) {
    if (typeof mid !== "string" || mid.length === 0) continue;
    const prior = map.get(mid);
    if (prior == null) {
      map.set(mid, { count: 1, last_ms: Number.isFinite(tsMs) ? tsMs : 0 });
    } else {
      prior.count += 1;
      if (Number.isFinite(tsMs) && tsMs > prior.last_ms) prior.last_ms = tsMs;
    }
  }
  return true;
}

/** The ONE per-row apply shared by the warm tail-merge, the checkpoint delta
 *  fold, and the full rebuild — _mergeFeedbackRow plus a fold counter
 *  (`map._rowsApplied`, an expando on the Map — never serialized). The counter
 *  guards the scheduled persist: the count reduction is NOT idempotent
 *  (count += 1 per surfaced id), so a struct that folded rows AFTER the
 *  checkpoint pin would OVER-cover the persisted claim and double-count on the
 *  next cold load. Mirrors hard-gates' _rowsApplied discipline. */
function _applyFeedbackRow(map, row) {
  if (_mergeFeedbackRow(map, row)) {
    map._rowsApplied = (map._rowsApplied ?? 0) + 1;
  }
}

// ---------------------------------------------------------------------------
// Q4 FIX CYCLE 2 — persisted engagement-prior aggregate cache (checkpoint-
// validated cold seed). Pattern mirrors multi-feature-score.js
// _coldSeedBackfillMap: captureCheckpoint({prev}) pin-first; acceptance gated
// FAIL-CLOSED on the S1c flags (extendedPrev — verbatim witness extension — or
// prefixVerified — witness-cap re-baseline verified inside the capture call);
// any other outcome (shrink, rewrite, atomic replacement) is a discontinuity:
// full rebuild, never a hybrid of cached state + new-file delta. Exact-eof
// serves the cached aggregate with ZERO disk writes; the persist is atomic
// tmp+rename 0600, scheduled OFF the recall critical path.
// ---------------------------------------------------------------------------
// v2 (proto-key trap fix — mirrors hard-gates.js:654-662): the entries map now
// serializes as a proto-safe ENTRY-ARRAY [[k, value], ...] instead of a plain
// {} object, so a recall-feedback surfaced_memory_id === "__proto__" (or
// "constructor"/"prototype") round-trips losslessly instead of invoking the
// inherited object setter (which JSON-omits it and drops it on Object.keys()
// deserialize — a pathologically-named memory would then silently lose its
// engagement prior on the next cold load). The bump forces any pre-existing
// v1-format cache on disk to be IGNORED and rebuilt (migrate-by-rebuild), never
// fed to the v2 deserializer (which expects entry-arrays).
const ENGAGEMENT_CACHE_SCHEMA_VERSION = "v2";

// Size-gated re-baseline persist (see BACKFILL_PERSIST_DELTA_BYTES_CAP —
// same policy): feedback rows are rare, so most folds change nothing — but
// the persisted checkpoint must still advance periodically or a fresh
// process re-folds an ever-growing delta.
const ENGAGEMENT_PERSIST_DELTA_BYTES_CAP = 32 * 1024 * 1024; // 32 MiB, frozen

function _engagementCachePath() {
  return join(STORAGE_DIR, "engagement-prior-agg.cache.json");
}

// Last cold-seed outcome, observable by the equivalence tests.
let _lastEngagementColdStats = null;

/** Test-only: { mode, rows_folded } of the most recent cold engagement seed. */
export function __peekEngagementColdStatsForTests() {
  return _lastEngagementColdStats;
}

// In-flight best-effort persists (fire-and-forget off the recall path).
const _pendingEngagementPersists = new Set();

/** Await every in-flight scheduled engagement-cache persist (tests+scripts). */
export async function _awaitPendingEngagementPersists() {
  while (_pendingEngagementPersists.size > 0) {
    await Promise.all([..._pendingEngagementPersists]);
  }
}

/**
 * Schedule a best-effort atomic persist of the raw aggregate. NEVER awaited on
 * the recall path; errors swallowed. `rowsAppliedAtPin` guards interleaved
 * folds: the count reduction is non-idempotent, so if any feedback row folded
 * between the checkpoint pin and the write, the persist is skipped (the cache
 * simply stays at its previous, still-valid state).
 */
function _scheduleEngagementPersist(map, checkpoint, ledgerPath, rowsAppliedAtPin) {
  const cachePath = _engagementCachePath();
  const p = new Promise((resolve) => setImmediate(resolve))
    .then(async () => {
      if ((map._rowsApplied ?? 0) !== rowsAppliedAtPin) return; // interleaved fold
      // PROTO-KEY TRAP (v2): serialize as an ENTRY-ARRAY [[mid, rec], ...], never
      // a plain {} object. A surfaced memory_id can be the literal "__proto__" /
      // "constructor" / "prototype"; `entries[mid] = rec` on a plain object would
      // invoke the inherited setter and JSON would then omit the key entirely —
      // dropping that memory's engagement prior on the next cold load. Entry-arrays
      // are index-addressed, so hostile keys round-trip losslessly.
      const entries = [];
      for (const [mid, rec] of map) entries.push([mid, { count: rec.count, last_ms: rec.last_ms }]);
      const payload = {
        schema_version: ENGAGEMENT_CACHE_SCHEMA_VERSION,
        ledger_path: ledgerPath,
        checkpoint: serializeCheckpoint(checkpoint),
        built_at: new Date().toISOString(),
        entries,
      };
      const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
      try {
        await mkdir(dirname(cachePath), { recursive: true });
        await writeFile(tmpPath, JSON.stringify(payload), { mode: 0o600 });
        await rename(tmpPath, cachePath);
      } catch {
        try {
          await rm(tmpPath, { force: true });
        } catch {
          // best-effort tmp hygiene
        }
      }
    })
    .catch(() => {
      // Best-effort: a persist failure must never surface on the recall path.
    })
    .finally(() => {
      _pendingEngagementPersists.delete(p);
    });
  _pendingEngagementPersists.add(p);
}

// Deserialize the persisted entries back into an aggregate Map. Fail-closed:
// any structural surprise returns null → full rebuild.
//
// PROTO-KEY TRAP (v2): entries arrive as an ENTRY-ARRAY [[mid, rec], ...]; we
// map.set(mid, ...) so hostile keys ("__proto__", "constructor", "prototype")
// land as ordinary Map entries (Map has no __proto__ setter trap). Each entry
// MUST be a 2-tuple [string, rec]; any other shape (not an array, wrong arity,
// non-string key, invalid rec) is a structural surprise → return null so the
// caller rebuilds from scratch. The schema_version bump to v2 (validated in
// _coldSeedEngagementAgg) guarantees a legacy v1 plain-object cache is never
// routed here.
function _deserializeEngagementEntries(entries) {
  if (!Array.isArray(entries)) return null;
  const map = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [mid, rec] = entry;
    if (typeof mid !== "string") return null;
    if (
      rec == null ||
      typeof rec !== "object" ||
      typeof rec.count !== "number" ||
      !Number.isFinite(rec.count) ||
      rec.count <= 0 ||
      typeof rec.last_ms !== "number" ||
      !Number.isFinite(rec.last_ms)
    ) {
      return null;
    }
    map.set(mid, { count: rec.count, last_ms: rec.last_ms });
  }
  return map;
}

// Fold exactly the terminated rows in [fromCp.eof, toCp.eof) through the SAME
// _applyFeedbackRow the full scan and the warm tail-merge use.
function _foldFeedbackRows(ledgerPath, fromCp, toCp, map) {
  let rows = 0;
  const res = readAppended(ledgerPath, fromCp, toCp, (text) => {
    rows += 1;
    try {
      _applyFeedbackRow(map, JSON.parse(text));
    } catch {
      // A single malformed row never aborts the fold.
    }
  });
  return { rows, error: res.error };
}

/**
 * Q4 FIX CYCLE 2 cold seed: checkpoint-validated disk cache + delta fold, else
 * pin-first full rebuild. Returns the appendAwareLedgerProjection wrapped
 * shape { struct, resumeOffset } — resumeOffset is the pinned checkpoint eof
 * (the seed's EXACT byte coverage), so a row torn at seed time is re-read by
 * the warm grow once its "\n" lands, never permanently skipped.
 */
function _coldSeedEngagementAgg(ledgerPath) {
  const finish = (map, mode, rowsFolded, resumeOffset = null) => {
    _lastEngagementColdStats = { mode, rows_folded: rowsFolded };
    return { struct: map, resumeOffset };
  };
  const cachePath = _engagementCachePath();
  if (existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
      if (
        parsed != null &&
        parsed.schema_version === ENGAGEMENT_CACHE_SCHEMA_VERSION &&
        parsed.ledger_path === ledgerPath
      ) {
        const cachedCp = deserializeCheckpoint(parsed.checkpoint);
        if (cachedCp !== null) {
          // PIN FIRST, then read only bytes at/below the pinned eof.
          const newCp = captureCheckpoint(ledgerPath, { prev: cachedCp });
          if (
            newCp !== null &&
            (newCp.extendedPrev === true || newCp.prefixVerified === true)
          ) {
            const map = _deserializeEngagementEntries(parsed.entries);
            if (map !== null) {
              if (newCp.eof === cachedCp.eof) {
                return finish(map, "cache-hit-exact", 0, newCp.eof);
              }
              const appliedBefore = map._rowsApplied ?? 0;
              const { rows, error } = _foldFeedbackRows(ledgerPath, cachedCp, newCp, map);
              if (error === null) {
                const rebaselined = newCp.extendedPrev !== true;
                const deltaBytes = newCp.eof - cachedCp.eof;
                if (
                  (map._rowsApplied ?? 0) !== appliedBefore ||
                  rebaselined ||
                  deltaBytes > ENGAGEMENT_PERSIST_DELTA_BYTES_CAP
                ) {
                  _scheduleEngagementPersist(map, newCp, ledgerPath, map._rowsApplied ?? 0);
                }
                return finish(map, "incremental", rows, newCp.eof);
              }
              // Fold error between pin and read: discard the partial map.
            }
          }
        }
      }
    } catch {
      // Corrupt cache → full rebuild below.
    }
  }

  // FULL REBUILD — pin-first; the degraded fallback certifies nothing and
  // persists nothing.
  const cp = captureCheckpoint(ledgerPath);
  if (cp !== null) {
    const map = new Map();
    const { rows, error } = _foldFeedbackRows(ledgerPath, emptyCheckpoint(), cp, map);
    if (error === null) {
      _scheduleEngagementPersist(map, cp, ledgerPath, map._rowsApplied ?? 0);
      return finish(map, "full-rebuild", rows, cp.eof);
    }
  }
  return finish(new Map(), "full-rebuild-degraded", 0);
}

/** Recency multiplier in [RECENCY_FLOOR, 1.0] given an age in days. Fresh
 *  (≤ WINDOW_DAYS) → 1.0; linearly decays to RECENCY_FLOOR at 2*WINDOW_DAYS;
 *  flat at the floor beyond that. Future-dated / unknown ts → 1.0 (treat as
 *  fresh; the count signal still gates the magnitude). */
function _recencyMultiplier(lastMs, nowMs) {
  if (!Number.isFinite(lastMs) || lastMs <= 0) return 1.0;
  const ageDays = (nowMs - lastMs) / MS_PER_DAY;
  if (ageDays <= ENGAGEMENT_PRIOR_CAPS.WINDOW_DAYS) return 1.0;
  if (ageDays >= 2 * ENGAGEMENT_PRIOR_CAPS.WINDOW_DAYS) {
    return ENGAGEMENT_PRIOR_CAPS.RECENCY_FLOOR;
  }
  const frac =
    (ageDays - ENGAGEMENT_PRIOR_CAPS.WINDOW_DAYS) / ENGAGEMENT_PRIOR_CAPS.WINDOW_DAYS;
  return 1.0 - frac * (1.0 - ENGAGEMENT_PRIOR_CAPS.RECENCY_FLOOR);
}

/**
 * Build a Map<memory_id, engagement_prior> from the recall-feedback rows on a
 * ledger. Defensive: any IO failure → empty map (engagement_prior 0.0
 * everywhere). The returned priors are bounded scalars ≥ 0.
 *
 * @param {string} [ledgerPath] — defaults to memoryLedgerPath().
 * @param {number} [nowMs]      — deterministic-test "now" override.
 * @returns {Map<string, number>}
 */
export function buildEngagementPriorMap(ledgerPath, nowMs) {
  let path = ledgerPath;
  if (typeof path !== "string" || path.length === 0) {
    try {
      path = memoryLedgerPath();
    } catch {
      return new Map();
    }
  }
  // Q4 FIX CYCLE 2 — the COLD branch (first call in a fresh process) seeds
  // from the checkpoint-validated disk cache + delta fold via
  // _coldSeedEngagementAgg instead of full-scanning the multi-GB ledger.
  // PARTICIPATION GATE: only for the config-resolved production ledger
  // (memoryLedgerPath(), hermetic under env overrides) — tests that pass
  // arbitrary fixture paths keep the pure in-memory behavior and never touch
  // production storage/. The warm path is unchanged: the shared append-aware
  // tail-merge folds only the appended bytes through _applyFeedbackRow.
  let useDiskCache = false;
  try {
    useDiskCache = path === memoryLedgerPath();
  } catch {
    useDiskCache = false;
  }
  let agg;
  try {
    agg = appendAwareLedgerProjection({
      ledgerPath: path,
      namespace: ENGAGEMENT_PRIOR_PROJECTION_NS,
      makeEmpty: () => new Map(),
      applyParsedRow: _applyFeedbackRow,
      ...(useDiskCache
        ? {
            fullRebuild: (lp) => {
              if (!existsSync(lp)) return new Map();
              return _coldSeedEngagementAgg(lp);
            },
          }
        : {}),
    });
  } catch {
    return new Map();
  }
  if (!(agg instanceof Map)) return new Map();

  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const out = new Map();
  for (const [mid, rec] of agg) {
    if (rec == null || typeof rec.count !== "number" || rec.count <= 0) continue;
    const recency = _recencyMultiplier(rec.last_ms, now);
    const prior = Math.log1p(rec.count) * recency;
    if (Number.isFinite(prior) && prior > 0) out.set(mid, prior);
  }
  return out;
}

/** Resolve the engagement prior for a single memory_id from a prebuilt map.
 *  Absent map / absent id / non-finite → NEUTRAL (0.0). Pure; this is what the
 *  scorer's engagementPrior() delegates to so the hot path does no I/O. */
export function engagementPriorFromMap(map, memory_id) {
  if (!(map instanceof Map)) return ENGAGEMENT_PRIOR_CAPS.NEUTRAL;
  if (typeof memory_id !== "string" || memory_id.length === 0) {
    return ENGAGEMENT_PRIOR_CAPS.NEUTRAL;
  }
  const v = map.get(memory_id);
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    return ENGAGEMENT_PRIOR_CAPS.NEUTRAL;
  }
  return v;
}

/** Test-only: clear the shared append-aware projection cache so a fixture
 *  rebuild starts cold. Production code MUST NOT call this. */
export function __resetEngagementPriorCacheForTests() {
  _resetAppendAwareProjectionCache();
}
