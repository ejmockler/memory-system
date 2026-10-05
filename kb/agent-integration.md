# Agent integration

How agent runtimes connect to the memory system. The boundary rule from `architecture.md` § Interface boundaries: MCP is universal; the hook story varies; per-source cursors are the safety net.

## The universal surface

One local process — call it `memory` — fronts everything via MCP:

- `recall(surrounding_context) → brief`
- `exclude`, `replace`, `substitute`, `excise`
- Control plane: list / pause connectors, inspect / approve quarantine

This is the design surface. What is registered today is listed in `mcp-surface.md` § Current status: of the verbs above, `memory_recall`, `memory_exclude` (scoped), `memory_rescind_policy`, `memory_connectors_list` and `memory_connectors_revoke` exist; `replace`, `substitute`, `excise`, pause and quarantine are planned, not implemented.

Every agent runtime calls this. Memory belongs to the user, not the runtime — Claude Code today, Codex tomorrow, a custom Python script next month all hit the same surface.

## How the agent gets context

Three patterns, ordered by unobtrusiveness:

1. **Agent-decides** — tool description says "call this to recall relevant context." Brittle; depends on the agent remembering to remember. Bad fit for life context, where the whole value is ambient.
2. **Hook-injects** — runtime hook (`UserPromptSubmit` on Claude Code, equivalent elsewhere) calls `recall` per turn and emits the brief as a system reminder. Agent never has to know memory exists; context just appears. This is the design's preferred pattern, but no recall-injecting hook ships in this repository; `hooks/registration-recommendation.md` lists the hooks that do.
3. **Explicit invocation** — `/recall`, status-line indicator, slash command. Useful for opt-in queries and debugging, not the daily path.

The KB principle "agents cannot write durably" extends naturally: agents also should not have to ask to remember. Put memory on the conversational substrate, not the agent's decision surface.

## Per-runtime integration

| Runtime | MCP | Hooks | Integration shape |
|---|---|---|---|
| Claude Code | Yes | Full (`UserPromptSubmit`, `Stop`, `SessionEnd`) | Hooks inject brief; MCP tools registered for policy ops; chat ledger via Stop hook |
| Codex CLI | Yes | Full (`SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`) registered at `~/.codex/hooks.json` | Three-hook recipe parallel to Claude Code; Stop payload carries only `last_assistant_message`, so a `turn_id`-keyed stitch cache (`CODEX_TURN_STITCH_TTL_SECONDS=300`) joins UserPromptSubmit's prompt before the chat ledger append. See `kb/connectors-survey.md § chat-codex` for the connector skeleton. |
| VS Code Claude extension | Extension-dependent | None public as of 2026-06-02 | Defer until the extension exposes hooks or `vscode.LanguageModelChat` path |
| Web claude.ai | None | None | Out of scope. A hosted bridge would invert the local-first commitment — same regression class as hosted MCPs. Behavioral solution is to move sessions to Claude Code / Codex. |

The Codex CLI row (design history in `kb/build-plan.md` and `kb/connectors-survey.md § Recommended sequence`) is pure `first_party`, no auth, no TCC, no cursor — the same three-hook recipe as `chat-claude-code.jsonl`. The legacy "wrapper or cron" guidance previously documented for Codex is superseded by the hook entries above.

The `imessage`, `screentime`, `git-log`, and `github-events` connector daemons compose with `ConnectorBase` (next subsection) and have hermetic synthetic-fixture tests. Their launchd service files are rendered from the templates in `launchd/` and are **not loaded automatically**. iMessage and Screen Time need a one-time **Full Disk Access** grant for the `node` binary the services run (`System Settings → Privacy & Security → Full Disk Access`); `git-log` and `github-events` need none. Enabling, disabling and troubleshooting each connector is in `docs/CONNECTORS.md`; to hide what a connector already ingested, call the `memory_connectors_revoke` MCP tool.

### Connectors — the shared base abstraction

The `imessage`, `screentime-knowledgec`, `git-log-local`, and `github-events` connectors are built on a single shared module at `mcp/lib/connectors/index.js`. Each impl daemon composes with `ConnectorBase` rather than re-deriving auth handling, cursor persistence, idempotent append, source_policy stamping, or health reporting. The contract from `kb/ingestion.md § Connector contract` is the spec; this section enumerates the concrete surface the daemons target.

**Module surface (`mcp/lib/connectors/index.js`):**

- `class ConnectorBase({source, sourceLedgerPath?, cursorPath?, sourcePolicyForRow, errorThreshold?, dedupTailLines?})`
  - `readCursor() → Promise<state | null>` — read `connectors/<source>/state.json`. Returns `null` if absent or corrupt; the daemon rebuilds from the source-of-truth (`kb/ingestion.md § Failure modes → "Cursor drift"`).
  - `writeCursor(state) → Promise<void>` — atomic tmp-write + fsync + rename + dir-fsync at mode `0600`. Power-cut at any point leaves either the prior state.json or the new state.json — never a half-written file.
  - `appendLedgerRow(row) → Promise<{appended: boolean, source_msg_id, id?}>` — bounded tail-read (`CAPS.CONNECTOR_DEDUP_TAIL_LINES`) dedupe on `row.source_msg_id`; stamps `id`/`ts`/`source`/`source_policy`/`checksum`; appends to `storage/sources/<source>.jsonl` with O_APPEND fsync + dir-fsync.
  - `reportHealth() → {source, last_appended_ts, last_cursor_advance_ts, error_rate, status}` — synchronous view of the cursor; status taxonomy: `ok | degraded | stale | failed`.
  - `tagError(kind) → Promise<void>` — increments `error_count` + records `last_error_kind`; crossing `CAPS.CONNECTOR_ERROR_THRESHOLD` trips `status="degraded"` on the next reportHealth.
- `listInstalledConnectors() → [{source, status, last_appended_ts, last_cursor_advance_ts}, ...]` — enumerates `connectors/<source>/` dirs that contain a `state.json`. Backs the `memory_connectors_list` MCP tool. Sub-directories without a state file are ignored.
- `applyConnectorRevoke({source, opts?}) → Promise<row>` — appends a `kind:"policy"` `policy_kind:"connector_revoke"` row to `ledgers/memory.jsonl` with `target_source: source` and `ts: serverTs()`. This is the AUTHORITATIVE kill-switch marker the recall layer's transitive-orphan BFS reads (`mcp/lib/recall/hard-gates.js`). NOT a `policy-events-YYYY-MM.jsonl` audit event; the marker lives on the memory ledger because the recall layer already reads memory.jsonl at every request.

**What the impl daemon owns (NOT ConnectorBase):**

- The `sourcePolicyForRow(row) → {deletion_semantics, consent_basis}` classifier closure. Each connector's edges (authorship-trumps-audience for iMessage outbound; iMessage business-account prefix `BIZ:`; tapback `kind:"reaction"`; etc.) live in the daemon, not the base class. The base never inspects the classifier's logic — it just calls the closure and stamps the result.
- Auth + credential handling. Each daemon owns `policy/<source>-{session|token}.json` at `0600` (or no credential for read-only macOS Library tails). Full Disk Access grants for `imessage` + `screentime-knowledgec` are made by the user (`docs/CONNECTORS.md`).
- Edit/delete-as-event emission. The base class never mutates prior rows; the daemon emits a NEW row with `kind:"reconstructed"` and `derived_from: [original_source_msg_id]` via the normal `appendLedgerRow` path.
- The source-native cursor field (`message.ROWID` for iMessage; commit SHA for git-log; ETag for github-events). Any extra keys the daemon stores on the cursor are passed through verbatim by `readCursor` / `writeCursor`.

**CAPS the base reads** (single source of truth: `mcp/lib/validation.js § CAPS`):

- `CONNECTOR_DEDUP_TAIL_LINES = 256` — tail-read window for `source_msg_id` dedup.
- `CONNECTOR_ERROR_THRESHOLD = 5` — `error_count >= threshold` trips `status="degraded"`.
- `CONNECTOR_HEALTH_STALE_SECONDS = 3600` — `last_cursor_advance_ts` older than this trips `status="stale"` (even with zero errors).

These four daemons target this surface. Later connectors should compose the same base rather than rolling their own append/cursor/health discipline.

## Claude Code (concrete)

| Concern | Mechanism |
|---|---|
| Recall injection | Design: a `UserPromptSubmit` hook → calls memory MCP → emits brief as a system reminder via stdout. Not shipped; the agent calls `memory_recall` itself. |
| Policy ops | MCP tools `memory_exclude` and `memory_rescind_policy` (`replace`, `substitute`, `excise` are planned) — agent calls them when the user expresses a forgetting intent |
| Source-row capture | `Stop` hook (per-turn append via `stop-hook.sh`); `SessionEnd` (final flush via `session-end-hook.sh`). The watermark daemon then runs the row-by-row salience cascade (`tickSourcesOnce`) over the captured rows. See § Hook bridge. |
| Chat capture | `stop-hook.sh` → appends turn to `storage/sources/chat-claude-code.jsonl` with `conversation_id`, `agent_role`, `ts`; deterministic `source_msg_id` for idempotency |
| Configuration | `~/.claude/settings.json` registers hooks at the user level (matcher `"*"`, project scope explicitly disallowed; see `hooks/registration-recommendation.md`); the memory MCP server is registered at user scope with `claude mcp add` (see `kb/mcp-registration-state.md`) |

Stack layout:

```
<checkout>/mcp/server.js              # the MCP server
<checkout>/hooks/recall-engagement-detect.sh  # UserPromptSubmit; records prompts for recall-engagement tracking
<checkout>/hooks/stop-hook.sh              # Stop; appends one row to chat-claude-code.jsonl
<checkout>/hooks/session-end-hook.sh       # SessionEnd; final flush of the same path
<checkout>/daemons/watermark.js       # runs tickSourcesOnce over all source ledgers
```

`<checkout>` is the directory the repository was cloned into; write it as an absolute path wherever a hook is registered. Hook state (`.tmp/`, `hook-errors.jsonl`) lives in `<MEMORY_ROOT>/hooks/`, and `MEMORY_ROOT` defaults to the checkout.

(Earlier placeholder names `log-chat.sh` and `distill.sh` were superseded by the canonical `stop-hook.sh` and `session-end-hook.sh`.)

## Watermark daemon as the live promote path

The watermark daemon (`<checkout>/daemons/watermark.js`) runs the row-by-row salience cascade over every `storage/sources/<src>.jsonl`. Each tick (`tickSourcesOnce`) reads from the per-source cursor forward, judges each new row through Stage-0 dispatch -> Stage-1 score -> Stage-2 embed+kNN, and routes to CORROBORATE / PROMOTE / EMBED_DEFERRED / DROP. PROMOTE calls `promoteSourceRow` directly; no batch file, no token-mint at trigger time, no separate supervisor process. Full design in `kb/salience-design.md`.

This means hook `Stop` is sufficient on its own: the hook writes one row to `chat-claude-code.jsonl`, and the next watermark tick (≤1s later) sees the row and judges it through the cascade. There is no separate idle-timer waiting for conversational silence — that earlier model is retired (`kb/legacy-archive.md`).

A runtime might never fire `Stop` (crash, stateless API call, laptop closed). The cascade's defense-in-depth is the same as the connector daemons' — every source ledger has a per-source cursor that survives restart; on next boot the daemon resumes at the cursor and catches up. Two-signal discipline (hook + cascade resume) survives even if the hook never fires for that turn.

## Watermark daemon

Process: `<checkout>/daemons/watermark.js`. Long-lived, single instance per machine, supervised by launchd / systemd (matches the connector daemon supervision pattern in `ingestion.md`). It is the live promote path: each tick walks every per-source ledger past the per-source cursor and runs the row-by-row salience cascade in-process (`kb/salience-design.md`).

**Responsibilities, in order (`tickSourcesOnce`).**

1. Enumerate every `<data root>/storage/sources/<src>.jsonl` file. New files appearing mid-run are picked up on the next tick; per-file readers attach lazily.
2. Per source, read from the cursor's `last_offset` forward to the tick-time EOF snapshot.
3. For each new row, run the cascade (Stage-0 dispatch -> Stage-1 score -> Stage-2 embed+kNN). Route to CORROBORATE / PROMOTE / EMBED_DEFERRED / DROP per `kb/salience-design.md`.
4. On PROMOTE, call `promoteSourceRow` directly (in-process). On CORROBORATE, emit a `policy.corroboration` row. On DROP, advance the cursor without ledger writes. On EMBED_DEFERRED, leave the cursor at the deferred row so the next tick retries.
5. Persist the per-source cursor atomically after each tick.

**What the daemon does NOT do.** It does not enqueue batches, does not write queue files, does not spawn an MCP child for promote, does not mint daemon-signed tokens. The earlier conversational pipeline (a separate supervisor process that did mint tokens at trigger time and called `memory_distill_promote_fact` through an MCP child) is retired; see `kb/legacy-archive.md`. `memory_distill_promote_fact` remains as a manual MCP surface; the cascade does not use it.

**Per-source watermark state.** One cursor file per source at `<data root>/storage/watermark-state/<src>.json` (`watermarkSourceCursorPath` in `mcp/lib/config.js`), atomically replaced after each tick (write-tmp-then-rename, fsync the tmp before rename, fsync the directory after rename — same discipline as the source ledger in `ingestion.md § Failure modes`). Each file holds `{version, source, last_offset, last_appended_ts, last_event_id, error_count, muted_until, updated_at}`; `last_offset` is a decimal string so offsets above 2^53 survive JSON (`readSourceCursor` / `writeSourceCursorAtomic` in `daemons/watermark.js`).

The hash-pinned block below is the earlier single-file design (`policy/watermark-state.json` with a `sources` map). It is kept verbatim because tests pin it; the per-source files above replaced it, and `last_processed_offset` in it corresponds to `last_offset`:

<!-- BEGIN-CANONICAL: watermark_state_schema_v1 -->
```
{
  "version": 1,
  "updated_at": "<ISO-8601>",
  "sources": {
    "<src>": {
      "source_ledger_path": "<absolute path to storage/sources/<src>.jsonl>",
      "last_processed_offset": <int byte offset; LOWER BOUND resume cursor>,
      "last_processed_id": "<source_msg_id> | null",
      "last_processed_ts": "<ISO-8601> | null"
    }
  }
}
```
<!-- END-CANONICAL: watermark_state_schema_v1 -->

`last_processed_offset` is the **per-source byte offset at which the next tick resumes** — a lower-bound resume cursor, not an EOF snapshot. Each tick reads `[cursor.last_processed_offset, snapSize)`; the cursor advances row-by-row as the cascade dispatches each row to its outcome. On a EMBED_DEFERRED outcome the cursor parks at the deferred row (so the next tick retries embedding). The legacy per-conversation conversation_key state shape (`conversations:{<runtime>:<conversation_id>}` + `in_flight[]`) was retired with the conversational pipeline; see `kb/legacy-archive.md`. <!-- spec-sweep:allow -->

**Daemon lock.** `<data root>/policy/distillation-state.lock` (a legacy name kept for compatibility; `distillationStateLockPath` in `mcp/lib/config.js`) — a sidecar lock file acquired on daemon startup per § acquireExclusiveLockFile in `architecture.md`, released on shutdown, and heartbeated by rewriting the lock body, which refreshes its mtime. Stale-lock recovery (per the discipline in `mcp-surface.md § Consumed-nonce store`): a lock file with a non-live owner PID and an mtime older than `STALE_LOCK_RECOVERY_SECONDS` (60s) is reclaimed; the reclamation is logged as `policy.daemon.lock_reclaimed`.

**Failure modes.**

- **Source ledger grows mid-tick.** The tick-time `snapSize` EOF read upper-bounds the scan; the cursor advances row by row. Next tick picks up exactly where this one stopped.
- **Cursor file corrupt or missing.** If a source's cursor file is absent, fails JSON-parse, or has the wrong `version` or `source`, `readSourceCursor` returns null and the daemon starts that source from a fresh cursor at offset 0, letting the cascade catch up row-by-row. **Rebuild MUST NOT seed the cursor to current EOF** — that would mark every pre-existing row as already-judged and the cascade would never see them. The first tick after rebuild walks every unprocessed row through the cascade. Slow but correct. <!-- spec-sweep:allow -->
- **Daemon dies mid-tick.** Cursor advancement is gated on the per-row promote/corroborate/embed/drop write succeeding: the cursor is persisted ONLY after the cascade's outcome write hits disk. Crash between row-judgement and cursor-persist is recoverable — restart resumes at the prior persisted cursor, the cascade re-judges the row (dedupe on `source_msg_id` at promote time prevents double-write).

**Token-event ownership table (AUTHORITATIVE — single source of truth, cross-linked from `mcp-surface.md`, `build-plan.md`, `architecture.md`).** Every `policy.*` event kind written to `<data root>/policy/policy-events-YYYY-MM.jsonl` has **exactly one producer**. Two producers writing the same kind is a conformance failure. The table below is the closed enumeration; no kind exists outside this list. (The conversational pipeline's event kinds were retired with it; the retired kinds are catalogued in `kb/legacy-archive.md`.)

<!-- BEGIN-CANONICAL: policy_event_kinds_table -->
| event-kind                                       | producer                                  | when                                                                  |
|--------------------------------------------------|-------------------------------------------|-----------------------------------------------------------------------|
| `policy.token.consumed`                          | `memory_distill_promote_fact` handler     | immediately after `checkAndConsume` (nonce append) succeeds           |
| `policy.token.rejected`                          | `memory_distill_promote_fact` handler     | on any `verifyToken` / `verifyBinding` / `checkAndConsume` failure (normal verification path) |
| `policy.token.rejected`                          | `mcp/lib/nonce-store.js`                  | corruption-recovery scenarios only (`reason: "corrupt_tail_truncated"` or `reason: "nonce_store_corrupted"`) |
| `policy.daemon.lock_reclaimed`                   | `watermark.js`                            | stale lock reclaimed at startup or per tick                           |
| `policy.corroboration`                           | `watermark.js` (via cascade `promoteSourceRow`) | the salience cascade routed a row to CORROBORATE — see `kb/salience-design.md` |
| `policy.recall.transitive_orphan_cap_exceeded`   | `mcp/lib/recall/hard-gates.js`            | a transitive-orphan forward-BFS hit `CAPS.TRANSITIVE_ORPHAN_DESCENDANTS_CAP` before exhausting reachable descendants — informational; partial coverage returned, recall completes (review-17, see § Transitive derivation-orphan propagation at recall time) |
| `policy.salience.recall_feedback`                | `mcp/lib/synthesis/recall-feedback-emitter.js` (`emitRecallFeedback`) | each recall surface, fire-and-forget from `mcp/lib/tools/recall.js`: one batched row encodes `surfaced_memory_ids[]` + `surface_position_by_id{}` + `scoring_weights{}` + `propensities_by_id{}` for the recall (CP-5 Trigger A wiring; single-producer invariant enforced by `mcp/test/synthesis/single-producer-recall-feedback.test.mjs`) |
<!-- END-CANONICAL: policy_event_kinds_table -->

**Name discipline.** `policy.daemon.*` is reserved for **daemon-lifecycle** events (lock, state, process). `policy.token.*` is reserved for token consume/reject events on the manual `memory_distill_promote_fact` path. `policy.corroboration` is reserved for the cascade's CORROBORATE outcome. `policy.recall.*` is reserved for recall-time signals from `mcp/lib/recall/`. `policy.salience.*` is reserved for salience-layer signals — both the live outcomes (`dropped`, `redacted`, `stale_post_revoke`, `source_revoked`) emitted from `mcp/lib/ingest/salience.js` and `daemons/watermark.js`, AND the recall↔salience feedback projection (`recall_feedback`) emitted from `mcp/lib/synthesis/recall-feedback-emitter.js` once CP-5 Trigger A activates.

**Two-producer exception for `policy.token.rejected`.** This kind has TWO authorized producers — the `memory_distill_promote_fact` handler for normal verification failures, and `mcp/lib/nonce-store.js` for corruption-recovery scenarios where the rejection is structural rather than verification-level. Distinguished by the `reason` field: the handler emits `bad_signature` / `bad_binding` / `nonce_replay` / `token_expired` / `unknown_tool`, while nonce-store emits ONLY `corrupt_tail_truncated` (tail-corruption auto-truncated and recovered) or `nonce_store_corrupted` (mid-file corruption — refused). This is the single exception to the one-producer-per-kind rule and is permitted because nonce-store corruption is a structural integrity event that the handler cannot observe (it runs strictly after the store has been opened) — the rejection MUST be recorded by whichever component detected it. Audit-join consumers filter by `reason` to disambiguate the two producers.

**Payload shapes (the line written to `policy-events-YYYY-MM.jsonl`).**

```
{kind: "policy.token.consumed",                       nonce_hash, tool, accepted_at}
{kind: "policy.token.rejected",                       nonce_hash_or_null, reason, attempted_at}
{kind: "policy.daemon.lock_reclaimed",                prior_pid, prior_mtime, reclaimed_at}
{kind: "policy.corroboration",                        target_memory_id, source_ref:{source, source_msg_id, consent_basis}, ts}
{kind: "policy.recall.transitive_orphan_cap_exceeded", seed_count, visited_count, cap, ledger_mtime, ledger_size, attempted_at}
{kind: "policy.salience.recall_feedback",             recall_id, surfaced_memory_ids, surface_position_by_id, scoring_weights, propensities_by_id, emitter_module, emitter_version}
```

The watermark daemon does NOT write `policy.token.*` events — those are owned by the `memory_distill_promote_fact` handler (consume/reject only; the mint-time event kind was retired with the supervisor pipeline). The daemon never holds the signing key.

## Hook bridge

The system wires Claude Code's `Stop` and `SessionEnd` hooks to the source-row capture path via two thin shell scripts — the *hook bridge*. The bridge does the minimum: parse the hook JSON from stdin, extract `conversation_id` plus turn metadata, and append one row to `chat-claude-code.jsonl`. No batching, no token minting, no MCP calls. The cascade in `daemons/watermark.js` then picks up the new row on its next tick and routes it through Stage-0/1/2.

Two-signal discipline: the hook bridge is the **best-effort fast path** — it puts the row on disk the instant the turn ends; the watermark daemon's cascade tick (≤1s) picks the row up immediately. If the hook never fires (laptop closed mid-conversation, runtime crash, hook misconfigured), the row simply never makes it onto disk for that turn — Claude Code's own transcript persistence under `~/.claude/projects/` allows a later backfill pass. There is no separate idle-watermark trigger or queue file for the hook to write to; the conversational-pipeline architecture that used one is retired (see `kb/legacy-archive.md`).

### Files

```
<checkout>/hooks/stop-hook.sh                            # Stop hook
<checkout>/hooks/session-end-hook.sh                     # SessionEnd hook
<data root>/storage/sources/chat-claude-code.jsonl   # destination ledger
```

Both scripts are mode `0755`, owned by the user, no setuid bit. They depend on `jq` (parsing hook JSON) and `flock` (atomic append lock); both are documented install prerequisites.

### Hook contract (stdin → stdout)

Claude Code invokes each hook with the hook event JSON on stdin. Both bridge scripts:

1. Read stdin to a temp file under `<MEMORY_ROOT>/hooks/.tmp/` (atomic-rename property — same volume as destination).
2. Validate the JSON parses and that `conversation_id` (or the runtime's equivalent — `session_id` in current Claude Code; bridge translates to `conversation_id`) is present. On parse failure: log to `<MEMORY_ROOT>/hooks/hook-errors.jsonl`, exit `0` (never block the runtime).
3. Perform the per-hook action (below).
4. Exit `0` always. A hook failure must not stall the conversation — a missed row simply does not enter the cascade for that turn, and Claude Code's own transcript persistence enables backfill.

### `stop-hook.sh` — per-turn chat ledger append

`Stop` fires after the assistant's turn completes. The bridge appends one chat event to `chat-claude-code.jsonl`:

```jsonc
{
  "id": "<ulid generated by the script>",
  "ts": "<ISO-8601 UTC, server-stamped at append time>",
  "source": "chat-claude-code",
  "source_msg_id": "<sha256(canonical_json({conversation_id, content_sha256, prev_source_msg_id}))>",
  "parties": ["user", "assistant"],
  "raw_content": {
    "conversation_id": "<from hook JSON>",
    "turn_index": "<integer from hook JSON if present, else null — informational only, NOT in source_msg_id preimage>",
    "user_text": "<hook JSON user_message>",
    "assistant_text": "<hook JSON assistant_message>",
    "runtime": "claude-code",
    "cwd": "<from hook JSON>"
  },
  "attachments": [],
  "source_policy": {
    "deletion_semantics": "full_excise",
    "consent_basis": "first_party"
  },
  "checksum": "<blake2b512 truncated to 16 bytes, lowercase hex (32 hex chars), of canonical_json of all fields above (excluding `checksum` itself); enables corrupt-tail-truncation discipline per architecture.md § Source ledgers>"
}
```

<!-- BEGIN-CANONICAL: source_msg_id_inline_formula -->
source_msg_id = sha256(canonical_json({conversation_id, content_sha256, prev_source_msg_id}))
<!-- END-CANONICAL: source_msg_id_inline_formula -->

Preimage fields:

- `content_sha256 = sha256(canonical_json({user_text, assistant_text}))` over raw UTF-8 bytes (RFC 8785 JCS, no NFC — matches the spec-5 r5 fix to `validation.js`).
- `prev_source_msg_id` is the `source_msg_id` of the most recent chat-ledger entry for the same `conversation_id`, or `null` for the conversation's first turn. The hook computes it by tail-reading the chat ledger (last few KB, bounded), filtering by `raw_content.conversation_id`, taking the last match.

**Why `prev_source_msg_id` is load-bearing**: pure `content_sha256` would silently collapse two genuinely distinct turns that happened to produce identical `{user_text, assistant_text}` — common in agentic coding transcripts where repeated `"continue"` / `"yes"` / `"do it"` user prompts pair with empty-prose tool-only assistant turns. Folding the prior entry's `source_msg_id` into the preimage gives distinctness without breaking idempotency: a second hook firing for the same turn sees the same `prev_source_msg_id` (the entry that existed BEFORE this turn) and produces the same `source_msg_id` (dedupes); two distinct turns with identical content see different `prev_source_msg_id` (the first turn becomes the second's predecessor) and produce different `source_msg_id` (both land). The `role` field that earlier preimages carried was vestigial — this is a combined-turn event (`parties: ["user", "assistant"]`) with no single role to hash — and is removed entirely.

Cost: one tail-read per hook invocation, **bounded by `CHAT_LEDGER_TAIL_READ_MAX_BYTES`** (default 256KB). Read backwards from EOF up to the cap, looking for the most recent entry matching this `conversation_id`. If no match within the budget OR the tail-read fails (corrupt ledger, lock contention beyond soft timeout), the hook falls back to `prev_source_msg_id = null` and logs the failure to `<MEMORY_ROOT>/hooks/hook-errors.jsonl` (per-event row with lock state, last-good-offset, and the conversation_id). The failure-matrix row above describes the collision edge case — it is detectable in the hook-errors log (two consecutive null-fallback rows for the same conversation_id within the watermark window is the diagnostic signature) and recoverable via the M2 chat-ledger checksum + corrupt-tail truncation discipline.

Idempotency: `source_msg_id` is a deterministic hash via the same `canonical_json` (RFC 8785) path as `binding_hash`. If the hook fires twice for the same turn, both writes produce identical `source_msg_id` and the cascade's promote-time dedupe (via `source_msg_id` equality) drops the duplicate. `memory_distill_promote_fact`'s `dedupe_action` covers the same case on the user-manual path.

Locking: `flock` an exclusive lock on `<data root>/storage/sources/.chat-claude-code.lock` from immediately before the append to immediately after `fsync`. Lock release on script exit guaranteed by trap.

`source_policy` is fixed for this connector: chat-claude-code is a first-party conversation; `full_excise` honors the user's right to delete their own design reasoning.

### `session-end-hook.sh` — final-row flush

`SessionEnd` fires when Claude Code closes a session. The bridge performs the same per-row append as `stop-hook.sh` for any remaining turn captured by the SessionEnd payload (typically zero or one), then exits. No batch file, no separate queue, no signaling. The cascade's next tick picks up any newly-appended row through the per-source watermark.

An earlier implementation of this hook wrote a batch envelope into a per-batch queue directory and signaled a long-lived supervisor process to immediately process it; that architecture is retired (see `kb/legacy-archive.md`). The current implementation simply appends the row and lets the cascade tick handle it.

### Claude Code settings.json registration

Hooks must be registered **at the user level** (not project-scoped) so capture is ambient across every project. The block lives in `~/.claude/settings.json` under the `hooks` key:

```jsonc
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "<checkout>/hooks/stop-hook.sh"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "<checkout>/hooks/session-end-hook.sh"
          }
        ]
      }
    ]
  }
}
```

Replace `<checkout>` with the absolute path of your clone: each `command` must be an absolute path to the real script (not a symlink), because the hook locates the checkout from its own location.

Project-scoped registration (`./.claude/settings.json`) is explicitly **not** used — memory capture is a user concern, not a project concern, and a per-project hook would silently lose conversations in projects that haven't opted in. The installer must check for and warn on any project-level `Stop` / `SessionEnd` registration that would shadow the user-level entry.

The `matcher: "*"` is required to fire on every `Stop` event regardless of subagent context.

### Failure mode matrix

| Failure | What happens | Recovery |
|---|---|---|
| `Stop` never fires (laptop closed mid-turn) | Turn missing from chat ledger | Accepted gap; Claude Code's own transcript persistence under `~/.claude/projects/` would allow a later backfill pass (none ships) |
| `Stop` fires twice for same turn | Both writes produce identical `source_msg_id` (same `conversation_id` + `content_sha256` + `prev_source_msg_id`) | Dedupe at salience-filter / `memory_distill_promote_fact` time; deterministic hash makes idempotency a property, not a probability |
| Two genuinely distinct turns produce identical `{user_text, assistant_text}` (e.g. user prompts `"continue"` twice; tool-only assistant turns with empty `assistant_text`) | Both writes produce DIFFERENT `source_msg_id` because `prev_source_msg_id` differs (the first turn becomes the second's predecessor) | Both turns land; no collapse. The `prev_source_msg_id` field in the preimage exists for this case |
| Hook tail-read of chat ledger fails (corrupt ledger, lock contention beyond soft timeout) | Hook falls back to `prev_source_msg_id = null` | Conservative default: may produce a duplicate row if the same turn fires twice (downstream dedupe handles). **Edge case**: if TWO distinct turns both hit the null fallback AND have identical `{user_text, assistant_text}` content (e.g. repeated `"continue"` prompts with empty tool-only assistant turns), they collapse to one chat-ledger entry. Trigger requires sustained ledger corruption — diagnose via `hook-errors.jsonl` (per-tail-read-failure log entry); repair by truncating corrupt tail (M2 source-ledger checksum + corrupt-tail truncation discipline below) which resets the ledger to a healthy state and the next turn re-establishes the prev-chain. Not silent: every tail-read failure logs to `<MEMORY_ROOT>/hooks/hook-errors.jsonl` with the lock state and last-good offset. |
| `SessionEnd` never fires (crash, kill -9) | The last turn's row may be missing from `chat-claude-code.jsonl` if `Stop` also did not fire for it | Same recovery as the `Stop`-never-fires row above: accepted gap; a later backfill from `~/.claude/projects/` could cover it (none ships) |
| `chat-claude-code.jsonl` append fails (disk full, permissions) | Hook logs to `hook-errors.jsonl`, exits 0; row not captured | User inspects `hook-errors.jsonl`; replays from `~/.claude/projects/` once root cause cleared |
| Hook JSON malformed | One line logged to `hook-errors.jsonl`; hook exits 0 | Manual review of error log; daemon's standalone watermark tick covers idle conversations |
| `flock` contention | `stop-hook.sh` waits (no timeout) | Acceptable — the lock is held only across one ledger append + fsync (<10ms typical) |
| `chat-claude-code.jsonl` missing | Append errors; hook logs and exits 0 | The install ensures the file exists with correct permissions on first daemon start |

### Interaction with `UserPromptSubmit`

`UserPromptSubmit` (the recall-injection hook in the design; not shipped, see § How the agent gets context) is **independent** of the `Stop` / `SessionEnd` path. It calls `memory_recall` and emits the brief via stdout; it never writes to the chat ledger. Its only relationship to this section is timing: it reads the ledger state that the *previous* turn's `stop-hook.sh` wrote.

## Recall-event substrate

The on-disk recall ledger (`ledgers/recall.jsonl`) and brief envelope shapes
are NOT enumerated in this file — they are owned by the recall-pipeline
contracts. Consult these in lockstep when modifying the recall surface:

- `kb/phase3-v0-contracts.md` § 4 (Brief envelope), § 5 (recall-log event),
  § 8 (CAPS) — authoritative v0 shape: `degraded_recall`, `density_flag`,
  `surfaced[].propensity / feature_breakdown`, `candidates_pre_truncation[]`.
- `kb/phase3-v1-rerank-contracts.md` § 2 (Brief envelope additions), § 3
  (recall ledger event additions), § 4 (CAPS additions) — Layer-3 listwise
  reranker (Gemini 2.5 Flash) ADDITIVE fields: `rerank_score` (per
  `surfaced[]` and per top-25 of `candidates_pre_truncation[]`),
  `rerank_attempted`, `rerank_failed_reason`, `layer3_latency_ms`,
  `degraded_recall_layer3`, plus the four `RECALL_RERANK_*` CAPS.

v1 is purely additive over v0; v0 readers ignoring the new fields remain
correct on every recall event.

## Transitive derivation-orphan propagation at recall time

Authoritative design: `kb/transitive-orphan-design.md`. Shape parent: `kb/phase3-v0-contracts.md` § 1 (IndexEntry), § 3 (ScoreComponents), § 5 (recall-log feature_breakdown), § 8 (CAPS). Open question parent: `kb/research-retrieval-frontiers.md` § Risks #10 (resolved here in Phase 3 v0+). MCP-surface impact: prose-only — see `kb/mcp-surface.md` § `memory_excise`. This section is the cross-spec consumer entry.

### Semantics (chosen — frozen)

An event `E` is a **transitive orphan** iff there exists a path through `derived_from` edges of length `d ≥ 1` from `E` back to some event `B` such that `B` is the target of an active (non-rescinded), non-`silent`, `derivation_policy in {"drop", "re_derive_without"}` `memory_excise` event, AND every edge on that path connects events whose `derivation_status` would otherwise be `NORMAL` (i.e. the chain is not broken by a `derivation_policy: "retain"` ancestor). `d` is the *orphan distance*; `d = 1` is the v0 "direct orphan" case; `d > 1` is what this design adds. The propagation rule is **RELAXED** (any excised ancestor along the chain marks the descendant — what Risk #10's "transitive excise" phrase literally means), and the treatment is **depth-aware flag, NOT drop** (preserves v0's multiplicative-gate semantics so an overwhelmingly relevant orphan can still pull through, and so the recall log carries the depth signal that the v3 learned ranker needs).

Five seeding rules are normative:

- `memory_excise` with `derivation_policy in {"drop", "re_derive_without"}` and `silent: false` DOES seed the transitive walk.
- `memory_excise` with `derivation_policy: "retain"` does NOT seed — the user explicitly asked to keep descendants alive.
- `memory_excise` with `silent: true` does NOT seed — silent excise is opaque to recall by construction; the privileged audit channel is its only consumer.
- `memory_replace` / `memory_substitute` do NOT seed — these are non-destructive supersession / reframe, not deletion. The old row stays in the ledger.
- A rescinded excise (via `memory_rescind_policy`) does NOT seed — the policy event is observable but inactive.

**Corroboration rescue.** A candidate orphan whose post-corroboration effective `source_refs[]` set contains at least one non-excised, non-orphan entry is un-flagged: the corroboration event provides an alternative provenance path the excise did not touch. Implementation is a post-BFS projection-join; see § Algorithm below.

### Algorithm

The implementer rebuilds this without reading the JS source as follows.

1. **Pre-pass (cached on ledger mtime + size).** Single scan of `ledgers/memory.jsonl` builds `reverseAdj: Map<ancestor_id, Set<descendant_id>>`. For each event `E` with `derived_from = [a_1, ..., a_k]`, insert `E.id` into `reverseAdj.get(a_i)` for each ancestor `a_i`. Cost `O(N · avg_fanin)`; expected `O(N)` at fanin 1–4.
2. **Seed set.** Walk the ledger's `policy`-kind rows. Include `memory_excise` events meeting all five seeding rules above; exclude every other policy kind. Use the rescinded-state derived from the corroboration / rescind-policy projection already maintained by the recall layer.
3. **Forward BFS over `reverseAdj`** from the seed set. Track per-node `distance_to_nearest_excised = BFS depth`; BFS guarantees first-visit is shortest-path. Cycles defended by a single visited Set (`derived_from` is a DAG by spec; the Set is belt-and-suspenders). Depth cap `CAPS.MAX_DERIVATION_DEPTH = 16`; descendant cap `CAPS.TRANSITIVE_ORPHAN_DESCENDANTS_CAP = 10000`.
4. **Cap-overflow behavior.** On hitting `TRANSITIVE_ORPHAN_DESCENDANTS_CAP` mid-walk, terminate the BFS, return the partial orphan map (the first `cap` descendants reached, all correctly flagged at their first-visited depth), and emit exactly one `policy.recall.transitive_orphan_cap_exceeded` event with payload `{seed_count, visited_count, cap, ledger_mtime, ledger_size, attempted_at}`. Recall completes — partial coverage is preferable to a latency spike. The cap is logged once per affected recall, not per overflow descendant.
5. **Corroboration rescue (post-BFS join).** For each `d` in the orphan map, load its effective `source_refs[]` per `architecture.md` § 5. If any entry's `source_ref.target_memory_id` is NOT in the seed set AND NOT in the orphan map, remove `d` from the orphan map and mark `rescued_by_corroboration = true`. Single pass; `O(orphan_count · avg_corroborations)`.
6. **Output map** keyed by `memory_id`:

   ```
   {
     distance_to_nearest_excised: number,   // 1..MAX_DERIVATION_DEPTH
     transitive_orphan: boolean,            // true iff present post-rescue
     rescued_by_corroboration: boolean      // true iff was in BFS output but removed by rescue
   }
   ```

7. **Apply at hard-gates time.** `applyHardGates` looks up each candidate by `memory_id`. Candidates absent from the map keep `derivation_status = CAPS.DERIVATION_STATUS_NORMAL`. Candidates present get the depth-aware dampener.

The map is recomputed only when the cache key `(ledger_mtime, ledger_size)` changes — typically hundreds of recalls between excises.

### Depth-aware scoring formula (frozen)

```
derivation_status =
  candidate not in orphan_map
    ? CAPS.DERIVATION_STATUS_NORMAL
    : max(
        CAPS.DERIVATION_STATUS_ORPHAN_FLOOR,   // 0.25
        exp(-CAPS.DERIVATION_ORPHAN_LAMBDA * (d - 1))
          * CAPS.DERIVATION_STATUS_ORPHAN      // 0.5 anchor
      )
```

With `CAPS.DERIVATION_ORPHAN_LAMBDA = 0.4`, `d = 1` evaluates to exactly `0.5` (the v0 direct-orphan value — strict superset of v0 behavior); `d = 2 → 0.335`; `d = 3 → 0.25` (floor); `d ≥ 4 → 0.25`.

### IndexEntry / ScoreComponents location

Per `kb/phase3-v0-contracts.md`:

- **§ 1 IndexEntry** carries `derivation_distance: number | null` — `null` for normal, `1..MAX_DERIVATION_DEPTH` for orphan. The boolean accessor `is_orphan = derivation_distance != null` is prose-defined; the canonical on-disk field is the number-or-null.
- **§ 3 ScoreComponents** carries `derivation_status: number` (the depth-aware gate value); shape unchanged from v0.
- **§ 5 recall-log `feature_breakdown`** carries BOTH `derivation_status: number` (the gate value, v0-compatible) AND `derivation_distance: number | null` (the raw depth, additive for v3 off-policy estimators).
- **§ 8 CAPS** carries `MAX_DERIVATION_DEPTH = 16`, `TRANSITIVE_ORPHAN_DESCENDANTS_CAP = 10000`, `DERIVATION_STATUS_ORPHAN_FLOOR = 0.25`, `DERIVATION_ORPHAN_LAMBDA = 0.4`.

No event-schema mutations; no MCP surface changes. The IndexEntry change is the only contract-shape delta and is additive over v0 (v0 readers ignoring `derivation_distance` and reading the absence of an orphan flag as "normal" remain correct on every non-orphan candidate).

### Cost model + user-facing cap

Bounded by `CAPS.TRANSITIVE_ORPHAN_DESCENDANTS_CAP = 10000`. At `N = 10⁴` facts (fanin avg 2, excise rate ~1%): reverse-adj build ~30ms; BFS reachability ~5ms; corroboration rescue ~2ms; total cold ~50ms; warm-cache (no ledger change) `O(1)` per candidate. At `N = 10⁵`: cold ~250ms, still well within recall's existing budget. Memory: reverse-adj Map ≤ ~13MB at `N = 10⁵`. Worst case (excise the root of a fanout-of-1000 graph) is bounded by the descendant cap, total latency ≤ ~50ms even on overflow. The cap is a known limitation; v2 (HippoRAG-2-style PPR over the derivation graph, per `research-retrieval-frontiers.md`) supersedes BFS with graph attention and removes the hard ceiling.

### Failure-mode matrix (transitive orphan computation)

| Failure | What happens | Recovery |
|---|---|---|
| BFS hits `CAPS.TRANSITIVE_ORPHAN_DESCENDANTS_CAP = 10000` before exhausting reachable descendants | Walk terminates at the cap; the first 10000 descendants ARE flagged at their first-visited depth; `policy.recall.transitive_orphan_cap_exceeded` emitted once with `{seed_count, visited_count, cap, ledger_mtime, ledger_size, attempted_at}`; recall completes with partial coverage | Partial coverage is the intended behavior — better than a latency spike. Operator may inspect the policy-events log for repeated cap-exceeded entries from the same `ledger_mtime` and consider Phase 4 incremental graph maintenance. The unreached descendants get `derivation_status = NORMAL` — fail-open per the v0+ principle (recall must complete; orphan flagging is a dampener, not a hard block). |
| `derived_from` cycle (spec-forbidden but defensively handled) | Visited Set terminates the walk; both `A` and `B` are flagged at their first-visited depth; no infinite loop | None required — visited Set is the structural defense. Cycle is logged as a ledger-integrity warning via `memory_health.health_notes` (Phase 3 v1+ surfacing). |
| BFS exceeds `CAPS.MAX_DERIVATION_DEPTH = 16` | Walk terminates at depth 16; descendants at depth ≥ 17 get `derivation_status = NORMAL` | Accepted: the depth-aware formula floors at 0.25 for `d ≥ 3` already, so a depth-17 descendant would have been at the floor regardless. No event emitted — depth cap is a structural bound on the formula, not an exceptional path. |
| Ledger mtime/size cache key collision (mtime quantized + size unchanged after edit — vanishingly rare on local FS) | Cache returns stale map; recall uses stale `derivation_distance` for one cycle | Self-healing on next ledger write that bumps both keys. Phase 4 may add a content-hash third component to the cache key if FS quantization observed in practice. |
| Corroboration projection unavailable (e.g. `memory_health.index_status != "ready"`) | Skip the rescue step; emit candidates as raw BFS output (no false negatives, possible false positives — a corroborated descendant stays flagged until the projection rebuilds) | Conservative direction: over-flagging is preferable to under-flagging when consent has been expressed via excise. Same discipline as `memory_excise`'s corroboration freshness invariant in `mcp-surface.md` § `memory_excise`. |

The cap-exceeded row is the only path that writes to `policy-events-YYYY-MM.jsonl` from the recall layer (`mcp/lib/recall/hard-gates.js`) — see the Token-event ownership table above for the canonical producer assignment.

## Per-runtime chat ledgers

Not a single `chat.jsonl`. Per-runtime ledgers, joined at the recall layer:

```
storage/sources/chat-claude-code.jsonl
storage/sources/chat-codex.jsonl
```

Reasons:

- Cleaner provenance ("you said this in Codex on Tuesday")
- Different hook fidelity and transcript shapes per runtime
- Easy to drop a runtime by stopping ingestion of one ledger

Aligns with the "multiple narrow ledgers, joined at read time" pattern from `inheritance.md`.

## Identity across runtimes

`recall`'s `surrounding_context` includes `conversation_id` and `agent_role` but not `runtime`. The agent's runtime is a provenance fact (recorded on each chat event) but not a recall scoping dimension.

This is correct: a memory you formed in Claude Code last week is yours, not Claude Code's, and should surface in Codex tomorrow if relevant.

## Bridging Claude Code's auto-memory

Claude Code already has auto-memory at `~/.claude/projects/-Users-<username>/memory/`. Three options:

- **(a) Replace.** Risky early — that system keeps current sessions coherent.
- **(b) Coexist.** Both run. Bears the cost of two memory systems with different scoring.
- **(c) Bridge.** Auto-memory's `MEMORY.md` index and per-memory files become a source for this system.

**Chosen: option (c).** Cheapest, lowest risk, no double-bookkeeping, preserves Claude Code defaults during shakeout.

### Pipeline subtlety

Auto-memory entries are **already-distilled facts**, not raw events. Claude Code's auto-memory ran its own salience filter to produce them. They enter as:

- `fact` kind directly
- `provenance.confidence: "pre_distilled"`
- Source ledger entry at `storage/sources/auto-memory.jsonl` for traceability
- The salience filter **does not re-judge** these on first pass — they bypass to the memory ledger

Otherwise the system either re-promotes what auto-memory already promoted (duplication) or fails to promote what auto-memory considered worth keeping (silent loss). Bypass is the safe default; later, an explicit re-judge pass can be run if the auto-memory output proves noisy.

Migration to option (a) — replacing auto-memory — is a future decision, gated on this system's projection earning trust.

No auto-memory bridge job ships in this repository. The pieces it would use exist: `memory_distill_promote_fact` accepts `provenance.confidence: "pre_distilled"`.

## Capture blind spots

Some surfaces are deliberately not captured. Naming them is honest; failing to name them is a silent gap.

- **Web claude.ai** — out of scope. No hook surface, hosted by Anthropic. If a meaningful fraction of conversations happen there, recall is blind to them.
- **VS Code Claude extension** — out of scope until the extension exposes hooks.
- **Mobile / iOS / Android apps** — out of scope, same reason as web.
- **Voice conversations with the assistant** — separate ingestion shape (deferred per `ingestion.md`).

The system does not claim uniform coverage of the user's agent conversations. Recall behavior should be evaluated with these gaps in mind.

## Transcript backfill

*Design history.* This section records a one-time decision made while the system was being built, about seeding it from the transcripts in which it was designed. No backfill job ships in this repository, and nothing reads the `design_corpus` flag described below.

**Decision: partial backfill, scoped to design-of-the-system transcripts only.** Every other prior Claude Code transcript stays where it lives (`~/.claude/projects/-Users-<username>/`) and does not enter `chat-claude-code.jsonl`. Forward conversations land via the `Stop` hook normally.

### Rationale

Three principles converge here. **Ledger-is-truth + provenance threaded** (`thesis.md` §1, §6): the KB is a stack of durable commitments whose derivation is the conversation that produced them. Promoting the KB sections as facts without ingesting their generating transcript would leave the most load-bearing memories in the system half-provenanced — `derived_from` edges pointing nowhere. **Replay set started from day one** (`build-plan.md`): a curated transcript with known-good outputs (the KB) is the cleanest seed data the salience filter will ever get. **Salience-filter-as-product** (`architecture.md` §3) cuts the other way for bulk backfill: applying a day-one untuned filter to a year of unrelated chats produces noise we have no labels to correct. Partial scope is what threads both.

### What concretely counts as a design transcript

A Claude Code transcript at `~/.claude/projects/-Users-<username>/*.jsonl` qualifies as design-of-the-system iff it contains at least one tool-use event whose `file_path` is under `<checkout>/`. Inspectable, mechanical, no LLM judgment in the loop. The backfill job globs the directory, scans each JSONL, and selects matches. This catches every conversation that authored or revised the KB — including the live one through which this decision is being written — and excludes everything else.

### Live vs. backfill for the current conversation

The conversation through which the user is reading and approving this decision is **live, not backfill**. It was ongoing when the hooks were first wired; the `Stop` hook captures it turn by turn the moment the hook lands. Backfill is reserved for transcripts whose final `Stop` already fired before the hook existed. The distinguishing test is "was a `Stop` hook in place when this turn was written," not topic.

### Promotion threshold and flags

Backfill events carry `backfill: true` and the standard stricter threshold from `ingestion.md` § Three timescales of up-to-date applies. **Plus** a second flag, `design_corpus: true`, on every backfilled chat event from a qualifying transcript. The salience filter treats `design_corpus: true` events differently from generic backfill: they are eligible for promotion at the *normal* threshold, not the stricter one, on the grounds that the KB files in the same filesystem subtree are independent corroboration of relevance. This is the same shape as the cross-source dedupe boost in `ingestion.md` § Cross-source dedupe at salience — corroborated content lowers the bar — but the corroborating "source" here is the KB itself.

The KB documents under `<checkout>/kb/` are *not* re-ingested through this pathway. They are promoted directly as `fact` events with `provenance.confidence: "pre_distilled"` via the auto-memory bridge shape (this section, `agent-integration.md` § Bridging Claude Code's auto-memory). The backfilled transcript supplies their `derived_from` edges.

### consent_basis on the design transcript

User-side turns: `first_party`. Assistant-side turns: `first_party` as well, on the grounds that the assistant is acting as the user's agent inside the user's machine on the user's behalf, and the substance of assistant turns in a design conversation *is* the user's reasoning made explicit through the agent. This differs from third-party message content in foreign sources where the assistant is not party to the exchange. The `consent_basis` distinction in `ingestion.md` § Consent-aware promotion exists to protect non-consenting humans whose words the user happens to be storing; it does not apply to the assistant's own outputs in a first-party conversation.

`deletion_semantics`: `full_excise` for the design corpus. The user retains the right to delete their own design reasoning cleanly, including from the source ledger, without tombstone residue.

### Operational summary

| What | Where | Flags | Promotion |
|---|---|---|---|
| Design transcripts (pre-hook) | `chat-claude-code.jsonl` via backfill job | `backfill: true`, `design_corpus: true` | Normal threshold (corroboration-relaxed) |
| All other pre-hook transcripts | Not ingested | — | — |
| Current conversation (mid-flight) | `chat-claude-code.jsonl` via `Stop` hook | none | Normal live threshold |
| KB documents under `<checkout>/kb/` | Memory ledger directly | `provenance.confidence: "pre_distilled"` | Bypass, per auto-memory bridge |

The backfill job was designed as one-shot, to run once when the hooks were first wired, and to be logged as such. Future design-of-the-system conversations are captured live and do not need a second backfill pass.
