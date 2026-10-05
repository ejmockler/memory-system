// memory_health real-data conformance tests (review-12 H9 + H8).
//
// Asserts:
//   1. tools_registered equals the live toolCount() (no hardcoded constant).
//   2. distillation_state.watermark_lag_seconds is computed against an on-disk
//      state file (override-for-test paths so we don't pollute the live
//      install).
//   3. health_notes is always an array.
//
// Also asserts the AUTHORITATIVE field set: the response keys MUST equal the
// frozen field set in kb/mcp-surface.md L964-990 — no extras, no omissions.
//
// Run: node test/health-real-data.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, utimesSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Finding 1 (verify-dedup): wrap node:crypto.createHash BEFORE importing
// health.js so ledger-checkpoint.js's ESM binding captures the counter. On the
// reducer compute path verifyPrefix is the only hasher, so a createHash count
// is an exact measure of sampled prefix-verification work per health call.
const _require = createRequire(import.meta.url);
const _crypto = _require("node:crypto");
const _origCreateHash = _crypto.createHash;
let hashCounting = false;
let hashCalls = 0;
_crypto.createHash = function countingCreateHash(...args) {
  if (hashCounting) hashCalls += 1;
  return _origCreateHash.apply(this, args);
};

// HERMETICITY (round-14 C-NEW-2 sibling fix): Test 1 calls buildHealthData()
// with no opts, which would otherwise read the live install's distillation-state
// + memory.jsonl. Read-only but pollutes test results based on production state.
// Set env vars BEFORE importing health.js so config.js binds paths inside a tmpdir.
const TEST_ROOT_PRE = mkdtempSync(join(tmpdir(), "memsys-health-test-"));
mkdirSync(join(TEST_ROOT_PRE, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT_PRE, "storage"), { recursive: true });
mkdirSync(join(TEST_ROOT_PRE, "ledgers"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT_PRE;
process.env.POLICY_BASE_DIR = join(TEST_ROOT_PRE, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT_PRE, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT_PRE, "ledgers");
process.env.TELEMETRY_BASE_DIR = join(TEST_ROOT_PRE, "telemetry");
process.on("exit", () => {
  try { rmSync(TEST_ROOT_PRE, { recursive: true, force: true }); } catch {}
});

const { buildHealthData, TOOL, scheduleReducerStateRebuild } = await import("../lib/tools/health.js");
const { toolCount } = await import("../lib/dispatch.js");
// H2 — reducer library, used by test 5 to pre-build a healthy persisted
// state (the same fold the off-handler rebuild child performs). Test 6 (H2b)
// additionally wraps the compute functions in counting spies via the
// buildHealthData opts seams.
const {
  updateStateFromLedgers,
  saveState: saveReducerState,
  computeCoverageFromState,
  computeDriftFromState,
} = await import("../lib/synthesis/health-reducers.js");

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// AUTHORITATIVE field set per kb/mcp-surface.md L964-990. The block is closed:
// every field below MUST appear and no other field may. This list is the
// drift detector — if the spec adds a field, this test fails until updated.
const AUTHORITATIVE_FIELDS = [
  "schema_version",
  "server_started_at",
  "time_now",
  "tools_registered",
  "telegram_connector_status",
  "source_event_counts",
  "ledger_byte_counts",
  "policy_events_active_file",
  "policy_events_disk_bytes",
  "rederive_jobs_pending",
  "distillation_state",
  // Wave-10: F-SYN-OPERATIONAL-synthesis-coverage-probe added the
  // synthesis_coverage projection to the closed health envelope. See
  // kb/mcp-surface.md health_envelope_schema_v1 block + lib/synthesis/
  // coverage-probe.js for the contract.
  "synthesis_coverage",
  // Wave-12: F-SYN-OPERATIONAL-drift-detection composes with the W10
  // probe — the synthesis_coverage projection answers "what is substrate
  // health right now?" and drift_alerts answers "did it drift from the
  // 30-day baseline?". See lib/synthesis/drift-detector.js for the
  // contract.
  "drift_alerts",
  "health_notes",
];

// ---------------------------------------------------------------------------
// Test 1: tools_registered tracks live registry (no hardcoded 9).
// ---------------------------------------------------------------------------
{
  const data = await buildHealthData();
  const expected = toolCount();
  check(
    "tools_registered equals live toolCount()",
    data.tools_registered === expected,
    `expected ${expected} got ${data.tools_registered}`,
  );
  // Guard against the regression: the Phase 0 stub returned a literal 9 even
  // when the registry grew. If toolCount() is ever != 9 and the health field
  // is still 9, the regression is back.
  check(
    "tools_registered is not the legacy hardcoded constant when registry differs",
    !(expected !== 9 && data.tools_registered === 9),
    "tools_registered looks hardcoded to 9",
  );
}

// ---------------------------------------------------------------------------
// Test 2: distillation_state is the R32.1 static deprecated-marker payload.
// ---------------------------------------------------------------------------
//
// R32 retired the conversational distillation pipeline (watermark.tickOnce +
// the supervisor). R32.1 replaced the dynamic distillation_state surface
// with a frozen deprecated-marker so operator dashboards keep a stable
// shape. The pre-R32 assertions (lag-vs-state-file, in-flight count from
// disk, memory-ledger tail) tested removed code paths and were excised in
// R34 CLOSE-3. What remains is a tight contract check on the marker shape.
{
  const tmpRoot = mkdtempSync(join(tmpdir(), "memory-health-test-"));
  try {
    const sourcesDir = join(tmpRoot, "storage", "sources");
    mkdirSync(sourcesDir, { recursive: true });

    const now = new Date("2026-05-31T00:00:00.000Z");
    const data = await buildHealthData({ sourcesDir, now });

    check(
      "distillation_state.deprecated is true (R32.1 marker)",
      data.distillation_state.deprecated === true,
      `expected true got ${data.distillation_state.deprecated}`,
    );
    check(
      "distillation_state.watermark_lag_seconds is null (deprecated marker)",
      data.distillation_state.watermark_lag_seconds === null,
      `expected null got ${data.distillation_state.watermark_lag_seconds}`,
    );
    check(
      "distillation_state.last_distillation_ts is null (deprecated marker)",
      data.distillation_state.last_distillation_ts === null,
      `expected null got ${data.distillation_state.last_distillation_ts}`,
    );
    check(
      "distillation_state.in_flight_batch_count is 0 (deprecated marker)",
      data.distillation_state.in_flight_batch_count === 0,
      `expected 0 got ${data.distillation_state.in_flight_batch_count}`,
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 3: health_notes is always an array (and AUTHORITATIVE field set holds).
// ---------------------------------------------------------------------------
{
  // Default-path call (no opts): exercises the default MEMORY_ROOT layout.
  // The rederive-jobs unimplemented note guarantees at least one entry.
  const data = await buildHealthData();
  check(
    "health_notes is an array (default path)",
    Array.isArray(data.health_notes),
    `typeof ${typeof data.health_notes}`,
  );
  check(
    "health_notes contains the rederive Phase-2 placeholder",
    data.health_notes.some((n) => n.includes("rederive jobs not yet implemented")),
    "expected the Phase-2 placeholder note",
  );

  // Override-path call against a temp tree with zero source ledgers.
  // R34 CLOSE-3: dropped stateFilePath + memoryLedgerPath opts. R32.1
  // buildHealthData ignores both; the dynamic distillation pipeline was
  // retired. Only sourcesDir + now are load-bearing here.
  const tmpRoot = mkdtempSync(join(tmpdir(), "memory-health-empty-"));
  try {
    const sourcesDir = join(tmpRoot, "storage", "sources");
    mkdirSync(sourcesDir, { recursive: true });

    const emptyData = await buildHealthData({
      sourcesDir,
      now: new Date("2026-05-31T00:00:00.000Z"),
    });
    check(
      "health_notes still an array when all sources are missing",
      Array.isArray(emptyData.health_notes),
      `typeof ${typeof emptyData.health_notes}`,
    );
    check(
      "ledger_missing notes are surfaced for absent source files",
      emptyData.health_notes.some((n) => n.startsWith("ledger_missing:")),
      "expected at least one ledger_missing: note",
    );

    // AUTHORITATIVE FIELD SET — closed block conformance. Exactly the spec
    // keys, no more no less. Drift here = spec drift; fix one or the other.
    const actualKeys = Object.keys(emptyData).sort();
    const expectedKeys = [...AUTHORITATIVE_FIELDS].sort();
    check(
      "data keys equal the AUTHORITATIVE FIELD SET (closed block)",
      JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
      `actual=${JSON.stringify(actualKeys)} expected=${JSON.stringify(expectedKeys)}`,
    );
    check(
      "no legacy fields leaked (ledger_writable, index_status, connectors_*)",
      !("ledger_writable" in emptyData) &&
        !("index_status" in emptyData) &&
        !("connectors_healthy" in emptyData) &&
        !("connectors_total" in emptyData) &&
        !("pending_quarantine_total" in emptyData) &&
        !("rederive_jobs" in emptyData),
      "found a deleted legacy field",
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 4: end-to-end via the registered TOOL.handler (envelope path).
// ---------------------------------------------------------------------------
{
  const env = await TOOL.handler({});
  check("envelope ok=true", env.ok === true);
  check("envelope meta.tool === memory_health", env.meta?.tool === "memory_health");
  check(
    "envelope.data has every AUTHORITATIVE field",
    AUTHORITATIVE_FIELDS.every((k) => Object.prototype.hasOwnProperty.call(env.data, k)),
    "missing one or more authoritative fields",
  );
  check(
    "envelope.data has no extra fields",
    Object.keys(env.data).every((k) => AUTHORITATIVE_FIELDS.includes(k)),
    "found an unexpected field on data",
  );
}

// ---------------------------------------------------------------------------
// Test 5 (H2): reducer-backed synthesis projections — degrade path + healthy
// path + last-known-good watermark.
//
// AUTHORITATIVE field set stays CLOSED: the degrade path adds ONLY the
// `synthesis_state_rebuilding:` health_note; synthesis_coverage/drift_alerts
// keep their existing top-level slots. The degrade path must return WITHOUT
// any inline full ledger scan (asserted structurally: the state file never
// materializes, and the rebuild request goes through the injected scheduler
// spy instead of a real child process); the healthy path must serve
// reducer-computed projections; a later corrupt state must serve the
// last-known-good aggregates verbatim, INCLUDING their built_at watermark.
// Fixture ledgers only — never the real ~2.3GB memory.jsonl (the real-ledger
// equivalence proof lives in scripts/health-equivalence.mjs).
// ---------------------------------------------------------------------------
{
  const { existsSync } = await import("node:fs");
  const tmpRoot = mkdtempSync(join(tmpdir(), "memory-health-reducer-"));
  try {
    const sourcesDir = join(tmpRoot, "storage", "sources");
    mkdirSync(sourcesDir, { recursive: true });
    const stateDir = join(tmpRoot, "health-reducer-state");
    const statePath = join(stateDir, "state.json");
    const memPath = join(tmpRoot, "memory.jsonl");
    const recPath = join(tmpRoot, "recall.jsonl");

    const now = new Date("2026-07-01T12:00:00.000Z");
    const ts = "2026-06-30T00:00:00.000Z"; // inside the 7-day coverage window
    writeFileSync(
      memPath,
      [
        JSON.stringify({
          kind: "fact",
          ts,
          features: {
            entities: ["alpha"],
            time_anchors: ["2026-06-30"],
            valence: 0.5,
            episodicity: 0.2,
            entity_extractor_version: "v1",
          },
        }),
        JSON.stringify({ kind: "fact", ts, features: {} }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      recPath,
      JSON.stringify({
        kind: "recall",
        ts,
        populator: { entities_count: 1, inferred_mood_sign: 1, query_episodicity: 0.4 },
      }) + "\n",
    );

    const baseOpts = {
      sourcesDir,
      memoryLedgerPath: memPath,
      recallLogPath: recPath,
      healthStateDir: stateDir,
      now,
      // Zero inline budget: ANY pending fold bytes must take the degrade
      // path — this is how the test forces "rebuild needed" without a
      // multi-GB fixture. (A zero budget still admits the zero-delta warm
      // path, which is exactly the bounded-by-appended-bytes invariant.)
      inlineFoldMaxBytes: 0,
    };

    // -- 5a: missing state => degrade note, no inline scan, rebuild scheduled.
    const scheduledA = [];
    const dataA = await buildHealthData({ ...baseOpts, scheduleRebuild: (req) => scheduledA.push(req) });
    check(
      "degrade path surfaces the synthesis_state_rebuilding note",
      dataA.health_notes.some((n) => n.startsWith("synthesis_state_rebuilding")),
      `notes=${JSON.stringify(dataA.health_notes)}`,
    );
    check(
      "degrade path with no last-known-good serves synthesis_coverage null",
      dataA.synthesis_coverage === null,
      `got ${JSON.stringify(dataA.synthesis_coverage)}`,
    );
    check(
      "degrade path with no last-known-good serves drift_alerts null",
      dataA.drift_alerts === null,
      `got ${JSON.stringify(dataA.drift_alerts)}`,
    );
    check(
      "rebuild is scheduled OFF the handler (scheduler spy called once)",
      scheduledA.length === 1 && scheduledA[0].statePath === statePath,
      `scheduled=${JSON.stringify(scheduledA)}`,
    );
    check(
      "no inline rebuild on the request path (state file never materialized)",
      !existsSync(statePath),
      "state.json exists — the handler rebuilt inline",
    );
    check(
      "degrade path keeps the AUTHORITATIVE field set closed",
      JSON.stringify(Object.keys(dataA).sort()) === JSON.stringify([...AUTHORITATIVE_FIELDS].sort()),
      `actual=${JSON.stringify(Object.keys(dataA).sort())}`,
    );

    // -- 5b: healthy persisted state => reducer-backed projections, no note.
    const { state } = updateStateFromLedgers(null, { ledgerPath: memPath, recallLogPath: recPath });
    mkdirSync(stateDir, { recursive: true });
    saveReducerState(statePath, state);
    const scheduledB = [];
    const dataB = await buildHealthData({ ...baseOpts, scheduleRebuild: (req) => scheduledB.push(req) });
    check(
      "healthy path emits no synthesis_state_rebuilding note",
      !dataB.health_notes.some((n) => n.startsWith("synthesis_state_rebuilding")),
      `notes=${JSON.stringify(dataB.health_notes)}`,
    );
    check(
      "healthy path serves reducer-computed synthesis_coverage (facts_in_window=2)",
      dataB.synthesis_coverage !== null && dataB.synthesis_coverage.facts_in_window === 2,
      `got ${JSON.stringify(dataB.synthesis_coverage)}`,
    );
    check(
      "healthy path coverage pct matches the fixture (entity 1 of 2)",
      dataB.synthesis_coverage.entity_coverage.pct === 0.5,
      `got ${JSON.stringify(dataB.synthesis_coverage?.entity_coverage)}`,
    );
    check(
      "healthy path serves reducer-computed drift_alerts (alerts array present)",
      dataB.drift_alerts !== null && Array.isArray(dataB.drift_alerts.alerts),
      `got ${JSON.stringify(dataB.drift_alerts)}`,
    );
    check(
      "healthy path schedules no rebuild",
      scheduledB.length === 0,
      `scheduled=${JSON.stringify(scheduledB)}`,
    );
    check(
      "healthy path persists the last-known-good aggregates",
      existsSync(join(stateDir, "last-good.json")),
      "last-good.json missing after a successful compute",
    );

    // -- 5c: corrupt state => degrade note + last-known-good served verbatim
    //        (same envelopes as 5b, INCLUDING their built_at watermark).
    writeFileSync(statePath, "{corrupt json", { mode: 0o600 });
    const scheduledC = [];
    const dataC = await buildHealthData({ ...baseOpts, scheduleRebuild: (req) => scheduledC.push(req) });
    check(
      "corrupt state surfaces the synthesis_state_rebuilding note",
      dataC.health_notes.some((n) => n.startsWith("synthesis_state_rebuilding")),
      `notes=${JSON.stringify(dataC.health_notes)}`,
    );
    check(
      "corrupt state serves the last-known-good synthesis_coverage with its built_at watermark",
      JSON.stringify(dataC.synthesis_coverage) === JSON.stringify(dataB.synthesis_coverage),
      "served coverage differs from the last-known-good envelope",
    );
    check(
      "corrupt state serves the last-known-good drift_alerts with its built_at watermark",
      JSON.stringify(dataC.drift_alerts) === JSON.stringify(dataB.drift_alerts),
      "served drift differs from the last-known-good envelope",
    );
    check(
      "corrupt state schedules a rebuild off the handler",
      scheduledC.length === 1,
      `scheduled=${JSON.stringify(scheduledC)}`,
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 6 (H2b): in-process envelope cache + zero-delta fast path.
//
// The cache sits ABOVE the compute seam (computeCoverageFromState /
// computeDriftFromState): a repeat call with an unchanged reducer state,
// untouched ledgers (same size+mtimeMs), and the same now-bucket must serve
// the previously computed envelopes VERBATIM — including their built_at,
// which is the truth of when the numbers were computed — without invoking
// the computes or the fold. Any of (ledger append, now-bucket rollover)
// must invalidate. The zero-delta fast path is separate: when stat shows no
// bytes appended past the verified checkpoint eof, updateStateFromLedgers is
// skipped entirely even on a cache MISS (the computes still run their own
// requireVerifiedCheckpoint, so no unverified numbers). Spies via the
// buildHealthData opts seams prove both skips. Fixture ledgers only.
// ---------------------------------------------------------------------------
{
  const tmpRoot = mkdtempSync(join(tmpdir(), "memory-health-envcache-"));
  try {
    const sourcesDir = join(tmpRoot, "storage", "sources");
    mkdirSync(sourcesDir, { recursive: true });
    const stateDir = join(tmpRoot, "health-reducer-state");
    const statePath = join(stateDir, "state.json");
    const memPath = join(tmpRoot, "memory.jsonl");
    const recPath = join(tmpRoot, "recall.jsonl");

    const ts = "2026-06-30T00:00:00.000Z"; // inside the 7-day coverage window
    const factRow = (entity) =>
      JSON.stringify({
        kind: "fact",
        ts,
        features: {
          entities: [entity],
          time_anchors: ["2026-06-30"],
          valence: 0.5,
          episodicity: 0.2,
          entity_extractor_version: "v1",
        },
      });
    writeFileSync(memPath, factRow("alpha") + "\n");
    writeFileSync(
      recPath,
      JSON.stringify({
        kind: "recall",
        ts,
        populator: { entities_count: 1, inferred_mood_sign: 1, query_episodicity: 0.4 },
      }) + "\n",
    );

    // Steady-state precondition: healthy persisted reducer state, caught up
    // to the ledger tails (zero pending bytes) — the production warm shape.
    const { state } = updateStateFromLedgers(null, { ledgerPath: memPath, recallLogPath: recPath });
    mkdirSync(stateDir, { recursive: true });
    saveReducerState(statePath, state);

    const counters = { coverage: 0, drift: 0, fold: 0 };
    const scheduled = [];
    const baseOpts = {
      sourcesDir,
      memoryLedgerPath: memPath,
      recallLogPath: recPath,
      healthStateDir: stateDir,
      // Generous inline budget: the 6d append below must fold INLINE (the
      // degrade path is test 5's subject, not this test's).
      inlineFoldMaxBytes: 1024 * 1024,
      envelopeCacheBucketMs: 60_000,
      scheduleRebuild: (req) => scheduled.push(req),
      computeCoverage: (...a) => {
        counters.coverage += 1;
        return computeCoverageFromState(...a);
      },
      computeDrift: (...a) => {
        counters.drift += 1;
        return computeDriftFromState(...a);
      },
      updateState: (...a) => {
        counters.fold += 1;
        return updateStateFromLedgers(...a);
      },
    };

    const now1 = new Date("2026-07-01T12:00:00.000Z"); // bucket B
    const now2 = new Date("2026-07-01T12:00:30.000Z"); // bucket B (+30s)
    const now3 = new Date("2026-07-01T12:01:30.000Z"); // bucket B+1

    // -- 6a: call #1 computes; zero-delta fast path skips the fold.
    const data1 = await buildHealthData({ ...baseOpts, now: now1 });
    check(
      "call #1 computes both envelopes (cache cold)",
      counters.coverage === 1 && counters.drift === 1,
      `coverage=${counters.coverage} drift=${counters.drift}`,
    );
    check(
      "call #1 zero-delta fast path skips updateStateFromLedgers",
      counters.fold === 0,
      `fold invoked ${counters.fold} times`,
    );
    check(
      "call #1 serves healthy reducer numbers (facts_in_window=1)",
      data1.synthesis_coverage !== null && data1.synthesis_coverage.facts_in_window === 1,
      `got ${JSON.stringify(data1.synthesis_coverage)}`,
    );

    // -- 6b: RED-FIRST — call #2 (same state, same now-bucket, untouched
    //        ledgers) must NOT invoke computeCoverageFromState.
    const data2 = await buildHealthData({ ...baseOpts, now: now2 });
    check(
      "cache hit: call #2 does NOT invoke computeCoverageFromState",
      counters.coverage === 1,
      `coverage invoked ${counters.coverage} times (expected 1)`,
    );
    check(
      "cache hit: call #2 does NOT invoke computeDriftFromState",
      counters.drift === 1,
      `drift invoked ${counters.drift} times (expected 1)`,
    );
    check(
      "cache hit: call #2 does NOT fold",
      counters.fold === 0,
      `fold invoked ${counters.fold} times`,
    );
    check(
      "cache hit serves field-identical synthesis_coverage INCLUDING the cached built_at",
      JSON.stringify(data2.synthesis_coverage) === JSON.stringify(data1.synthesis_coverage),
      `call#1=${JSON.stringify(data1.synthesis_coverage)} call#2=${JSON.stringify(data2.synthesis_coverage)}`,
    );
    check(
      "cache hit serves field-identical drift_alerts INCLUDING the cached built_at",
      JSON.stringify(data2.drift_alerts) === JSON.stringify(data1.drift_alerts),
      `call#1=${JSON.stringify(data1.drift_alerts)} call#2=${JSON.stringify(data2.drift_alerts)}`,
    );
    check(
      "cached built_at is the compute-time watermark (call #1's now), never fabricated fresh",
      data2.synthesis_coverage !== null && data2.synthesis_coverage.built_at === now1.toISOString(),
      `got ${data2.synthesis_coverage?.built_at}`,
    );
    check(
      "time_now stays live on a cache hit",
      data2.time_now === now2.toISOString(),
      `got ${data2.time_now}`,
    );
    check(
      "cache-hit response keeps the AUTHORITATIVE field set closed",
      JSON.stringify(Object.keys(data2).sort()) === JSON.stringify([...AUTHORITATIVE_FIELDS].sort()),
      `actual=${JSON.stringify(Object.keys(data2).sort())}`,
    );

    // A consumer mutating a served envelope must never poison the cache.
    if (data2.synthesis_coverage !== null) data2.synthesis_coverage.facts_in_window = 999;
    const data2b = await buildHealthData({ ...baseOpts, now: now2 });
    check(
      "consumer mutation cannot poison the cache",
      data2b.synthesis_coverage !== null && data2b.synthesis_coverage.facts_in_window === 1,
      `got ${JSON.stringify(data2b.synthesis_coverage)}`,
    );
    check(
      "mutation-probe call was itself a cache hit",
      counters.coverage === 1,
      `coverage invoked ${counters.coverage} times`,
    );

    // -- 6c: now-bucket rollover invalidates (rolling-window honesty).
    const data3 = await buildHealthData({ ...baseOpts, now: now3 });
    check(
      "now-bucket rollover invalidates the cache (coverage recomputed)",
      counters.coverage === 2,
      `coverage invoked ${counters.coverage} times (expected 2)`,
    );
    check(
      "rollover recompute carries a fresh built_at",
      data3.synthesis_coverage !== null && data3.synthesis_coverage.built_at === now3.toISOString(),
      `got ${data3.synthesis_coverage?.built_at}`,
    );
    check(
      "rollover recompute still skips the fold (ledgers untouched)",
      counters.fold === 0,
      `fold invoked ${counters.fold} times`,
    );

    // -- 6d: a state change (appended ledger row) invalidates.
    writeFileSync(memPath, factRow("beta") + "\n", { flag: "a" });
    const data4 = await buildHealthData({ ...baseOpts, now: now3 });
    check(
      "ledger append invalidates the cache (coverage recomputed)",
      counters.coverage === 3,
      `coverage invoked ${counters.coverage} times (expected 3)`,
    );
    check(
      "ledger append triggers the inline delta fold",
      counters.fold === 1,
      `fold invoked ${counters.fold} times (expected 1)`,
    );
    check(
      "recomputed envelope reflects the appended row (facts_in_window=2)",
      data4.synthesis_coverage !== null && data4.synthesis_coverage.facts_in_window === 2,
      `got ${JSON.stringify(data4.synthesis_coverage)}`,
    );

    // Healthy recompute repopulates: the next same-bucket call hits again.
    const data5 = await buildHealthData({ ...baseOpts, now: now3 });
    check(
      "healthy recompute repopulates the cache (next same-bucket call hits)",
      counters.coverage === 3 &&
        JSON.stringify(data5.synthesis_coverage) === JSON.stringify(data4.synthesis_coverage),
      `coverage=${counters.coverage}`,
    );
    check(
      "no rebuild was ever scheduled on the healthy/cached paths",
      scheduled.length === 0,
      `scheduled=${JSON.stringify(scheduled)}`,
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 7 (Finding 2): the rebuild marker is an EXCLUSIVE O_EXCL single-claim
// gate. Two concurrent scheduleReducerStateRebuild invocations against one
// markerPath spawn EXACTLY ONE child (the loser backs off on the live-pid
// marker); a stale marker (aged mtime OR dead pid) is reclaimed and a fresh
// rebuild spawns; the finishing child clears only its own pid-matched marker.
// The injected spawn spy proves single-spawn without launching real processes.
// ---------------------------------------------------------------------------
{
  const tmpRoot = mkdtempSync(join(tmpdir(), "memory-health-marker-"));
  try {
    const stateDir = join(tmpRoot, "health-reducer-state");
    const statePath = join(stateDir, "state.json");
    const markerPath = join(stateDir, "rebuild.pending");
    const memPath = join(tmpRoot, "memory.jsonl");
    const recPath = join(tmpRoot, "recall.jsonl");
    writeFileSync(memPath, JSON.stringify({ kind: "fact", ts: "2026-06-30T00:00:00.000Z", features: {} }) + "\n");
    writeFileSync(recPath, JSON.stringify({ kind: "recall", ts: "2026-06-30T00:00:00.000Z", populator: {} }) + "\n");
    const req = { stateDir, statePath, markerPath, ledgerPath: memPath, recallLogPath: recPath };

    let spawnCalls = 0;
    const spy = () => {
      spawnCalls += 1;
      return { unref() {} };
    };

    // Two concurrent invocations => exactly ONE spawn (loser backs off).
    scheduleReducerStateRebuild(req, spy);
    scheduleReducerStateRebuild(req, spy);
    check(
      "two concurrent scheduleReducerStateRebuild spawn exactly ONE rebuild child",
      spawnCalls === 1,
      `spawnCalls=${spawnCalls}`,
    );
    let marker = JSON.parse(readFileSync(markerPath, "utf8"));
    check(
      "winner's O_EXCL marker carries its own pid ownership token",
      marker.pid === process.pid,
      `marker.pid=${marker.pid}`,
    );

    // Aged marker (mtime older than REBUILD_MARKER_TTL_MS) => stale-reclaimed.
    const aged = new Date(Date.now() - 30 * 60 * 1000); // > 15min TTL
    utimesSync(markerPath, aged, aged);
    scheduleReducerStateRebuild(req, spy);
    check(
      "aged marker is stale-reclaimed and a fresh rebuild spawns",
      spawnCalls === 2,
      `spawnCalls=${spawnCalls}`,
    );

    // Dead-pid marker (fresh mtime) => reclaimed via pid-liveness, not age.
    writeFileSync(markerPath, JSON.stringify({ pid: 999999, requested_at: new Date().toISOString() }) + "\n", { mode: 0o600 });
    scheduleReducerStateRebuild(req, spy);
    check(
      "dead-pid marker is stale-reclaimed and a fresh rebuild spawns",
      spawnCalls === 3,
      `spawnCalls=${spawnCalls}`,
    );

    // Live-pid + fresh marker: NO reclaim, NO spawn (the loser backs off).
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
    check(
      "post-reclaim marker again carries our live pid",
      marker.pid === process.pid,
      `marker.pid=${marker.pid}`,
    );
    scheduleReducerStateRebuild(req, spy);
    check(
      "a live, fresh marker blocks a duplicate spawn",
      spawnCalls === 3,
      `spawnCalls=${spawnCalls}`,
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 8 (Finding 1): one envelope-cache-miss health call verifies each
// ledger's prefix ONCE, not ~10x. createHash counts the sampled witness hashes
// (verifyPrefix is the only hasher on the compute path); the per-call verify
// memo drives the two compute functions to skip their re-verifies, so a
// zero-delta warm call hashes exactly twice (planReducerFold, one per ledger).
// Distinct fixture paths guarantee an envelope-cache MISS. Fixture ledgers only.
// ---------------------------------------------------------------------------
{
  const tmpRoot = mkdtempSync(join(tmpdir(), "memory-health-verifydedup-"));
  try {
    const sourcesDir = join(tmpRoot, "storage", "sources");
    mkdirSync(sourcesDir, { recursive: true });
    const stateDir = join(tmpRoot, "health-reducer-state");
    const statePath = join(stateDir, "state.json");
    const memPath = join(tmpRoot, "memory.jsonl");
    const recPath = join(tmpRoot, "recall.jsonl");
    const ts = "2026-06-30T00:00:00.000Z";
    writeFileSync(memPath, JSON.stringify({ kind: "fact", ts, features: { entities: ["a"], entity_extractor_version: "v1" } }) + "\n");
    writeFileSync(recPath, JSON.stringify({ kind: "recall", ts, populator: { entities_count: 1, inferred_mood_sign: 1, query_episodicity: 0.4 } }) + "\n");
    // Healthy persisted state caught up to the tails (zero-delta warm shape).
    const { state } = updateStateFromLedgers(null, { ledgerPath: memPath, recallLogPath: recPath });
    mkdirSync(stateDir, { recursive: true });
    saveReducerState(statePath, state);

    const opts = {
      sourcesDir,
      memoryLedgerPath: memPath,
      recallLogPath: recPath,
      healthStateDir: stateDir,
      now: new Date("2026-07-01T12:00:00.000Z"),
      inlineFoldMaxBytes: 1024 * 1024,
      scheduleRebuild: () => {},
    };

    hashCalls = 0;
    hashCounting = true;
    const data = await buildHealthData(opts);
    hashCounting = false;

    check(
      "one cache-miss zero-delta health call verifies each ledger ONCE (2 witness hashes, not ~10x)",
      hashCalls === 2,
      `createHash calls=${hashCalls}`,
    );
    check(
      "verify-dedup call serves healthy reducer numbers (facts_in_window=1)",
      data.synthesis_coverage !== null && data.synthesis_coverage.facts_in_window === 1,
      `got ${JSON.stringify(data.synthesis_coverage)}`,
    );
    check(
      "verify-dedup call is NOT degraded",
      !data.health_notes.some((n) => n.startsWith("synthesis_state_rebuilding")),
      `notes=${JSON.stringify(data.health_notes)}`,
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll memory_health real-data checks passed.");
