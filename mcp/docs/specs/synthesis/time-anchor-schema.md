# Time-anchor schema and resolver contract

## Mission

Pin down the on-ledger shape of `fact.features.time_anchors[]`, the parse-once-resolve-many discipline that keeps "next Tuesday" stable across recall years, and the TempRetriever-style gated-channel rule that prevents evergreen facts from decaying like episodic ones during recall scoring. Without this contract, the `w_t1 * time_anchor_match` term in `mcp/lib/recall/multi-feature-score.js` is silently ill-defined: today it is a strict ISO-8601 step function that treats relative phrases ("yesterday", "last summer") as unparseable and zero-scores them, and it has no notion of gating the channel off for evergreen queries. This spec is a blocker for the context-populator (which needs to know which surrounding-context segments emit anchors) and for the episodicity feature (which uses `has_time_anchor` as one of four sigmoid inputs). It overrides the silence of `operations.md § Scoring` on the gating rule, adopts the v2 TempRetriever pattern wholesale, and closes the cross-tier ambiguity from the F2 research output by recommending store-relative + resolve-at-recall.

This is the schema and contract spec only. The concrete extractor (NER + temporal-expression parser) and the resolver implementation (chrono-node vs HeidelTime vs LLM) are substrate-tier work — `F-SYN-SUBSTRATE-time-anchor-resolver` will choose the library against the latency budget this spec names.

## kb anchors

- **`architecture.md` § 4 Memory ledger → fact features.** Binding quote: `features: { embedding, embedding_model_version, entities: [], time_anchors: [], valence }`. Establishes that `time_anchors` is an array on every fact's `features` block and lives alongside `entities` and `valence`. This spec defines the array element shape; the surrounding shape is fixed by architecture.md.

- **`operations.md` § recall → Scoring.** Binding quote: `+ w3 * time_proximity(memory.time_anchors, context.time)`. This is the single line of operations that names the recall-time consumer. The line is silent on gating, on what `time_proximity` returns when `memory.time_anchors == []`, and on whether `context.time` is the raw recall-clock or a parsed anchor from the conversation. This spec makes all three explicit and pins gating behavior to the TempRetriever pattern below.

- **`research-retrieval-frontiers.md` § Phase 3 v2.** Binding quote: `time-anchor channel gated (HeidelTime/SUTime/LLM resolver vs now, masked to 0 when context has no anchor — TempRetriever pattern)`. Authoritative source of the gating rule. The "vs now" phrasing here is misleading at the v2 frontier level — the resolver actually runs vs the recall-time context, not the wall clock; this spec corrects the framing for the implementer.

- **`research-retrieval-frontiers.md` § Citations — Abdallah et al. 2025 TempRetriever.** Binding quote: `Temporal information as fused channel, not post-hoc rerank. +6.63% Top-1 (and +3.79 NDCG@10) on ArchivalQA. Anchors gated time-anchor-match channel.` Empirical backing for treating the time-anchor signal as a first-class channel rather than a rerank-time tiebreaker, and for gating it (not always-on).

- **`research-retrieval-frontiers.md` § Phase 3 v0 multi-feature score.** Binding quote: `w_t1*time_anchor_match (gated to 0 if no anchor) + w_t2*power_law_decay(age, kind)`. Two distinct terms, two distinct gating disciplines: `w_t1` is conditionally masked, `w_t2` is always-on. This spec makes the asymmetry explicit and forbids gating `w_t2`.

- **`thesis.md` § 1 The ledger is permanent; the memory landscape is a projection.** Binding quote: `The event ledger is append-only and authoritative. "What the system currently believes" is the output of a function over that ledger, parameterized by the recall context.` The store-relative-resolve-at-recall discipline is a direct application: the anchor as parsed at promote time is permanent (ledger), the resolved instant is a projection computed at recall time (landscape).

- **`thesis.md` § 2 Relevance is determined at recall time.** Binding quote: `The recall function takes surrounding context — recent turns, entities, time anchors, agent role, mood signals, calendar state — and produces a bounded brief scored against that context.` Time anchors are recognised at this layer of the principle, which is the load-bearing reason to resolve at recall (not at promote).

## Schema

### Anchor element on `fact.features.time_anchors[]`

```ts
type TimeAnchor = {
  // Discriminator. Drives which fields of `parsed` are populated.
  kind: "absolute" | "relative" | "recurring";

  // The exact substring extracted from event content. Stored verbatim, never
  // normalized. Used by audit ("what did the extractor actually see?") and by
  // the drift-detection re-stamp pass. Empty string forbidden.
  raw_phrase: string;

  // The parsed form. Populated differently per `kind` (see § Decision rules).
  parsed: {
    // Populated when `kind === "absolute"`. ISO-8601 with timezone offset.
    // For absolute anchors the resolver returns this verbatim.
    iso?: string;

    // Populated when `kind === "relative"`. Names what the offset is measured
    // from. "event_ts" -> the promoting source row's ts (STABLE across re-read).
    // "now" -> the recall-time clock (DRIFTS — reserved for narrow cases like
    // ambient indicators "right now", "just now"; rejected for "next Tuesday").
    offset_from?: "event_ts" | "now";

    // Populated when `kind === "relative"`. Signed integer; positive = future,
    // negative = past. Combined with `offset_from` to compute the instant at
    // recall.
    offset_seconds?: number;

    // Populated when the phrase implies a span ("for a week", "a 2-hour meeting",
    // "last summer"). Span = [instant, instant + duration_seconds]. When set,
    // the resolver MUST emit both lower_bound_iso and upper_bound_iso.
    duration_seconds?: number;

    // Populated when `kind === "recurring"`. RFC-5545 RRULE subset (see § Decision
    // rules for the subset). Resolver behavior in v0: not resolved (see flag).
    recurrence?: {
      freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
      interval?: number;     // default 1
      byday?: string[];      // ["MO", "TU", ...]
      bymonthday?: number[]; // 1..31
      bymonth?: number[];    // 1..12
      until?: string;        // ISO-8601, exclusive
      count?: number;        // positive integer
    };
  };

  // Extractor's per-anchor confidence in [0, 1]. Distinct from
  // `event.provenance.confidence` (which is a fact-level epistemic confidence).
  // Below 0.5 -> the anchor is written but the resolver SHOULD downweight it
  // by linear scaling at recall (see § Decision rules § Confidence band).
  // RENAMED per review M3 from `confidence` to `extractor_confidence` to avoid
  // shadowing the provenance field on the enclosing fact.
  extractor_confidence: number;

  // Stamp identifying the (parser, lexicon, lexicon-version) tuple that
  // produced this anchor. Matches the discipline of `embedding_model_version`
  // on the surrounding features block. On extractor upgrade, the drift
  // detector (`F-SYN-OPERATIONAL-drift-detection`) emits a new fact event
  // with `derived_from` pointing at the original; the old anchor stays in
  // the ledger.
  extractor_version: string;

  // Set to true ONLY by the resolver when it refuses to compute an instant.
  // For v0 this is exactly `kind === "recurring"`. Future versions may add
  // others (TZ-ambiguous and never-disambiguated; multi-instant fuzz). The
  // multi-feature score MUST treat `recurrence_resolution_deferred === true`
  // as if the anchor were absent for the gating predicate (i.e. it does NOT
  // turn the time-anchor channel on; see § Decision rules).
  recurrence_resolution_deferred?: boolean;
};
```

Notes:

- `parsed` is a discriminated union by `kind`, NOT a flat dictionary. An `absolute` anchor MUST NOT carry `offset_from` / `offset_seconds`; a `relative` anchor MUST NOT carry `iso`; a `recurring` anchor MUST NOT carry `iso` / `offset_from` / `offset_seconds` (only `recurrence` and optionally `duration_seconds`). Validation MUST reject mixed shapes.
- `duration_seconds` is permitted on any `kind` but in practice is paired most often with `relative` (fuzzy spans like "last summer" → `offset_from=event_ts, offset_seconds=−180 * 86400, duration_seconds=90 * 86400`) and `absolute` ("the 2025-11-12 meeting" with a default 60-minute duration the extractor MAY supply).
- The whole array is bounded: max 8 anchors per fact (`CAPS.TIME_ANCHORS_MAX_PER_FACT`). Extractor outputs above the cap MUST be truncated by the promote-time validator, not silently kept.

### Resolved instant (returned by the resolver at recall time)

```ts
type ResolvedInstant = {
  // The canonical answer the score function consumes. Always ISO-8601 with
  // explicit timezone offset (resolver MUST NOT emit local time without TZ).
  // For recurring anchors in v0 this is null and `deferred === true`.
  instant_iso: string | null;

  // Span endpoints. Set whenever the source anchor had `duration_seconds` OR
  // when the resolver inferred a span from a fuzzy relative phrase. For
  // sharp anchors ("at 14:00 UTC"), both are null. The score function uses
  // these for bound-overlap scoring (see § Decision rules § time_anchor_match).
  lower_bound_iso: string | null;
  upper_bound_iso: string | null;

  // True iff the resolver did NOT produce an instant (e.g. recurring in v0,
  // unresolvable TZ, or extractor_confidence below CAPS.TIME_ANCHOR_HARD_DROP).
  // The score function MUST treat this as "no anchor present" for gating
  // purposes — i.e. it does NOT contribute to the "context has an anchor"
  // predicate.
  deferred: boolean;

  // Linear downweight in [0, 1] applied to time_anchor_match BEFORE the w_t1
  // weight is applied. Derived from extractor_confidence per § Decision rules
  // § Confidence band. 1.0 means full strength.
  confidence_multiplier: number;

  // Pinned tuple identifying which resolver and rules produced this instant.
  // Logged into the recall event so re-projection from the ledger is byte
  // stable when the resolver upgrades.
  resolver_version: string;
};
```

### Surrounding-context anchor list

`surrounding_context.time_anchors[]` mirrors the same `TimeAnchor` shape so that the gating predicate (`hasTemporalIntent`) operates on a single uniform array. The context populator (`F-SYN-FOUNDATION-context-populator`) extracts anchors from `current_query` and from each `recent_turns[]` entry; it does NOT extract them from `agent_role` or `ambient.*`.

The recall-time context additionally carries `surrounding_context.time` (the recall-clock ISO-8601) as in operations.md. This is the `reference_time` argument passed to `resolveAnchor` when an anchor uses `offset_from === "now"`. For `offset_from === "event_ts"` anchors, `reference_time` is ignored by the resolver — the offset was already baked into the promote-time `event_ts`.

### CAPS additions to `mcp/lib/validation.js`

```js
TIME_ANCHORS_MAX_PER_FACT: 8,           // truncation cap at promote time
TIME_ANCHOR_HARD_DROP: 0.30,            // extractor_confidence below this -> drop
TIME_ANCHOR_LOW_CONFIDENCE: 0.50,       // below this -> linear downweight
TIME_ANCHOR_MATCH_SHARP_DAY: 1.0,       // step function step #1
TIME_ANCHOR_MATCH_NEAR_WEEK: 0.5,       // step function step #2
TIME_ANCHOR_MATCH_BOUND_OVERLAP: 0.75,  // score when bounds overlap (not point)
TIME_ANCHOR_MATCH_NEAR_DAYS: 7,         // threshold for step #2
RESOLVER_LATENCY_BUDGET_MS: 5,          // per-anchor budget at recall time
TEMPORAL_LEXICON: Object.freeze([       // hasTemporalIntent (§ Decision rules)
  // explicit temporal pointers
  "when", "yesterday", "today", "tomorrow", "tonight", "morning", "afternoon",
  "evening", "night", "noon", "midnight",
  // temporal connectives
  "last", "next", "ago", "before", "after", "during", "since", "until",
  "recently", "ever", "never", "while", "whilst", "earlier", "later",
  // calendar units
  "week", "weeks", "month", "months", "year", "years", "day", "days",
  "hour", "hours", "minute", "minutes", "second", "seconds", "decade",
  "century",
  // weekday names
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  // month names
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  // seasonal
  "spring", "summer", "autumn", "fall", "winter",
  // known v0 gap (see § Open questions): "birthday", "anniversary", "holiday"
  // — temporal-intent signals without being lexicon words. v0 ships without
  // them; v1 adds them as separate category once we have recall-log evidence.
]),
```

`TEMPORAL_LEXICON` is `Object.freeze`'d at module load. Tokenization is whitespace + punctuation (`/[\s\p{P}]+/u`); the gate is case-insensitive; bare-stem matching is sufficient (we do NOT need stems like "yesteryear" → "year").

## Function signatures / Module surface

### `mcp/lib/synthesis/time-anchor-schema.js` (this contract; THIN module)

This module exports only schema-validation primitives. It is consumed by every other module that touches anchors and depends on nothing in `mcp/lib/recall/` to keep the dependency DAG one-way.

```ts
// Validates a single TimeAnchor against the discriminated union rules.
// Throws (NOT returns false) on the first violation so the promote-time
// caller sees the exact shape error in the source row's audit log.
// Throws also on:
//   - missing kind
//   - wrong fields-for-kind combination
//   - extractor_confidence outside [0, 1]
//   - empty raw_phrase
//   - extractor_version not a non-empty string
//   - recurrence pattern outside the RFC-5545 subset in § Schema
export function assertValidAnchor(anchor: unknown): asserts anchor is TimeAnchor;

// Validates the full array. Truncates to CAPS.TIME_ANCHORS_MAX_PER_FACT if
// over, recording the original length in the returned `truncated_from`.
// Drops anchors with extractor_confidence < CAPS.TIME_ANCHOR_HARD_DROP at the
// SCHEMA layer (not the score layer) so the ledger does not carry noise.
export function validateAnchorList(
  anchors: unknown[],
  opts?: { source_event_id?: string }
): {
  anchors: TimeAnchor[];
  truncated_from: number | null;    // null if no truncation
  hard_dropped: number;             // count
};

// Pure predicate. True iff the array contains at least one anchor that the
// resolver did NOT mark deferred. Used by both the gating rule on
// surrounding_context and as a fallback "has_time_anchor" feature when the
// fact-side resolved instants are unavailable (e.g. during episodicity
// scoring at promote time).
export function hasResolvableAnchor(anchors: TimeAnchor[]): boolean;
```

### `mcp/lib/synthesis/time-anchor-resolver.js` (substrate tier — sketch in this spec, full impl in `F-SYN-SUBSTRATE-time-anchor-resolver`)

The substrate tier owns the parser library choice (chrono-node / HeidelTime / LLM). This spec pins the SIGNATURES; the substrate spec pins the implementation. Both signatures are pure — no global clock reads, no I/O — so tests can be byte-stable.

```ts
// Parses raw text into anchors. Called at promote time only. `event_ts` is
// the source row's ts (used to resolve offset_from=event_ts anchors at parse
// time so the offset_seconds is baked in). Returns at most
// CAPS.TIME_ANCHORS_MAX_PER_FACT anchors; raises no errors on text with no
// anchors (returns []).
export function parseAnchors(
  text: string,
  event_ts: string,
  opts?: { extractor_version?: string; locale?: string }
): TimeAnchor[];

// Resolves a single anchor against reference_time. reference_time is
// surrounding_context.time at recall time (NOT new Date()). The function is
// pure: same anchor + same reference_time -> byte-identical ResolvedInstant.
//
// For kind="absolute": instant_iso = parsed.iso verbatim; reference_time
//   ignored.
// For kind="relative" with offset_from="event_ts": instant_iso is computed
//   from a stashed event_ts that the anchor MUST carry on the ledger
//   (validateAnchorList enforces this by requiring offset_from anchors to be
//   self-contained — see § Decision rules).
// For kind="relative" with offset_from="now": instant_iso is computed from
//   reference_time + offset_seconds.
// For kind="recurring": deferred=true, instant_iso=null (v0).
export function resolveAnchor(
  anchor: TimeAnchor,
  reference_time: string,           // ISO-8601 with TZ
  opts?: { resolver_version?: string }
): ResolvedInstant;

// Convenience: resolve a list, dropping deferred entries OR returning them
// flagged depending on `opts.include_deferred`. The score function consumes
// the non-deferred subset; the episodicity scorer consumes the count of
// non-deferred entries via hasResolvableAnchor.
export function resolveAnchors(
  anchors: TimeAnchor[],
  reference_time: string,
  opts?: { resolver_version?: string; include_deferred?: boolean }
): ResolvedInstant[];
```

### `mcp/lib/recall/multi-feature-score.js` (consumer surface)

Existing `timeAnchorMatch` is updated as below. The function rename + signature change is breaking; the old signature lives behind `timeAnchorMatchV0Legacy` for one minor release with a deprecation log so the integration test that asserts it can be migrated.

```ts
// hasTemporalIntent: returns true iff surrounding_context contains a
// resolvable anchor OR current_query lexically contains a token from
// CAPS.TEMPORAL_LEXICON. This is the gating predicate.
export function hasTemporalIntent(
  surrounding_context: { time_anchors?: TimeAnchor[]; current_query?: string }
): boolean;

// time_anchor_match: the soft feature scored against memory side anchors,
// gated to 0 when hasTemporalIntent is false.
//
// Returns a scalar in [0, 1]. Inputs:
//   memory_anchors:  ResolvedInstant[] — the fact's anchors resolved against
//                    reference_time at recall start (the recall service
//                    resolves once for all candidates per call to amortize)
//   context_anchors: ResolvedInstant[] — the surrounding_context's anchors,
//                    resolved likewise
//   surrounding_context: passed for the lexical fallback check
//
// Decision rules in § time_anchor_match below. Critical: NO time_anchors at
// all on the memory side does NOT mask the channel (only the SURROUNDING
// CONTEXT side gates). A fact without time anchors is "evergreen" — it
// scores 0 on this channel which the gate then suppresses.
export function timeAnchorMatch(
  memory_anchors: ResolvedInstant[],
  context_anchors: ResolvedInstant[],
  surrounding_context: { current_query?: string }
): number;
```

### `mcp/lib/recall/recall-service.js` (orchestration, integration tier)

Not specified here in detail (see `F-SYN-INTEGRATION-RECALL-CONSUMES-TIME-ANCHORS`); the relevant call shape is:

```js
const referenceTime = surrounding_context.time;
const ctxResolved = resolveAnchors(
  surrounding_context.time_anchors ?? [],
  referenceTime
);
for (const candidate of candidates) {
  const memResolved = resolveAnchors(
    candidate.features.time_anchors ?? [],
    referenceTime
  );
  candidate.__time_match = timeAnchorMatch(
    memResolved,
    ctxResolved,
    surrounding_context
  );
}
```

`resolveAnchors` is invoked once per candidate fact (typically ≤2 anchors per fact) and once per surrounding-context (≤4 anchors typical). At the 50-candidate Layer-2 rescore stage, total resolver calls per recall ≤ 50 × 2 + 4 = 104; at `RESOLVER_LATENCY_BUDGET_MS = 5` per call this is ≤ 520ms which is acceptable since resolution runs inside the rescore stage's existing budget. If the substrate-tier resolver chooses an LLM-based implementation, the budget tightens and resolution MUST batch over the candidate set — that constraint is named here and the substrate spec MUST honor it.

## Decision rules

### kind discriminator selection (parser side)

The parser tags each extracted phrase with exactly one `kind`. The selection rule is mechanical:

1. If the phrase resolves to a calendar instant with no recurrence and no implicit offset (e.g. "2026-11-12T14:00Z", "November 12 at 2pm", "Christmas 2025") → `kind = "absolute"`, populate `parsed.iso`.
2. Else if the phrase implies a recurrence pattern (e.g. "every Tuesday", "monthly", "each weekday morning") → `kind = "recurring"`, populate `parsed.recurrence`.
3. Else if the phrase is anchored to a movable point (e.g. "yesterday", "next Tuesday", "two weeks ago", "last summer") → `kind = "relative"`, populate `parsed.offset_from` and `parsed.offset_seconds`.

A phrase that is BOTH a relative offset AND has a span ("last summer", "next week") sets `parsed.duration_seconds` in addition to the offset.

### offset_from selection (resolves M2 from review)

For `kind = "relative"`, the parser MUST pick `offset_from` according to:

- `offset_from = "event_ts"` when the phrase is anchored to the moment the content was produced. This is the DEFAULT for nearly all relative phrases in NL. "Yesterday", "next Tuesday", "two weeks ago", "this morning", "last summer" all bake the offset against the source row's `ts` — meaning that re-reading the fact a year later still produces the SAME Tuesday/yesterday/morning. This is what makes "next Tuesday" parsed in 2025 still mean the original Tuesday-in-2025 when re-read in 2026.

- `offset_from = "now"` is reserved for ambient-progressive phrases where the speaker means the recall-time clock, NOT the speech-time clock. v0 candidates are limited to: `right now`, `just now`, `currently`, `at the moment`, and the bare "now" when not part of a fixed expression. The parser MUST NOT default to `"now"` — getting this wrong reintroduces the regression the spec exists to prevent.

The validation layer enforces: `offset_from = "event_ts"` anchors MUST carry the `offset_seconds` already computed against the source row's `ts`. The parser does this baking — there is no "later resolve event_ts" step. The recall-time resolver for `event_ts`-anchored relative anchors is therefore a one-line `add(promote_time_ts, offset_seconds)`, which the parser also bakes by storing `iso` on the anchor. (Net effect: an `event_ts`-relative anchor at storage is essentially an absolute anchor with an audit trail of the relative phrase. This is correct: it is what makes the meaning stable.)

The on-ledger representation therefore stores BOTH the parsed-relative form AND the baked-absolute ISO for `event_ts` anchors:

```ts
{
  kind: "relative",
  raw_phrase: "next Tuesday",
  parsed: {
    iso: "2025-11-18T00:00:00Z",     // baked at parse time against event_ts
    offset_from: "event_ts",
    offset_seconds: 432000           // 5 days from the Thursday event_ts
  },
  extractor_confidence: 0.92,
  extractor_version: "chrono-node@2.7.4+lex-v1"
}
```

For `offset_from = "now"`, `parsed.iso` is OMITTED — the resolver computes it at recall time.

### time_anchor_match (the scoring function)

Inputs at this layer are already-resolved `ResolvedInstant[]` on both memory and surrounding_context sides. The score is computed as follows:

```
function timeAnchorMatch(memory_anchors, context_anchors, surrounding_context):
  // Step 1: gate check.
  if not hasTemporalIntent(surrounding_context):
    return 0     # the channel is OFF for this query

  // Step 2: if memory has no anchors, return 0 (evergreen fact, no match).
  memory_non_deferred = memory_anchors filter where deferred === false
  if memory_non_deferred is empty:
    return 0

  // Step 3: if context has no resolved anchors but query has temporal
  // lexicon, return a small "intent matches but no specific anchor" credit.
  // This is the "you asked about time but didn't pin a date" case. The
  // matching memory anchors are not pinned either; we score by the bare
  // fact that both sides care about time.
  context_non_deferred = context_anchors filter where deferred === false
  if context_non_deferred is empty:
    return 0.25    # CAPS.TIME_ANCHOR_MATCH_INTENT_ONLY

  // Step 4: best-of-pairs match. For each (mem, ctx) pair compute the
  // pairwise score and return the maximum, scaled by mem-side confidence.
  best = 0
  for mem in memory_non_deferred:
    for ctx in context_non_deferred:
      pair = pairwiseTimeMatch(mem, ctx)
      scaled = pair * mem.confidence_multiplier * ctx.confidence_multiplier
      if scaled > best: best = scaled
  return best
```

Where `pairwiseTimeMatch` is the step function (instant-centric) with bound-overlap as a separate tier:

```
function pairwiseTimeMatch(mem, ctx):
  // If both have only instant_iso (sharp), use the day/week step function.
  if mem.lower_bound_iso is null and ctx.lower_bound_iso is null:
    delta_days = abs(toEpochDays(mem.instant_iso) - toEpochDays(ctx.instant_iso))
    if delta_days <= 1: return CAPS.TIME_ANCHOR_MATCH_SHARP_DAY   # 1.0
    if delta_days <= CAPS.TIME_ANCHOR_MATCH_NEAR_DAYS: return CAPS.TIME_ANCHOR_MATCH_NEAR_WEEK # 0.5
    return 0

  // If either has bounds, prefer bound overlap. Bound-overlap wins over
  // instant proximity when both are available — fuzzy anchors are a stronger
  // match against fuzzy queries than they are against sharp queries.
  mem_lo = mem.lower_bound_iso ?? mem.instant_iso
  mem_hi = mem.upper_bound_iso ?? mem.instant_iso
  ctx_lo = ctx.lower_bound_iso ?? ctx.instant_iso
  ctx_hi = ctx.upper_bound_iso ?? ctx.instant_iso
  if intervalsOverlap([mem_lo, mem_hi], [ctx_lo, ctx_hi]):
    return CAPS.TIME_ANCHOR_MATCH_BOUND_OVERLAP   # 0.75
  // Bounded but no overlap → fall back to centroid distance under the step
  // function.
  return pairwiseStep(centroid(mem_lo, mem_hi), centroid(ctx_lo, ctx_hi))
```

### `hasTemporalIntent` (the gate predicate)

```
function hasTemporalIntent(surrounding_context):
  // Path 1: explicit anchors present and resolvable.
  if hasResolvableAnchor(surrounding_context.time_anchors ?? []):
    return true
  // Path 2: lexical signal in the current query.
  q = (surrounding_context.current_query ?? "").toLowerCase()
  tokens = q.split(/[\s\p{P}]+/u)
  for tok in tokens:
    if CAPS.TEMPORAL_LEXICON.includes(tok):
      return true
  return false
```

Notes:

- The lexicon check fires on `current_query` ONLY, not on `recent_turns[]`. Two reasons. First: temporal intent in turn N-3 is too stale to drive the immediate scoring. Second: false-positive rate on the lexicon climbs linearly with corpus size, and recent-turns aggregate token count is 5–20× the query alone.
- A query like "what did I do last week" with no resolved anchor on the context (parser missed it) still passes the gate via "last" + "week". A query like "how do I configure HNSW" passes neither path and the channel is masked off — the desired behavior.
- The gate predicate is consulted EXACTLY once per recall (memoized), not once per candidate. Compute path is cheap (≤ 50 µs per query) but the memoization is required for byte-stable propensity logging: the same recall must compute the same gate value across replays.

### Relationship to `w_t2 * power_law_decay`

`power_law_decay` is NOT gated. It runs on every candidate regardless of `hasTemporalIntent`. The asymmetry is load-bearing:

- `w_t1 * time_anchor_match` answers "does this memory's content describe the time the query is about?" — only relevant when the query cares about time.
- `w_t2 * power_law_decay` answers "is this memory likely still accurate given how old it is?" — always relevant, since stale facts are stale regardless of query intent.

Gating `power_law_decay` along with `time_anchor_match` would mean that for evergreen queries ("what's my address") a 5-year-old "I live at X" fact and a 3-day-old "I live at Y" fact score equally — which is the exact regression `thesis.md § 4` ("decay is not a per-memory activation score") warns against by ALSO saying "discrimination erodes" depends on age. The multi-feature score is the place where age survives as a continuous penalty. The integration-tier wiring (`F-SYN-INTEGRATION-MULTI-FEATURE-SCORE-WIRING`) MUST enforce this asymmetry by asserting both branches of the gate explicitly in tests.

### Confidence band (extractor → resolver downweight)

The extractor stamps each anchor with `extractor_confidence ∈ [0, 1]`. The schema layer drops anchors below `CAPS.TIME_ANCHOR_HARD_DROP = 0.30` outright (they never reach the ledger). Anchors in `[0.30, 0.50)` are written but the resolver linearly downweights the contribution:

```
confidence_multiplier(extractor_confidence):
  if extractor_confidence >= 0.50:
    return 1.0
  // Linear ramp from 0.0 at 0.30 to 1.0 at 0.50.
  return (extractor_confidence - 0.30) / 0.20
```

The multiplier is recorded on `ResolvedInstant.confidence_multiplier` so the score function reads it directly. Below the hard-drop the anchor was already discarded; this function is only called on `[0.30, 1.0]` inputs.

### Timezone-ambiguous anchors

`"Tuesday morning"` has no timezone — the parser MUST resolve it against the surrounding event's TZ context. The cascade:

1. Use the source-row's `event_ts` TZ if present.
2. Fall back to `surrounding_context.ambient.calendar_state.timezone` at promote time (the salience cascade has access to this via the source policy block).
3. Fall back to UTC ONLY if the prior two are absent. Stamp `extractor_confidence *= 0.5` in this case (TZ-defaulting halves the confidence) so the downweight is mechanical.

A relative anchor that is `offset_from="now"` and was parsed without TZ context is treated as recall-time TZ at resolution. This is the only case where `reference_time`'s TZ matters for a relative anchor.

### Recurring anchors (deferred in v0)

For `kind = "recurring"`:

- The parser populates `parsed.recurrence`. The full RFC-5545 RRULE is not supported; the subset is `FREQ`, `INTERVAL`, `BYDAY`, `BYMONTHDAY`, `BYMONTH`, `UNTIL`, `COUNT`. Any unsupported RRULE component causes the parser to fall back to either `kind="absolute"` (next instance computed) or `kind="relative"` (offset to next instance), at the parser's discretion.
- The resolver in v0 returns `{ deferred: true, instant_iso: null, lower_bound_iso: null, upper_bound_iso: null }`. This means recurring anchors do NOT contribute to `time_anchor_match` and do NOT count toward `hasResolvableAnchor` for gating.
- v1 plan: resolve recurring anchors to "next instance after reference_time". This is the natural promotion path and does not require a schema change.

The schema-layer flag `recurrence_resolution_deferred` is set by the resolver; the schema validator does NOT set it on parse. This keeps the parser oblivious to the resolver's policy.

## Examples

### Example 1: "next Tuesday" in a 2025 chat ledger, recalled in 2026

Source row (2025-06-17, a Thursday):

```jsonc
{
  "id": "src_2025_0617_3a4b",
  "ts": "2025-06-17T15:14:00Z",
  "source": "chat-claude-code",
  "raw_content": "We're shipping the salience cascade next Tuesday at 10am PT."
}
```

Promote-time `parseAnchors(text, event_ts="2025-06-17T15:14:00Z")` extracts:

```jsonc
[
  {
    "kind": "relative",
    "raw_phrase": "next Tuesday at 10am PT",
    "parsed": {
      "iso": "2025-06-24T17:00:00Z",       // baked: Tuesday after 2025-06-17 @ 10am PT → 17:00Z
      "offset_from": "event_ts",
      "offset_seconds": 611160,             // 7d 1h 46m in seconds
      "duration_seconds": null
    },
    "extractor_confidence": 0.94,
    "extractor_version": "chrono-node@2.7.4+lex-v1"
  }
]
```

Recall at `2026-06-17T09:00:00Z` with `surrounding_context.current_query = "what was the salience cascade ship date?"`:

- `hasTemporalIntent` fires on the lexical signal of `"date"` (we did not include "date" in the v0 lexicon — note this gap; query would match via the entity index instead). For this example, suppose the user asked "when did the salience cascade ship?" → fires on "when".
- `resolveAnchor(anchor, "2026-06-17T09:00:00Z")` returns `{ instant_iso: "2025-06-24T17:00:00Z", deferred: false, confidence_multiplier: 1.0 }` — identical to the value a 2025 reader would have computed, BECAUSE `offset_from="event_ts"` and the iso was baked at parse time.
- If the surrounding context also has an anchor "around mid-2025" → `ResolvedInstant{ lower=2025-06-01, upper=2025-08-31 }`, the bounded-overlap branch fires and `pairwiseTimeMatch` returns 0.75.

What this rules out: if we had stored `offset_from="now"`, the resolver in 2026 would have computed "Tuesday after 2026-06-17" = 2026-06-23 — a different day, and the score function would miss the original 2025-06-24 ship date. The `offset_from="event_ts"` discipline is the load-bearing piece.

### Example 2: Evergreen fact, evergreen query — gate masks the channel

Stored fact: `"My home address is 123 Main St."` with `features.time_anchors: []` (no temporal phrase).

Recall query: `"what's my address"` with `surrounding_context.time_anchors: []`.

- `hasTemporalIntent` evaluates: no surrounding anchors AND no lexical signal in "what's my address" → returns `false`.
- `timeAnchorMatch` short-circuits at step 1, returns 0.
- The multi-feature score has `w_t1 * 0 = 0` contribution from this channel.
- `power_law_decay` STILL runs — if the fact is from 2 years ago and is a "fact" kind, its decay is `(1 + 1*730)^(-0.15) ≈ 0.39`, so the `w_t2 * 0.39 = 0.117` contribution penalizes age regardless of query intent. This is the desired asymmetry.

### Example 3: Recurring anchor parsed, deferred at recall

Source: `"I run every Tuesday morning."` parsed:

```jsonc
{
  "kind": "recurring",
  "raw_phrase": "every Tuesday morning",
  "parsed": {
    "recurrence": {
      "freq": "WEEKLY",
      "byday": ["TU"]
    },
    "duration_seconds": 3600
  },
  "extractor_confidence": 0.88,
  "extractor_version": "chrono-node@2.7.4+lex-v1"
}
```

Recall with query "what does my Tuesday look like":

- `resolveAnchor` returns `{ deferred: true, instant_iso: null, recurrence_resolution_deferred: true }`.
- The anchor does NOT count toward `hasResolvableAnchor` — but the lexical signal "Tuesday" fires `hasTemporalIntent`.
- `timeAnchorMatch` reaches step 2; if no other resolvable anchors are on the memory, it falls through and returns 0.
- The fact is still surfaced if it matches on embedding/entity/etc. — the gate is asymmetric: lexical intent opens the channel for QUERY purposes, but a deferred MEMORY-side anchor does not score.
- v1 (when the recurring resolver lands) would resolve to "the Tuesday on/after reference_time" → an instant match and a score of 1.0 against a `surrounding_context.time` of a Tuesday.

### Example 4: Drift-detection re-stamp emits a derived fact

Suppose the extractor upgrades from `chrono-node@2.7.4+lex-v1` to `+lex-v2` which now treats "ages ago" as a relative anchor (previously dropped). The drift-detector (`F-SYN-OPERATIONAL-drift-detection`) walks facts whose `extractor_version` predates the new lexicon and emits a `kind="reconstructed"` event:

```jsonc
{
  "kind": "reconstructed",
  "derived_from": ["fact_2025_0801_abcd"],
  "features": {
    "embedding": [...],
    "embedding_model_version": "gemini-embedding-001",
    "entities": [...],
    "time_anchors": [
      {
        "kind": "relative",
        "raw_phrase": "ages ago",
        "parsed": { "iso": "2024-06-01T00:00:00Z", "offset_from": "event_ts", "offset_seconds": -31536000 },
        "extractor_confidence": 0.55,
        "extractor_version": "chrono-node@2.7.4+lex-v2"
      }
    ]
  }
}
```

The original fact stays in the ledger with its original anchors. Recall projects from the latest derivation when both exist; the asymmetry is handled by the derivation graph projection rules, not by this contract.

## Invariants

I1. **Ledger immutability.** Anchors are written exactly once when their carrying event (fact or reconstructed) is appended. The schema validator MUST reject any mutation to an existing event's `features.time_anchors[]`. The drift-detection re-stamp emits a NEW event with `derived_from` pointing at the original — it does NOT mutate.

I2. **Resolver purity.** `resolveAnchor(anchor, reference_time)` is a pure function: same inputs → byte-identical output, no side-effects, no clock reads beyond the explicit `reference_time` argument. This is a testability invariant — replay over the ledger must produce identical resolved instants.

I3. **`event_ts` stability.** An anchor with `offset_from = "event_ts"` MUST carry `parsed.iso` baked at parse time. The resolver for such anchors returns `parsed.iso` verbatim regardless of `reference_time`. This makes "next Tuesday parsed in 2025, read in 2026" yield the same Tuesday.

I4. **Gating asymmetry.** Only `w_t1 * time_anchor_match` is gated by `hasTemporalIntent`. `w_t2 * power_law_decay` is NOT gated and always contributes. The integration-tier test suite MUST assert both directions: (a) evergreen query → `time_anchor_match = 0` AND `power_law_decay > 0` for any non-trivially-aged fact; (b) temporal query → both terms active.

I5. **Discriminated union.** `parsed` populates fields strictly per `kind`. Mixed-shape anchors (e.g. `kind="absolute"` with `offset_from` set) MUST be rejected by `assertValidAnchor` — they corrupt the resolver's per-kind switch.

I6. **Confidence-floor honesty.** Below `CAPS.TIME_ANCHOR_HARD_DROP` the anchor is dropped at the schema layer; it never reaches the ledger. The schema layer logs the drop count via `validateAnchorList`'s `hard_dropped` field so operators can monitor extractor-confidence drift over time.

I7. **Per-fact cap.** `features.time_anchors[].length ≤ CAPS.TIME_ANCHORS_MAX_PER_FACT (8)`. Extractors that exceed the cap have their output truncated by `validateAnchorList`, with `truncated_from` non-null in the return — a downstream audit event captures the truncation.

I8. **`extractor_version` stamping discipline.** Every anchor MUST carry `extractor_version` matching the regex `^[a-z0-9_\-]+@[0-9]+\.[0-9]+\.[0-9]+(\+[a-z0-9_\-]+)*$`. The version string identifies the parser library AND the lexicon revision; both contribute to the byte-stability of the resolved-instant projection.

I9. **`recurrence_resolution_deferred` quarantine.** `ResolvedInstant.deferred = true` MUST suppress contribution to BOTH `time_anchor_match` (via `pairwiseTimeMatch` filter) AND `hasResolvableAnchor` (via the predicate's filter). A deferred anchor on the memory side does not act as a "has anchor" signal for the gate; this prevents v0 recurring anchors from accidentally opening the channel and then scoring 0.

I10. **No clock side-effects from the resolver.** `resolveAnchor` MUST NOT call `Date.now()`, `new Date()` without an argument, `process.hrtime()`, or any other source of ambient time. All time inputs flow through the `reference_time` argument or are baked on the anchor. Lint rule (CI gate): the file `mcp/lib/synthesis/time-anchor-resolver.js` MUST NOT match the regex `Date\.now\(\)|new Date\(\)|process\.hrtime`.

I11. **Single resolve per recall call.** `resolveAnchors(context_anchors, reference_time)` is called exactly once at the start of a recall. `resolveAnchors(candidate.features.time_anchors, reference_time)` is called exactly once per Layer-2 rescore candidate. Re-resolving per scoring iteration is forbidden — the recall service caches the resolved arrays on the candidate object.

I12. **Lexicon as `Object.freeze`.** `CAPS.TEMPORAL_LEXICON` is frozen at module load. Runtime mutation MUST raise. Adding lexicon entries requires a code change + a `caps_version` bump that drift-detection can react to.

## Open questions

OQ1. **Resolver library choice.** Substrate-tier (`F-SYN-SUBSTRATE-time-anchor-resolver`) chooses between chrono-node (JS, ~3 ms/parse, MIT, mature), HeidelTime (Java subprocess, much higher recall, much higher latency), SUTime (similar to HeidelTime), and an LLM call (highest recall, ~hundreds of ms, requires batching). This spec accommodates any of them via the pure-function signatures, but the `RESOLVER_LATENCY_BUDGET_MS = 5` cap effectively rules out single-call LLM resolution. Substrate spec MUST justify the choice against the budget. Carry-forward as a wave-2 task.

OQ2. **Fuzzy bound semantics — instant vs bound-overlap precedence.** The current rule (bound-overlap wins when EITHER side has bounds) preserves both kinds of match but may over-credit fuzzy queries against sharp memories. Empirical question: does a fuzzy query like "around mid-2025" against a sharp anchor "2025-06-24" score 0.75 (bound-overlap) or 0.5 (near-week step)? Spec says 0.75 — punted to v1 calibration. Carry-forward.

OQ3. **Recurring promotion timing.** v0 defers recurring resolution. v1 will resolve "every Tuesday" to "next Tuesday on/after reference_time". Question: do we keep the recurrence pattern AND a resolved instant on the anchor (the resolver returns the next instance but the schema retains the pattern), or do we resolve at parse time when the recurrence has a near-bounded first instance? Resolver purity argues for "always resolve at recall against reference_time, never at parse." Carry-forward.

OQ4. **Lexicon gaps.** "Birthday", "anniversary", "holiday", "weekend" (not in v0 list), "deadline", "scheduled", "due", date-like strings ("Q3 2025", "FY26"), and the bare verb forms of temporal connectives ("scheduled", "planned", "due") — all are temporal-intent signals without being lexicon words. v0 ships without them; v1 expands the lexicon based on recall-log false-negatives (queries where the user clearly wanted time-conditioned matches but the gate was closed). Carry-forward as `F-SYN-OPERATIONAL-lexicon-tuning` (not yet a node — propose).

OQ5. **TZ inheritance ordering for relative anchors.** The cascade event_ts TZ → ambient TZ → UTC is specified, but the ambient TZ source (`surrounding_context.ambient.calendar_state.timezone`) is not pinned. operations.md names `ambient.calendar_state` but does not specify shape. Carry-forward to `F-SYN-FOUNDATION-context-populator` to pin the timezone field there.

OQ6. **Lexical signal scope — query only or include last turn?** The spec restricts `hasTemporalIntent` lexical check to `current_query`. An alternative: include the last `recent_turns[]` entry (turn N-1) on the grounds that follow-up questions ("yesterday, did I?" → next turn "what time?") inherit temporal context. Empirical question for v1: does single-turn restriction produce false-negative gating in conversation? Recall-log evidence required.

OQ7. **Lexicon false-positive rate.** Words like "may" (verb modal), "march" (verb), "fall" (verb) are in the lexicon as month and season. False-positive risk is real on contemporary English text. The current rule is bare-stem case-insensitive; v1 may need POS tagging (the parser already runs NER for entities, so POS is available). Carry-forward.

OQ8. **Confidence band cliff vs ramp empirics.** Linear ramp from 0.30 to 0.50 was chosen as the simplest defensible rule. Alternative: sigmoid ramp; alternative: harder cliff at 0.40. v1 calibration once we have recall-log evidence of low-confidence anchor performance. Carry-forward.

## Cross-tier impact

This contract constrains downstream specs as follows.

**SUBSTRATE tier:**
- `F-SYN-SUBSTRATE-time-anchor-resolver` — implements `parseAnchors` / `resolveAnchor` against this spec's signatures; must honor purity (I2, I10), latency budget (`CAPS.RESOLVER_LATENCY_BUDGET_MS`), and library choice constraint (OQ1).
- `F-SYN-SUBSTRATE-time-index` — the index is built from `features.time_anchors[].parsed.iso` (when populated) plus the resolved instants per `reference_time` query. Index does NOT cache resolutions across queries because `reference_time` varies; it indexes the baked `iso` for `event_ts`-anchored cases only.

**FOUNDATION tier:**
- `F-SYN-FOUNDATION-context-populator` — emits `surrounding_context.time_anchors[]` from `current_query` and `recent_turns[]`; uses the same `parseAnchors` from the substrate; must populate the `surrounding_context.time` ISO that this spec consumes as `reference_time`. Also pins the `ambient.calendar_state.timezone` field (OQ5).
- `F-SYN-FOUNDATION-episodicity-feature` — consumes `hasResolvableAnchor(features.time_anchors)` as one input to its sigmoid (`has_time_anchor`). The deferred-quarantine rule (I9) means recurring-only facts score lower on episodicity until v1 resolution lands — acceptable.
- `F-SYN-FOUNDATION-derivation-propagation` — drift-detection re-stamp emits a derived event (Example 4), the derivation walker must traverse from re-stamped events back to originals when projecting.

**INTEGRATION tier:**
- `F-SYN-INTEGRATION-RECALL-CONSUMES-TIME-ANCHORS` — owns the orchestration call shape (resolver once per call, cache on candidate); must instrument propensity logging of the gate decision so replay is byte-stable.
- `F-SYN-INTEGRATION-MULTI-FEATURE-SCORE-WIRING` — wires `timeAnchorMatch` and `powerLawDecay` into the additive branch; must assert the gating asymmetry (I4) in tests.
- `F-SYN-INTEGRATION-CASCADE-STAMPS-ENTITIES` and parallel `CASCADE-STAMPS-EPISODICITY` (no `CASCADE-STAMPS-TIME-ANCHORS` exists — propose one) — the salience cascade must call `parseAnchors` on the source row content before emitting the fact, stamping anchors into `features.time_anchors[]`.

**OPERATIONAL tier:**
- `F-SYN-OPERATIONAL-drift-detection` — consumes `extractor_version` to compute the re-stamp set; must accommodate the version-string regex (I8) and emit `kind="reconstructed"` events with `derived_from` (Example 4).
- `F-SYN-OPERATIONAL-offline-eval-harness` — needs a temporal-axis evaluation slice that tests both gated-off (evergreen) and gated-on (temporal-intent) recall paths. The held-out labeled set v2 (`F-SYN-OPERATIONAL-held-out-labeled-set-v2`) MUST include both modes; without that, the gating rule is untested in practice.

**BEHAVIOR tier:**
- No direct dependency. Aggregation behaviors are downstream of resolved instants.

**SUBSTRATE / OPERATIONAL co-constraint:**
- The `CAPS` block additions (`TEMPORAL_LEXICON`, `TIME_ANCHORS_MAX_PER_FACT`, scoring constants) MUST land in `mcp/lib/validation.js` before `multi-feature-score.js` consumes them. The CAPS frozen-object discipline (existing) carries over.
