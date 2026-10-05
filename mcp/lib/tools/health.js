/** memory_health — see kb/mcp-surface.md § memory_health (AUTHORITATIVE FIELD SET).
 *
 * Implementation contract (review-12 H8 + H9 fix):
 *   - Every field in the AUTHORITATIVE block at mcp-surface.md L964-990 MUST
 *     appear in the returned `data`; no field outside that block may appear.
 *   - No hardcoded faked values: `tools_registered` derives from the live
 *     registry, `policy_events_*` from policy-events.js,
 *     `source_event_counts` + `ledger_byte_counts` from real filesystem reads.
 *   - Degraded conditions (missing files, oversize ledgers, unsupported phase
 *     surfaces like rederive jobs) surface in `health_notes[]` rather than as
 *     dedicated booleans — keeps the field set closed per spec.
 *
 * R32.1: removed the on-disk read of distillation-state.json (the conversational
 * distillation pipeline was retired in R32; see kb/deprecation-discipline.md).
 * `distillation_state` remains as a top-level field for operator-dashboard
 * back-compat, but the values are static: `watermark_lag_seconds:null`,
 * `last_distillation_ts:null`, `in_flight_batch_count:0`, `deprecated:true`.
 * Schema version bumped 2 -> 3 to signal the change.
 *
 * H2 (memperf): the synthesis_coverage + drift_alerts projections are now
 * computed from the H1 day-bucket reducer state (lib/synthesis/
 * health-reducers.js) instead of full-scanning both ledgers on every call.
 * Field set unchanged (both projections keep their exact envelope shapes —
 * gated for equivalence against the original full-scan probes by
 * scripts/health-equivalence.mjs on the live ledgers); the only additive
 * surface is the `synthesis_state_rebuilding:` health_note on the degrade
 * path. See the REDUCER-BACKED SYNTHESIS PROJECTIONS block below.
 * S5 added `synthesis_aggregates_stale:` (age of the served last-good) on the
 * same path. C1 (rebuild-child observability) added two more notes there,
 * both fed by the detached child's rebuild-outcome.json:
 *   `synthesis_rebuild_failed: finished_at=<iso> <name>: <message_head>`
 *       — the most recent child finished ok:false and no last-good.json has
 *         been written since (supersession by saved_at);
 *   `synthesis_rebuild_never_completed`
 *       — no last-good built_at, no outcome file, no live marker: nothing
 *         has ever been observed to finish.
 * Neither prefix starts with `synthesis_state_rebuilding` or
 * `synthesis_aggregates_stale` (tests assert those absent by prefix). Note
 * the child has completed every time it was asked on the live tree (census
 * 08-09 .. 09-09, each degrade followed by a fresh built_at); these notes
 * make a FUTURE failure visible — before C1 the child ran stdio:"ignore"
 * with no catch and nothing on disk recorded its exit.
 *
 * H2b (memperf FU1): warm calls additionally serve both projections from an
 * in-process envelope cache (keyed on checkpoint pair + live ledger stat
 * identity + a 60s now-bucket; cached built_at kept) and skip the reducer
 * fold entirely when stat proves zero bytes were appended past the verified
 * checkpoints. Field set still unchanged; the cache sits strictly ABOVE the
 * compute seam the equivalence gate pins. See THE ENVELOPE CACHE +
 * ZERO-DELTA FAST PATH block below.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { constants as BUFFER_CONSTANTS } from "node:buffer";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { ok, serverTs } from "../envelope.js";
import { assertObjectShape } from "../validation.js";
import { currentActiveFile, policyEventsDiskBytes } from "../policy-events.js";
import {
  MEMORY_ROOT,
  STORAGE_DIR,
  memoryLedgerPath,
  recallLedgerPath,
} from "../config.js";
// S2d — index-WAL corruption quarantine surfacing. quarantineWal (index-wal.js)
// renames a corrupt WAL to index-wal.jsonl.corrupt-<epoch-ms> and logs a
// structured event to index-wal.quarantine.json in the same per-model-version
// dir; this probe projects the newest event per model version into
// health_notes so the operator sees the quarantine (and the parked bytes
// awaiting repair) without tailing stderr. Read-only + cheap: one readdir of
// indices/ plus one tiny JSON read per version that HAS a quarantine log.
import { readWalQuarantineNotes } from "../recall/index-wal.js";
// REG (memperf) — the deserialize-refusal breadcrumb file name is
// single-sourced with its writer (index-cache._recordDeserializeRefusal).
import { INDEX_REFUSAL_FILE } from "../recall/index-cache.js";
// S3g — refused-generation visibility. The 2026-07-16 incident served EMPTY
// recall on both production trees with the only signal buried in stderr
// breadcrumbs: an un-cutover pre-S3 writer rewrote a member at its fixed
// path AFTER manifest adoption, so every cold load refused the ACTIVE
// generation (index_manifest_member_mismatch) fail-closed. The probe below
// projects that state into health_notes. STAT-ONLY by contract: it compares
// each recorded member size against the on-disk size and NEVER hashes — a
// full sha256 of the ~707MB/1.9GB production members would blow health's
// latency budget (readActiveManifest itself is parse+shape only, no member
// reads).
import { readActiveManifest } from "../recall/index-manifest.js";
// H2 (memperf) — reducer-backed synthesis projections. Replaces the Wave-10
// computeSynthesisCoverage + Wave-12 detectDrift full-scan calls: both used
// to re-stream + JSON-parse the ENTIRE memory.jsonl (2.2GB) and recall.jsonl
// on every memory_health call (~7.3s of event-loop blocking, measured
// 2026-07-12). The H1 reducer library folds the ledgers once into persisted
// per-UTC-day buckets and updates incrementally via the S1 newline-safe
// checkpoint primitive; call-time cost is bounded by the bytes APPENDED
// since the last call plus O(witness) prefix verification. Envelope
// equivalence against the original full scans is gated on the LIVE ledgers
// by scripts/health-equivalence.mjs (H2 gate 1); warm-call latency by
// scripts/mcp-health-latency.mjs (H2 gate 2).
import {
  REDUCER_VERSION,
  computeCoverageFromState,
  computeDriftFromState,
  loadState,
  saveState,
  updateStateFromLedgers,
} from "../synthesis/health-reducers.js";
import {
  readLastGoodAggregates,
  writeJsonAtomic,
  writeLastGoodAggregates,
} from "../synthesis/last-good-aggregates.js";
import { deserializeCheckpoint, verifyPrefix } from "../synthesis/ledger-checkpoint.js";
// A1 — recall-liveness gate. DEFAULT-OFF: only reached when
// MEMORY_RECALL_LIVENESS_GATE === "1" (see the A1 attach block just above
// buildHealthData's return), so with the flag unset the health envelope is
// byte-identical to today.
import { evaluateRecallLiveness } from "../synthesis/recall-liveness-probe.js";
// F-NEW-W2-CHAT-CC-HEALTH-PROBE — per-source effective_empty_rate. Surfaces
// the "99.75%-empty" regression class as a degraded health note within days
// of any future extraction-logic regression in any agent-runtime hook source.
import {
  buildEmptyRateHealthNotes,
  computeEffectiveEmptyRatesForSources,
} from "../ingest/source-effective-empty-rate.js";
// B2 (memory-roots) — operator alias-candidate note, formatted from the
// `alias_candidates` the mail snapshot above already carries (tallied inside
// that same 7-day tail scan). Advisory health_notes[] string only: no new
// top-level key, no warnings[] entry, no level change.
import { buildAliasCandidateHealthNotes } from "../identity/alias-candidates.js";
// g3 — mail frozen-prefix head probe. The rolling backward-from-EOF window
// above cannot see the head of a 387MB append-only ledger, so it reports a
// healthy live mail rate while ~279k envelope-only rows sit behind it. ONE
// bounded positioned read from BOF (256KB) closes that blind spot. Emits a
// single health_notes[] string; adds no top-level field.
import {
  buildMailBodyCoverageHealthNotes,
  probeMailLedgerHead,
} from "../connectors/mail-body-coverage.js";
// F-NEW-W7-CURSOR-LAG-ALARM — per-source cursor-vs-ledger-tail lag snapshot.
// Surfaces the "watermark cursor parked for days while the source ledger
// keeps growing" failure mode (audit-finding: 4 of 5 sources stuck behind
// 24h+) as a degraded health note. Cheap: one statSync + one short tail
// read per source. Wrapped in try/catch so the probe never crashes the
// health surface.
//
// Daemon path import: daemons/watermark.js exports computeCursorLagSnapshot
// as a pure function. The relative ../../../ traversal lands at the repo
// root daemons/ dir alongside the mcp/ tree.
import { computeCursorLagSnapshot } from "../../../daemons/watermark.js";
// B1 (task-hypergraph) — Telegram drain-liveness detector. Replaces the
// hardcoded telegram_connector_status with a real read and surfaces a
// drain-stall as a health_note. Pure statSync-based probe (never reads a
// ledger's content); wrapped in try/catch so a probe failure degrades to
// "not_installed" + a note, mirroring the W7/W10 probe discipline.
import { computeTelegramDrainStatus } from "../connectors/telegram-drain-liveness.js";
// c2 (task-hypergraph) — SOURCE capture-liveness. The cursor-lag alarm below
// measures cascade BACKLOG, which collapses to lag_h=0.0 when a source dies;
// this probe keys on capture evidence (state.last_appended_ts + source-ledger
// mtime) so a source that STOPPED PRODUCING is finally visible. Pure, never
// reads a ledger's content, never throws.
import {
  buildCaptureStalenessHealthNotes,
  computeSourceCaptureStaleness,
} from "../synthesis/connector-staleness.js";

// `toolCount` lives in dispatch.js, but dispatch.js imports this file (it
// registers the memory_health TOOL). A static `import { toolCount } from
// "../dispatch.js"` would create an ESM cycle whose evaluation order leaves
// the imported binding in the temporal-dead-zone at module-init time. We
// instead resolve it lazily on first call via a dynamic import — by the time
// any handler runs, dispatch.js has fully initialized. The result is cached
// so we pay the dynamic-import cost once per process.
let _toolCountFn = null;
async function getToolCount() {
  if (_toolCountFn == null) {
    const mod = await import("../dispatch.js");
    _toolCountFn = mod.toolCount;
  }
  return _toolCountFn();
}

const NAME = "memory_health";

// Bumped per AUTHORITATIVE FIELD SET addition (review-12 H8/H9 reconciliation).
// Previous shape (Phase 0 stub) had legacy fields `ledger_writable`,
// `index_status`, `connectors_*`, `pending_quarantine_total`,
// `last_distillation_ts` at the top level. v2 follows the frozen block.
// v3 (R32.1): `distillation_state` is now a static deprecated-marker object;
// the conversational distillation pipeline was retired in R32. Operator
// dashboards may render the static null/0 values as "n/a".
// v4 (Wave-10 F-SYN-OPERATIONAL-synthesis-coverage-probe): added
// `synthesis_coverage` projection at the top level. The probe walks
// memory.jsonl + recall.jsonl over a rolling 7-day window and reports
// the share of new facts stamped with entities / time_anchors / valence /
// episodicity AND the share of recalls with non-empty scoringContext
// axes. Probe failure degrades to synthesis_coverage:null + a
// health_note rather than crashing the surface.
// v5 (Wave-12 F-SYN-OPERATIONAL-drift-detection): added `drift_alerts`
// projection at the top level. The detector compares the 30-day baseline
// window against the 7-day alert window on memory.jsonl + recall.jsonl
// and surfaces extractor_version_bump / coverage_drop / entity_count_drop
// / query_episodicity_drift alerts. Detector failure degrades to
// drift_alerts:null + a health_note (mirrors the W10 surface contract).
const HEALTH_SCHEMA_VERSION = 5;

// Captured at module-load time. Module load happens during MCP server boot
// (server.js → dispatch.js → tools/health.js), so this is an acceptable proxy
// for server_started_at without threading boot time through the call graph.
const SERVER_STARTED_AT = serverTs();

// Paths sourced from lib/config.js (env-overridable). SOURCES_DIR retains
// the legacy local-const name for readability — the value resolves to
// STORAGE_DIR + "/sources" under every override path so the registry below
// keeps tracking the same on-disk layout the spec freezes.
const SOURCES_DIR = join(STORAGE_DIR, "sources");
const MEMORY_LEDGER_PATH = memoryLedgerPath();

// R32.1: the static deprecated-marker payload for the `distillation_state`
// top-level field. Kept as a frozen literal so operator dashboards see a
// stable shape regardless of system state. The pipeline that populated the
// pre-R32 values (watermark.tickOnce + the distillation-supervisor) was
// retired in R32; see kb/deprecation-discipline.md + kb/legacy-archive.md.
const DEPRECATED_DISTILLATION_STATE = Object.freeze({
  watermark_lag_seconds: null,
  last_distillation_ts: null,
  in_flight_batch_count: 0,
  deprecated: true,
});

// Override-for-test pattern: production callers omit opts; tests pass an opts
// object so they can pin deterministic paths/times without monkey-patching
// the module. Mirrors the policy-events.js `{ now }` convention.
const DEFAULT_OPTS = Object.freeze({});

// Source ledger registry. The keys come from the AUTHORITATIVE
// `source_event_counts` block (mcp-surface.md L973-977); the file paths
// follow architecture.md § 1 (storage/sources/...). Missing files contribute
// 0 + a health_note rather than throwing.
const SOURCE_LEDGERS = Object.freeze([
  { key: "auto_memory",      file: "auto-memory.jsonl" },
  { key: "chat_claude_code", file: "chat-claude-code.jsonl" },
  { key: "telegram",         file: "telegram.jsonl" },
]);

// m2: the file names the REGISTRY loop owns. The discovery pass skips these by
// NAME, not by map-key presence: once a stat-errored registry ledger stops
// getting a ledger_byte_counts key (see the loop below), a hasOwnProperty guard
// would let discovery re-stat the same path and emit a duplicate
// `ledger_stat_error:` note plus a second statSync per health call. One fault,
// one note — the same dedup discipline the main-ledger pass uses via
// mainLedgerStatErrorLabels.
const REGISTRY_LEDGER_FILES = new Set(SOURCE_LEDGERS.map((s) => s.file));

// Cheap line-count guard: spec calls for skipping line counts on files >1 MB
// and surfacing a health_note instead. The byte cap is per-file; large files
// still get a real byte count (cheap statSync).
const LINE_COUNT_MAX_BYTES = 1024 * 1024;

// S5 — the Node string cap, as a health-visible threshold.
//
// V8 caps a single JS string at buffer.constants.MAX_STRING_LENGTH =
// 536,870,888 bytes on the Node v24 line this repo runs. Any reader that does
// readFileSync(path, "utf8") on a ledger past that cap throws
// ERR_STRING_TOO_LONG — and several such readers swallowed it in a bare
// `catch { return []; }`, which made an UNREADABLE ledger indistinguishable
// from an EMPTY one. Known incident sites:
// mcp/lib/synthesis/reconstruction-emitter.js:377 and daemons/watermark.js:908.
//
// ledgers/memory.jsonl crossed the cap around 2026-06-02 and measured
// 3,058,232,133 bytes on 2026-08-11 = 5.70x the cap — yet no memory_health
// envelope mentioned memory.jsonl at all. The note below is the operator's
// only cheap (statSync-only) signal that whole-file string reads of a ledger
// are now structurally impossible.
const LEDGER_STRING_CAP_BYTES = BUFFER_CONSTANTS.MAX_STRING_LENGTH;

// S5 — served-aggregate staleness threshold for the degrade path. Beyond this,
// the last-known-good synthesis_coverage / drift_alerts an operator reads are
// old enough to mislead, so their age is named in health_notes. A live call on
// 2026-08-11T06:44:10Z served aggregates built_at 2026-08-09T03:04:44.004Z
// (51.7h stale) with nothing in the envelope saying so.
const AGGREGATE_STALE_MAX_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// REDUCER-BACKED SYNTHESIS PROJECTIONS (H2).
//
// Persistence layout (under STORAGE_DIR — derived data, never ledgers/):
//   storage/health-reducer-state/state.json      — persisted reducer state
//   storage/health-reducer-state/last-good.json  — last successfully computed
//       synthesis_coverage + drift_alerts envelopes (their built_at is the
//       staleness watermark the degrade path serves)
//   storage/health-reducer-state/rebuild.pending — dedup marker while an
//       off-handler rebuild child is in flight
//   storage/health-reducer-state/rebuild.log (+ .1) — the child's stderr
//       (one `rebuild.start` JSON line, then any stack); rotated to .1 at
//       REBUILD_LOG_MAX_BYTES, so exactly two files ever exist
//   storage/health-reducer-state/rebuild-outcome.json — the last child's
//       exit record {schema, pid, started_at, finished_at, ok, error,
//       reason, state_saved, last_good_written}, written atomically
//       (tmp+rename) in the child's finally BEFORE it unlinks its marker, so
//       a reader never observes "no marker, no outcome" for a finished
//       child. The parent writes an ok:false/spawn-failed record when spawn
//       itself throws.
//
// THE NO-INLINE-FULL-SCAN CONTRACT. Before updateStateFromLedgers runs (it
// full-rebuilds INLINE on any verify failure — correct but O(file)), the
// handler pre-plans the fold: it bounds the bytes the update would have to
// read (appended delta on the healthy path; whole-file refold when the state
// is missing/corrupt/version-mismatched or a stored checkpoint no longer
// verifies). Pending work over REDUCER_INLINE_FOLD_MAX_BYTES NEVER runs on
// the request path: the call degrades — `synthesis_state_rebuilding:` note,
// last-known-good aggregates served with their built_at watermark (null
// before the first successful compute) — and the rebuild is scheduled OFF
// the handler as a detached child process (deduped via the marker file).
// Folds within the budget run inline: the steady-state warm path (a few KB
// of appended rows) and small hermetic test ledgers stay on the real-numbers
// path, while the production multi-GB rebuild can never block a health call.
// Sizing: the reducer folds ~600MB/s, so the 16 MiB budget caps the inline
// fold at ~30ms — comfortably inside the 250ms warm-path event-loop bound
// (measured 2026-07-14: full 2.27GB rebuild 3.6s in the child; warm delta
// fold ~40ms; coverage+drift computes ~100ms).
//
// THE ENVELOPE CACHE + ZERO-DELTA FAST PATH (H2b). Even with the reducer
// state warm, every call recomputed both envelopes from the full day-bucket
// state (~143ms coverage + ~152ms drift on the production state) and ran
// updateStateFromLedgers even when zero bytes had been appended (80-234ms of
// witness verification + checkpoint capture). Two request-path shavings:
//
//   1. Envelope cache: a single module-level entry (beside _reducerStateCache
//      below) holding the last successfully computed synthesis_coverage +
//      drift_alerts, keyed on
//        (statePath,
//         state.reducer_version,
//         the state's serialized checkpoint PAIR — memory + recall, which
//           encodes eof + the sha256 witness of each verified prefix,
//         each live ledger's stat identity (size + mtimeMs) — REQUIRED
//           because the computes fold the unterminated tail [eof, size) at
//           compute time (foldUnterminatedTail), so checkpoint identity
//           alone would keep serving numbers that DROP a freshly appended
//           tail row,
//         floor(nowMs / HEALTH_ENVELOPE_CACHE_BUCKET_MS)).
//      A hit serves deep copies (structuredClone both into and out of the
//      cache — a consumer mutating a served envelope can never poison it)
//      and KEEPS the cached built_at: it is the truth of when the numbers
//      were computed (same staleness-watermark discipline as last-good).
//      The cache is populated ONLY on the healthy compute path — never on,
//      and never served on, the degrade/last-good path. ROLLING-WINDOW
//      HONESTY: the coverage/drift window cutoffs slide with `now`, so a
//      hit inside one bucket serves cutoffs up to
//      HEALTH_ENVELOPE_CACHE_BUCKET_MS (60s) old — an accepted drift on
//      7/30-day windows; the equivalence gate (which pins one `now` against
//      a fresh state, and calls the compute functions directly underneath
//      this cache) is unaffected.
//   2. Zero-delta fast path: when planReducerFold verifies both checkpoints
//      and stat shows NO bytes appended past either eof (reason === null &&
//      pendingBytes === 0), updateStateFromLedgers is skipped entirely and
//      the computes run directly on the prior state — they re-run
//      requireVerifiedCheckpoint themselves, so no number is ever emitted
//      off an unverified offset. Nothing advanced, so saveState/last-good
//      persistence is skipped too (the existing advanced=false discipline).
//
// Both paths stay statSync-level on the request path; no new full scans, no
// new top-level fields, and the degrade contract is untouched.
// ---------------------------------------------------------------------------

const REDUCER_STATE_DIRNAME = "health-reducer-state";
const REDUCER_INLINE_FOLD_MAX_BYTES = 16 * 1024 * 1024;
// H2b — envelope-cache now-bucket width. The coverage/drift windows slide
// with `now`, so a cached envelope is only reusable while
// floor(nowMs / bucket) is unchanged; see the H2b block above for the
// accepted <=60s cutoff drift. Env-overridable (tests pin tiny/huge buckets
// without waiting on wall-clock rollover); opts.envelopeCacheBucketMs
// overrides per call.
const HEALTH_ENVELOPE_CACHE_BUCKET_MS = (() => {
  const v = Number(process.env.HEALTH_ENVELOPE_CACHE_BUCKET_MS);
  return Number.isFinite(v) && v > 0 ? v : 60_000;
})();
// A rebuild.pending marker younger than this suppresses duplicate child
// spawns; older markers are presumed crashed children and are re-scheduled.
const REBUILD_MARKER_TTL_MS = 15 * 60 * 1000;
// C1 — cap on the rebuild child's stderr log. Rotated active -> .1 before
// each spawn once over cap (telemetry.js:33-36 — the watermark daemon's
// 81.8MB unrotated stderr log is the standing counterexample that makes a
// bound a hard requirement).
const REBUILD_LOG_MAX_BYTES = 1 * 1024 * 1024;
const REBUILD_LOG_FILENAME = "rebuild.log";
const REBUILD_OUTCOME_FILENAME = "rebuild-outcome.json";

// In-process cache of the parsed reducer state, keyed by (path, mtime, size).
// state.json is ~24MB on the production tree; re-reading + re-validating it
// on every health call would cost ~50-80ms. The cached object is never
// mutated: updateStateFromLedgers has pure value semantics and the compute
// functions are read-only, so cache entries stay consistent with disk until
// another writer lands (mtime/size mismatch → re-read).
let _reducerStateCache = null;

function loadReducerStateCached(statePath) {
  let st;
  try {
    st = statSync(statePath);
  } catch {
    _reducerStateCache = null;
    return null;
  }
  if (
    _reducerStateCache !== null &&
    _reducerStateCache.statePath === statePath &&
    _reducerStateCache.mtimeMs === st.mtimeMs &&
    _reducerStateCache.size === st.size
  ) {
    return _reducerStateCache.state;
  }
  const state = loadState(statePath);
  if (state === null) {
    _reducerStateCache = null;
    return null;
  }
  _reducerStateCache = { statePath, mtimeMs: st.mtimeMs, size: st.size, state };
  return state;
}

function cacheReducerState(statePath, state) {
  try {
    const st = statSync(statePath);
    _reducerStateCache = { statePath, mtimeMs: st.mtimeMs, size: st.size, state };
  } catch {
    _reducerStateCache = null;
  }
}

// H2b — in-process envelope cache (single entry; see the ENVELOPE CACHE
// block above for the key composition and the accepted <=60s bucket drift).
// Value envelopes are structuredClone-d on the way IN and OUT, so neither a
// later consumer mutation nor a mutation of the served copy can poison it.
let _healthEnvelopeCache = null;

/**
 * Cache key for the computed envelopes, or null when no reducer state is
 * available (first-ever call / corrupt state — those paths never cache).
 * statSync-level only. The ledger stat identities are REQUIRED alongside the
 * checkpoint pair: the computes fold the unterminated tail [eof, size) at
 * compute time, so two calls with identical checkpoints but different tail
 * bytes must NOT share an entry. Callers capture the key BEFORE running the
 * computes — bytes appended mid-compute change the next call's stat identity
 * and force a conservative miss rather than ever risking a stale hit.
 */
function envelopeCacheKey(statePath, state, ledgerPath, recallLogPath, nowMs, bucketMs) {
  if (state === null) return null;
  const statId = (p) => {
    try {
      const st = statSync(p);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return "missing";
    }
  };
  return JSON.stringify([
    statePath,
    state.reducer_version,
    state.memory.checkpoint,
    state.recall.checkpoint,
    ledgerPath,
    statId(ledgerPath),
    recallLogPath,
    statId(recallLogPath),
    Math.floor(nowMs / bucketMs),
  ]);
}

/**
 * Pre-plan the reducer fold WITHOUT running it. Returns
 *   { inline: true, reason, pendingBytes }  — pending bytes fit the budget;
 *       safe to call updateStateFromLedgers on the request path. `reason` is
 *       null on the healthy incremental path and the raw rebuild trigger
 *       (e.g. "no-prior-state") when a small-file rebuild fits the budget.
 *       reason === null && pendingBytes === 0 certifies the ZERO-DELTA case
 *       (H2b): both stored checkpoints verified against the live files and
 *       stat shows no bytes appended past either checkpoint eof, so the fold
 *       would be a no-op and the caller may compute directly from the prior
 *       state (the computes re-run requireVerifiedCheckpoint themselves).
 *   { inline: false, reason, pendingBytes } — the update would refold more
 *       than `budget` bytes inline; the caller must degrade + schedule
 *       off-handler. `reason` here is the composed degrade-note string.
 *
 * BOTH shapes additionally carry `statErrors`: an array of { role, path, code }
 * for every ledger whose statSync failed with a NON-ENOENT errno (S5). It is a
 * pure report channel — pendingBytes, `reason`, the inline decision and the
 * `continue` are all unchanged by it — so the caller can surface an UNREADABLE
 * ledger instead of laundering it into the silent "missing ledger" path.
 *
 * Mirrors updateStateFromLedgers's own rebuild triggers (null/invalid state,
 * reducer_version mismatch, missing/invalid/unverifiable stored checkpoint)
 * so the request path never discovers an O(file) rebuild mid-call. A missing
 * ledger file is NOT a rebuild trigger (the update treats it as an empty
 * file-state without scanning anything).
 */
function planReducerFold(state, ledgerPath, recallLogPath, budget, verifyMemo) {
  let reason = null;
  if (state === null) reason = "no-prior-state";
  else if (state.reducer_version !== REDUCER_VERSION) reason = "reducer-version-mismatch";

  let pendingBytes = 0;
  // S5 — non-ENOENT stat errnos, reported to the caller instead of swallowed.
  const statErrors = [];
  for (const [role, path] of [
    ["memory", ledgerPath],
    ["recall", recallLogPath],
  ]) {
    let st;
    try {
      st = statSync(path);
    } catch (e) {
      // S5 — ENOENT really is "missing ledger" (empty file-state, zero fold
      // bytes) and stays silent here. Any OTHER errno (EACCES, ENOTDIR, EIO)
      // means the ledger EXISTS and cannot be read; that was laundered into
      // the same silent continue, which is how an unreadable 3 GB ledger
      // looked identical to an absent one. Record it; change nothing else.
      if (e && e.code && e.code !== "ENOENT") statErrors.push({ role, path, code: e.code });
      continue; // missing ledger: empty file-state, zero fold bytes
    }
    const size = st.size;
    if (reason !== null) {
      // Whole-state rebuild refolds every existing byte of this file.
      pendingBytes += size;
      continue;
    }
    const fileState = state[role];
    if (fileState.checkpoint === null) {
      // File was missing at the last update and exists now: per-file rebuild.
      reason = `${role}-ledger-appeared`;
      pendingBytes += size;
      continue;
    }
    const cp = deserializeCheckpoint(fileState.checkpoint);
    if (cp === null) {
      reason = `${role}-invalid-checkpoint`;
      pendingBytes += size;
      continue;
    }
    const pv = verifyPrefix(path, cp);
    if (!pv.ok) {
      reason = `${role}-${pv.reason}`;
      pendingBytes += size;
      continue;
    }
    // FINDING 1 — this file's stored checkpoint just verified. Memoize its
    // identity so computeCoverage/computeDrift can elide the sampled re-verify
    // while the live stat identity (size + mtimeMs) stays unchanged this call.
    if (verifyMemo instanceof Map) {
      verifyMemo.set(path, { checkpoint: fileState.checkpoint, size, mtimeMs: st.mtimeMs });
    }
    pendingBytes += Math.max(0, size - cp.eof);
  }

  if (pendingBytes > budget) {
    return {
      inline: false,
      reason: `${reason === null ? "append-delta-over-budget" : reason} (${pendingBytes} pending bytes > ${budget}-byte inline budget)`,
      pendingBytes,
      statErrors,
    };
  }
  return { inline: true, reason, pendingBytes, statErrors };
}

// last-good.json read/write now live in ../synthesis/last-good-aggregates.js
// so the detached rebuild child (scheduleRebuild below) can refresh the cache
// through the SAME implementation this path uses. See that module's header
// for why the child needs write access.

// FINDING 2 — the rebuild marker is an EXCLUSIVE single-claim gate, reusing the
// canonical acquireExclusiveLockFile discipline (index-wal.js / damping-log.js):
// the sole claim is an O_EXCL (openSync "wx") create carrying the winner's pid;
// every LOSER backs off WITHOUT spawning. A stale marker (its recorded pid is
// missing/dead OR its mtime is older than REBUILD_MARKER_TTL_MS — the const
// doubles as the in-flight window and the crashed-child staleness threshold) is
// reclaimed so a crashed child never wedges the gate. The finishing child
// clears ONLY its own pid-matched marker. This replaces the old statSync +
// plain writeFileSync (no O_EXCL, no ownership token) under which every racing
// process passed the check and spawned a detached multi-GB rebuild — a
// multi-process thundering herd (codex#10).

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === "EPERM") return true; // exists, just not ours
    return false; // ESRCH (and anything else): treat as dead
  }
}

// Reclaim the marker iff its recorded pid is missing/dead OR it is older than
// REBUILD_MARKER_TTL_MS. Returns true iff the marker was removed (or was
// already gone). Mirrors damping-log.js reclaimStaleLockIfDead (dead || stale).
function reclaimStaleMarker(markerPath) {
  let st;
  try {
    st = statSync(markerPath);
  } catch (e) {
    return !!(e && e.code === "ENOENT"); // already gone → effectively reclaimed
  }
  let pid = null;
  try {
    const body = JSON.parse(readFileSync(markerPath, "utf8"));
    if (Number.isInteger(body.pid)) pid = body.pid;
  } catch {
    // unreadable/torn marker body: cannot prove a live owner → treat as dead
  }
  const dead = pid == null || !pidAlive(pid);
  const stale = Date.now() - st.mtimeMs > REBUILD_MARKER_TTL_MS;
  if (!dead && !stale) return false; // a live, fresh owner holds the gate
  try {
    unlinkSync(markerPath);
  } catch (e) {
    if (!(e && e.code === "ENOENT")) return false;
  }
  return true;
}

// O_EXCL claim: create the marker or return null when another process already
// holds it (EEXIST). Any other error propagates.
function claimMarkerExclusive(markerPath) {
  try {
    return openSync(markerPath, "wx", 0o600); // O_WRONLY | O_CREAT | O_EXCL
  } catch (e) {
    if (e && e.code === "EEXIST") return null;
    throw e;
  }
}

// C1 — READ-ONLY marker liveness (the same dead||stale predicate as
// reclaimStaleMarker, minus the unlink). The degrade path uses it to decide
// whether "never completed" is attributable to a child that is still running;
// it must never reclaim — that is scheduleRebuild's exclusive job.
function rebuildMarkerLive(markerPath) {
  let st;
  try {
    st = statSync(markerPath);
  } catch {
    return false;
  }
  let pid = null;
  try {
    const body = JSON.parse(readFileSync(markerPath, "utf8"));
    if (Number.isInteger(body.pid)) pid = body.pid;
  } catch {
    return false; // torn/unreadable: cannot prove a live owner
  }
  if (!pidAlive(pid)) return false;
  return Date.now() - st.mtimeMs < REBUILD_MARKER_TTL_MS;
}

// C1 — fail-soft reader for rebuild-outcome.json (written by the child's
// finally / the parent's spawn-failure catch via writeJsonAtomic). Anything
// missing, torn, or non-object → null, so a half-written outcome can never
// throw on the request path.
function readRebuildOutcome(outcomePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(outcomePath, "utf8"));
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === "object" ? parsed : null;
}

/**
 * Default off-handler rebuild scheduler. EXCLUSIVELY claim the marker (O_EXCL),
 * then — only on winning — write our pid+ts ownership token (fsync'd) and spawn
 * a DETACHED node child that rebuilds the reducer state from the ledgers and
 * atomically persists it (updateStateFromLedgers handles both the full rebuild
 * and a cheap catch-up if a concurrent writer already fixed the state). A loser
 * (a live rebuild holds the gate) returns WITHOUT spawning. The handler never
 * waits on the child; the next health call after the child lands takes the
 * healthy incremental path. `spawnImpl` defaults to node:child_process spawn;
 * tests inject a spy to assert single-spawn hermetically. Tests may also
 * override the whole scheduler via opts.scheduleRebuild.
 *
 * The child ALSO recomputes the coverage/drift envelopes and refreshes
 * last-good.json. It previously stopped at saveState, which left the served
 * aggregates frozen for as long as calls kept degrading: last-good is
 * otherwise written only by the inline path, and the inline path is only
 * reachable under the 16 MiB pending budget. Observed live as a 13-day-stale
 * dashboard while state.json was current. `lastGoodPath` is optional — when
 * absent (older callers, hermetic tests) the child behaves exactly as before.
 */
export function scheduleReducerStateRebuild(
  { stateDir, statePath, markerPath, ledgerPath, recallLogPath, lastGoodPath = null, reason = null },
  spawnImpl = spawn,
) {
  mkdirSync(stateDir, { recursive: true });
  const logPath = join(stateDir, REBUILD_LOG_FILENAME);
  const outcomePath = join(stateDir, REBUILD_OUTCOME_FILENAME);
  const startedAt = new Date().toISOString();

  // Claim via O_EXCL. On EEXIST, try a single stale-reclaim + retry; if the
  // marker is STILL held a live rebuild owns the gate — back off (no spawn).
  let fd = claimMarkerExclusive(markerPath);
  if (fd === null) {
    reclaimStaleMarker(markerPath);
    fd = claimMarkerExclusive(markerPath);
    if (fd === null) return; // loser: a live rebuild owns the gate
  }

  // WON the claim. Write the ownership token (pid + ts), fsync, close.
  const ownerPid = process.pid;
  try {
    const body = Buffer.from(
      JSON.stringify({ pid: ownerPid, requested_at: new Date().toISOString() }) + "\n",
      "utf8",
    );
    let written = 0;
    while (written < body.length) {
      written += writeSync(fd, body, written, body.length - written);
    }
    fsyncSync(fd);
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }

  // C1 — bounded stderr log for the child. Rotate-if-over-cap BEFORE opening
  // (telemetry.js:226-236 discipline: ENOENT is benign — no log yet; any other
  // errno skips rotation but never suppresses the append). Then open in
  // append mode and hand the fd to spawn as the child's stdout+stderr. NEVER
  // "inherit"/"pipe": the parent's stdout is the MCP JSON-RPC channel.
  try {
    if (statSync(logPath).size >= REBUILD_LOG_MAX_BYTES) {
      renameSync(logPath, logPath + ".1");
    }
  } catch {
    /* ENOENT (no log yet) or a rotation errno: fall through and still append */
  }
  let logFd = null;
  try {
    logFd = openSync(logPath, "a", 0o600);
  } catch {
    logFd = null; // child streams fall back to "ignore"
  }

  const reducersHref = new URL("../synthesis/health-reducers.js", import.meta.url).href;
  const lastGoodHref = new URL("../synthesis/last-good-aggregates.js", import.meta.url).href;
  // The child's source. Observability contract (C1): first line on stderr is
  // a `rebuild.start` JSON event; every exit — success, throw, last-good
  // compute failure — lands in rebuild-outcome.json (atomic via the SAME
  // writeJsonAtomic last-good.json uses) BEFORE the pid-matched marker unlink,
  // so a reader never sees "no marker, no outcome" for a finished child.
  const code = [
    `import { loadState, saveState, updateStateFromLedgers, computeCoverageFromState, computeDriftFromState } from ${JSON.stringify(reducersHref)};`,
    `import { writeLastGoodAggregates, writeJsonAtomic } from ${JSON.stringify(lastGoodHref)};`,
    'import { mkdirSync, readFileSync, unlinkSync } from "node:fs";',
    'import { dirname } from "node:path";',
    `const statePath = ${JSON.stringify(statePath)};`,
    `const markerPath = ${JSON.stringify(markerPath)};`,
    `const lastGoodPath = ${JSON.stringify(lastGoodPath)};`,
    `const outcomePath = ${JSON.stringify(outcomePath)};`,
    `const reason = ${JSON.stringify(reason)};`,
    `const startedAt = ${JSON.stringify(startedAt)};`,
    `const ownerPid = ${ownerPid};`,
    "process.stderr.write(JSON.stringify({ event: 'rebuild.start', pid: process.pid, started_at: startedAt, reason }) + '\\n');",
    "let stateSaved = false, lastGoodWritten = false, error = null;",
    "try {",
    "  const { state } = updateStateFromLedgers(loadState(statePath), {",
    `    ledgerPath: ${JSON.stringify(ledgerPath)},`,
    `    recallLogPath: ${JSON.stringify(recallLogPath)},`,
    // Finding 3 — bound the persisted state written by the rebuild child.
    "    retentionNowMs: Date.now(),",
    "  });",
    "  mkdirSync(dirname(statePath), { recursive: true });",
    "  saveState(statePath, state);",
    "  stateSaved = true;",
    // Refresh the served aggregates from the state we just rebuilt. Without
    // this the degrade path serves a last-good that only the inline path ever
    // writes, so consecutive degraded calls freeze the dashboard indefinitely.
    // Isolated try/catch: a compute throw must neither clobber a good cache
    // (writeLastGoodAggregates is reached only on success) nor skip the marker
    // cleanup in the outer finally. The catch RECORDS the error (C1): a
    // last-good compute failure is exactly the class that freezes the served
    // dashboard, and it used to be swallowed by `catch {}`.
    "  if (typeof lastGoodPath === 'string' && lastGoodPath.length > 0) {",
    "    try {",
    "      const computeOpts = {",
    "        now: new Date(),",
    `        ledgerPath: ${JSON.stringify(ledgerPath)},`,
    `        recallLogPath: ${JSON.stringify(recallLogPath)},`,
    "      };",
    "      const coverage = computeCoverageFromState(state, computeOpts);",
    "      const drift = computeDriftFromState(state, computeOpts);",
    "      writeLastGoodAggregates(lastGoodPath, coverage, drift);",
    "      lastGoodWritten = true;",
    "    } catch (e) {",
    "      error = { name: (e && e.name) || 'Error', message_head: String((e && e.message) || e).slice(0, 120) };",
    "      process.stderr.write(String((e && e.stack) || e) + '\\n');",
    "      process.exitCode = 1;",
    "    }",
    "  }",
    "} catch (e) {",
    // No rethrow: recording + exitCode=1 keeps the finally on the normal path
    // so the outcome write and marker unlink always run.
    "  error = { name: (e && e.name) || 'Error', message_head: String((e && e.message) || e).slice(0, 120) };",
    "  process.stderr.write(String((e && e.stack) || e) + '\\n');",
    "  process.exitCode = 1;",
    "} finally {",
    "  // FIRST the outcome (atomic), THEN the marker: a reader that sees no",
    "  // marker must be able to find the outcome of the child that cleared it.",
    "  writeJsonAtomic(outcomePath, {",
    "    schema: 1,",
    "    pid: process.pid,",
    "    started_at: startedAt,",
    "    finished_at: new Date().toISOString(),",
    "    ok: error === null,",
    "    error,",
    "    reason,",
    "    state_saved: stateSaved,",
    "    last_good_written: lastGoodWritten,",
    "  });",
    "  // Clear ONLY our own marker: a sibling that stale-reclaimed ours and",
    "  // re-claimed the gate owns a marker with a DIFFERENT pid — never unlink",
    "  // that one.",
    "  try {",
    "    const m = JSON.parse(readFileSync(markerPath, 'utf8'));",
    "    if (m && m.pid === ownerPid) unlinkSync(markerPath);",
    "  } catch {}",
    "}",
  ].join("\n");
  try {
    try {
      const child = spawnImpl(process.execPath, ["--input-type=module", "-e", code], {
        detached: true,
        // Array form ALWAYS: never a bare string, never "inherit"/"pipe".
        // The parent's fd is a dup'd handle the child keeps; we close ours
        // below regardless of spawn outcome.
        stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
      });
      child.unref();
    } finally {
      if (logFd !== null) {
        try {
          closeSync(logFd);
        } catch {
          /* ignore */
        }
      }
    }
  } catch (e) {
    // Spawn failed — record it (C1: a spawn failure used to be silent), then
    // unlink OUR marker so a failed spawn doesn't wedge the gate for a full
    // TTL (freshly written with our pid; no child could have touched it, so
    // a plain unlink is our own marker).
    writeJsonAtomic(outcomePath, {
      schema: 1,
      pid: null,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      ok: false,
      error: {
        name: "spawn-failed",
        message_head: String((e && (e.code || e.message)) || e).slice(0, 120),
      },
      reason,
      state_saved: false,
      last_good_written: false,
    });
    try {
      unlinkSync(markerPath);
    } catch {
      /* best-effort */
    }
  }
}

function pathFor(sourcesDir, file) {
  return join(sourcesDir, file);
}

// Returns { bytes, exists, error, isFile } — never throws. `error` is non-null
// when statSync raised something other than ENOENT (e.g. EACCES); ENOENT
// collapses to exists=false with bytes=0.
//
// m2: `isFile` is an ADDITIVE field — true only on a successful statSync whose
// result is a regular file, false on both failure branches. statSync FOLLOWS
// symlinks, so a symlink pointing at a regular ledger reports isFile:true while
// one pointing at a directory reports false. bytes/exists/error are byte-
// identical to before, so the pre-existing call sites are unaffected.
function safeStatBytes(absPath) {
  try {
    const st = statSync(absPath);
    return { bytes: st.size, exists: true, error: null, isFile: st.isFile() };
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return { bytes: 0, exists: false, error: null, isFile: false };
    }
    return { bytes: 0, exists: false, error: e.code || e.message || String(e), isFile: false };
  }
}

// S5 — single formatter for the over-string-cap note, shared by the main-ledger
// pass and the SOURCE_LEDGERS loop so the two note strings can never drift.
// Pure string assembly: the caller has already paid for the byte count.
function overStringCapNote(label, bytes, cap) {
  return (
    `ledger_over_string_cap: ${label} bytes=${bytes} cap=${cap} ` +
    `ratio=${(bytes / cap).toFixed(2)} — whole-file readFileSync(utf8) of this ` +
    `ledger throws ERR_STRING_TOO_LONG`
  );
}

// Count newline-terminated records cheaply. Returns null + pushes a health
// note when the file exceeds LINE_COUNT_MAX_BYTES so the call stays cheap as
// the ledger grows. Empty files return 0. Missing files return 0.
function countLines(absPath, byteHint, notes, label) {
  if (byteHint > LINE_COUNT_MAX_BYTES) {
    notes.push(
      `source_event_count_skipped: ${label} (${byteHint} bytes > ${LINE_COUNT_MAX_BYTES}-byte budget)`
    );
    return null;
  }
  if (byteHint === 0) return 0;
  try {
    const buf = readFileSync(absPath);
    if (buf.length === 0) return 0;
    let count = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) count += 1; // '\n'
    }
    // Tolerate a trailing line without a final newline (defensive — the
    // ledger writer normally appends "\n" but the tail-write may be in flight).
    if (buf[buf.length - 1] !== 0x0a) count += 1;
    return count;
  } catch (e) {
    notes.push(`source_event_count_read_error: ${label}: ${e.code || e.message || String(e)}`);
    return null;
  }
}

// R32.1 removed: readLastDistillationTs + readDistillationState helpers.
// The conversational distillation pipeline (watermark.tickOnce, the
// distillation-supervisor, storage/distillation-queue/) was retired in
// R32; no on-disk state file feeds this surface anymore. The top-level
// `distillation_state` envelope field is preserved with a static
// deprecated-marker payload (see DEPRECATED_DISTILLATION_STATE above) so
// operator dashboards keep a stable shape; new code MUST NOT depend on
// the dynamic values. See kb/legacy-archive.md for the retired logic.

// Override-for-test plumbing. Tests pass opts with overridden paths/clock so
// the handler stays a pure function of its inputs. Production calls pass an
// empty object (or omit) and we resolve against the real homedir.
function resolveOpts(opts) {
  const o = opts || DEFAULT_OPTS;
  return {
    sourcesDir: o.sourcesDir || SOURCES_DIR,
    memoryLedgerPath: o.memoryLedgerPath || MEMORY_LEDGER_PATH,
    // Wave-10: recall.jsonl path threaded through so the synthesis-coverage
    // probe stays hermetic. Tests pin both ledger paths under MEMORY_ROOT;
    // production resolves to <MEMORY_ROOT>/ledgers/recall.jsonl.
    recallLogPath: o.recallLogPath || recallLedgerPath(),
    // S2d — per-model-version index tree root for the WAL-quarantine probe.
    // Tests pin it inside their temp tree; production resolves to
    // <MEMORY_ROOT>/indices.
    indicesDir: o.indicesDir || join(MEMORY_ROOT, "indices"),
    now: o.now instanceof Date ? o.now : new Date(),
    // H2 — reducer state directory (derived data; STORAGE_DIR honors
    // STORAGE_BASE_DIR, so hermetic tests get an isolated state dir for
    // free). NEVER under ledgers/.
    healthStateDir: o.healthStateDir || join(STORAGE_DIR, REDUCER_STATE_DIRNAME),
    // H2 — inline fold budget override (tests pass 0 to force the degrade
    // path deterministically on any pending fold bytes).
    inlineFoldMaxBytes:
      Number.isFinite(o.inlineFoldMaxBytes) && o.inlineFoldMaxBytes >= 0
        ? o.inlineFoldMaxBytes
        : REDUCER_INLINE_FOLD_MAX_BYTES,
    // S5 — string-cap threshold override (tests pin a tiny cap so the
    // over-cap note is reachable without writing a half-gigabyte fixture).
    // Production omits it and gets the real V8 limit.
    stringCapBytes:
      Number.isFinite(o.stringCapBytes) && o.stringCapBytes > 0
        ? o.stringCapBytes
        : LEDGER_STRING_CAP_BYTES,
    // H2 — off-handler rebuild scheduler override (tests pass a spy so
    // scheduling is assertable without spawning real child processes).
    scheduleRebuild:
      typeof o.scheduleRebuild === "function" ? o.scheduleRebuild : scheduleReducerStateRebuild,
    // H2b — envelope-cache now-bucket override (tests pin the bucket width so
    // rollover / non-rollover is deterministic under a pinned `now`).
    envelopeCacheBucketMs:
      Number.isFinite(o.envelopeCacheBucketMs) && o.envelopeCacheBucketMs > 0
        ? o.envelopeCacheBucketMs
        : HEALTH_ENVELOPE_CACHE_BUCKET_MS,
    // H2b — compute/fold seams. Tests pass spy wrappers around the real
    // functions to PROVE the envelope cache and the zero-delta fast path
    // actually skip work (same override-for-test pattern as scheduleRebuild).
    // Production callers omit these and get the real implementations.
    computeCoverage:
      typeof o.computeCoverage === "function" ? o.computeCoverage : computeCoverageFromState,
    computeDrift:
      typeof o.computeDrift === "function" ? o.computeDrift : computeDriftFromState,
    updateState:
      typeof o.updateState === "function" ? o.updateState : updateStateFromLedgers,
  };
}

// Exported as `buildHealthData` so tests can call without going through the
// MCP envelope path; the dispatch-facing handler wraps this in `ok()`.
// Async because tools_registered is resolved via a lazy dynamic import of
// dispatch.js (see getToolCount comment) — by handler-invocation time the
// cycle has resolved.
export async function buildHealthData(opts) {
  const {
    sourcesDir,
    memoryLedgerPath: ledgerPath,
    recallLogPath,
    indicesDir,
    now,
    healthStateDir,
    inlineFoldMaxBytes,
    stringCapBytes,
    scheduleRebuild,
    envelopeCacheBucketMs,
    computeCoverage,
    computeDrift,
    updateState,
  } = resolveOpts(opts);
  const healthNotes = [];

  // S2d — surface index-WAL corruption quarantines. A quarantined WAL means
  // recall is serving a degraded (valid-prefix-only) view for that model
  // version until the operator repairs the parked .corrupt-<epoch-ms> file.
  // Probe must never crash the health surface: readWalQuarantineNotes never
  // throws, and the readdir is wrapped (missing indices/ dir on a fresh
  // install is normal).
  try {
    for (const modelVersion of readdirSync(indicesDir)) {
      const { events } = readWalQuarantineNotes(join(indicesDir, modelVersion));
      if (events.length === 0) continue;
      const last = events[events.length - 1];
      healthNotes.push(
        `index_wal_quarantined: ${modelVersion} file=${last.quarantined_file} ` +
          `applied_seq=${last.applied_seq} ts=${last.ts} reason=${last.reason}`
      );
    }
  } catch {
    // No indices tree (fresh install) or unreadable dir — nothing to surface.
  }

  // S3g — surface refused/undeserializable ACTIVE index generations (clone
  // of the readdir probe above). For each model-version dir with an adopted
  // index-manifest.json, stat-compare every recorded member's size against
  // the on-disk size; any divergence means the next cold load REFUSES the
  // generation (verifyGenerationMembers' cheap-stat gate fails before any
  // hashing) and recall degrades — surface it as
  //   index_generation_refused: <mv> code=... member=... expected_size=...
  // A sha256-matching-size tamper is (accepted) out of this probe's reach:
  // stat-only, never hash (latency budget). Wrapped so it can never crash
  // the health surface.
  try {
    for (const modelVersion of readdirSync(indicesDir)) {
      const dir = join(indicesDir, modelVersion);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      // REG (memperf, S3g followup) — deserialize-refusal breadcrumb.
      // index-cache.js persists index-refusal.json when a VERIFIED
      // generation fails deserialize (checksums match, bytes don't decode —
      // invisible to the stat-mismatch probe below) and clears it on the
      // next successful cold serve. Surface it stat-level: one existsSync
      // gate + one tiny JSON read only when present; an unparseable
      // breadcrumb still surfaces (file presence IS the refusal signal).
      try {
        const refusalPath = join(dir, INDEX_REFUSAL_FILE);
        if (existsSync(refusalPath)) {
          let detail = "";
          try {
            const r = JSON.parse(readFileSync(refusalPath, "utf8"));
            detail =
              ` generation=${r.generation ?? "unknown"} label=${r.label ?? "unknown"}` +
              ` ts=${r.ts ?? "unknown"}`;
          } catch {
            detail = " (breadcrumb unparseable)";
          }
          healthNotes.push(
            `index_generation_refused: ${modelVersion} code=deserialize_failed${detail}`
          );
        }
      } catch {
        // never let the breadcrumb probe crash the health surface
      }
      const { manifest, error } = readActiveManifest(dir);
      if (error != null) {
        healthNotes.push(
          `index_generation_refused: ${modelVersion} code=${error.code}`
        );
        continue;
      }
      if (manifest == null || manifest.members == null) continue; // pre-adoption tree
      for (const key of ["bm25", "hnsw", "hnsw_meta"]) {
        const m = manifest.members[key] ?? null;
        if (m == null) continue;
        let st = null;
        try {
          st = statSync(join(dir, m.file));
        } catch {
          st = null;
        }
        if (st == null) {
          healthNotes.push(
            `index_generation_refused: ${modelVersion} code=index_manifest_member_missing ` +
              `member=${key} file=${m.file}`
          );
          break;
        }
        if (st.size !== m.size) {
          healthNotes.push(
            `index_generation_refused: ${modelVersion} code=index_manifest_member_mismatch ` +
              `member=${key} file=${m.file} expected_size=${m.size} actual_size=${st.size}`
          );
          break;
        }
      }
    }
  } catch {
    // No indices tree (fresh install) or unreadable dir — nothing to surface.
  }

  // S5 — MAIN-LEDGER READ-FAILURE PROBE. Exactly two extra statSync calls; no
  // reads, no hashing, no scans (health.js latency budget, see :78-82).
  //
  // memory.jsonl and recall.jsonl appeared NOWHERE in the memory_health
  // envelope: ledger_byte_counts is specified as "one entry per active SOURCE
  // ledger" and is pinned in the closed AUTHORITATIVE_FIELDS set, so both the
  // over-cap byte count and the stat errno ride inside health_notes rather than
  // widening any field.
  //
  // Deliberately NO `ledger_missing:` note for these two: an absent main ledger
  // is a normal cold-start state and would fire on every fresh install.
  const mainLedgerStatErrorLabels = new Set();
  for (const [label, abs] of [
    ["memory.jsonl", ledgerPath],
    ["recall.jsonl", recallLogPath],
  ]) {
    const st = safeStatBytes(abs);
    if (st.error) {
      healthNotes.push(`ledger_stat_error: ${label}: ${st.error}`);
      mainLedgerStatErrorLabels.add(label);
    }
    if (st.bytes > stringCapBytes) {
      healthNotes.push(overStringCapNote(label, st.bytes, stringCapBytes));
    }
  }

  // ledger_byte_counts + source_event_counts share one stat pass per source.
  const ledgerByteCounts = {};
  const sourceEventCounts = {};
  for (const { key, file } of SOURCE_LEDGERS) {
    const abs = pathFor(sourcesDir, file);
    const st = safeStatBytes(abs);
    if (st.error) {
      healthNotes.push(`ledger_stat_error: ${file}: ${st.error}`);
    }
    // m2: MISSING means genuinely absent (ENOENT), not merely unmeasurable. A
    // stat ERROR already emitted `ledger_stat_error:` above and must not ALSO
    // be reported as absent — s5 pinned exactly this for the main ledgers
    // ("an unreadable main ledger must not be laundered into ledger_missing:",
    // test/health-read-failures.test.mjs T3).
    if (!st.exists && !st.error) {
      healthNotes.push(`ledger_missing: ${file}`);
    }
    // S5 — same over-cap check as the main ledgers, reusing the byte count this
    // loop ALREADY computed: zero additional statSync calls.
    if (st.bytes > stringCapBytes) {
      healthNotes.push(overStringCapNote(file, st.bytes, stringCapBytes));
    }
    // m2: on a stat ERROR the size is unknown, and 0 would be a lie — write no
    // key and let health_notes carry the signal (null is unavailable: the
    // hash-pinned health_envelope_schema_v1 block types these values integer).
    // A genuine ENOENT keeps today's behaviour byte-for-byte: key at 0 PLUS the
    // `ledger_missing:` note, which test/ops-hygiene.test.mjs T1 requires
    // (ledger_byte_counts["auto-memory.jsonl"] === 0) and T3 pins.
    if (!st.error) {
      ledgerByteCounts[file] = st.bytes;
    }
    sourceEventCounts[key] = countLines(abs, st.bytes, healthNotes, file);
  }

  // m1: ledger_byte_counts is an OPEN map — kb/mcp-surface.md:994-995 declares
  // it `"<source>": integer  // one entry per active source ledger (chat-*.jsonl,
  // auto-memory.jsonl, telegram.jsonl, ...)`. Deriving it from SOURCE_LEDGERS
  // alone hid every ledger outside the registry (codex-cli/mail/git-log/
  // screentime/whatsapp/imessage/github-events — 805MB in production). So union
  // the registry names above with every *.jsonl regular file actually present.
  // source_event_counts stays CLOSED at its three keys per kb/mcp-surface.md:985
  // ("no field outside this list may be returned") — the loop above is its sole
  // driver and is untouched.
  //
  // m2 — CORRECTION OF A FALSIFIED CLAIM. This comment used to assert that
  // "discovered files exist by construction (no ledger_missing:/
  // ledger_stat_error: notes)", and the loop below acted on it: it kept only
  // safeStatBytes(...).bytes and dropped `exists`/`error`, so EVERY stat
  // failure was republished to the operator as a confident 0 — the same
  // absence-reported-as-a-value failure this file's probes exist to catch.
  // readdirSync + statSync is a TOCTOU pair, and the failure is reachable, not
  // theoretical: measured this session on uid 501 / Node v24.15.0, a directory
  // at mode 0444 (readable, NOT searchable) returned
  // readdirSync(...,{withFileTypes:true}) === [["x.jsonl", isFile:true]] while
  // statSync on that very entry threw EACCES. A dangling symlink and a file
  // unlinked between the readdir and the stat land the same way (ENOENT).
  // So: a failed stat writes NO key and pushes `ledger_stat_error:` instead.
  // `ledger_missing:` is NOT borrowed here — that note is the registry half's
  // contract for the three canonical names.
  //
  // The countLines rejection is unchanged and load-bearing: countLines
  // readFileSync's the whole file against a LINE_COUNT_MAX_BYTES budget of
  // 1,048,576 bytes, and the discovered ledgers measured live this session are
  // mail.jsonl 349,643,964 / codex-cli.jsonl 267,613,242 / git-log.jsonl
  // 123,854,983 bytes — 333x, 255x and 118x that budget. Bytes ONLY here.
  //
  // The type gate accepts a symlink whose target is a regular file:
  // dirent.isFile() is FALSE for a symlink while statSync FOLLOWS it (measured
  // this session: dirent link.jsonl isFile=false isSymbolicLink=true, and
  // statSync(link).isFile()===true at the target's 5000 bytes), so the registry
  // half already counted a symlinked ledger while this half silently dropped
  // it. Honest scope: `find <MEMORY_ROOT>/storage/sources -maxdepth
  // 1 -type l` printed nothing when re-run this session — this is a
  // two-halves-disagree CONSISTENCY fix with no live instance, not a production
  // defect. Directories are still excluded (a *.jsonl directory is neither
  // isFile nor isSymbolicLink, and a symlink resolving to one fails st.isFile),
  // which the nested.jsonl decoy bar in test/ops-hygiene.test.mjs depends on.
  //
  // Stat budget is unchanged for every entry the pass already counted: name
  // filters run BEFORE the type gate and the type gate before the stat, so
  // rejected entries still cost zero stats and each accepted candidate costs
  // exactly one. A missing/unreadable sourcesDir still degrades to the
  // registry-only map — the health surface must never throw.
  try {
    for (const dirent of readdirSync(sourcesDir, { withFileTypes: true })) {
      const name = dirent.name;
      // Skip dotfiles (.chat-claude-code.lock, .gitkeep) and further-suffixed
      // siblings (*.jsonl.offsets, *.jsonl.migrated-*, *.r14-backup).
      if (name.startsWith(".") || !name.endsWith(".jsonl")) continue;
      // Skip by REGISTRY NAME, not by map-key presence: a stat-errored registry
      // ledger writes no key above, and a hasOwnProperty guard would then let
      // this pass re-stat the same path and emit a duplicate
      // `ledger_stat_error:`. One fault, one note.
      if (REGISTRY_LEDGER_FILES.has(name)) continue;
      if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;
      const st = safeStatBytes(pathFor(sourcesDir, name));
      if (st.error) {
        healthNotes.push(`ledger_stat_error: ${name}: ${st.error}`);
        continue;
      }
      if (!st.exists) {
        // readdir already saw it, so this is a dangling symlink or a file
        // removed mid-call — an unmeasurable ledger, not an absent canonical
        // one. Report the errno; never a laundered 0, never `ledger_missing:`.
        healthNotes.push(`ledger_stat_error: ${name}: ENOENT`);
        continue;
      }
      // A symlink resolving to a directory (or any non-regular file): not a
      // ledger at all, so it is skipped silently — no key, no note.
      if (!st.isFile) continue;
      ledgerByteCounts[name] = st.bytes;
      if (st.bytes > stringCapBytes) {
        healthNotes.push(overStringCapNote(name, st.bytes, stringCapBytes));
      }
    }
  } catch {
    // Missing or unreadable sourcesDir — keep the SOURCE_LEDGERS-only map.
  }

  // B1 (task-hypergraph): real telegram_connector_status from the
  // drain-liveness detector (replaces the historical hardcoded
  // "not_installed"). The status reuses the existing enum
  // (mcp-surface.md:969) — a drain stall maps to "unhealthy" and is
  // disambiguated by the telegram_drain_stalled: health_note below. The probe
  // is a cheap statSync of the source ledger + staging file + a tiny
  // state.json read; it never reads a ledger's content. try/catch degrades to
  // "not_installed" + a probe-unreachable note so it can never crash the
  // health surface (mirrors the W7 cursor-lag / W10 coverage probe discipline).
  let telegramConnectorStatus = "not_installed";
  try {
    const drain = computeTelegramDrainStatus({ now });
    telegramConnectorStatus = drain.status;
    if (drain.drain_stalled) {
      const ledgerAgeH =
        typeof drain.ledger_age_ms === "number"
          ? Math.round((drain.ledger_age_ms / 3600000) * 10) / 10
          : "unknown";
      const stagingAgeM =
        typeof drain.staging_age_ms === "number"
          ? Math.round((drain.staging_age_ms / 60000) * 10) / 10
          : "unknown";
      healthNotes.push(
        `telegram_drain_stalled: ledger_age_h=${ledgerAgeH} staging_age_m=${stagingAgeM} unconsumed_bytes=${drain.unconsumed_bytes}`
      );
    }
  } catch (e) {
    telegramConnectorStatus = "not_installed";
    healthNotes.push(
      `telegram_drain_probe_unreachable: ${e && e.message ? e.message : String(e)}`
    );
  }

  // Phase 2 surface; not implemented in Phase 1. Spec L983 requires the int
  // field, so we return 0 and surface the unimplemented state via a note.
  // The note also makes test 3 (health_notes is always array) non-trivially
  // populated under default-path execution.
  const rederiveJobsPending = 0;
  healthNotes.push("rederive jobs not yet implemented (Phase 2)");

  // R32.1: static deprecated-marker. The pipeline that produced live values
  // here (watermark.tickOnce + distillation-supervisor) was retired in R32.
  const distillationState = DEPRECATED_DISTILLATION_STATE;

  // F-NEW-W2-CHAT-CC-HEALTH-PROBE — per-source effective_empty_rate over a
  // rolling 7-day window. status='degraded' when > 0.5 surfaces into
  // health_notes so the operator notices a 99.75%-empty-style regression
  // without tailing the JSONL sink directly.
  let effectiveEmptyRates = null;
  try {
    effectiveEmptyRates = computeEffectiveEmptyRatesForSources({ now });
    // Note assembly lives in the pure, hermetically-tested formatter
    // (lib/ingest/source-effective-empty-rate.js buildEmptyRateHealthNotes):
    // degraded note when status==='degraded', partial note when partial===true,
    // with window_covered_h guarded so a null-coverage partial scan renders
    // "unknown" instead of "nullh". Numeric-case strings are byte-identical
    // to the strings previously assembled inline here.
    healthNotes.push(...buildEmptyRateHealthNotes(effectiveEmptyRates));
    // B2 — unregistered operator mailboxes seen in the same mail tail
    // (lib/identity/alias-candidates.js). Empty by construction once every
    // address in the operator's own accounts is registered.
    healthNotes.push(
      ...buildAliasCandidateHealthNotes(effectiveEmptyRates ? effectiveEmptyRates.mail : null)
    );
  } catch {
    // Probe must never crash the health surface. The note absence is the
    // operator's signal that the probe is unreachable for this tick.
  }

  // g3 — mail frozen-prefix note. The probe above scans BACKWARD from EOF and
  // stops at the 7-day cutoff, so it is structurally incapable of reaching the
  // ~279k rows at the HEAD of mail.jsonl that the pre-fix .emlx resolver froze
  // at body_resolved=false. Left alone, health would report a healthy live
  // mail rate and say nothing about the envelope-only history behind it.
  //
  // ONE bounded positioned read from BOF (256KB, ~235 rows, sub-millisecond)
  // answers the only question that matters here: is the head bodyless while
  // the tail resolves? The note fires only when BOTH halves hold — a bodyless
  // head with a bodyless tail is a live outage, already covered by the
  // effective_empty_rate note above. Counts and rates only; no id, address,
  // subject, mailbox path or body text.
  try {
    healthNotes.push(
      ...buildMailBodyCoverageHealthNotes(
        probeMailLedgerHead({}),
        effectiveEmptyRates ? effectiveEmptyRates.mail : null
      )
    );
  } catch {
    // Probe must never crash the health surface. Note absence == probe
    // unreachable for this tick.
  }

  // F-NEW-W7-CURSOR-LAG-ALARM — surface stuck-cursor sources as health
  // notes. Each entry where warned=true emits a `cursor_lag_warn` line
  // with the lag in hours + cursor_ts + tail_ts so the operator can spot
  // the parked source without tailing the daemon stderr or grepping the
  // cursor JSON files. The snapshot is computed off the live cursor
  // files + ledger tails; no daemon RPC needed.
  try {
    const cursorLagSnapshot = computeCursorLagSnapshot({ now });
    for (const entry of cursorLagSnapshot) {
      if (!entry || !entry.warned) continue;
      const lagH =
        typeof entry.lag_ms === "number"
          ? Math.round(entry.lag_ms / 3600000)
          : "unknown";
      healthNotes.push(
        `cursor_lag_warn: ${entry.source} cursor=${entry.cursor_ts || "null"} tail=${entry.tail_ts || "null"} lag_h=${lagH}`
      );
    }
  } catch {
    // Probe must never crash the health surface. Note absence == probe
    // unreachable for this tick.
  }

  // c2 — SOURCE CAPTURE-STALENESS. The twin of the cursor-lag probe above and
  // the signal it structurally cannot carry: cursor lag measures cascade
  // backlog, so a source that STOPS producing lets the cursor catch up and
  // reads lag_h=0.0, identical to a healthy source (measured 2026-08-11:
  // github-events silent 88.6h, lag_h=0.0). This keys on capture evidence
  // instead — connectors/<s>/state.json.last_appended_ts and a statSync of
  // storage/sources/<s>.jsonl (never a content read) — and emits
  // source_capture_stale: / source_never_appended: / source_state_unreadable:
  // notes. Note assembly lives in the pure, hermetically-tested formatter
  // (lib/synthesis/connector-staleness.js buildCaptureStalenessHealthNotes).
  try {
    const captureStaleness = computeSourceCaptureStaleness({ now, sourcesDir });
    healthNotes.push(...buildCaptureStalenessHealthNotes(captureStaleness));
  } catch {
    // Probe must never crash the health surface. Note absence == probe
    // unreachable for this tick.
  }

  // H2 — reducer-backed synthesis_coverage + drift_alerts projections (the
  // Wave-10/12 envelopes, same closed shapes, computed from persisted day
  // buckets instead of a per-call full ledger scan). See the REDUCER-BACKED
  // SYNTHESIS PROJECTIONS block above for the persistence layout and the
  // no-inline-full-scan contract. Degrade path (over-budget fold, corrupt /
  // stale state, or a compute-time verify throw): serve the last-known-good
  // envelopes (their built_at is the staleness watermark; null before the
  // first successful compute), append the `synthesis_state_rebuilding:`
  // note — the only additive surface H2 itself introduced — and schedule the
  // rebuild OFF the handler. S5 later added a SECOND, non-colliding note on
  // this same path, `synthesis_aggregates_stale:`, which reports how old the
  // last-known-good envelopes being served actually are; both are health_notes
  // strings, so the closed top-level field set is still untouched.
  let synthesisCoverage = null;
  let driftAlerts = null;
  {
    const statePath = join(healthStateDir, "state.json");
    const lastGoodPath = join(healthStateDir, "last-good.json");
    const markerPath = join(healthStateDir, "rebuild.pending");
    let degradeReason = null;

    const priorState = loadReducerStateCached(statePath);
    const nowMs = now.getTime();

    // H2b — envelope-cache probe (statSync-level; see the ENVELOPE CACHE
    // block above). A hit means the reducer state AND both live ledgers are
    // byte-identical to a previous HEALTHY compute in this same now-bucket:
    // serve deep copies of those envelopes — cached built_at kept, no note,
    // no fold, no compute. Anything else falls through to the full path.
    const probeKey = envelopeCacheKey(
      statePath, priorState, ledgerPath, recallLogPath, nowMs, envelopeCacheBucketMs,
    );
    if (probeKey !== null && _healthEnvelopeCache !== null && _healthEnvelopeCache.key === probeKey) {
      synthesisCoverage = structuredClone(_healthEnvelopeCache.synthesis_coverage);
      driftAlerts = structuredClone(_healthEnvelopeCache.drift_alerts);
    } else {
      // FINDING 1 — per-call verify memo. planReducerFold records each ledger
      // it just verified; the compute functions consult the memo to skip a
      // redundant sampled re-verify of an unchanged file (a cheap statSync
      // re-check is always retained, so loudness is preserved).
      const verifyMemo = new Map();
      const plan = planReducerFold(
        priorState, ledgerPath, recallLogPath, inlineFoldMaxBytes, verifyMemo,
      );
      // S5 — surface the non-ENOENT stat errnos the fold planner used to
      // launder into "missing ledger". DEDUPED against the main-ledger pass
      // above: both sites stat the SAME two paths within one call, so a single
      // underlying fault must produce a single note.
      for (const se of plan.statErrors) {
        const label = se.role === "memory" ? "memory.jsonl" : "recall.jsonl";
        if (mainLedgerStatErrorLabels.has(label)) continue;
        mainLedgerStatErrorLabels.add(label);
        healthNotes.push(`ledger_stat_error: ${label}: ${se.code}`);
      }
      if (!plan.inline) {
        degradeReason = plan.reason;
      } else {
        try {
          let state;
          let advanced;
          if (plan.reason === null && plan.pendingBytes === 0 && priorState !== null) {
            // H2b — zero-delta fast path: both checkpoints verified and stat
            // shows nothing appended past either eof, so the fold would be a
            // no-op. Compute directly from the prior state (the computes run
            // requireVerifiedCheckpoint themselves — no unverified numbers).
            // Nothing advanced, so persistence below stays skip-unless-absent.
            state = priorState;
            advanced = false;
          } else {
            // FINDING 3 — bound the persisted state to the retention window.
            const res = updateState(priorState, {
              ledgerPath,
              recallLogPath,
              retentionNowMs: nowMs,
            });
            state = res.state;
            // Persist only when the fold actually advanced (a rebuild ran or
            // delta rows were applied) or nothing is on disk yet — back-to-back
            // health calls with an idle ledger skip the ~24MB rewrite + fsync.
            advanced =
              res.stats.memory.mode === "rebuild" ||
              res.stats.recall.mode === "rebuild" ||
              res.stats.memory.linesApplied > 0 ||
              res.stats.recall.linesApplied > 0;
          }
          // Key captured BEFORE the computes: bytes appended mid-compute
          // change the next probe's stat identity → conservative miss, never
          // a stale hit claiming tail bytes the numbers below don't include.
          const populateKey = envelopeCacheKey(
            statePath, state, ledgerPath, recallLogPath, nowMs, envelopeCacheBucketMs,
          );
          // FINDING 1 — verifyMemo skips re-verify on the zero-delta path
          // (state === priorState, checkpoint + stat identity unchanged); on
          // the append path the advanced checkpoint no longer matches the
          // memo, so the computes verify exactly as before.
          const computeOpts = { now, ledgerPath, recallLogPath, verifyMemo };
          synthesisCoverage = computeCoverage(state, computeOpts);
          driftAlerts = computeDrift(state, computeOpts);
          try {
            if (advanced || !existsSync(statePath)) {
              mkdirSync(healthStateDir, { recursive: true });
              saveState(statePath, state);
              cacheReducerState(statePath, state);
            }
            if (advanced || !existsSync(lastGoodPath)) {
              mkdirSync(healthStateDir, { recursive: true });
              writeLastGoodAggregates(lastGoodPath, synthesisCoverage, driftAlerts);
            }
          } catch {
            // Persistence is best-effort: the numbers above are already
            // computed and verified; a failed save only costs a refold later.
          }
          // Populate ONLY here — the healthy compute path. The degrade path
          // below never caches and never serves from the cache.
          if (populateKey !== null) {
            _healthEnvelopeCache = {
              key: populateKey,
              synthesis_coverage: structuredClone(synthesisCoverage),
              drift_alerts: structuredClone(driftAlerts),
            };
          }
        } catch (e) {
          // Compute-time verify failure (ledger rewritten mid-call, stale
          // offsets, ...) — the state needs a rebuild; never emit numbers off
          // unverified offsets.
          degradeReason = e && e.message ? e.message : String(e);
          synthesisCoverage = null;
          driftAlerts = null;
        }
      }
    }

    if (degradeReason !== null) {
      healthNotes.push(`synthesis_state_rebuilding: ${degradeReason}`);
      const lastGood = readLastGoodAggregates(lastGoodPath);
      synthesisCoverage = lastGood === null ? null : lastGood.synthesis_coverage;
      driftAlerts = lastGood === null ? null : lastGood.drift_alerts;
      // S5 — name the AGE of what we just decided to serve. The
      // synthesis_state_rebuilding: note above says a rebuild is pending; it
      // does NOT say how old the numbers the operator is reading actually are.
      // A live call served aggregates 51.7h stale with nothing saying so.
      // Pure Date arithmetic on an object already in hand — no extra I/O.
      // Null-guarded because readLastGoodAggregates explicitly permits
      // synthesis_coverage === null (last-good-aggregates.js:43-48).
      // The prefix is deliberately NOT synthesis_state_rebuilding: colliding
      // with it would break health-real-data.test.mjs:363 / :767, which assert
      // that prefix is ABSENT on their healthy fixtures.
      const servedBuiltAt = lastGood?.synthesis_coverage?.built_at;
      if (typeof servedBuiltAt === "string") {
        const builtMs = Date.parse(servedBuiltAt);
        const ageMs = nowMs - builtMs;
        if (Number.isFinite(builtMs) && ageMs > AGGREGATE_STALE_MAX_MS) {
          const ageH = Math.round((ageMs / 3_600_000) * 10) / 10;
          healthNotes.push(
            `synthesis_aggregates_stale: built_at=${servedBuiltAt} age_h=${ageH}`
          );
        }
      }
      // C1 — did the LAST rebuild child actually finish, and how? One small
      // fail-soft read of rebuild-outcome.json (<=1 KB; degrade path only —
      // the healthy/inline path gains no I/O). Missing/torn/non-object → null
      // → no note, never a throw.
      const outcome = readRebuildOutcome(join(healthStateDir, REBUILD_OUTCOME_FILENAME));
      if (
        outcome?.ok === false &&
        (lastGood === null ||
          typeof lastGood.saved_at !== "string" ||
          String(outcome.finished_at) > lastGood.saved_at)
      ) {
        // Unsuperseded failure: nothing good has been written since it ended.
        healthNotes.push(
          `synthesis_rebuild_failed: finished_at=${outcome.finished_at} ` +
            `${outcome.error?.name ?? "Error"}: ${String(outcome.error?.message_head ?? "").slice(0, 120)}`,
        );
      }
      if (
        (lastGood === null || typeof lastGood.synthesis_coverage?.built_at !== "string") &&
        outcome === null &&
        !rebuildMarkerLive(markerPath)
      ) {
        // No last-good, no outcome, no live child: nothing has ever been
        // observed to finish. This fires on the very first-ever degraded call
        // (before scheduleRebuild below creates the marker) and is literally
        // true then; the next call sees the live marker or the outcome.
        // Read-only liveness check — reclaiming is scheduleRebuild's job.
        healthNotes.push("synthesis_rebuild_never_completed");
      }
      try {
        scheduleRebuild({
          stateDir: healthStateDir,
          statePath,
          markerPath,
          ledgerPath,
          recallLogPath,
          lastGoodPath,
          reason: degradeReason,
        });
      } catch {
        // Scheduling is best-effort; the next health call re-schedules.
      }
    }
  }

  // A1 — recall-liveness gate, nested at synthesis_coverage.recall_liveness.
  //
  // DEFAULT-OFF. With MEMORY_RECALL_LIVENESS_GATE unset the whole block is
  // skipped and the envelope stays byte-identical to today — the property
  // test/health-real-data.test.mjs:404/:544/:624 pin by JSON.stringify-
  // comparing synthesis_coverage across cached / degraded calls.
  //
  // NESTED, NEVER TOP-LEVEL: health-real-data.test.mjs:78 AUTHORITATIVE_FIELDS
  // is a CLOSED top-level key set. A new top-level health key would break the
  // closed-envelope contract, so the verdict rides inside synthesis_coverage.
  //
  // NULL-GUARD IS MANDATORY: synthesisCoverage is legitimately null on the
  // compute-throw path (:1102) and on the degrade path when no last-known-good
  // exists (:1111). Attaching must never throw there — flag on + null coverage
  // returns null coverage, unchanged.
  //
  // NON-MUTATING: a NEW object is built rather than assigning onto
  // synthesisCoverage. The cache-hit path (:1019) already hands us a
  // structuredClone and the healthy path populates _healthEnvelopeCache with
  // its own clone strictly before this point, but copying here makes it
  // impossible for a later edit to poison _healthEnvelopeCache
  // .synthesis_coverage — or the last-known-good aggregates read off disk at
  // :1111 — with a stale verdict served on a subsequent call.
  //
  // The probe is a verdict adapter over the ALREADY-computed coverage source
  // and deliberately never forwards a ledgerPath, so this costs a read of
  // recall.jsonl (~20 MB) and never touches memory.jsonl (2.9 GB). See
  // lib/synthesis/recall-liveness-probe.js header, DEFECT GUARD.
  if (
    process.env.MEMORY_RECALL_LIVENESS_GATE === "1" &&
    synthesisCoverage !== null &&
    typeof synthesisCoverage === "object"
  ) {
    try {
      // `now` IS FORWARDED. This is the one call site holding a clock, and
      // dropping it made `evaluated_at` wall-clock-dependent under flag=1 —
      // which is exactly what the JSON.stringify envelope-identity pins at
      // health-real-data.test.mjs:404/:544/:624 cannot survive. resolveOpts
      // guarantees a Date (:732), and the probe forwards it into
      // computeSynthesisCoverage the same way (recall-liveness-probe.js:144).
      //
      // TWO RATES, ONE ENVELOPE: the enclosing snapshot is computed at
      // coverage-probe.js:56 DEFAULT_WINDOW_DAYS = 7 while the nested verdict
      // runs at 3650, so the verdict carries `enclosing_window_days` next to
      // its own `window_days` / `denominator` / `rate_basis`. A reader sees
      // 3650 vs 7 side by side instead of cross-referencing two modules.
      const enclosingWindowDays =
        Number.isFinite(synthesisCoverage.window_days) ? synthesisCoverage.window_days : null;
      const recallLiveness = await evaluateRecallLiveness({ recallLogPath, now });
      synthesisCoverage = {
        ...synthesisCoverage,
        recall_liveness: { ...recallLiveness, enclosing_window_days: enclosingWindowDays },
      };
    } catch (e) {
      // The probe throws only on an UNREADABLE recall ledger (coverage-probe's
      // LOUD-FAILURE contract: an unreadable ledger is NOT an empty one). Never
      // launder that into a verdict — surface a note and leave the key absent.
      healthNotes.push(
        `recall_liveness_probe_unreachable: ${e && e.message ? e.message : String(e)}`,
      );
    }
  }

  const toolsRegistered = await getToolCount();

  return {
    schema_version: HEALTH_SCHEMA_VERSION,
    server_started_at: SERVER_STARTED_AT,
    time_now: now.toISOString(),
    tools_registered: toolsRegistered,
    telegram_connector_status: telegramConnectorStatus,
    source_event_counts: sourceEventCounts,
    ledger_byte_counts: ledgerByteCounts,
    policy_events_active_file: currentActiveFile({ now }),
    policy_events_disk_bytes: policyEventsDiskBytes(),
    rederive_jobs_pending: rederiveJobsPending,
    distillation_state: distillationState,
    synthesis_coverage: synthesisCoverage,
    drift_alerts: driftAlerts,
    health_notes: healthNotes,
  };
}

async function handler(args) {
  assertObjectShape(args, "args", []);
  return ok(NAME, await buildHealthData());
}

export const TOOL = {
  name: NAME,
  description: "System health summary. Read-only. Cheap. Safe to call from a status line.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler,
};
