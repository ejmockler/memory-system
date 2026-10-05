# launchd services

The background services are per-user launchd agents. This directory holds 16
templates, one per agent: six core services and ten optional connectors, of
which you install only the ones you want. It also holds the wrapper that hands
credentials to the agents that need them, and the list of credential variable
names. Nothing here contains a path,
an account id or a credential: `scripts/render-launchd.mjs` turns the templates
into loadable plists for whatever checkout path, home directory and node binary
you give it.

| File | Role |
| --- | --- |
| `com.user.memory-system.<service>.plist.template` | one launchd agent each, with placeholders for every machine-specific value |
| `run-with-env.sh` | sources the private secrets file, then execs the real service command |
| `env.example` | names of the credential and identity variables, with empty values |

## The 16 service templates

Every label is `com.user.memory-system.<service>`. "Core" services are what a
working install needs to ingest, index and recall. Everything else is one
optional connector per data source: render and load only the ones you use.

In the Program column, `node` is the pinned node binary, `python` is
`<root>/local-embedder/.venv/bin/python3`, and "wrapped" means the command is
launched through `run-with-env.sh`.

### Core

| Service | Purpose | Schedule | Program | Permissions | Credentials |
| --- | --- | --- | --- | --- | --- |
| `watermark` | Ingest, filtering and indexing: turns source ledgers into memory and keeps the indexes current | at load, kept alive | wrapped `node --max-old-space-size=8192 daemons/watermark.js` | none | none; it calls no cloud service. Gemini keys are read only by the MCP server's reranker, from the client's registration `env` (see the README) |
| `queryd` | Resident query daemon that holds the lexical and vector indexes for recall | kept alive (no run-at-load key) | `node --max-old-space-size=8192 mcp/daemon/queryd.js` | none | none |
| `embed-server` | Local embedding server on 127.0.0.1:8359; the model must already be in the Hugging Face cache (the template sets `HF_HUB_OFFLINE=1`) | at load, kept alive | `python local-embedder/embed_server.py` | none | none |
| `rerank-server` | Local reranker on 127.0.0.1:8360; the model must already be in the Hugging Face cache (the template sets `HF_HUB_OFFLINE=1`) | at load, kept alive | `python local-embedder/rerank_server.py` | none | none |
| `embed-watchdog` | Restarts `embed-server` when its memory footprint passes `WATCHDOG_THRESHOLD_GB` | at load, then every 30 s | `bash daemons/embed-watchdog.sh` | none | none |
| `reembed-drain` | Embeds rows that were ingested while the embedding server was down, `REEMBED_BATCH` at a time | at load, then every 15 min | `node daemons/reembed-drain.mjs` | none | none |

### Optional connectors

| Service | Purpose | Schedule | Program | Permissions | Credentials |
| --- | --- | --- | --- | --- | --- |
| `codex-cli-connector` | Tails Codex CLI session files | at load, kept alive | `node mcp/lib/connectors/codex-cli.js` | none | none |
| `git-log-connector` | One pass over local git history per run | at load, then every 15 min | wrapped `node mcp/lib/connectors/git-log-local.js --once` | none | `GIT_LOG_OPERATOR_EMAILS` (identity value, colon-separated) |
| `github-events-connector` | One pass over your GitHub events per run | daily at 04:17 (not at load) | `node mcp/lib/connectors/github-events.js --once` | `gh` CLI installed, logged in and on `PATH` | none of its own; uses the `gh` login |
| `imessage-connector` | Reads the Messages database | at load, kept alive | `node mcp/lib/connectors/imessage.js` | Full Disk Access for the pinned node binary | none |
| `mail-connector` | Reads the Apple Mail store | at load, kept alive, 5 min interval | `node mcp/lib/connectors/mail.js` | Full Disk Access for the pinned node binary | none |
| `screentime-connector` | Reads the Screen Time database | at load, kept alive | `node daemons/screentime-connector.js` | Full Disk Access for the pinned node binary | none |
| `slack-connector` | One Slack poll per run | at load, then every 10 min | wrapped `node mcp/lib/connectors/slack.js --once` | none | `SLACK_USER_TOKEN`, `SLACK_WORKSPACE_IDS` |
| `telegram` | Telegram stage 1: Python capture that appends events to a staging file | at load, kept alive | `bash daemons/telegram-tail-run.sh` | a session file, created once with `mcp/lib/connectors/telegram/telegram_login.py` | `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION_FILE` |
| `telegram-connector` | Telegram stage 2: drains the staging file into the source ledger | at load, kept alive | `node mcp/lib/connectors/telegram.js` | none | none |
| `whatsapp-connector` | Reads the WhatsApp Desktop message database | at load, kept alive, 5 min interval | `node mcp/lib/connectors/whatsapp.js` | Full Disk Access for the pinned node binary | none |

Notes:

- Telegram is a two-stage pipeline: `telegram` captures, `telegram-connector`
  drains. Run both or neither. `telegram` keeps its own wrapper script, which
  picks its env file in this order: the file named by `TELEGRAM_ENV_FILE`
  (the template points that at the same secrets file every other service
  uses), then `<root>/config/secrets.env` when it exists, then `telegram.env`
  in `.config/memory-system` under the home directory. The same mode-600 rule
  applies to whichever file is chosen. Both templates set the staging file to
  `<root>/storage/tmp/telegram-staging.jsonl`; it contains message text.
- Full Disk Access is granted per binary in System Settings, Privacy and
  Security. Grant it to the exact node binary the rendered plist names, then
  reload the service.
- Logs go to `<root>/daemons/logs/<service>.stdout` and `.stderr`, except the
  two Python servers, which log to `<root>/local-embedder/logs/`, and
  `telegram`, whose files are named `telegram-tail`.

## Secrets

Plists in the LaunchAgents directory are world-readable, so no credential is
ever written into one. Instead:

1. Copy `launchd/env.example` to `<root>/config/secrets.env`.
2. `chmod 600 <root>/config/secrets.env`.
3. Every line ships commented out. Uncomment and fill in only the variables
   for the services you run (an uncommented empty assignment still exports an
   empty variable).

At service start `run-with-env.sh` sources that file with auto-export and then
execs the real command. It never prints a value. Its rules:

- file absent: one line on stderr, and the service starts anyway, so the core
  services run on a clean install with no credentials;
- file readable or writable by group or other: the wrapper exits 78 and the
  service does not start until you fix the mode;
- `MEMORY_SECRETS_FILE` overrides the file location.

`watermark`, `slack-connector` and `git-log-connector` start through the
wrapper. `telegram` reads the same file through its own wrapper.

## Rendering

```bash
node scripts/render-launchd.mjs \
  --root /opt/example/memsys \
  --home /Users/example \
  --out /tmp/memsys-plists
```

- `--root` and `--home` must be absolute. `--out` is created if missing and
  receives one `<label>.plist` per service at mode 0644.
- `--only watermark,queryd` renders a subset by short service name. An unknown
  name is an error.
- `--node <path>` sets the node binary the rendered plists name. The default
  is the node that runs the script, which is usually not what you want if that
  node comes from a version manager and may move: pass `--node` with a path
  that stays put. Full Disk Access is granted to this binary, so a service
  rendered with a different node needs its own grant.
- The Python servers use `<root>/local-embedder/.venv/bin/python3`, derived
  from `--root`.
- Rendering stops with a non-zero exit, naming the file and the token, if any
  placeholder survives substitution. Nothing is written in that case.

Check the result before loading it:

```bash
plutil -lint /tmp/memsys-plists/*.plist
```

### Installing

Without `--install` the script writes only into `--out`. **`--install` is the
only path that writes to your LaunchAgents directory or runs `launchctl`.**
With it, the script refuses unless `--home` is the home directory of the
account running it, copies the rendered plists into
`<home>/Library/LaunchAgents`, and bootstraps each one into that account's GUI
launchd domain.

To install by hand instead, copy the plists you want from `--out` into
`<home>/Library/LaunchAgents` and load each with `launchctl bootstrap` for your
own user domain.
