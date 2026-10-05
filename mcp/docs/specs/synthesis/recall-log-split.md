# Two-Recall-Log Split — Foundation Spec

> **Node:** `F-SYN-FOUNDATION-recall-log-split`
> **Tier:** foundation
> **Status:** authoritative; supersedes substrate / behavior-tier divergent shapes
> **Owns:** the damping-log row schema, the engagement signal contract, the reinforcement formula, the `turn_window_id` canonical encoding.

---

## 1. Mission

Resolve `open-problems.md` § 4 ("Silent excise vs recall-as-event paradox") by pinning the **two-recall-log split** as a complete, implementable contract. The recall pipeline now has two parallel logs with disjoint access disciplines:

1. A **public recall ledger** — `kind:"recall"` rows on `<data root>/ledgers/memory.jsonl`, keyed by `recall_id`. This is what `memory_excise` mutates surgically under `silent:true`; it is what `memory_exclude` snapshots `context_embedding` from (`operations.md § exclude`).
2. A **private damping log** — append-only JSONL at `<data root>/policy/damping-log.jsonl`, keyed by `{memory_id, turn_window_id}`. Read by exactly **two** code paths (the recall scorer and the calibration replay) and by nothing else. Persists the per-surfacing decay state + the engagement evidence that drives `thesis.md § 5` engagement-gated reinforcement.

This spec also fixes the **engagement signal contract** (five classes attributed to the *user*, not the LLM's first quote — closing `research-retrieval-frontiers.md § Risks #12`), the **reinforcement formula** (linear-decay windowed aggregate, not tanh-bounded), and the **canonical encoding of `turn_window_id`** (so the substrate and four behavior-tier nodes converge on one byte-level shape).

Why now: the substrate node and four behavior-tier nodes each invented divergent row shapes (substrate: flat `{kind, engagement_strength}`; behavior: `{signal_kind, plaintext conversation_id, numeric turn_window}`; density-flag behavior: `crowded_neighborhood` with hash-only entity sets that Jaccard cannot read). Cross-tier review caught all four as BLOCKER / MAJOR. This document is the **schema-of-record** the substrate and the four behaviors MUST mirror verbatim.

---

## 2. KB Anchors (binding quotes)

### A. `open-problems.md` § 4 — Silent excise vs recall-as-event paradox (resolved)

> "Resolved via the two-recall-logs option. The observable recall log is keyed by `{recall_id, memory_id}` and supports surgical row deletion under `silent: true`. A separate private damping log, keyed by `{memory_id, turn_window}` and never inspected by any tool other than the recall scorer, retains the surfacing and engagement signal so co-bucketed memories' reinforcement is unaffected by an excise."

Pins: two-logs split; surgical deletion lives on the public log; damping log persists co-bucketed signal.

### B. `thesis.md` § 5 — Reinforcement is engagement-gated proximity

> "A memory surfaced in turn 5 enters turn 6's surrounding context, raising its match probability. But raw surfacing is *anti-reinforced* — recently surfaced items are down-weighted to prevent positive-feedback dominance. Reinforcement happens only when the user *engages*: responds, agrees, corrects."

Pins: surfacing has a *negative* contribution; engagement has a *positive* contribution; the sign of reinforcement depends on the user, not on the assistant.

### C. `operations.md` § Damping

> "Per-surfacing decay: Each `recall` event records which memory ids were in the brief; For each surfaced memory, decrement an in-context boost for K turns; If the user **engages** with the memory (responds to it, builds on it, corrects it) within K turns, *reverse* the dampening and add a reinforcement boost."

Pins: per-surfacing decay is per memory_id over a K-turn window; engagement *reverses* the dampening (linear, not tanh-saturated); window length K is an operational tunable.

### D. `open-problems.md` § 8 — Damping calibration

> "Engagement-gated reinforcement is the right shape, but the constants are unknown: How many turns is 'recent'? What counts as engagement? How much should engagement boost vs raw surfacing penalize?"

Pins: K, engagement-class taxonomy, raw-surfacing penalty, and engagement weights are all CAPS knobs; bootstrap values are *guesses* to be calibrated by O5.

### E. `research-retrieval-frontiers.md` § Risks #12 — Two-stage credit assignment

> "Only count `engagement_positive` when the *user* (not the LLM's first draft) acknowledges the memory. Engagement listener must distinguish user-initiated agreement/correction from LLM-internal surfacing."

Pins: engagement detection runs over the **next user turn** after a recall — never on the assistant's quote in the *same* turn (that is the LLM rehearsing its own brief, not the user signaling fitness).

### F. `architecture.md` § 4 — Memory ledger / `recall` kind

> "The `recall` kind's `query.context_embedding` is the canonical source `memory_exclude` reads when it server-snapshots a predicate's embedding from a `recall_id`. This field is distinct from `fact.features.embedding` and exists only on recall-kind events."

Pins: the public recall ledger row schema (`{query, surfaced, density_flag, truncated}`); we do not redefine it here, we only constrain its relationship to the damping log.

### G. `architecture.md` § acquireExclusiveLockFile

> "Sidecar file as the lock. `<resource>.lock` lives in the same directory as the resource. File presence IS the lock. Body is `JSON.stringify({pid: process.pid, heartbeat_ts: <ISO-8601>})` for diagnostics. Mode `0600`."

Pins: every write to `damping-log.jsonl` MUST acquire `damping-log.lock` via the canonical pattern.

### H. `thesis.md` § 7 — Agents cannot write durably (without the screened surface)

> "What the screen does NOT buy ... on a single-user machine where the agent runs in the same uid as any holder of the daemon signing key, a sufficiently capable agent with `Bash` access CAN read the signing key ... The token discipline is a **screening and audit layer**, not a privilege boundary against same-uid attackers."

Pins: "private damping log" means **architecturally segregated from the MCP surface** — not "OS-enforced against same-uid attackers." See § 9 for the honest framing of what privacy this design buys.

---

## 3. Architecture overview

```
                   ┌──────────────────────────────────────────┐
                   │            memory_recall (MCP)           │
                   └──────────────────┬───────────────────────┘
                                      │
                                      ▼
                          ┌─────────────────────────┐
                          │     recall scorer       │
                          │ mcp/lib/recall/         │
                          │   score-candidate.js    │
                          └──────────┬──────────────┘
                                     │ (read-only)
                ┌────────────────────┴──────────────┐
                ▼                                   ▼
   ┌────────────────────────┐         ┌──────────────────────────────┐
   │ PUBLIC recall ledger   │         │ PRIVATE damping log          │
   │ ledgers/memory.jsonl   │         │ policy/damping-log.jsonl     │
   │ kind:"recall"          │         │ append-only; 0600;           │
   │ key: recall_id         │         │ key: (memory_id,             │
   │ surgical excise OK     │         │       turn_window_id)        │
   └─────────┬──────────────┘         └──────────────────────────────┘
             │                                       ▲          ▲
             │   ┌───────────────────────────────────┘          │
             ▼   │                                              │
   ┌─────────────────────────┐                ┌────────────────────────────┐
   │  memory_excise          │                │ engagement detector        │
   │  (surgical row delete   │                │  (Stop hook → next         │
   │   on silent:true)       │                │   UserPromptSubmit)        │
   └─────────────────────────┘                └────────────────────────────┘

       (no other tool / hook / process reaches the damping log)
```

Two writers feed the damping log:

1. The recall service writes `signal_kind:"surfacing"` (one row per surfaced memory) and `signal_kind:"crowded_neighborhood"` (one row per recall when density_flag fires).
2. The engagement detector writes `signal_kind:"engagement"` on the next user turn.

Derivation propagation (`F-SYN-FOUNDATION-derivation-propagation`) writes `signal_kind:"engagement_inherited"`.

`memory_excise` with `silent:true` writes `signal_kind:"expunged"` as a tombstone — the file is *never* rewritten.

---

## 4. Schema(s)

### 4.1 PUBLIC recall ledger row (cross-reference only)

Lives on `ledgers/memory.jsonl`. Defined authoritatively in `architecture.md § 4 → recall`. Quoted here for joinability:

```ts
type RecallRow = {
  id: string;                          // ledger event id, randomly assigned at write time
  ts: string;                          // ISO-8601, server-stamped
  kind: "recall";
  provenance: {
    agent_id: string;
    conversation_id: string;           // PLAINTEXT — this is the public ledger
    confidence: number;
  };
  query: {
    context_embedding: number[];       // 3072-d (Gemini-001 RETRIEVAL_QUERY)
    embedding_model_version: string;
    surrounding_context_hash: string;
  };
  surfaced: Array<{
    memory_id: string;
    score: number;
    position: number;                  // 0-indexed
  }>;
  density_flag: null | "many_candidates_near_topic";
  truncated: boolean;
};
```

`recall_id` is `RecallRow.id`. The public log carries plaintext `conversation_id` (`provenance.conversation_id`) — this is the existing public-ledger discipline. The damping log carries only the *hash* of conversation_id (see § 4.3).

### 4.2 Damping-log file layout

| Field            | Value                                                                                                   |
|------------------|---------------------------------------------------------------------------------------------------------|
| Path             | `<data root>/policy/damping-log.jsonl`                                                              |
| Mode             | `0600` (mandatory; the file MUST be unreadable by non-owner uids on creation)                            |
| Format           | JSONL (one event per line, UTF-8, LF terminator)                                                        |
| Discipline       | Append-only; never mutated, never truncated (except corrupt-tail recovery at startup; see § 6.5)         |
| Lock             | `<data root>/policy/damping-log.lock` via the `acquireExclusiveLockFile` discipline (`architecture.md`) |
| Access list      | Two paths only: `mcp/lib/recall/score-candidate.js` (read), `mcp/scripts/replay-salience.mjs` (read);    |
|                  | three writers: `mcp/lib/recall-feedback/damping-log.js` (write — used by the recall service, the engagement detector, the derivation propagator), and `memory_excise` (write tombstone via the same module). |

### 4.3 Canonical row envelope (top-level, identical across all signal kinds)

```ts
type DampingLogRow = {
  schema_version: 1;                       // bumped only on incompatible changes; consumers MUST skip rows with unknown schema_version
  signal_kind:
    | "surfacing"
    | "engagement"
    | "engagement_inherited"
    | "crowded_neighborhood"
    | "expunged";
  memory_id: string | null;                // see invariants I3
  turn_window_id: string;                  // base64url, 43 chars (32-byte sha256)
  recall_id: string | null;                // see invariants I4
  conversation_id_hash: string | null;     // see invariants I5
  ts: string;                              // ISO-8601, server-stamped at write time
  populator_version: string;               // e.g. "damping-log@1.0.0"; bumped on writer-side semantic changes
  fields: Record<string, unknown>;         // per-kind payload (see § 4.4)
};
```

The envelope is **frozen**. Adding a new top-level field requires `schema_version = 2`. Per-kind additions go in `fields` — readers tolerate unknown keys inside `fields` and skip rows with unknown `signal_kind` at the top level (forward-compat: future kinds do not crash old readers).

### 4.4 Per-kind `fields` shapes

#### 4.4.1 `signal_kind: "surfacing"`

Written by the recall service immediately after `memory_recall` commits the public recall row. One row per surfaced memory (i.e. `RecallRow.surfaced.length` rows per recall).

```ts
type SurfacingFields = {
  surfaced_strength: number;   // ∈ [0, 1]; position-weighted brief score (formula below)
  position: number;            // 0-indexed position in the brief
  score: number;               // the multi-feature score that placed this memory in the brief
  propensity: number;          // the brief's chosen propensity for this memory (Plackett-Luce; research-retrieval-frontiers.md v0)
};
```

`surfaced_strength` is computed as:

```
surfaced_strength = clamp01(score * (1 / (1 + position)))
```

Where `clamp01(x) = max(0, min(1, x))`. Rationale: position 0 gets full score; position 11 (last in a 12-item brief) is divided by 12 → diminishing damping for the deep tail. This is the form referenced in the substrate node review as "position-weighted score"; it is pinned here so the substrate and the recall scorer cannot drift.

Required envelope fields: `memory_id` REQUIRED, `recall_id` REQUIRED, `conversation_id_hash` REQUIRED.

#### 4.4.2 `signal_kind: "engagement"`

Written by the engagement detector on the **next user turn** after the recall (see § 5 for detection mechanics).

```ts
type EngagementFields = {
  engagement_class:
    | "direct"          // direct user reference to surfaced content (or surface tokens)
    | "paraphrase"      // semantic similarity ≥ 0.75 between user turn and memory content
    | "correction"      // user disagrees with the memory (still engagement; negative valence)
    | "dismiss"         // user dismisses the memory ("not relevant", "stop bringing that up")
    | "no_engagement";  // explicit absence — the K-turn window elapsed with no detection
  engagement_weight: number;     // sourced from CAPS.ENGAGEMENT_WEIGHTS (see § 7)
  evidence_span_hash: string;    // sha256 of the user-utterance span that triggered detection (lowercase hex; "" for no_engagement)
  detector_version: string;      // e.g. "engagement-detector@1.0.0"
};
```

Required envelope fields: `memory_id` REQUIRED, `recall_id` REQUIRED (joins back to the surfacing row that put this memory in front of the user), `conversation_id_hash` REQUIRED.

#### 4.4.3 `signal_kind: "engagement_inherited"`

Written by `F-SYN-FOUNDATION-derivation-propagation` when an engagement on memory `A` is propagated to a derivation parent `B` (the `corroboration-propagation` behavior).

```ts
type EngagementInheritedFields = {
  inherited_strength: number;          // ∈ [0, CAPS.DAMPING_INHERITED_STRENGTH_MAX]; capped at 0.5 in v0
  source_engagement_recall_id: string; // the recall_id of the original engagement event
  source_memory_id: string;            // memory_id that received the original engagement
  derivation_depth: number;            // edge count along the derivation_graph from source_memory_id to memory_id
};
```

Required envelope fields: `memory_id` REQUIRED (the inheriting memory — the parent), `recall_id` NULL (inheritance is derivation-graph-driven, not recall-driven), `conversation_id_hash` REQUIRED (scopes the propagation to the conversation that surfaced the engagement).

#### 4.4.4 `signal_kind: "crowded_neighborhood"`

Written by the recall service when the recall emits `density_flag: "many_candidates_near_topic"`. Used by the scorer to penalize candidates that show up in dense neighborhoods more often than a baseline (anti-cluster bias).

```ts
type CrowdedNeighborhoodFields = {
  entity_set_hash: string;             // sha256 base64url of sorted-join entity_set; for fast index lookup
  entity_set: string[];                // RAW sorted entity ids — required so Jaccard can be computed at read time
  time_window_start: string | null;    // ISO-8601; the lower bound of the recall's time anchors (null if no anchor)
  time_window_end: string | null;      // ISO-8601; the upper bound (null if no anchor)
  candidates_pre_truncation: string[]; // memory_ids of all candidates this recall scored before MMR + truncation, in score order
};
```

Required envelope fields: `memory_id` NULL (the signal is about a neighborhood, not a single memory; this is the only kind where memory_id is null with the row still being a recall-time signal), `recall_id` REQUIRED, `conversation_id_hash` REQUIRED.

Note: `entity_set` is included raw, not hash-only — a previous behavior-tier draft tried to keep only the hash, but the scorer needs the entity ids in clear text to compute Jaccard against a candidate's entities at read time. Hash exists in parallel for cheap O(1) bucket lookup.

#### 4.4.5 `signal_kind: "expunged"`

Written by `memory_excise` (via `damping-log.js`) when a memory is excised under `silent: true`. This is the **only** way the damping log "deletes" a memory's contribution — the file is never rewritten.

```ts
type ExpungedFields = {
  excise_reason: "silent_excise" | "damping_log_excise_by_window";
};
```

Required envelope fields: `memory_id` REQUIRED, `recall_id` NULL (excise is not recall-scoped), `conversation_id_hash` NULL (excise is global).

The scorer's in-memory index treats a `(memory_id)` with any `expunged` row as "filtered out" — `readWindowedSignals` returns `net = 0` for that memory_id regardless of other rows that may exist. Subsequent surfacing rows on the same memory_id (the excised memory could be re-promoted later from a different source) are not filtered; the scorer keys the filter by the tuple `(memory_id, expunged_ts)` — only rows older than the most recent expunge of that memory_id are filtered. This matches the open-problems.md #4 invariant that co-surfaced memories are unaffected; it also lets the system re-learn the memory's damping signal if it is re-promoted post-excise. (See § 6.4 for the decision rule.)

### 4.5 `turn_window_id` canonical encoding

This was the cross-implementation drift point flagged by the foundation-tier review. The pinned encoding is:

```
turn_window_id = base64url(
  sha256_bytes(
    utf8(conversation_id)
    ‖ 0x1F                            // ASCII Unit Separator
    ‖ big_endian_u64(base_turn_index)
    ‖ 0x1F
    ‖ big_endian_u64(window_size)
  )
)
```

Where:

- `‖` = byte concatenation.
- `conversation_id` is the runtime-emitted conversation identifier (Claude Code's `session_id`, Codex's equivalent). Bridge layers MUST normalize to the underlying `conversation_id` before hashing — never include the runtime-name prefix.
- `base_turn_index = floor(turn_index / window_size)` where `turn_index` starts at 0 for the first turn of a conversation. Same conversation, same window_size, two turns in the same window → identical `turn_window_id`.
- `window_size = CAPS.RECALL_K_TURN_WINDOW` (default 3; see § 7).
- The `0x1F` (Unit Separator) byte between components is non-printable and so cannot occur in `conversation_id`, eliminating prefix-collision attacks even if window_size or base_turn_index were changed adversarially.
- `big_endian_u64` is 8 bytes, MSB-first, unsigned. This binds the encoding to a fixed width across architectures.
- The sha256 digest is 32 bytes; base64url-encoded that is 43 characters (no padding).

Reference implementation (Node.js):

```js
import { createHash } from "node:crypto";
const SEP = Buffer.from([0x1f]);
function turnWindowId(conversationId, turnIndex, windowSize) {
  const baseTurnIndex = Math.floor(turnIndex / windowSize);
  const baseBuf = Buffer.alloc(8);
  baseBuf.writeBigUInt64BE(BigInt(baseTurnIndex));
  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeBigUInt64BE(BigInt(windowSize));
  const h = createHash("sha256");
  h.update(Buffer.from(conversationId, "utf8"));
  h.update(SEP);
  h.update(baseBuf);
  h.update(SEP);
  h.update(sizeBuf);
  return h.digest("base64url");
}
```

### 4.6 `conversation_id_hash` canonical encoding

```
conversation_id_hash = base64url(sha256(utf8(conversation_id)))
```

Same as `turn_window_id` minus the turn-window components. Used to scope `readWindowedSignals` queries to a single conversation without leaking the conversation identifier into the damping log.

The damping log **never** stores plaintext `conversation_id`. The public recall ledger does (for normal recall-replay / debug); the damping log does not (a path-leak from the damping log MUST NOT enable conversation-membership inference). This was a behavior-tier divergence (the behavior-tier draft stored plaintext); it is corrected here.

---

## 4.7 Authoritative Schema for Consumers

> **This section is ABSOLUTELY AUTHORITATIVE.** Every behavior-tier consumer
> (`F-SYN-BEHAVIOR-damping-from-recall-log`,
> `F-SYN-BEHAVIOR-recall-log-write-engagement`,
> `F-SYN-BEHAVIOR-density-flag-feedback`,
> `F-SYN-BEHAVIOR-engagement-detector`,
> `F-SYN-BEHAVIOR-corroboration-propagation`) MUST emit and consume the verbatim
> envelopes defined here. Any divergent inline shape in a consumer node is a
> reconciliation defect and CI MUST catch it (see § 4.7.4).
>
> This section is the dual of § 4.4 (which defines `fields` shapes) — § 4.7
> nails down the **full row** (envelope + fields) consumers paste into the JSONL,
> the field-by-field translation table from legacy plaintext shapes, and the
> single shared SCHEMA_VERSION constant consumers MUST import.

### 4.7.1 SCHEMA_VERSION constant (single source of truth)

```ts
// mcp/lib/recall-feedback/damping-log-schema.js  (NEW — created by substrate node)
export const RECALL_LOG_SCHEMA_VERSION = "v1";
// Numeric form used inside row.schema_version (envelope field per § 4.3):
export const RECALL_LOG_SCHEMA_VERSION_NUMERIC = 1;
// Identifier used in all consumer-side imports and CI grep tests.
```

**Rule:** every `appendSurfacing()` / `appendEngagement()` / `appendInheritedEngagement()` / `appendCrowdedNeighborhood()` / `expunge()` call site MUST `import { RECALL_LOG_SCHEMA_VERSION } from '<the single shared module>'` and reference it by name when constructing rows. Inlining the literal `"v1"` or `1` is a CI failure. See § 4.7.4 for the invariant.

When this spec bumps to `v2`, the substrate publishes a new constant value, the foundation spec authors a migration table in `4.7.2`, and every consumer is recompiled against the new constant — there is **no** silent backwards-compat path.

### 4.7.2 Verbatim row envelopes per `signal_kind`

Each row below is the **complete** JSONL line a consumer emits — envelope (§ 4.3) plus per-kind `fields` (§ 4.4), with all null vs required cells marked per invariants I3–I5 (§ 9). Consumers MUST NOT add top-level fields outside this envelope; per-kind `fields` extensions go inside `fields` only.

#### 4.7.2.A `signal_kind: "surfacing"` (verbatim row)

Written by: `F-SYN-BEHAVIOR-recall-log-write-engagement` (one row per surfaced memory).

```json
{
  "schema_version": 1,
  "signal_kind": "surfacing",
  "memory_id": "<string, REQUIRED>",
  "turn_window_id": "<base64url(sha256(...)), 43 chars, per § 4.5>",
  "recall_id": "<string, REQUIRED — id of the PUBLIC recall row>",
  "conversation_id_hash": "<base64url(sha256(utf8(conversation_id))), per § 4.6>",
  "ts": "<ISO-8601, server-stamped at append time>",
  "populator_version": "damping-log@<semver>",
  "fields": {
    "surfaced_strength": 0.0,
    "position": 0,
    "score": 0.0,
    "propensity": 0.0
  }
}
```

Constraints: `surfaced_strength = clamp01(score * (1 / (1 + position)))` (invariant I10). `position` is 0-indexed.

#### 4.7.2.B `signal_kind: "engagement"` (verbatim row)

Written by: `F-SYN-BEHAVIOR-engagement-detector` on next UserPromptSubmit.

```json
{
  "schema_version": 1,
  "signal_kind": "engagement",
  "memory_id": "<string, REQUIRED>",
  "turn_window_id": "<base64url(sha256(...)), per § 4.5>",
  "recall_id": "<string, REQUIRED — joins back to the surfacing row's recall_id>",
  "conversation_id_hash": "<base64url(sha256(utf8(conversation_id))), per § 4.6>",
  "ts": "<ISO-8601, server-stamped at append time>",
  "populator_version": "engagement-detector@<semver>",
  "fields": {
    "engagement_class": "<one of: direct | paraphrase | correction | dismiss | no_engagement>",
    "engagement_weight": 0.0,
    "evidence_span_hash": "<sha256-hex of user-utterance span, or \"\" for no_engagement>",
    "detector_version": "engagement-detector@<semver>"
  }
}
```

Constraints: `engagement_weight` MUST be the value of `CAPS.ENGAGEMENT_WEIGHTS[engagement_class]` — detector MUST NOT mint custom weights (invariant I11). One row per memory in `prior_surfaced[]` (the detector emits `no_engagement` for unreferenced memories — see § 6.6).

`engagement` is a **separate row** that joins to the surfacing row via `(memory_id, recall_id)`. It is NEVER an inline field on the surfacing row (closes the legacy `engagement_outcome` divergence, see § 4.7.3).

#### 4.7.2.C `signal_kind: "engagement_inherited"` (verbatim row)

Written by: `F-SYN-BEHAVIOR-corroboration-propagation` (via `F-SYN-FOUNDATION-derivation-propagation`'s BFS).

```json
{
  "schema_version": 1,
  "signal_kind": "engagement_inherited",
  "memory_id": "<string, REQUIRED — the INHERITING (parent) memory_id>",
  "turn_window_id": "<base64url(sha256(...)), per § 4.5; same window as the source engagement>",
  "recall_id": null,
  "conversation_id_hash": "<base64url(sha256(utf8(conversation_id))), per § 4.6>",
  "ts": "<ISO-8601, server-stamped at append time>",
  "populator_version": "derivation-propagator@<semver>",
  "fields": {
    "inherited_strength": 0.0,
    "source_engagement_recall_id": "<recall_id of the original engagement>",
    "source_memory_id": "<memory_id that received the original engagement>",
    "derivation_depth": 1
  }
}
```

Constraints: `inherited_strength ∈ [0, CAPS.DAMPING_INHERITED_STRENGTH_MAX]`. The propagator MUST honor `F-SYN-FOUNDATION-derivation-propagation`'s SPLIT, PROPAGATION_FORMULA, PROPAGATION_DEPTH_MAX, THRESHOLD_FLOOR, and NO-DOUBLE-CREDIT rules — the numeric value of `inherited_strength` is derived there, not here. This spec only fixes the row shape.

`recall_id` is `null` because inheritance is derivation-graph-driven, not recall-driven (invariant I4).

#### 4.7.2.D `signal_kind: "crowded_neighborhood"` (verbatim row)

Written by: `F-SYN-BEHAVIOR-density-flag-feedback` (one row per recall when `density_flag` fires).

```json
{
  "schema_version": 1,
  "signal_kind": "crowded_neighborhood",
  "memory_id": null,
  "turn_window_id": "<base64url(sha256(...)), per § 4.5>",
  "recall_id": "<string, REQUIRED — id of the PUBLIC recall row that fired the flag>",
  "conversation_id_hash": "<base64url(sha256(utf8(conversation_id))), per § 4.6>",
  "ts": "<ISO-8601, server-stamped at append time>",
  "populator_version": "damping-log@<semver>",
  "fields": {
    "entity_set_hash": "<base64url(sha256(canonical_json(sorted(entity_set))))>",
    "entity_set": ["<entity_id_sorted_1>", "<entity_id_sorted_2>", "..."],
    "time_window_start": null,
    "time_window_end": null,
    "candidates_pre_truncation": ["<memory_id_1>", "<memory_id_2>", "..."]
  }
}
```

Constraints: `memory_id` is `null` — and this is the ONLY signal_kind where that holds (invariant I3). `entity_set` MUST be present in RAW (not just `entity_set_hash`) so the scorer can compute Jaccard at read time. `candidates_pre_truncation` MUST be stored in-row (not in an in-process cache) so the join survives daemon restarts.

#### 4.7.2.E `signal_kind: "expunged"` (verbatim row)

Written by: `memory_excise` (via the substrate's `damping-log.js#expunge()`).

```json
{
  "schema_version": 1,
  "signal_kind": "expunged",
  "memory_id": "<string, REQUIRED — the excised memory_id>",
  "turn_window_id": "EXPUNGE_GLOBAL",
  "recall_id": null,
  "conversation_id_hash": null,
  "ts": "<ISO-8601, server-stamped at append time>",
  "populator_version": "damping-log@<semver>",
  "fields": {
    "excise_reason": "<one of: silent_excise | damping_log_excise_by_window>"
  }
}
```

Constraints: `turn_window_id` is the sentinel string `"EXPUNGE_GLOBAL"` (the ONE deviation from § 4.5 — consumers MUST recognize the sentinel). `recall_id` and `conversation_id_hash` are both `null` because expunge is global (invariants I4, I5). `expunged` rows are read by the scorer once per invocation into an in-memory `expungedMemoryIds` set; any `memory_id` in that set returns `score_boost = 0` regardless of other rows (§ 6.4, invariant I12).

### 4.7.3 Translation table: legacy plaintext shapes → canonical hashed/structured shapes

Behavior-tier drafts (before WU-recall-log-split-final-reconciliation) emitted divergent inline shapes. The table below is the MIGRATION CONTRACT. Any consumer code that still uses a "legacy" column is a defect and MUST be rewritten to the "canonical" column.

| Legacy field (behavior-tier drafts)                                          | Canonical replacement (this spec)                                                                                                                          | Note                                                                                                                                                                              |
|------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Top-level `kind: "surfacing" \| "engagement" \| ...`                          | Top-level `signal_kind: "surfacing" \| "engagement" \| "engagement_inherited" \| "crowded_neighborhood" \| "expunged"`                                      | Renamed AND moved from row root to envelope field (§ 4.3). `kind` is now reserved for the PUBLIC recall ledger's `kind:"recall"` discipline only.                                  |
| Top-level `conversation_id: "<plaintext>"`                                   | Envelope `conversation_id_hash: base64url(sha256(utf8(conversation_id)))` (§ 4.6)                                                                          | The damping log NEVER stores plaintext conversation_id (invariant I6). Plaintext stays on the PUBLIC recall ledger only.                                                            |
| Top-level `turn_window: <integer>` (epoch-floored or numeric base)             | Envelope `turn_window_id: base64url(sha256(utf8(conversation_id) ‖ 0x1F ‖ BE_u64(base_turn_index) ‖ 0x1F ‖ BE_u64(window_size)))` (§ 4.5)                  | Numeric form is REJECTED — base64url-sha256 form is the only permitted encoding. Reference impl in § 4.5.                                                                          |
| Inline `engagement_outcome: "agreed" \| "ignored" \| null` on surfacing row    | SEPARATE row of `signal_kind: "engagement"` referencing surfacing row by `(memory_id, recall_id)`                                                          | Append-only: engagement is a new row, NEVER a mutation of the surfacing row (invariant I1). Detector emits `engagement_class: "no_engagement"` for the "ignored" case.             |
| Inline `engagement_strength: <number>` flat on row                            | Inside `fields.engagement_weight` (one of `CAPS.ENGAGEMENT_WEIGHTS[engagement_class]`)                                                                     | Detector MUST source weight from CAPS by class name — inline custom weights are an invariant I11 violation.                                                                         |
| 6-class engagement taxonomy: `{paraphrase, agreement, contradiction, correction, dismissal, explicit_reference}` | 5-class taxonomy: `{direct, paraphrase, correction, dismiss, no_engagement}` (§ 6.7)                                                                       | Mapping (§ 6.7): `agreement → direct`, `contradiction → correction`, `explicit_reference → direct`, `dismissal → dismiss`. `paraphrase` and `correction` keep the same name.        |
| `entity_set_hash` ONLY on crowded_neighborhood rows                          | `entity_set_hash` AND raw `entity_set: string[]` BOTH present                                                                                              | Hash alone cannot answer Jaccard ≥ threshold at read time. Raw list is required (§ 4.4.4).                                                                                          |
| `candidates_pre_truncation` held in an in-process cache keyed by recall_id   | `candidates_pre_truncation: string[]` stored IN-ROW on the crowded_neighborhood signal                                                                     | In-process caches die at restart; in-row survives.                                                                                                                                  |
| Local `DAMPING_*` CAPS namespace (`DAMPING_RAW_SURFACING_PENALTY`, `DAMPING_ENGAGEMENT_BOOST`, `DAMPING_NORM`, `DAMPING_WINDOW_TURNS`, `CORROBORATION_PROPAGATION_DECAY`, `MAX_CORROBORATION_DEPTH`) | Foundation `RECALL_FEEDBACK` CAPS block (`RECALL_K_TURN_WINDOW`, `RAW_SURFACING_PENALTY`, `ENGAGEMENT_WEIGHTS`, `RECALL_W_ENG`, `DAMPING_INHERITED_STRENGTH_MAX`, `CROWDED_NEIGHBORHOOD_PENALTY`, `CROWDED_NEIGHBORHOOD_JACCARD_THRESHOLD`) — and propagation constants from `F-SYN-FOUNDATION-derivation-propagation` (`PROPAGATION_DEPTH_MAX`, `DECAY_PER_HOP`, `THRESHOLD_FLOOR`, SPLIT, STOP-AT-EVIDENCE, NO-DOUBLE-CREDIT) | All CAPS live in `mcp/lib/validation.js § CAPS.RECALL_FEEDBACK` and CAPS imported from the foundation propagation node. Behavior nodes import by name; no local re-declarations.   |
| Local `tanh(net / DAMPING_NORM)` aggregation inside the behavior scorer       | Substrate's `readWindowedSignals()` returns linear-decay aggregate per § 6.3; scorer uses `agg.score_boost` directly                                       | The aggregation formula is owned by the substrate (single source). Scorer just multiplies by `CAPS.RECALL_W_ENG`.                                                                    |
| Empty `surfaced[]` recall produces no damping rows                            | Empty `surfaced[]` with `density_flag` produces ONE `crowded_neighborhood` row (§ 4.4.4); empty `surfaced[]` with no flag produces zero damping rows       | The crowded_neighborhood signal is decoupled from per-memory surfacing.                                                                                                             |

### 4.7.4 CI-checkable invariant (`I-CONSUMER-SCHEMA-REFERENCE`)

> **Invariant ID:** `I-CONSUMER-SCHEMA-REFERENCE`
> **Tier:** CI-enforced; added to § 9 invariants table.
> **Owner:** substrate (CI script lives in `mcp/test/recall-feedback/consumer-schema-import.test.mjs`).

The invariant has two parts:

**Part A — single-shared-module rule.**
Every call site of `appendSurfacing()`, `appendEngagement()`, `appendInheritedEngagement()`, `appendCrowdedNeighborhood()`, or `expunge()` MUST be in a file that imports `RECALL_LOG_SCHEMA_VERSION` from the single shared module `mcp/lib/recall-feedback/damping-log-schema.js`. CI grep:

```
# pseudocode for mcp/test/recall-feedback/consumer-schema-import.test.mjs
for file in $(grep -rl 'appendSurfacing\|appendEngagement\|appendInheritedEngagement\|appendCrowdedNeighborhood\|\bexpunge(' mcp/lib mcp/scripts); do
  grep -q "import.*RECALL_LOG_SCHEMA_VERSION.*from.*recall-feedback/damping-log-schema" "$file" \
    || fail "Consumer $file calls a damping-log writer but does not import RECALL_LOG_SCHEMA_VERSION from the shared module"
done
```

**Part B — no-plaintext-shape rule.**
A CI grep MUST fail if any file under `mcp/lib/**` (excluding `mcp/lib/recall-feedback/damping-log-schema.js` and the legacy-shape translation fixtures under `mcp/test/recall-feedback/fixtures/legacy/`) contains any of the legacy plaintext shapes from § 4.7.3. Concretely:

```
# pseudocode for mcp/test/recall-feedback/consumer-no-legacy-shapes.test.mjs
# Each pattern below MUST have ZERO hits outside test fixtures:
patterns=(
  '"signal_kind":\s*"engaged"'                # engagement_outcome legacy
  '"engagement_outcome"'                       # legacy field
  '"conversation_id":\s*ctx\.conversation_id' # plaintext conversation_id in a damping-log write
  '"turn_window":\s*[0-9]'                     # numeric turn_window
  '\bDAMPING_RAW_SURFACING_PENALTY\b'          # legacy CAPS namespace
  '\bDAMPING_ENGAGEMENT_BOOST\b'
  '\bDAMPING_NORM\b'
  '\bDAMPING_WINDOW_TURNS\b'
  '\bCORROBORATION_PROPAGATION_DECAY\b'
  '\bMAX_CORROBORATION_DEPTH\b'
  'tanh.*engagement'                            # local-tanh aggregation pattern
)
for p in "${patterns[@]}"; do
  hits=$(grep -rE "$p" mcp/lib mcp/scripts --include='*.js' --include='*.mjs' \
          | grep -v 'mcp/lib/recall-feedback/damping-log-schema.js' \
          | grep -v 'mcp/test/recall-feedback/fixtures/legacy/')
  [ -z "$hits" ] || fail "Legacy shape '$p' found: $hits"
done
```

**Part C — verbatim envelope fixture.**
`mcp/test/recall-feedback/fixtures/canonical/` ships one JSONL fixture per `signal_kind` (the five verbatim rows from § 4.7.2). A CI test deep-equality-compares the output of each `append*()` call (under a deterministic seed for `ts`) against the fixture. Drift in the envelope or per-kind fields fails CI.

Together, Parts A + B + C enforce: (a) consumers can only construct rows through the substrate's writers, which always use the shared SCHEMA_VERSION constant; (b) no consumer file embeds a legacy plaintext shape inline; (c) the substrate's writers produce byte-identical envelopes to the foundation spec. Drift in ANY layer fails CI before merge.

---

## 5. Module surface

### 5.1 New module: `mcp/lib/recall-feedback/damping-log.js`

The substrate (`F-SYN-SUBSTRATE-DAMPING-LOG`) implements this; the four behavior nodes call into it. No other module writes to the damping log.

```ts
// All append functions:
// - acquire damping-log.lock via acquireExclusiveLockFile
// - server-stamp ts and populator_version
// - validate envelope + per-kind fields against the schema
// - write one JSONL line + fsync + dir-fsync
// - return the appended row (with ts populated)
// - throw on validation failure (caller MUST NOT silently swallow)

export type AppendSurfacingArgs = {
  memory_id: string;
  turn_window_id: string;
  recall_id: string;
  conversation_id_hash: string;
  surfaced_strength: number;   // in [0, 1]
  position: number;            // 0-indexed
  score: number;
  propensity: number;
};
export function appendSurfacing(args: AppendSurfacingArgs): Promise<DampingLogRow>;

export type AppendEngagementArgs = {
  memory_id: string;
  turn_window_id: string;
  recall_id: string;
  conversation_id_hash: string;
  engagement_class: "direct" | "paraphrase" | "correction" | "dismiss" | "no_engagement";
  engagement_weight: number;
  evidence_span_hash: string;
  detector_version: string;
};
export function appendEngagement(args: AppendEngagementArgs): Promise<DampingLogRow>;

export type AppendInheritedEngagementArgs = {
  memory_id: string;
  turn_window_id: string;
  conversation_id_hash: string;
  source_engagement_recall_id: string;
  source_memory_id: string;
  derivation_depth: number;
  inherited_strength: number;  // in [0, CAPS.DAMPING_INHERITED_STRENGTH_MAX]
};
export function appendInheritedEngagement(args: AppendInheritedEngagementArgs): Promise<DampingLogRow>;

export type AppendCrowdedNeighborhoodArgs = {
  turn_window_id: string;
  recall_id: string;
  conversation_id_hash: string;
  entity_set: string[];                  // sorted ascending; entity_set_hash derived
  entity_set_hash: string;
  time_window_start: string | null;
  time_window_end: string | null;
  candidates_pre_truncation: string[];
};
export function appendCrowdedNeighborhood(args: AppendCrowdedNeighborhoodArgs): Promise<DampingLogRow>;

export type ExpungeArgs = {
  memory_id: string;
  excise_reason: "silent_excise" | "damping_log_excise_by_window";
};
// Writes ONE tombstone row keyed by memory_id; envelope.turn_window_id is a
// canonical SENTINEL value `"EXPUNGE_GLOBAL"` (not a real hash; this is the only
// place where turn_window_id deviates from § 4.5; consumers MUST recognise it).
export function expunge(args: ExpungeArgs): Promise<DampingLogRow>;

// Read path. Returns the aggregate the scorer consumes (see § 6.3).
export type ReadWindowedSignalsArgs = {
  memory_id?: string;                    // optional — if absent, returns all memory_ids in window
  conversation_id_hash: string;
  current_turn_window_id: string;        // the window the scorer is scoring INTO
  K: number;                             // CAPS.RECALL_K_TURN_WINDOW
};

export type SignalAggregate = {
  [memory_id: string]: {
    score_boost: number;                 // see § 6.3 reinforcement formula
    surfacing_count: number;             // for diagnostics
    engagement_count: number;            // for diagnostics
    expunged: boolean;                   // if true, score_boost MUST be 0
    last_signal_ts: string;              // ISO-8601
  };
};
export function readWindowedSignals(args: ReadWindowedSignalsArgs): Promise<SignalAggregate>;
```

### 5.2 Recall scorer integration: `mcp/lib/recall/score-candidate.js`

The scorer adds a single feature: `score_boost`. It is read via `readWindowedSignals` once per recall (not once per candidate — batch the read):

```ts
// Inside the multi-feature scoring loop:
const aggregate = await readWindowedSignals({
  conversation_id_hash: hash(ctx.conversation_id),
  current_turn_window_id: turnWindowId(ctx.conversation_id, ctx.turn_index, CAPS.RECALL_K_TURN_WINDOW),
  K: CAPS.RECALL_K_TURN_WINDOW,
});

for (const candidate of candidates) {
  const damping = aggregate[candidate.memory_id];
  const score_boost = damping?.expunged ? 0 : (damping?.score_boost ?? 0);
  candidate.final_score = candidate.multiFeatureScore + CAPS.RECALL_W_ENG * score_boost;
}
```

Multi-feature score remains as defined in `research-retrieval-frontiers.md § Recommended Phase 3 architecture` — the damping contribution is purely additive on the `+ w_eng * engagement_prior` channel.

### 5.3 Engagement detector: `mcp/lib/recall-feedback/engagement-detector.js`

(Owned by the integration tier, `F-SYN-INTEGRATION-engagement`. Listed here as a consumer of the schema.)

```ts
type EngagementDetectionArgs = {
  // The recall that fired in the prior turn
  prior_recall_id: string;
  prior_surfaced: Array<{ memory_id: string; score: number; position: number; content: string }>;
  // The user turn that JUST landed (UserPromptSubmit hook payload)
  user_turn_text: string;
  conversation_id: string;
  turn_index: number;     // index of the CURRENT user turn
};

type EngagementDetectionResult = Array<{
  memory_id: string;
  engagement_class: "direct" | "paraphrase" | "correction" | "dismiss" | "no_engagement";
  engagement_weight: number;        // from CAPS.ENGAGEMENT_WEIGHTS
  evidence_span_hash: string;
}>;

export function detectEngagementOnNextUserTurn(
  args: EngagementDetectionArgs
): Promise<EngagementDetectionResult>;
```

For every memory in `prior_surfaced` the detector emits exactly one result row (even if it is `no_engagement` — the absence is itself a signal that closes the K-turn window; see § 6.3). Each row is forwarded to `appendEngagement`.

### 5.4 `memory_excise` integration

The `silent: true` path on `memory_excise` (defined in `mcp-surface.md § memory_excise`) calls:

```ts
await dampingLog.expunge({ memory_id, excise_reason: "silent_excise" });
```

AFTER it has surgically removed the public ledger's `recall` row(s) and AFTER the derivation-graph excise has propagated. The order matters: the public ledger excision is reversible-by-not-doing-it; the damping log tombstone is durable. Doing the public delete first means a crash between steps leaves the damping log unaware that the excise happened (the next recall will still see the surfacing rows) — but this is **strictly safer** than the reverse order, which would leave the damping log thinking the memory is gone while a stale `recall_id` row still references it.

---

## 6. Decision rules

### 6.1 Writer order (per recall)

On `memory_recall` success:

1. Compute `turn_window_id` from `(conversation_id, turn_index, K)`.
2. Compute `conversation_id_hash`.
3. Append the public `kind:"recall"` row to `ledgers/memory.jsonl` (existing path).
4. For each `surfaced[i]`, append `signal_kind:"surfacing"` to the damping log via `appendSurfacing`.
5. If `density_flag === "many_candidates_near_topic"`, append `signal_kind:"crowded_neighborhood"` ONCE per recall.

Steps 3–5 are NOT atomic across files. A crash between (3) and (4) leaves the public ledger with a recall row and the damping log with no surfacing rows. This is **acceptable** — the next recall reads the damping log only; the orphaned `recall_id` is harmless (the scorer ignores recall rows it cannot find surfacing entries for).

### 6.2 Engagement detector cadence (cross-runtime)

The detection MUST run on the **next user turn**, not at the end of the current turn (i.e. NOT in the Stop hook).

- **Claude Code:** detection runs in `UserPromptSubmit` for the next turn. The hook has access to `last_assistant_message` (the recall brief; what the LLM quoted in its response) and the just-submitted user text. The detector reads the prior `recall_id` from a small process-scoped cache keyed by `(conversation_id, turn_index-1)`.
- **Codex CLI:** Stop payload only carries `last_assistant_message` — but the Codex hook recipe also fires `UserPromptSubmit`. Detection runs in `UserPromptSubmit` exactly as in Claude Code. The stitch cache from `agent-integration.md § Codex CLI` (`CODEX_TURN_STITCH_TTL_SECONDS=300`) preserves the recall_id across the turn boundary.

This resolves the open question "does the engagement detector run sync in the Stop hook or async in the next UserPromptSubmit?" — pinned: **next UserPromptSubmit**. Cross-runtime consistency is preferred over saving a few hundred milliseconds of latency on the Claude Code path.

### 6.3 Reinforcement formula (AUTHORITATIVE)

This formula replaces both prior conflicting forms (the foundation-tier sketch and the substrate-tier `tanh(engagement_strength)` variant). Linear decay, windowed aggregate.

Given a memory_id `m` being scored at the current turn window `W`:

1. Read all damping-log rows where `conversation_id_hash` matches the current conversation AND `turn_window_id ∈ window(W, K)` AND (`memory_id === m` OR `crowded_neighborhood` row with `m ∈ fields.candidates_pre_truncation`).
2. If ANY `signal_kind:"expunged"` row exists for `m` (anywhere in history, NOT only within the window — the expunge is global), set `score_boost(m) = 0` and STOP. Return.
3. Otherwise, for each remaining row, compute `event_contribution`:

```
turns_since(row) = base_turn_index(W) - base_turn_index(row.turn_window_id)
decay(turns_since) = max(0, 1 - turns_since / K)

if row.signal_kind == "surfacing":
    event_contribution = -CAPS.RAW_SURFACING_PENALTY * decay(turns_since)

elif row.signal_kind == "engagement":
    # engagement_weight is signed: direct=+1.0, paraphrase=+0.6, correction=+0.4,
    # dismiss=-0.5, no_engagement=0.0. The scorer reads the sign as-is — a dismiss
    # is more strongly anti-reinforcing than raw surfacing.
    event_contribution = row.fields.engagement_weight * decay(turns_since)

elif row.signal_kind == "engagement_inherited":
    # inherited_strength is already capped at CAPS.DAMPING_INHERITED_STRENGTH_MAX
    event_contribution = row.fields.inherited_strength * decay(turns_since)

elif row.signal_kind == "crowded_neighborhood":
    # Only counts if (a) the current candidate is in candidates_pre_truncation
    # AND (b) the candidate's entities overlap the neighborhood's entity_set
    # by ≥ CAPS.CROWDED_NEIGHBORHOOD_JACCARD_THRESHOLD.
    if (m in row.fields.candidates_pre_truncation
        and jaccard(candidate.entities, row.fields.entity_set) >= CAPS.CROWDED_NEIGHBORHOOD_JACCARD_THRESHOLD):
        event_contribution = CAPS.CROWDED_NEIGHBORHOOD_PENALTY   # static, no decay (the neighborhood is a property of the recall, not of the time-since)
    else:
        event_contribution = 0
```

4. Aggregate: `score_boost(m) = sum(event_contribution_i)`.
5. The candidate's final score is `final = multiFeatureScore + CAPS.RECALL_W_ENG * score_boost(m)`.

`base_turn_index(turn_window_id)` is NOT recoverable from the hash — instead the scorer reads the row's `turn_window_id` and matches it against the running list of windows it has computed for the conversation in the current process. (For the steady-state recall path, the scorer maintains a small ring buffer of the last `K + 1` window ids; if a row's `turn_window_id` is not in the ring, treat `turns_since` as `K` — i.e. fully decayed, contribution = 0 — and log a `damping_log_window_out_of_range` debug event.)

### 6.4 The `expunge` global-tombstone rule

`signal_kind:"expunged"` tombstones are read once per scorer invocation and held in an in-memory set `expungedMemoryIds`. The set is rebuilt from a single forward pass of the damping log on startup or after `damping_log.lock` is released by another process (TTL-cached for 60 seconds otherwise).

Decision:
- `memory_id ∈ expungedMemoryIds` ⇒ `score_boost = 0`, regardless of any subsequent surfacing rows.
- A memory_id that has been excised and *later re-promoted* (e.g. a new fact from the same source with a fresh `id`) gets a fresh memory_id; the tombstone keys by memory_id, not by content, so re-promotion does not collide with the prior tombstone.
- If, for some reason, the *same* memory_id is excised silently and then later un-excised (no such path exists in v0; mentioned for completeness), the scorer must re-treat the memory_id as live. This would require an explicit `signal_kind:"un_expunge"` row, which is OUT OF SCOPE for v0.

### 6.5 Corrupt-tail recovery

Per `architecture.md § ingestion failure modes` — on startup, the substrate scans the damping log backwards from EOF and truncates at the first row that fails JSON parsing or schema validation. The truncation is logged as `policy.damping_log.corrupt_tail_truncated` (added to the policy-events kinds table as `policy.damping_log.*`). Mid-file corruption (a corrupt row with valid rows after it) is NOT truncated; instead the corrupt row is skipped at read time and the byte offset is recorded for forensics. The damping log uses the SAME discipline as `source-ledgers` — corruptable tail; mid-file is opaque.

### 6.6 Engagement detection edge cases

| Case                                                                           | Decision                                                                                                                                                                                  |
|--------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| User turn does not reference any surfaced memory                               | Emit `engagement_class: "no_engagement"` for every memory in `prior_surfaced`.                                                                                                              |
| User turn references TWO surfaced memories (e.g. "yeah on both Robin and Alex") | Emit one engagement row per referenced memory, classified independently. `evidence_span_hash` may be identical for both rows (same span).                                                  |
| User turn is itself a recall trigger (e.g. "what else about Robin?")           | The current turn's recall fires AFTER the engagement detection on the prior turn — the new recall's `surfacing` rows are written under the *new* turn_window_id. No conflict.              |
| User turn is empty (deleted before send) or whitespace-only                    | Skip detection entirely. The prior recall's surfacing rows stand alone with no engagement attached — they decay over K turns to zero contribution.                                          |
| LLM in the just-ended assistant turn quoted a memory verbatim                  | IRRELEVANT to engagement detection. We attribute only to the user's next turn. The assistant's quote is NOT engagement — this is the `research-retrieval-frontiers.md § Risks #12` fix.    |
| `evidence_span_hash` collides across two rows                                  | No constraint; the hash is a forensic anchor, not a key.                                                                                                                                    |
| K-turn window elapses with no detection AND no `no_engagement` row was emitted | Treat as if `engagement_class: "no_engagement"` had been emitted at K turns past. The scorer's `decay(turns_since)` formula will zero out the contribution naturally.                       |

### 6.7 Engagement-class taxonomy (FIXED at 5 values)

The five classes are exhaustive and disjoint:

| Class            | Trigger condition                                                                                                          | Weight  |
|------------------|----------------------------------------------------------------------------------------------------------------------------|---------|
| `direct`         | User turn contains tokens from the memory's `content` (≥ 3 contiguous-word match, case-insensitive)                          | +1.0    |
| `paraphrase`     | Gemini embedding cosine(user_turn, memory.content) ≥ 0.75 AND not a `direct` match                                          | +0.6    |
| `correction`     | User turn contains negation around any token of the memory's content (e.g. "no, it was actually X")                          | +0.4    |
| `dismiss`        | User turn matches a dismiss pattern (CAPS.DISMISS_PATTERNS) referencing the memory                                          | -0.5    |
| `no_engagement`  | None of the above fired within the next user turn                                                                          | 0.0     |

The engagement-detector node's previous 6-class taxonomy (`agreement`, `contradiction`, `explicit_reference`, `dismissal`, etc.) is collapsed:

- `agreement` ⇒ `direct`
- `contradiction` ⇒ `correction`
- `explicit_reference` ⇒ `direct`
- `dismissal` ⇒ `dismiss`

The Gemini classifier referenced in the behavior tier draft (with `ENGAGEMENT_FUZZY_THRESHOLD` and `ENGAGEMENT_DUAL_JUDGE_SAMPLE_RATE`) is implemented as a *single* classifier that emits one of these five labels per `(memory_id, user_turn)` pair. The dual-judge sampling is a calibration-time concern (judge two classifiers in parallel on a stratified 5% sample for drift detection) — it does NOT change the emitted taxonomy.

### 6.8 Cross-runtime engagement attribution (the Codex carve-out)

Codex's Stop hook payload only carries `last_assistant_message`. We resolve this by running engagement detection on **UserPromptSubmit for the next turn**, identical to Claude Code (see § 6.2). The stitch cache (`CODEX_TURN_STITCH_TTL_SECONDS = 300`) preserves the prior `recall_id` and `prior_surfaced[]` keyed by `(conversation_id, turn_index - 1)`. If the cache TTL expires before the next user turn arrives, the detector emits no engagement rows for that recall — the scorer treats it identically to "K turns elapsed with no engagement" (zero contribution).

---

## 7. CAPS introduced

All knobs land in `mcp/lib/validation.js § CAPS` as a single `RECALL_FEEDBACK` block, snapshot per recall via `_capsSnapshot()` for replay auditability.

| Cap                                          | Default                            | Source / rationale                                                                                                                              |
|----------------------------------------------|------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| `RECALL_K_TURN_WINDOW`                       | `3`                                | `open-problems.md § 8` — guess; calibrated via O5. Matches the upstream design's wave size.                                                                |
| `ENGAGEMENT_WEIGHTS`                         | see § 6.7 table                    | `thesis.md § 5` + `research-retrieval-frontiers.md § Risks #12`; weights are signed; sum is not constrained.                                    |
| `RAW_SURFACING_PENALTY`                      | `0.2`                              | `thesis.md § 5` — "raw surfacing is anti-reinforced"; magnitude calibrated against engagement weights such that an engaged direct overrides 5x raw surfacing. |
| `RECALL_W_ENG`                               | `0.3`                              | additive-side weight on multi-feature score; tunable.                                                                                          |
| `DAMPING_LOG_RETENTION_DAYS`                 | `null` (forever)                   | `thesis.md § 1` — "ledger is permanent". Operator may set a TTL via CAPS.                                                                       |
| `DAMPING_INHERITED_STRENGTH_MAX`             | `0.5`                              | Cap inherited engagement at half of the direct engagement weight to prevent runaway propagation.                                              |
| `CROWDED_NEIGHBORHOOD_PENALTY`               | `-0.3`                             | Magnitude calibrated so a single crowded-neighborhood hit overrides one engaged direct's worth of boost.                                       |
| `CROWDED_NEIGHBORHOOD_JACCARD_THRESHOLD`     | `0.5`                              | Half-overlap between candidate entities and the neighborhood entity_set.                                                                       |
| `DAMPING_LOG_LOCK_STALE_RECOVERY_SECONDS`    | `60`                               | Shared cap from `acquireExclusiveLockFile`.                                                                                                    |
| `DAMPING_LOG_READ_TTL_SECONDS`               | `60`                               | TTL for cached `expungedMemoryIds` set on the scorer side.                                                                                      |
| `DISMISS_PATTERNS`                           | `[/^stop bringing/, /not relevant/, /forget that/i, ...]` | regex list for the engagement detector's `dismiss` classification.                                                  |
| `ENGAGEMENT_FUZZY_THRESHOLD`                 | `0.75`                             | cosine threshold for `paraphrase` classification.                                                                                              |
| `ENGAGEMENT_DUAL_JUDGE_SAMPLE_RATE`          | `0.05`                             | 5% sample rate for parallel-judge calibration; does NOT affect the emitted taxonomy.                                                            |

---

## 8. Examples

### Example 1 — Vanilla recall + engaged direct

Operator is talking to Claude Code about scheduling. The recall surfaces three memories at turn 5 (`conversation_id = "cc-2026-06-18-abc"`). At turn 6, the user says "yeah on Robin's 2pm slot" — engagement detected against `mem_robin_meeting`.

**Step 1 — Public recall row** (`ledgers/memory.jsonl`):

```json
{"id":"rec_01HVX...","ts":"2026-06-18T14:05:11Z","kind":"recall","provenance":{"agent_id":"claude-code","conversation_id":"cc-2026-06-18-abc","confidence":0.9},"query":{"context_embedding":[...3072 floats...],"embedding_model_version":"gemini-embedding-001@2026-04","surrounding_context_hash":"5ec...a4"},"surfaced":[{"memory_id":"mem_robin_meeting","score":0.81,"position":0},{"memory_id":"mem_calendar_tuesday","score":0.74,"position":1},{"memory_id":"mem_alex_dm","score":0.61,"position":2}],"density_flag":null,"truncated":false}
```

**Step 2 — Damping log writes for the recall** (`policy/damping-log.jsonl`, three surfacing rows):

```json
{"schema_version":1,"signal_kind":"surfacing","memory_id":"mem_robin_meeting","turn_window_id":"qK7c...XQ","recall_id":"rec_01HVX...","conversation_id_hash":"hZ9..d3","ts":"2026-06-18T14:05:11Z","populator_version":"damping-log@1.0.0","fields":{"surfaced_strength":0.81,"position":0,"score":0.81,"propensity":0.42}}
{"schema_version":1,"signal_kind":"surfacing","memory_id":"mem_calendar_tuesday","turn_window_id":"qK7c...XQ","recall_id":"rec_01HVX...","conversation_id_hash":"hZ9..d3","ts":"2026-06-18T14:05:11Z","populator_version":"damping-log@1.0.0","fields":{"surfaced_strength":0.37,"position":1,"score":0.74,"propensity":0.31}}
{"schema_version":1,"signal_kind":"surfacing","memory_id":"mem_alex_dm","turn_window_id":"qK7c...XQ","recall_id":"rec_01HVX...","conversation_id_hash":"hZ9..d3","ts":"2026-06-18T14:05:11Z","populator_version":"damping-log@1.0.0","fields":{"surfaced_strength":0.20,"position":2,"score":0.61,"propensity":0.18}}
```

(`surfaced_strength` for position 1 = `0.74 / 2 = 0.37`; position 2 = `0.61 / 3 ≈ 0.20`.)

**Step 3 — User responds at turn 6: "yeah on Robin's 2pm slot"**. The engagement detector (running in UserPromptSubmit for turn 7's window or, more precisely, the user turn that immediately follows the recall) detects a direct match on `mem_robin_meeting`, and `no_engagement` on the other two. It writes:

```json
{"schema_version":1,"signal_kind":"engagement","memory_id":"mem_robin_meeting","turn_window_id":"qK7c...XQ","recall_id":"rec_01HVX...","conversation_id_hash":"hZ9..d3","ts":"2026-06-18T14:05:34Z","populator_version":"engagement-detector@1.0.0","fields":{"engagement_class":"direct","engagement_weight":1.0,"evidence_span_hash":"6ab...c1","detector_version":"engagement-detector@1.0.0"}}
{"schema_version":1,"signal_kind":"engagement","memory_id":"mem_calendar_tuesday","turn_window_id":"qK7c...XQ","recall_id":"rec_01HVX...","conversation_id_hash":"hZ9..d3","ts":"2026-06-18T14:05:34Z","populator_version":"engagement-detector@1.0.0","fields":{"engagement_class":"no_engagement","engagement_weight":0.0,"evidence_span_hash":"","detector_version":"engagement-detector@1.0.0"}}
{"schema_version":1,"signal_kind":"engagement","memory_id":"mem_alex_dm","turn_window_id":"qK7c...XQ","recall_id":"rec_01HVX...","conversation_id_hash":"hZ9..d3","ts":"2026-06-18T14:05:34Z","populator_version":"engagement-detector@1.0.0","fields":{"engagement_class":"no_engagement","engagement_weight":0.0,"evidence_span_hash":"","detector_version":"engagement-detector@1.0.0"}}
```

**Step 4 — Next recall fires at turn 7** (same conversation, new turn_window_id `qK7c..._W2`). Scorer aggregates over the K=3 window:

For `mem_robin_meeting`:
- surfacing contribution at turns_since=1 (prior turn window): `-0.2 * (1 - 1/3) = -0.133`
- engagement contribution at turns_since=1: `+1.0 * (1 - 1/3) = +0.667`
- `score_boost = -0.133 + 0.667 = +0.534`
- final score adjustment: `+0.3 * 0.534 = +0.160`

For `mem_calendar_tuesday`:
- surfacing contribution at turns_since=1: `-0.133`
- engagement contribution (`no_engagement`, weight 0): `0`
- `score_boost = -0.133`
- final score adjustment: `+0.3 * (-0.133) = -0.040`

Net effect: Robin's memory rises in the next brief; the unengaged calendar memory falls. This is `thesis.md § 5` working as designed.

### Example 2 — Silent excise with co-surfaced memories

Operator calls `memory_excise({target: "mem_alex_dm", silent: true})`. The public recall ledger has one `recall` row from Example 1 that references all three memory_ids. The damping log has three surfacing rows + three engagement rows.

**Step 1** — `memory_excise` rewrites the public ledger row to remove `mem_alex_dm` from `surfaced[]` (surgical row delete is more accurate than "row delete" — the row stays, only the `mem_alex_dm` entry is excised from its `surfaced[]` array). Or, depending on the silent-excise discipline declared in `mcp-surface.md`, the entire `recall` row is excised. Either way, the operation is mediated by the screened surface.

**Step 2** — `dampingLog.expunge({memory_id: "mem_alex_dm", excise_reason: "silent_excise"})` is called:

```json
{"schema_version":1,"signal_kind":"expunged","memory_id":"mem_alex_dm","turn_window_id":"EXPUNGE_GLOBAL","recall_id":null,"conversation_id_hash":null,"ts":"2026-06-18T14:08:22Z","populator_version":"damping-log@1.0.0","fields":{"excise_reason":"silent_excise"}}
```

**Step 3** — Next recall scoring run for any of the OTHER two memories (`mem_robin_meeting`, `mem_calendar_tuesday`) proceeds normally; the damping log still has their surfacing + engagement rows; the scorer's `score_boost` for them is unaffected by Alex's expunge.

This is the open-problems.md #4 invariant: **co-surfaced memories' reinforcement is unaffected by the excise**. The brutalist audit-pass-rejected design ("drop the bucket on excise") would have lost the Robin engagement signal entirely; the two-log split preserves it.

### Example 3 — Density flag fires, then a crowded-neighborhood penalty propagates

The user's recall for "Alex" returns 8 candidates within a 0.03 cosine score gap — density flag fires. The recall row has `density_flag: "many_candidates_near_topic"` and an empty `surfaced[]` (no specific memories returned, per `operations.md § Density flag`).

**Step 1 — Public recall row:**

```json
{"id":"rec_01HVZ...","ts":"2026-06-18T15:11:00Z","kind":"recall","provenance":{"agent_id":"claude-code","conversation_id":"cc-2026-06-18-def","confidence":0.4},"query":{...},"surfaced":[],"density_flag":"many_candidates_near_topic","truncated":false}
```

**Step 2 — Damping log writes** — no surfacing rows (empty brief), but one `crowded_neighborhood` row:

```json
{"schema_version":1,"signal_kind":"crowded_neighborhood","memory_id":null,"turn_window_id":"rA8...P0","recall_id":"rec_01HVZ...","conversation_id_hash":"e8..b1","ts":"2026-06-18T15:11:00Z","populator_version":"damping-log@1.0.0","fields":{"entity_set_hash":"jK2...rt","entity_set":["entity_alex_person","entity_thursday","entity_dm_topic"],"time_window_start":null,"time_window_end":null,"candidates_pre_truncation":["mem_alex_dm_1","mem_alex_dm_2","mem_alex_meeting","mem_alex_pr","mem_alex_msg_thursday","mem_alex_msg_sunday","mem_alex_followup","mem_alex_ack"]}}
```

**Step 3 — Next recall at turn 6** for the same conversation, query mentions "what did Alex say last Thursday". Candidate `mem_alex_dm_1` is scored. The scorer sees:
- It is in `candidates_pre_truncation` ✓
- Its entities `{entity_alex_person, entity_thursday, entity_msg}` overlap the crowded neighborhood's entities at Jaccard `|{alex, thursday}| / |{alex, thursday, dm_topic, msg}| = 2/4 = 0.5` ✓ (meets threshold)
- `event_contribution = CAPS.CROWDED_NEIGHBORHOOD_PENALTY = -0.3` (no decay; the neighborhood is a property of the recall, not of time).

So `score_boost(mem_alex_dm_1) = -0.3`; the multi-feature score is dampened by `0.3 * 0.3 = 0.09` on the final-score side. This pushes the recall toward emitting `density_flag` AGAIN (rather than confidently surfacing one Alex memory) — operationalizing `thesis.md § 4`: "the index erodes" becomes "scoring backs off in crowded neighborhoods."

### Example 4 — Engagement-inherited propagation

The user engages with `mem_alex_pr` (a fact derived from a github PR event). The derivation graph has `mem_alex_pr.derived_from = [mem_alex_commit_a, mem_alex_commit_b]` — two parent commits.

The derivation propagator (`F-SYN-FOUNDATION-derivation-propagation`) reads the engagement and writes inherited rows for the two parents:

```json
{"schema_version":1,"signal_kind":"engagement_inherited","memory_id":"mem_alex_commit_a","turn_window_id":"qK7c...XQ","recall_id":null,"conversation_id_hash":"hZ9..d3","ts":"2026-06-18T14:06:01Z","populator_version":"derivation-propagator@1.0.0","fields":{"inherited_strength":0.5,"source_engagement_recall_id":"rec_01HVX...","source_memory_id":"mem_alex_pr","derivation_depth":1}}
{"schema_version":1,"signal_kind":"engagement_inherited","memory_id":"mem_alex_commit_b","turn_window_id":"qK7c...XQ","recall_id":null,"conversation_id_hash":"hZ9..d3","ts":"2026-06-18T14:06:01Z","populator_version":"derivation-propagator@1.0.0","fields":{"inherited_strength":0.5,"source_engagement_recall_id":"rec_01HVX...","source_memory_id":"mem_alex_pr","derivation_depth":1}}
```

`inherited_strength = 0.5` is the `CAPS.DAMPING_INHERITED_STRENGTH_MAX`. At `derivation_depth = 1`, the cap is reached fully; at depth 2 (grandparent), the inherited_strength would be `0.5 * 0.5 = 0.25` (the propagator applies depth decay; see the propagation node's own spec for the formula).

At the next recall: parents `mem_alex_commit_a` and `mem_alex_commit_b` get `event_contribution = 0.5 * decay(1) = 0.5 * 0.667 = 0.333`. Even if they were NOT in the original surfacing brief, they are now boosted as if they had been engaged — the system "learned" that the PR engagement should propagate to the commits that produced it.

### Example 5 — Codex CLI cross-runtime equivalence

Same Example 1 scenario but on Codex CLI. The runtime emits `conversation_id = "codex-2026-06-18-xyz"`. The bridge layer normalizes via `agent-integration.md § chat-codex` (the runtime-name prefix is stripped before hashing).

- `turn_window_id = base64url(sha256("codex-2026-06-18-xyz" || 0x1F || BE_u64(1) || 0x1F || BE_u64(3)))`. The first three turns of the conversation share `base_turn_index = 0`, the next three share `base_turn_index = 1`, etc.
- Engagement detection runs on UserPromptSubmit for turn 6 (the user turn AFTER the assistant turn that consumed the brief). The stitch cache (`CODEX_TURN_STITCH_TTL_SECONDS=300`) carries the `recall_id` and `prior_surfaced[]` from turn 5 into turn 6's UserPromptSubmit context.
- Otherwise: identical writes to Example 1. The damping log does NOT care which runtime the engagement came from — the schema is runtime-agnostic.

---

## 9. Invariants

These must hold across every implementation of the substrate, the recall scorer, and the four behavior nodes. CI enforces (I1, I3–I5, I9); the rest are property-tested.

| ID  | Invariant                                                                                                                                                                                                                                                                                                                                                                                       |
|-----|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| I1  | Damping-log rows are append-only. The file is NEVER mutated in place. Engagement is a NEW row referencing the original `{memory_id, recall_id}` join, not a mutation of the surfacing row. The only "delete" is the `expunged` tombstone (also a new row). |
| I2  | `schema_version` allows forward-compatible additions. Readers MUST skip rows with unknown `signal_kind` values; readers MUST NOT crash on unknown keys inside `fields`. |
| I3  | `memory_id` is null IF AND ONLY IF `signal_kind === "crowded_neighborhood"`. All other kinds require a memory_id. |
| I4  | `recall_id` may be null only for `signal_kind ∈ {"engagement_inherited", "expunged"}`. All other kinds require a recall_id (and the recall_id MUST be the id of an existing row on `ledgers/memory.jsonl`). |
| I5  | `conversation_id_hash` may be null only for `signal_kind === "expunged"`. All other kinds require a conversation_id_hash. |
| I6  | The damping log NEVER stores plaintext `conversation_id`. Only the hash. Path-leak of the damping log MUST NOT reveal conversation membership. |
| I7  | The damping log is the ONLY persistent store of engagement signal. The public recall ledger MUST NOT carry engagement fields on `kind:"recall"` rows. (This isolates the engagement signal from `silent: true` excise — excising a recall_id does not lose engagement; the engagement row references that recall_id but lives separately.) |
| I8  | The damping log is consumed by `mcp/lib/recall/score-candidate.js` (read) and `mcp/scripts/replay-salience.mjs` (read) only. No MCP tool, no hook, no daemon other than the writers (recall service, engagement detector, derivation propagator, `memory_excise`) reaches the file. Enforced by a path-blocklist convention in `mcp/lib/recall-feedback/damping-log.js` AND by CI grep over `mcp/lib/**` ensuring no other module imports the damping-log file path. |
| I9  | The `turn_window_id` encoding is byte-exact across implementations. CI ships a fixture of `(conversation_id, turn_index, window_size, expected_turn_window_id)` triples; any drift fails CI. |
| I10 | `surfaced_strength = clamp01(score * (1 / (1 + position)))`. No other formula is permitted. |
| I11 | `engagement_weight` is sourced from `CAPS.ENGAGEMENT_WEIGHTS` keyed by `engagement_class`. The detector MUST NOT mint custom weights inline. |
| I12 | An `expunged` row for memory_id `m` is permanent: subsequent surfacing rows on `m` do not "un-expunge" `m`. The scorer's `expungedMemoryIds` set is monotonic-additive. |
| I13 | All file writes acquire `damping-log.lock` via the canonical `acquireExclusiveLockFile` discipline. |
| I14 | The file mode is `0600` from creation. CI tests that the file, when created by the test fixture, is mode `0600`. |
| I15 | Schema-version + populator-version on every row enable retrospective debugging. CI ships a fixture of "old populator wrote schema_version=1 with fields[X]; new populator writes schema_version=1 with fields[X, Y]"; the reader MUST tolerate both. |
| I16 (`I-CONSUMER-SCHEMA-REFERENCE`) | Every consumer call site of `appendSurfacing()` / `appendEngagement()` / `appendInheritedEngagement()` / `appendCrowdedNeighborhood()` / `expunge()` MUST import `RECALL_LOG_SCHEMA_VERSION` from the single shared module `mcp/lib/recall-feedback/damping-log-schema.js`. CI grep (`mcp/test/recall-feedback/consumer-schema-import.test.mjs`) fails if any consumer omits the import. Part B of the same test fails if legacy plaintext shapes (`engagement_outcome`, plaintext `conversation_id`, numeric `turn_window`, `DAMPING_*` CAPS names, `CORROBORATION_PROPAGATION_DECAY`, `MAX_CORROBORATION_DEPTH`, `tanh.*engagement`) appear anywhere under `mcp/lib/**` or `mcp/scripts/**` outside the schema module itself or the legacy-fixture directory. Part C deep-equality-compares each writer's output against the verbatim envelope fixtures in `mcp/test/recall-feedback/fixtures/canonical/`. See § 4.7.4. |

### Honest privacy framing

Per `thesis.md § 7`: the "private" in "private damping log" means **architectural segregation from the MCP surface**. It does NOT mean OS-enforced. A same-uid attacker with `Bash` access can read `<data root>/policy/damping-log.jsonl` directly — file mode `0600` does not protect against the user's own processes. The screening discipline (no MCP tool reads this file; the file is under `policy/` not under `ledgers/` to signal "operational signal, not authoritative memory state") is a screening + audit layer, not a privilege boundary. Stronger guarantees (separate uid for the recall service, Keychain-backed access) are deferred to Phase 4+.

This is the right framing because the alternative — silently implying that the file is "private from the agent" — would be the kind of implied-security-property the thesis explicitly calls out as the temptation to resist.

---

## 10. Open questions (forward to wave-N tasks)

| #   | Question                                                                                                                                                                                                          | Owner / wave                                  |
|-----|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------|
| OQ1 | `RECALL_K_TURN_WINDOW=3` is a guess (matches the upstream design's wave size). Needs O5 calibration. The spec declares 3 as the initial CAPS value; the calibration loop is tier-operational.                                  | Operational tier O5 calibration loop          |
| OQ2 | `RAW_SURFACING_PENALTY=0.2` vs `direct engagement=1.0` is a 5x ratio. Does that ratio hold up under operator-corpus calibration, or do we need to widen/narrow?                                                     | Operational tier O5                            |
| OQ3 | `CROWDED_NEIGHBORHOOD_JACCARD_THRESHOLD=0.5` is asserted. Below this, density-flag history does not penalize a candidate. Threshold should be calibrated against the corpus distribution of recall-time entity sets. | Operational tier O5                            |
| OQ4 | Damping-log retention: forever vs operator-tunable TTL. Forever is consistent with `thesis.md § 1`; a TTL would let the user cap storage growth (~4M rows/year at 1k recalls/day). v0 ships forever; CAPS knob is wired in but defaults to null. | Operator decision                              |
| OQ5 | Does engagement propagation through derivation graph write `engagement_inherited` for every propagated parent, or only for the directly-engaged event? Multiple writes risks double-counting; single-write loses provenance. **v0 decision: multiple writes, capped at `DAMPING_INHERITED_STRENGTH_MAX = 0.5`**; the cap prevents runaway aggregation. Reviewer should sign off. | `F-SYN-FOUNDATION-derivation-propagation`     |
| OQ6 | Sync vs async engagement detection. Spec pins **next UserPromptSubmit** (sync to the next user turn, NOT sync to the Stop hook). Open: is the latency on the UserPromptSubmit boundary acceptable? Measure.        | Phase 1 integration tier; latency review      |
| OQ7 | Engagement classifier choice: Gemini Flash inline vs a local zero-shot classifier. Spec assumes Gemini Flash; if rate-limited or unavailable, fall back to a regex/cosine combination (`paraphrase` channel uses cosine ≥ 0.75 anyway). Behavior tier owns the fallback strategy. | `F-SYN-INTEGRATION-engagement`                |
| OQ8 | What is the right `evidence_span_hash` granularity — full user turn, sentence containing the engagement, or token window? v0: sentence-containing-the-engagement (`segmenter.sentences(user_turn)` then pick the closest sentence to the matched evidence). Behavior tier owns the segmenter choice. | `F-SYN-INTEGRATION-engagement`                |
| OQ9 | The `EXPUNGE_GLOBAL` sentinel in `turn_window_id` for expunge rows is a special-case break in the canonical encoding. Acceptable hack or should we encode expunge tombstones in a separate file? v0: in-file with sentinel; the scorer recognizes the sentinel explicitly. Operator can override. | Substrate tier                                |
| OQ10 | The `crowded_neighborhood` row stores `candidates_pre_truncation` — potentially long arrays. At ~100 candidates × 24 bytes/memory_id × 1k recalls/day × 365 days = ~875 MB/year just for this field. Acceptable storage cost? Operator may want to cap to top-K candidates. | Operator decision; CAPS knob deferred         |

---

## 11. Cross-tier impact

This spec is the **schema-of-record**. The following downstream nodes MUST mirror it verbatim; their previous divergent drafts are SUPERSEDED.

### 11.1 Substrate

| Node                                | Constraint                                                                                                                                                                  |
|-------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `F-SYN-SUBSTRATE-DAMPING-LOG`       | Implements `mcp/lib/recall-feedback/damping-log.js` exactly per § 5.1. File path, mode, lock discipline, envelope, per-kind fields — all pinned here. Substrate's prior flat `{kind, engagement_strength}` row shape is RETIRED. |

### 11.2 Behavior

| Node                                                | Constraint                                                                                                                                                                                                                       |
|-----------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `F-SYN-BEHAVIOR-damping-from-recall-log`             | Read path uses `readWindowedSignals` exactly per § 5.1; reinforcement formula is the linear-decay aggregate from § 6.3. The tanh-bounded variant is REJECTED.                                                                       |
| `F-SYN-BEHAVIOR-recall-log-write-engagement`         | Writes `signal_kind:"surfacing"` rows on recall and `signal_kind:"engagement"` rows on next user turn. Schema is per § 4.4.1 + § 4.4.2.                                                                                            |
| `F-SYN-BEHAVIOR-density-flag-feedback`               | Writes `signal_kind:"crowded_neighborhood"` rows per § 4.4.4 — INCLUDING the raw entity_set, not just the hash. Reads via Jaccard at scoring time per § 6.3.                                                                       |
| `F-SYN-BEHAVIOR-corroboration-propagation`           | Writes `signal_kind:"engagement_inherited"` rows per § 4.4.3, capped at `CAPS.DAMPING_INHERITED_STRENGTH_MAX`. Derivation-depth-decay formula owned by the node's own spec but pinned here as monotonic-decreasing in `derivation_depth`. |
| `F-SYN-BEHAVIOR-engagement-detector` (if separate)    | 5-class taxonomy per § 6.7. The behavior-tier draft's 6-class taxonomy is COLLAPSED into the 5 fixed classes.                                                                                                                       |

### 11.3 Integration

| Node                                                | Constraint                                                                                                                                                                                                                       |
|-----------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `F-SYN-INTEGRATION-engagement`                       | Engagement detector runs in next UserPromptSubmit, NOT in Stop. Cross-runtime: Codex stitch cache (`CODEX_TURN_STITCH_TTL_SECONDS=300`) carries `recall_id` + `prior_surfaced[]` across the turn boundary.                          |
| `F-SYN-INTEGRATION-cp5-trigger`                       | Reads aggregate per memory_id via `readWindowedSignals`; uses `last_signal_ts` to drive `last_retrieved_ts` and `use_count` weight-bumps under CP-5 Trigger A (`salience-design.md`).                                              |
| `F-SYN-FOUNDATION-derivation-propagation`            | Writes `signal_kind:"engagement_inherited"`; honors the `DAMPING_INHERITED_STRENGTH_MAX` cap.                                                                                                                                     |

### 11.4 Operational

| Concern                                       | Constraint                                                                                                                                                                  |
|-----------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `mcp/scripts/replay-salience.mjs`            | Reads the damping log; replays the reinforcement formula against historical state; produces the byte-idempotent replay path needed for CAPS bumps (`salience-design.md § R24.5 graft`). |
| O5 calibration loop                          | Tunes `RECALL_K_TURN_WINDOW`, `ENGAGEMENT_WEIGHTS`, `RAW_SURFACING_PENALTY`, `RECALL_W_ENG`, and `CROWDED_NEIGHBORHOOD_PENALTY` against logged data. All knobs are CAPS, so re-calibration is a byte-idempotent rewrite. |
| `memory_excise` (MCP)                        | On `silent: true`, MUST call `dampingLog.expunge(memory_id)` after the public ledger surgical-delete completes.                                                              |
| `memory_health` (MCP)                        | MUST report the damping log's size, last-write-ts, and the count of `expunged` rows (forensic visibility into how often silent excise has fired). NOT the contents.            |

### 11.5 CAPS

Single source of truth: `mcp/lib/validation.js § CAPS.RECALL_FEEDBACK`. All knobs from § 7 land in this block. The block is snapshotted per recall via `_capsSnapshot()` so historical replays know which weights produced which scores.

---

## 12. Test plan (sketch — implementer fills in)

| Test                                                                                                                                                                            | Asserts                                                                                                                                                                                                                                          |
|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `damping-log-schema.test.js`                                                                                                                                                  | Every row matches the envelope; per-kind fields validate; `memory_id`/`recall_id`/`conversation_id_hash` null-rules per I3/I4/I5.                                                                                                                  |
| `turn-window-id-encoding.test.js`                                                                                                                                              | Fixture of 12 `(conversation_id, turn_index, window_size, expected)` triples; all match the canonical encoding from § 4.5. Includes edge cases: empty conversation_id (`""`), conversation_id with 0x1F byte (must be rejected upstream), turn_index 0, window_size 1. |
| `reinforcement-formula.test.js`                                                                                                                                              | Worked examples from § 8 produce the expected `score_boost` values to 6 decimal places. Both Robin's engaged direct (+0.534) and the calendar's pure surfacing (-0.133) match.                                                                     |
| `silent-excise-coherence.test.js`                                                                                                                                              | Open-problems.md #4 invariant: after `expunge(mem_alex_dm)`, co-surfaced `mem_robin_meeting` retains its engagement-boost score_boost unchanged. Property test over 100 random recalls × 3 memories × random excise patterns.                       |
| `engagement-attribution.test.js`                                                                                                                                               | Risk #12 invariant: when the user turn is empty, no engagement rows are written for the prior surfaced[]. When the assistant turn quotes the memory but the user does not, no engagement rows are written. Engagement is attributed to the user only. |
| `damping-log-private-access.test.js`                                                                                                                                          | CI grep over `mcp/lib/**` (excluding `mcp/lib/recall-feedback/`, `mcp/lib/recall/score-candidate.js`, `mcp/scripts/replay-salience.mjs`) asserts NO file path-references `damping-log.jsonl`. I8.                                                  |
| `damping-log-mode.test.js`                                                                                                                                                    | The damping log, when written, has file mode `0600`. I14.                                                                                                                                                                                          |
| `damping-log-append-only.test.js`                                                                                                                                              | Property test: 1000 random writes followed by an `expunge`, then a re-read — the log file size monotonically grew; the read returns expected aggregate; the expunge tombstone is present in the file. I1 + I12.                                  |
| `crowded-neighborhood-jaccard.test.js`                                                                                                                                        | Candidate with overlap ≥ 0.5 gets penalty; overlap < 0.5 does not. Candidate NOT in `candidates_pre_truncation` is never penalized regardless of entity overlap.                                                                                  |
| `codex-stitch-cache.test.js`                                                                                                                                                  | Cross-runtime: a fixture conversation in Codex with stitch cache populated produces identical damping-log rows (modulo runtime-specific conversation_id) to the same conversation in Claude Code.                                                  |

---

## 13. Glossary

| Term                          | Meaning                                                                                                                                                                       |
|-------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Public recall ledger**      | `kind:"recall"` rows on `ledgers/memory.jsonl`. Plaintext `conversation_id`. Surgically deletable on `silent:true` excise.                                                       |
| **Private damping log**       | `<data root>/policy/damping-log.jsonl`. Hashed `conversation_id`. Append-only with tombstones. Architecturally segregated from the MCP surface.                              |
| **`turn_window_id`**          | sha256-base64url over `(conversation_id, base_turn_index, window_size)`. The bucket key for windowed reinforcement aggregation.                                                  |
| **`conversation_id_hash`**    | sha256-base64url of conversation_id. The damping log's only conversation reference; plaintext is on the public ledger only.                                                     |
| **Surfacing strength**        | `clamp01(score * 1/(1+position))`. Position-weighted brief score; the damping signal for raw surfacing.                                                                          |
| **Engagement class**          | One of five: direct / paraphrase / correction / dismiss / no_engagement. Pinned 5-class taxonomy; weights in `CAPS.ENGAGEMENT_WEIGHTS`.                                          |
| **Engagement weight**         | Signed scalar: +1.0 / +0.6 / +0.4 / -0.5 / 0.0 respectively. Drives the reinforcement formula's positive contribution.                                                            |
| **Inherited engagement**      | Engagement signal propagated from a derivation child to its parents. Capped at `CAPS.DAMPING_INHERITED_STRENGTH_MAX = 0.5`.                                                       |
| **`crowded_neighborhood`**    | A signal-kind row written when the recall fires `density_flag`. Carries `candidates_pre_truncation` + `entity_set` for Jaccard-based penalty at read time.                       |
| **`expunged`**                | A tombstone row written by `memory_excise(silent:true)`. Global (no turn_window, no conversation_id_hash). Filters all of memory_id's other rows to net=0 at the scorer.          |
| **`readWindowedSignals`**     | The scorer's read API. Returns `SignalAggregate` keyed by memory_id; the scorer reads ONCE per recall and applies the boost per-candidate.                                       |
| **`score_boost`**             | The output of the reinforcement formula. Added to the multi-feature score as `+ CAPS.RECALL_W_ENG * score_boost`.                                                                |
| **K-turn window**             | The look-back window for reinforcement aggregation. `K = CAPS.RECALL_K_TURN_WINDOW`. Default 3; rows older than K turns contribute 0 (decay reaches 0).                            |
| **Stitch cache (Codex)**      | The 300-second TTL cache that holds `(recall_id, prior_surfaced[])` keyed by `(conversation_id, turn_index-1)`, used by the engagement detector to attribute on the next user turn. |

---

## 14. Change log

- 2026-06-18 — Initial spec. Synthesized from `F-SYN-FOUNDATION-recall-log-split` node + the `WU-damping-log-schema` revision step. Authoritative schema for the substrate and four behavior nodes.
- 2026-06-18 — WU-recall-log-split-final-reconciliation (BLOCKER closure). Added § 4.7 "Authoritative Schema for Consumers": (a) `RECALL_LOG_SCHEMA_VERSION = "v1"` constant pinned to a single shared module `mcp/lib/recall-feedback/damping-log-schema.js`; (b) verbatim JSON envelopes for all five signal kinds (§ 4.7.2.A–E); (c) field-by-field translation table from legacy behavior-tier plaintext shapes (top-level `kind`, plaintext `conversation_id`, numeric `turn_window`, inline `engagement_outcome`, 6-class taxonomy, hash-only `entity_set`, in-process `candidates_pre_truncation`, local `DAMPING_*` CAPS namespace, local `tanh` aggregation) to canonical hashed/structured shapes (§ 4.7.3); (d) CI-checkable invariant `I-CONSUMER-SCHEMA-REFERENCE` enforcing (Part A) shared-module import on every writer call site, (Part B) zero hits for legacy plaintext shapes outside the schema module and legacy-fixture directory, and (Part C) verbatim envelope fixture deep-equality (§ 4.7.4). Cross-listed as invariant I16 in § 9. Behavior-tier consumer nodes (damping-from-recall-log, recall-log-write-engagement, density-flag-feedback, engagement-detector, corroboration-propagation) updated in lock-step to reference § 4.7 by name and cite `RECALL_LOG_SCHEMA_VERSION`.
