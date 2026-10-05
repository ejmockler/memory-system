// damping-reader.js — Wave 12 BEHAVIOR tier.
// (F-SYN-BEHAVIOR-damping-from-recall-log)
//
// Authoritative spec:
//   - docs/specs/synthesis/recall-log-split.md § 4.7 (Authoritative Schema for
//     Consumers) — the envelope shapes consumed here.
//   - docs/specs/synthesis/recall-log-split.md § 6.3 (windowed aggregate) —
//     the linear-decay formula for converting signals into a per-memory
//     damping coefficient.
//
// MISSION
//   The recall scorer's engagementPrior() was a v0 stub (return 0). W12
//   wires it through to the private damping log: each candidate memory_id
//   acquires a `damping_coefficient` ∈ [DAMPING_CAPS.MIN_COEF,
//   DAMPING_CAPS.MAX_COEF] computed from the last WINDOW_DAYS of signals
//   that landed in the damping log for that memory_id.
//
// DIRECTIONAL INTERFACE (mutual-cycle closure with corroboration-propagator):
//   damping-reader → ranking.   Reads signals from damping-log; emits a
//                                bounded scalar to multi-feature-score.
//   damping-reader does NOT read derivation-graph; the corroboration
//   propagator owns that. Both feed multi-feature-score independently.
//   Resolves the W4/W12 mutual-cycle "F-SYN-BEHAVIOR-corroboration ↔
//   F-SYN-BEHAVIOR-damping-from-recall-log" islanding.
//
// CONTRACT
//   computeDampingCoefficient({memory_id, dampingLogPath?, nowMs?})
//     → Promise<number> ∈ [MIN_COEF, MAX_COEF]
//
//   Coefficient interpretation:
//     1.0 == BASE (neutral; no signal or no net effect)
//     <1.0 == damped — many raw surfacings without engagement; surfacing
//             rows in the window contribute -RAW_SURFACING_PENALTY each.
//     >1.0 == boosted — direct engagement / paraphrase / correction signals
//             contribute +ENGAGEMENT_BOOST; engagement_inherited rows
//             contribute a smaller boost (half) so the SPLIT-bounded
//             foundation-side propagation is honored at consumption.
//     MIN_COEF == hard floor returned when an `expunged` tombstone exists
//                 for the memory_id. Silent excise ⇒ ranking-neutral floor.
//
// DEFENSIVE DEGRADATION
//   Any read or parse failure surfaces as BASE (1.0). The scorer's hot
//   path is NEVER blocked by damping-log faults. This mirrors the W7/W9/W11
//   emitter/reader discipline (recall-feedback-emitter.js etc.).
//
// HOOKS NEVER BLOCK RUNTIME
//   The reader is a pure function over the log file; it does not register
//   hooks, it does not invoke producers. Single-producer-per-policy-kind
//   is preserved because we are a CONSUMER, not a writer.

import { readWindowedSignals, SIGNAL_KINDS } from "./damping-log.js";

/** Module version. Bump on any structural change. */
export const DAMPING_READER_VERSION = "v0.1.0";

/** Frozen CAPS for the damping coefficient computation. The values are v0
 *  tunables; the calibration loop (F-SYN-OPERATIONAL-damping-calibration-loop)
 *  owns the version-bump path. Inline literals are forbidden — consumers MUST
 *  import these by name. */
export const DAMPING_CAPS = Object.freeze({
  BASE: 1.0,
  ENGAGEMENT_BOOST: 0.05,
  RAW_SURFACING_PENALTY: -0.02,
  MAX_COEF: 1.5,
  MIN_COEF: 0.5,
  WINDOW_DAYS: 14,
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Map of engagement_class → multiplier on ENGAGEMENT_BOOST.
 *  Direct engagement is unit weight; paraphrase reinforces less strongly;
 *  correction matters more (the user actively corrected the surfaced
 *  memory — signal-rich); dismiss is a negative micro-signal; no_engagement
 *  contributes nothing (the substrate writes it for audit completeness). */
const ENGAGEMENT_CLASS_MULTIPLIER = Object.freeze({
  direct: 1.0,
  paraphrase: 0.7,
  correction: 1.2,
  dismiss: -0.5,
  no_engagement: 0.0,
});

/** Parse ISO-8601 → epoch-ms; null/invalid → null. */
function parseTsEpochMs(ts) {
  if (typeof ts !== "string" || ts === "") return null;
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

/** Clamp a number into [MIN_COEF, MAX_COEF]. */
function clampCoef(x) {
  if (!Number.isFinite(x)) return DAMPING_CAPS.BASE;
  if (x < DAMPING_CAPS.MIN_COEF) return DAMPING_CAPS.MIN_COEF;
  if (x > DAMPING_CAPS.MAX_COEF) return DAMPING_CAPS.MAX_COEF;
  return x;
}

/**
 * Compute the damping coefficient for a single memory_id, derived from the
 * private damping log's last WINDOW_DAYS of signals.
 *
 * Signal contributions:
 *   - surfacing                    → RAW_SURFACING_PENALTY (negative)
 *   - engagement                   → ENGAGEMENT_BOOST * class_multiplier
 *   - engagement_inherited         → ENGAGEMENT_BOOST * 0.5 (half weight;
 *                                    the SPLIT rule lives on the producer
 *                                    side — this half-weight on consumption
 *                                    is an additional bound)
 *   - expunged                     → return MIN_COEF immediately
 *   - crowded_neighborhood         → IGNORED (density-flag-feedback owns it
 *                                    via a separate scorer hook; consuming
 *                                    here would double-count)
 *
 * @param {object} args
 * @param {string} args.memory_id           — candidate memory_id under score.
 * @param {string} [args.dampingLogPath]    — kept for API symmetry / future
 *                                            hermetic-test seam; the substrate
 *                                            currently resolves the path from
 *                                            env (MEMORY_ROOT/POLICY_BASE_DIR).
 * @param {number} [args.nowMs]             — deterministic-test override for
 *                                            "now"; defaults to Date.now().
 * @returns {Promise<number>}  damping coefficient ∈ [MIN_COEF, MAX_COEF].
 */
export async function computeDampingCoefficient({
  memory_id,
  dampingLogPath,
  nowMs,
} = {}) {
  // Argument validation — defensive, returns BASE rather than throwing on
  // bad input so the recall hot path can't be broken by a populator bug.
  if (typeof memory_id !== "string" || memory_id === "") {
    return DAMPING_CAPS.BASE;
  }
  void dampingLogPath; // reserved seam; current substrate is env-pinned.

  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const windowStartMs = now - DAMPING_CAPS.WINDOW_DAYS * MS_PER_DAY;

  let rows;
  try {
    // Include EXPUNGED in the kinds set so the substrate's I12 expunge-bypass
    // is triggered — we need to OBSERVE the tombstone if it exists.
    rows = await readWindowedSignals({
      memory_id,
      signal_kinds: [
        SIGNAL_KINDS.SURFACING,
        SIGNAL_KINDS.ENGAGEMENT,
        SIGNAL_KINDS.ENGAGEMENT_INHERITED,
        SIGNAL_KINDS.EXPUNGED,
      ],
    });
  } catch {
    // Read failure → defensive degradation: BASE.
    return DAMPING_CAPS.BASE;
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return DAMPING_CAPS.BASE;
  }

  let delta = 0;
  for (const r of rows) {
    if (r == null || typeof r !== "object") continue;

    // expunged short-circuits everything — silent excise floor.
    if (r.signal_kind === SIGNAL_KINDS.EXPUNGED) {
      return DAMPING_CAPS.MIN_COEF;
    }

    // Window filter: drop rows older than WINDOW_DAYS.
    const tsMs = parseTsEpochMs(r.ts);
    if (tsMs == null) continue;
    if (tsMs < windowStartMs) continue;
    if (tsMs > now + MS_PER_DAY) continue; // future-skew defense

    if (r.signal_kind === SIGNAL_KINDS.SURFACING) {
      delta += DAMPING_CAPS.RAW_SURFACING_PENALTY;
      continue;
    }

    if (r.signal_kind === SIGNAL_KINDS.ENGAGEMENT) {
      const cls =
        r.fields != null && typeof r.fields.engagement_class === "string"
          ? r.fields.engagement_class
          : "direct";
      const mult =
        Object.prototype.hasOwnProperty.call(ENGAGEMENT_CLASS_MULTIPLIER, cls)
          ? ENGAGEMENT_CLASS_MULTIPLIER[cls]
          : 0;
      delta += DAMPING_CAPS.ENGAGEMENT_BOOST * mult;
      continue;
    }

    if (r.signal_kind === SIGNAL_KINDS.ENGAGEMENT_INHERITED) {
      // Half-weight on inherited engagements — the SPLIT bound already lives
      // on the producer side; consumption-side half-weight is a defensive
      // second cap so a high-fanout reconstruction can't dominate.
      delta += DAMPING_CAPS.ENGAGEMENT_BOOST * 0.5;
      continue;
    }

    // Unknown / unhandled kinds (e.g. crowded_neighborhood snuck in) → skip.
  }

  return clampCoef(DAMPING_CAPS.BASE + delta);
}

// ---------------------------------------------------------------------------
// buildDampingCoefficientMap({nowMs?}) → Promise<Map<memory_id, coefficient>>
//
// N6-stamp-priors: the recall scoring loop must stamp a damping_coefficient on
// EVERY candidate. Calling computeDampingCoefficient() per candidate would
// re-scan the WHOLE damping log once per candidate (readWindowedSignals →
// readAllRowsRaw streams byte 0..EOF every call). At ~1366 candidates that is
// 1366 full-log scans PER recall — a direct latency regression and exactly the
// "new per-query full-ledger scan" the W12 latency work forbids.
//
// This batch builder does ONE scan of the damping log per recall and folds the
// rows into per-memory_id buckets, applying the IDENTICAL per-row contribution
// formula as computeDampingCoefficient (surfacing penalty, engagement-class
// boost, half-weight inherited, window filter, future-skew defense, expunged →
// MIN_COEF short-circuit). The result for any memory_id is byte-identical to
// computeDampingCoefficient({memory_id}); the only difference is the single
// shared scan. Mirrors engagement-prior-reader.buildEngagementPriorMap.
//
// Memory_ids with NO in-window signal are simply ABSENT from the map; the
// recall stamper treats an absent id as the neutral BASE (1.0) — so the map
// only ever carries NON-neutral coefficients, keeping it small and the
// gate-OFF / no-signal path ranking-identical.
//
// DEFENSIVE: any read/parse failure → empty map → every candidate stamps the
// neutral BASE. The recall hot path is NEVER blocked.
//
// @param {object} [args]
// @param {number} [args.nowMs] — deterministic-test "now" override.
// @returns {Promise<Map<string, number>>}
// ---------------------------------------------------------------------------
export async function buildDampingCoefficientMap({ nowMs } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const windowStartMs = now - DAMPING_CAPS.WINDOW_DAYS * MS_PER_DAY;

  let rows;
  try {
    // No memory_id filter → ONE scan returns ALL rows of these kinds. Including
    // EXPUNGED triggers the substrate's expunge-bypass so tombstones surface
    // (we need to OBSERVE them to floor the affected memory_ids).
    rows = await readWindowedSignals({
      signal_kinds: [
        SIGNAL_KINDS.SURFACING,
        SIGNAL_KINDS.ENGAGEMENT,
        SIGNAL_KINDS.ENGAGEMENT_INHERITED,
        SIGNAL_KINDS.EXPUNGED,
      ],
    });
  } catch {
    return new Map();
  }
  if (!Array.isArray(rows) || rows.length === 0) return new Map();

  // First pass: collect expunged memory_ids (tombstone → MIN_COEF floor) and
  // accumulate per-memory_id deltas for the rest. A single linear pass.
  const expunged = new Set();
  const deltaById = new Map();

  for (const r of rows) {
    if (r == null || typeof r !== "object") continue;
    const mid = typeof r.memory_id === "string" ? r.memory_id : null;
    if (mid == null || mid === "") continue;

    if (r.signal_kind === SIGNAL_KINDS.EXPUNGED) {
      expunged.add(mid);
      continue;
    }

    // Window filter: drop rows outside [windowStart, now + 1 day].
    const tsMs = parseTsEpochMs(r.ts);
    if (tsMs == null) continue;
    if (tsMs < windowStartMs) continue;
    if (tsMs > now + MS_PER_DAY) continue;

    let contribution = 0;
    if (r.signal_kind === SIGNAL_KINDS.SURFACING) {
      contribution = DAMPING_CAPS.RAW_SURFACING_PENALTY;
    } else if (r.signal_kind === SIGNAL_KINDS.ENGAGEMENT) {
      const cls =
        r.fields != null && typeof r.fields.engagement_class === "string"
          ? r.fields.engagement_class
          : "direct";
      const mult = Object.prototype.hasOwnProperty.call(
        ENGAGEMENT_CLASS_MULTIPLIER,
        cls,
      )
        ? ENGAGEMENT_CLASS_MULTIPLIER[cls]
        : 0;
      contribution = DAMPING_CAPS.ENGAGEMENT_BOOST * mult;
    } else if (r.signal_kind === SIGNAL_KINDS.ENGAGEMENT_INHERITED) {
      contribution = DAMPING_CAPS.ENGAGEMENT_BOOST * 0.5;
    } else {
      continue; // unknown kind → skip (parity with per-id reader)
    }

    deltaById.set(mid, (deltaById.get(mid) || 0) + contribution);
  }

  const out = new Map();
  // Expunged memory_ids floor to MIN_COEF regardless of accumulated delta —
  // EXACTLY the short-circuit computeDampingCoefficient applies per id.
  for (const mid of expunged) {
    out.set(mid, DAMPING_CAPS.MIN_COEF);
  }
  for (const [mid, delta] of deltaById) {
    if (expunged.has(mid)) continue; // tombstone wins
    const coef = clampCoef(DAMPING_CAPS.BASE + delta);
    // Only carry NON-neutral coefficients; an absent id stamps BASE downstream.
    if (coef !== DAMPING_CAPS.BASE) out.set(mid, coef);
  }
  return out;
}

/** Resolve the damping coefficient for a single memory_id from a prebuilt map.
 *  Absent map / absent id / non-finite → BASE (1.0). Pure; this is what the
 *  recall stamper uses so the hot path does no per-candidate I/O. */
export function dampingCoefficientFromMap(map, memory_id) {
  if (!(map instanceof Map)) return DAMPING_CAPS.BASE;
  if (typeof memory_id !== "string" || memory_id.length === 0) {
    return DAMPING_CAPS.BASE;
  }
  const v = map.get(memory_id);
  if (typeof v !== "number" || !Number.isFinite(v)) return DAMPING_CAPS.BASE;
  return clampCoef(v);
}
