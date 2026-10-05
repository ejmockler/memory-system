// recent-surfaced-damping.js — honor surrounding_context.recent_recall_ids.
//
// kb/mcp-surface.md § memory_recall declares the field "for damping". Until
// this module the handler validated it and read it nowhere: an agent that
// ran four facet recalls in one session got the same top memory back in
// three of them (measured 2026-09-09 — the Examplewave interview email).
//
// Contract:
//   - collectRecentlySurfacedIds(recentRecallIds, lookup) resolves each
//     recall_id through the in-process recall log (recall-log.js
//     lookupRecall — TTL-enforced, process-local) and unions the
//     surfaced_memory_ids the handler stamped on the entry. Unknown / expired
//     / pre-stamp entries contribute nothing. Never throws.
//   - applyRecentSurfacedDamping(scored, surfacedIds, factor) multiplies
//     score_components.final_score by `factor` for every scored entry whose
//     memory_id is in the set, records the pre-damping score and the factor
//     on score_components (so the recall event stays reconstructable), and
//     re-sorts by the handler's ordering (final_score desc, memory_id asc).
//     factor >= 1 or an empty set is a byte-identical pass-through.
//
// This is DAMPING, not paging (the spec rejects paging): a memory the agent
// was just shown has to out-score fresh candidates by 1/factor to reappear.

export function collectRecentlySurfacedIds(recentRecallIds, lookup) {
  const out = new Set();
  if (!Array.isArray(recentRecallIds) || typeof lookup !== "function") return out;
  for (const rid of recentRecallIds) {
    if (typeof rid !== "string" || rid.length === 0) continue;
    let entry = null;
    try {
      entry = lookup(rid);
    } catch {
      entry = null;
    }
    const ids = entry && Array.isArray(entry.surfaced_memory_ids)
      ? entry.surfaced_memory_ids
      : [];
    for (const id of ids) {
      if (typeof id === "string" && id.length > 0) out.add(id);
    }
  }
  return out;
}

export function applyRecentSurfacedDamping(scored, surfacedIds, factor) {
  if (!Array.isArray(scored)) return { scored: [], dampedCount: 0 };
  const f = typeof factor === "number" && Number.isFinite(factor) ? factor : 1;
  if (!(surfacedIds instanceof Set) || surfacedIds.size === 0 || f >= 1) {
    return { scored, dampedCount: 0 };
  }
  let dampedCount = 0;
  for (const s of scored) {
    const id = s && s.candidate ? s.candidate.memory_id : null;
    if (id == null || !surfacedIds.has(id)) continue;
    const sc = s.score_components;
    if (!sc || typeof sc.final_score !== "number") continue;
    sc.final_score_pre_damping = sc.final_score;
    sc.recent_surfaced_damping_factor = f;
    sc.final_score = sc.final_score * f;
    dampedCount += 1;
  }
  if (dampedCount === 0) return { scored, dampedCount: 0 };
  const resorted = scored.slice().sort((a, b) => {
    if (b.score_components.final_score !== a.score_components.final_score) {
      return b.score_components.final_score - a.score_components.final_score;
    }
    return a.candidate.memory_id < b.candidate.memory_id ? -1 : 1;
  });
  return { scored: resorted, dampedCount };
}
