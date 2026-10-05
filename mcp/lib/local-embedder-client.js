// local-embedder-client.js — HTTP client for the local Qwen3 embedding server.
//
// WU1-local-embedder-client-and-dim4096.
//
// The operator runs a local embed server (a small Python/FastAPI host wrapping
// Qwen/Qwen3-Embedding-8B in fp16 on an Apple-silicon (MPS) backend) at
// http://127.0.0.1:8359. This client is the node-side counterpart that turns
// text into full 4096-dim L2-unit-normalized vectors WITHOUT any cloud
// round-trip, MRL truncation, or per-key quota dance.
//
// SHAPE MIRROR (load-bearing): this module MIRRORS gemini-client.js's
// embedSingle / embedBatch surface so callers can swap backends with minimal
// change:
//   - embedSingle({ text, isQuery }) -> { vector_4096, embedding_model_version }
//   - embedBatch({ items, isQuery })  -> [ { index, vector_4096,
//                                            embedding_model_version }, ... ]
// The Gemini analogue returns { vector_3072, vector_mrl_renormalized,
// embedding_model_version }; the local model returns FULL 4096 only (operator
// chose full fidelity — no MRL slice), so there is no vector_mrl_* field.
//
// ROW-SCOPED DEGENERATE VECTORS (E1 zero-norm-embedding-root-cause): the
// batched fp16 MPS forward pass sometimes returns ONE row of a multi-row
// batch as all-zero / non-finite while the same text embeds fine alone.
// embedBatch therefore treats a zero-norm / non-finite row as ROW-LOCAL: it
// re-POSTs that single text once, and if the retry is degenerate too the
// per-item record for THAT item only is
//   { index, vector_4096: null, embedding_model_version, degenerate: "zero_norm" }
// — the batch resolves, sibling items keep their vectors, and the caller
// (watermark prefetchEmbeddings) nulls one row instead of the whole tick.
// Shape faults (wrong dims, empty array, count mismatch, post-renorm
// violation) stay BATCH-FATAL and throw as before. embedSingle is unchanged:
// a degenerate single vector still throws LocalEmbedUnavailableError with
// the `has degenerate norm=0; cannot renormalize` text (recall + corroborate
// depend on it).
//
// SERVER CONTRACT (verified live 2026-06):
//   POST /embed {texts:string[], is_query:bool, dim:int}
//     -> { embeddings: number[][], model_version: string, dim: int,
//          count: int, elapsed_ms: number }
//   GET  /health -> { ok, model, model_version, device, native_dim }
//
//   `is_query` selects the asymmetric instruction prefix the Qwen3 embedding
//   model uses for retrieval queries vs. documents (the local analogue of
//   Gemini's RETRIEVAL_QUERY / RETRIEVAL_DOCUMENT task types). Documents pass
//   is_query:false; recall-time queries pass is_query:true.
//
// UNIT-NORM: the server returns vectors at ||v|| ~= 1.0, but fp16 quantization
// puts the realized norm a hair off 1.0 (observed ~1.0004). The pipeline-wide
// l2NormAssert epsilon is 1e-6, far tighter than fp16 noise. So this client
// DEFENSIVELY L2-renormalizes every returned vector before handing it back,
// then asserts the post-renorm invariant. That keeps every downstream layer
// (HNSW add, s_emb cosine-as-dot) sound without weakening the global epsilon.
//
// DEFENSIVE: a server that is down / unreachable / mis-shaped throws a typed
// LocalEmbedUnavailableError so callers (cascade promote, recall) can catch it
// and degrade exactly the way they catch gemini-client's
// KeyPoolExhaustedError today.
//
// TRANSPORT: node:http with agent:false + Connection: close — NOT global
// fetch. undici's keep-alive pool against this per-request-close python
// server threw an uncatchable setTypeOfService EINVAL from the socket write
// path and killed the watermark daemon twice on 2026-07-03. See the full
// rationale at _nodeHttpFetch below.

import http from "node:http";
import { Buffer } from "node:buffer";

import { CAPS } from "./validation.js";

// ---------------------------------------------------------------------------
// Constants + frozen capability descriptor.
// ---------------------------------------------------------------------------

// Module version string — bumped on any breaking change to the request /
// response contract this client speaks. Distinct from the MODEL version
// (which identifies the embedding geometry, not the client code).
export const VERSION = "1.0.0";

// Pinned model-version identifier. Sourced from CAPS so the index-dir name,
// the stamped features.embedding_model_version, and this client never drift.
const MODEL_VERSION = CAPS.ACTIVE_EMBED_MODEL_VERSION;

// Default server URL — operator-overridable via LOCAL_EMBED_URL. Resolved
// lazily at call time (not frozen into the caps) so a test / ad-hoc run can
// point at a different host by setting the env var before the request fires.
const DEFAULT_LOCAL_EMBED_URL = "http://127.0.0.1:8359";

// Default per-request wall-clock budget. The 8B fp16 model on MPS embeds short
// facts fast (a 32-batch of ~100-char facts in ~3s) but slows DRAMATICALLY on
// longer sequences: a batch of 2000-char texts blew the original 60s budget
// outright. The default stays 60s (the recall-time single-query path wants a
// tight budget so a slow server degrades fast), but the long-document re-embed
// path raises it via LOCAL_EMBED_TIMEOUT_MS so a slow long-text batch completes
// instead of aborting. Resolved per-call (not frozen) so env can override it
// without a process restart.
const DEFAULT_LOCAL_EMBED_TIMEOUT_MS = 60000;

// Frozen capability descriptor. URL is the DEFAULT (env override is resolved
// per-call by _resolveUrl); dim / batch cap are hard contract. TIMEOUT_MS is
// the DEFAULT (env override LOCAL_EMBED_TIMEOUT_MS is resolved per-call by
// _resolveTimeoutMs) — kept on the frozen descriptor for back-compat callers.
export const LOCAL_EMBED_CAPS = Object.freeze({
  URL: DEFAULT_LOCAL_EMBED_URL,
  DIM: CAPS.EMBEDDING_DIM_4096, // 4096 — full, no MRL truncation.
  BATCH_CAP: 256, // max items per /embed call; chunk larger inputs.
  TIMEOUT_MS: DEFAULT_LOCAL_EMBED_TIMEOUT_MS, // per-request wall-clock default.
  MODEL_VERSION,
  // E5: max single-row re-POSTs embedBatch issues per chunk for row-local
  // (zero / non-finite) rows. Mirrors embed_server.py
  // EMBED_DEGENERATE_RETRY_MAX default 8, one layer up. Hard contract like
  // DIM / BATCH_CAP — no env override. Rows past the cap, and every row of a
  // whole-degenerate chunk (len >= 2, matching the server's whole-batch
  // rule), become per-item null records without a request. Note on /health
  // `degenerate_*`: the server counts ENCODE-ATTEMPT row events (once per bad
  // row per request), not distinct rows — a client single-row retry of a
  // persistent row is a second request whose 1-row batch is bad again, so
  // such a row is counted twice; the client's null records are the
  // distinct-row count.
  DEGENERATE_RETRY_CAP: 8,
});

// Resolve the per-request timeout: LOCAL_EMBED_TIMEOUT_MS env override wins
// (must parse to a positive finite integer), else the frozen default. Resolved
// lazily at call time so a long-document re-embed run can bump the budget by
// exporting the env var before the request fires, without touching recall-time
// callers (which want the tight default so a slow server degrades fast).
function _resolveTimeoutMs() {
  const raw =
    typeof process !== "undefined" && process.env
      ? process.env.LOCAL_EMBED_TIMEOUT_MS
      : undefined;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = parseInt(raw.trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_LOCAL_EMBED_TIMEOUT_MS;
}

// L2-norm invariant tolerance (matches gemini-client + CAPS).
const L2_NORM_INVARIANT_EPSILON =
  typeof CAPS.L2_NORM_INVARIANT_EPSILON === "number"
    ? CAPS.L2_NORM_INVARIANT_EPSILON
    : 1e-6;

// ---------------------------------------------------------------------------
// Typed error: server unreachable / mis-shaped. Callers catch this to degrade.
// ---------------------------------------------------------------------------
export class LocalEmbedUnavailableError extends Error {
  constructor(message, opts) {
    super(message);
    this.name = "LocalEmbedUnavailableError";
    // `retryable` mirrors the gemini-client error convention: a transport /
    // availability failure is retryable once the server is back, but it is
    // NOT a hot-retry signal — callers degrade to promote-without-embed.
    this.retryable = false;
    if (opts && opts.cause !== undefined) this.cause = opts.cause;
    if (opts && typeof opts.url === "string") this.url = opts.url;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

// Resolve the embed-server URL: LOCAL_EMBED_URL env override wins, else the
// frozen default. Trailing slash trimmed so `${url}/embed` never doubles up.
function _resolveUrl() {
  const raw =
    typeof process !== "undefined" &&
    process.env &&
    typeof process.env.LOCAL_EMBED_URL === "string" &&
    process.env.LOCAL_EMBED_URL.trim() !== ""
      ? process.env.LOCAL_EMBED_URL.trim()
      : DEFAULT_LOCAL_EMBED_URL;
  return raw.replace(/\/+$/, "");
}

// TRANSPORT (load-bearing): node:http with agent:false — global fetch (undici)
// is BANNED in this client.
//
// WHY: on 2026-07-03 the watermark daemon (node v24.15.0) was killed TWICE by
// an uncatchable async error thrown from undici's socket write path during
// embed-heavy traffic against this server:
//
//   Error: setTypeOfService EINVAL
//       at Socket.setTypeOfService (node:net:683:13)
//       at writeH1 (node:internal/deps/undici/undici:7836:16)
//
// The local embed host is a single-threaded python http server that closes the
// connection after every request. undici's keep-alive pool reuses the socket it
// thinks is still open; when the reused socket is half-closed, the macOS
// setsockopt(IP_TOS) call on the write path fails EINVAL — and undici throws it
// OUTSIDE the fetch() promise chain, so no try/catch around `await _fetch(...)`
// can see it. The process dies, taking the in-flight cascade tick with it.
//
// FIX: a plain node:http request with `agent: false` (a fresh socket per
// request, no keep-alive pool, no undici) plus an explicit `Connection: close`
// header. Every failure mode surfaces as a rejection of THIS promise, which
// the callers below wrap into LocalEmbedUnavailableError. The server is
// 127.0.0.1-only, so there is no TLS / redirect / proxy handling to lose.
//
// The function is fetch-SHAPED (url, init) -> Response-like {ok, status,
// text(), json()} so the _setFetchForTests seam and every existing test stub
// keep working unchanged.
function _nodeHttpFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url); // throws synchronously -> rejects the promise
    if (target.protocol !== "http:") {
      reject(
        new Error(
          `local-embedder-client transport supports http: only (127.0.0.1 embed server); got ${target.protocol}`,
        ),
      );
      return;
    }
    const body = init.body != null ? init.body : null;
    // Connection: close is explicit and always wins — no keep-alive, ever.
    const headers = { ...(init.headers || {}), Connection: "close" };
    if (body != null) headers["Content-Length"] = Buffer.byteLength(body);
    const req = http.request(
      {
        host: target.hostname,
        port: target.port !== "" ? Number(target.port) : 80,
        path: `${target.pathname}${target.search}`,
        method: init.method || "GET",
        headers,
        agent: false, // fresh connection per request — no socket pool to go stale.
        signal: init.signal, // AbortController timeout destroys the request.
      },
      (res) => {
        // Buffer the WHOLE body before resolving, so the caller's timeout /
        // abort covers the full request+response and a mid-body failure
        // rejects here (one catch surface) instead of inside text().
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = typeof res.statusCode === "number" ? res.statusCode : 0;
          resolve({
            ok: status >= 200 && status <= 299,
            status,
            async text() {
              return text;
            },
            async json() {
              return JSON.parse(text);
            },
          });
        });
      },
    );
    req.on("error", reject); // ECONNREFUSED / ECONNRESET / AbortError -> reject.
    if (body != null) req.write(body);
    req.end();
  });
}

// Transport seam: tests inject a fetch-shaped stub via _setFetchForTests() so
// the request / response shape is exercised without a live server. Production
// uses _nodeHttpFetch above (NEVER global fetch — see the ban rationale there).
let _fetchImpl = null;
function _fetch(...args) {
  const fn = _fetchImpl != null ? _fetchImpl : _nodeHttpFetch;
  return fn(...args);
}

// Test-only seam. Pass a fetch-shaped function to intercept requests; pass
// null to restore the global fetch. Production code MUST NOT call this.
export function _setFetchForTests(fn) {
  if (fn === null || fn === undefined) {
    _fetchImpl = null;
    return;
  }
  if (typeof fn !== "function") {
    throw new Error("_setFetchForTests: argument must be a function or null");
  }
  _fetchImpl = fn;
}

function _l2Norm(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    const v = vector[i];
    sum += v * v;
  }
  return Math.sqrt(sum);
}

// Defensively L2-renormalize the server vector (fp16 noise puts the realized
// norm a hair off 1.0) and assert the tight invariant afterwards. Returns a
// NEW Array<number>. Throws LocalEmbedUnavailableError on a zero / non-finite
// vector (a structurally broken response — degrade, don't poison the index).
function _renormAndAssert(vector, label) {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new LocalEmbedUnavailableError(
      `local-embedder-client: ${label} is not a non-empty number[]`,
    );
  }
  if (vector.length !== LOCAL_EMBED_CAPS.DIM) {
    throw new LocalEmbedUnavailableError(
      `local-embedder-client: ${label} has ${vector.length} dims; expected ${LOCAL_EMBED_CAPS.DIM}`,
    );
  }
  const norm = _l2Norm(vector);
  if (norm === 0 || !Number.isFinite(norm)) {
    // E1: ROW-LOCAL fault (one row of a batched fp16 pass came back zero /
    // non-finite). embedBatch retries the item alone; embedSingle rethrows.
    const err = new LocalEmbedUnavailableError(
      `local-embedder-client: ${label} has degenerate norm=${norm}; cannot renormalize`,
    );
    err.rowLocal = true;
    throw err;
  }
  const out = new Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    const v = vector[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      // E1: ROW-LOCAL fault, same treatment as the degenerate-norm throw.
      const err = new LocalEmbedUnavailableError(
        `local-embedder-client: ${label}[${i}] is not a finite number`,
      );
      err.rowLocal = true;
      throw err;
    }
    out[i] = v / norm;
  }
  // Post-renorm invariant: this MUST hold now (we just divided by the norm).
  const postNorm = _l2Norm(out);
  if (Math.abs(postNorm - 1.0) > L2_NORM_INVARIANT_EPSILON) {
    throw new LocalEmbedUnavailableError(
      `local-embedder-client: ${label} unit-norm invariant violated post-renorm; ||v||=${postNorm}`,
    );
  }
  return out;
}

// POST a /embed request. Returns the parsed JSON body. Wraps every failure
// mode (network error, non-2xx, unparsable body, missing embeddings[]) into a
// LocalEmbedUnavailableError so callers have ONE catch surface.
async function _postEmbed(texts, isQuery) {
  const url = _resolveUrl();
  const endpoint = `${url}/embed`;
  const body = {
    texts,
    is_query: isQuery === true,
    dim: LOCAL_EMBED_CAPS.DIM,
  };

  // AbortController bounds the wall-clock so a hung server can't wedge a
  // caller forever: on timeout the signal destroys the in-flight node:http
  // request, its promise rejects, and the catch below wraps that into
  // LocalEmbedUnavailableError with the abort as cause. Budget is resolved
  // per-call (LOCAL_EMBED_TIMEOUT_MS env override, else the frozen default).
  // The timer is always cleared in the finally.
  const controller =
    typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  if (controller != null) {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* abort is best-effort */
      }
    }, _resolveTimeoutMs());
  }

  let response;
  try {
    response = await _fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller != null ? controller.signal : undefined,
    });
  } catch (netErr) {
    throw new LocalEmbedUnavailableError(
      `local-embedder-client: cannot reach embed server at ${endpoint}: ${
        netErr && netErr.message ? netErr.message : String(netErr)
      }`,
      { cause: netErr, url: endpoint },
    );
  } finally {
    if (timer != null) clearTimeout(timer);
  }

  if (!response || typeof response.ok !== "boolean") {
    throw new LocalEmbedUnavailableError(
      `local-embedder-client: malformed fetch response from ${endpoint}`,
      { url: endpoint },
    );
  }

  let parsed = null;
  let rawText = "";
  try {
    rawText = await response.text();
    parsed = rawText.length > 0 ? JSON.parse(rawText) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const apiMsg =
      parsed && parsed.error
        ? typeof parsed.error === "string"
          ? parsed.error
          : JSON.stringify(parsed.error)
        : rawText || "no response body";
    throw new LocalEmbedUnavailableError(
      `local-embedder-client: ${endpoint} returned ${response.status}: ${apiMsg}`,
      { url: endpoint },
    );
  }

  if (!parsed || !Array.isArray(parsed.embeddings)) {
    throw new LocalEmbedUnavailableError(
      `local-embedder-client: ${endpoint} response missing embeddings[]`,
      { url: endpoint },
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

// Embed a single text. Documents -> isQuery:false; recall queries -> true.
// Returns { vector_4096, embedding_model_version }. Throws on empty input or
// LocalEmbedUnavailableError when the server is unreachable / mis-shaped.
export async function embedSingle({ text, isQuery } = {}) {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("embedSingle: text must be a non-empty string");
  }
  const parsed = await _postEmbed([text], isQuery);
  if (parsed.embeddings.length !== 1) {
    throw new LocalEmbedUnavailableError(
      `local-embedder-client: embedSingle expected 1 embedding, got ${parsed.embeddings.length}`,
    );
  }
  const vector_4096 = _renormAndAssert(
    parsed.embeddings[0],
    "embedSingle.vector_4096",
  );
  // Trust the server's model_version when present; else fall back to the
  // pinned MODEL_VERSION. A model_version that disagrees with the pinned
  // value is surfaced verbatim (so a mid-flight server swap is visible) but
  // not treated as a hard failure — the geometry-mismatch guard lives in the
  // recall scorer (same-model gate), not here.
  const embedding_model_version =
    typeof parsed.model_version === "string" && parsed.model_version.length > 0
      ? parsed.model_version
      : MODEL_VERSION;
  return { vector_4096, embedding_model_version };
}

// Embed a batch of texts with a single is_query flag for all items. Order is
// preserved; each record carries its `index`. Chunks internally at
// LOCAL_EMBED_CAPS.BATCH_CAP so an arbitrarily large `items` array is safe.
// Mirrors gemini-client.embedBatch's return shape (array of per-item records).
export async function embedBatch({ items, isQuery } = {}) {
  if (!Array.isArray(items)) {
    throw new Error("embedBatch: items must be an array");
  }
  if (items.length === 0) return [];
  for (let i = 0; i < items.length; i++) {
    if (typeof items[i] !== "string" || items[i].length === 0) {
      throw new Error(`embedBatch: items[${i}] must be a non-empty string`);
    }
  }

  const out = new Array(items.length);
  const cap = LOCAL_EMBED_CAPS.BATCH_CAP;
  for (let chunkStart = 0; chunkStart < items.length; chunkStart += cap) {
    const chunkEnd = Math.min(chunkStart + cap, items.length);
    const chunk = items.slice(chunkStart, chunkEnd);
    const parsed = await _postEmbed(chunk, isQuery);
    if (parsed.embeddings.length !== chunk.length) {
      throw new LocalEmbedUnavailableError(
        `local-embedder-client: embedBatch expected ${chunk.length} embeddings, got ${parsed.embeddings.length}`,
      );
    }
    const embedding_model_version =
      typeof parsed.model_version === "string" &&
      parsed.model_version.length > 0
        ? parsed.model_version
        : MODEL_VERSION;
    // Pass 1: assert every row of the batched pass. Row-local faults (zero /
    // non-finite rows, err.rowLocal === true) are collected; any other fault
    // (wrong dim, non-array, post-renorm invariant) stays batch-fatal.
    const degenerateIdx = [];
    for (let i = 0; i < chunk.length; i++) {
      const label = `embedBatch[${chunkStart + i}].vector_4096`;
      let vector_4096;
      try {
        vector_4096 = _renormAndAssert(parsed.embeddings[i], label);
      } catch (err) {
        if (!(err && err.rowLocal === true)) throw err; // shape faults stay batch-fatal
        degenerateIdx.push(i);
        continue;
      }
      out[chunkStart + i] = {
        index: chunkStart + i,
        vector_4096,
        embedding_model_version,
      };
    }
    // Pass 2 (E1 + E5): re-POST a degenerate row alone (the single-row path
    // has never produced one), bounded. A whole-degenerate chunk (len >= 2,
    // the server's own whole-batch rule — a wedged GPU, not the one-row
    // class) and any row past LOCAL_EMBED_CAPS.DEGENERATE_RETRY_CAP get the
    // per-item null record directly, with no request. A 1-row chunk is never
    // whole-chunk and still gets its one retry.
    const wholeChunk = chunk.length >= 2 && degenerateIdx.length === chunk.length;
    let retries = 0;
    for (const i of degenerateIdx) {
      if (wholeChunk || retries >= LOCAL_EMBED_CAPS.DEGENERATE_RETRY_CAP) {
        out[chunkStart + i] = {
          index: chunkStart + i,
          vector_4096: null,
          embedding_model_version,
          degenerate: "zero_norm",
        };
        continue;
      }
      retries += 1;
      const label = `embedBatch[${chunkStart + i}].vector_4096`;
      let vector_4096;
      const retry = await _postEmbed(chunk.slice(i, i + 1), isQuery);
      if (retry.embeddings.length !== 1) {
        throw new LocalEmbedUnavailableError(
          `local-embedder-client: embedBatch retry expected 1 embedding, got ${retry.embeddings.length}`,
        );
      }
      try {
        vector_4096 = _renormAndAssert(retry.embeddings[0], label);
      } catch (err2) {
        if (!(err2 && err2.rowLocal === true)) throw err2;
        out[chunkStart + i] = {
          index: chunkStart + i,
          vector_4096: null,
          embedding_model_version,
          degenerate: "zero_norm",
        };
        continue;
      }
      out[chunkStart + i] = {
        index: chunkStart + i,
        vector_4096,
        embedding_model_version,
      };
    }
  }
  return out;
}

// Lightweight liveness probe. Returns the parsed /health body on success;
// throws LocalEmbedUnavailableError when the server is down. Callers use this
// to decide whether to route embeds locally vs. degrade to promote-without-
// embed before issuing a batch.
export async function health() {
  const url = _resolveUrl();
  const endpoint = `${url}/health`;
  let response;
  try {
    response = await _fetch(endpoint, { method: "GET" });
  } catch (netErr) {
    throw new LocalEmbedUnavailableError(
      `local-embedder-client: health probe failed for ${endpoint}: ${
        netErr && netErr.message ? netErr.message : String(netErr)
      }`,
      { cause: netErr, url: endpoint },
    );
  }
  if (!response || response.ok !== true) {
    throw new LocalEmbedUnavailableError(
      `local-embedder-client: health probe non-ok from ${endpoint}`,
      { url: endpoint },
    );
  }
  try {
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) : { ok: true };
  } catch {
    return { ok: true };
  }
}
