// local-reranker.test.mjs — N3-local-reranker regression gate.
//
// HERMETIC + OFFLINE: no rerank_server.py, no model, no network. globalThis.fetch
// is stubbed per-test so every code path (client shape, sort, typed-error
// degrade, rerank.js reorder-only, CAPS/env gate) is validated WITHOUT the
// Qwen3-Reranker weights — which the offline environment cannot download. The
// live model only affects the *scores*; the safety-critical PLUMBING under test
// (reorder-only, degrade-to-final_score, gate) is fully exercised here.
//
// Run: node --test test/recall/local-reranker.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateRanking as localGenerateRanking,
  LocalRerankUnavailableError,
} from "../../lib/recall/local-reranker-client.js";

const realFetch = globalThis.fetch;
function stubFetch(fn) { globalThis.fetch = fn; }
function restoreFetch() { globalThis.fetch = realFetch; }
function okResponse(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

const CANDS = [
  { id: "mem_a", content: "id=mem_a: alpha" },
  { id: "mem_b", content: "id=mem_b: bravo" },
  { id: "mem_c", content: "id=mem_c: charlie" },
];

// ===========================================================================
// A. local-reranker-client.generateRanking — shape, sort, contract.
// ===========================================================================

test("A1: returns a BARE ARRAY sorted highest-first, one entry per candidate (gemini parity)", async () => {
  // server returns scores in INPUT order; mem_b highest, mem_a lowest.
  stubFetch(async () => okResponse({ scores: [0.1, 0.9, 0.5] }));
  try {
    const out = await localGenerateRanking({ instruction: "find the best", candidates: CANDS });
    assert.ok(Array.isArray(out), "returns a BARE array (not {ranking})");
    assert.equal(out.length, 3, "one entry per candidate");
    assert.deepEqual(out.map((r) => r.id), ["mem_b", "mem_c", "mem_a"], "sorted by score desc");
    assert.equal(out[0].rank_score, 0.9, "rank_score carries the score");
    const ids = new Set(out.map((r) => r.id));
    assert.equal(ids.size, 3, "no duplicate ids");
    for (const r of out) assert.ok(CANDS.some((c) => c.id === r.id), "no foreign ids");
  } finally { restoreFetch(); }
});

test("A2: request carries query=instruction and documents in input order", async () => {
  let seen = null;
  stubFetch(async (url, init) => {
    seen = { url, body: JSON.parse(init.body) };
    return okResponse({ scores: [0.3, 0.2, 0.1] });
  });
  try {
    await localGenerateRanking({ instruction: "the brief", candidates: CANDS });
    assert.match(seen.url, /\/rerank$/, "POSTs to /rerank");
    assert.equal(seen.body.query, "the brief", "instruction becomes the query");
    assert.deepEqual(seen.body.documents, CANDS.map((c) => c.content), "documents in input order");
  } finally { restoreFetch(); }
});

test("A3: stable id tie-break for equal scores (deterministic output)", async () => {
  stubFetch(async () => okResponse({ scores: [0.5, 0.5, 0.5] }));
  try {
    const out = await localGenerateRanking({ instruction: "q", candidates: CANDS });
    assert.deepEqual(out.map((r) => r.id), ["mem_a", "mem_b", "mem_c"], "ties break by id asc");
  } finally { restoreFetch(); }
});

// ===========================================================================
// B. typed-error degrade triggers — every transport/shape failure throws
//    LocalRerankUnavailableError ("network failure" => rerank.js degrades).
// ===========================================================================

test("B1: server down (fetch throws) -> LocalRerankUnavailableError w/ 'network failure'", async () => {
  stubFetch(async () => { throw new Error("ECONNREFUSED 127.0.0.1:8360"); });
  try {
    await assert.rejects(
      () => localGenerateRanking({ instruction: "q", candidates: CANDS }),
      (e) => e instanceof LocalRerankUnavailableError && /network failure/.test(e.message),
    );
  } finally { restoreFetch(); }
});

test("B2: non-OK HTTP status -> typed error", async () => {
  stubFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  try {
    await assert.rejects(
      () => localGenerateRanking({ instruction: "q", candidates: CANDS }),
      (e) => e instanceof LocalRerankUnavailableError && /500/.test(e.message),
    );
  } finally { restoreFetch(); }
});

test("B3: malformed scores (wrong length) -> typed error (never a partial ranking)", async () => {
  stubFetch(async () => okResponse({ scores: [0.5] })); // 1 != 3 candidates
  try {
    await assert.rejects(
      () => localGenerateRanking({ instruction: "q", candidates: CANDS }),
      (e) => e instanceof LocalRerankUnavailableError && /malformed scores/.test(e.message),
    );
  } finally { restoreFetch(); }
});

test("B4: non-finite score -> typed error (no NaN leaks into the ranking)", async () => {
  stubFetch(async () => okResponse({ scores: [0.5, Number.NaN, 0.2] }));
  try {
    await assert.rejects(
      () => localGenerateRanking({ instruction: "q", candidates: CANDS }),
      (e) => e instanceof LocalRerankUnavailableError,
    );
  } finally { restoreFetch(); }
});

test("B5: input validation rejects empty/bad args before any fetch", async () => {
  let called = false;
  stubFetch(async () => { called = true; return okResponse({ scores: [] }); });
  try {
    await assert.rejects(() => localGenerateRanking({ instruction: "", candidates: CANDS }));
    await assert.rejects(() => localGenerateRanking({ instruction: "q", candidates: [] }));
    await assert.rejects(() => localGenerateRanking({ instruction: "q", candidates: [{ id: "x" }] }));
    assert.equal(called, false, "validation throws before issuing a request");
  } finally { restoreFetch(); }
});

// ===========================================================================
// C. rerank.js integration — reorder-only + degrade + gate, via the real
//    rerankCandidates with an injected generateRanking (the existing override
//    seam). Proves the local backend, when it returns a ranking, REORDERS; and
//    when it throws, recall degrades to the final_score sort (no drops).
// ===========================================================================

const SURROUNDING = {
  current_query: "what is the status of the project?",
  recent_turns: [{ role: "user", content: "status?" }],
  agent_role: "primary_assistant",
  entities: ["project"],
};
function pool() {
  // 3 candidates_with_scores; final_score order c > b > a (already desc-ish).
  const mk = (id, fs) => ({
    candidate: { memory_id: id, content: `body of ${id}`, kind: "fact" },
    score_components: { final_score: fs },
  });
  return [mk("mem_a", 0.10), mk("mem_b", 0.50), mk("mem_c", 0.90)];
}
function idsOf(res) {
  return res.reranked.map((r) => r.memory_id ?? r.candidate?.memory_id ?? r.id);
}

// An injected _generateRanking stands in for the gemini backend, so the
// gemini-key gate still applies — set a fake key (mirrors the existing
// rerank.test.mjs T3) so the short-circuit does not fire before the mock runs.
function withFakeKey() {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "AIzaFAKE_local_reranker_xxxxxxxxxxxxxxxxx";
  return () => { if (saved === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved; };
}

test("C1: rerankCandidates REORDERS when the backend returns a ranking (reorder-only)", async () => {
  const { rerankCandidates } = await import("../../lib/recall/rerank.js");
  const restoreKey = withFakeKey();
  // Bare-array mock flips final_score order: mem_a best, then b, then c.
  const mock = async () => [
    { id: "mem_a", rank_score: 0.99 },
    { id: "mem_b", rank_score: 0.50 },
    { id: "mem_c", rank_score: 0.01 },
  ];
  try {
    const res = await rerankCandidates({
      surrounding_context: SURROUNDING,
      candidates_with_scores: pool(),
      opts: { _generateRanking: mock },
    });
    assert.equal(res.degraded, false, "not degraded when backend succeeds");
    const ids = idsOf(res);
    assert.equal(new Set(ids).size, ids.length, "no duplicate ids");
    assert.equal(ids.length, 3, "reorder-only: every candidate survives (no drops)");
    assert.equal(ids[0], "mem_a", "reranker's top choice leads (order changed vs final_score)");
  } finally { restoreKey(); }
});

test("C2: a backend that THROWS degrades to the final_score sort (degraded=true, no drops)", async () => {
  const { rerankCandidates } = await import("../../lib/recall/rerank.js");
  const restoreKey = withFakeKey();
  const throwing = async () => { throw new LocalRerankUnavailableError("server down"); };
  try {
    const res = await rerankCandidates({
      surrounding_context: SURROUNDING,
      candidates_with_scores: pool(),
      opts: { _generateRanking: throwing },
    });
    assert.equal(res.degraded, true, "degraded when the backend throws");
    const ids = idsOf(res);
    assert.equal(ids.length, 3, "degrade keeps all candidates (no drops)");
    assert.equal(ids[0], "mem_c", "degraded order is final_score desc (mem_c highest)");
  } finally { restoreKey(); }
});

test("C3: the env GATE routes the DEFAULT path to the LOCAL backend — no gemini key needed", async () => {
  // Flip LOCAL_RERANKER_ENABLED=1: the DEFAULT path (no _generateRanking
  // injection) must route to the local client and reorder via the stubbed local
  // server — WITHOUT a GEMINI_API_KEY, proving the gemini-key short-circuit no
  // longer blocks the local backend.
  const mod = await import("../../lib/recall/rerank.js");
  const { CAPS } = await import("../../lib/validation.js");
  // SHIP DECISION 2026-07-31: the eval-first precondition this assertion
  // guarded has been satisfied, so the CAP now ships ON. Evidence recorded at
  // the CAP (mcp/lib/validation.js LOCAL_RERANKER_ENABLED): the local
  // Qwen3-Reranker-0.6B server answers /health ok on mps and returned real
  // scores for a 15-candidate payload; and the gemini path could never fire on
  // an agent-hosted MCP server, which inherits the shell env rather than the
  // launchd plist carrying GEMINI_API_KEYS — so every recall was degrading to
  // the raw final_score sort. Flipped to `true` so a silent revert to OFF (or
  // an accidental default change) still fails this gate.
  assert.equal(CAPS.LOCAL_RERANKER_ENABLED, true, "ships default ON (eval-first satisfied 2026-07-31)");

  const savedKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY; // prove no gemini key is required
  process.env.LOCAL_RERANKER_ENABLED = "1";
  // Stub the local server: scores in pool order [a,b,c] = [0.99,0.5,0.01] => a best.
  stubFetch(async () => okResponse({ scores: [0.99, 0.5, 0.01] }));
  try {
    const res = await mod.rerankCandidates({
      surrounding_context: SURROUNDING,
      candidates_with_scores: pool(),
      opts: {},
    });
    assert.equal(res.degraded, false, "local backend ran (not degraded) with NO gemini key");
    const ids = idsOf(res);
    assert.equal(ids.length, 3, "reorder-only: all candidates kept");
    assert.equal(ids[0], "mem_a", "reordered by the local reranker's scores");
  } finally {
    restoreFetch();
    delete process.env.LOCAL_RERANKER_ENABLED;
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
  }
});

// ===========================================================================
// D. FAILURE TAXONOMY (e14) — the REAL default path, no _generateRanking
//    injection, so the real local client is in the loop. Each case asserts the
//    rerank_failed_reason the record ACTUALLY carries.
//
//    Before e14 every one of D1/D2/D3 reported "network": the client wrapped
//    EVERY failure — abort, non-OK status, mis-shaped body — in a message
//    stamped "local-reranker: network failure", and rerank.js's _classifyError
//    matched that substring. The record named a cause nobody observed.
//    D4 is the GREEN guard: a genuine transport throw must KEEP saying
//    "network", and must keep the literal message stamp that
//    mcp/scripts/rerank-hermeticity-probe.mjs's DIAL_MARKER keys on.
//
//    HERMETIC: globalThis.fetch is stubbed in every case; no socket is opened
//    to 8360 (or anywhere). The abort is reproduced with a fetch stub that
//    honours init.signal, mirroring gemini-flash-client.test.mjs T-A.
// ===========================================================================

// Run the REAL default path with the local backend selected. Saves/restores
// LOCAL_RERANKER_ENABLED (rather than deleting it) so a caller-supplied
// tri-state override — e.g. the hermeticity probe's OFF corroboration run —
// survives this test.
async function withLocalBackend(envPatch, after) {
  const mod = await import("../../lib/recall/rerank.js");
  const saved = {};
  for (const k of Object.keys(envPatch)) saved[k] = process.env[k];
  const savedEnabled = process.env.LOCAL_RERANKER_ENABLED;
  const savedKey = process.env.GEMINI_API_KEY;
  process.env.LOCAL_RERANKER_ENABLED = "1";
  delete process.env.GEMINI_API_KEY; // the local path needs no gemini key
  for (const [k, v] of Object.entries(envPatch)) process.env[k] = v;
  try {
    return await mod.rerankCandidates({
      surrounding_context: SURROUNDING,
      candidates_with_scores: pool(),
      opts: {}, // NO _generateRanking — the real client runs
    });
  } finally {
    for (const k of Object.keys(envPatch)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (savedEnabled === undefined) delete process.env.LOCAL_RERANKER_ENABLED;
    else process.env.LOCAL_RERANKER_ENABLED = savedEnabled;
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
    if (after) after();
  }
}

// Every degrade, whatever the reason, still owes the reorder-only contract.
function assertDegradeContract(res, expectedReason) {
  assert.equal(res.degraded, true, "backend failure degrades");
  assert.equal(res.rerank_failed_reason, expectedReason, "rerank_failed_reason");
  const ids = idsOf(res);
  assert.equal(ids.length, 3, "degrade keeps every candidate (no drops)");
  assert.equal(new Set(ids).size, 3, "no duplicates");
  assert.deepEqual(ids, ["mem_c", "mem_b", "mem_a"], "final_score desc order");
  assert.ok(
    typeof res.layer3_latency_ms === "number" && res.layer3_latency_ms >= 0,
    "degrade ships a latency-until-failure",
  );
}

test("D1: a client-side ABORT reports reason=timeout (not 'network')", async () => {
  // fetch honours init.signal and rejects with an AbortError, exactly as
  // gemini-flash-client.test.mjs T-A does. The client's own 25ms timer fires
  // long before rerank.js's outer RECALL_RERANK_TIMEOUT_MS.
  stubFetch((_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        },
        { once: true },
      );
    }),
  );
  const res = await withLocalBackend({ LOCAL_RERANKER_TIMEOUT_MS: "25" }, restoreFetch);
  assertDegradeContract(res, "timeout");
});

test("D2: a non-OK HTTP status reports reason=http_503 (not 'network')", async () => {
  stubFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  const res = await withLocalBackend({}, restoreFetch);
  assertDegradeContract(res, "http_503");
});

test("D3: a wrong-length scores array reports reason=malformed_response", async () => {
  stubFetch(async () => okResponse({ scores: [0.5] })); // 1 != 3 candidates
  const res = await withLocalBackend({}, restoreFetch);
  assertDegradeContract(res, "malformed_response");
});

test("D3b: a non-finite score reports reason=malformed_response", async () => {
  stubFetch(async () => okResponse({ scores: [0.5, Number.NaN, 0.2] }));
  const res = await withLocalBackend({}, restoreFetch);
  assertDegradeContract(res, "malformed_response");
});

test("D4 (GREEN guard): a genuine transport throw stays 'network' and keeps the DIAL_MARKER", async () => {
  const refused = () => {
    const e = new Error("connect ECONNREFUSED 127.0.0.1:8360");
    e.code = "ECONNREFUSED";
    throw e;
  };
  // (a) the classified reason through the real path.
  stubFetch(async () => refused());
  const res = await withLocalBackend({}, restoreFetch);
  assertDegradeContract(res, "network");

  // (b) the message stamp itself. mcp/scripts/rerank-hermeticity-probe.mjs:406
  // keys its dead-port census on this exact literal; it must stay byte-stable.
  stubFetch(async () => refused());
  try {
    await assert.rejects(
      () => localGenerateRanking({ instruction: "q", candidates: CANDS }),
      (e) =>
        e instanceof LocalRerankUnavailableError &&
        e.message.includes("local-reranker: network failure"),
    );
  } finally {
    restoreFetch();
  }
});

// ---------------------------------------------------------------------------
// D5 — the vocabulary is FINITE. recall-observables.js:333 ticks a histogram
// keyed on rerank_failed_reason and rerank.js's loud-degrade logger emits once
// per DISTINCT reason per process; both break on unbounded cardinality. An
// error carrying an unrecognised structured .reason must FALL THROUGH to the
// substring/internal_error path, never pass its string through.
// ---------------------------------------------------------------------------

const REASON_VOCAB = new Set([
  "api_key_missing",
  "timeout",
  "network",
  "malformed_response",
  "all_ids_unmatched",
  "internal_error",
]);
function inVocab(r) {
  return REASON_VOCAB.has(r) || /^http_\d{3}$/.test(r);
}

test("D5: rerank_failed_reason is always a member of the frozen vocabulary", async () => {
  const { rerankCandidates } = await import("../../lib/recall/rerank.js");
  const restoreKey = withFakeKey();
  const mk = (patch) => async () => {
    const e = new Error(patch.message || "boom");
    Object.assign(e, patch);
    throw e;
  };
  const cases = [
    ["abort", mk({ name: "AbortError", message: "aborted" }), "timeout"],
    ["http", mk({ statusCode: 429, message: "rate limited" }), "http_429"],
    ["network", mk({ message: "local-reranker: network failure: refused" }), "network"],
    [
      "malformed",
      mk({ reason: "malformed_response", message: "malformed scores" }),
      "malformed_response",
    ],
    ["unknown", mk({ message: "something nobody classified" }), "internal_error"],
    // An UNRECOGNISED structured reason must not widen the vocabulary.
    ["bogus-reason", mk({ reason: "wormhole_collapse", message: "boom" }), "internal_error"],
    // ...nor may a non-string, nor an http_ lookalike that isn't 3 digits.
    ["numeric-reason", mk({ reason: 12345, message: "boom" }), "internal_error"],
    ["fake-http", mk({ reason: "http_9", message: "boom" }), "internal_error"],
  ];
  try {
    for (const [label, thrower, expected] of cases) {
      const res = await rerankCandidates({
        surrounding_context: SURROUNDING,
        candidates_with_scores: pool(),
        opts: { _generateRanking: thrower },
      });
      assert.equal(res.rerank_failed_reason, expected, `${label} -> ${expected}`);
      assert.ok(inVocab(res.rerank_failed_reason), `${label}: reason is in the frozen vocabulary`);
      assert.equal(idsOf(res).length, 3, `${label}: reorder-only survives the degrade`);
    }
  } finally {
    restoreKey();
  }
});
