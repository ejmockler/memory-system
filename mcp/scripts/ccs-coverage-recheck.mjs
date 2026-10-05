#!/usr/bin/env node
// ccs-coverage-recheck.mjs — W4-CCS operational closeout helper.
//
// F-CCS-OPS-coverage-recheck (operational tier).
//
// PURPOSE
//   Standardize the per-wave empirical synthesis_coverage check. Calls
//   memory_health (via buildHealthData), extracts the synthesis_coverage
//   projection, and computes a delta report vs a pinned baseline snapshot
//   at /tmp/memory-system-hypergraph-ccs/artifacts/baseline-coverage.json.
//
// USAGE
//   node mcp/scripts/ccs-coverage-recheck.mjs
//   node mcp/scripts/ccs-coverage-recheck.mjs --baseline /path/baseline.json
//   node mcp/scripts/ccs-coverage-recheck.mjs --out /path/out.json
//   node mcp/scripts/ccs-coverage-recheck.mjs --health-json /path/health.json
//                                                  # use a captured health
//                                                  # envelope instead of a
//                                                  # live buildHealthData call
//
// DISCIPLINE
//   - ESM imports, defensive try/catch around the live health surface so a
//     ledger outage degrades to "live_unavailable" rather than crashing the
//     closeout pipeline (mirrors the W10 probe degradation pattern).
//   - Module exports VERSION + frozen CAPS so callers can pin the
//     contract; tests import diffSynthesisCoverage / loadJson without
//     spawning a child process.
//   - Pure functions: diffSynthesisCoverage / extractCoverage / buildLift
//     take plain objects and return plain objects so tests are hermetic.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const VERSION = "ccs-coverage-recheck@1.0.0";

export const CAPS = Object.freeze({
  // Default artifact root for CCS wave finalizers. Override via --out for a
  // custom path; tests pass an in-memory path through writeLiftReport.
  DEFAULT_ARTIFACTS_DIR: "/tmp/memory-system-hypergraph-ccs/artifacts",
  DEFAULT_BASELINE_FILENAME: "baseline-coverage.json",
  DEFAULT_OUTPUT_PREFIX: "coverage-recheck-",
  // Closed enum of synthesis_coverage axes we track lift on. Adding a new
  // axis is a contract change — bump VERSION and update the diff schema.
  TRACKED_AXES: Object.freeze([
    "entity_coverage_pct",
    "time_anchor_coverage_pct",
    "valence_coverage_pct",
    "episodicity_coverage_pct",
  ]),
  TRACKED_RECALL_AXES: Object.freeze([
    "non_empty_entities_pct",
    "non_empty_time_anchor_pct",
    "non_empty_valence_pct",
    "degraded_recall_pct",
  ]),
});

// -----------------------------------------------------------------------------
// Pure helpers (test-importable; no side effects).
// -----------------------------------------------------------------------------

/** Load + parse a JSON file. Returns null if missing; throws on malformed. */
export function loadJson(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

/** Pull the synthesis_coverage block out of a health envelope or wrapper.
 *  Accepts:
 *    - the raw health data ({ synthesis_coverage: ... })
 *    - a captured snapshot ({ synthesis_coverage: ... })
 *    - the projection itself (passes through)
 *  Returns null if the projection cannot be located. */
export function extractCoverage(healthLike) {
  if (healthLike == null || typeof healthLike !== "object") return null;
  if (healthLike.synthesis_coverage !== undefined) {
    return healthLike.synthesis_coverage;
  }
  // The projection has a unique signature (entity_coverage block); use it
  // as a fingerprint to recognize when callers already extracted it.
  if (
    healthLike.entity_coverage &&
    typeof healthLike.entity_coverage === "object"
  ) {
    return healthLike;
  }
  return null;
}

function safePct(block) {
  if (block == null || typeof block !== "object") return 0;
  const n = Number(block.pct);
  return Number.isFinite(n) ? n : 0;
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Compute the wave-finalizer lift report.
 *  - baselineCov / currentCov are synthesis_coverage projections (or null).
 *  - Returns a plain object with baseline/current/delta for every tracked axis.
 *  - Missing axes coerce to 0 so a fresh-baseline / cold-current run still
 *    produces a structurally-valid report. */
export function diffSynthesisCoverage(baselineCov, currentCov) {
  const baseAxes = {};
  const currAxes = {};
  const deltaAxes = {};
  const baseB = baselineCov || {};
  const currB = currentCov || {};

  // Fact-side coverage axes.
  for (const axis of CAPS.TRACKED_AXES) {
    const key = axis.replace(/_pct$/, ""); // "entity_coverage_pct" -> "entity_coverage"
    const b = safePct(baseB[key]);
    const c = safePct(currB[key]);
    baseAxes[axis] = b;
    currAxes[axis] = c;
    deltaAxes[axis] = round4(c - b);
  }

  // Recall-side population axes.
  const baseRecall = (baseB.recall_population && typeof baseB.recall_population === "object")
    ? baseB.recall_population
    : {};
  const currRecall = (currB.recall_population && typeof currB.recall_population === "object")
    ? currB.recall_population
    : {};
  for (const axis of CAPS.TRACKED_RECALL_AXES) {
    const b = safeNum(baseRecall[axis]);
    const c = safeNum(currRecall[axis]);
    baseAxes["recall_population_" + axis] = b;
    currAxes["recall_population_" + axis] = c;
    deltaAxes["recall_population_" + axis] = round4(c - b);
  }

  // Window scalars.
  const baseFacts = safeNum(baseB.facts_in_window);
  const currFacts = safeNum(currB.facts_in_window);
  baseAxes.facts_in_window = baseFacts;
  currAxes.facts_in_window = currFacts;
  deltaAxes.facts_in_window = currFacts - baseFacts;

  const baseRecalls = safeNum(baseRecall.recalls_in_window);
  const currRecalls = safeNum(currRecall.recalls_in_window);
  baseAxes.recalls_in_window = baseRecalls;
  currAxes.recalls_in_window = currRecalls;
  deltaAxes.recalls_in_window = currRecalls - baseRecalls;

  return {
    baseline: baseAxes,
    current: currAxes,
    delta: deltaAxes,
    window_days: safeNum(currB.window_days) || safeNum(baseB.window_days) || null,
  };
}

function round4(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

/** Compose the wave finalizer report. Pure: no I/O. */
export function buildLift({
  baselineSnapshot,
  currentSnapshot,
  capturedAt,
  liveStatus,
}) {
  const baseCov = extractCoverage(baselineSnapshot);
  const currCov = extractCoverage(currentSnapshot);
  const diff = diffSynthesisCoverage(baseCov, currCov);

  return {
    version: VERSION,
    captured_at: capturedAt,
    live_status: liveStatus || "ok",
    baseline_source: baselineSnapshot && baselineSnapshot.captured_via
      ? baselineSnapshot.captured_via
      : null,
    current_source: currentSnapshot && currentSnapshot.captured_via
      ? currentSnapshot.captured_via
      : null,
    lift_report: diff,
    raw_baseline_present: baseCov != null,
    raw_current_present: currCov != null,
  };
}

/** Persist a lift report to disk. Idempotent: caller chooses the path. */
export function writeLiftReport(outPath, report) {
  const dir = dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
  return outPath;
}

// -----------------------------------------------------------------------------
// Live-call wrapper. Best-effort: if buildHealthData throws (corrupt ledger,
// EACCES, ESM init failure on a cold tree), we degrade to a stub current
// snapshot with live_status="unavailable" rather than killing the closeout.
// -----------------------------------------------------------------------------

export async function fetchLiveHealth({ healthBuilder } = {}) {
  try {
    const builder = healthBuilder || (await loadDefaultHealthBuilder());
    if (builder == null) {
      return { ok: false, reason: "health_module_unavailable", data: null };
    }
    const data = await builder();
    return { ok: true, reason: null, data };
  } catch (e) {
    return {
      ok: false,
      reason: e && e.message ? e.message : String(e),
      data: null,
    };
  }
}

async function loadDefaultHealthBuilder() {
  try {
    const mod = await import("../lib/tools/health.js");
    return mod.buildHealthData;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// CLI entrypoint.
// -----------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    baseline: null,
    out: null,
    healthJson: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--baseline") opts.baseline = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--health-json") opts.healthJson = argv[++i];
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node mcp/scripts/ccs-coverage-recheck.mjs [options]",
      "",
      "Options:",
      "  --baseline <path>     Override baseline-coverage.json path",
      "  --out <path>          Override output lift-report path",
      "  --health-json <path>  Use captured health envelope JSON instead of live call",
      "  --help, -h            Show this help",
      "",
      `Version: ${VERSION}`,
      "",
    ].join("\n"),
  );
}

function defaultBaselinePath() {
  return resolve(CAPS.DEFAULT_ARTIFACTS_DIR, CAPS.DEFAULT_BASELINE_FILENAME);
}

function defaultOutPath(ts) {
  return resolve(
    CAPS.DEFAULT_ARTIFACTS_DIR,
    `${CAPS.DEFAULT_OUTPUT_PREFIX}${ts}.json`,
  );
}

export async function runCli(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    return 0;
  }
  const baselinePath = opts.baseline || defaultBaselinePath();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = opts.out || defaultOutPath(ts);

  let baselineSnapshot = null;
  try {
    baselineSnapshot = loadJson(baselinePath);
  } catch (e) {
    process.stderr.write(
      `ccs-coverage-recheck: baseline load failed: ${e && e.message}\n`,
    );
  }

  let currentSnapshot = null;
  let liveStatus = "ok";
  if (opts.healthJson) {
    try {
      currentSnapshot = loadJson(opts.healthJson);
      liveStatus = currentSnapshot ? "from_file" : "missing_file";
    } catch (e) {
      liveStatus = `file_load_error:${e && e.message}`;
    }
  } else {
    const live = await fetchLiveHealth();
    if (live.ok) {
      currentSnapshot = live.data;
      liveStatus = "live";
    } else {
      liveStatus = `unavailable:${live.reason}`;
    }
  }

  const report = buildLift({
    baselineSnapshot,
    currentSnapshot,
    capturedAt: new Date().toISOString(),
    liveStatus,
  });

  writeLiftReport(outPath, report);
  process.stdout.write(JSON.stringify({ out: outPath, report }, null, 2) + "\n");
  return 0;
}

// Direct invocation guard (CLI mode).
const isDirect =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].endsWith("ccs-coverage-recheck.mjs");

if (isDirect) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(
        `ccs-coverage-recheck: unexpected failure: ${err && err.message ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
