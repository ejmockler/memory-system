# Phase 3 v0 — Authoritative Shape Contracts

This file is the AUTHORITATIVE shape contract for all Phase 3 v0 (recall layer)
components. Every downstream agent reads this and targets these shapes
exactly. Deviation is drift.

Authoritative spec source: `<checkout>/kb/research-retrieval-frontiers.md`
(read sections "Direct answer", "Recommended Phase 3 architecture", "Gemini
integration specifics", and "Staged rollout plan" before any implementation).

---

## 0. Pipeline summary (load-bearing recap)

Phase 3 v0 implements the recall layer as a layered pipeline:

- Layer 1: HYBRID candidate generation. BM25 + HNSW over MRL-768d vectors,
  RRF fused (k=60). Per-segment MaxSim across `surrounding_context` segments
  (`current_query`, each `recent_turn`, `agent_role`, resolved
  `time_anchor`). Top-50 candidate set.
- Layer 2: HARD GATES + RESCORE. After RRF fusion: predicate exclusion
  (snapshot-embedding match), `consent_basis` filter, `derivation_orphan`
  flag. Then full-3072d cosine rescore. Multi-feature score per
  `ScoreComponents` below. Multiplicative gates around additive soft features.
  NOT Park-style equal-weight additive.
- Layer 3: RERANK. NOT IN V0 — deferred to v1.
- Layer 4: MMR diversification (`lambda=0.7`, NOT LangChain default 0.5).
  Final brief ≤ 12 items, ≤ 4000 chars total, ≤ 600 chars per item.

Asymmetric task-type discipline:
- promote-time embeds with `task_type=RETRIEVAL_DOCUMENT`
- recall-time defaults to `RETRIEVAL_QUERY`; switches to
  `QUESTION_ANSWERING` when the resolved `current_query` (or trailing
  `recent_turn`) ends in `?`; switches to `FACT_VERIFICATION` for
  verification-style recall.
- Always call REST `embedContent` directly. SDKs (LangChain, Semantic
  Kernel, LiteLLM) silently drop `task_type`.

L2-norm invariant: `gemini-embedding-001` returns unit-norm vectors ONLY at
default 3072d. Sliced 768d vectors have norm ~0.59 and MUST be
L2-renormalized before any dot-product-as-cosine. Pipeline-wide invariant:
assert `||v|| = 1.0 ± 1e-6` at every layer; fail closed on violation.

Model pinning: `gemini-embedding-001` only. Do NOT use `gemini-embedding-2` —
Phase A empirically verified it silently ignores `taskType` (cosine 1.0
across all task types on identical strings).

---

## 1. IndexEntry shape

<!-- BEGIN-CANONICAL: phase3_v0_index_entry_shape -->
What the per-version indices store for each memory. Built at promote-time
(distill-promote-fact.js) and at backfill-time (scripts/backfill-embeddings.mjs).

```js
{
  memory_id: string,            // event.id (the ledger event id)
  kind: "fact" | "policy" | "recall" | "reconstructed",
  content: string,              // event.content; full text for BM25 indexing
  embedding_768: Float32Array,  // MRL-sliced from 3072d gemini-embedding-001
                                // RETRIEVAL_DOCUMENT vec, then L2-renormalized
  embedding_3072: Float32Array, // full 3072d, NOT renormalized (already unit
                                // norm at 3072)
  embedding_model_version: string, // "gemini-embedding-001" or similar
  ts: string,                   // event.ts (ISO-8601, RFC 3339)
  entities: string[],           // event.features.entities, lowercased + deduped
  valence: number | null,       // event.features.valence; -1.0 to +1.0;
                                // null if unset
  derivation_distance: number | null,
                                // null when the candidate is NOT a transitive
                                // orphan (NORMAL); 0..MAX_DERIVATION_DEPTH for
                                // the BFS-shortest-path distance to the
                                // nearest active excise seed. Derived boolean
                                // accessor: is_orphan = derivation_distance != null.
                                // d=1 (direct orphan) is the v0 anchor case;
                                // d>1 is transitive — propagated via the
                                // reverse-adjacency walk in
                                // mcp/lib/recall/hard-gates.js
                                // (loadTransitiveOrphanMap). Corroboration
                                // rescue can re-set this to null mid-walk.
                                // Authoritative: kb/transitive-orphan-design.md.
  consent_basis: "first_party" | "third_party_inferred" | string
}
```

Invariants:
- `||embedding_768|| = 1.0 ± 1e-6` (after MRL slice + L2 renorm).
- `||embedding_3072|| = 1.0 ± 1e-6` (native unit norm at default dim).
- `embedding_model_version` matches the per-version index directory:
  `indices/<embedding_model_version>/{hnsw.bin,bm25.json}`.
<!-- END-CANONICAL: phase3_v0_index_entry_shape -->

---

## 2. SegmentVector shape

One vector per `surrounding_context` segment at recall time. The recall
layer never collapses segments into a single pooled query embedding for
ranking; per-segment MaxSim preserves the distinct contribution of each
segment.

```js
{
  segment_role: "current_query" | "recent_turn_<i>" | "agent_role" | "time_anchor",
  vector: Float32Array,         // 3072d at recall time. NO MRL slice yet —
                                // slicing to 768d happens only at ANN-query
                                // time inside the HNSW retriever.
  task_type: "RETRIEVAL_QUERY" | "QUESTION_ANSWERING" | "FACT_VERIFICATION"
}
```

Notes:
- `recent_turn_<i>` indexes match the position in
  `surrounding_context.recent_turns[]` (0-indexed).
- The HNSW retriever slices to 768d + L2-renormalizes for ANN; the rescore
  layer (Layer 2) uses the full 3072d vector for cosine rescore.

---

## 3. ScoreComponents shape

<!-- BEGIN-CANONICAL: phase3_v0_score_components_shape -->
One per candidate per recall. Persisted in the recall ledger event under
`surfaced[].feature_breakdown` (without `final_score`).

```js
{
  memory_id: string,
  s_emb_full3072: number,         // full-dim cosine; the gate's primary signal
  predicate_mask: 0 | 1,          // 0 if excluded by any active predicate
  consent_dampener: number,       // 1.0 first_party; 0.6 third_party_inferred;
                                  // additional values per CAPS table
  derivation_status: number,      // 1.0 normal; depth-aware orphan dampener
                                  // otherwise. Formula (kb/transitive-orphan-
                                  // design.md § 4):
                                  //   max(FLOOR, exp(-LAMBDA*(d-1)) * ORPHAN)
                                  // d=1 -> 0.5 (v0 anchor); d=2 -> ~0.335;
                                  // d>=3 -> 0.25 (FLOOR). Backward compat:
                                  // the v0 boolean orphan flag at 0.5
                                  // remains the d=1 number exactly.
  episodicity_match: number,      // 1.0 default v0 (episodicity feature is v2)
  entity_overlap_jaccard: number, // |A intersect B| / |A union B| over entities
  time_anchor_match: number,      // 0..1 if surrounding_context has a time
                                  // anchor AND candidate matches; else 0
  power_law_decay: number,        // Wixted m*(1+h*t)^(-f) per kind
  valence_compat: number,         // -1..+1
  engagement_prior: number,       // 0 in v0; updates from recall-log in v3
  final_score: number             // computed via the multi-feature formula:
                                  //  base = s_emb_full3072
                                  //       * predicate_mask
                                  //       * consent_dampener
                                  //       * derivation_status
                                  //       * episodicity_match
                                  //  add  = w_ent * entity_overlap_jaccard
                                  //       + w_t1  * time_anchor_match  (gated
                                  //                                     to 0
                                  //                                     if no
                                  //                                     anchor)
                                  //       + w_t2  * power_law_decay
                                  //       + w_val * valence_compat
                                  //       + w_eng * engagement_prior
                                  //  final_score = base + add
}
```

Weights are sourced from CAPS (§ 8):
- `w_ent` = `CAPS.SCORE_WEIGHT_ENTITY_OVERLAP` (0.7)
- `w_t1`  = `CAPS.SCORE_WEIGHT_TIME_ANCHOR`    (1.5)
- `w_t2`  = `CAPS.SCORE_WEIGHT_TIME_DECAY`     (0.3)
- `w_val` = `CAPS.SCORE_WEIGHT_VALENCE`        (0.2)
- `w_eng` = `CAPS.SCORE_WEIGHT_ENGAGEMENT_PRIOR` (0.0 in v0)

Multiplicative gates wrap the embedding signal; additive soft features
contribute on top. This is intentional and contrasts with Park-style
equal-weight additive scoring.
<!-- END-CANONICAL: phase3_v0_score_components_shape -->

---

## 4. Brief envelope (recall.js return type)

```js
{
  brief: Array<{
    memory_id: string,
    content_excerpt: string,     // truncated to RECALL_BRIEF_MAX_CHARS_PER_ITEM
    score: number,               // final_score from ScoreComponents
    position: number,            // 0-indexed position in the surfaced brief
    propensity: number,          // Plackett-Luce probability for this item
                                 // at its observed position
    kind: "fact" | "policy" | "recall" | "reconstructed",
    ts: string                   // memory's original ts
  }>,
  density_flag: "ok" | "crowded" | "sparse",
                                 // "crowded" if avg pairwise cosine over the
                                 //   surfaced brief > 0.85, OR if >6 items
                                 //   pass the relevance bar at similar scores
                                 // "sparse" if surfaced brief is empty or
                                 //   substantially smaller than caller's
                                 //   max_items
                                 // "ok" otherwise
  degraded_recall: boolean,      // true if BM25-only fallback fired (Gemini
                                 // outage at recall-time)
  recall_id: string,             // the ledger event id of this recall
  candidate_set_size: number     // pre-truncation count (before MMR + caps)
}
```

Caps:
- `brief.length` ≤ `CAPS.RECALL_BRIEF_MAX_ITEMS` (12)
- sum of `content_excerpt.length` ≤ `CAPS.RECALL_BRIEF_MAX_CHARS_TOTAL` (4000)
- each `content_excerpt.length` ≤ `CAPS.RECALL_BRIEF_MAX_CHARS_PER_ITEM` (600)

The brief envelope is what the MCP `memory_recall` tool returns inside its
`result`. The recall-log ledger event (§ 5) is written in the same handler
call as the brief is computed.

---

## 5. Recall ledger event extension

<!-- BEGIN-CANONICAL: phase3_v0_recall_ledger_event_shape -->
What `recall-log.js` (the recall-substrate ledger writer) appends. This is
the substrate for v3 learning (Plackett-Luce off-policy evaluation).

```js
{
  id: string,                          // recall_id
  ts: string,                          // ISO-8601 recall timestamp
  kind: "recall",
  query: {
    surrounding_context_hash: string,  // sha256 hex of canonical_json(
                                       //   surrounding_context)
    context_embedding: number[],       // the recall-time query vector for
                                       // predicate snapshotting; either the
                                       // first segment vector OR a designated
                                       // pooled embedding; 3072d
    embedding_model_version: string
  },
  surfaced: Array<{
    memory_id: string,
    score: number,                     // final_score
    position: number,
    propensity: number,                // P_j ∝ exp(s_j / tau) over the
                                       // candidate set; logged with the
                                       // 5% deterministic jitter applied
    feature_breakdown: {               // ScoreComponents WITHOUT final_score
      s_emb_full3072: number,
      predicate_mask: 0 | 1,
      consent_dampener: number,
      derivation_status: number,       // depth-aware gate value (see § 3)
      derivation_distance: number | null,
                                       // raw BFS distance to nearest
                                       // active excise seed; null when
                                       // NORMAL. Logged alongside
                                       // derivation_status so v3
                                       // off-policy estimators have both
                                       // the gate output and its preimage.
      episodicity_match: number,
      entity_overlap_jaccard: number,
      time_anchor_match: number,
      power_law_decay: number,
      valence_compat: number,
      engagement_prior: number
    }
  }>,
  candidates_pre_truncation: Array<{
    memory_id: string,
    position: number,                  // 0-indexed in the pre-truncation
                                       // top-K candidate set
    score: number                      // final_score on the same scale as
                                       // surfaced[].score
  }>,                                  // length up to
                                       //   CAPS.RECALL_CANDIDATE_SET_SIZE (50)
  density_flag: "ok" | "crowded" | "sparse",
  degraded_recall: boolean
}
```

Propensity discipline (load-bearing for v3 off-policy estimation):
- Surfaced item `j` with score `s_j` and softmax temperature `tau` has
  `P_j ∝ exp(s_j / tau)` over the candidate set.
- A 5% score jitter (`CAPS.PROPENSITY_JITTER_FRACTION`) is sampled from a
  deterministic-per-`recall_id` source (e.g. seeded xorshift over the
  recall_id bytes). This keeps OPE estimators unbiased.
- Both the jittered score AND the resulting `propensity` are logged.
<!-- END-CANONICAL: phase3_v0_recall_ledger_event_shape -->

---

## 6. Predicate snapshot shape

<!-- BEGIN-CANONICAL: phase3_v0_predicate_snapshot_shape -->
For `memory_exclude` server-snapshot-at-exclude-time semantics. Stored
alongside the existing predicate spec; this shape is the snapshot the
predicate carries forward as it ages.

```js
{
  predicate_id: string,
  query_embedding_3072: number[],     // captured at predicate-creation time;
                                      // 3072d; embedding_model_version-tagged
  embedding_model_version: string,
  scope: { /* matches existing predicate spec — kb/mcp-surface.md */ },
  active: boolean
}
```

Note: the predicate's runtime `embedding` field in the existing predicate
spec stays at <= 1536 dims per `CAPS.PREDICATE_MAX_EMBEDDING_DIMS`. The
3072d `query_embedding_3072` is a separate snapshot used for full-fidelity
match at recall-rescore time. The two coexist; the legacy field is what
older callers see, the new snapshot is what Layer 2 gating uses.
<!-- END-CANONICAL: phase3_v0_predicate_snapshot_shape -->

---

## 7. File layout

```
<checkout>/mcp/lib/gemini-client.js
<checkout>/mcp/lib/recall/bm25-index.js
<checkout>/mcp/lib/recall/hnsw-index.js
<checkout>/mcp/lib/recall/hard-gates.js
<checkout>/mcp/lib/recall/multi-feature-score.js
<checkout>/mcp/lib/recall/mmr.js
<checkout>/mcp/lib/recall/propensity.js
<checkout>/mcp/lib/recall/hybrid-retriever.js
<checkout>/mcp/lib/tools/recall.js   (REWRITTEN; replaces
                                                     the Phase 0 stub)
<MEMORY_ROOT>/indices/<embedding_model_version>/hnsw.bin
<MEMORY_ROOT>/indices/<embedding_model_version>/bm25.json
<checkout>/scripts/backfill-embeddings.mjs
```

Per-version index discipline: append-only re-embedding under new model
versions; never overwrite. One index dir per `embedding_model_version`.
v0 pins to `gemini-embedding-001`; coexistence policy is an open problem
per the report.

---

## 8. CAPS additions (mcp/lib/validation.js)

The following CAPS are added to the existing `CAPS` object in
`validation.js`. Do NOT change existing CAPS values; only additions.

```js
GEMINI_EMBEDDING_MODEL_DEFAULT = "gemini-embedding-001"
GEMINI_EMBEDDING_DIMS_FULL = 3072
GEMINI_EMBEDDING_DIMS_MRL = 768
RECALL_BRIEF_MAX_ITEMS = 12
RECALL_BRIEF_MAX_CHARS_TOTAL = 4000
RECALL_BRIEF_MAX_CHARS_PER_ITEM = 600
RECALL_CANDIDATE_SET_SIZE = 50
RRF_K = 60
MMR_LAMBDA_DEFAULT = 0.7
DENSITY_FLAG_PAIRWISE_COSINE_THRESHOLD = 0.85
PROPENSITY_TEMPERATURE_TAU_DEFAULT = 0.3
PROPENSITY_JITTER_FRACTION = 0.05
POWER_LAW_F_FACT = 0.15
POWER_LAW_F_EPISODIC = 0.35
POWER_LAW_F_AMBIENT = 0.6
POWER_LAW_M_DEFAULT = 1.0
POWER_LAW_H_DEFAULT = 1.0
SCORE_WEIGHT_ENTITY_OVERLAP = 0.7
SCORE_WEIGHT_TIME_ANCHOR = 1.5
SCORE_WEIGHT_TIME_DECAY = 0.3
SCORE_WEIGHT_VALENCE = 0.2
SCORE_WEIGHT_ENGAGEMENT_PRIOR = 0.0
CONSENT_DAMPENER_FIRST_PARTY = 1.0
CONSENT_DAMPENER_THIRD_PARTY_INFERRED = 0.6
DERIVATION_STATUS_NORMAL = 1.0
DERIVATION_STATUS_ORPHAN = 0.5             // d=1 anchor (v0 backward-compat)
DERIVATION_STATUS_ORPHAN_FLOOR = 0.25      // depth-aware floor
DERIVATION_ORPHAN_LAMBDA = 0.4             // exp decay in (d-1) edges
MAX_DERIVATION_DEPTH = 16                  // BFS edge bound
TRANSITIVE_ORPHAN_DESCENDANTS_CAP = 10000  // BFS node bound; over-cap emits
                                            // policy.recall.transitive_
                                            // orphan_cap_exceeded
L2_NORM_INVARIANT_EPSILON = 1e-6
```

---

## 9. Graceful degrade discipline

- Gemini outage at promote-time: the cascade routes the row to the
  EMBED_DEFERRED outcome (row stays parked at the source-ledger cursor;
  no `memory.jsonl` write). The next cascade tick re-attempts embedding
  on Gemini recovery. Backfill (`scripts/backfill-embeddings.mjs`)
  covers pre-cascade rows that still lack vectors via the
  `is_seed_row` marker / absence-check (the retired R29.3 promote-time
  write path is recorded in `kb/legacy-archive.md § R29.3`).
- Gemini outage at recall-time: fallback to BM25-only candidate generation;
  emit `degraded_recall=true` in the brief envelope.

---

## 10. Config sourcing

`GEMINI_API_KEY` MUST be read from `process.env`. Both launchd plists already
wire it into `EnvironmentVariables`. Production code MUST NOT read
a `.env` file from another project directory directly — that's a development
convenience only. If `process.env.GEMINI_API_KEY` is missing, fail loud with
a clear message pointing to the plist + env-var name.

---

## 11. Hermeticity discipline (standing C-NEW-2 pattern)

All tests MUST set `MEMORY_ROOT`, `POLICY_BASE_DIR`, `STORAGE_BASE_DIR`,
`LEDGERS_BASE_DIR` to `mkdtempSync` paths BEFORE any dynamic import of
memory-system modules. Verified via snapshot-comparison: production
`<MEMORY_ROOT>/{ledgers,policy,indices}/*` mtime+size MUST be
IDENTICAL pre/post `npm test`. The C-NEW-2 hot-fix pattern is now standing
discipline.

spec-sweep gate: zero hits (refine the sweep if new deprecated field names
emerge). No new top-level state fields without updating the frozen schema
in `kb/agent-integration.md` AND the sweep allow-list.
