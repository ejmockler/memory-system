// single-producer-feature-backfill.test.mjs — CI invariant guard for
// F-CCS-FOUNDATION-feature-backfill-policy § 7.
//
// Asserts that ONLY one file under mcp/lib/** writes rows tagged
// `policy_kind: "feature_backfill"` — the sole producer is
// mcp/lib/synthesis/feature-backfill.js.
//
// RATIONALE
//   Mirrors the W2-CCS / W9 / W11 single-producer pattern. Every
//   policy_kind value in the system has exactly ONE writer file. Without
//   this guard, a future refactor could split backfill emission across the
//   drift-detector, a CLI helper, and the engine, and the recall overlay's
//   "latest by version-then-ts wins" rule would fail to produce a coherent
//   features projection during extractor-version migrations.
//
// W3-CCS RESOLUTION
//   - mcp/lib/synthesis/feature-backfill.js is the SOLE writer.
//   - This test greps every file under mcp/lib/** for the literal
//     "feature_backfill" as a quoted value and asserts ONLY the producer
//     matches.
//   - Test files (under mcp/test/**) and docs/specs are excluded.
//   - kb cross-references and doc comments INSIDE mcp/lib/ are tolerated
//     only when they identify the emitter as the single chokepoint.
//
// Run: node --test test/synthesis/single-producer-feature-backfill.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MCP_LIB_DIR = join(__dirname, "..", "..", "lib");

const ALLOWED_WRITERS = new Set([
  // Sole producer of policy_kind:"feature_backfill" rows.
  join(MCP_LIB_DIR, "synthesis", "feature-backfill.js"),
]);

// Read-side consumers MAY import the FEATURE_BACKFILL_KIND constant but
// MUST NOT inline the literal string. The single-producer test asserts
// the consumer's stripped source does NOT contain the literal as a quoted
// value — i.e. it sources the discriminator from the engine's export.
const ALLOWED_CALLERS = new Set([
  join(MCP_LIB_DIR, "recall", "multi-feature-score.js"),
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
    /'feature_backfill'/,
    /"feature_backfill"/,
    /`feature_backfill`/,
  ];
  for (const p of patterns) {
    if (p.test(stripped)) return true;
  }
  return false;
}

test("single-producer invariant — only feature-backfill.js writes the literal as a value", () => {
  const files = walkJsFiles(MCP_LIB_DIR);
  assert.ok(files.length > 0, "walkJsFiles found at least one file under mcp/lib/");

  const offending = [];
  for (const f of files) {
    if (fileMentionsLiteralOutsideComments(f)) {
      if (!ALLOWED_WRITERS.has(f) && !ALLOWED_CALLERS.has(f)) {
        offending.push(relative(MCP_LIB_DIR, f));
      }
    }
  }
  assert.deepEqual(
    offending,
    [],
    `extra writers detected for "feature_backfill": ${offending.join(", ")}\n` +
      `ONLY mcp/lib/synthesis/feature-backfill.js may write this policy_kind.`,
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
  const emitterPath = join(MCP_LIB_DIR, "synthesis", "feature-backfill.js");
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
    const stat = statSync(f);
    assert.ok(stat.isFile(), `allowed caller ${f} exists as a file`);
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

test("FEATURE_BACKFILL_KIND export matches the discriminator literal", async () => {
  const mod = await import("../../lib/synthesis/feature-backfill.js");
  assert.equal(mod.FEATURE_BACKFILL_KIND, "feature_backfill");
  assert.equal(typeof mod.FEATURE_BACKFILL_VERSION, "string");
  assert.ok(
    mod.FEATURE_BACKFILL_VERSION.length > 0,
    "version export is non-empty",
  );
  assert.equal(mod.FEATURE_BACKFILL_SCHEMA_VERSION, "v1");
});

test("BACKFILL_CAPS is frozen with the spec's fields", async () => {
  const mod = await import("../../lib/synthesis/feature-backfill.js");
  assert.equal(Object.isFrozen(mod.BACKFILL_CAPS), true);
  assert.equal(mod.BACKFILL_CAPS.BATCH_SIZE, 50);
  assert.equal(mod.BACKFILL_CAPS.MAX_WALL_MS, 30000);
  assert.equal(mod.BACKFILL_CAPS.FEATURE_BACKFILL_KIND, "feature_backfill");
});

test("CLI script does NOT contain the literal as a quoted value", () => {
  // §7.3: the CLI is NOT a writer; the literal must live only in the engine.
  const cliPath = join(MCP_LIB_DIR, "..", "scripts", "run-feature-backfill.mjs");
  const stat = statSync(cliPath);
  assert.ok(stat.isFile(), "CLI script exists");
  const src = readFileSync(cliPath, "utf8");
  const stripped = stripJsComments(src);
  assert.equal(
    /'feature_backfill'/.test(stripped),
    false,
    "CLI must not write 'feature_backfill' as a value",
  );
  assert.equal(
    /"feature_backfill"/.test(stripped),
    false,
    "CLI must not write \"feature_backfill\" as a value",
  );
});
