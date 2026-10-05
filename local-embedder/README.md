# local-embedder

Two small HTTP servers that keep models warm on the local machine so the
memory-system can embed and rerank without sending any content to a cloud
service. Both bind to `127.0.0.1` only.

| Server | File | Port | Default model | What it does |
| --- | --- | --- | --- | --- |
| Embed server | `embed_server.py` | 8359 | `Qwen/Qwen3-Embedding-8B` | `POST /embed` turns texts into L2-normalized vectors (4096-dim native) for dense recall. |
| Rerank server | `rerank_server.py` | 8360 | `Qwen/Qwen3-Reranker-0.6B` | `POST /rerank` scores query/document pairs (probability of "relevant") for the final recall reordering. |

Each also answers `GET /health` with `ok`, `model`, `model_version` and
`device` (plus `native_dim` and counters on the embed server). The Node side
talks to them over HTTP (`mcp/lib/local-embedder-client.js`,
`mcp/lib/recall/local-reranker-client.js`).

**The embedder is optional.** The memory-system stores and recalls memories
without it, in lexical-only mode, today: a fresh install with neither server
running puts and recalls (`scripts/smoke.mjs` does exactly that). The embed
and rerank servers add dense retrieval and reranking on top. If you
do not have the hardware below, skip this directory.

## Hardware requirements (default tier)

The defaults are sized for a high-memory Apple Silicon Mac. Stated plainly:

- **Apple Silicon with MPS.** The default tier runs the 8B embedding model in
  fp16 on the Metal (MPS) backend. This is the only configuration that has
  been run in production.
- **Disk: about 14 GB for the embedder weights plus about 1.1 GB for the
  reranker** (sizes of the downloaded Hugging Face cache entries for the
  default models). The optional speech-to-text model
  (`mlx-community/whisper-large-v3-turbo`, used by `scripts/stt/`) adds
  about 1.6 GB.
- **RAM (unified memory): plan for generous headroom above the weights.**
  Numbers recorded in the code:
  - Under sustained load the embed server's memory footprint oscillated
    between 26 and 32 GB with the default mitigations on (the SOAK NUMBERS
    block in the `test_embed_bounds.py` docstring).
  - Before the token-area batch cap existed, a single wide batch of long
    texts produced transient MPS spikes measured at 47, 67, 71 and 77 GB
    (the `_batch_size_for` docstring in `embed_server.py`). The cap
    (`EMBED_MAX_BATCH_TOKENS`, `EMBED_MAX_BATCH_SIZE`) now bounds the padded
    token area of one forward pass, so those spikes are the reason for the
    cap, not the expected steady state.

  Reading those numbers together (an inference, not a separate
  measurement): 32 GB of unified memory is at the limit for the default
  embedder, and 64 GB or more leaves room for the reranker and everything
  else you run.

A smaller machine can still run a smaller model on another device (see
"Choosing a different model or device"), but read the 4096-dim warning first.

## Setup

From the repository root. Nothing here downloads model weights until you pass
`--yes` in the last step.

```bash
# 1. Create the environment with the recorded interpreter (.python-version: 3.13)
uv venv --python "$(cat local-embedder/.python-version)" local-embedder/.venv

# 2. Install the pinned packages
uv pip install --python local-embedder/.venv/bin/python -r local-embedder/requirements.txt

# 3. See what would be downloaded and how large it is (downloads nothing)
scripts/download-models.sh

# 4. Download the weights
scripts/download-models.sh --yes                    # embedder, reranker and STT (STT skipped on Intel)
scripts/download-models.sh --only embedder --yes    # or one at a time
scripts/download-models.sh --only reranker --yes
```

`scripts/download-models.sh` uses the `hf` CLI from this venv
(`local-embedder/.venv/bin/hf`, or `HF_BIN` if set); for the speech-to-text
model it uses `.venv-stt/bin/hf` (or `STT_HF_BIN`), built from
`scripts/stt/requirements.txt`. Downloads are resumable: re-run the same
command after a network drop. `download_reranker.sh` in this directory is a
thin wrapper around `scripts/download-models.sh --only reranker`.

`requirements.txt` also pins `telethon`: the Telegram connector shares this
venv. It is not used by the embed or rerank servers.

Run the servers in the foreground to check them:

```bash
HF_HUB_OFFLINE=1 local-embedder/.venv/bin/python local-embedder/embed_server.py     # http://127.0.0.1:8359
HF_HUB_OFFLINE=1 local-embedder/.venv/bin/python local-embedder/rerank_server.py    # http://127.0.0.1:8360
curl -s http://127.0.0.1:8359/health
```

`HF_HUB_OFFLINE=1` makes the Hugging Face libraries use only the local cache:
a server whose model is not downloaded stops with an error instead of
fetching it. The launchd service templates for both servers set it. Without
it, a server started by hand contacts Hugging Face to check for the model and
downloads it if it is missing.

`smoke_test.py` loads the embedding model, embeds a few synthetic sentences
and prints throughput. `test_embed_bounds.py` exercises the embed server's
request bounds with a fake model (no weights, no GPU, needs only `numpy`):

```bash
python3 local-embedder/test_embed_bounds.py
```

It runs the server with `EMBED_TEST_PYTHON` if set, else
`local-embedder/.venv/bin/python3` if present, else the interpreter you
invoked it with.

## Configuration

Both servers are configured by environment variables. With none set, the
behaviour is the default tier described above.

| Variable | Server | Default | Meaning |
| --- | --- | --- | --- |
| `EMBED_MODEL` | embed | `Qwen/Qwen3-Embedding-8B` | Hugging Face model id to load. |
| `EMBED_MODEL_VERSION` | embed | `qwen3-embedding-8b-fp16` | Version string stamped on every response and stored with each vector. Change it whenever you change the model. |
| `EMBED_DEVICE` | embed | auto | Torch device. Unset means auto-detect: `mps`, then `cuda`, then `cpu`. |
| `RERANK_MODEL` | rerank | `Qwen/Qwen3-Reranker-0.6B` | Hugging Face model id to load. |
| `RERANK_DEVICE` | rerank | auto | Torch device, same auto-detection as `EMBED_DEVICE`. |

The dtype follows the device: fp16 on `mps` and `cuda`, fp32 on `cpu`. The
resolved device is printed at startup and reported as `device` on `/health`.

Other knobs (`EMBED_HOST`, `EMBED_PORT`, `RERANK_HOST`, `RERANK_PORT`,
`RERANK_MODEL_VERSION`, the request bounds and batch limits) are listed with
their defaults in [docs/ENVIRONMENT.md](../docs/ENVIRONMENT.md), under
"Embedder, reranker and voice".

### Choosing a different model or device

```bash
# Force CPU (slow; fp32)
EMBED_DEVICE=cpu local-embedder/.venv/bin/python local-embedder/embed_server.py

# Larger reranker: download it, then start the server with it
RERANK_MODEL=Qwen/Qwen3-Reranker-4B scripts/download-models.sh --only reranker --yes
RERANK_MODEL=Qwen/Qwen3-Reranker-4B RERANK_MODEL_VERSION=qwen3-reranker-4b \
  local-embedder/.venv/bin/python local-embedder/rerank_server.py
```

A launchd service uses the model named in its plist template; to switch the
service, change `RERANK_MODEL` there (and add a `RERANK_MODEL_VERSION`
entry) before rendering.

Only the default tier (MPS, fp16) has been measured. `cuda` and `cpu` are
selected by the same code path but are untested here; expect CPU embedding
with the 8B model to be impractically slow.

**Warning: the Node client requires 4096-dimensional vectors.** The
memory-system's embedding client (`mcp/lib/local-embedder-client.js`) and its
vector index are built for the 4096-dim output of the default 8B model.
Pointing `EMBED_MODEL` at a smaller embedding model with a different native
dimension is not a drop-in change: it needs matching Node-side changes (the
expected dimension and the index) and a full re-embed of existing memories.
Changing only `EMBED_MODEL` will produce vectors the Node side rejects.

The reranker has no such constraint: any Qwen3-Reranker size works with
`RERANK_MODEL` alone.
