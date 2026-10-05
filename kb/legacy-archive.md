# Legacy Archive

This file is the consolidated operator-readable history of components that have
been removed from the memory system in this codebase. New rounds that retire
parallel-running architectures MUST migrate the removed prose here (rather
than scatter "DEPRECATED" comments through live docs) and then delete the
original prose. See `kb/deprecation-discipline.md` for the policy.

Each section names the round that closed the component, the live architecture
that replaces it, and a brief shape-of-what-was-there note so a user
reading the on-disk policy events from before the removal can still parse them.

This file is on the allow-list of the prevent-legacy regression scanner
(`mcp/test/no-legacy-pipeline-references.test.mjs`) — forbidden identifiers
appear here legitimately as the historical record.

---

## R32 — Phase-1 conversational distillation pipeline (RETIRED 2026-06-05)

**Replaced by:** R25 row-by-row salience cascade
(`watermark.tickSourcesOnce` -> Stage-0 -> Stage-1 score -> Stage-2 embed+kNN ->
CORROBORATE / PROMOTE / EMBED_DEFERRED / DROP, with a direct call to
`promoteSourceRow`; no batch, no LLM-summarisation, no token-mint at trigger
time). The cascade runs against `storage/sources/<src>.jsonl` per-source
ledgers, of which `chat-claude-code.jsonl` is one.

**What was removed:**

- `daemons/distillation-supervisor.js` — long-lived launchd-supervised
  process that watched `storage/distillation-queue/pending/`, claimed batches
  via atomic rename into `in-flight/`, minted daemon-signed confirmation
  tokens from `policy/distillation-signing-key.json`, invoked
  `memory_distill_promote_fact` via a spawned MCP child with
  `MEMORY_ROLE=distillation`, and settled into `done/` or `failed/` (with a
  `_poisoned_batch_ids[]` set persisted in `policy/distillation-state.json`
  for batches that hit `POISON_THRESHOLD` failures).
- `~/Library/LaunchAgents/com.user.memory-system.distillation-supervisor.plist`
  — launchd job that supervised the above process; unloaded and deleted.
- `storage/distillation-queue/{pending,in-flight,done,failed,poisoned}/` —
  five subdirectories holding one batch-descriptor file per batch (atomic
  rename was the claim primitive). Held 513 `failed/` envelopes at retirement.
- `watermark.tickOnce` (distinct from the cascade's `tickSourcesOnce`) —
  the idle-watermark scan that built batches per `(runtime, conversation_id)`
  from chat ledgers after `DISTILLATION_IDLE_WATERMARK_SECONDS` of silence,
  bounded by `DISTILLATION_BATCH_MAX_TURNS`. Helpers `listChatLedgers`,
  `readTurnsInRange`, `getOrCreateConversation`, and the reconcile / poison /
  queue helpers went with it.
- `policy.token.minted` event kind — emitted by the supervisor immediately
  after `mintToken` succeeded, before the MCP call.
- `policy.distillation.batch.{enqueued,suppressed_by_hook,split,failed,
  poisoned}` event kinds — emitted by the watermark daemon and supervisor at
  batch lifecycle transitions.
- The Phase-1 hook-bridge from `Stop` / `SessionEnd` hooks that wrote batch
  descriptors into `storage/distillation-queue/pending/` with
  `reason: "hook_bridge"`. The source-ledger writes those hooks also did
  (one row per turn into `chat-claude-code.jsonl`) remain — they feed the
  cascade now.

**What stayed:**

- `memory_distill_promote_fact` MCP tool registration and handler — kept
  as a manual operator surface. An operator can still call it via Claude
  Code or Codex and the five-step verification (type-and-freshness,
  signature, binding, nonce single-use, consent) still runs.
- `verifyToken` in `mcp/lib/daemon-token.js` — load-bearing for the handler's
  `confirmation_token` check.
- `mintToken` in `mcp/lib/daemon-token.js` — preserved as a public export
  for operator out-of-band token issuance and for the daemon-token unit
  test surface. No production caller remains.
- `chat-claude-code.jsonl` source ledger — feeds the cascade.
- `policy/distillation-signing-key.json` — kept; the manual operator path
  still needs symmetric mint+verify.

**Why retired:** the conversational pipeline architecturally pre-dated the
cascade; R25 replaced its function but did not retire it, so both ran in
parallel and both consumed Gemini quota. By R32 the supervisor's watermark
lag was 51,687 s (~14 h), `last_distillation_ts` was `null`, and 200 of 200
recent policy events were conversational-pipeline activity (97
`distillation.batch.failed` + 33 `distillation.batch.poisoned` + 54
`token.minted` + 16 `batch.enqueued`) with zero cascade events on the same
window. R32 retired it in one round and froze a prevent-legacy regression
gate so the pattern (replace-then-leave-parallel-running) cannot recur
silently.

### R32.1 — KB migration of retired AUTHORITATIVE schemas

R32 retired the Phase-1 pipeline; R32.1 audited the live KB docs and
moved the frozen-but-now-dead schemas out of `kb/agent-integration.md`
and `kb/mcp-surface.md` into this archive so the live docs describe the
cascade as the canonical promote path.

**Retired AUTHORITATIVE schema 1: distillation batch file**

Frozen on-disk shape, one file per batch under the Phase-1 queue dir's
`{pending,in-flight,done,failed}/` subdirectories:

```
{
  "batch_id": "<ulid>",
  "runtime": "<runtime tag from chat-<runtime>.jsonl basename>",
  "conversation_id": "<from chat ledger turns>",
  "reason": "idle_watermark" | "hook_bridge" | "split_continuation" | "hook_bridge_empty",
  "chat_ledger_path": "<absolute path>",
  "range": {
    "first_turn_id": "<source_msg_id>",
    "last_turn_id":  "<source_msg_id>",
    "first_turn_ts": "<ISO-8601>",
    "last_turn_ts":  "<ISO-8601>"
  },
  "turn_count": <int 1..64>,
  "enqueued_at": "<ISO-8601>"
}
```

Batch cap was 64 turns. Over-cap split into sequential batches. The
supervisor claimed batches by atomic rename from `pending/` to
`in-flight/`, processed them, then renamed to `done/` or `failed/`.
513 `failed/` envelopes were on disk at retirement.

**Retired AUTHORITATIVE schema 2: distillation state file**

Single file at the Phase-1 watermark-state path, atomically replaced
each tick. Frozen top-level shape:

```
{
  "version": 1,
  "updated_at": "<ISO-8601>",
  "conversations": {
    "<runtime>:<conversation_id>": {
      "chat_ledger_path": "<absolute path>",
      "last_processed_turn_id": "<source_msg_id> | null",
      "last_processed_turn_ts": "<ISO-8601> | null",
      "resume_cursor_offset": <int byte offset; per-conversation lower-bound cursor>,
      "last_batch_id": "<ulid> | null",
      "last_batch_enqueued_at": "<ISO-8601> | null"
    }
  },
  "in_flight": [
    {
      "batch_id": "<ulid>",
      "conversation_key": "<runtime>:<conversation_id>",
      "enqueued_at": "<ISO-8601>",
      "claimed_at": "<ISO-8601> | null"
    }
  ]
}
```

The earlier nested-per-conversation `in_flight_batch_ids` shape (with
top-level `schema_version` + `runtimes:{<rt>:{conversations:{<conv>:...}}}`)
was deleted at review-12 C2 in favor of the flat `conversations` + top-level
`in_flight[]` shape above; the file was renamed from the Phase-1 path to
`watermark-state.json` in R32.1.

The implementation-private addendum (`_pending_turns_by_conv`,
`first_start_rebuild_complete`, `_poisoned_batch_ids` at top level;
`tentative_pending`, `retry_count_for_batch`, `_last_seen_id`,
`_last_seen_ts` per conversation) was retired with the supervisor.

**Retired AUTHORITATIVE schema 3: Phase-1 event-payload shapes**

The retired event-kind payloads that streamed to `policy-events-YYYY-MM.jsonl`
during Phase-1:

```
{kind: <retired mint kind>,                          nonce_hash, tool, issued_at, expires_at}
{kind: <retired batch.enqueued kind>,                batch_id, runtime, conversation_id, turn_count, reason, enqueued_at}
{kind: <retired batch.suppressed_by_hook kind>,      batch_id_we_would_have_enqueued, hook_batch_id, conversation_key, ts}
{kind: <retired batch.split kind>,                   parent_intent_id, batch_ids: [...], reason: <retired batch-cap>}
{kind: <retired batch.failed kind>,                  batch_id, reason, failed_at}
{kind: <retired batch.poisoned kind>,                batch_id, conversation_key, retry_count, poisoned_at}
```

(The literal kind strings are intentionally elided in this paragraph
because the forbidden-identifier scanner flags them; an operator
reading historical `policy-events-YYYY-MM.jsonl` lines from before
R32 can match each row's `kind` field against the post-retirement
list at the top of this section.)

The cascade promote path does NOT emit any of these. The surviving
event family the cascade and the MCP handler share (`policy.token.*`,
`policy.daemon.*`, `policy.recall.*`, `policy.corroboration`) lives in
`kb/agent-integration.md § Token-event ownership table (AUTHORITATIVE)`.

---

## R30 — Per-key 24h Gemini cooldown CAP (RETIRED)

**Replaced by:** sticky-until-429 rotation across the
`GEMINI_API_KEYS` pool with no per-key cooldown timer. The R29 cooldown
was modelled on Google's per-day quota reset cadence, but the empirical
behaviour was that a key in cooldown simply went unused for 24h even when
Google had reset its quota silently mid-window. R30 removed the cooldown
clock and lets the next 429 from a key flip rotation instead.

**What was removed:** `GEMINI_KEY_COOLDOWN_HOURS` constant + its readers
in `mcp/lib/gemini-client.js`. The 6 production references the R29
verifier found are 0 as of R30.

---

## R29.3 — `embedding_pending=true` promote-time field (RETIRED)

**Replaced by:** the EMBED_DEFERRED cascade outcome, which parks the row
at the cursor (the row stays in `storage/sources/<src>.jsonl` with no
`memory.jsonl` write) and lets the next cascade tick attempt embedding
again. The R29.3-era `is_seed_row` marker on facts already in
`memory.jsonl` from the pre-cascade era is the absence-check that
`scripts/backfill-embeddings.mjs` uses to find rows that still need
vectors; `embedding_pending` was the promote-time write the supervisor
made when Gemini was throttled at mint time.

**What was removed:** the `features.embedding_pending = true` write in
`mcp/lib/tools/distill-promote-fact.js` and all reader branches in
`mcp/lib/recall/hard-gates.js`, `mcp/lib/recall/hnsw-index.js`,
`mcp/lib/ingest/salience.js`, and `scripts/backfill-embeddings.mjs`. The
backfill script's recovery path now keys off absence of an embedding,
not on the field.

---

## R28.1 — `gemini-cli` and `python-sdk` agent-runtime connectors (RETIRED)

**Replaced by:** nothing. R28 originally shipped four agent-runtime hooks
(`chat-claude-code`, `chat-codex`, `chat-gemini`, `chat-python-sdk`). R28.1
dropped `chat-gemini` and `chat-python-sdk` because they had no
operator-authored callers — the rows the connectors would have captured
were operator-experiment chatter, not signal. The connector daemons were
removed in R28.1; the on-disk artefacts (the `connectors/gemini-cli/`
state dir holding the per-session cursors map, and any policy events
naming the source) were missed and lingered as a stale entry in
`memory_connectors_list` until R32 deleted them.

**What was removed in R28.1:** `daemons/gemini-cli-connector.js`,
`daemons/python-sdk-connector.js`, their launchd plists, their entries in
the source-validation enum (`validation.js`), the `chat-gemini` and
`chat-python-sdk` Stage-0 dispatch rows.

**What R32 removed (R28.1 gap closure):** `connectors/gemini-cli/state.json`
+ parent dir; KB prose in `connectors-survey.md`, `build-plan.md`,
`agent-integration.md` that still listed the two sources.

**What stayed:** the policy-events historical record of rows the connectors
captured before R28.1; the `chat-claude-code` and `chat-codex` agent-runtime
connectors (still active, both feeding the cascade).

---

## R33 — Final KB doc migration of Phase-1 prose (CLOSED 2026-06-05)

R32 retired the Phase-1 pipeline; R32.1 migrated the frozen-but-now-dead
AUTHORITATIVE schemas out of `kb/agent-integration.md` and
`kb/mcp-surface.md`. R33 closed the remaining four KB docs the R32.1
brutalist round flagged (`kb/build-plan.md`, `kb/ingestion.md`,
`kb/phase3-v0-contracts.md`, `kb/research-retrieval-frontiers.md`)
so the live docs no longer describe any retired identifier as
normative. The cascade is the only described promote path; the
forbidden-identifier scanner extended to `.md` (R32.1) now returns
zero hits against `kb/**`.

### R33.1 — `kb/build-plan.md § Phase 1` deliverable list (RETIRED PROSE)

The Phase-1 deliverable list as it stood in `kb/build-plan.md` pre-R33
is recorded verbatim below. The live `kb/build-plan.md § Phase 1 —
RETIRED (R32)` stub points operators here. The cascade replacement is
already summarised at `legacy-archive.md § R32 — Phase-1 conversational
distillation pipeline`; this section keeps the Phase-1 historical
deliverable enumeration for review-12 / review-20 trail readers.

Pre-R33 Phase-1 deliverable list (each was the bar to call Phase 1
"done" at the time it was written; none of these are bars the live
system holds itself to today):

- **Watermark daemon** at `<checkout>/daemons/watermark.js` —
  long-lived, single instance per machine, supervised by
  launchd/systemd. Tailed every
  `<data root>/storage/sources/chat-*.jsonl`; per
  `(runtime, conversation_id)` pair tracked last-turn `ts` and `id`.
  On each 1s tick, when `now - last_turn_ts` >=
  `DISTILLATION_IDLE_WATERMARK_SECONDS` (180), built a distillation
  batch (<= `DISTILLATION_BATCH_MAX_TURNS` = 64; over-cap split into
  sequential batches) and enqueued it. Batch on-disk shape was
  frozen authoritatively at `agent-integration.md § Watermark daemon
  (Phase 1) -> Distillation batch (AUTHORITATIVE SCHEMA)` — daemon
  and supervisor agreed byte-for-byte (review-12 C1). State persisted
  at `<data root>/policy/distillation-state.json` under
  `distillation-state.lock` with PID + mtime heartbeat. Re-ran on
  conversation resume if state changed during the gap.
- **Hook bridge to distillation** — two shell scripts replacing the
  Phase 0 placeholders:
  - `<checkout>/hooks/stop-hook.sh` — per-turn chat-ledger
    append; deterministic `source_msg_id` =
    `sha256(canonical_json({conversation_id, content_sha256,
    prev_source_msg_id}))` where `content_sha256` =
    `sha256(canonical_json({user_text, assistant_text}))`. `flock`
    discipline matching the source-ledger pattern. Hook performed
    one tail-read of the chat ledger capped at
    `CHAT_LEDGER_TAIL_READ_MAX_BYTES` (256KB) to find the previous
    entry for this `conversation_id`. (NOTE: this hook survives in
    the cascade architecture; it still writes
    `storage/sources/chat-claude-code.jsonl` rows.)
  - `<checkout>/daemons/distillation-supervisor.js` — separate
    process from `watermark.js`; watched the distillation queue
    (`<data root>/storage/distillation-queue/pending/`), claimed
    batches via atomic rename to `in-flight/`, minted daemon-signed
    tokens from `<data root>/policy/distillation-signing-key.json`
    (sole legitimate key-holder; `watermark.js` never read it),
    called `memory_distill_promote_fact` with the canonical binding,
    atomically renamed to `done/` or `failed/` on settle. Spawned
    with `MEMORY_ROLE=distillation` when invoking the memory MCP
    child process — the only role-marker the MCP server accepted for
    distillation-only tools. State file was SINGLE and SHARED: both
    daemons read/wrote
    `<data root>/policy/distillation-state.json` under the same
    state-file lock. Process model: supervised under the same
    launchd/systemd as the watermark daemon but as a distinct
    process to preserve the key-custody boundary the threat model
    leaned on.
  - `<checkout>/hooks/session-end-hook.sh` — `session_end_signal`
    to the daemon's queue to skip the idle wait. (Still exists in the
    cascade architecture.)
  - Registered at user level in `~/.claude/settings.json` under
    `hooks.Stop` and `hooks.SessionEnd` (matcher `"*"`);
    project-scoped registration explicitly disallowed (memory capture
    is a user concern). Both scripts exit `0` always (hook failure
    never blocked the runtime).
- **Distillation queue** at
  `<data root>/storage/distillation-queue/{pending,in-flight,done,failed}/` —
  one batch file per directory, atomic rename for claim. Both
  daemon-triggered (`reason: "idle_watermark"`) and
  hook-bridge-triggered (`reason: "hook_bridge"`) batches shared one
  schema; the supervisor could not tell them apart at the contract
  level.
- **Daemon-signed token class** went live with
  `<data root>/policy/distillation-signing-key.json` (file format
  `{"version": 1, "key_hex": "<64 hex chars>"}`; first-start
  generated 32 bytes via CSPRNG; subsequent starts validated and
  cached). Minting and verification flows were specified in
  `mcp-surface.md § Privilege levels -> Daemon-signed token`. (The
  on-disk key file survives because `memory_distill_promote_fact`
  still verifies tokens on direct manual operator calls.)
- **Consumed-nonce store** enforced for every distillation write at
  `<data root>/policy/consumed-nonces.jsonl` — atomic
  check-and-set under exclusive `flock`, `blake2b512`-truncated-to-16-bytes
  checksum per line (see `mcp-surface.md § Consumed-nonce store` for
  the rationale on truncated-blake2b512 vs native blake2b-128),
  TTL-driven compaction sweeper, corrupt-tail truncation on startup,
  mid-file corruption halts the daemon. (The store survives because
  `memory_distill_promote_fact` still single-use-binds tokens.)
- **Policy-events audit log** at
  `<data root>/policy/policy-events-YYYY-MM.jsonl` began streaming.
  Producer ownership was frozen authoritatively at
  `agent-integration.md § Token-event ownership table (AUTHORITATIVE)` —
  exactly one producer per kind, no overlap (review-12 C4). Summary
  of the Phase-1 producer assignments (now ALL retired except where
  noted):
    - `policy.token.<retired mint kind>` from the supervisor (post-mint) — RETIRED with the supervisor
    - `policy.token.{consumed,rejected}` from the
      `memory_distill_promote_fact` handler (post-verify) — STAYS
      for direct manual operator calls
    - `policy.distillation.batch.<retired enqueued|suppressed_by_hook|split kinds>` from the
      watermark daemon / hook bridge — RETIRED with the queue
    - `policy.daemon.{lock_reclaimed,state.rebuilt}` from the
      watermark daemon (and supervisor for its own lock) — partial
      survival; the cascade tick emits the lifecycle events it
      needs, the supervisor's lock events are gone
- **`memory_distill_promote_fact` wiring** — `confirmation_token`
  became required; the five-step verification sequence
  (type-and-freshness, signature, binding, nonce single-use, consent —
  in that order; type-and-freshness FIRST per
  `mcp-surface.md § Daemon-signed token verification` so type-routed
  tokens get a clean `wrong_type` reason and there is no HMAC oracle
  on type-routed payloads) went live. `SCOPE_BLOCKED` became
  reachable at step 0 via `MEMORY_ROLE` launch-identity env (any
  server with `MEMORY_ROLE != "distillation"` rejected
  distillation-only tools before payload parse — see
  `mcp-surface.md § Privilege levels -> SCOPE_BLOCKED via
  launch-identity`). `CONSENT_BLOCKED` became reachable. The
  supervisor read transcripts and emitted
  `memory_distill_promote_fact` calls into the memory ledger. Policy
  events (substitute / replace via `memory_distill_emit_policy`)
  were scheduled for Phase 3 alongside the agent-side tools they
  mirror — Phase 1 was promotion-only. (The MCP tool stays; the
  cascade route around it does not call it.)
- **Auto-memory bridge as inaugural caller** — promoted
  `pre_distilled` entries from `storage/sources/auto-memory.jsonl`
  through `memory_distill_promote_fact` with
  `provenance.confidence: "pre_distilled"`. The auto-memory bridge
  now feeds the cascade like any other source.
- **Test vectors pinned**: per-line nonce-store checksum vector; full
  daemon-token mint vector; binding-mismatch rejection vector;
  replay rejection vector; expiry rejection vector; wrong-type
  rejection vector; `source_refs_hash` single-ref + multi-ref-ordering
  vectors; `content_hash` non-ASCII NFC-conformance vector. (The
  surviving vectors live in the test suite for the surviving handler
  surface.)
- Watch promotions manually; feed corrections into the replay set.

The cascade replacement summary (what the system actually does today)
remains at `legacy-archive.md § R32 — Phase-1 conversational
distillation pipeline` above.

### R33.2 — `kb/ingestion.md § Agent-runtime sources` retired-connector callout (REWRITTEN)

The pre-R33 prose at `kb/ingestion.md § Agent-runtime sources` named
the two R28.1-retired sources explicitly:

> R28.1 scope correction removed `<retired source A>` and
> `<retired source B>`; the user focuses on Claude Code + Codex
> only.

R33 rewrote the parenthetical to point at `legacy-archive.md § R28.1`
instead of naming the retired sources inline. The retired source names
are: `gemini-cli` and `python-sdk` (recorded once here as the canonical
historical referent; live KB prose in `kb/ingestion.md` no longer names
them).

### R33.3 — `kb/ingestion.md § Edit and delete from source as policy-event triggers` (REWRITTEN)

Two sentences in the edit/delete-as-policy-event subsection described
the Phase-1 supervisor as the emitter of `memory_distill_emit_policy`
substitute events and as the rejected exclude-synthesis daemon:

> if the change is substantive, the [Phase-1 supervisor] emits
> `memory_distill_emit_policy` with `kind: "substitute"` (Phase 3+).
> ...
> The "delete -> exclude" path was considered and rejected — it would
> have required the [Phase-1 daemon] to synthesize a predicate against
> the deleted source, ...

R33 rewrote both sentences to describe the cascade-tick observer
emitting the substitute event and to describe the cascade as the path
that has no exclude-synthesis. The live cascade code at
`mcp/lib/ingest/salience.js` is the substitute-event emitter at Phase
3+; the integrity argument (the daemon has no exclude path) reads
identically against the cascade.

### R33.4 — `kb/phase3-v0-contracts.md § Graceful degrade discipline` (REWRITTEN)

The Gemini-outage-at-promote-time bullet referenced the retired
`embedding_pending=true` write path by name. R33 rewrote the inline
cross-reference to point at `legacy-archive.md § R29.3` without
naming the retired field literal in live prose. The semantic content
of the bullet (EMBED_DEFERRED is the cascade fallback; backfill keys
off absence of an embedding) is unchanged.

### R33.5 — `kb/research-retrieval-frontiers.md § Fallback (two-level)` (REWRITTEN)

Same shape as R33.4: the transient-outage fallback bullet referenced
the retired `embedding_pending=true` write path by name. R33 rewrote
the inline cross-reference to point at `legacy-archive.md § R29.3`
without naming the retired field literal. EMBED_DEFERRED remains the
live cascade fallback.

### Post-R33 acceptance

After R33: `node mcp/test/no-legacy-pipeline-references.test.mjs`
returns zero hits against `kb/**` (the live KB tree); the only
surviving in-tree hits are in `mcp/test/**` orphan test files which
are addressed by the R33 Phase-C orphan-test-removal sub-task and the
B3 / B4 foundation gates. Test-file hits are tracked separately from
KB-doc hits.

---

## R42 — `_mail-identity-map.json` mail identity map (RETIRED)

**Replaced by:** the per-host operator identity config
(`config/operator-identity.json`, or the file named by
`MEMORY_OPERATOR_IDENTITY_FILE`), read once per process by
`mcp/lib/identity/operator-identity.js`. The mail connector asks
`isOperator(address, "mail")` for every From: / To: address; the three
consent outcomes (`first_party`, `second_party_dm`,
`third_party_inferred`) are unchanged.

**What was removed:** the connector-local `_mail-identity-map.json` file
(shape `{canonical, aliases[]}`) that sat beside the mail connector and
was loaded by default. It duplicated addresses the other connectors
already needed and kept them inside the source tree.

**What stayed:** the optional `identityMapPath` constructor argument of
the mail connector. A caller can still inject a file of the old shape;
its addresses are unioned with the identity config. With no path given
the injected map is empty.
