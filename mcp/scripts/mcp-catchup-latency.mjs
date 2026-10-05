#!/usr/bin/env node
// mcp-catchup-latency.mjs — C1 gate 2: warm memory_catchup latency against the
// REAL stdio MCP server (pattern ported from scripts/mcp-health-latency.mjs /
// mcp-recall-latency.mjs).
//
// WHAT IT DOES.
//   1. Pre-builds/refreshes the per-source catch-up envelope projections at
//      their production paths (storage/catchup-projection/<source-key>.json)
//      via the SAME library entrypoint the server's post-serve rebuild runs
//      (rebuildProjectionForSource — never a fork). This makes the measurement
//      STEADY-STATE: the campaign claim is "a fresh process against WARM disk
//      projections", not "first run ever" (that one full scan is irreducible
//      and is exactly what writes the projections). Skip with --skip-prebuild.
//   2. Spawns a PRIVATE instance of the real stdio server (command/args/env
//      from ~/.claude.json mcpServers.memory, falling back to
//      `node ../server.js`; NEVER touches or restarts running servers).
//   3. Issues tools/call memory_catchup {limit:15, persona:true} TWICE and
//      prints cold (#1) and warm (#2) wall-clock RTTs.
//   4. With --assert-warm-ms N it exits non-zero unless BOTH hold:
//        - warm RTT <= N ms, and
//        - the warm response is an ok envelope carrying a NON-EMPTY rows
//          array. The honesty clause: an error / empty surface is fast by
//          construction and must never satisfy the latency claim (the C1
//          fail-closed fallback degrades to the full stream, never to a
//          silently-empty answer — an empty surface here means the pipeline
//          broke, not that it got fast).
//
// RED-RUN ISOLATION: `--assert-warm-ms 1` must fail before the real threshold
// is trusted.
//
// Usage:
//   node scripts/mcp-catchup-latency.mjs                      # measure only
//   node scripts/mcp-catchup-latency.mjs --assert-warm-ms 300 # gate
//
// Baseline for the before/after table: warm memory_catchup {limit:15,
// persona:true} = 700-1100ms (full re-stream of ~338MB of source ledgers on
// every call, measured 2026-07-12 with the same spawn+2-calls pattern).

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MEMORY_ROOT } from "../lib/config.js";
import { ADAPTER_REGISTRY } from "../lib/messaging/catchup.js";
import {
  rebuildProjectionForSource,
  _awaitPendingProjectionPersists,
} from "../lib/messaging/envelope-projection.js";

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

const results = {
  baseline_warm_catchup_ms: "700-1100",
  baseline_measured: "2026-07-12 (full re-stream of every source ledger per call)",
};

// ---------------------------------------------------------------------------
// 1. Steady-state precondition: per-source projections present + caught up,
//    via the real library entrypoint (same code the server runs post-serve).
// ---------------------------------------------------------------------------
if (!skipPrebuild) {
  const prebuild = {};
  for (const [key, entry] of ADAPTER_REGISTRY.entries()) {
    const t = performance.now();
    const r = rebuildProjectionForSource({
      root: MEMORY_ROOT,
      sourceKey: key,
      ledgerAbsPath: join(MEMORY_ROOT, entry.ledgerPath),
    });
    prebuild[key] = { ms: +(performance.now() - t).toFixed(1), ok: r.ok, reason: r.reason };
  }
  await _awaitPendingProjectionPersists();
  results.prebuild = prebuild;
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

// Parse a tools/call result into the memory envelope.
function envelopeOf(msg) {
  try {
    const content = msg.result?.content;
    const text = Array.isArray(content) ? content.map((c) => c.text || "").join("") : "";
    const envelope = JSON.parse(text);
    return envelope && typeof envelope === "object" ? envelope : null;
  } catch {
    return null;
  }
}

const CATCHUP_ARGS = { limit: 15, persona: true };

let exitCode = 0;
try {
  await rpc(
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "catchup-latency-gate", version: "1.0.0" },
    },
    "initialize",
  );
  results.spawn_to_initialize_ms = +(performance.now() - t0).toFixed(1);
  notify("notifications/initialized", {});

  const cold = await rpc(
    "tools/call",
    { name: "memory_catchup", arguments: CATCHUP_ARGS },
    "memory_catchup#1",
  );
  results.catchup_cold_ms = +cold.rttMs.toFixed(1);
  const coldEnv = envelopeOf(cold.msg);
  results.cold_ok = coldEnv?.ok === true;
  results.cold_rows = Array.isArray(coldEnv?.data?.rows) ? coldEnv.data.rows.length : null;

  const warm = await rpc(
    "tools/call",
    { name: "memory_catchup", arguments: CATCHUP_ARGS },
    "memory_catchup#2",
  );
  results.catchup_warm_ms = +warm.rttMs.toFixed(1);
  const warmEnv = envelopeOf(warm.msg);
  results.warm_ok = warmEnv?.ok === true;
  results.warm_rows = Array.isArray(warmEnv?.data?.rows) ? warmEnv.data.rows.length : null;
  results.warm_platforms = warmEnv?.data?.stats?.platforms ?? null;
  results.warm_personas_present = Array.isArray(warmEnv?.data?.rows)
    ? warmEnv.data.rows.filter((r) => r && r.persona).length
    : null;

  if (assertWarmMs !== null) {
    results.assert_warm_ms = assertWarmMs;
    const latencyOk = results.catchup_warm_ms <= assertWarmMs;
    // Honesty clause: an ok envelope with a NON-EMPTY ranked surface. An
    // error or empty response is fast by construction and can never satisfy
    // the latency claim.
    const honest = results.warm_ok === true && typeof results.warm_rows === "number" && results.warm_rows >= 1;
    results.pass = latencyOk && honest;
    if (!latencyOk) {
      console.error(
        `FAIL  warm memory_catchup ${results.catchup_warm_ms}ms > ${assertWarmMs}ms budget`,
      );
    }
    if (!honest) {
      console.error(
        "FAIL  warm memory_catchup was not an ok envelope with a non-empty rows " +
          "array — an error/empty response cannot satisfy the latency gate",
      );
    }
    if (!results.pass) exitCode = 1;
  }
} catch (e) {
  results.error = String(e);
  results.stderr_first_800 = stderrBuf.slice(0, 800);
  exitCode = 2;
} finally {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2000).unref();
}

console.log(JSON.stringify(results, null, 2));
if (exitCode === 0 && assertWarmMs !== null) {
  console.log(
    `\nLatency gate PASSED: warm memory_catchup ${results.catchup_warm_ms}ms <= ${assertWarmMs}ms ` +
      `(baseline ${results.baseline_warm_catchup_ms}ms, ${results.baseline_measured})`,
  );
}
process.exit(exitCode);
