// Tests for lib/recall/propensity.js — Plackett-Luce softmax + deterministic
// jitter for recall-time propensity logging.
//
// Run: node test/propensity.test.mjs
// Exits 0 on pass, non-zero on any failure.
//
// HERMETICITY (standing C-NEW-2 discipline): set MEMORY_ROOT + sub-dirs to
// mkdtemp paths BEFORE any dynamic import of memory-system modules. Production
// <checkout>/ledgers/* and policy/* MUST remain mtime-unchanged
// across npm test.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "memsys-propensity-test-"));
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

const {
  computePropensities,
  deterministicJitter,
  softmax,
} = await import("../lib/recall/propensity.js");
const { CAPS } = await import("../lib/validation.js");

let failures = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

// ---------------------------------------------------------------------------
// Test 1: identical scores -> near-uniform propensities.
// ---------------------------------------------------------------------------
// If every candidate has the same score, the jitter perturbs slightly but the
// resulting softmax should be close to 1/n for each. At score=1.0 the jitter
// scale is 0.05 (5%), so with tau=0.3 the softmax cannot deviate too far from
// uniform. We assert "near-uniform" within a tolerance derived from the
// max-jitter / tau exponential bound.
run("Test 1: identical scores yield near-uniform propensities", () => {
  const n = 10;
  const scores = new Array(n).fill(1.0);
  const result = computePropensities({
    candidate_scores: scores,
    jitter_seed: "recall_test_1",
  });
  assert.equal(result.length, n);
  const uniform = 1 / n;
  // Tolerance: max relative jitter (5%) divided by tau (0.3) bounds the
  // exponent shift at ~0.17; e^0.17 / e^-0.17 ~ 1.4. So we allow each
  // propensity within +/- 50% of uniform — generous but the test guards
  // against gross drift, not exact equality.
  for (let i = 0; i < n; i++) {
    const p = result[i].propensity;
    assert.ok(p > uniform * 0.5, `propensity[${i}]=${p} too small`);
    assert.ok(p < uniform * 1.5, `propensity[${i}]=${p} too large`);
  }
  let sum = 0;
  for (const r of result) sum += r.propensity;
  assert.ok(Math.abs(sum - 1.0) < 1e-6, `sum=${sum}`);
});

// ---------------------------------------------------------------------------
// Test 2: one very high score -> propensity concentrates near it.
// ---------------------------------------------------------------------------
// With tau=0.3 and a 10x score gap, the top item should dominate. We check
// (a) the top-scoring item has the highest propensity, and (b) it carries
// the bulk of the mass.
run("Test 2: dominant score concentrates propensity", () => {
  const scores = [10.0, 1.0, 1.0, 1.0, 1.0];
  const result = computePropensities({
    candidate_scores: scores,
    jitter_seed: "recall_test_2",
    tau: 0.3,
  });
  assert.equal(result.length, 5);
  // The top item is index 0.
  let maxIdx = 0;
  let maxP = result[0].propensity;
  for (let i = 1; i < result.length; i++) {
    if (result[i].propensity > maxP) {
      maxP = result[i].propensity;
      maxIdx = i;
    }
  }
  assert.equal(maxIdx, 0, `expected top propensity at index 0, got ${maxIdx}`);
  // With (10-1)/0.3 = 30 in the exponent, the top item is overwhelmingly
  // larger than the others. Even with 5% jitter (~+/-0.5 on a score of 10),
  // the exponent gap stays around 25+; concentration > 0.99 is comfortable.
  assert.ok(maxP > 0.99, `expected dominant propensity > 0.99, got ${maxP}`);
  let sum = 0;
  for (const r of result) sum += r.propensity;
  assert.ok(Math.abs(sum - 1.0) < 1e-6, `sum=${sum}`);
});

// ---------------------------------------------------------------------------
// Test 3: deterministic jitter — same seed reproduces; different seed differs.
// ---------------------------------------------------------------------------
run("Test 3: deterministicJitter is reproducible per seed", () => {
  const a = deterministicJitter("seed_alpha", 16, 0.05);
  const b = deterministicJitter("seed_alpha", 16, 0.05);
  const c = deterministicJitter("seed_bravo", 16, 0.05);
  assert.equal(a.length, 16);
  for (let i = 0; i < 16; i++) {
    assert.equal(a[i], b[i], `mismatch at i=${i}`);
  }
  // Different seed must produce different output (at least some indices).
  let anyDifferent = false;
  for (let i = 0; i < 16; i++) {
    if (a[i] !== c[i]) {
      anyDifferent = true;
      break;
    }
  }
  assert.ok(anyDifferent, "different seeds produced identical jitter");
  // Range check: all entries in [-0.05, +0.05].
  for (let i = 0; i < 16; i++) {
    assert.ok(a[i] >= -0.05 && a[i] <= 0.05, `a[${i}]=${a[i]} out of range`);
    assert.ok(c[i] >= -0.05 && c[i] <= 0.05, `c[${i}]=${c[i]} out of range`);
  }
});

// ---------------------------------------------------------------------------
// Test 4: softmax — extreme inputs do not overflow; sum stays 1.
// ---------------------------------------------------------------------------
run("Test 4: softmax handles extreme inputs without overflow", () => {
  const out = softmax([1e6, 0], 1.0);
  assert.equal(out.length, 2);
  for (const v of out) {
    assert.ok(Number.isFinite(v), `softmax produced non-finite: ${v}`);
    assert.ok(v >= 0 && v <= 1, `softmax value out of [0,1]: ${v}`);
  }
  // 1e6 dominates so utterly that index 0 should be ~1, index 1 should be ~0.
  assert.ok(out[0] > 0.999999);
  assert.ok(out[1] < 1e-9);
  const sum = out[0] + out[1];
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `sum=${sum}`);

  // Also verify that very negative scores do not produce NaN.
  const out2 = softmax([-1e6, 0], 1.0);
  let s2 = 0;
  for (const v of out2) {
    assert.ok(Number.isFinite(v));
    s2 += v;
  }
  assert.ok(Math.abs(s2 - 1.0) < 1e-9);

  // tau == 0 must throw.
  assert.throws(() => softmax([1, 2, 3], 0), /tau/);
});

// ---------------------------------------------------------------------------
// Test 5: across 100 recall_id seeds, each distribution sums to 1; entropy
// varies across seeds (i.e. jitter is doing real work, not collapsing).
// ---------------------------------------------------------------------------
run("Test 5: 100 seeds — sums always 1, entropy varies", () => {
  // Use a moderately spread score set so jitter has observable effect on
  // softmax but does not dominate. (All-equal scores would yield identical
  // post-softmax entropy near log(n) regardless of seed.)
  const scores = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
  const entropies = [];
  for (let k = 0; k < 100; k++) {
    const result = computePropensities({
      candidate_scores: scores,
      jitter_seed: `recall_${k}`,
    });
    assert.equal(result.length, scores.length);
    let sum = 0;
    let h = 0;
    for (const r of result) {
      assert.ok(
        Number.isFinite(r.propensity) && r.propensity >= 0 && r.propensity <= 1,
        `bad propensity at k=${k}: ${r.propensity}`,
      );
      sum += r.propensity;
      if (r.propensity > 0) h -= r.propensity * Math.log(r.propensity);
    }
    assert.ok(Math.abs(sum - 1.0) < 1e-6, `seed ${k}: sum=${sum}`);
    entropies.push(h);
  }
  // Entropy must vary across seeds: range > some tiny epsilon. If it didn't,
  // jitter would be a no-op and OPE estimators would lose variance.
  let minE = entropies[0];
  let maxE = entropies[0];
  for (const e of entropies) {
    if (e < minE) minE = e;
    if (e > maxE) maxE = e;
  }
  assert.ok(
    maxE - minE > 1e-6,
    `entropy did not vary across seeds: min=${minE} max=${maxE}`,
  );
});

// ---------------------------------------------------------------------------
// Sanity: CAPS values are as documented (a guard against silent drift if
// validation.js is edited).
// ---------------------------------------------------------------------------
run("CAPS: temperature + jitter constants present", () => {
  assert.equal(CAPS.PROPENSITY_TEMPERATURE_TAU_DEFAULT, 0.3);
  assert.equal(CAPS.PROPENSITY_JITTER_FRACTION, 0.05);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall propensity tests passed");
