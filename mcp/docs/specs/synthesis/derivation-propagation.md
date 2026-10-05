# Derivation-Graph Propagation — Foundation Spec

| | |
|---|---|
| Node | `F-SYN-FOUNDATION-derivation-propagation` |
| Tier | foundation |
| Status | pending |
| Depends on | `F-SYN-FOUNDATION-reconstructed-trigger`, `F-SYN-FOUNDATION-recall-log-split` |
| Authoritative for | `PROPAGATION_DEPTH_MAX`, `DECAY_PER_HOP`, `THRESHOLD_FLOOR`, `ORPHAN_DAMPENER`, `PARTIAL_ORPHAN_DAMPENER`, `LIVE_DAMPENER`, `ORPHAN_FLIP_RATIO` |

## 1. Mission

Pin the **propagation algebra** along `derived_from[]` edges across the `fact` / `policy` / `reconstructed` kinds for three semantically distinct channels:

1. **ENGAGEMENT propagation** — when a `reconstructed` event is engaged (per the engagement gate in `F-SYN-FOUNDATION-recall-log-split`), reinforcement flows *up* the derivation graph to each parent named in `derived_from[]`, decaying per hop, stopping at the first non-reconstructed ancestor (evidence is the floor).
2. **EXCISE propagation** — when a `fact` / `policy` is excised, the **already-shipped transitive-orphan BFS** (`kb/transitive-orphan-design.md`, implemented in `mcp/lib/recall/hard-gates.js`) is extended to assign a discrete `derivation_status ∈ {live, partially_orphaned, orphaned}` to every reconstructed descendant. The descendant is **not** auto-deleted; it is dampened at recall.
3. **EXCLUDE propagation** — when a `memory_exclude` predicate matches a parent at recall time, the recall scorer **recomputes** the affected reconstructed descendant's entity/time features against the surviving (non-matched) parent set, recall-time only, without mutating stored features.

This spec is the **single source of truth** for the propagation constants. All other tiers (behavior, integration, substrate, operational) reference them by **name** — never by inline value. That discipline was violated in earlier drafts (depth=4 here vs depth=3 in `F-SYN-BEHAVIOR-corroboration-propagation`, formula `0.5^(d-1)` here vs `0.5^depth` there); revision `WU-propagation-constants` converged them. The constants are flagged `v0 TUNABLE` per `open-problems.md #8` and the calibration loop (`F-SYN-OPERATIONAL-damping-calibration-loop`) owns the version-bump path.

The spec also pins the **forward-edge graph** extension to `F-SYN-SUBSTRATE-derivation-graph`: the transitive-orphan BFS already builds a `reverseAdj` (ancestor → descendant) at recall time; the engagement channel needs the **forward** adjacency (`derivation_graph.forwardAdj`: child reconstructed → parents) which is just `derived_from[]` read directly off the reconstructed row — no extra index, but a clear naming/contract distinction.

## 2. KB anchors (binding quotes)

### A1. `thesis.md` Principle 6 — Provenance threaded everywhere

> "Every event carries source, time, parties, derivation links. Agent-emitted inferences declare what they were derived from. **The derivation graph is what makes forgetting propagation possible — without it, a forgotten fact resurfaces through its derivatives.**"

This is the engagement+excise propagation root warrant. The forward channel (engagement) extends the same graph the backward channel (forgetting) already uses.

### A2. `operations.md` § excise(target, scope)

> "Propagate through derivation graph — **derivatives are marked epistemically orphaned (configurable: drop, retain, or re-derive without the excised parent)**."

This pins the **non-destructive** semantics of the excise channel: derivatives are flagged, not deleted. The dampener gate (§ 4.6) is how "marked orphaned" turns into a recall behavior without touching the ledger.

### A3. `architecture.md` § 5 — Derivation graph index

> "**Derivation graph** — edge per `derived_from` link; supports forgetting propagation."

The index already exists as one of the four canonical recall-side indices. This spec extends its use from **backward** (forgetting) to **forward** (engagement) traversal without redesigning the index.

### A4. `thesis.md` Principle 5 — Reinforcement is engagement-gated proximity

> "A memory surfaced in turn 5 enters turn 6's surrounding context, raising its match probability. But raw surfacing is *anti-reinforced* — recently surfaced items are down-weighted to prevent positive-feedback dominance. Reinforcement happens only when the user *engages*: responds, agrees, corrects."

This is the warrant for engagement propagation crossing the reconstruction boundary upward but **not** auto-rederiving downward: engagement on a derivative is signal about the underlying evidence, not authority to mint new derivatives.

### A5. `inheritance.md` § Take — Reversibility through new events

> "Reversibility through new events: `closure.recorded` with `surface_unblocked: true` | `exclude`, `replace`, `substitute` are events"

The reconstructed kind is the memory-system analogue of the upstream design's `closure.recorded` event. Propagation rules must preserve the "reversibility through new events" invariant — operator excision is reversed via a new manual re-derivation event, **not** by silent re-creation during BFS.

### A6. `open-problems.md` #5 — Predicate language is a hopeful sketch

> "User editability: captured features need to be human-inspectable so the user can refine 'no, exclude that broader pattern.'"

The EXCLUDE channel must make exclude-through-reconstruction-derivatives **mechanical** at recall time — the user excludes a parent and the descendants' entity_overlap stops counting the excluded entities, with no need to also manually exclude each derivative. Closes the user-editability gap for the reconstructed kind.

### A7. `open-problems.md` #6 — Reconsolidation policy

> "Agent summarizations during a conversation should produce `reconstructed` events. Pure read-and-cite recalls should not. The boundary is fuzzy and will need tuning."

This is the upstream warrant for the reconstructed-trigger taxonomy. The propagation rules below assume the trigger has fired correctly; debugging trigger mis-fires is `F-SYN-FOUNDATION-reconstructed-trigger`'s problem.

### A8. `open-problems.md` #8 — Damping calibration

> "Engagement-gated reinforcement is the right *shape*, but the constants are unknown ... These will need to be tuned through use; the framework supports it but the numbers are not pre-determined."

This warrants the `v0 TUNABLE` flag on every constant in § 3.1 — values chosen for shape, not certainty. The calibration loop (`F-SYN-OPERATIONAL-damping-calibration-loop`) is the version-bump path. CAPS schema in `mcp/lib/validation.js` is the canonical store.

### A9. `kb/transitive-orphan-design.md` § 2 (Algorithm) and § 4 (Scoring impact)

The transitive-orphan BFS over `reverseAdj` is **already shipped** in `mcp/lib/recall/hard-gates.js`. The EXCISE channel of this spec is a strict extension:

- Add `partially_orphaned` to the existing `{live, orphaned}` state.
- Wire the `ORPHAN_FLIP_RATIO` decision (count_excised / count_total > 0.5 → fully orphaned).
- Replace the existing depth-aware exponential dampener with the discrete three-state dampener (§ 4.6) for the reconstructed kind specifically — fact/policy descendants keep the existing depth-aware formula. (This avoids a recall-scoring regression on the fact-tier.)

### A10. `architecture.md` § 4 — `reconstructed` kind shape

```
content                   # agent-emitted summarization
derived_from: [ id, ... ]
features: { embedding, embedding_model_version, entities, time_anchors }
```

The `derived_from[]` array on the reconstructed row is the **forward** graph edge from the engagement-propagation perspective and the **backward** edge from the excise-propagation perspective. Same array, two traversal directions.

---

## 3. Authoritative constants (CAPS additions)

### 3.1 New CAPS in `mcp/lib/validation.js`

All seven constants below are added to the frozen `CAPS` object. All flagged `v0 TUNABLE` — the calibration loop owns the version-bump path. Bare-name re-exports follow the existing pattern at lines 706–726 of `validation.js`.

```js
// === Derivation propagation (authoritative; F-SYN-FOUNDATION-derivation-propagation §3) ===
// All values are v0 TUNABLE per open-problems.md #8.

// Single shared depth cap across all three channels (engagement/excise/exclude).
// Rationale: asymmetric caps create a vector where reinforcement outlives
// forgetting (or vice-versa) — audit-hostile. Three is the smallest cap that
// matches the typical operator narrative ("the event that derived from the
// event that derived from the fact") and matches the convergence target with
// the BEHAVIOR tier draft.
PROPAGATION_DEPTH_MAX: 3,                // v0 TUNABLE

// Per-hop multiplicative damping factor for the propagation formula.
// d=1 contributes base * 1.0 (no damping at direct parent — see § 4.2)
// d=2 contributes base * 0.5
// d=3 contributes base * 0.25
// Beyond d=3 propagation is gated by THRESHOLD_FLOOR before depth cap kicks in.
DECAY_PER_HOP: 0.5,                      // v0 TUNABLE

// Propagation-stop floor. propagated_strength < THRESHOLD_FLOOR halts the
// BFS branch (no row written, no descendants of this node visited). Bounds
// work in pathological wide-fanout graphs even when DEPTH_MAX is generous.
THRESHOLD_FLOOR: 0.01,                   // v0 TUNABLE

// Recall-time multiplicative dampener applied to the candidate score AFTER
// score-candidate.js computes the multi-feature score. NOT applied during
// BFS; this is a discrete state → multiplier table.
LIVE_DAMPENER: 1.0,                      // fixed (not tunable; identity)
PARTIAL_ORPHAN_DAMPENER: 0.6,            // v0 TUNABLE
ORPHAN_DAMPENER: 0.2,                    // v0 TUNABLE

// Threshold for partial → full orphan flip. When
//   count_excised(parents) / count_total(parents) > ORPHAN_FLIP_RATIO
// the descendant flips from partially_orphaned to orphaned. Strict > so
// 50/50 exactly stays partial (favors retention of provenance).
ORPHAN_FLIP_RATIO: 0.5,                  // v0 TUNABLE
```

Bare-name re-export block (after line 726 of `validation.js`):

```js
export const PROPAGATION_DEPTH_MAX = CAPS.PROPAGATION_DEPTH_MAX;
export const DECAY_PER_HOP = CAPS.DECAY_PER_HOP;
export const THRESHOLD_FLOOR = CAPS.THRESHOLD_FLOOR;
export const LIVE_DAMPENER = CAPS.LIVE_DAMPENER;
export const PARTIAL_ORPHAN_DAMPENER = CAPS.PARTIAL_ORPHAN_DAMPENER;
export const ORPHAN_DAMPENER = CAPS.ORPHAN_DAMPENER;
export const ORPHAN_FLIP_RATIO = CAPS.ORPHAN_FLIP_RATIO;
```

### 3.2 Constants table (cross-tier reference card)

| name | v0 value | tunable | channel(s) | reason for value |
|---|---|---|---|---|
| `PROPAGATION_DEPTH_MAX` | 3 | yes | E, X, EX | Matches transitive-orphan BFS reach and behavior-tier draft. Three hops covers "fact → reconstructed → reconstructed-of-reconstructed" — the deepest typical narrative chain. |
| `DECAY_PER_HOP` | 0.5 | yes | E, X, EX | Single value across channels keeps audit story uniform: "each hop halves the signal." |
| `THRESHOLD_FLOOR` | 0.01 | yes | E, X, EX | Two orders of magnitude below the typical engagement strength (1.0); cuts long tails. |
| `LIVE_DAMPENER` | 1.0 | no | X | Identity; live reconstructions score unchanged. |
| `PARTIAL_ORPHAN_DAMPENER` | 0.6 | yes | X | Intermediate between live (1.0) and orphan (0.2) — partial-orphan reconstructions still surface but rank below live siblings. |
| `ORPHAN_DAMPENER` | 0.2 | yes | X | Strong demotion (5×) but **non-zero** — fully orphaned reconstructions remain auditable in recall, not deleted. |
| `ORPHAN_FLIP_RATIO` | 0.5 | yes | X | Strict majority of parents excised. 50/50 stays partial (provenance-preserving default). |

Channel legend: **E** = engagement, **X** = excise, **EX** = exclude.

### 3.3 Constants explicitly **not** in this spec

These constants are owned by adjacent specs and are referenced (not redefined) here:

| name | owner spec | usage in this spec |
|---|---|---|
| `MAX_DERIVATION_DEPTH` | `kb/transitive-orphan-design.md` | The existing 16-hop BFS depth cap for the fact-tier transitive-orphan walk. This spec's `PROPAGATION_DEPTH_MAX = 3` is a **separate**, **tighter** cap applied only to the reconstructed-kind portion of the walk. |
| `TRANSITIVE_ORPHAN_DESCENDANTS_CAP` | `kb/transitive-orphan-design.md` | Total-nodes-visited cap; inherited by this spec — pathological-graph overflow still emits `policy.recall.transitive_orphan_cap_exceeded`. |
| `DERIVATION_STATUS_*` (NORMAL/ORPHAN/FLOOR/LAMBDA) | `kb/transitive-orphan-design.md` § 4 | Fact-tier depth-aware exponential dampener. Untouched. This spec adds the **discrete** dampener (`LIVE/PARTIAL/ORPHAN`) for the reconstructed kind only. |
| `DAMPING_INHERITED_STRENGTH_MAX` | `F-SYN-FOUNDATION-recall-log-split` § 4.4.3 | Cap (0.5 v0) on the `inherited_strength` field of the `engagement_inherited` row written by this spec. |

---

## 4. Schemas

### 4.1 Forward-edge derivation graph (extension to `F-SYN-SUBSTRATE-derivation-graph`)

The substrate-tier graph already provides `reverseAdj: Map<ancestor_id, Set<descendant_id>>` (per `kb/transitive-orphan-design.md` § 2). This spec adds:

```ts
// In-memory derivation graph (recomputed on ledger mtime change; same cache
// discipline as reverseAdj).
type DerivationGraph = {
  // Existing — used by the EXCISE channel.
  reverseAdj: Map<string /*ancestor_id*/, Set<string /*descendant_id*/>>;

  // New — used by the ENGAGEMENT channel. For each reconstructed event,
  // its `derived_from[]` array, indexed by event id. (For fact/policy events
  // this map has no entry — engagement does not propagate from non-reconstructed
  // events because they ARE evidence; see STOP-AT-EVIDENCE rule § 4.4.)
  forwardAdj: Map<string /*reconstructed_id*/, string[] /*parent_ids in derived_from order*/>;

  // New — populated for each reconstructed event from its kind tag at scan time.
  // Used by STOP-AT-EVIDENCE: the BFS halts at the first non-"reconstructed" kind.
  kindOf: Map<string /*memory_id*/, "fact" | "policy" | "reconstructed">;
};
```

The `forwardAdj` Map is a **redundant index** — `derived_from[]` is already on the reconstructed row. It exists for two reasons: (1) hot-path BFS does not re-read JSONL rows, and (2) the substrate-tier API contract is single-call `getForwardEdges(reconstructed_id)`, decoupling consumers from the row shape.

### 4.2 Propagation formula (canonical)

For each propagation channel, the **strength reaching depth d** is:

```
propagated_strength(base_strength, N_parents, d) =
  (base_strength / N_parents) * DECAY_PER_HOP^(d - 1)
```

where:

- `base_strength` ∈ [0, 1] is the channel's source-side magnitude (e.g. engagement strength).
- `N_parents` is the number of edges fanning out **at the source node only** (the SPLIT rule applies once at the entry to BFS, not at every hop — see § 4.3 invariant I-SPLIT-ONCE).
- `d` is the BFS distance in **edges** from the source node. `d = 1` means the direct parent (one edge traversed). `d = 0` is the source node itself (no propagation row written).

Why `^(d-1)` not `^d`: the direct parent is not double-damped. The SPLIT rule (`/ N_parents`) already accounts for the source's fanout; the per-hop decay is purely for **chain length** beyond that.

Worked numbers at `base_strength = 1.0`, `N_parents = 1`:

| d | propagated_strength | above floor? |
|---|---|---|
| 1 | 1.0 | yes |
| 2 | 0.5 | yes |
| 3 | 0.25 | yes |
| 4 | 0.125 | yes — but d=4 > PROPAGATION_DEPTH_MAX → DROPPED |

Worked numbers at `base_strength = 1.0`, `N_parents = 4`:

| d | propagated_strength | above floor? |
|---|---|---|
| 1 | 0.25 | yes |
| 2 | 0.125 | yes |
| 3 | 0.0625 | yes |

Worked numbers at `base_strength = 0.1`, `N_parents = 8`:

| d | propagated_strength | above floor? |
|---|---|---|
| 1 | 0.0125 | yes |
| 2 | 0.00625 | **no — < 0.01 → BFS branch halts** |

### 4.3 Inputs / outputs per channel

#### ENGAGEMENT channel

**Input** (from `F-SYN-INTEGRATION-engagement` or in-process from the recall scorer):

```ts
type EngagementInput = {
  source_memory_id: string;            // the engaged reconstructed event
  source_engagement_recall_id: string; // the recall event the engagement was observed in
  conversation_id_hash: string;        // scoping
  turn_window_id: string;              // canonical encoding from recall-log-split § 4.5
  base_strength: number;               // ∈ (0, 1]; from the engagement detector
};
```

**Output**: one `engagement_inherited` row written to the damping log (`F-SYN-FOUNDATION-recall-log-split` § 4.4.3) per (parent_id, source_engagement_recall_id, turn_window_id) tuple that passes THRESHOLD_FLOOR and is not deduplicated by NO-DOUBLE-CREDIT.

#### EXCISE channel

**Input** (loaded by `hard-gates.js` at recall time, same cache key as existing transitive-orphan BFS):

```ts
type ExciseInput = {
  excised_ids: Set<string>;            // direct-excise set (existing loader)
  graph: DerivationGraph;              // forward + reverse adjacency
};
```

**Output**: per reconstructed descendant `r`, a discrete state:

```ts
type DerivationStatusForReconstructed = {
  memory_id: string;
  derivation_status: "live" | "partially_orphaned" | "orphaned";
  count_excised_parents: number;       // |{p in derived_from(r) : p in excised_ids OR transitively orphaned}|
  count_total_parents: number;         // |derived_from(r)|
  distance_to_nearest_excised: number; // 1..PROPAGATION_DEPTH_MAX
};
```

#### EXCLUDE channel

**Input** (at recall time, per candidate):

```ts
type ExcludeInput = {
  candidate: ReconstructedEvent;          // the candidate being scored
  active_predicates: PredicateRow[];      // exclude predicate index
  excluded_parent_ids: Set<string>;       // computed by the predicate gate
};
```

**Output**: recomputed feature subset used in the multi-feature score for this candidate only:

```ts
type RecomputedFeatures = {
  entities_effective: string[];        // entities present in the surviving parents
  time_anchors_effective: string[];    // time_anchors from surviving parents
  surviving_parents_count: number;     // for the "all parents excluded" fallback
};
```

The recomputation is **not** persisted — the candidate's stored `features` are untouched. This is recall-time only per `architecture.md` § 5 (recall function is a fold over the ledger; landscape is a projection).

### 4.4 Decision rules (each pinned by name)

These rules apply uniformly to whichever channel they are named in. The rule names are intended to appear verbatim in code comments and test names so cross-tier specs can reference them.

#### Rule SPLIT (engagement only)

When a reconstructed event with `N = |derived_from[]|` parents is engaged with `base_strength`, each parent receives at most:

```
per_parent_at_d_eq_1 = base_strength / N
```

before per-hop decay. Without SPLIT, a 5-parent reconstruction would multiply total propagated reinforcement 5×, violating thesis Principle 5 (positive-feedback dominance). SPLIT applies **once** at the BFS entry; subsequent hops do not re-split (see invariant I-SPLIT-ONCE).

#### Rule STOP-AT-EVIDENCE (engagement only)

The engagement BFS terminates at the **first non-reconstructed node** along any path:

```
if (kindOf.get(next_node) !== "reconstructed") {
  write_row(next_node, propagated_strength);  // evidence still receives the row
  // do NOT enqueue next_node's parents
}
```

Evidence is the floor. Reconstructions of reconstructions of evidence terminate at the underlying evidence — but the evidence itself is the engagement target, not a transit hop. This honors the asymmetry "engagement crosses reconstruction boundary upward but stops at facts" called out in the design choice.

The EXCISE and EXCLUDE channels do **not** use STOP-AT-EVIDENCE: excise propagates over all `derived_from[]` edges of any kind (a reconstructed event derived from a reconstructed event derived from a fact orphans all of them when the fact is excised); exclude likewise applies wherever an excluded parent appears.

#### Rule NO-DOUBLE-CREDIT (engagement only)

The damping log row write is keyed by:

```
dedup_key = (parent_id, source_engagement_recall_id, turn_window_id)
```

If a parent is reachable via multiple paths from the same engagement source within the same turn window, **one row** is written (the one from the shortest path, i.e. the largest `propagated_strength`). Closes the feedback loop where parent fact `B` reinforced by reconstruction `R1` then later reinforced again by another reconstruction `R2` that **also derived from B in the same turn window** would otherwise double-credit `B`.

#### Rule ORPHAN-FLIP (excise only)

For each reconstructed descendant `r` with parents `P = derived_from(r)`:

```
excised_count = |{p in P : p in excised_ids OR derivation_status(p) === "orphaned"}|
total_count   = |P|
ratio         = excised_count / total_count

if    (excised_count === 0)                          → "live"
elif  (excised_count === total_count)                → "orphaned"
elif  (ratio > ORPHAN_FLIP_RATIO)                    → "orphaned"
else                                                 → "partially_orphaned"
```

Note the **strict greater-than** in the flip predicate: a 50/50 split stays partial. This is the provenance-preserving default — half of the parents are still live, so the descendant retains an audit trail.

A `partially_orphaned` ancestor counts as **excised** when computing the ratio for its descendants (transitivity). A `live` ancestor counts as live. This propagates the flip naturally through the BFS levels.

#### Rule DEPTH-CAP

All three channels share `PROPAGATION_DEPTH_MAX`. The BFS halts at any node whose depth exceeds the cap:

```
if (depth > PROPAGATION_DEPTH_MAX) {
  emit_cap_overflow_signal();  // informational policy event; one per recall
  return partial_results;
}
```

A single shared cap was chosen explicitly over per-channel caps (rejected alternative in the node design_choice): asymmetric caps would create the vector "reinforcement reaches further than forgetting" or vice versa, which is audit-hostile and offers no observable benefit.

#### Rule THRESHOLD-FLOOR (engagement only)

When `propagated_strength < THRESHOLD_FLOOR`:

- No `engagement_inherited` row is written for this node.
- BFS does not enqueue this node's parents.

The excise and exclude channels do not use THRESHOLD-FLOOR because their "strength" is discrete (orphan-or-not, excluded-or-not), not continuous. They are bounded by DEPTH-CAP and `TRANSITIVE_ORPHAN_DESCENDANTS_CAP` instead.

#### Rule CYCLE-DEFENSE

The derivation graph is a DAG **by spec** (a reconstructed event derives from events whose `id`s already exist in the ledger — append-only ordering forbids cycles). The BFS defends against violations via a `visited: Set<string>` initialized at the BFS entry:

```
if (visited.has(node.id)) continue;
visited.add(node.id);
```

A cycle would be a ledger-integrity bug; this defense exists so the BFS terminates gracefully rather than infinite-loops if such a bug occurs. The cycle case is **not** logged at the recall hot path (would be noise during the bug); it is caught by the validator at ledger-append time (see invariant I-DAG below).

---

## 5. Function signatures / Module surface

### 5.1 `mcp/lib/synthesis/derivation-propagation.js` (NEW — foundation-tier surface)

This module is the single export point for all three channel implementations. Behavior/integration tiers import from here; they do **not** re-implement the formula.

```ts
// Pure function. Called by F-SYN-INTEGRATION-engagement-detector-wiring when
// the engagement gate fires on a reconstructed candidate. Returns the rows
// to write to the damping log; does NOT itself write — the caller (an
// integration-tier module) owns the IO.
export function propagateEngagement(
  input: EngagementInput,
  graph: DerivationGraph,
  caps: typeof CAPS,
): EngagementInheritedRow[];

// Pure function. Called by mcp/lib/recall/hard-gates.js at the end of the
// existing transitive-orphan BFS. Takes the already-computed orphan map and
// adds the discrete derivation_status for reconstructed descendants.
export function classifyReconstructedDescendants(
  reverseAdjBfsOutput: Map<string, { distance_to_nearest_excised: number; transitive_orphan: boolean; rescued_by_corroboration: boolean }>,
  graph: DerivationGraph,
  excisedIds: Set<string>,
  caps: typeof CAPS,
): Map<string, DerivationStatusForReconstructed>;

// Pure function. Called by mcp/lib/recall/score-candidate.js per candidate
// that is of kind "reconstructed" AND has any active exclude predicate that
// matches at least one parent in derived_from[].
export function recomputeFeaturesAgainstSurvivingParents(
  candidate: ReconstructedEvent,
  excludedParentIds: Set<string>,
  parentRowsById: Map<string, FactOrPolicyOrReconstructedRow>,
): RecomputedFeatures;
```

All three functions are **pure** (no IO, no clock, no random) — the caller threads the graph/caps/parent rows in and writes the results out. This is the testability contract: every rule in § 4.4 has a unit test that calls these functions directly with fixed inputs.

### 5.2 Modified module surfaces

| file | change |
|---|---|
| `mcp/lib/validation.js` | Add seven CAPS (§ 3.1) plus their bare-name re-exports. Validator rejects unknown CAPS in the existing schema; adding them is enumerated, not pattern-matched, so each addition is mechanically reviewable. |
| `mcp/lib/recall/hard-gates.js` | After the existing transitive-orphan BFS produces its output map, call `classifyReconstructedDescendants` and merge the discrete `derivation_status` onto the candidate object (`candidate.derivation_status`, `candidate.count_excised_parents`, `candidate.count_total_parents`). |
| `mcp/lib/recall/score-candidate.js` (NEW per `F-SYN-FOUNDATION-recall-log-split` § 5.2) | After computing the multi-feature score, apply the dampener gate: `final_score = raw_score * dampenerFor(candidate.derivation_status)`. For reconstructed candidates with any excluded parents, replace `entity_overlap` and `time_anchor_overlap` inputs with the result of `recomputeFeaturesAgainstSurvivingParents`. |
| `mcp/lib/synthesis/derivation-graph.js` (touched by `F-SYN-SUBSTRATE-derivation-graph`) | Extend the existing reverse-adjacency scan to also populate `forwardAdj` and `kindOf` in one pass — adds no extra IO. |
| `mcp/lib/recall-feedback/damping-log.js` | Already accepts `engagement_inherited` rows per `F-SYN-FOUNDATION-recall-log-split` § 4.4.3. No change. |

### 5.3 The dampener-gate function (canonical implementation reference)

```js
// in score-candidate.js
import {
  LIVE_DAMPENER,
  PARTIAL_ORPHAN_DAMPENER,
  ORPHAN_DAMPENER,
} from "../validation.js";

function dampenerFor(status) {
  switch (status) {
    case "live":               return LIVE_DAMPENER;               // 1.0
    case "partially_orphaned": return PARTIAL_ORPHAN_DAMPENER;     // 0.6
    case "orphaned":           return ORPHAN_DAMPENER;             // 0.2
    default:
      // Non-reconstructed candidates (fact/policy) keep the existing
      // depth-aware DERIVATION_STATUS_ORPHAN dampener from
      // kb/transitive-orphan-design.md § 4 — this function is NOT invoked
      // on them; the caller dispatches by candidate.kind.
      throw new Error(`dampenerFor: unknown derivation_status: ${status}`);
  }
}
```

The throw-on-unknown is intentional: silent fallback would hide a status drift bug. The unit test `derivation-propagation.test.mjs` asserts the switch is exhaustive.

---

## 6. Decision rules — edge cases (table form)

| scenario | decision | rationale |
|---|---|---|
| Reconstructed `r` derives from 1 parent `p`; `p` is excised. | `r.derivation_status = orphaned` (ratio 1/1 = 1.0 > 0.5). | ORPHAN-FLIP at the unanimity case. |
| Reconstructed `r` derives from 3 parents; 1 is excised. | `partially_orphaned` (ratio 1/3 ≈ 0.33 ≤ 0.5). | Provenance preserved. |
| Reconstructed `r` derives from 3 parents; 2 are excised. | `orphaned` (ratio 2/3 ≈ 0.67 > 0.5). | Strict majority excised → flip. |
| Reconstructed `r` derives from 2 parents; 1 is excised. | `partially_orphaned` (ratio 0.5; **strict greater-than** in ORPHAN-FLIP). | The 50/50 case retains provenance — half of the parents remain live. |
| Reconstructed `r` derives from `r2`; `r2` derives from fact `f`; `f` is excised. | `r2.derivation_status = orphaned` (1/1); `r.derivation_status = orphaned` (transitive: r2 counts as excised for r). | Transitivity of ORPHAN-FLIP. |
| Reconstructed `r` derives from `r2` AND `f2` (live); `r2` derives from excised `f`. | `r2 = orphaned`; `r = partially_orphaned` (ratio 1/2 ≤ 0.5). | r retains f2 as live evidence. |
| Engaged reconstruction `r` with 4 parents at depth 1; `base_strength = 0.8`. | Each parent receives `0.8 / 4 = 0.2` rows at d=1; if any parent is reconstructed, BFS continues to its parents at d=2 with `0.2 * 0.5 = 0.1` per parent edge. | SPLIT then per-hop decay. |
| Engaged reconstruction `r`; all parents are facts. | One row per parent at d=1 with `base_strength / N` strength; BFS terminates (STOP-AT-EVIDENCE). | The engagement signal landed on the evidence floor. |
| Engaged reconstruction `r`; one parent is reconstructed `r2`, another is fact `f`. | At d=1: row for `r2` (continues BFS), row for `f` (BFS halts at f). At d=2 from `r2`: rows for `r2`'s parents. | Mixed-kind expansion. |
| Engaged reconstruction `r`; depth-3 ancestor exists. | Visited at d=3 (within DEPTH-CAP); descendants at d=4 are **not** visited. | DEPTH-CAP. |
| Engaged reconstruction `r`; same fact `f` is a parent and also a grandparent (via another reconstruction). | One row written for `f`, with strength from the **shortest** path (d=1, larger strength). NO-DOUBLE-CREDIT dedupe wins. | NO-DOUBLE-CREDIT. |
| Engaged reconstruction `r`; `base_strength = 0.05`; 8 parents. | At d=1: `0.05 / 8 = 0.00625`. **Below THRESHOLD_FLOOR (0.01)** — no rows written, BFS halts immediately. | THRESHOLD-FLOOR prevents trivial signal. |
| Excluded parent `p` matched by predicate at recall; `r` derives from `p` and `p2`. | `recomputeFeaturesAgainstSurvivingParents(r, {p})` returns `entities_effective = entities(p2)`, `time_anchors_effective = time_anchors(p2)`. Score for `r` uses these. | EXCLUDE channel; storage untouched. |
| Excluded parent `p` matched; `r` derives **only** from `p`. | `surviving_parents_count = 0`; `entities_effective = []`, `time_anchors_effective = []`. Score for `r` collapses entity_overlap and time_anchor_overlap to 0. (Score not zeroed entirely — embedding match still contributes.) | EXCLUDE fallback for total-mask. Avoids hiding the reconstruction entirely; the user can still see it via direct embedding match. |
| Excluded parent `p` matched; `r` has `derivation_status = orphaned` already (separately, via excise). | Both gates compose: dampener × recomputed-feature score. Multiplicative. | Orthogonal channels. |
| Engaged reconstruction `r` with `derivation_status = orphaned`. | Engagement still propagates upward to parents. Orphan status only affects `r`'s own surfacing score, not the propagation. | Excise dampens recall but does not block audit propagation. |
| Pathological cycle (ledger-integrity bug): `r1` derived_from `r2`, `r2` derived_from `r1`. | BFS terminates via CYCLE-DEFENSE `visited` set; no error logged at hot path. Ledger-append validator I-DAG catches the bug separately. | Hot-path resilience. |
| Excise event `excise(target=f, scope=…, silent=true)`. | EXCISE BFS still runs; descendants are dampened. No `policy.recall.transitive_orphan_*` event is emitted **for this excise** (silent semantics from operations.md § silent-excise paradox). The damping log entry kind `expunged` (from recall-log-split § 4.4.5) is the silent-excise audit channel. | Silent excise still propagates; only its visibility is silenced. |
| Operator manually re-derives a previously orphaned reconstruction (via a dedicated MCP tool — see § 8 open question). | A **new** reconstructed event is appended with fresh `id`, fresh `derived_from[]` (the now-surviving parents), fresh provenance. The old orphaned event remains in the ledger, demoted at recall. | Honors thesis Principle 1 (ledger is permanent) and Principle 7 (no silent agent writes). |

---

## 7. Worked examples

### Example 1: Engagement on a single-parent reconstruction

**Setup**:
- `f1 = fact("Alice's daughter is named Mira.", id=fct_A)`.
- `r1 = reconstructed("Alice has a daughter.", derived_from=[fct_A], id=rec_X)`.
- Operator engages with `rec_X` in conversation `conv_42` at turn 5.
- Engagement detector fires with `base_strength = 0.8`.

**Trace**:
1. `propagateEngagement({source: rec_X, base_strength: 0.8, ...}, graph, caps)`.
2. SPLIT: `N = |derived_from(rec_X)| = 1`; per-parent = `0.8 / 1 = 0.8`.
3. BFS from `rec_X`, d=1 visits `fct_A`. `kindOf(fct_A) = "fact"` → STOP-AT-EVIDENCE: write the row, do not enqueue.
4. `propagated_strength(0.8, 1, d=1) = 0.8 * 0.5^0 = 0.8`. Above THRESHOLD_FLOOR (0.01). Write.
5. Output: one `engagement_inherited` row, `memory_id = fct_A`, `inherited_strength = min(0.8, DAMPING_INHERITED_STRENGTH_MAX)`.

Note the cap from `recall-log-split` § 4.4.3 caps `inherited_strength ≤ 0.5` in v0 even though the formula yields 0.8 — that cap is enforced **at write time** by `damping-log.js`, not in `propagateEngagement` (separation of concerns; the formula is auditable per-tier).

### Example 2: Multi-parent reconstruction with mixed kinds

**Setup**:
- `f1 = fact("Bob lives in Seattle.", id=fct_B)`.
- `r1 = reconstructed("Bob is on the West Coast.", derived_from=[fct_B], id=rec_Y)`.
- `f2 = fact("Bob works at Acme.", id=fct_C)`.
- `r2 = reconstructed("Bob is a Pacific-Northwest tech worker.", derived_from=[rec_Y, fct_C], id=rec_Z)`.
- Engagement on `rec_Z`, `base_strength = 1.0`.

**Trace**:
1. SPLIT at `rec_Z`: `N = 2`; per-parent at d=1 = `0.5`.
2. d=1 visits `rec_Y` (reconstructed) and `fct_C` (fact).
3. Write rows:
   - `(memory_id=rec_Y, inherited_strength=0.5, derivation_depth=1)`.
   - `(memory_id=fct_C, inherited_strength=0.5, derivation_depth=1)`.
4. `fct_C`: STOP-AT-EVIDENCE — do not enqueue.
5. `rec_Y`: enqueue at d=2 with `propagated_strength = 0.5 * 0.5^1 = 0.25`.
6. d=2 visits `fct_B`. Write row `(memory_id=fct_B, inherited_strength=0.25, derivation_depth=2)`.
7. STOP-AT-EVIDENCE; BFS terminates.

**Output**: three `engagement_inherited` rows, one each for `rec_Y, fct_C, fct_B`, with strengths `[0.5, 0.5, 0.25]`. Total reinforcement = 1.25 (less than `base_strength * (1 + DECAY + DECAY^2) = 1.0 * 1.75` because SPLIT halved the source budget — this is intentional per Principle 5).

### Example 3: Excise propagation with partial orphan and corroboration rescue

**Setup**:
- `f1 = fact("$EMPLOYER paid $TOKEN on 2025-03-01.", id=fct_P)`.
- `f2 = fact("$EMPLOYER paid $TOKEN on 2025-04-01.", id=fct_Q)`.
- `r1 = reconstructed("$EMPLOYER pays $TOKEN monthly.", derived_from=[fct_P, fct_Q], id=rec_M)`.
- `r2 = reconstructed("$EMPLOYER is a paying employer.", derived_from=[rec_M], id=rec_N)`.
- Operator excises `fct_P` (employer asked to delete the March payment record).

**Trace** (at next recall after the excise):
1. Existing transitive-orphan BFS over `reverseAdj` from `fct_P`: visits `rec_M` (d=1), then `rec_N` (d=2). Both in the BFS output map with `transitive_orphan = true`.
2. Corroboration rescue: `rec_M` has source_refs from corroboration? Suppose no — keep in orphan map. `rec_N`: same — keep.
3. `classifyReconstructedDescendants` runs:
   - For `rec_M`: parents = `[fct_P, fct_Q]`. `fct_P` excised, `fct_Q` live. `count_excised = 1`, `count_total = 2`, `ratio = 0.5`. **Not** strictly > ORPHAN_FLIP_RATIO. Status: `partially_orphaned`.
   - For `rec_N`: parents = `[rec_M]`. `rec_M.derivation_status = partially_orphaned`. Per ORPHAN-FLIP transitivity: a `partially_orphaned` ancestor counts as excised when its descendants are evaluated. So `count_excised = 1, count_total = 1, ratio = 1.0`. Status: `orphaned`.
4. Score gate:
   - `rec_M` final score = raw_score × 0.6 (`PARTIAL_ORPHAN_DAMPENER`).
   - `rec_N` final score = raw_score × 0.2 (`ORPHAN_DAMPENER`).

The asymmetric outcome (`rec_M` partial, `rec_N` orphaned) is the intent: `rec_M` still has live evidence backing one of its claims; `rec_N` derives entirely from `rec_M` and inherits the doubt.

**Counterfactual**: if `fct_Q` were also excised, `rec_M` would flip to `orphaned` (2/2 > 0.5), and `rec_N` would already be `orphaned`. Both scored at 0.2.

**Counterfactual 2**: a new corroboration event lands stating "$THIRD_PARTY confirms $EMPLOYER pays $TOKEN monthly" with `source_ref.target_memory_id = rec_M`. The corroboration-rescue step removes `rec_M` from the orphan map → `derivation_status = live`. `rec_N` then re-evaluates: parents = `[rec_M (live)]`, `count_excised = 0`, status = `live`. The chain resurrects via corroboration without operator action — this is the answer to KEY DESIGN QUESTION 5 (excise + corroboration → recon resurrects, but only if the corroboration is independent of the excised parent).

---

## 8. Open questions (carried forward)

1. **Manual re-derivation MCP tool surface.** This spec accepts that auto-rederivation is wrong (violates user intent) and manual re-derivation is right. The tool surface itself is not pinned here — it belongs to `F-SYN-INTEGRATION-rederive-tool` (not yet drafted). Open question: should re-derivation be allowed on `orphaned` only, or also on `partially_orphaned`? Latter is more general; former matches the most common audit story.

2. **Episodicity recomputation in the EXCLUDE channel.** `F-SYN-FOUNDATION-episodicity-feature` depends on `entity_generality`. When parents are excluded at recall time, entity_generality of the descendant changes implicitly. Should `recomputeFeaturesAgainstSurvivingParents` also return a recomputed `episodicity_score`? Logically yes; cost-wise it triples the work per recall. v0 punts; v1 may add.

3. **Engagement double-credit across conversations.** NO-DOUBLE-CREDIT dedupes per `(parent_id, source_engagement_recall_id, turn_window_id)`. Two separate conversations both engaging with derivatives of the same parent **will** both credit the parent. This is intentional (parallel conversations are independent landscapes per Principle 2) but operator-visible drift if a single fact gets reinforced by N parallel sessions. Open question: should the calibration loop track per-conversation parent-credit budgets?

4. **STOP-AT-EVIDENCE for policy kinds.** `policy` events (`memory_corroborate`, `memory_replace`, etc.) are "evidence-shaped" for some purposes and "transit-shaped" for others. Current spec terminates BFS at any non-reconstructed kind — including policy. Is that right for `memory_corroborate`? A corroboration of a reconstruction is engagement-relevant evidence in its own right. v0 punts (treat as evidence-floor); revisit if behavior tier surfaces a need.

5. **Per-channel CAPS divergence under tuning.** The calibration loop may discover that engagement decay 0.5 is right but excise propagation needs a different reach. The current spec pins one `PROPAGATION_DEPTH_MAX` and one `DECAY_PER_HOP` for audit symmetry. If the calibration data demands divergence, the v1 contract change is non-trivial (every behavior-tier spec re-references). This spec marks them as `v0 TUNABLE` but does **not** pre-anticipate per-channel splits.

6. **Re-derivation as a damping-log signal.** Currently the user-driven re-derive emits a new reconstructed event. Should it also write a `signal_kind: "rederived"` row to the damping log, scoped to the original orphaned event id (so recall can know "this was rederived" without walking the ledger)? Open; integration tier owns.

---

## 9. Invariants (CI-enforceable)

| id | invariant | enforcement |
|---|---|---|
| **I-CAPS-NAMED-REFS** | No file under `mcp/lib/synthesis/` or `mcp/lib/recall/` contains inline values for `0.5`, `0.2`, `0.6`, `0.01`, `3`, or `0.2` in a numeric-literal position that grep can identify as a propagation constant. All references must go through `CAPS.PROPAGATION_DEPTH_MAX` / etc. | `mcp/test/synthesis/derivation-propagation-caps-named.test.mjs`: regex scan. Allowed exceptions enumerated explicitly in the test fixture. |
| **I-PROPAGATION-FORMULA** | `propagated_strength(base, N, 1) === base / N` for any `base, N`. `propagated_strength(base, N, d+1) === propagated_strength(base, N, d) * DECAY_PER_HOP`. | Unit test on `propagateEngagement` with fixture graphs of depths 1, 2, 3. |
| **I-SPLIT-ONCE** | The `/ N_parents` is applied once at BFS entry. Subsequent hops do not re-split even if intermediate nodes have their own multi-parent fanout. | Worked-example test: 2-parent root with one parent being a 3-parent reconstruction. Asserted output strengths. |
| **I-DEPTH-CAP** | `propagateEngagement` and `classifyReconstructedDescendants` both emit zero rows for any node at depth > `PROPAGATION_DEPTH_MAX`. | Synthetic graph with a depth-4 chain; assert depth-4 node is absent from output. |
| **I-STOP-AT-EVIDENCE** | After visiting a node with `kindOf !== "reconstructed"` in `propagateEngagement`, no successor of that node appears in the output. | Mixed-kind fixture; structural assertion on output node set. |
| **I-NO-DOUBLE-CREDIT** | For any `(parent_id, source_engagement_recall_id, turn_window_id)`, at most one row appears in the output of `propagateEngagement`. | Diamond-fanout fixture (`r → {p1, p2}; p1 → root; p2 → root`); assert one row for `root`. |
| **I-ORPHAN-FLIP-EXCLUSIVE** | A reconstructed descendant has `derivation_status ∈ {live, partially_orphaned, orphaned}`. Never undefined, never two of three. | Exhaustive table test on `(count_excised, count_total)` pairs for small `count_total ≤ 5`. |
| **I-ORPHAN-FLIP-RATIO-STRICT** | At `count_excised / count_total === ORPHAN_FLIP_RATIO` exactly, the status is `partially_orphaned`. | Boundary test at `2/4`, `5/10`. |
| **I-DAG** | At `memory_append` time for a `reconstructed` event, the validator rejects the row if any `derived_from[i]` is not present in the ledger OR if it would close a cycle (validator builds a tentative graph and runs Tarjan). | Existing ledger validator; extended test. |
| **I-THRESHOLD-FLOOR-HALTS** | `propagateEngagement` returns zero rows when `base_strength / max(1, N_parents)` is below `THRESHOLD_FLOOR`. | Direct test. |
| **I-DAMPENER-EXHAUSTIVE** | `dampenerFor(status)` covers all three states and throws on any other. | Switch-coverage test with an invalid status fixture. |
| **I-EXCLUDE-FALLBACK** | `recomputeFeaturesAgainstSurvivingParents(r, P_excluded)` with `P_excluded === derived_from(r)` returns `entities_effective = []` and `surviving_parents_count = 0`. | Direct test. |
| **I-STORED-FEATURES-UNCHANGED** | After a recall that triggered EXCLUDE recomputation on candidate `r`, the persisted row for `r` in the memory ledger has identical bytes to before. | Snapshot-diff test. |
| **I-AUTHORITATIVE-CONSTS** | `mcp/lib/validation.js` is the **only** file that contains the literal numeric values `3, 0.5, 0.01, 0.2, 0.6, 1.0, 0.5` in `CAPS.PROPAGATION_*` / `CAPS.DECAY_PER_HOP` / `CAPS.THRESHOLD_FLOOR` / `CAPS.*_DAMPENER` / `CAPS.ORPHAN_FLIP_RATIO` definition positions. Behavior-tier and integration-tier specs cite by name. | Grep-based CI scan over `docs/specs/synthesis/*.md` and `mcp/lib/**/*.js`. Specs may quote the value in **prose** (e.g. "v0 value is 0.5") only when adjacent to the CAPS name. |

---

## 10. Cross-tier impact

This node is the **upstream constraint** for the following downstream nodes. Each is pinned to reference the CAPS by name; inline values are tier-boundary violations.

| downstream node | what it inherits from this spec |
|---|---|
| `F-SYN-SUBSTRATE-DERIVATION-GRAPH` | Must expose `forwardAdj` and `kindOf` in addition to existing `reverseAdj`. § 4.1 schema. |
| `F-SYN-SUBSTRATE-RECONSTRUCTION-EMITTER` | At append time, validator must enforce I-DAG (cycle defense at the write surface, not just the read surface). |
| `F-SYN-BEHAVIOR-corroboration-propagation` | Prior draft used `MAX_CORROBORATION_DEPTH=3` and `0.5^depth`. **Superseded**: use `PROPAGATION_DEPTH_MAX` and the formula in § 4.2 with `^(d-1)`. The `engagement_inherited` row this behavior writes is keyed by NO-DOUBLE-CREDIT. |
| `F-SYN-BEHAVIOR-engagement-detector` | The detector computes `base_strength` per turn; the input to `propagateEngagement`. Detector does **not** decide propagation depth or formula — those live here. |
| `F-SYN-BEHAVIOR-forgetting-propagation-through-synthesis` | Prior draft used unrelated entity-mask logic. **Superseded**: forgetting propagation goes through `classifyReconstructedDescendants` (excise channel) — entity-mask logic is the EXCLUDE channel, scoped to recall-time per-candidate recomputation. |
| `F-SYN-FOUNDATION-recall-log-split` | This spec writes to the `engagement_inherited` row defined in § 4.4.3 of recall-log-split. Cap on `inherited_strength` (`DAMPING_INHERITED_STRENGTH_MAX = 0.5`) is enforced at write time **in damping-log.js**, not in `propagateEngagement` — preserves the formula's auditability. |
| `F-SYN-INTEGRATION-ENGAGEMENT-DETECTOR-WIRING` | Calls `propagateEngagement` from inside the engagement event handler. Owns the IO write to the damping log. |
| `F-SYN-INTEGRATION-DERIVATION-GRAPH-RECALL-PATHWAY` | Wires `classifyReconstructedDescendants` into the existing `hard-gates.js` transitive-orphan BFS output. |
| `F-SYN-INTEGRATION-MULTI-FEATURE-SCORE-WIRING` | Wires the `dampenerFor(status)` multiplicative gate and the EXCLUDE-channel feature recomputation into `score-candidate.js`. |
| `F-SYN-OPERATIONAL-damping-calibration-loop` | Owns the version-bump path for all seven CAPS in § 3.1. Reads soak data; proposes new values; emits a `policy.calibration.caps_bump` event; CI gate validates the bump. |
| `F-SYN-OPERATIONAL-drift-detection` | Monitors `engagement_inherited` row volume per conversation; alerts on drift from the calibration-loop's expected band. |

---

## 11. Reference: answering the KEY DESIGN QUESTIONS

| # | question | answer |
|---|---|---|
| 1 | Forward vs reverse graph: when does the system walk parent→child vs child→parent? | **Engagement** walks child (engaged reconstructed) → parent (forward traversal of `derived_from[]`). **Excise** walks parent (excised fact) → child (reverse traversal via `reverseAdj`). **Exclude** does **not** walk — it inspects the candidate's `derived_from[]` directly and recomputes features. |
| 2 | Multi-parent merge: 3 parents, 1 excised — survive or orphan? | `partially_orphaned` (ratio 1/3 = 0.33 ≤ ORPHAN_FLIP_RATIO 0.5). The descendant retains live evidence and scores at 0.6× dampener. See § 6 table and Example 3. |
| 3 | Bounded depth: are walks capped at PROPAGATION_DEPTH_MAX? | **Yes, all three channels.** Single shared cap of 3. Rejected per-channel caps as asymmetric. |
| 4 | Cycle prevention: A derives from B; B from A? | Prevented at **write time** by validator I-DAG (`memory_append` rejects rows that would close a cycle). At **read time** the BFS defends with a `visited` Set — terminates gracefully if the validator was bypassed. |
| 5 | Excise + corroboration: if X excised but later corroborated independently, does the recon resurrect? | **Yes**, automatically. The existing corroboration-rescue step in `kb/transitive-orphan-design.md` § 2 removes the descendant from the orphan map when its corroboration projection includes a non-excised source. `derivation_status` flips back to `live` at the next recall. See Example 3 Counterfactual 2. |

---

## 12. Appendix — change log relative to the node's revision

This spec is generated from `F-SYN-FOUNDATION-derivation-propagation` after the `WU-propagation-constants` revision (`2026-06-18`). All eleven `changes_made` entries from the revision step are reflected:

- Dependency `F-SYN-FOUNDATION-recall-log-split` honored in § 1 and § 10.
- CAPS pinned in § 3.1 with `v0 TUNABLE` flags.
- Depth cap converged at 3; formula `0.5^(d-1)` in § 4.2.
- Single shared cap across channels per § 4.4 Rule DEPTH-CAP.
- SPLIT rule in § 4.4.
- STOP-AT-EVIDENCE in § 4.4.
- THRESHOLD_FLOOR=0.01 in § 4.4 and § 3.1.
- NO-DOUBLE-CREDIT in § 4.4.
- ORPHAN_FLIP_RATIO=0.5 in § 4.4 Rule ORPHAN-FLIP.
- `open-problems.md #8` cited in § 2 A8.
- Implementation hints reference constants by NAME only in § 5.
