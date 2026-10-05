# Build plan

Phased. Each phase is lived in for 1–2 weeks before the next is started. The point of each phase is a *distinctive* test of the design, not infrastructure.

## Phase 0 — proof of distinctive thesis

The minimum that exercises context-conditional recall **and** a policy operation. If this phase is just embedding RAG, the phase is wrong.

- One source ledger: `chat-claude-code.jsonl` (per-runtime form from day one)
- Memory ledger with `fact`, `policy`, `recall`, `reconstructed` kinds
- Embedding index (start here; other features in Phase 3)
- `recall(context)` reading recent N turns as `surrounding_context`
- **One policy op wired in from day one: `exclude(predicate)`** — bound to a server-issued `recall_id`, embedding snapshotted server-side, never caller-supplied. **Scoped only** in Phase 0; `scope: "global"` returns `PRIVILEGE_REQUIRED` until Phase 2 ships user-issued token issuance
- `memory_rescind_policy` paired with `exclude` so propose-back has a reachable negative branch (the unified rescind that will also handle replace/substitute in Phase 3)
- `memory_get(id)` for read-before-destroy and provenance display
- Memory MCP server fronts `recall`, policy ops, and read introspection — no privileged tools land in Phase 0
- Consumed-nonce store at `policy/consumed-nonces.jsonl` and `policy/distillation-signing-key.json` files created with correct permissions (`0600`, `O_NOFOLLOW`, `nlink == 1`) from day one but unused in Phase 0; they go live in Phase 1 (distillation) and Phase 2 (control-plane writes)
- Claude Code integration wired: `UserPromptSubmit` hook injects brief; `Stop` hook captures turn and triggers distillation; idle-watermark daemon as fallback
- Auto-memory bridged as a pre-distilled source (see `agent-integration.md` § Bridging Claude Code's auto-memory)
- One-shot backfill of design-of-the-system transcripts only — JSONLs under `~/.claude/projects/-Users-<username>/` that touch `<checkout>/` — into `chat-claude-code.jsonl` with `backfill: true` + `design_corpus: true`; KB docs themselves promoted via the auto-memory bridge as pre-distilled facts pointing back at those transcript ranges (see `agent-integration.md` § Transcript backfill)
- **Replay set started from day one** — every conversation transcript + lived response (corrected, confirmed, ignored) becomes labeled eval data

**Done when:** the user can say "stop bringing up X" in conversation A and the system honors it in unrelated conversation B, two days later.

## Phase 1 — RETIRED (R32)

The Phase-1 conversational-distillation pipeline (idle-watermark batch
builder, the per-batch supervisor daemon, the on-disk claim-ring queue
under `storage/`, the daemon-token mint flow, and the retired
`policy.distillation.batch.*` event family) was retired in R32 in favor
of the R25 row-by-row salience cascade, which is now the only promote
path.

### Canonical: source_msg_id preimage formula

The cascade still uses the Phase-1 `source_msg_id` preimage formula
unchanged (it is the per-source row identity used by every connector
plus the chat-claude-code path). The formula below is MACHINE-CONSUMED
by `mcp/test/source-msg-id-preimage.test.mjs` via
`extractCanonical(...)`. Do NOT edit the inside of the CANONICAL block
without (1) updating the consumer test and (2) updating
`mcp/policy/canonical-allowlist.json` to record the new sha256.

<!-- BEGIN-CANONICAL: source_msg_id_formula -->
source_msg_id = sha256(canonical_json({conversation_id, content_sha256, prev_source_msg_id}))
<!-- END-CANONICAL: source_msg_id_formula -->

The literal identifiers of all retired components are recorded
once in `kb/legacy-archive.md § R32` and `§ R33`. The cascade tails `storage/sources/<src>.jsonl` per-source
ledgers (`watermark.tickSourcesOnce` -> Stage-0 -> Stage-1 score ->
Stage-2 embed+kNN -> CORROBORATE / PROMOTE / EMBED_DEFERRED / DROP, with
a direct call to `promoteSourceRow`).

For the historical deliverables that defined Phase 1, see
`kb/legacy-archive.md § R32 — Phase-1 conversational distillation
pipeline` (the cascade replacement summary) and
`kb/legacy-archive.md § R33 — Phase-1 build-plan deliverables` (the
verbatim Phase-1 deliverable list as it stood pre-R32).

What survives from this phase in the live architecture:

- The `Stop` and `SessionEnd` Claude Code hooks (`<checkout>/hooks/stop-hook.sh`
  and `<checkout>/hooks/session-end-hook.sh`) still write per-turn
  rows to `storage/sources/chat-claude-code.jsonl`; the cascade tails
  that ledger like any other source.
- The `memory_distill_promote_fact` MCP tool handler stays as the
  manual-operator-call surface (token verification remains for direct
  promote calls); the cascade itself calls `promoteSourceRow` directly
  and does not mint tokens at trigger time.
- The consumed-nonce store at `<data root>/policy/consumed-nonces.jsonl`
  stays because `memory_distill_promote_fact` still single-use-binds
  tokens against it for the manual-call path.
- The replay set lives.

**Done when (historical):** the salience filter's promotion decisions
agreed with the user's "yes, this matters" on 80%+ of a held-out sample.
This bar carries over to the cascade's Stage-1 score in v1+.

## Phase 2 — Connector boundary proof (re-cut, round-20 close)

The connector boundary is proved in three sub-phases. Round-20 re-sequenced the original two-step "hook parity → Telegram + iMessage" plan into **2a → 2b → 2c**, promoting macOS-native + dev-context connectors ahead of Telegram. Rationale: `kb/connectors-survey.md` shows that iMessage + ScreenTime + git-log + github-events share a single FDA grant (or no grant at all), exercise the consent classifier across all three values (`first_party` / `second_party_dm` / `third_party_inferred`), and ship without any new npm dep or third-party auth flow — i.e. they prove the connector boundary at strictly lower risk than Telegram. Telegram defers to **2c** where it gains real-auth + cross-source-derivation pressure on a substrate that is already shipping four connectors. `kb/connectors-survey.md` is the authoritative implementation spec for every connector in this phase.

### Phase 2a — Agent-runtime hook parity (SHIPPED)

One more chat-runtime ledger, a direct sibling of `chat-claude-code.jsonl`. Pure `first_party`, no auth, no TCC, no cursor management. 2a proved the connector boundary at lowest risk. R28.1 scope correction removed the two originally-planned siblings (see `kb/legacy-archive.md`).

- `chat-codex` — Codex CLI hooks (SessionStart / UserPromptSubmit / Stop / SessionEnd) registered at `~/.codex/hooks.json`. Stop hook carries only `last_assistant_message`, so a `turn_id`-keyed stitch cache joins it to UserPromptSubmit's prompt before append; GC TTL configurable via `CODEX_TURN_STITCH_TTL_SECONDS` (default 300s).

This replaced the legacy "wrapper or cron" guidance in `agent-integration.md § Per-runtime integration`. Per the R28.1 operator scope correction, codex-cli is the sole agent-runtime hook source.

### Phase 2b — Apple-native + dev-context connectors (SHIPPED)

Four connectors against the shared `ConnectorBase` substrate (`mcp/lib/connectors/index.js`). Exercises auth-less + read-only-Library tails, real cursors, and the full consent classifier (round-20 C1 authorship-trumps-audience + C2 second_party_dm parity dampener). Each impl daemon composes with `ConnectorBase` rather than re-deriving append / cursor / health discipline.

- **`imessage`** — read-only SQLite poll of `~/Library/Messages/chat.db` with WAL snapshot + `attributedBody` NSKeyedArchiver decoder for Ventura+ text. Daemon at `mcp/lib/connectors/imessage.js`; storage at `storage/sources/imessage.jsonl`. Classifier covers all seven round-20 rules (outbound→first_party, inbound 1:1→second_party_dm, group→third_party_inferred, business `BIZ:` prefix→third_party_inferred, tapback `kind:"reaction"` with `derived_from`, reply thread inheritance, cache_roomnames lifecycle). Requires operator FDA grant; see `kb/operations.md § Phase 2b activation procedure`.
- **`screentime`** — read-only SQLite poll of `~/Library/Application Support/Knowledge/knowledgeC.db` `ZOBJECT` table. Daemon at `mcp/lib/connectors/screentime.js`; storage at `storage/sources/screentime.jsonl`. Every row is `first_party` (operator's own behavioral signal on operator's machine); `first_party_behavioral` deferred to Phase 3 per `connectors-survey.md § Consent taxonomy extensions`. Shares the iMessage FDA grant (same node binary).
- **`git-log`** — walks operator-known repo roots; `git log --pretty=format:... --all --reflog` per repo. Daemon at `mcp/lib/connectors/git-log-local.js`; storage at `storage/sources/git-log.jsonl`. Author-email match → `first_party`; co-author / merged-from-others → `third_party_inferred`. No FDA, no new deps (`git` on PATH).
- **`github-events`** — `gh api /users/<self>/events` polled daily (30-day retention since 2025-01-30). Daemon at `mcp/lib/connectors/github-events.js`; storage at `storage/sources/github-events.jsonl`. Operator's own actions → `first_party`; events on others' repos → `third_party_inferred`. No FDA; `gh` authed via Keychain.

Shared `ConnectorBase` (round-19 + round-20 close) owns: auth-path discipline, atomic cursor persistence at `connectors/<source>/state.json` (mode 0600, tmp+fsync+rename+dir-fsync), bounded-tail dedupe on `source_msg_id`, source_policy stamping via per-daemon classifier closure, blake2b512-trunc-16-hex row checksum, edit/delete-as-event emission, and the `{ok|degraded|stale|failed}` health taxonomy. The `memory_connectors_list` MCP tool surfaces all four with `{source, status, last_appended_ts, last_cursor_advance_ts}`.

**Round-20 C4 kill-switch marker** ships for all four: `applyConnectorRevoke({source})` appends a `kind:"policy"` `policy_kind:"connector_revoke"` row to `ledgers/memory.jsonl` with `target_source: source`. The recall layer's transitive-orphan BFS reads this marker; derived memories tagged ORPHAN per `kb/transitive-orphan-design.md`.

Launchd plists for all four daemons ship under `~/Library/LaunchAgents/com.user.memory-system.<source>-connector.plist` but are **NOT auto-loaded** — activation is gated on the user behind a one-time FDA grant for the shared node binary (covers iMessage + ScreenTime in a single toggle). See `kb/operations.md § Phase 2b activation procedure` for the launchctl bootstrap + bootout commands and the troubleshooting matrix.

**Done.** All four connectors green on hermetic synthetic-fixture tests; `npm test` includes `connector-base.test.mjs`, `imessage-connector.test.mjs`, `screentime-connector.test.mjs`, `git-log-local-connector.test.mjs`, `github-events-connector.test.mjs`, and `connectors-list-live.test.mjs`; spec-sweep clean.

### Phase 2c — Telegram (first foreign-auth source)

Phase 2b cleared the substrate; Phase 2c adds the only remaining Phase 2 connector that exercises a foreign auth flow.

- **Telegram connector daemon** at `<checkout>/daemons/telegram-connector.py` talking MTProto directly (Telethon, Python — see `connectors-survey.md § Open questions` for the language decision) — no MCP intermediary. Auth secret at `<data root>/policy/telegram-session.json` (`0600`, gitignored, same discipline as `distillation-signing-key.json`). Takeout session used for one-shot backfill; `events.NewMessage` / `MessageEdited` / `MessageDeleted` for live tail.
- Three timescales activated: live (Telegram updates long-poll), catch-up (cursor-based, per-chat watermark), backfill (throttled, stricter promotion threshold via `backfill: true`).
- Source-policy classifier per `connectors-survey.md § telegram` (DM → `second_party_dm`; group / channel → `third_party_inferred`; saved-messages / self-channel → `first_party`).
- Sensitive-material gate stress-tested on real content.
- Derivation graph exercised when chat memory references Telegram-sourced facts.
- **`memory_connector_revoke` kill switch** reuses the Phase 2b `applyConnectorRevoke` marker; additionally revokes upstream auth via Telegram `auth.logOut`.
- **User-issued token issuance flow** ships (settings UI or CLI prompt). Unlocks privileged control-plane writes (`memory_connector_pause` / `resume`, `memory_quarantine_approve` / `excise`) AND unlocks `memory_exclude` `scope: "global"` (deferred from Phase 0).

**Done when:** a Telegram message can promote, surface in recall, be excluded, and the third-party consent question has a documented answer per content class — including the `second_party_dm` case for 1:1 DMs.

See `kb/connectors-survey.md` for the full top-5 connector skeletons (daemon path, storage path, auth secret path, consent classifier, kill switch per source) and the matrix of all surveyed sources with ToS / TCC / effort / signal columns.

## Phase 3 — more policy ops + context features

- `memory_replace` and `memory_substitute` wired in
- `memory_distill_emit_policy` wired in alongside them (was deferred from Phase 1 since its kinds depend on these agent-side tools)
- `memory_rescind_policy` extends to handle the new policy kinds without surface change
- Context features beyond embedding: entity overlap, time proximity, basic valence
- Recall function scoring uses all features
- Density flag implemented
- Damping rule implemented (engagement-gated)

**Done when:** the recall function visibly behaves differently across conversational neighborhoods, and the user can run an A/B between Phase 0's simple embedding recall and the multi-feature recall.

## Phase 3.5 — Mail.app + WhatsApp local cache + zsh history

Mail.app is the highest-volume `third_party_inferred` surface on this operator's machine; the path is `emlx` walk for backfill + IMAP IDLE direct to provider for live tail; FDA + Keychain (for IMAP creds).

WhatsApp **is hard / partially deferred.** The build-plan previously nominated `whatsmeow` / `baileys` for the live path. `kb/connectors-survey.md` rejects all three live options on phone-number-ban risk:

- `whatsapp-baileys-live` — Pure-TS reimplementation of multi-device WebSocket protocol. Red ToS risk, fragile stability, documented phone-ban risk in recurring Meta enforcement waves. **Deferred.**
- `whatsapp-web-js` — Puppeteer scrape of WhatsApp Web. Red ToS, fragile. **Rejected.**
- `whatsapp-mautrix-bridge` — Matrix homeserver dependency. **Rejected.**

The only WhatsApp path that ships in Phase 3.5 is `whatsapp-local-cache` — a read-only SQLite tail of `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite`; watch `-wal` mtime + watermarked SELECT on `ZWAMESSAGE`. FDA only, no ban risk, no reply-write capability. The "second foreign source" achievement (excise propagation across sources, privileged silent-excise channel) is exercised here, not in a `whatsmeow`-style live path.

zsh history (S effort, no permissions) joins to Screen Time via timestamp + cwd; introduces the argv-secret detection gate before promote.

- `mail-app-emlx-and-imap-idle` — emlx backfill + IMAP IDLE live tail; Envelope Index SQLite for delete tracking.
- `whatsapp-local-cache` — read-only SQLite tail, FDA only.
- `zsh-history` — `EXTENDED_HISTORY` parser + `potential_secret_in_payload` flag.
- Cross-source dedupe (same fact mentioned in two places).
- Derivation graph spans sources.
- `excise` exercised with cross-source propagation.
- Privileged channel for silent excise implemented.

**Done when:** an excise on a fact propagates correctly across Mail / WhatsApp-local / zsh / Telegram / iMessage and derived memories, and the silent-excise channel has a working privileged path with no leaked audit trail.

## Phase 4+ — EventKit, Slack, optional importers, deferred

EventKit slips here because the user's Calendar directory is empty today (re-evaluate when populated); Swift binary required for proper TCC attribution. Slack user-token connector (M effort, custom workspace app, watch the 2026-03-03 rate-limit cliff per `connectors-survey.md § Open questions`). Discord lands only as a manual data-request ZIP importer — no ToS-clean live path exists. Spotlight is repositioned from ingestion source to recall-time backend (`mdfind` the user's documents at recall, not at ingest — avoids the salience-filter flood).

Definitively deferred to later phases (re-evaluated when use-case crystallizes): Notes.app, Photos, Voice Memos, HealthKit, VS Code Local History, Gemini-CLI on-disk transcripts (Phase 2a hooks cover it), unified log.

Rejected outright (in `kb/connectors-survey.md`): `whatsapp-web-js`, `whatsapp-baileys-live` (live write path), `whatsapp-mautrix-bridge`, `discord-user-token-selfbot`, `web-claude-ai` bridging.

## Intentionally *not* in any phase yet

- Multi-user
- Multi-device sync
- Web UI
- Full-text search beyond embedding
- Backup / disaster recovery
- Sharing memories with another person

Real concerns. Scope creep until Phase 4 is solid.

## Why this order

The brutalist critique that landed hardest: putting policy ops in late phases makes the distinctive thesis untestable while early phases prove nothing more than embedding RAG. Phase 0 must include at least one policy op. Phase 3's other ops can wait, but `exclude` cannot.
