# Ingestion

How raw events from connected sources reach the memory ledger. The KB principles — provenance, source policy, append-only, mediated writes — bind tightly to this layer because the connectors are the highest-privilege components in the system. They hold credentials and see all raw content.

## Pipeline (canonical order)

```
external app
    → connector (daemon, per source)
        → source ledger (append-only JSONL)
            → sensitive-material gate
                → salience filter
                    → memory ledger
                        ↑
                    recall, policy ops
```

Each arrow is async. Each stage is the only writer of its output. No stage decides what the next stage cares about. The connector does not classify salience; the gate does not promote; the salience filter does not authenticate.

## Per-source mechanisms

| Source | Protocol | Liveness | Auth shape | Realistic library |
|---|---|---|---|---|
| Telegram | MTProto user API | Updates long-poll with pts/qts state | One-time login + 2FA, session file | telethon (py), gramjs (node) |
| WhatsApp | Reverse-engineered multi-device | Persistent socket | QR pairing once, session persisted | whatsmeow (go), baileys (node). Expect periodic breakage. |
| Email | IMAP IDLE or Gmail API + Pub/Sub | Server push | OAuth (Gmail) or app password (IMAP) | go-imap, imap-tools (py), gmail-api-go |
| iMessage / SMS | macOS local `chat.db` SQLite | File watcher + WAL tail | None — local FS | direct SQLite reads |
| Calendar | CalDAV or Google Calendar API | Polling (15 min typical) | OAuth | caldav, gcal API |

Each connector is its own process. Reasons for isolation: credential blast radius differs per source; ToS-fragility differs per source (especially WhatsApp); one crash must not stall the others.

### Agent-runtime sources

Agentic CLIs the user runs and SDKs write per-session JSONL logs under `$HOME`. These are tailed by file-watch connectors (no protocol, no auth) and produce normalized `{user_text, assistant_text}` turn pairs.

| Source | Default path | Pairing | Classifier default |
|---|---|---|---|
| codex-cli | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<uuid>.jsonl` | Pair `response_item` rows by walking `role:"user"` → next `role:"assistant"`; `source_msg_id = codex:<session_uuid>:<turn_index>`. Developer-role rows go to `raw_content.system_prompt_hash` only. | `first_party` |

The codex-cli connector is launchd-managed (`com.user.memory-system.codex-cli-connector`), no FDA, capture-only (no embedding at connector tier — Stage-0 + cascade run downstream). The user can override `consent_basis` via env var when tailing a shared session. (Two other agent-runtime connectors were retired so the system covers Claude Code + Codex only; see `kb/legacy-archive.md` for the retired source names. Claude Code captures land in `storage/sources/chat-claude-code.jsonl` via the `Stop` hook (`hooks/stop-hook.sh`), not via an agent-runtime connector.)

## Three timescales of up-to-date

**Live (seconds).** Subscription, IDLE, or long-poll where the protocol supports it. New message → source ledger within seconds → gate → salience → memory ledger. Next recall sees it.

**Catch-up (minutes–hours).** Daemon restart or transient outage. Pulls from cursor (last-ingested `source_msg_id` or timestamp per chat/folder), rate-limited, in-order. Live tail resumes when caught up.

**Backfill (hours–days).** First-connection historical pull. Years of history. Paginated, throttled (Gmail: ~50 reads/sec under quota; Telegram: respect FLOOD_WAIT). Runs in background; does not block live ingestion of *new* messages from the same source. Backfill events carry `backfill: true`; the salience filter applies a stricter promotion threshold to historical content so we do not promote a million ten-year-old messages on day one.

## Connector contract

Each connector does exactly six things:

1. **Authenticate** and maintain its session.
2. **Maintain a cursor** per chat/folder (last-ingested `source_msg_id` or timestamp).
3. **Append to its source ledger** at `storage/sources/<source>.jsonl` with idempotent writes keyed by `source_msg_id`. Multiple ingestion attempts of the same message converge.
4. **Attach source_policy** per event:
   ```
   { deletion_semantics, consent_basis }
   ```
5. **Emit edit and delete from source as new source-ledger events** (`message_edited`, `message_deleted`) — never mutate prior entries. Source ledger is append-only at this layer too.
6. **Expose a health endpoint** for the supervisor.

What the connector deliberately does *not* do: classify salience, detect sensitive material, deduplicate across sources, render content. Those concerns belong to downstream stages.

**Local MCP as protocol library.** A locally-running MCP that wraps a source's protocol cleanly (e.g., a local Telegram MCP, a local IMAP MCP) may sit underneath a connector as a protocol library. The connector remains the architectural unit and continues to satisfy the six-point contract above; it delegates wire-level operations to the local MCP. Hosted MCPs (e.g., claude.ai-hosted Gmail) are out of scope — they route raw content through a third party, inverting the local-first commitment. See `architecture.md` § Interface boundaries.

## State and credentials

- Per-source connector state at `connectors/<source>/state.json`: cursors, session metadata, last-ingested timestamps. Distinct from any of the ledgers; this is operational state, not memory.
- Credentials in the OS keychain (macOS Keychain Access, libsecret on Linux). Never flat-file. Never in source ledgers or memory ledgers.
- A connector with revoked or expired auth pauses, quarantines pending writes as `auth_pending`, surfaces a notification — does not silently fail.

## Source policy as the deletion contract

`source_policy.deletion_semantics`, declared at ingest, binds the system at excise time. When the user excises memory M, the system walks `source_refs[]` and applies each referenced source's policy:

- `tombstone_only` → source ledger entry marked tombstoned-from-re-promotion; remains on disk
- `full_excise` → source ledger entry deleted; quarantine entries deleted; cached attachments deleted
- `follows_upstream` → defer to whether the source app itself reports a delete

This is the only path by which the append-only source ledger is mutated. It requires the privileged excise channel (see `operations.md`).

## Edit and delete from source as policy-event triggers

Upstream edits and deletes are events, not mutations. Pipeline:

1. Source app reports edit/delete.
2. Connector appends `message_edited` or `message_deleted` to source ledger, referencing original `source_msg_id`. The source-ledger row is append-only; nothing prior is mutated.
3. Salience filter sees the edit/delete event and checks whether the original source event was previously promoted.
4. If yes, the response depends on which:
   - **Edit** — if the change is substantive, the cascade tick observing the edit event would emit `memory_distill_emit_policy` with `kind: "substitute"` (planned, not implemented). The derived memory's content updates under reframe provenance.
   - **Delete** — *no* policy event is emitted. The derived memory remains alive; its provenance points at a source-ledger entry now flagged as tombstoned. The upstream party deleted *their copy*; the user's *memory of having read it* is a separate fact that only the user gets to forget — explicitly, via `memory_excise`.

The "delete → exclude" path was considered and rejected — it would have required the cascade to synthesize a predicate against the deleted source, which means hand-crafting an `embedding` without a live `recall_id`. That reopens exactly the attack surface the agent-side `memory_exclude` spec is rewritten to close. The integrity guarantee survives only if the cascade has no exclude path; see `mcp-surface.md` § memory_distill_emit_policy.

The original promoted memory and the source's edit/delete history both stay in their respective ledgers under audit. Upstream activity informs but does not silently destroy.

## Cross-source dedupe at salience

Connectors never coordinate. If the same fact appears in Telegram and email, both raw events land in their respective source ledgers. The salience filter at promotion-time queries the memory ledger for near-duplicates:

- **Found, high confidence** — emit a `corroboration` policy event linking the new source ref to the existing memory id. The projection joins via that policy event; the prior memory row is *not* mutated. Append-only stays inviolate.
- **Found, ambiguous** — promote separately but link via `derived_from[]` so the derivation graph can surface the relationship later.
- **Not found** — promote normally.

A memory's effective `source_refs[]` grows over time via accumulated corroboration events, computed by joining the original promotion event with every subsequent corroboration. The growing list lives in the projection / index, never as in-place mutation of the original row. Excise walks the full corroboration set and applies each referenced source's deletion policy.

## Consent-aware promotion

Source policy shapes promotion, not just deletion. The salience filter applies caps and surface restrictions based on `consent_basis`:

- `first_party` — full promotion eligible
- `second_party_dm` — 1:1 direct message where the non-operator party is a single identifiable person who has not given explicit consent to memory ingestion, but where the channel itself is unambiguously bilateral (no third audience). Sits between `first_party` (operator authored) and `third_party_inferred` (group / broadcast where multiple non-consenting parties exist). Retention parity with `first_party`; verbatim quoting suppressed by default in promoted memories (subject to recall-time policy override); identifiable for excise / notification flows so the user can honor a counterparty deletion request cleanly. Default ranking dampener: none (parity with `first_party`) — the verbatim-quoting suppression carries the consent posture instead of a ranking dampener. Contrast with `third_party_inferred`'s 0.6 dampener (see `kb/connectors-survey.md § Consent taxonomy extensions`).
- `third_party_inferred` — promote with reduced recall ranking weight (0.6 dampener); never quote verbatim in recall briefs; default retention cap (configurable) unless the user explicitly pins
- `third_party_explicit` — promote normally but tag for "this party has agreed to be remembered"

OPTIONAL refinement (deferred — introduce only if ranking shows authored content drowning in behavioral traces; see `kb/connectors-survey.md § Consent taxonomy extensions`):

- `first_party_behavioral` — same consent posture as `first_party` (the user is the sole subject) but lets ranking and rendering distinguish "I wrote this" from "this is a trace of what I did." Used for Screen Time `ZOBJECT` rows, zsh `extended_history` entries, Safari / Chromium visit rows, and similar passive behavioral signals. Not load-bearing — connectors can emit plain `first_party` if the taxonomy is kept three-valued.

Source -> consent classification examples:

**Outbound (authored by the user) → always `first_party` regardless of audience.** The "authorship trumps audience" rule is committed. Content the user authored is `first_party` even when the channel has multiple non-consenting recipients; the channel context lives in `parties[]` / `room_id` / `participants[]` as provenance, not in the consent class. Rationale: `consent_basis` classifies the AUTHOR/CHANNEL's consent to ingest; surfacing-time decisions about whose-name-to-mention are a separate rendering concern handled by the recall layer. Implication: the user's group-chat messages get the full `first_party` dampener (1.0) and rank as engineered features intend.

- iMessage outbound in any thread (`is_from_me=1`) → `first_party`
- iMessage 1:1 thread (`is_from_me=0`, chat participant count == 2, `cache_roomnames IS NULL`) → `second_party_dm`
- Telegram outbound (Saved Messages OR any peer) → `first_party`
- Telegram 1:1 DM inbound from a `User` peer → `second_party_dm`
- WhatsApp outbound (`ZISFROMME=1`) → `first_party`
- WhatsApp DM (`ZTOJID` matching `s.whatsapp.net`, `ZISFROMME=0`) → `second_party_dm`
- Slack outbound (`user == authed_user`) → `first_party`
- Slack IM (`channel.is_im == true`), inbound side → `second_party_dm`
- Mail.app sent (operator address in `From`) → `first_party`
- Mail.app message with single non-user `To` and empty `Cc` → `second_party_dm`
- Telegram group/supergroup INBOUND, WhatsApp group `@g.us` INBOUND, Slack `is_channel`/`is_group`/`is_mpim` INBOUND, Mail.app multi-recipient INBOUND → `third_party_inferred`

The salience filter, not the connector, is where these decisions land. The connector's job is to faithfully record what `consent_basis` it could infer at ingest time.

**`consent_basis` is about consent to ingestion, not about authorship.** A user consenting to a chat ledger being ingested makes the entire ledger `first_party`, even though each event also records its speaker (user or assistant) separately in `parties[]`. How to weight assistant turns vs. user turns in recall is a separate concern handled by the recall function's scoring (`operations.md` § Scoring), not by `consent_basis`. This is why design-of-the-system transcripts (`agent-integration.md` § Transcript backfill) are `first_party` despite mixing user and assistant turns — the user consents to the whole conversation being remembered; the speaker dimension is provenance, captured separately.

## Failure modes

- **Connector dies** — supervisor restarts; cursor recovers; catch-up runs.
- **Source API outage** — exponential backoff with jitter; surface a notification after configured threshold.
- **Auth revoked or expired** — pause, quarantine pending writes as `auth_pending`, notify user.
- **WhatsApp protocol break** — expected periodically. Connector flags itself unhealthy; supervisor surfaces; library update required. Other sources unaffected.
- **Disk write torn during append** — source ledger uses fsync per batch + checksum per line; corrupt tail detected and truncated on next start.
- **Cursor drift (connector loses state)** — rebuild cursor by querying the source for "messages since last `source_msg_id` we have on file." The source is the canonical state of itself; the connector is a mirror.

## Deliberately deferred

Not in scope at this layer until later phases force them:

- **Entity resolution across sources** — same person across phone, Telegram, email. Not implemented.
- **Multi-device sync of the connectors themselves** — multiple machines running parallel connectors. Single-machine for now.
- **Outbound** — writing back to the source app (scheduling replies, deleting upstream from the system). Read-only for now.
- **Voice / audio sources** — voice memos, recordings, calls. Different ingestion shape; not part of this design.
- **File-system sources beyond iMessage** — notes apps, docs, browser history. Possible later; out of scope for the connector contract above.
