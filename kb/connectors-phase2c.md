# R38 Phase 2c — Telegram + Slack connector contracts

Authoritative shape contracts for the two source-tier connectors that land
in Phase 2c: Telegram (MTProto via Telethon Python helper + Node tail) and
Slack (Web API user OAuth polling). These canonical blocks are consumed by
the connector implementations + tests; do NOT edit the inside of a block
without (1) updating its consumers and (2) updating the matching `sha256`
entry in `mcp/policy/canonical-allowlist.json` and the
`canonical-allowlist.sha256.sentinel` (B13).

## Telegram

### Architecture

Two-process design:

1. `mcp/lib/connectors/telegram/telegram_tail.py` (Python 3 + Telethon)
   - Owns the MTProto subscription. KeepAlive launchd daemon.
   - Reads its session string from `~/.config/memory-system/telegram.session`
     (0600) — created once by `telegram_login.py`. Optionally from
     `TELEGRAM_SESSION_STRING` env. Refuses to start if missing.
   - Emits one JSONL line per `NewMessage` event to
     `<MEMORY_ROOT>/storage/tmp/telegram-staging.jsonl` (env-overridable via
     `TELEGRAM_STAGING_FILE`).

2. `mcp/lib/connectors/telegram.js` (Node, ConnectorBase subclass)
   - Tails the staging file using a byte-offset cursor stored in
     `connectors/telegram/state.json` (`staging_offset` key).
   - Normalises each event into the canonical source-row shape below,
     runs Stage-0 hard-drops, and appends to
     `storage/sources/telegram.jsonl`.

### Per-kind consent map

| `peer_type`  | direction      | `consent_basis`           |
|--------------|----------------|---------------------------|
| `user`       | any (1:1 DM)   | `first_party`             |
| `group`      | operator-sent  | `first_party`             |
| `group`      | other          | `third_party_inferred`    |
| `supergroup` | operator-sent  | `first_party`             |
| `supergroup` | other          | `third_party_inferred`    |
| `channel`    | any (broadcast)| `public_observation`      |

### Stage-0 hard-drops

| Rule                              | Reason                            |
|-----------------------------------|-----------------------------------|
| sender_name ends `/bot$/i`        | `bot_message`                     |
| `fwd_from.kind == "bot"`          | `bot_forward`                     |
| `0 < ttl_seconds < 86400`         | `ephemeral_short_ttl`             |
| `media_type` in {voice,video_note} AND text empty | `voice_video_metadata_only` |
| `media_type` in {sticker,animation} AND text empty | `sticker_only` |

### Canonical row shape

<!-- BEGIN-CANONICAL: telegram_row_shape -->
{
  "id": "ulid_<24chars>",
  "ts": "<ISO-8601 UTC>",
  "source": "telegram",
  "source_msg_id": "tg_<sha256(peer_id+:+message_id)[:32]>",
  "parties": ["<sender_name>", "<peer_name?>"],
  "raw_content": {
    "peer_type": "user|group|supergroup|channel",
    "peer_id": "<int>",
    "peer_name": "<str|null>",
    "message_id": "<int>",
    "sender_id": "<int|null>",
    "sender_name": "<str|null>",
    "is_outgoing": "<bool>",
    "is_self": "<bool>",
    "text": "<str>",
    "media_type": "<str|null>",
    "fwd_from": "<{kind,id}|null>",
    "reply_to": "<int|null>",
    "ttl_seconds": "<int|null>"
  },
  "attachments": [],
  "source_policy": {
    "deletion_semantics": "full_excise",
    "consent_basis": "first_party|third_party_inferred|public_observation"
  },
  "content": "<text>",
  "checksum": "<blake2b512-trunc-16-hex>"
}
<!-- END-CANONICAL: telegram_row_shape -->

### Operator one-time auth

1. `pip install --user telethon`
2. Create app at https://my.telegram.org -> "API development tools".
3. `export TELEGRAM_API_ID=... TELEGRAM_API_HASH=...`
4. `python3 mcp/lib/connectors/telegram/telegram_login.py`
   - Prompts for phone + SMS code + optional 2FA password.
   - Writes session at `~/.config/memory-system/telegram.session` (0600).
5. Add `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` to `~/.config/memory-system/.env` (0600).
6. `launchctl load ~/Library/LaunchAgents/com.user.memory-system.telegram-connector.plist`

## Slack

### Architecture

Single-process Node design (no Python helper, no MTProto):

- `mcp/lib/connectors/slack.js` (Node, `ConnectorBase` subclass) polls
  `slack.com` via the Web API using a per-workspace user OAuth token
  (`xoxp-*`). One token per workspace; tokens are passed via env
  (`SLACK_USER_TOKEN` global default, or
  `SLACK_USER_TOKEN_<workspace_id>` per workspace).
- Discovery: `conversations.list` enumerates every channel/DM the user
  participates in (`types=public_channel,private_channel,mpim,im`).
- History: per channel, `conversations.history` is walked with the
  `oldest` parameter set to the per-channel `last_ts` cursor (stored at
  `storage/sources/slack-cursors/<workspace_id>/<channel_id>.json`).
- Polling cadence: `SLACK_POLL_INTERVAL_SECONDS` (default 600s; matches
  the launchd `StartInterval`).
- Rate-limit handling: 429 responses respect the `Retry-After` header and
  back off exponentially up to a 5-minute cap per tick; beyond that the
  pollOnce returns and the next `StartInterval` retries.

### Per-kind consent map

| `channel_kind`     | author     | `consent_basis`        |
|--------------------|------------|------------------------|
| `im` (1:1 DM)      | any        | `first_party`          |
| `mpim`             | self       | `first_party`          |
| `mpim`             | other      | `third_party_inferred` |
| `private_channel`  | self       | `first_party`          |
| `private_channel`  | other      | `third_party_inferred` |
| `public_channel`   | self       | `first_party`          |
| `public_channel`   | other      | `public_observation`   |

The user's `user_id` per workspace is resolved once via `auth.test` at
daemon start and cached for the process lifetime.

### Stage-0 hard-drops

| Rule                                                | Reason                    |
|-----------------------------------------------------|---------------------------|
| `raw_content.is_bot === true` OR subtype `bot_message` | `bot_message`          |
| subtype in `channel_join`/`channel_leave`/`channel_topic`/`channel_purpose`/`channel_name`/`channel_archive`/`channel_unarchive` (and `group_*` variants) | `channel_lifecycle` |
| subtype `thread_broadcast` AND empty text          | `thread_broadcast_empty`  |
| subtype `file_share` AND empty text                | `file_share_no_text`      |
| empty text AND `has_files === false`               | `empty_message`           |

### Canonical row shape

<!-- BEGIN-CANONICAL: slack_row_shape -->
{
  "id": "ulid_<24chars>",
  "ts": "<ISO-8601 UTC>",
  "source": "slack",
  "source_msg_id": "slack:<workspace_id>:<channel_id>:<slack_ts>",
  "parties": ["self|<user_id>"],
  "raw_content": {
    "workspace_id": "<str>",
    "channel_id": "<str>",
    "channel_kind": "im|mpim|private_channel|public_channel",
    "ts": "<slack-ts seconds.microseconds>",
    "user": "<user_id|null>",
    "subtype": "<str|null>",
    "text": "<str>",
    "is_bot": "<bool>",
    "has_files": "<bool>",
    "thread_ts": "<slack-ts|absent>",
    "consent_classification": "first_party|third_party_inferred|public_observation"
  },
  "attachments": [],
  "source_policy": {
    "deletion_semantics": "full_excise",
    "consent_basis": "first_party|third_party_inferred|public_observation"
  },
  "content": "<text>",
  "checksum": "<blake2b512-trunc-16-hex>"
}
<!-- END-CANONICAL: slack_row_shape -->

### Operator one-time auth

1. https://api.slack.com/apps -> "Create New App" -> "From scratch".
2. Add user-token OAuth scopes: `channels:history`, `groups:history`,
   `im:history`, `mpim:history`, `users:read`.
3. Install the app to every workspace the user wants captured; copy
   the `xoxp-*` user OAuth token for each workspace.
4. Add to `~/.config/memory-system/.env` (0600):
   - `SLACK_WORKSPACE_IDS=T01ABC,T02DEF` (comma-separated workspace IDs)
   - `SLACK_USER_TOKEN_T01ABC=xoxp-...` (one per workspace) OR
     `SLACK_USER_TOKEN=xoxp-...` (single-workspace default)
5. `launchctl load ~/Library/LaunchAgents/com.user.memory-system.slack-connector.plist`
