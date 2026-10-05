#!/bin/bash
# telegram-tail-run.sh — N12 launchd wrapper for the Telegram MTProto tail.
#
# WHY A WRAPPER (not inline plist env):
#   launchd plists embed EnvironmentVariables verbatim into a file that is
#   world-readable in the LaunchAgents directory. TELEGRAM_API_ID /
#   TELEGRAM_API_HASH (and the session-file path) are operator secrets that
#   live in a 0600 env file. Sourcing that file at runtime keeps the secrets
#   at 0600 and OUT of the plist. The plist only ever names this wrapper +
#   the venv python; no credential bytes touch the plist.
#
# WHICH ENV FILE (first match wins):
#   1. $TELEGRAM_ENV_FILE when set;
#   2. <MEMORY_ROOT>/config/secrets.env when that file exists (MEMORY_ROOT
#      falls back to this checkout), the shared secrets file launchd/env.example
#      describes;
#   3. $HOME/.config/memory-system/telegram.env (the older location).
#   The same mode check applies to whichever file is chosen.
#
# The wrapper sources the env (which exports TELEGRAM_API_ID,
# TELEGRAM_API_HASH, TELEGRAM_SESSION_FILE) and execs the venv python on
# telegram_tail.py, which owns the Telethon MTProto subscription and writes
# one JSONL line per event to the staging file. The Node connector
# (telegram.js --once / runForever) tails that staging file separately; this
# wrapper does NOT run Node — it only stands up the upstream capture.
#
# KEY_LEAKAGE_ZERO: `set -a` auto-exports every var the env file defines, but
# the values are never echoed. telegram_tail.py itself never prints the
# session string (see its module header). Failure to source the env is fatal
# (set -e) so a missing creds file surfaces in the launchd stderr log rather
# than silently falling back to the public sample-app credentials.

set -euo pipefail

# CODE (venv python, telegram_tail.py) is located from this script's own
# checkout, never from MEMORY_ROOT: MEMORY_ROOT redirects DATA only.
CODE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_PYTHON="${CODE_ROOT}/local-embedder/.venv/bin/python3"
TAIL_SCRIPT="${CODE_ROOT}/mcp/lib/connectors/telegram/telegram_tail.py"

# DATA root: MEMORY_ROOT when set and non-empty, else this checkout.
DATA_ROOT="${MEMORY_ROOT:-$CODE_ROOT}"
SHARED_ENV_FILE="${DATA_ROOT}/config/secrets.env"
LEGACY_ENV_FILE="$HOME/.config/memory-system/telegram.env"
if [[ -n "${TELEGRAM_ENV_FILE:-}" ]]; then
  ENV_FILE="$TELEGRAM_ENV_FILE"
elif [[ -f "$SHARED_ENV_FILE" ]]; then
  ENV_FILE="$SHARED_ENV_FILE"
else
  ENV_FILE="$LEGACY_ENV_FILE"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "telegram-tail-run: env file not found at $ENV_FILE" >&2
  echo "  Looked for $SHARED_ENV_FILE, then $LEGACY_ENV_FILE (or set TELEGRAM_ENV_FILE)." >&2
  echo "  Create one with TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION_FILE (0600)." >&2
  exit 78  # EX_CONFIG
fi

# Same mode rule as launchd/run-with-env.sh: refuse a secrets file that is
# readable or writable by group or other. Prints the path and mode only.
perms="$(stat -L -f %Lp "$ENV_FILE")"
if (( 8#$perms & 8#077 )); then
  echo "telegram-tail-run: refusing $ENV_FILE with mode $perms; run: chmod 600 \"$ENV_FILE\"" >&2
  exit 78  # EX_CONFIG
fi

# Source operator creds. `set -a` auto-exports; values are never echoed.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Default the staging file to the connector's expected location if the env
# file did not pin TELEGRAM_STAGING_FILE explicitly. Evaluated after the env
# file is sourced; the path sits under the data root because the file holds
# message text. telegram_tail.py creates the directory with mode 0700.
export TELEGRAM_STAGING_FILE="${TELEGRAM_STAGING_FILE:-${MEMORY_ROOT:-$CODE_ROOT}/storage/tmp/telegram-staging.jsonl}"

exec "$VENV_PYTHON" "$TAIL_SCRIPT"
