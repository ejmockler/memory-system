// verify-gate.mjs
//
// R33 GAP-2 fix. Workflow verification phases must call runGate to enforce
// artifact-state truth instead of trusting agent reports. The harness never
// throws on gate failure; always returns a verdict object the workflow can
// record into its triage schema.
//
// Background: R32 triage trusted Phase-B agents' claim that edits had landed.
// The brutalist read the modified files but the modifications were
// modifications-in-the-agents-report, not modifications-on-disk. R32 shipped
// with 90 surviving hits believing the work was done. This primitive closes
// that loop by running the gate command itself (Bash / Node spawn) and
// reporting {exit, stdout_match, file_state} structurally. A crash is a
// FAIL, not a silent PASS.
//
// Usage as a module:
//   import { runGate } from "./verify-gate.mjs";
//   const v = await runGate({
//     name: "spec-sweep",
//     command: "node ../scripts/spec-sweep.mjs",
//     cwd: "<MEMORY_ROOT>/mcp",
//     expectedExit: 0,
//     expectedOutputMatch: /0 hits/,
//     expectedFileStates: [
//       { path: "<MEMORY_ROOT>/mcp/lib/config.js", mustExist: true },
//     ],
//     timeoutMs: 120000,
//   });
//
// CLI mode:
//   node verify-gate.mjs --gate-spec=/path/to/gate.json
// Prints the verdict object as JSON to stdout. Exits 0 if PASS, 1 if FAIL.
//
// Discipline: no new deps; ES modules; never throws on Bash failure.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Run a verification gate. Always resolves with a verdict object; never throws
 * on a failing command, missing file, timeout, or spawn error.
 *
 * @param {object} opts
 * @param {string} opts.name - Gate label, used in the verdict + logs.
 * @param {string} opts.command - Shell command to run (executed via /bin/sh -c).
 * @param {string} [opts.cwd] - Working directory for the spawn. Defaults to process.cwd().
 * @param {number} [opts.expectedExit=0] - Expected exit code; FAIL on mismatch.
 * @param {string|RegExp} [opts.expectedOutputMatch] - Optional stdout matcher.
 * @param {Array<{path:string, mustExist:boolean, maxBytes?:number, minBytes?:number, mtimeAfter?:number, contentMatch?:string|RegExp}>} [opts.expectedFileStates]
 * @param {Record<string,string>} [opts.env] - Extra env merged on top of process.env.
 * @param {number} [opts.timeoutMs] - Timeout in ms; default 5 minutes.
 * @returns {Promise<{gate:string, exit:number|null, stdout:string, stderr:string, durationMs:number, fileStateChecks:Array<object>, verdict:"PASS"|"FAIL", reason:string|null}>}
 */
export async function runGate(opts) {
  const {
    name,
    command,
    cwd = process.cwd(),
    expectedExit = 0,
    expectedOutputMatch = null,
    expectedFileStates = [],
    env = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts || {};

  if (!name || typeof name !== "string") {
    return {
      gate: String(name || "<unnamed>"),
      exit: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
      fileStateChecks: [],
      verdict: "FAIL",
      reason: "missing required option: name",
    };
  }
  if (!command || typeof command !== "string") {
    return {
      gate: name,
      exit: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
      fileStateChecks: [],
      verdict: "FAIL",
      reason: "missing required option: command",
    };
  }

  const started = Date.now();
  const spawnResult = await spawnCollect({
    command,
    cwd,
    env: { ...process.env, ...env },
    timeoutMs,
  });
  const durationMs = Date.now() - started;

  // File-state checks always run, even on command failure, so the verdict
  // captures the full picture for the triage schema.
  const fileStateChecks = (expectedFileStates || []).map((spec) =>
    checkFileState(spec),
  );

  // Determine verdict.
  let verdict = "PASS";
  let reason = null;

  if (spawnResult.spawnError) {
    verdict = "FAIL";
    reason = `spawn error: ${spawnResult.spawnError}`;
  } else if (spawnResult.timedOut) {
    verdict = "FAIL";
    reason = "timeout";
  } else if (spawnResult.exit !== expectedExit) {
    verdict = "FAIL";
    reason = `exit code ${spawnResult.exit} (expected ${expectedExit})`;
  } else if (expectedOutputMatch != null) {
    if (!matchesOutput(spawnResult.stdout, expectedOutputMatch)) {
      verdict = "FAIL";
      reason = `stdout did not match ${describeMatcher(expectedOutputMatch)}`;
    }
  }
  if (verdict === "PASS") {
    const firstBadFile = fileStateChecks.find((c) => c.ok === false);
    if (firstBadFile) {
      verdict = "FAIL";
      reason = `file-state check failed for ${firstBadFile.path}: ${firstBadFile.reason}`;
    }
  }

  return {
    gate: name,
    exit: spawnResult.exit,
    stdout: spawnResult.stdout,
    stderr: spawnResult.stderr,
    durationMs,
    fileStateChecks,
    verdict,
    reason,
  };
}

function spawnCollect({ command, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("/bin/sh", ["-c", command], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({
        exit: null,
        stdout: "",
        stderr: "",
        spawnError: String((e && e.message) || e),
        timedOut: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, timeoutMs);

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exit: null,
        stdout,
        stderr,
        spawnError: String((e && e.message) || e),
        timedOut,
      });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exit: code,
        stdout,
        stderr,
        spawnError: null,
        timedOut,
        signal: signal || null,
      });
    });
  });
}

function checkFileState(spec) {
  const out = {
    path: spec && spec.path,
    mustExist: !!(spec && spec.mustExist),
    ok: true,
    reason: null,
    exists: false,
    size: null,
    mtimeMs: null,
  };
  if (!spec || !spec.path) {
    out.ok = false;
    out.reason = "missing path";
    return out;
  }
  let st;
  try {
    st = statSync(spec.path);
    out.exists = true;
    out.size = st.size;
    out.mtimeMs = st.mtimeMs;
  } catch {
    out.exists = false;
    if (spec.mustExist) {
      out.ok = false;
      out.reason = "does not exist";
    }
    return out;
  }
  if (spec.mustExist === false && out.exists) {
    out.ok = false;
    out.reason = "exists but mustExist=false";
    return out;
  }
  if (typeof spec.maxBytes === "number" && st.size > spec.maxBytes) {
    out.ok = false;
    out.reason = `size ${st.size} > maxBytes ${spec.maxBytes}`;
    return out;
  }
  if (typeof spec.minBytes === "number" && st.size < spec.minBytes) {
    out.ok = false;
    out.reason = `size ${st.size} < minBytes ${spec.minBytes}`;
    return out;
  }
  if (typeof spec.mtimeAfter === "number" && st.mtimeMs <= spec.mtimeAfter) {
    out.ok = false;
    out.reason = `mtime ${st.mtimeMs} <= mtimeAfter ${spec.mtimeAfter}`;
    return out;
  }
  if (spec.contentMatch != null) {
    let body = "";
    try {
      body = readFileSync(spec.path, "utf8");
    } catch (e) {
      out.ok = false;
      out.reason = `read error: ${String((e && e.message) || e)}`;
      return out;
    }
    if (!matchesOutput(body, spec.contentMatch)) {
      out.ok = false;
      out.reason = `content did not match ${describeMatcher(spec.contentMatch)}`;
      return out;
    }
  }
  return out;
}

function matchesOutput(text, matcher) {
  if (matcher instanceof RegExp) return matcher.test(text);
  return String(text).includes(String(matcher));
}

function describeMatcher(matcher) {
  if (matcher instanceof RegExp) return matcher.toString();
  return JSON.stringify(String(matcher));
}

// ---------------- CLI mode ----------------

async function cliMain(argv) {
  let specPath = null;
  for (const a of argv) {
    if (a.startsWith("--gate-spec=")) {
      specPath = a.slice("--gate-spec=".length);
    }
  }
  if (!specPath) {
    process.stderr.write(
      "usage: node verify-gate.mjs --gate-spec=<path-to-json>\n",
    );
    process.exit(2);
  }
  let spec;
  try {
    spec = JSON.parse(readFileSync(specPath, "utf8"));
  } catch (e) {
    process.stderr.write(
      `failed to read/parse gate spec ${specPath}: ${(e && e.message) || e}\n`,
    );
    process.exit(2);
  }
  // Rehydrate RegExp from {regex, flags} sugar.
  if (spec && spec.expectedOutputMatch && typeof spec.expectedOutputMatch === "object" && spec.expectedOutputMatch.regex) {
    spec.expectedOutputMatch = new RegExp(
      spec.expectedOutputMatch.regex,
      spec.expectedOutputMatch.flags || "",
    );
  }
  const v = await runGate(spec);
  process.stdout.write(JSON.stringify(v, null, 2) + "\n");
  process.exit(v.verdict === "PASS" ? 0 : 1);
}

// Main-module check that survives spaces and symlinks in the invocation path:
// compare real filesystem paths, never a hand-built file:// string.
const INVOKED_DIRECTLY = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (INVOKED_DIRECTLY) {
  cliMain(process.argv.slice(2)).catch((e) => {
    // Defensive: even CLI must not throw upward without a structured verdict.
    process.stdout.write(
      JSON.stringify(
        {
          gate: "<cli>",
          exit: null,
          stdout: "",
          stderr: "",
          durationMs: 0,
          fileStateChecks: [],
          verdict: "FAIL",
          reason: `cli error: ${(e && e.message) || e}`,
        },
        null,
        2,
      ) + "\n",
    );
    process.exit(1);
  });
}
