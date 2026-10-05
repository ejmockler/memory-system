// recall-content-dedup.test.mjs — WU-recall-content-dedup regression gate.
//
// AUTHORITATIVE problem statement (empirically measured on the live 1.46M-fact
// ledger):
//   Query "update to latest Git HEAD" -> 12 memories returned, only 1 UNIQUE
//   (same OpenWrt commit 12x). Query "setup" -> 12 returned, 2 unique.
//   The corpus is ~97% noise dominated by byte-identical duplicate facts
//   (OpenWrt feed commits identical across many repos; codex-cli repeated
//   prompts). MMR diversity cannot collapse them because every candidate has
//   features.embedding=null (Gemini quota outage) -> s_emb=0 -> MMR has no
//   vector to diversify on -> returns duplicates. The brief is useless: same
//   answer N times.
//
// THE FIX (this test guards): a content-dedup pass at the recall PROJECTION,
// inserted AFTER the score-sort and BEFORE the rerank-input slice. It walks the
// score-sorted scored[] array, collapses candidates whose NORMALIZED content is
// byte-identical (normalize = trim + collapse internal whitespace runs to a
// single space + lowercase), keeps the FIRST (highest-scored) representative,
// and annotates score_components.duplicate_count on the survivor. final_score
// is unchanged. CAPS-gated (RECALL_CONTENT_DEDUP_ENABLED, default true).
//
// Two surfaces under test:
//   1. The pure helper _dedupScoredByContent / _normalizeContentForDedup
//      (unit; hermetic fixture scored set).
//   2. End-to-end recall on a fixture ledger with 12 identical fact rows + 1
//      distinct: the brief returns 2 distinct memories, not 13, and the
//      envelope surfaces deduped_count.
//
// HERMETICITY: mkdtempSync root + env vars set BEFORE any dynamic import of
// memory-system modules (standing C-NEW-2 pattern). GEMINI keys are unset so
// the recall embed step fails fast (no network) and degrades to the BM25-only
// path — which is exactly the embedding-outage scenario that defeats MMR.
// b4: unsetting the keys governs Layer-1 and the gemini Layer-3 backend only,
// so Layer-3 is ALSO pinned LOCAL_RERANKER_ENABLED="0" at the env seam below;
// without that pin recall reached the live rerank daemon on :8360 and this
// paragraph's "no network" was false. Production paths are snapshotted pre/post
// and asserted byte-identical.
//
// Run: node test/synthesis/recall-content-dedup.test.mjs

import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skipIfDaemonActive } from "../_hermetic-daemon-skip.mjs";
skipIfDaemonActive("WU-recall-content-dedup");

// The checkout this suite runs from. Its default (un-overridden) ledgers,
// policy and indices are what the byte-identity guards below watch; the
// suite itself works under a temp MEMORY_ROOT.
const CHECKOUT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// ---------------------------------------------------------------------------
// 0. Production snapshot guard BEFORE we touch anything.
// ---------------------------------------------------------------------------
const PROD_MEMORY_JSONL = join(CHECKOUT_ROOT, "ledgers", "memory.jsonl");
const PROD_RECALL_JSONL = join(CHECKOUT_ROOT, "ledgers", "recall.jsonl");
const PROD_INDICES_DIR = join(CHECKOUT_ROOT, "indices");
function snap(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const PROD_BEFORE = {
  memory: snap(PROD_MEMORY_JSONL),
  recall: snap(PROD_RECALL_JSONL),
  indices: snap(PROD_INDICES_DIR),
};

// ---------------------------------------------------------------------------
// 1. Hermetic root + env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-wu-content-dedup-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(MEMORY_ROOT, "policy");
const STORAGE_DIR = join(MEMORY_ROOT, "storage");
const LEDGERS_DIR = join(MEMORY_ROOT, "ledgers");
const INDICES_DIR = join(MEMORY_ROOT, "indices");
for (const d of [POLICY_DIR, STORAGE_DIR, LEDGERS_DIR, INDICES_DIR]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;
// Force the recall embed step to fail fast (no network) — this is the
// embedding-outage scenario that defeats MMR and motivates content-dedup.
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;
// b4: that scrub governs Layer-1 and the gemini Layer-3 backend only. An UNSET
// LOCAL_RERANKER_ENABLED falls through to CAPS.LOCAL_RERANKER_ENABLED (true),
// which skips the gemini key gate and sends the default backend at _baseUrl()
// to the LIVE rerank daemon on :8360 — reordering this suite's pool off-box.
// "0" is the tri-state OFF override (a `delete` is inert against a true CAP);
// it restores the api_key_missing degrade and opens no socket.
process.env.LOCAL_RERANKER_ENABLED = "0";

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// 2. Dynamic imports AFTER env override.
// ---------------------------------------------------------------------------
const { memoryLedgerPath } = await import("../../lib/config.js");
const recallMod = await import("../../lib/tools/recall.js");
const { _dedupScoredByContent, _normalizeContentForDedup } = recallMod;
const indexCacheMod = await import("../../lib/recall/index-cache.js");
const { saveIndices, _resetCaches } = indexCacheMod;
const { _resetTransitiveOrphanCaches } = await import(
  "../../lib/recall/hard-gates.js"
);
const { Bm25Index } = await import("../../lib/recall/bm25-index.js");
const { HnswIndex } = await import("../../lib/recall/hnsw-index.js");
const { CAPS } = await import("../../lib/validation.js");
// l5-fallback-removal — see the MODEL_VERSION note below; this fixture is
// keyed to the ACTIVE embed model now, so GEMINI_CLIENT_CONSTANTS has no
// reader left in this file.

// l5-fallback-removal — this fixture is keyed to the ACTIVE embed model. It
// used to be keyed to GEMINI_CLIENT_CONSTANTS.GEMINI_EMBEDDING_MODEL_VERSION
// and reached recall ONLY through the both-active-trees-empty legacy-coverage
// fallback branch in recall.js step c. With that branch deleted a legacy-keyed
// index is never loaded, so T10's e2e brief came back with 0 memories.
// Re-keyed to the active version; the row labels ride along because they all
// read MODEL_VERSION, so the hard-gates exclusion comparison stays
// self-consistent.
const MODEL_VERSION = CAPS.ACTIVE_EMBED_MODEL_VERSION;

// ---------------------------------------------------------------------------
// Helper: build a hermetic scored[] entry (the shape recall.js produces at
// step (h): { candidate, score_components }).
// ---------------------------------------------------------------------------
function scoredEntry(memory_id, content, final_score) {
  return {
    candidate: { memory_id, content, kind: "fact", ts: "2026-06-01T00:00:00Z" },
    score_components: { final_score },
  };
}

// ---------------------------------------------------------------------------
// T1 — dedup collapses a duplicate cluster: 5 candidates, 3 sharing identical
// content + 2 distinct -> 3 survivors (1 cluster rep + 2 distinct).
// ---------------------------------------------------------------------------
test("T1: 3-of-5 duplicate cluster collapses to 3 survivors (1 rep + 2 distinct)", () => {
  // Caller contract: scored[] is already sorted by final_score desc.
  const scored = [
    scoredEntry("dup_a", "update to latest Git HEAD", 0.9),
    scoredEntry("distinct_1", "totally different fact one", 0.8),
    scoredEntry("dup_b", "update to latest Git HEAD", 0.7),
    scoredEntry("dup_c", "update to latest Git HEAD", 0.6),
    scoredEntry("distinct_2", "another distinct fact two", 0.5),
  ];
  const { deduped, dedupedCount } = _dedupScoredByContent(scored);
  assert.equal(deduped.length, 3, "3 survivors remain after collapse");
  assert.equal(dedupedCount, 2, "2 duplicates were dropped");
  const ids = deduped.map((s) => s.candidate.memory_id);
  assert.deepEqual(
    ids,
    ["dup_a", "distinct_1", "distinct_2"],
    "score-sorted order preserved; dup cluster reduced to its highest-scored rep",
  );
});

// ---------------------------------------------------------------------------
// T2 — the kept representative is the HIGHEST final_score of its cluster, and
// final_score is NOT mutated.
// ---------------------------------------------------------------------------
test("T2: cluster rep is the highest-scored member; final_score untouched", () => {
  const scored = [
    scoredEntry("dup_hi", "same content here", 0.95),
    scoredEntry("dup_mid", "same content here", 0.55),
    scoredEntry("dup_lo", "same content here", 0.15),
  ];
  const { deduped, dedupedCount } = _dedupScoredByContent(scored);
  assert.equal(deduped.length, 1, "whole cluster collapses to one survivor");
  assert.equal(dedupedCount, 2, "two members dropped");
  assert.equal(
    deduped[0].candidate.memory_id,
    "dup_hi",
    "the highest-scored member (0.95) is the kept representative",
  );
  assert.equal(
    deduped[0].score_components.final_score,
    0.95,
    "final_score is NOT changed by dedup",
  );
});

// ---------------------------------------------------------------------------
// T3 — duplicate_count == N on the survivor (count includes the rep itself).
// ---------------------------------------------------------------------------
test("T3: survivor annotated with duplicate_count == cluster size (3)", () => {
  const scored = [
    scoredEntry("dup_a", "openwrt feed commit deadbeef", 0.9),
    scoredEntry("dup_b", "openwrt feed commit deadbeef", 0.8),
    scoredEntry("dup_c", "openwrt feed commit deadbeef", 0.7),
  ];
  const { deduped } = _dedupScoredByContent(scored);
  assert.equal(deduped.length, 1);
  assert.equal(
    deduped[0].score_components.duplicate_count,
    3,
    "duplicate_count counts the rep + the 2 collapsed duplicates",
  );
});

// ---------------------------------------------------------------------------
// T4 — whitespace + case-insensitive normalization collapses variants.
// "Update  to  HEAD" (double spaces, mixed case) and "update to head"
// (lowercase, single spaces) + a tab/newline variant all collapse.
// ---------------------------------------------------------------------------
test("T4: whitespace-collapse + lowercase normalization collapses variants", () => {
  const scored = [
    scoredEntry("v1", "Update  to  HEAD", 0.9),
    scoredEntry("v2", "update to head", 0.8),
    scoredEntry("v3", "  update\tto\nhead  ", 0.7),
  ];
  const { deduped, dedupedCount } = _dedupScoredByContent(scored);
  assert.equal(deduped.length, 1, "all three normalize to the same key");
  assert.equal(dedupedCount, 2, "two collapsed");
  assert.equal(deduped[0].candidate.memory_id, "v1", "highest-scored rep kept");
  assert.equal(deduped[0].score_components.duplicate_count, 3);

  // And the normalizer itself is deterministic on these inputs.
  assert.equal(
    _normalizeContentForDedup("Update  to  HEAD"),
    "update to head",
    "trim + collapse-whitespace + lowercase",
  );
  assert.equal(
    _normalizeContentForDedup("  update\tto\nhead  "),
    "update to head",
    "tabs and newlines are whitespace runs collapsed to single spaces",
  );
});

// ---------------------------------------------------------------------------
// T5 — empty/missing-content candidates do NOT collapse together (keyed by id).
// Distinct ids that genuinely lack content must each survive.
// ---------------------------------------------------------------------------
test("T5: empty-content candidates are keyed by id (never collapse together)", () => {
  const scored = [
    scoredEntry("empty_a", "", 0.9),
    scoredEntry("empty_b", "   ", 0.8), // whitespace-only normalizes to ""
    { candidate: { memory_id: "missing_c" }, score_components: { final_score: 0.7 } },
  ];
  const { deduped, dedupedCount } = _dedupScoredByContent(scored);
  assert.equal(
    deduped.length,
    3,
    "three distinct content-less ids all survive (keyed by id, not by empty content)",
  );
  assert.equal(dedupedCount, 0, "nothing collapsed");
  const ids = deduped.map((s) => s.candidate.memory_id);
  assert.deepEqual(ids, ["empty_a", "empty_b", "missing_c"]);
  for (const s of deduped) {
    assert.equal(
      s.score_components.duplicate_count,
      1,
      "each content-less survivor has duplicate_count=1",
    );
  }
});

// ---------------------------------------------------------------------------
// T6 — no-duplicate set is a PURE PASS-THROUGH: count + order identical,
// each survivor annotated duplicate_count=1, final_score untouched.
// ---------------------------------------------------------------------------
test("T6: no-duplicate set is a pure pass-through (backwards-compat)", () => {
  const scored = [
    scoredEntry("a", "alpha fact", 0.9),
    scoredEntry("b", "bravo fact", 0.8),
    scoredEntry("c", "charlie fact", 0.7),
    scoredEntry("d", "delta fact", 0.6),
  ];
  const beforeIds = scored.map((s) => s.candidate.memory_id);
  const beforeScores = scored.map((s) => s.score_components.final_score);
  const { deduped, dedupedCount } = _dedupScoredByContent(scored);
  assert.equal(dedupedCount, 0, "no duplicates -> nothing dropped");
  assert.equal(deduped.length, scored.length, "count unchanged");
  assert.deepEqual(
    deduped.map((s) => s.candidate.memory_id),
    beforeIds,
    "order unchanged",
  );
  assert.deepEqual(
    deduped.map((s) => s.score_components.final_score),
    beforeScores,
    "final_score values unchanged",
  );
  for (const s of deduped) {
    assert.equal(s.score_components.duplicate_count, 1);
  }
});

// ---------------------------------------------------------------------------
// T7 — empty input set returns empty (defensive).
// ---------------------------------------------------------------------------
test("T7: empty / non-array input is defensive", () => {
  const e = _dedupScoredByContent([]);
  assert.deepEqual(e.deduped, []);
  assert.equal(e.dedupedCount, 0);
  const bad = _dedupScoredByContent(null);
  assert.deepEqual(bad.deduped, []);
  assert.equal(bad.dedupedCount, 0);
});

// ---------------------------------------------------------------------------
// T8 — normalizer edge cases: non-string -> "", already-normal -> unchanged.
// ---------------------------------------------------------------------------
test("T8: _normalizeContentForDedup edge cases", () => {
  assert.equal(_normalizeContentForDedup(null), "", "null -> empty");
  assert.equal(_normalizeContentForDedup(undefined), "", "undefined -> empty");
  assert.equal(_normalizeContentForDedup(42), "", "number -> empty");
  assert.equal(
    _normalizeContentForDedup("already normal"),
    "already normal",
    "already-normalized string is unchanged",
  );
  assert.equal(_normalizeContentForDedup("   "), "", "whitespace-only -> empty");
});

// ---------------------------------------------------------------------------
// T9 — DIFFERENT content does NOT collapse even when it overlaps heavily.
// Only EXACT normalized matches collapse; near-duplicates survive separately.
// ---------------------------------------------------------------------------
test("T9: near-duplicate (different) content does NOT collapse", () => {
  const scored = [
    scoredEntry("x", "update to latest Git HEAD", 0.9),
    scoredEntry("y", "update to latest Git HEAD now", 0.8), // one extra word
    scoredEntry("z", "update to latest git head!", 0.7), // trailing punctuation
  ];
  const { deduped, dedupedCount } = _dedupScoredByContent(scored);
  assert.equal(deduped.length, 3, "three distinct normalized strings survive");
  assert.equal(dedupedCount, 0, "nothing collapsed — threshold-free exact match only");
});

// ===========================================================================
// END-TO-END: recall on a fixture ledger with 12 identical fact rows + 1
// distinct. Before the fix, the brief returned all 12 dups + the distinct.
// After: 2 distinct memories.
// ===========================================================================

const TS = "2026-06-01T00:00:00.000Z";
const DISTINCT_ID = "fact_distinct_quokka";
// The 12 byte-identical OpenWrt-style fact rows share this exact content.
const DUP_CONTENT =
  "update openwrt feeds to latest git head deadbeefcafe quokka";
const DISTINCT_CONTENT =
  "the rare quokka marsupial smiled on rottnest island quokka";

function factRow(id, content) {
  return {
    id,
    kind: "fact",
    content,
    created_at: TS,
    ts: TS,
    source_refs: [{ source: "test", consent_basis: "first_party" }],
    features: { embedding_model_version: MODEL_VERSION },
  };
}

function buildFixtureRows() {
  const rows = [];
  // 12 byte-identical dup rows (distinct ids, same content).
  for (let i = 0; i < 12; i++) {
    rows.push(factRow(`fact_dup_${String(i).padStart(2, "0")}`, DUP_CONTENT));
  }
  // 1 distinct row that ALSO BM25-matches the probe (shares "quokka").
  rows.push(factRow(DISTINCT_ID, DISTINCT_CONTENT));
  return rows;
}

function writeFixtureLedgerAndIndex(rows) {
  const path = memoryLedgerPath();
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path, body, { mode: 0o600 });
  // Build BM25 over the fact rows so the probe resolves all candidates.
  const bm25 = new Bm25Index();
  for (const r of rows) {
    bm25.add({
      memory_id: r.id,
      content: r.content,
      kind: r.kind,
      ts: r.ts,
      entities: [],
    });
  }
  // Empty HNSW (no embeddings) — the degraded BM25-only path ignores it. This
  // is the embedding-outage scenario where MMR cannot diversify.
  const hnsw = new HnswIndex({
    // Active-model geometry, matching the version this tree is saved under.
    // Still EMPTY: the degraded BM25-only path under test never searches it.
    dims: CAPS.EMBEDDING_DIM_4096,
    embedding_model_version: MODEL_VERSION,
  });
  saveIndices(MODEL_VERSION, { bm25, hnsw });
  _resetCaches();
  _resetTransitiveOrphanCaches();
}

function recallArgs() {
  return {
    surrounding_context: {
      current_query: "update openwrt feeds to latest git head quokka",
      recent_turns: [{ role: "user", content: "openwrt quokka head update" }],
      agent_role: "assistant",
      time: "2026-06-02T12:00:00.000Z",
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: "conv_wu_content_dedup",
    max_items: 12,
    max_chars: 4000,
  };
}

// ---------------------------------------------------------------------------
// T10 — end-to-end: 12 identical + 1 distinct -> brief returns 2 distinct
// memories, and the envelope surfaces deduped_count.
// ---------------------------------------------------------------------------
test("T10: e2e recall collapses 12 identical facts to 1 (+1 distinct = 2)", async () => {
  const rows = buildFixtureRows();
  writeFixtureLedgerAndIndex(rows);

  const env = await recallMod.TOOL.handler(recallArgs());
  assert.equal(env.ok, true, "handler returns ok envelope");
  const data = env.data;

  // Embedding outage -> BM25-only degrade. This is the scenario under test.
  assert.equal(data.degraded_recall, true, "degraded to BM25-only (no Gemini key)");

  const memIds = Array.isArray(data.memories) ? data.memories.map((m) => m.id) : [];
  // The dup cluster collapses to exactly ONE representative; the distinct row
  // is the second memory. 2 total — NOT 13.
  assert.equal(
    memIds.length,
    2,
    `brief returns 2 distinct memories, not 13 (got ${memIds.length}: ${memIds.join(",")})`,
  );
  // Exactly one dup-cluster id surfaces.
  const dupSurvivors = memIds.filter((id) => id.startsWith("fact_dup_"));
  assert.equal(dupSurvivors.length, 1, "exactly one dup-cluster representative survives");
  assert.ok(memIds.includes(DISTINCT_ID), "the distinct quokka fact also surfaces");

  // Observability: deduped_count surfaced on the envelope. 11 dups collapsed.
  assert.equal(typeof data.deduped_count, "number", "deduped_count is a number");
  assert.equal(data.deduped_count, 11, "11 of the 12 identical dups were collapsed");

  // candidate_set_size reflects the post-projection (deduped) set: 2.
  assert.equal(
    data.candidate_set_size,
    2,
    "candidate_set_size reflects the deduped projection (2 distinct)",
  );
});

// ---------------------------------------------------------------------------
// T11 — CAPS gate. The dedup pass is gated on
// CAPS.RECALL_CONTENT_DEDUP_ENABLED (default true). The CAP is the SOLE switch
// the handler reads:
//     if (CAPS.RECALL_CONTENT_DEDUP_ENABLED === true) { ...dedup... }
// We assert (a) the default is true (so the collapse in T10 is the shipped
// behavior) and (b) the inverse contract that DISABLING is equivalent to NOT
// running _dedupScoredByContent: the un-deduped scored set retains every
// duplicate, proving the gate's effect is exactly "skip the helper". CAPS is
// Object.freeze'd so we exercise the disabled branch via its definition (the
// "do nothing" path) rather than mutating the frozen table.
// ---------------------------------------------------------------------------
test("T11: dedup is CAPS-gated (default true; disabled == skip the helper)", () => {
  assert.equal(
    CAPS.RECALL_CONTENT_DEDUP_ENABLED,
    true,
    "default RECALL_CONTENT_DEDUP_ENABLED is true (so T10's collapse is shipped behavior)",
  );
  // The disabled branch is, by construction, "leave scored[] untouched". The
  // same 12-dup fixture, if the helper is NOT invoked, retains all 13 entries
  // with no annotation drift. This is the exact set the handler's else-branch
  // (CAP=false) carries forward to rerank/MMR.
  const scored = [];
  for (let i = 0; i < 12; i++) {
    scored.push(scoredEntry(`fact_dup_${i}`, DUP_CONTENT, 0.9 - i * 0.01));
  }
  scored.push(scoredEntry(DISTINCT_ID, DISTINCT_CONTENT, 0.3));
  // disabled == do not call _dedupScoredByContent -> set is unchanged.
  assert.equal(scored.length, 13, "un-deduped set retains all 13 rows");
  const dupCount = scored.filter((s) =>
    s.candidate.memory_id.startsWith("fact_dup_"),
  ).length;
  assert.equal(dupCount, 12, "all 12 duplicates remain when dedup is skipped");
  // No survivor carries duplicate_count when the helper never ran.
  for (const s of scored) {
    assert.equal(
      "duplicate_count" in s.score_components,
      false,
      "no duplicate_count annotation when dedup is disabled/skipped",
    );
  }
  // Sanity contrast: running the helper on the SAME set collapses to 2.
  const { deduped, dedupedCount } = _dedupScoredByContent(scored);
  assert.equal(deduped.length, 2, "enabled path collapses the same set to 2");
  assert.equal(dedupedCount, 11, "11 duplicates collapsed when enabled");
});

// ---------------------------------------------------------------------------
// T12 — production paths untouched (hermeticity invariant).
// ---------------------------------------------------------------------------
test("T12: production paths byte-identical (hermeticity)", () => {
  const after = {
    memory: snap(PROD_MEMORY_JSONL),
    recall: snap(PROD_RECALL_JSONL),
    indices: snap(PROD_INDICES_DIR),
  };
  assert.equal(
    after.memory,
    PROD_BEFORE.memory,
    "production memory.jsonl untouched (mtime:size)",
  );
  assert.equal(
    after.recall,
    PROD_BEFORE.recall,
    "production recall.jsonl untouched (mtime:size)",
  );
  assert.equal(
    after.indices,
    PROD_BEFORE.indices,
    "production indices/ untouched (mtime:size)",
  );
});
