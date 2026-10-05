// ccs-coverage-recheck.test.mjs
//
// W4-CCS operational scripts — combined unit + CLI test.
//
// Covers:
//   - mcp/scripts/ccs-coverage-recheck.mjs
//
// Discipline:
//   - HERMETIC: TMP_ROOT created per-suite; deleted on exit.
//   - node:test + node:assert/strict.
//   - Per script: pure-function asserts + CLI-mode asserts.
//   - >=12 assertions total per the W4-CCS engineering discipline note.
//
// Run:
//   node --test test/synthesis/ccs-coverage-recheck.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");

const TMP_ROOT = mkdtempSync(join(tmpdir(), "ccs-ops-scripts-"));
process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {}
});

// Module imports wrapped in try/catch — explicit failure beats a node:test
// "Cannot find module" stack with no context.
let coverageMod;
try {
  coverageMod = await import(
    "../../scripts/ccs-coverage-recheck.mjs"
  );
} catch (err) {
  console.error("FATAL: module import failed:", err);
  process.exit(1);
}

const COVERAGE_SCRIPT = resolve(
  REPO_ROOT,
  "scripts",
  "ccs-coverage-recheck.mjs",
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBaselineCoverage() {
  return {
    captured_at: "2026-06-21T00:00:00Z",
    captured_via: "baseline-fixture",
    synthesis_coverage: {
      window_days: 7,
      facts_in_window: 100,
      entity_coverage: { populated: 0, empty: 100, pct: 0 },
      time_anchor_coverage: { populated: 0, empty: 100, pct: 0 },
      valence_coverage: { populated: 0, empty: 100, pct: 0 },
      episodicity_coverage: { populated: 0, empty: 100, pct: 0 },
      recall_population: {
        recalls_in_window: 2,
        non_empty_entities_pct: 0,
        non_empty_time_anchor_pct: 0,
        non_empty_valence_pct: 0,
        degraded_recall_pct: 0,
      },
    },
  };
}

function makeCurrentCoveragePass() {
  return {
    captured_at: "2026-06-22T00:00:00Z",
    captured_via: "current-fixture-pass",
    synthesis_coverage: {
      window_days: 7,
      facts_in_window: 100,
      entity_coverage: { populated: 85, empty: 15, pct: 0.85 },
      time_anchor_coverage: { populated: 82, empty: 18, pct: 0.82 },
      valence_coverage: { populated: 90, empty: 10, pct: 0.9 },
      episodicity_coverage: { populated: 88, empty: 12, pct: 0.88 },
      recall_population: {
        recalls_in_window: 7,
        non_empty_entities_pct: 0.8,
        non_empty_time_anchor_pct: 0.75,
        non_empty_valence_pct: 0.9,
        degraded_recall_pct: 0.1,
      },
    },
  };
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

// ---------------------------------------------------------------------------
// PART A — ccs-coverage-recheck.mjs
// ---------------------------------------------------------------------------

test("coverage-recheck: VERSION + CAPS exported + frozen", () => {
  assert.equal(typeof coverageMod.VERSION, "string");
  assert.match(coverageMod.VERSION, /^ccs-coverage-recheck@/);
  assert.ok(Object.isFrozen(coverageMod.CAPS), "CAPS should be frozen");
  assert.ok(
    Array.isArray(coverageMod.CAPS.TRACKED_AXES) &&
      coverageMod.CAPS.TRACKED_AXES.length > 0,
    "TRACKED_AXES non-empty",
  );
});

test("coverage-recheck: diffSynthesisCoverage produces baseline/current/delta", () => {
  const baseline = makeBaselineCoverage().synthesis_coverage;
  const current = makeCurrentCoveragePass().synthesis_coverage;
  const diff = coverageMod.diffSynthesisCoverage(baseline, current);
  assert.ok(diff.baseline && diff.current && diff.delta, "shape");
  assert.equal(diff.baseline.entity_coverage_pct, 0);
  assert.equal(diff.current.entity_coverage_pct, 0.85);
  assert.equal(diff.delta.entity_coverage_pct, 0.85);
  assert.equal(
    diff.delta.recall_population_non_empty_entities_pct,
    0.8,
  );
  assert.equal(diff.delta.recalls_in_window, 5);
});

test("coverage-recheck: diff defends against null inputs", () => {
  const d = coverageMod.diffSynthesisCoverage(null, null);
  assert.ok(d, "returns object");
  assert.equal(d.delta.entity_coverage_pct, 0);
  assert.equal(d.delta.facts_in_window, 0);
});

test("coverage-recheck: extractCoverage finds projection from health envelope", () => {
  const wrapper = { synthesis_coverage: { entity_coverage: { pct: 0.5 } } };
  const direct = { entity_coverage: { pct: 0.7 } };
  assert.equal(coverageMod.extractCoverage(wrapper).entity_coverage.pct, 0.5);
  assert.equal(coverageMod.extractCoverage(direct).entity_coverage.pct, 0.7);
  assert.equal(coverageMod.extractCoverage(null), null);
});

test("coverage-recheck: buildLift composes report with live_status flag", () => {
  const report = coverageMod.buildLift({
    baselineSnapshot: makeBaselineCoverage(),
    currentSnapshot: makeCurrentCoveragePass(),
    capturedAt: "2026-06-22T00:01:00Z",
    liveStatus: "from_file",
  });
  assert.equal(report.version, coverageMod.VERSION);
  assert.equal(report.live_status, "from_file");
  assert.equal(report.baseline_source, "baseline-fixture");
  assert.equal(report.current_source, "current-fixture-pass");
  assert.equal(report.lift_report.delta.entity_coverage_pct, 0.85);
  assert.ok(report.raw_baseline_present);
  assert.ok(report.raw_current_present);
});

test("coverage-recheck: CLI mode runs end-to-end with --health-json", () => {
  const baselinePath = join(TMP_ROOT, "cov-baseline.json");
  const healthPath = join(TMP_ROOT, "cov-current.json");
  const outPath = join(TMP_ROOT, "cov-out.json");
  writeJson(baselinePath, makeBaselineCoverage());
  writeJson(healthPath, makeCurrentCoveragePass());
  const r = spawnSync(
    process.execPath,
    [
      COVERAGE_SCRIPT,
      "--baseline",
      baselinePath,
      "--health-json",
      healthPath,
      "--out",
      outPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, `stderr=${r.stderr}\nstdout=${r.stdout}`);
  assert.ok(existsSync(outPath), "wrote out file");
  const report = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(report.live_status, "from_file");
  assert.equal(report.lift_report.delta.entity_coverage_pct, 0.85);
});
