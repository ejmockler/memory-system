# Environment variables

Nothing in this file is required for the core install. With no variable set,
the MCP server, the daemons and the local model servers all start with the
defaults listed below, and every data path resolves inside the checkout.

A commented template with the commonly set variables is in
[`.env.example`](../.env.example). Nothing loads that file automatically: copy
the lines you need into one of the places described next.

## How a variable reaches a process

There are three kinds of process, and each gets its environment from a
different place.

- **The MCP server** (`mcp/server.js`) inherits the environment of the client
  that launches it. Put variables in the `env` block of the server entry in the
  client's MCP config (see `mcp/.mcp.json.example` for the entry shape).
- **launchd services started through the wrapper** (`watermark`,
  `git-log-connector`, `slack-connector`) run under `launchd/run-with-env.sh`,
  which sources `<MEMORY_ROOT>/config/secrets.env` and exports every variable in
  it before starting the service. The wrapper refuses a secrets file that group
  or other can read or write, so run `chmod 600` on it. A missing file is not
  an error: the service starts without credentials. The `telegram` service
  uses `daemons/telegram-tail-run.sh`, which applies the same mode rule to the
  file its plist template names (the same `config/secrets.env`).
- **Every other launchd service** (`queryd`, `embed-server`, `rerank-server`,
  `embed-watchdog`, `reembed-drain` and the remaining connectors) reads only the
  `EnvironmentVariables` block of its plist template in `launchd/`. Edit the
  template before rendering it with `scripts/render-launchd.mjs`. Never put a
  credential in a plist: plists are world-readable.

The MCP server and the services are separate processes. A variable that both
sides must agree on, such as `MEMORY_ROOT`, has to be set in both places.

Two rules about values apply throughout:

- **Set but empty is not always the same as unset.** The Node code mostly
  treats an empty string as unset. The Python servers do not: an empty
  `EMBED_PORT` fails at startup. In a secrets file, delete or comment out a
  line you do not use instead of leaving it empty.
- **Flags are matched exactly.** Where the Effect column says "`1`", only that
  string enables the flag; `true`, `yes` and `on` do not, unless the row lists
  them.

Rows marked **Safety gate** change what may be written or skipped. Rows marked
**Off-machine** cause data to leave the computer.

## Roots and paths

Resolution order for a directory that code takes from `mcp/lib/config.js`
(the server, its tools and most of the `watermark` service): the per-directory
variable wins if set; otherwise `MEMORY_ROOT` plus the conventional suffix;
otherwise the checkout that contains `mcp/` plus the same suffix. The checkout
is located from the code's own file path, never from the current directory or
the home directory.

Some code builds its paths from `MEMORY_ROOT` (or the checkout) directly and
ignores the per-directory variables:

- the hooks `hooks/stop-hook.sh`, `hooks/recall-engagement-detect.sh` and
  `hooks/session-end-hook.sh`, which use `<MEMORY_ROOT>/hooks`,
  `<MEMORY_ROOT>/storage` and `<MEMORY_ROOT>/policy`;
- the re-embed drain `daemons/reembed-drain.mjs`, which reads
  `<MEMORY_ROOT>/ledgers/memory.jsonl` and keeps its cursor in
  `<MEMORY_ROOT>/policy`;
- the connectors' default source-ledger path,
  `<MEMORY_ROOT>/storage/sources/<source>.jsonl`
  (`mcp/lib/connectors/index.js`);
- the Telegram capture's default staging file and the embedding watchdog's
  default log file.

So set the per-directory variables only if you also keep these in step, or
use `MEMORY_ROOT` alone.

| Variable | Default | Effect |
| --- | --- | --- |
| `MEMORY_ROOT` | the checkout that contains `mcp/` | Data root for ledgers, storage, policy, indices, telemetry, connector state, hook state and config. Code assets (virtualenvs, scripts) and the launchd service logs (`<checkout>/daemons/logs`, `<checkout>/local-embedder/logs`) stay in the checkout even when this points elsewhere. Read by the server, every daemon, the hooks and the launchd wrapper. |
| `POLICY_BASE_DIR` | `<MEMORY_ROOT>/policy` | Policy state directory. Wins over `MEMORY_ROOT` for this directory only. |
| `STORAGE_BASE_DIR` | `<MEMORY_ROOT>/storage` | Storage directory (source ledgers, caches, queues). Wins over `MEMORY_ROOT` for this directory only. |
| `LEDGERS_BASE_DIR` | `<MEMORY_ROOT>/ledgers` | Directory holding the memory ledger. Wins over `MEMORY_ROOT` for this directory only. |
| `DAEMONS_BASE_DIR` | `<MEMORY_ROOT>/daemons` | Resolved by `mcp/lib/config.js`, but no shipped code uses the result, so setting it has no effect. Service logs are named in the plist templates. |
| `HOOKS_BASE_DIR` | `<MEMORY_ROOT>/hooks` | Resolved by `mcp/lib/config.js`, but no shipped code uses the result, so setting it has no effect: the hooks always use `<MEMORY_ROOT>/hooks`. |
| `CONNECTORS_BASE_DIR` | `<MEMORY_ROOT>/connectors` | Per-connector cursor state (`<source>/state.json`). Wins over `MEMORY_ROOT` for this directory only. |
| `TELEMETRY_BASE_DIR` | `<MEMORY_ROOT>/telemetry` | Directory of the per-call telemetry file. Wins over `MEMORY_ROOT` for this directory only. |
| `QUARANTINE_BASE_DIR` | `<STORAGE_BASE_DIR>/quarantine` | Where rows rejected at ingest are kept for restore. Wins over both `STORAGE_BASE_DIR` and `MEMORY_ROOT`. Read by `mcp/lib/ingest/quarantine.js`. |
| `MEMORY_OPERATOR_IDENTITY_FILE` | `<MEMORY_ROOT>/config/operator-identity.json` | File that lists which addresses and handles are you. Resolved once when the process starts. Shape: `config/operator-identity.example.json`. |

## Server and tools

Set these in the MCP client config.

| Variable | Default | Effect |
| --- | --- | --- |
| `MEMORY_ROLE` | `agent` | **Safety gate.** Launch identity of the server, read once at startup. The distillation-only tools (`memory_distill_promote_fact`, `memory_distill_emit_reconstructed`) return `SCOPE_BLOCKED` unless this is `distillation`. |
| `MEMORY_PUT_ENABLED` | unset | **Safety gate.** Controls `memory_put`. `1` or `true` turns it on; `0` or `false` turns it off. Unset, it is on only for a standalone first run that has no vector index and is not served by `queryd`, and off on every configured install. |
| `MEMORY_QUERYD` | `auto` | Where recall loads its indexes. `auto` uses the `queryd` daemon when its socket answers, otherwise loads in-process. `required` always uses the daemon. `off` always loads in-process. Any other value is treated as `required`, with one warning on stderr. |
| `MEMORY_MCP_SHUTDOWN_GRACE_MS` | `5000` | How long the server waits for in-flight tool calls to finish before it exits on shutdown. |
| `MEMORY_MCP_PPID_POLL_MS` | `15000` | How often the server checks whether its parent process is gone, so an orphaned server exits. |
| `CATCHUP_PROJECTION` | on | `memory_catchup` uses its projection fast path unless this is `0`, which restores the full-stream read. |
| `MEMORY_BM25_DECOUPLE_EMBED` | off | `1` or `true` keeps the lexical index updated for a row even when embedding it fails. Read wherever a memory is written: set it in the MCP client config for `memory_put` (see `memory_put` in [kb/mcp-surface.md](../kb/mcp-surface.md)) and for the `watermark` service for ingested rows. |

## Recall and ranking

Set these in the MCP client config. The index-save variables also apply to the
`watermark` service, which writes the indexes.

| Variable | Default | Effect |
| --- | --- | --- |
| `LOCAL_RERANKER_ENABLED` | on | `1` or `true` reranks with the local reranker; `0` or `false` selects the cloud reranker instead, which needs a Gemini key (see Cloud keys). Any other value keeps the default. |
| `LOCAL_RERANKER_URL` | `http://127.0.0.1:8360` | Base URL of the reranker. **Off-machine** if it is not a loopback address: the query and candidate memory text are posted to it. |
| `LOCAL_RERANKER_TIMEOUT_MS` | `8000` | Per-request timeout for the reranker. On timeout recall degrades to the unreranked order. |
| `LOCAL_EMBED_URL` | `http://127.0.0.1:8359` | Base URL of the embedding server, used by recall, ingest and the re-embed drain. **Off-machine** if it is not a loopback address: memory and query text are posted to it. |
| `LOCAL_EMBED_TIMEOUT_MS` | `60000` | Per-request timeout for the embedding server. Must be a positive integer, otherwise the default applies. The maintenance script `mcp/scripts/reembed-local-4096.mjs` uses `600000` when this is unset. |
| `MEMORY_ENTITY_ALIAS_OVERLAY` | off | `1` resolves entity aliases through the alias overlay when recall matches entities. |
| `MEMORY_RECALL_ENTITY_MATCHKEY_LOOKUP` | off | `1` makes the entity lookup source-agnostic, so the same entity recorded by two sources is found as one. |
| `ENTITY_INDEX_CHECKPOINT_CACHE` | off | `1` or `true` validates the cached entity index against a checkpoint instead of rebuilding it. |
| `HNSW_CAPACITY_WARN_FRACTION` | `0.75` | Fraction of the vector index capacity at which a one-time warning is logged. Must be greater than 0 and at most 1, otherwise the default applies. |
| `INDEX_SAVE_WAL_RECORDS` | `8192` | A full index save is triggered once this many unsaved additions sit in the write-ahead log. |
| `INDEX_SAVE_WAL_BYTES` | `67108864` | Same trigger, measured in bytes of write-ahead log (64 MiB). |
| `INDEX_SAVE_MAX_STALENESS_MS` | `21600000` | Same trigger, measured as the age of the oldest unsaved addition (6 hours). |
| `INDEX_SAVE_BATCH` | unset | Legacy override: when set to a positive integer, a full index save also triggers after that many additions. Unset contributes nothing. |
| `INDEX_SAVE_MAX_AGE_S` | unset | Legacy override: when set to a positive number of seconds, replaces the quiet-period budget otherwise taken from `INDEX_SAVE_MAX_STALENESS_MS`. |

## Ingest and connectors

Set these for the service that runs the connector: in
`<MEMORY_ROOT>/config/secrets.env` for wrapped services, in the plist template
otherwise. Connector credentials are listed under Cloud keys.

| Variable | Default | Effect |
| --- | --- | --- |
| `GIT_LOG_REPO_ROOTS` | Five roots: `~/Documents`, `~/projects`, `~/code`, the checkout, and the home directory | Colon-separated directories the git-log connector searches for repositories. Setting it replaces the whole default list. |
| `GIT_LOG_OPERATOR_EMAILS` | empty | Colon-separated author addresses that count as you, for example `alex@example.com:alex@example.org`. Added to the identity file's list; it cannot remove an entry. |
| `CODEX_CLI_SESSIONS_GLOB` | `~/.codex/sessions/*/*/*/rollout-*.jsonl` | Colon-separated glob patterns the Codex CLI connector reads session files from. |
| `CODEX_CLI_CONSENT_BASIS` | `first_party` | Consent basis stamped on ingested Codex sessions. Set `second_party_dm` when the sessions are shared with another person. |
| `CODEX_CLI_FORCE_CWD` | unset | Working directory recorded for every Codex session. Unset, the session's own directory is used, then the connector's current directory. |
| `CODEX_AUTOMATION_DONE_PREFIX` | unset | When set, Codex assistant turns with no user text that begin with this marker are treated as automation status payloads and quarantined instead of ingested. Read by the `watermark` daemon's first filtering step. |
| `SLACK_WORKSPACE_IDS` | empty | Comma-separated workspace ids the Slack connector ingests. The connector does nothing without it. |
| `SLACK_POLL_INTERVAL_SECONDS` | `600` | Seconds between Slack polls. |
| `SLACK_HISTORY_PAGE_LIMIT` | `200` | Messages requested per history page. |
| `SLACK_CONVERSATIONS_PAGE_LIMIT` | `200` | Conversations requested per listing page. |
| `TELEGRAM_SESSION_FILE` | `~/.config/memory-system/telegram.session` | Session file written by `telegram_login.py` and read by the Telegram capture. `TELEGRAM_SESSION_STRING` wins when both are set. |
| `TELEGRAM_STAGING_FILE` | `<MEMORY_ROOT>/storage/tmp/telegram-staging.jsonl` | File the Telegram capture appends events to and the connector drains. It contains message text. Both sides must use the same value; with nothing set they resolve the same default. When you set it, give the MCP server process the same value too: its Telegram stall detector reads this file and does not see the launchd services' environment. |
| `TELEGRAM_CHANNEL_ALLOWLIST` | empty | Comma-separated channel ids you own or curate. Broadcast-channel posts from any other channel are dropped at ingest. Read once at startup. |
| `QUARANTINE_RETENTION_DAYS` | `30` | Days a quarantined row is kept. Must be a positive number, otherwise the default applies. |
| `MEMORY_GH_REPO_PRECISE` | off | `1` applies the stricter GitHub repository-path rule when entities are extracted. |
| `MEMORY_LEDGER_ROW_EMBEDDING_4096` | off | `1` or `true` stores the full embedding vector on the ledger row (the legacy layout) instead of only in the index. |
| `MEMORY_SALIENCE_BYPASS` | off | **Safety gate.** `1` or `true` skips the salience filter, so every promotion attempt writes a memory row with no filtering. Meant for tests; never set it on a real install. |
| `MEMORY_SCREENTIME_CAPTURED_STREAMS_OVERRIDE` | `/app/intents`, `/app/usage`, `/app/webUsage` | **Safety gate.** Comma-separated list that replaces the set of Screen Time streams the connector captures. Widening it captures browsing and search streams the default leaves out. |
| `MEMORY_WATERMARK_CAPTURED_ONLY_OVERRIDE` | `screentime` | **Safety gate.** Comma-separated list that replaces the set of sources that are captured but never promoted to memory. An empty string empties the set, so every source is promoted. |
| `MEMORY_OPERATOR_ALIAS_NAME_TOKENS_OVERRIDE` | unset | **Safety gate.** Comma-separated name tokens that replace the ones derived from your registered addresses when candidate aliases of you are detected. |

## Embedder, reranker and voice

The two model servers read only their plist template. Ports and hosts must
agree with `LOCAL_EMBED_URL` and `LOCAL_RERANKER_URL` above.

| Variable | Default | Effect |
| --- | --- | --- |
| `EMBED_MODEL` | `Qwen/Qwen3-Embedding-8B` | Hugging Face model id the embedding server loads. Also read by `scripts/download-models.sh`. |
| `EMBED_MODEL_VERSION` | `qwen3-embedding-8b-fp16` | Version string stamped on every response and stored with each vector. Change it whenever you change the model. |
| `EMBED_DEVICE` | auto | Torch device. Unset means auto-detect: `mps`, then `cuda`, then `cpu`. |
| `EMBED_HOST` | `127.0.0.1` | Address the embedding server binds. Binding a non-loopback address exposes an unauthenticated server to the network. |
| `EMBED_PORT` | `8359` | Port the embedding server binds. |
| `EMBED_DEFAULT_DIM` | `0` | Output dimension when a request does not ask for one. `0` means the model's native dimension. |
| `EMBED_MAX_SEQ_TOKENS` | `2048` | Hard cap on tokens per text; longer input is truncated. |
| `EMBED_MAX_BODY_BYTES` | `8388608` | Largest request body accepted (8 MB); larger requests get a 413. |
| `EMBED_MAX_INFLIGHT` | `8` | Requests allowed to wait on or hold the model at once; more get a 429. |
| `EMBED_REQUEST_DEADLINE_MS` | `55000` | Deadline for a queued request; one that expires before reaching the model is dropped. |
| `EMBED_MAX_BATCH_TOKENS` | `16384` | Padded-token budget for one forward pass; the batch size is derived from it. |
| `EMBED_MAX_BATCH_SIZE` | `64` | Ceiling on texts per forward pass. |
| `EMBED_MPS_EMPTY_CACHE_EVERY` | `1` | Release the Metal allocator cache after every Nth encode. `0` disables it. |
| `EMBED_DRAIN_TIMEOUT_S` | `20` | Seconds the server waits for the in-flight encode to finish on shutdown. |
| `EMBED_RECYCLE_AFTER_REQUESTS` | `0` | Exit cleanly after this many served requests so launchd restarts the server with fresh memory. `0` disables it. The shipped plist template sets `128`. |
| `EMBED_DEGENERATE_NORM_TOL` | `0.05` | How far a vector's length may be from 1 before the row is treated as corrupt and re-encoded. |
| `EMBED_DEGENERATE_RETRY_MAX` | `8` | Single-row re-encodes allowed per request for corrupt rows. `0` disables recovery. |
| `RERANK_MODEL` | `Qwen/Qwen3-Reranker-0.6B` | Hugging Face model id the reranker loads. Also read by `scripts/download-models.sh`. |
| `RERANK_MODEL_VERSION` | `qwen3-reranker-0.6b` | Version string the reranker reports. |
| `RERANK_DEVICE` | auto | Torch device, same auto-detection as `EMBED_DEVICE`. |
| `RERANK_HOST` | `127.0.0.1` | Address the reranker binds. Binding a non-loopback address exposes an unauthenticated server to the network. |
| `RERANK_PORT` | `8360` | Port the reranker binds. |
| `RERANK_MAX_TOKENS` | `2048` | Token cap per query-candidate pair; longer input is truncated. |
| `WHATSAPP_VOICE_STT` | on | **Safety gate.** The WhatsApp connector transcribes one-to-one voice notes on this machine unless this is `0`. Set `0` to stop audio being transcribed and stored as text. |
| `STT_MODEL` | `mlx-community/whisper-large-v3-turbo` | Speech-to-text model the voice worker (`scripts/stt/stt_batch.py`) loads. Also read by `scripts/download-models.sh`. |
| `GAMEPAUSE_FLAG` | unset (no pause check) | Path of a pause flag: while that file exists the voice worker exits without loading the model and the WhatsApp connector skips voice batches. When unset or empty no path is read. The connector passes a value from its environment through to the worker; an explicit pause-flag option (such as `WHATSAPP_VOICE_PAUSE_FLAG` in `--backfill-voice` mode) wins over it. |

## Daemons

| Variable | Default | Effect |
| --- | --- | --- |
| `MEMORY_WATERMARK_PAUSE_SYNTHESIS` | off | **Safety gate.** `1` suspends thread and project aggregation in the `watermark` daemon. Ingest continues; no new aggregate memories are produced until it is cleared and the daemon restarted. |
| `MEMORY_WATERMARK_ERROR_QUARANTINE_ENABLED` | off | **Safety gate.** `1` makes the `watermark` daemon write a row that failed with an error to the quarantine. Off, such a row is not quarantined. |
| `QUERYD_MODEL_VERSIONS` | the active local model version plus the legacy cloud embedding version | Comma-separated model versions whose indexes `queryd` loads and serves. The shipped plist template sets only `qwen3-embedding-8b-fp16`. |
| `REEMBED_BATCH` | `200` | Most rows the re-embed drain embeds per run. The shipped plist template sets `1000`. |
| `REEMBED_WORK_SET` | `sweep` | How the drain finds rows that lack a vector. `sweep` reads the sweep file in `<MEMORY_ROOT>/policy`; `ledger` derives the set from the memory ledger. |
| `REEMBED_HEALTH_TIMEOUT_MS` | `10000` | Timeout for the drain's health check of the embedding server before it starts work. |
| `REEMBED_DRAIN_STALE_LOCK_SECONDS` | `21600` | Age after which the drain reclaims a lock file left by a run that is no longer alive (6 hours). |
| `EMBED_SERVER_LABEL` | `com.user.memory-system.embed-server` | launchd label the drain looks up to find the embedding server's process id. Read-only lookup. |
| `ACTIVE_EMBED_MODEL_VERSION` | `qwen3-embedding-8b-fp16` | Model version, and so the `<MEMORY_ROOT>/indices/<version>` tree, that the re-embed drain and `mcp/scripts/reembed-local-4096.mjs` write to. It does not change the version recall reads, which is fixed in `mcp/lib/validation.js`. Leave it unset unless you are running a deliberate re-embed. |

## Cloud keys

Every variable in this table makes a process talk to a third party. None is
needed for a local-only install, and none ever belongs in a plist.

- The Gemini keys are read only by the MCP server, for the cloud reranker
  (`mcp/lib/recall/rerank.js`, used only when `LOCAL_RERANKER_ENABLED=0`), and
  by the manual script `scripts/backfill-embeddings.mjs`. Put them in the `env`
  block of the server entry in your client's MCP config, or in the shell you
  run the script from. No launchd service reads them, so `secrets.env` is the
  wrong place for them.
- The Slack and Telegram credentials go in `<MEMORY_ROOT>/config/secrets.env`
  (mode 600).

| Variable | Default | Effect |
| --- | --- | --- |
| `GEMINI_API_KEYS` | unset | **Off-machine.** Comma-separated pool of Gemini API keys for the cloud reranker and the manual embedding backfill. When a key is used, memory or query text is sent to Google. Wins over `GEMINI_API_KEY` when both are set (one warning on stderr). |
| `GEMINI_API_KEY` | unset | **Off-machine.** Single Gemini API key for the same two uses. Ignored when `GEMINI_API_KEYS` is set. |
| `SLACK_USER_TOKEN` | unset | **Off-machine.** User token the Slack connector calls the Slack API with. It downloads your workspace messages to this machine. A per-workspace token wins over it (see the last section). |
| `SLACK_API_BASE` | `https://slack.com/api` | **Off-machine.** Base URL the Slack connector sends its requests and the token to. Change it only to point at a test server you control. |
| `TELEGRAM_API_ID` | unset | **Off-machine.** Numeric id of your own Telegram application. Required by `telegram_login.py`; unset, the capture falls back to placeholder values. |
| `TELEGRAM_API_HASH` | unset | **Off-machine.** API hash paired with `TELEGRAM_API_ID`. |
| `TELEGRAM_SESSION_STRING` | unset | **Off-machine.** A Telegram login session, as a string. It is a full credential for your account. Wins over `TELEGRAM_SESSION_FILE` when both are set. |

## Testing and diagnostics

These exist in shipped runtime code but are for measurement and tests. Leave
them unset in normal use.

| Variable | Default | Effect |
| --- | --- | --- |
| `RECALL_PROF` | off | `1` prints per-stage timing of each recall to stderr. |
| `MEMORY_RECALL_LIVENESS_GATE` | off | `1` adds a recall-liveness verdict to `memory_health`. |
| `HEALTH_ENVELOPE_CACHE_BUCKET_MS` | `60000` | How long a computed `memory_health` result may be reused. Must be a positive number, otherwise the default applies. |
| `TELEMETRY_MAX_BYTES` | `33554432` | Size at which the per-call telemetry file is rotated (32 MiB). |
| `TELEMETRY_MAX_PENDING` | `1024` | Telemetry lines allowed to wait for the disk; beyond that, lines are dropped and counted. |
| `TELEMETRY_MAX_PENDING_BYTES` | `1048576` | Same bound, in bytes (1 MiB). |
| `WATERMARK_HEARTBEAT_OVERRIDE_SECONDS` | `5` | Heartbeat interval of the `watermark` daemon in seconds, with a floor of 1. |

## Test-only and maintenance-script variables

Each of these is read by a test seam or by one script that is run by hand.
None belongs in a normal install.

| Variable | Default | Effect |
| --- | --- | --- |
| `EMBED_FAKE_MODEL` | off | `1` makes the embedding server use a stub model instead of loading torch. Test seam. |
| `EMBED_FAKE_DIM` | `8` | Vector dimension of the stub model. |
| `EMBED_FAKE_LATENCY_MS` | `0` | Sleep per encode in the stub model. |
| `EMBED_FAKE_NAN_MARKER` | a NUL byte followed by `NAN` | Substring that makes the stub return a not-a-number row in a batch. |
| `EMBED_FAKE_NAN_ALWAYS` | off | `1` makes that fault persist when the row is retried alone. |
| `EMBED_FAKE_GARBAGE_MARKER` | a NUL byte followed by `GARBAGE` | Substring that makes the stub return a finite but corrupt row in a batch. |
| `MEMORY_TEST_STUB_EMBEDDER` | off | `1` makes the `watermark` daemon use a fixed stub vector instead of the embedding server. Tests only; it would corrupt a real index. |
| `REQUIRE_HERMETIC` | unset | Set to `1` by `mcp/scripts/run-all-tests.mjs` for one suite. `mcp/scripts/rerank-hermeticity-probe.mjs` refuses to run if it is already set. |
| `CATCHUP_EQUIV_RED` | off | `1` runs `mcp/scripts/catchup-equivalence.mjs` in its deliberately failing mode. |
| `RANKING_EVAL_GOLDSET` | off | `1` makes `mcp/scripts/run-calibration-cycle.mjs` use the ranking gold set; same as its `--ranking-goldset` flag. |
| `MEMORY_LEDGER_PATH` | unset | Ledger path for `mcp/scripts/run-feature-backfill.mjs` when `--ledger` is not given. Nothing else reads it. |
| `USERPROFILE` | unset | Fallback for the home directory in `scripts/spec-sweep.mjs` when the standard home variable is unset. |

## Generic variables

`HOME` and `PATH` are read the usual way. The home directory decides the
defaults that are written above as "under the home directory" or with a leading
`~`. Most plist templates set both. Three do not: `queryd` and `telegram`
set `HOME` but not `PATH`, and `rerank-server` sets neither; for the
variables a template does not set, the service gets whatever launchd supplies
by default. The voice worker is
started with `/opt/homebrew/bin` and `/usr/local/bin` put in front of `PATH`
so it can find `ffmpeg`.

## Variables the scanner does not list

The names below are read by shipped code but are looked up through a constant,
an injected environment object or a shell script, so the automated inventory
does not see them. They are documented here in prose.

Recall and ranking flags, set in the MCP client config. Only the exact string
`1` enables each one.

- MEMORY_ENTITY_IDF_ENABLED: weights entity overlap by how rare the entity is.
  Default off. Named in `mcp/lib/recall/multi-feature-score.js` and read in
  `mcp/lib/tools/recall.js`.
- MEMORY_ENTITY_NOISE_FILTER: drops role labels and conversation ids from
  entity overlap. Default off. `mcp/lib/recall/multi-feature-score.js`.
- MEMORY_SCORE_EPISODICITY_ABLATE: removes the episodicity term from the score,
  for measurement. Default off. `mcp/lib/recall/multi-feature-score.js`.
- MEMORY_SCORE_WEIGHTS_ENABLED: applies learned score weights instead of the
  fixed ones. Default off. `mcp/lib/recall/score-weight-overlay.js`.
- MEMORY_RECALL_QUERY_GAZETTEER_ENABLED: adds gazetteer matches to the entities
  found in the query. Default off, read once at startup.
  `mcp/lib/validation.js`.
- MEMORY_BM25_MODEL_NEUTRAL: recall loads the model-neutral lexical index.
  Default off. `mcp/lib/recall/bm25-projection.js`.

Ingest and daemon flags, set for the `watermark` service.

- MEMORY_STRUCTURAL_FLOOR_ENABLED: **safety gate.** `1` turns on a minimum
  structural score below which a row is not promoted. Default off, which means
  a floor of 0.0. `mcp/lib/caps.js`.
- MEMORY_STRUCTURAL_FLOOR_VALUE: the floor used when the flag above is on. A
  number from 0 to 1; absent or invalid means 0.05. `mcp/lib/caps.js`.
- MEMORY_MAIL_STAGE0_PERSON_SENDER_EXEMPT_ENABLED: on unless `0`. When on, mail
  from a person-shaped sender is exempt from one automated-mail drop rule.
  `mcp/lib/validation.js`.
- MEMORY_INCREMENTAL_AGGREGATION_ENABLED: `1` makes aggregation resume from a
  saved offset instead of rescanning the ledger. Default off in code; the
  shipped `watermark` plist template sets `1`. `mcp/lib/validation.js`.
- MEMORY_BM25_REBUILD_TARGET_ACTIVE: `1` arms the daemon's periodic lexical
  rebuild and targets the active model's index tree. The shipped `watermark`
  plist template sets `1`. `mcp/lib/recall/bm25-rebuild.js`.
- MEMORY_BM25_REBUILD_TARGET_LEGACY: `1` arms the rebuild and targets the legacy
  cloud model's tree instead. Wins over the flag above. Default off.
- MEMORY_BM25_REBUILD_OBJECT_ENTITIES: `1` includes object-shaped entities in
  the rebuilt lexical index. The shipped `watermark` plist template sets `1`.
- SCREENTIME_INIINTENT_NULL_VERB_MODE: `count_only` counts, instead of
  dropping, one class of Screen Time rows. Anything else means drop.
  `mcp/lib/ingest/stage0/screentime.js`.
- SCREENTIME_INIINTENT_NULL_VERB_UNTIL: a timestamp after which `count_only`
  reverts to drop.
- Per-workspace Slack tokens: a variable named SLACK_USER_TOKEN_ followed by a
  workspace id holds the token for that workspace and wins over
  SLACK_USER_TOKEN for it. **Off-machine**, same as the shared token.
  `mcp/lib/connectors/slack.js`.

Diagnostics.

- MEMORY_DEBUG: `1` prints a one-time line on stderr when the Codex CLI
  filtering module is loaded. Default off. `mcp/lib/ingest/stage0/codex-cli.js`.

Re-embed drain throttle, set in the `reembed-drain` plist template.

- REEMBED_THROTTLE: on unless `0`. When on, the drain passes a batch size and a
  pause to the re-embed child process. `daemons/reembed-drain.mjs`.
- REEMBED_BATCH_TEXTS: texts per embedding request, default 16. A value that is
  not a positive integer is refused and the default used.
- REEMBED_PAUSE_MS: pause between requests in milliseconds, default 250. Same
  validation.

Voice backfill, read only by the WhatsApp connector's `--backfill-voice` mode
(`mcp/lib/connectors/whatsapp.js`). That mode transcribes regardless of
`WHATSAPP_VOICE_STT`.

- WHATSAPP_VOICE_PAUSE_FLAG: pause flag path; default is `GAMEPAUSE_FLAG`
  when that is set, otherwise none (no pause check).
- WHATSAPP_STT_PYTHON: Python interpreter for the worker; default
  `.venv-stt/bin/python` in the checkout.
- WHATSAPP_STT_SCRIPT: worker script; default `scripts/stt/stt_batch.py` in the
  checkout.
- WHATSAPP_VOICE_MEDIA_ROOT: where voice-note audio is read from; default is
  the WhatsApp desktop app's shared container under the home directory.
- WHATSAPP_VOICE_TMP_DIR: scratch directory; default
  `<STORAGE_BASE_DIR>/tmp/voice`.

Shell scripts.

- MEMORY_SECRETS_FILE: the file `launchd/run-with-env.sh` sources. Default
  `<MEMORY_ROOT>/config/secrets.env`. The mode-600 rule applies to whatever
  file is named.
- TELEGRAM_ENV_FILE: the file `daemons/telegram-tail-run.sh` sources. When it
  is unset the script uses `<MEMORY_ROOT>/config/secrets.env` if that file
  exists, and otherwise `telegram.env` in `.config/memory-system` under the
  home directory. The shipped `telegram` plist template sets it to
  `<MEMORY_ROOT>/config/secrets.env`. The mode-600 rule applies to whichever
  file is chosen, and the script exits if that file is missing.
- WATCHDOG_LABEL: launchd label `daemons/embed-watchdog.sh` watches. Default
  `com.user.memory-system.embed-server`.
- WATCHDOG_THRESHOLD_GB: memory footprint at which the watchdog restarts the
  embedding server. Default 30; the shipped plist template sets 45.
- WATCHDOG_HARD_CEILING_GB: footprint at which it restarts the server even
  while it is busy. Default 80.
- WATCHDOG_BUSY_CMD: command whose non-empty output means the server is busy.
  Default is an `lsof` probe of port 8359, so change it if you change
  `EMBED_PORT`.
- WATCHDOG_LOG: log file. Default `<MEMORY_ROOT>/daemons/logs/embed-watchdog.log`.
- WATCHDOG_TERM_GRACE_S: seconds to wait after a polite stop before forcing a
  restart. Default 25.
- WATCHDOG_PID_CMD, WATCHDOG_FOOTPRINT_CMD, WATCHDOG_KICKSTART_CMD: test seams
  that replace how the watchdog finds the process, measures it and restarts it.
- HF_BIN and STT_HF_BIN: paths of the Hugging Face CLI used by
  `scripts/download-models.sh`. Defaults are the `hf` binaries in the two
  virtualenvs inside the checkout.
