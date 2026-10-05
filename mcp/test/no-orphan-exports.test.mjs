// no-orphan-exports.test.mjs
//
// R33 B4-bonus: orphan-export detector.
//
// Companion to B3 (no-orphan-test-imports). Where B3 flags TESTS that import
// production symbols that no longer exist, this gate flags PRODUCTION exports
// that nothing in the workspace calls. Both gates catch the same drift class
// (R32 removed code; cleanup landed partially; references survive in one
// direction or the other) but from opposite directions.
//
// Algorithm (informational mode, the default):
//   1. Walk mcp/lib/**/*.js and parse every named export declaration:
//        export function NAME(...) {...}
//        export const NAME = ...
//        export class NAME {...}
//        export { NAME, NAME2 as ALIAS } from "..."  (re-export forms)
//      We do NOT parse default exports (anonymous; orphan check is moot).
//   2. For each exported NAME: grep the workspace for any reference to NAME
//      that is not the export-site itself. Caller search paths:
//        mcp/, daemons/, scripts/
//      Excludes: node_modules/, .git/, the export-site file itself, reviews/.
//   3. If caller count == 0: record NAME as a candidate orphan.
//
// Output mode:
//   - DEFAULT (informational): prints the orphan list to stdout, exits 0.
//     The build does not fail. Orphans are operator-judgment-needed; some
//     exports legitimately exist for manual MCP-tool calls (e.g.
//     memory_distill_promote_fact's verifyToken helper).
//   - STRICT (env ORPHAN_EXPORTS_STRICT=1): exits 1 if any orphan remains
//     that is not on the EXCLUDE_FROM_ORPHAN_CHECK allow-list. Reserved
//     for a future round that has triaged the current orphan set.
//
// Exclusions (allow-list of legitimate-but-uncalled exports):
//   - Tool TOOL exports (TOOL is the MCP dispatcher's discovery shape; the
//     dispatcher reads it by directory scan, not by static import). Detected
//     by symbol name `TOOL`.
//   - Tool dispatch handlers (callable via MCP envelope, not from JS):
//     symbols named `handle*` in mcp/lib/tools/**.
//   - lib-loader.js exports (legitimate stand-alone reach: dynamic-import
//     surface used by external harnesses).
//   - api-key-pool surface (lib/gemini-client.js key-pool helpers used by
//     manual operator calls).
//   - Anything in mcp/lib/forbidden-legacy-identifiers.js (the list file
//     exports definitional constants).
//
// Self-test fixtures (under /tmp): a fake lib file with one orphaned export
// and one referenced export. Asserts the detector flags the orphan and not
// the referenced one.
//
// Run: node test/no-orphan-exports.test.mjs
//
// ES module. No external deps.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const MEMORY_SYSTEM_ROOT = resolve(dirname(THIS_FILE), "..", "..");
const LIB_ROOT = join(MEMORY_SYSTEM_ROOT, "mcp", "lib");

// ---------- export parsing ---------------------------------------------------

// Returns array of `{ file, name, lineNo }` for every named export found in
// the file at absPath. Forms recognized (anchored to line start, allowing
// leading whitespace):
//   export function NAME(
//   export async function NAME(
//   export const NAME =
//   export let NAME =
//   export var NAME =
//   export class NAME {
//   export { A, B as C }    // grouped export (no `from` re-export)
//
// Default exports are skipped (no name to track).
export function parseExports(absPath) {
  let body;
  try {
    body = readFileSync(absPath, "utf8");
  } catch {
    return [];
  }
  const out = [];
  const lines = body.split("\n");

  const reFn = /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;
  const reConstLetVar = /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/;
  const reClass = /^\s*export\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[{\s]/;
  const reGroup = /^\s*export\s*\{([^}]*)\}/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(reFn))) {
      out.push({ file: absPath, name: m[1], lineNo: i + 1 });
      continue;
    }
    if ((m = line.match(reConstLetVar))) {
      out.push({ file: absPath, name: m[1], lineNo: i + 1 });
      continue;
    }
    if ((m = line.match(reClass))) {
      out.push({ file: absPath, name: m[1], lineNo: i + 1 });
      continue;
    }
    if ((m = line.match(reGroup))) {
      // grouped: each comma-separated entry, allow `X as Y` (use Y).
      const inner = m[1];
      for (const raw of inner.split(",")) {
        const part = raw.trim();
        if (!part) continue;
        const asIdx = part.indexOf(" as ");
        const sym = asIdx >= 0 ? part.slice(asIdx + 4).trim() : part;
        // Strip trailing/leading non-identifier chars (defensive).
        const clean = sym.match(/[A-Za-z_$][A-Za-z0-9_$]*/);
        if (clean) {
          out.push({ file: absPath, name: clean[0], lineNo: i + 1 });
        }
      }
    }
  }
  return out;
}

// ---------- caller search ----------------------------------------------------

// Returns the number of times `name` appears as an identifier-token (bounded
// match) across the given absolute file roots, EXCLUDING the export-site
// file. Lines inside `// ...` comments are ignored (a stale doc-comment is
// not a real caller). Block comments are NOT stripped (cheap heuristic).
export function countCallers(name, fileRoots, exportSiteAbs) {
  const re = new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`);
  let total = 0;

  for (const root of fileRoots) {
    let st;
    try {
      st = statSync(root);
    } catch {
      continue;
    }
    if (st.isFile()) {
      total += countInFile(re, root, exportSiteAbs);
    } else if (st.isDirectory()) {
      for (const file of walkJs(root)) {
        total += countInFile(re, file, exportSiteAbs);
      }
    }
  }
  return total;
}

function countInFile(re, absPath, exportSiteAbs) {
  if (absPath === exportSiteAbs) return 0;
  let body;
  try {
    body = readFileSync(absPath, "utf8");
  } catch {
    return 0;
  }
  let n = 0;
  for (const raw of body.split("\n")) {
    // Strip `// comment` to EOL.
    const slash = raw.indexOf("//");
    const line = slash >= 0 ? raw.slice(0, slash) : raw;
    if (re.test(line)) n += 1;
  }
  return n;
}

function* walkJs(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = join(root, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "reviews"
          || ent.name === "dist" || ent.name === "build" || ent.name === "vendor") {
        continue;
      }
      yield* walkJs(p);
    } else if (ent.isFile()) {
      if (p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".cjs")) yield p;
    }
  }
}

// ---------- allow-list -------------------------------------------------------

// Symbol-name allow-list: these export names are NEVER orphans regardless of
// caller count. Rationale per name documented above (file-level comment).
const ALLOWED_SYMBOL_NAMES = new Set([
  "TOOL",         // MCP dispatcher discovery shape
]);

// File-path-suffix allow-list: every export in these files is exempt.
const ALLOWED_FILE_SUFFIXES = [
  "mcp/lib/forbidden-legacy-identifiers.js",  // definitional list exports
  "mcp/lib/lib-loader.js",                    // dynamic-import surface
  "mcp/lib/error-codes.js",                   // shared constants surface
];

// Symbol-prefix allow-list: any symbol matching one of these prefixes in a
// file under mcp/lib/tools/** is exempt (MCP envelope-callable handlers).
const ALLOWED_TOOL_HANDLER_PREFIXES = ["handle", "TOOL"];

function isExportAllowed({ file, name }) {
  if (ALLOWED_SYMBOL_NAMES.has(name)) return true;
  for (const suf of ALLOWED_FILE_SUFFIXES) {
    if (file.replace(/\\/g, "/").endsWith(suf)) return true;
  }
  if (file.replace(/\\/g, "/").includes("/mcp/lib/tools/")) {
    for (const pre of ALLOWED_TOOL_HANDLER_PREFIXES) {
      if (name.startsWith(pre)) return true;
    }
  }
  return false;
}

// ---------- main scan --------------------------------------------------------

function relFromRoot(absPath) {
  return relative(MEMORY_SYSTEM_ROOT, absPath).split("\\").join("/");
}

function findOrphans() {
  // 1. Collect every export across mcp/lib/**.
  const allExports = [];
  for (const file of walkJs(LIB_ROOT)) {
    allExports.push(...parseExports(file));
  }

  // 2. Caller roots: workspace minus reviews/, node_modules/.
  const fileRoots = [
    join(MEMORY_SYSTEM_ROOT, "mcp"),
    join(MEMORY_SYSTEM_ROOT, "daemons"),
    join(MEMORY_SYSTEM_ROOT, "scripts"),
  ];

  // 3. Per-export caller count.
  const orphans = [];
  const exempts = [];
  for (const exp of allExports) {
    if (isExportAllowed(exp)) {
      exempts.push(exp);
      continue;
    }
    const n = countCallers(exp.name, fileRoots, exp.file);
    if (n === 0) orphans.push(exp);
  }
  return { allExports, orphans, exempts };
}

// ---------- self-test --------------------------------------------------------

function runSelfTest() {
  const dir = mkdtempSync(join(tmpdir(), "orphan-exports-self-test-"));
  try {
    // Fixture A: export ORPHANED_FN that nothing calls.
    const fixA = join(dir, "lib-fixture.js");
    writeFileSync(
      fixA,
      [
        "export function ORPHANED_FN() { return 1; }",
        "export const REFERENCED_CONST = 42;",
        "export class ORPHANED_CLASS {}",
        "export { GROUPED_SYM };",
        "function GROUPED_SYM() {}",
      ].join("\n") + "\n",
    );
    // Fixture B: a caller that references REFERENCED_CONST only.
    const fixB = join(dir, "caller.js");
    writeFileSync(fixB, 'import { REFERENCED_CONST } from "./lib-fixture.js";\nconsole.log(REFERENCED_CONST);\n');

    // Assertion 1: parseExports finds all four named exports in fixA.
    const exports = parseExports(fixA);
    const names = exports.map((e) => e.name).sort();
    assert.deepEqual(
      names,
      ["GROUPED_SYM", "ORPHANED_CLASS", "ORPHANED_FN", "REFERENCED_CONST"],
      "(1) parseExports: expected four named exports, got " + JSON.stringify(names),
    );

    // Assertion 2: countCallers returns 0 for ORPHANED_FN, >=1 for REFERENCED_CONST.
    const orphanCount = countCallers("ORPHANED_FN", [dir], fixA);
    const refCount = countCallers("REFERENCED_CONST", [dir], fixA);
    assert.equal(orphanCount, 0, "(2) ORPHANED_FN must have 0 callers, got " + orphanCount);
    assert.ok(refCount >= 1, "(2) REFERENCED_CONST must have >=1 callers, got " + refCount);

    // Assertion 3: allow-list works — TOOL symbol is exempt.
    assert.equal(
      isExportAllowed({ file: "/whatever/mcp/lib/tools/foo.js", name: "TOOL" }),
      true,
      "(3) TOOL symbol must be allow-listed",
    );
    assert.equal(
      isExportAllowed({ file: "/whatever/mcp/lib/tools/foo.js", name: "handleFoo" }),
      true,
      "(3) handle* in tools/** must be allow-listed",
    );
    assert.equal(
      isExportAllowed({ file: "/whatever/mcp/lib/forbidden-legacy-identifiers.js", name: "anything" }),
      true,
      "(3) forbidden-legacy-identifiers.js file is fully allow-listed",
    );
    assert.equal(
      isExportAllowed({ file: "/whatever/mcp/lib/policy-events.js", name: "anything" }),
      false,
      "(3) production lib files (not on allow-list) are NOT exempt",
    );

    process.stdout.write("self-test: PASS (3 assertions)\n");
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ---------- main -------------------------------------------------------------

function main() {
  runSelfTest();

  const { allExports, orphans, exempts } = findOrphans();
  const strict = process.env.ORPHAN_EXPORTS_STRICT === "1";

  process.stdout.write(
    `no-orphan-exports: scanned ${allExports.length} named exports across mcp/lib/**\n`,
  );
  process.stdout.write(`  exempt (allow-listed): ${exempts.length}\n`);
  process.stdout.write(`  orphan candidates:     ${orphans.length}\n`);

  if (orphans.length > 0) {
    process.stdout.write("\n  orphan candidates (export sites with 0 callers in mcp/, daemons/, scripts/):\n");
    // Group by file for readability.
    const byFile = new Map();
    for (const o of orphans) {
      if (!byFile.has(o.file)) byFile.set(o.file, []);
      byFile.get(o.file).push(o);
    }
    for (const [file, fs] of byFile) {
      process.stdout.write(`    ${relFromRoot(file)}:\n`);
      for (const f of fs) {
        process.stdout.write(`      L${f.lineNo}  ${f.name}\n`);
      }
    }
    process.stdout.write(
      "\n  Mode: " + (strict ? "STRICT (exiting 1)" : "INFORMATIONAL (build not failed; set ORPHAN_EXPORTS_STRICT=1 to fail)")
        + "\n",
    );
  }

  if (strict && orphans.length > 0) process.exit(1);
  process.exit(0);
}

main();
