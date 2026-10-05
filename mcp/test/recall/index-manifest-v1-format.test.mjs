// index-manifest-v1-format.test.mjs — S3g INCIDENT: production recall served
// EMPTY on the new-code loader because the S3 manifest-gated deserialize path
// could not decode the LEGACY on-disk hnsw formats under the native
// hnswlib-node runtime.
//
// The verified production shape (indices/gemini-embedding-001, live
// 2026-07-16): a v2 line-delimited bm25.json PLUS a legacy single-file
// linear-scan hnsw.bin — `{"format":1,"backend":"linear-scan",...,
// "id_map":[...],"vectors":[[iid,[...]],...]}` on ONE line — under an
// adopted generation-0 manifest. The generation VERIFIES (checksums match),
// then HnswIndex._loadLegacyMonolithic builds the index container for the
// CURRENT runtime backend (hnswlib-node → `_native`, no `_vectors` map) and
// pokes `idx._vectors.set(...)` → TypeError: Cannot read properties of
// undefined (reading 'set') → _pickLoadableGeneration refuses the whole
// candidate → recall serves empty indices. The same crash class lives in
// _absorbNdjsonLine for a v2-NDJSON linear-scan hnsw.bin read on a native
// runtime (T2). The pure linear-scan runtime never crashed — only the
// native runtime reading linear-scan-format files does.
//
// RED-FIRST EVIDENCE — verbatim failing run against the UNMODIFIED pre-fix
// hnsw-index.js/health.js (2026-07-16, branch memperf, hnswlib-node backend;
// T3 — the v1-bm25 dispatch pin — was GREEN pre-fix, honestly recorded: the
// bm25 v1/v2 dispatch in index-cache.js _deserializeGenerationMembers was
// never broken; the incident bug is the hnsw legacy-format deserialize):
//
//   index-cache: failed to deserialize verified generation 0 (active) for v1fmt-t1-legacy-monolithic: Cannot read properties of undefined (reading 'set')
//   index-cache: failed to deserialize verified generation 0 (active) for v1fmt-t2-ndjson-linear: Cannot read properties of undefined (reading 'set')
//   index-manifest-v1-format: HNSW_BACKEND=hnswlib-node
//   ✖ T1 production shape: legacy format-1 linear-scan hnsw.bin under an adopted manifest serves non-empty (23.297666ms)
//     AssertionError [ERR_ASSERTION]: RED (production incident): bm25 must serve the fixture fact through the adopted manifest (whole candidate refused when the hnsw member fails deserialize)
//
//     0 !== 1
//
//         at assertServedLegacyHnsw (file:///<checkout>/mcp/test/recall/index-manifest-v1-format.test.mjs:224:10)
//       actual: 0,
//       expected: 1,
//       operator: 'strictEqual',
//   ✖ T2 v2-NDJSON linear-scan hnsw.bin loads on the native runtime (_absorbNdjsonLine crash class) (19.858583ms)
//     AssertionError [ERR_ASSERTION]: RED : bm25 must serve the fixture fact through the adopted manifest (whole candidate refused when the hnsw member fails deserialize)
//
//     0 !== 1
//   ✔ T3 v1 monolithic Bm25Index.serialize() bm25.json under a manifest still loads (dispatch pin) (14.654583ms)
//   ✖ T4 memory_health surfaces index_generation_refused for a mismatched adopted manifest (65.286166ms)
//     AssertionError [ERR_ASSERTION]: health_notes must carry the index_generation_refused note for v1fmt-t4-stale-manifest (got ["ledger_missing: auto-memory.jsonl","ledger_missing: chat-claude-code.jsonl","ledger_missing: telegram.jsonl","rederive jobs not yet implemented (Phase 2)"])
//     (the probe did not exist pre-fix — refusals were stderr-only)
//   ℹ tests 5 / pass 2 / fail 3
//
// Post-fix the whole file is green: the linear-scan-format loaders feed the
// native graph via the same auto-grow addPoint path add() uses, and health
// gains the stat-only index_generation_refused probe.
//
// Discipline (clones test/recall/index-manifest.test.mjs — RED-RUN
// ISOLATION): mkdtempSync temp root; MEMORY_ROOT/POLICY_BASE_DIR/
// STORAGE_BASE_DIR/LEDGERS_BASE_DIR overwritten BEFORE any dynamic import;
// dims=8 float32-exact unit vectors (native hnswlib stores float32 — exact
// deep-equal against the fixture bytes is only honest when the components
// are float32-representable); _resetCaches() between tests; final assertion
// pins ledgers/memory.jsonl absent from the temp tree.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Hermeticity: stake tmp dirs + overwrite env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-index-v1fmt-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
process.env.TELEMETRY_BASE_DIR = join(MEMORY_ROOT, "telemetry");
// High thresholds: nothing auto-flushes; these tests never schedule saves.
process.env.INDEX_SAVE_BATCH = "1000";
process.env.INDEX_SAVE_MAX_AGE_S = "3600";

mkdirSync(process.env.POLICY_BASE_DIR, { recursive: true, mode: 0o700 });
mkdirSync(process.env.STORAGE_BASE_DIR, { recursive: true, mode: 0o700 });
mkdirSync(process.env.LEDGERS_BASE_DIR, { recursive: true, mode: 0o700 });
mkdirSync(join(MEMORY_ROOT, "indices"), { recursive: true, mode: 0o700 });

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// Dynamic import AFTER env override.
const { INDEX_REFUSAL_FILE, loadIndices, _resetCaches } = await import(
  "../../lib/recall/index-cache.js"
);
const { HNSW_BACKEND } = await import("../../lib/recall/hnsw-index.js");
const { Bm25Index } = await import("../../lib/recall/bm25-index.js");
const { writeBm25IndexV2Atomic } = await import(
  "../../lib/recall/bm25-rebuild.js"
);
const {
  MANIFEST_FILE,
  adoptGeneration0,
  readActiveManifest,
  verifyGenerationMembers,
} = await import("../../lib/recall/index-manifest.js");

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
const DIMS = 8;

// Float32-exact unit vectors (components from {0, ±0.5}): the native backend
// stores float32, so getVectorByMemoryId round-trips these EXACTLY and the
// deep-equal against the legacy reader's semantics (id → the verbatim vector
// bytes in the file) is honest on both backends.
const VEC_A = [0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0];
const VEC_B = [0.5, -0.5, 0.5, -0.5, 0, 0, 0, 0];
const VEC_T = [0, 0, 0.5, 0.5, -0.5, 0.5, 0, 0]; // tombstoned id's vector

function dirFor(modelVersion) {
  return join(MEMORY_ROOT, "indices", modelVersion);
}

function bm25EntryFor(id, token) {
  return {
    memory_id: id,
    kind: "fact",
    content: `synthetic fact ${id} ${token}`,
    ts: "2026-07-16T00:00:00Z",
    entities: [],
    valence: null,
    consent_basis: "first_party",
  };
}

function smallBm25(entries) {
  const idx = new Bm25Index();
  for (const [id, token] of entries) idx.add(bm25EntryFor(id, token));
  return idx;
}

// The REAL production legacy shape (copied from
// indices/gemini-embedding-001/hnsw.bin, live 2026-07-16): ONE line, no
// trailing newline, format 1, backend linear-scan, id_map + inline vectors.
function writeLegacyMonolithicHnsw(dir, mv) {
  const blob = {
    format: 1,
    backend: "linear-scan",
    dims: DIMS,
    embedding_model_version: mv,
    M: 16,
    efConstruction: 200,
    efSearch: 50,
    maxElements: 100000,
    nextId: 3,
    id_map: [
      ["mem_a0", 0],
      ["mem_a1", 1],
      ["mem_t", 2],
    ],
    tombstones: ["mem_t"],
    vectors: [
      [0, VEC_A],
      [1, VEC_B],
      [2, VEC_T],
    ],
  };
  writeFileSync(join(dir, "hnsw.bin"), JSON.stringify(blob), { mode: 0o600 });
}

// The v2 linear-scan NDJSON shape (hnsw-index.js save()'s linear branch):
// header line + one {id, iid, v} line per vector. This is the artifact a
// linear-scan process (sandboxed env, out-of-band script) leaves at the
// fixed path; a native-runtime cold load must be able to deserialize it.
function writeNdjsonLinearHnsw(dir, mv) {
  const header = {
    format: 2,
    backend: "linear-scan",
    dims: DIMS,
    embedding_model_version: mv,
    M: 16,
    efConstruction: 200,
    efSearch: 50,
    maxElements: 1024,
    nextId: 2,
    count: 2,
    tombstones: [],
  };
  writeFileSync(
    join(dir, "hnsw.bin"),
    `${JSON.stringify(header)}\n` +
      `${JSON.stringify({ id: "mem_a0", iid: 0, v: VEC_A })}\n` +
      `${JSON.stringify({ id: "mem_a1", iid: 1, v: VEC_B })}\n`,
    { mode: 0o600 },
  );
}

// Adopt the on-disk fixture as generation 0 — the exact state production was
// in (manifest adopted 2026-07-14 over the pre-existing member bytes) — and
// sanity-pin that the generation VERIFIES: the incident bug is deserialize,
// not checksum refusal.
function adoptAndVerify(dir) {
  const adopted = adoptGeneration0(dir, {
    wal_cursor: { applied_seq: 0, applied_offset: 0 },
  });
  assert.equal(adopted.error, null, "fixture adoption succeeds");
  const { manifest, error } = readActiveManifest(dir);
  assert.equal(error, null, "adopted manifest readable");
  const v = verifyGenerationMembers(dir, manifest.members);
  assert.equal(
    v.ok,
    true,
    `fixture generation VERIFIES (${JSON.stringify(v.error)}) — the bug under test is deserialize`,
  );
  return manifest;
}

// Shared serving assertions for T1/T2: non-empty bm25 AND hnsw, and the
// hnsw contents deep-equal the legacy reader's semantics on the fixture
// (id_map, live size, per-id vectors, tombstones).
function assertServedLegacyHnsw(loaded, { tombstoned }, redLabel) {
  assert.equal(
    loaded.bm25.search("alphaglyph", 5).length,
    1,
    `RED ${redLabel}: bm25 must serve the fixture fact through the adopted ` +
      "manifest (whole candidate refused when the hnsw member fails deserialize)",
  );
  assert.equal(loaded.bm25.search("alphaglyph", 5)[0].memory_id, "mem_a0");
  assert.equal(
    loaded.hnsw.size(),
    2,
    `RED ${redLabel}: hnsw must serve the fixture's 2 live vectors`,
  );
  assert.ok(loaded.hnsw.has("mem_a0") && loaded.hnsw.has("mem_a1"));
  // Per-id vectors: deep-equal the verbatim fixture bytes (the legacy
  // linear-scan reader's exact semantics; float32-exact by construction).
  assert.deepEqual(loaded.hnsw.getVectorByMemoryId("mem_a0"), VEC_A);
  assert.deepEqual(loaded.hnsw.getVectorByMemoryId("mem_a1"), VEC_B);
  if (tombstoned) {
    assert.equal(loaded.hnsw.has("mem_t"), false, "tombstone honored on load");
    assert.equal(loaded.hnsw.getVectorByMemoryId("mem_t"), null);
  }
  // id-map correctness through search — the wrong-fact-id class: querying a
  // fixture vector must resolve to ITS id at ~zero distance.
  const hits = loaded.hnsw.search(VEC_B, 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].memory_id, "mem_a1", "iid→memory_id map correct");
  assert.ok(
    hits[0].cosine_distance < 1e-6,
    `exact vector resolves at ~0 distance (got ${hits[0].cosine_distance})`,
  );
}

// ---------------------------------------------------------------------------
// (T1) RED-FIRST — THE PRODUCTION SHAPE. v2 bm25.json + legacy format-1
// linear-scan monolithic hnsw.bin + adopted gen-0 manifest. Pre-fix, on the
// native runtime: verify OK → _loadLegacyMonolithic pokes idx._vectors
// (undefined under hnswlib-node) → TypeError → the WHOLE candidate is
// refused → cold load serves empty indices. Post-fix: served, and the hnsw
// content deep-equals the legacy reader's semantics.
// ---------------------------------------------------------------------------
await test("T1 production shape: legacy format-1 linear-scan hnsw.bin under an adopted manifest serves non-empty", () => {
  _resetCaches();
  const MV = "v1fmt-t1-legacy-monolithic";
  const dir = dirFor(MV);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  writeBm25IndexV2Atomic(
    join(dir, "bm25.json"),
    smallBm25([
      ["mem_a0", "alphaglyph"],
      ["mem_a1", "betaglyph"],
    ]),
  );
  writeLegacyMonolithicHnsw(dir, MV);
  adoptAndVerify(dir);

  _resetCaches(); // fresh process: cold manifest-gated load
  const loaded = loadIndices(MV);
  assertServedLegacyHnsw(loaded, { tombstoned: true }, "(production incident)");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T2) Same crash class through the v2-NDJSON linear-scan path
// (_absorbNdjsonLine poked idx._vectors per line on the native runtime).
// ---------------------------------------------------------------------------
await test("T2 v2-NDJSON linear-scan hnsw.bin loads on the native runtime (_absorbNdjsonLine crash class)", () => {
  _resetCaches();
  const MV = "v1fmt-t2-ndjson-linear";
  const dir = dirFor(MV);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  writeBm25IndexV2Atomic(
    join(dir, "bm25.json"),
    smallBm25([
      ["mem_a0", "alphaglyph"],
      ["mem_a1", "betaglyph"],
    ]),
  );
  writeNdjsonLinearHnsw(dir, MV);
  adoptAndVerify(dir);

  _resetCaches();
  const loaded = loadIndices(MV);
  assertServedLegacyHnsw(loaded, { tombstoned: false }, "");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T3) DISPATCH PIN (GREEN pre-fix, recorded honestly): a v1 monolithic
// Bm25Index.serialize() bm25.json under an adopted manifest loads through
// _deserializeGenerationMembers' existing v1/v2 dispatch
// (index-cache.js: _isV2Bm25File → false → JSON.parse + Bm25Index.deserialize).
// Locks the behavior the S3g spec initially suspected — proving the bm25
// side was never the incident bug.
// ---------------------------------------------------------------------------
await test("T3 v1 monolithic Bm25Index.serialize() bm25.json under a manifest still loads (dispatch pin)", () => {
  _resetCaches();
  const MV = "v1fmt-t3-bm25-v1";
  const dir = dirFor(MV);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const bm25 = smallBm25([
    ["mem_b0", "gammaglyph"],
    ["mem_b1", "deltaglyph"],
  ]);
  // The pre-WU-RR1 promote-time shape: ONE JSON object, version 1.
  writeFileSync(join(dir, "bm25.json"), JSON.stringify(bm25.serialize()), {
    mode: 0o600,
  });
  adoptAndVerify(dir);

  _resetCaches();
  const loaded = loadIndices(MV);
  const hits = loaded.bm25.search("gammaglyph", 5);
  assert.equal(hits.length, 1, "v1 bm25 member served through the manifest");
  assert.equal(hits[0].memory_id, "mem_b0");
  // No hnsw member on disk → bootstrap-empty hnsw (existing semantics).
  assert.equal(loaded.hnsw.size(), 0);
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T4) REFUSAL VISIBILITY — memory_health surfaces a refused ACTIVE
// generation as `index_generation_refused: <mv> code=... member=...` via a
// stat-only probe (NEVER hashes member bytes: a 707MB+ sha256 would blow
// health's latency budget). Fixture mirrors the qwen3 production incident:
// an old-code writer rewrote bm25.json AFTER manifest adoption, so the
// recorded size mismatches the on-disk size and every cold load refuses.
// ---------------------------------------------------------------------------
await test("T4 memory_health surfaces index_generation_refused for a mismatched adopted manifest", async () => {
  _resetCaches();
  const MV = "v1fmt-t4-stale-manifest";
  const dir = dirFor(MV);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  writeBm25IndexV2Atomic(
    join(dir, "bm25.json"),
    smallBm25([["mem_c0", "epsilonglyph"]]),
  );
  const manifest = adoptAndVerify(dir);
  const recordedSize = manifest.members.bm25.size;

  // The un-cutover old writer's flush: rewrites the member at the fixed path
  // with NO manifest rebind (size changes; the manifest goes stale).
  appendFileSync(join(dir, "bm25.json"), '\n["P","stale",[["mem_zz",1]]]');

  const { buildHealthData } = await import("../../lib/tools/health.js");
  const data = await buildHealthData({
    indicesDir: join(MEMORY_ROOT, "indices"),
    scheduleRebuild: () => {},
  });
  assert.ok(Array.isArray(data.health_notes), "health_notes is an array");
  const note = data.health_notes.find((n) =>
    String(n).startsWith(`index_generation_refused: ${MV} `),
  );
  assert.ok(
    note != null,
    `health_notes must carry the index_generation_refused note for ${MV} ` +
      `(got ${JSON.stringify(data.health_notes)})`,
  );
  assert.match(note, /code=index_manifest_member_mismatch/);
  assert.match(note, /member=bm25/);
  assert.ok(
    note.includes(`expected_size=${recordedSize}`),
    `note carries the recorded size (${note})`,
  );
  assert.match(note, /actual_size=\d+/);
  // The healthy fixture trees from T1-T3 (valid manifests) must NOT be
  // flagged — the probe fires only on a real mismatch.
  const falsePositives = data.health_notes.filter(
    (n) =>
      String(n).startsWith("index_generation_refused:") &&
      !String(n).includes(MV),
  );
  assert.deepEqual(falsePositives, [], "no false positives on healthy trees");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T5) REG (memperf) — DESERIALIZE-REFUSAL BREADCRUMB, both directions.
// A generation that VERIFIES but fails deserialize is invisible to T4's
// stat-mismatch probe (sizes match the manifest; the bytes just don't
// decode). Direction 1: the refusal persists a derived, newest-wins
// index-refusal.json and memory_health surfaces
// `index_generation_refused: <mv> code=deserialize_failed`. Direction 2:
// after the tree is repaired, the next successful cold serve CLEARS the
// breadcrumb and the health note disappears.
// ---------------------------------------------------------------------------
await test("T5 deserialize refusal persists index-refusal.json + health surfaces code=deserialize_failed; a successful serve clears both", async () => {
  _resetCaches();
  const MV = "v1fmt-t5-deserialize-refused";
  const dir = dirFor(MV);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Bytes that VERIFY (adoption checksums whatever is on disk) but can never
  // deserialize: neither the v2 line-delimited header nor parseable JSON.
  writeFileSync(join(dir, "bm25.json"), "NOT-JSON {{{\n", { mode: 0o600 });
  adoptAndVerify(dir);

  _resetCaches(); // fresh process: cold manifest-gated load
  const refused = loadIndices(MV);
  assert.equal(
    refused.bm25.search("epsilonglyph", 5).length,
    0,
    "refusal fail-closes to empty indices (existing degrade discipline)",
  );
  const refusalPath = join(dir, INDEX_REFUSAL_FILE);
  assert.ok(existsSync(refusalPath), "refusal breadcrumb persisted");
  const breadcrumb = JSON.parse(readFileSync(refusalPath, "utf8"));
  assert.equal(breadcrumb.code, "deserialize_failed");
  assert.equal(breadcrumb.model_version, MV);
  assert.equal(breadcrumb.generation, 0, "names the refused generation");

  const { buildHealthData } = await import("../../lib/tools/health.js");
  const data1 = await buildHealthData({
    indicesDir: join(MEMORY_ROOT, "indices"),
    scheduleRebuild: () => {},
  });
  const note = data1.health_notes.find((n) =>
    String(n).startsWith(`index_generation_refused: ${MV} `),
  );
  assert.ok(
    note != null,
    `health surfaces the deserialize refusal (got ${JSON.stringify(data1.health_notes)})`,
  );
  assert.match(note, /code=deserialize_failed/);

  // Direction 2 — repair the tree (valid member bytes + fresh gen-0
  // adoption, the heal-index-manifest.mjs remediation shape); the next
  // successful cold serve clears the breadcrumb and the note.
  unlinkSync(join(dir, MANIFEST_FILE));
  writeBm25IndexV2Atomic(
    join(dir, "bm25.json"),
    smallBm25([["mem_e0", "zetaglyph"]]),
  );
  adoptAndVerify(dir);
  _resetCaches();
  const served = loadIndices(MV);
  assert.equal(
    served.bm25.search("zetaglyph", 5).length,
    1,
    "repaired tree serves non-empty",
  );
  assert.equal(
    existsSync(refusalPath),
    false,
    "successful serve cleared the breadcrumb",
  );
  const data2 = await buildHealthData({
    indicesDir: join(MEMORY_ROOT, "indices"),
    scheduleRebuild: () => {},
  });
  assert.equal(
    data2.health_notes.find((n) =>
      String(n).startsWith(`index_generation_refused: ${MV} `),
    ) ?? null,
    null,
    "health note gone after the clear",
  );
  _resetCaches();
});

// ---------------------------------------------------------------------------
// Hermeticity pin: this suite must never create (or read) the memory ledger.
// ---------------------------------------------------------------------------
await test("ledgers/memory.jsonl was never created by this suite", () => {
  assert.equal(
    existsSync(join(MEMORY_ROOT, "ledgers", "memory.jsonl")),
    false,
    "no ledger file was ever created or read",
  );
});

// ---------------------------------------------------------------------------
// REG (memperf) — BACKEND PIN, an assertion instead of the old stderr print.
// T1/T2 are the RED reproduction ONLY on the hnswlib-node runtime (the
// linear-scan runtime always decoded its own formats), so a silently-swapped
// fallback backend would turn this suite into an unfailable gate. Assert it.
// ---------------------------------------------------------------------------
await test("HNSW backend is the native hnswlib-node runtime (T1/T2 only reproduce the incident there)", () => {
  assert.equal(
    HNSW_BACKEND,
    "hnswlib-node",
    `HNSW_BACKEND=${HNSW_BACKEND} — the linear-scan fallback cannot exercise the ` +
      "native deserialize path this suite gates on (install/rebuild hnswlib-node)",
  );
});
