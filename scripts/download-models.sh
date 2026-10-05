#!/usr/bin/env bash
# download-models.sh — explicit, resumable download of the model weights the
# memory-system's optional local services use:
#
#   embedder  EMBED_MODEL   (default Qwen/Qwen3-Embedding-8B)        local-embedder/embed_server.py
#   reranker  RERANK_MODEL  (default Qwen/Qwen3-Reranker-0.6B)       local-embedder/rerank_server.py
#   stt       STT_MODEL     (default mlx-community/whisper-large-v3-turbo)  scripts/stt/stt_batch.py
#
# Nothing is downloaded unless --yes is given: without it the script prints
# the plan (each model and its approximate size) and exits non-zero.
#
# Usage:
#   scripts/download-models.sh                    # print the plan, download nothing
#   scripts/download-models.sh --yes              # download all three models
#   scripts/download-models.sh --only reranker --yes
#
# The Hugging Face CLI (`hf`) comes from the pinned venvs, never from an
# activated shell:
#   embedder, reranker: ${HF_BIN:-<repo>/local-embedder/.venv/bin/hf}
#                       (local-embedder/requirements.txt)
#   stt:                ${STT_HF_BIN:-<repo>/.venv-stt/bin/hf}, else HF_BIN
#                       (scripts/stt/requirements.txt)
#
# Downloads go to the standard Hugging Face cache. `hf download` is resumable
# and skips files already present, so re-running after a network drop (or when
# everything is cached) is safe. HF_HUB_DISABLE_XET=1 selects the plain HTTP
# transfer path, which has been the more reliable one for the large shards.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

EMBED_MODEL_DEFAULT="Qwen/Qwen3-Embedding-8B"
RERANK_MODEL_DEFAULT="Qwen/Qwen3-Reranker-0.6B"
STT_MODEL_DEFAULT="mlx-community/whisper-large-v3-turbo"

EMBED_MODEL="${EMBED_MODEL:-$EMBED_MODEL_DEFAULT}"
RERANK_MODEL="${RERANK_MODEL:-$RERANK_MODEL_DEFAULT}"
STT_MODEL="${STT_MODEL:-$STT_MODEL_DEFAULT}"

# Approximate on-disk sizes in GB. They describe the DEFAULT models only.
EMBED_GB="14"     # measured: Hugging Face cache entry after a full download
RERANK_GB="1.1"   # measured: Hugging Face cache entry after a full download
STT_GB="1.6"      # approximate, from the model listing (not measured locally)

usage() {
  cat <<'USAGE'
usage: download-models.sh [--only embedder|reranker|stt] [--yes]

  --only <which>  download just one model (default: all three; on a
                  non-arm64 Mac, embedder and reranker only)
  --yes           actually download; without it only the plan is printed
  -h, --help      show this help

env: EMBED_MODEL, RERANK_MODEL, STT_MODEL (model ids), HF_BIN, STT_HF_BIN (hf CLI paths)
USAGE
}

ONLY=""
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --only)
      shift
      [ $# -gt 0 ] || { echo "download-models: --only needs a value" >&2; usage >&2; exit 2; }
      ONLY="$1" ;;
    --only=*) ONLY="${1#--only=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "download-models: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

case "$ONLY" in
  "") SELECTED="embedder reranker stt" ;;
  embedder|reranker|stt) SELECTED="$ONLY" ;;
  *) echo "download-models: --only must be embedder, reranker or stt (got: $ONLY)" >&2; exit 2 ;;
esac

# The stt model runs on MLX, which is Apple Silicon only, and install.sh does
# not create .venv-stt on other chips. On a non-arm64 Mac, leave stt out of the
# default set so the embedder and reranker still download; an explicit
# `--only stt` is refused rather than fetching weights nothing can run.
ARCH="$(uname -m)"
if [ "$ARCH" != "arm64" ]; then
  if [ "$ONLY" = "stt" ]; then
    echo "download-models: the stt model needs Apple Silicon (MLX); this Mac is $ARCH. Nothing downloaded." >&2
    exit 2
  elif [ -z "$ONLY" ]; then
    SELECTED="embedder reranker"
    echo "download-models: skipping the stt model: voice-note transcription needs Apple Silicon (MLX); this Mac is $ARCH."
  fi
fi

model_for() {
  case "$1" in
    embedder) echo "$EMBED_MODEL" ;;
    reranker) echo "$RERANK_MODEL" ;;
    stt)      echo "$STT_MODEL" ;;
  esac
}

default_for() {
  case "$1" in
    embedder) echo "$EMBED_MODEL_DEFAULT" ;;
    reranker) echo "$RERANK_MODEL_DEFAULT" ;;
    stt)      echo "$STT_MODEL_DEFAULT" ;;
  esac
}

size_for() {
  case "$1" in
    embedder) echo "$EMBED_GB" ;;
    reranker) echo "$RERANK_GB" ;;
    stt)      echo "$STT_GB" ;;
  esac
}

size_note_for() {
  case "$1" in
    embedder|reranker) echo "measured" ;;
    stt)               echo "approximate, from the model listing" ;;
  esac
}

hf_for() {
  case "$1" in
    embedder|reranker) echo "${HF_BIN:-$ROOT/local-embedder/.venv/bin/hf}" ;;
    stt)
      if [ -n "${STT_HF_BIN:-}" ]; then echo "$STT_HF_BIN"
      elif [ -x "$ROOT/.venv-stt/bin/hf" ]; then echo "$ROOT/.venv-stt/bin/hf"
      elif [ -n "${HF_BIN:-}" ]; then echo "$HF_BIN"
      else echo "$ROOT/.venv-stt/bin/hf"
      fi ;;
  esac
}

requirements_for() {
  case "$1" in
    embedder|reranker) echo "local-embedder/requirements.txt" ;;
    stt)               echo "scripts/stt/requirements.txt" ;;
  esac
}

# --- Plan: printed before any network call ------------------------------------
echo "download-models: plan"
TOTAL="0"
UNKNOWN=0
for which in $SELECTED; do
  model="$(model_for "$which")"
  if [ "$model" = "$(default_for "$which")" ]; then
    gb="$(size_for "$which")"
    printf '  %-9s %-44s ~%s GB (%s)\n' "$which" "$model" "$gb" "$(size_note_for "$which")"
    TOTAL="$(awk -v a="$TOTAL" -v b="$gb" 'BEGIN { printf "%.1f", a + b }')"
  else
    printf '  %-9s %-44s size unknown (non-default model; check its model page)\n' "$which" "$model"
    UNKNOWN=1
  fi
done
if [ "$UNKNOWN" = "1" ] && [ "$TOTAL" = "0" ]; then
  echo "  total: unknown (non-default model(s) only)"
elif [ "$UNKNOWN" = "1" ]; then
  echo "  total: ~${TOTAL} GB for the default models listed, plus the non-default model(s) above"
else
  echo "  total: ~${TOTAL} GB"
fi
echo "  Sizes in GB apply to the default models only. Files already in the"
echo "  Hugging Face cache are not fetched again."

if [ "$YES" != "1" ]; then
  echo
  echo "download-models: nothing downloaded. Re-run with --yes to proceed." >&2
  exit 1
fi

# --- Preflight: every needed CLI must exist before the first download ---------
for which in $SELECTED; do
  hf="$(hf_for "$which")"
  if [ ! -x "$hf" ]; then
    echo "download-models: hf CLI for the $which model not found at: $hf" >&2
    echo "  Create the environment first (see $(requirements_for "$which"))," >&2
    echo "  or point HF_BIN / STT_HF_BIN at an existing hf executable." >&2
    exit 3
  fi
done

# --- Download (foreground, resumable) -----------------------------------------
for which in $SELECTED; do
  model="$(model_for "$which")"
  hf="$(hf_for "$which")"
  echo
  echo "download-models: fetching $which model $model"
  HF_HUB_DISABLE_XET=1 "$hf" download "$model"
done
echo
echo "download-models: done"
