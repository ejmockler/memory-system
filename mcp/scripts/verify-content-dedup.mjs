// verify-content-dedup.mjs — empirical verification of the WU-recall-content-dedup
// fix against the LIVE ledger (<MEMORY_ROOT>/ledgers/memory.jsonl).
//
// READ-ONLY: drives TOOL.handler with the BM25-only degraded path (no GEMINI keys).
// Does NOT mutate the ledger. (Note: the handler itself best-effort appends a
// recall-log event + damping-log rows as a normal side effect of recall; it
// never writes to memory.jsonl content. We only READ memories[] from the brief.)
//
// For each query: reports returned-count and UNIQUE-content-count, where the
// uniqueness key uses the SAME normalization the dedup engine uses
// (_normalizeContentForDedup: trim + collapse whitespace + lowercase).

import { createHash } from "node:crypto";
import { TOOL, _normalizeContentForDedup } from "../lib/tools/recall.js";

// Hard fail-loud guard: this verification is only meaningful on the degraded
// BM25-only path the operators hit during the quota outage.
if (process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS) {
  console.error(
    "REFUSING: GEMINI_API_KEY / GEMINI_API_KEYS is set; this verifies the degraded BM25-only path. Unset them.",
  );
  process.exit(2);
}

const MAX_ITEMS = 12;
const NOW = "2026-06-21T18:00:00.000Z";

// before-state baseline from the workunit measurement (for before/after report).
const QUERIES = [
  { q: "bump the pinned lockfile to the newest release", before: "12 returned / 1 unique", flood: true },
  { q: "install", before: "12 returned / 2 unique", flood: true },
  { q: "printer calibration steps in the workshop", before: "relevant + distinct", flood: false },
  { q: "alexexample sample-repo commits", before: "relevant + distinct", flood: false },
];

function uniqueContentCount(memories) {
  const keys = new Set();
  for (const m of memories) {
    const content = m && typeof m.content === "string" ? m.content : "";
    const norm = _normalizeContentForDedup(content);
    // Empty content -> key by id so distinct empty-content rows don't collapse
    // (mirrors the engine's id-fallback). Hash for compact set membership.
    const key = norm.length > 0
      ? "c:" + createHash("sha256").update(norm, "utf8").digest("hex")
      : "id:" + (m && typeof m.id === "string" ? m.id : Math.random().toString());
    keys.add(key);
  }
  return keys.size;
}

function buildArgs(query) {
  return {
    surrounding_context: {
      recent_turns: [{ role: "user", content: query }],
      agent_role: "verification-harness",
      current_query: query,
      time: NOW,
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: "verify-content-dedup",
    max_items: MAX_ITEMS,
    max_chars: 4000,
  };
}

const results = [];
for (const { q, before, flood } of QUERIES) {
  let envelope;
  try {
    envelope = await TOOL.handler(buildArgs(q), { now: NOW });
  } catch (err) {
    results.push({ q, before, error: String(err && err.message ? err.message : err) });
    continue;
  }
  if (!envelope || envelope.ok !== true || !envelope.data) {
    results.push({
      q,
      before,
      error: "handler returned non-ok: " + JSON.stringify(envelope && envelope.error),
    });
    continue;
  }
  const data = envelope.data;
  const memories = Array.isArray(data.memories) ? data.memories : [];
  const returned = memories.length;
  const unique = uniqueContentCount(memories);
  const dups = returned - unique;
  results.push({
    q,
    before,
    flood,
    returned,
    unique,
    dups,
    deduped_count: data.deduped_count,
    degraded_recall: data.degraded_recall,
    candidate_set_size: data.candidate_set_size,
    // first ~70 chars of each surfaced content for the relevance eyeball check.
    samples: memories.slice(0, 5).map((m) => ({
      id: m.id,
      excerpt: (typeof m.content === "string" ? m.content : "").slice(0, 90),
    })),
  });
}

console.log(JSON.stringify({ max_items: MAX_ITEMS, results }, null, 2));
