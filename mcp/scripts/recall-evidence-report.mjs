#!/usr/bin/env node
// recall-evidence-report.mjs — e5. A THIN FORMATTER over
// mcp/lib/recall/recall-observables.js.
//
// WHAT THIS FILE OWNS: argument parsing and layout. That is all.
//
// It owns NO counter — `computeRecallObservables` is the single home for
// every number printed below, and this file never adds, averages, rescales
// or re-derives one. It owns no quality constant and makes no comparison
// against one, so there is no colour to print and no exit code that means
// "healthy": exit 0 means A REPORT WAS PRODUCED, nothing more. The same
// discipline is stated at length in verify-lexical-coverage-gate.mjs's
// header, with the opposite conclusion — that file IS a gate and owns an
// exit code that rules; this one deliberately does not.
//
// SCALE: every `pct` below is a FRACTION in [0,1], as the envelope's
// `rate_scale` field states. Nothing here multiplies by 100; the percent
// column is a DISPLAY of the same fraction and the fraction is printed
// alongside it in --json.
//
// READ-ONLY: this file performs no filesystem mutation of any kind — no
// write / append / mkdir / rename / unlink call appears in it, and its only
// output is stdout plus usage and diagnostics on stderr. Its one import
// beyond node:path reads with `statSync` and a read-only line stream.
//
// USAGE
//   node mcp/scripts/recall-evidence-report.mjs \
//     [--recall-log PATH] [--split-at ISO] [--since ISO] [--until ISO] \
//     [--min-sample N] [--json]
//
//   --recall-log PATH   default: recallLedgerPath() (mcp/lib/config.js)
//   --split-at ISO      produce two segments, `before` over [since, split-at)
//                       and `at_or_after` over [split-at, until]. Omit for a
//                       single `all` segment. THIS IS A PARAMETER: no publish
//                       instant is baked into the code on either side.
//   --since ISO         window start, inclusive. Default: unbounded.
//   --until ISO         window end, inclusive. Default: now.
//   --min-sample N      floor beneath which a segment prints raw counts and
//                       suppresses every percentage. Default: 30.
//   --json              print the envelope as one line of JSON instead of the
//                       human layout.
//   --help              this text on stderr, exit 2.
//
// Both `--flag value` and `--flag=value` are accepted.
//
// EXIT CODES
//   0  a report was produced
//   1  the reporter threw — an absent, unreadable or mid-scan-failed log, or
//      an unparseable boundary. Nothing is printed to stdout in this case:
//      an unreadable log must never render as an all-zero report.
//   2  bad invocation or --help.

import { resolve } from "node:path";

import { recallLedgerPath } from "../lib/config.js";
import { computeRecallObservables } from "../lib/recall/recall-observables.js";

const USAGE = [
  "recall-evidence-report.mjs — read-only observables over recall.jsonl.",
  "",
  "  --recall-log PATH   default: recallLedgerPath()",
  "  --split-at ISO      two segments: [since, split-at) and [split-at, until]",
  "  --since ISO         window start, inclusive (default: unbounded)",
  "  --until ISO         window end, inclusive (default: now)",
  "  --min-sample N      percentage-suppression floor (default: 30)",
  "  --json              one line of JSON instead of the human layout",
  "  --help              this text (exit 2)",
  "",
  "Exit: 0 report produced | 1 nothing readable to report on | 2 bad invocation.",
].join("\n");

const VALUE_FLAGS = new Set([
  "--recall-log",
  "--split-at",
  "--since",
  "--until",
  "--min-sample",
]);

function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { usage: true };
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    if (!VALUE_FLAGS.has(key)) {
      return { usage: true, error: `unknown argument ${JSON.stringify(arg)}` };
    }
    let val;
    if (eq === -1) {
      val = argv[i + 1];
      i += 1;
    } else {
      val = arg.slice(eq + 1);
    }
    if (typeof val !== "string" || val.length === 0) {
      return { usage: true, error: `argument ${JSON.stringify(key)} needs a value` };
    }
    out[key] = val;
  }
  return out;
}

/** Render a suppression-aware rate. No arithmetic happens here. */
function fmtRate(label, r) {
  if (r.pct === null) {
    return `${label}: ${r.count} (pct suppressed: ${r.suppressed})`;
  }
  return `${label}: ${r.count} (${r.pct})`;
}

function fmtHist(map) {
  const keys = Object.keys(map);
  if (keys.length === 0) return "{}";
  return keys.map((k) => `${k}=${map[k]}`).join("  ");
}

function fmtDist(label, d) {
  const head = `${label}: n=${d.count} min=${d.min} max=${d.max} mean=${d.mean}`;
  const mid =
    d.suppressed === null
      ? ` p50=${d.p50} p90=${d.p90}`
      : ` p50/p90 suppressed (${d.suppressed}) values=[${(d.values || []).join(",")}]`;
  const modes = d.modes.map((m) => `${m.value}x${m.count}`).join(" ");
  return `${head}${mid}\n      modes: ${modes}`;
}

function printSegment(seg) {
  const out = [];
  // `since` / `until` are the operator's own values, echoed verbatim; an
  // unset bound is shown as such rather than invented.
  out.push(
    `  [${seg.label}] ${seg.interval}  since=${seg.since ?? "(unset)"}  ` +
      `until=${seg.until ?? "(unset)"}`,
  );
  out.push(`    n = ${seg.n}`);
  out.push(`    ${fmtDist("surfaced", seg.surfaced)}`);
  out.push(`    ${fmtDist("candidates_pre_truncation", seg.candidates_pre_truncation)}`);
  if (seg.rows_without_surfaced_array > 0 || seg.rows_without_candidates_array > 0) {
    out.push(
      `    rows missing an array: surfaced=${seg.rows_without_surfaced_array} ` +
        `candidates=${seg.rows_without_candidates_array}`,
    );
  }
  out.push(`    ${fmtRate("empty_surfaced", seg.empty_surfaced_rate)}`);
  out.push(`    ${fmtRate("empty_candidates", seg.empty_candidate_rate)}`);
  out.push(
    `    ${fmtRate("empty_BOTH (coincidence)", seg.empty_surfaced_and_candidate_rate)}`,
  );
  out.push(`    -- degrade axis (a): raw degraded_recall flag --`);
  out.push(`    ${fmtRate("degraded_recall_flag", seg.degraded_recall_flag_rate)}`);
  out.push(
    `    ${fmtRate("degraded_wide (coverage-probe test, incl. populator.degraded)", seg.degraded_wide_rate)}`,
  );
  out.push(`    -- degrade axis (b): open cause histogram --`);
  out.push(`    degrade_cause: ${fmtHist(seg.degrade_cause_histogram)}`);
  out.push(`    -- degrade axis (c): Layer 3 / rerank, NEVER summed into (a) --`);
  out.push(`    ${fmtRate("degraded_recall_layer3", seg.degraded_recall_layer3_rate)}`);
  out.push(`    layer3_reason: ${fmtHist(seg.layer3_reason_histogram)}`);
  out.push(
    `    rerank_reason_without_layer3: ${seg.rerank_reason_without_layer3_count}`,
  );
  return out.join("\n");
}

function printHuman(env) {
  const lines = [];
  lines.push(`recall-evidence-report — ${env.recall_log_path}`);
  lines.push(`generated_at=${env.generated_at}  rate_scale=${env.rate_scale}  min_sample=${env.min_sample}`);
  lines.push(
    `window: since=${env.window.since ?? "(unbounded)"} until=${env.window.until}` +
      `  split_at=${env.split_at ?? "(none)"}`,
  );
  lines.push(
    `scan: total_lines=${env.scan.total_lines} parsed_lines=${env.scan.parsed_lines} ` +
      `skipped=${env.scan.skipped} recall_rows_seen=${env.scan.recall_rows_seen} ` +
      `in_window=${env.scan.in_window_rows} out_of_window=${env.scan.out_of_window_rows} ` +
      `non_recall=${env.scan.non_recall_rows}`,
  );
  lines.push("");
  lines.push(printSegment(env.totals));
  lines.push("");
  for (const seg of env.segments) {
    lines.push(printSegment(seg));
    lines.push("");
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.usage) {
    if (args.error) process.stderr.write(`${args.error}\n\n`);
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  let minSample;
  if (args["--min-sample"] !== undefined) {
    const n = Number(args["--min-sample"]);
    if (!Number.isFinite(n) || n < 0) {
      process.stderr.write(
        `--min-sample must be a non-negative number, got ${JSON.stringify(args["--min-sample"])}\n`,
      );
      process.exitCode = 2;
      return;
    }
    minSample = n;
  }

  const recallLogPath =
    args["--recall-log"] === undefined
      ? recallLedgerPath()
      : resolve(process.cwd(), args["--recall-log"]);

  let env;
  try {
    env = computeRecallObservables({
      recallLogPath,
      since: args["--since"],
      until: args["--until"],
      splitAt: args["--split-at"],
      minSample,
    });
  } catch (e) {
    // Nothing goes to stdout on this path. An unreadable log must never
    // render as an all-zero report.
    process.stderr.write(`${e && e.message ? e.message : String(e)}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(args.json ? `${JSON.stringify(env)}\n` : `${printHuman(env)}\n`);
  process.exitCode = 0;
}

main();
