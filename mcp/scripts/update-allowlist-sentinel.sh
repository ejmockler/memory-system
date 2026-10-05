#!/usr/bin/env bash
#
# update-allowlist-sentinel.sh
#
# B13: gate-guarding-the-gates discipline (R36 S2).
# Run this AFTER legitimate canonical-allowlist.json edits to update the
# sentinel. The integrity test (mcp/test/canonical-block-integrity.test.mjs)
# compares sha256(canonical-allowlist.json) against the sentinel and BLOCKS
# if they diverge — any solo edit to the allowlist (without a matching
# sentinel update) is structurally surfaced as a contract violation.
#
# Chain: edit canonical block -> update content_sha256 in allowlist (R34) ->
# run this script to refresh sentinel (R36). All three must be in sync for
# the gate to pass.
#
# Usage:
#   bash mcp/scripts/update-allowlist-sentinel.sh
#
# Exits 0 on success. No arguments.

set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ALLOWLIST="${REPO_ROOT}/mcp/policy/canonical-allowlist.json"
SENTINEL="${REPO_ROOT}/mcp/policy/canonical-allowlist.sha256.sentinel"

if [ ! -f "${ALLOWLIST}" ]; then
  echo "FAIL: allowlist not found at ${ALLOWLIST}" >&2
  exit 1
fi

# Compute sha256 of raw file bytes. shasum -a 256 is portable on macOS + Linux.
HASH="$(shasum -a 256 "${ALLOWLIST}" | awk '{print $1}')"

if [ -z "${HASH}" ]; then
  echo "FAIL: shasum produced empty output for ${ALLOWLIST}" >&2
  exit 1
fi

# Atomic write: tmp file in same dir, then rename.
TMP="${SENTINEL}.tmp.$$"
printf '%s\n' "${HASH}" > "${TMP}"
mv "${TMP}" "${SENTINEL}"

echo "B13 sentinel updated: ${SENTINEL}"
echo "sha256(canonical-allowlist.json) = ${HASH}"
