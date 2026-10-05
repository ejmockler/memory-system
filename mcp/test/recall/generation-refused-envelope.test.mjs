// generation-refused-envelope.test.mjs — FU2 (memperf): in-band
// degraded_reason for refused-generation recall.
//
// FINAL's worst seam: when the ACTIVE index generation is REFUSED (manifest
// member mismatch / deserialize failure) loadIndices serves the retained
// fallback generation (or empty indices) and recall reports
// degraded_recall:false — silent thin briefs (observed live: 1-14 candidates
// vs 46; only stderr + health_notes knew). This suite pins the fix: the
// refusal is stamped IN-BAND on the recall envelope + the recall ledger
// event (degraded_recall:true, degraded_reason:"index_generation_refused",
// threaded {code, member?, served} detail) and on queryd's per-model status,
// while the RESULT LIST stays byte-identical (fallback content still served —
// visibility, never suppression).
//
// RED-FIRST EVIDENCE — verbatim failing run against the UNMODIFIED pre-fix
// index-cache.js/recall.js/queryd.js (2026-07-17, branch memperf):
//
//   ✔ T1 baseline (healthy active generation): no refusal marker, results non-empty (63.680416ms)
//   ✖ T2 cold recall over a refused active generation stamps the envelope in-band (fallback still served) (54.005666ms)
//     AssertionError [ERR_ASSERTION]: RED (the live incident shape): degraded_recall must be true when the active generation was refused (got degraded_recall=false, degraded_reason=null, index_generation_refused=null)
//
//     false !== true
//   ✖ T3 warm-hit recall (same cached entry) still carries the marker (38.228541ms)
//     AssertionError [ERR_ASSERTION]: warm RED: degraded_recall still false on the warm hit (degraded_reason=null, marker=null)
//
//     false !== true
//   ✖ T4 queryd: status exposes the per-model refusal marker; a queryd-mode recall stamps the same envelope (26.932458ms)
//     AssertionError [ERR_ASSERTION]: RED daemon-side: status per-model entry must carry generation_refused (got undefined; entry {"model_version":"qwen3-embedding-8b-fp16","generation":1,"bm25_size":3,"hnsw_size":3,"degraded":false,"degraded_reason":{"code":"index_manifest_member_mismatch","member":"bm25","file":"bm25.json"}})
//
//     + actual - expected
//     + undefined
//     - { code: 'index_manifest_member_mismatch', member: 'bm25', served: 'fallback' }
//   ✔ T5 healthy publication clears the marker (byte-identical no-refusal envelope) (140.2885ms)
//   ✔ hermeticity: temp-tree socket + no writes outside MEMORY_ROOT (0.087208ms)
//   ℹ tests 6 / pass 3 / fail 3
//
// (T2 recorded the CURRENT envelope verbatim: degraded_recall=false,
// degraded_reason=null, index_generation_refused=null — the silent-thin-brief
// incident shape. T5 passed pre-fix vacuously by asserting the absence of
// fields that did not exist yet; post-fix it pins the omit-when-null additive
// invariant for real.)
//
// Discipline (clones test/daemon/queryd-client.test.mjs — RED-RUN ISOLATION):
// mkdtempSync temp root (SHORT prefix: unix socket paths cap at ~104 bytes on
// macOS); MEMORY_ROOT + base dirs overwritten BEFORE any dynamic import; the
// production tree and live daemons are NEVER touched. The local embed fetch
// is MOCKED (_setFetchForTests — no network) so the dense path runs healthy
// and the pre-fix RED is honestly degraded_recall:false, not an embed
// degrade. GEMINI keys scrubbed (Layer-3 rerank degrades deterministically).
// Fixtures only — the temp ledger holds 3 synthetic rows; the real 2GB
// ledgers are never read.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Hermeticity: stake tmp dirs + overwrite env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "fu2-"));
const MEMORY_ROOT = join(TMP_ROOT, "m");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
process.env.TELEMETRY_BASE_DIR = join(MEMORY_ROOT, "telemetry");
// High thresholds: nothing auto-flushes; index publication is explicit here.
process.env.INDEX_SAVE_BATCH = "1000";
process.env.INDEX_SAVE_MAX_AGE_S = "3600";
// Deterministic degrade for Layer-3 rerank; the local embed fetch is mocked
// below (never dialed), so recall's dense path runs with zero network
// dependence and degraded_recall stays FALSE on a healthy tree.
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;
// b4: explicit "0", not delete — _localRerankerEnabled() is tri-state and an
// unset var falls through to CAPS.LOCAL_RERANKER_ENABLED (true), which would
// dial the live :8360 rerank server from a suite that must not touch it.
process.env.LOCAL_RERANKER_ENABLED = "0";
delete process.env.MEMORY_QUERYD;

mkdirSync(process.env.POLICY_BASE_DIR, { recursive: true, mode: 0o700 });
mkdirSync(process.env.STORAGE_BASE_DIR, { recursive: true, mode: 0o700 });
mkdirSync(process.env.LEDGERS_BASE_DIR, { recursive: true, mode: 0o700 });
mkdirSync(join(MEMORY_ROOT, "indices"), { recursive: true, mode: 0o700 });

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// Dynamic imports AFTER env override.
// ---------------------------------------------------------------------------
const { CAPS } = await import("../../lib/validation.js");
const { memoryLedgerPath } = await import("../../lib/config.js");
const { saveIndices, _resetCaches } = await import(
  "../../lib/recall/index-cache.js"
);
const { _resetTransitiveOrphanCaches } = await import(
  "../../lib/recall/hard-gates.js"
);
const { Bm25Index } = await import("../../lib/recall/bm25-index.js");
const { HnswIndex } = await import("../../lib/recall/hnsw-index.js");
const { _setFetchForTests } = await import("../../lib/local-embedder-client.js");
const { Queryd, querydPaths, queryOnce } = await import("../../daemon/queryd.js");
const qc = await import("../../lib/recall/queryd-client.js");
const recallMod = await import("../../lib/tools/recall.js");

const ACTIVE_VERSION = CAPS.ACTIVE_EMBED_MODEL_VERSION;
const DIM = CAPS.EMBEDDING_DIM_4096;
const { socketPath: SOCKET_PATH } = querydPaths();

// The temp tree is the ONLY tree any daemon in this file may serve.
assert.ok(
  SOCKET_PATH.startsWith(MEMORY_ROOT),
  `socket path ${SOCKET_PATH} must live under the temp MEMORY_ROOT`,
);
assert.ok(
  Buffer.byteLength(SOCKET_PATH) < 100,
  `socket path too long for AF_UNIX: ${SOCKET_PATH}`,
);

// ---------------------------------------------------------------------------
// Fixture corpus (deterministic 4096-dim unit vectors in a 3-axis subspace —
// the queryd-client.test.mjs geometry). Two PUBLISHED generations of the SAME
// corpus so the manifest names a retained `previous` fallback: corrupting the
// active fixed-path member then refuses the active candidate while the
// fallback generation serves IDENTICAL content — the result-list-unchanged
// assertion is exact.
// ---------------------------------------------------------------------------
const Q_AXIS = 7;
const B_AXIS = 11;
const C_AXIS = 23;

function subspaceVec(queryComponent, offAxis) {
  const v = new Array(DIM).fill(0);
  v[Q_AXIS] = queryComponent;
  v[offAxis] = Math.sqrt(1 - queryComponent * queryComponent);
  return v;
}

const QUERY_VEC = (() => {
  const v = new Array(DIM).fill(0);
  v[Q_AXIS] = 1;
  return v;
})();
const TS = "2026-06-01T00:00:00.000Z";
function factRow(id, content, embedding) {
  const features = { embedding_model_version: ACTIVE_VERSION };
  if (embedding != null) features.embedding_4096 = embedding;
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

const ROWS = [
  factRow("fact_fu2_alpha", "quokka rottnest marsupial sighting note alpha", subspaceVec(0.97, B_AXIS)),
  factRow("fact_fu2_bravo", "quokka rottnest marsupial sighting note bravo", subspaceVec(0.95, B_AXIS)),
  factRow("fact_fu2_charlie", "quokka rottnest marsupial ferry logistics charlie", subspaceVec(0.9, C_AXIS)),
];
writeFileSync(
  memoryLedgerPath(),
  ROWS.map((r) => JSON.stringify(r)).join("\n") + "\n",
  { mode: 0o600 },
);

function publishCorpusGeneration() {
  const bm25 = new Bm25Index();
  const hnsw = new HnswIndex({
    dims: DIM,
    embedding_model_version: ACTIVE_VERSION,
  });
  for (const r of ROWS) {
    bm25.add({
      memory_id: r.id,
      content: r.content,
      kind: r.kind,
      ts: r.ts,
      entities: [],
    });
    hnsw.add(r.id, r.features.embedding_4096);
  }
  saveIndices(ACTIVE_VERSION, { bm25, hnsw });
  _resetCaches();
  _resetTransitiveOrphanCaches();
}

// Generation 0, then generation 1 (identical corpus): the gen-1 manifest
// names retained gen-0 members as `previous` — the refused-active fallback.
publishCorpusGeneration();
publishCorpusGeneration();

const ACTIVE_DIR = join(MEMORY_ROOT, "indices", ACTIVE_VERSION);
const ACTIVE_BM25_PATH = join(ACTIVE_DIR, "bm25.json");

// Local embed mock: every recall query embeds to QUERY_VEC (never dials).
_setFetchForTests(async (_url, init) => {
  const body = JSON.parse(init.body);
  const texts = Array.isArray(body.texts) ? body.texts : [];
  return {
    ok: true,
    async text() {
      return JSON.stringify({
        embeddings: texts.map(() => QUERY_VEC),
        model_version: ACTIVE_VERSION,
        dim: DIM,
        count: texts.length,
        elapsed_ms: 1,
      });
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
function recallArgs(query = "tell me about the quokka rottnest marsupial notes") {
  return {
    surrounding_context: {
      recent_turns: [{ role: "user", content: "quokka rottnest facts please" }],
      agent_role: "assistant",
      current_query: query,
      time: "2026-06-02T12:00:00.000Z",
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: "conv_fu2_generation_refused",
    max_items: 12,
    max_chars: 4000,
  };
}

const memoryIds = (data) => data.memories.map((m) => m.id);

const EXPECTED_REFUSAL = {
  code: "index_manifest_member_mismatch",
  member: "bm25",
  served: "fallback",
};

// Captured by T1, compared against by T2/T3/T4 — the result-list oracle.
let baselineIds = null;

// ---------------------------------------------------------------------------
// T1 — BASELINE (healthy active generation): results non-empty, no degrade,
// and — the additive invariant — NEITHER marker key exists on the envelope.
// ---------------------------------------------------------------------------
await test("T1 baseline (healthy active generation): no refusal marker, results non-empty", async () => {
  _resetCaches();
  const res = await recallMod.TOOL.handler(recallArgs());
  assert.equal(res.ok, true);
  assert.ok(res.data.memories.length > 0, "fixture sanity: baseline recall surfaces memories");
  assert.equal(res.data.degraded_recall, false, "healthy tree: not degraded");
  assert.equal(
    "degraded_reason" in res.data,
    false,
    "no-refusal envelope must not carry degraded_reason (additive invariant)",
  );
  assert.equal(
    "index_generation_refused" in res.data,
    false,
    "no-refusal envelope must not carry index_generation_refused (additive invariant)",
  );
  baselineIds = memoryIds(res.data);
});

// ---------------------------------------------------------------------------
// T2 — RED CORE (the live incident): corrupt the active generation's bm25
// member (an un-cutover writer's in-place rewrite: size diverges from the
// manifest record) -> the cold load REFUSES the active candidate and serves
// the retained previous generation -> the envelope must say so IN-BAND while
// the result list stays IDENTICAL to the healthy baseline.
// ---------------------------------------------------------------------------
await test("T2 cold recall over a refused active generation stamps the envelope in-band (fallback still served)", async () => {
  appendFileSync(ACTIVE_BM25_PATH, '\n["P","stale",[["mem_zz",1]]]');
  _resetCaches(); // fresh process: cold manifest-gated load

  const res = await recallMod.TOOL.handler(recallArgs());
  assert.equal(res.ok, true);

  // Visibility, never suppression: the fallback generation carries the SAME
  // corpus, so the surfaced result list is unchanged.
  assert.deepEqual(
    memoryIds(res.data),
    baselineIds,
    "fallback content still served — the stamp must not suppress results",
  );

  assert.equal(
    res.data.degraded_recall,
    true,
    "RED (the live incident shape): degraded_recall must be true when the " +
      "active generation was refused (got degraded_recall=" +
      `${res.data.degraded_recall}, degraded_reason=` +
      `${JSON.stringify(res.data.degraded_reason ?? null)}, ` +
      `index_generation_refused=${JSON.stringify(res.data.index_generation_refused ?? null)})`,
  );
  assert.equal(res.data.degraded_reason, "index_generation_refused");
  assert.deepEqual(
    res.data.index_generation_refused,
    EXPECTED_REFUSAL,
    "threaded refusal detail {code, member, served}",
  );

  // Both response-assembly sites: the persisted recall EVENT carries the
  // same stamp (the OPE substrate must see the degrade too).
  const { readFileSync } = await import("node:fs");
  const events = readFileSync(join(process.env.LEDGERS_BASE_DIR, "recall.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
  const ev = events[events.length - 1];
  assert.equal(ev.degraded_recall, true, "recall event stamped degraded");
  assert.equal(ev.degraded_reason, "index_generation_refused");
  assert.deepEqual(ev.index_generation_refused, EXPECTED_REFUSAL);
});

// ---------------------------------------------------------------------------
// T3 — WARM-HIT PERSISTENCE: the refusal marker lives on the cache entry, so
// a second recall served from the warm _indexCache entry still reports it.
// ---------------------------------------------------------------------------
await test("T3 warm-hit recall (same cached entry) still carries the marker", async () => {
  const res = await recallMod.TOOL.handler(recallArgs());
  assert.equal(res.ok, true);
  assert.equal(
    res.data.degraded_recall,
    true,
    `warm RED: degraded_recall still false on the warm hit (degraded_reason=` +
      `${JSON.stringify(res.data.degraded_reason ?? null)}, marker=` +
      `${JSON.stringify(res.data.index_generation_refused ?? null)})`,
  );
  assert.equal(res.data.degraded_reason, "index_generation_refused");
  assert.deepEqual(res.data.index_generation_refused, EXPECTED_REFUSAL);
  assert.deepEqual(memoryIds(res.data), baselineIds, "warm results unchanged");
});

// ---------------------------------------------------------------------------
// T4 — DAEMON SIDE: queryd loads via the same loadIndices, so its status must
// expose the per-model refusal marker (additive), and a queryd-mode recall
// must stamp the same envelope fields. This closes assessModelHealth's
// blind spot from the LOAD itself (its verify probe already breadcrumbs the
// mismatch, but a fallback serve reports degraded:false — the marker says
// WHAT was served). Q2 herd ban untouched: the marker rides the existing
// status call only.
// ---------------------------------------------------------------------------
await test("T4 queryd: status exposes the per-model refusal marker; a queryd-mode recall stamps the same envelope", async () => {
  _resetCaches(); // daemon cold-loads the refused tree itself
  const daemon = new Queryd({ modelVersions: [ACTIVE_VERSION], watchIntervalMs: 60000 });
  try {
    await daemon.start();
    await daemon.ready;

    const status = await queryOnce(SOCKET_PATH, { type: "status" });
    assert.equal(status.ok, true);
    const entry = status.models.find((m) => m.model_version === ACTIVE_VERSION);
    assert.ok(entry != null, "daemon carries the active model");
    assert.deepEqual(
      entry.generation_refused,
      EXPECTED_REFUSAL,
      "RED daemon-side: status per-model entry must carry generation_refused " +
        `(got ${JSON.stringify(entry.generation_refused)}; entry ${JSON.stringify(entry)})`,
    );

    process.env.MEMORY_QUERYD = "required";
    qc._resetQuerydForTest();
    const res = await recallMod.TOOL.handler(recallArgs());
    assert.equal(res.ok, true);
    assert.equal(res.data.index_source, "queryd", "served by the daemon");
    assert.deepEqual(memoryIds(res.data), baselineIds, "daemon-served results unchanged");
    assert.equal(
      res.data.degraded_recall,
      true,
      `queryd-mode RED: degraded_recall=${res.data.degraded_recall}, ` +
        `degraded_reason=${JSON.stringify(res.data.degraded_reason ?? null)}, ` +
        `marker=${JSON.stringify(res.data.index_generation_refused ?? null)}`,
    );
    assert.equal(res.data.degraded_reason, "index_generation_refused");
    assert.deepEqual(res.data.index_generation_refused, EXPECTED_REFUSAL);
  } finally {
    delete process.env.MEMORY_QUERYD;
    qc._resetQuerydForTest();
    await daemon.stop();
  }
});

// ---------------------------------------------------------------------------
// T5 — CLEARING + ADDITIVE INVARIANT: a healthy publication replaces the
// refused generation; the marker clears on the next load (cold AND the
// saveIndices-reseeded warm entry) and the envelope reverts to the
// byte-identical no-refusal shape (neither key present). Daemon status for a
// healthy tree omits generation_refused entirely.
// ---------------------------------------------------------------------------
await test("T5 healthy publication clears the marker (byte-identical no-refusal envelope)", async () => {
  publishCorpusGeneration(); // gen 2: fresh members + manifest over the corrupt tree
  _resetCaches();

  const res = await recallMod.TOOL.handler(recallArgs());
  assert.equal(res.ok, true);
  assert.equal(res.data.degraded_recall, false, "healthy again after repair");
  assert.equal("degraded_reason" in res.data, false, "marker cleared (envelope)");
  assert.equal("index_generation_refused" in res.data, false, "marker cleared (detail)");
  assert.deepEqual(memoryIds(res.data), baselineIds, "repaired results match baseline");

  // Warm hit on the healthy entry stays clean too.
  const warm = await recallMod.TOOL.handler(recallArgs());
  assert.equal(warm.data.degraded_recall, false);
  assert.equal("index_generation_refused" in warm.data, false);

  // Daemon-side omit-when-null: a healthy tree's status entry carries NO
  // generation_refused key (byte-identical pre-fix status shape).
  _resetCaches();
  const daemon = new Queryd({ modelVersions: [ACTIVE_VERSION], watchIntervalMs: 60000 });
  try {
    await daemon.start();
    await daemon.ready;
    const status = await queryOnce(SOCKET_PATH, { type: "status" });
    const entry = status.models.find((m) => m.model_version === ACTIVE_VERSION);
    assert.ok(entry != null);
    assert.equal(
      "generation_refused" in entry,
      false,
      "healthy status entry must omit generation_refused (additive invariant)",
    );
  } finally {
    await daemon.stop();
  }
});

// ---------------------------------------------------------------------------
// T6 — r3-degraded-recall-blindspot: THE ONE REACHABLE COLLISION.
//
// r3 adds a second visibility marker on this path (`index_unservable`, keyed
// on the ACTIVE tree's index SIZES) whose degraded_reason values are
// "active_tree_unservable" / "dense_leg_unservable". Against the other markers
// it is mutually exclusive by construction — a suppressed dense leg means
// `denseSegs` is empty (no bad_request to count) and the Layer-2 prefetch's
// `!degradedRecall` guard never opens. `index_generation_refused` is the
// exception: a refused ACTIVE generation that serves the fail-closed EMPTY
// indices fires BOTH.
//
// This pins the precedence for that overlap. A present-but-unparseable
// manifest is refused as a whole tree and stamped served:"empty", which is the
// shortest honest route to the overlap on this harness (loadIndices' own
// "unreadable-but-present manifest" branch). The pre-existing
// degraded_reason must be byte-identical to T2's, and NEITHER detail key may
// be lost.
// ---------------------------------------------------------------------------
await test("T6 refused active generation that serves EMPTY: index_generation_refused still wins, both detail keys survive", async () => {
  const { MANIFEST_FILE } = await import("../../lib/recall/index-manifest.js");
  writeFileSync(join(ACTIVE_DIR, MANIFEST_FILE), "{not json at all", {
    mode: 0o600,
  });
  _resetCaches(); // cold load: the corrupt manifest is actually read

  const res = await recallMod.TOOL.handler(recallArgs());
  assert.equal(res.ok, true, "the degrade stays in-band");
  assert.equal(
    res.data.memories.length,
    0,
    "fixture sanity: the whole tree was refused, so the empty indices serve",
  );
  assert.equal(res.data.degraded_recall, true, "degraded either way");

  // PRECEDENCE: r3's spread is placed FIRST at both envelope sites, so the
  // later index_generation_refused spread overwrites degraded_reason and the
  // pre-existing value is unchanged.
  assert.equal(
    res.data.degraded_reason,
    "index_generation_refused",
    "the pre-existing reason must win the collision unchanged",
  );
  assert.equal(
    res.data.index_generation_refused.served,
    "empty",
    "fixture sanity: this really is the refused-AND-empty overlap",
  );
  assert.ok(
    res.data.index_unservable != null,
    "the dedicated r3 marker key survives the collision alongside the refusal detail",
  );
  assert.equal(res.data.index_unservable.hnsw_empty, true, "empty serve: HNSW empty");
  assert.equal(res.data.index_unservable.bm25_empty, true, "empty serve: BM25 empty");

  // Same at the EVENT site (same spread order).
  const { readFileSync } = await import("node:fs");
  const events = readFileSync(join(process.env.LEDGERS_BASE_DIR, "recall.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
  const ev = events[events.length - 1];
  assert.equal(ev.degraded_reason, "index_generation_refused", "event precedence identical");
  assert.ok(ev.index_generation_refused != null, "event keeps the refusal detail");
  assert.ok(ev.index_unservable != null, "event keeps the r3 marker");
});

// ---------------------------------------------------------------------------
// Hermeticity pin.
// ---------------------------------------------------------------------------
await test("hermeticity: temp-tree socket + no writes outside MEMORY_ROOT", () => {
  assert.ok(memoryLedgerPath().startsWith(MEMORY_ROOT), "ledger is the temp fixture");
  assert.ok(ACTIVE_DIR.startsWith(MEMORY_ROOT), "indices are the temp fixture");
});
