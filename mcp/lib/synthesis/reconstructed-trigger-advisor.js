// reconstructed-trigger-advisor.js — Wave 11 BEHAVIOR.
// (F-SYN-BEHAVIOR-reconstructed-trigger-logic)
//
// Authoritative specs:
//   - docs/specs/synthesis/reconstructed-trigger-logic.md (this WU)
//   - docs/specs/synthesis/reconstructed-trigger.md       (W7 foundation contract)
//   - kb/open-problems.md #6                              (operator question)
//
// Architectural anchors:
//   - thesis.md Principle 7 — agents cannot write durably without going
//     through the screened surface. The advisor is OPTIONAL: it does NOT
//     replace the screen. The W7 emitter (`reconstruction-emitter.js`)
//     remains the SOLE writer of `kind: "reconstructed"` rows; the W8 MCP
//     tool (`distill-emit-reconstructed.js`) remains the SOLE agent-facing
//     surface. The advisor is a PRE-EMIT hint that lets the agent decline
//     to call the screen when the answer is obviously "no". The emitter's
//     own R8 idempotency check + R3 not-excised gate are unchanged.
//
// CONTRACT (single async export):
//   shouldEmitReconstruction(input) — returns {emit, reason, advisory_score}.
//   `emit` is the advisor's recommendation; `reason` is one of a closed
//   set of reason codes; `advisory_score` is a [0,1] confidence-weighted
//   signal the integration tier can plumb into dashboards / telemetry.
//
// REASON CODES (closed enum):
//   - "below_confidence_min"   — confidence < CAPS.CONFIDENCE_MIN
//   - "pure_paraphrase"        — single parent + content is a paraphrase
//   - "near_duplicate_exists"  — existing reconstructed row inside the
//                                {conversation_id, parent_set_hash}
//                                idempotency domain has near-identical
//                                content (cosine over token-set Jaccard
//                                proxy > CAPS.NEAR_DUP_THRESHOLD)
//   - "ok_to_emit"             — gates passed; emit recommended
//   - "advisor_error"          — defensive degradation (try/catch barrier)
//
// DEFENSIVE DEGRADATION DISCIPLINE:
//   The advisor is on the HOT path (agent considering an emit), so any
//   uncaught throw inside this module would block the agent. We wrap the
//   entire decision in a try/catch and return {emit:false,
//   reason:"advisory_error", advisory_score:0} on any failure. The
//   conservative bias (emit:false on uncertainty) is intentional: a
//   false-negative advisor recommendation wastes one round-trip; a
//   false-positive (recommending emit on a corrupt input) would mint a
//   spurious reconstructed event.
//
// SINGLE-PRODUCER POSTURE:
//   The advisor does NOT write to the memory ledger, the policy events
//   stream, the recall log, or any other policy_kind surface. No new
//   policy_kind value is introduced. The CI single-producer test is
//   unaffected.

import { createHash } from "node:crypto";

import { streamLedgerLines } from "./_ledger-stream.js";

// ---------------------------------------------------------------------------
// PUBLIC CONSTANTS
// ---------------------------------------------------------------------------

/** Module version stamp. Frozen across calls; bump on threshold changes. */
export const TRIGGER_ADVISOR_VERSION = "v0.1.0";

/** Frozen CAPS table. All thresholds are CAPS-driven so the operator can
 *  recalibrate without touching the algorithm. The defaults below align
 *  with the W7 foundation spec § R4 (confidence floor 0.6) and § R5
 *  (paraphrase gate 0.85 edit-similarity → 0.8 token-set Jaccard at the
 *  advisor tier; the advisor is intentionally MORE PERMISSIVE than the
 *  emitter's gate so the advisor never advises "emit" on a payload the
 *  emitter would reject — the advisor is a pre-screen, not a post-screen). */
export const TRIGGER_CAPS = Object.freeze({
  /** Confidence floor below which the advisor recommends NOT emitting. */
  CONFIDENCE_MIN: 0.6,
  /** Token-set Jaccard above which a single-parent synthesis is treated
   *  as a "pure paraphrase" of its parent. v0 uses a cheap word-bag
   *  Jaccard; v1 will plumb cosine over Gemini embeddings. */
  PARAPHRASE_OVERLAP_THRESHOLD: 0.8,
  /** Token-set Jaccard above which an existing reconstructed row in the
   *  {conversation_id, parent_set_hash} domain is considered a
   *  near-duplicate. Higher than the paraphrase gate because we are
   *  comparing two SYNTHESES, not a synthesis against a parent. */
  NEAR_DUP_THRESHOLD: 0.92,
});

// ---------------------------------------------------------------------------
// INTERNAL: tokenization + token-set Jaccard (paraphrase + near-dup proxy)
// ---------------------------------------------------------------------------

/** Lowercase word-bag tokenisation. Matches the engagement-detector.js
 *  discipline (preserves hyphens + apostrophes intra-token). Punctuation
 *  is stripped on edges. */
function tokenize(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const lower = text.toLowerCase();
  const out = [];
  const re = /[a-z0-9_'-]+/g;
  let m;
  while ((m = re.exec(lower)) !== null) {
    const t = m[0].replace(/^[-']+|[-']+$/g, "");
    if (t.length > 0) out.push(t);
  }
  return out;
}

/** Token-set Jaccard: |A ∩ B| / |A ∪ B|. Returns 0 when either side is
 *  empty; returns 1 only when the two token SETS are identical. Cheap,
 *  order-insensitive, and a reasonable v0 proxy for paraphrase detection
 *  on short summarization text. */
function tokenSetJaccard(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

// ---------------------------------------------------------------------------
// INTERNAL: ledger scan (near-duplicate detection)
// ---------------------------------------------------------------------------

/** Streamed ledger scan — mirrors reconstruction-emitter.js scanLedgerLines.
 *  Returns ONLY `kind === "reconstructed"` rows (the sole consumer,
 *  findCandidatesInIdempotencyDomain, already discarded every other kind, so
 *  filtering here is behaviour-preserving and bounds retention: 1,827 such
 *  rows on the live 3 GB ledger).
 *  Defensive: missing file, read failure, torn-tail JSON all degrade to
 *  an empty/partial result rather than throwing.
 *
 *  INCIDENT HISTORY (defect class — full write-up at
 *  reconstruction-emitter.js:371-401):
 *    The original body slurped the ENTIRE memory.jsonl into ONE utf8 string
 *    (whole-file synchronous read) inside a bare `catch { return []; }`.
 *    Node/V8's max string
 *    length is 536,870,888 bytes and the live ledger is >3 GB, so the read
 *    throws ERR_STRING_TOO_LONG and the swallow made an UNREADABLE ledger
 *    indistinguishable from an EMPTY one — here that silently disarms the
 *    near-duplicate gate (every candidate reads as "no prior row"). The
 *    advisor is planned-but-unwired, so this was a dormant landmine.
 *
 *  FIX: stream through _ledger-stream.js with the kind filter INSIDE the
 *  callback (no whole-file string, no row cap, no time window — a cap would
 *  silently change the idempotency-domain semantics), drop the
 *  existsSync short-circuit (it conflated EACCES/ELOOP/ENOTDIR with a
 *  missing file — _ledger-stream.js:118-126; ENOENT still yields [] with no
 *  log), and log a read failure ONCE per call instead of swallowing it.
 *
 *  @param {string} ledgerPath
 *  @param {{error?: Function}} [logger] — optional; falls back to console.error
 *    (the live call site below passes none, so console.error is the path that
 *    actually fires in production). */
function scanLedgerLines(ledgerPath, logger) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) return [];
  const out = [];
  // streamLedgerLines never throws; fs failures surface on counts.readError.
  const counts = streamLedgerLines(ledgerPath, (row) => {
    if (row && row.kind === "reconstructed") out.push(row);
  });
  if (counts.readError !== null && counts.readError !== undefined) {
    try {
      const line =
        `reconstructed-trigger-advisor: ledger scan failed mid-read (${counts.readError}); ` +
        `proceeding with ${out.length} reconstructed rows parsed before the failure — ` +
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

/** Stable hash over a sorted parent set. Matches the W7 emitter's
 *  parent_set_hash discipline (sha256(canonical_json(sorted_parents)))
 *  but inlined here so the advisor stays free of validation.js deps. */
function parentSetHash(parents) {
  const sorted = [...parents].sort();
  // canonical_json of an array of strings is just JSON.stringify with stable
  // ordering — arrays preserve order; we sorted above; no nested objects.
  const preimage = JSON.stringify(sorted);
  return createHash("sha256").update(Buffer.from(preimage, "utf8")).digest("hex");
}

/** Find the reconstructed rows in the ledger that share BOTH the
 *  conversation_id (when set) AND the sorted parent_set_hash with the
 *  candidate. These are the rows the W7 emitter's S4 (agent) idempotency
 *  domain would collide on; the advisor's near-dup check runs over the
 *  SAME domain. */
function findCandidatesInIdempotencyDomain(ledgerRows, conversationId, parentSetH) {
  const out = [];
  for (const row of ledgerRows) {
    if (row == null || typeof row !== "object") continue;
    if (row.kind !== "reconstructed") continue;
    // conversation_id check: when caller scoped to a conversation, only
    // rows from the same conversation count.
    if (conversationId != null) {
      const rowConv =
        row.provenance && typeof row.provenance === "object"
          ? row.provenance.conversation_id
          : null;
      if (rowConv !== conversationId) continue;
    }
    const rowParents = Array.isArray(row.derived_from) ? row.derived_from : [];
    if (rowParents.length === 0) continue;
    const rowH = parentSetHash(rowParents);
    if (rowH !== parentSetH) continue;
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// PUBLIC ENTRY POINT
// ---------------------------------------------------------------------------

/**
 * shouldEmitReconstruction — pre-emit advisor.
 *
 * @param {object} input
 *   - parents: Array<{id: string, content: string}> OR Array<string>
 *       When string[], the advisor SKIPS the pure-paraphrase check (it
 *       cannot compute overlap without parent content) but still applies
 *       confidence + near-dup gates. The integration tier SHOULD pass the
 *       full {id, content} shape — the W8 MCP tool handler has the parent
 *       bodies in hand from the prior recall.
 *   - content: string                                — the candidate synthesis
 *   - confidence: number ∈ [0,1]                     — agent self-report
 *   - conversation_id: string | null                 — null on daemon-style
 *   - ledgerPath: string                             — memory.jsonl path
 *   - derivationGraph?: any                          — RESERVED for v1
 *
 * @returns {Promise<{emit: boolean, reason: string, advisory_score: number}>}
 */
export async function shouldEmitReconstruction(input) {
  // Single outer try/catch barrier: any uncaught throw inside the algorithm
  // collapses to the conservative {emit:false, advisor_error, 0} result.
  try {
    // ---- shape pre-checks (defensive; the W8 tool also schema-checks) ----
    if (input == null || typeof input !== "object" || Array.isArray(input)) {
      return { emit: false, reason: "advisor_error", advisory_score: 0 };
    }
    const {
      parents,
      content,
      confidence,
      conversation_id: conversationId,
      ledgerPath,
    } = input;
    if (!Array.isArray(parents) || parents.length === 0) {
      return { emit: false, reason: "advisor_error", advisory_score: 0 };
    }
    if (typeof content !== "string" || content.length === 0) {
      return { emit: false, reason: "advisor_error", advisory_score: 0 };
    }
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
      return { emit: false, reason: "advisor_error", advisory_score: 0 };
    }

    // ---- Gate 1: confidence floor ----
    // Per W7 § R4: confidence < CONFIDENCE_MIN is a hard reject at the
    // emitter. The advisor mirrors the gate so the agent can decline the
    // round-trip when its own self-report is already below the floor.
    if (confidence < TRIGGER_CAPS.CONFIDENCE_MIN) {
      return {
        emit: false,
        reason: "below_confidence_min",
        // Score scales the confidence into [0, CONFIDENCE_MIN) for telemetry.
        advisory_score: Math.max(0, Math.min(1, confidence)),
      };
    }

    // ---- Gate 2: pure-paraphrase of a single parent ----
    // Only applies when parents.length === 1 AND parent has content. A
    // single-parent emit that is just a verbatim/near-verbatim restatement
    // of the parent is the canonical "this is a paraphrase, don't emit"
    // failure mode that open-problems #6 calls out by name.
    if (parents.length === 1) {
      const p = parents[0];
      const parentContent =
        p != null && typeof p === "object" && typeof p.content === "string"
          ? p.content
          : null;
      if (parentContent !== null) {
        let overlap = 0;
        try {
          overlap = tokenSetJaccard(content, parentContent);
        } catch {
          overlap = 0;
        }
        if (overlap > TRIGGER_CAPS.PARAPHRASE_OVERLAP_THRESHOLD) {
          return {
            emit: false,
            reason: "pure_paraphrase",
            advisory_score: overlap,
          };
        }
      }
      // parents.length === 1 with no resolvable parent content — fall
      // through. The advisor cannot diagnose paraphrase without the parent
      // body; the W7 emitter has no equivalent check at the substrate tier
      // (the W8 handler tier does, see distill-emit-reconstructed.js
      // classifier hook). We bias toward "emit" since the agent has
      // already committed to a parent set with confidence ≥ floor.
    }

    // ---- Gate 3: near-duplicate of an existing reconstructed row ----
    // We scan the ledger inside the {conversation_id, parent_set_hash}
    // idempotency domain — the same domain the W7 emitter's S4 key
    // collapses to. If any prior reconstructed row's content is within
    // NEAR_DUP_THRESHOLD of the candidate, the W7 emitter's R8
    // idempotency would mostly catch it; the advisor saves the round-trip.
    //
    // Defensive try/catch around the cross-module read so a torn ledger
    // file or a transient I/O failure degrades to "no near-dup observed"
    // rather than aborting the advisor.
    let parentIds;
    try {
      parentIds = parents.map((p) =>
        typeof p === "string" ? p : p != null && typeof p === "object" ? p.id : null,
      );
    } catch {
      parentIds = [];
    }
    if (parentIds.some((id) => typeof id !== "string" || id.length === 0)) {
      // Some parent has no resolvable id — we cannot compute the
      // parent_set_hash. Skip the near-dup gate but proceed to "ok".
      return { emit: true, reason: "ok_to_emit", advisory_score: confidence };
    }
    const parentSetH = parentSetHash(parentIds);

    let ledgerRows = [];
    if (typeof ledgerPath === "string" && ledgerPath.length > 0) {
      try {
        ledgerRows = scanLedgerLines(ledgerPath);
      } catch {
        // Defensive degradation. Cross-module I/O failure must not block
        // the advisor; we proceed as if the ledger had no near-dup match.
        ledgerRows = [];
      }
    }
    let candidates = [];
    try {
      candidates = findCandidatesInIdempotencyDomain(
        ledgerRows,
        conversationId === undefined ? null : conversationId,
        parentSetH,
      );
    } catch {
      candidates = [];
    }
    if (candidates.length > 0) {
      let bestOverlap = 0;
      for (const cand of candidates) {
        const candContent = typeof cand.content === "string" ? cand.content : "";
        if (candContent.length === 0) continue;
        let ov = 0;
        try {
          ov = tokenSetJaccard(content, candContent);
        } catch {
          ov = 0;
        }
        if (ov > bestOverlap) bestOverlap = ov;
      }
      if (bestOverlap > TRIGGER_CAPS.NEAR_DUP_THRESHOLD) {
        return {
          emit: false,
          reason: "near_duplicate_exists",
          advisory_score: bestOverlap,
        };
      }
    }

    // ---- All gates passed → emit recommended. ----
    // advisory_score is the agent's self-reported confidence — the
    // integration tier can plumb this into dashboards as "advisor
    // confidence at acceptance" without needing a separate field.
    return {
      emit: true,
      reason: "ok_to_emit",
      advisory_score: confidence,
    };
  } catch {
    // Defensive degradation barrier. Any uncaught throw → conservative
    // {emit:false} result. The integration tier should NOT distinguish
    // "advisor said no" from "advisor errored" without inspecting `reason`.
    return { emit: false, reason: "advisor_error", advisory_score: 0 };
  }
}

// ---------------------------------------------------------------------------
// TEST-ONLY EXPORTS — surfaced for the substrate test suite so the internal
// helpers can be unit-tested without invoking the full advisor path. Not
// part of the public contract.
// ---------------------------------------------------------------------------

export const __internal = Object.freeze({
  tokenize,
  tokenSetJaccard,
  scanLedgerLines,
  parentSetHash,
  findCandidatesInIdempotencyDomain,
});
