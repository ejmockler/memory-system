#!/usr/bin/env node
// verify-embed-population-census.mjs — e1 (embed-population hypergraph).
//
// WHY THIS EXISTS
// ---------------
// "How many memories are embedded?" has been answered in this tree from a
// SWEEP QUEUE, a cursor, a bytes_behind figure and a cache key — none of
// which is a population. A queue is a work list whose scope is set by
// whoever appended to it; a cursor is a position; neither can tell you how
// many ledger rows carry a vector, and neither can tell you how many rows
// are UNMEASURABLE. This gate answers the question by RESOLUTION instead:
// a full bounded stream over a PINNED prefix of the ledger, cross-cut by
// three independent instruments, partitioned into a closed named enum.
//
// WHAT IT DOES NOT DO
// -------------------
// It owns NO threshold and NO counter. Every count belongs to
// `mcp/lib/recall/embed-population-census.js`; this file parses arguments,
// resolves defaults through lib/config.js + lib/validation.js, and turns a
// refusal into an exit code — the verify-lexical-coverage-gate.mjs /
// bm25-coverage-probe.js split, copied deliberately. There is no
// `if (count < n)` here, and no path where this file computes a ratio.
//
// It also starts NO embedding work. It enqueues nothing, signals no daemon,
// and proposes no campaign.
//
// READ-ONLY, STATED HONESTLY
// --------------------------
// This FILE performs no mutation: no member of the write family (write /
// append / mkdir / rename / rm / unlink / truncate / createWriteStream /
// openSync with a write flag) appears in it, and its only output is one line
// on stdout plus usage and diagnostics on stderr. The stronger claim that
// nothing it imports TRANSITIVELY contains a mutator would be FALSE and is
// not made: `daemons/reembed-drain.mjs` (reached via the census module, for
// the single definition of the `${id}#${k}` chunk rule) contains lock-file
// creation, cursor writes and log appends. What is true, and was verified by
// reading that file on 2026-08-18, is that the census imports only
// `stripChunkSuffix` and `sidecarLineId` — two pure string/Buffer functions —
// and that the drain's CLI is behind an INVOKED_DIRECTLY guard, so importing
// it fires no drain and no mutator is reachable on this runtime path.
// `mcp/lib/synthesis/ledger-checkpoint.js` is pure-read by its own contract.
// Nothing reaches queryd, the embed server, or hnsw-index.js's loader (which
// would read the 2.1 GB hnsw.bin). The observable proof is stronger than any
// reading: size, mtime, dev and ino of ledgers/, indices/<model>/, storage/
// and policy/ are unchanged across a live run.
//
// ABSENCE IS NEVER A VERDICT
// --------------------------
// There is no path to exit 0 that did not complete a measurement of all
// THREE bucket-bearing instruments over a pinned prefix. An unreadable
// ledger, hnsw meta or sidecar, a bad argument, `--help`, or any unexpected
// exception exits 2 with `verdict:"refuse"` and NO census in the payload.
// `--help` deliberately exits 2 for exactly this reason.
//
// USAGE
//   node mcp/scripts/verify-embed-population-census.mjs
//     [--model-version=ID] [--ledger=PATH] [--sidecar=PATH] [--hnsw-meta=PATH]
//     [--legacy-sidecar=PATH] [--sweep=PATH] [--pin=PATH] [--verify-digest]
//
//   --model-version=ID     default: ACTIVE_EMBED_MODEL_VERSION (lib/validation.js).
//                          The hnsw meta MUST be stamped with it or the run refuses.
//   --ledger=PATH          default: memoryLedgerPath() (lib/config.js)
//   --sidecar=PATH         default: <MEMORY_ROOT>/indices/<model>/vectors.jsonl
//   --hnsw-meta=PATH       default: <MEMORY_ROOT>/indices/<model>/hnsw.bin.meta.json
//   --legacy-sidecar=PATH  default: <MEMORY_ROOT>/indices/<model>/embeddings-sidecar.jsonl.
//                          At the DEFAULT path an absent file is reported as
//                          unmeasured (it is not bucket-bearing, so it moves no
//                          count); passed EXPLICITLY, an unreadable file refuses.
//   --sweep=PATH           default: <POLICY_DIR>/re-embed-sweep.jsonl. QUEUE
//                          figures ONLY — labelled as such, never a population.
//   --pin=PATH             a pin-ledger-snapshot.mjs payload (latest.json or a
//                          content-addressed pin) whose checkpoint pins the
//                          prefix. Default: capture a fresh checkpoint here.
//   --verify-digest        also sha256 the whole prefix after the counting pass
//                          (ONE EXTRA full read of a 3.4 GB file). The payload
//                          names which method was used either way.
//   --help                 this text (exit 2 — exit 0 means "measured").
//
// Every default resolves through lib/config.js and lib/validation.js rather
// than a hard-coded absolute path, so the gate retargets entirely by env
// (MEMORY_ROOT / LEDGERS_BASE_DIR / POLICY_BASE_DIR) — which is what lets the
// hermetic arms in mcp/test/auto-drain.test.mjs drive it without ever naming a
// production path.
//
// EXIT CODES
//   0  permit — a completed census over a pinned prefix, all three
//               bucket-bearing instruments measured, buckets partitioning.
//   3  refuse — the census ran but an INSTRUMENT INVARIANT broke: hnsw model
//               mismatch, unsupported meta format, id_map/nextId disagreement,
//               a broken readAppended accounting identity, a non-boolean
//               embed_state, or non-partitioning buckets.
//   2  refuse — nothing measurable: bad arguments, --help, an unreadable
//               ledger / hnsw meta / sidecar / pin, a DRIFTED pinned prefix
//               (census_prefix_drifted — the bytes under the pin are not the
//               bytes that were pinned, so no delta over them means anything;
//               that code is deliberately NOT an instrument-invariant code and
//               so lands here, not at 3), or any other failure.
//
// Output: exactly ONE line of JSON on stdout in EVERY case, including refusals,
// so a refusal is as auditable as a permit.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MEMORY_ROOT, POLICY_DIR, memoryLedgerPath } from "../lib/config.js";
import { ACTIVE_EMBED_MODEL_VERSION } from "../lib/validation.js";
import { deserializeCheckpoint } from "../lib/synthesis/ledger-checkpoint.js";
import {
  EMBED_POPULATION_BUCKETS,
  EmbedPopulationCensusError,
  INSTRUMENT_INVARIANT_CODES,
  POPULATION_UNIT,
  UNMEASURABLE_BUCKET,
  censusEmbedPopulation,
} from "../lib/recall/embed-population-census.js";

const USAGE = [
  "verify-embed-population-census.mjs — census the embed population over a pinned ledger prefix.",
  "",
  "  --model-version=ID     default: ACTIVE_EMBED_MODEL_VERSION",
  "  --ledger=PATH          default: memoryLedgerPath()",
  "  --sidecar=PATH         default: <MEMORY_ROOT>/indices/<model>/vectors.jsonl",
  "  --hnsw-meta=PATH       default: <MEMORY_ROOT>/indices/<model>/hnsw.bin.meta.json",
  "  --legacy-sidecar=PATH  default: <MEMORY_ROOT>/indices/<model>/embeddings-sidecar.jsonl",
  "  --sweep=PATH           default: <POLICY_DIR>/re-embed-sweep.jsonl (QUEUE figures only)",
  "  --pin=PATH             a pin-ledger-snapshot payload to pin the prefix with",
  "  --verify-digest        sha256 the whole prefix (one EXTRA full read)",
  "  --help                 this text (exit 2 — exit 0 means 'measured')",
  "",
  "Exit: 0 permit | 3 refuse (instrument invariant broke) | 2 refuse (nothing measured).",
].join("\n");

/**
 * Arguments are parsed BEFORE any filesystem access, so a bad invocation can
 * never be reported as a measurement. Path defaults are pure string joins over
 * lib/config.js values; resolving them touches no disk.
 */
function parseArgs(argv) {
  let modelVersion = null;
  let ledgerPath = null;
  let sidecarPath = null;
  let hnswMetaPath = null;
  let legacySidecarPath = null;
  let legacySidecarExplicit = false;
  let sweepPath = null;
  let pinPath = null;
  let verifyDigest = false;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { error: { code: "census_help", message: "usage requested" }, usage: true };
    }
    if (arg === "--verify-digest") {
      verifyDigest = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const val = eq === -1 ? null : arg.slice(eq + 1);
    if (val === null || val.length === 0) {
      return {
        error: {
          code: "census_bad_arguments",
          message: `argument ${JSON.stringify(arg)} must be of the form --flag=value`,
        },
        usage: true,
      };
    }
    switch (key) {
      case "--model-version":
        modelVersion = val;
        break;
      case "--ledger":
        ledgerPath = val;
        break;
      case "--sidecar":
        sidecarPath = val;
        break;
      case "--hnsw-meta":
        hnswMetaPath = val;
        break;
      case "--legacy-sidecar":
        legacySidecarPath = val;
        legacySidecarExplicit = true;
        break;
      case "--sweep":
        sweepPath = val;
        break;
      case "--pin":
        pinPath = val;
        break;
      default:
        return {
          error: {
            code: "census_bad_arguments",
            message: `unknown argument ${JSON.stringify(key)}`,
          },
          usage: true,
        };
    }
  }

  const model = modelVersion === null ? ACTIVE_EMBED_MODEL_VERSION : modelVersion;
  const indexDir = join(MEMORY_ROOT, "indices", model);
  return {
    error: null,
    modelVersion: model,
    ledgerPath: ledgerPath === null ? memoryLedgerPath() : ledgerPath,
    sidecarPath: sidecarPath === null ? join(indexDir, "vectors.jsonl") : sidecarPath,
    hnswMetaPath: hnswMetaPath === null ? join(indexDir, "hnsw.bin.meta.json") : hnswMetaPath,
    legacySidecarPath:
      legacySidecarPath === null ? join(indexDir, "embeddings-sidecar.jsonl") : legacySidecarPath,
    legacySidecarOptional: !legacySidecarExplicit,
    sweepPath: sweepPath === null ? join(POLICY_DIR, "re-embed-sweep.jsonl") : sweepPath,
    pinPath,
    verifyDigest,
  };
}

/**
 * Load a pin-ledger-snapshot payload and hand back its checkpoint. A pin that
 * cannot be read or does not carry a valid checkpoint is a REFUSAL, never a
 * silent fall-back to a fresh capture: an operator who named a pin and got a
 * different denominator would be misled.
 */
function loadPin(pinPath) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(pinPath, "utf8"));
  } catch (e) {
    return { checkpoint: null, error: `pin at ${pinPath} is unreadable: ${e && e.message ? e.message : String(e)}` };
  }
  const raw =
    payload !== null && typeof payload === "object" && payload.observation !== null &&
    typeof payload.observation === "object"
      ? payload.observation.checkpoint
      : null;
  const cp = deserializeCheckpoint(raw === undefined || raw === null ? payload && payload.checkpoint : raw);
  if (cp === null) {
    return {
      checkpoint: null,
      error:
        `pin at ${pinPath} carries no valid checkpoint (looked at observation.checkpoint then ` +
        `checkpoint). Refusing to substitute a fresh capture for the pin you named.`,
    };
  }
  return { checkpoint: cp, error: null };
}

/**
 * The envelope every exit path emits. The unit constants are CONTRACT
 * CONSTANTS of the census module, not measurements, so they are stamped even
 * when nothing was measured — a reader of a refusal must not have to guess the
 * scale the numbers would have been on. Measured fields are OMITTED (never
 * nulled) when no census completed, so an un-measured envelope cannot be
 * misread as a measurement of zero.
 */
function baseEnvelope({ verdict, args, errorCode, error }) {
  return {
    verdict,
    measured: false,
    model_version: args === null ? null : args.modelVersion,
    ledger_path: args === null ? null : args.ledgerPath,
    sidecar_path: args === null ? null : args.sidecarPath,
    hnsw_meta_path: args === null ? null : args.hnswMetaPath,
    population_unit: POPULATION_UNIT,
    bucket_enum: [...EMBED_POPULATION_BUCKETS],
    unmeasurable_bucket: UNMEASURABLE_BUCKET,
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
      baseEnvelope({ verdict: "refuse", args: null, errorCode: parsed.error.code, error: parsed.error.message }),
      2,
    );
    return;
  }

  let checkpoint = null;
  if (parsed.pinPath !== null) {
    const pin = loadPin(parsed.pinPath);
    if (pin.error !== null) {
      process.stderr.write(`verify-embed-population-census: ${pin.error}\n`);
      emit(
        baseEnvelope({
          verdict: "refuse",
          args: parsed,
          errorCode: "census_pin_unreadable",
          error: pin.error,
        }),
        2,
      );
      return;
    }
    checkpoint = pin.checkpoint;
  }

  let census;
  try {
    census = await censusEmbedPopulation({
      ledgerPath: parsed.ledgerPath,
      hnswMetaPath: parsed.hnswMetaPath,
      sidecarPath: parsed.sidecarPath,
      legacySidecarPath: parsed.legacySidecarPath,
      legacySidecarOptional: parsed.legacySidecarOptional,
      sweepPath: parsed.sweepPath,
      modelVersion: parsed.modelVersion,
      checkpoint,
      verifyDigest: parsed.verifyDigest,
    });
  } catch (err) {
    const code =
      err instanceof EmbedPopulationCensusError ? err.code : "census_unexpected_error";
    process.stderr.write(
      `verify-embed-population-census: census failed (${code}): ${
        err && err.message ? err.message : String(err)
      }\n`,
    );
    // An instrument invariant that broke is a MEASURED-grade refusal (3) and is
    // reported distinctly from an unmeasurable one (2). Neither is a permit,
    // and neither carries a census payload.
    emit(
      baseEnvelope({ verdict: "refuse", args: parsed, errorCode: code, error: err && err.message ? err.message : String(err) }),
      INSTRUMENT_INVARIANT_CODES.includes(code) ? 3 : 2,
    );
    return;
  }

  emit(
    {
      ...baseEnvelope({ verdict: "permit", args: parsed, errorCode: null, error: null }),
      measured: true,
      pin_path: parsed.pinPath,
      ...census,
    },
    0,
  );
}

await main();
