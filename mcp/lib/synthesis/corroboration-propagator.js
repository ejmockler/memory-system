// corroboration-propagator.js — Wave 12 BEHAVIOR tier.
// (F-SYN-BEHAVIOR-corroboration-propagation)
//
// Authoritative spec:
//   - docs/specs/synthesis/derivation-propagation.md
//     § 4.3 (forward propagation), § 4.4 (STOP-AT-EVIDENCE), § 4.5 (caps).
//   - docs/specs/synthesis/recall-log-split.md § 4.7.2.C
//     (engagement_inherited envelope — produced by the engagement detector;
//     this module is the RANK-TIME complement: read the graph forward, not
//     the substrate's inherited-signal log).
//
// MISSION
//   A memory_id with corroborating descendants (reconstructed events that
//   derive FROM it) is more reliable than an isolated leaf. At rank time
//   we boost such memories proportionally to descendant count, capped at
//   MAX_BOOST so a high-fanout root cannot dominate.
//
//   The complement of damping-reader: damping-reader pulls per-row signals
//   off the damping log; this module reads the static derivation graph
//   structure. Together they feed two independent scalars to
//   multi-feature-score.computeScore.
//
// DIRECTIONAL INTERFACE (mutual-cycle closure with damping-reader):
//   corroboration-propagator → ranking.  Reads forwardAdj from
//                                         derivation-graph; emits a bounded
//                                         scalar to multi-feature-score.
//   corroboration-propagator does NOT read the damping log; damping-reader
//   owns that. Both feed multi-feature-score independently.
//   Resolves the W4/W12 mutual-cycle "F-SYN-BEHAVIOR-corroboration ↔
//   F-SYN-BEHAVIOR-damping-from-recall-log" islanding.
//
// CONTRACT
//   computeCorroborationBoost({memory_id, derivationGraph})
//     → number ∈ [BASE, MAX_BOOST]
//
//   - BASE = 1.0 (ranking-neutral; no descendants found)
//   - MAX_BOOST = 1.3 (cap to prevent positive-feedback dominance)
//
//   The walk is BFS forward through derivationGraph.forwardAdj, traversing
//   children-of-children up to MAX_HOPS. We count UNIQUE descendant ids;
//   the boost is min(BASE + count * BOOST_PER_DESCENDANT, MAX_BOOST).
//
//   Note on direction: derivation-graph stores forwardAdj as child → parent
//   (a reconstructed child points at the facts it derives FROM). To find
//   CORROBORATING DESCENDANTS of memory_id m (i.e. reconstructed events
//   that name m in their derived_from[]) we walk reverseAdj: m → children.
//   The producer-side BFS in F-SYN-BEHAVIOR-corroboration-propagation uses
//   forwardAdj to walk from a reconstructed UP to its parents; this
//   ranking-side function does the opposite: from a candidate DOWN to its
//   reconstructed corroborators. Different walks, different goals, same
//   underlying graph. We accept both naming forms defensively.
//
// DEFENSIVE DEGRADATION
//   Any null/missing graph → return BASE (1.0). The scorer's hot path is
//   NEVER blocked. Pure function; no I/O.

/** Module version. Bump on any structural change. */
export const CORROBORATION_PROPAGATOR_VERSION = "v0.1.0";

/** Frozen CAPS for the corroboration boost computation. Values are v0
 *  tunables; calibration owns the version-bump path. Consumers MUST import
 *  these by name; inline literals are forbidden. */
export const CORROBORATION_CAPS = Object.freeze({
  BASE: 1.0,
  BOOST_PER_DESCENDANT: 0.05,
  MAX_BOOST: 1.3,
  MAX_HOPS: 2,
});

/**
 * Resolve the "walk-down-to-descendants" adjacency from the graph object.
 * The derivation-graph substrate's reverseAdj is parent → children (used
 * by EXCISE channel); that's the direction we want here. If the caller
 * passes a graph that only has forwardAdj (legacy), fall back to that
 * defensively — it will produce a different walk but still bounded.
 */
function descendantsAdj(graph) {
  if (graph == null || typeof graph !== "object") return null;
  if (graph.reverseAdj instanceof Map) return graph.reverseAdj;
  if (graph.forwardAdj instanceof Map) return graph.forwardAdj;
  return null;
}

/**
 * Count unique descendants of `rootId` via BFS over `adj`, up to MAX_HOPS.
 * Returns 0 if root has no children. Cycles defended via a visited Set.
 */
function countDescendants(adj, rootId) {
  if (!(adj instanceof Map)) return 0;
  if (typeof rootId !== "string" || rootId.length === 0) return 0;

  const visited = new Set();
  visited.add(rootId);

  // BFS queue of {id, depth}. The root sits at depth=0 and is NOT counted.
  const queue = [{ id: rootId, depth: 0 }];
  let count = 0;

  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    if (depth >= CORROBORATION_CAPS.MAX_HOPS) continue;
    const children = adj.get(id);
    if (children == null) continue;
    for (const childId of children) {
      if (typeof childId !== "string" || childId.length === 0) continue;
      if (visited.has(childId)) continue;
      visited.add(childId);
      count++;
      queue.push({ id: childId, depth: depth + 1 });
    }
  }
  return count;
}

/**
 * Compute the corroboration boost for a single candidate memory_id.
 *
 * @param {object} args
 * @param {string} args.memory_id           — candidate under score.
 * @param {object} args.derivationGraph     — output of
 *                                            loadOrRebuildDerivationGraph();
 *                                            we read .reverseAdj (preferred)
 *                                            or .forwardAdj (defensive
 *                                            fallback).
 * @returns {number} corroboration boost ∈ [BASE, MAX_BOOST].
 */
export function computeCorroborationBoost({
  memory_id,
  derivationGraph,
} = {}) {
  // Defensive null-graph degradation. The pure-function contract means we
  // NEVER throw; the scorer's hot path keeps going.
  if (typeof memory_id !== "string" || memory_id === "") {
    return CORROBORATION_CAPS.BASE;
  }
  const adj = descendantsAdj(derivationGraph);
  if (adj == null) {
    return CORROBORATION_CAPS.BASE;
  }

  let count;
  try {
    count = countDescendants(adj, memory_id);
  } catch {
    return CORROBORATION_CAPS.BASE;
  }
  if (!Number.isFinite(count) || count <= 0) {
    return CORROBORATION_CAPS.BASE;
  }

  const raw =
    CORROBORATION_CAPS.BASE + count * CORROBORATION_CAPS.BOOST_PER_DESCENDANT;
  if (raw >= CORROBORATION_CAPS.MAX_BOOST) return CORROBORATION_CAPS.MAX_BOOST;
  if (raw <= CORROBORATION_CAPS.BASE) return CORROBORATION_CAPS.BASE;
  return raw;
}
