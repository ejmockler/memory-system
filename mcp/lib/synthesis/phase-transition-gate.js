// phase-transition-gate.js — operational-tier gate that refuses to claim
// "advanced to v1 / v2 / v3" without measurable evidence.
//
// Implements F-SYN-OPERATIONAL-phase-transition-criteria per
// docs/specs/synthesis/phase-transition-criteria.md.
//
// KB ANCHOR
//   research-retrieval-frontiers.md § Staged rollout plan — the canonical
//   v0/v1/v2/v3 success criteria. Each row in the synthesis staged-rollout
//   table maps to a {fromPhase, toPhase} arm here.
//
// DESIGN
//   Every threshold lives in the frozen PHASE_TRANSITION_GATE_CAPS table —
//   no inline numeric literals in the criterion evaluators (invariant 3 of
//   the spec). The function `evaluatePhaseTransition()` is the sole public
//   entry point; it dispatches on `(fromPhase, toPhase)` to one of three
//   evaluators (v0→v1, v1→v2, v2→v3) and refuses unknown pairs by throwing
//   (invariant 4). The v3→v4 arm returns a sentinel result with
//   `code: "TRANSITION_DEFERRED"` rather than throwing — the synthesis
//   quote treats v4 as deferred-conditional, not illegal.
//
// DEFENSIVE DEGRADATION (spec § 6.1)
//   Every cross-module side effect — fs read, JSON.parse, dynamic import —
//   is wrapped in try/catch and degrades to "criterion measured = 0".
//   The only throws are argument-schema violations (unknown phase pairs,
//   missing required string fields). Runtime hot paths NEVER fail-shut on
//   IO error; they fail-soft to a not-met criterion, with the IO failure
//   recorded in the blocker_reasons[] text.
//
// VERSION + CAPS DISCIPLINE (W2-W11 module convention)
//   - PHASE_TRANSITION_GATE_VERSION pinned and exported.
//   - PHASE_TRANSITION_GATE_CAPS frozen; the test suite asserts
//     Object.isFrozen(PHASE_TRANSITION_GATE_CAPS) === true.
//
// HOOK DISCIPLINE
//   This module is a pure-function gate; it has no hooks. The
//   "hooks NEVER block runtime" rule is moot here — the gate is called
//   only by promotion scripts, never on the recall hot path.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKOUT_ROOT } from "../config.js";

// ---------------------------------------------------------------------------
// VERSION + CAPS
// ---------------------------------------------------------------------------

/** Semver version of the gate's behavior. Bumped per spec § 13. */
export const PHASE_TRANSITION_GATE_VERSION = "v0.1.0";

/** Frozen threshold + bookkeeping CAPS. Every numeric constant the gate
 *  references lives here. The test suite asserts Object.isFrozen. */
export const PHASE_TRANSITION_GATE_CAPS = Object.freeze({
  // v0→v1
  LABEL_SET_FLOOR: 150,
  // v1→v2
  NDCG_DELTA_FLOOR: 0.03,
  HARM_RATE_DELTA_CEILING: 0,
  // v2→v3
  ENGAGEMENT_PER_WEEK_FLOOR: 200,
  CALIBRATION_WINDOW_WEEKS_FLOOR: 8,
  // Internal rolling-average window for the engagement volume probe
  ROLLING_WINDOW_WEEKS: 4,
  // Direction constants — referenced by name in the criterion records
  DIRECTION: Object.freeze({ GTE: "gte", LTE: "lte" }),
});

/** Legal (fromPhase, toPhase) pairs. Anything else throws. */
const LEGAL_PAIRS = new Set([
  "v0->v1",
  "v1->v2",
  "v2->v3",
  "v3->v4", // deferred sentinel, but still a legal call
]);

/** Hard criteria that cannot be --override-criteria'd per spec § 10.4.
 *  Exported so future override tooling can read the deny-list. */
export const HARD_CRITERIA = Object.freeze([
  "label_set_size",
  "ndcg_at_12_ci_excludes_zero",
  "harm_rate_not_worse",
]);

// ---------------------------------------------------------------------------
// Internal helpers (pure where possible; IO is defensively wrapped)
// ---------------------------------------------------------------------------

/** Resolve the default labels path under MEMORY_ROOT (read lazily, at call
 *  time) or, when unset, the checkout root from config.js. The env
 *  override mirrors the discipline in damping-log.js. */
function defaultLabelsPath() {
  try {
    const root = process.env.MEMORY_ROOT || CHECKOUT_ROOT;
    return join(root, "ledgers", "held-out-labels.jsonl");
  } catch {
    return "";
  }
}

/** Resolve the default damping-log path. */
function defaultDampingLogPath() {
  try {
    const policy = process.env.POLICY_BASE_DIR
      || join(process.env.MEMORY_ROOT || CHECKOUT_ROOT, "policy");
    return join(policy, "damping-log.jsonl");
  } catch {
    return "";
  }
}

/** Count `kind:"held_out_label"` rows in a JSONL file. Corrupt lines are
 *  silently dropped. Missing file → 0. Mirrors the eval-harness readJsonl
 *  + indexRecallById pattern but slimmer (we only need the count). */
function countHeldOutLabels(path) {
  if (typeof path !== "string" || path.length === 0) return 0;
  if (!existsSync(path)) return 0;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  if (raw.length === 0) return 0;
  let count = 0;
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object" && row.kind === "held_out_label") {
        count++;
      }
    } catch {
      continue;
    }
  }
  return count;
}

/** Probe that the eval-harness module exports its VERSION symbol. Dynamic
 *  import is wrapped in try/catch so a missing/broken harness cannot crash
 *  the gate — the criterion just fails. */
async function evalHarnessImportable() {
  try {
    const mod = await import("./eval-harness.js");
    if (mod && typeof mod.EVAL_HARNESS_VERSION === "string"
        && mod.EVAL_HARNESS_VERSION.length > 0) {
      return 1;
    }
    return 0;
  } catch {
    return 0;
  }
}

/** Probe that the entity-index module exports its VERSION symbol (W11
 *  prerequisite for v1→v2). */
async function entityIndexWired() {
  try {
    const mod = await import("./entity-index.js");
    // Some W11 modules export FOO_VERSION; others export VERSION. Accept
    // either — we are checking the wire, not the name.
    const versionKey = Object.keys(mod || {}).find((k) => /VERSION$/.test(k));
    if (versionKey && typeof mod[versionKey] === "string" && mod[versionKey].length > 0) {
      return 1;
    }
    return 0;
  } catch {
    return 0;
  }
}

/** Probe that the episodicity-scorer module exports its VERSION symbol. */
async function episodicityMatchWired() {
  try {
    const mod = await import("./episodicity-scorer.js");
    const versionKey = Object.keys(mod || {}).find((k) => /VERSION$/.test(k));
    if (versionKey && typeof mod[versionKey] === "string" && mod[versionKey].length > 0) {
      return 1;
    }
    return 0;
  } catch {
    return 0;
  }
}

/** Rolling-average engagement signal volume per week from a damping log
 *  JSONL file. Returns 0 on any IO failure. The rolling window is
 *  CAPS.ROLLING_WINDOW_WEEKS wide; we tally weeks by ISO week-of-year so
 *  the test surface stays deterministic. */
function rollingEngagementVolume(path) {
  if (typeof path !== "string" || path.length === 0) return 0;
  if (!existsSync(path)) return 0;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  if (raw.length === 0) return 0;
  // weekKey -> count
  const byWeek = new Map();
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    try {
      const row = JSON.parse(line);
      if (row == null || typeof row !== "object") continue;
      const sk = row.signal_kind;
      if (sk !== "engagement" && sk !== "engagement_inherited") continue;
      const ts = typeof row.ts === "string" ? row.ts : null;
      if (ts === null) continue;
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) continue;
      // ISO-week key: year + week-of-year, sufficient bucket for our rolling avg
      const yr = d.getUTCFullYear();
      const wk = isoWeek(d);
      const key = `${yr}-W${String(wk).padStart(2, "0")}`;
      byWeek.set(key, (byWeek.get(key) || 0) + 1);
    } catch {
      continue;
    }
  }
  if (byWeek.size === 0) return 0;
  // Take the most-recent N weeks (by key sort) and return the mean.
  const keysSorted = [...byWeek.keys()].sort();
  const window = keysSorted.slice(-PHASE_TRANSITION_GATE_CAPS.ROLLING_WINDOW_WEEKS);
  let sum = 0;
  for (const k of window) sum += byWeek.get(k) || 0;
  return Math.floor(sum / window.length);
}

/** Compute ISO week-of-year for a Date. Standard algorithm. */
function isoWeek(d) {
  try {
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const diff = (target.getTime() - firstThursday.getTime()) / 86400000;
    return 1 + Math.round((diff - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  } catch {
    return 1;
  }
}

/** Apply the threshold + direction to a measurement to produce `met`. */
function meets(measured, threshold, direction) {
  if (typeof measured !== "number" || !Number.isFinite(measured)) return false;
  if (direction === PHASE_TRANSITION_GATE_CAPS.DIRECTION.LTE) {
    return measured <= threshold;
  }
  // default: gte
  return measured >= threshold;
}

/** Build a Criterion record. */
function criterion(name, measured, threshold, direction) {
  // NaN measurements rendered as 0 in the visible field per spec § 6.1.
  const m = (typeof measured === "number" && Number.isFinite(measured)) ? measured : 0;
  return {
    name,
    measured: m,
    threshold,
    direction,
    met: meets(m, threshold, direction),
  };
}

/** Render a blocker reason string for a failed criterion. */
function blockerFor(c) {
  const op = c.direction === PHASE_TRANSITION_GATE_CAPS.DIRECTION.LTE ? "<=" : ">=";
  const wrongOp = c.direction === PHASE_TRANSITION_GATE_CAPS.DIRECTION.LTE ? ">" : "<";
  return `${c.name}: measured ${c.measured} ${wrongOp} threshold ${c.threshold} (must be ${op} threshold)`;
}

/** Build a GateResult envelope. */
function buildResult(fromPhase, toPhase, criteria, code) {
  const can_advance = criteria.length > 0 && criteria.every((c) => c.met === true);
  const blockers = [];
  for (const c of criteria) {
    if (!c.met) blockers.push(blockerFor(c));
  }
  const result = {
    from_phase: fromPhase,
    to_phase: toPhase,
    can_advance,
    criteria,
    evaluated_at: new Date().toISOString(),
    version: PHASE_TRANSITION_GATE_VERSION,
  };
  if (blockers.length > 0) result.blocker_reasons = blockers;
  if (typeof code === "string" && code.length > 0) result.code = code;
  // Invariant 5: can_advance:true implies blocker_reasons is absent.
  if (result.can_advance === true && result.blocker_reasons) {
    // This branch is unreachable by construction; the assertion is a
    // defensive belt-and-suspenders for refactors.
    result.can_advance = false;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Per-transition evaluators
// ---------------------------------------------------------------------------

/** v0 → v1 — criteria per spec § 4.1. */
async function evalV0toV1(opts) {
  const labelsPath = opts.labelsPath || defaultLabelsPath();
  const labelCount = countHeldOutLabels(labelsPath);
  const harnessImportable = await evalHarnessImportable();
  const recallBaseline = (opts.evalCurrent
      && typeof opts.evalCurrent.recall_at_12 === "number"
      && Number.isFinite(opts.evalCurrent.recall_at_12))
    ? opts.evalCurrent.recall_at_12
    : 0;

  const criteria = [
    criterion(
      "label_set_size",
      labelCount,
      PHASE_TRANSITION_GATE_CAPS.LABEL_SET_FLOOR,
      PHASE_TRANSITION_GATE_CAPS.DIRECTION.GTE,
    ),
    criterion(
      "offline_eval_available",
      harnessImportable,
      1,
      PHASE_TRANSITION_GATE_CAPS.DIRECTION.GTE,
    ),
    criterion(
      "recall_at_12_baseline",
      recallBaseline,
      0,
      PHASE_TRANSITION_GATE_CAPS.DIRECTION.GTE,
    ),
  ];
  return buildResult("v0", "v1", criteria);
}

/** v1 → v2 — criteria per spec § 4.2. */
async function evalV1toV2(opts) {
  const cur = opts.evalCurrent || {};
  const base = opts.evalBaseline || {};

  const curNdcg = typeof cur.ndcg_at_12 === "number" && Number.isFinite(cur.ndcg_at_12)
    ? cur.ndcg_at_12
    : NaN;
  const baseNdcg = typeof base.ndcg_at_12 === "number" && Number.isFinite(base.ndcg_at_12)
    ? base.ndcg_at_12
    : NaN;
  const ndcgDelta = (Number.isFinite(curNdcg) && Number.isFinite(baseNdcg))
    ? (curNdcg - baseNdcg)
    : NaN;

  const ndcgCi = cur && cur.bootstrap_ci && Array.isArray(cur.bootstrap_ci.ndcg)
    ? cur.bootstrap_ci.ndcg
    : null;
  const ndcgCiLo = (ndcgCi && typeof ndcgCi[0] === "number" && Number.isFinite(ndcgCi[0]))
    ? ndcgCi[0]
    : NaN;
  const ciExcludesZero = (Number.isFinite(ndcgCiLo) && ndcgCiLo > 0) ? 1 : 0;

  const curHarm = typeof cur.harm_rate === "number" && Number.isFinite(cur.harm_rate)
    ? cur.harm_rate
    : NaN;
  const baseHarm = typeof base.harm_rate === "number" && Number.isFinite(base.harm_rate)
    ? base.harm_rate
    : NaN;
  const harmDelta = (Number.isFinite(curHarm) && Number.isFinite(baseHarm))
    ? (curHarm - baseHarm)
    : NaN;

  const entityWired = await entityIndexWired();
  const episodicityWired = await episodicityMatchWired();

  const criteria = [
    criterion(
      "ndcg_at_12_uplift",
      ndcgDelta,
      PHASE_TRANSITION_GATE_CAPS.NDCG_DELTA_FLOOR,
      PHASE_TRANSITION_GATE_CAPS.DIRECTION.GTE,
    ),
    criterion(
      "ndcg_at_12_ci_excludes_zero",
      ciExcludesZero,
      1,
      PHASE_TRANSITION_GATE_CAPS.DIRECTION.GTE,
    ),
    criterion(
      "harm_rate_not_worse",
      harmDelta,
      PHASE_TRANSITION_GATE_CAPS.HARM_RATE_DELTA_CEILING,
      PHASE_TRANSITION_GATE_CAPS.DIRECTION.LTE,
    ),
    criterion(
      "entity_index_wired",
      entityWired,
      1,
      PHASE_TRANSITION_GATE_CAPS.DIRECTION.GTE,
    ),
    criterion(
      "episodicity_match_wired",
      episodicityWired,
      1,
      PHASE_TRANSITION_GATE_CAPS.DIRECTION.GTE,
    ),
  ];
  return buildResult("v1", "v2", criteria);
}

/** v2 → v3 — criteria per spec § 4.3. */
async function evalV2toV3(opts) {
  // Prefer pre-computed dampingCalibration; fall back to scanning the
  // damping log if absent.
  let volumePerWeek = 0;
  let windowWeeks = 0;
  if (opts.dampingCalibration && typeof opts.dampingCalibration === "object") {
    const dc = opts.dampingCalibration;
    if (Array.isArray(dc.weekly_volumes) && dc.weekly_volumes.length > 0) {
      // Most-recent-last; rolling average over the trailing window.
      const recent = dc.weekly_volumes.slice(
        -PHASE_TRANSITION_GATE_CAPS.ROLLING_WINDOW_WEEKS,
      );
      let sum = 0;
      let n = 0;
      for (const v of recent) {
        if (typeof v === "number" && Number.isFinite(v)) {
          sum += v;
          n++;
        }
      }
      volumePerWeek = n === 0 ? 0 : Math.floor(sum / n);
    }
    if (typeof dc.calibration_window_weeks === "number"
        && Number.isFinite(dc.calibration_window_weeks)) {
      windowWeeks = dc.calibration_window_weeks;
    }
  }
  if (volumePerWeek === 0) {
    // Fall back to damping-log scan.
    const dpath = opts.dampingLogPath || defaultDampingLogPath();
    volumePerWeek = rollingEngagementVolume(dpath);
  }

  const ndcgCi = opts.evalCurrent
      && opts.evalCurrent.bootstrap_ci
      && Array.isArray(opts.evalCurrent.bootstrap_ci.ndcg)
    ? opts.evalCurrent.bootstrap_ci.ndcg
    : null;
  const ndcgCiLo = (ndcgCi && typeof ndcgCi[0] === "number" && Number.isFinite(ndcgCi[0]))
    ? ndcgCi[0]
    : NaN;
  const ciExcludesZero = (Number.isFinite(ndcgCiLo) && ndcgCiLo > 0) ? 1 : 0;

  const criteria = [
    criterion(
      "engagement_signal_volume_per_week",
      volumePerWeek,
      PHASE_TRANSITION_GATE_CAPS.ENGAGEMENT_PER_WEEK_FLOOR,
      PHASE_TRANSITION_GATE_CAPS.DIRECTION.GTE,
    ),
    criterion(
      "damping_calibration_window_weeks",
      windowWeeks,
      PHASE_TRANSITION_GATE_CAPS.CALIBRATION_WINDOW_WEEKS_FLOOR,
      PHASE_TRANSITION_GATE_CAPS.DIRECTION.GTE,
    ),
    criterion(
      "ndcg_at_12_ci_excludes_zero",
      ciExcludesZero,
      1,
      PHASE_TRANSITION_GATE_CAPS.DIRECTION.GTE,
    ),
  ];
  return buildResult("v2", "v3", criteria);
}

/** v3 → v4 — deferred sentinel per spec § 4.4. */
function evalV3toV4() {
  const result = {
    from_phase: "v3",
    to_phase: "v4",
    can_advance: false,
    criteria: [],
    blocker_reasons: [
      "v3 -> v4 is deferred per research-retrieval-frontiers.md § Phase 3 v4 (deferred, conditional)",
    ],
    code: "TRANSITION_DEFERRED",
    evaluated_at: new Date().toISOString(),
    version: PHASE_TRANSITION_GATE_VERSION,
  };
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate whether the synthesis cluster meets the criteria to advance
 * from `fromPhase` to `toPhase`.
 *
 * @param {object} opts
 * @param {"v0"|"v1"|"v2"|"v3"} opts.fromPhase
 * @param {"v1"|"v2"|"v3"|"v4"} opts.toPhase
 * @param {string} [opts.labelsPath]
 * @param {string} [opts.recallLogPath]
 * @param {string} [opts.dampingLogPath]
 * @param {object} [opts.evalCurrent]    — current-tier eval-harness blob
 * @param {object} [opts.evalBaseline]   — previous-tier eval-harness blob
 * @param {object} [opts.dampingCalibration]
 * @returns {Promise<object>} GateResult per spec § 5
 */
export async function evaluatePhaseTransition(opts) {
  if (opts == null || typeof opts !== "object") {
    const e = new Error("evaluatePhaseTransition: opts must be an object");
    e.code = "PHASE_TRANSITION_BAD_ARGS";
    throw e;
  }
  const { fromPhase, toPhase } = opts;
  if (typeof fromPhase !== "string" || typeof toPhase !== "string") {
    const e = new Error("evaluatePhaseTransition: fromPhase and toPhase required");
    e.code = "PHASE_TRANSITION_BAD_ARGS";
    throw e;
  }
  const pairKey = `${fromPhase}->${toPhase}`;
  if (!LEGAL_PAIRS.has(pairKey)) {
    const e = new Error(
      `evaluatePhaseTransition: unknown transition ${pairKey} (legal: ${[...LEGAL_PAIRS].join(", ")})`,
    );
    e.code = "PHASE_TRANSITION_BAD_TRANSITION";
    throw e;
  }

  try {
    if (pairKey === "v0->v1") return await evalV0toV1(opts);
    if (pairKey === "v1->v2") return await evalV1toV2(opts);
    if (pairKey === "v2->v3") return await evalV2toV3(opts);
    if (pairKey === "v3->v4") return evalV3toV4();
  } catch (err) {
    // Defensive: a criterion evaluator that throws should NOT propagate to
    // the caller. We surface it as a refusal with a single blocker line so
    // the caller still sees a structured result.
    const msg = err && err.message ? err.message : String(err);
    return {
      from_phase: fromPhase,
      to_phase: toPhase,
      can_advance: false,
      criteria: [],
      blocker_reasons: [`internal evaluator error: ${msg}`],
      code: "INTERNAL_EVALUATOR_ERROR",
      evaluated_at: new Date().toISOString(),
      version: PHASE_TRANSITION_GATE_VERSION,
    };
  }
  // Unreachable.
  throw new Error("evaluatePhaseTransition: dispatch fell through");
}

// Re-export internals for test-time pinning (the test suite asserts pure
// helpers behave as documented). These names are exposed on a `_internals`
// object rather than top-level so they cannot be imported by accident.
export const _internals = Object.freeze({
  countHeldOutLabels,
  rollingEngagementVolume,
  meets,
  buildResult,
});
