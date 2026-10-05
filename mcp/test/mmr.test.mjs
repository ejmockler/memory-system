// MMR diversification + density_flag + brief-caps tests.
//
// Phase 3 v0 Layer 4. Authoritative shape contract:
// kb/phase3-v0-contracts.md. Spec source: kb/research-retrieval-frontiers.md.
//
// HERMETICITY (standing C-NEW-2 pattern): set MEMORY_ROOT/POLICY/STORAGE/
// LEDGERS dirs to mkdtempSync paths BEFORE any dynamic import of memory-system
// modules, so config.js binds paths inside a tmpdir, NOT the default
// MEMORY_ROOT. mmr.js only depends on validation.js (CAPS) which does not
// touch the filesystem at import time — but we set env vars defensively so
// any future imports through this test file remain hermetic.
//
// Run: node test/mmr.test.mjs
// Exits 0 on pass, non-zero on any failure.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "memsys-mmr-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
mkdirSync(join(TEST_ROOT, "indices"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.on("exit", () => {
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

const { mmrSelect, emitDensityFlag, enforceBriefCaps, _avgPairwiseCosine } =
  await import("../lib/recall/mmr.js");
const { CAPS } = await import("../lib/validation.js");

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`PASS  ${label}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL  ${label}`);
    console.error(`      ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers: unit-norm vectors in a tiny synthetic embedding space.
// ---------------------------------------------------------------------------

/**
 * Build a unit-norm vector along a chosen axis direction. dims=8 keeps the
 * tests fast and human-readable while still exercising the dot-product code.
 *
 * dir is an array of unnormalized components; the result is L2-normalized.
 */
function unitVec(components) {
  const a = Float32Array.from(components);
  let norm = 0;
  for (let i = 0; i < a.length; i += 1) norm += a[i] * a[i];
  norm = Math.sqrt(norm);
  if (norm === 0) throw new Error("unitVec: zero vector");
  for (let i = 0; i < a.length; i += 1) a[i] /= norm;
  return a;
}

// Sanity: a pair with cosine ~0.95.
//   v1 = [1, 0]; v2 = [0.95, sqrt(1 - 0.95^2)]
function nearDuplicatePair() {
  const a = unitVec([1, 0, 0, 0, 0, 0, 0, 0]);
  const t = Math.sqrt(1 - 0.95 * 0.95); // ~0.3122
  const b = unitVec([0.95, t, 0, 0, 0, 0, 0, 0]);
  return [a, b];
}

// Three mutually-orthogonal unit vectors (cosine = 0 between each pair).
// Chosen on axes 3, 4, 5 so they are ALSO orthogonal to nearDuplicatePair()
// (which lives on axes 1, 2). Tests rely on these being orthogonal to
// dupA/dupB as well.
function threeOrthogonal() {
  return [
    unitVec([0, 0, 1, 0, 0, 0, 0, 0]),
    unitVec([0, 0, 0, 1, 0, 0, 0, 0]),
    unitVec([0, 0, 0, 0, 1, 0, 0, 0]),
  ];
}

// ---------------------------------------------------------------------------
// Test 1: lambda=0.7. 2 near-duplicates + 3 diverse. MMR should prefer the
// diverse over the duplicate after the first pick.
// ---------------------------------------------------------------------------
check("T1: lambda=0.7 prefers diverse over near-duplicate", () => {
  const [dupA, dupB] = nearDuplicatePair();
  const [orth1, orth2, orth3] = threeOrthogonal();
  // Give the duplicates the top two scores so a pure-relevance selector
  // would pick both first. MMR with lambda=0.7 must NOT pick dupB second.
  const candidates = [
    { memory_id: "dupA", score: 1.0, embedding_3072: dupA },
    { memory_id: "dupB", score: 0.98, embedding_3072: dupB },
    { memory_id: "orth1", score: 0.9, embedding_3072: orth1 },
    { memory_id: "orth2", score: 0.85, embedding_3072: orth2 },
    { memory_id: "orth3", score: 0.8, embedding_3072: orth3 },
  ];
  const out = mmrSelect({ candidates, K: 5, lambda: 0.7 });
  assert.equal(out.length, 5);
  assert.equal(out[0].memory_id, "dupA", "highest-relevance picked first");
  // After dupA is selected: dupB's MMR = 0.7*0.98 - 0.3*0.95 = 0.401
  //                        orth1's MMR = 0.7*0.9  - 0.3*0    = 0.63
  // So orth1 wins second.
  assert.equal(
    out[1].memory_id,
    "orth1",
    `expected orth1 second (diverse), got ${out[1].memory_id}`,
  );
  // positions must be 0..N-1 in selection order
  for (let i = 0; i < out.length; i += 1) {
    assert.equal(out[i].position, i);
  }
});

// ---------------------------------------------------------------------------
// Test 2: lambda=1.0 (pure relevance): returns by score only.
// ---------------------------------------------------------------------------
check("T2: lambda=1.0 returns purely by score", () => {
  const [dupA, dupB] = nearDuplicatePair();
  const [orth1, orth2, orth3] = threeOrthogonal();
  const candidates = [
    { memory_id: "orth1", score: 0.5, embedding_3072: orth1 },
    { memory_id: "dupA", score: 1.0, embedding_3072: dupA },
    { memory_id: "orth2", score: 0.3, embedding_3072: orth2 },
    { memory_id: "dupB", score: 0.95, embedding_3072: dupB },
    { memory_id: "orth3", score: 0.1, embedding_3072: orth3 },
  ];
  const out = mmrSelect({ candidates, K: 5, lambda: 1.0 });
  const ids = out.map((o) => o.memory_id);
  assert.deepEqual(ids, ["dupA", "dupB", "orth1", "orth2", "orth3"]);
});

// ---------------------------------------------------------------------------
// Test 3: lambda=0.0 (pure diversity): selects the most diverse subset
// irrespective of score. First pick (with empty selected set) has zero
// redundancy term, so MMR ties at 0 for all; deterministic tie-break is
// first-occurrence-wins (input order). Subsequent picks maximize -max_sim,
// i.e. minimize max similarity to already-selected. With three mutually
// orthogonal vectors + two near-duplicates of position 0, the diverse
// subset is {orth1, orth2, orth3, ...}.
// ---------------------------------------------------------------------------
check("T3: lambda=0.0 selects diverse subset regardless of score", () => {
  // Cluster: dupA, dupB, near1 all live near axis 1 (pairwise cosines >0.9).
  // Outliers: outX (axis 4), outY (axis 5) — orthogonal to the cluster.
  // dupA has the highest input score so a relevance-driven selector would
  // pick it first. With lambda=0.0 the score is ignored. The empty-selected
  // initial tie is broken by input order, so we put dupA first to make sure
  // the test exercises a non-trivial path: even though dupA is picked first
  // (tie), the next two picks MUST be the orthogonal outliers (not dupB or
  // near1) because pure-diversity penalizes their high similarity to dupA.
  const [dupA, dupB] = nearDuplicatePair();
  const near1 = unitVec([0.92, Math.sqrt(1 - 0.92 * 0.92), 0, 0, 0, 0, 0, 0]);
  const outX = unitVec([0, 0, 0, 1, 0, 0, 0, 0]);
  const outY = unitVec([0, 0, 0, 0, 1, 0, 0, 0]);
  const candidates = [
    { memory_id: "dupA", score: 1.0, embedding_3072: dupA },
    { memory_id: "dupB", score: 0.99, embedding_3072: dupB },
    { memory_id: "near1", score: 0.98, embedding_3072: near1 },
    { memory_id: "outX", score: 0.10, embedding_3072: outX },
    { memory_id: "outY", score: 0.05, embedding_3072: outY },
  ];
  const out = mmrSelect({ candidates, K: 3, lambda: 0.0 });
  const ids = out.map((o) => o.memory_id);
  // Step 0 (empty selected, all MMR = 0): input-order tie-break → dupA.
  // Step 1: max_sim_to_{dupA} for each: dupB=0.95, near1=0.92, outX=0,
  //   outY=0. MMR = -max_sim. outX (0) and outY (0) tie; input-order →
  //   outX wins.
  // Step 2: max_sim to {dupA, outX}: dupB=0.95, near1=0.92, outY=0.
  //   outY wins.
  assert.deepEqual(ids, ["dupA", "outX", "outY"]);
});

// ---------------------------------------------------------------------------
// Test 4: emitDensityFlag thresholds.
// ---------------------------------------------------------------------------
check("T4a: emitDensityFlag avg cosine ~0.9 -> crowded", () => {
  // Build 3 vectors all pairwise ~0.9 apart (cosine).
  // v_i = (cos(theta), sin(theta) along axis i+1). Use small angles so
  // pairwise cosines stay around 0.9.
  const theta = Math.acos(0.9); // ~0.4510 rad; angle from base vector
  // Use simple construction: v1=[1,0,0,...], v2=[0.9, sqrt(0.19), 0,...],
  // v3=[0.9, 0, sqrt(0.19), 0,...]. Cosines: <v1,v2>=0.9, <v1,v3>=0.9,
  // <v2,v3>=0.9*0.9 + 0 + 0 = 0.81. Avg = (0.9+0.9+0.81)/3 = 0.87 > 0.85.
  const t = Math.sqrt(0.19);
  const selected = [
    { embedding_3072: unitVec([1, 0, 0, 0, 0, 0, 0, 0]) },
    { embedding_3072: unitVec([0.9, t, 0, 0, 0, 0, 0, 0]) },
    { embedding_3072: unitVec([0.9, 0, t, 0, 0, 0, 0, 0]) },
  ];
  const flag = emitDensityFlag({
    selected,
    candidates_at_similar_scores: 0,
  });
  assert.equal(flag, "crowded", `expected crowded; got ${flag}`);
});

check("T4b: emitDensityFlag avg cosine ~0.3 with 4 items -> ok", () => {
  // Build 4 vectors with small pairwise cosines (~0.3 average).
  // v1=[1,0,..], v2=[0.3, sqrt(0.91), 0,..], v3=[0.3, 0, sqrt(0.91), 0,..],
  // v4=[0.3, 0, 0, sqrt(0.91), 0,..].
  // Cosines: <v1,vk>=0.3 for k=2,3,4. <vi,vj> for i,j in 2..4 = 0.09.
  // Avg over C(4,2)=6 pairs: (3*0.3 + 3*0.09)/6 = (0.9+0.27)/6 = 0.195 < 0.85.
  const t = Math.sqrt(0.91);
  const selected = [
    { embedding_3072: unitVec([1, 0, 0, 0, 0, 0, 0, 0]) },
    { embedding_3072: unitVec([0.3, t, 0, 0, 0, 0, 0, 0]) },
    { embedding_3072: unitVec([0.3, 0, t, 0, 0, 0, 0, 0]) },
    { embedding_3072: unitVec([0.3, 0, 0, t, 0, 0, 0, 0]) },
  ];
  const flag = emitDensityFlag({
    selected,
    candidates_at_similar_scores: 0,
  });
  assert.equal(flag, "ok", `expected ok; got flag=${flag}`);
});

check("T4c: emitDensityFlag selected.length=2 -> sparse", () => {
  const [a, b] = [
    unitVec([1, 0, 0, 0, 0, 0, 0, 0]),
    unitVec([0, 1, 0, 0, 0, 0, 0, 0]),
  ].map((v) => ({ embedding_3072: v }));
  const flag = emitDensityFlag({
    selected: [a, b],
    candidates_at_similar_scores: 0,
  });
  assert.equal(flag, "sparse");
});

check("T4d: emitDensityFlag candidates_at_similar_scores>6 -> crowded", () => {
  // Even with diverse vectors + healthy item count, the score-tie condition
  // alone triggers "crowded" per the spec.
  const [orth1, orth2, orth3] = threeOrthogonal();
  const selected = [
    { embedding_3072: orth1 },
    { embedding_3072: orth2 },
    { embedding_3072: orth3 },
  ];
  const flag = emitDensityFlag({
    selected,
    candidates_at_similar_scores: 7,
  });
  assert.equal(flag, "crowded");
});

// ---------------------------------------------------------------------------
// Test 5: enforceBriefCaps trims per-item and total char budgets.
// ---------------------------------------------------------------------------
check("T5a: per-item char budget", () => {
  const longContent = "x".repeat(CAPS.RECALL_BRIEF_MAX_CHARS_PER_ITEM + 100);
  const trimmed = enforceBriefCaps([
    { memory_id: "m1", content_excerpt: longContent, score: 0.9 },
  ]);
  assert.equal(trimmed.length, 1);
  assert.equal(
    trimmed[0].content_excerpt.length,
    CAPS.RECALL_BRIEF_MAX_CHARS_PER_ITEM,
  );
  // Other fields preserved.
  assert.equal(trimmed[0].memory_id, "m1");
  assert.equal(trimmed[0].score, 0.9);
});

check("T5b: total char budget caps the list", () => {
  // 10 items each 600 chars = 6000 total. Budget is 4000 → exactly 6 fit,
  // with the 7th truncated to remaining = 4000 - 6*600 = 400, then loop
  // breaks after that partial. So 7 items in output, last is 400 chars.
  const per = CAPS.RECALL_BRIEF_MAX_CHARS_PER_ITEM;
  const items = Array.from({ length: 10 }, (_, i) => ({
    memory_id: `m${i}`,
    content_excerpt: "x".repeat(per),
    score: 1 - i * 0.01,
  }));
  const trimmed = enforceBriefCaps(items);
  // Sum of content_excerpt lengths must be <= MAX_CHARS_TOTAL.
  const totalChars = trimmed.reduce(
    (s, it) => s + it.content_excerpt.length,
    0,
  );
  assert.ok(
    totalChars <= CAPS.RECALL_BRIEF_MAX_CHARS_TOTAL,
    `total ${totalChars} > cap ${CAPS.RECALL_BRIEF_MAX_CHARS_TOTAL}`,
  );
  // Should have included 6 full items + 1 partial = 7.
  assert.equal(trimmed.length, 7);
  assert.equal(trimmed[6].content_excerpt.length, 400);
});

check("T5c: respects maxItems cap", () => {
  // 20 short items, all fit char-wise, but maxItems=12 truncates.
  const items = Array.from({ length: 20 }, (_, i) => ({
    memory_id: `m${i}`,
    content_excerpt: "short",
    score: 1 - i * 0.01,
  }));
  const trimmed = enforceBriefCaps(items);
  assert.equal(trimmed.length, CAPS.RECALL_BRIEF_MAX_ITEMS);
});

// ---------------------------------------------------------------------------
// Defensive: input-validation guards.
// ---------------------------------------------------------------------------
check("guard: mmrSelect rejects lambda out of [0,1]", () => {
  assert.throws(() =>
    mmrSelect({ candidates: [], K: 1, lambda: 1.5 }),
  );
  assert.throws(() =>
    mmrSelect({ candidates: [], K: 1, lambda: -0.1 }),
  );
});

check("guard: mmrSelect handles empty candidates", () => {
  const out = mmrSelect({ candidates: [], K: 12, lambda: 0.7 });
  assert.deepEqual(out, []);
});

check("guard: mmrSelect handles K larger than candidate set", () => {
  const [orth1, orth2] = threeOrthogonal();
  const out = mmrSelect({
    candidates: [
      { memory_id: "a", score: 1, embedding_3072: orth1 },
      { memory_id: "b", score: 0.5, embedding_3072: orth2 },
    ],
    K: 12,
    lambda: 0.7,
  });
  assert.equal(out.length, 2);
});

// White-box: _avgPairwiseCosine on the orthogonal set must be 0.
check("white-box: _avgPairwiseCosine of orthogonal vectors = 0", () => {
  const [a, b, c] = threeOrthogonal();
  const avg = _avgPairwiseCosine([a, b, c]);
  assert.ok(Math.abs(avg) < 1e-6, `expected ~0; got ${avg}`);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall mmr.test.mjs checks passed");
