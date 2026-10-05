#!/usr/bin/env node
// run-damping-calibration.mjs — CLI for the operational damping + propagation
// CAPS calibration loop (F-SYN-OPERATIONAL-damping-calibration-loop, Wave 12).
//
// This is the O5 calibration runner: it sweeps the W12 CAPS grid against the
// W11 held-out labeled set + offline-eval harness and writes the winning caps
// vector to <MEMORY_ROOT>/policy/calibrated-damping-caps.json.
//
// CLI:
//   node mcp/scripts/run-damping-calibration.mjs
//       [--labels=<path>] [--recall=<path>] [--baseline=<path>]
//       [--output=<path>] [--grid=<json>]
//
// Defaults:
//   --labels   = <MEMORY_ROOT>/ledgers/held-out-labels.jsonl
//   --recall   = <MEMORY_ROOT>/ledgers/recall.jsonl
//   --baseline = (none — uses an internal default baseline caps vector)
//   --output   = <MEMORY_ROOT>/policy/calibrated-damping-caps.json
//   --grid     = (none — uses DEFAULT_GRID_SPEC from calibration-loop.js)
//
// Exit codes:
//   0 — calibration ran (winning caps written to --output).
//   1 — labels file missing (delegated to runCalibration → evaluate()).
//   2 — bad CLI arg.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  runCalibration,
  CALIBRATION_LOOP_VERSION,
  DEFAULT_GRID_SPEC,
} from "../lib/synthesis/calibration-loop.js";
import { LEDGERS_DIR, POLICY_DIR } from "../lib/config.js";

// Data root comes from lib/config.js (MEMORY_ROOT, default: this checkout),
// never from the home directory.
const DEFAULT_LABELS = join(LEDGERS_DIR, "held-out-labels.jsonl");
const DEFAULT_RECALL = join(LEDGERS_DIR, "recall.jsonl");
const DEFAULT_OUTPUT = join(POLICY_DIR, "calibrated-damping-caps.json");

// The CLI's fallback baseline caps vector — used when --baseline is not
// supplied. These mirror the hand-tuned priors documented in
// docs/specs/synthesis/recall-log-split.md § "CAPS table" — the calibration
// run will either beat them on NDCG@12 (and write a new vector) or fall back
// to them unchanged (the baseline-is-best case).
const DEFAULT_BASELINE_CAPS = Object.freeze({
  DAMPING_ENGAGEMENT_BOOST: 0.05,
  RAW_SURFACING_PENALTY: -0.02,
  CORROBORATION_BOOST_PER_DESCENDANT: 0.05,
});

function parseArgs(argv) {
  const opts = {
    labels: DEFAULT_LABELS,
    recall: DEFAULT_RECALL,
    baseline: null,
    output: DEFAULT_OUTPUT,
    grid: null,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--labels=")) opts.labels = arg.slice("--labels=".length);
    else if (arg.startsWith("--recall=")) opts.recall = arg.slice("--recall=".length);
    else if (arg.startsWith("--baseline=")) opts.baseline = arg.slice("--baseline=".length);
    else if (arg.startsWith("--output=")) opts.output = arg.slice("--output=".length);
    else if (arg.startsWith("--grid=")) opts.grid = arg.slice("--grid=".length);
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: run-damping-calibration.mjs " +
          "[--labels=path] [--recall=path] [--baseline=path] " +
          "[--output=path] [--grid=jsonblob]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`run-damping-calibration: unknown arg ${arg}\n`);
      process.exit(2);
    }
  }
  return opts;
}

function loadBaselineCaps(path) {
  if (path == null) return DEFAULT_BASELINE_CAPS;
  if (!existsSync(path)) {
    process.stderr.write(
      `run-damping-calibration: baseline caps file not found: ${path}\n` +
        `  falling back to internal DEFAULT_BASELINE_CAPS.\n`,
    );
    return DEFAULT_BASELINE_CAPS;
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    // If the file is a previous calibration output, prefer best_caps.
    if (parsed && typeof parsed === "object" && parsed.best_caps) {
      return parsed.best_caps;
    }
    return parsed;
  } catch (err) {
    process.stderr.write(
      `run-damping-calibration: failed reading baseline ${path}: ${err && err.message}\n` +
        `  falling back to internal DEFAULT_BASELINE_CAPS.\n`,
    );
    return DEFAULT_BASELINE_CAPS;
  }
}

function loadGrid(gridArg) {
  if (gridArg == null) return DEFAULT_GRID_SPEC;
  try {
    return JSON.parse(gridArg);
  } catch (err) {
    process.stderr.write(
      `run-damping-calibration: --grid is not valid JSON: ${err && err.message}\n`,
    );
    process.exit(2);
  }
}

async function main() {
  const opts = parseArgs(process.argv);

  if (!existsSync(opts.labels)) {
    process.stderr.write(
      `run-damping-calibration: labels file missing: ${opts.labels}\n` +
        `  expected per held-out-labeled-set.md § 5 (operator labeling pass).\n` +
        `  exit 1 — calibration cannot run.\n`,
    );
    process.exit(1);
  }

  const baselineCaps = loadBaselineCaps(opts.baseline);
  const gridSpec = loadGrid(opts.grid);

  let result;
  try {
    result = await runCalibration({
      labelsPath: opts.labels,
      recallLogPath: opts.recall,
      baselineCaps,
      gridSpec,
    });
  } catch (err) {
    process.stderr.write(
      `run-damping-calibration: calibration failed: ${err && err.message}\n`,
    );
    process.exit(1);
  }

  const payload = {
    schema_version: "v1",
    version: CALIBRATION_LOOP_VERSION,
    written_at: new Date().toISOString(),
    inputs: {
      labels: opts.labels,
      recall: opts.recall,
      baseline_path: opts.baseline,
    },
    cold_start: result.cold_start,
    best_caps: result.best_caps,
    baseline_caps: result.baseline_caps,
    baseline_metrics: result.baseline_metrics,
    best_metrics: result.best_metrics,
    search_log: result.search_log,
    eval_harness_version: result.eval_harness_version,
  };
  const json = JSON.stringify(payload, null, 2);
  try {
    writeFileSync(opts.output, json + "\n", { mode: 0o600 });
    process.stderr.write(`run-damping-calibration: wrote ${opts.output}\n`);
  } catch (err) {
    process.stderr.write(
      `run-damping-calibration: failed writing output ${opts.output}: ${err && err.message}\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`run-damping-calibration: unhandled error ${err && err.stack}\n`);
  process.exit(1);
});
