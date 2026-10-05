// drift-detector.js — Wave 12 OPERATIONAL tier for
// F-SYN-OPERATIONAL-drift-detection.
//
// PURPOSE
//   Detect when extractor versions bump mid-window AND when downstream
//   coverage on the cascade ledger / recall ledger diverges from a longer
//   30-day baseline. The W10 synthesis-coverage probe gives an in-the-moment
//   snapshot ("are we stamping today?"); the W12 drift detector compares
//   that snapshot to the 30-day baseline so a slow regression — half the
//   extractor rolling forward to v0.2.0 while the other half stays on
//   v0.1.0, or coverage dropping from 95% to 88% over a week — surfaces
//   visibly on the operator dashboard.
//
//   The four alert kinds (closed set; expansion would bump
//   DRIFT_DETECTOR_VERSION):
//
//     - extractor_version_bump      Multiple distinct versions of one of
//                                   the four extractors observed in the
//                                   7-day alert window. (Stable substrate
//                                   should see a single version.)
//     - coverage_drop               One of the four cascade-side coverage
//                                   percentages dropped by more than
//                                   CAPS.COVERAGE_DROP_THRESHOLD_PCT
//                                   from baseline (30d) to current (7d).
//     - entity_count_drop           Per-row average entity count fell by
//                                   more than CAPS.ENTITY_COUNT_DROP_THRESHOLD_PCT
//                                   from baseline to current. Catches
//                                   "the extractor still runs but returns
//                                   fewer/no entities per row" regressions.
//     - query_episodicity_drift     Average recall-side query_episodicity
//                                   shifted (in either direction) by more
//                                   than CAPS.COVERAGE_DROP_THRESHOLD_PCT
//                                   between baseline and current. Catches
//                                   "the query distribution moved but the
//                                   substrate did not follow" regressions.
//
// DESIGN PRINCIPLES
//   - HERMETIC: paths are caller-supplied (ledgerPath, recallLogPath); no
//     STORAGE_DIR / LEDGERS_DIR reach-through. memory_health threads both
//     through the probe so test setups can pin them under MEMORY_ROOT.
//   - DEFENSIVE: every missing field, malformed line, or missing file
//     degrades to "no alert" rather than crashes. Probe failure must never
//     take down the health surface (hooks-never-block discipline). ONE
//     deliberate exception (WU-health-string-cap-fix): an UNREADABLE
//     ledger (open failure, readSync failure mid-scan) THROWS instead of
//     degrading to empty slices — the memory_health caller's existing
//     try/catch converts the throw into a `drift_detector_unreachable`
//     health note plus drift_alerts:null, which is loudly distinguishable
//     from the baseline_facts=0/current_facts=0 envelope an EMPTY ledger
//     legitimately produces. The health surface itself never goes down;
//     the loudness rides its designed degrade path.
//   - PURE (modulo disk read): no Date.now() outside the rolling-window
//     anchor (opts.now defaults to new Date() for production but tests pin
//     it explicitly).
//   - SINGLE-PRODUCER: This module is the SOLE writer / reader of the four
//     alert kinds above. The health.js caller imports `detectDrift` and
//     surfaces the {alerts, built_at} envelope into the `drift_alerts`
//     top-level field on the health envelope.
//   - BOUNDED: streams each ledger once via _ledger-stream.js's
//     streamLedgerLines, retaining only the in-window (30-day) row slices
//     (WU-health-string-cap-fix — the original readFileSync(path, "utf8")
//     implementation materialized the ENTIRE ledger as one JS string; once
//     memory.jsonl crossed Node's ~536,870,888-byte max-string cap it threw
//     ERR_STRING_TOO_LONG, which the old catch swallowed into empty
//     baseline/current slices, so drift_alerts silently reported
//     baseline_facts=0/current_facts=0 against a 1.8 GB ledger).

import {
  readFileSync, // backfill-queue readers ONLY (small file) — ledger scans go through streamLedgerLines
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  unlinkSync,
  renameSync,
  constants as fsConstants,
} from "node:fs";
import { join } from "node:path";
import { CHECKOUT_ROOT } from "../config.js";
// WU-health-string-cap-fix: the shared WU-B1 streaming primitive. Sync
// fd/readSync chunked scan, StringDecoder across UTF-8 chunk seams, never
// materializes the whole file, and surfaces fs failures on counts.readError
// instead of throwing — see _ledger-stream.js module header. Do NOT replace
// with a bespoke reader; every ledger consumer rebased onto this primitive.
import { streamLedgerLines } from "./_ledger-stream.js";

export const DRIFT_DETECTOR_VERSION = "v0.1.0";

// Queue surface version. Pinned independently of DRIFT_DETECTOR_VERSION so a
// queue-schema bump (new dedupe_key shape, etc.) can roll forward without
// re-versioning the whole detector. Downstream drainers (operator CLI,
// daemon idle tick) pin to this so a mismatched on-disk queue gets surfaced
// loudly rather than mis-processed.
export const BACKFILL_QUEUE_VERSION = "v0.1.0";

// Closed cap block. Mirror of W9 engagement-queue discipline: bumping any
// value here REQUIRES a BACKFILL_QUEUE_VERSION bump because daemons + CLI
// pin to these to size their per-tick budgets.
export const BACKFILL_QUEUE_CAPS = Object.freeze({
  // Max queue tasks drained per daemon idle tick. Keeps a stuck loop from
  // hammering the engine; operator CLI ignores this cap and processes all.
  TASKS_PER_TICK: 5,
});

// Closed cap block. Per-WU discipline: bumping any value here REQUIRES a
// DRIFT_DETECTOR_VERSION bump because dashboards / alarms downstream pin to
// the snapshot's emitted version.
export const DRIFT_CAPS = Object.freeze({
  COVERAGE_DROP_THRESHOLD_PCT: 5,
  ENTITY_COUNT_DROP_THRESHOLD_PCT: 10,
  BASELINE_WINDOW_DAYS: 30,
  ALERT_WINDOW_DAYS: 7,
});

// Closed kind set. Single source of truth so the health surface + any
// downstream operator UIs can switch on a known list.
export const DRIFT_ALERT_KINDS = Object.freeze({
  EXTRACTOR_VERSION_BUMP: "extractor_version_bump",
  COVERAGE_DROP: "coverage_drop",
  ENTITY_COUNT_DROP: "entity_count_drop",
  QUERY_EPISODICITY_DRIFT: "query_episodicity_drift",
});

// Severity ladder. "info" = informational (a version bump in isolation is
// expected during a rollout); "warn" = operator should look; "critical" =
// substrate is degraded enough that recall quality is at risk.
const SEVERITY = Object.freeze({
  INFO: "info",
  WARN: "warn",
  CRITICAL: "critical",
});

// Stream a JSONL ledger and split rows into baseline + current buckets in
// one pass. Baseline = [now - baselineDays, now - alertDays); current =
// [now - alertDays, now]. Malformed lines + non-ISO ts collapse to "skip".
//
// WU-health-string-cap-fix: rebased onto streamLedgerLines. The previous
// readFileSync(absPath, "utf8") whole-file read threw ERR_STRING_TOO_LONG
// once the ledger crossed Node's ~536,870,888-byte max-string cap, and the
// old catch swallowed that into empty buckets — making a 1.8 GB unreadable
// ledger indistinguishable from an empty one. Constraints preserved:
//   - RETURN SHAPE unchanged: {baseline, current, totalLines, parsedLines}.
//     totalLines counts non-empty lines, parsedLines counts JSON-parse
//     successes — streamLedgerLines counts both identically to the old
//     split-loop.
//   - FILTERING unchanged: `ts` field ONLY (no created_at fallback — the
//     drift detector deliberately diverges from coverage-probe.js here;
//     do not "fix" the asymmetry without re-baselining the alert history),
//     finite-ms check, future rows dropped, [baselineCutoff, alertCutoff)
//     → baseline, [alertCutoff, now] → current. Out-of-window rows never
//     enter the buckets (bounded retention: only the 30-day slice is held).
//   - MISSING / falsy path still returns zeros WITHOUT throwing (pinned by
//     drift-detector.test.mjs "missing paths → no alerts (no throw)").
//   - UNREADABLE file (open/readSync failure surfaced on counts.readError)
//     now THROWS: a baseline/current split computed off a truncated scan
//     is biased toward the file head (oldest rows) and would fabricate
//     coverage_drop alerts — WORSE than no answer. The memory_health
//     caller catches the throw into a `drift_detector_unreachable` health
//     note + drift_alerts:null — an unreadable ledger must never be
//     indistinguishable from an empty one.
function streamLedgerSplit(absPath, nowMs, baselineDays, alertDays) {
  const out = { baseline: [], current: [], totalLines: 0, parsedLines: 0 };
  if (!absPath || !existsSync(absPath)) return out;

  const alertCutoffMs = nowMs - alertDays * 24 * 60 * 60 * 1000;
  const baselineCutoffMs = nowMs - baselineDays * 24 * 60 * 60 * 1000;

  // streamLedgerLines never throws; fs failures surface on counts.readError.
  const counts = streamLedgerLines(absPath, (parsed) => {
    if (parsed == null || typeof parsed !== "object") return;
    const tsMs =
      typeof parsed.ts === "string" ? Date.parse(parsed.ts) : NaN;
    if (!Number.isFinite(tsMs)) return;
    if (tsMs > nowMs) return;
    if (tsMs < baselineCutoffMs) return;
    if (tsMs >= alertCutoffMs) {
      out.current.push(parsed);
    } else {
      out.baseline.push(parsed);
    }
  });
  out.totalLines = counts.totalLines;
  out.parsedLines = counts.parsedLines;
  if (counts.readError !== null && counts.readError !== undefined) {
    // LOUD-FAILURE contract (WU-health-string-cap-fix): see doc block above.
    throw new Error(
      `drift-detector: ledger scan failed (${counts.readError}) at ${absPath}; ` +
        "refusing to compute drift off a truncated scan — " +
        "an unreadable ledger is NOT an empty ledger",
    );
  }
  return out;
}

// A fact row "looks like" a feature-stamped fact when it has a kind of
// "fact" / "reconstructed_fact" OR carries a features slot. Mirrors the
// coverage-probe.js predicate so the two probes agree on what "fact in
// window" means.
function looksLikeFact(row) {
  if (!row) return false;
  return (
    row.kind === "fact" ||
    row.kind === "reconstructed_fact" ||
    row.features != null
  );
}

// Per-axis populated predicates. Mirror coverage-probe.js so a regression
// here can't disagree with the cascade-side measurement.
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

// Compute per-axis coverage and per-row average entity count for a slice
// of fact rows. Returns 0 across the board on an empty slice so the
// downstream divergence math is well-defined (0 → 0 = 0 drift).
function sliceStats(rows) {
  let facts = 0;
  let entFacts = 0;
  let taFacts = 0;
  let valFacts = 0;
  let epFacts = 0;
  let entityTokenSum = 0;
  // Per-axis version histograms — let the alert composer detect a
  // version-bump even when coverage stays flat.
  const versions = {
    entity_extractor_version: new Set(),
    episodicity_version: new Set(),
    time_anchor_resolver_version: new Set(),
    valence_model_version: new Set(),
  };

  for (const row of rows) {
    if (!looksLikeFact(row)) continue;
    facts += 1;
    if (isEntitiesPopulated(row)) {
      entFacts += 1;
      entityTokenSum += row.features.entities.length;
    }
    if (isTimeAnchorPopulated(row)) taFacts += 1;
    if (isValencePopulated(row)) valFacts += 1;
    if (isEpisodicityPopulated(row)) epFacts += 1;

    const f = row.features || {};
    for (const k of Object.keys(versions)) {
      const v = f[k];
      if (typeof v === "string" && v.length > 0) versions[k].add(v);
    }
  }

  const safePct = (n, d) => (d > 0 ? n / d : 0);

  return {
    facts,
    entity_pct: safePct(entFacts, facts),
    time_anchor_pct: safePct(taFacts, facts),
    valence_pct: safePct(valFacts, facts),
    episodicity_pct: safePct(epFacts, facts),
    // Average entity count PER FACT (denominator = all in-slice facts, not
    // just populated ones; a regression where 100% of rows stamp but each
    // returns 0 entities should still trip the entity_count_drop alert).
    avg_entity_count: safePct(entityTokenSum, facts),
    versions: {
      entity_extractor_version: Array.from(versions.entity_extractor_version),
      episodicity_version: Array.from(versions.episodicity_version),
      time_anchor_resolver_version: Array.from(versions.time_anchor_resolver_version),
      valence_model_version: Array.from(versions.valence_model_version),
    },
  };
}

// Per-axis average query_episodicity for recall events in a slice. Recall
// events without a populator.query_episodicity contribute nothing — the
// denominator is "recalls with a populated query_episodicity scalar" so a
// degraded path doesn't artificially deflate the average.
function recallSliceAvgQueryEpisodicity(rows) {
  let n = 0;
  let sum = 0;
  for (const ev of rows) {
    if (!ev || ev.kind !== "recall") continue;
    const p = ev.populator;
    if (p == null || typeof p !== "object") continue;
    const qe = p.query_episodicity;
    if (typeof qe !== "number" || !Number.isFinite(qe)) continue;
    n += 1;
    sum += qe;
  }
  if (n === 0) return { n: 0, avg: 0 };
  return { n, avg: sum / n };
}

// Round to 4 decimal places so on-disk snapshots stay deterministic. The
// alert composer reads these so any rounding instability would surface as
// spurious-alert flapping at the threshold edge.
function r4(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

// Severity for a coverage drop. Below 2x the threshold = warn; >=2x =
// critical. The exact ladder is intentionally simple so operators can
// reason about it without consulting a table.
function coverageDropSeverity(dropPct) {
  const threshold = DRIFT_CAPS.COVERAGE_DROP_THRESHOLD_PCT;
  return dropPct >= threshold * 2 ? SEVERITY.CRITICAL : SEVERITY.WARN;
}

// Compose the alert list for a fact-side axis (coverage drop). Returns
// zero or one alert; the per-axis split lets dashboards drill in.
function pushCoverageDropAlert(alerts, axis, baselinePct, currentPct) {
  // Treat coverage in [0,1]. drop_pct expressed as integer percentage points.
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

// Per-axis extractor version-bump alert. Fires when the union of versions
// observed in the current window has more than one distinct string OR when
// the current window's version set is disjoint from the baseline's (a
// clean cut-over).
function pushVersionBumpAlerts(alerts, baselineVersions, currentVersions) {
  for (const axis of Object.keys(currentVersions)) {
    const cur = currentVersions[axis];
    const base = baselineVersions[axis] || [];
    if (cur.length === 0) continue;
    // Multi-version observed in the current window — definitely an in-flight
    // rollout / pinned-shard scenario.
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
    // Single current version but it's disjoint from the baseline set —
    // clean cut-over. We still flag so operators can correlate downstream
    // coverage shifts with the version bump.
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

// Per-fact entity-count drop. Compares avg entities-per-row. The threshold
// is expressed as a percentage of the baseline average so a halving (50%
// drop) trips even when absolute count is small.
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

// Recall-side query_episodicity drift. Bidirectional (queries shifted
// either toward more episodic or more semantic). Threshold reuses
// COVERAGE_DROP_THRESHOLD_PCT scaled to the [0,1] episodicity range so a
// 5% shift in absolute episodicity scores fires.
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

/**
 * Compute the drift-alert envelope for the operator dashboard.
 *
 * @param {object} opts
 * @param {string} opts.ledgerPath      - absolute path to memory.jsonl
 * @param {string} opts.recallLogPath   - absolute path to recall.jsonl
 * @param {Date|number} [opts.now]      - clock anchor (Date or epoch ms);
 *                                        production omits, tests pin
 *
 * @returns {Promise<object>}
 *   {
 *     alerts: Array<{
 *       kind: "extractor_version_bump" | "coverage_drop"
 *           | "entity_count_drop" | "query_episodicity_drift",
 *       axis: string,
 *       severity: "info" | "warn" | "critical",
 *       baseline: number | Array<string>,
 *       current:  number | Array<string>,
 *       drift_pct: number   // integer-ish percent (rounded to 4dp)
 *     }>,
 *     built_at: string,                  // ISO-8601
 *     detector_version: string,          // DRIFT_DETECTOR_VERSION
 *     baseline_window_days: number,
 *     alert_window_days: number,
 *     baseline_facts: number,
 *     current_facts: number,
 *     baseline_recalls: number,
 *     current_recalls: number,
 *   }
 *
 * The function is async to match the buildHealthData contract; the body is
 * synchronous so the caller can await it without extra event-loop ticks.
 */
export async function detectDrift(opts) {
  const o = opts || {};
  const ledgerPath = typeof o.ledgerPath === "string" ? o.ledgerPath : null;
  const recallLogPath = typeof o.recallLogPath === "string" ? o.recallLogPath : null;
  const nowMs =
    o.now instanceof Date
      ? o.now.getTime()
      : typeof o.now === "number" && Number.isFinite(o.now)
        ? o.now
        : Date.now();

  const baselineDays = DRIFT_CAPS.BASELINE_WINDOW_DAYS;
  const alertDays = DRIFT_CAPS.ALERT_WINDOW_DAYS;

  // ---------------------------------------------------------------------
  // Fact-side slices.
  // ---------------------------------------------------------------------
  const factSplit = streamLedgerSplit(ledgerPath, nowMs, baselineDays, alertDays);
  const baselineFact = sliceStats(factSplit.baseline);
  const currentFact = sliceStats(factSplit.current);

  // ---------------------------------------------------------------------
  // Recall-side slices (only used for query_episodicity_drift today).
  // ---------------------------------------------------------------------
  const recallSplit = streamLedgerSplit(recallLogPath, nowMs, baselineDays, alertDays);
  const baselineRecall = recallSliceAvgQueryEpisodicity(recallSplit.baseline);
  const currentRecall = recallSliceAvgQueryEpisodicity(recallSplit.current);

  const alerts = [];

  // 1. extractor_version_bump — version histogram changes across the four
  //    cascade-side axes. We use the COMBINED set (baseline ∪ current) for
  //    each axis: if the current 7-day window shows >1 version OR the
  //    current version is disjoint from baseline → alert.
  try {
    pushVersionBumpAlerts(alerts, baselineFact.versions, currentFact.versions);
  } catch {
    // defensive — never let a single axis crash the envelope
  }

  // 2. coverage_drop — per-axis percentage drop > CAPS threshold.
  try {
    pushCoverageDropAlert(alerts, "entity_coverage", baselineFact.entity_pct, currentFact.entity_pct);
    pushCoverageDropAlert(alerts, "time_anchor_coverage", baselineFact.time_anchor_pct, currentFact.time_anchor_pct);
    pushCoverageDropAlert(alerts, "valence_coverage", baselineFact.valence_pct, currentFact.valence_pct);
    pushCoverageDropAlert(alerts, "episodicity_coverage", baselineFact.episodicity_pct, currentFact.episodicity_pct);
  } catch {
    // defensive
  }

  // 3. entity_count_drop — avg entities-per-fact dropped more than the
  //    ENTITY_COUNT_DROP_THRESHOLD_PCT of the baseline value.
  try {
    pushEntityCountDropAlert(alerts, baselineFact.avg_entity_count, currentFact.avg_entity_count);
  } catch {
    // defensive
  }

  // 4. query_episodicity_drift — recall-side query distribution drifted.
  try {
    pushQueryEpisodicityDriftAlert(
      alerts,
      baselineRecall.avg,
      currentRecall.avg,
      baselineRecall.n,
      currentRecall.n,
    );
  } catch {
    // defensive
  }

  // 5. Optional backfill-task enqueue (F-CCS-BACKFILL-trigger):
  //    For every extractor_version_bump alert, enqueue a backfill task into
  //    <MEMORY_ROOT>/policy/backfill-queue.jsonl. Dedupe by a stable
  //    alert_id ({kind, axis, sorted(current)}) so the same alert firing
  //    every tick produces at most one queue entry.
  //
  //    Off by default — only opt-in callers (the watermark daemon idle tick,
  //    operator CLI) flip enqueueBackfill:true. Keeping it opt-in preserves
  //    the existing detectDrift contract (the W12 health surface still calls
  //    it with no enqueue side effect).
  if (o.enqueueBackfill === true) {
    try {
      for (const alert of alerts) {
        if (alert.kind !== DRIFT_ALERT_KINDS.EXTRACTOR_VERSION_BUMP) continue;
        try {
          enqueueBackfillTask({
            alert_id: backfillAlertId(alert),
            reason: "extractor_version_bump",
            axis: alert.axis,
            baseline_versions: Array.isArray(alert.baseline) ? alert.baseline : [],
            current_versions: Array.isArray(alert.current) ? alert.current : [],
            fact_ids: ["*"],
            scheduled_at: new Date(nowMs).toISOString(),
          });
        } catch {
          // Per-alert failure must not block envelope emission.
        }
      }
    } catch {
      // defensive
    }
  }

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

// ---------------------------------------------------------------------------
// Backfill-trigger queue (F-CCS-BACKFILL-trigger).
//
// SINGLE-PRODUCER: this module is the SOLE writer of backfill-queue.jsonl.
// The operator CLI (mcp/scripts/run-feature-backfill.mjs) and the daemon
// idle tick are READERS via drainBackfillQueue(); they import the helpers
// from here. Single-producer is enforced by the alert-emission path: the
// only enqueue site is the conditional inside detectDrift() above, plus the
// exported enqueueBackfillTask() helper which exists for unit-test seams
// and operator dry-runs.
//
// QUEUE SHAPE (one JSON object per line):
//   {
//     ts:                ISO-8601 timestamp the enqueue ran (audit anchor)
//     alert_id:          stable dedupe key derived from the alert
//                        ({kind, axis, sorted(current_versions)})
//     reason:            "extractor_version_bump" (closed set for now)
//     axis:              e.g. "entity_extractor_version"
//     baseline_versions: array of baseline-window versions
//     current_versions:  array of current-window versions
//     fact_ids:          ["*"] = backfill all; else a specific list
//     scheduled_at:      ISO-8601 the trigger fired (==ts in normal path)
//     queue_version:     BACKFILL_QUEUE_VERSION (drainer cross-checks)
//   }
//
// IDEMPOTENCE: enqueueBackfillTask reads the current queue file before
// writing and skips if a line with the same alert_id is already present.
// Dedupe is best-effort (read-then-write race tolerated — at worst, two
// drainers race and we end up with two queue lines; the engine's
// {target_fact_id, backfill_version} dedupe (§6) keeps the ledger clean).
// ---------------------------------------------------------------------------

function memoryRootForBackfillQueue() {
  return process.env.MEMORY_ROOT || CHECKOUT_ROOT;
}
function policyDirForBackfillQueue() {
  return process.env.POLICY_BASE_DIR || join(memoryRootForBackfillQueue(), "policy");
}

export function backfillQueuePath() {
  return join(policyDirForBackfillQueue(), "backfill-queue.jsonl");
}

const BACKFILL_QUEUE_O_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_NOFOLLOW;
const BACKFILL_QUEUE_FILE_MODE = 0o600;

// Stable alert id. Hash-free intentionally — readable in the queue file and
// trivially reproducible across processes. The {kind, axis, sorted current}
// triple is the dedupe surface: two drift snapshots over the same window
// MUST produce the same alert_id so the second snapshot's enqueue is a
// no-op.
export function backfillAlertId(alert) {
  if (alert == null || typeof alert !== "object") return null;
  const kind = typeof alert.kind === "string" ? alert.kind : "unknown";
  const axis = typeof alert.axis === "string" ? alert.axis : "unknown";
  const cur = Array.isArray(alert.current) ? alert.current.slice().sort() : [];
  return `${kind}|${axis}|${cur.join(",")}`;
}

/**
 * Read the current backfill queue file into an array of parsed objects.
 *
 * Defensive on every failure mode (missing file, unreadable, malformed
 * line) — returns [] rather than throwing. Mirrors the engagement-queue
 * read discipline (synthesis events must never crash a caller).
 *
 * @returns {object[]} parsed queue entries; corrupt lines silently skipped.
 */
export function readBackfillQueue() {
  const path = backfillQueuePath();
  if (!existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  if (raw === "") return [];
  const out = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip corrupt mid-file lines
    }
  }
  return out;
}

/**
 * Append one queue line. Caller may pass a fully-formed task; missing
 * fields are defaulted. The alert_id field is REQUIRED for dedupe; if
 * absent the enqueue throws.
 *
 * Idempotent: reads the current queue and skips the append if a line with
 * the same alert_id is already present. Returns true if appended, false
 * if deduped.
 */
export function enqueueBackfillTask(task) {
  if (task == null || typeof task !== "object") {
    throw new TypeError("enqueueBackfillTask: task must be an object");
  }
  if (typeof task.alert_id !== "string" || task.alert_id.length === 0) {
    throw new TypeError("enqueueBackfillTask: task.alert_id required (string)");
  }

  // Dedupe: scan the current queue file. The window between read and write
  // is small but a concurrent writer (two daemons simultaneously) could
  // produce a duplicate; the engine's per-fact dedupe absorbs that.
  const existing = readBackfillQueue();
  for (const row of existing) {
    if (row && row.alert_id === task.alert_id) {
      return false;
    }
  }

  const dir = policyDirForBackfillQueue();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const line = JSON.stringify({
    ts: typeof task.ts === "string" ? task.ts : new Date().toISOString(),
    alert_id: task.alert_id,
    reason: typeof task.reason === "string" ? task.reason : "extractor_version_bump",
    axis: typeof task.axis === "string" ? task.axis : null,
    baseline_versions: Array.isArray(task.baseline_versions) ? task.baseline_versions : [],
    current_versions: Array.isArray(task.current_versions) ? task.current_versions : [],
    fact_ids: Array.isArray(task.fact_ids) ? task.fact_ids : ["*"],
    scheduled_at:
      typeof task.scheduled_at === "string" ? task.scheduled_at : new Date().toISOString(),
    queue_version: BACKFILL_QUEUE_VERSION,
  }) + "\n";

  const fd = openSync(backfillQueuePath(), BACKFILL_QUEUE_O_FLAGS, BACKFILL_QUEUE_FILE_MODE);
  try {
    const bytes = Buffer.from(line, "utf8");
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Drain the backfill queue. Mirrors drainEngagementQueue's rename-to-tmp
 * pattern from W10 so concurrent enqueues (operator CLI + daemon idle
 * tick) can't race the read-then-unlink window.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxTasks] - cap on entries returned; the rest are
 *   left in a re-enqueued tail file so the next drain picks them up. The
 *   daemon passes BACKFILL_QUEUE_CAPS.TASKS_PER_TICK; the operator CLI
 *   passes Infinity.
 * @returns {object[]} parsed task entries; corrupt lines silently skipped.
 */
export function drainBackfillQueue(opts) {
  const o = opts || {};
  const maxTasks =
    typeof o.maxTasks === "number" && Number.isFinite(o.maxTasks) && o.maxTasks > 0
      ? Math.floor(o.maxTasks)
      : Infinity;

  const path = backfillQueuePath();
  if (!existsSync(path)) return [];
  const sidecar =
    path +
    ".draining." +
    process.pid +
    "." +
    Date.now() +
    "." +
    Math.floor(Math.random() * 1e6);
  try {
    renameSync(path, sidecar);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    return [];
  }
  let raw;
  try {
    raw = readFileSync(sidecar, "utf8");
  } catch {
    try { unlinkSync(sidecar); } catch { /* ignore */ }
    return [];
  }
  try {
    unlinkSync(sidecar);
  } catch {
    // best-effort cleanup; uniquely named sidecar cannot collide with future drains.
  }
  if (raw === "") return [];

  const all = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    try {
      all.push(JSON.parse(line));
    } catch {
      // skip corrupt
    }
  }
  if (all.length <= maxTasks) return all;

  // Cap exceeded: take the first N, re-enqueue the rest so the next tick
  // can pick them up. Re-enqueue goes through enqueueBackfillTask so dedupe
  // still applies (if a tail task's alert_id matches a fresh enqueue from a
  // parallel producer, the dedupe absorbs it).
  const taken = all.slice(0, maxTasks);
  const tail = all.slice(maxTasks);
  for (const task of tail) {
    try {
      enqueueBackfillTask(task);
    } catch {
      // Re-enqueue failure is non-fatal; the operator can re-run the CLI.
    }
  }
  return taken;
}

// Test seam — production daemons do not call this.
export function _resetBackfillQueueForTest() {
  const path = backfillQueuePath();
  try {
    unlinkSync(path);
  } catch (e) {
    if (!(e && e.code === "ENOENT")) throw e;
  }
}
