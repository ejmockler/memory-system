# Episodicity-axis feature contract (per-fact scalar + query scalar + match-score)

> **Revision note (Wave 5, WU-episodicity-scorer-substrate, 2026-06-19):**
> Resolved W4 review spawn finding — cross-tier field-path mismatch with
> `power-law-decay-contract.md`. The fact-side slot is now
> `features.episodicity` (a bare scalar `number | null ∈ [0, 1]`),
> matching what the W3 decay contract reads at `§ 4.3.1`. The rich
> telemetry object (`components`, `fallbacks_applied`,
> `episodicity_version`, `weights_hash`) moves to a sibling sidecar
> slot `features.episodicity_meta`. All prior text and worked examples
> have been migrated from `features.episodicity_score` →
> `features.episodicity` (scalar) and `features.episodicity_meta`
> (metadata). The match-score consumer now reads
> `candidate.features?.episodicity ?? null` directly. The CAPS keys,
> sigmoid weights, and invariants are unchanged; only the field path
> shifted to satisfy the foundation handshake.

> **Status:** foundation spec (synthesis tier, wave-N).
> **Node:** `F-SYN-FOUNDATION-episodicity-feature`.
> **Owners (downstream substrate / integration):**
> `F-SYN-SUBSTRATE-EPISODICITY-SCORER`,
> `F-SYN-INTEGRATION-CASCADE-STAMPS-EPISODICITY`,
> `F-SYN-INTEGRATION-MULTI-FEATURE-SCORE-WIRING`.
> **Authoritative kb cross-refs:**
> `research-retrieval-frontiers.md § Phase 3 v2`,
> `research-retrieval-frontiers.md § Phase 3 v0 multi-feature score`,
> `architecture.md § 4 Memory ledger`,
> `salience-design.md § R24.5 graft (ship dark with zero weight)`,
> sibling synthesis specs:
> `entity-schema.md`, `time-anchor-schema.md`, `valence-provenance.md`,
> `power-law-decay-contract.md` (which **consumes** the per-fact episodicity
> scalar this spec produces).

---

## 1. Mission

Pin the *computation contract* for the **episodicity scalar** — a pure
`[0, 1]` real-valued feature that estimates how episodic vs how semantic
a given memory event is, computed identically (same pure function, same
caps) on the fact side at promote time and on the query side at recall
time. Episodicity is the row-level dial that replaces the smuggled
`episodic / semantic / ambient` row-kind labels rejected by
`power-law-decay-contract.md § 0`. It is the load-bearing input to the
`f_effective(fact)` stratification rule in the W3 decay contract, the
multiplicative `episodicity_match` channel in the
`research-retrieval-frontiers.md § Phase 3 v0` multi-feature score, and
the stratification dimension for the Phase 3 v2 success criterion
(*"stratified Recall@12 by query_episodicity quartile shows episodic ↔
episodic, semantic ↔ semantic separation"*).

The "why now" is twofold. First, the multi-feature score formula already
*names* `episodicity_match` as a multiplicative-gate factor at v0 per
`research-retrieval-frontiers.md`, so leaving the channel inert means
v0 ships with a `null * other_factors` failure mode unless this spec
exists. Second, the W3 rebase
(`power-law-decay-contract.md`) explicitly defers the formula shape to
this contract: the decay stratification rule reads
`features.episodicity` as a `[0, 1]` scalar and relies on its definition
being pinned BEFORE the W3 patch lands in `mcp/lib/recall/multi-feature-score.js`.

Within scope:

1. **The function shape** — a sigmoid over four features with five
   hand-tuned weights, all CAPS-pinned so re-calibration is a knob-flip.
2. **The four input features** — `has_time_anchor` (binary 0/1),
   `log(1 + corroboration_count)`, `entity_generality` (1 - mean
   entity-specificity), `narrative_valence_magnitude`
   (`|valence.magnitude|`).
3. **The promote-time stamp side** — when, where, with what fallbacks.
4. **The recall-time twin** — `query_episodicity` computed over
   `surrounding_context` with the SAME pure function.
5. **The match function** — `episodicity_match = 1 - |fact_ep -
   query_ep|`, on which side of the multi-feature score formula.
6. **The corroboration-drift hazard** — the review's MAJOR issue
   (review_step issue #1): re-derivation policy when corroboration_count
   changes after promote.
7. **The entity-extractor-version drift hazard** — re-stamp policy when
   the entity specificity-prior table or extractor bumps.
8. **The empty / null input fallbacks** — every feature has a documented
   absent-value rule (the review flagged the empty-entities and
   absent-valence cases).
9. **The dark-launch operator switch** — zero weight on the channel
   without code change, per `salience-design.md § R24.5`.

Out of scope (separately owned):

- The substrate scorer implementation
  (`F-SYN-SUBSTRATE-EPISODICITY-SCORER` — module wiring + cache).
- The integration call sites
  (`F-SYN-INTEGRATION-CASCADE-STAMPS-EPISODICITY`,
  `F-SYN-INTEGRATION-MULTI-FEATURE-SCORE-WIRING`).
- The learned-weight replacement (`F-SYN-OPERATIONAL-offline-eval-harness`
  / `F-SYN-OPERATIONAL-held-out-labeled-set-v2` will re-fit at v2).

The audience is the future implementer who will write
`mcp/lib/synthesis/episodicity-scorer.js`, add the CAPS, and wire the
two call sites. The contract is language-agnostic in shape but the
reference signatures and CAPS keys assume the existing Node.js/ESM
codebase.

---

## 2. kb anchors

Every claim in this spec traces back to one of the following kb
passages or sibling synthesis specs. Quotes are verbatim from
`<checkout>/kb/` as of when this spec was written, and from the sibling
specs in `<checkout>/mcp/docs/specs/synthesis/`.

### 2.1 The v2 feature spec (the spec to pin to v0)

> *`research-retrieval-frontiers.md § Phase 3 v2 — Entity/derivation
> graph as PPR + episodicity feature` (audit_ref line 45):*
> `"episodicity feature on event.features (sigmoid over has_time_anchor,
> log corroboration_count, entity_generality, narrative_valence);
> query_episodicity scalar from surrounding_context; episodicity_match
> enters the score."`

Binding: this is the formula shape verbatim. Four features, sigmoid
combine, query-side twin, match-score enters the multi-feature score.
The "stamp at promote / recompute at recall" twin discipline is
inherited from `valence-provenance.md` (which calls the same scorer on
both sides).

### 2.2 The v0 multi-feature score formula slot

> *`research-retrieval-frontiers.md § Recommended Phase 3 architecture
> / Layer 2` (audit_ref line 19):*
> `"Multi-feature score is (s_emb_full3072 * predicate_mask *
> consent_dampener * derivation_status * episodicity_match) +
> w_ent*entity_overlap_jaccard + w_t1*time_anchor_match (gated to 0 if
> no anchor) + w_t2*power_law_decay(age, kind) + w_val*valence_compat +
> w_eng*engagement_prior."`

Binding: `episodicity_match` is one of the **five multiplicative
gates** wrapped around the embedding score. It is NOT on the additive
side. The decision-rule section (§ 6) makes this asymmetry mechanically
explicit.

### 2.3 The v2 success criterion (the channel's reason for existing)

> *`research-retrieval-frontiers.md § Phase 3 v2 success criteria`
> (audit_ref line 45):*
> `"stratified Recall@12 by query_episodicity quartile shows episodic
> ↔ episodic, semantic ↔ semantic separation."`

Binding: the channel exists to enforce same-quartile preference.
Worked example § 7.4 demonstrates the same-quartile bias the
match-score creates.

### 2.4 The fact-features slot (where the value lives)

> *`architecture.md § 4 Memory ledger → fact features` (per
> `valence-provenance.md` § KB-3 quoting it):*
> `"features: { embedding, embedding_model_version, entities: [],
> time_anchors: [], valence } — valence is declared as a per-fact
> feature."`

Binding: `features.episodicity` (the scalar) and its sidecar
`features.episodicity_meta` are the **synthesis-tier extension slots**
added by this spec. They sit alongside `features.embedding`,
`features.entities[]`, `features.time_anchors[]`, `features.valence`.
The cascade write is atomic — either all synthesis features (and the
version stamps) succeed or the fact is not appended (matches the
`valence-provenance.md § S2` discipline). The scalar lives at
`features.episodicity` so the W3 power-law-decay-contract's
`§ 4.3.1` read of `candidate.features.episodicity` is the same field
path; the meta object lives at `features.episodicity_meta` for
telemetry / replay.

### 2.5 The dark-launch (zero-weight) graft pattern

> *`salience-design.md § R24.5` (audit_ref line 5):*
> `"R24.5 graft: ship two zero-valued retrieval-decay-feedback columns
> (last_retrieved_ts, use_count) inside features.salience.components
> at R25 with weight=0.0 in CAPS.SALIENCE_WEIGHTS_V1, so CP-5 Trigger A
> becomes a byte-idempotent weight bump rather than a schema migration
> once recall.jsonl populates."`

Binding: the same graft pattern applies to episodicity. The CAPS
introduces a per-channel weight knob (`CAPS.SCORE_WEIGHT_EPISODICITY_MATCH`)
that can be set to **0.0 in production** if the v0 hand-tuned weights
prove anti-helpful (mitigation for the recommended-but-risky review
disposition). Computation continues; only the wired weight becomes
zero. The channel is *never* removed from the formula structure (a
removal would force a downstream code change); it is *zeroed*.

### 2.6 The W3 stratification rule (the consumer)

> *`<checkout>/mcp/docs/specs/synthesis/power-law-decay-contract.md
> § 4.3.1`:*
> ```
> delta_eps = CAPS.POWER_LAW_DECAY_FACT_STRATIFICATION.EPISODICITY_F_SLOPE
>             * (eps - 0.5)
> ...
> return base_f + delta
> ```
> *(where `eps = candidate.features.episodicity ?? 0.5`)*

Binding: the W3 decay channel reads the per-fact episodicity scalar
directly. The scalar is `[0, 1]`; the W3 contract treats `0.5` as
neutral and stratifies upward (faster decay) or downward (slower decay)
around that pivot. The v0 weights in this spec MUST produce values
spread across `[0, 1]` (not bunched at the sigmoid asymptotes) so the
W3 stratification has dynamic range. § 6.4 documents the calibration
guarantee.

### 2.7 The entity-schema specificity-prior table (mirrored from
`entity-schema.md` § 3.1)

> *`entity-schema.md § 3.1`:*
> `"event 0.95, person 0.90, place 0.80, project 0.70, org 0.60,
> artifact 0.50, topic 0.10. Adding a kind that is not in this table is
> a defect — lib/ingest/salience.js MUST fail closed if
> specificity_prior[kind] is undefined at any call site."`

Binding: `entity_generality = 1 - mean(entity.specificity_prior[kind])`
over `fact.features.entities[]`. The specificity-prior table is the
SAME data structure as the entity-schema mirror; this spec MUST cite
the same constants by reference (`CAPS.ENTITY_SPECIFICITY_PRIORS`) and
the CI cross-check at `entity-schema.md § I9` enforces that both nodes
carry the same kinds and priors.

### 2.8 The valence value shape (input to the magnitude feature)

> *`valence-provenance.md § S1`:*
> `"ValenceValue { sign: -1 | 0 | +1, magnitude: number ∈ [0, 1],
> source: 'lexicon' | 'classifier' | 'absent', extractor_version:
> string }"`

Binding: `narrative_valence_magnitude = |valence.magnitude|`. The
absent-case (`source === 'absent'`) is the review_step's MINOR issue:
explicit fallback rule at § 6.3.

### 2.9 The corroboration projection (input to the corroboration
feature)

> *`architecture.md § 5 Indexes`:*
> `"Corroboration index — keyed by canonical_id; counts policy.corroboration
> events emitted by the salience cascade."`

Binding: `corroboration_count = corroborationCount(fact)` is a read
from the corroboration projection at the moment of computation. The
review_step MAJOR drift hazard (§ 6.5) is resolved by tying the stored
`features.episodicity` scalar (and the `episodicity_version` carried in
`features.episodicity_meta`) to a version stamp AND re-computing
query-side `query_episodicity` over LIVE projection at recall time.
Promote-time stamp is a **cache for the W3 stratification**, not a
truth claim that the fact stays at that episodicity forever; query-side
re-computation is the live signal.

### 2.10 Why the same pure function on both sides

> *`valence-provenance.md § Mission`:*
> `"A single named module — mcp/lib/synthesis/valence-scorer.js — that
> produces valence values for BOTH call sites (cascade-stamp at promote
> time over event.content, and populator at recall time over
> surrounding_context)."`

Binding: this spec adopts the same discipline. ONE module
(`mcp/lib/synthesis/episodicity-scorer.js`) exports ONE pure function
(`computeEpisodicity`) called from BOTH sides. CI grep test asserts no
other source file in `mcp/lib/synthesis/`, `mcp/lib/ingest/`, or
`mcp/lib/recall/` defines a function whose name contains `episodicity`
and that performs the sigmoid combine.

---

## 3. Schemas

### 3.1 Input schema — `EpisodicityInput`

```ts
/**
 * The bag of features the sigmoid eats. Used identically on the fact
 * side and the query side. Every field has an explicit "absent" rule
 * (see § 6.3).
 */
type EpisodicityInput = {
  /**
   * Binary 0/1. 1 iff the row has at least one usable time anchor.
   * Definition of "usable" per time-anchor-schema.md:
   *   - kind ∈ {"absolute", "relative"} AND
   *   - extractor_confidence ≥ CAPS.EPISODICITY_TIME_ANCHOR_MIN_CONF (0.5),
   *     AND
   *   - recurrence_resolution_deferred !== true
   * Recurring anchors that the resolver deferred do NOT contribute
   * (matches time-anchor-schema.md gating predicate).
   *
   * Empty / missing time_anchors[] → 0.
   * On the QUERY side, derived from surrounding_context.time_anchor
   * (single) and the time_anchors in recent_turns[] (any of them
   * suffices).
   */
  has_time_anchor: 0 | 1;

  /**
   * Number of policy.corroboration events that target this fact, read
   * from the corroboration projection AT THE MOMENT OF COMPUTATION.
   *   - On the FACT side at promote time: this is always 0 (the fact
   *     is being written for the first time; no corroboration events
   *     yet refer to it).
   *   - On the FACT side via re-stamp (O6 drift event): this is the
   *     live count as of the re-stamp moment.
   *   - On the QUERY side: not meaningful — the query has no
   *     corroboration history. § 6.6 defines query-side substitution:
   *     use the MEAN corroboration_count of the top-K candidate
   *     corroborations the surrounding_context's entity-set anchors
   *     to. § 6.6 also documents the v0 simplification: query-side
   *     corroboration_count = 0 unconditionally (the channel for the
   *     query side leans on entity_generality and has_time_anchor; the
   *     review prefers the simpler v0).
   *
   * MUST be non-negative integer. Negative or non-integer → coerced to
   * 0 and telemetry row records `fallback_reason: "BAD_CORROBORATION"`.
   */
  corroboration_count: number;

  /**
   * The fact's entity set (canonical_id-bearing), used to compute
   * entity_generality. On the query side, the populator constructs
   * this as the union of entities extracted from current_query,
   * recent_turns[] (most recent ≤ 4), and ambient.parties_present.
   * The SAME extractor (entity-schema.md § 7.1) is used.
   *
   * Empty / null → entity_generality fallback rule applies (§ 6.3).
   */
  entities: Entity[];   // per entity-schema.md § 4

  /**
   * The fact's valence value. On the query side, this is
   * surrounding_context.ambient.inferred_mood. Used to compute
   * |valence.magnitude|.
   *
   * Per valence-provenance.md § S1, `source === 'absent'` implies
   * sign=0 AND magnitude=0; the absent case contributes 0 to the
   * sigmoid input but DOES NOT affect b0 (i.e. the row is not penalized
   * for being affect-neutral; it just receives no upward push from the
   * b4 term).
   */
  valence: ValenceValue;   // per valence-provenance.md § S1

  /**
   * The kind of the row this computation is associated with. Used only
   * for the no-episodicity-on-non-facts rule (§ 6.7): episodicity is
   * defined only for `kind === "fact"`. For `kind ∈ {policy, recall,
   * reconstructed}` the function returns null (NOT 0.5; see § 6.7).
   *
   * On the query side this field is omitted; the populator always
   * computes a query_episodicity scalar.
   */
  kind?: "fact" | "policy" | "recall" | "reconstructed";
};
```

### 3.2 Output schema — split: scalar + `EpisodicityMeta` sidecar

Post-W5 rename, the function returns the scalar and the sidecar
separately so the fact-feature schema can store them at distinct field
paths (`features.episodicity` and `features.episodicity_meta`).

```ts
/**
 * The bare scalar ∈ [0, 1] OR null. 1 = maximally episodic (a one-off,
 * affect-laden, time-anchored event involving specific entities);
 * 0 = maximally semantic (a generalization across many corroborations,
 * involving generic topics, no anchor, low affect).
 *
 * Returned as `null` for non-fact kinds when computed on the fact side
 * (see § 6.7).
 *
 * THIS is the value persisted at `features.episodicity` and consumed
 * by the W3 power-law-decay-contract's `§ 4.3.1` stratifier and by the
 * multi-feature-score's `episodicity_match` channel.
 */
type EpisodicityScalar = number | null;

type EpisodicityMeta = {
  /**
   * The four feature values that fed the sigmoid, preserved so the
   * recall-log can replay and the analyst can audit. Each is the value
   * AS THE FUNCTION SAW IT (post-fallback substitution if any).
   */
  components: {
    has_time_anchor: 0 | 1;
    log_corroboration_count: number;     // log(1 + corroboration_count)
    entity_generality: number;            // ∈ [0, 1] or null (see § 6.3)
    narrative_valence_magnitude: number;  // |valence.magnitude| ∈ [0, 1]
  };

  /**
   * Telemetry — which fallbacks fired during this computation. Empty
   * array means clean compute. Possible values: see § 6.3.
   */
  fallbacks_applied: string[];

  /**
   * The CAPS version pin captured at the moment of computation. Bumps
   * on any change to weights, entity-specificity priors, or the sigmoid
   * shape trigger an O6 re-stamp pass on the fact side. Query side
   * recomputes per recall so the version drift never persists.
   */
  episodicity_version: string;          // CAPS.EPISODICITY_VERSION

  /**
   * Hash of the CAPS.EPISODICITY_WEIGHTS_V1 + CAPS.ENTITY_SPECIFICITY_PRIORS
   * pair, captured per _capsSnapshot() in mcp/lib/validation.js.
   * Recall-log row carries this so replay can refuse if mismatched.
   * (Matches the salience.js weights-discipline pattern.)
   */
  weights_hash: string;
};
```

### 3.3 Fact-feature slot

```ts
type FactFeatures = {
  embedding: number[];
  embedding_model_version: string;
  entities: Entity[];                 // per entity-schema.md
  time_anchors: TimeAnchor[];         // per time-anchor-schema.md
  valence: ValenceValue;              // per valence-provenance.md
  episodicity: number | null;         // <-- this spec, scalar ∈ [0, 1]
                                      // OR null for non-fact / fallback.
                                      // W3 power-law-decay-contract reads
                                      // this exact field path.
  episodicity_meta?: EpisodicityMeta; // <-- this spec, sidecar holding
                                      // components, fallbacks_applied,
                                      // episodicity_version, weights_hash
                                      // (telemetry + replay shape).
  salience?: SalienceFeatures;        // per salience-design.md
};
```

The `features.episodicity` scalar is **always populated** on
`kind === "fact"` rows, even when fallbacks fire — in that case the
value may be `null` and `features.episodicity_meta.fallbacks_applied[]`
documents why. Non-fact kinds (`policy`, `recall`, `reconstructed`)
DO NOT carry `features.episodicity` or `features.episodicity_meta`
fields at all (matches the `valence-provenance.md` discipline of
"reconstructed does not stamp valence").

### 3.4 Surrounding-context twin

```ts
type SurroundingContext = {
  recent_turns: Turn[];
  agent_role: string;
  current_query: string;
  time: string;
  ambient: {
    calendar_state: CalendarState | null;
    inferred_mood: ValenceValue;
    parties_present: string[];
  };
  recent_recall_ids: string[];
  /**
   * Computed by F-SYN-FOUNDATION-context-populator at recall time over
   * the rest of the context. Always populated (never null) because the
   * recall-time scorer needs a numeric value for the multiplicative
   * gate. Fallback rules at § 6.3 ensure a value emerges even when
   * inputs are degraded.
   *
   * Bare scalar ∈ [0, 1]. The query-side meta (components, fallbacks,
   * version, weights hash) is carried separately on the recall log row
   * (see § 3.6) — `surrounding_context` itself only holds the scalar
   * so the multi-feature scorer can read it directly.
   */
  query_episodicity: number;             // <-- this spec, scalar ∈ [0, 1]
  query_episodicity_meta?: EpisodicityMeta;
};
```

### 3.5 CAPS schema — additions to `mcp/lib/validation.js`

```js
// Episodicity (F-SYN-FOUNDATION-episodicity-feature)

EPISODICITY_VERSION: 'v1',                  // bump on any weight / prior change

/**
 * v0 hand-tuned sigmoid weights. PRIOR-not-measured — re-fit by the O5
 * calibration loop once the held-out labeled set exists (per
 * F-SYN-OPERATIONAL-held-out-labeled-set-v2). The pattern matches the
 * Park-as-baseline / W3 priors discipline: ship hand-tuned values that
 * are explainable in cognitive-science terms, document their direction
 * and magnitude rationale here, and let O5 re-fit them.
 *
 * The sigmoid combine:
 *   z = b0 + b1 * has_time_anchor
 *          + b2 * log(1 + corroboration_count)
 *          + b3 * entity_generality
 *          + b4 * |valence.magnitude|
 *   episodicity = 1 / (1 + exp(-z))
 *
 * v0 PRIOR direction + magnitude rationale:
 *   b0 = -1.5  (intercept — bias toward semantic when all features are
 *               neutral, because most facts in the corpus will be
 *               semi-generalizable; pure-episodic should be a positive
 *               departure from baseline, not the default).
 *
 *   b1 = +1.8  (time anchor is the STRONGEST episodic signal — Tulving
 *               1972 / Conway 2009 episodic-memory definitions all
 *               privilege "spatiotemporal context"; without time, a
 *               memory cannot be episodic; with time, it usually is).
 *
 *   b2 = -0.6  (more corroboration → more semantic, because the fact
 *               has been REPEATEDLY observed across contexts, which is
 *               the cognitive-science definition of semantic
 *               consolidation — Squire & Kandel 2009. The sign is
 *               negative; the log saturates the effect so even very
 *               highly-corroborated facts only shift z by ≈ -2.4 at
 *               count=50).
 *
 *   b3 = +0.5  (specific entities → episodic; generic entities → semantic.
 *               entity_generality = 1 - mean_specificity, so high
 *               generality means generic topics and the b3 term pulls
 *               UPWARD which would be inverted — see RESOLUTION BELOW).
 *
 *   b4 = +0.4  (high-magnitude affect → episodic memory — Cahill &
 *               McGaugh 1998 amygdala-modulated episodic encoding).
 *
 * RESOLUTION on b3 sign:
 *   The original spec text in F-SYN-FOUNDATION-episodicity-feature.json
 *   reads "entity_generality (1 - mean entity-specificity)" with b3=+0.5
 *   "(specific entities → episodic; generic entities → semantic)". That
 *   prose is INCONSISTENT with the formula: if generality = 1 - specificity,
 *   then high generality (= low specificity = topic-like) should push
 *   episodicity DOWN, so the sign on entity_generality is NEGATIVE, not
 *   positive. We FIX THIS HERE:
 *     b3 = -0.5     // negative on entity_generality
 *   Equivalent to b3' = +0.5 on entity_specificity (the original prose
 *   intent). The CAPS pin uses entity_generality as the named input;
 *   the b3 sign is negative; the cognitive prior matches the prose.
 *   This is recorded as an OPEN QUESTION § 8 Q1: confirm with O5
 *   calibration once labels exist.
 */
EPISODICITY_WEIGHTS_V1: Object.freeze({
  b0: -1.5,
  b1: +1.8,
  b2: -0.6,
  b3: -0.5,   // negated per resolution above; entity_generality high → semantic
  b4: +0.4,
}),

/**
 * Entity specificity-prior table. MIRRORED from entity-schema.md § 3.1.
 * The CI cross-check at entity-schema.md § I9 enforces equality with
 * the entity-schema mirror. Adding a kind that is not in this table
 * fails closed in mcp/lib/synthesis/episodicity-scorer.js (matches the
 * entity-schema.md § 3.1 discipline).
 *
 * Kind → specificity (∈ [0, 1]). entity_generality = 1 - mean(spec_of_each).
 */
ENTITY_SPECIFICITY_PRIORS: Object.freeze({
  event:    0.95,
  person:   0.90,
  place:    0.80,
  project:  0.70,
  org:      0.60,
  artifact: 0.50,
  topic:    0.10,
}),

/**
 * The v0 bootstrap weight for the episodicity_match multiplicative gate.
 * Operator dark-launch knob (per salience-design.md § R24.5): set to 0.0
 * to neutralize the channel without code change.
 *
 *   episodicity_match = 1 - |fact_ep - query_ep|        ∈ [0, 1]
 *   multiplicative_contribution = (1 - W) + W * episodicity_match
 *
 * where W = SCORE_WEIGHT_EPISODICITY_MATCH. At W=0 the contribution is
 * always 1.0 (channel inert). At W=1.0 the channel is fully active. The
 * recommended v0 ship value is 0.5 (half-active) per the review's
 * "ship dark with zero weight" mitigation, but the value MUST be
 * configurable without code change.
 *
 * INVARIANT: this knob does NOT change the structural shape of the
 * multi-feature score formula; the channel position is fixed by
 * research-retrieval-frontiers.md § Phase 3 v0.
 */
SCORE_WEIGHT_EPISODICITY_MATCH: 0.5,

/**
 * Minimum extractor_confidence for a time anchor to count as
 * "has_time_anchor=1". Below this threshold the anchor is treated as
 * absent (matches the time-anchor-schema.md gating predicate).
 */
EPISODICITY_TIME_ANCHOR_MIN_CONF: 0.5,

/**
 * Number of recent_turns the populator scans to construct query-side
 * has_time_anchor. v0: scan the most recent 4 turns. Any usable anchor
 * in any of them yields 1; otherwise 0.
 */
EPISODICITY_QUERY_RECENT_TURNS_SCAN: 4,
```

### 3.6 Telemetry schema — `episodicity_values[]`

Per-recall log row carries an array of per-candidate episodicity
snapshots; on the recall log row itself there is exactly one
`query_episodicity` entry. These flow into the recall-log split owned
by `F-SYN-FOUNDATION-recall-log-split`.

```ts
type EpisodicityTelemetryRow = {
  candidate_id: string;          // or "QUERY" for the query-side row
  side: "fact" | "query";
  score: number | null;
  components: {
    has_time_anchor: 0 | 1;
    log_corroboration_count: number;
    entity_generality: number | null;
    narrative_valence_magnitude: number;
  };
  fallbacks_applied: string[];
  episodicity_version: string;
  weights_hash: string;
};
```

The recall-log row's full schema is owned by
`F-SYN-FOUNDATION-recall-log-split`; this spec specifies only the
`episodicity_values[]` array shape and the single `query_episodicity`
field shape.

---

## 4. Module surface

### 4.1 Reference signature

```js
// File: mcp/lib/synthesis/episodicity-scorer.js
//
// AUTHORITATIVE spec: mcp/docs/specs/synthesis/episodicity-feature.md
//
// SINGLE pure function used on BOTH the cascade-stamp side AND the
// recall-time populator side. The "same function on both sides" is the
// load-bearing invariant — see § 7 I-EPI-1.

export const EPISODICITY_VERSION = 'v1';

/**
 * Compute the episodicity scalar over the four features.
 *
 * Pure function. No I/O, no clock reads, no global state beyond the
 * frozen CAPS reference.
 *
 * @param {EpisodicityInput} input
 * @returns {{score: number | null, meta: EpisodicityMeta}}
 *   .score is the bare scalar that will be persisted at
 *   `features.episodicity`; .meta is the sidecar persisted at
 *   `features.episodicity_meta`.
 */
export function computeEpisodicity(input);

/**
 * Helper used by the cascade-stamp side and the recall populator side
 * to compute `entity_generality` from the entity set. Pulled out so the
 * fallback rule (empty entities → entity_generality = null, masked from
 * the sigmoid) is identical on both sides.
 *
 * @param {Entity[]} entities
 * @returns {number | null}   1 - mean(specificity_prior[kind]) or null
 *                            when entities[] is empty / null.
 */
export function meanEntityGenerality(entities);

/**
 * Build the telemetry row for a single computation. Pure helper; no
 * side effects.
 *
 * @param {string} candidate_id     memory_id, or "QUERY" for the query
 *                                  side
 * @param {"fact" | "query"} side
 * @param {{score: number | null, meta: EpisodicityMeta}} value
 * @returns {EpisodicityTelemetryRow}
 */
export function episodicityTelemetry(candidate_id, side, value);
```

### 4.2 Cascade-stamp call site

`mcp/lib/ingest/salience.js` invokes `computeEpisodicity(input)` between
the embed step and the final fact append. The stamper MUST:

1. Resolve `has_time_anchor` from the fact's just-computed
   `features.time_anchors[]` per § 6.1 (b).
2. Set `corroboration_count = 0` (the fact is being written for the
   first time; no corroborations have been emitted against it yet).
3. Read `features.entities` and `features.valence` from the same
   fact-features block that just finished computing.
4. Set `kind = "fact"` (other kinds do not reach this code path —
   policy / recall / reconstructed are written elsewhere).
5. Call `computeEpisodicity(input)`.
6. Set `fact.features.episodicity = value.score` (the scalar that the
   W3 stratifier reads) AND `fact.features.episodicity_meta` to the
   sidecar (components, fallbacks_applied, episodicity_version,
   weights_hash) so the re-stamp pass and the replay harness retain the
   full trace.
7. Atomic-write the fact (embedding + entities + time_anchors + valence
   + episodicity + episodicity_meta together, or none).

### 4.3 Recall-time populator call site

`F-SYN-FOUNDATION-context-populator` invokes `computeEpisodicity(input)`
once per recall, constructing the input from `surrounding_context` per
§ 6.2 (the query-side translation table). It MUST:

1. Build the `EpisodicityInput` using only `surrounding_context` plus
   the entity-extractor + valence-scorer outputs over distilled query
   text (per `entity-schema.md § 7.6` and `valence-provenance.md § 6`).
2. Set `corroboration_count = 0` unconditionally at v0 (§ 6.6
   simplification).
3. Omit `kind` (query side does not have a row-kind).
4. Call `computeEpisodicity(input)`.
5. Set `surrounding_context.query_episodicity = value.score` (the
   scalar) AND optionally `surrounding_context.query_episodicity_meta`
   for telemetry / replay.
6. Pass the scalar through to the multi-feature scorer.

### 4.4 Multi-feature scorer consumption

`mcp/lib/recall/multi-feature-score.js`'s `computeScore` MUST:

1. For each surviving candidate, read `candidate.features.episodicity`.
   If `null` / `undefined` (non-fact kind, missing stamp, or fallback),
   use the **neutral score 0.5** for the match calculation. (Decision
   § 6.7.) This matches the W3 power-law-decay-contract `§ 4.3.1`
   read: `candidate.features.episodicity ?? 0.5`.
2. Read `surrounding_context.query_episodicity` (always populated; never
   null because the populator always emits one).
3. Compute `episodicity_match = 1 - |fact_ep - query_ep|` per § 6.4.
4. Apply via the multiplicative gate formula:
   `gate_contribution = (1 - W) + W * episodicity_match`
   where `W = CAPS.SCORE_WEIGHT_EPISODICITY_MATCH`. At W=0 contribution
   is 1.0 (inert); at W=1 it is `episodicity_match` (fully active).
5. Multiply into the gate factor alongside `predicate_mask`,
   `consent_dampener`, `derivation_status` per
   `research-retrieval-frontiers.md § Phase 3 v0`.

### 4.5 Re-stamp call site (O6 drift event)

`F-SYN-OPERATIONAL-drift-detection` triggers a re-stamp pass when ANY of:

- `EPISODICITY_VERSION` bumps (weight change OR sigmoid-shape change).
- `ENTITY_SPECIFICITY_PRIORS` mutates (table change).
- `ENTITY_EXTRACTOR_VERSION` bumps (entities change → entity_generality
  may shift).
- A `policy.corroboration` event lands targeting a fact whose
  `corroboration_count` was previously stamped (§ 6.5 the MAJOR review
  issue).

The re-stamp pass:

1. Reads the fact row from `ledgers/memory.jsonl`.
2. Re-derives the corroboration_count from the LIVE corroboration
   projection at re-stamp time.
3. Re-computes episodicity over the (possibly updated) entity set.
4. Emits a `policy.episodicity_re_stamp` event referencing the fact_id
   and carrying the new scalar AND the new `EpisodicityMeta` sidecar
   PLUS the diff against the previous one.
5. NEVER mutates the original fact row (append-only ledger invariant).
6. The projection at index-build time and the recall-time scorer JOIN
   the policy events against the fact rows; the most-recent
   `policy.episodicity_re_stamp` wins (matches the
   `entity-schema.md § 8.1` re-extraction projection pattern).

---

## 5. The four input features (definitions, valid ranges, derivations)

### 5.1 `has_time_anchor` — binary, 0 or 1

**Fact side.** `1` iff `fact.features.time_anchors[]` contains at least
one element satisfying ALL of:

- `kind ∈ {"absolute", "relative"}` (recurring is deferred per
  `time-anchor-schema.md` and contributes 0 here).
- `extractor_confidence ≥ CAPS.EPISODICITY_TIME_ANCHOR_MIN_CONF` (0.5
  v0).
- `recurrence_resolution_deferred !== true`.

Otherwise `0`. Empty or null `time_anchors[]` → `0`.

**Query side.** `1` iff ANY of:

- `surrounding_context.time_anchors` exists and contains a usable anchor
  per the fact-side rule, OR
- the populator's distillation of the most recent
  `CAPS.EPISODICITY_QUERY_RECENT_TURNS_SCAN` (4 v0) recent_turns yields
  at least one usable anchor when re-run through the time-anchor
  resolver.

Otherwise `0`.

### 5.2 `log(1 + corroboration_count)` — non-negative real

Read from the corroboration projection at the moment of computation.

- **Promote-time stamp:** always 0 → `log(1+0) = 0`.
- **Re-stamp (O6 drift):** live count from the projection at the
  re-stamp moment.
- **Query side:** 0 unconditionally at v0 (see § 6.6).

Saturation property: `log(1+50) ≈ 3.93`, `log(1+1000) ≈ 6.91`. With
`b2 = -0.6` the maximum negative contribution to z from this term is
roughly `-4.1` at 1000 corroborations — bounded so a single
ultra-corroborated outlier cannot dominate the sigmoid.

### 5.3 `entity_generality` — `[0, 1]` real or null

```
entity_generality = 1 - mean(spec)
```

where `spec` is the per-entity `CAPS.ENTITY_SPECIFICITY_PRIORS[kind]`
value (mirrored from `entity-schema.md § 3.1`).

**Empty / null entities.** The empty case (no entities stamped) is the
review's MINOR issue: under naive `mean()`, an empty array yields a
defined-but-arbitrary mean (0 or NaN), and either choice biases the
sigmoid (`mean=0 → generality=1 → strongly semantic` under the
positive-sign reading, or `mean=NaN → propagates NaN`).

Decision: empty entities → `entity_generality = null`. The null value
is **masked from the sigmoid** (the `b3 * entity_generality` term is
omitted entirely from `z`), NOT substituted with a neutral value. This
matches the time-anchor masking discipline in
`time-anchor-schema.md` and avoids the over-semantic bias the review
flagged. Telemetry records `fallback_reason:
"EMPTY_ENTITIES_GENERALITY_MASKED"`.

**Unknown kind.** If any `entity.kind` is not in
`CAPS.ENTITY_SPECIFICITY_PRIORS`, the computation fails closed
(matches `entity-schema.md § 3.1`): the scorer throws
`EPISODICITY_UNKNOWN_ENTITY_KIND` and the cascade write aborts (a fact
whose entities reference an unknown kind is a schema violation upstream
and MUST NOT be silently scored).

### 5.4 `narrative_valence_magnitude` — `[0, 1]` real

`= |valence.magnitude|` per `valence-provenance.md § S1`.

**Absent valence** (`valence.source === 'absent'`). The review's MINOR
issue: an absent valence implies `sign=0 AND magnitude=0` (per
valence-provenance.md storage invariants). Under direct substitution
`|0| = 0`, so the `b4 * 0` term contributes 0 to `z`.

Decision: keep the direct substitution. A row with no affect signal
neither pushes toward episodic nor away from it; the sigmoid intercept
`b0 = -1.5` already provides the semantic-leaning baseline. Telemetry
records `fallback_reason: "ABSENT_VALENCE_ZERO_MAGNITUDE"` so the
analyst can audit. This is **different** from the entity-generality
case (where null is masked) because magnitude already has a meaningful
zero — the entity case does not.

---

## 6. Decision rules

### 6.1 The sigmoid combine

```
z = b0
    + b1 * has_time_anchor
    + b2 * log(1 + corroboration_count)
    + b3 * (entity_generality ?? omitted)
    + b4 * narrative_valence_magnitude

episodicity = 1 / (1 + exp(-z))
```

Implementation note: when `entity_generality === null` the `b3` term is
DROPPED from `z` entirely (not zeroed — zeroing would still apply `b3 *
0 = 0`, which is mechanically identical here only because `b3 ≠ 0` is
a multiplication-by-known-zero; the mask reading is preserved for
clarity and audit). The implementation is mechanically equivalent to
treating absent generality as `0.5 - b0/b3 - ...` adjusted, but the
spec discipline is "mask", not "substitute-neutral", to match the
broader time-anchor masking pattern.

### 6.2 Query-side input construction (the recall-time twin)

The query-side `EpisodicityInput` is built from `surrounding_context`
by the F-SYN-FOUNDATION-context-populator following this table:

| Field | Query-side derivation |
|---|---|
| `has_time_anchor` | per § 5.1 query-side rule (scan anchors in `surrounding_context.time_anchor` AND most recent N recent_turns) |
| `corroboration_count` | **0** unconditionally at v0 (§ 6.6 simplification) |
| `entities` | union of: entities extracted from `current_query`; entities extracted from most recent `CAPS.EPISODICITY_QUERY_RECENT_TURNS_SCAN` turns; `ambient.parties_present` (mapped to `kind="person"` synthetic entities). Re-uses entity-schema.md § 7.1 extractor. |
| `valence` | `surrounding_context.ambient.inferred_mood` directly (already a ValenceValue per valence-provenance.md § S3) |
| `kind` | omitted (query has no row-kind) |

The populator MUST construct this input deterministically — given
identical `surrounding_context`, the same `EpisodicityInput` is built
across runs (so the replay harness can reproduce
`query_episodicity` byte-for-byte; matches the recall-log replay
discipline).

### 6.3 Fallback rules — complete table

| Input state | Decision | `fallbacks_applied` entry |
|---|---|---|
| `time_anchors[]` empty / null | `has_time_anchor = 0` | (none) |
| `time_anchors[]` has only recurring / low-confidence | `has_time_anchor = 0` | (none) |
| `corroboration_count` negative / non-integer | coerce to 0 | `BAD_CORROBORATION` |
| `corroboration_count` not provided | substitute 0 (promote-time default) | `PROMOTE_TIME_CORROBORATION_ZERO` (only on the promote-time fact-side path; recall-side never records this) |
| `entities[]` empty / null | mask b3 term | `EMPTY_ENTITIES_GENERALITY_MASKED` |
| `entities[i].kind` unknown | throw `EPISODICITY_UNKNOWN_ENTITY_KIND` | (fail closed — no row emitted) |
| `valence` `source === 'absent'` | substitute magnitude = 0 | `ABSENT_VALENCE_ZERO_MAGNITUDE` |
| `valence` missing entirely (legacy row, pre-spec) | substitute magnitude = 0 | `LEGACY_VALENCE_MISSING` |
| Non-fact kind (cascade side) | return `score = null` | `NON_FACT_KIND` |
| Sigmoid overflow (z > 700 or < -700) | clamp to 1.0 / 0.0 respectively | `SIGMOID_CLAMP` |

### 6.4 The match-score formula

```
function episodicityMatch(fact_ep, query_ep):
  if fact_ep === null:
    fact_ep = 0.5             // neutral for non-fact / fallback
  // query_ep is never null by populator invariant
  return 1 - abs(fact_ep - query_ep)
```

The match score is in `[0, 1]`:
- `1.0` when the two episodicities are identical (perfect match).
- `0.0` when they are at opposite ends (0 vs 1).
- The match is symmetric around the diagonal — it does not prefer
  episodic OR semantic; it prefers SAME quartile.

This addresses the v2 success criterion (§ 2.3): stratification by
query-episodicity quartile yields same-quartile preference because the
match score is highest when `fact_ep ≈ query_ep`.

**The review's open question Q3 (cross-quartile recall).** "Sometimes
you want a semantic fact in an episodic context." The match score
PENALIZES cross-quartile recall. v0 mitigates this via the
multiplicative gate formula:

```
gate_contribution = (1 - W) + W * episodicity_match
```

At `W = 0.5` (v0 ship), the worst-case cross-quartile penalty is `0.5`
(when `episodicity_match = 0`). The candidate is not eliminated — it
just receives half-strength gate weight from this channel. The other
multiplicative gates (predicate_mask, consent_dampener, derivation_status)
and the additive soft features (entity_overlap, time_anchor_match,
decay, valence_compat, engagement_prior) still let a strong cross-quartile
candidate win. v2 may swap in a learned `W` per query type.

### 6.5 The corroboration-drift hazard (review_step MAJOR)

The review_step MAJOR issue: a fact stamped at promote time with
`corroboration_count = 0` will drift from the LIVE projection as
corroboration events land. The stored `features.episodicity` scalar
becomes stale.

Resolution: **the stored value is a stratification cache, not a truth
claim**. Two mechanisms keep the channel honest:

1. **O6 re-stamp on corroboration landing** (§ 4.5). Every
   `policy.corroboration` event that targets a fact triggers a re-stamp
   pass that emits a `policy.episodicity_re_stamp` event. The fact row
   itself stays immutable (append-only invariant). The projection at
   index-build time applies the most-recent re-stamp.
   - Cost: O(1) per corroboration event, batched per O6 drift tick.
2. **Recall-side `query_episodicity` is always fresh.** The match score
   uses (cached fact_ep) vs (fresh query_ep). The query side is
   recomputed every recall, so the multiplicative gate adapts to query
   context drift even without re-stamping the fact.

This split — stamp the fact (cached for W3 stratification + first-pass
match), re-stamp on drift events (O6), live-compute the query — resolves
the review's hazard. The fact's `features.episodicity` scalar is treated
as the W3 stratification input AND the match-score input; both consumers
get the most-recent re-stamp via the policy-event projection.

**Why not pure recall-time computation?** The W3
`power-law-decay-contract.md § 4.3` reads
`candidate.features.episodicity` as a `[0, 1]` scalar AT the
multi-feature scorer call site. Re-walking the corroboration projection
per candidate per recall is O(N) per fact and is not the right cost
profile for the recall hot path. The O6 re-stamp is the right cost
profile: cost amortized per corroboration event, not per recall.

### 6.6 Query-side `corroboration_count` simplification (v0)

The query has no corroboration history. Two design options were on the
table:

| Option | Behavior | Trade-off |
|---|---|---|
| **A. Always 0 (v0 ship)** | Query-side always treats this term as 0; the channel relies on `has_time_anchor`, `entity_generality`, `narrative_valence_magnitude` for query characterization. | Loses fidelity (queries that ARE about highly-corroborated subjects look as episodic as queries about one-off events); recovered by reading entity_generality and time anchors. |
| **B. Mean over top-K candidate corroborations** | Look up the candidates the query's entities anchor to, average their corroboration_count, use as query input. | Couples query-episodicity to the candidate set, which couples recall to its own scoring — circular and slow. |

**Decision: ship A at v0**, defer B to v2. The query-side computation
must remain fast (O(1) given a constructed input) and self-contained.
This makes query_episodicity slightly biased toward episodic
(corroboration is the strongest semantic pull, and we are removing it
on the query side), but the `b0 = -1.5` intercept absorbs most of that
bias, and the match score is symmetric in the two values so the
calibration concern is mostly a quartile-shift issue that O5
recalibration can fix.

### 6.7 Non-fact kinds

`policy`, `recall`, `reconstructed` rows DO NOT carry
`features.episodicity` or `features.episodicity_meta`. The CAPS table
is keyed only on `kind === "fact"` for the cascade-stamp path. The
multi-feature scorer reads `candidate.features?.episodicity ?? null`
and substitutes the neutral `0.5` when null/missing — non-fact
candidates receive a neutral contribution from the episodicity channel
rather than being silently eliminated. This is the same null-substitution
shape the W3 power-law-decay-contract uses at `§ 4.3.1`
(`candidate.features.episodicity ?? 0.5`).

This matches the W3 contract's `kind="fact"`-only stratification rule
(`power-law-decay-contract.md § 4.3.1`: `if kind != "fact": return
base_f`); the two contracts agree that episodicity is a fact-only
feature.

**Reconstructed events deserve special mention.** A reconstructed event
is the agent's recall-time summarization (per `architecture.md § 4`).
Its `derived_from[]` may point at multiple parent facts with varying
episodicities. The Open Question § 8 Q4 asks whether reconstructed
should inherit a derived episodicity (mean over parents? max? min?).
v0 ships **no inheritance**: reconstructed rows have no
`features.episodicity` scalar and receive the neutral 0.5 substitution
at match time. v1 may add inheritance.

### 6.8 Re-computation policy (extractor-version bumps)

When `ENTITY_EXTRACTOR_VERSION` bumps:

1. The replay-entity-extraction script
   (`mcp/scripts/replay-entity-extraction.mjs`) re-runs entity
   extraction over the ledger, emitting `policy.entity_re_extraction`
   events (per `entity-schema.md § 8.1`).
2. The drift detector (`F-SYN-OPERATIONAL-drift-detection`) observes
   the entity re-extraction events and schedules an O6 re-stamp pass
   on the affected facts.
3. The re-stamp reads the now-current entity set (via the
   `policy.entity_re_extraction` projection) and re-runs
   `computeEpisodicity`.
4. Emits `policy.episodicity_re_stamp` events.

When `EPISODICITY_VERSION` bumps (weight or sigmoid-shape change):

1. The drift detector observes the version bump (CAPS hash mismatch
   between current and last-recorded).
2. O6 schedules a full-corpus re-stamp pass.
3. The replay-harness asserts that re-stamping under the new version
   produces byte-identical output to running `computeEpisodicity` at
   the new CAPS — this is the determinism invariant property test.

The cost of a full re-stamp pass is one read per fact + one
`computeEpisodicity` call + one append per stamp. At 10⁵ facts the
pass takes seconds; at 10⁷ facts the pass takes a few minutes. The pass
is O6-scheduled, not a recall-time concern.

---

## 7. Worked examples

The user's real data shapes drive these. The `surrounding_context`
and fact shapes match `operations.md § Inputs` and `architecture.md §
Memory ledger`.

### 7.1 Example: a clean episodic event (meeting with a specific person)

```js
// Promote-time fact: "Robin said the Q3 review went well" from iMessage.
const input = {
  has_time_anchor: 1,           // "Q3 review" resolves to an absolute anchor
  corroboration_count: 0,
  entities: [
    {kind: "person",  canonical_id: "person:imessage:robin_lastname",  ...},
    {kind: "event",   canonical_id: "event:imessage:q3_review",          ...},
    {kind: "project", canonical_id: "project:imessage:garden_fund", ...},
  ],
  valence: {sign: +1, magnitude: 0.6, source: "lexicon", extractor_version: "lexicon-v1"},
  kind: "fact",
};

// entity_generality = 1 - mean(0.90, 0.95, 0.70)
//                   = 1 - 0.85
//                   = 0.15  (very specific entities)
// |valence.magnitude| = 0.6
// log(1+0) = 0
// z = -1.5 + 1.8*1 + (-0.6)*0 + (-0.5)*0.15 + 0.4*0.6
//   = -1.5 + 1.8 + 0 - 0.075 + 0.24
//   = 0.465
// episodicity = 1 / (1 + e^(-0.465))
//             ≈ 0.614

const value = computeEpisodicity(input);
// value.score ≈ 0.614   (mildly episodic)
// value.components = {has_time_anchor: 1, log_corroboration_count: 0,
//                     entity_generality: 0.15, narrative_valence_magnitude: 0.6}
// value.fallbacks_applied = []   (clean compute)
```

### 7.2 Example: a clean semantic fact (general principle, no anchor)

```js
// Promote-time fact: "Power-law decay beats exponential at individual
// subject level (Wixted & Ebbesen 1997)" from a research note.
const input = {
  has_time_anchor: 0,           // no extractable anchor
  corroboration_count: 0,       // first promote
  entities: [
    {kind: "topic",    canonical_id: "topic:manual:power_law_decay",   ...},
    {kind: "topic",    canonical_id: "topic:manual:forgetting_curves", ...},
    {kind: "artifact", canonical_id: "artifact:manual:wixted_ebbesen_1997", ...},
  ],
  valence: {sign: 0, magnitude: 0, source: "absent", extractor_version: "lexicon-v1"},
  kind: "fact",
};

// entity_generality = 1 - mean(0.10, 0.10, 0.50)
//                   = 1 - 0.233
//                   = 0.767   (highly generic — topic-heavy)
// |valence.magnitude| = 0 (absent → magnitude=0)
// log(1+0) = 0
// z = -1.5 + 1.8*0 + (-0.6)*0 + (-0.5)*0.767 + 0.4*0
//   = -1.5 + 0 + 0 - 0.384 + 0
//   = -1.884
// episodicity = 1 / (1 + e^(1.884))
//             ≈ 0.132

const value = computeEpisodicity(input);
// value.score ≈ 0.132   (strongly semantic)
// value.fallbacks_applied = ["ABSENT_VALENCE_ZERO_MAGNITUDE"]
```

### 7.3 Example: a fact that drifts from episodic to semantic over time

This is the worked-out form of the review_step's MAJOR issue: a memory
acquires corroborations and the stored episodicity needs to update.

```js
// Day 0 promote: "I prefer the Wixted decay over MemoryBank exponential"
// First articulation; no corroboration; specific topic but with
// time-anchored "today I read".
const input_day_0 = {
  has_time_anchor: 1,
  corroboration_count: 0,
  entities: [
    {kind: "topic",    canonical_id: "topic:chat-claude-code:wixted_vs_memorybank", ...},
    {kind: "artifact", canonical_id: "artifact:chat-claude-code:research_retrieval_frontiers_md", ...},
  ],
  valence: {sign: +1, magnitude: 0.3, source: "lexicon", extractor_version: "lexicon-v1"},
  kind: "fact",
};
// z_0 = -1.5 + 1.8 + 0 + (-0.5)*(1 - 0.30) + 0.4*0.3
//     = -1.5 + 1.8 + 0 - 0.35 + 0.12 = 0.07
// episodicity_0 ≈ 0.518   (just above neutral, mildly episodic)

// Day 30: 5 corroboration events have landed (the user re-asserted
// the preference in 5 different chats).
const input_day_30 = {
  has_time_anchor: 1,
  corroboration_count: 5,
  entities: [...same as day 0...],
  valence: {sign: +1, magnitude: 0.3, source: "lexicon", extractor_version: "lexicon-v1"},
  kind: "fact",
};
// z_30 = -1.5 + 1.8 + (-0.6)*log(6) + (-0.35) + 0.12
//      = -1.5 + 1.8 + (-1.075) + (-0.35) + 0.12
//      = -1.005
// episodicity_30 ≈ 0.268   (now leaning semantic — corroborated belief)

// The O6 re-stamp pass emits a policy.episodicity_re_stamp event on the
// fact, carrying value_30. The fact row itself is unchanged. The
// projection at index-build time picks up the new value.
//
// At recall time, the W3 decay channel reads the LIVE value (0.268, not
// 0.518), and the multi-feature scorer's episodicity_match channel
// reads the same. The drift is captured exactly where it should be.
```

### 7.4 Example: query-side computation + match-score (same-quartile bias)

```js
// Recall context: the user asks "what was Robin's take on Q3?".
const surrounding_context = {
  current_query: "what was Robin's take on Q3?",
  recent_turns: [
    {role: "user",      content: "let me check the Q3 review notes"},
    {role: "assistant", content: "I have the Q3 retro from June."},
  ],
  agent_role: "memory-recall",
  time: "2026-06-18T14:00:00Z",
  time_anchors: [{kind:"absolute", parsed:{iso:"2026-06-30T00:00:00Z"}, ...}],
  ambient: {
    calendar_state: null,
    inferred_mood: {sign:0, magnitude:0, source:"absent", extractor_version:"lexicon-v1"},
    parties_present: [],
  },
  recent_recall_ids: [],
};

// Populator-built query input:
const query_input = {
  has_time_anchor: 1,           // "Q3" parses to an absolute anchor
  corroboration_count: 0,       // v0 simplification
  entities: [
    {kind: "person",  canonical_id: "person:chat-claude-code:robin_lastname", ...},
    {kind: "event",   canonical_id: "event:chat-claude-code:q3_review",        ...},
  ],
  valence: {sign:0, magnitude:0, source:"absent", extractor_version:"lexicon-v1"},
};
// entity_generality = 1 - mean(0.90, 0.95) = 1 - 0.925 = 0.075
// z = -1.5 + 1.8 + 0 + (-0.5)*0.075 + 0 = 0.2625
// query_episodicity ≈ 0.565   (mildly episodic)

// Three candidate facts surface:
//   Candidate A: the day-0 Robin-meeting fact from 7.1 — episodicity 0.614
//   Candidate B: the day-30 corroborated-preference fact from 7.3 — episodicity 0.268
//   Candidate C: a semantic principle about Q3 retros — episodicity 0.13

// episodicity_match scores:
//   match_A = 1 - |0.614 - 0.565| = 0.951    ← preferred (same quartile)
//   match_B = 1 - |0.268 - 0.565| = 0.703
//   match_C = 1 - |0.130 - 0.565| = 0.565

// Multiplicative gate contribution (W = 0.5):
//   gate_A = (1 - 0.5) + 0.5 * 0.951 = 0.976
//   gate_B = (1 - 0.5) + 0.5 * 0.703 = 0.851
//   gate_C = (1 - 0.5) + 0.5 * 0.565 = 0.782

// Candidate A's score is multiplied by 0.976, B's by 0.851, C's by 0.782.
// The episodic-leaning query preferentially gates IN candidate A (the
// matching-quartile event) while still letting B and C through at
// reduced gate weight. The multi-feature score's other channels
// (entity_overlap, time_anchor_match, embedding cosine) decide the
// final ranking; episodicity_match is the SAME-QUARTILE SOFT GATE.
```

### 7.5 Example: legacy fact (no episodicity stamped pre-spec)

```js
// A fact written before this spec landed. features.episodicity
// is undefined.
const candidate = {
  memory_id: "evt_01H1...",
  kind: "fact",
  ts: "2026-04-01T00:00:00.000Z",
  features: {
    embedding: [...],
    embedding_model_version: "gemini-embedding-001",
    entities: [...],
    time_anchors: [...],
    valence: {...},
    // episodicity: undefined — pre-spec
    // episodicity_meta: undefined — pre-spec
  },
};

// At recall time the multi-feature scorer reads:
const fact_ep = candidate.features?.episodicity ?? null;
// fact_ep === null  →  substituted with neutral 0.5 in the match calc.
//
// The neutral substitution means legacy facts receive the average
// match-score with any query, neither penalized nor preferred. The O6
// drift-detection pass identifies missing-stamp facts and schedules
// re-stamp; once re-stamped the fact has a real score.
```

### 7.6 Example: edge — unknown entity kind fails closed

```js
const input_bad = {
  has_time_anchor: 0,
  corroboration_count: 0,
  entities: [
    {kind: "ALIEN", canonical_id: "ALIEN:imessage:something", ...},
  ],
  valence: {sign:0, magnitude:0, source:"absent", extractor_version:"lexicon-v1"},
  kind: "fact",
};

// computeEpisodicity throws EPISODICITY_UNKNOWN_ENTITY_KIND.
// The cascade-stamp call site catches the throw and aborts the fact
// write (the embedding/entities/time_anchors/valence/episodicity
// atomic write fails closed).
//
// This is the schema-violation surface: an upstream entity-extractor
// bug emitted an entity with an unknown kind, the salience cascade
// did not catch it, and the episodicity scorer is the last gate. The
// throw surfaces the bug into the salience cascade error path
// (matches entity-schema.md § 3.1 fail-closed discipline).
```

### 7.7 Example: deterministic replay

```js
// The replay harness (mcp/scripts/replay-salience.mjs) reads a recall
// log row and reconstructs the original computation.
const a = computeEpisodicity({
  has_time_anchor: 1,
  corroboration_count: 3,
  entities: [
    {kind:"person", ...},
    {kind:"project", ...},
  ],
  valence: {sign:+1, magnitude:0.5, source:"lexicon", extractor_version:"lexicon-v1"},
  kind: "fact",
});
const b = computeEpisodicity({...same input...});
assert(a.score === b.score);
assert(a.weights_hash === b.weights_hash);
assert(a.episodicity_version === b.episodicity_version);
```

---

## 8. Open questions (carry forward as wave-N tasks)

The following questions remain open at v0 ship. Each is marked with its
materiality (MATERIAL = carry forward as a hypergraph task; MINOR =
documented but not blocking).

1. **(MATERIAL) Sign on b3 — entity_generality vs entity_specificity.**
   The original JSON predicate text said "specific entities → episodic;
   generic entities → semantic" with `b3=+0.5` on entity_generality.
   That is internally inconsistent; this spec resolves to `b3=-0.5` on
   entity_generality (equivalent to `b3'=+0.5` on entity_specificity).
   O5 calibration on the held-out label set MUST confirm the sign
   empirically — if the labels suggest the original direction (positive
   on generality), bump `EPISODICITY_VERSION` and re-stamp. This is
   the most likely v0 weight to flip post-calibration.

2. **(MATERIAL) Query-side `corroboration_count`.** v0 ships
   unconditionally 0. v2 may swap in mean-over-candidate-corroborations
   if the offline eval shows query characterization is too episodic-biased.
   See § 6.6 trade-off table.

3. **(MATERIAL) Cross-quartile recall bias.** The match-score formula
   `1 - |fact - query|` penalizes cross-quartile candidates. v0
   mitigates via the multiplicative gate's `(1-W) + W*match`
   half-active formulation. v2 may add a query-type-specific `W` (e.g.
   `W=0` when the query is asking about a one-off in a semantic context,
   so the channel is inert; `W=1` when the query is asking about the
   same characteristic kind, so the channel is fully active). The
   research output's F5 also flags this.

4. **(MINOR) Reconstructed-event inheritance.** Should
   `kind="reconstructed"` rows inherit episodicity from their parents?
   v0: no (no stamp). v1 option: `episodicity_inherited =
   mean(parent.features.episodicity for parent in derived_from)`,
   stamped on the reconstructed row's features. Would let the W3 decay
   channel stratify reconstructed rows. Deferred.

5. **(MINOR) Hand-tuned vs all-zero shipping.** Per
   `salience-design.md § R24.5`, ship with `SCORE_WEIGHT_EPISODICITY_MATCH
   = 0.0` if the v0 weights prove anti-helpful. v0 ships at 0.5
   (half-active) as the middle ground. The user can flip the knob
   in `mcp/lib/validation.js` without a code change.

6. **(MINOR) Migration path under weight changes.** v0 ships
   `EPISODICITY_VERSION='v1'`. O5 calibration produces a new weight
   set → `EPISODICITY_VERSION='v2'`. The transition:
   - Stamp new facts at v2 immediately.
   - O6 schedules a full-corpus re-stamp pass.
   - The recall-log replay harness refuses to replay if the version
     differs from the stamped version — analyst chooses to either
     re-derive at the new version (re-running `computeEpisodicity` on
     the recorded input) or roll back the CAPS.
   - During the transition window (~minutes for a 10⁵-fact corpus) the
     stamped vs live values may differ; the recall-log telemetry
     records both and the projection wins.

7. **(MINOR) Sigmoid alternatives.** v0 uses the standard sigmoid `1 /
   (1 + e^-z)`. The research output considered tanh-rescaled and
   piecewise-linear; the sigmoid was chosen for monotonicity + analytic
   gradient + match with the cognitive-science intuition (saturation at
   both ends). v2 may revisit if the offline eval shows midrange
   over-density.

8. **(MINOR) Query-side multi-turn fan-out.** When the populator scans
   `CAPS.EPISODICITY_QUERY_RECENT_TURNS_SCAN` turns (4 v0) and finds
   different episodicities in different turns, the current spec
   aggregates by union (entities from all turns merged, anchors from
   any turn yield 1). The review_step's open-question Q2 asks if
   weighted (last-turn-most-recent) or max would be better. v0: union
   is simplest, calibration may demote.

---

## 9. Invariants

The following invariants MUST hold across every implementation, language
port, or version bump that claims contract conformance. Each invariant
names the property test that enforces it.

### I-EPI-1 — Single pure function, both sides

The cascade-stamp side AND the recall-time populator side MUST call the
SAME exported `computeEpisodicity` function from
`mcp/lib/synthesis/episodicity-scorer.js`. CI grep test: no other
source file in `mcp/lib/synthesis/`, `mcp/lib/ingest/`, or
`mcp/lib/recall/` defines a function whose name contains `episodicity`
and that performs a sigmoid combine.

### I-EPI-2 — Deterministic across replay

For fixed inputs and fixed CAPS, `computeEpisodicity` MUST be
bit-identical across runs. Property-tested by the replay harness:
replaying a recall log row MUST yield byte-identical
`query_episodicity` and `episodicity_values[]` to the original recall.

### I-EPI-3 — No clock side-effects

The function MUST NOT call `Date.now()`, `new Date()` (without an
argument), `performance.now()`, or any equivalent wall-clock primitive.
The function is a pure combination of inputs.

### I-EPI-4 — Range bound

For all valid inputs the output `score` MUST satisfy `0 ≤ score ≤ 1`
OR be exactly `null` (non-fact / fallback). Linted by the scorer's
output validation (no extra clamp needed since the sigmoid guarantees
the `[0, 1]` range for finite `z`).

### I-EPI-5 — Monotonicity in each feature

For fixed other inputs and fixed CAPS:

- Increasing `has_time_anchor` from 0 to 1 MUST raise (or keep equal)
  the score (because `b1 > 0`).
- Increasing `corroboration_count` MUST lower the score (because
  `b2 < 0`).
- Increasing `entity_generality` (more generic entities) MUST lower the
  score (because `b3 < 0` post-resolution § 8 Q1).
- Increasing `narrative_valence_magnitude` MUST raise the score
  (because `b4 > 0`).

Property-tested.

### I-EPI-6 — Same-feature symmetry of match

`episodicityMatch(a, b) === episodicityMatch(b, a)` for all valid `a`,
`b`. Property-tested.

### I-EPI-7 — Match range

`episodicityMatch(a, b) ∈ [0, 1]` for all valid inputs. Maximum 1.0 iff
`a === b`. Property-tested.

### I-EPI-8 — Null-fact neutral substitution

When `fact_ep === null` (non-fact kind or fallback), the multi-feature
scorer MUST substitute `0.5` for the match calculation, NOT eliminate
the candidate. CI test in
`mcp/test/recall/multi-feature-score-episodicity.test.mjs`.

### I-EPI-9 — Query-side never null

The populator MUST emit a non-null `query_episodicity` scalar on every
recall. Fallback rules guarantee a value exists even when the entity
extractor, valence scorer, or time-anchor extractor are degraded. CI
test asserts no recall row has `query_episodicity === null`.

### I-EPI-10 — CAPS-table closure

`CAPS.EPISODICITY_WEIGHTS_V1` and `CAPS.ENTITY_SPECIFICITY_PRIORS` MUST
be `Object.freeze`d at module load. Runtime mutation MUST fail
(silently in non-strict, loudly in strict mode). The only legitimate
path to change weights is editing `mcp/lib/validation.js` and bumping
`EPISODICITY_VERSION`.

### I-EPI-11 — Version-bump audit

Any change to `EPISODICITY_WEIGHTS_V1`, `ENTITY_SPECIFICITY_PRIORS`,
or the sigmoid shape MUST bump `EPISODICITY_VERSION` and emit one
`policy.drift` event into `policy-events-YYYY-MM.jsonl`. The replay harness
reads the recorded version off the recall log row and refuses to
replay if the version mismatches.

### I-EPI-12 — Dark-launch zero

Setting `CAPS.SCORE_WEIGHT_EPISODICITY_MATCH = 0.0` MUST silently zero
out the match channel's contribution (multiplicative gate becomes 1.0)
without any code change. The `computeEpisodicity` function continues
to compute and stamp; only the wired weight becomes zero. Matches the
`salience-design.md § R24.5` graft pattern.

### I-EPI-13 — Telemetry coverage

For every fact-side computation, exactly one row MUST be emitted into
`recall.episodicity_values[]` per scored candidate. For every recall,
exactly one `query_episodicity` row MUST be emitted. Candidates
dropped by the multiplicative hard gates (predicate-excluded,
consent-blocked) do not get episodicity telemetry rows from this
channel — they were never scored against the match function.

### I-EPI-14 — Entity-schema kind closure

The keys of `CAPS.ENTITY_SPECIFICITY_PRIORS` MUST equal the entries
in `entity-schema.md § 3.1` (the mirror table). CI cross-check at
`entity-schema.md § I9` enforces this. An entity whose kind is not in
the table fails closed (§ 5.3 `EPISODICITY_UNKNOWN_ENTITY_KIND` throw).

### I-EPI-15 — Cascade atomicity

The fact append at promote time MUST write `features.episodicity` AND
`features.episodicity_meta` atomically with `features.embedding`,
`features.entities`, `features.time_anchors`, `features.valence`.
Partial-write states ("fact with embedding but no episodicity") MUST
be impossible.

### I-EPI-16 — Fact-only stamping

The `features.episodicity` and `features.episodicity_meta` fields MUST
NOT appear on `kind ∈ {policy, recall, reconstructed}` rows in the
ledger. CI grep test asserts absence on non-fact rows.

### I-EPI-17 — Re-stamp uses policy events, not row mutation

The O6 re-stamp pass MUST emit `policy.episodicity_re_stamp` events
into `policy-events-YYYY-MM.jsonl`; it MUST NOT mutate the original fact row's
`features.episodicity` or `features.episodicity_meta`. The projection
joins the policy events at index-build time. Matches the
`entity-schema.md § 8.1` re-extraction discipline AND
`valence-provenance.md` re-stamp discipline.

### I-EPI-18 — Match-score formula closure

The multi-feature score's `episodicity_match` formula MUST be
`1 - |fact_ep - query_ep|`. CI test at
`mcp/test/recall/multi-feature-score-episodicity.test.mjs` asserts the
formula by spot-checking against the worked examples in § 7.

### I-EPI-19 — Multiplicative-gate placement

The `episodicity_match` term MUST enter the multi-feature score on the
**multiplicative** side, NOT the additive side. CI grep test on
`mcp/lib/recall/multi-feature-score.js` asserts `episodicity_match`
is referenced only inside the multiplicative-gate calculation, never
inside the additive-soft-feature sum.

### I-EPI-20 — Same-quartile preference

For fixed candidate set, increasing the absolute difference
`|fact_ep - query_ep|` MUST monotonically decrease the channel's gate
contribution. Property-tested.

---

## 10. Cross-tier impact

This foundation contract constrains the following downstream tier
nodes. The constraints are stated as "wires" — what each node MUST do
to satisfy this contract.

### 10.1 `F-SYN-SUBSTRATE-EPISODICITY-SCORER` (substrate tier)

Implements `mcp/lib/synthesis/episodicity-scorer.js` per §4.

- Exports `computeEpisodicity`, `meanEntityGenerality`,
  `episodicityTelemetry`.
- Pure-functional; no I/O, no clock reads, no global state.
- Property-tested against the invariants in § 9.
- Tests at `mcp/test/synthesis/episodicity-scorer.test.mjs`:
  worked examples § 7.1–7.7 pass byte-identically.
- CI cross-check: `EPISODICITY_WEIGHTS_V1` is `Object.freeze`d at
  module load.

### 10.2 `F-SYN-INTEGRATION-CASCADE-STAMPS-EPISODICITY` (integration tier)

Wires § 4.2 into `mcp/lib/ingest/salience.js`.

- Calls `computeEpisodicity` between embed step and atomic append.
- Sets `fact.features.episodicity` to the scalar AND
  `fact.features.episodicity_meta` to the sidecar.
- Atomic write per I-EPI-15.
- Tests at `mcp/test/ingest/salience-episodicity.test.mjs`.

### 10.3 `F-SYN-INTEGRATION-MULTI-FEATURE-SCORE-WIRING` (integration tier)

Wires the match-score formula and the multiplicative-gate consumption.

- Reads `candidate.features?.episodicity ?? null`, substituting `0.5`
  when null per I-EPI-8.
- Reads `surrounding_context.query_episodicity` (scalar).
- Computes `episodicity_match = 1 - |fact_ep - query_ep|`.
- Applies via `gate_contribution = (1 - W) + W * episodicity_match`
  where `W = CAPS.SCORE_WEIGHT_EPISODICITY_MATCH`.
- Multiplies into the gate factor alongside `predicate_mask`,
  `consent_dampener`, `derivation_status`.
- Tests at `mcp/test/recall/multi-feature-score-episodicity.test.mjs`.

### 10.4 `F-SYN-FOUNDATION-context-populator` (foundation tier)

Builds the query-side `EpisodicityInput` per § 6.2.

- Re-uses entity-extractor (`entity-schema.md § 7.1`) for entity union.
- Re-uses valence-scorer (`valence-provenance.md § 6`) for inferred_mood.
- Re-uses time-anchor resolver (`time-anchor-schema.md`) for query-side
  `has_time_anchor`.
- Always emits a non-null `query_episodicity` scalar per I-EPI-9.

### 10.5 `F-SYN-FOUNDATION-power-law-decay-contract` (foundation tier, sibling)

Consumes `features.episodicity` directly as the `eps` input to the
decay stratification rule.

- The W3 contract's `delta_eps` term (`power-law-decay-contract.md §
  4.3.1`) reads `candidate.features.episodicity ?? 0.5`.
- The `0.5` neutral fallback is consistent across both contracts.
- CI cross-check: the substring `features.episodicity` (the bare
  scalar field path) appears in both
  `mcp/lib/recall/multi-feature-score.js` (this spec) and the W3 helper
  (`power-law-decay-contract.md`). Post-W5 rename the two specs agree
  on the field path; the W4 review's spawn finding is resolved.

### 10.6 `F-SYN-OPERATIONAL-drift-detection` (operational tier)

Schedules O6 re-stamp passes.

- On `EPISODICITY_VERSION` bump → full-corpus re-stamp.
- On `policy.corroboration` event landing → per-fact re-stamp.
- On `policy.entity_re_extraction` event landing → re-stamp facts
  whose entities changed.
- Each re-stamp emits `policy.episodicity_re_stamp` events per § 4.5.

### 10.7 `F-SYN-OPERATIONAL-offline-eval-harness` and
`F-SYN-OPERATIONAL-held-out-labeled-set-v2` (operational tier)

Re-fit the v0 hand-tuned weights once enough labels accumulate.

- Stratified Recall@12 by `query_episodicity` quartile is the success
  criterion (per § 2.3).
- The re-fit produces a new `EPISODICITY_WEIGHTS_V2`; the version bumps
  to `v2`; O6 schedules full-corpus re-stamp.
- The eval harness MUST be able to re-run `computeEpisodicity` over
  recorded inputs with arbitrary weight sets (the function is pure, so
  this is straightforward — but the harness MUST own its own CAPS
  reference, not the prod one, to avoid cross-contamination).

### 10.8 `F-SYN-INTEGRATION-RECALL-CONSUMES-VALENCE` and sibling
RECALL-CONSUMES-* nodes

These nodes own the recall-side reads of valence, time anchors, and
entities. They MUST pass through the values to the populator (§ 10.4),
which builds the query-side `EpisodicityInput`. They do NOT need to
know about episodicity directly; the dependency is on the populator.

### 10.9 `mcp/lib/validation.js § CAPS`

Adds the constants in § 3.5.

The spec does NOT constrain:

- The W1 / W2 score weights (other than `SCORE_WEIGHT_EPISODICITY_MATCH`).
- The reranker (Layer 3) — episodicity is a Layer-2 multi-feature
  score channel only.
- The MMR diversification (Layer 4).
- The corroboration projection's internal representation (this spec
  reads its output, not its data).

---

## 11. Implementation checklist (for the future substrate-tier task)

A future implementer building `mcp/lib/synthesis/episodicity-scorer.js`
should:

- [ ] Add the CAPS constants from § 3.5 to `mcp/lib/validation.js`.
- [ ] Write `mcp/lib/synthesis/episodicity-scorer.js` exporting
  `computeEpisodicity`, `meanEntityGenerality`, `episodicityTelemetry`
  per § 4.1. Pure-functional; ESM; no I/O.
- [ ] Write tests at `mcp/test/synthesis/episodicity-scorer.test.mjs`:
  - Worked examples § 7.1–7.7 pass byte-identically.
  - All § 9 invariants are property-tested.
  - `EPISODICITY_UNKNOWN_ENTITY_KIND` throw on unknown kind.
  - Deterministic replay fixture.
- [ ] CI cross-check: `CAPS.ENTITY_SPECIFICITY_PRIORS` equals the
  table at `entity-schema.md § 3.1`.
- [ ] CI grep test: no other source file in `mcp/lib/synthesis/`,
  `mcp/lib/ingest/`, or `mcp/lib/recall/` defines a function whose
  name contains `episodicity` and that performs a sigmoid combine
  (I-EPI-1).
- [ ] CI grep test: `episodicity_match` is referenced only inside the
  multiplicative-gate calculation in
  `mcp/lib/recall/multi-feature-score.js` (I-EPI-19).
- [ ] Wire `F-SYN-INTEGRATION-CASCADE-STAMPS-EPISODICITY` per § 4.2 —
  this is the substrate's first integration consumer.
- [ ] Wire `F-SYN-INTEGRATION-MULTI-FEATURE-SCORE-WIRING` per § 4.4 —
  this is the substrate's second integration consumer.
- [ ] Coordinate with the populator (`F-SYN-FOUNDATION-context-populator`)
  to ensure the query-side input construction (§ 6.2) lands in lockstep
  with the cascade-stamp side.

When this checklist is complete, the W3 stratification rule
(`power-law-decay-contract.md § 4.3`) can be safely consumed by the
multi-feature scorer — both contracts are then concretely backed by a
real number on every fact.
