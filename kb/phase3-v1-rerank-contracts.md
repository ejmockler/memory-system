# Phase 3 v1 — Layer-3 Rerank Authoritative Contracts

This file is the AUTHORITATIVE shape contract for Phase 3 v1 Layer-3
(Gemini 2.5 Flash listwise reranker). Every downstream implementor agent
reads this and targets these shapes exactly. Deviation is drift.

Cross-links:
- `kb/research-retrieval-frontiers.md` § "Phase 3 v1 — Instruction-following reranker", § "Recommended Phase 3 architecture > Layer 3", § Risks #8 / #14.
- `kb/phase3-v1-reranker-model.md` (model decision, API URL, request body shape).
- `kb/phase3-v0-contracts.md` (existing IndexEntry / ScoreComponents / Brief / recall-event shapes — v1 extends, never breaks).
- `mcp/lib/gemini-flash-client.js` (already-implemented transport surface; `generateRanking({instruction, candidates})`).

---

## 0. Pipeline summary (v1)

```
Layer 1 — hybridRetrieve (RRF k=60 over BM25 + HNSW MRL-768d) → ~50 candidates
Layer 2 — applyHardGates + full-3072d rescore + multi-feature → survivors sorted by final_score
Layer 3 — rerankCandidates: top-25 of survivors → Flash listwise → top-12 by rerank_score
Layer 4 — mmrSelect over the top-12 (relevance term = final_score, NOT rerank_score)
Brief — enforceBriefCaps + density flag + propensities + recall-log
```

Layer 3 ONLY REORDERS. Hard gates are immutable correctness invariants;
the reranker may NEVER drop a candidate on its own opinion.

---

## 1. New module: `mcp/lib/recall/rerank.js`

### Exports

```js
// Build the natural-language instruction string passed to gemini-flash-client.
buildRerankInstruction({ surrounding_context, candidates, opts }): string

// Build {id, content} for one candidate per the kb/phase3-v1-reranker-model.md template.
serializeCandidateForRerank({ entry, score_components }): { id: string, content: string }

// Top-level orchestration: instruction + candidate list + Flash call + parse + fallback.
rerankCandidates({ surrounding_context, candidates_with_scores, opts }): Promise<RerankResult>
```

### Type detail

```js
// RerankResult
{
  reranked: Array<{
    memory_id: string,
    final_score: number,      // Layer-2 multi-feature score (unchanged passthrough)
    rerank_score: number | null, // null when degraded (Flash failure)
    rerank_position: number   // 0-indexed position in the rerank output
  }>,
  degraded: boolean,
  layer3_latency_ms: number,  // monotonic from before Flash POST to after parse OR abort
  rerank_failed_reason: string | null
                              // null on success; otherwise one of:
                              //   "api_key_missing"
                              //   "timeout"
                              //   "network"
                              //   "http_<status>"     (e.g. http_429 after retry exhaustion)
                              //   "malformed_response"
                              //   "all_ids_unmatched"
                              //   "internal_error"
}
```

### buildRerankInstruction

Inputs:
- `surrounding_context`: `{ current_query, recent_turns[], agent_role, time_anchor?, entities? }`
  (`time_anchor` and `entities` are v0-future; v0 passes them as `null` / `[]`)
- `candidates`: not used for instruction text itself (kept for future entity-set
  derivation); accepted for forward compat
- `opts.now`: ISO-8601 string for deterministic test mode (overrides
  `surrounding_context.time`)

Output template (verbatim — the implementor must match this string structure
so T1 can pin it):

```
Rank these candidate memories by relevance to the current conversation context.

Current context:
- agent role: <agent_role>
- time: <time_now ISO-8601>
- recent conversation:
<recent_turns formatted as "role: content" one per line, in order>
- entities in context: <comma-joined entities, or "(none)">

Ranking rules (apply declaratively):
1. PREFER candidates whose entities overlap with the conversation entities
2. DAMPEN candidates marked consent_basis="third_party_inferred" by ~30-40%
3. DEMOTE candidates marked derivation_orphan=true unless the conversation is about deletions/excisions
4. AVOID candidates that are paraphrases of any recent_turn (they're already in context)
5. SUPPRESS candidates with negative valence unless the conversation valence matches

Return a JSON array of {id, rank_score} for ALL provided candidates with rank_score in [0,1]; higher = more relevant.
```

`recent_turns` are joined with `\n` and prefixed `  - <role>: <content>`. The
total instruction is capped at `CAPS.RECALL_BRIEF_MAX_CHARS_TOTAL` (4000); if
exceeded, recent_turns are truncated from the OLDEST end until under cap (the
most-recent turns are most signalful).

### serializeCandidateForRerank

Per `entry: IndexEntry` (kb/phase3-v0-contracts.md § 1) and the attached
`score_components: ScoreComponents` (§ 3):

```
id={memory_id} (kind={kind}, ts={ts}, entities=[{entities joined ","}], consent_basis={consent_basis}, derivation_orphan={true|false}, valence={valence ?? "null"}):
{content[0..RECALL_RERANK_CONTENT_EXCERPT_CHARS]}
```

- `derivation_orphan` derived: `derivation_distance != null` (v0 shape).
- `valence` rendered as `null` literal when the IndexEntry field is null.
- Content truncated at `CAPS.RECALL_RERANK_CONTENT_EXCERPT_CHARS` (400). NO
  ellipsis — the reranker treats truncation as opaque.
- Returns `{ id: entry.memory_id, content: <serialized string above> }`.
- The `id` MUST equal `entry.memory_id` exactly (gemini-flash-client uses it
  as the join key for response validation).

### rerankCandidates

Inputs:
- `surrounding_context`: as above
- `candidates_with_scores`: `Array<{ candidate: IndexEntry, score_components: ScoreComponents }>`,
  sorted by `final_score` desc (the implementor MAY assume sorted; T3
  asserts sort)
- `opts.now?`: ISO-8601 override for instruction time line
- `opts.signal?`: AbortSignal hook for test-driven cancellation
- `opts.timeoutMs?`: override of `CAPS.RECALL_RERANK_TIMEOUT_MS` for tests

Algorithm:

1. Truncate to top `CAPS.RECALL_RERANK_INPUT_SIZE` (25) by `final_score`.
   If `candidates_with_scores.length === 0`: return
   `{ reranked: [], degraded: false, layer3_latency_ms: 0, rerank_failed_reason: null }`
   (empty pool is not a failure).
2. Capture start = `performance.now()`.
3. If `process.env.GEMINI_API_KEY` is empty/missing: short-circuit degraded
   path with `rerank_failed_reason="api_key_missing"`. Do NOT call Flash.
4. Build `instruction = buildRerankInstruction({...})` and
   `candidates = candidates_with_scores.map(serializeCandidateForRerank)`.
5. Race `generateRanking({instruction, candidates})` against a
   `setTimeout(CAPS.RECALL_RERANK_TIMEOUT_MS)`. On timeout: set
   `rerank_failed_reason="timeout"`. On thrown error: map to one of:
   - error has `.statusCode` → `http_<statusCode>`
   - `gemini-flash-client: network` in message → `network`
   - `responseSchema`/`ranking[]`/parse messages → `malformed_response`
   - `GEMINI_API_KEY is not set` → `api_key_missing`
   - else → `internal_error`
6. On success, build `responseById = Map<id, rank_score>` from Flash output.
   Compute `medianScore` = median of `[...responseById.values()]`.
   - For each input id NOT in `responseById`: assign `rank_score = medianScore`
     (partial-response patch; preserves the survivor set).
   - For each Flash-returned id NOT in the input set: ignore (already
     defended at gemini-flash-client level; double-defense here).
   - If `responseById.size === 0` after filtering: degrade with
     `rerank_failed_reason="all_ids_unmatched"`.
7. Sort candidates by `rank_score` desc (tie-break: original `final_score`
   desc, then `memory_id` asc — same tiebreak as Layer-2 sort).
8. Truncate to `CAPS.RECALL_RERANK_OUTPUT_SIZE` (12). Assign
   `rerank_position = 0..N-1`.
9. layer3_latency_ms = `performance.now() - start` (rounded to int ms).
10. On any failure path: sort by `final_score` desc, take top-12, all
    `rerank_score = null`, `degraded = true`. layer3_latency_ms still
    populated (latency-until-failure).

---

## 2. Brief envelope additions

Extends `kb/phase3-v0-contracts.md § 4` ADDITIVELY:

```js
{
  brief: Array<{
    memory_id, content_excerpt, score, position, propensity, kind, ts,
    rerank_score: number | null,        // NEW — null when degraded_recall_layer3
  }>,
  density_flag: ...,
  degraded_recall: boolean,             // UNCHANGED — BM25-only fallback (embed outage)
  degraded_recall_layer3: boolean,      // NEW — Flash outage at recall time
  layer3_latency_ms: number,            // NEW — Flash POST→parse latency (ms)
  rerank_input_count: number,           // NEW — actual count fed to Flash (≤ 25)
  rerank_output_count: number,          // NEW — actual count kept after Flash (≤ 12)
  recall_id, candidate_set_size
}
```

Backward-compat (load-bearing): every existing field above (`brief[]`,
`density_flag`, `degraded_recall`, `recall_id`, `candidate_set_size`) keeps
the exact shape and semantics from v0. The legacy `memories[]` /
`bounded_by` / `truncated` envelope returned by `recall.js` ALSO stays
unchanged. v1 is ADDITIVE.

**Semantic drift callout (round-19 brutalist CRITICAL-5).** The envelope
SHAPE is unchanged, but the ORDER of `memories[]` / `brief[]` is now
Flash-listwise-reranked top first (was multi-feature-score top first in v0).
Downstream consumers reading `memories[0]` to get "the most relevant
memory" now receive the Flash-reranked top, not the engineered-features top.
This is intentional — Layer 3 exists to improve the surfaced ordering — but
it IS a behavioral change consumers should be aware of. Two safety nets:
(1) MMR (Layer 4) still uses Layer-2 `final_score` as its relevance term,
so the engineered-features signal is not abandoned. (2) When
`degraded_recall_layer3=true` the ordering falls back to Layer-2
`final_score` exactly — v0-compatible behavior is the fallback path.

---

## 3. Recall ledger event additions

<!-- BEGIN-CANONICAL: phase3_v1_recall_ledger_event_additions -->
Extends `kb/phase3-v0-contracts.md § 5` ADDITIVELY:

```js
{
  id, ts, kind: "recall",
  query: ...,                            // UNCHANGED
  surfaced: Array<{
    memory_id, score, position, propensity, feature_breakdown,
    rerank_score: number | null,         // NEW
  }>,
  candidates_pre_truncation: Array<{
    memory_id, position, score,
    rerank_score: number | null,         // NEW — only populated for the 25 fed to Flash; null for positions 25..49
  }>,
  density_flag,
  degraded_recall,
  rerank_attempted: boolean,             // NEW — true iff Flash POST was issued (false on api_key_missing)
  rerank_failed_reason: string | null,   // NEW — see RerankResult above
  layer3_latency_ms: number,             // NEW
  degraded_recall_layer3: boolean,       // NEW
  // Round-19 brutalist CRITICAL-4 hot-fix: audit-provenance fields. Required
  // for the FIRST week of production logs so recall.jsonl can be audited for
  // prompt drift, cap changes, and model-version skew across recalls. Append-
  // only; v0 consumers ignore. Emitted on EVERY rerankCandidates return
  // (happy / degraded / short-circuited).
  rerank_instruction_hash: string | null,// NEW — sha256-16hex (32 hex chars) of
                                         //   the exact instruction string sent
                                         //   to Flash; null if rerank_attempted=false
                                         //   (api_key_missing or empty candidate set)
  rerank_caps_snapshot: object | null,   // NEW — {RECALL_RERANK_INPUT_SIZE,
                                         //   RECALL_RERANK_OUTPUT_SIZE,
                                         //   RECALL_RERANK_TIMEOUT_MS,
                                         //   RECALL_RERANK_CONTENT_EXCERPT_CHARS,
                                         //   GEMINI_FLASH_RERANK_TEMPERATURE,
                                         //   GEMINI_FLASH_RERANK_THINKING_BUDGET,
                                         //   GEMINI_FLASH_RERANK_MAX_OUTPUT_TOKENS}
                                         //   at the time of the call
  rerank_model_version: string | null    // NEW — the exact Flash model tag the
                                         //   call hit (CAPS.GEMINI_FLASH_MODEL_DEFAULT
                                         //   at recall time)
}
```

Audit-provenance fields are emitted unconditionally by `rerankCandidates`.
When Google publishes a dated snapshot tag (per
`kb/phase3-v1-reranker-model.md`), the bumped CAPS value flows through
`rerank_model_version` automatically — no schema change needed.
<!-- END-CANONICAL: phase3_v1_recall_ledger_event_additions -->

---

## 4. CAPS additions to `mcp/lib/validation.js`

```js
RECALL_RERANK_INPUT_SIZE = 25
RECALL_RERANK_OUTPUT_SIZE = 12
RECALL_RERANK_TIMEOUT_MS = 15000
RECALL_RERANK_CONTENT_EXCERPT_CHARS = 400
```

These are NEW CAPS; existing CAPS values (including the v1 client knobs
`GEMINI_FLASH_MODEL_DEFAULT`, `GEMINI_FLASH_RERANK_*`) are not modified.

---

## 5. Pipeline integration point in `mcp/lib/tools/recall.js`

The Layer 3 insertion slots between the sort by `final_score` (after
Layer 2 multi-feature scoring) and the MMR call (Layer 4).

**Exact insertion span**: between current line 400 (close of `scored.sort`
block, immediately after the `scored.sort((a, b) => ...)` call ending at
line 400) and line 401 (`const top20 = scored.slice(0, 20);`).

The replacement block (paraphrased; precise wiring is the implementor's
job):

```js
// EXISTING (lines 393-400):
scored.sort((a, b) => {
  if (b.score_components.final_score !== a.score_components.final_score) {
    return b.score_components.final_score - a.score_components.final_score;
  }
  return a.candidate.memory_id < b.candidate.memory_id ? -1 : 1;
});

// NEW Layer 3 (insert AFTER line 400, BEFORE line 401):
const rerankInput = scored.slice(0, CAPS.RECALL_RERANK_INPUT_SIZE);
const {
  reranked,
  degraded: degradedLayer3,
  layer3_latency_ms,
  rerank_failed_reason,
} = await rerankCandidates({
  surrounding_context: ctx,
  candidates_with_scores: rerankInput.map((s) => ({
    candidate: s.candidate,
    score_components: s.score_components,
  })),
});

// MODIFY line 401: the MMR input set is now the reranked top-12 (joined back
// to the `scored` entries by memory_id so `score_components` survives).
const rerankedById = new Map(reranked.map((r) => [r.memory_id, r]));
const top12 = reranked
  .map((r) => scored.find((s) => s.candidate.memory_id === r.memory_id))
  .filter(Boolean);

// MMR over top12 (was top20 in v0). Relevance term stays `final_score` per
// kb/research-retrieval-frontiers.md § Layer 4: "Relevance term is the full
// multi-feature score" — Flash already ordered; double-using rerank_score
// would compound listwise noise.
```

The `top20` variable is replaced by `top12`. The propensity computation
(currently over `top20Scores`, line 455) becomes propensity over
`rerankInput` (the 25 fed to Flash) — see § 6 below for why. The
`candidates_pre_truncation` writeback (line 530) gets a `rerank_score`
field merged from `rerankedById` for the first 25 entries, null for 25..49.

---

## 6. candidates_pre_truncation set

**Decision: record the TOP-25 fed to Flash WITH rerank_score, AND positions
26..50 from the Layer-2 post-sort set WITHOUT rerank_score (null), all in
the same array of up to 50 entries.**

Rationale:
- v0 already commits to "top-50 fused" as the substrate (`RECALL_CANDIDATE_SET_SIZE=50`).
  Truncating to 25 at v1 would shrink the off-policy estimator's support and
  break paired comparison with v0 logs.
- Recording ONLY the top-25 loses the Layer-2-vs-Layer-3 rank-mix signal —
  the v3 OPE pipeline (kb/research-retrieval-frontiers.md § Phase 3 v3)
  needs to see WHICH Layer-2 candidates Flash demoted out of contention.
- Recording BOTH separately would double the schema surface; merging them
  into one array with `rerank_score: number | null` keeps the substrate
  flat and machine-parseable.
- Propensities are computed over the top-25 (the set Flash actually chose
  from), not the top-50 — because the propensity distribution must reflect
  the policy that produced the surfaced briefs. This deviates from v0
  (which computed propensities over top-20); the deviation is intentional
  and matches the ARCH_CONTEXT directive ("Plackett-Luce propensity is
  computed AFTER Layer 3 over the final-sorted top-RECALL_RERANK_INPUT_SIZE
  set").

---

## 7. Test plan (for `mcp/test/rerank.test.mjs` + integration test agent)

<!-- BEGIN-CANONICAL: phase3_v1_test_plan -->
- **T1** — `buildRerankInstruction` emits the expected template for a known
  `surrounding_context` (fixed `now`, 2 recent_turns, agent_role); assert
  substring matches of each of the 5 rules and the header lines.
- **T2** — `serializeCandidateForRerank` truncates `content` at exactly
  `CAPS.RECALL_RERANK_CONTENT_EXCERPT_CHARS`; renders `derivation_orphan`
  boolean derived from `derivation_distance`; renders null `valence` as
  `null` literal.
- **T3** — `rerankCandidates` happy path with a mocked Flash returning a
  known reordering of 5 ids: result `reranked.length === 5`,
  `rerank_position` matches Flash order, `rerank_score` matches Flash
  scores, `degraded === false`, `rerank_failed_reason === null`.
- **T4** — Partial response: Flash returns 3 of 5 ids → the 2 omitted ids
  receive the median of the 3 returned `rank_score`s; nothing dropped
  (`reranked.length === 5`); `degraded === false`.
- **T5** — Timeout: mocked Flash delays past `RECALL_RERANK_TIMEOUT_MS` →
  `degraded === true`, `rerank_failed_reason === "timeout"`, output sorted
  by `final_score` desc, all `rerank_score === null`.
- **T6** — Malformed: mocked Flash returns missing `ranking[]` →
  `degraded === true`, `rerank_failed_reason === "malformed_response"`.
- **T7** — `GEMINI_API_KEY` missing → `degraded === true`,
  `rerank_failed_reason === "api_key_missing"`; Flash never POSTed (assert
  via mock call-count = 0).
- **T8** — Integration end-to-end with REAL Flash (gated on
  `GEMINI_API_KEY` present + `REQUIRE_FLASH_SMOKE=1` hard-fails when key is
  absent in CI): full `recall.js` handler returns a Brief with
  `rerank_score` populated on every `brief[]` item,
  `degraded_recall_layer3 === false`, `layer3_latency_ms > 0`.

Hermeticity: every test sets `MEMORY_ROOT` etc. before dynamic import per
the C-NEW-2 standing pattern. Mocked Flash uses `globalThis.fetch` override
restored in afterEach — same discipline as `test/gemini-client.test.mjs`.
<!-- END-CANONICAL: phase3_v1_test_plan -->

---

## 8. Deviations from ARCH_CONTEXT

- None of substance. One clarification: ARCH_CONTEXT says "candidates_pre_truncation
  set should record the TOP-25 fed to Flash, or the FULL post-RRF top-50,
  or both — pick one with rationale." This contract picks "the full top-50,
  with `rerank_score` populated for the first 25 only" — a hybrid framed as
  one array. The rationale (§ 6 above) is that this preserves v0 OPE
  substrate fidelity AND captures the Layer-2-vs-Layer-3 rank-mix signal
  v3 needs.
- ARCH_CONTEXT specifies propensity over "the top-25-or-final-set"; this
  contract pins to top-25 (the input to Flash), matching the ARCH_CONTEXT
  directive in the CONSTRAINTS block.
