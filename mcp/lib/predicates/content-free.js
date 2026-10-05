// content-free.js
//
// Shared predicate: "does this row carry any semantic payload?"
//
// Driven by ./content-fields-manifest.js. Centralises the per-source check
// that was previously re-implemented (and re-drifted) in each connector's
// Stage-0 module. See the manifest header for the cross-source motivation
// (R45 finding F-INFRA-R45-CONTENT-FREE).
//
// Contract:
//
//   isContentFree(row, source) → {
//     drop:     boolean,           // true ⇔ row is content-free and should be dropped
//     reason:   "content_free" | null,
//     triggers: string[],          // diagnostic: which checks fired
//   }
//
//   The `reason` string is the telemetry key used by salience policy events
//   (`policy.stage0.dropped` with `reason: "content_free"`), so callers can
//   pass it through unchanged.
//
//   `triggers` is a flat array of strings useful for operator debugging,
//   e.g. ["empty:url", "empty:query", "metadata_zero:commits"]. The
//   structural shape is stable but the exact string set is best-effort —
//   tests should assert on `drop`/`reason`, not on `triggers` membership.
//
// Behaviour:
//
//   * Unknown source → drop=false (fail-open). A connector that ships
//     before its manifest entry is added still has its rows passed through;
//     the manifest gap is visible at review time, not silently lossy.
//
//   * Source declared with EMPTY fields list → drop=false. Same fail-open
//     reasoning.
//
//   * Field lookup is case-insensitive: the predicate matches both `Body`
//     and `body`. The manifest SHOULD declare lower-case names; the
//     case-insensitive match is a safety net for connectors whose row
//     builders preserve source-native casing.
//
//   * "Empty" string-field rules: null, undefined, "", and whitespace-only
//     strings are empty. Any other value (including the string "0") is
//     non-empty and the row is NOT content-free.
//
//   * "Empty" metadata rules: 0, null, undefined, false, and [] (empty
//     array) are empty. Any other value — including arrays of length ≥1,
//     true, and numbers > 0 — counts as content-bearing and the row is NOT
//     content-free even when every declared text field is empty.
//
// Stream resolution:
//
//   The predicate looks for the stream identifier on the row in this order:
//     1. row.stream
//     2. row.raw_content.stream  (the connector-ledger shape)
//     3. row.payload?.stream     (defensive — some connectors nest payload)
//
//   If a stream is present AND the manifest declares a stream_specific
//   override for that source+stream pair, the override's field list
//   REPLACES the default field list.
//
// ES module. Imports the manifest helper; no other dependencies.

import { getContentFieldSpec } from "./content-fields-manifest.js";

// resolveStream — best-effort lookup of the per-row stream identifier.
// Returns "" when no recognised slot carries a non-empty string.
function resolveStream(row) {
  if (!row || typeof row !== "object") return "";
  if (typeof row.stream === "string" && row.stream.length > 0) return row.stream;
  const rc = row.raw_content;
  if (rc && typeof rc === "object" && typeof rc.stream === "string" && rc.stream.length > 0) {
    return rc.stream;
  }
  const pl = row.payload;
  if (pl && typeof pl === "object" && typeof pl.stream === "string" && pl.stream.length > 0) {
    return pl.stream;
  }
  return "";
}

// lookupField — case-insensitive, null-safe field read from the row.
// Returns the first match it finds; field declaration order in the manifest
// is the tie-break.
function lookupField(row, name) {
  if (!row || typeof row !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(row, name)) {
    return row[name];
  }
  // Case-insensitive fallback. Cheap O(keys) scan; the row keysets are
  // small (< 30 fields) so the linear pass is fine.
  const lower = name.toLowerCase();
  for (const k of Object.keys(row)) {
    if (k.toLowerCase() === lower) return row[k];
  }
  // Defensive nesting check: connectors that wrap payload in raw_content.
  const rc = row.raw_content;
  if (rc && typeof rc === "object") {
    if (Object.prototype.hasOwnProperty.call(rc, name)) return rc[name];
    for (const k of Object.keys(rc)) {
      if (k.toLowerCase() === lower) return rc[k];
    }
  }
  return undefined;
}

// isStringEmpty — null / undefined / "" / whitespace-only → empty.
function isStringEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v !== "string") return false;
  return v.trim().length === 0;
}

// isMetadataEmpty — 0 / null / undefined / false / [] → empty.
// Numbers > 0, non-empty arrays, non-empty strings, and truthy objects
// count as content-bearing.
function isMetadataEmpty(v) {
  if (v === null || v === undefined) return true;
  if (v === false) return true;
  if (typeof v === "number") return v === 0 || Number.isNaN(v);
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "string") return v.trim().length === 0;
  // Truthy objects / true / non-empty strings — non-empty.
  return false;
}

// isContentFree — the public predicate.
//
// `row`    : connector row (top-level fields, may carry raw_content / payload).
// `source` : source identifier (matches the manifest keys).
//
// Returns the structured envelope described in the file header. The caller
// can spread `reason` directly into a `policy.stage0.dropped` event.
export function isContentFree(row, source) {
  // Defensive: bad inputs never DROP. Fail-open is the cross-cutting
  // invariant — see file header.
  if (!row || typeof row !== "object") {
    return { drop: false, reason: null, triggers: ["invalid_row"] };
  }
  if (typeof source !== "string" || source.length === 0) {
    return { drop: false, reason: null, triggers: ["unknown_source"] };
  }

  const stream = resolveStream(row);
  const spec = getContentFieldSpec(source, stream);
  if (!spec) {
    return { drop: false, reason: null, triggers: ["unregistered_source"] };
  }

  const { fields, metadata } = spec;
  if (!Array.isArray(fields) || fields.length === 0) {
    // Source registered but declared no content fields — fail-open.
    return { drop: false, reason: null, triggers: ["no_declared_fields"] };
  }

  // Walk the declared text fields. If ANY is non-empty, the row carries
  // semantic payload and we return drop=false immediately.
  const triggers = [];
  for (const name of fields) {
    const v = lookupField(row, name);
    if (!isStringEmpty(v)) {
      return { drop: false, reason: null, triggers: [`has_text:${name}`] };
    }
    triggers.push(`empty:${name}`);
  }

  // All declared text fields empty. Now check metadata "has-payload" hints.
  // Any non-empty metadata field rescues the row from being dropped.
  for (const name of metadata) {
    const v = lookupField(row, name);
    if (!isMetadataEmpty(v)) {
      return {
        drop: false,
        reason: null,
        triggers: [...triggers, `has_metadata:${name}`],
      };
    }
    triggers.push(`metadata_zero:${name}`);
  }

  // Every declared text field empty AND every declared metadata hint
  // empty → row is content-free.
  return { drop: true, reason: "content_free", triggers };
}

export default isContentFree;
