// content-fields-manifest.js
//
// Per-source declaration of the fields that carry semantic payload ("content")
// on a row coming out of a connector. The companion predicate
// `./content-free.js` consumes this manifest to decide whether a row is
// content-free (all declared content fields null/empty AND no content-bearing
// metadata such as commits>0 / attachments>0) and therefore should be DROPPED
// before Stage-0 hands the row off to embedding / structural scoring.
//
// Background — why this exists (R45 cross-source finding):
//
//   Multiple connectors emit rows whose payload columns are null/empty by
//   construction:
//     * github-events: PushEvent with commits=0 and first_message=null
//       (the upstream API truncated the commit list).
//     * screentime: /notification/usage rows that carry no body/title (the
//       notification was system-generated and had no human-visible string).
//     * codex-cli: scaffold-only rows that record an agent-runtime hook
//       firing but contain no text/content (the hook produced no payload).
//
//   Each connector implemented its own ad-hoc "is this content-free?" check.
//   The checks drifted (some looked at `text`, some at `body`, screentime
//   varied across streams). A row that one connector would have dropped got
//   through another and was embedded with a falsely high structural_score
//   because the structural scorer treats "absence of text" as "use the
//   fallback prose hint" rather than "this row has no semantic payload".
//
// Design: declaration owners publish content-field specs; this module folds
// those specs into the lookup consumed by the predicate. Messaging sources are
// discovered from the adapter registry and keep their field names beside the
// raw-row projection that reads them. Sources without adapter declarations use
// the local declarations below until their producer layer exposes a registry.
// A missing declaration stays explicit: the predicate returns drop=false with
// trigger "unregistered_source".
//
// Schema:
//   {
//     <source>: {
//       fields: [<top-level row field names>],   // checked unless overridden
//       stream_specific?: {
//         <stream>: [<field names>],             // overrides `fields` for this stream
//       },
//       metadata?: [<field names>],              // numeric "has-payload" hints;
//                                                // if any > 0, row is NOT content-free
//                                                // even when text fields are null
//     }
//   }
//
// Field-name conventions:
//   * String fields: the predicate treats null, undefined, "", and
//     whitespace-only strings as empty.
//   * Metadata fields: the predicate treats 0, null, undefined, [] (empty
//     array), and false as empty; any other value is "has payload".
//
// Field-name lookup is case-insensitive and null-safe (see content-free.js).
//
// ES module.

import { ADAPTER_MODULES } from "../messaging/adapters/registry.js";

// Fold adapter-owned declarations by the adapter's own PLATFORM identity.
// Missing or malformed capabilities are skipped so classification stays
// fail-open when a new adapter lands before its declaration.
function contentSpecsFromAdapters(modules) {
  const entries = [];
  for (const mod of Array.isArray(modules) ? modules : []) {
    const source = mod && mod.PLATFORM;
    const spec = mod && mod.CONTENT_FIELD_SPEC;
    if (
      typeof source !== "string" ||
      source.length === 0 ||
      spec == null ||
      typeof spec !== "object" ||
      !Array.isArray(spec.fields) ||
      spec.fields.length === 0
    ) {
      continue;
    }
    entries.push([source, spec]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

const ADAPTER_CONTENT_FIELD_SPECS = contentSpecsFromAdapters(ADAPTER_MODULES);

export const CONTENT_FIELDS_MANIFEST = Object.freeze({
  // screentime — multi-stream connector. Default fields cover the common
  // /web/visit and /notification/usage shapes; stream_specific overrides
  // narrow the check for streams whose semantic payload lives in a
  // non-default column (e.g. /app/intents uses intent_class as the payload).
  screentime: Object.freeze({
    fields: Object.freeze(["url", "query", "body", "title"]),
    stream_specific: Object.freeze({
      "/app/intents": Object.freeze(["intent_class"]),
      "/notification/usage": Object.freeze(["body", "title"]),
      "/web/visit": Object.freeze(["url", "query"]),
    }),
  }),

  // codex-cli — agent-runtime hook payload. Scaffold-only rows have neither
  // text nor content set.
  "codex-cli": Object.freeze({
    fields: Object.freeze(["text", "content"]),
  }),

  // F-T2-CHAT_CLAUDE-CODE-F6 — Claude Code agent-runtime hook payload. The
  // stop-hook writes raw_content.{user_text, assistant_text}; an empty turn
  // (both fields blank) is content-free and Stage-0 routes it to DROP via
  // the shared isContentFree predicate.
  "chat-claude-code": Object.freeze({
    fields: Object.freeze(["user_text", "assistant_text"]),
  }),

  // git-log — commit subject + body. A no-message commit (rare; usually a
  // merge with --allow-empty-message) is content-free.
  "git-log": Object.freeze({
    fields: Object.freeze(["subject", "body"]),
  }),

  // github-events — PushEvent etc. first_message is the head commit's
  // message; body/title cover Issue/PR/Comment events. commits>0 keeps a
  // push with a truncated message but a non-zero commit count from being
  // dropped (the commit count itself is the semantic signal).
  "github-events": Object.freeze({
    fields: Object.freeze(["first_message", "body", "title"]),
    metadata: Object.freeze(["commits"]),
  }),

  // Adapter-backed messaging declarations. Membership and field specs come
  // from adapters/registry.js plus each module's CONTENT_FIELD_SPEC export.
  ...ADAPTER_CONTENT_FIELD_SPECS,
});

// getContentFieldSpec — resolve the manifest entry for a source, honoring
// stream-specific overrides. Returns `{ fields, metadata }` where `fields`
// is the array of string-payload field names to check and `metadata` is the
// array of numeric/array "has-payload" hint field names. Returns null when
// the source is not registered — callers MUST treat null as "no declared
// content fields, do not drop".
//
// `stream` is optional. When provided AND the manifest declares a
// stream_specific override for that stream, the override REPLACES the
// default `fields` list (it does not merge — overrides are total).
export function getContentFieldSpec(source, stream) {
  if (typeof source !== "string" || source.length === 0) return null;
  const entry = CONTENT_FIELDS_MANIFEST[source];
  if (!entry) return null;

  let fields = entry.fields;
  if (
    typeof stream === "string" &&
    stream.length > 0 &&
    entry.stream_specific &&
    entry.stream_specific[stream]
  ) {
    fields = entry.stream_specific[stream];
  }

  return {
    fields: Array.isArray(fields) ? fields : [],
    metadata: Array.isArray(entry.metadata) ? entry.metadata : [],
  };
}

// listRegisteredSources — operator/test helper. Returns the source keys the
// manifest currently declares.
export function listRegisteredSources() {
  return Object.keys(CONTENT_FIELDS_MANIFEST);
}

export default CONTENT_FIELDS_MANIFEST;
