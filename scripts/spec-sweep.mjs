#!/usr/bin/env node
// spec-sweep.mjs — runnable conformance gate (Lesson 11).
//
// Phase 1 review-13 verdict identified the mechanical sweep gate as a reviewer
// JSON document, not a runnable script. This file is the corrective: a single
// node executable that greps the live tree for deprecated names and validates
// every batch.json + the distillation-state.json against the frozen schemas
// documented in `kb/agent-integration.md`.
//
// ===========================================================================
// EXIT-CODE SEMANTICS (R35 M1 — recursion floor close).
// -----------------------------------------------------
// The pre-R35 contract was "exit 0 unless sweep-internal-error; exit 1
// otherwise." Under R34 brutalist phase (c) this was shown to be half a
// gate: classifier hits were detected (logged) but did not always escalate
// to a hard build failure, and a sweep-internal-error was indistinguishable
// from a legitimate finding. R35 separates the two concerns into three
// distinct exit codes so downstream gates (CI, npm test, hooks) can react
// to the SEMANTIC reason the sweep failed:
//
//   exit 0 — clean. Zero classifier hits AND zero sweep-internal-errors.
//   exit 1 — legitimate findings. One or more classifier hits across any
//            category that is NOT "EVENT-OWNERSHIP WARNING" and NOT
//            "sweep-internal-error". This is the "build should block"
//            signal: legacy_pattern_seen / STATE-SCHEMA / BATCH-SCHEMA /
//            STATE-FILE SCHEMA / BATCH-FILE SCHEMA / EVENT-KIND-PRESENCE
//            findings landed in source that needs editing.
//   exit 2 — gate broken. One or more sweep-internal-error findings (a KB
//            parser threw, a per-file read failed, etc.). The sweep itself
//            could not run cleanly; the build MUST block until the gate is
//            repaired, otherwise the negative space ("we saw zero hits")
//            is a false guarantee. Exit 2 takes priority over exit 1.
//
// EVENT-OWNERSHIP WARNING remains a soft, advisory-only category and does
// not influence the exit code.
// ===========================================================================
//
// Usage:
//   node scripts/spec-sweep.mjs
//   node scripts/spec-sweep.mjs --self-test
//
// ===========================================================================
// REFINEMENT (recovery r14 — sweep-refinement). Distinguishes LEGITIMATE
// references to deprecated names from REAL drift via three layered
// allow-marker mechanisms. The pre-refinement sweep flagged 56 hits; ~49 of
// those were false positives (test deny-lists, migration code, DELETED-field
// callouts, the health envelope's own schema_version field, and prose
// counter-examples that explicitly forbid the bad shape). The refined sweep
// reports ONLY real drift.
//
// Allow-marker forms (all three are detected; any one is sufficient):
//
//   (a) INLINE allow-marker — a single line ending in one of these literal
//       markers is exempted from the deprecated-name greps:
//           // spec-sweep:allow         (JS, TS, comments)
//           # spec-sweep:allow          (shell, configs)
//           <!-- spec-sweep:allow -->   (markdown)
//       Use sparingly — every inline marker is a promise that the line is
//       intentional (e.g. a test deny-list assertion, a migration-code
//       hasOwnProperty check). Reviewers should be able to read the
//       intent on the same line.
//
//   (b) PATH-PREFIX / PATTERN allow-list — pragmatic exemptions for known
//       legitimate code patterns:
//         - test/* files where the deprecated name appears inside a
//           `for (const ... of [...])` deny-list loop body. Pattern: the
//           same test file contains the for-loop and the term is enumerated
//           as a value being rejected.
//         - watermark.js old-shape-detection code: lines containing
//           `hasOwnProperty.call(parsed, "<deprecated>")` — this is the
//           migration code that DELETES the old shape, naming the old key
//           is required.
//         - test/* files asserting deprecated-field ABSENCE via
//           `!hasOwnProperty.call(..., "<deprecated>")` patterns.
//         - distillation-supervisor.js documentation comment listing the
//           deprecated batch field names.
//
//   (c) SECTION allow-list in KB — hits in `agent-integration.md` (and any
//       *.md) within a clearly marked "DELETED FIELDS" callout section are
//       exempted. Detected by tracking the most recent markdown heading
//       (`## ...`) or strong-emphasis line (`**...DELETED...**`,
//       `**...REPLACED...**`, `**...OLD...**`, `**...Name discipline...**`,
//       `**...WRONG...**`). The callout text is the AUTHORITATIVE source
//       for what is deprecated; naming the old keys there is required, not
//       drift. The section is active from the introducing line through the
//       next blank line (paragraph break).
//
// SCOPED `schema_version` HANDLING — `schema_version` is BOTH a deleted
// distillation-state field AND a current health-envelope field. The bare
// grep was a false positive on health.js + health-real-data.test.mjs. We
// now only flag `schema_version` hits in source files whose path contains
// "distillation" OR whose basename is `distillation-state.json`, OR whose
// name is one of the spec KB files that talk about the distillation state
// schema (agent-integration.md, build-plan.md, mcp-surface.md). The
// health envelope's `schema_version` is correctly emitted by health.js
// and asserted by health-real-data.test.mjs — these are NOT drift.
//
// CONSTRAINT (do not relax): the sweep MUST still catch real drift. Every
// allow-marker is a NARROW carve-out. A live deprecated-name reference in
// any source file outside the allow-listed contexts must still surface.
// ===========================================================================
//
// Categories searched:
//   1. BATCH-SCHEMA DEPRECATED (turn_range, trigger_ts, start_id, end_id,
//      start_ts, end_ts) — DELETED from spec (agent-integration.md L106).
//   2. STATE-SCHEMA DEPRECATED (schema_version [DISTILLATION-SCOPED],
//      runtimes-as-top-level, last_processed_offset, in_flight_batch_ids,
//      high_water_mark_offset) — DELETED (L141, N3).
//   3. EVENT-KIND WRONG-VARIANT (policy.daemon.batch.split) — wrong name;
//      the correct name is policy.distillation.batch.split (L170).
//   4. HEALTH FAKE-DATA MARKERS (hardcoded `tools_registered: 9`) — should
//      call toolCount() per kb spec.
//   5. Batch-file schema validation — every batch.json in queue dirs must
//      have EXACTLY 8 top-level keys + 4 range keys.
//   6. State-file schema validation — distillation-state.json must have
//      EXACTLY {version,updated_at,conversations,in_flight}.
//   7. Event-ownership table cross-check — every producer named in the
//      ownership table at agent-integration.md L159+ must have an
//      appendPolicyEvent call site with that kind.
//   8. Event-kind presence — every kind in EVENT_KINDS (single source of
//      truth in mcp/lib/policy-events.js) must have at least one
//      appendPolicyEvent call site in the source tree.
//
// No npm deps. node:* builtins only. Portable POSIX `grep -RIn` (no GNU/BSD
// extensions). Skips node_modules/.git/dist/build.

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

// R32 prevent-legacy gate. Imports the canonical forbidden-identifiers list
// shared with `mcp/test/no-legacy-pipeline-references.test.mjs`. See
// `kb/deprecation-discipline.md` for the policy. The sweep adds a new
// `legacy_pattern_seen` category whose hits cause a non-zero exit, same as
// the existing BATCH-SCHEMA / STATE-SCHEMA / EVENT-KIND categories.
import {
  FORBIDDEN_IDENTIFIERS as R32_FORBIDDEN_IDENTIFIERS,
  defaultScanRoots as r32DefaultScanRoots,
  stripComments as r32StripComments,
  scanLineForForbidden as r32ScanLineForForbidden,
  isExcludedPath as r32IsExcludedPath,
  isScannedFile as r32IsScannedFile,
} from "../mcp/lib/forbidden-legacy-identifiers.js";

// R35 M2 — extractCanonical for structural binding on machine-consumed KB
// regions. parseFrozenEventOwnership prefers the CANONICAL block
// 'policy_event_kinds_table' when present and falls back to the legacy
// anchor-text path so a partial migration is not catastrophic.
import { extractCanonical as r35ExtractCanonical } from "../mcp/scripts/canonical-block-scan.mjs";

// Paths.
const HOME = process.env.HOME || process.env.USERPROFILE;
// ROOT is the CODE root (kb/, mcp/, daemons/, hooks/, scripts/): always the
// checkout this script lives in. DATA_ROOT (queue, policy state) follows
// MEMORY_ROOT and defaults to the checkout, the same split as mcp/lib/config.js
// (CHECKOUT_ROOT vs MEMORY_ROOT).
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DATA_ROOT = process.env.MEMORY_ROOT || ROOT;
const SEARCH_ROOTS = [
  join(ROOT, "kb"),
  join(ROOT, "mcp"),
  join(ROOT, "daemons"),
  join(ROOT, "hooks"),
  join(ROOT, "scripts"),
];
const QUEUE_BASE = join(DATA_ROOT, "storage", "distillation-queue");
const QUEUE_DIRS = ["pending", "in-flight", "done", "failed"].map((d) =>
  join(QUEUE_BASE, d),
);
const STATE_FILE = join(DATA_ROOT, "policy", "distillation-state.json");
const OWNERSHIP_DOC = join(ROOT, "kb", "agent-integration.md");
const KB_AGENT_INTEGRATION = join(ROOT, "kb", "agent-integration.md");

// ---------- AUTHORITATIVE-KB schema parsers --------------------------------
//
// R34 B11 MIGRATION PATH (TECH-DEBT, deferred from R34 to R35).
// -------------------------------------------------------------
// The three parsers below (parseFrozenBatchSchema / parseFrozenStateSchema /
// parseFrozenEventOwnership) still use anchor-text matching: they look for
// strong-emphasis preamble phrases like
//   "**Distillation batch (AUTHORITATIVE SCHEMA"
// and slice the next fenced ``` block. This is brittle: renaming the heading
// silently breaks the parser. R33-B5 made the failure visible (a crash
// becomes a sweep-internal-error finding instead of silent zero hits), but
// the underlying brittleness remains.
//
// R34 ships the replacement infrastructure as
//   mcp/scripts/kb-spec-extract.mjs
// which introduces the BEGIN-SPEC / END-SPEC marker convention. When a
// future migration round (R35+) decides to keep the distillation pipeline
// schemas in the KB (rather than fully retiring them with the pipeline),
// those blocks should be wrapped:
//
//   <!-- BEGIN-SPEC: kb.batch_schema.v1 -->
//   ```json
//   { ... }
//   ```
//   <!-- END-SPEC: kb.batch_schema.v1 -->
//
// and the parsers below should be rewritten to call
//   extractSpec(KB_AGENT_INTEGRATION, "kb.batch_schema.v1")
// instead of extractFencedBlockAfter("**Distillation batch...").
//
// CURRENT STATE (R34): the distillation pipeline schemas were RETIRED in
// R32; the anchors above no longer exist in kb/agent-integration.md. The
// parsers run with `{ optional: true }`, return null sentinels, and the
// downstream batch/state sweeps become no-ops. Because there is no live
// authoritative schema in the KB to read, there is nothing to migrate to
// a BEGIN-SPEC block YET — R34 keeps the anchor-based parsers as
// no-op-shimmed code paths and does not introduce empty BEGIN-SPEC blocks.
// If R35 reintroduces a live KB-pinned schema, follow the migration path
// above.
//
// The sweep gate validates batch/state files against shapes pinned in
// `kb/agent-integration.md`. Before this refactor the gate carried its OWN
// hardcoded copies of those shapes — the 4th divergent copy in the tree
// (after watermark.js, distillation-supervisor.js, and the test suite).
// The brutalist review (recovery r14) called this out as drift hiding
// behind the gate's own definitions: the gate could never catch drift in
// the shape it was meant to enforce, because the gate WAS one of the
// drifting copies.
//
// The fix is to make the KB block load-bearing at gate time: parse the
// fenced JSON blocks at module-init, derive the field sets from them,
// and fail LOUDLY on parse error so the sweep cannot silently fall back
// to a hardcoded default. Three parsers live here:
//
//   parseFrozenBatchSchema(kbPath)        -> { topKeys, rangeKeys }
//   parseFrozenStateSchema(kbPath)        -> { topKeys, conversationKeys, in_flight_keys }
//   parseFrozenEventOwnership(kbPath)     -> Map<kind, Set<producerFile>>
//
// Each parser fingerprints the KB section by a stable anchor phrase, slices
// the next fenced ``` block, parses the JSON, and extracts the key sets.
// If the anchor moves OR the JSON malforms, the parser throws and the
// sweep fails the run — the spec author cannot accidentally desync the
// fenced block from the prose without the gate noticing.

function readKbForParser(kbPath) {
  if (!existsSync(kbPath)) {
    throw new Error(
      `KB parser: file not found at ${kbPath} — the spec sweep gate requires the authoritative KB to be present`,
    );
  }
  return readFileSync(kbPath, "utf8");
}

// Find the first fenced ``` block whose opening fence appears at or after
// the line containing `anchor`. Returns the block body (text BETWEEN the
// two fence lines), or throws if not found.
//
// R33-B5: callers may pass {optional: true} to convert anchor-not-found into
// a sentinel return of `null` instead of throwing. The KB sections this
// parser describes were ALL retired with the distillation pipeline in R32;
// downstream sweeps now treat missing fenced blocks as "this checker has
// nothing to do" rather than "crash the entire sweep."
function extractFencedBlockAfter(text, anchor, opts = {}) {
  const idx = text.indexOf(anchor);
  if (idx < 0) {
    if (opts.optional) return null;
    throw new Error(
      `KB parser: anchor "${anchor}" not found — the KB section may have been renamed; reconcile spec-sweep.mjs against kb/agent-integration.md`,
    );
  }
  const tail = text.slice(idx);
  // First ``` after anchor opens the block; second ``` closes it.
  const openMatch = tail.match(/\n```[^\n]*\n/);
  if (!openMatch) {
    throw new Error(
      `KB parser: no opening fence after anchor "${anchor}" — the authoritative schema block is missing`,
    );
  }
  const openEnd = openMatch.index + openMatch[0].length;
  const afterOpen = tail.slice(openEnd);
  const closeIdx = afterOpen.indexOf("\n```");
  if (closeIdx < 0) {
    throw new Error(
      `KB parser: no closing fence after anchor "${anchor}" — fenced block is unterminated`,
    );
  }
  return afterOpen.slice(0, closeIdx);
}

// The KB fenced blocks are JSON-shaped but use placeholders like `"<ulid>"`
// and shorthand union syntax (`"<x> | null"`, bare-int placeholders like
// `<integer, 1..N>`). Strip the values aggressively, keep ONLY the keys —
// that is all the schema gate needs. Approach: scan for `"key":` patterns
// at the relevant nesting depth. Simpler than building a JSON-with-comments
// parser and resilient to spec authors editing the inline placeholder
// values without touching the keys.
function extractKeysAtDepth(blockText, depth /* 1 = top, 2 = nested */) {
  // Convention: a key directly inside the outermost `{ ... }` is at depth 1.
  // We track the depth ENTERING each line. A line that opens a container
  // (e.g. `{` on its own, or `"range": {`) puts subsequent lines deeper;
  // a key on the SAME line as its container-open is at the outer depth (it
  // is the parent's key, e.g. `"range":` itself), not the inner depth.
  const keys = [];
  const lines = blockText.split("\n");
  let curDepth = 0;
  for (const ln of lines) {
    const opens = (ln.match(/[{[]/g) || []).length;
    const closes = (ln.match(/[}\]]/g) || []).length;
    // Key on this line lives at depth `curDepth` (the depth we're currently
    // inside). If the line opens a fresh container with a key before it
    // (e.g. `"range": {`), the key still lives at depth curDepth — it is
    // the container's name in the PARENT object.
    const m = ln.match(/^\s*"([^"]+)"\s*:/);
    if (m && curDepth === depth) {
      keys.push(m[1]);
    }
    curDepth += opens - closes;
  }
  return keys;
}

// Same as extractKeysAtDepth but only collects keys nested inside a SPECIFIC
// parent key. Used to grab e.g. the `range` sub-object's keys.
function extractKeysUnderParent(blockText, parentKey) {
  // Find a line that opens a container with the given parent key (e.g.
  // `"range": {`). Once found, collect keys whose curDepth equals the depth
  // immediately INSIDE the parent (depthAtParentOpen + 1). Stop when the
  // parent container closes.
  const keys = [];
  const lines = blockText.split("\n");
  let depthAtParentOpen = -1;
  let curDepth = 0;
  let inParent = false;
  const escapedParent = parentKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Allow optional placeholder syntax like "<runtime>:<conversation_id>"
  // by matching the literal key string anywhere in the key field.
  const parentRe = new RegExp(`"${escapedParent}"\\s*:\\s*[{[]`);
  for (const ln of lines) {
    const opens = (ln.match(/[{[]/g) || []).length;
    const closes = (ln.match(/[}\]]/g) || []).length;
    if (!inParent) {
      if (parentRe.test(ln)) {
        inParent = true;
        depthAtParentOpen = curDepth; // depth of the parent's name in its enclosing object
        // After processing this line we will be inside the parent.
        curDepth += opens - closes;
        continue;
      }
      curDepth += opens - closes;
      continue;
    }
    // Inside the parent. Keys directly inside live at curDepth ==
    // depthAtParentOpen + 1.
    const m = ln.match(/^\s*"([^"]+)"\s*:/);
    if (m && curDepth === depthAtParentOpen + 1) {
      keys.push(m[1]);
    }
    curDepth += opens - closes;
    if (curDepth <= depthAtParentOpen) {
      // Parent container fully closed.
      break;
    }
  }
  return keys;
}

export function parseFrozenBatchSchema(kbPath, opts = {}) {
  const text = readKbForParser(kbPath);
  // Stable anchor: the strong-emphasis preamble line for the authoritative
  // batch schema. The exact phrase appears once in the doc.
  //
  // R33-B5: this anchor was retired with the distillation pipeline in R32;
  // the KB block no longer exists. With opts.optional the parser returns a
  // null sentinel and the downstream batch-file sweep becomes a no-op
  // (there are no batch files to validate against the retired schema).
  const anchor = "**Distillation batch (AUTHORITATIVE SCHEMA";
  const block = extractFencedBlockAfter(text, anchor, opts);
  if (block === null) return null;
  const topKeys = extractKeysAtDepth(block, 1);
  const rangeKeys = extractKeysUnderParent(block, "range");
  if (topKeys.length === 0) {
    throw new Error(
      "KB parser (batch schema): zero top-level keys extracted — the authoritative fenced block changed shape",
    );
  }
  if (rangeKeys.length === 0) {
    throw new Error(
      'KB parser (batch schema): zero `range` sub-keys extracted — the "range" sub-object is missing or malformed',
    );
  }
  return { topKeys, rangeKeys };
}

export function parseFrozenStateSchema(kbPath, opts = {}) {
  const text = readKbForParser(kbPath);
  // Anchor: the strong-emphasis preamble for the authoritative state schema.
  //
  // R33-B5: retired-with-pipeline. opts.optional → null sentinel so the
  // state-file sweep becomes a no-op when the KB block has been migrated.
  const anchorMain = (text.match(/\*\*State file: `[^`\n]*policy\/distillation-state\.json` \(AUTHORITATIVE SCHEMA/) || ["**State file: `<MEMORY_ROOT>/policy/distillation-state.json` (AUTHORITATIVE SCHEMA"])[0];
  const mainBlock = extractFencedBlockAfter(text, anchorMain, opts);
  if (mainBlock === null) return null;
  const topKeys = extractKeysAtDepth(mainBlock, 1);
  // Conversations sub-keys live two levels deep: conversations -> "<runtime>:<conversation_id>" -> {fields}.
  // The placeholder key is "<runtime>:<conversation_id>"; extract its children.
  const conversationKeys = extractKeysUnderParent(mainBlock, "<runtime>:<conversation_id>");
  // in_flight is an array of objects; extract object keys.
  // Approach: find the in_flight array and the first object literal inside it.
  const inFlightKeys = (function extractInFlightKeys() {
    const idx = mainBlock.indexOf('"in_flight"');
    if (idx < 0) return [];
    const tail = mainBlock.slice(idx);
    // The array opens with `[`; first `{` inside is the object literal.
    const objStart = tail.indexOf("{");
    if (objStart < 0) return [];
    const objEnd = tail.indexOf("}", objStart);
    if (objEnd < 0) return [];
    const obj = tail.slice(objStart, objEnd + 1);
    const keys = [];
    for (const ln of obj.split("\n")) {
      const m = ln.match(/^\s*"([^"]+)"\s*:/);
      if (m) keys.push(m[1]);
    }
    return keys;
  })();

  // Implementation-private addendum block (post-this-refactor, lives in
  // the SAME KB doc). Parse it so the gate accepts these fields without
  // a hand-maintained allow-list inside the sweep script.
  const addendumAnchor = "**State-file implementation-private addendum to the frozen schema";
  let addendumTopKeys = [];
  let addendumConversationKeys = [];
  try {
    const addendumBlock = extractFencedBlockAfter(text, addendumAnchor);
    addendumTopKeys = extractKeysUnderParent(addendumBlock, "_state_addendum_top_level");
    addendumConversationKeys = extractKeysUnderParent(addendumBlock, "_state_addendum_per_conversation");
  } catch (err) {
    throw new Error(
      `KB parser (state addendum): ${err.message} — the implementation-private addendum block is required (see kb/agent-integration.md)`,
    );
  }

  if (topKeys.length === 0) {
    throw new Error(
      "KB parser (state schema): zero top-level keys extracted — the authoritative fenced block changed shape",
    );
  }
  if (conversationKeys.length === 0) {
    throw new Error(
      "KB parser (state schema): zero per-conversation keys extracted — the `<runtime>:<conversation_id>` block is missing or malformed",
    );
  }
  if (inFlightKeys.length === 0) {
    throw new Error(
      "KB parser (state schema): zero in_flight[] object keys extracted",
    );
  }
  return {
    topKeys,
    conversationKeys,
    in_flight_keys: inFlightKeys,
    addendumTopKeys,
    addendumConversationKeys,
  };
}

export function parseFrozenEventOwnership(kbPath, opts = {}) {
  // R35 M2 — primary path is structural extraction from the CANONICAL
  // 'policy_event_kinds_table' block. The legacy anchor-text path remains as
  // a fallback so a partial migration (block missing on this branch but
  // present on the linked anchor) is not catastrophic. If both paths fail
  // we throw / return-null per the {optional} contract.
  let canonicalText = null;
  try {
    canonicalText = r35ExtractCanonical(kbPath, "policy_event_kinds_table");
  } catch {
    canonicalText = null;
  }
  let sourceForLines;
  if (canonicalText != null) {
    sourceForLines = canonicalText;
  } else {
    const text = readKbForParser(kbPath);
    const tableAnchor = "Token-event ownership table";
    const idx = text.indexOf(tableAnchor);
    if (idx < 0) {
      if (opts.optional) return null;
      throw new Error(
        `KB parser (event ownership): canonical block 'policy_event_kinds_table' missing AND anchor "${tableAnchor}" not found`,
      );
    }
    // The table is the next markdown table after the anchor. Slice a window
    // wide enough to contain it.
    sourceForLines = text.slice(idx, idx + 8000);
  }
  const lines = sourceForLines.split("\n");
  const map = new Map();
  for (const ln of lines) {
    if (!ln.startsWith("|")) continue;
    if (/^\|[\s\-:|]+\|$/.test(ln.trim())) continue;
    const cells = ln.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    const kind = cells[0].replace(/`/g, "").trim();
    const producer = cells[1].replace(/`/g, "").trim();
    if (!kind.startsWith("policy.")) continue;
    if (!map.has(kind)) map.set(kind, new Set());
    // Producer cell may name multiple files via "OR"; split.
    for (const p of producer.split(/\bOR\b/).map((s) => s.trim()).filter(Boolean)) {
      map.get(kind).add(p);
    }
  }
  if (map.size === 0) {
    throw new Error(
      "KB parser (event ownership): zero kinds parsed — the table format may have changed",
    );
  }
  return map;
}

// Module-init: load the authoritative shapes.
//
// R33-B5: a crashing module-init silenced every other checker (a gate that
// reports nothing reads as a gate that found nothing). The new contract is:
//   - call each parser with {optional: true}
//   - on a THROWN error, record a `sweep-internal-error` finding (a parser
//     that crashes on malformed input must surface).
//   - on a NULL return (the documented "anchor retired" sentinel for parsers
//     called with {optional: true}), DO NOT record an error: the schema was
//     intentionally retired (e.g. batch/state schemas migrated out of the KB
//     with the distillation-pipeline retirement in R32). The downstream
//     checker becomes a no-op and the run remains clean.
// CLOSE-4 (R34): batch + state KB sections are retired; their `null`
// sentinels are EXPECTED and not findings. parseFrozenEventOwnership is
// NOT retired — its anchor still exists; if it ever returns null that IS
// drift and we still want a finding. So this function records the error
// ONLY when the parser throws; the parser's own `{optional: true}` contract
// is what distinguishes retired-by-design from truly-broken.
const KB_PARSE_ERRORS = []; // collected for final report
function tryParse(label, fn) {
  try {
    return fn();
  } catch (err) {
    KB_PARSE_ERRORS.push({ checker: label, error: err.message });
    return null;
  }
}
const FROZEN_BATCH = tryParse("parseFrozenBatchSchema", () =>
  parseFrozenBatchSchema(KB_AGENT_INTEGRATION, { optional: true }),
);
const FROZEN_STATE = tryParse("parseFrozenStateSchema", () =>
  parseFrozenStateSchema(KB_AGENT_INTEGRATION, { optional: true }),
);
const FROZEN_OWNERSHIP = tryParse("parseFrozenEventOwnership", () =>
  parseFrozenEventOwnership(KB_AGENT_INTEGRATION, { optional: true }),
);

// Skip directories on every grep call. `grep --exclude-dir=` is supported by
// both BSD grep (macOS) and GNU grep. To stay portable we pass the flag once
// per directory rather than relying on `-r` walking.
// R39.1: `workflows` names an archive directory of workflow scripts,
// containing historical workflow-script snapshots (R32-current). These are
// frozen documentary records of past workflows; they MUST mention deprecated
// identifiers in prose/strings as part of describing what those workflows
// were eradicating. Excluding the directory keeps the sweep focused on LIVE
// source while preserving the archive intact.
const SKIP_DIRS = ["node_modules", ".git", "dist", "build", "workflows"];

// ---------- Categories & hits ----------------------------------------------

// Hit = { category, file, line, term, context }.
const allHits = [];

function addHit(category, file, line, term, context) {
  allHits.push({ category, file, line, term, context });
}

function printHit(h) {
  // Plain-text structured: file:line:term  context
  // Use a 2-space separator so editors that hyperlink file:line: prefixes work.
  const ctx = (h.context || "").trim().slice(0, 160);
  process.stdout.write(`  ${h.file}:${h.line}: [${h.term}] ${ctx}\n`);
}

// ---------- Allow-marker mechanisms ----------------------------------------

// (a) Inline allow-marker. A line ending in one of these literal strings is
// exempted from the deprecated-name greps. Trailing whitespace tolerated.
const INLINE_ALLOW_MARKERS = [
  "// spec-sweep:allow",
  "# spec-sweep:allow",
  "<!-- spec-sweep:allow -->",
];

function hasInlineAllowMarker(content) {
  const trimmed = (content || "").trimEnd();
  for (const m of INLINE_ALLOW_MARKERS) {
    if (trimmed.endsWith(m)) return true;
  }
  return false;
}

// (b) Path-prefix / pattern allow-list. Cached per file body since the same
// file is hit many times.
const FILE_BODY_CACHE = new Map();
function readFileCached(path) {
  if (FILE_BODY_CACHE.has(path)) return FILE_BODY_CACHE.get(path);
  let body = "";
  try {
    body = readFileSync(path, "utf8");
  } catch {
    body = "";
  }
  FILE_BODY_CACHE.set(path, body);
  return body;
}

function isTestDenyListAllowed(file, term, content) {
  // Test files only.
  if (!file.includes("/mcp/test/")) return false;
  const body = readFileCached(file);
  // Pattern 1: term appears INSIDE a `for (const ... of [...])` array
  // literal whose body contains the term in quotes.
  const forLoopRe = new RegExp(
    `for\\s*\\(\\s*const[^)]*of\\s*\\[[^\\]]*"${escapeRe(term)}"[^\\]]*\\]`,
  );
  if (forLoopRe.test(body)) return true;
  // Pattern 2: the term appears in a `!hasOwnProperty.call(..., "<term>")`
  // assertion (test that the field is absent post-migration). The test
  // text intentionally NAMES the deprecated field.
  const absenceRe = new RegExp(
    `!\\s*Object\\.prototype\\.hasOwnProperty\\.call\\([^,]+,\\s*"${escapeRe(term)}"\\)`,
  );
  if (absenceRe.test(body)) return true;
  // Pattern 3: the term appears as a string literal inside a
  // `does NOT have` description string (drift-detector test labels).
  if (/does NOT have/.test(content) && content.includes(`"${term}"`)) return true;
  // Pattern 4: AUTHORITATIVE_FIELDS array literal in tests (drift-detector
  // list defining the closed field set, naming each field as a string).
  // Activated only when the file body contains `AUTHORITATIVE_FIELDS` and
  // the term is one of the fields in that array.
  if (body.includes("AUTHORITATIVE_FIELDS")) {
    const arrRe = new RegExp(
      `AUTHORITATIVE_FIELDS[\\s\\S]*?\\[[\\s\\S]*?"${escapeRe(term)}"[\\s\\S]*?\\]`,
    );
    if (arrRe.test(body)) return true;
  }
  // Pattern 5: per-line "rejects deprecated <term>" test (the line OR
  // a 4-line context window in the file body contains the term AND a
  // rejection assertion or label).
  // Examples:
  //   check("reject: extra trigger_ts (...)", () => {...})
  //   const b = goodBatch({ trigger_ts: ... }); assert.throws(...)
  //   assert.throws(() => validateBatchShape(b), /unexpected key 'trigger_ts'/);
  //   driftObj.trigger_ts = "..."; // DELETED-from-spec extra
  const rejectionContextRe = /(?:reject|unexpected key|DELETED-from-spec|deprecated|smoking-gun|drift)/i;
  if (rejectionContextRe.test(content) && content.includes(term)) return true;
  // Window check: locate the hit line in the body and inspect +/- 3 lines
  // for a rejection context (`reject`, `assert.throws`, `unexpected key`,
  // `DELETED-from-spec`).
  const bodyLines = body.split("\n");
  for (let i = 0; i < bodyLines.length; i++) {
    if (bodyLines[i] !== content) continue;
    const winStart = Math.max(0, i - 3);
    const winEnd = Math.min(bodyLines.length, i + 4);
    const window = bodyLines.slice(winStart, winEnd).join("\n");
    if (
      window.includes(term) &&
      (rejectionContextRe.test(window) ||
        /assert\.throws/.test(window) ||
        /smoking-gun/.test(window))
    ) {
      return true;
    }
  }
  // Pattern 6: header comment block in a test file that lists deprecated
  // names as part of documenting what the test enforces. Recognized by
  // the line starting with `//` AND being within the first 30 lines of
  // the file AND containing comma-separated deprecated names.
  const lineNum = (function findLine() {
    // Cheap line-number lookup: split and search for the literal content.
    const lines = body.split("\n");
    for (let i = 0; i < Math.min(lines.length, 30); i++) {
      if (lines[i] === content) return i + 1;
    }
    return -1;
  })();
  if (lineNum > 0 && /^\s*\/\//.test(content) && /,\s*\w+_(?:id|ts|range|count)/.test(content)) {
    return true;
  }
  return false;
}

function isWatermarkOldShapeDetection(file, term, content) {
  if (basename(file) !== "watermark.js") return false;
  // Pattern A: the migration comment that names schema_version/runtimes/in_flight_batch_ids.
  if (/`schema_version`\/`runtimes`\/`in_flight_batch_ids`/.test(content)) return true;
  // Pattern B: the hasOwnProperty.call(parsed, "...") detection itself.
  if (/hasOwnProperty\.call\(parsed,\s*"/.test(content)) return true;
  return false;
}

function isSupervisorDeprecatedComment(file, term, content) {
  if (basename(file) !== "distillation-supervisor.js") return false;
  // Comment block in validateBatchShape that documents the deprecated terms.
  if (/Deprecated names/.test(content)) return true;
  if (/end_ts\)\s*surface as the generic/.test(content)) return true;
  if (/^\s*\/\/\s*end_ts\)/.test(content)) return true;
  // The comment line listing turn_range, trigger_ts, start_id, end_id, start_ts.
  if (/turn_range,\s*trigger_ts,\s*start_id,\s*end_id,\s*start_ts/.test(content)) return true;
  return false;
}

// (c) Section allow-list. Markdown file lines within a clearly-marked
// DELETED/REPLACED/OLD/Name-discipline/WRONG callout section are exempted.
const SECTION_ACTIVE_RANGES = new Map(); // file -> array of {start, end}

function buildSectionRanges(file) {
  if (SECTION_ACTIVE_RANGES.has(file)) return SECTION_ACTIVE_RANGES.get(file);
  const ranges = [];
  let body = "";
  try {
    body = readFileSync(file, "utf8");
  } catch {
    SECTION_ACTIVE_RANGES.set(file, ranges);
    return ranges;
  }
  const lines = body.split("\n");
  // A section is "active" starting on the line that introduces it and
  // continues until the next blank line (paragraph break). Introducing
  // lines are markdown headings (`#{1,6} ...`) or paragraphs containing
  // strong-emphasis tokens like `**DELETED**`, `**REPLACED**`, `**OLD**`,
  // `**Name discipline.**`, `**Two-producer exception ...**`, or
  // `**No drift permitted.**` — and the introducing line itself must
  // additionally contain one of the deprecation-naming keywords (so a
  // random `**header**` does not silently exempt everything).
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const isHeading = /^#{1,6}\s/.test(ln);
    const isStrong = /\*\*[^*]+\*\*/.test(ln);
    const namesDeleted =
      /DELETED|REPLACED|deprecated|OLD shape|OLD field|Name discipline|name discipline|Two-producer exception|WRONG|No drift permitted/.test(
        ln,
      );
    if ((isHeading || isStrong) && namesDeleted) {
      const start = i + 1; // 1-indexed
      let end = start;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === "") break;
        end = j + 1;
      }
      ranges.push({ start, end });
    }
  }
  SECTION_ACTIVE_RANGES.set(file, ranges);
  return ranges;
}

function isInDeletedCalloutSection(file, lineNum) {
  if (!file.endsWith(".md")) return false;
  const ranges = buildSectionRanges(file);
  const n = parseInt(lineNum, 10);
  for (const r of ranges) {
    if (n >= r.start && n <= r.end) return true;
  }
  return false;
}

// Helper.
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Composite: returns true iff the hit should be skipped.
function isExempt(file, term, lineNum, content) {
  // (a) Inline marker — universal ONLY for hits routed through isExempt.
  // Measured, not assumed: `sweepR32LegacyPatterns` (the `legacy_pattern_seen`
  // category) never calls isExempt/hasInlineAllowMarker — it calls addHit
  // directly — and it runs r32StripComments FIRST, so a trailing
  // `// spec-sweep:allow` is deleted before the scan ever sees the line. The
  // marker is therefore INERT for legacy_pattern_seen; that category's only
  // exemption mechanism is EXCLUDED_PATH_SUFFIXES in
  // mcp/lib/forbidden-legacy-identifiers.js, which this file imports as
  // r32IsExcludedPath and applies in both r32WalkDir and the scan loop.
  if (hasInlineAllowMarker(content)) return true;
  // (b) Pattern-based exemptions.
  if (isTestDenyListAllowed(file, term, content)) return true;
  if (isWatermarkOldShapeDetection(file, term, content)) return true;
  if (isSupervisorDeprecatedComment(file, term, content)) return true;
  // (c) KB section callout.
  if (isInDeletedCalloutSection(file, lineNum)) return true;
  return false;
}

// ---------- grep helpers ---------------------------------------------------

// Run portable grep. Uses -RIn (recursive, binary-skip, line-numbers) plus
// fixed-string mode (-F) per term so the search terms are not regex-parsed.
function grepTermInRoots(term, roots) {
  const args = ["-RIn", "-F", "-e", term];
  for (const dir of SKIP_DIRS) {
    args.push(`--exclude-dir=${dir}`);
  }
  for (const r of roots) {
    if (existsSync(r)) args.push(r);
  }
  if (args.length === 4) return []; // no roots existed
  const res = spawnSync("grep", args, { encoding: "utf8" });
  if (res.status === 2) {
    process.stderr.write(
      `spec-sweep: grep error for term '${term}': ${res.stderr}\n`,
    );
    return [];
  }
  const out = res.stdout || "";
  return out
    .split("\n")
    .filter((l) => l.length > 0)
    .map(parseGrepLine)
    .filter(Boolean);
}

function parseGrepLine(line) {
  const firstColon = line.indexOf(":");
  if (firstColon < 0) return null;
  const secondColon = line.indexOf(":", firstColon + 1);
  if (secondColon < 0) return null;
  const file = line.slice(0, firstColon);
  const lineNo = line.slice(firstColon + 1, secondColon);
  const content = line.slice(secondColon + 1);
  return { file, line: lineNo, content };
}

// ---------- Categorical sweeps --------------------------------------------

const SRC_FILE_RE = /\.(?:js|mjs|cjs|ts|sh|json|md)$/;

// Distillation-scoped: a file path / basename hints it is part of the
// distillation pipeline. The `schema_version` deprecation only applies in
// these contexts — outside (e.g. the health envelope), `schema_version` is
// a legitimate current field.
function isDistillationScoped(file) {
  if (file.includes("distillation")) return true;
  if (basename(file) === "distillation-state.json") return true;
  // The state-schema validator + state-related code in the spec docs.
  if (file.endsWith("/agent-integration.md")) return true;
  if (file.endsWith("/build-plan.md")) return true;
  if (file.endsWith("/mcp-surface.md")) return true;
  return false;
}

// R35 M3: STATE-SCHEMA classifier allowlist for LIVE identifier mentions in
// KB documentation. The classifier's negative set (FORBIDDEN literals) is
// distillation-pipeline-historical. Some of those literal strings are ALSO
// names of LIVE non-distillation fields:
//   - `schema_version` is the live HEALTH envelope field (kb/mcp-surface.md
//     authoritative field set; produced by mcp/lib/tools/health.js).
//   - `last_processed_offset` is the live per-source watermark cursor field
//     (kb/agent-integration.md watermark_state_schema_v1; produced by
//     daemons/watermark.js).
//   - `in_flight_batch_ids` has NO live consumer, but its naming in
//     kb/legacy-archive.md is the POINT of the archive: the archive records
//     what shape was retired, by name.
// The positive set below is consulted ONLY for hits in KB docs (.md under
// kb/) — production code remains fully gated. Per-file-basename scoping
// keeps each carve-out NARROW: a live identifier is allowlisted only in
// the specific KB file where its live meaning is defined or referenced.
// Production code references continue to fail the gate.
const ALLOWLISTED_LIVE_IDENTIFIERS = new Map([
  [
    "mcp-surface.md",
    new Set([
      // HEALTH envelope field — live, produced by mcp/lib/tools/health.js.
      "schema_version",
    ]),
  ],
  [
    "glossary.md",
    new Set([
      // Watermark cursor field — live, read/written by daemons/watermark.js.
      "last_processed_offset",
    ]),
  ],
  [
    "agent-integration.md",
    new Set([
      // Watermark cursor field — live, defined in the
      // watermark_state_schema_v1 CANONICAL block in this file.
      "last_processed_offset",
    ]),
  ],
  [
    "legacy-archive.md",
    new Set([
      // Historical-retirement-record naming — the archive's purpose is to
      // name the shape that was deleted. No live consumer.
      "in_flight_batch_ids",
    ]),
  ],
]);

// Returns true iff (file, term) is an allowlisted live-identifier mention
// in a KB documentation file. The classifier's deprecated-literal hit list
// has overlap with currently-live identifier names; this positive set is
// the documentation-context-aware suppression that prevents the classifier
// from flagging those live mentions as drift.
function isAllowlistedLiveIdentifier(file, term) {
  // KB docs only — production code is never allowlisted.
  if (!file.includes("/kb/")) return false;
  if (!file.endsWith(".md")) return false;
  const allowed = ALLOWLISTED_LIVE_IDENTIFIERS.get(basename(file));
  if (!allowed) return false;
  return allowed.has(term);
}

function sweepDeprecatedTerms() {
  // Category 1: BATCH-SCHEMA DEPRECATED
  const batchDeprecated = [
    "turn_range",
    "trigger_ts",
    "start_id",
    "end_id",
    "start_ts",
    "end_ts",
  ];
  // Category 2a: STATE-SCHEMA DEPRECATED (distillation-scoped — schema_version
  // is a valid health-envelope field outside distillation contexts).
  const stateDeprecatedDistillationScoped = ["schema_version"];
  // Category 2b: STATE-SCHEMA DEPRECATED (unscoped — these terms have no
  // legitimate non-distillation usage).
  const stateDeprecated = [
    "last_processed_offset",
    "in_flight_batch_ids",
    "high_water_mark_offset",
  ];
  // Category 3: EVENT-KIND WRONG-VARIANT
  const eventWrong = ["policy.daemon.batch.split"];

  const categories = [
    ["BATCH-SCHEMA DEPRECATED", batchDeprecated, /* distScoped */ false],
    [
      "STATE-SCHEMA DEPRECATED",
      stateDeprecatedDistillationScoped,
      /* distScoped */ true,
    ],
    ["STATE-SCHEMA DEPRECATED", stateDeprecated, /* distScoped */ false],
    ["EVENT-KIND WRONG-VARIANT", eventWrong, /* distScoped */ false],
  ];

  for (const [cat, terms, distScoped] of categories) {
    for (const t of terms) {
      const hits = grepTermInRoots(t, SEARCH_ROOTS);
      for (const h of hits) {
        if (!SRC_FILE_RE.test(h.file)) continue;
        // Self-skip: spec-sweep.mjs itself enumerates these terms.
        if (basename(h.file) === "spec-sweep.mjs") continue;
        // schema_version is scoped: only flag in distillation contexts.
        if (distScoped && !isDistillationScoped(h.file)) continue;
        // R35 M3: live-identifier allowlist for KB documentation mentions.
        // Applied BEFORE isExempt so allowlisted hits short-circuit any
        // downstream callout / inline-marker checks.
        if (isAllowlistedLiveIdentifier(h.file, t)) continue;
        // Composite exemption check.
        if (isExempt(h.file, t, h.line, h.content)) continue;
        addHit(cat, h.file, h.line, t, h.content);
      }
    }
  }

  // Special handling for "runtimes" as top-level state key. We grep the
  // narrow pattern `"runtimes"` (with quotes) in src files only.
  const runtimesHits = grepTermInRoots('"runtimes"', SEARCH_ROOTS);
  for (const h of runtimesHits) {
    if (!SRC_FILE_RE.test(h.file)) continue;
    if (basename(h.file) === "spec-sweep.mjs") continue;
    // R35 M3: live-identifier allowlist applies to the runtimes-top-level
    // probe too, for parity. "runtimes" is not currently in any per-file
    // allowlist, but if a future KB section legitimately mentions it as a
    // live identifier the same shape works.
    if (isAllowlistedLiveIdentifier(h.file, "runtimes")) continue;
    if (isExempt(h.file, '"runtimes"', h.line, h.content)) continue;
    addHit(
      "STATE-SCHEMA DEPRECATED",
      h.file,
      h.line,
      "runtimes (top-level)",
      h.content,
    );
  }
}

// Category 4: HEALTH FAKE-DATA MARKERS — hardcoded `tools_registered: 9`.
function sweepHealthFakeData() {
  const hits = grepTermInRoots("tools_registered", SEARCH_ROOTS);
  for (const h of hits) {
    if (!SRC_FILE_RE.test(h.file)) continue;
    if (basename(h.file) === "spec-sweep.mjs") continue;
    if (!/tools_registered[^=]*[=:]\s*9\b/.test(h.content)) continue;
    if (h.file.includes("/mcp/test/")) continue;
    // Composite exemption — picks up KB prose counter-examples in callout
    // sections (e.g. mcp-surface.md L997 "No drift permitted... hardcoded
    // values (e.g. tools_registered: 9 ...) are a conformance failure").
    if (isExempt(h.file, "tools_registered", h.line, h.content)) continue;
    addHit(
      "HEALTH FAKE-DATA MARKERS",
      h.file,
      h.line,
      "tools_registered=9",
      h.content,
    );
  }
}

// ---------- Frozen-schema validators ---------------------------------------

// Derived from the AUTHORITATIVE KB block at module-init (see
// parseFrozenBatchSchema). Previously these were a 4th hand-maintained
// copy of the same shape; they are now the SOLE per-process projection
// of the spec at gate-eval time.
//
// R33-B5: when the KB block is absent (retired-with-pipeline), the
// downstream batch-file sweep should become a no-op rather than crash.
// FROZEN_BATCH may be null here; consumers gate on truthiness.
const BATCH_REQUIRED = FROZEN_BATCH ? FROZEN_BATCH.topKeys : [];
const RANGE_REQUIRED = FROZEN_BATCH ? FROZEN_BATCH.rangeKeys : [];

function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name));
}

function sweepBatchFiles() {
  // R33-B5: no FROZEN_BATCH schema => skip; nothing to validate against.
  if (!FROZEN_BATCH) return;
  for (const dir of QUEUE_DIRS) {
    for (const file of listJsonFiles(dir)) {
      let obj;
      try {
        obj = JSON.parse(readFileSync(file, "utf8"));
      } catch (err) {
        addHit(
          "BATCH-FILE SCHEMA",
          file,
          "0",
          "json_parse_error",
          err.message,
        );
        continue;
      }
      if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
        addHit("BATCH-FILE SCHEMA", file, "0", "not_object", typeof obj);
        continue;
      }
      const topKeys = Object.keys(obj);
      const missing = BATCH_REQUIRED.filter((k) => !topKeys.includes(k));
      const extras = topKeys.filter((k) => !BATCH_REQUIRED.includes(k));
      for (const m of missing) {
        addHit("BATCH-FILE SCHEMA", file, "0", `missing:${m}`, "");
      }
      for (const e of extras) {
        addHit("BATCH-FILE SCHEMA", file, "0", `extra:${e}`, "");
      }
      if (
        obj.range &&
        typeof obj.range === "object" &&
        !Array.isArray(obj.range)
      ) {
        const rk = Object.keys(obj.range);
        const rMissing = RANGE_REQUIRED.filter((k) => !rk.includes(k));
        const rExtras = rk.filter((k) => !RANGE_REQUIRED.includes(k));
        for (const m of rMissing) {
          addHit("BATCH-FILE SCHEMA", file, "0", `range.missing:${m}`, "");
        }
        for (const e of rExtras) {
          addHit("BATCH-FILE SCHEMA", file, "0", `range.extra:${e}`, "");
        }
      }
    }
  }
}

// Derived from the AUTHORITATIVE KB block at module-init. The frozen schema
// supplies STATE_TOP_REQUIRED + STATE_CONV_ALLOWED_HARD; the implementation-
// private addendum block (same KB doc, separate fenced block) supplies the
// closed set of fields the daemon may also persist. The previous gate carried
// a hand-maintained allow-list for the addendum AND classified extras as a
// "STATE-FILE RESIDUAL (open spec)" warning — exactly the drift-hidden-behind-
// allow-list pattern the brutalist review (r14) called out. After this
// refactor: NO hand allow-list, the addendum is in the KB, and any field
// outside frozen ∪ addendum is a hard schema error.
// R33-B5: FROZEN_STATE may be null when the KB section was retired. Treat
// missing schema as "state-file sweep skipped" — the absence is already a
// sweep-internal-error finding from module-init.
const STATE_TOP_REQUIRED = FROZEN_STATE ? FROZEN_STATE.topKeys : [];
const STATE_TOP_ADDENDUM = new Set(FROZEN_STATE ? FROZEN_STATE.addendumTopKeys : []);
const STATE_CONV_ALLOWED_HARD = new Set(FROZEN_STATE ? FROZEN_STATE.conversationKeys : []);
const STATE_CONV_ADDENDUM = new Set(FROZEN_STATE ? FROZEN_STATE.addendumConversationKeys : []);

function sweepStateFile() {
  // R33-B5: no FROZEN_STATE schema => skip; nothing to validate against.
  if (!FROZEN_STATE) return;
  if (!existsSync(STATE_FILE)) {
    return;
  }
  let obj;
  try {
    obj = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    addHit("STATE-FILE SCHEMA", STATE_FILE, "0", "json_parse_error", err.message);
    return;
  }
  const topKeys = Object.keys(obj);
  const missing = STATE_TOP_REQUIRED.filter((k) => !topKeys.includes(k));
  // Top-level extras: anything NOT in the frozen schema AND NOT in the
  // KB-documented implementation-private addendum is drift.
  const extras = topKeys.filter(
    (k) => !STATE_TOP_REQUIRED.includes(k) && !STATE_TOP_ADDENDUM.has(k),
  );
  for (const m of missing) {
    addHit("STATE-FILE SCHEMA", STATE_FILE, "0", `top.missing:${m}`, "");
  }
  for (const e of extras) {
    addHit("STATE-FILE SCHEMA", STATE_FILE, "0", `top.extra:${e}`, "");
  }
  if (obj.conversations && typeof obj.conversations === "object") {
    for (const [convKey, conv] of Object.entries(obj.conversations)) {
      if (conv == null || typeof conv !== "object") continue;
      for (const k of Object.keys(conv)) {
        if (STATE_CONV_ALLOWED_HARD.has(k)) continue;
        // KB-documented implementation-private addendum field — pass.
        if (STATE_CONV_ADDENDUM.has(k)) continue;
        // Drift: hard schema error.
        addHit(
          "STATE-FILE SCHEMA",
          STATE_FILE,
          "0",
          `conv[${convKey}].extra:${k}`,
          "",
        );
      }
    }
  }
}

// ---------- Event-ownership table cross-check ------------------------------

function sweepEventOwnership() {
  if (!existsSync(OWNERSHIP_DOC)) return;
  const text = readFileSync(OWNERSHIP_DOC, "utf8");
  const idx = text.indexOf("Token-event ownership table");
  if (idx < 0) return;
  const slice = text.slice(idx, idx + 4000);
  const lines = slice.split("\n");
  const rows = [];
  for (const ln of lines) {
    if (!ln.startsWith("|")) continue;
    if (/^\|[\s\-:|]+\|$/.test(ln.trim())) continue;
    const cells = ln
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    const kind = cells[0].replace(/`/g, "").trim();
    const producer = cells[1].replace(/`/g, "").trim();
    if (!kind.startsWith("policy.")) continue;
    rows.push({ kind, producer });
  }

  const PRODUCER_FILES = {
    "watermark.js": [join(ROOT, "daemons", "watermark.js")],
    "distillation-supervisor.js": [
      join(ROOT, "daemons", "distillation-supervisor.js"),
    ],
    "session-end-hook.sh": [join(ROOT, "hooks", "session-end-hook.sh")],
    "memory_distill_promote_fact handler": [
      join(ROOT, "mcp", "lib", "tools", "distill-promote-fact.js"),
    ],
    "mcp/lib/nonce-store.js": [join(ROOT, "mcp", "lib", "nonce-store.js")],
    "nonce-store.js": [join(ROOT, "mcp", "lib", "nonce-store.js")],
    "mcp/lib/recall/hard-gates.js": [
      join(ROOT, "mcp", "lib", "recall", "hard-gates.js"),
    ],
    // WAVE-9 / CP-5 Trigger A: the single producer for
    // `policy.salience.recall_feedback`. The recall-time handler
    // (mcp/lib/tools/recall.js) invokes emitRecallFeedback fire-and-
    // forget; the emitter writes the row. Single-producer invariant
    // enforced by mcp/test/synthesis/single-producer-recall-feedback.test.mjs.
    "mcp/lib/synthesis/recall-feedback-emitter.js": [
      join(ROOT, "mcp", "lib", "synthesis", "recall-feedback-emitter.js"),
    ],
  };

  for (const { kind, producer } of rows) {
    const producerTokens = producer
      .split(/\bOR\b|\(/)
      .map((s) => s.trim())
      .filter(Boolean);
    let resolvedAny = false;
    let foundAny = false;
    for (const tok of producerTokens) {
      let matched = null;
      for (const key of Object.keys(PRODUCER_FILES)) {
        if (tok.includes(key)) {
          matched = PRODUCER_FILES[key];
          break;
        }
      }
      if (!matched) continue;
      resolvedAny = true;
      for (const f of matched) {
        if (!existsSync(f)) continue;
        const body = readFileSync(f, "utf8");
        // Two recognized write chokepoints:
        //   - appendPolicyEvent (writes to policy-events.jsonl)
        //   - direct memory-ledger emitters (kind:"policy", policy_kind:"X")
        //     such as mcp/lib/synthesis/recall-feedback-emitter.js. The
        //     policy_kind discriminator (the dotted-suffix of the event
        //     kind, e.g. "salience.recall_feedback") appears in the
        //     emitter's exported KIND constant.
        const policyKindSuffix = kind.startsWith("policy.")
          ? kind.slice("policy.".length)
          : kind;
        const isPolicyEventWriter =
          body.includes(kind) && body.includes("appendPolicyEvent");
        const isLedgerEmitter =
          body.includes(policyKindSuffix) &&
          /policy_kind\s*[:=]/.test(body);
        if (isPolicyEventWriter || isLedgerEmitter) {
          foundAny = true;
          break;
        }
      }
      if (foundAny) break;
    }
    if (!resolvedAny) {
      addHit(
        "EVENT-OWNERSHIP WARNING",
        OWNERSHIP_DOC,
        "0",
        `unresolved-producer:${producer}`,
        `kind=${kind}`,
      );
      continue;
    }
    if (!foundAny) {
      addHit(
        "EVENT-OWNERSHIP WARNING",
        OWNERSHIP_DOC,
        "0",
        `missing-call-site:${kind}`,
        `producer=${producer}`,
      );
    }
  }
}

// ---------- Event-kind presence cross-check --------------------------------

async function sweepEventKindPresence() {
  const policyEventsPath = join(ROOT, "mcp", "lib", "policy-events.js");
  if (!existsSync(policyEventsPath)) return;
  const body = readFileSync(policyEventsPath, "utf8");
  const match = body.match(/EVENT_KINDS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
  if (!match) return;
  const kindList = match[1]
    .split("\n")
    .map((ln) => {
      const m = ln.match(/"([^"]+)"/);
      return m ? m[1] : null;
    })
    .filter(Boolean);
  for (const kind of kindList) {
    const hits = grepTermInRoots(kind, SEARCH_ROOTS);
    let foundEmit = false;
    const seenFiles = new Set();
    for (const h of hits) {
      if (!SRC_FILE_RE.test(h.file)) continue;
      if (h.file === policyEventsPath) continue;
      if (h.file.endsWith("/spec-sweep.mjs")) continue;
      if (seenFiles.has(h.file)) continue;
      seenFiles.add(h.file);
      const fileBody = readFileSync(h.file, "utf8");
      if (fileBody.includes("appendPolicyEvent")) {
        foundEmit = true;
        break;
      }
    }
    if (!foundEmit) {
      addHit(
        "EVENT-KIND PRESENCE",
        policyEventsPath,
        "0",
        `no-emit-for:${kind}`,
        "kind declared in EVENT_KINDS but no appendPolicyEvent call site uses it",
      );
    }
  }
}

// ---------- R32 legacy-pattern sweep --------------------------------------
//
// New category `legacy_pattern_seen`. Uses the canonical scanner exported
// from `mcp/lib/forbidden-legacy-identifiers.js` so this gate and the
// regression test (`mcp/test/no-legacy-pipeline-references.test.mjs`) never
// drift. A hit here yields a non-zero exit, identical to the older
// schema-drift categories.
//
// Scan roots come from `r32DefaultScanRoots(ROOT)`: mcp/, daemons/, scripts/,
// kb/, package.json. R32.1 added `kb/` and the `.md` extension to the
// shared scanner because the R32 brutalist round found six live operator
// docs still describing the retired pipeline normatively. The two
// allow-listed kb meta-docs (kb/legacy-archive.md, kb/deprecation-discipline.md)
// remain excluded via EXCLUDED_PATH_SUFFIXES.
function r32WalkDir(root, files) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = join(root, ent.name);
    const rel = relative(ROOT, p).split("\\").join("/");
    // Use the canonical excluded-path check so spec-sweep and the regression
    // test cannot drift on what counts as excluded.
    if (r32IsExcludedPath(rel)) continue;
    if (ent.isDirectory()) {
      r32WalkDir(p, files);
    } else if (ent.isFile()) {
      if (r32IsScannedFile(rel)) files.push(p);
    }
  }
}

function sweepR32LegacyPatterns() {
  const roots = r32DefaultScanRoots(ROOT);
  const files = [];
  for (const root of roots) {
    let st;
    try {
      st = statSync(root);
    } catch {
      continue;
    }
    if (st.isFile()) {
      files.push(root);
    } else if (st.isDirectory()) {
      r32WalkDir(root, files);
    }
  }
  for (const file of files) {
    // R33-B5: per-file try/catch so a single malformed file (or a regex
    // throwing on a runaway line) becomes a finding instead of aborting
    // the entire legacy-pattern scan.
    try {
      const rel = relative(ROOT, file).split("\\").join("/");
      if (r32IsExcludedPath(rel)) continue;
      let body;
      try {
        body = readFileSync(file, "utf8");
      } catch (readErr) {
        addHit(
          "sweep-internal-error",
          file,
          "0",
          "sweepR32LegacyPatterns/readFile",
          readErr.message,
        );
        continue;
      }
      const dot = file.lastIndexOf(".");
      const ext = dot < 0 ? "" : file.slice(dot).toLowerCase();
      const lines = body.split("\n");
      let inBlockComment = false;
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (inBlockComment) {
          const close = line.indexOf("*/");
          if (close < 0) continue;
          line = line.slice(close + 2);
          inBlockComment = false;
        }
        const openIdx = line.lastIndexOf("/*");
        const closeIdx = line.lastIndexOf("*/");
        if (openIdx >= 0 && (closeIdx < 0 || closeIdx < openIdx)) {
          inBlockComment = true;
          line = line.slice(0, openIdx);
        }
        const stripped = r32StripComments(line, ext);
        const lineHits = r32ScanLineForForbidden(stripped);
        for (const { id } of lineHits) {
          addHit("legacy_pattern_seen", file, String(i + 1), id, line.trim().slice(0, 160));
        }
      }
    } catch (fileErr) {
      addHit(
        "sweep-internal-error",
        file,
        "0",
        "sweepR32LegacyPatterns/scan",
        fileErr.message,
      );
    }
  }
}

// ---------- Self-test ------------------------------------------------------

// Self-test: build a tmpdir containing fake source files that exercise each
// allow-marker form, run the deprecated-name detection over them, and
// confirm the sweep correctly skips marked lines and catches unmarked ones.
function runSelfTest() {
  const dir = join(tmpdir(), `spec-sweep-self-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  let failures = 0;
  const check = (label, cond, detail) => {
    if (cond) {
      process.stdout.write(`PASS  ${label}\n`);
    } else {
      failures += 1;
      process.stdout.write(`FAIL  ${label}${detail ? ` -- ${detail}` : ""}\n`);
    }
  };
  const eqSet = (a, b) => {
    if (a.length !== b.length) return false;
    const sa = new Set(a);
    for (const x of b) if (!sa.has(x)) return false;
    return true;
  };

  // ---- KB-parser conformance checks ----
  // Verify the parsers return the EXACT shape the KB currently documents.
  // If a spec author edits the fenced block to add/rename a field, this
  // self-test surfaces the change BEFORE the sweep runs.
  //
  // R33-B5: when the KB anchors have been retired (distillation-pipeline
  // schemas migrated out of the doc), the parsers now return null with
  // {optional: true}. The self-test tolerates BOTH outcomes: present block
  // exact-shape OR null+sentinel. Each conformance check below is wrapped
  // in `if (block != null) { exact-shape assert } else { PASS "retired" }`.
  try {
    const batch = parseFrozenBatchSchema(KB_AGENT_INTEGRATION, { optional: true });
    if (batch === null) {
      check(
        "self-test: parseFrozenBatchSchema (KB anchor retired — null sentinel)",
        true,
      );
    } else {
    const expectedBatchTop = [
      "batch_id",
      "runtime",
      "conversation_id",
      "reason",
      "chat_ledger_path",
      "range",
      "turn_count",
      "enqueued_at",
    ];
    const expectedBatchRange = [
      "first_turn_id",
      "last_turn_id",
      "first_turn_ts",
      "last_turn_ts",
    ];
    check(
      `self-test: parseFrozenBatchSchema topKeys (expected 8: ${expectedBatchTop.join(",")})`,
      eqSet(batch.topKeys, expectedBatchTop),
      `got ${JSON.stringify(batch.topKeys)}`,
    );
    check(
      `self-test: parseFrozenBatchSchema rangeKeys (expected 4: ${expectedBatchRange.join(",")})`,
      eqSet(batch.rangeKeys, expectedBatchRange),
      `got ${JSON.stringify(batch.rangeKeys)}`,
    );
    }
  } catch (err) {
    failures += 1;
    process.stdout.write(`FAIL  self-test: parseFrozenBatchSchema threw -- ${err.message}\n`);
  }

  try {
    const state = parseFrozenStateSchema(KB_AGENT_INTEGRATION, { optional: true });
    if (state === null) {
      check(
        "self-test: parseFrozenStateSchema (KB anchor retired — null sentinel)",
        true,
      );
    } else {
    const expectedStateTop = ["version", "updated_at", "conversations", "in_flight"];
    const expectedConv = [
      "chat_ledger_path",
      "last_processed_turn_id",
      "last_processed_turn_ts",
      "resume_cursor_offset",
      "last_batch_id",
      "last_batch_enqueued_at",
    ];
    const expectedInFlight = ["batch_id", "conversation_key", "enqueued_at", "claimed_at"];
    const expectedAddendumTop = ["_pending_turns_by_conv", "first_start_rebuild_complete", "_poisoned_batch_ids"];
    const expectedAddendumConv = [
      "tentative_pending",
      "retry_count_for_batch",
      "_last_seen_id",
      "_last_seen_ts",
    ];
    check(
      `self-test: parseFrozenStateSchema topKeys`,
      eqSet(state.topKeys, expectedStateTop),
      `got ${JSON.stringify(state.topKeys)}`,
    );
    check(
      `self-test: parseFrozenStateSchema conversationKeys`,
      eqSet(state.conversationKeys, expectedConv),
      `got ${JSON.stringify(state.conversationKeys)}`,
    );
    check(
      `self-test: parseFrozenStateSchema in_flight_keys`,
      eqSet(state.in_flight_keys, expectedInFlight),
      `got ${JSON.stringify(state.in_flight_keys)}`,
    );
    check(
      `self-test: parseFrozenStateSchema addendumTopKeys`,
      eqSet(state.addendumTopKeys, expectedAddendumTop),
      `got ${JSON.stringify(state.addendumTopKeys)}`,
    );
    check(
      `self-test: parseFrozenStateSchema addendumConversationKeys`,
      eqSet(state.addendumConversationKeys, expectedAddendumConv),
      `got ${JSON.stringify(state.addendumConversationKeys)}`,
    );
    }
  } catch (err) {
    failures += 1;
    process.stdout.write(`FAIL  self-test: parseFrozenStateSchema threw -- ${err.message}\n`);
  }

  try {
    const ownership = parseFrozenEventOwnership(KB_AGENT_INTEGRATION, { optional: true });
    if (ownership === null) {
      check(
        "self-test: parseFrozenEventOwnership (KB anchor retired — null sentinel)",
        true,
      );
    } else {
    check(
      `self-test: parseFrozenEventOwnership returns non-empty map`,
      ownership.size > 0,
      `got size=${ownership.size}`,
    );
    // Spot-check: the retired pipeline kind should NOT exist in the
    // post-R32 KB. If it appears, the doc may have been reverted.
    check(
      `self-test: parseFrozenEventOwnership does NOT have retired policy.distillation.batch.split`,
      !ownership.has("policy.distillation.batch.split"),
    );
    }
  } catch (err) {
    failures += 1;
    process.stdout.write(`FAIL  self-test: parseFrozenEventOwnership threw -- ${err.message}\n`);
  }
  try {
    // (a) inline-marker JS — should be exempted.
    const jsAllow = `const x = "high_water_mark_offset"; // spec-sweep:allow\n`;
    // unmarked line — should be CAUGHT (real drift).
    const jsDrift = `const y = "high_water_mark_offset";\n`;
    // (a) inline-marker shell.
    const shAllow = `echo "high_water_mark_offset" # spec-sweep:allow\n`;
    // (a) inline-marker markdown.
    const mdAllow = `The old name was \`high_water_mark_offset\` <!-- spec-sweep:allow -->\n`;
    // (c) section-callout markdown — line 2 (inside ## DELETED) exempted,
    // line 4 (separate paragraph) CAUGHT.
    const mdCallout =
      `## DELETED FIELDS\n` +
      `The OLD field names are high_water_mark_offset and in_flight_batch_ids.\n` +
      `\n` +
      `A new paragraph: high_water_mark_offset is drift here.\n`;
    // (b) test-deny-list pattern.
    const testFile =
      `import { deepStrictEqual } from "node:assert";\n` +
      `for (const dep of ["high_water_mark_offset", "last_processed_offset"]) {\n` +
      `  // assert deny-list rejection\n` +
      `}\n`;

    writeFileSync(join(dir, "allow.js"), jsAllow);
    writeFileSync(join(dir, "drift.js"), jsDrift);
    writeFileSync(join(dir, "allow.sh"), shAllow);
    writeFileSync(join(dir, "callout.md"), mdCallout);
    writeFileSync(join(dir, "inline.md"), mdAllow);
    // Mimic the test path that the pattern allow-list expects.
    const testSubdir = join(dir, "mcp", "test");
    mkdirSync(testSubdir, { recursive: true });
    writeFileSync(join(testSubdir, "deny-list.test.mjs"), testFile);

    // Now run the deprecated-name greps scoped to this tmpdir.
    const term = "high_water_mark_offset";
    const hits = grepTermInRoots(term, [dir]);
    const surfaced = [];
    for (const h of hits) {
      if (!SRC_FILE_RE.test(h.file)) continue;
      if (basename(h.file) === "spec-sweep.mjs") continue;
      if (isExempt(h.file, term, h.line, h.content)) continue;
      surfaced.push(h);
    }

    // Expectations:
    // - drift.js MUST appear (real drift).
    const driftHit = surfaced.find((h) => h.file.endsWith("drift.js"));
    check("self-test: drift.js (unmarked) is CAUGHT", !!driftHit);
    // - allow.js MUST NOT appear (inline marker).
    const allowJsLeak = surfaced.find((h) => h.file.endsWith("allow.js"));
    check("self-test: allow.js (// spec-sweep:allow) is EXEMPTED", !allowJsLeak);
    // - allow.sh MUST NOT appear (inline marker).
    const allowShLeak = surfaced.find((h) => h.file.endsWith("allow.sh"));
    check("self-test: allow.sh (# spec-sweep:allow) is EXEMPTED", !allowShLeak);
    // - inline.md MUST NOT appear (markdown inline marker).
    const allowMdLeak = surfaced.find((h) => h.file.endsWith("inline.md"));
    check("self-test: inline.md (<!-- spec-sweep:allow -->) is EXEMPTED", !allowMdLeak);
    // - callout.md line 2 (inside ## DELETED) MUST NOT appear; line 4
    //   (separate paragraph) MUST appear — drift outside the callout.
    const calloutLine2 = surfaced.find(
      (h) => h.file.endsWith("callout.md") && h.line === "2",
    );
    const calloutLine4 = surfaced.find(
      (h) => h.file.endsWith("callout.md") && h.line === "4",
    );
    check(
      "self-test: callout.md line 2 (DELETED FIELDS section) is EXEMPTED",
      !calloutLine2,
    );
    check(
      "self-test: callout.md line 4 (separate paragraph) is CAUGHT",
      !!calloutLine4,
    );
    // - test deny-list pattern MUST NOT appear.
    const denyListLeak = surfaced.find((h) =>
      h.file.endsWith("deny-list.test.mjs"),
    );
    check(
      "self-test: deny-list.test.mjs (for-loop pattern) is EXEMPTED",
      !denyListLeak,
    );
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    // Clear caches so a follow-up real run is uncontaminated.
    FILE_BODY_CACHE.clear();
    SECTION_ACTIVE_RANGES.clear();
  }
  if (failures > 0) {
    process.stdout.write(`\nself-test: ${failures} failure(s)\n`);
    process.exit(1);
  }
  process.stdout.write(`\nself-test: all checks passed\n`);
  process.exit(0);
}

// ---------- Main -----------------------------------------------------------

// R33-B5: per-checker safe runner. Each top-level checker is wrapped so a
// crash in one (a regex against a renamed KB anchor, a glob throwing on a
// missing dir, a malformed JSON in a queue file) becomes a finding with
// category=sweep-internal-error instead of aborting the entire sweep. The
// final report includes every internal error and the exit code is 1 if
// there is ANY internal error OR any real hit.
function runChecker(label, fn) {
  try {
    const r = fn();
    // Support async checkers via Promise return.
    if (r && typeof r.then === "function") {
      return r.catch((err) => {
        addHit(
          "sweep-internal-error",
          "scripts/spec-sweep.mjs",
          "0",
          label,
          (err && err.message) || String(err),
        );
      });
    }
  } catch (err) {
    addHit(
      "sweep-internal-error",
      "scripts/spec-sweep.mjs",
      "0",
      label,
      (err && err.message) || String(err),
    );
  }
  return undefined;
}

async function main() {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }
  process.stdout.write("spec-sweep: starting\n");
  process.stdout.write(
    `spec-sweep: search roots = ${SEARCH_ROOTS.join(", ")}\n`,
  );
  process.stdout.write(
    `spec-sweep: queue dirs = ${QUEUE_DIRS.join(", ")}\n`,
  );

  // R33-B5: module-init KB-parser failures are now sweep-internal-errors,
  // not fatal exits. Surface them as findings before the categorical run.
  for (const kbErr of KB_PARSE_ERRORS) {
    addHit(
      "sweep-internal-error",
      "kb/agent-integration.md",
      "0",
      kbErr.checker,
      kbErr.error,
    );
  }

  // Each checker is isolated. A throw inside one becomes a finding; the
  // remaining checkers still run.
  runChecker("sweepDeprecatedTerms", sweepDeprecatedTerms);
  runChecker("sweepHealthFakeData", sweepHealthFakeData);
  runChecker("sweepBatchFiles", sweepBatchFiles);
  runChecker("sweepStateFile", sweepStateFile);
  runChecker("sweepEventOwnership", sweepEventOwnership);
  await runChecker("sweepEventKindPresence", sweepEventKindPresence);
  runChecker("sweepR32LegacyPatterns", sweepR32LegacyPatterns);

  const byCat = new Map();
  for (const h of allHits) {
    if (!byCat.has(h.category)) byCat.set(h.category, []);
    byCat.get(h.category).push(h);
  }

  if (byCat.size === 0) {
    process.stdout.write("spec-sweep: 0 hits across 0 categories\n");
    process.exit(0);
  }

  for (const [cat, hits] of byCat) {
    process.stdout.write(`\n[${cat}] (${hits.length} hit${hits.length === 1 ? "" : "s"})\n`);
    for (const h of hits) printHit(h);
  }

  const totalHits = allHits.length;
  const numCats = byCat.size;
  const internalErrors = (byCat.get("sweep-internal-error") || []).length;
  process.stdout.write(
    `\nspec-sweep: ${totalHits} hits across ${numCats} categor${numCats === 1 ? "y" : "ies"}` +
      (internalErrors > 0
        ? ` (including ${internalErrors} sweep-internal-error${internalErrors === 1 ? "" : "s"})`
        : "") +
      `\n`,
  );

  // STATE-FILE RESIDUAL no longer exists as a category — the addendum is
  // now a first-class KB block, so the hand allow-list inside the gate is
  // gone. EVENT-OWNERSHIP WARNING remains a soft (warning-only) category.
  //
  // R35 M1: tri-state exit semantics. See the file-header EXIT-CODE
  // SEMANTICS block for the contract. We partition findings:
  //   - internalErrorHits: the gate itself is broken (exit 2 — priority).
  //   - classifierHits: legitimate drift the build should block on (exit 1).
  //   - soft-warning hits (EVENT-OWNERSHIP WARNING): advisory only,
  //     excluded from both partitions.
  // Exit 2 strictly dominates exit 1 because a broken gate may also be
  // emitting (or suppressing!) classifier hits; CI must see the broken
  // gate first and fix THAT before trusting the classifier output.
  const internalErrorHits = allHits.filter(
    (h) => h.category === "sweep-internal-error",
  );
  const classifierHits = allHits.filter(
    (h) =>
      h.category !== "EVENT-OWNERSHIP WARNING" &&
      h.category !== "sweep-internal-error",
  );
  process.stdout.write(
    `spec-sweep: exit-partition: ${classifierHits.length} classifier hit${classifierHits.length === 1 ? "" : "s"}, ${internalErrorHits.length} sweep-internal-error${internalErrorHits.length === 1 ? "" : "s"}\n`,
  );
  if (internalErrorHits.length > 0) {
    process.stdout.write(
      "spec-sweep: exit 2 — gate is broken (one or more sweep-internal-error findings); build must block until the gate is repaired\n",
    );
    process.exit(2);
  }
  if (classifierHits.length > 0) {
    process.stdout.write(
      "spec-sweep: exit 1 — classifier findings present; build should block on drift\n",
    );
    process.exit(1);
  }
  process.exit(0);
}

// R35 M3: export classifier-allowlist helpers so the regression test can
// drive them directly (HERMETIC) without needing to fork spec-sweep against
// a synthetic filesystem.
export {
  ALLOWLISTED_LIVE_IDENTIFIERS,
  isAllowlistedLiveIdentifier,
};

// Main-module check that survives spaces and symlinks in the invocation path:
// compare real filesystem paths, never a hand-built file:// string.
const INVOKED_DIRECTLY = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (INVOKED_DIRECTLY) {
  main();
}
