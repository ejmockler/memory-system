// rerank.js — Phase 3 v1 Layer-3 reranker orchestration.
//
// AUTHORITATIVE shape contract: kb/phase3-v1-rerank-contracts.md
// Spec source: kb/research-retrieval-frontiers.md
//   § "Phase 3 v1 — Instruction-following reranker"
//   § "Recommended Phase 3 architecture > Layer 3"
// Model + transport: mcp/lib/gemini-flash-client.js (REST direct; no SDK).
//
// LOAD-BEARING INVARIANTS (do not deviate without re-reading the spec):
//
//   1. Layer 3 ONLY REORDERS. Hard gates are immutable correctness
//      invariants. The reranker may NEVER drop a candidate on its own
//      opinion — drops happen at Layer 2 hard gates. If Flash returns a
//      candidate id we didn't send: ignore. If Flash OMITS a candidate id
//      we sent: assign it the median rank_score from the response so it
//      stays in the pool (no silent disappearance).
//
//   2. The instruction template structure (5 ranking rules + header block)
//      is pinned by T1 — change only in lockstep with the contracts doc.
//
//   3. content_excerpt is capped at CAPS.RECALL_RERANK_CONTENT_EXCERPT_CHARS
//      (400). Cap is hard truncation; no ellipsis. The reranker treats the
//      truncated content as opaque.
//
//   4. Fallback semantics: ANY Flash failure (timeout, network, http, parse,
//      missing API key, all-ids-unmatched) collapses to degraded=true with
//      a categorized rerank_failed_reason. On degraded path we sort the
//      INPUT (top-RECALL_RERANK_INPUT_SIZE) by final_score desc, take top
//      RECALL_RERANK_OUTPUT_SIZE, and set rerank_score=null on every item.
//      layer3_latency_ms is still populated (latency-until-failure).
//
//   5. Latency uses process.hrtime.bigint(); converted to integer ms via
//      Number(div by 1_000_000n). Date.now() / new Date() are forbidden in
//      agent scripts (only allowed at module-load level — same discipline
//      as gemini-flash-client.js / envelope.js serverTs).
//
//   6. No new npm deps; ES modules + plain JS only.

import { createHash } from "node:crypto";
import { CAPS, SALIENCE_WEIGHTS_V1_HASH } from "../validation.js";
import { serverTs } from "../envelope.js";
import { generateRanking } from "../gemini-flash-client.js";
// F1 (memperf): key-availability gate reuses gemini-client.js's shared key
// pool (GEMINI_API_KEYS plural / legacy GEMINI_API_KEY singular) instead of
// reading the singular env var directly — the production MCP server env
// sets only the plural form.
import { geminiKeyPoolSize } from "../gemini-client.js";
// N3-local-reranker: the local Qwen3-Reranker backend, gated by
// CAPS.LOCAL_RERANKER_ENABLED. Same generateRanking({instruction,candidates})
// -> {ranking:[{id,rank_score}]} shape, so it is a drop-in for the gemini call.
// A reranker outage throws (LocalRerankUnavailableError, "network failure") and
// the existing catch below degrades to the final_score sort — reorder-only.
import { generateRanking as _localGenerateRanking } from "./local-reranker-client.js";

// Resolve the DEFAULT ranking backend at call time (not import time) so the CAP
// is read live. Tests still override via opts._generateRanking (highest prio).
//
// TRI-STATE (b4-reranker-flag-flip). The env var is an OVERRIDE in BOTH
// directions, not an OR-arm that can only turn the flag on:
//   "1" / "true"   -> ON   (wins even when the CAP is false)
//   "0" / "false"  -> OFF  (wins even when the CAP is true)
//   unset / other  -> fall through to CAPS.LOCAL_RERANKER_ENABLED === true
// The old form was `CAP === true || env === "1"`, which had no OFF arm: once
// the CAP shipped true, `LOCAL_RERANKER_ENABLED=0` was inert and the CAP was
// unfalsifiable by env. Falling through on unset is what keeps every
// currently-unset host on exactly its previous resolution.
//
// WHY THE OFF ARM MATTERS (mechanism, not a roster). Leaving the var UNSET
// resolves to the CAP; a true CAP skips the gemini key-availability
// short-circuit below; the default backend then dials
// `LOCAL_RERANKER_URL || http://127.0.0.1:8360` via local-reranker-client.js
// _baseUrl(). So "unset" is not neutral — it is an opt-IN to an off-process
// dependency, which is why anything that must stay self-contained pins "0"
// rather than deleting the var.
//
// The one verified NON-TEST consumer of the OFF arm is
// mcp/scripts/mcp-recall-latency.mjs --skip-rerank, which sets "0" on the
// spawned server's env AFTER merging ~/.claude.json's mcpServers.memory.env,
// so the pin survives that merge and rerank cost can be attributed by
// difference.
//
// No count of test callers is recorded here on purpose: this comment has
// carried a wrong one before, and the population moves whenever a recall suite
// is added. RE-DERIVE it instead — mcp/scripts/rerank-hermeticity-probe.mjs
// censuses the whole SUITES registry by resolution and prints which suites
// dial, which do not, and which could not be measured.
//
// This is the SINGLE read of the flag: _resolveDefaultGenerateRanking() (which
// backend to call) and the gemini key-availability gate below (whether a
// missing gemini key is fatal) BOTH consume it, so backend selection and the
// key gate can never disagree.
function _localRerankerEnabled() {
  const raw = process.env.LOCAL_RERANKER_ENABLED;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "1" || v === "true") return true;
    if (v === "0" || v === "false") return false;
  }
  return CAPS.LOCAL_RERANKER_ENABLED === true;
}
function _resolveDefaultGenerateRanking() {
  return _localRerankerEnabled() ? _localGenerateRanking : generateRanking;
}

// Round-19 CRITICAL-4 hot-fix: emit append-only audit-provenance fields on
// every rerankCandidates return so recall.jsonl can be audited for prompt
// drift, cap changes, and model-version skew across recalls. Hash of the
// exact instruction string + a snapshot of the load-bearing CAPS + the
// model tag actually used. Computed once per call from the same CAPS the
// call uses; no separate source of truth.
function _instructionHash(instructionString) {
  if (typeof instructionString !== "string" || instructionString.length === 0) return null;
  return createHash("sha256").update(instructionString, "utf8").digest("hex").slice(0, 32);
}
// R25.5 CRIT-7: exported as `capsSnapshot` so recall.js can thread the
// salience-caps triple into recall.jsonl rows. The `_capsSnapshot` alias is
// retained as the private internal name used by _withAudit() so existing
// audit-provenance behaviour is byte-identical.
export function capsSnapshot() {
  return _capsSnapshot();
}
function _capsSnapshot() {
  // R25 salience-integration: include the salience CAPS triple on every
  // recall so recall.jsonl carries the audit trail for prompt drift across
  // re-weight events. CAPS values are pinned by validation.js (A6 owner);
  // null fallbacks tolerate the pre-A6-landing window without crashing.
  return {
    RECALL_RERANK_INPUT_SIZE: CAPS.RECALL_RERANK_INPUT_SIZE,
    RECALL_RERANK_OUTPUT_SIZE: CAPS.RECALL_RERANK_OUTPUT_SIZE,
    RECALL_RERANK_TIMEOUT_MS: CAPS.RECALL_RERANK_TIMEOUT_MS,
    RECALL_RERANK_CONTENT_EXCERPT_CHARS: CAPS.RECALL_RERANK_CONTENT_EXCERPT_CHARS,
    GEMINI_FLASH_RERANK_TEMPERATURE: CAPS.GEMINI_FLASH_RERANK_TEMPERATURE,
    GEMINI_FLASH_RERANK_THINKING_BUDGET: CAPS.GEMINI_FLASH_RERANK_THINKING_BUDGET,
    GEMINI_FLASH_RERANK_MAX_OUTPUT_TOKENS: CAPS.GEMINI_FLASH_RERANK_MAX_OUTPUT_TOKENS,
    SALIENCE_VERSION:
      typeof CAPS.SALIENCE_VERSION === "string" ? CAPS.SALIENCE_VERSION : null,
    // R25.5 CRIT-7: source the live SALIENCE_WEIGHTS_V1_HASH from the
    // top-level export in validation.js (derived from
    // canonicalJson(SALIENCE_WEIGHTS_V1)). The pre-R25.5 lookup against
    // CAPS.SALIENCE_WEIGHTS_V1_HASH always returned null because the hash
    // is not stored on the frozen CAPS object — it's exported as a separate
    // module-level constant. The audit trail in recall.jsonl was therefore
    // missing the freeze-window pin; this fixes it.
    SALIENCE_WEIGHTS_V1_HASH:
      typeof SALIENCE_WEIGHTS_V1_HASH === "string"
        ? SALIENCE_WEIGHTS_V1_HASH
        : null,
    SALIENCE_ALPHA:
      typeof CAPS.SALIENCE_ALPHA === "number" ? CAPS.SALIENCE_ALPHA : null,
  };
}
function _modelVersion() {
  return CAPS.GEMINI_FLASH_MODEL_DEFAULT;
}
// Wraps every rerankCandidates() return with audit-provenance fields. The
// instruction argument is the actual string sent to Flash (or null if the
// call never built one, e.g. on api_key_missing or internal_error during
// instruction build). caps_snapshot and model_version are always present.
function _withAudit(result, instructionStringOrNull) {
  return {
    ...result,
    rerank_instruction_hash: _instructionHash(instructionStringOrNull),
    rerank_caps_snapshot: _capsSnapshot(),
    rerank_model_version: _modelVersion(),
  };
}

// ---------------------------------------------------------------------------
// Constants (CAPS-sourced)
// ---------------------------------------------------------------------------

const RERANK_INPUT_SIZE = CAPS.RECALL_RERANK_INPUT_SIZE;
const RERANK_OUTPUT_SIZE = CAPS.RECALL_RERANK_OUTPUT_SIZE;
const RERANK_TIMEOUT_MS = CAPS.RECALL_RERANK_TIMEOUT_MS;
const RERANK_CONTENT_EXCERPT_CHARS = CAPS.RECALL_RERANK_CONTENT_EXCERPT_CHARS;
const MAX_INSTRUCTION_CHARS = CAPS.RECALL_BRIEF_MAX_CHARS_TOTAL;
// Per-recent-turn content cap in the instruction. The reranker only needs
// the most-recent conversation contour; long turn bodies waste tokens and
// crowd out the candidates. 200 chars is the contract default (see
// kb/phase3-v1-rerank-contracts.md § buildRerankInstruction).
const TURN_CONTENT_CHARS = 200;

// ---------------------------------------------------------------------------
// buildRerankInstruction
// ---------------------------------------------------------------------------
//
// Output template (verbatim — T1 pins the substring set; structural change
// is drift):
//
//   Rank these candidate memories by relevance to the current conversation context.
//
//   Current context:
//   - agent role: <agent_role>
//   - time: <time_now ISO-8601>
//   - recent conversation:
//     - <role>: <content>
//     - <role>: <content>
//   - entities in context: <comma-joined entities, or "(none)">
//
//   Ranking rules (apply declaratively):
//   1. PREFER candidates whose entities overlap with the conversation entities
//   2. DAMPEN candidates marked consent_basis="third_party_inferred" by ~30-40%
//   3. DEMOTE candidates marked derivation_orphan=true unless the conversation is about deletions/excisions
//   4. AVOID candidates that are paraphrases of any recent_turn (they're already in context)
//   5. SUPPRESS candidates with negative valence unless the conversation valence matches
//   6. PREFER salience >= 0.6 when other features tie.
//
//   Return a JSON array of {id, rank_score} for ALL provided candidates with rank_score in [0,1]; higher = more relevant.
//
// If the total instruction exceeds CAPS.RECALL_BRIEF_MAX_CHARS_TOTAL (4000),
// recent_turns are truncated from the OLDEST end (most-recent turns are most
// signalful) until the instruction fits under the cap.
export function buildRerankInstruction({
  surrounding_context,
  candidates: _candidates, // accepted for forward-compat; unused at v1
  opts,
} = {}) {
  const ctx = surrounding_context || {};
  const agentRole =
    typeof ctx.agent_role === "string" && ctx.agent_role.length > 0
      ? ctx.agent_role
      : "unknown";

  // Determinism: opts.now overrides; otherwise stamp via envelope.serverTs
  // (same helper the rest of the pipeline uses).
  const timeNow =
    opts && typeof opts.now === "string" && opts.now.length > 0
      ? opts.now
      : serverTs();

  // Entities: render comma-joined, or "(none)" if empty/absent.
  const entitiesArr = Array.isArray(ctx.entities) ? ctx.entities : [];
  const entitiesLine = entitiesArr.length === 0 ? "(none)" : entitiesArr.join(", ");

  // Recent turns: each as "  - <role>: <content>" with content truncated to
  // TURN_CONTENT_CHARS. Empty array renders as "  - (no recent turns)".
  const turnsArr = Array.isArray(ctx.recent_turns) ? ctx.recent_turns.slice() : [];
  const renderTurns = (arr) => {
    if (arr.length === 0) return "  - (no recent turns)";
    return arr
      .map((t) => {
        const role =
          t && typeof t.role === "string" && t.role.length > 0 ? t.role : "unknown";
        const content =
          t && typeof t.content === "string" ? t.content.slice(0, TURN_CONTENT_CHARS) : "";
        return `  - ${role}: ${content}`;
      })
      .join("\n");
  };

  const renderFull = (turns) =>
    `Rank these candidate memories by relevance to the current conversation context.

Current context:
- agent role: ${agentRole}
- time: ${timeNow}
- recent conversation:
${renderTurns(turns)}
- entities in context: ${entitiesLine}

Ranking rules (apply declaratively):
1. PREFER candidates whose entities overlap with the conversation entities
2. DAMPEN candidates marked consent_basis="third_party_inferred" by ~30-40%
3. DEMOTE candidates marked derivation_orphan=true unless the conversation is about deletions/excisions
4. AVOID candidates that are paraphrases of any recent_turn (they're already in context)
5. SUPPRESS candidates with negative valence unless the conversation valence matches
6. PREFER salience >= 0.6 when other features tie.

Return a JSON array of {id, rank_score} for ALL provided candidates with rank_score in [0,1]; higher = more relevant.`;

  // Drop oldest turns until under MAX_INSTRUCTION_CHARS.
  let working = turnsArr.slice();
  let out = renderFull(working);
  while (out.length > MAX_INSTRUCTION_CHARS && working.length > 0) {
    working = working.slice(1);
    out = renderFull(working);
  }
  return out;
}

// ---------------------------------------------------------------------------
// serializeCandidateForRerank
// ---------------------------------------------------------------------------
//
// Per-candidate text per kb/phase3-v1-rerank-contracts.md § serializeCandidateForRerank
// (R25 extension: salience= field appended after valence=):
//
//   id=<memory_id> (kind=<kind>, ts=<ts>, entities=[<joined>], consent_basis=<basis>, derivation_orphan=<true|false>, valence=<v | null>, salience=<f3>):
//   <content[0..RECALL_RERANK_CONTENT_EXCERPT_CHARS]>
//
// derivation_orphan derived from entry.derivation_distance != null (v0 shape).
// valence null literal rendered as "null" (matches T2 expectation).
// salience=<f3> is a 3-decimal float in [0,1]. Sourced from
// entry.features.salience.score when present; defaults to 0.500 for legacy
// rows (the 3 May-31 smoke rows pre-date the salience cascade). The default
// is rank-neutral against the "PREFER salience >= 0.6 when other features
// tie" rule (Flash rule 6).
// content truncated at RECALL_RERANK_CONTENT_EXCERPT_CHARS; NO ellipsis.
//
// The returned `id` MUST equal entry.memory_id exactly — gemini-flash-client
// uses it as the join key for response validation.
export function serializeCandidateForRerank({ entry, score_components: _sc } = {}) {
  if (!entry || typeof entry !== "object") {
    throw new Error("serializeCandidateForRerank: entry must be an object");
  }
  if (typeof entry.memory_id !== "string" || entry.memory_id.length === 0) {
    throw new Error("serializeCandidateForRerank: entry.memory_id must be a non-empty string");
  }
  const kind = typeof entry.kind === "string" ? entry.kind : "unknown";
  const ts = typeof entry.ts === "string" ? entry.ts : "";
  // Entity-heavy rows (chat-log facts) can carry dozens of entities; an
  // unbounded join here pushed header+excerpt past gemini-flash-client's
  // MAX_CANDIDATE_CONTENT_CHARS validation, throwing BEFORE any HTTP call and
  // degrading every such recall to internal_error at 0ms (latent since R33;
  // surfaced 2026-07-17 by F1's loud-degrade detail line). Cap the join —
  // the final hard slice below is the guarantee; this keeps the header legible.
  const entities = Array.isArray(entry.entities)
    ? entry.entities.slice(0, 8).join(",") +
      (entry.entities.length > 8 ? `,+${entry.entities.length - 8}` : "")
    : "";
  const consentBasis =
    typeof entry.consent_basis === "string" ? entry.consent_basis : "first_party";
  const derivationOrphan =
    entry.derivation_distance !== undefined && entry.derivation_distance !== null;
  const valence =
    entry.valence === null || entry.valence === undefined ? "null" : String(entry.valence);
  // R25 salience-integration: read score from entry.features.salience.score.
  // Legacy rows (no features.salience) default to 0.5 — rank-neutral against
  // Flash rule 6 ("PREFER salience >= 0.6 when other features tie").
  const salienceScore = _resolveSalienceScore(entry).score;
  const salienceStr = salienceScore.toFixed(3);
  const contentSrc = typeof entry.content === "string" ? entry.content : "";
  const contentExcerpt = contentSrc.slice(0, RERANK_CONTENT_EXCERPT_CHARS);

  const header =
    `id=${entry.memory_id} ` +
    `(kind=${kind}, ts=${ts}, entities=[${entities}], ` +
    `consent_basis=${consentBasis}, derivation_orphan=${derivationOrphan}, ` +
    `valence=${valence}, salience=${salienceStr}):`;

  // HARD GUARANTEE: never exceed the flash client's per-candidate validation
  // cap (CAPS.RECALL_BRIEF_MAX_CHARS_PER_ITEM — the same constant it reads as
  // MAX_CANDIDATE_CONTENT_CHARS). Hard truncation, no ellipsis, per the
  // existing excerpt discipline; the reranker treats content as opaque.
  return {
    id: entry.memory_id,
    content: `${header}\n${contentExcerpt}`.slice(
      0,
      CAPS.RECALL_BRIEF_MAX_CHARS_PER_ITEM
    ),
  };
}

// ---------------------------------------------------------------------------
// _resolveSalienceScore (R25): pull the salience score off an IndexEntry,
// tolerating the three states encountered in the wild:
//
//   1. features.salience.score present, weights_hash matches CAPS.SALIENCE_WEIGHTS_V1_HASH
//      -> {score, source: "scored", caps_drift: false}
//   2. features.salience.score present, weights_hash mismatch (CAPS re-weight
//      happened since the row was scored)
//      -> {score, source: "scored_drifted", caps_drift: true}
//      (we still use the stored score — it's the audit-trail truth)
//   3. features.salience missing entirely (legacy May-31 smoke rows, or any
//      row that pre-dates R25 cascade)
//      -> {score: 0.5, source: "legacy_no_score", caps_drift: false}
//
// The Layer-2 multiplier ALSO consumes this (mirrored in
// applySalienceMultiplier below) and SKIPS the multiplier on
// source="legacy_no_score" — legacy rows are ranking-neutral so they
// don't get penalised by missing instrumentation.
// ---------------------------------------------------------------------------
export function _resolveSalienceScore(entry) {
  const features = entry && typeof entry === "object" ? entry.features : null;
  const sal = features && typeof features === "object" ? features.salience : null;
  if (!sal || typeof sal !== "object") {
    return { score: 0.5, source: "legacy_no_score", caps_drift: false };
  }
  const score =
    typeof sal.score === "number" && Number.isFinite(sal.score) ? sal.score : 0.5;
  const storedHash = typeof sal.weights_hash === "string" ? sal.weights_hash : null;
  const currentHash =
    typeof CAPS.SALIENCE_WEIGHTS_V1_HASH === "string"
      ? CAPS.SALIENCE_WEIGHTS_V1_HASH
      : null;
  // If CAPS hasn't been populated yet (A6 lands separately) we can't detect
  // drift; treat as no-drift to avoid spurious caps_drift_count bumps.
  if (storedHash == null || currentHash == null || storedHash === currentHash) {
    return { score, source: "scored", caps_drift: false };
  }
  return { score, source: "scored_drifted", caps_drift: true };
}

// ---------------------------------------------------------------------------
// Latency helper (monotonic; hrtime-based; agent-script-safe)
// ---------------------------------------------------------------------------

function _nowNs() {
  return process.hrtime.bigint();
}

function _elapsedMs(startNs) {
  const elapsedNs = process.hrtime.bigint() - startNs;
  // Convert bigint ns -> ms, rounded to integer ms.
  return Number(elapsedNs / 1_000_000n);
}

// ---------------------------------------------------------------------------
// Failure classification (maps thrown errors -> rerank_failed_reason codes)
// ---------------------------------------------------------------------------
//
// Reason taxonomy per kb/phase3-v1-rerank-contracts.md § 1 RerankResult:
//   "api_key_missing" | "timeout" | "network" | "http_<status>"
//   | "malformed_response" | "all_ids_unmatched" | "internal_error"
//
// The vocabulary is FROZEN and BOUNDED — not decoration. _logRerankDegradeOnce
// below emits once per DISTINCT reason per process, and recall-observables.js
// ticks a layer3Reason histogram keyed on this exact string; both rely on the
// cardinality staying small. So an error may HINT at its reason structurally
// (err.reason), but only a member of the frozen set may pass; anything else
// falls through to the substring rules and ultimately internal_error.
//
// ---------------------------------------------------------------------------
// CENSUS BY RESOLUTION — all seven codes against the LOCAL backend (e14).
// Recorded as reachability, not as a count: for each code, either the test that
// reaches it or the construction that makes it unreachable.
//
//   timeout            REACHABLE — test/recall/local-reranker.test.mjs D1. The
//                      client's own AbortController fires (default 8000ms, env
//                      LOCAL_RERANKER_TIMEOUT_MS) and local-reranker-client.js
//                      now rethrows the AbortError UNWRAPPED, so the
//                      name/code branch below fires. Pre-e14 this was
//                      unreachable on the local path: the abort was rewrapped
//                      as "network failure" and every client timeout was
//                      filed as a network fault.
//   http_<status>      REACHABLE — D2 (503). local-reranker-client.js stamps
//                      { statusCode, reason:"http_<status>" } on the non-OK
//                      response.
//   malformed_response REACHABLE — D3 (wrong-length scores) and D3b
//                      (non-finite score), both via the structured .reason.
//                      NOT via the substring list below: that list is
//                      gemini-shaped, and rerank.js:311-316 records the bug
//                      growing it already caused.
//   network            REACHABLE — D4, and ONLY for a genuine transport throw
//                      (ECONNREFUSED / DNS / socket reset / unparseable body).
//                      The message stamp "local-reranker: network failure"
//                      is load-bearing: rerank-hermeticity-probe.mjs's
//                      DIAL_MARKER is that literal.
//   internal_error     REACHABLE backend-independently — the instruction /
//                      serialization build in rerankCandidates throws before
//                      any HTTP call (see the try/catch around
//                      buildRerankInstruction + serializeCandidateForRerank).
//                      Also the fall-through for any unclassified error, and
//                      for an unrecognised err.reason (D5).
//   api_key_missing    UNREACHABLE BY CONSTRUCTION, correctly so. It is a
//                      gemini-only gate: rerankCandidates skips the key
//                      short-circuit entirely when _localRerankerEnabled(),
//                      because the local Qwen3-Reranker needs no key. Nothing
//                      to fix — a local recall that reported a missing API key
//                      would be the dishonest outcome.
//   all_ids_unmatched  UNREACHABLE BY CONSTRUCTION, correctly so. It fires
//                      when a backend returns ids that are not in the input
//                      set; the local client builds its result by pairing the
//                      server's scores POSITIONALLY with the CALLER'S OWN ids
//                      (local-reranker-client.js: candidates.map((c,i) => ({
//                      id: c.id, ... }))), so it can never emit a foreign id.
//                      A shape failure surfaces as malformed_response instead.
// ---------------------------------------------------------------------------

// The frozen reason vocabulary. `http_<3 digits>` is the one parameterised
// member; everything else is a literal. Anything outside this set is NOT a
// reason — it is an unclassified error.
const _REASON_VOCABULARY = Object.freeze([
  "api_key_missing",
  "timeout",
  "network",
  "malformed_response",
  "all_ids_unmatched",
  "internal_error",
]);
const _REASON_SET = new Set(_REASON_VOCABULARY);
function _isKnownRerankReason(reason) {
  return _REASON_SET.has(reason) || /^http_\d{3}$/.test(reason);
}

function _classifyError(err) {
  if (!err) return "internal_error";

  // A backend that KNOWS what went wrong may say so structurally rather than
  // hoping a substring survives. Bounded on purpose: an unrecognised code
  // falls through to the rules below (it must never widen the histogram).
  if (typeof err.reason === "string" && _isKnownRerankReason(err.reason)) {
    return err.reason;
  }

  const msg = typeof err.message === "string" ? err.message : "";

  // AbortError from AbortSignal.timeout / our own race.
  if (err.name === "AbortError" || err.code === "ABORT_ERR") return "timeout";

  // HTTP status from gemini-flash-client._flashRequest.
  if (typeof err.statusCode === "number") {
    return `http_${err.statusCode}`;
  }

  if (msg.includes("GEMINI_API_KEY is not set")) return "api_key_missing";
  if (msg.includes("network failure")) return "network";

  // gemini-flash-client parse failures carry these substrings.
  if (
    msg.includes("ranking[") ||
    msg.includes("ranking[]") ||
    msg.includes("missing candidates[]") ||
    msg.includes("missing candidates[0].content.parts") ||
    msg.includes("no text part") ||
    msg.includes("not valid JSON despite responseSchema") ||
    msg.includes("not in input candidate set") ||
    msg.includes("appears more than once") ||
    msg.includes("rank_score must be a finite number")
  ) {
    return "malformed_response";
  }

  return "internal_error";
}

// ---------------------------------------------------------------------------
// Loud degrade (F1 memperf): every degraded:true return writes ONE stderr
// line per distinct reason per process, so silent Layer-3 collapse is
// impossible while repeated degrades (e.g. a persistent missing key) don't
// spam one line per recall. The taxonomy is finite (<= 7 codes), so
// once-per-distinct-reason never hides a NEW failure mode. `detail` must
// never contain key bytes or memory content.
// ---------------------------------------------------------------------------

const _degradeLoggedReasons = new Set();
function _logRerankDegradeOnce(reason, detail) {
  try {
    if (_degradeLoggedReasons.has(reason)) return;
    _degradeLoggedReasons.add(reason);
    process.stderr.write(
      "memory-recall rerank: DEGRADED reason=" +
        reason +
        " — Layer-3 rerank skipped, final_score order used" +
        (detail ? ": " + detail : "") +
        "\n"
    );
  } catch {
    // Logger throws must not propagate into the recall path.
  }
}

// Test seam: clear the once-per-process set so suites can assert emit counts.
export function _resetRerankDegradeLogForTests() {
  _degradeLoggedReasons.clear();
}

// ---------------------------------------------------------------------------
// Median helper (for partial-response patch)
// ---------------------------------------------------------------------------

function _median(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return 0;
  const sorted = nums.slice().sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Degraded-path builder: sort by final_score desc, take top OUTPUT_SIZE,
// rerank_score=null on every item.
// ---------------------------------------------------------------------------

function _buildDegradedReranked(input) {
  const sorted = input.slice().sort((a, b) => {
    const aS = a.score_components.final_score;
    const bS = b.score_components.final_score;
    if (bS !== aS) return bS - aS;
    return a.candidate.memory_id < b.candidate.memory_id ? -1 : 1;
  });
  return sorted.slice(0, RERANK_OUTPUT_SIZE).map((s, i) => ({
    memory_id: s.candidate.memory_id,
    final_score: s.score_components.final_score,
    rerank_score: null,
    rerank_position: i,
  }));
}

// ---------------------------------------------------------------------------
// rerankCandidates (top-level orchestration)
// ---------------------------------------------------------------------------
//
// Inputs:
//   surrounding_context: { current_query, recent_turns[], agent_role, time_anchor?, entities? }
//   candidates_with_scores: Array<{ candidate: IndexEntry, score_components: ScoreComponents }>
//                           — caller's responsibility to pre-sort by final_score desc.
//   opts.now?: ISO-8601 override for instruction time line.
//   opts.timeoutMs?: override of CAPS.RECALL_RERANK_TIMEOUT_MS (test hook).
//   opts.signal?: AbortSignal external hook (test hook).
//   opts._generateRanking?: function override for test mocking (defaults to
//                           imported generateRanking). Tests that override
//                           globalThis.fetch can leave this unset.
//
// Returns: { reranked, degraded, layer3_latency_ms, rerank_failed_reason }
//   per RerankResult shape (see contracts § 1).
export async function rerankCandidates({
  surrounding_context,
  candidates_with_scores,
  opts,
} = {}) {
  // Empty pool: trivial success, not a failure.
  if (!Array.isArray(candidates_with_scores) || candidates_with_scores.length === 0) {
    return _withAudit({
      reranked: [],
      degraded: false,
      layer3_latency_ms: 0,
      rerank_failed_reason: null,
    }, null);
  }

  // Truncate to top RECALL_RERANK_INPUT_SIZE. We assume caller sorted by
  // final_score desc per the contract; do a defensive slice anyway.
  const rerankInput = candidates_with_scores.slice(0, RERANK_INPUT_SIZE);

  const optsObj = opts || {};
  const timeoutMs =
    typeof optsObj.timeoutMs === "number" && Number.isFinite(optsObj.timeoutMs)
      ? optsObj.timeoutMs
      : RERANK_TIMEOUT_MS;
  const generateRankingFn =
    typeof optsObj._generateRanking === "function"
      ? optsObj._generateRanking
      : _resolveDefaultGenerateRanking();

  // Short-circuit: no usable gemini key. Do NOT issue any POST. Key presence
  // is resolved via the SHARED gemini-client.js key pool (GEMINI_API_KEYS
  // plural, or legacy GEMINI_API_KEY singular) — the same machinery the
  // embedding path uses — so the production pool-only env reranks. This gate
  // applies to the gemini backend ONLY — the local Qwen3-Reranker (CAPS/env
  // LOCAL_RERANKER_ENABLED) needs no gemini key, so skip the gate when it is
  // on. An injected _generateRanking (tests) still respects the gate: the
  // injection stands in for the gemini call, so no-key means it must not be
  // invoked (T7).
  if (!_localRerankerEnabled()) {
    let poolSize = 0;
    let poolErr = null;
    try {
      poolSize = geminiKeyPoolSize();
    } catch (e) {
      // Shape-validation throw (placeholder / malformed key): pool unusable.
      poolErr = e;
    }
    if (poolErr || poolSize === 0) {
      // poolErr.message carries only redacted key prefixes (gemini-client
      // redaction discipline) — never raw key bytes.
      _logRerankDegradeOnce(
        "api_key_missing",
        poolErr
          ? "key pool unusable: " + (poolErr.message || String(poolErr))
          : "neither GEMINI_API_KEYS nor GEMINI_API_KEY is set in env"
      );
      return _withAudit({
        reranked: _buildDegradedReranked(rerankInput),
        degraded: true,
        layer3_latency_ms: 0,
        rerank_failed_reason: "api_key_missing",
      }, null);
    }
  }

  const startNs = _nowNs();

  // Build instruction + serialized candidates.
  let instruction;
  let serialized;
  try {
    instruction = buildRerankInstruction({
      surrounding_context,
      candidates: rerankInput,
      opts: { now: optsObj.now },
    });
    serialized = rerankInput.map((s) =>
      serializeCandidateForRerank({
        entry: s.candidate,
        score_components: s.score_components,
      })
    );
  } catch (err) {
    _logRerankDegradeOnce(
      "internal_error",
      "instruction/candidate build failed: " +
        (err && err.message ? err.message : String(err))
    );
    return _withAudit({
      reranked: _buildDegradedReranked(rerankInput),
      degraded: true,
      layer3_latency_ms: _elapsedMs(startNs),
      rerank_failed_reason: "internal_error",
    }, null);
  }

  // Race the Flash call against a setTimeout, and — F1 (memperf) — thread an
  // AbortController signal into the backend so the timeout genuinely cancels
  // the in-flight HTTP request instead of leaking it. Known limitation:
  // injected test stubs and local-reranker-client.js destructure only what
  // they use, so backends that ignore `signal` still run to completion in
  // the background (the Promise.race still bounds OUR wait); the default
  // gemini path aborts for real. We never abort on success.
  //
  // e14 note, so the two defects are not conflated: that leak is a
  // CANCELLATION defect, left OPEN for a follow-up. It is not a taxonomy one —
  // this race's own rejection is already name="AbortError", so an outer
  // timeout has always classified as "timeout" and still does. What e14 fixed
  // is the LOCAL CLIENT's own timer, which used to be rewrapped as "network".
  // On the local path that inner timer (8000ms) always fires before this outer
  // race (CAPS.RECALL_RERANK_TIMEOUT_MS = 15000), so this race is effectively
  // dead code there; see the measured budget at local-reranker-client.js's
  // DEFAULT_TIMEOUT_MS.
  let response;
  const controller = new AbortController();
  try {
    const ranking = generateRankingFn({
      instruction,
      candidates: serialized,
      signal: controller.signal,
    });
    let timeoutHandle;
    const timeoutPromise = new Promise((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        // Abort the underlying request BEFORE rejecting so the HTTP attempt
        // is torn down rather than left running in the background.
        controller.abort();
        const e = new Error(`rerank: Flash call exceeded ${timeoutMs}ms`);
        e.name = "AbortError";
        reject(e);
      }, timeoutMs);
      // Allow process to exit if this is the only outstanding handle.
      if (timeoutHandle && typeof timeoutHandle.unref === "function") {
        timeoutHandle.unref();
      }
    });
    try {
      response = await Promise.race([ranking, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  } catch (err) {
    const reason = _classifyError(err);
    _logRerankDegradeOnce(
      reason,
      err && err.message ? String(err.message).slice(0, 200) : String(err)
    );
    return _withAudit({
      reranked: _buildDegradedReranked(rerankInput),
      degraded: true,
      layer3_latency_ms: _elapsedMs(startNs),
      rerank_failed_reason: reason,
    }, instruction);
  }

  // Defensive shape check on the response (the client already enforces this,
  // but the failure mode here is identical to malformed_response).
  if (!Array.isArray(response)) {
    _logRerankDegradeOnce(
      "malformed_response",
      "ranking backend returned a non-array response"
    );
    return _withAudit({
      reranked: _buildDegradedReranked(rerankInput),
      degraded: true,
      layer3_latency_ms: _elapsedMs(startNs),
      rerank_failed_reason: "malformed_response",
    }, instruction);
  }

  // Build response_map (id -> rank_score), filtering to the input id set.
  const inputIdSet = new Set(rerankInput.map((s) => s.candidate.memory_id));
  const responseById = new Map();
  const responseScores = [];
  for (const r of response) {
    if (!r || typeof r.id !== "string") continue;
    if (!inputIdSet.has(r.id)) continue; // ignore unmatched ids
    if (responseById.has(r.id)) continue; // ignore duplicates
    if (typeof r.rank_score !== "number" || !Number.isFinite(r.rank_score)) continue;
    responseById.set(r.id, r.rank_score);
    responseScores.push(r.rank_score);
  }

  // All ids unmatched (response was for a different set entirely).
  if (responseById.size === 0) {
    _logRerankDegradeOnce(
      "all_ids_unmatched",
      "no response id matched the input candidate id set"
    );
    return _withAudit({
      reranked: _buildDegradedReranked(rerankInput),
      degraded: true,
      layer3_latency_ms: _elapsedMs(startNs),
      rerank_failed_reason: "all_ids_unmatched",
    }, instruction);
  }

  // Partial-response patch (CRITICAL-1 hot-fix post round-19 brutalist):
  // when Flash returns scores for only some input ids, the omitted ids must
  // fall BELOW every explicitly-scored id. Previous behavior used the MEDIAN
  // of returned scores, which mechanically lifted Flash-omitted candidates
  // above the lowest explicit scores — exactly inverting Flash's signal.
  // The corrected semantic: floor-fill = (min of returned scores) - epsilon,
  // so omitted candidates rank below the lowest score Flash explicitly assigned.
  // Epsilon is half the smallest representable gap on the [0,1] grid Flash
  // produces, in practice 1e-6 — small enough to not collide with explicit
  // scores at finite precision, large enough to survive numeric noise.
  // See kb/phase3-v1-rerank-contracts.md § 5 (partial-response semantics).
  const minResponseScore = Math.min(...responseScores);
  const FLOOR_FILL_EPSILON = 1e-6;
  const floorFillScore = minResponseScore - FLOOR_FILL_EPSILON;

  // Build pre-sort list of every input candidate with an attached rank_score.
  const annotated = rerankInput.map((s) => ({
    memory_id: s.candidate.memory_id,
    final_score: s.score_components.final_score,
    rerank_score: responseById.has(s.candidate.memory_id)
      ? responseById.get(s.candidate.memory_id)
      : floorFillScore,
  }));

  // Sort by rerank_score desc; tie-break: final_score desc, then memory_id asc
  // (same tiebreak as Layer-2 sort in recall.js so behavior is consistent).
  annotated.sort((a, b) => {
    if (b.rerank_score !== a.rerank_score) return b.rerank_score - a.rerank_score;
    if (b.final_score !== a.final_score) return b.final_score - a.final_score;
    return a.memory_id < b.memory_id ? -1 : 1;
  });

  // Truncate to RECALL_RERANK_OUTPUT_SIZE; assign rerank_position 0..N-1.
  const reranked = annotated.slice(0, RERANK_OUTPUT_SIZE).map((r, i) => ({
    memory_id: r.memory_id,
    final_score: r.final_score,
    rerank_score: r.rerank_score,
    rerank_position: i,
  }));

  return _withAudit({
    reranked,
    degraded: false,
    layer3_latency_ms: _elapsedMs(startNs),
    rerank_failed_reason: null,
  }, instruction);
}

// ---------------------------------------------------------------------------
// Exposed for tests that need to introspect knobs without re-importing CAPS.
// ---------------------------------------------------------------------------
export const RERANK_CONSTANTS = Object.freeze({
  RERANK_INPUT_SIZE,
  RERANK_OUTPUT_SIZE,
  RERANK_TIMEOUT_MS,
  RERANK_CONTENT_EXCERPT_CHARS,
  MAX_INSTRUCTION_CHARS,
  TURN_CONTENT_CHARS,
});
