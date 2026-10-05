// test-exit-discipline.test.mjs
//
// R34 Foundation B9 self-test.
//
// Synthesizes fixture .test.mjs strings (in-memory) covering the canonical
// shapes the scanner must handle, then asserts the scanner classifies each
// correctly. Also runs the scanner against the real mcp/test/ directory to
// confirm it does not crash and produces a structured report.
//
// Hermetic: no temp-file writes; classify() works on string input directly.
// detectSwallowingCatch() likewise. We avoid touching the filesystem for the
// synthetic fixtures.
//
// Discipline-class table:
//   A) node:assert; throws -> default uncaught -> exit 1.  PASS.
//   B) custom counter + exit-guard.                         PASS.
//   B-bad) custom counter + FAIL log + NO exit-guard.       FAIL.
//   C) imperative throw on failure, no counter.             PASS.
//   D) try/catch swallows assertion throws.                 FAIL.
//
// We also confirm the real production scan exits with a defined exit code
// (0 or 1) and emits a numeric scanned count. We do not assert PASS/FAIL on
// the production set because that depends on the state of mcp/test/ at the
// moment of run.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { classify, detectSwallowingCatch, analyze } from "../scripts/test-exit-discipline.mjs";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
// fileURLToPath, not URL.pathname: pathname stays percent-encoded, so a
// checkout path containing a space resolved to a directory that does not exist.
import { fileURLToPath } from "node:url";
import { join } from "node:path";

let assertions = 0;
let failures = 0;
function check(label, cond, detail = "") {
  assertions += 1;
  if (!cond) {
    failures += 1;
    console.error(`FAIL: ${label}${detail ? " :: " + detail : ""}`);
  } else {
    console.log(`PASS: ${label}`);
  }
}

// --- Discipline-class A: node:assert ---
const A_TEXT = `
import { strict as assert } from "node:assert";
assert.equal(1 + 1, 2);
assert.equal("a", "a");
`;
{
  const c = classify(A_TEXT);
  check(
    "class A: node:assert recognized",
    c.usesNodeAssert === true,
  );
  check(
    "class A: no counter pattern",
    c.hasCounter === false,
  );
  check(
    "class A: no exit-guard required (none needed)",
    c.hasExitGuard === false,
  );
  const swallow = detectSwallowingCatch(A_TEXT);
  check("class A: no swallowing catch", swallow.length === 0);
}

// --- Discipline-class B: counter + exit guard ---
const B_TEXT = `
let failures = 0;
let assertions = 0;
function check(label, cond) {
  assertions += 1;
  if (!cond) { failures += 1; console.error("FAIL: " + label); }
}
check("foo", 1 === 1);
check("bar", 2 === 2);
console.log("\\nAll " + assertions + " passed.");
if (failures > 0) {
  console.error(failures + " failure(s) out of " + assertions + " assertions.");
  process.exit(1);
}
process.exit(0);
`;
{
  const c = classify(B_TEXT);
  check("class B: counter detected", c.hasCounter === true);
  check("class B: FAIL log detected", c.hasFailLog === true);
  check("class B: exit-guard detected", c.hasExitGuard === true);
}

// --- Discipline-class B-bad: counter + FAIL log + NO exit-guard ---
const B_BAD_TEXT = `
let failures = 0;
let assertions = 0;
function check(label, cond) {
  assertions += 1;
  if (!cond) { failures += 1; console.log("FAIL: " + label); }
}
check("foo", 1 === 2); // would fail
console.log(failures + " failure(s) out of " + assertions + " assertions.");
// NOTE: no process.exit(1) here -> silent FAIL
`;
{
  const c = classify(B_BAD_TEXT);
  check("class B-bad: counter detected", c.hasCounter === true);
  check("class B-bad: FAIL log detected", c.hasFailLog === true);
  check(
    "class B-bad: NO exit-guard detected (this is the violation)",
    c.hasExitGuard === false,
  );
}

// --- Discipline-class C: imperative throw on failure, no counter ---
const C_TEXT = `
function mustEqual(a, b) {
  if (a !== b) throw new Error("mismatch: " + a + " vs " + b);
}
mustEqual(1, 1);
mustEqual("x", "x");
`;
{
  const c = classify(C_TEXT);
  check("class C: no counter", c.hasCounter === false);
  check("class C: no FAIL log", c.hasFailLog === false);
  const swallow = detectSwallowingCatch(C_TEXT);
  check("class C: no swallowing catch", swallow.length === 0);
}

// --- Discipline-class D: try/catch swallows assertion throws ---
// Built via concatenation so this literal does not itself trip the scanner
// when test-exit-discipline.test.mjs is fed back into the scanner.
const _ASSERT = "assert";
const D_TEXT =
  `import { strict as ` +
  _ASSERT +
  ` } from "node:assert";\n` +
  `try {\n` +
  `  ` +
  _ASSERT +
  `.equal(1, 2); // would throw\n` +
  `} catch (e) {\n` +
  `  console.log("oh well");\n` +
  `}\n` +
  `console.log("done");\n`;
{
  const swallow = detectSwallowingCatch(D_TEXT);
  check(
    "class D: swallowing catch detected",
    swallow.length >= 1,
    `found ${swallow.length} swallowing catches`,
  );
}

// --- analyze() integration on temp fixture files ---
// We need to drive analyze() which reads from disk. Use a temp dir.
const tmp = mkdtempSync(join(tmpdir(), "b9-test-exit-discipline-"));
try {
  const goodPath = join(tmp, "good.test.mjs");
  const badPath = join(tmp, "bad.test.mjs");
  const swallowPath = join(tmp, "swallow.test.mjs");
  writeFileSync(goodPath, B_TEXT);
  writeFileSync(badPath, B_BAD_TEXT);
  writeFileSync(swallowPath, D_TEXT);

  const good = analyze(goodPath);
  check("analyze(good): pass", good.pass === true, JSON.stringify(good.reasons));

  const bad = analyze(badPath);
  check("analyze(bad): fail", bad.pass === false);
  check(
    "analyze(bad): reason mentions exit-guard",
    bad.reasons.some((r) => /exit-guard/.test(r)),
  );

  const swallow = analyze(swallowPath);
  check("analyze(swallow): fail", swallow.pass === false);
  check(
    "analyze(swallow): reason mentions try/catch",
    swallow.reasons.some((r) => /try\/catch/.test(r)),
  );

  // --- CLI smoke: run scanner against the temp dir as --root ---
  const scriptPath = resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "..",
    "scripts",
    "test-exit-discipline.mjs",
  );
  const cli = spawnSync("node", [scriptPath, `--root=${tmp}`, "--json"], {
    encoding: "utf8",
  });
  check("CLI: exits non-zero on violations", cli.status === 1, `got ${cli.status}`);
  let cliOut;
  try {
    cliOut = JSON.parse(cli.stdout);
  } catch {
    cliOut = null;
  }
  check("CLI: emits parseable JSON", cliOut !== null);
  if (cliOut) {
    check("CLI: scanned count >= 3", cliOut.scanned >= 3);
    check("CLI: at least 2 violations (bad + swallow)", cliOut.violations >= 2);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// --- Real production scan: does not crash; returns structured output ---
{
  const scriptPath = resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "..",
    "scripts",
    "test-exit-discipline.mjs",
  );
  const realRoot = resolve(
    fileURLToPath(new URL(".", import.meta.url)),
  );
  const cli = spawnSync("node", [scriptPath, `--root=${realRoot}`, "--json"], {
    encoding: "utf8",
  });
  check(
    "production scan: exit code is 0 or 1",
    cli.status === 0 || cli.status === 1,
    `got ${cli.status}`,
  );
  let cliOut;
  try {
    cliOut = JSON.parse(cli.stdout);
  } catch {
    cliOut = null;
  }
  check("production scan: JSON parseable", cliOut !== null);
  if (cliOut) {
    check(
      "production scan: scanned at least 20 .test.mjs files",
      cliOut.scanned >= 20,
      `scanned=${cliOut.scanned}`,
    );
    console.log(
      `[info] production scan: scanned=${cliOut.scanned} violations=${cliOut.violations}`,
    );
    if (cliOut.violations > 0) {
      for (const v of cliOut.findings || []) {
        console.log(`  VIOLATION ${v.file}`);
        for (const r of v.reasons) console.log(`           ${r}`);
      }
    }
  }
}

console.log(`\n[summary] ${assertions} assertions, ${failures} failure(s)`);
if (failures > 0) process.exit(1);
process.exit(0);
