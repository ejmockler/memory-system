// score-weight-overlay.js — N1-calibration WORKUNIT item (4): the CAPS/env-gated
// READER that lets the recall scorer pick up calibrated live weights from an
// append-only `policy.recall.score_weights` projection WITHOUT ever mutating the
// frozen CAPS.
//
// CONTRACT (the load-bearing safety surface)
//   resolveScoreWeightOverlay({ ledgerPath?, env? }) → {
//     SCORE_WEIGHT_ENGAGEMENT_PRIOR: number,
//     SCORE_WEIGHT_DAMPING_PRIOR: number,
//     SCORE_WEIGHT_CORROBORATION_PRIOR: number,
//     source: "frozen_caps" | "projection",
//     applied_row_id: string | null,
//   }
//
//   GATE OFF (default): returns the frozen CAPS triple verbatim
//   (SCORE_WEIGHT_*_PRIOR, all 0.0 today). source="frozen_caps". This is the
//   byte-identical no-op path: a fresh checkout with no env + no projection
//   behaves exactly as before this WORKUNIT.
//
//   GATE ON (MEMORY_SCORE_WEIGHTS_ENABLED=1): reads the LATEST
//   policy.recall.score_weights row off the ledger and applies it ONLY when the
//   safety predicate holds:
//       reviewed === true            (operator sign-off chokepoint)
//       cold_start === false         (never over-fit on zero data)
//       harm_delta <= 0              (never increase harm vs baseline)
//       ndcg_delta > 0               (must be a measured lift)
//       goldset_headroom_ok === true (anti-circularity: the goldset had real
//                                     baseline-miss headroom)
//   When the predicate fails (or no projection exists) it FALLS BACK to the
//   frozen CAPS triple. The gate is therefore fail-safe in BOTH directions:
//   no env ⇒ frozen; env on but no qualifying projection ⇒ frozen.
//
// THESIS #1: this module RETURNS a value object; it NEVER assigns into CAPS.
// The CAPS object stays Object.frozen. The projection is read-only.
//
// DEFENSIVE DEGRADATION: any IO/parse failure → frozen CAPS triple. The recall
// hot path is never blocked by a projection-log fault.

import { CAPS } from "../validation.js";
import { memoryLedgerPath } from "../config.js";
import {
  appendAwareLedgerProjection,
} from "../synthesis/append-aware-ledger-projection.js";
import {
  SCORE_WEIGHTS_KIND,
  SCORE_WEIGHT_PROJECTION_KEYS,
} from "../synthesis/score-weights-emitter.js";

/** The env flag that gates the live flip. Default OFF until measured lift +
 *  operator sign-off (WORKUNIT discipline). Exported as a single source of
 *  truth so the runbook + tests never grep for the literal. */
export const SCORE_WEIGHTS_ENV = Object.freeze({
  ENABLED: "MEMORY_SCORE_WEIGHTS_ENABLED",
});

const SCORE_WEIGHTS_PROJECTION_NS = "score-weight-overlay";

/** The frozen-CAPS triple — the default no-op weights. Read fresh from CAPS so
 *  if the CAPS default ever changes this tracks it. */
function frozenCapsTriple() {
  return {
    SCORE_WEIGHT_ENGAGEMENT_PRIOR:
      typeof CAPS.SCORE_WEIGHT_ENGAGEMENT_PRIOR === "number" &&
      Number.isFinite(CAPS.SCORE_WEIGHT_ENGAGEMENT_PRIOR)
        ? CAPS.SCORE_WEIGHT_ENGAGEMENT_PRIOR
        : 0,
    SCORE_WEIGHT_DAMPING_PRIOR:
      typeof CAPS.SCORE_WEIGHT_DAMPING_PRIOR === "number" &&
      Number.isFinite(CAPS.SCORE_WEIGHT_DAMPING_PRIOR)
        ? CAPS.SCORE_WEIGHT_DAMPING_PRIOR
        : 0,
    SCORE_WEIGHT_CORROBORATION_PRIOR:
      typeof CAPS.SCORE_WEIGHT_CORROBORATION_PRIOR === "number" &&
      Number.isFinite(CAPS.SCORE_WEIGHT_CORROBORATION_PRIOR)
        ? CAPS.SCORE_WEIGHT_CORROBORATION_PRIOR
        : 0,
  };
}

/** Merge ONE ledger row into the latest-projection holder. Latest-wins by ts
 *  then id (mirrors feature-backfill _mergeBackfillRow). We keep ONLY the most
 *  recent score_weights row regardless of reviewed status; the predicate gate
 *  is applied at resolve time, not at merge time, so a later reviewed:false row
 *  correctly SUPERSEDES (and can disable) an earlier reviewed:true row. */
function _mergeScoreWeightsRow(holder, row) {
  if (
    row == null ||
    row.kind !== "policy" ||
    row.policy_kind !== SCORE_WEIGHTS_KIND
  ) {
    return;
  }
  const prior = holder.latest;
  if (prior == null) {
    holder.latest = row;
    return;
  }
  const priorTs = typeof prior.ts === "string" ? prior.ts : "";
  const rowTs = typeof row.ts === "string" ? row.ts : "";
  if (rowTs > priorTs) {
    holder.latest = row;
  } else if (rowTs === priorTs) {
    const priorId = typeof prior.id === "string" ? prior.id : "";
    const rowId = typeof row.id === "string" ? row.id : "";
    if (rowId > priorId) holder.latest = row;
  }
}

/** Read the latest score_weights projection row off the ledger (or null). */
function latestProjectionRow(ledgerPath) {
  let holder;
  try {
    holder = appendAwareLedgerProjection({
      ledgerPath,
      namespace: SCORE_WEIGHTS_PROJECTION_NS,
      makeEmpty: () => ({ latest: null }),
      applyParsedRow: _mergeScoreWeightsRow,
    });
  } catch {
    return null;
  }
  if (holder == null || typeof holder !== "object") return null;
  return holder.latest != null ? holder.latest : null;
}

/** The safety predicate. A projection is APPLICABLE only if all hold. Exported
 *  for direct unit-testing of the chokepoint. */
export function isProjectionApplicable(row) {
  if (row == null || typeof row !== "object") return false;
  if (row.reviewed !== true) return false;
  if (row.cold_start === true) return false;
  if (typeof row.harm_delta !== "number" || !Number.isFinite(row.harm_delta)) return false;
  if (row.harm_delta > 0) return false;
  if (typeof row.ndcg_delta !== "number" || !Number.isFinite(row.ndcg_delta)) return false;
  if (row.ndcg_delta <= 0) return false;
  if (row.goldset_headroom_ok === false) return false;
  // weights must carry exactly the three live keys, all finite.
  const w = row.weights;
  if (w == null || typeof w !== "object" || Array.isArray(w)) return false;
  for (const k of SCORE_WEIGHT_PROJECTION_KEYS) {
    if (typeof w[k] !== "number" || !Number.isFinite(w[k])) return false;
  }
  return true;
}

/**
 * Resolve the active live-weight triple for the scorer.
 *
 * @param {object} [opts]
 * @param {string} [opts.ledgerPath] — defaults memoryLedgerPath().
 * @param {object} [opts.env]        — env override for tests; defaults process.env.
 * @returns {{
 *   SCORE_WEIGHT_ENGAGEMENT_PRIOR: number,
 *   SCORE_WEIGHT_DAMPING_PRIOR: number,
 *   SCORE_WEIGHT_CORROBORATION_PRIOR: number,
 *   source: "frozen_caps" | "projection",
 *   applied_row_id: string | null,
 * }}
 */
export function resolveScoreWeightOverlay(opts = {}) {
  const frozen = frozenCapsTriple();
  const env =
    opts.env != null && typeof opts.env === "object"
      ? opts.env
      : typeof process !== "undefined" && process.env
        ? process.env
        : {};

  // GATE OFF — default no-op path. Byte-identical to pre-WORKUNIT behavior.
  if (env[SCORE_WEIGHTS_ENV.ENABLED] !== "1") {
    return { ...frozen, source: "frozen_caps", applied_row_id: null };
  }

  let ledgerPath = opts.ledgerPath;
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    try {
      ledgerPath = memoryLedgerPath();
    } catch {
      return { ...frozen, source: "frozen_caps", applied_row_id: null };
    }
  }

  const row = latestProjectionRow(ledgerPath);
  if (!isProjectionApplicable(row)) {
    return { ...frozen, source: "frozen_caps", applied_row_id: null };
  }

  // Applicable — apply the projected weights.
  const out = {
    source: "projection",
    applied_row_id: typeof row.id === "string" ? row.id : null,
  };
  for (const k of SCORE_WEIGHT_PROJECTION_KEYS) out[k] = row.weights[k];
  return out;
}
