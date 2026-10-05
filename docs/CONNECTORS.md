# Connectors

A connector reads one source of your own activity and appends what it finds to
the store. Every connector is optional and none is installed by
`bash scripts/install.sh`, in any mode: you render and load each one yourself.
The core (put and recall) works with no connector at all.

In this page `<checkout>` is your clone and `<data root>` is where your data
lives (the checkout, unless you set `MEMORY_ROOT`; services always use the
checkout, see [INSTALL.md](../INSTALL.md)).

## How a connector works

1. The connector appends one row per event (a message, a commit, a turn) to
   `<data root>/storage/sources/<source>.jsonl` and keeps its position in
   `<data root>/connectors/<source>/state.json`. Rows are plain JSON text.
2. The `watermark` core service reads those source ledgers, filters them, and
   writes memories to `<data root>/ledgers/memory.jsonl`. Without `watermark`
   running, a connector only fills its source ledger and nothing it captured
   is recalled.
3. `memory_recall` can then return that content to any agent connected to the
   server.

So the privacy question for each connector is the same: whatever it reads
ends up as readable text on your disk, and can be surfaced to the agent you
use and, through it, to that agent's model provider. Read the risk line of a
connector before enabling it. Most of what these connectors read was written
by other people who did not agree to it being indexed.

## Enabling, testing and disabling

Enable a connector by rendering its service file and loading it, from the
checkout:

```bash
node scripts/render-launchd.mjs --root "$PWD" --home "$HOME" \
  --out "$PWD/launchd/rendered" --node "$(command -v node)" \
  --only <service> --install
```

Leave out `--install` to only write the file and read it first. `<service>` is
the name given in each section below. The schedule, program and log file of
every service are in [launchd/README.md](../launchd/README.md).

Most connector modules can be run by hand before you install anything:

```bash
node mcp/lib/connectors/<module>.js --check   # see below: a real probe only for whatsapp
node mcp/lib/connectors/<module>.js --once    # one pass, then exit
```

What `--check` does depends on the module:

- `whatsapp.js` is the only real probe: it opens the WhatsApp database
  read-only and runs one query. It prints `ok` and exits 0, or prints
  `check_failed: <reason>` and exits 1 (for example when the database is
  missing or Full Disk Access is denied).
- `imessage.js` and `mail.js` print `ok` and exit 0 without touching their
  source, so a pass there proves nothing about permissions.
- `git-log-local.js`, `github-events.js`, `slack.js`, `telegram.js`,
  `codex-cli.js` and `screentime.js` print the health saved by their last run
  (from the connector's cursor file) as one line of JSON and exit 0. They do
  not contact their source; on a fresh install the status is `ok` with no
  timestamps.
- `daemons/screentime-connector.js`, the service entry point, takes no
  arguments: it ignores `--check` and starts its polling loop.

`--once` really ingests: it appends to the source ledger under your data root.

Disable a connector:

```bash
launchctl bootout "gui/$(id -u)/com.user.memory-system.<service>"
rm ~/Library/LaunchAgents/com.user.memory-system.<service>.plist
```

That stops capture and keeps what was already captured. To also stop that
content from being recalled, call the `memory_connectors_revoke` tool with the
source name (its only argument, `source`): it hides every memory derived from
that source. There is no tool to undo a revoke. `memory_connectors_list` shows
the state of each source. Both tools are described in
[kb/mcp-surface.md](../kb/mcp-surface.md).

The tool never deletes the raw rows. To delete them, stop the connector first
(above), then remove its source ledger by hand:

```bash
rm "<data root>/storage/sources/<source>.jsonl"
```

`<source>` is the source name given in each section below (for example
`imessage` or `git-log`). Deleting the ledger does not reset the connector's
saved read position in `<data root>/connectors/<source>/state.json`, so a
connector you enable again does not necessarily re-read what you deleted.

Connectors that need Full Disk Access need it for the exact `node` binary
named in the rendered service file: System Settings, Privacy and Security,
Full Disk Access, add that binary, then load the service again. The grant
covers every connector run by that binary, and anything else that binary
runs.

Your operator identity file (`<data root>/config/operator-identity.json`)
tells connectors which addresses, handles and logins are you. Fill it in
before enabling a connector, or nothing is attributed to you.

## Claude Code sessions (hooks)

- **Source name:** `chat-claude-code`. Not a service: it is the Stop hook
  `hooks/stop-hook.sh`, which Claude Code runs after each turn.
- **Reads:** the hook payload and the session transcript file Claude Code
  names in it.
- **Needs:** `jq` and `node` on `PATH`. No macOS permission, no credential.
- **Enable and disable:** add or remove the hook entry in your Claude Code
  user settings; see
  [hooks/registration-recommendation.md](../hooks/registration-recommendation.md).
- **Stores:** one row per turn with the text of your prompt and the
  assistant's reply, the conversation id and the working directory. Strings
  shaped like API keys are redacted before the row is written; that is a
  pattern match, not a guarantee.
- **Risk:** everything you type to the agent and everything it answers is
  kept, including code, file contents and any secret the redaction misses.

## Codex CLI sessions

- **Service:** `codex-cli-connector`. Module `mcp/lib/connectors/codex-cli.js`.
  Source name `codex-cli`.
- **Reads:** the session files the Codex CLI writes under `~/.codex/sessions`.
- **Needs:** nothing. The files are in your home directory.
- **Stores:** one row per paired user and assistant turn, with the text of
  both.
- **Risk:** the same as Claude Code sessions: prompts, replies, code and
  anything pasted into a session.

## Local git history

- **Service:** `git-log-connector`. Module
  `mcp/lib/connectors/git-log-local.js`. Source name `git-log`.
- **Reads:** runs `git log` in every repository it finds, three levels deep,
  under a list of roots. With `GIT_LOG_REPO_ROOTS` unset there are five:
  the `Documents`, `projects` and `code` directories under your home
  directory, the checkout, and your home directory itself. Set
  `GIT_LOG_REPO_ROOTS` (colon-separated absolute paths) to replace that list.
- **Needs:** `git`. No permission is granted up front, but two of the default
  roots, `Documents` and the home directory itself, are folders macOS
  protects: when the connector runs as a launchd service, macOS may ask for,
  or silently deny, access to them, and repositories there are then skipped.
  Set `GIT_LOG_REPO_ROOTS` to avoid them. `GIT_LOG_OPERATOR_EMAILS` in `secrets.env`
  (colon-separated) adds author addresses that count as you, on top of the
  identity file.
- **Stores:** one row per commit: hash, author name and address, date, the
  commit message, repository path, and the changed file paths with line counts. At most 500 commits per
  repository on the first run. It does not store file contents or diffs.
- **Risk:** commit authors' names and e-mail addresses from every repository
  you have cloned, not only your own, and the paths of your repositories.

## GitHub events

- **Service:** `github-events-connector`. Module
  `mcp/lib/connectors/github-events.js`. Source name `github-events`.
- **Reads:** your own event feed, by running `gh api` for your user once a day.
  This is a network call to GitHub.
- **Needs:** the `gh` CLI installed, logged in (`gh auth login`) and on the
  service's `PATH`. The connector holds no credential of its own.
- **Stores:** one row per event (pushes, issues, pull requests, comments and so
  on) with a summary of it: the repository, your login, the time and what the
  event was about.
- **Risk:** summaries of events on other people's repositories can include
  text those people wrote. It uses whatever access your `gh` login has.

## Messages (iMessage and SMS)

- **Service:** `imessage-connector`. Module `mcp/lib/connectors/imessage.js`.
  Source name `imessage`.
- **Reads:** `~/Library/Messages/chat.db`, opened read-only.
- **Needs:** Full Disk Access for the service's `node` binary.
- **Stores:** one row per message: text, sender handle (phone number or
  address), chat, direction and time.
- **Risk:** high. The full text of your private conversations and the phone
  numbers and addresses of everyone in them, including one-time codes and
  anything else sent to you.

## Apple Mail

- **Service:** `mail-connector`. Module `mcp/lib/connectors/mail.js`. Source
  name `mail`.
- **Reads:** Apple Mail's local store under `~/Library/Mail`: the message index
  and the per-message body files. Read-only. It does not talk to any mail
  server.
- **Needs:** Full Disk Access for the service's `node` binary, and Mail.app
  set up with your accounts.
- **Stores:** one row per message: sender, recipients, subject, date and the
  extracted body text.
- **Risk:** high. Every message in every account Mail.app syncs, including
  receipts, medical, financial and account-recovery mail.

## Screen Time

- **Service:** `screentime-connector`. Entry point
  `daemons/screentime-connector.js`, module `mcp/lib/connectors/screentime.js`.
  Source name `screentime`.
- **Reads:** the system activity database
  `~/Library/Application Support/Knowledge/knowledgeC.db` and the Focus state
  file under `~/Library/DoNotDisturb`.
- **Needs:** Full Disk Access for the service's `node` binary.
- **Stores:** by default app usage, web usage and app intents: which app or
  site, when and for how long, with the Focus mode active at the time.
- **Risk:** a detailed timeline of what you did on the machine, including web
  addresses.

## WhatsApp Desktop

- **Service:** `whatsapp-connector`. Module `mcp/lib/connectors/whatsapp.js`.
  Source name `whatsapp`.
- **Reads:** the WhatsApp Desktop message database in
  `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared`, read-only.
  It does not connect to WhatsApp.
- **Needs:** WhatsApp Desktop installed and linked; Full Disk Access for the
  service's `node` binary.
- **Stores:** one row per message: text, sender id, chat, direction and time,
  for one-to-one and group chats.
- **Voice notes:** on by default when the connector runs. Voice notes in
  one-to-one chats only (never groups or broadcasts) are copied to a private
  temporary directory under `<data root>/storage/tmp`, transcribed on the
  machine by `scripts/stt/stt_batch.py`, and the copy is deleted. The
  transcript is stored with the message. It needs the speech-to-text
  environment (`--python` on Apple Silicon), its model (`--models --yes`) and
  `ffmpeg`. Notes longer than 15 minutes are skipped. Set
  `WHATSAPP_VOICE_STT=0` in the connector's environment to turn transcription
  off.
- **Risk:** high. The same as Messages, plus the spoken content of voice notes
  other people sent you.

## Slack (advanced, off by default)

- **Service:** `slack-connector`. Module `mcp/lib/connectors/slack.js`. Source
  name `slack`.
- **Reads:** the Slack Web API, every 10 minutes: the channels, group chats and
  direct messages your account can see in the workspaces you list. This is a
  network call to Slack.
- **Needs:** `SLACK_USER_TOKEN` (a user token) and `SLACK_WORKSPACE_IDS`
  (comma-separated) in `secrets.env`. A variable named
  `SLACK_USER_TOKEN_<workspace id>` overrides the token for one workspace.
- **Stores:** one row per message: text, author id, channel, workspace and
  time.
- **This connector acts as your own Slack account.** It is not a workspace app
  that an administrator installed and can see: it reads with a token that
  carries your personal access. Whether you may do that is governed by Slack's
  terms and by the rules of each workspace, which is often your employer's.
  You are responsible for both. The token is as powerful as your login: keep
  it only in the mode 0600 secrets file.
- **Risk:** high. Colleagues' messages, possibly confidential to an
  organisation, copied to your disk in plain text.

The tree ships no other Slack tooling.

## Telegram (advanced, off by default)

Telegram is two services that must run together.

- **Services:** `telegram` (capture) and `telegram-connector` (drain). Source
  name `telegram`.
- **Reads:** the capture, `mcp/lib/connectors/telegram/telegram_tail.py`, logs
  in to Telegram as you with the Telethon library and receives every new and
  edited message in every chat, group and channel of your account. It writes
  each event to a staging file. The drain, `mcp/lib/connectors/telegram.js`,
  moves staged events into the source ledger.
- **Needs:**
  - the embedder Python environment (`--python`); Telethon is installed there;
  - `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` of an application you register
    with Telegram under your own account, and `TELEGRAM_SESSION_FILE`, in
    `secrets.env`;
  - a session, created once, interactively, from the checkout:

    ```bash
    TELEGRAM_API_ID=<id> TELEGRAM_API_HASH=<hash> \
      ./local-embedder/.venv/bin/python mcp/lib/connectors/telegram/telegram_login.py
    ```

    It asks for your phone number, the login code and your two-step password,
    and writes the session to `TELEGRAM_SESSION_FILE` (default
    `~/.config/memory-system/telegram.session`) at mode 0600.
- **Stores:** one row per message or edit: text, chat, sender id and name,
  direction and time.
- **This connector is a full login to your Telegram account.** The session
  file is equivalent to your password and two-step code together: anyone who
  copies it can read and send as you. It is a user session, not a bot, and
  using a user account through the API is subject to Telegram's terms of
  service, which you are responsible for following. Revoke it at any time from
  Telegram's device list.
- **Staging file:** by default `storage/tmp/telegram-staging.jsonl` under the
  data root (`<MEMORY_ROOT>`), in a directory created with owner-only
  permissions, and it contains message text. Both service templates use that
  path. It is not removed when you disable the connector.
- **Risk:** high. Every message in every chat of the account, and a credential
  on disk that grants full account access.
