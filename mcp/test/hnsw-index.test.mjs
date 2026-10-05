// hnsw-index.test.mjs — Phase 3 v0 hnsw-index unit tests.
//
// HERMETIC (C-NEW-2 pattern): set MEMORY_ROOT and friends to mkdtempSync
// paths BEFORE dynamic import of memory-system modules. The hnsw-index does
// not itself read from MEMORY_ROOT, but its import chain pulls in
// gemini-client which is conservative about config sourcing — and the rest
// of the test suite uses the same pattern.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-hnsw-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");

// Dynamic import AFTER env override.
const { HnswIndex, HNSW_BACKEND } = await import("../lib/recall/hnsw-index.js");
const { l2Renormalize } = await import("../lib/vector-math.js");

// ---------------------------------------------------------------------------
// Ad-hoc test harness (matches sibling test/*.test.mjs style).
// ---------------------------------------------------------------------------
let failures = 0;
let passes = 0;

function pass(label) {
  passes++;
  console.log(`  pass: ${label}`);
}
function fail(label, err) {
  failures++;
  console.log(`  FAIL: ${label}`);
  if (err) console.log(`        ${err && err.stack ? err.stack : err}`);
}
async function test(label, fn) {
  console.log(`test: ${label}`);
  try {
    await fn();
  } catch (err) {
    fail(label, err);
  }
}

// Deterministic seeded PRNG (xorshift32) so the test is reproducible and
// independent of the global Math.random state.
function makeRng(seed) {
  let s = seed | 0;
  if (s === 0) s = 1;
  return function () {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    // Map to [0,1).
    return ((s >>> 0) % 1_000_003) / 1_000_003;
  };
}

function randomUnit(dims, rng) {
  const v = new Array(dims);
  for (let i = 0; i < dims; i++) v[i] = rng() * 2 - 1;
  return l2Renormalize(v);
}

// Generate two vectors close in cosine space: produce a base unit vector
// then add small noise + renormalize.
function nearbyUnit(base, rng, noise) {
  const v = new Array(base.length);
  for (let i = 0; i < base.length; i++) {
    v[i] = base[i] + (rng() * 2 - 1) * noise;
  }
  return l2Renormalize(v);
}

const DIMS = 768;
const MODEL = "gemini-embedding-001";

// ---------------------------------------------------------------------------
// Test 5 (printed first for visibility): backend reporting.
// ---------------------------------------------------------------------------
await test("T5: HNSW_BACKEND reported correctly", async () => {
  if (HNSW_BACKEND !== "hnswlib-node" && HNSW_BACKEND !== "linear-scan") {
    fail(`T5: HNSW_BACKEND = "${HNSW_BACKEND}", expected one of hnswlib-node | linear-scan`);
    return;
  }
  pass(`T5: HNSW_BACKEND = "${HNSW_BACKEND}"`);
});

// ---------------------------------------------------------------------------
// Test 1: 10 vectors with known cosine relationships; top-3 includes correct
// memories.
//
// Construction: 3 "cluster centers" + a query. Each cluster has 3-4 nearby
// vectors. Query is built nearby to cluster A. Expect top-3 to be entirely
// from cluster A.
// ---------------------------------------------------------------------------
await test("T1: top-3 includes correct memories on known cosine layout", async () => {
  const rng = makeRng(42);
  const idx = new HnswIndex({ dims: DIMS, embedding_model_version: MODEL });

  const centerA = randomUnit(DIMS, rng);
  const centerB = randomUnit(DIMS, rng);
  const centerC = randomUnit(DIMS, rng);

  // 4 near A, 3 near B, 3 near C — 10 vectors total.
  const items = [];
  for (let i = 0; i < 4; i++) {
    items.push({ memory_id: `A${i}`, vector: nearbyUnit(centerA, rng, 0.05) });
  }
  for (let i = 0; i < 3; i++) {
    items.push({ memory_id: `B${i}`, vector: nearbyUnit(centerB, rng, 0.05) });
  }
  for (let i = 0; i < 3; i++) {
    items.push({ memory_id: `C${i}`, vector: nearbyUnit(centerC, rng, 0.05) });
  }
  idx.addBulk(items);

  if (idx.size() !== 10) {
    fail(`T1: size = ${idx.size()}, expected 10`);
    return;
  }

  // Query: a small perturbation of centerA, distinct from any indexed point.
  const query = nearbyUnit(centerA, rng, 0.05);
  const results = idx.search(query, 3);

  if (results.length !== 3) {
    fail(`T1: results.length = ${results.length}, expected 3`);
    return;
  }
  // Every top-3 hit should be from cluster A.
  const allA = results.every((r) => r.memory_id.startsWith("A"));
  if (!allA) {
    fail(`T1: top-3 not all from cluster A: ${results.map((r) => r.memory_id).join(",")}`);
    return;
  }
  // Ranks must be 0,1,2.
  for (let i = 0; i < 3; i++) {
    if (results[i].rank !== i) {
      fail(`T1: rank[${i}] = ${results[i].rank}, expected ${i}`);
      return;
    }
  }
  // Distances must be monotonically non-decreasing.
  for (let i = 1; i < 3; i++) {
    if (results[i].cosine_distance < results[i - 1].cosine_distance - 1e-9) {
      fail(`T1: distances not monotone: ${results.map((r) => r.cosine_distance).join(",")}`);
      return;
    }
  }
  pass(`T1: top-3 from cluster A = ${results.map((r) => r.memory_id).join(",")}; ` +
    `cosine_distances = ${results.map((r) => r.cosine_distance.toFixed(4)).join(",")}`);
});

// ---------------------------------------------------------------------------
// Test 2: save + load round-trip preserves search results.
// ---------------------------------------------------------------------------
await test("T2: save + load round-trip preserves search results", async () => {
  const rng = makeRng(7);
  const idx = new HnswIndex({ dims: DIMS, embedding_model_version: MODEL });
  const items = [];
  for (let i = 0; i < 20; i++) {
    items.push({ memory_id: `m${i}`, vector: randomUnit(DIMS, rng) });
  }
  idx.addBulk(items);

  const query = randomUnit(DIMS, rng);
  const before = idx.search(query, 5);

  const path = join(TMP_ROOT, "test2-index.bin");
  idx.save(path);

  const idx2 = HnswIndex.load(path);
  if (idx2.size() !== idx.size()) {
    fail(`T2: loaded size = ${idx2.size()}, expected ${idx.size()}`);
    return;
  }
  const after = idx2.search(query, 5);

  if (after.length !== before.length) {
    fail(`T2: result count mismatch ${after.length} vs ${before.length}`);
    return;
  }
  for (let i = 0; i < before.length; i++) {
    if (after[i].memory_id !== before[i].memory_id) {
      fail(
        `T2: top-${i + 1} memory_id mismatch ${after[i].memory_id} vs ${before[i].memory_id}`
      );
      return;
    }
    if (Math.abs(after[i].cosine_distance - before[i].cosine_distance) > 1e-6) {
      fail(
        `T2: top-${i + 1} distance mismatch ${after[i].cosine_distance} vs ${before[i].cosine_distance}`
      );
      return;
    }
  }
  pass(`T2: round-trip preserves top-5 ids and distances exactly`);
});

// ---------------------------------------------------------------------------
// Test 3: invariant — adding a non-unit-norm vector throws.
// ---------------------------------------------------------------------------
await test("T3: non-unit-norm vector add throws", async () => {
  const idx = new HnswIndex({ dims: DIMS, embedding_model_version: MODEL });
  // Construct a vector with norm 2 (deliberately off).
  const v = new Array(DIMS).fill(0);
  v[0] = 2;
  let threw = false;
  try {
    idx.add("bad", v);
  } catch (err) {
    threw = true;
    const msg = err && err.message ? err.message : String(err);
    if (!msg.includes("invariant violated") && !msg.includes("unit-norm")) {
      fail(`T3: threw but message did not mention unit-norm invariant: ${msg}`);
      return;
    }
  }
  if (!threw) {
    fail("T3: expected throw on non-unit-norm vector");
    return;
  }
  // Wrong-dim vector also throws.
  let threwDim = false;
  try {
    idx.add("wrongdim", l2Renormalize([1, 2, 3]));
  } catch (_e) {
    threwDim = true;
  }
  if (!threwDim) {
    fail("T3: expected throw on wrong-dim vector");
    return;
  }
  pass("T3: non-unit-norm AND wrong-dim adds throw");
});

// ---------------------------------------------------------------------------
// Test 4: remove(memory_id) filters from subsequent search.
// ---------------------------------------------------------------------------
await test("T4: remove filters from subsequent search", async () => {
  const rng = makeRng(123);
  const idx = new HnswIndex({ dims: DIMS, embedding_model_version: MODEL });
  const center = randomUnit(DIMS, rng);
  const items = [];
  for (let i = 0; i < 5; i++) {
    items.push({ memory_id: `r${i}`, vector: nearbyUnit(center, rng, 0.02) });
  }
  idx.addBulk(items);

  const query = nearbyUnit(center, rng, 0.02);
  const before = idx.search(query, 5);
  if (before.length !== 5) {
    fail(`T4: pre-remove search returned ${before.length}, expected 5`);
    return;
  }
  const top = before[0].memory_id;
  idx.remove(top);
  if (idx.size() !== 4) {
    fail(`T4: size after remove = ${idx.size()}, expected 4`);
    return;
  }
  const after = idx.search(query, 5);
  if (after.length !== 4) {
    fail(`T4: post-remove search returned ${after.length}, expected 4`);
    return;
  }
  for (const r of after) {
    if (r.memory_id === top) {
      fail(`T4: removed memory_id ${top} still appears in results`);
      return;
    }
  }
  // remove() of an absent memory_id is a no-op.
  idx.remove("does-not-exist");

  // Round-trip should preserve tombstone.
  const path = join(TMP_ROOT, "test4-index.bin");
  idx.save(path);
  const idx2 = HnswIndex.load(path);
  const afterReload = idx2.search(query, 5);
  if (afterReload.length !== 4) {
    fail(`T4: reload returned ${afterReload.length} results, expected 4`);
    return;
  }
  for (const r of afterReload) {
    if (r.memory_id === top) {
      fail(`T4: tombstone not preserved across save/load; ${top} reappeared`);
      return;
    }
  }
  pass(`T4: remove + reload tombstone preserved (removed ${top})`);
});

// ---------------------------------------------------------------------------
// Empirical timing: 1000 random unit-norm 768d vectors; 100 queries; median +
// p95 latency.
// ---------------------------------------------------------------------------
await test("Empirical: 1000 vectors, 100 queries, latency", async () => {
  const rng = makeRng(2026);
  const idx = new HnswIndex({ dims: DIMS, embedding_model_version: MODEL });
  const N = 1000;
  const items = new Array(N);
  for (let i = 0; i < N; i++) {
    items[i] = { memory_id: `bench_${i}`, vector: randomUnit(DIMS, rng) };
  }
  const tBuildStart = process.hrtime.bigint();
  idx.addBulk(items);
  const tBuildEnd = process.hrtime.bigint();
  const buildMs = Number(tBuildEnd - tBuildStart) / 1e6;

  const Q = 100;
  const queries = new Array(Q);
  for (let i = 0; i < Q; i++) queries[i] = randomUnit(DIMS, rng);

  const latencies = new Array(Q);
  for (let i = 0; i < Q; i++) {
    const t0 = process.hrtime.bigint();
    idx.search(queries[i], 10);
    const t1 = process.hrtime.bigint();
    latencies[i] = Number(t1 - t0) / 1e6;
  }
  latencies.sort((a, b) => a - b);
  const median = latencies[Math.floor(Q * 0.5)];
  const p95 = latencies[Math.floor(Q * 0.95)];
  const max = latencies[Q - 1];
  console.log(
    `  bench: backend=${HNSW_BACKEND} N=${N} dims=${DIMS} ` +
      `build=${buildMs.toFixed(1)}ms ` +
      `search median=${median.toFixed(3)}ms p95=${p95.toFixed(3)}ms max=${max.toFixed(3)}ms`
  );
  pass(
    `bench: median=${median.toFixed(3)}ms p95=${p95.toFixed(3)}ms (backend=${HNSW_BACKEND})`
  );
});

// ---------------------------------------------------------------------------
// Cleanup + summary.
// ---------------------------------------------------------------------------
try {
  rmSync(TMP_ROOT, { recursive: true, force: true });
} catch (_e) {
  // best-effort
}

console.log("");
console.log(`hnsw-index.test.mjs: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
process.exit(0);
