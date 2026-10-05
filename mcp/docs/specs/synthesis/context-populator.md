# Surrounding-context populator contract (server-side, hook-driven, symmetric to cascade-stamp)

**Node:** `F-SYN-FOUNDATION-context-populator`
**Tier:** foundation (design_spec, blocker)
**Status:** synthesis-ready; depends on `F-SYN-FOUNDATION-entity-schema`, `F-SYN-FOUNDATION-time-anchor-schema`, `F-SYN-FOUNDATION-valence-provenance`.
**Constrains:** the recall handler at `mcp/lib/tools/recall.js`, the `UserPromptSubmit` hook at `hooks/recall-on-prompt.sh`, the Codex CLI equivalent, the recall-event ledger event shape, the predicate-snapshot embedding step of `memory_exclude`, and the operational drift-detection re-stamp loop.

---

## 1. Mission

Pin **who** populates `surrounding_context.{entities, time_anchors, ambient.inferred_mood, ambient.parties_present, ambient.calendar_state}` at recall time, **when** the population fires, **which modules** it invokes, and **what wire shape** the upstream hook hands to the MCP. Today, `mcp/lib/tools/recall.js` validates a `surrounding_context.ambient` block (parties_present, calendar_state, inferred_mood) but nothing populates `surrounding_context.entities`, `surrounding_context.time_anchor`, or `surrounding_context.valence` — the scoring pass in `computeScore` is wired with an *empty* `scoringContext` (`{entities: [], time_anchor: null, valence: null}`, see `recall.js` § g). The Wave-2 substrate primitives (`mcp/lib/synthesis/entity-extractor.js`, `time-anchor-resolver.js`, `valence-scorer.js`) exist, are versioned, and are already called on the cascade-stamp side at promote-time — but no one calls them on the recall-consume side. This spec closes that loop by mandating a **server-side populator** that runs **inside** the recall handler, **before** candidate scoring, using the **same module imports** the cascade uses. The unifying invariant: a candidate's `features.entities[]` and the recall's `surrounding_context.entities[]` were produced by the same `extractor_version`, against the same `canonical_id` rules, with the same `STOPWORDS` set — symmetry is enforced by code identity, not by review.

This spec also forecloses three failure modes the brutalist review flagged: agent-side fabrication of entity tags (`thesis.md` Principle 7), hook-side NL extraction in bash (wrong stack, easily skipped), and silent on-demand re-extraction per candidate inside the scorer (redundant work, breaks the `surrounding_context` contract documented in `operations.md`).

---

## 2. kb anchors

The contract is grounded in four KB passages. Each is reproduced verbatim from `/tmp/memory-system-hypergraph-synthesis/audit_ref/`; binding language is preserved.

### A1 — `operations.md` § `recall(surrounding_context) → brief` / Inputs

> ```
> surrounding_context: {
>   recent_turns: [],            # last N conversation turns
>   agent_role,                  # e.g., "assistant", "writer", "scheduler"
>   current_query,               # the immediate utterance
>   time,                        # ISO timestamp
>   ambient: {
>     calendar_state,
>     inferred_mood,             # heuristic from word choice
>     parties_present            # if multi-user
>   },
>   recent_recall_ids: []        # for damping
> }
> ```

**Binding:** the **input** to the populator is exactly this schema MINUS the populated fields. The hook passes `{recent_turns, agent_role, current_query, time, ambient.parties_present?, ambient.calendar_state?, recent_recall_ids}` and NOTHING ELSE. The populator emits the **enriched** shape: the input plus `entities`, `time_anchors`, `ambient.inferred_mood`, AND a normalized/augmented `ambient.parties_present`. The phrase "heuristic from word choice" in the comment is the declared lineage — the populator is exactly the component that performs that heuristic.

### A2 — `agent-integration.md` § Claude Code → Recall injection

> `UserPromptSubmit` hook → calls memory MCP → emits brief as a system reminder via stdout

**Binding:** the **caller** is `UserPromptSubmit` (Claude Code) or its Codex equivalent (`SessionStart`/`UserPromptSubmit` per `~/.codex/hooks.json` per § Per-runtime integration). The hook is a thin shell script; everything it learns about the conversation comes from the runtime's hook JSON on stdin. The hook does NOT do NL extraction; it forwards. The MCP recall handler is the populator.

### A3 — `operations.md` § recall → Scoring

> `+ w2 * entity_overlap(memory.entities, context.entities) + w3 * time_proximity(memory.time_anchors, context.time)`

**Binding:** `context.entities` and `context.time` are READ by the scorer as features. The scorer ASSUMES they are populated. The populator is the component that fulfills the assumption. The score formula is the **consumer**; this spec defines the **producer**.

### A4 — `research-retrieval-frontiers.md` § Risks #12 + critic §4 query.mood provenance

> "valence/mood channel has a silent NLP dependency — populator must declare where query.mood is derived from (closes the silent NLP dependency)."

**Binding:** before this spec, `query.mood` (the recall-time valence signal that feeds the `w_val * valence_compat` term in `research-retrieval-frontiers.md` § Layer 2) was a silent dependency on an undeclared upstream NLP component. This spec MAKES the dependency declared, versioned, and locatable: it is `mcp/lib/synthesis/valence-scorer.js` (the same module the cascade uses), invoked at `mcp/lib/recall/context-populator.js` (this spec's new module), and stamped on every recall-log event as `populator.valence_model_version`. There is no other lineage; there cannot be one.

### A5 — `thesis.md` § Principle 7 (Agents cannot write durably)

> "Mutation goes through a narrow MCP surface that validates, screens, attaches provenance — the agent cannot fabricate surrounding_context fields the scorer trusts."

**Binding:** the principle is not just about ledger writes. The recall scorer **trusts** `surrounding_context.entities`. If the agent supplies them, the agent can bias the scorer toward arbitrary memories by passing entity tags absent from any recent turn. The principle therefore extends to the population step: **the agent does not populate, the server does.** Request validation REJECTS agent-provided `entities`, `time_anchors`, or `inferred_mood` with `error_code: 'POPULATOR_OWNED_FIELD_PROVIDED'`. The screen exists at the MCP boundary; the populator is the screen's content for these fields.

### A6 — `research-retrieval-frontiers.md` § Recommended Phase 3 architecture (Layer 1)

> "The dense leg encodes each segment of `surrounding_context` (`current_query`, each `recent_turn`, `agent_role`, resolved time anchor) separately as `RETRIEVAL_QUERY` vectors"

**Binding:** "resolved time anchor" is a segment role the dense leg encodes as its own vector. The populator is what RESOLVES it. The segment-builder in `recall.js` (`buildSegments`) currently emits no `time_anchor` segment because the field is null upstream. After this spec, the populator emits `time_anchors[]`; `buildSegments` adds a `time_anchor` role for the highest-confidence anchor, or omits the segment when `time_anchors.length === 0`.

---

## 3. Architectural placement

```
                       ┌────────────────────────────────────────┐
                       │  Claude Code runtime (or Codex CLI)    │
                       │                                        │
                       │  UserPromptSubmit hook JSON on stdin   │
                       └──────────────────┬─────────────────────┘
                                          │  recent_turns, current_query,
                                          │  agent_role, time, parties_present?,
                                          │  recent_recall_ids
                                          ▼
                       ┌────────────────────────────────────────┐
                       │  hooks/recall-on-prompt.sh             │
                       │  (thin shell; jq + curl/node MCP call) │
                       │  FORBIDDEN: any NL extraction here     │
                       └──────────────────┬─────────────────────┘
                                          │  MCP tools/call memory_recall
                                          │  args.surrounding_context = RAW
                                          ▼
                       ┌────────────────────────────────────────┐
                       │  mcp/lib/tools/recall.js handler       │
                       │  Step 1: validate raw shape            │
                       │  Step 2: REJECT populator-owned fields │
                       │  Step 3: call populateSurroundingContext
                       │  Step 4: build segments, embed,        │
                       │          retrieve, gate, score, log    │
                       └──────────────────┬─────────────────────┘
                                          │  fullCtx
                                          ▼
                       ┌────────────────────────────────────────┐
                       │  mcp/lib/recall/context-populator.js   │  ◀── NEW MODULE
                       │                                        │
                       │  imports SAME modules cascade uses:    │
                       │    synthesis/entity-extractor.js       │
                       │    synthesis/time-anchor-resolver.js   │
                       │    synthesis/valence-scorer.js         │
                       └──────────────────┬─────────────────────┘
                                          │  populator_version, latency_ms,
                                          │  entities, time_anchors,
                                          │  inferred_mood, parties_present
                                          ▼
                       ┌────────────────────────────────────────┐
                       │  recall-log.jsonl event:               │
                       │    populator: {                        │
                       │      version, entity_extractor_version,│
                       │      time_anchor_resolver_version,     │
                       │      valence_model_version,            │
                       │      latency_ms, degraded:bool         │
                       │    }                                   │
                       └────────────────────────────────────────┘
```

The dotted lines from the **cascade-stamper** in `mcp/lib/ingest/salience.js` (Stage-2 entity stamping, time-anchor stamping, valence stamping at promote time) to **`mcp/lib/synthesis/{entity-extractor,time-anchor-resolver,valence-scorer}.js`** are the same as the recall-side dotted lines. Symmetry by code identity, not by code review.

---

## 4. Schemas

All shapes below are normative. Two implementations MUST produce field-byte-identical outputs from identical inputs.

### 4.1 `RawSurroundingContext` (hook → MCP)

```ts
interface RawSurroundingContext {
  // —————— hook-passed (per kb/operations.md surrounding_context schema) ——————
  recent_turns: Array<{ role: "user" | "assistant" | "system" | "tool"; content: string }>;
  agent_role: string;          // e.g., "assistant", "writer", "scheduler"
  current_query: string;
  time: string;                // ISO-8601 UTC, server-stamped by the hook
  recent_recall_ids?: string[];
  ambient?: {
    // hook-passed only; populator never overwrites these two:
    calendar_state?: object | null;       // null at v0 (calendar connector deferred)
    parties_present?: string[];           // raw runtime knowledge (multi-user)
    // FORBIDDEN AT INPUT — populator-owned (rejected with error if present):
    inferred_mood?: never;
  };

  // —————— populator-owned (rejected if hook/agent supplies them) ——————
  entities?: never;
  time_anchors?: never;
  // ambient.inferred_mood — see above
}
```

Request validation REJECTS any input that includes `surrounding_context.entities`, `surrounding_context.time_anchors`, or `surrounding_context.ambient.inferred_mood`. Error code: `POPULATOR_OWNED_FIELD_PROVIDED`. The error message names the offending field. No partial honoring — the principle is hard-shut.

### 4.2 `FullSurroundingContext` (populator output → scorer)

```ts
interface FullSurroundingContext extends RawSurroundingContext {
  // Populated by mcp/lib/recall/context-populator.js — never by the agent.
  entities: Entity[];                   // shape per F-SYN-FOUNDATION-entity-schema
  time_anchors: TimeAnchor[];           // shape per F-SYN-FOUNDATION-time-anchor-schema
  ambient: {
    calendar_state: object | null;      // pass-through from hook (null at v0)
    parties_present: string[];          // merged: hook + extracted (see §6.3)
    inferred_mood: Valence;             // shape per F-SYN-FOUNDATION-valence-provenance
  };
  // Provenance trailer — written to the recall-log event verbatim.
  populator: {
    version: "v1";                      // POPULATOR_VERSION constant
    entity_extractor_version: string;   // e.g., "v0.1.0"
    time_anchor_resolver_version: string; // e.g., "rule-v1"
    valence_model_version: string;      // e.g., "lexicon-v1"
    latency_ms: number;                 // wall-clock of populator only
    degraded: boolean;                  // true if any sub-extractor threw
    degraded_reasons: string[];         // e.g., ["entity_extractor_threw"]
  };
}
```

The `populator.*` block is the O6-drift-detection re-stamp seed. It is NOT consumed by the scorer; it is consumed by the recall-event log and by `memory_exclude`'s predicate-snapshot routine (so an exclusion captured today continues to match next week when the predicate is re-evaluated against new candidates).

### 4.3 `Entity` (refresher — full spec lives in `entity-schema.md`)

```ts
interface Entity {
  kind: "person" | "place" | "time" | "topic" | "artifact" | "event" | "source_handle";
  canonical_id: string;            // <source>:<kind>:<slug>
  surface: string;                 // original surface form
  source_scope: string;            // matches scope segment in canonical_id
  evidence: "structural" | "linguistic" | "ner" | "user_declared";
  confidence: number;              // [0, 1]
  extractor_version: string;       // ENTITY_EXTRACTOR_VERSION
  span: [number, number] | null;   // byte offset in the source text the populator concatenated
}
```

### 4.4 `TimeAnchor` (refresher — full spec lives in `time-anchor-schema.md`)

```ts
interface TimeAnchor {
  kind: "absolute" | "relative" | "recurring";
  instant_iso: string | null;
  duration_ms: number | null;
  raw_phrase: string;
  span: [number, number];
  confidence: number;
}
```

### 4.5 `Valence` (refresher — full spec lives in `valence-provenance.md`)

```ts
interface Valence {
  sign: -1 | 0 | 1;
  magnitude: number;               // [0, 1]
  source: "lexicon" | "model";     // 'lexicon' at v0
  model_version: string;           // MODEL_VERSION ('lexicon-v1' at v0)
}
```

### 4.6 CAPS additions (single source of truth: `mcp/lib/validation.js § CAPS`)

```ts
const CAPS = {
  // …existing CAPS…
  POPULATOR_VERSION: "v1",                          // bumped per §8 invariants
  POPULATOR_MAX_LATENCY_MS_SOFT: 200,               // alert threshold, not fail-shut
  POPULATOR_MAX_LATENCY_MS_HARD: 1500,              // fail-shut: degrade and emit warning
  POPULATOR_CONCAT_BYTE_CAP: 50_000,                // matches time-anchor-resolver internal cap
  POPULATOR_PARTIES_PRESENT_MAX: 32,                // post-merge cap
  POPULATOR_MEMOIZE_TTL_MS: 0,                      // v0: NO caching (see §6.5)
};
```

### 4.7 `recall-log` event extension (additive over v0/v1 shape)

The recall-log event written to `ledgers/recall.jsonl` (per `phase3-v0-contracts.md § 5`) gains one additive top-level block:

```jsonc
{
  // …existing v0+v1 fields per phase3-v0-contracts.md and phase3-v1-rerank-contracts.md…
  "populator": {
    "version": "v1",
    "entity_extractor_version": "v0.1.0",
    "time_anchor_resolver_version": "rule-v1",
    "valence_model_version": "lexicon-v1",
    "latency_ms": 47,
    "degraded": false,
    "degraded_reasons": [],
    "entities_count": 3,
    "time_anchors_count": 1,
    "inferred_mood_sign": -1,
    "parties_present_count_hook": 0,
    "parties_present_count_post_merge": 1,
    "parties_present_added_by_extraction": 1
  }
}
```

The counts (not the full entities/anchors) are recorded for drift-detection efficiency. The full `entities[]` and `time_anchors[]` arrays are NOT logged on the event — they are reachable from the concatenated input via `surrounding_context_hash` already present on the event. This avoids doubling recall-log size while preserving the audit trail.

---

## 5. Module surface

### 5.1 Module path

```
mcp/lib/recall/context-populator.js       ← NEW MODULE (this spec)
```

Wired into `mcp/lib/tools/recall.js` as the **FIRST step after request validation**, BEFORE `buildSegments`, `embedSegments`, `hybridRetrieve`, `applyHardGates`, `computeScore`.

### 5.2 Public function

```js
/**
 * Populate the surrounding_context with extracted entities, time anchors,
 * inferred mood, and a merged parties_present list. Server-side only.
 *
 * @param {RawSurroundingContext} rawCtx  Hook-passed shape; populator-owned
 *                                         fields MUST NOT be present (caller
 *                                         is responsible for the reject path).
 * @param {object} [opts]
 * @param {string} [opts.source]          Source scope for entity extraction;
 *                                         defaults to "agent" for chat-origin
 *                                         recall. Must be one of
 *                                         ENTITY_SOURCE_SCOPES.
 * @param {string} [opts.now]             ISO timestamp used by the time-anchor
 *                                         resolver for "tomorrow" / "next
 *                                         week" resolution. Defaults to
 *                                         rawCtx.time.
 * @returns {FullSurroundingContext}
 * @throws {ToolError}                     ERROR_CODES.POPULATOR_FAILED only
 *                                         when CAPS.POPULATOR_MAX_LATENCY_MS_HARD
 *                                         is exceeded AND fail-shut is enabled.
 *                                         Otherwise see §6.4 (soft-degrade).
 */
export function populateSurroundingContext(rawCtx, opts = {}) { /* … */ }
```

### 5.3 Required imports (symmetry contract)

These import paths are **load-bearing**. Any test fixture asserting symmetry MUST grep for them in BOTH `mcp/lib/ingest/salience.js` AND `mcp/lib/recall/context-populator.js`. A divergent import — e.g., recall-time importing a `recall/entity-extractor.js` shim — is a CI-blocking conformance failure (see §8 invariant I-CP-2).

```js
import {
  extractEntities,
  ENTITY_EXTRACTOR_VERSION,
  ENTITY_SOURCE_SCOPES,
} from "../synthesis/entity-extractor.js";

import {
  resolveTimeAnchors,
  TIME_ANCHOR_RESOLVER_VERSION,
} from "../synthesis/time-anchor-resolver.js";

import {
  scoreValence,
  MODEL_VERSION as VALENCE_MODEL_VERSION,
} from "../synthesis/valence-scorer.js";

import { CAPS } from "../validation.js";
import { ToolError, ERROR_CODES } from "../error-codes.js";
```

### 5.4 Recall-handler wiring (delta to `mcp/lib/tools/recall.js`)

Replace the `scoringContext` block that currently reads:

```js
// CURRENT (recall.js § g, lines ~360-370):
const scoringContext = {
  entities: [],
  time_anchor: null,
  valence: null,
};
```

with:

```js
// PROPOSED (after this spec lands):
import { populateSurroundingContext } from "../recall/context-populator.js";

// …after request validation, before buildSegments:
const fullCtx = populateSurroundingContext(ctx, { now: ctx.time });
const scoringContext = {
  entities: fullCtx.entities,
  time_anchor: fullCtx.time_anchors.length > 0 ? fullCtx.time_anchors[0] : null,
  valence: fullCtx.ambient.inferred_mood,
};

// And use fullCtx (not ctx) for buildSegments + downstream scorer call:
const segments = buildSegments(fullCtx);
// …
// stamp the populator block onto the recall-log event:
appendRecallEvent({ /* …existing fields…, */ populator: fullCtx.populator });
```

`buildSegments` gains a `time_anchor` segment role iff `fullCtx.time_anchors.length > 0`:

```js
function buildSegments(ctx) {
  const segments = [];
  // …existing roles…
  if (ctx.time_anchors && ctx.time_anchors.length > 0) {
    segments.push({
      segment_role: "time_anchor",
      text: ctx.time_anchors[0].raw_phrase,
    });
  }
  return segments;
}
```

---

## 6. Decision rules

### 6.1 Input concatenation order (deterministic; load-bearing)

The populator extracts from a single concatenated string, NOT from per-turn texts independently. Deterministic order matters because `extractEntities` returns `span` byte offsets the recall-log event references for audit.

```
concatenatedText =
  recent_turns
    .map(t => t.content)
    .join("\n")
  + "\n"
  + current_query
```

The `agent_role` field is NOT concatenated (it is a structured tag, not free text — and feeding it to NER recreates FM-1-class noise on words like `"assistant"`). The `time` ISO string is NOT concatenated (it is the resolver's `now`, not extraction input).

If `concatenatedText.length > CAPS.POPULATOR_CONCAT_BYTE_CAP` (50_000), the populator TRUNCATES to the cap (suffix-preserving — i.e., keep the last 50_000 bytes) and stamps `populator.degraded_reasons += ["input_truncated"]`. Truncation does NOT set `degraded: true` — it is a known bounded behavior, not an extractor failure.

### 6.2 Source scope choice

The populator passes `source: "agent"` to `extractEntities` by default. Rationale: the recall input is the AGENT's working surface (recent_turns from the assistant + user). The `agent` source scope's stopword set is calibrated against agentic-coding transcripts in the cascade-stamper. Symmetry with the cascade is automatic because both call paths use the same module and the same scope.

If `rawCtx.recent_turns[].role === "user"` and the recall is being driven from an inbound iMessage thread (Phase 2b connector), the caller MAY pass `opts.source = "imessage"` — but this is NOT a v0 path. v0 always uses `"agent"`.

### 6.3 `parties_present` merge rule (closes critic Issue MINOR-1)

```
fullCtx.ambient.parties_present =
  dedup(
    (rawCtx.ambient?.parties_present ?? []),   // HOOK-PASSED, authoritative-first
    extractedPersonEntities                     // augmented from extraction
      .filter(e => e.kind === "person")
      .map(e => e.canonical_id)
  ).slice(0, CAPS.POPULATOR_PARTIES_PRESENT_MAX)
```

- The hook's `parties_present` is **trusted-first** — the runtime knows the multi-user state from a source the extractor cannot see (e.g., an iMessage thread participant list). Hook-supplied entries are kept in order, deduped against each other by case-insensitive string equality.
- Extracted person entities are **augmented-after** — appended in order of `span` ascending, deduped against the hook list AND against prior extracted entries. The dedup key is the `canonical_id` (per `entity-schema.md`'s per-source-scope canonical-id contract). If a hook-supplied raw string and an extracted `canonical_id` refer to the same person but differ in surface form (e.g., `"Alice"` vs `"agent:person:alice"`), they are NOT merged in v0 — v0 dedup is by-string within hook + by-canonical-id within extracted. The cross-domain alias graph is a v1 concern (see `entity-schema.md § alias-graph deferred`).
- Hard cap at 32 entries; the AUGMENTED entries are truncated first, never the HOOK entries (the hook entries are authoritative).

The populator stamps `parties_present_added_by_extraction` on the recall-log event so the user can observe how often extraction-augmented the hook list (drift signal).

### 6.4 Failure mode policy: soft-degrade with stamped reason (closes critic Issue MINOR-2)

The populator **soft-degrades by default**. If any sub-extractor throws OR exceeds the soft latency cap, the populator:

1. Catches the throw / records the latency.
2. Substitutes a degraded-but-typed value for the failing channel:
   - entity-extractor threw → `entities: []`
   - time-anchor-resolver threw → `time_anchors: []`
   - valence-scorer threw → `inferred_mood: {sign: 0, magnitude: 0, source: "lexicon", model_version: VALENCE_MODEL_VERSION}` (the neutral sentinel)
3. Stamps `populator.degraded = true` and appends a reason to `populator.degraded_reasons[]` (e.g., `"entity_extractor_threw"`, `"valence_scorer_threw"`, `"latency_soft_exceeded"`).
4. Returns the partially-populated `fullCtx` so the recall pipeline continues; the brief envelope sets `degraded_recall = true` (the existing v0 contract field, per `phase3-v0-contracts.md § 4`).

**Hard fail-shut** triggers only when `populator.latency_ms > CAPS.POPULATOR_MAX_LATENCY_MS_HARD` (1500ms). At that point the populator throws `ToolError(POPULATOR_FAILED, "populator hard-latency cap exceeded")` and the recall handler surfaces the error to the agent. Rationale: 1500ms exceeds any plausible user-visible latency budget; a populator at that scale is almost certainly looping, and silently emitting an empty `surrounding_context` would corrupt the recall-event log with a hard-to-diagnose failure mode. The soft cap (200ms) is the alert threshold — it logs but does not fail.

Defaults are **explicit** in this spec because the brutalist-review issue MINOR-2 named "leaving this to open_questions" as the wrong move on the recall hot path.

### 6.5 Memoization

v0 **does NOT memoize.** `CAPS.POPULATOR_MEMOIZE_TTL_MS = 0`. Rationale: the populator is on the recall hot path but each recall already produces a distinct `surrounding_context_hash` (which folds in `current_query`, all `recent_turns`, `agent_role`, `time`, `ambient.parties_present`) — two recalls sharing a hash AND firing within a TTL window AND benefiting from a cache hit are vanishingly rare. The brutalist's open-question about a cache layer is intentionally deferred: a cache layer (a) costs operator complexity (TTL choice, invalidation on extractor-version bump), (b) buys little (most multi-recall conversations advance current_query and recent_turns turn-by-turn), and (c) the soft latency budget (200ms) is already comfortably reachable without one. A future v1 may set `POPULATOR_MEMOIZE_TTL_MS > 0` keyed on `sha256(canonical_json(rawCtx))` if measured p95 exceeds the soft cap on >5% of recalls.

### 6.6 `calendar_state` ownership

The populator NEVER computes `calendar_state`. It is pass-through from the hook. v0 sets it to `null` because no calendar connector ships at Phase 0 / Phase 1 / Phase 2a / Phase 2b. When a calendar connector lands (Phase 3+, not currently in `build-plan.md`), the hook's caller (e.g., a Codex extension) will pass `calendar_state: {now_event: {...}, next_event: {...}}` and the populator will pass it through unchanged. The populator NEVER calls the calendar API itself — that is the connector's job, and routing it through the populator would re-introduce the silent-NLP-dependency class of failure this spec exists to close.

### 6.7 Versioning + drift-detection seed

Three version stamps flow through to the recall-log event:

```
populator.entity_extractor_version    = ENTITY_EXTRACTOR_VERSION    (e.g., "v0.1.0")
populator.time_anchor_resolver_version = TIME_ANCHOR_RESOLVER_VERSION (e.g., "rule-v1")
populator.valence_model_version       = MODEL_VERSION                (e.g., "lexicon-v1")
```

When any of these bumps (e.g., `STOPWORDS` gains a new entry, a relative-time regex is added, a positive-word lexicon expands), the new version is stamped on every NEW recall event automatically — the populator imports the version constants from the substrate modules, so a substrate bump propagates by re-import. **OLD recall events keep their old stamps** (the recall-log is append-only). The operational re-stamp loop (`F-SYN-OPERATIONAL-drift-detection`) is the consumer: when a `populator.version` change is detected across the recall-log tail, an operator-triggered job re-runs the populator over a sample of historical `surrounding_context_hash` inputs to measure drift (delta in `entities_count`, `inferred_mood_sign`, etc.). This spec emits the version stamps; the re-stamp pass itself is OUT OF SCOPE here and OWNED by `F-SYN-OPERATIONAL-drift-detection`.

The `populator.version` field (a string `"v1"`, separate from the three substrate versions) bumps when THIS SPEC's behavior changes (e.g., concatenation order, source-scope policy, parties_present merge rule). Substrate bumps DO NOT bump `populator.version` — they propagate through the substrate version stamps.

---

## 7. Examples

Every example uses invented, illustrative data. The "input" rows are the RAW context the hook passes; the "output" rows are the FULL context the populator returns.

### 7.1 Example A — single-turn recall with one explicit time anchor

**Input (hook → MCP):**

```json
{
  "recent_turns": [
    { "role": "user", "content": "I'm meeting with Robin tomorrow at 3pm — anything I should remember about her?" }
  ],
  "agent_role": "assistant",
  "current_query": "anything I should remember about her?",
  "time": "2026-06-18T19:00:00Z",
  "ambient": { "calendar_state": null, "parties_present": [] },
  "recent_recall_ids": []
}
```

**Concatenated text fed to extractors:**

```
I'm meeting with Robin tomorrow at 3pm — anything I should remember about her?
anything I should remember about her?
```

**Populator output (FullSurroundingContext):**

```json
{
  "recent_turns": [/* unchanged */],
  "agent_role": "assistant",
  "current_query": "anything I should remember about her?",
  "time": "2026-06-18T19:00:00Z",
  "recent_recall_ids": [],
  "entities": [],
  "time_anchors": [
    {
      "kind": "relative",
      "instant_iso": "2026-06-19T15:00:00Z",
      "duration_ms": null,
      "raw_phrase": "tomorrow at 3pm",
      "span": [22, 37],
      "confidence": 0.9
    }
  ],
  "ambient": {
    "calendar_state": null,
    "parties_present": [],
    "inferred_mood": {
      "sign": 0,
      "magnitude": 0,
      "source": "lexicon",
      "model_version": "lexicon-v1"
    }
  },
  "populator": {
    "version": "v1",
    "entity_extractor_version": "v0.1.0",
    "time_anchor_resolver_version": "rule-v1",
    "valence_model_version": "lexicon-v1",
    "latency_ms": 18,
    "degraded": false,
    "degraded_reasons": []
  }
}
```

Notes on this example:

- `entities` is empty because v0 entity-extractor harvests **structural** entities (URLs, emails, GitHub repo paths, phones, file paths, hashtags). The proper noun `"Robin"` is NOT structural and is not harvested at v0. Linguistic-evidence person extraction is deferred to a later substrate version. This is INTENTIONAL — `salience-design.md` Appendix A.1 documents FM-1 conflation of arbitrary capitalized names as the failure mode v0 explicitly defends against by NOT extracting them.
- `time_anchors[0]` is resolved against `opts.now = "2026-06-18T19:00:00Z"`. "tomorrow at 3pm" → `2026-06-19T15:00:00Z` (assuming UTC; the resolver's tz policy is owned by `time-anchor-schema.md`).
- `inferred_mood.sign === 0` because the lexicon has no positive/negative hits on this text.
- `ambient.parties_present` stays empty even though "Robin" is mentioned, because v0 entity extraction does not harvest names. The hook also passed empty. The recall-log event will record `parties_present_added_by_extraction: 0`.
- The scorer receives `scoringContext = { entities: [], time_anchor: <the absolute resolved anchor>, valence: <neutral> }`. The `w3 * time_proximity` term gets a non-zero contribution; the `w2 * entity_overlap` term is 0; the `w_val * valence_compat` term is 0.

### 7.2 Example B — multi-turn recall with a GitHub URL + negative valence

**Input (hook → MCP):**

```json
{
  "recent_turns": [
    { "role": "user", "content": "I'm furious about the regression in https://github.com/anthropics/claude-code — they broke `claude doctor`." },
    { "role": "assistant", "content": "Understood. Want me to check if there's a known issue?" },
    { "role": "user", "content": "yes, and also pull anything about my last conversation about this repo." }
  ],
  "agent_role": "assistant",
  "current_query": "yes, and also pull anything about my last conversation about this repo.",
  "time": "2026-06-18T20:14:00Z",
  "ambient": { "calendar_state": null, "parties_present": [] },
  "recent_recall_ids": ["rec_a1b2c3d4"]
}
```

**Populator output (abridged for brevity; populator/version block as in Example A):**

```json
{
  "entities": [
    {
      "kind": "artifact",
      "canonical_id": "agent:artifact:github_com_anthropics_claude_code",
      "surface": "https://github.com/anthropics/claude-code",
      "source_scope": "agent",
      "evidence": "structural",
      "confidence": 1.0,
      "extractor_version": "v0.1.0",
      "span": [38, 80]
    },
    {
      "kind": "artifact",
      "canonical_id": "agent:artifact:anthropics_claude_code",
      "surface": "anthropics/claude-code",
      "source_scope": "agent",
      "evidence": "structural",
      "confidence": 1.0,
      "extractor_version": "v0.1.0",
      "span": [46, 68]
    }
  ],
  "time_anchors": [],
  "ambient": {
    "calendar_state": null,
    "parties_present": [],
    "inferred_mood": {
      "sign": -1,
      "magnitude": 0.31,
      "source": "lexicon",
      "model_version": "lexicon-v1"
    }
  },
  "populator": {
    "version": "v1",
    "entity_extractor_version": "v0.1.0",
    "time_anchor_resolver_version": "rule-v1",
    "valence_model_version": "lexicon-v1",
    "latency_ms": 42,
    "degraded": false,
    "degraded_reasons": []
  }
}
```

Notes:

- The URL and the GitHub-repo-path are BOTH harvested by `entity-extractor.js` (`harvestUrls`, `harvestGithubRepoPaths`). These will dedup at `canonical_id` granularity inside the extractor's coalescing pass — only one survives per `canonical_id`. Two different `canonical_id`s mean two distinct ENTITY ROWS (one for the URL form, one for the path form), which is by design (the recall-time scorer cares about `entity_overlap` against memory entities indexed under either form).
- `inferred_mood.sign === -1` because the words "furious", "broke", "regression" hit the negative lexicon.
- The recall scorer will receive `scoringContext.entities = [...both entity rows]`. The `entity_overlap_jaccard` term will fire against any memory in the ledger whose `features.entities[]` contains either canonical id — including the historic memory from the user's prior conversation about this repo (which is exactly what the user asked to pull).
- The `time_anchors` array is empty (no temporal phrase in the input).

### 7.3 Example C — soft-degrade: time-anchor-resolver throws

Imagine `time-anchor-resolver.js` throws a TypeError mid-scan on a malformed input (hypothetical regression — not observed today). The populator catches it.

**Input:** same as Example A.

**Populator output (degraded):**

```json
{
  "entities": [],
  "time_anchors": [],
  "ambient": {
    "calendar_state": null,
    "parties_present": [],
    "inferred_mood": {
      "sign": 0,
      "magnitude": 0,
      "source": "lexicon",
      "model_version": "lexicon-v1"
    }
  },
  "populator": {
    "version": "v1",
    "entity_extractor_version": "v0.1.0",
    "time_anchor_resolver_version": "rule-v1",
    "valence_model_version": "lexicon-v1",
    "latency_ms": 21,
    "degraded": true,
    "degraded_reasons": ["time_anchor_resolver_threw"]
  }
}
```

- The other channels (entities, valence) still ran successfully. Only the time-anchor channel zeroed out.
- The recall handler reads `populator.degraded === true` and propagates `brief.degraded_recall = true` to the agent (existing v0 contract field — `phase3-v0-contracts.md § 4`).
- The recall-log event records `populator.degraded_reasons === ["time_anchor_resolver_threw"]`. The user dashboard (Phase 3 v1+ observability) alarms on any non-zero rate of populator degrades over a rolling window.

### 7.4 Example D — agent attempts to inject a populator-owned field

**Input (an agent has, against discipline, decided to "help" by passing entities):**

```json
{
  "recent_turns": [/* … */],
  "agent_role": "assistant",
  "current_query": "what did I say last time about AlexEx7?",
  "time": "2026-06-18T20:30:00Z",
  "ambient": { "calendar_state": null, "parties_present": [] },
  "recent_recall_ids": [],
  "entities": [
    {
      "kind": "person",
      "canonical_id": "agent:person:alexex7",
      "surface": "AlexEx7",
      "source_scope": "agent",
      "evidence": "user_declared",
      "confidence": 1.0,
      "extractor_version": "v0.1.0",
      "span": [0, 7]
    }
  ]
}
```

**Populator response:**

```
ToolError {
  code: "POPULATOR_OWNED_FIELD_PROVIDED",
  message: "surrounding_context.entities is owned by the recall-side populator; the caller MUST NOT supply this field"
}
```

- The agent CANNOT bias the scorer by passing entities.
- The agent CANNOT skip entity extraction by passing `entities: []`.
- The agent CANNOT spoof `inferred_mood` to game the `w_val` term.
- The hook is also bound by the same rule (any hook that drifts into NL extraction will trip this validation in CI integration tests).

### 7.5 Example E — multi-party iMessage thread with hook-supplied parties_present + extraction augmentation

**Input (hook → MCP, from a phase-2b iMessage-driven recall):**

```json
{
  "recent_turns": [
    { "role": "user", "content": "Carol just sent me a link: https://github.com/example/memory-system — can you remember when I last discussed this?" }
  ],
  "agent_role": "assistant",
  "current_query": "can you remember when I last discussed this?",
  "time": "2026-06-18T21:00:00Z",
  "ambient": {
    "calendar_state": null,
    "parties_present": ["+15555550101", "+15555550102"]
  },
  "recent_recall_ids": []
}
```

**Populator output (relevant fields):**

```json
{
  "entities": [
    {
      "kind": "artifact",
      "canonical_id": "agent:artifact:github_com_example_memory_system",
      "surface": "https://github.com/example/memory-system",
      "source_scope": "agent",
      "evidence": "structural",
      "confidence": 1.0,
      "extractor_version": "v0.1.0",
      "span": [27, 67]
    },
    {
      "kind": "artifact",
      "canonical_id": "agent:artifact:example_memory_system",
      "surface": "example/memory-system",
      "source_scope": "agent",
      "evidence": "structural",
      "confidence": 1.0,
      "extractor_version": "v0.1.0",
      "span": [35, 56]
    }
  ],
  "ambient": {
    "parties_present": ["+15555550101", "+15555550102"]
  }
}
```

Notes:

- The hook-supplied phone numbers stay AT THE FRONT of `parties_present` (hook-first rule, §6.3). No augmented persons because v0 doesn't harvest names like "Carol".
- The recall-log event records `parties_present_count_hook: 2, parties_present_added_by_extraction: 0, parties_present_count_post_merge: 2`.
- If a later substrate version adds linguistic-evidence person extraction, "Carol" would become e.g. `agent:person:carol`, and the populator would dedup it against the hook entries (which are phone-number-typed and NOT alias-resolvable at v0) — so v1+ would surface a `parties_present_count_post_merge: 3`. This is the alias-graph-deferred case from `entity-schema.md`.

---

## 8. Invariants (CI-enforceable)

These are the rules a CI smoke test SHOULD assert. Each names the failure mode it forecloses.

### I-CP-1 — populator-owned fields rejected at the MCP boundary

A request with ANY of `surrounding_context.entities`, `surrounding_context.time_anchors`, `surrounding_context.ambient.inferred_mood` MUST be rejected with `ERROR_CODES.POPULATOR_OWNED_FIELD_PROVIDED` BEFORE any work happens. Closes: agent-side fabrication (`thesis.md` Principle 7).

### I-CP-2 — symmetry by code identity

`mcp/lib/recall/context-populator.js` imports:
- `extractEntities` from `../synthesis/entity-extractor.js`
- `resolveTimeAnchors` from `../synthesis/time-anchor-resolver.js`
- `scoreValence` from `../synthesis/valence-scorer.js`

AND `mcp/lib/ingest/salience.js` (the cascade-stamper) imports from the SAME module paths (no shims, no `recall/entity-extractor.js`, no `ingest/entity-extractor.js`). A repo-level `grep -RE "from '\\./(synthesis|recall/entity-extractor|ingest/entity-extractor)'" mcp/lib` test asserts that no second copy exists. Closes: drift between cascade-stamp and recall-consume extractor behavior; the I1↔I2 cross-tier invariant becomes a CI gate.

### I-CP-3 — populator runs once per recall, server-side, before scoring

`populateSurroundingContext` is invoked EXACTLY ONCE inside `mcp/lib/tools/recall.js` per request, BEFORE the first call to `buildSegments`, `embedSegments`, `hybridRetrieve`, or `computeScore`. NOT inside a per-candidate loop. Closes: lazy-populator failure mode (alternative #3 in the design choice).

### I-CP-4 — version stamps are READ FROM the substrate modules, not duplicated

`populator.entity_extractor_version` MUST be the `ENTITY_EXTRACTOR_VERSION` constant exported by `entity-extractor.js`. NOT a hard-coded literal in `context-populator.js`. Same for the other two version stamps. Closes: silent skew between substrate version bumps and recall-log version stamps.

### I-CP-5 — populator latency is recorded for every recall

`populator.latency_ms` is a NUMBER on every recall-log event, even on the hard-fail-shut path. Wall-clock measured at populator entry/exit. Closes: blind spot in O6 drift-detection (a populator that quietly slows down to seconds-per-call without ever throwing).

### I-CP-6 — soft-degrade preserves typing

On any soft-degrade, the populator returns a `FullSurroundingContext` with `entities: Entity[]` (possibly empty), `time_anchors: TimeAnchor[]` (possibly empty), and `ambient.inferred_mood: Valence` (possibly the neutral sentinel). It NEVER returns `null` or `undefined` for these fields. Closes: scorer crashes downstream of a degraded populator.

### I-CP-7 — hook does not run NL extraction

`hooks/recall-on-prompt.sh` MUST NOT shell out to any extractor binary, MUST NOT pipe into a node script that imports `synthesis/*`, MUST NOT carry `entities` / `time_anchors` / `inferred_mood` in its MCP request body. A `grep -E "(entity-extractor|time-anchor|valence-scorer|jq.*entities)" hooks/recall-on-prompt.sh` test asserts emptiness. Closes: hook-side NL extraction (alternative #1 in the design choice).

### I-CP-8 — `populator.degraded === true` propagates to `brief.degraded_recall`

The recall-handler MUST set `brief.degraded_recall = true` whenever `populator.degraded === true`, REGARDLESS of whether the Gemini embed leg also degraded. Closes: invisible populator-failure mode in operator dashboards.

### I-CP-9 — `parties_present` hook entries are NEVER truncated by augmentation

If `(hook_count + augmented_count) > CAPS.POPULATOR_PARTIES_PRESENT_MAX`, the populator MUST drop AUGMENTED entries first. Hook entries are dropped ONLY if `hook_count > CAPS.POPULATOR_PARTIES_PRESENT_MAX` (in which case the suffix is dropped). Closes: extraction-augmentation overriding ground-truth runtime knowledge.

### I-CP-10 — `calendar_state` is never set BY the populator

Only the hook supplies `ambient.calendar_state`. The populator's job is to PASS IT THROUGH (or set to `null` if the hook omits it). The populator code path that touches `calendar_state` is exactly one line: `fullCtx.ambient.calendar_state = rawCtx.ambient?.calendar_state ?? null`. Closes: silent connector dependency leaking into the populator (Open Question #6.6).

---

## 9. Open questions

These remain material. Carry forward; do NOT resolve in this spec.

### Q-CP-1 — When does a substrate-version bump trigger an automatic recall-log re-stamp?

Owned by `F-SYN-OPERATIONAL-drift-detection`. This spec emits version stamps; the *trigger* for a re-stamp pass is upstream. Open: do we re-stamp on any minor bump (every `STOPWORDS` change) or only on majors (`v0.x.x` → `v1.0.0`)? Recommendation: minors record drift metrics; majors trigger re-stamps. Resolve in OPERATIONAL tier.

### Q-CP-2 — Should `agent_role` participate in entity extraction in v1?

v0 excludes `agent_role` from the concatenation (§6.1). A v1 extractor with linguistic evidence might want to know "this is the `assistant` speaking" to suppress first-person pronouns or to differently weigh person-mentions. Open: revisit when linguistic-evidence extraction lands.

### Q-CP-3 — How does the populator behave when `recent_turns` is empty (cold-start recall)?

Today, `recent_turns: []` is valid (per `validateRecentTurns` which accepts any array up to `CAPS.RECALL_RECENT_TURNS_MAX`). The populator concatenates `current_query` alone and extracts from it. This works mechanically. Open: does the *brief* envelope want to flag cold-start recalls as a separate quality bucket for operator review? Not the populator's job today, but the populator's `populator.entities_count === 0 && time_anchors_count === 0 && inferred_mood.sign === 0` triple is the natural signal.

### Q-CP-4 — Should `populator.entities[]` carry the FULL extracted entity records, or just `canonical_id`s?

The current schema (§4.2) returns full `Entity` records (with `surface`, `evidence`, `confidence`, `span`). The downstream scorer's `entity_overlap_jaccard` term needs only `canonical_id`s. The `surface` / `span` are useful for the recall-log audit (so an operator can see "the extractor matched `Robin` at byte 22"). Open: is the audit trail worth the bytes? Recommendation: keep full records in the `FullSurroundingContext`; reduce to counts in the recall-log event (per §4.7). The spec's current shape preserves the full audit, which is the more recoverable direction.

### Q-CP-5 — Cross-runtime parity (Codex CLI)

The Codex CLI hook recipe is described in `agent-integration.md` § Per-runtime integration. This spec assumes the Codex hook ALSO passes the raw shape — recent_turns, current_query, agent_role, time — to the same MCP `memory_recall` tool. Open: does the Codex `UserPromptSubmit` payload include all the fields Claude Code's does? If `agent_role` is implicit (Codex hard-codes `"assistant"`), the spec is unchanged. If `agent_role` requires a runtime-side default, the hook documentation MUST name it.

### Q-CP-6 — Memoization revisited if p95 latency exceeds soft cap

v0 declines memoization (§6.5). If real-world recall traffic shows p95 populator latency > 200ms on more than 5% of recalls, a v1 memoization layer becomes appealing. Open: should the cache key be `sha256(canonical_json(rawCtx))` (per-request) or `sha256(concatenatedText + agent_role + time-bucketed-to-minute)` (per near-equivalent text)? The latter buys more hits but introduces a "near-recall" semantic that complicates `surrounding_context_hash` correctness.

---

## 10. Cross-tier impact

This spec constrains and is constrained by the following other tier nodes.

### 10.1 Foundation (sibling) — `F-SYN-FOUNDATION-entity-schema`, `F-SYN-FOUNDATION-time-anchor-schema`, `F-SYN-FOUNDATION-valence-provenance`

The populator's output `Entity[]`, `TimeAnchor[]`, and `Valence` are the schemas defined by these three nodes. **Symmetry contract:** the cascade-stamper and the populator MUST produce identical values for identical inputs. Any change to these schemas that changes serialization order, slug normalization, or value bounds invalidates this spec's examples and SHOULD trigger a populator_version bump.

### 10.2 Substrate — `F-SYN-SUBSTRATE-ENTITY-EXTRACTOR`, `F-SYN-SUBSTRATE-TIME-ANCHOR-RESOLVER`, `F-SYN-SUBSTRATE-VALENCE-SCORER`

The populator IS A CALLER of these substrate modules. **It owns no NL logic of its own.** A substrate module's `version` constant is the populator's `populator.<x>_version` field. The substrate modules MUST be invokable as pure functions with the input contract documented in §5.3 (no I/O, no external API calls, no module-global mutable state). A substrate module that develops latency >50ms per call WILL push the populator over its soft latency cap; substrate spec changes that increase latency MUST be coordinated with this spec's `CAPS.POPULATOR_MAX_LATENCY_MS_SOFT`.

### 10.3 Integration — `F-SYN-INTEGRATION-CONTEXT-POPULATOR-HOOK`

That node defines the **hook → MCP wire shape** in detail (matcher rules, error logging, soft timeouts). This spec defines what the MCP DOES with the wire input. The contract between the two: the hook passes RAW fields; the MCP populates the rest. Cross-tier invariant: any field listed in §4.1 as `never` for input is the hook's hard prohibition AND the MCP's hard rejection.

### 10.4 Integration — `F-SYN-INTEGRATION-RECALL-CONSUMES-ENTITIES`, `F-SYN-INTEGRATION-RECALL-CONSUMES-TIME-ANCHORS`, `F-SYN-INTEGRATION-RECALL-CONSUMES-VALENCE`

Those nodes specify how the SCORER consumes the populated fields. This spec is the PRODUCER. The data shapes in §4.2 ARE the shapes those consumer nodes assume. A change to `Entity.canonical_id` format here is a breaking change for those three nodes.

### 10.5 Operational — `F-SYN-OPERATIONAL-drift-detection`

The populator emits the version stamps; the operational node owns the re-stamp loop that consumes them. Closes the cross-tier seam: the populator does not OWN the loop, but it OWNS the data that makes the loop possible.

### 10.6 MCP surface — `mcp/lib/tools/recall.js`, `mcp/lib/recall-log.js`, `mcp/lib/tools/exclude.js`

- `recall.js` is wired per §5.4.
- `recall-log.js` gains the `populator` block on every recall event per §4.7. The `appendRecallEvent` function signature gains a `populator` field (additive over v0/v1 contracts).
- `exclude.js`: when an operator issues `memory_exclude` against a prior `recall_id`, the predicate-snapshot routine reads the recall event's `surrounding_context_hash` AND its `populator.entity_extractor_version`. If the current `ENTITY_EXTRACTOR_VERSION` differs from the snapshot's, the snapshot's `entities[]` (recoverable by re-running the populator over the recoverable concatenated text — bounded by the recall-log retention) is the AUTHORITATIVE predicate state. This closes the seam where a predicate captured at extractor v0.1.0 must still match candidates indexed at extractor v0.2.0. The implementation detail belongs in the `memory_exclude` spec; this spec ENSURES the metadata is present.

### 10.7 Thesis — Principle 7 (Agents cannot write durably)

The screen at the MCP boundary now extends to the READ path: agents cannot fabricate the inputs the scorer trusts. The principle is upheld by code (`POPULATOR_OWNED_FIELD_PROVIDED` reject) rather than by review. Honest framing: same-uid agents can still drop `surrounding_context.parties_present` to mask multi-user state (the hook-passed-only rule is hard-shut against fabrication but the hook itself runs in the agent's uid). This is the same threat-model boundary that `thesis.md` Principle 7 names: the screen buys "agent cannot fabricate without leaving an audit trail," not "agent cannot influence the input at all." The drift-detection loop catches the second class.

---

## 11. Implementation checklist (out-of-spec, for the implementing node)

The DO step of this node and of the wiring nodes will check off these items.

- [ ] Create `mcp/lib/recall/context-populator.js` exporting `populateSurroundingContext(rawCtx, opts?)` with the §5.2 signature.
- [ ] Add `POPULATOR_OWNED_FIELD_PROVIDED` and `POPULATOR_FAILED` to `mcp/lib/error-codes.js`.
- [ ] Add `POPULATOR_VERSION`, `POPULATOR_MAX_LATENCY_MS_SOFT`, `POPULATOR_MAX_LATENCY_MS_HARD`, `POPULATOR_CONCAT_BYTE_CAP`, `POPULATOR_PARTIES_PRESENT_MAX`, `POPULATOR_MEMOIZE_TTL_MS` to `mcp/lib/validation.js § CAPS`.
- [ ] Wire `recall.js` per §5.4 (validation reject path, populator invocation, scoringContext rewire, segment-builder time-anchor addition, recall-log block).
- [ ] Extend `recall-log.js` `appendRecallEvent` to record the `populator` block (additive).
- [ ] Update `hooks/recall-on-prompt.sh` to STRIP any inbound `entities` / `time_anchors` / `inferred_mood` from the agent's prompt before forwarding to the MCP (defense-in-depth; the MCP still rejects, but the hook is the first line).
- [ ] Add CI smoke tests for I-CP-1 through I-CP-10 (each invariant gets a dedicated assertion).
- [ ] Add a symmetry-test fixture: a fixed input string + assertions that `extractEntities` returns identical output when invoked through `mcp/lib/recall/context-populator.js` AND through `mcp/lib/ingest/salience.js`'s entity-stamping pass.

---

**End of spec.**
