// multi-feature-score.js — Phase 3 v0 recall scoring (Layer 2 RESCORE).
//
// AUTHORITATIVE spec source: kb/research-retrieval-frontiers.md
// (sections "Direct answer", "Recommended Phase 3 architecture", "Gemini
// integration specifics", "Staged rollout plan").
// Shape contract: kb/phase3-v0-contracts.md (§ 3
// ScoreComponents).
//
// Multi-feature score formula (multiplicative gates around additive soft
// features — NOT Park-style equal-weight additive):
//
//   base  = s_emb_full3072
//         * predicate_mask
//         * consent_dampener
//         * derivation_status
//         * episodicity_match
//
//   add   = w_ent * entity_overlap_jaccard
//         + w_t1  * time_anchor_match     (gated to 0 if no anchor)
//         + w_t2  * power_law_decay
//         + w_val * valence_compat
//         + w_eng * engagement_prior
//
//   final_score = base + add
//                 + w_damping * damping_coefficient    (W12; default 0)
//                 + w_corro   * corroboration_boost    (W12; default 0)
//
// W12 mutual-cycle closure (F-SYN-BEHAVIOR-corroboration-propagation +
// F-SYN-BEHAVIOR-damping-from-recall-log): both PRIORS are optional inputs
// resolved out of `candidate.priors` (a back-compat extension) and weighted
// by CAPS.SCORE_WEIGHT_DAMPING_PRIOR / SCORE_WEIGHT_CORROBORATION_PRIOR.
// Existing call sites that don't pass priors observe no behavior change —
// the additive contribution is exactly zero until the weights are flipped
// by the calibration loop AND the call site populates the scalars via
// damping-reader.computeDampingCoefficient and
// corroboration-propagator.computeCorroborationBoost.
//
// Weights sourced from CAPS (kb/phase3-v0-contracts.md § 8):
//   w_ent = CAPS.SCORE_WEIGHT_ENTITY_OVERLAP        (0.7)
//   w_t1  = CAPS.SCORE_WEIGHT_TIME_ANCHOR           (1.5)
//   w_t2  = CAPS.SCORE_WEIGHT_TIME_DECAY            (0.3)
//   w_val = CAPS.SCORE_WEIGHT_VALENCE               (0.2)
//   w_eng = CAPS.SCORE_WEIGHT_ENGAGEMENT_PRIOR      (0.0 in v0)
//
// Power-law forgetting curve per Wixted & Ebbesen 1997:
//   m * (1 + h*t)^(-f)   where t is age in DAYS
// Per-kind f exponents (from CAPS):
//   fact     -> 0.15
//   episodic -> 0.35
//   ambient  -> 0.6
//
// Determinism: every helper accepts an `opts.now` (ISO-8601 string) override
// for tests. We import serverTs from envelope.js — the same helper
// validation.js's RFC 3339 stamping flows through.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
// WU-incrementalize-recall-recomputes — buildLatestBackfillMap scanned the
// ENTIRE 1.82 GB ledger on every production query (~4.5 s warm) because the old
// cache key (mtimeMs + sizeBytes) moved on every daemon append. The shared
// append-aware tail-merge replays ONLY the appended bytes through the SAME
// latest-wins reduction.
import {
  appendAwareLedgerProjection,
  _resetAppendAwareProjectionCache,
} from "../synthesis/append-aware-ledger-projection.js";
// Q4 (memperf) — a FRESH process previously paid the full multi-GB backfill
// scan on its first recall (~3.3s cold). The latest-wins map is now persisted
// to a checkpoint-validated cache (S1 primitive) under STORAGE_DIR; a fresh
// process cold-seeds from it and folds ONLY the appended delta rows through
// the SAME _mergeBackfillRow reducer.
import {
  captureCheckpoint,
  deserializeCheckpoint,
  emptyCheckpoint,
  readAppended,
  serializeCheckpoint,
} from "../synthesis/ledger-checkpoint.js";
import { STORAGE_DIR, memoryLedgerPath } from "../config.js";

// Cache-partition id for the shared append-aware projection helper.
const BACKFILL_PROJECTION_NS = "feature-backfill";

import { CAPS } from "../validation.js";
import { serverTs } from "../envelope.js";
// Wave 6 — synthesis-side episodicity match. The local episodicityMatch
// stub below is preserved (legacy callers depend on its 1.0 return); the
// new synthesisEpisodicityMatch wraps the substrate's 2-arg form, which is
// what computeScore now calls when both candidate and query episodicity
// scalars are present.
import { episodicityMatch as synthesisEpisodicityMatch } from "../synthesis/episodicity-scorer.js";
import {
  SLUG_EMPTY_SENTINEL,
  isNoiseEntityMatchKey,
  slugify,
} from "../synthesis/entity-extractor.js";
// W3-CCS — F-CCS-BACKFILL-recall-consumer.
// Read the policy_kind discriminator from the engine's exported constant so
// we never inline the literal here (single-producer CI guard).
import { FEATURE_BACKFILL_KIND } from "../synthesis/feature-backfill.js";

/** D2 — the env flag that ABLATES the episodicity multiplier. Default OFF.
 *  Exported as a single frozen source of truth (mirrors
 *  score-weight-overlay.js SCORE_WEIGHTS_ENV) so the runbook and the tests
 *  never grep for the string literal.
 *
 *  Measured motivation: `features.episodicity` is stamped in [0.136, 0.461]
 *  (W_INTERCEPT=-1.5 plus an unstamped corroboration_count, so W_CORRO is
 *  dead), while the recall-time populator emits query_episodicity = 0.1359
 *  on 256/265 logged recalls. episodicityMatch is 1 - |f - q|, so live the
 *  multiplier collapses to 1.1359 - f: a term FALLING in the candidate's own
 *  episodicity — an anti-episodic prior over [0.675, 1.0] that no calibration
 *  ever chose. This flag lets the operator measure recall with the term
 *  removed before deciding whether to re-fit or delete it.
 *
 *  ONLY the exact string "1" enables it. Unset, "0", "", "true" and "yes"
 *  all leave every score bit-identical. */
export const EPISODICITY_ABLATE_ENV = Object.freeze({
  ENABLED: "MEMORY_SCORE_EPISODICITY_ABLATE",
});

/** D3 — opt in to IDF-weighted entity overlap. Default OFF. */
export const ENTITY_IDF_ENV = Object.freeze({
  ENABLED: "MEMORY_ENTITY_IDF_ENABLED",
});

/** L8 — opt in to dropping read-side entity NOISE (conversational role labels
 *  and conversation-id uuid topics) from the entity_overlap key sets.
 *  Default OFF.
 *
 *  THE RULE: a noise key is dropped only when it appears in exactly one of the
 *  two key sets; a noise key present in both is retained. The intersection is
 *  therefore bit-identical between flag states and only union-only members are
 *  removed, so the score is non-decreasing and can never cross zero in either
 *  direction. See dropUnpairedNoise below for the mechanism.
 *
 *  The vocabulary lives beside STOPWORDS in synthesis/entity-extractor.js as
 *  ENTITY_NOISE_ROLE_SURFACES / ENTITY_NOISE_UUID_SLUG_RE and is applied here
 *  via the pure isNoiseEntityMatchKey. This is a rerank-only filter: it lives
 *  strictly inside the two overlap functions and never changes which rows
 *  enter the candidate pool, and it mutates no stored data — unsetting the
 *  flag reverts it completely.
 *
 *  ONLY the exact string "1" enables it. Unset, "0", "", "true" and "yes"
 *  all leave every score bit-identical. */
export const ENTITY_NOISE_FILTER_ENV = Object.freeze({
  ENABLED: "MEMORY_ENTITY_NOISE_FILTER",
});

/** Call-time read of ENTITY_NOISE_FILTER_ENV — never cached at module load, so
 *  a test can toggle it in-process. Same `env` resolution idiom as
 *  computeScore's `scoringEnv`: an explicit env object wins, else process.env,
 *  else {}. */
function noiseFilterEnabled(env) {
  const resolved =
    env != null && typeof env === "object"
      ? env
      : typeof process !== "undefined" && process.env
        ? process.env
        : {};
  return resolved[ENTITY_NOISE_FILTER_ENV.ENABLED] === "1";
}

// ---------------------------------------------------------------------------
// W3-CCS — F-CCS-BACKFILL-recall-consumer.
//
// Spec: docs/specs/ccs/feature-backfill-policy.md § 4 (overlay semantics).
//
// The 83 historical facts on memory.jsonl were promoted BEFORE the W2-W6
// extractor stack existed, so their features payloads carry {embedding,
// salience} only. Re-stamping the fact rows in-place is forbidden by
// thesis #1 (the ledger is permanent). Instead the W3 engine appends ONE
// policy.feature_backfill row per fact carrying the extractor outputs as a
// features_overlay; this consumer reads those rows at recall time and
// overlays them onto the in-memory candidate BEFORE scoring.
//
// CRITICAL: the overlay is an in-memory transform. The original fact row
// MUST NOT be mutated — applyBackfillOverlay returns a NEW candidate
// object (per spec §4.2). Mutating the cached candidate would leak the
// overlay into a subsequent read where the recall pipeline expects to see
// the original row's features.
// ---------------------------------------------------------------------------

/** Closed v1 channel set (mirror of feature-backfill.js OVERLAY_CHANNELS_V1).
 *  Inlined here to avoid the consumer pulling the engine's full export
 *  surface; documented as a closed set per spec §3.2. Consumer SHOULD
 *  drift-check against the engine export at module init. */
const BACKFILL_OVERLAY_CHANNELS = Object.freeze([
  "entities",
  "time_anchors",
  "valence",
  "episodicity",
]);

/** Cache age ceiling — RETAINED for back-compat export only. The W3 spec §4.5
 *  used this 60 s ceiling to bound a stuck-mtime stale projection; the
 *  WU-incrementalize-recall-recomputes append-aware tail-merge replaces that
 *  mechanism (it re-stats on every call and tail-merges any growth, so the
 *  projection is never stale), but the constant stays exported so existing
 *  callers/tests that read it keep working. */
export const LATEST_BACKFILL_CACHE_MAX_AGE_MS = 60_000;

/**
 * Build (or fetch from cache) the latest-backfill map for a ledger path.
 * Spec §4.1: stream ledger, filter policy.feature_backfill, group by
 * target_fact_id, select max(backfill_version) per group (tie-break ts
 * then id). Map<fact_id, FeatureBackfillEvent>.
 *
 * Defensive: any IO failure returns an empty map (the consumer degrades
 * to "no overlay" — original fact features stand alone).
 *
 * @param {string} ledgerPath
 * @returns {Map<string, object>}
 */
export function buildLatestBackfillMap(ledgerPath) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    return new Map();
  }
  if (!existsSync(ledgerPath)) return new Map();
  // WU-incrementalize-recall-recomputes — the shared append-aware tail-merge.
  //
  // The old key (mtimeMs + sizeBytes + builtAtMs<60s) MISSED on every
  // production query because the daemon bumps both mtime AND size on every
  // append; buildLatestBackfillMap then re-streamed the WHOLE 1.82 GB ledger to
  // find ~83 policy.feature_backfill rows (~4.5 s warm). Now the module-scope
  // cache tail-merges ONLY the appended bytes through the SAME latest-wins
  // reduction (_mergeBackfillRow). CORRECTNESS: the reduction is monotonic —
  // an appended row can only ADD a new target_fact_id or OVERRIDE an existing
  // one when its (version, ts, id) is greater — so replaying the appended tail
  // against the cached Map is byte-identical to a full rebuild. The 60 s
  // staleness ceiling is no longer needed (the tail-merge keeps it fresh); we
  // keep the constant exported for back-compat. The cache holds size + mtimeMs
  // and falls back to a full rebuild on shrink / mtime-regression.
  //
  // Q4 — the COLD branch (first call in a fresh process) seeds from a
  // checkpoint-validated disk cache + delta fold via _coldSeedBackfillMap.
  // PARTICIPATION GATE: only for the config-resolved production ledger
  // (memoryLedgerPath(), hermetic under env overrides) — tests that pass
  // arbitrary fixture paths keep the pure in-memory behavior and never touch
  // production storage/.
  const useDiskCache = ledgerPath === memoryLedgerPath();
  const map = appendAwareLedgerProjection({
    ledgerPath,
    namespace: BACKFILL_PROJECTION_NS,
    makeEmpty: () => new Map(),
    applyParsedRow: _mergeBackfillRow,
    ...(useDiskCache
      ? {
          fullRebuild: (lp) => {
            if (!existsSync(lp)) return new Map();
            return _coldSeedBackfillMap(lp);
          },
        }
      : {}),
  });
  // appendAwareLedgerProjection returns null only when the ledger is missing
  // (handled above) or on bad args — degrade to an empty map defensively.
  return map instanceof Map ? map : new Map();
}

// ---------------------------------------------------------------------------
// Q4 — persisted latest-backfill cache (checkpoint-validated cold seed).
// ---------------------------------------------------------------------------
// v2 (proto-key trap fix — mirrors hard-gates.js:654-662): the entries map now
// serializes as a proto-safe ENTRY-ARRAY [[k, value], ...] instead of a plain
// {} object, so a target_fact_id === "__proto__" (or "constructor"/"prototype")
// round-trips losslessly instead of invoking the inherited object setter (which
// JSON-omits it and drops it on Object.keys() deserialize — a pathologically-
// named fact would then silently lose its feature overlay on the next cold
// load). The bump forces any pre-existing v1-format cache on disk to be IGNORED
// and rebuilt (migrate-by-rebuild), never fed to the v2 deserializer (which
// expects entry-arrays).
const BACKFILL_CACHE_SCHEMA_VERSION = "v2";

// Size-gated re-baseline persist: backfill rows are rare (~83 ever), so the
// map usually gains nothing on a fold — but the checkpoint must still advance
// periodically or a fresh process re-folds an ever-growing delta.
const BACKFILL_PERSIST_DELTA_BYTES_CAP = 32 * 1024 * 1024; // 32 MiB, frozen

function _backfillCachePath() {
  return join(STORAGE_DIR, "feature-backfill-map.cache.json");
}

// Last cold-seed outcome, observable by the equivalence tests.
let _lastBackfillColdStats = null;

/** Test-only: { mode, rows_folded } of the most recent cold backfill seed. */
export function __peekBackfillColdStatsForTests() {
  return _lastBackfillColdStats;
}

// In-flight best-effort persists (fire-and-forget off the recall path).
const _pendingBackfillPersists = new Set();

/** Await every in-flight scheduled backfill-cache persist (tests + scripts). */
export async function _awaitPendingBackfillCachePersists() {
  while (_pendingBackfillPersists.size > 0) {
    await Promise.all([..._pendingBackfillPersists]);
  }
}

// Fire-and-forget atomic persist (tmp+rename, 0600). Over-coverage from a
// grow tail-merge landing between schedule and write is SAFE here: the
// latest-wins reduction is idempotent (re-folding a row already reflected in
// the map reproduces the identical map), so no fold guard is needed.
function _scheduleBackfillPersist(map, checkpoint, ledgerPath) {
  const cachePath = _backfillCachePath();
  const p = new Promise((resolve) => setImmediate(resolve))
    .then(async () => {
      // PROTO-KEY TRAP (v2): serialize as an ENTRY-ARRAY [[k, v], ...], never a
      // plain {} object. A target_fact_id can be the literal "__proto__" /
      // "constructor" / "prototype"; `entries[k] = v` on a plain object would
      // invoke the inherited setter and JSON would then omit the key entirely —
      // dropping that fact's overlay on the next cold load. Entry-arrays are
      // index-addressed, so hostile keys round-trip losslessly.
      const entries = [];
      for (const [k, v] of map) entries.push([k, v]);
      const payload = {
        schema_version: BACKFILL_CACHE_SCHEMA_VERSION,
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
      _pendingBackfillPersists.delete(p);
    });
  _pendingBackfillPersists.add(p);
}

// Deserialize the persisted entries back into a Map. Fail-closed: any
// structural surprise returns null → full rebuild.
//
// PROTO-KEY TRAP (v2): entries arrive as an ENTRY-ARRAY [[k, v], ...]; we
// map.set(k, ...) so hostile keys ("__proto__", "constructor", "prototype")
// land as ordinary Map entries (Map has no __proto__ setter trap). Each entry
// MUST be a 2-tuple [string, object]; any other shape (not an array, wrong
// arity, non-string key, non-object value) is a structural surprise → return
// null so the caller rebuilds from scratch. The schema_version bump to v2
// (validated in _coldSeedBackfillMap) guarantees a legacy v1 plain-object cache
// is never routed here.
function _deserializeBackfillEntries(entries) {
  if (!Array.isArray(entries)) return null;
  const map = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [k, v] = entry;
    if (typeof k !== "string") return null;
    if (v == null || typeof v !== "object") return null;
    map.set(k, v);
  }
  return map;
}

// Fold exactly the terminated rows in [fromCp.eof, toCp.eof) through the SAME
// _mergeBackfillRow reducer the full scan and the warm tail-merge use.
function _foldBackfillRows(ledgerPath, fromCp, toCp, map) {
  let rows = 0;
  const res = readAppended(ledgerPath, fromCp, toCp, (text) => {
    rows += 1;
    try {
      _mergeBackfillRow(map, JSON.parse(text));
    } catch {
      // A single malformed row never aborts the fold.
    }
  });
  return { rows, error: res.error };
}

/**
 * Q4 cold seed: checkpoint-validated disk cache + delta fold, else pin-first
 * full rebuild (mirrors content-index.js v2; see _coldSeedScanStruct in
 * hard-gates.js for the shared flow narrative). Exact-eof serves the cached
 * map with ZERO disk writes; discontinuity fails closed into a full rebuild.
 */
function _coldSeedBackfillMap(ledgerPath) {
  // FIX CYCLE 2: return the appendAwareLedgerProjection wrapped shape
  // { struct, resumeOffset } — resumeOffset is the pinned checkpoint eof, so
  // the projection layer resumes the next grow-merge there instead of at raw
  // st.size and a row torn at seed time folds once its "\n" lands. The
  // degraded path (no checkpoint) reports null → historical raw-size resume.
  const finish = (map, mode, rowsFolded, resumeOffset = null) => {
    _lastBackfillColdStats = { mode, rows_folded: rowsFolded };
    return { struct: map, resumeOffset };
  };
  const cachePath = _backfillCachePath();
  if (existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
      if (
        parsed != null &&
        parsed.schema_version === BACKFILL_CACHE_SCHEMA_VERSION &&
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
            const map = _deserializeBackfillEntries(parsed.entries);
            if (map !== null) {
              if (newCp.eof === cachedCp.eof) {
                return finish(map, "cache-hit-exact", 0, newCp.eof);
              }
              const sizeBefore = map.size;
              const { rows, error } = _foldBackfillRows(ledgerPath, cachedCp, newCp, map);
              if (error === null) {
                const rebaselined = newCp.extendedPrev !== true;
                const deltaBytes = newCp.eof - cachedCp.eof;
                if (
                  map.size !== sizeBefore ||
                  rebaselined ||
                  deltaBytes > BACKFILL_PERSIST_DELTA_BYTES_CAP
                ) {
                  _scheduleBackfillPersist(map, newCp, ledgerPath);
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

  // FULL REBUILD — pin-first; the tolerant fallback certifies nothing and
  // persists nothing.
  const cp = captureCheckpoint(ledgerPath);
  if (cp !== null) {
    const map = new Map();
    const { rows, error } = _foldBackfillRows(ledgerPath, emptyCheckpoint(), cp, map);
    if (error === null) {
      _scheduleBackfillPersist(map, cp, ledgerPath);
      return finish(map, "full-rebuild", rows, cp.eof);
    }
  }
  return finish(new Map(), "full-rebuild-degraded", 0);
}

/**
 * Merge ONE ledger row into the latest-backfill Map (spec §4.1.4 latest-wins).
 * Non-backfill rows are ignored. Latest wins by backfill_version, then ts,
 * then id. Pure: only mutates the supplied Map. Shared by the cold rebuild and
 * the tail-merge so both paths apply byte-identical reduction semantics.
 */
function _mergeBackfillRow(map, row) {
  if (
    row == null ||
    row.kind !== "policy" ||
    row.policy_kind !== FEATURE_BACKFILL_KIND ||
    typeof row.target_fact_id !== "string"
  ) {
    return;
  }
  const tgt = row.target_fact_id;
  const prior = map.get(tgt);
  if (prior == null) {
    map.set(tgt, row);
    return;
  }
  const priorV = typeof prior.backfill_version === "number" ? prior.backfill_version : 0;
  const rowV = typeof row.backfill_version === "number" ? row.backfill_version : 0;
  if (rowV > priorV) {
    map.set(tgt, row);
  } else if (rowV === priorV) {
    const priorTs = typeof prior.ts === "string" ? prior.ts : "";
    const rowTs = typeof row.ts === "string" ? row.ts : "";
    if (rowTs > priorTs) {
      map.set(tgt, row);
    } else if (rowTs === priorTs) {
      const priorId = typeof prior.id === "string" ? prior.id : "";
      const rowId = typeof row.id === "string" ? row.id : "";
      if (rowId > priorId) map.set(tgt, row);
    }
  }
}

/**
 * Apply a feature-backfill overlay to a candidate IN MEMORY (spec §4.2).
 *
 *   - Returns a NEW candidate object (input is NOT mutated).
 *   - Per-channel REPLACE rule (§4.3): the overlay channel REPLACES the
 *     original; absent channels preserve the original.
 *   - Unknown channels in the overlay are IGNORED (consumer is conservative;
 *     the engine fail-shuts on emit so an unknown channel should never
 *     reach disk).
 *
 * @param {object} candidate
 * @param {Map<string, object>} latestBackfillMap
 * @returns {object} new candidate (or the input if no overlay applies)
 */
export function applyBackfillOverlay(candidate, latestBackfillMap) {
  if (candidate == null || typeof candidate !== "object") return candidate;
  if (!(latestBackfillMap instanceof Map)) return candidate;
  // Spec §10.5 / §4.1: lookup by candidate.id (fact row id) OR
  // candidate.memory_id (recall-side alias) — recall.js populates both,
  // older call sites only memory_id.
  const lookupId =
    typeof candidate.id === "string" && candidate.id.length > 0
      ? candidate.id
      : typeof candidate.memory_id === "string" && candidate.memory_id.length > 0
        ? candidate.memory_id
        : null;
  if (lookupId == null) return candidate;
  const backfill = latestBackfillMap.get(lookupId);
  if (backfill == null) return candidate;
  const overlay =
    backfill.features_overlay != null &&
    typeof backfill.features_overlay === "object"
      ? backfill.features_overlay
      : null;
  if (overlay == null) return candidate;
  const originalFeatures =
    candidate.features != null && typeof candidate.features === "object"
      ? candidate.features
      : {};
  const overlaidFeatures = { ...originalFeatures };
  for (const channel of BACKFILL_OVERLAY_CHANNELS) {
    if (overlay[channel] !== undefined) {
      overlaidFeatures[channel] = overlay[channel];
    }
  }
  // Surface the canonical entities[] list also at candidate.entities (the
  // shape computeScore reads for entity_overlap). The scorer reads
  // candidate.entities as a string[]; the overlay entities are objects
  // with canonical_id — flatten to canonical_id strings so the existing
  // jaccard path fires without further refactor. Original candidate.entities
  // wins if the overlay does not carry entities (per per-channel REPLACE).
  if (Array.isArray(overlaidFeatures.entities)) {
    const ids = [];
    for (const e of overlaidFeatures.entities) {
      if (e != null && typeof e === "object" && typeof e.canonical_id === "string") {
        ids.push(e.canonical_id);
      } else if (typeof e === "string") {
        ids.push(e);
      }
    }
    return { ...candidate, features: overlaidFeatures, entities: ids };
  }
  return { ...candidate, features: overlaidFeatures };
}

/** Test-only: clear the module-level cache so a fixture rebuild starts
 *  cold. Production code MUST NOT call this. */
export function __resetBackfillCacheForTests() {
  // WU-incrementalize-recall-recomputes — clears the shared append-aware
  // projection cache (ALL namespaces, including this module's backfill
  // namespace). Hermetic tests that rewrite their fixture ledger in place
  // (NOT append-only) rely on this to force a clean cold rebuild on the next
  // buildLatestBackfillMap call.
  _resetAppendAwareProjectionCache();
}

// ---------------------------------------------------------------------------
// Per-kind f exponents for the power-law decay curve.
// ---------------------------------------------------------------------------
const POWER_LAW_F_BY_KIND = Object.freeze({
  fact: CAPS.POWER_LAW_F_FACT,
  episodic: CAPS.POWER_LAW_F_EPISODIC,
  ambient: CAPS.POWER_LAW_F_AMBIENT,
});

// One day in milliseconds; used to convert age-ms to age-days for the curve.
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// nowIso(opts): centralized "what time is it" for the module. Tests pass
// opts.now to make computations deterministic; production callers omit it and
// pick up serverTs() (which itself calls new Date().toISOString()).
// ---------------------------------------------------------------------------
function nowIso(opts) {
  if (opts != null && typeof opts.now === "string" && opts.now !== "") {
    return opts.now;
  }
  return serverTs();
}

// ---------------------------------------------------------------------------
// entityMatchKey(canonical_id): drop the SOURCE segment from a canonical_id so
// the same entity matches across the connector it was observed through.
//
// canonical_id is `${kind}:${source}:${slug}` (entity-extractor.js:276). The
// source segment records WHERE an entity was seen, not WHICH entity it is —
// the file path mcp/lib/tools/recall.js is the same artifact whether it
// surfaced via git-log, telegram, or a chat turn.
//
// Why this matters: the recall query side stamps a FIXED source (recall.js
// hardcodes "chat-claude-code" for the populator's extractEntities call),
// while fact-side ids carry whichever connector ingested the row. Measured
// distribution over 2,382 recent entity mentions: telegram 1101, codex-cli
// 642, chat-claude-code 320, git-log 137, manual 72, whatsapp 52, imessage
// 24, mail 18, github-events 16. Under exact set intersection the query side
// could only ever match the 13% of facts that happened to arrive through
// chat-claude-code, so entity_overlap contributed ~0 to nearly every score —
// a weighted scoring feature silently returning no signal.
//
// Colon-safe: only the FIRST two segments are structural, so a slug
// containing ':' survives intact. Ids with fewer than two colons (legacy or
// test fixtures like "n1") pass through unchanged.
// ---------------------------------------------------------------------------
export function entityMatchKey(canonical_id) {
  if (typeof canonical_id !== "string" || canonical_id === "") return null;
  const first = canonical_id.indexOf(":");
  if (first < 0) return canonical_id;
  const second = canonical_id.indexOf(":", first + 1);
  if (second < 0) return canonical_id;
  return canonical_id.slice(0, first + 1) + canonical_id.slice(second + 1);
}

// ---------------------------------------------------------------------------
// dropUnpairedNoise(a, b): the L8 read-side noise filter, in ONE place so the
// weighted and unweighted overlap paths cannot drift apart.
//
// Rule: a noise key is removed only when it appears in exactly ONE of the two
// key sets. A noise key present in BOTH is real matching evidence — the two
// rows genuinely share it — so it is retained.
//
// Why the membership tests must read the ORIGINAL sets: both drop lists are
// collected before either set is mutated, which makes the pass symmetric and
// independent of the order the two sets are visited in.
//
// Consequence (this is the invariant, and it is structural rather than
// incidental): the intersection a ∩ b is bit-identical before and after this
// call, because no key is added and no shared key is removed. Only union-only
// members can leave. Both overlap functions are therefore non-decreasing under
// the filter, and neither can cross zero in either direction — an empty
// intersection stays empty, and a non-empty one keeps at least one member on
// each side, so the `a.size === 0 || b.size === 0` guard cannot fire on it.
//
// Mutates both sets in place; the caller owns them and they are local.
// ---------------------------------------------------------------------------
function dropUnpairedNoise(a, b) {
  const dropA = [];
  for (const k of a) {
    if (isNoiseEntityMatchKey(k) && !b.has(k)) dropA.push(k);
  }
  const dropB = [];
  for (const k of b) {
    if (isNoiseEntityMatchKey(k) && !a.has(k)) dropB.push(k);
  }
  for (const k of dropA) a.delete(k);
  for (const k of dropB) b.delete(k);
}

// ---------------------------------------------------------------------------
// entityOverlapJaccard(candidate_entities, context_entities): standard Jaccard
// over two string arrays, compared SOURCE-AGNOSTICALLY via entityMatchKey.
// Returns 0 when either side is empty (no signal). Inputs are NOT mutated;
// case-folding/normalization is the caller's job (entries on IndexEntry are
// pre-lowercased + deduped per the contract).
//
// Jaccard is computed over the normalized key sets, so two ids differing only
// by source collapse to one member on each side — |A|, |B| and the
// intersection all stay consistent and the ratio remains in [0, 1].
// ---------------------------------------------------------------------------
export function entityOverlapJaccard(candidate_entities, context_entities, env) {
  if (!Array.isArray(candidate_entities) || !Array.isArray(context_entities)) {
    return 0;
  }
  if (candidate_entities.length === 0 || context_entities.length === 0) {
    return 0;
  }
  // L8 — the key sets are built UNFILTERED, exactly as the flag-off path does.
  const a = new Set();
  for (const x of candidate_entities) {
    const k = entityMatchKey(x);
    if (k !== null) a.add(k);
  }
  const b = new Set();
  for (const x of context_entities) {
    const k = entityMatchKey(x);
    if (k !== null) b.add(k);
  }
  // The filter is a no-op unless the flag is on; when off, nothing below runs.
  if (noiseFilterEnabled(env)) dropUnpairedNoise(a, b);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) {
    if (b.has(x)) intersection++;
  }
  // |A union B| = |A| + |B| - |A intersect B|.
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

// ---------------------------------------------------------------------------
// entityOverlapIdf(candidate_entities, context_entities, entity_df,
//                  entity_df_n, attribution): weighted Jaccard over the SAME
// source-agnostic entityMatchKey sets as entityOverlapJaccard.
//
// entity_df is a caller-supplied Map/object of entityMatchKey -> document
// frequency (a Set value is also accepted, matching BM25Index._entityIndex's
// in-memory value shape). The scorer never reads the ledger or builds an
// index. Unknown keys use df=1. Every weight uses the positive BM25 IDF:
//   ln((N - df + 0.5) / (df + 0.5) + 1)
//
// H6 residual: promoted messaging facts already carry the direct-vs-room
// distinction in features.attribution. A group/supergroup/channel peer name
// is ambient room context rather than a direct human sender, so its effective
// df is floored at N (the minimum positive IDF). Sender entities and DM peers
// retain their measured df. This consumes the existing closed attribution
// subset without re-kinding or rewriting any canonical_id.
// ---------------------------------------------------------------------------
export function entityOverlapIdf(
  candidate_entities,
  context_entities,
  entity_df,
  entity_df_n,
  attribution = null,
  env,
) {
  if (!Array.isArray(candidate_entities) || !Array.isArray(context_entities)) {
    return 0;
  }
  if (candidate_entities.length === 0 || context_entities.length === 0) {
    return 0;
  }
  if (!(typeof entity_df_n === "number" && Number.isFinite(entity_df_n) && entity_df_n >= 1)) {
    // L8 — forward `env`: the two paths must never disagree about flag state.
    return entityOverlapJaccard(candidate_entities, context_entities, env);
  }

  // L8 — same rule as entityOverlapJaccard: build unfiltered, then drop only
  // the noise keys that are NOT shared. Every weight below is strictly
  // positive (df is clamped to [1, N], so idf >= ln(0.5/(N+0.5) + 1) > 0), so
  // an unchanged intersectionWeight over a non-increasing unionWeight is
  // non-decreasing — the same proof as the unweighted path.
  const a = new Set();
  for (const raw of candidate_entities) {
    const key = entityMatchKey(raw);
    if (key !== null) a.add(key);
  }
  const b = new Set();
  for (const raw of context_entities) {
    const key = entityMatchKey(raw);
    if (key !== null) b.add(key);
  }
  if (noiseFilterEnabled(env)) dropUnpairedNoise(a, b);
  if (a.size === 0 || b.size === 0) return 0;

  const N = entity_df_n;
  const channelPeerKeys = new Set();
  if (attribution != null && typeof attribution === "object" && !Array.isArray(attribution)) {
    const peerType = typeof attribution.peer_type === "string"
      ? attribution.peer_type.toLowerCase()
      : "";
    if (peerType === "group" || peerType === "supergroup" || peerType === "channel") {
      for (const field of ["peer_name", "peer_id"]) {
        const value = attribution[field];
        if ((typeof value === "string" && value.length > 0) ||
            (typeof value === "number" && Number.isFinite(value))) {
          const slug = slugify(String(value));
          if (slug !== SLUG_EMPTY_SENTINEL) channelPeerKeys.add(`person:${slug}`);
        }
      }
    }
  }

  const documentFrequency = (key) => {
    let rawDf;
    if (entity_df instanceof Map) {
      rawDf = entity_df.get(key);
    } else if (entity_df != null && typeof entity_df === "object" &&
               Object.prototype.hasOwnProperty.call(entity_df, key)) {
      rawDf = entity_df[key];
    }
    if (rawDf instanceof Set) rawDf = rawDf.size;
    let df = typeof rawDf === "number" && Number.isFinite(rawDf) && rawDf >= 1
      ? rawDf
      : 1;
    df = Math.min(N, Math.max(1, df));
    if (channelPeerKeys.has(key)) df = N;
    return df;
  };
  const idf = (key) => {
    const df = documentFrequency(key);
    return Math.log((N - df + 0.5) / (df + 0.5) + 1);
  };

  let intersectionWeight = 0;
  let unionWeight = 0;
  const union = new Set([...a, ...b]);
  for (const key of union) {
    const weight = idf(key);
    unionWeight += weight;
    if (a.has(key) && b.has(key)) intersectionWeight += weight;
  }
  if (!(unionWeight > 0) || !Number.isFinite(unionWeight)) return 0;
  const score = intersectionWeight / unionWeight;
  if (!Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, score));
}

// ---------------------------------------------------------------------------
// timeAnchorMatch(candidate_ts, context_time_anchor, opts): step function over
// the absolute distance between the candidate's timestamp and the resolved
// time anchor on the surrounding context.
//
//   no anchor   -> 0
//   |delta| <= 1 day   -> 1.0
//   |delta| <= 7 days  -> 0.5
//   otherwise          -> 0.0
//
// v0 anchor resolution: anchors are ISO-8601 timestamps OR null.
// Natural-language anchor resolution (HeidelTime / SUTime / LLM) is v2.
// ---------------------------------------------------------------------------
export function timeAnchorMatch(candidate_ts, context_time_anchor, opts) {
  // opts is accepted for API symmetry with the other helpers and to leave
  // room for v2 anchor-resolution to use it (e.g. now-relative anchors).
  void opts;
  if (context_time_anchor == null || context_time_anchor === "") return 0;
  if (typeof candidate_ts !== "string" || candidate_ts === "") return 0;

  const candEpoch = Date.parse(candidate_ts);
  const anchorEpoch = Date.parse(context_time_anchor);
  if (!Number.isFinite(candEpoch) || !Number.isFinite(anchorEpoch)) return 0;

  const deltaMs = Math.abs(candEpoch - anchorEpoch);
  const deltaDays = deltaMs / MS_PER_DAY;
  if (deltaDays <= 1) return 1.0;
  if (deltaDays <= 7) return 0.5;
  return 0.0;
}

// ---------------------------------------------------------------------------
// powerLawDecay({ ts, kind, opts }): Wixted & Ebbesen 1997 retention curve.
//
//   m * (1 + h*t)^(-f)   where t is age in DAYS (clamped to >= 0).
//
// m and h are CAPS-pinned (default 1.0 each). f selects on kind:
//   fact     -> 0.15  (slow decay)
//   episodic -> 0.35
//   ambient  -> 0.6   (fast decay)
// Unknown kinds default to "ambient" — the most conservative (fastest decay)
// choice; emits no error, the caller upstream is responsible for kind
// validation at promote-time.
//
// opts.now (ISO-8601 string) overrides "current time" for deterministic tests.
// Returns a scalar in (0, 1]. At t=0 (or t<0 due to clock skew) returns 1.0.
// ---------------------------------------------------------------------------
export function powerLawDecay({ ts, kind, opts } = {}) {
  if (typeof ts !== "string" || ts === "") {
    // No usable timestamp -> treat as fully decayed minimum (caller will weight
    // this with w_t2 which is small by default).
    return 0;
  }
  const tsEpoch = Date.parse(ts);
  if (!Number.isFinite(tsEpoch)) return 0;

  const nowEpoch = Date.parse(nowIso(opts));
  if (!Number.isFinite(nowEpoch)) return 0;

  let ageDays = (nowEpoch - tsEpoch) / MS_PER_DAY;
  if (ageDays < 0) ageDays = 0;

  const f = POWER_LAW_F_BY_KIND[kind] != null
    ? POWER_LAW_F_BY_KIND[kind]
    : POWER_LAW_F_BY_KIND.ambient;
  const m = CAPS.POWER_LAW_M_DEFAULT;
  const h = CAPS.POWER_LAW_H_DEFAULT;

  return m * Math.pow(1 + h * ageDays, -f);
}

// ---------------------------------------------------------------------------
// freshnessLabel({ candidate_ts, now_iso }): the SINGLE producer of the
// `freshness` label on memory_recall's memories[] entries (the only call site
// is the memories[] projection in lib/tools/recall.js, which passes the
// candidate's `ts` and the caller-supplied `surrounding_context.time`).
//
// Contract:
//   age = Date.parse(now_iso) - Date.parse(candidate_ts), clamped to >= 0 for
//        clock skew — the SAME clamp powerLawDecay documents and applies at
//        the `if (ageDays < 0) ageDays = 0;` line above (this file, in
//        powerLawDecay). A future-dated candidate_ts is therefore "fresh",
//        not an error.
//   age <= CAPS.RECALL_FRESHNESS_STALE_AFTER_MS  -> "fresh"  (boundary
//        INCLUSIVE: exactly-at-threshold is still fresh)
//   otherwise                                    -> "stale"
//   candidate_ts missing / empty / unparseable   -> "stale"
//   now_iso     missing / unparseable            -> "stale"
//
// Why "stale" for unknown: the empty-candidate_ts branch is REACHABLE, not
// theoretical — recall.js's enriched-candidate projection assigns
// `ts: t ? t.candidate.ts : ""`, so a surfaced row whose top-candidate lookup
// missed genuinely arrives here with "". Reporting an unknown age as "fresh"
// would be reporting absence of evidence as evidence; the repo's own stated
// discipline is that over-flagging beats under-flagging (kb/agent-integration.md,
// "Conservative direction: over-flagging is preferable to under-flagging").
//
// NO AMBIENT CLOCK. This function deliberately does NOT call nowIso(),
// serverTs(), or Date.now(). `now_iso` is the only clock, so two callers
// passing the same surrounding_context.time get byte-identical labels.
//
// `potentially_outdated` is DECLARED in the ABI (kb/mcp-surface.md § memory_recall,
// kb/operations.md § brief) but RESERVED and never returned at this version.
// The keying decision: the only honest producer of "outdated" is supersession /
// derivation state (a memory contradicted or replaced by a later one) — which
// is exactly the work this node defers. Age alone cannot distinguish "old" from
// "outdated": a five-year-old birthdate is old and perfectly current. Inventing
// a definition here (e.g. keying it on derivation-graph or hard-gate state)
// would be worse than the reservation, because the next reader would build on
// it. Until a supersession signal exists, the returned label set is exactly
// {"fresh","stale"} and this function is a TOTAL function of
// (candidate_ts, now_iso).
//
// @param {{candidate_ts?: string, now_iso?: string}} arg
// @returns {"fresh"|"stale"}
// ---------------------------------------------------------------------------
export function freshnessLabel({ candidate_ts, now_iso } = {}) {
  if (typeof candidate_ts !== "string" || candidate_ts === "") return "stale";
  if (typeof now_iso !== "string" || now_iso === "") return "stale";

  const candEpoch = Date.parse(candidate_ts);
  if (!Number.isFinite(candEpoch)) return "stale";

  const nowEpoch = Date.parse(now_iso);
  if (!Number.isFinite(nowEpoch)) return "stale";

  let ageMs = nowEpoch - candEpoch;
  if (ageMs < 0) ageMs = 0; // clock skew — same clamp as powerLawDecay

  return ageMs <= CAPS.RECALL_FRESHNESS_STALE_AFTER_MS ? "fresh" : "stale";
}

// ---------------------------------------------------------------------------
// episodicityMatch({ candidate, surrounding_context }): v0 STUB.
//
// v0 always returns 1.0 — episodicity routing is a v2 feature.
// v2 plan (documented for the next implementer): sigmoid over
//   (has_time_anchor, log corroboration_count, entity_generality,
//    narrative_valence).
// The output is the episodicity-axis match between the candidate and the
// query (a high-corroboration generic fact should not score high against an
// episodic narrative query, and vice versa). Logistic regression / a small
// MLP fit on Phase 3 v0's recall-log substrate is the v2 model.
// ---------------------------------------------------------------------------
export function episodicityMatch({ candidate, surrounding_context } = {}) {
  void candidate;
  void surrounding_context;
  return 1.0;
}

// ---------------------------------------------------------------------------
// valenceCompat(candidate_valence, context_valence): emotion-axis match.
//
//   candidate_valence null         -> 0   (no signal)
//   either is missing              -> 0
//   both present                   -> 1 - |c - x| / 2, clamped to [-1, 1]
//
// candidate_valence and context_valence are in [-1, +1]. The 1 - |delta|/2
// transform maps a maximum delta of 2 to 0 and a perfect match to 1.
// ---------------------------------------------------------------------------
export function valenceCompat(candidate_valence, context_valence) {
  if (candidate_valence == null) return 0;
  if (context_valence == null) return 0;
  if (typeof candidate_valence !== "number" || !Number.isFinite(candidate_valence)) {
    return 0;
  }
  if (typeof context_valence !== "number" || !Number.isFinite(context_valence)) {
    return 0;
  }
  const raw = 1 - Math.abs(candidate_valence - context_valence) / 2;
  // Defensive clamp; for inputs in [-1,+1] the formula already yields [0,1],
  // but we honor the documented [-1, 1] contract should out-of-range values
  // slip through.
  if (raw < -1) return -1;
  if (raw > 1) return 1;
  return raw;
}

// ---------------------------------------------------------------------------
// engagementPrior(memory_id, opts): minimal use_count / last_retrieved prior.
//
// N1-calibration WORKUNIT item (2): the v0 `return 0` stub was doubly inert
// (the weight SCORE_WEIGHT_ENGAGEMENT_PRIOR is also 0.0), so the calibration
// loop could never measure a lift from the engagement leg. This now delegates
// to a PRECOMPUTED projection map the caller passes in via
// `opts.engagementPriorById` (a Map<memory_id, number> built by
// engagement-prior-reader.buildEngagementPriorMap from the EXISTING
// policy.salience.recall_feedback rows — no new substrate, no fact-row
// mutation). The scorer itself stays PURE and does NO I/O: when no map is
// supplied (every legacy call site, and the default recall path until the
// caller opts in) it returns 0 EXACTLY as the stub did — so behavior is
// byte-identical until a caller wires the map AND the weight is flipped.
//
// v3 successor: Plackett-Luce / doubly-robust OPE over the recall-log
// propensities (research report staged rollout). This is the v0 minimal wire.
// ---------------------------------------------------------------------------
export function engagementPrior(memory_id, opts) {
  const map =
    opts != null && opts.engagementPriorById instanceof Map
      ? opts.engagementPriorById
      : null;
  if (map == null) return 0;
  if (typeof memory_id !== "string" || memory_id.length === 0) return 0;
  const v = map.get(memory_id);
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return v;
}

// ---------------------------------------------------------------------------
// computeScore({ s_emb_full3072, gates, candidate, surrounding_context, opts })
//
// Returns a ScoreComponents object per kb/phase3-v0-contracts.md § 3. Inputs:
//
//   s_emb_full3072: number  — full 3072d cosine (rescore output from Layer 2).
//   gates: {
//     predicate_mask: 0 | 1,
//     consent_dampener: number,    // pre-resolved per consent_basis
//     derivation_status: number,   // 1.0 normal; 0.5 orphan
//   }
//   candidate: {
//     memory_id: string,
//     kind: "fact" | "episodic" | "ambient" | ...,
//     ts: string,                  // ISO-8601
//     entities: string[],
//     valence: number | null,
//   }
//   surrounding_context: {
//     entities: string[],
//     time_anchor: string | null,  // ISO-8601 or null in v0
//     valence: number | null,
//   }
//   opts: { now?: string }         // deterministic test override
//
// The multiplicative branch wins on high s_emb_full3072 (since the additive
// soft features are bounded). The additive branch wins on high entity overlap
// or strong time-anchor matches when the embedding signal is weak.
//
// predicate_mask=0 collapses the multiplicative branch to 0 — that is the
// intentional behavior; predicate-excluded candidates can still float on
// soft features but lose all embedding contribution.
// ---------------------------------------------------------------------------
export function computeScore({
  s_emb_full3072,
  gates,
  candidate,
  surrounding_context,
  opts,
} = {}) {
  if (typeof s_emb_full3072 !== "number" || !Number.isFinite(s_emb_full3072)) {
    throw new Error("computeScore: s_emb_full3072 must be a finite number");
  }
  if (gates == null || typeof gates !== "object") {
    throw new Error("computeScore: gates must be an object");
  }
  if (candidate == null || typeof candidate !== "object") {
    throw new Error("computeScore: candidate must be an object");
  }
  if (surrounding_context == null || typeof surrounding_context !== "object") {
    throw new Error("computeScore: surrounding_context must be an object");
  }

  // Null-embedding handling.
  //
  // A candidate whose fact row was promoted WITHOUT an embedding (empty
  // content, or — WU2 — a local-server outage at promote time) carries
  // features.embedding_4096 === null (legacy Gemini-null rows carry
  // embedding_3072 === null) + features.embed_state === true. When such a
  // candidate has NO vector anywhere, s_emb collapses to 0 and the scorer
  // routes it through the additive-only branch.
  //
  // R5 hydrated-index-vector precedence: the null-promote sweep drain
  // (reembed-local-4096.mjs) writes the fact's vector ONLY into the sidecar +
  // HNSW index — the immutable ledger row (thesis #1) keeps its null marker
  // forever (stamped at distill-promote-fact.js:631-635). A hydrated index
  // vector must therefore win over the stale row marker: the marker only
  // gates candidates with NO vector anywhere, i.e. s_emb_full3072 === 0.
  //
  // CALL-SITE CONTRACT the s_emb_full3072 !== 0 guard rests on (computeScore
  // has exactly ONE production call site, mcp/lib/tools/recall.js:2269):
  // recall.js:2215-2225 initializes s_emb_full3072 = 0 and assigns a nonzero
  // cosine ONLY when _resolveCandidateEmbedding returned an actual vector —
  // the row vector first, else the index-resident vector via
  // hnsw.getVectorByMemoryId. A null-marker row has no row vector by
  // construction, so a nonzero s_emb_full3072 arriving alongside the marker
  // triple can only originate from an index-hydrated vector. Trust it: take
  // the multiplicative branch, keep embedding_source = "fact_row" (no new
  // enum value — propensity-log stratification consumers see the frozen
  // "fact_row"/"none" domain), and report had_embedding_at_recall = true
  // truthfully.
  //
  // Known measure-zero edge: a hydrated vector whose query cosine is EXACTLY
  // 0.0 is indistinguishable here from "no vector" and degrades to the
  // fallback branch. Its multiplicative s_emb contribution is identically 0
  // either way — the difference is telemetry (embedding_source/
  // fallback_branch_used/had_embedding_at_recall) plus falling under the
  // fallback-only additive floor gate below.
  //
  // WU2-inline-embed-and-remove-gemini-quota-machinery removed the
  // policy.embedding_backfill OVERLAY consultation: that overlay was the
  // read-side of the deleted async embed-backfill worker. By recall time the
  // candidate either resolves a real vector (row-carried or index-hydrated;
  // embedding_source="fact_row") or it does not (additive fallback) — there
  // is no separate overlay map any more. NOTE: this is DISTINCT from the
  // feature_backfill overlay (buildLatestBackfillMap / applyBackfillOverlay
  // above), which is KEPT — it overlays entities/time/valence/episodicity, not
  // embeddings.
  //
  // had_embedding_at_recall / fallback_branch_used are surfaced on the
  // ScoreComponents return so the propensity log can stratify by recall regime.
  const candidateFeatures =
    candidate && typeof candidate.features === "object" &&
    candidate.features !== null
      ? candidate.features
      : null;
  // b2-silent-recall-degrade (Part 2) — `vector_resolved` is an OPTIONAL,
  // TRI-STATE caller signal on the constructed scoring view (never on the
  // immutable ledger row; thesis #1). It answers the question the row-shape
  // predicate above can only guess at: did a vector actually resolve for this
  // candidate at THIS recall?
  //
  //   true    -> a vector resolved; legacy predicate governs (unchanged)
  //   absent  -> unknown; legacy predicate governs (unchanged)
  //   false   -> the caller MEASURED that no vector resolved on a healthy
  //              dense channel; the candidate is on the fallback branch
  //
  // MEASURED DELTA TABLE (read-only census of ledgers/memory.jsonl, 9
  // offset-diverse 4 MiB slices, 14,969 rows parsed, 0 parse failures):
  //
  //   class                                        rows    what changes
  //   embed_state:true, no row vector             14,571   NOTHING — the
  //     (mid-ledger bulk: git-log/codex-cli/…)             legacy predicate
  //                                                        already routes these
  //                                                        to the fallback
  //                                                        branch (`== null`
  //                                                        catches absent as
  //                                                        well as explicit
  //                                                        null)
  //   embedding_4096 array (recent facts)            178   NOTHING — a vector
  //                                                        resolves, so the
  //                                                        call site passes
  //                                                        vector_resolved:true
  //   embed_state false-or-absent, no row vector     220   THE DELTA, and only
  //     (117 early `fact`, 13 `reconstructed`,              the subset whose
  //      90 `policy` — policy rows are not                  vector also misses
  //      recall candidates)                                 in the index
  //
  // For the delta rows the ONLY score change is a DROP: s_emb_full3072 is 0 by
  // construction here, so the multiplicative branch was already 0 and
  // final_pre_salience === additive either way. Above
  // RECALL_ADDITIVE_FLOOR_FALLBACK the number is bit-identical and exactly
  // three telemetry fields flip (embedding_source, fallback_branch_used,
  // had_embedding_at_recall); below it the fallback-only floor fires and the
  // candidate goes to 0. Monotone: no score rises, no drop is reversed.
  //
  // ONLY the discriminator moves. The `&& s_emb_full3072 === 0` guard below is
  // untouched, so the R5 hydrated-index-vector precedence and its documented
  // measure-zero exactly-0.0-cosine edge behave exactly as before.
  const vectorResolved =
    candidate != null && typeof candidate.vector_resolved === "boolean"
      ? candidate.vector_resolved
      : null;
  const candidateEmbeddingNull =
    vectorResolved === false
      ? true
      : candidateFeatures != null &&
        candidateFeatures.embed_state === true &&
        candidateFeatures.embedding_4096 == null &&
        candidateFeatures.embedding_3072 == null;
  let embedding_source = "fact_row";
  let s_emb_for_branch = s_emb_full3072;
  if (candidateEmbeddingNull && s_emb_full3072 === 0) {
    // No vector anywhere (row marker set AND nothing hydrated from the
    // index) → additive-only fallback, byte-identical to pre-R5 behavior.
    s_emb_for_branch = 0;
    embedding_source = "none";
  }
  const fallback_branch_used = embedding_source === "none";
  const had_embedding_at_recall = !fallback_branch_used;

  const predicate_mask = gates.predicate_mask === 0 ? 0 : 1;
  const consent_dampener = typeof gates.consent_dampener === "number"
    ? gates.consent_dampener
    : CAPS.CONSENT_DAMPENER_FIRST_PARTY;
  const derivation_status = typeof gates.derivation_status === "number"
    ? gates.derivation_status
    : CAPS.DERIVATION_STATUS_NORMAL;

  // Wave 6 — prefer the synthesis substrate's 2-arg episodicity match when
  // BOTH sides carry an episodicity scalar (candidate.features.episodicity
  // from the cascade-time stamper, surrounding_context.query_episodicity
  // from the recall-time populator). When either side is missing, fall back
  // to the legacy 1.0 stub so legacy ledger rows / unwired callers retain
  // the pre-Wave-6 behavior.
  const candidateEpisodicity =
    candidate &&
    typeof candidate.features === "object" &&
    candidate.features !== null &&
    typeof candidate.features.episodicity === "number" &&
    Number.isFinite(candidate.features.episodicity)
      ? candidate.features.episodicity
      : null;
  const queryEpisodicity =
    surrounding_context &&
    typeof surrounding_context.query_episodicity === "number" &&
    Number.isFinite(surrounding_context.query_episodicity)
      ? surrounding_context.query_episodicity
      : null;
  let episodicity_match;
  if (candidateEpisodicity != null && queryEpisodicity != null) {
    episodicity_match = synthesisEpisodicityMatch(
      candidateEpisodicity,
      queryEpisodicity,
    );
  } else {
    episodicity_match = episodicityMatch({
      candidate,
      surrounding_context,
    });
  }

  // D2 ABLATION GATE — default OFF, env-only, no CAPS write (thesis #1: CAPS
  // stays Object.frozen and is never assigned into).
  //
  // 1.0 is not an arbitrary neutral: it is EXACTLY what the v0 stub
  // `episodicityMatch` (this file, the `return 1.0;` above) already returns.
  // So the flag's true semantics are "force every candidate onto the stub's
  // neutral path", and it can only change the score of candidates that took
  // the SYNTHESIS path — i.e. those where both `candidate.features.episodicity`
  // and `surrounding_context.query_episodicity` are finite. Stub-path
  // candidates are already at 1.0 and are unaffected in either flag state.
  //
  // The assignment targets the SAME `episodicity_match` binding that the
  // `const multiplicative =` product consumes AND that the returned
  // ScoreComponents breakdown reports, so the multiplicand line stays
  // untouched and the observability contract holds: the value logged at
  // mcp/lib/tools/recall.js feature_breakdown is the value the scorer
  // actually multiplied in, never a raw value it discarded.
  //
  // Env resolution is the score-weight-overlay.js resolveScoreWeightOverlay
  // idiom verbatim — `opts.env` wins for tests, else process.env, else {}.
  const scoringEnv =
    opts != null && opts.env != null && typeof opts.env === "object"
      ? opts.env
      : typeof process !== "undefined" && process.env
        ? process.env
        : {};
  if (scoringEnv[EPISODICITY_ABLATE_ENV.ENABLED] === "1") {
    episodicity_match = 1.0;
  }

  const candidate_entities = Array.isArray(candidate.entities) ? candidate.entities : [];
  const context_entities = Array.isArray(surrounding_context.entities)
    ? surrounding_context.entities
    : [];
  const hasEntityDf =
    opts != null && opts.entity_df != null &&
    typeof opts.entity_df_n === "number" && Number.isFinite(opts.entity_df_n) &&
    opts.entity_df_n >= 1;
  const candidateAttribution =
    candidateFeatures != null && candidateFeatures.attribution != null &&
    typeof candidateFeatures.attribution === "object" &&
    !Array.isArray(candidateFeatures.attribution)
      ? candidateFeatures.attribution
      : null;
  const entity_overlap_jaccard =
    scoringEnv[ENTITY_IDF_ENV.ENABLED] === "1" && hasEntityDf
      ? entityOverlapIdf(
          candidate_entities,
          context_entities,
          opts.entity_df,
          opts.entity_df_n,
          candidateAttribution,
          scoringEnv,
        )
      : entityOverlapJaccard(candidate_entities, context_entities, scoringEnv);

  const time_anchor_match = timeAnchorMatch(
    candidate.ts,
    surrounding_context.time_anchor != null ? surrounding_context.time_anchor : null,
    opts,
  );

  const power_law_decay = powerLawDecay({
    ts: candidate.ts,
    kind: candidate.kind,
    opts,
  });

  const valence_compat = valenceCompat(
    candidate.valence == null ? null : candidate.valence,
    surrounding_context.valence == null ? null : surrounding_context.valence,
  );

  const engagement_prior = engagementPrior(candidate.memory_id, opts);

  // W12 mutual-cycle closure: read the two PRIORS off candidate.priors. Both
  // default to their respective neutral values (damping 1.0, corroboration
  // 1.0) so candidates without instrumentation are ranking-neutral. The
  // weights (CAPS.SCORE_WEIGHT_DAMPING_PRIOR, SCORE_WEIGHT_CORROBORATION_PRIOR)
  // default to 0.0 so the additive contribution is zero until the calibration
  // loop flips them. Defensive: any non-finite or out-of-range value
  // degrades to the neutral default.
  const priors =
    candidate.priors != null && typeof candidate.priors === "object"
      ? candidate.priors
      : null;
  let damping_coefficient =
    priors != null &&
    typeof priors.damping_coefficient === "number" &&
    Number.isFinite(priors.damping_coefficient)
      ? priors.damping_coefficient
      : 1.0;
  // Bound to the spec's [0.5, 1.5] interval defensively.
  if (damping_coefficient < 0.5) damping_coefficient = 0.5;
  if (damping_coefficient > 1.5) damping_coefficient = 1.5;
  let corroboration_boost =
    priors != null &&
    typeof priors.corroboration_boost === "number" &&
    Number.isFinite(priors.corroboration_boost)
      ? priors.corroboration_boost
      : 1.0;
  // Bound to the spec's [1.0, 1.3] interval defensively.
  if (corroboration_boost < 1.0) corroboration_boost = 1.0;
  if (corroboration_boost > 1.3) corroboration_boost = 1.3;

  // Multiplicative branch: s_emb_full3072 wrapped in the hard-gate multipliers
  // AND the soft episodicity match. predicate_mask=0 -> this whole branch is 0.
  // W2-CCS: s_emb_for_branch substitutes when the candidate is on the
  // null-embed cascade path with no overlay — collapses the branch to 0.
  const multiplicative =
    s_emb_for_branch *
    predicate_mask *
    consent_dampener *
    derivation_status *
    episodicity_match;

  // Additive branch: weighted soft features. time_anchor_match is already
  // gated to 0 when no anchor is set on the surrounding context, so the w_t1
  // weight contributes nothing in that case. The three PRIORS round out the
  // additive branch.
  //
  // N1-calibration WORKUNIT item (4): the three live PRIOR weights are read
  // from `opts.scoreWeightOverlay` when the caller supplies it (recall.js
  // resolves it ONCE per recall via score-weight-overlay.resolveScoreWeightOverlay,
  // which returns the frozen CAPS triple when the env gate is OFF and the
  // calibrated triple only for a REVIEWED, harm-safe, NDCG-positive projection).
  // When no overlay is supplied (every legacy/test call site) we read the
  // FROZEN CAPS values verbatim — so behavior is byte-identical until a caller
  // both wires the overlay AND a qualifying projection exists under the gate.
  // We NEVER mutate CAPS (thesis #1): the overlay is a read-only value object.
  const overlay =
    opts != null && opts.scoreWeightOverlay != null &&
    typeof opts.scoreWeightOverlay === "object"
      ? opts.scoreWeightOverlay
      : null;
  const resolveWeight = (key, fallback) => {
    if (overlay != null) {
      const ov = overlay[key];
      if (typeof ov === "number" && Number.isFinite(ov)) return ov;
    }
    return typeof fallback === "number" && Number.isFinite(fallback) ? fallback : 0;
  };
  const w_eng = resolveWeight(
    "SCORE_WEIGHT_ENGAGEMENT_PRIOR",
    CAPS.SCORE_WEIGHT_ENGAGEMENT_PRIOR,
  );
  const w_damping = resolveWeight(
    "SCORE_WEIGHT_DAMPING_PRIOR",
    CAPS.SCORE_WEIGHT_DAMPING_PRIOR,
  );
  const w_corro = resolveWeight(
    "SCORE_WEIGHT_CORROBORATION_PRIOR",
    CAPS.SCORE_WEIGHT_CORROBORATION_PRIOR,
  );
  const additive =
    CAPS.SCORE_WEIGHT_ENTITY_OVERLAP * entity_overlap_jaccard +
    CAPS.SCORE_WEIGHT_TIME_ANCHOR * time_anchor_match +
    CAPS.SCORE_WEIGHT_TIME_DECAY * power_law_decay +
    CAPS.SCORE_WEIGHT_VALENCE * valence_compat +
    w_eng * engagement_prior +
    w_damping * damping_coefficient +
    w_corro * corroboration_boost;

  let final_pre_salience = multiplicative + additive;

  // W2-CCS — F-CCS-CASCADE-promote-without-embed § 4.4 additive-only floor.
  //
  // When the candidate is on the fallback branch (null embedding, no
  // overlay), gate the additive sum against ADDITIVE_FLOOR. Below the
  // floor the candidate is dropped — we represent that by zeroing the
  // pre-salience score AND surfacing dropped_by_additive_floor=true so
  // the caller (recall.js) can filter it out of the candidate set before
  // ranking. Above the floor the candidate scores normally on the
  // additive branch.
  //
  // CRITICAL: the hard gates (predicate_mask, consent_dampener,
  // derivation_status) are NOT pre-filters — applyHardGates RETURNS gated
  // candidates and recall.js passes the gate values INTO computeScore. Both
  // this floor and predicate_mask are consumed by recall.js at the Layer-2
  // OUTPUT partition (post-sort, pre-dedup/rerank), which hard-drops
  // predicate_mask=0 and dropped_by_additive_floor=true candidates from the
  // surfaceable set. This floor is the ADDITIONAL gate for the null-embed
  // fallback regime only. It does NOT relax the existing hard gates.
  let dropped_by_additive_floor = false;
  if (fallback_branch_used) {
    const floor =
      typeof CAPS.RECALL_ADDITIVE_FLOOR_FALLBACK === "number" &&
      Number.isFinite(CAPS.RECALL_ADDITIVE_FLOOR_FALLBACK)
        ? CAPS.RECALL_ADDITIVE_FLOOR_FALLBACK
        : 0.10;
    if (additive < floor) {
      dropped_by_additive_floor = true;
      final_pre_salience = 0;
    }
  }

  // R25 salience-integration (Layer-2 multiplier). Read
  // candidate.features.salience.score; null/undefined -> multiplier 1.0
  // (back-compat with legacy memory.jsonl rows that pre-date the cascade).
  //
  //   final = final_pre_salience * salience^alpha
  //
  // alpha is CAPS.SALIENCE_ALPHA (0.5 per the design's locked CP-2 weights).
  // With alpha=0.5 the multiplier compresses the [0,1] salience grid toward
  // 1.0 — a 0.5 salience row pays only ~30% (sqrt(0.5)=0.707), a 0.1 row
  // pays ~70%. Legacy rows are ranking-neutral (multiplier=1.0) so they
  // don't get penalised by missing instrumentation.
  const salienceResolved = _resolveSalienceForScore(candidate);
  const salienceMultiplier = _salienceMultiplier(salienceResolved);
  const final_score = final_pre_salience * salienceMultiplier;

  return {
    memory_id: typeof candidate.memory_id === "string" ? candidate.memory_id : "",
    s_emb_full3072,
    predicate_mask,
    consent_dampener,
    derivation_status,
    episodicity_match,
    entity_overlap_jaccard,
    time_anchor_match,
    power_law_decay,
    valence_compat,
    engagement_prior,
    // W12 mutual-cycle closure scalars — surfaced on the ScoreComponents
    // record so downstream observers (calibration loop, eval harness) can
    // audit the priors that contributed to final_score.
    damping_coefficient,
    corroboration_boost,
    salience_score: salienceResolved.score,
    salience_source: salienceResolved.source,
    salience_multiplier: salienceMultiplier,
    salience_caps_drift: salienceResolved.caps_drift,
    // W2-CCS recall-regime stratification — surfaced so propensity log
    // / OPE pipeline can separate fallback-branch recalls from full-
    // embedding recalls without re-deriving from candidate features.
    had_embedding_at_recall,
    embedding_source,
    fallback_branch_used,
    dropped_by_additive_floor,
    final_score,
  };
}

// ---------------------------------------------------------------------------
// _resolveSalienceForScore (R25): mirror of rerank.js _resolveSalienceScore.
// Reads candidate.features.salience.score; tolerates three states (scored,
// scored_drifted on weights_hash mismatch, legacy_no_score). Kept local here
// to avoid a recall<->recall import cycle (multi-feature-score and rerank
// are siblings; recall.js wires them).
// ---------------------------------------------------------------------------
function _resolveSalienceForScore(candidate) {
  const features =
    candidate && typeof candidate === "object" ? candidate.features : null;
  const sal = features && typeof features === "object" ? features.salience : null;
  if (!sal || typeof sal !== "object") {
    return { score: 0.5, source: "legacy_no_score", caps_drift: false };
  }
  const score =
    typeof sal.score === "number" && Number.isFinite(sal.score) ? sal.score : 0.5;
  const storedHash = typeof sal.weights_hash === "string" ? sal.weights_hash : null;
  const currentHash =
    typeof CAPS.SALIENCE_WEIGHTS_V1_HASH === "string"
      ? CAPS.SALIENCE_WEIGHTS_V1_HASH
      : null;
  if (storedHash == null || currentHash == null || storedHash === currentHash) {
    return { score, source: "scored", caps_drift: false };
  }
  return { score, source: "scored_drifted", caps_drift: true };
}

// ---------------------------------------------------------------------------
// _salienceMultiplier (R25): final *= salience^alpha for scored rows;
// returns 1.0 (ranking-neutral) for legacy rows so missing instrumentation
// doesn't penalise old data. alpha is CAPS.SALIENCE_ALPHA (0.5 default per
// the locked design). If alpha is unset (A6 hasn't landed), fall back to
// 0.5 so the multiplier semantics still hold.
// ---------------------------------------------------------------------------
function _salienceMultiplier(resolved) {
  if (resolved.source === "legacy_no_score") return 1.0;
  const alpha =
    typeof CAPS.SALIENCE_ALPHA === "number" && Number.isFinite(CAPS.SALIENCE_ALPHA)
      ? CAPS.SALIENCE_ALPHA
      : 0.5;
  // Math.pow on score in [0,1] with alpha in (0,1] stays in [0,1].
  // Clamp negative or non-finite scores to 0 defensively.
  const score = Math.max(0, Math.min(1, resolved.score));
  return Math.pow(score, alpha);
}
