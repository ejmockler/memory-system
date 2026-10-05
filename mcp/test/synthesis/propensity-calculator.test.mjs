// propensity-calculator.test.mjs — Wave 7 SYNTHESIS coverage for the
// synthesis-tier propensity calculator facade
// (F-SYN-OPERATIONAL-propensity-logging-soak).
//
// Coverage matrix (12+ assertions enforced by the goal):
//   1. Module surface exports (VERSION + frozen CAPS).
//   2. PROPENSITY_CAPS values match spec § 3 (TEMPERATURE_TAU=1.0, JITTER_PCT=0.05).
//   3. Empty input → empty output.
//   4. Single candidate → propensity = 1.0 (degenerate softmax).
//   5. Multi-candidate: propensities ∈ (0, 1) for every row.
//   6. Multi-candidate: Σ propensity ≈ 1.0 ± 1e-6 (Plackett-Luce invariant).
//   7. Monotonicity: higher score → higher mean propensity over many seeds
//      (the seed-averaged inequality holds even though a single seed can
//      flip due to ±5% jitter on tied scores).
//   8. Deterministic replay: same {scoredCandidates, jitter_seed} → identical
//      propensity vector.
//   9. Jitter does work: different jitter seeds produce different propensities
//      (not a no-op).
//  10. Output preserves input order + memory_id binding.
//  11. Defensive: non-array input → TypeError.
//  12. Defensive: missing memory_id → TypeError.
//  13. Defensive: non-finite score → TypeError.
//  14. Defensive: scored object missing → TypeError.
//  15. Soak-substrate: 10-candidate softmax with TAU=1.0 places p10 + p90 in
//      the expected wide-distribution band (not collapsed to argmax).
//
// HERMETICITY (standing C-NEW-2 discipline): set MEMORY_ROOT + sub-dirs to
// mkdtemp paths BEFORE any dynamic import of memory-system modules.
//
// Run: node test/synthesis/propensity-calculator.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "memsys-propensity-calc-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

const mod = await import("../../lib/synthesis/propensity-calculator.js");
const { PROPENSITY_VERSION, PROPENSITY_CAPS, computePropensities } = mod;

// ---------------------------------------------------------------------------
// 1. Module surface exports.
// ---------------------------------------------------------------------------
test("module surface: VERSION + frozen CAPS + computePropensities", () => {
  assert.equal(typeof PROPENSITY_VERSION, "string");
  assert.ok(PROPENSITY_VERSION.length > 0, "VERSION must be non-empty");
  assert.equal(typeof PROPENSITY_CAPS, "object");
  assert.ok(Object.isFrozen(PROPENSITY_CAPS), "PROPENSITY_CAPS must be frozen");
  assert.equal(typeof computePropensities, "function");
});

// ---------------------------------------------------------------------------
// 2. CAPS values match the W7 spec contract.
// ---------------------------------------------------------------------------
test("PROPENSITY_CAPS: TAU=1.0 + JITTER_PCT=0.05", () => {
  assert.equal(PROPENSITY_CAPS.TEMPERATURE_TAU, 1.0);
  assert.equal(PROPENSITY_CAPS.JITTER_PCT, 0.05);
});

// ---------------------------------------------------------------------------
// 3. Empty input → empty output.
// ---------------------------------------------------------------------------
test("empty input returns empty output", () => {
  const out = computePropensities([]);
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 0);
});

// ---------------------------------------------------------------------------
// 4. Single candidate → propensity = 1.0.
// ---------------------------------------------------------------------------
test("single candidate: propensity == 1.0 (degenerate softmax)", () => {
  const out = computePropensities([{ memory_id: "mem_a", score: 0.42 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].memory_id, "mem_a");
  assert.equal(out[0].score, 0.42);
  assert.equal(out[0].propensity, 1.0);
});

// ---------------------------------------------------------------------------
// 5 + 6. Multi-candidate: propensities in (0, 1) + sum ≈ 1.
// ---------------------------------------------------------------------------
test("multi-candidate: each propensity ∈ (0, 1); sum ≈ 1.0 ± 1e-6", () => {
  const scored = [
    { memory_id: "mem_a", score: 2.0 },
    { memory_id: "mem_b", score: 1.5 },
    { memory_id: "mem_c", score: 1.0 },
    { memory_id: "mem_d", score: 0.5 },
    { memory_id: "mem_e", score: 0.2 },
  ];
  const out = computePropensities(scored, { jitter_seed: "rec_unit_test_5" });
  assert.equal(out.length, 5);
  let sum = 0;
  for (const r of out) {
    assert.ok(
      Number.isFinite(r.propensity),
      `propensity must be finite, got ${r.propensity}`,
    );
    assert.ok(
      r.propensity > 0 && r.propensity < 1,
      `propensity must be in (0, 1), got ${r.propensity}`,
    );
    sum += r.propensity;
  }
  assert.ok(Math.abs(sum - 1.0) < 1e-6, `sum=${sum} not ≈ 1.0`);
});

// ---------------------------------------------------------------------------
// 7. Monotonicity (over many seeds): higher score → higher mean propensity.
// ---------------------------------------------------------------------------
test("higher score → higher mean propensity across 100 seeds", () => {
  const scored = [
    { memory_id: "mem_lo", score: 0.1 },
    { memory_id: "mem_hi", score: 2.0 },
  ];
  let meanLo = 0;
  let meanHi = 0;
  const N = 100;
  for (let k = 0; k < N; k++) {
    const out = computePropensities(scored, { jitter_seed: `seed_${k}` });
    meanLo += out[0].propensity;
    meanHi += out[1].propensity;
  }
  meanLo /= N;
  meanHi /= N;
  assert.ok(
    meanHi > meanLo,
    `mean(hi)=${meanHi} should exceed mean(lo)=${meanLo}`,
  );
  // The 1.9-unit score gap at TAU=1.0 should give the high-score item a
  // strongly dominant mean propensity; allow generous slack but require the
  // dominance to be meaningful.
  assert.ok(
    meanHi > 0.7,
    `mean(hi)=${meanHi} should dominate at TAU=1.0`,
  );
});

// ---------------------------------------------------------------------------
// 8. Deterministic replay: identical input → identical output.
// ---------------------------------------------------------------------------
test("deterministic replay: same (input, seed) → same propensities", () => {
  const scored = [
    { memory_id: "mem_x", score: 0.9 },
    { memory_id: "mem_y", score: 0.7 },
    { memory_id: "mem_z", score: 0.5 },
  ];
  const a = computePropensities(scored, { jitter_seed: "rec_replay_seed" });
  const b = computePropensities(scored, { jitter_seed: "rec_replay_seed" });
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].memory_id, b[i].memory_id);
    assert.equal(a[i].propensity, b[i].propensity);
  }
});

// ---------------------------------------------------------------------------
// 9. Jitter does work: different seeds produce different propensities.
// ---------------------------------------------------------------------------
test("jitter is non-trivial: different seeds → different propensities", () => {
  const scored = [
    { memory_id: "mem_p", score: 0.6 },
    { memory_id: "mem_q", score: 0.6 },
    { memory_id: "mem_r", score: 0.6 },
  ];
  const a = computePropensities(scored, { jitter_seed: "seed_alpha" });
  const c = computePropensities(scored, { jitter_seed: "seed_bravo" });
  let anyDifferent = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].propensity !== c[i].propensity) {
      anyDifferent = true;
      break;
    }
  }
  assert.ok(anyDifferent, "different seeds produced identical propensities");
});

// ---------------------------------------------------------------------------
// 10. Output preserves input order + memory_id binding.
// ---------------------------------------------------------------------------
test("output preserves input order + binds memory_id correctly", () => {
  const scored = [
    { memory_id: "mem_first", score: 0.3 },
    { memory_id: "mem_second", score: 0.4 },
    { memory_id: "mem_third", score: 0.5 },
  ];
  const out = computePropensities(scored, { jitter_seed: "rec_order_test" });
  assert.equal(out[0].memory_id, "mem_first");
  assert.equal(out[1].memory_id, "mem_second");
  assert.equal(out[2].memory_id, "mem_third");
  assert.equal(out[0].score, 0.3);
  assert.equal(out[1].score, 0.4);
  assert.equal(out[2].score, 0.5);
});

// ---------------------------------------------------------------------------
// 11–14. Defensive shape: malformed inputs throw TypeError.
// ---------------------------------------------------------------------------
test("defensive: non-array input throws TypeError", () => {
  assert.throws(() => computePropensities(null), /array/);
  assert.throws(() => computePropensities(undefined), /array/);
  assert.throws(() => computePropensities("foo"), /array/);
  assert.throws(() => computePropensities({ memory_id: "mem_a", score: 1 }), /array/);
});

test("defensive: candidate missing memory_id throws TypeError", () => {
  assert.throws(
    () => computePropensities([{ score: 0.5 }, { memory_id: "mem_b", score: 0.7 }]),
    /memory_id/,
  );
  assert.throws(
    () => computePropensities([{ memory_id: "", score: 0.5 }]),
    /memory_id/,
  );
});

test("defensive: candidate with non-finite score throws TypeError", () => {
  assert.throws(
    () => computePropensities([
      { memory_id: "mem_a", score: 0.5 },
      { memory_id: "mem_b", score: Number.NaN },
    ]),
    /score/,
  );
  assert.throws(
    () => computePropensities([
      { memory_id: "mem_a", score: Number.POSITIVE_INFINITY },
    ]),
    /score/,
  );
});

test("defensive: null / non-object candidate throws TypeError", () => {
  assert.throws(
    () => computePropensities([null, { memory_id: "mem_a", score: 0.5 }]),
    /object/,
  );
  assert.throws(
    () => computePropensities([{ memory_id: "mem_a", score: 0.5 }, 42]),
    /object/,
  );
});

// ---------------------------------------------------------------------------
// 15. Soak-substrate distribution at TAU=1.0 over 10 candidates.
// ---------------------------------------------------------------------------
test("TAU=1.0 over 10 candidates yields a non-degenerate distribution", () => {
  // A linearly-spaced score set at unit increments; at TAU=1.0 the top
  // candidate dominates but the tail still carries non-trivial mass —
  // the spec's exploration prior for the soak substrate.
  const scored = [];
  for (let i = 0; i < 10; i++) {
    scored.push({ memory_id: `mem_${i}`, score: 0.1 * i });
  }
  const out = computePropensities(scored, { jitter_seed: "rec_soak_substrate" });
  assert.equal(out.length, 10);
  // The argmax is index 9 (score 0.9); its propensity must be strictly less
  // than 1.0 (the soak substrate must NOT be quasi-deterministic, per spec
  // § 3.6) — and the tail (index 0) must have a strictly positive propensity
  // (the IPS importance weight prerequisite).
  assert.ok(
    out[9].propensity < 0.95,
    `TAU=1.0 should not collapse to argmax; top p=${out[9].propensity}`,
  );
  assert.ok(
    out[0].propensity > 1e-3,
    `tail must carry strictly positive mass; tail p=${out[0].propensity}`,
  );
  let sum = 0;
  for (const r of out) sum += r.propensity;
  assert.ok(Math.abs(sum - 1.0) < 1e-6, `sum=${sum}`);
});
