// recall-feedback-emitter.js — Wave 9 SUBSTRATE/INTEGRATION glue for
// F-SYN-INTEGRATION-CP5-TRIGGER-A-ACTIVATION.
//
// PURPOSE
//   This module is the SOLE producer of `kind:"policy"`,
//   `policy_kind:"salience.recall_feedback"` rows in ledgers/memory.jsonl.
//   It is invoked from the recall-time surface (mcp/lib/tools/recall.js)
//   after the brief is returned to the caller; the call is fire-and-forget
//   and MUST NEVER throw out to the caller.
//
//   The zero-weighted `features.salience.components.last_retrieved_ts` and
//   `features.salience.components.use_count` columns ship at R25 (see
//   salience-design.md §R24.5). This emitter writes the per-surfacing audit
//   trail those columns will eventually be folded against — emitting one
//   batched event per recall (not N events for N surfaced memories) so the
//   ledger does not balloon with single-memory rows.
//
// SINGLE-PRODUCER INVARIANT (design contract, enforced by CI)
//   The architect-time review of CP-5 Trigger A flagged that
//   "script-as-producer" for `policy.salience.recall_feedback` collides with
//   the kb's single-source-of-truth invariant. RESOLUTION (Wave 9):
//
//     - This module is the SOLE writer of rows whose top-level fields are
//       `kind:"policy"` AND `policy_kind:"salience.recall_feedback"`.
//     - The CI test mcp/test/synthesis/single-producer-recall-feedback.test.mjs
//       greps every file under mcp/lib/** for the literal string
//       "salience.recall_feedback" and asserts ONLY this file matches as a
//       writer (the recall-time consumer at mcp/lib/tools/recall.js calls in
//       via emitRecallFeedback, never references the literal).
//     - scripts/replay-salience.mjs (the original design's producer) does NOT
//       write the row directly; if it ever needs to, it MUST route through
//       emitRecallFeedback so the single-chokepoint discipline holds.
//
//   This mirrors the discipline used for `policy_kind:"connector_revoke"`
//   (single producer: mcp/lib/connectors/index.js applyConnectorRevoke) and
//   `kind:"reconstructed"` (single producer: emitReconstruction).
//
// ROW SHAPE (memory.jsonl line)
//   {
//     id: "mem_<16hex>",
//     kind: "policy",
//     policy_kind: "salience.recall_feedback",
//     schema_version: "v1",
//     recall_id: <string>,
//     surfaced_memory_ids: [<string>, ...],
//     surface_position_by_id: { <memory_id>: <int>, ... },
//     scoring_weights: { <weight_name>: <number>, ... },
//     propensities_by_id: { <memory_id>: <number>, ... },
//     emitter_module: "recall-feedback-emitter",
//     emitter_version: "v1",
//     ts: <iso8601>,
//   }
//
// DEFENSIVE I/O DISCIPLINE
//   - Any write failure (disk full, permission denied, parent dir missing)
//     is caught, logged via console.error, and swallowed. The caller (recall
//     handler) gets {ok: false, written_count: 0, error_reason: "..."}.
//     A throw out of this emitter would crash the recall hot-path because
//     the caller invokes us fire-and-forget at the tail of handler().
//   - The on-disk write is fsync'd so durability matches connector_revoke
//     and the reconstruction emitter (both shipped with explicit fsync).

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

import { memoryLedgerPath } from "../config.js";
import { serverTs } from "../envelope.js";

// ---------------------------------------------------------------------------
// PUBLIC CONSTANTS — exported so consumers + tests reference one source of
// truth. NEVER inline the literal "salience.recall_feedback" anywhere else
// under mcp/lib/ (the single-producer CI test will flag a violation).
// ---------------------------------------------------------------------------

/** The policy_kind discriminator stamped into every row this module writes.
 *  Consumers reading memory.jsonl filter on `row.policy_kind ===
 *  RECALL_FEEDBACK_KIND`. */
export const RECALL_FEEDBACK_KIND = "salience.recall_feedback";

/** Schema version stamped into every row. Bumped when the row shape changes
 *  in a backwards-incompatible way. v1 ships the batched-set envelope. */
export const RECALL_FEEDBACK_SCHEMA_VERSION = "v1";

/** Emitter module identifier — written into the row's `emitter_module`
 *  audit slot so downstream consumers can identify the producer without
 *  parsing the file path of the writer. */
const EMITTER_MODULE = "recall-feedback-emitter";

/** Emitter version tag — written into the row's `emitter_version` audit
 *  slot. Bumped when the writer-side semantics change in a way the consumer
 *  cares about (e.g. a propensity field is renamed). */
const EMITTER_VERSION = "v1";

// ---------------------------------------------------------------------------
// File-system constants — mirror the connector-revoke + reconstruction-
// emitter writer discipline. O_NOFOLLOW guards against symlink-redirect
// attacks; 0600 mode matches the rest of the ledger's privacy posture.
// ---------------------------------------------------------------------------

const LEDGER_O_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_NOFOLLOW;

const LEDGER_FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function generateRowId() {
  // mem_<16hex> — matches the prefix discipline used by
  // applyConnectorRevoke (connectors/index.js) for parity. The recall layer
  // does not key off this id; it exists for ledger-level audit join.
  return "mem_" + randomBytes(8).toString("hex");
}

function ensureLedgerDir(ledgerPath) {
  const dir = dirname(ledgerPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function fsyncDir(dir) {
  // macOS APFS + Linux ext4 default need the explicit dir-fsync after a
  // first-time create so power-cut between data sync and inode-link sync
  // cannot lose the new file's existence. Mirrors applyConnectorRevoke.
  try {
    const dirFd = openSync(dir, fsConstants.O_RDONLY);
    try {
      fsyncSync(dirFd);
    } finally {
      try {
        closeSync(dirFd);
      } catch {
        // ignore
      }
    }
  } catch (err) {
    if (err && err.code !== "EISDIR" && err.code !== "EINVAL") {
      // non-fatal — the row bytes are already fsync'd to the file; an
      // unflushable dir entry is the rarest of corner cases and bubbling
      // up here would defeat the defensive-write contract.
    }
  }
}

function appendOneRow(row) {
  const ledgerPath = memoryLedgerPath();
  ensureLedgerDir(ledgerPath);
  const bytes = Buffer.from(JSON.stringify(row) + "\n", "utf8");
  const fd = openSync(ledgerPath, LEDGER_O_FLAGS, LEDGER_FILE_MODE);
  try {
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written);
    }
    fsyncSync(fd);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
  fsyncDir(dirname(ledgerPath));
}

// ---------------------------------------------------------------------------
// Input validation — light but defensive. We do NOT throw on invalid input;
// instead we return {ok:false, written_count:0, error_reason:"..."} so the
// fire-and-forget caller never crashes. The CI test asserts shape via the
// success path; bad-input paths just no-op.
// ---------------------------------------------------------------------------

function validateInput(input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "input must be a plain object" };
  }
  if (typeof input.recall_id !== "string" || input.recall_id.length === 0) {
    return { ok: false, reason: "recall_id must be a non-empty string" };
  }
  if (!Array.isArray(input.surfaced_memory_ids)) {
    return {
      ok: false,
      reason: "surfaced_memory_ids must be an array",
    };
  }
  for (let i = 0; i < input.surfaced_memory_ids.length; i++) {
    const s = input.surfaced_memory_ids[i];
    if (typeof s !== "string" || s.length === 0) {
      return {
        ok: false,
        reason: `surfaced_memory_ids[${i}] must be a non-empty string`,
      };
    }
  }
  if (
    input.surface_position_by_id == null ||
    typeof input.surface_position_by_id !== "object" ||
    Array.isArray(input.surface_position_by_id)
  ) {
    return {
      ok: false,
      reason: "surface_position_by_id must be a plain object",
    };
  }
  if (
    input.scoring_weights == null ||
    typeof input.scoring_weights !== "object" ||
    Array.isArray(input.scoring_weights)
  ) {
    return { ok: false, reason: "scoring_weights must be a plain object" };
  }
  if (
    input.propensities_by_id == null ||
    typeof input.propensities_by_id !== "object" ||
    Array.isArray(input.propensities_by_id)
  ) {
    return {
      ok: false,
      reason: "propensities_by_id must be a plain object",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// PUBLIC API — the SOLE entry point. The recall-time handler calls this
// AFTER returning the brief; never await it (fire-and-forget).
//
// BATCHING DISCIPLINE
//   One emit -> ONE row -> the entire surfaced set is encoded in a single
//   JSONL line. Emitting N rows for N surfaced memories was rejected at
//   architect-time review (it inflated the ledger 5-10x without adding
//   audit value the batched envelope cannot provide via the
//   surface_position_by_id + propensities_by_id maps).
//
// RETURN SHAPE
//   {
//     ok: true,
//     written_count: 1,           // always 1 on success (batched envelope)
//   }
//   OR on any failure (invalid input OR write failure):
//   {
//     ok: false,
//     written_count: 0,
//     error_reason: <string>,     // human-readable, for logger
//   }
//
//   The caller (recall handler) MUST NOT branch on ok=false — the contract
//   is fire-and-forget. The error_reason is logged here AND returned for
//   tests that want to assert on the failure mode.
// ---------------------------------------------------------------------------

/**
 * Emit a batched `policy.salience.recall_feedback` event for one recall.
 *
 * @param {object} input
 * @param {string} input.recall_id — the recall_id from the surfaced brief.
 * @param {string[]} input.surfaced_memory_ids — every memory_id surfaced.
 * @param {Record<string, number>} input.surface_position_by_id — map
 *   memory_id -> 0-indexed surface position.
 * @param {object} input.scoring_weights — snapshot of the active weight
 *   vector at recall time (e.g. CAPS.SALIENCE_WEIGHTS_V1 keys). Audit-only;
 *   the consumer matches against the live caps to detect drift.
 * @param {Record<string, number>} input.propensities_by_id — map
 *   memory_id -> propensity score (Plackett-Luce output).
 *
 * @returns {Promise<{ok: boolean, written_count: number, error_reason?: string}>}
 */
export async function emitRecallFeedback(input) {
  // Defensive: validate before any I/O. Bad input is a no-op return; we do
  // NOT throw out to the fire-and-forget caller.
  const v = validateInput(input);
  if (v.ok !== true) {
    try {
      console.error(
        `recall-feedback-emitter: invalid input, skipping write: ${v.reason}`,
      );
    } catch {
      // logger throws don't propagate
    }
    return { ok: false, written_count: 0, error_reason: v.reason };
  }

  const row = {
    id: generateRowId(),
    kind: "policy",
    policy_kind: RECALL_FEEDBACK_KIND,
    schema_version: RECALL_FEEDBACK_SCHEMA_VERSION,
    recall_id: input.recall_id,
    surfaced_memory_ids: [...input.surfaced_memory_ids],
    surface_position_by_id: { ...input.surface_position_by_id },
    scoring_weights: { ...input.scoring_weights },
    propensities_by_id: { ...input.propensities_by_id },
    emitter_module: EMITTER_MODULE,
    emitter_version: EMITTER_VERSION,
    ts: serverTs(),
  };

  // Defensive write — any throw is caught, logged, and swallowed. The
  // fire-and-forget contract means the recall handler keeps moving even if
  // the audit ledger is uniformly busted.
  try {
    appendOneRow(row);
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    try {
      console.error(
        `recall-feedback-emitter: ledger append failed, skipping: ${reason}`,
      );
    } catch {
      // logger throws don't propagate
    }
    return { ok: false, written_count: 0, error_reason: reason };
  }

  return { ok: true, written_count: 1 };
}

// ---------------------------------------------------------------------------
// TEST-ONLY EXPORTS — surfaced for the substrate test suite so the internal
// helpers can be unit-tested without invoking the full emit path. Not part
// of the public substrate contract.
// ---------------------------------------------------------------------------

export const __internal = Object.freeze({
  validateInput,
  generateRowId,
  EMITTER_MODULE,
  EMITTER_VERSION,
});
