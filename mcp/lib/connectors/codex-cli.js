// codex-cli.js — R28 Phase 2a agent-runtime connector for the Codex CLI.
//
// Tails per-session rollout JSONL files written by the Codex CLI under
//   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<uuid>.jsonl
// pairs adjacent user/assistant `response_item` rows into turns, and emits
// one source-ledger row per paired turn. Pure file-tail; zero new deps, no
// auth secret, no TCC grant (path is under $HOME — no FDA required).
//
// Authoritative specs:
//   - reviews/r28/spec.md § Discovery results → codex-cli (file shape, row
//     discriminator, pairing rules).
//   - kb/connectors-survey.md § Top-5 connector skeletons + the agent-runtime
//     addendum: operator is the human party in operator-run CLIs/SDKs, so
//     consent_basis defaults to first_party.
//   - kb/ingestion.md § Connector contract (the six obligations the
//     ConnectorBase satisfies; this module supplies the per-source classifier
//     closure and the per-source polling logic).
//
// Cursor shape (per kb/ingestion.md § Connector contract → CURSOR + the R28
// per-session-turn-index extension):
//
//   {
//     // Per-session cursor map: session_uuid -> last appended turn_index.
//     // Primary dedup signal; survives file rotation, byte-offset drift,
//     // and even cursor-file restoration from a stale backup (the base
//     // class's source_msg_id tail-read kicks in as backstop).
//     per_session_cursors: { "<session_uuid>": <last_turn_index_int>, ... },
//
//     // Fast-path read offset per session file so we don't re-scan from
//     // byte 0 every tick. Advisory only — turn-index dedup is authoritative.
//     per_session_offsets: { "<session_file_basename>": <bytes_consumed>, ... },
//
//     // F-NEW-R41-CODEX-PARSE-LOOP — per-file content-version record. Keys
//     // the unchanged-file skip (zero reads for fully-ingested files) and
//     // the once-per-content-version parse_error tagging. Advisory only,
//     // like per_session_offsets: deleting it costs one re-walk per file.
//     per_session_file_meta: {
//       "<session_file_basename>": {
//         size: <int>, mtime_ms: <float>,
//         ingest_complete: <bool>, parse_error_tagged: <bool>,
//       }, ...
//     },
//
//     // Base-class contract keys:
//     last_polled_ts: ISO-8601,
//     last_appended_ts: ISO-8601,
//     last_appended_id: ulid,
//     last_cursor_advance_ts: ISO-8601,
//     error_count: int,
//     last_error_kind: string|null,
//   }
//
// Per-session restart-recovery: on each pollOnce, for each discovered
// session file we read from `per_session_offsets[file_basename]` (fast
// path) and validate every yielded turn's index against
// `per_session_cursors[session_uuid]`. Out-of-order, replayed, or
// duplicate rows are dropped at the turn-index check; the
// ConnectorBase.appendLedgerRow source_msg_id tail-read is the final
// backstop.
//
// HERMETICITY: every path is sourced via env-overridable sessionsGlob and
// the ConnectorBase config helpers. Tests build synthetic JSONL fixtures
// under mkdtempSync and override the glob; production ~/.codex/sessions
// is never touched in tests.
//
// KEY_LEAKAGE_ZERO: this module never logs raw content. Per-row tagError
// kinds use enumerated codes only (parse_error, append_error, walk_error);
// no operator dialog ever reaches stderr.

// F-NEW-R40-CODEX-ERR-STRING-TOO-LONG: readFileSync was replaced by the
// fd-based positional primitives (openSync/fstatSync/readSync/closeSync)
// used by _readSessionRows — a whole-file utf8 read throws
// ERR_STRING_TOO_LONG once a rollout file outgrows V8's max string length
// (536,870,888 bytes). See _readSessionRows for the full story.
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, basename, resolve } from "node:path";
import { createHash } from "node:crypto";

import { ConnectorBase } from "./index.js";
import { CAPS } from "../validation.js";
import { serverTs } from "../envelope.js";
// F-NEW-W1-CODEX-TELEMETRY-SINK — the connector MUST call stage0Dispatch
// (the canonical dispatcher in lib/ingest/stage0/index.js) rather than the
// per-source codexCliStage0 directly. Only the dispatcher path invokes the
// persistent telemetry sink (recordDrop → storage/telemetry/stage0_counters_<date>.jsonl).
// Calling codexCliStage0 directly silently bypassed the JSONL counters.
import { stage0Dispatch } from "../ingest/stage0/index.js";

// F-NEW-R42-CONSUMER-MIGRATION / F-NEW-R43-CONNECTOR-WIRING — every
// connector imports the canonical identity + bot-actor predicates so the
// "is this row's author the operator?" and "is this row's author a bot?"
// questions resolve identically across sources. For codex-cli specifically,
// both predicates are defensive: in a normal Codex session the parties are
// fixed ("user", "assistant"), the operator IS the user, and bots do not
// participate. The imports exist so the agent-runtime hook participates in
// the same identity discipline as the rest of the connectors and so any
// forwarded automation / shared-machine session future-proofs through the
// same single source of truth.
import {
  isOperator,
  getOperatorIdentities,
} from "../identity/operator-identity.js";
import { isBotActor, BOT_ACTOR_REGEX } from "../identity/bot-actors.js";

// F-CCS-CONNECTOR-codex-cli-structural — mirror the W2 git-log-structural +
// github-events-structural shape. We reuse `slugify` + the entity-schema
// constants from the canonical entity-extractor substrate so the slug pipeline
// matches byte-identical with the cascade text-extractor path. canonical_id
// formation is inlined (NOT via buildCanonicalId) because the `codex-cli`
// source_scope is intentionally outside ENTITY_SOURCE_SCOPES at v0 — the
// closed enum (entity-extractor.js §4) currently lists
// {imessage, git-log, github-events, screentime, chat-claude-code, manual}.
// buildCanonicalId would throw on "codex-cli"; the cascade's row-parties path
// already silently skips unknown source_scopes (distill-promote-fact.js
// buildPartyEntity §205-208). Emitting structured_features under the
// "codex-cli" scope is forward-compat: when codex-cli joins the enum, every
// historical row already carries the structurally-typed payload.
import {
  slugify as entitySlugify,
  SLUG_EMPTY_SENTINEL,
  ENTITY_SLUG_REGEX,
} from "../synthesis/entity-extractor.js";

// =============================================================================
// Constants
// =============================================================================

// Source identifier. Stamped onto every emitted row; also the basename of
// storage/sources/codex-cli.jsonl and connectors/codex-cli/state.json.
const SOURCE = "codex-cli";

// Default glob pattern resolution. We do NOT depend on a glob library; the
// CAPS string carries a "~/.codex/sessions/*/*/*/rollout-*.jsonl" shape and
// we expand the leading "~/" + the trailing "<YYYY>/<MM>/<DD>/rollout-*.jsonl"
// pattern via a bounded directory walk identical to git-log-local's
// repo-discovery walker. Operator-overridable via CODEX_CLI_SESSIONS_GLOB
// (colon-separated absolute globs).
function defaultSessionsGlobs() {
  const fromEnv = process.env.CODEX_CLI_SESSIONS_GLOB;
  if (typeof fromEnv === "string" && fromEnv !== "") {
    return fromEnv.split(":").filter(Boolean);
  }
  return [CAPS.CODEX_CLI_SESSIONS_GLOB];
}

// Maximum number of path SEGMENTS the glob expander will walk. Each "*"
// or literal in the pattern consumes one level. The canonical absolute
// glob "<HOME>/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl" has
// ~8 segments under $HOME; test fixtures under /tmp/<runner>/<TEST_ROOT>/...
// can run 10+ segments deep. The bound is purely defensive against a
// malformed pattern with absurd nesting — we set it high enough that real
// paths comfortably clear it.
const SESSIONS_WALK_MAX_DEPTH = 32;

// Per-file row-count safety: prevents a corrupt or hostile session file
// from forcing an unbounded JSON.parse loop in one tick. A real Codex
// session typically holds a few hundred rows; 50000 is two orders of
// magnitude above the live cap. Beyond this we bail with a parse_error
// tagged on the cursor and resume on the next tick.
const PER_FILE_ROW_HARD_CAP = 50000;

// F-NEW-R40-CODEX-ERR-STRING-TOO-LONG — fixed-size read window for the
// fd-based chunked session reader (_readSessionRows). 8 MiB balances
// syscall count against peak memory: a 912 MB rollout file streams in
// ~114 positional readSync calls with at most one chunk + one decoded
// line resident at a time. Each decoded LINE becomes one JS string, so
// individual chunks (and lines) must stay far below V8's max string
// length (536,870,888 bytes) — the limit the old whole-file readFileSync
// tripped over.
const READ_CHUNK_BYTES = 8 * 1024 * 1024;

// Upper bound on how far the first-line session_meta scan (the offset > 0
// fast path in _readSessionRows) will look for the first "\n". A real
// codex session_meta row is well under 100 KB; 4 chunks (32 MiB) is absurd
// headroom. Past this we give up on meta extraction and the caller falls
// back to filenameToSessionId — the rollout filename carries the same
// session UUID, so the per_session_cursors key stays stable.
const SESSION_META_SCAN_MAX_BYTES = 4 * READ_CHUNK_BYTES;

// F-T1-CODEX_CLI-F1 — scaffold-prefix detector. The Codex agent runtime
// injects framing turns into the session as if they were user-typed:
// <system_prompt>, <goal_context>, <subagent_notification>,
// <environment_context>, <INSTRUCTIONS>, <thesis_statement>,
// <counterpart_gaps>, "# AGENTS.md instructions for ...", and
// "CONTEXT AND INSTRUCTIONS:" headers. These are not operator dialogue;
// they are the scaffold that the next assistant turn is conditioned on.
//
// CRITIC NOTE (F-T1-CODEX_CLI-F1): the connector tags every auto-injected
// user turn with raw_content.auto_injected = true at write-time. The
// downstream Stage-0 module then trusts the flag (primary) and falls back
// to an anchored regex over user_text (for unflagged historical data
// already on disk). Tagging at write-time avoids re-running this regex on
// every Stage-0 dispatch and lets a future operator-pasted scaffold blob
// (where the prefix is incidental, not auto-injected) survive without a
// special-case opt-out.
//
// Anchored at start-of-string with `^\s*` so a real operator message that
// merely DISCUSSES a scaffold token ("the <system_prompt> tag did X")
// does NOT match — the regex requires the scaffold token to be the first
// non-whitespace content of the turn.
// F-NEW-W8-CODEX-CONNECTOR-MIRROR: keep in sync with stage0/codex-cli.js
// SCAFFOLD_USER_RE. The connector stamps auto_injected=true based on this
// regex; Stage-0 trusts the flag (and falls back to its own SCAFFOLD_USER_RE
// for unflagged historical rows). The two regexes MUST recognize the same
// envelope set. W7 added 4 interrupt tokens to stage0 only; W8 mirrors them
// here so the connector flag agrees: turn_aborted, session_aborted,
// tool_use_error, command_interrupted.
// F-A6-CODEX-RECOMMENDED-PLUGINS adds recommended_plugins to both regexes.
const SCAFFOLD_USER_RE =
  /^\s*(?:<(?:environment_context|system_prompt|goal_context|subagent_notification|INSTRUCTIONS|thesis_statement|counterpart_gaps|turn_aborted|session_aborted|tool_use_error|command_interrupted|recommended_plugins)\b|# AGENTS\.md instructions for|CONTEXT AND INSTRUCTIONS:)/i;

function looksAutoInjectedUserText(userText) {
  if (typeof userText !== "string" || userText === "") return false;
  return SCAFFOLD_USER_RE.test(userText);
}

// =============================================================================
// Glob expansion (bounded directory walk)
// =============================================================================

// expandGlob: given a path that may contain leading "~/" and any number of
// "*" path segments (NOT character-class globs, NOT "**"), returns the
// sorted list of files matching every literal/wildcard segment in turn.
//
// Single-segment "*" matches any direct child of the current directory.
// "rollout-*.jsonl" style filename matching is supported on the LAST segment.
//
// We deliberately do not pull in node-glob or fast-glob: the patterns we
// support are a strict subset and the walker is ~30 lines.
// Directory-listing memo, keyed on the directory's own (mtimeMs, ino).
//
// WHY: the production glob is
//   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl
// over a tree that is now 15 GB / 6,297 files / 5,623 directories, and the
// connector re-expands it on EVERY poll (~58 s). Uncached that is one
// readdirSync per directory plus one statSync per child — ~12,000 syscalls a
// poll, ~15 million a day — to rediscover a date-partitioned tree whose past
// days are immutable. Measured mid-poll: 63,252 filesystem events in 15 s,
// the second-largest source of filesystem-event traffic on the machine.
//
// CORRECTNESS: a directory's mtime changes whenever an entry is added,
// removed, or renamed, so an unchanged (mtimeMs, ino) means the child NAME SET
// is unchanged — safe to reuse. Entry TYPE cannot change without a
// rename/unlink+create, which also moves the parent's mtime. Appending to an
// existing file does NOT move the parent's mtime, and does not need to: the
// memo only caches DISCOVERY, and every returned path is still stat'd
// downstream by the per_session_file_meta / per_session_offsets logic, so
// growth of a known file is detected exactly as before. The ino check catches
// a directory replaced wholesale.
//
// NOT a cap: every session stays discoverable. Only the rediscovery of
// unchanged directories is elided. The memo is one small record per directory,
// proportional to the tree the caller already walks.
const _dirMemo = new Map();

// Test seam: drop the memo so suites stay order-independent.
export function _resetDirMemo() {
  _dirMemo.clear();
}

function listDirCached(dir) {
  let dst;
  try {
    dst = statSync(dir);
  } catch {
    _dirMemo.delete(dir);
    return null;
  }
  if (!dst.isDirectory()) {
    _dirMemo.delete(dir);
    return null;
  }
  const hit = _dirMemo.get(dir);
  if (hit != null && hit.mtimeMs === dst.mtimeMs && hit.ino === dst.ino) {
    return hit.children;
  }

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    _dirMemo.delete(dir);
    return null;
  }

  const children = [];
  for (const ent of entries) {
    const full = join(dir, ent.name);
    // statSync (follows symlinks) preserves the pre-memo behavior exactly:
    // session files may be symlinks, and the sessions tree itself can sit
    // under a symlinked /tmp on macOS.
    try {
      const st = statSync(full);
      children.push({ name: ent.name, isDir: st.isDirectory(), isFile: st.isFile() });
    } catch {
      // Race-with-deletion is non-fatal; omit the entry.
    }
  }
  _dirMemo.set(dir, { mtimeMs: dst.mtimeMs, ino: dst.ino, children });
  return children;
}

function expandGlob(pattern) {
  if (typeof pattern !== "string" || pattern === "") return [];
  let p = pattern;
  if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  if (p === "~") p = homedir();
  // Split on path separator; each segment is either a literal string or
  // contains one or more "*" wildcards.
  const segments = p.split("/").filter((s) => s !== "");
  if (segments.length === 0) return [];
  const rooted = p.startsWith("/") ? "/" : "";
  // BFS through the segments, accumulating candidate directories at each
  // depth. We bound the walk by SESSIONS_WALK_MAX_DEPTH defensively.
  let frontier = [rooted || "."];
  for (let i = 0; i < segments.length; i++) {
    if (i > SESSIONS_WALK_MAX_DEPTH) return [];
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    const matcher = segmentMatcher(seg);
    const next = [];
    for (const dir of frontier) {
      // listDirCached returns entries with their resolved type, reusing the
      // previous listing when the directory's (mtimeMs, ino) is unchanged.
      // Type resolution still uses statSync (symlink-following) inside the
      // memo, so leaf/intermediate classification is identical to the
      // pre-memo walk — see the memo header for the correctness argument.
      const children = listDirCached(dir);
      if (children == null) continue;
      for (const ch of children) {
        if (!matcher(ch.name)) continue;
        const full = join(dir, ch.name);
        if (isLast) {
          // Leaf: must resolve to a regular file.
          if (ch.isFile) next.push(full);
        } else {
          // Intermediate segment: follow into the directory, including a
          // symlink-to-directory (statSync followed it during memoization).
          if (ch.isDir) next.push(full);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) return [];
  }
  return frontier.sort();
}

// segmentMatcher: returns a fn(name) -> boolean for a glob segment that
// may contain "*" wildcards. We compile to a RegExp once per segment so
// the BFS inner loop is O(1) per candidate name.
function segmentMatcher(segment) {
  if (!segment.includes("*")) {
    return (name) => name === segment;
  }
  // Escape regex metacharacters EXCEPT "*", then replace "*" with ".*".
  // We intentionally do not support character classes, "?" wildcards, or
  // "**" globstar; the codex sessions layout doesn't need them.
  const re = "^" + segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
  const compiled = new RegExp(re);
  return (name) => compiled.test(name);
}

// =============================================================================
// F-CCS-CONNECTOR-codex-cli-structural — buildStructuredFeatures (per-row)
// =============================================================================
//
// The salience cascade currently re-derives entities and time anchors from
// raw turn text every time it promotes a fact. That is the FM-1 regression
// in slow motion for codex-cli specifically: a fuzzy NER pass over a single
// turn's `user_text + assistant_text` cannot recover the conversation_id
// (which is the most stable cross-turn join key) and frequently misses the
// project (the directory the operator was working in). This connector
// ALREADY KNOWS — at emit time — what the conversation is
// (raw_content.conversation_id), what project the operator is in
// (raw_content.cwd → basename), and when the turn happened (turn.ts). The
// structured-features payload pins all three so downstream cascades can stop
// forcing the text extractor to re-discover them. Mirrors the
// git-log-structural + github-events-structural pattern (W2-CCS).
//
// Shape (per WU spec + structured-features-schema.md §3.1):
//   parties      = ["user", "assistant"]   (fixed; matches the row's parties)
//   entities     = [
//     {kind:"topic",   canonical_id:"topic:codex-cli:<slug(conversation_id)>"},
//     {kind:"project", canonical_id:"project:codex-cli:<slug(basename(cwd))>"},
//   ] (project optional — only when cwd is present and slugifies non-empty)
//   time_anchors = [{kind:"absolute", instant_iso:turn.ts, structural:true,
//                    raw_phrase:turn.ts}]
//   schema_version  = "v1"
//   emitter_version = "codex-cli-structural@1.0.0"
//
// source_scope discipline: stamped as "codex-cli" verbatim. As of v0 this is
// NOT in ENTITY_SOURCE_SCOPES; the cascade's row-parties path silently skips
// unknown sources (distill-promote-fact.js §208), and the structured-features
// merger (distill-promote-fact.js §738-811) does NOT enforce source_scope
// against the enum — it merges by canonical_id verbatim. So our emission is
// strictly additive: future cascades that admit codex-cli to the enum pick
// up the structurally-typed entities byte-identical; today's cascade ignores
// the emission silently. Forward-compat by construction.

/** Frozen schema discriminator for the v0 ship of structured_features. */
export const STRUCTURED_FEATURES_SCHEMA_VERSION = "v1";

/**
 * Frozen emitter version stamped on every structured_features payload
 * produced by this module. Matches the time-anchor-schema §8 I8 regex
 * `/^[a-z0-9_\-]+@[0-9]+\.[0-9]+\.[0-9]+(\+[a-z0-9_\-]+)*$/`.
 * Naming convention mirrors github-events-structural + screentime-structural.
 */
export const STRUCTURED_FEATURES_EMITTER_VERSION = "codex-cli-structural@1.0.0";

/**
 * The source_scope this connector stamps. NOT in ENTITY_SOURCE_SCOPES at v0;
 * the cascade gracefully skips unknown sources at the row-parties path
 * (distill-promote-fact.js §208) but the structured_features merger admits
 * the emission verbatim via canonical_id union (§738-811). Forward-compat
 * for when codex-cli joins the enum.
 */
export const STRUCTURED_FEATURES_SOURCE_SCOPE = "codex-cli";

/**
 * Per-row evidence kind. Connector-emit allowlist per foundation spec §3.2
 * is {handle, structural, kb_lookup}. The conversation_id, cwd basename, and
 * turn ts are all structurally-typed fields fixed by the codex rollout
 * format, so 'structural' is the only honest value.
 */
const STRUCTURED_EVIDENCE = "structural";

// Module-VERSION export for the WU engineering discipline ("Module exports
// VERSION + frozen CAPS"). Pinned to the emitter version so a drift-detector
// pass can spot upgrades and re-extract.
export const VERSION = STRUCTURED_FEATURES_EMITTER_VERSION;

// Frozen CAPS bag for the WU discipline + test introspection. Tests can read
// CAPS.SCHEMA_VERSION etc. directly without poking at named exports.
export const STRUCTURED_FEATURES_CAPS = Object.freeze({
  SCHEMA_VERSION: STRUCTURED_FEATURES_SCHEMA_VERSION,
  EMITTER_VERSION: STRUCTURED_FEATURES_EMITTER_VERSION,
  SOURCE_SCOPE: STRUCTURED_FEATURES_SOURCE_SCOPE,
});

/**
 * _structuralEntity: build one Entity (entity-schema §4 shape) from a raw
 * surface. Returns null if the surface slugifies to the empty sentinel or
 * fails the slug regex (defensive degradation — the cascade still has the
 * text-extractor path for that surface).
 *
 * Pure function. No I/O, no Date.now(), no Math.random().
 */
function _structuralEntity(kind, surface) {
  if (typeof surface !== "string" || surface === "") return null;
  let slug;
  try {
    slug = entitySlugify(surface);
  } catch {
    return null;
  }
  if (slug === SLUG_EMPTY_SENTINEL) return null;
  if (!ENTITY_SLUG_REGEX.test(slug)) return null;
  return {
    kind,
    canonical_id: `${kind}:${STRUCTURED_FEATURES_SOURCE_SCOPE}:${slug}`,
    surface,
    source_scope: STRUCTURED_FEATURES_SOURCE_SCOPE,
    evidence: STRUCTURED_EVIDENCE,
    confidence: 1.0,
    extractor_version: STRUCTURED_FEATURES_EMITTER_VERSION,
  };
}

/**
 * buildStructuredFeatures: derive the structured_features payload for a
 * single codex-cli row from its raw_content. Returns the payload object on
 * success OR null when the raw_content is missing the structurally-typed
 * fields we need (defensive degradation per the brutalist hot-path discipline
 * — the connector emits the row WITHOUT structured_features and the cascade
 * falls back to the text-extractor path, which is the explicit
 * backwards-compat invariant from foundation spec §7).
 *
 * Inputs we read from raw_content (the connector ALREADY KNOWS these):
 *   - conversation_id : the codex thread_id; becomes a topic entity. Per
 *                       operator memory notes (memory.md §codex-in-claude-
 *                       workflow), thread_ids are tracked via `--json
 *                       thread_id` capture and are the stable cross-turn
 *                       join key for any codex session.
 *   - cwd             : the working directory the codex CLI was started in;
 *                       basename becomes a project entity. Optional — when
 *                       absent (very old codex versions / synthetic test
 *                       fixtures) the project entity is omitted.
 *   - turn_ts         : strict ISO-8601 timestamp; becomes the absolute
 *                       time anchor. The codex rollout writes turn timestamps
 *                       as strict ISO-8601 strings (verified against the live
 *                       operator fixture at storage/sources/codex-cli.jsonl).
 *
 * Failure modes that route to null (NOT throw — never block emit):
 *   - rawContent is not a plain object
 *   - all three structural fields are missing/empty/non-string
 *   - conversation_id AND cwd both fail to slugify
 *
 * Otherwise: returns a partial payload (some structural fields may be empty
 * arrays if their input was malformed). The cascade merger is union-with-
 * precedence so partial structural emission is strictly additive (foundation
 * spec §6).
 */
export function buildStructuredFeatures(rawContent) {
  if (rawContent == null || typeof rawContent !== "object" || Array.isArray(rawContent)) {
    return null;
  }

  const entities = [];

  // Topic entity from conversation_id (the codex thread_id). The thread_id
  // is the most stable cross-turn join key — every turn of the same codex
  // session carries the same conversation_id, and `codex resume <thread_id>`
  // is the operator's primary mechanism for re-entering a session. Using
  // `topic` as the kind matches the spec note: the closed kind enum
  // (entity-extractor.js §3) has no "session"/"thread", and topic is the
  // right semantic bucket for "the bounded conversation context".
  const conversationId = rawContent.conversation_id;
  const topicEntity = _structuralEntity("topic", conversationId);
  if (topicEntity) entities.push(topicEntity);

  // Project entity from basename(cwd). basename collapses an absolute path
  // to its leaf name so a session started under
  // <HOME>/memory-system/mcp slugifies to `mcp` (not the full path).
  // Same project across re-clones / re-mounts stamps the same canonical_id.
  let projectEntity = null;
  const cwd = rawContent.cwd;
  if (typeof cwd === "string" && cwd !== "") {
    const cwdBase = basename(cwd);
    projectEntity = _structuralEntity("project", cwdBase);
    if (projectEntity) entities.push(projectEntity);
  }

  // Absolute time anchor from the turn timestamp. We accept `turn_ts` (the
  // canonical field name per WU spec) AND fall back to the row's `ts` field
  // — the connector currently writes the turn timestamp at the ROW level
  // (row.ts) and does NOT replicate it inside raw_content. This dual-read
  // keeps the helper usable both at emit time (raw_content has turn_ts via
  // the caller-supplied shape) and at re-extract time (a tail of the on-disk
  // ledger has row.ts only). Pure function — no Date.now() fallback.
  const timeAnchors = [];
  const turnTs =
    typeof rawContent.turn_ts === "string" && rawContent.turn_ts !== ""
      ? rawContent.turn_ts
      : (typeof rawContent.ts === "string" && rawContent.ts !== ""
          ? rawContent.ts
          : null);
  if (typeof turnTs === "string" && turnTs !== "") {
    const parsedMs = Date.parse(turnTs);
    if (Number.isFinite(parsedMs)) {
      timeAnchors.push({
        kind: "absolute",
        // WU spec calls for `instant_iso:turn_ts`. The cascade merger's
        // dedupe key (distill-promote-fact.js §783-795) accepts both
        // `parsed.iso` and `instant_iso` — we use `instant_iso` to match
        // the WU spec verbatim and to align with the cascade's own row-ts
        // stamp (§700) which also writes `instant_iso`.
        instant_iso: turnTs,
        raw_phrase: turnTs,
        extractor_confidence: 1.0,
        extractor_version: STRUCTURED_FEATURES_EMITTER_VERSION,
        // structural=true is the connector's pinning that this anchor
        // comes from a structurally-typed field — the merger uses this
        // to win tie-breaks over text-extracted anchors of the same
        // (kind, iso) per foundation spec §6 OQ5.
        structural: true,
      });
    }
  }

  // parties[] is the literal pair per WU spec — fixed for every codex turn.
  // Mirrors the row.parties shape stamped by buildRow above. The cascade's
  // row-parties path will route both "user" and "assistant" through
  // buildPartyEntity but silently skip them (codex-cli is not in
  // ENTITY_SOURCE_SCOPES at v0), so the emission here is the only place the
  // cascade learns the party shape for this row at v0.
  const parties = ["user", "assistant"];

  // If we found NOTHING structural at all, return null so the row emits
  // without structured_features (backwards-compat path; cascade text
  // extractor runs as today). The parties[] pair alone is not enough — a
  // row without conversation_id, cwd, OR a turn_ts is malformed enough
  // that structural emission would be a lie.
  if (entities.length === 0 && timeAnchors.length === 0) {
    return null;
  }

  // Sort entities by canonical_id (foundation spec §3.1 — array MUST be
  // sorted ascending for byte-stable merge / dedupe).
  entities.sort((a, b) =>
    a.canonical_id < b.canonical_id ? -1 : a.canonical_id > b.canonical_id ? 1 : 0,
  );

  return {
    schema_version: STRUCTURED_FEATURES_SCHEMA_VERSION,
    emitter_version: STRUCTURED_FEATURES_EMITTER_VERSION,
    entities,
    time_anchors: timeAnchors,
    parties,
  };
}

// =============================================================================
// CodexCliConnector
// =============================================================================

export class CodexCliConnector extends ConnectorBase {
  // These three maps are keyed per Codex session and grow with the session
  // corpus — 6,297 entries / 1.9 MB of the 2.165 MB cursor at time of writing,
  // against 78 bytes of genuinely hot O(1) fields. Routing them to the
  // change-gated sidecar takes this connector's cursor writes from ~3.2 GB/day
  // to approximately zero while it is idle, without bounding how many sessions
  // are tracked. See ConnectorBase.heavyCursorKeys.
  get heavyCursorKeys() {
    return ["per_session_file_meta", "per_session_offsets", "per_session_cursors"];
  }

  constructor(opts = {}) {
    const {
      sessionsGlobs,
      batchMaxTurns,
      consentBasisOverride,
      now,
      // ConnectorBase pass-throughs:
      sourceLedgerPath,
      cursorPath,
    } = opts;

    // Operator-overridable consent_basis. Default is first_party because
    // the operator is the human party in operator-run Codex sessions
    // (Phase A spec § Schema per source). The override exists so an operator
    // who tails a shared codex session (pair-programming, demo recording)
    // can flip to second_party_dm via env var without code change.
    const consentBasis =
      typeof consentBasisOverride === "string" && consentBasisOverride !== ""
        ? consentBasisOverride
        : (process.env.CODEX_CLI_CONSENT_BASIS || "first_party");

    function sourcePolicyForRow(_row) {
      // Authorship is unambiguous for agent-runtime sources: every turn is
      // either operator-typed (user) or model-generated (assistant). Both
      // sides are "operator's session" for consent purposes — analogous to
      // chat-claude-code Phase 2b discipline.
      return {
        deletion_semantics: "full_excise",
        consent_basis: consentBasis,
      };
    }

    super({
      source: SOURCE,
      sourceLedgerPath,
      cursorPath,
      sourcePolicyForRow,
    });

    this.sessionsGlobs =
      Array.isArray(sessionsGlobs) && sessionsGlobs.length > 0
        ? sessionsGlobs
        : defaultSessionsGlobs();
    this.batchMaxTurns =
      Number.isInteger(batchMaxTurns) && batchMaxTurns > 0
        ? batchMaxTurns
        : CAPS.CODEX_CLI_BATCH_MAX_TURNS;
    // Override-for-test: opts.now is a () => ISO-8601 string; production
    // uses the shared envelope.serverTs.
    this._now = typeof now === "function" ? now : serverTs;
  }

  // ---------------------------------------------------------------------------
  // Session discovery
  // ---------------------------------------------------------------------------

  // discoverSessionFiles: expand every configured glob, dedupe, sort by
  // mtime ascending so the oldest pending session is processed first
  // (matches ledger append-only chronology).
  discoverSessionFiles() {
    const found = new Set();
    for (const g of this.sessionsGlobs) {
      const matches = expandGlob(g);
      for (const m of matches) found.add(m);
    }
    const list = [...found];
    // Sort by mtime ascending; on tie fall back to path for determinism.
    list.sort((a, b) => {
      let ma = 0;
      let mb = 0;
      try { ma = statSync(a).mtimeMs; } catch { /* keep 0 */ }
      try { mb = statSync(b).mtimeMs; } catch { /* keep 0 */ }
      if (ma !== mb) return ma - mb;
      return a.localeCompare(b);
    });
    return list;
  }

  // ---------------------------------------------------------------------------
  // Per-file row reader
  // ---------------------------------------------------------------------------

  // _readSessionRows: stream the file as JSONL starting at `fromOffset`
  // bytes and return { rows, sessionId, sessionCwd, newOffset, error }.
  // Malformed lines are skipped (not fatal); the parse_error tag is
  // incremented at most once per call.
  //
  // The Codex rollout format puts the session_meta as the first row, which
  // carries `payload.id` (the session UUID we cursor on). We surface it
  // separately so the caller can key per_session_cursors regardless of
  // where in the byte stream the first turn lands.
  //
  // F-NEW-R40-CODEX-ERR-STRING-TOO-LONG — this function used to slurp the
  // whole file via readFileSync(filePath, "utf8"). V8 caps a single JS
  // string at 536,870,888 bytes, so once a long-lived session's rollout
  // file outgrew that limit the read threw ERR_STRING_TOO_LONG on EVERY
  // poll: zero rows came back, tagError fired once per tick (observed
  // error_count 18k+ against a 912 MB session file), and the file's tail
  // was never ingested. Replaced with an fd-based positional chunked
  // reader:
  //
  //   1. When fromOffset > 0, read ONLY the first line (from byte 0) to
  //      recover session_meta (payload.id / payload.cwd). The old code got
  //      the meta "for free" because it re-walked the whole string from
  //      byte 0 on every call.
  //   2. Stream from `offset` in READ_CHUNK_BYTES readSync chunks,
  //      splitting on "\n" at the BYTE level (0x0A can never appear inside
  //      a multi-byte UTF-8 sequence, so byte-splitting is UTF-8 safe) and
  //      carrying the partial trailing line across chunk boundaries as a
  //      Buffer — NOT a string, because a chunk boundary can land inside a
  //      multi-byte character; only complete lines are ever decoded.
  //
  // Per-poll cost is O(bytes past fromOffset) plus one bounded first-line
  // read; peak memory is one chunk + one decoded line. Semantics preserved
  // from the string-based version:
  //
  //   - The truncation/rotation clamp below is deliberately STRICT
  //     (`fromOffset < size`, not `<=`) so an UNCHANGED file
  //     (fromOffset == size) re-walks from byte 0. That re-walk is
  //     load-bearing: _pairTurns numbers turns from the start of whatever
  //     rows it is given, so only a from-byte-0 walk yields
  //     session-relative turn indexes that can advance past the
  //     per_session_cursors watermark. Do NOT "optimise" this to `<=`.
  //   - Offsets are now true BYTES (fstat size). The old code persisted
  //     raw.length, which is UTF-16 code units; for a file containing
  //     multi-byte characters a legacy offset lands a little EARLY in the
  //     byte stream, the partial first line costs one parse_error, and the
  //     turn-index dedup absorbs the re-read. Self-heals once the byte
  //     offset is persisted. (Pure-ASCII files — the common case — have
  //     identical units under both schemes.)
  //   - Genuinely unreadable files (ENOENT, EACCES, EIO mid-read) return
  //     { rows: [], newOffset: fromOffset, error: err.code } exactly as
  //     the readFileSync version did — all-or-nothing on I/O failure.
  //   - PER_FILE_ROW_HARD_CAP now bounds lines WALKED IN THIS CALL rather
  //     than lines-from-byte-0 (the old code always walked from byte 0, so
  //     the two were the same thing). Counting per-call is truer to the
  //     cap's intent — bounding the JSON.parse work of one tick.
  _readSessionRows(filePath, fromOffset) {
    let fd = null;
    try {
      fd = openSync(filePath, "r");
      const st = fstatSync(fd);
      const size = st.size;
      const mtimeMs = st.mtimeMs;
      if (size === 0) {
        return {
          rows: [],
          sessionId: null,
          sessionCwd: null,
          newOffset: 0,
          error: null,
          readFailed: false,
          parseErrorCount: 0,
          walkedFrom: 0,
          hitRowCap: false,
          fileSize: 0,
          fileMtimeMs: mtimeMs,
        };
      }
      // Defensive: if the file was truncated or rotated since the last poll,
      // the stored offset may exceed the new size. Fall back to byte 0 so we
      // re-derive the session_id and re-walk; turn-index dedup absorbs the
      // re-read. (Strict `<` on purpose — see the header comment above.)
      const offset =
        Number.isInteger(fromOffset) && fromOffset >= 0 && fromOffset < size
          ? fromOffset
          : 0;

      const rows = [];
      let sessionId = null;
      // F-NEW-W3-CHAT-CC-CODEX-CWD-KEY-ASYMMETRY — the codex rollout's
      // session_meta row carries payload.cwd (the working directory the
      // codex CLI was started in). This is FAR more accurate than the
      // connector daemon's own process.cwd() (which is the daemon's start
      // dir, not the codex session's), so we prefer the session-meta cwd
      // when present and only fall back to process.cwd() when the rollout
      // omits it (synthetic test fixtures, very old codex versions).
      let sessionCwd = null;
      let parseErrors = 0;
      let lineNum = 0;
      let hitRowCap = false;

      // handleLine: shared per-line logic for the first-line meta read and
      // the main streaming walk. `keep` mirrors the old `lineStart >= offset`
      // check: every line the main walk sees starts at or past `offset` (we
      // seek there), so the only walked-but-not-kept line is the first-line
      // meta read. Returns false when the row cap trips (stop reading).
      const handleLine = (line, keep) => {
        if (lineNum > PER_FILE_ROW_HARD_CAP) {
          hitRowCap = true;
          return false;
        }
        lineNum += 1;
        if (line === "") return true;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          parseErrors += 1;
          return true;
        }
        if (!parsed || typeof parsed !== "object") return true;
        // Capture session_meta even if we are reading from a non-zero offset.
        if (parsed.type === "session_meta" && parsed.payload && typeof parsed.payload.id === "string") {
          sessionId = parsed.payload.id;
          if (typeof parsed.payload.cwd === "string" && parsed.payload.cwd.length > 0) {
            sessionCwd = parsed.payload.cwd;
          }
        }
        if (keep) rows.push(parsed);
        return true;
      };

      // Single reusable read window. allocUnsafe is fine: we only ever look
      // at chunk.subarray(0, bytesRead) and copy anything that must outlive
      // the next readSync.
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);

      // (1) First-line session_meta read. Only needed when the main walk
      // starts past byte 0 — a from-zero walk sees the meta line anyway.
      if (offset > 0) {
        let firstLineBytes = null;
        let acc = null;
        let scanPos = 0;
        while (scanPos < size && scanPos < SESSION_META_SCAN_MAX_BYTES) {
          const want = Math.min(READ_CHUNK_BYTES, size - scanPos);
          const n = readSync(fd, chunk, 0, want, scanPos);
          if (n <= 0) break;
          const view = chunk.subarray(0, n);
          const nl = view.indexOf(0x0a);
          if (nl !== -1) {
            const head = Buffer.from(view.subarray(0, nl));
            firstLineBytes = acc === null ? head : Buffer.concat([acc, head]);
            break;
          }
          // No newline in this window yet — copy and keep scanning. (A
          // session_meta line this long is pathological; the scan cap
          // bails us out and meta extraction degrades to the
          // filenameToSessionId fallback in pollOnce.)
          acc = acc === null ? Buffer.from(view) : Buffer.concat([acc, Buffer.from(view)]);
          scanPos += n;
        }
        if (firstLineBytes !== null) {
          handleLine(firstLineBytes.toString("utf8"), false);
        }
      }

      // (2) Main streaming walk from `offset` to EOF.
      let pos = offset;
      let carry = null; // raw bytes of a partial line spanning chunk reads
      while (pos < size && !hitRowCap) {
        const want = Math.min(READ_CHUNK_BYTES, size - pos);
        const n = readSync(fd, chunk, 0, want, pos);
        // Short-read / EOF race: the file shrank between fstat and here
        // (rotation). Stop; the strict clamp re-walks from byte 0 on the
        // next poll and turn-index dedup absorbs the replay.
        if (n <= 0) break;
        pos += n;
        const view = chunk.subarray(0, n);
        let from = 0;
        while (from < n) {
          const nl = view.indexOf(0x0a, from);
          if (nl === -1) break;
          let lineBuf = view.subarray(from, nl);
          if (carry !== null) {
            lineBuf = Buffer.concat([carry, lineBuf]);
            carry = null;
          }
          if (!handleLine(lineBuf.toString("utf8"), true)) break;
          from = nl + 1;
        }
        if (hitRowCap) break;
        if (from < n) {
          // Partial trailing line: COPY it out (the chunk buffer is reused
          // by the next readSync) and prepend it to the next chunk's bytes.
          const rest = Buffer.from(view.subarray(from, n));
          carry = carry === null ? rest : Buffer.concat([carry, rest]);
        }
      }
      // Trailing line with no terminating newline (session mid-write). The
      // string-based version parsed it; keep that behavior.
      if (!hitRowCap && carry !== null && carry.length > 0) {
        handleLine(carry.toString("utf8"), true);
      }

      // newOffset = fstat size, mirroring the old newOffset = raw.length
      // (full file length) — including on a row-cap bail, where the old
      // code ALSO advanced past the unwalked tail.
      //
      // F-NEW-R41-CODEX-PARSE-LOOP — the advisory fields below let pollOnce
      // distinguish STATIC content defects (a line that was read but fails
      // JSON.parse; re-reading can never fix it) from TRANSIENT read
      // failures (the catch path: readFailed=true), and let it key error
      // de-duplication + the unchanged-file skip on the exact content
      // version (fileSize + fileMtimeMs from the same fstat the walk used).
      // walkedFrom is the EFFECTIVE start offset after the truncation/
      // rotation clamp — walkedFrom === 0 means the walk saw the whole file
      // and the paired turn indexes are session-relative.
      return {
        rows,
        sessionId,
        sessionCwd,
        newOffset: size,
        error: parseErrors > 0 ? "parse_error" : null,
        readFailed: false,
        parseErrorCount: parseErrors,
        walkedFrom: offset,
        hitRowCap,
        fileSize: size,
        fileMtimeMs: mtimeMs,
      };
    } catch (err) {
      // Genuine I/O failure (ENOENT / EACCES / EIO mid-read, ...): rows are
      // all-or-nothing and the offset is pinned at fromOffset for retry.
      // readFailed=true is the ONLY signal pollOnce accepts for pinning the
      // per-session offset — parse errors above never set it.
      return {
        rows: [],
        sessionId: null,
        sessionCwd: null,
        newOffset: fromOffset,
        error: err.code || "read_error",
        readFailed: true,
        parseErrorCount: 0,
        walkedFrom: null,
        hitRowCap: false,
        fileSize: null,
        fileMtimeMs: null,
      };
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* double-close / EBADF: nothing to do */ }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Turn pairing
  // ---------------------------------------------------------------------------

  // pairTurns: walk the session rows and pair adjacent user / assistant
  // `response_item` rows into turns. Returns an array of
  //   { turn_index, ts, user_text, assistant_text, developer_texts }
  // where:
  //   - turn_index counts paired turns from the START of the session
  //     (session-relative, not per-pollOnce). This is the dedup key.
  //   - developer_texts is the array of any `role:"developer"` rows that
  //     appeared between this turn and the previous one. Stored as a
  //     blake2b hash on the row (raw_content.system_prompt_hash) — never as
  //     content, per Phase A spec.
  //
  // Empty / tool-result-only turns are flagged via the Stage-0 module at
  // append time; we still pair them so the turn_index counter stays monotonic.
  _pairTurns(rows) {
    const turns = [];
    let pendingUser = null;
    let pendingDev = [];
    let lastTs = null;
    let turnIndex = 0;
    for (const row of rows) {
      if (!row || row.type !== "response_item") continue;
      const payload = row.payload || {};
      if (payload.type !== "message") continue;
      const role = payload.role;
      const text = extractText(payload.content);
      const ts = typeof row.timestamp === "string" ? row.timestamp : null;
      if (ts) lastTs = ts;
      if (role === "developer") {
        // Developer rows are system-prompt boilerplate. Hash-only.
        if (text) pendingDev.push(text);
        continue;
      }
      if (role === "user") {
        // A new user turn closes any previous unmatched user (operator
        // sent two messages in a row with no assistant response — rare but
        // possible). We emit the previous unmatched user with empty
        // assistant_text so the turn_index counter stays monotonic. The
        // half-turn is typically Stage-0 dropped (empty_assistant), so we
        // do NOT drain pendingDev here — the next paired turn will inherit
        // the same developer-row context the dropped half-turn would have
        // carried.
        if (pendingUser !== null) {
          turns.push({
            turn_index: turnIndex++,
            ts: pendingUser.ts || lastTs,
            user_text: pendingUser.text,
            assistant_text: "",
            developer_texts: pendingDev,
          });
        }
        pendingUser = { text, ts };
        continue;
      }
      if (role === "assistant") {
        // Pair with pendingUser if present; otherwise this is an unmatched
        // assistant (rare — would imply the session opened with a non-user
        // turn). Still emit so turn_index stays monotonic.
        turns.push({
          turn_index: turnIndex++,
          ts: ts || (pendingUser && pendingUser.ts) || lastTs,
          user_text: pendingUser ? pendingUser.text : "",
          assistant_text: text,
          developer_texts: pendingDev,
        });
        pendingUser = null;
        pendingDev = [];
        continue;
      }
    }
    // Trailing unmatched user (session still in flight). Emit with empty
    // assistant — the next pollOnce will see it again and overwrite if a
    // response materialised. The Stage-0 hook drops the empty-assistant
    // case so we don't pollute the ledger with half-turns.
    if (pendingUser !== null) {
      turns.push({
        turn_index: turnIndex++,
        ts: pendingUser.ts || lastTs,
        user_text: pendingUser.text,
        assistant_text: "",
        developer_texts: pendingDev,
      });
    }
    return turns;
  }

  // ---------------------------------------------------------------------------
  // pollOnce — the main per-tick entry point
  // ---------------------------------------------------------------------------

  // pollOnce: discover session files, tail each, pair turns, append. Returns
  // {appended, errors, sessions}.
  //
  // Idempotent on session_uuid + turn_index. Re-running with no new turns
  // returns {appended: 0, errors: 0}. Restart-recovery: if state.json is
  // missing the per_session_cursors map, the first poll re-scans every
  // discovered file and the base-class source_msg_id tail-read deduplicates
  // anything already on disk.
  async pollOnce() {
    const files = this.discoverSessionFiles();
    const state = (await this.readCursor()) || {};
    const perSessionCursors =
      state.per_session_cursors && typeof state.per_session_cursors === "object"
        ? { ...state.per_session_cursors }
        : {};
    const perSessionOffsets =
      state.per_session_offsets && typeof state.per_session_offsets === "object"
        ? { ...state.per_session_offsets }
        : {};
    // F-NEW-R41-CODEX-PARSE-LOOP — per-file content-version bookkeeping,
    // persisted next to per_session_offsets:
    //   { "<fileBase>": { size, mtime_ms, ingest_complete, parse_error_tagged } }
    //
    //   size / mtime_ms       — the fstat the last successful walk ran
    //                           against; together with fileBase they key the
    //                           file's CONTENT VERSION.
    //   ingest_complete       — the last walk of this version started at
    //                           byte 0 (session-relative turn numbering) and
    //                           the turn loop was not broken early (append
    //                           failure / batch cap), i.e. every turn this
    //                           version can ever yield has been offered to
    //                           the cursor gate. Unchanged files with
    //                           ingest_complete are SKIPPED entirely (zero
    //                           reads) instead of being re-walked from byte
    //                           0 by the strict clamp in _readSessionRows.
    //   parse_error_tagged    — parse_error was tagError()d for THIS content
    //                           version. Line-level parse failures are
    //                           static content defects, so tagging them
    //                           more than once per version only inflates
    //                           error_count (the R41 live-loop symptom:
    //                           error_count +~1.3k/poll against dead files).
    const perFileMeta =
      state.per_session_file_meta && typeof state.per_session_file_meta === "object"
        ? { ...state.per_session_file_meta }
        : {};

    let appendedCount = 0;
    let errorCount = 0;
    let lastAppendedTs = state.last_appended_ts || null;
    let lastAppendedId = state.last_appended_id || null;
    let sessionsProcessed = 0;
    // c3-cursor-stamp-class: did any REAL cursor map change this poll? Set at
    // the three per-session-cursor / per-file-offset assignment sites below,
    // and only when the stored value actually differs. Deliberately NOT set by
    // the per_session_file_meta update — that is size/mtime bookkeeping, not
    // cursor progress. See the write site at the tail of this method.
    let cursorAdvanced = false;
    // Proto-safe own-value read for the cursor maps: a bare `map[k]` would
    // return Function.prototype.toString for k === "toString" and score a
    // spurious advance. Commit b97565c closed two prototype-key defects in
    // this tree; do not reintroduce the pattern.
    const ownValue = (map, key) =>
      Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

    for (const filePath of files) {
      const fileBase = basename(filePath);
      const fromOffset = Number.isInteger(perSessionOffsets[fileBase])
        ? perSessionOffsets[fileBase]
        : 0;

      // F-NEW-R41-CODEX-PARSE-LOOP — unchanged-file skip. If the last walk
      // of this exact content version was a complete from-zero walk and the
      // offset already sits at EOF, a re-read is provably a no-op: the same
      // bytes yield the same turns, all at-or-below the per_session_cursors
      // watermark. Skipping here is what makes a permanently-bad (or merely
      // huge) dead session file cost ZERO reads per tick instead of a full
      // re-parse — _readSessionRows' strict clamp deliberately re-walks
      // from byte 0 when fromOffset == size, which is correct for turn
      // numbering but ruinous as a steady-state. A content change (size or
      // mtime drift) always forces a fresh read.
      const prevMeta = perFileMeta[fileBase];
      if (prevMeta && prevMeta.ingest_complete === true) {
        let quickStat = null;
        try { quickStat = statSync(filePath); } catch { quickStat = null; }
        if (
          quickStat &&
          quickStat.size === prevMeta.size &&
          quickStat.mtimeMs === prevMeta.mtime_ms &&
          fromOffset === quickStat.size
        ) {
          sessionsProcessed += 1;
          continue;
        }
      }

      const {
        rows,
        sessionId,
        sessionCwd,
        newOffset,
        error,
        readFailed,
        walkedFrom,
        fileSize,
        fileMtimeMs,
      } = this._readSessionRows(filePath, fromOffset);
      let parseErrorTagged = false;
      if (error) {
        if (readFailed) {
          // Genuine READ error (fs error: ENOENT / EACCES / EIO mid-file).
          // Transient by nature — tag every occurrence; the offset stays
          // pinned (gate below) so the next tick retries the same bytes.
          errorCount += 1;
          await this.tagError(error);
        } else {
          // parse_error — a line was READ but is not valid JSON. Static
          // content defect: re-reading can never succeed. Tag it at most
          // once per content version (fileBase + size + mtime_ms) so a
          // permanently-bad file cannot inflate error_count forever.
          const alreadyTagged =
            prevMeta != null &&
            prevMeta.parse_error_tagged === true &&
            prevMeta.size === fileSize &&
            prevMeta.mtime_ms === fileMtimeMs;
          if (!alreadyTagged) {
            errorCount += 1;
            await this.tagError(error);
          }
          parseErrorTagged = true;
        }
        // Continue with whatever rows we did parse — partial progress is
        // better than zero.
      }
      sessionsProcessed += 1;
      // Determine session_uuid. Fall back to filename if session_meta was
      // missing (defensive — a corrupt header would otherwise prevent any
      // cursor key). The filename-derived id is stable across re-reads.
      const effectiveSessionId = sessionId || filenameToSessionId(fileBase);
      const lastTurnIndex = Number.isInteger(perSessionCursors[effectiveSessionId])
        ? perSessionCursors[effectiveSessionId]
        : -1;

      const turns = this._pairTurns(rows);
      let appendedInFile = 0;
      // F-NEW-R41-CODEX-PARSE-LOOP — track WHY the turn loop ended. Both
      // early-exit reasons leave turns un-offered to the cursor gate, so
      // the file must be re-walked next tick (ingest_complete=false below).
      let appendFailed = false;
      let batchCapped = false;
      for (const turn of turns) {
        if (appendedInFile >= this.batchMaxTurns) {
          batchCapped = true;
          break;
        }
        if (turn.turn_index <= lastTurnIndex) continue;
        // F-T1-CODEX_CLI-F1 — connector-side scaffold tagging. If the
        // user_text starts with an auto-injection scaffold token, set
        // auto_injected=true on the row BEFORE Stage-0 sees it. Stage-0
        // then keys off the flag (primary path) rather than re-running the
        // regex on every dispatch. The flag is persisted in the row's
        // raw_content so the quarantine entry carries the tagging
        // provenance for any future restore.
        const autoInjected = looksAutoInjectedUserText(turn.user_text);
        // F-NEW-W1-CODEX-QUARANTINE-METADATA — build the stable
        // source_msg_id BEFORE Stage-0 so that, if Stage-0 routes the row
        // to quarantine, the entry carries source_msg_id (the key
        // restoreFromQuarantine() searches on). Pre-flag code passed only
        // {source, raw_content} to Stage-0 which made source_msg_id null
        // on the quarantine entry and rendered the row unrecoverable by id.
        const sourceMsgId = `codex:${effectiveSessionId}:${turn.turn_index}`;
        const turnTs = typeof turn.ts === "string" ? turn.ts : undefined;
        // System-prompt hash is computed up-front so the probe event
        // exposes it to Stage-0 for the system_prompt_hash dedup signal
        // (F-T2-CODEX_CLI-F6). We compute it once and re-use it when we
        // build the final row below.
        const systemPromptHashForProbe =
          turn.developer_texts && turn.developer_texts.length > 0
            ? hashSystemPrompts(turn.developer_texts)
            : null;
        // Stage-0 hook: per-source structural filter. We invoke through
        // the canonical stage0Dispatch (F-NEW-W1-CODEX-TELEMETRY-SINK) so
        // the persistent JSONL telemetry sink (recordDrop → storage/
        // telemetry/stage0_counters_<date>.jsonl) fires. Calling
        // codexCliStage0 directly bypassed the dispatcher and silenced
        // the per-reason counter sink.
        //
        // We invoke before building the full row so a DROP decision
        // short-circuits the expensive checksum + atomic-append path —
        // but we stamp source_msg_id, ts, parties, session_file,
        // conversation_id, and turn_index on the probe so the Stage-0
        // → quarantineRow path snapshots the FULL recoverable row, not
        // a stripped form. restoreFromQuarantine() keys on
        // source_msg_id so a null id would make the row unrecoverable.
        // F-NEW-W3-CHAT-CC-CODEX-CWD-KEY-ASYMMETRY: stamp cwd on the probe
        // event as well so the chat-cc-side dedup index, when it tail-reads
        // codex-cli.jsonl, sees a non-wildcard cwd bucket. buildRow() below
        // stamps the same value onto the on-disk row. Priority order:
        //   1. CODEX_CLI_FORCE_CWD env (hermetic test override)
        //   2. session_meta.payload.cwd from the rollout file (authoritative
        //      for the codex session itself — the cwd the codex CLI was
        //      started in)
        //   3. process.cwd() (daemon-side fallback when older rollout
        //      versions omit cwd from session_meta; less accurate but
        //      strictly better than the pre-W3 wildcard `*` bucket)
        const probeCwdOverride = process.env.CODEX_CLI_FORCE_CWD;
        const probeCwd =
          typeof probeCwdOverride === "string" && probeCwdOverride.length > 0
            ? probeCwdOverride
            : (typeof sessionCwd === "string" && sessionCwd.length > 0
                ? sessionCwd
                : process.cwd());
        const probeEvent = {
          source: SOURCE,
          source_msg_id: sourceMsgId,
          ts: turnTs,
          parties: ["user", "assistant"],
          raw_content: {
            conversation_id: effectiveSessionId,
            session_file: fileBase,
            turn_index: turn.turn_index,
            user_text: turn.user_text,
            assistant_text: turn.assistant_text,
            auto_injected: autoInjected,
            cwd: probeCwd,
            ...(systemPromptHashForProbe !== null
              ? { system_prompt_hash: systemPromptHashForProbe }
              : {}),
          },
        };
        const stage0Verdict = stage0Dispatch(probeEvent);
        if (stage0Verdict && stage0Verdict.decision === "DROP") {
          // Advance the per-session cursor over the dropped turn so we don't
          // re-evaluate it on the next poll. Salience-layer telemetry will
          // not see a DROP from a never-emitted row; that's by design.
          // Stage-0 itself is responsible for routing the dropped row to
          // F-INFRA-QUARANTINE (14-day retention per
          // F-T1-CODEX_CLI-F1 critic) using the row Stage-0 receives.
          // c3-cursor-stamp-class: moving the cursor past a dropped turn is
          // real skip-past progress (telegram.js:247 "append OR skip-past").
          if (ownValue(perSessionCursors, effectiveSessionId) !== turn.turn_index) {
            cursorAdvanced = true;
          }
          perSessionCursors[effectiveSessionId] = turn.turn_index;
          continue;
        }
        const row = buildRow({
          sessionId: effectiveSessionId,
          sessionFileBasename: fileBase,
          turn,
          autoInjected,
          sessionCwd,
        });
        try {
          const res = await this.appendLedgerRow(row);
          if (res.appended) {
            appendedCount += 1;
            appendedInFile += 1;
            lastAppendedTs = this._now();
            lastAppendedId = res.id;
          }
          // Whether appended or deduped, advance the per-session cursor
          // past this turn. Dedup is fine: row is already on disk.
          // c3-cursor-stamp-class: only a real change counts as an advance.
          if (ownValue(perSessionCursors, effectiveSessionId) !== turn.turn_index) {
            cursorAdvanced = true;
          }
          perSessionCursors[effectiveSessionId] = turn.turn_index;
        } catch (err) {
          errorCount += 1;
          appendFailed = true;
          await this.tagError(err && err.code ? err.code : "append_error");
          // Do NOT advance cursor on append failure — next poll retries.
          break;
        }
      }
      // F-NEW-R41-CODEX-PARSE-LOOP — per-file offset advance. The old gate
      // (`errorCount === 0 || appendedInFile > 0`) had two defects:
      //   1. It keyed on the POLL-GLOBAL errorCount, so one bad file blocked
      //      offset advancement for every later file in the same tick.
      //   2. It treated parse_error like a transient failure. A line that
      //      was READ but fails JSON.parse is a static content defect —
      //      pinning the offset just re-reads (and re-fails) the same bytes
      //      every tick, forever. That was the live loop: legacy mid-line
      //      offsets each cost one parse_error per poll, the gate then
      //      froze EVERY stuck offset, and error_count climbed ~1.3k/min.
      // New rule: advance past the bytes actually consumed unless
      //   - the READ itself failed (fs error; rows are all-or-nothing and
      //     newOffset === fromOffset anyway), or
      //   - an append failure broke the loop with zero progress (retry the
      //     same bytes next tick — pre-existing semantics).
      // Turn accounting is decoupled from the offset: per_session_cursors
      // only ever advances through turns actually offered to the gate, and
      // any turns deferred by a non-zero-offset walk are recovered by the
      // next from-zero re-walk (fromOffset == size clamps to 0).
      if (!readFailed && (!appendFailed || appendedInFile > 0)) {
        // c3-cursor-stamp-class: a first-ever offset (prior undefined) and any
        // change to an existing one are both real cursor progress; re-writing
        // the same offset for an unchanged file is not.
        if (ownValue(perSessionOffsets, fileBase) !== newOffset) {
          cursorAdvanced = true;
        }
        perSessionOffsets[fileBase] = newOffset;
      }
      // Record the content version this walk ran against. ingest_complete
      // requires a from-zero walk (session-relative turn numbering — the
      // only kind whose indexes can pass the per_session_cursors gate) that
      // was not cut short by an append failure or the batch cap. A row-cap
      // bail does NOT block it: the cap is deterministic per content
      // version (a re-walk of the same bytes trips at the same line and
      // yields the same turns), so re-reading an unchanged capped file can
      // never ingest more; a version change forces a fresh read regardless.
      // Parse errors do NOT block it either — that is the point of R41.
      if (!readFailed) {
        perFileMeta[fileBase] = {
          size: fileSize,
          mtime_ms: fileMtimeMs,
          ingest_complete: walkedFrom === 0 && !appendFailed && !batchCapped,
          parse_error_tagged: parseErrorTagged,
        };
      }
    }

    // Persist cursor.
    const nowTs = this._now();
    // c3-cursor-stamp-class fix (ports telegram.js:255-264): bump
    // last_cursor_advance_ts ONLY when a per-session cursor or per-file offset
    // genuinely changed this poll. The prior unconditional `nowTs` stamped an
    // advance on EVERY poll — including the steady state this connector spends
    // almost all of its time in, where the unchanged-file skip above performs
    // ZERO reads — which refreshed the timestamp forever and defeated the
    // staleness classifiers (index.js _healthFromState :601,607-611 and
    // metadataFromState :701,707-711 compare this field against
    // CAPS.CONNECTOR_HEALTH_STALE_SECONDS).
    //
    // last_polled_ts stays unconditional (it means "we ran"); last_appended_ts
    // only moves on a real append.
    const carriedAdvanceTs =
      typeof state.last_cursor_advance_ts === "string" ? state.last_cursor_advance_ts : null;
    const nextState = {
      ...state,
      per_session_cursors: perSessionCursors,
      per_session_offsets: perSessionOffsets,
      per_session_file_meta: perFileMeta,
      last_polled_ts: nowTs,
      last_appended_ts: lastAppendedTs,
      last_appended_id: lastAppendedId,
      last_cursor_advance_ts: cursorAdvanced ? nowTs : carriedAdvanceTs,
      error_count: Number.isInteger(state.error_count) ? state.error_count : 0,
    };
    // Reload to pick up tagError increments.
    const reloaded = (await this.readCursor()) || {};
    if (Number.isInteger(reloaded.error_count) && reloaded.error_count >= nextState.error_count) {
      nextState.error_count = reloaded.error_count;
      nextState.last_error_kind = reloaded.last_error_kind;
      nextState.last_error_ts = reloaded.last_error_ts;
    }
    await this.writeCursor(nextState);

    return { appended: appendedCount, errors: errorCount, sessions: sessionsProcessed };
  }
}

// =============================================================================
// Helpers (module-private)
// =============================================================================

// extractText: pull all `text` / `input_text` / `output_text` strings out of
// a `content` array of the shape:
//   [ { type:"input_text", text:"..." }, { type:"output_text", text:"..." }, ... ]
// Strings are joined with "\n\n". Non-text content parts (image, tool_use,
// reasoning encrypted_content) are skipped — we want operator/assistant
// dialogue only at the ledger tier; richer payloads survive in raw_content.
function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const c of content) {
    if (c && typeof c === "object") {
      if (typeof c.text === "string" && c.text !== "") {
        parts.push(c.text);
      }
    }
  }
  return parts.join("\n\n");
}

// filenameToSessionId: best-effort session-id extraction from
// "rollout-<ISO>-<uuid>.jsonl". Returns null on shape mismatch (the caller
// then uses the filename verbatim as the cursor key).
function filenameToSessionId(fileBasename) {
  // rollout-2026-01-01T00-00-00-00000000-0000-4000-8000-000000000001.jsonl
  // The trailing UUID is the last 5 dash-separated groups before ".jsonl".
  const stripped = fileBasename.replace(/\.jsonl$/i, "");
  const parts = stripped.split("-");
  if (parts.length >= 5) {
    return parts.slice(-5).join("-");
  }
  return fileBasename;
}

// buildRow: assemble the connector-emitted source-ledger row from a paired
// turn. The base class stamps id / ts / source / source_policy / checksum
// at appendLedgerRow time; we set source_msg_id, parties, raw_content, and
// content here.
//
// F-T1-CODEX_CLI-F1: autoInjected is the connector-side scaffold-prefix
// tag. When true, raw_content.auto_injected = true is stamped on the row
// so Stage-0 (and any downstream consumer of the quarantine entry) can
// trust the flag without re-running the SCAFFOLD_USER_RE on every dispatch.
function buildRow({ sessionId, sessionFileBasename, turn, autoInjected, sessionCwd }) {
  const userText = typeof turn.user_text === "string" ? turn.user_text : "";
  const assistantText = typeof turn.assistant_text === "string" ? turn.assistant_text : "";
  const content = buildContent(userText, assistantText);
  const systemPromptHash = turn.developer_texts && turn.developer_texts.length > 0
    ? hashSystemPrompts(turn.developer_texts)
    : null;
  // F-NEW-W1-R43-CODEX-IMESSAGE-WIRING: stamp raw_content.sender_is_bot at
  // row-build time so the field is present on every codex-cli row in parity
  // with the imessage / github-events / git-log connectors. By construction
  // codex sessions only contain the literal parties "user" (operator) and
  // "assistant" (model); neither label matches the F-INFRA-R43 bot-actor
  // enumeration (dependabot, renovate, github-actions, claude[bot], ...).
  // We still route the authoring party through isBotActor so the field is
  // honestly derived (not hardcoded false) and so any future codex variant
  // that injects an automation identity into the party label propagates a
  // truthful signal. Authoring party for a paired turn is "user" — the
  // operator-typed half; assistant authorship lives separately in
  // assistant_text and is not classified here.
  const senderIsBot = isBotActor("user");
  // F-NEW-W3-CHAT-CC-CODEX-CWD-KEY-ASYMMETRY: stamp raw_content.cwd at
  // emit time so cross-source dedup against chat-claude-code rows actually
  // collides on the (cwd, content_sha256[:12]) key. Pre-W3 codex-cli rows
  // never carried cwd, which meant the chat-cc-side dedup index bucketed
  // every codex-cli row under the wildcard `*` while the chat-cc consumer
  // looked up under the real operator cwd — keys never matched. Priority:
  //   1. CODEX_CLI_FORCE_CWD env var (hermetic test override).
  //   2. session_meta.payload.cwd from the rollout file — the authoritative
  //      "the codex CLI was started here" path. The codex client writes
  //      this on session creation.
  //   3. process.cwd() (daemon fallback when older codex versions omit
  //      cwd from session_meta).
  // The chat-cc-side dedup is updated in tandem to fall back to a
  // cwd-agnostic secondary lookup when neither side surfaces a cwd, so
  // legacy ledgers (rows written before this fix) still participate in
  // the dedup contract via the (cwd='*', sha12) bucket.
  const cwdOverride = process.env.CODEX_CLI_FORCE_CWD;
  const cwd =
    typeof cwdOverride === "string" && cwdOverride.length > 0
      ? cwdOverride
      : (typeof sessionCwd === "string" && sessionCwd.length > 0
          ? sessionCwd
          : process.cwd());
  const rawContent = {
    conversation_id: sessionId,
    session_file: sessionFileBasename,
    turn_index: turn.turn_index,
    user_text: userText,
    assistant_text: assistantText,
    sender_is_bot: senderIsBot,
    cwd,
  };
  if (systemPromptHash !== null) {
    rawContent.system_prompt_hash = systemPromptHash;
  }
  if (autoInjected === true) {
    rawContent.auto_injected = true;
  }
  // F-CCS-CONNECTOR-codex-cli-structural: stamp structured_features at emit
  // time so the cascade does not have to re-derive conversation_id, cwd
  // basename, and turn ts from the joined user+assistant text. Defensive:
  // any throw from the helper is swallowed so a malformed row still emits
  // (cascade falls back to the text-extractor path — strict backwards-compat
  // per foundation spec §7). We pass `turn_ts` explicitly because raw_content
  // does NOT replicate the row-level ts; the structural emitter prefers
  // raw_content.turn_ts and falls back to raw_content.ts (which is what a
  // tail-read of the on-disk ledger sees).
  let structuredFeatures = null;
  try {
    structuredFeatures = buildStructuredFeatures({
      ...rawContent,
      turn_ts: typeof turn.ts === "string" ? turn.ts : undefined,
    });
  } catch {
    structuredFeatures = null;
  }
  return {
    source_msg_id: `codex:${sessionId}:${turn.turn_index}`,
    ts: typeof turn.ts === "string" ? turn.ts : undefined,
    parties: ["user", "assistant"],
    ...(structuredFeatures != null ? { structured_features: structuredFeatures } : {}),
    raw_content: rawContent,
    content,
  };
}

// buildContent: deterministic concatenation of user + assistant text for the
// `content` field. Matches the chat-claude-code shape:
//   "user: <...>\n\nassistant: <...>"
// Empty halves are omitted so a half-turn (Stage-0 will likely drop these)
// does not produce stray "assistant: " prefixes.
function buildContent(userText, assistantText) {
  const parts = [];
  if (userText) parts.push(`user: ${userText}`);
  if (assistantText) parts.push(`assistant: ${assistantText}`);
  return parts.join("\n\n");
}

// hashSystemPrompts: blake2b512 truncated to 16 hex chars over the joined
// developer-role texts. Keeps system-prompt provenance auditable without
// reproducing the (often token-heavy and PII-prone) prompt body on the
// ledger. Matches the truncation discipline used by the row checksum.
function hashSystemPrompts(texts) {
  const joined = texts.join("\n\n");
  return createHash("blake2b512").update(Buffer.from(joined, "utf8")).digest().subarray(0, 16).toString("hex");
}

// =============================================================================
// CLI / daemon entry points
// =============================================================================

// runOnce: invoke pollOnce once and exit. Used by --once and by the launchd
// plist's foreground execution.
export async function runOnce(opts = {}) {
  const c = new CodexCliConnector(opts);
  return c.pollOnce();
}

// runForever: poll loop with a fixed sleep between ticks. NOT used by the
// launchd plist (which uses StartInterval / KeepAlive throttle); exposed
// for manual operator debug sessions.
export async function runForever(opts = {}) {
  const intervalSec = Number.isInteger(opts.intervalSec) && opts.intervalSec > 0
    ? opts.intervalSec
    : 60;
  const c = new CodexCliConnector(opts);
  for (;;) {
    try { await c.pollOnce(); }
    catch { /* tagError already invoked; loop continues */ }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

// run: shorthand the task spec asks for — opts.once toggles single-tick
// vs forever. Equivalent to picking runOnce / runForever from a launcher.
export async function run(opts = {}) {
  if (opts && opts.once) return runOnce(opts);
  return runForever(opts);
}

// CLI surface: --check (report health), --once (single poll, exit), default
// is runForever.
export async function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--check")) {
    const c = new CodexCliConnector();
    const h = c.reportHealth();
    process.stdout.write(JSON.stringify(h) + "\n");
    return 0;
  }
  if (args.includes("--once")) {
    const res = await runOnce();
    process.stdout.write(JSON.stringify(res) + "\n");
    return 0;
  }
  await runForever();
  return 0;
}

// Run when invoked directly (node lib/connectors/codex-cli.js ...).
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`codex-cli fatal: ${err && err.stack ? err.stack : String(err)}\n`);
      process.exit(1);
    },
  );
}

// Test-only exports. Not part of the public surface; named with a leading
// underscore so consumers know they may move.
export const _internals = {
  expandGlob,
  segmentMatcher,
  extractText,
  filenameToSessionId,
  buildRow,
  buildContent,
  hashSystemPrompts,
  // F-T1-CODEX_CLI-F1 — surface the scaffold-detector + regex so unit
  // tests (and any operator-facing audit tool) can assert the same set of
  // prefixes the connector tags at write-time.
  SCAFFOLD_USER_RE,
  looksAutoInjectedUserText,
  // F-NEW-R40-CODEX-ERR-STRING-TOO-LONG — surface the chunk size so the
  // regression test can synthesize a session file that provably straddles
  // a read boundary (mid-chunk line split + split multi-byte character)
  // without hardcoding 8 MiB.
  READ_CHUNK_BYTES,
};

// Suppress unused-var lint for the `resolve` import — retained for future
// use during the shared-helper refactor (sibling agents' `_agent_runtime_tail.js`
// will likely surface a need to absolute-ify env-injected globs).
void resolve;

// F-NEW-R42-CONSUMER-MIGRATION / F-NEW-R43-CONNECTOR-WIRING — the
// canonical predicates are imported above so codex-cli participates in
// the same identity discipline as the rest of the connectors. isBotActor
// is now invoked from buildRow() to stamp raw_content.sender_is_bot at
// row-build time (F-NEW-W1-R43-CODEX-IMESSAGE-WIRING). isOperator,
// getOperatorIdentities, and BOT_ACTOR_REGEX remain imported as forward-
// compat hooks for any future agent-runtime source / shared-machine
// session future-proofing; the void-references suppress the unused-var
// lint without removing the imports.
void isOperator;
void getOperatorIdentities;
void BOT_ACTOR_REGEX;
