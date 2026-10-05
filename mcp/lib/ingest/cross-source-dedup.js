// Stage-1 cross-source dedup layer (F-CROSS-CROSS-SOURCE-DEDUP / R50).
//
// Layer 1.5 of the R25 salience cascade. Runs AFTER per-source Stage-0
// (mcp/lib/ingest/stage0/*.js) and BEFORE the salience scorer commits a
// row to memory.jsonl. Generic entry point checkCrossSourceDuplicate(row,
// source) consults a small, declarative table of contracts that describe
// "row X in source A is the same operator-attention event as row Y in
// source B" and queries the *other* source's ledger to confirm/refute.
//
// Architectural contract:
//   - This module owns the cross-source lookup substrate. The per-source
//     Stage-0 modules (chat-claude-code, screentime, github-events) own
//     the DROP decision; they import this module and call the entry point
//     to decide whether the substrate has corroborating evidence in the
//     other source. The per-source Stage-0 stays "pure" with respect to
//     its own ledger; this module is the ONLY place that cross-reads
//     other source ledgers from inside the cascade.
//   - Each contract is declarative: (source_a, source_b, key_extractor_a,
//     key_extractor_b, window_ms, reason). Adding a new contract is a
//     one-entry change; CRITIC INVARIANTS (caching, bounded memory, fail-
//     open) are enforced uniformly by the entry point.
//
// Contracts shipped in v1:
//   A. chat-claude-code <-> codex-cli
//        key = (conversation_id, content_sha256)
//        window = +/-60s
//        reason on dup = "cross_source_dup_chat_cc_codex"
//      Note: the chat-claude-code Stage-0 module already ships a tighter,
//      sha12-based DROP via its own internal index. This generic contract
//      is the substrate version that uses the canonical content_sha256
//      (full hex) carried by the row envelope where available. The two
//      paths are complementary; the in-module path stays as the wave-2
//      activation, the substrate path becomes the canonical reuse target
//      for future agent-runtime sources.
//   B. screentime INSendMessageIntent <-> imessage
//        key = (canonicalized_handle, ts) with +/-5min window
//        reason on dup = "cross_source_dup_screentime_imessage"
//   C. github-events PushEvent <-> git-log
//        key = (canonical_repo_basename, head_sha)
//        window = unbounded (same SHA across sources is always the same
//                 commit; ts agreement is not required)
//        reason on dup = "cross_source_dup_gh_gitlog"
//   D. whatsapp <-> imessage  (F-NEW-W4-WHATSAPP-F9-XSRC-DEDUP-CONTRACT)
//        key = (canonicalized_peer_phone, normalised_text) with +/-5min window
//        reason on dup = "whatsapp_cross_source_duplicate"
//        Scope: 1:1 chats only (ZSESSIONTYPE=0 on the whatsapp side). Group
//        chats are excluded — the iMessage ledger keys on handle_id which
//        is a single peer, not a group room, so a positive match across
//        group chats would be meaningless. Peer phone is extracted from
//        the whatsapp peer JID's local-part (the prefix before "@") and
//        normalized via canonicalizeHandle. Text is normalised (collapsed
//        whitespace, trimmed) so formatting drift between WhatsApp and
//        iMessage clients doesn't defeat equality. Window is +/-5min,
//        same as Contract B (screentime <-> imessage): operators often
//        retype the same prose into a second client within minutes when
//        the first client lacks read-receipt confirmation. Short-text
//        defang (>=25 normalised chars) is enforced ON THE STAGE-0 SIDE
//        before the consume rule fires, mirroring slack F6 — the
//        substrate itself does NOT gate on length so other callers can
//        choose their own threshold.
//
// CRITIC INVARIANTS (every contract obeys):
//   - Caching: cache lookups by (other_source, contract_key) with 5-min
//     TTL. Cache hits never re-scan the ledger.
//   - Bounded memory: cache cap = 10_000 entries, LRU eviction (Map
//     insertion-order suffices for a small LRU).
//   - Fail-open: ANY error (file missing, parse error, key extractor
//     throws) returns {is_dup: false} and emits a one-shot stderr warning
//     so the operator notices but the dispatch is never blocked.
//   - Telemetry: the per-contract dup reasons live in REASON_ALLOWLIST
//     (mcp/lib/ingest/stage0/telemetry.js). The substrate itself does
//     NOT call recordDrop — the per-source Stage-0 module is the canonical
//     point of decision and counter increment.
//
// Module surface:
//   - checkCrossSourceDuplicate(row, source) -> {is_dup, paired_source?,
//       paired_id?, contract?, reason?}
//   - CROSS_SOURCE_CONTRACTS (frozen constant) — readable from tests and
//     ops tooling.
//   - canonicalizeHandle(handle, source) — E.164-style normalization
//   - canonicalizeRepoBasename(slug) — strip .git/-server/-client/-cli/-mcp
//   - withinWindow(ts_a, ts_b, window_ms) — bool helper
//   - lookupOtherSourceLedger(other_source, key_predicate) — cached, LRU-
//     bounded ledger tail scan
//   - _resetCachesForTest() — test-only cache reset

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { STORAGE_DIR } from "../config.js";

// ---------------------------------------------------------------------------
// Cache + memory discipline.
// ---------------------------------------------------------------------------
const LOOKUP_CACHE_TTL_MS = 5 * 60 * 1000;
const LOOKUP_CACHE_MAX_ENTRIES = 10_000;
// Tail-only read budget for the per-source ledger scan. 4 MiB covers a
// normal working-day ledger (~1k rows); larger ledgers surface only the
// trailing window, which is correct for the time-windowed contracts (older
// rows time out of the window) and acceptable for SHA-only contracts (a
// missed dup in the cold tail is recoverable via the quarantine restore
// path and is far better than blocking dispatch).
const LEDGER_TAIL_MAX_BYTES = 4 * 1024 * 1024;

// LRU cache: Map preserves insertion order, so on hit we delete+re-set to
// move the entry to the end; on overflow we delete the oldest (first) entry.
// Each entry: { value, builtAt }
const _lookupCache = new Map();

function _cacheGet(key) {
  const entry = _lookupCache.get(key);
  if (entry === undefined) return undefined;
  if (Date.now() - entry.builtAt > LOOKUP_CACHE_TTL_MS) {
    _lookupCache.delete(key);
    return undefined;
  }
  // LRU bump: re-insert at the end.
  _lookupCache.delete(key);
  _lookupCache.set(key, entry);
  return entry.value;
}

function _cacheSet(key, value) {
  if (_lookupCache.has(key)) {
    _lookupCache.delete(key);
  } else if (_lookupCache.size >= LOOKUP_CACHE_MAX_ENTRIES) {
    // Evict the oldest entry.
    const oldest = _lookupCache.keys().next().value;
    if (oldest !== undefined) _lookupCache.delete(oldest);
  }
  _lookupCache.set(key, { value, builtAt: Date.now() });
}

// One-shot stderr warnings so a recurrent ledger-missing situation does
// not flood logs.
const _warnedKeys = new Set();
function _warnOnce(key, msg) {
  if (_warnedKeys.has(key)) return;
  _warnedKeys.add(key);
  try {
    // eslint-disable-next-line no-console
    console.warn(`[cross-source-dedup] ${msg}`);
  } catch {
    /* never crash the hot path */
  }
}

// ---------------------------------------------------------------------------
// Helpers — exported so per-source modules and tests can reuse them.
// ---------------------------------------------------------------------------

// canonicalizeHandle — collapses operator phone / handle strings into a
// stable comparison key. Strategy:
//   - lowercase + trim
//   - percent-decode (so a URL-encoded handle "%2B15555550123" canonicalizes
//     to the same key as the E.164 form "+15555550123"); decode is wrapped
//     in try/catch so a malformed encoding never throws on the hot path
//     and falls back to the raw string
//   - if the string contains only digits + leading "+", strip the "+"
//     (E.164 -> bare digit form)
//   - if the string is purely digits after stripping non-digits AND its
//     length is >= 7 (plausible phone), return the digits
//   - otherwise return the lowercased/trimmed value (email, group handle,
//     etc.); the contract caller decides whether email-shape comparisons
//     are valid.
// `source` is currently informational (some sources may want different
// normalization later); we accept it now so the call site is stable.
//
// F-NEW-W4-CROSS-SOURCE-DEDUP-PCT-DECODE — without the decode pre-pass,
// "%2B15555550123".replace(/[^\d]/g, "") yields "215555550123" (12 digits;
// the "2" from "%2B"), so the key never matches the iMessage "+15555550123"
// form which canonicalizes to "15555550123" (11 digits). decodeURIComponent
// strips the "%2B" → "+" before digit extraction, restoring parity.
export function canonicalizeHandle(handle, _source) {
  if (typeof handle !== "string") return "";
  let s = handle.trim().toLowerCase();
  if (s.length === 0) return "";
  // Percent-decode pre-pass. Wrapped in try/catch because
  // decodeURIComponent throws URIError on stray '%' that isn't part of a
  // valid escape sequence (e.g. "50% off"). On error, fall back to the
  // already-trimmed/lowercased string so the rest of the heuristic still
  // runs.
  try {
    s = decodeURIComponent(s);
  } catch {
    /* malformed percent-encoding; keep the un-decoded form */
  }
  // Strip whitespace inside (parentheses, dashes, dots in phones).
  // We do this on a digit-detection copy; we keep the original string for
  // non-phone fallbacks.
  const digitsOnly = s.replace(/[^\d]/g, "");
  // Heuristic: if the original starts with "+" OR digits dominate AND we
  // have >=7 digits, treat as phone.
  const phoneLikely = s.startsWith("+") || (digitsOnly.length >= 7 && digitsOnly.length / s.length > 0.6);
  if (phoneLikely && digitsOnly.length >= 7) {
    return digitsOnly;
  }
  return s;
}

// canonicalizeRepoBasename — strip .git/-server/-client/-cli/-mcp; lowercase.
// Mirrors the implementation in stage0/githubevents.js per the spec; this
// substrate is the canonical home and the github-events module already
// imports its own copy (kept in sync with this regex).
const REPO_BASENAME_SUFFIX_REGEX = /(?:\.git|-server|-client|-cli|-mcp)$/i;
export function canonicalizeRepoBasename(name) {
  if (typeof name !== "string" || name.length === 0) return "";
  let s = name.toLowerCase();
  // Allow nested suffixes (`foo-mcp-server` -> `foo-mcp` -> `foo`).
  for (let i = 0; i < 4; i++) {
    const next = s.replace(REPO_BASENAME_SUFFIX_REGEX, "");
    if (next === s) break;
    s = next;
  }
  // Also accept owner/repo slugs — keep only the basename half.
  const slashIdx = s.lastIndexOf("/");
  if (slashIdx >= 0) s = s.slice(slashIdx + 1);
  return s;
}

// withinWindow — both arguments are epoch-ms (numbers) OR ISO strings.
// Returns false if either is missing / unparseable (fail-closed on the
// window check itself so an undated row never claims to be inside any
// window).
export function withinWindow(ts_a, ts_b, window_ms) {
  const a = typeof ts_a === "number" ? ts_a : Date.parse(ts_a);
  const b = typeof ts_b === "number" ? ts_b : Date.parse(ts_b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (!Number.isFinite(window_ms) || window_ms < 0) return false;
  return Math.abs(a - b) <= window_ms;
}

// ---------------------------------------------------------------------------
// lookupOtherSourceLedger — cached, LRU-bounded tail-scan of a source
// ledger. The caller supplies a contract key (used as the cache key) AND
// a key_predicate function that returns the per-row extracted key (or null
// when the row is not relevant). The scan returns an array of
// { key, ts, raw_content } shapes; the caller filters by window / key
// equality.
//
// Cache strategy:
//   - Cache key: `${other_source}::${contract_key}`. Two different
//     contracts against the same source get distinct cache entries.
//   - Cache value: array of {key, ts, raw_content} extracted by the
//     predicate. Cache TTL = 5min.
// ---------------------------------------------------------------------------
function _ledgerPath(source) {
  if (typeof source !== "string" || source.length === 0) return "";
  return join(STORAGE_DIR, "sources", `${source}.jsonl`);
}

export function lookupOtherSourceLedger(other_source, contract_key, key_predicate) {
  const cacheKey = `${other_source}::${contract_key}`;
  const cached = _cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const path = _ledgerPath(other_source);
  if (!path || !existsSync(path)) {
    _cacheSet(cacheKey, []);
    return [];
  }
  let raw;
  try {
    const buf = readFileSync(path);
    if (buf.length === 0) {
      _cacheSet(cacheKey, []);
      return [];
    }
    const start = Math.max(0, buf.length - LEDGER_TAIL_MAX_BYTES);
    raw = buf.slice(start).toString("utf8");
    if (start > 0) {
      // Drop the leading partial line — we sliced mid-record.
      const idx = raw.indexOf("\n");
      raw = idx >= 0 ? raw.slice(idx + 1) : "";
    }
  } catch (err) {
    _warnOnce(
      `read::${other_source}`,
      `failed to read ${other_source} ledger at ${path}: ${err && err.message}`
    );
    _cacheSet(cacheKey, []);
    return [];
  }
  if (raw === "") {
    _cacheSet(cacheKey, []);
    return [];
  }

  const out = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    if (line === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    let extracted;
    try {
      extracted = key_predicate(parsed);
    } catch {
      continue;
    }
    if (!extracted) continue;
    out.push(extracted);
  }
  _cacheSet(cacheKey, out);
  return out;
}

// ---------------------------------------------------------------------------
// Contract definitions.
// ---------------------------------------------------------------------------
//
// Shape:
//   {
//     id: string,                       — stable identifier for telemetry / logs
//     source_a: string,                 — the source being CHECKED
//     source_b: string,                 — the OTHER source we look up
//     reason: string,                   — telemetry reason (must be in REASON_ALLOWLIST)
//     window_ms: number,                — +/- window for ts pairing. 0/undefined ⇒
//                                          no window check (key-only contract,
//                                          e.g. SHA equality)
//     extract_a: (row) -> {key, ts}|null  — key extractor on source_a side
//     extract_b: (row) -> {key, ts}|null  — key extractor on source_b side
//   }
//
// The substrate is keyed source_a -> source_b: the per-source Stage-0 on
// source_a is the caller, and the lookup runs against source_b's ledger.
//
// We export the table as a frozen constant for test introspection.
// ---------------------------------------------------------------------------

// Contract A — chat-claude-code <-> codex-cli
// Key: (conversation_id, content_sha256). 60s pairing window.
function _extractChatCc(row) {
  if (!row || typeof row !== "object") return null;
  const rc = row.raw_content;
  if (!rc || typeof rc !== "object") return null;
  const convId =
    typeof rc.conversation_id === "string" && rc.conversation_id.length > 0
      ? rc.conversation_id
      : "";
  const sha =
    typeof rc.content_sha256 === "string" && rc.content_sha256.length > 0
      ? rc.content_sha256
      : "";
  if (!convId || !sha) return null;
  const tsRaw = typeof row.ts === "string" ? row.ts : "";
  const tsMs = tsRaw ? Date.parse(tsRaw) : NaN;
  return { key: `${convId}\x00${sha}`, ts: tsMs, raw_content: rc };
}

const CONTRACT_CHAT_CC_CODEX = Object.freeze({
  id: "chat-cc-codex",
  source_a: "chat-claude-code",
  source_b: "codex-cli",
  reason: "cross_source_dup_chat_cc_codex",
  window_ms: 60 * 1000,
  extract_a: _extractChatCc,
  extract_b: _extractChatCc,
});

// Contract B — screentime INSendMessageIntent <-> imessage
// Key: canonicalized handle. 5min pairing window.
// screentime side: only fires on /app/intents rows with
//   intent_class == 'INSendMessageIntent'. Handle comes from the related-
//   contact-ids string (best effort) or the derived intent id; if no
//   handle is available, the row is not a candidate.
// imessage side: handle_id, ts.
function _extractScreentimeSendMessage(row) {
  if (!row || typeof row !== "object") return null;
  const rc = row.raw_content;
  if (!rc || typeof rc !== "object") return null;
  if (rc.stream !== "/app/intents") return null;
  const intentClass =
    typeof rc.intent_class === "string" ? rc.intent_class : "";
  if (intentClass !== "INSendMessageIntent") return null;
  // Best-effort handle extraction. The screentime intent payload puts the
  // recipient in related_contact_ids; if absent, fall back to
  // interaction_id (low precision, but better than nothing for the
  // window-filter step).
  const handleRaw =
    (typeof rc.related_contact_ids === "string" && rc.related_contact_ids) ||
    (typeof rc.interaction_id === "string" && rc.interaction_id) ||
    "";
  const handle = canonicalizeHandle(handleRaw, "screentime");
  if (!handle) return null;
  const tsRaw = typeof row.ts === "string" ? row.ts : "";
  const tsMs = tsRaw ? Date.parse(tsRaw) : NaN;
  return { key: handle, ts: tsMs, raw_content: rc };
}

function _extractImessage(row) {
  if (!row || typeof row !== "object") return null;
  const rc = row.raw_content;
  if (!rc || typeof rc !== "object") return null;
  const handleRaw =
    typeof rc.handle_id === "string" ? rc.handle_id : "";
  const handle = canonicalizeHandle(handleRaw, "imessage");
  if (!handle) return null;
  const tsRaw = typeof row.ts === "string" ? row.ts : "";
  const tsMs = tsRaw ? Date.parse(tsRaw) : NaN;
  return { key: handle, ts: tsMs, raw_content: rc };
}

const CONTRACT_SCREENTIME_IMESSAGE = Object.freeze({
  id: "screentime-imessage",
  source_a: "screentime",
  source_b: "imessage",
  reason: "cross_source_dup_screentime_imessage",
  window_ms: 5 * 60 * 1000,
  extract_a: _extractScreentimeSendMessage,
  extract_b: _extractImessage,
});

// Contract C — github-events PushEvent <-> git-log
// Key: (canonical_repo_basename, head_sha). No window — same SHA across
// sources is always the same commit. We DO retain the ts on the extracted
// shape so future ops queries can correlate, but the dup check is key-only.
function _extractGithubPushEvent(row) {
  if (!row || typeof row !== "object") return null;
  const rc = row.raw_content;
  if (!rc || typeof rc !== "object") return null;
  const evtType =
    (typeof rc.event_type === "string" && rc.event_type) ||
    (typeof rc.type === "string" && rc.type) ||
    "";
  if (evtType !== "PushEvent") return null;
  const sha = typeof rc.head === "string" && rc.head.length > 0 ? rc.head : "";
  if (!sha) return null;
  const slug = typeof rc.repo === "string" ? rc.repo : "";
  const basename = canonicalizeRepoBasename(slug);
  if (!basename) return null;
  const tsRaw =
    (typeof rc.created_at === "string" && rc.created_at) ||
    (typeof row.ts === "string" && row.ts) ||
    "";
  const tsMs = tsRaw ? Date.parse(tsRaw) : NaN;
  return { key: `${basename}\x00${sha}`, ts: tsMs, raw_content: rc };
}

function _extractGitlog(row) {
  if (!row || typeof row !== "object") return null;
  const rc = row.raw_content;
  if (!rc || typeof rc !== "object") return null;
  const sha =
    typeof rc.commit_hash === "string" && rc.commit_hash.length > 0
      ? rc.commit_hash
      : "";
  if (!sha) return null;
  // git-log uses repo_path (absolute fs path); pull the basename.
  const repoPath = typeof rc.repo_path === "string" ? rc.repo_path : "";
  const lastSlash = repoPath.lastIndexOf("/");
  const rawBasename = lastSlash >= 0 ? repoPath.slice(lastSlash + 1) : repoPath;
  const basename = canonicalizeRepoBasename(rawBasename);
  if (!basename) return null;
  const tsRaw = typeof row.ts === "string" ? row.ts : "";
  const tsMs = tsRaw ? Date.parse(tsRaw) : NaN;
  return { key: `${basename}\x00${sha}`, ts: tsMs, raw_content: rc };
}

const CONTRACT_GH_GITLOG = Object.freeze({
  id: "gh-gitlog",
  source_a: "github-events",
  source_b: "git-log",
  reason: "cross_source_dup_gh_gitlog",
  window_ms: 0, // SHA equality is sufficient
  extract_a: _extractGithubPushEvent,
  extract_b: _extractGitlog,
});

// Contract D — whatsapp <-> imessage
// (F-NEW-W4-WHATSAPP-F9-XSRC-DEDUP-CONTRACT)
//
// Key: (canonicalized_peer_phone, normalised_text). +/-5min pairing window.
//
// Scope gate (whatsapp side): 1:1 chats only — ZSESSIONTYPE=0 on the
// whatsapp raw_content. Group / broadcast rows return null from extract_a
// so the substrate scan never even reaches the imessage ledger.
//
// Peer extraction: WhatsApp JIDs look like "15551234567@s.whatsapp.net".
// For 1:1 chats the peer is whichever side ISN'T the operator:
//   - is_from_me=1 → peer = to_jid
//   - is_from_me=0 → peer = from_jid
// session_jid is the fallback if either is_from_me-derived side is null
// (some older WhatsApp ChatStorage rows omit one of from_jid/to_jid for
// outbound history). The JID's local-part (prefix before "@") is fed
// through canonicalizeHandle which collapses to bare-digit phone form
// (E.164 without the leading "+"), matching iMessage's handle_id
// canonicalization in _extractImessage.
//
// Text normalisation: collapse runs of whitespace + trim. The contract
// does NOT enforce a minimum text length — that defang lives on the
// Stage-0 caller side (whatsapp.js: CROSS_SOURCE_DUP_MIN_TEXT_CHARS=25)
// so per-source policy can tighten or loosen independently.
function _normaliseTextForXsrc(s) {
  if (typeof s !== "string") return "";
  return s.replace(/\s+/g, " ").trim();
}

function _jidLocalPart(jid) {
  if (typeof jid !== "string" || jid.length === 0) return "";
  const at = jid.indexOf("@");
  return at >= 0 ? jid.slice(0, at) : jid;
}

function _extractWhatsappOneOnOne(row) {
  if (!row || typeof row !== "object") return null;
  const rc = row.raw_content;
  if (!rc || typeof rc !== "object") return null;
  // Scope gate: 1:1 chats only. session_type=0 per the whatsapp connector
  // raw-row shape (ZWACHATSESSION.ZSESSIONTYPE).
  if (rc.session_type !== 0) return null;
  const text = _normaliseTextForXsrc(rc.text);
  if (text.length === 0) return null;
  const isFromMe = rc.is_from_me === 1 || rc.is_from_me === true;
  let peerJid = "";
  if (isFromMe) {
    peerJid = typeof rc.to_jid === "string" ? rc.to_jid : "";
  } else {
    peerJid = typeof rc.from_jid === "string" ? rc.from_jid : "";
  }
  if (!peerJid) {
    // Fallback: session_jid (the chat's peer JID for 1:1 sessions).
    peerJid = typeof rc.session_jid === "string" ? rc.session_jid : "";
  }
  const localPart = _jidLocalPart(peerJid);
  const peer = canonicalizeHandle(localPart, "whatsapp");
  if (!peer) return null;
  const tsRaw = typeof row.ts === "string" ? row.ts : "";
  const tsMs = tsRaw ? Date.parse(tsRaw) : NaN;
  return { key: `${peer}\x00${text}`, ts: tsMs, raw_content: rc };
}

function _extractImessageForWhatsapp(row) {
  if (!row || typeof row !== "object") return null;
  const rc = row.raw_content;
  if (!rc || typeof rc !== "object") return null;
  // Mirror the whatsapp side's text normalisation. iMessage stamps text
  // under raw_content.text (post-attributedBody decode); when text is
  // null/empty (decode error, media-only, redacted) the row is not a
  // candidate.
  const text = _normaliseTextForXsrc(rc.text);
  if (text.length === 0) return null;
  // Peer canonicalization. handle_id is the iMessage source-native peer
  // identifier (e.g. "+15551234567" or "user@example.com"); we route it
  // through canonicalizeHandle which yields the bare-digit phone form
  // for phone-shaped handles.
  const handleRaw = typeof rc.handle_id === "string" ? rc.handle_id : "";
  const peer = canonicalizeHandle(handleRaw, "imessage");
  if (!peer) return null;
  const tsRaw = typeof row.ts === "string" ? row.ts : "";
  const tsMs = tsRaw ? Date.parse(tsRaw) : NaN;
  return { key: `${peer}\x00${text}`, ts: tsMs, raw_content: rc };
}

const CONTRACT_WHATSAPP_IMESSAGE = Object.freeze({
  id: "whatsapp-imessage",
  source_a: "whatsapp",
  source_b: "imessage",
  reason: "whatsapp_cross_source_duplicate",
  window_ms: 5 * 60 * 1000,
  extract_a: _extractWhatsappOneOnOne,
  extract_b: _extractImessageForWhatsapp,
});

// Contract E — git-log <-> git-log (SAME-SOURCE content-hash dedup).
// WU-A3-git-log-content-dedup.
//
// Problem: OpenWrt feeds and other vendored-mirror corpora produce many
// commits whose (repo_path, commit_hash) tuples are distinct (so
// source_msg_id is unique per-repo) but whose CONTENT (subject + body) is
// byte-identical across repos. Empirically 64,851 / 80,128 (~81 %) of the
// git-log queue is such cross-repo content duplication, with single-string
// peaks of 223 ("mt76: update to the latest version"). Embedding each
// duplicate before discovering the collision at the kNN layer wastes
// Gemini quota and pollutes the recall index with near-anchor neighbours
// for the same commit message.
//
// Key: sha256(normalised_content). Normalisation = subject + "\n" + body,
// trimmed, with runs of whitespace collapsed. Empty content (no subject
// AND no body) is NOT a candidate — the row carries no signal and falls
// through to the standard Stage-0 path.
//
// Scope: SAME-source (source_a === source_b === "git-log"). The substrate
// treats this like any other contract — the source_b ledger scan reads
// git-log.jsonl itself. Self-collision is mathematically impossible at
// gate time because the row being checked has NOT yet been appended to
// the ledger (Stage-0 fires BEFORE the watermark daemon advances). The
// defensive self-filter on source_msg_id (skip a candidate whose
// source_msg_id equals the candidate-row's source_msg_id) covers replay
// / re-presentation paths where a row may be re-seen post-append (e.g.
// crash recovery, manual backfill).
//
// Window: 0 (no time bound). Content equality across an arbitrary time
// span is the same fact; OpenWrt feed merges may surface the same commit
// weeks apart across upstream + downstream + vendor mirrors.
//
// Reason on dup = "git_log_content_dup_corroborate". Surfaced as a DROP
// at the per-source Stage-0 (see lib/ingest/stage0/gitlog.js Rule 5).
// The "corroborate" suffix in the reason marks the operator intent: the
// second-and-later identical-content rows are evidence corroborating the
// first row's fact, NOT new facts in their own right. Downstream
// corroboration-count projections (lib/synthesis/episodicity-scorer.js
// reads features.corroboration_count) consume the DROP via the
// policy.corroboration ledger; that wiring lives at the Stage-0 caller
// site (gitlog.js) so the substrate stays a pure detector.
function _normaliseGitlogContent(rc) {
  const subject = typeof rc.subject === "string" ? rc.subject : "";
  const body = typeof rc.body === "string" ? rc.body : "";
  const joined = `${subject}\n${body}`;
  // Collapse whitespace runs and trim. Mirrors _normaliseTextForXsrc but
  // we keep a single newline between subject and body so that two rows
  // whose body happens to begin with the subject text don't collapse
  // into the same hash as a single-line variant.
  return joined.replace(/[ \t]+/g, " ").replace(/\n+/g, "\n").trim();
}

function _extractGitlogContentHash(row) {
  if (!row || typeof row !== "object") return null;
  const rc = row.raw_content;
  if (!rc || typeof rc !== "object") return null;
  const normalised = _normaliseGitlogContent(rc);
  if (normalised.length === 0) return null;
  const hash = createHash("sha256").update(normalised).digest("hex");
  const tsRaw = typeof row.ts === "string" ? row.ts : "";
  const tsMs = tsRaw ? Date.parse(tsRaw) : NaN;
  const sourceMsgId =
    typeof row.source_msg_id === "string" ? row.source_msg_id : "";
  return {
    key: hash,
    ts: tsMs,
    raw_content: rc,
    source_msg_id: sourceMsgId,
  };
}

const CONTRACT_GITLOG_CONTENT_DEDUP = Object.freeze({
  id: "gitlog-content-dedup",
  source_a: "git-log",
  source_b: "git-log",
  reason: "git_log_content_dup_corroborate",
  window_ms: 0, // content equality is time-independent
  extract_a: _extractGitlogContentHash,
  extract_b: _extractGitlogContentHash,
  // Same-source contracts MUST filter out self-matches; the substrate
  // honors this flag in checkCrossSourceDuplicate by skipping any
  // candidate whose source_msg_id equals the extracted row's
  // source_msg_id. Cross-source contracts default to false (the
  // source_msg_id namespaces are disjoint so a collision is mathematically
  // impossible).
  self_match_filter: true,
});

export const CROSS_SOURCE_CONTRACTS = Object.freeze([
  CONTRACT_CHAT_CC_CODEX,
  CONTRACT_SCREENTIME_IMESSAGE,
  CONTRACT_GH_GITLOG,
  CONTRACT_WHATSAPP_IMESSAGE,
  CONTRACT_GITLOG_CONTENT_DEDUP,
]);

// ---------------------------------------------------------------------------
// checkCrossSourceDuplicate — generic entry point.
// ---------------------------------------------------------------------------
//
// Walks every contract whose source_a matches the caller's source. For each
// matching contract:
//   1. Run extract_a(row) — bail if no key.
//   2. Resolve the cached extraction over the source_b ledger via
//      lookupOtherSourceLedger.
//   3. For each candidate in the cache, check key equality. If
//      window_ms > 0, additionally check withinWindow(ts_a, ts_b, window).
//   4. First hit returns is_dup=true with the contract metadata.
//
// Fail-open: any thrown error returns {is_dup: false}.
//
// Return shape (success):
//   {is_dup: true, paired_source: <other_source>, paired_id: <key>,
//    contract: <contract_id>, reason: <reason>}
//   {is_dup: false}
// ---------------------------------------------------------------------------
export function checkCrossSourceDuplicate(row, source) {
  try {
    if (!row || typeof row !== "object") return { is_dup: false };
    if (typeof source !== "string" || source.length === 0) {
      return { is_dup: false };
    }
    for (const contract of CROSS_SOURCE_CONTRACTS) {
      if (contract.source_a !== source) continue;
      let extracted;
      try {
        extracted = contract.extract_a(row);
      } catch {
        continue;
      }
      if (!extracted) continue;
      const candidates = lookupOtherSourceLedger(
        contract.source_b,
        contract.id,
        contract.extract_b
      );
      if (!candidates || candidates.length === 0) continue;
      // Same-source dedup contracts (source_a === source_b, e.g. the
      // gitlog-content-dedup contract) MUST filter self-matches: the
      // ledger scan can re-surface the row being checked itself when the
      // watermark daemon replays a row post-append. The contract opts in
      // via self_match_filter=true; the substrate uses source_msg_id as
      // the identity key (extract_a / extract_b populate it on the
      // returned shape).
      const selfFilter = contract.self_match_filter === true;
      const extractedSelfId =
        selfFilter && typeof extracted.source_msg_id === "string"
          ? extracted.source_msg_id
          : "";
      for (const cand of candidates) {
        if (cand.key !== extracted.key) continue;
        if (
          selfFilter &&
          extractedSelfId.length > 0 &&
          typeof cand.source_msg_id === "string" &&
          cand.source_msg_id === extractedSelfId
        ) {
          // The row matched itself — skip and keep scanning. If this is
          // the only candidate with the matching key, the contract returns
          // is_dup=false (no DROP) and the row PASSes Stage-0 as the
          // first-seen anchor for its content hash.
          continue;
        }
        if (contract.window_ms > 0) {
          if (!withinWindow(extracted.ts, cand.ts, contract.window_ms)) {
            continue;
          }
        }
        return {
          is_dup: true,
          paired_source: contract.source_b,
          paired_id:
            typeof cand.source_msg_id === "string" && cand.source_msg_id.length > 0
              ? cand.source_msg_id
              : cand.key,
          contract: contract.id,
          reason: contract.reason,
        };
      }
    }
    return { is_dup: false };
  } catch (err) {
    _warnOnce(
      `check::${source}`,
      `checkCrossSourceDuplicate threw for source=${source}: ${err && err.message}`
    );
    return { is_dup: false };
  }
}

// ---------------------------------------------------------------------------
// Test-only surfaces. Mirrors the F-T2-GITHUB_EVENTS-F8 / chat-cc internal
// helpers so tests can exercise the substrate without touching real
// ledgers.
// ---------------------------------------------------------------------------
export function _resetCachesForTest() {
  _lookupCache.clear();
  _warnedKeys.clear();
}

export function _seedLookupCacheForTest(other_source, contract_key, entries) {
  const key = `${other_source}::${contract_key}`;
  _cacheSet(key, Array.isArray(entries) ? entries.slice() : []);
}

export const _internals = {
  LOOKUP_CACHE_TTL_MS,
  LOOKUP_CACHE_MAX_ENTRIES,
  LEDGER_TAIL_MAX_BYTES,
};
