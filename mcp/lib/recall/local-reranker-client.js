// local-reranker-client.js — HTTP client for the local Qwen3-Reranker server.
//
// N3-local-reranker. recall Layer-3 (rerank.js) historically called
// gemini-flash-client.js generateRanking(); with no GEMINI_API_KEY every query
// degraded (degraded_recall_layer3=true) to a final_score sort. This client is
// the node-side counterpart to local-embedder/rerank_server.py (a small Python
// host wrapping Qwen/Qwen3-Reranker on the M-series MPS backend at
// http://127.0.0.1:8360), so reranking runs LOCAL, unmetered, and private.
//
// SHAPE MIRROR (load-bearing): this module MIRRORS gemini-flash-client.js's
// generateRanking surface EXACTLY so rerank.js can swap backends with a single
// resolver — both accept { instruction, candidates:[{id, content}] } and return
// a BARE ARRAY [ { id, rank_score:number }, ... ] (NOT wrapped in {ranking}),
// one entry per candidate, no dupes, no foreign ids; the array order IS the
// rank, highest first. rerankCandidates asserts Array.isArray(response).
//
// SERVER CONTRACT:
//   POST /rerank {query:string, documents:string[], instruction?:string}
//     -> { scores:number[], model_version, count, elapsed_ms }   (P(relevant)
//        per document, input order; higher = more relevant)
//   GET  /health -> { ok, model, device }
//
// DEFENSIVE: a server that is down / unreachable / slow / mis-shaped fails the
// call in a way rerank.js's existing catch degrades to the final_score sort
// (reorder-only contract preserved; a reranker outage can NEVER drop candidates
// or crash recall). e14 split that single outcome into HONEST causes, because
// until then every failure was wrapped in one "network failure" message and the
// record named a cause nobody observed:
//   - an ABORT (our own timeout) rethrows UNWRAPPED, mirroring
//     gemini-flash-client.js's _flashRequest, so _classifyError sees
//     name === "AbortError" and records "timeout";
//   - every other failure throws a typed LocalRerankUnavailableError carrying a
//     structured `.reason` ("http_<status>" / "malformed_response") that
//     _classifyError honours, and a message whose prefix matches that reason;
//   - only a GENUINE transport throw keeps the "network failure" prefix — the
//     literal mcp/scripts/rerank-hermeticity-probe.mjs's DIAL_MARKER keys on.

const DEFAULT_URL = "http://127.0.0.1:8360";

// DEFAULT_TIMEOUT_MS — the budget a Layer-3 rerank gets on the local path.
//
// MEASURED, not assumed. `node scripts/rerank-budget-probe.mjs --n 5` on
// 2026-08-19 (Qwen/Qwen3-Reranker-0.6B, mps), production-shaped payload built
// through buildRerankInstruction + serializeCandidateForRerank —
// 15 candidates x 600 chars, 3912-char instruction, 13029-byte request:
//
//   first-call (cold)                        2941.5 ms   [reported alone]
//   warm serial, production query   p50 1916.5  p95 2452.2 ms
//   warm serial, SHORT query ctrl   p50  285.4  p95 1086.4 ms
//   2-concurrent, production query  p50 1992.9  p95 4017.5 ms
//
//   worst observed 4017.5 ms -> 3982.5 ms headroom at 8000. UNCHANGED.
//
// What the numbers say, so the next reader does not re-derive it:
//   (a) the production query costs 6.7x the short-query control. The client
//       sends the FULL instruction as `query`, and rerank_server.py's _format
//       inlines it into EVERY one of the 15 prompts — query length is
//       MULTIPLIED by the candidate count, not added once. A short-query
//       benchmark is therefore not a measurement of this path.
//   (b) 2-concurrent p95 is 2.1x serial p50 — that is rerank_server.py's
//       process-global _LOCK serialising the forward pass, not noise. Two
//       simultaneous recalls each pay the other's latency.
//   (c) request BYTES are bounded by construction (15 x
//       RECALL_BRIEF_MAX_CHARS_PER_ITEM) and are kilobytes; transport size
//       explains nothing here.
//
// STRUCTURAL: 8000 < CAPS.RECALL_RERANK_TIMEOUT_MS (15000), so on the local
// path THIS timer always fires first and rerank.js's outer race never wins. A
// Layer-3 timeout observed near 8s is this budget expiring — not the CAP.
// Do not move this number without a fresh run of scripts/rerank-budget-probe.mjs
// recorded here.
export const DEFAULT_TIMEOUT_MS = 8000;

// LocalRerankUnavailableError(message, cause, meta)
//   meta.kind    — the human phrase after the "local-reranker: " prefix.
//                  DEFAULTS to "network failure", so a 2-arg construction is
//                  byte-identical to the pre-e14 message (the hermeticity
//                  probe's DIAL_MARKER and C2's `new
//                  LocalRerankUnavailableError('server down')` both depend on
//                  that default staying put).
//   meta.reason  — the rerank_failed_reason code this failure IS, read
//                  structurally by rerank.js _classifyError. Never invent a
//                  code here: the taxonomy is frozen and bounded there.
//   meta.statusCode — HTTP status, for the pre-existing statusCode branch.
export class LocalRerankUnavailableError extends Error {
  constructor(message, cause, meta = {}) {
    const kind = (meta && typeof meta.kind === "string" && meta.kind) || "network failure";
    super(`local-reranker: ${kind}: ${message}`);
    this.name = "LocalRerankUnavailableError";
    if (cause) this.cause = cause;
    if (meta && typeof meta.statusCode === "number") this.statusCode = meta.statusCode;
    if (meta && typeof meta.reason === "string") this.reason = meta.reason;
  }
}

function _baseUrl(opts) {
  const u =
    (opts && typeof opts.url === "string" && opts.url) ||
    process.env.LOCAL_RERANKER_URL ||
    DEFAULT_URL;
  return u.replace(/\/+$/, "");
}

// Extract the query text the reranker scores against. The rerank instruction is
// the full brief; the server formats <Instruct>/<Query>/<Document> itself, so we
// pass the instruction as the query and let the server's default instruction
// frame it. Truncation is the server's job (RERANK_MAX_TOKENS).
function _validate({ instruction, candidates }) {
  if (typeof instruction !== "string" || instruction.length === 0) {
    throw new Error("generateRanking: instruction must be a non-empty string");
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("generateRanking: candidates must be a non-empty array");
  }
  for (const c of candidates) {
    if (!c || typeof c.id !== "string" || c.id.length === 0) {
      throw new Error("generateRanking: every candidate needs a non-empty string id");
    }
    if (typeof c.content !== "string") {
      throw new Error("generateRanking: every candidate needs a string content");
    }
  }
}

// generateRanking — gemini-flash-client.js-compatible. Async; returns
// { ranking: [{id, rank_score}] } ordered highest-first. Throws
// LocalRerankUnavailableError on any transport/shape failure (-> degrade).
export async function generateRanking({ instruction, candidates } = {}, opts = {}) {
  _validate({ instruction, candidates });
  const url = `${_baseUrl(opts)}/rerank`;
  const timeoutMs =
    Number(opts.timeoutMs || process.env.LOCAL_RERANKER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let body;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: instruction,
        documents: candidates.map((c) => c.content),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new LocalRerankUnavailableError(`server returned ${res.status}`, null, {
        kind: `server error ${res.status}`,
        statusCode: res.status,
        reason: `http_${res.status}`,
      });
    }
    body = await res.json();
  } catch (err) {
    if (err instanceof LocalRerankUnavailableError) throw err;
    // An abort is OUR OWN timeout firing, not the network refusing us. Rethrow
    // it UNWRAPPED — exactly as gemini-flash-client.js:125-127 does — so
    // rerank.js _classifyError's name/code branch records "timeout". Wrapping
    // it (pre-e14) buried every client timeout under "network".
    if ((err && err.name === "AbortError") || (err && err.code === "ABORT_ERR") || controller.signal.aborted) {
      throw err;
    }
    // ECONNREFUSED, DNS, socket reset, malformed JSON body — genuine transport
    // failures, and the only ones that keep the "network failure" stamp.
    throw new LocalRerankUnavailableError(err && err.message ? err.message : String(err), err);
  } finally {
    clearTimeout(timer);
  }

  const scores = body && body.scores;
  if (!Array.isArray(scores) || scores.length !== candidates.length) {
    throw new LocalRerankUnavailableError(
      `malformed scores (got ${scores && scores.length}, want ${candidates.length})`,
      null,
      { kind: "malformed response", reason: "malformed_response" },
    );
  }
  // Pair each candidate id with its score, then sort highest-first. The array
  // order IS the rank (matches the gemini contract); rank_score carries the
  // calibrated P(relevant). Stable tie-break on id keeps output deterministic.
  const paired = candidates.map((c, i) => {
    const s = Number(scores[i]);
    if (!Number.isFinite(s)) {
      throw new LocalRerankUnavailableError(`non-finite score at ${i}`, null, {
        kind: "malformed response",
        reason: "malformed_response",
      });
    }
    return { id: c.id, rank_score: s };
  });
  paired.sort((a, b) =>
    b.rank_score !== a.rank_score ? b.rank_score - a.rank_score : a.id < b.id ? -1 : 1,
  );
  // BARE ARRAY (gemini-flash-client parity) — rerankCandidates does
  // Array.isArray(response); a {ranking:[...]} wrapper would be malformed_response.
  return paired;
}

// Lightweight health probe (used by the gate / ops to confirm the model is up).
export async function rerankerHealth(opts = {}) {
  try {
    const res = await fetch(`${_baseUrl(opts)}/health`, { method: "GET" });
    if (!res.ok) return { ok: false, status: res.status };
    return await res.json();
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}
