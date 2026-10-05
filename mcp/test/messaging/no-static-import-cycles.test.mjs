// no-static-import-cycles.test.mjs — the messaging module graph must be a DAG.
//
// WHY THIS GATE EXISTS. Until f5-catchup-seam, catchup.js and
// envelope-projection.js imported each other. The cycle was survivable only by
// a hand-maintained convention ("both modules dereference the other's bindings
// inside function bodies only, never at module eval"), asserted in prose in two
// header comments and enforced by nothing. One `const X = OTHER_MODULE_CONST;`
// at module scope in either file would have turned that convention into a
// live TDZ ReferenceError whose symptom depends on WHICH module the process
// imported first — i.e. a defect that reproduces in production and not in the
// test that imports the other end first.
//
// f5 broke the cycle by extracting the shared constants + the shared retain
// fold into a leaf (lib/messaging/ledger-retain.js, zero imports). This gate
// is what keeps it broken: it re-derives the static import graph from source
// and fails on any cycle, so the hazard cannot silently return.
//
// SCOPE. Static `import` statements with RELATIVE specifiers, over
// mcp/lib/messaging/** (.js + .mjs). Bare specifiers (node:, packages) cannot
// participate in an intra-directory cycle and are ignored. Dynamic `import()`
// is deliberately NOT followed: a dynamic import is evaluated at call time, so
// it cannot produce the module-eval TDZ this gate defends against.
//
// THESIS #1 (read-only): this gate reads source bytes and writes nothing
// outside a self-test tmpdir. No ledger, index, or projection is touched.
//
// Run: node test/messaging/no-static-import-cycles.test.mjs
// Exit 0 = the graph is a DAG. Exit 1 = at least one cycle, printed as
//   CYCLE: a.js -> b.js -> a.js
//
// ES module. No external deps.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve, basename, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const MEMORY_SYSTEM_ROOT = resolve(dirname(THIS_FILE), "..", "..", "..");
const MESSAGING_ROOT = join(MEMORY_SYSTEM_ROOT, "mcp", "lib", "messaging");

// ---------- graph construction -----------------------------------------------

const SOURCE_EXTENSIONS = [".js", ".mjs"];

/** Recursively collect every source file under `dir`. */
export function collectSources(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...collectSources(p));
    } else if (SOURCE_EXTENSIONS.some((e) => p.endsWith(e))) {
      out.push(p);
    }
  }
  return out;
}

// A STATIC import statement, anchored to line start (so an `import(` inside an
// expression, or the word `import` inside a comment sentence, does not match).
// Covers all three static forms:
//   import X from "spec";  /  import { A, B } from "spec";  /  import "spec";
//   import * as NS from "spec";
// Multi-line specifier lists are handled because the match is anchored on the
// `import` keyword and the specifier string is found by a following scan.
const RE_STATIC_IMPORT = /^[ \t]*import\b(?![ \t]*\()([\s\S]*?)from[ \t]*["']([^"']+)["']/gm;
const RE_BARE_IMPORT = /^[ \t]*import[ \t]+["']([^"']+)["']/gm;

/** Every relative specifier statically imported by the file at absPath. */
export function parseStaticRelativeImports(absPath, body = null) {
  const src = body === null ? readFileSync(absPath, "utf8") : body;
  const specs = [];
  let m;
  RE_STATIC_IMPORT.lastIndex = 0;
  while ((m = RE_STATIC_IMPORT.exec(src)) !== null) specs.push(m[2]);
  RE_BARE_IMPORT.lastIndex = 0;
  while ((m = RE_BARE_IMPORT.exec(src)) !== null) specs.push(m[1]);
  return specs.filter((s) => s.startsWith("."));
}

/**
 * Build { files, edges } where `edges` maps an absolute file path to the
 * absolute paths of the in-scope files it statically imports. Edges leaving
 * the scanned set (e.g. "../synthesis/ledger-checkpoint.js") are dropped —
 * they cannot close a cycle inside the scanned set on their own, and the gate
 * is scoped to the messaging graph by design.
 */
export function buildImportGraph(root) {
  const files = collectSources(root);
  const inScope = new Set(files);
  const edges = new Map();
  for (const f of files) {
    const deps = [];
    for (const spec of parseStaticRelativeImports(f)) {
      const abs = resolve(dirname(f), spec);
      if (inScope.has(abs) && abs !== f) deps.push(abs);
    }
    edges.set(f, deps);
  }
  return { files, edges };
}

/**
 * Every cycle-closing back edge, as an ordered path of absolute file paths
 * whose first and last element are the same node. Iterative-safe DFS with the
 * classic white/grey/black colouring.
 */
export function findCycles({ files, edges }) {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map(files.map((f) => [f, WHITE]));
  const stack = [];
  const cycles = [];
  const seen = new Set();

  function visit(node) {
    color.set(node, GREY);
    stack.push(node);
    for (const dep of edges.get(node) || []) {
      const c = color.get(dep) ?? WHITE;
      if (c === GREY) {
        const at = stack.indexOf(dep);
        const cyc = stack.slice(at).concat([dep]);
        const key = cyc.join("|");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cyc);
        }
      } else if (c === WHITE) {
        visit(dep);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }

  for (const f of files) if (color.get(f) === WHITE) visit(f);
  return cycles;
}

function formatCycle(cyc) {
  return "CYCLE: " + cyc.map((p) => basename(p)).join(" -> ");
}

// ---------- self-test (non-vacuity) ------------------------------------------

// Fixture source is ASSEMBLED FROM TOKENS, never written as a literal import
// statement. The sibling gate test/no-orphan-test-imports.test.mjs parses
// import statements out of test SOURCE with a regex that does not model string
// literals, so a literal `im`+`port { b } from "./b.js"` sitting inside a
// fixture string here would be read as a REAL import of a module that does not
// exist, and that gate would fail on this file. Token assembly keeps both gates
// green without weakening either.
const KW_IMPORT = "im" + "port";
const staticImport = (sym, spec) => `${KW_IMPORT} { ${sym} } from ${JSON.stringify(spec)};\n`;
const lineComment = (text) => `// ${text}\n`;
const dynamicImport = (spec) => `${KW_IMPORT}(${JSON.stringify(spec)})`;

// A gate that cannot fail proves nothing. Build a two-file cycle and a
// three-file DAG in a tmpdir and assert the detector's verdict on each.
function runSelfTest() {
  const dir = mkdtempSync(join(tmpdir(), "no-cycles-selftest-"));
  try {
    // (1) a genuine 2-cycle
    writeFileSync(join(dir, "a.js"), staticImport("b", "./b.js") + "export const a = 1;\n");
    writeFileSync(join(dir, "b.js"), staticImport("a", "./a.js") + "export const b = 2;\n");
    let cycles = findCycles(buildImportGraph(dir));
    assert.equal(cycles.length, 1, "self-test: the a<->b cycle must be detected");
    assert.match(formatCycle(cycles[0]), /^CYCLE: (a\.js -> b\.js -> a\.js|b\.js -> a\.js -> b\.js)$/);

    // (2) the same files re-pointed at a leaf: a DAG, plus proof that a
    //     DYNAMIC import and a commented-out import are not followed.
    writeFileSync(
      join(dir, "a.js"),
      staticImport("c", "./c.js") +
        lineComment(staticImport("b", "./b.js").trim()) +
        `export const a = () => ${dynamicImport("./b.js")};\n`,
    );
    writeFileSync(join(dir, "b.js"), staticImport("c", "./c.js") + "export const b = 2;\n");
    writeFileSync(join(dir, "c.js"), "export const c = 3;\n");
    cycles = findCycles(buildImportGraph(dir));
    assert.equal(cycles.length, 0, "self-test: the leaf-shaped graph must be a DAG");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- main --------------------------------------------------------------

function main() {
  runSelfTest();

  const graph = buildImportGraph(MESSAGING_ROOT);
  const edgeCount = [...graph.edges.values()].reduce((n, d) => n + d.length, 0);
  const cycles = findCycles(graph);

  process.stdout.write(
    `no-static-import-cycles: scanned ${graph.files.length} modules / ${edgeCount} intra-directory static import edges under ` +
      `${relative(MEMORY_SYSTEM_ROOT, MESSAGING_ROOT)}\n`,
  );

  if (cycles.length > 0) {
    for (const c of cycles) process.stdout.write(`  ${formatCycle(c)}\n`);
    process.stdout.write(
      `\n  FAIL: ${cycles.length} static import cycle(s). A cycle survives only by the convention that\n` +
        "  neither module dereferences the other at module eval — a convention nothing enforces.\n" +
        "  Extract the shared bindings into a leaf module (see lib/messaging/ledger-retain.js).\n",
    );
    process.exit(1);
  }

  process.stdout.write("  cycles: 0 (the messaging module graph is a DAG)\n");
  process.exit(0);
}

main();
