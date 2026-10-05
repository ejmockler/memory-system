#!/usr/bin/env node
// run-contextual-eval-ab.mjs — N5-contextual-retrieval A/B driver.
//
// Runs the full 6-cell contextual A/B in ONE shot and emits a paired NDJSON
// summary so the gate operator reads a single artifact instead of stitching six
// separate `run-contextual-eval.mjs` invocations:
//
//     {bm25, dense, fused} x {baseline, contextual}
//
// For each LEG it reports the per-arm top_k_failure_rate (K=20, the Anthropic
// axis) + per_stratum, and the per-leg DELTA:
//
//     delta_failure = baseline.top_k_failure_rate - contextual.top_k_failure_rate
//                     ( > 0  => contextual REDUCED the failure rate = a LIFT )
//
// It delegates each cell to run-contextual-eval.mjs (the single source of truth
// for index resolution, chunk-id rollup, embed-server degrade, and the
// skipped_no_contextual_index guard). That child is READ-ONLY on the indices
// (it snapshots), so this driver never mutates a fact row, a ledger, or an
// index (thesis #1). The dense/fused cells degrade gracefully (not crash) when
// the embed server is down: the child emits status=degraded_no_embed_server /
// skipped_no_contextual_index, which we surface verbatim with delta=null so the
// operator knows that leg's number is not yet meaningful.
//
//   node mcp/scripts/run-contextual-eval-ab.mjs [--goldset=path] [--k=20]
//        [--limit=N] [--legs=bm25,dense,fused] [--model=dir]
//
// OUTPUT (NDJSON to stdout):
//   {kind:"contextual_eval_ab_config", ...}
//   {kind:"contextual_eval_ab_cell", leg, arm, status, top_k_failure_rate, ...} x up to 6
//   {kind:"contextual_eval_ab_summary", per_leg:{bm25:{...delta...}, ...}}
//
// Exit 0 always when the runs completed (even degraded); exit 1 only on a hard
// driver failure (bad args / child spawn error / goldset missing).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { LEDGERS_DIR } from "../lib/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(__dirname, "run-contextual-eval.mjs");
// Data root comes from lib/config.js (MEMORY_ROOT, default: this checkout),
// never from the home directory.
const DEFAULT_GOLDSET = join(LEDGERS_DIR, "contextual-eval-goldset.jsonl");

function parseArgs(argv) {
  const opts = {
    goldset: DEFAULT_GOLDSET,
    k: 20,
    limit: 0,
    legs: ["bm25", "dense", "fused"],
    model: null,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--goldset=")) opts.goldset = arg.slice("--goldset=".length);
    else if (arg.startsWith("--k=")) opts.k = Number(arg.slice("--k=".length));
    else if (arg.startsWith("--limit=")) opts.limit = Number(arg.slice("--limit=".length));
    else if (arg.startsWith("--model=")) opts.model = arg.slice("--model=".length);
    else if (arg.startsWith("--legs=")) {
      opts.legs = arg
        .slice("--legs=".length)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: run-contextual-eval-ab.mjs [--goldset=path] [--k=20] [--limit=N] " +
          "[--legs=bm25,dense,fused] [--model=dir]\n",
      );
      process.exit(0);
    }
  }
  return opts;
}

// runCell — spawn run-contextual-eval.mjs for one (leg, arm) and parse the
// terminal NDJSON record (the config line is informational; the result line is
// the one that carries the metrics or the degrade status). Never throws: a
// child crash resolves to a synthetic error cell so the matrix is always
// complete.
function runCell(leg, arm, opts) {
  return new Promise((resolve) => {
    const args = [
      RUNNER,
      "--leg", leg,
      "--index", arm,
      `--goldset=${opts.goldset}`,
      `--k=${opts.k}`,
    ];
    if (opts.limit > 0) args.push(`--limit=${opts.limit}`);
    if (opts.model) args.push(`--model=${opts.model}`);

    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.on("error", (e) => {
      resolve({ leg, arm, status: "child_spawn_error", error: e.message });
    });
    child.on("close", (code) => {
      // Parse the LAST JSON object line that is a result/skip record.
      let result = null;
      let config = null;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj && obj.kind === "contextual_eval_config") config = obj;
        if (obj && obj.kind === "contextual_eval_result") result = obj;
      }
      if (result == null) {
        resolve({
          leg,
          arm,
          status: code === 0 ? "no_result_record" : `child_exit_${code}`,
          config,
        });
        return;
      }
      resolve({
        leg,
        arm,
        status: result.status || "ok",
        top_k_failure_rate:
          typeof result.top_k_failure_rate === "number" ? result.top_k_failure_rate : null,
        recall_at_20: typeof result.recall_at_20 === "number" ? result.recall_at_20 : null,
        n_total: typeof result.n_total === "number" ? result.n_total : null,
        per_stratum: result.per_stratum || null,
        per_leg: result.per_leg || null,
        index_variant_available:
          config && typeof config.index_variant_available === "boolean"
            ? config.index_variant_available
            : null,
      });
    });
  });
}

// A failure rate is only comparable across arms when BOTH arms produced a real
// metric (not a degrade/skip). When either arm is degraded we report delta=null
// so the operator does not read a spurious lift.
function deltaFor(baselineCell, contextualCell) {
  const okStatus = (s) => s === "ok";
  const b = baselineCell && baselineCell.top_k_failure_rate;
  const c = contextualCell && contextualCell.top_k_failure_rate;
  if (
    !okStatus(baselineCell && baselineCell.status) ||
    !okStatus(contextualCell && contextualCell.status) ||
    typeof b !== "number" ||
    typeof c !== "number"
  ) {
    return null;
  }
  // delta > 0 => contextual REDUCED top_k_failure_rate (a lift).
  return Number((b - c).toFixed(6));
}

async function main() {
  const opts = parseArgs(process.argv);
  const VALID_LEGS = new Set(["bm25", "dense", "fused"]);
  const legs = opts.legs.filter((l) => VALID_LEGS.has(l));
  if (legs.length === 0) {
    process.stderr.write(
      `run-contextual-eval-ab: no valid legs in ${JSON.stringify(opts.legs)} ` +
        "(expected bm25|dense|fused)\n",
    );
    process.exit(1);
  }
  if (!existsSync(opts.goldset)) {
    process.stderr.write(`run-contextual-eval-ab: goldset missing: ${opts.goldset}\n`);
    process.exit(1);
  }
  if (!existsSync(RUNNER)) {
    process.stderr.write(`run-contextual-eval-ab: runner missing: ${RUNNER}\n`);
    process.exit(1);
  }

  const config = {
    kind: "contextual_eval_ab_config",
    legs,
    arms: ["baseline", "contextual"],
    goldset: opts.goldset,
    k: opts.k,
    limit: opts.limit,
    model: opts.model,
    runner: RUNNER,
    started_at: new Date().toISOString(),
  };
  process.stdout.write(JSON.stringify(config) + "\n");

  // Run the 2*|legs| cells. Each cell is a read-only child; we run them
  // SEQUENTIALLY so two children never contend on the embed server / a snapshot.
  const cells = {};
  for (const leg of legs) {
    for (const arm of ["baseline", "contextual"]) {
      const cell = await runCell(leg, arm, opts);
      cells[`${leg}:${arm}`] = cell;
      process.stdout.write(
        JSON.stringify({ kind: "contextual_eval_ab_cell", ...cell }) + "\n",
      );
    }
  }

  // Per-leg summary with the baseline - contextual delta.
  const per_leg = {};
  for (const leg of legs) {
    const baselineCell = cells[`${leg}:baseline`];
    const contextualCell = cells[`${leg}:contextual`];
    const delta = deltaFor(baselineCell, contextualCell);
    per_leg[leg] = {
      baseline_failure:
        baselineCell && typeof baselineCell.top_k_failure_rate === "number"
          ? baselineCell.top_k_failure_rate
          : null,
      contextual_failure:
        contextualCell && typeof contextualCell.top_k_failure_rate === "number"
          ? contextualCell.top_k_failure_rate
          : null,
      delta, // baseline - contextual; > 0 => contextual lift; null => incomparable
      baseline_status: baselineCell ? baselineCell.status : "missing",
      contextual_status: contextualCell ? contextualCell.status : "missing",
    };
  }

  process.stdout.write(
    JSON.stringify({
      kind: "contextual_eval_ab_summary",
      per_leg,
      finished_at: new Date().toISOString(),
    }) + "\n",
  );
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`run-contextual-eval-ab: unhandled ${e && e.stack}\n`);
  process.exit(1);
});
