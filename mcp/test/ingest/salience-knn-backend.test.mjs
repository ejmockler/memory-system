// salience-knn-backend.test.mjs — R25 unit tests for _hnsw.js + _corroborate.js.
//
// HERMETIC (C-NEW-2 pattern): mkdtempSync MEMORY_ROOT before dynamic import.
// Tests use a deterministic seeded RNG for unit vectors; embed is stubbed.

import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-salience-knn-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");

const {
  buildIndex,
  knn,
  appendToIndex,
  serializeIndex,
  deserializeIndex,
  saveIndexToDisk,
  loadIndexFromDisk,
  salienceIndexPath,
  buildEmptyIndex,
  HNSW_BACKEND,
} = await import("../../lib/ingest/_hnsw.js");

const { corroborateOrPromote, CORROBORATE_INTERNALS } = await import(
  "../../lib/ingest/_corroborate.js"
);

const { l2Renormalize } = await import("../../lib/vector-math.js");

// ---------------------------------------------------------------------------
// Ad-hoc harness (sibling test pattern).
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

// Deterministic xorshift32.
function makeRng(seed) {
  let s = seed | 0;
  if (s === 0) s = 1;
  return function () {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_003) / 1_000_003;
  };
}
function randomUnit(dims, rng) {
  const v = new Array(dims);
  for (let i = 0; i < dims; i++) v[i] = rng() * 2 - 1;
  return l2Renormalize(v);
}
function nearbyUnit(base, rng, noise) {
  const v = new Array(base.length);
  for (let i = 0; i < base.length; i++) v[i] = base[i] + (rng() * 2 - 1) * noise;
  return l2Renormalize(v);
}

const DIMS = 768;
const MODEL = "gemini-embedding-001";

// ---------------------------------------------------------------------------
// T0: backend banner.
// ---------------------------------------------------------------------------
await test("T0: HNSW_BACKEND advertised", async () => {
  if (HNSW_BACKEND !== "hnswlib-node" && HNSW_BACKEND !== "linear-scan") {
    fail(`T0: HNSW_BACKEND = "${HNSW_BACKEND}"`);
    return;
  }
  pass(`T0: HNSW_BACKEND = "${HNSW_BACKEND}"`);
});

// ---------------------------------------------------------------------------
// T1: buildIndex round-trip.
// ---------------------------------------------------------------------------
await test("T1: buildIndex returns indexHandle with .size() and .search()", async () => {
  const rng = makeRng(1);
  const ids = ["A", "B", "C"];
  const vectors = ids.map(() => randomUnit(DIMS, rng));
  const idx = buildIndex({
    vectors,
    ids,
    opts: { embedding_model_version: MODEL, dims: DIMS },
  });
  if (idx.size() !== 3) {
    fail(`T1: size = ${idx.size()}, expected 3`);
    return;
  }
  pass("T1: buildIndex constructed 3-entry index");
});

// ---------------------------------------------------------------------------
// T2: knn returns ascending distance and the workflow-required shape
// ({ id, cosine_distance }).
// ---------------------------------------------------------------------------
await test("T2: knn returns ascending {id, cosine_distance}", async () => {
  const rng = makeRng(2);
  const center = randomUnit(DIMS, rng);
  const ids = ["near1", "near2", "near3", "far"];
  const vectors = [
    nearbyUnit(center, rng, 0.02),
    nearbyUnit(center, rng, 0.05),
    nearbyUnit(center, rng, 0.1),
    randomUnit(DIMS, rng),
  ];
  const idx = buildIndex({ vectors, ids, opts: { embedding_model_version: MODEL, dims: DIMS } });
  const query = nearbyUnit(center, rng, 0.01);
  const out = knn(idx, query, 3);
  if (out.length !== 3) {
    fail(`T2: knn returned ${out.length}, expected 3`);
    return;
  }
  for (const r of out) {
    if (typeof r.id !== "string" || typeof r.cosine_distance !== "number") {
      fail(`T2: wrong field shape ${JSON.stringify(r)}`);
      return;
    }
  }
  for (let i = 1; i < out.length; i++) {
    if (out[i].cosine_distance < out[i - 1].cosine_distance - 1e-9) {
      fail(`T2: distances not ascending: ${out.map((r) => r.cosine_distance).join(",")}`);
      return;
    }
  }
  if (out[0].id !== "near1") {
    fail(`T2: nearest = ${out[0].id}, expected near1`);
    return;
  }
  pass("T2: knn shape + ordering correct, nearest = near1");
});

// ---------------------------------------------------------------------------
// T3: empty index → knn returns [].
// ---------------------------------------------------------------------------
await test("T3: knn on empty index returns []", async () => {
  const idx = buildEmptyIndex({ embedding_model_version: MODEL, dims: DIMS });
  const rng = makeRng(3);
  const q = randomUnit(DIMS, rng);
  const out = knn(idx, q, 8);
  if (out.length !== 0) {
    fail(`T3: empty index knn returned ${out.length} hits, expected 0`);
    return;
  }
  pass("T3: empty-index knn returns []");
});

// ---------------------------------------------------------------------------
// T4: appendToIndex grows the index incrementally.
// ---------------------------------------------------------------------------
await test("T4: appendToIndex grows live size", async () => {
  const idx = buildEmptyIndex({ embedding_model_version: MODEL, dims: DIMS });
  const rng = makeRng(4);
  appendToIndex(idx, "x1", randomUnit(DIMS, rng));
  appendToIndex(idx, "x2", randomUnit(DIMS, rng));
  if (idx.size() !== 2) {
    fail(`T4: size = ${idx.size()}, expected 2`);
    return;
  }
  pass("T4: appendToIndex added 2 entries");
});

// ---------------------------------------------------------------------------
// T5: serializeIndex / deserializeIndex round-trip via Uint8Array.
// ---------------------------------------------------------------------------
await test("T5: serialize -> deserialize preserves search results", async () => {
  const rng = makeRng(5);
  const center = randomUnit(DIMS, rng);
  const ids = ["s1", "s2", "s3"];
  const vectors = ids.map(() => nearbyUnit(center, rng, 0.05));
  const idx = buildIndex({ vectors, ids, opts: { embedding_model_version: MODEL, dims: DIMS } });

  const query = nearbyUnit(center, rng, 0.02);
  const before = knn(idx, query, 3);

  const buf = serializeIndex(idx);
  if (!(buf instanceof Uint8Array)) {
    fail(`T5: serializeIndex returned ${typeof buf}, expected Uint8Array`);
    return;
  }
  const idx2 = deserializeIndex(buf);
  if (idx2.size() !== 3) {
    fail(`T5: deserialized size = ${idx2.size()}, expected 3`);
    return;
  }
  const after = knn(idx2, query, 3);
  if (after.length !== before.length) {
    fail(`T5: result length mismatch ${after.length} vs ${before.length}`);
    return;
  }
  for (let i = 0; i < before.length; i++) {
    if (before[i].id !== after[i].id) {
      fail(`T5: id[${i}] ${before[i].id} vs ${after[i].id}`);
      return;
    }
    if (Math.abs(before[i].cosine_distance - after[i].cosine_distance) > 1e-9) {
      fail(`T5: distance[${i}] mismatch`);
      return;
    }
  }
  pass("T5: serialize/deserialize preserved 3 search results");
});

// ---------------------------------------------------------------------------
// T6: salienceIndexPath + saveIndexToDisk / loadIndexFromDisk round-trip.
// ---------------------------------------------------------------------------
await test("T6: disk persistence round-trip at canonical path", async () => {
  const rng = makeRng(6);
  const idx = buildIndex({
    vectors: [randomUnit(DIMS, rng), randomUnit(DIMS, rng)],
    ids: ["d1", "d2"],
    opts: { embedding_model_version: MODEL, dims: DIMS },
  });
  const p = salienceIndexPath();
  if (!p.endsWith("/storage/index/salience-knn.bin")) {
    fail(`T6: salienceIndexPath = ${p}; expected …/storage/index/salience-knn.bin`);
    return;
  }
  const written = saveIndexToDisk(idx, p);
  if (written !== p) {
    fail(`T6: saveIndexToDisk returned ${written}, expected ${p}`);
    return;
  }
  const exists = existsSync(p) || existsSync(p + ".meta.json");
  if (!exists) {
    fail(`T6: no file written at ${p}`);
    return;
  }
  const idx2 = loadIndexFromDisk(p);
  if (!idx2 || idx2.size() !== 2) {
    fail(`T6: loadIndexFromDisk failed; size = ${idx2 && idx2.size()}`);
    return;
  }
  pass(`T6: disk round-trip at ${p}`);
});

// ---------------------------------------------------------------------------
// T7: loadIndexFromDisk on missing path returns null (lets caller rebuild).
// ---------------------------------------------------------------------------
await test("T7: loadIndexFromDisk returns null on missing path", async () => {
  const r = loadIndexFromDisk(join(TMP_ROOT, "nonexistent-index.bin"));
  if (r !== null) {
    fail(`T7: expected null, got ${r}`);
    return;
  }
  pass("T7: missing path → null");
});

// ---------------------------------------------------------------------------
// T8: corroborateOrPromote — first-fact-ever path (empty index → PROMOTE
// with novelty=1.0 and side-effect appendToIndex).
// ---------------------------------------------------------------------------
await test("T8: corroborateOrPromote on empty index → PROMOTE novelty=1.0", async () => {
  const idx = buildEmptyIndex({ embedding_model_version: MODEL, dims: DIMS });
  const rng = makeRng(8);
  const vec = randomUnit(DIMS, rng);
  const stub = async (_text) => ({ vector: vec, embedding_model_version: MODEL });
  const thresholds = { "git-log": 0.28 };
  const r = await corroborateOrPromote({
    event: { id: "evt-1", content: "first commit ever", source: "git-log" },
    indexHandle: idx,
    thresholds,
    opts: { embed: stub },
  });
  if (r.decision !== "PROMOTE") {
    fail(`T8: decision = ${r.decision}, expected PROMOTE`);
    return;
  }
  if (r.novelty !== 1.0) {
    fail(`T8: novelty = ${r.novelty}, expected 1.0`);
    return;
  }
  if (!r.appended_to_index || idx.size() !== 1) {
    fail(`T8: index size = ${idx.size()}, expected 1`);
    return;
  }
  pass("T8: empty-index PROMOTE with novelty=1.0 and appended");
});

// ---------------------------------------------------------------------------
// T9: corroborateOrPromote — near-duplicate triggers CORROBORATE, does NOT
// append to index, returns a policy.corroboration event payload.
// ---------------------------------------------------------------------------
await test("T9: near-duplicate triggers CORROBORATE", async () => {
  const idx = buildEmptyIndex({ embedding_model_version: MODEL, dims: DIMS });
  const rng = makeRng(9);
  const anchor = randomUnit(DIMS, rng);
  appendToIndex(idx, "anchor", anchor);
  // Build a near-duplicate vector (cosine_distance well under 0.28 git-log threshold).
  const dup = nearbyUnit(anchor, rng, 0.01);
  const stub = async (_text) => ({ vector: dup, embedding_model_version: MODEL });
  const r = await corroborateOrPromote({
    event: { id: "evt-dup", content: "duplicate-ish commit", source: "git-log" },
    indexHandle: idx,
    thresholds: { "git-log": 0.28 },
    opts: { embed: stub, now: () => "2026-06-02T00:00:00.000Z" },
  });
  if (r.decision !== "CORROBORATE") {
    fail(`T9: decision = ${r.decision}, expected CORROBORATE (distance ${r.cosine_distance})`);
    return;
  }
  if (r.target_id !== "anchor") {
    fail(`T9: target_id = ${r.target_id}, expected "anchor"`);
    return;
  }
  if (idx.size() !== 1) {
    fail(`T9: index grew to ${idx.size()}, expected stays at 1`);
    return;
  }
  const pe = r.policy_event;
  if (!pe || pe.type !== "policy.corroboration") {
    fail(`T9: policy_event missing or wrong type: ${JSON.stringify(pe)}`);
    return;
  }
  if (pe.target_memory_id !== "anchor" || pe.source_ref.source_msg_id !== "evt-dup") {
    fail(`T9: policy_event fields wrong: ${JSON.stringify(pe)}`);
    return;
  }
  pass("T9: CORROBORATE with policy.corroboration event, no index growth");
});

// ---------------------------------------------------------------------------
// T10: corroborateOrPromote — far vector → PROMOTE with novelty in (0,1].
// ---------------------------------------------------------------------------
await test("T10: far vector triggers PROMOTE with bounded novelty", async () => {
  const idx = buildEmptyIndex({ embedding_model_version: MODEL, dims: DIMS });
  const rng = makeRng(10);
  appendToIndex(idx, "anchor", randomUnit(DIMS, rng));
  const far = randomUnit(DIMS, rng);
  const stub = async (_text) => ({ vector: far, embedding_model_version: MODEL });
  const r = await corroborateOrPromote({
    event: { id: "evt-far", content: "unrelated commit", source: "git-log" },
    indexHandle: idx,
    thresholds: { "git-log": 0.28 },
    opts: { embed: stub },
  });
  if (r.decision !== "PROMOTE") {
    fail(`T10: decision = ${r.decision}, expected PROMOTE`);
    return;
  }
  if (!(r.novelty >= 0 && r.novelty <= 1)) {
    fail(`T10: novelty out of [0,1]: ${r.novelty}`);
    return;
  }
  if (idx.size() !== 2) {
    fail(`T10: index size = ${idx.size()}, expected 2`);
    return;
  }
  pass(`T10: PROMOTE novelty=${r.novelty.toFixed(3)}, index grew to 2`);
});

// ---------------------------------------------------------------------------
// T11: embed called exactly once (no double-embed).
// ---------------------------------------------------------------------------
await test("T11: embed called exactly once per candidate", async () => {
  const idx = buildEmptyIndex({ embedding_model_version: MODEL, dims: DIMS });
  const rng = makeRng(11);
  const vec = randomUnit(DIMS, rng);
  let calls = 0;
  const stub = async (_text) => {
    calls++;
    return { vector: vec, embedding_model_version: MODEL };
  };
  await corroborateOrPromote({
    event: { id: "evt", content: "x", source: "git-log" },
    indexHandle: idx,
    thresholds: { "git-log": 0.28 },
    opts: { embed: stub },
  });
  if (calls !== 1) {
    fail(`T11: embed called ${calls} times, expected 1`);
    return;
  }
  pass("T11: embed called exactly once");
});

// ---------------------------------------------------------------------------
// T12: unknown source → thresholdFor throws (per-source contract enforced).
// ---------------------------------------------------------------------------
await test("T12: unknown source throws", async () => {
  const idx = buildEmptyIndex({ embedding_model_version: MODEL, dims: DIMS });
  const rng = makeRng(12);
  const stub = async () => ({ vector: randomUnit(DIMS, rng), embedding_model_version: MODEL });
  let threw = false;
  try {
    await corroborateOrPromote({
      event: { id: "evt", content: "x", source: "unknown-source" },
      indexHandle: idx,
      thresholds: { "git-log": 0.28 },
      opts: { embed: stub },
    });
  } catch (e) {
    threw = true;
    if (!/no CORROBORATE_THRESHOLD entry for source/.test(String(e.message))) {
      fail(`T12: wrong error message: ${e.message}`);
      return;
    }
  }
  if (!threw) {
    fail("T12: expected throw on unknown source");
    return;
  }
  pass("T12: unknown source throws with clear message");
});

// ---------------------------------------------------------------------------
// T13: embedding_model_version cross-check.
// ---------------------------------------------------------------------------
await test("T13: embedding_model_version mismatch throws", async () => {
  const idx = buildEmptyIndex({ embedding_model_version: MODEL, dims: DIMS });
  const rng = makeRng(13);
  const stub = async () => ({
    vector: randomUnit(DIMS, rng),
    embedding_model_version: "different-model",
  });
  let threw = false;
  try {
    await corroborateOrPromote({
      event: { id: "evt", content: "x", source: "git-log" },
      indexHandle: idx,
      thresholds: { "git-log": 0.28 },
      embeddingModelVersion: MODEL,
      opts: { embed: stub },
    });
  } catch (e) {
    threw = true;
    if (!/embedding_model_version/.test(String(e.message))) {
      fail(`T13: wrong error: ${e.message}`);
      return;
    }
  }
  if (!threw) {
    fail("T13: expected throw on version mismatch");
    return;
  }
  pass("T13: embedding_model_version mismatch throws");
});

// ---------------------------------------------------------------------------
// T14: CORROBORATE_INTERNALS exposed for inspection.
// ---------------------------------------------------------------------------
await test("T14: CORROBORATE_INTERNALS frozen + exposes defaults", async () => {
  if (!CORROBORATE_INTERNALS || typeof CORROBORATE_INTERNALS !== "object") {
    fail("T14: CORROBORATE_INTERNALS missing");
    return;
  }
  if (CORROBORATE_INTERNALS.DEFAULT_KNN_K !== 8) {
    fail(`T14: DEFAULT_KNN_K = ${CORROBORATE_INTERNALS.DEFAULT_KNN_K}, expected 8`);
    return;
  }
  if (CORROBORATE_INTERNALS.SALIENCE_VERSION_DEFAULT !== "v1") {
    fail(`T14: SALIENCE_VERSION_DEFAULT = ${CORROBORATE_INTERNALS.SALIENCE_VERSION_DEFAULT}`);
    return;
  }
  if (!Object.isFrozen(CORROBORATE_INTERNALS)) {
    fail("T14: CORROBORATE_INTERNALS not frozen");
    return;
  }
  pass("T14: CORROBORATE_INTERNALS frozen with expected defaults");
});

// ---------------------------------------------------------------------------
// Cleanup + summary.
// ---------------------------------------------------------------------------
rmSync(TMP_ROOT, { recursive: true, force: true });

console.log("");
console.log(`salience-knn-backend: ${passes} pass / ${failures} fail`);
if (failures > 0) {
  process.exit(1);
}
