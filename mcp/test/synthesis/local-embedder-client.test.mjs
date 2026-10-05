// local-embedder-client.test.mjs — WU1-local-embedder-client-and-dim4096.
//
// Guards the two coordinated changes that make local Qwen3 the embedding
// backend at full 4096 dims:
//
//   PART A — the node client (lib/local-embedder-client.js):
//     - embedSingle / embedBatch request + response SHAPE (HTTP mocked via the
//       _setFetchForTests seam — no live server dependency).
//     - returns 4096-dim vectors.
//     - unit-norm passthrough: the server's ~1.0004 fp16 norm is renormalized
//       to ||v||=1.0 +/- 1e-6 before return.
//     - isQuery flag threads through to the request body's `is_query`.
//     - LocalEmbedUnavailableError on an unreachable / non-ok / mis-shaped
//       server.
//     - VERSION + frozen LOCAL_EMBED_CAPS (URL/dim/batch-cap/timeout).
//
//   PART B — the dimension contract (4096):
//     - index-cache rowToIndexEntry reads features.embedding_4096.
//     - back-compat: a row with only features.embedding_3072 still surfaces it.
//     - s_emb cross-model isolation: _selectSameDimEmbedding returns the
//       same-dim vector and null for a cross-model candidate (-> s_emb=0).
//     - CAPS: EMBEDDING_DIM_4096=4096, ACTIVE_EMBED_MODEL_VERSION pinned.
//     - _emptyHnswDims is model-versioned (4096 for the active local model).
//
//   PART C — the real node:http transport (undici ban, 2026-07-03):
//     - default transport (no test stub) sends Connection: close and opens a
//       FRESH connection per request (agent:false — no keep-alive pool to
//       reuse a socket the per-request-close python server already dropped;
//       undici's pool did exactly that and killed the watermark daemon twice
//       with an uncatchable setTypeOfService EINVAL).
//     - ECONNREFUSED on the real transport wraps into
//       LocalEmbedUnavailableError (rejects; never an uncaught async throw).
//     - timeout destroys the in-flight request and surfaces as
//       LocalEmbedUnavailableError with the abort as cause.
//
// HERMETICITY: no disk; PARTs A+B do no env mutation (fetch seam + pure
// helpers). PART C drives the REAL transport against an ephemeral 127.0.0.1
// server, so it save/restores LOCAL_EMBED_URL / LOCAL_EMBED_TIMEOUT_MS around
// each test. Run: node test/synthesis/local-embedder-client.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";

import {
  VERSION,
  LOCAL_EMBED_CAPS,
  LocalEmbedUnavailableError,
  embedSingle,
  embedBatch,
  health,
  _setFetchForTests,
} from "../../lib/local-embedder-client.js";
import { CAPS } from "../../lib/validation.js";
import { rowToIndexEntry, _emptyHnswDims } from "../../lib/recall/index-cache.js";
import { _selectSameDimEmbedding } from "../../lib/tools/recall.js";

const DIM = 4096;
const MODEL_VERSION = "qwen3-embedding-8b-fp16";

// Build a non-unit-norm 4096 vector (norm ~1.0004, mimicking fp16 noise):
// every component = base; norm = base*sqrt(DIM). Pick base so norm != 1.0.
function makeVec(scale = 1.0004) {
  const base = scale / Math.sqrt(DIM);
  return new Array(DIM).fill(base);
}

function l2(v) {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

// Stub fetch that records the last request and returns a server-shaped body.
function makeFetchStub({ embeddings, status = 200, ok = true, modelVersion = MODEL_VERSION, networkError = null } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    if (networkError) throw networkError;
    const payload = {
      embeddings,
      model_version: modelVersion,
      dim: DIM,
      count: Array.isArray(embeddings) ? embeddings.length : 0,
      elapsed_ms: 12,
    };
    return {
      ok,
      status,
      async text() {
        return JSON.stringify(payload);
      },
    };
  };
  fn.calls = calls;
  return fn;
}

// --------------------------------------------------------------------------
// PART A — client request/response shape, dim, unit-norm, isQuery flag.
// --------------------------------------------------------------------------

test("embedSingle returns a renormalized 4096-dim vector + model version", async () => {
  const stub = makeFetchStub({ embeddings: [makeVec(1.0004)] });
  _setFetchForTests(stub);
  try {
    const res = await embedSingle({ text: "hello world", isQuery: false });
    assert.equal(Array.isArray(res.vector_4096), true, "vector_4096 is an array");
    assert.equal(res.vector_4096.length, DIM, "vector is full 4096 dims");
    assert.equal(res.embedding_model_version, MODEL_VERSION, "model version surfaced");
    // Unit-norm passthrough: the ~1.0004 fp16 norm is renormalized to 1.0.
    assert.ok(Math.abs(l2(res.vector_4096) - 1.0) <= 1e-6, "renormalized to unit norm");
  } finally {
    _setFetchForTests(null);
  }
});

test("embedSingle threads is_query:true for recall-time queries", async () => {
  const stub = makeFetchStub({ embeddings: [makeVec()] });
  _setFetchForTests(stub);
  try {
    await embedSingle({ text: "what did i say about X", isQuery: true });
    assert.equal(stub.calls.length, 1, "exactly one request issued");
    assert.equal(stub.calls[0].body.is_query, true, "is_query flag true for query");
    assert.equal(stub.calls[0].body.dim, DIM, "request asks for 4096 dim");
    assert.deepEqual(stub.calls[0].body.texts, ["what did i say about X"], "texts array carries the input");
    assert.match(stub.calls[0].url, /\/embed$/, "POSTs to the /embed endpoint");
  } finally {
    _setFetchForTests(null);
  }
});

test("embedSingle defaults is_query to false (document mode)", async () => {
  const stub = makeFetchStub({ embeddings: [makeVec()] });
  _setFetchForTests(stub);
  try {
    await embedSingle({ text: "a fact about the world" }); // no isQuery
    assert.equal(stub.calls[0].body.is_query, false, "documents pass is_query:false");
  } finally {
    _setFetchForTests(null);
  }
});

test("embedBatch preserves order, indexes, and chunk count", async () => {
  const stub = makeFetchStub({ embeddings: [makeVec(), makeVec(), makeVec()] });
  _setFetchForTests(stub);
  try {
    const res = await embedBatch({ items: ["a", "b", "c"], isQuery: false });
    assert.equal(res.length, 3, "one record per item");
    assert.equal(res[0].index, 0, "index 0 preserved");
    assert.equal(res[2].index, 2, "index 2 preserved");
    assert.equal(res[1].vector_4096.length, DIM, "batch vectors are 4096 dims");
    assert.ok(Math.abs(l2(res[0].vector_4096) - 1.0) <= 1e-6, "batch vector renormalized");
    assert.equal(res[0].embedding_model_version, MODEL_VERSION, "batch carries model version");
  } finally {
    _setFetchForTests(null);
  }
});

// --------------------------------------------------------------------------
// PART A — E1 zero-norm-embedding-root-cause: a degenerate row inside an
// otherwise-good batch is ROW-LOCAL. embedBatch retries that one text alone;
// a persistent zero row yields a per-item null record; embedSingle still
// throws (recall + corroborate depend on the exact message, R14 pins it).
// --------------------------------------------------------------------------

// Fetch stub whose Nth call answers with responses[N] (server-shaped bodies).
function makeSequencedFetchStub(responses) {
  const calls = [];
  const fn = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    const embeddings = responses[Math.min(calls.length - 1, responses.length - 1)];
    const payload = {
      embeddings,
      model_version: MODEL_VERSION,
      dim: DIM,
      count: embeddings.length,
      elapsed_ms: 12,
    };
    return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
  };
  fn.calls = calls;
  return fn;
}

const ZERO_VEC = new Array(DIM).fill(0);

test("E1: embedBatch retries ONE zero-norm row alone and resolves the full batch", async () => {
  const stub = makeSequencedFetchStub([
    [makeVec(), ZERO_VEC.slice(), makeVec()], // batched pass: row 1 degenerate
    [makeVec(1.0002)],                        // single-row retry: clean
  ]);
  _setFetchForTests(stub);
  try {
    const res = await embedBatch({ items: ["a", "b", "c"], isQuery: false });
    assert.equal(stub.calls.length, 2, "exactly one extra request for the degenerate row");
    assert.deepEqual(stub.calls[1].body.texts, ["b"], "the retry carries exactly the one degenerate text");
    assert.equal(stub.calls[1].body.is_query, false, "the retry keeps the batch's is_query flag");
    assert.equal(res.length, 3, "one record per item");
    for (let i = 0; i < 3; i++) {
      assert.equal(res[i].index, i, `index ${i} preserved`);
      assert.equal(res[i].vector_4096.length, DIM, `item ${i} is 4096 dims`);
      assert.ok(Math.abs(l2(res[i].vector_4096) - 1.0) <= 1e-6, `item ${i} is unit-norm`);
      assert.equal(res[i].degenerate, undefined, `item ${i} is not flagged degenerate`);
    }
    assert.equal(res[1].embedding_model_version, MODEL_VERSION, "retried item carries model version");
  } finally {
    _setFetchForTests(null);
  }
});

test("E1: a persistently zero row yields a per-item null record; siblings intact; no throw", async () => {
  const stub = makeSequencedFetchStub([
    [makeVec(), ZERO_VEC.slice(), makeVec()], // batched pass: row 1 degenerate
    [ZERO_VEC.slice()],                       // single-row retry: still degenerate
  ]);
  _setFetchForTests(stub);
  try {
    const res = await embedBatch({ items: ["a", "b", "c"], isQuery: false });
    assert.equal(stub.calls.length, 2, "one retry only — never a second retry");
    assert.deepEqual(stub.calls[1].body.texts, ["b"], "retry carried the single degenerate text");
    assert.equal(res.length, 3, "batch resolves with one record per item");
    assert.deepEqual(
      res[1],
      { index: 1, vector_4096: null, embedding_model_version: MODEL_VERSION, degenerate: "zero_norm" },
      "the degenerate item is a row-scoped null record",
    );
    for (const i of [0, 2]) {
      assert.equal(res[i].vector_4096.length, DIM, `sibling ${i} keeps its 4096-dim vector`);
      assert.ok(Math.abs(l2(res[i].vector_4096) - 1.0) <= 1e-6, `sibling ${i} is unit-norm`);
      assert.equal(res[i].degenerate, undefined, `sibling ${i} is not flagged`);
    }
  } finally {
    _setFetchForTests(null);
  }
});

test("E1: embedSingle on a zero vector still throws the exact degenerate-norm LocalEmbedUnavailableError", async () => {
  const stub = makeFetchStub({ embeddings: [ZERO_VEC.slice()] });
  _setFetchForTests(stub);
  try {
    await assert.rejects(
      () => embedSingle({ text: "x", isQuery: false }),
      (err) => {
        assert.ok(err instanceof LocalEmbedUnavailableError, "typed error class");
        assert.ok(
          err.message.includes("has degenerate norm=0; cannot renormalize"),
          `R14 message text pinned (got: ${err.message})`,
        );
        return true;
      },
    );
    assert.equal(stub.calls.length, 1, "embedSingle does not retry");
  } finally {
    _setFetchForTests(null);
  }
});

test("E1: a wrong-dim row inside a batch stays batch-fatal (no retry)", async () => {
  const stub = makeSequencedFetchStub([
    [makeVec(), new Array(3072).fill(1 / Math.sqrt(3072)), makeVec()],
  ]);
  _setFetchForTests(stub);
  try {
    await assert.rejects(
      () => embedBatch({ items: ["a", "b", "c"], isQuery: false }),
      (err) => {
        assert.ok(err instanceof LocalEmbedUnavailableError, "shape fault -> typed error");
        assert.match(err.message, /3072 dims; expected 4096/, "dim mismatch surfaced");
        return true;
      },
    );
    assert.equal(stub.calls.length, 1, "no single-row retry for a shape fault");
  } finally {
    _setFetchForTests(null);
  }
});

// --------------------------------------------------------------------------
// PART A — E5 embed-track-residuals: the E1 single-row retry is BOUNDED per
// chunk. A whole-degenerate chunk (len >= 2, the server's own whole-batch
// rule) issues NO retry; a partial-degenerate chunk retries at most
// LOCAL_EMBED_CAPS.DEGENERATE_RETRY_CAP rows; every degenerate row still
// yields the exact per-item null record watermark.js and the re-embed sweep
// depend on.
// --------------------------------------------------------------------------

function assertBatchContract(res, items) {
  assert.equal(res.length, items.length, "one record per item");
  for (let i = 0; i < res.length; i++) {
    assert.ok(res[i] && typeof res[i] === "object", `record ${i} present`);
    assert.equal(res[i].index, i, `record ${i} carries its index`);
  }
}

const NULL_RECORD = (i) => ({
  index: i,
  vector_4096: null,
  embedding_model_version: MODEL_VERSION,
  degenerate: "zero_norm",
});

test("E5: LOCAL_EMBED_CAPS.DEGENERATE_RETRY_CAP is 8 and the descriptor stays frozen", () => {
  assert.equal(LOCAL_EMBED_CAPS.DEGENERATE_RETRY_CAP, 8, "mirrors EMBED_DEGENERATE_RETRY_MAX default 8");
  assert.ok(Object.isFrozen(LOCAL_EMBED_CAPS), "LOCAL_EMBED_CAPS is frozen");
  assert.throws(() => {
    "use strict";
    LOCAL_EMBED_CAPS.DEGENERATE_RETRY_CAP = 99;
  }, TypeError, "cap is not writable");
  assert.equal(LOCAL_EMBED_CAPS.DEGENERATE_RETRY_CAP, 8, "cap unchanged after write attempt");
});

test("E5: a 4-row whole-degenerate chunk issues exactly ONE POST and 4 null records", async () => {
  const items = ["a", "b", "c", "d"];
  const stub = makeSequencedFetchStub([
    [ZERO_VEC.slice(), ZERO_VEC.slice(), ZERO_VEC.slice(), ZERO_VEC.slice()],
    [makeVec()], // must never be reached
  ]);
  _setFetchForTests(stub);
  try {
    const res = await embedBatch({ items, isQuery: false });
    assert.equal(stub.calls.length, 1, "whole-chunk: no single-row retry at all");
    assert.deepEqual(stub.calls[0].body.texts, items, "the one POST is the batched pass");
    assertBatchContract(res, items);
    for (let i = 0; i < items.length; i++) {
      assert.deepEqual(res[i], NULL_RECORD(i), `row ${i} is the per-item null record`);
    }
  } finally {
    _setFetchForTests(null);
  }
});

test("E5: a 4-row chunk with exactly one zero row still gets its one retry (E1 regression)", async () => {
  const items = ["a", "b", "c", "d"];
  const stub = makeSequencedFetchStub([
    [makeVec(), makeVec(), ZERO_VEC.slice(), makeVec()], // row 2 degenerate
    [makeVec(1.0002)],                                   // retry: clean
  ]);
  _setFetchForTests(stub);
  try {
    const res = await embedBatch({ items, isQuery: false });
    assert.equal(stub.calls.length, 2, "batched pass + exactly one single-row retry");
    assert.deepEqual(stub.calls[1].body.texts, ["c"], "the retry carries exactly the one degenerate text");
    assertBatchContract(res, items);
    for (let i = 0; i < items.length; i++) {
      assert.equal(res[i].degenerate, undefined, `row ${i} is not flagged`);
      assert.equal(res[i].vector_4096.length, DIM, `row ${i} is 4096 dims`);
      assert.ok(Math.abs(l2(res[i].vector_4096) - 1.0) <= 1e-6, `row ${i} is unit-norm`);
    }
  } finally {
    _setFetchForTests(null);
  }
});

test("E5: a 256-row whole-degenerate chunk short-circuits to ONE POST and 256 null records", async () => {
  const n = LOCAL_EMBED_CAPS.BATCH_CAP;
  assert.equal(n, 256, "BATCH_CAP unchanged");
  const items = Array.from({ length: n }, (_, i) => `t${i}`);
  const stub = makeSequencedFetchStub([
    Array.from({ length: n }, () => ZERO_VEC.slice()),
    [makeVec()], // must never be reached
  ]);
  _setFetchForTests(stub);
  try {
    const res = await embedBatch({ items, isQuery: false });
    assert.equal(stub.calls.length, 1, "256-row wedged chunk: one POST, not 257");
    assert.equal(stub.calls[0].body.texts.length, n, "the one POST carried the whole chunk");
    assertBatchContract(res, items);
    let nulls = 0;
    for (let i = 0; i < n; i++) {
      assert.deepEqual(res[i], NULL_RECORD(i), `row ${i} is the per-item null record`);
      nulls += 1;
    }
    assert.equal(nulls, n, "every row nulled");
  } finally {
    _setFetchForTests(null);
  }
});

test("E5: a partial-degenerate chunk retries at most DEGENERATE_RETRY_CAP rows; every bad row still nulls", async () => {
  const cap = LOCAL_EMBED_CAPS.DEGENERATE_RETRY_CAP;
  const items = Array.from({ length: 12 }, (_, i) => `t${i}`);
  const goodIdx = new Set([3, 9]); // 10 of 12 rows degenerate — NOT whole-chunk
  const batched = items.map((_, i) => (goodIdx.has(i) ? makeVec() : ZERO_VEC.slice()));
  // Every retry answers with a still-zero single row (persistently bad rows).
  const stub = makeSequencedFetchStub([batched, [ZERO_VEC.slice()]]);
  _setFetchForTests(stub);
  try {
    const res = await embedBatch({ items, isQuery: false });
    assert.equal(stub.calls.length, 1 + cap, `batched pass + exactly ${cap} retries (got ${stub.calls.length})`);
    assert.deepEqual(stub.calls[0].body.texts, items, "call 0 is the batched pass");
    const badIdx = items.map((_, i) => i).filter((i) => !goodIdx.has(i));
    for (let k = 0; k < cap; k++) {
      assert.deepEqual(
        stub.calls[1 + k].body.texts,
        [items[badIdx[k]]],
        `retry ${k} carries exactly the ${k}th degenerate text`,
      );
      assert.equal(stub.calls[1 + k].body.is_query, false, `retry ${k} keeps is_query`);
    }
    assertBatchContract(res, items);
    for (const i of badIdx) {
      assert.deepEqual(res[i], NULL_RECORD(i), `bad row ${i} (retried or capped) is the null record`);
    }
    for (const i of goodIdx) {
      assert.equal(res[i].degenerate, undefined, `sibling ${i} is not flagged`);
      assert.equal(res[i].vector_4096.length, DIM, `sibling ${i} keeps its vector`);
      assert.ok(Math.abs(l2(res[i].vector_4096) - 1.0) <= 1e-6, `sibling ${i} is unit-norm`);
    }
  } finally {
    _setFetchForTests(null);
  }
});

test("E5: a 1-row degenerate chunk is NOT whole-chunk and still gets its one retry", async () => {
  const stub = makeSequencedFetchStub([[ZERO_VEC.slice()], [makeVec(1.0002)]]);
  _setFetchForTests(stub);
  try {
    const res = await embedBatch({ items: ["solo"], isQuery: true });
    assert.equal(stub.calls.length, 2, "batched pass + one retry (server whole-batch rule is len >= 2)");
    assert.deepEqual(stub.calls[1].body.texts, ["solo"], "retry carries the one text");
    assert.equal(stub.calls[1].body.is_query, true, "retry keeps is_query");
    assertBatchContract(res, ["solo"]);
    assert.equal(res[0].degenerate, undefined, "recovered on retry");
    assert.equal(res[0].vector_4096.length, DIM, "4096 dims");
  } finally {
    _setFetchForTests(null);
  }
});

test("embedBatch returns [] for empty input without a network call", async () => {
  const stub = makeFetchStub({ embeddings: [] });
  _setFetchForTests(stub);
  try {
    const res = await embedBatch({ items: [], isQuery: false });
    assert.deepEqual(res, [], "empty input -> empty output");
    assert.equal(stub.calls.length, 0, "no request issued for empty batch");
  } finally {
    _setFetchForTests(null);
  }
});

test("embedSingle throws on empty text (input validation)", async () => {
  await assert.rejects(
    () => embedSingle({ text: "" }),
    /text must be a non-empty string/,
    "empty text rejected",
  );
});

// --------------------------------------------------------------------------
// PART A — LocalEmbedUnavailableError on unreachable / non-ok / mis-shaped.
// --------------------------------------------------------------------------

test("embedSingle throws typed LocalEmbedUnavailableError when server unreachable", async () => {
  const netErr = new Error("ECONNREFUSED 127.0.0.1:8359");
  _setFetchForTests(makeFetchStub({ embeddings: [makeVec()], networkError: netErr }));
  try {
    await assert.rejects(
      () => embedSingle({ text: "x", isQuery: false }),
      (err) => {
        assert.ok(err instanceof LocalEmbedUnavailableError, "typed error class");
        assert.equal(err.name, "LocalEmbedUnavailableError", "error name pinned");
        assert.equal(err.retryable, false, "structural error is not hot-retryable");
        assert.equal(err.cause, netErr, "underlying network error preserved as cause");
        return true;
      },
    );
  } finally {
    _setFetchForTests(null);
  }
});

test("embedSingle throws LocalEmbedUnavailableError on non-2xx response", async () => {
  _setFetchForTests(makeFetchStub({ embeddings: [makeVec()], ok: false, status: 503 }));
  try {
    await assert.rejects(
      () => embedSingle({ text: "x", isQuery: false }),
      (err) => {
        assert.ok(err instanceof LocalEmbedUnavailableError, "503 -> typed error");
        assert.match(err.message, /503/, "status surfaced in message");
        return true;
      },
    );
  } finally {
    _setFetchForTests(null);
  }
});

test("embedSingle throws LocalEmbedUnavailableError on missing embeddings[]", async () => {
  // ok:200 but the body has no embeddings array.
  const fn = async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ model_version: MODEL_VERSION }); } });
  _setFetchForTests(fn);
  try {
    await assert.rejects(
      () => embedSingle({ text: "x", isQuery: false }),
      /missing embeddings/,
      "mis-shaped body rejected",
    );
  } finally {
    _setFetchForTests(null);
  }
});

test("embedSingle rejects a wrong-dim vector from the server", async () => {
  _setFetchForTests(makeFetchStub({ embeddings: [new Array(3072).fill(1 / Math.sqrt(3072))] }));
  try {
    await assert.rejects(
      () => embedSingle({ text: "x", isQuery: false }),
      (err) => {
        assert.ok(err instanceof LocalEmbedUnavailableError, "dim mismatch -> typed error");
        assert.match(err.message, /3072 dims; expected 4096/, "dim mismatch detail surfaced");
        return true;
      },
    );
  } finally {
    _setFetchForTests(null);
  }
});

test("health throws LocalEmbedUnavailableError when probe fails", async () => {
  _setFetchForTests(async () => { throw new Error("connect ECONNREFUSED"); });
  try {
    await assert.rejects(() => health(), LocalEmbedUnavailableError, "health probe fails typed");
  } finally {
    _setFetchForTests(null);
  }
});

// --------------------------------------------------------------------------
// PART A — VERSION + frozen LOCAL_EMBED_CAPS.
// --------------------------------------------------------------------------

test("VERSION + LOCAL_EMBED_CAPS are exported, frozen, and correctly shaped", () => {
  assert.equal(typeof VERSION, "string", "VERSION is a string");
  assert.ok(VERSION.length > 0, "VERSION non-empty");
  assert.equal(Object.isFrozen(LOCAL_EMBED_CAPS), true, "LOCAL_EMBED_CAPS is frozen");
  assert.equal(LOCAL_EMBED_CAPS.DIM, 4096, "caps DIM is 4096");
  assert.equal(LOCAL_EMBED_CAPS.BATCH_CAP, 256, "caps BATCH_CAP is 256");
  assert.equal(typeof LOCAL_EMBED_CAPS.TIMEOUT_MS, "number", "caps TIMEOUT_MS numeric");
  assert.equal(LOCAL_EMBED_CAPS.URL, "http://127.0.0.1:8359", "caps URL default");
  assert.equal(LOCAL_EMBED_CAPS.MODEL_VERSION, MODEL_VERSION, "caps MODEL_VERSION pinned");
});

// --------------------------------------------------------------------------
// PART B — dimension contract: CAPS, index-cache, s_emb, empty HNSW dims.
// --------------------------------------------------------------------------

test("CAPS pin EMBEDDING_DIM_4096 and ACTIVE_EMBED_MODEL_VERSION", () => {
  assert.equal(CAPS.EMBEDDING_DIM_4096, 4096, "EMBEDDING_DIM_4096 = 4096");
  assert.equal(CAPS.ACTIVE_EMBED_MODEL_VERSION, MODEL_VERSION, "active model version pinned");
});

test("rowToIndexEntry reads features.embedding_4096 (active local model)", () => {
  const vec = makeVec(1.0);
  const row = {
    id: "mem_qwen_1",
    kind: "fact",
    content: "a locally embedded fact",
    created_at: "2026-06-17T00:00:00.000Z",
    features: {
      embedding_4096: vec,
      embedding_model_version: MODEL_VERSION,
    },
  };
  const entry = rowToIndexEntry(row, MODEL_VERSION);
  assert.equal(Array.isArray(entry.embedding_4096), true, "embedding_4096 carried");
  assert.equal(entry.embedding_4096.length, DIM, "4096-dim vector preserved");
  assert.equal(entry.embedding_3072, null, "no legacy 3072 on a qwen3 fact");
  assert.equal(entry.embedding_model_version, MODEL_VERSION, "model version surfaced");
});

test("rowToIndexEntry back-compat: a Gemini fact with only embedding_3072 still surfaces it", () => {
  const vec3072 = new Array(3072).fill(1 / Math.sqrt(3072));
  const row = {
    id: "mem_gemini_1",
    kind: "fact",
    content: "an old gemini fact",
    created_at: "2026-01-01T00:00:00.000Z",
    features: {
      embedding_3072: vec3072,
      embedding_model_version: "gemini-embedding-001",
    },
  };
  const entry = rowToIndexEntry(row, "gemini-embedding-001");
  assert.equal(entry.embedding_4096, null, "no 4096 on a legacy fact");
  assert.equal(Array.isArray(entry.embedding_3072), true, "legacy 3072 still readable");
  assert.equal(entry.embedding_3072.length, 3072, "3072-dim preserved for back-compat recall");
});

test("_selectSameDimEmbedding picks the query-dim vector and isolates cross-model", () => {
  const v4096 = makeVec(1.0);
  const v3072 = new Array(3072).fill(1 / Math.sqrt(3072));
  // Query is 4096-dim (local model): pick the 4096 candidate vector.
  const localCand = { embedding_4096: v4096, embedding_3072: null };
  assert.equal(_selectSameDimEmbedding(localCand, 4096), v4096, "4096 query -> 4096 candidate vec");
  // Query is 3072-dim (Gemini): NULL. l5-fallback-removal deleted the 3072
  // selection arm together with the step-c legacy-coverage fallback that was
  // the only writer of a 3072-dim query vector (FL-24 binds them). Nothing in
  // recall can produce queryDim=3072 any more; see PART D / T1 below.
  const gemCand = { embedding_4096: null, embedding_3072: v3072 };
  assert.equal(_selectSameDimEmbedding(gemCand, 3072), null, "3072 selection arm removed by l5");
  // CROSS-MODEL: a 4096-only candidate against a 3072 query -> null (s_emb=0).
  assert.equal(_selectSameDimEmbedding(localCand, 3072), null, "cross-model 4096-vs-3072 -> null");
  // A 3072-only candidate against a 4096 query -> null (s_emb=0).
  assert.equal(_selectSameDimEmbedding(gemCand, 4096), null, "cross-model 3072-vs-4096 -> null");
  // No vectors at all -> null.
  assert.equal(_selectSameDimEmbedding({}, 4096), null, "no candidate vector -> null");
  // Defensive: bad inputs -> null.
  assert.equal(_selectSameDimEmbedding(null, 4096), null, "null candidate -> null");
  assert.equal(_selectSameDimEmbedding(localCand, 0), null, "non-positive dim -> null");
});

// ---------------------------------------------------------------------------
// PART D — l5-fallback-removal. The legacy-coverage fallback branch in
// recall.js step c (`activeHnswEmpty && activeBm25Empty` -> load the Gemini
// index, re-encode the query with embedSegments, MRL-slice to 768) and
// _selectSameDimEmbedding's embedding_3072 selection arm are ONE unit (FL-24):
// that branch was the only writer of a 3072-dim query vector, so it was the
// only producer of a queryDim under which the 3072 arm could return. Both were
// removed together; these five assertions pin the removal AND its blast radius.
//
// T1/T3 are the behavioural + structural pins (RED before the removal).
// T2/T4/T5 are anti-overreach controls (GREEN on both sides) — they prove the
// edit deleted one selection arm and one branch, not the function, not the
// wire-contract field name, and not the model-version constant.
//
// Hermetic: reads the recall.js SOURCE TEXT off disk (repo file, no ledger, no
// index, no daemon) and calls one pure exported helper.
// ---------------------------------------------------------------------------

const RECALL_SRC = readFileSync(
  new URL("../../lib/tools/recall.js", import.meta.url),
  "utf8",
);

function countOccurrences(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

test("T1 (l5): _selectSameDimEmbedding no longer selects a 3072 candidate vector", () => {
  const v3072 = new Array(3072).fill(1 / Math.sqrt(3072));
  const gemCand = { embedding_4096: null, embedding_3072: v3072 };
  assert.equal(
    _selectSameDimEmbedding(gemCand, 3072),
    null,
    "the 3072 selection arm was removed with the legacy-coverage fallback branch",
  );
});

test("T2 (l5, anti-vacuity): the 4096 selection arm still returns the candidate vector", () => {
  const v4096 = makeVec(1.0);
  assert.equal(v4096.length, 4096, "fixture really is a 4096-dim vector");
  const localCand = { embedding_4096: v4096, embedding_3072: null };
  assert.equal(
    _selectSameDimEmbedding(localCand, 4096),
    v4096,
    "one arm was deleted, not the function",
  );
});

test("T3 (l5, structural): the both-empty legacy-coverage fallback branch is gone", () => {
  assert.equal(
    countOccurrences(RECALL_SRC, "activeHnswEmpty && activeBm25Empty"),
    0,
    "recall.js must carry no both-active-trees-empty legacy fallback branch",
  );
});

test("T4 (l5, anti-overreach): the embedding_3072 wire field survives at the MMR/density sites", () => {
  // `embedding_3072` is the array-like WIRE CONTRACT into mmrSelect /
  // emitDensityFlag and carries 4096-dim ACTIVE vectors under a legacy field
  // name on purpose. Only the SELECTION arm was removed; the field name must
  // never be grep-purged.
  assert.ok(
    countOccurrences(RECALL_SRC, "embedding_3072:") >= 3,
    `expected >=3 embedding_3072: wire sites to remain, found ${countOccurrences(RECALL_SRC, "embedding_3072:")}`,
  );
});

test("T5 (l5, FL-25): EMBEDDING_MODEL_VERSION survives in its definition and both readers", () => {
  assert.ok(
    RECALL_SRC.includes(
      "const EMBEDDING_MODEL_VERSION = CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT;",
    ),
    "EMBEDDING_MODEL_VERSION definition unchanged",
  );
  assert.ok(
    RECALL_SRC.includes("rowToIndexEntry(row, EMBEDDING_MODEL_VERSION)"),
    "still the 2nd arg of rowToIndexEntry (labels rows carrying no own model version)",
  );
  assert.ok(
    RECALL_SRC.includes("embedding_model_version: EMBEDDING_MODEL_VERSION,"),
    "still passed into applyHardGates (selects the exclusion-gate vector field)",
  );
});

test("_emptyHnswDims is model-versioned: 4096 for the active local model, 768 otherwise", () => {
  assert.equal(_emptyHnswDims(MODEL_VERSION), 4096, "active model -> full 4096 index dim");
  assert.equal(_emptyHnswDims("gemini-embedding-001"), 768, "legacy Gemini -> MRL 768 index dim");
  assert.equal(_emptyHnswDims("some-unknown-model"), 768, "unknown model -> conservative 768 default");
});

// --------------------------------------------------------------------------
// PART C — REAL node:http transport (undici ban regression, 2026-07-03).
//
// These tests do NOT stub the fetch seam (_setFetchForTests(null)): they pin
// the default transport itself. undici/global fetch is banned in this client
// because its keep-alive pool, reusing a socket the per-request-close python
// embed server had half-closed, threw an uncatchable setTypeOfService EINVAL
// from the socket write path and killed the watermark daemon twice.
// --------------------------------------------------------------------------

// Save/restore the env the real transport reads, per test.
function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) {
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  const restore = () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  return fn().finally(restore);
}

// Ephemeral 127.0.0.1 server; resolves { server, url, connections, requests }.
function startServer(handler) {
  return new Promise((resolve, reject) => {
    const connections = [];
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("error", () => {}); // client abort mid-request must not throw here
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        handler(req, res, requests[requests.length - 1]);
      });
    });
    server.on("connection", (socket) => connections.push(socket));
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}`, connections, requests });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

test("PART C: real transport sends Connection: close and a fresh connection per request", async () => {
  _setFetchForTests(null); // REAL transport under test.
  const embedPayload = JSON.stringify({
    embeddings: [makeVec(1.0004)],
    model_version: MODEL_VERSION,
    dim: DIM,
    count: 1,
    elapsed_ms: 5,
  });
  const { server, url, connections, requests } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.end(embedPayload);
  });
  try {
    await withEnv({ LOCAL_EMBED_URL: url }, async () => {
      const r1 = await embedSingle({ text: "transport probe one", isQuery: false });
      const r2 = await embedSingle({ text: "transport probe two", isQuery: true });
      assert.equal(r1.vector_4096.length, DIM, "real transport returns 4096-dim vector");
      assert.ok(Math.abs(l2(r2.vector_4096) - 1.0) <= 1e-6, "renorm holds over real transport");

      assert.equal(requests.length, 2, "server saw both requests");
      for (const rq of requests) {
        assert.equal(rq.headers.connection, "close", "Connection: close sent explicitly");
        assert.equal(rq.method, "POST", "POSTs to /embed");
        assert.equal(rq.url, "/embed", "path is /embed");
      }
      assert.equal(JSON.parse(requests[0].body).is_query, false, "body intact over real transport");
      assert.equal(JSON.parse(requests[1].body).is_query, true, "is_query threads over real transport");

      // THE defect guard: no keep-alive pool — each request opened its OWN
      // TCP connection, so a server that closes per-request can never leave
      // a stale pooled socket for a later write to die on.
      assert.equal(connections.length, 2, "one fresh connection per request (agent:false, no pool)");
    });
  } finally {
    await closeServer(server);
  }
});

test("PART C: real transport GET /health works and carries Connection: close", async () => {
  _setFetchForTests(null);
  const { server, url, requests } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ ok: true, model: "qwen3", model_version: MODEL_VERSION, device: "mps", native_dim: DIM }));
  });
  try {
    await withEnv({ LOCAL_EMBED_URL: url }, async () => {
      const h = await health();
      assert.equal(h.ok, true, "health body parsed over real transport");
      assert.equal(requests[0].method, "GET", "health is a GET");
      assert.equal(requests[0].url, "/health", "path is /health");
      assert.equal(requests[0].headers.connection, "close", "health also sends Connection: close");
    });
  } finally {
    await closeServer(server);
  }
});

test("PART C: real transport wraps ECONNREFUSED into LocalEmbedUnavailableError (rejects, never an uncaught throw)", async () => {
  _setFetchForTests(null);
  await withEnv({ LOCAL_EMBED_URL: "http://127.0.0.1:1" }, async () => {
    await assert.rejects(
      () => embedSingle({ text: "x", isQuery: false }),
      (err) => {
        assert.ok(err instanceof LocalEmbedUnavailableError, "typed error over real transport");
        assert.ok(err.cause, "underlying socket error preserved as cause");
        assert.equal(err.cause.code, "ECONNREFUSED", "ECONNREFUSED surfaced in cause");
        return true;
      },
    );
    await assert.rejects(() => health(), LocalEmbedUnavailableError, "health probe fails typed too");
  });
});

test("PART C: timeout destroys the in-flight request and surfaces as LocalEmbedUnavailableError", async () => {
  _setFetchForTests(null);
  // Server accepts the request and never responds; body never handled.
  const { server, url } = await startServer(() => {
    /* hang forever */
  });
  try {
    await withEnv({ LOCAL_EMBED_URL: url, LOCAL_EMBED_TIMEOUT_MS: "100" }, async () => {
      const t0 = Date.now();
      await assert.rejects(
        () => embedSingle({ text: "hang", isQuery: false }),
        (err) => {
          assert.ok(err instanceof LocalEmbedUnavailableError, "timeout -> typed unavailable error");
          assert.ok(err.cause, "abort preserved as cause");
          return true;
        },
      );
      assert.ok(Date.now() - t0 < 5000, "aborted on the per-call budget, not the 60s default");
    });
  } finally {
    await closeServer(server);
  }
});
