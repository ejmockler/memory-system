// no-orphan-test-imports.test.mjs
//
// R33 foundation B3 (Gap 3) — orphan-test-imports detector.
//
// Problem this gate closes:
//   R32 removed production functions/constants (tickOnce, QUEUE_DIR,
//   policy.distillation.batch.enqueued event family, ...) but many test
//   files still IMPORT those names. Because ES-module named imports of a
//   nonexistent binding resolve at runtime to `undefined` (rather than
//   throwing at parse time), such "orphan" tests survived two cleanup
//   rounds invisibly — they would crash only at first use, mid-suite, with
//   a generic TypeError. R32.1 ended with sweep_hit_count=58, npm test
//   crashing at PASS=131/FAIL=17, and 50 of those hits located inside
//   test files that import deleted exports.
//
// What this scanner does:
//   1. Walks every *.test.mjs under mcp/test/ (recursive).
//   2. Parses static `import` declarations and dynamic `await import(...)`
//      destructurings: extracts (importedSymbol, targetSpecifier).
//   3. Resolves each non-`node:` non-external specifier to an absolute path.
//   4. Reads the target file and asks: is `importedSymbol` named-exported?
//      The export checker recognises:
//        - export function foo
//        - export async function foo
//        - export const|let|var foo
//        - export class foo
//        - export { foo }
//        - export { foo as bar }            (the EXPORTED name is "bar")
//        - export { foo } from "..."        (re-export; resolved transitively)
//        - export * from "..."              (re-export-all; resolved transitively)
//        - export default ...               (matches imported `default`)
//   5. If the import target file does not exist, or the symbol is not
//      exported by it (transitively), the (testFile, symbol, target) triple
//      is recorded as an ORPHAN.
//
// Exclusions:
//   - The scanner itself and `no-legacy-pipeline-references.test.mjs`
//     (it imports FORBIDDEN_IDENTIFIERS, which is a real export, but its
//     fixtures intentionally reference removed names — those are string
//     literals, not imports, so they don't actually trip this gate; the
//     exclude is defensive).
//   - `node:*` and bare-package specifiers (e.g. `"node:fs"`, `"canonicalize"`)
//     are skipped — we can't introspect a node-builtin's exports here.
//   - Namespace imports (`import * as ns from "..."`) — skipped per task
//     spec; cannot verify per-symbol because callers may pluck members at
//     runtime via property access that the scanner cannot statically prove
//     orphan.
//   - Default imports of a target file that has `export default ...` are
//     accepted; if there is no default, the import-name is recorded as
//     orphan.
//
// Self-tests (T1..T4): see runSelfTests().
//
// Wired into npm test post-existing-tests and post-no-legacy-pipeline.
//
// Exit code:
//   0 — zero orphans found in real production scan.
//   1 — at least one orphan (or self-test failure).

import assert from "node:assert/strict";
import {
  readdirSync,
  readFileSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const MCP_ROOT = resolve(dirname(THIS_FILE), "..");
const MEMORY_SYSTEM_ROOT = resolve(MCP_ROOT, "..");
const TEST_ROOT = resolve(MCP_ROOT, "test");

// Test files whose imports SHOULD NOT be validated. (The detector itself,
// the legacy-prevent gate which intentionally couples to fixtures, and the
// orphan-exports self-tester which writes its own fixture modules at
// runtime — the static scanner cannot see imports embedded in strings
// passed to writeFileSync.)
const EXCLUDED_TEST_FILES = new Set([
  resolve(TEST_ROOT, "no-orphan-test-imports.test.mjs"),
  resolve(TEST_ROOT, "no-legacy-pipeline-references.test.mjs"),
  resolve(TEST_ROOT, "no-orphan-exports.test.mjs"),
  // 2026-08-12: same category as no-orphan-exports.test.mjs above — a scanner
  // self-tester whose fixtures ARE synthetic module source, held as arrays of
  // string literals (e.g. 'import { memoryLedgerPath } from "../mcp/lib/config.js";'
  // at :1537). Those specifiers are written from the perspective of the
  // SIMULATED file's location (scripts/, mcp/scripts/), not this directory, so
  // resolving them relative to mcp/test/ yields mcp/mcp/lib/config.js and six
  // false target-missing orphans. They are fixtures, not imports: nothing in
  // this file actually imports config.js.
  resolve(TEST_ROOT, "no-ledger-readfilesync.test.mjs"),
]);

// ---------- import parser ----------------------------------------------------

// Strip line and block comments from source. We don't try to be a full JS
// parser — we just want enough to make import-regexes not match the
// occasional "import { x }" line inside a /* */ comment or a // line.
//
// We DO preserve string literals (so an import inside a template literal is
// still seen if it really is an import). The R32 legacy gate has its own
// comment stripper; this one is intentionally simpler.
function stripCommentsForImports(src) {
  // Strip // line comments FIRST (but not inside strings — best effort).
  // Order matters: a line-comment may contain "*/" (e.g. a doc-comment that
  // mentions "ingest/stage0/*.js" or includes a literal "*/" example). If
  // we stripped block comments first, that line-comment "*/" would close a
  // bogus block-comment opened by an earlier line-comment "/*", swallowing
  // a large region of real code (including its `export` statements).
  let out = src
    .split("\n")
    .map((line) => {
      // Find the first // that is NOT inside a quoted string. Walk
      // character by character; track quote state.
      let inStr = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inStr) {
          if (c === "\\") {
            i++; // skip escaped char
            continue;
          }
          if (c === inStr) inStr = null;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") {
          inStr = c;
          continue;
        }
        if (c === "/" && line[i + 1] === "/") {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
  // Then strip /* ... */ blocks (multi-line aware) — STRING-AWARE.
  //
  // 2026-08-12: this was `out.replace(/\/\*[\s\S]*?\*\//g, "")`, a STRING-BLIND
  // regex, which falsified this function's own stated invariant six lines above
  // ("We DO preserve string literals"). A file that carries "/*" inside one
  // string literal and "*/" inside another — which any test of a comment-aware
  // tokenizer necessarily does — had everything between them silently deleted.
  //
  // Measured: mcp/test/no-ledger-readfilesync.test.mjs carries "/*" in a string
  // at :1511 and "*/" in a string at :1638; the bogus block swallowed :1511-1638,
  // hiding three of its six synthetic import fixtures. The three survivors were
  // then parsed as REAL imports of "../mcp/lib/config.js", which resolves from
  // mcp/test/ to the nonexistent mcp/mcp/lib/config.js, and reported as
  // target-missing orphans. Three false positives, and the suite is
  // standalone-green, so only the full-suite run surfaced it.
  //
  // The line-comment pass above is already string-aware and its header explains
  // why order matters for the SAME hazard in the other direction. This pass now
  // uses the same discipline: walk characters, track quote/template state, and
  // only honour a "/*" that is genuinely in code context.
  let stripped = "";
  let inStr = null;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (inStr) {
      stripped += c;
      if (c === "\\") {
        if (i + 1 < out.length) stripped += out[++i];
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      stripped += c;
      continue;
    }
    if (c === "/" && out[i + 1] === "*") {
      const end = out.indexOf("*/", i + 2);
      if (end === -1) break; // unterminated block: drop the remainder, as the regex did
      // Preserve newlines so downstream line numbers stay meaningful.
      for (let j = i; j < end + 2; j++) if (out[j] === "\n") stripped += "\n";
      i = end + 1;
      continue;
    }
    stripped += c;
  }
  return stripped;
}

// Extract destructured names from a JS-source binding-pattern fragment
// such as `{ a, b: c, d = 1, "e": f }`. Returns the imported (local-binding)
// names — for `{ b: c }` we return `c` (the local name), but in import
// semantics it's the SOURCE name that matters. We handle the import-form
// `{ foo as bar }` by returning the SOURCE name `foo` (see callers).
function parseImportClause(clause) {
  // clause is the text inside { ... }.
  // Returns array of source-side names.
  const out = [];
  // Split on commas at the top level (no nested braces expected in import
  // clauses).
  const parts = clause.split(",");
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    // Form: "foo" or "foo as bar"
    const m = part.match(/^([A-Za-z_$][\w$]*)\s*(?:as\s+[A-Za-z_$][\w$]*)?$/);
    if (m) {
      out.push(m[1]);
      continue;
    }
    // Form: '"foo" as bar' (string-literal export name)
    const ms = part.match(/^["']([^"']+)["']\s+as\s+[A-Za-z_$][\w$]*$/);
    if (ms) {
      out.push(ms[1]);
    }
    // Anything else (defaults, weird) — skip; static analysis ends here.
  }
  return out;
}

// Extract names from a destructuring LHS for dynamic import:
// `const { a, b: c } = await import(...)` — returns ["a", "b"] (source).
function parseDestructureLhs(clause) {
  const out = [];
  const parts = clause.split(",");
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    // Form: "foo" or "foo: localName" or "foo = default"
    const m = part.match(/^([A-Za-z_$][\w$]*)/);
    if (m) {
      out.push(m[1]);
    }
  }
  return out;
}

// Parse an import string `from "spec"` block into structured records.
// Returns array of:
//   { kind: "named"|"default"|"namespace"|"side-effect",
//     names: string[]|null, specifier: string }
export function parseImports(src) {
  const code = stripCommentsForImports(src);
  const records = [];

  // --- static imports ---------------------------------------------------
  // Match `import ... from "spec";` with variants:
  //   - import "spec";                              (side-effect)
  //   - import D from "spec";                       (default)
  //   - import * as ns from "spec";                 (namespace)
  //   - import { a, b as c } from "spec";           (named)
  //   - import D, { a } from "spec";                (default + named)
  //   - import D, * as ns from "spec";              (default + namespace)
  //
  // We use a single regex that captures the clause and the spec, then
  // classify by clause shape.
  const STATIC_IMPORT_RE =
    /\bimport\s+(?:([^;'"]+?)\s+from\s+)?(['"])([^'"]+)\2\s*;?/g;
  let m;
  while ((m = STATIC_IMPORT_RE.exec(code)) !== null) {
    const clause = (m[1] || "").trim();
    const specifier = m[3];
    if (!clause) {
      records.push({ kind: "side-effect", names: null, specifier });
      continue;
    }
    // Default + something? Default is the leading identifier (or alone).
    // Strip namespace `* as ns` and named `{ ... }` parts.
    let rest = clause;
    let hasDefault = false;
    let hasNamespace = false;
    let namedNames = null;

    // Pull off `{ ... }`.
    const braceMatch = rest.match(/\{([^}]*)\}/);
    if (braceMatch) {
      namedNames = parseImportClause(braceMatch[1]);
      rest = (rest.slice(0, braceMatch.index) + rest.slice(braceMatch.index + braceMatch[0].length)).trim();
    }
    // Pull off `* as ns`.
    const nsMatch = rest.match(/\*\s*as\s+[A-Za-z_$][\w$]*/);
    if (nsMatch) {
      hasNamespace = true;
      rest = (rest.slice(0, nsMatch.index) + rest.slice(nsMatch.index + nsMatch[0].length)).trim();
    }
    // Strip dangling commas/whitespace.
    rest = rest.replace(/,/g, "").trim();
    // Whatever's left is the default-import binding.
    if (rest && /^[A-Za-z_$][\w$]*$/.test(rest)) {
      hasDefault = true;
    }

    if (hasDefault) {
      records.push({ kind: "default", names: ["default"], specifier });
    }
    if (hasNamespace) {
      records.push({ kind: "namespace", names: null, specifier });
    }
    if (namedNames && namedNames.length > 0) {
      records.push({ kind: "named", names: namedNames, specifier });
    }
  }

  // --- dynamic imports: `await import("spec")` or `import("spec")` ------
  // Detect destructured form:
  //   const { a, b: c } = await import("spec");
  //   const { a } = await import("spec");
  //   let { a } = await import("spec");
  //   var { a } = await import("spec");
  // And bare/aliased form:
  //   const mod = await import("spec");
  //   const ns  = await import("spec");
  // For the bare/aliased form we record `namespace` (no per-symbol check).
  const DYN_DESTRUCT_RE =
    /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?import\s*\(\s*(['"])([^'"]+)\2\s*\)/g;
  while ((m = DYN_DESTRUCT_RE.exec(code)) !== null) {
    const clause = m[1];
    const specifier = m[3];
    const names = parseDestructureLhs(clause);
    if (names.length > 0) {
      records.push({ kind: "named", names, specifier });
    }
  }
  const DYN_BARE_RE =
    /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:await\s+)?import\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  while ((m = DYN_BARE_RE.exec(code)) !== null) {
    const specifier = m[2];
    records.push({ kind: "namespace", names: null, specifier });
  }

  return records;
}

// ---------- specifier resolver ----------------------------------------------

// Decide whether a specifier is "external" (node-builtin or bare package) —
// such specifiers are SKIPPED by the orphan check. A specifier is internal
// iff it starts with "./" or "../" or "/" (absolute).
export function isInternalSpecifier(spec) {
  return spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/");
}

// Resolve `specifier` relative to `fromFile`. Returns absolute path or null
// if the target does not exist on disk (the import would crash at runtime
// with ERR_MODULE_NOT_FOUND).
export function resolveSpecifier(fromFile, specifier) {
  if (!isInternalSpecifier(specifier)) return null;
  const base = dirname(fromFile);
  const abs = resolve(base, specifier);
  try {
    const st = statSync(abs);
    if (st.isFile()) return abs;
  } catch {
    // not a file; could be missing extension — try .js
  }
  // Try with .js / .mjs / .cjs appended.
  for (const ext of [".js", ".mjs", ".cjs"]) {
    const cand = abs + ext;
    try {
      const st = statSync(cand);
      if (st.isFile()) return cand;
    } catch {
      // continue
    }
  }
  // Directory + /index.js?
  try {
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const ext of [".js", ".mjs", ".cjs"]) {
        const cand = join(abs, "index" + ext);
        try {
          const stI = statSync(cand);
          if (stI.isFile()) return cand;
        } catch {
          // continue
        }
      }
    }
  } catch {
    // not a directory either
  }
  return null;
}

// ---------- exports analyser -------------------------------------------------

// Parse `src` and return:
//   { exportedNames: Set<string>,
//     hasExportStar: boolean,
//     reExportsFrom: Array<{ names: string[]|null, specifier: string }>,
//     hasDefault: boolean }
// where:
//   - exportedNames includes ONLY locally-defined-and-named exports (the
//     EXPORTED name, after `as`-renaming).
//   - hasExportStar is true if the file contains `export * from "..."`.
//   - reExportsFrom carries `export { a, b as c } from "spec"` and
//     `export * from "spec"` for transitive resolution.
export function parseExports(src) {
  const code = stripCommentsForImports(src);
  const exportedNames = new Set();
  let hasDefault = false;
  const reExportsFrom = [];

  // 1. `export function|class|const|let|var|async function NAME`
  const DECL_RE =
    /\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = DECL_RE.exec(code)) !== null) {
    exportedNames.add(m[1]);
  }

  // 2. `export default ...`
  if (/\bexport\s+default\b/.test(code)) {
    hasDefault = true;
  }

  // 3. `export { a, b as c }` (no from) — local re-export
  // 4. `export { a, b as c } from "spec"` — re-export from source
  // 5. `export * from "spec"` — star re-export
  // 6. `export * as ns from "spec"` — namespace re-export (treat as star
  //    consumer side — caller can't pluck a symbol from it without `.ns.x`
  //    syntax, so we don't need to recurse into it for symbol resolution).
  const EXPORT_BRACED_RE = /\bexport\s*\{([^}]*)\}(?:\s*from\s*(['"])([^'"]+)\2)?/g;
  while ((m = EXPORT_BRACED_RE.exec(code)) !== null) {
    const clause = m[1];
    const fromSpec = m[3] || null;
    // Each item is `name` or `name as alias`; the EXPORTED name is the
    // alias (or `name` if no alias).
    const items = clause.split(",");
    const sourceNames = [];
    for (const raw of items) {
      const part = raw.trim();
      if (!part) continue;
      const asM = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (asM) {
        if (fromSpec) {
          // re-export: track SOURCE name to look up in the target file
          sourceNames.push(asM[1]);
          // and the EXPORTED (alias) name is now an export of THIS file
          exportedNames.add(asM[2]);
        } else {
          // local re-export: source name must be in scope; alias is exported
          exportedNames.add(asM[2]);
        }
        continue;
      }
      const plainM = part.match(/^([A-Za-z_$][\w$]*)$/);
      if (plainM) {
        if (fromSpec) {
          sourceNames.push(plainM[1]);
          exportedNames.add(plainM[1]);
        } else {
          exportedNames.add(plainM[1]);
        }
        continue;
      }
    }
    if (fromSpec) {
      reExportsFrom.push({ names: sourceNames, specifier: fromSpec });
    }
  }

  // `export * from "spec"`  (NOT `export * as ns from "spec"`)
  const EXPORT_STAR_RE = /\bexport\s*\*\s*from\s*(['"])([^'"]+)\1/g;
  while ((m = EXPORT_STAR_RE.exec(code)) !== null) {
    reExportsFrom.push({ names: null, specifier: m[2] });
  }
  // `export * as ns from "spec"` — adds `ns` as a local export, doesn't
  // contribute to symbol resolution of arbitrary names.
  const EXPORT_STAR_AS_RE = /\bexport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"][^'"]+['"]/g;
  while ((m = EXPORT_STAR_AS_RE.exec(code)) !== null) {
    exportedNames.add(m[1]);
  }

  return { exportedNames, hasDefault, reExportsFrom };
}

// Does `targetFile` (transitively, via re-exports) export `symbol`?
// `visited` guards against re-export cycles.
export function fileExportsSymbol(targetFile, symbol, visited = new Set()) {
  if (visited.has(targetFile)) return false;
  visited.add(targetFile);
  let body;
  try {
    body = readFileSync(targetFile, "utf8");
  } catch {
    return false;
  }
  const { exportedNames, hasDefault, reExportsFrom } = parseExports(body);
  if (symbol === "default") {
    return hasDefault;
  }
  if (exportedNames.has(symbol)) return true;
  // Walk re-exports.
  for (const re of reExportsFrom) {
    const reAbs = resolveSpecifier(targetFile, re.specifier);
    if (!reAbs) continue;
    if (re.names === null) {
      // export * from — any symbol could be there; recurse.
      if (fileExportsSymbol(reAbs, symbol, visited)) return true;
    } else if (re.names.includes(symbol)) {
      // The braced re-export claims to provide `symbol`. Confirm the
      // upstream really exports it; otherwise it's an orphan one level
      // deeper.
      if (fileExportsSymbol(reAbs, symbol, visited)) return true;
    }
  }
  return false;
}

// ---------- test-file walker -------------------------------------------------

function* walkTests(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = join(root, ent.name);
    if (ent.isDirectory()) {
      // Skip fixtures and any explicitly-fixture-style folders.
      if (ent.name === "fixtures" || ent.name === "node_modules") continue;
      yield* walkTests(p);
    } else if (ent.isFile() && ent.name.endsWith(".test.mjs")) {
      yield p;
    }
  }
}

// ---------- main scanner -----------------------------------------------------

export function scanForOrphanImports(testRoot) {
  const orphans = [];
  for (const testFile of walkTests(testRoot)) {
    if (EXCLUDED_TEST_FILES.has(testFile)) continue;
    let body;
    try {
      body = readFileSync(testFile, "utf8");
    } catch {
      continue;
    }
    const imports = parseImports(body);
    for (const rec of imports) {
      if (!isInternalSpecifier(rec.specifier)) continue;
      const targetAbs = resolveSpecifier(testFile, rec.specifier);
      if (!targetAbs) {
        // Target file does not exist. EVERY named/default import from it
        // is orphan; namespace too — record one entry per imported name,
        // or a single placeholder for namespace/side-effect.
        if (rec.kind === "named" && rec.names) {
          for (const n of rec.names) {
            orphans.push({
              testFile,
              symbol: n,
              specifier: rec.specifier,
              reason: "target-missing",
            });
          }
        } else if (rec.kind === "default") {
          orphans.push({
            testFile,
            symbol: "default",
            specifier: rec.specifier,
            reason: "target-missing",
          });
        } else {
          orphans.push({
            testFile,
            symbol: "(namespace)",
            specifier: rec.specifier,
            reason: "target-missing",
          });
        }
        continue;
      }
      if (rec.kind === "namespace" || rec.kind === "side-effect") {
        // No per-symbol assertion possible; skip per task spec.
        continue;
      }
      const namesToCheck =
        rec.kind === "default" ? ["default"] : rec.names || [];
      for (const sym of namesToCheck) {
        if (!fileExportsSymbol(targetAbs, sym)) {
          orphans.push({
            testFile,
            symbol: sym,
            specifier: rec.specifier,
            targetAbs,
            reason: "symbol-not-exported",
          });
        }
      }
    }
  }
  return orphans;
}

// ---------- self-tests -------------------------------------------------------

function runSelfTests() {
  const dir = mkdtempSync(join(tmpdir(), "orphan-imports-self-test-"));
  try {
    // Layout:
    //   dir/
    //     lib/
    //       real.js                 (exports foo, bar)
    //       reexporter.js           (re-exports foo from real.js)
    //       star.js                 (export * from "./real.js")
    //     test/
    //       t1-orphan.test.mjs      (imports nonexistent BAZ)         -> orphan
    //       t2-ok.test.mjs          (imports foo — exists)            -> no orphan
    //       t3-namespace.test.mjs   (import * as ns)                  -> skipped, no orphan
    //       t4-reexport.test.mjs    (import foo from reexporter.js)   -> resolved, no orphan
    //       t5-star.test.mjs        (import bar from star.js)         -> resolved, no orphan
    //       t6-default.test.mjs     (import D from real.js — missing) -> orphan
    //
    const libDir = join(dir, "lib");
    const testDir = join(dir, "test");
    mkdirSync(libDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });

    writeFileSync(
      join(libDir, "real.js"),
      [
        "export function foo() { return 1; }",
        "export const bar = 2;",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(libDir, "reexporter.js"),
      [
        'export { foo } from "./real.js";',
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(libDir, "star.js"),
      [
        'export * from "./real.js";',
        "",
      ].join("\n"),
    );

    writeFileSync(
      join(testDir, "t1-orphan.test.mjs"),
      [
        'import { BAZ } from "../lib/real.js";',
        "console.log(BAZ);",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(testDir, "t2-ok.test.mjs"),
      [
        'import { foo } from "../lib/real.js";',
        "console.log(foo());",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(testDir, "t3-namespace.test.mjs"),
      [
        'import * as ns from "../lib/real.js";',
        "console.log(ns.foo());",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(testDir, "t4-reexport.test.mjs"),
      [
        'import { foo } from "../lib/reexporter.js";',
        "console.log(foo());",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(testDir, "t5-star.test.mjs"),
      [
        'import { bar } from "../lib/star.js";',
        "console.log(bar);",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(testDir, "t6-default.test.mjs"),
      [
        'import D from "../lib/real.js";',
        "console.log(D);",
        "",
      ].join("\n"),
    );

    const orphans = scanForOrphanImports(testDir);

    const byTest = new Map();
    for (const o of orphans) {
      const rel = relative(testDir, o.testFile);
      if (!byTest.has(rel)) byTest.set(rel, []);
      byTest.get(rel).push(o);
    }

    // T1: nonexistent name detected.
    assert.ok(
      byTest.has("t1-orphan.test.mjs"),
      "T1: t1-orphan must produce an orphan finding, got: "
        + JSON.stringify([...byTest.keys()]),
    );
    assert.ok(
      byTest.get("t1-orphan.test.mjs").some((o) => o.symbol === "BAZ"),
      "T1: orphan symbol BAZ must be reported",
    );

    // T2: existing import — no orphan.
    assert.ok(
      !byTest.has("t2-ok.test.mjs"),
      "T2: t2-ok must not produce any orphan, got: "
        + JSON.stringify(byTest.get("t2-ok.test.mjs") || []),
    );

    // T3: namespace import — no per-symbol assertion -> no orphan recorded.
    assert.ok(
      !byTest.has("t3-namespace.test.mjs"),
      "T3: namespace import must be skipped (no orphan)",
    );

    // T4: re-export chain resolved.
    assert.ok(
      !byTest.has("t4-reexport.test.mjs"),
      "T4: re-export of foo must be resolved (no orphan), got: "
        + JSON.stringify(byTest.get("t4-reexport.test.mjs") || []),
    );

    // T5: star re-export resolved.
    assert.ok(
      !byTest.has("t5-star.test.mjs"),
      "T5: export * star re-export of bar must be resolved (no orphan), got: "
        + JSON.stringify(byTest.get("t5-star.test.mjs") || []),
    );

    // T6: default import against a file with no `export default` -> orphan.
    assert.ok(
      byTest.has("t6-default.test.mjs"),
      "T6: default import against non-default-exporting file must be orphan",
    );
    assert.ok(
      byTest.get("t6-default.test.mjs").some((o) => o.symbol === "default"),
      "T6: orphan symbol 'default' must be reported",
    );

    process.stdout.write("self-test: PASS (6 assertions)\n");
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
  // 1. Self-tests first.
  runSelfTests();

  // 2. Real scan over mcp/test/.
  const orphans = scanForOrphanImports(TEST_ROOT);

  if (orphans.length === 0) {
    process.stdout.write("no-orphan-test-imports: PASS (0 orphans)\n");
    process.exit(0);
  }

  // Group by test file for readable output.
  const byFile = new Map();
  for (const o of orphans) {
    if (!byFile.has(o.testFile)) byFile.set(o.testFile, []);
    byFile.get(o.testFile).push(o);
  }
  process.stderr.write(
    `\nno-orphan-test-imports: FAIL (${orphans.length} orphan import${
      orphans.length === 1 ? "" : "s"
    } across ${byFile.size} test file${byFile.size === 1 ? "" : "s"})\n\n`,
  );
  for (const [file, fileOrphans] of byFile) {
    const rel = relative(MEMORY_SYSTEM_ROOT, file);
    process.stderr.write(`  ${rel}:\n`);
    for (const o of fileOrphans) {
      process.stderr.write(
        `    [${o.reason}]  symbol="${o.symbol}"  from="${o.specifier}"\n`,
      );
    }
  }
  process.stderr.write(
    "\n  An orphan import names a symbol that no longer exists in the target\n",
  );
  process.stderr.write(
    "  module. The test would crash at first use with a TypeError. Either\n",
  );
  process.stderr.write(
    "  delete the test (the production code is gone) or rewrite it against\n",
  );
  process.stderr.write("  the current exports.\n\n");
  process.exit(1);
}

main();
