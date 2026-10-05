#!/usr/bin/env bash
# stop-hook.sh — Claude Code Stop hook, per kb/agent-integration.md
# § stop-hook.sh — per-turn chat ledger append.
#
# Reads Claude Code hook JSON from stdin, computes deterministic
# source_msg_id = sha256(canonical_json({conversation_id, content_sha256,
# prev_source_msg_id})) where the field name is EXACTLY "prev_source_msg_id"
# (drift = the propagation bug class that bit rounds 8/9/10), then appends
# one chat event row to <MEMORY_ROOT>/storage/sources/chat-claude-code.jsonl
# under flock(1) (or, where flock is not installed, an atomic mkdir lock) and
# fsync.
#
# NEVER blocks the runtime: always exits 0. trap on EXIT releases the lock.
#
# Dependencies (Phase 1 install prerequisites):
#   - jq           (parse hook JSON on stdin)
#   - flock        (optional: atomic append lock, `brew install flock` on macOS; without it the hook takes a mkdir lock instead)
#   - node >=22.18.0 (canonical_json + sha256 + blake2b512-truncated-to-16-bytes via mcp/lib/validation.js)

set -u

# Disable pipefail / errexit deliberately. Every per-step failure is caught
# explicitly so we can route to hook-errors.jsonl and exit 0.

# CODE root: the checkout this script lives in (mcp/lib, sibling scripts).
# Derived only from the script location, never from MEMORY_ROOT.
CODE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# DATA root: MEMORY_ROOT redirects storage/policy/hook state; it defaults to
# the checkout, mirroring mcp/lib/config.js (CHECKOUT_ROOT vs MEMORY_ROOT).
MEMORY_ROOT="${MEMORY_ROOT:-${CODE_ROOT}}"
HOOK_DIR="${MEMORY_ROOT}/hooks"
TMP_DIR="${HOOK_DIR}/.tmp"
ERR_LOG="${HOOK_DIR}/hook-errors.jsonl"
SOURCES_DIR="${MEMORY_ROOT}/storage/sources"
LEDGER_PATH="${SOURCES_DIR}/chat-claude-code.jsonl"
LOCK_PATH="${SOURCES_DIR}/.chat-claude-code.lock"
MCP_LIB="${CODE_ROOT}/mcp/lib"

mkdir -p "${TMP_DIR}" "${SOURCES_DIR}" 2>/dev/null || true

# Atomic-quoted error logger. Always succeeds; never aborts the hook.
log_err() {
  local reason="$1"
  local detail="${2:-}"
  local ts
  ts="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  # Build a JSON line via jq so embedded quotes/newlines in detail are safe.
  local line
  line="$(jq -cn \
    --arg ts "${ts}" \
    --arg reason "${reason}" \
    --arg detail "${detail}" \
    '{ts:$ts, hook:"stop-hook.sh", reason:$reason, detail:$detail}' 2>/dev/null)" || \
    line="{\"ts\":\"${ts}\",\"hook\":\"stop-hook.sh\",\"reason\":\"${reason}\",\"detail_unencodable\":true}"
  printf '%s\n' "${line}" >>"${ERR_LOG}" 2>/dev/null || true
}

# Always release lock fd + remove stdin tmp on exit; always exit 0.
LOCK_FD=
# Set only while THIS process holds the mkdir fallback lock (no flock on PATH).
LOCK_DIR_HELD=
STDIN_TMP=
cleanup() {
  if [ -n "${LOCK_FD}" ]; then
    eval "exec ${LOCK_FD}>&-" 2>/dev/null || true
  fi
  if [ -n "${LOCK_DIR_HELD}" ]; then
    rmdir "${LOCK_DIR_HELD}" 2>/dev/null || true
    LOCK_DIR_HELD=
  fi
  if [ -n "${STDIN_TMP}" ]; then
    rm -f "${STDIN_TMP}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 0' INT TERM

# ---- 1. Read stdin to a tmp file (atomic-rename property — same volume) ----
STDIN_TMP="$(mktemp "${TMP_DIR}/stop-hook.stdin.XXXXXX" 2>/dev/null)" || {
  STDIN_TMP=
  log_err "mktemp_failed" "${TMP_DIR}"
  exit 0
}
cat >"${STDIN_TMP}" 2>/dev/null || {
  log_err "stdin_read_failed" "${STDIN_TMP}"
  exit 0
}

# ---- 2. Parse hook JSON; validate conversation_id present ----
# Claude Code Stop hook payload uses session_id; bridge translates to conversation_id.
# Defensive extraction: try several common field shapes; otherwise null.
HOOK_JSON="$(cat "${STDIN_TMP}" 2>/dev/null)" || { log_err "stdin_reread_failed" ""; exit 0; }
if ! printf '%s' "${HOOK_JSON}" | jq -e . >/dev/null 2>&1; then
  log_err "json_parse_failed" "stdin not valid JSON"
  exit 0
fi

CONVERSATION_ID="$(printf '%s' "${HOOK_JSON}" | jq -r '
  (.conversation_id // .session_id // empty) | select(type=="string" and length>0)
' 2>/dev/null)"
if [ -z "${CONVERSATION_ID}" ]; then
  log_err "missing_conversation_id" "neither conversation_id nor session_id present"
  exit 0
fi

# ---- 3. Hand stdin file off to node for canonical_json + sha256 + blake2b ----
# Node does ALL hashing and JSON canonicalisation (RFC 8785 JCS), tail-reads the
# ledger for prev_source_msg_id, and emits the final chat-event JSONL line on
# stdout. Bash then appends under flock. Single node invocation per hook fire.

CHAT_EVENT_LINE="$(
  HOOK_INPUT_PATH="${STDIN_TMP}" \
  LEDGER_PATH="${LEDGER_PATH}" \
  MCP_LIB="${MCP_LIB}" \
  ERR_LOG="${ERR_LOG}" \
  node --input-type=module -e '
    import { readFileSync, statSync, openSync, readSync, closeSync, appendFileSync } from "node:fs";
    import { createHash, randomBytes } from "node:crypto";
    import { pathToFileURL } from "node:url";
    import { join } from "node:path";
    const MCP_LIB = process.env.MCP_LIB;
    const { canonicalJson, CAPS } = await import(pathToFileURL(join(MCP_LIB, "validation.js")).href);
    const { serverTs } = await import(pathToFileURL(join(MCP_LIB, "envelope.js")).href);

    // F-T2-CHAT_CLAUDE-CODE-F5 / F8 — bounded ledger tail-read budget. Now
    // sourced from CAPS.CHAT_LEDGER_TAIL_READ_MAX_BYTES (2 MiB) instead of a
    // local 262144 constant. The audit observed 17+ tail_read_budget_exhausted
    // events at 256 KiB; the 2 MiB cap covers observed working-day session
    // ledger growth (~400 KB typical, ~1.5 MB long sessions). Defensive
    // fallback to 2 MiB if CAPS export is somehow absent so the hook still
    // succeeds rather than crashing on undefined.
    const TAIL_MAX = Number.isInteger(CAPS?.CHAT_LEDGER_TAIL_READ_MAX_BYTES)
      ? CAPS.CHAT_LEDGER_TAIL_READ_MAX_BYTES
      : 2 * 1024 * 1024;
    const LEDGER_PATH = process.env.LEDGER_PATH;
    const ERR_LOG = process.env.ERR_LOG;

    function logErr(reason, detail) {
      try {
        const line = JSON.stringify({
          ts: new Date().toISOString(),
          hook: "stop-hook.sh:node",
          reason,
          detail: detail ?? null,
        });
        appendFileSync(ERR_LOG, line + "\n");
      } catch { /* never throw from error logger */ }
    }

    // Read the hook payload back from stdin tmp.
    const raw = readFileSync(process.env.HOOK_INPUT_PATH, "utf8");
    let hook;
    try { hook = JSON.parse(raw); } catch (e) {
      logErr("node_json_parse_failed", String(e && e.message));
      process.exit(2);
    }

    const conversationId =
      (typeof hook.conversation_id === "string" && hook.conversation_id) ||
      (typeof hook.session_id === "string" && hook.session_id) || null;
    if (!conversationId) { logErr("node_missing_conversation_id", ""); process.exit(2); }

    // Defensive extraction of user/assistant text. R28.1 parity fix with
    // codex-cli connector: handle BOTH string-form and Anthropic Messages API
    // array-form content, e.g. [{type:"text", text:"..."}, {type:"tool_result",
    // content:"..."} | content:[{type:"text", text:"..."}, ...]]. Array-form
    // drop was the gemini-cli brutalist finding class; chat-claude-code shared
    // the same code path defect (only typeof === "string" was accepted).
    function extractText(v) {
      if (typeof v === "string") return v;
      if (v == null) return "";
      if (Array.isArray(v)) {
        const parts = [];
        for (const item of v) {
          if (typeof item === "string") { parts.push(item); continue; }
          if (item == null || typeof item !== "object") continue;
          // {type:"text", text:"..."} — Anthropic content block.
          if (typeof item.text === "string") { parts.push(item.text); continue; }
          // {type:"tool_result", content: "..." | [...] } — Anthropic tool turn.
          if (item.content != null) { parts.push(extractText(item.content)); continue; }
        }
        return parts.filter(Boolean).join("\n");
      }
      if (typeof v === "object") {
        if (typeof v.text === "string") return v.text;
        if (v.content != null) return extractText(v.content);
      }
      return "";
    }
    function pickField(...keys) {
      for (const k of keys) {
        if (k in hook) {
          const out = extractText(hook[k]);
          if (out) return out;
        }
      }
      return "";
    }
    // Defense-in-depth key-shape redaction. R28.1 parity fix: the operator
    // uses memory-system which references provider keys; conversation echo of
    // a key must not land verbatim in the ledger. Replace AIza... / AQ.... /
    // sk-ant-... shapes with "<REDACTED:KEY_SHAPE>". Runs BEFORE content_sha256
    // so the hash reflects the redacted form (downstream dedupe stays stable).
    const KEY_SHAPE_RX =
      /AIza[A-Za-z0-9_-]{35,}|AQ\.[A-Za-z0-9_-]{40,80}|sk-ant-[A-Za-z0-9_-]{40,}/g;
    function redactKeyShapes(s) {
      if (typeof s !== "string" || s.length === 0) return s;
      return s.replace(KEY_SHAPE_RX, "<REDACTED:KEY_SHAPE>");
    }
    let userText = redactKeyShapes(pickField("user_message", "user_text", "prompt"));
    let assistantText = redactKeyShapes(pickField("assistant_message", "assistant_text", "response"));

    // F-NEW-W9-STOP-HOOK-TRANSCRIPT-FALLBACK. Claude Code Stop hook input does
    // NOT carry user_message / assistant_message directly — it sends only
    // {session_id, transcript_path, cwd, hook_event_name, stop_hook_active}.
    // The pickField extraction above was written against an older hook spec
    // and silently returns "" against the current spec, producing 100% empty
    // user_text/assistant_text rows (audit-confirmed: 854/854 rows over 7d
    // were content-free; the memory_connectors_list source-effective-empty
    // probe correctly flagged the source as degraded).
    //
    // Fallback: when the direct extraction yields empty content and
    // transcript_path is present, read the transcript .jsonl and walk
    // bottom-up for the most recent user prompt + assistant text response.
    // Skip tool_use / tool_result / thinking entries (those are not
    // conversational content). Bounded by TAIL_MAX to keep the hook fast.
    function readTurnFromTranscript(transcriptPath) {
      if (typeof transcriptPath !== "string" || transcriptPath === "") {
        return { userText: "", assistantText: "" };
      }
      let st;
      try { st = statSync(transcriptPath); } catch (e) {
        logErr("transcript_stat_failed", String(e && e.message));
        return { userText: "", assistantText: "" };
      }
      const size = st.size;
      if (size === 0) return { userText: "", assistantText: "" };
      const readLen = Math.min(size, TAIL_MAX);
      const start = size - readLen;
      const buf = Buffer.alloc(readLen);
      let fd;
      try {
        fd = openSync(transcriptPath, "r");
        let off = 0;
        while (off < readLen) {
          const n = readSync(fd, buf, off, readLen - off, start + off);
          if (n <= 0) break;
          off += n;
        }
      } catch (e) {
        logErr("transcript_read_failed", String(e && e.message));
        try { if (fd != null) closeSync(fd); } catch {}
        return { userText: "", assistantText: "" };
      } finally {
        try { if (fd != null) closeSync(fd); } catch {}
      }
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      // Drop partial first line if we did not read from offset 0.
      const firstFullIdx = (start === 0) ? 0 : 1;
      let uText = "", aText = "";
      for (let i = lines.length - 1; i >= firstFullIdx; i--) {
        const line = lines[i];
        if (!line) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        const t = r && r.type;
        const msg = r && r.message;
        if (!msg) continue;
        if (t === "assistant" && !aText) {
          const content = msg.content;
          if (Array.isArray(content)) {
            const parts = [];
            for (const item of content) {
              if (item && item.type === "text" && typeof item.text === "string") {
                parts.push(item.text);
              }
            }
            if (parts.length > 0) aText = parts.join("\n");
          } else if (typeof content === "string" && content) {
            aText = content;
          }
        } else if (t === "user" && !uText) {
          const content = msg.content;
          // Only count real user prompts (string content). Skip arrays —
          // those are tool_result wrappers, not user-written prompts.
          if (typeof content === "string" && content) {
            uText = content;
          }
        }
        if (uText && aText) break;
      }
      return { userText: uText, assistantText: aText };
    }

    if (!userText && !assistantText) {
      const transcriptPath = typeof hook.transcript_path === "string"
        ? hook.transcript_path : "";
      if (transcriptPath) {
        const fromTranscript = readTurnFromTranscript(transcriptPath);
        userText = redactKeyShapes(fromTranscript.userText);
        assistantText = redactKeyShapes(fromTranscript.assistantText);
      }
    }

    const turnIndexRaw = hook.turn_index;
    const turnIndex = Number.isInteger(turnIndexRaw) ? turnIndexRaw : null;
    const cwd = typeof hook.cwd === "string" ? hook.cwd : null;

    // Tail-read the ledger backwards up to TAIL_MAX bytes for the most recent
    // entry whose raw_content.conversation_id matches.
    function tailReadPrev() {
      let st;
      try { st = statSync(LEDGER_PATH); } catch (e) {
        if (e && e.code === "ENOENT") return null; // first-ever turn
        logErr("ledger_stat_failed", String(e && e.message));
        return null;
      }
      const size = st.size;
      if (size === 0) return null;
      const readLen = Math.min(size, TAIL_MAX);
      const start = size - readLen;
      // F-NEW-W2-CHAT-CC-TRANSCRIPT-TRUNCATION-WARN — emit the structured
      // truncation log line BEFORE we walk the buffer. The cap-hit
      // condition is (readLen == TAIL_MAX && size > TAIL_MAX); that is,
      // we actually read fewer bytes than the ledger holds. The pre-
      // existing `tail_read_budget_exhausted` row below is narrower:
      // it only fires when the cap was hit AND we ALSO failed to find
      // a matching prev_source_msg_id. The new row fires UNCONDITIONALLY
      // on cap-hit so the operator sees every silent truncation, not
      // just the ones that also broke prev-id resolution.
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
      let fd;
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
      const text = buf.toString("utf8");
      // If we did not read from offset 0, the first newline-delimited record
      // may be partial — drop it.
      const lines = text.split("\n");
      const firstFullIdx = (start === 0) ? 0 : 1;
      let budgetExhaustedWithoutMatch = (start > 0);
      for (let i = lines.length - 1; i >= firstFullIdx; i--) {
        const line = lines[i];
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const rc = obj && obj.raw_content;
        if (rc && rc.conversation_id === conversationId && typeof obj.source_msg_id === "string") {
          return obj.source_msg_id;
        }
      }
      if (budgetExhaustedWithoutMatch) {
        logErr("tail_read_budget_exhausted", JSON.stringify({
          conversation_id: conversationId, ledger_size: size, read_bytes: readLen
        }));
      }
      return null;
    }

    const prevSourceMsgId = tailReadPrev(); // null OK

    // Canonical preimages. RFC 8785 JCS via validation.canonicalJson. Hash over
    // RAW UTF-8 bytes — never NFC-normalised. Field name is EXACTLY
    // "prev_source_msg_id" (propagation discipline).
    function sha256Hex(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
    // blake2b512 truncated to 16 bytes per kb/mcp-surface.md § Consumed-nonce
    // store; NOT a native blake2b-128 — see comment in mcp/lib/nonce-store.js
    // for why those two engines produce different bytes for the same input.
    function blake2b512TruncTo16Hex(bytes) {
      return createHash("blake2b512").update(bytes).digest().subarray(0, 16).toString("hex");
    }

    const contentPreimage = canonicalJson({ user_text: userText, assistant_text: assistantText });
    const contentSha256 = sha256Hex(Buffer.from(contentPreimage, "utf8"));

    const sourceMsgIdPreimage = canonicalJson({
      conversation_id: conversationId,
      content_sha256: contentSha256,
      prev_source_msg_id: prevSourceMsgId,
    });
    const sourceMsgId = sha256Hex(Buffer.from(sourceMsgIdPreimage, "utf8"));

    // ULID — minimal local implementation (Crockford base32, time + 80 random bits).
    function ulid() {
      const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
      let now = Date.now();
      const time = new Array(10);
      for (let i = 9; i >= 0; i--) { time[i] = ENC[now % 32]; now = Math.floor(now / 32); }
      const rand = randomBytes(10);
      let r = "";
      for (let i = 0; i < 10; i++) r += ENC[rand[i] % 32];
      return time.join("") + r;
    }

    const event = {
      id: "ulid_" + ulid(),
      ts: serverTs(),
      source: "chat-claude-code",
      source_msg_id: sourceMsgId,
      parties: ["user", "assistant"],
      raw_content: {
        conversation_id: conversationId,
        turn_index: turnIndex,
        user_text: userText,
        assistant_text: assistantText,
        runtime: "claude-code",
        cwd,
      },
      attachments: [],
      source_policy: {
        deletion_semantics: "full_excise",
        consent_basis: "first_party",
      },
    };

    // Checksum (architecture.md M2 fix): blake2b512-truncated-to-16-bytes hex
    // over canonical_json of ALL other fields. Compute BEFORE write so the
    // writer can self-verify. See kb/mcp-surface.md § Consumed-nonce store
    // → "Why blake2b512 truncated to 16 bytes and not blake2b-128".
    event.checksum = blake2b512TruncTo16Hex(Buffer.from(canonicalJson(event), "utf8"));

    // Emit the final JSONL line on stdout (single line, "\n" appended by bash).
    process.stdout.write(JSON.stringify(event));
  ' 2>>"${ERR_LOG}"
)"
NODE_RC=$?

if [ ${NODE_RC} -ne 0 ] || [ -z "${CHAT_EVENT_LINE}" ]; then
  log_err "node_chat_event_build_failed" "rc=${NODE_RC}"
  exit 0
fi

# Re-verify the produced line parses as JSON before we touch the lock.
if ! printf '%s' "${CHAT_EVENT_LINE}" | jq -e . >/dev/null 2>&1; then
  log_err "chat_event_unparseable" ""
  exit 0
fi

# ---- 4. Acquire lock; append; fsync; release. ----
# With flock(1) on PATH the lock is the fd-9 flock below, exactly as before
# (those lines are kept unindented so they stay identical to the flock-only
# version). Without it (a stock macOS account has no flock) the hook takes an
# atomic mkdir lock on "${LOCK_PATH}.d" instead.
if command -v flock >/dev/null 2>&1; then
# fd 9 is the lock fd. flock(1) waits indefinitely — acceptable per the spec
# (the lock is held only across one append + fsync, <10ms typical).
LOCK_FD=9
# Open (creating if needed) the lock file for writing on fd 9.
if ! exec 9>>"${LOCK_PATH}"; then
  log_err "lock_open_failed" "${LOCK_PATH}"
  exit 0
fi

if ! flock -x 9 2>/dev/null; then
  log_err "flock_failed" "${LOCK_PATH}"
  exit 0
fi
else
  # mkdir is atomic: exactly one concurrent caller creates the directory.
  # Bounded wait (never blocks the runtime for long), and a lock directory
  # older than LOCK_STALE_SECS is treated as left behind by a killed hook
  # (the holder normally keeps it for one append + fsync) and removed. The
  # wait bound is longer than the stale threshold, so a leftover lock delays
  # one turn but does not drop it.
  LOCK_DIR="${LOCK_PATH}.d"
  LOCK_STALE_SECS=10
  LOCK_MAX_TRIES=150
  lock_tries=0
  while ! mkdir "${LOCK_DIR}" 2>/dev/null; do
    lock_tries=$((lock_tries + 1))
    if [ "${lock_tries}" -ge "${LOCK_MAX_TRIES}" ]; then
      log_err "lock_timeout" "${LOCK_DIR}"
      exit 0
    fi
    # Lock dir mtime: BSD stat first, GNU stat as the fallback.
    lock_mtime="$(stat -f %m "${LOCK_DIR}" 2>/dev/null)" || \
      lock_mtime="$(stat -c %Y "${LOCK_DIR}" 2>/dev/null)" || lock_mtime=
    case "${lock_mtime}" in
      ''|*[!0-9]*) ;;
      *)
        if [ $(( $(date +%s) - lock_mtime )) -gt "${LOCK_STALE_SECS}" ]; then
          rmdir "${LOCK_DIR}" 2>/dev/null || true
          continue
        fi
        ;;
    esac
    sleep 0.1
  done
  LOCK_DIR_HELD="${LOCK_DIR}"
fi

# Append the JSONL line + LF, then fsync via a node one-liner (bash has no
# portable fsync). The lock is still held; we release on exit.
if ! printf '%s\n' "${CHAT_EVENT_LINE}" >>"${LEDGER_PATH}" 2>/dev/null; then
  log_err "ledger_append_failed" "${LEDGER_PATH}"
  exit 0
fi

LEDGER_PATH="${LEDGER_PATH}" node -e '
  import("node:fs").then(({ openSync, fsyncSync, closeSync }) => {
    try {
      const fd = openSync(process.env.LEDGER_PATH, "r+");
      fsyncSync(fd);
      closeSync(fd);
    } catch (_) { /* fsync best-effort */ }
  });
' >/dev/null 2>&1 || true

# trap will close lock fd → flock releases (or rmdir the mkdir lock).
exit 0
