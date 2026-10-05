// F-CCS-CONNECTOR-chat-claude-code-structural (W3-CCS) — pure helper module
// that derives the structured_features payload for a chat-claude-code source
// row at emit time. The W9 audit observed that the chat-claude-code source
// runs a 59.8% empty-rate over the trailing 7d window (Stop hook firing on
// tool-only turns where neither user_text nor assistant_text surfaces text);
// the remaining substantive rows land in the source ledger but the cascade
// text-extractor has no structural anchor to dedupe / corroborate against,
// so the same conversation_id + cwd surfaces fan out into N text-derived
// entities instead of a single canonical project + topic pair.
//
// This module mirrors the W2 patterns (git-log-local + github-events
// structural emitters) verbatim:
//
//   1. Pure-functional buildStructuredFeatures(row) → returns the
//      structured_features object on success OR undefined on any structural
//      violation (backwards-compat: the cascade falls back to the text-only
//      path via `sf?.entities ?? []` when undefined is returned).
//   2. Local slugify mirroring the 7 ordered steps of
//      mcp/lib/synthesis/entity-extractor.js#slugify verbatim — kept
//      module-local so the connector emit path does not pull a synthesis
//      import on the hot path and so a future CI grep on slugify drift can
//      flag any divergence between the two call sites.
//   3. Module-local CAPS frozen at module scope per W2-W12 discipline.
//      Defense-in-depth: emit-side caps stop oversized payloads at the
//      source; the future merger MUST re-enforce its own copy.
//   4. evidence: 'structural' on every entity (the connector ALREADY KNOWS
//      conversation_id + cwd structurally; foundation spec §3.2 connector-
//      emit allowlist is {handle, structural, kb_lookup}).
//   5. emitter_version conforms to the structured-features-schema §3.2
//      regex `/^[a-z0-9_\-]+@[0-9]+\.[0-9]+\.[0-9]+(\+[a-z0-9_\-]+)*$/` so
//      the future cascade-side validator accepts the payload (NOT
//      unsupported_schema_version, NOT invalid_emitter_version).
//
// SHAPE the helper extracts from raw_content:
//   - conversation_id: stable chat-cc UUID/slug → topic entity
//     (canonical_id=`topic:chat-claude-code:SLUG(conv_id)`).
//   - cwd:            optional absolute filesystem path → project entity
//                     (canonical_id=`project:chat-claude-code:SLUG(basename(cwd))`).
//                     Mirrors the git-log-local pattern of using basename so
//                     the same project canonical_id stamps regardless of
//                     where the operator clones the repo.
//
// PARTIES: always ["user", "assistant"] per the stop-hook contract
// (hooks/stop-hook.sh always emits both as the row's parties[]). We project
// them to canonical_id form ["person:chat-claude-code:user",
// "person:chat-claude-code:assistant"] for the merger's intersect-by-id
// path (foundation spec §3.1 / §6.3).
//
// TIME_ANCHORS: a single absolute anchor stamped from row.ts (the turn
// timestamp written by the stop-hook). structural:true so the merger wins
// tie-breaks over text-extracted anchors of the same (kind, iso) per
// foundation spec §6 OQ5.
//
// CONSUMER WIRING: chat-claude-code rows are emitted by
// hooks/stop-hook.sh (a bash script that builds the JSONL line via an
// inline node block) — NOT a long-running Node connector daemon. This
// module is therefore a PURE HELPER consumed by:
//   - the future stop-hook update that imports buildStructuredFeatures
//     and stamps the field at emit time, AND
//   - the F-CCS-BACKFILL-engine that walks the existing ledger and
//     materializes the field via a policy.feature_backfill event for
//     pre-upgrade rows.
// Both consumers SHOULD invoke the helper inside a defensive try/catch
// so a builder throw never blocks the row from landing (W2-W12 discipline).

import {
  slugify,
  buildCanonicalId,
  ENTITY_SLUG_REGEX,
  SLUG_EMPTY_SENTINEL,
  MIN_ENTITY_LENGTH,
} from "../synthesis/entity-extractor.js";
// TIME_ANCHORS_MAX_PER_FACT is the RESOLVER's cap. The connector's CAPS bag
// re-exports it (tests read the bag), but it does not re-declare the number:
// the resolver is the single source of truth and this import is what makes
// that sentence true. time-anchor-resolver.js has zero imports of its own, so
// it is a leaf and no cycle is constructible through this edge.
import { TIME_ANCHOR_RESOLVER_CAPS } from "../synthesis/time-anchor-resolver.js";

// =============================================================================
// Module identity — W2-W12 discipline: VERSION + frozen CAPS.
// =============================================================================

/**
 * Frozen schema discriminator for the v1 ship of structured_features.
 * Pinned by docs/specs/ccs/structured-features-schema.md §3.1.
 */
export const STRUCTURED_FEATURES_SCHEMA_VERSION = "v1";

/**
 * Frozen emitter version stamped on every structured_features payload
 * produced by this module. Matches the spec §3.2 regex
 * `/^[a-z0-9_\-]+@[0-9]+\.[0-9]+\.[0-9]+(\+[a-z0-9_\-]+)*$/`. The
 * workunit task identifier was "chat-cc-structural-v1"; we encode the
 * same intent in the regex-conforming `<name>@<semver>` form so the
 * drift-detector path (OQ1) can spot upgrades and re-extract.
 */
export const STRUCTURED_FEATURES_EMITTER_VERSION = "chat-cc-structural@1.0.0";

/**
 * The entity-schema source_scope this connector stamps. Matches
 * ENTITY_SOURCE_SCOPES from lib/synthesis/entity-extractor.js (the closed
 * 6-source enum that already includes "chat-claude-code"). Stamping a
 * non-enum source_scope would make the canonical_id drift from the
 * cascade text-extractor path and break the union-by-canonical-id merge
 * invariant.
 */
export const STRUCTURED_FEATURES_SOURCE_SCOPE = "chat-claude-code";

/**
 * Per-row evidence kind. Connector-emit allowlist is {handle, structural,
 * kb_lookup} per foundation spec §3.2; chat-cc knows conversation_id +
 * cwd structurally so 'structural' is the only honest value.
 */
const STRUCTURED_EVIDENCE = "structural";

/**
 * Module VERSION constant per W2-W12 discipline. Mirrors the structured-
 * features emitter version so the supervisor inventory + drift-detector
 * see a single bumpable identity.
 */
export const VERSION = STRUCTURED_FEATURES_EMITTER_VERSION;

/**
 * Frozen CAPS bag — tests can read CAPS.SCHEMA_VERSION etc. directly
 * without poking at named exports.
 */
export const CAPS = Object.freeze({
  SCHEMA_VERSION: STRUCTURED_FEATURES_SCHEMA_VERSION,
  EMITTER_VERSION: STRUCTURED_FEATURES_EMITTER_VERSION,
  SOURCE_SCOPE: STRUCTURED_FEATURES_SOURCE_SCOPE,
  // foundation spec §3.2 — cap mirrors the github-events emitter. NOT the
  // git-log emitter: git-log-local.js's CAPS bag has exactly three keys
  // (SCHEMA_VERSION, EMITTER_VERSION, SOURCE_SCOPE) and defines neither of
  // the two caps below.
  ENTITY_MAX_PER_ROW: 32,
  // NOT a local literal: read from the resolver that owns the cap.
  TIME_ANCHORS_MAX_PER_FACT: TIME_ANCHOR_RESOLVER_CAPS.TIME_ANCHORS_MAX_PER_FACT,
  // Closed enums (foundation spec §3 / §4). Inlined so the future
  // cascade-side validator can cross-check the connector's view.
  VALID_EVIDENCE_AT_CONNECTOR: Object.freeze([
    "handle",
    "structural",
    "kb_lookup",
  ]),
  ENTITY_KINDS: Object.freeze([
    "person",
    "place",
    "org",
    "project",
    "event",
    "topic",
    "artifact",
  ]),
});

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Take the basename of an absolute (or relative) filesystem path. Mirrors
 * the node:path basename() contract for forward-slash paths (chat-cc rows
 * carry POSIX-shaped cwds on macOS) without pulling node:path in on the
 * hot path. Returns "" when the input is not a non-empty string.
 *
 * Why module-local: the cwd surfaces paths on the operator's machine
 * (e.g. <HOME>/memory-system/mcp) and stripping the parent dirs is
 * a deterministic, pure-string operation. The full path would slugify
 * to a chatty `_users_alex_memory_system_mcp` slug; basename gives the
 * concise `mcp` project canonical_id that joins cleanly with git-log
 * + github-events project entities when the operator is working in the
 * same repo across all three sources.
 */
function _basename(p) {
  if (typeof p !== "string" || p.length === 0) return "";
  // Strip trailing separators so basename("/foo/") -> "foo".
  let s = p;
  while (s.length > 1 && (s.endsWith("/") || s.endsWith("\\"))) {
    s = s.slice(0, -1);
  }
  const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return idx >= 0 ? s.slice(idx + 1) : s;
}

/**
 * _structuralEntity: build one Entity (entity-schema §4 shape) from a raw
 * surface. Returns null on any structural violation (defensive
 * degradation — the cascade still has the text-extractor path for that
 * surface). Pure-functional; no I/O, no Date.now(), no Math.random().
 *
 * Uses the shared synthesis slugify so the emit-side canonicalization is
 * byte-identical to the cascade text-extractor path; if buildCanonicalId
 * throws (sentinel-slug or closed-enum violation) we swallow and return
 * null per the "connector emit must never block the row" invariant.
 */
function _structuralEntity(kind, surface) {
  if (typeof surface !== "string") return null;
  const trimmed = surface.trim();
  if (trimmed.length === 0) return null;
  // Foundation spec §6.1(a) — min surface length on codepoints.
  if ([...trimmed].length < MIN_ENTITY_LENGTH) return null;
  let slug;
  try {
    slug = slugify(trimmed);
  } catch {
    return null;
  }
  if (slug === SLUG_EMPTY_SENTINEL) return null;
  if (!ENTITY_SLUG_REGEX.test(slug)) return null;
  let canonicalId;
  try {
    canonicalId = buildCanonicalId({
      source: STRUCTURED_FEATURES_SOURCE_SCOPE,
      kind,
      text: trimmed,
    });
  } catch {
    // buildCanonicalId throws on unknown kind, unknown source, or sentinel
    // slug. All three are defensive paths we already short-circuit above;
    // the catch defends against a future entity-extractor change.
    return null;
  }
  return {
    kind,
    canonical_id: canonicalId,
    surface: trimmed,
    source_scope: STRUCTURED_FEATURES_SOURCE_SCOPE,
    evidence: STRUCTURED_EVIDENCE,
    confidence: 1.0,
    extractor_version: STRUCTURED_FEATURES_EMITTER_VERSION,
  };
}

// =============================================================================
// buildStructuredFeatures — the public emit-time helper
// =============================================================================

/**
 * Derive the structured_features payload for a single chat-claude-code
 * row. Returns the payload object on success OR undefined when the input
 * row is too malformed to extract anything safely (defensive degradation
 * per W2-W12 discipline; backwards-compat is preserved by consumer-side
 * `sf?.entities ?? []` short-circuits).
 *
 * Inputs we read:
 *   - row.raw_content.conversation_id : stable chat-cc id → topic entity
 *   - row.raw_content.cwd             : optional cwd      → project entity
 *   - row.ts                          : turn ISO timestamp → absolute time
 *                                       anchor with structural:true
 *
 * Failure modes that route to undefined (NOT throw — never block emit):
 *   - row is null/undefined/non-object
 *   - row.raw_content is missing or non-object
 *
 * Otherwise: returns a partial payload (some sub-fields may be empty
 * arrays when their inputs were malformed). The cascade merger unions
 * with precedence so partial structural emission is strictly additive
 * (foundation spec §6).
 *
 * @param {object} row - source-row shape: {ts, raw_content, ...}
 * @returns {object|undefined}
 */
export function buildStructuredFeatures(row) {
  // Defensive: every input is hostile. Return undefined on any structural
  // violation so the cascade falls back to the text-extractor-only path.
  if (row == null || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const rc = row.raw_content;
  if (rc == null || typeof rc !== "object" || Array.isArray(rc)) {
    return undefined;
  }

  const entities = [];

  // Conversation id → topic entity. The conversation_id is the operator's
  // chat-cc session UUID (per the stop-hook emit shape) — surfacing it as
  // a topic lets the cascade dedupe N turns from the same session into a
  // single canonical anchor instead of N text-derived ad-hoc entities.
  const conversationId =
    typeof rc.conversation_id === "string" ? rc.conversation_id : "";
  if (conversationId.length > 0) {
    const e = _structuralEntity("topic", conversationId);
    if (e) entities.push(e);
  }

  // cwd → project entity (basename). cwd is OPTIONAL — older rows in the
  // ledger carry cwd:null when the hook fired before the field was added.
  // When absent we simply skip the project stamp (NOT a crash; NOT a
  // sentinel slug). The basename pattern mirrors git-log-local's
  // basename(repo_path) so the same project canonical_id stamps across
  // chat-cc + git-log + github-events when the operator is working in the
  // same repo across all three.
  const cwd = typeof rc.cwd === "string" ? rc.cwd : "";
  if (cwd.length > 0) {
    const projectBase = _basename(cwd);
    if (projectBase.length > 0) {
      const e = _structuralEntity("project", projectBase);
      if (e) entities.push(e);
    }
  }

  // Sort entities by canonical_id (foundation spec invariant I7 — array
  // MUST be sorted ascending for byte-stable merge / dedupe).
  entities.sort((a, b) =>
    a.canonical_id < b.canonical_id ? -1 :
    a.canonical_id > b.canonical_id ? 1 : 0,
  );

  // Cap at ENTITY_MAX_PER_ROW; defense-in-depth (the merger also caps).
  const cappedEntities = entities.slice(0, CAPS.ENTITY_MAX_PER_ROW);

  // time_anchors: prefer the turn clock (row.ts — the moment the stop-hook
  // recorded the turn). Per foundation spec §5.2 worked example: the
  // connector stamps the source clock; the cascade's row-ts-as-anchor node
  // separately stamps row.ts for backfill of pre-upgrade rows. The dedupe
  // key (kind, parsed.iso) collapses identical pairs so duplication is
  // harmless. structural:true wins tie-breaks over text-extracted anchors.
  const timeAnchors = [];
  const rowTs = typeof row.ts === "string" ? row.ts : "";
  if (rowTs.length > 0) {
    const parsedMs = Date.parse(rowTs);
    if (Number.isFinite(parsedMs)) {
      let iso;
      try {
        iso = new Date(parsedMs).toISOString();
      } catch {
        iso = null;
      }
      if (typeof iso === "string" && iso.length > 0) {
        timeAnchors.push({
          kind: "absolute",
          raw_phrase: rowTs,
          parsed: { iso },
          extractor_confidence: 1.0,
          extractor_version: STRUCTURED_FEATURES_EMITTER_VERSION,
          structural: true,
        });
      }
    }
  }

  // parties: chat-cc rows ALWAYS carry ["user","assistant"] per the
  // stop-hook contract — both sides participate in every turn even when
  // the text on one side is empty (tool-only turns). We project them to
  // canonical_id form so the merger's intersect-by-id path admits them
  // unchanged. The slug pipeline produces "user" and "assistant" verbatim
  // (both clear MIN_ENTITY_LENGTH=3 and ENTITY_SLUG_REGEX).
  const partiesCanonical = [];
  for (const party of ["user", "assistant"]) {
    let canonicalId;
    try {
      canonicalId = buildCanonicalId({
        source: STRUCTURED_FEATURES_SOURCE_SCOPE,
        kind: "person",
        text: party,
      });
    } catch {
      continue;
    }
    partiesCanonical.push(canonicalId);
  }

  return {
    schema_version: STRUCTURED_FEATURES_SCHEMA_VERSION,
    emitter_version: STRUCTURED_FEATURES_EMITTER_VERSION,
    entities: cappedEntities,
    time_anchors: timeAnchors.slice(0, CAPS.TIME_ANCHORS_MAX_PER_FACT),
    parties: partiesCanonical,
  };
}

// =============================================================================
// Test-only surface
// =============================================================================

/**
 * Surfaces module-internals for the structural-test fixture so tests can
 * assert basename behavior + the structural-entity gate without hardcoding
 * implementation details inline.
 */
export const _internals = Object.freeze({
  _basename,
  _structuralEntity,
});
