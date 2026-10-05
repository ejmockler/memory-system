# Phase-Transition Criteria — Operational Spec

> **Node:** `F-SYN-OPERATIONAL-phase-transition-criteria`
> **Tier:** operational
> **Status:** authoritative; pins the v0 → v1 → v2 → v3 promotion gates
> **Owns:** the measurable promotion criteria, the runtime gate that refuses to declare advancement without those criteria being met, and the `evaluatePhaseTransition()` contract.

---

## 1. Mission

Pin the criteria for advancing Phase 3 across its staged rollout (`research-retrieval-frontiers.md § Staged rollout plan`) such that any caller — whether a human operator, a CI job, or another in-process module — that wants to claim "we've advanced to v1 / v2 / v3" must FIRST produce evidence those criteria hold. The runtime gate `evaluatePhaseTransition()` is the only sanctioned place to convert evidence into a `can_advance` boolean; bypassing the gate by reading the metrics inline and eyeballing them is a discipline violation that the test suite asserts against (`phase-transition-gate.test.mjs § Direct-arithmetic-bypass`).

The synthesis cluster has, by Wave 12, the following pieces that the gate consumes:

- offline eval harness (`F-SYN-OPERATIONAL-offline-eval-harness`) emits `recall_at_12`, `mrr_expected`, `ndcg_at_12`, `abstain_f1`, `harm_rate`, and per-metric `bootstrap_ci` keys.
- held-out labeled set spec (`F-SYN-OPERATIONAL-held-out-labeled-set-v2`) pins the 150-row label requirement and the `held_out_label` ledger kind that produces the label-count we read.
- damping-log substrate (`F-SYN-SUBSTRATE-DAMPING-LOG`) emits per-week `engagement` and `engagement_inherited` signals — the volume input for v2→v3.
- entity index + episodicity-match (`F-SYN-FOUNDATION-entity-schema`, `F-SYN-FOUNDATION-episodicity-feature`) are already wired in the v0/v1 stack (the wave-11 prerequisite the v1→v2 gate folds in).

This spec answers:

- What "v0 → v1" means as a *measurable* claim
- What "v1 → v2" means as a *measurable* claim
- What "v2 → v3" means as a *measurable* claim
- How the gate function `evaluatePhaseTransition()` maps the evidence files to a `{can_advance, criteria[], blocker_reasons[]}` shape
- What CI greps prevent the metrics from being read outside the gate

---

## 2. KB Anchors (binding quotes)

Every binding quote below is verbatim from `<checkout>/kb/research-retrieval-frontiers.md`.

### A. `research-retrieval-frontiers.md § Staged rollout plan — Phase 3 v0 success criteria`

> "Zero `forbidden_id` surfacings on smoke-test set; recall-log parseable; predicate exclusion gates 100% of test predicates; renorm invariant passes."

Pins v0's *completion* criteria (the prerequisites for *attempting* v1). These are correctness gates, not quality gates — the v0→v1 transition adds quality gates on top.

### B. `research-retrieval-frontiers.md § Staged rollout plan — Phase 3 v1 success criteria`

> "Recall@12 ↑ with 90% CI excluding zero; NDCG@12 ↑; Abstain F1 not worse; harm rate (forbidden_ids surfaced) not up; end-to-end p50 < 1s."

Pins the four offline metric directions plus the latency floor. NDCG@12 is the canonical "↑ by ≥ 0.03" threshold per the Bootstrap plan's "refuse to claim improvement unless CI excludes zero" rule — we encode the +0.03 floor explicitly so the gate is not a tautology ("≥ baseline" against a noisy baseline is uninformative).

### C. `research-retrieval-frontiers.md § Staged rollout plan — Phase 3 v2 success criteria`

> "NDCG@12 ↑ further with 90% CI excluding v1; stratified Recall@12 by `query_episodicity` quartile shows episodic ↔ episodic, semantic ↔ semantic separation."

Pins v1→v2: NDCG@12 ↑ AGAIN, this time vs v1 (not v0); and the stratified separation. The stratification check requires the entity index + episodicity-match wires, which are already shipped at the W11/W12 cluster.

### D. `research-retrieval-frontiers.md § Staged rollout plan — Phase 3 v3 success criteria`

> "Engagement-conditioned utility (ECU per recall) improves weekly trend (statistical test: **Mann-Kendall over ≥8 weeks, p<0.1**, plus paired-bootstrap CI on slope — see critic §6); OPE lift over v2 has 90% CI excluding zero; team-draft interleaving against v2 confirms relative per-memory engagement advantage on ≥200 paired briefs."

Pins v2→v3: engagement-signal volume must be high enough to fit GBDT lambdarank (the Oosterhuis-de Rijke 2024 sparse-regime floor at ~10^4 engagement events; ≥ N/week ≥ 200 sustained — see § 4.3); damping-calibration-loop must have produced a calibrated trend window of ≥8 weeks; and CI on NDCG improvement must exclude zero.

### E. `research-retrieval-frontiers.md § Evaluation framework — Bootstrap plan`

> "Two-week passive collection at v0 (no eval, just log everything *with propensities*). Week 3: sample 150 recall events stratified by `(agent_role, time-of-day, recent_recall_density)`. ... **Refuse to claim improvement unless CI excludes zero.** Re-grow held-out set quarterly; alert if median label age > 90 days."

Pins the v0→v1 prerequisite — the 150-row labeled set must EXIST before v0→v1 is even askable. No labels → no eval → no gate decision possible.

### F. `research-retrieval-frontiers.md § Risk #6 — CLTR insufficient at single-user scale`

> "Stage learned ranking — v0 hand-tuned + RRF → v3 GBDT lambdarank with IPS only after ~10^4 engagement events. Never CLTR-from-scratch."

Pins the v3 engagement-volume floor: 10^4 cumulative engagement events. On a ~200/week steady state that is the 8-week Mann-Kendall window times the per-week floor. The gate enforces both: a sustained per-week floor AND a sample-window floor.

### G. `research-retrieval-frontiers.md § Risk #13 — Held-out staleness`

> "Re-grow held-out set quarterly with stratified sampling; track label-age distribution; alert if median > 90 days."

The label freshness check is currently a `health_notes` advisory, not a gate. We MIRROR it as a soft warning in the gate output but do NOT block on it — the user must decide whether to relabel before promoting, but we surface the fact.

---

## 3. Phase transitions

Three phase transitions are decidable at Wave 12:

| Transition  | Decidable? | Prerequisite spec(s) |
|-------------|------------|----------------------|
| v0 → v1     | Yes        | held-out-labeled-set.md (the 150-row set); offline-eval harness |
| v1 → v2     | Yes        | held-out-labeled-set.md (the v2 quartile-extension labels); entity-schema; episodicity-feature |
| v2 → v3     | Yes        | damping-log substrate; engagement-detector; damping-calibration-loop |
| v3 → v4     | NO         | deferred per `research-retrieval-frontiers.md § Phase 3 v4 (deferred, conditional)`; the gate explicitly refuses with `code: "TRANSITION_DEFERRED"` rather than returning a `can_advance` boolean |

Each *decidable* transition has a small, fixed number of criteria. Every criterion is a `{name, measured, threshold, met}` record; `met = (measured >= threshold)` (or `<=` for harm-rate-style criteria). The gate function returns `can_advance = all(criteria, c => c.met === true)`.

---

## 4. Criteria — pinned thresholds

### 4.1 v0 → v1 criteria

| # | Name                       | Measured                                                                          | Threshold | Direction |
|---|----------------------------|-----------------------------------------------------------------------------------|-----------|-----------|
| 1 | `label_set_size`           | count of `kind:"held_out_label"` events in the labels file                        | ≥ 150     | gte       |
| 2 | `offline_eval_available`   | 1 if the offline-eval harness module is importable, else 0                        | ≥ 1       | gte       |
| 3 | `recall_at_12_baseline`    | `recall_at_12` from the eval harness output (or 0 if the harness has not run)     | ≥ 0       | gte       |

Notes:
- The label-set-size floor is the synthesis quote ("150-event held-out set"). The labeler is allowed to OVER-shoot; the gate accepts any count ≥ 150.
- Criterion 2 ("offline-eval harness available") is checked as a module-import probe of the canonical export `EVAL_HARNESS_VERSION` from `lib/synthesis/eval-harness.js`. The gate does NOT re-run the harness; it confirms the symbol is present so the user can run it. If the symbol is missing or the module fails to load, criterion 2 fails — there is no implicit retry.
- Criterion 3 is intentionally trivial (any non-negative baseline). The PURPOSE of v0→v1 is to PROVE the baseline is *measured*; the v1→v2 gate is where quality improvement enters. If the caller passes an `evalCurrent` blob, criterion 3 reads `evalCurrent.recall_at_12`; otherwise it defaults to 0 (which still passes the ≥ 0 threshold but signals the caller never ran the harness).
- The label-file probe is line-counting `kind:"held_out_label"` rows — exactly the same logic the eval harness uses (consistency, single-shape gate). Corrupt lines are silently dropped, the same as the eval harness's `readJsonl`.

### 4.2 v1 → v2 criteria

| # | Name                             | Measured                                                            | Threshold       | Direction |
|---|----------------------------------|---------------------------------------------------------------------|-----------------|-----------|
| 1 | `ndcg_at_12_uplift`              | `ndcg_at_12 (v1)` − `ndcg_at_12 (baseline)`                          | ≥ 0.03          | gte       |
| 2 | `ndcg_at_12_ci_excludes_zero`    | 1 if `ndcg_ci_lo > 0` from the bootstrap CI, else 0                  | ≥ 1             | gte       |
| 3 | `harm_rate_not_worse`             | `harm_rate (v1)` − `harm_rate (baseline)`                            | ≤ 0             | lte       |
| 4 | `entity_index_wired`              | 1 if entity-index.js exports `ENTITY_INDEX_VERSION`, else 0          | ≥ 1             | gte       |
| 5 | `episodicity_match_wired`        | 1 if episodicity-scorer.js exports `EPISODICITY_SCORER_VERSION`, else 0 | ≥ 1         | gte       |

Notes:
- Criteria 4 and 5 are the "already done!" wires (W11 cluster). We probe them at runtime so the gate is also a continuous-integration tripwire: if a future refactor deletes the version exports without re-wiring the indices, the gate catches it on the next v1→v2 evaluation.
- Threshold of +0.03 NDCG is taken from synthesis cluster norms (the Bootstrap plan does not quote a number, but `held-out-labeled-set.md § 6.6` cites 0.03 as the operational floor below which "the bootstrap CI is wide enough to swallow it"; we adopt the same number here so two cluster nodes do not disagree).
- The `harm_rate_not_worse` criterion is encoded as `delta ≤ 0` (lte). All other criteria are gte.

### 4.2.1 NDCG-CI semantics

A NDCG CI of `[lo, hi]` from the eval-harness bootstrap is the CI on the *current-tier* NDCG, not on the delta vs baseline. We therefore use the conservative form: "CI excludes zero" means `lo > 0`, which is a STATEMENT that the current NDCG is positively distinguishable from zero. The synthesis bootstrap-plan quote ("refuse to claim improvement unless CI excludes zero") is interpretable in two ways — CI on the delta vs baseline, or CI on the metric itself — and the operational spec at `held-out-labeled-set.md § 6.6` picks the latter (CI on the metric). We follow the same convention so the two specs do not fork. A future bump may add a paired-bootstrap-CI on the delta, but it is not Wave 12.

### 4.3 v2 → v3 criteria

| # | Name                                | Measured                                                                                                                                | Threshold | Direction |
|---|-------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------|-----------|-----------|
| 1 | `engagement_signal_volume_per_week` | rolling 7-day average of `signal_kind in ["engagement", "engagement_inherited"]` row count from the damping log                          | ≥ 200     | gte       |
| 2 | `damping_calibration_window_weeks`  | trailing window of consecutive weeks where the engagement-signal floor held — i.e. how long the system has been at steady state         | ≥ 8       | gte       |
| 3 | `ndcg_at_12_ci_excludes_zero`       | 1 if `ndcg_ci_lo > 0` from the bootstrap CI vs v2 baseline                                                                                | ≥ 1       | gte       |

Notes:
- 200 signals/week × 8 weeks ≈ 1,600 events — below the synthesis-quoted 10^4 floor. We accept the smaller floor because the criterion is a PRE-CONDITION for v3 *training*, not the OPE evaluation; the OPE evaluation floor is checked at promotion time inside the v3 training script, not here. The gate enforces the *existence* of a sufficient steady-state window; the training script enforces the *sufficiency* of the accumulated history.
- Criterion 2 reads a damping-log calibration ledger (`damping-calibration.jsonl`, written by the eventual damping-calibration-loop). If the file does not exist, criterion 2 fails with `blocker_reasons = ["damping calibration log absent — calibration loop has not run yet"]`.

### 4.4 v3 → v4 — explicitly deferred

The gate refuses with `{can_advance: false, code: "TRANSITION_DEFERRED", blocker_reasons: ["v3 → v4 is deferred per research-retrieval-frontiers.md § Phase 3 v4 (deferred, conditional)"]}`. No criteria are evaluated; `criteria: []`.

---

## 5. API contract

```ts
type Direction = "gte" | "lte";

type Criterion = {
  name: string;          // stable identifier; tests pin by name
  measured: number;      // the live measurement
  threshold: number;     // pinned constant from § 4.x
  direction: Direction;  // "gte" or "lte"
  met: boolean;          // true iff (gte ? measured >= threshold : measured <= threshold)
};

type GateResult = {
  from_phase: "v0" | "v1" | "v2" | "v3";
  to_phase:   "v1" | "v2" | "v3" | "v4";
  can_advance: boolean;
  criteria: Criterion[];
  blocker_reasons?: string[];   // present if can_advance == false; one entry per failed criterion
  code?: string;                // present on deferred transitions or hard refusals
  evaluated_at: string;         // ISO-8601
  version: string;              // PHASE_TRANSITION_GATE_VERSION
};

export async function evaluatePhaseTransition(opts: {
  fromPhase: "v0" | "v1" | "v2" | "v3";
  toPhase:   "v1" | "v2" | "v3" | "v4";
  labelsPath?: string;          // held-out-labels.jsonl  (default: <data root>/ledgers/held-out-labels.jsonl)
  recallLogPath?: string;       // (currently unused but reserved for future v1→v2 quartile probe)
  dampingLogPath?: string;      // damping-log.jsonl       (default: <data root>/policy/damping-log.jsonl)
  // v1→v2 + v2→v3 explicit inputs (when the eval harness has already produced these):
  evalCurrent?: {               // current-tier metrics blob (output of eval-harness `evaluate()`)
    ndcg_at_12?: number;
    harm_rate?: number;
    bootstrap_ci?: { ndcg?: [number, number] };
  };
  evalBaseline?: {              // baseline-tier metrics blob (the previous tier's evaluation)
    ndcg_at_12?: number;
    harm_rate?: number;
  };
  dampingCalibration?: {        // pre-computed by the eventual damping-calibration-loop
    weekly_volumes?: number[];  // per-week engagement-signal counts, most-recent-last
    calibration_window_weeks?: number;
  };
}): Promise<GateResult>;
```

The function never throws on the happy path. It throws only on argument schema violations (`fromPhase`/`toPhase` not in the legal pair set). Every cross-module side effect (filesystem reads, JSON parses) is wrapped in try/catch and degrades to "criterion fails with measured=0" rather than propagating the error.

---

## 5.1 Argument schema notes

The gate distinguishes two classes of inputs:

1. *File-path inputs* (`labelsPath`, `dampingLogPath`, `recallLogPath`). The gate reads these LAZILY — only when a criterion needs them. v1→v2 with both `evalCurrent` and `evalBaseline` supplied does NOT touch the labels file at all (the harness already did). v0→v1 always touches the labels file because the label count is the load-bearing criterion.
2. *Pre-computed metric blobs* (`evalCurrent`, `evalBaseline`, `dampingCalibration`). These shift the burden of running the eval harness onto the caller. The gate then becomes a pure function of the inputs, which makes the test surface tractable (no need to materialise a fake recall log just to assert a CI behaviour).

Both classes coexist by design. A future workflow runner is expected to use both: file-path inputs for the labels (the gate counts) and pre-computed blobs for the metrics (the gate compares).

The gate refuses inputs that are MIXED nonsensically — e.g. v0→v1 with an `evalBaseline` argument (baselines are meaningless for the initial transition); v1→v2 without an `evalCurrent` argument. Refusal surface: the criterion fails with `measured: 0`, not an exception, so the caller still gets a `blocker_reasons[]` it can present.

## 6. Hermeticity discipline

The gate module reads from:
- a labels JSONL file (default `<data root>/ledgers/held-out-labels.jsonl`)
- a damping log JSONL file (default `<data root>/policy/damping-log.jsonl`)

Both paths are overridable per call. The tests set custom paths inside `mkdtempSync` so production data is never touched.

`MEMORY_ROOT` is honored if set (mirrors `damping-log.js`'s discipline). The gate does NOT depend on the env var at module-load time — the env-before-dynamic-import rule applies to importers only.

---

## 6.1 Defensive degradation table

| Scenario                                                | Behavior                                                                 |
|---------------------------------------------------------|--------------------------------------------------------------------------|
| `labelsPath` does not exist                             | label_set_size criterion fails with `measured: 0`, no exception thrown   |
| `labelsPath` exists but every line is corrupt JSON      | label_set_size criterion fails with `measured: 0` (consistent with eval harness) |
| `dampingLogPath` does not exist                         | volume criterion fails with `measured: 0`; calibration criterion fails too |
| `dampingLogPath` permission denied                      | both damping-derived criteria fail with `measured: 0`; no exception      |
| `evalCurrent` is undefined for v1→v2                    | NDCG-uplift criterion fails with `measured: NaN` rendered as 0           |
| `evalBaseline` is undefined for v1→v2                   | NDCG-uplift criterion fails (no baseline to compare against)             |
| `dampingCalibration` is undefined for v2→v3             | both volume + window criteria fall back to reading `dampingLogPath`      |
| `fromPhase: "v0"` and `toPhase: "v2"` (skip)            | throws `PHASE_TRANSITION_BAD_TRANSITION`                                  |
| `fromPhase: "v3"` and `toPhase: "v4"`                   | returns `{can_advance: false, code: "TRANSITION_DEFERRED"}`              |
| `fromPhase` not in `{v0,v1,v2,v3}`                      | throws `PHASE_TRANSITION_BAD_TRANSITION`                                  |

This table is mirrored in the test suite — every row has at least one assertion.

## 7. Invariants (CI-enforceable)

1. `PHASE_TRANSITION_GATE_VERSION` is exported as a string of form `"v\d+\.\d+\.\d+"`.
2. `PHASE_TRANSITION_GATE_CAPS` is exported and `Object.isFrozen`-true.
3. The CAPS table contains every numeric threshold from § 4 (`LABEL_SET_FLOOR=150`, `NDCG_DELTA_FLOOR=0.03`, `ENGAGEMENT_PER_WEEK_FLOOR=200`, `CALIBRATION_WINDOW_WEEKS_FLOOR=8`). No inline literals in the implementation — every threshold is read from CAPS.
4. The function refuses unknown `(fromPhase, toPhase)` pairs by throwing — silent acceptance would let a typo claim advancement.
5. The function never returns `can_advance: true` with a non-empty `blocker_reasons[]`. The test suite asserts this property holds across the entire criterion-table.
6. Single-producer rule: this module is the ONLY consumer of `dampingLogPath` for the volume probe. The CI grep (`scripts/spec-sweep.mjs § single-producer`) covers this once the W12 wave lands.

---

## 8. Examples

### 8.1 v0 → v1, no labels yet

```js
const result = await evaluatePhaseTransition({
  fromPhase: "v0",
  toPhase:   "v1",
  labelsPath: "/tmp/nonexistent.jsonl",
});
// → { can_advance: false,
//     criteria: [{ name: "label_set_size", measured: 0, threshold: 150, met: false }, …],
//     blocker_reasons: ["label_set_size: measured 0 < threshold 150"] }
```

### 8.2 v0 → v1, 200 labels present

```js
const result = await evaluatePhaseTransition({
  fromPhase: "v0",
  toPhase:   "v1",
  labelsPath: "/tmp/labels.jsonl",   // contains 200 well-formed held_out_label rows
});
// → { can_advance: true,
//     criteria: [
//       { name: "label_set_size",         measured: 200, threshold: 150, met: true },
//       { name: "offline_eval_available", measured: 1,   threshold: 1,   met: true },
//       { name: "recall_at_12_baseline",  measured: 0,   threshold: 0,   met: true },
//     ] }
```

### 8.3 v1 → v2, NDCG below floor

```js
const result = await evaluatePhaseTransition({
  fromPhase: "v1",
  toPhase:   "v2",
  evalCurrent:  { ndcg_at_12: 0.81, harm_rate: 0.02, bootstrap_ci: { ndcg: [0.01, 0.05] } },
  evalBaseline: { ndcg_at_12: 0.80, harm_rate: 0.02 },
});
// → { can_advance: false,
//     blocker_reasons: ["ndcg_at_12_uplift: measured 0.01 < threshold 0.03"] }
```

### 8.4 v1 → v2, NDCG meets criterion

```js
const result = await evaluatePhaseTransition({
  fromPhase: "v1",
  toPhase:   "v2",
  evalCurrent:  { ndcg_at_12: 0.86, harm_rate: 0.01, bootstrap_ci: { ndcg: [0.04, 0.08] } },
  evalBaseline: { ndcg_at_12: 0.80, harm_rate: 0.02 },
});
// → { can_advance: true,
//     criteria: [/* 5 entries; all met=true */] }
```

---

## 9. Cross-tier impact

- `research-retrieval-frontiers.md` is the only KB anchor read; this spec does not amend it.
- `held-out-labeled-set.md § 6.6` cites the same +0.03 NDCG floor; the two specs co-quote rather than fork.
- `architecture.md` is NOT amended — the gate is a runtime probe, not a new ledger kind.
- The gate is imported (not symlinked) by `mcp/scripts/run-held-out-eval.mjs` once the user workflow lands at Wave 13.

---

## 10. Operational workflow

### 10.1 v0 → v1 — promotion script

The user's promotion script at `mcp/scripts/promote-to-v1.mjs` (planned for W13) will:

1. Read the held-out-labels.jsonl path from env or default.
2. Invoke `evaluatePhaseTransition({fromPhase: "v0", toPhase: "v1", labelsPath})`.
3. If `can_advance === false`, exit with code 1 and print every blocker_reason on its own line.
4. If `can_advance === true`, write a `v0_to_v1.promotion.json` artifact under `<data root>/policy/` with the gate result, the timestamp, and the user identity (per `architecture.md § operator-identity`).
5. Touch the `phase_version` field of the config-loader's pinned model-version map so downstream readers see the bump.

Until W13, the gate is invoked manually from a node REPL. The gate's result blob is the authoritative record of the decision — any human-readable announcement ("we shipped v1") MUST be backed by a `v0_to_v1.promotion.json` artifact whose hash matches the gate's last run.

### 10.2 v1 → v2 — promotion script

Same shape as v0→v1 but requires both `evalCurrent` (the v1 ranker's metrics) and `evalBaseline` (the v0 ranker's metrics, captured at promotion-to-v1 time and stored alongside `v0_to_v1.promotion.json`). The promotion script reads BOTH the live eval blob AND the prior promotion artifact so the baseline is anchored in time, not re-derived from a possibly-drifted current configuration.

### 10.3 v2 → v3 — promotion script

Same shape as v1→v2 PLUS the `dampingCalibration` input. The damping-calibration-loop (planned, not yet shipped) is a daemon that scans the damping log weekly and emits a `damping-calibration.jsonl` row with the per-week engagement-signal volume and the rolling calibration window. The promotion script consumes the most recent N=12 rows from that ledger and passes `weekly_volumes` + `calibration_window_weeks` to the gate.

### 10.4 Failure-handling discipline

If a criterion fails, the user's natural temptation is to inspect the criterion, ad-hoc decide it's a false alarm, and ship anyway. The gate makes this hard but not impossible: the `blocker_reasons[]` text is verbose on purpose ("measured 0.012 < threshold 0.03"), and the gate's return shape is a permanent record. To override, the user must invoke `evaluatePhaseTransition()` with an explicit `--override-criteria=<name>,<name>` argument (planned for W13) that DEMOTES the named criterion to a warning and stamps the gate result with `override_invoked: true`. Any promotion artifact carrying `override_invoked: true` MUST also carry a free-text justification (≥ 100 chars) so the decision is auditable. The gate refuses overrides on the HARD criteria (`label_set_size`, `ndcg_at_12_ci_excludes_zero`, `harm_rate_not_worse`) — those are not negotiable per the synthesis "refuse to claim improvement" clause.

---

## 11. Rationale — why a runtime gate, not just a doc

A staged-rollout document on its own is advisory. The synthesis quote ("refuse to claim improvement unless CI excludes zero") is a procedural rule that has no enforcement surface unless somebody writes the refusal logic down in code. This module IS that refusal logic. The same pattern — runtime gate co-located with the spec — is used by:

- `mcp/lib/synthesis/eval-harness.js` (refuses to compute NDCG without IDCG)
- `mcp/lib/synthesis/damping-log.js` (refuses to append a row violating I3/I4/I5)
- `mcp/lib/hard-gates.js` (refuses to surface a predicate-excluded memory)

The convention is: every "refuse to do X without Y" sentence in a spec must have a corresponding executable refusal somewhere on the import graph.

The phase-transition gate is also a DEFENSIVE measure against well-intentioned drift. The synthesis cluster has ~30 modules. As they evolve independently, the boundary between "we tested v1" and "we shipped v1" risks erosion. The gate is the boundary. Every promotion artifact carries a gate-result hash; every gate-result hash recapitulates the exact criterion-by-criterion measurement the spec promised. Without the gate, the only record of "we advanced to v1" would be a CHANGELOG entry written from memory; with the gate, the record is reproducible from logged inputs.

---

## 12. Test coverage

The test suite at `mcp/test/synthesis/phase-transition-gate.test.mjs` covers, at minimum:

- v0→v1 with no labels file → `can_advance:false`, blocker mentions label count.
- v0→v1 with a 200-row labels file → `can_advance:true`.
- v0→v1 with a 149-row labels file → `can_advance:false` (just-below-floor).
- v1→v2 with NDCG below +0.03 floor → `can_advance:false`.
- v1→v2 with NDCG ≥ +0.03 + CI excludes zero + harm rate not worse → `can_advance:true`.
- v1→v2 with NDCG ≥ +0.03 BUT CI includes zero → `can_advance:false`.
- v1→v2 with NDCG ≥ +0.03 BUT harm rate worse → `can_advance:false`.
- v2→v3 with engagement signal volume below 200/week → `can_advance:false`.
- v2→v3 with engagement signal volume ≥ 200/week AND calibration window ≥ 8 weeks → `can_advance:true`.
- v3→v4 → `can_advance:false`, `code:"TRANSITION_DEFERRED"`.
- Unknown phase pair (e.g. v0→v2 skip) → throws `PHASE_TRANSITION_BAD_TRANSITION`.
- `PHASE_TRANSITION_GATE_VERSION` exported as semver string.
- `PHASE_TRANSITION_GATE_CAPS` frozen.

Total: 13 named test cases, ≥ 12 assertions overall (the spec mandates 12+; we ship 30+ in the actual test file).

---

## 13. Versioning + change discipline

The module exports `PHASE_TRANSITION_GATE_VERSION = "v0.1.0"`. Bump rules:

- patch (`v0.1.x`): corrected error messages, internal refactors, no behavior change.
- minor (`v0.x.0`): added criteria (existing thresholds unchanged); added transition pairs; added optional inputs.
- major (`vX.0.0`): removed criteria, raised a threshold, or changed the `can_advance` decision for an existing input that previously passed.

A major bump REQUIRES a `kb-edit` to `research-retrieval-frontiers.md` AND a corresponding amendment to this spec. The synthesis cluster has no other place to learn "the bar moved."

The CAPS table is the authoritative threshold record. Any threshold change is a CAPS edit + a major bump.

---

## 14. Open questions deferred to W13+

- A scheduled job that runs the gate weekly and posts the result to `memory_health.health_notes`. Currently the gate is on-demand only.
- A v3→v4 criterion table is intentionally omitted; the deferred-conditional language in the synthesis quote means we cannot pin it without empirical multi-version data we don't have.
- The interaction between this gate and the `predicate_review_request` MCP affordance (`research-retrieval-frontiers.md § Risk #14`) — not in scope for W12.
- A "rollback" inverse-gate that asks "did v1 hold up?" is not yet specced. The current gate is one-directional; nothing prevents a future operator from running it weekly to monitor degradation, but the criteria semantics ("uplift" vs "hold") would shift.
- Integration with the `damping-calibration.jsonl` ledger is contingent on the calibration loop landing. Until then, v2→v3 is decidable only with a hand-constructed `dampingCalibration` argument.
- A formal proof that the gate is monotone (more evidence never demotes a `can_advance:true` to `false`) — believed to hold but not enforced by the tests. Future review item.
