# Valence / Mood Channel Provenance

`F-SYN-FOUNDATION-valence-provenance` — foundation-tier design contract.

## Mission

The Phase 3 recall scorer (`research-retrieval-frontiers.md`) lists `w_val * valence_compat`
as one of the additive soft-feature terms with bootstrap weight `w_val = 0.2`. The
architecture (`architecture.md § 4`) names `valence` as a per-fact feature. Operations
(`operations.md § recall → Inputs / ambient`) lists `inferred_mood` as a recall-time
slot in `surrounding_context.ambient`. None of these documents say WHERE the valence
value is produced, by WHAT module, with WHAT provenance, or under WHAT formula. The
critic (`research-retrieval-frontiers.md § Risks + open questions § 4`) flagged this
as a *silent NLP dependency* — the load-bearing channel has no named owner.

This spec closes that gap. It declares:

1. A single named module — `mcp/lib/synthesis/valence-scorer.js` — that produces
   valence values for BOTH call sites (cascade-stamp at promote time over
   `event.content`, and populator at recall time over `surrounding_context`).
2. A versioned, provenance-tagged output shape: `{sign, magnitude, source,
   extractor_version}`. The `source` field is a first-class signal that downstream
   consumers (the multi-feature scorer, the episodicity feature, the calibration loop)
   use to weight confidence in the value.
3. The exact formula for `valence_compat` and the rule that places it on the additive
   soft-feature side of the multi-feature score — NEVER on the multiplicative-gate
   side, because valence mismatch is a preference signal, not a correctness invariant.
4. The cross-extractor-version reconciliation discipline: when v1 swaps lexicon
   for classifier, fact-side and query-side valence MUST share the same
   `extractor_version` at compare time, enforced by the O6 re-stamp pass.
5. The reconstructed-event handling: reconstructed events do not stamp valence
   (per `architecture.md § 4`), and the episodicity feature substitutes `b4 = 0`.

The audience is the implementer who will turn this into Node.js at
`mcp/lib/synthesis/` in the substrate wave. Every formula, threshold, schema
field, and edge case below is binding.

## kb anchors

The five anchors below are the binding citations. Implementers MUST treat the
quoted text as the source of truth; this spec is a projection.

### KB-1: research-retrieval-frontiers.md § Risks + open questions / critic §4

> "Mood / valence channel appears in scoring but no provenance for how query.mood
> is derived from surrounding_context. Silent dependency on an upstream NLP
> component."

This is the predicate of the spec. The named-module + provenance-tag discipline
is the direct closure.

### KB-2: research-retrieval-frontiers.md § Phase 3 v0 multi-feature score

> "+ w_val\*valence_compat — appears on the additive soft-feature side, w_val=0.2
> bootstrap"

Pins the score-side wiring. Valence_compat is one term in the additive sum,
weighted `w_val = 0.2`. NOT a multiplicative gate.

### KB-3: architecture.md § 4 Memory ledger → fact features

> "features: { embedding, embedding_model_version, entities: [], time_anchors: [],
> valence } — valence is declared as a per-fact feature."

Pins the storage location for the cascade-stamped valence value. The valence
field lives on `fact.features.valence` and is set at promote time by the
salience cascade. The corresponding slot on `reconstructed.features` is
intentionally absent in the schema.

### KB-4: operations.md § recall → Inputs / ambient

> "ambient: { calendar_state, inferred_mood, parties_present } — inferred_mood is
> the recall-time slot the synthesis layer's valence-scorer must populate."

Pins the populator's output location. Recall-time valence is written to
`surrounding_context.ambient.inferred_mood`. This is the query-side
read by the multi-feature scorer.

### KB-5: salience-design.md § R25 Implementation Sketch

> "New module: `mcp/lib/ingest/salience.js` (~450 LOC, +~50 over R24 for two
> zero-valued decay-feedback columns). Exports `scoreCandidate(event, ctx)`.
> Owned by `memory_distill_promote_fact` between step 3e (consent walk) and
> step 4 (embed-then-append); embedding reused for index write."

Pins the cascade-stamp call site. The valence-scorer is invoked from within
`scoreCandidate` (or its successor) at promote time, just before the embed
call. The valence value is attached to the fact's `features` block alongside
`features.embedding` and `features.salience.components`.

## Schema(s)

### S1. ValenceValue (the unit produced by the scorer)

```ts
type ValenceValue = {
  // Signed direction on a discrete three-state axis.
  // -1 = net-negative affect; 0 = neutral / no signal; +1 = net-positive affect.
  sign: -1 | 0 | +1;

  // Strength of affective signal, normalized to [0, 1].
  // 0 means absent (no affect signal at all); 1 means maximal (saturating
  // lexicon-density on the input). Magnitude is independent of sign at
  // the storage level — sign=0 always pairs with magnitude=0.
  magnitude: number;

  // Provenance — which path produced this value.
  //   'lexicon'    — affect dictionary lookup hit at least one token (v0 default).
  //   'classifier' — neural classifier produced a confident score (v1 swap path).
  //   'absent'     — neither path produced a usable signal; sign=0, magnitude=0,
  //                  consumer should treat this as "no information" rather than
  //                  "definitely neutral".
  source: 'lexicon' | 'classifier' | 'absent';

  // Versioned extractor tag. Bumps trigger O6 re-stamp passes on the fact-side.
  //   'lexicon-v1'    — initial v0 ship.
  //   'classifier-v1' — first classifier swap (deferred to v1).
  //   etc.
  extractor_version: string;
};
```

Storage invariants:

- `sign === 0` IFF `magnitude === 0` (both 0 means no signal; never one without
  the other).
- `magnitude >= 0` and `magnitude <= 1`. Out-of-range values fail the schema
  check and are clipped at the scorer boundary, never persisted.
- `source === 'absent'` IFF `sign === 0 AND magnitude === 0`. The triple
  (sign=0, magnitude=0, source!='absent') is forbidden.
- `extractor_version` is a non-empty string, matching `/^[a-z]+-v[0-9]+$/`.

### S2. fact.features.valence (cascade-stamped)

The fact-side storage location is `fact.features.valence`, populated at promote
time by `valence-scorer.scoreValence(event.content)`. Its type is `ValenceValue`
(S1).

```ts
type FactFeatures = {
  embedding: number[];
  embedding_model_version: string;
  entities: string[];
  time_anchors: TimeAnchor[];
  valence: ValenceValue;      // <-- this spec
  salience?: SalienceFeatures; // (from kb/salience-design.md)
};
```

Note: when the cascade is in EMBED_DEFERRED state and a fact is not yet
written, valence is also not yet stamped. Valence stamping happens in the
same atomic write as the embedding stamp — both succeed or neither is
appended. This avoids the "fact exists with embedding but no valence"
corruption mode.

### S3. surrounding_context.ambient.inferred_mood (populator-stamped)

The query-side storage location is the recall input `surrounding_context.ambient.inferred_mood`,
populated by the context populator (`F-SYN-FOUNDATION-context-populator`) which
calls `valence-scorer.scoreValence(distilledQueryText)`. Its type is `ValenceValue`
(S1).

```ts
type SurroundingContext = {
  recent_turns: Turn[];
  agent_role: string;
  current_query: string;
  time: string;
  ambient: {
    calendar_state: CalendarState | null;
    inferred_mood: ValenceValue;       // <-- this spec
    parties_present: string[];
  };
  recent_recall_ids: string[];
};
```

The populator's distilled query text is the input. Spec §6 (Decision Rules)
defines how the populator constructs that text from `current_query +
recent_turns[]`.

### S4. ValenceCompat (the scoring intermediate)

```ts
type ValenceCompat = {
  // The compatibility score, in [0, 1]. Higher means fact and query share
  // valence direction and magnitude.
  score: number;

  // Effective contribution to the multi-feature score, equals
  //   score * CAPS.RECALL_W_VAL
  // The scorer logs this so the recall-log can replay the contribution.
  weighted: number;

  // Both sides' provenance, surfaced so the recall-log can detect
  // cross-version mismatches.
  fact_source: 'lexicon' | 'classifier' | 'absent';
  query_source: 'lexicon' | 'classifier' | 'absent';
  fact_extractor_version: string;
  query_extractor_version: string;

  // True iff fact_extractor_version === query_extractor_version. When false,
  // the comparison is ill-defined; the score is computed anyway but the
  // multi-feature scorer applies a confidence dampener (see §6.4).
  cross_version: boolean;
};
```

### S5. CAPS contributions

The following constants are added to `mcp/lib/validation.js § CAPS` and
snapshotted via `_capsSnapshot()` on every recall (R19 audit discipline).

```ts
CAPS.RECALL_W_VAL = 0.2;
// Multi-feature scorer weight on the additive soft-feature side.
// Bootstrap value per research-retrieval-frontiers.md § Phase 3 v0 recommendation.
// Hand-tuned through v0–v2; learned at v3 (LightGBM lambdarank).

CAPS.VALENCE_SIGN_THRESHOLD = 0.05;
// Below this absolute net intensity, the lexicon scorer collapses sign AND
// magnitude to 0 (and source='absent'). Closes the rounding-degenerate-sign
// reviewer finding (MINOR §3). Symmetric: applies to v0 lexicon and v1
// classifier alike.

CAPS.VALENCE_MAGNITUDE_CLAMP = [0.0, 1.0];
// Magnitudes outside this range are clamped at the scorer boundary.

CAPS.VALENCE_EXTRACTOR_VERSION = 'lexicon-v1';
// Single source of truth for the active extractor version. Bumps require
// an O6 re-stamp pass on every fact's features.valence value.

CAPS.VALENCE_CROSS_VERSION_DAMPENER = 0.5;
// Applied to ValenceCompat.weighted when cross_version === false. Limits the
// score-side influence of a fact-vs-query valence comparison done across
// extractor versions. The full restamp pass (O6) is the discipline; this
// dampener is the safety net during the rolling window between stamp and
// restamp.
```

### S6. Lexicon file shape

The v0 lexicon lives at `mcp/lib/synthesis/lexicons/valence-v1.json`.

```ts
type ValenceLexicon = {
  version: 'lexicon-v1';
  // Seeded from NRC VAD (Mohammad 2018) under permissive license; substrate-tier
  // open question may swap to AFINN / ANEW / VADER, but the schema is invariant.
  source_attribution: string;
  // Token-keyed signed intensities. Tokens are lowercase, punctuation-stripped,
  // not stemmed (intentionally surface-form to keep behavior auditable).
  entries: {
    [token: string]: {
      sign: -1 | +1;          // entries are never sign=0 (those are omitted)
      intensity: number;       // (0, 1] — strength of the affect
    };
  };
  // Multiplier on next token's intensity if the bigram (intensifier, token)
  // matches. E.g. 'very' * 1.5, 'extremely' * 1.8, 'slightly' * 0.5.
  intensifiers: { [token: string]: number };
  // Sign-flip operators applied to the next token. E.g. 'not', 'never', 'no'.
  negators: string[];
  // Token count after stopword strip below which the scorer falls back to
  // source='absent'. Avoids high-magnitude collapses from one-word inputs.
  min_token_threshold: number;
};
```

The lexicon is loaded once at module import time (`require` cache). It is
treated as read-only at runtime; updates ship as a new file with a bumped
version filename (e.g. `valence-v2.json`) AND a corresponding
`CAPS.VALENCE_EXTRACTOR_VERSION` bump triggering O6 restamp.

## Function signatures / Module surface

The module is `mcp/lib/synthesis/valence-scorer.js`. Its public surface:

### F1. `scoreValence(text, opts?) → ValenceValue`

```ts
function scoreValence(
  text: string,
  opts?: {
    // Override the active extractor version. ONLY for offline testing /
    // golden-set regeneration. Production callers omit this.
    extractor_version_override?: string;
    // If true, never fall back to source='absent' even when the lexicon
    // produces zero signal — return sign=0, magnitude=0, source='lexicon'.
    // Used by tests that need to distinguish "lexicon ran but found nothing"
    // from "lexicon was not run". Default false.
    no_absent_fallback?: boolean;
  }
): ValenceValue;
```

Contract:

- Deterministic: same input → same output, modulo `extractor_version_override`.
- Synchronous: returns within ~100µs for inputs ≤ 500 tokens (lexicon-v1).
- Never throws on valid string input. Empty string returns
  `{sign: 0, magnitude: 0, source: 'absent', extractor_version: <active>}`.
- Non-string input throws `TypeError`.

### F2. `scoreValenceCompat(factValence, queryValence) → ValenceCompat`

```ts
function scoreValenceCompat(
  factValence: ValenceValue,
  queryValence: ValenceValue
): ValenceCompat;
```

Contract:

- Pure function. No I/O, no module-state reads.
- Implements the formula in §6.3.
- Returns ValenceCompat with `weighted = score * CAPS.RECALL_W_VAL *
  (cross_version ? 1 : CAPS.VALENCE_CROSS_VERSION_DAMPENER)`.

### F3. `valenceMagnitude(value) → number` (helper for episodicity feature)

```ts
function valenceMagnitude(value: ValenceValue): number;
```

Contract:

- Returns `value.magnitude` (a number in `[0, 1]`).
- Used by `F-SYN-FOUNDATION-episodicity-feature` to read the `b4` input. This
  helper exists so the episodicity feature does not have to know about the
  internal sign/magnitude split — it gets the magnitude as a scalar.
- For a fact with no valence stamped (e.g. a reconstructed event), the
  episodicity feature does not call this helper; it substitutes `b4 = 0` (see
  Decision Rule §6.5).

### F4. `getActiveExtractorVersion() → string`

```ts
function getActiveExtractorVersion(): string;
```

Contract:

- Returns the current `CAPS.VALENCE_EXTRACTOR_VERSION`. The watermark daemon
  reads this on tick start and compares to the persisted state; any change
  triggers an O6 restamp queue entry.

### F5. `requiresRestamp(value) → boolean`

```ts
function requiresRestamp(value: ValenceValue): boolean;
```

Contract:

- Returns `true` iff `value.extractor_version !== getActiveExtractorVersion()`.
- Used by the O6 restamp pass to filter facts whose stamped valence is stale.

### F6. Cross-module integration points

These are NOT exported from `valence-scorer.js` but are part of the contract
because the spec names them:

- `mcp/lib/ingest/salience.js` — cascade stamp call site. Within
  `scoreCandidate`, after the consent walk (step 3e) and before the embed
  call (step 4), invoke `valence-scorer.scoreValence(event.content)` and
  attach the result to `event.features.valence`. The value is included in
  the same atomic ledger append as the embedding.
- `mcp/lib/synthesis/context-populator.js` (built in
  `F-SYN-FOUNDATION-context-populator`) — recall-time stamp call site. After
  distilling `surrounding_context.current_query + recent_turns[]` into a
  focused query string, invoke `valence-scorer.scoreValence(distilledText)`
  and write the result to `surrounding_context.ambient.inferred_mood`.
- `mcp/lib/recall/multi-feature-score.js` (built in the substrate wave) —
  scoring call site. For each candidate fact, invoke
  `valence-scorer.scoreValenceCompat(fact.features.valence,
  surrounding_context.ambient.inferred_mood)` and add `compat.weighted` to
  the additive soft-feature sum.
- `mcp/lib/synthesis/episodicity-feature.js` (built in
  `F-SYN-FOUNDATION-episodicity-feature`) — reads
  `valence-scorer.valenceMagnitude(fact.features.valence)` as the `b4`
  sigmoid input. Falls back to `b4 = 0` for reconstructed events.

## Decision rules

### §6.1 — scoreValence for the lexicon v0 path

Input: `text: string`.

```
1. If text is empty or whitespace-only, return
   {sign: 0, magnitude: 0, source: 'absent', extractor_version: ACTIVE}.

2. Tokenize: lowercase, strip punctuation, split on whitespace.
   Result is tokens[] of length T_raw.

3. Strip stopwords using a small fixed list (the, a, an, of, to, in, on, at,
   for, is, are, was, were, be, been, being, do, does, did). Result is
   tokens_filtered[] of length T.

4. If T < lexicon.min_token_threshold (3 by default), return
   {sign: 0, magnitude: 0, source: 'absent', extractor_version: ACTIVE}.

5. Walk tokens_filtered left-to-right maintaining:
     - net: running signed sum of intensities.
     - hits: count of tokens that matched the lexicon.
     - pending_negation: bool, true if previous token was a negator.
     - pending_multiplier: number, 1.0 unless previous token was an intensifier.

   For each token t at index i:
     - If t in lexicon.negators: set pending_negation = NOT pending_negation,
       skip lexicon lookup.
     - Else if t in lexicon.intensifiers: set pending_multiplier =
       lexicon.intensifiers[t], skip lexicon lookup.
     - Else if t in lexicon.entries:
         entry = lexicon.entries[t]
         contribution = entry.sign * entry.intensity * pending_multiplier
         if pending_negation: contribution = -contribution
         net = net + contribution
         hits = hits + 1
         pending_negation = false
         pending_multiplier = 1.0
     - Else:
         pending_negation = false   # negator's scope is one token
         pending_multiplier = 1.0   # intensifier's scope is one token

6. If hits == 0, return
   {sign: 0, magnitude: 0, source: 'absent', extractor_version: ACTIVE}.

7. Normalize: net_normalized = net / sqrt(T). (sqrt normalization keeps
   short emotional bursts from saturating while long flat texts can't
   compound. Empirically tuned in lexicon-v1 validation.)

8. If |net_normalized| < CAPS.VALENCE_SIGN_THRESHOLD (0.05):
     return {sign: 0, magnitude: 0, source: 'absent', extractor_version: ACTIVE}.
   (Closes reviewer MINOR §3: small-magnitude signals collapse cleanly to
   absent, not to sign=0+source='lexicon'.)

9. sign = (net_normalized > 0) ? +1 : -1.
   magnitude = min(|net_normalized|, 1.0).   # CAPS.VALENCE_MAGNITUDE_CLAMP

10. Return {sign, magnitude, source: 'lexicon', extractor_version: ACTIVE}.
```

### §6.2 — scoreValence for the classifier v1 path (deferred)

When `CAPS.VALENCE_EXTRACTOR_VERSION` is `classifier-v1`, the lexicon path is
not run. Instead:

```
1. Submit text to the classifier (DistilBERT-affect or Gemini Flash few-shot,
   chosen at substrate tier).

2. Classifier returns {label: 'positive' | 'negative' | 'neutral', confidence: [0,1]}.

3. If confidence < 0.5 (configurable per-classifier):
     return {sign: 0, magnitude: 0, source: 'absent', extractor_version: ACTIVE}.

4. Else:
     sign = (label == 'positive') ? +1 : (label == 'negative') ? -1 : 0
     magnitude = (sign == 0) ? 0 : confidence
     source = 'classifier'
     return {sign, magnitude, source, extractor_version: ACTIVE}.
```

The v1 swap is behind the same `scoreValence` signature. Downstream callers
do not need to change.

### §6.3 — scoreValenceCompat formula

```
score = 1 - 0.5 * |fact.sign * fact.magnitude - query.sign * query.magnitude|

clamp score to [0, 1] (defensive — the formula already guarantees this when
sign ∈ {-1, 0, +1} and magnitude ∈ [0, 1]).
```

Worked range check:

- `fact = (+1, 1.0)`, `query = (+1, 1.0)`: score = 1 - 0.5 * 0 = 1.0.
- `fact = (+1, 1.0)`, `query = (-1, 1.0)`: score = 1 - 0.5 * 2 = 0.0.
- `fact = (0, 0)`, `query = (0, 0)`: score = 1 - 0.5 * 0 = 1.0. (Both absent
  → maximum compat; this is intentional, because "neither side has affect" is
  not a mismatch.)
- `fact = (+1, 0.5)`, `query = (0, 0)`: score = 1 - 0.5 * 0.5 = 0.75.

Cross-version handling:

```
cross_version = (fact.extractor_version === query.extractor_version)

weighted = score * CAPS.RECALL_W_VAL                              # base
if not cross_version:
    weighted = weighted * CAPS.VALENCE_CROSS_VERSION_DAMPENER     # 0.5x penalty
```

The cross-version dampener is the SAFETY NET during the window when O6
restamp is in progress. Steady-state, after restamp completes, all facts
share the active version and `cross_version` is always true.

### §6.4 — Score wiring in multi-feature-score.js

```
multi_feature_score(memory, context) =
    s_emb_full3072
  * predicate_mask                  # multiplicative gates (correctness)
  * consent_dampener
  * derivation_status
  * episodicity_match
  + w_ent * entity_overlap_jaccard
  + w_t1 * time_anchor_match (gated to 0 if no anchor)
  + w_t2 * power_law_decay(age, kind)
  + w_val * valence_compat          # ← THIS SPEC's contribution
  + w_eng * engagement_prior
```

The `w_val * valence_compat` term is the additive contribution. It is
NEVER multiplied into the gate cluster on the multiplicative side. A
valence mismatch reduces the additive sum; it does NOT zero or near-zero
the whole score.

Specifically: when `ValenceCompat.weighted = 0` (worst case, opposite
signs, both at full magnitude), the contribution to the additive sum is
0 — but the multiplicative gate cluster is unaffected, so a memory with
strong embedding + entity match + correct derivation can still rank
highly. This is the design intent: valence preference is a tiebreaker,
not a veto.

### §6.5 — Reconstructed event handling

`architecture.md § 4` lists `valence` ONLY on `fact.features`. The
`reconstructed.features` schema explicitly omits it:

```
reconstructed:
  content
  derived_from: [ id, ... ]
  features: { embedding, embedding_model_version, entities, time_anchors }
                                                          # no valence
```

Spec rule:

1. The cascade does NOT stamp valence on reconstructed events. The salience
   cascade only runs over `fact` candidates; reconstructed events come from
   the agent's recall-time summarization path and bypass salience entirely.

2. When the episodicity feature is computed over a reconstructed event, it
   substitutes `b4 = 0` (the magnitude input) in the sigmoid. This is the
   contract between this spec and `F-SYN-FOUNDATION-episodicity-feature`.

3. When a reconstructed event surfaces in a brief, the multi-feature scorer
   computes `valence_compat` with `fact_valence = {sign: 0, magnitude: 0,
   source: 'absent', extractor_version: <whatever>}` as a sentinel. This
   yields a compat score that depends only on the query's valence — high
   when query is also absent, lower as query magnitude grows. This is
   acceptable because reconstructed events are rare in recall briefs (they
   are agent-emitted summarizations, not retrieved facts).

### §6.6 — Cross-extractor-version reconciliation (the O6 restamp)

This rule directly addresses the reviewer's MAJOR §1 finding.

When `CAPS.VALENCE_EXTRACTOR_VERSION` is bumped (e.g. lexicon-v1 →
classifier-v1):

1. The O6 restamp queue is populated by a sweep over `ledgers/memory.jsonl`
   filtering `fact` events whose `features.valence.extractor_version !==
   getActiveExtractorVersion()`. The query is satisfied by `requiresRestamp`.

2. The restamp worker reads each candidate fact, runs the active
   `scoreValence(fact.content)`, and writes a `policy.restamp.valence` event
   to `ledgers/memory.jsonl` (append-only — no in-place mutation).

3. The corroboration-style projection (architecture.md § 4 patterns) joins
   the fact with its latest restamp event to compute the effective
   `features.valence`. This makes restamp byte-idempotent: re-running it
   over an already-restamped fact emits a duplicate that the projection
   collapses.

4. During the restamp window, fact-side valence and query-side valence may
   carry different `extractor_version` strings. The `CAPS.VALENCE_CROSS_VERSION_DAMPENER`
   (0.5) halves the score contribution during this window. The dampener
   does NOT excuse the restamp — it bounds the damage while restamp
   completes.

5. Restamp is bounded by `CAPS.RESTAMP_BATCH_SIZE` (defined in the O6 spec,
   not here) per tick to avoid blocking ingestion.

### §6.7 — Edge cases

| Edge case | Rule |
|---|---|
| Input is non-string (number, object, null) | Throw `TypeError`. |
| Input is a 50KB document | Process in full; lexicon-v1 is O(T) and bounded. Classifier-v1 truncates to its model's input cap (defined at substrate tier). |
| Lexicon file fails to load at module import | Throw `Error('valence-scorer: lexicon load failure')`. Cascade ingestion halts (fail closed). The CI integration test asserts the lexicon loads. |
| Input is pure punctuation / emoji-only | Tokenizer strips to empty; rule §6.1 step 1 returns `source: 'absent'`. (Emoji affect is a v2 enhancement, gated on operator empirical signal.) |
| Multiple sentences with conflicting valence | Lexicon-v1 sums signed intensities; if they cancel to below `CAPS.VALENCE_SIGN_THRESHOLD`, return `source: 'absent'`. Mixed-affect text is honestly neutral. |
| Fact's `features.valence` is missing on a legacy row | Treat as `{sign: 0, magnitude: 0, source: 'absent', extractor_version: 'lexicon-v1'}` sentinel. Logged to `health_notes` for restamp triage. |

## Examples

These examples use short constructed strings; none is taken from a real
message. Example 1 extends spot-check (1) of salience-design.md § R25.7,
which is itself a constructed string.

### Example 1 — Promote-time stamp on an iMessage with positive affect

Input row (shaped like a `storage/sources/imessage.jsonl` row):

```json
{
  "id": "imsg-2026-06-15-23",
  "ts": "2026-06-15T14:32:00Z",
  "source": "imessage",
  "parties": ["alex", "sam"],
  "raw_content": "yeah for the meeting tuesday i was thinking 2-4, that should work great"
}
```

Cascade reaches Layer-2 score; salience PROMOTE. Just before the embed call:

```js
const valence = scoreValence(event.raw_content);
// internal walk:
//   tokens_filtered = ['yeah', 'meeting', 'tuesday', 'thinking', '2-4',
//                      'work', 'great']
//   T = 7 (above min_token_threshold = 3)
//   lexicon hits: 'yeah' (+1, 0.4), 'great' (+1, 0.9)
//   net = 0.4 + 0.9 = 1.3
//   net_normalized = 1.3 / sqrt(7) = 0.491
//   |0.491| >= 0.05 → not absent
//   sign = +1, magnitude = min(0.491, 1.0) = 0.491
//
// returns:
// { sign: +1, magnitude: 0.491, source: 'lexicon', extractor_version: 'lexicon-v1' }
```

Stamped onto the fact:

```json
{
  "id": "mem-imsg-2026-06-15-23",
  "kind": "fact",
  "content": "yeah for the meeting tuesday i was thinking 2-4, that should work great",
  "features": {
    "embedding": [...3072 floats...],
    "embedding_model_version": "gemini-embedding-001",
    "entities": ["sam", "meeting", "tuesday"],
    "time_anchors": [{"kind": "weekday", "value": "tuesday"}],
    "valence": {
      "sign": 1,
      "magnitude": 0.491,
      "source": "lexicon",
      "extractor_version": "lexicon-v1"
    }
  }
}
```

### Example 2 — Recall-time populator producing inferred_mood

Recall input arrives at `recall(surrounding_context)`. The populator distills:

```
current_query: "what did sam say about scheduling tuesday"
recent_turns: [
  "i'm worried we won't make the deadline",
  "everything's been falling apart this week"
]
```

The populator concatenates and distills (algorithm specified in
`F-SYN-FOUNDATION-context-populator`) to:

```
"worried deadline falling apart sam scheduling tuesday"
```

Then calls:

```js
const inferredMood = scoreValence(distilledText);
// internal walk:
//   tokens_filtered = ['worried', 'deadline', 'falling', 'apart', 'sam',
//                      'scheduling', 'tuesday']
//   T = 7
//   lexicon hits: 'worried' (-1, 0.7), 'apart' (-1, 0.5) [contextual; in
//      lexicon-v1 'apart' carries a mild negative]
//   net = -0.7 + -0.5 = -1.2
//   net_normalized = -1.2 / sqrt(7) = -0.453
//   |0.453| >= 0.05 → not absent
//   sign = -1, magnitude = 0.453
//
// returns:
// { sign: -1, magnitude: 0.453, source: 'lexicon', extractor_version: 'lexicon-v1' }
```

Written to `surrounding_context.ambient.inferred_mood`. Multi-feature scorer
then computes compat against Example 1's fact:

```js
const compat = scoreValenceCompat(
  { sign: +1, magnitude: 0.491, source: 'lexicon', extractor_version: 'lexicon-v1' },  // fact
  { sign: -1, magnitude: 0.453, source: 'lexicon', extractor_version: 'lexicon-v1' }   // query
);
// fact_signed_mag = +1 * 0.491 = +0.491
// query_signed_mag = -1 * 0.453 = -0.453
// |0.491 - (-0.453)| = 0.944
// score = 1 - 0.5 * 0.944 = 0.528
// cross_version = true
// weighted = 0.528 * 0.2 * 1.0 = 0.1056
//
// returns:
// { score: 0.528, weighted: 0.1056,
//   fact_source: 'lexicon', query_source: 'lexicon',
//   fact_extractor_version: 'lexicon-v1', query_extractor_version: 'lexicon-v1',
//   cross_version: true }
```

The +0.1056 enters the additive sum. The fact still surfaces if other
features carry it; the valence mismatch is a soft demotion, not a veto.

### Example 3 — Reconstructed event in a brief, query has absent valence

Recall query is purely factual, no affect markers:

```
current_query: "which hostname does the samplebot LX-2 answer on"
```

Populator distills to `"hostname samplebot LX-2 answer"`. Lexicon walk yields zero
hits → `source: 'absent', sign: 0, magnitude: 0`.

A reconstructed event surfaces (the agent previously summarized a setup
note):

```json
{
  "id": "mem-reconstructed-2026-05-12-04",
  "kind": "reconstructed",
  "content": "On the lab LAN the LX-2 called 'samplebot' answers as amber-harbor.local",
  "features": {
    "embedding": [...],
    "embedding_model_version": "gemini-embedding-001",
    "entities": ["LX-2", "samplebot", "amber-harbor"],
    "time_anchors": []
    // NOTE: no valence field — reconstructed events do not carry valence.
  }
}
```

Multi-feature scorer reaches valence_compat. Rule §6.5 applies:

```js
const factValenceSentinel = {
  sign: 0, magnitude: 0, source: 'absent', extractor_version: 'lexicon-v1'
};
const queryValence = surrounding_context.ambient.inferred_mood;  // also absent

const compat = scoreValenceCompat(factValenceSentinel, queryValence);
// fact_signed_mag = 0 * 0 = 0
// query_signed_mag = 0 * 0 = 0
// |0 - 0| = 0
// score = 1 - 0.5 * 0 = 1.0
// weighted = 1.0 * 0.2 = 0.2
```

Maximum compat. The reconstructed event is not penalized for the missing
valence when the query is also absent. This is correct: there is nothing
to mismatch.

### Example 4 — Cross-version dampener during an O6 restamp window

Operator has bumped `CAPS.VALENCE_EXTRACTOR_VERSION` to `classifier-v1`.
The restamp pass is mid-flight; some facts still carry `lexicon-v1`
stamps. The query side is populated by the active scorer (`classifier-v1`).

```js
const compat = scoreValenceCompat(
  { sign: +1, magnitude: 0.49, source: 'lexicon',    extractor_version: 'lexicon-v1' },
  { sign: +1, magnitude: 0.85, source: 'classifier', extractor_version: 'classifier-v1' }
);
// score = 1 - 0.5 * |0.49 - 0.85| = 1 - 0.18 = 0.82
// cross_version = false
// weighted = 0.82 * 0.2 * 0.5 = 0.082  (vs 0.164 if same-version)
//
// returns:
// { score: 0.82, weighted: 0.082,
//   fact_source: 'lexicon', query_source: 'classifier',
//   fact_extractor_version: 'lexicon-v1', query_extractor_version: 'classifier-v1',
//   cross_version: false }
```

The dampener halves the contribution. The fact still surfaces; the
mismatch is bounded. When O6 restamp completes for this fact, the
dampener no longer fires.

### Example 5 — Short text falls back to absent

```js
scoreValence("ok cool")
// tokens_filtered = ['ok', 'cool']
// T = 2; min_token_threshold = 3
// returns {sign: 0, magnitude: 0, source: 'absent',
//          extractor_version: 'lexicon-v1'}
```

Even though `cool` is in the lexicon (+1, 0.5), the short-text gate fires
first. This is intentional: one-word emotional bursts give the scorer
too little context to trust the magnitude. The substrate tier may revisit
`min_token_threshold` based on operator empirics.

## Invariants

These MUST hold across all implementations of this contract.

### I1. Same module, both call sites.

The cascade-stamp path AND the populator path call the IDENTICAL exported
function `scoreValence` from `mcp/lib/synthesis/valence-scorer.js`. There is
no second copy, no inlined heuristic, no parallel implementation. This
preserves Principle 2 (projection-from-ledger discipline) and closes the
reviewer's symmetry concern.

### I2. Provenance on every value.

No `ValenceValue` may exist without a `source` field. The schema check fails
closed. `source: 'absent'` is a first-class value, not a missing field. This
distinguishes "scorer ran and found nothing" from "scorer was not run", and
downstream consumers MUST weight differently.

### I3. Additive-only score wiring.

`w_val * valence_compat` enters the multi-feature score on the additive
side. It NEVER multiplies the gate cluster (predicate_mask, consent_dampener,
derivation_status, episodicity_match). A valence mismatch CAN reduce the
additive contribution to zero; it CANNOT mask a correctness gate.

### I4. Sign-magnitude consistency.

`sign === 0 ⟺ magnitude === 0`. Enforced at the scorer boundary (rule §6.1
step 8) and at the schema check. Implementations MUST NOT emit
`(sign=+1, magnitude=0)` or `(sign=0, magnitude=0.3)` — both are forbidden.

### I5. Extractor version is the same string both sides at compare time
when not in restamp.

Steady-state, after any O6 restamp pass completes, every fact in the ledger
carries `features.valence.extractor_version === CAPS.VALENCE_EXTRACTOR_VERSION`.
The query-side value is produced by the active scorer and therefore also
carries the active version. The cross-version dampener fires ONLY during
the restamp window, never steady-state.

### I6. Reconstructed events carry no valence field.

The fact schema includes `features.valence`; the reconstructed schema does
not (architecture.md § 4 binding). Implementations MUST NOT introduce
valence on reconstructed events. The episodicity feature substitutes
`b4 = 0` (Decision Rule §6.5).

### I7. Lexicon file is read-only at runtime.

The lexicon JSON is loaded once at module import. Hot updates do not exist;
the discipline is bump-the-version-string-and-restamp. Implementations MUST
NOT support a runtime lexicon mutation API.

### I8. Cross-version dampener applies only to weighted, never to score.

`ValenceCompat.score` reflects the geometric compatibility (the formula
in §6.3). `ValenceCompat.weighted` adds the dampener. The recall-log
records both; offline analysis can see the unmasked geometry.

### I9. `_capsSnapshot()` records all valence caps on every recall.

`CAPS.RECALL_W_VAL`, `CAPS.VALENCE_SIGN_THRESHOLD`,
`CAPS.VALENCE_EXTRACTOR_VERSION`, and `CAPS.VALENCE_CROSS_VERSION_DAMPENER`
are all snapshotted via `_capsSnapshot()` and embedded in the recall event
(R19 audit discipline). A weight or threshold change is byte-traceable from
the recall ledger.

### I10. `valence-scorer.scoreValence` is deterministic.

For a fixed `CAPS.VALENCE_EXTRACTOR_VERSION` and lexicon file, the function
is a pure function of its input. No clock reads, no random draws, no
external I/O. This is required so that the golden-query harness
(salience-design.md CP-4) can assert reproducible top-K rankings.

## Open questions

These five remain open and propagate to wave-N tasks. They are NOT blocking
this spec; they are decision points for the substrate or operational tier.

### Q1. Lexicon choice — NRC VAD vs AFINN vs ANEW vs VADER

The substrate wave will pick. This contract requires only that the lexicon
produce a `ValenceValue` matching the schema. Tradeoffs:

| Lexicon | Coverage | Domain fit | Licensing |
|---|---|---|---|
| NRC VAD (Mohammad 2018) | ~20k entries | General-purpose; gaps on technical content | Permissive academic |
| AFINN (Nielsen 2011) | ~2.5k entries | Social media skew | Permissive |
| ANEW (1999 affective norms) | ~1k entries | Lab-controlled affect ratings | Requires registration |
| VADER (Hutto & Gilbert 2014) | ~7.5k + rules | Tuned for social media; handles emoji + intensifiers | Permissive |

The default in this spec is NRC VAD because it has the broadest base
vocabulary; VADER has a stronger out-of-the-box rule engine. Substrate
tier will A/B both on operator corpora.

### Q2. Domain adaptation for developer chat + iMessage NL

The user's corpora are heavy on iMessage natural language (Example 1
shape) and developer chat (technical content with low affect density).
General-purpose lexicons underperform on the developer-chat slice. The
question is whether to build a small domain-adapted overlay
(`lexicon-v1-dev-chat.json`) at the substrate tier, or accept the gap and
let `w_val = 0.2` absorb the noise.

Operational tier may revisit if the recall-log shows valence-driven
re-ranking errors concentrated in the developer-chat agent_role.

### Q3. Re-stamp scheduling

The O6 restamp pass is mentioned here but specified in the O6 contract.
This spec assumes O6 exists and provides:

- A queue populated by `requiresRestamp` filter.
- A batched worker that runs `scoreValence(fact.content)` and emits
  `policy.restamp.valence` events.
- A back-pressure mechanism so restamp doesn't starve ingestion.

If O6 does not land before the first valence extractor bump, this spec's
cross-version dampener (0.5x) is the sole defense. That is tolerable for a
v0–v1 transition but not for v1–v2.

### Q4. w_val calibration with K (damping constant)

The recall scorer has multiple bootstrap weights (`w_ent`, `w_t1`, `w_t2`,
`w_val`, `w_eng`) AND a per-kind power-law damping constant `K`. The
operational tier calibration loop will tune some subset. Open question:
is `w_val` in the tuned set, or does it stay fixed at 0.2 through v0-v2 and
get learned only at v3 (LightGBM lambdarank)?

The default in this spec is **fixed at 0.2 through v2**. Learned at v3 with
the rest of the score weights.

### Q5. parties_present interaction with valence

A comment that reads neutral in isolation may have charged valence between
specific parties (sarcasm, in-group reference). `surrounding_context.ambient.parties_present`
is available at recall time. The question: does the populator factor it in,
e.g. by routing through a parties-aware classifier in v1?

Deferred to v1. v0 scores on raw text only.

## Cross-tier impact

This spec constrains the following other nodes in the hypergraph. Changes
to this spec require coordinated updates to each.

### `F-SYN-FOUNDATION-episodicity-feature`

The episodicity sigmoid takes four inputs `b1..b4`. `b4` is
`|valence.magnitude|`. This spec defines the type and provenance of that
value AND the reconstructed-event substitution rule (§6.5: `b4 = 0` for
reconstructed events). The episodicity spec MUST call
`valence-scorer.valenceMagnitude(fact.features.valence)` rather than
reading the field directly, so the substitution is centralized.

### `F-SYN-FOUNDATION-context-populator`

The populator owns the distillation algorithm that produces the focused
query string from `current_query + recent_turns[]`. After distillation, the
populator calls `valence-scorer.scoreValence` and writes the result to
`surrounding_context.ambient.inferred_mood`. The populator spec MUST list
this as one of its outputs and MUST cite this contract for the
ValenceValue type.

### `F-SYN-SUBSTRATE-valence-scorer` (later wave)

This is the implementation target. The substrate spec will:

- Pick the lexicon (Q1).
- Implement `mcp/lib/synthesis/valence-scorer.js` against this interface.
- Ship `mcp/lib/synthesis/lexicons/valence-v1.json`.
- Add CI tests for: schema invariants, golden-input determinism, sign/
  magnitude consistency, short-text absent fallback, cross-version
  dampener arithmetic.

### `F-SYN-INTEGRATION-RECALL-CONSUMES-VALENCE` (later wave)

This is the recall-side wiring. The integration spec will:

- Update `mcp/lib/recall/multi-feature-score.js` to invoke
  `valence-scorer.scoreValenceCompat` and add `compat.weighted` to the
  additive sum.
- Snapshot all CAPS valence keys via `_capsSnapshot()`.
- Log `ValenceCompat` (both score and weighted, plus cross_version flag)
  into the recall event so off-policy evaluation can reason about valence
  contribution.

### `F-SYN-OPERATIONAL-O6-RESTAMP`

The O6 contract owns the restamp queue and batched worker. This spec
hands O6 the input: a fact stream filtered by `requiresRestamp`, and the
expected output event shape (`policy.restamp.valence`). Coordination point:
O6's batch size and back-pressure rules.

### `kb/salience-design.md § R25 Implementation Sketch`

The salience cascade module (`mcp/lib/ingest/salience.js`) gains a call to
`valence-scorer.scoreValence` after the consent walk (step 3e) and before
the embed call (step 4). The salience design spec MUST list this in its
touched-files block when the substrate wave lands.

### `kb/architecture.md § 4`

The `fact.features.valence` field's type is pinned by this spec (S1
ValenceValue). The architecture doc lists the field name; this spec
pins the schema. Implementers MUST NOT emit a scalar number or string
in this slot — only a `ValenceValue`.

### `kb/operations.md § recall → Inputs / ambient`

The `surrounding_context.ambient.inferred_mood` field's type is pinned by
this spec (S1 ValenceValue). The operations doc lists the field name as a
"heuristic from word choice"; this spec replaces the heuristic with a named
module.

---

End of contract.
