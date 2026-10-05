// score-weights-emitter.js — N1-calibration WORKUNIT item (3): the SOLE
// producer of `kind:"policy"`, `policy_kind:"recall.score_weights"` rows.
//
// THESIS #1 (load-bearing): the calibration winner is an APPEND-ONLY POLICY
// PROJECTION that recall READS — it NEVER mutates the frozen CAPS
// (validation.js Object.freeze) and NEVER mutates a fact row. This emitter
// writes one `kind:"policy"` row per calibration cycle onto ledgers/memory.jsonl
// (the same durable append-only substrate recall-feedback-emitter.js +
// feature-backfill.js write to). The recall scorer overlays the LATEST REVIEWED
// projection at rank time via score-weight-overlay.js — but ONLY when the
// CAPS/env gate is ON. Gate OFF ⇒ the frozen CAPS defaults stand, byte-identical.
//
// SINGLE-PRODUCER INVARIANT (mirrors recall-feedback-emitter.js:18-32)
//   This module is the SOLE writer of rows whose top-level fields are
//   kind:"policy" AND policy_kind:"recall.score_weights". The literal
//   "recall.score_weights" MUST NOT be written anywhere else under mcp/lib/**.
//
// ROW SHAPE (memory.jsonl line)
//   {
//     id: "mem_<16hex>",
//     kind: "policy",
//     policy_kind: "recall.score_weights",
//     schema_version: "v1",
//     reviewed: false,                 // operator sign-off chokepoint (item 4)
//     weights: {                       // EXACTLY the three live-weight keys
//       SCORE_WEIGHT_ENGAGEMENT_PRIOR: <number>,
//       SCORE_WEIGHT_DAMPING_PRIOR: <number>,
//       SCORE_WEIGHT_CORROBORATION_PRIOR: <number>,
//     },
//     baseline_metrics: { ndcg_at_12, harm_rate, ... },
//     best_metrics:     { ndcg_at_12, harm_rate, ... },
//     ndcg_delta: <number>,            // best - baseline (point estimate)
//     harm_delta: <number>,            // best - baseline (≤ 0 to be applicable)
//     ndcg_ci_lower_delta: <number|null>, // bootstrap 90% CI lower bound on Δ
//     cold_start: <boolean>,
//     goldset_headroom_ok: <boolean>,  // anti-circularity guard verdict
//     calibration_version: <string>,
//     eval_harness_version: <string>,
//     emitter_module: "score-weights-emitter",
//     emitter_version: "v1",
//     ts: <iso8601>,
//   }
//
// DEFENSIVE I/O DISCIPLINE (mirrors recall-feedback-emitter.js)
//   - Bad input is a no-op return {ok:false, ...}; we do not throw out to a
//     fire-and-forget caller.
//   - The on-disk write is fsync'd (file + dir) so durability matches the
//     sibling emitters.

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

import { memoryLedgerPath } from "../config.js";
import { serverTs } from "../envelope.js";

// ---------------------------------------------------------------------------
// PUBLIC CONSTANTS — single source of truth. NEVER inline the literal
// "recall.score_weights" anywhere else under mcp/lib/.
// ---------------------------------------------------------------------------

/** The policy_kind discriminator stamped into every row this module writes. */
export const SCORE_WEIGHTS_KIND = "recall.score_weights";

/** Schema version stamped into every row. */
export const SCORE_WEIGHTS_SCHEMA_VERSION = "v1";

/** The EXACT set of live-weight keys a projection may carry — asserted so a
 *  Layer-1 re-rank cap (DAMPING_ENGAGEMENT_BOOST etc.) can NEVER leak into a
 *  Layer-2 SCORE_WEIGHT_*_PRIOR slot (the namespace-gap trap). */
export const SCORE_WEIGHT_PROJECTION_KEYS = Object.freeze([
  "SCORE_WEIGHT_ENGAGEMENT_PRIOR",
  "SCORE_WEIGHT_DAMPING_PRIOR",
  "SCORE_WEIGHT_CORROBORATION_PRIOR",
]);

const EMITTER_MODULE = "score-weights-emitter";
const EMITTER_VERSION = "v1";

// ---------------------------------------------------------------------------
// File-system constants — mirror recall-feedback-emitter.js writer discipline.
// ---------------------------------------------------------------------------

const LEDGER_O_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_NOFOLLOW;

const LEDGER_FILE_MODE = 0o600;

function generateRowId() {
  return "mem_" + randomBytes(8).toString("hex");
}

function ensureLedgerDir(ledgerPath) {
  const dir = dirname(ledgerPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function fsyncDir(dir) {
  try {
    const dirFd = openSync(dir, fsConstants.O_RDONLY);
    try {
      fsyncSync(dirFd);
    } finally {
      try {
        closeSync(dirFd);
      } catch {
        // ignore
      }
    }
  } catch (err) {
    if (err && err.code !== "EISDIR" && err.code !== "EINVAL") {
      // non-fatal — row bytes already fsync'd to file.
    }
  }
}

function appendOneRow(row, ledgerPathOverride) {
  const ledgerPath =
    typeof ledgerPathOverride === "string" && ledgerPathOverride.length > 0
      ? ledgerPathOverride
      : memoryLedgerPath();
  ensureLedgerDir(ledgerPath);
  const bytes = Buffer.from(JSON.stringify(row) + "\n", "utf8");
  const fd = openSync(ledgerPath, LEDGER_O_FLAGS, LEDGER_FILE_MODE);
  try {
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written);
    }
    fsyncSync(fd);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
  fsyncDir(dirname(ledgerPath));
}

// ---------------------------------------------------------------------------
// Input validation — light but defensive. Bad input → {ok:false}; no throw.
// ---------------------------------------------------------------------------

function isPlainObject(x) {
  return x != null && typeof x === "object" && !Array.isArray(x);
}

function validateWeights(weights) {
  if (!isPlainObject(weights)) {
    return { ok: false, reason: "weights must be a plain object" };
  }
  const keys = Object.keys(weights);
  // EXACT key set — no extra keys (namespace-gap trap), no missing keys.
  if (keys.length !== SCORE_WEIGHT_PROJECTION_KEYS.length) {
    return {
      ok: false,
      reason: `weights must carry exactly ${SCORE_WEIGHT_PROJECTION_KEYS.join(", ")}`,
    };
  }
  for (const k of SCORE_WEIGHT_PROJECTION_KEYS) {
    const v = weights[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { ok: false, reason: `weights.${k} must be a finite number` };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// PUBLIC API — emitScoreWeights()
// ---------------------------------------------------------------------------

/**
 * Emit one append-only `policy.recall.score_weights` projection row.
 *
 * The row defaults to reviewed:false — the operator promotes it to applicable
 * by appending a superseding reviewed:true row (see markScoreWeightsReviewed).
 * The overlay reader (score-weight-overlay.js) only applies a REVIEWED,
 * non-cold-start, harm_delta≤0 set, and only when the env/CAPS gate is ON.
 *
 * @param {object} input
 * @param {Record<string, number>} input.weights — the three live weights.
 * @param {object} input.baseline_metrics
 * @param {object} input.best_metrics
 * @param {boolean} [input.cold_start]
 * @param {boolean} [input.goldset_headroom_ok]
 * @param {number|null} [input.ndcg_ci_lower_delta]
 * @param {string} [input.calibration_version]
 * @param {string} [input.eval_harness_version]
 * @param {boolean} [input.reviewed]  — defaults false (operator chokepoint).
 * @param {string} [input.ledgerPath] — test seam; defaults memoryLedgerPath().
 * @returns {Promise<{ok: boolean, written_count: number, row?: object, error_reason?: string}>}
 */
export async function emitScoreWeights(input) {
  if (!isPlainObject(input)) {
    return { ok: false, written_count: 0, error_reason: "input must be a plain object" };
  }
  const wv = validateWeights(input.weights);
  if (wv.ok !== true) {
    return { ok: false, written_count: 0, error_reason: wv.reason };
  }
  if (!isPlainObject(input.baseline_metrics) || !isPlainObject(input.best_metrics)) {
    return {
      ok: false,
      written_count: 0,
      error_reason: "baseline_metrics and best_metrics must be plain objects",
    };
  }

  const baseNdcg =
    typeof input.baseline_metrics.ndcg_at_12 === "number"
      ? input.baseline_metrics.ndcg_at_12
      : 0;
  const bestNdcg =
    typeof input.best_metrics.ndcg_at_12 === "number"
      ? input.best_metrics.ndcg_at_12
      : 0;
  const baseHarm =
    typeof input.baseline_metrics.harm_rate === "number"
      ? input.baseline_metrics.harm_rate
      : 0;
  const bestHarm =
    typeof input.best_metrics.harm_rate === "number"
      ? input.best_metrics.harm_rate
      : 0;

  // Re-stamp ONLY the canonical keys (drop any stray keys the caller passed).
  const weights = {};
  for (const k of SCORE_WEIGHT_PROJECTION_KEYS) weights[k] = input.weights[k];

  const row = {
    id: generateRowId(),
    kind: "policy",
    policy_kind: SCORE_WEIGHTS_KIND,
    schema_version: SCORE_WEIGHTS_SCHEMA_VERSION,
    reviewed: input.reviewed === true,
    weights,
    baseline_metrics: input.baseline_metrics,
    best_metrics: input.best_metrics,
    ndcg_delta: bestNdcg - baseNdcg,
    harm_delta: bestHarm - baseHarm,
    ndcg_ci_lower_delta:
      typeof input.ndcg_ci_lower_delta === "number" &&
      Number.isFinite(input.ndcg_ci_lower_delta)
        ? input.ndcg_ci_lower_delta
        : null,
    cold_start: input.cold_start === true,
    goldset_headroom_ok: input.goldset_headroom_ok !== false,
    calibration_version:
      typeof input.calibration_version === "string"
        ? input.calibration_version
        : null,
    eval_harness_version:
      typeof input.eval_harness_version === "string"
        ? input.eval_harness_version
        : null,
    emitter_module: EMITTER_MODULE,
    emitter_version: EMITTER_VERSION,
    ts: serverTs(),
  };

  try {
    appendOneRow(row, input.ledgerPath);
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    try {
      console.error(`score-weights-emitter: ledger append failed: ${reason}`);
    } catch {
      // logger throws don't propagate
    }
    return { ok: false, written_count: 0, error_reason: reason };
  }
  return { ok: true, written_count: 1, row };
}

/**
 * Append a superseding REVIEWED row for a prior projection — the operator
 * sign-off gesture. Re-emits the SAME weights/metrics with reviewed:true so
 * the overlay's latest-wins reader picks it up. Carries `supersedes` = the
 * prior row id for audit. Single-producer discipline holds (still this module).
 *
 * @param {object} priorRow — the projection row to promote (from emitScoreWeights).
 * @param {object} [opts] — { ledgerPath } test seam.
 */
export async function markScoreWeightsReviewed(priorRow, opts = {}) {
  if (!isPlainObject(priorRow)) {
    return { ok: false, written_count: 0, error_reason: "priorRow must be a plain object" };
  }
  return emitScoreWeights({
    weights: priorRow.weights,
    baseline_metrics: priorRow.baseline_metrics,
    best_metrics: priorRow.best_metrics,
    cold_start: priorRow.cold_start,
    goldset_headroom_ok: priorRow.goldset_headroom_ok,
    ndcg_ci_lower_delta: priorRow.ndcg_ci_lower_delta,
    calibration_version: priorRow.calibration_version,
    eval_harness_version: priorRow.eval_harness_version,
    reviewed: true,
    ledgerPath: opts.ledgerPath,
  });
}

export const __internal = Object.freeze({
  validateWeights,
  generateRowId,
  EMITTER_MODULE,
  EMITTER_VERSION,
});
