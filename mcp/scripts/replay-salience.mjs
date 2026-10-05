#!/usr/bin/env node
// replay-salience.mjs — R25 weight-replay / rescore tool.
//
// Authoritative spec source:
//   kb/salience-design.md § "Layer 2 mark-and-rank"
//   kb/ingestion.md § Salience placeholder
//
// Purpose
// -------
// Re-score every memory-ledger fact that already carries `features.salience`
// against the CURRENT CAPS.SALIENCE_WEIGHTS_V1 (or against an operator-
// supplied weights JSON via --weights). Used after an operator tweaks the
// weights vector (R25 ship is frozen; week-1 may shift) so the recall surface
// can pick the new score WITHOUT a re-embed and WITHOUT touching the
// append-only memory.jsonl.
//
// Sidecar-vs-inline decision
// --------------------------
// STORAGE: sidecar file at
//
//   $MEMORY_ROOT/storage/salience-rescore-<weights_hash>.jsonl
//
// keyed by memory_id. One row per fact rescored. This matches the same
// invariant the embedding backfill uses (scripts/backfill-embeddings.mjs
// § "V0 design choice: sidecar embeddings"):
//
//   - memory.jsonl is append-only; in-place mutation would forge prior bytes.
//   - Emitting a `kind=policy.salience.rescore` row into memory.jsonl conflates
//     fact rows with audit rows and forces a new fact-event kind into the
//     event-kind taxonomy (owned by Phase A6, the CAPS owner; this script
//     must not touch validation.js).
//   - The sidecar's <weights_hash> filename naturally segregates concurrent
//     experiments: two operators trying alternate weight vectors do not
//     collide.
//   - The recall surface (Phase A4) reads the sidecar by weights_hash and
//     overlays features.salience.score at IndexEntry construction; absence of
//     the sidecar means "use the score stored on the fact row".
//
// Append-only sidecar
// -------------------
// The sidecar itself is append-only per weights_hash. Re-running the script
// with the same weights produces byte-IDENTICAL output (deterministic sort
// by memory_id, deterministic round-to-12-decimals on the score). The
// existing-rows-skip path makes the second run a no-op.
//
// Byte-idempotency contract
// -------------------------
//   1. Sort facts by memory_id ascending before emitting.
//   2. Round scores to 12 decimals (matches canonicalJson stability).
//   3. Skip any memory_id already present in the sidecar.
//   4. Write the sidecar in two phases: stream to <path>.partial then rename
//      (atomic on POSIX).
// On a clean re-run the second pass produces zero new rows.
//
// CLI
// ---
//   node mcp/scripts/replay-salience.mjs                 # default weights
//   node mcp/scripts/replay-salience.mjs --dry-run       # log only
//   node mcp/scripts/replay-salience.mjs --weights path.json
//   node mcp/scripts/replay-salience.mjs --quiet
//
// Exit codes
//   0   ok (zero or more new rows written)
//   1   bad CLI args / bad weights file
//   2   missing required components on a fact (corruption path)
//
// Hermeticity
// -----------
// All paths flow through lib/config.js. Tests set MEMORY_ROOT and per-dir
// overrides BEFORE dynamic import — production memory.jsonl is READ but never
// mutated. The sidecar lives under storage/, which is env-overridable via
// STORAGE_BASE_DIR.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { STORAGE_DIR, memoryLedgerPath } from "../lib/config.js";
import { CAPS, canonicalJson, canonicalJsonSha256Hex } from "../lib/validation.js";
import { serverTs } from "../lib/envelope.js";
// WU-scripts-stringcap: readLedgerFacts' readFileSync crossed Node's max
// string length once memory.jsonl passed 536,870,888 bytes (it is now
// 3,056,314,513 B = 5.69x the cap).
import { streamLedgerLines } from "../lib/synthesis/_ledger-stream.js";

// ---------------------------------------------------------------------------
// Weight vector defaults. If CAPS.SALIENCE_WEIGHTS_V1 is not yet present
// (Phase A6 has not landed on the operator's branch), fall back to the
// design-doc baseline. This keeps the script callable both pre- and post-A6.
// ---------------------------------------------------------------------------
const DESIGN_DOC_BASELINE_WEIGHTS = Object.freeze({
  recency: 0.15,
  authorship: 0.2,
  content_mass: 0.15,
  source_prior: 0.1,
  structural: 0.15,
  novelty: 0.25,
  last_retrieved_ts: 0.0,
  use_count: 0.0,
});

const COMPONENT_NAMES = Object.freeze([
  "recency",
  "authorship",
  "content_mass",
  "source_prior",
  "structural",
  "novelty",
  "last_retrieved_ts",
  "use_count",
]);

export function defaultWeights() {
  if (CAPS && typeof CAPS === "object" && CAPS.SALIENCE_WEIGHTS_V1) {
    // Defensive shallow copy so we never mutate the frozen CAPS object.
    return { ...CAPS.SALIENCE_WEIGHTS_V1 };
  }
  return { ...DESIGN_DOC_BASELINE_WEIGHTS };
}

// ---------------------------------------------------------------------------
// Sidecar path. The <weights_hash> discriminator means two operators running
// alternate weights against the same memory.jsonl produce non-overlapping
// sidecar files.
// ---------------------------------------------------------------------------
export function rescoreSidecarPath(weightsHash) {
  if (typeof weightsHash !== "string" || weightsHash.length === 0) {
    throw new Error("rescoreSidecarPath: weightsHash must be a non-empty string");
  }
  return join(STORAGE_DIR, `salience-rescore-${weightsHash}.jsonl`);
}

// ---------------------------------------------------------------------------
// Weights validation. Caller passes an object with the 8 component names.
// Missing names default to 0 (matches design: last_retrieved_ts and use_count
// are weight-zero anchors). All values must be finite numbers in [0, 1].
// ---------------------------------------------------------------------------
export function normalizeWeights(input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("normalizeWeights: input must be a plain object");
  }
  const out = {};
  for (const name of COMPONENT_NAMES) {
    const v = input[name];
    if (v === undefined || v === null) {
      out[name] = 0;
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`normalizeWeights: ${name} must be a finite number`);
    }
    if (v < 0 || v > 1) {
      throw new Error(`normalizeWeights: ${name} must be in [0,1]`);
    }
    out[name] = v;
  }
  return out;
}

// 32-hex-char weights hash. Matches the CAPS.SALIENCE_WEIGHTS_V1_HASH
// convention from the integration map (sha256(canonicalJson(weights))[:32]).
export function weightsHashOf(weights) {
  const normalized = normalizeWeights(weights);
  return canonicalJsonSha256Hex(normalized).slice(0, 32);
}

// ---------------------------------------------------------------------------
// Score recomposition. Dot product over the 8 named components. Round to 12
// decimals so two runs of this script on the same input bytes produce
// byte-identical output (the JSON canonicalizer's default float discipline is
// 15 significant digits; 12 decimals is a strict subset and survives the
// round-trip through JSON.parse/JSON.stringify).
// ---------------------------------------------------------------------------
export function rescore(components, weights) {
  if (components == null || typeof components !== "object") {
    throw new Error("rescore: components must be an object");
  }
  const w = normalizeWeights(weights);
  let sum = 0;
  for (const name of COMPONENT_NAMES) {
    const c = components[name];
    if (c === null || c === undefined) {
      // Decay-feedback graft columns may legitimately be null/0 at admit
      // time; treat as 0.
      continue;
    }
    if (typeof c !== "number" || !Number.isFinite(c)) {
      throw new Error(`rescore: component ${name} must be a finite number`);
    }
    sum += c * w[name];
  }
  // Clamp to [0, 1] (defensive — sum of weight-bounded inputs each in [0,1]
  // with weights summing to <= 1 is already in [0,1], but float drift on the
  // last decimals can push us 1e-16 over).
  if (sum < 0) sum = 0;
  if (sum > 1) sum = 1;
  // Round to 12 decimals.
  return Math.round(sum * 1e12) / 1e12;
}

// ---------------------------------------------------------------------------
// Ledger reader. Yields parsed fact rows that carry features.salience.
// Skips empty lines (memory.jsonl-style) and lines without features.salience.
// ---------------------------------------------------------------------------
// WU-scripts-stringcap: streams instead of readFileSync. The filter below is
// byte-for-byte the pre-existing one; only the iteration mechanism changed.
//
// NO ROW CAP, deliberately. The filter already discards 96.3% of the live
// ledger: measured 55,714 retained rows at 11,801 bytes/row = 627 MB heap /
// 862 MB RSS over the full 3 GB ledger. (FINDINGS F7 warned about a 1.5M-row
// retention blowing 4.2 GB in a DIFFERENT file; that hazard does not apply
// here, verified by measurement rather than inherited as caution.) The caller
// at runReplaySalience() sorts and iterates the returned Array, so the shape
// is pinned.
//
// existsSync dropped per B1c3 (_ledger-stream.js:118-127) — it returns false
// for an EACCES/ELOOP/ENOTDIR path, which silently became "no facts" and made
// a rescore run look like a clean no-op over an unreadable ledger.
export function readLedgerFacts(ledgerPath) {
  const out = [];
  const counts = streamLedgerLines(ledgerPath, (row) => {
    if (row == null || typeof row !== "object") return;
    if (row.kind !== "fact") return;
    if (
      row.features == null ||
      typeof row.features !== "object" ||
      row.features.salience == null ||
      typeof row.features.salience !== "object"
    ) {
      return;
    }
    if (typeof row.id !== "string" || row.id.length === 0) return;
    out.push(row);
  });
  if (counts.readError) {
    throw new Error(
      `replay-salience: cannot read ledger ${ledgerPath}: ${counts.readError}`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sidecar reader. Returns the Set of memory_ids already present so we can
// skip them on a deterministic re-run (byte-idempotency invariant).
// ---------------------------------------------------------------------------
export function readSidecarIds(sidecarPath) {
  if (!existsSync(sidecarPath)) return new Set();
  const raw = readFileSync(sidecarPath, "utf8");
  if (raw === "") return new Set();
  const ids = new Set();
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "") continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row.memory_id === "string") {
        ids.add(row.memory_id);
      }
    } catch {
      // Skip malformed sidecar lines on read; the writer is the canonical
      // source so the next clean run will regenerate them.
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Replay driver.
// ---------------------------------------------------------------------------
export function runReplaySalience(opts = {}) {
  const ledgerPath = opts.ledgerPath || memoryLedgerPath();
  const weights = normalizeWeights(opts.weights || defaultWeights());
  const wh = weightsHashOf(weights);
  const sidecarPath = opts.sidecarPath || rescoreSidecarPath(wh);
  const dryRun = opts.dryRun === true;
  const quiet = opts.quiet === true;
  const log = quiet ? () => {} : (m) => console.log(m);

  log(`replay-salience: ledger=${ledgerPath}`);
  log(`replay-salience: weights_hash=${wh}`);
  log(`replay-salience: sidecar=${sidecarPath} dry_run=${dryRun}`);

  const facts = readLedgerFacts(ledgerPath);
  log(`replay-salience: ${facts.length} fact row(s) carry features.salience`);

  const existing = readSidecarIds(sidecarPath);
  let changedByMoreThan = 0;
  const movedThreshold = 0.05;
  const newRows = [];

  // Deterministic order so byte-idempotency holds.
  facts.sort((a, b) => a.id.localeCompare(b.id));

  for (const fact of facts) {
    if (existing.has(fact.id)) continue;
    const sal = fact.features.salience;
    const oldScore = typeof sal.score === "number" ? sal.score : null;
    let newScore;
    try {
      newScore = rescore(sal.components || {}, weights);
    } catch (e) {
      // Corruption — surface for the operator. Exit non-zero at end if any.
      console.error(
        `replay-salience: fact ${fact.id} has corrupt components: ${e.message}`,
      );
      newRows.push({
        memory_id: fact.id,
        error: "corrupt_components",
        message: e.message,
        ts: serverTs(),
      });
      continue;
    }
    if (
      oldScore !== null &&
      Math.abs(newScore - oldScore) > movedThreshold
    ) {
      changedByMoreThan += 1;
    }
    newRows.push({
      memory_id: fact.id,
      old_score: oldScore,
      new_score: newScore,
      weights_hash: wh,
      version: "v1",
      ts: serverTs(),
    });
  }

  const pct = facts.length === 0 ? 0 : (changedByMoreThan / facts.length) * 100;
  log(
    `replay-salience: rescored ${newRows.length} facts; ` +
      `${changedByMoreThan} (${pct.toFixed(1)}%) changed score by >${movedThreshold}`,
  );

  if (dryRun) {
    log("replay-salience: dry-run; no sidecar write");
    return { wrote: 0, scanned: facts.length, changed_by_more: changedByMoreThan, weights_hash: wh };
  }

  if (newRows.length === 0) {
    log("replay-salience: nothing new to write (idempotent re-run)");
    return { wrote: 0, scanned: facts.length, changed_by_more: changedByMoreThan, weights_hash: wh };
  }

  mkdirSync(dirname(sidecarPath), { recursive: true });
  // Atomic write: stream to .partial, rename. Re-derives the existing rows so
  // the sidecar grows append-only without a partial-write window.
  const partial = `${sidecarPath}.partial`;
  // Re-include the existing sidecar content if any, then the new rows. We use
  // canonicalJson to keep key ordering stable across re-runs.
  let body = "";
  if (existsSync(sidecarPath)) {
    body = readFileSync(sidecarPath, "utf8");
    if (body !== "" && !body.endsWith("\n")) body += "\n";
  }
  for (const row of newRows) {
    body += canonicalJson(row) + "\n";
  }
  writeFileSync(partial, body, { mode: 0o600 });
  renameSync(partial, sidecarPath);

  log(`replay-salience: wrote ${newRows.length} row(s) to ${sidecarPath}`);
  return { wrote: newRows.length, scanned: facts.length, changed_by_more: changedByMoreThan, weights_hash: wh };
}

// ---------------------------------------------------------------------------
// CLI entry point — only when invoked directly (not when imported by tests).
// ---------------------------------------------------------------------------
const isDirect = process.argv[1] && process.argv[1].endsWith("replay-salience.mjs");
if (isDirect) {
  const args = process.argv.slice(2);
  let dryRun = false;
  let quiet = false;
  let weightsPath = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--quiet") quiet = true;
    else if (a === "--weights") {
      weightsPath = args[i + 1];
      i += 1;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: replay-salience.mjs [--dry-run] [--quiet] [--weights path.json]",
      );
      process.exit(0);
    } else {
      console.error(`replay-salience: unknown arg ${a}`);
      process.exit(1);
    }
  }
  let weights;
  if (weightsPath) {
    try {
      weights = JSON.parse(readFileSync(weightsPath, "utf8"));
    } catch (e) {
      console.error(`replay-salience: failed to read weights ${weightsPath}: ${e.message}`);
      process.exit(1);
    }
  } else {
    weights = defaultWeights();
  }
  try {
    const res = runReplaySalience({ weights, dryRun, quiet });
    if (!quiet) {
      console.log(
        `replay-salience: DONE wrote=${res.wrote} scanned=${res.scanned} ` +
          `changed_by_more=${res.changed_by_more}`,
      );
    }
    process.exit(0);
  } catch (e) {
    console.error(`replay-salience: FAILED ${e.message}`);
    process.exit(2);
  }
}
