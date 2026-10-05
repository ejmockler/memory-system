// recall-local-4096-query.test.mjs — WU-recall-flip-to-local-4096 regression gate.
//
// AUTHORITATIVE behavior under test: the LIVE memory_recall handler now embeds
// the recall query via the LOCAL Qwen3-8B server (full 4096 dims, isQuery:true)
// and reads the ACTIVE 4096 index (indices/<ACTIVE_EMBED_MODEL_VERSION>/), NOT
// the Gemini multi-segment encoder + gemini-embedding-001 index. The flip is:
//
//   1. Query embedding -> local. The assembled surrounding_context
//      (current_query + recent_turns + agent_role) is routed through
//      embedSingle({ text, isQuery:true }) -> ONE 4096 L2-unit vector. We assert
//      the local client is the ONLY embed surface called (the mock fetch sees
//      is_query:true and dim:4096) and that the Gemini path is NOT invoked.
//   2. Index load -> active. loadIndices(ACTIVE_EMBED_MODEL_VERSION) reads the
//      4096 HNSW. We build a small hermetic 4096 fixture index.
//   3. s_emb geometry. The 4096 query vector compares ONLY against candidate
//      embedding_4096 (via _selectSameDimEmbedding). A 4096-embedded fact that
//      is the literal nearest neighbor ranks #1 (semantic ranking is real).
//   4. Partial coverage. A fact with NO embedding_4096 (not yet re-embedded)
//      gets s_emb=0 and ranks by BM25 + additive features — never a crash.
//   5. degraded_recall. FALSE when the local embed + 4096 index both succeed;
//      TRUE (BM25-only) when the local server is unavailable
//      (LocalEmbedUnavailableError) — and the handler does NOT throw.
//
// HERMETICITY: mkdtempSync root + env vars set BEFORE any dynamic import of
// memory-system modules (standing C-NEW-2 pattern). GEMINI keys are unset so
// the OLD path would have degraded; the NEW path embeds locally regardless.
// The local fetch is MOCKED via local-embedder-client._setFetchForTests and
// (b4) Layer-3 is pinned LOCAL_RERANKER_ENABLED="0" at the env seam below, so
// no live server is required. Both halves are load-bearing: the embedder mock
// alone left recall dialing the rerank daemon on :8360, which is what this
// sentence used to claim it did not. Production paths are snapshotted pre/post
// and asserted byte-identical.
//
// Run: node test/synthesis/recall-local-4096-query.test.mjs

import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skipIfDaemonActive } from "../_hermetic-daemon-skip.mjs";
skipIfDaemonActive("WU-recall-flip-to-local-4096");

// The checkout this suite runs from. Its default (un-overridden) ledgers,
// policy and indices are what the byte-identity guards below watch; the
// suite itself works under a temp MEMORY_ROOT.
const CHECKOUT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// ---------------------------------------------------------------------------
// 0. Production snapshot guard BEFORE we touch anything.
// ---------------------------------------------------------------------------
const PROD_MEMORY_JSONL = join(CHECKOUT_ROOT, "ledgers", "memory.jsonl");
const PROD_RECALL_JSONL = join(CHECKOUT_ROOT, "ledgers", "recall.jsonl");
const PROD_INDICES_DIR = join(CHECKOUT_ROOT, "indices");
function snap(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const PROD_BEFORE = {
  memory: snap(PROD_MEMORY_JSONL),
  recall: snap(PROD_RECALL_JSONL),
  indices: snap(PROD_INDICES_DIR),
};

// ---------------------------------------------------------------------------
// 1. Hermetic root + env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-wu-local4096-query-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(MEMORY_ROOT, "policy");
const STORAGE_DIR = join(MEMORY_ROOT, "storage");
const LEDGERS_DIR = join(MEMORY_ROOT, "ledgers");
const INDICES_DIR = join(MEMORY_ROOT, "indices");
for (const d of [POLICY_DIR, STORAGE_DIR, LEDGERS_DIR, INDICES_DIR]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;
// Force the OLD Gemini path to be unavailable — proves the NEW local path is
// what produces a non-degraded recall (the OLD code would have degraded here).
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;
// b4: "the NEW local path" above means the local EMBEDDER (Layer-1). Layer-3
// is a separate selector, and an UNSET LOCAL_RERANKER_ENABLED falls through to
// CAPS.LOCAL_RERANKER_ENABLED (true), which skips the gemini key gate and
// sends the default backend at _baseUrl() to the LIVE rerank daemon on :8360.
// "0" is the tri-state OFF override (a `delete` is inert against a true CAP);
// it restores the api_key_missing degrade and opens no rerank socket.
process.env.LOCAL_RERANKER_ENABLED = "0";

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// 2. Dynamic imports AFTER env override.
// ---------------------------------------------------------------------------
const { memoryLedgerPath } = await import("../../lib/config.js");
const recallMod = await import("../../lib/tools/recall.js");
const { _selectSameDimEmbedding } = recallMod;
const indexCacheMod = await import("../../lib/recall/index-cache.js");
const { saveIndices, _resetCaches } = indexCacheMod;
const { _resetTransitiveOrphanCaches } = await import(
  "../../lib/recall/hard-gates.js"
);
const { Bm25Index } = await import("../../lib/recall/bm25-index.js");
const { HnswIndex } = await import("../../lib/recall/hnsw-index.js");
const { CAPS } = await import("../../lib/validation.js");
const localEmbedMod = await import("../../lib/local-embedder-client.js");
const { _setFetchForTests, LocalEmbedUnavailableError } = localEmbedMod;

const ACTIVE_VERSION = CAPS.ACTIVE_EMBED_MODEL_VERSION;
// The legacy Gemini tree recall.js falls back to when the ACTIVE tree's HNSW
// and BM25 are BOTH empty. Same constant recall.js reads for
// EMBEDDING_MODEL_VERSION, so the fixture and the handler cannot drift.
const LEGACY_VERSION = CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT;
const DIM = CAPS.EMBEDDING_DIM_4096; // 4096
const RECALL_JSONL = join(LEDGERS_DIR, "recall.jsonl");

// ---------------------------------------------------------------------------
// Deterministic 4096-dim unit-vector helpers.
//
// We build vectors as a unit spike at a chosen index so cosine(a,b) is exactly
// 1 when a and b spike the same index and 0 when they spike different indices.
// This makes the nearest-neighbor outcome (and s_emb) exactly predictable
// without a real embedding model.
// ---------------------------------------------------------------------------
function unitSpike(idx, dim = DIM) {
  const v = new Array(dim).fill(0);
  v[idx % dim] = 1;
  return v;
}

// Mock-fetch state: the LAST /embed request body the handler issued, so the
// test can assert is_query:true + dim:4096 and that the query text reached the
// local backend. queryVecSpikeIndex controls which spike the "query embedding"
// lands on (matching one fact's stored embedding_4096 -> that fact is the NN).
let lastEmbedRequest = null;
let queryVecSpikeIndex = 0;
let embedCallCount = 0;

function installLocalEmbedMock({ spikeIndex, fail = false } = {}) {
  embedCallCount = 0;
  lastEmbedRequest = null;
  if (typeof spikeIndex === "number") queryVecSpikeIndex = spikeIndex;
  _setFetchForTests(async (url, init) => {
    embedCallCount += 1;
    if (fail) {
      // Simulate an unreachable server -> the client throws
      // LocalEmbedUnavailableError, which recall catches and degrades on.
      throw new Error("ECONNREFUSED 127.0.0.1:8359 (mock)");
    }
    const body = JSON.parse(init.body);
    lastEmbedRequest = body;
    const texts = Array.isArray(body.texts) ? body.texts : [];
    const embeddings = texts.map(() => unitSpike(queryVecSpikeIndex));
    return {
      ok: true,
      async text() {
        return JSON.stringify({
          embeddings,
          model_version: ACTIVE_VERSION,
          dim: DIM,
          count: embeddings.length,
          elapsed_ms: 1,
        });
      },
    };
  });
}

function clearLocalEmbedMock() {
  _setFetchForTests(null);
}

// ---------------------------------------------------------------------------
// Fixture ledger: facts carrying features.embedding_4096 (active model) plus
// one fact with NO embedding_4096 (partial-coverage / not-yet-re-embedded).
// ---------------------------------------------------------------------------
const TS = "2026-06-01T00:00:00.000Z";

function factRow(id, content, { spikeIndex = null } = {}) {
  const features = { embedding_model_version: ACTIVE_VERSION };
  if (spikeIndex !== null) {
    features.embedding_4096 = unitSpike(spikeIndex);
  }
  return {
    id,
    kind: "fact",
    content,
    created_at: TS,
    ts: TS,
    source_refs: [{ source: "test", consent_basis: "first_party" }],
    features,
  };
}

// Shared probe text — all fixture facts BM25-match it (share "quokka") so they
// all enter the candidate pool via the BM25 leg even when their dense vector
// differs. Semantic ranking (s_emb on embedding_4096) then orders them.
const PROBE_WORD = "quokka";

function buildFixture({ withEmbeddings = true } = {}) {
  // fact_match spikes the SAME index the mock query embedding spikes -> cosine
  // 1.0 -> it is the dense nearest-neighbor and should rank #1 when 4096 is on.
  const rows = [
    factRow("fact_match", `the ${PROBE_WORD} nearest neighbor target fact`, {
      spikeIndex: withEmbeddings ? 7 : null,
    }),
    factRow("fact_far_a", `another ${PROBE_WORD} fact far in embedding space`, {
      spikeIndex: withEmbeddings ? 11 : null,
    }),
    factRow("fact_far_b", `a third ${PROBE_WORD} fact also far away`, {
      spikeIndex: withEmbeddings ? 23 : null,
    }),
    // Partial-coverage fact: NO embedding_4096 (not yet re-embedded). Must NOT
    // crash; s_emb=0; ranks by BM25 + additive features.
    factRow("fact_no_embed", `an unembedded ${PROBE_WORD} fact awaiting backfill`, {
      spikeIndex: null,
    }),
  ];
  return rows;
}

// buildBm25:false leaves the active BM25 EMPTY as well as (optionally) the
// HNSW, so a fully-empty active index tree is constructible without a second
// harness. T9 needs that shape: it is the only input under which the
// `activeHnswEmpty && activeBm25Empty` branch is reachable.
function writeFixtureLedgerAndIndex(rows, { buildHnsw = true, buildBm25 = true } = {}) {
  const path = memoryLedgerPath();
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path, body, { mode: 0o600 });

  const bm25 = new Bm25Index();
  if (buildBm25) {
    for (const r of rows) {
      bm25.add({
        memory_id: r.id,
        content: r.content,
        kind: r.kind,
        ts: r.ts,
        entities: [],
      });
    }
  }

  // Active 4096 HNSW. Add every fact that carries embedding_4096 at its spike.
  const hnsw = new HnswIndex({
    dims: DIM,
    embedding_model_version: ACTIVE_VERSION,
  });
  if (buildHnsw) {
    for (const r of rows) {
      const emb = r.features && r.features.embedding_4096;
      if (Array.isArray(emb)) hnsw.add(r.id, emb);
    }
  }
  saveIndices(ACTIVE_VERSION, { bm25, hnsw });
  _resetCaches();
  _resetTransitiveOrphanCaches();
}

function recallArgs(currentQuery = `what is the ${PROBE_WORD} target`) {
  return {
    surrounding_context: {
      current_query: currentQuery,
      recent_turns: [{ role: "user", content: `${PROBE_WORD} marsupial` }],
      agent_role: "assistant",
      time: "2026-06-02T12:00:00.000Z",
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: "conv_wu_local4096_query",
    max_items: 12,
    max_chars: 4000,
  };
}

function readRecallJsonl() {
  if (!existsSync(RECALL_JSONL)) return [];
  return readFileSync(RECALL_JSONL, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

// ===========================================================================
// T1 — unit: _selectSameDimEmbedding picks embedding_4096 when the query is
// 4096-dim, and returns null for a candidate carrying only a 3072 vector.
// ===========================================================================
test("T1: _selectSameDimEmbedding routes 4096 query to embedding_4096", () => {
  const cand4096 = { embedding_4096: unitSpike(3), embedding_3072: null };
  const sel = _selectSameDimEmbedding(cand4096, DIM);
  assert.ok(Array.isArray(sel), "returns the 4096 vector");
  assert.equal(sel.length, DIM, "selected vector is 4096-dim");
  assert.equal(sel[3], 1, "selected the embedding_4096 spike");

  // A candidate with only a 3072 vector is a DIFFERENT geometry -> null when
  // the query is 4096 (cross-model isolation; never a spurious cosine).
  const cand3072 = { embedding_4096: null, embedding_3072: new Array(3072).fill(0) };
  assert.equal(
    _selectSameDimEmbedding(cand3072, DIM),
    null,
    "3072-only candidate is not selected for a 4096 query",
  );
  // A candidate with NO same-dim vector -> null (partial-coverage -> s_emb=0).
  assert.equal(
    _selectSameDimEmbedding({ embedding_4096: null, embedding_3072: null }, DIM),
    null,
    "no usable vector -> null",
  );
});

// ===========================================================================
// T2 — the LIVE handler embeds the query via the LOCAL client with
// is_query:true and dim:4096, and degraded_recall is FALSE.
// ===========================================================================
test("T2: query embeds via local client (isQuery=true, dim=4096); not degraded", async () => {
  installLocalEmbedMock({ spikeIndex: 7 });
  try {
    writeFixtureLedgerAndIndex(buildFixture());
    const env = await recallMod.TOOL.handler(recallArgs());
    assert.equal(env.ok, true, "handler returns ok envelope");

    // The local embed surface was the one invoked (exactly once for the query).
    assert.equal(embedCallCount, 1, "local embed called exactly once");
    assert.ok(lastEmbedRequest != null, "local /embed received a request");
    assert.equal(
      lastEmbedRequest.is_query,
      true,
      "query routed with is_query:true (asymmetric retrieval-query prefix)",
    );
    assert.equal(lastEmbedRequest.dim, DIM, "request asks for dim=4096");
    assert.ok(
      Array.isArray(lastEmbedRequest.texts) && lastEmbedRequest.texts.length === 1,
      "exactly one assembled query text was embedded",
    );
    // The assembled query carries the surrounding_context (current_query text).
    assert.ok(
      lastEmbedRequest.texts[0].includes(PROBE_WORD),
      "assembled query text includes the surrounding_context",
    );

    // The local embed + 4096 index both succeeded -> NOT degraded.
    assert.equal(
      env.data.degraded_recall,
      false,
      "degraded_recall is FALSE when local embed + 4096 index succeed",
    );
  } finally {
    clearLocalEmbedMock();
  }
});

// ===========================================================================
// T3 — semantic ranking is REAL: the fact whose embedding_4096 is the query's
// nearest neighbor (cosine 1.0) surfaces, and s_emb on the 4096 candidate fires
// (final_score for the NN exceeds the partial-coverage fact's).
// ===========================================================================
test("T3: 4096 nearest-neighbor fact ranks above the unembedded fact (s_emb fires)", async () => {
  installLocalEmbedMock({ spikeIndex: 7 }); // matches fact_match's spike
  try {
    writeFixtureLedgerAndIndex(buildFixture());
    const env = await recallMod.TOOL.handler(recallArgs());
    assert.equal(env.ok, true, "handler ok");
    const memIds = (env.data.memories || []).map((m) => m.id);
    assert.ok(memIds.includes("fact_match"), "the NN fact surfaces in the brief");

    // The NN fact (cosine 1.0 against the query) must outrank the
    // partial-coverage fact (s_emb=0). Compare their brief positions.
    const posMatch = memIds.indexOf("fact_match");
    const posNoEmbed = memIds.indexOf("fact_no_embed");
    if (posNoEmbed !== -1) {
      assert.ok(
        posMatch < posNoEmbed,
        `4096 NN (pos ${posMatch}) ranks above the unembedded fact (pos ${posNoEmbed})`,
      );
    }
    // candidate_set_size reflects a real candidate pool (not 0).
    assert.ok(
      env.data.candidate_set_size > 0,
      "recall produced a non-empty candidate set",
    );
  } finally {
    clearLocalEmbedMock();
  }
});

// ===========================================================================
// T4 — partial coverage: a fact with NO embedding_4096 still surfaces (BM25 +
// additive features) and does NOT crash the handler. s_emb=0 for it.
// ===========================================================================
test("T4: partial-coverage fact (no embedding_4096) surfaces without crashing", async () => {
  installLocalEmbedMock({ spikeIndex: 7 });
  try {
    writeFixtureLedgerAndIndex(buildFixture());
    const env = await recallMod.TOOL.handler(recallArgs());
    assert.equal(env.ok, true, "handler returns ok (no crash on partial coverage)");
    const memIds = (env.data.memories || []).map((m) => m.id);
    assert.ok(
      memIds.includes("fact_no_embed"),
      "the unembedded fact is still recalled via BM25 (graceful partial coverage)",
    );
  } finally {
    clearLocalEmbedMock();
  }
});

// ===========================================================================
// T5 — LocalEmbedUnavailable -> BM25 degrade. The handler does NOT throw;
// degraded_recall is TRUE; candidates still resolve via BM25.
// ===========================================================================
test("T5: local embed server unavailable -> BM25-only degrade (no throw)", async () => {
  installLocalEmbedMock({ fail: true });
  try {
    writeFixtureLedgerAndIndex(buildFixture());
    let env;
    await assert.doesNotReject(async () => {
      env = await recallMod.TOOL.handler(recallArgs());
    }, "handler does not throw when the local server is unavailable");
    assert.equal(env.ok, true, "handler still returns an ok envelope");
    assert.equal(
      env.data.degraded_recall,
      true,
      "degraded_recall is TRUE when the local embed server is unavailable",
    );
    // BM25-only still resolves candidates (the brief is not empty).
    const memIds = (env.data.memories || []).map((m) => m.id);
    assert.ok(memIds.length > 0, "BM25-only degrade still surfaces memories");
  } finally {
    clearLocalEmbedMock();
  }
});

// ===========================================================================
// T6 — the recall.jsonl event records the ACTIVE 4096 model_version on the
// query (not the legacy gemini version), and a non-empty context_embedding
// when the local embed succeeded.
// ===========================================================================
test("T6: recall.jsonl query event stamps the active 4096 model + context_embedding", async () => {
  installLocalEmbedMock({ spikeIndex: 7 });
  try {
    writeFixtureLedgerAndIndex(buildFixture());
    await recallMod.TOOL.handler(recallArgs());
    const events = readRecallJsonl();
    assert.ok(events.length > 0, "a recall event was written");
    const ev = events[events.length - 1];
    assert.equal(ev.kind, "recall", "event kind is recall");
    assert.equal(
      ev.query.embedding_model_version,
      ACTIVE_VERSION,
      "query event stamps the ACTIVE 4096 model version",
    );
    assert.equal(
      ev.query.context_embedding.length,
      DIM,
      "context_embedding is the 4096 query vector",
    );
    assert.equal(
      ev.degraded_recall,
      false,
      "recall event degraded_recall=false on the live local path",
    );
  } finally {
    clearLocalEmbedMock();
  }
});

// ===========================================================================
// T7 — fallback: when the active 4096 index tree is absent entirely, recall
// still returns (it does not return 0 / does not throw). With no active index
// AND no gemini index, BM25-only over an empty store yields an empty-but-ok
// brief; the key invariant is "no crash, ok envelope".
// ===========================================================================
test("T7: missing active index -> recall still returns an ok envelope (no crash)", async () => {
  installLocalEmbedMock({ spikeIndex: 7 });
  try {
    // Build the ledger but DO NOT populate the HNSW (buildHnsw:false) — the
    // active index's HNSW is empty. BM25 still resolves candidates.
    writeFixtureLedgerAndIndex(buildFixture(), { buildHnsw: false });
    let env;
    await assert.doesNotReject(async () => {
      env = await recallMod.TOOL.handler(recallArgs());
    }, "handler does not throw when the active HNSW is empty");
    assert.equal(env.ok, true, "ok envelope even with an empty active HNSW");
    // BM25 still resolves the fixture facts (recall never returns 0 here).
    const memIds = (env.data.memories || []).map((m) => m.id);
    assert.ok(
      memIds.length > 0,
      "BM25 fallback over the active index still surfaces memories",
    );
  } finally {
    clearLocalEmbedMock();
  }
});

// ===========================================================================
// T9 — UNREACHABLE-INDEX PIN, retargeted by l5-fallback-removal.
//
// SHAPE (unchanged): the ACTIVE tree is fully empty (HNSW and BM25 both), and
// the LEGACY gemini-embedding-001 tree has a POPULATED BM25 and an EMPTY HNSW.
//
// HISTORY: this was the REACHABILITY pin for the legacy-coverage fallback
// (r1-revert-l5). While recall.js carried the `activeHnswEmpty &&
// activeBm25Empty` branch, this fixture was the input under which the branch
// did work — it swapped `bm25`/`hnsw` to the legacy tree so the BM25 leg
// resolved candidates the active tree could not see, and the pin asserted
// memories.length > 0.
//
// NOW: l5-fallback-removal deleted that branch, so no cross-model tree swap
// exists and the empty active BM25 is the only lexical source. The pin guards
// the OPPOSITE direction and is the post-removal control: a recall whose index
// is unreachable must return ZERO memories AND report itself degraded — never
// a silently healthy empty brief. Both halves are load-bearing; asserting only
// the emptiness would pass equally on a recall that had lost its degrade flag.
// The degraded_recall assertion below is UNCHANGED and now covers the
// both-empty case too, which previously fell through this chain reporting
// health (residual r1-1).
//
// FL-26 SAFETY, retained: the legacy HNSW is built EMPTY and asserted empty
// below. On the pre-l5 bytes a NON-empty legacy HNSW would have driven
// recall.js into `embedSegments(...)`, i.e. a LIVE outbound Gemini request
// from a test. The assertion stays as a standing guard on the fixture shape.
// ===========================================================================
test("T9: empty ACTIVE tree + populated LEGACY BM25 -> zero memories, reported degraded", async () => {
  installLocalEmbedMock({ spikeIndex: 7 });
  try {
    const rows = buildFixture();
    // Active tree: nothing at all.
    writeFixtureLedgerAndIndex(rows, { buildHnsw: false, buildBm25: false });
    // Legacy tree: BM25 carries every fixture row; HNSW deliberately EMPTY.
    const legacyBm25 = new Bm25Index();
    for (const r of rows) {
      legacyBm25.add({
        memory_id: r.id,
        content: r.content,
        kind: r.kind,
        ts: r.ts,
        entities: [],
      });
    }
    const legacyHnsw = new HnswIndex({
      dims: CAPS.GEMINI_EMBEDDING_DIMS_MRL,
      embedding_model_version: LEGACY_VERSION,
    });
    assert.equal(
      legacyHnsw.size(),
      0,
      "FL-26: the legacy HNSW must stay EMPTY so no live Gemini encode can fire",
    );
    assert.ok(legacyBm25.size() > 0, "legacy BM25 is populated (anti-vacuity)");
    saveIndices(LEGACY_VERSION, { bm25: legacyBm25, hnsw: legacyHnsw });
    _resetCaches();
    _resetTransitiveOrphanCaches();

    let env;
    await assert.doesNotReject(async () => {
      env = await recallMod.TOOL.handler(recallArgs());
    }, "handler does not throw when only the legacy tree has coverage");
    assert.equal(env.ok, true, "ok envelope");
    const memIds = (env.data.memories || []).map((m) => m.id);
    assert.equal(
      memIds.length,
      0,
      `no cross-model fallback: a legacy-only tree serves nothing -- memories=${memIds.join(",")}`,
    );
    // The dense leg is suppressed on this arm (empty active HNSW), so the call
    // is lexical-only over an unreachable index and reports itself degraded.
    assert.equal(
      env.data.degraded_recall,
      true,
      "BM25-only over the legacy tree is reported as degraded",
    );
  } finally {
    clearLocalEmbedMock();
  }
});

// ===========================================================================
// r3-degraded-recall-blindspot — T10/T11/T12.
//
// WHAT T9 ALREADY CLOSED, and what it did not. Since l5-fallback-removal the
// both-empty active tree reports degraded_recall:true (T9 above pins it), so
// the "reports healthy" half of the blindspot is gone. What survives is the
// REASON half: degraded_recall is ONE boolean shared by every degrade on this
// path, so from the envelope alone an operator cannot tell
//
//   (i)  the whole active tree is unservable (both legs empty -> zero
//        memories), from
//   (ii) only the dense leg is unservable (HNSW empty, BM25 populated -> a
//        real lexical brief, merely thinner).
//
// Those two states are conflated by the boolean and were previously
// indistinguishable. T10/T12 are the discrimination pair; T11 is the trap.
//
// SHARED across T10/T12 (registration order): the reason value T10 actually
// observed. T12 asserts DISTINCTNESS against it and fails loudly (never
// vacuously) if T10 did not run first.
// ===========================================================================
let observedBothEmptyReason = null;

test("T10: both active legs empty -> degraded_reason + index_unservable marker on BOTH the response and the recall event", async () => {
  installLocalEmbedMock({ spikeIndex: 7 });
  try {
    // Same fixture shape T9 owns, minus the legacy tree: since
    // l5-fallback-removal no branch re-points recall at another model's tree,
    // so the legacy corpus is inert here and its absence changes nothing.
    writeFixtureLedgerAndIndex(buildFixture(), {
      buildHnsw: false,
      buildBm25: false,
    });
    const env = await recallMod.TOOL.handler(recallArgs());
    assert.equal(env.ok, true, "ok envelope (the degrade is in-band, never a throw)");
    assert.equal(env.data.memories.length, 0, "fixture sanity: the empty tree serves nothing");

    // The boolean is unchanged from T9 — this node adds the REASON beside it.
    assert.equal(env.data.degraded_recall, true, "boolean still true (bit-identical to pre-change)");
    assert.equal(
      env.data.degraded_reason,
      "active_tree_unservable",
      "the whole active tree being unservable must be NAMED, not just flagged",
    );
    const m = env.data.index_unservable;
    assert.ok(m != null && typeof m === "object", "dedicated marker key present on the response");
    assert.equal(m.code, "index_unservable", "machine-readable failure class");
    assert.equal(m.reason, "active_tree_unservable", "marker reason matches degraded_reason");
    assert.equal(m.hnsw_empty, true, "active HNSW reported empty");
    assert.equal(m.bm25_empty, true, "active BM25 reported empty");
    // r3 run 2 — the emptiness above is an OBSERVATION here: in-process
    // loadIndices returns real index objects, so their sizes were measured and
    // the two booleans are honest. (The daemon-mode arm where a model version
    // is ABSENT from queryd's status measures nothing and therefore WITHHOLDS
    // both keys — test (h) in test/daemon/queryd-client.test.mjs.)
    assert.equal(m.sizes_measured, true, "in-process sizes are measured, not inferred");
    assert.equal(m.model_version, ACTIVE_VERSION, "marker names the tree that served this call");
    assert.equal(m.index_source, "in-process", "hermetic run is not queryd-served");

    // The recall EVENT carries the same pair (operators read the ledger, not
    // just the live response).
    const events = readRecallJsonl();
    const ev = events[events.length - 1];
    assert.equal(ev.kind, "recall", "last ledger row is this recall");
    assert.equal(ev.degraded_recall, true, "event boolean still true");
    assert.equal(
      ev.degraded_reason,
      "active_tree_unservable",
      "the event must name the reason too, not only the response",
    );
    assert.ok(ev.index_unservable != null, "dedicated marker key present on the event");
    assert.equal(ev.index_unservable.hnsw_empty, true, "event marker: HNSW empty");
    assert.equal(ev.index_unservable.bm25_empty, true, "event marker: BM25 empty");

    observedBothEmptyReason = env.data.degraded_reason;
  } finally {
    clearLocalEmbedMock();
  }
});

test("T11: NEGATIVE CONTROL — a populated active tree that legitimately matches nothing is NOT degraded", async () => {
  installLocalEmbedMock({ spikeIndex: 999 });
  try {
    // A genuinely POPULATED active tree (both sizes non-zero, asserted below)
    // whose retrieval legs run unsuppressed and simply resolve to nothing: the
    // indexed id is backed by no ledger row, so candidate projection yields an
    // empty brief. This is the spec's trap — an empty RESULT is not a failure.
    // The marker keys on index SIZE, never on result count, so this call must
    // stay clean in BOTH directions (no boolean, no reason key).
    const rows = buildFixture();
    writeFileSync(
      memoryLedgerPath(),
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      { mode: 0o600 },
    );
    const bm25 = new Bm25Index();
    const hnsw = new HnswIndex({ dims: DIM, embedding_model_version: ACTIVE_VERSION });
    bm25.add({
      memory_id: "unbacked_1",
      content: "wombat unrelated corpus token",
      kind: "fact",
      ts: TS,
      entities: [],
    });
    hnsw.add("unbacked_1", unitSpike(3));
    assert.ok(bm25.size() > 0, "anti-vacuity: the active BM25 really is populated");
    assert.ok(hnsw.size() > 0, "anti-vacuity: the active HNSW really is populated");
    saveIndices(ACTIVE_VERSION, { bm25, hnsw });
    _resetCaches();
    _resetTransitiveOrphanCaches();

    const env = await recallMod.TOOL.handler(recallArgs("wombat unrelated corpus token"));
    assert.equal(env.ok, true, "ok envelope");
    assert.equal(env.data.memories.length, 0, "the query legitimately surfaces nothing");
    assert.equal(
      env.data.degraded_recall,
      false,
      "a healthy index that matches nothing is NOT degraded",
    );
    assert.equal(
      "degraded_reason" in env.data,
      false,
      "no reason key on a healthy call (additive: the response stays byte-identical)",
    );
    assert.equal(
      "index_unservable" in env.data,
      false,
      "no marker key on a healthy call",
    );
  } finally {
    clearLocalEmbedMock();
  }
});

test("T12: DISCRIMINATION CONTROL — dense leg unservable + populated BM25 reports a DISTINCT reason", async () => {
  installLocalEmbedMock({ spikeIndex: 7 });
  try {
    // The half-built shape T7 above already owns: the active BM25 carries the
    // corpus, the active HNSW is empty (BM25 rebuilt ahead of the dense
    // backfill). Same boolean as T10, materially different brief.
    writeFixtureLedgerAndIndex(buildFixture(), { buildHnsw: false, buildBm25: true });
    const env = await recallMod.TOOL.handler(recallArgs());
    assert.equal(env.ok, true, "ok envelope");
    assert.ok(env.data.memories.length > 0, "the lexical leg still serves a real brief");
    assert.equal(env.data.degraded_recall, true, "still degraded (dense leg suppressed)");
    assert.equal(
      env.data.degraded_reason,
      "dense_leg_unservable",
      "only the dense leg is unservable here",
    );
    const m = env.data.index_unservable;
    assert.ok(m != null && typeof m === "object", "dedicated marker key present");
    assert.equal(m.hnsw_empty, true, "HNSW empty");
    assert.equal(m.bm25_empty, false, "BM25 populated — this is what splits the two states");
    // r3 run 2 — both booleans above are measured on the in-process path.
    assert.equal(m.sizes_measured, true, "in-process sizes are measured, not inferred");

    // THE POINT OF THIS NODE: the two states the boolean conflated are now
    // separable from the envelope alone.
    assert.ok(
      observedBothEmptyReason != null,
      "anti-vacuity: T10 must have run and recorded its reason before this comparison",
    );
    assert.notEqual(
      env.data.degraded_reason,
      observedBothEmptyReason,
      "dense-leg-only must NOT report the same reason as a wholly unservable tree",
    );
  } finally {
    clearLocalEmbedMock();
  }
});

// ===========================================================================
// T8 — hermeticity: production paths are byte-identical pre/post.
// ===========================================================================
test("T8: production paths byte-identical (hermeticity)", () => {
  assert.equal(snap(PROD_MEMORY_JSONL), PROD_BEFORE.memory, "prod memory.jsonl untouched");
  assert.equal(snap(PROD_RECALL_JSONL), PROD_BEFORE.recall, "prod recall.jsonl untouched");
  assert.equal(snap(PROD_INDICES_DIR), PROD_BEFORE.indices, "prod indices/ untouched");
});
