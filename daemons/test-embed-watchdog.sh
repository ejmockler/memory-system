#!/bin/bash
# test-embed-watchdog.sh — hermetic tests for embed-watchdog.sh.
# No real launchctl, no real footprint, no writes to the production log:
# everything is injected via WATCHDOG_* env seams into a mktemp workdir.
# Exit 0 = all cases pass; any assertion failure prints a message and exits 1.

set -u

WATCHDOG_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/embed-watchdog.sh"
[ -f "$WATCHDOG_SH" ] || { echo "FAIL: $WATCHDOG_SH not found" >&2; exit 1; }

tmp="$(mktemp -d)" || { echo "FAIL: mktemp -d" >&2; exit 1; }
# targets collects the disposable `sleep` PIDs spawned by cases j/k/l — the
# ONLY PIDs this suite ever signals. Cleanup kills them even on early fail.
targets=""
trap 'kill $targets 2>/dev/null; rm -rf "$tmp"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

kicks() { find "$1" -type f | wc -l | tr -d ' '; }

iso_line() {
  grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z ' "$1"
}

# --- case a: under threshold -> no kickstart -----------------------------------
mkdir -p "$tmp/kicks.a"
WATCHDOG_LOG="$tmp/log.a" \
WATCHDOG_PID_CMD='echo 12345' \
WATCHDOG_FOOTPRINT_CMD='echo 20' \
WATCHDOG_KICKSTART_CMD="touch $tmp/kicks.a/kick.\$RANDOM" \
  bash "$WATCHDOG_SH"
rc=$?
[ "$rc" -eq 0 ] || fail "case a: watchdog exited $rc, want 0"
[ "$(kicks "$tmp/kicks.a")" -eq 0 ] || fail "case a: kickstart fired under threshold"
iso_line "$tmp/log.a" || fail "case a: no ISO-timestamped log line"
grep -q 'OK pid=12345' "$tmp/log.a" || fail "case a: missing OK log line"
pass "case a: under threshold (20GB) -> no kickstart"

# --- case b: over threshold -> exactly one kickstart ----------------------------
# WATCHDOG_BUSY_CMD='true' injects an explicit IDLE busy-check: the production
# default probes the REAL port 8359 and would make this case flaky under live
# embed traffic. Hermetic = idle, so the classic over-threshold path fires.
mkdir -p "$tmp/kicks.b"
WATCHDOG_LOG="$tmp/log.b" \
WATCHDOG_PID_CMD='echo 12345' \
WATCHDOG_FOOTPRINT_CMD='echo 45' \
WATCHDOG_BUSY_CMD='true' \
WATCHDOG_KICKSTART_CMD="touch $tmp/kicks.b/kick.\$RANDOM" \
  bash "$WATCHDOG_SH"
rc=$?
[ "$rc" -eq 0 ] || fail "case b: watchdog exited $rc, want 0"
[ "$(kicks "$tmp/kicks.b")" -eq 1 ] || fail "case b: expected exactly 1 kickstart, got $(kicks "$tmp/kicks.b")"
grep -q 'OVER THRESHOLD pid=12345' "$tmp/log.b" || fail "case b: missing OVER THRESHOLD log line"
pass "case b: over threshold (45GB) -> exactly one kickstart"

# --- case b2: real footprint GB line, over threshold ----------------------------
# (explicit idle busy-check, same hermeticity rationale as case b)
mkdir -p "$tmp/kicks.b2"
WATCHDOG_LOG="$tmp/log.b2" \
WATCHDOG_PID_CMD='echo 12345' \
WATCHDOG_FOOTPRINT_CMD='echo "    phys_footprint: 45 GB"' \
WATCHDOG_BUSY_CMD='true' \
WATCHDOG_KICKSTART_CMD="touch $tmp/kicks.b2/kick.\$RANDOM" \
  bash "$WATCHDOG_SH"
rc=$?
[ "$rc" -eq 0 ] || fail "case b2: watchdog exited $rc, want 0"
[ "$(kicks "$tmp/kicks.b2")" -eq 1 ] || fail "case b2: GB-unit line over threshold should kickstart once"
pass "case b2: 'phys_footprint: 45 GB' line -> one kickstart"

# --- case b3: real footprint MB line, converts under threshold ------------------
mkdir -p "$tmp/kicks.b3"
WATCHDOG_LOG="$tmp/log.b3" \
WATCHDOG_PID_CMD='echo 12345' \
WATCHDOG_FOOTPRINT_CMD='echo "phys_footprint: 512 MB"' \
WATCHDOG_KICKSTART_CMD="touch $tmp/kicks.b3/kick.\$RANDOM" \
  bash "$WATCHDOG_SH"
rc=$?
[ "$rc" -eq 0 ] || fail "case b3: watchdog exited $rc, want 0"
[ "$(kicks "$tmp/kicks.b3")" -eq 0 ] || fail "case b3: 512 MB should be under threshold"
grep -q 'footprint=0.500GB' "$tmp/log.b3" || fail "case b3: MB->GB conversion not logged (want footprint=0.500GB)"
pass "case b3: 'phys_footprint: 512 MB' -> 0.500GB, no kickstart"

# --- case c: footprint command fails -> fail-safe, exit 0 -----------------------
mkdir -p "$tmp/kicks.c"
WATCHDOG_LOG="$tmp/log.c" \
WATCHDOG_PID_CMD='echo 12345' \
WATCHDOG_FOOTPRINT_CMD='false' \
WATCHDOG_KICKSTART_CMD="touch $tmp/kicks.c/kick.\$RANDOM" \
  bash "$WATCHDOG_SH"
rc=$?
[ "$rc" -eq 0 ] || fail "case c: watchdog exited $rc, want 0 (fail-safe)"
[ "$(kicks "$tmp/kicks.c")" -eq 0 ] || fail "case c: kickstart fired on failed footprint command"
grep -q 'unparseable footprint' "$tmp/log.c" || fail "case c: missing fail-safe log line"
pass "case c: footprint command fails -> no kickstart, exit 0"

# --- case c2: footprint command prints empty -> fail-safe, exit 0 ---------------
mkdir -p "$tmp/kicks.c2"
WATCHDOG_LOG="$tmp/log.c2" \
WATCHDOG_PID_CMD='echo 12345' \
WATCHDOG_FOOTPRINT_CMD='echo ""' \
WATCHDOG_KICKSTART_CMD="touch $tmp/kicks.c2/kick.\$RANDOM" \
  bash "$WATCHDOG_SH"
rc=$?
[ "$rc" -eq 0 ] || fail "case c2: watchdog exited $rc, want 0 (fail-safe)"
[ "$(kicks "$tmp/kicks.c2")" -eq 0 ] || fail "case c2: kickstart fired on empty footprint output"
pass "case c2: empty footprint output -> no kickstart, exit 0"

# --- case c3: unknown unit -> fail-safe, exit 0 ----------------------------------
mkdir -p "$tmp/kicks.c3"
WATCHDOG_LOG="$tmp/log.c3" \
WATCHDOG_PID_CMD='echo 12345' \
WATCHDOG_FOOTPRINT_CMD='echo "phys_footprint: 45 TB"' \
WATCHDOG_KICKSTART_CMD="touch $tmp/kicks.c3/kick.\$RANDOM" \
  bash "$WATCHDOG_SH"
rc=$?
[ "$rc" -eq 0 ] || fail "case c3: watchdog exited $rc, want 0 (fail-safe)"
[ "$(kicks "$tmp/kicks.c3")" -eq 0 ] || fail "case c3: kickstart fired on unknown unit"
grep -q 'unparseable footprint' "$tmp/log.c3" || fail "case c3: missing fail-safe log line"
pass "case c3: unknown unit (TB) -> no kickstart, exit 0"

# --- case d: no PID -> no kickstart, exit 0 --------------------------------------
mkdir -p "$tmp/kicks.d"
WATCHDOG_LOG="$tmp/log.d" \
WATCHDOG_PID_CMD='true' \
WATCHDOG_FOOTPRINT_CMD='echo 45' \
WATCHDOG_KICKSTART_CMD="touch $tmp/kicks.d/kick.\$RANDOM" \
  bash "$WATCHDOG_SH"
rc=$?
[ "$rc" -eq 0 ] || fail "case d: watchdog exited $rc, want 0"
[ "$(kicks "$tmp/kicks.d")" -eq 0 ] || fail "case d: kickstart fired with no PID"
grep -q 'no running PID' "$tmp/log.d" || fail "case d: missing no-PID log line"
pass "case d: missing PID -> no kickstart, exit 0"

# --- case e: log rotation — seeded >1MB log shrinks under 1MB --------------------
mkdir -p "$tmp/kicks.e"
rotlog="$tmp/log.e"
head -c 1200000 /dev/zero | tr '\0' 'x' >"$rotlog"
seeded="$(stat -f%z "$rotlog")"
[ "$seeded" -gt 1048576 ] || fail "case e: seed log only $seeded bytes, want >1048576"
WATCHDOG_LOG="$rotlog" \
WATCHDOG_PID_CMD='echo 12345' \
WATCHDOG_FOOTPRINT_CMD='echo 20' \
WATCHDOG_KICKSTART_CMD="touch $tmp/kicks.e/kick.\$RANDOM" \
  bash "$WATCHDOG_SH"
rc=$?
[ "$rc" -eq 0 ] || fail "case e: watchdog exited $rc, want 0"
after="$(stat -f%z "$rotlog")"
[ "$after" -lt 1048576 ] || fail "case e: log not rotated ($after bytes, want <1048576)"
[ -f "${rotlog}.1" ] || fail "case e: rotated .1 file missing"
iso_line "$rotlog" || fail "case e: fresh log missing ISO-timestamped line after rotation"
pass "case e: >1MB log rotated to .1, fresh log under 1MB"

# --- case f: busy + over threshold + under hard ceiling -> defer, no kickstart --
mkdir -p "$tmp/kicks.f"
WATCHDOG_LOG="$tmp/log.f" \
WATCHDOG_PID_CMD='echo 12345' \
WATCHDOG_FOOTPRINT_CMD='echo 45' \
WATCHDOG_BUSY_CMD='echo conn' \
WATCHDOG_KICKSTART_CMD="touch $tmp/kicks.f/kick.\$RANDOM" \
  bash "$WATCHDOG_SH"
rc=$?
[ "$rc" -eq 0 ] || fail "case f: watchdog exited $rc, want 0"
[ "$(kicks "$tmp/kicks.f")" -eq 0 ] || fail "case f: kickstart fired while busy under hard ceiling"
grep -q 'busy, deferring' "$tmp/log.f" || fail "case f: missing 'busy, deferring' log line"
pass "case f: busy + 45GB over threshold, under ceiling (80) -> deferred, no kickstart"

# --- case g: busy + over hard ceiling -> exactly one kickstart (safety wins) -----
mkdir -p "$tmp/kicks.g"
WATCHDOG_LOG="$tmp/log.g" \
WATCHDOG_PID_CMD='echo 12345' \
WATCHDOG_FOOTPRINT_CMD='echo 85' \
WATCHDOG_BUSY_CMD='echo conn' \
WATCHDOG_HARD_CEILING_GB='80' \
WATCHDOG_KICKSTART_CMD="touch $tmp/kicks.g/kick.\$RANDOM" \
  bash "$WATCHDOG_SH"
rc=$?
[ "$rc" -eq 0 ] || fail "case g: watchdog exited $rc, want 0"
[ "$(kicks "$tmp/kicks.g")" -eq 1 ] || fail "case g: expected exactly 1 kickstart over hard ceiling, got $(kicks "$tmp/kicks.g")"
grep -q 'OVER HARD CEILING pid=12345' "$tmp/log.g" || fail "case g: missing OVER HARD CEILING log line"
pass "case g: busy + 85GB over hard ceiling (80) -> exactly one kickstart"

# --- case h: busy-check command fails -> counts as IDLE -> kickstart -------------
# A broken lsof must never suppress memory protection (fail-safe asymmetry).
mkdir -p "$tmp/kicks.h"
WATCHDOG_LOG="$tmp/log.h" \
WATCHDOG_PID_CMD='echo 12345' \
WATCHDOG_FOOTPRINT_CMD='echo 45' \
WATCHDOG_BUSY_CMD='exit 1' \
WATCHDOG_KICKSTART_CMD="touch $tmp/kicks.h/kick.\$RANDOM" \
  bash "$WATCHDOG_SH"
rc=$?
[ "$rc" -eq 0 ] || fail "case h: watchdog exited $rc, want 0"
[ "$(kicks "$tmp/kicks.h")" -eq 1 ] || fail "case h: failed busy-check must count as IDLE and kickstart once, got $(kicks "$tmp/kicks.h")"
grep -q 'OVER THRESHOLD pid=12345' "$tmp/log.h" || fail "case h: missing OVER THRESHOLD log line"
pass "case h: failed busy-check counts as IDLE -> kickstart fires"

# --- case i: invalid hard ceiling resets to default, busy-guard still works ------
mkdir -p "$tmp/kicks.i"
WATCHDOG_LOG="$tmp/log.i" \
WATCHDOG_PID_CMD='echo 12345' \
WATCHDOG_FOOTPRINT_CMD='echo 45' \
WATCHDOG_BUSY_CMD='echo conn' \
WATCHDOG_HARD_CEILING_GB='banana' \
WATCHDOG_KICKSTART_CMD="touch $tmp/kicks.i/kick.\$RANDOM" \
  bash "$WATCHDOG_SH"
rc=$?
[ "$rc" -eq 0 ] || fail "case i: watchdog exited $rc, want 0"
[ "$(kicks "$tmp/kicks.i")" -eq 0 ] || fail "case i: busy at 45GB under default ceiling should defer"
grep -q "bad WATCHDOG_HARD_CEILING_GB='banana'" "$tmp/log.i" || fail "case i: missing bad-ceiling reset log line"
grep -q 'busy, deferring' "$tmp/log.i" || fail "case i: busy-guard broken after ceiling reset"
pass "case i: invalid ceiling resets to 80; busy-guard defers at 45GB"

# --- cases j/k/l: DEFAULT action branch (no WATCHDOG_KICKSTART_CMD) --------------
# The default branch invokes `launchctl` UNQUALIFIED, so a PATH shim fakes it
# hermetically: the shim appends every invocation ("$*") to a per-case calls
# file and (cases j/l) forwards the TERM to a disposable `sleep 300 &` child —
# the ONLY pid these cases ever signal. Real launchctl is never reached.

# make_shim <calls_file> [<pid_to_TERM_on_'kill TERM'>]
make_shim() {
  mkdir -p "$tmp/bin"
  {
    echo '#!/bin/bash'
    echo "echo \"\$*\" >> '$1'"
    if [ -n "${2:-}" ]; then
      echo "if [ \"\${1:-}\" = kill ] && [ \"\${2:-}\" = TERM ]; then kill -TERM $2 2>/dev/null; fi"
    fi
    echo 'exit 0'
  } >"$tmp/bin/launchctl"
  chmod +x "$tmp/bin/launchctl"
}

# --- case j: default branch, phase-1 graceful — TERM lands, target exits ---------
sleep 300 &
target_j=$!
disown "$target_j"   # keep bash from printing an async 'Terminated' notice
targets="$targets $target_j"
make_shim "$tmp/calls.j" "$target_j"
PATH="$tmp/bin:$PATH" \
WATCHDOG_LOG="$tmp/log.j" \
WATCHDOG_PID_CMD="echo $target_j" \
WATCHDOG_FOOTPRINT_CMD='echo 45' \
WATCHDOG_BUSY_CMD='true' \
WATCHDOG_TERM_GRACE_S=5 \
  bash "$WATCHDOG_SH"
rc=$?
[ "$rc" -eq 0 ] || fail "case j: watchdog exited $rc, want 0"
[ "$(grep -c "^kill TERM gui/$(id -u)/com.user.memory-system.embed-server\$" "$tmp/calls.j")" -eq 1 ] \
  || fail "case j: expected exactly one 'kill TERM gui/$(id -u)/...' launchctl call (calls: $(cat "$tmp/calls.j"))"
! grep -q 'kickstart' "$tmp/calls.j" || fail "case j: kickstart fired despite graceful phase-1 exit"
grep -q 'phase 1: sent SIGTERM' "$tmp/log.j" || fail "case j: missing 'phase 1: sent SIGTERM' log line"
grep -q 'graceful drain' "$tmp/log.j" || fail "case j: missing 'graceful drain' log line"
kill -0 "$target_j" 2>/dev/null && fail "case j: target pid $target_j still alive after graceful phase 1"
pass "case j: default branch phase 1 — one 'kill TERM', no kickstart, target exited"

# --- case k: default branch, phase-2 fallback — TERM ignored, grace expires ------
sleep 300 &
target_k=$!
disown "$target_k"
targets="$targets $target_k"
make_shim "$tmp/calls.k"   # record-only shim: the TERM is never forwarded
PATH="$tmp/bin:$PATH" \
WATCHDOG_LOG="$tmp/log.k" \
WATCHDOG_PID_CMD="echo $target_k" \
WATCHDOG_FOOTPRINT_CMD='echo 45' \
WATCHDOG_BUSY_CMD='true' \
WATCHDOG_TERM_GRACE_S=2 \
  bash "$WATCHDOG_SH"
rc=$?
[ "$rc" -eq 0 ] || fail "case k: watchdog exited $rc, want 0"
grep -q 'phase 2:' "$tmp/log.k" || fail "case k: missing 'phase 2:' log line after grace expiry"
[ "$(grep -c "^kickstart -k gui/$(id -u)/com.user.memory-system.embed-server\$" "$tmp/calls.k")" -eq 1 ] \
  || fail "case k: expected exactly one 'kickstart -k gui/$(id -u)/...' launchctl call (calls: $(cat "$tmp/calls.k"))"
kill "$target_k" 2>/dev/null
pass "case k: default branch phase 2 — TERM ignored, kickstart -k after ${WATCHDOG_TERM_GRACE_S:-2}s grace"

# --- case l: bad WATCHDOG_TERM_GRACE_S resets to default; phase 1 still works ----
sleep 300 &
target_l=$!
disown "$target_l"
targets="$targets $target_l"
make_shim "$tmp/calls.l" "$target_l"
PATH="$tmp/bin:$PATH" \
WATCHDOG_LOG="$tmp/log.l" \
WATCHDOG_PID_CMD="echo $target_l" \
WATCHDOG_FOOTPRINT_CMD='echo 45' \
WATCHDOG_BUSY_CMD='true' \
WATCHDOG_TERM_GRACE_S='banana' \
  bash "$WATCHDOG_SH"
rc=$?
[ "$rc" -eq 0 ] || fail "case l: watchdog exited $rc, want 0"
grep -q "bad WATCHDOG_TERM_GRACE_S='banana'" "$tmp/log.l" || fail "case l: missing bad-grace reset log line"
grep -q 'graceful drain' "$tmp/log.l" || fail "case l: phase 1 did not complete after grace reset"
! grep -q 'kickstart' "$tmp/calls.l" || fail "case l: kickstart fired despite graceful exit"
pass "case l: bad WATCHDOG_TERM_GRACE_S='banana' resets to 25; phase 1 completes"

echo "PASS: all embed-watchdog cases"
exit 0
