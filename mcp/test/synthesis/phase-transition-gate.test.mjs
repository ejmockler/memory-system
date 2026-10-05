// phase-transition-gate.test.mjs — operational-tier coverage for the
// phase-transition gate (F-SYN-OPERATIONAL-phase-transition-criteria).
//
// Pins the v0→v1 / v1→v2 / v2→v3 / v3→v4 criteria from
// docs/specs/synthesis/phase-transition-criteria.md.
//
// Coverage (per spec § 12):
//   - v0→v1 with no labels file → can_advance:false
//   - v0→v1 with 200 labels → can_advance:true
//   - v0→v1 with 149 labels → can_advance:false (just-below-floor)
//   - v1→v2 with NDCG below +0.03 floor → can_advance:false
//   - v1→v2 with NDCG meeting criterion + CI excludes zero + harm not worse
//   - v1→v2 with NDCG ≥ +0.03 BUT CI includes zero → can_advance:false
//   - v1→v2 with NDCG ≥ +0.03 BUT harm rate worse → can_advance:false
//   - v2→v3 with engagement volume below 200/week → can_advance:false
//   - v2→v3 with engagement volume ≥ 200 AND window ≥ 8 → can_advance:true
//   - v3→v4 → can_advance:false with code:"TRANSITION_DEFERRED"
//   - Unknown phase pair throws PHASE_TRANSITION_BAD_TRANSITION
//   - VERSION exported as semver string
//   - CAPS frozen + contains every numeric threshold
//
// Run: node test/synthesis/phase-transition-gate.test.mjs

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermeticity: set MEMORY_ROOT before the dynamic import.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-ptg-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
const LEDGERS_DIR = join(MEMORY_ROOT, "ledgers");
const POLICY_DIR = join(MEMORY_ROOT, "policy");
mkdirSync(LEDGERS_DIR, { recursive: true });
mkdirSync(POLICY_DIR, { recursive: true });
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;

const {
  PHASE_TRANSITION_GATE_VERSION,
  PHASE_TRANSITION_GATE_CAPS,
  HARD_CRITERIA,
  evaluatePhaseTransition,
  _internals,
} = await import("../../lib/synthesis/phase-transition-gate.js");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

function assertEqual(actual, expected, msg) {
  const ok = actual === expected;
  if (ok) passed++;
  else {
    failed++;
    console.error(
      `FAIL: ${msg}\n   actual:   ${JSON.stringify(actual)}\n   expected: ${JSON.stringify(expected)}`,
    );
  }
}

async function assertThrowsAsync(fn, codeWanted, msg) {
  try {
    await fn();
  } catch (e) {
    if (codeWanted && e.code !== codeWanted) {
      failed++;
      console.error(`FAIL: ${msg} (expected code ${codeWanted}, got ${e.code})`);
      return;
    }
    passed++;
    return;
  }
  failed++;
  console.error(`FAIL: ${msg} (expected throw, none raised)`);
}

// ===========================================================================
// 1. VERSION + CAPS invariants
// ===========================================================================

assert(
  typeof PHASE_TRANSITION_GATE_VERSION === "string"
    && /^v\d+\.\d+\.\d+$/.test(PHASE_TRANSITION_GATE_VERSION),
  "PHASE_TRANSITION_GATE_VERSION is a semver string",
);

assert(
  Object.isFrozen(PHASE_TRANSITION_GATE_CAPS),
  "PHASE_TRANSITION_GATE_CAPS is frozen (invariant 2)",
);

assertEqual(
  PHASE_TRANSITION_GATE_CAPS.LABEL_SET_FLOOR,
  150,
  "CAPS.LABEL_SET_FLOOR pinned at 150",
);
assertEqual(
  PHASE_TRANSITION_GATE_CAPS.NDCG_DELTA_FLOOR,
  0.03,
  "CAPS.NDCG_DELTA_FLOOR pinned at 0.03",
);
assertEqual(
  PHASE_TRANSITION_GATE_CAPS.ENGAGEMENT_PER_WEEK_FLOOR,
  200,
  "CAPS.ENGAGEMENT_PER_WEEK_FLOOR pinned at 200",
);
assertEqual(
  PHASE_TRANSITION_GATE_CAPS.CALIBRATION_WINDOW_WEEKS_FLOOR,
  8,
  "CAPS.CALIBRATION_WINDOW_WEEKS_FLOOR pinned at 8",
);

assert(
  Array.isArray(HARD_CRITERIA) && HARD_CRITERIA.includes("label_set_size"),
  "HARD_CRITERIA includes label_set_size",
);
assert(
  HARD_CRITERIA.includes("harm_rate_not_worse"),
  "HARD_CRITERIA includes harm_rate_not_worse",
);

// ===========================================================================
// 2. v0 → v1 — no labels file
// ===========================================================================

{
  const result = await evaluatePhaseTransition({
    fromPhase: "v0",
    toPhase: "v1",
    labelsPath: join(TMP_ROOT, "nonexistent-labels.jsonl"),
  });
  assertEqual(result.can_advance, false, "v0->v1 with no labels: can_advance=false");
  assert(
    Array.isArray(result.blocker_reasons) && result.blocker_reasons.length > 0,
    "v0->v1 with no labels: blocker_reasons populated",
  );
  const mentionsLabel = result.blocker_reasons.some((r) => r.includes("label_set_size"));
  assert(mentionsLabel, "v0->v1 with no labels: blocker_reasons mentions label_set_size");
  assertEqual(result.from_phase, "v0", "result.from_phase echoed");
  assertEqual(result.to_phase, "v1", "result.to_phase echoed");
  assertEqual(typeof result.evaluated_at, "string", "result.evaluated_at is string");
  assertEqual(result.version, PHASE_TRANSITION_GATE_VERSION, "result.version stamped");
  // Criteria list always non-empty for a decidable transition
  assert(Array.isArray(result.criteria) && result.criteria.length === 3,
    "v0->v1: 3 criteria reported");
  // label_set_size criterion measured = 0 (file missing)
  const lab = result.criteria.find((c) => c.name === "label_set_size");
  assertEqual(lab.measured, 0, "label_set_size.measured = 0 on missing file");
  assertEqual(lab.threshold, 150, "label_set_size.threshold = 150");
  assertEqual(lab.met, false, "label_set_size.met = false");
}

// ===========================================================================
// 3. v0 → v1 — 200 labels present
// ===========================================================================

function makeLabelsFile(path, n, options = {}) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({
      id: `label-${i}`,
      ts: "2026-06-01T00:00:00.000Z",
      kind: "held_out_label",
      derived_from: [`recall-${i}`],
      payload: { expected_ids: [`mem-${i}`], forbidden_ids: [], abstain: false },
    }));
  }
  if (options.includeCorrupt) {
    lines.push("not a json line");
    lines.push("{broken");
  }
  if (options.includeWrongKind) {
    lines.push(JSON.stringify({ kind: "fact", id: "fact-1" }));
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

{
  const labelsPath = join(LEDGERS_DIR, "labels-200.jsonl");
  makeLabelsFile(labelsPath, 200);
  const result = await evaluatePhaseTransition({
    fromPhase: "v0",
    toPhase: "v1",
    labelsPath,
  });
  assertEqual(result.can_advance, true, "v0->v1 with 200 labels: can_advance=true");
  assert(result.blocker_reasons === undefined,
    "v0->v1 success: blocker_reasons absent");
  const lab = result.criteria.find((c) => c.name === "label_set_size");
  assertEqual(lab.measured, 200, "label_set_size.measured = 200");
  assertEqual(lab.met, true, "label_set_size.met = true");
  // eval-harness import probe should succeed (the module exists in W11)
  const eh = result.criteria.find((c) => c.name === "offline_eval_available");
  assertEqual(eh.met, true, "offline_eval_available.met = true (harness importable)");
}

// ===========================================================================
// 4. v0 → v1 — 149 labels (just-below-floor)
// ===========================================================================

{
  const labelsPath = join(LEDGERS_DIR, "labels-149.jsonl");
  makeLabelsFile(labelsPath, 149);
  const result = await evaluatePhaseTransition({
    fromPhase: "v0",
    toPhase: "v1",
    labelsPath,
  });
  assertEqual(result.can_advance, false, "v0->v1 with 149 labels: can_advance=false");
  const lab = result.criteria.find((c) => c.name === "label_set_size");
  assertEqual(lab.measured, 149, "label_set_size.measured = 149");
  assertEqual(lab.met, false, "label_set_size.met = false at 149 < 150");
}

// ===========================================================================
// 5. v0 → v1 — corrupt + wrong-kind lines skipped
// ===========================================================================

{
  const labelsPath = join(LEDGERS_DIR, "labels-160-mixed.jsonl");
  makeLabelsFile(labelsPath, 160, { includeCorrupt: true, includeWrongKind: true });
  const result = await evaluatePhaseTransition({
    fromPhase: "v0",
    toPhase: "v1",
    labelsPath,
  });
  const lab = result.criteria.find((c) => c.name === "label_set_size");
  assertEqual(lab.measured, 160,
    "label_set_size only counts kind:held_out_label, skips corrupt + wrong-kind");
  assertEqual(result.can_advance, true,
    "v0->v1: corrupt-tolerated 160 labels still passes floor");
}

// ===========================================================================
// 6. v1 → v2 — NDCG below +0.03 floor
// ===========================================================================

{
  const result = await evaluatePhaseTransition({
    fromPhase: "v1",
    toPhase: "v2",
    evalCurrent:  { ndcg_at_12: 0.81, harm_rate: 0.02, bootstrap_ci: { ndcg: [0.01, 0.05] } },
    evalBaseline: { ndcg_at_12: 0.80, harm_rate: 0.02 },
  });
  assertEqual(result.can_advance, false, "v1->v2 NDCG below floor: can_advance=false");
  const uplift = result.criteria.find((c) => c.name === "ndcg_at_12_uplift");
  // measured value is curr - base = 0.01 (within floating-point tolerance)
  assert(Math.abs(uplift.measured - 0.01) < 1e-9,
    `ndcg_at_12_uplift.measured ≈ 0.01 (got ${uplift.measured})`);
  assertEqual(uplift.met, false, "ndcg_at_12_uplift.met = false at 0.01 < 0.03");
  assert(
    result.blocker_reasons.some((r) => r.includes("ndcg_at_12_uplift")),
    "blocker_reasons mentions ndcg_at_12_uplift",
  );
}

// ===========================================================================
// 7. v1 → v2 — NDCG meets criterion (all conditions pass)
// ===========================================================================

{
  const result = await evaluatePhaseTransition({
    fromPhase: "v1",
    toPhase: "v2",
    evalCurrent:  { ndcg_at_12: 0.86, harm_rate: 0.01, bootstrap_ci: { ndcg: [0.04, 0.08] } },
    evalBaseline: { ndcg_at_12: 0.80, harm_rate: 0.02 },
  });
  assertEqual(result.can_advance, true, "v1->v2 NDCG meets: can_advance=true");
  const uplift = result.criteria.find((c) => c.name === "ndcg_at_12_uplift");
  assert(Math.abs(uplift.measured - 0.06) < 1e-9,
    `ndcg_at_12_uplift.measured ≈ 0.06 (got ${uplift.measured})`);
  assertEqual(uplift.met, true, "ndcg_at_12_uplift.met = true at 0.06 >= 0.03");
  const ci = result.criteria.find((c) => c.name === "ndcg_at_12_ci_excludes_zero");
  assertEqual(ci.met, true, "ndcg CI excludes zero: met=true");
  const harm = result.criteria.find((c) => c.name === "harm_rate_not_worse");
  assert(harm.measured <= 0, "harm_rate delta <= 0 (improved)");
  assertEqual(harm.met, true, "harm_rate_not_worse.met = true");
  const ent = result.criteria.find((c) => c.name === "entity_index_wired");
  assertEqual(ent.met, true, "entity_index_wired.met = true (W11 wire)");
  const epi = result.criteria.find((c) => c.name === "episodicity_match_wired");
  assertEqual(epi.met, true, "episodicity_match_wired.met = true (W11 wire)");
}

// ===========================================================================
// 8. v1 → v2 — NDCG ≥ +0.03 BUT CI includes zero → blocked
// ===========================================================================

{
  const result = await evaluatePhaseTransition({
    fromPhase: "v1",
    toPhase: "v2",
    evalCurrent:  { ndcg_at_12: 0.86, harm_rate: 0.01, bootstrap_ci: { ndcg: [-0.01, 0.08] } },
    evalBaseline: { ndcg_at_12: 0.80, harm_rate: 0.02 },
  });
  assertEqual(result.can_advance, false, "v1->v2 CI includes zero: can_advance=false");
  const ci = result.criteria.find((c) => c.name === "ndcg_at_12_ci_excludes_zero");
  assertEqual(ci.met, false, "ndcg_at_12_ci_excludes_zero.met = false");
  assert(
    result.blocker_reasons.some((r) => r.includes("ndcg_at_12_ci_excludes_zero")),
    "blocker_reasons mentions ndcg_at_12_ci_excludes_zero",
  );
}

// ===========================================================================
// 9. v1 → v2 — NDCG ≥ +0.03 BUT harm rate worse → blocked
// ===========================================================================

{
  const result = await evaluatePhaseTransition({
    fromPhase: "v1",
    toPhase: "v2",
    evalCurrent:  { ndcg_at_12: 0.86, harm_rate: 0.05, bootstrap_ci: { ndcg: [0.04, 0.08] } },
    evalBaseline: { ndcg_at_12: 0.80, harm_rate: 0.02 },
  });
  assertEqual(result.can_advance, false, "v1->v2 harm worse: can_advance=false");
  const harm = result.criteria.find((c) => c.name === "harm_rate_not_worse");
  assert(harm.measured > 0, "harm_rate delta > 0 (harm increased)");
  assertEqual(harm.met, false, "harm_rate_not_worse.met = false");
  assert(
    result.blocker_reasons.some((r) => r.includes("harm_rate_not_worse")),
    "blocker_reasons mentions harm_rate_not_worse",
  );
}

// ===========================================================================
// 10. v2 → v3 — engagement volume below 200/week
// ===========================================================================

{
  const result = await evaluatePhaseTransition({
    fromPhase: "v2",
    toPhase: "v3",
    dampingCalibration: {
      weekly_volumes: [50, 60, 70, 80],
      calibration_window_weeks: 4,
    },
    evalCurrent: { bootstrap_ci: { ndcg: [0.04, 0.08] } },
  });
  assertEqual(result.can_advance, false, "v2->v3 low volume: can_advance=false");
  const vol = result.criteria.find((c) => c.name === "engagement_signal_volume_per_week");
  assert(vol.measured < 200, "engagement_signal_volume_per_week below floor");
  assertEqual(vol.met, false, "volume criterion not met");
  const win = result.criteria.find((c) => c.name === "damping_calibration_window_weeks");
  assertEqual(win.met, false, "calibration window of 4 < 8 not met");
}

// ===========================================================================
// 11. v2 → v3 — full criteria met
// ===========================================================================

{
  const result = await evaluatePhaseTransition({
    fromPhase: "v2",
    toPhase: "v3",
    dampingCalibration: {
      weekly_volumes: [220, 240, 230, 260, 245, 270, 250, 235],
      calibration_window_weeks: 9,
    },
    evalCurrent: { bootstrap_ci: { ndcg: [0.04, 0.08] } },
  });
  assertEqual(result.can_advance, true, "v2->v3 full met: can_advance=true");
  const vol = result.criteria.find((c) => c.name === "engagement_signal_volume_per_week");
  assert(vol.measured >= 200, "engagement volume >= 200");
  assertEqual(vol.met, true, "volume criterion met");
  const win = result.criteria.find((c) => c.name === "damping_calibration_window_weeks");
  assertEqual(win.measured, 9, "window measured = 9");
  assertEqual(win.met, true, "window criterion met");
  const ci = result.criteria.find((c) => c.name === "ndcg_at_12_ci_excludes_zero");
  assertEqual(ci.met, true, "ndcg CI excludes zero met");
}

// ===========================================================================
// 12. v3 → v4 — deferred sentinel
// ===========================================================================

{
  const result = await evaluatePhaseTransition({
    fromPhase: "v3",
    toPhase: "v4",
  });
  assertEqual(result.can_advance, false, "v3->v4: can_advance=false (deferred)");
  assertEqual(result.code, "TRANSITION_DEFERRED", "v3->v4: code=TRANSITION_DEFERRED");
  assert(result.criteria.length === 0, "v3->v4: no criteria evaluated");
  assert(Array.isArray(result.blocker_reasons) && result.blocker_reasons.length > 0,
    "v3->v4: blocker_reasons populated");
}

// ===========================================================================
// 13. Unknown / illegal phase pair
// ===========================================================================

await assertThrowsAsync(
  () => evaluatePhaseTransition({ fromPhase: "v0", toPhase: "v2" }),
  "PHASE_TRANSITION_BAD_TRANSITION",
  "unknown pair v0->v2 throws PHASE_TRANSITION_BAD_TRANSITION",
);

await assertThrowsAsync(
  () => evaluatePhaseTransition({ fromPhase: "v1", toPhase: "v0" }),
  "PHASE_TRANSITION_BAD_TRANSITION",
  "downgrade v1->v0 throws PHASE_TRANSITION_BAD_TRANSITION",
);

await assertThrowsAsync(
  () => evaluatePhaseTransition({ fromPhase: "bogus", toPhase: "v1" }),
  "PHASE_TRANSITION_BAD_TRANSITION",
  "bogus fromPhase throws PHASE_TRANSITION_BAD_TRANSITION",
);

await assertThrowsAsync(
  () => evaluatePhaseTransition({}),
  "PHASE_TRANSITION_BAD_ARGS",
  "missing fromPhase/toPhase throws PHASE_TRANSITION_BAD_ARGS",
);

await assertThrowsAsync(
  () => evaluatePhaseTransition(null),
  "PHASE_TRANSITION_BAD_ARGS",
  "null opts throws PHASE_TRANSITION_BAD_ARGS",
);

// ===========================================================================
// 14. Internal helpers behave as documented
// ===========================================================================

{
  // meets()
  assertEqual(_internals.meets(0.05, 0.03, "gte"), true, "meets gte true");
  assertEqual(_internals.meets(0.02, 0.03, "gte"), false, "meets gte false");
  assertEqual(_internals.meets(-0.01, 0, "lte"), true, "meets lte true");
  assertEqual(_internals.meets(0.05, 0, "lte"), false, "meets lte false");
  assertEqual(_internals.meets(NaN, 0, "gte"), false, "meets NaN -> false");
}

{
  // countHeldOutLabels on a missing file
  assertEqual(_internals.countHeldOutLabels(join(TMP_ROOT, "no.jsonl")), 0,
    "countHeldOutLabels on missing file = 0");
}

// ===========================================================================
// 15. v2 → v3 fallback to damping-log scan when calibration absent
// ===========================================================================

{
  const dampingPath = join(POLICY_DIR, "damping-log.jsonl");
  const lines = [];
  // Synthesize 4 weeks of engagement signals: 250 per week.
  // Spread across 2026-W20..W23
  const baseDates = [
    "2026-05-11T12:00:00.000Z", // W20
    "2026-05-18T12:00:00.000Z", // W21
    "2026-05-25T12:00:00.000Z", // W22
    "2026-06-01T12:00:00.000Z", // W23
  ];
  for (const d of baseDates) {
    for (let i = 0; i < 250; i++) {
      lines.push(JSON.stringify({
        schema_version: 1,
        signal_kind: i % 5 === 0 ? "engagement_inherited" : "engagement",
        memory_id: `mem-${i}`,
        turn_window_id: "tw",
        recall_id: "r1",
        conversation_id_hash: "c",
        ts: d,
        populator_version: "test@0",
        fields: {},
      }));
    }
  }
  writeFileSync(dampingPath, lines.join("\n") + "\n", "utf8");
  const vol = _internals.rollingEngagementVolume(dampingPath);
  assert(vol >= 200, `rollingEngagementVolume reads back >= 200 (got ${vol})`);
}

// ===========================================================================
// 16. Property: can_advance:true implies blocker_reasons absent
// (Invariant 5 across every successful result above)
// ===========================================================================

{
  // Re-run the v0->v1 success case and assert the invariant directly.
  const labelsPath = join(LEDGERS_DIR, "labels-200.jsonl");
  const r = await evaluatePhaseTransition({
    fromPhase: "v0",
    toPhase: "v1",
    labelsPath,
  });
  if (r.can_advance === true) {
    assert(r.blocker_reasons === undefined,
      "invariant 5: can_advance:true => no blocker_reasons");
  } else {
    // Shouldn't reach here; if eval-harness import fails, skip the check.
    assert(true, "invariant 5 vacuously true (harness import failed)");
  }
}

// ===========================================================================
// CLEANUP + SUMMARY
// ===========================================================================

try {
  rmSync(TMP_ROOT, { recursive: true, force: true });
} catch {
  // best-effort cleanup
}

console.log(`\nphase-transition-gate.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
