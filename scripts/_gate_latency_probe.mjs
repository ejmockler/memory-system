// GATE latency probe — drives recall.js TOOL.handler with three queries.
// Reports cold + warm wall time per query. Prints top-3 surfaced memory ids/content.
import { performance } from "node:perf_hooks";

const mod = await import("../mcp/lib/tools/recall.js");
const TOOL = mod.TOOL || mod.default || mod;
const handler = TOOL.handler;
if (typeof handler !== "function") {
  console.error("no handler export; keys=", Object.keys(mod));
  process.exit(1);
}

const QUERIES = [
  "printer calibration steps in the workshop",
  "what did the landlord say",
  "alexexample sample-repo commits",
];

function mkArgs(q) {
  return {
    surrounding_context: {
      recent_turns: [{ role: "user", content: q }],
      agent_role: "assistant",
      current_query: q,
      time: new Date().toISOString(),
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: "gate-latency-probe",
    max_items: 12,
    max_chars: 4000,
  };
}

function top3(brief) {
  const mems = (brief && (brief.memories || brief.surfaced)) || [];
  return mems.slice(0, 3).map((m, i) => ({
    rank: i,
    id: m.memory_id || m.id,
    content: (m.content || "").slice(0, 70),
  }));
}

function getBrief(res) {
  // envelope shape: { ok, data:{ recall_id, memories:[...], degraded_recall }, ... }
  if (!res) return null;
  return res.data || res;
}

const results = {};
for (const q of QUERIES) {
  // cold
  let t0 = performance.now();
  let res = await handler(mkArgs(q));
  let cold = performance.now() - t0;
  const brief = getBrief(res);
  // warm (avg of 2)
  const warms = [];
  for (let i = 0; i < 2; i++) {
    t0 = performance.now();
    await handler(mkArgs(q));
    warms.push(performance.now() - t0);
  }
  const warm = warms.reduce((a, b) => a + b, 0) / warms.length;
  results[q] = {
    cold_ms: Math.round(cold),
    warm_ms: Math.round(warm),
    degraded_recall_flag: brief ? brief.degraded_recall : undefined,
    top3: top3(brief),
  };
  console.log(`\n=== "${q}" ===`);
  console.log(`cold=${results[q].cold_ms}ms warm=${results[q].warm_ms}ms degraded_recall=${results[q].degraded_recall_flag}`);
  for (const t of results[q].top3) {
    console.log(`  #${t.rank} ${t.id} score=${t.score} :: ${t.content}`);
  }
}
console.log("\n__RESULTS_JSON__" + JSON.stringify(results));
