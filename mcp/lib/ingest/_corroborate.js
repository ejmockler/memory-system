// _corroborate.js — R25 salience cascade Layer 3 surface.
//
// OWNERSHIP CONTRACT
//   This module owns the *embed + kNN + corroboration-or-promote decision*
//   surface that salience.js (owned by sibling A1) calls during a single
//   pass of scoreCandidate(). A1 owns:
//     - the Stage-0 dispatch wiring (sibling A2)
//     - the Layer-2 6-component scoring (A1 core)
//     - the orchestration that decides DROP / PASS-to-Layer-3
//   This file owns:
//     - the embed call (single embedSingle invocation; never two)
//     - the kNN lookup via _hnsw.js
//     - the corroboration-threshold branch
//     - the novelty component (when not corroborating)
//     - the incremental appendToIndex side-effect on PROMOTE
//
// USAGE PATTERN (the contract A1's scoreCandidate honors):
//
//   import { corroborateOrPromote } from "./_corroborate.js";
//
//   const { decision, ... } = await corroborateOrPromote({
//     event,                  // { id, content, source, ... }
//     indexHandle,            // open kNN handle from _hnsw.js
//     thresholds,             // CAPS.CORROBORATE_THRESHOLD
//     embeddingModelVersion,  // CAPS.ACTIVE_EMBED_MODEL_VERSION (l14: the
//                             // embed backend is local-embedder-client.js)
//     opts,                   // { embed, knnK, now, audit, logger }
//   });
//
//   if (decision === "CORROBORATE") {
//     // emit policy.corroboration (the caller is responsible for the
//     // append-to-policy-events-log side; we return the event payload).
//     return { decision: "CORROBORATE", target_id, source_ref, ... };
//   } else {
//     // append to memory.jsonl with features.salience.components.novelty
//     return { decision: "PROMOTE", novelty, embedding_4096, ... };
//   }
//
// KEY INVARIANT: embedSingle is called EXACTLY ONCE per candidate. The
// returned vector is reused for (a) the kNN query AND (b) the appendToIndex
// side-effect on PROMOTE. No double-embed. (l14: that vector is now the local
// client's 4096-dim vector, not a 768-dim MRL slice — see STATUS block below.)
//
// NOVELTY CONVENTION
//   The recall-layer HnswIndex returns cosine_distance = 1 - dot for
//   unit-norm vectors. For unit-norm dot products that range is [-1, 1] so
//   cosine_distance ∈ [0, 2]. The workflow brief says:
//
//     "novelty = max(0, min(1, neighbors[0].cosine_distance / 2)) for
//      index-stability across embedding magnitudes"
//
//   That is what we use. Worth noting: in practice Gemini embeddings are
//   semantically clustered so cosine_distance > 1 (anti-correlated vectors)
//   is rare; the /2 normalizer is a stable mapping not a tight bound.
//   The clamp to [0,1] is purely defensive.
//
// EMPTY-INDEX CASE
//   When the kNN index has zero entries (first fact ever in memory.jsonl),
//   _hnsw.knn() returns []. We treat that as max-novelty (novelty = 1.0)
//   and never corroborate — the first promote is always the cluster anchor
//   per the design's "no canonical-anchor swap" guarantee.
//
// EMBED FAILURE
//   If opts.embed throws (local embed server unreachable / mis-shaped ->
//   LocalEmbedUnavailableError from local-embedder-client.js), we propagate
//   the error. The salience cascade does NOT silently skip embed; the caller is
//   responsible for backpressure / retry. Documented at design doc §
//   "Embedding rate-limit handling". NOTE: no gemini error class is caught in
//   this file — the only catch surface is the caller's — so the l14 backend
//   swap moved no catch surface.
//
// ---------------------------------------------------------------------------
// STATUS AS MEASURED BY l14-embed-callers-migrate, corrected by l16 — READ
// BEFORE PUTTING THIS MODULE INTO PRODUCTION. Two facts, each re-derivable:
//
//   1. ZERO PRODUCTION IMPORTERS. A tree-wide import-shape query (matching
//      `from "<path>_corroborate.js"` and `import("<path>_corroborate.js")`,
//      multiline, excluding node_modules) resolves to exactly TWO importing
//      files, and BOTH are tests:
//        - mcp/test/ingest/salience-knn-backend.test.mjs:30-31
//        - mcp/test/embed-callers-migrate.test.mjs:132
//      (A single-line regex misses the first: its `await import(` and the path
//      sit on separate lines. Query multiline or you will undercount.)
//      salience.js mentions corroborateOrPromote only in a comment; it does
//      NOT import it. So corroborateOrPromote is dead in production and
//      defaultEmbed — reachable only when a caller omits opts.embed — is
//      therefore unreachable in production.
//
//   2. A FUTURE PRODUCTION CALLER MUST CONFIGURE _hnsw FOR 4096 DIMS.
//      _hnsw.js's `dims` defaults to DEFAULT_MRL_DIMS (768); the indexHandle
//      this module is handed must be opened at 4096 or the kNN compares
//      mismatched geometry. Not changed here — _hnsw.js is out of l14's remit
//      and has other callers.
// ---------------------------------------------------------------------------

import { embedSingle } from "../local-embedder-client.js";
import { knn, appendToIndex } from "./_hnsw.js";

const DEFAULT_KNN_K = 8;
const DEFAULT_TASK_TYPE = "RETRIEVAL_DOCUMENT";
const SALIENCE_VERSION_DEFAULT = "v1";

// ---------------------------------------------------------------------------
// Threshold lookup with explicit per-source contract. Returns the cosine-
// distance threshold below which a candidate is considered "near-duplicate"
// of its nearest neighbor and routed to CORROBORATE instead of PROMOTE.
// ---------------------------------------------------------------------------

function thresholdFor(thresholds, source) {
  if (!thresholds || typeof thresholds !== "object") {
    throw new Error(
      "corroborateOrPromote: thresholds map is required (typically CAPS.CORROBORATE_THRESHOLD)"
    );
  }
  if (!Object.prototype.hasOwnProperty.call(thresholds, source)) {
    throw new Error(
      `corroborateOrPromote: no CORROBORATE_THRESHOLD entry for source "${source}"`
    );
  }
  const t = thresholds[source];
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > 2) {
    throw new Error(
      `corroborateOrPromote: invalid threshold ${t} for source "${source}" (must be finite number in [0,2])`
    );
  }
  return t;
}

// ---------------------------------------------------------------------------
// Default embed adapter — uses the production embedSingle. Tests inject a
// deterministic stub via opts.embed.
// ---------------------------------------------------------------------------

// l14-embed-callers-migrate — repointed from gemini-client.embedSingle to
// local-embedder-client.embedSingle. The two signatures do NOT match (gemini:
// {text,taskType,dims,source}; local: {text,isQuery}), so the call and the
// result read are repointed together: local returns { vector_4096,
// embedding_model_version } and has no vector_mrl_renormalized field.
//
// The DEFAULT_TASK_TYPE constant above ("RETRIEVAL_DOCUMENT") maps to
// isQuery:false. Evidence
// from the two call sites that fix the polarity in this tree:
//   - mcp/lib/tools/recall.js, the local-query-embed branch's
//     `embedSingle({ text: localQueryText, isQuery: true })` — a recall QUERY
//   - daemons/watermark.js, `localEmbedBatch({ items, isQuery: false })` —
//     ingest DOCUMENTS
// This function embeds a candidate for a kNN against the DOCUMENT-side index,
// so it takes the document polarity.
//
// The F-NEW-W4-EMBED-COST-WIRING source:"corroborate" attribution is gone with
// the gemini client (local-embedder-client.js does not call recordEmbedCall).
// That counter was ALREADY structurally zero: corroborateOrPromote has no
// production importer (see module header), so this function is unreachable.
async function defaultEmbed(text) {
  const r = await embedSingle({ text, isQuery: false });
  return {
    vector: r.vector_4096,
    embedding_model_version: r.embedding_model_version,
  };
}

// ---------------------------------------------------------------------------
// Main entry point. Returns one of:
//
//   { decision: "CORROBORATE", target_id, source_ref, cosine_distance,
//     embedding_model_version, embedding_4096, policy_event, version }
//
//   { decision: "PROMOTE", novelty, neighbors, embedding_model_version,
//     embedding_4096, version, appended_to_index: true }
//
// The vector key is named embedding_4096 because that is what it is: post-l14
// defaultEmbed returns local-embedder-client's full 4096-dim vector, never a
// 768-dim MRL slice. (Renamed by l16 from embedding_mrl_768. Safe: both
// importing files are tests and NEITHER reads this key off the return —
// `rg 'embedding_mrl_768|embedding_4096' mcp/test/ingest/salience-knn-backend.test.mjs`
// is empty, and embed-callers-migrate.test.mjs's hits are all on
// features.embedding_* read off ledger rows. Unrelated to the still-real
// 768-dim features.embedding_mrl_768 on the legacy Gemini path in
// distill-promote-fact.js and ctx.embedding_mrl_768 in salience.js.)
//
// The caller (salience.js orchestrator) feeds `novelty` into the Layer-2
// components.novelty slot, takes `embedding_4096` as the value to persist
// on the fact row, and (on CORROBORATE) appends `policy_event` to the
// policy-events ledger.
// ---------------------------------------------------------------------------

export async function corroborateOrPromote({
  event,
  indexHandle,
  thresholds,
  embeddingModelVersion, // optional — used for cross-check against embed
  opts,
} = {}) {
  if (!event || typeof event !== "object") {
    throw new Error("corroborateOrPromote: event must be an object");
  }
  if (typeof event.id !== "string" || event.id.length === 0) {
    throw new Error("corroborateOrPromote: event.id must be a non-empty string");
  }
  if (typeof event.content !== "string" || event.content.length === 0) {
    throw new Error("corroborateOrPromote: event.content must be a non-empty string");
  }
  if (typeof event.source !== "string" || event.source.length === 0) {
    throw new Error("corroborateOrPromote: event.source must be a non-empty string");
  }
  if (!indexHandle) {
    throw new Error("corroborateOrPromote: indexHandle is required");
  }

  const cfg = opts || {};
  const embed = typeof cfg.embed === "function" ? cfg.embed : defaultEmbed;
  const knnK = Number.isInteger(cfg.knnK) && cfg.knnK > 0 ? cfg.knnK : DEFAULT_KNN_K;
  const version = typeof cfg.version === "string" ? cfg.version : SALIENCE_VERSION_DEFAULT;
  const now = typeof cfg.now === "function" ? cfg.now : () => new Date().toISOString();

  const threshold = thresholdFor(thresholds, event.source);

  // 1. Embed ONCE.
  const embedResult = await embed(event.content);
  const vec = embedResult && embedResult.vector;
  if (!vec || typeof vec.length !== "number") {
    throw new Error(
      "corroborateOrPromote: embed() must return { vector: Array<number>, embedding_model_version }"
    );
  }
  const emv = embedResult.embedding_model_version;
  if (
    embeddingModelVersion != null &&
    typeof emv === "string" &&
    emv !== embeddingModelVersion
  ) {
    throw new Error(
      `corroborateOrPromote: embed returned embedding_model_version "${emv}" but caller expected "${embeddingModelVersion}"`
    );
  }

  // 2. kNN lookup. Empty index → first-fact-ever max-novelty path.
  const neighbors = knn(indexHandle, vec, knnK);

  if (neighbors.length === 0) {
    appendToIndex(indexHandle, event.id, vec);
    return {
      decision: "PROMOTE",
      novelty: 1.0,
      neighbors: [],
      embedding_model_version: emv,
      embedding_4096: vec,
      version,
      appended_to_index: true,
    };
  }

  const nearest = neighbors[0];

  // 3. Corroboration branch.
  if (nearest.cosine_distance < threshold) {
    const policy_event = {
      type: "policy.corroboration",
      ts: now(),
      target_memory_id: nearest.id,
      source_ref: {
        source: event.source,
        source_msg_id: event.id,
      },
      cosine_distance: nearest.cosine_distance,
      threshold,
      version,
    };
    return {
      decision: "CORROBORATE",
      target_id: nearest.id,
      source_ref: policy_event.source_ref,
      cosine_distance: nearest.cosine_distance,
      threshold,
      embedding_model_version: emv,
      embedding_4096: vec,
      policy_event,
      version,
    };
  }

  // 4. PROMOTE branch — compute novelty, append to index, return.
  // Novelty formula per workflow brief:
  //   cosine_distance ∈ [0, 2]; novelty = clamp(distance / 2, [0, 1])
  // Documented above at module header.
  const raw = nearest.cosine_distance / 2;
  const novelty = raw < 0 ? 0 : raw > 1 ? 1 : raw;

  appendToIndex(indexHandle, event.id, vec);

  return {
    decision: "PROMOTE",
    novelty,
    neighbors,
    embedding_model_version: emv,
    embedding_4096: vec,
    version,
    appended_to_index: true,
  };
}

// ---------------------------------------------------------------------------
// Convenience exports for tests + salience.js inspection.
// ---------------------------------------------------------------------------

export const CORROBORATE_INTERNALS = Object.freeze({
  DEFAULT_KNN_K,
  DEFAULT_TASK_TYPE,
  SALIENCE_VERSION_DEFAULT,
  defaultEmbed,
  thresholdFor,
});
