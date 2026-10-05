// conversation-index.js — WU-backward-conversation-index (Tier-0 backfill).
//
// PURPOSE:
//   Derive a per-fact conversation descriptor (conversation_id + human-ish
//   thread_label) for the EXISTING corpus of promoted facts — the Tier-0
//   material that context-prefix.js documents as 0% thread coverage today.
//
//   The forward-stamp fix (a parallel workunit) writes
//   provenance.conversation_id onto NEW facts at promote time. This module is
//   the BACKWARD half: it reconstructs the same descriptor for facts that were
//   promoted BEFORE the forward stamp existed (and which therefore carry
//   provenance.conversation_id === null).
//
// WHY THIS IS POSSIBLE (investigated against the live ledgers, 2026-06):
//   - The fact row carries source_refs[0].source_msg_id (100% coverage on the
//     1.46M-row live ledger — verified, 0 facts missing it).
//   - Every source ledger storage/sources/<source>.jsonl is strictly
//     append-only and joinable 1:1 on source_msg_id; the source row retains the
//     thread-bearing fields in raw_content (chat_guid / repo_path+author /
//     conversation_id / session_jid / repo).
//   - So fact_id -> source_msg_id -> source_row.raw_content -> bucket_key is a
//     pure left-join over retained data. NO fact row is mutated.
//
// THESIS #1 (NEVER mutate EXISTING fact rows): this is a DERIVED PROJECTION.
//   It builds a sidecar index keyed by fact_id; it never touches memory.jsonl.
//   The consumer (context-prefix.js) LEFT-JOINS this index at read/rebuild
//   time. Deleting the cache is always safe — the next call rebuilds it from
//   the (append-only) ledgers.
//
// BYTE-IDENTICAL DESCRIPTORS (forward == backward):
//   The descriptor we emit is `daemon:thread:<bucket_key>` — the exact shape
//   that thread-aggregator.js emits for reconstructed events and that
//   context-prefix.js readConversationId / deriveThreadLabel already parse.
//   We REUSE thread-aggregator.__internal.extractThreadKey (over a synthetic
//   fact-shaped object built from the source row's raw_content) so the
//   backward label and the forward/daemon label collide on the SAME
//   bucket_key. This is the spine of the plan: zero read-side label drift.
//
// SHAPE (mirrors entity-index.js — streamed rebuild, mtime+size cache,
//        VERSION + frozen CAPS):
//
//   rebuildConversationIndex({ ledgerPath, cachePath?, sourcesDir? }) -> async {
//     byFactId: Map<fact_id, { conversation_id, thread_label }>,
//     ledgerMtime: number,    // memory.jsonl mtimeMs at build time
//     ledgerSize: number,     // memory.jsonl size at build time
//     built_at: ISO-8601,
//     stats: { facts_seen, facts_joined, sources: {<source>: {seen, joined}} },
//   }
//
//   loadOrRebuildConversationIndex({ ledgerPath, cachePath?, sourcesDir? })
//     -> async <same shape>; cache hit iff schema + ledger_mtime_ms +
//        ledger_size_bytes all match (size guards macOS HFS+ 1s mtime
//        granularity, matching index-cache.js discipline).
//
//   lookupConversation(index, factId) -> { conversation_id, thread_label } | null
//
//   persistConversationIndex(index, cachePath) -> async void (atomic, 0600).
//
// CACHE FILE FORMAT (schema v1):
//   {
//     "schema_version": "v1",
//     "ledger_mtime_ms": <number>,
//     "ledger_size_bytes": <number>,
//     "built_at": "<ISO-8601>",
//     "stats": { ... },
//     "entries": { "<fact_id>": { "c": "<conversation_id>", "l": "<thread_label>" }, ... }
//   }
//   (short keys c/l keep the on-disk projection compact for ~1.4M facts.)
//
// DISCIPLINE: ESM, defensive try/catch around every fs op, streamed reads
//   (never readFileSync the 1.78GB ledger or the 508MB git-log source), Node
//   stdlib only. Never throws to a recall-time caller path; a corrupt cache
//   or a missing source ledger degrades to a smaller (or empty) index.

import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";

import { streamLedgerLines } from "./_ledger-stream.js";
import { __internal as threadInternal } from "./thread-aggregator.js";
import {
  sourceLedgerPath as defaultSourceLedgerPath,
  connectorStatePath,
} from "../config.js";
import {
  labelForSessionJid,
  loadOrBuildLabelMap,
  defaultChatStoragePath as defaultWhatsAppChatStoragePath,
  defaultWhatsAppStatePath,
} from "../connectors/whatsapp-name-recovery.js";
import { recoverImessageLabels } from "../connectors/_imessage-name-recovery.js";

/** Cache file schema version. Bump on any structural change to the on-disk
 *  shape. A schema mismatch on load triggers a full rebuild. */
export const CONVERSATION_INDEX_SCHEMA_VERSION = "v1";

export const CONVERSATION_INDEX_VERSION = "conversation-index@0.1.0";

// Frozen CAPS (mirror the THREAD_AGGREGATOR_CAPS / ENTITY_INDEX conventions).
export const CONVERSATION_INDEX_CAPS = Object.freeze({
  // The set of sources whose source rows carry a derivable thread key. This is
  // a SUPERSET of thread-aggregator's THREAD_BEARING_SOURCES because the
  // backward index can also join whatsapp (session_jid) — a source the daemon
  // aggregator does not currently thread, but whose source rows DO retain the
  // join field. screentime is deliberately omitted: its rows carry no
  // conversational thread key (only a signal stream).
  THREAD_BEARING_SOURCES: Object.freeze([
    "imessage",
    "whatsapp",
    "git-log",
    "github-events",
    "codex-cli",
    "chat-claude-code",
  ]),
  // Hard cap on a single source ledger's line size handed to the streamer
  // (defends against a pathological row). 8 MiB matches _ledger-stream's
  // default; pinned here so the CAP is auditable.
  MAX_SOURCE_LINE_BYTES: 8 * 1024 * 1024,
  // The descriptor prefix. MUST match thread-aggregator's
  // `daemon:thread:${bucket_key}` so forward + backward labels are
  // byte-identical and collide in the read path.
  CONVERSATION_ID_PREFIX: "daemon:thread:",
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Return {mtimeMs, size} for a path, or null if it does not exist. */
function statFingerprint(path) {
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size || 0 };
  } catch {
    return null;
  }
}

/**
 * deriveDescriptorFromSourceRow — given a retained source row, derive the
 * conversation descriptor `{ conversation_id, thread_label }` (or null when no
 * stable key is derivable).
 *
 * Strategy (per the WU plan): build a synthetic fact-shaped object that feeds
 * thread-aggregator.extractThreadKey, so the bucket_key is byte-identical to
 * the daemon/forward path. extractThreadKey reads:
 *   - fact.source         (the connector name)
 *   - fact.ts             (for the day bucket)
 *   - fact.raw_content    (the thread-bearing fields)
 *   - fact.provenance.conversation_id (last-resort)
 * The source row carries `source`, `ts`, and `raw_content` directly, so we
 * pass it through (a source row IS already fact-shaped enough for
 * extractThreadKey's readRawContent: it has a sibling `raw_content` object).
 *
 * Returns null on any failure (defensive — a malformed source row must never
 * abort the rebuild).
 */
function deriveDescriptorFromSourceRow(sourceRow, opts = {}) {
  if (sourceRow == null || typeof sourceRow !== "object") return null;

  // github-events SPECIAL-CASE (WU-github-join-recovery).
  //   thread-aggregator.extractThreadKey shares one branch for
  //   git-log + github-events and REQUIRES both a repo AND an author_email.
  //   git-log rows carry author_email per commit; github-events rows NEVER do
  //   — the github-events connector persists `repo` + a login surface
  //   (actor_login / pr_author / issue_author / member_login), not a commit
  //   author email. So extractThreadKey returns null for every github-events
  //   row and the whole source joined at 0% (the bug this WU closes).
  //
  //   github-events is also NOT threaded by the forward/daemon path for the
  //   same reason, so there is NO existing forward bucket_key to collide with
  //   — we are free to define the canonical github-events thread key here. The
  //   repo IS the conversation surface (a repo's activity stream), so we
  //   thread on `repo` alone: `repo:<repo>:day:<day>`. This stays inside this
  //   module's owned surface (label derivation) and never touches the shared
  //   thread-aggregator or the parallel-owned recall path.
  if (sourceRow.source === "github-events") {
    return deriveGithubEventsDescriptor(sourceRow);
  }

  let key;
  try {
    key = threadInternal.extractThreadKey(sourceRow);
  } catch {
    return null;
  }
  if (key == null || typeof key.bucket_key !== "string" || key.bucket_key.length === 0) {
    return null;
  }
  const conversation_id = CONVERSATION_INDEX_CAPS.CONVERSATION_ID_PREFIX + key.bucket_key;

  // WhatsApp HUMAN-NAME RECOVERY (WU-whatsapp-name-recovery).
  //   The bucket_key (and thus conversation_id) MUST stay byte-identical to
  //   the forward/daemon path — it threads on the raw session_jid. ONLY the
  //   human-readable thread_label is enriched: when a recovered label map is
  //   supplied AND it resolves this session_jid, we render the contact / group
  //   name ("Mom 2026-06-22", "Group: Soccer Parents 2026-06-22") instead of
  //   the opaque JID. On a miss we fall back to the current JID-based label so
  //   behavior is strictly additive. The recovered name is PII and lives only
  //   in this local derived index.
  if (key.source === "whatsapp") {
    const sessionJid = typeof key.thread_id === "string" ? key.thread_id : null;
    // Prefer the FORWARD-captured session_label on the source row itself (NEW
    // rows the enriched connector stamped), then the side-table recovery map
    // (BACKWARD: historical rows whose source predates the forward stamp).
    const rc = readRawContentLocal(sourceRow);
    const forwardLabel =
      rc && typeof rc.session_label === "string" ? collapseWs(rc.session_label) : null;
    const human =
      forwardLabel !== null
        ? forwardLabel
        : labelForSessionJid(opts && opts.whatsappLabelMap, sessionJid);
    if (human !== null) {
      const day = typeof key.day === "string" ? key.day : null;
      const thread_label = day !== null ? collapseWs(`${human} ${day}`) : collapseWs(human);
      return { conversation_id, thread_label };
    }
  }

  // iMessage HUMAN-NAME RECOVERY (WU-imessage-name-recovery).
  //   Symmetric to the WhatsApp branch above. The bucket_key / conversation_id
  //   stay byte-identical to the forward/daemon path (they thread on the raw
  //   chat_guid via thread-aggregator). ONLY the human-readable thread_label is
  //   enriched: when a recovered label map (chat_guid -> human label) is
  //   supplied AND it resolves this thread's chat_guid (== key.thread_id for
  //   imessage), we render the contact / group name ("Alex Example 2026-06-22",
  //   "Group: Sam Sample, Jo Placeholder, Kit Specimen 2026-06-22") instead of the opaque
  //   chat_guid. On a miss we fall back to the chat_guid-based label so the
  //   behavior is strictly additive. The recovered name is PII and lives only
  //   in this local derived index.
  if (key.source === "imessage") {
    const labelMap = opts && opts.imessageLabelMap;
    const chatGuid = typeof key.thread_id === "string" ? key.thread_id : null;
    const human =
      labelMap instanceof Map && chatGuid !== null
        ? collapseWs(labelMap.get(chatGuid))
        : null;
    if (human !== null) {
      const day = typeof key.day === "string" ? key.day : null;
      const thread_label =
        day !== null ? collapseWs(`${human} ${day}`) : human;
      return { conversation_id, thread_label };
    }
  }

  const thread_label = deriveBackwardThreadLabel(key);
  return { conversation_id, thread_label };
}

/**
 * deriveGithubEventsDescriptor — derive the conversation descriptor for a
 * github-events row (or a github-events fact in the content-fallback path).
 *
 * Thread key: `repo:<repo>:day:<day>` → conversation_id
 *   `daemon:thread:repo:<repo>:day:<day>`.
 *
 * Label: the repo is the descriptive head; when the row references a single PR
 * or Issue we sharpen the label to `<repo> PR #<n>` / `<repo> issue #<n>` so
 * the per-PR/issue conversation reads naturally (per the WU plan). The
 * conversation_id stays repo-day scoped (one thread per repo per day) so all
 * activity on a repo on a day collapses into one conversation regardless of
 * which PR/issue line item it was — the LABEL carries the finer surface.
 *
 * Works on BOTH a source row (raw_content sibling, the join path) AND a fact
 * row (the content-fallback path) because it reads `raw_content` via the same
 * resolver thread-aggregator uses; when the github-events SOURCE row is
 * genuinely missing, the caller can hand us the FACT row and we still recover
 * the repo label from the fact's own retained raw_content.
 *
 * Returns null when no `repo` is derivable (no stable key).
 */
function deriveGithubEventsDescriptor(row) {
  if (row == null || typeof row !== "object") return null;
  const day = dayBucketSafe(row.ts);
  if (day === null) return null;

  const rc = readRawContentLocal(row);

  // repo is the join key. Accept the canonical `repo` plus the legacy
  // `repo_path` / `repo_name` aliases for symmetry with extractThreadKey.
  const repo =
    (rc && typeof rc.repo === "string" && rc.repo) ||
    (rc && typeof rc.repo_path === "string" && rc.repo_path) ||
    (rc && typeof rc.repo_name === "string" && rc.repo_name) ||
    null;
  if (!repo) return null;

  const conversation_id =
    CONVERSATION_INDEX_CAPS.CONVERSATION_ID_PREFIX + `repo:${repo}:day:${day}`;

  // Sharpen the label with a PR/issue surface when present.
  let head = repo;
  if (rc) {
    const prNum = positiveIntOrNull(rc.pr_number);
    const issueNum = positiveIntOrNull(rc.issue_number);
    if (prNum !== null) {
      head = `${repo} PR #${prNum}`;
    } else if (issueNum !== null) {
      head = `${repo} issue #${issueNum}`;
    }
  }
  const thread_label = collapseWs(`${head} ${day}`);
  return { conversation_id, thread_label };
}

/** Read raw_content from a row, mirroring thread-aggregator.readRawContent's
 *  precedence (sibling -> source_refs[0] -> features) without importing a
 *  non-exported helper. */
function readRawContentLocal(row) {
  if (row == null || typeof row !== "object") return null;
  if (row.raw_content && typeof row.raw_content === "object") return row.raw_content;
  if (Array.isArray(row.source_refs) && row.source_refs.length > 0) {
    const ref0 = row.source_refs[0];
    if (ref0 && typeof ref0 === "object" && ref0.raw_content && typeof ref0.raw_content === "object") {
      return ref0.raw_content;
    }
  }
  if (row.features && typeof row.features === "object") {
    const rc = row.features.raw_content;
    if (rc && typeof rc === "object") return rc;
  }
  return null;
}

/** YYYY-MM-DD day bucket from an ISO ts, or null when unparseable. Matches
 *  thread-aggregator's dayBucket output for valid timestamps. */
function dayBucketSafe(ts) {
  if (typeof ts !== "string" || ts.length === 0) return null;
  const d = new Date(ts);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  return d.toISOString().slice(0, 10);
}

/** A positive integer (1,2,3,...) or null. Rejects 0, negatives, non-ints,
 *  and non-numbers (the connector stamps pr_number/issue_number as numbers; a
 *  null/absent field returns null). */
function positiveIntOrNull(v) {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) return null;
  return v;
}

/**
 * deriveBackwardThreadLabel — a short human-ish descriptor from the thread key.
 * Mirrors context-prefix.deriveThreadLabel's OUTPUT for the same bucket_key
 * (the most-descriptive tokens), but is computed from the structured key
 * directly (no string re-parse). Kept consistent so the label stored in the
 * index equals what context-prefix would derive if it parsed our
 * conversation_id — letting the consumer use EITHER our stored label or its own
 * derivation interchangeably.
 *   imessage:        "<chat/party id> <day>"
 *   git-log/github:  "<repo> <day>"
 *   generic:         "<thread_id> <day>"
 */
function deriveBackwardThreadLabel(key) {
  if (key == null || typeof key !== "object") return null;
  const day = typeof key.day === "string" ? key.day : null;
  const src = typeof key.source === "string" ? key.source : null;
  let head = null;
  if (src === "git-log" || src === "github-events") {
    // thread_id is "<repo>::<author>"; the repo is the descriptive head.
    const tid = typeof key.thread_id === "string" ? key.thread_id : "";
    const sep = tid.indexOf("::");
    head = sep > 0 ? tid.slice(0, sep) : tid;
  } else {
    head = typeof key.thread_id === "string" ? key.thread_id : null;
  }
  head = collapseWs(head);
  if (head === null && day === null) return null;
  if (head === null) return day;
  if (day === null) return head;
  return collapseWs(`${head} ${day}`);
}

function collapseWs(s) {
  if (typeof s !== "string") return null;
  const out = s.replace(/\s+/g, " ").trim();
  return out.length > 0 ? out : null;
}

/**
 * collectSourceMsgIdsByFact — PASS 1a: stream the memory ledger once and build
 *   factId -> { source, source_msg_id }
 * for every fact row that carries a join key in a thread-bearing source. We
 * also track which (source, source_msg_id) pairs we actually need, so PASS 1b
 * only retains the descriptors we will join (bounding memory).
 *
 * For github-events facts we ALSO capture a content-fallback descriptor
 * derived from the FACT row's own retained raw_content/features, so a fact
 * whose github-events SOURCE row is genuinely missing still resolves a repo
 * label (the WU fallback requirement). The fallback is only USED in PASS 2
 * when the source-row join produced nothing.
 *
 * Returns { factToRef, neededBySource, factFallback, stats }.
 */
function collectSourceMsgIdsByFact(ledgerPath) {
  const factToRef = new Map(); // fact_id -> { source, source_msg_id }
  const neededBySource = new Map(); // source -> Set<source_msg_id>
  const factFallback = new Map(); // fact_id -> descriptor (github-events only)
  const bearing = new Set(CONVERSATION_INDEX_CAPS.THREAD_BEARING_SOURCES);
  const stats = { facts_seen: 0, facts_with_ref: 0 };

  if (!existsSync(ledgerPath)) {
    return { factToRef, neededBySource, factFallback, stats };
  }

  streamLedgerLines(ledgerPath, (row) => {
    try {
      if (row == null || typeof row !== "object") return;
      if (row.kind !== "fact") return;
      const factId = row.id;
      if (typeof factId !== "string" || factId.length === 0) return;
      stats.facts_seen += 1;

      const refs = Array.isArray(row.source_refs) ? row.source_refs : [];
      // Use the FIRST ref that has a usable (source, source_msg_id) in a
      // thread-bearing source. Facts almost always have exactly one ref; we
      // prefer the row.source's own ref when present.
      let chosen = null;
      for (const ref of refs) {
        if (ref == null || typeof ref !== "object") continue;
        const src = typeof ref.source === "string" ? ref.source : null;
        const smid =
          typeof ref.source_msg_id === "string" && ref.source_msg_id.length > 0
            ? ref.source_msg_id
            : null;
        if (src === null || smid === null) continue;
        if (!bearing.has(src)) continue;
        chosen = { source: src, source_msg_id: smid };
        // Prefer the ref whose source matches the fact's own source.
        if (src === row.source) break;
      }
      if (chosen === null) return;

      factToRef.set(factId, chosen);
      stats.facts_with_ref += 1;
      let set = neededBySource.get(chosen.source);
      if (set === undefined) {
        set = new Set();
        neededBySource.set(chosen.source, set);
      }
      set.add(chosen.source_msg_id);

      // github-events CONTENT-FALLBACK: capture a descriptor derived from the
      // fact row itself (its own retained raw_content/features carries `repo`
      // for WU-A2-era facts). Used in PASS 2 only when the source-row join
      // misses (e.g. a quarantined / pruned source row). Cheap: only computed
      // for github-events facts.
      if (chosen.source === "github-events") {
        const fb = deriveGithubEventsDescriptor(row);
        if (fb !== null) factFallback.set(factId, fb);
      }
    } catch {
      // A single malformed row must never abort the rebuild.
    }
  });

  return { factToRef, neededBySource, factFallback, stats };
}

/**
 * buildDescriptorsForSource — PASS 1b: stream ONE source ledger once and build
 *   source_msg_id -> { conversation_id, thread_label }
 * for ONLY the source_msg_ids in `needed` (so we never retain descriptors for
 * source rows no fact references). Bounded to needed.size entries.
 */
function buildDescriptorsForSource(sourcePath, needed, opts = {}) {
  const out = new Map(); // source_msg_id -> descriptor
  if (!(needed instanceof Set) || needed.size === 0) return out;
  if (typeof sourcePath !== "string" || !existsSync(sourcePath)) return out;

  let remaining = needed.size;
  streamLedgerLines(
    sourcePath,
    (row) => {
      try {
        if (remaining === 0) return;
        if (row == null || typeof row !== "object") return;
        const smid =
          typeof row.source_msg_id === "string" && row.source_msg_id.length > 0
            ? row.source_msg_id
            : null;
        if (smid === null) return;
        if (!needed.has(smid)) return;
        if (out.has(smid)) return; // first occurrence wins (append-only)
        const desc = deriveDescriptorFromSourceRow(row, opts);
        // Even when desc is null (no derivable key) we mark it resolved so we
        // stop scanning early; null descriptors are simply not joined later.
        out.set(smid, desc);
        remaining -= 1;
      } catch {
        // Defensive: skip the malformed source row, keep scanning.
      }
    },
    { maxLineBytes: CONVERSATION_INDEX_CAPS.MAX_SOURCE_LINE_BYTES },
  );
  return out;
}

function emptyStats() {
  return {
    facts_seen: 0,
    facts_joined: 0,
    sources: {},
  };
}

/**
 * isProductionRoot — true ONLY when the configured MEMORY_ROOT is the install's
 * own root, i.e. the checkout that contains mcp/ (config.js CHECKOUT_ROOT, the
 * default data root). Hermetic tests point MEMORY_ROOT at a tmpdir, so
 * this returns false there. The live-DB auto-load gates on this so a hermetic
 * test NEVER opens the operator's real ChatStorage.sqlite (HERMETICITY
 * discipline). When false, recovery silently degrades to an empty map and the
 * WhatsApp label falls back to the JID-based descriptor — exactly what a test
 * (which injects its own map when it wants one) expects.
 */
async function isProductionRoot() {
  try {
    const cfg = await import("../config.js");
    return cfg.MEMORY_ROOT === cfg.CHECKOUT_ROOT;
  } catch {
    return false;
  }
}

/**
 * resolveWhatsAppLabelMapDefensively — load/build the session_jid -> human
 * label map from the live ChatStorage.sqlite, caching it into the WhatsApp
 * connector's state.json. EVERY failure mode (no config, no DB, FDA denied,
 * node:sqlite unavailable) degrades to an empty Map — a rebuild of the
 * conversation-index must NEVER fail because WhatsApp name recovery could not
 * run. Returns Map (possibly empty), never throws.
 *
 * HERMETICITY: only opens the live ChatStorage.sqlite under the real production
 * MEMORY_ROOT. Under a hermetic test root it returns an empty map without
 * touching ~/Library. Tests that want a populated map inject it via
 * rebuildConversationIndex({ whatsappLabelMap }).
 */
async function resolveWhatsAppLabelMapDefensively() {
  try {
    if (!(await isProductionRoot())) return new Map();
    const chatStoragePath = await defaultWhatsAppChatStoragePath();
    const statePath = await defaultWhatsAppStatePath();
    const { map } = await loadOrBuildLabelMap({ chatStoragePath, statePath });
    return map instanceof Map ? map : new Map();
  } catch {
    return new Map();
  }
}

/**
 * resolveImessageLabelMapDefensively — load/build the chat_guid -> human label
 * map from the live chat.db + AddressBook, caching it into the imessage
 * connector's state.json (re-resolved on a source-db mtime change). EVERY
 * failure mode (no chat.db, FDA/TCC denied for AddressBook, node:sqlite
 * unavailable) degrades to an empty Map — a rebuild of the conversation-index
 * must NEVER fail because iMessage name recovery could not run. Returns a Map
 * (possibly empty), never throws. Symmetric to the WhatsApp helper above.
 */
async function resolveImessageLabelMapDefensively() {
  try {
    // HERMETICITY (shared gate, added by WU-whatsapp-name-recovery): only open
    // the live chat.db / AddressBook under the real production MEMORY_ROOT. A
    // hermetic test (tmpdir MEMORY_ROOT) returns an empty map and falls back to
    // the chat_guid label — so the join test stays deterministic and never
    // reads ~/Library. Tests that want a populated iMessage map inject it via
    // rebuildConversationIndex({ imessageLabelMap }).
    if (!(await isProductionRoot())) return new Map();
    const statePath = connectorStatePath("imessage");
    const { byChatGuid } = await recoverImessageLabels({ statePath });
    return byChatGuid instanceof Map ? byChatGuid : new Map();
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Rebuild the conversation index by joining facts to their retained source
 * rows. Optionally persist to `cachePath`.
 *
 * @param {object} opts
 * @param {string} opts.ledgerPath — absolute path to memory.jsonl
 * @param {string} [opts.cachePath] — when set, the rebuilt index is persisted
 * @param {(source:string)=>string} [opts.sourceLedgerPath] — resolver for a
 *        source ledger path (defaults to config.sourceLedgerPath). Test hook.
 * @param {Map} [opts.whatsappLabelMap] — pre-resolved session_jid -> label map
 *        (WU-whatsapp-name-recovery). Test hook + injection point. When OMITTED,
 *        the map is loaded/built from the live ChatStorage.sqlite (cached in the
 *        connector state.json) — but ONLY when a whatsapp fact is actually
 *        present, and any failure degrades to an empty map (JID-label fallback).
 * @param {Map} [opts.imessageLabelMap] — pre-resolved chat_guid -> label map
 *        (WU-imessage-name-recovery). Test hook + injection point. When OMITTED,
 *        the map is loaded/built from the live chat.db + AddressBook (cached in
 *        the imessage connector state.json) — but ONLY when an imessage fact is
 *        actually present, and any failure degrades to an empty map (chat_guid
 *        label fallback).
 * @returns {Promise<{
 *   byFactId: Map<string, {conversation_id:string, thread_label:string|null}>,
 *   ledgerMtime: number, ledgerSize: number, built_at: string, stats: object,
 * }>}
 */
export async function rebuildConversationIndex({
  ledgerPath,
  cachePath,
  sourceLedgerPath,
  whatsappLabelMap,
  imessageLabelMap,
} = {}) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    throw new TypeError("rebuildConversationIndex: ledgerPath required");
  }
  const resolveSource =
    typeof sourceLedgerPath === "function"
      ? sourceLedgerPath
      : defaultSourceLedgerPath;

  const byFactId = new Map();
  const stats = emptyStats();

  // PASS 1a — fact -> ref, the set of source_msg_ids we must resolve, and the
  // per-fact github-events content-fallback descriptors.
  const { factToRef, neededBySource, factFallback, stats: refStats } =
    collectSourceMsgIdsByFact(ledgerPath);
  stats.facts_seen = refStats.facts_seen;

  // WhatsApp name recovery: resolve session_jid -> human label ONCE for the
  // whole rebuild. Use the caller-injected map when present (test hook);
  // otherwise build it lazily from the live ChatStorage.sqlite — but ONLY when
  // a whatsapp fact actually needs it (no DB open on a whatsapp-free corpus).
  // Any failure (no DB, FDA denied, sqlite missing) degrades to an empty map,
  // so the WhatsApp label silently falls back to the JID-based descriptor.
  let waLabelMap = whatsappLabelMap instanceof Map ? whatsappLabelMap : null;
  if (waLabelMap === null && neededBySource.has("whatsapp")) {
    waLabelMap = await resolveWhatsAppLabelMapDefensively();
  }

  // iMessage name recovery: resolve chat_guid -> human label ONCE for the whole
  // rebuild. Use the caller-injected map when present (test hook); otherwise
  // build it lazily from the live chat.db + AddressBook — but ONLY when an
  // imessage fact actually needs it (no chat.db / AddressBook open on an
  // imessage-free corpus). Any failure (no DB, TCC/FDA denied, sqlite missing)
  // degrades to an empty map, so the imessage label silently falls back to the
  // chat_guid-based descriptor.
  let imLabelMap = imessageLabelMap instanceof Map ? imessageLabelMap : null;
  if (imLabelMap === null && neededBySource.has("imessage")) {
    imLabelMap = await resolveImessageLabelMapDefensively();
  }

  // PASS 1b — for each source, build source_msg_id -> descriptor (bounded to
  // the needed set), then join.
  const descBySource = new Map(); // source -> Map<source_msg_id, descriptor>
  for (const [source, needed] of neededBySource) {
    let sourcePath;
    try {
      sourcePath = resolveSource(source);
    } catch {
      sourcePath = null;
    }
    const descMap =
      sourcePath != null
        ? buildDescriptorsForSource(sourcePath, needed, {
            whatsappLabelMap: waLabelMap,
            imessageLabelMap: imLabelMap,
          })
        : new Map();
    descBySource.set(source, descMap);
    stats.sources[source] = { seen: needed.size, joined: 0 };
  }

  // PASS 2 — left-join fact -> descriptor. github-events facts fall back to the
  // fact-derived descriptor when the SOURCE-row join produced nothing (missing
  // source row, or a source row with no derivable repo).
  for (const [factId, ref] of factToRef) {
    const descMap = descBySource.get(ref.source);
    let desc = descMap === undefined ? null : descMap.get(ref.source_msg_id) || null;
    if (desc == null && ref.source === "github-events") {
      const fb = factFallback.get(factId);
      if (fb != null) desc = fb; // content-fallback (no source row matched)
    }
    if (desc == null) continue; // no source row matched OR no derivable key
    byFactId.set(factId, {
      conversation_id: desc.conversation_id,
      thread_label: desc.thread_label,
    });
    stats.facts_joined += 1;
    const s = stats.sources[ref.source];
    if (s) s.joined += 1;
  }

  const fp = statFingerprint(ledgerPath);
  const ledgerMtime = fp ? fp.mtimeMs : 0;
  const ledgerSize = fp ? fp.size : 0;
  const built_at = new Date().toISOString();
  const index = { byFactId, ledgerMtime, ledgerSize, built_at, stats };

  if (typeof cachePath === "string" && cachePath.length > 0) {
    await persistConversationIndex(index, cachePath);
  }
  return index;
}

/**
 * Load the conversation index from cache if consistent with the ledger's
 * current mtime AND size; otherwise rebuild (and persist when cachePath set).
 *
 * "Consistent" = cache exists + parses + schema matches + ledger_mtime_ms ===
 * current mtime + ledger_size_bytes === current size. The size check guards
 * against macOS HFS+ 1s mtime granularity masking a same-second append.
 *
 * @param {object} opts — same as rebuildConversationIndex.
 * @returns {Promise<same shape as rebuildConversationIndex>}
 */
export async function loadOrRebuildConversationIndex({
  ledgerPath,
  cachePath,
  sourceLedgerPath,
  whatsappLabelMap,
  imessageLabelMap,
} = {}) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    throw new TypeError("loadOrRebuildConversationIndex: ledgerPath required");
  }
  const fp = statFingerprint(ledgerPath);

  if (
    typeof cachePath === "string" &&
    cachePath.length > 0 &&
    existsSync(cachePath)
  ) {
    try {
      const raw = readFileSync(cachePath, "utf8");
      const parsed = JSON.parse(raw);
      const schemaOk =
        parsed && parsed.schema_version === CONVERSATION_INDEX_SCHEMA_VERSION;
      const mtimeOk =
        fp != null && parsed && parsed.ledger_mtime_ms === fp.mtimeMs;
      const sizeOk =
        fp != null && parsed && parsed.ledger_size_bytes === fp.size;
      // Cold-start round-trip: ledger missing AND the cache claims 0/0.
      const coldStartOk =
        fp == null &&
        parsed &&
        parsed.ledger_mtime_ms === 0 &&
        parsed.ledger_size_bytes === 0;
      if (schemaOk && ((mtimeOk && sizeOk) || coldStartOk)) {
        return {
          byFactId: deserializeEntries(parsed.entries),
          ledgerMtime: parsed.ledger_mtime_ms,
          ledgerSize: parsed.ledger_size_bytes,
          built_at:
            typeof parsed.built_at === "string"
              ? parsed.built_at
              : new Date().toISOString(),
          stats:
            parsed.stats && typeof parsed.stats === "object"
              ? parsed.stats
              : emptyStats(),
        };
      }
    } catch {
      // Corrupt cache → fall through to rebuild. Never block on a derived cache.
    }
  }

  return rebuildConversationIndex({
    ledgerPath,
    cachePath,
    sourceLedgerPath,
    whatsappLabelMap,
    imessageLabelMap,
  });
}

/**
 * loadConversationIndexFromCacheSync — SYNCHRONOUS, CACHE-ONLY load.
 *
 * For sync consumers (bm25-rebuild's contextual prefix path runs inside a
 * synchronous streamLedgerLines callback and cannot await). Reads ONLY the
 * cache file; it NEVER rebuilds (rebuilding the full 1.5M-fact join is the
 * out-of-band build-conversation-index.mjs script's job — doing it here would
 * stall the BM25 rebuild). Returns the deserialized index when the cache is
 * present + schema-valid + fingerprint-consistent with the ledger; otherwise
 * returns null so the caller degrades to its non-indexed behavior.
 *
 * @param {object} opts
 * @param {string} opts.ledgerPath — used for the mtime+size consistency check.
 * @param {string} opts.cachePath
 * @param {boolean} [opts.requireFresh=true] — when false, a schema-valid cache
 *        is accepted even if the ledger fingerprint diverged (a stale but
 *        usable projection; the BM25 rebuild may legitimately want the labels
 *        for the rows that DID exist at index-build time). Defaults to true
 *        (strict), matching loadOrRebuildConversationIndex.
 * @returns {{byFactId: Map, ledgerMtime:number, ledgerSize:number,
 *            built_at:string, stats:object} | null}
 */
export function loadConversationIndexFromCacheSync({
  ledgerPath,
  cachePath,
  requireFresh = true,
} = {}) {
  if (typeof cachePath !== "string" || cachePath.length === 0) return null;
  if (!existsSync(cachePath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || parsed.schema_version !== CONVERSATION_INDEX_SCHEMA_VERSION) {
    return null;
  }
  if (requireFresh) {
    const fp =
      typeof ledgerPath === "string" && ledgerPath.length > 0
        ? statFingerprint(ledgerPath)
        : null;
    const mtimeOk = fp != null && parsed.ledger_mtime_ms === fp.mtimeMs;
    const sizeOk = fp != null && parsed.ledger_size_bytes === fp.size;
    const coldStartOk =
      fp == null &&
      parsed.ledger_mtime_ms === 0 &&
      parsed.ledger_size_bytes === 0;
    if (!((mtimeOk && sizeOk) || coldStartOk)) return null;
  }
  return {
    byFactId: deserializeEntries(parsed.entries),
    ledgerMtime: parsed.ledger_mtime_ms,
    ledgerSize: parsed.ledger_size_bytes,
    built_at:
      typeof parsed.built_at === "string"
        ? parsed.built_at
        : new Date().toISOString(),
    stats:
      parsed.stats && typeof parsed.stats === "object"
        ? parsed.stats
        : emptyStats(),
  };
}

/**
 * lookupConversation — resolve a fact_id to its conversation descriptor.
 * Returns null on a miss (never throws on a miss). Defensive copy.
 *
 * @param {{byFactId: Map<string, object>}} index
 * @param {string} factId
 * @returns {{conversation_id:string, thread_label:string|null} | null}
 */
export function lookupConversation(index, factId) {
  if (index == null || !(index.byFactId instanceof Map)) {
    throw new TypeError("lookupConversation: index missing byFactId Map");
  }
  if (typeof factId !== "string" || factId.length === 0) return null;
  const hit = index.byFactId.get(factId);
  if (hit == null) return null;
  return {
    conversation_id: hit.conversation_id,
    thread_label:
      typeof hit.thread_label === "string" ? hit.thread_label : null,
  };
}

/**
 * Persist the index to a cache file. tmp + rename (atomic), mode 0600.
 *
 * @param {{byFactId: Map, ledgerMtime:number, ledgerSize:number, built_at:string, stats:object}} index
 * @param {string} cachePath
 * @returns {Promise<void>}
 */
export async function persistConversationIndex(index, cachePath) {
  if (index == null || !(index.byFactId instanceof Map)) {
    throw new TypeError("persistConversationIndex: index missing byFactId Map");
  }
  if (typeof cachePath !== "string" || cachePath.length === 0) {
    throw new TypeError("persistConversationIndex: cachePath required");
  }

  const payload = {
    schema_version: CONVERSATION_INDEX_SCHEMA_VERSION,
    ledger_mtime_ms:
      typeof index.ledgerMtime === "number" ? index.ledgerMtime : 0,
    ledger_size_bytes:
      typeof index.ledgerSize === "number" ? index.ledgerSize : 0,
    built_at:
      typeof index.built_at === "string"
        ? index.built_at
        : new Date().toISOString(),
    stats:
      index.stats && typeof index.stats === "object"
        ? index.stats
        : emptyStats(),
    entries: serializeEntries(index.byFactId),
  };

  const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
  const bytes = JSON.stringify(payload);
  writeFileSync(tmpPath, bytes, { mode: 0o600 });
  renameSync(tmpPath, cachePath);
}

/**
 * Serialize Map<fact_id, {conversation_id, thread_label}> → compact object.
 * Short keys c/l keep the file small at ~1.4M entries.
 */
function serializeEntries(byFactId) {
  const out = {};
  for (const [k, v] of byFactId) {
    if (v == null || typeof v.conversation_id !== "string") continue;
    out[k] = {
      c: v.conversation_id,
      l: typeof v.thread_label === "string" ? v.thread_label : null,
    };
  }
  return out;
}

/** Deserialize the compact object back into a Map. Tolerant of tampering. */
function deserializeEntries(entries) {
  const map = new Map();
  if (entries == null || typeof entries !== "object") return map;
  for (const k of Object.keys(entries)) {
    const v = entries[k];
    if (v == null || typeof v !== "object") continue;
    const c = typeof v.c === "string" && v.c.length > 0 ? v.c : null;
    if (c === null) continue;
    map.set(k, {
      conversation_id: c,
      thread_label: typeof v.l === "string" ? v.l : null,
    });
  }
  return map;
}

// Test-only surface — internal helpers exposed so the WU suite can unit-test
// the join/derivation pipeline without reconstructing whole ledgers.
export const __internal = Object.freeze({
  deriveDescriptorFromSourceRow,
  deriveGithubEventsDescriptor,
  deriveBackwardThreadLabel,
  collectSourceMsgIdsByFact,
  buildDescriptorsForSource,
  resolveWhatsAppLabelMapDefensively,
  serializeEntries,
  deserializeEntries,
  statFingerprint,
});
