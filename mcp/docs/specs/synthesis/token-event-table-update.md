# Token-event ownership table — synthesis-wave extension

## Mission

`kb/agent-integration.md § Token-event ownership table` (the block delimited by `<!-- BEGIN-CANONICAL(quoted-example): policy_event_kinds_table -->` … `<!-- END-CANONICAL(quoted-example): policy_event_kinds_table -->` at lines 143–152 of the live file) is declared **the closed enumeration; no kind exists outside this list**. Two synthesis-wave work-units — F-SYN-INTEGRATION-CP5-TRIGGER-A-ACTIVATION (the `replay-salience.mjs` recall-feedback projection that materialises CP-5 Trigger A) and F-SYN-SUBSTRATE-RECONSTRUCTION-EMITTER (the shared `emitReconstruction` callable, exercised on both the AGENT path and the DAEMON aggregator path) introduce policy event kinds that are not in that enumeration. Until the kb edit lands, any integration node that ships a producer for one of those kinds is in direct violation of the kb's binding declaration. This spec pins down exactly which rows get added, what the new payload shapes are, how name discipline is extended, how the second two-producer exception is documented, and how the conformance probe re-validates the table — so a single PR can land the kb edit ahead of every downstream integration node and the wave-0 scheduler can release the blocked integration nodes the moment it does.

This is a kb-edit-only spec. The runtime additions (allowed-kinds set in `mcp/lib/policy-events.js`, the prefix-validation rules, the conformance probe) are second-order consequences and are pinned here for the implementer of the kb edit so that the matching code change ships in the same PR.

## kb anchors

Every binding quote below is verbatim from the cited file under `<checkout>/kb/` as of when this spec was written.

- **agent-integration.md § Token-event ownership table (lines 141–152)** —
  > "Every `policy.*` event kind written to `<data root>/policy/policy-events-YYYY-MM.jsonl` has **exactly one producer**. Two producers writing the same kind is a conformance failure. The table below is the closed enumeration; no kind exists outside this list."

  This is the binding closure rule. The spec exists because the synthesis wave introduces kinds that are not enumerated; the edit must restore closure.

- **agent-integration.md § Name discipline (line 154)** —
  > "`policy.token.*` is reserved for token consume/reject events on the user-manual `memory_distill_promote_fact` path. `policy.corroboration` is reserved for the cascade's CORROBORATE outcome. `policy.recall.*` is reserved for recall-time signals from `mcp/lib/recall/`."

  Establishes the prefix-reservation convention. The spec extends it for two new prefixes: `policy.salience.*` and `policy.reconstruction.*`. (Note: `policy.salience.*` already has live entries in `mcp/lib/policy-events.js EVENT_KINDS`, including `policy.salience.dropped`, `policy.salience.redacted`, `policy.salience.stale_post_revoke`, `policy.salience.source_revoked` — these were added in R25/R26 but the kb table at lines 143–152 has fallen out of sync. See § Open questions item (a).)

- **agent-integration.md § Two-producer exception for policy.token.rejected (line 156)** —
  > "This is the single exception to the one-producer-per-kind rule and is permitted because nonce-store corruption is a structural integrity event that the handler cannot observe … Audit-join consumers filter by the `reason` field to disambiguate the two producers."

  The precedent for the second exception this spec introduces. The exception template is "two authorized producers, disambiguated by a payload field." This spec extends it to `policy.reconstruction.emitted`, disambiguated by `provenance.agent_id` prefix (`daemon:*` vs anything else).

- **architecture.md §4 Memory ledger — reconstructed kind** —
  > "reconstructed: content — agent-emitted summarization; derived_from: [ id, ... ]"

  Grounds the existence of the `reconstructed` ledger kind. `policy.reconstruction.emitted` is the audit-log analogue of the ledger-write event: every successful append of a `kind:"reconstructed"` row by `emitReconstruction` raises a policy event so audit consumers can join the appended row to its producer.

- **salience-design.md § Scoring function — R24.5 zero-weighted columns (line 76)** —
  > "the cascade already ships dark columns that wait on the recall feedback signal"

  Grounds the recall-feedback projection. `last_retrieved_ts` and `use_count` ship at R25 with weight=0.0 in `CAPS.SALIENCE_WEIGHTS_V1`; CP-5 Trigger A's `scripts/replay-salience.mjs` populates them by rolling up engagement signals once `recall.jsonl` exists. `policy.salience.recall_feedback` is the per-tick rollup audit event.

## Schemas — additions to the canonical table

### 1. New rows for the canonical-block table

The CANONICAL block at `kb/agent-integration.md` lines 143–152 gains three NEW kinds plus a producer addition to TWO existing kinds. The block-marker comments **MUST be preserved verbatim** (the conformance probe parses them). In the quotation below the markers are shown as `(quoted-example)` so the structural scanner does not read this spec as a second definition — when applying the edit to kb/, write the plain `BEGIN-CANONICAL:` / `END-CANONICAL:` forms. The full post-edit block reads as follows; markdown table columns aligned for readability but byte-identical column widths are not required (the probe is shape-tolerant within the markers).

```
<!-- BEGIN-CANONICAL(quoted-example): policy_event_kinds_table -->
| event-kind                                       | producer                                                                | when                                                                  |
|--------------------------------------------------|-------------------------------------------------------------------------|-----------------------------------------------------------------------|
| `policy.token.consumed`                          | `memory_distill_promote_fact` handler                                   | immediately after `checkAndConsume` (nonce append) succeeds on the MANUAL path |
| `policy.token.consumed`                          | `memory_distill_emit_reconstructed` handler                             | immediately after `checkAndConsume` (nonce append) succeeds on the AGENT path |
| `policy.token.rejected`                          | `memory_distill_promote_fact` handler                                   | on any `verifyToken` / `verifyBinding` / `checkAndConsume` failure on the MANUAL path |
| `policy.token.rejected`                          | `memory_distill_emit_reconstructed` handler                             | on any `verifyToken` / `verifyBinding` / `checkAndConsume` failure on the AGENT path |
| `policy.token.rejected`                          | `mcp/lib/nonce-store.js`                                                | corruption-recovery scenarios only (`reason: "corrupt_tail_truncated"` or `reason: "nonce_store_corrupted"`) |
| `policy.daemon.lock_reclaimed`                   | `watermark.js`                                                          | stale lock reclaimed at startup or per tick                           |
| `policy.corroboration`                           | `watermark.js` (via cascade `promoteSourceRow`)                         | the salience cascade routed a row to CORROBORATE — see `kb/salience-design.md` |
| `policy.recall.transitive_orphan_cap_exceeded`   | `mcp/lib/recall/hard-gates.js`                                          | a transitive-orphan forward-BFS hit `CAPS.TRANSITIVE_ORPHAN_DESCENDANTS_CAP` before exhausting reachable descendants — informational; partial coverage returned, recall completes |
| `policy.salience.recall_feedback`                | `scripts/replay-salience.mjs`                                           | each replay tick that aggregates damping-log engagement signals into a per-target `last_retrieved_ts` + `use_count_delta` projection (CP-5 Trigger A activation) |
| `policy.reconstruction.emitted`                  | `memory_distill_emit_reconstructed` handler                             | immediately after `emitReconstruction` returns `{appended: true}` on the AGENT path |
| `policy.reconstruction.emitted`                  | `daemons/watermark.js` (via aggregator tick `emitReconstruction` call)  | the daemon aggregator (thread / project) successfully appended a `kind:"reconstructed"` row via the shared emitter |
<!-- END-CANONICAL(quoted-example): policy_event_kinds_table -->
```

NOTE: the in-flight gap between the kb table and `mcp/lib/policy-events.js EVENT_KINDS` (the latter already contains `policy.salience.dropped`, `policy.salience.redacted`, `policy.salience.stale_post_revoke`, `policy.salience.source_revoked`) is OUT OF SCOPE for this spec — see § Open questions (a) for the consolidation question. This spec only adds the three NEW kinds and the producer additions that the synthesis wave-0 blocker requires. A separate housekeeping PR can backfill the salience.* drift.

### 2. Payload-shape additions

After the existing payload-shape block at `kb/agent-integration.md` lines 160–166, append three new shape lines. The full post-edit payload block reads:

```
{kind: "policy.token.consumed",                       nonce_hash, tool, accepted_at}
{kind: "policy.token.rejected",                       nonce_hash_or_null, reason, attempted_at}
{kind: "policy.daemon.lock_reclaimed",                prior_pid, prior_mtime, reclaimed_at}
{kind: "policy.corroboration",                        target_memory_id, source_ref:{source, source_msg_id, consent_basis}, ts}
{kind: "policy.recall.transitive_orphan_cap_exceeded", seed_count, visited_count, cap, ledger_mtime, ledger_size, attempted_at}
{kind: "policy.salience.recall_feedback",             target_memory_id, last_retrieved_ts, use_count_delta, replay_tick_id, ts}
{kind: "policy.reconstruction.emitted",               memory_event_id, derived_from, conversation_id_or_null, agent_id, confidence, ts}
```

Field semantics for the new shapes (each line below is a TypeScript-style declaration; the implementer turns the kb prose into a JSON-shaped object on the audit line):

```ts
// kind: "policy.salience.recall_feedback"
type SalienceRecallFeedbackEvent = {
  kind: "policy.salience.recall_feedback";
  target_memory_id: string;            // id of the memory row whose columns are being updated
  last_retrieved_ts: string | null;    // ISO-8601 of the most recent recall that surfaced target_memory_id;
                                        // null if the rollup tick produced no advancement
  use_count_delta: number;             // non-negative integer; increment applied to use_count this tick
  replay_tick_id: string;              // ulid; one id per `scripts/replay-salience.mjs` invocation —
                                        // groups all per-target events written in a single tick
  ts: string;                          // ISO-8601, server-stamped at appendPolicyEvent time
};

// kind: "policy.reconstruction.emitted"
type ReconstructionEmittedEvent = {
  kind: "policy.reconstruction.emitted";
  memory_event_id: string;             // id of the kind:"reconstructed" row that was appended
  derived_from: string[];              // mirrors the ledger row's derived_from (parent ids); MUST be non-empty
  conversation_id_or_null: string | null;
                                        // populated when the reconstruction is tied to a conversation
                                        // (AGENT path); null for daemon-path rollups that span conversations
  agent_id: string;                    // see § Decision rules → "agent_id prefix discipline"
  confidence: number;                  // 0.0–1.0 inclusive; the emitter's confidence in the summarization
  ts: string;                          // ISO-8601, server-stamped at appendPolicyEvent time
};
```

### 3. JSON schema (machine-readable, for the EVENT_KINDS validator)

The `mcp/lib/policy-events.js` validator gains per-kind structural assertions for the new kinds (not just kind-name membership). Implementers wire these into `appendPolicyEvent` immediately after the EVENT_KINDS_SET membership check:

```json
{
  "$id": "policy.salience.recall_feedback",
  "type": "object",
  "additionalProperties": true,
  "required": ["kind", "target_memory_id", "last_retrieved_ts", "use_count_delta", "replay_tick_id", "ts"],
  "properties": {
    "kind": { "const": "policy.salience.recall_feedback" },
    "target_memory_id": { "type": "string", "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$" },
    "last_retrieved_ts": { "oneOf": [{ "type": "string", "format": "date-time" }, { "type": "null" }] },
    "use_count_delta": { "type": "integer", "minimum": 0 },
    "replay_tick_id": { "type": "string", "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$" },
    "ts": { "type": "string", "format": "date-time" }
  }
}
```

```json
{
  "$id": "policy.reconstruction.emitted",
  "type": "object",
  "additionalProperties": true,
  "required": ["kind", "memory_event_id", "derived_from", "conversation_id_or_null", "agent_id", "confidence", "ts"],
  "properties": {
    "kind": { "const": "policy.reconstruction.emitted" },
    "memory_event_id": { "type": "string", "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$" },
    "derived_from": {
      "type": "array",
      "minItems": 1,
      "items": { "type": "string", "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$" }
    },
    "conversation_id_or_null": { "oneOf": [{ "type": "string", "minLength": 1 }, { "type": "null" }] },
    "agent_id": {
      "type": "string",
      "minLength": 1,
      "description": "see § Decision rules → agent_id prefix discipline"
    },
    "confidence": { "type": "number", "minimum": 0.0, "maximum": 1.0 },
    "ts": { "type": "string", "format": "date-time" }
  }
}
```

The ULID regex above is the same one used elsewhere in `mcp/lib/validation.js`. The additionalProperties:true posture matches the existing audit-log discipline: the policy-events stream is informational and consumer-side projections may grow new fields.

### 4. Extension to § Name discipline

The existing § Name discipline paragraph at line 154 is appended to. The post-edit paragraph reads:

> **Name discipline.** `policy.daemon.*` is reserved for **daemon-lifecycle** events (lock, state, process). `policy.token.*` is reserved for token consume/reject events — historically the user-manual `memory_distill_promote_fact` path, extended in synthesis wave-0 to also cover the agent-path `memory_distill_emit_reconstructed` handler (the same token discipline, applied at the agent boundary). `policy.corroboration` is reserved for the cascade's CORROBORATE outcome. `policy.recall.*` is reserved for recall-time signals from `mcp/lib/recall/`. `policy.salience.*` is reserved for salience-layer signals — both the live R25 outcomes (`dropped`, `redacted`, `stale_post_revoke`, `source_revoked`) emitted from `mcp/lib/ingest/salience.js` and `daemons/watermark.js`, AND the recall<->salience feedback projection (`recall_feedback`) emitted from `scripts/replay-salience.mjs` once CP-5 Trigger A activates. `policy.reconstruction.*` is reserved for reconstructed-event lifecycle signals from the shared `emitReconstruction` callers (the agent-path MCP handler and the daemon-path aggregator).

### 5. Extension to § Two-producer exception

The existing § Two-producer exception paragraph at line 156 becomes a two-paragraph block:

> **Two-producer exception for `policy.token.rejected`.** This kind has TWO authorized producers — the `memory_distill_promote_fact` handler for normal verification failures on the user-manual path, and `mcp/lib/nonce-store.js` for corruption-recovery scenarios where the rejection is structural rather than verification-level. Distinguished by the `reason` field: the handler emits `bad_signature` / `bad_binding` / `nonce_replay` / `token_expired` / `unknown_tool`, while nonce-store emits ONLY `corrupt_tail_truncated` (tail-corruption auto-truncated and recovered) or `nonce_store_corrupted` (mid-file corruption — refused). Synthesis wave-0 adds `memory_distill_emit_reconstructed` as a third authorized producer of `policy.token.rejected` on the AGENT path, using the SAME `reason` taxonomy as the user-manual handler. Audit-join consumers filter by `reason` to disambiguate the corruption producer from the verification producers, and filter by the `tool` field on `policy.token.consumed` (or by `provenance.agent_id` prefix on the join with the corresponding ledger write) to disambiguate the user-manual path from the agent path on the verification producers.
>
> **Two-producer exception for `policy.reconstruction.emitted`.** This kind has TWO authorized producers — the `memory_distill_emit_reconstructed` MCP handler on the AGENT path, and `daemons/watermark.js` on the DAEMON aggregator path. Unlike the `policy.token.rejected` exception (which is structurally forced by the recovery layer), this is a deliberate two-caller model: the same `emitReconstruction` callable validates and appends from both paths so the integrity discipline is uniform, but the producer identity matters to audit consumers. Disambiguation rule: **`agent_id` prefix**. The DAEMON path stamps `agent_id` with the prefix `daemon:` (e.g. `daemon:watermark:thread-aggregator`, `daemon:watermark:project-aggregator`). The AGENT path stamps `agent_id` with whatever identity the calling runtime carries (e.g. `claude-code:session-<ulid>`, `codex:thread-<ulid>`) and **MUST NOT** stamp an identifier that begins with `daemon:` — the agent-path emitter rejects (returns `{appended: false, reason: "agent_id_reserved_prefix"}`) any payload whose `agent_id` matches `/^daemon:/`. Audit-join consumers split the producer by the prefix predicate `agent_id.startsWith("daemon:")`.

## Function signatures / Module surface

The kb edit is paired with a runtime-side delta. Each function below names exactly what the implementer changes; signatures are TypeScript-style for clarity but the codebase is JavaScript.

### `mcp/lib/policy-events.js` — `EVENT_KINDS`

```ts
// Add to the frozen list, after the existing kinds. Order is informational
// only (the Set is the membership check); insert sites preserve git diff
// readability by keeping additions at the end of the file.
EVENT_KINDS = [
  ...existingKinds,
  "policy.salience.recall_feedback",
  "policy.reconstruction.emitted",
];
```

### `mcp/lib/policy-events.js` — `validatePerKindShape(event)` (NEW helper)

```ts
// Called from appendPolicyEvent immediately after EVENT_KINDS_SET membership
// passes. Throws Error("appendPolicyEvent: <kind> payload <field> ...") on
// schema mismatch. Per-kind branches; defaults to no-op for kinds that
// pre-date the synthesis wave (back-compat — the existing kinds did NOT
// have structural validation and we are not retrofitting them here; the
// synthesis-wave additions ARE validated).
function validatePerKindShape(event: PolicyEvent): void;
```

Branches the implementer adds (one per new kind):

```ts
switch (event.kind) {
  case "policy.salience.recall_feedback": {
    requireUlid(event.target_memory_id, "target_memory_id");
    requireUlid(event.replay_tick_id, "replay_tick_id");
    requireIso8601OrNull(event.last_retrieved_ts, "last_retrieved_ts");
    requireNonNegativeInteger(event.use_count_delta, "use_count_delta");
    requireIso8601(event.ts, "ts");
    return;
  }
  case "policy.reconstruction.emitted": {
    requireUlid(event.memory_event_id, "memory_event_id");
    requireUlidArrayMin1(event.derived_from, "derived_from");
    requireStringOrNull(event.conversation_id_or_null, "conversation_id_or_null");
    requireString(event.agent_id, "agent_id");
    requireConfidence(event.confidence, "confidence");
    requireIso8601(event.ts, "ts");
    return;
  }
  // existing kinds: no validation (back-compat)
}
```

The four `require*` helpers are private to the file and mirror the existing style of `mcp/lib/validation.js` (throw on first failure with a stable error string).

### `mcp/lib/synthesis/reconstruction.js` — `emitReconstruction(args)` (NEW module, separate spec)

Out of scope for this spec; the substrate spec at `F-SYN-SUBSTRATE-RECONSTRUCTION-EMITTER` owns it. This spec declares only that **after** `emitReconstruction` returns `{appended: true, memory_event_id, derived_from}`, the caller MUST `appendPolicyEvent({kind: "policy.reconstruction.emitted", memory_event_id, derived_from, conversation_id_or_null, agent_id, confidence, ts: serverTs()})`. The audit emit is part of the caller's contract, not part of `emitReconstruction`'s atomic write — a crash between the ledger append and the audit emit is tolerated (the ledger row is the source of truth; the audit log is replay-recoverable via the ledger).

### `scripts/replay-salience.mjs` — `tick()` callable (the recall-feedback projection)

Same scope split: the spec at `F-SYN-INTEGRATION-CP5-TRIGGER-A-ACTIVATION` owns the tick logic; this spec declares only that **after** the tick produces a per-target rollup `{target_memory_id, last_retrieved_ts, use_count_delta}`, the script MUST `appendPolicyEvent({kind: "policy.salience.recall_feedback", target_memory_id, last_retrieved_ts, use_count_delta, replay_tick_id, ts: serverTs()})` once per affected target. `replay_tick_id` is a single ulid generated at the top of the tick — every audit event from a single tick shares it so consumers can group.

### Conformance probe — `scripts/check-policy-event-kinds.mjs` (existing or new)

The probe enumerates `policy.*` kinds observed in `policy/policy-events-YYYY-MM.jsonl` files and joins against the canonical-table-extracted set parsed from `kb/agent-integration.md`. The probe MUST:

```ts
async function checkPolicyEventKinds(): Promise<{
  ok: boolean;
  unenumerated_kinds_in_audit: string[];   // observed in logs, missing from kb table
  unobserved_kinds_in_kb: string[];        // present in kb table, never seen in logs
  table_parse_ok: boolean;                 // BEGIN/END markers found, table parsable
  table_row_count: number;                 // number of rows extracted from the kb table
}>;
```

The probe parses the markdown table inside the BEGIN-CANONICAL/END-CANONICAL markers; markdown row alignment is shape-tolerant (split on `|`, trim, drop empty leading/trailing cells, skip the separator row `|---|---|---|`). Probe failure conditions:
- `table_parse_ok = false` if either marker is missing or the table cannot be parsed → CI fails.
- `unenumerated_kinds_in_audit.length > 0` → CI fails (the closed-enumeration invariant is broken).
- `unobserved_kinds_in_kb.length > 0` is informational, not a CI failure (a kind may legitimately be unseen if the producer hasn't fired yet — e.g. corruption paths).

## Decision rules

Each rule below is a single line of explicit logic plus its edge case.

1. **closed-enumeration rule.** A `policy.*` line written to `policy-events-YYYY-MM.jsonl` MUST have its `kind` field equal one of the rows in the canonical table. Edge: a runtime that tries to write an unknown kind is rejected at `appendPolicyEvent` (the existing EVENT_KINDS_SET check) — the audit log never contains an unenumerated kind. The probe is a safety net that catches drift between the kb table and the EVENT_KINDS_SET.

2. **prefix-reservation rule.** A new `policy.*` kind whose prefix is not currently reserved (§ Name discipline) MUST be added with a name-discipline extension in the same PR. Edge: the synthesis wave adds two new prefixes (`policy.salience.*` and `policy.reconstruction.*`); both get a sentence in the post-edit § Name discipline paragraph.

3. **one-producer-per-kind rule.** Every kind has exactly one producer. Edge: TWO exceptions (post-synthesis):
   - `policy.token.rejected`: three authorized producers (manual handler, agent-path handler, nonce-store), disambiguated by `reason` field for the corruption case and by `tool` / `agent_id` field for the verification case.
   - `policy.reconstruction.emitted`: two authorized producers (handler, daemon), disambiguated by the `agent_id` prefix predicate `startsWith("daemon:")`.

4. **agent_id prefix discipline.** On the AGENT path (`memory_distill_emit_reconstructed` handler), `agent_id` MUST NOT match `/^daemon:/`. On the DAEMON path (`daemons/watermark.js`), `agent_id` MUST start with `daemon:`. Edge: the emitter validates BEFORE appending the ledger row; rejection cause `"agent_id_reserved_prefix"` (agent path) or `"agent_id_missing_daemon_prefix"` (daemon path). The audit emit never fires on a rejected agent_id (no ledger row was appended).

5. **append-then-audit ordering.** The audit emit fires AFTER the ledger append returns success. Crash window between the two is tolerated: replay can re-derive the audit event from the ledger row (`memory_event_id` is the join key). The reverse ordering (audit-then-append) is rejected — it would create audit rows for ledger writes that never happened.

6. **`use_count_delta` accumulation.** The recall-feedback projection emits the **delta** since the last tick for each target, not the absolute use_count. Edge: a target with no engagement signals this tick is NOT emitted (no zero-delta rows clutter the audit log). The downstream salience-column updater accumulates the delta into the memory event's `features.salience.components.use_count` column.

7. **`last_retrieved_ts` monotonic-or-null.** The recall-feedback projection's `last_retrieved_ts` is either null (no recall surfaced this target this tick) or strictly greater than the previously-emitted `last_retrieved_ts` for the same `target_memory_id`. Edge: tick replays of historical recall events MAY emit a `last_retrieved_ts` that is older than the column's current value; the salience-column updater takes `max(current, emitted)`, never overwrites unconditionally.

8. **conformance-probe re-validation gate.** After the kb edit lands, the probe MUST run as part of the kb-edit PR's CI; the PR is unmergeable until the probe reports `ok: true`. Edge: the probe also runs after every integration-node PR that adds a new producer — if that PR omits the kb edit, the probe catches the drift before merge.

9. **canonical-block marker preservation.** The BEGIN-CANONICAL/END-CANONICAL comment lines MUST be preserved character-identical. Edge: an editor that auto-formats HTML comments would break the probe; the kb-edit PR MUST verify the markers survive any markdown-format pass.

10. **two-PR rejection.** The kb edit MUST land as a single PR that ALSO updates `mcp/lib/policy-events.js EVENT_KINDS` and the new `validatePerKindShape` helper. Edge: splitting them creates a window where either the audit log is rejecting valid producer emits (kb landed first) or the audit log is accepting unenumerated kinds (code landed first); both are conformance violations. The wave-0 scheduler enforces this by treating the kb edit and the code edit as a single atomic node.

## Examples

### Example 1 — `policy.salience.recall_feedback` from a normal replay tick

`scripts/replay-salience.mjs` runs at `2026-06-20T03:15:02Z`, observes 4 candidate memory rows that were surfaced in recall events during the prior tick window, and rolls up engagement. The tick id is the ulid `01J9F0R6C8M5H7K2NQYV3WAEXC`. For each affected target the script calls:

```js
appendPolicyEvent({
  kind: "policy.salience.recall_feedback",
  target_memory_id: "01J9F0R5C8M5H7K2NQYV3WAEXB",
  last_retrieved_ts: "2026-06-20T03:14:58.331Z",
  use_count_delta: 2,
  replay_tick_id: "01J9F0R6C8M5H7K2NQYV3WAEXC",
  ts: "2026-06-20T03:15:02.405Z"
});
```

The stored audit line (post-checksum):

```json
{"kind":"policy.salience.recall_feedback","target_memory_id":"01J9F0R5C8M5H7K2NQYV3WAEXB","last_retrieved_ts":"2026-06-20T03:14:58.331Z","use_count_delta":2,"replay_tick_id":"01J9F0R6C8M5H7K2NQYV3WAEXC","ts":"2026-06-20T03:15:02.405Z","checksum":"a3f7c2…"}
```

The fourth row in the same tick has zero engagement signals and is **not** emitted (per decision rule 6). Three audit lines land for this tick, sharing the same `replay_tick_id`.

### Example 2 — `policy.reconstruction.emitted` from the AGENT path

The user, mid-conversation in Claude Code, asks the assistant to "summarise this whole thread for me to paste into a note." The assistant calls `memory_distill_emit_reconstructed` with the conversation's accumulated message ids. The handler:
1. Verifies the agent token (`checkAndConsume` succeeds) → emits `policy.token.consumed` with `tool: "memory_distill_emit_reconstructed", nonce_hash: "...", accepted_at: "..."`.
2. Calls `emitReconstruction({content, derived_from, agent_id, confidence})`. `agent_id` is `"claude-code:session-01J9F0R7P3M8M9K5NQYV3WAEX1"`. The validator confirms the id does NOT start with `daemon:`. The ledger row is appended at `id: "01J9F0R7P3M8M9K5NQYV3WAEX2"`.
3. After `emitReconstruction` returns `{appended: true, memory_event_id: "01J9F0R7P3M8M9K5NQYV3WAEX2", derived_from: [...]}`, the handler calls:

```js
appendPolicyEvent({
  kind: "policy.reconstruction.emitted",
  memory_event_id: "01J9F0R7P3M8M9K5NQYV3WAEX2",
  derived_from: [
    "01J9F0R6C8M5H7K2NQYV3WAEX0",
    "01J9F0R6C8M5H7K2NQYV3WAEX1",
    "01J9F0R6C8M5H7K2NQYV3WAEX2"
  ],
  conversation_id_or_null: "conv-2026-06-20-claude-code-A1B2",
  agent_id: "claude-code:session-01J9F0R7P3M8M9K5NQYV3WAEX1",
  confidence: 0.82,
  ts: "2026-06-20T03:17:11.024Z"
});
```

The stored audit line carries the `agent_id` field with no `daemon:` prefix; an audit consumer filtering by `agent_id.startsWith("daemon:")` excludes this line and assigns it to the AGENT producer.

### Example 3 — `policy.reconstruction.emitted` from the DAEMON path

A thread aggregator inside `daemons/watermark.js` rolls up a long conversation into a single `kind:"reconstructed"` row. The daemon calls `emitReconstruction` with `agent_id: "daemon:watermark:thread-aggregator"` and `conversation_id_or_null: null` (the rollup spans multiple conversation_ids; the aggregator did not select a single one to attribute). The emitter validates `agent_id.startsWith("daemon:")` is true (per decision rule 4), appends the ledger row, returns `{appended: true, memory_event_id: "01J9F0R8YZ4N0L8K2NQYV3WAEX9", derived_from: [...]}`. The daemon then calls:

```js
appendPolicyEvent({
  kind: "policy.reconstruction.emitted",
  memory_event_id: "01J9F0R8YZ4N0L8K2NQYV3WAEX9",
  derived_from: [
    "01J9F0R7P3M8M9K5NQYV3WAEX2",
    "01J9F0R7P3M8M9K5NQYV3WAEX3"
  ],
  conversation_id_or_null: null,
  agent_id: "daemon:watermark:thread-aggregator",
  confidence: 0.74,
  ts: "2026-06-20T03:30:00.121Z"
});
```

An audit consumer doing the producer split:

```js
function producerOf(event) {
  if (event.kind !== "policy.reconstruction.emitted") return null;
  return event.agent_id.startsWith("daemon:") ? "daemon" : "agent";
}
```

assigns this line to the DAEMON producer.

### Example 4 — Conformance-probe failure (negative example)

A hypothetical integration PR adds a producer for `policy.reconstruction.emitted` but omits the kb edit. CI runs the probe:

```
$ node scripts/check-policy-event-kinds.mjs
table_parse_ok: true
table_row_count: 6     # the live pre-edit table has 6 rows
unenumerated_kinds_in_audit: ["policy.reconstruction.emitted"]
unobserved_kinds_in_kb: []
ok: false

[FAIL] kb/agent-integration.md § Token-event ownership table is missing 1 kind observed in audit:
  - policy.reconstruction.emitted
The kb table is declared "the closed enumeration; no kind exists outside this list."
Edit kb/agent-integration.md inside the BEGIN-CANONICAL/END-CANONICAL markers and re-run.
```

The PR is unmergeable. The author rebases the kb-edit branch in and re-runs the probe; it now reports `ok: true` and the PR can land.

### Example 5 — Agent path attempts a reserved prefix (rejection)

A misconfigured runtime tries to emit a reconstructed row with `agent_id: "daemon:fake"`. The agent-path handler calls `emitReconstruction({..., agent_id: "daemon:fake"})`. The validator (per decision rule 4) returns `{appended: false, reason: "agent_id_reserved_prefix"}`. No ledger row is appended; consequently, **no `policy.reconstruction.emitted` audit event is emitted** (per decision rule 5: append-then-audit). The handler emits `policy.token.rejected` with `reason: "agent_id_reserved_prefix"` (extending the existing reason taxonomy on the agent path — see § Two-producer exception's extended paragraph).

## Invariants

1. **Closed-enumeration invariant.** ∀ `e ∈ policy-events-YYYY-MM.jsonl` : `e.kind ∈ KindsExtractedFromCanonicalTable(kb/agent-integration.md)`.

2. **Block-marker invariant.** The substrings `<!-- BEGIN-CANONICAL(quoted-example): policy_event_kinds_table -->` and `<!-- END-CANONICAL(quoted-example): policy_event_kinds_table -->` appear exactly once each in `kb/agent-integration.md`, in that order, with the markdown table strictly between them.

3. **EVENT_KINDS_SET / kb-table parity.** `Set(EVENT_KINDS in mcp/lib/policy-events.js) === KindsExtractedFromCanonicalTable(kb/agent-integration.md)`. The probe checks both directions.

4. **One-producer-per-kind invariant, with declared exceptions.** Every kind except `policy.token.rejected` and `policy.reconstruction.emitted` has exactly one producer. The two exceptions are documented in § Two-producer exception with explicit disambiguation rules.

5. **`policy.reconstruction.emitted` producer-split invariant.** For every line `e` of kind `policy.reconstruction.emitted`:
   - `e.agent_id` is present and non-empty.
   - Either `e.agent_id.startsWith("daemon:")` (DAEMON producer) or NOT (AGENT producer); the partition is total.

6. **`policy.reconstruction.emitted` ↔ ledger-row invariant.** For every line `e` of kind `policy.reconstruction.emitted`, there exists exactly one row `r` in `ledgers/memory.jsonl` with `r.id === e.memory_event_id` and `r.kind === "reconstructed"` and `r.derived_from === e.derived_from`. Crash between append and audit is tolerated (the audit may be missing), but an audit event whose `memory_event_id` does not resolve to a ledger row is a conformance failure.

7. **`use_count_delta` non-negativity.** `e.use_count_delta >= 0` for every `policy.salience.recall_feedback` line. Negative deltas would indicate decay; decay is column-side logic, not audit-event content.

8. **`replay_tick_id` cohesion.** All `policy.salience.recall_feedback` events emitted from a single `replay-salience.mjs` tick share the same `replay_tick_id`. The replay script generates the ulid once at the top of the tick.

9. **Append-then-audit ordering invariant.** Every `policy.reconstruction.emitted` line is written strictly after the corresponding ledger row's `fsync` returned; every `policy.salience.recall_feedback` line is written strictly after the corresponding salience-column update's `fsync` returned.

10. **Probe idempotence.** Running `scripts/check-policy-event-kinds.mjs` twice in succession on an unchanged kb file and audit log returns identical output. Edge: rotation at month boundary changes the set of files but not the union of observed kinds.

## Open questions

(a) **Backfill of the live R25/R26 salience.* kinds.** The kb table at lines 143–152 of the live file is missing four kinds that `mcp/lib/policy-events.js EVENT_KINDS` already enumerates: `policy.salience.dropped`, `policy.salience.redacted`, `policy.salience.stale_post_revoke`, `policy.salience.source_revoked`. The probe would catch this drift if it ran today. Question: does this spec's PR also backfill those four rows into the canonical table (one big consolidation PR) or does that drift get a separate housekeeping PR? Recommendation: **consolidate** — the probe is only useful once parity holds, and shipping the synthesis kinds into a table that is already out of parity creates two distinct drift sources. Defer the call to the kb-edit reviewer; flagged here so it isn't missed.

(b) **`policy.salience.*` namespace collision.** The kb's existing § Name discipline reserves `policy.recall.*` for recall-time signals from `mcp/lib/recall/`. The new kind `policy.salience.recall_feedback` is in `policy.salience.*` rather than `policy.recall.*` — it is a salience-side rollup OF recall signals, not a recall-side signal. The choice is defensible (producer is `scripts/replay-salience.mjs`, owned by the salience layer) but the naming may confuse audit consumers. Question: keep `policy.salience.recall_feedback` or rename to `policy.salience.recall_engagement_rollup`? Recommendation: keep — `recall_feedback` is the precise term the salience-design doc uses (R24.5 graft) and the `replay_tick_id` field makes the rollup nature obvious.

(c) **Cross-link refresh.** Line 141 declares the table "cross-linked from `mcp-surface.md`, `build-plan.md`, `architecture.md`." The kb edit MAY also need a re-pointer in those docs if they quote the table by row count or row text. Question: does the kb-edit PR also sweep those three docs? Recommendation: do a textual grep for the existing kind names in those files; if any of the three quotes the table, update in the same PR. If not, leave them alone — the cross-link is a "consult this doc" pointer, not a copy.

(d) **`feature_version` bump on the probe.** The probe is structural over the markdown table, not the schema, so it should not need a feature_version bump when the table grows. But if a downstream consumer pins to a specific table-row-count or a specific kinds-set, that consumer breaks silently on the edit. Question: should the EVENT_KINDS Object.freeze block carry a sentinel comment with a monotonically-increasing revision number that downstream consumers can check? Recommendation: no — the EVENT_KINDS_SET is the structural contract; consumers that pin to a specific set are over-coupled and should be loosened.

(e) **Phase-0 vs Phase-1 sequencing.** The synthesis wave includes both `policy.salience.recall_feedback` (depends on `recall.jsonl` populating) and `policy.reconstruction.emitted` (depends on `memory_distill_emit_reconstructed` shipping). If `recall.jsonl` doesn't populate until after the kb edit, the recall_feedback kind will be in the canonical table but have no producer. The probe's `unobserved_kinds_in_kb` field catches this (informational, not failing). Question: ship the kb row pre-emptively and accept the unobserved gap, or gate the row on producer activation? Recommendation: pre-emptively — wave-0 prerequisite means the table is shipped FIRST so wave-1 producers don't break the closed-enumeration invariant when they wake up.

(f) **`agent_id` schema drift.** The agent-path `agent_id` shape is currently undeclared (the AGENT-path handler is in a sibling spec). If the runtime-identifier shape later changes (e.g. `claude-code:session-<ulid>` → `claude-code/<ulid>`), the prefix-discipline rule still works (the daemon prefix is `daemon:` and no claude-code id begins with that), but a downstream consumer pinning on the existing format breaks. Recommendation: declare in the AGENT-path handler spec that `agent_id` follows `^[a-z][a-z0-9-]*:[A-Za-z0-9_.\-:]+$` (lowercased runtime tag, colon, then runtime-specific suffix) and that `^daemon:.*$` is reserved for daemons.

## Cross-tier impact

This node is a wave-0 blocker for the following synthesis nodes (as enumerated in the source node's `blocks` field):

- **F-SYN-INTEGRATION-CP5-TRIGGER-A-ACTIVATION** — produces `policy.salience.recall_feedback` via `scripts/replay-salience.mjs`. Cannot ship until this spec lands the canonical-table row and the `validatePerKindShape` branch. After this spec lands, that node's contract is unblocked: it owns the rollup logic and the `replay_tick_id` ulid generation, but the audit-emit shape is pinned here.

- **F-SYN-SUBSTRATE-RECONSTRUCTION-EMITTER** — defines `emitReconstruction(args) → {appended, memory_event_id, derived_from}` and the agent_id-prefix validation. Cannot ship until this spec lands the canonical-table rows for `policy.reconstruction.emitted` (both producer entries) and the two-producer exception extension. After this spec lands, that node owns the emitter logic, the prefix rejection (`agent_id_reserved_prefix` / `agent_id_missing_daemon_prefix`), and the ledger-write atomicity; the audit-emit shape is pinned here.

- **F-SYN-INTEGRATION-RECONSTRUCTED-MCP-TOOL** — defines the `memory_distill_emit_reconstructed` MCP tool, which is an additional producer of the existing `policy.token.consumed` and `policy.token.rejected` kinds. Cannot ship until this spec lands the producer additions in the canonical table and the corresponding extensions to § Name discipline and § Two-producer exception. After this spec lands, that node owns the MCP-tool surface (registration, handler binding, JSON-schema for the tool input), the `checkAndConsume` integration on the agent path, and the `agent_id` extraction from the agent token.

Downstream non-blocker impact:

- **`mcp/lib/recall/log.js`** (or wherever `appendRecallEvent` lives) — gains a sibling consumer (the replay script reads its output); no shape change. The recall-event shape is owned by the phase3-v0-contracts spec; this spec does not touch it.

- **`memory_health` observability MCP tool** — already reports `policy_events_active_file` and `policy_events_disk_bytes`. After this spec lands, `memory_health` MAY add an optional projection `policy_event_kind_counts: Record<kind, count>` derived from the rotated files. Out of scope here; flagged as a Phase-1 observability follow-up.

- **`scripts/check-policy-event-kinds.mjs`** — this spec defines the probe's contract. The implementer may have to author the script in the same PR if it does not yet exist (likely; the kb-table parity check has not been automated to date).

- **`kb/legacy-archive.md`** — no impact. The retired Phase-1 event-family catalogued there (see kb/legacy-archive.md § R32 for the exact identifiers; the names are intentionally not reproduced here per kb/deprecation-discipline.md scope rules) is explicitly outside the closed enumeration; this spec does not resurrect any member of that family.

- **Cross-linked docs (`mcp-surface.md`, `build-plan.md`, `architecture.md`)** — per § Open questions (c), may need a textual sweep for any pinned row count or kind-name list.

After this spec lands, the closed-enumeration invariant is restored across the kb and the runtime, the conformance probe can run as a CI gate, and the three blocked synthesis nodes (CP5-Trigger-A, Reconstruction-Emitter, Reconstructed-MCP-Tool) are released to ship in wave 1.
