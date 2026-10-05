#!/usr/bin/env node
// run-calibration-cycle.mjs — N1-calibration WORKUNIT item (3): the harness /
// scheduler that closes the learning loop.
//
// WHAT IT DOES (one cycle)
//   1. Runs runCalibration() over the LIVE-WEIGHT grid (LIVE_WEIGHT_GRID_SPEC:
//      SCORE_WEIGHT_{ENGAGEMENT,DAMPING,CORROBORATION}_PRIOR) against
//      ledgers/held-out-labels.jsonl joined to the recall soak substrate
//      (ledgers/recall.jsonl), using rescoreSurfacedWithLiveWeights — so the
//      grid is swept in the SAME units the live scorer reads (closing the
//      namespace gap; the surfaced[] re-rank caps are NOT touched here).
//   2. Computes NDCG@12 (eval-harness primary metric) + a paired-bootstrap 90%
//      CI lower bound on the NDCG delta (conservative: best point − baseline CI
//      upper). The calibration loop already enforces harm_rate ≤ baseline.
//   3. Runs the ANTI-CIRCULARITY guard against the contextual-eval goldset: if
//      the goldset's baseline-miss headroom is ~0 the instrument is measuring
//      its own selection criterion (the exact bug the de-circularized builder
//      fixed) → the cycle marks goldset_headroom_ok=false so the overlay refuses
//      the result.
//   4. Emits the winner as an APPEND-ONLY policy projection
//      (policy.recall.score_weights, reviewed:false) via emitScoreWeights. It
//      NEVER mutates the frozen CAPS and NEVER writes a fact row (thesis #1).
//      The overlay only applies it after an operator appends a reviewed:true
//      superseding row (--review) AND the env gate MEMORY_SCORE_WEIGHTS_ENABLED=1.
//
// COLD-START SAFETY: when n_labels_used==0 runCalibration returns the baseline
// unchanged (cold_start:true); the projection records cold_start and the overlay
// refuses to apply it. The cycle is idempotent + cold-start-safe so it is safe
// to schedule on a daemon idle cadence.
//
// CLI
//   node mcp/scripts/run-calibration-cycle.mjs
//       [--labels=<path>] [--recall=<path>] [--goldset=<path>]
//       [--emit]            # actually append the projection (default: dry-run)
//       [--output=<path>]   # write the cycle JSON report to disk
//
// Exit codes:
//   0 — cycle ran (report emitted; projection appended iff --emit and a winner).
//   1 — labels file missing OR anti-circularity guard failed hard.
//   2 — bad CLI arg.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  runCalibration,
  LIVE_WEIGHT_GRID_SPEC,
  rescoreSurfacedWithLiveWeights,
  CALIBRATION_LOOP_VERSION,
} from "../lib/synthesis/calibration-loop.js";
import { EVAL_HARNESS_VERSION } from "../lib/synthesis/eval-harness.js";
import { LEDGERS_DIR } from "../lib/config.js";
import {
  emitScoreWeights,
  SCORE_WEIGHT_PROJECTION_KEYS,
} from "../lib/synthesis/score-weights-emitter.js";

// Data root comes from lib/config.js (MEMORY_ROOT, default: this checkout),
// never from the home directory.
const DEFAULT_LABELS = join(LEDGERS_DIR, "held-out-labels.jsonl");
const DEFAULT_RECALL = join(LEDGERS_DIR, "recall.jsonl");
const DEFAULT_GOLDSET = join(LEDGERS_DIR, "contextual-eval-goldset.jsonl");

// N11-ranking-goldset: the RANKING-sensitive eval substrate (baseline NDCG@12 <
// 1.0). Built by mcp/scripts/build-ranking-eval-goldset.mjs. --ranking-goldset
// (or RANKING_EVAL_GOLDSET=1) points the cycle's three inputs at this substrate
// in one flag: labels := the held_out_label rows, recall := the PAIRED recall
// substrate (stamped priors so the sweep can move the metric), and the
// anti-circularity headroom guard reads the ranking-goldset meta header (which
// carries headroom.baseline_miss_fraction_all = the fraction of rows with
// baseline NDCG@12 < 1.0). Unlike the contextual goldset (RETRIEVAL headroom,
// NDCG=1.0 once retrieved) this substrate has REAL RANKING headroom, so the
// SCORE_WEIGHT_*_PRIOR sweep can register a measurable lift.
const RANKING_LABELS = join(LEDGERS_DIR, "ranking-eval-goldset.jsonl");
const RANKING_RECALL = join(LEDGERS_DIR, "ranking-eval-recall.jsonl");

// Minimum baseline-miss fraction the goldset must exhibit for a measured delta
// to be trustworthy. Below this the goldset has no headroom for a dense /
// prior-weighted leg to win → the metric would read a fake floor.
const MIN_GOLDSET_HEADROOM_FRACTION = 0.05;

// The baseline the live-weight sweep moves AWAY from: all three live weights at
// their frozen-CAPS default of 0.0 (current production behavior).
export const LIVE_WEIGHT_BASELINE = Object.freeze({
  SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.0,
  SCORE_WEIGHT_DAMPING_PRIOR: 0.0,
  SCORE_WEIGHT_CORROBORATION_PRIOR: 0.0,
});

export function parseArgs(argv) {
  // N11: --ranking-goldset (or env RANKING_EVAL_GOLDSET=1) flips all three
  // inputs to the ranking-sensitive substrate BEFORE per-flag overrides, so an
  // operator can still override e.g. --recall= on top of it.
  const rankingMode =
    argv.includes("--ranking-goldset") ||
    process.env.RANKING_EVAL_GOLDSET === "1";
  const opts = {
    labels: rankingMode ? RANKING_LABELS : DEFAULT_LABELS,
    recall: rankingMode ? RANKING_RECALL : DEFAULT_RECALL,
    // The ranking substrate's labels file IS its goldset: the meta header on
    // line 0 carries headroom.baseline_miss_fraction_all for the guard.
    goldset: rankingMode ? RANKING_LABELS : DEFAULT_GOLDSET,
    emit: false,
    output: null,
    ranking_mode: rankingMode,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--labels=")) opts.labels = arg.slice("--labels=".length);
    else if (arg.startsWith("--recall=")) opts.recall = arg.slice("--recall=".length);
    else if (arg.startsWith("--goldset=")) opts.goldset = arg.slice("--goldset=".length);
    else if (arg.startsWith("--output=")) opts.output = arg.slice("--output=".length);
    else if (arg === "--emit") opts.emit = true;
    else if (arg === "--ranking-goldset") { /* handled above; recognised here */ }
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: run-calibration-cycle.mjs [--labels=path] [--recall=path] " +
          "[--goldset=path] [--ranking-goldset] [--emit] [--output=path]\n" +
          "  --ranking-goldset  point labels+recall+goldset at the N11 " +
          "ranking-sensitive substrate (baseline NDCG@12 < 1.0; real ranking " +
          "headroom). Equivalent to RANKING_EVAL_GOLDSET=1.\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`run-calibration-cycle: unknown arg ${arg}\n`);
      process.exit(2);
    }
  }
  return opts;
}

/**
 * Anti-circularity guard. Reads the goldset meta row and returns the
 * baseline-miss headroom fraction + an ok verdict. A goldset with ~0 headroom
 * means the BM25 baseline already surfaces the goldens, so any "win" a weight
 * change shows is the instrument measuring its own selection criterion.
 *
 * Defensive: a missing/unreadable goldset returns {ok:false, fraction:null} —
 * the cycle then emits goldset_headroom_ok=false so the overlay refuses the
 * result (fail-safe), but does NOT crash (the held-out-labels eval is the
 * primary metric; the goldset is the circularity cross-check).
 *
 * @param {string} goldsetPath
 * @returns {{ok:boolean, fraction:(number|null), reason:(string|null)}}
 */
export function assertGoldsetHeadroom(goldsetPath) {
  if (typeof goldsetPath !== "string" || !existsSync(goldsetPath)) {
    return { ok: false, fraction: null, reason: "goldset missing" };
  }
  let firstLine;
  try {
    const raw = readFileSync(goldsetPath, "utf8");
    firstLine = raw.split("\n").find((l) => l.length > 0);
  } catch (err) {
    return { ok: false, fraction: null, reason: `goldset unreadable: ${err && err.message}` };
  }
  if (firstLine == null) {
    return { ok: false, fraction: null, reason: "goldset empty" };
  }
  let meta;
  try {
    meta = JSON.parse(firstLine);
  } catch {
    return { ok: false, fraction: null, reason: "goldset meta unparseable" };
  }
  const headroom = meta && typeof meta.headroom === "object" ? meta.headroom : null;
  const fraction =
    headroom != null && typeof headroom.baseline_miss_fraction_all === "number"
      ? headroom.baseline_miss_fraction_all
      : null;
  if (fraction == null) {
    return { ok: false, fraction: null, reason: "goldset meta lacks baseline_miss_fraction_all" };
  }
  if (fraction < MIN_GOLDSET_HEADROOM_FRACTION) {
    return {
      ok: false,
      fraction,
      reason: `goldset headroom ${fraction} < floor ${MIN_GOLDSET_HEADROOM_FRACTION} (no headroom — circular)`,
    };
  }
  return { ok: true, fraction, reason: null };
}

/**
 * Conservative lower bound on the NDCG delta from each run's per-run bootstrap
 * CI. Returns best_point − baseline_CI_upper. ≥ 0 means the best run's point
 * estimate clears the baseline's 90% CI upper bound — a strong (conservative)
 * signal the lift is real and not bootstrap noise. Null if CIs are absent.
 */
export function ndcgCiLowerDelta(baselineMetrics, bestMetrics) {
  if (baselineMetrics == null || bestMetrics == null) return null;
  const baseCi =
    baselineMetrics.bootstrap_ci && Array.isArray(baselineMetrics.bootstrap_ci.ndcg)
      ? baselineMetrics.bootstrap_ci.ndcg
      : null;
  const bestPoint =
    typeof bestMetrics.ndcg_at_12 === "number" ? bestMetrics.ndcg_at_12 : null;
  if (baseCi == null || bestPoint == null) return null;
  const baseUpper = typeof baseCi[1] === "number" ? baseCi[1] : null;
  if (baseUpper == null) return null;
  return bestPoint - baseUpper;
}

/**
 * Run ONE calibration cycle. Returns the cycle report object. Pure w.r.t. the
 * ledger UNLESS opts.emit is true (then it appends the projection). Exported so
 * the test drives it hermetically without the CLI shell.
 */
export async function runCalibrationCycle(opts) {
  const headroom = assertGoldsetHeadroom(opts.goldset);

  let calib;
  try {
    calib = await runCalibration({
      labelsPath: opts.labels,
      recallLogPath: opts.recall,
      baselineCaps: { ...LIVE_WEIGHT_BASELINE },
      gridSpec: LIVE_WEIGHT_GRID_SPEC,
      rescoreSurfaced: rescoreSurfacedWithLiveWeights,
    });
  } catch (err) {
    return {
      ok: false,
      stage: "runCalibration",
      error: err && err.message,
      goldset_headroom: headroom,
    };
  }

  const ndcg_delta =
    (calib.best_metrics && typeof calib.best_metrics.ndcg_at_12 === "number"
      ? calib.best_metrics.ndcg_at_12
      : 0) -
    (calib.baseline_metrics && typeof calib.baseline_metrics.ndcg_at_12 === "number"
      ? calib.baseline_metrics.ndcg_at_12
      : 0);
  const harm_delta =
    (calib.best_metrics && typeof calib.best_metrics.harm_rate === "number"
      ? calib.best_metrics.harm_rate
      : 0) -
    (calib.baseline_metrics && typeof calib.baseline_metrics.harm_rate === "number"
      ? calib.baseline_metrics.harm_rate
      : 0);
  const ndcg_ci_lower_delta = ndcgCiLowerDelta(
    calib.baseline_metrics,
    calib.best_metrics,
  );

  // Normalise best_caps into the EXACT three-key live-weight shape (the winner
  // may carry only the keys that moved; absent keys default to baseline 0.0).
  const weights = {};
  for (const k of SCORE_WEIGHT_PROJECTION_KEYS) {
    weights[k] =
      calib.best_caps && typeof calib.best_caps[k] === "number"
        ? calib.best_caps[k]
        : 0.0;
  }

  // A winner is only "real" when: not cold-start, NDCG strictly improved, harm
  // did not increase, and the goldset had headroom. The projection records all
  // of these; the overlay re-checks them at read time (defense in depth).
  const is_winner =
    calib.cold_start !== true &&
    ndcg_delta > 0 &&
    harm_delta <= 0 &&
    headroom.ok === true;

  const report = {
    ok: true,
    is_winner,
    cold_start: calib.cold_start === true,
    n_labels_used:
      calib.baseline_metrics && typeof calib.baseline_metrics.n_labels_used === "number"
        ? calib.baseline_metrics.n_labels_used
        : 0,
    weights,
    baseline_metrics: calib.baseline_metrics,
    best_metrics: calib.best_metrics,
    ndcg_delta,
    harm_delta,
    ndcg_ci_lower_delta,
    goldset_headroom: headroom,
    calibration_version: CALIBRATION_LOOP_VERSION,
    eval_harness_version: EVAL_HARNESS_VERSION,
    search_log_len: Array.isArray(calib.search_log) ? calib.search_log.length : 0,
    emitted: false,
    emitted_row_id: null,
  };

  if (opts.emit && is_winner) {
    const emit = await emitScoreWeights({
      weights,
      baseline_metrics: calib.baseline_metrics,
      best_metrics: calib.best_metrics,
      cold_start: calib.cold_start === true,
      goldset_headroom_ok: headroom.ok === true,
      ndcg_ci_lower_delta,
      calibration_version: CALIBRATION_LOOP_VERSION,
      eval_harness_version: EVAL_HARNESS_VERSION,
      reviewed: false, // operator sign-off chokepoint
      ledgerPath: opts.ledgerPath,
    });
    report.emitted = emit.ok === true;
    report.emitted_row_id = emit.ok === true && emit.row ? emit.row.id : null;
    report.emit_error = emit.ok === true ? null : emit.error_reason;
  }

  return report;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!existsSync(opts.labels)) {
    process.stderr.write(
      `run-calibration-cycle: labels file missing: ${opts.labels}\n` +
        `  expected per held-out-labeled-set.md § 5 (operator labeling pass). exit 1.\n`,
    );
    process.exit(1);
  }

  const report = await runCalibrationCycle(opts);
  const json = JSON.stringify(report, null, 2);
  if (opts.output) {
    try {
      writeFileSync(opts.output, json + "\n", { mode: 0o600 });
      process.stderr.write(`run-calibration-cycle: wrote ${opts.output}\n`);
    } catch (err) {
      process.stderr.write(
        `run-calibration-cycle: failed writing ${opts.output}: ${err && err.message}\n`,
      );
      process.exit(1);
    }
  } else {
    process.stdout.write(json + "\n");
  }
  process.exit(report.ok ? 0 : 1);
}

// Only run main() when invoked as a script (not when imported by the test).
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
  main().catch((err) => {
    process.stderr.write(`run-calibration-cycle: unhandled error ${err && err.stack}\n`);
    process.exit(1);
  });
}
