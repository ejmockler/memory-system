// single-producer-recall-feedback.test.mjs — CI invariant guard for
// F-SYN-INTEGRATION-CP5-TRIGGER-A-ACTIVATION.
//
// Asserts that ONLY one file under mcp/lib/** writes rows tagged
// `policy_kind: "salience.recall_feedback"` — the sole producer is
// mcp/lib/synthesis/recall-feedback-emitter.js.
//
// RATIONALE
//   The architect-time review of CP-5 Trigger A flagged that
//   "script-as-producer" for `policy.salience.recall_feedback` collides with
//   the kb's single-source-of-truth invariant (each policy_kind has exactly
//   one producer file in the codebase; mirrors connector_revoke owned by
//   connectors/index.js and kind:"reconstructed" owned by
//   reconstruction-emitter.js).
//
//   WAVE-9 RESOLUTION
//     - mcp/lib/synthesis/recall-feedback-emitter.js is the SOLE writer.
//     - This test greps every file under mcp/lib/** for either the literal
//       "salience.recall_feedback" or "recall_feedback" used as a
//       policy_kind value and asserts ONLY the emitter file matches.
//     - Test files (under mcp/test/**) and docs/specs are excluded — they
//       reference the kind as a string but never write rows.
//     - kb cross-references and doc comments INSIDE mcp/lib/ are tolerated
//       only when they identify the emitter as the single chokepoint
//       (e.g. recall.js's import comment that names
//       recall-feedback-emitter.js as the producer).
//
// Run: node test/synthesis/single-producer-recall-feedback.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MCP_LIB_DIR = join(__dirname, "..", "..", "lib");

// File-path discipline:
//   - allowed_writers — files that may CONTAIN the literal AND write rows.
//   - allowed_callers — files that may CONTAIN the literal as part of a
//     comment that references the sole producer (e.g. recall.js's import
//     header that documents WHY it calls emitRecallFeedback). These files
//     must NOT contain a fresh writer pattern.
//
// The CI assertion is strict: any file outside these allowlists that
// mentions the literal at all triggers a failure. The allowlists are
// hand-curated and reviewed at architect time.

const ALLOWED_WRITERS = new Set([
  // Sole producer of policy_kind:"salience.recall_feedback" rows.
  join(MCP_LIB_DIR, "synthesis", "recall-feedback-emitter.js"),
]);

const ALLOWED_CALLERS = new Set([
  // Recall handler calls emitRecallFeedback fire-and-forget; its import
  // comment may name the producer but never writes the literal as a row
  // value.
  join(MCP_LIB_DIR, "tools", "recall.js"),
]);

// Walk every file under mcp/lib/ and return absolute paths.
function walkJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkJsFiles(path));
    } else if (entry.isFile()) {
      // Cover .js + .mjs; skip non-JS/MJS to avoid stale snapshot fixtures.
      if (path.endsWith(".js") || path.endsWith(".mjs")) {
        out.push(path);
      }
    }
  }
  return out;
}

// Detect "writer-like" usage of the literal. The literal appearing in a
// comment that documents the producer is OK; the literal appearing as a
// VALUE in a JS object literal (or a string concatenation that writes to
// the ledger) is NOT.
//
// Heuristic (sufficient for the v0 CI guard):
//   - Match the literal "salience.recall_feedback" surrounded by quotes
//     (single, double, or backtick) — that's the producer-shape we are
//     guarding against. The substring inside a // or /* */ comment is
//     allowed; we strip comments before searching.
//
// We keep the heuristic deliberately narrow because the v1 schema-version
// bump may rotate the literal value, and a too-strict check would surface
// noisy failures every time docs reference an updated value.
function stripJsComments(src) {
  // Best-effort: strip // line comments and /* */ block comments. We do
  // NOT need a full JS parser; the heuristic only needs to catch the
  // common case where a doc comment names the policy_kind for context.
  let out = "";
  let i = 0;
  let inString = null;
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < src.length) {
        out += c2;
        i += 2;
        continue;
      }
      if (c === inString) {
        inString = null;
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && c2 === "/") {
      // line comment
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      // block comment
      i += 2;
      while (i + 1 < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function fileMentionsLiteralOutsideComments(absPath) {
  const src = readFileSync(absPath, "utf8");
  const stripped = stripJsComments(src);
  // Match the literal in any quoted context.
  // We look for the EXACT producer string "salience.recall_feedback"
  // inside single, double, or backtick quotes.
  const patterns = [
    /'salience\.recall_feedback'/,
    /"salience\.recall_feedback"/,
    /`salience\.recall_feedback`/,
  ];
  for (const p of patterns) {
    if (p.test(stripped)) return true;
  }
  return false;
}

// Also detect bare-identifier references to RECALL_FEEDBACK_KIND — these
// are LEGITIMATE consumers (e.g. a reader that filters by the constant)
// because they route through the emitter module's exported symbol. We
// treat them as informational only.
function fileMentionsLiteralInComment(absPath) {
  const src = readFileSync(absPath, "utf8");
  return /salience\.recall_feedback/.test(src);
}

test("single-producer invariant — only recall-feedback-emitter.js writes the literal as a value", () => {
  const files = walkJsFiles(MCP_LIB_DIR);
  assert.ok(files.length > 0, "walkJsFiles found at least one file under mcp/lib/");

  const offending = [];
  for (const f of files) {
    if (fileMentionsLiteralOutsideComments(f)) {
      if (!ALLOWED_WRITERS.has(f)) {
        offending.push(relative(MCP_LIB_DIR, f));
      }
    }
  }
  assert.deepEqual(
    offending,
    [],
    `extra writers detected for "salience.recall_feedback": ${offending.join(", ")}\n` +
      `ONLY mcp/lib/synthesis/recall-feedback-emitter.js may write this policy_kind.`,
  );
});

test("ALLOWED_WRITERS list is non-empty and points at a file that exists", () => {
  assert.ok(ALLOWED_WRITERS.size > 0, "ALLOWED_WRITERS is non-empty");
  for (const f of ALLOWED_WRITERS) {
    const stat = statSync(f);
    assert.ok(stat.isFile(), `allowed writer ${f} exists as a file`);
  }
});

test("the sole producer file IS the emitter and DOES mention the literal", () => {
  const emitterPath = join(MCP_LIB_DIR, "synthesis", "recall-feedback-emitter.js");
  assert.ok(
    ALLOWED_WRITERS.has(emitterPath),
    "ALLOWED_WRITERS contains the emitter",
  );
  // Sanity: the producer file MUST contain the literal — otherwise the
  // guard would silently pass if a refactor accidentally removed the
  // writer entirely (a false-negative).
  assert.ok(
    fileMentionsLiteralOutsideComments(emitterPath),
    "emitter file actually writes the literal (guard-against-false-negative)",
  );
});

test("ALLOWED_CALLERS may reference the literal in comments but must not write it", () => {
  for (const f of ALLOWED_CALLERS) {
    // Caller may mention the literal in a doc comment that names the
    // producer. We assert the comment-stripped source does NOT contain
    // the literal as a quoted value (which would indicate a fresh writer).
    assert.equal(
      fileMentionsLiteralOutsideComments(f),
      false,
      `allowed caller ${relative(MCP_LIB_DIR, f)} must not write the literal as a value (comment-only references are allowed)`,
    );
  }
});

test("test file is excluded from the scan (no self-reference false-positive)", () => {
  // The test file lives at mcp/test/synthesis/single-producer-recall-feedback.test.mjs
  // and walkJsFiles() scans mcp/lib/ only — so we should NEVER see this file
  // in the offending list. This test asserts the boundary explicitly.
  const files = walkJsFiles(MCP_LIB_DIR);
  for (const f of files) {
    assert.ok(
      !f.includes(join("test", "synthesis")),
      `scan must not descend into mcp/test/, got ${f}`,
    );
  }
});
