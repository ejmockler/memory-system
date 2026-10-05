// context-prefix.js — WU1-context-prefix-and-contextual-bm25 (Tier-0).
//
// PURPOSE:
//   Build a deterministic, pure, defensive THREAD-FIRST context prefix for a
//   fact row. The prefix is concatenated onto row.content before BM25
//   tokenization (contextual BM25, Anthropic-cookbook-style "contextual
//   retrieval", adapted): a short natural-language descriptor that situates an
//   otherwise-anaphoric atomic fact ("yea sure", "remove excess console logs")
//   in its conversation / project / entity context so a query term that the
//   fact omitted (because a human used a pronoun) still matches via BM25.
//
// WHY THIS SHAPE (ground truth, investigated against the live 1.78GB ledger):
//   The cookbook situates a chunk with an LLM call per chunk. We are FULLY
//   LOCAL and additive: the prefix is derived DETERMINISTICALLY from fields
//   that already exist on the promoted fact row. Investigation findings that
//   drive the resolution order below:
//
//     - provenance.conversation_id is NULL on ~100% of promoted fact rows.
//     - features.thread does NOT exist on any fact row.
//     - source_refs carry NO thread/conversation key (only source_msg_id).
//     - The thread-aggregator derives thread keys from `raw_content`
//       (chat_identifier / repo_path / author_email), but raw_content does
//       NOT survive onto the promoted fact row — it lives only on the daemon's
//       in-window stream. So there is NO resolvable thread TITLE or stable
//       thread id on a standalone fact row.
//     - There is NO conversation registry / title store anywhere in the repo
//       (thread-aggregator emits reconstructed *events*, not a title index).
//
//   UPDATE (WU-backward-conversation-index): the third bullet above is now
//   ADDRESSED by a DERIVED projection rather than by mutating fact rows. The
//   backward conversation-index (lib/synthesis/conversation-index.js) joins
//   each fact's source_refs[].source_msg_id to its retained, append-only
//   source row (storage/sources/<source>.jsonl) and derives the SAME
//   `daemon:thread:<bucket_key>` descriptor the daemon aggregator emits
//   (reusing thread-aggregator.extractThreadKey, so labels are byte-identical).
//   When a caller threads that index into buildContextPrefix(row, opts), the
//   resolution order below gains a REAL thread label for facts that join — the
//   historical 0% coverage rises to whatever fraction of facts have a
//   thread-bearing, joinable source row. Thesis #1 is preserved: the fact row
//   is never mutated; the index is a sidecar left-join, safe to delete and
//   rebuild from the (append-only) ledgers. When opts is omitted (or the index
//   is absent), behavior degrades to the original on-row resolution below:
//
//   The thesis-#1 invariant (NEVER mutate fact rows; indices are derived)
//   means we will not backfill thread ids onto rows. So the resolution order
//   DEGRADES, by design, to the signals that DO exist:
//
//     1. THREAD/CONVERSATION label — a short derived descriptor IF the row
//        carries a usable conversation_id (provenance.conversation_id or
//        source_refs[*].conversation_id / features.raw_content.*). Reconstructed
//        rows emitted by the aggregators DO carry
//        provenance.conversation_id = "daemon:thread:<bucket_key>" — those get
//        a real derived thread descriptor. Atomic facts almost never do.
//     2. PROJECT label — derived generically from project/org/topic entities
//        (features.entities[kind in {project,org,topic}]) or the source. This
//        is the dominant resolvable signal for git-log / github-events.
//     3. ENTITIES-only — the last resort: just the canonical entity
//        display-names + the date. Always available when features.entities
//        is non-empty.
//
//   Entity display-names + the created_at date are ALWAYS appended (when
//   present) regardless of which label resolved — they are the cheapest,
//   highest-coverage anchors (entities have ~88% coverage on the corpus).
//
// FORMAT (segments joined by single spaces; empty segments omitted):
//   "Conversation: <label>. Source: <source>. Entities: <e1, e2, ...>. Date: <YYYY-MM-DD>."
//   - "Conversation:" segment present only when a thread OR project label
//     resolved (thread descriptor preferred; project label otherwise).
//   - The whole prefix is bounded to ~40 tokens (PREFIX_MAX_TOKENS) by
//     truncating the entity list, then hard-capping characters.
//
// CONTRACT:
//   buildContextPrefix(row) -> string   (may be "" when nothing resolves)
//   Pure. Deterministic. Never throws. Missing fields -> a shorter prefix.
//
// LENGTH-NORM / avgdl IMPACT (documented per WU §B):
//   The prefix adds ~10-15 post-stopword tokens per doc. BM25's length
//   normalization (b=0.75) divides the tf-saturation denominator by
//   (1 - b + b*|d|/avgdl); when EVERY doc grows by a similar constant, avgdl
//   grows in lockstep, so |d|/avgdl is ~unchanged for typical docs and the
//   per-term saturation is barely perturbed. Short atomic facts (the ones
//   that benefit most) get RELATIVELY less length-penalty inflation than long
//   docs, which is the desired direction: the prefix terms on a 4-token fact
//   are not unduly down-weighted. Net: concatenation is safe under b=0.75; we
//   do NOT need to re-tune k1/b for this WU. (We also deliberately CONCATENATE
//   into the single tokenized content field rather than the cookbook's
//   two-field MAX, because our BM25 score is an additive sum over query terms
//   — a prefix-only match and a content match ADD, which is strictly more
//   recall than taking the max of two independently-scored fields.)

export const VERSION = "context-prefix@0.1.0";

// Hard bounds. PREFIX_MAX_TOKENS is the soft target the WU specifies (~40);
// PREFIX_MAX_CHARS is the belt-and-braces hard cap so a pathological surface
// (e.g. a 2KB URL "artifact" entity) can never blow up the indexed doc.
export const PREFIX_MAX_TOKENS = 40;
export const PREFIX_MAX_CHARS = 320;
// Cap on how many entity display-names we list. Beyond this the marginal
// recall is tiny and the token budget is better spent elsewhere; also keeps
// the prefix deterministic in length regardless of an outlier row with 50
// extracted entities.
const MAX_ENTITIES_IN_PREFIX = 6;
// Cap each individual display-name's length (a URL "artifact" surface can be
// hundreds of chars). 48 keeps a readable token without dominating the budget.
const MAX_DISPLAY_NAME_CHARS = 48;
// Entity kinds that signal a PROJECT/topic grouping (resolution step 2).
const PROJECT_ENTITY_KINDS = new Set(["project", "org", "topic"]);

// ---------------------------------------------------------------------------
// INTERNAL: safe field readers (every one is defensive — a malformed row must
// never throw; it just contributes nothing).
// ---------------------------------------------------------------------------

function asString(v) {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function getFeatures(row) {
  return row && typeof row.features === "object" && row.features !== null
    ? row.features
    : {};
}

// created_at -> "YYYY-MM-DD" (UTC). Mirrors thread-aggregator.dayBucket so the
// date segment is timezone-stable and identical across re-runs. Returns null
// on a missing / unparseable timestamp.
function isoDate(row) {
  const ca = row && typeof row.created_at === "string" ? row.created_at : null;
  if (ca === null) return null;
  const ms = Date.parse(ca);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

// readConversationId — the ONLY place a thread/conversation handle lives on a
// fact row, checked in priority order. Returns the raw id string or null.
//   1. provenance.conversation_id   (reconstructed rows: "daemon:thread:...")
//   2. source_refs[*].conversation_id (defensive: not seen on live rows but
//      cheap to honor if a future connector stamps it)
//   3. features.raw_content.conversation_id (test fixtures / some pipelines)
function readConversationId(row) {
  const prov =
    row && typeof row.provenance === "object" && row.provenance !== null
      ? row.provenance
      : null;
  if (prov) {
    const c = asString(prov.conversation_id);
    if (c) return c;
  }
  if (Array.isArray(row && row.source_refs)) {
    for (const ref of row.source_refs) {
      if (ref && typeof ref === "object") {
        const c = asString(ref.conversation_id);
        if (c) return c;
      }
    }
  }
  const feats = getFeatures(row);
  const rc =
    feats && typeof feats.raw_content === "object" && feats.raw_content !== null
      ? feats.raw_content
      : null;
  if (rc) {
    const c = asString(rc.conversation_id);
    if (c) return c;
  }
  return null;
}

// deriveThreadLabel — turn a conversation_id into a SHORT human-ish descriptor.
// We have no title store, so the descriptor is a cleaned form of the id:
//   - "daemon:thread:chat:<chatId>:day:<YYYY-MM-DD>" (reconstructed) ->
//       "<chatId> <YYYY-MM-DD>"  (the most informative tokens)
//   - "daemon:thread:repo:<repo>:author:<email>:day:<d>" ->
//       "<repo> <d>"
//   - anything else -> the id with separators normalized to spaces.
// Returns null when no usable descriptor can be formed.
function deriveThreadLabel(convId) {
  const id = asString(convId);
  if (id === null) return null;
  // Strip a leading "daemon:thread:" marker if present.
  let s = id.startsWith("daemon:thread:") ? id.slice("daemon:thread:".length) : id;
  // Pull the most descriptive piece out of the structured bucket keys.
  // chat:<chatId>:day:<date>
  const chatM = /^chat:(.+?):day:(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (chatM) return collapseWs(`${chatM[1]} ${chatM[2]}`);
  // repo:<repo>:author:<email>:day:<date>  OR  ...:week:<wk>
  const repoM = /^repo:(.+?):author:(.+?):(?:day|week):(.+)$/.exec(s);
  if (repoM) return collapseWs(`${repoM[1]} ${repoM[3]}`);
  // <source>:<convId>:day:<date>  (generic aggregator key)
  const genM = /^(.+?):(.+?):day:(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (genM) return collapseWs(`${genM[2]} ${genM[3]}`);
  // Fallback: replace structural separators with spaces, collapse.
  return collapseWs(s.replace(/[:_/]+/g, " "));
}

function collapseWs(s) {
  const out = s.replace(/\s+/g, " ").trim();
  return out.length > 0 ? out : null;
}

// entityDisplayName — derive a human display name from one entity OBJECT.
// Ground-truth entity shape (investigated):
//   { kind, canonical_id, surface, source_scope, evidence, confidence, ... }
// Preference: surface (the observed text) > canonical_id local part > null.
// We also defensively accept a bare string entity (some test fixtures /
// legacy rows) and the malformed "[object Object]" sentinel the recall
// index-cache currently produces (we reject the latter as noise).
function entityDisplayName(ent) {
  if (typeof ent === "string") {
    const s = ent.trim();
    if (s.length === 0) return null;
    if (s === "[object object]" || s === "[object Object]") return null;
    return clampName(s);
  }
  if (ent && typeof ent === "object") {
    const surface = asString(ent.surface);
    if (surface) return clampName(surface);
    // canonical_id form is "<kind>:<scope>:<local>"; take the local part.
    const cid = asString(ent.canonical_id);
    if (cid) {
      const parts = cid.split(":");
      const local = parts.length > 0 ? parts[parts.length - 1] : cid;
      const cleaned = collapseWs(local.replace(/_+/g, " "));
      if (cleaned) return clampName(cleaned);
    }
  }
  return null;
}

function clampName(s) {
  return s.length > MAX_DISPLAY_NAME_CHARS
    ? s.slice(0, MAX_DISPLAY_NAME_CHARS)
    : s;
}

// collectEntityNames — ordered, de-duplicated display names from
// features.entities. Deterministic: preserves first-seen order, drops
// case-insensitive duplicates, caps the count. Also returns the project-grade
// entities (kind in {project,org,topic}) so the project-label step can reuse
// the same single pass.
function collectEntityNames(row) {
  const feats = getFeatures(row);
  const ents = Array.isArray(feats.entities) ? feats.entities : [];
  const names = [];
  const seen = new Set();
  const projectNames = [];
  const projectSeen = new Set();
  for (const ent of ents) {
    const name = entityDisplayName(ent);
    if (name === null) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      if (names.length < MAX_ENTITIES_IN_PREFIX) names.push(name);
    }
    // Project-grade entities (object form only — strings carry no kind).
    if (ent && typeof ent === "object" && PROJECT_ENTITY_KINDS.has(ent.kind)) {
      if (!projectSeen.has(key)) {
        projectSeen.add(key);
        projectNames.push(name);
      }
    }
  }
  return { names, projectNames };
}

// deriveProjectLabel — generic project descriptor (NOT hardcoded to any
// operator project). Prefers a project/org/topic entity surface; falls back
// to the source connector name (a coarse but real grouping signal).
function deriveProjectLabel(row, projectNames) {
  if (Array.isArray(projectNames) && projectNames.length > 0) {
    // Join up to 2 project-grade names for a slightly richer label.
    return projectNames.slice(0, 2).join(", ");
  }
  return null;
}

// ---------------------------------------------------------------------------
// PUBLIC: buildContextPrefix
// ---------------------------------------------------------------------------

/**
 * resolveBackwardConversationId(row, opts) -> string | null
 *
 * WU-backward-conversation-index wiring. The fact row itself almost never
 * carries provenance.conversation_id (the historical 0% coverage this WU
 * fixes). The backward conversation-index (lib/synthesis/conversation-index.js)
 * is a DERIVED projection fact_id -> {conversation_id, thread_label} built by
 * joining the fact's source_refs to its retained source row. When the caller
 * threads that index in via `opts.conversationIndex`, we resolve the REAL
 * conversation_id for facts that have one — turning the historical
 * degrade-to-project path into a real thread label.
 *
 * Two accepted shapes (both optional; both degrade silently to null):
 *   - opts.conversationEntry: a pre-resolved { conversation_id, thread_label }
 *     (the caller already did the lookup; cheapest, no Map probe here).
 *   - opts.conversationIndex: the index object { byFactId: Map } plus a
 *     lookupConversation(index, factId) fn (opts.lookupConversation). We do the
 *     probe here keyed by row.id.
 *
 * Defensive: index absent / malformed / miss -> null (the caller falls back to
 * the existing on-row resolution, i.e. CURRENT BEHAVIOR).
 */
function resolveBackwardConversationId(row, opts) {
  if (opts == null || typeof opts !== "object") return null;
  // Shape 1: caller pre-resolved the descriptor.
  const entry = opts.conversationEntry;
  if (entry != null && typeof entry === "object") {
    const c = asString(entry.conversation_id);
    if (c) return c;
  }
  // Shape 2: caller handed us the index + a lookup fn; probe by row.id.
  const idx = opts.conversationIndex;
  const lookup = opts.lookupConversation;
  if (idx != null && typeof lookup === "function") {
    const factId = asString(row && row.id);
    if (factId) {
      try {
        const hit = lookup(idx, factId);
        if (hit != null && typeof hit === "object") {
          const c = asString(hit.conversation_id);
          if (c) return c;
        }
      } catch {
        // Defensive degrade: a throwing lookup must not break prefix building.
        return null;
      }
    }
  }
  return null;
}

/**
 * buildContextPrefix(row, opts?) -> string
 *
 * Deterministic, pure, defensive. Resolution order for the "Conversation:"
 * label: backward conversation-index descriptor (when opts threads it in) ->
 * on-row thread/conversation descriptor -> project label -> (omitted, entities
 * carry the signal). Entity display-names and the date are always appended
 * when present. Returns "" when the row yields no usable signal at all.
 *
 * @param {object} row — a promoted fact row.
 * @param {object} [opts] — optional backward-index wiring (see
 *   resolveBackwardConversationId). When omitted, behavior is byte-identical
 *   to the original single-arg signature (the index is purely additive).
 */
export function buildContextPrefix(row, opts) {
  if (row == null || typeof row !== "object") return "";

  let label = null;
  try {
    // WU-backward-conversation-index: prefer the REAL conversation_id from the
    // backward index (when threaded in) over the (usually null) on-row one.
    let convId = resolveBackwardConversationId(row, opts);
    if (convId === null) convId = readConversationId(row);
    label = deriveThreadLabel(convId); // null when no conv id
  } catch {
    label = null;
  }

  let names = [];
  let projectNames = [];
  try {
    const collected = collectEntityNames(row);
    names = collected.names;
    projectNames = collected.projectNames;
  } catch {
    names = [];
    projectNames = [];
  }

  // PROJECT fallback when no thread/conversation label resolved.
  if (label === null) {
    try {
      label = deriveProjectLabel(row, projectNames);
    } catch {
      label = null;
    }
  }

  const source = asString(row.source);
  let date = null;
  try {
    date = isoDate(row);
  } catch {
    date = null;
  }

  // Assemble segments; omit empty ones.
  const segments = [];
  if (label) segments.push(`Conversation: ${label}.`);
  if (source) segments.push(`Source: ${source}.`);
  if (names.length > 0) segments.push(`Entities: ${names.join(", ")}.`);
  if (date) segments.push(`Date: ${date}.`);

  if (segments.length === 0) return "";

  let prefix = segments.join(" ");

  // Hard token cap (~40). Tokenize on whitespace (cheap proxy for the BM25
  // tokenizer's word-split); if over budget, drop entities first (they are
  // the most expendable / most numerous), then hard-cap chars.
  if (countWsTokens(prefix) > PREFIX_MAX_TOKENS && names.length > 0) {
    // Re-build with a shrinking entity list until under budget.
    let n = names.length;
    while (n > 0) {
      const trimmed = [];
      if (label) trimmed.push(`Conversation: ${label}.`);
      if (source) trimmed.push(`Source: ${source}.`);
      trimmed.push(`Entities: ${names.slice(0, n).join(", ")}.`);
      if (date) trimmed.push(`Date: ${date}.`);
      const candidate = trimmed.join(" ");
      if (countWsTokens(candidate) <= PREFIX_MAX_TOKENS) {
        prefix = candidate;
        break;
      }
      n -= 1;
    }
    if (n === 0) {
      // Even with zero entities still over budget (huge label) — drop entities.
      const trimmed = [];
      if (label) trimmed.push(`Conversation: ${label}.`);
      if (source) trimmed.push(`Source: ${source}.`);
      if (date) trimmed.push(`Date: ${date}.`);
      prefix = trimmed.join(" ");
    }
  }

  // Belt-and-braces hard char cap.
  if (prefix.length > PREFIX_MAX_CHARS) {
    prefix = prefix.slice(0, PREFIX_MAX_CHARS);
  }
  return prefix;
}

function countWsTokens(s) {
  if (typeof s !== "string" || s.length === 0) return 0;
  const parts = s.split(/\s+/);
  let n = 0;
  for (const p of parts) if (p.length > 0) n += 1;
  return n;
}

// Test-only surface — exposed so the WU suite can unit-test the internal
// resolution helpers without reconstructing whole rows.
export const __internal = Object.freeze({
  isoDate,
  readConversationId,
  resolveBackwardConversationId,
  deriveThreadLabel,
  deriveProjectLabel,
  entityDisplayName,
  collectEntityNames,
  countWsTokens,
  PROJECT_ENTITY_KINDS,
});
