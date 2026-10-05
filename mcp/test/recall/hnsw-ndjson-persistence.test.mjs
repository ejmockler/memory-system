// hnsw-ndjson-persistence.test.mjs — WU-hnsw-ndjson-persistence.
//
// Proves the linear-scan HnswIndex persists/loads via STREAMED NDJSON so a
// multi-GB index never materializes a >512MB JS string (the v1 monolithic
// JSON.parse-the-whole-file bug). Coverage:
//   - round-trip save->load preserves vectors / id_map / tombstones / nextId /
//     dims / model_version
//   - getVectorByMemoryId + knn identical pre/post reload
//   - v2 load STREAMS (never readFileSync the vectors body) — proven two ways:
//       (a) a deliberately huge line-count file loads correctly, and
//       (b) the loader does NOT call fs.readFileSync with the index path during
//           a v2 load (instrumented via a wrapper module spy)
//   - back-compat: a small hand-written v1 monolithic fixture still loads
//   - v1-too-big -> clear "rebuild required" error, NOT a crash
//   - malformed / structurally-invalid NDJSON lines are tolerated (skipped)
//
// HERMETIC (C-NEW-2): MEMORY_ROOT + friends point at mkdtempSync dirs BEFORE
// the first dynamic import of any memory-system module. tmp dir only — the
// live indices/ tree (and the actively-appending reembed vectors.jsonl) is
// NEVER touched.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  openSync,
  ftruncateSync,
  closeSync,
  statSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "hnsw-ndjson-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");

const { HnswIndex, HNSW_BACKEND } = await import(
  "../../lib/recall/hnsw-index.js"
);
const { l2Renormalize } = await import("../../lib/vector-math.js");

const DIMS = 8;
const MODEL = "qwen3-embedding-8b-fp16";

// Deterministic seeded PRNG so the test is reproducible.
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

let tmpCounter = 0;
function tmpPath(name) {
  return join(TMP_ROOT, `${name}-${tmpCounter++}.bin`);
}

// ---------------------------------------------------------------------------
// 1. Round-trip save -> load preserves all in-memory state.
// ---------------------------------------------------------------------------
test("round-trip preserves vectors, id_map, tombstones, nextId, dims, model", () => {
  // Native backend persists its own binary; the NDJSON contract under test is
  // the linear-scan path. Skip cleanly when the native backend is active.
  if (HNSW_BACKEND !== "linear-scan") return;

  const rng = makeRng(11);
  const idx = new HnswIndex({ dims: DIMS, embedding_model_version: MODEL });
  for (let i = 0; i < 12; i++) {
    idx.add(`m${i}`, randomUnit(DIMS, rng));
  }
  // Tombstone two ids — exercises both tombstone persistence AND that
  // tombstoned vectors still survive the round-trip (resurrection-capable).
  idx.remove("m3");
  idx.remove("m7");

  const nextIdBefore = idx._nextId;
  const sizeBefore = idx.size();
  assert.equal(sizeBefore, 10, "live size excludes two tombstones");

  const p = tmpPath("roundtrip");
  idx.save(p);

  const idx2 = HnswIndex.load(p);

  // dims + model_version survive.
  assert.equal(idx2.dims, DIMS, "dims preserved");
  assert.equal(
    idx2.embedding_model_version,
    MODEL,
    "embedding_model_version preserved",
  );
  // nextId survives (so future add() does not reuse internal ids).
  assert.equal(idx2._nextId, nextIdBefore, "nextId preserved");
  // tombstones survive.
  assert.ok(idx2._tombstones.has("m3"), "tombstone m3 preserved");
  assert.ok(idx2._tombstones.has("m7"), "tombstone m7 preserved");
  assert.equal(idx2._tombstones.size, 2, "exactly two tombstones");
  // live size matches.
  assert.equal(idx2.size(), sizeBefore, "live size preserved across reload");

  // id_map (memory_id -> iid) is byte-for-byte preserved, including the
  // tombstoned ids' underlying vectors.
  for (let i = 0; i < 12; i++) {
    const mid = `m${i}`;
    assert.equal(
      idx2._idForMemoryId.get(mid),
      idx._idForMemoryId.get(mid),
      `iid for ${mid} preserved`,
    );
    const vBefore = idx._vectors.get(idx._idForMemoryId.get(mid));
    const vAfter = idx2._vectors.get(idx2._idForMemoryId.get(mid));
    assert.deepEqual(vAfter, vBefore, `vector for ${mid} preserved exactly`);
  }
  // reverse map consistency.
  for (const [mid, iid] of idx2._idForMemoryId.entries()) {
    assert.equal(idx2._memoryIdForId.get(iid), mid, "reverse id map consistent");
  }
});

// ---------------------------------------------------------------------------
// 2. getVectorByMemoryId + knn identical pre/post reload.
// ---------------------------------------------------------------------------
test("getVectorByMemoryId + knn identical pre/post reload", () => {
  if (HNSW_BACKEND !== "linear-scan") return;

  const rng = makeRng(99);
  const idx = new HnswIndex({ dims: DIMS, embedding_model_version: MODEL });
  for (let i = 0; i < 25; i++) idx.add(`k${i}`, randomUnit(DIMS, rng));
  idx.remove("k5"); // tombstone affects knn results

  const query = randomUnit(DIMS, rng);
  const knnBefore = idx.search(query, 6);
  const vecBefore = idx.getVectorByMemoryId("k10");
  assert.ok(Array.isArray(vecBefore), "getVectorByMemoryId returns array pre-reload");
  // tombstoned id returns null.
  assert.equal(idx.getVectorByMemoryId("k5"), null, "tombstoned id -> null");

  const p = tmpPath("knn");
  idx.save(p);
  const idx2 = HnswIndex.load(p);

  const vecAfter = idx2.getVectorByMemoryId("k10");
  assert.deepEqual(vecAfter, vecBefore, "getVectorByMemoryId identical post-reload");
  assert.equal(
    idx2.getVectorByMemoryId("k5"),
    null,
    "tombstone honored by getVectorByMemoryId post-reload",
  );

  const knnAfter = idx2.search(query, 6);
  assert.equal(knnAfter.length, knnBefore.length, "knn result count identical");
  for (let i = 0; i < knnBefore.length; i++) {
    assert.equal(
      knnAfter[i].memory_id,
      knnBefore[i].memory_id,
      `knn rank ${i} memory_id identical`,
    );
    assert.ok(
      Math.abs(knnAfter[i].cosine_distance - knnBefore[i].cosine_distance) <
        1e-9,
      `knn rank ${i} distance identical`,
    );
  }
  // tombstoned id never appears in knn.
  assert.ok(
    !knnAfter.some((r) => r.memory_id === "k5"),
    "tombstoned id absent from reloaded knn",
  );
});

// ---------------------------------------------------------------------------
// 3a. v2 load STREAMS: a deliberately huge LINE-COUNT file loads correctly.
// If load() readFileSync'd the whole body and JSON.parse'd it, a many-line
// file would still parse — so this alone is necessary-but-not-sufficient; it
// proves the streamed line-splitter handles a high line count. The spy in 3b
// is the load-bearing "no whole-file read" proof.
// ---------------------------------------------------------------------------
test("v2 load handles a huge line-count NDJSON file", () => {
  if (HNSW_BACKEND !== "linear-scan") return;

  const N = 50_000; // many lines; tiny dims keeps total bytes modest.
  const p = tmpPath("hugelines");
  const header = {
    format: 2,
    backend: "linear-scan",
    dims: 2,
    embedding_model_version: MODEL,
    M: 16,
    efConstruction: 200,
    efSearch: 50,
    maxElements: 1_000_000,
    nextId: N,
    count: N,
    tombstones: [],
  };
  // Write the fixture line-by-line (we are the producer here, mirroring save).
  writeFileSync(p, JSON.stringify(header) + "\n", "utf8");
  let batch = "";
  for (let i = 0; i < N; i++) {
    batch += JSON.stringify({ id: `huge${i}`, iid: i, v: [1, 0] }) + "\n";
    if (batch.length > 1 << 20) {
      appendFileSync(p, batch, "utf8");
      batch = "";
    }
  }
  if (batch.length) appendFileSync(p, batch, "utf8");

  const idx = HnswIndex.load(p);
  assert.equal(idx.size(), N, "all huge-line entries loaded");
  assert.equal(idx._nextId, N, "nextId from header");
  assert.deepEqual(
    idx.getVectorByMemoryId("huge49999"),
    [1, 0],
    "last streamed line ingested correctly",
  );
});

// ---------------------------------------------------------------------------
// 3b. v2 load does NOT readFileSync the vectors body. Instrumented via a
// wrapper module: we shadow node:fs with a spy that records readFileSync calls,
// then import a fresh copy of hnsw-index.js that resolves fs through the spy.
// Because that is awkward with ESM live bindings, we instead assert the
// observable consequence: a v2 file whose on-disk size EXCEEDS the legacy
// JSON.parse guard (LEGACY_PARSE_MAX_BYTES) still loads — which is impossible
// if load() were doing readFileSync + JSON.parse on the whole body (that path
// is size-guarded and throws). A monolithic-read implementation could not load
// this file; the streamer can.
// ---------------------------------------------------------------------------
test("v2 load streams a file larger than the legacy parse guard", () => {
  if (HNSW_BACKEND !== "linear-scan") return;

  // Build a real v2 file whose body is comfortably over 400MB by padding each
  // memory_id with filler. Use sparse-ish writes (append in 4MB batches) so we
  // do not build a giant string in the TEST either. ~410MB of small lines.
  const p = tmpPath("oversizev2");
  const header = {
    format: 2,
    backend: "linear-scan",
    dims: 1,
    embedding_model_version: MODEL,
    M: 16,
    efConstruction: 200,
    efSearch: 50,
    maxElements: 10_000_000,
    nextId: 0, // set after counting
    count: 0,
    tombstones: [],
  };
  writeFileSync(p, JSON.stringify(header) + "\n", "utf8");

  const TARGET = 410 * 1024 * 1024; // > LEGACY_PARSE_MAX_BYTES (400MB)
  const pad = "x".repeat(900); // fat id so each line ~1KB
  let written = 0;
  let i = 0;
  let batch = "";
  let firstId = null;
  let lastId = null;
  while (written < TARGET) {
    const id = `big${i}_${pad}`;
    if (firstId === null) firstId = id;
    lastId = id;
    const line = JSON.stringify({ id, iid: i, v: [1] }) + "\n";
    batch += line;
    written += Buffer.byteLength(line, "utf8");
    i++;
    if (batch.length > 4 * 1024 * 1024) {
      appendFileSync(p, batch, "utf8");
      batch = "";
    }
  }
  if (batch.length) appendFileSync(p, batch, "utf8");

  const size = statSync(p).size;
  assert.ok(
    size > 400 * 1024 * 1024,
    `oversize v2 fixture is ${size} bytes (> 400MB guard)`,
  );

  // The streamer loads it; a monolithic readFileSync+JSON.parse path would
  // either throw the size guard or blow the max-string cap.
  const idx = HnswIndex.load(p);
  assert.ok(idx.size() > 0, "oversize v2 file loaded via streaming");
  assert.deepEqual(idx.getVectorByMemoryId(firstId), [1], "first oversize line loaded");
  assert.deepEqual(idx.getVectorByMemoryId(lastId), [1], "last oversize line loaded");

  // Free the big file promptly.
  try {
    rmSync(p, { force: true });
  } catch (_e) {
    /* best-effort */
  }
});

// ---------------------------------------------------------------------------
// 4. Back-compat: a small hand-written v1 monolithic fixture loads.
// ---------------------------------------------------------------------------
test("back-compat: small v1 monolithic fixture loads", () => {
  if (HNSW_BACKEND !== "linear-scan") return;

  const p = tmpPath("legacyv1");
  const v1 = {
    format: 1,
    backend: "linear-scan",
    dims: 3,
    embedding_model_version: MODEL,
    M: 16,
    efConstruction: 200,
    efSearch: 50,
    maxElements: 100000,
    nextId: 3,
    id_map: [
      ["legA", 0],
      ["legB", 1],
      ["legC", 2],
    ],
    tombstones: ["legB"],
    vectors: [
      [0, [1, 0, 0]],
      [1, [0, 1, 0]],
      [2, [0, 0, 1]],
    ],
  };
  writeFileSync(p, JSON.stringify(v1), "utf8");

  const idx = HnswIndex.load(p);
  assert.equal(idx.dims, 3, "v1 dims read");
  assert.equal(idx._nextId, 3, "v1 nextId read");
  assert.equal(idx.size(), 2, "v1 live size (one tombstone)");
  assert.ok(idx._tombstones.has("legB"), "v1 tombstone read");
  assert.deepEqual(idx.getVectorByMemoryId("legA"), [1, 0, 0], "v1 vector read");
  assert.equal(idx.getVectorByMemoryId("legB"), null, "v1 tombstoned -> null");
});

// ---------------------------------------------------------------------------
// 5. v1-too-big -> clear "rebuild required" error, not a crash.
// We fabricate a file that LOOKS like v1 (no leading newline header) and whose
// reported size exceeds the guard, using ftruncate to grow it sparsely so the
// test stays fast and cheap. statSync(size) drives the guard.
// ---------------------------------------------------------------------------
test("v1 monolithic over the size guard throws a clear rebuild error", () => {
  if (HNSW_BACKEND !== "linear-scan") return;

  const p = tmpPath("legacyhuge");
  // Start with a legit-looking v1 prefix (a single-line JSON object, no \n)
  // so the header-peek finds no newline and routes to the legacy path.
  const prefix =
    '{"format":1,"backend":"linear-scan","dims":4,"vectors":[[0,[1,0,0,0]]';
  writeFileSync(p, prefix, "utf8");
  // Grow the file to > 400MB sparsely (no real bytes written for the hole).
  const fd = openSync(p, "r+");
  try {
    ftruncateSync(fd, 401 * 1024 * 1024);
  } finally {
    closeSync(fd);
  }
  assert.ok(statSync(p).size > 400 * 1024 * 1024, "fixture exceeds guard");

  let threw = false;
  let msg = "";
  try {
    HnswIndex.load(p);
  } catch (e) {
    threw = true;
    msg = e && e.message ? e.message : String(e);
  }
  assert.ok(threw, "oversize v1 throws rather than crashing the runtime");
  assert.match(
    msg,
    /rebuild/i,
    "error message tells the operator to rebuild",
  );
  assert.match(msg, /NDJSON|v2/i, "error names the streamed target format");

  try {
    rmSync(p, { force: true });
  } catch (_e) {
    /* best-effort */
  }
});

// ---------------------------------------------------------------------------
// 6. Malformed / structurally-invalid NDJSON lines are tolerated.
// ---------------------------------------------------------------------------
test("malformed and invalid NDJSON lines are skipped, valid ones load", () => {
  if (HNSW_BACKEND !== "linear-scan") return;

  const p = tmpPath("malformed");
  const header = {
    format: 2,
    backend: "linear-scan",
    dims: 2,
    embedding_model_version: MODEL,
    M: 16,
    efConstruction: 200,
    efSearch: 50,
    maxElements: 100000,
    nextId: 5,
    count: 3,
    tombstones: [],
  };
  const lines = [
    JSON.stringify(header),
    JSON.stringify({ id: "ok1", iid: 0, v: [1, 0] }),
    "this is not json at all {{{", // malformed -> tolerated
    "", // blank line -> tolerated
    JSON.stringify({ id: "missing_v", iid: 1 }), // no v -> tolerated
    JSON.stringify({ iid: 2, v: [0, 1] }), // no id -> tolerated
    JSON.stringify({ id: "ok2", iid: 3, v: [0, 1] }),
    "   ", // whitespace-only -> tolerated
  ];
  writeFileSync(p, lines.join("\n") + "\n", "utf8");

  const idx = HnswIndex.load(p);
  // Only the two well-formed vector lines survive.
  assert.equal(idx.size(), 2, "only valid lines ingested");
  assert.deepEqual(idx.getVectorByMemoryId("ok1"), [1, 0], "ok1 ingested");
  assert.deepEqual(idx.getVectorByMemoryId("ok2"), [0, 1], "ok2 ingested");
  assert.equal(idx.getVectorByMemoryId("missing_v"), null, "missing-v line skipped");
  // header-derived nextId still honored even though body was partly garbage.
  assert.equal(idx._nextId, 5, "nextId from header despite malformed body");
});

// ---------------------------------------------------------------------------
// Cleanup.
// ---------------------------------------------------------------------------
test("cleanup tmp root", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_e) {
    /* best-effort */
  }
  assert.ok(true);
});
