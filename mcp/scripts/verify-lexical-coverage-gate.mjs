#!/usr/bin/env node
// verify-lexical-coverage-gate.mjs — l4 (legacy-purge hypergraph).
//
// WHY THIS EXISTS
// ---------------
// Nothing in the running system notices when a model's lexical index stops
// covering the ledger. `mcp/daemon/queryd.js`'s `assessModelHealth` reads the
// per-model `index-manifest.json` and, on its `if (mread.manifest == null)`
// branch, returns `{ degraded: false, generation: null, reason: null }` — the
// bootstrap/legacy tree is treated as the documented degrade-to-empty
// contract, not as corruption (verified by reading that function on
// 2026-08-15; cited by file and symbol, not by line, because this tree
// drifts). So a deletion that removes a model directory and its manifest
// reports HEALTHY: no operator signal, no degraded flag, no reason string,
// while recall's candidate supply has silently gone to zero. This gate is the
// missing signal, made explicit and executable: it MEASURES coverage and
// turns it into an exit code, so a deletion procedure can be gated on a
// number instead of on the absence of an alarm.
//
// WHAT IT DOES NOT DO
// -------------------
// It owns no threshold. The comparison is `assertCoverageFloor`'s alone
// (`mcp/lib/recall/bm25-coverage-probe.js`), which is the single sanctioned
// threshold home; this file contains no `if (coverage_pct < floor)` of its
// own. It owns no counter either: `probeBm25Coverage` is the single coverage
// counter. `coverage_pct` arrives from the probe ALREADY quantized to four
// decimal places (`Math.round(rawPct * 1e4) / 1e4` in that module) and is
// passed through here with no further transform — it is not raw, and it is
// never clamped, rounded up, or coerced. It is a PERCENT in [0,100+]. The
// synthesis-side entity-population probe — a different module measuring a
// different thing on recall.jsonl, whose `pct()` returns a FRACTION (0.0214
// meaning 2.14%) — is deliberately NOT imported here; mixing the two scales
// is a documented trap in this repo.
//
// READ-ONLY, STATED HONESTLY
// --------------------------
// This FILE performs no mutation: no filesystem-mutating call of any kind
// appears in it (none of the *Sync write / append / mkdir / rename / remove
// / unlink family, no write stream, nothing that shortens a file), and its
// only output is one line on stdout plus usage and diagnostics on stderr.
// The stronger claim that nothing it imports TRANSITIVELY contains a mutator
// would be FALSE, and is not made: `bm25-coverage-probe.js` imports
// `index-manifest.js` (three atomic-rename sites) and `bm25-rebuild.js`
// (directory creation and atomic rename). What is true, and was verified by
// reading those files on 2026-08-15, is that the probe imports only READ
// symbols from them — `memberStatIdentity`, `readActiveManifest`,
// `sha256File`, `countFactRowsStreamed` (whose body calls only `ledgerSize`
// and `streamLedgerLines`), and `loadBm25IndexFromV2File` — so no mutator is
// reachable on this gate's runtime path. The observable proof is stronger
// than either reading: size, mtime and inode of the probed index directory
// and of storage/ are unchanged across a live run.
//
// ABSENCE IS NEVER A VERDICT
// --------------------------
// There is no path to exit 0 that did not complete a measurement that cleared
// the floor. An index that cannot be read, a ledger that cannot be read, a
// zero denominator, a bad argument, `--help`, or any unexpected exception all
// exit non-zero with `verdict:"refuse"`. `--help` deliberately exits 2 rather
// than 0 for exactly this reason.
//
// USAGE
//   node mcp/scripts/verify-lexical-coverage-gate.mjs \
//     [--model-version=ID] [--min-coverage-pct=N] [--index=PATH] [--ledger=PATH]
//
//   --model-version=ID     default: CAPS.ACTIVE_EMBED_MODEL_VERSION
//                          (mcp/lib/validation.js `ACTIVE_EMBED_MODEL_VERSION`)
//   --min-coverage-pct=N   default: 99. A PERCENT (99 means 99%, not 0.99).
//   --index=PATH           default: <MEMORY_ROOT>/indices/<model-version>/bm25.json
//   --ledger=PATH          default: memoryLedgerPath() (mcp/lib/config.js)
//   --no-verify-digest     skip the manifest sha256 cross-check (a 735 MB hash
//                          costs seconds); index_digest_verified records which.
//   --help                 print this usage on stderr and exit 2.
//
// Every default resolves through lib/config.js and lib/validation.js rather
// than a hard-coded absolute path, so the gate retargets entirely by env
// (MEMORY_ROOT / LEDGERS_BASE_DIR) — which is what makes the hermetic test in
// mcp/test/lexical-coverage-gate.test.mjs able to drive it without ever
// naming a production path.
//
// EXIT CODES
//   0  permit — a completed measurement whose coverage_pct >= min_coverage_pct
//   3  refuse — a completed measurement BELOW the floor
//               (Bm25CoverageProbeError code `bm25_coverage_below_floor`)
//   2  refuse — nothing measured: bad invocation, unreadable index or ledger,
//               empty denominator, non-finite coverage, or any other failure
//
// Output: exactly ONE line of JSON on stdout in every case, so an operator can
// pipe it to jq and an audit trail exists for a refusal as much as a permit.

import { join } from "node:path";

import { MEMORY_ROOT, memoryLedgerPath } from "../lib/config.js";
import {
  Bm25CoverageProbeError,
  DENOMINATOR_UNIT,
  NUMERATOR_UNIT,
  assertCoverageFloor,
  probeBm25Coverage,
} from "../lib/recall/bm25-coverage-probe.js";
import { ACTIVE_EMBED_MODEL_VERSION } from "../lib/validation.js";

const DEFAULT_MIN_COVERAGE_PCT = 99;

const USAGE = [
  "verify-lexical-coverage-gate.mjs — measure a model's BM25 coverage and rule on it.",
  "",
  "  --model-version=ID     default: ACTIVE_EMBED_MODEL_VERSION",
  "  --min-coverage-pct=N   default: 99 (a PERCENT: 99 means 99%, not 0.99)",
  "  --index=PATH           default: <MEMORY_ROOT>/indices/<model-version>/bm25.json",
  "  --ledger=PATH          default: memoryLedgerPath()",
  "  --no-verify-digest     skip the manifest sha256 cross-check",
  "  --help                 this text (exit 2 — exit 0 means 'measured and cleared')",
  "",
  "Exit: 0 permit | 3 refuse (below floor) | 2 refuse (nothing measured).",
].join("\n");

/**
 * Argument parsing happens BEFORE any filesystem access, so a bad invocation
 * can never be reported as a measurement. Path defaults are pure string joins
 * over lib/config.js values; resolving them touches no disk.
 */
function parseArgs(argv) {
  let modelVersion = null;
  let minPctRaw = null;
  let indexPath = null;
  let ledgerPath = null;
  let verifyIndexDigest = true;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { error: { code: "gate_help", message: "usage requested" }, usage: true };
    }
    if (arg === "--no-verify-digest") {
      verifyIndexDigest = false;
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const val = eq === -1 ? null : arg.slice(eq + 1);
    if (val === null || val.length === 0) {
      return {
        error: {
          code: "gate_bad_arguments",
          message: `argument ${JSON.stringify(arg)} must be of the form --flag=value`,
        },
        usage: true,
      };
    }
    switch (key) {
      case "--model-version":
        modelVersion = val;
        break;
      case "--min-coverage-pct":
        minPctRaw = val;
        break;
      case "--index":
        indexPath = val;
        break;
      case "--ledger":
        ledgerPath = val;
        break;
      default:
        return {
          error: {
            code: "gate_bad_arguments",
            message: `unknown argument ${JSON.stringify(key)}`,
          },
          usage: true,
        };
    }
  }

  const resolvedModel =
    modelVersion === null ? ACTIVE_EMBED_MODEL_VERSION : modelVersion;
  const resolvedIndex =
    indexPath === null ? join(MEMORY_ROOT, "indices", resolvedModel, "bm25.json") : indexPath;
  const resolvedLedger = ledgerPath === null ? memoryLedgerPath() : ledgerPath;

  let minPct = DEFAULT_MIN_COVERAGE_PCT;
  if (minPctRaw !== null) {
    // Number() so "abc" -> NaN and "" -> 0 are both caught here rather than
    // silently becoming a floor. No coercion, no fallback to the default: an
    // operator who typed a floor and got a different one would be misled.
    const n = Number(minPctRaw);
    if (!Number.isFinite(n)) {
      return {
        error: {
          code: "gate_bad_arguments",
          message: `--min-coverage-pct must be a finite number of PERCENT, got ${JSON.stringify(minPctRaw)}`,
        },
        modelVersion: resolvedModel,
        indexPath: resolvedIndex,
        ledgerPath: resolvedLedger,
      };
    }
    minPct = n;
  }

  return {
    error: null,
    modelVersion: resolvedModel,
    indexPath: resolvedIndex,
    ledgerPath: resolvedLedger,
    minPct,
    verifyIndexDigest,
  };
}

/**
 * The envelope every exit path emits. `numerator_unit`, `denominator_unit` and
 * `coverage_pct_unit` are CONTRACT CONSTANTS of the probe module, not
 * measurements, so they are stamped even when nothing was measured — a reader
 * of a refusal must not have to guess the scale the number would have been on.
 * The measured fields are OMITTED (not nulled) when no probe completed, so an
 * un-measured envelope cannot be misread as a measurement of zero.
 */
function baseEnvelope({ verdict, modelVersion, indexPath, ledgerPath, minPct, errorCode, error }) {
  return {
    verdict,
    measured: false,
    model_version: modelVersion,
    index_path: indexPath,
    ledger_path: ledgerPath,
    min_coverage_pct: minPct,
    numerator_unit: NUMERATOR_UNIT,
    denominator_unit: DENOMINATOR_UNIT,
    coverage_pct_unit: "percent",
    error_code: errorCode,
    error,
  };
}

function emit(envelope, code) {
  process.stdout.write(JSON.stringify(envelope) + "\n");
  process.exitCode = code;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.error !== null) {
    if (parsed.usage === true) process.stderr.write(USAGE + "\n");
    emit(
      baseEnvelope({
        verdict: "refuse",
        modelVersion: parsed.modelVersion ?? null,
        indexPath: parsed.indexPath ?? null,
        ledgerPath: parsed.ledgerPath ?? null,
        // An unparseable floor stays null. Reporting the default here would
        // claim a floor the operator never asked for.
        minPct: null,
        errorCode: parsed.error.code,
        error: parsed.error.message,
      }),
      2,
    );
    return;
  }

  const { modelVersion, indexPath, ledgerPath, minPct, verifyIndexDigest } = parsed;

  let result;
  try {
    result = probeBm25Coverage({ indexPath, ledgerPath, verifyIndexDigest });
  } catch (err) {
    // Every probe refusal — probe_index_unreadable, probe_ledger_unreadable,
    // probe_ledger_no_eligible_rows, probe_ledger_read_anomaly,
    // probe_coverage_not_finite, probe_bad_arguments — and every unexpected
    // exception lands here. None of them is a permit.
    const code =
      err instanceof Bm25CoverageProbeError ? err.code : "gate_unexpected_error";
    process.stderr.write(
      `verify-lexical-coverage-gate: measurement failed (${code}): ${
        err && err.message ? err.message : String(err)
      }\n`,
    );
    emit(
      baseEnvelope({
        verdict: "refuse",
        modelVersion,
        indexPath,
        ledgerPath,
        minPct,
        errorCode: code,
        error: err && err.message ? err.message : String(err),
      }),
      2,
    );
    return;
  }

  // The measurement completed. Everything below reports it verbatim; the only
  // decision left belongs to assertCoverageFloor.
  const measured = {
    ...baseEnvelope({
      verdict: "permit",
      modelVersion: result.model_version,
      indexPath: result.index_path,
      ledgerPath: result.ledger_path,
      minPct,
      errorCode: null,
      error: null,
    }),
    measured: true,
    indexed_docs: result.indexed_docs,
    eligible_rows: result.eligible_rows,
    coverage_pct: result.coverage_pct,
    indexed_docs_exceeds_eligible_rows: result.indexed_docs_exceeds_eligible_rows,
    units_bound: result.units_bound,
    active_model_version: result.active_model_version,
    is_active_model: result.is_active_model,
    index_size: result.index_size,
    index_integrity: result.index_integrity,
    index_integrity_detail: result.index_integrity_detail,
    index_digest_verified: result.index_digest_verified,
    index_stat_identity: result.index_stat_identity,
    index_moved_during_load: result.index_moved_during_load,
    ledger_size: result.ledger_size,
    ledger_total_lines: result.ledger_total_lines,
    ledger_stat_identity: result.ledger_stat_identity,
    probe_ms: result.probe_ms,
    probed_at: result.probed_at,
  };

  try {
    assertCoverageFloor(result, minPct);
  } catch (err) {
    const code =
      err instanceof Bm25CoverageProbeError ? err.code : "gate_unexpected_error";
    process.stderr.write(
      `verify-lexical-coverage-gate: ${err && err.message ? err.message : String(err)}\n`,
    );
    emit(
      { ...measured, verdict: "refuse", error_code: code, error: err && err.message ? err.message : String(err) },
      // Below the floor is a MEASURED refusal (3) and is reported distinctly
      // from an unmeasurable one (2). Any other throw from the threshold home
      // means the comparison itself did not happen: that is a 2.
      code === "bm25_coverage_below_floor" ? 3 : 2,
    );
    return;
  }

  emit(measured, 0);
}

await main();
