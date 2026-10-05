// dense-reembed-infra.test.mjs — WU-dense-reembed-infra regression gate.
//
// AUTHORITATIVE behavior under test (the DO-phase plan's reembed_design +
// recall_wiring + giant_chunking, against the live linear-scan 4096 deployment):
//
//   A. FULL-FIDELITY re-embed (mcp/scripts/reembed-local-4096.mjs):
//      - text within the window embeds WHOLE (single chunk, id unchanged, NO
//        '#k' suffix, NO truncation).
//      - text over the window is TURN-AWARE chunked on the debate-turn delimiter
//        ("\n---\n") into overlapping multi-vector chunks `${factId}#${k}` that
//        cover ALL content with NO gaps (every char survives in >=1 chunk).
//      - a single un-splittable turn > window is hard char-windowed (still full).
//      - text past the model context ceiling warns LOUD (truncation-impossible).
//      - length-bucketed batch sizing (big batches for short, small for long).
//
//   B. recall.js s_emb SIDECAR overlay (_resolveCandidateEmbedding):
//      - a candidate whose ledger row carries NO embedding_4096 (every PRE-
//        EXISTING fact) gets its 4096 vector from the index via
//        hnsw.getVectorByMemoryId -> s_emb fires instead of 0. THE gap fixture.
//      - a NEW cascade fact that carries embedding_4096 on its row uses the ROW
//        vector; the overlay never runs for it (invariant unchanged).
//      - a legacy gemini-3072 fact under the 3072 query path uses its row 3072
//        vector and never gets a 4096 overlay (geometry-mix guard).
//
//   C. recall.js chunk-id resolution (_stripChunkSuffix):
//      - a knn/candidate id `${factId}#${k}` strips back to the fact id so the
//        fact row resolves; ids without a numeric '#k' suffix pass through.
//
//   D. HnswIndex.getVectorByMemoryId — the index-side accessor the overlay reads.
//
// HERMETIC + OFFLINE: pure helpers + a small in-memory HnswIndex fixture. No
// embed server, no ledger, no MPS. Production paths are never touched.
//
// Run: node test/synthesis/dense-reembed-infra.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _stripChunkSuffix,
  _selectSameDimEmbedding,
  _resolveCandidateEmbedding,
} from "../../lib/tools/recall.js";
import { HnswIndex } from "../../lib/recall/hnsw-index.js";
import {
  chunksFor,
  splitTurns,
  batchSizeForCharLen,
  WINDOW,
  MODEL_CONTEXT_TOKENS,
  CHARS_PER_TOKEN,
  TURN_DELIMITERS,
  collectContents,
  planEmbedItems,
} from "../../scripts/reembed-local-4096.mjs";

const DIM = 4096;
const GEMINI_DIM = 3072;
const TURN = "\n---\n"; // the debate-turn delimiter the Map found

function unitSpike(idx, dim = DIM) {
  const v = new Array(dim).fill(0);
  v[idx % dim] = 1;
  return v;
}

// ===========================================================================
// A. FULL-FIDELITY re-embed: no truncation, turn-aware chunking, full coverage.
// ===========================================================================

test("A1: short fact embeds WHOLE — single chunk, id unchanged, no truncation", () => {
  const text = "a small fact well under the window";
  const cs = chunksFor("mem_short", text);
  assert.equal(cs.length, 1, "one chunk for sub-window text");
  assert.equal(cs[0].id, "mem_short", "id is unchanged (no #k suffix)");
  assert.equal(cs[0].text, text, "FULL text — byte-identical, never sliced");
  assert.equal(cs[0].text.length, text.length, "no chars dropped");
});

test("A2: a fact exactly at WINDOW chars still embeds whole (boundary, no chunking)", () => {
  const text = "x".repeat(WINDOW);
  const cs = chunksFor("mem_edge", text);
  assert.equal(cs.length, 1, "text at the window edge is a single chunk");
  assert.equal(cs[0].id, "mem_edge", "boundary text keeps the bare id");
  assert.equal(cs[0].text.length, WINDOW, "no truncation at the boundary");
});

test("A3: giant is TURN-AWARE chunked on the debate delimiter into `${id}#${k}`", () => {
  assert.ok(TURN_DELIMITERS.includes(TURN), "the turn delimiter is the configured one");
  const turns = [];
  for (let i = 0; i < 120; i++) turns.push(`TURN${i}:` + "a".repeat(1800));
  const giant = turns.join(TURN); // ~240K chars, well over WINDOW
  assert.ok(giant.length > WINDOW, "fixture exceeds the window");

  const cs = chunksFor("mem_giant", giant);
  assert.ok(cs.length > 1, "giant produced multiple chunk-vectors");
  // Every chunk id carries the `${factId}#${k}` form.
  for (let k = 0; k < cs.length; k++) {
    assert.equal(cs[k].id, `mem_giant#${k}`, `chunk ${k} id is mem_giant#${k}`);
  }
  // No chunk exceeds the window (each is a real, in-context embed).
  assert.ok(cs.every((c) => c.text.length <= WINDOW), "no chunk exceeds WINDOW");
});

test("A4: giant chunking covers ALL content — NO gaps, no dropped turns", () => {
  const turns = [];
  for (let i = 0; i < 120; i++) turns.push(`TURN${i}:` + "a".repeat(1800));
  const giant = turns.join(TURN);
  const cs = chunksFor("mem_giant", giant);
  const joined = cs.map((c) => c.text).join(" ");

  // Every unique turn marker survives in at least one chunk.
  let missing = 0;
  for (let i = 0; i < 120; i++) if (joined.indexOf(`TURN${i}:`) === -1) missing++;
  assert.equal(missing, 0, "no turn marker was dropped by chunking");

  // Sliding-window coverage: every 500-char span of the original appears in
  // some chunk (no content gap between chunk boundaries).
  let gaps = 0;
  for (let p = 0; p + 500 <= giant.length; p += 500) {
    const probe = giant.slice(p, p + 500);
    if (!cs.some((c) => c.text.indexOf(probe) !== -1)) gaps++;
  }
  assert.equal(gaps, 0, "every 500-char span of the giant is covered (no gaps)");
});

test("A5: a single un-splittable turn > WINDOW is hard char-windowed (still full)", () => {
  const huge = "B".repeat(WINDOW * 3 + 1234); // one segment, no delimiter
  const cs = chunksFor("mem_block", huge);
  assert.ok(cs.length > 1, "an over-window single turn is split");
  assert.ok(cs.every((c) => c.text.length <= WINDOW), "every sub-turn chunk fits the window");
  // Reconstruction is at least the full length (overlap only ever DUPLICATES).
  const recon = cs.map((c) => c.text).join("");
  assert.ok(recon.length >= huge.length, "no content lost in the hard window");
  assert.equal(new Set(recon).size, 1, "every char is the original 'B' (full fidelity)");
});

test("A6: text past the model context ceiling WARNS loud (truncation-impossible)", () => {
  // window deliberately disabled (> ceiling) so the single-chunk fast path is
  // forced to ship a vector built from > ceiling chars; it must warn, not slice.
  const ceilingChars = MODEL_CONTEXT_TOKENS * CHARS_PER_TOKEN;
  const over = "C".repeat(ceilingChars + 5000);
  let warns = 0;
  const cs = chunksFor("mem_over", over, { window: ceilingChars + 10000, onWarn: () => warns++ });
  assert.equal(warns, 1, "over-ceiling fact warned exactly once");
  assert.equal(cs.length, 1, "still emitted (full text, never silently dropped)");
  assert.equal(cs[0].text.length, over.length, "no silent truncation");
});

test("A7: splitTurns falls back to one segment when no delimiter is present", () => {
  const segs = splitTurns("no delimiter here at all");
  assert.equal(segs.length, 1, "undivided text is a single turn");
  // With delimiters present it splits and re-attaches the marker to each turn.
  const withDelim = splitTurns(`first${TURN}second${TURN}third`);
  assert.equal(withDelim.length, 3, "three turns");
  assert.ok(withDelim[1].startsWith(TURN), "the delimiter stays attached to its turn");
});

test("A8: length-bucketed batch sizing — big batches for short, small for long", () => {
  assert.equal(batchSizeForCharLen(100), 256, "tiny facts batch huge");
  assert.equal(batchSizeForCharLen(900), 128, "short facts batch large");
  assert.equal(batchSizeForCharLen(4000), 48, "medium facts batch moderate");
  assert.equal(batchSizeForCharLen(16000), 12, "long facts batch small");
  assert.equal(batchSizeForCharLen(80000), 4, "giant chunks batch tiny");
  // Strictly non-increasing in length (the bucketing invariant).
  const lens = [50, 200, 1000, 4000, 16000, 80000, 200000];
  let prev = Infinity;
  for (const L of lens) {
    const bs = batchSizeForCharLen(L);
    assert.ok(bs <= prev, `batch size is non-increasing across lengths (at ${L})`);
    prev = bs;
  }
});

// ===========================================================================
// D. HnswIndex.getVectorByMemoryId — the index-side accessor the overlay reads.
// ===========================================================================

test("D1: getVectorByMemoryId returns the stored vector; null for miss/empty/tombstone", () => {
  const h = new HnswIndex({ dims: DIM, embedding_model_version: "qwen3-embedding-8b-fp16" });
  h.add("mem_a", unitSpike(5));
  const got = h.getVectorByMemoryId("mem_a");
  assert.ok(Array.isArray(got), "returns an array for a live id");
  assert.equal(got.length, DIM, "returns a 4096-dim vector");
  assert.equal(got[5], 1, "returns the exact stored vector");
  assert.equal(h.getVectorByMemoryId("mem_missing"), null, "miss -> null");
  assert.equal(h.getVectorByMemoryId(""), null, "empty id -> null");
  assert.equal(h.getVectorByMemoryId(123), null, "non-string id -> null (defensive)");
  h.remove("mem_a");
  assert.equal(h.getVectorByMemoryId("mem_a"), null, "tombstoned id -> null");
});

// ===========================================================================
// C. recall chunk-id resolution — _stripChunkSuffix.
// ===========================================================================

test("C1: _stripChunkSuffix maps `${factId}#${k}` back to the fact id", () => {
  assert.equal(_stripChunkSuffix("mem_abc#0"), "mem_abc", "strips #0");
  assert.equal(_stripChunkSuffix("mem_abc#17"), "mem_abc", "strips multi-digit #k");
  assert.equal(_stripChunkSuffix("mem_abc"), "mem_abc", "no suffix -> unchanged");
  // Only a TRAILING numeric suffix is a chunk index; everything else verbatim.
  assert.equal(_stripChunkSuffix("mem_abc#v2"), "mem_abc#v2", "non-numeric suffix -> verbatim");
  assert.equal(_stripChunkSuffix("mem_abc#"), "mem_abc#", "trailing '#' is not a chunk suffix");
  assert.equal(_stripChunkSuffix("#3"), "#3", "leading '#' is not a chunk suffix");
  assert.equal(_stripChunkSuffix("a#b#5"), "a#b", "strips only the LAST numeric suffix");
});

// ===========================================================================
// C/dedup. Chunk-id dedup: multiple chunks of one fact collapse to one fact id,
// keeping the best fused entry. Simulates the recall candidate-build collapse.
// ===========================================================================

test("C2: chunk-ids collapse to ONE fact id keeping the best-scoring chunk", () => {
  // Mirror recall.js's collapse: fused entries with chunk-ids -> best per fact.
  const fused = [
    { memory_id: "mem_g#0", rrf_score: 0.10 },
    { memory_id: "mem_g#1", rrf_score: 0.42 }, // best chunk for mem_g
    { memory_id: "mem_g#2", rrf_score: 0.31 },
    { memory_id: "mem_solo", rrf_score: 0.20 }, // non-chunked fact
  ];
  const bestByFact = new Map();
  for (const f of fused) {
    const factId = _stripChunkSuffix(f.memory_id);
    const prev = bestByFact.get(factId);
    if (prev === undefined || f.rrf_score > prev.rrf_score) bestByFact.set(factId, f);
  }
  // Emit-once-in-order pass.
  const seen = new Set();
  const candidates = [];
  for (const f of fused) {
    const factId = _stripChunkSuffix(f.memory_id);
    if (seen.has(factId)) continue;
    seen.add(factId);
    candidates.push({ memory_id: factId, rrf_score: bestByFact.get(factId).rrf_score });
  }
  // mem_g appears exactly ONCE despite three chunks; mem_solo once.
  const ids = candidates.map((c) => c.memory_id);
  assert.deepEqual(ids, ["mem_g", "mem_solo"], "one candidate per fact, fused order");
  const g = candidates.find((c) => c.memory_id === "mem_g");
  assert.equal(g.rrf_score, 0.42, "kept the BEST-scoring chunk as the representative");
  assert.equal(ids.filter((i) => i === "mem_g").length, 1, "no chunk-id duplicates leak");
});

// ===========================================================================
// B. s_emb sidecar overlay — the core gap fix + back-compat invariants.
// ===========================================================================

test("B1: GAP fixture — row lacks embedding_4096; overlay pulls index vec -> s_emb fires", () => {
  // The canonical gap: a pre-existing fact whose ledger row has NO embedding_4096
  // (rowToIndexEntry -> null) but whose 4096 vector lives in the index.
  const h = new HnswIndex({ dims: DIM, embedding_model_version: "qwen3-embedding-8b-fp16" });
  h.add("mem_gap", unitSpike(9));
  const gapCandidate = { memory_id: "mem_gap", embedding_4096: null, embedding_3072: null };

  // Pre-fix behavior: _selectSameDimEmbedding (row only) returns null -> s_emb=0.
  assert.equal(_selectSameDimEmbedding(gapCandidate, DIM), null, "row-only selection is null (the bug)");

  // Post-fix: the overlay resolves the index vector -> a usable 4096 vector.
  const resolved = _resolveCandidateEmbedding(gapCandidate, h, DIM);
  assert.ok(Array.isArray(resolved), "overlay returns a vector for the gap fact");
  assert.equal(resolved.length, DIM, "overlay vector is 4096-dim");
  assert.equal(resolved[9], 1, "overlay returned the index-resident vector");
  // s_emb (cosine == dot for unit vectors) against a matching query is > 0.
  let dot = 0;
  const query = unitSpike(9);
  for (let i = 0; i < DIM; i++) dot += query[i] * resolved[i];
  assert.ok(dot > 0, "s_emb transitions 0 -> >0 with the overlay (gap closed)");
});

test("B2: CONTROL — a NEW fact carrying row embedding_4096 uses the ROW vector (overlay never fires)", () => {
  const h = new HnswIndex({ dims: DIM, embedding_model_version: "qwen3-embedding-8b-fp16" });
  // Index holds a DIFFERENT vector for the same id; the row vector must win so we
  // prove the overlay does not override a row-carried embedding.
  h.add("mem_new", unitSpike(2));
  const rowCandidate = { memory_id: "mem_new", embedding_4096: unitSpike(7), embedding_3072: null };
  const resolved = _resolveCandidateEmbedding(rowCandidate, h, DIM);
  assert.ok(Array.isArray(resolved), "control returns a vector");
  assert.equal(resolved[7], 1, "control uses the ROW vector (spike@7)");
  assert.equal(resolved[2], 0, "control did NOT pick up the index vector (spike@2)");
});

test("B3: a 3072-only fact under a 3072 query resolves to NOTHING (no row arm, no 4096 overlay)", () => {
  // The index only has 4096 vectors. A legacy gemini fact (row embedding_3072,
  // no embedding_4096) under a 3072 query must NOT receive the 4096 index
  // vector (geometry-mix guard).
  //
  // l5-fallback-removal RETARGET: this used to assert the candidate resolved to
  // its ROW 3072 vector, via _selectSameDimEmbedding's 3072 selection arm. That
  // arm was deleted together with the legacy-coverage fallback branch that was
  // the only writer of a 3072-dim query vector (FL-24 binds them), so BOTH legs
  // of _resolveCandidateEmbedding now decline: the row leg no longer reads
  // embedding_3072, and the overlay leg length-rejects the 4096 index vector.
  // The result is null -> s_emb=0, which is the correct no-measurable-geometry
  // answer. The assertion still discriminates the regression it was written
  // for: a geometry-mix bug handing back the indexed 4096 spike makes this
  // non-null.
  const h = new HnswIndex({ dims: DIM, embedding_model_version: "qwen3-embedding-8b-fp16" });
  h.add("mem_gem", unitSpike(3)); // a 4096 index vector exists for this id
  const geminiCandidate = {
    memory_id: "mem_gem",
    embedding_4096: null,
    embedding_3072: unitSpike(4, GEMINI_DIM),
  };
  assert.equal(
    _resolveCandidateEmbedding(geminiCandidate, h, GEMINI_DIM),
    null,
    "no 3072 row arm and no cross-geometry overlay -> null (s_emb=0)",
  );
  // Positive control (anti-vacuity), KEPT — independently true before and after
  // l5. The candidate carries no embedding_4096, and its 3072 row vector is
  // length-rejected against a 4096 query, so the candidate falls through to the
  // index overlay and returns the indexed 4096 spike. This pins the OTHER side
  // of the geometry guard: the 3072-query refusal above is the guard firing,
  // not a dead harness.
  const overlaid = _resolveCandidateEmbedding(geminiCandidate, h, DIM);
  assert.ok(
    Array.isArray(overlaid) && overlaid.length === DIM,
    "the 4096 index vector still overlays under a matching 4096 query",
  );
  assert.equal(overlaid[3], 1, "the overlay returns the indexed 4096 spike");
});

test("B4: GEOMETRY guard — overlay rejects an index vector whose dim != query dim", () => {
  // A pre-existing fact with no row vector, queried under 3072: the index holds a
  // 4096 vector for it. The overlay MUST reject it (wrong geometry) -> null.
  const h = new HnswIndex({ dims: DIM, embedding_model_version: "qwen3-embedding-8b-fp16" });
  h.add("mem_x", unitSpike(1));
  const cand = { memory_id: "mem_x", embedding_4096: null, embedding_3072: null };
  assert.equal(
    _resolveCandidateEmbedding(cand, h, GEMINI_DIM),
    null,
    "4096 index vector is rejected for a 3072 query (no geometry mix)",
  );
  // Same fact under the matching 4096 query DOES overlay.
  const ok = _resolveCandidateEmbedding(cand, h, DIM);
  assert.ok(Array.isArray(ok) && ok.length === DIM, "matching dim overlays cleanly");
});

test("B5: DEFENSIVE — missing hnsw / missing getter / bad id never throws, returns null", () => {
  const cand = { memory_id: "mem_y", embedding_4096: null };
  assert.equal(_resolveCandidateEmbedding(cand, null, DIM), null, "null hnsw -> null");
  assert.equal(_resolveCandidateEmbedding(cand, {}, DIM), null, "hnsw without getter -> null");
  const throwing = { getVectorByMemoryId() { throw new Error("boom"); } };
  assert.equal(_resolveCandidateEmbedding(cand, throwing, DIM), null, "a throwing getter is swallowed -> null");
  assert.equal(_resolveCandidateEmbedding(null, {}, DIM), null, "null candidate -> null");
  assert.equal(_resolveCandidateEmbedding({ memory_id: "" }, {}, DIM), null, "empty memory_id -> null");
});

test("B6: CHUNK fact — overlay resolves via the WINNING chunk-id, NOT the bare fact id", () => {
  // PRODUCTION REALITY: a giant's vectors are stored in the index ONLY under
  // chunk-ids (`${factId}#${k}`) — the bare factId is NEVER an index key. recall
  // strips chunk-ids to the factId for the LEDGER row, but must keep the winning
  // chunk-id (candidate.index_vector_id) so the s_emb overlay can fetch THAT
  // chunk's vector. (The prior version of this test stored under the bare id,
  // which production never does — a false green. This reflects the real index.)
  const h = new HnswIndex({ dims: DIM, embedding_model_version: "qwen3-embedding-8b-fp16" });
  h.add("mem_chunked#0", unitSpike(7));
  h.add("mem_chunked#1", unitSpike(12)); // the dedup-winning chunk for this query
  h.add("mem_chunked#2", unitSpike(20));

  // 1. The bug: bare-factId lookup MISSES (no vector stored under it).
  assert.equal(
    h.getVectorByMemoryId(_stripChunkSuffix("mem_chunked#1")), null,
    "bare factId is NOT an index key for a chunked giant (the gap)",
  );

  // 2. The fix: candidate carries memory_id=factId (for the row) AND
  //    index_vector_id=winning chunk-id (for the vector). Overlay resolves it.
  const cand = {
    memory_id: _stripChunkSuffix("mem_chunked#1"), // "mem_chunked" — for the ledger row
    index_vector_id: "mem_chunked#1",              // winning chunk — for the vector
    embedding_4096: null,                          // existing fact: no row vector
  };
  assert.equal(cand.memory_id, "mem_chunked", "candidate row id is the stripped factId");
  const resolved = _resolveCandidateEmbedding(cand, h, DIM);
  assert.ok(Array.isArray(resolved), "overlay resolves a vector (not s_emb=0)");
  assert.equal(resolved[12], 1, "it is the WINNING chunk's vector (chunk#1), via the chunk-id fallback");

  // 3. Without index_vector_id (regression guard), the giant correctly falls to
  //    null — proving the fix, not the bare lookup, is what saves it.
  const candNoChunk = { memory_id: "mem_chunked", embedding_4096: null };
  assert.equal(
    _resolveCandidateEmbedding(candNoChunk, h, DIM), null,
    "without the winning chunk-id, the giant would rescore at s_emb=0 (the original bug)",
  );
});

// ===========================================================================
// E. E3 2026-09 — the child's ledger reader and its completeness count.
//
// Two defects wedged the live drain at offset 7092821 (599 refused ticks,
// 2026-09-04 .. 2026-09-15): collectContents read the ledger through
// node:readline, which tears a row on U+2028 and drops it silently; and the
// child counted a chunked giant whose every `${id}#k` chunk was already in the
// sidecar as `pending`, so the parent's exact `matched === pending` rule could
// never hold. E1 pins the reader; E2-E4 pin planEmbedItems, the completeness
// count the drain's residual r6-4 was waiting on. Hermetic: a tmp ledger and
// in-memory sets; the live ledger and sidecar are never opened.
// ===========================================================================

test("E1: collectContents resolves a row containing U+2028 intact and skips non-fact / empty-content rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reembed-e3-"));
  try {
    const ledgerPath = join(dir, "memory.jsonl");
    const rows = [
      { kind: "fact", id: "mem_u2028", content: "before after" },
      { kind: "fact", id: "mem_plain", content: "plain content" },
      { kind: "note", id: "mem_note", content: "not a fact row" },
      { kind: "fact", id: "mem_empty", content: "" },
    ];
    const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    // Non-vacuity: JSON.stringify really leaves U+2028 unescaped, so the
    // fixture carries the raw separator a readline reader would split on.
    assert.ok(body.includes(" "), "fixture carries a raw U+2028 inside a JSON string");
    writeFileSync(ledgerPath, body);

    const want = new Set(["mem_u2028", "mem_plain", "mem_note", "mem_empty", "mem_ghost"]);
    const out = await collectContents(want, { ledgerPath });

    assert.deepEqual([...out.keys()].sort(), ["mem_plain", "mem_u2028"],
      "exactly the two non-empty fact rows resolve");
    const u = out.get("mem_u2028");
    assert.equal(u.content, "before after", "the U+2028 row's content is returned intact");
    assert.ok(u.content.includes(" "), "the separator survives (not torn, not stripped)");
    assert.equal(u.content.charCodeAt(6), 0x2028, "char code 0x2028 is present at its position");
    assert.equal(u.row.id, "mem_u2028", "the whole row is retained for the contextual path");
    assert.equal(out.get("mem_plain").content, "plain content");
    assert.equal(out.has("mem_note"), false, "kind !== \"fact\" is skipped");
    assert.equal(out.has("mem_empty"), false, "content.length === 0 is skipped");
    assert.equal(out.has("mem_ghost"), false, "an id with no ledger row resolves nothing (stays pending upstream)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// E4 2026-09 — latest-write-wins through collectContents. streamLedgerRowsById
// used to short-circuit once every wanted id had been seen ONCE, so a
// re-appended id resolved to its FIRST row (observed: [a:OLD, b, a:NEW] =>
// a:OLD) while this reader's comment claimed the opposite. The helper's own
// gate is test/synthesis/ledger-stream-by-id.test.mjs; E1b pins the claim at
// the reembed reader, including that the content.length === 0 skip applies to
// the WINNING (latest) row, not the first one.
test("E1b: collectContents resolves a re-appended id to its LATEST row (latest-write-wins), and an empty latest row resolves nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reembed-e4-"));
  try {
    const ledgerPath = join(dir, "memory.jsonl");
    const rows = [
      { kind: "fact", id: "mem_a", content: "OLD", marker: "first" },
      { kind: "fact", id: "mem_b", content: "b-content" },
      { kind: "fact", id: "mem_a", content: "NEW", marker: "last" },
      { kind: "fact", id: "mem_emptied", content: "had content once" },
      { kind: "fact", id: "mem_emptied", content: "" },
    ];
    writeFileSync(ledgerPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const want = new Set(["mem_a", "mem_b", "mem_emptied"]);
    const out = await collectContents(want, { ledgerPath });

    assert.deepEqual([...out.keys()].sort(), ["mem_a", "mem_b"],
      "mem_a and mem_b resolve; the re-appended id whose latest row is empty does not");
    assert.equal(out.get("mem_a").content, "NEW", "the re-appended id returns its LATEST content");
    assert.equal(out.get("mem_a").row.marker, "last", "the retained row is the later row, not the first");
    assert.equal(out.get("mem_b").content, "b-content");
    assert.equal(out.has("mem_emptied"), false,
      "the content.length === 0 skip applies to the winning (latest) row — the earlier non-empty row does not resurrect it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A giant that chunksFor packs into EXACTLY three windows: nine 2,000-char
// turns joined by the turn delimiter pack three-per-window under WINDOW=7,200
// with the 720-char overlap carried across edges (verified by the assertion in
// E2, not assumed).
function threeChunkGiant() {
  const turns = [];
  for (let i = 0; i < 9; i++) turns.push(String.fromCharCode(97 + i).repeat(2000));
  return turns.join(TURN);
}

function giantContents(text) {
  return new Map([["giant", { content: text, row: { id: "giant", content: text } }]]);
}

test("E2: planEmbedItems — a giant whose EVERY chunk is in the sidecar is complete: pending 0, no items, 3 resumed", () => {
  const text = threeChunkGiant();
  assert.ok(text.length > WINDOW, "the fixture is over the window, so it chunks");
  const cs = chunksFor("giant", text);
  assert.deepEqual(cs.map((c) => c.id), ["giant#0", "giant#1", "giant#2"], "chunksFor yields exactly 3 chunks");

  const contents = giantContents(text);
  const done = new Set(["giant#0", "giant#1", "giant#2"]);
  const want = new Set(["giant"]);
  const plan = planEmbedItems({ contents, done, want, contextual: false, conversationIndex: null });

  assert.equal(plan.pendingAfterResume, 0, "a chunk-complete giant is NOT pending");
  assert.equal(plan.items.length, 0, "nothing is re-embedded");
  assert.equal(plan.resumedChunkItems, 3, "all three chunk ids were skipped by item-level resume");
  assert.equal(plan.chunkedFacts, 1);
  assert.equal(plan.chunkVectors, 3);
  assert.equal(plan.prefixedFacts, 0);

  // PURE: inputs untouched, and the same inputs give the same answer twice.
  assert.equal(done.size, 3);
  assert.equal(contents.size, 1);
  assert.equal(want.size, 1);
  assert.deepEqual(planEmbedItems({ contents, done, want, contextual: false, conversationIndex: null }), plan);
});

test("E3: planEmbedItems — one missing chunk keeps the giant pending and emits exactly that chunk", () => {
  const text = threeChunkGiant();
  const contents = giantContents(text);
  const done = new Set(["giant#0", "giant#2"]); // #1 never landed
  const plan = planEmbedItems({ contents, done, want: new Set(["giant"]), contextual: false, conversationIndex: null });

  assert.equal(plan.pendingAfterResume, 1, "an incomplete giant stays pending");
  assert.deepEqual(plan.items.map((it) => it.id), ["giant#1"], "exactly the missing chunk is embedded");
  assert.equal(plan.resumedChunkItems, 2, "the two present chunks are still skipped (per-chunk resume unchanged)");
  assert.equal(plan.chunkedFacts, 1);
  assert.equal(plan.chunkVectors, 3);
});

test("E4: planEmbedItems — an id in want with no resolved content stays pending (unresolvable rows stall loudly)", () => {
  const text = threeChunkGiant();
  const contents = new Map([
    ...giantContents(text),
    ["plain", { content: "a whole fact", row: { id: "plain", content: "a whole fact" } }],
  ]);
  // Everything that resolved is fully embedded; `ghost` never resolved (the
  // live shape: mem_0000000000000001 torn by readline, or any row the ledger
  // does not yield).
  const done = new Set(["giant#0", "giant#1", "giant#2", "plain"]);
  const want = new Set(["giant", "plain", "ghost"]);
  const plan = planEmbedItems({ contents, done, want, contextual: false, conversationIndex: null });

  assert.equal(plan.pendingAfterResume, 1, "ghost is counted pending even though nothing can be embedded for it");
  assert.equal(plan.items.length, 0, "no work item exists for an unresolvable id — the parent must see the shortfall");
  assert.equal(plan.resumedChunkItems, 4, "the bare id of a whole fact resumes like a chunk id");

  // Control: a whole fact that is NOT in the sidecar is pending AND emitted.
  const fresh = planEmbedItems({
    contents, done: new Set(["giant#0", "giant#1", "giant#2"]), want, contextual: false, conversationIndex: null,
  });
  assert.equal(fresh.pendingAfterResume, 2, "plain (unembedded) + ghost (unresolved)");
  assert.deepEqual(fresh.items.map((it) => it.id), ["plain"]);
});
