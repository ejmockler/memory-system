// ledger-embedding-reroute.test.mjs — node v3-ledger-embedding-reroute.
//
// WHAT THIS PINS
// --------------
// distill-promote-fact.js used to stamp the FULL 4096-dim embedding onto every
// successfully-embedded fact row of the append-only ledger. Measured on the
// live ledger: the average fact row is 88,347 B, of which
// features.embedding_4096 is 87,998 B (96.59%); content averages 550 B. The
// ledger is ~3.06 GB and grows 19-24 MB/day at only ~200-400 facts/day — the
// growth is per-row SIZE, not volume. Downstream, recall must JSON.parse those
// rows: a 45-row candidate set costs 7.55 ms (4,092,480 B) with the vector and
// 0.26 ms (131,850 B) without.
//
// The row copy is REDUNDANT. The same code path already writes the vector
// out-of-band: updateIndicesForFact -> scheduleSaveIndices(...) ->
// appendWalRecord(...) -> fsyncSync(fd) (index-wal.js), replayed by
// index-cache.js (hnsw.add(rec.fact_id, rec.vector)) and absorbed by queryd on
// every 2 s watch tick so promoted-but-not-yet-published facts stay visible.
// The read side is already built and wired: recall.js _resolveCandidateEmbedding
// (row vector first, else hnsw.getVectorByMemoryId, dimension-guarded), plus the
// daemon-mode queryd `vector_fetch` batch prefetch that degrades to an empty
// overlay Map on any error.
//
// So this node STOPS writing features.embedding_4096 onto the row (default),
// behind the zero-code operator revert MEMORY_LEDGER_ROW_EMBEDDING_4096=1.
//
// HERMETIC: mkdtempSync MEMORY_ROOT + the five *_BASE_DIR vars are set BEFORE
// any dynamic import (index-cache.js derives its indices dir from MEMORY_ROOT,
// so a late assignment would write into the LIVE indices/ tree). No live
// ledger, no live index, no embed server, no daemon, no network.
//
// node:test + node:assert/strict.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Hermetic env — copied VERBATIM from test/cascade-inline-local-embed.test.mjs.
// MUST be set BEFORE any dynamic import touches config.js / index-cache.js.
// -----------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-v3-reroute-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.POLICY_BASE_DIR = join(TMP_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TMP_ROOT, "ledgers");
process.env.HOOKS_BASE_DIR = join(TMP_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(TMP_ROOT, "daemons");

const WATERMARK_STATE_DIR = join(process.env.STORAGE_BASE_DIR, "watermark-state");
const SOURCES_DIR = join(process.env.STORAGE_BASE_DIR, "sources");
for (const d of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  process.env.HOOKS_BASE_DIR,
  process.env.DAEMONS_BASE_DIR,
  WATERMARK_STATE_DIR,
  SOURCES_DIR,
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

const promoteMod = await import("../../lib/tools/distill-promote-fact.js");
const watermarkMod = await import("../../../daemons/watermark.js");
const salienceMod = await import("../../lib/ingest/salience.js");
const stage0Mod = await import("../../lib/ingest/stage0/index.js");
const { CAPS, ACTIVE_EMBED_MODEL_VERSION } = await import("../../lib/validation.js");
const { rowToIndexEntry } = await import("../../lib/recall/index-cache.js");
const { _selectSameDimEmbedding, _resolveCandidateEmbedding } = await import(
  "../../lib/tools/recall.js"
);
const { computeScore } = await import("../../lib/recall/multi-feature-score.js");
const { predicateMaskForCandidate } = await import("../../lib/recall/hard-gates.js");

const FLAG = "MEMORY_LEDGER_ROW_EMBEDDING_4096";
const LEDGER_PATH = join(process.env.LEDGERS_BASE_DIR, "memory.jsonl");
const WAL_PATH = join(TMP_ROOT, "indices", ACTIVE_EMBED_MODEL_VERSION, "index-wal.jsonl");
const NOW_ISO = "2026-06-22T00:00:00.000Z";
const NOW = new Date(NOW_ISO);

// ---------------------------------------------------------------------------
// A REALISTIC stub vector. This matters: the sibling suite's degenerate
// [1,0,0,...] stub serializes to 8,193 B, which would put the flag-ON row at
// ~9,160 B — only 1,160 B above the 8,000 B threshold, making the RED nearly
// vacuous. An L2-normalized pseudo-random 4096 vector serializes to ~87,600 B,
// matching the live ledger's measured 87,998 B. Unit norm is REQUIRED:
// updateIndicesForFact calls l2NormAssert(vector, ...) before hnsw.add.
// Deterministic LCG so the fixture is reproducible.
// ---------------------------------------------------------------------------
function unitVec4096(seed) {
  let s = seed >>> 0;
  const v = new Array(CAPS.EMBEDDING_DIM_4096);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const x = (s / 4294967296) * 2 - 1;
    v[i] = x;
    sum += x * x;
  }
  const norm = Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}
const VEC = unitVec4096(0x5eed01);

function ledgerRows() {
  if (!existsSync(LEDGER_PATH)) return [];
  return readFileSync(LEDGER_PATH, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// Find a fact row by its memory_event_id. The ledger is append-only and shared
// across cases, so we NEVER truncate it (truncating would also desync the WAL
// seq bookkeeping); every case addresses its own row by id.
function factRowById(id) {
  return ledgerRows().find((r) => r.kind === "fact" && r.id === id) || null;
}

function walRecordsFor(id) {
  if (!existsSync(WAL_PATH)) return [];
  return readFileSync(WAL_PATH, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
    .filter((p) => p && p.rec && p.rec.fact_id === id);
}

// Drive ONE real promote through the SAME appendFactRow stamp block +
// updateIndicesForFact the cascade uses, with the flag forced to `flagValue`
// (undefined => unset). Restores the previous env in a finally.
async function promoteWithFlag(content, flagValue, vector_4096) {
  const prev = process.env[FLAG];
  if (flagValue === undefined) delete process.env[FLAG];
  else process.env[FLAG] = flagValue;
  try {
    return await promoteMod.appendOperatorFact(
      {
        content,
        provenance: { agent_id: "test" },
        ...(vector_4096 === undefined ? {} : { vector_4096 }),
      },
      { now: NOW_ISO },
    );
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

// ---------------------------------------------------------------------------
// T1 — THE RED. Flag OFF (default): a successfully-embedded promote writes a
// fact row with NO features.embedding_4096 KEY AT ALL (absent, not null — an
// explicit null is the null-embed branch's signature and mixing the two muddies
// the on-disk shape), while embed_state / embedding_model_version are unchanged.
// ---------------------------------------------------------------------------
test("T1: flag OFF — the promoted fact row carries NO embedding_4096 and is <8 KB", async () => {
  const res = await promoteWithFlag("v3 reroute T1 success row alpha", undefined, VEC);
  assert.equal(res.ok, true, "promote succeeded");
  const row = factRowById(res.memory_event_id);
  assert.ok(row != null, "the fact row landed on the hermetic ledger");

  // The key is ABSENT, not null.
  assert.equal(
    "embedding_4096" in row.features,
    false,
    "features.embedding_4096 key is absent on the success path",
  );
  // The discriminator fields are byte-unchanged.
  assert.equal(row.features.embed_state, false, "embed_state stays false on success");
  assert.equal(
    row.features.embedding_model_version,
    CAPS.ACTIVE_EMBED_MODEL_VERSION,
    "embedding_model_version still stamped to the active local model",
  );

  const bytes = Buffer.byteLength(JSON.stringify(row), "utf8");
  assert.ok(
    bytes < 8000,
    `serialized row must be <8000 B, got ${bytes} (live ledger average today: 88,347 B)`,
  );
});

// ---------------------------------------------------------------------------
// T2 — POSITIVE CONTROL. The vector is not merely DELETED: the same promote
// carries it out-of-band into the fsync'd index WAL, which index-cache replays
// (hnsw.add(rec.fact_id, rec.vector)) and queryd absorbs on its watch tick.
//
// NOTE on mechanism: the spec suggested capturing scheduleSaveIndices' third
// argument "via the test mods object the harness already injects". That is
// impossible — distill-promote-fact.js does a STATIC
// `import { loadIndices, scheduleSaveIndices } from "../recall/index-cache.js"`,
// and watermark.js's mods.indexCache is consumed by watermark itself, never
// threaded into the promote module. So we assert the DURABLE artifact instead,
// which is strictly stronger: the on-disk WAL line.
//
// CAPABLE OF FAILING: the first half of this test drives a promote with NO
// vector and asserts that NO WAL record exists for it. A vacuous implementation
// that dropped the vector everywhere would fail the second half.
// ---------------------------------------------------------------------------
test("T2: the vector lands out-of-band in the fsync'd index WAL (positive control)", async () => {
  // (a) negative arm — a vector-less promote produces no WAL record at all.
  const none = await promoteWithFlag("v3 reroute T2 vectorless row", undefined, undefined);
  assert.equal(
    walRecordsFor(none.memory_event_id).length,
    0,
    "a promote with no vector writes NO index-WAL record (this arm proves the " +
      "positive arm below is capable of failing)",
  );

  // (b) positive arm — the real promote's vector IS in the WAL, full 4096 dims.
  const res = await promoteWithFlag("v3 reroute T2 out-of-band row beta", undefined, VEC);
  const recs = walRecordsFor(res.memory_event_id);
  assert.equal(recs.length, 1, "exactly one index-WAL record for the promoted fact");
  const rec = recs[0].rec;
  assert.equal(rec.fact_id, res.memory_event_id, "WAL record is bound to this fact id");
  assert.ok(Array.isArray(rec.vector), "WAL record carries a vector array");
  assert.equal(rec.vector.length, 4096, "the out-of-band vector is the FULL 4096 dims");
  assert.equal(rec.vector[0], VEC[0], "and it is the vector we handed the promote");

  // And the row it belongs to still carries none of it.
  const row = factRowById(res.memory_event_id);
  assert.equal("embedding_4096" in row.features, false, "row still carries no vector");
});

// ---------------------------------------------------------------------------
// T3 — dispatch parity through the row->candidate projection. Feed the
// new-shape row to the SAME rowToIndexEntry index-cache uses (do not
// reimplement it) and confirm the entry degrades exactly like a pre-existing
// vector-less fact: embedding_4096 null, embed_state false carried through on
// .features, and _selectSameDimEmbedding declining to pick a row vector.
// ---------------------------------------------------------------------------
test("T3: rowToIndexEntry projects the new-shape row to a null row vector", async () => {
  const res = await promoteWithFlag("v3 reroute T3 dispatch parity row", undefined, VEC);
  const row = factRowById(res.memory_event_id);
  const entry = rowToIndexEntry(row, "qwen3-embedding-8b-fp16");
  assert.ok(entry != null, "rowToIndexEntry produced an entry");
  assert.equal(entry.embedding_4096, null, "entry.embedding_4096 is null");
  assert.equal(entry.features.embed_state, false, "entry.features.embed_state is false");
  assert.equal(
    _selectSameDimEmbedding(entry, 4096),
    null,
    "_selectSameDimEmbedding finds no row vector -> the overlay is what resolves it",
  );
});

// ---------------------------------------------------------------------------
// T4 — the overlay resolves it. This is the read path that makes the reroute
// safe: recall.js _resolveCandidateEmbedding, unmodified, pulls the vector from
// the index (in-process HNSW getVectorByMemoryId; in daemon mode the identical
// getVectorByMemoryId shim built over queryd vector_fetch), and returns null
// when that overlay degrades to empty (recall.js's error path).
// ---------------------------------------------------------------------------
test("T4: _resolveCandidateEmbedding recovers the vector via the index overlay", async () => {
  const res = await promoteWithFlag("v3 reroute T4 overlay row", undefined, VEC);
  const row = factRowById(res.memory_event_id);
  const entry = rowToIndexEntry(row, "qwen3-embedding-8b-fp16");

  const resolved = _resolveCandidateEmbedding(
    entry,
    { getVectorByMemoryId: (id) => (id === entry.memory_id ? VEC : null) },
    4096,
  );
  assert.ok(Array.isArray(resolved), "the overlay returned a vector");
  assert.equal(resolved.length, 4096, "and it is the 4096-dim active geometry");

  // The DEGRADED-overlay shim recall.js builds when vector_fetch throws
  // (vectorsById = new Map() -> getVectorByMemoryId(id) ?? null).
  const degraded = _resolveCandidateEmbedding(
    entry,
    { getVectorByMemoryId: () => null },
    4096,
  );
  assert.equal(degraded, null, "a degraded overlay resolves to null (-> s_emb=0)");
});

// ---------------------------------------------------------------------------
// T5 — THE REGRESSION THAT WOULD SILENTLY RERANK THE WHOLE CORPUS.
//
// multi-feature-score.js's additive-fallback discriminator keys on
// features.embed_state === true (AND embedding_4096 == null AND embedding_3072
// == null AND s_emb === 0), NOT on the PRESENCE of the embedding_4096 field.
// This node only removes the field from the success path, where embed_state is
// false, so the discriminator cannot move. Pin that.
//
// UPDATED by b2-silent-recall-degrade Part 2: the discriminator now ALSO
// accepts an OPTIONAL tri-state `vector_resolved` on the scoring candidate,
// which takes precedence when it is exactly false. Every assertion below that
// supplies no signal is unchanged — cases (a)-(c) are the proof — and case (d)
// exercises the signalled branch that closes Fv3-3.
// ---------------------------------------------------------------------------
test("T5: the additive-fallback discriminator did NOT move for unsignalled callers", () => {
  const gates = {
    predicate_mask: 1,
    consent_dampener: CAPS.CONSENT_DAMPENER_FIRST_PARTY,
    derivation_status: CAPS.DERIVATION_STATUS_NORMAL,
  };
  const surrounding_context = { entities: [], time_anchor: null, valence: null };
  const baseCandidate = {
    memory_id: "mem_v3_t5",
    kind: "fact",
    ts: NOW_ISO, // age 0 -> time decay 1.0 -> additive leg = SCORE_WEIGHT_TIME_DECAY
    entities: [],
    valence: null,
  };

  // (a) The new shipped shape: no row vector, embed_state:false, a vector
  // resolved by the OVERLAY (s_emb = 0.55). Still the "fact_row" branch.
  const withVector = computeScore({
    s_emb_full3072: 0.55,
    gates,
    candidate: {
      ...baseCandidate,
      features: {
        embed_state: false,
        embedding_model_version: "qwen3-embedding-8b-fp16",
      },
    },
    surrounding_context,
    opts: { now: NOW_ISO },
  });
  assert.equal(withVector.fallback_branch_used, false, "no fallback for embed_state:false");
  assert.equal(withVector.embedding_source, "fact_row", "embedding_source stays fact_row");
  assert.equal(
    Number(withVector.final_score.toFixed(2)),
    0.85,
    "0.55 multiplicative + 0.30 time-decay additive = 0.85",
  );

  // (b) The genuine no-vector-anywhere row (the null-embed promote branch):
  // embed_state:true + both embeddings null + s_emb 0 -> additive-only.
  const noVector = computeScore({
    s_emb_full3072: 0,
    gates,
    candidate: {
      ...baseCandidate,
      features: { embed_state: true, embedding_4096: null, embedding_3072: null },
    },
    surrounding_context,
    opts: { now: NOW_ISO },
  });
  assert.equal(noVector.fallback_branch_used, true, "embed_state:true + s_emb 0 -> fallback");
  assert.equal(noVector.embedding_source, "none", "embedding_source is none");

  // (c) Fv3-3 — FIXED IN PRODUCTION by b2-silent-recall-degrade Part 2; this
  // call still shows the legacy behavior because it supplies NO signal.
  //
  // The finding: when the overlay resolves nothing (queryd vector_fetch failed
  // -> empty Map, or the in-process index simply misses the id), a new-shape
  // fact scores s_emb = 0 with embed_state:false. The ROW-SHAPE discriminator
  // requires embed_state === true, so the candidate was reported as
  // had_embedding_at_recall === true / embedding_source === "fact_row" even
  // though NO vector participated — the propensity log MIS-STRATIFIED it.
  //
  // What changed: computeScore now reads an OPTIONAL tri-state
  // `vector_resolved` off the constructed scoring view. recall.js supplies it
  // (`resolvedEmbedding != null`) whenever the dense channel was healthy for
  // that call, so in production the overlay-miss case is now correctly routed
  // to the fallback branch — case (d) below proves it. When the signal is
  // ABSENT (this call, every other call site, every legacy test) the legacy
  // row-shape predicate governs unchanged, which is exactly what the
  // assertions here pin: the change is additive, not a silent global rerank.
  //
  // Deliberately still unsignalled here: recall.js OMITS the key on any
  // degraded path, so an availability failure can never mass-hard-drop.
  const overlayDegraded = computeScore({
    s_emb_full3072: 0, // the overlay resolved null
    gates,
    candidate: {
      ...baseCandidate,
      features: {
        embed_state: false,
        embedding_model_version: "qwen3-embedding-8b-fp16",
      },
    },
    surrounding_context,
    opts: { now: NOW_ISO },
  });
  assert.equal(
    Number(overlayDegraded.final_score.toFixed(2)),
    0.3,
    "overlay-degraded new-shape fact scores 0.30 (additive time-decay leg only)",
  );
  assert.equal(
    overlayDegraded.had_embedding_at_recall,
    true,
    "no vector_resolved signal -> the legacy row-shape predicate governs, unchanged",
  );
  assert.equal(
    overlayDegraded.fallback_branch_used,
    false,
    "no signal -> NOT routed through the additive-only fallback branch (legacy behavior preserved)",
  );

  // (d) Fv3-3 CLOSED: the identical candidate, with the recall-derived signal
  // recall.js now passes on a healthy dense channel. The telemetry tells the
  // truth, and the score is the SAME NUMBER — the multiplicative branch was
  // already 0 (s_emb = 0), so routing to the additive-only branch changes
  // nothing but the stratification labels (this row's additive leg, 0.30,
  // clears RECALL_ADDITIVE_FLOOR_FALLBACK = 0.10).
  const overlayDegradedSignalled = computeScore({
    s_emb_full3072: 0,
    gates,
    candidate: {
      ...baseCandidate,
      features: {
        embed_state: false,
        embedding_model_version: "qwen3-embedding-8b-fp16",
      },
      vector_resolved: false,
    },
    surrounding_context,
    opts: { now: NOW_ISO },
  });
  assert.equal(
    overlayDegradedSignalled.had_embedding_at_recall,
    false,
    "Fv3-3 FIXED: telemetry no longer claims an embedding participated",
  );
  assert.equal(
    overlayDegradedSignalled.fallback_branch_used,
    true,
    "Fv3-3 FIXED: routed through the additive-only fallback branch",
  );
  assert.equal(
    overlayDegradedSignalled.embedding_source,
    "none",
    "Fv3-3 FIXED: embedding_source is none, not fact_row",
  );
  assert.equal(
    overlayDegradedSignalled.dropped_by_additive_floor,
    false,
    "additive 0.30 clears the fallback floor -> no drop",
  );
  assert.equal(
    overlayDegradedSignalled.final_score,
    overlayDegraded.final_score,
    "and the final_score is NUMERICALLY IDENTICAL — telemetry only",
  );
});

// ---------------------------------------------------------------------------
// T6 — the null-embed branch is byte-identical to today. This node touches ONLY
// the ok=true+vector_4096 arm; the ok=false arm still writes all four embedding
// fields as EXPLICIT null + embed_state=true, which is what the re-embed sweep
// and the additive-fallback discriminator both key on.
// ---------------------------------------------------------------------------
test("T6: the null-embed promote branch is untouched", async () => {
  const res = await promoteWithFlag("v3 reroute T6 null-embed row", undefined, undefined);
  const row = factRowById(res.memory_event_id);
  assert.ok(row != null, "the null-embed row landed");
  assert.equal(row.features.embedding_4096, null, "embedding_4096 explicitly null");
  assert.equal(row.features.embedding_3072, null, "embedding_3072 explicitly null");
  assert.equal(row.features.embedding_mrl_768, null, "embedding_mrl_768 explicitly null");
  assert.equal(row.features.embedding_model_version, null, "model_version explicitly null");
  assert.equal(row.features.embed_state, true, "embed_state true marks it for re-embed");
  // The explicit-null KEYS must be PRESENT here — that is the shape difference
  // from the success path, where the key is absent entirely.
  assert.equal("embedding_4096" in row.features, true, "the null key is present, not absent");
});

// ---------------------------------------------------------------------------
// T7 — THE EXCLUSION FAIL-OPEN, PINNED NOT FIXED (finding Fv3-3).
//
// hard-gates.js's GATE_VECTOR_FIELDS = ["embedding_4096","embedding_3072",
// "embedding_768"] reads the ROW vector off the candidate entry, and recall.js
// guards its post-overlay predicate reapply on `resolvedEmbedding != null`. So
// when the overlay degrades, a new-shape fact has NO vector in either place and
// the DENSE predicate channel silently skips it — an authorized exclusion
// fails OPEN on that channel. The context_entities channel is unaffected
// (it needs no vector) and still masks.
//
// This is a PRE-EXISTING fail-open for every index-only-vector fact; this node
// extends it to 100% of newly-promoted facts. MEASURED MITIGANT: the live
// corpus currently has ZERO active predicates (loadActivePredicates() returned
// an empty array), so the widened surface is latent today. Recorded, not fixed.
// ---------------------------------------------------------------------------
test("T7: dense predicate channel fails open without a vector; entity channel still masks", async () => {
  const res = await promoteWithFlag("v3 reroute T7 exclusion row", undefined, VEC);
  const row = factRowById(res.memory_event_id);
  const entry = rowToIndexEntry(row, "qwen3-embedding-8b-fp16");

  // A dense predicate whose query vector IS this fact's vector — cosine 1.0,
  // far above any threshold. It would certainly mask if a vector were reachable.
  const densePred = {
    predicate_id: "pred_v3_dense",
    query_embedding: VEC,
    similarity_threshold: 0.1,
  };
  const denseOnly = predicateMaskForCandidate(entry, null, [densePred]);
  assert.equal(
    denseOnly.masked,
    false,
    "Fv3-3 (RECORDED, NOT FIXED): with resolvedVector=null and no row vector, " +
      "the dense exclusion channel FAILS OPEN",
  );
  // Control: the very same predicate DOES mask once a vector is reachable, so
  // the assertion above is about vector reachability, not a broken predicate.
  assert.equal(
    predicateMaskForCandidate(entry, VEC, [densePred]).masked,
    true,
    "control: the same predicate masks when the resolved vector is supplied",
  );

  // The entity channel needs no vector and is unaffected by this node.
  const entityPred = {
    predicate_id: "pred_v3_entity",
    context_entities: Array.isArray(entry.entities) && entry.entities.length > 0
      ? [entry.entities[0]]
      : ["v3-entity-probe"],
  };
  const entityEntry =
    Array.isArray(entry.entities) && entry.entities.length > 0
      ? entry
      : { ...entry, entities: ["v3-entity-probe"] };
  assert.equal(
    predicateMaskForCandidate(entityEntry, null, [entityPred]).masked,
    true,
    "the context_entities channel still masks with no vector anywhere",
  );
});

// ---------------------------------------------------------------------------
// T8 — the kill switch. MEMORY_LEDGER_ROW_EMBEDDING_4096=1 restores the legacy
// on-disk shape with ZERO code change and no deploy. The flag is read at CALL
// time (not cached at import) so a per-case env flip takes effect.
// ---------------------------------------------------------------------------
test("T8: MEMORY_LEDGER_ROW_EMBEDDING_4096=1 restores the legacy row shape", async () => {
  const res = await promoteWithFlag("v3 reroute T8 kill-switch row", "1", VEC);
  const row = factRowById(res.memory_event_id);
  assert.ok(Array.isArray(row.features.embedding_4096), "row carries an embedding array again");
  assert.equal(
    row.features.embedding_4096.length,
    CAPS.EMBEDDING_DIM_4096,
    "and it is the full 4096 dims",
  );
  assert.equal(row.features.embed_state, false, "embed_state unchanged by the flag");
  const bytes = Buffer.byteLength(JSON.stringify(row), "utf8");
  assert.ok(
    bytes > 80000,
    `the legacy shape is the big one: expected >80,000 B, got ${bytes}`,
  );

  // "true" is honored too — same convention as MEMORY_BM25_DECOUPLE_EMBED.
  const res2 = await promoteWithFlag("v3 reroute T8 kill-switch row true", "true", VEC);
  assert.ok(
    Array.isArray(factRowById(res2.memory_event_id).features.embedding_4096),
    'the "true" spelling of the flag is honored as well',
  );
});

// ---------------------------------------------------------------------------
// T9 — THE RECOVERY PREDICATE. With the row vector gone, the ONLY enumeration
// key a reconciliation sweep has for "this fact's vector should be in the 4096
// index but is not on the row" is the DERIVED TRIPLE below. That makes
// features.embedding_model_version LOAD-BEARING where it used to be decorative:
// without it a sweep cannot tell a rerouted row from a legacy Gemini row or an
// unembedded one. This test exists to stop a future edit from quietly dropping
// it as "redundant".
// ---------------------------------------------------------------------------
test("T9: the derived recovery predicate holds on the new-shape row", async () => {
  const res = await promoteWithFlag("v3 reroute T9 recovery predicate row", undefined, VEC);
  const f = factRowById(res.memory_event_id).features;
  const isRerouted =
    f.embed_state === false &&
    f.embedding_model_version === CAPS.ACTIVE_EMBED_MODEL_VERSION &&
    !("embedding_4096" in f);
  assert.equal(
    isRerouted,
    true,
    "embed_state===false && embedding_model_version===ACTIVE && no embedding_4096 " +
      "is the sole reconciliation key for a rerouted fact",
  );
});

// ---------------------------------------------------------------------------
// T10 — FINDING Fv3-4, the residual this node CREATES.
//
// updateIndicesForFact is best-effort at all three call sites: each is wrapped
// in a try/catch that only logs "index update failed for <id>". TODAY that is
// harmless — the ledger row still holds the vector, so a rebuild recovers it.
// AFTER this node it is OUTRIGHT VECTOR LOSS with no marker: the row has no
// vector, the WAL never got one, and embed_state===false means the re-embed
// sweep (which keys on embed_state===true) never revisits the fact.
//
// Driven here with a NON-UNIT vector, which makes l2NormAssert throw inside
// updateIndicesForFact — the same shape as a loadIndices throw, a bm25/hnsw add
// throw, or a WAL append error. The promote still SUCCEEDS and the row still
// lands; only the vector is gone.
// ---------------------------------------------------------------------------
test("Fv3-4: an index-write failure loses the vector silently but never the row", async () => {
  const nonUnit = new Array(CAPS.EMBEDDING_DIM_4096).fill(0.5); // ||v|| = 32
  const res = await promoteWithFlag("v3 reroute Fv3-4 index-failure row", undefined, nonUnit);
  assert.equal(res.ok, true, "the promote still succeeds — index writes are best-effort");
  const row = factRowById(res.memory_event_id);
  assert.ok(row != null, "the fact row is still durably on the ledger");
  assert.equal("embedding_4096" in row.features, false, "no vector on the row");
  assert.equal(walRecordsFor(res.memory_event_id).length, 0, "and none in the WAL either");
  // The sweep key that WOULD have caught this is embed_state===true, and it is
  // false here — so nothing re-embeds this fact. Recorded as Fv3-4.
  assert.equal(row.features.embed_state, false, "Fv3-4: the re-embed sweep key is NOT set");
});

// ---------------------------------------------------------------------------
// T11 — PRODUCTION-PATH FIDELITY. The cases above drive appendOperatorFact,
// which reaches the SAME appendFactRow stamp block and the SAME
// updateIndicesForFact. This case drives the REAL cascade instead (watermark
// tick -> stage0 -> salience -> promoteSourceRow), mirroring the harness in
// test/cascade-inline-local-embed.test.mjs, so the shipped shape is pinned on
// the path that actually writes the live ledger.
// ---------------------------------------------------------------------------
test("T11: the real watermark cascade promotes the new row shape too", async () => {
  const source = "imessage";
  const tag = "v3cascade";
  writeFileSync(
    join(SOURCES_DIR, `${source}.jsonl`),
    JSON.stringify({
      id: `ulid_${tag}`,
      ts: NOW_ISO,
      source,
      source_msg_id: `${source}-${tag}`,
      raw_content: { text: "v3 reroute cascade fidelity row", handle_id: "+15555550199" },
      source_policy: { deletion_semantics: "full_excise", consent_basis: "first_party" },
      checksum: `cksum-${tag}`,
    }) + "\n",
  );
  try { writeFileSync(join(WATERMARK_STATE_DIR, `${source}.json`), ""); } catch {}

  const before = new Set(ledgerRows().filter((r) => r.kind === "fact").map((r) => r.id));

  const localEmbedBatch = async (args) =>
    args.items.map((_t, i) => ({
      index: i,
      vector_4096: VEC.slice(),
      embedding_model_version: ACTIVE_EMBED_MODEL_VERSION,
    }));
  watermarkMod._setCascadeModsForTest({
    stage0: stage0Mod,
    salience: salienceMod,
    promote: promoteMod,
    normalizeSourceEvent: salienceMod.normalizeSourceEvent,
    localEmbedBatch,
    indexCache: { loadIndices: () => ({ hnsw: null }) },
  });
  const prev = process.env[FLAG];
  delete process.env[FLAG];
  let result;
  try {
    result = await watermarkMod.tickSourcesOnce({ now: NOW });
  } finally {
    watermarkMod._setCascadeModsForTest(null);
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }

  assert.ok(result.rows_promoted >= 1, "the cascade promoted at least one row");
  const fresh = ledgerRows().filter((r) => r.kind === "fact" && !before.has(r.id));
  assert.equal(fresh.length, 1, "exactly one new fact row from the cascade tick");
  const f = fresh[0].features;
  assert.equal("embedding_4096" in f, false, "cascade row carries no embedding_4096 key");
  assert.equal(f.embed_state, false, "cascade success path keeps embed_state false");
  assert.equal(
    f.embedding_model_version,
    ACTIVE_EMBED_MODEL_VERSION,
    "cascade row keeps the active model version stamp",
  );
  const recs = walRecordsFor(fresh[0].id);
  assert.equal(recs.length, 1, "the cascade's vector went out-of-band to the WAL");
  assert.equal(recs[0].rec.vector.length, 4096, "full 4096 dims in the WAL");
});
