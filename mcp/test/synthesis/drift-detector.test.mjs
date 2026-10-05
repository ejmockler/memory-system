// drift-detector.test.mjs — Wave 12 OPERATIONAL coverage for
// F-SYN-OPERATIONAL-drift-detection.
//
// Asserts the drift-detector's contract:
//   - Stable ledger (single extractor version, flat coverage) yields zero alerts.
//   - Multi-version observation in the 7-day window fires
//     extractor_version_bump.
//   - Baseline 95% coverage that drops to 80% in the alert window fires
//     coverage_drop with the right severity ladder + drift_pct math.
//   - Recall-side query_episodicity moving outside the +/- threshold band
//     fires query_episodicity_drift.
//   - Per-fact entity-count drop fires entity_count_drop.
//   - Missing ledger / malformed rows / missing files degrade safely (no
//     throw, no spurious alerts).
//   - memory_health envelope surfaces drift_alerts as a top-level projection.
//   - VERSION + CAPS exported (module-surface invariant).
//
// Discipline:
//   - HERMETIC: env vars + tmpdir BEFORE any dynamic import that touches
//     config.js (matches W2-W11 hermeticity pattern).
//   - node:test + node:assert/strict.
//   - 12+ assertions across the suite.
//
// Run:
//   node --test test/synthesis/drift-detector.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hermetic env. MUST be set BEFORE any dynamic import touches config.js so the
// ledger / policy paths land under TMP_ROOT.
// ---------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-drift-detector-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.POLICY_BASE_DIR = join(TMP_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TMP_ROOT, "ledgers");
process.env.HOOKS_BASE_DIR = join(TMP_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(TMP_ROOT, "daemons");

for (const d of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  process.env.HOOKS_BASE_DIR,
  process.env.DAEMONS_BASE_DIR,
  join(process.env.STORAGE_BASE_DIR, "sources"),
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {}
});

// Defensive imports — try/catch documents the module-load contract.
let driftMod;
let healthMod;
try {
  driftMod = await import("../../lib/synthesis/drift-detector.js");
  healthMod = await import("../../lib/tools/health.js");
} catch (err) {
  console.error("FATAL: module import failed:", err);
  process.exit(1);
}

const {
  detectDrift,
  DRIFT_DETECTOR_VERSION,
  DRIFT_CAPS,
  DRIFT_ALERT_KINDS,
} = driftMod;
const { buildHealthData } = healthMod;

// Helper: write JSONL rows to a file. One row per line, trailing newline.
function writeJsonl(path, rows) {
  const text = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  writeFileSync(path, text, { mode: 0o600 });
}

// Clock anchor. Fixed so window-filter assertions are deterministic. The
// detector's baseline window is 30d and alert window is 7d, so we use:
//   - "alertWindow" timestamps: 1-6 days ago (current window)
//   - "baselineWindow" timestamps: 10-29 days ago (baseline only)
//   - "outOfWindow" timestamps: 40+ days ago (excluded entirely)
const NOW = new Date("2026-06-20T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const inAlertWindowTs = (daysAgo) =>
  new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();

function factWithVersion(id, daysAgo, opts) {
  const o = opts || {};
  return {
    id,
    kind: "fact",
    ts: inAlertWindowTs(daysAgo),
    content: "drift fixture",
    features: {
      entities: o.entities || [{ canonical_id: "topic:test:a", kind: "topic" }],
      entity_extractor_version: o.entityVersion || "v0.1.0",
      time_anchors: o.timeAnchors || [
        { instant_iso: inAlertWindowTs(daysAgo), kind: "explicit", resolver: "test" },
      ],
      time_anchor_resolver_version: o.timeAnchorVersion || "v0.1.0",
      valence: o.valence == null ? 0.2 : o.valence,
      valence_model_version: o.valenceVersion || "lexicon-v1",
      episodicity: o.episodicity == null ? 0.6 : o.episodicity,
      episodicity_version: o.episodicityVersion || "v0.1.0",
    },
  };
}

function factWithEmptyStamps(id, daysAgo) {
  return {
    id,
    kind: "fact",
    ts: inAlertWindowTs(daysAgo),
    content: "empty-stamp fixture",
    features: {
      entities: [],
      time_anchors: [],
      valence: null,
      episodicity: null,
    },
  };
}

function recallWithQueryEpisodicity(id, daysAgo, qe) {
  return {
    id,
    ts: inAlertWindowTs(daysAgo),
    kind: "recall",
    populator: {
      version: "v1",
      degraded: false,
      degraded_reasons: [],
      entities_count: 1,
      time_anchors_count: 1,
      inferred_mood_sign: 0.2,
      has_time_anchor: true,
      query_episodicity: qe,
    },
    degraded_recall: false,
  };
}

const LEDGER_PATH = join(TMP_ROOT, "ledgers", "memory.jsonl");
const RECALL_PATH = join(TMP_ROOT, "ledgers", "recall.jsonl");

// ---------------------------------------------------------------------------
// T0 — module-surface invariant: VERSION + frozen CAPS exported.
// ---------------------------------------------------------------------------
test("T0: module exports VERSION + frozen CAPS + alert-kind enum", () => {
  assert.equal(
    typeof DRIFT_DETECTOR_VERSION,
    "string",
    "DRIFT_DETECTOR_VERSION is exported as string",
  );
  assert.equal(DRIFT_DETECTOR_VERSION, "v0.1.0", "version matches WU pin");
  assert.equal(Object.isFrozen(DRIFT_CAPS), true, "DRIFT_CAPS is frozen");
  assert.equal(DRIFT_CAPS.COVERAGE_DROP_THRESHOLD_PCT, 5);
  assert.equal(DRIFT_CAPS.ENTITY_COUNT_DROP_THRESHOLD_PCT, 10);
  assert.equal(DRIFT_CAPS.BASELINE_WINDOW_DAYS, 30);
  assert.equal(DRIFT_CAPS.ALERT_WINDOW_DAYS, 7);
  // Alert-kind taxonomy is closed; the four kinds must be exported.
  assert.equal(DRIFT_ALERT_KINDS.EXTRACTOR_VERSION_BUMP, "extractor_version_bump");
  assert.equal(DRIFT_ALERT_KINDS.COVERAGE_DROP, "coverage_drop");
  assert.equal(DRIFT_ALERT_KINDS.ENTITY_COUNT_DROP, "entity_count_drop");
  assert.equal(DRIFT_ALERT_KINDS.QUERY_EPISODICITY_DRIFT, "query_episodicity_drift");
});

// ---------------------------------------------------------------------------
// T1 — stable substrate: single extractor version, flat coverage → zero alerts.
//
// Both baseline and alert windows look identical. The detector should emit
// no alerts and the envelope should still carry its scaffolding fields.
// ---------------------------------------------------------------------------
test("T1: stable substrate yields zero alerts", async () => {
  const rows = [];
  // Spread 20 facts across the baseline + alert windows, all on the SAME
  // extractor version. Coverage is uniform.
  for (let i = 0; i < 10; i++) {
    rows.push(factWithVersion(`b${i}`, 14 + i, {})); // baseline
  }
  for (let i = 0; i < 10; i++) {
    rows.push(factWithVersion(`c${i}`, 1 + (i % 6), {})); // alert window
  }
  writeJsonl(LEDGER_PATH, rows);
  writeJsonl(RECALL_PATH, []);

  const env = await detectDrift({
    ledgerPath: LEDGER_PATH,
    recallLogPath: RECALL_PATH,
    now: NOW,
  });

  assert.equal(env.alerts.length, 0, "stable substrate → no alerts");
  assert.equal(env.detector_version, DRIFT_DETECTOR_VERSION);
  assert.equal(env.baseline_window_days, 30);
  assert.equal(env.alert_window_days, 7);
  assert.equal(env.baseline_facts, 10);
  assert.equal(env.current_facts, 10);
  assert.equal(typeof env.built_at, "string");
  assert.ok(env.built_at.startsWith("2026-06-20"), "built_at mirrors NOW");
});

// ---------------------------------------------------------------------------
// T2 — extractor_version_bump when interleaved versions appear in the
// 7-day alert window.
// ---------------------------------------------------------------------------
test("T2: interleaved old + new extractor versions fire extractor_version_bump", async () => {
  const rows = [
    // Baseline: all v0.1.0
    factWithVersion("b1", 14, { entityVersion: "v0.1.0" }),
    factWithVersion("b2", 16, { entityVersion: "v0.1.0" }),
    factWithVersion("b3", 18, { entityVersion: "v0.1.0" }),
    // Alert window: BOTH v0.1.0 and v0.2.0 observed
    factWithVersion("c1", 1, { entityVersion: "v0.1.0" }),
    factWithVersion("c2", 2, { entityVersion: "v0.2.0" }),
    factWithVersion("c3", 3, { entityVersion: "v0.2.0" }),
  ];
  writeJsonl(LEDGER_PATH, rows);
  writeJsonl(RECALL_PATH, []);

  const env = await detectDrift({
    ledgerPath: LEDGER_PATH,
    recallLogPath: RECALL_PATH,
    now: NOW,
  });

  const bumpAlerts = env.alerts.filter(
    (a) => a.kind === DRIFT_ALERT_KINDS.EXTRACTOR_VERSION_BUMP,
  );
  assert.ok(
    bumpAlerts.length >= 1,
    `expected ≥1 extractor_version_bump alert, got ${JSON.stringify(env.alerts)}`,
  );
  const entityBump = bumpAlerts.find((a) => a.axis === "entity_extractor_version");
  assert.ok(entityBump, "entity_extractor_version axis flagged");
  assert.equal(entityBump.severity, "info", "version-bump alone is info severity");
  assert.ok(
    Array.isArray(entityBump.current) && entityBump.current.includes("v0.2.0"),
    "current versions include v0.2.0",
  );
  assert.ok(
    Array.isArray(entityBump.current) && entityBump.current.includes("v0.1.0"),
    "current versions include v0.1.0 (interleaved)",
  );
});

// ---------------------------------------------------------------------------
// T3 — coverage_drop: version bump + coverage falling below threshold fires
// BOTH alerts. The baseline has 100% entity coverage; the alert window
// drops to ~33% (1 stamped, 2 empty).
// ---------------------------------------------------------------------------
test("T3: version bump + coverage drop fires extractor_version_bump and coverage_drop", async () => {
  const rows = [
    // Baseline: 10 facts all fully stamped, all v0.1.0
    factWithVersion("b1", 12, { entityVersion: "v0.1.0" }),
    factWithVersion("b2", 13, { entityVersion: "v0.1.0" }),
    factWithVersion("b3", 14, { entityVersion: "v0.1.0" }),
    factWithVersion("b4", 15, { entityVersion: "v0.1.0" }),
    factWithVersion("b5", 16, { entityVersion: "v0.1.0" }),
    factWithVersion("b6", 17, { entityVersion: "v0.1.0" }),
    factWithVersion("b7", 18, { entityVersion: "v0.1.0" }),
    factWithVersion("b8", 19, { entityVersion: "v0.1.0" }),
    factWithVersion("b9", 20, { entityVersion: "v0.1.0" }),
    factWithVersion("b10", 21, { entityVersion: "v0.1.0" }),
    // Alert window: 1 fully stamped on v0.2.0, 2 with empty stamps.
    // entity_coverage current = 1/3 = 33% vs baseline 100% → 67-point drop.
    factWithVersion("c1", 1, { entityVersion: "v0.2.0" }),
    factWithEmptyStamps("c2", 2),
    factWithEmptyStamps("c3", 3),
  ];
  writeJsonl(LEDGER_PATH, rows);
  writeJsonl(RECALL_PATH, []);

  const env = await detectDrift({
    ledgerPath: LEDGER_PATH,
    recallLogPath: RECALL_PATH,
    now: NOW,
  });

  const coverageAlerts = env.alerts.filter(
    (a) => a.kind === DRIFT_ALERT_KINDS.COVERAGE_DROP,
  );
  assert.ok(
    coverageAlerts.length >= 1,
    `expected ≥1 coverage_drop alert, got ${JSON.stringify(env.alerts)}`,
  );
  const entityCoverageAlert = coverageAlerts.find(
    (a) => a.axis === "entity_coverage",
  );
  assert.ok(entityCoverageAlert, "entity_coverage axis flagged");
  // 100% baseline → 33% current = 67-point drop, which is > 2x threshold
  // (10pp), so severity should be critical.
  assert.equal(
    entityCoverageAlert.severity,
    "critical",
    `expected critical severity, got ${entityCoverageAlert.severity}`,
  );
  assert.ok(
    entityCoverageAlert.drift_pct > DRIFT_CAPS.COVERAGE_DROP_THRESHOLD_PCT,
    `drift_pct (${entityCoverageAlert.drift_pct}) > threshold ${DRIFT_CAPS.COVERAGE_DROP_THRESHOLD_PCT}`,
  );
  assert.equal(entityCoverageAlert.baseline, 1.0, "baseline pct = 100%");
  // Version bump should also fire.
  const bumpAlerts = env.alerts.filter(
    (a) => a.kind === DRIFT_ALERT_KINDS.EXTRACTOR_VERSION_BUMP,
  );
  assert.ok(
    bumpAlerts.length >= 1,
    "version-bump alert also fires alongside coverage_drop",
  );
});

// ---------------------------------------------------------------------------
// T4 — entity_count_drop: stamping rate stays high (100%) but average
// entities-per-fact halves. Catches a regression where the extractor runs
// but returns fewer entities per row.
// ---------------------------------------------------------------------------
test("T4: entity_count_drop fires when per-row entity count regresses", async () => {
  const richEntities = [
    { canonical_id: "topic:test:a", kind: "topic" },
    { canonical_id: "topic:test:b", kind: "topic" },
    { canonical_id: "topic:test:c", kind: "topic" },
    { canonical_id: "topic:test:d", kind: "topic" },
  ];
  const sparseEntities = [
    { canonical_id: "topic:test:a", kind: "topic" },
  ];
  const rows = [
    // Baseline: 5 facts with 4 entities each (avg = 4.0)
    factWithVersion("b1", 12, { entities: richEntities }),
    factWithVersion("b2", 14, { entities: richEntities }),
    factWithVersion("b3", 16, { entities: richEntities }),
    factWithVersion("b4", 18, { entities: richEntities }),
    factWithVersion("b5", 20, { entities: richEntities }),
    // Alert window: 5 facts with 1 entity each (avg = 1.0)
    //   = 75% drop, > ENTITY_COUNT_DROP_THRESHOLD_PCT (10)
    factWithVersion("c1", 1, { entities: sparseEntities }),
    factWithVersion("c2", 2, { entities: sparseEntities }),
    factWithVersion("c3", 3, { entities: sparseEntities }),
    factWithVersion("c4", 4, { entities: sparseEntities }),
    factWithVersion("c5", 5, { entities: sparseEntities }),
  ];
  writeJsonl(LEDGER_PATH, rows);
  writeJsonl(RECALL_PATH, []);

  const env = await detectDrift({
    ledgerPath: LEDGER_PATH,
    recallLogPath: RECALL_PATH,
    now: NOW,
  });

  const countAlert = env.alerts.find(
    (a) => a.kind === DRIFT_ALERT_KINDS.ENTITY_COUNT_DROP,
  );
  assert.ok(
    countAlert,
    `expected entity_count_drop alert, got ${JSON.stringify(env.alerts)}`,
  );
  assert.equal(countAlert.baseline, 4.0, "baseline avg = 4 entities/fact");
  assert.equal(countAlert.current, 1.0, "current avg = 1 entity/fact");
  assert.ok(
    countAlert.drift_pct >= 50,
    `drift_pct ≥ 50 (got ${countAlert.drift_pct})`,
  );
});

// ---------------------------------------------------------------------------
// T5 — query_episodicity_drift: recall-side distribution shifts beyond the
// threshold band.
// ---------------------------------------------------------------------------
test("T5: query_episodicity_drift fires when recall distribution moves", async () => {
  writeJsonl(LEDGER_PATH, []);
  const recalls = [
    // Baseline: low-episodicity queries (avg ~0.2)
    recallWithQueryEpisodicity("rb1", 10, 0.2),
    recallWithQueryEpisodicity("rb2", 14, 0.15),
    recallWithQueryEpisodicity("rb3", 18, 0.25),
    recallWithQueryEpisodicity("rb4", 22, 0.2),
    // Current: high-episodicity queries (avg ~0.8)
    recallWithQueryEpisodicity("rc1", 1, 0.8),
    recallWithQueryEpisodicity("rc2", 2, 0.85),
    recallWithQueryEpisodicity("rc3", 3, 0.75),
  ];
  writeJsonl(RECALL_PATH, recalls);

  const env = await detectDrift({
    ledgerPath: LEDGER_PATH,
    recallLogPath: RECALL_PATH,
    now: NOW,
  });

  const driftAlert = env.alerts.find(
    (a) => a.kind === DRIFT_ALERT_KINDS.QUERY_EPISODICITY_DRIFT,
  );
  assert.ok(
    driftAlert,
    `expected query_episodicity_drift alert, got ${JSON.stringify(env.alerts)}`,
  );
  assert.equal(driftAlert.severity, "warn", "query_episodicity_drift is warn severity");
  assert.ok(driftAlert.baseline < 0.3, "baseline avg < 0.3");
  assert.ok(driftAlert.current > 0.7, "current avg > 0.7");
  assert.ok(
    driftAlert.drift_pct > DRIFT_CAPS.COVERAGE_DROP_THRESHOLD_PCT,
    `drift_pct ${driftAlert.drift_pct} > threshold ${DRIFT_CAPS.COVERAGE_DROP_THRESHOLD_PCT}`,
  );
  assert.equal(env.baseline_recalls, 4);
  assert.equal(env.current_recalls, 3);
});

// ---------------------------------------------------------------------------
// T6 — defensive: missing ledger, malformed lines, missing recall path.
// Detector must degrade rather than throw.
// ---------------------------------------------------------------------------
test("T6: missing ledger / malformed lines / missing recall path degrade safely", async () => {
  // Mixed-good-and-malformed cascade ledger.
  const goodFact = factWithVersion("good1", 1, {});
  const text =
    JSON.stringify(goodFact) +
    "\n" +
    "this is not json\n" +
    "{partial:" +
    "\n";
  writeFileSync(LEDGER_PATH, text, { mode: 0o600 });

  // Missing recall ledger entirely.
  const env = await detectDrift({
    ledgerPath: LEDGER_PATH,
    recallLogPath: join(TMP_ROOT, "ledgers", "does-not-exist.jsonl"),
    now: NOW,
  });

  assert.ok(Array.isArray(env.alerts), "alerts is always an array");
  assert.equal(env.baseline_recalls, 0);
  assert.equal(env.current_recalls, 0);
  // With only one fact in window and no baseline, no coverage_drop should fire.
  const coverageAlerts = env.alerts.filter(
    (a) => a.kind === DRIFT_ALERT_KINDS.COVERAGE_DROP,
  );
  assert.equal(
    coverageAlerts.length,
    0,
    "no coverage_drop alerts when baseline is empty",
  );
  assert.equal(typeof env.built_at, "string", "envelope always has built_at");

  // Fully-missing ledger path → empty envelope, no throw.
  const env2 = await detectDrift({
    ledgerPath: join(TMP_ROOT, "ledgers", "also-missing.jsonl"),
    recallLogPath: join(TMP_ROOT, "ledgers", "still-missing.jsonl"),
    now: NOW,
  });
  assert.equal(env2.alerts.length, 0, "missing paths → no alerts (no throw)");
  assert.equal(env2.baseline_facts, 0);
  assert.equal(env2.current_facts, 0);
});

// ---------------------------------------------------------------------------
// T7 — memory_health envelope surfaces drift_alerts top-level projection.
// ---------------------------------------------------------------------------
test("T7: memory_health envelope includes drift_alerts projection", async () => {
  // Plant a small fixture so drift_alerts is non-null + has empty alerts.
  writeJsonl(LEDGER_PATH, [
    factWithVersion("b1", 14, {}),
    factWithVersion("b2", 16, {}),
    factWithVersion("c1", 1, {}),
    factWithVersion("c2", 3, {}),
  ]);
  writeJsonl(RECALL_PATH, []);

  const data = await buildHealthData({
    sourcesDir: join(TMP_ROOT, "storage", "sources"),
    memoryLedgerPath: LEDGER_PATH,
    recallLogPath: RECALL_PATH,
    now: NOW,
  });

  assert.ok("drift_alerts" in data, "drift_alerts key present in envelope");
  assert.notEqual(data.drift_alerts, null, "drift_alerts is non-null on happy path");
  assert.ok(Array.isArray(data.drift_alerts.alerts), "drift_alerts.alerts is an array");
  assert.equal(
    data.drift_alerts.detector_version,
    DRIFT_DETECTOR_VERSION,
    "envelope carries detector_version",
  );
  assert.equal(data.drift_alerts.baseline_window_days, 30);
  assert.equal(data.drift_alerts.alert_window_days, 7);
});
