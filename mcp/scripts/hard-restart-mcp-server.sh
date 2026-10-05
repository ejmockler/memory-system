#!/usr/bin/env bash
#
# hard-restart-mcp-server.sh — R36 S3
#
# Hard-restart the memory-system MCP server children spawned by long-lived
# hosts (Claude Code, Codex CLI). Node module cache is per-process: editing
# a file on disk does NOT change what a running MCP child returns. The host
# keeps that child alive across edits, so for example a bump of
# HEALTH_SCHEMA_VERSION in mcp/lib/tools/health.js will not be visible via
# memory_health until the child is replaced.
#
# reload-daemon.sh only handles launchd-managed daemons (the watermark loop
# and connectors). MCP server children are NOT launchd-managed — they are
# stdio subprocesses owned by the host. The only safe replacement is
# SIGKILL; the host will respawn a fresh child on the next MCP call.
#
# Steps:
#   1. launchctl unload the watermark agent plist (drains in-flight ticks).
#   2. sleep 2.
#   3. pgrep -f "memory-system/mcp/server\.js" — these are the MCP children.
#   4. kill -9 each PID (host will respawn fresh on next MCP call).
#   5. sleep 1.
#   6. launchctl load -w the watermark agent plist.
#   7. sleep 5.
#   8. Spawn a one-shot MCP server (with the node binary the watermark plist
#      names, or else the node on PATH; NODE_BIN overrides both) + run initialize +
#      tools/list + memory_health JSON-RPC. Assert schema_version=3 in the
#      response.
#   9. Print "Hard-restart complete. schema_version=<n> verified."
#
# Modes:
#   --dry-run   — print what would be killed; take no destructive action.
#   (default)   — execute all steps.
#
# Exit codes:
#   0 — all steps complete; schema_version matches HEALTH_SCHEMA_VERSION
#   1 — any step failed; print FAIL + offending step
#
# Convention: run this after editing daemon/MCP-server code that affects
# data returned over the MCP surface (schema bumps, response shape changes,
# tool registry edits). See kb/deprecation-discipline.md
# "MCP-server hard-restart after code edits".

set -u

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "FAIL: unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

# CODE root (server.js, mcp/lib): this script's own checkout,
# never MEMORY_ROOT, which redirects DATA only.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVER_JS="${REPO_ROOT}/mcp/server.js"
WATERMARK_PLIST="${HOME}/Library/LaunchAgents/com.user.memory-system.watermark.plist"

# Node binary for the smoke test: NODE_BIN when set; otherwise the node the
# installed watermark plist runs (ProgramArguments: /bin/bash, run-with-env.sh,
# <node>, ...), so the smoke test uses the same binary as the services;
# otherwise the node on PATH.
if [[ -z "${NODE_BIN:-}" && -f "$WATERMARK_PLIST" ]]; then
  PLIST_NODE="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:2' "$WATERMARK_PLIST" 2>/dev/null || true)"
  if [[ "$PLIST_NODE" == */node && -x "$PLIST_NODE" ]]; then
    NODE_BIN="$PLIST_NODE"
  fi
fi
if [[ -z "${NODE_BIN:-}" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
MATCH_PATTERN="$(printf '%s' "${REPO_ROOT}" | sed 's/[][\.*^$+?(){}|]/\\&/g')/mcp/server\\.js"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

echo "[hard-restart-mcp] mode: $([[ $DRY_RUN -eq 1 ]] && echo dry-run || echo execute)"
echo "[hard-restart-mcp] target server: $SERVER_JS"

# --- Step 1: unload watermark plist ---
if [[ -f "$WATERMARK_PLIST" ]]; then
  echo "[hard-restart-mcp] step 1/9: launchctl unload watermark plist"
  if [[ $DRY_RUN -eq 0 ]]; then
    launchctl unload "$WATERMARK_PLIST" 2>/dev/null || true
  fi
else
  echo "[hard-restart-mcp] step 1/9: watermark plist not found (skipped): $WATERMARK_PLIST"
fi

# --- Step 2: settle ---
echo "[hard-restart-mcp] step 2/9: sleep 2"
[[ $DRY_RUN -eq 0 ]] && sleep 2

# --- Step 3: enumerate MCP children ---
echo "[hard-restart-mcp] step 3/9: pgrep -f $MATCH_PATTERN"
LIVE_PIDS=$(pgrep -f "$MATCH_PATTERN" || true)
if [[ -z "$LIVE_PIDS" ]]; then
  echo "[hard-restart-mcp]   no stale MCP children found"
else
  echo "[hard-restart-mcp]   stale MCP children: $LIVE_PIDS"
fi

# --- Step 4: kill -9 ---
echo "[hard-restart-mcp] step 4/9: kill -9 stale MCP children"
if [[ -n "$LIVE_PIDS" ]]; then
  for pid in $LIVE_PIDS; do
    if [[ $DRY_RUN -eq 1 ]]; then
      echo "[hard-restart-mcp]   would kill -9 $pid"
    else
      if kill -9 "$pid" 2>/dev/null; then
        echo "[hard-restart-mcp]   killed $pid"
      else
        echo "[hard-restart-mcp]   warn: kill -9 $pid failed (already gone?)"
      fi
    fi
  done
fi

# --- Step 5: settle ---
echo "[hard-restart-mcp] step 5/9: sleep 1"
[[ $DRY_RUN -eq 0 ]] && sleep 1

# Post-kill verification: ensure no MCP children remain (host will respawn
# lazily on the next MCP call; we don't pre-spawn).
if [[ $DRY_RUN -eq 0 ]]; then
  REMAIN=$(pgrep -f "$MATCH_PATTERN" || true)
  if [[ -n "$REMAIN" ]]; then
    fail "MCP children still alive after kill -9: $REMAIN"
  fi
fi

# --- Step 6: reload watermark plist ---
if [[ -f "$WATERMARK_PLIST" ]]; then
  echo "[hard-restart-mcp] step 6/9: launchctl load -w watermark plist"
  if [[ $DRY_RUN -eq 0 ]]; then
    if ! launchctl load -w "$WATERMARK_PLIST"; then
      fail "launchctl load -w $WATERMARK_PLIST"
    fi
  fi
else
  echo "[hard-restart-mcp] step 6/9: watermark plist not found (skipped)"
fi

# --- Step 7: settle ---
echo "[hard-restart-mcp] step 7/9: sleep 5"
[[ $DRY_RUN -eq 0 ]] && sleep 5

# --- Step 8: smoke-test memory_health via fresh MCP child ---
echo "[hard-restart-mcp] step 8/9: smoke-test memory_health on fresh MCP child"
if [[ $DRY_RUN -eq 0 ]]; then
  if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
    fail "node not found / not executable (set NODE_BIN or put node on PATH): ${NODE_BIN:-<none>}"
  fi
  if [[ ! -f "$SERVER_JS" ]]; then
    fail "MCP server entrypoint not found: $SERVER_JS"
  fi

  # JSON-RPC sequence: initialize -> initialized notification -> tools/call
  # memory_health. We pipe three lines into the server's stdin and grep the
  # JSON-RPC responses on stdout for schema_version.
  REQ_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"hard-restart-smoke","version":"0.0.1"}}}'
  REQ_INITED='{"jsonrpc":"2.0","method":"notifications/initialized"}'
  REQ_HEALTH='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_health","arguments":{}}}'

  SMOKE_OUT=$(printf '%s\n%s\n%s\n' "$REQ_INIT" "$REQ_INITED" "$REQ_HEALTH" \
    | "$NODE_BIN" "$SERVER_JS" 2>/dev/null \
    | head -c 200000)

  # Extract schema_version=<n> from response payload. The memory_health
  # envelope is JSON-stringified inside the content[0].text field of the
  # tools/call response, so the inner JSON appears with backslash-escaped
  # quotes (e.g. `\"schema_version\":3`). A permissive char-class lets us
  # match both the escaped form and a raw form if the framing ever changes.
  SCHEMA_VER=$(printf '%s' "$SMOKE_OUT" \
    | grep -oE 'schema_version[\":\\]+[0-9]+' \
    | head -n1 \
    | grep -oE '[0-9]+$')
  if [[ -z "$SCHEMA_VER" ]]; then
    echo "[hard-restart-mcp]   raw smoke output (truncated 4KB):"
    printf '%s' "$SMOKE_OUT" | head -c 4096
    fail "smoke-test: no schema_version found in memory_health response"
  fi
  echo "[hard-restart-mcp]   schema_version=$SCHEMA_VER"
  # Derive the expectation from the SOURCE rather than hardcoding it. This
  # assertion was pinned to 3 while HEALTH_SCHEMA_VERSION had moved to 5, so
  # the script completed every destructive step (unload, SIGKILL of all MCP
  # children, reload) and then exited 1 on a false failure — the worst possible
  # shape for a recovery tool. Reading the constant keeps it correct across
  # future bumps, which is the whole reason this smoke-test exists.
  EXPECTED_VER=$(grep -oE 'HEALTH_SCHEMA_VERSION[[:space:]]*=[[:space:]]*[0-9]+' \
    "${REPO_ROOT}/mcp/lib/tools/health.js" \
    | head -n1 \
    | grep -oE '[0-9]+$')
  if [[ -z "$EXPECTED_VER" ]]; then
    fail "smoke-test: could not read HEALTH_SCHEMA_VERSION from mcp/lib/tools/health.js"
  fi
  if [[ "$SCHEMA_VER" != "$EXPECTED_VER" ]]; then
    fail "smoke-test: schema_version=$SCHEMA_VER (source declares $EXPECTED_VER)"
  fi
  echo "[hard-restart-mcp]   schema_version matches source ($EXPECTED_VER)"
else
  echo "[hard-restart-mcp]   dry-run: skipped smoke-test"
fi

# --- Step 9: done ---
echo "[hard-restart-mcp] step 9/9: complete"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "Hard-restart dry-run complete. (no kills performed)"
else
  echo "Hard-restart complete. schema_version=${SCHEMA_VER} verified."
fi
exit 0
