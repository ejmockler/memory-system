// exports-not-anti-tested.test.mjs — R25.6 structural regression for the
// export-vs-lookup bug class.
//
// The R25 bundle shipped 3 instances of this bug. R25.5 fixed those 3 but
// added a 4th (stage0/index.js exported stage0Dispatch but watermark.js +
// salience.js looked up `dispatch`). To prevent a 5th instance, this test:
//
//   1. Asserts every fixed MISMATCH from Phase A still has the expected
//      named export present on the providing module.
//
//   2. Scans the lib/ directory for `_setXxxForTest` setters AND each
//      test file for adapter-shaped uses of them. An adapter that calls
//      the production export under a different name is the anti-test
//      signature: a test shim literally encoding the runtime gap.
//
//   3. Confirms loadModule() throws on missing exports (the structural
//      defense's contract).
//
// HERMETIC: pure import + filesystem read. No external state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// The Stage-0 modules imported below write telemetry under the data root; keep it in a temp root.
process.env.MEMORY_ROOT = mkdtempSync(join(tmpdir(), "exports-not-anti-tested-"));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_ROOT = resolve(__dirname, "..", "..");
const REPO_ROOT = resolve(MCP_ROOT, "..");
const LIB_DIR = join(MCP_ROOT, "lib");
const TEST_DIR = join(MCP_ROOT, "test");

// -----------------------------------------------------------------------------
// 1. Every Phase A MISMATCH provider still exports the expected name.
// -----------------------------------------------------------------------------

test("Phase A MISMATCH #1: stage0/index.js exports `dispatch`", async () => {
  const mod = await import("../../lib/ingest/stage0/index.js");
  assert.equal(
    typeof mod.dispatch,
    "function",
    "stage0/index.js must export `dispatch` (watermark.js:957 lookup)",
  );
});

test("Phase A MISMATCH #2: stage0/index.js dispatch resolves via salience.js lookup", async () => {
  // salience.js:181-184 tries mod.dispatch then mod.default. The R25.6 fix
  // adds both aliases. Verify both resolve to the same callable.
  const mod = await import("../../lib/ingest/stage0/index.js");
  assert.equal(typeof mod.dispatch, "function");
  assert.equal(typeof mod.default, "function");
});

test("Phase A MISMATCH #3: salience.js exports `scoreCandidate`", async () => {
  const mod = await import("../../lib/ingest/salience.js");
  assert.equal(typeof mod.scoreCandidate, "function");
});

test("Phase A MISMATCH #4: distill-promote-fact.js exports `promoteSourceRow`", async () => {
  const mod = await import("../../lib/tools/distill-promote-fact.js");
  assert.equal(typeof mod.promoteSourceRow, "function");
});

// -----------------------------------------------------------------------------
// 2. dispatch signature compatibility: both calling conventions must work.
// -----------------------------------------------------------------------------

test("stage0 dispatch accepts (event) AND (source, event, opts) forms", async () => {
  const { dispatch } = await import("../../lib/ingest/stage0/index.js");
  // 1-arg form (salience.js historically called this way).
  const r1 = dispatch({ source: "imessage", raw_content: { text: "hi" } });
  assert.ok(r1 && typeof r1.decision === "string");
  assert.equal(r1.source, "imessage");
  // 3-arg form (watermark.js call site).
  const r2 = dispatch(
    "imessage",
    { source: "imessage", raw_content: { text: "hi" } },
    { now: Date.now() },
  );
  assert.ok(r2 && typeof r2.decision === "string");
  assert.equal(r2.source, "imessage");
  // 3-arg form where event lacks source — caller's source must stamp it.
  const r3 = dispatch(
    "screentime",
    { raw_content: { stream: "/discoverability/signals" } },
    { now: Date.now() },
  );
  assert.ok(r3 && typeof r3.decision === "string");
});

// -----------------------------------------------------------------------------
// 3. Anti-test scan: no test file may contain an adapter-shaped use of
// _setStage0DispatchForTest that bridges a production export gap.
//
// Adapter signature: `(_src, ev) => stage0Dispatch(ev)`. Plain forced-PASS DI
// like `() => ({ decision: "PASS" })` is LEGITIMATE (hermeticity primitive,
// not a production-bug-bridge) and is allowed.
//
// IMPLEMENTATION NOTE (R25.7 CRIT-A3 fix): the prior implementation ran a
// single regex over the entire file text, which produced false positives
// when the adapter pattern appeared inside `//` line comments or `/* */`
// block comments (e.g. historical-note comments explaining the anti-test
// is forbidden). The fix is to strip comments line-by-line BEFORE applying
// the regex; the regex itself is unchanged. Block comments are tracked
// across lines via a simple `in_comment_block` boolean.
// -----------------------------------------------------------------------------

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...walk(full));
    } else if (
      full.endsWith(".test.mjs") ||
      full.endsWith(".test.js") ||
      full.endsWith(".mjs") ||
      full.endsWith(".js")
    ) {
      out.push(full);
    }
  }
  return out;
}

// Strip line + block comments from JS-ish source so a structural-pattern
// regex sees only executable code. Preserves line count (replaces stripped
// regions with empty strings on the same lines) so reported line numbers
// would still align if surfaced. Conservative — does not parse strings;
// the adapter regex below contains characters that would be syntax errors
// inside a real string literal that also happens to contain `=>`, so the
// edge case is not load-bearing for this gate.
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const rawLine of src.split("\n")) {
    let line = rawLine;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) {
        out.push("");
        continue;
      }
      line = line.slice(end + 2);
      inBlock = false;
    }
    // Strip block comments that open and (optionally) close on this line.
    while (true) {
      const start = line.indexOf("/*");
      if (start === -1) break;
      const end = line.indexOf("*/", start + 2);
      if (end === -1) {
        line = line.slice(0, start);
        inBlock = true;
        break;
      }
      line = line.slice(0, start) + line.slice(end + 2);
    }
    // Strip line comments.
    const lineCommentIdx = line.indexOf("//");
    if (lineCommentIdx !== -1) {
      line = line.slice(0, lineCommentIdx);
    }
    out.push(line);
  }
  return out.join("\n");
}

// Exported only for the SELF-TEST cases below.
function hasAdapterAntiPattern(src) {
  const stripped = stripComments(src);
  return /_setStage0DispatchForTest\s*\(\s*\([^)]*\)\s*=>\s*stage0Dispatch\s*\(/.test(
    stripped,
  );
}

test("SELF-TEST-A: adapter pattern inside a // comment is NOT flagged", () => {
  const synthetic =
    "// _setStage0DispatchForTest((_src, ev) => stage0Dispatch(ev)) is forbidden\n" +
    "const x = 1;\n";
  assert.equal(hasAdapterAntiPattern(synthetic), false);
});

test("SELF-TEST-A2: adapter pattern inside a /* */ block comment is NOT flagged", () => {
  const synthetic =
    "/*\n" +
    " * Historical note: _setStage0DispatchForTest((_src, ev) => stage0Dispatch(ev))\n" +
    " * was the R25.5 anti-test pattern.\n" +
    " */\n" +
    "const x = 1;\n";
  assert.equal(hasAdapterAntiPattern(synthetic), false);
});

test("SELF-TEST-B: bare adapter pattern on a live code line IS flagged", () => {
  const synthetic =
    "_setStage0DispatchForTest((_src, ev) => stage0Dispatch(ev));\n";
  assert.equal(hasAdapterAntiPattern(synthetic), true);
});

test("no test file bridges Stage-0 dispatch via the adapter anti-pattern", () => {
  const files = walk(TEST_DIR);
  const offenders = [];
  for (const f of files) {
    // Exclude this regression test itself — it intentionally contains the
    // pattern inside SELF-TEST-B synthetic strings as part of the gate's
    // own correctness proof.
    if (f === __filename) continue;
    const text = readFileSync(f, "utf8");
    if (hasAdapterAntiPattern(text)) {
      offenders.push(f.replace(REPO_ROOT + "/", ""));
    }
  }
  assert.equal(
    offenders.length,
    0,
    `anti-test adapter found in: ${offenders.join(", ")}\n` +
      "Use the real production export (stage0/index.js exports `dispatch` directly via the R25.6 alias).",
  );
});

// -----------------------------------------------------------------------------
// 4. loadModule structural defense contract.
// -----------------------------------------------------------------------------

test("loadModule throws when an expected export is missing", async () => {
  const { loadModule } = await import("../../lib/lib-loader.js");
  await assert.rejects(
    () =>
      loadModule(
        new URL("../../lib/ingest/stage0/index.js", import.meta.url).href,
        ["dispatch", "thisExportDoesNotExist_R25p6"],
      ),
    /missing expected export/,
  );
});

test("loadModule returns the module when all expected exports present", async () => {
  const { loadModule } = await import("../../lib/lib-loader.js");
  const mod = await loadModule(
    new URL("../../lib/ingest/stage0/index.js", import.meta.url).href,
    ["dispatch", "stage0Dispatch", "listSources"],
  );
  assert.equal(typeof mod.dispatch, "function");
  assert.equal(typeof mod.stage0Dispatch, "function");
  assert.equal(typeof mod.listSources, "function");
});

test("loadModule rejects non-string specifier", async () => {
  const { loadModule } = await import("../../lib/lib-loader.js");
  await assert.rejects(() => loadModule("", ["x"]), /non-empty string/);
  await assert.rejects(
    () =>
      loadModule(
        new URL("../../lib/ingest/stage0/index.js", import.meta.url).href,
        [],
      ),
    /non-empty string array/,
  );
});
