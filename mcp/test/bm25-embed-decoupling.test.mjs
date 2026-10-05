import { readFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

// Pin every imported path to a fresh root before config.js is evaluated.
const TEST_ROOT = mkdtempSync(join(tmpdir(), "memory-bm25-decouple-"));
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.INDEX_SAVE_MAX_STALENESS_MS = "600000";
delete process.env.MEMORY_BM25_DECOUPLE_EMBED;
// The operator gate's first-run arm depends on the queryd mode. Pin it to
// in-process so no test here probes for (or talks to) a query daemon; the
// daemon-mode case below flips it explicitly and restores it.
process.env.MEMORY_QUERYD = "off";

for (const dir of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  join(TEST_ROOT, "indices"),
]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

const { appendOperatorFact, standaloneLexicalFirstRun } = await import(
  "../lib/tools/distill-promote-fact.js"
);
const { loadIndices, evictModelIndices, _indexCacheHas } = await import(
  "../lib/recall/index-cache.js"
);
const { _resetQuerydForTest } = await import("../lib/recall/queryd-client.js");
const { CAPS } = await import("../lib/validation.js");

// `active` is re-bound after the cache-eviction cases below (an evicted entry
// is a stale handle); every test reads it at call time.
let active = loadIndices(CAPS.ACTIVE_EMBED_MODEL_VERSION);
const gemini = loadIndices(CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT);

function args(content, vector_4096) {
  return {
    content,
    provenance: {
      agent_id: "bm25-embed-decoupling-test",
      conversation_id: null,
      confidence: "high",
    },
    ...(vector_4096 ? { vector_4096 } : {}),
  };
}

function hasDocument(bm25, memoryId, query) {
  return bm25.search(query, 50).some((row) => row.memory_id === memoryId);
}

test("gate shapes: handler + watermark gates unchanged; operator gate adds only the first-run arm", () => {
  const source = readFileSync(
    new URL("../lib/tools/distill-promote-fact.js", import.meta.url),
    "utf8",
  );
  // The MCP promote handler and the watermark (promoteSourceRow) gates are
  // byte-identical to the pre-first-run shape: embed success OR the rollout
  // flag, nothing else.
  const flaggedGates = source.match(
    /if \(embedOutput\.ok === true \|\| bm25DecoupleEmbedFlagOn\(\)\) \{/g,
  );
  assert.equal(flaggedGates?.length, 2, "handler and watermark gates, unchanged");
  // The operator-put gate is the ONLY one widened, and only by the shared
  // first-run predicate, consulted last.
  const operatorGates = source.match(
    /if \(\s*embedOutput\.ok === true \|\|\s*bm25DecoupleEmbedFlagOn\(\) \|\|\s*\(await standaloneLexicalFirstRun\(\)\)\s*\) \{/g,
  );
  assert.equal(operatorGates?.length, 1, "exactly one operator gate with the first-run arm");
  // The predicate is consulted at exactly one gate in this module.
  assert.equal(
    source.match(/await standaloneLexicalFirstRun\(\)/g)?.length,
    1,
    "the first-run predicate widens one gate only",
  );
  // ...and that one gate is inside appendOperatorFact, not the handler or the
  // watermark entry point.
  const opStart = source.indexOf("export async function appendOperatorFact(");
  const opEnd = source.indexOf("export async function promoteSourceRow(");
  const gateAt = source.indexOf("(await standaloneLexicalFirstRun())");
  assert.ok(opStart > 0 && opEnd > opStart, "both entry points present");
  assert.ok(gateAt > opStart && gateAt < opEnd, "the widened gate lives in appendOperatorFact");
});

test("flag OFF + empty HNSW + in-process (first run): BM25-only add on the ACTIVE model, never the Gemini tree", async () => {
  assert.equal(process.env.MEMORY_BM25_DECOUPLE_EMBED, undefined, "rollout flag is off");
  assert.equal(active.hnsw.size(), 0, "precondition: no vector index");
  assert.equal(await standaloneLexicalFirstRun(), true, "predicate: standalone first run");
  const activeBm25Before = active.bm25.size();
  const geminiBm25Before = gemini.bm25.size();
  const geminiHnswBefore = gemini.hnsw.size();

  const result = await appendOperatorFact(args("firstrunomega lexical active"));

  assert.equal(result.ok, true);
  assert.equal(active.bm25.size(), activeBm25Before + 1, "one ACTIVE BM25 doc");
  assert.equal(hasDocument(active.bm25, result.memory_event_id, "firstrunomega"), true);
  assert.equal(active.hnsw.size(), 0, "no vector added; HNSW still empty");
  assert.equal(gemini.bm25.size(), geminiBm25Before, "never lands in Gemini BM25");
  assert.equal(gemini.hnsw.size(), geminiHnswBefore, "never lands in Gemini HNSW");
});

test("daemon mode: predicate is false WITHOUT calling loadIndices; embeddingless put adds no BM25 entry", async () => {
  // Same root, same EMPTY active HNSW as the first-run case above — the only
  // thing that differs is the queryd mode, so daemon mode alone must keep the
  // predicate false. loadIndices populates the module cache on every call, so
  // "the active model is still absent from the cache" is the observable for
  // "loadIndices was never called" (herd ban).
  const bm25SizeBefore = active.bm25.size();
  try {
    // Instrument control (in-process): the predicate DOES load the index.
    evictModelIndices(CAPS.ACTIVE_EMBED_MODEL_VERSION);
    assert.equal(_indexCacheHas(CAPS.ACTIVE_EMBED_MODEL_VERSION), false);
    assert.equal(await standaloneLexicalFirstRun(), true);
    assert.equal(
      _indexCacheHas(CAPS.ACTIVE_EMBED_MODEL_VERSION),
      true,
      "control: in-process mode loads the index, so the cache probe can see a load",
    );

    process.env.MEMORY_QUERYD = "required";
    _resetQuerydForTest();
    evictModelIndices(CAPS.ACTIVE_EMBED_MODEL_VERSION);
    assert.equal(_indexCacheHas(CAPS.ACTIVE_EMBED_MODEL_VERSION), false);

    assert.equal(await standaloneLexicalFirstRun(), false, "daemon mode => not a first run");
    assert.equal(
      _indexCacheHas(CAPS.ACTIVE_EMBED_MODEL_VERSION),
      false,
      "predicate never called loadIndices in daemon mode",
    );

    const result = await appendOperatorFact(args("daemonmodesigma ledger only"));
    assert.equal(result.ok, true, "the put itself is not blocked by daemon mode");
    assert.equal(
      _indexCacheHas(CAPS.ACTIVE_EMBED_MODEL_VERSION),
      false,
      "an embeddingless operator put in daemon mode never loads the index",
    );

    // Back in-process: the reloaded index (base files + WAL replay) holds
    // exactly what it held before — the daemon-mode put wrote no index record.
    process.env.MEMORY_QUERYD = "off";
    _resetQuerydForTest();
    active = loadIndices(CAPS.ACTIVE_EMBED_MODEL_VERSION);
    assert.equal(active.bm25.size(), bm25SizeBefore, "no BM25 entry was added or persisted");
    assert.equal(hasDocument(active.bm25, result.memory_event_id, "daemonmodesigma"), false);
    assert.equal(
      active.bm25.search("firstrunomega", 5).length,
      1,
      "the earlier first-run doc survived the reload (WAL-durable)",
    );
  } finally {
    process.env.MEMORY_QUERYD = "off";
    _resetQuerydForTest();
    active = loadIndices(CAPS.ACTIVE_EMBED_MODEL_VERSION);
  }
});

test("seed: one vector in the ACTIVE HNSW ends the first-run state", async () => {
  // Everything below is the configured-install path (a vector index exists),
  // where an embeddingless put is lexically indexed only under the flag.
  const vector = new Array(CAPS.EMBEDDING_DIM_4096).fill(0);
  vector[1] = 1;
  const hnswBefore = active.hnsw.size();

  const result = await appendOperatorFact(args("seedvectorkappa lexical vector", vector));

  assert.equal(active.hnsw.size(), hnswBefore + 1);
  assert.equal(active.hnsw.has(result.memory_event_id), true);
  assert.equal(await standaloneLexicalFirstRun(), false, "non-empty HNSW => not a first run");
});

test("default OFF + non-empty HNSW: embedding failure does not update BM25", async () => {
  const bm25Before = active.bm25.size();
  const hnswBefore = active.hnsw.size();
  const result = await appendOperatorFact(args("decoupleoffalpha ledger only"));

  assert.equal(result.ok, true, "embeddingless promotion does not throw");
  assert.equal(active.bm25.size(), bm25Before);
  assert.equal(active.hnsw.size(), hnswBefore);
  assert.equal(hasDocument(active.bm25, result.memory_event_id, "decoupleoffalpha"), false);
});

test("ON + embedding failure: adds an ACTIVE-model BM25 doc only", async () => {
  process.env.MEMORY_BM25_DECOUPLE_EMBED = "true";
  const activeBm25Before = active.bm25.size();
  const activeHnswBefore = active.hnsw.size();
  const geminiBm25Before = gemini.bm25.size();
  const geminiHnswBefore = gemini.hnsw.size();

  const result = await appendOperatorFact(args("decoupleonbeta lexical active"));

  assert.equal(active.bm25.size(), activeBm25Before + 1);
  assert.equal(active.hnsw.size(), activeHnswBefore);
  assert.equal(hasDocument(active.bm25, result.memory_event_id, "decoupleonbeta"), true);
  assert.equal(gemini.bm25.size(), geminiBm25Before, "never lands in Gemini BM25");
  assert.equal(gemini.hnsw.size(), geminiHnswBefore, "never lands in Gemini HNSW");
});

test("flag is read per call: turning it OFF restores the embedding-failure no-op", async () => {
  process.env.MEMORY_BM25_DECOUPLE_EMBED = "false";
  const bm25Before = active.bm25.size();
  const hnswBefore = active.hnsw.size();

  const result = await appendOperatorFact(args("decoupleoffgamma ledger only"));

  assert.equal(result.ok, true);
  assert.equal(active.bm25.size(), bm25Before);
  assert.equal(active.hnsw.size(), hnswBefore);
  assert.equal(hasDocument(active.bm25, result.memory_event_id, "decoupleoffgamma"), false);
});

test("ON + embedding success: adds both ACTIVE-model BM25 and HNSW entries", async () => {
  process.env.MEMORY_BM25_DECOUPLE_EMBED = "1";
  const bm25Before = active.bm25.size();
  const hnswBefore = active.hnsw.size();
  const vector = new Array(CAPS.EMBEDDING_DIM_4096).fill(0);
  vector[0] = 1;

  const result = await appendOperatorFact(
    args("decoupleondelta lexical vector", vector),
  );

  assert.equal(active.bm25.size(), bm25Before + 1);
  assert.equal(active.hnsw.size(), hnswBefore + 1);
  assert.equal(active.hnsw.has(result.memory_event_id), true);
  assert.equal(hasDocument(active.bm25, result.memory_event_id, "decoupleondelta"), true);
});
