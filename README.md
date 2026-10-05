# memory-system

Give Claude Code, or any other MCP client, a long-term memory that lives on
your Mac. Tell it something once ("I prefer morning meetings") and it can find
that again in a later session, in any project. Everything is stored in plain
files on your own disk; nothing is hosted.

It is for one person on one Mac who is comfortable in a terminal. **macOS
only**: the installer refuses any other system.

**Requirements:** macOS, Node.js 22.18.0 or newer, and the Xcode Command Line
Tools. That is all the basic install needs; the optional local models and
background services need more (see [Requirements](#requirements)).

MCP (the Model Context Protocol) is the standard way an AI app such as Claude
Code connects to outside tools. This project is an MCP server: a small program
(`mcp/server.js`) that Claude Code starts for you and calls when it wants to
store or look up a memory. It offers 14 tools; the two you use every day are
`memory_put` (store) and `memory_recall` (look up).

## Quick start

From nothing to a stored and recalled memory:

```bash
git clone https://github.com/ejmockler/memory-system.git
cd memory-system
bash scripts/install.sh --core
node scripts/smoke.mjs
claude mcp add --scope user memory -- node "$PWD/mcp/server.js"
```

- The checkout's directory name and location are your choice; nothing
  depends on them, and spaces in the path are fine.
- `install.sh --core` checks the prerequisites, runs `npm ci` in `mcp/`,
  creates the data directories and runs an install check whose last line is
  `core: usable`. It then prints the next two commands, with your checkout's
  path filled in.
- `smoke.mjs` starts the server on a throwaway data directory, stores one
  synthetic memory, recalls it, and prints one line of JSON. Success is
  `{"ok":true,...}` and exit code 0.
- The last line registers the server with Claude Code. Run it from the
  checkout: `"$PWD/mcp/server.js"` expands to the absolute path of the server,
  and the quotes keep a path with spaces in one piece. `--scope user` makes the
  tools available in every directory; without it Claude Code only offers them
  in sessions started from the directory you ran the command in. Any other MCP
  client that can launch a stdio server works the same way: the command is
  `node` and the single argument is the absolute path of `mcp/server.js` (see
  `mcp/.mcp.json.example`).

> **Your memories are stored inside the checkout by default.** Deleting or
> re-cloning the directory, or running `git clean -fdx` in it, deletes them.
> To keep them elsewhere, see [Where your data lives](#where-your-data-lives).

## Using it from Claude Code

Check that Claude Code sees the server: run `claude mcp list` in a terminal,
or type `/mcp` inside a Claude Code session. `memory` should be listed as
connected. If you registered it while a session was open, start a new session.

Then talk to it in plain words:

- "Remember that I prefer morning meetings."
- "What do you know about my meeting preferences?"

Claude decides by itself when to call a tool, based on what you ask and on
the tool descriptions. Asking it to remember something or asking what it
knows usually leads to a call; it does not recall or store on every turn.
Claude Code may ask your permission the first time it uses each tool.

To make recall and storing routine, you can add instructions like these to a
`CLAUDE.md` file (your user-wide `~/.claude/CLAUDE.md`, or one in a project).
This is optional and the wording is yours to change:

```markdown
## Long-term memory

- At the start of a task, call `memory_recall` with the task as the query and
  use anything relevant it returns.
- When you learn a durable fact about me, my preferences or my projects (not
  a passing detail of this task), store it with `memory_put`.
```

### What the tools take

Claude fills in these arguments itself; you only need them if you call the
tools from your own code. These are the same shapes `scripts/smoke.mjs` uses.

`memory_put` stores one memory. `content` is the text. `provenance` is
required and must be an object, but every field in it is optional, so `{}`
is accepted; `agent_id` and `conversation_id` record who stored it and in
which conversation.

```json
{
  "content": "Alex Example prefers morning meetings.",
  "provenance": { "agent_id": "my-agent", "conversation_id": "first-run" }
}
```

`memory_recall` looks memories up. `current_query` is what you are looking
for. `time` is the current time of the query as an ISO-8601 timestamp: recall
measures how recent each memory is against it. `recent_turns` (the last few
turns of the conversation, may be empty) and `agent_role` are required too.

```json
{
  "conversation_id": "first-run",
  "surrounding_context": {
    "recent_turns": [],
    "agent_role": "assistant",
    "current_query": "When does Alex Example like to meet?",
    "time": "2026-01-15T09:00:00Z"
  }
}
```

### What a recall returns

This is a real answer to the recall above on a fresh basic install, trimmed to
the fields you are most likely to read (the full answer has about twenty more,
mostly diagnostics):

```json
{
  "ok": true,
  "data": {
    "recall_id": "rec_7637fd7d5546c420",
    "memories": [
      {
        "id": "mem_f18c7bfd362c3eec",
        "content": "Alex Example prefers morning meetings.",
        "provenance": {
          "source": "manual",
          "ts": "2026-10-04T05:17:25.271Z",
          "conversation_id": "first-run",
          "confidence": "high"
        },
        "freshness": "fresh"
      }
    ],
    "truncated": false,
    "degraded_recall": true,
    "degraded_reason": "dense_leg_unservable"
  },
  "error": null,
  "meta": { "tool": "memory_recall", "version": 1 }
}
```

`memories` holds the stored text and where it came from (`source` is
`manual` for anything stored with `memory_put`). `degraded_recall: true` is
normal on a basic install: it means recall used word matching only, because
the optional local embedding model is not running. The answers are still
correct matches. Every tool, argument and error code is described in
[kb/mcp-surface.md](kb/mcp-surface.md).

One limit to know before you go further: once you add the local models or the
background services, `memory_put` is switched off by default and needs an
explicit opt-in. [INSTALL.md](INSTALL.md#when-memory_put-needs-an-opt-in)
explains why and what changes.

## What works at each tier

You can stop after any tier. Each one is a separate installer mode.

| Tier | What you install | What you get |
| --- | --- | --- |
| 1. Node only | `bash scripts/install.sh --core` | The MCP server. `memory_put` stores a memory and `memory_recall` finds it by word matching (BM25). Recall answers are marked `degraded_recall` because the dense (vector) search is absent; they are still correct matches. Once installed it needs no Python, no models, no background process and no network. |
| 2. Python tier and models | `--python`, then `--models --yes` | Dense (vector) recall and reranking from two local model servers on `127.0.0.1`, and on-device transcription of voice notes. Dense recall and reranking need those two servers running, started by hand or by the tier 3 services; installing this tier alone does not remove `degraded_recall`. Needs Apple Silicon and a lot of memory; see Requirements. |
| 3. Services and macOS permissions | `--services --yes`, plus connectors you add by hand | Six background launchd services that keep ingest and the indexes running, and optional connectors that read your Codex CLI sessions, git history, GitHub events, Messages, Mail, Screen Time, Slack, Telegram and WhatsApp. Several connectors need Full Disk Access or a credential. |

## Requirements

Tier 1 (required):

- macOS. The installer refuses any other system.
- Node.js 22.18.0 or newer, with npm (the floor is `engines.node` in
  `mcp/package.json`; 24.15.0 is the tested version).
- The Xcode Command Line Tools (`xcode-select --install`): one dependency, the
  vector index, is compiled during `npm ci`.

Tier 2 (optional), for the default models:

- Apple Silicon (arm64). The embedding server has only been run on the Metal
  (MPS) backend. On Intel the speech-to-text environment and its model are
  skipped; the embedding and rerank models still download.
- Python 3.13 for the embedding and rerank servers and Python 3.12 for
  speech-to-text (the two `.python-version` files). The installer uses `uv` if
  it is on `PATH`, otherwise `python3.13` and `python3.12`.
- Disk: about 14 GB for the embedding model, about 1.1 GB for the reranker and
  about 1.6 GB for the speech-to-text model, plus the Python environments.
- RAM (unified memory): the embedding server's footprint measured 26 to 32 GB
  under sustained load. 32 GB is at the limit for the default embedder; 64 GB
  or more leaves room for the reranker and everything else you run. Details
  and the smaller-model caveat are in
  [local-embedder/README.md](local-embedder/README.md).
- `ffmpeg` on `PATH` for voice-note transcription.

Tier 3 (optional): tier 1, tier 2 for the two model services, and per
connector the permission or credential listed in
[docs/CONNECTORS.md](docs/CONNECTORS.md).

The installer registers nothing with any client and installs no background
service unless you ask for `--services --yes`. The full procedure, every
installer mode, upgrading and uninstalling are in [INSTALL.md](INSTALL.md).

## Where your data lives

Everything the system stores is under one directory, the data root. **By
default the data root is the checkout itself**, so your memories sit next to
the code: deleting or re-cloning the checkout, or running `git clean -fdx` in
it, deletes them. (`git pull` and `git clean -fd` without `-x` leave them
alone.)

To keep data elsewhere, set `MEMORY_ROOT` to an absolute path when you install
and give the server the same value in its registration:

```bash
MEMORY_ROOT=/absolute/path/to/data bash scripts/install.sh --core
claude mcp add --scope user memory -e MEMORY_ROOT=/absolute/path/to/data -- node "$PWD/mcp/server.js"
```

The background services do not follow `MEMORY_ROOT`; if you plan to run them,
read the limits in [INSTALL.md](INSTALL.md#code-root-and-data-root) first.

Inside the data root:

- `ledgers/` holds the memory ledger and the recall log;
- `storage/` holds the raw rows each connector captured and index state;
- `indices/` holds the search indexes, created on first use;
- `policy/` holds exclusions, revocations and signing state;
- `telemetry/` holds a size-capped log of tool calls, without their content;
- `connectors/` holds each connector's read position;
- `hooks/` holds the optional Claude Code hooks' temporary files and error
  log, once you register them;
- `config/` holds your identity file and, if you use one, `secrets.env`.

Everything the system writes into them is ignored by git (`.gitignore`);
only the example files under `config/` are tracked. They contain whatever you
put or ingest, in plain text, protected only by your account's file
permissions.

## Uninstalling

For a basic (tier 1) install, two steps remove everything:

```bash
claude mcp remove memory --scope user
```

then delete the checkout (and your `MEMORY_ROOT` directory, if you set one).
That deletes all your memories. If you installed models, services, hooks or
connectors, follow
[Uninstalling completely](INSTALL.md#uninstalling-completely) instead.

## What leaves the machine

With the default configuration, memory content never leaves your machine:
storing, indexing, embedding, reranking and transcription are all local, and
the two model servers listen on `127.0.0.1` only. The exceptions, all opt-in:

- **Google Gemini API.** Only when `GEMINI_API_KEY` or `GEMINI_API_KEYS` is
  set in the environment of the process. Recall sends the query and candidate
  memory text to the Gemini reranker (`mcp/lib/gemini-flash-client.js`) only if
  you also switch the local reranker off with `LOCAL_RERANKER_ENABLED=0`. The
  Gemini embedding client (`mcp/lib/gemini-client.js`) is used by the manual
  script `scripts/backfill-embeddings.mjs`. With no key, neither is called.
- **Model download.** `--models --yes` downloads model weights from Hugging
  Face. It uploads nothing. The model services run with Hugging Face's offline
  mode on, so they never download or check for models themselves; if you start
  a model server by hand, see
  [local-embedder/README.md](local-embedder/README.md).
- **Connectors that talk to a service.** The Slack connector calls the Slack
  API, the GitHub connector calls GitHub through the `gh` CLI, and the
  Telegram capture holds a Telegram session. They fetch your data from those
  services; they do not send your memories to them.
- **Your MCP client.** Whatever `memory_recall` returns goes to the agent that
  asked, and from there to that agent's model provider.

## Repository map

| Path | Contents |
| --- | --- |
| `mcp/` | The MCP server: `mcp/server.js`, the tools and libraries under `mcp/lib/`, the query daemon under `mcp/daemon/`, the test suites under `mcp/test/`. |
| `mcp/lib/connectors/` | One module per ingest connector. |
| `daemons/` | Entry points of the background services, including `daemons/watermark.js`, which turns ingested rows into memories and keeps the indexes current. |
| `local-embedder/` | The two Python model servers (embedding and rerank). |
| `scripts/` | `scripts/install.sh`, `scripts/smoke.mjs`, `scripts/render-launchd.mjs`, `scripts/download-models.sh`, and the speech-to-text worker under `scripts/stt/`. The other files there are maintenance and development tools. |
| `launchd/` | One service template per background service, the credentials wrapper and `launchd/env.example`. |
| `hooks/` | Optional Claude Code hooks that capture agent sessions. |
| `config/` | Example per-host configuration files. |
| `kb/` | Design notes and the tool reference. Start with [kb/README.md](kb/README.md), the index. |

## Documentation

- [INSTALL.md](INSTALL.md): prerequisites, every installer mode, configuration,
  services, verifying, upgrading, uninstalling, troubleshooting.
- [docs/CONNECTORS.md](docs/CONNECTORS.md): each connector, what it reads, what
  it needs and its privacy risk.
- [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md): environment variables.
- [kb/mcp-surface.md](kb/mcp-surface.md): the tool reference (names, schemas,
  error codes).
- [CONTRIBUTING.md](CONTRIBUTING.md): running the tests and the two rules for
  changes.
- [SECURITY.md](SECURITY.md): reporting a vulnerability.
- [CHANGELOG.md](CHANGELOG.md): what changed in each release.

## License

MIT. See [LICENSE](LICENSE).
