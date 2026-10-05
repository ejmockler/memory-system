// Input validation helpers. Throw ToolError(INVALID_ARGUMENTS) on failure;
// dispatch converts to envelope.

import { createHash } from "node:crypto";
import { ERROR_CODES, ToolError } from "./error-codes.js";

// Caps from kb/mcp-surface.md § Caps.
export const CAPS = Object.freeze({
  RECALL_MAX_ITEMS: 12,
  RECALL_MAX_CHARS: 4000,
  RECALL_PER_MEMORY_CONTENT_CHARS: 600,
  RECALL_LOG_TTL_SECONDS: 86400,
  PREDICATE_MAX_ENTITIES: 32,
  PREDICATE_MAX_EMBEDDING_DIMS: 1536,
  PREDICATE_MAX_ACTIVE: 1024,
  REPLACE_NEW_EVENT_CONTENT_CHARS: 4000,
  SUBSTITUTE_TRANSFORM_CHARS: 4000,
  CONTENT_MAX_CHARS: 16384,
  DERIVATION_WALK_MAX_DEPTH: 6,
  DERIVATION_WALK_MAX_NODES: 64,
  EXCISE_REDERIVE_MAX_NODES: 64,
  CONSUMED_NONCE_TTL_SECONDS: 604800,
  STALE_LOCK_RECOVERY_SECONDS: 60,
  LIST_PREDICATES_MAX_ITEMS: 100,
  LIST_QUARANTINE_MAX_ITEMS: 50,
  LIST_CONNECTORS_MAX_ITEMS: 32,
  RECALL_RECENT_TURNS_MAX: 8,
  RECALL_TURN_CONTENT_CHARS: 2000,
  RECALL_CURRENT_QUERY_CHARS: 2000,
  RECALL_RECENT_RECALL_IDS_MAX: 16,
  // RECALL_RECENT_SURFACED_DAMPING_FACTOR — multiplier applied to the
  // final_score of a candidate that was ALREADY SURFACED by one of the
  // recalls named in surrounding_context.recent_recall_ids (the spec's "for
  // damping" annotation, kb/mcp-surface.md § memory_recall). 1.0 disables.
  // This is damping, not paging: the brief stays a one-shot projection; a
  // memory the agent has just been shown merely has to out-score fresh
  // candidates by 4x to be shown again. Resolution goes through the
  // in-process recall log (RECALL_LOG_TTL_SECONDS), so ids from a prior
  // server process resolve to nothing and damp nothing.
  RECALL_RECENT_SURFACED_DAMPING_FACTOR: 0.25,
  RATIONALE_CHARS: 500,
  PREDICATE_MIN_EMBEDDING_DIMS: 16,
  // CHAT_LEDGER_TAIL_READ_MAX_BYTES: bounded tail-read in stop-hook.sh for
  // prev_source_msg_id lookup. See kb/agent-integration.md § stop-hook.sh.
  // F-T2-CHAT_CLAUDE-CODE-F5 / F8 — raised from 256 KiB → 2 MiB. The 256 KiB
  // cap caused prev_source_msg_id chain forks on sessions >256 KB (audit
  // counted 17+ tail_read_budget_exhausted events in hook-errors.jsonl over a
  // single day). 2 MiB covers the observed ledger growth pattern (typical
  // working-day session ledgers crest ~400 KB; long sessions hit ~1.5 MB)
  // while keeping the read budget bounded to ~5-10 ms on a fast SSD. Both
  // hooks (stop-hook.sh + session-end-hook.sh) consult this CAP via env-var
  // injection at hook invocation; the bash side passes
  // CHAT_LEDGER_TAIL_READ_MAX_BYTES into the node block to avoid drift.
  CHAT_LEDGER_TAIL_READ_MAX_BYTES: 2 * 1024 * 1024,
  // INFLIGHT_RECLAIM_AGE_SECONDS: in_flight[] entries older than this with no
  // matching pending/in-flight queue file are reclaimed. See
  // kb/agent-integration.md § Watermark daemon → State file.
  INFLIGHT_RECLAIM_AGE_SECONDS: 60,
  // -----------------------------------------------------------------------
  // Phase 3 v0 (recall layer) caps. Authoritative shape contract:
  // kb/phase3-v0-contracts.md. Spec source: kb/research-retrieval-frontiers.md.
  // Do NOT change values without updating the contract file in lockstep.
  // -----------------------------------------------------------------------
  // Gemini embedding model + dims. v0 pins to gemini-embedding-001 only;
  // gemini-embedding-2 silently ignores taskType (Phase A verified).
  GEMINI_EMBEDDING_MODEL_DEFAULT: "gemini-embedding-001",
  GEMINI_EMBEDDING_DIMS_FULL: 3072,
  GEMINI_EMBEDDING_DIMS_MRL: 768,
  // -----------------------------------------------------------------------
  // WU1-local-embedder-client-and-dim4096 — local Qwen3 embedding backend.
  //
  // The operator chose FULL 4096 dims (no MRL truncation): an Apple-silicon
  // (MPS) host handles a 4096-dim HNSW index, and full fidelity is preferred over
  // the storage savings MRL slicing would buy. The local embed server
  // (lib/local-embedder-client.js -> http://127.0.0.1:8359/embed) returns
  // 4096-float L2-unit-normalized vectors from Qwen/Qwen3-Embedding-8B (fp16).
  //
  // EMBEDDING_DIM_4096 is the full local-model dimension. ACTIVE_EMBED_MODEL
  // _VERSION is the model-versioned identifier stamped onto every locally
  // embedded fact (features.embedding_model_version) AND used as the
  // per-model index directory name (indices/<version>/). The index-dir name
  // IS the model-version string by invariant (loadIndices/saveIndices key the
  // dir off it), so the new tree is indices/qwen3-embedding-8b-fp16/ — sitting
  // next to the existing indices/gemini-embedding-001/ tree. The old Gemini
  // index dir is an orphaned
  // projection (thesis #1: ledger permanent; indices are derived) and is NOT
  // deleted by this WU. WU2 retires the Gemini machinery; this WU only adds
  // the local backend so both coexist this phase.
  EMBEDDING_DIM_4096: 4096,
  ACTIVE_EMBED_MODEL_VERSION: "qwen3-embedding-8b-fp16",
  // Phase 3 v1 Layer-3 listwise reranker model. The stable alias is itself
  // the pinned identifier in Google's current discipline (its `version:"001"`
  // field is constant for the alias). No dated snapshot exists on v1beta as
  // of 2026-06-02; the PINNED_SNAPSHOT field mirrors the alias today and is
  // the forward seam for when Google publishes a `gemini-2.5-flash-XX-2025`
  // tag. Authoritative: kb/phase3-v1-reranker-model.md. Do NOT swap to
  // gemini-flash-latest (rolls forward with 2-week notice — silent break of
  // the listwise JSON contract is the failure mode this pinning prevents).
  GEMINI_FLASH_MODEL_DEFAULT: "gemini-2.5-flash",
  GEMINI_FLASH_PINNED_SNAPSHOT: "gemini-2.5-flash",
  // Listwise-rerank generationConfig knobs (load-bearing per
  // kb/phase3-v1-reranker-model.md § "API URL + request body template").
  // thinkingBudget MUST be 0 — without it 2.5-flash spends ~95 reasoning
  // tokens with no measured ranking-quality gain and triples end-to-end p50.
  GEMINI_FLASH_RERANK_THINKING_BUDGET: 0,
  GEMINI_FLASH_RERANK_TEMPERATURE: 0.0,
  GEMINI_FLASH_RERANK_MAX_OUTPUT_TOKENS: 1024,
  // Brief envelope caps (final surfaced result from recall.js).
  RECALL_BRIEF_MAX_ITEMS: 12,
  RECALL_BRIEF_MAX_CHARS_TOTAL: 4000,
  RECALL_BRIEF_MAX_CHARS_PER_ITEM: 600,
  // Pre-truncation candidate set size for the recall-log substrate.
  RECALL_CANDIDATE_SET_SIZE: 50,
  // Reciprocal Rank Fusion constant (Cormack/Clarke/Buettcher 2009).
  RRF_K: 60,
  // WU-RR1 — BM25 full-rebuild trigger threshold. The daemon counts facts
  // added since the last rebuild via the policy.bm25_index_rebuild event
  // on memory.jsonl; when that delta crosses this threshold the next idle
  // tick schedules a one-shot rebuild from the canonical ledger
  // (mcp/scripts/rebuild-bm25-index.mjs / lib/recall/bm25-rebuild.js).
  // 5000 chosen as a compromise: small enough that recall drift stays
  // bounded (≤5000 missing facts in BM25's inverted index between rebuilds)
  // and large enough that the rebuild cost (full ledger stream + write)
  // amortizes across many promotes. Set to 0 to disable the auto-trigger
  // entirely; the script form remains callable for hand-runs.
  BM25_REBUILD_THRESHOLD: 5000,
  // WU1-context-prefix-and-contextual-bm25 — contextual BM25 kill-switch.
  // When true, the BM25 rebuild concatenates a deterministic context prefix
  // (lib/recall/context-prefix.js buildContextPrefix) onto each fact's content
  // BEFORE tokenization: "Conversation: <label>. Source: <s>. Entities: <...>.
  // Date: <d>.\n\n<content>". This is contextual retrieval (Anthropic-cookbook
  // style) adapted to a fully-local, deterministic, additive-BM25 setting: a
  // query term the fact omitted via anaphor (a project / entity / date the
  // human referred to by pronoun) becomes BM25-matchable through the prefix.
  // We CONCATENATE into the single tokenized field rather than the cookbook's
  // two-field MAX because our BM25 score is an additive sum over query terms,
  // so a prefix-only match and a content match ADD (strictly more recall than
  // a max). DEFAULT false — eval-first: we build baseline (off) vs contextual
  // (on) indices for an A/B and only flip the default once the offline eval
  // proves lift. The prefix adds ~10-15 tokens/doc; BM25 length-norm (b=0.75)
  // absorbs it because avgdl grows in lockstep (see context-prefix.js header).
  CONTEXTUAL_BM25_ENABLED: false,
  // N5-contextual-retrieval — contextual DENSE (embedding) kill-switch. Mirrors
  // CONTEXTUAL_BM25_ENABLED above for the situate-then-embed dense leg
  // (Anthropic-cookbook "contextual embeddings", adapted fully-local +
  // deterministic). When true, the dense re-embed path
  // (scripts/reembed-local-4096.mjs) prefixes each fact's text with the SAME
  // deterministic buildContextPrefix (lib/recall/context-prefix.js) the BM25
  // rebuild uses — "Conversation: <label>. Source: <s>. Entities: <...>. Date:
  // <d>.\n\n<content>" — BEFORE chunking, so chunk #0 carries the situating
  // context and the embedding sits near queries that name the thread / project /
  // entity / date the atomic fact omitted via anaphor. The prefixed vectors are
  // written to a PARALLEL indices/<model>-contextual/ tree (sidecar + HNSW); the
  // baseline tree is never touched (thesis #1 — derived, deletable projection).
  // DEFAULT false — eval-first, identical discipline to the BM25 cap: we build
  // baseline (off) vs contextual (on) HNSW trees for an A/B and only flip the
  // default once the offline failure-rate eval proves dense lift. The prefix is
  // bounded to ~40 tokens (context-prefix.js PREFIX_MAX_TOKENS); WINDOW=7200
  // chars (~1800 tokens) + 40 < the 2048-token server cap, so chunk #0 never
  // overflows the embed window. OFF => byte-identical embedded text to today.
  CONTEXTUAL_DENSE_ENABLED: false,
  // WU-RR2 — substrate-aware Layer-1c fallback. When the BM25 + HNSW union
  // produces fewer than RECALL_SUBSTRATE_FALLBACK_TRIGGER_THRESHOLD unique
  // candidates AND the populator extracted any entities from the surrounding
  // context, recall falls back to scanning features.entities via the
  // substrate entity-index (canonical_id -> [memory_id]) and merges those
  // ids into the candidate pool (deduped, capped at
  // RECALL_SUBSTRATE_FALLBACK_MAX_CANDIDATES). Rationale: 99.9% of facts
  // currently have features.embedding=null because Gemini quota blocks the
  // backfill, so HNSW is mostly empty. The substrate has 88.7% entity
  // coverage on 1.4M facts; recall just wasn't using it for candidate
  // selection. When indices return enough candidates the fallback never
  // fires (no perf regression). Authoritative: kb/architecture.md § indices
  // are derived from the ledger, never authoritative; treat as cache.
  RECALL_SUBSTRATE_FALLBACK_TRIGGER_THRESHOLD: 5,
  RECALL_SUBSTRATE_FALLBACK_MAX_CANDIDATES: 50,
  // WORKUNIT N8 — temporal substrate fallback (the time-index WIRE slot). The
  // exact mirror of the entity-index fallback above: when the BM25 + HNSW union
  // produces fewer than RECALL_SUBSTRATE_FALLBACK_TRIGGER_THRESHOLD unique
  // candidates AND the populator resolved an absolute time anchor from the
  // surrounding context, recall augments the candidate pool with memory_ids
  // whose features.time_anchors[] fall within RECALL_TIME_FALLBACK_WINDOW_MS of
  // the resolved anchor (via the cached substrate-tier time-index — a sorted
  // projection over absolute instants rebuilt under the SAME mtime+size
  // fingerprint discipline as the entity-index, NOT a fresh full-ledger scan).
  // The fallback is candidate-RECALL only: it never touches scoring, so it does
  // NOT double-count the w_t1*time_anchor_match channel (that stays owned by
  // multi-feature-score). 30 days is the v0 proximity window; an absent/stale
  // time-index cache rebuilds-or-skips and the fallback is a no-op.
  RECALL_TIME_FALLBACK_WINDOW_MS: 30 * 24 * 60 * 60 * 1000,
  // e15-recall-temporal-scoping — the age threshold that separates the brief's
  // `freshness: "fresh"` from `"stale"`. Read by ONE producer,
  // multi-feature-score.js `freshnessLabel`, which is called from exactly one
  // site (lib/tools/recall.js, the memories[] projection). Deliberately reuses
  // the SAME 30-day temporal scale this subsystem already pins for
  // RECALL_TIME_FALLBACK_WINDOW_MS directly above rather than inventing a
  // second, unrelated notion of "recent" for the same recall path.
  // NOT in capsSnapshot()'s allow-list (lib/recall/rerank.js) — that snapshot
  // is an explicit list, so adding this value here leaves every already-written
  // caps_snapshot block in ledgers/recall.jsonl comparable to new ones.
  RECALL_FRESHNESS_STALE_AFTER_MS: 30 * 24 * 60 * 60 * 1000,
  // WORKUNIT N8 — memory_put gate. The operator-facing direct memory-write tool
  // (memory_put) is DARK BY DEFAULT on a configured install: with this flag
  // false the handler returns SCOPE_BLOCKED and writes NO ledger row and NO
  // policy event. Flip to true (env MEMORY_PUT_ENABLED=1 also flips it via the
  // handler's env read) to let an agent-role caller record an operator-authored
  // fact directly through the appendFactRow chokepoint. Distinct from
  // MEMORY_ROLE=distillation gating: memory_put is first-party, needs NO daemon
  // token, and asserts consent_basis="first_party".
  // The actual rule (tools/put.js putEnabled): with this flag false and the env
  // var unset, put is on ONLY for a standalone first run with no vector index
  // (not a queryd client AND no vector index on disk for the active model; a
  // refused, truncated or unreadable index does not count); otherwise set
  // MEMORY_PUT_ENABLED=1. MEMORY_PUT_ENABLED=0 forces it off everywhere.
  MEMORY_PUT_ENABLED: false,
  // MMR lambda; relevance vs. redundancy trade. 0.7 (NOT LangChain default 0.5).
  MMR_LAMBDA_DEFAULT: 0.7,
  // Density-flag thresholds.
  DENSITY_FLAG_PAIRWISE_COSINE_THRESHOLD: 0.85,
  // Propensity (Plackett-Luce softmax) discipline.
  PROPENSITY_TEMPERATURE_TAU_DEFAULT: 0.3,
  PROPENSITY_JITTER_FRACTION: 0.05,
  // Power-law forgetting curve per Wixted & Ebbesen 1997: m*(1+h*t)^(-f).
  // Per-kind f exponents.
  POWER_LAW_F_FACT: 0.15,
  POWER_LAW_F_EPISODIC: 0.35,
  POWER_LAW_F_AMBIENT: 0.6,
  POWER_LAW_M_DEFAULT: 1.0,
  POWER_LAW_H_DEFAULT: 1.0,
  // Multi-feature soft-add weights (multiplicative gates wrap these).
  SCORE_WEIGHT_ENTITY_OVERLAP: 0.7,
  SCORE_WEIGHT_TIME_ANCHOR: 1.5,
  SCORE_WEIGHT_TIME_DECAY: 0.3,
  SCORE_WEIGHT_VALENCE: 0.2,
  // Engagement prior: 0 in v0; updates from recall-log learning in v3.
  SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.0,
  // W12 mutual-cycle closure (F-SYN-BEHAVIOR-damping-from-recall-log +
  // F-SYN-BEHAVIOR-corroboration-propagation) — additive PRIORS that consume
  // bounded scalars from damping-reader.js + corroboration-propagator.js.
  // Both default to 0.0 so existing call sites that don't pass the scalars
  // see no behavior change. The calibration loop owns the version-bump path.
  // Authoritative bounds:
  //   damping_coefficient   ∈ [DAMPING_CAPS.MIN_COEF, DAMPING_CAPS.MAX_COEF]
  //                              = [0.5, 1.5]
  //   corroboration_boost   ∈ [CORROBORATION_CAPS.BASE,
  //                            CORROBORATION_CAPS.MAX_BOOST] = [1.0, 1.3]
  SCORE_WEIGHT_DAMPING_PRIOR: 0.0,
  SCORE_WEIGHT_CORROBORATION_PRIOR: 0.0,
  // N6-stamp-priors: master switch for stamping candidate.priors
  // {damping_coefficient, corroboration_boost} + the engagementPriorById map at
  // recall time. Default ON: the three SCORE_WEIGHT_*_PRIOR weights above are
  // still 0.0, so stamping NON-neutral priors is a ranking no-op until the
  // calibration loop (N1) flips a weight off 0.0 under its reviewed/harm-safe
  // overlay — at which point the stamped priors give the weight a real signal
  // to act on. Flipping this CAP OFF reverts to neutral priors everywhere
  // (byte-identical ranking, and skips the once-per-recall damping-log scan).
  // The damping map is built ONCE per recall via buildDampingCoefficientMap
  // (a single damping-log scan), NOT per candidate — no new full-ledger scan.
  RECALL_STAMP_PRIORS_ENABLED: true,
  // C2 — QUERY-SIDE GAZETTEER. Run the closed-set recognizer
  // (lib/synthesis/gazetteer.js) over the recall populator text, additively
  // AFTER the structural entity extractor, merging kb_lookup entities into
  // populatorEntities (lib/tools/recall.js, immediately after the structural
  // try/catch). This is the QUERY-side twin of the already-default-ON
  // write-side CASCADE_GAZETTEER_ENABLED below: the cascade stamps kb_lookup
  // ids onto facts, but the recall populator was structural-only, so the two
  // sides could never meet and 260/265 logged recalls extracted 0 entities —
  // the I-CP-2 symmetry contract (recall.js:1319-1321) did not actually hold.
  //
  // DEFAULT OFF, and off is byte-identical: the merge step returns the
  // structural array UNCHANGED (same reference) when this is not true.
  // Evaluated at module load from the environment, exactly like
  // INCREMENTAL_AGGREGATION_ENABLED below — CAPS is Object.freeze()d, so a
  // bare `false` literal here would be a code edit, not an operator lever.
  // ON iff the operator sets MEMORY_RECALL_QUERY_GAZETTEER_ENABLED=1 in the
  // MCP server env. Read as CAPS.RECALL_QUERY_GAZETTEER_ENABLED === true.
  //
  // Blast radius when ON: populatorEntities feeds THREE consumers, not one —
  // computeQueryEpisodicity (recall.js:~1421, episodicity_match), the
  // populatorEntityIds projection (~1447 -> entity_overlap), and the
  // substrate-fallback candidate gate (~1918, which ADDS candidates). Flip it
  // with that in view.
  RECALL_QUERY_GAZETTEER_ENABLED:
    typeof process !== "undefined" &&
    process.env?.MEMORY_RECALL_QUERY_GAZETTEER_ENABLED === "1",
  // W2-CCS — F-CCS-FOUNDATION-cascade-embedding-decoupling § 4.4.
  // Additive-only fallback floor: a candidate routed through the additive
  // branch (because s_emb collapsed to 0 — features.embedding === null and
  // no overlay vector) MUST have additive_sum >= this floor to surface, or
  // it is dropped from the candidate set. Rationale: without dense
  // similarity we cannot rule out spurious matches on weak structural
  // signal; the floor keeps the "no entity overlap, no time anchor"
  // candidates from leaking through during Gemini outages.
  // v0 prior: 0.10. Calibration follow-up in spec §10 Q1.
  RECALL_ADDITIVE_FLOOR_FALLBACK: 0.10,
  // Consent-basis dampeners (multiplicative gate component).
  CONSENT_DAMPENER_FIRST_PARTY: 1.0,
  CONSENT_DAMPENER_THIRD_PARTY_INFERRED: 0.6,
  // Derivation-status gates (orphaned ancestors -> reduced weight).
  // DERIVATION_STATUS_ORPHAN is the v0 anchor for distance d=1 (direct
  // orphan). Transitive (d>1) orphans use the depth-aware dampener:
  //     max(FLOOR, exp(-LAMBDA*(d-1)) * DERIVATION_STATUS_ORPHAN)
  // d=1 evaluates to 1.0 * 0.5 = 0.5 exactly — strict superset of v0.
  // FLOOR=0.05 (round-18 hot-fix; was 0.25 which flatlined the dampener at
  // d>=3 because formula reached 0.225 < 0.25 by d=3). With FLOOR=0.05 the
  // dampener is genuinely depth-aware across the operational range:
  //   d=1: 0.500    d=2: 0.335    d=3: 0.225    d=4: 0.151    d=5: 0.101
  //   d=6: 0.068    d=7: 0.045 (clamped to 0.05)   d=8+: 0.05
  // Authoritative: kb/transitive-orphan-design.md § 4.
  DERIVATION_STATUS_NORMAL: 1.0,
  DERIVATION_STATUS_ORPHAN: 0.5,
  DERIVATION_STATUS_ORPHAN_FLOOR: 0.05,
  DERIVATION_ORPHAN_LAMBDA: 0.4,
  // Transitive-orphan BFS bounds. MAX_DERIVATION_DEPTH bounds the walk in
  // edges; TRANSITIVE_ORPHAN_DESCENDANTS_CAP bounds the total visited node
  // count. Cap-overflow emits one informational policy.recall event and
  // returns partial coverage — preferable to a latency spike.
  MAX_DERIVATION_DEPTH: 16,
  TRANSITIVE_ORPHAN_DESCENDANTS_CAP: 10000,
  // L2-norm invariant epsilon. Assert ||v|| = 1.0 +/- this at every layer.
  L2_NORM_INVARIANT_EPSILON: 1e-6,
  // Predicate-match cosine threshold for Layer 2 hard-gating. A candidate
  // whose full-3072d cosine to any active predicate's snapshot embedding
  // exceeds this threshold is masked out (predicate_mask = 0). v0 uses
  // dense-cosine-only matching; v2 may layer entity-scope / scope-rule logic
  // on top. Authoritative: kb/phase3-v0-contracts.md § Hard gates.
  PREDICATE_MATCH_COSINE_THRESHOLD: 0.85,
  // -----------------------------------------------------------------------
  // Phase 3 v1 Layer-3 (Gemini 2.5 Flash listwise reranker) caps.
  // Authoritative shape contract: kb/phase3-v1-rerank-contracts.md § 4.
  // -----------------------------------------------------------------------
  // Top-N from Layer 2's final_score-sorted survivors fed to Flash. Well
  // under Flash's 1M input-token budget for 400-char excerpts.
  RECALL_RERANK_INPUT_SIZE: 15,
  // Kept after Flash's listwise sort. Matches RECALL_BRIEF_MAX_ITEMS.
  RECALL_RERANK_OUTPUT_SIZE: 12,
  // Flash latency budget at recall time. Abort + degrade if exceeded.
  RECALL_RERANK_TIMEOUT_MS: 15000,
  // Per-candidate content truncation in the rerank prompt (no ellipsis;
  // reranker treats truncation as opaque).
  RECALL_RERANK_CONTENT_EXCERPT_CHARS: 400,
  // N3-local-reranker — route Layer-3 through the LOCAL Qwen3-Reranker server
  // (local-embedder/rerank_server.py, http://127.0.0.1:8360) instead of the
  // dead Gemini-Flash call. Ships ON (see ENABLED below); it shipped OFF until
  // 2026-07-31 under an eval-first precondition + the model being present in
  // the HF cache with the server up. When false, rerank.js uses the gemini
  // path exactly as before (with no key it degrades to the final_score sort);
  // when true and the local server is unreachable, the same degrade fires
  // (reorder-only contract preserved). env LOCAL_RERANKER_URL /
  // LOCAL_RERANKER_TIMEOUT_MS override the client transport; env
  // LOCAL_RERANKER_ENABLED is a TRI-STATE override of THIS cap in both
  // directions — "1"/"true" forces ON, "0"/"false" forces OFF, unset falls
  // through to the value here (rerank.js _localRerankerEnabled()).
  // ENABLED 2026-07-31 after the eval-first precondition above was satisfied:
  // the Qwen3-Reranker-0.6B server answers /health {"ok":true,...,"device":"mps"}
  // and returned real scores for a 15-candidate payload (405-606 ms warm, 3.9 s
  // cold).
  //
  // CORRECTED 2026-08-17 (final integrated review). This comment previously
  // justified the flip with "the gemini path could never fire on this host
  // anyway — the MCP server is a stdio child of the agent host, so it inherits
  // the shell env and NOT the launchd plist that carries GEMINI_API_KEYS."
  // THAT IS FALSE, and it was load-bearing for this decision. Measured:
  // ~/.claude.json mcpServers.memory.env sets GEMINI_API_KEYS explicitly (5
  // keys), so acquireGeminiKey() succeeds in-process and the gemini path CAN
  // fire. Do not reason from the retracted claim — it would also mislead the
  // pending decision about deleting the gemini surface.
  //
  // The flip stands on its remaining, verified merits, which never depended on
  // the false premise: local is drop-in (same {ranking:[{id,rank_score}]} contract), unmetered, and
  // keeps recall contents on-device. The degrade path is UNCHANGED: if the local
  // server is unreachable the same reorder-only degrade fires.
  LOCAL_RERANKER_ENABLED: true,
  // -----------------------------------------------------------------------
  // WU-recall-content-dedup — content-dedup at the recall projection.
  // -----------------------------------------------------------------------
  // When true (default), recall collapses byte-identical NORMALIZED content
  // among the score-sorted candidate set BEFORE rerank + MMR + truncation.
  // normalize = trim + collapse internal whitespace runs to single spaces +
  // lowercase. The highest-scored representative of each content cluster is
  // kept; subsequent same-content candidates are dropped and the survivor is
  // annotated with score_components.duplicate_count. This is threshold-free
  // (only EXACT normalized matches collapse) and a pure pass-through when the
  // candidate set has no duplicates. Set false to disable (e.g. for OPE
  // replay fidelity over historical recall rows). The ledger is unchanged —
  // this is a recall-PROJECTION operation (thesis: ledger permanent #1, the
  // projection collapses dups #2). See lib/tools/recall.js step (h).
  RECALL_CONTENT_DEDUP_ENABLED: true,
  // -----------------------------------------------------------------------
  // Phase 2b connector-base caps (kb/connectors-survey.md § Top-5 connector
  // skeletons + kb/ingestion.md § Connector contract). The connector base
  // class at lib/connectors/index.js consumes these directly; each Phase 2b
  // impl daemon (imessage, screentime, git-log-local, github-events) targets
  // them through ConnectorBase.appendLedgerRow / reportHealth.
  // -----------------------------------------------------------------------
  // Tail-read window for source_msg_id dedupe in appendLedgerRow. Out-of-
  // window duplicates slip through; the salience-layer corroboration path
  // (kb/ingestion.md § Cross-source dedupe) absorbs the long tail.
  CONNECTOR_DEDUP_TAIL_LINES: 256,
  // Cursor.error_count threshold: at-or-above => reportHealth returns
  // status="degraded". Each connector daemon may override via the
  // ConnectorBase constructor (errorThreshold) but the default trip line is
  // 5 errors before the supervisor surfaces the connector as unhealthy.
  CONNECTOR_ERROR_THRESHOLD: 5,
  // Cursor.last_cursor_advance_ts staleness threshold: if the cursor has
  // not advanced within this window, reportHealth returns status="stale"
  // (even with zero errors). Daemons that legitimately idle (github-events
  // polls once/day) override this in their own reporter.
  CONNECTOR_HEALTH_STALE_SECONDS: 3600,
  // -----------------------------------------------------------------------
  // c2 (task-hypergraph) — CAPTURE-liveness thresholds, consumed by the pure
  // detector in lib/synthesis/connector-staleness.js. Distinct from
  // CONNECTOR_HEALTH_STALE_SECONDS above (which keys on
  // last_cursor_advance_ts — poisoned on 4 of 9 connectors, see that module's
  // header) and from the W7 cursor-lag alarm (which measures CASCADE backlog
  // and collapses to lag_h=0.0 when a source dies). These key on the only
  // honest capture evidence: state.last_appended_ts and the source ledger's
  // mtime.
  //
  // The 6h default deliberately REUSES the established
  // CAPS.TELEGRAM_DRAIN_STALL_THRESHOLD_MS number below rather than inventing
  // a second one: same question ("has this source's ledger stopped moving?"),
  // same answer.
  //
  // Per-source overrides are REQUIRED — the comment on
  // CONNECTOR_HEALTH_STALE_SECONDS already asserts this ("Daemons that
  // legitimately idle (github-events polls once/day) override this in their
  // own reporter") and no such override was ever written, which is why that
  // classifier is unusable. Every value below is ~2x a measured live
  // inter-append gap (census 2026-08-11T18:54Z, hours since last append:
  // github-events 88.6, mail 54.6, git-log 7.0, imessage 4.1, whatsapp 0.2,
  // telegram 0.02, codex-cli 0.06, screentime 0.03, chat-claude-code 0.07)
  // and is sized so NO healthy source is red on day one, while both real
  // stalls (github-events, mail) fire.
  SOURCE_CAPTURE_STALE_DEFAULT_MS: 6 * 60 * 60 * 1000,
  SOURCE_CAPTURE_STALE_OVERRIDES_MS: Object.freeze({
    // Polls the GitHub events API once/day; 88.6h of live silence must fire.
    "github-events": 48 * 60 * 60 * 1000,
    // Apple Mail arrives in bursts with day-scale quiet gaps (42h observed
    // between bursts); the current 54.6h silence must still fire.
    mail: 48 * 60 * 60 * 1000,
    // Human messaging: overnight + workday gaps of 13h observed.
    imessage: 24 * 60 * 60 * 1000,
    // Commit bursts, then nothing overnight — 7.0h gap observed at 18:54Z,
    // which already falsifies the 6h default for this source.
    "git-log": 24 * 60 * 60 * 1000,
    // Agent-session bursty: silent whenever the operator is not in a session
    // (same overnight shape as git-log).
    "codex-cli": 24 * 60 * 60 * 1000,
    // Same agent-session burstiness; ledger-only source (no connectors/ dir).
    "chat-claude-code": 24 * 60 * 60 * 1000,
    // Sub-hour cadence while awake, silent overnight.
    whatsapp: 12 * 60 * 60 * 1000,
    telegram: 12 * 60 * 60 * 1000,
    // ~0.5h cadence while the Mac is awake; silent while it sleeps. NOTE:
    // screentime is captured-only (WATERMARK_CAPTURED_ONLY_SOURCES below) —
    // its CASCADE cursor is frozen at 2026-06-01 on purpose, which is exactly
    // why this alarm keys on capture evidence instead.
    screentime: 12 * 60 * 60 * 1000,
  }),
  // -----------------------------------------------------------------------
  // B1 (task-hypergraph) — Telegram drain-liveness thresholds. The detector
  // in lib/connectors/telegram-drain-liveness.js fires drain_stalled when the
  // SOURCE ledger's mtime is stale WHILE the upstream staging file is still
  // live — the silent-stall class found 2026-07-06 (telegram.jsonl frozen 11
  // days while the Python tail kept appending to staging). It INVERTS W7's
  // growth gate: a frozen ledger has ledger_growing=false, so
  // computeCursorLagSnapshot is structurally blind to a drain stall.
  //
  // STAGING_LIVE_WINDOW: staging counts as "capture is live" when its mtime
  // is within this window (mirrors CURSOR_LAG_LEDGER_GROWTH_WINDOW_MS = 1h in
  // watermark.js). DRAIN_STALL_THRESHOLD: the source ledger counts as "drain
  // frozen" once its mtime is older than this — 6h, well below the 11-day
  // silent window yet well above normal quiet gaps. Gating drain_stalled on
  // staging-live means a quiet ledger during a quiet period does NOT
  // false-fire, because the staging file is quiet then too.
  TELEGRAM_STAGING_LIVE_WINDOW_MS: 60 * 60 * 1000,
  TELEGRAM_DRAIN_STALL_THRESHOLD_MS: 6 * 60 * 60 * 1000,
  // Maximum size in bytes of a typedstream blob the iMessage decoder will
  // attempt to parse. Real chat.db messages cap out around 16 KiB; any
  // larger blob is treated as malformed (refused at the parser boundary, so
  // a corrupt or hostile attributedBody column can't cause unbounded scan
  // costs). Authoritative: kb/source-fidelity-spec.md § 2.
  TYPEDSTREAM_MAX_BUFFER_BYTES: 1048576,
  // -----------------------------------------------------------------------
  // R28 Phase 2a — codex-cli connector caps.
  //
  // Codex CLI rollout logs live at
  //   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<uuid>.jsonl
  // on macOS. Each file is a per-session JSONL with rows discriminated by a
  // `type` field: "session_meta", "event_msg", "response_item",
  // "turn_context". The connector pairs `response_item` rows with
  // payload.role == "user" / "assistant" into turns; "developer"-role rows
  // (system permissions boilerplate, repo-overview prompts) are recorded
  // only as raw_content.system_prompt_hash and never as content.
  //
  // The glob is operator-overridable via the CODEX_CLI_SESSIONS_GLOB env
  // var (a colon-separated list of absolute glob patterns; the connector
  // resolves each via a bounded directory walk).
  //
  // CODEX_CLI_BATCH_MAX_TURNS bounds the number of paired user/assistant
  // turns appended in a single pollOnce per session file. A very-long
  // session file is picked up in chunks via the per-session turn-index
  // cursor stored in state.json.
  // -----------------------------------------------------------------------
  CODEX_CLI_SESSIONS_GLOB: "~/.codex/sessions/*/*/*/rollout-*.jsonl",
  CODEX_CLI_BATCH_MAX_TURNS: 500,
  // -----------------------------------------------------------------------
  // R39 Phase 3a — Mail connector caps.
  //
  // Apple Mail's Envelope Index path varies by Mail.app major version (V8
  // on Big Sur+, V10 on Ventura/Sonoma, etc.). The connector's V-resolver
  // walks ~/Library/Mail/ and picks the highest-numbered V<N> dir whose
  // MailData/Envelope Index exists; CAPS.MAIL_ENVELOPE_INDEX_PATH is the
  // operator-overridable absolute path (leading "~/" expands to homedir,
  // empty string means use the V-resolver default).
  //
  // FDA on the node binary the service runs is required (~/Library/Mail/ is
  // TCC-protected). The iMessage grant covers the same binary.
  //
  // MAIL_POLL_INTERVAL_SECONDS controls runForever cadence; 300s (5 min)
  // matches the launchd plist StartInterval. Mail.app keeps the index
  // fresh via its own sync; sub-minute polling adds no value.
  // -----------------------------------------------------------------------
  MAIL_ENVELOPE_INDEX_PATH: "",
  MAIL_POLL_INTERVAL_SECONDS: 300,
  // -----------------------------------------------------------------------
  // B2 (memory-roots) — operator alias-candidate detector thresholds, read
  // by lib/identity/alias-candidates.js INSIDE the existing 7-day mail tail
  // scan (lib/ingest/source-effective-empty-rate.js; no second scan). An
  // unregistered To/Cc address becomes a candidate when it dominates one
  // Apple Mail account's rows (share >= min_account_share in an account
  // holding >= min_account_rows rows) and/or when its local-part carries a
  // registered-operator name token AND it received >= min_direct_rows
  // direct (non-list, Stage-0 rules 1-4 silent) mails.
  //
  // Calibrated on a 7-day census of a live mail ledger (top To/Cc
  // recipient per account, rows(addr,acct)/rows(acct)): every account's own
  // address held a share >= 0.81, so 0.5 is a wide margin;
  // min_account_rows=5 keeps a 2-row account from electing anyone. A
  // low-volume send-as alias delivered into another account's mailbox (a
  // handful of direct rows, ~1% share of that account) is reachable only
  // through the name-token key, hence min_direct_rows=3.
  //
  // name_tokens_override: when MEMORY_OPERATOR_ALIAS_NAME_TOKENS_OVERRIDE is
  // a comma list it REPLACES the token set derived from the registered
  // EMAILS local-parts (see deriveNameTokens in
  // lib/identity/alias-candidates.js);
  // null means derive. Test/operator knob, same idiom as
  // WATERMARK_CAPTURED_ONLY_SOURCES below.
  // -----------------------------------------------------------------------
  OPERATOR_ALIAS_CANDIDATE: Object.freeze({
    min_direct_rows: 3,
    min_account_share: 0.5,
    min_account_rows: 5,
    name_tokens_override:
      typeof process !== "undefined" &&
      typeof process.env?.MEMORY_OPERATOR_ALIAS_NAME_TOKENS_OVERRIDE === "string"
        ? Object.freeze(
            process.env.MEMORY_OPERATOR_ALIAS_NAME_TOKENS_OVERRIDE
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          )
        : null,
  }),
  // A2 (memory-roots node mail-admission-fix) — Stage-0 mail Rule 9
  // person-sender exemption (lib/ingest/stage0/mail.js isPersonSenderExempt).
  // Apple's automated_conversation column is stamped 2 on any conversation
  // with no reply yet (ac>0 on 273,982 of 292,112 ledger rows, 94%), so
  // Rule 9 `apple_automated` killed every human thread OPENER while the
  // "Re:" replies PASSed (A1 census maps/mail-admission-census.md FA1-1).
  // Measured on the 2026-09-15 ledger with the real stage0() in a hermetic
  // env (FINDINGS.md FA2-1..FA2-4): the exemption (consent_basis first_party
  // OR unquoted person-shaped display name with no brand token, non-role
  // local-part, Return-Path local empty / equal to From local / SRS0|SRS1)
  // moves rows ONLY out of apple_automated; list_unsubscribe, list_id,
  // noreply_sender, operator_junk_folder, marketing_platform,
  // auto_submitted, bulk_precedence counts are byte-identical before/after,
  // and zero airline / bank / marketplace / Apple Support rows are released.
  //
  // Default ON. Operator kill-switch: MEMORY_MAIL_STAGE0_PERSON_SENDER_EXEMPT_ENABLED=0
  // in the daemon env (read once at module load — CAPS is frozen, so a bare
  // literal would not be an operator lever; same env-at-import shape as
  // RECALL_QUERY_GAZETTEER_ENABLED / INCREMENTAL_AGGREGATION_ENABLED). OFF
  // restores the pre-A2 unconditional Rule 9 DROP byte-for-byte.
  MAIL_STAGE0_PERSON_SENDER_EXEMPT_ENABLED:
    !(typeof process !== "undefined" &&
      process.env?.MEMORY_MAIL_STAGE0_PERSON_SENDER_EXEMPT_ENABLED === "0"),
  // -----------------------------------------------------------------------
  // R39 Phase 3b — WhatsApp connector caps.
  //
  // ChatStorage.sqlite lives at
  //   ~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite
  // on macOS (Phase A inventory verified the real path; the spec hint about
  // a "Message/" subdir was wrong on this host). Operator-overridable via
  // CAPS.WHATSAPP_CHATSTORAGE_PATH (leading "~/" expands to homedir).
  //
  // Full Disk Access is required (Group Containers are TCC-protected). It goes
  // to the node binary the rendered plist names: scripts/render-launchd.mjs
  // `--node <path>`, default the node that ran the render script. No other
  // credentials, no Gemini quota, no network egress: a pure local SQLite read.
  //
  // WHATSAPP_POLL_INTERVAL_SECONDS controls runForever cadence; 300s is the
  // default since WhatsApp Desktop only syncs on app activation and a
  // sub-minute poll yields no benefit.
  // -----------------------------------------------------------------------
  WHATSAPP_CHATSTORAGE_PATH:
    "~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite",
  WHATSAPP_POLL_INTERVAL_SECONDS: 300,
  // -----------------------------------------------------------------------
  // R38 Phase 2c — Slack connector caps.
  //
  // The Slack connector polls slack.com via the Web API. Configuration is
  // driven by env vars (SLACK_USER_TOKEN or per-workspace
  // SLACK_USER_TOKEN_<workspace_id>; SLACK_WORKSPACE_IDS comma-separated;
  // SLACK_POLL_INTERVAL_SECONDS cadence). The cap below is the default
  // polling cadence in seconds; the launchd plist pins StartInterval to the
  // same value. Slack tier-2 rate limits start at 20 requests/minute per
  // user token; a 10-minute poll across a handful of channels stays well
  // under the cap and respects the friendliness tier even on dense
  // workspaces.
  // -----------------------------------------------------------------------
  SLACK_POLL_INTERVAL_SECONDS: 600,
  // -----------------------------------------------------------------------
  // R26 watermark multi-source coverage (kb/salience-design.md § Phase D).
  // The watermark daemon's source list is config-driven rather than glob-
  // hardcoded so future sources are a one-line CAPS edit.
  //
  // Wildcard semantics: a trailing "*" matches any suffix against
  // storage/sources/<entry>.jsonl basenames; a bare name is exact-match.
  // The "chat-*" forms route to the conversation/idle-watermark batch
  // pipeline (existing behaviour); bare-name source-tier entries route to
  // the row-by-row tail-and-promote salience cascade.
  // -----------------------------------------------------------------------
  WATERMARK_SOURCES: Object.freeze([
    // F-T2-CHAT_CLAUDE-CODE-F7 — bare-name entry registers chat-claude-code
    // with the row-by-row tail-and-cascade pipeline. The legacy "chat-*"
    // wildcard below is kept for back-compat with the retired conversational-
    // batch pipeline (listSourceLedgers skips wildcard entries), but the
    // bare-name entry here is what actually gets the daemon to tail
    // storage/sources/chat-claude-code.jsonl. Without this entry the audit
    // observed 0 rows from 765 ledger rows reaching memory.jsonl — the
    // source was registered nowhere downstream of the connector.
    "chat-claude-code",
    "chat-claude-code-*",
    "imessage",
    "screentime",
    "git-log",
    "github-events",
    // R28 Phase 2a — agent-runtime hook connectors. Bare-name
    // entries route to the row-by-row tail-and-cascade pipeline;
    // per-source cursor lives at storage/watermark-state/<source>.json.
    // codex-cli is the sole agent-runtime hook source.
    "codex-cli",
    // R38 Phase 2c — Telegram source-tier connector. Tails a Python-helper
    // staging file (mcp/lib/connectors/telegram/telegram_tail.py) via the
    // shared ConnectorBase; per-source cursor lives at
    // storage/watermark-state/telegram.json.
    "telegram",
    // R39 Phase 3a — Apple Mail Envelope Index + .emlx body files. Bare-name
    // routes to row-by-row tail-and-cascade pipeline. Per-source cursor at
    // storage/watermark-state/mail.json. FDA on the node binary the service
    // runs is required to read ~/Library/Mail/; the iMessage TCC grant
    // already covers the same binary.
    "mail",
    // R39 Phase 3b — WhatsApp Desktop ChatStorage.sqlite source. Bare-name
    // routes to row-by-row tail-and-cascade pipeline. Per-source cursor at
    // storage/watermark-state/whatsapp.json. FDA on the node binary the service
    // runs is required to read the WhatsApp Group Container; the iMessage TCC
    // grant already covers the same binary.
    "whatsapp",
    // R38 Phase 2c — Slack source-tier connector. Polls slack.com via the
    // Web API; per-channel cursor lives under
    // storage/sources/slack-cursors/<workspace_id>/<channel_id>.json.
    // Per-source watermark cursor lives at
    // storage/watermark-state/slack.json.
    "slack",
  ]),
  // -----------------------------------------------------------------------
  // Wave 9 — captured-only sources. Sources listed here are CAPTURED by
  // their connector daemon (which keeps tailing the upstream feed and
  // writing storage/sources/<source>.jsonl) but are NOT cascaded by the
  // watermark daemon: tickSourcesOnce skips the source entirely (no
  // dispatch, no cursor advance, no error_count bump) and
  // computeCursorLagSnapshot / emitCursorLagAlarms filter the source out
  // (a captured-only source cannot be "behind on cascade" by definition).
  //
  // This is the explicit opt-in twin of the historical implicit pattern
  // (telegram / slack / mail / whatsapp left out of WATERMARK_SOURCES
  // because no Stage-0 module shipped yet). Captured-only sources stay
  // IN WATERMARK_SOURCES so their cursor-state file shape is preserved;
  // they are only filtered at the cascade-dispatch + cursor-lag-alarm
  // boundaries. Removing a source from this list (and likely resetting
  // its cursor) fully re-activates cascade processing — the mode is
  // reversible by design.
  //
  // screentime sits here (Wave 9 audit + production observation): 0%
  // promoted facts across the live corpus; the connector's per-app
  // duration bands are attention-shape telemetry rather than a fact
  // stream. Repositioning (not deletion) keeps the connector daemon +
  // Stage-0 module + structural-rule table available for re-activation
  // once a downstream consumer for attention-shape telemetry ships.
  // Test-only override: set MEMORY_WATERMARK_CAPTURED_ONLY_OVERRIDE to a
  // comma-separated list to replace the default. An EMPTY string disables
  // captured_only entirely (all sources cascade normally — restores legacy
  // behavior for tests that pre-date W9). Tests that exercise screentime
  // cascade flow (watermark-multisource T4/T5) set this before importing.
  WATERMARK_CAPTURED_ONLY_SOURCES: Object.freeze(
    typeof process !== "undefined" &&
    typeof process.env?.MEMORY_WATERMARK_CAPTURED_ONLY_OVERRIDE === "string"
      ? process.env.MEMORY_WATERMARK_CAPTURED_ONLY_OVERRIDE
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : ["screentime"]
  ),
  // Per-source cursor file schema version. Bump on any breaking change to
  // the {last_offset, last_appended_ts, last_event_id} contract.
  WATERMARK_CURSOR_VERSION: 1,
  // Backoff: a source whose error_count is at-or-above this cap is muted
  // until the operator clears the cursor. Independent of
  // CONNECTOR_ERROR_THRESHOLD (which gates connector health, not watermark
  // tailing).
  WATERMARK_SOURCE_ERROR_THRESHOLD: 50,
  // D1 — Incremental (offset-checkpointed) aggregation. Default OFF: the daemon
  // keeps the full-ledger-rescan aggregation + whole-ledger byId emitter path,
  // byte-for-byte. ON iff the operator sets
  // MEMORY_INCREMENTAL_AGGREGATION_ENABLED=1 in the watermark plist env (same
  // lever discipline as the bulk-drain flags). Evaluated at module load, exactly
  // like WATERMARK_CAPTURED_ONLY_SOURCES above. Read as
  // CAPS.INCREMENTAL_AGGREGATION_ENABLED === true (design.md §D-4.1).
  INCREMENTAL_AGGREGATION_ENABLED:
    typeof process !== "undefined" &&
    process.env?.MEMORY_INCREMENTAL_AGGREGATION_ENABLED === "1",
  // -----------------------------------------------------------------------
  // R25 salience cascade (kb/salience-design.md). Layer-1 Stage-0 module
  // regexes + per-source structural-score tables. Held in CAPS so an
  // operator can re-weight without re-embed and so the canonical
  // weights_hash bookkeeping (set in Phase A6) covers structural-rule
  // drift end-to-end.
  // -----------------------------------------------------------------------
  // OTP / verification-code redaction regex (case-insensitive in callers).
  // F-T2-MAIL-F3 (Wave 3): expanded from the original iMessage-only shapes
  // to cover the dominant email-2FA forms (Stripe, Twilio, Apple ID,
  // Google, Microsoft, GitHub, Discord, Slack standardised templates).
  // Catches:
  //   - "verification code", "one-time code/passcode/password"
  //   - bare \bOTP\b and \bPIN\b followed by digits
  //   - "OKX", "Coinbase code" brand-specific templates
  //   - "Your <thing> code/passcode/PIN is <4-8 digits>"
  //   - "<4-8 digits> is your verification/sign-in/login/security/access/one-time code/passcode/PIN"
  //   - "Use this code: <4-8 digits>", "Enter (this) code: <4-8 digits>"
  // Same regex is shared with iMessage via CAPS.SALIENCE_OTP_REGEX (single
  // source of truth). Action is REDACT_DROP — false-positive risk on bare
  // "12345 is your favorite number" prose is acceptable because the row
  // gets digits scrubbed and is low-value either way. Coordinated with
  // F-INFRA-R44 A2P predicate bus. The regex is a string (not a RegExp
  // literal) so the CAPS block stays JSON-serialisable for the dashboard.
  SALIENCE_OTP_REGEX:
    "verification code|one[- ]?time (?:code|passcode|password)|\\bOTP\\b|\\bPIN\\b[ :]\\s*\\d{4,8}|\\bOKX\\b|Coinbase code|Your[\\s\\S]{0,40}?(?:code|passcode|PIN)[\\s\\S]{0,10}?is[\\s\\S]{0,10}?\\b\\d{4,8}\\b|\\b\\d{4,8}\\b\\s+is\\s+your\\s+(?:verification|sign[- ]?in|login|security|access|one[- ]?time)\\s+(?:code|passcode|PIN)|Use this code[:\\s]+\\d{4,8}|Enter\\s+(?:this\\s+)?code[:\\s]+\\d{4,8}",
  // DEPRECATED (F-NEW-W2-VALIDATION-BOT-AUTHOR-REGEX-GIT, Wave 3):
  // SALIENCE_BOT_AUTHOR_REGEX_GIT was a strict-subset bot-author regex
  // ("dependabot|renovate-bot|github-actions") used by Stage-0
  // mcp/lib/ingest/stage0/gitlog.js. It missed copilot, web-flow,
  // [bot]@ suffixes, claude[bot], gpt-engineer-app[bot], pr-bot, and
  // GitHub's `<digits>+`-prefixed noreply privacy emails — every one of
  // which the canonical isBotActor() predicate in
  // lib/identity/bot-actors.js DOES recognise.
  //
  // The Stage-0 module now imports isBotActor() directly and no longer
  // reads CAPS.SALIENCE_BOT_AUTHOR_REGEX_GIT. The constant is retained
  // (a) for the test/ingest/stage0-modules.test.mjs CAPS-presence
  // assertion that references it as a typeof === "string" probe, and
  // (b) because freezing a property off a frozen CAPS object would
  // require a wider refactor than this WU's scope. Any new caller MUST
  // route through isBotActor() (the strict superset of this regex's
  // intent).
  SALIENCE_BOT_AUTHOR_REGEX_GIT: "dependabot|renovate-bot|github-actions",
  // Bot-author regex for github-events (matched against actor.login /
  // pr_author). Renovate's GH actor surfaces as plain "renovate" rather
  // than "renovate-bot" in some event types.
  SALIENCE_BOT_AUTHOR_REGEX_GH: "dependabot|renovate",
  // Per-source Layer-2 structural-score rule table. Sourced from
  // kb/salience-design.md § "structural 0.15 per-source rule table".
  // Hard-zero rows for Stage-0 droppers are kept so a future regression
  // (e.g., Stage-0 module skipped) cannot accidentally promote them at
  // high structural score. The salience scorer reads these via
  // CAPS.SALIENCE_STRUCTURAL_RULES[source][rule_name].
  SALIENCE_STRUCTURAL_RULES: Object.freeze({
    imessage: Object.freeze({
      tapback: 0.05,
      business_handle: 0.10,
      otp_pattern: 0.0,
      placeholder_residual: 0.0,
      substantive_prose: 0.85,
      short_reply: 0.40,
    }),
    screentime: Object.freeze({
      discoverability_signals: 0.0,
      default: 0.40,
      // F-NEW-W7-SCREENTIME-BAND-CENTRAL-SCORE — central per-source
      // overrides for the /app/usage duration bands. Absent here, the
      // module-local USAGE_DURATION_BAND_DEFAULTS in stage0/screentime.js
      // apply; populated here, they override. Keys mirror
      // USAGE_DURATION_BAND_NAMES. Left undefined by default so the
      // module-local defaults remain authoritative until an operator
      // re-tunes a band centrally.
    }),
    "git-log": Object.freeze({
      initial_commit: 0.0,
      merge_only: 0.15,
      bot_commit: 0.0,
      subject_only: 0.50,
      substantive_prose: 0.85,
    }),
    "github-events": Object.freeze({
      low_signal_event: 0.0,
      bot_event: 0.0,
      substantive_prose: 0.70,
    }),
    // R28 Phase 2a — agent-runtime hook sources. Defaults mirror the
    // git-log shape (substantive_prose / subject_only / boilerplate);
    // empty-turn + slash-command + developer-only DROPpers run in the
    // stage0 module itself, not via structural-rule lookup.
    "codex-cli": Object.freeze({
      substantive_prose: 0.85,
      subject_only: 0.55,
      boilerplate: 0.30,
      empty_turn: 0.0,
      developer_only: 0.0,
      environment_context_only: 0.0,
    }),
    // F-T2-CHAT_CLAUDE-CODE-F6 — Claude Code chat ledger structural rules.
    // Mirror the codex-cli shape: empty_turn hard-zeroes (Stage-0 DROPs it
    // before structural lookup), substantive prose at 0.85, subject-only
    // dialogue (one half present, short) at 0.55. content_free hard-zeroes
    // (Stage-0 drops via the shared isContentFree predicate). The audit
    // observed 832/834 rows in storage/sources/chat-claude-code.jsonl with
    // both user_text == "" and assistant_text == "" — those ride the
    // empty_turn / content_free DROPs and never pollute structural-score
    // lookups even if a future regression skips Stage-0.
    "chat-claude-code": Object.freeze({
      substantive_prose: 0.85,
      subject_only: 0.55,
      boilerplate: 0.30,
      empty_turn: 0.0,
      content_free: 0.0,
    }),
    // R38 Phase 2c — Telegram. Slightly lower substantive_prose ceiling than
    // imessage/codex-cli because cross-source corroboration with iMessage is
    // common; bot/ephemeral/sticker DROPpers run inside stage0/telegram.js.
    "telegram": Object.freeze({
      substantive_prose: 0.80,
      subject_only: 0.50,
      bot_message: 0.0,
      bot_forward: 0.0,
      ephemeral_short_ttl: 0.0,
      voice_video_metadata_only: 0.0,
      sticker_only: 0.0,
      // F-T2-TELEGRAM-F3 — channel broadcast DROP. 1:N mass-media has no
      // operator-authored content; preserved via quarantineRow with the
      // CAPS.TELEGRAM_CHANNEL_ALLOWLIST + is_outgoing exemption carve-out.
      channel_broadcast: 0.0,
      // F-T2-TELEGRAM-F4 — forwarded-from-channel echo DROP. Group members
      // re-broadcasting a public channel post is double-embed noise; the
      // operator already subscribes to the source channel separately.
      channel_forward_echo: 0.0,
    }),
    // R38 Phase 2c — Slack. Hard-zero rows for Stage-0 droppers
    // (bot_message, channel_lifecycle, thread_broadcast_empty,
    // file_share_no_text, empty_message) and a substantive_prose / short_reply
    // pair for PASS rows. Score band matches the chat-* / codex-cli shape;
    // own-team Slack often corroborates iMessage threads and the
    // corroborate_threshold accordingly mirrors imessage's tight 0.18.
    "slack": Object.freeze({
      substantive_prose: 0.80,
      short_reply: 0.45,
      bot_message: 0.0,
      channel_lifecycle: 0.0,
      thread_broadcast_empty: 0.0,
      file_share_no_text: 0.0,
      empty_message: 0.0,
    }),
    // R39 Phase 3a — Mail. Hard-zero rows for Stage-0 droppers
    // (list_unsubscribe / list_id / auto_submitted / bulk_precedence /
    // noreply_sender / marketing_platform / apple_automated /
    // placeholder_residual / otp_pattern). PASS rows pick substantive_prose
    // vs short_reply by the 200-char threshold inside stage0/mail.js. Mail
    // bodies are denser than chat — substantive_prose is rated 0.85, the
    // same band as iMessage long-form. html_only_discount is a 0.5x
    // multiplier applied at PASS time inside stage0/mail.js for the
    // html-only structural smell.
    "mail": Object.freeze({
      substantive_prose: 0.85,
      short_reply: 0.40,
      html_only_discount: 0.5,
      list_unsubscribe: 0.0,
      list_id: 0.0,
      auto_submitted: 0.0,
      bulk_precedence: 0.0,
      noreply_sender: 0.0,
      marketing_platform: 0.0,
      apple_automated: 0.0,
      placeholder_residual: 0.0,
      otp_pattern: 0.0,
    }),
  }),
  // -----------------------------------------------------------------------
  // R25 salience scoring caps (Phase A6 — A1 scorer authority).
  // Layer-2 component weights + per-source priors + corroboration thresholds.
  // Authoritative spec: kb/salience-design.md § "Scoring function" and
  // § "Operator Call-Points → CP-1/CP-2". Frozen at R25 ship; the week-1
  // freeze re-derives against real recall.jsonl. Do NOT change values
  // without bumping SALIENCE_VERSION and replaying via replay-salience.mjs.
  // -----------------------------------------------------------------------
  SALIENCE_VERSION: "v1",
  // 8-key weights dict; 6 scored components + 2 zero-weighted decay-feedback
  // grafts (R24.5: shipped dark, CP-5 Trigger A activates via byte-idempotent
  // weight bump + replay). Sums to 1.0.
  SALIENCE_WEIGHTS_V1: Object.freeze({
    recency: 0.15,
    authorship: 0.20,
    content_mass: 0.15,
    source_prior: 0.10,
    structural: 0.15,
    novelty: 0.25,
    last_retrieved_ts: 0.0,
    use_count: 0.0,
  }),
  // Per-source baseline prior (Layer-2 source_prior component). git-fp
  // highest because the operator's own commits are the densest signal
  // source in the corpus.
  SALIENCE_SOURCE_PRIORS: Object.freeze({
    "git-log": 0.85,
    "imessage": 0.60,
    "github-events": 0.55,
    "screentime": 0.20,
    "chat-claude-code": 0.70,
    "chat-codex": 0.70,
    // R28 Phase 2a — agent-runtime hook canonical source name.
    // Same prior as its chat-* analogue.
    "codex-cli": 0.70,
    // R38 Phase 2c — Telegram prior. Same band as iMessage; foreign DM/chat
    // streams sit below dev-context (git/gh) and above passive (screentime).
    "telegram": 0.60,
    // R38 Phase 2c — Slack prior. Same band as iMessage / Telegram; team
    // chat sits in the same conversational density tier and corroborates
    // iMessage threads frequently.
    "slack": 0.60,
    // R39 Phase 3a — Mail prior. Mail bodies are denser than chat but lower
    // signal-density than the operator's own git commits; sits in the
    // iMessage / Telegram / Slack conversational band.
    "mail": 0.55,
  }),
  // Per-source recency-decay tau in SECONDS. recency = exp(-Δt / τ_source).
  // iMessage 90d, ScreenTime 30d, git 365d, gh 180d, chat 60d.
  SALIENCE_TAU_SECONDS: Object.freeze({
    "imessage": 90 * 86400,
    "screentime": 30 * 86400,
    "git-log": 365 * 86400,
    "github-events": 180 * 86400,
    "chat-claude-code": 60 * 86400,
    "chat-codex": 60 * 86400,
    // R28 Phase 2a / R28.1 — agent-runtime hook canonical source names.
    "codex-cli": 60 * 86400,
    // R38 Phase 2c — Telegram. Mirror iMessage tau (90d); same
    // conversational decay shape.
    "telegram": 90 * 86400,
    // R38 Phase 2c — Slack. Mirror iMessage tau (90d); team-chat decay
    // tracks DM decay closely on observed corpora.
    "slack": 90 * 86400,
    // R39 Phase 3a — Mail. Longer tau (180d) than chat: business mail
    // contracts, receipts, and project updates retain salience for
    // months, not weeks.
    "mail": 180 * 86400,
  }),
  // Per-source corroborate threshold (CP-1 Aggressive default): if the
  // nearest cosine_distance < threshold, emit policy.corroboration and
  // return CORROBORATE (no new fact row).
  SALIENCE_CORROBORATE_THRESHOLD: Object.freeze({
    "imessage": 0.18,
    "git-log": 0.28,
    "github-events": 0.30,
    "screentime": 0.35,
    "chat-claude-code": 0.25,
    "chat-codex": 0.25,
    // R28 Phase 2a / R28.1 — agent-runtime hook canonical source names.
    "codex-cli": 0.25,
    // R38 Phase 2c — Telegram corroborate threshold. Mirror iMessage (0.18);
    // foreign DM/chat content frequently restates iMessage threads.
    "telegram": 0.18,
    // R38 Phase 2c — Slack corroborate threshold. Mirror iMessage (0.18);
    // team-chat content frequently restates iMessage/Telegram threads.
    "slack": 0.18,
    // R39 Phase 3a — Mail corroborate threshold. Looser than chat (0.25):
    // mail bodies are richer + more verbose, so a stricter threshold
    // would mis-corroborate distinct topics with shared boilerplate.
    "mail": 0.25,
  }),
  // Boilerplate regex source string. Hard-zeros content_mass when matches.
  // Conservative pattern: empty/whitespace-only, single-word acks, and
  // canonical commit templates (Initial commit, wip). The Stage-0 modules
  // already drop these in most cases; the regex is a defence-in-depth
  // catch for the cases that slip past Stage-0 (e.g. a "wip" subject with
  // an unusual diff trailer that the git Stage-0 module accepts).
  SALIENCE_BOILERPLATE_REGEX:
    "^\\s*$|^(ok|okay|thanks|thx|ty|yes|no|lol|haha|sounds good|got it|sure|nope|yep|yeah|nice)\\s*[!.?]*\\s*$|^Initial commit$|^wip$|^WIP$",
  // Rerank Layer-2 multiplier: final *= salience^alpha. alpha=0.5 (square-
  // rooted to preserve long tail per design § Storage + recall integration).
  SALIENCE_ALPHA: 0.5,
  // kNN k for novelty + corroboration (design § "1 - max(cosine, k=8)").
  SALIENCE_KNN_K: 8,
  // HNSW incremental promotion threshold. Below this many facts the
  // scorer's kNN uses a linear scan against the recall-layer HNSW's loaded
  // vectors (sub-millisecond at this scale). At/above the threshold the
  // existing HnswIndex serves the kNN. The swap is internal to
  // salience.js; no operator-visible flag. Justification: linear scan of
  // <=1000 unit-norm 768d vectors is well inside the <1ms per-ingest
  // budget the design quotes; HNSW only becomes load-bearing at ~10^4+.
  SALIENCE_HNSW_INCREMENTAL_THRESHOLD: 1000,
  // R25.5 CRIT-6 cold-start novelty lerp floor. While hnsw.size() < this
  // many facts, the raw novelty signal is linearly blended toward 0.5
  // (the neutral midpoint) so the first backfill rows don't admit at
  // novelty=1.0 simply because the index happens to be empty. Prevents
  // the brutalist's top-week-1 risk: under alphabetical phase ordering
  // git-log (~130k rows) lands first; without the lerp every git-log row
  // admits at novelty=1.0 and ~80k rows later iMessage rows paraphrasing
  // the same topics would collapse to corroboration against inflated
  // git-log facts — destroying iMessage provenance. The lerp delays
  // semantic-cosine corroboration from compounding until the index is
  // dense enough that cross-source cosine is meaningful.
  SALIENCE_NOVELTY_LERP_FLOOR: 200,
  // R25.5 CRIT-6 cold-start corroboration disable. While hnsw.size() < this
  // many facts, the corroboration branch is entirely skipped: every PASS
  // candidate goes to PROMOTE. Reasoning: a single nearest neighbour at
  // distance < threshold is just as likely to be coincidence as semantic
  // agreement when the index is this sparse; "agreement" requires multiple
  // independent votes which a <50-entry index cannot supply.
  SALIENCE_CORROBORATE_MIN_INDEX_SIZE: 50,
  // A3 (memory-roots node codex-authorship-axis) — speaker-derived authorship
  // for the two agent-transcript sources (codex-cli, chat-claude-code).
  // kb/ingestion.md:140: "consent_basis is about consent to ingestion, not
  // about authorship" — and on those two sources consent_basis is first_party
  // on 100% of rows, so it cannot tell the operator's words from the agent's
  // narration. When true, authorshipScore keys those sources on
  // raw_content.user_text (non-empty → operator-authored 1.0, else the agent
  // rung below) and resolves every other source's consent via
  // event.consent_basis ?? event.source_policy.consent_basis (the daemon path
  // passes the raw source row, where the field lives under source_policy).
  // When false, authorshipScore reproduces the pre-A3 rule byte-for-byte,
  // including the absent hoist, so the old regime stays diffable.
  SALIENCE_SPEAKER_AUTHORSHIP_ENABLED: true,
  // A3 — the agent-authored rung: one step below the R21 third-party human
  // value (0.6), the same step that separates first party (1.0) from third
  // party. Rerank information only (kb/salience-design.md:54); never a gate.
  SALIENCE_AUTHORSHIP_AGENT: 0.4,
  // A5 (memory-roots node codex-speaker-guard) — speaker guard on the
  // Layer-3 kNN CORROBORATE branch (salience.js scoreCandidate).
  //
  // SALIENCE_CORROBORATE_SPEAKER_GUARD_ENABLED — when true (default), a row
  // that carries the operator's own words (raw_content.user_text non-blank,
  // auto_injected !== true, not matching the scaffold regex below) is NOT
  // folded into a nearest-neighbour fact at cosine_distance < threshold; it
  // falls through to PROMOTE with `novelty` = the raw kNN distance. The
  // corroboration keeps only a target_id, so before this guard the operator's
  // words left the ledger whenever any fact — usually the agent's own
  // narration — sat within 0.25 of them. Measured 2026-09-02..09-08 (A4 /
  // FA4-1, FA4-4): codex-cli 663 operator-word rows / 338 promoted / 230 kNN-
  // corroborated (51.0% admission); chat-claude-code 274 / 116 / 158 (42.3%).
  // Scaffold rows are a separate class and stay foldable: 221 codex
  // `<recommended_plugins>` envelope rows in the window, 118 reply-less (those
  // now DROP at Stage-0 rule 3 per FA6-1 and never reach kNN) and 103 with a
  // reply (those still reach kNN and still CORROBORATE under the guard).
  //
  // Precedence: the guard sits AFTER the Layer-2.5 content-hash branch
  // (CASCADE_CONTENT_DEDUP_ENABLED, lookupCanonical) and only inside the kNN
  // branch, so a byte-identical re-paste of an operator turn still folds with
  // reason="content_duplicate_no_embed" — the guard protects distinct
  // operator words, not repeats. When false, the kNN branch fires on distance
  // alone and emits the unchanged policy.corroboration shape (byte-for-byte
  // the pre-A5 routing). No new policy kind, reason string, or telemetry key.
  SALIENCE_CORROBORATE_SPEAKER_GUARD_ENABLED: true,
  // A5 — scaffold regex SOURCE for the guard's "not operator words" test.
  // Mirrors Stage-0's SCAFFOLD_USER_RE (mcp/lib/ingest/stage0/codex-cli.js,
  // including the A6 `recommended_plugins` token) character-for-character;
  // salience.js compiles it with the "i" flag exactly as Stage-0 does.
  // Kept as a CAPS string (like SALIENCE_BOILERPLATE_REGEX) because
  // salience.js loads stage0 dynamically and must not import the module
  // statically. T-A5-6 (salience-cascade.test.mjs) asserts this string ===
  // stage0 _internals.SCAFFOLD_USER_RE.source, so the two cannot drift
  // silently. A row matching it is a harness envelope threaded in as a
  // pseudo-user turn (environment_context, system_prompt, recommended_plugins,
  // ...), never the operator speaking.
  SALIENCE_SPEAKER_GUARD_SCAFFOLD_REGEX:
    "^\\s*(?:<(?:environment_context|system_prompt|goal_context|subagent_notification|INSTRUCTIONS|thesis_statement|counterpart_gaps|turn_aborted|session_aborted|tool_use_error|command_interrupted|recommended_plugins)\\b|# AGENTS\\.md instructions for|CONTEXT AND INSTRUCTIONS:)",
  // -----------------------------------------------------------------------
  // WU2-inline-embed-and-remove-gemini-quota-machinery removed
  // CASCADE_PROMOTE_WITHOUT_EMBED_ENABLED here. The cascade now embeds inline
  // via the local Qwen3 server (lib/local-embedder-client.js), which has no
  // per-key quota to exhaust; the Gemini-quota PROMOTE_WITHOUT_EMBED /
  // EMBED_DEFERRED circuit-breaker it gated was deleted. On a local-server
  // outage the cascade promotes with embedding=null and records the fact id
  // to the simple re-embed sweep file (see daemons/watermark.js
  // appendReEmbedSweep) — no CAP toggle, no async queue.
  // -----------------------------------------------------------------------
  // WU1-promote-time-content-dedup-gate — EMBEDDING-FREE content-dedup gate.
  // Authoritative: lib/synthesis/content-index.js header.
  //
  // CASCADE_CONTENT_DEDUP_ENABLED — when true (default), salience.js
  // scoreCandidate runs a Layer-2.5 content-hash dedup check AFTER Stage-1
  // structural PASS and BEFORE the Layer-3 embed / PROMOTE_WITHOUT_EMBED
  // branches. If ctx.contentIndex is wired AND the candidate's normalized
  // content already maps to an EARLIER canonical fact_id (not the
  // candidate's own id), the cascade returns CORROBORATE
  // (target_id=canonical, reason="content_duplicate_no_embed") instead of
  // writing a redundant fact row — the content-hash analog of the dead
  // Layer-3 embed+kNN CORROBORATE while the Gemini pool is cooled.
  //
  // This is the "stop allowing it" fix for the ~1.33M duplicate noise facts
  // the cascade persisted under capture-everything-while-embeddings-are-null.
  // When false, the gate never fires (back-compat: every PASS candidate
  // flows through the existing embed/promote branches verbatim). The gate is
  // ALSO inert when ctx.contentIndex is absent (hermetic tests, legacy
  // callers, index-load failure) — degrade to normal promote, never block.
  CASCADE_CONTENT_DEDUP_ENABLED: true,
  // -----------------------------------------------------------------------
  // WORKUNIT A-promote-projection — promote-time completeness stamps. Each
  // flag gates ONE additive feature stamped at the single promote chokepoint
  // (appendFactRow). All default ON (sensible default per the workunit) but
  // are individually CAPS-gated so an operator can disable any one without a
  // code change if it ever regresses a downstream reader. Every gate is
  // additive + defensive: when false the row promotes exactly as before
  // (Thesis #1 — only NEW rows are ever shaped; no existing row is mutated).
  //
  // CASCADE_VALENCE_STAMP_ENABLED — stamp features.valence as the structured
  //   {sign, magnitude, source, model_version} ValenceValue object from
  //   scoreValence(content). MUST run BEFORE episodicity scoring so the
  //   episodicity scorer's narrative_valence_magnitude input is populated.
  CASCADE_VALENCE_STAMP_ENABLED: true,
  // CASCADE_GAZETTEER_ENABLED — run the closed-set gazetteer recognizer
  //   (lib/synthesis/gazetteer.js) additively AFTER the structural entity
  //   extractor, merging kb_lookup-evidence entities into features.entities.
  CASCADE_GAZETTEER_ENABLED: true,
  // CASCADE_THREAD_KEYS_ENABLED — forward the source event's identity keys
  //   {chat_guid, chat_identifier, repo_path, author_email, actor_login,
  //   repo, conversation_id} onto the fact (features.thread_keys) so the
  //   thread / project aggregators can bucket NEW facts without a join back
  //   to the source ledger.
  CASCADE_THREAD_KEYS_ENABLED: true,
  // CASCADE_TS_MIRROR_ENABLED — stamp a top-level `ts` mirror of created_at
  //   on NEW facts so the aggregators' ts-presence guard passes on the
  //   promote-side row (read-side backlog is N7b's concern).
  CASCADE_TS_MIRROR_ENABLED: true,
  // CASCADE_ATTRIBUTION_ENABLED — stamp a top-level parties[] (connector
  //   audience array, verbatim) and a bounded, closed-key features.attribution
  //   subset {sender_id, sender_name, peer_id, peer_name, peer_type,
  //   is_outgoing, is_self, reply_to, fwd_from} on NEW messaging facts
  //   (telegram/imessage/whatsapp/mail) so the recall read-side can surface
  //   sender + direction. The full raw_content is NEVER re-attached.
  CASCADE_ATTRIBUTION_ENABLED: true,
  // EMBED_STATE_VALUES — closed enum of the features.embed_state tracking
  // flag's logical states. The W2-CCS ship persists embed_state as a
  // BOOLEAN on the fact row (true ↔ "pending"; false ↔ "ready"; absent ↔
  // pre-W2 legacy row). This enum is the forward-compat name vocabulary the
  // W5-CCS spec uses to discuss state transitions in operator docs and the
  // additive-recall scorer's branch labels. The boolean persistence is
  // preserved verbatim so existing fact rows + the multi-feature-score
  // null-embedding branch (lib/recall/multi-feature-score.js § 4.2) stays
  // byte-stable. A future migration may move the on-disk shape to the
  // string enum once all readers handle both.
  //   - "ready"          : embedding_3072 + embedding_mrl_768 populated.
  //   - "pending"        : null embedding; backfill queue has the fact_id.
  //   - "permanent_null" : null embedding; content was empty / unembeddable
  //                        at promote time and no backfill will succeed.
  //                        Reserved for a future drift-detector pass that
  //                        moves stuck "pending" rows after N attempts.
  EMBED_STATE_VALUES: Object.freeze(["ready", "pending", "permanent_null"]),
  // -----------------------------------------------------------------------
  // R29 Gemini API key pool + R30 round-robin rotation discipline.
  // Authoritative spec: reviews/r29/spec.md § A-C and reviews/r30/plan.md.
  // -----------------------------------------------------------------------
  // R30: Seconds a key parks in a post-429 skip window. Round-robin
  // rotation across keys is the primary discipline; this cooldown is a
  // politeness window so we don't hammer Google immediately on a key
  // that just 429'd. 60s aligns with Google's per-minute rate-limit
  // recovery cadence: a key 429'd 30s ago is still skipped (still in
  // Google's rate-limit window); 70s after the 429 the key is re-eligible.
  // Per-day quotas surface as every-request-429 — the throttle layer
  // (ThrottledStructuralError) absorbs the log. Set to 0 to disable the
  // cooldown entirely (pure round-robin; a 429'd key is immediately
  // re-eligible — only useful in tests or when the operator explicitly
  // accepts the abuse-pattern risk).
  GEMINI_KEY_COOLDOWN_SECONDS: 60,
  // Hard cap on the parsed GEMINI_API_KEYS pool. 32 is well above any
  // realistic per-operator key count and bounds the worst-case state map.
  GEMINI_KEY_POOL_MAX_SIZE: 32,
  // R37: PROACTIVE per-minute rate-limit ceiling per key. Gemini free-tier
  // `gemini-embedding-001` quota is 5 RPM per project. The R30 60s cooldown
  // is a REACTIVE response to an observed 429/403; the RPM tracker is an
  // ADDITIVE proactive filter that skips a key when its rolling 60s call
  // count has reached the limit, BEFORE a request is fired. Coexists with
  // (not replaces) the cooldown. Set to 0 to disable the proactive filter
  // entirely (pure round-robin + cooldown only). The window is the rolling
  // sample size for the count.
  GEMINI_KEY_RPM_LIMIT: 5,
  GEMINI_KEY_RPM_WINDOW_MS: 60000,
  // -----------------------------------------------------------------------
  // WU2-inline-embed-and-remove-gemini-quota-machinery removed the pool-wide
  // GEMINI_NETWORK_* circuit-breaker caps and the CASCADE_SKIP_EMBED_*
  // backlog-skip caps. Those gated the cascade-vs-embed-worker network-
  // contention workaround that only existed because the cascade shared the
  // Gemini connection pool with the async embed-backfill worker. The cascade
  // now embeds inline via the local server and the async worker is gone, so
  // there is no shared pool to starve and no backlog to skip on. The Gemini
  // key pool (cooldown + RPM) remains for the recall/_corroborate embed call
  // sites + the Flash reranker, but nothing consults a network breaker now.
  // -----------------------------------------------------------------------
  // Wave 9 — recall-log-split.md § 6.7 engagement-detector caps.
  // Authoritative shape contract: docs/specs/synthesis/recall-log-split.md.
  // The 5-class taxonomy is FIXED; the weights are signed (dismiss is -0.5,
  // an active anti-reinforcement signal stronger than raw surfacing).
  // The detector MUST source weights from this block by class name (invariant
  // I11). Inlining custom numeric weights at call sites is a CI failure.
  // -----------------------------------------------------------------------
  RECALL_K_TURN_WINDOW: 3,
  ENGAGEMENT_WEIGHTS: Object.freeze({
    direct: 1.0,
    paraphrase: 0.6,
    correction: 0.4,
    dismiss: -0.5,
    no_engagement: 0.0,
  }),
  ENGAGEMENT_FUZZY_THRESHOLD: 0.75,
  // F-SYN-INTEGRATION-ENGAGEMENT-DETECTOR-WIRING — v0 keyword-heuristic
  // detector token-match minimum (contiguous-word run length for `direct`).
  ENGAGEMENT_DIRECT_MIN_TOKENS: 3,
  // Engagement-queue path (the non-blocking hook-side queue the watermark
  // daemon polls in its idle tick — HOOKS-NEVER-BLOCK discipline per
  // kb/agent-integration.md). Bounded growth: the daemon trims on each poll.
  ENGAGEMENT_QUEUE_MAX_LINES: 10000,
});

// SALIENCE_WEIGHTS_V1_HASH — sha256(canonicalJson(SALIENCE_WEIGHTS_V1)) sliced
// to 32 hex chars. Derived from the weights dict above so a weight bump
// automatically produces a new hash without manual bookkeeping. Pinned into
// every fact row's features.salience.weights_hash and into the rerank
// audit-provenance snapshot for R19 audit. Computed at module load time
// (Object.freeze on the weights makes the derivation deterministic).
const _saliencW1Canon = canonicalize(CAPS.SALIENCE_WEIGHTS_V1);
export const SALIENCE_WEIGHTS_V1_HASH = createHash("sha256")
  .update(Buffer.from(_saliencW1Canon, "utf8"))
  .digest("hex")
  .slice(0, 32);

// Re-export individual caps as named constants for callers that want them
// without the CAPS prefix. Matches spec-4 § Caps export contract.
export const RECALL_MAX_ITEMS = CAPS.RECALL_MAX_ITEMS;
export const RECALL_MAX_CHARS = CAPS.RECALL_MAX_CHARS;
export const RECALL_PER_MEMORY_CONTENT_CHARS = CAPS.RECALL_PER_MEMORY_CONTENT_CHARS;
export const RECALL_LOG_TTL_SECONDS = CAPS.RECALL_LOG_TTL_SECONDS;
export const PREDICATE_MAX_ENTITIES = CAPS.PREDICATE_MAX_ENTITIES;
export const PREDICATE_MAX_EMBEDDING_DIMS = CAPS.PREDICATE_MAX_EMBEDDING_DIMS;
export const PREDICATE_MIN_EMBEDDING_DIMS = CAPS.PREDICATE_MIN_EMBEDDING_DIMS;
export const PREDICATE_MAX_ACTIVE = CAPS.PREDICATE_MAX_ACTIVE;
export const REPLACE_NEW_EVENT_CONTENT_CHARS = CAPS.REPLACE_NEW_EVENT_CONTENT_CHARS;
export const SUBSTITUTE_TRANSFORM_CHARS = CAPS.SUBSTITUTE_TRANSFORM_CHARS;
export const CONTENT_MAX_CHARS = CAPS.CONTENT_MAX_CHARS;
export const CHAT_LEDGER_TAIL_READ_MAX_BYTES = CAPS.CHAT_LEDGER_TAIL_READ_MAX_BYTES;
export const INFLIGHT_RECLAIM_AGE_SECONDS = CAPS.INFLIGHT_RECLAIM_AGE_SECONDS;
export const DERIVATION_WALK_MAX_DEPTH = CAPS.DERIVATION_WALK_MAX_DEPTH;
export const DERIVATION_WALK_MAX_NODES = CAPS.DERIVATION_WALK_MAX_NODES;
export const EXCISE_REDERIVE_MAX_NODES = CAPS.EXCISE_REDERIVE_MAX_NODES;
export const CONSUMED_NONCE_TTL_SECONDS = CAPS.CONSUMED_NONCE_TTL_SECONDS;
export const STALE_LOCK_RECOVERY_SECONDS = CAPS.STALE_LOCK_RECOVERY_SECONDS;
export const LIST_PREDICATES_MAX_ITEMS = CAPS.LIST_PREDICATES_MAX_ITEMS;
export const LIST_QUARANTINE_MAX_ITEMS = CAPS.LIST_QUARANTINE_MAX_ITEMS;
export const LIST_CONNECTORS_MAX_ITEMS = CAPS.LIST_CONNECTORS_MAX_ITEMS;
// WU1-local-embedder-client-and-dim4096 — local Qwen3 full-4096 contract.
export const EMBEDDING_DIM_4096 = CAPS.EMBEDDING_DIM_4096;
export const ACTIVE_EMBED_MODEL_VERSION = CAPS.ACTIVE_EMBED_MODEL_VERSION;

function fail(msg, details) {
  throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, msg, details);
}

export function assertObject(value, fieldName) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${fieldName} must be an object`);
  }
  return value;
}

export function assertNonEmptyString(value, fieldName, { maxChars } = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${fieldName} must be a non-empty string`);
  }
  if (maxChars != null && value.length > maxChars) {
    fail(`${fieldName} exceeds ${maxChars} chars`);
  }
  return value;
}

export function assertOptionalString(value, fieldName, { maxChars } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    fail(`${fieldName} must be a string`);
  }
  if (maxChars != null && value.length > maxChars) {
    fail(`${fieldName} exceeds ${maxChars} chars`);
  }
  return value;
}

export function assertEnum(value, allowed, fieldName) {
  if (!allowed.includes(value)) {
    fail(`${fieldName} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

export function assertIntInRange(value, fieldName, { min, max } = {}) {
  if (!Number.isInteger(value)) {
    fail(`${fieldName} must be an integer`);
  }
  if (min != null && value < min) fail(`${fieldName} must be >= ${min}`);
  if (max != null && value > max) fail(`${fieldName} must be <= ${max}`);
  return value;
}

export function assertOptionalIntInRange(value, fieldName, opts) {
  if (value === undefined || value === null) return null;
  return assertIntInRange(value, fieldName, opts);
}

export function assertNumberInRange(value, fieldName, { min, max } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${fieldName} must be a finite number`);
  }
  if (min != null && value < min) fail(`${fieldName} must be >= ${min}`);
  if (max != null && value > max) fail(`${fieldName} must be <= ${max}`);
  return value;
}

export function assertStringArray(value, fieldName, { maxItems, maxItemChars } = {}) {
  if (!Array.isArray(value)) fail(`${fieldName} must be an array`);
  if (maxItems != null && value.length > maxItems) {
    fail(`${fieldName} exceeds max ${maxItems} items`);
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") {
      fail(`${fieldName}[${i}] must be a string`);
    }
    if (maxItemChars != null && value[i].length > maxItemChars) {
      fail(`${fieldName}[${i}] exceeds ${maxItemChars} chars`);
    }
  }
  return value;
}

export function assertOptionalStringArray(value, fieldName, opts) {
  if (value === undefined || value === null) return [];
  return assertStringArray(value, fieldName, opts);
}

export function assertNumberArray(value, fieldName, { maxItems } = {}) {
  if (!Array.isArray(value)) fail(`${fieldName} must be an array of numbers`);
  if (maxItems != null && value.length > maxItems) {
    fail(`${fieldName} exceeds max ${maxItems} dims`);
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "number" || !Number.isFinite(value[i])) {
      fail(`${fieldName}[${i}] must be a finite number`);
    }
  }
  return value;
}

// Embedding-vector validation. Rejects zero-length and single-element vectors;
// enforces both the spec's PREDICATE_MIN_EMBEDDING_DIMS (16) and
// PREDICATE_MAX_EMBEDDING_DIMS (1536). Designed for callers passing distillation
// embeddings; not used for arbitrary numeric arrays.
export function assertEmbedding(value, fieldName) {
  if (!Array.isArray(value)) {
    fail(`${fieldName} must be an array of numbers`);
  }
  if (value.length < PREDICATE_MIN_EMBEDDING_DIMS) {
    fail(`${fieldName} must have at least ${PREDICATE_MIN_EMBEDDING_DIMS} dimensions`);
  }
  if (value.length > PREDICATE_MAX_EMBEDDING_DIMS) {
    fail(`${fieldName} exceeds max ${PREDICATE_MAX_EMBEDDING_DIMS} dimensions`);
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "number" || !Number.isFinite(value[i])) {
      fail(`${fieldName}[${i}] must be a finite number`);
    }
  }
  return value;
}

// Strict RFC 3339 / ISO-8601 timestamp regex. Permits fractional seconds and
// either "Z" or a numeric ±HH:MM offset. Rejects bare dates ("2026-05-30"),
// freeform strings ("Jan 5 2026", "tomorrow"), and years alone ("2026") — the
// loose `new Date(value)` parser previously here accepted all of those.
const ISO8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function assertIso8601(value, fieldName) {
  assertNonEmptyString(value, fieldName);
  if (!ISO8601_RE.test(value)) {
    fail(`${fieldName} must be a valid RFC 3339 timestamp`);
  }
  // Regex passes shape; cross-check the calendar so 2026-02-30T... fails.
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    fail(`${fieldName} must be a valid RFC 3339 timestamp`);
  }
  return value;
}

export function assertOptionalIso8601(value, fieldName) {
  if (value === undefined || value === null) return null;
  return assertIso8601(value, fieldName);
}

// Shape check: assert no unknown keys are present beyond `allowed`. Permissive
// fail-shut; we want unknown caller fields to error rather than silently drop.
export function assertObjectShape(value, fieldName, allowed) {
  assertObject(value, fieldName);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`${fieldName} has unknown field "${key}"`);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// canonical_json (RFC 8785 JCS)
// ---------------------------------------------------------------------------
// Reference: kb/mcp-surface.md § Privilege levels canonical JSON encoding.
//
// JCS (RFC 8785) requires:
//  - Object keys sorted lexicographically by UTF-16 code units (NOT byte-wise).
//  - No whitespace anywhere; no trailing commas.
//  - Strings preserved as-is per RFC 8785 §3.2.2.2 — **no NFC normalization**.
//  - Numbers serialized per ECMA-262 Number.prototype.toString (IEEE-754
//    shortest-round-trip; integers without trailing ".0").
//  - Arrays preserve insertion order.
//  - `null`, `true`, `false` as literals.
//
// Implementation: delegate to the `canonicalize` npm package (cyberphone JS
// port, the canonical test source the spec mandates). Rolling our own JCS
// silently violated §3.2.2.2 by normalizing to NFC; the library does not.
import canonicalize from "canonicalize";

// Returns the canonical JSON string (UTF-8 codepoints; callers can take
// Buffer.from(result, "utf8") to get bytes). Throws on undefined inputs and
// on values the library cannot encode (function / symbol / bigint).
export function canonicalJson(value) {
  if (value === undefined) {
    throw new Error("canonical_json: undefined is not a JSON value");
  }
  const out = canonicalize(value);
  if (out === undefined) {
    throw new Error("canonical_json: value not encodable as JSON");
  }
  return out;
}

// Convenience helper for the binding_hash discipline — sha256 of the canonical
// JSON bytes, returned as lowercase hex.
export function canonicalJsonSha256Hex(value) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Inline tests / spec-4 test vector
// ---------------------------------------------------------------------------
// kb/mcp-surface.md § Privilege levels:
//
//   binding_object = {
//     "target": "mem_01HZX8K9PQRS",
//     "scope": "memory_ledger_only",
//     "derivation_policy": "retain",
//     "silent": false
//   }
//
//   canonical_json bytes (102 bytes):
//   {"derivation_policy":"retain","scope":"memory_ledger_only","silent":false,"target":"mem_01HZX8K9PQRS"}
//
// Frozen sha256 (lowercase hex), authoritative per spec § Privilege levels:
//   5d6109a311a8ed773135c518c8a5e72bc226d68ef7d592d74c3321a1dc30a17d
//
// test/canonical-json.test.mjs asserts this hex + the non-ASCII probe pair;
// mismatch is a conformance failure. Not illustrative; not pending.
//
// Pass cases for assertIso8601:
//   "2026-05-30T12:34:56Z"
//   "2026-05-30T12:34:56+00:00"
//   "2026-05-30T12:34:56.789Z"
//
// Fail cases for assertIso8601:
//   "2026", "Jan 5 2026", "tomorrow", "2026-05-30"
//
// Pass cases for assertEmbedding: arrays length in [16, 1536] of finite numbers.
// Fail cases: [], [0.1], length > 1536, non-finite element.
