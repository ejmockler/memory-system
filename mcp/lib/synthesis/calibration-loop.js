// calibration-loop.js — operational-tier damping + propagation CAPS
// calibration loop (F-SYN-OPERATIONAL-damping-calibration-loop, Wave 12).
//
// This is the "O5 calibration" deferred since W2: turning hand-tuned damping
// + propagation priors into measured values against the W11 held-out labeled
// set + offline-eval harness.
//
// CONTRACT (the goal-spec calls this out verbatim):
//   - export const CALIBRATION_LOOP_VERSION = "v0.1.0"
//   - export async function runCalibration({
//       labelsPath, recallLogPath, baselineCaps, gridSpec, derivationGraph?,
//       rescoreSurfaced?,
//     }) → {
//       best_caps, baseline_metrics, best_metrics, search_log,
//       baseline_caps, version, built_at, cold_start,
//     }
//   - gridSpec default keys: {
//       DAMPING_ENGAGEMENT_BOOST: [0.03, 0.05, 0.07],
//       RAW_SURFACING_PENALTY:    [-0.01, -0.02, -0.04],
//       CORROBORATION_BOOST_PER_DESCENDANT: [0.03, 0.05, 0.07],
//     }
//   - For each grid point: evaluate() with re-scored recall log (CAPS applied
//     to surfaced[] re-ranking) → record metrics.
//   - Pick CAPS that MAXIMIZE NDCG@12 (primary), SUBJECT TO
//     harm_rate ≤ baseline_harm (never accept a candidate that increases harm
//     relative to the baseline-caps run).
//
// COLD-START DISCIPLINE (spec § "cold-start" requirement from the WU):
//   When labelsPath is empty OR no recall row joins to any label, the
//   calibration MUST return the baseline unchanged. No grid search, no
//   movement, no opportunity to over-fit on zero data.
//
// CROSS-MODULE DEFENSIVE DISCIPLINE
//   - Every cross-module call (fs read, evaluate() invocation, JSON parse) is
//     wrapped in try/catch.
//   - The loop NEVER fails-shut on a single grid point exception: that
//     candidate is logged with `{ ok: false, error }` and the search continues
//     so a single bad caps combo cannot kill the whole calibration.
//   - The ONLY fatal paths are "labelsPath missing" (delegated to evaluate())
//     and "baselineCaps malformed" (caller bug; we surface early).
//
// PURE FUNCTIONS (NO HIDDEN I/O EXCEPT THE TWO LEDGER READS PER CANDIDATE)
//   - Rescoring is a pure transform over surfaced[] given a caps vector.
//   - The temp re-scored recall log is written into a caller-supplied
//     scratch dir (or os.tmpdir()), removed after each candidate evaluation.
//
// VERSION + CAPS DISCIPLINE (W2-W11 module convention)
//   - CALIBRATION_LOOP_VERSION pinned and exported.
//   - DEFAULT_GRID_SPEC frozen so consumers cannot mutate the shipped grid.
//   - CAPS frozen (CALIBRATION_LOOP_CAPS) including the constraint mode.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluate, EVAL_HARNESS_VERSION } from "./eval-harness.js";

// ---------------------------------------------------------------------------
// Versioning + frozen module exports
// ---------------------------------------------------------------------------

export const CALIBRATION_LOOP_VERSION = "v0.2.0";

/** The canonical grid the WU pinned. Tests can override by passing a custom
 *  gridSpec; production calls expect to use this object by default. Frozen
 *  so consumers cannot mutate it across calls.
 *
 *  NAMESPACE NOTE (N1-calibration WORKUNIT, v0.2.0): these three keys are the
 *  LAYER-1 re-rank caps. They multiply RAW COUNTS on surfaced[] metadata
 *  (engagement_strength, raw_surfacing_count, descendant_corroborations) in
 *  rescoreSurfacedWithCaps. They are a DIFFERENT tuning surface from the LIVE
 *  scorer weights (LIVE_WEIGHT_GRID_SPEC below). Mixing the two is a unit
 *  error: a 0.05 grid point adds ~0.05 per signal here, but scales a bounded
 *  [0.5,1.5] / [1.0,1.3] prior in the live-weight surface. */
export const DEFAULT_GRID_SPEC = Object.freeze({
  DAMPING_ENGAGEMENT_BOOST: Object.freeze([0.03, 0.05, 0.07]),
  RAW_SURFACING_PENALTY: Object.freeze([-0.01, -0.02, -0.04]),
  CORROBORATION_BOOST_PER_DESCENDANT: Object.freeze([0.03, 0.05, 0.07]),
});

/** N1-calibration (WORKUNIT item 1): the LIVE-WEIGHT grid. These are the
 *  Layer-2 (multi-feature-score rank-time) weights — they multiply NORMALIZED
 *  PRIORS the scorer reads off candidate.priors, NOT raw surfaced[] counts:
 *
 *    SCORE_WEIGHT_ENGAGEMENT_PRIOR  × engagement_prior   (≥ 0, from recall-feedback)
 *    SCORE_WEIGHT_DAMPING_PRIOR     × damping_coefficient (∈ [0.5, 1.5])
 *    SCORE_WEIGHT_CORROBORATION_PRIOR × corroboration_boost (∈ [1.0, 1.3])
 *
 *  Ranges are deliberately NARROW ([0.0, 0.03] max for damping/corroboration;
 *  [0.0, 0.04] for engagement) so the additive priors cannot over-dominate the
 *  other bounded additive features (entity_overlap_jaccard ∈ [0,1], etc.) or
 *  the multiplicative embedding branch (MAP finding "SAFE CALIBRATION STRATEGY"
 *  point 4). Baseline stays at 0.0 (current frozen CAPS default) → no behavior
 *  change unless a non-zero cell strictly wins on NDCG@12 with harm ≤ baseline.
 *  Frozen so consumers cannot mutate the shipped grid. */
export const LIVE_WEIGHT_GRID_SPEC = Object.freeze({
  SCORE_WEIGHT_ENGAGEMENT_PRIOR: Object.freeze([0.0, 0.01, 0.02, 0.04]),
  SCORE_WEIGHT_DAMPING_PRIOR: Object.freeze([0.0, 0.01, 0.02, 0.03]),
  SCORE_WEIGHT_CORROBORATION_PRIOR: Object.freeze([0.0, 0.01, 0.02, 0.03]),
});

/** Module CAPS — the calibration-loop's own knobs (not the CAPS it tunes).
 *  These are the policy choices for HOW we calibrate, not WHAT we calibrate. */
export const CALIBRATION_LOOP_CAPS = Object.freeze({
  // Primary metric: NDCG@12 (graded relevance, includes neighbor +1 and
  // forbidden -2). Spec § 6.3 of held-out-labeled-set.md.
  PRIMARY_METRIC: "ndcg_at_12",
  // Hard constraint: harm_rate MUST NOT exceed baseline. Equality is OK
  // (the candidate is at least as safe); strictly greater is rejected.
  HARM_CONSTRAINT_MODE: "no_increase",
  // Numeric tolerance for "no increase" — floats out of bootstrap are
  // exact-comparable here because we never re-mean a candidate's harm rate
  // (each candidate's harm_rate is a deterministic count/N).
  HARM_TIE_EPSILON: 1e-12,
  // Tie-breaking when two grid points produce identical NDCG@12: prefer the
  // one with LOWER harm_rate, then lower abstain_f1 loss, then earliest in
  // grid-iteration order (so the search log is reproducible).
  TIEBREAK: Object.freeze(["harm_rate_asc", "iteration_order_asc"]),
  // Module identifier for log rows + audit trail.
  EMITTER_MODULE: "calibration-loop",
});

// ---------------------------------------------------------------------------
// Helpers — pure functions over (recall_row, caps)
// ---------------------------------------------------------------------------

/** Recognise the LAYER-1 re-rank caps keys this loop knows how to apply.
 *  Defensive: anything not in this list is silently ignored when re-scoring
 *  (forward compat — a future WU can ship more keys without breaking this
 *  module). */
const LAYER1_CAPS_KEYS = new Set([
  "DAMPING_ENGAGEMENT_BOOST",
  "RAW_SURFACING_PENALTY",
  "CORROBORATION_BOOST_PER_DESCENDANT",
]);

/** N1-calibration: the LAYER-2 LIVE scorer-weight keys. These are validated +
 *  expanded by the SAME helpers as the Layer-1 caps but are applied by a
 *  DIFFERENT rescorer (rescoreSurfacedWithLiveWeights) against the NORMALIZED
 *  priors on each surfaced item, not the raw counts. Kept as a distinct set so
 *  expandGrid/normaliseCaps never silently swap a Layer-1 cap into a Layer-2
 *  slot (the namespace-gap trap). */
export const LIVE_WEIGHT_KEYS = Object.freeze([
  "SCORE_WEIGHT_ENGAGEMENT_PRIOR",
  "SCORE_WEIGHT_DAMPING_PRIOR",
  "SCORE_WEIGHT_CORROBORATION_PRIOR",
]);
const LIVE_WEIGHT_KEY_SET = new Set(LIVE_WEIGHT_KEYS);

/** Union of every key the loop validates/expands. A gridSpec or caps object
 *  may carry EITHER the Layer-1 caps OR the Layer-2 live weights (or both);
 *  the rescorer chosen by the caller decides which subset actually moves
 *  scores. normaliseCaps + expandGrid accept any key in this union. */
const KNOWN_CAPS_KEYS = new Set([...LAYER1_CAPS_KEYS, ...LIVE_WEIGHT_KEY_SET]);

/** Spec-pinned neutral defaults + hard bounds for the LIVE priors, mirrored
 *  from multi-feature-score.js:630-651 + DAMPING_CAPS / CORROBORATION_CAPS so
 *  the live-weight rescorer applies the SAME clamps the scorer applies at
 *  recall time (no calibration over-fit outside the scorer's reachable range).
 *  engagement_prior has no upper clamp in the scorer (it is a non-negative
 *  count-derived scalar) so we only floor it at 0. */
const LIVE_PRIOR_BOUNDS = Object.freeze({
  damping_coefficient: Object.freeze({ neutral: 1.0, min: 0.5, max: 1.5 }),
  corroboration_boost: Object.freeze({ neutral: 1.0, min: 1.0, max: 1.3 }),
  engagement_prior: Object.freeze({ neutral: 0.0, min: 0.0, max: Infinity }),
});

/** Validate a caps object: must be a plain object with finite numeric
 *  values on each known key. Returns a normalised frozen snapshot (so the
 *  search log carries an immutable record of every probed caps vector). */
function normaliseCaps(caps, where) {
  if (caps === null || typeof caps !== "object" || Array.isArray(caps)) {
    const e = new Error(`calibration-loop: ${where} must be a plain object`);
    e.code = "CALIBRATION_BAD_ARGS";
    throw e;
  }
  const out = {};
  for (const k of KNOWN_CAPS_KEYS) {
    const v = caps[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      const e = new Error(
        `calibration-loop: ${where}.${k} must be a finite number; got ${JSON.stringify(v)}`,
      );
      e.code = "CALIBRATION_BAD_ARGS";
      throw e;
    }
    out[k] = v;
  }
  return Object.freeze(out);
}

/** Default rescorer — applies the three known caps to each surfaced item's
 *  score and re-sorts descending. Optional fields on each surfaced item:
 *    - raw_surfacing_count       (number, default 0) — N prior raw surfacings
 *    - engagement_strength       (number, default 0) — aggregated engagement
 *    - descendant_corroborations (number, default 0) — # descendants engaged
 *
 *  If those fields are absent, the rescore is a no-op (the score stays at
 *  its original value). This is the defensive-degradation discipline: real
 *  recall logs may lack the optional fields → calibration still runs (it
 *  just won't move metrics). Test fixtures supply the fields to drive
 *  the grid actually-into-effect.
 *
 *  Returns a NEW surfaced[] (does not mutate input). */
export function rescoreSurfacedWithCaps(surfaced, caps) {
  if (!Array.isArray(surfaced)) return [];
  const damping = Number.isFinite(caps.DAMPING_ENGAGEMENT_BOOST)
    ? caps.DAMPING_ENGAGEMENT_BOOST
    : 0;
  const rawPenalty = Number.isFinite(caps.RAW_SURFACING_PENALTY)
    ? caps.RAW_SURFACING_PENALTY
    : 0;
  const corroboration = Number.isFinite(caps.CORROBORATION_BOOST_PER_DESCENDANT)
    ? caps.CORROBORATION_BOOST_PER_DESCENDANT
    : 0;

  const rescored = [];
  for (let i = 0; i < surfaced.length; i++) {
    const item = surfaced[i];
    if (item == null || typeof item !== "object") continue;
    const baseScore = typeof item.score === "number" && Number.isFinite(item.score)
      ? item.score
      : 0;
    const rawCount = typeof item.raw_surfacing_count === "number"
      ? item.raw_surfacing_count
      : 0;
    const engStrength = typeof item.engagement_strength === "number"
      ? item.engagement_strength
      : 0;
    const descCount = typeof item.descendant_corroborations === "number"
      ? item.descendant_corroborations
      : 0;
    // Re-score formula (additive linear; the three caps are exactly the
    // gridSpec keys the WU pinned):
    //   score' = score
    //          + DAMPING_ENGAGEMENT_BOOST       * engagement_strength
    //          + RAW_SURFACING_PENALTY          * raw_surfacing_count
    //          + CORROBORATION_BOOST_PER_DESCENDANT * descendant_corroborations
    // RAW_SURFACING_PENALTY is itself negative in the gridSpec, so adding it
    // (rather than subtracting) keeps the sign convention right.
    const newScore =
      baseScore +
      damping * engStrength +
      rawPenalty * rawCount +
      corroboration * descCount;
    rescored.push({ ...item, score: newScore });
  }
  // Sort descending by score, then by original position ascending (stable
  // tiebreak — keeps deterministic order across runs).
  rescored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const pa = typeof a.position === "number" ? a.position : 0;
    const pb = typeof b.position === "number" ? b.position : 0;
    return pa - pb;
  });
  // Re-stamp positions in the new order so eval-harness's
  // surfacedIdsFromRecall(sort-by-position) reflects the new ranking.
  for (let i = 0; i < rescored.length; i++) rescored[i].position = i;
  return rescored;
}

/** Clamp a prior scalar into its spec-pinned bound (mirrors the defensive
 *  clamps in multi-feature-score.computeScore). Non-finite → neutral. */
function clampPrior(name, raw) {
  const b = LIVE_PRIOR_BOUNDS[name];
  if (b == null) return raw;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return b.neutral;
  if (raw < b.min) return b.min;
  if (raw > b.max) return b.max;
  return raw;
}

/** N1-calibration (WORKUNIT item 1): the LIVE-WEIGHT rescorer. Closes the
 *  namespace gap — instead of multiplying raw surfaced[] COUNTS (Layer 1),
 *  this applies the three SCORE_WEIGHT_*_PRIOR weights to the NORMALIZED
 *  priors each item carries under `surfaced[i].priors`, exactly as
 *  multi-feature-score.js:680-687 does at recall rank time:
 *
 *    score' = score
 *           + SCORE_WEIGHT_ENGAGEMENT_PRIOR    * engagement_prior
 *           + SCORE_WEIGHT_DAMPING_PRIOR       * damping_coefficient
 *           + SCORE_WEIGHT_CORROBORATION_PRIOR * corroboration_boost
 *
 *  The priors are clamped to the SAME bounds the scorer enforces, and absent
 *  priors degrade to their NEUTRAL value (engagement 0.0, damping 1.0,
 *  corroboration 1.0) — so a surfaced item with no instrumentation is
 *  ranking-neutral and the rescore is a no-op when every weight is 0.0 (the
 *  baseline). This is the function the harness passes as opts.rescoreSurfaced
 *  to drive the LIVE weights through the grid sweep.
 *
 *  Returns a NEW surfaced[] (does not mutate input). */
export function rescoreSurfacedWithLiveWeights(surfaced, caps) {
  if (!Array.isArray(surfaced)) return [];
  const wEng = Number.isFinite(caps && caps.SCORE_WEIGHT_ENGAGEMENT_PRIOR)
    ? caps.SCORE_WEIGHT_ENGAGEMENT_PRIOR
    : 0;
  const wDamp = Number.isFinite(caps && caps.SCORE_WEIGHT_DAMPING_PRIOR)
    ? caps.SCORE_WEIGHT_DAMPING_PRIOR
    : 0;
  const wCorro = Number.isFinite(caps && caps.SCORE_WEIGHT_CORROBORATION_PRIOR)
    ? caps.SCORE_WEIGHT_CORROBORATION_PRIOR
    : 0;

  const rescored = [];
  for (let i = 0; i < surfaced.length; i++) {
    const item = surfaced[i];
    if (item == null || typeof item !== "object") continue;
    const baseScore = typeof item.score === "number" && Number.isFinite(item.score)
      ? item.score
      : 0;
    const priors =
      item.priors != null && typeof item.priors === "object" ? item.priors : null;
    const engagement_prior = clampPrior(
      "engagement_prior",
      priors != null ? priors.engagement_prior : undefined,
    );
    const damping_coefficient = clampPrior(
      "damping_coefficient",
      priors != null ? priors.damping_coefficient : undefined,
    );
    const corroboration_boost = clampPrior(
      "corroboration_boost",
      priors != null ? priors.corroboration_boost : undefined,
    );
    const newScore =
      baseScore +
      wEng * engagement_prior +
      wDamp * damping_coefficient +
      wCorro * corroboration_boost;
    rescored.push({ ...item, score: newScore });
  }
  rescored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const pa = typeof a.position === "number" ? a.position : 0;
    const pb = typeof b.position === "number" ? b.position : 0;
    return pa - pb;
  });
  for (let i = 0; i < rescored.length; i++) rescored[i].position = i;
  return rescored;
}

/** Stream a .jsonl file into an array of parsed rows (defensive). */
function readJsonl(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  if (raw.length === 0) return [];
  const lines = raw.split("\n");
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return rows;
}

/** Write a recall log to disk re-scored under the supplied caps. Returns
 *  the path the caller should pass into evaluate(). The on-disk file is a
 *  drop-in substitute for the original recall log: same shape, only the
 *  surfaced[] arrays are rewritten. Non-recall rows are passed through
 *  untouched so the file's shape stays valid for any other reader. */
function writeRescoredRecallLog({
  scratchDir,
  recallRows,
  caps,
  rescoreSurfaced,
}) {
  const lines = [];
  for (const row of recallRows) {
    if (row == null || typeof row !== "object") continue;
    if (row.kind !== "recall") {
      try {
        lines.push(JSON.stringify(row));
      } catch {
        continue;
      }
      continue;
    }
    let newSurfaced;
    try {
      newSurfaced = rescoreSurfaced(row.surfaced || [], caps);
    } catch {
      newSurfaced = row.surfaced || [];
    }
    const rewritten = { ...row, surfaced: newSurfaced };
    try {
      lines.push(JSON.stringify(rewritten));
    } catch {
      continue;
    }
  }
  const outPath = join(scratchDir, `recall.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.jsonl`);
  writeFileSync(outPath, lines.join("\n") + (lines.length > 0 ? "\n" : ""), { mode: 0o600 });
  return outPath;
}

/** Enumerate the Cartesian product of a grid spec. Returns an array of
 *  plain caps objects in deterministic lexicographic key-order so the
 *  search log is reproducible across runs. */
export function expandGrid(gridSpec) {
  if (gridSpec == null || typeof gridSpec !== "object" || Array.isArray(gridSpec)) {
    throw new Error("calibration-loop.expandGrid: gridSpec must be a plain object");
  }
  const keys = Object.keys(gridSpec).filter((k) => KNOWN_CAPS_KEYS.has(k)).sort();
  if (keys.length === 0) return [];
  const valueLists = keys.map((k) => {
    const v = gridSpec[k];
    if (!Array.isArray(v) || v.length === 0) {
      throw new Error(
        `calibration-loop.expandGrid: gridSpec.${k} must be a non-empty array`,
      );
    }
    for (const x of v) {
      if (typeof x !== "number" || !Number.isFinite(x)) {
        throw new Error(
          `calibration-loop.expandGrid: gridSpec.${k} values must be finite numbers`,
        );
      }
    }
    return v;
  });
  const out = [];
  function recurse(depth, acc) {
    if (depth === keys.length) {
      out.push({ ...acc });
      return;
    }
    const k = keys[depth];
    for (const v of valueLists[depth]) {
      acc[k] = v;
      recurse(depth + 1, acc);
    }
  }
  recurse(0, {});
  return out;
}

/** Decide whether `candidate` beats `incumbent`. Returns true if the
 *  candidate strictly improves the primary metric AND honors the harm
 *  constraint (≤ baseline harm). Tiebreaks per CAPS.TIEBREAK. */
function candidateBeats({ candidate, incumbent, baselineHarm }) {
  if (!candidate.ok) return false;
  if (!incumbent.ok) return true;
  // Hard constraint: candidate harm rate must not exceed baseline.
  if (candidate.metrics.harm_rate > baselineHarm + CALIBRATION_LOOP_CAPS.HARM_TIE_EPSILON) {
    return false;
  }
  const cNdcg = candidate.metrics[CALIBRATION_LOOP_CAPS.PRIMARY_METRIC];
  const iNdcg = incumbent.metrics[CALIBRATION_LOOP_CAPS.PRIMARY_METRIC];
  if (typeof cNdcg !== "number" || !Number.isFinite(cNdcg)) return false;
  if (typeof iNdcg !== "number" || !Number.isFinite(iNdcg)) return true;
  if (cNdcg > iNdcg) return true;
  if (cNdcg < iNdcg) return false;
  // Tie on primary metric → tiebreak on harm rate ascending.
  if (candidate.metrics.harm_rate < incumbent.metrics.harm_rate) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Public API — runCalibration()
// ---------------------------------------------------------------------------

/**
 * Run the damping + propagation CAPS calibration loop.
 *
 * @param {object} opts
 * @param {string}  opts.labelsPath       — held-out labels.jsonl path
 * @param {string}  opts.recallLogPath    — recall.jsonl path (soak substrate)
 * @param {object}  opts.baselineCaps     — current (hand-tuned) caps; the
 *                                          baseline run uses these as-is.
 * @param {object} [opts.gridSpec]        — grid to sweep; defaults to
 *                                          DEFAULT_GRID_SPEC.
 * @param {object} [opts.derivationGraph] — optional; forwarded to evaluate()
 *                                          for the +1 neighbor graded gain.
 * @param {function} [opts.rescoreSurfaced] — optional override for the
 *                                          per-recall rescorer. Signature:
 *                                          (surfaced, caps) → surfaced'.
 * @param {string} [opts.scratchDir]      — directory for temp re-scored
 *                                          recall logs (defaults to a fresh
 *                                          mkdtemp under os.tmpdir()).
 *
 * @returns {Promise<{
 *   best_caps: object,
 *   baseline_caps: object,
 *   baseline_metrics: object,
 *   best_metrics: object,
 *   search_log: object[],
 *   cold_start: boolean,
 *   version: string,
 *   eval_harness_version: string,
 *   built_at: string,
 * }>}
 */
export async function runCalibration({
  labelsPath,
  recallLogPath,
  baselineCaps,
  gridSpec,
  derivationGraph,
  rescoreSurfaced,
  scratchDir,
} = {}) {
  // ---- 1) Argument validation (the only fatal path).
  if (typeof labelsPath !== "string" || labelsPath.length === 0) {
    const e = new Error("runCalibration: labelsPath required");
    e.code = "CALIBRATION_BAD_ARGS";
    throw e;
  }
  if (typeof recallLogPath !== "string" || recallLogPath.length === 0) {
    const e = new Error("runCalibration: recallLogPath required");
    e.code = "CALIBRATION_BAD_ARGS";
    throw e;
  }
  const normBaseline = normaliseCaps(baselineCaps || {}, "baselineCaps");
  const effectiveGrid = gridSpec || DEFAULT_GRID_SPEC;
  const candidates = expandGrid(effectiveGrid);
  const rescore = typeof rescoreSurfaced === "function"
    ? rescoreSurfaced
    : rescoreSurfacedWithCaps;
  const builtAt = new Date().toISOString();

  // ---- 2) Pre-flight: detect cold-start before doing any sweep work.
  //
  // Cold-start := labels file exists but has zero labels (or zero joinable
  // labels). We detect by reading labels here (the eval-harness will do it
  // again per-candidate; that's OK — labels are small relative to recall).
  // We do NOT count "labels file missing" as cold-start; that's the
  // canonical hard-fail mode of run-held-out-eval.mjs and we let evaluate()
  // surface the same error.
  if (!existsSync(labelsPath)) {
    const e = new Error(`runCalibration: labelsPath not found: ${labelsPath}`);
    e.code = "CALIBRATION_FILE_MISSING";
    throw e;
  }
  const labels = readJsonl(labelsPath);
  const labelCount = labels.filter(
    (r) => r && typeof r === "object" && r.kind === "held_out_label",
  ).length;

  // Recall log is allowed to be missing — that's a degenerate "no data" path
  // distinct from a missing labels file. We treat zero joinable rows as
  // cold-start too.
  let recallRows = [];
  try {
    if (existsSync(recallLogPath)) recallRows = readJsonl(recallLogPath);
  } catch {
    recallRows = [];
  }

  // ---- 3) Set up scratch dir for re-scored recall logs.
  let createdScratchDir = false;
  let scratch = scratchDir;
  if (typeof scratch !== "string" || scratch.length === 0) {
    scratch = mkdtempSync(join(tmpdir(), "memory-system-calibration-"));
    createdScratchDir = true;
  }

  const searchLog = [];
  let baselineMetrics = null;
  let bestResult = { ok: false, caps: normBaseline, metrics: null };

  try {
    // ---- 4) Always evaluate the baseline first, even in cold-start.
    //
    // In cold-start the baseline metrics will be {n_labels_used: 0, recall_at_12: 0, ...}
    // — we still report them so the operator can see "the calibration ran,
    // the corpus is empty, here are the zeroes." This is more honest than
    // skipping the eval entirely.
    {
      const baselinePath = writeRescoredRecallLog({
        scratchDir: scratch,
        recallRows,
        caps: normBaseline,
        rescoreSurfaced: rescore,
      });
      try {
        baselineMetrics = await evaluate({
          labelsPath,
          recallLogPath: baselinePath,
          derivationGraph,
        });
      } finally {
        try { rmSync(baselinePath, { force: true }); } catch { /* noop */ }
      }
      searchLog.push({
        iteration: -1,
        is_baseline: true,
        caps: normBaseline,
        ok: true,
        metrics: baselineMetrics,
      });
      bestResult = {
        ok: true,
        caps: normBaseline,
        metrics: baselineMetrics,
        is_baseline: true,
      };
    }

    // ---- 5) Cold-start short-circuit.
    //
    // If there are no labels at all, the grid sweep has zero signal — every
    // candidate will produce identical (zero) metrics, and picking the
    // candidate that "wins" would be over-fitting noise. The WU requires:
    //   "Cold-start case (no labels) → returns baseline, no change."
    // Same path when the join rate is zero (no recall joins to a label).
    const joinable = baselineMetrics ? baselineMetrics.n_labels_used : 0;
    if (labelCount === 0 || joinable === 0) {
      return {
        best_caps: normBaseline,
        baseline_caps: normBaseline,
        baseline_metrics: baselineMetrics,
        best_metrics: baselineMetrics,
        search_log: searchLog,
        cold_start: true,
        version: CALIBRATION_LOOP_VERSION,
        eval_harness_version: EVAL_HARNESS_VERSION,
        built_at: builtAt,
      };
    }

    // ---- 6) Grid sweep.
    const baselineHarm = baselineMetrics ? baselineMetrics.harm_rate : 1.0;
    for (let i = 0; i < candidates.length; i++) {
      const candidateCaps = normaliseCaps(candidates[i], `gridSpec[${i}]`);
      let candidatePath = null;
      let candidate = { ok: false, caps: candidateCaps, metrics: null };
      try {
        candidatePath = writeRescoredRecallLog({
          scratchDir: scratch,
          recallRows,
          caps: candidateCaps,
          rescoreSurfaced: rescore,
        });
        const metrics = await evaluate({
          labelsPath,
          recallLogPath: candidatePath,
          derivationGraph,
        });
        candidate = { ok: true, caps: candidateCaps, metrics };
      } catch (err) {
        // Defensive: a single bad caps combo cannot kill the search.
        candidate = {
          ok: false,
          caps: candidateCaps,
          metrics: null,
          error: err && err.message,
        };
      } finally {
        if (candidatePath) {
          try { rmSync(candidatePath, { force: true }); } catch { /* noop */ }
        }
      }
      searchLog.push({
        iteration: i,
        is_baseline: false,
        caps: candidateCaps,
        ok: candidate.ok,
        metrics: candidate.metrics,
        error: candidate.error || null,
        harm_constraint_passed: candidate.ok
          ? candidate.metrics.harm_rate <= baselineHarm + CALIBRATION_LOOP_CAPS.HARM_TIE_EPSILON
          : null,
      });
      if (candidateBeats({ candidate, incumbent: bestResult, baselineHarm })) {
        bestResult = candidate;
      }
    }

    // ---- 7) Return the winner. By construction this is either the
    //         baseline (if no candidate beat it under the harm constraint)
    //         or a grid point that strictly improved NDCG@12 without
    //         increasing harm.
    return {
      best_caps: bestResult.caps,
      baseline_caps: normBaseline,
      baseline_metrics: baselineMetrics,
      best_metrics: bestResult.metrics,
      search_log: searchLog,
      cold_start: false,
      version: CALIBRATION_LOOP_VERSION,
      eval_harness_version: EVAL_HARNESS_VERSION,
      built_at: builtAt,
    };
  } finally {
    // Best-effort scratch dir cleanup. Defensive: never let cleanup fail
    // the calibration itself.
    if (createdScratchDir) {
      try { rmSync(scratch, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }
}
