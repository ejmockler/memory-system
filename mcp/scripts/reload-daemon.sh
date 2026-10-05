#!/usr/bin/env bash
#
# reload-daemon.sh — Foundation B6
#
# Reload a memory-system launchd daemon after on-disk code edits so the
# running process picks up the new module bytes (Node module cache is
# per-process; in-place file edits are invisible until reload).
#
# Usage:
#   bash mcp/scripts/reload-daemon.sh <daemon-name>
#
# <daemon-name> matches the suffix of:
#   ~/Library/LaunchAgents/com.user.memory-system.<daemon-name>.plist
#
# Convention: ANY workflow phase that edits files under
#   <MEMORY_ROOT>/daemons/*.js
# OR <MEMORY_ROOT>/mcp/lib/* that the daemons import
# MUST end with a call to this helper.
# See kb/deprecation-discipline.md "Daemon reload after code edits".
#
# NOTE (R36 S3): this script ONLY restarts the watermark daemon (and other
# launchd-managed daemons). It does NOT refresh MCP server children spawned
# by Claude Code / Codex CLI — those are stdio subprocesses owned by the
# host, not launchd jobs, and they cache imported modules per-process. For
# schema-version changes or any edit that affects MCP-served data (e.g.,
# mcp/lib/tools/* or anything imported by mcp/server.js), use
# `mcp/scripts/hard-restart-mcp-server.sh` instead — it kills the stale MCP
# children with SIGKILL so the host respawns them against the post-edit
# code. See kb/deprecation-discipline.md
# "MCP-server hard-restart after code edits".
#
# Exit codes:
#   0 — daemon reloaded; PID present after warmup; RSS reported
#   1 — any step failed (unload, stop-verify, load, start-verify, warmup-verify)

set -u

DAEMON="${1:-}"
if [[ -z "$DAEMON" ]]; then
  echo "FAIL: usage: $0 <daemon-name>" >&2
  exit 1
fi

LABEL="com.user.memory-system.${DAEMON}"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
# Match by the daemon source path (more specific than the bare label, which
# can collide with this helper's own argv when pgrep -f sees the command).
MATCH_PATTERN="daemons/${DAEMON}\\.js"

if [[ ! -f "$PLIST" ]]; then
  echo "FAIL: plist not found: $PLIST" >&2
  exit 1
fi

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

echo "[reload-daemon] target: $DAEMON ($LABEL)"
echo "[reload-daemon] plist:  $PLIST"

# --- Step 1: unload ---
echo "[reload-daemon] step 1/5: launchctl unload"
launchctl unload "$PLIST" 2>/dev/null || true  # unload may report "not loaded"; tolerated
sleep 2

# --- Step 2: verify stopped ---
echo "[reload-daemon] step 2/5: verify stopped (pgrep -f $MATCH_PATTERN must be empty)"
LIVE_PIDS=$(pgrep -f "$MATCH_PATTERN" || true)
if [[ -n "$LIVE_PIDS" ]]; then
  # Give it one more grace window — KeepAlive throttle can race
  sleep 3
  LIVE_PIDS=$(pgrep -f "$MATCH_PATTERN" || true)
  if [[ -n "$LIVE_PIDS" ]]; then
    fail "daemon still running after unload; PIDs: $LIVE_PIDS"
  fi
fi
echo "[reload-daemon]   stopped OK"

# --- Step 3: load -w ---
echo "[reload-daemon] step 3/5: launchctl load -w"
if ! launchctl load -w "$PLIST"; then
  fail "launchctl load -w $PLIST"
fi
sleep 5

# --- Step 4: verify started ---
echo "[reload-daemon] step 4/5: verify started (pgrep -f $MATCH_PATTERN must return PID)"
PID=$(pgrep -f "$MATCH_PATTERN" | head -n1 || true)
if [[ -z "$PID" ]]; then
  fail "daemon did not start after load (pgrep -f $MATCH_PATTERN empty)"
fi
echo "[reload-daemon]   started OK; PID=$PID"

# --- Step 5: warmup + RSS ---
echo "[reload-daemon] $DAEMON reloaded successfully; PID=$PID; sleeping 30s for warmup"
sleep 30

# Re-resolve PID in case launchd restarted the worker during warmup
NEW_PID=$(pgrep -f "$MATCH_PATTERN" | head -n1 || true)
if [[ -z "$NEW_PID" ]]; then
  fail "daemon died during 30s warmup window"
fi
if [[ "$NEW_PID" != "$PID" ]]; then
  echo "[reload-daemon]   note: PID changed during warmup ($PID -> $NEW_PID); KeepAlive likely restarted it"
  PID="$NEW_PID"
fi

# RSS in KB on macOS ps; convert to MB for the report
RSS_KB=$(ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ' || true)
if [[ -z "$RSS_KB" ]]; then
  fail "could not read RSS for PID $PID"
fi
RSS_MB=$(( RSS_KB / 1024 ))

echo "[reload-daemon] post-warmup: PID=$PID  RSS=${RSS_KB} KB (~${RSS_MB} MB)"
echo "[reload-daemon] OK"
exit 0
