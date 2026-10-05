// recall-log.js — recall-substrate ledger writer + in-process lookup map.
//
// TWO COUPLED SURFACES live here:
//
//   1. In-process recall map (Phase 0 carry-over): keyed by recall_id, used
//      by memory_exclude to snapshot the query.context_embedding +
//      embedding_model_version from the prior recall when binding a
//      predicate. TTL-enforced (RECALL_LOG_TTL_SECONDS, default 24h).
//
//   2. On-disk recall-substrate ledger (Phase 3 v0 addition): an append-only
//      JSONL at ledgers/recall.jsonl that captures the FULL per-recall trace
//      needed by Phase 3 v3 off-policy evaluation: candidate set, surfaced
//      items with propensities, feature breakdowns, density flag, and
//      degraded_recall flag. See kb/phase3-v0-contracts.md § 5.
//
// Authoritative spec source:
//   kb/research-retrieval-frontiers.md
//   § "Recommended Phase 3 architecture" → recall-as-event logging,
//   § "Staged rollout plan" → Phase 3 v0 deliverables.
//
// Why both surfaces coexist:
//   - memory_exclude needs O(1) lookup by recall_id for context_embedding
//     snapshotting. The on-disk JSONL is append-only and unindexed.
//   - The on-disk JSONL is the v3 OPE substrate. Process-restart must NOT
//     lose this signal.
//   - The TTL only applies to the in-process map. The on-disk ledger has no
//     TTL; it is the long-lived recall-log per the report.
//
// File durability: each appended line is fsync'd + dir-fsync'd, matching the
// memory.jsonl discipline in distill-promote-fact.js. Recall events are the
// supervisory signal for v3 learning; a torn line is silently bad data, and
// a missing line is silently lost training signal.

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { LEDGERS_DIR } from "./config.js";
import { CAPS } from "./validation.js";

// ---------------------------------------------------------------------------
// In-process map (memory_exclude binding surface)
// ---------------------------------------------------------------------------
const RECALL_LOG = new Map();

export function recordRecall(recallId, entry) {
  RECALL_LOG.set(recallId, entry);
}

export function lookupRecall(recallId, now = Date.now()) {
  const entry = RECALL_LOG.get(recallId);
  if (entry == null) return null;
  const loggedAtMs = Date.parse(entry.logged_at);
  if (!Number.isFinite(loggedAtMs)) {
    return null;
  }
  const ageSeconds = (now - loggedAtMs) / 1000;
  if (ageSeconds > CAPS.RECALL_LOG_TTL_SECONDS) {
    return null;
  }
  return entry;
}

// Test-only: clear between unit tests. Production code does not call this.
export function _resetRecallLog() {
  RECALL_LOG.clear();
}

// ---------------------------------------------------------------------------
// On-disk recall-substrate ledger (Phase 3 v0)
// ---------------------------------------------------------------------------

function recallLedgerPath() {
  return join(LEDGERS_DIR, "recall.jsonl");
}

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
    if (err && err.code !== "EISDIR" && err.code !== "EINVAL") {
      throw err;
    }
  } finally {
    if (dirFd !== -1) {
      try { closeSync(dirFd); } catch {}
    }
  }
}

/**
 * Append a recall event to ledgers/recall.jsonl. Shape per
 * kb/phase3-v0-contracts.md § 5 (v0 base) AND
 * kb/phase3-v1-rerank-contracts.md § 3 (v1 additive Layer-3 fields).
 *
 * The caller MUST also call recordRecall(recallId, {...}) for the
 * in-process map used by memory_exclude — appendRecallEvent does NOT touch
 * the in-process map. (The two surfaces serve different purposes; coupling
 * them at the writer would hide the distinct semantics.)
 *
 * @param {object} event - shaped per v0 § 5 + v1 § 3:
 *   {
 *     id, ts, kind:"recall",
 *     query:{surrounding_context_hash, context_embedding, embedding_model_version},
 *     surfaced:[{memory_id, score, position, propensity, feature_breakdown,
 *                rerank_score: number | null}],     // v1 ADDS rerank_score
 *     candidates_pre_truncation:[{memory_id, position, score,
 *                rerank_score: number | null}],     // v1 ADDS rerank_score
 *                                                   // (non-null for the
 *                                                   //  top-RECALL_RERANK_INPUT_SIZE
 *                                                   //  fed to Flash; null
 *                                                   //  for positions 25..49
 *                                                   //  so propensity replay
 *                                                   //  remains sound)
 *     density_flag,
 *     degraded_recall,                              // v0 — BM25-only fallback
 *     rerank_attempted: boolean,                    // v1 NEW (top level)
 *     rerank_failed_reason: string | null,          // v1 NEW (top level)
 *     layer3_latency_ms: number,                    // v1 NEW (top level)
 *     degraded_recall_layer3: boolean,              // v1 NEW (top level)
 *     // Round-19 brutalist CRITICAL-4 hot-fix: audit-provenance fields
 *     // required for the FIRST week of production logs. Without them the
 *     // recall.jsonl cannot be audited for prompt drift, cap changes, or
 *     // model version skew across recalls. Append-only; v0 consumers ignore.
 *     rerank_instruction_hash: string | null,       // v1 NEW — sha256-16hex of
 *                                                   //   the exact instruction
 *                                                   //   string sent to Flash;
 *                                                   //   null if rerank_attempted=false
 *     rerank_caps_snapshot: object | null,          // v1 NEW — {INPUT_SIZE,
 *                                                   //   OUTPUT_SIZE,
 *                                                   //   TIMEOUT_MS,
 *                                                   //   CONTENT_EXCERPT_CHARS,
 *                                                   //   FLASH_TEMPERATURE,
 *                                                   //   FLASH_THINKING_BUDGET}
 *                                                   //   at the time of the call;
 *                                                   //   null if rerank_attempted=false
 *     rerank_model_version: string | null           // v1 NEW — the exact Flash
 *                                                   //   model tag the call hit
 *                                                   //   (CAPS.GEMINI_FLASH_MODEL_DEFAULT
 *                                                   //   at recall time); null
 *                                                   //   if rerank_attempted=false
 *   }
 *
 * v1 additions are ADDITIVE over v0; v0 consumers that ignore the new
 * fields remain correct.
 */
export function appendRecallEvent(event) {
  if (event == null || typeof event !== "object") {
    throw new TypeError("appendRecallEvent: event must be an object");
  }
  const path = recallLedgerPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const bytes = Buffer.from(JSON.stringify(event) + "\n", "utf8");
  const fd = openSync(path, LEDGER_O_FLAGS, LEDGER_FILE_MODE);
  try {
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDir(dir);
}
