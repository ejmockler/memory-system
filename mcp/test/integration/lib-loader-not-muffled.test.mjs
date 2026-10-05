// lib-loader-not-muffled.test.mjs — R25.7 CRIT-A1 regression.
//
// R25.6 shipped lib-loader.js as a structural defense against the
// export-vs-lookup bug class: loadModule() throws a clear error if any
// expected named export is missing. R25.6 brutalist found that the
// throw was muffled at the callers — watermark.js wrapped each call in
// catch{}, and salience.js did the same. The R25.5 silent-fallthrough
// failure mode was preserved at runtime.
//
// R25.7 removes those catch{} wraps. This test pins the fix three ways:
//
//   T1. The structural-defense contract: loadModule() throws on a
//       synthetic module missing an expected export, with a clear
//       message that includes the missing name.
//
//   T2. Source-level static-grep on watermark.js: no try/catch wrap
//       around a loadModule(...) call. The "missing expected export"
//       throw must propagate.
//
//   T3. Source-level static-grep on salience.js: same.
//
// HERMETIC: synthetic-module write + filesystem read. No external state,
// no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_ROOT = resolve(__dirname, "..", "..");
const REPO_ROOT = resolve(MCP_ROOT, "..");

// ---------------------------------------------------------------------------
// T1. loadModule throws on a synthetic module missing an expected export.
// ---------------------------------------------------------------------------

test("R25.7 CRIT-A1 T1: loadModule throws clear error on missing export", async () => {
  const tmp = join(tmpdir(), `lib-loader-muffle-${process.pid}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const modPath = join(tmp, "synthetic-mod.mjs");
    // Provider exports `present`; caller asks for `absent`.
    writeFileSync(
      modPath,
      "export function present() { return 1; }\n",
      "utf8",
    );

    const { loadModule } = await import(
      pathToFileURL(join(MCP_ROOT, "lib", "lib-loader.js")).href
    );

    let threw = null;
    try {
      await loadModule(pathToFileURL(modPath).href, ["absent"]);
    } catch (err) {
      threw = err;
    }

    assert.ok(threw != null, "loadModule MUST throw on missing export");
    assert.ok(
      threw instanceof Error,
      "thrown value MUST be an Error instance",
    );
    assert.ok(
      /missing expected export/.test(threw.message),
      "error message MUST include 'missing expected export' (got: " +
        threw.message +
        ")",
    );
    assert.ok(
      /absent/.test(threw.message),
      "error message MUST name the missing export (got: " +
        threw.message +
        ")",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T2 + T3 helpers: strip comments, then scan for a try{...}catch wrap that
// contains `loadModule(` in its try-block.
//
// The strip is essential — the surrounding source contains MANY comment
// blocks that mention loadModule, catch, and try/catch. Without stripping,
// the regex would match commentary instead of code.
// ---------------------------------------------------------------------------

function stripComments(src) {
  // Strip /* ... */ block comments (non-greedy, multi-line).
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip // line comments to end-of-line.
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1);
  return out;
}

// Scan stripped source for `try { ... loadModule( ... } catch` where the
// loadModule call is INSIDE the try block. We walk braces to find the
// matching close brace of each `try {` and check whether `} catch` follows.
function findMuffledLoadModule(stripped) {
  const hits = [];
  const tryRe = /\btry\s*\{/g;
  let m;
  while ((m = tryRe.exec(stripped)) != null) {
    const start = m.index;
    const openBrace = m.index + m[0].length - 1;
    let depth = 1;
    let i = openBrace + 1;
    while (i < stripped.length && depth > 0) {
      const c = stripped[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    if (depth !== 0) continue; // unbalanced — skip
    const close = i - 1;
    const body = stripped.slice(openBrace + 1, close);
    // What follows the close brace? Skip whitespace.
    let j = close + 1;
    while (j < stripped.length && /\s/.test(stripped[j])) j++;
    const followedByCatch = stripped.slice(j, j + 5) === "catch";
    if (followedByCatch && /\bloadModule\s*\(/.test(body)) {
      hits.push({ start, body: body.slice(0, 240) });
    }
  }
  return hits;
}

test("R25.7 CRIT-A1 T2: watermark.js has no try/catch wrap around loadModule", () => {
  const src = readFileSync(
    join(REPO_ROOT, "daemons", "watermark.js"),
    "utf8",
  );
  const stripped = stripComments(src);
  // Sanity: the file must actually call loadModule (otherwise the test
  // is vacuously passing).
  assert.ok(
    /\bloadModule\s*\(/.test(stripped),
    "watermark.js MUST call loadModule (file content changed?)",
  );
  const hits = findMuffledLoadModule(stripped);
  assert.equal(
    hits.length,
    0,
    "watermark.js MUST NOT wrap loadModule() in try{...}catch — the " +
      "structural defense's throw would be muffled. Hits: " +
      JSON.stringify(hits, null, 2),
  );
});

test("R25.7 CRIT-A1 T3: salience.js has no try/catch wrap around loadModule", () => {
  const src = readFileSync(
    join(MCP_ROOT, "lib", "ingest", "salience.js"),
    "utf8",
  );
  const stripped = stripComments(src);
  assert.ok(
    /\bloadModule\s*\(/.test(stripped),
    "salience.js MUST call loadModule (file content changed?)",
  );
  const hits = findMuffledLoadModule(stripped);
  assert.equal(
    hits.length,
    0,
    "salience.js MUST NOT wrap loadModule() in try{...}catch — the " +
      "structural defense's throw would be muffled. Hits: " +
      JSON.stringify(hits, null, 2),
  );
});
