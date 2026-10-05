// gemini-client.js — REST-based Gemini embedding client.
//
// Phase 3 v0 recall-layer foundation. See:
//   kb/research-retrieval-frontiers.md § "Gemini integration specifics"
//
// Load-bearing decisions (do not deviate without re-reading the spec):
//
//   1. Model is gemini-embedding-001 ONLY. Phase A verified gemini-embedding-2
//      silently ignores taskType (cosine 1.0 across all task types on identical
//      strings). The asymmetric task-type strategy IS the system's edge.
//
//   2. Call REST embedContent directly. SDKs (@google/generative-ai, LangChain
//      VectorStoreRetriever, Semantic Kernel, LiteLLM proxy) silently drop
//      task_type and eliminate the entire asymmetric advantage.
//
//   3. MRL + L2 RENORM INVARIANT: gemini-embedding-001 returns unit-norm
//      vectors ONLY at default 3072 dims. Sliced 768d vectors have norm
//      approx 0.59 and MUST be L2-renormalized before any dot-product-as-cosine.
//      ||v||=1.0 +/- 1e-6 is a pipeline-wide invariant; vector-math.js exports
//      l2NormAssert() for runtime enforcement at every layer, and the embed
//      paths in this module call it on every vector they return.
//
//   4. Always request outputDimensionality=3072 from the REST endpoint; slice
//      client-side for MRL. (Per Phase A: relying on the API to slice is the
//      same code path that triggers the unit-norm trap server-side.)
//
//   5. GEMINI_API_KEYS (or legacy GEMINI_API_KEY) is read from process.env.
//      In production the only caller is the MCP server's cloud reranker, so the
//      key belongs in the MCP server's environment (the MCP client config);
//      manual scripts take it from the shell. Never put it in a plist's
//      EnvironmentVariables, and never read a .env file from production code.
//
//      R29 + R30 key-pool discipline:
//        - GEMINI_API_KEYS (comma-separated) is the primary source; trimmed,
//          empties skipped, duplicates removed, capped at
//          CAPS.GEMINI_KEY_POOL_MAX_SIZE.
//        - GEMINI_API_KEY remains supported as a degenerate single-key pool.
//        - If BOTH are set, GEMINI_API_KEYS wins and a one-line stderr warning
//          is emitted at first call.
//        - R30: selectKey() is ROUND-ROBIN, not sticky. _lastUsedIndex
//          advances on every call so load spreads evenly across N keys.
//        - Per-key 429 timestamps are tracked in memory only. A key that
//          returns 429 is skipped while (now - last_429_ts) is within
//          CAPS.GEMINI_KEY_COOLDOWN_SECONDS (default 60s — Google's
//          per-minute rate-limit recovery window). Per-day quotas surface
//          as every-request-429: the daemon parks via the
//          ThrottledStructuralError throttle and self-recovers when the
//          next-eligible time rolls forward.
//        - CAPS.GEMINI_KEY_COOLDOWN_SECONDS = 0 disables the skip window
//          entirely (pure rotation; immediate re-try).
//        - All-keys-in-cooldown throws KeyPoolExhaustedError so callers
//          can degrade gracefully.
//        - Keys are NEVER logged. Diagnostics use a 6-char prefix + "...".

import { serverTs } from "./envelope.js";
import { CAPS } from "./validation.js";
// The L2 / MRL vector math lives in vector-math.js, which has no imports of
// its own — so this edge cannot become a cycle. l2NormAssert and mrlSlice are
// called on the embed paths below; DEFAULT_MRL_DIMS and
// L2_NORM_INVARIANT_EPSILON are re-exported through GEMINI_CLIENT_CONSTANTS.
// l2Renormalize is deliberately NOT imported: this module has no call site for
// it (mrlSlice, its only former caller here, moved out too).
import {
  l2NormAssert,
  mrlSlice,
  DEFAULT_MRL_DIMS,
  L2_NORM_INVARIANT_EPSILON,
} from "./vector-math.js";
// F-NEW-W4-EMBED-COST-WIRING: every embedSingle/embedBatch/embedSegments call
// records (model, source, input_tokens) into the in-process counter so the
// operator can surface $/day per source via memory_connectors_list. Inline
// rather than wrapper-based: there are 4+ call-sites (recall.js,
// distill-promote-fact.js, _corroborate.js, salience.js) and threading a
// wrapper through each would multiply edit surface and risk un-tracked
// paths. The inline call is fail-safe (recordEmbedCall rejects bad input
// silently) so an instrumentation bug can never break the embed hot path.
import {
  estimateInputTokens,
  estimateBatchInputTokens,
  recordEmbedCall,
} from "./observability/embed-cost.js";

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

// Pinned model. Per the architecture report: load-bearing.
const GEMINI_MODEL = "gemini-embedding-001";
const GEMINI_EMBEDDING_MODEL_VERSION = "gemini-embedding-001";

// Endpoints.
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const EMBED_CONTENT_PATH = `models/${GEMINI_MODEL}:embedContent`;
const BATCH_EMBED_CONTENTS_PATH = `models/${GEMINI_MODEL}:batchEmbedContents`;

// Batch size cap. Empirically Gemini's batchEmbedContents accepts up to ~100
// requests per call; chunk larger inputs.
const GEMINI_BATCH_SIZE_MAX = 100;

// Default output dimensionality — always the full 3072d for storage; MRL
// slicing is a client-side concern.
const DEFAULT_OUTPUT_DIMENSIONALITY = 3072;

// Retry policy buckets:
//   - 5xx + network errors: retryable on the SAME key (infra failure; rotating
//     wastes a slot).
//   - 429: rotate to the next key AND record the 429 timestamp on this key.
//     The key is skipped while (now - last_429_ts) is within
//     CAPS.GEMINI_KEY_COOLDOWN_SECONDS (R30: 60s default — Google's
//     per-minute rate-limit recovery cadence). Per-day quotas surface as
//     every-request-429 and the daemon parks via the throttle layer.
//   - 403: rotate to the next key AND record the 429 timestamp on this key
//     (R29.2 — "project denied access" class: GCP project misconfiguration.
//     A 403'd key is treated identically to 429 for skip-window purposes;
//     if the operator fixes project access mid-window, the key becomes
//     re-eligible after the 60s window. A distinct stderr line is emitted
//     so the operator can tell project-denial apart from quota-exhaustion
//     in their logs and act accordingly.)
//   - 400 / 401: config error, NOT retryable, NOT rotated. The next key would
//     hit the same wall.
const RETRY_BACKOFF_MS = [200, 600, 1800];
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
// R29.2: 403 ("project denied access") joins 429 in the rotate-and-cool bucket.
// Distinct from RETRYABLE_STATUSES because rotation is keyed off statusCode in
// the inner loop, not off this set; this set still drives "is this retryable
// on the SAME key" classification in _embedRequest.
const PROJECT_DENIED_STATUSES = new Set([403]);

// R29.1: Key-shape validation patterns.
// - Legacy AIza format: AIzaSy + 33 alphanum (39 chars total per Google Cloud API key convention)
// - New AQ format (Vertex AI / GenAI 2026+): AQ. + 50 chars (53 total)
// Either format passes. Placeholders and obviously-malformed strings throw at pool boot.
const KEY_SHAPE_AIZA = /^AIza[A-Za-z0-9_-]{35,}$/;
const KEY_SHAPE_AQ = /^AQ\.[A-Za-z0-9_-]{40,80}$/;
const KEY_PLACEHOLDER = /^REPLACE_/;
function isValidKeyShape(key) {
  if (typeof key !== "string" || key.length < 30) return false;
  if (KEY_PLACEHOLDER.test(key)) return false;
  return KEY_SHAPE_AIZA.test(key) || KEY_SHAPE_AQ.test(key);
}
function redactKey(key) {
  if (typeof key !== "string") return "<non-string>";
  if (key.length <= 12) return "<too-short:" + key.length + ">";
  return key.slice(0, 12) + "...";
}

// All eight task types per gemini-embedding-001 docs. Exported for callers so
// upstream pipeline code never has to free-string a task type.
export const GEMINI_TASK_TYPES = Object.freeze({
  RETRIEVAL_QUERY: "RETRIEVAL_QUERY",
  RETRIEVAL_DOCUMENT: "RETRIEVAL_DOCUMENT",
  SEMANTIC_SIMILARITY: "SEMANTIC_SIMILARITY",
  CLASSIFICATION: "CLASSIFICATION",
  CLUSTERING: "CLUSTERING",
  QUESTION_ANSWERING: "QUESTION_ANSWERING",
  FACT_VERIFICATION: "FACT_VERIFICATION",
  CODE_RETRIEVAL_QUERY: "CODE_RETRIEVAL_QUERY",
});

const VALID_TASK_TYPES = new Set(Object.values(GEMINI_TASK_TYPES));

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// R29 key pool + R30 round-robin rotation state.
// ----------------------------------------------------------------------------
//
// State shape (module-scope; in-memory only; daemon restart = fresh state):
//
//   _keyPool: string[]           // ordered list of opaque key strings
//   _lastUsedIndex: number       // round-robin cursor; -1 means "next is 0"
//   _key429TsByIndex: Map<number, number>
//                                // last-429 epoch ms per key index. A key
//                                // index whose entry is within
//                                // CAPS.GEMINI_KEY_COOLDOWN_SECONDS of now
//                                // is skipped by selectKey().
//   _poolWarnedDualEnv: boolean  // one-shot stderr warning when both envs set
//   _poolLoaded: boolean         // lazy parse-once flag (resolveable at any call)
//
// R30 zero-cooldown semantic:
//   When CAPS.GEMINI_KEY_COOLDOWN_SECONDS === 0 the skip-check short-circuits
//   so EVERY key is always eligible — pure rotation with no skip window.
//   In that mode, KeyPoolExhaustedError can still fire, but only when every
//   key in a single rotation pass returns 429/403 (the outer loop tries each
//   key once; if all fail, the pool is exhausted for this request). This is
//   intentional: zero cooldown means "be aggressive across all keys in
//   parallel" — once a single pass through all keys has 429'd, the request
//   has nowhere to go.
//
// We resolve LAZILY (at first call, not module load) so:
//   - test runners that scrub env vars and then re-set them work correctly
//   - import time does not throw if the operator's plist is still being
//     configured.
//
// Keys are NEVER logged. _keyPrefix() returns the first 6 chars + "..." for
// diagnostics — enough to disambiguate a 5-key pool, not enough to leak.

let _keyPool = null;
let _lastUsedIndex = -1;
let _key429TsByIndex = null;
let _poolWarnedDualEnv = false;
let _poolLoaded = false;

// R37: proactive per-minute rate-limit tracker. Per-key list of recent call
// timestamps (epoch ms, sorted ascending). selectKey() trims each list to the
// rolling CAPS.GEMINI_KEY_RPM_WINDOW_MS window and skips a key whose remaining
// count is >= CAPS.GEMINI_KEY_RPM_LIMIT. Distinct from the R30 cooldown
// (_key429TsByIndex): cooldown is REACTIVE (set on observed 429/403), the
// RPM tracker is PROACTIVE (records EVERY attempt and prevents over-issue
// before the request fires). Both filters are applied in selectKey; either
// can skip a key. The tracker is recorded just before _embedRequest fires.
let _callTimestampsByIndex = null;

// R29.3 CRIT-3: throttle the throw-site log so a sustained cooldown
// window emits ONE stderr line instead of one-per-throw. The watermark
// wrapper has its own throttle (R29.1) at the catch site; the throw site
// needs its own throttle independent of that because the catch-site
// throttle only fires AFTER the throw propagates — by then this site
// has already logged. R29.2's verification captured 161,861 stderr lines
// because the throw-site emit was unconditional.
//
// State:
//   _throwSiteLastLogMs: epoch ms of the last emit, or null if not yet emitted
//     (also reset to null on any successful _embedRequest so the next
//     exhaustion fires a fresh log line).
//   _throwSiteLastNextRetryAtIso: the next_retry_at_iso of the last emit; if
//     a new throw carries a DIFFERENT iso the window resets early so the
//     operator sees the updated timing.
let _throwSiteLastLogMs = null;
let _throwSiteLastNextRetryAtIso = null;
const THROW_SITE_LOG_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

// WU2-inline-embed-and-remove-gemini-quota-machinery removed the pool-wide
// NETWORK circuit-breaker (_networkFailureTimestamps / _networkCooldownUntilMs
// + _recordNetworkFailure / _clearNetworkBreaker / _networkCooldownActive +
// the allKeysCooled / embedTemporarilyUnavailable predicates). That machinery
// existed only to keep the cascade hot path from starving the async embed-
// backfill worker's network access while both shared the Gemini connection
// pool. The cascade now embeds inline via the local server and the async
// worker is gone, so there is no shared pool to protect. The per-key 429
// cooldown + RPM tracker below remain for the recall/_corroborate embed call
// sites and the Flash reranker.

// ThrottledStructuralError — marker base class for errors that represent a
// structural condition (pool exhausted, pool not configured, all keys revoked)
// rather than per-instance noise. Throttle layers in callers (watermark.js
// wrapper-catch + prefetch-catch; gemini-client throw-site) should rate-limit
// logs on `err instanceof ThrottledStructuralError`.
//
// Concrete classes extending this (current + planned):
//   - KeyPoolExhaustedError
//   - (future) KeyPoolNotConfiguredError
//   - (future) KeyPoolAllRevokedError
//
// Authors of new error classes: extend ThrottledStructuralError when the error
// represents a structural condition that fires N-per-row but carries 1-bit of
// operator-relevant signal. Extend plain Error for per-instance noise that
// operators want to see every occurrence of. The base class IS the convention
// — throttle layers check `instanceof ThrottledStructuralError`, never .name
// strings, so future structural-error subclasses are picked up automatically.
//
// `retryable` is set to `false` on the base: the existing transport-retry
// layer in callers treats truthy `retryable` as a signal to keep hammering.
// The degrade-to-embed-pending path is the correct response for any structural
// error in this hierarchy, not a hot retry. Subclasses inherit this default.
export class ThrottledStructuralError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
    this.retryable = false;
  }
}

// Custom error class. Callers (notably the watermark daemon) catch this via
// `instanceof ThrottledStructuralError` to engage the embed-pending / degrade
// path cleanly without confusing it with generic embed transport failures.
//
// `.name` is pinned to the literal string "KeyPoolExhaustedError" (not the
// constructor.name fallback from the base) for log readability + back-compat
// with operator dashboards that filter on the name string. The throttle
// decision itself does NOT depend on the name — that uses instanceof.
export class KeyPoolExhaustedError extends ThrottledStructuralError {
  constructor(message, opts) {
    super(message);
    this.name = "KeyPoolExhaustedError";
    if (opts && typeof opts.next_retry_at_iso === "string") {
      this.next_retry_at_iso = opts.next_retry_at_iso;
    } else {
      this.next_retry_at_iso = null;
    }
  }
}

// Redact a key for logging. 6 chars is enough to disambiguate any realistic
// pool (Gemini keys are ~39 chars; the first 6 of AIzaSy* still leak nothing
// sensitive because every Google API key starts with the same fixed prefix).
// We slice 0..6 because the operator's actual entropy lives later in the
// string. The redaction floor matches the spec's "first-6-chars + '...'"
// discipline.
function _keyPrefix(key) {
  if (typeof key !== "string" || key.length === 0) return "<empty>";
  return key.slice(0, 6) + "...";
}

// Parse GEMINI_API_KEYS / GEMINI_API_KEY into the in-memory pool. Lazy: called
// from _resolvePool(). Side effects: populates _keyPool + _key429TsByIndex;
// resets _lastUsedIndex; warns once on dual-env config; never logs key bytes.
function _parseKeyPoolFromEnv() {
  const rawMulti = process.env.GEMINI_API_KEYS;
  const rawSingle = process.env.GEMINI_API_KEY;
  const hasMulti = typeof rawMulti === "string" && rawMulti.trim() !== "";
  const hasSingle = typeof rawSingle === "string" && rawSingle.trim() !== "";

  let pool = [];
  if (hasMulti) {
    if (hasSingle && !_poolWarnedDualEnv) {
      process.stderr.write(
        "gemini-client: both GEMINI_API_KEYS and GEMINI_API_KEY set; using GEMINI_API_KEYS and ignoring GEMINI_API_KEY\n"
      );
      _poolWarnedDualEnv = true;
    }
    const parts = rawMulti.split(",");
    const seen = new Set();
    for (let i = 0; i < parts.length; i++) {
      const trimmed = parts[i].trim();
      if (trimmed === "") continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      pool.push(trimmed);
      if (pool.length >= CAPS.GEMINI_KEY_POOL_MAX_SIZE) break;
    }
  } else if (hasSingle) {
    pool = [rawSingle.trim()];
  }

  // R29.1: Validate each candidate's shape. Reject the REPLACE_ placeholder
  // and any string that doesn't match AIza-format or AQ-format. Fail-loud at
  // boot rather than 401-loop at runtime. Never echo raw key bytes — use
  // redactKey() for the error string.
  for (let i = 0; i < pool.length; i++) {
    const k = pool[i];
    if (!isValidKeyShape(k)) {
      throw new Error(
        "gemini-client: pool key #" +
          (i + 1) +
          " (" +
          redactKey(k) +
          ") fails shape validation; reject if placeholder or wrong format. " +
          "Accepted shapes: AIza<35+ chars> or AQ.<40-80 chars>. " +
          "Check GEMINI_API_KEYS in the environment of this process."
      );
    }
  }

  _keyPool = pool;
  _key429TsByIndex = new Map();
  _callTimestampsByIndex = new Map();
  _lastUsedIndex = -1;

  if (pool.length > 0) {
    process.stderr.write(
      "gemini-client: loaded " + pool.length + "-key pool; first prefix=" + redactKey(pool[0]) + "\n"
    );
  }
}

// Lazy resolver. Idempotent across calls in a process. Returns void; throws
// only when both env vars are absent AND the pool is empty.
function _resolvePool() {
  if (_poolLoaded) return;
  _parseKeyPoolFromEnv();
  _poolLoaded = true;
}

// Force a re-parse from env. Intended for tests AND for an eventual daemon
// SIGUSR1 path that re-ups cooldown state. Resets _poolWarnedDualEnv so the
// warning is emitted again on dual-env in the new state.
export function _resetKeyPoolForTests() {
  _keyPool = null;
  _lastUsedIndex = -1;
  _key429TsByIndex = null;
  _callTimestampsByIndex = null;
  _poolWarnedDualEnv = false;
  _poolLoaded = false;
  // R29.3: throw-site throttle state must also reset between tests so a
  // prior test's emit doesn't suppress the next test's first emit.
  _throwSiteLastLogMs = null;
  _throwSiteLastNextRetryAtIso = null;
  // R30: clear any per-test cooldown-seconds override.
  _testCooldownSecondsOverride = null;
  // R37: clear any per-test RPM-limit override.
  _testRpmLimitOverride = null;
}

// F1 (memperf): pool-size introspection for consumers that gate on key
// availability (notably the recall Layer-3 rerank gate in
// mcp/lib/recall/rerank.js). Lazily parses the env on first call via the
// same _resolvePool() path the request code uses; returns 0 when neither
// GEMINI_API_KEYS nor GEMINI_API_KEY is configured. NOTE: may propagate the
// shape-validation throw from _parseKeyPoolFromEnv (REPLACE_ placeholder or
// malformed key) — callers must treat a throw as "pool unusable" and
// degrade accordingly. Never logs key bytes.
export function geminiKeyPoolSize() {
  _resolvePool();
  return _keyPool ? _keyPool.length : 0;
}

// F1 (memperf): acquire the next eligible key from the shared pool using the
// EXACT selection machinery the embedding path uses (selectKey: round-robin
// + 429-cooldown + proactive RPM filter). Returns the key string, or null
// when the pool is unconfigured OR every key is currently cooling down /
// RPM-parked. Like geminiKeyPoolSize(), may propagate the shape-validation
// throw from the lazy env parse. Never logs key bytes.
export function acquireGeminiKey() {
  _resolvePool();
  const sel = selectKey();
  return sel ? sel.key : null;
}

// R30 test-only seam. CAPS is Object.freeze'd so tests can't mutate
// CAPS.GEMINI_KEY_COOLDOWN_SECONDS directly. Tests call this with `n` (a
// non-negative integer) to override the cooldown in-process; pass null to
// clear the override and revert to the CAPS value. Production code MUST
// NOT call this — the daemon reads CAPS directly.
let _testCooldownSecondsOverride = null;
export function _setCooldownSecondsForTests(n) {
  if (n === null || n === undefined) {
    _testCooldownSecondsOverride = null;
    return;
  }
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      "_setCooldownSecondsForTests: argument must be a non-negative integer or null"
    );
  }
  _testCooldownSecondsOverride = n;
}
function _activeCooldownSeconds() {
  return _testCooldownSecondsOverride != null
    ? _testCooldownSecondsOverride
    : CAPS.GEMINI_KEY_COOLDOWN_SECONDS;
}

// R37 test-only seam. CAPS is Object.freeze'd so tests can't mutate
// CAPS.GEMINI_KEY_RPM_LIMIT directly. Tests with REAL Gemini network calls
// (notably integration-phase3-v0.test.mjs) may legitimately need to issue
// >5 calls inside a 60s window against a single key during a single test
// run — the test is exercising end-to-end correctness, not bucket
// arithmetic. Setting the limit to 0 disables the proactive filter
// entirely; pass null to clear the override. Production code MUST NOT
// call this — the daemon reads CAPS directly.
let _testRpmLimitOverride = null;
export function _setRpmLimitForTests(n) {
  if (n === null || n === undefined) {
    _testRpmLimitOverride = null;
    return;
  }
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      "_setRpmLimitForTests: argument must be a non-negative integer or null"
    );
  }
  _testRpmLimitOverride = n;
}
function _activeRpmLimit() {
  return _testRpmLimitOverride != null
    ? _testRpmLimitOverride
    : CAPS.GEMINI_KEY_RPM_LIMIT;
}

// Throw if the pool is empty (no env vars set). Lazy; called from the request
// path so module load itself never throws.
function _assertPoolNonEmpty() {
  if (!_keyPool || _keyPool.length === 0) {
    throw new Error(
      "GEMINI_API_KEYS / GEMINI_API_KEY is not set. Set GEMINI_API_KEYS " +
        "(comma-separated) in the MCP server's environment (your MCP client " +
        "config; never in a plist's EnvironmentVariables), OR export " +
        "GEMINI_API_KEYS=... for ad-hoc runs."
    );
  }
}

// R37: Trim the per-key call-timestamp list to the rolling RPM window. The
// list is maintained sorted-ascending (we only push Date.now() values which
// are monotonic in practice; small clock jitter is bounded by the windowMs
// cliff and is operationally harmless). The trim drops timestamps older than
// `now - windowMs`. Mutates the list in place; safe on missing/empty entries.
function _trimRpmTimestamps(keyIndex, nowMs, windowMs) {
  if (!_callTimestampsByIndex) return;
  const list = _callTimestampsByIndex.get(keyIndex);
  if (!list || list.length === 0) return;
  const cutoff = nowMs - windowMs;
  let drop = 0;
  while (drop < list.length && list[drop] < cutoff) drop++;
  if (drop > 0) list.splice(0, drop);
}

// R37: Record a call attempt against the given key index. Initializes the
// per-key list lazily on first use. Trims to the rolling window AFTER the
// push so the post-call count is the operative one for the next selectKey.
function _recordRpmCall(keyIndex, nowMs, windowMs) {
  if (!_callTimestampsByIndex) return;
  let list = _callTimestampsByIndex.get(keyIndex);
  if (!list) {
    list = [];
    _callTimestampsByIndex.set(keyIndex, list);
  }
  list.push(nowMs);
  _trimRpmTimestamps(keyIndex, nowMs, windowMs);
}

// R37: True iff the key has already issued >= `limit` calls within the rolling
// window. The trim is done in place so subsequent calls observe the trimmed
// state. limit <= 0 disables the filter (always returns false).
function _isRpmExhausted(keyIndex, nowMs, limit, windowMs) {
  if (!Number.isFinite(limit) || limit <= 0) return false;
  if (!_callTimestampsByIndex) return false;
  _trimRpmTimestamps(keyIndex, nowMs, windowMs);
  const list = _callTimestampsByIndex.get(keyIndex);
  if (!list) return false;
  return list.length >= limit;
}

// R30 + R37: Return the next eligible key via round-robin rotation.
//
// Algorithm: starting at (_lastUsedIndex + 1) % poolSize, iterate forward up
// to poolSize positions, returning the first index that is NOT within the
// cooldown window AND is NOT RPM-throttled. A key index is in cooldown if
//   (now - _key429TsByIndex.get(index)) < CAPS.GEMINI_KEY_COOLDOWN_SECONDS*1000.
// CAPS.GEMINI_KEY_COOLDOWN_SECONDS === 0 short-circuits that skip so every
// key bypasses the cooldown gate. R37: an additional PROACTIVE filter skips
// any key whose rolling call count in the last CAPS.GEMINI_KEY_RPM_WINDOW_MS
// has reached CAPS.GEMINI_KEY_RPM_LIMIT. CAPS.GEMINI_KEY_RPM_LIMIT <= 0
// disables the proactive filter (pure cooldown semantics).
//
// On a hit, _lastUsedIndex is advanced to the returned index so the NEXT
// call resumes round-robin from there. Returns null when every key in the
// pool is filtered (caller will throw KeyPoolExhaustedError).
//
// Return shape: { key, index } so callers can mark a 429 on the same index
// without an extra _keyPool.indexOf() lookup.
function selectKey(nowMs) {
  if (!_keyPool || _keyPool.length === 0) return null;
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const cooldownMs = _activeCooldownSeconds() * 1000;
  const rpmLimit = _activeRpmLimit();
  const rpmWindowMs = CAPS.GEMINI_KEY_RPM_WINDOW_MS;
  const poolSize = _keyPool.length;

  for (let step = 1; step <= poolSize; step++) {
    const idx = (_lastUsedIndex + step) % poolSize;
    if (cooldownMs > 0) {
      const last429 = _key429TsByIndex.get(idx);
      if (typeof last429 === "number" && now - last429 < cooldownMs) {
        continue;
      }
    }
    // R37: proactive per-minute filter. Applied AFTER cooldown so the
    // (cheaper) cooldown check short-circuits when the key is already
    // parked from a recent 429/403.
    if (_isRpmExhausted(idx, now, rpmLimit, rpmWindowMs)) {
      continue;
    }
    _lastUsedIndex = idx;
    return { key: _keyPool[idx], index: idx };
  }
  return null;
}

// Compute the earliest next-eligible time across the pool as an ISO string.
// For each key index that has a last_429_ts, the next-eligible time is
// last_429_ts + cooldownMs. We return the minimum (the soonest a key
// becomes eligible). Returns null if no key has ever 429'd, or if the
// cooldown is zero (in which case keys are always eligible).
function _earliestNextEligibleIso() {
  if (!_key429TsByIndex || _key429TsByIndex.size === 0) return null;
  const cooldownMs = _activeCooldownSeconds() * 1000;
  if (cooldownMs === 0) return null;
  let earliest = null;
  for (const ts of _key429TsByIndex.values()) {
    if (typeof ts === "number") {
      const nextEligible = ts + cooldownMs;
      if (earliest == null || nextEligible < earliest) {
        earliest = nextEligible;
      }
    }
  }
  if (earliest == null) return null;
  return new Date(earliest).toISOString();
}

// R30: Record a 429 (or 403 — treated identically for skip-window purposes)
// on the given key index. Caller supplies nowMs for test determinism.
function _mark429(index, nowMs) {
  if (!_key429TsByIndex) return;
  if (!Number.isInteger(index) || index < 0) return;
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  _key429TsByIndex.set(index, now);
}

// R29.3 CRIT-3: throttled stderr emit for KeyPoolExhaustedError throw sites.
// Emits ONCE per THROW_SITE_LOG_THROTTLE_MS window unless the supplied
// nextRetryAtIso has changed (in which case the operator should see the
// updated retry time immediately, not after the window expires). A
// successful _embedRequest resets _throwSiteLastLogMs to null so the next
// exhaustion after a recovery fires a fresh log.
function _maybeLogPoolExhausted(msg, nextRetryAtIso) {
  const now = Date.now();
  const windowElapsed =
    _throwSiteLastLogMs == null ||
    now - _throwSiteLastLogMs > THROW_SITE_LOG_THROTTLE_MS;
  const isoChanged = _throwSiteLastNextRetryAtIso !== nextRetryAtIso;
  if (windowElapsed || isoChanged) {
    _throwSiteLastLogMs = now;
    _throwSiteLastNextRetryAtIso = nextRetryAtIso;
    process.stderr.write(`${msg}\n`);
  }
}

function assertTaskType(taskType) {
  if (!VALID_TASK_TYPES.has(taskType)) {
    throw new Error(
      `gemini-client: invalid taskType "${taskType}"; expected one of ${[...VALID_TASK_TYPES].join(", ")}`
    );
  }
}

// Compute next-attempt epoch ms. Centralized for test override.
function _nowMs(opts) {
  if (opts && typeof opts.now === "function") return opts.now();
  if (opts && typeof opts.now === "string") return Date.parse(opts.now);
  return Date.parse(serverTs());
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Single fetch+parse attempt for a Gemini REST endpoint. Returns parsed JSON
// on 2xx. Throws on non-2xx with a descriptive message; attaches
// err.statusCode + err.retryable for the retry layer.
//
// R29: the apiKey is now PASSED IN by the retry layer (instead of pulled from
// env on every call). The key never leaves this function via logs or error
// messages — the constructed URL is used only as a fetch target.
async function _embedRequest(urlPath, body, apiKey) {
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error("_embedRequest: apiKey argument is required");
  }
  const url = `${GEMINI_API_BASE}/${urlPath}?key=${encodeURIComponent(apiKey)}`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (netErr) {
    // WU2-inline-embed-and-remove-gemini-quota-machinery removed the pool-wide
    // network-breaker recorder here. A `fetch failed` stays a retryable infra
    // error wrapped for the retry layer below — there is no longer a shared
    // connection pool to protect from the (now-deleted) async embed worker.
    const wrapped = new Error(
      `gemini-client: network failure calling ${urlPath}: ${netErr && netErr.message ? netErr.message : String(netErr)}`
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
  } catch (_parseErr) {
    parsedBody = null;
  }

  if (!response.ok) {
    const apiMsg =
      parsedBody && parsedBody.error && parsedBody.error.message
        ? parsedBody.error.message
        : rawText || "no response body";
    const retryable = RETRYABLE_STATUSES.has(response.status);
    const err = new Error(
      `gemini-client: ${urlPath} returned ${response.status}: ${apiMsg}`
    );
    err.statusCode = response.status;
    err.retryable = retryable;
    err.body = parsedBody;
    throw err;
  }

  return parsedBody;
}

// R30 retry wrapper: round-robin key rotation + per-key 60s skip window.
//
// Two nested loops:
//   - OUTER (rotation): selectKey() advances round-robin, skipping keys
//     whose last_429_ts is within CAPS.GEMINI_KEY_COOLDOWN_SECONDS of now.
//     On 429 OR 403, mark the key's 429 timestamp and continue rotating.
//     Capped at pool-size attempts per request so a single request cannot
//     loop forever through a pool that is wholly 429'ing.
//   - INNER (transport): existing per-key backoff for 5xx / network errors
//     (these are infrastructure issues; burning rotation on them is wasteful).
//
// 400/401 throw immediately on whichever key surfaced them (these are config
// errors at the KEY layer; the next key would presumably hit the same wall
// only if the operator misconfigured every key).
//
// 403 ("project denied access") is treated as a PER-KEY config error: it
// usually means the operator has not enabled the Generative Language API on
// the GCP project owning this key, or the key was issued in a project with
// billing-suspended status. Other keys may live in well-configured projects,
// so we rotate (and treat the 403'd key identically to 429 for skip-window
// purposes — if the operator fixes project access, the key becomes
// re-eligible after the 60s window elapses).
//
// If all keys are within the skip window at OUTER-loop entry, OR if every
// key returns 429/403 within a single pass, throw KeyPoolExhaustedError so
// callers can degrade to embed-pending. The throttle in the watermark
// daemon (R29.1) catches both 429-exhaustion and 403-exhaustion via this
// single error class.
async function _embedRequestWithRetry(urlPath, body) {
  _resolvePool();
  _assertPoolNonEmpty();

  const maxRotations = _keyPool.length;
  let lastErr = null;

  for (let rotation = 0; rotation < maxRotations; rotation++) {
    const pick = selectKey();
    if (pick == null) {
      // Every key is filtered (cooldown OR R37 RPM-throttle). Build the
      // exhaustion error with next_retry_at_iso = soonest cooldown release;
      // if no key has ever 429'd, the RPM tracker is the binding filter and
      // next_retry_at_iso will be null (the RPM window slides continuously).
      const next = _earliestNextEligibleIso();
      const cooldownSec = _activeCooldownSeconds();
      const msg =
        next != null
          ? `gemini-client: all keys exhausted (${_keyPool.length}/${_keyPool.length} in ${cooldownSec}s cooldown or RPM-throttled until ${next}); round-robin rotation skipped every key; next embed will throw KeyPoolExhaustedError until at least one key's cooldown elapses or its RPM window slides`
          : `gemini-client: all keys exhausted (${_keyPool.length}/${_keyPool.length} RPM-throttled at ${CAPS.GEMINI_KEY_RPM_LIMIT} calls/${CAPS.GEMINI_KEY_RPM_WINDOW_MS}ms window); round-robin rotation skipped every key; next embed will throw KeyPoolExhaustedError until at least one key's RPM window slides`;
      // R29.3 CRIT-3: throttle so a sustained cold-pool window emits ONE
      // line per 5 minutes, not one-per-throw. Throw remains unconditional.
      _maybeLogPoolExhausted(msg, next);
      throw new KeyPoolExhaustedError(msg, { next_retry_at_iso: next });
    }
    const { key, index: keyIndex } = pick;

    // Inner transport-retry loop on the chosen key. 5xx / network retries
    // stay on the SAME key — they are infra failures, not quota failures.
    const maxAttempts = RETRY_BACKOFF_MS.length + 1;
    let rotateToNextKey = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // R37: record the call against the RPM tracker BEFORE firing so a
        // concurrent selectKey on the same key index sees the in-flight
        // attempt count against the rolling window. The record happens on
        // EVERY transport-retry attempt because each attempt is a network
        // round-trip Google's per-minute counter would observe.
        _recordRpmCall(keyIndex, Date.now(), CAPS.GEMINI_KEY_RPM_WINDOW_MS);
        const result = await _embedRequest(urlPath, body, key);
        // R29.3 CRIT-3: reset throw-site throttle on any successful embed.
        // The next exhaustion event (if any) should fire a fresh log line —
        // the cold-pool condition has been broken by a successful call.
        _throwSiteLastLogMs = null;
        _throwSiteLastNextRetryAtIso = null;
        return result;
      } catch (err) {
        lastErr = err;
        if (err && err.statusCode === 429) {
          // Quota / rate-limit failure: record 429 on THIS key and rotate.
          _mark429(keyIndex);
          const fromOrd = keyIndex + 1;
          const total = _keyPool.length;
          process.stderr.write(
            `gemini-client: key #${fromOrd} of ${total} (prefix ${_keyPrefix(key)}) hit 429, rotating round-robin to next eligible key (${_activeCooldownSeconds()}s skip window)\n`
          );
          rotateToNextKey = true;
          break;
        }
        if (err && PROJECT_DENIED_STATUSES.has(err.statusCode)) {
          // R29.2 + R30: 403 "project denied access" — likely GCP project
          // misconfiguration on the project owning THIS key. Treat
          // identically to 429 for skip-window purposes; if the operator
          // fixes project access within the 60s window the next request to
          // this key index will succeed. Distinct stderr message so the
          // operator can tell project-denial apart from quota-exhaustion
          // in their logs and act accordingly (enable Generative Language
          // API + billing vs. wait-for-rate-limit-recovery).
          _mark429(keyIndex);
          const fromOrd = keyIndex + 1;
          const total = _keyPool.length;
          const fromRedacted = redactKey(key);
          process.stderr.write(
            `gemini-client: key #${fromOrd} of ${total} (prefix ${fromRedacted}) returned 403 'project denied access' — likely GCP project misconfiguration; check Generative Language API enablement + billing on the project owning this key; rotating round-robin to next eligible key (${_activeCooldownSeconds()}s skip window)\n`
          );
          rotateToNextKey = true;
          break;
        }
        if (!err.retryable || attempt === maxAttempts - 1) {
          throw err;
        }
        await _sleep(RETRY_BACKOFF_MS[attempt]);
      }
    }

    if (!rotateToNextKey) {
      // Inner loop returned successfully or threw a non-rotation error.
      // (Both terminal paths return / throw inside the loop above; this is a
      // defensive break in case future edits change the inner control flow.)
      break;
    }
    // Rotate: no inter-key backoff — we are trying a different identity, not
    // re-trying the same one.
  }

  // Exhausted the rotation budget. If the terminal lastErr was a 429 OR a
  // 403 (rotate-and-mark class), synthesize a KeyPoolExhaustedError so the
  // watermark-layer throttle catches the cold-pool condition once per
  // cooldown window (R29.1). Mixed pools (some keys 429'd, some 403'd) all
  // end up here; the throttle does not need to distinguish.
  if (
    lastErr &&
    (lastErr.statusCode === 429 || PROJECT_DENIED_STATUSES.has(lastErr.statusCode))
  ) {
    const next = _earliestNextEligibleIso();
    const cooldownSec = CAPS.GEMINI_KEY_COOLDOWN_SECONDS;
    const msg =
      next != null
        ? `gemini-client: all keys exhausted (${_keyPool.length}/${_keyPool.length} in ${cooldownSec}s cooldown until ${next}); round-robin rotation exhausted in one pass; next embed will throw KeyPoolExhaustedError until at least one key's cooldown elapses`
        : `gemini-client: all keys exhausted (${_keyPool.length}/${_keyPool.length} in ${cooldownSec}s cooldown); round-robin rotation exhausted in one pass; next embed will throw KeyPoolExhaustedError until at least one key's cooldown elapses`;
    // R29.3 CRIT-3: throttle so a sustained cold-pool window emits ONE
    // line per 5 minutes, not one-per-throw. Throw remains unconditional.
    _maybeLogPoolExhausted(msg, next);
    throw new KeyPoolExhaustedError(msg, { next_retry_at_iso: next });
  }
  // Unreachable for non-rotation paths (inner loop throws), but guard anyway.
  throw lastErr || new Error("gemini-client: _embedRequestWithRetry exhausted with no error captured");
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

// Embed a single text. Returns the full 3072d vector and, if `dims` was
// supplied (defaulting to 3072 = no slice), the MRL-sliced + L2-renormalized
// vector. Always returns both for caller convenience; if dims === 3072 then
// vector_mrl_renormalized is null (slicing 3072 -> 3072 is a no-op).
//
// F-NEW-W4-EMBED-COST-WIRING: `source` is an optional connector / call-site
// label used by the embed-cost observability layer to attribute spend to
// the operator-facing source. Callers SHOULD pass a stable string (e.g.
// "recall-time", "promote-fact", "corroborate", "salience"). When omitted,
// the call still records under "unknown_source" so the counter never silently
// drops a billable network round-trip.
export async function embedSingle({
  text,
  taskType,
  dims = DEFAULT_OUTPUT_DIMENSIONALITY,
  source,
} = {}) {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("embedSingle: text must be a non-empty string");
  }
  assertTaskType(taskType);
  if (!Number.isInteger(dims) || dims <= 0 || dims > 3072) {
    throw new Error(`embedSingle: dims must be a positive integer <= 3072, got ${dims}`);
  }

  // F-NEW-W4-EMBED-COST-WIRING: record BEFORE the network call so even a
  // failed embed (which still incurs a Gemini-side network round-trip and
  // may be billed) is attributed. Token count is derived from input text
  // alone, so the pre-call estimate matches the post-call truth.
  recordEmbedCall({
    model: GEMINI_EMBEDDING_MODEL_VERSION,
    input_tokens: estimateInputTokens(text),
    output_tokens: 0,
    source: typeof source === "string" && source.length > 0 ? source : "unknown_source",
  });

  const body = {
    model: `models/${GEMINI_MODEL}`,
    content: { parts: [{ text }] },
    taskType,
    outputDimensionality: 3072,
  };

  const parsed = await _embedRequestWithRetry(EMBED_CONTENT_PATH, body);

  if (!parsed || !parsed.embedding || !Array.isArray(parsed.embedding.values)) {
    throw new Error(
      "embedSingle: response missing embedding.values; unexpected Gemini schema"
    );
  }
  const vector_3072 = parsed.embedding.values;
  if (vector_3072.length !== 3072) {
    throw new Error(
      `embedSingle: expected 3072 dims, got ${vector_3072.length}; cannot proceed`
    );
  }

  // Default-dim full vectors come back unit-norm per Phase A; assert it.
  l2NormAssert(vector_3072, "embedSingle.vector_3072");

  let vector_mrl_renormalized = null;
  if (dims < 3072) {
    vector_mrl_renormalized = mrlSlice(vector_3072, dims);
    l2NormAssert(vector_mrl_renormalized, "embedSingle.vector_mrl_renormalized");
  }

  return {
    vector_3072,
    vector_mrl_renormalized,
    embedding_model_version: GEMINI_EMBEDDING_MODEL_VERSION,
  };
}

// Embed a batch of texts with a single task_type for all items. Order
// preserved via an "index" field on each returned record. Chunks input
// internally if length > GEMINI_BATCH_SIZE_MAX.
//
// F-NEW-W4-EMBED-COST-WIRING: `source` mirrors embedSingle's optional
// source label. One recordEmbedCall fires per chunk (each chunk is one
// batchEmbedContents network round-trip, regardless of the per-item
// count) so the call_count counter is a faithful proxy for round-trips.
export async function embedBatch({ items, taskType, source } = {}) {
  if (!Array.isArray(items)) {
    throw new Error("embedBatch: items must be an array");
  }
  if (items.length === 0) return [];
  for (let i = 0; i < items.length; i++) {
    if (typeof items[i] !== "string" || items[i].length === 0) {
      throw new Error(`embedBatch: items[${i}] must be a non-empty string`);
    }
  }
  assertTaskType(taskType);

  const costSource =
    typeof source === "string" && source.length > 0 ? source : "unknown_source";

  const out = new Array(items.length);
  for (let chunkStart = 0; chunkStart < items.length; chunkStart += GEMINI_BATCH_SIZE_MAX) {
    const chunkEnd = Math.min(chunkStart + GEMINI_BATCH_SIZE_MAX, items.length);
    const chunk = items.slice(chunkStart, chunkEnd);

    // F-NEW-W4-EMBED-COST-WIRING: record per chunk. Token estimate sums
    // across the chunk; one round-trip == one call_count bump.
    recordEmbedCall({
      model: GEMINI_EMBEDDING_MODEL_VERSION,
      input_tokens: estimateBatchInputTokens(chunk),
      output_tokens: 0,
      source: costSource,
    });

    // batchEmbedContents wants an array of full embedContent request bodies.
    const requests = chunk.map((text) => ({
      model: `models/${GEMINI_MODEL}`,
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: 3072,
    }));
    const body = { requests };

    const parsed = await _embedRequestWithRetry(BATCH_EMBED_CONTENTS_PATH, body);

    if (!parsed || !Array.isArray(parsed.embeddings)) {
      throw new Error(
        "embedBatch: response missing embeddings[]; unexpected Gemini schema"
      );
    }
    if (parsed.embeddings.length !== chunk.length) {
      throw new Error(
        `embedBatch: expected ${chunk.length} embeddings, got ${parsed.embeddings.length}`
      );
    }

    for (let i = 0; i < chunk.length; i++) {
      const emb = parsed.embeddings[i];
      if (!emb || !Array.isArray(emb.values)) {
        throw new Error(
          `embedBatch: embeddings[${i}] missing values; unexpected Gemini schema`
        );
      }
      const vector_3072 = emb.values;
      if (vector_3072.length !== 3072) {
        throw new Error(
          `embedBatch: embeddings[${i}] expected 3072 dims, got ${vector_3072.length}`
        );
      }
      l2NormAssert(vector_3072, `embedBatch[${chunkStart + i}].vector_3072`);

      out[chunkStart + i] = {
        index: chunkStart + i,
        vector_3072,
        vector_mrl_renormalized: null,
        embedding_model_version: GEMINI_EMBEDDING_MODEL_VERSION,
      };
    }
  }
  return out;
}

// Embed an array of surrounding_context segments at recall-time, preserving
// the segment_role tag. Used by Layer 1 of the recall pipeline for per-segment
// MaxSim. All segments share a single taskType (typically RETRIEVAL_QUERY).
export async function embedSegments({ segments, taskType, source } = {}) {
  if (!Array.isArray(segments)) {
    throw new Error("embedSegments: segments must be an array");
  }
  if (segments.length === 0) return [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (
      !seg ||
      typeof seg !== "object" ||
      typeof seg.segment_role !== "string" ||
      seg.segment_role.length === 0 ||
      typeof seg.text !== "string" ||
      seg.text.length === 0
    ) {
      throw new Error(
        `embedSegments: segments[${i}] must be { segment_role: non-empty string, text: non-empty string }`
      );
    }
  }
  assertTaskType(taskType);

  const items = segments.map((s) => s.text);
  // F-NEW-W4-EMBED-COST-WIRING: forward `source` so embedSegments call-sites
  // (recall.js — "recall-time") attribute their spend without double-counting.
  // embedBatch records once per chunk; embedSegments does not record again.
  const batched = await embedBatch({ items, taskType, source });
  return batched.map((rec, i) => ({
    index: i,
    segment_role: segments[i].segment_role,
    vector_3072: rec.vector_3072,
    vector_mrl_renormalized: rec.vector_mrl_renormalized,
    embedding_model_version: rec.embedding_model_version,
  }));
}

// R29.1: Exported for tests that exercise key-shape validation directly.
export { isValidKeyShape };

// Exported for tests that need to introspect the pinned version string.
export const GEMINI_CLIENT_CONSTANTS = Object.freeze({
  GEMINI_MODEL,
  GEMINI_EMBEDDING_MODEL_VERSION,
  GEMINI_BATCH_SIZE_MAX,
  DEFAULT_OUTPUT_DIMENSIONALITY,
  DEFAULT_MRL_DIMS,
  L2_NORM_INVARIANT_EPSILON,
});
