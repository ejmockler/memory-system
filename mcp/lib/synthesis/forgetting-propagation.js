// forgetting-propagation.js — Wave 11 BEHAVIOR tier.
// (F-SYN-BEHAVIOR-forgetting-propagation-through-synthesis)
//
// Authoritative spec:
//   - docs/specs/synthesis/derivation-propagation.md (W4 foundation)
//     § 4.4 EXCISE channel, § 4.4 Rule DEPTH-CAP, § 4.4 Rule CYCLE-DEFENSE.
//
// MISSION
//   When the operator excludes / excises a memory (a fact, policy, or
//   reconstructed row) the W8 derivation-graph-recall-pathway already
//   orphans reconstructed descendants LAZILY at recall time
//   (mcp/lib/recall/hard-gates.js + mcp/lib/tools/recall.js gate). The
//   orphaning is non-destructive — the descendant rows stay on disk and
//   are dampened by the multi-feature score's derivation_status branch.
//
//   This module makes the propagation EXPLICIT at excise time so:
//
//     1. The audit ledger captures the full cascade in ONE policy row, not
//        a per-recall reconstruction.
//        (Operators reading memory.jsonl can answer "what did this
//        excise touch?" without replaying every recall.)
//
//     2. The recall layer has a fast-path: read the cascade rows and
//        short-circuit transitive-orphan BFS for memory ids already
//        captured in a fresh cascade event.
//
//     3. The single-producer invariant for `policy.derivation.cascade_orphan`
//        rows is preserved — only this module writes them.
//        Enforced by mcp/test/synthesis/single-producer-forgetting-cascade.test.mjs.
//
// CONTRACT
//   propagateForgettingThroughSynthesis({excisedMemoryId, ledgerPath,
//                                       derivationGraph})
//     → {orphan_events_emitted, cascade_event_id}
//
//   - excisedMemoryId is the memory_id of the row being excluded. Walking
//     starts from this id over the graph's reverseAdj (parent → child)
//     using derivation-graph.walkExcisePropagation.
//
//   - ledgerPath is the memory.jsonl write target. The cascade row lands
//     here as a `kind:"policy", policy_kind:"derivation.cascade_orphan"`
//     event. If the caller passes derivationGraph in, we re-use it (cheap
//     path); otherwise we cold-load via loadOrRebuildDerivationGraph.
//
//   - derivationGraph is optional. When the caller already has the graph
//     in hand (e.g. another tier's BFS just used it) re-use avoids an
//     ledger restream.
//
// DEFENSIVE DEGRADATION
//   Every cross-module call (loadOrRebuildDerivationGraph, walk, ledger
//   write) is wrapped in try/catch. A graph load failure surfaces as a
//   no-op return — the excise itself is unaffected, the audit ledger
//   simply does NOT carry the cascade row for this excise. Operators see
//   drift via memory_health (TODO behavior-tier follow-up) but the hot
//   path NEVER throws back to the caller. This matches the W7+W9 emitter
//   discipline (recall-feedback-emitter.js, reconstruction-emitter.js).
//
// DEPTH CAP
//   The W4 foundation pins PROPAGATION_DEPTH_MAX=3. The walk re-uses the
//   derivation-graph.walkExcisePropagation generator which enforces the
//   cap, so this module does NOT redefine it.
//
// MULTI-PARENT BEHAVIOR
//   A reconstructed child whose parents include the excised root AND ≥1
//   live (non-excised) parent is NOT cascaded by this module. The
//   walkExcisePropagation BFS visits the child (it is a descendant of the
//   excised root by reverseAdj) but the ORPHAN-FLIP rule (W4 § 4.4) lives
//   at the recall layer: a single parent excised out of N>1 produces
//   `partially_orphaned` state at recall time, NOT `orphaned`. To honor
//   that invariant at cascade time we filter descendants to those whose
//   `derived_from[]` is ENTIRELY in the cascade set — i.e. they would
//   flip to `orphaned` under ORPHAN-FLIP. Multi-parent rescued nodes are
//   omitted from the cascade event and left to the lazy recall gate
//   (which can still classify them as `partially_orphaned`).
//
//   This is the conservative interpretation: the cascade event is the
//   ONE-row audit of nodes whose lineage is fully gated. Partial-orphan
//   nodes are not in the audit because their status is not yet final
//   (a future excise could flip them to orphaned, or a corroboration
//   rescue could keep them live).

import { randomBytes } from "node:crypto";
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

import { serverTs } from "../envelope.js";
import { streamLedgerLines } from "./_ledger-stream.js";
import {
  loadOrRebuildDerivationGraph,
  PROPAGATION_DEPTH_MAX,
  walkExcisePropagation,
} from "./derivation-graph.js";

// ---------------------------------------------------------------------------
// PUBLIC CONSTANTS — exported so consumers + tests reference one source of
// truth. NEVER inline the literal "derivation.cascade_orphan" anywhere else
// under mcp/lib/ (the single-producer CI test will flag a violation).
// ---------------------------------------------------------------------------

/** Module version stamp — increment when the row shape / propagation
 *  semantics change in a backwards-incompatible way. v0.1.0 ships the
 *  W11 BEHAVIOR-tier first cut. */
export const FORGETTING_PROPAGATION_VERSION = "v0.1.0";

/** The policy_kind discriminator stamped into every cascade row. The
 *  single-producer CI test asserts only this file writes it. */
export const PROPAGATION_CASCADE_KIND = "derivation.cascade_orphan";

/** Frozen module-level capability snapshot — mirrors the CAPS discipline
 *  used by recall-feedback-emitter (RECALL_FEEDBACK_KIND/SCHEMA_VERSION).
 *  PROPAGATION_DEPTH_MAX is re-exported from derivation-graph (which is
 *  the W4 authoritative store) so consumers can inspect the snapshot
 *  without crossing tier boundaries. */
export const CAPS = Object.freeze({
  PROPAGATION_DEPTH_MAX,
  PROPAGATION_CASCADE_KIND,
  FORGETTING_PROPAGATION_VERSION,
});

/** Emitter module identifier — written into the row's `emitter_module`
 *  audit slot so downstream consumers can identify the producer without
 *  parsing the file path of the writer. */
const EMITTER_MODULE = "forgetting-propagation";

// ---------------------------------------------------------------------------
// File-system constants — mirror the W9 recall-feedback-emitter discipline.
// O_NOFOLLOW guards against symlink-redirect attacks; 0600 mode matches the
// rest of the ledger's privacy posture.
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
  // mem_<16hex> — matches the prefix discipline used by recall-feedback-
  // emitter + connectors/index.js for parity. The recall layer does not
  // key off this id; it exists for ledger-level audit join.
  return "mem_" + randomBytes(8).toString("hex");
}

function ensureLedgerDir(ledgerPath) {
  try {
    const dir = dirname(ledgerPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  } catch {
    // Best-effort: a missing parent dir means the appendOneRow open() will
    // surface the actual ENOENT; let it bubble there.
  }
}

function fsyncDir(dir) {
  // macOS APFS + Linux ext4 default need the explicit dir-fsync after a
  // first-time create so power-cut between data sync and inode-link sync
  // cannot lose the new file's existence. Mirrors recall-feedback-emitter.
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

function appendOneRow(ledgerPath, row) {
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

/**
 * Build the cascade set: starting from the excised root, walk descendants
 * via reverseAdj (parent → child). Filter to descendants whose ENTIRE
 * derived_from[] lineage is captured in the cascade — those are the
 * `orphaned` outcomes per W4 § 4.4 Rule ORPHAN-FLIP. Multi-parent rescued
 * nodes (≥1 parent still live, not in cascade set) are omitted; they
 * remain `partially_orphaned` at recall time via the lazy gate.
 *
 * To compute "fully-orphaned" we need to know each candidate's parents.
 * The derivation graph's forwardAdj (child → parents) gives us this in
 * O(1) per node.
 *
 * @param {{forwardAdj: Map<string, Set<string>>, reverseAdj: Map<string, Set<string>>}} graph
 * @param {string} excisedMemoryId
 * @returns {{cascadedIds: string[], examined_count: number}}
 */
function buildCascadeSet(graph, excisedMemoryId) {
  const examined = [];
  try {
    for (const visit of walkExcisePropagation(graph, excisedMemoryId)) {
      examined.push(visit);
    }
  } catch {
    // walkExcisePropagation should not throw on a valid graph; defensive.
    return { cascadedIds: [], examined_count: 0 };
  }

  // cascadeSet: ids known to be fully orphaned. Seed with the excised
  // root so multi-parent descendants whose other-parents include the
  // root see it counted as excised.
  const cascadeSet = new Set([excisedMemoryId]);

  // Order matters: examined[] is BFS-visit order from the W4 generator
  // (depth-1 first, then depth-2, ...). Iterating in this order lets us
  // propagate "fully orphaned" through chains: an intermediate child's
  // fully-orphaned status flips its own grandchildren.
  const cascadedIds = [];
  for (const visit of examined) {
    const id = visit.memoryId;
    if (cascadeSet.has(id)) continue; // dedup defense — BFS visited set should already prevent this
    const parents = graph.forwardAdj instanceof Map
      ? graph.forwardAdj.get(id)
      : undefined;
    let fullyOrphaned = false;
    if (parents === undefined || parents.size === 0) {
      // No parent edges recorded — this can happen for fact/policy rows
      // that have no derivation edges of their own but were nonetheless
      // reachable through reverseAdj (e.g. a policy targets them).
      // Without a derived_from[] we can't apply ORPHAN-FLIP — skip.
      fullyOrphaned = false;
    } else {
      // ORPHAN-FLIP w/ transitivity: every parent must be in cascadeSet
      // (which contains the root excise + already-fully-orphaned ancestors).
      fullyOrphaned = true;
      for (const parentId of parents) {
        if (!cascadeSet.has(parentId)) {
          fullyOrphaned = false;
          break;
        }
      }
    }
    if (fullyOrphaned) {
      cascadeSet.add(id);
      cascadedIds.push(id);
    }
  }

  return { cascadedIds, examined_count: examined.length };
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

/**
 * Propagate the forgetting cascade through the derivation graph after an
 * excise / exclude. Emits ONE `policy.derivation.cascade_orphan` row that
 * captures every reconstructed descendant whose lineage is fully orphaned
 * by the excise (per W4 § 4.4 Rule ORPHAN-FLIP).
 *
 * Defensive: every failure mode (missing graph, ledger write throw, bad
 * input) returns `{orphan_events_emitted: 0, cascade_event_id: ""}` —
 * never throws back to the caller (the caller invokes fire-and-forget).
 *
 * @param {object} opts
 * @param {string} opts.excisedMemoryId — the memory_id of the excised row.
 * @param {string} opts.ledgerPath — absolute path to memory.jsonl.
 * @param {object} [opts.derivationGraph] — optional pre-loaded graph
 *   (forwardAdj/reverseAdj Maps). When omitted, cold-loaded from ledger.
 *
 * @returns {Promise<{orphan_events_emitted: number, cascade_event_id: string}>}
 */
export async function propagateForgettingThroughSynthesis({
  excisedMemoryId,
  ledgerPath,
  derivationGraph,
} = {}) {
  // Input validation. We do NOT throw; fire-and-forget callers expect a
  // no-op on bad input.
  if (typeof excisedMemoryId !== "string" || excisedMemoryId.length === 0) {
    return { orphan_events_emitted: 0, cascade_event_id: "" };
  }
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    return { orphan_events_emitted: 0, cascade_event_id: "" };
  }

  // Acquire the graph. Prefer the caller's pre-loaded snapshot; cold-load
  // on demand otherwise.
  let graph = derivationGraph;
  if (graph == null || !(graph.reverseAdj instanceof Map) || !(graph.forwardAdj instanceof Map)) {
    try {
      graph = await loadOrRebuildDerivationGraph({ ledgerPath });
    } catch (err) {
      // Defensive: graph load failure → no-op. The excise still proceeds
      // because the caller invoked us fire-and-forget. Log for operator
      // visibility but do NOT propagate.
      try {
        console.error(
          `forgetting-propagation: graph load failed for excisedMemoryId=${excisedMemoryId}: ${err && err.message ? err.message : String(err)}`,
        );
      } catch {
        // logger throws don't propagate
      }
      return { orphan_events_emitted: 0, cascade_event_id: "" };
    }
  }

  // Verify the graph shape — guards against a partial cache parse.
  if (!(graph.reverseAdj instanceof Map) || !(graph.forwardAdj instanceof Map)) {
    return { orphan_events_emitted: 0, cascade_event_id: "" };
  }

  // Walk the descendants, classify each via ORPHAN-FLIP w/ transitivity,
  // and collect the fully-orphaned set.
  let cascadeResult;
  try {
    cascadeResult = buildCascadeSet(graph, excisedMemoryId);
  } catch (err) {
    try {
      console.error(
        `forgetting-propagation: cascade build failed for ${excisedMemoryId}: ${err && err.message ? err.message : String(err)}`,
      );
    } catch {
      // ignore
    }
    return { orphan_events_emitted: 0, cascade_event_id: "" };
  }

  const { cascadedIds, examined_count } = cascadeResult;

  // Zero cascaded ids → still emit nothing. The single-row contract is:
  // a cascade event ALWAYS captures ≥1 orphaned descendant. An empty
  // cascade is operationally indistinguishable from "no propagation".
  if (cascadedIds.length === 0) {
    return { orphan_events_emitted: 0, cascade_event_id: "" };
  }

  const cascadeEventId = generateRowId();
  const row = {
    id: cascadeEventId,
    kind: "policy",
    policy_kind: PROPAGATION_CASCADE_KIND,
    schema_version: FORGETTING_PROPAGATION_VERSION,
    excised_memory_id: excisedMemoryId,
    orphaned_memory_ids: [...cascadedIds],
    orphan_count: cascadedIds.length,
    examined_count,
    propagation_depth_max: PROPAGATION_DEPTH_MAX,
    emitter_module: EMITTER_MODULE,
    emitter_version: FORGETTING_PROPAGATION_VERSION,
    ts: serverTs(),
  };

  // Defensive write — any throw is caught, logged, and swallowed.
  try {
    appendOneRow(ledgerPath, row);
  } catch (err) {
    try {
      console.error(
        `forgetting-propagation: ledger append failed for ${excisedMemoryId}: ${err && err.message ? err.message : String(err)}`,
      );
    } catch {
      // logger throws don't propagate
    }
    return { orphan_events_emitted: 0, cascade_event_id: "" };
  }

  return {
    orphan_events_emitted: cascadedIds.length,
    cascade_event_id: cascadeEventId,
  };
}

// ---------------------------------------------------------------------------
// TEST-ONLY EXPORTS — surfaced for the substrate test suite so the internal
// helpers can be unit-tested without invoking the full propagate path. Not
// part of the public behavior contract.
// ---------------------------------------------------------------------------

export const __internal = Object.freeze({
  buildCascadeSet,
  generateRowId,
  EMITTER_MODULE,
});

// ---------------------------------------------------------------------------
// Re-read helper for tests / operators — given a ledger path, return every
// cascade row currently on disk. Useful for both single-producer enforcement
// tests and operator audit queries. Defensive: returns [] on any IO failure.
// ---------------------------------------------------------------------------

/** readCascadeEventsFromLedger — stream every cascade_orphan row off the ledger.
 *
 *  INCIDENT HISTORY (defect class, same bite as the emitter — see the full
 *  write-up at reconstruction-emitter.js:371-401):
 *    The original body slurped the ENTIRE memory.jsonl into ONE utf8 string
 *    (whole-file synchronous read) inside a bare `catch { return []; }`.
 *    Node/V8's max string
 *    length is 536,870,888 bytes and the live ledger is >3 GB, so the read
 *    throws ERR_STRING_TOO_LONG and the swallow made an UNREADABLE ledger
 *    indistinguishable from an EMPTY one. This reader has no production
 *    caller today — it was a dormant landmine, correct only until wired.
 *
 *  FIX:
 *    1. Stream via _ledger-stream.js (the WU-B1 primitive) and apply the
 *       cascade filter INSIDE the callback, so retention is bounded by the
 *       cascade-row count rather than by the ledger size and no whole-file
 *       string is ever materialized. Do NOT add a row cap or a time window
 *       here — that would silently change the operator-audit semantics
 *       (same rationale as reconstruction-emitter.js:392-394).
 *    2. The former existsSync(ledgerPath) short-circuit is GONE: it
 *       conflated an EACCES/ELOOP/ENOTDIR path with a missing one (see
 *       _ledger-stream.js:118-126). streamLedgerLines returns zeros with
 *       readError null for a genuine ENOENT, so missing-ledger → [] holds.
 *    3. A read failure is logged ONCE per call instead of being swallowed,
 *       so the operator can tell "unreadable" from "empty".
 *
 *  @param {string} ledgerPath
 *  @param {{error?: Function}} [logger] — optional; falls back to console.error.
 *  @returns {Array<object>} cascade rows only. Never throws. */
export function readCascadeEventsFromLedger(ledgerPath, logger) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) return [];
  const out = [];
  // streamLedgerLines never throws; fs failures surface on counts.readError.
  const counts = streamLedgerLines(ledgerPath, (row) => {
    if (row && row.kind === "policy" && row.policy_kind === PROPAGATION_CASCADE_KIND) {
      out.push(row);
    }
  });
  if (counts.readError !== null && counts.readError !== undefined) {
    try {
      const line =
        `forgetting-propagation: cascade-event scan failed mid-read (${counts.readError}); ` +
        `proceeding with ${out.length} cascade rows parsed before the failure — ` +
        "an unreadable ledger is NOT an empty ledger";
      if (logger && typeof logger.error === "function") {
        logger.error(line);
      } else {
        console.error(line);
      }
    } catch {
      // logger throws don't propagate
    }
  }
  return out;
}
