# Installing

This page takes a fresh clone to a working install, one explicit step at a
time. Nothing here runs unless you type it: the installer registers no MCP
client, installs no background service and downloads no model unless you pass
the flag that says so. The installed model services never download a model
on their own either: their service files turn on Hugging Face's offline mode
(`HF_HUB_OFFLINE=1`), so a missing model makes them fail rather than fetch it.

In this page `<checkout>` is the directory you cloned into and `<data root>`
is where your data lives (the checkout, unless you set `MEMORY_ROOT`).

## Prerequisites

For the core:

- macOS.
- Node.js 22.18.0 or newer and npm, on `PATH`.
- The Xcode Command Line Tools: `xcode-select --install`.

For the Python tier and the models (optional):

- Apple Silicon (arm64) for the default models. On Intel the speech-to-text
  environment and the speech-to-text model are skipped (voice notes are not
  transcribed); the embedding and rerank models still download, but the
  embedding server is untested there.
- `uv` on `PATH`, or `python3.13` (embedding and rerank servers) and
  `python3.12` (speech-to-text) on `PATH`.
- About 17 GB of free disk for the three default models and 32 GB of unified
  memory at the very least; 64 GB or more is comfortable. See
  [local-embedder/README.md](local-embedder/README.md) for the measurements.
- `ffmpeg` on `PATH` if you want voice notes transcribed.

For the optional hooks: `jq` on `PATH`.

## The installer

```bash
bash scripts/install.sh --help
```

prints every mode. Modes can be combined; with no mode, `--core` runs. Every
mode is safe to run again: existing config and data files are never
overwritten.

| Flag | What it does | What it writes |
| --- | --- | --- |
| `--core` | Checks the prerequisites (macOS, Node.js, npm, the Xcode Command Line Tools), runs `npm ci` in `mcp/`, creates the data, config and log directories, copies each `config/*.example.*` file to `<data root>/config/` under its real name (the `.example` part dropped) if that file does not exist yet, except the optional gazetteer seed, then runs the install check (`scripts/install/doctor.mjs`). Today that copies one file, `config/operator-identity.example.json`, to `<data root>/config/operator-identity.json`. | `mcp/node_modules` and two log directories in the checkout; `policy`, `storage`, `ledgers`, `telemetry`, `connectors` and `config` under the data root. |
| `--python` | Creates the two Python environments from their pinned manifests (`local-embedder/requirements.txt` and `scripts/stt/requirements.txt`). Uses `uv` when it is on `PATH`, otherwise the matching `pythonX.Y`. The speech-to-text environment is created on Apple Silicon only. | `<checkout>/local-embedder/.venv` and `<checkout>/.venv-stt`. Large download. |
| `--models` | Shows the model download plan from `scripts/download-models.sh`. Without `--yes` it downloads nothing and the installer exits 1 after showing the plan. | Only with `--yes`: the Hugging Face cache. |
| `--services` | Renders the six core background services with `scripts/render-launchd.mjs` and lists exactly what would be installed. Installs nothing unless `--yes` is also given. | `<checkout>/launchd/rendered`. Only with `--yes`: the LaunchAgents directory of your account, and the services are loaded into launchd. |
| `--all` | `--core`, `--python`, `--models` and `--services`, in that order. | The sum of the above. |
| `--yes` | Confirms the irreversible part of `--models` and `--services`. It has no effect on `--core` or `--python`. | See `--models` and `--services`. |
| `--help`, `-h` | Shows the help and exits. | Nothing. |

Any other argument stops the installer with `install: unknown argument:` and
exit code 64 before anything is written.

## Core install

```bash
bash scripts/install.sh --core
```

A successful run ends with the install check and then a list of next steps.
The check's last line is `core: usable`, and the lines above it look like
this:

```text
[ok]   node version: 24.15.0 (needs 22.18.0 or newer)
[ok]   dependencies load: the vector index and MCP modules import
[ok]   server handshake: initialize and tools/list answered (14 tools)
[ok]   data root writable: <data root>
[--]   optional: embedder Python environment absent
```

`[ok]` is a passed check, `[FAIL]` a failed core check, and `[--]` an optional
part that is absent. Optional lines never change the result. The core check
starts the server, asks for its tool list and stops it; it stores nothing.

On a fresh install one of the optional lines reads
`[--]   optional: <data root>/config/operator-identity.json is still the unedited example; replace its values with your own`.
That is expected: storing and recalling memories work without editing that
file. It matters once you add connectors (see
[Operator identity](#operator-identity)).

When the check passes, the installer prints the next steps: run
`node scripts/smoke.mjs`, then register the server with the `claude mcp add`
command from
[Registering the server with an MCP client](#registering-the-server-with-an-mcp-client),
printed with your checkout's path (and your `MEMORY_ROOT`, if you set one)
filled in.

Outside the checkout and the data root, the only files written are npm's own
download and build caches in your home directory.

### Code root and data root

There are two roots:

- The **code root** is the checkout. `mcp/node_modules`, the Python
  environments, service logs and rendered service files live here.
- The **data root** is the directory named by `MEMORY_ROOT` when that variable
  is set, otherwise the checkout. Ledgers, storage, policy, telemetry,
  connector cursors and config live here.

`--core` creates these directories under the data root: `policy`, `storage`,
`storage/sources`, `storage/feedback`, `ledgers`, `telemetry`, `connectors`
and `config`. It creates two log directories in the checkout,
`<checkout>/daemons/logs` and `<checkout>/local-embedder/logs`.

To keep data outside the checkout:

```bash
MEMORY_ROOT=/absolute/path/to/data bash scripts/install.sh --core
```

and then give the same `MEMORY_ROOT` to everything that touches the data: the
MCP server (the `env` block of its registration in your client), the hooks,
and `node scripts/install/doctor.mjs --data-root /absolute/path/to/data`.

**A split data root does not reach the background services.** The service
files are rendered from the checkout path alone: `scripts/render-launchd.mjs`
reads no environment variable, and every Node and shell service template
sets the service's `MEMORY_ROOT` to the checkout (the two Python model
servers, `embed-server` and `rerank-server`, keep no data and set none).
Services therefore read and write under the checkout whatever `MEMORY_ROOT`
was in your shell. If you plan to run the
services, leave `MEMORY_ROOT` unset everywhere so the server, the hooks and
the services all use the checkout.

### Registering the server with an MCP client

The installer registers nothing. The server is a stdio MCP server: the command
is `node` and its one argument is the absolute path of `mcp/server.js`. For
Claude Code, run this from the checkout:

```bash
claude mcp add --scope user memory -- node "$PWD/mcp/server.js"
```

`"$PWD/mcp/server.js"` expands to the absolute path of the server; keep the
quotes so a path with spaces stays one argument. `--scope user` makes the
server visible in every directory; without it Claude Code registers at local
scope, which only sessions started from the directory you ran the command in
can see (`kb/mcp-registration-state.md` explains the scopes). Check the result
with `claude mcp list`, or `/mcp` inside a Claude Code session.

To pass environment variables to the server (for example `MEMORY_ROOT`, or
`MEMORY_PUT_ENABLED` below), add `-e NAME=value` after the server name:

```bash
claude mcp add --scope user memory -e MEMORY_PUT_ENABLED=1 -- node "$PWD/mcp/server.js"
```

To change an existing registration, remove it first with
`claude mcp remove memory --scope user`.

For any other client, copy the shape in `mcp/.mcp.json.example` and replace
the placeholder path. Restart the client after an upgrade so it starts the new
server.

### When `memory_put` needs an opt-in

`memory_put` works with no configuration on a fresh install. Once the install
has a vector index or runs the query daemon (in practice: once the local
embedding model has indexed memories, or the `queryd` service is running; both
come with the model servers and background services), the server refuses it
with `SCOPE_BLOCKED` unless it is started with `MEMORY_PUT_ENABLED=1` in the
`env` block of its registration. `MEMORY_PUT_ENABLED=0` switches it off in
every case.

On such an install the put is stored, but `memory_recall` does not return it
by default: the row has no embedding, no re-embed sweep entry is written for
it, and it joins the lexical index only when the server also runs with
`MEMORY_BM25_DECOUPLE_EMBED=1` (off by default). `memory_get` with the
returned id does return it. Details are in
[kb/mcp-surface.md](kb/mcp-surface.md) under `memory_put`.

### Hooks (optional)

The Claude Code hooks under `hooks/` capture your agent sessions. They are
never registered for you. See
[hooks/registration-recommendation.md](hooks/registration-recommendation.md);
register them by their real path, never through a symlink, because each hook
finds the checkout from its own location.

## Per-host configuration

All of it lives in `<data root>/config/`, which git ignores.

### Operator identity

`--core` creates `<data root>/config/operator-identity.json` from
`config/operator-identity.example.json`. It says which e-mail addresses,
GitHub logins, phone numbers and message handles are you, so connectors can
tell your own messages and commits from other people's. The example values are
synthetic: replace every one with your own, or delete the entries you do not
need. The field descriptions are inside the file.

- With no file, nothing is attributed to you and one hint line goes to stderr.
- A file that is not valid JSON, or has a field of the wrong type, stops the
  process at start.
- The file is read once per process: restart the server and the services after
  editing it.
- `MEMORY_OPERATOR_IDENTITY_FILE` points at a file of the same shape anywhere
  on disk.

Until you edit it, the install check reports it as
`still the unedited example`. That line is informational: storing and
recalling memories work without editing the file, so you can leave it until
you add your first connector, which uses it to tell your own messages and
commits from other people's.

### Gazetteer seed (optional)

The gazetteer seed is the list of names (projects, organisations, topics,
artifacts) the server recognises as entities when no richer list is
available. The server has a built-in list, and the installer does not create
`<data root>/config/gazetteer-seed.json`. To use your own list, create that
file by hand: copy `config/gazetteer-seed.example.json` to
`<data root>/config/gazetteer-seed.json` and edit it.

- The file must be a non-empty JSON array of `{"surface": "...", "kind": "..."}`
  objects. `surface` is a non-empty string, matched as a whole word,
  case-insensitively. `kind` is one of `person`, `place`, `org`, `project`,
  `event`, `topic`, `artifact`.
- A valid file **replaces** the built-in list entirely; the two are not
  merged. An unedited copy of the example therefore recognises only its four
  synthetic names and not the built-in list.
- Delete the file to go back to the built-in list.
- A file that is present but unreadable, not valid JSON, not an array, empty,
  or holding a malformed entry stops the server at start with an error that
  names the file. The install check then reports
  `server handshake: the server exited early`.

### Secrets

The core needs no credential. A service that needs one reads it from a
private file, never from its service file (those are world-readable):

```bash
cp launchd/env.example config/secrets.env
chmod 600 config/secrets.env
```

Run those two commands in the checkout, then fill in the variables for the
services you run and delete or comment out the rest (an empty assignment still
exports an empty variable). `launchd/env.example` lists every variable name.

- The wrapper `launchd/run-with-env.sh` reads
  `$MEMORY_ROOT/config/secrets.env`, and each service file sets `MEMORY_ROOT`
  to the checkout, so for the services the file is
  `<checkout>/config/secrets.env`. With a split data root the installer's hint
  and the install check name `<data root>/config/secrets.env` instead; the
  services do not read that one. `MEMORY_SECRETS_FILE` overrides the location.
- If the file is absent the service starts without credentials and says so in
  one line on stderr.
- If the file is readable or writable by group or other, the wrapper refuses
  with exit code 78 and the service does not start until you run `chmod 600`.

### Curated evaluation pairs (optional)

`<data root>/config/contextual-eval-curated.json` is read only by the
evaluation script `mcp/scripts/build-contextual-eval-goldset.mjs`. It is a
JSON array of `{"golden": "<memory id>", "query": "...", "note": "..."}`
objects. Absent means no curated pairs; a malformed file stops that script
with an error naming the file. Nothing else reads it.

## Python tier and models

```bash
bash scripts/install.sh --python
```

creates `<checkout>/local-embedder/.venv` (Python 3.13, for the embedding and
rerank servers) and, on Apple Silicon, `<checkout>/.venv-stt` (Python 3.12,
for voice-note transcription). An existing environment is kept and its
packages are brought in line with the manifest.

```bash
bash scripts/install.sh --models
bash scripts/install.sh --models --yes
```

The first command prints the plan and exits 1 without downloading. The second
downloads into the standard Hugging Face cache. On an Intel Mac the
speech-to-text model is left out (it runs only on Apple Silicon) and the
embedding and rerank models download as usual. Default models and sizes:

| Model | Used for | Approximate size |
| --- | --- | --- |
| `Qwen/Qwen3-Embedding-8B` | dense recall | 14 GB |
| `Qwen/Qwen3-Reranker-0.6B` | reranking | 1.1 GB |
| `mlx-community/whisper-large-v3-turbo` | voice-note transcription | 1.6 GB |

Downloads are resumable: run the same command again after a network drop. To
fetch one model, call the script directly:
`scripts/download-models.sh --only reranker --yes` (`embedder`, `reranker` or
`stt`; `--only stt` is refused on Intel). Run `--python` first: the download
uses the `hf` command from the environments it creates.

Memory needs, running the servers in the foreground, and choosing another
model or device are covered in
[local-embedder/README.md](local-embedder/README.md).

## Background services

There are 16 launchd service templates in `launchd/`: six core services and
ten optional connectors. [launchd/README.md](launchd/README.md) has the full
table; [docs/CONNECTORS.md](docs/CONNECTORS.md) describes each connector.

### Core services

```bash
bash scripts/install.sh --services
```

renders the six core services (`watermark`, `queryd`, `embed-server`,
`rerank-server`, `embed-watchdog`, `reembed-drain`) into
`<checkout>/launchd/rendered` and lists what would be installed. Nothing is
installed. Read the rendered files, then:

```bash
bash scripts/install.sh --services --yes
```

This runs `scripts/render-launchd.mjs` with its own `--install` flag, which

1. refuses unless the home directory it was given is the home directory of the
   account running it;
2. copies each rendered file into `~/Library/LaunchAgents` at mode 0644;
3. loads each one with `launchctl bootstrap gui/<your uid> <file>`.

The services then start, and start again at every login. `embed-server` and
`rerank-server` need the Python environment and the models. Their service
files set `HF_HUB_OFFLINE=1`, so they never download a model themselves:
without the environment or the models they fail and are restarted in a loop,
so run `--python` and `--models --yes` first.

The services run the `node` that was first on `PATH` when you rendered them.
If that node comes from a version manager or a package manager it may move on
upgrade; the installer warns about this. Render again after it moves.

### Optional connectors

The installer never installs a connector. Render the ones you want yourself,
from the checkout:

```bash
node scripts/render-launchd.mjs --root "$PWD" --home "$HOME" \
  --out "$PWD/launchd/rendered" --node "$(command -v node)" \
  --only imessage-connector
```

- `--root` and `--home` must be absolute paths. `--only` takes a
  comma-separated list of short service names; an unknown name is an error
  that lists the known ones.
- Add `--install` to the same command to copy the rendered files into
  `~/Library/LaunchAgents` and load them. Without it only `--out` is written.
- Check a rendered file with `plutil -lint <file>`.

### Start, stop, uninstall

Each service has the label `com.user.memory-system.<service>` and the file
`~/Library/LaunchAgents/com.user.memory-system.<service>.plist`. The tree has
no stop or uninstall script; these commands are the inverse of what the
install step does.

```bash
# stop one service (it stays stopped until you load it again or log in)
launchctl bootout "gui/$(id -u)/com.user.memory-system.<service>"

# start it again
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.user.memory-system.<service>.plist

# uninstall every service of this system
for p in ~/Library/LaunchAgents/com.user.memory-system.*.plist; do
  launchctl bootout "gui/$(id -u)" "$p"
  rm "$p"
done
```

Most services are kept alive by launchd, so killing the process does not stop
one; boot it out.

### Logs

- `<checkout>/daemons/logs/<service>.stdout` and `.stderr` for every Node and
  shell service. The Telegram capture's files are named `telegram-tail`.
- `<checkout>/local-embedder/logs/` for `embed-server` and `rerank-server`.
- `<data root>/hooks/hook-errors.jsonl` for the hooks.

## Verifying an install

```bash
node scripts/install/doctor.mjs
node scripts/smoke.mjs
cd mcp && npm test
```

- `doctor.mjs` is the install check `--core` ends with. Exit 0 and
  `core: usable` mean the server starts and the data root is writable. It
  takes `--root <checkout>` and `--data-root <dir>`. The data root it checks
  is `MEMORY_ROOT` when that is set, otherwise the checkout; `--data-root`
  overrides both.
- `smoke.mjs` starts the server on a throwaway data directory under the system
  temp directory, puts one synthetic memory, recalls it, removes the directory
  and prints one line of JSON. Exit 0 with
  `{"ok":true,"summary":"put then recall returned the put text (lexical-only, degraded_recall)"}`
  is success on a core install: `degraded_recall` only says that the dense leg
  is absent. Exit 1 carries the reason in `summary`. It never touches your
  data root and needs no network.
- `npm test` runs every registered suite through
  `mcp/scripts/run-all-tests.mjs` and prints a tally; it takes about four
  minutes. Passing suites print some alarming-looking lines on purpose (see
  [CONTRIBUTING.md](CONTRIBUTING.md#running-the-tests)). Exit 0 means every suite
  passed, 1 means a suite failed or nothing ran, 2 means the runner refused to start
  (unsupported Node, unknown argument, or a suite on disk that is not
  registered). It needs only the core install (Node.js and
  `mcp/node_modules`): no network, no model server and no cloud key. Suites
  that exercise the embedding path run against a stub of the model server
  rather than skipping. The suites that call the cloud API skip those cases
  and exit 0 when `GEMINI_API_KEY` is not set. `REQUIRE_FLASH_SMOKE=1` turns
  the skip into a failure for the integration and flash-client suites; the
  live cases in `test/gemini-client.test.mjs` have no forcing flag.

What a skip means: some suites print a skip line for a check that only runs
against a populated store or with an opt-in variable. That is not a failure
and the suite still exits 0. One kind of skip is turned into a failure under
`npm test`: suites that assert the store does not change while they run first
wait for the data root to be quiet, and if background services keep writing
to it they fail instead of passing without having checked anything. Run the
tests with the services stopped, or from a checkout that has none.

## Upgrading

```bash
git pull
bash scripts/install.sh --core
```

- `--core` reinstalls the Node dependencies only when `mcp/package-lock.json`
  or your Node version's module ABI changed, and keeps your config and data.
- If `local-embedder/requirements.txt` or `scripts/stt/requirements.txt`
  changed, run `--python` again.
- If a file under `launchd/` changed, boot the services out (see above), then
  run `--services --yes` again. Loading a service that is already loaded
  fails, so boot out first. `--services` renders only the six core services:
  for each connector you installed, boot it out too and run your own
  `node scripts/render-launchd.mjs ... --only <service> --install` command
  from "Optional connectors" again.
- Restart your MCP client so it launches the new server.

## Uninstalling completely

1. Boot out and delete every service file (the loop under "Start, stop,
   uninstall").
2. Remove the server from your MCP client (for Claude Code:
   `claude mcp remove memory --scope user`) and remove any hook entries you
   added to its settings.
3. Delete the checkout. With the default data root this also deletes all your
   data. If you set `MEMORY_ROOT`, delete that directory too.
4. Delete the downloaded models from the Hugging Face cache (by default
   `~/.cache/huggingface/hub`, the three model directories named in the table
   above).
5. If you used the Telegram connector: delete its session file (by default
   `~/.config/memory-system/telegram.session`) and its staging file (by
   default `<data root>/storage/tmp/telegram-staging.jsonl`, which goes with
   the data root in step 3), and end the session from Telegram's own device
   list.
6. In System Settings, Privacy and Security, Full Disk Access: remove the
   `node` entry if you added one for a connector.

npm's and uv's caches in your home directory are shared with other projects;
clear them with those tools if you want the space back.

## Troubleshooting

Installer messages. A message starts with `install:` unless the row shows
another prefix (`models:`, `download-models:`, `render-launchd:`). The
prerequisite and argument checks (the first six rows) stop before anything is
written; each later row comes from a single mode, after any earlier mode in
the same run has done its work:

| Message | Fix |
| --- | --- |
| `this installer supports macOS only` | There is no installer for other systems. |
| `Node.js 22.18 or newer is required, and no node was found on PATH` | Install Node.js and open a new shell. |
| `Node.js 22.18 or newer is required (found ...)` | Upgrade Node.js, or put a newer one first on `PATH`. |
| `npm was not found on PATH` | Reinstall Node.js; npm ships with it. |
| `the Xcode Command Line Tools (C compiler) are required` | Run `xcode-select --install`, finish the dialog, run the installer again. |
| `unknown argument: ...` | Use only the flags in the table above. |
| `the embedder environment needs Python 3.13: install uv, or put python3.13 on PATH` (or the speech-to-text one, 3.12) | Install `uv`, or that Python version. |
| `HOME is not set` | Run `--services` from a normal login shell. |
| `models: nothing downloaded; re-run with --models --yes to download.` | Expected without `--yes`; the exit code is 1 by design. |
| `download-models: hf CLI for the ... model not found` | Run `--python` first. |
| `download-models: skipping the stt model: voice-note transcription needs Apple Silicon (MLX); this Mac is ...` | Expected on Intel: the embedding and rerank models still download. |
| `download-models: the stt model needs Apple Silicon (MLX); this Mac is ... Nothing downloaded.` | You asked for `--only stt` on Intel. Voice-note transcription is not available there. |
| `render-launchd: --install refused: --home ... is not the home directory of the current account` | Render for your own account. |
| `render-launchd: launchctl bootstrap failed for ...` | The service is usually already loaded: boot it out, then install again. |

Install check lines:

| Line | Meaning and fix |
| --- | --- |
| `[FAIL] node version: ... is too old` | The `node` running the check is below the floor. |
| `[FAIL] dependencies load: modules in mcp/node_modules did not import` | `npm ci` did not finish, or Node changed since. Run `bash scripts/install.sh --core` again. |
| `[FAIL] server handshake: the server exited early` | The server stopped at start. Run `node mcp/server.js` in the checkout to see why. The usual cause is a malformed file in `<data root>/config/`: the error names it. |
| `[FAIL] server handshake: no answer within 60 seconds` | The server started but did not answer. Run it by hand as above and read stderr. |
| `[FAIL] server handshake: the tool list lacks ...` | The checkout is incomplete or modified. |
| `[FAIL] server handshake: skipped because the dependencies did not load` | Fix the dependencies line first. |
| `[FAIL] data root writable: ... (missing)` or `(not writable)` | Run `--core` again to create the directories, or fix their permissions. With a split root, check that you passed `--data-root`. |
| `[--] optional: ... is still the unedited example` | Edit your operator identity file. |
| `[--] optional: ... is readable by others` | `chmod 600` the secrets file. |

Other symptoms:

- **`memory_put` answers `SCOPE_BLOCKED`.** The install has a vector index or
  runs the query daemon. Start the server with `MEMORY_PUT_ENABLED=1`. The
  put is then stored, but `memory_recall` does not return it by default: it
  has no embedding, no re-embed sweep entry is written, and it joins the
  lexical index only with `MEMORY_BM25_DECOUPLE_EMBED=1` (off by default); see
  [kb/mcp-surface.md](kb/mcp-surface.md) under `memory_put`.
- **Recall is marked `degraded_recall`.** The embedding server is not running
  or not reachable. That is the normal state of a core-only install.
- **A service restarts in a loop.** Read its `.stderr` log. For the two model
  servers the cause is a missing Python environment or model.
- **A connector logs a permission error.** It needs Full Disk Access for the
  exact `node` binary named in its rendered service file; see
  [docs/CONNECTORS.md](docs/CONNECTORS.md).
