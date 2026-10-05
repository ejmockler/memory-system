# Reconciliation Policy — Contradictions Between Reconstructed Events and Facts

> Foundation contract — `F-SYN-FOUNDATION-reconciliation-policy-spec`.
> Resolves `open-problems.md #6 (Reconsolidation policy)` — the contradiction branch.
> Authoritative pin for what happens when a `reconstructed` event (proposed or just appended) contradicts a parent `fact`, another `reconstructed` event, or an active operator policy.

---

## Mission

The W7 spec (`reconstructed-trigger.md`) pinned the TRIGGER for emitting `reconstructed` events: who is allowed to call `emitReconstruction`, what the agent-path classifier looks for, what the daemon-path admission gates require, and how each path threads `derived_from[]` to its parents. The W7 spec is silent, by design, about a separate and equally load-bearing question: **what if the freshly proposed reconstruction contradicts the very parents it claims to derive from?** Or worse — what if it contradicts a different `reconstructed` event already on the ledger, or an active `policy.exclude` the user emitted to forbid exactly this content?

`open-problems.md #6` names the gap honestly: the reconstructed kind exists in the ledger to capture conversational re-derivation, but the trigger boundary is fuzzy and "will need tuning." The reconstructed-trigger spec resolved the trigger boundary. This spec resolves the **contradiction boundary** that surfaces only AFTER the trigger fires — the moment the system holds, in working memory, both the proposed new row and a logical adversary on the ledger.

The spec is on-thesis:

- `thesis.md §1` — the ledger is permanent; the landscape is a projection over it. Nothing this spec does mutates a parent fact or rewrites a prior reconstructed row.
- `thesis.md §6` — provenance threaded everywhere; every contradiction outcome leaves an inspectable derivation trail (the contradicted ids are pinned on the new row; `policy.reconcile.*` events anchor every choice).
- `architecture.md §4` — four-kind taxonomy preserved; no fifth kind introduced. The new policy variants extend the existing `policy.policy_kind` enum.
- `research-retrieval-frontiers.md Risk #10` — A-MEM-style in-place memory evolution destroys provenance. This spec REJECTS in-place rewrites under every resolution pattern. SUBSTITUTE appends a new policy row; the superseded row stays immutable on the ledger.

The spec is on-precedent: it inherits the discipline that the W3-W9 reconstructed-trigger work established (shared validator+appender pattern; CAPS-knobs over hardcoded thresholds; structural screen at the substrate layer; per-path discriminator on `provenance.agent_id`). The W7 node's existing `design_choice` field — *"append-only reconciliation, never automated mutation; surface `reconciliation_required` for operator decision"* — is the BASE policy this spec specializes. This spec REFINES that base by enumerating three mechanical patterns the SYSTEM produces automatically (CO-EXIST as the default, EXCLUDE-REJECTED for hard policy contradictions, and the SUBSTITUTE *protocol* the user's MCP-issued substitute consumes), while preserving the no-auto-mutation invariant on every code path.

This spec defines:

1. **Contradiction detection** — when does the emitter even know two rows disagree? The pre-emit heuristic, the cosine-distance lift, and the entity-intersection × valence-sign-mismatch shortcut.
2. **Three resolution patterns** — `SUBSTITUTE`, `CO_EXIST`, `EXCLUDE_REJECTED` — each with a formal contract (what the ledger looks like after, what recall sees, what audit events fire).
3. **Decision algorithm** — given a new emission + a detected contradiction, choose a pattern mechanically. Inputs: confidence delta, scope alignment, conversation_id overlap, presence of an authority-tier `policy.exclude` or `policy.fact_excluded`.
4. **Schema additions** — `reconstructed.contradicts: [memory_event_id]` on every emission that fired the detector; `reconstructed.resolution` enum; the new `policy.reconcile.substitute` and `policy.reconcile.co_exist` audit events.
5. **Recall-time consumption** — how the brief surfaces CO-EXIST clusters (both present, conflict tag) and how SUBSTITUTE clusters surface (only the superseder; the superseded row is silently excluded at the cascade gate).
6. **Three+ examples** — illustrative walk-throughs of each pattern.
7. **Invariants** — CI-enforceable contracts.
8. **Cross-tier impact** — substrate (`reconciliation.js` module), behavior (recall projection updates), recall (brief metadata extension).

The spec does NOT specify: (a) the user MCP surface for manually resolving a CO-EXIST cluster (that is `F-SYN-BEHAVIOR-forgetting-propagation-through-synthesis` territory); (b) the calibration of `SUBSTITUTE_CONFIDENCE_DELTA` (deferred to the operational calibration loop, same posture as W7's `RECONSTRUCT_MIN_CONFIDENCE`); (c) the cross-version embedding model handling for cosine-based contradiction detection (deferred to the embedding-model-upgrade work; flagged in open question O4).

---

## kb anchors

### A1. `open-problems.md #6 Reconsolidation policy` (verbatim)

> "Each recall is a rewrite of the recalled memory in the agent's working understanding. The `reconstructed` kind exists in the ledger to capture this, but the trigger is unclear:
>
> - Agent summarizations during a conversation should produce `reconstructed` events.
> - Pure read-and-cite recalls should not.
> - The boundary is fuzzy and will need tuning."

**Binding.** `reconstructed-trigger.md` (W7) resolved the trigger boundary. This spec resolves the *consequence* boundary downstream of the trigger: once a reconstructed event has fired and is sitting at the emitter's `assembleRow` step, what happens if the system detects that the proposed row contradicts an existing fact or another existing reconstruction. The "will need tuning" caveat carries over — every threshold below is a `CAPS.*` knob calibrated against operator labels via the existing offline-eval harness (cross-binding: `F-SYN-OPERATIONAL-held-out-labeled-set-v2`).

### A2. `thesis.md Principle 1 — The ledger is permanent` (verbatim)

> "The event ledger is append-only and authoritative. 'What the system currently believes' is the output of a function over that ledger, parameterized by the recall context. The landscape does not exist between recalls. Storing a current view is the temptation that erodes everything."

**Binding.** No pattern in this spec mutates a parent fact, no pattern overwrites a prior reconstructed row, no pattern silently deletes content. SUBSTITUTE is implemented as a NEW `policy.reconcile.substitute` row that points at `{superseder_id, superseded_id}`; recall projection consults that row to decide who wins. The superseded row stays on the ledger with its original content, its original `derived_from[]`, and its original `policy.reconstruct.emitted` audit trail. EXCLUDE_REJECTED rejects the new emission BEFORE it appends — there is nothing to rewrite; the only row that lands is the `policy.reconcile.exclude_rejected` audit event. CO_EXIST is the zero-mutation default — both rows live on the ledger; the projection surfaces both.

### A3. `thesis.md Principle 6 — Provenance threaded everywhere` (verbatim)

> "Every event carries source, time, parties, derivation links. Agent-emitted inferences declare what they were derived from. The derivation graph is what makes forgetting propagation possible — without it, a forgotten fact resurfaces through its derivatives."

**Binding.** Every reconstructed emission that the detector fires on records the contradicted ids in `reconstructed.contradicts: [memory_event_id]` — this is a NEW derivation-graph edge type (a *negative* edge), parallel to the existing positive `derived_from` edge. Every chosen resolution pattern produces a `policy.reconcile.*` event with `targets: [new_id, contradicted_ids[]]` AND `payload: { resolution, criteria_matched }`. Operators inspecting the ledger can answer the question *"why did the system surface only the new row at recall time?"* by walking from the new row's `contradicts[]` to the `policy.reconcile.substitute` event that fixed the choice.

### A4. `architecture.md §4 — Four-kind taxonomy` (paraphrase + binding)

The four kinds are `fact`, `policy`, `recall`, `reconstructed`. The `policy.policy_kind` enum is `exclude` | `replace` | `substitute` | `corroboration` | `rescind`.

**Binding.** This spec adds THREE new `policy.policy_kind` variants:

- `reconcile.substitute` — emitted when SUBSTITUTE pattern fires. Distinct from the existing `substitute` (which is manual content-transform) — `reconcile.substitute` is system-driven from a reconstructed-vs-parent contradiction, and its `payload` shape is different (see S4).
- `reconcile.co_exist` — emitted when CO_EXIST pattern fires (default). Records the contradiction in audit without changing the recall projection (both rows surface).
- `reconcile.exclude_rejected` — emitted when EXCLUDE_REJECTED pattern fires. The new emission was rejected before append; the audit row is the only persistent trace.

No fifth ledger kind. No fifth top-level enum. The `policy.policy_kind` field is the discriminator; the new variants share the `policy` event's existing `targets[] + payload` shape.

### A5. `research-retrieval-frontiers.md Risks #10` (paraphrase)

> "A-MEM-style memory evolution destroys provenance. Reject in-place rewrites. Reflection/promotion writes a NEW event with `derived_from[]` populated; parents stay immutable; semantic promotion is corroboration-gated."

**Binding.** SUBSTITUTE — the only pattern that could plausibly look like in-place rewrite — is implemented as a NEW row (the `policy.reconcile.substitute`) that points at the superseded row. The superseded row stays at its original ledger offset, its original content, its original embedding. No bytes change. The recall projection joins {fact_row, all reconcile.substitute rows targeting it} and consults the active substitute (if any) to decide who wins. This is the exact same projection-discipline pattern that `memory_substitute` (the user-facing tool) uses for content-transform; the reconcile variant inherits the discipline and the projection code path.

### A6. `reconstructed-trigger.md §AM4 — Daemon path bypass` (binding)

> "The daemon path satisfies the SAME structural validators as the agent path, run by the SAME `emitReconstruction` function."

**Binding.** Contradiction detection runs in the SHARED `emitReconstruction` function — meaning BOTH callers (agent path and daemon path) are subject to it. The daemon path does NOT get a free pass from the contradiction detector. Specifically: a thread-aggregator that composes a reconstructed event whose Gemini Flash output contradicts a parent fact's `valence.sign` is subjected to the same SUBSTITUTE/CO_EXIST/EXCLUDE_REJECTED decision as an agent-path emission. The two-caller convergence at the shared validator is what makes this guarantee enforceable.

---

## Contradiction detection

The detector runs as a NEW step in `emitReconstruction`, inserted between W7's step 8 (`extractFeatures`) and step 9 (`assembleRow`). The reason it lives at this position: it needs `features.embedding` (for cosine), `features.entities` (for entity overlap), and `features.valence_sign` (if W8 `valence-provenance.md` is shipped; if not, the detector falls back to entity-only mode — see D5 below).

The detection algorithm is a SHORT-CIRCUIT cascade — early returns are cheap, late returns mean a contradiction was found.

### D1. Walk the parent derivation graph (one hop)

For each `parent_id` in `input.parents`:

1. Look up the parent row in the index cache.
2. Walk the derivation graph FORWARD by one hop — find all reconstructed events that have THIS parent in their `derived_from[]`. Call this set `parent_children`.
3. Skip events in `parent_children` whose `provenance.conversation_id === input.conversation_id` (intra-conversation refinement — handled by SUBSTITUTE branch below, not by CO_EXIST detection).
4. For each remaining `child_id` in `parent_children`, run the contradiction test (D3) against `input.content`. If ANY child contradicts, accumulate to `contradicted_ids[]`.

The one-hop walk is bounded — `CAPS.RECONCILE_PARENT_CHILDREN_MAX = 32` (default). Beyond this cap the detector returns `code: RECONCILE_DETECTION_BUDGET_EXCEEDED` and falls back to the CO_EXIST default (append the new row, mark `reconstructed.contradicts: ["__detection_budget_exceeded__"]` as a sentinel for the user-inspection dashboard). This is the same "fail-open with audit" posture the recall layer's transitive-orphan BFS uses (`agent-integration.md § Transitive derivation-orphan propagation at recall time`).

### D2. Walk the parent itself (parent-vs-child direct test)

In addition to D1's sibling walk, the detector tests the parent ROW directly against the proposed reconstructed content:

For each `parent_id` in `input.parents`:

1. Compute `entity_overlap = |parent.features.entities ∩ input.features.entities|`. Reject early (no contradiction declared) if `entity_overlap === 0` — a reconstruction with no entity overlap with a parent is inferentially independent; the W7 R7 multi-parent overlap gate would have flagged this case anyway.
2. If `entity_overlap > 0`, run the contradiction test (D3) with the parent row as the candidate adversary.
3. If the parent contradicts, accumulate to `contradicted_ids[]`.

This is the WARRANT for the heuristic stated in the task description: *"parent.entities ∩ new.entities ≠ ∅ AND parent.valence.sign ≠ new.valence.sign suggests opposing claims."* The entity-intersection gate cheap-filters; the valence-sign mismatch (or, if no valence available, the embedding-cosine adversarial fallback) is the actual decision.

### D3. The contradiction test (per-candidate)

Given the proposed `input.content + input.features.embedding` and a candidate adversary row `cand`, return `is_contradiction: boolean` per:

- **Test 1 (preferred — requires `valence-provenance` to be shipped):** if `cand.features.valence.sign` AND `input.features.valence_sign` are both populated AND they differ (`+` vs `-`, or `+`/`-` vs `0` with abs(magnitude) ≥ `CAPS.RECONCILE_VALENCE_MAGNITUDE_GATE = 0.4`), declare contradiction.
- **Test 2 (fallback — when valence is not populated on either side):** compute cosine between `cand.features.embedding` and `input.features.embedding`. If `cosine < CAPS.RECONCILE_COSINE_ADVERSARY_GATE = -0.05`, declare contradiction. (Negative cosine indicates the embedding vectors point in OPPOSING semantic directions — embedding models trained with InfoNCE-style contrastive objectives produce near-orthogonal vectors for unrelated content (cosine ≈ 0) and negative-cosine vectors for content with opposing meaning. The threshold is a v0 guess; calibration is open question O1.)
- **Test 3 (hard signal — always available):** if `cand.kind === "policy"` AND `cand.policy_kind === "fact_excluded"` AND the predicate matches `input.content` (using the existing `mcp/lib/recall/predicate-match.js` evaluator), declare contradiction with the special outcome `code: HARD_AUTHORITY_CONTRADICTION` — this is the warrant for the EXCLUDE_REJECTED pattern (D4 below).

Tests 1, 2, 3 run in this order. The first one to fire decides. Test 1's valence path is preferred because it carries semantic intent ("this is good/bad/neutral") that embeddings alone do not encode; Test 2 is the universal fallback.

### D4. Authority policy check

Before declaring `CO_EXIST` or `SUBSTITUTE`, the detector ALSO walks the predicate index for active `policy.exclude` events whose predicates match `input.content`. If one fires with `confidence` (declared on the policy row at emit time — see `mcp-surface.md § memory_exclude`) above `CAPS.RECONCILE_AUTHORITY_CONFIDENCE_GATE = 0.85`, the contradiction is escalated to `HARD_AUTHORITY_CONTRADICTION` and the resolution is forced to `EXCLUDE_REJECTED` (D4 in the decision algorithm).

This is the warrant for the SCENARIO the task description names: *"new contradicts a high-confidence policy event (e.g., operator-emitted policy.fact_excluded that names the new content as forbidden)."* The user's high-confidence policy.exclude IS the authority; reconstructed emissions cannot override it.

### D5. Detection failure mode (no valence + cosine borderline)

If Test 1 cannot run (no valence field on either side — happens during the W7→W8 transition window or for old facts that pre-date valence stamping) AND Test 2's cosine is in the borderline zone `(-0.05, +0.10)`, the detector returns `is_contradiction: maybe` with `confidence_score = (0.10 - cosine) / 0.15`. The decision algorithm (R3 below) treats `maybe` as `CO_EXIST` by default — the safe pattern. This is the *"surface both; let the user decide"* posture inherited from the W7 node's `design_choice`.

### D6. Performance budget

The detector runs inside `emitReconstruction` on every call. Performance budget per call:

- D1 parent-children walk: O(`avg_children_per_parent` × `parents.length`) — bounded by `CAPS.RECONCILE_PARENT_CHILDREN_MAX = 32`.
- D2 parent direct test: O(`parents.length`).
- D3 per-candidate test: O(`embedding_dim`) for cosine; O(`entity_count`) for entity intersection.
- D4 predicate-index walk: O(`active_predicate_count`) — bounded by the existing `PREDICATE_MAX_ACTIVE` cap.

Total worst case: ≤ 50ms on a 768-dim embedding, ≤ 100 active predicates, ≤ 16 parents (the W7 `RECONSTRUCT_PARENTS_MAX`). Same order of magnitude as the cascade's salience-stamp step (`salience-design.md`). The detector runs on the watermark daemon's idle tick, NOT inline in the agent's request path (for the daemon caller); it does run inline for the agent caller, but the agent caller is already paying for an embed + entity-extract + token-verify roundtrip — adding 50ms is acceptable.

---

## Three resolution patterns

Each pattern has: (a) a formal contract (what the ledger contains after); (b) what the recall projection does; (c) what audit events fire; (d) the agent/operator-facing return shape.

### P1. SUBSTITUTE — new row supersedes old

**When fired.** Decision algorithm R1 below. Hot conditions:

- `confidence(new) ≥ confidence(superseded) + CAPS.RECONCILE_SUBSTITUTE_CONFIDENCE_DELTA` (default 0.15).
- The superseded row's `provenance.conversation_id === input.conversation_id` (intra-conversation refinement — same agent, same recall context, fresh evidence).
- The superseded row is a `reconstructed`-kind row, NOT a `fact`-kind row. (Facts are never auto-superseded by reconstructions — operator-only via `memory_substitute`. See I3 below.)
- Same `provenance.agent_id` prefix (e.g. `claude-code:` vs `daemon:thread-aggregator` cannot cross-supersede — see I4).

**Ledger after.** Two new rows appended:

1. The new `reconstructed` row with `contradicts: [superseded_id]`, `resolution: "substitute"`.
2. A `policy.reconcile.substitute` row with `targets: [new_row_id, superseded_id]`, `payload: { superseder: <new_row_id>, superseded: <superseded_id>, criteria: { confidence_delta, scope_match, conversation_id_match } }`.

The superseded row STAYS UNTOUCHED on the ledger. Its `superseded_by` field (architecture.md §4 — currently only set for `fact` rows under `memory_replace`) is NOT mutated by this pattern; the projection learns of the supersession by joining the row with the `policy.reconcile.substitute` event keyed on `targets`. (This decouples "the row's persisted state" from "the projection's interpretation"; same posture as `memory_replace`'s two-row pattern.)

**Recall projection.** When the recall layer encounters the superseded row in the candidate set, it consults the index for any `policy.reconcile.substitute` event whose `targets[1] === superseded_id` AND `rescinded_at === null`. If one is found, the superseded row is SILENTLY DROPPED at the recall cascade hard-gate (`mcp/lib/recall/hard-gates.js`), and the superseder row is included as if it were the original surfaced candidate (its score is computed independently — supersession does NOT carry over the superseded's recall trace; that would be a positive-feedback channel). The brief surfaces only the superseder. There is no "superseded" note in the brief metadata — from the brief consumer's perspective, only the superseder ever existed in this projection.

**Operator-facing.** The `memory_rescind_policy` tool, called against the `policy.reconcile.substitute` row's id, deactivates the supersession. The superseded row resumes appearing in recall candidates. The superseder remains on the ledger; both now surface together, exactly as if a CO_EXIST had been chosen at emit time. (This is the standard rescind-restores-prior-state pattern from `mcp-surface.md § memory_rescind_policy`.)

**Audit events.**

```jsonc
{ "kind": "policy.reconcile.substitute",
  "memory_id": "<policy_row_id>",
  "targets": ["<superseder_id>", "<superseded_id>"],
  "payload": {
    "superseder": "<superseder_id>",
    "superseded": "<superseded_id>",
    "criteria": {
      "confidence_delta": 0.18,
      "scope_match": true,
      "conversation_id_match": true,
      "agent_id_prefix_match": true,
      "test_fired": "test_1_valence_sign_mismatch" | "test_2_cosine_adversary"
    },
    "detected_contradiction_score": -0.21    // cosine, or valence mag diff
  },
  "rescinded_at": null,
  "ts": "<ISO-8601>" }
```

### P2. CO_EXIST — both rows kept

**When fired.** Decision algorithm R2 below. Hot conditions:

- ANY contradiction detected, but criteria for SUBSTITUTE (R1) and EXCLUDE_REJECTED (R3) not met. This is the DEFAULT and CATCH-ALL — the safe path.
- Cross-conversation (the two rows have different `conversation_id`s) — operator may have had two different conversations on adjacent topics.
- Cross-scope (the two rows have different `scope` values — one `conversation_local`, one `cross_session`).
- Neither has clear confidence authority (confidence delta below SUBSTITUTE threshold).

**Ledger after.** ONE new row appended:

1. The new `reconstructed` row with `contradicts: [contradicted_ids[]]`, `resolution: "co_exist"`.
2. PLUS a `policy.reconcile.co_exist` audit row (note: this is an audit-only row — the projection does not consult it for recall behavior; it exists so operator dashboards can count CO_EXIST clusters).

The contradicted rows STAY UNTOUCHED. Both surface.

**Recall projection.** When the recall layer surfaces the new row OR any of the contradicted rows in a brief, the brief metadata gains a `conflict` tag listing the other rows in the cluster:

```jsonc
"brief_metadata": {
  "conflict": {
    "cluster_id": "<sha256(sorted([new_id, ...contradicted_ids[]]))>",
    "other_ids": ["<other_id>", ...],
    "note": "contradicting view from fact <other_id>; both surfaced for operator review"
  }
}
```

The brief budget arithmetic counts each row in a CO_EXIST cluster as 1.0 slots (NOT the 1.5-slot weighting the W7 review_step rejected). Both rows fully count. The reason: the W7 review_step's 1.5-slot heuristic was rejected for introducing non-integer slot arithmetic into the recall projection; this spec adopts the simpler "1.0 + 1.0 = 2.0" counting AND adds a dashboard alarm (the count of unresolved CO_EXIST clusters surfaces in `memory_health`) for when contradictions accumulate beyond `CAPS.RECONCILE_COEXIST_PENDING_THRESHOLD = 20`.

**Operator-facing.** The user resolves a CO_EXIST cluster by calling EITHER `memory_substitute(target=one_of_the_ids, content_transform=<new_content>)` OR `memory_exclude(predicate=<that_targets_one_side>)`. Both are existing operator-MCP surfaces (no new tool); the agent does NOT have an MCP affordance to resolve CO_EXIST clusters (only the user does, via the privileged exclude/substitute tokens). This is the load-bearing "no auto-mutation; operator decision is the trust boundary" stance from thesis Principle 7 and the W7 node's existing `design_choice`.

**Audit events.**

```jsonc
{ "kind": "policy.reconcile.co_exist",
  "memory_id": "<audit_row_id>",
  "targets": ["<new_id>", "<contradicted_id_0>", "<contradicted_id_1>", ...],
  "payload": {
    "cluster_id": "<sha256-hex>",
    "detection_metrics": [
      { "candidate_id": "<contradicted_id_0>", "test_fired": "...", "score": ... },
      ...
    ],
    "criteria_for_substitute_failed": ["conversation_id_mismatch", "confidence_delta_below_gate"],
    "criteria_for_exclude_rejected_failed": ["no_authority_policy_match"]
  },
  "rescinded_at": null,
  "ts": "<ISO-8601>" }
```

### P3. EXCLUDE_REJECTED — new emission rejected before append

**When fired.** Decision algorithm R3 below. Hot conditions:

- D3 Test 3 fired (active `policy.exclude` or `policy.fact_excluded` whose predicate matches `input.content`) AND that policy's `confidence ≥ CAPS.RECONCILE_AUTHORITY_CONFIDENCE_GATE = 0.85`.
- OR `D4 authority policy check` returned `HARD_AUTHORITY_CONTRADICTION`.

**Ledger after.** NO `reconstructed` row appended. ONE `policy.reconcile.exclude_rejected` audit row appended:

```jsonc
{ "kind": "policy.reconcile.exclude_rejected",
  "memory_id": "<audit_row_id>",
  "targets": ["<attempted_content_hash>", "<authority_policy_id>"],
  "payload": {
    "content_hash": "<sha256(input.content)>",
    "parents_at_attempt": ["<parent_id>", ...],
    "authority_policy_id": "<policy_event_id>",
    "authority_predicate_match_score": 0.94,
    "agent_id": "<input.agent_id>",
    "rejected_at_step": "emit_reconstruction.detector"
  },
  "rescinded_at": null,
  "ts": "<ISO-8601>" }
```

**Recall projection.** N/A — no `reconstructed` row exists to surface. The audit row is consulted only by the user-inspection tooling (e.g. `memory_health.recent_excludes_rejected`).

**Agent/daemon-facing.** The caller receives:

```jsonc
{ "ok": false,
  "code": "INVALID_RECONSTRUCTION_CONTRADICTS_AUTHORITY",
  "reason": "active policy.<policy_kind> <policy_event_id> forbids this content (predicate match score 0.94 ≥ authority confidence gate 0.85)",
  "hint": { "authority_policy_id": "<id>", "rescind_via": "memory_rescind_policy" }
}
```

The agent-path tool handler maps this to its standard error envelope. The daemon-path caller (thread-aggregator / project-aggregator) logs the rejection to the watermark daemon's structured log and ABANDONS this bucket's emission for the current tick; the next idle tick will re-attempt only if the authority policy was rescinded in the interim (the bucket_key idempotency from W7 S5 ensures no duplicate spam).

**Token semantics (agent path only).** The `confirmation_token` IS burned (R9 ordering in W7 — token consume happens before classifier, classifier happens before contradiction detection, which means by the time EXCLUDE_REJECTED is determined, the nonce is gone). This matches the W7 PURE_CITATION semantics — *agent-identity-gate first, structural-screen second, content-screen last*. The agent receives the rejection AFTER spending the token. This is the gaming-defense posture from W7 E5.

---

## Decision algorithm

Given a new emission `input` and a non-empty `contradicted_ids[]` from the detector, choose ONE pattern. The algorithm is mechanical and order-sensitive.

### R1. Check for HARD_AUTHORITY_CONTRADICTION first

If ANY detected contradiction has `test_fired === "test_3_authority_policy_match"` OR D4 returned `HARD_AUTHORITY_CONTRADICTION`, return `EXCLUDE_REJECTED`.

The reasoning: a high-confidence operator-emitted `policy.exclude` is the ceiling; nothing below it can override. Even if the new emission's confidence is 1.0 and all other criteria would prefer SUBSTITUTE, the authority policy wins. This is the load-bearing principle: operator policy emissions are the trust ceiling for the reconstruction stream.

### R2. Check for SUBSTITUTE next

Return SUBSTITUTE iff ALL of:

- `contradicted_ids.length === 1` (the algorithm refuses to auto-supersede multiple rows in a single emission — that case falls through to CO_EXIST per R3).
- Let `superseded = ledger.byId(contradicted_ids[0])`. Require `superseded.kind === "reconstructed"` (NEVER auto-supersede a fact — see I3).
- `input.confidence ≥ superseded.provenance.confidence + CAPS.RECONCILE_SUBSTITUTE_CONFIDENCE_DELTA` (default 0.15).
- `input.conversation_id === superseded.provenance.conversation_id` (intra-conversation refinement only).
- `input.scope === superseded.scope` (same scope — see I5).
- `input.provenance.agent_id.startsWith(superseded.provenance.agent_id.split(":")[0] + ":")` — same agent_id PREFIX (e.g. `claude-code:` to `claude-code:`; not `claude-code:` to `daemon:`).

If ANY of these fails, fall through to R3.

Edge case — `superseded.kind === "fact"`: NEVER auto-supersede. Returns CO_EXIST. Operator must explicitly call `memory_substitute` (the existing operator-facing tool, NOT the reconcile.substitute variant this spec introduces) if they want the reconstruction to replace the fact's projection. This is invariant I3, the load-bearing trust-boundary stance.

### R3. CO_EXIST is the default

If R1 and R2 both fail, return CO_EXIST. This includes:

- Cross-conversation contradictions.
- Cross-scope contradictions.
- Low confidence delta (below SUBSTITUTE gate).
- Multi-contradiction (more than one contradicted_id).
- Cross-agent contradictions (`claude-code:` vs `codex:` vs `daemon:`).
- Detection-failure-mode `maybe` results (D5).

This is the safe default. The cost is brief budget consumption; the benefit is preservation of the contradiction signal for operator review.

### R4. Pseudo-code

```ts
function chooseResolution(
  input: EmitReconstructionInput,
  contradicted: Array<{ id: string; row: LedgerRow; metric: DetectionMetric }>,
  ctx: EmitReconstructionCtx
): "SUBSTITUTE" | "CO_EXIST" | "EXCLUDE_REJECTED" {
  // R1 — authority check
  if (contradicted.some(c => c.metric.test_fired === "test_3_authority_policy_match")) {
    return "EXCLUDE_REJECTED";
  }
  const authorityPolicies = ctx.indexCache.activePolicyMatches(input.content, {
    minConfidence: CAPS.RECONCILE_AUTHORITY_CONFIDENCE_GATE,
  });
  if (authorityPolicies.length > 0) return "EXCLUDE_REJECTED";

  // R2 — substitute check
  if (contradicted.length !== 1) return "CO_EXIST";
  const superseded = contradicted[0].row;
  if (superseded.kind !== "reconstructed") return "CO_EXIST";
  if (input.confidence < superseded.provenance.confidence + CAPS.RECONCILE_SUBSTITUTE_CONFIDENCE_DELTA) return "CO_EXIST";
  if (input.conversation_id !== superseded.provenance.conversation_id) return "CO_EXIST";
  if (input.scope !== superseded.scope) return "CO_EXIST";
  const inputPrefix = input.agent_id.split(":")[0];
  const supersedePrefix = superseded.provenance.agent_id.split(":")[0];
  if (inputPrefix !== supersedePrefix) return "CO_EXIST";
  return "SUBSTITUTE";

  // R3 — default
  // (unreachable; the two returns above cover the path)
}
```

The algorithm is intentionally NOT confidence-weighted between SUBSTITUTE and CO_EXIST — once R2's gates pass, SUBSTITUTE fires; otherwise CO_EXIST fires. Confidence weighting between patterns introduces a continuous knob into a discrete decision; same posture as W7's R5/R6/R7 classifier — discrete outcomes, threshold-gated.

---

## Schema additions

### S1. `reconstructed` row — two new fields

```jsonc
{
  // ... existing W7 fields ...
  "content": "...",
  "derived_from": [ "<parent_id>", ... ],
  "features": { ... },

  // NEW — this spec
  "contradicts": [ "<memory_id>", ... ],    // present when the detector fired;
                                            //   empty array OR field absent
                                            //   when no contradiction detected
  "resolution": "substitute" | "co_exist"   // present when contradicts.length > 0;
                                            //   absent (or null) otherwise
                                            //   NOTE: "exclude_rejected" is NEVER
                                            //   a value here — that case rejects
                                            //   the row pre-append, so no
                                            //   reconstructed row carries it
}
```

The `contradicts` field is the NEGATIVE derivation edge — its semantic is *"the system, at emit time, considered these rows to be in tension with this one and chose a resolution."* It is symmetrical to `derived_from` (positive edge) but lives in the opposite direction in the derivation graph. The recall layer does NOT use `contradicts` for forgetting propagation (that uses `derived_from`); operator tooling uses it for the *"why is this row here?"* inspection trail.

The `resolution` field is the system's choice. It is permitted to be `null` for legacy rows (pre-this-spec); legacy rows are treated as `co_exist` for projection purposes.

### S2. `policy` event — three new `policy_kind` values

```jsonc
{
  "kind": "policy",
  "policy_kind": "reconcile.substitute"      // NEW — superseder/superseded pair
              | "reconcile.co_exist"         // NEW — audit-only cluster marker
              | "reconcile.exclude_rejected",// NEW — audit-only rejection trace
  "applied_at": "<ISO-8601>",
  "scope": null,                              // these reconcile policies are global
  "targets": [ "<id>", ... ],
  "payload": { ... },                         // see P1/P2/P3 above for shapes
  "rescinded_at": null
}
```

The `policy_kind` enum extends `architecture.md §4`'s existing `"exclude" | "replace" | "substitute" | "corroboration" | "rescind"`. The dot-notation (`reconcile.substitute`) is a deliberate namespace separator to distinguish system-driven reconciliation from the existing manual `substitute`. The projection logic dispatches on the full string (`policy_kind === "reconcile.substitute"`); no regex matching, no prefix games.

### S3. CAPS additions

```ts
// Detection
RECONCILE_PARENT_CHILDREN_MAX: 32,            // D1 cap on parent-children walk
RECONCILE_VALENCE_MAGNITUDE_GATE: 0.4,        // D3 Test 1 mag-delta floor
RECONCILE_COSINE_ADVERSARY_GATE: -0.05,       // D3 Test 2 negative-cosine gate
RECONCILE_AUTHORITY_CONFIDENCE_GATE: 0.85,    // D4 authority-policy confidence floor

// Decision
RECONCILE_SUBSTITUTE_CONFIDENCE_DELTA: 0.15,  // R2 confidence-delta floor

// Operator health
RECONCILE_COEXIST_PENDING_THRESHOLD: 20,      // memory_health alarm trigger
```

All values are v0 guesses; calibration via the offline-eval harness (`F-SYN-OPERATIONAL-held-out-labeled-set-v2`) is open question O1.

### S4. `policy.reconcile.substitute` payload

```jsonc
{
  "superseder": "<reconstructed_id>",
  "superseded": "<reconstructed_id>",
  "criteria": {
    "confidence_delta": <number>,
    "scope_match": <bool>,
    "conversation_id_match": <bool>,
    "agent_id_prefix_match": <bool>,
    "test_fired": "test_1_valence_sign_mismatch" | "test_2_cosine_adversary"
  },
  "detected_contradiction_score": <number>    // signed; valence-mag-delta or cosine
}
```

### S5. `policy.reconcile.co_exist` payload

```jsonc
{
  "cluster_id": "<sha256-hex>",
  "detection_metrics": [
    {
      "candidate_id": "<id>",
      "test_fired": "test_1_valence_sign_mismatch" | "test_2_cosine_adversary",
      "score": <number>
    }
  ],
  "criteria_for_substitute_failed": [ "<string>", ... ],
  "criteria_for_exclude_rejected_failed": [ "<string>", ... ]
}
```

### S6. `policy.reconcile.exclude_rejected` payload

```jsonc
{
  "content_hash": "<sha256-hex>",
  "parents_at_attempt": [ "<id>", ... ],
  "authority_policy_id": "<policy_event_id>",
  "authority_predicate_match_score": <number>,
  "agent_id": "<string>",
  "rejected_at_step": "emit_reconstruction.detector"
}
```

### S7. Brief metadata extension

```jsonc
"brief_metadata": {
  // ... existing fields ...
  "conflict": {
    "cluster_id": "<sha256-hex>",
    "other_ids": [ "<memory_id>", ... ],
    "note": "<string>"            // human-readable for the agent's brief consumer
  }
}
```

Only present when the brief surfaces ≥1 row from a CO_EXIST cluster. Absent otherwise.

---

## Recall-time consumption

The recall layer's interaction with this spec lives in three places.

### RC1. Hard-gate update — SUBSTITUTE rows

`mcp/lib/recall/hard-gates.js` gains a new check, run after the existing not-excised and transitive-orphan gates:

```ts
// Pseudo-code; the implementing PR translates to existing module shapes.
for (const candidate of candidates) {
  const activeSubstitute = indexCache.activeReconcileSubstitute(candidate.id);
  // activeSubstitute is a policy.reconcile.substitute row where:
  //   targets[1] === candidate.id (the superseded position)
  //   rescinded_at === null
  if (activeSubstitute) {
    candidates.delete(candidate);   // SILENTLY drop the superseded
    // Note: do NOT auto-add the superseder; if the superseder was independently
    // surfaced by the scorer, fine. If not, this contradiction was outside the
    // current recall context and surfacing the superseder would be a non-
    // sequitur. The supersession only DROPS; it does not RE-INJECT.
  }
}
```

The activeReconcileSubstitute lookup is O(1) via a new index projection over `policy.reconcile.substitute` rows. The projection is a derived cache — same discipline as the existing `superseded_by` index for `memory_replace` (architecture.md §4 `superseded_by: id | null`).

### RC2. Brief enrichment — CO_EXIST clusters

After the scorer has selected the brief's `RECALL_MAX_ITEMS` candidates, a post-process step walks each surfaced row's `contradicts[]` field. If ANY entry in `contradicts[]` is ALSO in the brief, the row gains a `brief_metadata.conflict` block listing the other ids and a human-readable note ("contradicting view from fact X").

If a row's `contradicts[]` references rows that are NOT in the brief, the conflict block is suppressed (no point surfacing a cluster the consumer can't see). The dashboard alarm in `memory_health` is the user's path to discover those un-surfaced clusters.

### RC3. Brief budget arithmetic

CO_EXIST rows are NOT discounted (1.0 slot each, NOT the 1.5-slot weighting the W7 node review_step rejected). Both rows in a 2-row cluster cost 2.0 brief slots. This may cause the brief to hit `RECALL_MAX_ITEMS` faster when contradictions accumulate — that pressure is the SIGNAL, not the bug. The user's resolution of the cluster (via `memory_substitute` or `memory_exclude`) reclaims one slot.

The `RECONCILE_COEXIST_PENDING_THRESHOLD = 20` dashboard alarm in `memory_health` is the leading indicator the user watches; once tripped, the user triages clusters from a sorted list (by `recall_surface_count` descending — clusters that have been surfaced multiple times are prioritized).

---

## Examples

### Example E1 — SUBSTITUTE (intra-conversation refinement)

**Setup.** The user is mid-conversation with their Claude Code agent about an Acmebot LX-2 that keeps dropping jobs. The conversation surfaces an earlier reconstructed event from the same conversation:

- `rec_X` (existing): content = *"The SampleBot LX-2 is reached over Wi-Fi; the wired en5 link is only a fallback."* — `provenance.confidence = 0.65`, `provenance.conversation_id = conv_999`, `provenance.agent_id = claude-code:conv_999`, `scope = conversation_local`. Single parent `fact_A` (a chat-log fact from a Slack message).
- `fact_A`: content = *"An LX-2 accepts jobs over Wi-Fi or over a wired link (interface en5)."* — no valence; embedding cosine to `rec_X` = +0.73.

Now the agent reconciles new evidence: a fresh recall surfaces `fact_B` (a separate Slack message — *"for SampleBot the wired en5 link is the DEFAULT route; Wi-Fi stays on for firmware updates only"*). The agent calls `memory_distill_emit_reconstructed` with:

- content: *"The SampleBot LX-2 takes jobs over the wired en5 link by default; Wi-Fi is kept for firmware updates only."*
- parents: `[fact_A, fact_B]`
- confidence: 0.88
- conversation_id: `conv_999`
- scope: `conversation_local`

**Detector.** D2 runs the parent-direct test on `fact_A`. Entity overlap (SampleBot, LX-2, en5, Wi-Fi) is non-empty. D3 Test 2 runs (no valence on `fact_A`): cosine between proposed content and `fact_A` is +0.21 — not a contradiction (above the −0.05 gate). D2 runs against `fact_B`: cosine +0.84 — not a contradiction. D1 walks `fact_A`'s children, finds `rec_X`. Skip? `rec_X.conversation_id === conv_999 === input.conversation_id` — D1 step 3 says SKIP (intra-conversation refinement, handled by the SUBSTITUTE branch). The D1 walk does NOT add `rec_X` to `contradicted_ids[]` BUT marks `rec_X` as an "intra-conversation candidate for SUBSTITUTE supersession" in a separate set. (The detector returns both: contradictions from cross-conv siblings AND intra-conv refinements; the decision algorithm R2 reads the latter.)

**Decision.** R1 — no authority policy match. R2 — exactly one intra-conv refinement candidate (`rec_X`). `rec_X.kind === "reconstructed"` ✓. `input.confidence (0.88) ≥ rec_X.confidence (0.65) + 0.15 (gate) = 0.80` ✓. `conv_999 === conv_999` ✓. `conversation_local === conversation_local` ✓. `agent_id` prefix `claude-code` matches ✓. **SUBSTITUTE fires.**

**Ledger after.** Two new rows:

```jsonc
// New reconstructed row
{ "id": "rec_NEW", "kind": "reconstructed",
  "ts": "2026-06-20T15:42:11Z",
  "provenance": { "agent_id": "claude-code:conv_999", "conversation_id": "conv_999", "confidence": 0.88 },
  "content": "The SampleBot LX-2 takes jobs over the wired en5 link by default; Wi-Fi is kept for firmware updates only.",
  "derived_from": ["fact_A", "fact_B"],
  "features": { ... },
  "contradicts": ["rec_X"],
  "resolution": "substitute" }

// New reconcile policy row
{ "id": "pol_RECON_1", "kind": "policy",
  "policy_kind": "reconcile.substitute",
  "applied_at": "2026-06-20T15:42:11Z",
  "scope": null,
  "targets": ["rec_NEW", "rec_X"],
  "payload": {
    "superseder": "rec_NEW",
    "superseded": "rec_X",
    "criteria": {
      "confidence_delta": 0.23,
      "scope_match": true,
      "conversation_id_match": true,
      "agent_id_prefix_match": true,
      "test_fired": "test_2_cosine_adversary"
    },
    "detected_contradiction_score": -0.11
  },
  "rescinded_at": null }
```

`rec_X` stays untouched. The recall hard-gate, on next recall, drops `rec_X` silently in favor of `rec_NEW`. The brief consumer only ever sees `rec_NEW`.

### Example E2 — CO_EXIST (cross-conversation)

**Setup.** The user has two parallel conversations a week apart:

- `conv_A` (Mon 2026-06-15, with Claude Code, about the seed-library catalog design): produces `rec_M` — *"The seed-library catalog should key every packet by plant variety, because borrowers search by what they want to grow."*
- `conv_B` (Mon 2026-06-22, with Codex CLI, on the same catalog design): produces a new emission — *"The catalog should NOT key packets by plant variety — donated packets are often mislabeled, so a variety key spreads errors; a per-donation batch key is the correct choice."*

Both emissions have:

- Parent `fact_Y` (a chunk of the project's design notes on catalog keys).
- `scope = cross_session` (both intended to inform all future seed-library conversations).
- Different `conversation_id` and different `agent_id` prefix (claude-code vs codex).

**Detector.** D2 + D3 Test 2: cosine between `rec_M` and the new content = −0.18. CONTRADICTION DETECTED. `contradicted_ids = [rec_M]`.

**Decision.** R1 — no authority policy. R2 — `contradicted.length === 1` ✓. `rec_M.kind === "reconstructed"` ✓. Confidence delta? input.confidence (0.74) vs rec_M.confidence (0.78) → delta = −0.04, BELOW the 0.15 gate. ✗ — R2 FAILS. CO_EXIST.

**Ledger after.** One new reconstructed row + one audit policy row:

```jsonc
{ "id": "rec_NEW2", "kind": "reconstructed",
  "provenance": { "agent_id": "codex:conv_B", "conversation_id": "conv_B", "confidence": 0.74 },
  "content": "The catalog should NOT key packets by plant variety; a per-donation batch key is the correct choice.",
  "derived_from": ["fact_Y"],
  "contradicts": ["rec_M"],
  "resolution": "co_exist" }

{ "id": "pol_RECON_2", "kind": "policy",
  "policy_kind": "reconcile.co_exist",
  "targets": ["rec_NEW2", "rec_M"],
  "payload": {
    "cluster_id": "0xab12...",
    "detection_metrics": [{ "candidate_id": "rec_M", "test_fired": "test_2_cosine_adversary", "score": -0.18 }],
    "criteria_for_substitute_failed": ["confidence_delta_below_gate", "conversation_id_mismatch", "agent_id_prefix_mismatch"],
    "criteria_for_exclude_rejected_failed": ["no_authority_policy_match"]
  } }
```

Both `rec_M` and `rec_NEW2` stay on the ledger. Next recall on a seed-library topic surfaces both (cross_session scope); brief metadata carries the conflict block: *"contradicting view from fact rec_M; both surfaced for operator review."* The user sees the disagreement and decides — calls `memory_substitute(target=rec_M, content_transform=<rec_NEW2 content>)` if Codex is right, or `memory_exclude(predicate matching rec_NEW2)` if Claude Code was right.

### Example E3 — EXCLUDE_REJECTED (authority policy forbids)

**Setup.** Three weeks earlier the user emitted a `policy.exclude` with predicate: *"any content claiming the seed-library ships seeds by mail"* — confidence 0.95, `scope = cross_session`, `applied_at = 2026-06-01`. The policy was deliberate: the project's design notes (`seed-library/design/pickup.md`) say lending is pickup-only, and the user does not want an agent's earlier mistake about mail delivery to come back.

A daemon-path thread-aggregator processes an old chat log from `chat-claude-code.jsonl` (written before the policy) and Gemini Flash composes a reconstructed event: *"The seed-library ships seeds by mail in padded envelopes within two days of a request."* — parents = three pre-policy chat facts that DO mention mail delivery (the agent had it wrong several times before the user corrected it).

**Detector.** D4 authority policy check fires: the active `policy.exclude` predicate matches `input.content` with score 0.94 ≥ 0.85 gate. `HARD_AUTHORITY_CONTRADICTION`.

**Decision.** R1 — authority contradiction → **EXCLUDE_REJECTED**.

**Ledger after.** NO `reconstructed` row appended. One audit row:

```jsonc
{ "id": "pol_RECON_3", "kind": "policy",
  "policy_kind": "reconcile.exclude_rejected",
  "targets": ["<content_hash>", "<authority_policy_id>"],
  "payload": {
    "content_hash": "0xfade...",
    "parents_at_attempt": ["fact_chat_171", "fact_chat_172", "fact_chat_173"],
    "authority_policy_id": "pol_EXCL_42",
    "authority_predicate_match_score": 0.94,
    "agent_id": "daemon:thread-aggregator",
    "rejected_at_step": "emit_reconstruction.detector"
  } }
```

The daemon caller receives `code: INVALID_RECONSTRUCTION_CONTRADICTS_AUTHORITY` and abandons this bucket for the current tick. The bucket's idempotency key (W7 S5) ensures the daemon does not retry the same composition on the next tick — only a content change (i.e. Gemini Flash composes something different from the same parents) would refresh the bucket and allow re-attempt. If the user rescinds `pol_EXCL_42` (via `memory_rescind_policy`), the next daemon tick that re-composes against the same bucket will produce a new content hash (the bucket key includes the parent set, not the content; new composition → new content hash → new idempotency key); the re-attempt will then succeed.

### Example E4 — CO_EXIST with multi-contradiction fallback

**Setup.** A new reconstructed emission contradicts TWO existing reconstructions simultaneously — neither matches all the SUBSTITUTE criteria individually. The detector returns `contradicted_ids = [rec_P, rec_Q]`.

**Decision.** R1 — no authority policy. R2 — `contradicted.length === 2`, NOT 1. ✗ — R2 FAILS. CO_EXIST.

**Ledger after.** New reconstructed row with `contradicts: [rec_P, rec_Q]`, `resolution: "co_exist"`. Audit policy row with `cluster_id` and metrics for both. All three rows surface together at next recall.

This is the deliberate "fail-safe to CO_EXIST" posture — multi-contradiction is the murky case where the system cannot mechanically resolve and surfaces all options for the user. The user can resolve via successive `memory_substitute` or `memory_exclude` calls against each contradicted row individually.

---

## Invariants — CI-enforceable

### I1. Single emitter — contradiction detection lives in `emitReconstruction` only

CI grep gate: `grep -r 'detectContradiction\|chooseResolution' mcp/lib/` MUST return only files inside `mcp/lib/synthesis/reconciliation.js` (the new module) AND `mcp/lib/synthesis/reconstruction-emitter.js` (the W7 emitter that calls into reconciliation). Any other file is a conformance failure — same posture as W7 I1 (the grep gate against rogue `kind: "reconstructed"` writes).

### I2. No in-place mutation of contradicted rows

CI test fixture: emit SUBSTITUTE pattern; assert the superseded row's bytes on disk are unchanged before-and-after (sha256 of the relevant ledger line). The recall projection is the ONLY place that interprets `policy.reconcile.substitute`; the row itself never gets a `superseded_by` mutation. Same posture as Risk #10 binding.

### I3. NEVER auto-supersede a fact

CI test fixture: emit a reconstructed event whose detector returns a single-fact `contradicted_ids` (intra-conv, high confidence, all SUBSTITUTE criteria met EXCEPT for the kind check). Assert the algorithm returns CO_EXIST. The corresponding audit row's `criteria_for_substitute_failed[]` includes `"contradicted_kind_is_fact"`. This is the load-bearing trust-boundary stance: facts have a higher trust level than reconstructions; only operator action (via `memory_substitute`) can supersede a fact's projection.

### I4. Same-agent-prefix gate prevents cross-agent supersession

CI test fixture: a Claude Code emission contradicts an existing Codex reconstruction, all other SUBSTITUTE criteria met. Assert CO_EXIST fires (NOT SUBSTITUTE). The user's parallel-agent landscape stays inspectable; one agent cannot silently override another's reconstruction.

### I5. Same-scope gate prevents scope escalation

CI test fixture: a `conversation_local` emission contradicts an existing `cross_session` reconstruction. Assert CO_EXIST fires. Scope escalation by silent supersession would be a privilege bug.

### I6. EXCLUDE_REJECTED leaves no reconstructed row

CI test fixture: emit a content that matches an active authority policy. Assert NO `reconstructed` row landed on the ledger. Assert ONE `policy.reconcile.exclude_rejected` row DID land. Assert the agent caller received `code: INVALID_RECONSTRUCTION_CONTRADICTS_AUTHORITY`.

### I7. Reconcile policies are rescindable

CI test fixture: emit SUBSTITUTE; verify supersession; rescind the `policy.reconcile.substitute` via `memory_rescind_policy`; verify the recall projection surfaces BOTH rows again. Same posture as `memory_replace`'s rescind path.

### I8. Detection-budget-exceeded fail-open is audited

CI test fixture: configure `RECONCILE_PARENT_CHILDREN_MAX = 1`; emit a parent with 5 children. Assert the emission succeeds (CO_EXIST path) AND `contradicts: ["__detection_budget_exceeded__"]` is set. The fail-open posture is recorded in the ledger; operator can find it in inspection.

### I9. Daemon path subject to the detector

CI test fixture: a daemon-path emission with content that contradicts an existing reconstruction. Assert the detector fires AND the decision algorithm runs AND the appropriate pattern is chosen (SUBSTITUTE / CO_EXIST / EXCLUDE_REJECTED), exactly as for the agent path. The W7 shared-validator convergence (A6) is what makes this enforceable.

### I10. CAPS values are the single source of truth

CI grep gate: numeric thresholds (0.15, 0.85, 0.4, −0.05, 32, 20) MUST NOT appear as literals in `mcp/lib/synthesis/reconciliation.js`; they MUST be read from `CAPS.*`. Same discipline as W7 S6.

---

## Open questions

### O1. Calibration of detection + decision thresholds

Every numeric CAPS value is a v0 guess. The calibration path:

- Operator labels a sample of `policy.reconcile.co_exist` clusters from `memory_health.coexist_pending`: which were real contradictions, which were false-positives (the detector fired but the user thinks they're the same claim).
- Feed labels into `F-SYN-OPERATIONAL-held-out-labeled-set-v2`. Compute per-test precision/recall.
- Re-tune `RECONCILE_COSINE_ADVERSARY_GATE` (Test 2), `RECONCILE_VALENCE_MAGNITUDE_GATE` (Test 1), `RECONCILE_SUBSTITUTE_CONFIDENCE_DELTA` (R2).

Defer to v1 held-out re-grow per the W7 + W8 + W9 calibration loop. The spec ships v0 defaults; the loop tightens.

### O2. Automatic operator notification on CO_EXIST surfacing?

When a CO_EXIST cluster surfaces in a brief during a real recall, should the user be notified via a side-channel (e.g. a desktop notification, a daily digest, a slack post)? Pros: actionable triage. Cons: notification spam if clusters accumulate.

v0 ships dashboard-only: `memory_health` exposes the count and the top-N most-recently-surfaced clusters; the user polls. Notification-channel integration is deferred to a v1 operator-experience node.

### O3. Tracking re-contradiction (re-opening resolved clusters)

If the user resolves a CO_EXIST cluster via `memory_substitute`, then a later reconstructed emission contradicts the resulting projection — does the system flag *"this cluster you resolved is being contradicted again"* differently from a fresh contradiction?

v0 does NOT track re-contradiction explicitly. The audit trail is sufficient: the new `policy.reconcile.co_exist` event's `targets[]` includes the substituted row, and inspection of that row's history reveals the prior `policy.reconcile.substitute` resolution. Operator can walk the trail manually. A "re-contradiction count" surface in `memory_health` is deferred.

### O4. Cross-embedding-model contradiction detection

Test 2 (cosine) depends on the embedding model. Across model upgrades (e.g. `gemini-embedding-001` → `gemini-embedding-002`), the cosine gate's calibration may shift. The current spec assumes single-model operation; the embedding-model-version field on each row could be consulted to skip Test 2 when models differ (fall back to Test 1 valence-only, or treat as `maybe` per D5).

Defer to the embedding-model-upgrade work (cross-binding: `kb/open-problems.md #7 Index discrimination decay model`).

### O5. Should `policy.reconcile.co_exist` events have an active/inactive bit?

A `policy.reconcile.co_exist` event is audit-only — it records that the system detected a contradiction and chose CO_EXIST. After the user resolves the cluster (via `memory_substitute` or `memory_exclude`), should the `co_exist` event be marked rescinded? Currently the spec says NO — the co_exist audit row is permanent (it records what the system DID); the user's resolution writes its own new policy row. Pros of this: cleaner audit chain. Cons: the dashboard's count of unresolved clusters needs to join across (co_exist event, subsequent substitute/exclude events on the same targets) to compute "unresolved" — slightly more expensive than a direct active-flag scan.

v0 ships without an active bit; the join is the canonical path. v1 may reconsider.

### O6. Multi-contradiction SUBSTITUTE — should R2 ever fire with N>1?

Current R2 forces CO_EXIST when `contradicted.length > 1`. Conceivable extension: if ALL N contradicted rows are intra-conversation reconstructions AND all SUBSTITUTE criteria pass against each individually, fire a multi-target SUBSTITUTE (single `policy.reconcile.substitute` with `targets: [new, supersededA, supersededB, ...]`).

Defer to v1 — needs operator-label evidence that multi-target SUBSTITUTE is actually a real case in practice. v0 keeps R2 strict (length === 1).

### O7. Detection step ordering inside `emitReconstruction`

This spec inserts the detector between W7's step 8 (`extractFeatures`) and step 9 (`assembleRow`). An alternative: insert AFTER step 11 (`updateIndices`) — i.e. always append the row, then post-hoc decide CO_EXIST vs SUBSTITUTE, with EXCLUDE_REJECTED handled at write-time-only via a pre-flight check.

Pros of post-hoc: simpler detector (the new row's id exists during detection). Cons: a SUBSTITUTE then requires marking the just-written superseder as "fresh" but actually appending the policy AFTER means a 0-second window where the superseder exists but the substitute policy doesn't (recall race). v0 keeps the detector pre-append for SUBSTITUTE consistency (the policy row is appended in the same `assembleRow` transaction as the reconstructed row); the EXCLUDE_REJECTED case is the only one where the detector's outcome stops the append.

---

## Cross-tier impact

### CT1. Substrate tier — `mcp/lib/synthesis/reconciliation.js` (new)

Owns: D1–D4 detection, R1–R3 decision algorithm, the `chooseResolution` function.

Consumed by: `mcp/lib/synthesis/reconstruction-emitter.js` (the W7 emitter calls into this module at the new step-8.5 detector slot).

Bound to: `F-SYN-SUBSTRATE-RECONSTRUCTION-EMITTER` node — that node's do_step will add the step-8.5 call site when this spec is implemented; this spec defines the contract.

### CT2. Substrate tier — `mcp/lib/synthesis/reconstruction-emitter.js` (extended)

The W7 emitter's step list expands from 12 to 14:

```
... (W7 steps 1–8 unchanged) ...
8.5. detectContradiction(input, ctx)                  // NEW — D1–D4
8.6. chooseResolution(input, contradicted, ctx)       // NEW — R1–R3
9.   assembleRow(input, embedding, features, ...,
                  contradicted_ids, resolution)        // NEW args
... (W7 steps 10–12 unchanged) ...
12.5. if resolution === "substitute":
        appendLedgerRow(policy.reconcile.substitute)   // NEW
      else if contradicted_ids.length > 0:
        appendLedgerRow(policy.reconcile.co_exist)     // NEW (audit-only)
13.  return { ok: true, memory_id, dedupe_action, resolution, contradicts }
```

For EXCLUDE_REJECTED, the emitter SHORT-CIRCUITS at step 8.6, appends ONLY the `policy.reconcile.exclude_rejected` row, and returns `{ ok: false, code: INVALID_RECONSTRUCTION_CONTRADICTS_AUTHORITY, ... }`.

### CT3. Behavior tier — recall projection updates

Owns: RC1 hard-gate update, RC2 brief enrichment, RC3 brief-budget arithmetic.

Files touched: `mcp/lib/recall/hard-gates.js` (RC1), `mcp/lib/recall/score-candidate.js` (RC2), `mcp/lib/recall/brief-builder.js` (RC3).

Bound to: `F-SYN-BEHAVIOR-corroboration-propagation` and `F-SYN-BEHAVIOR-forgetting-propagation-through-synthesis` (the W7 node's forward `blocks` field) — those behavior nodes consume this spec's projection contracts.

### CT4. Behavior tier — `memory_health` extension

`mcp/lib/tools/memory-health.js` gains:

- `coexist_pending_count`: count of distinct CO_EXIST clusters whose targets are not all individually substituted/excluded.
- `coexist_top_n`: top-N most-recently-surfaced clusters by recall_surface_count.
- `excludes_rejected_recent`: count of `policy.reconcile.exclude_rejected` rows in the last 24h.

Alarm fires when `coexist_pending_count > CAPS.RECONCILE_COEXIST_PENDING_THRESHOLD (20)`.

### CT5. Integration tier — no new MCP tool

This spec INTRODUCES NO new agent-facing MCP tools. The detector + decision algorithm runs inside the existing `memory_distill_emit_reconstructed` handler's call to `emitReconstruction`. Operators resolve clusters via the existing `memory_substitute` / `memory_exclude` / `memory_rescind_policy` surfaces.

The choice to NOT add a new MCP tool is deliberate: a `memory_resolve_reconciliation(reconstructed_id, action)` tool was considered (W7 node's open question O2) and rejected for v0. Rationale: the existing four-tool forgetting family already covers the user-decision surface; adding a fifth tool specifically for reconciliation duplicates capability and increases the screened-surface area. v1 may reconsider once operator-experience data indicates the existing tools are too coarse.

### CT6. Recall tier — `recall.surfaced[].brief_metadata` extension

The `recall` kind's `surfaced[]` array gains the optional `brief_metadata.conflict` block (S7). Schema migration: this is an OPTIONAL field; old `recall` rows do NOT have it; new rows have it ONLY when ≥1 surfaced row is part of a CO_EXIST cluster. No backfill needed.

### CT7. Operational tier — calibration loop

`F-SYN-OPERATIONAL-held-out-labeled-set-v2` gains a new label dimension: `reconciliation_outcome ∈ { real_contradiction, false_positive_paraphrase, false_positive_same_claim_different_words }`. Operator labels CO_EXIST clusters from the dashboard; the calibration loop tightens the CAPS values per O1.

Bound to: existing operational node, no new node required.

---

## Stigmergy — do_step completion metadata

When this spec is implemented (the `reconciliation.js` module + tests + emitter integration land), the implementer updates `/tmp/memory-system-hypergraph-synthesis/nodes/F-SYN-FOUNDATION-reconciliation-policy-spec.json`'s `do_step` field. The current `do_step` is the spec-write step (see top-level update for this workunit). Implementation-step convention follows the W7 + W8 pattern: a second `do_step` entry with `phase: "implementation"` and a list of files+tests landed.
