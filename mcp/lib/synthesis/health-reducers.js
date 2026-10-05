// health-reducers.js — H1: per-UTC-day sufficient statistics over
// memory.jsonl + recall.jsonl that answer computeSynthesisCoverage
// (coverage-probe.js) and detectDrift (drift-detector.js) questions WITHOUT
// re-streaming the full ledger.
//
// WHY: memory_health (mcp/lib/tools/health.js) calls both full-scan probes on
// every invocation; each streams + JSON-parses the entire 2.18GB memory.jsonl
// AND recall.jsonl — 7.3s of event-loop blocking per health call. This module
// folds the ledgers ONCE into day buckets, updates incrementally via the S1
// checkpoint primitive (ledger-checkpoint.js), and computes both envelopes
// from the buckets plus an exact positioned-read replay of ONLY the boundary
// days of each rolling window.
//
// THE TWO TIMESTAMP RULES (deliberately asymmetric — see the WU-health-
// string-cap-fix doc blocks in both originals; do NOT "fix" the asymmetry):
//
//   Rule A (coverage, coverage-probe.js:103-111):
//     tsField = (typeof ts === "string" && ts) || (typeof created_at ===
//     "string" && created_at) || null; Date.parse; skip non-finite; window
//     is INCLUSIVE both ends [cutoffMs, nowMs]. A row with a NON-EMPTY but
//     unparseable `ts` does NOT fall through to `created_at` — it is skipped.
//
//   Rule B (drift, drift-detector.js:163-195):
//     `ts` field ONLY (no created_at fallback); future rows (tsMs > nowMs)
//     dropped; baseline [now-30d, now-7d) half-open, current [now-7d, now]
//     inclusive.
//
//   Whenever `ts` is a parseable non-empty string the two rules yield the
//   SAME tsMs; they diverge only on rows drift skips (missing / empty /
//   unparseable ts with a parseable created_at). Hence each day bucket keeps
//   TWO sub-aggregates: `both` (admitted by both rules, bucketed by the
//   shared tsMs) and `covOnly` (created_at-fallback rows, bucketed by the
//   coverage tsMs). Coverage sums both + covOnly; drift sums `both` only.
//
// STATE SHAPE (JSON-serializable value; no module-scope mutable caches):
//   {
//     reducer_version: REDUCER_VERSION,
//     memory: { checkpoint: serializeCheckpoint(cp)|null,
//               days: { [utcDayIndex]: dayBucket } },
//     recall: { ...same shape, recall-side aggregates... },
//   }
//   utcDayIndex = Math.floor(tsMs / 86400000). Each dayBucket:
//     both:    per-rule sub-aggregate (see emptyMemAgg / emptyRecallAgg)
//     covOnly: same shape, created_at-fallback rows only
//     bothOff: flat [off1, len1, off2, len2, ...] byte positions of the
//              `both` rows (byteLength EXCLUDES the terminating "\n")
//     covOff:  same, for covOnly rows
//   The offsets exist so BOUNDARY days of a rolling window can be replayed
//   row-exactly with positioned reads: interior days (entirely inside the
//   window) are summed from the aggregates; the day containing the cutoff /
//   the anchor is re-read and each row re-classified with the exact rule.
//
// HOSTILE VERSION STRINGS (H1b hardening). Per-axis version histograms hold
// ONLY genuine version strings (any string, including Object.prototype
// property names like "constructor" and "__proto__", and the literal string
// "_missing_"); rows with a missing/empty version are counted OUT-OF-BAND in
// the per-axis `vMissing` counter. All histogram reads/writes go through
// hasOwnProperty-guarded helpers so prototype-named keys count correctly on
// the plain (JSON round-trip / structuredClone-stable) objects the state is
// made of. The "_missing_" sentinel-collision decision (H1b): keeping the
// missing count out-of-band lets drift's version sets include a LITERAL
// "_missing_" version string exactly like drift-detector.js:263-266, while
// coverage's envelope merges literal + genuinely-missing under the sentinel
// key exactly like coverage-probe.js:187-190 (see envelopeVersionHists,
// which also reproduces the originals' plain-object tick semantics for
// prototype-named keys so the differential gate compares EXACT envelopes).
//
// UNTERMINATED-TAIL CONTRACT (H1b). The checkpoint's newline-safe eof never
// covers bytes [eof, size): a writer that crashed (or is mid-append) between
// the JSON body and its "\n" leaves a COMPLETE but unterminated final row
// that _ledger-stream.js:226-238 counts and the checkpoint excludes. The
// compute functions close that divergence by opportunistically parsing the
// current [eof, stat.size) tail bytes at COMPUTE time and folding any valid
// complete rows WITHOUT checkpointing them (foldUnterminatedTail): once the
// row is terminated, the next update folds it into the state exactly once.
// This is a bounded delta read (O(bytes appended since the last update)),
// not a full-ledger scan, and it makes the H2 real-ledger equivalence gate
// immune to mid-append / crashed-writer flake.
//
// BOUNDED STATE (Finding 3). updateStateFromLedgers accepts an opt-in
// `retentionNowMs` anchor; when present it prunes whole day buckets older than
// RETENTION_WINDOW_DAYS + RETENTION_MARGIN_DAYS (30d + 2d) so the persisted
// state stays bounded by the window rather than by total ledger lifetime
// (structuredClone + serialize + fsync cost scaled with history otherwise).
// The compute functions read at most a 30d window (drift baseline; coverage
// default 7d), so a pruned state supports windows <= RETENTION_WINDOW_DAYS with
// output IDENTICAL to a full-history rebuild — pruning removes only whole OLD
// buckets, never a bucket any <=30d window reads, and touches neither the
// checkpoint nor any retained bucket's offsets. Absent the anchor (the default,
// and every path the equivalence gate exercises) NOTHING is pruned, so the
// output stays byte-equivalent. No REDUCER_VERSION bump: pruning is
// shape-valid and forward/backward compatible.
//
// VERIFY MEMO (Finding 1). computeCoverageFromState / computeDriftFromState
// accept an opt-in per-call `verifyMemo` (Map: path -> {checkpoint, size,
// mtimeMs}) captured by the caller from a checkpoint it ALREADY verified this
// synchronous call. requireVerifiedCheckpoint / requireStillVerified skip the
// sampled verifyPrefix ONLY when the file's current stat identity AND stored
// checkpoint match the memo (a cheap statSync re-check is always retained);
// otherwise they verify exactly as before. Absent the memo (the default, and
// every existing caller/test) full loudness is preserved.
//
// LOUDNESS CONTRACT: the compute functions NEVER emit numbers off unverified
// offsets. verifyPrefix (sampled sha256 witness) must pass against the stored
// checkpoint at compute time; any failure THROWS with a message naming the
// reason. H2's memory_health caller catches into the existing
// `*_unreachable` health-note path — exactly the degrade route the full-scan
// originals use for an unreadable ledger. Three H1b additions:
//   - boundary-day replay BINDS every stored offset to its bucket: the
//     re-read row must re-classify to the same sub-aggregate and UTC day, or
//     the compute throws "state-offset-mismatch" (a shape-valid state with
//     aliased/swapped offsets must never silently double-count);
//   - after ALL positioned reads, verifyPrefix runs a SECOND time so a
//     rewrite that lands mid-compute (after the entry verify, before the
//     numbers escape) is caught (sampled-witness limitation still applies);
//   - updateOneFile's incremental path requires the freshly captured
//     checkpoint's witness to PREFIX-EXTEND the prior witness; when
//     captureCheckpoint fell back to a fresh sample because the prior
//     checkpoint failed its in-capture re-verify (a rewrite landed in the
//     verify->capture TOCTOU window) the update is forced to a full rebuild
//     with reason "capture-fallback" instead of binding old aggregates to a
//     checkpoint of the new file. A fresh sample that captureCheckpoint
//     marked prefix-certified-by-prev (S1c: witness-budget overflow on a
//     legitimately appended file) stays INCREMENTAL under the compacted
//     witness with reason "witness-compacted" — no periodic full re-stream.
//
// WHAT THIS MODULE DOES NOT DO (H2 owns those seams):
//   - no memory_health handler wiring, no daemon, no persistence-location
//     policy (saveState/loadState take a caller-supplied path);
//   - NO backfill enqueue: the drift-detector.js:530-551 side channel is
//     opt-in and health.js never opts in — the reducer compute path must not
//     write the queue.
//
// DISCIPLINE: ESM, Node stdlib only. Source ledgers are never written. The
// only full-ledger read is the explicit rebuild path (readAppended from
// emptyCheckpoint()); incremental updates read the appended delta plus the
// O(witness) verification ranges; computes read witness ranges plus the
// stored boundary-day rows.

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  BLOCK_BYTES,
  captureCheckpoint,
  deserializeCheckpoint,
  emptyCheckpoint,
  readAppended,
  serializeCheckpoint,
  verifyPrefix,
} from "./ledger-checkpoint.js";
// Imported — never copied — so the drift envelope can never version-skew
// against the full-scan original (H1 invariant).
import {
  DRIFT_ALERT_KINDS,
  DRIFT_CAPS,
  DRIFT_DETECTOR_VERSION,
} from "./drift-detector.js";
import { DEFAULT_WINDOW_DAYS } from "./coverage-probe.js";

/** Bump on ANY change to bucket semantics / aggregate fields / timestamp
 *  rules. A persisted state with a different reducer_version is rebuilt from
 *  scratch by updateStateFromLedgers.
 *  v0.2.0 (H1b): mem aggregates gained the per-axis `vMissing` out-of-band
 *  missing-version counters and version histograms now hold genuine version
 *  strings only — an on-disk shape change, hence the bump.
 *  v0.3.0: isValencePopulated now recognizes the structured
 *  {sign, magnitude, source, model_version} object the cascade actually
 *  persists (distill-promote-fact.js:992), not just the legacy scalar. This
 *  changes the valPop count a bucket yields for identical input, so every
 *  persisted bucket computed under v0.2.0 holds valPop:0 and MUST be
 *  recomputed — without this bump the fix would apply only to newly folded
 *  rows and valence_coverage would stay 0% for the whole retained window. */
export const REDUCER_VERSION = "v0.3.0";

const DAY_MS = 24 * 60 * 60 * 1000;

// Finding 3 — bounded-state retention horizon. RETENTION_WINDOW_DAYS is pinned
// to the widest window any compute reads (drift's baseline window,
// DRIFT_CAPS.BASELINE_WINDOW_DAYS = 30d); RETENTION_MARGIN_DAYS is documented
// slack so the boundary day of the widest window (and the day just below it,
// which the boundary-aligned classify already drops) is never at risk of being
// pruned under forward clock movement between the pruning anchor and a later
// compute `now`. Buckets strictly older than
// day(retentionNowMs) - (RETENTION_WINDOW_DAYS + RETENTION_MARGIN_DAYS) can
// never be read by a <=30d window and are dropped whole.
export const RETENTION_WINDOW_DAYS = DRIFT_CAPS.BASELINE_WINDOW_DAYS;
export const RETENTION_MARGIN_DAYS = 2;

const VERSION_AXES = Object.freeze([
  "entity_extractor_version",
  "episodicity_version",
  "time_anchor_resolver_version",
  "valence_model_version",
]);

/** coverage-probe.js:187-190 sentinel for missing/empty version strings.
 *  The reducer state does NOT store missing rows under this key (they live
 *  in the out-of-band vMissing counters — see the module header); the key is
 *  only re-materialized at coverage-envelope time by envelopeVersionHists,
 *  where a LITERAL "_missing_" version string merges with genuinely-missing
 *  rows exactly like the original. */
const MISSING_VERSION_KEY = "_missing_";

// Severity ladder — replica of the module-private SEVERITY in
// drift-detector.js:129-133 (not exported there by design).
const SEVERITY = Object.freeze({
  INFO: "info",
  WARN: "warn",
  CRITICAL: "critical",
});

// ---------------------------------------------------------------------------
// Replicated module-private predicates. coverage-probe.js and
// drift-detector.js keep these private on purpose (H2's gate diffs against
// the UNMODIFIED originals); the differential tests in
// mcp/test/synthesis/health-reducers.test.mjs guard against divergence.
// ---------------------------------------------------------------------------

// coverage-probe.js:309-312 / drift-detector.js:201-208.
function looksLikeFact(row) {
  if (!row) return false;
  return (
    row.kind === "fact" ||
    row.kind === "reconstructed_fact" ||
    row.features != null
  );
}

// coverage-probe.js:142-179 / drift-detector.js:212-231.
function isEntitiesPopulated(row) {
  const f = row && row.features;
  if (f == null || typeof f !== "object") return false;
  return Array.isArray(f.entities) && f.entities.length > 0;
}
function isTimeAnchorPopulated(row) {
  const f = row && row.features;
  if (f == null || typeof f !== "object") return false;
  return Array.isArray(f.time_anchors) && f.time_anchors.length > 0;
}
// features.valence is the structured object {sign, magnitude, source,
// model_version} on disk (distill-promote-fact.js:992), NOT a scalar — the
// scalar is a factValenceScalar projection applied at index time. Testing
// typeof === "number" pinned valence_coverage to 0%. Legacy scalar rows
// still count. Presence semantics, matching isEpisodicityPopulated.
function isValencePopulated(row) {
  const f = row && row.features;
  if (f == null || typeof f !== "object") return false;
  if (typeof f.valence === "number") return Number.isFinite(f.valence);
  const v = f.valence;
  if (v == null || typeof v !== "object") return false;
  return typeof v.sign === "number" && Number.isFinite(v.sign);
}
function isEpisodicityPopulated(row) {
  const f = row && row.features;
  if (f == null || typeof f !== "object") return false;
  return typeof f.episodicity === "number" && Number.isFinite(f.episodicity);
}

// ---------------------------------------------------------------------------
// Prototype-safe histogram plumbing (H1b — hostile version strings).
//
// The state's histograms are PLAIN objects (JSON round-trip and
// structuredClone both re-materialize plain objects, so a null-prototype
// container could not survive persistence anyway). Plain-object subscript
// reads/writes are hostile-key traps: `hist["constructor"] || 0` resolves
// the inherited Object constructor (turning the count into a garbage
// string), and `hist["__proto__"] = n` is a silent no-op through the
// inherited setter. Every histogram access therefore goes through these two
// helpers: hasOwnProperty-guarded reads and defineProperty writes create
// honest own data properties for ANY string key.
// ---------------------------------------------------------------------------

function histGet(hist, key) {
  return Object.prototype.hasOwnProperty.call(hist, key) ? hist[key] : 0;
}

function histSet(hist, key, value) {
  Object.defineProperty(hist, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

// coverage-probe.js:130-135.
function pct(populated, total) {
  if (total === 0) return 0;
  return Math.round((populated / total) * 10000) / 10000;
}

// coverage-probe.js:202-230 (recall-side populator predicates).
function isRecallEntitiesPopulated(event) {
  const p = event && event.populator;
  if (p == null || typeof p !== "object") return false;
  return typeof p.entities_count === "number" && p.entities_count > 0;
}
function isRecallTimeAnchorPopulated(event) {
  const p = event && event.populator;
  if (p == null || typeof p !== "object") return false;
  if (p.has_time_anchor === true) return true;
  return typeof p.time_anchors_count === "number" && p.time_anchors_count > 0;
}
function isRecallValencePopulated(event) {
  const p = event && event.populator;
  if (p == null || typeof p !== "object") return false;
  // inferred_mood_sign === 0 is the neutral fallback stamp and counts as
  // NOT populated (coverage-probe.js:215-223).
  return typeof p.inferred_mood_sign === "number" && p.inferred_mood_sign !== 0;
}
function isRecallDegraded(event) {
  if (event == null || typeof event !== "object") return false;
  if (event.degraded_recall === true) return true;
  const p = event.populator;
  return p != null && typeof p === "object" && p.degraded === true;
}

// drift-detector.js:314-317.
function r4(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

// drift-detector.js:322-325.
function coverageDropSeverity(dropPct) {
  const threshold = DRIFT_CAPS.COVERAGE_DROP_THRESHOLD_PCT;
  return dropPct >= threshold * 2 ? SEVERITY.CRITICAL : SEVERITY.WARN;
}

// drift-detector.js:329-341.
function pushCoverageDropAlert(alerts, axis, baselinePct, currentPct) {
  const dropPct = (baselinePct - currentPct) * 100;
  if (dropPct <= DRIFT_CAPS.COVERAGE_DROP_THRESHOLD_PCT) return;
  alerts.push({
    kind: DRIFT_ALERT_KINDS.COVERAGE_DROP,
    axis,
    severity: coverageDropSeverity(dropPct),
    baseline: r4(baselinePct),
    current: r4(currentPct),
    drift_pct: r4(dropPct),
  });
}

// drift-detector.js:347-379. Alert FIRING is order-independent (only
// cardinality + membership/disjointness matter); the version ARRAYS we pass
// in are lexicographically sorted (Set-insertion file order is not
// reconstructible from day buckets) — see canonicalizeDriftEnvelope.
function pushVersionBumpAlerts(alerts, baselineVersions, currentVersions) {
  for (const axis of Object.keys(currentVersions)) {
    const cur = currentVersions[axis];
    const base = baselineVersions[axis] || [];
    if (cur.length === 0) continue;
    if (cur.length > 1) {
      alerts.push({
        kind: DRIFT_ALERT_KINDS.EXTRACTOR_VERSION_BUMP,
        axis,
        severity: SEVERITY.INFO,
        baseline: base.slice(),
        current: cur.slice(),
        drift_pct: 0,
      });
      continue;
    }
    if (base.length > 0 && !base.includes(cur[0])) {
      alerts.push({
        kind: DRIFT_ALERT_KINDS.EXTRACTOR_VERSION_BUMP,
        axis,
        severity: SEVERITY.INFO,
        baseline: base.slice(),
        current: cur.slice(),
        drift_pct: 0,
      });
    }
  }
}

// drift-detector.js:384-396.
function pushEntityCountDropAlert(alerts, baselineAvg, currentAvg) {
  if (baselineAvg <= 0) return;
  const dropPct = ((baselineAvg - currentAvg) / baselineAvg) * 100;
  if (dropPct <= DRIFT_CAPS.ENTITY_COUNT_DROP_THRESHOLD_PCT) return;
  alerts.push({
    kind: DRIFT_ALERT_KINDS.ENTITY_COUNT_DROP,
    axis: "entities_per_fact",
    severity: coverageDropSeverity(dropPct),
    baseline: r4(baselineAvg),
    current: r4(currentAvg),
    drift_pct: r4(dropPct),
  });
}

// drift-detector.js:402-414.
function pushQueryEpisodicityDriftAlert(alerts, baselineAvg, currentAvg, baselineN, currentN) {
  if (baselineN === 0 || currentN === 0) return;
  const driftPct = Math.abs(baselineAvg - currentAvg) * 100;
  if (driftPct <= DRIFT_CAPS.COVERAGE_DROP_THRESHOLD_PCT) return;
  alerts.push({
    kind: DRIFT_ALERT_KINDS.QUERY_EPISODICITY_DRIFT,
    axis: "query_episodicity",
    severity: SEVERITY.WARN,
    baseline: r4(baselineAvg),
    current: r4(currentAvg),
    drift_pct: r4(driftPct),
  });
}

// ---------------------------------------------------------------------------
// Timestamp classification (the both/covOnly split — module header).
// ---------------------------------------------------------------------------

/**
 * Classify a parsed row under BOTH timestamp rules.
 * @returns {{sub: "both"|"covOnly", tsMs: number}|null} null = admitted by
 *   neither rule (including the rule-A no-fallthrough case: a non-empty but
 *   unparseable `ts` shadows a parseable `created_at`).
 */
function classifyRowTs(row) {
  // Rule B first: `ts` only. When it admits, rule A's tsField is the same
  // non-empty `ts` string, so both rules share this tsMs.
  const tsB = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
  if (Number.isFinite(tsB)) return { sub: "both", tsMs: tsB };
  // Rule A: ts (non-empty string) || created_at (non-empty string) || null.
  // Note a non-empty unparseable ts lands here as tsField === row.ts and
  // parses NaN — NO fallthrough to created_at (coverage-probe.js:103-108).
  const tsField =
    (typeof row.ts === "string" && row.ts) ||
    (typeof row.created_at === "string" && row.created_at) ||
    null;
  const tsA = tsField ? Date.parse(tsField) : NaN;
  if (Number.isFinite(tsA)) return { sub: "covOnly", tsMs: tsA };
  return null;
}

// ---------------------------------------------------------------------------
// State constructors, folds, merges, validation.
// ---------------------------------------------------------------------------

function emptyVersionHists() {
  return {
    entity_extractor_version: {},
    episodicity_version: {},
    time_anchor_resolver_version: {},
    valence_model_version: {},
  };
}

function emptyVersionMissing() {
  return {
    entity_extractor_version: 0,
    episodicity_version: 0,
    time_anchor_resolver_version: 0,
    valence_model_version: 0,
  };
}

/** Memory-side sub-aggregate (rows passing looksLikeFact only). */
function emptyMemAgg() {
  return {
    facts: 0,
    entPop: 0,
    taPop: 0,
    valPop: 0,
    epPop: 0,
    // Sum of features.entities.length over entity-POPULATED rows only
    // (drift-detector.js:255-258).
    entityTokenSum: 0,
    // Per-axis version COUNT histograms over GENUINE version strings only
    // (a literal "_missing_" version is a genuine string and lands here).
    // Coverage's extractor_versions = envelopeVersionHists(hist, vMissing);
    // drift's version sets = ALL histogram keys (matching the original
    // sliceStats Set, which admits any non-empty string).
    versions: emptyVersionHists(),
    // Out-of-band per-axis count of rows with a missing/empty version
    // (H1b — avoids the "_missing_" sentinel collision, see module header).
    vMissing: emptyVersionMissing(),
  };
}

/** Recall-side sub-aggregate (rows with kind === "recall" only). */
function emptyRecallAgg() {
  return {
    recalls: 0,
    entPop: 0,
    taPop: 0,
    valPop: 0, // inferred_mood_sign === 0 counts as NOT populated
    degraded: 0,
    // qeN/qeSum over recalls with a finite populator.query_episodicity
    // (drift-detector.js:295-309 denominator discipline).
    qeN: 0,
    qeSum: 0,
  };
}

function emptyAgg(role) {
  return role === "memory" ? emptyMemAgg() : emptyRecallAgg();
}

function emptyDayBucket(role) {
  return {
    both: emptyAgg(role),
    covOnly: emptyAgg(role),
    bothOff: [],
    covOff: [],
  };
}

function emptyFileState() {
  return { checkpoint: null, days: {} };
}

/** Fresh empty reducer state. */
export function createEmptyState() {
  return {
    reducer_version: REDUCER_VERSION,
    memory: emptyFileState(),
    recall: emptyFileState(),
  };
}

function foldMemoryRow(agg, row) {
  agg.facts += 1;
  if (isEntitiesPopulated(row)) {
    agg.entPop += 1;
    agg.entityTokenSum += row.features.entities.length;
  }
  if (isTimeAnchorPopulated(row)) agg.taPop += 1;
  if (isValencePopulated(row)) agg.valPop += 1;
  if (isEpisodicityPopulated(row)) agg.epPop += 1;
  const f = row.features || {};
  for (const axis of VERSION_AXES) {
    const v = f[axis];
    // Same admission split as BOTH originals: coverage-probe.js:187-190
    // (sentinel) and drift-detector.js:263-266 (Set membership) admit
    // exactly non-empty strings; everything else is "missing".
    if (typeof v === "string" && v.length > 0) {
      histSet(agg.versions[axis], v, histGet(agg.versions[axis], v) + 1);
    } else {
      agg.vMissing[axis] += 1;
    }
  }
}

function foldRecallRow(agg, ev) {
  agg.recalls += 1;
  if (isRecallEntitiesPopulated(ev)) agg.entPop += 1;
  if (isRecallTimeAnchorPopulated(ev)) agg.taPop += 1;
  if (isRecallValencePopulated(ev)) agg.valPop += 1;
  if (isRecallDegraded(ev)) agg.degraded += 1;
  const p = ev.populator;
  if (p != null && typeof p === "object") {
    const qe = p.query_episodicity;
    if (typeof qe === "number" && Number.isFinite(qe)) {
      agg.qeN += 1;
      agg.qeSum += qe;
    }
  }
}

/** Merge a memory sub-aggregate into an accumulator of the same shape. */
function addMemAgg(dst, src) {
  dst.facts += src.facts;
  dst.entPop += src.entPop;
  dst.taPop += src.taPop;
  dst.valPop += src.valPop;
  dst.epPop += src.epPop;
  dst.entityTokenSum += src.entityTokenSum;
  for (const axis of VERSION_AXES) {
    const sh = src.versions[axis];
    const dh = dst.versions[axis];
    // Object.keys yields OWN keys only, so hostile keys ("constructor",
    // "__proto__", ...) merge as honest counts through the guarded helpers.
    for (const k of Object.keys(sh)) histSet(dh, k, histGet(dh, k) + sh[k]);
    dst.vMissing[axis] += src.vMissing[axis];
  }
}

function addRecallAgg(dst, src) {
  dst.recalls += src.recalls;
  dst.entPop += src.entPop;
  dst.taPop += src.taPop;
  dst.valPop += src.valPop;
  dst.degraded += src.degraded;
  dst.qeN += src.qeN;
  dst.qeSum += src.qeSum;
}

// --- strict shape validation (loadState / saveState / update / compute) ----

function isNonNegInt(x) {
  return Number.isInteger(x) && x >= 0;
}

function isPlainObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function isValidVersionHists(v) {
  if (!isPlainObject(v)) return false;
  for (const axis of VERSION_AXES) {
    const h = v[axis];
    if (!isPlainObject(h)) return false;
    // Object.keys sees own keys only; own "__proto__"/"constructor" data
    // properties (created by histSet and preserved by JSON.parse /
    // structuredClone) are validated like any other key.
    for (const k of Object.keys(h)) if (!isNonNegInt(h[k])) return false;
  }
  return true;
}

function isValidVersionMissing(m) {
  if (!isPlainObject(m)) return false;
  for (const axis of VERSION_AXES) if (!isNonNegInt(m[axis])) return false;
  return true;
}

function isValidMemAgg(a) {
  if (!isPlainObject(a)) return false;
  for (const k of ["facts", "entPop", "taPop", "valPop", "epPop", "entityTokenSum"]) {
    if (!isNonNegInt(a[k])) return false;
  }
  return isValidVersionHists(a.versions) && isValidVersionMissing(a.vMissing);
}

function isValidRecallAgg(a) {
  if (!isPlainObject(a)) return false;
  for (const k of ["recalls", "entPop", "taPop", "valPop", "degraded", "qeN"]) {
    if (!isNonNegInt(a[k])) return false;
  }
  return typeof a.qeSum === "number" && Number.isFinite(a.qeSum);
}

/**
 * Offset-pair array validation, BOUND to the stored checkpoint (H1b).
 * Every (off, len) pair must address bytes strictly inside the verified
 * prefix [0, eof) — a pair reaching past eof can never have been folded by
 * this module — and offsets must be STRICTLY ascending within the array
 * (applyLine appends in file order, so duplicates/reorderings only arise
 * from corruption; a duplicated pair would double-count silently).
 */
function isValidOffsets(arr, eof) {
  if (!Array.isArray(arr) || arr.length % 2 !== 0) return false;
  let prevOff = -1;
  for (let i = 0; i < arr.length; i += 2) {
    const off = arr[i];
    const len = arr[i + 1];
    if (!isNonNegInt(off) || !Number.isInteger(len) || len < 1) return false;
    if (off + len > eof) return false;
    if (off <= prevOff) return false;
    prevOff = off;
  }
  return true;
}

function isValidDayBucket(b, role, eof) {
  if (!isPlainObject(b)) return false;
  const aggOk = role === "memory" ? isValidMemAgg : isValidRecallAgg;
  if (!aggOk(b.both) || !aggOk(b.covOnly)) return false;
  if (!isValidOffsets(b.bothOff, eof) || !isValidOffsets(b.covOff, eof)) return false;
  // Row-count/offset-count coherence: applyLine records exactly one (off,
  // len) pair per folded row, so a mismatch means tampered aggregates or
  // dropped offsets — either would corrupt boundary-day replay.
  const rowKey = role === "memory" ? "facts" : "recalls";
  if (b.bothOff.length !== 2 * b.both[rowKey]) return false;
  if (b.covOff.length !== 2 * b.covOnly[rowKey]) return false;
  return true;
}

/** Canonical UTC-day keys only: "01", "-0", "1e3", " 7" etc. are rejected —
 *  a non-canonical key aliases a canonical one at compute time (Number()
 *  bucketing) and can double-count or throw mid-compute. */
function isCanonicalDayKey(key) {
  const n = Number(key);
  return Number.isSafeInteger(n) && String(n) === key;
}

function isValidFileState(fs, role) {
  if (!isPlainObject(fs)) return false;
  let eof = null;
  if (fs.checkpoint !== null) {
    const cp = deserializeCheckpoint(fs.checkpoint);
    if (cp === null) return false;
    eof = cp.eof;
  }
  if (!isPlainObject(fs.days)) return false;
  const keys = Object.keys(fs.days);
  // A null (file-missing) or empty (eof 0) checkpoint can never have folded
  // a row — non-empty days under it are semantically impossible (H1b).
  if (keys.length > 0 && (eof === null || eof === 0)) return false;
  for (const key of keys) {
    if (!isCanonicalDayKey(key)) return false;
    if (!isValidDayBucket(fs.days[key], role, eof)) return false;
  }
  return true;
}

/**
 * Strict whole-state validation. reducer_version must be PRESENT (a string)
 * but is not required to EQUAL REDUCER_VERSION here — updateStateFromLedgers
 * detects the mismatch and rebuilds with reason "reducer-version-mismatch";
 * the compute functions refuse a mismatched state loudly.
 */
function isValidState(state) {
  if (!isPlainObject(state)) return false;
  if (typeof state.reducer_version !== "string" || state.reducer_version.length === 0) {
    return false;
  }
  return isValidFileState(state.memory, "memory") && isValidFileState(state.recall, "recall");
}

// ---------------------------------------------------------------------------
// updateStateFromLedgers
// ---------------------------------------------------------------------------

function normPath(p) {
  return typeof p === "string" && p.length > 0 ? p : null;
}

function witnessBytes(cp) {
  let n = 0;
  for (const e of cp.witness) n += e.len;
  return n;
}

/**
 * Does newCp's witness PREFIX-EXTEND priorCp's witness (identical off/len/
 * hash for the first priorCp.witness.length entries)? True for every
 * checkpoint captureCheckpoint({prev}) produced on its incremental path
 * (prev's witness is reused verbatim and only new blocks are appended); a
 * FRESH fallback sample — captureCheckpoint's response to a rewrite landing
 * in the verify->capture TOCTOU window, or a witness-budget overflow — fails
 * it. updateOneFile then consults the capture's prefix-certified-by-prev
 * signal (S1c): budget-overflow resamples (newCp.prefixVerified) keep the
 * incremental fold under the compacted witness; unverified fresh samples
 * force a full rebuild instead of binding old-prefix aggregates to a
 * checkpoint of a possibly-different file (H1b).
 */
function witnessPrefixExtends(newCp, priorCp) {
  const pw = priorCp.witness;
  const nw = newCp.witness;
  if (nw.length < pw.length) return false;
  for (let i = 0; i < pw.length; i++) {
    if (nw[i].off !== pw[i].off || nw[i].len !== pw[i].len || nw[i].hash !== pw[i].hash) {
      return false;
    }
  }
  return true;
}

/**
 * TEST-ONLY seam. When set, `beforeIncrementalCapture({role, path})` runs
 * inside updateOneFile's incremental path AFTER the prior checkpoint
 * verified and BEFORE captureCheckpoint — the exact TOCTOU window the
 * capture-fallback guard exists for. Production code must never set this;
 * it exists so the fault-injection test can interleave a same-eof rewrite
 * deterministically. Always reset it to null in a finally block.
 */
export const __testHooks = { beforeIncrementalCapture: null };

/** Fold one delta line into a file-state. Malformed JSON / non-object /
 *  role-irrelevant / timestamp-inadmissible rows are skipped (mirrors the
 *  originals' silent-skip discipline). */
function applyLine(fileState, role, text, off, len) {
  let row;
  try {
    row = JSON.parse(text);
  } catch {
    return;
  }
  if (row == null || typeof row !== "object") return;
  // Rows that contribute to NEITHER probe are not stored at all:
  // coverage-probe.js:309-312 narrows memory rows to looksLikeFact;
  // both recall-side consumers narrow to kind === "recall".
  if (role === "memory") {
    if (!looksLikeFact(row)) return;
  } else if (row.kind !== "recall") {
    return;
  }
  const cls = classifyRowTs(row);
  if (cls === null) return;
  const key = String(Math.floor(cls.tsMs / DAY_MS));
  let bucket = fileState.days[key];
  if (!bucket) {
    bucket = emptyDayBucket(role);
    fileState.days[key] = bucket;
  }
  if (cls.sub === "both") {
    if (role === "memory") foldMemoryRow(bucket.both, row);
    else foldRecallRow(bucket.both, row);
    bucket.bothOff.push(off, len);
  } else {
    if (role === "memory") foldMemoryRow(bucket.covOnly, row);
    else foldRecallRow(bucket.covOnly, row);
    bucket.covOff.push(off, len);
  }
}

/**
 * Update (or build) the state for ONE source file.
 * @returns {{fileState: object, fileStats: object}}
 */
function updateOneFile(role, path, priorFileState, forcedReason) {
  const fileStats = { mode: "rebuild", reason: null, linesApplied: 0, bytesRead: 0 };

  // Missing file mirrors the originals' missing-file behavior: empty state
  // for that file, no throw (coverage-probe.js:92-94, drift-detector.js:165).
  if (path === null || !existsSync(path)) {
    fileStats.reason = "missing";
    return { fileState: emptyFileState(), fileStats };
  }

  let reason = forcedReason;
  let priorCp = null;
  if (reason === null) {
    if (!isValidFileState(priorFileState, role)) {
      reason = "invalid-file-state";
    } else if (priorFileState.checkpoint === null) {
      // The file was missing at the prior update and exists now.
      reason = "no-prior-checkpoint";
    } else {
      priorCp = deserializeCheckpoint(priorFileState.checkpoint);
      if (priorCp === null) {
        reason = "invalid-checkpoint";
      } else {
        // ANY verify failure (shrunk / prefix-drift / missing / io-error /
        // invalid-checkpoint) forces a full rebuild — correct, just slow.
        const pv = verifyPrefix(path, priorCp);
        if (!pv.ok) reason = pv.reason;
      }
    }
  }

  if (reason === null) {
    // Incremental path: extend the checkpoint cheaply ({prev} reuses the
    // prior witness verbatim) and fold ONLY the appended delta rows.
    if (__testHooks.beforeIncrementalCapture !== null) {
      __testHooks.beforeIncrementalCapture({ role, path });
    }
    const newCp = captureCheckpoint(path, { prev: priorCp });
    // S1c: disambiguate captureCheckpoint's two fresh-sample fallbacks via
    // the non-enumerable prefix-certified-by-prev signal it attaches when
    // priorCp verified INSIDE the capture call:
    //   - prefixVerified true  — witness-budget overflow on a legitimately
    //     appended file: the [0, priorCp.eof) prefix is proven byte-identical,
    //     so the incremental fold stays sound under the fresh COMPACTED
    //     witness (mode "incremental", reason "witness-compacted") — no
    //     full re-stream every ~63 append-updates, zero extra witness reads;
    //   - flag absent — priorCp failed capture's internal re-verify, i.e. a
    //     genuine rewrite landed in the verify->capture TOCTOU window: fail
    //     over to a full rebuild rather than checkpoint old numbers over new
    //     bytes (H1b TOCTOU guard, reason "capture-fallback").
    const witnessCompacted =
      newCp !== null &&
      newCp.eof >= priorCp.eof &&
      !witnessPrefixExtends(newCp, priorCp) &&
      newCp.prefixVerified === true;
    if (
      newCp !== null &&
      newCp.eof >= priorCp.eof &&
      !witnessPrefixExtends(newCp, priorCp) &&
      !witnessCompacted
    ) {
      reason = "capture-fallback";
    } else if (newCp !== null && newCp.eof >= priorCp.eof) {
      // Pure value semantics: never mutate the caller's state.
      const fileState = structuredClone(priorFileState);
      const res = readAppended(path, priorCp, newCp, (text, off, len) =>
        applyLine(fileState, role, text, off, len),
      );
      if (res.error === null) {
        fileState.checkpoint = serializeCheckpoint(newCp);
        fileStats.mode = "incremental";
        if (witnessCompacted) fileStats.reason = "witness-compacted";
        fileStats.linesApplied = res.lines;
        // Honest accounting of actual bytes read off disk:
        //   - our verifyPrefix above re-read the prior witness ranges;
        //   - captureCheckpoint({prev}) internally verifies prev again
        //     (hence the 2x) and hashes only the NEW sample blocks — or, on
        //     the witness-compacted resample, the FULL fresh witness;
        //   - findNewlineSafeEof scans backward <= one BLOCK_BYTES window;
        //   - readAppended scanned res.bytes_scanned bytes of delta
        //     (includes blank/oversized-skip bytes, unlike res.bytes).
        fileStats.bytesRead =
          res.bytes_scanned +
          2 * witnessBytes(priorCp) +
          (witnessCompacted
            ? witnessBytes(newCp)
            : Math.max(0, witnessBytes(newCp) - witnessBytes(priorCp))) +
          Math.min(BLOCK_BYTES, newCp.size);
        return { fileState, fileStats };
      }
      reason = `delta-read-failed:${res.error}`;
    } else {
      reason = "capture-failed";
    }
  }

  // Full rebuild from the origin cursor — the ONLY full-ledger scan path.
  const cp = captureCheckpoint(path);
  if (cp === null) {
    // File vanished / unreadable between existsSync and capture.
    fileStats.reason = "capture-failed";
    return { fileState: emptyFileState(), fileStats };
  }
  const fileState = emptyFileState();
  const res = readAppended(path, emptyCheckpoint(), cp, (text, off, len) =>
    applyLine(fileState, role, text, off, len),
  );
  if (res.error !== null) {
    // Fail-closed: a state checkpointed off a partial rebuild scan would be
    // silently biased toward the file head. Mirrors the originals'
    // loud-unreadable contract (coverage-probe.js:113-120,
    // drift-detector.js:186-193) — an unreadable ledger is NOT an empty one.
    throw new Error(
      `health-reducers: full rebuild scan failed (${res.error}) at ${path}; ` +
        "refusing to checkpoint a partial fold",
    );
  }
  fileState.checkpoint = serializeCheckpoint(cp);
  fileStats.mode = "rebuild";
  fileStats.reason = reason;
  fileStats.linesApplied = res.lines;
  fileStats.bytesRead = res.bytes_scanned + witnessBytes(cp) + Math.min(BLOCK_BYTES, cp.size);
  return { fileState, fileStats };
}

/**
 * pruneFileStateDays (Finding 3) — drop whole day buckets older than the
 * retention horizon anchored at retentionNowMs, IN PLACE. The floor day is
 *   floor(retentionNowMs / DAY_MS) - (RETENTION_WINDOW_DAYS + RETENTION_MARGIN_DAYS)
 * and every day key strictly BELOW it is deleted; all days >= the floor and
 * all future days are retained. Only whole OLD buckets are removed — the
 * checkpoint and every retained bucket's aggregates/offsets are untouched, so
 * the pruned file-state still passes isValidFileState (strictly-ascending
 * in-eof offsets, row/offset-count coherence, canonical day keys all survive).
 * A no-finite anchor is a no-op. Returns the same fileState for chaining.
 */
export function pruneFileStateDays(fileState, retentionNowMs) {
  if (!Number.isFinite(retentionNowMs)) return fileState;
  if (!isPlainObject(fileState) || !isPlainObject(fileState.days)) return fileState;
  const floorDay =
    Math.floor(retentionNowMs / DAY_MS) - (RETENTION_WINDOW_DAYS + RETENTION_MARGIN_DAYS);
  for (const key of Object.keys(fileState.days)) {
    if (Number(key) < floorDay) delete fileState.days[key];
  }
  return fileState;
}

/**
 * updateStateFromLedgers — fold both ledgers into a NEW state value.
 *
 * Per file: a null/invalid prior state or a reducer_version mismatch forces
 * a full rebuild; otherwise verifyPrefix gates an incremental delta fold
 * (any failure → full rebuild with the recorded reason). The input state is
 * never mutated.
 *
 * @param {object|null} state - prior state (from loadState or a previous
 *   update); null/invalid → rebuild.
 * @param {object} opts - { ledgerPath, recallLogPath, retentionNowMs? }
 *   (memory.jsonl / recall.jsonl absolute paths). When `retentionNowMs` is a
 *   finite number the NEXT state is pruned to the retention window via
 *   pruneFileStateDays (Finding 3, bounded state); absent it NOTHING is pruned
 *   — the default that keeps the equivalence gate byte-equivalent.
 * @returns {{state: object, stats: {memory: object, recall: object}}} stats
 *   per file: { mode: "incremental"|"rebuild", reason: string|null,
 *   linesApplied: number, bytesRead: number } — bytesRead counts delta bytes
 *   plus witness-verification bytes so tests can assert no full re-scan.
 */
export function updateStateFromLedgers(state, opts) {
  const o = opts || {};
  const paths = {
    memory: normPath(o.ledgerPath),
    recall: normPath(o.recallLogPath),
  };
  const retentionNowMs = Number.isFinite(o.retentionNowMs) ? o.retentionNowMs : null;

  let forcedReason = null;
  if (!isValidState(state)) forcedReason = "no-prior-state";
  else if (state.reducer_version !== REDUCER_VERSION) forcedReason = "reducer-version-mismatch";

  const next = createEmptyState();
  const stats = {};
  for (const role of ["memory", "recall"]) {
    const prior = forcedReason === null ? state[role] : null;
    const { fileState, fileStats } = updateOneFile(role, paths[role], prior, forcedReason);
    next[role] = fileState;
    stats[role] = fileStats;
    // Finding 3 — bound the persisted state by the retention window. Opt-in
    // and defaulted OFF: with no anchor the equivalence gate and every
    // existing caller/test stay byte-identical.
    if (retentionNowMs !== null) pruneFileStateDays(next[role], retentionNowMs);
  }
  return { state: next, stats };
}

// ---------------------------------------------------------------------------
// saveState / loadState
// ---------------------------------------------------------------------------

/**
 * saveState — atomic persist: write statePath + ".tmp.<pid>", fsync, rename
 * over statePath, then best-effort fsync of the containing directory.
 * Throws on invalid input or fs failure (a caller must never believe a state
 * was persisted when it was not).
 */
export function saveState(statePath, state) {
  if (typeof statePath !== "string" || statePath.length === 0) {
    throw new TypeError("saveState: statePath must be a non-empty string");
  }
  if (!isValidState(state)) {
    throw new TypeError("saveState: state failed strict shape validation");
  }
  const tmp = `${statePath}.tmp.${process.pid}`;
  const bytes = Buffer.from(JSON.stringify(state), "utf8");
  let fd = -1;
  try {
    fd = openSync(tmp, "w", 0o600);
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written);
    }
    fsyncSync(fd);
  } catch (e) {
    try {
      if (fd !== -1) closeSync(fd);
    } catch {
      /* ignore */
    }
    fd = -1;
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort tmp cleanup */
    }
    throw e;
  } finally {
    if (fd !== -1) {
      closeSync(fd);
    }
  }
  renameSync(tmp, statePath);
  // Directory fsync is best-effort (some platforms refuse O_RDONLY dir fds).
  try {
    const dfd = openSync(dirname(statePath), "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* best-effort */
  }
}

/**
 * loadState — read + strict-validate a persisted state. ANYTHING malformed
 * (unreadable file, truncated/corrupt JSON, wrong shape, bad checkpoint,
 * bad day bucket) returns null so the caller rebuilds — a corrupt state is
 * never partially applied.
 */
export function loadState(statePath) {
  if (typeof statePath !== "string" || statePath.length === 0) return null;
  let raw;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isValidState(parsed)) return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// Compute-time replay plumbing
// ---------------------------------------------------------------------------

/**
 * memoSaysVerified (Finding 1) — may the sampled verifyPrefix be skipped for
 * `path`? Only when the caller's per-call verify memo holds an entry for the
 * path whose STORED checkpoint matches `serializedCheckpoint` AND whose stat
 * identity (size + mtimeMs) still matches the live file RIGHT NOW. The fresh
 * statSync is always paid (a cheap re-check that catches any append/rewrite
 * that bumps size or mtime within the same synchronous call); the sampled
 * sha256 witness read is the only thing elided. Any mismatch — or no memo —
 * returns false so the caller verifies exactly as before.
 */
function memoSaysVerified(verifyMemo, path, serializedCheckpoint) {
  if (!(verifyMemo instanceof Map)) return false;
  const m = verifyMemo.get(path);
  if (m == null || typeof m !== "object") return false;
  if (
    m.checkpoint !== serializedCheckpoint &&
    JSON.stringify(m.checkpoint) !== JSON.stringify(serializedCheckpoint)
  ) {
    return false;
  }
  let st;
  try {
    st = statSync(path);
  } catch {
    return false;
  }
  return st.size === m.size && st.mtimeMs === m.mtimeMs;
}

/**
 * Verify the stored checkpoint against the live file before ANY number is
 * emitted. Returns null when the file is legitimately absent (checkpoint
 * null AND file missing — the originals' zero-rows case); otherwise the
 * deserialized checkpoint. Throws loudly on every drift/staleness mode —
 * never emit numbers off unverified offsets. When `verifyMemo` proves the
 * file's stat identity + stored checkpoint are unchanged this synchronous
 * call (Finding 1), the sampled verifyPrefix is elided; the loud paths are
 * unchanged.
 */
function requireVerifiedCheckpoint(fnLabel, path, fileState, verifyMemo) {
  if (fileState.checkpoint === null) {
    if (existsSync(path)) {
      throw new Error(
        `${fnLabel}: state has no checkpoint for ${path} but the file exists — ` +
          "state is stale; re-run updateStateFromLedgers before computing",
      );
    }
    return null;
  }
  const cp = deserializeCheckpoint(fileState.checkpoint);
  if (cp === null) {
    throw new Error(`${fnLabel}: stored checkpoint for ${path} is invalid (invalid-checkpoint)`);
  }
  if (memoSaysVerified(verifyMemo, path, fileState.checkpoint)) {
    return cp;
  }
  const pv = verifyPrefix(path, cp);
  if (!pv.ok) {
    throw new Error(
      `${fnLabel}: refusing to compute from unverified state for ${path} — ` +
        `verifyPrefix failed (${pv.reason}); rebuild via updateStateFromLedgers`,
    );
  }
  return cp;
}

function readExactOrThrow(fnLabel, path, fd, buf, off, len) {
  let got = 0;
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, off + got);
    if (n === 0) {
      throw new Error(
        `${fnLabel}: short read at byte ${off + got} of ${path} — ` +
          "file shrank under a verified checkpoint (prefix-drift)",
      );
    }
    got += n;
  }
}

/** Positioned re-read + parse of stored (off, len) pairs, in stored order. */
function readRowsFromPairs(fnLabel, path, fd, pairs) {
  const rows = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const off = pairs[i];
    const len = pairs[i + 1];
    const buf = Buffer.alloc(len);
    readExactOrThrow(fnLabel, path, fd, buf, off, len);
    let row;
    try {
      row = JSON.parse(buf.toString("utf8"));
    } catch {
      throw new Error(
        `${fnLabel}: boundary-row re-parse failed at byte ${off} of ${path} — ` +
          "bytes changed outside the sampled witness (prefix-drift)",
      );
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Post-read re-verification (H1b): after ALL positioned reads for a file,
 * verifyPrefix must STILL pass, or a rewrite landed mid-compute and some
 * replayed rows may have come off the new bytes. Throws — numbers are
 * withheld, mirroring requireVerifiedCheckpoint's loudness.
 */
function requireStillVerified(fnLabel, path, cp, verifyMemo, serializedCheckpoint) {
  // Finding 1 — the memo's fresh statSync still catches any size/mtime change
  // that landed during the positioned boundary reads; only the sampled sha256
  // re-read is elided when the stat identity is provably unchanged.
  if (memoSaysVerified(verifyMemo, path, serializedCheckpoint)) return;
  const pv = verifyPrefix(path, cp);
  if (!pv.ok) {
    throw new Error(
      `${fnLabel}: post-read verify failed (${pv.reason}) at ${path} — ` +
        "ledger changed mid-compute; refusing to emit numbers off mixed bytes",
    );
  }
}

/**
 * Bucket binding for boundary-day replay (H1b): the row re-read from a
 * stored (off, len) pair must be exactly the KIND of row applyLine stored
 * there — role-admissible, same timestamp-rule sub-aggregate, same UTC day.
 * Any mismatch means the state's offsets alias different rows (corruption /
 * tampering): folding such a row would silently double-count against the
 * day aggregates, so this THROWS instead.
 */
function assertRowInBucket(fnLabel, path, role, expectSub, dayIdx, row, off) {
  const roleOk =
    role === "memory"
      ? looksLikeFact(row)
      : row !== null && typeof row === "object" && row.kind === "recall";
  const cls = roleOk ? classifyRowTs(row) : null;
  if (cls === null || cls.sub !== expectSub || Math.floor(cls.tsMs / DAY_MS) !== dayIdx) {
    throw new Error(
      `${fnLabel}: state-offset-mismatch at byte ${off} of ${path} — stored ` +
        `offset does not point at a ${role}/${expectSub} row of day ${dayIdx}; ` +
        "state is corrupt, rebuild via updateStateFromLedgers",
    );
  }
}

/** Parity with _ledger-stream.js / readAppended: single-line content cap. */
const TAIL_MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * foldUnterminatedTail (H1b) — opportunistic compute-time fold of the bytes
 * PAST the checkpoint's newline-safe eof: [cp.eof, stat.size). Parses every
 * complete line plus a trailing unterminated line (exactly the row
 * _ledger-stream.js:226-238 flushes at EOF and the checkpoint excludes) and
 * calls onRow(parsedObject) for each valid JSON object. Nothing here is
 * checkpointed — the next update folds the terminated rows into the state
 * and they simply stop appearing in the tail. Blank lines and lines over
 * TAIL_MAX_LINE_BYTES are skipped (original parity). cp.eof is a line
 * boundary by construction, so the region starts on a row start. Cost is
 * O(bytes appended since the last update) — never a full-ledger scan.
 * Throws "tail-read-failed" on any read anomaly (a tail that shrinks or
 * errors mid-read means the file is being rewritten, not appended).
 */
function foldUnterminatedTail(fnLabel, path, cp, onRow) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    throw new Error(`${fnLabel}: tail-read-failed (stat) at ${path}`);
  }
  if (size <= cp.eof) return;
  let fd = -1;
  try {
    fd = openSync(path, "r");
  } catch {
    throw new Error(`${fnLabel}: tail-read-failed (open) at ${path}`);
  }
  try {
    const deliver = (buf) => {
      let row;
      try {
        row = JSON.parse(buf.toString("utf8"));
      } catch {
        return; // torn / malformed tail rows are invisible, like the original
      }
      if (row === null || typeof row !== "object") return;
      onRow(row);
    };
    const chunk = Buffer.alloc(Math.min(BLOCK_BYTES, size - cp.eof));
    let pendingBufs = [];
    let pendingBytes = 0;
    let lineBytes = 0;
    let pos = cp.eof;
    while (pos < size) {
      const want = Math.min(chunk.length, size - pos);
      let n;
      try {
        n = readSync(fd, chunk, 0, want, pos);
      } catch {
        throw new Error(`${fnLabel}: tail-read-failed (read) at byte ${pos} of ${path}`);
      }
      if (n === 0) {
        throw new Error(`${fnLabel}: tail-read-failed (shrunk) at byte ${pos} of ${path}`);
      }
      let cursor = 0;
      while (cursor < n) {
        const nl = chunk.indexOf(0x0a, cursor);
        if (nl < 0 || nl >= n) {
          const sliceLen = n - cursor;
          if (lineBytes + sliceLen <= TAIL_MAX_LINE_BYTES) {
            pendingBufs.push(Buffer.from(chunk.subarray(cursor, n)));
            pendingBytes += sliceLen;
          } else {
            pendingBufs = []; // over the cap: keep counting, stop buffering
            pendingBytes = 0;
          }
          lineBytes += sliceLen;
          break;
        }
        const contentLen = lineBytes + (nl - cursor);
        if (contentLen > 0 && contentLen <= TAIL_MAX_LINE_BYTES) {
          let lineBuf;
          if (pendingBytes === 0) {
            lineBuf = chunk.subarray(cursor, nl);
          } else {
            pendingBufs.push(Buffer.from(chunk.subarray(cursor, nl)));
            lineBuf = Buffer.concat(pendingBufs, contentLen);
          }
          deliver(lineBuf);
        }
        pendingBufs = [];
        pendingBytes = 0;
        lineBytes = 0;
        cursor = nl + 1;
      }
      pos += n;
    }
    // The trailing unterminated line (the whole point of this helper).
    if (lineBytes > 0 && lineBytes <= TAIL_MAX_LINE_BYTES && pendingBytes === lineBytes) {
      deliver(Buffer.concat(pendingBufs, pendingBytes));
    }
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function sortedDayIndices(fileState) {
  return Object.keys(fileState.days)
    .map(Number)
    .sort((a, b) => a - b);
}

function requireCurrentVersion(fnLabel, state) {
  if (!isValidState(state)) {
    throw new TypeError(`${fnLabel}: state failed strict shape validation`);
  }
  if (state.reducer_version !== REDUCER_VERSION) {
    throw new Error(
      `${fnLabel}: reducer-version-mismatch (state ${state.reducer_version}, ` +
        `library ${REDUCER_VERSION}) — rebuild via updateStateFromLedgers`,
    );
  }
}

const nowMsFrom = (now) =>
  now instanceof Date
    ? now.getTime()
    : typeof now === "number" && Number.isFinite(now)
      ? now
      : Date.now();

// ---------------------------------------------------------------------------
// computeCoverageFromState
// ---------------------------------------------------------------------------

/**
 * computeCoverageFromState — exact replica of computeSynthesisCoverage's
 * envelope (coverage-probe.js:374-384) computed from day buckets.
 *
 * Rolling window [nowMs - windowDays*86400000, nowMs], INCLUSIVE both ends
 * (rule A). Interior days sum both + covOnly aggregates; the day containing
 * the cutoff and the day containing `now` are EXACT-REPLAYED via positioned
 * reads of the stored offsets after verifyPrefix (drift at compute time
 * throws — see requireVerifiedCheckpoint). Days past day(now) are entirely
 * future and excluded, matching the tsMs > nowMs drop.
 *
 * @param {object} state — current state (post updateStateFromLedgers).
 * @param {object} opts — { now, windowDays, ledgerPath, recallLogPath }.
 *   `now` (Date | finite number) defaults to Date.now() exactly like the
 *   original (the ONLY Date.now() in the compute paths); tests pin it.
 * @returns {object} envelope structurally identical to the original.
 */
export function computeCoverageFromState(state, opts) {
  const FN = "computeCoverageFromState";
  requireCurrentVersion(FN, state);
  const o = opts || {};
  const ledgerPath = normPath(o.ledgerPath);
  const recallLogPath = normPath(o.recallLogPath);
  const verifyMemo = o.verifyMemo; // Finding 1 — optional per-call verify memo.
  // Same normalization as coverage-probe.js:274-285.
  const windowDays =
    Number.isFinite(o.windowDays) && o.windowDays > 0 ? o.windowDays : DEFAULT_WINDOW_DAYS;
  const nowMs = nowMsFrom(o.now);
  const cutoffMs = nowMs - windowDays * 24 * 60 * 60 * 1000;
  const cutDay = Math.floor(cutoffMs / DAY_MS);
  const nowDay = Math.floor(nowMs / DAY_MS);

  // Row-exact coverage admission (rule A over [cutoffMs, nowMs] inclusive).
  const admit = (row) => {
    if (row == null || typeof row !== "object") return false;
    const tsField =
      (typeof row.ts === "string" && row.ts) ||
      (typeof row.created_at === "string" && row.created_at) ||
      null;
    const tsMs = tsField ? Date.parse(tsField) : NaN;
    if (!Number.isFinite(tsMs)) return false;
    return tsMs >= cutoffMs && tsMs <= nowMs;
  };

  // ----- memory side ------------------------------------------------------
  const memAcc = emptyMemAgg();
  if (ledgerPath !== null) {
    const fileState = state.memory;
    const cp = requireVerifiedCheckpoint(FN, ledgerPath, fileState, verifyMemo);
    if (cp !== null) {
      let fd = -1;
      try {
        for (const d of sortedDayIndices(fileState)) {
          if (d < cutDay || d > nowDay) continue;
          const bucket = fileState.days[String(d)];
          if (d > cutDay && d < nowDay) {
            addMemAgg(memAcc, bucket.both);
            addMemAgg(memAcc, bucket.covOnly);
            continue;
          }
          // Boundary day: exact replay of both sub-aggregates' rows. Each
          // replayed row is BOUND to its bucket (sub + day) — an aliased /
          // swapped offset throws instead of double-counting (H1b).
          if (fd === -1) fd = openSync(ledgerPath, "r");
          for (const [pairs, sub] of [
            [bucket.bothOff, "both"],
            [bucket.covOff, "covOnly"],
          ]) {
            const rows = readRowsFromPairs(FN, ledgerPath, fd, pairs);
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              assertRowInBucket(FN, ledgerPath, "memory", sub, d, row, pairs[2 * i]);
              if (!admit(row)) continue;
              foldMemoryRow(memAcc, row);
            }
          }
        }
        // Unterminated-tail fold + post-read verify (H1b, module header).
        foldUnterminatedTail(FN, ledgerPath, cp, (row) => {
          if (!admit(row)) return;
          if (!looksLikeFact(row)) return;
          foldMemoryRow(memAcc, row);
        });
        requireStillVerified(FN, ledgerPath, cp, verifyMemo, fileState.checkpoint);
      } finally {
        if (fd !== -1) {
          try {
            closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  // ----- recall side ------------------------------------------------------
  const recAcc = emptyRecallAgg();
  if (recallLogPath !== null) {
    const fileState = state.recall;
    const cp = requireVerifiedCheckpoint(FN, recallLogPath, fileState, verifyMemo);
    if (cp !== null) {
      let fd = -1;
      try {
        for (const d of sortedDayIndices(fileState)) {
          if (d < cutDay || d > nowDay) continue;
          const bucket = fileState.days[String(d)];
          if (d > cutDay && d < nowDay) {
            addRecallAgg(recAcc, bucket.both);
            addRecallAgg(recAcc, bucket.covOnly);
            continue;
          }
          if (fd === -1) fd = openSync(recallLogPath, "r");
          for (const [pairs, sub] of [
            [bucket.bothOff, "both"],
            [bucket.covOff, "covOnly"],
          ]) {
            const rows = readRowsFromPairs(FN, recallLogPath, fd, pairs);
            for (let i = 0; i < rows.length; i++) {
              const ev = rows[i];
              assertRowInBucket(FN, recallLogPath, "recall", sub, d, ev, pairs[2 * i]);
              if (!admit(ev)) continue;
              foldRecallRow(recAcc, ev);
            }
          }
        }
        foldUnterminatedTail(FN, recallLogPath, cp, (ev) => {
          if (!admit(ev)) return;
          if (ev.kind !== "recall") return;
          foldRecallRow(recAcc, ev);
        });
        requireStillVerified(FN, recallLogPath, cp, verifyMemo, fileState.checkpoint);
      } finally {
        if (fd !== -1) {
          try {
            closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  // ----- envelope (coverage-probe.js:374-384) ------------------------------
  const facts = memAcc.facts;
  return {
    window_days: windowDays,
    built_at: new Date(nowMs).toISOString(),
    facts_in_window: facts,
    entity_coverage: {
      populated: memAcc.entPop,
      empty: facts - memAcc.entPop,
      pct: pct(memAcc.entPop, facts),
    },
    time_anchor_coverage: {
      populated: memAcc.taPop,
      empty: facts - memAcc.taPop,
      pct: pct(memAcc.taPop, facts),
    },
    valence_coverage: {
      populated: memAcc.valPop,
      empty: facts - memAcc.valPop,
      pct: pct(memAcc.valPop, facts),
    },
    episodicity_coverage: {
      populated: memAcc.epPop,
      empty: facts - memAcc.epPop,
      pct: pct(memAcc.epPop, facts),
    },
    extractor_versions: envelopeVersionHists(memAcc),
    recall_population: {
      recalls_in_window: recAcc.recalls,
      non_empty_entities_pct: pct(recAcc.entPop, recAcc.recalls),
      non_empty_time_anchor_pct: pct(recAcc.taPop, recAcc.recalls),
      non_empty_valence_pct: pct(recAcc.valPop, recAcc.recalls),
      degraded_recall_pct: pct(recAcc.degraded, recAcc.recalls),
    },
  };
}

// ---------------------------------------------------------------------------
// computeDriftFromState
// ---------------------------------------------------------------------------

/**
 * computeDriftFromState — exact replica of detectDrift's envelope
 * (drift-detector.js:553-563) computed from day buckets.
 *
 * Windows from the imported DRIFT_CAPS: baseline [now-30d, now-7d) HALF-OPEN,
 * current [now-7d, now] inclusive, future rows dropped, `ts` field ONLY
 * (rule B — created_at-fallback rows are invisible here by design). Interior
 * days sum `both` aggregates only; up to three boundary days — day(now-30d),
 * day(now-7d), day(now) — are exact-replayed with the half-open/inclusive
 * edges: a row at exactly now-7d lands in CURRENT, a row at exactly now is
 * kept, now+1ms is dropped.
 *
 * qeSum is accumulated in ASCENDING day order (deterministic FP
 * association). CAVEAT: the original sums query_episodicity in global file
 * order; when appends are out of ts order the two associations can differ
 * in the last ulp. All other aggregates are integer counts and exact.
 *
 * Version arrays inside extractor_version_bump alerts are emitted
 * LEXICOGRAPHICALLY SORTED (the original's Set-insertion file order is not
 * reconstructible from day buckets); alert FIRING is order-independent.
 * Compare envelopes via canonicalizeDriftEnvelope on BOTH sides.
 *
 * NO backfill enqueue: the drift-detector.js:530-551 side channel is opt-in
 * and health.js never opts in — the reducer never writes the queue.
 *
 * @param {object} state — current state (post updateStateFromLedgers).
 * @param {object} opts — { now, ledgerPath, recallLogPath }; `now` defaults
 *   to Date.now() exactly like the original.
 */
export function computeDriftFromState(state, opts) {
  const FN = "computeDriftFromState";
  requireCurrentVersion(FN, state);
  const o = opts || {};
  const ledgerPath = normPath(o.ledgerPath);
  const recallLogPath = normPath(o.recallLogPath);
  const verifyMemo = o.verifyMemo; // Finding 1 — optional per-call verify memo.
  const nowMs = nowMsFrom(o.now);

  const baselineDays = DRIFT_CAPS.BASELINE_WINDOW_DAYS;
  const alertDays = DRIFT_CAPS.ALERT_WINDOW_DAYS;
  const alertCutoffMs = nowMs - alertDays * 24 * 60 * 60 * 1000;
  const baselineCutoffMs = nowMs - baselineDays * 24 * 60 * 60 * 1000;
  const dBase = Math.floor(baselineCutoffMs / DAY_MS);
  const dAlert = Math.floor(alertCutoffMs / DAY_MS);
  const dNow = Math.floor(nowMs / DAY_MS);
  const boundary = new Set([dBase, dAlert, dNow]);

  // Rule B classification of a replayed row: "baseline" | "current" | null.
  const classify = (row) => {
    if (row == null || typeof row !== "object") return null;
    const tsMs = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(tsMs)) return null;
    if (tsMs > nowMs) return null;
    if (tsMs < baselineCutoffMs) return null;
    return tsMs >= alertCutoffMs ? "current" : "baseline";
  };

  // ----- fact-side slices (memory ledger, `both` sub-aggregate only) ------
  const baseFact = emptyMemAgg();
  const curFact = emptyMemAgg();
  if (ledgerPath !== null) {
    const fileState = state.memory;
    const cp = requireVerifiedCheckpoint(FN, ledgerPath, fileState, verifyMemo);
    if (cp !== null) {
      let fd = -1;
      try {
        for (const d of sortedDayIndices(fileState)) {
          const bucket = fileState.days[String(d)];
          if (boundary.has(d)) {
            if (bucket.bothOff.length === 0) continue;
            if (fd === -1) fd = openSync(ledgerPath, "r");
            const rows = readRowsFromPairs(FN, ledgerPath, fd, bucket.bothOff);
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              assertRowInBucket(FN, ledgerPath, "memory", "both", d, row, bucket.bothOff[2 * i]);
              const slice = classify(row);
              if (slice === null) continue;
              foldMemoryRow(slice === "current" ? curFact : baseFact, row);
            }
          } else if (d > dBase && d < dAlert) {
            addMemAgg(baseFact, bucket.both);
          } else if (d > dAlert && d < dNow) {
            addMemAgg(curFact, bucket.both);
          }
        }
        // Unterminated-tail fold + post-read verify (H1b, module header).
        // Tail rows are rule-B classified exactly like replayed rows (a
        // created_at-fallback tail row stays invisible to drift).
        foldUnterminatedTail(FN, ledgerPath, cp, (row) => {
          const slice = classify(row);
          if (slice === null) return;
          if (!looksLikeFact(row)) return;
          foldMemoryRow(slice === "current" ? curFact : baseFact, row);
        });
        requireStillVerified(FN, ledgerPath, cp, verifyMemo, fileState.checkpoint);
      } finally {
        if (fd !== -1) {
          try {
            closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  // ----- recall-side slices (query_episodicity only) -----------------------
  const baseQe = { n: 0, sum: 0 };
  const curQe = { n: 0, sum: 0 };
  if (recallLogPath !== null) {
    const fileState = state.recall;
    const cp = requireVerifiedCheckpoint(FN, recallLogPath, fileState, verifyMemo);
    if (cp !== null) {
      let fd = -1;
      try {
        // Ascending day order — deterministic FP association for qeSum
        // (see the last-ulp caveat in the function doc block).
        for (const d of sortedDayIndices(fileState)) {
          const bucket = fileState.days[String(d)];
          if (boundary.has(d)) {
            if (bucket.bothOff.length === 0) continue;
            if (fd === -1) fd = openSync(recallLogPath, "r");
            const rows = readRowsFromPairs(FN, recallLogPath, fd, bucket.bothOff);
            for (let i = 0; i < rows.length; i++) {
              const ev = rows[i];
              assertRowInBucket(FN, recallLogPath, "recall", "both", d, ev, bucket.bothOff[2 * i]);
              const slice = classify(ev);
              if (slice === null) continue;
              const p = ev.populator;
              if (p == null || typeof p !== "object") continue;
              const qe = p.query_episodicity;
              if (typeof qe !== "number" || !Number.isFinite(qe)) continue;
              const acc = slice === "current" ? curQe : baseQe;
              acc.n += 1;
              acc.sum += qe;
            }
          } else if (d > dBase && d < dAlert) {
            baseQe.n += bucket.both.qeN;
            baseQe.sum += bucket.both.qeSum;
          } else if (d > dAlert && d < dNow) {
            curQe.n += bucket.both.qeN;
            curQe.sum += bucket.both.qeSum;
          }
        }
        // Tail rows sit at the very end of the file, so folding them after
        // the ascending-day sweep matches the original's file-order qeSum
        // association for them exactly.
        foldUnterminatedTail(FN, recallLogPath, cp, (ev) => {
          const slice = classify(ev);
          if (slice === null) return;
          if (ev.kind !== "recall") return;
          const p = ev.populator;
          if (p == null || typeof p !== "object") return;
          const qe = p.query_episodicity;
          if (typeof qe !== "number" || !Number.isFinite(qe)) return;
          const acc = slice === "current" ? curQe : baseQe;
          acc.n += 1;
          acc.sum += qe;
        });
        requireStillVerified(FN, recallLogPath, cp, verifyMemo, fileState.checkpoint);
      } finally {
        if (fd !== -1) {
          try {
            closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  // ----- sliceStats-shaped rollups (drift-detector.js:236-289,295-309) -----
  const safePct = (n, d) => (d > 0 ? n / d : 0);
  const finishFact = (acc) => ({
    facts: acc.facts,
    entity_pct: safePct(acc.entPop, acc.facts),
    time_anchor_pct: safePct(acc.taPop, acc.facts),
    valence_pct: safePct(acc.valPop, acc.facts),
    episodicity_pct: safePct(acc.epPop, acc.facts),
    avg_entity_count: safePct(acc.entityTokenSum, acc.facts),
    // Version sets = ALL histogram keys (genuine version strings only —
    // missing rows live out-of-band in vMissing), lexicographically sorted
    // (see canonicalizeDriftEnvelope). Keys are constructed in VERSION_AXES
    // order so pushVersionBumpAlerts iterates axes exactly like the
    // original sliceStats versions object.
    versions: {
      entity_extractor_version: versionSetOf(acc, "entity_extractor_version"),
      episodicity_version: versionSetOf(acc, "episodicity_version"),
      time_anchor_resolver_version: versionSetOf(acc, "time_anchor_resolver_version"),
      valence_model_version: versionSetOf(acc, "valence_model_version"),
    },
  });
  const baselineFact = finishFact(baseFact);
  const currentFact = finishFact(curFact);
  const baselineRecall =
    baseQe.n === 0 ? { n: 0, avg: 0 } : { n: baseQe.n, avg: baseQe.sum / baseQe.n };
  const currentRecall =
    curQe.n === 0 ? { n: 0, avg: 0 } : { n: curQe.n, avg: curQe.sum / curQe.n };

  // ----- alert composition, exact order of drift-detector.js:484-518 -------
  const alerts = [];
  pushVersionBumpAlerts(alerts, baselineFact.versions, currentFact.versions);
  pushCoverageDropAlert(alerts, "entity_coverage", baselineFact.entity_pct, currentFact.entity_pct);
  pushCoverageDropAlert(alerts, "time_anchor_coverage", baselineFact.time_anchor_pct, currentFact.time_anchor_pct);
  pushCoverageDropAlert(alerts, "valence_coverage", baselineFact.valence_pct, currentFact.valence_pct);
  pushCoverageDropAlert(alerts, "episodicity_coverage", baselineFact.episodicity_pct, currentFact.episodicity_pct);
  pushEntityCountDropAlert(alerts, baselineFact.avg_entity_count, currentFact.avg_entity_count);
  pushQueryEpisodicityDriftAlert(
    alerts,
    baselineRecall.avg,
    currentRecall.avg,
    baselineRecall.n,
    currentRecall.n,
  );

  // Envelope (drift-detector.js:553-563). baseline_recalls/current_recalls
  // are the qe-POPULATED counts (.n), not total recalls.
  return {
    alerts,
    built_at: new Date(nowMs).toISOString(),
    detector_version: DRIFT_DETECTOR_VERSION,
    baseline_window_days: baselineDays,
    alert_window_days: alertDays,
    baseline_facts: baselineFact.facts,
    current_facts: currentFact.facts,
    baseline_recalls: baselineRecall.n,
    current_recalls: currentRecall.n,
  };
}

function versionSetOf(acc, axis) {
  // ALL histogram keys: the histogram holds genuine version strings only
  // (missing rows are counted out-of-band in vMissing), so a LITERAL
  // "_missing_" version string is included here exactly like the original
  // drift Set (drift-detector.js:263-266) — no filter (H1b).
  return Object.keys(acc.versions[axis]).sort();
}

/**
 * Replay `count` ticks of the ORIGINAL coverage-probe tickVersion
 * (`hist[key] = (hist[key] || 0) + 1` on a PLAIN object) so the emitted
 * envelope is bit-identical to the full-scan original — including its
 * behavior on Object.prototype-named keys: "__proto__" ticks are silent
 * no-ops through the inherited setter (key absent from the envelope) and
 * "constructor"/"toString"/... start from the inherited value (the count
 * degrades to the original's concatenated string). Numeric runs collapse to
 * one addition; only hostile keys pay the per-tick loop.
 */
function replayOriginalTicks(hist, key, count) {
  for (let i = 0; i < count; i++) {
    const cur = hist[key]; // deliberately UNGUARDED: sees inherited values
    const next = (cur || 0) + 1;
    if (typeof next === "number") {
      hist[key] = next + (count - 1 - i);
      return;
    }
    hist[key] = next; // silent no-op for "__proto__", like the original
  }
}

/**
 * The coverage envelope's extractor_versions block, reconstructed from a
 * memory aggregate with the original's exact plain-object tick semantics.
 * Genuine version keys replay their histogram counts; the out-of-band
 * missing count replays under the "_missing_" sentinel, merging with a
 * literal "_missing_" version string exactly like coverage-probe.js:187-190.
 */
function envelopeVersionHists(acc) {
  const out = emptyVersionHists();
  for (const axis of VERSION_AXES) {
    const h = acc.versions[axis];
    for (const k of Object.keys(h)) replayOriginalTicks(out[axis], k, h[k]);
    replayOriginalTicks(out[axis], MISSING_VERSION_KEY, acc.vMissing[axis]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// canonicalizeDriftEnvelope
// ---------------------------------------------------------------------------

/**
 * canonicalizeDriftEnvelope — deep-copy an envelope and sort the version
 * arrays inside extractor_version_bump alerts lexicographically. The
 * equivalence contract between this module and detectDrift is:
 *
 *   deepStrictEqual(canonicalizeDriftEnvelope(reducerEnv),
 *                   canonicalizeDriftEnvelope(originalEnv))
 *
 * (the original emits Set-insertion / file-first-seen version order, which
 * is not reconstructible from day buckets under out-of-ts-order appends;
 * everything else compares exact).
 */
export function canonicalizeDriftEnvelope(envelope) {
  const copy = structuredClone(envelope);
  if (copy !== null && typeof copy === "object" && Array.isArray(copy.alerts)) {
    for (const alert of copy.alerts) {
      if (!alert || alert.kind !== DRIFT_ALERT_KINDS.EXTRACTOR_VERSION_BUMP) continue;
      if (Array.isArray(alert.baseline)) alert.baseline.sort();
      if (Array.isArray(alert.current)) alert.current.sort();
    }
  }
  return copy;
}
