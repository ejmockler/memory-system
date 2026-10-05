#!/usr/bin/env bash
# session-end-hook.sh — Claude Code SessionEnd → distillation-queue bridge.
#
# Contract (kb/agent-integration.md § session-end-hook.sh — "AUTHORITATIVE
# SCHEMA"):
#   - Read Claude Code hook JSON from stdin.
#   - Extract conversation_id (Claude Code's session_id; the bridge renames it
#     to conversation_id for the canonical batch schema).
#   - Look up chat_ledger_path from the fixed per-runtime table
#       (claude-code → <MEMORY_ROOT>/storage/sources/chat-claude-code.jsonl)
#     and tail-read the chat ledger (bounded by CHAT_LEDGER_TAIL_READ_MAX_BYTES
#     = 262144 bytes) for all chat events whose raw_content.conversation_id
#     matches this conversation_id.
#   - Build the AUTHORITATIVE-SCHEMA batch object — flat field set, frozen
#     names — and enqueue it at
#       <MEMORY_ROOT>/storage/distillation-queue/pending/<batch_id>.json
#     atomically (tmp + rename), schema:
#       {batch_id, runtime, conversation_id, reason,
#        chat_ledger_path,
#        range:{first_turn_id, last_turn_id, first_turn_ts, last_turn_ts},
#        turn_count, enqueued_at}
#   - If the tail-read finds zero matching turns, emit
#       reason: "hook_bridge_empty"
#     with range fields all null and turn_count 0, AND append a warning row to
#     hook-errors.jsonl with reason="empty_conversation_tail" (so the audit
#     log is honest about why the supervisor will no-op promote-skip).
#   - NEVER block the runtime: exit 0 always; errors append to
#       <MEMORY_ROOT>/hooks/hook-errors.jsonl
#   - No MCP calls, no secrets, no chat-ledger writes. The distillation
#     supervisor (sole key-holder) processes the batch when it claims it.
#
# Dependencies: jq, node (the latter generates ULIDs + ISO-8601 timestamps,
# tail-reads the chat ledger, parses JSONL, and assembles the batch JSON via
# a single one-liner — no npm deps, plain crypto.randomBytes + Crockford
# base32 + canonical JSON.stringify with stable key order over a flat object).

set -u
# NOTE: no `set -e` — every command's failure path is logged and swallowed; we
# guarantee `exit 0` to honor the never-block contract.

# CODE root: the checkout this script lives in (mcp/lib, sibling scripts).
# Derived only from the script location, never from MEMORY_ROOT.
CODE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# DATA root: MEMORY_ROOT redirects storage/policy/hook state; it defaults to
# the checkout, mirroring mcp/lib/config.js (CHECKOUT_ROOT vs MEMORY_ROOT).
MEMORY_ROOT="${MEMORY_ROOT:-${CODE_ROOT}}"; MEMSYS="${MEMORY_ROOT}"
HOOKS_DIR="${MEMSYS}/hooks"
TMP_DIR="${HOOKS_DIR}/.tmp"
ERR_LOG="${HOOKS_DIR}/hook-errors.jsonl"
QUEUE_PENDING="${MEMSYS}/storage/distillation-queue/pending"
MCP_LIB="${CODE_ROOT}/mcp/lib"

# Per-runtime chat ledger lookup. The SessionEnd hook is Claude-Code-specific
# (the only runtime that emits SessionEnd today); the lookup is one-entry but
# explicit so the contract is greppable and Phase 2 runtimes are an additive
# change here.
RUNTIME="claude-code"
CHAT_LEDGER_PATH="${MEMSYS}/storage/sources/chat-claude-code.jsonl"

mkdir -p "${TMP_DIR}" "${QUEUE_PENDING}" 2>/dev/null || true

# log_err <reason> [extra-json-object]
# Appends one JSONL row to hook-errors.jsonl. Uses jq to construct the row so
# the conversation_id (when known) is properly JSON-escaped. Failure of the
# log itself is silently swallowed — we will not let logging block the runtime.
log_err() {
  local reason="$1"
  local extra="${2:-{\}}"
  local now
  now="$(node -e 'process.stdout.write(new Date().toISOString())' 2>/dev/null || echo "")"
  if [ -z "${now}" ]; then now="1970-01-01T00:00:00.000Z"; fi
  printf '%s\n' "$(jq -cn \
    --arg ts "${now}" \
    --arg hook "session-end-hook" \
    --arg reason "${reason}" \
    --argjson extra "${extra}" \
    '{ts: $ts, hook: $hook, reason: $reason} + $extra' 2>/dev/null \
    || printf '{"ts":"%s","hook":"session-end-hook","reason":"%s"}' "${now}" "${reason}")" \
    >> "${ERR_LOG}" 2>/dev/null || true
}

# log_warn — separate channel for the empty-conversation case. Per task spec
# the warning row uses the simpler shape {ts, hook:"session-end",
# conversation_id, reason:"empty_conversation_tail"} (NOT "session-end-hook")
# — see kb/agent-integration.md § Hook bridge integration empty-conversation
# rule.
log_warn() {
  local reason="$1"
  local conv_id="$2"
  local now
  now="$(node -e 'process.stdout.write(new Date().toISOString())' 2>/dev/null || echo "")"
  if [ -z "${now}" ]; then now="1970-01-01T00:00:00.000Z"; fi
  printf '%s\n' "$(jq -cn \
    --arg ts "${now}" \
    --arg hook "session-end" \
    --arg cid "${conv_id}" \
    --arg reason "${reason}" \
    '{ts: $ts, hook: $hook, conversation_id: $cid, reason: $reason}' 2>/dev/null \
    || printf '{"ts":"%s","hook":"session-end","conversation_id":"%s","reason":"%s"}' "${now}" "${conv_id}" "${reason}")" \
    >> "${ERR_LOG}" 2>/dev/null || true
}

# 1. Capture stdin to a temp file on the same volume as the destination
#    (atomic-rename property). The temp file is uniquely named to avoid
#    collisions across concurrent hook fires.
STDIN_TMP="${TMP_DIR}/session-end-stdin.$$.$(date +%s 2>/dev/null || echo 0).json"
if ! cat > "${STDIN_TMP}" 2>/dev/null; then
  log_err "stdin_capture_failed"
  rm -f "${STDIN_TMP}" 2>/dev/null || true
  exit 0
fi

cleanup() { rm -f "${STDIN_TMP}" 2>/dev/null || true; }
trap cleanup EXIT
trap 'cleanup; exit 0' INT TERM

# 2. Validate JSON parses.
if ! jq -e '.' "${STDIN_TMP}" >/dev/null 2>&1; then
  log_err "json_parse_failed"
  exit 0
fi

# 3. Extract conversation_id. Claude Code's SessionEnd payload uses
#    `session_id`; the bridge accepts either field name (forward-compat) and
#    surfaces a normalized `conversation_id` for the batch schema. The
#    `// empty` chain falls through to no-output (empty string) when both
#    fields are absent or null, which the next check catches.
CONV_ID="$(jq -r '.conversation_id // .session_id // empty' "${STDIN_TMP}" 2>/dev/null)"

if [ -z "${CONV_ID}" ] || [ "${CONV_ID}" = "null" ]; then
  log_err "missing_conversation_id"
  exit 0
fi

# 4. Hand control to node for: ULID mint, ISO-8601 enqueued_at, tail-read of
#    the chat ledger (bounded by CHAT_LEDGER_TAIL_READ_MAX_BYTES = 262144),
#    JSONL parse, range extraction, and assembly of the AUTHORITATIVE-shape
#    batch JSON. Single node invocation = single startup cost. Node emits the
#    final JSON object on stdout; bash writes it to disk under atomic rename.
#
#    The serverTs helper is imported from mcp/lib/envelope.js so the timestamp
#    format matches every other producer in the system (canonical JS ISO-8601
#    via new Date().toISOString()).
BATCH_JSON="$(
  HOOK_CONV_ID="${CONV_ID}" \
  HOOK_RUNTIME="${RUNTIME}" \
  CHAT_LEDGER_PATH="${CHAT_LEDGER_PATH}" \
  MCP_LIB="${MCP_LIB}" \
  ERR_LOG="${ERR_LOG}" \
  node --input-type=module -e '
    import { statSync, openSync, readSync, closeSync, appendFileSync } from "node:fs";
    import { randomBytes } from "node:crypto";
    import { pathToFileURL } from "node:url";
    import { join } from "node:path";

    const MCP_LIB = process.env.MCP_LIB;
    const { serverTs } = await import(pathToFileURL(join(MCP_LIB, "envelope.js")).href);
    const { CAPS } = await import(pathToFileURL(join(MCP_LIB, "validation.js")).href);

    // F-T2-CHAT_CLAUDE-CODE-F5 / F8 — bounded ledger tail-read budget. Now
    // sourced from CAPS.CHAT_LEDGER_TAIL_READ_MAX_BYTES (2 MiB) so the two
    // hooks (stop-hook.sh + this one) cannot drift on the cap value. Defensive
    // fallback to 2 MiB if CAPS export is somehow absent so the hook still
    // succeeds rather than crashing on undefined.
    const TAIL_MAX = Number.isInteger(CAPS?.CHAT_LEDGER_TAIL_READ_MAX_BYTES)
      ? CAPS.CHAT_LEDGER_TAIL_READ_MAX_BYTES
      : 2 * 1024 * 1024;
    const CONV_ID = process.env.HOOK_CONV_ID;
    const RUNTIME = process.env.HOOK_RUNTIME;
    const LEDGER_PATH = process.env.CHAT_LEDGER_PATH;
    const ERR_LOG = process.env.ERR_LOG;

    function logErr(reason, detail) {
      try {
        const line = JSON.stringify({
          ts: serverTs(),
          hook: "session-end-hook:node",
          reason,
          detail: detail ?? null,
        });
        appendFileSync(ERR_LOG, line + "\n");
      } catch { /* never throw from error logger */ }
    }

    // ULID — Crockford base32 over [48-bit ms timestamp || 80-bit randomness].
    // Matches the inline ulid() in daemons/watermark.js / hooks/stop-hook.sh.
    const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    function ulid() {
      let now = Date.now();
      const time = new Array(10);
      for (let i = 9; i >= 0; i--) { time[i] = ENC[now % 32]; now = Math.floor(now / 32); }
      const rand = randomBytes(10);
      let r = "";
      for (let i = 0; i < 10; i++) r += ENC[rand[i] % 32];
      return time.join("") + r;
    }

    // Tail-read the chat ledger up to TAIL_MAX bytes. Returns the raw text
    // of (possibly the last partial line +) all subsequent full lines.
    function tailRead() {
      let st;
      try { st = statSync(LEDGER_PATH); } catch (e) {
        if (e && e.code === "ENOENT") return { text: "", start: 0 };
        logErr("ledger_stat_failed", String(e && e.message));
        return null;
      }
      const size = st.size;
      if (size === 0) return { text: "", start: 0 };
      const readLen = Math.min(size, TAIL_MAX);
      const start = size - readLen;
      // F-NEW-W2-CHAT-CC-TRANSCRIPT-TRUNCATION-WARN — surface a structured
      // log line when the tail-read cap kicks in. This is the SessionEnd
      // equivalent of the stop-hook truncation warn: a 2 MiB-capped
      // tail-read on a ledger >2 MiB silently drops the older turns of
      // the conversation from the supervisor batch range, so the
      // distillation queue sees only the trailing window. Logging the
      // event lets the operator notice when a session exceeds the cap
      // (the F8 predicate hint to widen to 4 MiB is the natural next
      // step if this fires repeatedly).
      if (readLen === TAIL_MAX && size > TAIL_MAX) {
        logErr("transcript_truncated_for_extract", JSON.stringify({
          source: LEDGER_PATH,
          ledger_size: size,
          tail_read_max_bytes: TAIL_MAX,
          read_bytes: readLen,
          truncated_bytes: size - readLen,
        }));
      }
      const buf = Buffer.alloc(readLen);
      let fd = null;
      try {
        fd = openSync(LEDGER_PATH, "r");
        let off = 0;
        while (off < readLen) {
          const n = readSync(fd, buf, off, readLen - off, start + off);
          if (n <= 0) break;
          off += n;
        }
      } catch (e) {
        logErr("ledger_read_failed", String(e && e.message));
        try { if (fd != null) closeSync(fd); } catch {}
        return null;
      } finally {
        try { if (fd != null) closeSync(fd); } catch {}
      }
      return { text: buf.toString("utf8"), start };
    }

    const tail = tailRead();
    // tail === null → unrecoverable read failure already logged. Fall through
    // to hook_bridge_empty so the supervisor still settles the conversation.
    const lines = (tail ? tail.text : "").split("\n");
    // If we did NOT start at offset 0, the first record may be partial — drop it.
    const firstFullIdx = (tail && tail.start === 0) ? 0 : 1;

    // Walk lines in REVERSE so the first match we collect is the newest.
    // Collect ALL turns matching this conversation_id (within tail budget).
    // newest_first[0] = newest turn; newest_first[N-1] = oldest turn in budget.
    const newestFirst = [];
    for (let i = lines.length - 1; i >= firstFullIdx; i--) {
      const line = lines[i];
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const rc = obj && obj.raw_content;
      if (rc && rc.conversation_id === CONV_ID &&
          typeof obj.source_msg_id === "string" &&
          typeof obj.ts === "string") {
        newestFirst.push({ id: obj.source_msg_id, ts: obj.ts });
      }
    }

    const enqueuedAt = serverTs();
    const batchId = ulid();

    let reason, range, turnCount;
    if (newestFirst.length === 0) {
      reason = "hook_bridge_empty";
      range = {
        first_turn_id: null,
        last_turn_id:  null,
        first_turn_ts: null,
        last_turn_ts:  null,
      };
      turnCount = 0;
    } else {
      // newest_first[0] is newest → last_turn_*; last entry is oldest → first_turn_*.
      const newest = newestFirst[0];
      const oldest = newestFirst[newestFirst.length - 1];
      reason = "hook_bridge";
      range = {
        first_turn_id: oldest.id,
        last_turn_id:  newest.id,
        first_turn_ts: oldest.ts,
        last_turn_ts:  newest.ts,
      };
      turnCount = newestFirst.length;
    }

    // Emit the AUTHORITATIVE batch shape — flat top-level fields in the order
    // the spec defines them. JSON.stringify with no replacer preserves
    // insertion order; downstream consumers are JSON-aware and do not depend
    // on byte-exact ordering (canonical_json is for hashing, not transport).
    const batch = {
      batch_id: batchId,
      runtime: RUNTIME,
      conversation_id: CONV_ID,
      reason,
      chat_ledger_path: LEDGER_PATH,
      range,
      turn_count: turnCount,
      enqueued_at: enqueuedAt,
    };

    process.stdout.write(JSON.stringify(batch));
  ' 2>>"${ERR_LOG}"
)"
NODE_RC=$?

if [ ${NODE_RC} -ne 0 ] || [ -z "${BATCH_JSON}" ]; then
  log_err "node_batch_build_failed" "$(jq -cn --arg cid "${CONV_ID}" --arg rc "${NODE_RC}" '{conversation_id: $cid, node_rc: $rc}')"
  exit 0
fi

# Re-verify the produced line parses as JSON before we touch the queue.
if ! printf '%s' "${BATCH_JSON}" | jq -e . >/dev/null 2>&1; then
  log_err "batch_json_unparseable" "$(jq -cn --arg cid "${CONV_ID}" '{conversation_id: $cid}')"
  exit 0
fi

# 5. Extract batch_id and reason from the node-emitted object (single jq
#    invocation; we need batch_id for the on-disk filename and reason to know
#    whether to log the empty-conversation warning).
BATCH_ID="$(printf '%s' "${BATCH_JSON}" | jq -r '.batch_id // empty' 2>/dev/null)"
BATCH_REASON="$(printf '%s' "${BATCH_JSON}" | jq -r '.reason // empty' 2>/dev/null)"

if [ -z "${BATCH_ID}" ] || [ "${BATCH_ID}" = "null" ]; then
  log_err "missing_batch_id_in_node_output" "$(jq -cn --arg cid "${CONV_ID}" '{conversation_id: $cid}')"
  exit 0
fi

# 6. Empty-conversation warning row (per task spec algorithm step 5). This is
#    a non-fatal signal — the batch is still enqueued with reason
#    "hook_bridge_empty" so the supervisor settles the conversation honestly
#    (see kb/agent-integration.md § Distillation batch reason enum).
if [ "${BATCH_REASON}" = "hook_bridge_empty" ]; then
  log_warn "empty_conversation_tail" "${CONV_ID}"
fi

# 7. Atomic claim: write to a tmp file in pending/ (same volume as the final
#    name — rename(2) is atomic only within a filesystem), then rename into
#    place. The supervisor's directory watch picks up only the renamed file;
#    the tmp file's `.tmp.` prefix is filtered.
PEND_TMP="${QUEUE_PENDING}/.tmp.${BATCH_ID}.$$"
FINAL="${QUEUE_PENDING}/${BATCH_ID}.json"

if ! printf '%s\n' "${BATCH_JSON}" > "${PEND_TMP}" 2>/dev/null; then
  log_err "queue_tmp_write_failed" "$(jq -cn --arg cid "${CONV_ID}" --arg bid "${BATCH_ID}" '{conversation_id: $cid, batch_id: $bid}')"
  rm -f "${PEND_TMP}" 2>/dev/null || true
  exit 0
fi

if ! mv "${PEND_TMP}" "${FINAL}" 2>/dev/null; then
  log_err "queue_rename_failed" "$(jq -cn --arg cid "${CONV_ID}" --arg bid "${BATCH_ID}" '{conversation_id: $cid, batch_id: $bid}')"
  rm -f "${PEND_TMP}" 2>/dev/null || true
  exit 0
fi

# Success. No stdout output (SessionEnd hook stdout is not surfaced as a
# system reminder; we keep the channel quiet to avoid runtime noise).
exit 0
