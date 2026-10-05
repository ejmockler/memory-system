// single-producer-forgetting-cascade.test.mjs — CI invariant guard for
// F-SYN-BEHAVIOR-forgetting-propagation-through-synthesis.
//
// Asserts that ONLY one file under mcp/lib/** writes rows tagged
// `policy_kind: "derivation.cascade_orphan"` — the sole producer is
// mcp/lib/synthesis/forgetting-propagation.js.
//
// RATIONALE
//   Mirrors the W9 single-producer-recall-feedback CI invariant: every
//   policy_kind value in the system has exactly ONE writer file. Without
//   this guard, a future refactor could split the cascade emission across
//   tools/exclude.js + the synthesis module + a daemon, and the audit
//   ledger would no longer round-trip through a single chokepoint (the
//   propagation-cascade audit would skew under hostile drift).
//
//   WAVE-11 RESOLUTION
//     - mcp/lib/synthesis/forgetting-propagation.js is the SOLE writer.
//     - This test greps every file under mcp/lib/** for the literal
//       "derivation.cascade_orphan" as a quoted value and asserts ONLY the
//       producer file matches.
//     - Test files (under mcp/test/**) and docs/specs are excluded — they
//       reference the kind as a string but never write rows.
//     - kb cross-references and doc comments INSIDE mcp/lib/ are tolerated
//       only when they identify the emitter as the single chokepoint.
//
// Run: node test/synthesis/single-producer-forgetting-cascade.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MCP_LIB_DIR = join(__dirname, "..", "..", "lib");

// File-path discipline mirrors single-producer-recall-feedback.test.mjs.
const ALLOWED_WRITERS = new Set([
  // Sole producer of policy_kind:"derivation.cascade_orphan" rows.
  join(MCP_LIB_DIR, "synthesis", "forgetting-propagation.js"),
]);

const ALLOWED_CALLERS = new Set([
  // exclude.js calls propagateForgettingThroughSynthesis fire-and-forget;
  // its caller comment may name the producer but never writes the literal
  // as a row value.
  join(MCP_LIB_DIR, "tools", "exclude.js"),
]);

function walkJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkJsFiles(path));
    } else if (entry.isFile()) {
      if (path.endsWith(".js") || path.endsWith(".mjs")) {
        out.push(path);
      }
    }
  }
  return out;
}

// Strip comments before searching so a header doc mentioning the literal
// (allowed) does not trigger a false positive.
function stripJsComments(src) {
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
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
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
  const patterns = [
    /'derivation\.cascade_orphan'/,
    /"derivation\.cascade_orphan"/,
    /`derivation\.cascade_orphan`/,
  ];
  for (const p of patterns) {
    if (p.test(stripped)) return true;
  }
  return false;
}

test("single-producer invariant — only forgetting-propagation.js writes the literal as a value", () => {
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
    `extra writers detected for "derivation.cascade_orphan": ${offending.join(", ")}\n` +
      `ONLY mcp/lib/synthesis/forgetting-propagation.js may write this policy_kind.`,
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
  const emitterPath = join(MCP_LIB_DIR, "synthesis", "forgetting-propagation.js");
  assert.ok(
    ALLOWED_WRITERS.has(emitterPath),
    "ALLOWED_WRITERS contains the emitter",
  );
  assert.ok(
    fileMentionsLiteralOutsideComments(emitterPath),
    "emitter file actually writes the literal (guard-against-false-negative)",
  );
});

test("ALLOWED_CALLERS may reference the literal in comments but must not write it", () => {
  for (const f of ALLOWED_CALLERS) {
    // Caller exists.
    const stat = statSync(f);
    assert.ok(stat.isFile(), `allowed caller ${f} exists as a file`);
    // Comment-stripped source does NOT contain the literal as a value.
    assert.equal(
      fileMentionsLiteralOutsideComments(f),
      false,
      `allowed caller ${relative(MCP_LIB_DIR, f)} must not write the literal as a value (comment-only references are allowed)`,
    );
  }
});

test("test directory is excluded from the scan (no self-reference false-positive)", () => {
  const files = walkJsFiles(MCP_LIB_DIR);
  for (const f of files) {
    assert.ok(
      !f.includes(join("test", "synthesis")),
      `scan must not descend into mcp/test/, got ${f}`,
    );
  }
});

test("PROPAGATION_CASCADE_KIND export matches the discriminator literal", async () => {
  // Import the module and verify the constant export equals the literal —
  // catches a refactor that renames the constant but leaves the literal
  // string drifting.
  const mod = await import("../../lib/synthesis/forgetting-propagation.js");
  assert.equal(mod.PROPAGATION_CASCADE_KIND, "derivation.cascade_orphan");
  assert.equal(mod.FORGETTING_PROPAGATION_VERSION, "v0.1.0");
});
