# Power-law Decay Contract

> **Status:** foundation spec (synthesis tier, wave-N).
> **Node:** `F-SYN-FOUNDATION-power-law-decay-contract`.
> **Owners (downstream):** `F-SYN-INTEGRATION-MULTI-FEATURE-SCORE-WIRING`,
> `F-SYN-SUBSTRATE-TIME-INDEX`.
> **Authoritative kb cross-refs:** `architecture.md` (§4 Memory ledger — **the
> closed kind enumeration**), `research-retrieval-frontiers.md`,
> `thesis.md`, `operations.md`,
> `kb/phase3-v0-contracts.md` (downstream wiring contract).

---

## 0. Kind taxonomy — authoritative anchor

The earlier draft of this contract tabulated `f` values over six labels
(`fact / episodic / semantic / ambient / reconstructed / policy`). Three
of those (`episodic`, `semantic`, `ambient`) are **NOT** memory-ledger
kinds. The authoritative architecture-tier enumeration is:

> *`architecture.md` §4 Memory ledger:*
> "Single append-only stream: `ledgers/memory.jsonl`. Mixed kinds:
> — `fact` — promoted from a source
> — `policy` — `exclude` / `replace` / `substitute` / `corroboration` /
> `rescind` operations
> — `recall` — logged retrieval (informs damping and reinforcement; carries
> the query embedding for predicate snapshotting)
> — `reconstructed` — agent-emitted recall-time summarization (may diverge
> from source)"

> *`architecture.md` §4 Common shape:*
> "`kind: "fact" | "policy" | "recall" | "reconstructed"`"

This contract is **rebased** onto the 4-kind closed set. The smuggled
`episodic / semantic / ambient` axis is collapsed into a row-level
**stratification rule within `fact`** that reads
`fact.features.episodicity` (the scalar contract owned by
`F-SYN-FOUNDATION-episodicity-feature`) rather than pretending those
labels were ever row-kinds.

### 0.1 Mapping table: smuggled label → authoritative anchor

| Smuggled label (pre-rebase) | Authoritative location | How it shows up at recall time |
|---|---|---|
| `kind = "episodic"` | `kind = "fact"` with high `features.episodicity` | `f_effective(fact)` is bumped UPWARD via the stratification rule (§4.3) |
| `kind = "semantic"` | `kind = "fact"` with low `features.episodicity` | `f_effective(fact)` is bumped DOWNWARD via the stratification rule (§4.3) |
| `kind = "ambient"` | `surrounding_context.ambient` (operations.md §13–18 calendar/mood/parties bundle) — NOT a row-kind | never reaches the decay channel; the channel sees `candidate.kind` only |

The smuggled labels were a category error: `ambient` is a property of the
recall **context**, not the candidate; `episodic` and `semantic` are
**features** of facts, not their kind. The four authoritative kinds
remain `{fact, policy, recall, reconstructed}`.

### 0.2 CI invariant

A grep-based test (`test/synthesis/kind-taxonomy-invariant.test.mjs`)
asserts that no synthesis spec or synthesis library source uses
`kind="ambient"`, `kind="semantic"`, or `kind="episodic"` as if they were
row-level kinds. The test allows these labels in two narrow contexts:
(a) as `Entity.kind` values (the entity-schema spec has its own
taxonomy), and (b) as `features.episodicity` stratification labels
in this spec (where they are explicitly demoted to row-level features,
not row-level kinds).

---

## 1. Mission

This document pins down the canonical contract for the **Wixted & Ebbesen
1997 power-law forgetting function** `m * (1 + h * t)^(-f)` that occupies the
`w_t2 * power_law_decay(age, kind)` slot of the Phase 3 v0 multi-feature score
formula (`research-retrieval-frontiers.md § Recommended Phase 3 architecture`).

Before this spec existed the function shape lived in a substrate node
(`F-SYN-SUBSTRATE-TIME-INDEX`) that *referenced* the curve but explicitly
disclaimed ownership ("the time-index is the bucketed-match owner; the decay
function is somebody else's"). The substrate review caught the gap:
> "Power-law decay (operations.md / Wixted & Ebbesen) is correctly noted as
> separate from `time_anchor_match` — but no foundation/substrate node owns
> the decay function. Sibling-tier check."

This contract closes that hole. It owns:

1. **The function shape** — `m * (1 + h * t)^(-f)`, with all four constants
   (`m`, `h`, `unit_seconds`, per-kind `f`) pinned to CAPS so re-calibration
   is a knob-flip rather than a code change.
2. **The per-kind `f` prior table** — `{fact: 0.15, reconstructed: 0.25,
   policy: 0.05, recall: 0.50}` v0 priors, **explicitly flagged
   PRIOR-not-measured** per critic §2 / Risks #6. Future re-calibration
   (O5 damping-calibration-loop) consumes these as targets to refit, not
   as ground truth.
3. **The fact-row stratification rule** — `f_effective(fact)` is adjusted
   upward (toward fast episodic-style decay) or downward (toward slow
   semantic-style decay) as a function of `fact.features.episodicity`
   (and, secondarily, `fact.features.entities[].specificity`). See §4.3.
4. **The recall-time-stateless computation site** — the function consumes
   `event.ts` and `surrounding_context.time` only; it never reads, writes,
   or caches any per-fact strength field. This is the mechanical enforcement
   of `thesis.md § Principle 4` ("decay is not a per-memory activation
   score").
5. **The integration point** — additive sibling channel inside the
   multi-feature score, **orthogonal to and never co-computed with** the
   gated `w_t1 * time_anchor_match` channel.

The "why now" is twofold. First, the multi-feature-score module
(`mcp/lib/recall/multi-feature-score.js`) already ships a `powerLawDecay`
helper, but it diverges from the foundation contract in three ways the
synthesis must reconcile: it accepts no explicit `recall_ts` (it reads
`serverTs()` internally), it returns `0` rather than `1` when `ts` is
missing, and its CAPS keys (`POWER_LAW_F_FACT`, `POWER_LAW_F_EPISODIC`,
`POWER_LAW_F_AMBIENT`) mix in the smuggled labels — the foundation
hypergraph requires the authoritative 4-kind set plus the
stratification rule. Second, the integration node
(`F-SYN-INTEGRATION-MULTI-FEATURE-SCORE-WIRING`) lists this contract as a
dependency: the integration wiring change is blocked on a named foundation
owner.

The audience for this spec is the future implementer who will land the
foundation patch to `mcp/lib/recall/multi-feature-score.js` and the
companion CAPS edits to `mcp/lib/validation.js`, plus the telemetry hook
into `mcp/lib/recall-log.js`. The contract is implementation-language-
agnostic in shape but the reference signatures and CAPS keys assume the
existing Node.js/ESM codebase.

---

## 2. kb anchors

Every claim in this spec traces back to one of the following kb passages.
Quotes are verbatim from `<checkout>/kb/`.

### 2.1 Authoritative kind taxonomy (architecture.md §4)

> *`architecture.md` §4 Memory ledger:*
> "Single append-only stream: `ledgers/memory.jsonl`. Mixed kinds:
> — `fact` — promoted from a source
> — `policy` — `exclude` / `replace` / `substitute` / `corroboration` /
> `rescind` operations
> — `recall` — logged retrieval (informs damping and reinforcement; carries
> the query embedding for predicate snapshotting)
> — `reconstructed` — agent-emitted recall-time summarization (may diverge
> from source)"

> *`architecture.md` §4 Common shape, every entry:*
> "`kind: "fact" | "policy" | "recall" | "reconstructed"`"

This four-element closed enumeration is the **only** valid row-level
kind set. Every per-kind `f` value in this contract MUST be keyed on a
member of this set. Anything else is a category error.

### 2.2 Formula shape and version selection

> *`research-retrieval-frontiers.md § Phase 3 v0 — multi-feature score formula`:*
> "Multi-feature score is `(s_emb_full3072 * predicate_mask *
> consent_dampener * derivation_status * episodicity_match) +
> w_ent*entity_overlap_jaccard + w_t1*time_anchor_match (gated to 0 if no
> anchor) + w_t2*power_law_decay(age, kind) + w_val*valence_compat +
> w_eng*engagement_prior`. Decay is Wixted & Ebbesen 1997 power-law
> `m*(1+h*t)^(-f)` with per-kind `f`, **not** MemoryBank's exponential."

> *`research-retrieval-frontiers.md § Citations / #5 Wixted & Ebbesen (1997)`:*
> "Power-law (not exponential) as correct functional form at individual-
> subject level. Anchors `m*(1+h*t)^(-f)` decay; per-kind `f` differentiates
> fact/episodic/ambient."

NB: the research-retrieval-frontiers.md quote above predates the kind
taxonomy rebase. The phrase "per-kind `f` differentiates fact/episodic/
ambient" is interpreted here as **`fact` is a row-level kind; the
`episodic`/`ambient` differentiation is performed by the stratification
rule (§4.3) over `features.episodicity`, not by additional row-level
kinds.** See §0 for the rebase rationale.

### 2.3 PRIOR-not-measured discipline (critic §2)

> *`research-retrieval-frontiers.md § Risks #6 / Open questions`:*
> "Per-kind power-law `f` priors (0.15/0.35/0.6) remain load-bearing and
> not adversarially re-verified — re-measure before they harden as
> defaults (critic §2)."

> *`research-retrieval-frontiers.md § Open holes / loose ends`:*
> "Power-law per-kind f values (0.15/0.35/0.6) — pure prior, not derived
> or cited from Wixted & Ebbesen 1997 (which fit individual subjects, not
> memory-kind partitions)."

### 2.4 Why power-law beats MemoryBank exponential

> *`research-retrieval-frontiers.md § Citations / #4 Zhong et al.
> (MemoryBank)`:*
> "Introduces recall-updates-strength (`S←S+1, t←0`) and `cos × retention`
> multiplicative gate — conceptual precedent for engagement-gated
> reinforcement. We replace exponential decay with Wixted power-law and
> gate on engagement, not raw surfacing."

### 2.5 Recall-time-statelessness (thesis Principle 4)

> *`thesis.md § Principle 4: Decay is not a per-memory activation score`:*
> "A memory is 'stale' only relative to recall contexts. Something unused
> for two years can be perfectly live when a conversation lands near it.
> What erodes is the index's *discrimination* — the likelihood that
> incoming contexts match cleanly to one memory rather than many."

The mechanical consequence: **decay must be computed at recall time, never
stamped onto the fact, never cached per-fact, never mutated by a recall
event**. This contract enforces that by injecting `recall_ts` as a function
argument (not reading a wall-clock) and by returning a pure scalar without
any side-effect.

### 2.6 Why decay is a separate channel from time-anchor-match

> *`operations.md § recall → Scoring`:*
> "score = ... + w3 * time_proximity(memory.time_anchors, context.time) ..."

The `operations.md` formula carries only the anchor-match term. The
power-law decay channel is an additive sibling per
`research-retrieval-frontiers.md`, and it operates over `event.ts` age —
not over `time_anchors[]`. Two channels, two inputs, two semantic
questions. Conflating them is a category error caught in the substrate
node review.

> *`research-retrieval-frontiers.md § Recommended Phase 3 architecture`:*
> "Multi-feature score is `... + w_t1*time_anchor_match (gated to 0 if no
> anchor) + w_t2*power_law_decay(age, kind) + ...`"

The `(gated to 0 if no anchor)` clause is the discriminator. It applies to
`w_t1` only. `w_t2 * power_law_decay` is **never** gated to 0 by the
absence of an anchor — that is the whole point of the channel.

### 2.7 Episodicity feature as the stratification dial

> *`F-SYN-FOUNDATION-episodicity-feature` (cross-tier predicate):*
> "Define the episodicity scalar in [0,1] as a pure function over (a)
> `has_time_anchor`, (b) `log(1 + corroboration_count)`, (c)
> `entity_generality` (1 - mean entity-specificity), (d)
> `narrative_valence_magnitude` — stamped on every promoted fact and
> recomputed at recall time over `surrounding_context`."

This `[0, 1]` scalar is the row-level dial that replaces the smuggled
`episodic`/`semantic`/`ambient` kind labels. High = episodic; low =
semantic. The decay stratification rule (§4.3) reads it directly.

### 2.8 Decay vs. R24.5 salience decay-feedback columns

> *`salience-design.md § R24.5 graft`:*
> "Ship two zero-valued retrieval-decay-feedback columns
> (`last_retrieved_ts`, `use_count`) inside `features.salience.components`
> at R25 with weight=0.0 in `CAPS.SALIENCE_WEIGHTS_V1`, so CP-5 Trigger A
> becomes a byte-idempotent weight bump rather than a schema migration
> once `recall.jsonl` populates."

The salience decay-feedback columns are **promote-time** salience signals
that feed `CAPS.SALIENCE_WEIGHTS_V1`. They are NOT the Wixted power-law
decay channel. This contract has nothing to do with them; the two systems
do not communicate. The salience `last_retrieved_ts` measures *re-use
frequency*, not *event age*; it lives in `features.salience.components`,
not in the recall scorer.

---

## 3. Schemas

### 3.1 Input schema — `PowerLawDecayInput`

```ts
type PowerLawDecayInput = {
  /**
   * The ledger event's promote-time stamp. ISO-8601 string.
   * Source: candidate.ts (the memory-ledger row's `ts` field).
   * MUST be a valid, finite, parseable ISO-8601 timestamp.
   * If null/undefined/empty/unparseable, the function applies the
   * MISSING_TS fallback (see § 6).
   */
  event_ts: string;

  /**
   * The recall-time stamp. ISO-8601 string.
   * Source: surrounding_context.time (operations.md § Inputs).
   * MUST be injected by the caller. The function does NOT read
   * `new Date()` or `Date.now()`; this is the determinism invariant.
   * If null/undefined/empty/unparseable, the function applies the
   * MISSING_RECALL_TS fallback (see § 6).
   */
  recall_ts: string;

  /**
   * The kind of the candidate event.
   * One of the FOUR authoritative memory-ledger kinds enumerated in
   * architecture.md §4: "fact" | "policy" | "recall" | "reconstructed".
   * Unknown/null/undefined kinds default to the FACT_FALLBACK (see § 6).
   *
   * NOTE: "episodic", "semantic", and "ambient" are NOT accepted row-
   * level kinds. If a caller passes one of those strings (legacy code
   * path), the kind dispatcher treats it as UNKNOWN_KIND and falls
   * through to FACT_FALLBACK, emitting an UNKNOWN_KIND telemetry row.
   * The CI invariant (§ 0.2) blocks new code from doing this.
   */
  kind: "fact" | "policy" | "recall" | "reconstructed";

  /**
   * Optional: the candidate fact's episodicity scalar (∈ [0, 1]) — the
   * v0 stratification dial. Owned by F-SYN-FOUNDATION-episodicity-feature.
   * Read from `candidate.features.episodicity` at the call site.
   * Present only on `kind="fact"` candidates; ignored for other kinds.
   * Absent / null / undefined → treated as 0.5 (neutral) — the
   * stratification adjustment collapses to zero, recovering the base
   * `f` value.
   */
  episodicity?: number;

  /**
   * Optional: mean entity-specificity over the candidate fact's
   * `features.entities[].specificity` values, ∈ [0, 1]. Used as a
   * secondary stratification signal in §4.3. Absent → treated as 0.5
   * (neutral).
   */
  entity_specificity_mean?: number;
};
```

### 3.2 Output — bare number

```ts
type PowerLawDecayOutput = number;
// ∈ [0, 1]. Interpretation:
//   1.0  — no decay (recall_ts ≤ event_ts, or t = 0).
//   →0   — heavily decayed (t → ∞ for any f > 0).
//
// Algebraic invariants:
//   • Monotonically non-increasing in t (for f > 0, m > 0, h > 0).
//   • Continuous; no step discontinuities.
//   • Output never negative, never > m.
```

### 3.3 CAPS schema — `mcp/lib/validation.js`

```ts
type PowerLawDecayCAPS = {
  /**
   * Contract version. Bumps on any change to the curve shape, the per-kind
   * f table, m, h, unit_seconds, or the stratification coefficients. The
   * bump triggers an O6 drift event (kb/observability.md § Drift events)
   * but does NOT require re-stamping facts — the function is recall-time-
   * stateless and produces no persisted per-fact value.
   */
  POWER_LAW_DECAY_VERSION: 2;  // bumped from 1 on the kind-taxonomy rebase

  /**
   * Wixted m. Saturation amplitude. v0 default 1.0 (no scaling).
   */
  POWER_LAW_M_DEFAULT: 1.0;

  /**
   * Wixted h. Time-scale prefactor. v0 default 1.0 (curve normalized to
   * unit_seconds time units).
   */
  POWER_LAW_H_DEFAULT: 1.0;

  /**
   * Time unit in seconds. v0 default 86400 (one day).
   */
  POWER_LAW_DECAY_UNIT_SECONDS: 86400;

  /**
   * Per-kind f exponent table. Frozen (Object.freeze) so reassignment is
   * impossible from inside the recall path. CAPS-level overrides go
   * through validation.js, never through monkey-patching at runtime.
   *
   * v0 PRIOR — NOT MEASURED — re-fit by O5 calibration when the recall
   * log carries enough engagement labels (~10⁴ events per critic §2).
   *
   * KEYS ARE THE AUTHORITATIVE 4-KIND CLOSED SET FROM architecture.md §4.
   * No "episodic", "semantic", or "ambient" keys are permitted here.
   * The episodic/semantic distinction is handled by the §4.3
   * stratification rule, NOT by additional row-level kinds.
   */
  POWER_LAW_DECAY_F_BY_KIND: {
    fact: 0.15;          // PRIOR — Wixted-Ebbesen canonical fact decay;
                         //         stratified per row by features.episodicity
                         //         (see §4.3 — high episodicity → higher
                         //         effective f; low episodicity → lower).
    reconstructed: 0.25; // PRIOR — synthesized facts decay FASTER than
                         //         primary observations (they are
                         //         derivative; agent confabulation risk
                         //         compounds with age).
    policy: 0.05;        // PRIOR — operational, near-permanent; policies
                         //         remain operative until rescinded. A
                         //         tiny decay still applies to demote
                         //         ancient policies in tie-break.
    recall: 0.50;        // PRIOR — the recall LOG itself ages out fast;
                         //         recall events inform damping and
                         //         reinforcement on a short window, not
                         //         a long-term reference horizon.
  };

  /**
   * Stratification coefficients for the fact row's effective f
   * (see §4.3). v0 PRIOR — NOT MEASURED.
   *
   *   f_effective(fact, row) =
   *     base_f_fact
   *     + EPISODICITY_F_SLOPE   * (episodicity         - 0.5)
   *     + ENTITY_SPECIFICITY_F_SLOPE * (entity_specificity_mean - 0.5)
   *
   * EPISODICITY_F_SLOPE = +0.20:
   *   high episodicity (→1) bumps f up by +0.10 (faster decay; matches
   *   the smuggled "episodic" prior of 0.35-ish for ε≈1.0);
   *   low episodicity  (→0) drops f down by -0.10 (slower decay; matches
   *   the smuggled "semantic" prior of 0.05-ish for ε≈0).
   *
   *   NB: the smuggled "semantic" label originally had f=0.60 (fastest);
   *   the rebased reading inverts this — semantic facts (low episodicity,
   *   high abstraction) actually decay SLOWER than episodic facts under
   *   the Wixted prior. The pre-rebase 0.60 was anchored to the wrong
   *   intuition (semantic projections "age quickly"). The rebased reading
   *   matches the cognitive-science prior that abstract generalizations
   *   are more durable than specific episodes. This is itself a PRIOR
   *   subject to O5 recalibration.
   *
   * ENTITY_SPECIFICITY_F_SLOPE = +0.10:
   *   high specificity (specific persons/places) → slightly faster decay
   *   (more narrow context, fewer recall handles);
   *   low specificity (generic topics) → slightly slower decay (more
   *   re-attachment opportunities).
   *
   * The combined adjustment is clamped to [-0.10, +0.20] around the base
   * f so f_effective stays in [0.05, 0.35] for facts. This prevents
   * pathological rows from flipping the curve shape.
   */
  POWER_LAW_DECAY_FACT_STRATIFICATION: {
    EPISODICITY_F_SLOPE: 0.20;
    ENTITY_SPECIFICITY_F_SLOPE: 0.10;
    CLAMP_DELTA_MIN: -0.10;
    CLAMP_DELTA_MAX: 0.20;
  };

  /**
   * v0 bootstrap weight for the additive multi-feature-score channel.
   * Phase 3 v0 default 0.3 per research-retrieval-frontiers.md.
   * Operator dark-launch knob: set to 0 to zero the channel without code
   * changes (the salience-design.md R24.5 graft pattern).
   *
   * (Existing CAPS key is SCORE_WEIGHT_TIME_DECAY — see § 9 below for the
   * CAPS rename / alias plan.)
   */
  RECALL_W_T2: 0.3;
};
```

### 3.4 Telemetry schema — `power_law_decay_values[]`

Per-recall log row (under `recall.jsonl` per `architecture.md § Memory
ledger`) carries an array of per-candidate decay snapshots that the
operational tier (O5) consumes to re-fit the f priors.

```ts
type PowerLawDecayTelemetryRow = {
  candidate_id: string;     // memory_id of the scored candidate
  kind: string;             // candidate.kind, verbatim (one of the 4
                            // authoritative kinds — or "MISSING" if the
                            // input was null/undefined, or "UNKNOWN:<x>"
                            // if a smuggled label was passed)
  t_seconds: number;        // (recall_ts - event_ts) clamped at 0
  t_days: number;           // t_seconds / 86400, for analyst convenience
  base_f: number;           // the kind-base f value (before stratification)
  f: number;                // the f value actually applied (after
                            // stratification, for kind="fact")
  episodicity?: number;     // the row's episodicity scalar (only on facts)
  entity_specificity_mean?: number;
  stratify_delta?: number;  // f - base_f (only on facts); for analyst
                            // convenience tracking the dial's effect
  decay: number;            // the function's return value, ∈ [0, 1]
  fallback_reason?:         // present iff a fallback path was taken
    "MISSING_TS" |
    "MISSING_RECALL_TS" |
    "UNPARSEABLE_TS" |
    "UNPARSEABLE_RECALL_TS" |
    "UNKNOWN_KIND" |
    "SMUGGLED_LABEL" |       // caller passed "episodic"/"semantic"/"ambient"
    "FUTURE_EVENT";
};
```

The full per-recall log row schema (where this array lives) is owned by
`F-SYN-FOUNDATION-recall-log-split`. This contract specifies only the
`power_law_decay_values[]` field shape.

---

## 4. Module surface

### 4.1 Reference signature

```js
// File: mcp/lib/recall/multi-feature-score.js
//
// AUTHORITATIVE spec: mcp/docs/specs/synthesis/power-law-decay-contract.md

export const POWER_LAW_DECAY_VERSION = 2;

/**
 * Wixted & Ebbesen 1997 power-law forgetting.
 *
 * Pure function. Recall-time-stateless. The function does NOT read
 * `new Date()` or `Date.now()`; `recall_ts` is always supplied by the
 * caller (= surrounding_context.time per operations.md).
 *
 * Algebra:
 *   t_seconds = max(0, (parse(recall_ts) - parse(event_ts)) / 1000)
 *   t         = t_seconds / CAPS.POWER_LAW_DECAY_UNIT_SECONDS
 *   base_f    = CAPS.POWER_LAW_DECAY_F_BY_KIND[kind] ?? FACT_FALLBACK_F
 *   f         = stratifyF(kind, base_f, episodicity,
 *                          entity_specificity_mean)
 *   decay     = CAPS.POWER_LAW_M_DEFAULT *
 *               Math.pow(1 + CAPS.POWER_LAW_H_DEFAULT * t, -f)
 *
 * `stratifyF` is identity for non-fact kinds; for kind="fact" it applies
 * the §4.3 stratification rule.
 *
 * @param {object} input
 * @param {string} input.event_ts   ISO-8601, the ledger event's promote-
 *                                  time stamp.
 * @param {string} input.recall_ts  ISO-8601, surrounding_context.time.
 * @param {string} input.kind       "fact" | "policy" | "recall" |
 *                                  "reconstructed".
 * @param {number} [input.episodicity]  candidate.features.episodicity (∈
 *                                       [0,1]); used for fact stratification.
 * @param {number} [input.entity_specificity_mean]  mean of
 *                                                   candidate.features.
 *                                                   entities[].specificity.
 * @returns {number} ∈ [0, 1] — multiplier for the multi-feature score's
 *                              additive w_t2 channel.
 */
export function powerLawDecay({
  event_ts, recall_ts, kind, episodicity, entity_specificity_mean,
});
```

### 4.2 Telemetry helper

```js
/**
 * Build the telemetry row for a single candidate. The recall scorer
 * accumulates these into `recall.power_law_decay_values[]` (per § 3.4).
 *
 * Pure; no side effects.
 */
export function powerLawDecayTelemetry({
  candidate_id, event_ts, recall_ts, kind, episodicity,
  entity_specificity_mean,
});
//   → PowerLawDecayTelemetryRow per § 3.4
```

### 4.3 Stratification within `fact` (per-row episodicity adjustment)

The smuggled `episodic / semantic / ambient` axis collapses into a
**row-level** adjustment of the base `f` for `kind="fact"` candidates.
The adjustment reads `features.episodicity` (the [0,1] scalar owned by
`F-SYN-FOUNDATION-episodicity-feature`) and, secondarily, the mean of
`features.entities[].specificity`.

#### 4.3.1 Formula

```
function stratifyF(kind, base_f, episodicity, entity_specificity_mean):
  if kind != "fact":
    return base_f                          # non-fact kinds use base_f as-is

  eps      = episodicity              ?? 0.5  // null → neutral
  ent_spec = entity_specificity_mean  ?? 0.5  // null → neutral

  delta_eps = CAPS.POWER_LAW_DECAY_FACT_STRATIFICATION.EPISODICITY_F_SLOPE
              * (eps - 0.5)                  // ∈ [-0.10, +0.10] (slope 0.20)
  delta_ent = CAPS.POWER_LAW_DECAY_FACT_STRATIFICATION.ENTITY_SPECIFICITY_F_SLOPE
              * (ent_spec - 0.5)             // ∈ [-0.05, +0.05] (slope 0.10)

  delta = delta_eps + delta_ent              // ∈ [-0.15, +0.15] uncapped

  delta = clamp(delta,
                CAPS.POWER_LAW_DECAY_FACT_STRATIFICATION.CLAMP_DELTA_MIN,
                CAPS.POWER_LAW_DECAY_FACT_STRATIFICATION.CLAMP_DELTA_MAX)
                                              // → ∈ [-0.10, +0.20]

  return base_f + delta                      // f_effective(fact) ∈ [0.05, 0.35]
```

The clamp guarantees `f_effective(fact)` stays in `[0.05, 0.35]`. This
range bracket means:
- Most-semantic fact (eps=0, spec=0): `f_effective ≈ 0.05` (slowest decay,
  matching the cognitive-science prior that abstract generalizations are
  durable).
- Neutral fact (eps=0.5, spec=0.5): `f_effective = 0.15` (the
  Wixted-Ebbesen canonical fact prior, unchanged).
- Most-episodic fact (eps=1, spec=1): `f_effective ≈ 0.35` (faster decay,
  matching the smuggled "episodic" prior).

#### 4.3.2 Worked examples — stratification effect

```js
// Example A: a fact about a one-off meeting (high episodicity).
//   features.episodicity = 0.85
//   features.entities = [{kind:"person", specificity:0.9},
//                        {kind:"event",  specificity:0.95}]
//   entity_specificity_mean ≈ 0.925
//
//   delta_eps = 0.20 * (0.85 - 0.5) =  0.070
//   delta_ent = 0.10 * (0.925 - 0.5) =  0.0425
//   delta     = 0.1125 → clamped to 0.1125 (within [-0.10, +0.20])
//   f_effective = 0.15 + 0.1125 = 0.2625
//
//   At t=30 days: decay = (1+30)^(-0.2625) ≈ 0.413
//   For comparison: a non-stratified fact at t=30 days:
//                   decay = (1+30)^(-0.15)  ≈ 0.604
//   → episodic-leaning meeting note fades faster than a neutral fact.
```

```js
// Example B: a fact representing a general principle (low episodicity).
//   features.episodicity = 0.12
//   features.entities = [{kind:"topic", specificity:0.1}]
//   entity_specificity_mean = 0.1
//
//   delta_eps = 0.20 * (0.12 - 0.5)  = -0.076
//   delta_ent = 0.10 * (0.10 - 0.5)  = -0.040
//   delta     = -0.116 → clamped to -0.10 (CLAMP_DELTA_MIN)
//   f_effective = 0.15 - 0.10 = 0.05
//
//   At t=365 days: decay = (1+365)^(-0.05) ≈ 0.748
//   Compare neutral-fact at t=365: decay = (1+365)^(-0.15) ≈ 0.419
//   → semantic-leaning generalization stays much hotter year-over-year.
```

```js
// Example C: a neutral fact (no episodicity stamped — legacy row).
//   features.episodicity = undefined → treated as 0.5
//   features.entities    = undefined → entity_specificity_mean = 0.5
//
//   delta_eps = 0.0
//   delta_ent = 0.0
//   delta     = 0.0
//   f_effective = 0.15 (unchanged)
//
//   → legacy facts without episodicity get the base Wixted prior. No
//     silent demotion or promotion. Telemetry records
//     `stratify_delta = 0` and `episodicity = null` for the analyst.
```

### 4.4 What the contract does NOT export

Three things this module deliberately does NOT expose:

1. **No `decayAt(event_ts, kind, age_days)` variant.** Offline analysis
   helpers belong in the O5 calibration harness, not in the recall path.
   Carrying it on the recall-time module risks an implementer calling it
   with a hand-computed `age_days` that diverges from the canonical
   `recall_ts - event_ts` discipline. (See § 9 Open Q3.)
2. **No clock side-effects.** No `Date.now()`, no `serverTs()`, no
   `new Date()` inside `powerLawDecay`. The existing helper in
   `multi-feature-score.js` violates this (it calls `nowIso(opts)` which
   falls through to `serverTs()`); the synthesis patch tightens this.
3. **No per-fact cache.** No memoization keyed on `event_ts`. The function
   is cheap (one parse, one pow), and a per-fact cache would silently
   freeze the decay value on the first recall — breaking thesis Principle
   4 mechanically.

### 4.5 Wiring into `computeScore`

The integration node (`F-SYN-INTEGRATION-MULTI-FEATURE-SCORE-WIRING`)
owns the exact call site. The contract here is: `computeScore` calls
`powerLawDecay({event_ts: candidate.ts, recall_ts:
surrounding_context.time, kind: candidate.kind,
episodicity: candidate.features?.episodicity,
entity_specificity_mean: meanEntitySpecificity(candidate.features?.entities)})`
and adds the result into the additive branch as
`CAPS.SCORE_WEIGHT_TIME_DECAY * power_law_decay`.

The multiplicative branch does NOT touch `power_law_decay`. The decay
value is a *soft signal*, not a hard gate. Pre-existing wiring in
`mcp/lib/recall/multi-feature-score.js` already follows this discipline
(line 337); the synthesis patch only swaps the helper signature to take
explicit `recall_ts` and the episodicity/entity inputs.

---

## 5. Decision rules

### 5.1 Time arithmetic

```
Given:
  event_epoch_ms  = Date.parse(input.event_ts)
  recall_epoch_ms = Date.parse(input.recall_ts)

Compute:
  raw_delta_ms = recall_epoch_ms - event_epoch_ms

Clamp:
  t_seconds = max(0, raw_delta_ms / 1000)

Normalize:
  t = t_seconds / CAPS.POWER_LAW_DECAY_UNIT_SECONDS
```

Rationale for the clamp: future-dated events (calendar invites, scheduled
reminders) have `event_ts > recall_ts`. Under the unclamped formula `t`
would be negative, `(1 + h*t)` would be < 1, and `(1 + h*t)^(-f)` would
be > 1 for `f > 0` — exploding the additive channel. Clamping at 0 floors
the decay multiplier at `m = 1.0`, which is the correct semantic ("a
future event has not begun decaying yet").

### 5.2 Kind → f dispatch

```
function dispatchF(kind):
  if kind is null/undefined/empty/non-string:
    return FACT_FALLBACK_F           # CAPS.POWER_LAW_DECAY_F_BY_KIND.fact
  if kind in {"episodic", "semantic", "ambient"}:
    # legacy smuggled label — flag and fall back
    return FACT_FALLBACK_F           # telemetry fallback_reason: SMUGGLED_LABEL
  if kind in CAPS.POWER_LAW_DECAY_F_BY_KIND:
    return CAPS.POWER_LAW_DECAY_F_BY_KIND[kind]
  return FACT_FALLBACK_F             # unknown kind → slowest decay
```

Rationale for the unknown-kind fallback being `fact` (the slowest), not a
fast-decay default: "do no harm." Missing kind metadata is a data-quality
issue, and over-penalizing a candidate with missing metadata silently
demotes legitimate ranked candidates. Defaulting to the slowest decay
leaves the candidate at full strength so the embedding signal can still
rank it on its own merits. The telemetry row records
`fallback_reason: "UNKNOWN_KIND"` so the user sees the drift.

Smuggled labels (`episodic`/`semantic`/`ambient`) fall through the same
path but receive `fallback_reason: "SMUGGLED_LABEL"` so the user can
identify the upstream caller passing the wrong kind taxonomy. The CI
invariant (§ 0.2) blocks new code from doing this; the runtime fallback
is the belt-and-suspenders defense for legacy callers.

### 5.3 Missing-input behavior

| Input state | t-clamp | Returns | Telemetry `fallback_reason` |
|---|---|---|---|
| `event_ts` is null/undefined/"" | n/a | 1.0 | `MISSING_TS` |
| `event_ts` is unparseable string | n/a | 1.0 | `UNPARSEABLE_TS` |
| `recall_ts` is null/undefined/"" | n/a | 1.0 | `MISSING_RECALL_TS` |
| `recall_ts` is unparseable string | n/a | 1.0 | `UNPARSEABLE_RECALL_TS` |
| `recall_epoch < event_epoch` (future event) | t→0 | 1.0 | `FUTURE_EVENT` |
| `kind` unknown / missing | n/a | computed (fact-base-f) | `UNKNOWN_KIND` |
| `kind` is a smuggled label | n/a | computed (fact-base-f) | `SMUGGLED_LABEL` |
| All inputs valid | normal | computed | (none) |

Three of these (MISSING_TS, UNPARSEABLE_TS, MISSING_RECALL_TS) inherit a
return value of **1.0**, not **0**. This is a deliberate divergence from
the existing helper (which returns 0 on missing `ts`). Rationale: a
candidate whose age cannot be computed should not be silently *demoted*
by the decay channel — it should be ranking-neutral. The telemetry row
makes the data-quality issue visible.

(NB: the existing helper returns 0 on missing inputs. The synthesis patch
inverts this. See § 9 Open Q2.)

### 5.4 Determinism contract

The function MUST be byte-stable across runs given the same inputs.
Mechanical enforcement:

1. No `Date.now()`, no `new Date()`, no `performance.now()`.
2. `recall_ts` MUST be passed by the caller.
3. `Math.pow` is IEEE 754; floating-point results MUST match across V8
   versions (Node ≥ 18 is the project's pin).
4. The CAPS table is `Object.freeze`d at module load.
5. The stratification formula uses only `Math.pow`-style arithmetic; no
   floating-point dispatch beyond the kind table.
6. Property-tested against the replay harness (`replay-salience.mjs`):
   replaying a recall log row MUST yield byte-identical
   `power_law_decay_values[]` to the original recall.

### 5.5 Orthogonality contract vs. `time_anchor_match`

The two time channels MUST NOT share computation:

| | `time_anchor_match` | `power_law_decay` |
|---|---|---|
| Owner | `F-SYN-FOUNDATION-time-anchor-schema` + `F-SYN-SUBSTRATE-TIME-INDEX` | this contract |
| Inputs | `candidate.features.time_anchors[]`, `surrounding_context.time_anchor` | `candidate.ts`, `surrounding_context.time`, `candidate.features.episodicity` (fact-stratification only), `candidate.features.entities[].specificity` (fact-stratification only) |
| Gating | masks to 0 if no anchor | NEVER gated; always computes |
| Question answered | "does the fact's anchor match the query's anchor?" | "how recent is the event regardless of any anchors?" |
| Substrate | bucketed time-index (`F-SYN-SUBSTRATE-TIME-INDEX`) | stateless arithmetic |
| Co-fires? | yes — both can contribute on the same recall | yes — both can contribute on the same recall |
| Double-count risk? | none — they consume different inputs | none — they consume different inputs |

The time-index substrate does **not** compute power-law decay. The recall
scorer calls `powerLawDecay` directly from `computeScore`. The substrate
is the bucketed-match owner; this contract is the decay owner. The split
is enforced by the import surface: `mcp/lib/recall/multi-feature-score.js`
imports neither `time-index.js` nor any anchor-resolution helper for the
decay computation — they share only the abstract notion that "time
matters."

---

## 6. Worked examples

The user's real data shapes drive these. The `surrounding_context`
and `candidate` shapes match `operations.md § Inputs` and
`architecture.md § Memory ledger`.

### 6.1 Example: recent fact (neutral episodicity), recall a day later

```js
// Operator promotes a fact about a meeting takeaway.
const candidate = {
  memory_id: "evt_01HZK...",
  kind: "fact",                       // architecture.md §4
  ts: "2026-06-17T14:00:00.000Z",
  features: {
    episodicity: 0.55,                // mildly episodic
    entities: [{kind:"person", specificity:0.9}],
  },
};
const surrounding_context = {
  time: "2026-06-18T14:00:00.000Z",   // 24 h later
};

const decay = powerLawDecay({
  event_ts: candidate.ts,
  recall_ts: surrounding_context.time,
  kind: candidate.kind,
  episodicity: candidate.features.episodicity,
  entity_specificity_mean: 0.9,
});

// Math:
//   t = 1 day; base_f = 0.15;
//   delta_eps = 0.20 * (0.55 - 0.5) = 0.010
//   delta_ent = 0.10 * (0.90 - 0.5) = 0.040
//   delta     = 0.050 (within clamp)
//   f         = 0.20
//   decay     = (1 + 1.0)^(-0.20) ≈ 0.8706
// → at 1 day, a mildly-episodic fact still contributes 0.87.
```

### 6.2 Example: old fact (low episodicity, generic topic), recall after a year

```js
const candidate = {
  memory_id: "evt_01H5...",
  kind: "fact",
  ts: "2025-06-18T00:00:00.000Z",
  features: {
    episodicity: 0.10,                // semantic-leaning
    entities: [{kind:"topic", specificity:0.1}],
  },
};
const surrounding_context = {
  time: "2026-06-18T00:00:00.000Z",   // 365 days later
};

const decay = powerLawDecay({
  event_ts: candidate.ts,
  recall_ts: surrounding_context.time,
  kind: candidate.kind,
  episodicity: candidate.features.episodicity,
  entity_specificity_mean: 0.1,
});

// Math:
//   t = 365; base_f = 0.15;
//   delta_eps = 0.20 * (0.10 - 0.5) = -0.080
//   delta_ent = 0.10 * (0.10 - 0.5) = -0.040
//   delta_raw = -0.120 → clamped to -0.10
//   f         = 0.05
//   decay     = (1 + 365)^(-0.05) ≈ 0.7480
// → a year-old semantic generalization still contributes 0.748.
//   Compare a neutral fact at 365 days: 366^(-0.15) ≈ 0.4194.
//   Compare an episodic fact at 365 days: 366^(-0.35) ≈ 0.1389.
// The stratification keeps long-lived abstractions hot and lets
// short-lived episodes fade.
```

### 6.3 Example: future-dated calendar event (fact kind, future ts)

```js
const candidate = {
  memory_id: "evt_01HZL...",
  kind: "fact",                       // calendar invite promoted as fact
  ts: "2026-07-01T15:00:00.000Z",     // future
  features: {episodicity: 0.9, entities: []},
};
const surrounding_context = {
  time: "2026-06-18T10:00:00.000Z",   // recall NOW
};

const decay = powerLawDecay({
  event_ts: candidate.ts,
  recall_ts: surrounding_context.time,
  kind: candidate.kind,
  episodicity: 0.9,
});

// Math:
//   raw_delta_ms = -1_133_400_000  (negative — future event)
//   t = 0
//   decay = (1 + 0)^(-f) = 1.0 regardless of f
// → future events stay full-strength. Telemetry row sets
//   fallback_reason: "FUTURE_EVENT" so the user can audit.
```

### 6.4 Example: missing kind on a legacy row

```js
const candidate = {
  memory_id: "evt_01H1...",
  // kind absent — legacy row that pre-dates the kind field
  ts: "2026-04-01T00:00:00.000Z",
  features: {},                       // also missing episodicity
};
const surrounding_context = {
  time: "2026-06-18T00:00:00.000Z",   // 78 days later
};

const decay = powerLawDecay({
  event_ts: candidate.ts,
  recall_ts: surrounding_context.time,
  kind: candidate.kind,               // undefined
});

// Math:
//   t = 78 days
//   base_f = 0.15 (FACT_FALLBACK — unknown kind defaults to slowest decay)
//   episodicity undefined → treated as 0.5 → delta = 0
//   f = 0.15
//   decay = (1 + 78)^(-0.15) = 79^(-0.15) ≈ 0.5404
// → unknown kind gets the "do no harm" treatment.
// Telemetry row: { ..., kind: "MISSING", base_f: 0.15, f: 0.15,
//                  episodicity: null, fallback_reason: "UNKNOWN_KIND" }.
```

### 6.5 Example: policy event (predicate that's still operative)

```js
const candidate = {
  memory_id: "evt_01HZM...",
  kind: "policy",                     // architecture.md §4
  ts: "2025-01-15T00:00:00.000Z",     // 17 months ago
};
const surrounding_context = {
  time: "2026-06-18T00:00:00.000Z",
};

const decay = powerLawDecay({
  event_ts: candidate.ts,
  recall_ts: surrounding_context.time,
  kind: candidate.kind,
});

// Math:
//   t ≈ 515 days
//   base_f = 0.05 (policy — slowest of all kinds)
//   stratifyF(kind="policy") returns base_f unchanged
//   decay = (1 + 515)^(-0.05) = 516^(-0.05) ≈ 0.7307
// → a policy event from 17 months ago still contributes 0.73, demoting
//   only marginally. This is the correct prior: policy events operate
//   until rescinded; ranking should not silently forget them.
```

### 6.6 Example: reconstructed event

```js
const candidate = {
  memory_id: "evt_01HZN...",
  kind: "reconstructed",              // architecture.md §4
  ts: "2026-05-01T12:00:00.000Z",
  derived_from: ["evt_01H9...", "evt_01HA..."],
};
const surrounding_context = {
  time: "2026-06-18T00:00:00.000Z",   // 48 days later
};

const decay = powerLawDecay({
  event_ts: candidate.ts,
  recall_ts: surrounding_context.time,
  kind: candidate.kind,
});

// Math:
//   t = 48 days
//   base_f = 0.25 (reconstructed — synthesized faster than primary)
//   stratifyF(kind="reconstructed") returns base_f unchanged
//   decay = (1 + 48)^(-0.25) ≈ 0.3781
// → reconstructed events fade faster than facts at the same age.
//   Open Q5: a v1 variant could look at derived_from[].kind to inherit
//   the slowest decay among parents. Deferred.
```

### 6.7 Example: recall event (the log ages out fast)

```js
const candidate = {
  memory_id: "evt_01HZR...",
  kind: "recall",                     // architecture.md §4
  ts: "2026-05-01T00:00:00.000Z",
};
const surrounding_context = {
  time: "2026-06-18T00:00:00.000Z",   // 48 days later
};

const decay = powerLawDecay({
  event_ts: candidate.ts,
  recall_ts: surrounding_context.time,
  kind: candidate.kind,
});

// Math:
//   t = 48 days
//   base_f = 0.50 (recall log decays fast)
//   decay = (1 + 48)^(-0.50) = 49^(-0.5) ≈ 0.1429
// → 48-day-old recall event contributes only 0.14. Recall events inform
//   damping and reinforcement on a short window; they are not meant to
//   anchor long-term recall.
```

### 6.8 Example: deterministic replay across runs

```js
// Replay harness — replay-salience.mjs replays a recall log row.
const a = powerLawDecay({
  event_ts: "2026-03-01T00:00:00.000Z",
  recall_ts: "2026-06-15T12:34:56.789Z",
  kind: "fact",
  episodicity: 0.7,
});
const b = powerLawDecay({
  event_ts: "2026-03-01T00:00:00.000Z",
  recall_ts: "2026-06-15T12:34:56.789Z",
  kind: "fact",
  episodicity: 0.7,
});
assert(a === b);
```

---

## 7. Invariants

The following invariants are mechanical. They MUST hold across every
implementation, language port, or version bump that claims contract
conformance.

### I-PLD-1 — Recall-time-statelessness

The `powerLawDecay` function MUST NOT read or write any persistent state.
No file I/O, no database calls, no module-level mutable variables (beyond
the frozen CAPS reference). Inputs are functions arguments; output is the
return value; nothing else flows.

### I-PLD-2 — Deterministic across replay

For fixed inputs `(event_ts, recall_ts, kind, episodicity,
entity_specificity_mean)` and fixed CAPS, the output MUST be bit-identical
across runs. Property-tested by the replay harness.

### I-PLD-3 — No clock side-effects

The function MUST NOT call `Date.now()`, `new Date()` (without an
argument), `performance.now()`, or any equivalent wall-clock primitive.
`recall_ts` is the ONLY source-of-truth for current time, and it is
caller-supplied.

### I-PLD-4 — Range bound

For all valid inputs the output MUST satisfy `0 ≤ decay ≤
CAPS.POWER_LAW_M_DEFAULT`. With `m = 1.0` (v0 default) this is `0 ≤ decay
≤ 1.0`. Linted by the score-rescaler in `computeScore` (no extra clamp
required since the math guarantees it for `f, h ≥ 0`, `t ≥ 0`).

### I-PLD-5 — Monotonicity in age

For fixed `kind`, fixed stratification inputs, and fixed CAPS,
`powerLawDecay` MUST be monotonically non-increasing in `t = recall_ts -
event_ts`. This is the algebraic property the curve advertises; any
optimization (memoization, fast-path, SIMD) MUST preserve it.
Property-tested.

### I-PLD-6 — No per-fact mutation

The function MUST NOT mutate `candidate`, `surrounding_context`, or any
ledger event. Inputs are read-only. (Mechanically: the function accepts
five scalars, not the full candidate object, so the contract is
expressed at the call boundary.)

### I-PLD-7 — Channel orthogonality

The function MUST NOT consume `candidate.features.time_anchors[]` or
`surrounding_context.time_anchor`. Those are the time-anchor-match
channel's inputs. Cross-contamination is a bug. CI lint: the
`powerLawDecay` source MUST NOT reference the strings `time_anchor` or
`time_anchors`.

### I-PLD-8 — Future-event safety

For `recall_ts < event_ts` the output MUST be `m` (not > m, not 0, not
NaN). This is the `max(0, t)` clamp; without it the curve diverges
above 1 and corrupts the multi-feature score.

### I-PLD-9 — CAPS-table closure

The per-kind `f` table MUST be `Object.freeze`d at module load. Runtime
mutation of `CAPS.POWER_LAW_DECAY_F_BY_KIND` MUST fail (silently in
non-strict, loudly in strict mode). The only legitimate path to change
priors is editing `mcp/lib/validation.js` and bumping
`POWER_LAW_DECAY_VERSION`.

### I-PLD-10 — Version-bump audit

Any change to `CAPS.POWER_LAW_DECAY_F_BY_KIND`,
`CAPS.POWER_LAW_DECAY_FACT_STRATIFICATION`,
`POWER_LAW_M_DEFAULT`, `POWER_LAW_H_DEFAULT`, or
`POWER_LAW_DECAY_UNIT_SECONDS` MUST bump
`CAPS.POWER_LAW_DECAY_VERSION` and emit one `policy.drift` event into
`policy-events-YYYY-MM.jsonl`. Replay harness reads the recorded version off the
recall log row and refuses to replay if the version mismatches.

### I-PLD-11 — Dark-launch zero

Setting `CAPS.SCORE_WEIGHT_TIME_DECAY = 0` MUST silently zero out the
contribution of the channel to the final score without any code change.
This is the user's escape hatch if v0 evaluation shows the channel is
anti-helpful (matches the `salience-design.md` R24.5 graft pattern). The
`powerLawDecay` function continues to compute; only the wired weight
becomes zero.

### I-PLD-12 — Telemetry coverage

For every candidate that survives the multiplicative gates and enters the
additive scoring, exactly one row MUST be emitted into
`recall.power_law_decay_values[]`. Candidates dropped by hard gates
(predicate-excluded, consent-blocked) do not get telemetry rows from this
channel — they were never scored against the decay function.

### I-PLD-13 — Closed kind taxonomy

The per-kind `f` table's keys MUST be a subset of the authoritative
4-kind enumeration from `architecture.md §4`:
`{"fact", "policy", "recall", "reconstructed"}`. No synthesis spec or
synthesis library source MUST use `kind="ambient"`, `kind="semantic"`, or
`kind="episodic"` as if they were row-level kinds. The grep test
(`test/synthesis/kind-taxonomy-invariant.test.mjs`) is the mechanical
enforcement. Smuggled labels at runtime fall through the dispatcher's
`SMUGGLED_LABEL` branch (§5.2) and are recorded in telemetry.

### I-PLD-14 — Stratification monotonicity

For fixed `kind="fact"` and fixed `(event_ts, recall_ts,
entity_specificity_mean)`, `powerLawDecay` MUST be monotonically
non-increasing in `episodicity`. That is, increasing episodicity raises
`f` (within the clamp) which lowers `decay`. Property-tested. This
guarantees the stratification dial has a defined direction — high
episodicity always means faster decay.

---

## 8. Cross-tier impact

This foundation contract constrains four downstream tier nodes.

### 8.1 `F-SYN-INTEGRATION-MULTI-FEATURE-SCORE-WIRING` (integration tier)

This contract names the function the integration node wires. The
integration tier MUST:

- Call `powerLawDecay({event_ts: candidate.ts, recall_ts:
  surrounding_context.time, kind: candidate.kind,
  episodicity: candidate.features?.episodicity,
  entity_specificity_mean: meanEntitySpecificity(...)})` and feed the
  result into the additive sum as `CAPS.SCORE_WEIGHT_TIME_DECAY *
  power_law_decay`.
- NOT multiply the decay term into the multiplicative-gate branch (decay
  is a soft signal, not a hard gate).
- NOT gate the decay term by anchor presence (that gate belongs to
  `time_anchor_match` only).
- Emit `recall.power_law_decay_values[]` with one row per scored
  candidate.

### 8.2 `F-SYN-SUBSTRATE-TIME-INDEX` (substrate tier)

The time-index substrate handles the BUCKETED time-anchor-match channel.
It MUST NOT compute power-law decay. The substrate node's review_step
already flagged this hole; this contract closes it by becoming the
named owner.

The time-index substrate's bucketing data structure does NOT need to
include `event.ts` — the decay channel does not query the index at all.
This is what "orthogonal channels" means at the substrate boundary.

### 8.3 `F-SYN-FOUNDATION-time-anchor-schema` (foundation tier sibling)

The anchor schema owns the shape of `candidate.features.time_anchors[]`
and `surrounding_context.time_anchor`. Those fields MUST NOT be read by
the power-law decay function. This contract guarantees the discipline at
the import boundary; the anchor schema owns the discipline at the field
boundary.

### 8.4 `F-SYN-FOUNDATION-episodicity-feature` (foundation tier sibling)

The episodicity feature owns the `[0, 1]` scalar that this contract reads
to stratify the fact-row base `f`. The two foundation nodes MUST stay in
lockstep:

- This contract reads `candidate.features.episodicity` as a scalar; the
  episodicity feature MUST emit it as a scalar (not a bucket label).
- This contract's stratification slopes
  (`EPISODICITY_F_SLOPE = 0.20`) assume the canonical sigmoid range of
  the episodicity feature; if the episodicity feature changes its
  output transform, this contract's slopes MUST be re-derived.
- Both contracts pin their version (`POWER_LAW_DECAY_VERSION = 2`,
  `EPISODICITY_VERSION = 'v1'`) and the replay harness asserts the pair.

### 8.5 `O5-damping-calibration-loop` (operational tier — future wave)

The O5 calibration loop consumes `recall.power_law_decay_values[]` from
the recall log. It re-fits the per-kind `f` priors against engagement
labels. When O5 ships, it MUST:

- Read the per-recall telemetry rows from `recall.jsonl` (the recall log
  substrate).
- Group by `kind` (one of the 4 authoritative kinds).
- For `kind="fact"`, additionally stratify by episodicity quartile and
  re-fit the slope coefficients (`EPISODICITY_F_SLOPE`,
  `ENTITY_SPECIFICITY_F_SLOPE`) jointly with the base `f`.
- Propose new `CAPS.POWER_LAW_DECAY_F_BY_KIND` entries with confidence
  intervals.
- NEVER mutate CAPS at runtime; calibration emits a proposal, the
  operator approves the CAPS edit manually.
- Bump `POWER_LAW_DECAY_VERSION` on every accepted recalibration.

### 8.6 Cross-tier invariants honored

This spec preserves four cross-cutting invariants the existing system
holds:

1. **thesis Principle 4 — decay is not a per-memory strength field.**
   Mechanically: no per-fact cache, no mutation, recall-time-only
   computation.
2. **architecture.md § Index — derived layer, never authoritative.** The
   recall scorer reads `event.ts` from the ledger and `surrounding_
   context.time` from the recall input; the decay value is recomputed on
   every recall, never stored.
3. **operations.md damping orthogonality — decay is the default,
   surfacing-penalty is separate.** The power-law decay channel
   complements the `recent_surfacing_penalty` (w4 in operations.md)
   without overlapping it; the surfacing penalty consumes
   `recent_recall_ids`, decay consumes `event.ts`.
4. **research-retrieval-frontiers.md staged rollout — v0 ships a soft
   feature, v3 trains it.** This contract delivers the v0 hand-tuned
   shape *and* the telemetry stream needed for v3's learned ranker. No
   re-architecture is needed at v3 to swap the prior table.

---

## 9. Open questions

Carry these forward as wave-N tasks. Each is wired with a deferral target
so the question doesn't drop on the floor.

### Open Q1 — Unknown-kind fallback: fact or fast-decay?

The synthesis spec mandates `fact` (the slowest base_f) as the
unknown-kind fallback. The existing helper uses a fast-decay default. The
patch flips this direction — "do no harm" beats "default to conservative
discrimination."

**Defer to O5:** the calibration loop should empirically choose the
fallback based on engagement labels on the unknown-kind cohort. The
contract pins fact-fallback for v0 ship; O5 may re-fit.

### Open Q2 — Missing-input return: 0 or 1?

This contract mandates returning **1.0** on missing `event_ts` /
`recall_ts`. The existing helper returns **0**. The flip moves the
channel from "silent demotion on bad data" to "ranking-neutral on bad
data with audit trail."

**Defer to operator review** during v0 dark-launch.

### Open Q3 — Should `decayAt(event_ts, kind, age_days)` exist for offline analysis?

**Defer to operational tier.**

### Open Q4 — `unit_seconds` — days or weeks?

**Defer to O5 calibration.**

### Open Q5 — Reconstructed events: parent-kind decay or fixed `reconstructed` base_f?

v0 ships with `reconstructed → base_f = 0.25` (fixed, faster than fact).
A v1 variant could read `candidate.derived_from[]` and inherit the
parent's stratified `f`. The fixed v0 path is simpler.

**Defer to v1.**

### Open Q6 — Policy events: should they decay at all?

v0 contract gives `policy → base_f = 0.05`. A more aggressive
interpretation is `f=0` (policy events never decay, only `rescind`).

**Defer to operator review.**

### Open Q7 — Composite interaction with engagement-prior channel

**Defer to Phase 3 v3** (engagement-trained ranker).

### Open Q8 — CAPS naming: rename existing keys to match contract?

Path-1 (alias new keys to old) recommended. The integration node carries
the rename.

### Open Q9 — Recall-kind base_f at 0.50: defensible?

The recall log ages out fast by design. v0 pin is 0.50 — much faster than
fact. The "right" value depends on what fraction of the recall stream the
operator wants to keep retrievable on a 30-day horizon.

**Defer to O5.** v0 telemetry on recall→recall-recall feedback loops
will reveal whether 0.50 is too aggressive.

### Open Q10 — Stratification slope sign on entity_specificity

This spec sets `ENTITY_SPECIFICITY_F_SLOPE = +0.10` (specific entities →
faster decay; generic entities → slower). The opposite sign is also
defensible (a fact about a specific person remains relevant whenever that
person resurfaces). The current sign matches the cognitive-science
generalization-prior; a workflow-specific empirical fit may invert it.

**Defer to O5 calibration.**

---

## 10. Implementation checklist (for the future implementer)

A landing checklist for the engineer who picks this up.

- [ ] Edit `mcp/lib/validation.js`:
  - Add `POWER_LAW_DECAY_VERSION = 2`.
  - Add `POWER_LAW_DECAY_UNIT_SECONDS = 86400`.
  - Add `POWER_LAW_DECAY_F_BY_KIND = Object.freeze({fact: 0.15,
    reconstructed: 0.25, policy: 0.05, recall: 0.50})`.
  - Add `POWER_LAW_DECAY_FACT_STRATIFICATION = Object.freeze({
    EPISODICITY_F_SLOPE: 0.20,
    ENTITY_SPECIFICITY_F_SLOPE: 0.10,
    CLAMP_DELTA_MIN: -0.10, CLAMP_DELTA_MAX: 0.20})`.
  - Add `RECALL_W_T2` as an alias for `SCORE_WEIGHT_TIME_DECAY`.
  - Add inline comment citing architecture.md §4 and the
    PRIOR-not-measured discipline.
- [ ] Edit `mcp/lib/recall/multi-feature-score.js`:
  - Replace the existing `powerLawDecay({ts, kind, opts})` with the
    contract signature `powerLawDecay({event_ts, recall_ts, kind,
    episodicity, entity_specificity_mean})`.
  - Remove the `nowIso(opts)` call; `recall_ts` MUST be caller-supplied.
  - Replace the legacy `POWER_LAW_F_BY_KIND` table with the 4-kind set.
  - Implement `stratifyF` per §4.3.1.
  - Flip the unknown-kind fallback to `fact`.
  - Flip the missing-input return from `0` to `1`.
  - Add `powerLawDecayTelemetry({...})` returning the
    `PowerLawDecayTelemetryRow` shape.
  - Export `POWER_LAW_DECAY_VERSION = 2`.
  - Update the caller (`computeScore`) to pass
    `surrounding_context.time` as `recall_ts` and to thread
    `candidate.features?.episodicity` plus the entity-specificity mean.
- [ ] Edit `mcp/lib/recall-log.js` (or wherever the recall event row is
  built) to accumulate `power_law_decay_values[]` from the telemetry
  helper.
- [ ] Add property tests for invariants I-PLD-1 through I-PLD-14 under
  `mcp/test/synthesis/power-law-decay.test.mjs`.
- [ ] Add the kind-taxonomy CI invariant
  (`mcp/test/synthesis/kind-taxonomy-invariant.test.mjs`) that greps
  `mcp/docs/specs/synthesis/*.md` and `mcp/lib/synthesis/**/*.js` for
  forbidden `kind="ambient"` / `kind="semantic"` / `kind="episodic"`
  patterns.
- [ ] Add a CI lint that greps `mcp/lib/recall/multi-feature-score.js`
  for `time_anchor` references inside the `powerLawDecay` function body
  — must be zero (I-PLD-7).
- [ ] Update `kb/phase3-v0-contracts.md § 3 ScoreComponents` to reference
  this spec as the authoritative owner of the `power_law_decay` field.
- [ ] Update `F-SYN-INTEGRATION-MULTI-FEATURE-SCORE-WIRING` node to
  reference this contract as a satisfied dependency.
- [ ] Update `F-SYN-SUBSTRATE-TIME-INDEX` node to drop the
  ownership-disclaimer comment now that this contract is the named
  owner.

---

## 11. Footer — provenance of the priors

The per-kind `f` priors and stratification slopes are educated guesses,
NOT empirical measurements. The kb is explicit about this:

> *`research-retrieval-frontiers.md § Open holes / loose ends`:*
> "Power-law per-kind f values (0.15/0.35/0.6) — pure prior, not derived
> or cited from Wixted & Ebbesen 1997 (which fit individual subjects, not
> memory-kind partitions)."

Future readers of this spec, of `mcp/lib/validation.js`, or of recall log
rows that carry `power_law_decay_values[]` MUST treat the priors as a v0
bootstrap, not as ground truth. The mechanical safeguards:

1. The CAPS table's inline comment carries the PRIOR-not-measured flag.
2. The contract version bumps on recalibration (I-PLD-10).
3. The replay harness refuses to replay across version changes
   (mechanical enforcement of provenance).
4. The O5 calibration loop is named in § 8.5 as the owner of the
   recalibration discipline.
5. The kind taxonomy is anchored to `architecture.md §4` (the closed
   4-kind set), with the smuggled `episodic / semantic / ambient`
   labels demoted to fact-row stratification dials. The CI invariant
   (`test/synthesis/kind-taxonomy-invariant.test.mjs`, I-PLD-13)
   mechanically prevents the smuggling from returning.

The contract ships dark-launchable: setting `CAPS.SCORE_WEIGHT_TIME_DECAY
= 0` zeroes the channel without code edits (I-PLD-11). If v0 evaluation
shows the priors are anti-helpful, the user's escape hatch is one
CAPS edit, not a code rollback. This matches the `salience-design.md`
R24.5 graft pattern.

---

*End of contract.*
