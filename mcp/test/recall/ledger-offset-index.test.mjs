// ledger-offset-index.test.mjs — WU-recall-latency-fix regression gate.
//
// AUTHORITATIVE problem statement (measured grounding plan):
//   "dominant cost is ledger row resolution not hnsw load ... loadLedgerRowsByIds
//    streams the 1.8 GB ledger per query 5.2s 83 percent."
//   recommended_fix: "index cache fix seek ledger rows by offset via sidecar not
//    full stream"; implementation: "rewrite loadLedgerRowsByIds to seek rows by
//    byte offset via a sidecar or tail merge mtime cache".
//
// WHAT THIS TEST GUARDS:
//   1. The offset index builds a memory_id -> {offset,len} map over the append-
//      only ledger, and seekLedgerRowsByIds resolves wanted rows by BYTE OFFSET
//      (round-trip: seek result == the actual ledger row).
//   2. TAIL-MERGE: after appending new rows, buildOffsetIndex re-scans ONLY the
//      appended bytes (the cache object is reused; the newly appended id resolves)
//      — the cache-hit-no-full-reload behavior the plan requires.
//   3. loadLedgerRowsByIds (the recall hot path) returns BYTE-IDENTICAL results
//      to the legacy full-stream resolver, scoped, kind-tolerant (reconstructed
//      rows resolve), latest-write-wins, empty/array/missing back-compat.
//   4. STALE-OFFSET SAFETY: a wrong offset never returns a wrong row — the per-id
//      verification falls back to the scoped stream and resolves correctly.
//   5. SIDECAR round-trip: writeOffsetSidecar + a cold reload resolve identically.
//   6. FULL-4096 RESCORE FIDELITY preserved: end-to-end recall over the offset-
//      resolved candidate path still ranks the 4096 nearest-neighbor fact #1
//      (the cosine rescore stays full-4096; the operator's full-fidelity floor).
//   7. Back-compat with the EXISTING index: recall over a fixture with NO offset
//      sidecar still resolves (index built in-process; legacy callers unaffected).
//
// HERMETICITY: mkdtempSync root + env vars set BEFORE any dynamic import of
// memory-system modules (standing C-NEW-2 pattern). The local embedder fetch is
// MOCKED and (b4) Layer-3 is pinned LOCAL_RERANKER_ENABLED="0" at the env seam
// below, so no live server is required. Both halves are load-bearing: mocking
// the embedder alone left recall dialing the rerank daemon on :8360, which is
// what this sentence used to claim it did not. Production paths are snapshotted
// pre/post and asserted byte-identical — we NEVER touch the live index dir or
// ledger.
//
// Run: node test/recall/ledger-offset-index.test.mjs

import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  appendFileSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skipIfDaemonActive } from "../_hermetic-daemon-skip.mjs";
skipIfDaemonActive("WU-recall-latency-fix ledger-offset-index");

// The checkout this suite runs from. Its default (un-overridden) ledgers,
// policy and indices are what the byte-identity guards below watch; the
// suite itself works under a temp MEMORY_ROOT.
const CHECKOUT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// ---------------------------------------------------------------------------
// Production-path snapshot BEFORE any work (hermeticity invariant).
// ---------------------------------------------------------------------------
const PROD_MEMORY_JSONL = join(CHECKOUT_ROOT, "ledgers", "memory.jsonl");
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
  indices: snap(PROD_INDICES_DIR),
};

// ---------------------------------------------------------------------------
// Hermetic root + env BEFORE dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-offset-index-"));
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
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;
// b4: the key scrub above governs the gemini backend only. An UNSET
// LOCAL_RERANKER_ENABLED falls through to CAPS.LOCAL_RERANKER_ENABLED (true),
// which skips the gemini key gate and sends the default backend at _baseUrl()
// to the LIVE rerank daemon on :8360. "0" is the tri-state OFF override (a
// `delete` is inert against a true CAP); it restores the api_key_missing
// degrade and opens no socket.
process.env.LOCAL_RERANKER_ENABLED = "0";

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ---------------------------------------------------------------------------
// Dynamic imports AFTER env override.
// ---------------------------------------------------------------------------
const { memoryLedgerPath } = await import("../../lib/config.js");
const offsetMod = await import("../../lib/recall/ledger-offset-index.js");
const {
  buildOffsetIndex,
  seekLedgerRowsByIds,
  writeOffsetSidecar,
  offsetSidecarPath,
  _resetOffsetCaches,
  _peekCachedIndex,
  _setAfterStatHookForTests,
  _extractIdFromLine,
} = offsetMod;
const indexCacheMod = await import("../../lib/recall/index-cache.js");
const { loadLedger, loadLedgerRowsByIds, saveIndices, _resetCaches } =
  indexCacheMod;
const { Bm25Index } = await import("../../lib/recall/bm25-index.js");
const { HnswIndex } = await import("../../lib/recall/hnsw-index.js");
const { CAPS } = await import("../../lib/validation.js");
const localEmbedMod = await import("../../lib/local-embedder-client.js");
const { _setFetchForTests } = localEmbedMod;
const recallMod = await import("../../lib/tools/recall.js");

const ACTIVE_VERSION = CAPS.ACTIVE_EMBED_MODEL_VERSION;
const DIM = CAPS.EMBEDDING_DIM_4096;

const LEDGER = memoryLedgerPath();
const TS = "2026-06-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Fixture helpers.
// ---------------------------------------------------------------------------
function factRow(id, content, extra = {}) {
  return {
    id,
    kind: "fact",
    content,
    created_at: TS,
    ts: TS,
    source_refs: [{ source: "test", consent_basis: "first_party" }],
    features: { embedding_model_version: ACTIVE_VERSION },
    ...extra,
  };
}

// Write a fresh fixture ledger (overwrite) and reset every cache so the next
// resolve rebuilds from byte 0.
function writeLedger(rows) {
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(LEDGER, body, { mode: 0o600 });
  _resetCaches(); // also clears the offset cache (WU-recall-latency-fix wiring)
}

// Append rows to the ledger WITHOUT clearing caches (exercises tail-merge).
function appendLedger(rows) {
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  appendFileSync(LEDGER, body, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Build a base fixture: 200 filler facts + a handful of known ids, incl. a
// reconstructed row and a non-ASCII id (to exercise byte-vs-char offsets).
// ---------------------------------------------------------------------------
const KNOWN = "fact_known_quokka";
const PARENT = "fact_parent_alpha";
const RECON = "recon_zeta";
const UNICODE_ID = "fact_café_résumé"; // multi-byte UTF-8 in the id
const baseRows = [];
for (let i = 0; i < 200; i++) {
  baseRows.push(factRow(`bulk_${String(i).padStart(4, "0")}`, `filler row ${i} pad pad`));
}
baseRows.push(factRow(KNOWN, "the rare quokka marsupial on rottnest island"));
baseRows.push(factRow(PARENT, "alpha parent fact content for derivation"));
baseRows.push(factRow(UNICODE_ID, "a fact whose id has café résumé accents"));
baseRows.push({
  id: RECON,
  kind: "reconstructed",
  content: "reconstructed synthesis derived from alpha note quokka",
  created_at: TS,
  ts: TS,
  derived_from: [PARENT],
  source_refs: [{ source: "test", consent_basis: "first_party" }],
  features: { embedding_model_version: ACTIVE_VERSION },
});

// ===========================================================================
// T1 — _extractIdFromLine pulls the id cheaply (incl. escaped/unicode ids).
// ===========================================================================
test("T1: _extractIdFromLine extracts ids without a full parse, handles unicode + escapes", () => {
  assert.equal(
    _extractIdFromLine(JSON.stringify({ id: "abc123", content: "x" })),
    "abc123",
    "plain id",
  );
  assert.equal(
    _extractIdFromLine(JSON.stringify({ id: UNICODE_ID, content: "y" })),
    UNICODE_ID,
    "unicode id round-trips",
  );
  assert.equal(
    _extractIdFromLine(JSON.stringify({ id: 'has"quote', content: "z" })),
    'has"quote',
    "escaped-quote id",
  );
  assert.equal(
    _extractIdFromLine(JSON.stringify({ kind: "policy", note: "no id here" })),
    null,
    "row with no string id -> null",
  );
  assert.equal(_extractIdFromLine("not json at all"), null, "garbage -> null");
});

// ===========================================================================
// T2 — buildOffsetIndex + seekLedgerRowsByIds round-trip: seeked rows EXACTLY
//      equal the actual ledger rows; only the wanted ids are returned.
// ===========================================================================
test("T2: offset-seek round-trips the actual ledger rows (scoped to wanted ids)", () => {
  writeLedger(baseRows);
  const index = buildOffsetIndex(LEDGER);
  assert.ok(index && index.byId instanceof Map, "index built");
  assert.ok(index.byId.has(KNOWN), "index records the known id");
  assert.ok(index.byId.has(UNICODE_ID), "index records the unicode id");
  assert.equal(index.byId.size, baseRows.length, "index covers every row");

  const wanted = new Set([KNOWN, PARENT, RECON, UNICODE_ID]);
  const seeked = seekLedgerRowsByIds(LEDGER, wanted);
  assert.equal(seeked.indexed, true, "indexed path used");
  assert.equal(seeked.byId.size, 4, "exactly the 4 wanted rows (not all 204)");
  assert.equal(seeked.misses, 0, "no misses");
  assert.equal(
    seeked.byId.get(KNOWN).content,
    "the rare quokka marsupial on rottnest island",
    "known row content round-trips byte-for-byte",
  );
  assert.equal(
    seeked.byId.get(RECON).kind,
    "reconstructed",
    "reconstructed kind preserved (kind-tolerant, not fact-only)",
  );
  assert.equal(
    seeked.byId.get(UNICODE_ID).content,
    "a fact whose id has café résumé accents",
    "unicode row resolves at its BYTE offset (not char offset)",
  );
  assert.equal(seeked.byId.has("bulk_0001"), false, "non-wanted id excluded");
});

// ===========================================================================
// T3 — TAIL-MERGE: append a new row; buildOffsetIndex re-scans ONLY the
//      appended bytes (the SAME cache object is reused) and the new id resolves.
//      This is the "cache-hit-no-full-reload" the plan requires.
// ===========================================================================
test("T3: tail-merge indexes appended rows without a full re-scan", () => {
  writeLedger(baseRows);
  const first = buildOffsetIndex(LEDGER);
  const firstByIdRef = first.byId;
  const firstSize = first.size;
  assert.equal(firstByIdRef.has("fact_appended_zzz"), false, "new id not yet present");

  // Append a brand-new fact AFTER the current EOF (append-only invariant).
  const NEW_ID = "fact_appended_zzz";
  appendLedger([factRow(NEW_ID, "freshly appended quokka fact")]);

  const second = buildOffsetIndex(LEDGER);
  // The cache object is REUSED (tail-merge mutates it in place) — proof we did
  // not rebuild from scratch.
  assert.equal(second.byId, firstByIdRef, "same cache Map reused (no rebuild)");
  assert.ok(second.size > firstSize, "indexed size advanced to new EOF");
  assert.ok(second.byId.has(NEW_ID), "appended id now indexed");

  const seeked = seekLedgerRowsByIds(LEDGER, new Set([NEW_ID]));
  assert.equal(seeked.byId.size, 1, "appended row resolves via seek");
  assert.equal(
    seeked.byId.get(NEW_ID).content,
    "freshly appended quokka fact",
    "appended row content correct after tail-merge",
  );
});

// ===========================================================================
// T4 — loadLedgerRowsByIds PARITY: the offset-accelerated resolver returns the
//      SAME rows the legacy full-stream loadLedger().byId would, scoped.
// ===========================================================================
test("T4: loadLedgerRowsByIds matches the legacy full-stream resolution, scoped", () => {
  writeLedger(baseRows);
  const wanted = new Set([KNOWN, PARENT, RECON, UNICODE_ID]);
  const fast = loadLedgerRowsByIds(wanted);
  assert.ok(fast.byId instanceof Map, "returns {byId} Map");
  assert.equal(fast.byId.size, 4, "scoped to the wanted ids");

  // Ground truth via the legacy full-ledger reader.
  const full = loadLedger();
  for (const id of wanted) {
    assert.deepEqual(
      fast.byId.get(id),
      full.byId.get(id),
      `row ${id} identical to legacy full-stream resolution`,
    );
  }
  assert.equal(fast.byId.has("bulk_0050"), false, "non-wanted id absent");

  // Back-compat surfaces.
  const empty = loadLedgerRowsByIds(new Set());
  assert.equal(empty.byId.size, 0, "empty set -> empty Map");
  const arr = loadLedgerRowsByIds([KNOWN]);
  assert.equal(arr.byId.size, 1, "array input tolerated");
  assert.ok(arr.byId.has(KNOWN), "array input resolves the id");
});

// ===========================================================================
// T5 — LATEST-WRITE-WINS: a later row for the same id overwrites the earlier
//      one (the offset index records the LAST offset; matches Map.set order).
// ===========================================================================
test("T5: latest-write-wins for a duplicated id", () => {
  const DUP = "fact_dup";
  const rows = [
    factRow(DUP, "first version of the dup fact"),
    factRow("other_a", "another fact"),
    factRow(DUP, "SECOND newer version of the dup fact"),
  ];
  writeLedger(rows);
  const seeked = seekLedgerRowsByIds(LEDGER, new Set([DUP]));
  assert.equal(
    seeked.byId.get(DUP).content,
    "SECOND newer version of the dup fact",
    "latest write wins via offset index",
  );
  const viaLoad = loadLedgerRowsByIds(new Set([DUP]));
  assert.equal(
    viaLoad.byId.get(DUP).content,
    "SECOND newer version of the dup fact",
    "loadLedgerRowsByIds agrees (latest write wins)",
  );
});

// ===========================================================================
// T6 — STALE-OFFSET SAFETY: a wrong/poisoned offset never returns a wrong row.
//      We corrupt the cached offset for KNOWN to point at a DIFFERENT row; the
//      per-id verification rejects it, loadLedgerRowsByIds back-fills via the
//      scoped stream, and the CORRECT row is still returned.
// ===========================================================================
test("T6: a stale offset never returns a wrong row (verify + stream back-fill)", () => {
  writeLedger(baseRows);
  // Prime the cache.
  buildOffsetIndex(LEDGER);
  const cached = _peekCachedIndex(LEDGER);
  assert.ok(cached, "offset cache primed");
  // Poison KNOWN's offset -> point it at PARENT's bytes (a real but WRONG row).
  const parentEnt = cached.byId.get(PARENT);
  assert.ok(parentEnt, "parent entry present");
  cached.byId.set(KNOWN, { offset: parentEnt.offset, len: parentEnt.len });

  // Direct seek: KNOWN must be a MISS (verification: parsed row.id !== KNOWN).
  const seeked = seekLedgerRowsByIds(LEDGER, new Set([KNOWN]));
  assert.equal(seeked.byId.has(KNOWN), false, "poisoned offset -> verification miss, no wrong row");
  assert.equal(seeked.misses, 1, "counted as a miss");

  // loadLedgerRowsByIds back-fills the missed id via the scoped stream and
  // returns the CORRECT row regardless of the poisoned offset.
  const fast = loadLedgerRowsByIds(new Set([KNOWN]));
  assert.equal(
    fast.byId.get(KNOWN).content,
    "the rare quokka marsupial on rottnest island",
    "correct row recovered via stream back-fill (never a wrong row)",
  );
});

// ===========================================================================
// T7 — SIDECAR round-trip: writeOffsetSidecar persists; a cold reload (cache
//      cleared) reads the sidecar + tail-merges, and resolution is identical.
// ===========================================================================
test("T7: offset sidecar persists and reloads cold, tail-merging new appends", () => {
  writeLedger(baseRows);
  const written = writeOffsetSidecar(LEDGER);
  assert.ok(written === baseRows.length, `sidecar wrote ${baseRows.length} entries (got ${written})`);
  assert.ok(existsSync(offsetSidecarPath(LEDGER)), "sidecar file exists on disk");

  // Append AFTER the sidecar was written (so the cold load must tail-merge).
  const SIDE_NEW = "fact_after_sidecar";
  appendLedger([factRow(SIDE_NEW, "appended after the sidecar was written quokka")]);

  // Cold process simulation: drop the in-memory cache; force a sidecar load.
  _resetOffsetCaches();
  const seeked = seekLedgerRowsByIds(LEDGER, new Set([KNOWN, SIDE_NEW]));
  assert.equal(seeked.byId.size, 2, "both pre-sidecar and post-sidecar rows resolve cold");
  assert.equal(
    seeked.byId.get(KNOWN).content,
    "the rare quokka marsupial on rottnest island",
    "pre-sidecar row resolves from the loaded sidecar",
  );
  assert.equal(
    seeked.byId.get(SIDE_NEW).content,
    "appended after the sidecar was written quokka",
    "post-sidecar row resolves via cold tail-merge",
  );
});

// ===========================================================================
// T8 — FULL-4096 RESCORE FIDELITY preserved end-to-end. Build a 4096 fixture
//      index; the fact whose embedding_4096 is the query's nearest neighbor
//      (cosine 1.0) must rank #1. This proves the offset-resolved candidate
//      path feeds the full-4096 cosine rescore unchanged (operator's floor).
// ===========================================================================
function unitSpike(idx, dim = DIM) {
  const v = new Array(dim).fill(0);
  v[idx % dim] = 1;
  return v;
}
const PROBE_WORD = "quokka";
function embedFact(id, content, spikeIndex) {
  const features = { embedding_model_version: ACTIVE_VERSION };
  if (spikeIndex !== null) features.embedding_4096 = unitSpike(spikeIndex);
  return {
    id,
    kind: "fact",
    content,
    created_at: TS,
    ts: TS,
    source_refs: [{ source: "test", consent_basis: "first_party" }],
    features,
  };
}
function installLocalEmbedMock(spikeIndex) {
  _setFetchForTests(async (url, init) => {
    const body = JSON.parse(init.body);
    const texts = Array.isArray(body.texts) ? body.texts : [];
    const embeddings = texts.map(() => unitSpike(spikeIndex));
    return {
      ok: true,
      async text() {
        return JSON.stringify({
          embeddings,
          model_version: ACTIVE_VERSION,
          dim: DIM,
          count: embeddings.length,
          elapsed_ms: 1,
        });
      },
    };
  });
}

test("T8: full-4096 rescore fidelity preserved through the offset-resolved path", async () => {
  // Query embedding spikes index 7 -> fact_match (spike 7) is the cosine-1.0 NN.
  const MATCH_SPIKE = 7;
  const rows = [
    embedFact("fact_match", `the ${PROBE_WORD} nearest neighbor target fact`, MATCH_SPIKE),
    embedFact("fact_far_a", `another ${PROBE_WORD} fact far in space`, 11),
    embedFact("fact_far_b", `a third ${PROBE_WORD} fact also far away`, 23),
    embedFact("fact_no_embed", `an unembedded ${PROBE_WORD} fact awaiting backfill`, null),
  ];
  writeLedger(rows);

  // Build the ACTIVE 4096 index (BM25 over all; HNSW over the embedded ones).
  const bm25 = new Bm25Index();
  for (const r of rows) {
    bm25.add({ memory_id: r.id, content: r.content, kind: r.kind, ts: r.ts, entities: [] });
  }
  const hnsw = new HnswIndex({ dims: DIM, embedding_model_version: ACTIVE_VERSION });
  for (const r of rows) {
    const emb = r.features && r.features.embedding_4096;
    if (Array.isArray(emb)) hnsw.add(r.id, emb);
  }
  saveIndices(ACTIVE_VERSION, { bm25, hnsw });
  _resetCaches();

  installLocalEmbedMock(MATCH_SPIKE);
  let env;
  try {
    env = await recallMod.TOOL.handler({
      surrounding_context: {
        current_query: `tell me about the ${PROBE_WORD} nearest neighbor`,
        recent_turns: [{ role: "user", content: `${PROBE_WORD} facts please` }],
        agent_role: "assistant",
        time: "2026-06-02T12:00:00.000Z",
        ambient: null,
        recent_recall_ids: [],
      },
      conversation_id: "conv_offset_fidelity",
      max_items: 12,
      max_chars: 4000,
    });
  } finally {
    _setFetchForTests(null);
  }
  assert.ok(env && env.ok === true, "recall ok envelope");
  const data = env.data || {};
  assert.equal(data.degraded_recall, false, "dense leg ran (NOT degraded) — local embed + 4096 index live");
  const memIds = Array.isArray(data.memories) ? data.memories.map((m) => m.id) : [];
  assert.ok(memIds.length >= 1, "at least one candidate resolved via the offset path");
  assert.ok(memIds.includes("fact_match"), "the 4096 NN fact surfaced");
  assert.equal(memIds[0], "fact_match", "the full-4096 nearest-neighbor fact ranks #1 (fidelity preserved)");
});

// ===========================================================================
// T9 — BACK-COMPAT with the EXISTING index: a fixture with NO offset sidecar
//      still resolves end-to-end (index built in-process). Degraded BM25-only
//      path (no embed mock) still returns the BM25-matched fact.
// ===========================================================================
test("T9: back-compat — recall resolves with NO offset sidecar present (built in-process)", async () => {
  // Fresh fixture, NO sidecar on disk. Remove any sidecar a prior test wrote so
  // this models the genuine "existing index, never had an offset sidecar" case.
  const rows = [
    factRow(KNOWN, "the rare quokka marsupial on rottnest island"),
    factRow("noise_1", "an unrelated fact about something else entirely"),
  ];
  writeLedger(rows);
  try {
    if (existsSync(offsetSidecarPath(LEDGER))) rmSync(offsetSidecarPath(LEDGER));
  } catch {
    /* best-effort */
  }
  _resetOffsetCaches();
  assert.equal(existsSync(offsetSidecarPath(LEDGER)), false, "no sidecar on disk (back-compat case)");

  const bm25 = new Bm25Index();
  for (const r of rows) {
    bm25.add({ memory_id: r.id, content: r.content, kind: r.kind, ts: r.ts, entities: [] });
  }
  const hnsw = new HnswIndex({ dims: DIM, embedding_model_version: ACTIVE_VERSION });
  saveIndices(ACTIVE_VERSION, { bm25, hnsw });
  _resetCaches();

  // No embed mock -> the local embed step fails -> degraded BM25-only. The
  // candidate STILL resolves through the offset-or-stream resolver.
  _setFetchForTests(null);
  const env = await recallMod.TOOL.handler({
    surrounding_context: {
      current_query: "tell me about the quokka marsupial on rottnest",
      recent_turns: [{ role: "user", content: "quokka facts please" }],
      agent_role: "assistant",
      time: "2026-06-02T12:00:00.000Z",
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: "conv_offset_backcompat",
    max_items: 12,
    max_chars: 4000,
  });
  assert.ok(env && env.ok === true, "recall ok envelope (no sidecar)");
  const data = env.data || {};
  assert.ok(typeof data.candidate_set_size === "number" && data.candidate_set_size >= 1, "candidate resolved without a sidecar");
  const memIds = Array.isArray(data.memories) ? data.memories.map((m) => m.id) : [];
  assert.ok(memIds.includes(KNOWN), "BM25-matched known fact surfaced via in-process offset index");
});

// ===========================================================================
// T10 — missing-ledger + tiny-set back-compat: seek on a missing ledger reports
//       indexed=false (caller falls back), and loadLedgerRowsByIds is safe.
// ===========================================================================
test("T10: missing-ledger and degenerate inputs are safe", () => {
  _resetOffsetCaches();
  const bogus = "/tmp/does-not-exist-memsys-offset-" + Date.now() + ".jsonl";
  const seeked = seekLedgerRowsByIds(bogus, new Set(["anything"]));
  assert.equal(seeked.indexed, false, "missing ledger -> indexed=false (caller falls back)");
  assert.equal(seeked.byId.size, 0, "missing ledger -> empty result");
  assert.equal(buildOffsetIndex(bogus), null, "buildOffsetIndex returns null for a missing ledger");
  assert.equal(buildOffsetIndex(""), null, "empty path -> null");

  // loadLedgerRowsByIds on the real fixture, empty wanted -> empty.
  writeLedger(baseRows);
  const empty = loadLedgerRowsByIds([]);
  assert.equal(empty.byId.size, 0, "empty array -> empty Map");
});

// ===========================================================================
// T12 (Q4) — v2 sidecar checkpoint FAIL-CLOSED: an in-place ledger replacement
// that GROWS the file (size up, mtime forward) must NOT be served from the
// stale sidecar. The old v1 acceptance (sc.size <= st.size && sc.mtimeMs <=
// st.mtimeMs — NO prefix witness, S1 defect (b)) tail-merged over the stale
// byId and MISSED ids living in the new file's prefix; the v2 checkpoint
// witness detects the drift and full-rebuilds.
//
// RED-RUN RECORD (2026-07-15, this workspace): with the S1c soundness gate in
// buildOffsetIndex's cold branch bypassed (accept any non-null capture), this
// test FAILED exactly as designed — swap_prefix_row missed (stale sidecar
// served). Gate is falsifiable.
// ===========================================================================
test("T12: prefix-rewrite-with-growth invalidates the sidecar (fail-closed full rebuild)", async () => {
  writeLedger(baseRows);
  assert.ok(writeOffsetSidecar(LEDGER) > 0, "sidecar written for the ORIGINAL file");

  // Replace the ledger with a LARGER, different-content file: new ids in the
  // prefix region, none of the old ids. Force mtime forward so the v1-era
  // size/mtime acceptance would have trusted the stale sidecar.
  const swapRows = [];
  for (let i = 0; i < 250; i++) {
    swapRows.push(factRow(`swap_${String(i).padStart(4, "0")}`, `swapped row ${i} pad pad pad`));
  }
  swapRows.unshift(factRow("swap_prefix_row", "the very first row of the REPLACED file"));
  const body = swapRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(LEDGER, body, { mode: 0o600 });
  assert.ok(statSync(LEDGER).size > 0, "replacement written");
  _resetOffsetCaches(); // cold process simulation — sidecar is the only seed

  const seeked = seekLedgerRowsByIds(LEDGER, new Set(["swap_prefix_row", KNOWN]));
  assert.equal(
    seeked.byId.get("swap_prefix_row")?.content,
    "the very first row of the REPLACED file",
    "id living in the REPLACED prefix resolves (stale sidecar was NOT trusted)",
  );
  assert.equal(seeked.byId.has(KNOWN), false, "old-file id is gone (no stale hybrid)");
  await offsetMod._awaitPendingSidecarWrites();
});

// ===========================================================================
// T13 (Q4) — torn tail at sidecar cold load: the checkpoint's newline-safe
// eof excludes the torn bytes, so the torn row is neither absorbed from a
// stale cursor nor skipped forever — it folds once its "\n" lands.
// ===========================================================================
test("T13: torn tail excluded on cold sidecar load, absorbed once completed", async () => {
  writeLedger(baseRows);
  assert.ok(writeOffsetSidecar(LEDGER) > 0, "sidecar written");
  const TORN = "fact_torn_tail";
  appendFileSync(LEDGER, JSON.stringify(factRow(TORN, "torn quokka row")), { mode: 0o600 }); // no "\n"

  _resetOffsetCaches();
  const mid = seekLedgerRowsByIds(LEDGER, new Set([KNOWN, TORN]));
  assert.equal(mid.byId.get(KNOWN)?.content, "the rare quokka marsupial on rottnest island");
  assert.equal(mid.byId.has(TORN), false, "torn row not absorbed");

  appendFileSync(LEDGER, "\n", { mode: 0o600 }); // complete the row
  const after = seekLedgerRowsByIds(LEDGER, new Set([TORN]));
  assert.equal(after.byId.get(TORN)?.content, "torn quokka row", "completed row absorbed exactly once");
  await offsetMod._awaitPendingSidecarWrites();
});

// ===========================================================================
// T16 (Q4 FIX CYCLE 2 — reviewer's torn-tail seam): the WARM grow must honor
// the streamer's `terminated` flag. Before the fix, _scanInto absorbed torn
// lines and buildOffsetIndex recorded cached.size = raw st.size, so the next
// grow resumed MID-ROW: the completed row's offset landed at a mid-row byte
// (or was lost entirely) and every seek for that id missed for the life of
// the process.
// RED-RUN RECORD (2026-07-16, this workspace): before the fix, the torn_row
// seek below MISSED after completion (mid-row resume absorbed the fragment's
// id at a wrong offset; readLedgerRowAtOffset verification rejected it).
// ===========================================================================
test("T16: warm grow skips a torn tail and resolves the row once its newline lands", () => {
  writeLedger(baseRows);
  const first = buildOffsetIndex(LEDGER);
  const firstByIdRef = first.byId;

  // Tear a row IMMEDIATELY after its opening brace, so the torn fragment has
  // no id but the mid-row REMAINDER does — the exact shape that poisoned the
  // pre-fix resume-at-raw-size scan.
  const TORN = "torn_row_warm";
  const fullLine = JSON.stringify(factRow(TORN, "torn warm-grow quokka row"));
  const cut = 1; // "{" only
  appendFileSync(LEDGER, fullLine.slice(0, cut), { mode: 0o600 });

  const mid = buildOffsetIndex(LEDGER); // grow #1: torn tail must NOT be absorbed
  assert.equal(mid.byId, firstByIdRef, "grow reused the cache (no rebuild)");
  assert.equal(mid.byId.has(TORN), false, "torn row not absorbed by the warm grow");

  // Complete the row and append one more; grow #2 must resume at the torn
  // row's START (last-terminated offset), not the raw pre-completion size.
  const AFTER = "after_torn_row";
  appendFileSync(
    LEDGER,
    fullLine.slice(cut) + "\n" + JSON.stringify(factRow(AFTER, "row after the torn one")) + "\n",
    { mode: 0o600 },
  );
  const grown = buildOffsetIndex(LEDGER);
  assert.equal(grown.byId, firstByIdRef, "second grow still reused the cache");

  const seeked = seekLedgerRowsByIds(LEDGER, new Set([TORN, AFTER]));
  assert.equal(
    seeked.byId.get(TORN)?.content,
    "torn warm-grow quokka row",
    "completed torn row resolves via seek (offset recorded at the row START)",
  );
  assert.equal(
    seeked.byId.get(AFTER)?.content,
    "row after the torn one",
    "row following the torn one also resolves",
  );
  assert.equal(seeked.misses, 0, "no misses after the torn row completed");
});

// ===========================================================================
// T17 (OFF) — WARM GROW-MERGE APPEND RACE: an append that interleaves BETWEEN
// buildOffsetIndex's pre-scan stat and its scan must leave a COHERENT
// (size, mtimeMs) fingerprint. Before the fix the warm growth branch paired
// the post-scan safeOffset (which already absorbed the interleaved row) with
// the PRE-scan st.mtimeMs — so the cached fingerprint no longer described the
// file: the next buildOffsetIndex saw size-equal-but-mtime-moved (neither an
// exact hit nor growth) and spuriously FULL-REBUILT, swapping the byId Map
// identity. The interleave is only reachable from inside the function, so we
// drive it with the test-only _setAfterStatHookForTests seam.
//
// RED before the fix: (e) the cached mtime is the stale pre-scan value (!=
// statSync) and (g) the next build full-rebuilds (byId identity changes).
// GREEN after: post-scan mtime → coherent pair → exact hit, same byId reused.
// (f) the interleaved row is in byId either way — byId content was never wrong
// (per-seek verification is the authoritative guard); this documents that.
// ===========================================================================
test("T17: warm grow-merge with an interleaved append records a coherent post-scan mtime (exact-hit next call)", () => {
  writeLedger(baseRows);
  // (a) Prime the cache (cold build → coherent fingerprint).
  const primed = buildOffsetIndex(LEDGER);
  const primedByIdRef = primed.byId;

  // (b) Append one terminated row so the NEXT build routes to the growth branch
  //     (st.size > cached.size).
  const ROW_B = "fact_grow_b";
  appendLedger([factRow(ROW_B, "row b appended before the interleaved build")]);

  // (c) Arm the seam: fire AFTER buildOffsetIndex's pre-scan stat but BEFORE its
  //     scan. It appends ANOTHER terminated row (the interleaved daemon write)
  //     and forces the file mtime STRICTLY forward to a KNOWN future value with
  //     whole-second granularity (deterministic across macOS/APFS timestamp
  //     resolution). The scan then reads EOF-past-ROW_C while `st` (captured
  //     before the hook) still reflects the pre-interleave size.
  const ROW_C = "fact_interleaved_c";
  const futureSec = Math.floor(statSync(LEDGER).mtimeMs / 1000) + 3600;
  let fired = 0;
  _setAfterStatHookForTests(() => {
    fired += 1;
    appendLedger([factRow(ROW_C, "row c interleaved between the stat and the scan")]);
    utimesSync(LEDGER, futureSec, futureSec); // known future mtime, wins over the append's mtime
  });

  // (d) The interleaved grow-merge.
  const grown = buildOffsetIndex(LEDGER);
  _setAfterStatHookForTests(null); // clear the hook before the follow-up build
  assert.equal(fired, 1, "the interleave hook fired exactly once during the grow build");
  assert.equal(grown.byId, primedByIdRef, "grow-merge reused the cache (no rebuild on this call)");

  // (e) The cached fingerprint's mtime must equal the file's ACTUAL mtime (the
  //     forced future value). RED before the fix (records the stale pre-scan
  //     st.mtimeMs); GREEN after (post-scan _postPinMtime).
  const cachedAfterGrow = _peekCachedIndex(LEDGER);
  assert.equal(
    cachedAfterGrow.mtimeMs,
    statSync(LEDGER).mtimeMs,
    "cached mtime equals the post-interleave file mtime (coherent fingerprint)",
  );

  // (f) Correctness backstop: byId content was never wrong — the interleaved row
  //     is present regardless of the mtime bug (the scan absorbed it).
  assert.ok(cachedAfterGrow.byId.has(ROW_C), "interleaved row is indexed (byId content correct either way)");
  assert.ok(cachedAfterGrow.byId.has(ROW_B), "the pre-build appended row is indexed too");

  // (g) The next build must be an EXACT HIT — the SAME byId Map object reused,
  //     no full rebuild. RED before the fix (incoherent (size, stale-mtime)
  //     forces a spurious full rebuild that swaps the byId identity); GREEN
  //     after (coherent pair → exact hit). Hook is cleared, so nothing races.
  const again = buildOffsetIndex(LEDGER);
  assert.equal(
    again.byId,
    primedByIdRef,
    "subsequent build is an exact hit (same byId reused, no spurious full rebuild)",
  );

  // The interleaved row still resolves via seek after the exact hit.
  const seeked = seekLedgerRowsByIds(LEDGER, new Set([ROW_B, ROW_C]));
  assert.equal(
    seeked.byId.get(ROW_C)?.content,
    "row c interleaved between the stat and the scan",
    "interleaved row resolves via offset seek",
  );
  assert.equal(seeked.misses, 0, "both the pre-build and interleaved rows resolve");
});

// ===========================================================================
// T14 (Q4) — duplicate ids across the sidecar/delta split: latest-write-wins
// must hold when the earlier duplicate is INSIDE the sidecar and the later
// one arrives in the delta fold.
// ===========================================================================
test("T14: duplicate id across sidecar + delta resolves latest-write-wins", async () => {
  const DUP = "fact_dup_split";
  writeLedger([factRow(DUP, "first version inside the sidecar"), ...baseRows.slice(0, 5)]);
  assert.ok(writeOffsetSidecar(LEDGER) > 0, "sidecar written with v1 of the dup");
  appendLedger([factRow(DUP, "SECOND version appended after the sidecar")]);

  _resetOffsetCaches();
  const seeked = seekLedgerRowsByIds(LEDGER, new Set([DUP]));
  assert.equal(
    seeked.byId.get(DUP)?.content,
    "SECOND version appended after the sidecar",
    "delta fold overrode the sidecar entry (latest-write-wins)",
  );
  await offsetMod._awaitPendingSidecarWrites();
});

// ===========================================================================
// T15 (Q4) — off-critical-path sidecar write: a cold full scan with NO
// sidecar SCHEDULES one (fire-and-forget, never inline), so the NEXT fresh
// process finds it and skips the full scan.
// ===========================================================================
test("T15: cold full scan schedules a sidecar write off the critical path", async () => {
  writeLedger(baseRows);
  try {
    rmSync(offsetSidecarPath(LEDGER));
  } catch {}
  _resetOffsetCaches();
  assert.equal(existsSync(offsetSidecarPath(LEDGER)), false, "no sidecar before the cold build");

  const built = buildOffsetIndex(LEDGER);
  assert.ok(built && built.byId.size === baseRows.length, "cold full scan built the index");
  assert.equal(
    existsSync(offsetSidecarPath(LEDGER)),
    false,
    "sidecar write did NOT happen inline on the (synchronous) build call",
  );
  await offsetMod._awaitPendingSidecarWrites();
  assert.ok(existsSync(offsetSidecarPath(LEDGER)), "scheduled sidecar write landed");

  // A genuinely fresh process now cold-loads from the sidecar it left behind.
  _resetOffsetCaches();
  const seeked = seekLedgerRowsByIds(LEDGER, new Set([KNOWN, UNICODE_ID]));
  assert.equal(seeked.byId.size, 2, "fresh process resolves from the auto-written sidecar");
  await offsetMod._awaitPendingSidecarWrites();
});

// ===========================================================================
// T11 — Production-path byte-identity guard (hermeticity invariant).
// ===========================================================================
test("T11: production ledger + indices untouched (byte-identical)", () => {
  const after = { memory: snap(PROD_MEMORY_JSONL), indices: snap(PROD_INDICES_DIR) };
  assert.equal(after.memory, PROD_BEFORE.memory, "production memory.jsonl untouched");
  assert.equal(after.indices, PROD_BEFORE.indices, "production indices/ untouched");
});
