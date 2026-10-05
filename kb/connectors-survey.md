# Connectors survey

Design survey of connectors for the memory system, written before most of them were built. For the connectors that ship today and how to enable each one, see `docs/CONNECTORS.md`. Surveys seven source families (Telegram, WhatsApp, macOS comms, macOS knowledge-work, macOS passive, dev-context, agent-runtimes), evaluates each against the connector contract in `ingestion.md § Connector contract`, and recommends a re-cut of the phase ordering.

Synthesis date: 2026-06-02.

## TL;DR

As of 2026-06-02 the memory system ingests exactly one source — `chat-claude-code.jsonl` (94 events, fed by `hooks/stop-hook.sh` and `hooks/session-end-hook.sh`). `mcp/lib/tools/connectors-list.js` is a Phase 0 stub returning `{connectors: []}` and `mcp/lib/connectors/` does not yet exist. The connector contract is well-specified (six obligations: auth, cursor, idempotent append, source_policy stamping, edit/delete-as-event, health) but the build plan is materially stale on two fronts: Codex CLI and Gemini CLI now ship first-class hook systems, and iMessage + Screen Time are unexpectedly cheaper and higher-signal on this operator's actual machine than the Phase 4-nominated WhatsApp path.

Recommendation (round-20 re-sequenced per brutalist C5 — Apple-native macros + dev-context before Telegram):
- **Phase 2a — Agent-runtime hook parity**: `chat-codex`, `chat-gemini`. Pure first_party, no auth, no TCC. (R28.1 dropped the originally-scoped `chat-python-sdk` — the Anthropic Python SDK had no operator-authored callers on disk.)
- **Phase 2b — Apple-native + dev-context (shared FDA grant)**: `imessage`, `screentime-knowledgec`, `git-log-local`, `github-events`. iMessage + Screen Time share one FDA prompt; git + GitHub are S-effort zero-dep. Lower ToS risk + lower classifier complexity than Telegram; earns first cross-source recall queries quickly.
- **Phase 2c — Telegram (first non-Apple foreign source)**: heaviest classifier work; gray-ToS posture; ships after Phase 2b proves the connector boundary at lower risk.
- **Phase 3 — Mail.app + WhatsApp (local cache only) + zsh history**: WhatsApp's live paths (Baileys, whatsapp-web.js, mautrix) are REJECTED on phone-ban risk; the read-only SQLite tail under `group.net.whatsapp.WhatsApp.shared` is the only acceptable path. See § Open questions for the Baileys/mautrix tradeoff the user may want to revisit.

Discord-live (self-bot) and web-claude.ai bridging are rejected outright.

Three taxonomy gaps surfaced. `second_party_dm` is needed across iMessage / Telegram / WhatsApp / Slack / Mail.app and should ship in Phase 2 before any DM source merges. `first_party_behavioral` is OPTIONAL and deferred until ranking shows authored content being drowned by behavioral traces. An `assisted: bool` annotation may replace a fourth consent value for AI-coauthored content — flagged but not specified here.

## Current connector state

| Source | File | Events as of 2026-06-02 | Producer |
|---|---|---|---|
| chat-claude-code | `storage/sources/chat-claude-code.jsonl` | 94 | `hooks/stop-hook.sh` + `hooks/session-end-hook.sh` |

`mcp/lib/tools/connectors-list.js` returns `{connectors: []}` (Phase 0 stub). `mcp/lib/connectors/` does not exist. No foreign sources land yet.

## Sources matrix

Column legend: **ToS risk** — `clean` / `gray` / `red`. **macOS perms** — TCC grants required. **Effort** — S/M/L/XL ≈ days/weeks/months. **Signal** — 1 (low) to 5 (high). **Recommendation** — `ship_phase_2` / `ship_phase_2_5` / `ship_phase_3` / `defer` / `reject`.

| Source | Access path | ToS risk | macOS perms | Consent basis | Stability | Effort | Signal | Recommendation |
|---|---|---|---|---|---|---|---|---|
| telegram | MTProto user API via Telethon (Python); takeout for backfill, NewMessage/MessageEdited/MessageDeleted for live tail | gray | none | first_party (outbound, Saved); second_party_dm (1:1); third_party_inferred (groups, channels) | stable | M | 5 | ship_phase_2 |
| telegram-export-zip | Telegram Desktop -> Export Chat History (`result.json` + `media/`) as one-shot seed | clean | none | same as telegram live; classified at import time | stable | S | 3 | ship_phase_2 |
| whatsapp-local-cache | Read-only SQLite tail of `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite`; watch `-wal` mtime + watermarked SELECT on `ZWAMESSAGE` | clean | FDA | first_party (`ZISFROMME=1`); second_party_dm (DM inbound, `s.whatsapp.net` peer); third_party_inferred (groups `@g.us`, broadcast) | stable | S | 4 | ship_phase_3 |
| whatsapp-baileys-live | Pure-TS reimplementation of multi-device WebSocket protocol (Baileys v7.0.0-rc13) | red | none | same as whatsapp-local-cache | fragile | L | 4 | defer |
| whatsapp-web-js | Puppeteer-driven scrape of WhatsApp Web | red | none | n/a | fragile | L | 4 | reject |
| whatsapp-mautrix-bridge | mautrix-whatsapp Go bridge over whatsmeow; requires Matrix homeserver | red | none | n/a | moderate | XL | 4 | reject |
| whatsapp-export-zip | Right-click chat -> Export chat (40k msg cap / 10k with-media); one-shot importer | clean | none | same as whatsapp-local-cache; classified at import time | stable | S | 2 | reject |
| imessage | Read-only SQLite poll of `~/Library/Messages/chat.db` with WAL snapshot; `attributedBody` NSKeyedArchiver decoder for Ventura+ text | clean | FDA | first_party (`is_from_me=1`); second_party_dm (`is_from_me=0`, participant count==2); third_party_inferred (group, `cache_roomnames` non-null) | stable | S | 5 | ship_phase_2 |
| mail-app-emlx-and-imap-idle | Walk `~/Library/Mail/V*/<account>/*.mbox/.../*.emlx` for backfill + IMAP IDLE direct to provider for live tail; Envelope Index SQLite for delete tracking | clean | FDA + Keychain | first_party (user is From); second_party_dm (single non-user To, empty Cc); third_party_inferred (multi-recipient, mailing list, `Precedence: bulk`) | stable | M | 4 | ship_phase_3 |
| slack-user-token | Web API `conversations.history` / `conversations.replies` via user `xoxp-` token from custom workspace app | gray | Keychain | first_party (`user==authed_user`); second_party_dm (`channel.is_im`); third_party_inferred (`is_mpim`, `is_channel`, `is_group`) | moderate | M | 4 | defer |
| discord-bot-token | Bot API; bot can only see channels it joins with manage-messages | clean | none | n/a (captures ~0% of personal content) | stable | XL | 1 | reject |
| discord-user-token-selfbot | User token extracted from desktop localStorage (self-bot) | red | none | n/a (active enforcement March 2026) | fragile | L | 2 | reject |
| discord-data-export-import | Manual data request ZIP imported as one-shot | clean | none | first_party (authored); second_party_dm (1:1); third_party_inferred (group DM, server channels) | stable | L | 2 | defer |
| eventkit-calendar-reminders | EventKit via Swift CLI binary with NSCalendarsFullAccessUsageDescription / NSRemindersFullAccessUsageDescription Info.plist | clean | TCC-Calendar + TCC-Reminders | first_party (own); third_party_inferred (attendee names from non-organized events) | stable | S | 3 | defer |
| safari-history | Read-only SQLite poll of `~/Library/Safari/History.db` (CFAbsoluteTime, +978307200 for Unix) | clean | FDA (Sequoia tightened) | first_party (or first_party_behavioral if adopted) | stable | S | 3 | defer |
| chromium-history | Read-only SQLite of Chrome/Brave/Edge History (WebKit-time microseconds since 1601; cp to temp because Chrome holds exclusive lock when running) | clean | none (user paths) | first_party (or first_party_behavioral) | stable | S | 3 | defer |
| photos-metadata | Read `Photos.sqlite` (`ZASSET`, `ZPERSON`, `ZMOMENT`, `ZKEYWORD`); osxphotos absorbs schema drift | clean | FDA + optional NSPhotoLibrary | first_party (own photos); third_party_inferred (`ZPERSON` user-named face clusters of others, shared-album participants) | moderate | M | 3 | defer |
| voice-memos | `CloudRecordings.db` + tsrp UDTA atom extraction from `.m4a` (macOS 15+) | clean | FDA | first_party (or first_party_behavioral) | moderate | M | 2 | defer |
| notes-app | Protobuf decoder against `~/Library/Group Containers/group.com.apple.notes/` (apple_cloud_notes_parser Ruby v0.23 or apple-notes-parser Python) | clean | FDA | first_party; third_party_inferred for shared-note co-participants | fragile | L | 2 | defer |
| spotlight-metadata | `mdfind` / `mdls` over the system index; repositioned as RECALL backend not ingestion source | clean | none (user paths) | n/a (recall-time query, not ledger ingest) | stable | S | 2 | defer |
| screentime-knowledgec | Read-only SQLite poll of `~/Library/Application Support/Knowledge/knowledgeC.db` ZOBJECT; fold Focus/DND Assertions.json as enrichment | clean | FDA | first_party (or first_party_behavioral) | stable | S | 4 | ship_phase_2_5 |
| focus-dnd | `~/Library/DoNotDisturb/Assertions.json` read inside screentime-knowledgec connector (folded, not standalone) | clean | FDA (shared grant) | first_party (or first_party_behavioral) | stable | S | 2 | ship_phase_2_5 |
| zsh-history | Tail `~/.zsh_history` (EXTENDED_HISTORY format `: <ts>:<elapsed>;<cmd>`); requires argv-secret detection gate before promote | clean | none | first_party (with `potential_secret_in_payload` flag on individual events for sensitive-material gate) | stable | S | 3 | ship_phase_3 |
| unified-log | `/usr/bin/log show` + `log stream` with narrow predicate | clean | none | first_party (or first_party_behavioral) — not recommended for memory layer | moderate | M | 1 | reject |
| healthkit | HealthKit via signed Swift binary; requires Apple Developer cert + notarization | clean | HealthKit TCC | first_party (or first_party_behavioral) | stable | L | 3 | defer |
| git-log-local | Walk operator-known repo roots; `git log --pretty=format:... --all --reflog` per repo; idempotent on commit SHA | clean | Files-and-Folders only if launchd walks `~/Documents`, `~/Desktop`, `~/Downloads` on macOS 12+ | first_party (authored commits); third_party_inferred (co-authored / merged-from-others in operator-owned repos) | stable | S | 5 | ship_phase_2_5 |
| github-events | `gh api /users/<self>/events` polled daily (30-day retention since 2025-01-30); idempotent on event id | clean | none (gh in Keychain) | first_party (operator's actions); third_party_inferred (parent issues/PRs on repos owned by others) | stable | S | 4 | ship_phase_2_5 |
| vscode-local-history | Walk `~/Library/Application Support/Code/User/History/` file-hash dirs + `entries.json` | clean | none | first_party (or first_party_behavioral) | moderate | M | 2 | defer |
| chat-codex | Codex CLI hooks (SessionStart / UserPromptSubmit / Stop / SessionEnd) at `~/.codex/hooks.json`; `turn_id`-keyed stitch cache joins UserPromptSubmit prompt to Stop's `last_assistant_message` | clean | none | first_party | stable | M | 5 | ship_phase_2 |
| chat-gemini | Gemini CLI hooks (BeforeAgent / AfterAgent / SessionEnd) in `~/.gemini/settings.json`; AfterAgent payload carries both prompt and prompt_response (no stitching needed) | clean | none | first_party | stable | S | 4 | ship_phase_2 |
| vscode-claude-extension | No public API as of 2026-06-02; awaiting extension event API or `vscode.LanguageModelChat` path | clean | none | first_party (when access exists) | fragile | XL | 3 | defer |
| web-claude-ai | No first-party access; data export (batch, weeks latency), browser-extension proxy, or scraping all violate local-first thesis or ToS | red | none | n/a (rejected — behavioral solution is to move sessions to Claude Code / Codex / Python wrapper) | fragile | XL | 3 | reject |

## Recommended sequence

### Phase 2a — Agent-runtime hook parity

Sources: `chat-codex`, `chat-gemini`. (R28.1 dropped `chat-python-sdk`.)

Codex CLI and Gemini CLI now ship first-class hook systems (Stop / SessionEnd / UserPromptSubmit equivalents); `agent-integration.md`'s legacy "wrapper or cron" guidance is stale. Both runtimes are pure `first_party` with no auth, no TCC, no cursor management — the same three-hook recipe as `chat-claude-code.jsonl`. Combined effort ~2 days, zero new npm deps. Shipping these first proves the connector boundary at lowest risk and immediately doubles the chat-runtime corpus the distillation layer trains on. Codex needs a `turn_id`-keyed stitch cache (UserPromptSubmit -> Stop) because its Stop payload omits the user prompt; Gemini's AfterAgent payload is pre-stitched.

### Phase 2b — iMessage + Screen Time + dev-context (round-20 C5 re-sequenced)

Sources: `imessage`, `screentime-knowledgec`, `git-log-local`, `github-events`.

**Re-sequenced from original 2b/2.5 split.** The brutalist's "complexity-front-loading" critique (round-20 C5) lands: Telegram is the heaviest item in Phase 2 (MTProto auth, persistent client, gray-ToS posture, classifier work) and it doesn't share infrastructure with anything else here. iMessage + Screen Time share the same FDA grant (one TCC prompt for two sources) and the same SQLite-tail discipline; git + GitHub are S-effort dev-context with zero new deps. All four are clean-ToS, low-classifier-risk, high-signal. Shipping them before Telegram (a) lets the consent_basis + kill-switch + classifier-edge discipline mature against simpler sources first, (b) provides the temporal-coverage spine (Screen Time) that the recall layer's time-anchor channel needs, (c) earns the user their first cross-source recall queries quickly. Total Phase 2b effort ~5 days. The iMessage `attributedBody` NSKeyedArchiver decoder is the only real risk.

### Phase 2c — Telegram (first non-Apple foreign source)

Sources: `telegram`.

MTProto user API via Telethon (Python sibling daemon, ~500 LOC, takeout session for backfill, QR-pair login via `auth.exportLoginToken`). Highest signal per effort in its access-path family but materially heavier than Phase 2b (persistent client, gray-ToS posture, classifier work across DM/group/channel/Saved Messages). Ships after Phase 2b proves the connector boundary at lower risk. The `second_party_dm` taxonomy must be ratified in `ingestion.md` before merge (round-20 close: now committed; authorship trumps audience for outbound).

### Phase 3 — Mail.app + WhatsApp (local cache) + zsh history

Sources: `mail-app-emlx-and-imap-idle`, `whatsapp-local-cache`, `zsh-history`.

Mail.app via emlx walk + IMAP IDLE live tail (M effort, dual access path because emlx is fast-backfill and IMAP IDLE is live, FDA + Keychain) covers the highest-volume `third_party_inferred` surface. WhatsApp via the verified-readable `ChatStorage.sqlite` under `group.net.whatsapp.WhatsApp.shared` (S effort, no ban risk, FDA only — replaces the build-plan's whatsmeow/Baileys nomination which carries documented phone-number-ban risk). zsh history (S effort, no permissions) adds the developer-context payload that joins to Screen Time via timestamp + cwd. Phase 3 also introduces the sensitive-material gate that zsh history requires (argv-secret detection).

### Phase 4+ — EventKit, Slack, optional importers, deferred

Sources: `eventkit-calendar-reminders`, `slack-user-token`, `discord-data-export-import`, `spotlight-as-recall-backend`.

EventKit slips here; Swift binary required for proper TCC attribution. Slack user-token connector (M, custom workspace app, watch 2026-03-03 rate-limit cliff). Discord as a manual data-request ZIP importer only — no ToS-clean live path exists. Spotlight repositioned from ingestion source to recall-time backend (`mdfind` the user's documents at recall, not at ingest — avoids the salience-filter flood).

Definitively defer: Notes.app, Photos, Voice Memos, HealthKit (need extended use-case), VS Code Local History, Gemini-CLI on-disk transcripts (hooks cover it), unified log.

Reject: whatsapp-web.js, Baileys-live, Discord-live self-bot, web-claude.ai bridging.

## Top-5 connector skeletons

The five highest-priority connectors, with the six fields each new connector skeleton must define: source name, daemon path, storage path, auth secret path, consent classifier, kill switch.

### telegram

- **Source:** `telegram`
- **Daemon path:** `<checkout>/daemons/telegram-connector.py`
- **Storage path:** `<data root>/storage/sources/telegram.jsonl`
- **Auth secret path:** `<data root>/policy/telegram-session.json` (`0600`, gitignored; matches `distillation-signing-key.json` discipline)
- **Consent classifier:** `from_id == self_user_id` → `first_party`; peer is `User` (1:1 DM) AND `from_id != self` → `second_party_dm`; peer is `Chat` / `Channel` (group / supergroup) → `third_party_inferred`; peer is `Broadcast` channel → `third_party_inferred` + tag `broadcast`; Saved Messages (peer == self) → `first_party`
- **Kill switch:** operator runs `mcp tool memory_connector_revoke source=telegram`: (1) telethon `auth.logOut` to revoke server-side auth key; (2) shred `policy/telegram-session.json`; (3) per `source_policy.deletion_semantics`, `full_excise` `storage/sources/telegram.jsonl` and walk derivation graph for `source_refs.source==telegram` applying per-event policy; (4) drop `connectors/telegram/state.json` cursor

### chat-codex

- **Source:** `chat-codex`
- **Daemon path:** `<checkout>/hooks/codex/stop-hook.sh` + `session-end-hook.sh` + `recall-on-prompt.sh` (registered at `~/.codex/hooks.json`)
- **Storage path:** `<data root>/storage/sources/chat-codex.jsonl`
- **Auth secret path:** n/a (first-party local runtime; no auth secret — shares the watermark-daemon kill semantics; `.codex/hooks.json` registration is the only persisted policy artifact)
- **Consent classifier:** all events `first_party` (operator runs Codex against their own OpenAI key on their own machine; user text and assistant text both flow through operator-controlled runtime — same rule already applied to `chat-claude-code.jsonl`)
- **Kill switch:** remove the three hook entries from `~/.codex/hooks.json` (or `mcp tool memory_connector_revoke source=chat-codex`); truncate `storage/sources/chat-codex.jsonl`; SIGUSR1 watermark daemon; walk derivation graph for `source_refs.source==chat-codex`

### imessage

- **Source:** `imessage`
- **Daemon path:** `<checkout>/daemons/imessage-connector.js`
- **Storage path:** `<data root>/storage/sources/imessage.jsonl`
- **Auth secret path:** n/a — no credential; instead requires Full Disk Access TCC grant on the daemon binary. Document the grant in `policy/tcc-grants.md` (gitignored) so the user knows what to revoke
- **Consent classifier (round-20 edges committed per brutalist C3):**
  1. **Outbound is always first_party** (`is_from_me=1`), regardless of `cache_roomnames` — authorship trumps audience (round-20 C1 close; see `ingestion.md`).
  2. **Inbound 1:1 → second_party_dm**: `is_from_me=0` AND `cache_roomnames IS NULL` AND chat participant count == 2.
  3. **Inbound group → third_party_inferred**: `is_from_me=0` AND (`cache_roomnames IS NOT NULL` OR chat participant count > 2). Use `cache_roomnames` first because it's set as soon as the chat is a group, even if the group rename has happened mid-thread.
  4. **Business iMessage edge**: business accounts have `handle.id` formatted as `BIZ:<merchant_id>` not `+15555550101` or `email@example.com`. Treat business-account inbound as `third_party_inferred` (no consent to ingest commercial automated content) even though participant count == 2 — the conversation is bilateral by phone-line topology but the merchant did not consent to memory ingestion. Detection: regex on `handle.id` prefix or `handle.service==BusinessChat`.
  5. **Tapbacks / reactions edge**: `associated_message_type` in 2000-3007 (Love/Like/Dislike/Laugh/Emphasize/Question variants and their removals) — these are not authored content; emit them as `kind: "reaction"` with `derived_from: [associated_message_guid]`, inheriting the consent_basis of the target message. Same rule for is_from_me: the reactor's authorship still trumps audience.
  6. **cache_roomnames lifecycle**: in group chats, `cache_roomnames` can be renamed; classify on the value at message-ts (not the current value); store the historical value in the event's `room_id` field for replay.
  7. **Reply threading**: `thread_originator_guid` is non-null for in-thread replies; the reply's consent_basis is determined by ITS own `is_from_me` + room context (NOT inherited from the originator). This is correct because replies are independent authored events; threading is a rendering concern.
- **Kill switch (round-20 C4 propagation committed):** operator runs `mcp tool memory_connector_revoke source=imessage`. Steps in order:
  1. Stop the launchd daemon (`launchctl unload`).
  2. Revoke FDA via System Settings or `tccutil reset SystemPolicyAllFiles <daemon-bundle-id>`.
  3. Append a single `policy` event with `kind: "policy"`, `policy_kind: "connector_revoke"`, `target_source: "imessage"`, ts at the moment of revoke. This is the AUTHORITATIVE marker the recall layer reads.
  4. `full_excise` `storage/sources/imessage.jsonl` (delete file; the source-of-truth `chat.db` is untouched).
  5. Drop `connectors/imessage/state.json` cursor.
  6. **Single transitive-orphan recompute** (matches `kb/transitive-orphan-design.md`): the connector_revoke event acts as a new excise source whose `target_source` is matched against every memory event's `source_refs[].source` field. The recall layer's existing transitive-orphan BFS runs once over the derivation_graph from each affected memory; results are cached at process scope and busted on the policy event's mtime. NOT incremental source_refs[] subtraction — that would be 30min on a populated ledger; the single BFS is 30s.
  7. The recall layer's `applyHardGates` already respects `derivation_status=ORPHAN` per round-18 — no new pipeline code needed.

### screentime-knowledgec

- **Source:** `screentime-knowledgec`
- **Daemon path:** `<checkout>/daemons/screentime-connector.js`
- **Storage path:** `<data root>/storage/sources/screentime.jsonl`
- **Auth secret path:** n/a — no credential; requires Full Disk Access TCC grant on the daemon binary (shared grant with `imessage-connector` if same binary; otherwise separate prompt). Documented in `policy/tcc-grants.md`
- **Consent classifier:** all `ZOBJECT` rows → `first_party` (behavioral traces of the user on their own machine; Focus/DND assertions folded in as enrichment column, also `first_party`). Optionally tag `first_party_behavioral` if the taxonomy adopts that distinction.
- **Kill switch:** operator runs `mcp tool memory_connector_revoke source=screentime-knowledgec`: (1) stop the launchd daemon; (2) revoke FDA via `tccutil` if no other connector shares the binary; (3) `full_excise` `storage/sources/screentime.jsonl`; (4) walk derivation graph for `source_refs.source==screentime-knowledgec`; (5) drop `connectors/screentime/state.json`. `knowledgeC.db` self-rolls in ~4 weeks upstream.

## Consent taxonomy extensions

`ingestion.md § Consent-aware promotion` currently enumerates three values: `first_party`, `third_party_inferred`, `third_party_explicit`. This survey surfaces two additions — one load-bearing, one optional.

### `second_party_dm` (load-bearing — needed in Phase 2)

A 1:1 direct message where the non-operator party is a single identifiable person who has not given explicit consent to memory ingestion, but where the channel itself is unambiguously bilateral (no third audience). Sits between `first_party` (operator authored) and `third_party_inferred` (group / broadcast where multiple non-consenting parties exist).

Default promotion rules:
- Retention parity with `first_party`.
- Verbatim quoting suppressed by default in promoted memories (subject to recall-time policy override).
- Identifiable for excise / notification flows so the user can honor a counterparty deletion request cleanly.
- No special highlighting in surfaced context.

Ranking dampener: TBD by operator; recommendation is no dampener (parity with `first_party`) since the user was an active participant, with the verbatim-quoting suppression carrying the consent posture instead. Contrast with `third_party_inferred` which carries a 0.6 ranking dampener in current ingestion semantics.

Examples: iMessage 1:1 thread (chat participant count == 2, `is_from_me=0`); Telegram 1:1 DM inbound from a `User` peer; WhatsApp DM (`ZTOJID` matching `s.whatsapp.net`, `ZISFROMME=0`); Slack IM (`channel.is_im == true`), inbound side; Mail.app message with single non-user `To` and empty `Cc`.

### `first_party_behavioral` (OPTIONAL — defer)

OPTIONAL refinement of `first_party` for behavioral / usage traces (not authored content). Same consent posture as `first_party` (the user is the sole subject) but lets ranking and rendering distinguish "I wrote this" from "this is a trace of what I did." Not load-bearing — connectors can emit plain `first_party` if the taxonomy is kept three-valued — but useful as a ranking-time knob for Screen Time, zsh history, browser history, and any future macOS passive source.

Recommendation: introduce only if Phase 2.5 / Phase 3 ranking shows authored content drowning in behavioral traces; otherwise defer. Premature taxonomy growth has a real cost in distillation policy complexity.

Examples: Screen Time `ZOBJECT` app-usage interval; Focus/DND assertion transition; zsh `extended_history` entry; Safari / Chromium visit row; Spotlight modification event (if ever ingested); HealthKit sample (Phase 6+).

## Open questions

The user-facing decisions this survey leaves unresolved:

1. **Telegram daemon language.** Does the user accept Python as a second daemon language for the Telegram connector (Telethon), or insist on Node-only (GramJS) despite weaker maintenance and 289 open issues? The JSONL boundary makes process-language irrelevant downstream, but multi-language operations adds a launchd recipe.
2. **Telegram ban-flag risk.** Does the user accept the operational ban-flag risk for Telegram MTProto user clients (24h soft-bans documented on flagged accounts) and commit to emailing `recover@telegram.org` from the connector phone number before first login as a pre-install step in `operations.md`?
3. **WhatsApp scope — read-only vs live-write (operator-facing tradeoff per round-20 brutalist C6).** Two distinct postures:
   - **Read-only local cache (Phase 3 candidate; recommended)**: tail `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite`. S effort, FDA-only, no phone-ban risk, no ToS issue (reading your own device's local cache is unambiguously fine). Captures all received + sent messages with full body + metadata. Cannot send replies; cannot trigger live notifications; on macOS the WhatsApp.app must have run at least once so the cache is populated.
   - **Live-write via Baileys (REJECTED current default; reconsider if reply-capability is load-bearing)**: pure-TS Web protocol reimplementation. Captures the same content as read-only PLUS lets the system send replies, mark-as-read, etc. ToS risk: Meta has banned phone numbers in waves (most recently early 2026 per Baileys GitHub issues). The ban is on the WhatsApp account, not the device — the phone number stops working for WhatsApp entirely, which is materially worse than the connector failing. Baileys also breaks ~quarterly when WhatsApp updates the web client. Operator decision: is reply-capability worth the ban risk and the maintenance churn?
   - **Mautrix bridge (REJECTED)**: same Baileys-class ban risk + requires running a Matrix homeserver. XL effort. The bridge is well-engineered for matrix-native users; for a single-user memory-system it adds infrastructure (homeserver) the system doesn't otherwise need.
4. **`second_party_dm` timing.** Should it ship in Phase 2 (because Telegram + iMessage both need it) or wait? Shipping in 2 forces an `ingestion.md` edit, distillation policy update, and a back-migration plan for any `chat-claude-code.jsonl` events the user wants reclassified.
5. **`first_party_behavioral` timing.** Introduce now (with Screen Time + zsh) or defer until ranking shows authored content being drowned out? Premature taxonomy growth has a real cost in distillation policy complexity.
6. **Slack rate-limit cliff (2026-03-03).** A "custom app in the user's own workspace" is asserted to remain internal-rate-limited, but no written confirmation from Slack legal has been obtained. Should the connector be scoped to one specific workspace per install, or is a multi-workspace OAuth flow acceptable risk?
7. **Shared TCC binary.** iMessage + Screen Time both need Full Disk Access. Should they share a single launchd binary (one TCC prompt, shared connector code) or run as two independent processes per the `ingestion.md` "each connector is its own process" mandate? The mandate exists for crash-isolation; sharing a binary breaks it but halves the user's install friction.
8. **Codex Stop-hook stitching.** Codex's Stop hook carries only `last_assistant_message`, not the user prompt. Is the proposed `turn_id`-keyed stitch cache with `CODEX_TURN_STITCH_TTL_SECONDS=300` GC acceptable, or should `chat-codex.jsonl` emit half-records (user-only or assistant-only) and let the distillation layer reconcile? The latter is simpler but breaks the architectural invariant that one source-ledger row == one full turn.
9. **Gemini hook surface re-verification (round-20 brutalist C9).** ~~The Gemini integration brief verified hook names against a third-party doc site...~~ SUPERSEDED by R28.1: the Gemini CLI connector was removed end-to-end (operator scope correction; only Claude Code + Codex remain as agent-runtime sources). Item retained for historical record; no action.
10. **Notes.app maintenance burden (round-20 brutalist C8).** The Notes row's `L` effort is for INITIAL build only. NoteStore.sqlite's protobuf schema drifts ~1-2x per major macOS release; cloud-sync vs local-only handling adds branches; apple_cloud_notes_parser maintenance has been intermittent. Realistic perpetual cost: ~3-5 days per macOS major release. The `defer` recommendation stands but if Phase 3+ revisits, plan a maintenance budget — not just the initial build.
11. **Browser FDA divergence (round-20 brutalist C7 footnote).** Safari (`~/Library/Safari/History.db`) requires FDA on Sequoia+ because the Library/Safari subdir is Apple-managed; Chromium-family browsers (`~/Library/Application Support/Google/Chrome/Default/History`) do NOT require FDA because Application Support is user-owned. The matrix correctly differs by source. If both browsers ship as separate connectors, the user-visible install flow differs: Safari prompts once for FDA; Chromium installs silently. Document in `operations.md` install runbook.
