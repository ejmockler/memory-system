#!/usr/bin/env bash
# recall-engagement-detect.sh — Claude Code UserPromptSubmit hook for
# F-SYN-INTEGRATION-ENGAGEMENT-DETECTOR-WIRING (Wave 9).
#
# DISCIPLINE — HOOKS-NEVER-BLOCK (kb/agent-integration.md, architect review):
#   Semantic classification does NOT happen here. This hook only collects
#   raw signal (current_turn text + prior_recall context) and FIRE-AND-FORGETs
#   a JSONL line onto <MEMORY_ROOT>/policy/engagement-queue.jsonl. The
#   watermark daemon's idle tick reads the queue, invokes
#   `mcp/lib/synthesis/engagement-detector.js#processEngagementQueue`, and
#   appends one engagement row per memory via damping-log.appendEngagement.
#
# The hook ALWAYS exits 0. Any failure routes to hook-errors.jsonl. The hook
# MUST NOT touch the damping log directly (private invariant S9/I8 — only
# the daemon-side seam reaches the damping log).
#
# Dependencies: jq, node >= 22.18.0 (the floor in mcp/package.json engines).
#
# Hook payload (Claude Code UserPromptSubmit):
#   {
#     session_id, conversation_id, transcript_path, cwd, hook_event_name,
#     prompt: <string>,  // the just-submitted user turn
#     ...
#   }
#
# Optional environment / sidecar:
#   <MEMORY_ROOT>/policy/recall-context.json
#     {prior_recall_id, prior_recall_brief:{recall_id, surfaced:[{memory_id, content}]}}
#   Written by the recall handler's caller (a separate WU); if absent, the
#   hook still enqueues a signal with an empty prior_recall_brief so the
#   daemon can no-op rather than silently dropping the turn.

set -u

# CODE root: the checkout this script lives in (mcp/lib, sibling scripts).
# Derived only from the script location, never from MEMORY_ROOT.
CODE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# DATA root: MEMORY_ROOT redirects storage/policy/hook state; it defaults to
# the checkout, mirroring mcp/lib/config.js (CHECKOUT_ROOT vs MEMORY_ROOT).
MEMORY_ROOT="${MEMORY_ROOT:-${CODE_ROOT}}"
HOOK_DIR="${MEMORY_ROOT}/hooks"
TMP_DIR="${HOOK_DIR}/.tmp"
ERR_LOG="${HOOK_DIR}/hook-errors.jsonl"
POLICY_DIR="${MEMORY_ROOT}/policy"
QUEUE_PATH="${POLICY_DIR}/engagement-queue.jsonl"
RECALL_CONTEXT_PATH="${POLICY_DIR}/recall-context.json"
MCP_LIB="${CODE_ROOT}/mcp/lib"

mkdir -p "${TMP_DIR}" "${POLICY_DIR}" 2>/dev/null || true

log_err() {
  local reason="$1"
  local detail="${2:-}"
  local ts
  ts="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  local line
  line="$(jq -cn \
    --arg ts "${ts}" \
    --arg reason "${reason}" \
    --arg detail "${detail}" \
    '{ts:$ts, hook:"recall-engagement-detect.sh", reason:$reason, detail:$detail}' 2>/dev/null)" || \
    line="{\"ts\":\"${ts}\",\"hook\":\"recall-engagement-detect.sh\",\"reason\":\"${reason}\",\"detail_unencodable\":true}"
  printf '%s\n' "${line}" >>"${ERR_LOG}" 2>/dev/null || true
}

STDIN_TMP=
cleanup() {
  if [ -n "${STDIN_TMP}" ]; then
    rm -f "${STDIN_TMP}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 0' INT TERM

# ---- 1. Read stdin to tmp ----
STDIN_TMP="$(mktemp "${TMP_DIR}/recall-engagement.stdin.XXXXXX" 2>/dev/null)" || {
  STDIN_TMP=
  log_err "mktemp_failed" "${TMP_DIR}"
  exit 0
}
cat >"${STDIN_TMP}" 2>/dev/null || {
  log_err "stdin_read_failed" "${STDIN_TMP}"
  exit 0
}

# ---- 2. Defer to node for parsing + queue write. ----
# Node side is responsible for:
#   - Parsing the hook JSON + the optional recall-context sidecar
#   - Building the queue signal envelope
#   - Calling enqueueEngagementSignal (fire-and-forget; fsync inside)
# We hand off via env so node has all paths; node never reads from stdin.
HOOK_INPUT_PATH="${STDIN_TMP}" \
RECALL_CONTEXT_PATH="${RECALL_CONTEXT_PATH}" \
QUEUE_PATH="${QUEUE_PATH}" \
MCP_LIB="${MCP_LIB}" \
ERR_LOG="${ERR_LOG}" \
MEMORY_ROOT="${MEMORY_ROOT}" \
POLICY_BASE_DIR="${POLICY_DIR}" \
node --input-type=module -e '
  import { readFileSync, existsSync, appendFileSync } from "node:fs";
  import { pathToFileURL } from "node:url";
  import { join } from "node:path";

  const ERR_LOG = process.env.ERR_LOG;
  function logErr(reason, detail) {
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        hook: "recall-engagement-detect.sh:node",
        reason,
        detail: detail ?? null,
      });
      appendFileSync(ERR_LOG, line + "\n");
    } catch { /* never throw from error logger */ }
  }

  let detectorMod;
  try {
    const url = pathToFileURL(join(process.env.MCP_LIB, "synthesis/engagement-detector.js")).href;
    detectorMod = await import(url);
  } catch (e) {
    logErr("detector_import_failed", String(e && e.message));
    process.exit(0);
  }
  const { enqueueEngagementSignal } = detectorMod;
  if (typeof enqueueEngagementSignal !== "function") {
    logErr("detector_missing_enqueue", "");
    process.exit(0);
  }

  // Parse hook payload.
  let hook;
  try {
    const raw = readFileSync(process.env.HOOK_INPUT_PATH, "utf8");
    hook = JSON.parse(raw);
  } catch (e) {
    logErr("hook_json_parse_failed", String(e && e.message));
    process.exit(0);
  }

  const conversationId =
    (typeof hook.conversation_id === "string" && hook.conversation_id) ||
    (typeof hook.session_id === "string" && hook.session_id) || null;
  if (!conversationId) {
    logErr("missing_conversation_id", "neither conversation_id nor session_id present");
    process.exit(0);
  }

  const currentTurnText =
    (typeof hook.prompt === "string" && hook.prompt) ||
    (typeof hook.user_text === "string" && hook.user_text) ||
    (typeof hook.user_message === "string" && hook.user_message) ||
    "";
  if (currentTurnText.trim() === "") {
    // Empty / whitespace user turn — skip per spec § 6.6 edge case.
    process.exit(0);
  }

  // Optional sidecar: prior recall context. Absence is fine; the daemon
  // will no-op when prior_recall_brief.surfaced is empty.
  let priorRecallId = null;
  let priorRecallBrief = { recall_id: null, surfaced: [] };
  const ctxPath = process.env.RECALL_CONTEXT_PATH;
  if (existsSync(ctxPath)) {
    try {
      const ctx = JSON.parse(readFileSync(ctxPath, "utf8"));
      if (ctx && typeof ctx === "object") {
        if (typeof ctx.prior_recall_id === "string") {
          priorRecallId = ctx.prior_recall_id;
        }
        if (ctx.prior_recall_brief && typeof ctx.prior_recall_brief === "object") {
          priorRecallBrief = ctx.prior_recall_brief;
        }
      }
    } catch (e) {
      // Sidecar present but unparseable — log and continue with empty brief.
      logErr("recall_context_parse_failed", String(e && e.message));
    }
  }

  const turnIndex = Number.isInteger(hook.turn_index) ? hook.turn_index : null;

  // Fire-and-forget enqueue. The daemon will read + drain on its next tick.
  try {
    enqueueEngagementSignal({
      ts: new Date().toISOString(),
      conversation_id: conversationId,
      turn_index: turnIndex,
      prior_recall_id: priorRecallId,
      prior_recall_brief: priorRecallBrief,
      current_turn_text: currentTurnText,
    });
  } catch (e) {
    logErr("enqueue_failed", String(e && e.message));
    process.exit(0);
  }

  process.exit(0);
' >/dev/null 2>>"${ERR_LOG}" || true

# The hook ALWAYS exits 0. We do not block the next user turn on the
# success or failure of the enqueue — the daemon's next idle tick will
# read whatever landed.
exit 0
