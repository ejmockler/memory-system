# Cascade Embedding Decoupling — Foundation Spec

> **Node:** `F-CCS-FOUNDATION-cascade-embedding-decoupling`
> **Tier:** foundation (W1-CCS, BLOCKER)
> **Status:** authoritative; pins the contract for cascade promotion WITHOUT promote-time embedding success
> **Owns:** the new contract that decouples Stage-2 embedding from the PROMOTE decision, the `<data root>/policy/embed-queue.jsonl` queue file format, the `policy.embedding_backfill` event schema, the recall-time embedding-overlay rule that lets the multi-feature scorer survive `features.embedding == null`, and the additive fallback gate.
> **Downstream implementers:** `F-CCS-CASCADE-promote-without-embed` (the cascade hot-path change), `F-CCS-BACKFILL-engine` / `F-CCS-BACKFILL-recall-consumer` / `F-CCS-BACKFILL-trigger` (the worker side), and the W6 recall scorer wiring.

---

## 1. Mission

On **2026-06-20** the cascade froze. Three sources stopped promoting:

- `git-log.jsonl` — **271 rows** stalled past the watermark cursor.
- `chat-claude-code.jsonl` — **97 rows** stalled.
- `gh-events.jsonl` — **28 rows** stalled.

Root cause: **Stage-2 of the cascade calls `gemini-client.embedSingle` synchronously inside the promote hot-path**. Gemini quota was exhausted on the rotating key set, and key #4 GCP returned `403 PERMISSION_DENIED` (project disabled). The cascade's `EMBED_DEFERRED` outcome parked the watermark cursor on every candidate — by design, R29.3 ("the deferred-embed flag is dead; cursor parks at `EMBED_DEFERRED`") guarantees that an embed failure stops the watermark from advancing. That correctness invariant collided with a sustained outage: **the entire promotion path was frozen on the embedding dependency** for as long as the quota / 403 lasted. Recall degraded only as a second-order effect; the primary symptom was that *new structural facts could not enter `memory.jsonl` at all*.

This spec pins the contract that fixes that failure mode without giving up the renorm / model-version / asymmetric-task-type invariants the embedding pipeline depends on. The pivot is:

1. **Stage-2 becomes asynchronous.** The cascade's PROMOTE decision MUST NOT block on `embedSingle`. A row with `features.embedding == null` is a valid, durable PROMOTE outcome — it just lacks the dense feature.
2. **A queue file persists pending embed work.** `<data root>/policy/embed-queue.jsonl` is appended on every PROMOTE-without-embed; a background worker drains it.
3. **Embedding success is delivered as a new policy event.** `policy.embedding_backfill` is the single carrier: it names a `target_fact_id` and ships the vector + model version. The original fact row is never mutated in place.
4. **Recall builds an embedding overlay from `policy.embedding_backfill` events** at init, and the multi-feature scorer falls back to an **additive-only branch** when `s_emb == 0`, gated by `ADDITIVE_FLOOR` so pure noise is not surfaced.

This contract converts a hot-path outage into a graceful degradation: PROMOTE keeps flowing; recall quality drops for backfill-pending rows; everything heals when Gemini recovers.

---

## 2. KB Anchors

### A. `research-retrieval-frontiers.md` § Recommended Phase 3 architecture — Layer 2 multi-feature score (load-bearing, verbatim)

> "Multi-feature score is `(s_emb_full3072 * predicate_mask * consent_dampener * derivation_status * episodicity_match) + w_ent*entity_overlap_jaccard + w_t1*time_anchor_match (gated to 0 if no anchor) + w_t2*power_law_decay(age, kind) + w_val*valence_compat + w_eng*engagement_prior`."

Pins the shape this spec extends. Two structural facts matter:

1. **The multiplicative branch is gating.** When `s_emb_full3072 == 0`, the whole multiplicative product is 0 regardless of the other multiplicative factors. The scorer's behavior in that regime is what this spec must pin.
2. **The additive branch is independent.** `w_ent*entity_overlap_jaccard + w_t1*time_anchor_match + w_t2*power_law_decay + w_val*valence_compat + w_eng*engagement_prior` is summed without any multiplicative dependence on `s_emb`. That is the carrier this spec uses to keep null-embedding rows reachable.

### B. `salience-design.md` § Promote-time algorithm (cascade stages, verbatim)

> "LAYER 3: embedding + HNSW for novelty + corroboration check"
> "emb = embedSingle(event.content)  # reused for index write"
> "nearest = hnsw.knn(emb, k=8)"
> "novelty = 1 - nearest[0].cosine_distance"
> "components.novelty = novelty"

Note: salience-design names this stage **LAYER 3** in the in-source algorithm pseudocode. The ledger-and-supervisor-facing terminology calls it **Stage-2** (Stage-0 = hard-drop, Stage-1 = mark-and-rank, Stage-2 = embed/novelty). This spec uses **Stage-2** consistently; the LAYER-3 / Stage-2 mapping is normative.

Stage-2 is exactly the call this spec is moving off the hot path. The novelty component (the only Stage-2 output) becomes an enrichment that the backfill worker can stamp later via the same `policy.embedding_backfill` event, or skip entirely if the corroboration window has already closed.

### C. `salience-design.md` § Failure modes — Stage-2 corollary

> "Embedding-model drift — Gemini swap → non-comparable `novelty`. Signal: `salience_calibration_mismatch` counter. Fix: `salience_layer_quiesce` + rebuild."

The KB already anticipates that Stage-2 outputs can be backfilled / rebuilt without violating the append-only invariant. This spec generalizes that escape hatch from "rare model-swap" to "any time Gemini is unavailable on the promote path."

### D. `research-retrieval-frontiers.md` § Fallback (two-level)

> "Transient outage: cache 24h of fact embeddings locally; the cascade routes uncomputable rows to the EMBED_DEFERRED outcome (cursor-park) and the next tick retries — no promote-time partial fact is written."

This spec **explicitly retires the "no promote-time partial fact is written" half of that sentence** for the cascade hot-path. The justification is empirical: the 2026-06-20 freeze proved cursor-park is correct for short transients but unworkable for multi-hour outages on a critical-path source. The 24h embedding cache is preserved as a separate optimization and is out of scope here.

---

## 3. New flow

### 3.1 Stage-0 dispatch (UNCHANGED)

Per-source hard-drop modules under `mcp/lib/ingest/stage0/` continue to fire structurally (~10 µs). Decisions: `DROP`, `OTP_SECRET_REDACT`, `ADMIT`. Drops emit `policy.salience.dropped` / `policy.salience.redacted` and the watermark advances past the row. **No change.**

### 3.2 Stage-1 score (UNCHANGED)

`scoreCandidate` in `mcp/lib/ingest/salience.js` computes the five non-novelty components (`recency`, `authorship`, `content_mass`, `source_prior`, `structural`) plus the two zero-weighted R24.5 columns (`last_retrieved_ts`, `use_count`). All five are deterministic and embedding-free. `salience` is a weighted sum **excluding `novelty`** at this stage. **No change.**

### 3.3 PROMOTE on Stage-1 success → `appendFactRow` with `features.embedding == null` (NEW CONTRACT)

After Stage-1 the cascade calls `appendFactRow` immediately with:

- `features.embedding_3072 = null`
- `features.embedding_mrl_768 = null`
- `features.embedding_model_version = null`
- `features.salience.components.novelty = null` (Stage-2 has not run)
- `features.salience.score` computed from the five Stage-1 components only, with the `novelty` weight (0.25) **redistributed pro-rata** across the remaining five so the score domain stays `[0, 1]` for the cascade decision threshold. Redistribution is byte-deterministic; the recomputed weight vector hash is recorded as `features.salience.weights_hash_at_admit` so a future replay over the same components produces the identical score.
- `features.embed_state = true` (NEW; promoted to a first-class enum-style flag — distinct from the R29.3-retired `embed_state` marker that was a soft "missing column" hint. This one is normative: it tells the recall consumer to consult the overlay, and tells the backfill worker the row is queue-eligible.)

W3 entity stamping, W6 time_anchor stamping, W3 valence stamping, and W4 episodicity stamping continue to fire — none of those depend on the embedding. The row lands in `memory.jsonl` with full structured features and a null embedding.

`policy.token.consumed` is emitted as usual. From the supervisor's perspective the work is **done** — the row is durable, the watermark advances. The embedding is now a separate, optional, async enrichment.

### 3.4 Embed queue (NEW)

After `appendFactRow` returns successfully, the cascade appends one line to `<data root>/policy/embed-queue.jsonl`:

```jsonl
{"fact_id":"<id>","source":"<source>","content_sha256":"<hex>","enqueued_at":"<ISO8601>","attempt":0}
```

Schema:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `fact_id` | string | yes | The id appendFactRow returned for the row that needs an embedding. Foreign key into `memory.jsonl`. |
| `source` | string | yes | The connector source (`git_log`, `chat_claude_code`, …) — used by the worker for batching and per-source rate-limiting. |
| `content_sha256` | string (hex) | yes | SHA-256 of the exact text that was hashed into `args.content` at promote time. The worker re-reads the content from `memory.jsonl` by `fact_id` and asserts the hash matches before calling Gemini — protects against in-flight row mutation (which is forbidden but worth gating). |
| `enqueued_at` | string (ISO 8601) | yes | UTC timestamp at enqueue. Used for queue-age dashboards and the staleness gate (see § 7). |
| `attempt` | integer | yes | 0 at enqueue. Incremented by the worker on each retry. Worker drops the line at `attempt > MAX_BACKFILL_ATTEMPTS` (default 6) and emits `policy.embedding_backfill_abandoned` with the reason; the recall path tolerates an unbacked-fill row indefinitely.

The queue is **append-only and crash-safe**: the worker reads sequentially, processes, and on success appends the `policy.embedding_backfill` event then truncates the queue file via the standard "rewrite into temp + rename" idiom under an exclusive file lock (the same lock the existing `policy-events.js` writer uses). On worker crash mid-batch, the queue file still has every unprocessed line; the worker resumes on next start.

**Single-producer for the queue:** only `mcp/lib/ingest/salience.js` writes `embed-queue.jsonl`. Enforced by CI grep:

```
grep -rE 'embed-queue\.jsonl' mcp/lib mcp/scripts mcp/server.js \
  | grep -v 'mcp/lib/ingest/salience.js' \
  | grep -v 'mcp/lib/synthesis/embed-backfill-worker.js' \
  | grep -v ': //'  # ignore comments
```

The worker (`embed-backfill-worker.js`) is the only **consumer** that mutates the queue (drains it). Read-only inspection from other callers (dashboards, health probes) is permitted.

### 3.5 Background embed worker (NEW)

`mcp/lib/synthesis/embed-backfill-worker.js` runs on the daemon's idle tick or as a long-running supervised child process. Loop:

```
while (queue not empty AND tick_budget_remaining):
  batch = read up to EMBED_BACKFILL_BATCH_SIZE lines (default 16)
  for each entry in batch:
    if attempt > MAX_BACKFILL_ATTEMPTS:
      emit policy.embedding_backfill_abandoned {fact_id, reason: "max_attempts"}
      remove from queue
      continue
    row = lookupFactById(entry.fact_id)
    if row == null:
      emit policy.embedding_backfill_abandoned {fact_id, reason: "row_missing"}
      remove from queue
      continue
    if sha256(row.content) != entry.content_sha256:
      emit policy.embedding_backfill_abandoned {fact_id, reason: "content_drift"}
      remove from queue
      continue
    try:
      r = await embedSingle({
        text: row.content,
        taskType: GEMINI_TASK_TYPES.RETRIEVAL_DOCUMENT,
        dims: CAPS.GEMINI_EMBEDDING_DIMS_MRL,
        source: "embed-backfill",
      })
      appendPolicyEvent({
        kind: "policy",
        policy_kind: "embedding_backfill",
        target_fact_id: entry.fact_id,
        embedding: { vector_3072: r.vector_3072, vector_mrl_768: r.vector_mrl_renormalized },
        embedding_model_version: r.embedding_model_version,
        ts: serverTs(),
      })
      remove from queue
    catch (e):
      if classifyGeminiError(e) in { QUOTA_EXHAUSTED, KEY_403, NETWORK }:
        # Transient — bump attempt, keep in queue, exponential backoff at the
        # tick level (next tick is 60s; backoff is "skip this entry for the
        # next N ticks" where N = 2^attempt capped at 32).
        bump attempt; set next_eligible_tick on the queue entry; continue
      else:
        # Permanent — bad input, model rejected the row, etc.
        emit policy.embedding_backfill_abandoned {fact_id, reason: classifyGeminiError(e).code}
        remove from queue
```

`EMBED_BACKFILL_BATCH_SIZE`, `MAX_BACKFILL_ATTEMPTS`, and `EMBED_BACKFILL_TICK_BUDGET_MS` are pinned in `CAPS` and frozen.

### 3.6 Why a queue file and not "scan memory.jsonl for rows where features.embedding == null"

Three reasons:

1. **Ordering.** Newest-first enrichment matters more than oldest-first (recall is biased toward recency). A queue file is naturally FIFO and the worker can re-sort by source priority cheaply; a scan over `memory.jsonl` would need a parallel sorted index.
2. **Cost bound.** During a 24h Gemini outage the queue may grow to ~10⁴ entries. A linear scan over a multi-GB `memory.jsonl` to find them is wasteful and racy with concurrent appendFactRow. The queue is O(pending), `memory.jsonl` is O(total).
3. **Idempotency.** The queue carries `content_sha256`; the row carries content. Re-derivation under content drift is caught structurally without trusting that fact rows are immutable (they should be, but the queue's hash check defends against bugs).

The queue file is **not the source of truth**. `policy.embedding_backfill` events are. If the queue file is deleted, the recall overlay still works on already-backfilled rows; the backfill worker has lost the work-list and a maintenance script (`mcp/scripts/rebuild-embed-queue.mjs`, future work) can scan `memory.jsonl` for `features.embed_state == true` rows that lack a matching `policy.embedding_backfill` event and re-enqueue them. The script is **not** in scope for this spec — it is named here so the recovery path is documented.

---

## 4. Recall-time embedding overlay

### 4.1 Overlay construction

On recall init (the same place `loadIndices` warms HNSW), `mcp/lib/recall/embedding-overlay.js` (NEW) constructs:

```
Map<fact_id, {vector_3072, vector_mrl_768, embedding_model_version, backfilled_at}>
```

by scanning the policy event log for `policy_kind == "embedding_backfill"` events. The scan is one-pass-per-process-start and the resulting Map is cached for the lifetime of the recall daemon (cache invalidated on a new policy event of this kind — same invalidation hook the existing HNSW index uses).

For overlay correctness: if multiple `policy.embedding_backfill` events exist for the same `target_fact_id`, the latest by `ts` wins. This permits future re-embeds under model migration without re-architecture.

### 4.2 Per-candidate resolution

For each candidate in the multi-feature scorer:

```
embedding := candidate.features.embedding_3072
if embedding == null:
  overlay_entry := overlay.get(candidate.id)
  if overlay_entry != null:
    embedding := overlay_entry.vector_3072
if embedding == null:
  s_emb := 0
  fallback_branch := true
else:
  s_emb := cosine(query_embedding, embedding)
  fallback_branch := false
```

`fallback_branch` is forwarded into the scorer so it can apply the additive-only gate (§ 4.4).

### 4.3 Multi-feature score under s_emb=0

The KB formula (§ 2.A verbatim) is:

```
(s_emb * predicate_mask * consent_dampener * derivation_status * episodicity_match)
  + w_ent*entity_overlap_jaccard
  + w_t1*time_anchor_match
  + w_t2*power_law_decay(age, kind)
  + w_val*valence_compat
  + w_eng*engagement_prior
```

When `s_emb == 0` the multiplicative branch collapses to 0 regardless of `predicate_mask`, `consent_dampener`, `derivation_status`, `episodicity_match`. The score then equals the additive branch:

```
additive_sum := w_ent*entity_overlap_jaccard
              + w_t1*time_anchor_match
              + w_t2*power_law_decay(age, kind)
              + w_val*valence_compat
              + w_eng*engagement_prior
final_score := 0 + additive_sum
```

**Critical: the hard gates (predicate_mask, consent_dampener, derivation_status) DO NOT migrate to the additive branch.** They are correctness invariants per `research-retrieval-frontiers.md` § Risks #14 ("Predicate exclusion is a hard gate *outside* the learned ranker forever"). When `s_emb == 0`, the additive branch is the score; the hard gates apply as **separate pre-filters before the scorer runs**, exactly as they do today. This spec does NOT relax them.

Specifically: predicate-excluded candidates, `CONSENT_BLOCKED` rows, and `derivation_orphan == true` rows are dropped or demoted **before** the per-candidate scoring loop, in the existing hard-gate stage. The fallback branch never sees them. This is invariant.

### 4.4 Additive floor — the fallback gate

Without `s_emb`, a candidate that has weak structural signal (small entity overlap, no time anchor, neutral valence, no engagement prior) can still score nonzero. To avoid surfacing pure noise during a Gemini outage, the additive branch is gated:

```
if fallback_branch == true AND additive_sum < ADDITIVE_FLOOR:
  drop candidate
```

`ADDITIVE_FLOOR = 0.10` is the v0 prior. Rationale:

- `w_ent` bootstrap = 0.7, so an `entity_overlap_jaccard >= 0.15` alone clears the floor. That matches the minimum "the candidate shares at least one prominent entity with the query" intuition.
- `w_t1` bootstrap = 1.5 (active when a time anchor exists), so any time-anchor match easily clears.
- A row with neither — no shared entity, no time-anchor match — has no anchor to the query and SHOULD be dropped while we can't tell from dense similarity whether it's secretly relevant.

The floor is exposed as `CAPS.RECALL_ADDITIVE_FLOOR_FALLBACK` and frozen.

Calibration follow-up (see § 10 open questions): when the recall log accumulates enough `fallback_branch == true` recall events with engagement signal, the floor SHOULD be re-tuned. v0 ships the prior.

### 4.5 What recall logs about the fallback

Every recall event now MUST record per-candidate:

- `had_embedding_at_recall: boolean` — true if the candidate had a usable embedding (own or via overlay), false if `s_emb == 0` was forced.
- `embedding_source: "fact_row" | "overlay" | "none"`.
- `fallback_branch_used: boolean` — true iff `had_embedding_at_recall == false`.

These fields enter the W6 propensity log so the OPE pipeline at v3 can stratify by fallback vs full-embed and the v1 held-out eval can isolate the fallback regime's accuracy hit. Without this stratification, learned rankers trained on mixed-regime data will silently encode the outage period as feature noise.

---

## 5. `policy.embedding_backfill` schema

```json
{
  "kind": "policy",
  "policy_kind": "embedding_backfill",
  "id": "<uuid-v4>",
  "ts": "<ISO 8601 UTC>",
  "target_fact_id": "<fact-id from memory.jsonl>",
  "embedding": {
    "vector_3072": [<3072 floats, L2-normalized, ||v||=1.0 ± 1e-6>],
    "vector_mrl_768": [<768 floats, L2-renormalized after MRL slice, ||v||=1.0 ± 1e-6>]
  },
  "embedding_model_version": "<gemini-embedding-001 or successor pinned in config>",
  "emitter_module": "mcp/lib/synthesis/embed-backfill-worker.js",
  "emitter_version": "<semver pinned in module's VERSION export>"
}
```

### 5.1 Field-by-field invariants

| Field | Type | Constraint | Producer-side check | Consumer-side check |
|---|---|---|---|---|
| `kind` | string | `== "policy"` | yes | yes |
| `policy_kind` | string | `== "embedding_backfill"` | yes | yes |
| `id` | string | UUID v4 | yes | n/a (uniqueness not load-bearing for this event) |
| `ts` | string | ISO 8601 UTC | yes | parsed; tie-break key for latest-wins overlay |
| `target_fact_id` | string | non-empty; foreign key into `memory.jsonl` | yes | overlay drops entries whose `target_fact_id` does not resolve to a row (handles fact deletion via `policy.connector_revoke`) |
| `embedding.vector_3072` | array | length == 3072, each value finite, `\|\|v\|\|` == 1.0 ± 1e-6 | yes (the existing `l2NormAssert` in `mcp/lib/vector-math.js`) | yes (overlay re-asserts on read) |
| `embedding.vector_mrl_768` | array | length == 768, each finite, `\|\|v\|\|` == 1.0 ± 1e-6 (re-normalized) | yes | yes |
| `embedding_model_version` | string | matches the pinned `gemini-embedding-001` or future-pinned model | yes | overlay segregates by version (RRF across versions deferred per `research-retrieval-frontiers.md` open question; v0 uses one version at a time and the overlay rejects events whose version != current config) |
| `emitter_module` | string | `== "mcp/lib/synthesis/embed-backfill-worker.js"` | yes (this is the single-producer enforcement at the event-level) | CI grep enforces no other emitter |
| `emitter_version` | string | semver | yes | logged, not gated |

### 5.2 Single-producer enforcement

Only `mcp/lib/synthesis/embed-backfill-worker.js` may emit `policy.embedding_backfill`. CI grep:

```
grep -rE 'policy_kind:\s*["\x27]embedding_backfill["\x27]' mcp/ \
  | grep -v 'mcp/lib/synthesis/embed-backfill-worker.js' \
  | grep -v 'mcp/test/' \
  | grep -v 'mcp/docs/' \
  | grep -v ': //'
```

Tests may emit (via the standard test-double pattern). Docs may reference. Anywhere else fails CI.

### 5.3 Why a new policy_kind and not a fact-row mutation

`memory.jsonl` is append-only. Mutating `features.embedding_3072 = <vector>` in place violates the R19 audit invariant ("source ledger never mutated"). A new policy event is the only schema-compatible carrier. The overlay reconstructs the effective embedding state per recall.

This also future-proofs the model-migration story: a Gemini-embedding-002 era simply emits new `policy.embedding_backfill` events at the new version, and the overlay can either prefer the newer version or RRF across versions per the open question in `research-retrieval-frontiers.md` § Risks (resolved before first version bump).

---

## 6. Backwards-compat

### 6.1 Existing facts with embeddings continue working unchanged

Any row already in `memory.jsonl` that carries `features.embedding_3072` is **not touched** by this spec. The recall overlay only fires when `candidate.features.embedding_3072 == null`. The full-embedding hot path is identical to today's behavior. The multi-feature scorer's primary code path is unchanged.

### 6.2 New facts may have `features.embedding == null` — validators MUST accept

The `validation.js` schema MUST be relaxed:

- `features.embedding_3072`: optional, may be `null` or a 3072-array.
- `features.embedding_mrl_768`: optional, may be `null` or a 768-array.
- `features.embedding_model_version`: optional, may be `null` or a non-empty string.
- New optional: `features.embed_state: boolean` (default `false` when omitted).
- New optional: `features.salience.weights_hash_at_admit: string` (set when novelty was redistributed out of the weights for a Stage-1-only PROMOTE).

The "if one is set, all are set; if one is null, all are null" cross-field invariant remains. This is asserted in the validator and tested in `cascade-embedding-decoupling.test.js`.

### 6.3 Rows without `last_retrieved_ts` / `use_count` still cascade

The R24.5 zero-weighted columns are populated by `appendRecallEvent` after recall. A row that has never been recalled has `last_retrieved_ts == null, use_count == 0`. Both must be valid for cascade purposes — the cascade reads neither. **No change** from R24.5; documented here for completeness because cascade is the touch-point.

### 6.4 Migration plan for in-flight pre-fix rows

The 271 + 97 + 28 rows that froze on 2026-06-20 are not yet promoted. They are still in their source ledgers. After this spec ships:

1. Watermark advances over them. They cascade through Stage-0 / Stage-1. Most promote with `features.embed_state == true`.
2. The embed queue file accumulates ~400 entries on the first post-deploy tick.
3. As Gemini quota recovers, the worker drains the queue at ~16 entries / minute (1 batch / tick, 1 tick / 60s; the actual rate is bounded by Gemini's TPM).
4. Steady-state queue depth stays near zero. Outage-period queue depth is observable via `policy.embedding_backfill` ts gap and an `embed_queue_depth` projection on `memory_health`.

No fact loss. No re-architecture. The contract heals the freeze.

---

## 7. Failure modes

### 7.1 Gemini total exhaustion (multi-day)

- Queue grows monotonically — bound is "all promote-eligible source rows since the outage started," which on real-operator traffic (≤ ~10⁴ rows/day across all sources) is well under a million entries / day. The queue file at ~200 bytes/line stays under 200 MB / day. Disk pressure is not a concern.
- Cascade still promotes. `memory.jsonl` keeps growing.
- Recall degrades gracefully: candidates without embeddings hit the additive branch. Recall@12 drops measurably; the recall log carries `fallback_branch_used: true` so the user can quantify the regression.
- When Gemini recovers, the worker drains the queue. Backfilled rows re-enter the full multi-feature scoring on next recall. Operator-visible "freeze" reduces to a "noisy interval" with a clear before/after edge.

### 7.2 Embed-backfill worker crash mid-batch

- Queue file persists on disk (append-only).
- On daemon restart, worker resumes from the head of the queue.
- Worst case is one duplicate `policy.embedding_backfill` event for the entry that was in-flight when the crash hit. The overlay's "latest by `ts` wins" rule handles this trivially.

### 7.3 Backfill worker can't keep up with promote rate

- The queue grows. The cascade keeps promoting (it does not block on queue depth).
- `embed_queue_depth` projection alerts at 1k entries; investigate Gemini quota provisioning or worker batch size.
- Recall continues to function in mixed mode (some rows have embeddings, some don't).

### 7.4 `policy.embedding_backfill` event written but row deleted

- Possible via `policy.connector_revoke` removing source-derived rows.
- Overlay enforces foreign-key correctness on read: an event whose `target_fact_id` no longer resolves to a row is **silently skipped** (not an error — revoke is legitimate).

### 7.5 Two `policy.embedding_backfill` events for the same fact

- Possible via crash-retry (§ 7.2) or future model migration.
- Latest by `ts` wins. Older event is logged but unused.

### 7.6 Worker tries to re-embed and row content has changed

- Forbidden by the append-only invariant. Defense in depth: queue entry carries `content_sha256`; worker drops the entry with `policy.embedding_backfill_abandoned {reason: "content_drift"}`. Recall remains in fallback for the row indefinitely or until a manual `rebuild-embed-queue.mjs` invocation.

### 7.7 Queue file deleted by operator

- Recall overlay continues to function on already-backfilled rows.
- Pending rows that haven't been backfilled yet are now lost work — the `rebuild-embed-queue.mjs` script (future, out of scope) is the recovery affordance.
- This is documented in the operations playbook entry that ships alongside this spec; not enforced in code.

---

## 8. Worked examples

### 8.1 Queue lifecycle — enqueue → drain → overlay

**Day 0, 14:00 UTC** — Gemini quota exhausted on all rotating keys. `git-log.jsonl` row arrives at the cascade.

```
Stage-0: ADMIT (no hard-drop rule fires).
Stage-1: components = {recency: 0.92, authorship: 1.0, content_mass: 0.78,
                       source_prior: 0.85, structural: 0.85}
         (novelty omitted; weight 0.25 redistributed pro-rata to other 5
          components — each gains 0.25 * (own_weight / 0.75))
         salience_score = 0.84
         decision: PROMOTE
```

`appendFactRow` writes:

```json
{
  "id": "fact_01HX...",
  "kind": "fact",
  "content": "R23: harden HNSW backfill",
  "source_refs": [{"source": "git_log", "source_msg_id": "..."}],
  "features": {
    "embedding_3072": null,
    "embedding_mrl_768": null,
    "embedding_model_version": null,
    "embed_state": true,
    "salience": {
      "score": 0.84,
      "components": {
        "recency": 0.92, "authorship": 1.0, "content_mass": 0.78,
        "source_prior": 0.85, "structural": 0.85,
        "novelty": null,
        "last_retrieved_ts": null, "use_count": 0
      },
      "weights_hash": "<SALIENCE_WEIGHTS_V1_HASH>",
      "weights_hash_at_admit": "<NOVELTY_REDISTRIBUTED_HASH>",
      "version": "salience-v1"
    },
    "entities": [...], "time_anchors": [...], "valence": "neutral",
    "episodicity": "episodic"
  },
  ...
}
```

Then queue append:

```
{"fact_id":"fact_01HX...","source":"git_log","content_sha256":"a3b1...","enqueued_at":"2026-06-20T14:00:01Z","attempt":0}
```

`policy.token.consumed` emitted. Watermark advances.

**Day 0, 14:01 UTC** — Worker tick fires. Tries to embed; Gemini returns 429.
Worker classifies as QUOTA_EXHAUSTED (transient), bumps `attempt` to 1, sets `next_eligible_tick = current + 2`. Entry remains in queue.

**Day 0, 18:00 UTC** — Quota recovers. Worker tick fires.

```
embedSingle(text="R23: harden HNSW backfill", taskType=RETRIEVAL_DOCUMENT)
  -> {vector_3072: [...], vector_mrl_renormalized: [...], embedding_model_version: "gemini-embedding-001"}
```

Worker emits:

```json
{
  "kind": "policy",
  "policy_kind": "embedding_backfill",
  "id": "0193...",
  "ts": "2026-06-20T18:00:14Z",
  "target_fact_id": "fact_01HX...",
  "embedding": {"vector_3072": [...], "vector_mrl_768": [...]},
  "embedding_model_version": "gemini-embedding-001",
  "emitter_module": "mcp/lib/synthesis/embed-backfill-worker.js",
  "emitter_version": "1.0.0"
}
```

Queue line removed.

**Day 0, 18:05 UTC** — Recall query "which tasks did I finish for the Larkmoor project" arrives.

Overlay (refreshed since a new `policy.embedding_backfill` event landed) contains `fact_01HX... -> {vector_3072: [...], vector_mrl_768: [...]}`.

Candidate `fact_01HX...` has `features.embedding_3072 == null` BUT the overlay supplies it.

```
s_emb := cosine(query_embedding, overlay_entry.vector_3072)  # e.g. 0.61
fallback_branch := false
```

Scored normally. Backfill complete.

### 8.2 Sustained outage — recall in fallback

**Day 1, 09:00 UTC** — Gemini still down. Operator recalls "LX-2 setup steps."

Candidate set includes 12 rows promoted during the outage; 8 of them have `entities` containing "LX-2" or "acmebot" (W3 stamped at PROMOTE time, embedding-independent).

For each:

```
embedding := null (own row); overlay has nothing.
s_emb := 0; fallback_branch := true
additive_sum := w_ent * entity_overlap_jaccard("LX-2", ["LX-2","SampleBot"]) + ...
             = 0.7 * 0.5 + 0.0 (no time anchor) + 0.3 * decay + 0.2 * valence + ...
             ≈ 0.38
0.38 >= ADDITIVE_FLOOR (0.10), keep.
```

Top-12 is constructed from the additive scores alone. The brief carries a `degraded_recall: true` flag and `fallback_branch_rate: 0.83` (10/12 candidates were in fallback). The user sees a coherent-but-thinner brief.

### 8.3 Mixed regime — partial backfill

**Day 2, 11:00 UTC** — Gemini quota partial; worker has drained 60% of the day-0 queue. Recall fires.

Some candidates have own embeddings (promoted before outage). Some have overlay-supplied embeddings (backfilled). A few have neither (still queued).

Per-candidate `embedding_source ∈ {"fact_row", "overlay", "none"}` is logged. The propensity log carries the stratification. Total recall quality is between the day-0 freeze and the steady-state baseline. Operator-visible: brief carries `fallback_branch_rate: 0.18` (decreasing).

---

## 9. Invariants (CI-enforceable)

| # | Invariant | Enforcement |
|---|---|---|
| I-1 | PROMOTE never blocks on embed. | Grep test: `mcp/lib/ingest/salience.js` does not import `embedSingle` on the promote hot-path (only the worker does). Behavioral test: simulate `embedSingle` throw — assert `appendFactRow` still called. |
| I-2 | `features.embedding == null` is a valid PROMOTE state. | `validation.js` accepts; assert in `cascade-embedding-decoupling.test.js`. |
| I-3 | Multi-feature scorer handles `s_emb == 0` via additive fallback. | Unit test: pass synthetic candidate with `features.embedding_3072 == null`; assert `final_score == additive_sum`; assert hard gates still applied. |
| I-4 | Single-producer for `policy.embedding_backfill`. | CI grep (§ 5.2). |
| I-5 | Single-producer for `embed-queue.jsonl` writes. | CI grep (§ 3.4). |
| I-6 | Overlay "latest by ts wins" on duplicate `target_fact_id`. | Unit test: inject two events with different ts; assert later one is returned. |
| I-7 | Overlay drops events whose `target_fact_id` does not resolve in `memory.jsonl`. | Unit test: emit event for non-existent fact_id; assert overlay does not surface it. |
| I-8 | `ADDITIVE_FLOOR` gate applies only when `fallback_branch == true`. | Unit test: pass non-fallback candidate with `additive_sum < ADDITIVE_FLOOR`; assert NOT dropped. |
| I-9 | Hard gates (predicate, consent, derivation_status) apply BEFORE per-candidate scoring, regardless of fallback. | Unit test: predicate-excluded fallback candidate with high `additive_sum` is dropped pre-scorer. |
| I-10 | L2-renormalization invariant survives the round-trip. | Unit test: `policy.embedding_backfill.embedding.vector_3072` has `\|\|v\|\| == 1.0 ± 1e-6` on read; ditto vector_mrl_768. |
| I-11 | Queue file is append-only between worker batches. | Unit test: mid-tick append from cascade does not corrupt the worker's reader (worker uses snapshot-on-batch-start; new appends processed on next tick). |
| I-12 | Recall logs `had_embedding_at_recall`, `embedding_source`, `fallback_branch_used` per candidate. | Schema test on the recall-event row; assertion that the values are populated on every candidate in a representative recall fixture. |
| I-13 | `embed_state == true` AND `embedding_3072 != null` is impossible (mutual exclusion). | Validator: cross-field check; test asserts validator rejects. |
| I-14 | The novelty-weight redistribution is byte-deterministic given the active weight vector. | Test: compute `weights_hash_at_admit` twice; assert equal. |

---

## 10. Open questions

### Q1 — `ADDITIVE_FLOOR` calibration

`0.10` is a prior. The right value is empirical: at what threshold do fallback-branch surfacings stop producing useful engagement? Resolution path: 2-week soak (see `propensity-logging-soak.md`) accumulates fallback recall events; week-3 analysis stratifies engagement by `additive_sum` quantile. If <10% of surfacings below 0.10 produce positive engagement and the floor is the right cut, ship as-is; otherwise raise.

### Q2 — Backfill worker batch size and tick interval

`EMBED_BACKFILL_BATCH_SIZE = 16` and `EMBED_BACKFILL_TICK_BUDGET_MS = 5000` are priors. Real values depend on Gemini's actual TPM under our key rotation and the daemon's idle-tick frequency. Resolve via dry-run instrumentation in the first week post-deploy.

### Q3 — Cross-version recall behavior

If the user migrates from `gemini-embedding-001` to a successor, the overlay must decide: prefer-new, RRF-across-versions, or quiesce-old. This spec defers to `research-retrieval-frontiers.md` § Risks #3 ("Gemini v2 migration trap") + the open question on coexisting indices. v0 ships single-version with hard reject of mismatched-version overlay entries. Decision required BEFORE first version bump.

### Q4 — Whether to re-emit novelty into the salience block after backfill

Today, salience's `novelty` component depends on Stage-2 (k-NN over the embedding). When backfill completes, we could either:

(a) Leave the salience score frozen at its Stage-1-only value (current spec, simpler).
(b) Emit a `policy.salience.novelty_backfill` event that the salience replay path folds in via the byte-idempotent replay mechanism.

(a) is the v0 contract. (b) is a future enrichment if the user's recall log shows that novelty-aware salience meaningfully outperforms Stage-1-only salience for backfilled rows. Out of scope for this spec.

### Q5 — Whether to extend the same pattern to corroboration

The cascade's CORROBORATE branch also depends on Stage-2 (HNSW k-NN). Under outage, with no embedding, the cascade can't detect duplicates → may admit templated traffic that should have corroborated an existing anchor. Mitigation: per-source entity-based dedupe at Stage-1 (already partially present via `cross-source-dedup.js`) catches many duplicates structurally. Pure-content templated dupes leak through. Future work: a separate `F-CCS-CASCADE-corroboration-deferred` spec could mirror this pattern (queue + backfill + post-hoc corroboration via new policy event). Explicitly out of scope here; flagged for tracking.

### Q6 — Whether `policy.embedding_backfill_abandoned` events should trigger a maintenance affordance

If the worker abandons a fact_id (max attempts, content drift), the row is stuck in fallback forever. Should the user see a digest? Resolution: a future `embed_backfill_abandoned_count` projection on `memory_health` surfaces totals; per-event detail lives in the policy log. Not blocking for v0.

---

## 11. Cross-tier impact

| Node | Tier | Relationship |
|---|---|---|
| `F-CCS-CASCADE-promote-without-embed` | cascade (implementer) | Implements § 3.3 — the salience.js change that calls appendFactRow without waiting on embed, plus the queue write. |
| `F-CCS-BACKFILL-engine` | backfill (implementer) | Implements § 3.5 — the worker module, the queue-drain loop, the `policy.embedding_backfill` emission. |
| `F-CCS-BACKFILL-recall-consumer` | backfill (implementer) | Implements § 4 — the overlay map, the per-candidate resolution, the additive-only branch wiring in the recall scorer. |
| `F-CCS-BACKFILL-trigger` | backfill (implementer) | Wires the worker into the daemon tick or supervised child-process lifecycle. |
| `F-CCS-FOUNDATION-feature-backfill-policy` | foundation (sibling) | Parallel pattern; this spec is the cascade-specific precedent. The feature-backfill-policy spec generalizes to entities / time_anchors / valence / episodicity using the SAME `policy_kind = "<feature>_backfill"` discipline. The single-producer-per-policy-kind rule keeps them disjoint. |
| `F-CCS-FOUNDATION-structured-features-schema` | foundation (sibling) | Pins the schema this spec relaxes (`features.embedding_3072` becomes optional/nullable). The two specs MUST agree on field names and validator contract before either implementer ships. |

### 11.1 Required ordering

1. `F-CCS-FOUNDATION-structured-features-schema` lands first (validator relaxation).
2. This spec lands (contract pinned).
3. `F-CCS-CASCADE-promote-without-embed` + `F-CCS-BACKFILL-*` implementers ship in parallel.
4. Recall consumer wires the overlay last (depends on the worker emitting events to consume).

### 11.2 Backwards-compat check between sibling specs

The feature-backfill-policy spec (entities / time_anchors / valence / episodicity backfill) uses the same pattern: `policy.<feature>_backfill {target_fact_id, <feature_payload>}`. The single-producer enforcement is per-policy-kind, so they don't collide. The recall overlay generalizes — the embedding overlay is just the first instance of a "feature overlay" pattern. Future refactor (NOT in scope) may extract a `mcp/lib/recall/feature-overlay.js` base.

---

## 12. Definition of done

- [ ] Validator accepts `features.embedding_3072 == null` and the new optional fields.
- [ ] `mcp/lib/ingest/salience.js` PROMOTE path writes the row immediately and appends to `embed-queue.jsonl` instead of awaiting `embedSingle`.
- [ ] `mcp/lib/synthesis/embed-backfill-worker.js` exists, exports `VERSION` + frozen `CAPS`, drains the queue, emits `policy.embedding_backfill`.
- [ ] `mcp/lib/recall/embedding-overlay.js` exists and is wired into the recall scorer.
- [ ] Multi-feature scorer applies the additive-only branch + `ADDITIVE_FLOOR` gate when `fallback_branch == true`.
- [ ] Recall event row carries `had_embedding_at_recall`, `embedding_source`, `fallback_branch_used` per candidate.
- [ ] All 14 invariants (§ 9) have at least one test in `cascade-embedding-decoupling.test.js`.
- [ ] CI greps for single-producer (queue, policy event) are wired into `mcp/scripts/check-single-producer.mjs`.
- [ ] `npm test` ≥ 98/98.
- [ ] Operator dry-run on 2026-06-20 frozen rows (`git-log.jsonl` 271 + `chat-claude-code.jsonl` 97 + `gh-events.jsonl` 28) confirms PROMOTE proceeds end-to-end with mock Gemini-throws-quota.
