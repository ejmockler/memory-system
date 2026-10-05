#!/bin/bash
# embed-watchdog.sh — kickstart the embed-server when its phys_footprint exceeds a threshold.
#
# Context: the Qwen3-Embedding-8B server (launchd label com.user.memory-system.embed-server)
# leaks MPS/IOAccelerator memory ~1.8GB/h from an ~18GB baseline; unchecked it reaches
# jetsam territory (98GB on 2026-07-10). This watchdog measures phys_footprint via
# `footprint -p <pid>` and, when over threshold, runs `launchctl kickstart -k` on the
# service. launchd KeepAlive on the server absorbs the ~15s model reload.
#
# Fail-safe bias: ANY ambiguity (no PID, failed/empty/unparseable footprint output,
# unknown unit, bad threshold) logs the condition and exits 0 WITHOUT kickstarting.
# The only action this script ever takes against the system is the kickstart command;
# it never signals PIDs directly.
#
# Env seams (all optional; defaults are production values):
#   WATCHDOG_LABEL          launchd label of the target service
#   WATCHDOG_PID_CMD        command printing the target PID (default: parse `launchctl list`)
#   WATCHDOG_FOOTPRINT_CMD  command printing either a bare number (GB) or a
#                           "phys_footprint: <n> <GB|MB|KB>" line; $PID is exported to it
#   WATCHDOG_THRESHOLD_GB   kickstart threshold in GB (default 30; model baseline is ~18)
#   WATCHDOG_KICKSTART_CMD  command run when over threshold
#   WATCHDOG_LOG            log file, truncate-rotated at 1MB (old log moved to .1)
#   WATCHDOG_BUSY_CMD       command whose non-empty stdout marks the server BUSY
#                           (default: lsof established-TCP probe of :8359).
#                           Evaluated ONLY on the over-threshold path. Empty
#                           output, a failed command, or a missing tool all
#                           count as IDLE — a broken busy-check must never
#                           suppress memory protection (fail-safe stays
#                           asymmetric: ambiguity can only preserve, never add
#                           or remove beyond that, the pre-busy-guard behavior).
#   WATCHDOG_HARD_CEILING_GB busy-guard ceiling in GB (default 80): BUSY and
#                           footprint <= ceiling -> log 'busy, deferring' and
#                           skip the kickstart; footprint > ceiling -> kickstart
#                           even when busy (machine safety wins; jetsam at 98GB
#                           is the disaster being prevented). An invalid value
#                           resets to the default so a typo cannot disable
#                           memory protection.

set -u

WATCHDOG_LABEL="${WATCHDOG_LABEL:-com.user.memory-system.embed-server}"
WATCHDOG_THRESHOLD_GB="${WATCHDOG_THRESHOLD_GB:-30}"
WATCHDOG_BUSY_CMD="${WATCHDOG_BUSY_CMD:-lsof -nP -iTCP:8359 -sTCP:ESTABLISHED}"
WATCHDOG_HARD_CEILING_GB="${WATCHDOG_HARD_CEILING_GB:-80}"
WATCHDOG_LOG="${WATCHDOG_LOG:-${MEMORY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/daemons/logs/embed-watchdog.log}"
LOG_MAX_BYTES=1048576

mkdir -p "$(dirname "$WATCHDOG_LOG")"

rotate_log() {
  local size
  if [ -f "$WATCHDOG_LOG" ]; then
    size="$(stat -f%z "$WATCHDOG_LOG" 2>/dev/null || echo 0)"
    if [ "$size" -gt "$LOG_MAX_BYTES" ]; then
      mv -f "$WATCHDOG_LOG" "${WATCHDOG_LOG}.1"
    fi
  fi
}

log() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  rotate_log
  printf '%s %s\n' "$ts" "$*" >>"$WATCHDOG_LOG"
}

# Collapse newlines and cap length so raw command output is safe to log on one line.
one_line() {
  printf '%s' "$1" | tr '\n' ' ' | head -c 300
}

# --- Validate threshold (fail-safe: bad threshold means no action) ------------
case "$WATCHDOG_THRESHOLD_GB" in
  '' | *[!0-9.]*)
    log "bad WATCHDOG_THRESHOLD_GB='$WATCHDOG_THRESHOLD_GB'; skipping (fail-safe)"
    exit 0
    ;;
esac

# --- Validate hard ceiling (reset to default, do NOT skip: the ceiling only
# --- gates the busy-guard DEFERRAL, so a bad value must fall back to a sane
# --- ceiling rather than disable memory protection) ---------------------------
case "$WATCHDOG_HARD_CEILING_GB" in
  '' | *[!0-9.]*)
    log "bad WATCHDOG_HARD_CEILING_GB='$WATCHDOG_HARD_CEILING_GB'; using default 80"
    WATCHDOG_HARD_CEILING_GB=80
    ;;
esac

# --- Resolve target PID --------------------------------------------------------
pid=""
if [ -n "${WATCHDOG_PID_CMD:-}" ]; then
  pid="$(bash -c "$WATCHDOG_PID_CMD" 2>/dev/null)" || true
else
  pid="$(launchctl list 2>/dev/null | awk -v label="$WATCHDOG_LABEL" '$3 == label { print $1; exit }')" || true
fi

case "$pid" in
  '' | *[!0-9]*)
    log "no running PID for $WATCHDOG_LABEL (got '$(one_line "$pid")'); nothing to do"
    exit 0
    ;;
esac

# --- Measure footprint ----------------------------------------------------------
raw=""
if [ -n "${WATCHDOG_FOOTPRINT_CMD:-}" ]; then
  raw="$(PID="$pid" bash -c "$WATCHDOG_FOOTPRINT_CMD" 2>&1)" || true
else
  # First phys_footprint: line only; phys_footprint_peak: does not match this pattern.
  raw="$(/usr/bin/footprint -p "$pid" 2>/dev/null | awk '/phys_footprint:/ { print; exit }')" || true
fi

# Parse to GB. Accepts a bare number (already GB) or "phys_footprint: <n> <unit>".
# Anything else (empty, non-numeric, unknown unit) yields "" -> fail-safe skip.
gb="$(printf '%s\n' "$raw" | awk '
  NF == 0 { next }
  {
    v = ""; u = ""
    if ($1 == "phys_footprint:" && NF >= 3) { v = $2; u = $3 }
    else if (NF == 1)                       { v = $1; u = "GB" }
    if (v !~ /^[0-9]+([.][0-9]+)?$/) exit
    if      (u == "GB") printf "%.3f\n", v
    else if (u == "MB") printf "%.3f\n", v / 1024
    else if (u == "KB") printf "%.6f\n", v / 1048576
    exit
  }
')"

if [ -z "$gb" ]; then
  log "unparseable footprint for pid=$pid (raw: '$(one_line "$raw")'); skipping (fail-safe)"
  exit 0
fi

# --- Compare (floats, via awk) and act ------------------------------------------
over="$(awk -v v="$gb" -v t="$WATCHDOG_THRESHOLD_GB" 'BEGIN { if (v + 0 > t + 0) print 1; else print 0 }')"

if [ "$over" -ne 1 ]; then
  log "OK pid=$pid footprint=${gb}GB threshold=${WATCHDOG_THRESHOLD_GB}GB"
  exit 0
fi

# --- Busy-guard (R6; evaluated ONLY on the over-threshold path) -----------------
# BUSY = non-empty stdout from WATCHDOG_BUSY_CMD (default: an ESTABLISHED TCP
# connection on the embed port means a drain batch is in flight; killing the
# server mid-batch costs the drain its retries). The fail-safe stays ASYMMETRIC:
# a failed/empty/ambiguous busy-check counts as IDLE (a broken lsof must not
# suppress memory protection), and even a genuine BUSY only defers below
# WATCHDOG_HARD_CEILING_GB — above it, machine safety wins and we kickstart.
busy_raw="$(bash -c "$WATCHDOG_BUSY_CMD" 2>/dev/null)" || true
busy=0
if [ -n "$(printf '%s' "$busy_raw" | tr -d '[:space:]')" ]; then
  busy=1
fi
if [ "$busy" -eq 1 ]; then
  over_ceiling="$(awk -v v="$gb" -v c="$WATCHDOG_HARD_CEILING_GB" 'BEGIN { if (v + 0 > c + 0) print 1; else print 0 }')"
  if [ "$over_ceiling" -ne 1 ]; then
    log "OVER THRESHOLD pid=$pid footprint=${gb}GB threshold=${WATCHDOG_THRESHOLD_GB}GB but busy, deferring (ceiling=${WATCHDOG_HARD_CEILING_GB}GB)"
    exit 0
  fi
  log "OVER HARD CEILING pid=$pid footprint=${gb}GB ceiling=${WATCHDOG_HARD_CEILING_GB}GB while busy -> kickstart anyway (machine safety wins)"
fi

log "OVER THRESHOLD pid=$pid footprint=${gb}GB threshold=${WATCHDOG_THRESHOLD_GB}GB -> kickstart"
rc=0
if [ -n "${WATCHDOG_KICKSTART_CMD:-}" ]; then
  bash -c "$WATCHDOG_KICKSTART_CMD" >>"$WATCHDOG_LOG" 2>&1 || rc=$?
else
  # SIGTERM-first (default action ONLY; the WATCHDOG_KICKSTART_CMD seam above
  # bypasses all of this). The embed server drains gracefully on SIGTERM:
  # it finishes the in-flight batch, 503s queued work, and exits 0 within
  # EMBED_DRAIN_TIMEOUT_S (20s); launchd KeepAlive absorbs the clean exit.
  # Poll up to WATCHDOG_TERM_GRACE_S (default 25 = drain timeout + margin) for
  # the PID to exit/change; only a process still alive after the grace window
  # gets the old hard `kickstart -k`. `kill -0` sends NO signal (existence
  # probe only) — this script still never signals PIDs directly.
  WATCHDOG_TERM_GRACE_S="${WATCHDOG_TERM_GRACE_S:-25}"
  case "$WATCHDOG_TERM_GRACE_S" in
    '' | *[!0-9]*)
      log "bad WATCHDOG_TERM_GRACE_S='$WATCHDOG_TERM_GRACE_S'; using default 25"
      WATCHDOG_TERM_GRACE_S=25
      ;;
  esac
  term_rc=0; domain="gui/$(id -u)"
  launchctl kill TERM "$domain/$WATCHDOG_LABEL" >>"$WATCHDOG_LOG" 2>&1 || term_rc=$?
  log "phase 1: sent SIGTERM to $domain/$WATCHDOG_LABEL (exit=$term_rc); waiting up to ${WATCHDOG_TERM_GRACE_S}s for pid=$pid to exit"
  waited=0
  gone=0
  while [ "$waited" -lt "$WATCHDOG_TERM_GRACE_S" ]; do
    sleep 1
    waited=$((waited + 1))
    if ! kill -0 "$pid" 2>/dev/null; then
      gone=1
      break
    fi
  done
  if [ "$gone" -eq 1 ]; then
    log "phase 1: pid=$pid exited after ${waited}s (graceful drain); launchd KeepAlive restarts the service"
  else
    log "phase 2: pid=$pid still alive after ${WATCHDOG_TERM_GRACE_S}s -> kickstart -k fallback"
    launchctl kickstart -k "$domain/$WATCHDOG_LABEL" >>"$WATCHDOG_LOG" 2>&1 || rc=$?
  fi
fi
log "kickstart exit=$rc for $WATCHDOG_LABEL"
exit 0
