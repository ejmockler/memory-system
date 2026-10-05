// queryd-client.test.mjs — Q2 thin queryd client in recall (no fallback herd).
//
// What this suite pins (node spec Q2, memperf):
//   (a) HERD BAN — MEMORY_QUERYD=required with no daemon: memory_recall
//       returns the structured degrade ({code:"queryd_unavailable",
//       retryable:true} in the ToolError details) and PROVABLY never invokes
//       in-process index loading (a counting spy injected via
//       recall.__setLoadIndicesForTest stays at 0).
//   (d) auto mode with NO socket present: the recall response carries NO
//       additive fields (no index_source, no generation) and deep-equals the
//       MEMORY_QUERYD=off response — the pre-Q2 in-process path, loadIndices
//       spy > 0 (i.e. today's behavior, byte-identical).
//   (b) EQUIVALENCE — same fixture corpus, live daemon: daemon-mode recall
//       (required AND auto-with-socket) deep-equals the in-process response
//       minus the additive index_source/generation fields, with ZERO
//       in-process index loads, and the response is stamped
//       index_source:"queryd" + generation.
//   (c) mid-session daemon death: the NEXT call degrades loudly (bounded — 1
//       reconnect attempt), still zero in-process loads; after a daemon
//       restart the next call recovers WITHOUT any process-level reset
//       (per-request re-probe).
//   (e) LOADING: a request against a daemon stalled in its initial load gets
//       exactly one 250ms retry then the loud structured degrade; once the
//       daemon is READY the same client recovers.
//   (f) vector_fetch chunking: >VECTOR_FETCH_MAX_IDS ids are chunked
//       client-side (a single over-cap frame would be a daemon bad_request).
//   (i) FU3 — Q2 in-flight daemon death at the CLIENT protocol level: a mock
//       hello-then-destroy unix server (reusing the real wire protocol) makes
//       QuerydClient.request reject QuerydUnavailableError with attempts===2
//       after the server observed EXACTLY 2 connections, in bounded time.
//   (j) FU3 — client-side deadline: a daemon wedged via _setStallHook plus a
//       short deadlineMs rejects with the mirrored queryd_client_deadline
//       path (reason "timeout") and the SAME client serves the next request
//       once the stall clears (connection usable after a deadline).
//
// FU3 also adds ROW_G, the CHUNK-ID GIANT: a fact whose 4096 vector lives
// ONLY under the `${factId}#0` chunk id in the HNSW sidecar (no row vector,
// no bare-factId index entry) — the re-embedded >40,960-token giant shape.
// The in-process oracle (d) resolves its s_emb via the index_vector_id
// fallback in _resolveCandidateEmbedding; the daemon-mode deep-equal (b)
// therefore transitively pins that recall's queryd vector_fetch prefetch
// includes the winning-chunk id (a dropped chunk vector flips s_emb 0.99->0
// and visibly reorders the brief). (b) additionally asserts the RECORDED
// wanted-id union contains BOTH the bare factId and `${factId}#0`.
//
// RED-FIRST NOTE: authored before mcp/lib/recall/queryd-client.js and the
// recall.js daemon seams existed — the recorded red run fails on
// ERR_MODULE_NOT_FOUND (queryd-client.js) / missing __setLoadIndicesForTest,
// which is the honest pre-Q2 baseline (the component itself is absent; a
// naive-fallback stub would only test the stub). The herd-ban assertion (a)
// is the load-bearing red: any implementation that silently falls back to
// in-process loading fails it.
//
// Discipline (matches test/daemon/queryd.test.mjs):
//   - mkdtempSync rooted in tmpdir (SHORT prefix: unix socket paths cap at
//     ~104 bytes on macOS); MEMORY_ROOT + base dirs overwritten BEFORE any
//     dynamic import. Production trees and live daemons are NEVER touched:
//     every daemon in this file is started against the temp STORAGE_DIR.
//   - local embed server is MOCKED via _setFetchForTests (no network); GEMINI
//     keys scrubbed so Layer-3 rerank degrades deterministically.
//   - node:test + node:assert/strict; _resetCaches / _resetQuerydForTest
//     between phases.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Hermeticity: stake tmp dirs + overwrite env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "q2-"));
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
// (never dialed), so recall's dense path runs with zero network dependence.
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
const { loadIndices, saveIndices, _resetCaches } = await import(
  "../../lib/recall/index-cache.js"
);
const { _resetTransitiveOrphanCaches } = await import(
  "../../lib/recall/hard-gates.js"
);
const { Bm25Index } = await import("../../lib/recall/bm25-index.js");
const { HnswIndex } = await import("../../lib/recall/hnsw-index.js");
const { _setFetchForTests } = await import("../../lib/local-embedder-client.js");
const { Queryd, querydPaths, queryOnce } = await import("../../daemon/queryd.js");
// FU3 (i) — the mock hello-then-destroy server REUSES the real wire protocol
// (frames, caps, hello handshake) so the client under test sees byte-faithful
// daemon behavior up to the mid-request death.
const {
  FrameDecoder,
  MAX_INBOUND_FRAME_BYTES,
  MAX_OUTBOUND_FRAME_BYTES,
  PROTOCOL_VERSION,
  encodeFrame,
  helloFrame,
} = await import("../../daemon/queryd-protocol.js");
const qc = await import("../../lib/recall/queryd-client.js");
const recallMod = await import("../../lib/tools/recall.js");

const ACTIVE_VERSION = CAPS.ACTIVE_EMBED_MODEL_VERSION;
const DIM = CAPS.EMBEDDING_DIM_4096;
const QUERYD_PATH = join(import.meta.dirname, "..", "..", "daemon", "queryd.js");
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
// Fixture corpus — 4096-dim unit vectors in a 3-axis subspace (the same
// deterministic geometry as test/recall-mmr-active-geometry.test.mjs).
// ROW_A carries its vector on the ledger row (row-vector path: the daemon
// vector_fetch overlay must NOT fire for it); ROW_B / ROW_C carry vectors
// ONLY in the HNSW sidecar (the index-overlay path recall resolves via
// hnsw.getVectorByMemoryId in-process and via queryd vector_fetch in daemon
// mode). ROW_G (FU3) is the chunk-id giant: its vector lives ONLY under
// `${ROW_G_ID}#0` (never the bare fact id), with the HIGHEST query component
// (0.99) so a dropped chunk vector visibly changes s_emb and the brief
// ordering — the daemon/in-process deep-equal is mutation-sensitive to the
// index_vector_id fallback. Its content deliberately shares fewer query
// terms than A/B/C so the bare-id BM25 entry ranks LAST and the dense-leg
// chunk entry (rank 0) wins the RRF dedup — index_vector_id must therefore
// be `${ROW_G_ID}#0`, never the bare id.
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
const ROW_A_ID = "fact_q2_alpha";
const ROW_B_ID = "fact_q2_bravo";
const ROW_C_ID = "fact_q2_charlie";
const ROW_G_ID = "fact_q2_golf";
const ROW_G_CHUNK_ID = `${ROW_G_ID}#0`;
const VEC_A = subspaceVec(0.97, B_AXIS);
const VEC_B = subspaceVec(0.95, B_AXIS);
const VEC_C = subspaceVec(0.9, C_AXIS);
const VEC_G = subspaceVec(0.99, B_AXIS);

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
  factRow(ROW_A_ID, "quokka rottnest marsupial sighting note alpha", VEC_A),
  factRow(ROW_B_ID, "quokka rottnest marsupial sighting note bravo", null),
  factRow(ROW_C_ID, "quokka rottnest marsupial ferry logistics charlie", null),
  // FU3 — the chunk-id giant: NO row vector, and (below) NO bare-id HNSW
  // entry either; the vector exists ONLY under ROW_G_CHUNK_ID. Fewer query
  // terms than A/B/C (no "marsupial"/"note") keeps its bare-id BM25 rank
  // last so the chunk entry wins the fused dedup (see fixture comment).
  factRow(ROW_G_ID, "quokka rottnest giant chunk fixture golf", null),
];
writeFileSync(
  memoryLedgerPath(),
  ROWS.map((r) => JSON.stringify(r)).join("\n") + "\n",
  { mode: 0o600 },
);

const VEC_BY_ID = new Map([
  [ROW_A_ID, VEC_A],
  [ROW_B_ID, VEC_B],
  [ROW_C_ID, VEC_C],
]);
// Publish the POPULATED fixture generation over indices/<ACTIVE_VERSION>/.
// r3-degraded-recall-blindspot — extracted from the module-level block it used
// to be so case (k) below can publish an EMPTY tree and then RESTORE this one
// byte-for-byte, rather than duplicating the fixture build.
function publishFixtureIndices() {
  const bm25 = new Bm25Index();
  const hnsw = new HnswIndex({
    dims: DIM,
    embedding_model_version: ACTIVE_VERSION,
  });
  for (const r of ROWS) {
    // BM25 always indexes the BARE fact id (chunking is a dense-leg concern).
    bm25.add({
      memory_id: r.id,
      content: r.content,
      kind: r.kind,
      ts: r.ts,
      entities: [],
    });
    const vec = VEC_BY_ID.get(r.id);
    if (vec != null) hnsw.add(r.id, vec);
  }
  // FU3 — the giant's vector is stored ONLY under its chunk id, exactly like
  // reembed-local-4096 stores >40,960-token giants. There is deliberately NO
  // hnsw entry under the bare ROW_G_ID: any resolution of ROW_G's s_emb MUST
  // go through the index_vector_id (winning-chunk) fallback.
  hnsw.add(ROW_G_CHUNK_ID, VEC_G);
  saveIndices(ACTIVE_VERSION, { bm25, hnsw });
  _resetCaches();
  _resetTransitiveOrphanCaches();
}
publishFixtureIndices();

// The in-process truth for vector equivalence (what getVectorByMemoryId
// serves from the freshly published generation).
const DIRECT_VEC_B = loadIndices(ACTIVE_VERSION).hnsw.getVectorByMemoryId(ROW_B_ID);
assert.ok(Array.isArray(DIRECT_VEC_B), "fixture sanity: index-resident vector");
_resetCaches();

// Local embed mock: every recall query embeds to QUERY_VEC. Installed for the
// whole file; the fetch stub never dials the network.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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
    conversation_id: "conv_q2_queryd_client",
    max_items: 12,
    max_chars: 4000,
  };
}

// Deep-equal projection: drop the per-call random recall_id, the Q2 additive
// fields under test (index_source/generation), and the wall-clock Layer-3
// latency. Everything else — memories, scores, ordering, degrade flags,
// populator counts — must match exactly across backends.
function sanitized(data) {
  const clone = JSON.parse(JSON.stringify(data));
  delete clone.recall_id;
  delete clone.index_source;
  delete clone.generation;
  delete clone.layer3_latency_ms;
  return clone;
}

// r3-degraded-recall-blindspot — the RECALL EVENT rows this process appended
// to the temp ledger tree (never the live one: LEDGERS_BASE_DIR was pointed at
// the temp MEMORY_ROOT before any import). Operators read the ledger, not just
// the live response, so the event's degraded_reason is asserted alongside the
// response's.
function readRecallEvents() {
  const p = join(process.env.LEDGERS_BASE_DIR, "recall.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

// In-process loadIndices spy: recall.js routes its in-process index loads
// through this seam, so a count of 0 PROVES the herd ban (no in-process index
// deserialization) on daemon-mode paths.
let inProcessLoads = 0;
recallMod.__setLoadIndicesForTest((mv) => {
  inProcessLoads += 1;
  return loadIndices(mv);
});

function spawnDaemon(models = ACTIVE_VERSION) {
  const child = spawn(process.execPath, [QUERYD_PATH, `--models=${models}`], {
    env: { ...process.env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += String(d);
  });
  const exited = new Promise((res) =>
    child.once("exit", (code, sig) => res({ code, sig })),
  );
  return { child, exited, stderrText: () => stderr };
}

async function waitReady(stderrText) {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const resp = await queryOnce(SOCKET_PATH, { type: "status" });
      if (resp.ok === true && resp.state === "ready") return resp;
    } catch {
      // socket not up yet
    }
    assert.ok(
      Date.now() < deadline,
      `daemon never became ready; stderr:\n${stderrText()}`,
    );
    await sleep(50);
  }
}

async function stopDaemon(handle) {
  if (handle.child.exitCode == null) handle.child.kill("SIGTERM");
  const { code } = await handle.exited;
  assert.equal(code, 0, `daemon exit code ${code}; stderr:\n${handle.stderrText()}`);
}

const isQuerydUnavailableToolError = (e) =>
  e != null &&
  e.details != null &&
  e.details.code === "queryd_unavailable" &&
  e.details.retryable === true;

// Captured by (d), compared against by (b)/(c) — the cross-backend oracle.
let inProcessData = null;

// ---------------------------------------------------------------------------
// (a) HERD BAN — required + no daemon: structured degrade, ZERO in-process loads.
// ---------------------------------------------------------------------------
test("(a) herd ban: MEMORY_QUERYD=required with no daemon degrades loud with zero in-process index loads", async () => {
  process.env.MEMORY_QUERYD = "required";
  qc._resetQuerydForTest();
  inProcessLoads = 0;

  await assert.rejects(
    () => recallMod.TOOL.handler(recallArgs()),
    (e) => {
      assert.ok(
        isQuerydUnavailableToolError(e),
        `expected structured queryd_unavailable degrade, got: ${e && e.stack}`,
      );
      return true;
    },
  );
  assert.equal(
    inProcessLoads,
    0,
    "HERD BAN VIOLATED: recall invoked in-process loadIndices in daemon mode",
  );
});

// ---------------------------------------------------------------------------
// (d) auto with no socket == pre-Q2 in-process path, no additive fields.
// ---------------------------------------------------------------------------
test("(d) auto mode with no socket: in-process path, no additive fields, identical to off mode", async () => {
  delete process.env.MEMORY_QUERYD;
  qc._resetQuerydForTest();
  _resetCaches();
  inProcessLoads = 0;

  const resAuto = await recallMod.TOOL.handler(recallArgs());
  assert.equal(resAuto.ok, true);
  assert.ok(inProcessLoads > 0, "auto-with-no-socket must use in-process loadIndices");
  assert.ok(!("index_source" in resAuto.data), "no additive index_source field");
  assert.ok(!("generation" in resAuto.data), "no additive generation field");
  assert.equal(resAuto.data.degraded_recall, false, "dense path live on fixture");
  assert.equal(
    resAuto.data.memories.length,
    4,
    `expected all 4 fixture memories, got ${JSON.stringify(resAuto.data.memories)}`,
  );
  // FU3 — chunk-giant geometry pin: ROW_G surfaces, and it surfaces AHEAD of
  // ROW_C. ROW_G's only lexical/dense signals are weak (BM25 rank last, rrf
  // from a single leg) — it outranks ROW_C only because its s_emb resolved to
  // 0.99 via the `${ROW_G_ID}#0` chunk vector (the index_vector_id fallback
  // in _resolveCandidateEmbedding). If that resolution broke (s_emb=0), this
  // ordering flips, so the oracle captured below is ordering-sensitive to the
  // chunk-vector fetch — which is what makes the daemon-mode deep-equal in
  // (b) pin the SAME fallback through queryd vector_fetch.
  const briefIds = resAuto.data.memories.map((m) => m.id);
  assert.ok(
    briefIds.includes(ROW_G_ID),
    `chunk-id giant must surface (got ${JSON.stringify(briefIds)})`,
  );
  assert.ok(
    briefIds.indexOf(ROW_G_ID) < briefIds.indexOf(ROW_C_ID),
    `giant (s_emb 0.99 via chunk vector) must outrank charlie (0.9); got ${JSON.stringify(briefIds)}`,
  );

  process.env.MEMORY_QUERYD = "off";
  qc._resetQuerydForTest();
  const resOff = await recallMod.TOOL.handler(recallArgs());
  assert.equal(resOff.ok, true);
  assert.ok(!("index_source" in resOff.data) && !("generation" in resOff.data));
  assert.deepEqual(
    sanitized(resAuto.data),
    sanitized(resOff.data),
    "auto-with-no-socket must be identical to off (the pre-Q2 path)",
  );

  inProcessData = sanitized(resOff.data);
});

// ---------------------------------------------------------------------------
// (b) equivalence + additive stamp + zero loads against a live child daemon;
// (c) daemon death -> loud degrade; restart -> recovery without reset.
// ---------------------------------------------------------------------------
test("(b)+(c) daemon mode: equivalence, additive stamp, zero loads; death degrades, restart recovers", async () => {
  assert.ok(inProcessData != null, "test (d) must have captured the oracle");

  let handle = spawnDaemon();
  try {
    await waitReady(handle.stderrText);

    // --- (b) required mode against the live daemon.
    process.env.MEMORY_QUERYD = "required";
    qc._resetQuerydForTest();
    inProcessLoads = 0;
    // FU3 — record the vector_fetch wanted-id union. Materialize the shared
    // singleton FIRST (recall's handler reuses it via getQuerydClient), then
    // wrap its vectorFetch as an own-property spy that delegates to the real
    // prototype method. Restored below by deleting the own property.
    const sharedClient = qc.getQuerydClient();
    const recordedVectorFetchIds = new Set();
    sharedClient.vectorFetch = function (modelVersion, ids, opts) {
      for (const id of Array.isArray(ids) ? ids : []) {
        recordedVectorFetchIds.add(id);
      }
      return qc.QuerydClient.prototype.vectorFetch.call(
        this,
        modelVersion,
        ids,
        opts,
      );
    };
    let resRequired;
    try {
      resRequired = await recallMod.TOOL.handler(recallArgs());
    } finally {
      delete sharedClient.vectorFetch; // restore the prototype method
    }
    assert.equal(resRequired.ok, true);
    assert.equal(inProcessLoads, 0, "daemon mode must not loadIndices in-process");
    // r3-degraded-recall-blindspot — NEGATIVE CONTROL in daemon mode: a
    // healthy, populated, daemon-served call carries NO marker key at all and
    // is not degraded. The marker keys on index SIZE / status PRESENCE, so it
    // must be unreachable here.
    assert.equal(
      "index_unservable" in resRequired.data,
      false,
      "no unservable marker on a healthy daemon-served call (additive: byte-identical)",
    );
    assert.equal(
      resRequired.data.degraded_recall,
      false,
      "a healthy populated daemon-served call is NOT degraded",
    );
    assert.equal(resRequired.data.index_source, "queryd", "additive index_source stamp");
    assert.equal(resRequired.data.generation, 0, "generation from queryd envelopes");
    assert.deepEqual(
      sanitized(resRequired.data),
      inProcessData,
      "daemon-mode response must deep-equal the in-process response (minus additive fields)",
    );
    // FU3 — the wanted-id union must contain BOTH the giant's bare fact id
    // (the row-level lookup that MISSES for giants) and its winning-chunk
    // `${factId}#0` id (the index_vector_id fallback that HITS). Dropping
    // either from recall's prefetch union regresses the giant to s_emb=0.
    // RED-RUN RECORD (2026-07-17, scratch copy of THIS file with absolute
    // imports and the fixture mutated to store the giant's vector under the
    // bare fact id — live tree untouched): this assertion fails verbatim
    //   AssertionError [ERR_ASSERTION]: daemon-mode rescore prefetch must
    //   request the giant's winning-chunk id fact_q2_golf#0 (recorded: [...])
    // because index_vector_id degenerates to the bare id when no chunk entry
    // exists — proving the assertion pins the chunk-id path, not mere
    // vector_fetch traffic. A SECOND red run (same date, scratch copy whose
    // spy FILTERS ROW_G_CHUNK_ID out of the delegated ids — simulating a
    // recall that drops index_vector_id from its prefetch union) fails the
    // deep-equal above ("daemon-mode response must deep-equal the in-process
    // response"): the giant rescored s_emb=0 and the brief reordered, proving
    // the equivalence gate itself is ordering-sensitive to the chunk vector
    // (s_emb resolved via the index_vector_id fallback, not 0).
    assert.ok(
      recordedVectorFetchIds.has(ROW_G_ID),
      `daemon-mode rescore prefetch must request the giant's bare fact id ${ROW_G_ID} (recorded: ${JSON.stringify([...recordedVectorFetchIds])})`,
    );
    assert.ok(
      recordedVectorFetchIds.has(ROW_G_CHUNK_ID),
      `daemon-mode rescore prefetch must request the giant's winning-chunk id ${ROW_G_CHUNK_ID} (recorded: ${JSON.stringify([...recordedVectorFetchIds])})`,
    );

    // --- (b) auto mode finds the socket -> same daemon path.
    delete process.env.MEMORY_QUERYD;
    qc._resetQuerydForTest();
    inProcessLoads = 0;
    const resAuto = await recallMod.TOOL.handler(recallArgs());
    assert.equal(resAuto.ok, true);
    assert.equal(inProcessLoads, 0, "auto-with-socket must not loadIndices in-process");
    assert.equal(resAuto.data.index_source, "queryd");
    assert.deepEqual(sanitized(resAuto.data), inProcessData);

    // --- (c) daemon death: the NEXT call fails loud and bounded; no silent
    // in-process fallback (mode stays memoized as daemon — no reset here).
    await stopDaemon(handle);
    inProcessLoads = 0;
    await assert.rejects(
      () => recallMod.TOOL.handler(recallArgs()),
      (e) => {
        assert.ok(
          isQuerydUnavailableToolError(e),
          `expected structured queryd_unavailable degrade, got: ${e && e.stack}`,
        );
        return true;
      },
    );
    assert.equal(
      inProcessLoads,
      0,
      "HERD BAN VIOLATED: daemon death fell back to in-process loadIndices",
    );

    // --- (c) daemon restart: the next call recovers via per-request
    // re-probe — NO _resetQuerydForTest between death and recovery.
    handle = spawnDaemon();
    await waitReady(handle.stderrText);
    inProcessLoads = 0;
    const resRecovered = await recallMod.TOOL.handler(recallArgs());
    assert.equal(resRecovered.ok, true);
    assert.equal(inProcessLoads, 0);
    assert.equal(resRecovered.data.index_source, "queryd");
    assert.deepEqual(sanitized(resRecovered.data), inProcessData);
  } finally {
    if (handle.child.exitCode == null) {
      await stopDaemon(handle).catch(() => handle.child.kill("SIGKILL"));
    }
    delete process.env.MEMORY_QUERYD;
    qc._resetQuerydForTest();
  }
});

// ---------------------------------------------------------------------------
// (g) CONFIG HARDENING (REG followup, red-first): an UNRECOGNIZED
// MEMORY_QUERYD value must fail TOWARD the herd ban — resolve as "required"
// (daemon mode; with no daemon the caller gets the loud structured degrade)
// and emit exactly ONE stderr warning naming the raw value. Pre-REG any
// unrecognized value silently resolved to auto: with no socket present the
// recall herd-loaded the multi-GB indices in-process — the exact failure mode
// a MEMORY_QUERYD=required deployment set the env var to ban (one typo like
// "requird" reopened it, silently).
//
// RED-RUN RECORD (2026-07-16, this workspace, hermetic temp tree only —
// verbatim failing run against the UNMODIFIED pre-REG queryd-client.js
// _readModeEnv, which mapped every unrecognized value to "auto"):
//
//   ✖ (g) unrecognized MEMORY_QUERYD value resolves to required (herd ban) with one stderr warning naming it (0.780667ms)
//     AssertionError [ERR_ASSERTION]: unrecognized MEMORY_QUERYD must resolve as required (fail toward the herd ban), never silently auto
//     + actual - expected
//     + 'in-process'
//     - 'daemon'
//
// (test (h) below failed in the same red run against the unmodified
// recall.js — the pre-REG mismatch produced exactly the SILENT empty brief
// this node bans:
//
//   ✖ (h) daemon without the active model version: response carries degraded_reason queryd_model_missing, never a silent empty brief (76.115042ms)
//     AssertionError [ERR_ASSERTION]: mismatch must be LOUD on the response (got {"degraded_recall":false,"memories":0})
//     + actual - expected
//     + undefined
//     - 'queryd_model_missing'
// )
// ---------------------------------------------------------------------------
test("(g) unrecognized MEMORY_QUERYD value resolves to required (herd ban) with one stderr warning naming it", async () => {
  process.env.MEMORY_QUERYD = "requird"; // the realistic typo
  qc._resetQuerydForTest();
  const captured = [];
  const realErr = console.error;
  console.error = (...args) => {
    captured.push(args.map(String).join(" "));
  };
  let mode;
  let modeAgain;
  try {
    mode = await qc.resolveQuerydMode();
    modeAgain = await qc.resolveQuerydMode(); // memoized: no second warning
  } finally {
    console.error = realErr;
    delete process.env.MEMORY_QUERYD;
    qc._resetQuerydForTest();
  }
  assert.equal(
    mode,
    "daemon",
    "unrecognized MEMORY_QUERYD must resolve as required (fail toward the herd ban), never silently auto",
  );
  assert.equal(modeAgain, "daemon", "memoized resolution is stable");
  const warnings = captured.filter(
    (l) => l.includes("MEMORY_QUERYD") && l.includes("requird"),
  );
  assert.equal(
    warnings.length,
    1,
    `exactly one stderr warning naming the raw value (got ${JSON.stringify(captured)})`,
  );
  assert.ok(
    warnings[0].includes("required"),
    `warning names the fail-closed resolution (got: ${warnings[0]})`,
  );
});

// ---------------------------------------------------------------------------
// (h) MODEL MISMATCH (REG followup): a daemon that does NOT carry the model
// version serving this call (spawned --models=<other>) must never yield a
// SILENT empty brief stamped index_source:"queryd" — the response carries
// degraded_reason "queryd_model_missing" + degraded_recall=true, and the
// herd ban still holds (zero in-process index loads).
// ---------------------------------------------------------------------------
test("(h) daemon without the active model version: response carries degraded_reason queryd_model_missing, never a silent empty brief", async () => {
  const OTHER = `${ACTIVE_VERSION}-other-tree`;
  const handle = spawnDaemon(OTHER);
  try {
    await waitReady(handle.stderrText);
    process.env.MEMORY_QUERYD = "required";
    qc._resetQuerydForTest();
    inProcessLoads = 0;
    const res = await recallMod.TOOL.handler(recallArgs());
    assert.equal(res.ok, true, "mismatch degrades the brief, not the call");
    assert.equal(inProcessLoads, 0, "herd ban holds on the mismatch path");
    assert.equal(res.data.index_source, "queryd", "still stamped queryd-served");
    assert.equal(
      res.data.degraded_reason,
      "queryd_model_missing",
      `mismatch must be LOUD on the response (got ${JSON.stringify({
        degraded_reason: res.data.degraded_reason,
        degraded_recall: res.data.degraded_recall,
        memories: Array.isArray(res.data.memories) ? res.data.memories.length : null,
      })})`,
    );
    assert.equal(res.data.degraded_recall, true, "response marked degraded");
    assert.equal(
      res.data.memories.length,
      0,
      "the daemon cannot serve this model version — empty, but LOUDLY so",
    );

    // -----------------------------------------------------------------------
    // r3-degraded-recall-blindspot — F72 ON THIS PATH: the sizes were NOT
    // MEASURED. queryd's status carries no entry for this model version, so
    // recall's size view has nothing to read and its `0`s are a naming miss,
    // not an observation of an empty tree. The marker must therefore WITHHOLD
    // the emptiness booleans (omitted, never nulled, never defaulted to true)
    // and say so with sizes_measured:false. `index_unservable` itself still
    // fires: the CLASS is measured — a daemon that does not carry the version
    // provably cannot serve it (every search bad_requests).
    //
    // RED (pre-change, recorded verbatim in the node report): today the
    // marker reports hnsw_empty:true + bm25_empty:true from those unmeasured
    // zeros and reason "active_tree_unservable"; there is no sizes_measured
    // key at all.
    // -----------------------------------------------------------------------
    const marker = res.data.index_unservable;
    assert.ok(
      marker != null && typeof marker === "object",
      "the unservable-index marker fires on the model-absent path",
    );
    assert.equal(marker.code, "index_unservable", "machine-readable failure class");
    assert.equal(
      marker.sizes_measured,
      false,
      "F72: the daemon carries no entry for this version, so no size was observed",
    );
    assert.equal(
      "hnsw_empty" in marker,
      false,
      "F72: an unmeasured size is WITHHELD, never promoted into a factual claim",
    );
    assert.equal(
      "bm25_empty" in marker,
      false,
      "F72: an unmeasured size is WITHHELD, never promoted into a factual claim",
    );
    assert.equal(
      marker.reason,
      "queryd_model_missing",
      "the marker reuses the existing reason vocabulary for this exact shape",
    );
    assert.equal(marker.index_source, "queryd", "marker names the backend");
    assert.equal(
      marker.model_version,
      ACTIVE_VERSION,
      "marker names the version the daemon does not carry",
    );

    // The RECALL EVENT has no queryd/REG spread, so pre-change it disagreed
    // with the response here: the event said "active_tree_unservable" while
    // the response said "queryd_model_missing". Same call, two stories. This
    // is the second discriminating red.
    const events = readRecallEvents();
    assert.ok(events.length > 0, "a recall event was appended for this call");
    const ev = events[events.length - 1];
    assert.equal(ev.kind, "recall", "last ledger row is this recall");
    assert.equal(ev.degraded_recall, true, "event boolean agrees with the response");
    assert.equal(
      ev.degraded_reason,
      "queryd_model_missing",
      "response and event must tell the SAME story about why this call degraded",
    );
    assert.equal(ev.index_unservable.sizes_measured, false, "event marker: unmeasured");
    assert.equal("hnsw_empty" in ev.index_unservable, false, "event marker withholds too");
    assert.equal("bm25_empty" in ev.index_unservable, false, "event marker withholds too");
  } finally {
    if (handle.child.exitCode == null) {
      await stopDaemon(handle).catch(() => handle.child.kill("SIGKILL"));
    }
    delete process.env.MEMORY_QUERYD;
    qc._resetQuerydForTest();
  }
});

// ---------------------------------------------------------------------------
// (e) LOADING: exactly one 250ms retry, then loud degrade; READY recovers.
// (f) vector_fetch chunking above VECTOR_FETCH_MAX_IDS.
// ---------------------------------------------------------------------------
test("(e)+(f) loading gets one 250ms retry then degrade; ready recovers; vector_fetch chunks >256 ids", async () => {
  const daemon = new Queryd({ modelVersions: [ACTIVE_VERSION], watchIntervalMs: 60000 });
  const gate = deferred();
  daemon._setSlowLoadHook(() => gate.promise);
  await daemon.start();
  const client = new qc.QuerydClient();
  try {
    // (e) request during the (stalled) initial load: one 250ms retry, then
    // the structured degrade — never a hang, never an in-process fallback.
    const t0 = Date.now();
    await assert.rejects(
      () =>
        client.request({
          type: "bm25_search",
          model_version: ACTIVE_VERSION,
          query_text: "quokka rottnest",
          k: 5,
        }),
      (e) => {
        assert.ok(e instanceof qc.QuerydUnavailableError, `got: ${e && e.stack}`);
        assert.equal(e.code, "queryd_unavailable");
        assert.equal(e.retryable, true);
        assert.equal(e.reason, "loading");
        assert.equal(e.attempts, 2, "exactly one retry after the first loading response");
        return true;
      },
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 250, `loading retry must wait 250ms (waited ${elapsed}ms)`);

    gate.resolve();
    await daemon.ready;
    assert.equal(daemon.state, "ready");

    // Same client recovers once the daemon is ready.
    const resp = await client.request({
      type: "bm25_search",
      model_version: ACTIVE_VERSION,
      query_text: "quokka rottnest marsupial",
      k: 5,
    });
    assert.equal(resp.ok, true);
    assert.ok(resp.results.length > 0);

    // (f) vector_fetch with 300 ids (> VECTOR_FETCH_MAX_IDS=256) must be
    // chunked client-side — an over-cap single frame would come back as a
    // daemon bad_request. Known ids resolve to the index-resident vectors;
    // unknown ids resolve to structured nulls.
    const ids = [
      ROW_B_ID,
      ROW_C_ID,
      ...Array.from({ length: 298 }, (_, i) => `q2-missing-${i}`),
    ];
    const fetched = await client.vectorFetch(ACTIVE_VERSION, ids);
    assert.equal(fetched.byId.size, 300);
    assert.equal(fetched.generation, 0);
    assert.deepEqual(fetched.byId.get(ROW_B_ID), DIRECT_VEC_B);
    assert.equal(fetched.byId.get("q2-missing-0"), null);
  } finally {
    client.close();
    await daemon.stop();
    _resetCaches();
    _setFetchForTests(null);
  }
});

// ---------------------------------------------------------------------------
// (i) FU3 — Q2 IN-FLIGHT DAEMON DEATH at the client protocol level. Test (c)
// covers death BETWEEN calls (the socket file goes dead); this covers death
// MID-REQUEST: the daemon accepts, completes a valid hello handshake, then
// dies while the request is in flight. The client's contract: exactly ONE
// reconnect (the second connection dies the same way), then the loud
// structured failure — attempts===2, the server observed EXACTLY 2
// connections (no reconnect herd), bounded wall time.
// ---------------------------------------------------------------------------
test("(i) in-flight daemon death: hello-then-destroy server -> QuerydUnavailableError, attempts===2, exactly 2 connections, bounded", async () => {
  // Distinct short socket (never the daemon SOCKET_PATH — nothing real
  // listens here) under the temp root; AF_UNIX cap ~104 bytes on macOS.
  const MOCK_SOCKET = join(TMP_ROOT, "hd.sock");
  assert.ok(
    Buffer.byteLength(MOCK_SOCKET) < 100,
    `mock socket path too long for AF_UNIX: ${MOCK_SOCKET}`,
  );
  let connectionCount = 0;
  const server = createServer((sock) => {
    connectionCount += 1;
    sock.on("error", () => {
      // ECONNRESET after our own destroy — never an unhandled 'error'.
    });
    // Valid hello immediately (the real handshake: helloFrame stamps
    // PROTOCOL_VERSION; outbound-cap encode, exactly like queryd._send).
    const hello = helloFrame("ready");
    assert.equal(hello.protocol_version, PROTOCOL_VERSION);
    sock.write(encodeFrame(hello, { maxBytes: MAX_OUTBOUND_FRAME_BYTES }));
    // Inbound side rides the real FrameDecoder at the daemon's inbound cap;
    // the FIRST complete request frame kills the connection mid-request.
    const decoder = new FrameDecoder({ maxFrameBytes: MAX_INBOUND_FRAME_BYTES });
    sock.on("data", (chunk) => {
      const { frames } = decoder.push(chunk);
      if (frames.length > 0) sock.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(MOCK_SOCKET, resolve);
  });

  const client = new qc.QuerydClient({ socketPath: MOCK_SOCKET });
  // Mirrors CONNECT_TIMEOUT_MS in queryd-client.js (unexported by design):
  // the failure must land well under the wedged-case budget of
  // CONNECT_TIMEOUT_MS per attempt — connect+hello succeed here, so the
  // death is detected event-driven (ms), never by timer.
  const CONNECT_TIMEOUT_MS = 1000;
  try {
    const t0 = Date.now();
    await assert.rejects(
      () =>
        client.request({
          type: "bm25_search",
          model_version: ACTIVE_VERSION,
          query_text: "quokka rottnest",
          k: 5,
        }),
      (e) => {
        assert.ok(e instanceof qc.QuerydUnavailableError, `got: ${e && e.stack}`);
        assert.equal(e.code, "queryd_unavailable");
        assert.equal(e.retryable, true);
        assert.equal(
          e.attempts,
          2,
          "exactly one reconnect after the in-flight death, then loud failure",
        );
        return true;
      },
    );
    const elapsed = Date.now() - t0;
    assert.ok(
      elapsed < CONNECT_TIMEOUT_MS * 2 + 500,
      `in-flight death must fail fast (event-driven), took ${elapsed}ms`,
    );
    assert.equal(
      connectionCount,
      2,
      "the server must observe EXACTLY the reconnect budget: 2 connections",
    );
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// (j) FU3 — CLIENT-SIDE DEADLINE. The daemon enforces deadline_ms on its own
// queue, but a WEDGED daemon (stalled handler, never answering) must not hang
// recall past the mirrored client-side deadline. _setStallHook (the queryd
// test hook, cf. (e)'s _setSlowLoadHook) wedges the handler; a short
// deadlineMs must reject via the mirrored queryd_client_deadline path
// (reason "timeout") in bounded time, and the SAME client must serve the
// next request once the stall clears — a deadline never poisons the
// connection.
// ---------------------------------------------------------------------------
test("(j) client-side deadline: stalled daemon + deadlineMs=50 -> timeout-reason QuerydUnavailableError; same client recovers", async () => {
  const daemon = new Queryd({ modelVersions: [ACTIVE_VERSION], watchIntervalMs: 60000 });
  await daemon.start();
  await daemon.ready;
  assert.equal(daemon.state, "ready");
  const client = new qc.QuerydClient();
  const stall = deferred();
  try {
    daemon._setStallHook(() => stall.promise);
    const t0 = Date.now();
    await assert.rejects(
      () =>
        client.request(
          {
            type: "bm25_search",
            model_version: ACTIVE_VERSION,
            query_text: "quokka rottnest",
            k: 5,
          },
          { deadlineMs: 50 },
        ),
      (e) => {
        assert.ok(e instanceof qc.QuerydUnavailableError, `got: ${e && e.stack}`);
        assert.equal(e.code, "queryd_unavailable");
        assert.equal(e.retryable, true);
        assert.equal(
          e.reason,
          "timeout",
          "the mirrored queryd_client_deadline path classifies as timeout",
        );
        assert.equal(
          e.attempts,
          1,
          "a deadline is not a connection-level failure — no reconnect burn",
        );
        return true;
      },
    );
    const elapsed = Date.now() - t0;
    assert.ok(
      elapsed >= 50,
      `client-side deadline must wait its 50ms budget (waited ${elapsed}ms)`,
    );
    assert.ok(
      elapsed < 1500,
      `deadline must fire at ~50ms, never hang on the wedged daemon (took ${elapsed}ms)`,
    );

    // Clear the stall, release the wedged handler, and prove the SAME client
    // (same connection — no close/reset in between) still serves.
    daemon._setStallHook(null);
    stall.resolve();
    const resp = await client.request({
      type: "bm25_search",
      model_version: ACTIVE_VERSION,
      query_text: "quokka rottnest marsupial",
      k: 5,
    });
    assert.equal(resp.ok, true, "connection usable after a client-side deadline");
    assert.ok(Array.isArray(resp.results) && resp.results.length > 0);
  } finally {
    daemon._setStallHook(null);
    stall.resolve();
    client.close();
    await daemon.stop();
  }
});

// ---------------------------------------------------------------------------
// (k) r3-degraded-recall-blindspot — POSITIVE CONTROL IN THE OTHER DIRECTION,
// SAME MODE. (h) above pins the model-ABSENT arm (sizes unmeasured, emptiness
// withheld). Without this arm the discrimination is unproven: an
// implementation that stamped sizes_measured:false unconditionally in daemon
// mode would satisfy (h) vacuously.
//
// Here the daemon carries the ACTIVE model version over a genuinely EMPTY
// published tree. The status entry EXISTS and reports bm25_size:0 /
// hnsw_size:0 — those zeros are MEASURED — so the marker must report
// sizes_measured:true with hnsw_empty:true + bm25_empty:true and the
// pre-existing reason "active_tree_unservable". Machine-readable fields alone
// separate this from (h)'s absent arm.
//
// LAST IN FILE ORDER on purpose: it republishes indices/<ACTIVE_VERSION>/ over
// the suite's populated fixture. The `finally` restores the fixture via
// publishFixtureIndices() (the same builder the module-level publish uses) so
// nothing downstream is contaminated even if the ordering ever changes.
// ---------------------------------------------------------------------------
test("(k) daemon WITH the active model over an EMPTY tree: sizes MEASURED, both legs empty, active_tree_unservable", async () => {
  // Publish an empty generation for the ACTIVE version, then start a daemon on
  // it: the entry is present, its sizes are real zeros.
  saveIndices(ACTIVE_VERSION, {
    bm25: new Bm25Index(),
    hnsw: new HnswIndex({ dims: DIM, embedding_model_version: ACTIVE_VERSION }),
  });
  _resetCaches();
  _resetTransitiveOrphanCaches();

  const handle = spawnDaemon(ACTIVE_VERSION);
  try {
    const status = await waitReady(handle.stderrText);
    const entry = (status.models || []).find(
      (e) => e != null && e.model_version === ACTIVE_VERSION,
    );
    assert.ok(entry != null, "fixture sanity: the daemon DOES carry the active version");
    assert.equal(entry.bm25_size, 0, "fixture sanity: measured zero, not a naming miss");
    assert.equal(entry.hnsw_size, 0, "fixture sanity: measured zero, not a naming miss");

    process.env.MEMORY_QUERYD = "required";
    qc._resetQuerydForTest();
    inProcessLoads = 0;
    const res = await recallMod.TOOL.handler(recallArgs());
    assert.equal(res.ok, true, "an unservable tree degrades the brief, not the call");
    assert.equal(inProcessLoads, 0, "herd ban holds on the empty-tree path");
    assert.equal(res.data.index_source, "queryd", "queryd-served");

    const marker = res.data.index_unservable;
    assert.ok(marker != null && typeof marker === "object", "marker present");
    assert.equal(
      marker.sizes_measured,
      true,
      "the entry exists, so its zeros were OBSERVED — this is the present-and-zero arm",
    );
    assert.equal(marker.hnsw_empty, true, "measured: active HNSW empty");
    assert.equal(marker.bm25_empty, true, "measured: active BM25 empty");
    assert.equal(
      marker.reason,
      "active_tree_unservable",
      "the pre-existing reason for a wholly unservable tree is unchanged",
    );
    assert.equal(marker.index_source, "queryd", "same mode as (h) — the arms differ by FIELDS");
    assert.equal(marker.model_version, ACTIVE_VERSION);
    assert.equal(res.data.degraded_recall, true, "still degraded");
    assert.equal(
      res.data.degraded_reason,
      "active_tree_unservable",
      "no queryd_model_missing here: the version IS carried",
    );
  } finally {
    if (handle.child.exitCode == null) {
      await stopDaemon(handle).catch(() => handle.child.kill("SIGKILL"));
    }
    delete process.env.MEMORY_QUERYD;
    qc._resetQuerydForTest();
    // Restore the populated fixture generation for any later reader.
    publishFixtureIndices();
  }
});
