// F-SYN-OPERATIONAL-synthesis-coverage-probe — unit + integration test.
//
// Asserts the synthesis-coverage probe's contract:
//   - Mixed coverage on the cascade ledger yields the right populated/empty/pct
//     breakdown across all four feature stamps (entities, time_anchors,
//     valence, episodicity).
//   - Window filter excludes facts whose ts falls outside [now-windowDays, now].
//   - Missing features / malformed rows / missing files DEGRADE rather than
//     throw (defensive contract, mirrors the W2 + W7 probe discipline).
//   - Recall-side coverage walks recall.jsonl and counts the populator block.
//   - memory_health surfaces synthesis_coverage as a top-level projection in
//     the response envelope (closed-block conformance is asserted in
//     test/health-real-data.test.mjs; here we assert the wiring + the
//     shape of the projection).
//
// Discipline:
//   - HERMETIC: env vars + tmpdir BEFORE any dynamic import that touches
//     config.js (matches the W2-W9 hermeticity pattern).
//   - node:test + node:assert/strict.
//   - At least 8 assertions.
//
// Run:
//   node --test test/synthesis/coverage-probe.test.mjs

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

// -----------------------------------------------------------------------------
// Hermetic env. MUST be set BEFORE any dynamic import touches config.js so the
// ledger / policy paths land under TMP_ROOT.
// -----------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-syn-coverage-probe-"));
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
let coverageProbeMod;
let healthMod;
try {
  coverageProbeMod = await import("../../lib/synthesis/coverage-probe.js");
  healthMod = await import("../../lib/tools/health.js");
} catch (err) {
  console.error("FATAL: module import failed:", err);
  process.exit(1);
}

const { computeSynthesisCoverage, DEFAULT_WINDOW_DAYS } = coverageProbeMod;
const { buildHealthData } = healthMod;

// Helper: write JSONL rows to a file. Each row is a row object; this is
// append-mode-equivalent (the writer uses writeFileSync with overwrite
// semantics per test). We pre-format the lines deliberately so the probe
// has to parse the same on-disk layout the daemon writes.
function writeJsonl(path, rows) {
  const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path, text, { mode: 0o600 });
}

// Clock anchor used across tests. Fixed so window-filter assertions are
// deterministic. The probe defaults to a 7-day window; we set NOW such
// that "1 day ago" is in-window and "30 days ago" is out-of-window.
const NOW = new Date("2026-06-17T12:00:00Z");
const inWindow1d = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
const inWindow3d = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
const outOfWindow30d = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

// Fixture: a fact row with all four stamps populated.
function factFullyStamped(id, ts) {
  return {
    id,
    kind: "fact",
    ts,
    content: "fully-stamped fact",
    features: {
      entities: [{ canonical_id: "project:git-log:foo", kind: "project" }],
      entity_extractor_version: "v0.1.0",
      time_anchors: [
        { instant_iso: ts, kind: "explicit", resolver: "test" },
      ],
      time_anchor_resolver_version: "v0.2.0",
      // PRODUCTION SHAPE. scoreValence returns — and the cascade persists
      // verbatim — the structured object, not a scalar; see
      // mcp/lib/tools/distill-promote-fact.js:992 ("the object is the
      // authoritative on-disk shape"). This fixture previously carried the
      // pre-migration scalar 0.3, so the probe's `typeof === "number"` test
      // passed here while reporting 0% valence coverage against every real
      // ledger. Keep this in the production shape; T1b pins the legacy
      // scalar separately.
      valence: {
        sign: -1,
        magnitude: 0.13736056394868904,
        source: "lexicon",
        model_version: "lexicon-v1",
      },
      valence_model_version: "v0.1.0",
      episodicity: 0.8,
      episodicity_version: "v0.1.0",
    },
  };
}

// Fixture: a fact row with NO stamps (the cascade silently degraded across
// every axis — operator should see 0% coverage when this happens).
function factEmptyStamps(id, ts) {
  return {
    id,
    kind: "fact",
    ts,
    content: "no-stamp fact",
    features: {
      entities: [],
      time_anchors: [],
      valence: null,
      episodicity: null,
    },
  };
}

// Fixture: a fact row with PARTIAL stamps. Entities populated but valence
// + episodicity null. Models the regression we're trying to detect.
function factPartialStamps(id, ts) {
  return {
    id,
    kind: "fact",
    ts,
    content: "partial-stamp fact",
    features: {
      entities: [{ canonical_id: "topic:test:bar", kind: "topic" }],
      entity_extractor_version: "v0.1.0",
      time_anchors: [],
      valence: null,
      episodicity: null,
    },
  };
}

// Fixture: a recall event with full populator block.
function recallFullyPopulated(id, ts) {
  return {
    id,
    ts,
    kind: "recall",
    populator: {
      version: "v1",
      entity_extractor_version: "v0.1.0",
      time_anchor_resolver_version: "v0.2.0",
      valence_model_version: "v0.1.0",
      episodicity_version: "v0.1.0",
      degraded: false,
      degraded_reasons: [],
      entities_count: 3,
      time_anchors_count: 1,
      inferred_mood_sign: 0.5,
      has_time_anchor: true,
      query_episodicity: 0.7,
    },
    degraded_recall: false,
  };
}

// Fixture: a recall event whose populator never ran (degraded path).
function recallDegraded(id, ts) {
  return {
    id,
    ts,
    kind: "recall",
    populator: {
      version: "v1",
      degraded: true,
      degraded_reasons: ["embedding_failure"],
      entities_count: 0,
      time_anchors_count: 0,
      inferred_mood_sign: 0,
      has_time_anchor: false,
      query_episodicity: null,
    },
    degraded_recall: true,
  };
}

const LEDGER_PATH = join(TMP_ROOT, "ledgers", "memory.jsonl");
const RECALL_PATH = join(TMP_ROOT, "ledgers", "recall.jsonl");

// ---------------------------------------------------------------------------
// T1 — mixed-coverage cascade ledger yields the right per-axis breakdown.
//
// Two facts fully stamped, one partially stamped, one empty. Expected:
//   entity_coverage:      3 / 4 populated (full + full + partial = 3)
//   time_anchor_coverage: 2 / 4 populated (full + full)
//   valence_coverage:     2 / 4 populated
//   episodicity_coverage: 2 / 4 populated
// ---------------------------------------------------------------------------
test("T1: mixed coverage on the cascade ledger yields correct per-axis breakdown", async () => {
  writeJsonl(LEDGER_PATH, [
    factFullyStamped("m1", inWindow1d),
    factFullyStamped("m2", inWindow1d),
    factPartialStamps("m3", inWindow1d),
    factEmptyStamps("m4", inWindow1d),
  ]);
  writeJsonl(RECALL_PATH, []);

  const snap = await computeSynthesisCoverage({
    ledgerPath: LEDGER_PATH,
    recallLogPath: RECALL_PATH,
    now: NOW,
  });

  assert.equal(snap.facts_in_window, 4, "all four facts in window");
  assert.equal(snap.entity_coverage.populated, 3, "3 facts have entities");
  assert.equal(snap.entity_coverage.empty, 1, "1 fact lacks entities");
  assert.equal(snap.entity_coverage.pct, 0.75, "entity_coverage pct = 75%");
  assert.equal(
    snap.time_anchor_coverage.populated,
    2,
    "2 facts have time_anchors",
  );
  assert.equal(snap.time_anchor_coverage.pct, 0.5, "time_anchor pct = 50%");
  assert.equal(snap.valence_coverage.populated, 2, "2 facts have valence");
  assert.equal(snap.episodicity_coverage.populated, 2, "2 facts have episodicity");
});

// ---------------------------------------------------------------------------
// T1b — valence shape regression.
//
// features.valence is written as the structured object
// {sign, magnitude, source, model_version}; the [-1,+1] scalar is only ever
// a factValenceScalar projection applied at index time. The probe once
// tested `typeof f.valence === "number"`, which no object satisfies, so
// valence_coverage read 0% on every real window while valence_model_version
// was stamped on every fact row. Both fixtures in this suite carried the
// pre-migration scalar, so nothing caught it.
//
// Pins all four cases: production object, legacy scalar (back-compat),
// null degrade, and a malformed object with no usable sign. Neutral
// sign 0 counts as POPULATED — presence semantics, matching the sibling
// episodicity axis, which counts a 0 scalar.
// ---------------------------------------------------------------------------
test("T1b: valence coverage counts the production object shape, not just scalars", async () => {
  const withValence = (id, valence) => ({
    id,
    kind: "fact",
    ts: inWindow1d,
    content: "valence shape probe",
    features: { entities: [], time_anchors: [], valence, episodicity: null },
  });

  writeJsonl(LEDGER_PATH, [
    withValence("obj", {
      sign: -1,
      magnitude: 0.137,
      source: "lexicon",
      model_version: "lexicon-v1",
    }),
    withValence("obj-neutral", {
      sign: 0,
      magnitude: 0,
      source: "lexicon",
      model_version: "lexicon-v1",
    }),
    withValence("legacy-scalar", 0.3),
    withValence("degraded-null", null),
    withValence("malformed", { magnitude: 0.5, source: "lexicon" }),
  ]);
  writeJsonl(RECALL_PATH, []);

  const snap = await computeSynthesisCoverage({
    ledgerPath: LEDGER_PATH,
    recallLogPath: RECALL_PATH,
    now: NOW,
  });

  assert.equal(snap.facts_in_window, 5, "all five rows in window");
  assert.equal(
    snap.valence_coverage.populated,
    3,
    "object + neutral object + legacy scalar are populated",
  );
  assert.equal(
    snap.valence_coverage.empty,
    2,
    "null degrade and sign-less object are not populated",
  );
});

// ---------------------------------------------------------------------------
// T2 — rolling-window filter: facts whose ts is outside [now-windowDays, now]
// MUST NOT count toward the denominators. This is the core operator-visible
// signal — without it, a degraded yesterday looks identical to a degraded
// last year.
// ---------------------------------------------------------------------------
test("T2: window filter excludes facts outside [now - windowDays, now]", async () => {
  writeJsonl(LEDGER_PATH, [
    factFullyStamped("m1", inWindow1d),
    factFullyStamped("m2", outOfWindow30d), // 30 days ago — out of 7-day window
    factEmptyStamps("m3", outOfWindow30d),
  ]);
  writeJsonl(RECALL_PATH, []);

  const snap = await computeSynthesisCoverage({
    ledgerPath: LEDGER_PATH,
    recallLogPath: RECALL_PATH,
    now: NOW,
    windowDays: 7,
  });

  assert.equal(snap.facts_in_window, 1, "only the in-window fact counts");
  assert.equal(snap.entity_coverage.populated, 1, "the in-window fact is fully stamped");
  assert.equal(snap.entity_coverage.pct, 1.0, "100% coverage on the single in-window fact");
  assert.equal(snap.window_days, 7, "window_days mirrors the request");
});

// ---------------------------------------------------------------------------
// T3 — defensive degradation:
//   - missing features → counted as not-populated, not crash
//   - malformed JSON line → silently skipped
//   - missing ledger file → facts_in_window = 0 (no throw)
// ---------------------------------------------------------------------------
test("T3: missing features / malformed rows / missing file degrade safely", async () => {
  // Hand-write the ledger so we can mix a malformed line in.
  const goodRow = factFullyStamped("m1", inWindow1d);
  const featurelessRow = {
    id: "m2",
    kind: "fact",
    ts: inWindow1d,
    content: "no features slot at all",
    // features intentionally omitted
  };
  const text =
    JSON.stringify(goodRow) +
    "\n" +
    JSON.stringify(featurelessRow) +
    "\n" +
    "this is not json\n";
  writeFileSync(LEDGER_PATH, text, { mode: 0o600 });
  writeJsonl(RECALL_PATH, []);

  const snap = await computeSynthesisCoverage({
    ledgerPath: LEDGER_PATH,
    recallLogPath: RECALL_PATH,
    now: NOW,
  });

  // The featureless row has kind:"fact" + features:undefined, so it counts
  // toward facts_in_window but is "empty" across every axis (defensive
  // contract: missing fields → not-populated, not crash). The malformed
  // line is silently skipped.
  assert.equal(
    snap.facts_in_window,
    2,
    "good row + featureless row count; malformed line is dropped",
  );
  assert.equal(
    snap.entity_coverage.populated,
    1,
    "only the well-formed row has entities",
  );
  assert.equal(
    snap.entity_coverage.empty,
    1,
    "featureless row is counted as not-populated (defensive degrade)",
  );

  // Missing ledger path → empty snapshot, no throw.
  const snap2 = await computeSynthesisCoverage({
    ledgerPath: join(TMP_ROOT, "ledgers", "does-not-exist.jsonl"),
    recallLogPath: RECALL_PATH,
    now: NOW,
  });
  assert.equal(snap2.facts_in_window, 0, "missing ledger → 0 facts (no throw)");
  assert.equal(
    snap2.entity_coverage.pct,
    0,
    "missing ledger → 0% coverage (no division by zero)",
  );
});

// ---------------------------------------------------------------------------
// T4 — recall ledger coverage: counts populator block entries.
// ---------------------------------------------------------------------------
test("T4: recall ledger coverage reflects populator block", async () => {
  writeJsonl(LEDGER_PATH, []);
  writeJsonl(RECALL_PATH, [
    recallFullyPopulated("r1", inWindow1d),
    recallFullyPopulated("r2", inWindow3d),
    recallDegraded("r3", inWindow1d),
  ]);

  const snap = await computeSynthesisCoverage({
    ledgerPath: LEDGER_PATH,
    recallLogPath: RECALL_PATH,
    now: NOW,
  });

  assert.equal(snap.recall_population.recalls_in_window, 3, "all 3 recalls in window");
  // 2 of 3 have non-empty entities_count
  assert.ok(
    snap.recall_population.non_empty_entities_pct > 0.6 &&
      snap.recall_population.non_empty_entities_pct < 0.7,
    `non_empty_entities_pct ~= 2/3, got ${snap.recall_population.non_empty_entities_pct}`,
  );
  // 1 of 3 was degraded
  assert.ok(
    snap.recall_population.degraded_recall_pct > 0.3 &&
      snap.recall_population.degraded_recall_pct < 0.4,
    `degraded_recall_pct ~= 1/3, got ${snap.recall_population.degraded_recall_pct}`,
  );
});

// ---------------------------------------------------------------------------
// T5 — extractor_versions histogram captures version drift across the window.
// ---------------------------------------------------------------------------
test("T5: extractor_versions histogram captures version drift", async () => {
  const f1 = factFullyStamped("m1", inWindow1d);
  const f2 = factFullyStamped("m2", inWindow1d);
  // Pin m2 to a newer extractor version to model a mid-window upgrade.
  f2.features.entity_extractor_version = "v0.2.0";
  writeJsonl(LEDGER_PATH, [f1, f2]);
  writeJsonl(RECALL_PATH, []);

  const snap = await computeSynthesisCoverage({
    ledgerPath: LEDGER_PATH,
    recallLogPath: RECALL_PATH,
    now: NOW,
  });

  const eevH = snap.extractor_versions.entity_extractor_version;
  assert.equal(
    eevH["v0.1.0"],
    1,
    `expected 1 row on v0.1.0, got ${JSON.stringify(eevH)}`,
  );
  assert.equal(
    eevH["v0.2.0"],
    1,
    `expected 1 row on v0.2.0, got ${JSON.stringify(eevH)}`,
  );
});

// ---------------------------------------------------------------------------
// T6 — memory_health includes synthesis_coverage in its response envelope.
//
// The contract: synthesis_coverage is a top-level field on the health envelope
// (or null if the probe is unreachable). Tests against the buildHealthData
// shape so the response keys match the AUTHORITATIVE FIELD SET spec.
// ---------------------------------------------------------------------------
test("T6: memory_health includes synthesis_coverage projection", async () => {
  writeJsonl(LEDGER_PATH, [
    factFullyStamped("m1", inWindow1d),
    factEmptyStamps("m2", inWindow1d),
  ]);
  writeJsonl(RECALL_PATH, [recallFullyPopulated("r1", inWindow1d)]);

  const data = await buildHealthData({
    sourcesDir: join(TMP_ROOT, "storage", "sources"),
    memoryLedgerPath: LEDGER_PATH,
    recallLogPath: RECALL_PATH,
    now: NOW,
  });

  assert.ok(
    "synthesis_coverage" in data,
    "buildHealthData response carries synthesis_coverage key",
  );
  assert.notEqual(
    data.synthesis_coverage,
    null,
    "synthesis_coverage is non-null on the happy path",
  );
  assert.equal(
    data.synthesis_coverage.facts_in_window,
    2,
    "synthesis_coverage.facts_in_window = 2",
  );
  assert.equal(
    data.synthesis_coverage.entity_coverage.pct,
    0.5,
    "entity_coverage pct = 50% (1 of 2)",
  );
  assert.equal(
    data.synthesis_coverage.recall_population.recalls_in_window,
    1,
    "recall_population.recalls_in_window = 1",
  );
});

// ---------------------------------------------------------------------------
// T7 — DEFAULT_WINDOW_DAYS export is the documented 7.
// Operators threading this through dashboards rely on the constant.
// ---------------------------------------------------------------------------
test("T7: DEFAULT_WINDOW_DAYS is the documented 7", () => {
  assert.equal(DEFAULT_WINDOW_DAYS, 7, "DEFAULT_WINDOW_DAYS = 7");
});

// ---------------------------------------------------------------------------
// T8 — pct denominator uses facts_in_window, not the ledger total. A fact
// outside the window MUST NOT inflate or deflate the denominator.
// ---------------------------------------------------------------------------
test("T8: pct denominator uses facts_in_window, not total ledger rows", async () => {
  writeJsonl(LEDGER_PATH, [
    factFullyStamped("m1", inWindow1d),
    factFullyStamped("m2", inWindow1d),
    // Out of window — must not inflate the denominator
    factEmptyStamps("m3", outOfWindow30d),
    factEmptyStamps("m4", outOfWindow30d),
  ]);
  writeJsonl(RECALL_PATH, []);

  const snap = await computeSynthesisCoverage({
    ledgerPath: LEDGER_PATH,
    recallLogPath: RECALL_PATH,
    now: NOW,
  });

  assert.equal(snap.facts_in_window, 2, "only 2 facts in window");
  assert.equal(
    snap.entity_coverage.pct,
    1.0,
    "pct = 100% (both in-window facts are stamped); out-of-window empties are not denominator",
  );
});
