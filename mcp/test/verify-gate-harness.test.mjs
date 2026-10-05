// verify-gate-harness.test.mjs
//
// R33 GAP-2 self-test. Verifies the runGate primitive in
// mcp/scripts/verify-gate.mjs returns structurally-correct verdict objects
// across the six artifact-state truths the workflow must enforce:
//
//   T1 success command + matching stdout regex                  -> PASS
//   T2 non-zero exit when zero expected                          -> FAIL "exit code 1"
//   T3 non-zero exit when that exact code is expected            -> PASS
//   T4 file-state check: exists -> PASS; missing -> FAIL
//   T5 timeout: sleep longer than timeoutMs                      -> FAIL "timeout"
//   T6 spawn-target crash (node throws inline)                   -> FAIL, never throws upward
//
// Run: node test/verify-gate-harness.test.mjs
// Exits 0 on full pass, non-zero on any failure.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../scripts/verify-gate.mjs";

let failures = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(`      ${detail}`);
  }
}

// Scratch dir for T4 file-state checks. Hermetic; removed at end.
const scratch = mkdtempSync(join(tmpdir(), "verify-gate-test-"));
const presentPath = join(scratch, "present.txt");
writeFileSync(presentPath, "hello\n", "utf8");
const absentPath = join(scratch, "definitely-not-here.txt");

try {
  // ---------------- T1 success + stdout regex ----------------
  {
    const v = await runGate({
      name: "T1-echo-hello",
      command: "echo hello",
      expectedExit: 0,
      expectedOutputMatch: /hello/,
    });
    ok("T1 echo hello -> PASS", v.verdict === "PASS", `reason=${v.reason} exit=${v.exit} stdout=${JSON.stringify(v.stdout)}`);
    ok("T1 exit==0", v.exit === 0);
    ok("T1 reason null", v.reason === null);
    ok("T1 gate name preserved", v.gate === "T1-echo-hello");
    ok("T1 durationMs is number", typeof v.durationMs === "number" && v.durationMs >= 0);
  }

  // ---------------- T2 exit 1 when expecting 0 ----------------
  {
    const v = await runGate({
      name: "T2-exit-1",
      command: "exit 1",
      expectedExit: 0,
    });
    ok("T2 exit 1 -> FAIL", v.verdict === "FAIL");
    ok("T2 reason mentions exit code 1", typeof v.reason === "string" && /exit code 1/.test(v.reason), `reason=${v.reason}`);
    ok("T2 exit==1", v.exit === 1);
  }

  // ---------------- T3 exit 2 expected ----------------
  {
    const v = await runGate({
      name: "T3-exit-2-expected",
      command: 'node -e "process.exit(2)"',
      expectedExit: 2,
    });
    ok("T3 exit 2 expected -> PASS", v.verdict === "PASS", `reason=${v.reason} exit=${v.exit}`);
    ok("T3 exit==2", v.exit === 2);
  }

  // ---------------- T4 file-state checks ----------------
  {
    const v = await runGate({
      name: "T4a-present",
      command: "true",
      expectedExit: 0,
      expectedFileStates: [{ path: presentPath, mustExist: true }],
    });
    ok("T4a present file -> PASS", v.verdict === "PASS", `reason=${v.reason}`);
    ok("T4a fileStateChecks recorded", Array.isArray(v.fileStateChecks) && v.fileStateChecks.length === 1);
    ok("T4a present file marked exists", v.fileStateChecks[0].exists === true);
    ok("T4a present file ok=true", v.fileStateChecks[0].ok === true);

    const v2 = await runGate({
      name: "T4b-absent",
      command: "true",
      expectedExit: 0,
      expectedFileStates: [{ path: absentPath, mustExist: true }],
    });
    ok("T4b absent file -> FAIL", v2.verdict === "FAIL");
    ok(
      "T4b reason mentions does not exist",
      typeof v2.reason === "string" && /does not exist/.test(v2.reason),
      `reason=${v2.reason}`,
    );
    ok("T4b file-state ok=false", v2.fileStateChecks[0].ok === false);
    ok("T4b file-state exists=false", v2.fileStateChecks[0].exists === false);
  }

  // ---------------- T5 timeout ----------------
  {
    const v = await runGate({
      name: "T5-timeout",
      command: "sleep 5",
      expectedExit: 0,
      timeoutMs: 250,
    });
    ok("T5 sleep 5 with 250ms timeout -> FAIL", v.verdict === "FAIL");
    ok(
      "T5 reason == timeout",
      v.reason === "timeout",
      `reason=${v.reason} exit=${v.exit}`,
    );
    ok("T5 duration close to or above timeoutMs", v.durationMs >= 200);
  }

  // ---------------- T6 spawn-target crash ----------------
  // node -e "throw new Error(...)" exits with code 1 and writes to stderr.
  // The harness must FAIL gracefully with a structured verdict, NEVER throw.
  {
    let threwUpward = false;
    let v;
    try {
      v = await runGate({
        name: "T6-inline-throw",
        command:
          'node -e "throw new Error(\'verify_gate_self_test_crash\')"',
        expectedExit: 0,
      });
    } catch (e) {
      threwUpward = true;
    }
    ok("T6 runGate did not throw upward", threwUpward === false);
    ok("T6 verdict FAIL", v && v.verdict === "FAIL");
    ok(
      "T6 reason mentions exit code (non-zero)",
      v && typeof v.reason === "string" && /exit code/.test(v.reason),
      `reason=${v && v.reason}`,
    );
    ok(
      "T6 stderr captures the thrown error message",
      v && typeof v.stderr === "string" && /verify_gate_self_test_crash/.test(v.stderr),
      `stderr=${v && v.stderr && v.stderr.slice(0, 200)}`,
    );
  }

  // ---------------- Bonus invariants ----------------
  // Bad input: missing command. Harness must return a structured FAIL, not throw.
  {
    let threwUpward = false;
    let v;
    try {
      v = await runGate({ name: "T7-missing-command" });
    } catch (e) {
      threwUpward = true;
    }
    ok("T7 missing command did not throw", threwUpward === false);
    ok("T7 missing command -> FAIL", v && v.verdict === "FAIL");
    ok(
      "T7 reason mentions missing command",
      v && typeof v.reason === "string" && /command/.test(v.reason),
      `reason=${v && v.reason}`,
    );
  }
} finally {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

if (failures > 0) {
  console.error(`\nverify-gate-harness: ${failures} FAIL`);
  process.exit(1);
}
console.log("\nverify-gate-harness: ALL PASS");
process.exit(0);
