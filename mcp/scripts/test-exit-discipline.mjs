// test-exit-discipline.mjs
//
// R34 Foundation B9. Static analyzer for test-exit-discipline.
//
// PROBLEM (root cause #2 of R33 triage):
//   A test file can report "3 failure(s) out of 28 assertions" via console.log
//   and still exit 0 because the exit-on-failure guard is missing or buggy.
//   Workflow gates that check "exit code" then trust the test to have wired
//   correct exit semantics. Silent-FAIL slips through.
//
// FIX:
//   Walk every .test.mjs under mcp/test/ (excluding self + fixtures). For each
//   file:
//     - Detect the "discipline class" it belongs to:
//         A) node:assert  -> assertions throw; default uncaught exit 1; OK
//         B) custom check/failure-counter -> requires an explicit
//            "if (<counter> > 0) process.exit(1)" near end-of-file
//         C) throws-on-failure imperative style (no counter, no try/catch
//            around assert sites) -> OK (same as A)
//     - If class B and no exit-guard found, flag the file as SILENT-FAIL risk.
//
//   This is static + best-effort. It cannot prove a test exits correctly
//   under every code path. It catches the specific R33 silent-FAIL pattern
//   (counter + console.log but no exit-guard) which is the empirically
//   recurring failure mode.
//
// CLI:
//   node mcp/scripts/test-exit-discipline.mjs            # scan production
//   node mcp/scripts/test-exit-discipline.mjs --root=<dir>
//   node mcp/scripts/test-exit-discipline.mjs --json
//
// Exit codes:
//   0 = no violations
//   1 = at least one violation OR structural error
//
// Discipline:
//   - Node stdlib only. No new deps.
//   - No filesystem writes.
//   - HERMETIC: reads files only; never executes them.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join, basename } from "node:path";

const DEFAULT_ROOT = resolve(
  new URL(".", import.meta.url).pathname,
  "..",
  "test",
);

// Patterns we look for.
//
// Failure-counter signatures: lines that look like a custom check harness
// incrementing a counter. The presence of any of these in a test file marks
// it as discipline-class B (requires explicit exit-guard).
const COUNTER_INCREMENT_PATTERNS = [
  /\bfailures?\s*\+=\s*1\b/, // failures += 1
  /\bfailures?\+\+\b/, // failures++
  /\bfailed\s*\+=\s*1\b/,
  /\bfailed\+\+\b/,
  /\bfailCount\s*\+=\s*1\b/,
  /\bfailCount\+\+\b/,
  /\bnFail\s*\+=\s*1\b/,
  /\bnFail\+\+\b/,
  /\bfail\s*\+=\s*1\b/, // single-letter "fail" counter
  /\bfail\+\+\b/,
];

// console.log/error FAIL signatures: lines that look like a custom check
// harness emitting a FAIL line. Independent signal of discipline-class B.
const FAIL_LOG_PATTERNS = [
  /console\.(log|error|warn)\([^)]*\bFAIL\b/,
  /console\.(log|error|warn)\([^)]*\bfailure\(s\)\b/i,
  /console\.(log|error|warn)\([^)]*\b\$\{failures?\}\b/,
];

// Exit-guard signatures: presence of any one of these near a counter
// satisfies discipline.
//
// The "if (counter > 0) ... process.exit(1)" gap can be large because the
// error message between guard-open and exit-call may span several lines and
// include multi-line template strings. Use a generous 800-char window. The
// risk of a false-negative (real silent-FAIL hidden by a faraway exit) is
// lower than the false-positive cost of flagging clean tests.
const EXIT_GUARD_PATTERNS = [
  /\bif\s*\(\s*failures?\s*>\s*0\s*\)\s*[\s\S]{0,800}?process\.exit\s*\(\s*1\s*\)/,
  /\bif\s*\(\s*failed\s*>\s*0\s*\)\s*[\s\S]{0,800}?process\.exit\s*\(\s*1\s*\)/,
  /\bif\s*\(\s*failCount\s*>\s*0\s*\)\s*[\s\S]{0,800}?process\.exit\s*\(\s*1\s*\)/,
  /\bif\s*\(\s*nFail\s*>\s*0\s*\)\s*[\s\S]{0,800}?process\.exit\s*\(\s*1\s*\)/,
  /\bif\s*\(\s*fail\s*>\s*0\s*\)\s*[\s\S]{0,800}?process\.exit\s*\(\s*1\s*\)/,
  // Inverted guard: if (failures === 0) {pass} else {process.exit(1)}
  /\bif\s*\(\s*failures?\s*===?\s*0\s*\)\s*\{[\s\S]{0,800}?\}\s*else\s*\{[\s\S]{0,400}?process\.exit\s*\(\s*1\s*\)/,
  /\bif\s*\(\s*failed\s*===?\s*0\s*\)\s*\{[\s\S]{0,800}?\}\s*else\s*\{[\s\S]{0,400}?process\.exit\s*\(\s*1\s*\)/,
  /\bif\s*\(\s*fail\s*===?\s*0\s*\)\s*\{[\s\S]{0,800}?\}\s*else\s*\{[\s\S]{0,400}?process\.exit\s*\(\s*1\s*\)/,
  // Ternary exit on counter: process.exit(failures > 0 ? 1 : 0)
  /\bprocess\.exit\s*\(\s*failures?\s*>\s*0\s*\?\s*1\s*:\s*0\s*\)/,
  /\bprocess\.exit\s*\(\s*failed\s*>\s*0\s*\?\s*1\s*:\s*0\s*\)/,
  /\bprocess\.exit\s*\(\s*failCount\s*>\s*0\s*\?\s*1\s*:\s*0\s*\)/,
  // Equivalent ternary: process.exit(failures === 0 ? 0 : 1)
  /\bprocess\.exit\s*\(\s*failures?\s*===?\s*0\s*\?\s*0\s*:\s*1\s*\)/,
  /\bprocess\.exit\s*\(\s*failed\s*===?\s*0\s*\?\s*0\s*:\s*1\s*\)/,
  /\bprocess\.exit\s*\(\s*failCount\s*===?\s*0\s*\?\s*0\s*:\s*1\s*\)/,
  // exitCode assignment
  /\bprocess\.exitCode\s*=\s*failures?\s*>\s*0\s*\?\s*1\s*:\s*0\b/,
  /\bprocess\.exitCode\s*=\s*1\b/,
  // throw-on-summary pattern
  /\bthrow\s+new\s+Error\([^)]*\$\{failures?\}/,
];

// node:assert use means failures throw -> default uncaught -> exit 1. This
// is discipline-class A; no counter-style guard needed.
const ASSERT_IMPORT_PATTERNS = [
  /from\s+['"]node:assert(?:\/strict)?['"]/,
  /require\(\s*['"]node:assert(?:\/strict)?['"]\s*\)/,
];

// Try/catch that SWALLOWS assertion throws is itself a silent-FAIL risk
// even in discipline-class A. We flag a try block followed by a catch that
// does not re-throw, does not exit, and does not increment a counter, where
// at least one assertion call lives inside the try.
//
// Be conservative: only fire on prefixed assert.* / t.* method calls and a
// short list of canonical bare functions. A bare "match(" or "ok(" is too
// noisy because tests often mock-register match()/ok() handlers.
const ASSERT_CALL_PATTERN =
  /\b(assert\.\w+|strict\.\w+|t\.(?:assert|equal|deepEqual|strictEqual|deepStrictEqual|ok|fail|throws|rejects|notEqual))\s*\(/;

function listTestFiles(root) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name === "fixtures" || name === "node_modules") continue;
        walk(full);
      } else if (st.isFile() && /\.test\.mjs$/.test(name)) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

function classify(text) {
  const usesNodeAssert = ASSERT_IMPORT_PATTERNS.some((re) => re.test(text));
  const hasCounter = COUNTER_INCREMENT_PATTERNS.some((re) => re.test(text));
  const hasFailLog = FAIL_LOG_PATTERNS.some((re) => re.test(text));
  const hasExitGuard = EXIT_GUARD_PATTERNS.some((re) => re.test(text));
  return { usesNodeAssert, hasCounter, hasFailLog, hasExitGuard };
}

function detectSwallowingCatch(text) {
  // Coarse scan: find each "catch (" block. Heuristic: if the catch body
  // (up to matching brace) contains no process.exit, no throw, no counter
  // increment, no console.error of the error, AND the preceding try block
  // contains an assert/strictEqual/etc call, flag it.
  const findings = [];
  const catchRe = /\}\s*catch\s*\(\s*([A-Za-z_$][\w$]*)?\s*\)\s*\{/g;
  let m;
  while ((m = catchRe.exec(text)) !== null) {
    const catchStart = m.index + m[0].length;
    // Walk forward to matching close-brace.
    let depth = 1;
    let i = catchStart;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      i += 1;
    }
    const catchBody = text.slice(catchStart, i - 1);
    // Walk backward from m.index to find the matching opening { of the try.
    let depthBack = 1;
    let j = m.index - 1;
    while (j >= 0 && depthBack > 0) {
      const ch = text[j];
      if (ch === "}") depthBack += 1;
      else if (ch === "{") depthBack -= 1;
      j -= 1;
    }
    const tryBody = text.slice(j + 2, m.index);
    if (!ASSERT_CALL_PATTERN.test(tryBody)) continue;
    // A catch body is NOT swallowing if it:
    //   - rethrows / process.exits
    //   - touches a failures counter
    //   - calls a fail(...) or check(...)/assert(...) helper (test-harness
    //     idiom: catch translates a thrown error into a recorded failure)
    //   - returns up the stack (caller decides; common in async tests)
    const swallows =
      !/process\.exit\s*\(/.test(catchBody) &&
      !/\bthrow\b/.test(catchBody) &&
      !/\b(failures?|failed|failCount|nFail)\b/.test(catchBody) &&
      !/\b(fail|check|assert|expect|t\.(fail|equal|deepEqual))\s*\(/.test(catchBody) &&
      !/\breturn\b/.test(catchBody);
    if (swallows) {
      const lineNo = text.slice(0, m.index).split(/\r?\n/).length;
      findings.push({ kind: "swallowing-catch", line: lineNo });
    }
  }
  return findings;
}

function analyze(file) {
  const text = readFileSync(file, "utf8");
  const cls = classify(text);
  const reasons = [];

  // Class B violation: counter or fail-log without exit-guard.
  if ((cls.hasCounter || cls.hasFailLog) && !cls.hasExitGuard) {
    reasons.push(
      "counter or FAIL-log present without exit-guard (process.exit(1) on >0 failures)",
    );
  }

  // Class A check: try/catch that swallows assertion throws.
  const swallowing = detectSwallowingCatch(text);
  for (const s of swallowing) {
    reasons.push(`try/catch around assertion(s) does not exit/rethrow (line ${s.line})`);
  }

  return {
    file,
    pass: reasons.length === 0,
    reasons,
    classification: cls,
  };
}

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, json: false };
  for (const a of argv) {
    if (a.startsWith("--root=")) out.root = resolve(a.slice("--root=".length));
    else if (a === "--json") out.json = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.root)) {
    console.error(`test-exit-discipline: root does not exist: ${args.root}`);
    process.exit(1);
  }
  const files = listTestFiles(args.root);
  // Self-exclusion: do not scan this scanner's own self-test fixture path
  // (real test files are scanned normally; fixtures live under .../fixtures
  // which listTestFiles skips).
  const results = files.map(analyze);
  const violations = results.filter((r) => !r.pass);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          scanned: results.length,
          violations: violations.length,
          findings: violations,
        },
        null,
        2,
      ),
    );
  } else {
    for (const v of violations) {
      console.log(`VIOLATION  ${v.file}`);
      for (const r of v.reasons) console.log(`           ${r}`);
    }
    console.log(
      `test-exit-discipline: scanned ${results.length} .test.mjs files; ${violations.length} violation(s)`,
    );
  }
  process.exit(violations.length === 0 ? 0 : 1);
}

// Export internals for the self-test.
export { listTestFiles, classify, detectSwallowingCatch, analyze };

// Run only when invoked as CLI.
// Main-module check that survives spaces and symlinks in the invocation path:
// compare real filesystem paths, never a hand-built file:// string.
const invokedAsCli = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedAsCli) {
  main();
}
