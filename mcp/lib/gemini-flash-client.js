// gemini-flash-client.js — REST-based Gemini Flash listwise reranker client.
//
// Phase 3 v1 Layer-3 listwise reranker. See:
//   kb/phase3-v1-reranker-model.md           (model choice + API body shape)
//   kb/research-retrieval-frontiers.md       (§ "Phase 3 v1 — Instruction-following reranker")
//   mcp/lib/validation.js                    (CAPS.GEMINI_FLASH_MODEL_DEFAULT et al.)
//
// SCOPE: this module stands up the client + a smoke entry point ONLY. Wiring
// into the recall pipeline (Layer-3 over the Layer-2 candidate set) is the
// follow-up implement-phase3-v1 workflow. This file is the "model-tag config
// + smoke" surface that the spec calls out as the v1 prerequisite.
//
// Load-bearing decisions (do not deviate without re-reading the spec):
//
//   1. Model is gemini-2.5-flash (the stable alias). Phase A audit verified
//      against the live v1beta /models endpoint on 2026-06-02; no dated
//      snapshot tag exists today (probes of -09-2025, -preview-09-2025,
//      -001 all returned HTTP 404). CAPS.GEMINI_FLASH_PINNED_SNAPSHOT mirrors
//      the stable alias as the forward seam for when Google publishes one.
//      Do NOT swap to gemini-flash-latest (2-week rolling deprecation — silent
//      break of the JSON-ranking contract is the failure mode pinning prevents).
//
//   2. responseSchema is REQUIRED. The reranker output shape is strict per
//      kb/phase3-v0-contracts.md ("parser fallback is drift"). We request
//      `{ranking: [{id, rank_score}]}` with mime "application/json" and the
//      model returns exact-shape JSON.
//
//   3. thinkingConfig.thinkingBudget MUST be 0. Without it, 2.5-flash spends
//      ~95 reasoning tokens and triples p50 latency on the smoke prompt with
//      no measured ranking-quality benefit (Phase A measurement: 1205ms vs
//      ~3100ms). temperature MUST be 0.0; listwise rerank is deterministic by
//      spec; Plackett-Luce propensity (Layer-2 v0) handles exploration.
//
//   4. Retry policy mirrors gemini-client.js: up to 3 attempts on retryable
//      statuses (429/5xx + network) with exponential backoff; 400/401/403
//      throw immediately. NO local fallback to a different model — fail
//      closed (the caller's caller decides whether to surface Layer-2 results
//      without the rerank, which is a recall-pipeline policy decision, not
//      a client-library decision).
//
//   5. Key resolution goes through gemini-client.js's shared key pool
//      (GEMINI_API_KEYS comma-separated, or legacy singular GEMINI_API_KEY)
//      at call time (NOT at module load), so test runners that scrub then
//      re-set env vars work cleanly (pair env mutations with
//      _resetKeyPoolForTests()). Production wiring lives in the MCP server
//      env (~/.claude.json mcpServers.memory) and the launchd plists.

import { CAPS } from "./validation.js";
import { acquireGeminiKey } from "./gemini-client.js";

// ----------------------------------------------------------------------------
// Constants (CAPS-sourced)
// ----------------------------------------------------------------------------

const GEMINI_FLASH_MODEL = CAPS.GEMINI_FLASH_MODEL_DEFAULT;
const GEMINI_FLASH_PINNED_SNAPSHOT = CAPS.GEMINI_FLASH_PINNED_SNAPSHOT;
const THINKING_BUDGET = CAPS.GEMINI_FLASH_RERANK_THINKING_BUDGET;
const TEMPERATURE = CAPS.GEMINI_FLASH_RERANK_TEMPERATURE;
const MAX_OUTPUT_TOKENS = CAPS.GEMINI_FLASH_RERANK_MAX_OUTPUT_TOKENS;

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GENERATE_CONTENT_PATH = `models/${GEMINI_FLASH_MODEL}:generateContent`;

// Retry policy — mirrors gemini-client.js exactly. 429/5xx + network are
// retryable; 400/401/403 are not.
const RETRY_BACKOFF_MS = [200, 600, 1800];
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

// Candidate-count caps. The recall candidate set tops out at
// CAPS.RECALL_CANDIDATE_SET_SIZE (50) post-RRF; we apply the same ceiling here.
const MAX_CANDIDATES = CAPS.RECALL_CANDIDATE_SET_SIZE;

// Per-candidate content cap. Matches CAPS.RECALL_BRIEF_MAX_CHARS_PER_ITEM (600),
// the same surface the rerank instruction frames around.
const MAX_CANDIDATE_CONTENT_CHARS = CAPS.RECALL_BRIEF_MAX_CHARS_PER_ITEM;

// Max instruction length. 4000 chars matches RECALL_BRIEF_MAX_CHARS_TOTAL and
// keeps the prompt envelope predictable.
const MAX_INSTRUCTION_CHARS = CAPS.RECALL_BRIEF_MAX_CHARS_TOTAL;

// ----------------------------------------------------------------------------
// Internal helpers (mirrored from gemini-client.js for identical retry behavior)
// ----------------------------------------------------------------------------

// F1 (memperf): repointed at the shared gemini-client.js key pool so the
// production pool-only env (GEMINI_API_KEYS, plural) works. acquireGeminiKey
// returns null when the pool is unconfigured OR every key is cooling down /
// RPM-parked; it may also propagate the pool's shape-validation throw.
// Because getApiKey() runs per attempt inside _flashRequest, retries rotate
// to the next pool key automatically (round-robin selectKey semantics).
// The error message MUST keep the exact substring "GEMINI_API_KEY is not set"
// — rerank.js _classifyError keys on it for reason=api_key_missing.
function getApiKey() {
  const key = acquireGeminiKey();
  if (key == null) {
    throw new Error(
      "GEMINI_API_KEYS / GEMINI_API_KEY is not set (or every pool key is " +
        "cooling down / RPM-parked). Set GEMINI_API_KEYS (comma-separated) " +
        "in the MCP server env and the launchd plist EnvironmentVariables " +
        "(~/Library/LaunchAgents/com.user.memory-system.*.plist), OR " +
        "export GEMINI_API_KEY=... for ad-hoc runs."
    );
  }
  return key;
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function _flashRequest(urlPath, body, signal) {
  const apiKey = getApiKey();
  const url = `${GEMINI_API_BASE}/${urlPath}?key=${encodeURIComponent(apiKey)}`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (netErr) {
    // F1 (memperf): an abort must surface AS-IS, never wrapped as a
    // retryable "network failure". An unwrapped AbortError carries no
    // .retryable flag, so the retry loop rethrows immediately and rerank.js
    // _classifyError maps name === "AbortError" -> "timeout".
    if ((netErr && netErr.name === "AbortError") || (signal && signal.aborted)) {
      throw netErr;
    }
    const wrapped = new Error(
      `gemini-flash-client: network failure calling ${urlPath}: ${netErr && netErr.message ? netErr.message : String(netErr)}`
    );
    wrapped.retryable = true;
    wrapped.cause = netErr;
    throw wrapped;
  }

  let parsedBody = null;
  let rawText = "";
  try {
    rawText = await response.text();
    parsedBody = rawText.length > 0 ? JSON.parse(rawText) : null;
  } catch (parseErr) {
    // F1 (memperf): an abort during body-read must not masquerade as a
    // malformed/empty response — rethrow it unwrapped.
    if (parseErr && parseErr.name === "AbortError") throw parseErr;
    parsedBody = null;
  }

  if (!response.ok) {
    const apiMsg =
      parsedBody && parsedBody.error && parsedBody.error.message
        ? parsedBody.error.message
        : rawText || "no response body";
    const retryable = RETRYABLE_STATUSES.has(response.status);
    const err = new Error(
      `gemini-flash-client: ${urlPath} returned ${response.status}: ${apiMsg}`
    );
    err.statusCode = response.status;
    err.retryable = retryable;
    err.body = parsedBody;
    throw err;
  }

  return parsedBody;
}

async function _flashRequestWithRetry(urlPath, body, signal) {
  let lastErr = null;
  const maxAttempts = RETRY_BACKOFF_MS.length + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await _flashRequest(urlPath, body, signal);
    } catch (err) {
      lastErr = err;
      if (!err.retryable || attempt === maxAttempts - 1) throw err;
      await _sleep(RETRY_BACKOFF_MS[attempt]);
      // F1 (memperf): never sleep-and-retry past an abort — if the caller
      // aborted during the backoff, rethrow the last error instead of
      // issuing another attempt.
      if (signal && signal.aborted) throw lastErr;
    }
  }
  throw lastErr;
}

// ----------------------------------------------------------------------------
// Prompt assembly + response schema
// ----------------------------------------------------------------------------

// JSON schema for the listwise-rerank output. The model returns
// {"ranking": [{"id":"<memory_id>","rank_score":<number>}]}. The reranker is
// listwise — the order of items in `ranking` IS the rank from highest to
// lowest relevance, and `rank_score` is a model-provided real-valued score
// for tie-breaking + recall-event logging (Layer-3 v3 OPE will use these to
// detect rank-mix when the model changes).
const RANKING_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    ranking: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          rank_score: { type: "number" },
        },
        required: ["id", "rank_score"],
      },
    },
  },
  required: ["ranking"],
};

// Build the prompt text. Matches kb/phase3-v1-reranker-model.md § "API URL
// + request body template" verbatim shape: instruction string, then a
// candidate list rendered as a JSON array of {id, content}. The model is
// instructed to return ranking + rank_scores; the responseSchema enforces
// the output shape.
function _buildPromptText(instruction, candidates) {
  const candidatesJson = JSON.stringify(
    candidates.map((c) => ({ id: c.id, content: c.content }))
  );
  return (
    instruction +
    "\n\n" +
    "Rank the CANDIDATES below from highest to lowest relevance to the " +
    "INSTRUCTION above. Return JSON of shape " +
    '{"ranking":[{"id":"<candidate_id>","rank_score":<number>}, ...]} ' +
    "containing exactly one entry per candidate id, no duplicates, no " +
    "ids not present in the input. rank_score is a real number; higher = " +
    "more relevant. The order of the ranking array IS the rank.\n\n" +
    "CANDIDATES:\n" +
    candidatesJson
  );
}

// Validate input shape. Throws a plain Error (not ToolError; this is a
// library-internal surface called from recall pipeline code, not directly
// from MCP dispatch).
function _validateRankingArgs({ instruction, candidates }) {
  if (typeof instruction !== "string" || instruction.length === 0) {
    throw new Error("generateRanking: instruction must be a non-empty string");
  }
  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    throw new Error(
      `generateRanking: instruction exceeds ${MAX_INSTRUCTION_CHARS} chars`
    );
  }
  if (!Array.isArray(candidates)) {
    throw new Error("generateRanking: candidates must be an array");
  }
  if (candidates.length === 0) {
    throw new Error("generateRanking: candidates must not be empty");
  }
  if (candidates.length > MAX_CANDIDATES) {
    throw new Error(
      `generateRanking: candidates length (${candidates.length}) exceeds cap ${MAX_CANDIDATES}`
    );
  }
  const ids = new Set();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      throw new Error(`generateRanking: candidates[${i}] must be an object`);
    }
    if (typeof c.id !== "string" || c.id.length === 0) {
      throw new Error(
        `generateRanking: candidates[${i}].id must be a non-empty string`
      );
    }
    if (ids.has(c.id)) {
      throw new Error(
        `generateRanking: duplicate candidate id "${c.id}" at index ${i}`
      );
    }
    ids.add(c.id);
    if (typeof c.content !== "string" || c.content.length === 0) {
      throw new Error(
        `generateRanking: candidates[${i}].content must be a non-empty string`
      );
    }
    if (c.content.length > MAX_CANDIDATE_CONTENT_CHARS) {
      throw new Error(
        `generateRanking: candidates[${i}].content exceeds ${MAX_CANDIDATE_CONTENT_CHARS} chars`
      );
    }
  }
}

// Parse the model response. The responseSchema GUARANTEES the shape on the
// happy path, but we still defensively validate: the architecture report
// treats parse-fallback as drift (kb/phase3-v0-contracts.md), and we want
// the failure to surface here, not as a confused-deputy bug downstream.
function _parseRankingResponse(parsed, inputCandidateIds) {
  // Surface shape: { candidates: [{ content: { parts: [{ text }] }, ... }] }
  if (
    !parsed ||
    !Array.isArray(parsed.candidates) ||
    parsed.candidates.length === 0
  ) {
    throw new Error(
      "gemini-flash-client: response missing candidates[]; unexpected Gemini schema"
    );
  }
  const cand = parsed.candidates[0];
  if (
    !cand ||
    !cand.content ||
    !Array.isArray(cand.content.parts) ||
    cand.content.parts.length === 0
  ) {
    throw new Error(
      "gemini-flash-client: response missing candidates[0].content.parts[]; unexpected Gemini schema"
    );
  }
  const textPart = cand.content.parts.find(
    (p) => typeof p.text === "string" && p.text.length > 0
  );
  if (!textPart) {
    throw new Error(
      "gemini-flash-client: response has no text part; unexpected Gemini schema"
    );
  }
  let payload;
  try {
    payload = JSON.parse(textPart.text);
  } catch (parseErr) {
    throw new Error(
      `gemini-flash-client: response text is not valid JSON despite responseSchema: ${parseErr.message}`
    );
  }
  if (!payload || !Array.isArray(payload.ranking)) {
    throw new Error(
      "gemini-flash-client: response JSON missing ranking[] array"
    );
  }
  const inputIdSet = new Set(inputCandidateIds);
  const seenIds = new Set();
  const out = new Array(payload.ranking.length);
  for (let i = 0; i < payload.ranking.length; i++) {
    const entry = payload.ranking[i];
    if (!entry || typeof entry !== "object") {
      throw new Error(`gemini-flash-client: ranking[${i}] must be an object`);
    }
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new Error(
        `gemini-flash-client: ranking[${i}].id must be a non-empty string`
      );
    }
    if (!inputIdSet.has(entry.id)) {
      throw new Error(
        `gemini-flash-client: ranking[${i}].id "${entry.id}" not in input candidate set`
      );
    }
    if (seenIds.has(entry.id)) {
      throw new Error(
        `gemini-flash-client: ranking[${i}].id "${entry.id}" appears more than once`
      );
    }
    seenIds.add(entry.id);
    if (typeof entry.rank_score !== "number" || !Number.isFinite(entry.rank_score)) {
      throw new Error(
        `gemini-flash-client: ranking[${i}].rank_score must be a finite number`
      );
    }
    out[i] = { id: entry.id, rank_score: entry.rank_score };
  }
  return out;
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

// generateRanking: send an instruction + a candidate set to gemini-2.5-flash
// and receive a listwise rank with per-item rank_scores. The instruction is
// the caller's "policy string" (agent_role, time anchor, prefer-entity-overlap,
// etc.); the recall pipeline composes it. This client is purely transport +
// shape enforcement.
//
// Returns: Array<{ id: string, rank_score: number }> in the model's ranking
// order, length equal to candidates.length, every id from the input set, no
// duplicates.
//
// Throws on:
//   - missing GEMINI_API_KEYS / GEMINI_API_KEY (actionable message)
//   - argument-shape violations (instruction empty, candidates malformed, ...)
//   - non-2xx HTTP after retry exhaustion
//   - abort via opts.signal (unwrapped AbortError — never re-wrapped as a
//     network failure)
//   - response shape that violates the schema invariants (extra ids, dup ids,
//     non-finite rank_score, missing ranking[])
//
// F1 (memperf): optional `signal` (AbortSignal) is threaded end-to-end into
// fetch so a caller-side timeout genuinely cancels the in-flight HTTP
// request instead of leaking it.
export async function generateRanking({ instruction, candidates, signal } = {}) {
  _validateRankingArgs({ instruction, candidates });
  if (signal != null && typeof signal.aborted !== "boolean") {
    throw new Error(
      "generateRanking: signal must be an AbortSignal (boolean .aborted)"
    );
  }

  const promptText = _buildPromptText(instruction, candidates);
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: promptText }],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RANKING_RESPONSE_SCHEMA,
      temperature: TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingBudget: THINKING_BUDGET },
    },
  };

  const parsed = await _flashRequestWithRetry(GENERATE_CONTENT_PATH, body, signal);
  const inputIds = candidates.map((c) => c.id);
  const ranking = _parseRankingResponse(parsed, inputIds);

  // Note: we do NOT require ranking.length === candidates.length here. The
  // architecture report says reranker output may legitimately be shorter than
  // input (e.g., the model decides only top-K are relevant and emits fewer
  // entries). Callers that require full-length must enforce it themselves.
  return ranking;
}

// Exported for tests that need to introspect the pinned tag + config knobs
// without re-importing CAPS.
export const GEMINI_FLASH_CLIENT_CONSTANTS = Object.freeze({
  GEMINI_FLASH_MODEL,
  GEMINI_FLASH_PINNED_SNAPSHOT,
  THINKING_BUDGET,
  TEMPERATURE,
  MAX_OUTPUT_TOKENS,
  MAX_CANDIDATES,
  MAX_CANDIDATE_CONTENT_CHARS,
  MAX_INSTRUCTION_CHARS,
});

