#!/usr/bin/env node
// n10-closure.mjs — WORKUNIT N10 CLOSURE RUNNER.
//
// Runs the messaging-attention invariant eval over FIXTURES ONLY (no live DB,
// daemon off) and emits the single machine-checkable closure line on success:
//
//   INVARIANT_CLOSURE platform_tokens_L2to5=0 degradation_gate=PASS fifth_adapter ranked_ok=true L2to5_diff=EMPTY
//
// Exit 0 iff all three abstraction-invariant gates are green simultaneously
// (grep gate (a), capability-degradation gate (b), synthetic-5th-adapter +
// empty-diff gate (c)). Exit 1 otherwise, printing which gate(s) failed and the
// offending detail so the OWNING node (never N10) can be sent back.
//
// Run: node test/messaging/n10-closure.mjs   (or: npm run msg-n10-closure)

import { runInvariantEval } from "../../lib/messaging/n10-invariant-eval.mjs";

function fmt(n, digits = 6) {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : String(n);
}

function main() {
  const r = runInvariantEval();

  // Human-readable gate report to stderr (the closure line goes to stdout so a
  // wrapper can grep stdout for exactly the machine-checkable line).
  const log = (...a) => process.stderr.write(a.join(" ") + "\n");

  log(`n10 invariant eval — ${r.version}`);
  log(`  fixture: ${r.fixture_path}`);
  log("");
  log(`  pipeline: ${r.pipeline.envelopes_total} envelopes, ${r.pipeline.envelopes_invalid} invalid, ${r.pipeline.ranked.length} ranked rows`);
  log(`  precision=${fmt(r.precision_recall.precision, 4)} recall=${fmt(r.precision_recall.recall, 4)} ` +
      `(no_ambient=${r.precision_recall.no_ambient_chatter_surfaced} no_closer=${r.precision_recall.no_closer_surfaced} all_asks=${r.precision_recall.real_asks_surfaced})`);
  log(`  operator unified: ${r.pipeline.operator.unified} (${r.pipeline.operator.operator_person_id})`);
  log(`  cross-platform dedup row: ${r.pipeline.dedup.cross_platform_row
        ? r.pipeline.dedup.cross_platform_row.platforms.join("+")
        : "NONE"}`);
  log("");
  log(`  GATE (a) grep platform tokens : ${r.gate_a.pass ? "PASS" : "FAIL"}  (count=${r.gate_a.platform_tokens_L2to5})`);
  if (!r.gate_a.pass) {
    for (const m of r.gate_a.offending) log(`      ${m.file}:${m.line}: <${m.token}> ${m.text}`);
  }
  log(`  GATE (b) capability degradation: ${r.gate_b.pass ? "PASS" : "FAIL"}  ` +
      `(delta_L2=${fmt(r.gate_b.delta_L2, 4)} delta_L5=${fmt(r.gate_b.delta_L5)} >= ${r.gate_b.min_delta})`);
  log(`  GATE (c) 5th adapter + diff    : ${r.gate_c.pass ? "PASS" : "FAIL"}  ` +
      `(ranked_ok=${r.gate_c.ranked_ok} L2to5_diff=${typeof r.gate_c.L2to5_diff === "string" ? r.gate_c.L2to5_diff : "NON-EMPTY"} fakeplatform_rows=${r.gate_c.fakeplatform_rows})`);
  if (r.gate_c.L2to5_diff !== "EMPTY" && Array.isArray(r.gate_c.L2to5_diff)) {
    for (const d of r.gate_c.L2to5_diff) log(`      changed: ${d.file}`);
  }
  log("");

  if (r.all_pass && typeof r.closure_line === "string") {
    // The ONE machine-checkable line on stdout.
    process.stdout.write(r.closure_line + "\n");
    log("CLOSURE: all three gates green — the abstraction invariant is PROVEN.");
    process.exit(0);
  } else {
    log("CLOSURE SUPPRESSED: at least one gate is red. The fix lands in the OWNING node, not in N10 (N10 never loosens a gate).");
    process.exit(1);
  }
}

main();
