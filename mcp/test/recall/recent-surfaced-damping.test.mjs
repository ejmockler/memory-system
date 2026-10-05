// recent-surfaced-damping.test.mjs — surrounding_context.recent_recall_ids
// is honored as DAMPING (kb/mcp-surface.md § memory_recall), via
// lib/recall/recent-surfaced-damping.js and the recall-log stamp it reads.
//
// HERMETIC: pure helpers + the in-process recall-log map. No ledger reads,
// no index, no network. RED before the module existed: the handler
// validated recent_recall_ids and read it nowhere (measured 2026-09-09: one
// memory surfaced in three of four same-session facet recalls).

import assert from "node:assert/strict";
import {
  collectRecentlySurfacedIds,
  applyRecentSurfacedDamping,
} from "../../lib/recall/recent-surfaced-damping.js";
import {
  recordRecall,
  lookupRecall,
  _resetRecallLog,
} from "../../lib/recall-log.js";
import { CAPS } from "../../lib/validation.js";

let passed = 0;
function ok(msg) { passed++; console.log(`  ok ${msg}`); }

const mk = (id, score) => ({
  candidate: { memory_id: id },
  score_components: { final_score: score },
});

console.log("# CAPS");
assert.ok(
  typeof CAPS.RECALL_RECENT_SURFACED_DAMPING_FACTOR === "number" &&
    CAPS.RECALL_RECENT_SURFACED_DAMPING_FACTOR > 0 &&
    CAPS.RECALL_RECENT_SURFACED_DAMPING_FACTOR < 1,
);
ok("RECALL_RECENT_SURFACED_DAMPING_FACTOR is a (0,1) multiplier");

console.log("# collectRecentlySurfacedIds");
_resetRecallLog();
recordRecall("rec_a", {
  query: {},
  logged_at: "2026-09-09T02:00:00.000Z",
  surfaced_memory_ids: ["mem_1", "mem_2"],
});
recordRecall("rec_b", {
  query: {},
  logged_at: "2026-09-09T02:05:00.000Z",
  surfaced_memory_ids: ["mem_2", "mem_3"],
});
recordRecall("rec_legacy", { query: {}, logged_at: "2026-09-09T02:06:00.000Z" });
const NOW = Date.parse("2026-09-09T02:10:00.000Z");
const lookup = (rid) => lookupRecall(rid, NOW);
{
  const ids = collectRecentlySurfacedIds(["rec_a", "rec_b"], lookup);
  assert.deepStrictEqual([...ids].sort(), ["mem_1", "mem_2", "mem_3"]);
}
ok("unions surfaced ids across the named recalls");
{
  const ids = collectRecentlySurfacedIds(["rec_missing", "rec_legacy", "", 42], lookup);
  assert.strictEqual(ids.size, 0);
}
ok("unknown ids, pre-stamp entries, and junk contribute nothing");
{
  const expired = Date.parse("2026-09-09T02:00:00.000Z") + (CAPS.RECALL_LOG_TTL_SECONDS + 1) * 1000;
  const ids = collectRecentlySurfacedIds(["rec_a"], (rid) => lookupRecall(rid, expired));
  assert.strictEqual(ids.size, 0);
}
ok("an entry past RECALL_LOG_TTL_SECONDS resolves to nothing (TTL respected)");
{
  const ids = collectRecentlySurfacedIds(["rec_a"], () => { throw new Error("boom"); });
  assert.strictEqual(ids.size, 0);
  assert.strictEqual(collectRecentlySurfacedIds(undefined, lookup).size, 0);
  assert.strictEqual(collectRecentlySurfacedIds(["rec_a"], null).size, 0);
}
ok("a throwing lookup, a missing list, or a missing lookup never throws");

console.log("# applyRecentSurfacedDamping");
{
  const scored = [mk("mem_1", 0.9), mk("mem_2", 0.8), mk("mem_4", 0.5), mk("mem_5", 0.3)];
  const { scored: out, dampedCount } = applyRecentSurfacedDamping(
    scored, new Set(["mem_1", "mem_2"]), 0.25,
  );
  assert.strictEqual(dampedCount, 2);
  assert.deepStrictEqual(out.map((s) => s.candidate.memory_id), ["mem_4", "mem_5", "mem_1", "mem_2"]);
  const m1 = out.find((s) => s.candidate.memory_id === "mem_1").score_components;
  assert.strictEqual(m1.final_score, 0.9 * 0.25);
  assert.strictEqual(m1.final_score_pre_damping, 0.9);
  assert.strictEqual(m1.recent_surfaced_damping_factor, 0.25);
  const m4 = out.find((s) => s.candidate.memory_id === "mem_4").score_components;
  assert.strictEqual(m4.final_score, 0.5);
  assert.strictEqual("final_score_pre_damping" in m4, false);
}
ok("damped entries drop below fresh ones, keep pre-damping score + factor; others untouched");
{
  // Damping, not paging: a dominant memory still wins.
  const scored = [mk("mem_1", 1.0), mk("mem_4", 0.2)];
  const { scored: out, dampedCount } = applyRecentSurfacedDamping(scored, new Set(["mem_1"]), 0.25);
  assert.strictEqual(dampedCount, 1);
  assert.strictEqual(out[0].candidate.memory_id, "mem_1");
}
ok("a memory that out-scores fresh candidates by more than 1/factor still surfaces (damping, not paging)");
{
  const scored = [mk("mem_1", 0.9), mk("mem_2", 0.8)];
  const a = applyRecentSurfacedDamping(scored, new Set(), 0.25);
  const b = applyRecentSurfacedDamping(scored, new Set(["mem_1"]), 1);
  const c = applyRecentSurfacedDamping(scored, new Set(["mem_9"]), 0.25);
  for (const r of [a, b, c]) {
    assert.strictEqual(r.dampedCount, 0);
    assert.strictEqual(r.scored, scored);
    assert.strictEqual(scored[0].score_components.final_score, 0.9);
  }
}
ok("empty set, factor >= 1, or no overlap is a byte-identical pass-through (same array)");
{
  // Tie-break after damping follows the handler's order: memory_id asc.
  const scored = [mk("mem_b", 0.4), mk("mem_a", 0.4), mk("mem_z", 1.6)];
  const { scored: out } = applyRecentSurfacedDamping(scored, new Set(["mem_z"]), 0.25);
  assert.deepStrictEqual(out.map((s) => s.candidate.memory_id), ["mem_a", "mem_b", "mem_z"]);
}
ok("re-sort uses final_score desc then memory_id asc, matching the handler");

_resetRecallLog();
console.log(`\n${passed} assertions passed`);
