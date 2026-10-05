# Inheritance

What we take from the upstream design and what we invert. "The upstream design" here means an earlier, unpublished event-ledger system for orchestrating evaluator agents; it is not part of this repository, and the names in the tables below are its file and event names.

## Take

| Pattern | Upstream form | Memory system form |
|---|---|---|
| Event ledger as truth | `frontier-events.jsonl`, `session-events.jsonl` | `memory.jsonl` (mixed-kind ledger), plus per-app source ledgers |
| Projection as recomputable cache | `surface-index.json` derived from frontier events | Recall brief derived from memory ledger + index |
| Bounded briefs at read time | an assignment-brief read tool with strict array/string caps | `recall(context)` returning a capped brief |
| Provenance threaded | `nucleus_hash`, `handoff_token_sha256`, `source_event_id` | `source_refs[]`, `derived_from[]` on every event |
| Mediated writes via MCP | Evaluators have no `Write`; all durable state via MCP tools | Agent has no direct ledger access; policy ops via MCP |
| Multiple narrow ledgers joined at read | coverage / traffic / audit / intel separate; brief joins | per-app source ledgers + memory ledger + recall trace |
| Reversibility through new events | `closure.recorded` with `surface_unblocked: true` | `exclude`, `replace`, `substitute` are events |
| Hooks at agent boundaries | SubagentStart/Stop writes `agent-runs.jsonl` | Distillation hook at conversation end |

## Invert

| Dimension | Upstream design | Memory system |
|---|---|---|
| Consistency model | Strong, locked, signed | Eventual, fuzzy, async |
| State authority | Stored, validated, replayable identically | Projected, context-conditional, can legitimately differ across recalls |
| Lifecycle | Discrete gates (DISCOVER → EVALUATE → VERIFY → GRADE → REPORT) | Continuous decay; no global lifecycle |
| Forgetting | Doesn't exist; everything is replayable forever | First-class, typed, propagating through derivation graph |
| Consumer scope | One orchestrator + N evaluators per wave | One agent per turn; many turns per day |
| Provenance rigor | Cryptographic (signed handoffs) | Metadata only (lightweight) |
| Coverage tracking | Global ("don't re-test surface X") | Per-neighborhood ("don't re-surface memory M in *this* conversation") |

## What changes structurally

The upstream design optimizes for **auditable replay**: any state must be reconstructable, identical, forever. This system optimizes for **useful reconstruction**: each recall is a fresh projection scored against now. The ledger discipline is preserved; the discrete lifecycle and cryptographic rigor are dropped. Soft decay and continuous activation replace hard gates.

The temptation to "just store the current view" is the moment the design stops being recoverable. Resist the materialized view as a source of truth — let it be a cache that is allowed to lie, with the ledger always able to set it right.
