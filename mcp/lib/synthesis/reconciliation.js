// reconciliation.js — F-SYN-FOUNDATION-reconciliation-policy-spec RUNTIME.
//
// Spec authority: docs/specs/synthesis/reconciliation-policy.md (W10).
//
// CONTRACT (public exports):
//   - RECONCILIATION_VERSION                         module version pin
//   - RECONCILE_CAPS                                 frozen knob set (I10)
//   - detectContradictions({ newReconstruction,      D1-D4 detector cascade
//                            parents,
//                            ledgerPath,
//                            derivationGraph? })
//   - chooseResolution({ newReconstruction,          R1-R3 decision algorithm
//                        contradicting,
//                        parentLedgerRows })
//   - emitReconciliationPolicy({ decision,           builds the audit policy
//                                newEventId,         payload (system-driven
//                                contradictingEventIds }) reconcile.* event)
//
// I1 / I10 discipline:
//   - The detector + chooser live in THIS module only. The single caller is
//     `reconstruction-emitter.js` (the W7 emitter). Any other file referencing
//     `detectContradictions` or `chooseResolution` is a conformance failure.
//   - Numeric thresholds live ONLY in RECONCILE_CAPS. No magic literals in
//     the function bodies.
//
// Performance posture (spec § D6):
//   - O(parents.length) parent-direct test (D2).
//   - O(parent_children) cap-bounded walk (D1) at RECONCILE_PARENT_CHILDREN_MAX.
//   - O(entities × parents) entity-intersection (cheap).
//   - O(embedding_dim) cosine when both rows carry embeddings.
//
// Failure mode (spec § D5 / hot-path defensive degradation):
//   - Ledger read failure → return {contradicting:[], detection_evidence:{
//     reason:"ledger_unreadable", code:"DETECT_LEDGER_UNREADABLE"}}. The emitter
//     interprets this as fail-open per the W7 hard-gate posture.
//   - Detection budget exceeded (D1 cap blown) → return a sentinel-decorated
//     detection_evidence with code "DETECTION_BUDGET_EXCEEDED" so the emitter
//     can stamp the sentinel ["__detection_budget_exceeded__"] (spec § I8).
//
// ESM imports (W2-W13 style).

import { streamLedgerLines } from "./_ledger-stream.js";

export const RECONCILIATION_VERSION = "v0.1.0";

/** All numeric knobs for the runtime — single source of truth (I10).
 *  Values mirror the spec defaults (S3). Calibration via O1 deferred. */
export const RECONCILE_CAPS = Object.freeze({
  // D1 parent-children walk cap. (Spec S3.)
  RECONCILE_PARENT_CHILDREN_MAX: 32,
  // Re-aliased default for backward-compat with the task wiring that names this
  // CONTRADICTION_OVERLAP_THRESHOLD (entity-intersection score floor before we
  // declare a contradiction in the entity-only fallback). 0.3 ≅ "at least
  // ~30% of the new row's entities overlap a candidate's entities". The spec
  // uses entity-overlap > 0 as the cheap filter; we lift it to 0.3 for the
  // valence-fallback path to keep noise out.
  CONTRADICTION_OVERLAP_THRESHOLD: 0.3,
  // D3 Test 1 — valence magnitude floor (spec RECONCILE_VALENCE_MAGNITUDE_GATE).
  VALENCE_OPPOSITION_THRESHOLD: 0.4,
  // D3 Test 2 — cosine negative gate (spec RECONCILE_COSINE_ADVERSARY_GATE).
  COSINE_ADVERSARY_THRESHOLD: -0.05,
  // R2 — confidence delta floor for SUBSTITUTE (task wiring renames the spec's
  // RECONCILE_SUBSTITUTE_CONFIDENCE_DELTA to CONFIDENCE_DELTA_FOR_SUBSTITUTE
  // and softens it from 0.15 to 0.2 for the v0 ship). The spec calibrates via
  // O1 either way; we honor the task wiring.
  CONFIDENCE_DELTA_FOR_SUBSTITUTE: 0.2,
  // D4 authority-policy confidence floor (spec RECONCILE_AUTHORITY_CONFIDENCE_GATE).
  AUTHORITY_CONFIDENCE_GATE: 0.85,
});

// ---------------------------------------------------------------------------
// INTERNAL — ledger reading (defensive)
// ---------------------------------------------------------------------------

/** scanLedgerWithStatus — s2-reconciliation-latent.
 *
 *  INCIDENT CLASS (why this is streamed):
 *    The original body slurped the ENTIRE memory.jsonl into one JS string.
 *    Node/V8 caps a single string at 536,870,888 bytes; the live ledger is
 *    ~3.05 GB, so that read throws ERR_STRING_TOO_LONG — and the bare
 *    `catch { return []; }` around it turned an UNREADABLE ledger into an
 *    EMPTY one. This module was the last holdout of that class in
 *    lib/synthesis/ (derivation-graph.js, drift-detector.js,
 *    coverage-probe.js and reconstruction-emitter.js were migrated to
 *    _ledger-stream.js earlier).
 *
 *  THIS WAS LATENT, NOT A LIVE OUTAGE — do not mis-narrate it. The single
 *  production caller supplies a derivationGraph whose `byId` is a Map on
 *  BOTH of its dispatch branches (reconstruction-emitter.js:1310-1313,
 *  commit 8c991806, 2026-07-08), and detectContradictions short-circuits on
 *  that Map before it ever reaches this path. No cascade tick has been
 *  scanning a zero-row ledger; the landmine was armed but never stepped on.
 *
 *  WHAT WAS ACTUALLY BROKEN (size-independent): the module's declared
 *  `DETECT_LEDGER_UNREADABLE` code (see header, and the @returns union on
 *  detectContradictions) was UNREACHABLE. The scan could not report a
 *  failure, so `ledgerOk` never went false and the unreadable branch was
 *  dead code. Returning `readError` here is what makes that contract real.
 *
 *  Two conflations are now classified apart by _ledger-stream.js:118-127
 *  (B1c3) via the openSync errno rather than by an existence probe:
 *    - ENOENT (genuinely missing ledger) → readError null → stays benign.
 *    - EACCES / ELOOP / ENOTDIR / mid-stream read failure → readError set.
 *      An existence probe reports FALSE for a file behind an unreadable
 *      parent directory, which is precisely how an existing-but-unreadable
 *      ledger used to masquerade as an empty one.
 *
 *  Per-line JSON parse failures (the torn tail a mid-append daemon always
 *  leaves) stay silently skipped inside the streamer — unchanged.
 *
 *  @returns {{ rows: object[], readError: string|null }}
 */
function scanLedgerWithStatus(ledgerPath) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    return { rows: [], readError: null };
  }
  const out = [];
  // streamLedgerLines never throws; fs failures surface on counts.readError.
  // No maxLineBytes override — inherit the 8 MiB default so behavior matches
  // the sibling scan at reconstruction-emitter.js scanLedgerLines. No row cap
  // and no reordering: findAuthorityContradictions iterates in ledger order
  // and authority_hits[0] is order-sensitive.
  const counts = streamLedgerLines(ledgerPath, (row) => {
    out.push(row);
  });
  return { rows: out, readError: counts.readError ?? null };
}

/** Read the ledger as a list of parsed rows. Defensive: never throws; a
 *  read failure yields []. Callers that must distinguish "empty" from
 *  "unreadable" use scanLedgerWithStatus directly. */
function scanLedger(ledgerPath) {
  return scanLedgerWithStatus(ledgerPath).rows;
}

// ---------------------------------------------------------------------------
// INTERNAL — entity overlap (D2 cheap filter)
// ---------------------------------------------------------------------------

/** Pull a Set of entity tokens (slug-ish strings) off of a row's features.
 *  Returns an empty Set if the row has no entities (degrades gracefully). */
function entityTokens(row) {
  const tokens = new Set();
  if (row == null || typeof row !== "object") return tokens;
  const features = row.features;
  if (features == null || typeof features !== "object") return tokens;
  const entities = Array.isArray(features.entities) ? features.entities : [];
  for (const ent of entities) {
    if (ent == null) continue;
    if (typeof ent === "string" && ent.length > 0) {
      tokens.add(ent);
      continue;
    }
    if (typeof ent === "object") {
      // Common shapes: { canonical_id }, { slug }, { surface }
      if (typeof ent.canonical_id === "string" && ent.canonical_id.length > 0) {
        tokens.add(ent.canonical_id);
        continue;
      }
      if (typeof ent.slug === "string" && ent.slug.length > 0) {
        tokens.add(ent.slug);
        continue;
      }
      if (typeof ent.surface === "string" && ent.surface.length > 0) {
        tokens.add(ent.surface.toLowerCase());
      }
    }
  }
  return tokens;
}

/** Compute entity overlap ratio = |A ∩ B| / max(|A|, 1). Asymmetric in A's
 *  favor — the new row's entity coverage drives the threshold (so we don't
 *  flag a huge parent that happens to mention a single new-row entity). */
function entityOverlapRatio(a, b) {
  if (a.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / a.size;
}

// ---------------------------------------------------------------------------
// INTERNAL — valence opposition (D3 Test 1)
// ---------------------------------------------------------------------------

/** Extract a {sign, magnitude} valence summary from either a row's features or
 *  a free-standing valence object. Returns null if absent or malformed.
 *
 *  The reconstructed kind does NOT carry valence on its on-disk shape (per
 *  reconstructed-trigger.md A2), but the proposed `newReconstruction.features`
 *  in the detector path MAY carry a transient valence used only for the
 *  contradiction test (the emitter computes it during extractFeatures and can
 *  pass it forward). The fact kind carries valence directly in features. */
function valenceOf(row) {
  if (row == null || typeof row !== "object") return null;
  const direct = row.valence;
  if (direct && typeof direct === "object") {
    const v = normalizeValence(direct);
    if (v) return v;
  }
  const features = row.features;
  if (features == null || typeof features !== "object") return null;
  if (features.valence && typeof features.valence === "object") {
    return normalizeValence(features.valence);
  }
  if (typeof features.valence_sign === "string") {
    const mag = typeof features.valence_magnitude === "number" ? features.valence_magnitude : 0;
    return normalizeValence({ sign: features.valence_sign, magnitude: mag });
  }
  return null;
}

function normalizeValence(v) {
  if (v == null || typeof v !== "object") return null;
  let sign = v.sign;
  if (typeof sign === "number") {
    sign = sign > 0 ? "+" : sign < 0 ? "-" : "0";
  }
  if (sign !== "+" && sign !== "-" && sign !== "0") return null;
  const magnitude = typeof v.magnitude === "number" && Number.isFinite(v.magnitude)
    ? Math.max(0, Math.min(1, v.magnitude))
    : 0;
  return { sign, magnitude };
}

/** D3 Test 1 — valence-sign mismatch above magnitude gate. Returns
 *  { fired:boolean, score:number } where score is signed magnitude delta. */
function valenceContradiction(newV, candV) {
  if (newV == null || candV == null) return { fired: false, score: 0 };
  if (newV.sign === candV.sign) return { fired: false, score: 0 };
  // Opposing signs (+ vs -, or +/- vs 0): require the OPPONENT'S magnitude to
  // exceed the floor — a neutral candidate vs a strongly-positive new row
  // is still "opposing", but only if both carry enough magnitude that the
  // opposition is meaningful.
  const opposingMag = Math.max(Math.abs(newV.magnitude), Math.abs(candV.magnitude));
  if (opposingMag < RECONCILE_CAPS.VALENCE_OPPOSITION_THRESHOLD) {
    return { fired: false, score: opposingMag };
  }
  return { fired: true, score: opposingMag };
}

// ---------------------------------------------------------------------------
// INTERNAL — cosine (D3 Test 2)
// ---------------------------------------------------------------------------

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const n = Math.min(a.length, b.length);
  if (n === 0) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (typeof x !== "number" || typeof y !== "number") return null;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function embeddingOf(row) {
  if (row == null || typeof row !== "object") return null;
  if (Array.isArray(row.embedding)) return row.embedding;
  const features = row.features;
  if (features == null || typeof features !== "object") return null;
  if (Array.isArray(features.embedding)) return features.embedding;
  return null;
}

/** D3 Test 2 — negative-cosine adversary. */
function cosineContradiction(newRow, candRow) {
  const a = embeddingOf(newRow);
  const b = embeddingOf(candRow);
  if (a == null || b == null) return { fired: false, score: null };
  const c = cosine(a, b);
  if (c == null) return { fired: false, score: null };
  if (c < RECONCILE_CAPS.COSINE_ADVERSARY_THRESHOLD) {
    return { fired: true, score: c };
  }
  return { fired: false, score: c };
}

// ---------------------------------------------------------------------------
// INTERNAL — D4 authority-policy check
// ---------------------------------------------------------------------------

/** Walk ledger rows looking for active policy.exclude / policy.fact_excluded
 *  events whose advertised confidence exceeds the authority gate AND whose
 *  predicate (here approximated by entity intersection ≥ overlap threshold)
 *  matches the proposed reconstruction.
 *
 *  This is a v0 surrogate for the spec's
 *  `mcp/lib/recall/predicate-match.js evaluator` reference — that module is
 *  not yet implemented; the runtime falls back to entity-overlap-as-predicate
 *  so the HARD_AUTHORITY pattern is testable today. When predicate-match.js
 *  lands the call site swaps to it without changing the public surface. */
function findAuthorityContradictions(newRow, newEntities, ledgerRows) {
  const hits = [];
  if (!Array.isArray(ledgerRows) || ledgerRows.length === 0) return hits;
  for (const row of ledgerRows) {
    if (row == null || typeof row !== "object") continue;
    if (row.kind !== "policy") continue;
    if (row.rescinded_at != null) continue;
    if (row.silent === true) continue;
    if (row.active_inline === false) continue;
    const pk = row.policy_kind;
    if (typeof pk !== "string") continue;
    const isExclude = pk === "exclude" || pk === "fact_excluded";
    if (!isExclude) continue;
    const conf = typeof row.confidence === "number"
      ? row.confidence
      : (row.payload && typeof row.payload.confidence === "number"
        ? row.payload.confidence
        : null);
    if (conf == null) continue;
    if (conf < RECONCILE_CAPS.AUTHORITY_CONFIDENCE_GATE) continue;
    // Predicate-match surrogate: entity-overlap-as-predicate.
    const candEntities = entityTokens(row);
    if (candEntities.size === 0) {
      // The policy row may have its predicate's context_entities[] attached
      // elsewhere on the row (under predicate.context_entities); try that.
      const pred = row.predicate;
      if (pred && Array.isArray(pred.context_entities)) {
        for (const e of pred.context_entities) {
          if (typeof e === "string") candEntities.add(e);
        }
      }
    }
    const overlap = entityOverlapRatio(newEntities, candEntities);
    if (overlap >= RECONCILE_CAPS.CONTRADICTION_OVERLAP_THRESHOLD) {
      hits.push({
        candidate_id: row.id,
        test_fired: "test_3_authority_policy_match",
        score: conf,
        overlap,
      });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// INTERNAL — D1 parent-children walk
// ---------------------------------------------------------------------------

/** Build a Map<parentId, Set<childId>> over reconstructed rows' derived_from
 *  edges. Used by D1 to enumerate the candidate adversaries. */
function buildReverseAdj(rows) {
  const reverseAdj = new Map();
  for (const row of rows) {
    if (row == null || typeof row !== "object") continue;
    const id = row.id;
    if (typeof id !== "string" || id.length === 0) continue;
    if (row.kind !== "reconstructed") continue;
    const parents = Array.isArray(row.derived_from) ? row.derived_from : [];
    for (const parentId of parents) {
      if (typeof parentId !== "string" || parentId.length === 0) continue;
      let s = reverseAdj.get(parentId);
      if (s === undefined) {
        s = new Set();
        reverseAdj.set(parentId, s);
      }
      s.add(id);
    }
  }
  return reverseAdj;
}

// ---------------------------------------------------------------------------
// PUBLIC — detectContradictions (D1–D4)
// ---------------------------------------------------------------------------

/** Detect contradictions for a proposed reconstructed emission.
 *
 *  @param {object} arg
 *    - newReconstruction: { id?, content, features?, valence?, confidence?,
 *                           embedding?, provenance? }
 *    - parents: string[]                           parent ids
 *    - ledgerPath: string                          path to memory.jsonl
 *    - derivationGraph?: { reverseAdj: Map<parentId, Set<childId>>,
 *                          byId: Map<id, row> }    optional; if absent the
 *                                                  detector STREAMS ledgerPath
 *                                                  line-by-line via
 *                                                  _ledger-stream.js (never a
 *                                                  whole-file string — see the
 *                                                  scanLedgerWithStatus note).
 *                                                  The live emitter always
 *                                                  passes this Map, so the
 *                                                  fallback is the cold path.
 *
 *  @returns {Promise<{
 *    contradicting: string[],                      memory_ids that contradict
 *    detection_evidence: {
 *      code: "OK" | "DETECTION_BUDGET_EXCEEDED"
 *           | "DETECT_LEDGER_UNREADABLE",       // carries reason:"ledger_unreadable";
 *                                               // fires on any non-ENOENT read
 *                                               // error, including a partial read
 *      reason?: "ledger_unreadable",
 *      authority_hits: Array<{candidate_id, test_fired, score}>,
 *      sibling_hits: Array<{candidate_id, test_fired, score}>,
 *      parent_hits: Array<{candidate_id, test_fired, score}>,
 *      intra_conv_refinement_candidates: string[], // D1 step 3 skip-list (R2 fuel)
 *      visited_children_count: number,
 *      budget_exceeded: boolean
 *    }
 *  }>}
 */
export async function detectContradictions({
  newReconstruction,
  parents,
  ledgerPath,
  derivationGraph,
} = {}) {
  // Defensive shape gate — never throw past the API boundary.
  if (newReconstruction == null || typeof newReconstruction !== "object") {
    return {
      contradicting: [],
      detection_evidence: {
        code: "DETECT_BAD_INPUT",
        reason: "newReconstruction missing",
        authority_hits: [],
        sibling_hits: [],
        parent_hits: [],
        intra_conv_refinement_candidates: [],
        visited_children_count: 0,
        budget_exceeded: false,
      },
    };
  }
  const safeParents = Array.isArray(parents) ? parents.filter((p) => typeof p === "string" && p.length > 0) : [];

  // Load ledger rows. Prefer the caller's derivationGraph if supplied;
  // otherwise read from disk. Both code paths degrade gracefully on failure.
  let rows = [];
  let ledgerOk = true;
  if (derivationGraph && derivationGraph.byId instanceof Map) {
    rows = Array.from(derivationGraph.byId.values());
  } else {
    try {
      const scan = scanLedgerWithStatus(ledgerPath);
      rows = scan.rows;
      // ENOENT keeps readError null (missing ledger stays benign, code "OK").
      // Any other errno is an existing-but-unreadable ledger.
      if (scan.readError != null) ledgerOk = false;
    } catch {
      // Defense in depth — streamLedgerLines never throws, so the only path
      // here is an unexpected bug in the onRow accumulator.
      rows = [];
      ledgerOk = false;
    }
  }
  // Any read error is fatal to the verdict regardless of how many rows landed:
  // a PARTIALLY read ledger silently produces a WRONG answer, because a missing
  // authority `policy` row downgrades an exclude_rejected to co_exist. Rows
  // parsed before the failure are not a usable basis for a contradiction call.
  if (!ledgerOk) {
    return {
      contradicting: [],
      detection_evidence: {
        code: "DETECT_LEDGER_UNREADABLE",
        reason: "ledger_unreadable",
        authority_hits: [],
        sibling_hits: [],
        parent_hits: [],
        intra_conv_refinement_candidates: [],
        visited_children_count: 0,
        budget_exceeded: false,
      },
    };
  }

  const byId = new Map();
  for (const row of rows) {
    if (row && typeof row.id === "string") byId.set(row.id, row);
  }
  const reverseAdj = (derivationGraph && derivationGraph.reverseAdj instanceof Map)
    ? derivationGraph.reverseAdj
    : buildReverseAdj(rows);

  const newEntities = entityTokens(newReconstruction);
  const newConv = newReconstruction.provenance && typeof newReconstruction.provenance.conversation_id === "string"
    ? newReconstruction.provenance.conversation_id
    : (typeof newReconstruction.conversation_id === "string" ? newReconstruction.conversation_id : null);

  // D4 — authority-policy walk (run first so R1 can short-circuit cleanly).
  let authorityHits = [];
  try {
    authorityHits = findAuthorityContradictions(newReconstruction, newEntities, rows);
  } catch {
    authorityHits = [];
  }

  // D2 — parent-direct test.
  const parentHits = [];
  for (const parentId of safeParents) {
    const parent = byId.get(parentId);
    if (parent == null) continue;
    try {
      const result = candidateContradicts(newReconstruction, newEntities, parent);
      if (result.fired) {
        parentHits.push({
          candidate_id: parentId,
          test_fired: result.test_fired,
          score: result.score,
        });
      }
    } catch {
      // defensive — skip this candidate
      continue;
    }
  }

  // D1 — sibling walk (one hop) bounded by RECONCILE_PARENT_CHILDREN_MAX.
  const siblingHits = [];
  const intraConvRefinementCandidates = [];
  let visited = 0;
  let budgetExceeded = false;
  const cap = RECONCILE_CAPS.RECONCILE_PARENT_CHILDREN_MAX;
  outer: for (const parentId of safeParents) {
    const children = reverseAdj.get(parentId);
    if (children == null) continue;
    for (const childId of children) {
      if (visited >= cap) {
        budgetExceeded = true;
        break outer;
      }
      visited += 1;
      if (typeof childId !== "string" || childId.length === 0) continue;
      const child = byId.get(childId);
      if (child == null) continue;
      if (child.kind !== "reconstructed") continue;
      const childConv = child.provenance && typeof child.provenance.conversation_id === "string"
        ? child.provenance.conversation_id
        : null;
      if (newConv != null && childConv === newConv) {
        // Spec D1 step 3 — intra-conversation refinement. Hold for R2.
        intraConvRefinementCandidates.push(childId);
        continue;
      }
      try {
        const result = candidateContradicts(newReconstruction, newEntities, child);
        if (result.fired) {
          siblingHits.push({
            candidate_id: childId,
            test_fired: result.test_fired,
            score: result.score,
          });
        }
      } catch {
        continue;
      }
    }
  }

  // Assemble contradicting[] union. Authority hits ALWAYS surface (so R1
  // can detect HARD_AUTHORITY). Sibling + parent hits surface for R2/R3.
  // Intra-conv refinement candidates are kept SEPARATE (R2 reads them).
  const contradictingSet = new Set();
  for (const h of authorityHits) contradictingSet.add(h.candidate_id);
  for (const h of siblingHits) contradictingSet.add(h.candidate_id);
  for (const h of parentHits) contradictingSet.add(h.candidate_id);

  return {
    contradicting: [...contradictingSet],
    detection_evidence: {
      code: budgetExceeded ? "DETECTION_BUDGET_EXCEEDED" : "OK",
      authority_hits: authorityHits,
      sibling_hits: siblingHits,
      parent_hits: parentHits,
      intra_conv_refinement_candidates: intraConvRefinementCandidates,
      visited_children_count: visited,
      budget_exceeded: budgetExceeded,
    },
  };
}

/** Per-candidate D3 test cascade. Returns {fired, test_fired, score}.
 *  Ordering: Test 1 (valence) → Test 2 (cosine). Test 3 (authority) is
 *  evaluated in findAuthorityContradictions and does not pass through here. */
function candidateContradicts(newRow, newEntities, candRow) {
  const candEntities = entityTokens(candRow);
  // Cheap filter — entity overlap MUST be >0 OR both sides MUST carry
  // embeddings (cosine can detect contradictions even without entity overlap
  // when the rows are semantically opposed prose).
  const overlap = entityOverlapRatio(newEntities, candEntities);
  const haveBothEmbeddings = embeddingOf(newRow) != null && embeddingOf(candRow) != null;
  if (overlap === 0 && !haveBothEmbeddings) {
    return { fired: false, test_fired: null, score: 0 };
  }
  // Test 1 — valence mismatch (requires both rows carry valence).
  const newV = valenceOf(newRow);
  const candV = valenceOf(candRow);
  if (newV != null && candV != null) {
    const r = valenceContradiction(newV, candV);
    if (r.fired && overlap >= RECONCILE_CAPS.CONTRADICTION_OVERLAP_THRESHOLD) {
      return { fired: true, test_fired: "test_1_valence_sign_mismatch", score: r.score };
    }
  }
  // Test 2 — cosine adversary.
  const c = cosineContradiction(newRow, candRow);
  if (c.fired) {
    return { fired: true, test_fired: "test_2_cosine_adversary", score: c.score };
  }
  return { fired: false, test_fired: null, score: 0 };
}

// ---------------------------------------------------------------------------
// PUBLIC — chooseResolution (R1-R3)
// ---------------------------------------------------------------------------

/** Choose ONE resolution pattern for a non-empty contradicting[] set.
 *
 *  @param {object} arg
 *    - newReconstruction: { content, confidence, scope, conversation_id?,
 *                           provenance?, agent_id? }
 *    - contradicting: string[]                          memory_ids
 *    - parentLedgerRows: object[]                       row lookup pool (rows
 *                                                       must include each id
 *                                                       in contradicting[])
 *    - detectionEvidence?: object                       optional shortcut into
 *                                                       authority + intra-conv
 *                                                       data from the detector
 *
 *  @returns "substitute" | "co_exist" | "exclude_rejected"
 */
export function chooseResolution({
  newReconstruction,
  contradicting,
  parentLedgerRows,
  detectionEvidence,
} = {}) {
  // Defensive defaults — never throw.
  const rows = Array.isArray(parentLedgerRows) ? parentLedgerRows : [];
  const ids = Array.isArray(contradicting) ? contradicting : [];

  // R1 — authority check FIRST.
  if (detectionEvidence && Array.isArray(detectionEvidence.authority_hits) && detectionEvidence.authority_hits.length > 0) {
    return "exclude_rejected";
  }
  // Defense-in-depth — also walk the rows for any matching authority policy
  // even if the caller forgot to thread detection_evidence through.
  for (const row of rows) {
    if (row == null || typeof row !== "object") continue;
    if (row.kind !== "policy") continue;
    if (row.rescinded_at != null) continue;
    const pk = row.policy_kind;
    if (pk !== "exclude" && pk !== "fact_excluded") continue;
    const conf = typeof row.confidence === "number"
      ? row.confidence
      : (row.payload && typeof row.payload.confidence === "number" ? row.payload.confidence : null);
    if (conf == null) continue;
    if (conf >= RECONCILE_CAPS.AUTHORITY_CONFIDENCE_GATE && ids.includes(row.id)) {
      return "exclude_rejected";
    }
  }

  // R2 — SUBSTITUTE gates (six conjunctive checks).
  // The task wiring's six gates:
  //   1. contradicting.length === 1
  //   2. superseded.kind === "reconstructed"
  //   3. confidence(new) - confidence(superseded) >= CONFIDENCE_DELTA_FOR_SUBSTITUTE
  //   4. conversation_id match
  //   5. scope match
  //   6. agent_id prefix match
  //
  // The detector's intra_conv_refinement_candidates feed into the same R2
  // logic — a single-element refinement set is treated as the implicit
  // contradicting[] for SUBSTITUTE purposes.
  let candidateIds = ids;
  if (
    candidateIds.length === 0 &&
    detectionEvidence &&
    Array.isArray(detectionEvidence.intra_conv_refinement_candidates) &&
    detectionEvidence.intra_conv_refinement_candidates.length > 0
  ) {
    candidateIds = detectionEvidence.intra_conv_refinement_candidates;
  }
  if (candidateIds.length !== 1) return "co_exist";

  const rowById = new Map();
  for (const r of rows) if (r && typeof r.id === "string") rowById.set(r.id, r);
  const superseded = rowById.get(candidateIds[0]);
  if (superseded == null) return "co_exist";
  if (superseded.kind !== "reconstructed") return "co_exist";

  const newConfidence = typeof newReconstruction.confidence === "number"
    ? newReconstruction.confidence
    : (newReconstruction.provenance && typeof newReconstruction.provenance.confidence === "number"
      ? newReconstruction.provenance.confidence
      : null);
  const supersededConfidence = superseded.provenance && typeof superseded.provenance.confidence === "number"
    ? superseded.provenance.confidence
    : null;
  if (newConfidence == null || supersededConfidence == null) return "co_exist";
  if ((newConfidence - supersededConfidence) < RECONCILE_CAPS.CONFIDENCE_DELTA_FOR_SUBSTITUTE) {
    return "co_exist";
  }

  const newConv = newReconstruction.provenance && typeof newReconstruction.provenance.conversation_id === "string"
    ? newReconstruction.provenance.conversation_id
    : (typeof newReconstruction.conversation_id === "string" ? newReconstruction.conversation_id : null);
  const supersededConv = superseded.provenance && typeof superseded.provenance.conversation_id === "string"
    ? superseded.provenance.conversation_id
    : null;
  if (newConv == null || supersededConv == null || newConv !== supersededConv) return "co_exist";

  const newScope = typeof newReconstruction.scope === "string" ? newReconstruction.scope : null;
  const supersededScope = typeof superseded.scope === "string" ? superseded.scope : null;
  if (newScope == null || newScope !== supersededScope) return "co_exist";

  const newAgent = newReconstruction.provenance && typeof newReconstruction.provenance.agent_id === "string"
    ? newReconstruction.provenance.agent_id
    : (typeof newReconstruction.agent_id === "string" ? newReconstruction.agent_id : null);
  const supersededAgent = superseded.provenance && typeof superseded.provenance.agent_id === "string"
    ? superseded.provenance.agent_id
    : null;
  if (newAgent == null || supersededAgent == null) return "co_exist";
  const newPrefix = newAgent.split(":")[0];
  const supersededPrefix = supersededAgent.split(":")[0];
  if (newPrefix !== supersededPrefix) return "co_exist";

  return "substitute";
}

// ---------------------------------------------------------------------------
// PUBLIC — emitReconciliationPolicy (S4 / S5 / S6 payload builders)
// ---------------------------------------------------------------------------

/** Build the audit-policy payload for the chosen pattern.
 *
 *  Returns a plain object ready to be appended to the ledger as a `policy`
 *  row. The caller (reconstruction-emitter.js) stamps id, ts, applied_at,
 *  rescinded_at:null, and any scope fields per the ledger conventions.
 *
 *  @param {object} arg
 *    - decision: "substitute" | "co_exist" | "exclude_rejected"
 *    - newEventId: string                              // pending reconstructed id
 *    - contradictingEventIds: string[]
 *    - detectionEvidence?: object                      // optional metric trail
 *    - authorityPolicyId?: string                      // EXCLUDE_REJECTED only
 *    - contentHash?: string                            // EXCLUDE_REJECTED only
 *    - agentId?: string                                // EXCLUDE_REJECTED only
 *
 *  @returns object                                     // policy event payload
 */
export function emitReconciliationPolicy({
  decision,
  newEventId,
  contradictingEventIds,
  detectionEvidence,
  authorityPolicyId,
  contentHash,
  agentId,
} = {}) {
  const ids = Array.isArray(contradictingEventIds) ? contradictingEventIds.filter((s) => typeof s === "string") : [];
  if (decision === "substitute") {
    const supersededId = ids[0] || null;
    const metric = detectionEvidence
      && Array.isArray(detectionEvidence.sibling_hits)
      && detectionEvidence.sibling_hits.find((h) => h.candidate_id === supersededId);
    const testFired = metric ? metric.test_fired : "test_2_cosine_adversary";
    const detectedScore = metric ? metric.score : 0;
    return {
      kind: "policy",
      policy_kind: "reconcile.substitute",
      scope: null,
      targets: [newEventId, supersededId].filter((s) => typeof s === "string"),
      payload: {
        superseder: newEventId,
        superseded: supersededId,
        criteria: {
          test_fired: testFired,
          // Operator-introspection criteria; the runtime evaluator stamps
          // booleans true here because by reaching SUBSTITUTE all gates pass.
          scope_match: true,
          conversation_id_match: true,
          agent_id_prefix_match: true,
        },
        detected_contradiction_score: detectedScore,
        runtime_version: RECONCILIATION_VERSION,
      },
      rescinded_at: null,
    };
  }
  if (decision === "co_exist") {
    return {
      kind: "policy",
      policy_kind: "reconcile.co_exist",
      scope: null,
      targets: [newEventId, ...ids],
      payload: {
        cluster_id: stableClusterId([newEventId, ...ids]),
        detection_metrics: detectionEvidence
          ? mergeDetectionMetrics(detectionEvidence)
          : [],
        criteria_for_substitute_failed: detectionEvidence && detectionEvidence.budget_exceeded
          ? ["detection_budget_exceeded"]
          : ["substitute_gates_unmet"],
        criteria_for_exclude_rejected_failed: ["no_authority_policy_match"],
        runtime_version: RECONCILIATION_VERSION,
      },
      rescinded_at: null,
    };
  }
  if (decision === "exclude_rejected") {
    const authHit = detectionEvidence
      && Array.isArray(detectionEvidence.authority_hits)
      && detectionEvidence.authority_hits[0];
    return {
      kind: "policy",
      policy_kind: "reconcile.exclude_rejected",
      scope: null,
      targets: [
        contentHash || null,
        authorityPolicyId || (authHit ? authHit.candidate_id : null),
      ].filter((s) => typeof s === "string"),
      payload: {
        content_hash: contentHash || null,
        authority_policy_id: authorityPolicyId || (authHit ? authHit.candidate_id : null),
        authority_predicate_match_score: authHit ? authHit.score : null,
        agent_id: agentId || null,
        rejected_at_step: "emit_reconstruction.detector",
        runtime_version: RECONCILIATION_VERSION,
      },
      rescinded_at: null,
    };
  }
  // Unknown decision — return a sentinel payload so the caller can audit it.
  return {
    kind: "policy",
    policy_kind: "reconcile.unknown",
    scope: null,
    targets: [newEventId, ...ids],
    payload: {
      reason: `unknown decision ${String(decision)}`,
      runtime_version: RECONCILIATION_VERSION,
    },
    rescinded_at: null,
  };
}

function mergeDetectionMetrics(evidence) {
  const out = [];
  if (Array.isArray(evidence.sibling_hits)) {
    for (const h of evidence.sibling_hits) out.push({ ...h });
  }
  if (Array.isArray(evidence.parent_hits)) {
    for (const h of evidence.parent_hits) out.push({ ...h });
  }
  if (Array.isArray(evidence.authority_hits)) {
    for (const h of evidence.authority_hits) out.push({ ...h });
  }
  return out;
}

function stableClusterId(ids) {
  // Stable string from a sorted, deduped id set. The on-disk shape uses a
  // sha256 over this — we keep the cheap surrogate here so a missing hash
  // module does not block the policy emission. The audit row's downstream
  // consumers can canonicalize later if needed.
  const dedup = [...new Set(ids.filter((s) => typeof s === "string"))].sort();
  return "cluster:" + dedup.join("|");
}

// ---------------------------------------------------------------------------
// TEST-ONLY internal surface
// ---------------------------------------------------------------------------

export const __internal = Object.freeze({
  scanLedger,
  entityTokens,
  entityOverlapRatio,
  valenceOf,
  valenceContradiction,
  cosine,
  cosineContradiction,
  candidateContradicts,
  findAuthorityContradictions,
  buildReverseAdj,
});
