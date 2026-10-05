# Held-Out Labeled Set — Operational Spec

> **Node:** `F-SYN-OPERATIONAL-held-out-labeled-set-v2`
> **Tier:** operational
> **Status:** authoritative; pins the v1→v2 held-out contract
> **Owns:** the `held_out_label` ledger event shape, the sampling/stratification rule, the label-set storage path, the v0→v1 and v1→v2 eval-metric definitions, the quarterly re-grow cadence, and the CI gate that refuses to claim "ranker improved" without paired-bootstrap CI excluding zero.

---

## 1. Mission

Pin the contract for the **150-row user-labeled held-out set** that the Phase 3 v1 ranker promotion gate depends on. Per `research-retrieval-frontiers.md § Phase 3 v1` and `§ Evaluation framework`, no v0→v1 ranker swap may claim improvement without paired-bootstrap CI excluding zero on this set; per `§ Phase 3 v2 success criteria`, no v1→v2 swap may claim improvement on the stratified-Recall@12-by-episodicity-quartile gate without the v2 label extensions defined here. This is also the gate that refuses LLM-as-judge self-preference (risk #15) by using Claude (different family) as a tiebreaker only.

The labeled set IS event-sourced — labels are stored as a new `held_out_label` ledger kind, each `derived_from` the recall event being labeled, so the set itself is auditable, version-stamped, and re-growable without losing the v0→v1 comparison anchor.

This spec answers:

- Which 150 recall events get labeled (sample design)
- What a label looks like (schema + storage)
- How the user labels them (workflow)
- What metrics the set produces (offline eval)
- When the set goes stale (re-grow cadence)
- How CI enforces the "no improvement without CI excluding zero" rule

---

## 2. KB Anchors (binding quotes)

Every binding quote below is verbatim from the cited file under `/tmp/memory-system-hypergraph-synthesis/audit_ref/` (which mirrors `<checkout>/kb/`).

### A. `research-retrieval-frontiers.md § Phase 3 v1 — Instruction-following reranker + held-out bootstrap`

> "150-event held-out set stratified by `(agent_role, time-of-day, recent_recall_density)`, user-labeled with `expected_ids[]/forbidden_ids[]/abstain:bool`, stored as `held_out_label` events `derived_from` the recall; offline metrics suite (Recall@12, MRR-expected, NDCG@12 with derivation-graph graded relevance + negative gain on `forbidden_ids`, Abstain F1) with paired-bootstrap 90% CI over 10k resamples vs Phase 0; LLM-as-judge (Claude, not Gemini — different family, order swap, length norm) as tiebreaker only."

Pins: sample size, stratification axes, label fields, storage as a new ledger kind derived_from the recall, the four offline metrics, bootstrap parameters, and the LLM-judge tiebreaker discipline.

### B. `research-retrieval-frontiers.md § Phase 3 v1 success criterion`

> "Recall@12 ↑ with 90% CI excluding zero; NDCG@12 ↑; Abstain F1 not worse; harm rate (forbidden_ids surfaced) not up; end-to-end p50 < 1s."

Pins: the CI gate. The set is the gate's only legitimate input.

### C. `research-retrieval-frontiers.md § Evaluation framework — Bootstrap plan`

> "Two-week passive collection at v0 (no eval, just log everything *with propensities*). Week 3: sample 150 recall events stratified by `(agent_role, time-of-day, recent_recall_density)`. User labels `expected_ids[]/forbidden_ids[]/abstain:bool` in batches of 20 (~15 min/batch, ~2 hours total — feasible but not free; critic §5). Labels stored as `held_out_label` events `derived_from` the recall event — the held-out set is itself event-sourced and auditable. Run all four offline metrics with paired-bootstrap 90% CI over 10k resamples vs Phase 0. **Refuse to claim improvement unless CI excludes zero.** Re-grow held-out set quarterly; alert if median label age > 90 days."

Pins: the soak-then-sample cadence, batch size + time budget, the auditable-event property, the refusal rule, the quarterly re-grow, and the 90-day staleness alarm.

### D. `research-retrieval-frontiers.md § Risks #13 — Held-out staleness`

> "Re-grow held-out set quarterly with stratified sampling; track label-age distribution; alert if median > 90 days."

Pins: re-grow cadence and the surfacing channel (the alarm rides on `memory_health.health_notes`).

### E. `research-retrieval-frontiers.md § Risks #15 — LLM-as-judge self-preference`

> "Use a different model family (Claude or GPT-4o); dual-order presentation; length normalization; LLM-judge only as tiebreaker between rankers with overlapping CIs."

Pins: LLM-judge is permitted as a tiebreaker ONLY; the judge must be a different family from the embedded ranker; bias mitigations (order swap, length norm) are mandatory.

### F. `research-retrieval-frontiers.md § Phase 3 v2 success criteria`

> "stratified Recall@12 by `query_episodicity` quartile shows episodic ↔ episodic, semantic ↔ semantic separation."

Pins the v2 extension: the same 150 events must carry `query_episodicity_quartile` ground truth so the v1→v2 gate is computable. Quartile assignment is hand-labeled at relabel time, BEFORE the episodicity sigmoid is calibrated — see § 10 (Open questions).

### G. `architecture.md § 4 — Memory ledger`

> "`recall` — logged retrieval (informs damping and reinforcement; carries the query embedding for predicate snapshotting)"

> "The `recall` kind's `query.context_embedding` is the canonical source `memory_exclude` reads when it server-snapshots a predicate's embedding from a `recall_id`. This field is distinct from `fact.features.embedding` and exists only on recall-kind events."

Pins: the recall-kind shape we sample from and derive_from.

### H. `architecture.md § 4 — Memory ledger (kind enumeration)`

> "Mixed kinds: `fact` ... `policy` ... `recall` ... `reconstructed`"

Pins: the four canonical kinds. **`held_out_label` is a fifth kind, added by this spec** (see § 4 — Decision: extend the canonical kind list, NOT a separate ledger). The rationale is in § 4.1.

---

## 3. Sample design

### 3.1 Size

**150 rows minimum.** Per critic §5 the user labor estimate is `~2 hours total = 7–8 batches × 20 events × ~15 min/batch`. The v1→v2 stratified-by-quartile gate requires per-cell n≥30 across 4 episodicity quartiles (per power analysis at § 6.5); 150/4 = 37.5 satisfies the floor with headroom.

### 3.2 Stratification axes (three-way)

The sample is stratified by the cross-product of three categorical features observed at recall time:

| Axis                       | Buckets                                       | Source                                                                                           |
|----------------------------|-----------------------------------------------|--------------------------------------------------------------------------------------------------|
| `agent_role`               | `{coding, planning, conversation, other}`     | `recall.provenance.agent_id` resolved through a static role-map; `other` is the catch-all bucket |
| `time_of_day_bucket`       | `{night, morning, afternoon, evening}`        | `recall.ts` resolved to operator-local timezone via `Intl.DateTimeFormat` then bucketed          |
| `recent_recall_density`    | `{low, medium, high}`                         | count of `kind:"recall"` events in the 6-hour window preceding `recall.ts`; quantile-cut over the sampling pool (low ≤ p33, p33 < medium ≤ p66, high > p66) |

Buckets pinned:

- **`time_of_day_bucket`** — `night = [00:00, 06:00)`, `morning = [06:00, 12:00)`, `afternoon = [12:00, 18:00)`, `evening = [18:00, 24:00)`. UTC offset derived from `Intl.DateTimeFormat().resolvedOptions().timeZone` at sampling time; pinned in the label event so a later TZ change does not re-bucket old labels.
- **`recent_recall_density`** — quantile boundaries computed against the sampling-pool population, not absolute counts (the soak volume is unknown a priori; absolute thresholds would mis-stratify low-volume weeks). Boundaries are themselves recorded in the label-set metadata header (see § 4.3).

Cross-product cells: `4 × 4 × 3 = 48 cells`. Target allocation: roughly `floor(150 / 48) ≈ 3` per cell, with overflow distributed to cells with the largest sampling pool (proportional-to-pool stratified sampling within the floor of 3 minimum). Empty cells are tolerated (operator's lab has no `night × coding × high` events in the soak window) and recorded as `cell_empty:true` in the label-set metadata so the gate is honest about coverage gaps.

### 3.3 Sampling source

`storage/recall.jsonl` (per `F-SYN-FOUNDATION-recall-log-split` — the **public** recall log; the private damping log is NEVER sampled because labels would leak engagement signal into the held-out set, violating the v3 IPS-training discipline). Sampling window: the two-week passive-collection soak at v0 (`research-retrieval-frontiers.md § Bootstrap plan`).

If `storage/recall.jsonl` does not yet exist (Phase 0 stub still routes recall to `ledgers/memory.jsonl § kind:"recall"`), the sampling source is `ledgers/memory.jsonl` filtered for `kind:"recall"` AND `ts ∈ [soak_start, soak_end]`. The sampler MUST emit a deprecation warning when reading from `memory.jsonl` directly — the split is the long-term contract.

### 3.4 Random seed for reproducibility

The sampler is seeded with `seed = blake2b("held-out-v" + label_set_version + "::" + soak_start_iso + "::" + soak_end_iso).slice(0, 16)`. The seed is recorded in the label-set metadata header so re-sampling the same `(version, soak_window)` is byte-identical. **No wall-clock seeding.** If `label_set_version` is bumped (quarterly re-grow), the seed changes deterministically.

### 3.5 Pool admission rules (what is sampled out)

Before stratification, the candidate pool is filtered:

- `recall.surfaced.length == 0` events EXCLUDED (no brief to label).
- `recall.density_flag == "abstain_emit"` events INCLUDED but flagged `is_abstain_candidate:true` so the labeler can confirm/refute the abstain decision (this is how Abstain F1 gets its positive labels).
- `recall.provenance.confidence < 0.3` events EXCLUDED (degraded recall — not representative).
- Events where ANY surfaced memory has been hard-excised (`fact.tombstoned:true`) since the recall EXCLUDED (the brief cannot be reconstructed for the labeler).
- Events from the same conversation as another already-sampled event are de-duplicated to at most 2 per conversation (prevents single-session bias).

---

## 4. Label schema

### 4.1 Decision: `held_out_label` as a new canonical kind

**`held_out_label` is a fifth canonical kind on `ledgers/memory.jsonl`**, NOT a separate ledger file. Rationale:

1. The KB anchor (§ 2.A and § 2.C) says "stored as `held_out_label` events `derived_from` the recall" — the `derived_from` semantics are defined on `architecture.md § 4` ONLY for ledger kinds. A separate file would break `derived_from` graph traversal.
2. The derivation graph (§ 5 Index — Derivation graph) is the substrate for forgetting propagation; a label event derived_from an excised recall must propagate orphan-flag the same way a `reconstructed` event would. Putting labels in a side file would require parallel propagation logic.
3. The corroboration projection and recall-trace index already filter by `kind`; adding a fifth kind costs nothing while a side-file index is novel surface area.

`architecture.md § 4` MUST be edited to add `held_out_label` to the canonical kind list. The edit is small but is a kb-edit prerequisite for shipping this spec's runtime code. See § 13 (Cross-tier impact).

Storage path: `<data root>/ledgers/memory.jsonl` (the same file as `fact`/`policy`/`recall`/`reconstructed`).

**Operational dual-write file: `<data root>/ledgers/held-out-labels.jsonl`** is an INDEX file (cache, not authoritative), built as a derived projection over `memory.jsonl` filtered to `kind:"held_out_label"`. It exists so the eval harness can `readJsonl` without walking the full memory ledger; it is rebuildable at any time from the source and is treated like the other `index/` artifacts (per `architecture.md § 5 — Index`). The label-set CLI tools read the index; the writer always writes to `memory.jsonl` first, then refreshes the index entry.

### 4.2 Per-event schema (v1 base + v2 extension)

```ts
type HeldOutLabelEvent = {
  // Common ledger fields (per architecture.md § 4)
  id: string;                         // ulid
  ts: string;                         // ISO-8601 server-stamped at write time
  kind: "held_out_label";
  provenance: {
    agent_id: "operator:<operator_id>";  // labels are operator-emitted only — no agent surface
    conversation_id: null;               // labeling is not conversational
    confidence: 1.0;                     // operator labels are ground truth by definition
  };
  derived_from: [string, ...string[]];  // [recall_event_id]; in v2 relabels, ALSO [prior_label_event_id]
                                         // — the v1 label stays immutable; v2 is an additive event

  // Payload (v1 base — REQUIRED on every label, all versions)
  payload: {
    label_set_version: "v1" | "v2";    // schema version (NOT label-batch version — see § 7.2)
    expected_ids: string[];             // memory_ids the brief SHOULD have surfaced (empty if abstain)
    forbidden_ids: string[];            // memory_ids that surfacing would be HARMFUL (empty allowed)
    abstain: boolean;                   // true if the brief should have emitted no content
    labeled_at: string;                 // ISO-8601 (when the user submitted, not when ledger appended)
    labeler_notes?: string;             // optional free text — surfaces in eval failure triage

    // Stratification metadata (frozen at label time — does NOT re-bucket on TZ change)
    strata: {
      agent_role: "coding" | "planning" | "conversation" | "other";
      time_of_day_bucket: "night" | "morning" | "afternoon" | "evening";
      recent_recall_density_bucket: "low" | "medium" | "high";
      tz: string;                       // IANA name resolved at sampling time
    };

    // v2 extension — REQUIRED when label_set_version == "v2", absent when "v1"
    expected_entities?: string[];       // canonical_ids the brief MUST capture (F-SYN-FOUNDATION-entity-schema)
    expected_time_anchors?: Array<{ kind: "absolute" | "relative"; value: string }> | null;
                                        // null means "labeler asserts NO anchor expected" (gate-mask=0 correctness)
                                        // [] means "anchor expected but operator left blank — re-label needed"
                                        // a non-empty array means the structured anchors per F-SYN-FOUNDATION-time-anchor-schema
    expected_valence_sign?: -1 | 0 | 1 | "UNLABELED";
                                        // UNLABELED excludes this label from valence-compat eval entirely
    query_episodicity_quartile?: 1 | 2 | 3 | 4;
                                        // hand-labeled BEFORE F-SYN-FOUNDATION-episodicity-feature sigmoid is calibrated
                                        // (breaks the circular-dependency risk; see § 10)
    relevant_for_episodicity_eval?: boolean;
                                        // false on ambiguous events; excluded from the v1→v2 gate computation
  };
};
```

Distinctions the labeler workflow MUST preserve:

- `expected_time_anchors: null` ≠ `expected_time_anchors: []`. `null` = "labeler asserts no anchor expected" (= correct behavior is gate-mask=0); `[]` = "labeler skipped this field, need re-labeling." The UI MUST default to neither and force an explicit choice.
- `forbidden_ids` may be empty; `expected_ids` may be empty (only when `abstain:true`). `expected_ids.length > 0 AND abstain==true` is rejected at write time.
- `expected_ids ∩ forbidden_ids == ∅` enforced at write time.

### 4.3 Label-set metadata header

A single `held_out_label_meta` event (a `policy` kind with `policy_kind:"held_out_label_meta"`) accompanies each label batch. Schema:

```ts
type HeldOutLabelSetMetaEvent = {
  id: string;
  ts: string;
  kind: "policy";
  policy_kind: "held_out_label_meta";
  applied_at: string;
  scope: { label_set_version: "v1" | "v2"; batch_id: string };
  targets: string[];                    // recall_event_ids included in this batch
  payload: {
    soak_window: { start_iso: string; end_iso: string };
    seed_hex: string;                   // 16-byte blake2b seed used by the sampler
    cell_allocation: Record<string, number>;
                                        // { "coding|morning|medium": 3, ... } — actual per-cell counts
    cell_empty: string[];               // cells with zero candidates in the pool
    density_quantile_boundaries: { p33: number; p66: number };
    sampler_version: string;            // git sha of bin/sample-held-out.mjs
  };
};
```

This event sits in `ledgers/memory.jsonl` alongside the per-event labels, so the full label set is reconstructable from the ledger alone.

---

## 5. Labeler workflow

### 5.1 Two-pass: sample, then label

**Pass 1 — sample (one-shot per label-set version):**
`bin/sample-held-out.mjs --version v1 --soak-start <ISO> --soak-end <ISO>` reads `storage/recall.jsonl`, runs stratified sampling per § 3, writes one `policy.held_out_label_meta` event with `targets = [recall_id, ...]` and NO per-event labels yet. Idempotent: re-running with the same `(version, soak_window)` is a no-op if the meta event already exists.

**Pass 2 — label (batches of 20, multi-session):**
`bin/label-held-out.mjs --version v1 --batch-size 20` iterates the un-labeled recall_ids from the meta event (skipping those that already have a `held_out_label` event derived_from them) and presents each as:

```
=== Recall 47 of 150 ===
recall_id: 01JE7V8K9XQZ...
ts: 2026-05-21T14:33:12Z (afternoon)
agent_role: coding
density_bucket: medium

--- surrounding_context ---
current_query: "did we decide to use HNSW or IVF for the index?"
recent_turns: [
  user: "let's revisit the ANN choice",
  assistant: "...",
  ...
]

--- brief that was surfaced ---
[1] mem_01JD... (score 0.83): "Decision: HNSW for vector index, per build-plan.md"
[2] mem_01JC... (score 0.79): "Hard gate: predicate exclusion before rerank"
[3] mem_01JB... (score 0.71): "(unrelated: budget meeting notes)"
...

[E] expected_ids (comma-separated)
[F] forbidden_ids
[A] abstain (y/n)
[N] notes
[S] skip / save & exit
```

Each batch saves intermediate state to `<data root>/policy/held-out-label-cursor.json` so a multi-session label session can resume.

### 5.2 v2 relabeling

`bin/relabel-held-out-v2.mjs` iterates existing `held_out_label` events with `label_set_version: "v1"`, presents each recall with the surrounding_context + brief AGAIN plus the v1 labels for context, and prompts for the five v2 extension fields. Each submission writes a NEW `held_out_label` event with:

```
label_set_version: "v2"
derived_from: [prior_label_event_id, recall_event_id]
expected_ids: <copied from v1 unless operator overrides>
forbidden_ids: <copied from v1 unless operator overrides>
abstain: <copied from v1 unless operator overrides>
labeled_at: <new ISO timestamp>
expected_entities: ...
expected_time_anchors: ...
expected_valence_sign: ...
query_episodicity_quartile: ...
relevant_for_episodicity_eval: ...
```

The v1 label event is NOT mutated — both events coexist, and `loadHeldOutLabels({version: 'v1'})` and `loadHeldOutLabels({version: 'v2'})` return disjoint snapshots.

Idempotency: re-running `relabel-held-out-v2.mjs` against a recall_id that already has a v2 label is a no-op (skip), not a duplicate event. Idempotency is enforced by scanning for `derived_from ⊇ {recall_id} AND label_set_version=="v2"` before prompting.

### 5.3 Operator time budget

Per `research-retrieval-frontiers.md § Bootstrap plan` (critic §5):

- v1 first-time label: **~2 hours total** = 7–8 batches × 20 events × ~15 min/batch.
- v2 relabel (when the user only fills the five new fields): **~30 minutes** because expected_ids/forbidden_ids/abstain are already labeled and the new fields are smaller-scope per event.
- Quarterly re-grow at 50 events/quarter: **~40 minutes/quarter**. At 38 events/quarter (to refresh per-cell counts): **~30 minutes/quarter**.

This labor is the genuine product risk (per `open-problems.md § 1 — Salience filter evaluation at N=1`). The spec acknowledges it; the open question in § 10 asks the user to confirm the cadence commitment.

---

## 6. Eval metrics

All offline metrics computed by `mcp/lib/eval/held-out-metrics.js`. The harness loads labels via `loadHeldOutLabels({version})`, joins each label to its `derived_from` recall event (re-reading `storage/recall.jsonl` for the brief and `ledgers/memory.jsonl` for the surfaced memories' content + features), and computes:

### 6.1 Recall@12

For each labeled recall: `|expected_ids ∩ surfaced_ids[:12]| / |expected_ids|`. Averaged across the set (macro-average; not weighted by `|expected_ids|` per event). Events with `abstain:true` AND `expected_ids:[]` AND `surfaced_ids:[]` count as `recall@12 = 1.0` (correct abstain); events with `abstain:true` AND `surfaced_ids != []` count as `recall@12 = 0.0` (failed abstain).

### 6.2 MRR-expected

For each labeled recall: `mean( 1 / rank_of_first(expected_id, surfaced_ids) )` if any expected_id is in surfaced, else 0. The mean is across events; events with `expected_ids:[]` are excluded from MRR.

### 6.3 NDCG@12 with graded relevance

DCG numerator uses graded gain per surfaced memory at rank `r`:

| Relation                                            | gain |
|-----------------------------------------------------|------|
| `mem_id ∈ expected_ids`                             | +2   |
| `mem_id` is a derivation-graph 1-neighbor of any expected_id | +1   |
| `mem_id ∈ forbidden_ids`                            | **−2** (NEGATIVE — encodes asymmetric harm) |
| otherwise                                           | 0    |

`NDCG@12 = DCG@12 / IDCG@12` where IDCG is computed from a hypothetical perfect ranking of {gain=+2 for all expected, +1 for all 1-neighbors, 0 for filler} truncated to 12. The negative-gain term means real-world NDCG can go below zero — the eval harness MUST NOT clip.

### 6.4 Abstain F1

Treating `abstain:true` labels as positive class and the ranker's `density_flag == "abstain_emit" OR surfaced:[]` as predicted positive: standard binary F1. Precision = `TP / (TP + FP)`; recall = `TP / (TP + FN)`; F1 = harmonic mean. Per LongMemEval ability #5 (Wu et al. 2025).

### 6.5 Harm rate (hard alarm)

`harm_rate = (# briefs with ANY forbidden_id in surfaced[:12]) / (# briefs total)`. **ANY positive triggers a hard alarm** — the CI gate refuses promotion even with positive Recall@12 lift if harm rate goes up.

### 6.6 Paired-bootstrap 90% CI, 10k resamples

For every metric, the harness:

1. Pairs each labeled event with its baseline (Phase 0 for v0→v1, v1 for v1→v2) brief.
2. Computes the per-event metric delta (`metric_new - metric_baseline`).
3. Resamples the delta vector with replacement 10,000 times; computes the 5th and 95th percentiles of the resampled means.
4. Reports the 90% CI `[p5, p95]`.

**Refuse to claim improvement unless the CI excludes zero on Recall@12 AND NDCG@12 does not regress AND Abstain F1 does not regress AND harm rate does not increase.** This is the CI gate (§ 11.3).

### 6.7 Statistical power for the v1→v2 stratified gate

Per critic §5 and the v2 gate's stratified-by-quartile requirement: with 150 events and 4 episodicity quartiles, per-cell n ≈ 37. A power analysis (`bin/eval-power-check.mjs`) computes — under a one-sided paired-bootstrap at α=0.10, target effect size 5% Recall@12 — the minimum n-per-cell required. If any quartile has fewer than the computed minimum (default ≥30), the v1→v2 gate REFUSES to activate and the harness emits `gate_inactive_reason: "under_powered_quartile=N"`. Re-grow targets that quartile with stratified resampling.

---

## 7. Re-grow cadence

### 7.1 Quarterly re-sample

Every 90 days, `bin/sample-held-out.mjs --version v3 --soak-start <last_3mo_start> --soak-end <now>` runs against the most recent 3 months of `storage/recall.jsonl`. Sampling rule: 50 new events (stratified per § 3) added to the working set; the oldest 50 v1 labels are marked `superseded_at` (a policy event, not a mutation — the original label stays in the ledger). Working set remains 150 rows; 100 are carryover, 50 are fresh.

If the user commits to only 30/quarter (open question § 10), the working set inflates to ~200 over 4 quarters and the oldest tier (>1 year) is dropped wholesale.

### 7.2 Label-set version vs schema version

Two version namespaces:

- **schema version** (`label_set_version: "v1" | "v2"`) — pinned by this spec, bumped only when payload fields change.
- **batch version** (`batch_id` in the meta event payload, e.g., `"2026Q2"`) — bumped every quarterly re-grow, recorded in the meta event but NOT in the per-event label payload.

The eval harness loads by schema version. Batches within a schema version are stacked; quarterly cadence is the user's discipline for keeping median label age fresh.

### 7.3 Median-label-age alarm

`memory_health` (per `F-SYN-OPERATIONAL-memory-health` or its current synthesis sibling) computes `median(now - label.payload.labeled_at)` over the active label set and surfaces:

```
health_notes: [
  ...,
  "held_out_label_median_age_days: 94 (alarm threshold: 90)",
]
```

The threshold is recorded in `mcp/lib/caps.js § HELD_OUT_STALENESS_DAYS_THRESHOLD = 90`. Surfacing in `memory_health.health_notes` is per `architecture.md § acquireExclusiveLockFile` discipline notes — the alarm is a soft signal, not a hard failure; the CI gate § 11 is the hard failure mode.

---

## 8. Implementation hints

Files to create. Existing modules to NOT duplicate are flagged.

### 8.1 New files

| Path                                            | Role                                                                              |
|-------------------------------------------------|-----------------------------------------------------------------------------------|
| `mcp/lib/eval/held-out-schema.js`               | Exports `HeldOutLabelV1Schema`, `HeldOutLabelV2Schema`, `HeldOutLabelMetaSchema`; pure JSON schema + validator. ESM. |
| `mcp/lib/eval/label-set.js`                     | `loadHeldOutLabels({version})`, `loadHeldOutLabelMeta({batchId})`, `writeHeldOutLabel(event)`. Reads `ledgers/memory.jsonl`; defensive try/catch around per-line JSON.parse — corrupt lines logged, not thrown. |
| `mcp/lib/eval/held-out-metrics.js`              | The four metrics + paired-bootstrap. Pure functions; no I/O. |
| `mcp/lib/eval/sampler.js`                       | The stratified sampler used by `bin/sample-held-out.mjs`. Deterministic given seed. |
| `mcp/lib/synthesis/labeler.js`                  | Shared labeler primitives (cursor save/restore, batch iteration) used by both `bin/label-held-out.mjs` and `bin/relabel-held-out-v2.mjs`. |
| `bin/sample-held-out.mjs`                       | CLI: stratified sample → write meta event. |
| `bin/label-held-out.mjs`                        | CLI: interactive labeling loop, batches of 20. |
| `bin/relabel-held-out-v2.mjs`                   | CLI: v1→v2 extension prompts. |
| `bin/eval-power-check.mjs`                      | CLI: power analysis for the v1→v2 stratified gate. |
| `scripts/regrow-labels.mjs`                     | CLI: quarterly re-sample (50 new events; mark 50 oldest as superseded). |

### 8.2 Existing modules to integrate (do NOT duplicate)

- `mcp/lib/synthesis/episodicity-scorer.js` — used at label-time to PRESENT (not assign) a sigmoid score for the user's reference; the user's hand-assigned `query_episodicity_quartile` is authoritative.
- `mcp/lib/synthesis/entity-extractor.js` — used at label-time to PRESENT canonical_ids for autocomplete in the `expected_entities` field.
- `mcp/lib/recall-log.js` — read-only source for `storage/recall.jsonl` discovery.
- `mcp/lib/policy-events.js` — the meta event (`policy.held_out_label_meta`) MUST be added to `EVENT_KINDS` and to the `kb/agent-integration.md § Token-event ownership table`. See § 13 cross-tier impact.
- `mcp/lib/caps.js` — add `HELD_OUT_STALENESS_DAYS_THRESHOLD = 90` and `HELD_OUT_TARGET_SIZE = 150` and `HELD_OUT_POWER_MIN_PER_QUARTILE = 30`.

### 8.3 Hermetic test setup pattern (per ENGINEERING DISCIPLINE)

Tests use `node:test` + `node:assert/strict`. Per project convention, set env vars BEFORE dynamic-importing the modules under test:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

test("loadHeldOutLabels respects label_set_version filter", async () => {
  const tmpRoot = await mkdtemp(...);
  process.env.MEMORY_SYSTEM_ROOT = tmpRoot;
  // ... seed ledgers/memory.jsonl with mixed-version events
  const { loadHeldOutLabels } = await import("../lib/eval/label-set.js");
  const v1 = await loadHeldOutLabels({ version: "v1" });
  const v2 = await loadHeldOutLabels({ version: "v2" });
  assert.equal(v1.length, 150);
  assert.equal(v2.length, 150);
  // v1 and v2 may share recall_ids but are distinct label events
  const v1Ids = new Set(v1.map(l => l.id));
  for (const l of v2) assert.ok(!v1Ids.has(l.id));
});
```

### 8.4 Defensive try/catch (per ENGINEERING DISCIPLINE)

Cross-module calls that might throw:

- `loadHeldOutLabels` → defensive on per-line JSON.parse; corrupt lines logged via `policy.salience.dropped` style audit, not thrown.
- `held-out-metrics.js` → defensive on `surfaced[]` being null/undefined when joining label to recall event; treat missing as `surfaced: []`.
- `regrow-labels.mjs` → defensive on the quarterly window having < 50 candidates after stratification; emit `regrow_under_target` warning, NOT throw.

---

## 9. CI gate — "refuse to claim improvement"

### 9.1 The gate

`bin/eval-held-out.mjs --baseline v0 --candidate v1` runs the full metric suite, computes paired-bootstrap CI per § 6.6, and exits:

- exit 0 (PROMOTE OK) iff: Recall@12 lower-bound > 0 AND NDCG@12 lower-bound ≥ 0 AND Abstain F1 lower-bound ≥ 0 AND harm rate upper-bound ≤ baseline harm rate.
- exit 1 (PROMOTE REFUSED) otherwise. The exit message names which condition failed.

### 9.2 CI integration

`npm test` from `<checkout>/mcp/` runs all 72 tests today. The eval harness is NOT run on every `npm test` (it requires a labeled set and the candidate ranker's output) — it is run as a separate `npm run eval:held-out -- --baseline v0 --candidate v1` invocation gated to the v0→v1 phase transition.

Test files under `mcp/test/` that this spec ADDS:

- `mcp/test/held-out-schema.test.mjs` — schema validation: rejects `expected_ids ∩ forbidden_ids != ∅`, rejects `expected_ids != [] AND abstain==true`, rejects mixed v1/v2 fields on a `"v1"` event.
- `mcp/test/held-out-metrics.test.mjs` — synthetic test set: known Recall@12, MRR, NDCG (with negative gain on forbidden), Abstain F1; assert exact metric values.
- `mcp/test/held-out-sampler.test.mjs` — sampler determinism: same `(seed, soak_window)` → byte-identical sample.
- `mcp/test/held-out-label-staleness.test.mjs` — median-age alarm fires at the right threshold.
- `mcp/test/held-out-paired-bootstrap.test.mjs` — bootstrap CI computation against a known-good reference distribution.

These keep the suite at ≥72 (current) + 5 = 77 or higher.

### 9.3 LLM-as-judge tiebreaker discipline (risk #15)

When the CI gate produces overlapping CIs between two ranker variants (both have `[p5, p95]` straddling zero or each other), the harness MAY invoke a Claude-family judge per `research-retrieval-frontiers.md § Risks #15`:

- judge model is Claude (different family from Gemini ranker)
- each comparison presents BOTH orderings (A-then-B and B-then-A), counts agreement
- length normalization: per-brief char count is reported alongside the judge's preference
- the judge's verdict is RECORDED in a `policy.held_out_judge_verdict` event but does NOT override the gate. The gate's hard pass/fail rule from § 9.1 remains authoritative; the judge breaks ties only when both Recall@12 and NDCG@12 CIs straddle zero and the user has elected `--allow-tiebreaker` explicitly.

---

## 10. Open questions

### 10.1 Cold start — what to do when soak hasn't accumulated 1000+ recall events

The two-week soak (`research-retrieval-frontiers.md § Bootstrap plan`) ASSUMES recall volume is at 10^3+ events. On a fresh single-user install with maybe 10–20 recalls/day, two weeks = 140–280 candidates, barely enough for 150 stratified samples and likely with empty cells across the 48-cell cross-product.

Two options on the table:

- **(a) Extend the soak window until pool ≥ 500.** Honest about the volume floor; delays Phase 3 v1 by weeks. Recommended default.
- **(b) Drop the stratification to two axes** (`agent_role × density`, omit time-of-day) until pool grows; document the reduced statistical power; re-stratify at first quarterly re-grow.

The spec defaults to (a). The CLI accepts `--allow-degraded-strata` to opt into (b) explicitly. The user chooses; the choice is recorded in the meta event payload.

### 10.2 Re-labeling stale rows — same operator or different?

Quarterly re-grow inserts 50 fresh events; the OLD 100 carryover events still have labels from the previous operator session (potentially months old). When a v1 event hits the median-age alarm (90 days), should the re-label be:

- **same operator?** Consistent voice; risk of confirmation bias (operator remembers their own earlier judgment).
- **different operator?** Single-user system. No "different operator" exists.
- **same operator + blind?** Operator re-labels WITHOUT seeing their prior label; we compare the two; disagreement → ambiguous event → exclude from gate.

Recommended: same operator + blind. The CLI hides the v1 label from the v2 relabel prompt by default.

### 10.3 LLM-as-judge to ASSIST labeling (not just judge rankers)

Could the labeler use Claude to pre-fill `expected_ids` guesses, accepting/correcting per event? Risk #15 (LLM-judge self-preference) is about judge-vs-ranker; using the judge to assist LABELING is a different concern (LLM bias contaminates the ground truth). Cross-check:

- if Claude pre-fills `expected_ids`, the user's accept-rate becomes a noisy label rather than ground truth.
- mitigation: the user MUST type the expected_ids freshly with a blank prompt; Claude assist appears ONLY in a "did the user forget any?" prompt at submission time.

Recommended: DEFER LLM assist until v3 (post-ranker-promotion). The v0→v1 baseline labels MUST be operator-only.

### 10.4 Empty cells in the 48-cell cross-product

Per § 3.2 some cells will be empty in any reasonable soak window. Options:

- **(a) tolerate empty cells**, record in `cell_empty:[]`, refuse to compute stratified-cell-level metrics for those cells.
- **(b) collapse adjacent cells** (e.g., merge `night × coding × high` into `night × coding × medium`), preserving statistical power at the cost of strata fidelity.

Recommended: (a). Empty cells are honest signal.

### 10.5 v1 label → v2 label drift on `expected_ids` overrides

If the user overrides `expected_ids` during v2 relabel (their judgment changed), the v0→v1 gate continues using the v1 label; the v1→v2 gate uses the v2 label. Both are valid for their respective gates. Drift IS tracked: `bin/eval-held-out.mjs --report-drift` produces a per-event diff between v1 and v2 expected_ids and reports `mean_drift_jaccard_distance`. > 0.3 → operator confidence in either v1 or v2 is suspect; gates pause for review.

---

## 11. Invariants — CI-enforceable

These are tested by `mcp/test/held-out-*.test.mjs` and gate `npm test`.

1. **Schema closure** — `held_out_label` events with fields outside `{id, ts, kind, provenance, derived_from, payload}` REJECTED. Tested by `held-out-schema.test.mjs`.
2. **derived_from non-empty** — every `held_out_label` event MUST have `derived_from[0]` resolvable to a `kind:"recall"` event in `ledgers/memory.jsonl`. Tested.
3. **expected_ids ∩ forbidden_ids == ∅** — enforced at write time. Tested.
4. **abstain consistency** — `abstain:true` ⇒ `expected_ids:[]`. Tested.
5. **null vs []** on `expected_time_anchors` — distinguishable; the schema validator rejects `undefined` in v2 events. Tested.
6. **Sampler determinism** — same `(seed, soak_window, pool)` produces byte-identical sample. Tested.
7. **NDCG negative gain** — forbidden_ids contribute −2; harness MUST NOT clip to zero. Tested with a synthetic case where NDCG < 0.
8. **Paired-bootstrap 10k resamples** — the harness's bootstrap loop runs exactly `BOOTSTRAP_RESAMPLES = 10000` resamples; pinned in `caps.js`; tested.
9. **Idempotent re-label** — re-running `relabel-held-out-v2.mjs` against a v2-labeled recall is a no-op. Tested.
10. **Label-set version isolation** — `loadHeldOutLabels({version:'v1'})` and `loadHeldOutLabels({version:'v2'})` return disjoint event id sets. Tested.
11. **Median-age alarm** — `memory_health.health_notes` includes the alarm when median > `HELD_OUT_STALENESS_DAYS_THRESHOLD`. Tested.
12. **Promotion gate refusal** — `bin/eval-held-out.mjs --baseline v0 --candidate v1` exits non-zero when Recall@12 CI straddles zero. Tested with a synthetic refusing case.
13. **Stratification frozen at label time** — TZ change after labeling does NOT re-bucket old labels (the `strata.tz` field is frozen). Tested.
14. **Pool admission rules** — sampler excludes `surfaced:[]` events, low-confidence events, and excised-recall events. Tested.

---

## 12. Stigmergy — do_step completion metadata

When this spec is implemented (the runtime modules + tests land), the implementer updates `F-SYN-OPERATIONAL-held-out-labeled-set-v2.json`'s `do_step` field to:

```json
{
  "completed_at": "<ISO-8601>",
  "completed_by": "synthesis-wave-7-op",
  "spec_path": "mcp/docs/specs/synthesis/held-out-labeled-set.md",
  "files_added": [
    "mcp/lib/eval/held-out-schema.js",
    "mcp/lib/eval/label-set.js",
    "mcp/lib/eval/held-out-metrics.js",
    "mcp/lib/eval/sampler.js",
    "mcp/lib/synthesis/labeler.js",
    "bin/sample-held-out.mjs",
    "bin/label-held-out.mjs",
    "bin/relabel-held-out-v2.mjs",
    "bin/eval-power-check.mjs",
    "bin/eval-held-out.mjs",
    "scripts/regrow-labels.mjs",
    "mcp/test/held-out-schema.test.mjs",
    "mcp/test/held-out-metrics.test.mjs",
    "mcp/test/held-out-sampler.test.mjs",
    "mcp/test/held-out-label-staleness.test.mjs",
    "mcp/test/held-out-paired-bootstrap.test.mjs"
  ],
  "files_modified": [
    "kb/architecture.md",                         // add held_out_label to canonical kind list
    "kb/agent-integration.md",                    // add policy.held_out_label_meta and policy.held_out_judge_verdict rows
    "mcp/lib/policy-events.js",                   // EVENT_KINDS additions
    "mcp/lib/caps.js"                             // HELD_OUT_STALENESS_DAYS_THRESHOLD, HELD_OUT_TARGET_SIZE, HELD_OUT_POWER_MIN_PER_QUARTILE, BOOTSTRAP_RESAMPLES
  ],
  "test_status": "npm test passes N/N (>= 77)",
  "open_questions_resolved": ["10.1 (default to extend-soak)", "10.2 (same operator, blind)", "10.3 (defer LLM assist to v3)"],
  "open_questions_deferred": ["10.4 (tolerate empty cells)", "10.5 (drift reporting)"]
}
```

The do_step write itself is per-`F-SYN-OPERATIONAL` convention: the implementer edits the JSON node file at `/tmp/memory-system-hypergraph-synthesis/nodes/F-SYN-OPERATIONAL-held-out-labeled-set-v2.json` with the above object.

---

## 13. Cross-tier impact — operational + behavior nodes that depend on this

### 13.1 Operational nodes (BLOCKED until this spec ships)

- `F-SYN-OPERATIONAL-phase-transition-criteria` — defines the v0→v1 and v1→v2 promotion gates; references this spec's CI gate (§ 9.1) as the sole legitimate computation of "ranker improved." No ranker promotion without this spec landed.
- `F-SYN-OPERATIONAL-offline-eval-harness` — implements `bin/eval-held-out.mjs`; entirely subsumes this spec's § 6 and § 9.
- `F-SYN-OPERATIONAL-damping-calibration-loop` — the engagement-gated reinforcement constants (K, engagement weights) calibrate against this set; refuse calibration changes that fail the CI gate.

### 13.2 Behavior nodes (LABEL-CONSUMER side)

- `F-SYN-BEHAVIOR-density-flag-feedback` — Abstain F1 (§ 6.4) consumes `abstain:true` labels; the density-flag emission rate calibrates against this metric.
- `F-SYN-BEHAVIOR-reconstructed-trigger-logic` — `reconstructed` rows are graded relevance +1 in NDCG when they are 1-neighbors of expected_ids; the trigger logic must be honest about which reconstructions count.
- `F-SYN-BEHAVIOR-thread-aggregation` — aggregated threads that surface in briefs count in `surfaced[]`; their labels need to be wired through the eval harness consistently.

### 13.3 Foundation node dependencies (REQUIRED to be implemented first)

- `F-SYN-FOUNDATION-recall-log-split` — provides `storage/recall.jsonl`, the sampling source (§ 3.3).
- `F-SYN-FOUNDATION-entity-schema` — provides canonical_id for `expected_entities[]` (§ 4.2 v2 extension).
- `F-SYN-FOUNDATION-time-anchor-schema` — provides anchor shape for `expected_time_anchors[]` (§ 4.2 v2 extension).
- `F-SYN-FOUNDATION-valence-provenance` — provides the valence channel that `expected_valence_sign` is measured against.
- `F-SYN-FOUNDATION-episodicity-feature` — provides the sigmoid the user's `query_episodicity_quartile` ground truth is compared against; per § 10 the labels precede the sigmoid calibration.

### 13.4 Integration node dependencies (touch the same surfaces)

- `F-SYN-INTEGRATION-CASCADE-STAMPS-ENTITIES`, `F-SYN-INTEGRATION-CASCADE-STAMPS-EPISODICITY` — the cascade-time stamps these write to `fact` events are what the eval harness reads to compute graded relevance.
- `F-SYN-INTEGRATION-RECALL-CONSUMES-TIME-ANCHORS` — the recall-time time-anchor consumption is what the v2 `expected_time_anchors[]` labels measure correctness against.

### 13.5 KB-edit prerequisites (must land before runtime code)

1. `kb/architecture.md § 4 — Memory ledger` — add `held_out_label` to the canonical kind list. Small edit (one bullet + a brief per-kind extension block).
2. `kb/agent-integration.md § Token-event ownership table` — add `policy.held_out_label_meta` and `policy.held_out_judge_verdict` rows per `F-SYN-INTEGRATION-token-event-table-update` discipline.

Both edits land in the same PR as the `mcp/lib/eval/` module.

---

## 14. Summary — what this spec pins

- **150 rows** sampled from a two-week soak of `storage/recall.jsonl`, stratified by `agent_role × time_of_day_bucket × recent_recall_density` (4 × 4 × 3 = 48 cells, target ≈3 per cell).
- Labels stored as a **new `held_out_label` canonical kind** on `ledgers/memory.jsonl`, each `derived_from: [recall_id]`. A derived index file `ledgers/held-out-labels.jsonl` is a cache.
- Per-event payload: `{label_set_version, expected_ids[], forbidden_ids[], abstain:bool, labeled_at, strata{...}}` for v1; v2 adds `expected_entities[]`, `expected_time_anchors[]|null`, `expected_valence_sign`, `query_episodicity_quartile`, `relevant_for_episodicity_eval`.
- **Operator workflow**: ~2 hours total for v1 (7–8 batches of 20), ~30 min for v2 relabel. Resumable, idempotent.
- **Four offline metrics**: Recall@12, MRR-expected, NDCG@12 with `+2/+1/0/−2` graded relevance, Abstain F1. Plus harm rate as hard alarm.
- **Paired-bootstrap 90% CI over 10,000 resamples**; CI gate refuses ranker promotion unless lower-bound > 0 on Recall@12 AND no regression on NDCG@12 / Abstain F1 / harm rate.
- **Quarterly re-grow** with median-age alarm at 90 days surfaced via `memory_health.health_notes`.
- **CI-enforceable invariants** at § 11; tested in `mcp/test/held-out-*.test.mjs`; current 72/72 suite stays green and grows to ≥77.
- **LLM-as-judge** (Claude, not Gemini) permitted as tiebreaker ONLY, never as primary judgment, with order-swap + length-norm bias mitigations.

This spec answers what the v1 promotion gate IS in mechanical terms. The Phase 0 → Phase 3 v1 transition cannot complete without this set existing, labeled, and consulted via the CI gate.
