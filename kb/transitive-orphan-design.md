# Transitive derivation-orphan propagation at recall time (Phase 3 v0+)

Status: design record. The design is implemented in `mcp/lib/recall/hard-gates.js` (see `agent-integration.md` § Transitive derivation-orphan propagation at recall time for the shipped behaviour).
Authoritative spec parent: `research-retrieval-frontiers.md` § Risks #10 +
"Recommended Phase 3 architecture" Layer 2. Authoritative shape parent:
`phase3-v0-contracts.md` § 1 (IndexEntry), § 3 (ScoreComponents), § 5 (recall
ledger event extension), § 8 (CAPS).

Cross-spec consumers: `agent-integration.md` § Failure modes, `mcp-surface.md`
§ `memory_excise` (derivation_policy semantics), `architecture.md` § 4
(`derived_from`) and § 5 (Derivation graph index).

---

## 1. Precise semantics

**Definition.** An event `E` is a *transitive orphan* iff there exists a path
through `derived_from` edges of length `d ≥ 1` from `E` back to some event
`B` such that `B` is the target of an active (non-rescinded), non-`silent`,
`derivation_policy in {"drop", "re_derive_without"}` excise event, AND every
edge on that path connects events whose `derivation_status` would otherwise
be `NORMAL` (i.e. the path is unbroken by a `derivation_policy: "retain"`
ancestor — see corroboration rescue below). The depth `d` to the nearest
excised ancestor is the *orphan distance*. `d = 1` is the v0 "direct orphan"
case; `d > 1` is what this design adds.

**Relaxed vs strict.** We adopt the **RELAXED** rule: *any* excised ancestor
along the chain marks the descendant. Justification: derivation is a
semantic-provenance edge ("this fact is what I concluded from those"), and an
excise expresses "I do not want that fact's content to influence recall."
Strict (immediate-parent-only) would let the user's excise be silently
laundered through one intermediate inference — the exact failure mode
`research-retrieval-frontiers.md` Risk #10 forbids. Relaxed is also
algorithmically equivalent to "is reachable in the forward derivation graph
from any excised seed," which is what Risk #10's "transitive excise" phrase
literally means.

**Treatment.** Orphans are *flagged*, not dropped. This preserves v0
behavior — `derivation_status` is a multiplicative gate (0.5) that the
multi-feature score multiplies in, the embedding signal can still pull the
candidate through if it is overwhelmingly relevant, and the recall-log
records the (now depth-aware) flag for future learners. Dropping would lose
information v3 will need (engagement on orphan-surfaced items is a signal
about how aggressively to demote in future). The orphan is dropped only when
its `derivation_status` × `predicate_mask` × `consent_dampener` collapses
the multiplicative base to within numerical noise of zero (the existing
post-rescore drop path; no new mechanism needed).

**Corroboration rescue (resolved).** A descendant that *also* carries an
independent, non-excised source via a `corroboration`-kind policy event is
NOT an orphan even if a `derived_from` ancestor is excised. Reasoning: the
corroboration event provides an alternative provenance path that the excise
did not touch; treating it as orphan would over-propagate the excise into
content the user never asked to forget. Implementation: after the BFS-forward
walk produces a candidate orphan set, we re-check each candidate against the
corroboration projection (`architecture.md` § 5) and *un-flag* any candidate
whose effective `source_refs[]` set contains at least one non-excised entry
that is *not* itself derived from an excised ancestor. This is a single
extra projection-join after the BFS, O(orphan_count × avg_source_refs).

**`memory_replace` / `memory_substitute` interactions (resolved).**
`memory_replace` is *excise-with-replacement*: it appends a `policy` row
with `policy_kind: "replace"` targeting both `old_id` and `new_event_id`
(per `mcp-surface.md` § `memory_replace`). For orphan purposes the
*replacement* row is the canonical content from the policy's `applied_at`
forward; the *old* row is not in the excise set (it is superseded, not
excised). Descendants of `old_id` are NOT flagged as orphans on the basis
of `memory_replace` alone — `replace` is a non-destructive supersession,
not a deletion. `memory_substitute` is the same: the substitute reframe
event becomes a sibling, the original stays in the ledger, no orphan
propagation. Only `memory_excise` (with `derivation_policy in {"drop",
"re_derive_without"}`) seeds the transitive walk. `derivation_policy:
"retain"` excise events DO NOT seed orphan propagation by definition — the
user explicitly asked to keep descendants alive.

**`silent: true` excise.** Silent excise stays opaque to recall by
construction — its targets are not visible to the recall layer, and we do
NOT include them in the transitive seed set. The silent-excise audit
channel is the only consumer; the orphan walk treats silent-excise events as
nonexistent. (This matches `mcp-surface.md` § silent-excise paradox.)

---

## 2. Algorithm

**Pre-pass (once per ledger mtime).** Build the reverse adjacency:

```
reverseAdj: Map<ancestor_id, Set<descendant_id>>
```

Single pass over `ledgers/memory.jsonl`. For each event `E` with
`E.derived_from = [a_1, ..., a_k]`, for each `a_i`, add `E.id` to
`reverseAdj.get(a_i)`. `O(facts × avg_derivation_fanin)` = O(facts) at
expected fanin (avg 1–4 per `architecture.md` § 4).

**Seed set.** From the existing `loadDerivationExciseSet` (already in
`hard-gates.js`), filter to `silent !== true` AND `derivation_policy in
{"drop", "re_derive_without"}` (or unset — treated as "drop" per
`mcp-surface.md` default). The current loader returns the full
direct-excise Set; we add a sibling loader `loadTransitiveSeeds` that
applies the policy filter.

**Forward BFS.** From the seed set, BFS over `reverseAdj`. For each visited
descendant `d`, record `distance_to_nearest_excised = depth_in_BFS`. Use a
single visited Set so a node visited at a shorter distance is not later
relaxed (BFS guarantees first-visit = shortest path in unweighted graphs).
Cap depth at `CAPS.MAX_DERIVATION_DEPTH = 16`; cap total visited at
`CAPS.TRANSITIVE_ORPHAN_DESCENDANTS_CAP = 10000`. On cap-overflow, emit one
`policy.recall.transitive_orphan_cap_exceeded` event (informational) and
return what has been discovered — partial coverage is preferable to a
latency spike. Cycles (which should not occur given derivation is a DAG by
spec) are defended by the visited Set.

**Corroboration rescue.** For each `d` in the orphan map, load its
effective `source_refs[]` (corroboration projection per `architecture.md`
§ 5). If any entry's `source_ref.target_memory_id` (when the corroboration
itself points at a fact) is NOT in the seed set AND not in the orphan map,
remove `d` from the orphan map. Single pass; O(orphan_count ×
avg_corroborations).

**Output.**

```
Map<memory_id, {
  distance_to_nearest_excised: number,  // 1..MAX_DERIVATION_DEPTH
  transitive_orphan: boolean,           // true iff in map post-rescue
  rescued_by_corroboration: boolean     // true iff was in BFS output but
                                        // removed by rescue
}>
```

`applyHardGates` looks up each candidate by `memory_id` in this map and
assigns `derivation_status` via the depth-aware formula below. Candidates
absent from the map keep `derivation_status = DERIVATION_STATUS_NORMAL`.

**Cache key.** `(ledger_mtime, ledger_size)` — same discipline as
`loadDerivationExciseSet` will inherit; bust on any change. The map is
recomputed at recall-time only when the cache key changes (typical
~hundreds of recalls between excises).

---

## 3. Cost model

At `N = 10^k` facts with avg derivation fanin `f ≈ 2` and excise rate
`r ≈ 1%`:

| stage | cost | N=10³ | N=10⁴ | N=10⁵ |
|---|---|---|---|---|
| reverse-adj build | O(N) | <5ms | ~30ms | ~200ms |
| seed-set load | O(N) | <5ms | ~30ms | ~200ms |
| BFS reachability | O(r·N · branching) | <1ms | ~5ms | ~30ms |
| corroboration rescue | O(orphan·refs) | <1ms | ~2ms | ~10ms |
| cached recall (no ledger change) | O(1) lookup per candidate | <0.1ms | <0.1ms | <0.1ms |

Memory: reverse-adj Map holds ~`N` entries with avg-`f` Sets — ~40–80
bytes/edge — bounded by `10^5 × 2 × 64B = 13MB`, well under any concern.

Worst case (`excise the root of a fanout-of-1000 graph`):
`CAPS.TRANSITIVE_ORPHAN_DESCENDANTS_CAP = 10000` bounds the walk; latency
stays under ~50ms even when triggered. The cap is logged as a known
limitation; v2 may replace BFS with incremental graph maintenance.

---

## 4. Scoring impact

**Decision: depth-aware dampener, NOT boolean.**

```
derivation_status =
  candidate not in orphan_map   ? CAPS.DERIVATION_STATUS_NORMAL
                                : max(
                                    CAPS.DERIVATION_STATUS_ORPHAN_FLOOR,  // 0.25
                                    exp(-LAMBDA * (d - 1))                // d=1 → 1.0·ORPHAN, d=∞ → floor
                                      * CAPS.DERIVATION_STATUS_ORPHAN     // 0.5 anchor
                                  )
```

With `CAPS.DERIVATION_ORPHAN_LAMBDA = 0.4`:

| distance d | derivation_status |
|---|---|
| 1 (direct, v0 compat) | 0.50 |
| 2 | 0.335 |
| 3 | 0.225 → floored to 0.25 |
| 4+ | 0.25 |

Justification: v0 boolean would collapse the "directly excised parent"
case (which we are highly confident is contaminated) with the "great-great-
grandchild of an excise" case (which is plausibly far removed and might
just share a single ancestor by coincidence). Depth-aware preserves the
information; the `LAMBDA = 0.4` choice keeps `d=1` at exactly the v0 value
(0.5) so this is a strict superset of the v0 behavior. The floor
`0.25` prevents the gate from collapsing to numerical noise at deep
chains — the multi-feature score remains expressive enough that the v3
learned ranker can override aggressively when engagement justifies.

**Backward-compat.** `d=1` is preserved at `DERIVATION_STATUS_ORPHAN = 0.5`
exactly. Every existing test that asserts the v0 direct-orphan value
continues to pass.

---

## 5. Spec changes

### `kb/agent-integration.md`
- § Failure modes / Token-event ownership table: add row
  `policy.recall.transitive_orphan_cap_exceeded` with producer
  `recall.js` (or `hard-gates.js`); rare informational event.
- (Optional) brief note under § Identity across runtimes that orphan
  propagation crosses runtime boundaries — it follows the derivation
  graph, not the chat-ledger.

### `kb/phase3-v0-contracts.md`
- § 1 IndexEntry: change `derivation_orphan: boolean` to
  `derivation_distance: number | null` — `null` for normal,
  `1..MAX_DERIVATION_DEPTH` for orphan. Add a derived boolean accessor in
  prose ("`is_orphan = derivation_distance != null`"). Keep boolean form
  in serialized form ONLY in the recall-log feature_breakdown for v3
  backwards-compat with already-logged events; new fields are additive.
- § 3 ScoreComponents: `derivation_status` stays a number (already is).
  Document the depth-aware formula in prose with the CAPS reference.
- § 5 recall-log feature_breakdown: add field
  `derivation_distance: number | null` alongside `derivation_status`.
  Off-policy estimators (v3) read both — the raw distance and the gate
  value. Existing `derivation_status` field shape unchanged.
- § 8 CAPS additions: add
  - `MAX_DERIVATION_DEPTH = 16`
  - `TRANSITIVE_ORPHAN_DESCENDANTS_CAP = 10000`
  - `DERIVATION_STATUS_ORPHAN_FLOOR = 0.25`
  - `DERIVATION_ORPHAN_LAMBDA = 0.4`

### `kb/research-retrieval-frontiers.md`
- Open question #10 ("`memory_excise` transitive propagation through
  derivation_graph at recall time"): move from "open" to "resolved in
  `transitive-orphan-design.md`; v0+ scope." Keep the question text;
  add resolution-pointer.

### `kb/mcp-surface.md`
- § `memory_excise`: no API change. Add prose note: "Recall layer
  propagates `derivation_policy: drop` / `re_derive_without` excise
  events forward through the derivation graph at recall time; see
  `kb/transitive-orphan-design.md`. `derivation_policy: retain` does
  not propagate."

### `kb/architecture.md`
- § 5 (Derivation graph index): add prose paragraph noting that the
  graph is *also* the seed of forward propagation for orphan flagging
  at recall, and the corroboration projection acts as a rescue check.

---

## 6. Contracts updates summary

`IndexEntry.derivation_orphan: boolean` → `derivation_distance: number | null`.
Recall-log gains `feature_breakdown.derivation_distance: number | null`.
`ScoreComponents.derivation_status` formula becomes depth-aware (number
unchanged). Four new CAPS. No new top-level fields; no event-schema
mutations; no MCP surface changes.

---

## 7. Test plan (for the implementation agent)

All tests hermetic per § 11 of `phase3-v0-contracts.md` (`MEMORY_ROOT`,
`POLICY_BASE_DIR`, `STORAGE_BASE_DIR`, `LEDGERS_BASE_DIR` → `mkdtempSync`
paths set BEFORE dynamic import).

1. **Regression: direct orphan still flagged at 0.5.** Ledger with one
   fact `B`, one `excise(B)`, one fact `A` with `derived_from = [B]`.
   Recall over `A` → `derivation_status = 0.5`, `derivation_distance = 1`.
2. **2-deep transitive.** `B → A → C`, excise `B`. `C.derivation_distance = 2`,
   `derivation_status = 0.335`.
3. **4-deep transitive.** `B → A → C → D → E`, excise `B`. `E.distance = 4`,
   `derivation_status` floored to `0.25`.
4. **Cycle defense.** Construct ledger with `derived_from` that introduces
   a cycle (`A.derived_from = [B]`, `B.derived_from = [A]`). The visited
   set must terminate; assert no infinite loop, both `A` and `B` orphan-
   flagged at their first-visited depth.
5. **Cap overflow.** Synthetic ledger with a single seed exciting a fanout
   chain of `> TRANSITIVE_ORPHAN_DESCENDANTS_CAP` descendants. Assert the
   walk terminates at the cap, emits the `policy.recall.transitive_orphan_
   cap_exceeded` event, and the first 10000 descendants ARE flagged.
6. **Corroboration rescue.** `B → A`, excise `B`, but `A` has a
   `corroboration` policy event linking to a non-excised source `S`. Assert
   `A.transitive_orphan = false`, `A.rescued_by_corroboration = true`,
   `derivation_status = 1.0`.
7. **`memory_replace` does NOT propagate.** Ledger with `memory_replace(B,
   B')` (i.e. policy row, no excise). `A` derived from `B`. Assert `A` is
   NOT orphan.
8. **Silent excise is opaque.** Excise(B) with `silent: true`. `A` derived
   from `B`. Assert `A` is NOT orphan (silent excises are not seeds for the
   recall-side walk; the audit channel is the only consumer).
9. **`derivation_policy: "retain"` excise does NOT propagate.** Excise(B,
   retain). `A` derived from `B`. Assert `A` is NOT orphan; the user opted
   into keeping descendants live.
10. **Rescinded excise does NOT propagate.** Excise(B), then rescind the
    excise via `memory_rescind_policy`. `A` derived from `B`. Assert `A`
    is NOT orphan.
11. **Performance.** Synthesize a ledger with `10^4` events, random
    derivation graph at avg fanin 2, 10% excise rate. Measure: recall
    cold-cache adds < 100ms to the existing recall path; warm-cache adds
    < 5ms.
12. **Cache invalidation.** Run recall, then append an excise event,
    re-run recall. Assert the new excise is reflected (cache busted on
    mtime+size change).

Coverage matrix:
- direct (depth 1): #1
- transitive (depth 2, 4, deep): #2, #3, with floor at #3
- defensive: #4 (cycle), #5 (cap)
- semantics: #6 (corroboration), #7 (replace), #8 (silent), #9 (retain),
  #10 (rescind)
- perf: #11
- caching: #12

---

## 8. Out-of-scope / deferred

- **Incremental graph maintenance.** v2+ may persist `reverseAdj` and
  apply incremental upserts on ledger append, eliminating the full-scan
  rebuild. Out of scope for v0+; the cache-on-mtime path is sufficient
  through `N = 10^5`.
- **PPR / graph-attention orphan propagation.** `research-retrieval-
  frontiers.md` v2 already plans HippoRAG-2-style PPR over the derivation
  graph; once that lands, the BFS reachability check folds into the PPR
  score directly. This design is the bridge between v0's shallow-orphan
  and v2's PPR-graph.
- **Inferred orphans from `consent_basis` changes.** A consent-revocation
  on a source event is NOT an excise; it should change the dampener, not
  flag the descendant as orphan. No additional logic needed here.
