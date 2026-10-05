#!/bin/bash
# install.sh: take a fresh clone to a working memory server, one explicit step
# at a time. Runs on the stock macOS /bin/bash (3.2) and needs nothing beyond
# macOS, Node.js and the Xcode Command Line Tools.
#
#   bash scripts/install.sh            same as --core
#   bash scripts/install.sh --help     every mode and what it writes
#
# Two roots:
#   CODE root  the checkout this script lives in (physical path). Node modules,
#              Python environments, service logs and rendered plists live here.
#   DATA root  MEMORY_ROOT when it is set, otherwise the checkout. Ledgers,
#              storage, policy, telemetry and config live here.
#
# Node: the services and the server use the Node.js already on PATH (checked
# against the floor below) and the service templates receive its path. Nothing
# is vendored or downloaded for Node.
#
# This script never talks to the service manager itself. The only route to the
# LaunchAgents directory is scripts/render-launchd.mjs --install, reached when
# both --services and --yes are given. The only route to a model download is
# scripts/download-models.sh --yes, reached when both --models and --yes are
# given. Existing config and data files are never overwritten.
set -euo pipefail

# Keep in step with engines.node in mcp/package.json and MIN_NODE in
# mcp/scripts/run-all-tests.mjs (the test runner refuses anything older).
NODE_FLOOR="22.18.0"
CORE_SERVICES="watermark,queryd,embed-server,rerank-server,embed-watchdog,reembed-drain"
STAMP_NAME=".install-stamp"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DATA_ROOT="${MEMORY_ROOT:-$ROOT}"

usage() {
  cat <<'USAGE'
usage: install.sh [--core] [--python] [--models] [--services] [--all] [--yes]

Modes (several may be combined; with no mode, --core runs):

  --core      Check prerequisites (macOS, Node.js 22.18 or newer, npm, the
              Xcode Command Line Tools), install the Node dependencies with
              `npm ci` in mcp/, create the data, config and log directories,
              copy each config/*.example.* file to its real name if that file
              does not exist yet (except the optional gazetteer seed, which
              is skipped so the built-in seed list applies), then run the
              install check
              (scripts/install/doctor.mjs).
              Writes: mcp/node_modules, daemons/logs and local-embedder/logs
              in the checkout; policy, storage, ledgers, telemetry, connectors
              and config under the data root.

  --python    Create the two Python environments from their pinned manifests:
              local-embedder/.venv (embedding and rerank servers) and
              .venv-stt (voice-note transcription, Apple Silicon only). Uses
              `uv` when it is on PATH, otherwise the matching pythonX.Y.
              Writes: those two directories in the checkout. Large download.

  --models    Show the model download plan from scripts/download-models.sh.
              Downloads nothing unless --yes is also given.
              Writes (only with --yes): the Hugging Face cache.

  --services  Render the six core background services into launchd/rendered/
              with scripts/render-launchd.mjs and list exactly what would be
              installed. Installs nothing unless --yes is also given.
              Writes: launchd/rendered in the checkout. Only with --yes: the
              LaunchAgents directory of your account, and the services are
              loaded into launchd.

  --all       --core, --python, --models and --services, in that order.

  --yes       Confirm the irreversible part of --models and --services.
              Only `--services --yes` touches the LaunchAgents directory and
              launchd. Only `--models --yes` downloads model weights.
              It has no effect on --core or --python.

  --help, -h  Show this help and exit.

Data root: the directory named by MEMORY_ROOT when that variable is set,
otherwise the checkout itself. Existing config and data files are never
overwritten, so every mode is safe to run again.
USAGE
}

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

DO_CORE=0
DO_PYTHON=0
DO_MODELS=0
DO_SERVICES=0
YES=0
WANT_HELP=0
BAD_ARG=""
HAVE_BAD_ARG=0

while [ $# -gt 0 ]; do
  case "$1" in
    --core) DO_CORE=1 ;;
    --python) DO_PYTHON=1 ;;
    --models) DO_MODELS=1 ;;
    --services) DO_SERVICES=1 ;;
    --all) DO_CORE=1; DO_PYTHON=1; DO_MODELS=1; DO_SERVICES=1 ;;
    --yes) YES=1 ;;
    --help|-h) WANT_HELP=1 ;;
    *) if [ "$HAVE_BAD_ARG" = "0" ]; then BAD_ARG="$1"; HAVE_BAD_ARG=1; fi ;;
  esac
  shift
done

if [ "$WANT_HELP" = "1" ]; then
  usage
  exit 0
fi
if [ "$HAVE_BAD_ARG" = "1" ]; then
  printf 'install: unknown argument: %s\n' "$BAD_ARG" >&2
  usage >&2
  exit 64
fi
if [ "$DO_CORE$DO_PYTHON$DO_MODELS$DO_SERVICES" = "0000" ]; then
  DO_CORE=1
fi

# --- Prerequisites: checked before anything is written -------------------------

# Leading digits of a version component ("0-nightly" -> 0, "" -> 0).
num() {
  local digits="${1%%[!0-9]*}"
  printf '%s' "${digits:-0}"
}

# version_at_least <found> <floor>: compares major.minor.patch as integers.
version_at_least() {
  local IFS=.
  local found floor
  # shellcheck disable=SC2206
  found=($1)
  # shellcheck disable=SC2206
  floor=($2)
  local i f w
  for i in 0 1 2; do
    f="$(num "${found[$i]:-0}")"
    w="$(num "${floor[$i]:-0}")"
    if [ "$f" -gt "$w" ]; then return 0; fi
    if [ "$f" -lt "$w" ]; then return 1; fi
  done
  return 0
}

if [ "$(uname -s)" != "Darwin" ]; then
  die "this installer supports macOS only (found $(uname -s))."
fi
if ! command -v node >/dev/null 2>&1; then
  die "Node.js ${NODE_FLOOR%.*} or newer is required, and no node was found on PATH."
fi
NODE_VERSION="$(node -p process.versions.node 2>/dev/null || true)"
if [ -z "$NODE_VERSION" ] || ! version_at_least "$NODE_VERSION" "$NODE_FLOOR"; then
  die "Node.js ${NODE_FLOOR%.*} or newer is required (found ${NODE_VERSION:-an unreadable version})."
fi
if ! command -v npm >/dev/null 2>&1; then
  die "npm was not found on PATH; it ships with Node.js, so reinstall Node.js ${NODE_FLOOR%.*} or newer."
fi
# The native vector-index module is compiled on install. Probe with
# xcode-select only: running the cc or python3 placeholders without the
# Command Line Tools opens a system installer dialog.
if ! xcode-select -p >/dev/null 2>&1; then
  die "the Xcode Command Line Tools (C compiler) are required; install them with: xcode-select --install"
fi

# Absolute path of the node on PATH. Kept as the PATH entry (not the symlink
# target) because package managers move the target on every upgrade.
NODE_BIN="$(command -v node)"
case "$NODE_BIN" in
  /*) ;;
  *) NODE_BIN="$(node -p process.execPath)" ;;
esac

# --- --core --------------------------------------------------------------------

deps_stamp() {
  local lock_sum abi
  lock_sum="$(shasum -a 256 "$ROOT/mcp/package-lock.json" | awk '{print $1}')"
  abi="$(node -p process.versions.modules)"
  printf '%s %s\n' "$lock_sum" "$abi"
}

deps_load() {
  (cd "$ROOT/mcp" && node --input-type=module \
    -e "await import('hnswlib-node'); await import('@modelcontextprotocol/sdk/server/index.js');" \
    >/dev/null 2>&1)
}

install_node_deps() {
  local stamp_file="$ROOT/mcp/node_modules/$STAMP_NAME"
  local want
  want="$(deps_stamp)"
  if [ -f "$stamp_file" ] && [ "$(cat "$stamp_file")" = "$want" ] && deps_load; then
    say "node dependencies: up to date (kept mcp/node_modules)"
    return 0
  fi
  say "node dependencies: running npm ci in $ROOT/mcp"
  (cd "$ROOT/mcp" && npm ci --no-audit --no-fund --no-update-notifier)
  printf '%s\n' "$want" > "$stamp_file"
}

make_dirs() {
  local d
  for d in policy storage storage/sources storage/feedback ledgers telemetry connectors config; do
    mkdir -p "$DATA_ROOT/$d"
  done
  for d in daemons/logs local-embedder/logs; do
    mkdir -p "$ROOT/$d"
  done
  say "directories: data under $DATA_ROOT, logs under $ROOT"
}

copy_example_configs() {
  local src base target
  for src in "$ROOT"/config/*.example.*; do
    [ -e "$src" ] || continue
    base="$(basename "$src")"
    target="$DATA_ROOT/config/${base/.example./.}"
    # The gazetteer seed is optional: when the file is absent the built-in
    # seed list applies, so copying the example would silently replace it.
    if [ "$base" = "gazetteer-seed.example.json" ]; then
      if [ -e "$target" ]; then
        say "config: kept    $target"
      else
        say "config: optional $target not created (built-in seed list applies; create it from config/gazetteer-seed.example.json to use your own)"
      fi
      continue
    fi
    if [ -e "$target" ]; then
      say "config: kept    $target"
    else
      cp "$src" "$target"
      say "config: created $target (from $base; replace the example values with your own)"
    fi
  done
}

secrets_hint() {
  if [ -e "$DATA_ROOT/config/secrets.env" ]; then
    return 0
  fi
  say "credentials: none are needed for the core. If you later run a service that needs one:"
  say "  1. cp \"$ROOT/launchd/env.example\" \"$DATA_ROOT/config/secrets.env\""
  say "  2. chmod 600 \"$DATA_ROOT/config/secrets.env\""
  say "  3. uncomment and fill in only the variables you use"
}

core_next_steps() {
  say
  say "Next steps:"
  say "  1. Check that a memory can be stored and recalled (uses a throwaway root):"
  say "       node \"$ROOT/scripts/smoke.mjs\""
  say "  2. Register the server with Claude Code (it starts the server itself, over stdio):"
  if [ "$DATA_ROOT" = "$ROOT" ]; then
    say "       claude mcp add --scope user memory -- node \"$ROOT/mcp/server.js\""
  else
    say "       claude mcp add --scope user memory -e MEMORY_ROOT=\"$DATA_ROOT\" -- node \"$ROOT/mcp/server.js\""
  fi
  say "  Hooks are optional. Register them by their real path under"
  say "    $ROOT/hooks"
  say "  and never through a symlink: each hook finds the checkout from its own"
  say "  location. See $ROOT/hooks/registration-recommendation.md"
  say "  This installer registered nothing. Outside the checkout and the data root, only"
  say "  npm wrote files (its own download and build caches in your home directory)."
}

run_core() {
  say "== core =="
  install_node_deps
  make_dirs
  copy_example_configs
  secrets_hint
  say
  local rc=0
  node "$ROOT/scripts/install/doctor.mjs" --root "$ROOT" --data-root "$DATA_ROOT" --node-floor "$NODE_FLOOR" || rc=$?
  if [ "$rc" = "0" ]; then
    core_next_steps
  fi
  return "$rc"
}

# --- --python ------------------------------------------------------------------

# make_venv <label> <venv dir> <requirements file> <.python-version file>
make_venv() {
  local label="$1" dir="$2" req="$3" ver_file="$4"
  local ver
  ver="$(tr -d '[:space:]' < "$ver_file")"
  if command -v uv >/dev/null 2>&1; then
    if [ -x "$dir/bin/python" ]; then
      say "python: $label environment exists (kept $dir)"
    else
      say "python: creating $label environment with uv (Python $ver)"
      uv venv --python "$ver" "$dir"
    fi
    uv pip install --python "$dir/bin/python" -r "$req"
  elif command -v "python$ver" >/dev/null 2>&1; then
    if [ -x "$dir/bin/python" ]; then
      say "python: $label environment exists (kept $dir)"
    else
      say "python: creating $label environment with python$ver"
      "python$ver" -m venv "$dir"
    fi
    "$dir/bin/python" -m pip install -r "$req"
  else
    die "the $label environment needs Python $ver: install uv, or put python$ver on PATH."
  fi
}

run_python() {
  say "== python =="
  make_venv "embedder" "$ROOT/local-embedder/.venv" \
    "$ROOT/local-embedder/requirements.txt" "$ROOT/local-embedder/.python-version"
  if [ "$(uname -m)" = "arm64" ]; then
    make_venv "speech-to-text" "$ROOT/.venv-stt" \
      "$ROOT/scripts/stt/requirements.txt" "$ROOT/scripts/stt/.python-version"
  else
    say "python: skipped the speech-to-text environment (MLX runs on Apple Silicon only)"
  fi
}

# --- --models ------------------------------------------------------------------

run_models() {
  say "== models =="
  if [ "$YES" = "1" ]; then
    bash "$ROOT/scripts/download-models.sh" --yes
    return $?
  fi
  bash "$ROOT/scripts/download-models.sh" || true
  say "models: nothing downloaded; re-run with --models --yes to download."
  return 1
}

# --- --services ----------------------------------------------------------------

render_services() {
  # "$@" is empty for the preview and "--install" for the confirmed run.
  node "$ROOT/scripts/render-launchd.mjs" --root "$ROOT" --home "$HOME" \
    --out "$ROOT/launchd/rendered" --node "$NODE_BIN" --only "$CORE_SERVICES" "$@"
}

run_services() {
  say "== services =="
  if [ -z "${HOME:-}" ]; then
    die "HOME is not set, so the account that would run the services is unknown."
  fi
  render_services

  local agents_dir="$HOME/Library/LaunchAgents"
  local svc plist old_ifs
  say "services: these files would be copied into $agents_dir and loaded into launchd:"
  old_ifs="$IFS"
  IFS=,
  for svc in $CORE_SERVICES; do
    plist="com.user.memory-system.$svc.plist"
    say "  $ROOT/launchd/rendered/$plist"
  done
  IFS="$old_ifs"
  say "services: they would run $NODE_BIN"
  say "services: optional connectors are not included; they read personal databases and"
  say "  need permissions or credentials, so add them by hand (see $ROOT/launchd/README.md)."

  local node_real
  node_real="$(node -p process.execPath)"
  case "$NODE_BIN $node_real" in
    */.nvm/*|*/.volta/*|*/.fnm/*|*/fnm/*|*/.asdf/*|*/.nodenv/*|*/.nodebrew/*|*/.local/share/mise/*|*/n/versions/*|*/Cellar/*)
      say "warning: this node comes from a version or package manager and may move when it is"
      say "  upgraded or removed; the services would then stop starting until you render again."
      ;;
  esac
  if [ ! -x "$ROOT/local-embedder/.venv/bin/python3" ]; then
    say "warning: $ROOT/local-embedder/.venv/bin/python3 is missing; the embed and rerank"
    say "  servers would fail to start and be restarted in a loop. Run --python first."
  fi

  if [ "$YES" != "1" ]; then
    say "services: nothing installed. Re-run with --services --yes to install and load them."
    return 0
  fi
  say "services: installing"
  render_services --install
}

# --- Run the selected modes in a fixed order -----------------------------------

NEEDS_YES=0
STARTED=0
# Blank line between modes, none before the first.
gap() {
  if [ "$STARTED" = "1" ]; then say; fi
  STARTED=1
}

if [ "$DO_CORE" = "1" ]; then
  gap
  run_core
fi
if [ "$DO_PYTHON" = "1" ]; then
  gap
  run_python
fi
if [ "$DO_MODELS" = "1" ]; then
  gap
  rc=0
  run_models || rc=$?
  if [ "$rc" != "0" ]; then
    if [ "$YES" = "1" ]; then
      exit "$rc"
    fi
    NEEDS_YES=1
  fi
fi
if [ "$DO_SERVICES" = "1" ]; then
  gap
  run_services
fi

# --models without --yes is reported as a failure of that mode, after any
# remaining preview has been shown.
if [ "$NEEDS_YES" = "1" ]; then
  exit 1
fi
exit 0
