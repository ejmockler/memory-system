#!/usr/bin/env bash
# download_reranker.sh — thin wrapper: fetch the Qwen3-Reranker weights through
# scripts/download-models.sh (which prints the size first and downloads nothing
# without --yes).
#
# Layer-3 reranker model staging: 0.6B is the default (smallest weights, proves
# the server contract and wiring end-to-end); 4B can be swapped in afterwards
# via the RERANK_MODEL env var of rerank_server.py (env change, no code change).
#
# Usage:
#   ./download_reranker.sh              # show the plan for 0.6B, download nothing
#   ./download_reranker.sh --yes        # download 0.6B
#   ./download_reranker.sh 4B --yes     # download the 4B upgrade
set -euo pipefail

SIZE="0.6B"
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --*) ARGS+=("$arg") ;;
    *)   SIZE="$arg" ;;
  esac
done

export RERANK_MODEL="Qwen/Qwen3-Reranker-${SIZE}"
exec "$(dirname "$0")/../scripts/download-models.sh" --only reranker ${ARGS[@]+"${ARGS[@]}"}
