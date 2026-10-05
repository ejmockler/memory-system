#!/usr/bin/env node
// compact-duplicate-facts.mjs — WU2-retroactive-dedup-compaction (Part A).
//
// AUTHORITATIVE problem statement (Thesis #1: the ledger is PERMANENT):
//   <MEMORY_ROOT>/ledgers/memory.jsonl carries ~1.33M duplicate
//   noise facts (1.78 GB) that the capture-everything-filter-nothing cascade
//   wrote while the Gemini key pool was cooled (see content-index.js header).
//   WU1 stops NEW duplicates at promote time. THIS script collapses the
//   EXISTING duplicates already on disk.
//
//   We DO NOT delete rows (the ledger is an append-only, permanent learning
//   substrate — kb/architecture.md §5). Instead, for each content-hash
//   cluster of size >= 2 we keep the EARLIEST fact as canonical and emit ONE
//   policy.corroboration event per duplicate, appended to the SAME canonical
//   ledger. The recall hard-gates projection (_scanLedger →
//   corroborationByTarget) then folds each duplicate's source_ref onto the
//   canonical fact, and the recall-time content-dedup pass + the embed-queue
//   prune (Part B) can treat the duplicates as already-represented.
//
// SHAPE (load-bearing — MUST match the recall reader in
// mcp/lib/recall/hard-gates.js _scanLedger, NOT the salience.js sidecar emit):
//   The recall reader reads memory.jsonl rows shaped:
//     { kind:"policy", policy_kind:"corroboration",
//       targets:[target_memory_id], payload:{ source_ref:{...} } }
//   and pushes { corroboration_event_id, source_ref } onto
//   corroborationByTarget.get(target_memory_id). We therefore emit:
//     {
//       id: "mem_<rand>",
//       kind: "policy",
//       policy_kind: "corroboration",
//       targets: [canonical_id],
//       payload: { source_ref: {
//         source: <duplicate's source>,
//         target_memory_id: <duplicate_id>,   // the corroborating fact
//         via: "retroactive_content_dedup",
//         consent_basis: <duplicate's consent_basis | null>,
//       } },
//       // WU2 identifying fields the operator/finalizer reads directly:
//       target_id: canonical_id,
//       corroborating_id: duplicate_id,
//       cosine_distance: null,        // content-hash dedup has no embedding
//       reason: "retroactive_content_dedup",
//       emitter_module: "compact-duplicate-facts",
//       emitter_version: COMPACT_DUPLICATE_FACTS_VERSION,
//       ts: <ISO>,
//     }
//
//   SINGLE-PRODUCER NOTE: policy.corroboration is ALREADY produced by the
//   cascade (salience.js emitCorroboration → policy-events SIDECAR) and the
//   in-flight content-dedup gate. This script is a one-shot OPERATOR tool that
//   appends RETROACTIVE corroborations to the CANONICAL ledger (memory.jsonl)
//   with a DISTINCT reason ("retroactive_content_dedup") that never collides
//   with the cascade's reasons ("content_duplicate_no_embed" /
//   "salience_corroborate"). It does NOT run in the cascade hot path and does
//   not violate single-producer-per-policy-kind: the recall reader keys only
//   on policy_kind="corroboration" + targets + payload.source_ref, all of
//   which we satisfy. Re-using the existing policy_kind (rather than a new
//   "corroboration.retroactive") is the cleaner choice — it requires ZERO
//   reader change and the projection semantics are identical.
//
// IDEMPOTENCY: re-running --apply skips any duplicate_id already corroborated
//   by a prior retroactive run. The seen-set is built by streaming the ledger
//   ONCE and collecting every corroborating_id from rows whose
//   reason === "retroactive_content_dedup".
//
// DISCIPLINE:
//   - ESM, defensive try/catch around the cluster build + emit loop.
//   - NEVER readFileSync the 1.78 GB ledger — stream via _ledger-stream.js.
//   - Reuse content-index.js normalizeContent / contentHash (parity with WU1).
//   - Empty-content / null-hash facts are NEVER collapsed.
//   - --dry-run is the DEFAULT (report only). --apply writes events
//     (batched, fsync'd via the same durability discipline distill-promote-fact
//     and watermark.js use for canonical-ledger appends).
//
// CLI:
//   node mcp/scripts/compact-duplicate-facts.mjs               # dry-run
//   node mcp/scripts/compact-duplicate-facts.mjs --dry-run
//   node mcp/scripts/compact-duplicate-facts.mjs --apply
//   node mcp/scripts/compact-duplicate-facts.mjs --ledger <path> [--quiet]

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  openSync,
  statSync,
  writeSync,
} from "node:fs";
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { dirname } from "node:path";

import { memoryLedgerPath } from "../lib/config.js";
import { serverTs } from "../lib/envelope.js";
import { streamLedgerLines } from "../lib/synthesis/_ledger-stream.js";
import { contentHash } from "../lib/synthesis/content-index.js";

// ---------------------------------------------------------------------------
// Module identity (WU discipline: export VERSION + frozen CAPS).
// ---------------------------------------------------------------------------

/** Bump on any behavioural change to the corroboration emit contract. */
export const COMPACT_DUPLICATE_FACTS_VERSION = "v1";

export const COMPACT_DUPLICATE_FACTS_CAPS = Object.freeze({
  // The distinct reason that marks a retroactive (vs cascade) corroboration.
  // Idempotency keys on this string.
  REASON: "retroactive_content_dedup",
  // Append batch size: flush every N events with a single fsync to bound the
  // syscall count on the ~1.33M-event worst case.
  EMIT_BATCH_SIZE: 1000,
  // Module name stamped on every emitted event.
  EMITTER_MODULE: "compact-duplicate-facts",
});

// ---------------------------------------------------------------------------
// Canonical-ledger append discipline (mirrors distill-promote-fact.js
// appendFactRow + watermark.js: O_APPEND|O_CREAT|O_WRONLY|O_NOFOLLOW, single
// writeSync loop per line, fsyncSync(fd), then fsyncDir).
// ---------------------------------------------------------------------------

const LEDGER_O_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_NOFOLLOW;
const LEDGER_FILE_MODE = 0o600;

function fsyncDir(dirPath) {
  let dirFd = -1;
  try {
    dirFd = openSync(dirPath, fsConstants.O_RDONLY);
    fsyncSync(dirFd);
  } catch (err) {
    // EISDIR / EINVAL on platforms that refuse dir fsync — best-effort.
    if (err && err.code !== "EISDIR" && err.code !== "EINVAL") {
      // Non-fatal: the file's bytes are already fsync'd by the caller.
    }
  } finally {
    if (dirFd !== -1) {
      try {
        closeSync(dirFd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Append a batch of event objects to the ledger as one JSONL block, then
 * fsync the fd + the directory. A single openSync/closeSync per batch bounds
 * the syscall cost. Throws on write failure (the operator wants a loud halt,
 * not a silent partial compaction).
 *
 * @param {string} ledgerPath
 * @param {object[]} events
 */
function appendEventBatch(ledgerPath, events) {
  if (events.length === 0) return;
  let body = "";
  for (const ev of events) body += JSON.stringify(ev) + "\n";
  const bytes = Buffer.from(body, "utf8");
  const fd = openSync(ledgerPath, LEDGER_O_FLAGS, LEDGER_FILE_MODE);
  try {
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDir(dirname(ledgerPath));
}

// ---------------------------------------------------------------------------
// Build the corroboration event for a single (canonical, duplicate) pair.
// ---------------------------------------------------------------------------

function newEventId() {
  return "mem_" + cryptoRandomBytes(8).toString("hex");
}

/**
 * @param {string} canonicalId
 * @param {{id:string, source:string|null, consent_basis:string|null}} dup
 * @param {string} ts
 * @returns {object} a memory.jsonl-shaped policy.corroboration row.
 */
export function buildRetroactiveCorroboration(canonicalId, dup, ts) {
  return {
    id: newEventId(),
    kind: "policy",
    policy_kind: "corroboration",
    // Load-bearing for the recall reader (hard-gates _scanLedger):
    targets: [canonicalId],
    payload: {
      source_ref: {
        source: dup.source || null,
        target_memory_id: dup.id,
        via: COMPACT_DUPLICATE_FACTS_CAPS.REASON,
        consent_basis: dup.consent_basis || null,
      },
    },
    // WU2 identifying fields (operator / finalizer / idempotency read these):
    target_id: canonicalId,
    corroborating_id: dup.id,
    cosine_distance: null,
    reason: COMPACT_DUPLICATE_FACTS_CAPS.REASON,
    emitter_module: COMPACT_DUPLICATE_FACTS_CAPS.EMITTER_MODULE,
    emitter_version: COMPACT_DUPLICATE_FACTS_VERSION,
    ts,
  };
}

// ---------------------------------------------------------------------------
// Pass 1: stream the ledger, building
//   - byContentHash: Map<hash, { canonicalId, dups: [{id,source,consent_basis}] }>
//   - alreadyCorroborated: Set<duplicate_id> (idempotency seen-set)
//
// We stream ONCE. The seen-set is collected from prior retroactive
// corroboration rows in the SAME stream so a re-run with --apply emits 0 new
// events. fact-row "source" is row.source (matches the row schema); the
// consent_basis is read best-effort from source_refs[0].
// ---------------------------------------------------------------------------

function firstSourceRefConsentBasis(row) {
  if (!Array.isArray(row.source_refs)) return null;
  const ref = row.source_refs[0];
  if (ref == null || typeof ref !== "object") return null;
  return typeof ref.consent_basis === "string" ? ref.consent_basis : null;
}

/**
 * @param {string} ledgerPath
 * @returns {{
 *   byContentHash: Map<string, {canonicalId:string, dups:object[]}>,
 *   alreadyCorroborated: Set<string>,
 *   factRows: number,
 *   ledgerBytes: number,
 * }}
 */
export function scanLedgerForClusters(ledgerPath) {
  const byContentHash = new Map();
  const alreadyCorroborated = new Set();
  let factRows = 0;

  streamLedgerLines(ledgerPath, (row) => {
    try {
      if (row == null || typeof row !== "object") return;

      // Collect the idempotency seen-set from prior retroactive corroborations.
      if (
        row.kind === "policy" &&
        row.policy_kind === "corroboration" &&
        row.reason === COMPACT_DUPLICATE_FACTS_CAPS.REASON &&
        typeof row.corroborating_id === "string" &&
        row.corroborating_id.length > 0
      ) {
        alreadyCorroborated.add(row.corroborating_id);
        return;
      }

      // Only fact rows are capture candidates. Tolerate absent-kind legacy
      // rows that carry a content string (matches content-index.js applyRow).
      if (typeof row.kind === "string" && row.kind !== "fact") return;
      const factId = row.id;
      if (typeof factId !== "string" || factId.length === 0) return;
      const content = typeof row.content === "string" ? row.content : "";
      const hash = contentHash(content);
      if (hash === null) return; // empty content -> NEVER collapse.

      factRows += 1;
      const existing = byContentHash.get(hash);
      if (existing == null) {
        // EARLIEST wins: first fact seen for this hash is canonical.
        byContentHash.set(hash, { canonicalId: factId, dups: [] });
      } else {
        // A later row with the same content hash -> a duplicate.
        existing.dups.push({
          id: factId,
          source: typeof row.source === "string" ? row.source : null,
          consent_basis: firstSourceRefConsentBasis(row),
        });
      }
    } catch {
      // Defensive: a single malformed row never aborts the scan.
    }
  });

  let ledgerBytes = 0;
  try {
    ledgerBytes = statSync(ledgerPath).size;
  } catch {
    ledgerBytes = 0;
  }

  return { byContentHash, alreadyCorroborated, factRows, ledgerBytes };
}

// ---------------------------------------------------------------------------
// Driver: compute the report; optionally emit events.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} [opts.ledgerPath]
 * @param {boolean} [opts.apply]    — default false (dry-run).
 * @param {boolean} [opts.quiet]
 * @param {string}  [opts.now]      — ISO ts injection for tests.
 * @returns {{
 *   clusters: number,
 *   total_duplicates: number,
 *   canonical_count: number,
 *   corroboration_events_to_emit: number,
 *   corroboration_events_emitted: number,
 *   already_corroborated_skipped: number,
 *   bytes: number,
 *   applied: boolean,
 * }}
 */
export function runCompaction(opts = {}) {
  const ledgerPath =
    typeof opts.ledgerPath === "string" && opts.ledgerPath.length > 0
      ? opts.ledgerPath
      : memoryLedgerPath();
  const apply = opts.apply === true;
  const quiet = opts.quiet === true;
  const log = quiet ? () => {} : (m) => console.log(m);
  const ts = typeof opts.now === "string" && opts.now.length > 0 ? opts.now : serverTs();

  log(`compact-duplicate-facts: ledger=${ledgerPath} apply=${apply}`);
  if (!existsSync(ledgerPath)) {
    log("compact-duplicate-facts: ledger absent — nothing to do");
    return {
      clusters: 0,
      total_duplicates: 0,
      canonical_count: 0,
      corroboration_events_to_emit: 0,
      corroboration_events_emitted: 0,
      already_corroborated_skipped: 0,
      bytes: 0,
      applied: apply,
    };
  }

  const { byContentHash, alreadyCorroborated, ledgerBytes } =
    scanLedgerForClusters(ledgerPath);

  // Compute the report + the list of (canonicalId, dup) pairs to emit.
  let clusters = 0;
  let totalDuplicates = 0;
  let toEmit = 0;
  let skipped = 0;
  // Materialize the emit plan lazily into batches to bound memory: we hold
  // the cluster map already (bounded by distinct-content cardinality), so a
  // flat pair list of size total_duplicates is the same order of magnitude —
  // acceptable. The emit loop flushes in EMIT_BATCH_SIZE chunks.
  const canonicalCount = byContentHash.size;

  const pending = [];
  for (const { canonicalId, dups } of byContentHash.values()) {
    if (dups.length === 0) continue; // singleton cluster -> nothing to collapse.
    clusters += 1;
    totalDuplicates += dups.length;
    for (const dup of dups) {
      if (alreadyCorroborated.has(dup.id)) {
        skipped += 1;
        continue;
      }
      toEmit += 1;
      if (apply) pending.push(buildRetroactiveCorroboration(canonicalId, dup, ts));
    }
  }

  log(
    `compact-duplicate-facts: clusters=${clusters} total_duplicates=${totalDuplicates} ` +
      `canonical_count=${canonicalCount} corroboration_events_to_emit=${toEmit} ` +
      `already_corroborated_skipped=${skipped} bytes=${ledgerBytes}`,
  );

  let emitted = 0;
  if (apply && pending.length > 0) {
    const batchSize = COMPACT_DUPLICATE_FACTS_CAPS.EMIT_BATCH_SIZE;
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      appendEventBatch(ledgerPath, batch);
      emitted += batch.length;
    }
    log(`compact-duplicate-facts: emitted ${emitted} corroboration event(s)`);
  } else if (!apply) {
    log("compact-duplicate-facts: dry-run; no events appended");
  }

  return {
    clusters,
    total_duplicates: totalDuplicates,
    canonical_count: canonicalCount,
    corroboration_events_to_emit: toEmit,
    corroboration_events_emitted: emitted,
    already_corroborated_skipped: skipped,
    bytes: ledgerBytes,
    applied: apply,
  };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------
const isDirect =
  process.argv[1] && process.argv[1].endsWith("compact-duplicate-facts.mjs");
if (isDirect) {
  const args = process.argv.slice(2);
  let apply = false;
  let quiet = false;
  let ledgerPath = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--apply") apply = true;
    else if (a === "--dry-run") apply = false;
    else if (a === "--quiet") quiet = true;
    else if (a === "--ledger") {
      ledgerPath = args[i + 1];
      i += 1;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: compact-duplicate-facts.mjs [--dry-run|--apply] [--ledger <path>] [--quiet]",
      );
      process.exit(0);
    } else {
      console.error(`compact-duplicate-facts: unknown arg ${a}`);
      process.exit(1);
    }
  }
  try {
    const res = runCompaction({ apply, quiet, ledgerPath });
    if (!quiet) {
      console.log(
        `compact-duplicate-facts: DONE applied=${res.applied} ` +
          `events_emitted=${res.corroboration_events_emitted} ` +
          `events_to_emit=${res.corroboration_events_to_emit} ` +
          `clusters=${res.clusters} duplicates=${res.total_duplicates}`,
      );
    }
    process.exit(0);
  } catch (e) {
    console.error(`compact-duplicate-facts: FAILED ${e && e.message ? e.message : e}`);
    process.exit(2);
  }
}
