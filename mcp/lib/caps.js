// Central library caps for ingest-side floor/ceiling enforcement.
//
// This module is the canonical home for *global* numeric caps that live
// outside the per-source structural-rule table in lib/validation.js. The
// V-layer CAPS (lib/validation.js) is FROZEN at R25 ship and carries the
// per-source structural-rule bands; this file holds the cross-cutting
// floor cap that Layer-2 (salience promotion) consults regardless of
// which source produced the row.
//
// F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION (Wave-5 residual closeout):
//   The W5 review flagged that per-source structural_score band logic was
//   re-implemented in 9 Stage-0 modules with no single source of truth.
//   The companion central computation helper now lives in
//   lib/ingest/structural-score.js (computeStructuralScore). This module
//   complements that helper by exposing the *floor cap* — a single global
//   value the salience scorer can floor structural_score against before
//   promotion. Centralising the cap means recalibration is a one-place
//   edit; per-source bands stay as defense-in-depth overrides.
//
// Activation discipline (critic-modified):
//   The floor cap MUST remain disabled (effectively 0.0) until the
//   shadow-pass measurement in F-META-SALIENCE-RECALIBRATION-PLAN
//   completes and the operator signs off on the floor value derived from
//   N=500 reviewed rows. Premature activation drops content silently.
//
//   Activation is env-gated:
//     MEMORY_STRUCTURAL_FLOOR_ENABLED=1     → reads MEMORY_STRUCTURAL_FLOOR_VALUE
//                                              (default 0.05 if enabled but
//                                              value is absent/invalid).
//     MEMORY_STRUCTURAL_FLOOR_ENABLED unset → returns 0.0 (no-op floor).
//
//   The export is a function (getMinPromoteStructuralScore) and a getter
//   constant (MIN_PROMOTE_STRUCTURAL_SCORE) read at module import time.
//   The getter is sufficient for production (env vars are stable across
//   a daemon's lifetime); the function form exists for tests that toggle
//   env vars between assertions.

const FLOOR_ENV_FLAG = "MEMORY_STRUCTURAL_FLOOR_ENABLED";
const FLOOR_ENV_VALUE = "MEMORY_STRUCTURAL_FLOOR_VALUE";
const DEFAULT_FLOOR_WHEN_ENABLED = 0.05;

// getMinPromoteStructuralScore — read the current env-gated floor. Reads
// process.env at every call so tests can toggle the flag between
// assertions without re-importing. Production daemons read the env once
// at startup via the MIN_PROMOTE_STRUCTURAL_SCORE constant below.
export function getMinPromoteStructuralScore() {
  if (typeof process === "undefined" || !process.env) return 0.0;
  if (process.env[FLOOR_ENV_FLAG] !== "1") return 0.0;
  const raw = process.env[FLOOR_ENV_VALUE];
  if (typeof raw !== "string" || raw.length === 0) {
    return DEFAULT_FLOOR_WHEN_ENABLED;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return DEFAULT_FLOOR_WHEN_ENABLED;
  }
  return parsed;
}

// MIN_PROMOTE_STRUCTURAL_SCORE — module-load-time snapshot of the floor.
// Most callers should consume this constant; tests that toggle the env
// between assertions should call getMinPromoteStructuralScore() directly.
//
// Default: 0.0 (no-op floor) per the activation discipline above.
export const MIN_PROMOTE_STRUCTURAL_SCORE = getMinPromoteStructuralScore();
