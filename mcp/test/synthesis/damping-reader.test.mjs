// damping-reader.test.mjs — Wave 12 BEHAVIOR coverage for the rank-time
// damping coefficient reader (F-SYN-BEHAVIOR-damping-from-recall-log).
//
// Coverage matrix (12+ assertions enforced by the goal):
//   1. Module surface exports (VERSION + frozen DAMPING_CAPS).
//   2. Empty log → BASE (no signal, no ranking change).
//   3. Single surfacing → penalty applied; result < BASE.
//   4. Single direct engagement → boost applied; result > BASE.
//   5. correction engagement weighs MORE than direct.
//   6. paraphrase engagement weighs LESS than direct.
//   7. dismiss engagement is NEGATIVE.
//   8. engagement_inherited contributes a HALF boost.
//   9. expunged tombstone short-circuits to MIN_COEF.
//  10. Out-of-window rows (older than WINDOW_DAYS) are ignored.
//  11. Defensive: non-string memory_id → BASE.
//  12. Defensive: result is always clamped to [MIN_COEF, MAX_COEF].
//  13. Many positive signals saturate at MAX_COEF, many negatives at MIN_COEF.
//
// Run: node --test test/synthesis/damping-reader.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hermetic env BEFORE dynamic import (W2-W11 idiom). The damping-log
// substrate resolves paths from MEMORY_ROOT / POLICY_BASE_DIR.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-damping-reader-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(MEMORY_ROOT, "policy");
mkdirSync(POLICY_DIR, { recursive: true, mode: 0o700 });
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;

const reader = await import("../../lib/synthesis/damping-reader.js");
const dampingLogMod = await import("../../lib/synthesis/damping-log.js");

const {
  DAMPING_READER_VERSION,
  DAMPING_CAPS,
  computeDampingCoefficient,
} = reader;

const dampingLogPath = dampingLogMod.dampingLogPath();

// Reset / clear the damping log between test cases.
function resetLog() {
  writeFileSync(dampingLogPath, "", { mode: 0o600 });
}

// Append a single row directly to the JSONL log. We bypass the substrate's
// public writers because they require many invariants (conversation_id_hash,
// recall_id, etc.) — we want a focused unit test of the READER logic, and
// the substrate's I12 / envelope checks are covered by damping-log.test.mjs.
function appendRow(row) {
  const line = JSON.stringify(row) + "\n";
  appendFileSync(dampingLogPath, line, { mode: 0o600 });
}

function baseEnvelope(extra) {
  return {
    schema_version: 1,
    signal_kind: extra.signal_kind,
    memory_id: extra.memory_id != null ? extra.memory_id : "mem_A",
    turn_window_id: "twid_test_A",
    recall_id: "rec_test_001",
    conversation_id_hash: "cidhash_test_A",
    ts: extra.ts,
    populator_version: "test-writer@1.0.0",
    fields: extra.fields != null ? extra.fields : {},
  };
}

const NOW_MS = Date.parse("2026-06-20T12:00:00Z");
const ONE_HOUR_AGO = new Date(NOW_MS - 60 * 60 * 1000).toISOString();
const TWO_DAYS_AGO = new Date(NOW_MS - 2 * 24 * 60 * 60 * 1000).toISOString();
const FIFTEEN_DAYS_AGO = new Date(NOW_MS - 15 * 24 * 60 * 60 * 1000).toISOString();

// ---------------------------------------------------------------------------
// 1. SURFACE — module exports VERSION + frozen CAPS (W2-W11 module shape).
// ---------------------------------------------------------------------------
test("module surface: VERSION + frozen DAMPING_CAPS", () => {
  assert.equal(DAMPING_READER_VERSION, "v0.1.0", "VERSION pinned");
  assert.equal(typeof computeDampingCoefficient, "function", "exports fn");
  assert.equal(DAMPING_CAPS.BASE, 1.0, "BASE=1.0");
  assert.equal(DAMPING_CAPS.MIN_COEF, 0.5, "MIN_COEF=0.5");
  assert.equal(DAMPING_CAPS.MAX_COEF, 1.5, "MAX_COEF=1.5");
  assert.equal(DAMPING_CAPS.WINDOW_DAYS, 14, "WINDOW_DAYS=14");
  assert.equal(DAMPING_CAPS.ENGAGEMENT_BOOST, 0.05, "ENGAGEMENT_BOOST=0.05");
  assert.equal(DAMPING_CAPS.RAW_SURFACING_PENALTY, -0.02, "SURFACING_PENALTY=-0.02");
  // Frozen: attempts to add new keys silently fail (or throw in strict mode).
  assert.throws(() => {
    "use strict";
    DAMPING_CAPS.NEW_KEY = 1;
  }, "DAMPING_CAPS is frozen");
});

// ---------------------------------------------------------------------------
// 2. EMPTY LOG — no signal, no ranking change.
// ---------------------------------------------------------------------------
test("empty log → BASE", async () => {
  resetLog();
  const coef = await computeDampingCoefficient({
    memory_id: "mem_A",
    nowMs: NOW_MS,
  });
  assert.equal(coef, DAMPING_CAPS.BASE, "empty log returns BASE");
});

// ---------------------------------------------------------------------------
// 3. SURFACING PENALTY — single surfacing pulls coefficient below BASE.
// ---------------------------------------------------------------------------
test("single surfacing → coefficient < BASE (anti-reinforcement)", async () => {
  resetLog();
  appendRow(
    baseEnvelope({
      signal_kind: "surfacing",
      ts: ONE_HOUR_AGO,
      fields: { surfaced_strength: 0.7, position: 0, score: 0.7, propensity: 0.5 },
    }),
  );
  const coef = await computeDampingCoefficient({
    memory_id: "mem_A",
    nowMs: NOW_MS,
  });
  assert.ok(coef < DAMPING_CAPS.BASE, `surfacing damps below BASE; got ${coef}`);
  assert.ok(
    coef >= DAMPING_CAPS.MIN_COEF,
    `coef respects MIN_COEF floor; got ${coef}`,
  );
  assert.equal(
    coef,
    DAMPING_CAPS.BASE + DAMPING_CAPS.RAW_SURFACING_PENALTY,
    "exact penalty",
  );
});

// ---------------------------------------------------------------------------
// 4. ENGAGEMENT BOOST — direct engagement pushes coefficient above BASE.
// ---------------------------------------------------------------------------
test("direct engagement → coefficient > BASE", async () => {
  resetLog();
  appendRow(
    baseEnvelope({
      signal_kind: "engagement",
      ts: ONE_HOUR_AGO,
      fields: {
        engagement_class: "direct",
        engagement_weight: 1.0,
        evidence_span_hash: "h_direct_A",
        detector_version: "test@1.0.0",
      },
    }),
  );
  const coef = await computeDampingCoefficient({
    memory_id: "mem_A",
    nowMs: NOW_MS,
  });
  assert.ok(coef > DAMPING_CAPS.BASE, `direct engagement boosts; got ${coef}`);
  assert.equal(coef, DAMPING_CAPS.BASE + DAMPING_CAPS.ENGAGEMENT_BOOST);
});

// ---------------------------------------------------------------------------
// 5. CORRECTION > DIRECT — class-multiplier ranking.
// ---------------------------------------------------------------------------
test("correction engagement weighs MORE than direct", async () => {
  resetLog();
  appendRow(
    baseEnvelope({
      memory_id: "mem_direct",
      signal_kind: "engagement",
      ts: ONE_HOUR_AGO,
      fields: {
        engagement_class: "direct",
        engagement_weight: 1.0,
        evidence_span_hash: "h_direct_B",
        detector_version: "test@1.0.0",
      },
    }),
  );
  appendRow(
    baseEnvelope({
      memory_id: "mem_correction",
      signal_kind: "engagement",
      ts: ONE_HOUR_AGO,
      fields: {
        engagement_class: "correction",
        engagement_weight: 1.0,
        evidence_span_hash: "h_correction_A",
        detector_version: "test@1.0.0",
      },
    }),
  );
  const direct = await computeDampingCoefficient({
    memory_id: "mem_direct",
    nowMs: NOW_MS,
  });
  const correction = await computeDampingCoefficient({
    memory_id: "mem_correction",
    nowMs: NOW_MS,
  });
  assert.ok(
    correction > direct,
    `correction (${correction}) > direct (${direct})`,
  );
});

// ---------------------------------------------------------------------------
// 6. PARAPHRASE < DIRECT — softer signal.
// ---------------------------------------------------------------------------
test("paraphrase engagement weighs LESS than direct", async () => {
  resetLog();
  appendRow(
    baseEnvelope({
      memory_id: "mem_direct_2",
      signal_kind: "engagement",
      ts: ONE_HOUR_AGO,
      fields: {
        engagement_class: "direct",
        engagement_weight: 1.0,
        evidence_span_hash: "h_direct_C",
        detector_version: "test@1.0.0",
      },
    }),
  );
  appendRow(
    baseEnvelope({
      memory_id: "mem_paraphrase",
      signal_kind: "engagement",
      ts: ONE_HOUR_AGO,
      fields: {
        engagement_class: "paraphrase",
        engagement_weight: 1.0,
        evidence_span_hash: "h_paraphrase_A",
        detector_version: "test@1.0.0",
      },
    }),
  );
  const direct = await computeDampingCoefficient({
    memory_id: "mem_direct_2",
    nowMs: NOW_MS,
  });
  const paraphrase = await computeDampingCoefficient({
    memory_id: "mem_paraphrase",
    nowMs: NOW_MS,
  });
  assert.ok(paraphrase < direct, `paraphrase < direct`);
  assert.ok(paraphrase > DAMPING_CAPS.BASE, `paraphrase still positive`);
});

// ---------------------------------------------------------------------------
// 7. DISMISS — negative micro-signal.
// ---------------------------------------------------------------------------
test("dismiss engagement is NEGATIVE", async () => {
  resetLog();
  appendRow(
    baseEnvelope({
      signal_kind: "engagement",
      ts: ONE_HOUR_AGO,
      fields: {
        engagement_class: "dismiss",
        engagement_weight: 1.0,
        evidence_span_hash: "h_dismiss_A",
        detector_version: "test@1.0.0",
      },
    }),
  );
  const coef = await computeDampingCoefficient({
    memory_id: "mem_A",
    nowMs: NOW_MS,
  });
  assert.ok(coef < DAMPING_CAPS.BASE, `dismiss damps; got ${coef}`);
});

// ---------------------------------------------------------------------------
// 8. INHERITED ENGAGEMENT — half-weight on consumption per the SPLIT bound.
// ---------------------------------------------------------------------------
test("engagement_inherited contributes a HALF boost", async () => {
  resetLog();
  appendRow({
    schema_version: 1,
    signal_kind: "engagement_inherited",
    memory_id: "mem_A",
    turn_window_id: "twid_inherited",
    recall_id: null,
    conversation_id_hash: "cidhash_test_A",
    ts: ONE_HOUR_AGO,
    populator_version: "test-writer@1.0.0",
    fields: {
      inherited_strength: 0.5,
      source_engagement_recall_id: "rec_source_001",
      source_memory_id: "mem_descendant",
      derivation_depth: 1,
    },
  });
  const coef = await computeDampingCoefficient({
    memory_id: "mem_A",
    nowMs: NOW_MS,
  });
  const expected = DAMPING_CAPS.BASE + DAMPING_CAPS.ENGAGEMENT_BOOST * 0.5;
  assert.equal(coef, expected, "inherited engagement → BASE + 0.5 * boost");
  assert.ok(coef > DAMPING_CAPS.BASE, "still net-positive");
});

// ---------------------------------------------------------------------------
// 9. EXPUNGED — short-circuit to MIN_COEF.
// ---------------------------------------------------------------------------
test("expunged tombstone → MIN_COEF", async () => {
  resetLog();
  // Layer some positive signals first; expunged must override.
  appendRow(
    baseEnvelope({
      signal_kind: "engagement",
      ts: ONE_HOUR_AGO,
      fields: {
        engagement_class: "direct",
        engagement_weight: 1.0,
        evidence_span_hash: "h_pre_expunge",
        detector_version: "test@1.0.0",
      },
    }),
  );
  appendRow({
    schema_version: 1,
    signal_kind: "expunged",
    memory_id: "mem_A",
    turn_window_id: "EXPUNGE_GLOBAL",
    recall_id: null,
    conversation_id_hash: null,
    ts: ONE_HOUR_AGO,
    populator_version: "test-writer@1.0.0",
    fields: { excise_reason: "silent_excise" },
  });
  const coef = await computeDampingCoefficient({
    memory_id: "mem_A",
    nowMs: NOW_MS,
  });
  assert.equal(coef, DAMPING_CAPS.MIN_COEF, "expunged → MIN_COEF floor");
});

// ---------------------------------------------------------------------------
// 10. WINDOW FILTER — rows older than WINDOW_DAYS are ignored.
// ---------------------------------------------------------------------------
test("rows older than WINDOW_DAYS are ignored", async () => {
  resetLog();
  appendRow(
    baseEnvelope({
      signal_kind: "engagement",
      ts: FIFTEEN_DAYS_AGO, // out of 14-day window
      fields: {
        engagement_class: "direct",
        engagement_weight: 1.0,
        evidence_span_hash: "h_stale_A",
        detector_version: "test@1.0.0",
      },
    }),
  );
  appendRow(
    baseEnvelope({
      signal_kind: "engagement",
      ts: TWO_DAYS_AGO, // in window
      fields: {
        engagement_class: "direct",
        engagement_weight: 1.0,
        evidence_span_hash: "h_recent_A",
        detector_version: "test@1.0.0",
      },
    }),
  );
  const coef = await computeDampingCoefficient({
    memory_id: "mem_A",
    nowMs: NOW_MS,
  });
  // Only the in-window engagement should count → BASE + 1 * BOOST.
  assert.equal(
    coef,
    DAMPING_CAPS.BASE + DAMPING_CAPS.ENGAGEMENT_BOOST,
    "stale row dropped, in-window row counted",
  );
});

// ---------------------------------------------------------------------------
// 11. DEFENSIVE — non-string memory_id → BASE; null nowMs falls back to Date.now.
// ---------------------------------------------------------------------------
test("defensive: bad inputs → BASE, never throws", async () => {
  resetLog();
  const a = await computeDampingCoefficient({ memory_id: null, nowMs: NOW_MS });
  assert.equal(a, DAMPING_CAPS.BASE, "null memory_id → BASE");
  const b = await computeDampingCoefficient({});
  assert.equal(b, DAMPING_CAPS.BASE, "missing memory_id → BASE");
  const c = await computeDampingCoefficient({
    memory_id: "",
    nowMs: NOW_MS,
  });
  assert.equal(c, DAMPING_CAPS.BASE, "empty memory_id → BASE");
});

// ---------------------------------------------------------------------------
// 12. CLAMP — many positive signals saturate at MAX_COEF; many negatives at
// MIN_COEF (clamp invariant).
// ---------------------------------------------------------------------------
test("result is always clamped to [MIN_COEF, MAX_COEF]", async () => {
  resetLog();
  // 50 correction events (× 1.2 multiplier × 0.05 boost = 3.0 raw) → saturate.
  for (let i = 0; i < 50; i++) {
    appendRow(
      baseEnvelope({
        signal_kind: "engagement",
        ts: ONE_HOUR_AGO,
        fields: {
          engagement_class: "correction",
          engagement_weight: 1.0,
          evidence_span_hash: `h_sat_${i}`,
          detector_version: "test@1.0.0",
        },
      }),
    );
  }
  const high = await computeDampingCoefficient({
    memory_id: "mem_A",
    nowMs: NOW_MS,
  });
  assert.equal(high, DAMPING_CAPS.MAX_COEF, "saturates at MAX_COEF");

  resetLog();
  // 100 surfacing events × -0.02 each = -2.0 raw → should clamp at MIN_COEF.
  for (let i = 0; i < 100; i++) {
    appendRow(
      baseEnvelope({
        signal_kind: "surfacing",
        ts: ONE_HOUR_AGO,
        fields: { surfaced_strength: 0.5, position: 0, score: 0.5, propensity: 0.5 },
      }),
    );
  }
  const low = await computeDampingCoefficient({
    memory_id: "mem_A",
    nowMs: NOW_MS,
  });
  assert.equal(low, DAMPING_CAPS.MIN_COEF, "floors at MIN_COEF");
});
