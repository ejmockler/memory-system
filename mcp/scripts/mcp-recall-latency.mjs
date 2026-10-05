#!/usr/bin/env node
// mcp-recall-latency.mjs — Q4 gate 2: first-memory_recall-per-session latency
// against the REAL stdio MCP server (pattern ported from
// scripts/mcp-health-latency.mjs, itself ported from the 2026-07-12 throwaway
// harness that measured the 12.5s cold-recall baseline).
//
// WHAT IT DOES.
//   1. Pre-builds/refreshes the four Q4 projection caches at their production
//      paths via the SAME library code the server runs (never a fork):
//        - ledger byte-offset sidecar        (<ledger>.offsets, v2 checkpoint)
//        - derivation-graph cache            (storage/derivation-graph.cache.json)
//        - hard-gates raw-scan cache         (storage/hard-gates-scan.cache.json)
//        - latest-backfill map cache         (storage/feature-backfill-map.cache.json)
//      This makes the measurement STEADY-STATE: the campaign claim is "a fresh
//      process against WARM disk caches", not "first run ever after deploy"
//      (that one full scan is irreducible and is what writes the caches).
//      Skip with --skip-prebuild. Per-step prebuild timings + cold-seed modes
//      are reported so a silent full-scan regression is visible here.
//   2. Spawns a PRIVATE instance of the real stdio server (command/args/env
//      from ~/.claude.json mcpServers.memory, falling back to
//      `node ../server.js`; NEVER touches or restarts running servers), with
//      RECALL_PROF=1 so the handler's env-gated stage marks land on stderr.
//   3. Issues ONE tools/call memory_recall — the cold, first-of-session call
//      the 12.5s baseline measured — and prints the wall-clock RTT plus the
//      per-stage PROF breakdown.
//   4. With --assert-cold-ms N it exits non-zero unless BOTH hold:
//        - cold RTT <= N ms, and
//        - the response is an ok envelope AND not degraded_recall (a dense-
//          leg-less degraded response is fast by construction and must never
//          satisfy the latency claim — honesty clause, mirrors the health
//          gate's degrade guard).
//
// QUERYD NOTE (re-scoped Q4): recall scoring runs in-process in this wave
// (Q2 wires the queryd client separately). The script detects a live queryd
// (storage/queryd/queryd.lock, pid alive) and REPORTS it, but never starts
// one against production trees; when none is running the printed number IS
// the in-process number, and the report says so.
//
// RED-RUN ISOLATION: `--assert-cold-ms 1` must fail before the real
// threshold is trusted.
//
// Usage:
//   node scripts/mcp-recall-latency.mjs                       # measure only
//   node scripts/mcp-recall-latency.mjs --assert-cold-ms 2500 # gate
//   node scripts/mcp-recall-latency.mjs --skip-rerank         # attribution run
//
// --skip-rerank (R2/WI4): spawns the server with LOCAL_RERANKER_ENABLED="0",
// the explicit OFF override, so the rerank stage's local-reranker HTTP cost
// (989-1378 ms in the Q4 fix-2 breakdown) can be attributed by difference.
// b4: this assignment only became load-bearing once _localRerankerEnabled()
// went tri-state — while the resolver was `CAP === true || env === "1"` and
// the CAP shipped true, "0" was inert and rerank_skipped:true labelled a
// rerank-INCLUSIVE run. It changes ONLY
// the spawned server's env — recall.js/rerank.js are untouched — and the
// output labels itself (rerank_skipped) so a rerank-off number can never be
// silently passed off as the production-path number.
//
// Baseline for the before/after table: first memory_recall per session =
// ~12.5s (projection full scans + exact-mtime cache defeats, measured
// 2026-07-12 with the same spawn+call pattern).

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { STORAGE_DIR, memoryLedgerPath } from "../lib/config.js";

const OVERALL_TIMEOUT_MS = 240000;

const argv = process.argv.slice(2);
let assertColdMs = null;
const skipPrebuild = argv.includes("--skip-prebuild");
const skipRerank = argv.includes("--skip-rerank");
const acIdx = argv.indexOf("--assert-cold-ms");
if (acIdx !== -1) {
  assertColdMs = Number(argv[acIdx + 1]);
  if (!Number.isFinite(assertColdMs) || assertColdMs <= 0) {
    console.error("--assert-cold-ms requires a positive number");
    process.exit(2);
  }
}

const results = {
  baseline_first_recall_ms: 12500,
  baseline_measured: "2026-07-12",
};

// ---------------------------------------------------------------------------
// 0. queryd detection (report-only; NEVER started here).
// ---------------------------------------------------------------------------
function detectLiveQueryd() {
  try {
    const lockPath = join(STORAGE_DIR, "queryd", "queryd.lock");
    if (!existsSync(lockPath)) return { running: false };
    const raw = JSON.parse(readFileSync(lockPath, "utf8"));
    const pid = Number(raw && raw.pid);
    if (!Number.isInteger(pid) || pid <= 0) return { running: false };
    try {
      process.kill(pid, 0);
      return { running: true, pid };
    } catch {
      return { running: false };
    }
  } catch {
    return { running: false };
  }
}
results.queryd = detectLiveQueryd();
results.measurement_mode = results.queryd.running
  ? "operator-live-queryd-present (recall still scores in-process this wave)"
  : "in-process (no live queryd; none started — production trees are never touched by a script-spawned queryd)";

// ---------------------------------------------------------------------------
// 1. Steady-state precondition: the four projection caches present + caught
//    up, via the real library entrypoints (same code the server runs).
// ---------------------------------------------------------------------------
if (!skipPrebuild) {
  const ledgerPath = memoryLedgerPath();
  const prebuild = {};

  {
    // buildOffsetIndex (not writeOffsetSidecar): the cold branch loads the
    // existing v2 sidecar, folds the delta, and only schedules a rewrite when
    // one is actually needed (first-ever build, discontinuity, or a delta
    // past the size gate) — an exact-eof prebuild tick rewrites nothing.
    const t = performance.now();
    const offsetMod = await import("../lib/recall/ledger-offset-index.js");
    const built = offsetMod.buildOffsetIndex(ledgerPath);
    await offsetMod._awaitPendingSidecarWrites();
    prebuild.offset_sidecar = {
      ms: +(performance.now() - t).toFixed(1),
      entries: built ? built.byId.size : -1,
      sidecar_present: existsSync(offsetMod.offsetSidecarPath(ledgerPath)),
    };
  }
  {
    const t = performance.now();
    const dg = await import("../lib/synthesis/derivation-graph.js");
    await dg.loadOrRebuildDerivationGraph({
      ledgerPath,
      cachePath: join(STORAGE_DIR, "derivation-graph.cache.json"),
    });
    await dg._awaitPendingGraphCachePersists();
    prebuild.derivation_graph = {
      ms: +(performance.now() - t).toFixed(1),
      cold_seed: dg.__peekColdSeedStatsForTests(),
    };
  }
  {
    const t = performance.now();
    const hg = await import("../lib/recall/hard-gates.js");
    await hg.loadTransitiveOrphanMap({});
    await hg._awaitPendingScanCachePersists();
    prebuild.hard_gates_scan = {
      ms: +(performance.now() - t).toFixed(1),
      cold_seed: hg.__peekScanColdStatsForTests(),
    };
  }
  {
    const t = performance.now();
    const mfs = await import("../lib/recall/multi-feature-score.js");
    mfs.buildLatestBackfillMap(ledgerPath);
    await mfs._awaitPendingBackfillCachePersists();
    prebuild.backfill_map = {
      ms: +(performance.now() - t).toFixed(1),
      cold_seed: mfs.__peekBackfillColdStatsForTests(),
    };
  }
  {
    // Q4 FIX CYCLE 2 — the FIFTH projection: buildEngagementPriorMap
    // (recall.js engagement leg) cold-seeds from a checkpoint-validated cache
    // since FIX CYCLE 2; before that it full-scanned the multi-GB ledger on
    // every fresh process (the remaining 2500ms blocker).
    const t = performance.now();
    const epr = await import("../lib/synthesis/engagement-prior-reader.js");
    epr.buildEngagementPriorMap(ledgerPath);
    await epr._awaitPendingEngagementPersists();
    prebuild.engagement_prior = {
      ms: +(performance.now() - t).toFixed(1),
      cold_seed: epr.__peekEngagementColdStatsForTests(),
    };
  }
  results.prebuild = prebuild;
}

// ---------------------------------------------------------------------------
// 2. Spawn the real stdio server (private instance) with RECALL_PROF=1.
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
env.RECALL_PROF = "1"; // env-gated stage marks (lib/tools/recall.js __mark)
if (skipRerank) {
  // Attribution mode: neutralize the rerank stage in the SPAWNED server only.
  // Both backends are gated by env this run controls: LOCAL_RERANKER_ENABLED
  // ="0" is the tri-state OFF override, which beats CAPS.LOCAL_RERANKER_ENABLED
  // whatever the CAP is pinned to (it ships TRUE), and the
  // gemini path with NO key degrades to the final_score sort (reorder-only
  // contract; validation.js documents this exact degrade). The honesty
  // clause below still applies unchanged, and the report carries
  // rerank_skipped so this number is never conflated with the
  // production-path one.
  env.LOCAL_RERANKER_ENABLED = "0";
  delete env.GEMINI_API_KEYS;
  delete env.GEMINI_API_KEY;
}
results.rerank_skipped = skipRerank;
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

// Per-stage numbers: the handler's env-gated `PROF <label> <ms>ms` stderr
// lines (lib/tools/recall.js __mark).
function profStagesOf(stderrText) {
  const stages = [];
  for (const line of stderrText.split("\n")) {
    const m = /^PROF\s+(\S+)\s+(\d+(?:\.\d+)?)ms$/.exec(line.trim());
    if (m) stages.push({ stage: m[1], ms: Number(m[2]) });
  }
  return stages;
}

let exitCode = 0;
try {
  await rpc(
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "recall-latency-gate", version: "1.0.0" },
    },
    "initialize",
  );
  results.spawn_to_initialize_ms = +(performance.now() - t0).toFixed(1);
  notify("notifications/initialized", {});

  const cold = await rpc(
    "tools/call",
    {
      name: "memory_recall",
      arguments: {
        surrounding_context: {
          current_query: "recall latency gate: what did I work on most recently?",
          recent_turns: [
            { role: "user", content: "summarize my recent memory-system work" },
          ],
          agent_role: "assistant",
          time: new Date().toISOString(),
          ambient: null,
          recent_recall_ids: [],
        },
        conversation_id: "recall-latency-gate",
        max_items: 8,
        max_chars: 4000,
      },
    },
    "memory_recall#1",
  );
  results.recall_cold_ms = +cold.rttMs.toFixed(1);
  results.spawn_to_first_recall_total_ms = +(performance.now() - t0).toFixed(1);
  const envelope = envelopeOf(cold.msg);
  results.envelope_ok = envelope?.ok === true;
  results.degraded_recall = envelope?.data?.degraded_recall ?? null;
  results.candidate_set_size = envelope?.data?.candidate_set_size ?? null;
  results.memories_returned = Array.isArray(envelope?.data?.memories)
    ? envelope.data.memories.length
    : null;
  results.stages = profStagesOf(stderrBuf);

  if (assertColdMs !== null) {
    results.assert_cold_ms = assertColdMs;
    const latencyOk = results.recall_cold_ms <= assertColdMs;
    // Honesty clause: ok envelope, dense leg alive, AND a NON-VACUOUS
    // candidate set. A recall over refused/empty indices (e.g. the live
    // daemon's index-manifest churn window reports degraded_recall=false
    // with candidate_set_size=0) is fast by construction and must never
    // satisfy the latency claim.
    const honest =
      results.envelope_ok === true &&
      results.degraded_recall === false &&
      typeof results.candidate_set_size === "number" &&
      results.candidate_set_size >= 1;
    results.pass = latencyOk && honest;
    if (!latencyOk) {
      console.error(
        `FAIL  cold memory_recall ${results.recall_cold_ms}ms > ${assertColdMs}ms budget`,
      );
    }
    if (!honest) {
      console.error(
        "FAIL  cold memory_recall response was not an ok, non-degraded, non-empty " +
          "envelope — a degraded, error, or empty-candidate-set response cannot " +
          "satisfy the latency gate",
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
if (exitCode === 0 && assertColdMs !== null) {
  console.log(
    `\nLatency gate PASSED: cold memory_recall ${results.recall_cold_ms}ms <= ${assertColdMs}ms ` +
      `(baseline ${results.baseline_first_recall_ms}ms, ${results.baseline_measured})`,
  );
}
process.exit(exitCode);
