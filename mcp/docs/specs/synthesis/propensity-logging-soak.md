# Propensity Logging Soak — Operational Spec

> **Node:** `F-SYN-OPERATIONAL-propensity-logging-soak`
> **Tier:** operational (Wave 7)
> **Status:** authoritative; pins the v0 propensity distribution + the soak window
> **Owns:** the Plackett-Luce-with-temperature contract over surfaced briefs, the 2-week soak collection period, the `recall_log_health` projection on `memory_health`.
> **Wave-7 verification:** confirms `mcp/lib/tools/recall.js` writes the canonical recall event shape end-to-end so the soak yields a usable OPE substrate at week 3.

---

## 1. Mission

Make Off-Policy Evaluation (OPE) at Phase 3 v3 mechanically possible. Three load-bearing decisions are pinned here:

1. The **propensity distribution** `P(surface | candidate, scores)` that `mcp/lib/recall/propensity.js` MUST compute and `mcp/lib/recall-log.js` MUST write on every surfaced item: Plackett-Luce over softmaxed multi-feature scores at temperature `τ` with 5% multiplicative jitter applied to per-candidate scores before softmax.
2. The **soak collection period** — 2 weeks of passive logging at v0, target ≥1000 recall events, no labels collected — before any sampling for held-out labeling (v1) or learned-ranker work (v3).
3. The **canonical recall-event shape** that `recall.js` is verified to write end-to-end as of W6, with any gaps (compared to this spec) listed in § 8 Required follow-ups — to be addressed in a separate work-unit, NOT in this spec.

Why these together: `research-retrieval-frontiers.md` § Bootstrap plan pins "Two-week passive collection at v0 (no eval, just log everything *with propensities*)" and § Phase 3 v0 deliverables pins "propensity logging from v0 is the load-bearing prerequisite. Without it OPE is biased to uselessness." Critic §5 explicitly flagged that the synthesis-as-written defined only "5% jitter" — which is not a propensity distribution and produces ill-defined importance weights at v3. This spec closes that gap.

---

## 2. KB Anchors

### A. `research-retrieval-frontiers.md` § Phase 3 v0 deliverables (Staged rollout plan)

> "**recall-as-event logging** of `query.context_embedding`, top-50 `surfaced[]{memory_id, score, position, propensity}` and per-candidate feature values; `memory.recall_feedback {recall_id, useful_ids, harmful_ids, expected_ids}` MCP; **explicit propensity distribution** (Plackett-Luce over softmaxed scores with temperature τ, plus 5% jitter — *not* jitter alone; critic §5)."

Pins: (a) the surfaced-row schema (`memory_id, score, position, propensity`); (b) Plackett-Luce over softmaxed scores at temperature `τ`; (c) 5% jitter is ADDITIVE to the Plackett-Luce distribution, NOT a substitute for it.

### B. `research-retrieval-frontiers.md` § Bootstrap plan

> "Two-week passive collection at v0 (no eval, just log everything *with propensities*). Week 3: sample 150 recall events stratified by `(agent_role, time-of-day, recent_recall_density)`. ... New ranker variants require OPE (Kiyohara 2023) on logged propensities **before** any live swap — propensity logging from v0 is the load-bearing prerequisite. Without it OPE is biased to uselessness."

Pins: (a) 2-week soak window; (b) labels are NOT collected during the soak — pure logging; (c) week 3 is the earliest sampling point; (d) Kiyohara 2023 OPE is the downstream consumer that fails outright without this substrate.

### C. `research-retrieval-frontiers.md` § Risks #11 — Position bias is from LLM attention

> "Position bias is from LLM attention, not user gaze — web-search PBM propensity tables don't transfer. Re-estimate propensities from logged data via intervention harvesting + 5% jitter from day 1. Do not import Joachims 2017 Table 1 wholesale."

Pins: the 5% jitter is the intervention-harvesting mechanism — it MUST be live from day 1 of the soak so position-bias propensity tables can be re-estimated from logs rather than imported.

### D. `research-retrieval-frontiers.md` Citation 10 — Kiyohara et al. 2023

> "Defines OPE estimator and the stochasticity requirement that makes 5% score jitter from v0 a non-negotiable design choice."

Pins: stochasticity is the OPE prerequisite. A deterministic policy has importance weight `1/0` for any off-policy comparator that ever selected a different candidate; the variance of IPS / SNIPS / DR estimators blows up.

### E. `research-retrieval-frontiers.md` § Risks #6 — CLTR insufficient at single-user scale

> "Stage learned ranking — v0 hand-tuned + RRF → v3 GBDT lambdarank with IPS only after ~10^4 engagement events. Never CLTR-from-scratch."

Pins: the soak's job is not to train a ranker. The soak's job is to populate the substrate so the v3 GBDT (whenever it arrives — months after the soak) has propensities to inverse-weight against. This frames the 2-week minimum: the soak MUST run end-to-end before v1 begins sampling for labels; the substrate keeps accruing through v1 → v2 → v3.

---

## 3. Propensity distribution — pinned formula

### 3.1 Inputs

- `scores: Array<number>` — the multi-feature `final_score` (v0) or `rerank_score` (v1, when Layer-3 Flash succeeded; falls back to `final_score` on degrade) for each candidate fed to the surfacing step. Per the W6 wiring in `recall.js` (§ j), the propensity step runs over the top-`RECALL_RERANK_INPUT_SIZE` (currently 25) by final_score, since the post-Layer-3 ordering IS the policy that produced the surfaced brief.
- `τ: number` — Plackett-Luce temperature. v0 prior **τ = `CAPS.PROPENSITY_TEMPERATURE_TAU_DEFAULT` = 0.3** (see § 3.4 for the choice rationale and § 9 Open questions for the calibration path).
- `jitter_seed: string` — deterministic seed for the 5% jitter. v0 uses `recall_id` so that replay of a historical recall row reproduces the identical propensity vector (required for OPE reproducibility).

### 3.2 Algorithm

```
1. For each i in [0, n):
     base_jitter[i] := uniform sample in [-1, +1], deterministic from
                       SHA-256(jitter_seed || counter_block_i).
     local_scale[i] := PROPENSITY_JITTER_FRACTION * |scores[i]|
                       (currently 0.05 — i.e. 5% of the per-candidate
                       score magnitude)
     jittered_score[i] := scores[i] + base_jitter[i] * local_scale[i]

2. propensity[i] := softmax(jittered_score, τ)[i]
                  = exp(jittered_score[i] / τ)
                    / Σ_j exp(jittered_score[j] / τ)

3. Invariant: Σ_i propensity[i] == 1.0 ± 1e-6.
```

This is the existing behaviour of `mcp/lib/recall/propensity.js § computePropensities`; this spec promotes it from an implementation detail to a contract.

### 3.3 Concrete formula

For a candidate at position `k` in the input set of `n` survivors:

```
                                    exp( (s_k + j_k * 0.05 * |s_k|) / τ )
  P(position k | scores) =  ─────────────────────────────────────────────────────
                            Σ_{i=0..n-1} exp( (s_i + j_i * 0.05 * |s_i|) / τ )
```

where `j_i ∈ [-1, +1]` is the deterministic jitter sample.

### 3.4 Why τ = 0.3 (v0 prior)

τ trades off **immediate retrieval quality** against **OPE-substrate quality**:

| τ | Behaviour | OPE viability |
|---|---|---|
| 0 | Argmax — deterministic top-K | IPS importance weight `→ ∞` for any non-matching off-policy candidate (Kiyohara 2023). OPE dead. |
| 0.3 (v0 prior) | Top items strongly preferred, tail receives non-negligible mass | Soft; importance weights bounded; small expected NDCG cost (1–3% per PL literature) |
| 1.0 | Mild preference; broad exploration | OPE variance lowest, retrieval quality worst |
| ∞ | Uniform — random sampling | Retrieval useless |

τ = 0.3 is a **tunable knob**, pinned in `mcp/lib/validation.js § CAPS.PROPENSITY_TEMPERATURE_TAU_DEFAULT`. § 9 Open questions records the open calibration question: how do we know v0 τ=0.3 is right? The soak itself provides the first data point — § 7 health-probe surfaces the realized propensity distribution `(p10, p50, p90)` so the user can spot a regression mid-soak.

### 3.5 Why this is NOT the per-rank Plackett-Luce decomposition

The original Plackett-Luce model factors the joint probability of an ORDERED ranking as `∏_k softmax-over-remaining(scores)`. A strict reading of "Plackett-Luce over softmaxed scores" would log the product over the K realized positions for the K-item ranking.

The v0 contract here is the **per-position softmax**, NOT the product-over-positions joint. Three reasons:

1. **MMR + brief caps make positions partly correlated.** The surfaced ordering is the output of the Layer-3 rerank → MMR → brief-cap pipeline, not a direct PL sample. The per-position softmax is the right one-shot stochasticity logged at the *surfacing* boundary, not a generative model of how the rank itself was assembled.
2. **OPE estimators that need joint propensities (e.g. PL-IPS) can re-derive the joint from logged per-position values if the user wants.** Logging the per-position propensity gives downstream estimators the maximum optionality; logging the joint discards information.
3. **Implementation simplicity matches W6 verification.** `recall.js` calls `computePropensities` once per recall and writes one `propensity` per surfaced item — the W6 wiring is intact; this spec confirms rather than mutates it.

If, in v3, a downstream estimator demands the joint propensity, the per-position values logged here are sufficient to reconstruct it deterministically (jitter seed is logged via `recall_id`); no re-soak is needed.

### 3.6 Why this satisfies Kiyohara 2023 stochasticity prerequisite

The Plackett-Luce softmax at τ=0.3 with 5% jitter gives every candidate in the top-25 a propensity strictly in (0, 1) — no candidate ever has `P=0` or `P=1`. Thus IPS/SNIPS/DR importance weights are finite and the variance of the off-policy estimator is bounded.

5% jitter alone would have given the argmax candidate `P ≈ 0.95` and all others `P ≈ 0.05/n` — a quasi-deterministic policy that makes OPE estimators unreliable. The Plackett-Luce softmax replaces that with a smooth distribution over the top-25.

---

## 4. Recall event shape — canonical contract (verbatim)

The following shape is what `appendRecallEvent` in `mcp/lib/recall-log.js` writes to `ledgers/recall.jsonl`. This spec PINS it as the canonical shape for the soak; v0/v1 consumers MUST match it byte-for-byte.

```jsonc
{
  "id": "rec_<16hex>",                    // recall_id; jitter_seed source
  "ts": "<ISO-8601 server timestamp>",
  "kind": "recall",
  "query": {
    "surrounding_context_hash":            "<sha256 of canonicalJson(ctx)>",
    "context_embedding":                   [...3072 floats, or [] when degraded_recall],
    "embedding_model_version":             "gemini-embedding-001"
  },
  "surfaced": [
    {
      "memory_id":     "<id>",
      "score":         <final_score from multi-feature scorer>,
      "position":      <0-indexed rank in the brief>,
      "propensity":    <Plackett-Luce softmax value, ∈ (0, 1)>,
      "rerank_score":  <Flash listwise score | null when degraded_recall_layer3>,
      "feature_breakdown": {
        "s_emb_full3072":         <number>,
        "predicate_mask":         <0 | 1>,
        "consent_dampener":       <number ∈ [0, 1]>,
        "derivation_status":      <number ∈ [0, 1]>,
        "episodicity_match":      <number ∈ [0, 1]>,
        "entity_overlap_jaccard": <number ∈ [0, 1]>,
        "time_anchor_match":      <number ∈ [0, 1]>,
        "power_law_decay":        <number ∈ [0, 1]>,
        "valence_compat":         <number ∈ [0, 1]>,
        "engagement_prior":       <number>
      }
    }
    // … one entry per surfaced item, in brief order, capped per
    // RECALL_BRIEF_MAX_ITEMS (currently 12)
  ],
  "candidates_pre_truncation": [
    {
      "memory_id":    "<id>",
      "position":     <0-indexed rank in the post-Layer-2 sort>,
      "score":        <final_score>,
      "rerank_score": <Flash score | null for positions 25..49>
    }
    // … up to RECALL_CANDIDATE_SET_SIZE (currently 50) entries
  ],
  "density_flag":            <"ok" | "many_candidates_near_topic" | "sparse_neighborhood" | "crowded_neighborhood" | …>,
  "degraded_recall":         <bool — true when Gemini embed failed and BM25-only fallback ran>,
  "rerank_attempted":        <bool>,
  "rerank_failed_reason":    <string | null>,
  "layer3_latency_ms":       <number>,
  "degraded_recall_layer3":  <bool — true when Flash rerank failed or was skipped>,
  "caps_snapshot":           { /* salience weights hash + rerank caps */ },
  "populator":               { /* W6 synthesis populator metadata, see context-populator.md § 4.7 */ }
}
```

The spec definition of "what MUST be logged" per the user prompt and § 2.A simplifies to the following minimum:

| Field | Type | Required | Source |
|---|---|---|---|
| `kind` | `"recall"` | yes | `recall.js` literal |
| `query.context_embedding` | `Array<number>` (3072d) or `[]` | yes | first segment vector, or `[]` when degraded_recall |
| `query.embedding_model_version` | string | yes | `GEMINI_CLIENT_CONSTANTS.GEMINI_EMBEDDING_MODEL_VERSION` |
| `query.surrounding_context_hash` | sha256 hex | yes | `createHash("sha256").update(canonicalJson(ctx))` |
| `surfaced[].memory_id` | string | yes | per item |
| `surfaced[].score` | number | yes | per item, final_score from multi-feature scorer |
| `surfaced[].position` | int ≥ 0 | yes | per item |
| `surfaced[].propensity` | number ∈ (0, 1) | yes | per item, computed via § 3 |
| `surfaced[].dense_score` | number \| null | OPTIONAL — see § 8 follow-up F1 | not currently logged at surfaced[] level |
| `surfaced[].bm25_score` | number \| null | OPTIONAL — see § 8 follow-up F1 | not currently logged at surfaced[] level |
| `surfaced[].rerank_score` | number \| null | yes | per item, null on Layer-3 degrade |
| `density_flag` | enum | yes | `emitDensityFlag` output |
| `truncated` | bool | yes (envelope) | brief envelope; see § 8 follow-up F2 |
| `degraded_recall_layer3` | bool | yes | top-level field |

The required minimum is what § 2.A pins. The OPTIONAL fields (`dense_score`, `bm25_score`) are flagged as § 8 follow-up F1 because they currently live on the `candidates_pre_truncation` entries (via `hybridRetrieve`'s output) but are not propagated to the surfaced-row level; adding them is a separate work-unit, NOT in scope here.

---

## 5. Soak collection period — pinned

### 5.1 Window

**2 weeks** of passive collection, measured from the first appended row in `ledgers/recall.jsonl` whose `ts` falls in the soak window. The window is wall-clock, not "until we hit N events" — short soak windows under low traffic produce non-representative substrate.

### 5.2 Volume target

**≥ 1000 recall events** within the 2-week window. Stratified sampling for week-3 labeling (per § 2.B) requires a non-trivial event count per stratum; the synthesis literature anchor is the LongMemEval 150-event held-out set stratified by `(agent_role, time-of-day, recent_recall_density)` → minimum 1000 to support stratified sampling of 150 with ~7 events per stratum.

If the soak hits 2 weeks but < 1000 events: extend wall-clock until ≥ 1000 events are collected. Surface this via § 7 health probe; do NOT silently cut the soak short.

### 5.3 No labels during soak

The soak is **pure logging**. No `held_out_label` events, no `useful_ids` / `harmful_ids` / `expected_ids` feedback, no operator inspection of `surfaced[]` IDs. The labeling pass at week 3+ is a separate node (`F-SYN-OPERATIONAL-offline-eval-harness`); admitting label data into the soak window would couple the propensity substrate to label collection, polluting the OPE downstream.

### 5.4 No exploration boost during soak

The soak runs the production pipeline as-is. No τ annealing, no forced top-K exploration, no synthetic recall injection. The soak's purpose is to characterize the production distribution; mutating it produces a substrate that does not represent the system as deployed.

### 5.5 Reset rule

If the propensity distribution shape changes mid-soak (e.g. τ is tuned, the jitter fraction is changed, the Plackett-Luce decomposition switches to per-rank joint), the soak window resets and the pre-change rows are excluded from week-3 sampling. The schema-version bump is the trigger; see § 9 Invariant I3.

---

## 6. Verification of W6 integration

Read of `mcp/lib/tools/recall.js` (W6 wiring) confirms the following end-to-end:

| Spec requirement (§ 4) | W6 site in `recall.js` | Status |
|---|---|---|
| `id` (recall_id) | line 393: `"rec_" + randomBytes(8).toString("hex")` | OK |
| `ts` | line 761: `serverTs()` | OK |
| `kind: "recall"` | line 773 (event object literal) | OK |
| `query.surrounding_context_hash` | lines 394–396: `createHash("sha256").update(canonicalJson(ctx))` | OK |
| `query.context_embedding` | lines 778–780: first segment 3072d vector, `[]` on degrade | OK |
| `query.embedding_model_version` | line 781: `EMBEDDING_MODEL_VERSION` constant | OK |
| `surfaced[].memory_id` | line 710 | OK |
| `surfaced[].score` | line 711 | OK |
| `surfaced[].position` | line 712 | OK |
| `surfaced[].propensity` | lines 713–715: `propensityByMemoryId.get(memory_id)` | OK |
| `surfaced[].rerank_score` | line 719: null when not in rerank input | OK |
| `surfaced[].feature_breakdown` | lines 720–733: all 10 multi-feature components | OK |
| `candidates_pre_truncation[]` | lines 747–759: up to `RECALL_CANDIDATE_SET_SIZE` (50) entries | OK |
| `density_flag` | line 785 | OK |
| `degraded_recall` | line 786 | OK |
| `rerank_attempted` | line 788 | OK |
| `rerank_failed_reason` | line 789 | OK |
| `layer3_latency_ms` | line 790 | OK |
| `degraded_recall_layer3` | line 791 | OK |
| `caps_snapshot` | line 794: `capsSnapshot()` from rerank module | OK |
| `populator` | lines 798–817: W6 synthesis populator metadata | OK |
| Propensity computation (§ 3 algorithm) | lines 650–669: `computePropensities({candidate_scores, tau, jitter_seed})` with `tau = CAPS.PROPENSITY_TEMPERATURE_TAU_DEFAULT`, `jitter_seed = recallId` | OK |
| `appendRecallEvent` is invoked end-to-end | line 829: inside the `try { appendRecallEvent(recallEvent); } catch …` | OK — wired |
| Failure visibility on append error | lines 830–840: returns `{ ok:false, error: INTERNAL_ERROR }` envelope | OK |

**Verdict:** the W6 wiring writes the canonical recall event shape end-to-end. The propensity distribution computed matches § 3 (Plackett-Luce softmax with τ = `CAPS.PROPENSITY_TEMPERATURE_TAU_DEFAULT` and 5%-of-|score| jitter seeded by `recall_id`). The substrate is sufficient for the 2-week soak to begin once this spec lands. Required follow-ups are in § 8 — they are gap-closing fields, NOT correctness bugs against the v0 minimum contract pinned in § 2.A.

---

## 7. Health probe

`memory_health` MUST expose a new top-level projection `recall_log_health` with the following shape:

```jsonc
"recall_log_health": {
  "window_days":             14,
  "rows_in_window":          <integer count of recall.jsonl rows with ts in last 14 days>,
  "propensity_present_rate": <float in [0, 1] — fraction of rows whose every surfaced[] entry has a finite propensity in (0, 1)>,
  "density_flag_rate":       <float in [0, 1] — fraction of rows whose density_flag !== "ok">,
  "degraded_recall_rate":    <float in [0, 1] — fraction of rows with degraded_recall:true>,
  "degraded_recall_layer3_rate": <float in [0, 1] — fraction with degraded_recall_layer3:true>,
  "propensity_distribution": { "p10": <float>, "p50": <float>, "p90": <float> },
  "soak_status": <"not_started" | "in_progress" | "complete" | "extended_low_volume">
}
```

Rationale per field:

- `window_days` is fixed at 14 to match § 5.1 soak window; the field is included in the projection so dashboards do not have to hard-code the constant.
- `rows_in_window` is the soak progress meter. `soak_status` flips `not_started → in_progress` on the first row and `in_progress → complete` when `rows_in_window ≥ 1000 AND window_days ≥ 14`. If `window_days ≥ 14 AND rows_in_window < 1000` it goes to `extended_low_volume` per § 5.2.
- `propensity_present_rate` MUST be 1.0 throughout the soak. Any value below 1.0 is a correctness bug — the spec-mandated invariant in § 9 (I1) is `propensity ∈ (0, 1)` on every surfaced row.
- `density_flag_rate` is a sanity signal: a sudden change in density-flag distribution mid-soak suggests an upstream shift (predicate ledger churn, MMR threshold drift) that may invalidate the soak.
- `degraded_recall_rate` and `degraded_recall_layer3_rate` are quality signals — a high rate during the soak means the substrate is biased toward the BM25-only / no-Flash fallback distribution, which v3 IPS estimators must be aware of (see § 9 Open Q2).
- `propensity_distribution` (p10/p50/p90) lets the user spot a τ regression mid-soak rather than at day 14: a healthy distribution at τ=0.3 places the median propensity in roughly the inverse of the input size (~1/25 = 0.04 for top-25 input); collapse toward 1.0 / 25.0 (uniform) or toward 1.0 (deterministic argmax) is an early warning.

The probe is structural over `ledgers/recall.jsonl` — a tail-scan over the last 14 days of rows. It is read-only; it does NOT mutate the ledger.

---

## 8. Required follow-ups (out of scope for this WU)

The W6 wiring matches the v0 minimum contract pinned in § 2.A. The gaps below are gap-closing fields the broader spec (§ 4 canonical table) names as optional or that would tighten the substrate for v3 OPE. Each is a separate work-unit, NOT to be addressed here.

**F1. Propagate `dense_score` / `bm25_score` onto `surfaced[]`.**
`hybridRetrieve` returns per-candidate `dense_score` and `bm25_score`, and `recall.js` propagates them onto the `candidates_pre_truncation` shadow (via the candidate spread at line 458). They do NOT survive onto `surfaced[]`. Adding them would let v3 IPS estimators decompose the Layer-1 fusion contribution per surfaced item. Out of scope for this WU; flagged as the only field-shape gap vs the user-prompt minimum.

**F2. Add `truncated: bool` at the recall-event level (not just the brief envelope).**
`recall.js` returns `truncated` on the brief envelope (line 864) but does NOT include it on the `recallEvent` object written to `recall.jsonl`. Add `truncated: scored.length > capped.length` to the event object so the ledger row is self-contained for offline analysis. Minor.

**F3. Distinguish `density_flag = null` vs `"ok"` in the on-disk row.**
`recall.js` writes `density_flag` directly to the event (line 785) but the brief envelope rewrites `"ok"` to `null` on the way out (line 869). The on-disk row preserves `"ok"`; this is correct per § 4 but is worth pinning explicitly so a future cleanup pass does not propagate the envelope's null-substitution into the recall log.

**F4. Provide the `memory_health.recall_log_health` probe.**
Currently `memory_health` does not expose the § 7 projection. Implementing it is a separate observability WU; the spec § 7 pins the shape so the implementer has a single target.

**F5. Soak-gate enforcement.**
The user prompt does not include the soak-gate (`assertSoakComplete()` throwing before v3 ranker promotion) in scope for this WU. The node card's `implementation_hints` field flags it as part of the broader operational story (file (e) in that hint block). When `F-SYN-OPERATIONAL-offline-eval-harness` is opened, it MUST consult this spec's § 5 (soak window + volume) and § 7 (`soak_status`) as the gating contract.

---

## 9. Invariants — CI-enforceable

**I1. Propensity domain.** For every row in `ledgers/recall.jsonl`, for every entry in `surfaced[]`: `0 < propensity < 1` and `Number.isFinite(propensity) === true`. A row with any surfaced propensity `0`, `1`, `NaN`, or missing is a correctness bug.

**I2. Propensity sum normalization (over the rerank-input set).** The propensity values for the candidates fed to `computePropensities` (which is the top-`RECALL_RERANK_INPUT_SIZE` of `scored` per `recall.js` § j) sum to 1.0 ± 1e-6. The CI probe samples this on synthetic recall traces; the runtime invariant is already asserted in `computePropensities` (lines 197–201).

**I3. Schema-version stability through the soak.** During the 2-week soak window, the propensity distribution shape (Plackett-Luce-with-temperature; jitter fraction; jitter seed binding to `recall_id`) MUST NOT change. CI gate: a per-row schema-version field (proposal: surface `caps_snapshot.PROPENSITY_TEMPERATURE_TAU_DEFAULT` + `caps_snapshot.PROPENSITY_JITTER_FRACTION` as the propensity-shape fingerprint; any mid-soak change resets the soak window per § 5.5).

**I4. Per-row required field coverage.** Every row in `ledgers/recall.jsonl` has all of: `id`, `ts`, `kind:"recall"`, `query.surrounding_context_hash`, `query.embedding_model_version`, `surfaced` (possibly empty), `candidates_pre_truncation` (possibly empty), `density_flag`, `degraded_recall`, `degraded_recall_layer3`. The CI tail probe parses each row and asserts presence; missing-field rows fail closed.

**I5. Embedding-model-version pinning.** `query.embedding_model_version` equals `GEMINI_CLIENT_CONSTANTS.GEMINI_EMBEDDING_MODEL_VERSION` for every row in the soak window. A mid-soak model bump invalidates the substrate (geometric scale of `score` changes); the version mismatch is the gate.

**I6. Jitter determinism.** Two recalls with identical `jitter_seed` (i.e. identical `recall_id`) and identical candidate scores produce bit-identical propensity vectors. The property is tested in `mcp/test/recall/propensity-replay.test.mjs` (proposal — not strictly required for the soak, but trivial to add).

**I7. `propensity_present_rate` = 1.0 throughout the soak.** The § 7 health probe surface MUST report `propensity_present_rate === 1.0` for every health poll inside the soak window. Any value below 1.0 is a P0 alarm — the substrate is producing soak rows that v3 OPE cannot use.

**I8. No labels in soak window.** No row in `ledgers/memory.jsonl` of `kind: "held_out_label"` with `derived_from` pointing at a recall row within the soak window. The soak is pure logging per § 5.3. The CI probe asserts the empty set.

---

## 10. Open questions

**Q1. τ calibration — how do we know v0 τ=0.3 is right?**
The choice is principled (medium-stochasticity; OPE viable; small expected NDCG cost) but not empirically calibrated against this system's score distribution. The soak itself is the first calibration opportunity: the § 7 `propensity_distribution` (p10/p50/p90) over 1000+ events gives the user a realized distribution to compare against expected. If at week 1 the distribution is overly concentrated (p90 ≈ p50) or overly diffuse (p90 ≈ 1/n), τ should be re-tuned at the soak boundary. Defer the call to the v1-bootstrap WU.

**Q2. Cold-start exploration — higher τ for the first N recalls?**
Counter-argument: the first N recalls are also when the ledger is small and the predicate set is unstable; high-τ exploration here could surface stale or contaminated memories the user has to dismiss. Defer until the soak produces evidence one way or the other. The § 7 `density_flag_rate` is the leading indicator: if it tracks high at the soak start and falls toward week 2, the natural in-process exploration is sufficient and a cold-start boost would be redundant.

**Q3. Should the soak re-run on `embedding_model_version` bump?**
A v1 → v2 Gemini bump changes the geometric scale of `score`, which changes the softmax shape at fixed τ. Logically the soak must re-run. The operational cost is 2 weeks of held-out v3 work; the alternative is to admit a τ re-tune across the version boundary. Defer to the embedding-migration WU; flag here so it is not forgotten.

**Q4. Should `degraded_recall=true` rows count toward the 1000-event volume target?**
A degraded recall is a valid candidate-surfaced event with a valid propensity (computed over BM25-only candidates). It IS part of the production distribution. The conservative answer is YES — count them; the soak characterizes the system as deployed. The aggressive answer is NO — exclude them so the substrate is dense-only; v3 IPS would then need a separate degraded-recall correction. Recommendation: YES, count them; surface the `degraded_recall_rate` in § 7 so the user can decide whether to require additional soak time after a degraded-heavy week.

**Q5. Per-position joint propensity (PL decomposition over the realized rank)?**
§ 3.5 pins per-position softmax, not the joint over the realized K-item rank. If v3 demands the joint, it can be derived from the logged per-position values + the logged jitter seed (`recall_id`). Confirm with the v3 ranker WU before committing to a re-log.

**Q6. Position bias propensity table (Risks #11)?**
The Joachims 2017 propensity table (web-search PBM) does not transfer to LLM-attention bias. The soak's 5% jitter is the substrate from which a system-specific position-bias propensity table can be re-estimated via intervention harvesting — this estimation pipeline is a v3 concern, NOT a v0 soak concern. Flagged here because the soak makes it *possible*; the actual estimator is downstream.

---

## 11. Cross-tier impact

**Blocks (per node card):**

- **`F-SYN-OPERATIONAL-offline-eval-harness`** — the held-out labeling pass at week 3+ requires the soak to be `complete` per § 7 `soak_status`. The harness MUST consult `memory_health.recall_log_health.soak_status` before sampling. Sampling against an incomplete soak produces a biased held-out set (selection-on-active-traffic).
- **`F-SYN-OPERATIONAL-damping-calibration-loop`** — the damping CAPS (K, raw-surfacing penalty, engagement weights per `recall-log-split.md § D`) are calibrated from the recall+damping ledger pair. The damping log is keyed by `{memory_id, turn_window_id}`; without the recall.jsonl substrate (which `co-bucketing` reads) the calibration loop has nothing to fit against.

**Depends on:**

- **`F-SYN-INTEGRATION-multi-feature-score-wiring`** — the multi-feature `final_score` is the input to the propensity softmax. Stable scoring is a prerequisite; the W6 work-unit landed this.

**Does NOT touch:**

- **The recall pipeline itself** (`mcp/lib/recall/*.js`). The pipeline is correct per W6; this spec confirms it and pins the contract.
- **The damping log** (`recall-log-split.md`). Damping is the engagement reinforcement signal; propensity is the action-distribution signal. They share `recall_id` as the join key but are otherwise disjoint.
- **The v3 GBDT lambdarank ranker.** This spec produces the substrate the v3 ranker needs; the ranker itself is gated separately on ~10^4 engagement events (Risks #6).

**Surface impact on `kb/` docs:**

- `kb/phase3-v0-contracts.md § 5` — this spec's § 3 (propensity distribution) and § 4 (recall event shape) supersede any divergent draft in that file. The kb file should cite this spec as authoritative; the in-mcp `phase3-v0-contracts.md` is the implementation guide, this synthesis spec is the contract.
- `kb/research-retrieval-frontiers.md` — no edit required; this spec is the implementation answer to that doc's § Phase 3 v0 deliverables and § Bootstrap plan rows.

**Surface impact on other synthesis specs:**

- `recall-log-split.md` (foundation tier) defines the two-log split (public recall ledger + private damping log). This spec pins the propensity contract on the public side. The two specs are complementary; cross-referenced in § 11 above.
- `context-populator.md` (W4) defines the `populator` block surfaced on the recall row. This spec carries that block forward verbatim per § 4; no edit to context-populator.md required.

---

## Provenance

- 2026-06-19 — Initial spec. Pins the v0 propensity distribution (Plackett-Luce-with-temperature τ=0.3 + 5% multiplicative jitter), the 2-week soak window with ≥1000-event volume target, the canonical recall-event shape verified against W6 `recall.js`, and the `memory_health.recall_log_health` health probe. Closes `research-retrieval-frontiers.md` critic §5 ("propensity logging requires a defined propensity model on day 1"). Listed five required follow-ups (§ 8) as separate WUs.
- 2026-06-20 — WU-propensity-soak-runtime: cwf → completed. Resolution_step landed the synthesis-tier facade `mcp/lib/synthesis/propensity-calculator.js` (exports `PROPENSITY_VERSION = "v0.1.0"` + frozen `PROPENSITY_CAPS = {TEMPERATURE_TAU: 1.0, JITTER_PCT: 0.05}` + `computePropensities(scoredCandidates) → Array<{memory_id, score, propensity}>`) and the matching coverage suite `mcp/test/synthesis/propensity-calculator.test.mjs` (14 node:test cases, 30+ assertions). The recall-runtime wiring in `mcp/lib/tools/recall.js` § j (W6) was re-verified against § 6 of this spec and is unchanged — Plackett-Luce softmax with τ = CAPS.PROPENSITY_TEMPERATURE_TAU_DEFAULT (0.3) + 5%-of-|score| jitter seeded by `recall_id` already flows end-to-end into `recall.jsonl` and the `policy.salience.recall_feedback` row via `emitRecallFeedback`'s `propensities_by_id`. The synthesis-tier facade carries the soak-substrate CAPS prior (τ=1.0, the spec § 3.4 "broader exploration" column) as a single source of truth for synthesis-side analyses that may run with a different prior than the runtime. Single-producer discipline preserved: the synthesis facade forwards to `lib/recall/propensity.js`, which remains the sole owner of the softmax + deterministic-jitter primitive.
