#!/usr/bin/env node
// mcp-health-latency.mjs — H2 gate 2: memory_health warm-call latency against
// the REAL stdio MCP server (pattern ported from the 2026-07-12 throwaway
// timing harness that measured the 7.3s full-scan baseline).
//
// WHAT IT DOES.
//   1. Pre-builds/refreshes the reducer state at the production state path
//      (STORAGE_DIR/health-reducer-state/state.json) via the H1 library —
//      the same fold the handler's off-handler rebuild child runs. This
//      makes the measurement STEADY-STATE: without it, a first-ever run
//      would measure the fast degrade path (last-known-good + note), which
//      is not the number the campaign claims. Skip with --skip-prebuild.
//   2. Spawns a PRIVATE instance of the real stdio server (command/args/env
//      from ~/.claude.json mcpServers.memory, falling back to
//      `node ../server.js`; never touches running servers), initializes,
//      then issues tools/call memory_health TWICE.
//   3. Prints cold (#1) and warm (#2) wall-clock RTTs. With
//      --assert-warm-ms N it exits non-zero unless BOTH hold:
//        - warm RTT <= N ms, and
//        - the warm response is NOT degraded (synthesis_coverage non-null,
//          no `synthesis_state_rebuilding:` note). The second clause keeps
//          the gate honest: a degrade-path response is fast by construction
//          and must never satisfy the latency claim.
//
// RED-RUN ISOLATION: `--assert-warm-ms 1` must fail before the real
// threshold is trusted.
//
// Usage:
//   node scripts/mcp-health-latency.mjs                      # measure only
//   node scripts/mcp-health-latency.mjs --assert-warm-ms 400 # gate
//
// Baseline for the before/after table: memory_health = 7.3s (full-scan
// implementation, measured 2026-07-12 with the same spawn+2-calls pattern).

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { STORAGE_DIR, memoryLedgerPath, recallLedgerPath } from "../lib/config.js";
import { loadState, saveState, updateStateFromLedgers } from "../lib/synthesis/health-reducers.js";

const OVERALL_TIMEOUT_MS = 240000;

const argv = process.argv.slice(2);
let assertWarmMs = null;
const skipPrebuild = argv.includes("--skip-prebuild");
const awIdx = argv.indexOf("--assert-warm-ms");
if (awIdx !== -1) {
  assertWarmMs = Number(argv[awIdx + 1]);
  if (!Number.isFinite(assertWarmMs) || assertWarmMs <= 0) {
    console.error("--assert-warm-ms requires a positive number");
    process.exit(2);
  }
}

const results = { baseline_full_scan_ms: 7300, baseline_measured: "2026-07-12" };

// ---------------------------------------------------------------------------
// 1. Steady-state precondition: reducer state present + caught up.
// ---------------------------------------------------------------------------
const statePath = join(STORAGE_DIR, "health-reducer-state", "state.json");
if (!skipPrebuild) {
  const t = performance.now();
  const { state, stats } = updateStateFromLedgers(loadState(statePath), {
    ledgerPath: memoryLedgerPath(),
    recallLogPath: recallLedgerPath(),
  });
  mkdirSync(dirname(statePath), { recursive: true });
  saveState(statePath, state);
  results.prebuild_ms = +(performance.now() - t).toFixed(1);
  results.prebuild_mode = { memory: stats.memory.mode, recall: stats.recall.mode };
}

// ---------------------------------------------------------------------------
// 2. Spawn the real stdio server (private instance).
// ---------------------------------------------------------------------------
let command = process.execPath;
let args = [fileURLToPath(new URL("../server.js", import.meta.url))];
let env = { ...process.env };
try {
  const cfg = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")).mcpServers?.memory;
  if (cfg && typeof cfg.command === "string") {
    command = cfg.command;
    args = Array.isArray(cfg.args) ? cfg.args : [];
    env = { ...process.env, ...(cfg.env || {}) };
  }
} catch {
  /* fall back to node ../server.js */
}
results.server = { command, args };

const t0 = performance.now();
const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
let stderrBuf = "";
child.stderr.on("data", (d) => {
  stderrBuf += d.toString();
});

let buf = "";
const pending = new Map(); // id -> { label, sentAt, resolve, reject, timer }
child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve({ msg, rttMs: performance.now() - p.sentAt });
    }
  }
});

let nextId = 1;
function rpc(method, params, label) {
  const id = nextId++;
  const sentAt = performance.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${label}`));
      }
    }, OVERALL_TIMEOUT_MS);
    pending.set(id, { label, sentAt, resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

// Parse a tools/call result into the memory envelope's data payload.
function healthDataOf(msg) {
  try {
    const content = msg.result?.content;
    const text = Array.isArray(content) ? content.map((c) => c.text || "").join("") : "";
    const envelope = JSON.parse(text);
    return envelope && typeof envelope === "object" ? envelope.data : null;
  } catch {
    return null;
  }
}
function isDegraded(data) {
  if (data === null || typeof data !== "object") return true;
  if (data.synthesis_coverage === null || data.synthesis_coverage === undefined) return true;
  const notes = Array.isArray(data.health_notes) ? data.health_notes : [];
  return notes.some((n) => typeof n === "string" && n.startsWith("synthesis_state_rebuilding"));
}

let exitCode = 0;
try {
  const init = await rpc(
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "health-latency-gate", version: "1.0.0" },
    },
    "initialize",
  );
  results.spawn_to_initialize_ms = +(performance.now() - t0).toFixed(1);
  void init;
  notify("notifications/initialized", {});

  const cold = await rpc("tools/call", { name: "memory_health", arguments: {} }, "memory_health#1");
  results.memory_health_cold_ms = +cold.rttMs.toFixed(1);
  results.cold_degraded = isDegraded(healthDataOf(cold.msg));

  const warm = await rpc("tools/call", { name: "memory_health", arguments: {} }, "memory_health#2");
  results.memory_health_warm_ms = +warm.rttMs.toFixed(1);
  const warmData = healthDataOf(warm.msg);
  results.warm_degraded = isDegraded(warmData);
  results.warm_facts_in_window = warmData?.synthesis_coverage?.facts_in_window ?? null;

  if (assertWarmMs !== null) {
    results.assert_warm_ms = assertWarmMs;
    const latencyOk = results.memory_health_warm_ms <= assertWarmMs;
    const honest = results.warm_degraded === false;
    results.pass = latencyOk && honest;
    if (!latencyOk) {
      console.error(
        `FAIL  warm memory_health ${results.memory_health_warm_ms}ms > ${assertWarmMs}ms budget`,
      );
    }
    if (!honest) {
      console.error(
        "FAIL  warm memory_health served the DEGRADE path (synthesis_coverage null or " +
          "synthesis_state_rebuilding note) — a degraded response cannot satisfy the latency gate",
      );
    }
    if (!results.pass) exitCode = 1;
  }
} catch (e) {
  results.error = String(e);
  results.stderr_first_500 = stderrBuf.slice(0, 500);
  exitCode = 2;
} finally {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2000).unref();
}

console.log(JSON.stringify(results, null, 2));
if (exitCode === 0 && assertWarmMs !== null) {
  console.log(
    `\nLatency gate PASSED: warm memory_health ${results.memory_health_warm_ms}ms <= ${assertWarmMs}ms ` +
      `(baseline ${results.baseline_full_scan_ms}ms, ${results.baseline_measured})`,
  );
}
process.exit(exitCode);
