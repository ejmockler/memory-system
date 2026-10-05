// Stage-0 hard-drop module for the `chat-claude-code` source
// (F-T2-CHAT_CLAUDE-CODE-F6 / F7).
//
// Layer 1 of the R25 salience cascade for Claude Code agent-runtime hook
// captures. Input: a fully-formed source-row event from
// storage/sources/chat-claude-code.jsonl (shape produced by hooks/stop-hook.sh
// — per-turn user/assistant pair with raw_content carrying conversation_id,
// turn_index, user_text, assistant_text, runtime="claude-code", cwd).
//
// Rules:
//   1. raw_content.user_text empty AND raw_content.assistant_text empty
//                                                        → DROP (empty_turn)
//      The audit found 832/834 rows in the ledger (~99.75%) carrying both
//      fields empty — the Stop hook fires on every turn, including the
//      pure-tool-call turns where Claude Code never surfaces text on either
//      side. These are not recoverable signal; we do not quarantine them.
//   2. isContentFree(row, "chat-claude-code") returns drop=true
//                                                        → DROP (content_free)
//      The shared predicate uses content-fields-manifest.js: any row whose
//      declared fields (user_text + assistant_text) are all
//      empty/whitespace-only is content-free. Rule 1 fires first for the
//      common case; Rule 2 is the safety net for shape drift (e.g. a future
//      manifest revision adds another field).
//   3. otherwise                                          → PASS
//
// Why NOT quarantine empty_turn / content_free:
//   These rows carry no operator intent and no recoverable signal. The hook
//   fired on a turn where Claude Code emitted a tool-only response with no
//   user-visible text on either side. The conversation_id + ts are preserved
//   in the source ledger (storage/sources/chat-claude-code.jsonl) so the
//   chain hash continuity stays intact; the salience cascade just skips them.
//   Per CRITIC INVARIANTS: this is the correct case for permanent DROP — the
//   rows have zero cross-source corroboration value (no extractable content
//   to corroborate against), and the source ledger is the durable record of
//   "the hook fired".
//
// On PASS we emit a structural_score hint derived from
// CAPS.SALIENCE_STRUCTURAL_RULES["chat-claude-code"]. Substantive prose wins
// when either side has substantial body text; subject_only is the
// short-dialogue fallback.

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { CAPS } from "../../validation.js";
import { isContentFree } from "../../predicates/content-free.js";
import { quarantineRow } from "../quarantine.js";
import { STORAGE_DIR } from "../../config.js";
// F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION — canonical band helper.
// chat-claude-code mirrors codex-cli's cliff on joined user+assistant
// length at SUBJECT_ONLY_CHAR_THRESHOLD.
import { computeStructuralScore } from "../structural-score.js";

// Mirror codex-cli's threshold for "substantive vs subject-only" routing.
// Combined user_text + assistant_text length; 64 chars matches the
// codex-cli convention so cross-source corroboration sees comparable
// structural-score bands when an operator runs both tools.
const SUBJECT_ONLY_CHAR_THRESHOLD = 64;

// ---------------------------------------------------------------------------
// F-NEW-W2-CHAT-CC-CROSS-SOURCE-DEDUP — cross-source dedup index vs codex-cli.
// ---------------------------------------------------------------------------
//
// When an operator runs BOTH the chat-claude-code stop hook and a codex-cli
// session in the same cwd, a single conversational turn often lands in both
// source ledgers. The chat-claude-code copy is the later-emitting and the
// codex-cli copy carries fuller context (system_prompt_hash, tool_calls,
// developer_texts). We bucket recent codex-cli rows by
// (cwd, content_sha256[:12]) with a 5-min cache TTL, then drop a
// chat-claude-code turn that collides on key within a tight +/-10min wall-
// clock window. Quarantine (30d retention) preserves the row for restore if
// the dedup is wrong.
//
// Mirror pattern: F-T2-GITHUB_EVENTS-F8's gitlog SHA index (lazy build, 5m
// TTL, bounded by ledger size). The cache rebuild is O(bytes) over the
// trailing portion of codex-cli.jsonl; we bound the read to the last
// CODEX_TAIL_MAX_BYTES so a saturated codex-cli ledger does not slow the
// chat-claude-code hot path. The +/-10min window absorbs clock skew and
// pairing latency between the stop hook firing and codex-cli's rollout
// writer.
const CODEX_LEDGER_CACHE_TTL_MS = 5 * 60 * 1000;
const CODEX_DEDUP_WINDOW_MS = 10 * 60 * 1000;
// Tail-only read budget for the cache rebuild. 4 MiB covers a normal
// working-day codex-cli ledger (~1k rows). A larger ledger surfaces only
// the trailing window; older rows time out of the 10-min dedup window
// anyway so missing them is correct, not lossy.
const CODEX_TAIL_MAX_BYTES = 4 * 1024 * 1024;
// Hard cap on cache cardinality. Bounded growth even if a hostile or
// corrupt codex-cli ledger somehow grew past the tail budget.
const CODEX_DEDUP_CACHE_MAX_ENTRIES = 50_000;

let _codexDedupCache = null; // { byKey: Map<key, ts_ms[]>, builtAt: number }

function _codexLedgerPath() {
  return join(STORAGE_DIR, "sources", "codex-cli.jsonl");
}

function _sha12(userText, assistantText) {
  // Match the chat-claude-code stop-hook's content_sha256 preimage shape
  // (canonical {user_text, assistant_text}) so an operator's intuitive
  // "same content" matches across sources. We use sha256 hex truncated to
  // 12 chars per the node spec — high enough collision resistance for a
  // 5-min cache window but compact enough to be cheap to bucket.
  const u = typeof userText === "string" ? userText : "";
  const a = typeof assistantText === "string" ? assistantText : "";
  // Build a JSON-stable preimage WITHOUT pulling in the canonicalJson
  // dependency (this module is on the salience hot path). The two keys
  // are deterministically ordered and string-typed so a hand-built
  // template matches RFC 8785 JCS for this fixed shape.
  const preimage =
    '{"assistant_text":' + JSON.stringify(a) + ',"user_text":' + JSON.stringify(u) + "}";
  return createHash("sha256").update(Buffer.from(preimage, "utf8")).digest("hex").slice(0, 12);
}

function _buildCodexDedupIndex() {
  const path = _codexLedgerPath();
  const byKey = new Map(); // key=`${cwd}\x00${sha12}` -> ts_ms[]
  if (!existsSync(path)) {
    return { byKey, builtAt: Date.now() };
  }
  let raw;
  try {
    // Tail-only read so a huge codex-cli ledger does not stall the cascade
    // hot path. We use a stat + read-from-offset pattern parallel to the
    // chat-claude-code stop hook's tailReadPrev.
    const buf = readFileSync(path);
    if (buf.length === 0) return { byKey, builtAt: Date.now() };
    const start = Math.max(0, buf.length - CODEX_TAIL_MAX_BYTES);
    raw = buf.slice(start).toString("utf8");
    if (start > 0) {
      // Drop the leading partial line — we sliced mid-record.
      const idx = raw.indexOf("\n");
      raw = idx >= 0 ? raw.slice(idx + 1) : "";
    }
  } catch {
    return { byKey, builtAt: Date.now() };
  }
  if (raw === "") return { byKey, builtAt: Date.now() };
  const lines = raw.split("\n");
  for (const line of lines) {
    if (line === "") continue;
    if (byKey.size >= CODEX_DEDUP_CACHE_MAX_ENTRIES) break;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const rc = parsed && parsed.raw_content;
    if (!rc || typeof rc !== "object") continue;
    // codex-cli rows do NOT stamp raw_content.cwd today; cwd is implicit in
    // the conversation_id + session_file (rollout files live under
    // ~/.codex/sessions/<YYYY>/<MM>/<DD>/...). When cwd is absent on
    // either side, we still bucket on a synthetic "*" cwd so a sha-only
    // hit still triggers — this is the same pragmatic compromise the F8
    // gitlog index makes when the repo basename is missing. False positive
    // risk: a code snippet that happens to be identical across operator
    // sessions in different repos. Mitigation: the +/-10min wall-clock
    // window narrows the collision space to the tight live-session band,
    // and quarantine makes any wrong drop recoverable.
    const cwd =
      typeof rc.cwd === "string" && rc.cwd.length > 0 ? rc.cwd : "*";
    const sha = _sha12(rc.user_text, rc.assistant_text);
    const key = `${cwd}\x00${sha}`;
    const ts = typeof parsed.ts === "string" ? Date.parse(parsed.ts) : NaN;
    if (!Number.isFinite(ts)) continue;
    const arr = byKey.get(key);
    if (arr) {
      arr.push(ts);
    } else {
      byKey.set(key, [ts]);
    }
  }
  return { byKey, builtAt: Date.now() };
}

function _getCodexDedupIndex() {
  const now = Date.now();
  if (
    _codexDedupCache != null &&
    now - _codexDedupCache.builtAt < CODEX_LEDGER_CACHE_TTL_MS
  ) {
    return _codexDedupCache;
  }
  try {
    _codexDedupCache = _buildCodexDedupIndex();
  } catch {
    _codexDedupCache = { byKey: new Map(), builtAt: now };
  }
  return _codexDedupCache;
}

// Test-only cache reset + seed surface (mirrors githubevents F8 helpers).
export function _resetCodexDedupCacheForTest() {
  _codexDedupCache = null;
}
export function _seedCodexDedupCacheForTest(byKey) {
  _codexDedupCache = {
    byKey: byKey instanceof Map ? byKey : new Map(),
    builtAt: Date.now(),
  };
}

function isEmpty(v) {
  if (v == null) return true;
  if (typeof v !== "string") return false;
  return v.trim().length === 0;
}

// _shapeForQuarantine — quarantineRow requires row.source. Defensive stamp
// for tests that invoke stage0() directly with a synthetic event missing
// the source field; the dispatcher always stamps it.
function _shapeForQuarantine(event) {
  if (event && typeof event === "object") {
    if (typeof event.source === "string" && event.source.length > 0) return event;
    return { ...event, source: "chat-claude-code" };
  }
  return { source: "chat-claude-code", raw_content: {} };
}

export function stage0(event) {
  if (!event || typeof event !== "object") {
    return { decision: "PASS", reason: null };
  }
  const rc = event.raw_content || {};
  const userText = typeof rc.user_text === "string" ? rc.user_text : "";
  const assistantText =
    typeof rc.assistant_text === "string" ? rc.assistant_text : "";

  // Rule 1 — empty turn. Both sides blank. DROP without quarantine: the
  // operator's stop-hook fired on a turn that surfaced no user or assistant
  // text (tool-only turns are the dominant case per the audit). No
  // recoverable signal; the durable artefact is the hook firing itself, not
  // the empty payload.
  if (isEmpty(userText) && isEmpty(assistantText)) {
    return { decision: "DROP", reason: "empty_turn" };
  }

  // Rule 2 — content-free safety net via the shared predicate. Catches
  // shape drift (e.g. the manifest declares a new field a future stop-hook
  // emits) without re-implementing the empty-check inline.
  const cf = isContentFree(event, "chat-claude-code");
  if (cf && cf.drop) {
    return { decision: "DROP", reason: "content_free" };
  }

  // Rule 3 — F-NEW-W2-CHAT-CC-CROSS-SOURCE-DEDUP. Cross-source dedup vs
  // codex-cli ledger. When the operator runs BOTH stop-hook (this source)
  // AND a codex-cli session in the same cwd, the same turn often lands
  // twice. The codex-cli copy is canonical (richer metadata); we drop the
  // chat-claude-code copy via quarantine so it stays restorable for 30d.
  //
  // Key shape: (cwd, content_sha256[:12]). Time window: +/-10min wall-clock.
  // The +/-10min absorbs clock skew and pairing latency between hooks; the
  // (cwd, sha12) compound key prevents legitimate dual-tool runs in
  // unrelated repos from colliding by sha alone.
  //
  // F-NEW-W3-CHAT-CC-CODEX-CWD-KEY-ASYMMETRY: codex-cli now stamps
  // raw_content.cwd at emit time (matching connector update), so the
  // (real-cwd, sha12) key on this side will collide with a codex row that
  // landed in the same operator cwd. For LEGACY codex rows already on disk
  // that pre-date the W3 stamp (and thus bucket under "*"), we ALSO probe
  // the secondary `(*, sha12)` key as a fail-open fallback. The legacy-
  // bucket probe ONLY fires after the real-cwd probe misses, so a true
  // cross-cwd false positive only happens when the SAME sha12 appears in
  // both legacy-codex and a different chat-cc cwd within +/-10min — which
  // is statistically negligible. Quarantine keeps any false drop
  // recoverable for 30d.
  //
  // Defensive: when event.ts is absent / unparseable, we cannot apply the
  // time window so we skip the rule (PASS-through) — better to keep a
  // duplicate than drop the wrong row.
  const cwd =
    typeof rc.cwd === "string" && rc.cwd.length > 0 ? rc.cwd : "*";
  const evtTsMs = typeof event.ts === "string" ? Date.parse(event.ts) : NaN;
  if (Number.isFinite(evtTsMs)) {
    const sha12 = _sha12(userText, assistantText);
    const primaryKey = `${cwd}\x00${sha12}`;
    const wildcardKey = `*\x00${sha12}`;
    const idx = _getCodexDedupIndex();
    // F-NEW-W3: probe both the (real-cwd, sha12) key and the legacy
    // (*, sha12) bucket so codex rows written before the W3 cwd-stamp
    // landed still participate in the dedup contract.
    const stampSets = [idx.byKey.get(primaryKey)];
    if (cwd !== "*") {
      const legacyStamps = idx.byKey.get(wildcardKey);
      if (legacyStamps && legacyStamps.length > 0) {
        stampSets.push(legacyStamps);
      }
    }
    let withinWindow = false;
    for (const stamps of stampSets) {
      if (!stamps || stamps.length === 0) continue;
      for (const stamp of stamps) {
        if (Math.abs(stamp - evtTsMs) <= CODEX_DEDUP_WINDOW_MS) {
          withinWindow = true;
          break;
        }
      }
      if (withinWindow) break;
    }
    if (withinWindow) {
      try {
        quarantineRow(_shapeForQuarantine(event), "chat_cc_codex_dedup", {
          rule_id: "F-NEW-W2-CHAT-CC-CROSS-SOURCE-DEDUP/codex_dup",
          source: "chat-claude-code",
        });
      } catch {
        /* hot path must not crash on quarantine failure */
      }
      return { decision: "DROP", reason: "chat_cc_codex_dedup" };
    }
  }

  // PASS + structural-score hint.
  // F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION: cliff on joined
  // user+assistant length routed through the central helper.
  const structural_score = computeStructuralScore(
    { _joined: userText + assistantText },
    "chat-claude-code",
    {
      contentFields: ["_joined"],
      shortReplyThreshold: SUBJECT_ONLY_CHAR_THRESHOLD,
      lowerBand: "subject_only",
    }
  );
  return {
    decision: "PASS",
    reason: null,
    structural_score,
  };
}

export function structuralRules() {
  return { ...(CAPS.SALIENCE_STRUCTURAL_RULES?.["chat-claude-code"] || {}) };
}

// Test-only exports. Surfaces the subject-only threshold so unit tests can
// assert the PASS-band boundary without hardcoding the constant. The
// F-NEW-W2-CHAT-CC-CROSS-SOURCE-DEDUP additions surface the window +
// cache TTL + sha12 helper so tests can synth a codex-cli row and assert
// the cross-source DROP fires (or correctly does not fire) within the
// +/-10min boundary.
export const _internals = {
  SUBJECT_ONLY_CHAR_THRESHOLD,
  CODEX_LEDGER_CACHE_TTL_MS,
  CODEX_DEDUP_WINDOW_MS,
  CODEX_TAIL_MAX_BYTES,
  CODEX_DEDUP_CACHE_MAX_ENTRIES,
  _sha12,
};
