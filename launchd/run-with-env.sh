#!/bin/bash
# run-with-env.sh <command> [args...]: launchd wrapper that loads credentials
# from a private env file and then execs the real service command.
#
# WHY A WRAPPER (not inline plist env):
#   launchd plists embed EnvironmentVariables verbatim into a file that is
#   world-readable in the LaunchAgents directory. Credentials therefore live
#   in <MEMORY_ROOT>/config/secrets.env at mode 0600 and are sourced here at
#   runtime, so no credential byte ever lands in a plist. This generalises
#   daemons/telegram-tail-run.sh to any service command. See launchd/env.example
#   for the variable names.
#
# Contract:
#   - secrets file absent: one line on stderr, then exec anyway. The core
#     services must run on a clean install that has no credentials at all.
#   - secrets file readable or writable by group or other: refuse with exit 78
#     (EX_CONFIG) without running the command.
#   - `set -a` auto-exports every variable the file defines. No value is ever
#     echoed; never add `set -x` to this script.
#
# Override the file location with MEMORY_SECRETS_FILE.

set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "run-with-env: usage: run-with-env.sh <command> [args...]" >&2
  exit 64  # EX_USAGE
fi

MEMORY_ROOT="${MEMORY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export MEMORY_ROOT
ENV_FILE="${MEMORY_SECRETS_FILE:-$MEMORY_ROOT/config/secrets.env}"

if [[ -f "$ENV_FILE" ]]; then
  perms="$(stat -L -f %Lp "$ENV_FILE")"
  if (( 8#$perms & 8#077 )); then
    echo "run-with-env: refusing $ENV_FILE with mode $perms; run: chmod 600 \"$ENV_FILE\"" >&2
    exit 78  # EX_CONFIG
  fi
  # Source operator credentials. `set -a` auto-exports; values are never echoed.
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  echo "run-with-env: no secrets file at $ENV_FILE; starting without credentials" >&2
fi

exec "$@"
