#!/usr/bin/env node
// health-equivalence.mjs — H2 gate 1: reducer-backed health projections are
// byte-equivalent to the original full-scan probes ON THE REAL LEDGERS.
//
// WHAT IT PROVES. memory_health (mcp/lib/tools/health.js) now serves
// synthesis_coverage from computeCoverageFromState and drift_alerts from
// computeDriftFromState (mcp/lib/synthesis/health-reducers.js) instead of
// the full-scan computeSynthesisCoverage / detectDrift. This gate pins a
// newline-safe EOF on the LIVE ledgers (ledger-checkpoint captureCheckpoint,
// READ-ONLY), materializes exactly that prefix, runs BOTH implementations
// over the identical bytes with the identical pinned `now`, and deep-compares
// the structural envelopes. ANY divergence exits non-zero.
//
// WHY A PREFIX COPY. The originals take only {ledgerPath, recallLogPath,
// now} — they cannot be bounded to a byte prefix through their opts, and the
// live ledgers keep growing under the daemons. Both sides therefore run
// against a stream-copied [0, eof) prefix in a temp dir; the live files are
// only ever opened for reading (captureCheckpoint / verifyPrefix / the copy
// source fd). After the copy, the pinned checkpoint is re-verified against
// the live file so a mid-copy rewrite (not append) fails the gate loudly
// instead of comparing mixed bytes.
//
// COMPARISON CONTRACT.
//   - coverage: assert.deepStrictEqual on the raw envelopes, excluding
//     built_at (both sides receive the same pinned now, but the field is a
//     timestamp, not a structural output).
//   - drift: canonicalizeDriftEnvelope on BOTH sides (the original emits
//     Set-insertion version order inside extractor_version_bump alerts,
//     which is not reconstructible from day buckets), then deepStrictEqual
//     excluding built_at.
//
// RED-RUN ISOLATION (prove the gate CAN fail before trusting a pass):
//   node scripts/health-equivalence.mjs --red-run         # perturbs coverage
//   node scripts/health-equivalence.mjs --red-run=drift   # perturbs drift
// Both inject a one-count divergence into the reducer side after computing;
// the run MUST exit non-zero.
//
// Cost: two full scans of memory.jsonl (~2.3GB: original probes + reducer
// rebuild) plus the prefix copy — several seconds BY DESIGN. This is
// gate-time work; the handler itself never full-scans (that is gate 2's
// no-regression guarantee, scripts/mcp-health-latency.mjs).
//
// Exit codes: 0 = equivalent; 1 = divergence (or red-run, as intended);
// 2 = setup/environment failure (nothing proven).

import { deepStrictEqual } from "node:assert/strict";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { captureCheckpoint, verifyPrefix } from "../lib/synthesis/ledger-checkpoint.js";
import { computeSynthesisCoverage } from "../lib/synthesis/coverage-probe.js";
import { detectDrift } from "../lib/synthesis/drift-detector.js";
import {
  canonicalizeDriftEnvelope,
  computeCoverageFromState,
  computeDriftFromState,
  updateStateFromLedgers,
} from "../lib/synthesis/health-reducers.js";
import { memoryLedgerPath, recallLedgerPath } from "../lib/config.js";

const redRunArg = process.argv.find((a) => a === "--red-run" || a.startsWith("--red-run="));
const RED_RUN = redRunArg ? (redRunArg.includes("=") ? redRunArg.split("=")[1] : "coverage") : null;
if (RED_RUN !== null && RED_RUN !== "coverage" && RED_RUN !== "drift") {
  console.error(`unknown --red-run target "${RED_RUN}" (coverage | drift)`);
  process.exit(2);
}

const COPY_CHUNK_BYTES = 8 * 1024 * 1024;

/** Stream-copy exactly bytes [0, eof) of src into dst. Positioned reads —
 *  the source is opened read-only and never modified. */
function copyPrefix(srcPath, eof, dstPath) {
  const buf = Buffer.alloc(Math.min(COPY_CHUNK_BYTES, Math.max(eof, 1)));
  const src = openSync(srcPath, "r");
  try {
    const dst = openSync(dstPath, "w", 0o600);
    try {
      let pos = 0;
      while (pos < eof) {
        const want = Math.min(buf.length, eof - pos);
        const n = readSync(src, buf, 0, want, pos);
        if (n === 0) {
          throw new Error(`short read at byte ${pos} of ${srcPath} (file shrank mid-copy)`);
        }
        let written = 0;
        while (written < n) written += writeSync(dst, buf, written, n - written);
        pos += n;
      }
    } finally {
      closeSync(dst);
    }
  } finally {
    closeSync(src);
  }
}

function stripBuiltAt(envelope) {
  const copy = structuredClone(envelope);
  delete copy.built_at;
  return copy;
}

const ms = (t) => `${(performance.now() - t).toFixed(0)}ms`;

const livePaths = { memory: memoryLedgerPath(), recall: recallLedgerPath() };
const tmpRoot = mkdtempSync(join(tmpdir(), "health-equivalence-"));
process.on("exit", () => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort temp cleanup */
  }
});

let failures = 0;
try {
  // ---- pin + materialize the prefix ---------------------------------------
  const copyPaths = {};
  for (const role of ["memory", "recall"]) {
    const live = livePaths[role];
    const copy = join(tmpRoot, basename(live));
    copyPaths[role] = copy;
    const cp = captureCheckpoint(live);
    if (cp === null) {
      // Missing live ledger: both implementations treat a missing path as
      // zero rows — leave the copy path nonexistent so they agree.
      console.log(`${role}: ${live} missing/unreadable — comparing missing-file behavior`);
      continue;
    }
    const t = performance.now();
    copyPrefix(live, cp.eof, copy);
    const pv = verifyPrefix(live, cp);
    if (!pv.ok) {
      console.error(
        `SETUP FAILURE: ${live} was REWRITTEN (not appended) mid-copy ` +
          `(verifyPrefix: ${pv.reason}); rerun the gate`,
      );
      process.exit(2);
    }
    console.log(
      `${role}: pinned eof=${cp.eof} of size=${cp.size} (${statSync(copy).size} bytes copied, ${ms(t)})`,
    );
  }

  const now = Date.now(); // one pinned clock for all four computations
  const opts = { ledgerPath: copyPaths.memory, recallLogPath: copyPaths.recall, now };

  // ---- original full scans -------------------------------------------------
  let t = performance.now();
  const originalCoverage = await computeSynthesisCoverage(opts);
  console.log(`original computeSynthesisCoverage: ${ms(t)}`);
  t = performance.now();
  const originalDrift = await detectDrift(opts);
  console.log(`original detectDrift:              ${ms(t)}`);

  // ---- reducer-backed compute (rebuild from the origin cursor) -------------
  t = performance.now();
  const { state, stats } = updateStateFromLedgers(null, {
    ledgerPath: copyPaths.memory,
    recallLogPath: copyPaths.recall,
  });
  console.log(
    `reducer rebuild:                   ${ms(t)} ` +
      `(memory ${stats.memory.linesApplied} lines, recall ${stats.recall.linesApplied} lines)`,
  );
  t = performance.now();
  const reducerCoverage = computeCoverageFromState(state, opts);
  const reducerDrift = computeDriftFromState(state, opts);
  console.log(`reducer compute (both envelopes):  ${ms(t)}`);

  if (RED_RUN === "coverage") {
    reducerCoverage.facts_in_window += 1;
    console.log("RED-RUN: injected facts_in_window+1 into the reducer coverage envelope — this run MUST fail");
  } else if (RED_RUN === "drift") {
    reducerDrift.current_facts += 1;
    console.log("RED-RUN: injected current_facts+1 into the reducer drift envelope — this run MUST fail");
  }

  // ---- structural deep-compare (excluding built_at) -------------------------
  try {
    deepStrictEqual(stripBuiltAt(reducerCoverage), stripBuiltAt(originalCoverage));
    console.log(`PASS  synthesis_coverage equivalent (facts_in_window=${originalCoverage.facts_in_window})`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL  synthesis_coverage diverged:\n${e.message}`);
  }
  try {
    deepStrictEqual(
      stripBuiltAt(canonicalizeDriftEnvelope(reducerDrift)),
      stripBuiltAt(canonicalizeDriftEnvelope(originalDrift)),
    );
    console.log(
      `PASS  drift_alerts equivalent (alerts=${originalDrift.alerts.length}, ` +
        `baseline_facts=${originalDrift.baseline_facts}, current_facts=${originalDrift.current_facts})`,
    );
  } catch (e) {
    failures += 1;
    console.error(`FAIL  drift_alerts diverged:\n${e.message}`);
  }
} catch (e) {
  console.error(`SETUP FAILURE: ${e && e.stack ? e.stack : e}`);
  process.exit(2);
}

if (failures > 0) {
  console.error(`\n${failures} divergence(s) — reducer output is NOT equivalent to the full scan`);
  process.exit(1);
}
console.log("\nEquivalence gate PASSED: reducer-backed health projections match the full-scan originals.");
