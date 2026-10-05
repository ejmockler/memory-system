// index-manifest.test.mjs — S3 immutable generation manifest for the
// BM25 + HNSW index pair.
//
// T1 is the RED-FIRST mixed-generation reproduction, expressed only through
// the public index-cache.js API so it is valid pre- and post-fix: pre-S3,
// hnsw-index.js save() published hnsw.bin and hnsw.bin.meta.json as TWO
// independent renames, so a crash between them (or a concurrent reader)
// paired a new HNSW graph with an old id map — and an ANN label resolved to
// the WRONG fact id. loadIndices had no way to notice.
//
// RED-FIRST EVIDENCE — verbatim failing run against the UNMODIFIED pre-S3
// index-cache.js/hnsw-index.js (2026-07-14, branch memperf, before
// index-manifest.js existed):
//
//   ✖ T1 mixed generations: gen-B hnsw.bin under gen-A meta is refused; retained prior generation served (14.143458ms)
//     AssertionError [ERR_ASSERTION]: mixed pair must never resolve a foreign vector to gen-1's mem_x (got mem_x @ cosine_distance 0)
//
//     true !== false
//
//         at TestContext.<anonymous> (file:///<checkout>/mcp/test/recall/index-manifest.test.mjs:226:12)
//       actual: true,
//       expected: false,
//       operator: 'strictEqual'
//
// i.e. the pre-change loader happily served gen-B's graph through gen-A's
// id map: a query for the FOREIGN vector u9 (never a vector of any gen-1
// fact) came back as gen-1's "mem_x" at cosine_distance 0 — the exact
// wrong-fact-id exposure S3 closes. (T2+ additionally failed with
// ERR_MODULE_NOT_FOUND for lib/recall/index-manifest.js, which did not
// exist pre-change.) The same test is green post-fix (manifest-gated
// loading + checksum refusal + prior-generation fallback).
//
// Discipline (matches test/recall/index-wal.test.mjs — RED-RUN ISOLATION):
//   - mkdtempSync rooted in tmpdir; MEMORY_ROOT + POLICY_BASE_DIR +
//     STORAGE_BASE_DIR + LEDGERS_BASE_DIR overwritten BEFORE any dynamic
//     import. Live indices / live ledger are NEVER touched.
//   - fixtures only; a final assertion pins that ledgers/memory.jsonl was
//     never created inside the temp tree.
//   - small synthetic dims=8 unit vectors; per-test model versions.
//   - node:test + node:assert/strict; _resetCaches() between tests.
//   - index-manifest.js is imported LAZILY (inside the tests that need it)
//     so T1 stays runnable against pre-change code.

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Hermeticity: stake tmp dirs + overwrite env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-index-manifest-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
process.env.TELEMETRY_BASE_DIR = join(MEMORY_ROOT, "telemetry");
// High thresholds: nothing auto-flushes; flushes in these tests are explicit.
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

// Dynamic import AFTER env override. index-manifest.js is deliberately NOT
// imported here (RED-RUN ISOLATION — see header).
const {
  loadIndices,
  saveIndices,
  scheduleSaveIndices,
  flushIndicesNow,
  _resetCaches,
} = await import("../../lib/recall/index-cache.js");
const { WAL_FILE, readAppliedCursor } = await import(
  "../../lib/recall/index-wal.js"
);
const { HnswIndex, HNSW_BACKEND } = await import(
  "../../lib/recall/hnsw-index.js"
);
const { Bm25Index } = await import("../../lib/recall/bm25-index.js");
const { writeBm25IndexV2Atomic } = await import(
  "../../lib/recall/bm25-rebuild.js"
);

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
const DIMS = 8;
const NATIVE = HNSW_BACKEND === "hnswlib-node";

function dirFor(modelVersion) {
  return join(MEMORY_ROOT, "indices", modelVersion);
}

function unitVec(seed) {
  const v = [];
  let x = (seed + 1) * 2654435761;
  for (let i = 0; i < DIMS; i++) {
    x = (x * 1103515245 + 12345) % 2147483647;
    v.push((x % 1000) / 1000 + 0.01);
  }
  const norm = Math.sqrt(v.reduce((s, a) => s + a * a, 0));
  return v.map((a) => a / norm);
}

function bm25EntryFor(id, token) {
  return {
    memory_id: id,
    kind: "fact",
    content: `synthetic fact ${id} ${token}`,
    ts: "2026-07-14T00:00:00Z",
    entities: [],
    valence: null,
    consent_basis: "first_party",
  };
}

function freshIndices(modelVersion) {
  return {
    bm25: new Bm25Index(),
    hnsw: new HnswIndex({
      dims: DIMS,
      embedding_model_version: modelVersion,
      maxElements: 1024,
    }),
  };
}

function addFact(pair, id, token, seed) {
  pair.bm25.add(bm25EntryFor(id, token));
  pair.hnsw.add(id, unitVec(seed));
}

// Add to the in-memory indices AND schedule the debounced persist — mirrors
// updateIndicesForFact's exact sequence in distill-promote-fact.js.
function addAndSchedule(modelVersion, pair, id, token, seed) {
  const entry = bm25EntryFor(id, token);
  const vector = unitVec(seed);
  pair.bm25.add(entry);
  pair.hnsw.add(id, vector);
  return scheduleSaveIndices(
    modelVersion,
    pair,
    { factId: id, bm25Entry: entry, vector },
  );
}

// ---------------------------------------------------------------------------
// (T1) RED-FIRST: mixed-generation exposure. Gen 0 = {mem_g0, mem_g1};
// gen 1 = gen 0 + mem_x (label 2 in the id map). A FOREIGN binary whose
// label 2 holds unitVec(9) is then placed at hnsw.bin while gen-1's
// .meta.json stays — the exact on-disk state a crash between hnsw-index.js
// save()'s two renames leaves behind. Pre-change loadIndices served the
// pair: search(unitVec(9)) resolved label 2 through gen-1's id map to
// "mem_x" at cosine_distance 0 — the WRONG fact id. Post-change the
// manifest checksums refuse the mix and the retained gen 0 is served.
//
// Native-backend only: the bin/meta two-file publication (and therefore the
// mixed-pair window) exists only under hnswlib-node. The linear-scan format
// is a single self-contained file.
// ---------------------------------------------------------------------------
await test(
  "T1 mixed generations: gen-B hnsw.bin under gen-A meta is refused; retained prior generation served",
  { skip: !NATIVE ? "hnswlib-node backend unavailable" : false },
  () => {
    _resetCaches();
    const MV = "s3-t1-mixed-pair";
    const dir = dirFor(MV);

    // Generation 0: two facts.
    const pair = freshIndices(MV);
    addFact(pair, "mem_g0", "alephglyph", 0);
    addFact(pair, "mem_g1", "bethglyph", 1);
    saveIndices(MV, pair);

    // Generation 1: + mem_x (internal label 2 in the meta id map).
    addFact(pair, "mem_x", "xanaduglyph", 5);
    saveIndices(MV, pair);

    // Foreign generation B, built in a scratch dir: labels 0,1,2 hold
    // unitVec(6), unitVec(7), unitVec(9) — vectors of NO gen-1 fact.
    const scratch = join(TMP_ROOT, "scratch-t1");
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const foreign = new HnswIndex({
      dims: DIMS,
      embedding_model_version: MV,
      maxElements: 1024,
    });
    foreign.add("mem_f0", unitVec(6));
    foreign.add("mem_f1", unitVec(7));
    foreign.add("mem_f2", unitVec(9));
    foreign.save(join(scratch, "hnsw.bin"));

    // Simulate the crash between the two renames: gen-B's binary lands at
    // the live path, gen-1's .meta.json (id map) stays.
    copyFileSync(join(scratch, "hnsw.bin"), join(dir, "hnsw.bin"));

    _resetCaches(); // fresh process: no warm cache
    const loaded = loadIndices(MV);

    // The wrong-fact-id exposure: a query for the foreign vector must never
    // come back as gen-1's mem_x at ~zero distance (that is gen-B's graph
    // read through gen-A's id map).
    const hits = loaded.hnsw.search(unitVec(9), 1);
    const top = hits.length > 0 ? hits[0] : null;
    const wrongIdServed =
      top != null && top.memory_id === "mem_x" && top.cosine_distance < 1e-3;
    assert.equal(
      wrongIdServed,
      false,
      `mixed pair must never resolve a foreign vector to gen-1's mem_x ` +
        `(got ${top == null ? "no hit" : `${top.memory_id} @ cosine_distance ${top.cosine_distance}`})`,
    );

    // Refusal is generation-atomic: NOTHING of the mismatched gen-1 pair is
    // served — the retained prior generation (gen 0) is.
    assert.equal(
      loaded.hnsw.has("mem_x"),
      false,
      "gen-1's id map is not served over gen-B's binary (fallback = retained gen 0)",
    );
    assert.equal(
      loaded.bm25.search("xanaduglyph", 5).length,
      0,
      "gen-1-only bm25 content not served (generation served as a unit)",
    );
    assert.ok(
      loaded.hnsw.has("mem_g0") && loaded.hnsw.has("mem_g1"),
      "retained prior generation (gen 0) served as the fallback",
    );
    const b0 = loaded.bm25.search("alephglyph", 5);
    assert.equal(b0.length, 1, "gen-0 bm25 content served");
    assert.equal(b0[0].memory_id, "mem_g0");
    _resetCaches();
  },
);

// ---------------------------------------------------------------------------
// (T2) Migration: first load with NO manifest adopts the current on-disk
// files as generation 0 (checksummed); the files themselves are untouched.
// ---------------------------------------------------------------------------
await test("T2 no manifest: first load adopts on-disk files as generation 0", async () => {
  _resetCaches();
  const MV = "s3-t2-adoption";
  const dir = dirFor(MV);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Legacy publication (pre-manifest layout): direct member writes, no
  // saveIndices — exactly what a pre-S3 tree looks like.
  const pair = freshIndices(MV);
  addFact(pair, "mem_l0", "gimelglyph", 10);
  addFact(pair, "mem_l1", "dalethglyph", 11);
  writeBm25IndexV2Atomic(join(dir, "bm25.json"), pair.bm25);
  pair.hnsw.save(join(dir, "hnsw.bin"));

  const { MANIFEST_FILE, readActiveManifest, verifyGenerationMembers } =
    await import("../../lib/recall/index-manifest.js");
  assert.equal(
    existsSync(join(dir, MANIFEST_FILE)),
    false,
    "fixture: no manifest before the first load",
  );

  const bm25Before = statSync(join(dir, "bm25.json"));
  const hnswBefore = statSync(join(dir, "hnsw.bin"));

  _resetCaches();
  const loaded = loadIndices(MV);
  assert.ok(loaded.hnsw.has("mem_l0"), "legacy facts served after adoption");
  assert.equal(loaded.bm25.search("gimelglyph", 5)[0].memory_id, "mem_l0");

  // Adoption wrote a generation-0 manifest binding the CURRENT files...
  const { manifest, error } = readActiveManifest(dir);
  assert.equal(error, null, "adopted manifest readable");
  assert.equal(manifest.generation, 0, "legacy state adopted as generation 0");
  assert.equal(manifest.adopted, true, "manifest marked as a legacy adoption");
  assert.equal(manifest.previous, null, "generation 0 has no prior generation");
  assert.deepEqual(
    manifest.wal_cursor,
    { applied_seq: 0, applied_offset: 0 },
    "fresh tree: adopted manifest embeds the zero applied cursor verbatim",
  );
  assert.equal(manifest.members.bm25.file, "bm25.json");
  assert.equal(manifest.members.hnsw.file, "hnsw.bin");
  const v = verifyGenerationMembers(dir, manifest.members);
  assert.equal(v.ok, true, `adopted members verify (${JSON.stringify(v.error)})`);

  // ...and adoption is checksum-only: no member file was rewritten.
  const bm25After = statSync(join(dir, "bm25.json"));
  const hnswAfter = statSync(join(dir, "hnsw.bin"));
  assert.equal(bm25After.mtimeMs, bm25Before.mtimeMs, "bm25.json untouched");
  assert.equal(hnswAfter.mtimeMs, hnswBefore.mtimeMs, "hnsw.bin untouched");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T3) Checksum refusal is fail-closed and STRUCTURED; the retained prior
// generation is the fallback; with no valid generation left, recall degrades
// to empty indices (never a mismatched combination).
// ---------------------------------------------------------------------------
await test("T3 checksum mismatch: structured refusal, prior-generation fallback, empty when none", async () => {
  _resetCaches();
  const MV = "s3-t3-refusal";
  const dir = dirFor(MV);

  const pair = freshIndices(MV);
  addFact(pair, "mem_a0", "heglyph", 20);
  saveIndices(MV, pair); // generation 0
  addFact(pair, "mem_a1", "vavglyph", 21);
  saveIndices(MV, pair); // generation 1 (gen 0 retained as fallback)

  const { readActiveManifest, verifyGenerationMembers, retentionMemberNames } =
    await import("../../lib/recall/index-manifest.js");

  // Tamper with the ACTIVE generation's hnsw member.
  appendFileSync(join(dir, "hnsw.bin"), Buffer.from([0x00]));

  const { manifest } = readActiveManifest(dir);
  assert.equal(manifest.generation, 1);
  const v = verifyGenerationMembers(dir, manifest.members);
  assert.equal(v.ok, false, "tampered member refused");
  assert.equal(v.error.code, "index_manifest_member_mismatch");
  assert.equal(v.error.member, "hnsw");
  assert.equal(v.error.file, "hnsw.bin");
  assert.equal(typeof v.error.expected_sha256, "string");

  // Reader falls back to the retained generation 0 — never the mixed pair.
  _resetCaches();
  const loaded = loadIndices(MV);
  assert.equal(loaded.hnsw.has("mem_a1"), false, "tampered gen 1 refused");
  assert.ok(loaded.hnsw.has("mem_a0"), "retained gen 0 served");
  assert.equal(loaded.bm25.search("vavglyph", 5).length, 0);
  assert.equal(loaded.bm25.search("heglyph", 5).length, 1);

  // Tamper the fallback too: NO valid generation remains -> empty indices
  // (fail-closed degrade), never a mismatched combination.
  const prevNames = retentionMemberNames(manifest.previous.generation);
  appendFileSync(join(dir, prevNames.hnsw), Buffer.from([0x00]));
  _resetCaches();
  const empty = loadIndices(MV);
  assert.equal(empty.hnsw.size(), 0, "no valid generation -> empty hnsw");
  assert.equal(empty.bm25.search("heglyph", 5).length, 0, "empty bm25");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T4) Flush path: the debounced flush activates a NEW generation inside the
// flush lease and the manifest embeds the CAPTURED WAL applied cursor
// {applied_seq, applied_offset} verbatim; retirement (cursor advance)
// happens at/after activation, never before.
// ---------------------------------------------------------------------------
await test("T4 flush activates a new generation embedding the captured WAL cursor verbatim", async () => {
  _resetCaches();
  const MV = "s3-t4-flush-cursor";
  const dir = dirFor(MV);

  const pair = freshIndices(MV);
  addFact(pair, "mem_b0", "zayinglyph", 30);
  saveIndices(MV, pair); // generation 0
  _resetCaches();

  const live = loadIndices(MV);
  const r1 = addAndSchedule(MV, live, "mem_b1", "hethglyph", 31);
  assert.equal(r1.flushed, false, "batch=1000: no auto-flush");
  addAndSchedule(MV, live, "mem_b2", "tethglyph", 32);
  const walSizeBefore = statSync(join(dir, WAL_FILE)).size;
  assert.ok(walSizeBefore > 0, "fixture: two unretired WAL records");

  assert.equal(flushIndicesNow(MV), true, "flush succeeds");

  const { readActiveManifest, verifyGenerationMembers } = await import(
    "../../lib/recall/index-manifest.js"
  );
  const { manifest, error } = readActiveManifest(dir);
  assert.equal(error, null);
  assert.equal(manifest.generation, 1, "flush activated the next generation");
  // The captured cursor {applied_seq: tail.lastSeq, applied_offset:
  // tail.lastOffset} embedded VERBATIM (offset is the pre-compaction byte
  // offset of the last flushed record — i.e. the WAL size at capture).
  assert.deepEqual(
    manifest.wal_cursor,
    { applied_seq: 2, applied_offset: walSizeBefore },
    "manifest embeds the captured WAL applied cursor verbatim",
  );
  // Retirement happened (at/after activation): on-disk cursor agrees on seq.
  assert.equal(readAppliedCursor(dir).applied_seq, 2, "records retired");

  // Model metadata binds the generation to the index geometry.
  assert.equal(manifest.embedding_model_version, MV);
  assert.equal(manifest.dims, DIMS);
  assert.equal(manifest.hnsw_backend, HNSW_BACKEND);
  if (NATIVE) {
    assert.ok(manifest.members.hnsw_meta != null, "meta sidecar is a bound member");
  }
  const v = verifyGenerationMembers(dir, manifest.members);
  assert.equal(v.ok, true, "activated members verify");

  // Prior generation retained as the fallback.
  assert.equal(manifest.previous.generation, 0);
  const pv = verifyGenerationMembers(dir, manifest.previous.members);
  assert.equal(pv.ok, true, "retained prior generation verifies");

  // The flushed generation serves everything on a cold load.
  _resetCaches();
  const loaded = loadIndices(MV);
  assert.ok(loaded.hnsw.has("mem_b0"));
  assert.ok(loaded.hnsw.has("mem_b1"));
  assert.ok(loaded.hnsw.has("mem_b2"));
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T5) GC: exactly ONE prior generation is retained; older generations are
// removed; the fallback generation is never unlinked (it still loads).
// ---------------------------------------------------------------------------
await test("T5 GC retains exactly one prior generation; the fallback is never unlinked", async () => {
  _resetCaches();
  const MV = "s3-t5-gc";
  const dir = dirFor(MV);

  const pair = freshIndices(MV);
  addFact(pair, "mem_c0", "yodglyph", 40);
  saveIndices(MV, pair); // generation 0
  addFact(pair, "mem_c1", "kaphglyph", 41);
  saveIndices(MV, pair); // generation 1 (retains gen 0)
  addFact(pair, "mem_c2", "lamedglyph", 42);
  saveIndices(MV, pair); // generation 2 (retains gen 1, GCs gen 0)

  const { readActiveManifest } = await import(
    "../../lib/recall/index-manifest.js"
  );
  const { manifest } = readActiveManifest(dir);
  assert.equal(manifest.generation, 2);
  assert.equal(manifest.previous.generation, 1, "exactly one prior retained");

  const genFiles = readdirSync(dir).filter((f) => /\.gen-\d+\./.test(f));
  assert.ok(
    genFiles.every((f) => /\.gen-1\./.test(f)),
    `only gen-1 retention files remain (got ${JSON.stringify(genFiles)})`,
  );
  assert.ok(genFiles.length > 0, "the fallback generation's files exist");

  // The retained fallback actually loads: tamper the active generation and
  // the reader must serve gen 1 (never empty while the fallback is intact).
  appendFileSync(join(dir, "bm25.json"), "\n{}");
  _resetCaches();
  const loaded = loadIndices(MV);
  assert.equal(loaded.hnsw.has("mem_c2"), false, "tampered gen 2 refused");
  assert.ok(loaded.hnsw.has("mem_c0") && loaded.hnsw.has("mem_c1"), "gen 1 served");
  assert.equal(loaded.bm25.search("kaphglyph", 5).length, 1);
  _resetCaches();
});

// ===========================================================================
// FIX CYCLE 2 (2026-07-14) — T6..T12. The manifest core (T1-T5) survived
// review; what refuted was COMPLETENESS: three out-of-band writers
// (bm25-rebuild.js:372, reembed-local-4096.mjs:658,
// backfill-embeddings.mjs:491) rewrote members at the FIXED paths with no
// manifest rebind, so the manifest-gated loader REFUSED the whole generation
// on the next cold load (on a previous-less tree: EMPTY indices forever);
// plus a verify->deserialize reader race, a size-only retention guard, a
// missing binTmp fsync, and silent gen-0 re-adoption over a corrupt manifest
// on the save path. Each test below is red-first; new API (publishGeneration,
// _setAfterVerifyHook, recordVerifiedDigest, ...) is imported LAZILY so the
// suite stays runnable against pre-fix code (RED-RUN ISOLATION).
//
// RED-RUN EVIDENCE — verbatim failing runs against the pre-fix code
// (2026-07-14, branch memperf; for T8 only the test hook was staged, not the
// fix):
//   ✖ T6 ... — TypeError: publishGeneration is not a function
//       (there IS no sanctioned rebind seam pre-fix — the refusal half of T6
//        PASSED against pre-fix code, i.e. the outage is real: the unbound
//        daemon rewrite is refused and recall serves empty indices)
//   ✖ T7 ... — TypeError: publishGeneration is not a function (same outage,
//        reembed-style hnsw rewrite)
//   ✖ T8 ... — AssertionError: raced load must never resolve the foreign
//        vector to mem_r2 (got mem_r2 @ cosine_distance 0) — the mixed
//        bin/meta pair WAS served across the verify->deserialize window
//   ✖ T9 ... — AssertionError: existing snapshot NEVER clobbered by
//        same-size foreign bytes — the size-only guard hardlinked the
//        crashed-successor's foreign bytes OVER the good fallback snapshot
//   ✖ T10 .. — AssertionError: save over a corrupt manifest THROWS — pre-fix
//        saveIndices silently re-adopted generation 0 over the corrupt
//        manifest (lineage + fallback destroyed, no error)
//   ✖ T11 .. — AssertionError: binTmp is fsynced at fd level between write
//        and rename — pre-fix the native branch renamed the un-fsynced bin
//   ✖ T12 .. — TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be
//        of type string. Received undefined (DIGEST_CACHE_FILE did not exist
//        — no verified-digest cache pre-fix: every cold load full-hashed the
//        ~1.9 GB hnsw.bin)
// ===========================================================================

// ---------------------------------------------------------------------------
// (T6) OUT-OF-BAND WRITER, bm25 (daemon rebuild seam). RED half documents the
// fix-cycle-2 outage: a daemon-style fixed-path rewrite of bm25.json
// (tmp+rename via writeBm25IndexV2Atomic — exactly bm25-rebuild.js's writer)
// with NO manifest rebind is REFUSED by the manifest-gated loader, and on a
// previous-less tree recall degrades to EMPTY indices. GREEN half: the same
// rewrite routed through publishGeneration is served as a fresh generation,
// with the untouched hnsw member's recorded checksum carried forward.
// ---------------------------------------------------------------------------
await test("T6 out-of-band fixed-path bm25 rewrite is refused (the outage); publishGeneration rebinds and serves", async () => {
  _resetCaches();
  const MV = "s3-t6-oob-bm25";
  const dir = dirFor(MV);

  // Generation 0 — previous=null, no retention snapshots: the exact
  // legacy-adopted/first-save tree the review reproduced EMPTY-forever on.
  const pair = freshIndices(MV);
  addFact(pair, "mem_d0", "memglyph", 50);
  saveIndices(MV, pair);

  // Daemon-style rebuild output (a superset) lands at the FIXED path.
  const rebuilt = new Bm25Index();
  rebuilt.add(bm25EntryFor("mem_d0", "memglyph"));
  rebuilt.add(bm25EntryFor("mem_d1", "nunglyph"));
  writeBm25IndexV2Atomic(join(dir, "bm25.json"), rebuilt);

  // TODAY'S OUTAGE, documented: active generation refused (bm25 checksum
  // mismatch), no fallback exists -> empty indices; the rebuild output is
  // silently discarded.
  _resetCaches();
  const refused = loadIndices(MV);
  assert.equal(
    refused.bm25.search("memglyph", 5).length,
    0,
    "active generation refused: fail-closed to empty bm25",
  );
  assert.equal(
    refused.bm25.search("nunglyph", 5).length,
    0,
    "the unbound rebuild output is never served",
  );
  assert.equal(refused.hnsw.size(), 0, "generation refused as a UNIT");

  // GREEN half: the SAME rewrite through the publisher seam.
  const { publishGeneration } = await import("../../lib/recall/index-cache.js");
  const { readActiveManifest, verifyGenerationMembers } = await import(
    "../../lib/recall/index-manifest.js"
  );
  const before = readActiveManifest(dir).manifest;
  publishGeneration(MV, {
    bm25: (fixedPath) => writeBm25IndexV2Atomic(fixedPath, rebuilt),
  });
  const { manifest, error } = readActiveManifest(dir);
  assert.equal(error, null);
  assert.equal(
    manifest.generation,
    before.generation + 1,
    "publisher rebinds a NEW generation",
  );
  assert.equal(
    manifest.members.hnsw.sha256,
    before.members.hnsw.sha256,
    "unchanged hnsw member's recorded checksum carried forward (partial publish)",
  );
  assert.notEqual(
    manifest.members.bm25.sha256,
    before.members.bm25.sha256,
    "rewritten bm25 member re-checksummed",
  );
  const v = verifyGenerationMembers(dir, manifest.members);
  assert.equal(v.ok, true, `published members verify (${JSON.stringify(v.error)})`);

  _resetCaches();
  const served = loadIndices(MV);
  assert.equal(
    served.bm25.search("nunglyph", 5)[0].memory_id,
    "mem_d1",
    "rebound rebuild output served as a fresh generation",
  );
  assert.ok(served.hnsw.has("mem_d0"), "carried hnsw member served");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T7) OUT-OF-BAND WRITER, hnsw (reembed seam) — analogous to T6 for the
// reembed-local-4096.mjs bare hnsw.save(HNSW_PATH) rewrite.
// ---------------------------------------------------------------------------
await test("T7 out-of-band fixed-path hnsw rewrite is refused; publishGeneration({hnsw}) rebinds and serves", async () => {
  _resetCaches();
  const MV = "s3-t7-oob-hnsw";
  const dir = dirFor(MV);

  const pair = freshIndices(MV);
  addFact(pair, "mem_e0", "samekhglyph", 60);
  saveIndices(MV, pair);

  // reembed-style: a BIGGER hnsw saved at the FIXED path, no manifest rebind.
  const rebuilt = new HnswIndex({
    dims: DIMS,
    embedding_model_version: MV,
    maxElements: 1024,
  });
  rebuilt.add("mem_e0", unitVec(60));
  rebuilt.add("mem_e1", unitVec(61));
  rebuilt.save(join(dir, "hnsw.bin"));

  _resetCaches();
  const refused = loadIndices(MV);
  assert.equal(refused.hnsw.size(), 0, "unbound hnsw rewrite refused (outage)");
  assert.equal(
    refused.bm25.search("samekhglyph", 5).length,
    0,
    "generation refused as a unit",
  );

  const { publishGeneration } = await import("../../lib/recall/index-cache.js");
  const { readActiveManifest } = await import(
    "../../lib/recall/index-manifest.js"
  );
  const before = readActiveManifest(dir).manifest;
  publishGeneration(MV, { hnsw: rebuilt });
  const { manifest, error } = readActiveManifest(dir);
  assert.equal(error, null);
  assert.equal(manifest.generation, before.generation + 1);
  assert.equal(
    manifest.members.bm25.sha256,
    before.members.bm25.sha256,
    "untouched bm25 member's recorded checksum carried forward",
  );

  _resetCaches();
  const served = loadIndices(MV);
  assert.ok(served.hnsw.has("mem_e1"), "rebound reembed output served");
  assert.equal(
    served.bm25.search("samekhglyph", 5)[0].memory_id,
    "mem_e0",
    "carried bm25 member served",
  );
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T8) READER RACE: verify -> deserialize is not atomic. A concurrent
// publisher's FIRST member rename (the bin) landing inside that window paired
// a foreign graph with the verified generation's id map — the wrong-fact-id
// exposure again, this time through a checksum-verified load. The fix
// re-stats the manifest fingerprint AND the candidate's member identities
// (ino:mtimeMs:size) after deserialize, discards the candidate on any change,
// retries the walk (bounded), then fails closed. _setAfterVerifyHook is the
// deterministic interleaving point (test-only).
//
// Native-backend only: the bin/meta mixed pair needs the two-file layout.
// ---------------------------------------------------------------------------
await test(
  "T8 reader race: member swap between verify and deserialize is discarded, retried, never a wrong fact id",
  { skip: !NATIVE ? "hnswlib-node backend unavailable" : false },
  async () => {
    _resetCaches();
    const MV = "s3-t8-reader-race";
    const dir = dirFor(MV);

    const pair = freshIndices(MV);
    addFact(pair, "mem_r0", "ayinglyph", 70);
    addFact(pair, "mem_r1", "peglyph", 71);
    saveIndices(MV, pair); // generation 0
    addFact(pair, "mem_r2", "tsadeglyph", 72);
    saveIndices(MV, pair); // generation 1 (gen 0 retained as the fallback)

    // The successor publisher's mid-flight artifact: label 2 holds unitVec(9)
    // — under gen 1's id map label 2 is mem_r2, so a mixed pair resolves the
    // foreign vector to mem_r2 at distance ~0.
    const scratch = join(TMP_ROOT, "scratch-t8");
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const foreign = new HnswIndex({
      dims: DIMS,
      embedding_model_version: MV,
      maxElements: 1024,
    });
    foreign.add("mem_f0", unitVec(80));
    foreign.add("mem_f1", unitVec(81));
    foreign.add("mem_f2", unitVec(9));
    foreign.save(join(scratch, "hnsw.bin"));

    _resetCaches(); // fresh process; ALSO clears any prior hook
    const { _setAfterVerifyHook } = await import(
      "../../lib/recall/index-cache.js"
    );
    let fired = 0;
    _setAfterVerifyHook(() => {
      fired += 1;
      _setAfterVerifyHook(null); // one-shot
      // The publisher's first member rename lands NOW — after our verify,
      // before our deserialize. Meta and manifest stay gen 1's (mid-flight).
      renameSync(join(scratch, "hnsw.bin"), join(dir, "hnsw.bin"));
    });

    const loaded = loadIndices(MV);
    assert.equal(fired, 1, "the race was injected exactly once");

    const hits = loaded.hnsw.search(unitVec(9), 1);
    const top = hits.length > 0 ? hits[0] : null;
    const wrongIdServed =
      top != null && top.memory_id === "mem_r2" && top.cosine_distance < 1e-3;
    assert.equal(
      wrongIdServed,
      false,
      `raced load must never resolve the foreign vector to mem_r2 ` +
        `(got ${top == null ? "no hit" : `${top.memory_id} @ cosine_distance ${top.cosine_distance}`})`,
    );

    // The retry walk re-verified: the swapped bin fails gen 1's checksums,
    // so the retained gen 0 is served WHOLE.
    assert.equal(loaded.hnsw.has("mem_r2"), false, "half-swapped gen 1 refused on retry");
    assert.ok(
      loaded.hnsw.has("mem_r0") && loaded.hnsw.has("mem_r1"),
      "retained gen 0 served after the race",
    );
    assert.equal(
      loaded.bm25.search("tsadeglyph", 5).length,
      0,
      "generation served as a unit",
    );
    _resetCaches();
  },
);

// ---------------------------------------------------------------------------
// (T9) RETENTION GUARD: a crashed successor that replaced a fixed path with
// SAME-SIZE foreign bytes must never clobber the existing (good) generation
// snapshot when the next save re-runs retention. Pre-fix the guard was
// size-only and linkOrCopyReplace overwrote the snapshot.
// ---------------------------------------------------------------------------
await test("T9 retention guard: same-size foreign bytes at the fixed path never clobber the existing snapshot", async () => {
  _resetCaches();
  const MV = "s3-t9-retention-guard";
  const dir = dirFor(MV);

  const pair = freshIndices(MV);
  addFact(pair, "mem_s0", "qophglyph", 90);
  saveIndices(MV, pair); // generation 0 active

  const {
    readActiveManifest,
    retainActiveGeneration,
    retentionMemberNames,
    sha256File,
  } = await import("../../lib/recall/index-manifest.js");
  const { manifest } = readActiveManifest(dir);

  // Successor save #A takes its retention snapshot while the fixed path
  // still holds the recorded bytes...
  const first = retainActiveGeneration(dir, manifest);
  assert.equal(first.error, null, "first retention succeeds");
  const names = retentionMemberNames(manifest.generation);
  const goodSha = sha256File(join(dir, names.bm25));
  assert.equal(goodSha, manifest.members.bm25.sha256, "snapshot holds the recorded bytes");

  // ...then #A crashes after replacing bm25.json with SAME-SIZE foreign
  // bytes (tmp+rename — the sanctioned replacement mechanics) and BEFORE
  // activating its manifest.
  const bm25Path = join(dir, "bm25.json");
  const size = statSync(bm25Path).size;
  const foreignBytes = Buffer.alloc(size, 0x5a);
  writeFileSync(`${bm25Path}.tmp-t9`, foreignBytes);
  renameSync(`${bm25Path}.tmp-t9`, bm25Path);

  // Successor save #B re-runs retention against the SAME active manifest.
  const second = retainActiveGeneration(dir, manifest);
  assert.equal(second.error, null, "second retention degrades gracefully");
  assert.equal(
    sha256File(join(dir, names.bm25)),
    goodSha,
    "existing snapshot NEVER clobbered by same-size foreign bytes",
  );
  assert.equal(
    second.members.bm25.sha256,
    manifest.members.bm25.sha256,
    "returned entry keeps the recorded content identity",
  );
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T10) SAVE-PATH FAIL-CLOSED: a manifest that EXISTS but cannot be parsed
// must make the save THROW a structured error. Pre-fix saveIndices discarded
// readActiveManifest().error and fell through to adoptGeneration0, silently
// re-adopting generation 0 OVER the corrupt manifest (lineage + retained
// fallback destroyed, no error surfaced).
// ---------------------------------------------------------------------------
await test("T10 corrupt-but-present manifest on the SAVE path fails closed (no silent gen-0 re-adoption)", async () => {
  _resetCaches();
  const MV = "s3-t10-corrupt-manifest-save";
  const dir = dirFor(MV);

  const pair = freshIndices(MV);
  addFact(pair, "mem_t0", "reshglyph", 100);
  saveIndices(MV, pair); // generation 0

  const { MANIFEST_FILE } = await import("../../lib/recall/index-manifest.js");
  const manifestPath = join(dir, MANIFEST_FILE);
  writeFileSync(manifestPath, "{ this is not json", "utf8");
  const corruptBytes = readFileSync(manifestPath, "utf8");

  addFact(pair, "mem_t1", "shinglyph", 101);
  let threw = null;
  try {
    saveIndices(MV, pair);
  } catch (e) {
    threw = e;
  }
  assert.ok(
    threw != null,
    "save over a corrupt manifest THROWS (pre-fix it silently re-adopted gen 0)",
  );
  assert.equal(threw.code, "index_manifest_unreadable", "structured error code");
  assert.equal(
    readFileSync(manifestPath, "utf8"),
    corruptBytes,
    "the corrupt manifest was not overwritten (no re-adoption)",
  );
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T11) DURABILITY DISCIPLINE PIN: the native hnsw save must fsync the
// written binary at fd level BEFORE renaming it into place (parity with the
// meta sidecar and activateManifest — the manifest checksums these bytes and
// publishes strictly after them). fsync-before-rename cannot be observed from
// a black box (only a power cut would tell), so this pins the SOURCE
// discipline: between writeIndexSync(binTmp) and renameSync(binTmp, path)
// there must be an fd-level fsync of binTmp. The assertion fails if the
// fsync is removed or reordered.
// ---------------------------------------------------------------------------
await test("T11 native hnsw save fsyncs the written binary before its rename (discipline pin)", () => {
  const src = readFileSync(
    new URL("../../lib/recall/hnsw-index.js", import.meta.url),
    "utf8",
  );
  const writeIdx = src.indexOf("writeIndexSync(binTmp)");
  assert.ok(writeIdx >= 0, "native branch writes the binary to binTmp");
  const renameIdx = src.indexOf("renameSync(binTmp, path)", writeIdx);
  assert.ok(renameIdx > writeIdx, "binTmp is renamed into place after the write");
  const between = src.slice(writeIdx, renameIdx);
  assert.match(
    between,
    /openSync\(binTmp[^)]*\)[\s\S]*fsyncSync\(/,
    "binTmp is fsynced at fd level between write and rename",
  );
});

// ---------------------------------------------------------------------------
// (T12) PERF GATE: verified-digest cache. Cold-load member verification must
// skip the full sha256 when the member's stat identity (ino:mtimeMs:size)
// matches a previously verified digest — publish-time checksums seed the
// persisted sidecar so per-session process spawns never re-hash the ~1.9 GB
// hnsw.bin. (b) proves the skip path is REAL by forging a cache entry for a
// tampered file: verify accepts it without hashing — the designed tradeoff
// (the cache is a trusted 0600 artifact inside MEMORY_ROOT; every sanctioned
// member replacement is tmp+rename, i.e. a new inode -> automatic miss), and
// the fingerprint-miss fail direction is asserted first.
// ---------------------------------------------------------------------------
await test("T12 verified-digest cache: cold-load verify skips the full sha256 on a stat-fingerprint hit", async () => {
  _resetCaches();
  const MV = "s3-t12-digest-cache";
  const dir = dirFor(MV);

  const pair = freshIndices(MV);
  addFact(pair, "mem_u0", "tavglyph", 110);
  saveIndices(MV, pair); // gen 0 — publish-time checksums seed the cache

  const {
    DIGEST_CACHE_FILE,
    memberStatIdentity,
    readActiveManifest,
    recordVerifiedDigest,
    verifyGenerationMembers,
  } = await import("../../lib/recall/index-manifest.js");

  // (a) Publish seeded the persisted cache: each member's CURRENT stat
  // identity maps to its recorded digest.
  const cachePath = join(dir, DIGEST_CACHE_FILE);
  assert.ok(existsSync(cachePath), "digest-cache sidecar persisted at publish time");
  const { manifest } = readActiveManifest(dir);
  const cache = JSON.parse(readFileSync(cachePath, "utf8"));
  for (const key of ["bm25", "hnsw"]) {
    const m = manifest.members[key];
    const st = statSync(join(dir, m.file));
    const hit = cache.entries[memberStatIdentity(st)];
    assert.ok(
      hit != null && hit.sha256 === m.sha256,
      `${key}'s verified digest recorded under its stat identity`,
    );
  }

  // (b) Same-size tamper via tmp+rename -> NEW inode -> fingerprint miss ->
  // the full hash runs and refuses (fail direction intact)...
  const bm25Path = join(dir, "bm25.json");
  const orig = readFileSync(bm25Path);
  const tampered = Buffer.from(orig);
  tampered[tampered.length - 2] ^= 0xff;
  writeFileSync(`${bm25Path}.tmp-t12`, tampered);
  renameSync(`${bm25Path}.tmp-t12`, bm25Path);
  const vMiss = verifyGenerationMembers(dir, manifest.members);
  assert.equal(vMiss.ok, false, "fingerprint miss -> full hash -> tamper refused");
  assert.equal(vMiss.error.code, "index_manifest_member_mismatch");

  // ...then a forged verified digest for the tampered file's identity makes
  // verify PASS without hashing — proof the skip path short-circuits.
  recordVerifiedDigest(dir, statSync(bm25Path), manifest.members.bm25.sha256, "bm25.json");
  const vHit = verifyGenerationMembers(dir, manifest.members);
  assert.equal(
    vHit.ok,
    true,
    "fingerprint hit on a verified digest SKIPS the full sha256 (the perf-gate skip path is real)",
  );
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T13) S2y RED-FIRST: PUBLISHER MUTUAL EXCLUSION. publishGeneration is the
// ONE sanctioned publication seam, but it carried no writer lock of its own:
// an out-of-band publisher (daemon bm25 rebuild, reembed script) running
// concurrently with the lease-holding debounced flush interleaved member
// writes/checksums/manifest activations — the loser bound checksums over the
// winner's bytes (or clobbered the winner's members under the winner's
// manifest), so content silently vanished from the served generation (and,
// in the checksum-skew orderings, the next cold load refused it outright).
// Fix: publishGeneration takes the S2 flush lease when not already held
// (bounded wait); _flushPendingSaves passes opts._leaseHeld; a busy lease is
// a structured throw (code index_flush_lease_busy) the daemon tolerates as a
// retry-next-tick skip.
//
// RED-FIRST EVIDENCE — verbatim failing run against the pre-S2y
// index-cache.js (2026-07-15, branch memperf, isolated scratchpad copy —
// RED-RUN ISOLATION; the live tree was never reverted):
//
//   ✖ T13 publisher mutual exclusion: concurrent publishGeneration vs flush is lease-serialized (103.944417ms)
//     AssertionError [ERR_ASSERTION]: concurrent publish is refused while the flush lease is held
//     + actual - expected
//
//     + null
//     - 'index_flush_lease_busy'
//
//       actual: null,
//       expected: 'index_flush_lease_busy',
//       operator: 'strictEqual',
// ---------------------------------------------------------------------------
await test("T13 publisher mutual exclusion: concurrent publishGeneration vs flush is lease-serialized", async () => {
  _resetCaches();
  const MV = "s3-t13-publisher-mutex";
  const dir = dirFor(MV);
  const { publishGeneration } = await import("../../lib/recall/index-cache.js");
  const { readActiveManifest, verifyGenerationMembers } = await import(
    "../../lib/recall/index-manifest.js"
  );

  // Generation 0, then a pending debounced add (the flush-side writer).
  const pair = freshIndices(MV);
  addFact(pair, "mem_m0", "hookglyph", 130);
  saveIndices(MV, pair);
  _resetCaches();
  const loaded = loadIndices(MV);
  addAndSchedule(MV, loaded, "mem_m1", "latchglyph", 131);

  // The daemon-style rebuild output (a superset, as a real ledger rebuild
  // would be): base + flushed fact + one rebuild-only fact.
  const rebuilt = new Bm25Index();
  rebuilt.add(bm25EntryFor("mem_m0", "hookglyph"));
  rebuilt.add(bm25EntryFor("mem_m1", "latchglyph"));
  rebuilt.add(bm25EntryFor("mem_m2", "boltglyph"));

  // Concurrent publisher: fires MID-FLUSH, inside saveIndices' hnsw member
  // write — the flush lease is held by this very flush (T11-style spy).
  let concurrentErr = null;
  let writerRan = false;
  let spyRan = false;
  const proto = Object.getPrototypeOf(loaded.hnsw);
  loaded.hnsw.save = function (path) {
    spyRan = true;
    try {
      publishGeneration(
        MV,
        { bm25: (fixedPath) => { writerRan = true; writeBm25IndexV2Atomic(fixedPath, rebuilt); } },
        { leaseWaitMs: 50 },
      );
    } catch (e) {
      concurrentErr = e;
    }
    return proto.save.call(this, path);
  };
  try {
    assert.equal(flushIndicesNow(MV), true, "the lease-holding flush succeeds");
  } finally {
    delete loaded.hnsw.save;
  }
  assert.ok(spyRan, "the concurrent publish was attempted mid-flush");
  assert.equal(
    concurrentErr != null ? concurrentErr.code : null,
    "index_flush_lease_busy",
    "concurrent publish is refused while the flush lease is held",
  );
  assert.equal(writerRan, false, "the refused publisher never touched a member file");

  // Retry-next-tick semantics: the SAME publish succeeds once the lease is
  // free, and BOTH resulting generations verify (no checksum-mismatch
  // refusal anywhere in the lineage).
  const afterFlush = readActiveManifest(dir).manifest;
  const vFlush = verifyGenerationMembers(dir, afterFlush.members);
  assert.equal(vFlush.ok, true, `flush generation verifies (${JSON.stringify(vFlush.error)})`);
  publishGeneration(MV, {
    bm25: (fixedPath) => writeBm25IndexV2Atomic(fixedPath, rebuilt),
  });
  const afterPublish = readActiveManifest(dir).manifest;
  assert.equal(
    afterPublish.generation,
    afterFlush.generation + 1,
    "the retried publish rebinds a fresh generation",
  );
  const vPub = verifyGenerationMembers(dir, afterPublish.members);
  assert.equal(vPub.ok, true, `published generation verifies (${JSON.stringify(vPub.error)})`);
  assert.equal(
    afterPublish.members.hnsw.sha256,
    afterFlush.members.hnsw.sha256,
    "the flush's hnsw member carried forward intact (nothing clobbered)",
  );

  // Cold load serves the serialized result — no refusal breadcrumbs, and
  // both the flushed fact and the rebuild-only fact are present.
  const refusals = [];
  const realErr = console.error;
  console.error = (...args) => {
    if (/REFUSING index generation/.test(String(args[0]))) refusals.push(args[0]);
    return realErr.apply(console, args);
  };
  let served;
  _resetCaches();
  try {
    served = loadIndices(MV);
  } finally {
    console.error = realErr;
  }
  assert.deepEqual(refusals, [], "no generation refused on cold load");
  assert.equal(served.bm25.search("latchglyph", 5)[0].memory_id, "mem_m1", "flushed fact served");
  assert.equal(served.bm25.search("boltglyph", 5)[0].memory_id, "mem_m2", "rebuild-only fact served");
  assert.ok(served.hnsw.has("mem_m1"), "flushed hnsw content served");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T14) S2y RED-FIRST: _carryMember bin/meta COHERENCE. When a publication
// carries an hnsw member the active manifest never recorded (a stray pair
// left by an out-of-band writer), the pre-S2y carry checksummed whatever
// bytes sat at hnsw.bin / hnsw.bin.meta.json and bound them — including a
// bin/meta pair that DISAGREES on backend/dims/embedding_model_version,
// which every subsequent cold load verifies successfully (checksums match
// the incoherent bytes!) and then fails to deserialize, churning through the
// fallback chain. Fix: probe pair coherence before binding; refuse the
// incoherent pair with a structured breadcrumb and publish without the
// member.
//
// RED-FIRST EVIDENCE — verbatim failing run against the pre-S2y
// index-cache.js (2026-07-15, branch memperf, isolated scratchpad copy —
// RED-RUN ISOLATION; the live tree was never reverted):
//
//   ✖ T14 _carryMember coherence: incoherent stray hnsw bin/meta pair refused; coherent pair carried (83.12425ms)
//     AssertionError [ERR_ASSERTION]: incoherent bin/meta pair must not be bound into the manifest
//     + actual - expected
//
//     + {
//     +   file: 'hnsw.bin',
//     +   sha256: '4acab262f9b02a7fed01419f46679e6c84d789dbcb43ef4eb23802a56d9e3635',
//     +   size: 391
//     + }
//     - null
//
//       operator: 'deepStrictEqual',
// ---------------------------------------------------------------------------
await test("T14 _carryMember coherence: incoherent stray hnsw bin/meta pair refused; coherent pair carried", async () => {
  _resetCaches();
  const { publishGeneration } = await import("../../lib/recall/index-cache.js");

  const smallBm25 = () => {
    const idx = new Bm25Index();
    idx.add(bm25EntryFor("mem_c0", "wrenglyph"));
    return idx;
  };
  // INCOHERENT fixture: a stray SINGLE-FILE linear-scan v2 NDJSON hnsw.bin,
  // written byte-level so the pair-DISAGREEMENT fixtures are deterministic on
  // BOTH backends (on a native machine, HnswIndex.save emits the opaque
  // binary + its own meta — a coherent pair). Format is exactly
  // hnsw-index.js save()'s linear branch: header line {format:2,
  // backend:"linear-scan", ...} + one {id, iid, v} line per vector.
  const writeStrayLinearHnsw = (dir, mv) => {
    const header = {
      format: 2,
      backend: "linear-scan",
      dims: DIMS,
      embedding_model_version: mv,
      M: 16,
      efConstruction: 200,
      efSearch: 50,
      maxElements: 1024,
      nextId: 1,
      count: 1,
      tombstones: [],
    };
    writeFileSync(
      join(dir, "hnsw.bin"),
      `${JSON.stringify(header)}\n${JSON.stringify({ id: "mem_stray", iid: 0, v: unitVec(140) })}\n`,
      { mode: 0o600 },
    );
  };

  // COHERENT: a stray hnsw artifact written by the REAL writer for this
  // runtime (native: opaque binary + meta sidecar; linear: self-contained
  // single file) is carried and served. Runtime-appropriate by construction
  // — exactly the artifact an out-of-band writer on this host leaves behind.
  const MV1 = "s3-t14-carry-coherent";
  const dir1 = dirFor(MV1);
  publishGeneration(MV1, {
    bm25: (p) => writeBm25IndexV2Atomic(p, smallBm25()),
  }); // gen 0: bm25 only, hnsw unrecorded
  {
    const stray = new HnswIndex({
      dims: DIMS,
      embedding_model_version: MV1,
      maxElements: 64,
    });
    stray.add("mem_stray", unitVec(140));
    stray.save(join(dir1, "hnsw.bin"));
  }
  const pub1 = publishGeneration(MV1, {
    bm25: (p) => writeBm25IndexV2Atomic(p, smallBm25()),
  });
  assert.ok(
    pub1.manifest.members.hnsw != null && typeof pub1.manifest.members.hnsw.sha256 === "string",
    "coherent unrecorded hnsw member is checksummed and bound",
  );
  _resetCaches();
  const served1 = loadIndices(MV1);
  assert.ok(served1.hnsw.has("mem_stray"), "carried coherent member served on cold load");

  // INCOHERENT (backend disagreement): the same linear-scan bin plus a meta
  // sidecar claiming the hnswlib-node backend — the exact pair HnswIndex.load
  // misroutes on. Must be refused with a structured breadcrumb and published
  // WITHOUT the member.
  const MV2 = "s3-t14-carry-incoherent-backend";
  const dir2 = dirFor(MV2);
  publishGeneration(MV2, {
    bm25: (p) => writeBm25IndexV2Atomic(p, smallBm25()),
  });
  writeStrayLinearHnsw(dir2, MV2);
  writeFileSync(
    join(dir2, "hnsw.bin.meta.json"),
    JSON.stringify({
      format: 2,
      backend: "hnswlib-node",
      dims: DIMS,
      embedding_model_version: MV2,
      nextId: 1,
      id_map: [["mem_stray", 0]],
      tombstones: [],
    }),
    { mode: 0o600 },
  );
  const breadcrumbs = [];
  const realErr = console.error;
  console.error = (...args) => {
    if (/index_hnsw_member_incoherent/.test(String(args[0]))) breadcrumbs.push(String(args[0]));
    return realErr.apply(console, args);
  };
  let pub2;
  try {
    pub2 = publishGeneration(MV2, {
      bm25: (p) => writeBm25IndexV2Atomic(p, smallBm25()),
    });
  } finally {
    console.error = realErr;
  }
  assert.deepEqual(
    pub2.manifest.members.hnsw,
    null,
    "incoherent bin/meta pair must not be bound into the manifest",
  );
  assert.deepEqual(pub2.manifest.members.hnsw_meta, null, "the meta half is refused with it");
  assert.equal(breadcrumbs.length, 1, "structured incoherence breadcrumb emitted");
  assert.match(breadcrumbs[0], /backend/, "breadcrumb names the disagreement");
  _resetCaches();
  const served2 = loadIndices(MV2);
  assert.equal(served2.hnsw.size(), 0, "published without the member: bootstrap-empty hnsw");
  assert.equal(
    served2.bm25.search("wrenglyph", 5).length,
    1,
    "the generation itself is served (no refusal churn)",
  );

  // INCOHERENT (dims/model disagreement): meta backend agrees with the bin
  // header, but dims and embedding_model_version do not.
  const MV3 = "s3-t14-carry-incoherent-dims";
  const dir3 = dirFor(MV3);
  publishGeneration(MV3, {
    bm25: (p) => writeBm25IndexV2Atomic(p, smallBm25()),
  });
  writeStrayLinearHnsw(dir3, MV3);
  writeFileSync(
    join(dir3, "hnsw.bin.meta.json"),
    JSON.stringify({
      format: 2,
      backend: "linear-scan",
      dims: DIMS * 2,
      embedding_model_version: "someone-elses-model",
      nextId: 1,
      id_map: [],
      tombstones: [],
    }),
    { mode: 0o600 },
  );
  const breadcrumbs3 = [];
  console.error = (...args) => {
    if (/index_hnsw_member_incoherent/.test(String(args[0]))) breadcrumbs3.push(String(args[0]));
    return realErr.apply(console, args);
  };
  let pub3;
  try {
    pub3 = publishGeneration(MV3, {
      bm25: (p) => writeBm25IndexV2Atomic(p, smallBm25()),
    });
  } finally {
    console.error = realErr;
  }
  assert.deepEqual(pub3.manifest.members.hnsw, null, "dims/model-disagreeing pair refused");
  assert.equal(breadcrumbs3.length, 1, "structured breadcrumb for the dims/model case");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (F1) RED-FIRST: a LINEAR-backend fresh hnsw save that leaves a STALE NATIVE
// hnsw.bin.meta.json on disk (the exact state a prior hnswlib-node save leaves
// after the runtime falls back to linear-scan). Pre-fix publishGeneration
// bound the meta via existsSync(hnswMetaPath)?checksum:null, so the stale
// native sidecar was bound alongside the fresh single-file linear bin: the
// generation VERIFIED on every cold load (checksums match the incoherent
// bytes) and then THREW inside HnswIndex._loadNativeSidecar (a native sidecar
// over a non-native bin) — a permanent ACTIVE-generation refusal + fallback
// churn. Post-fix the meta is bound from the save ARTIFACT's metaPath (null on
// the linear backend): NO stale native meta is bound and the stale sidecar is
// REMOVED, so the cold load no longer refuses.
//
// Host-independent: the on-disk shapes are staged directly (a FUNCTION-writer
// streams the linear NDJSON regardless of this host's HNSW_BACKEND), and the
// coherence outcome for the bin itself is asserted per-runtime.
//
// RED pre-fix: hnsw_meta member is bound (stale native checksum, not null);
// the stale sidecar file survives; and the cold load refuses (deserialize
// throws) so generation_refused != null.
// ---------------------------------------------------------------------------
await test("F1 linear fresh save with a stale native hnsw meta: no stale meta bound, sidecar removed, no refusal churn", async () => {
  _resetCaches();
  const { publishGeneration } = await import("../../lib/recall/index-cache.js");
  const { readActiveManifest, verifyGenerationMembers } = await import(
    "../../lib/recall/index-manifest.js"
  );
  const MV = "f1-linear-fresh-stale-meta";
  const dir = dirFor(MV);

  // Generation 0: a bm25-only lineage (a real manifest to build gen 1 on).
  const bm25gen0 = new Bm25Index();
  bm25gen0.add(bm25EntryFor("mem_f1_0", "phiglyph"));
  publishGeneration(MV, { bm25: (p) => writeBm25IndexV2Atomic(p, bm25gen0) });

  // Stage a STALE NATIVE hnsw.bin.meta.json on disk (a prior hnswlib-node save
  // left it; the runtime then fell back to linear-scan).
  const staleMetaPath = join(dir, "hnsw.bin.meta.json");
  writeFileSync(
    staleMetaPath,
    JSON.stringify({
      format: 2,
      backend: "hnswlib-node",
      dims: DIMS,
      embedding_model_version: MV,
      nextId: 2,
      id_map: [
        ["mem_native_a", 0],
        ["mem_native_b", 1],
      ],
      tombstones: [],
    }),
    { mode: 0o600 },
  );

  // Generation 1: a LINEAR-scan fresh hnsw save via a FUNCTION-writer that
  // streams a single-file NDJSON bin and returns the linear-scan save artifact
  // (metaPath:null) — exactly hnsw-index.js save()'s linear branch shape.
  const writeLinearHnsw = (fixedPath) => {
    const header = {
      format: 2,
      backend: "linear-scan",
      dims: DIMS,
      embedding_model_version: MV,
      M: 16,
      efConstruction: 200,
      efSearch: 50,
      maxElements: 1024,
      nextId: 1,
      count: 1,
      tombstones: [],
    };
    const tmp = `${fixedPath}.tmp-f1`;
    writeFileSync(
      tmp,
      `${JSON.stringify(header)}\n${JSON.stringify({ id: "mem_f1_lin", iid: 0, v: unitVec(200) })}\n`,
      { mode: 0o600 },
    );
    renameSync(tmp, fixedPath);
    return {
      backend: "linear-scan",
      dims: DIMS,
      format: 2,
      embedding_model_version: MV,
      metaPath: null,
    };
  };
  const pub = publishGeneration(MV, { hnsw: writeLinearHnsw });

  // The hnsw_meta member is bound from the artifact metaPath (null), NEVER the
  // stale native sidecar; and the stale sidecar file is REMOVED.
  assert.equal(
    pub.manifest.members.hnsw_meta,
    null,
    "linear save metaPath:null binds NO hnsw_meta member (never the stale native sidecar)",
  );
  assert.equal(
    existsSync(staleMetaPath),
    false,
    "the stale native hnsw.bin.meta.json is removed so HnswIndex.load cannot probe it",
  );
  const v = verifyGenerationMembers(dir, pub.manifest.members);
  assert.equal(v.ok, true, `published members verify (${JSON.stringify(v.error)})`);

  // Cold load: no permanent refusal/churn (pre-fix the stale native meta over
  // the linear bin threw in _loadNativeSidecar -> deserialize_failed refusal).
  _resetCaches();
  const loaded = loadIndices(MV);
  assert.equal(
    loaded.generation_refused,
    null,
    "coherent generation: cold load does NOT refuse the active generation",
  );
  assert.equal(
    loaded.bm25.search("phiglyph", 5).length,
    1,
    "the generation is served (never a refusal degrade to empty)",
  );

  // Host-independent coherence outcome for the linear bin: a linear-scan
  // runtime decodes and serves the single-file bin; a native runtime
  // COHERENTLY drops it (a single-file linear bin is refused there) — either
  // way with no stale meta and no refusal churn.
  if (HNSW_BACKEND === "linear-scan") {
    assert.notEqual(pub.manifest.members.hnsw, null, "linear bin bound on the linear runtime");
    assert.ok(loaded.hnsw.has("mem_f1_lin"), "linear bin served on the linear runtime");
  } else {
    assert.equal(
      pub.manifest.members.hnsw,
      null,
      "single-file linear bin coherence-refused on the native runtime (no incoherent pair bound)",
    );
    assert.equal(loaded.hnsw.size(), 0, "bootstrap-empty hnsw, served without refusal");
  }
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (F2) RED-FIRST: the deserialize-refusal breadcrumb (index-refusal.json, the
// REG index_generation_refused visibility fix memory_health reads) must
// SURVIVE a FALLBACK serve. Pre-fix _clearDeserializeRefusal fired on ANY
// successful candidate serve — including the retained/previous fallback — so
// the breadcrumb was erased the instant a fallback served and health went
// silent about the refused ACTIVE generation. Post-fix it is cleared ONLY when
// the ACTIVE generation itself serves.
// ---------------------------------------------------------------------------
await test("F2 deserialize-refusal breadcrumb survives a FALLBACK serve; cleared only when the ACTIVE generation serves", async () => {
  _resetCaches();
  const { publishGeneration, INDEX_REFUSAL_FILE } = await import(
    "../../lib/recall/index-cache.js"
  );
  const MV = "f2-refusal-breadcrumb";
  const dir = dirFor(MV);

  // Generation 0: healthy — the retained fallback.
  const pair = freshIndices(MV);
  addFact(pair, "mem_f2_0", "chiglyph", 30);
  saveIndices(MV, pair); // gen 0

  // Generation 1: a bm25 member that VERIFIES (its checksum matches the bytes
  // on disk) but cannot be DESERIALIZED (not a valid bm25 index). hnsw carried.
  // Written via tmp+rename (the publisher contract — an in-place write would
  // corrupt the hardlinked gen-0 retention snapshot that must remain the
  // healthy fallback).
  publishGeneration(MV, {
    bm25: (p) => {
      const tmp = `${p}.tmp-f2`;
      writeFileSync(tmp, "this is not a valid bm25 index\n", { mode: 0o600 });
      renameSync(tmp, p);
    },
  });
  const refusalPath = join(dir, INDEX_REFUSAL_FILE);

  // Cold load: the active gen 1 verifies then throws on deserialize; the
  // retained gen 0 serves as the FALLBACK. The breadcrumb must SURVIVE it.
  _resetCaches();
  const loaded = loadIndices(MV);
  assert.equal(
    loaded.bm25.search("chiglyph", 5)[0].memory_id,
    "mem_f2_0",
    "retained gen 0 served as the fallback",
  );
  assert.ok(
    loaded.generation_refused != null && loaded.generation_refused.served === "fallback",
    "the active refusal is reported in-band (served: fallback)",
  );
  assert.equal(
    existsSync(refusalPath),
    true,
    "deserialize-refusal breadcrumb PRESERVED across a fallback serve (health keeps surfacing it)",
  );

  // A later HEALTHY active publish + cold load clears the breadcrumb: the
  // ACTIVE generation itself now serves.
  const healthy = freshIndices(MV);
  addFact(healthy, "mem_f2_0", "chiglyph", 30);
  addFact(healthy, "mem_f2_1", "psiglyph", 31);
  saveIndices(MV, healthy); // gen 2 (healthy active)
  _resetCaches();
  const served = loadIndices(MV);
  assert.equal(served.generation_refused, null, "healthy active generation serves without refusal");
  assert.equal(
    existsSync(refusalPath),
    false,
    "breadcrumb cleared once the ACTIVE generation successfully serves",
  );
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (F3) RED-FIRST: a partial publish that CARRIES a member whose fixed file was
// replaced out-of-band with SAME-SIZE DIFFERENT bytes (new inode) must
// re-checksum the on-disk bytes, never carry the stale recorded sha over
// foreign content. Pre-fix _carryMember trusted `st.size === recorded.size`
// and bound the stale sha — a generation REFUSED on its next cold load
// (recorded sha != on-disk bytes). Post-fix carry's identity check against the
// retention snapshot detects the replacement and binds the REAL digest.
// ---------------------------------------------------------------------------
await test("F3 partial publish re-checksums a SAME-SIZE foreign-replaced carried member (never the stale recorded sha)", async () => {
  _resetCaches();
  const { publishGeneration } = await import("../../lib/recall/index-cache.js");
  const {
    readActiveManifest,
    retainActiveGeneration,
    retentionMemberNames,
    verifyGenerationMembers,
    sha256File,
  } = await import("../../lib/recall/index-manifest.js");
  const MV = "f3-carry-foreign-replace";
  const dir = dirFor(MV);

  // Generation 0: bm25 + hnsw.
  const pair = freshIndices(MV);
  addFact(pair, "mem_f3_0", "omegaglyph", 40);
  saveIndices(MV, pair); // gen 0
  const gen0 = readActiveManifest(dir).manifest;
  const recordedBm25Sha = gen0.members.bm25.sha256;

  // Pre-create gen 0's retention snapshot from the RECORDED bytes (bm25.json
  // still holds them) so the next publish's retention keeps this good snapshot
  // (the T9 content guard) instead of re-linking the foreign fixed path.
  const first = retainActiveGeneration(dir, gen0);
  assert.equal(first.error, null, "gen-0 retention snapshot created from recorded bytes");
  const names = retentionMemberNames(gen0.generation);
  assert.equal(
    sha256File(join(dir, names.bm25)),
    recordedBm25Sha,
    "snapshot holds the recorded bm25 bytes",
  );

  // Out-of-band: replace bm25.json with SAME-SIZE DIFFERENT bytes via
  // tmp+rename (new inode) — the exact spoof a size-only carry misses.
  const bm25Path = join(dir, "bm25.json");
  const size = statSync(bm25Path).size;
  const foreignBytes = Buffer.alloc(size, 0x7e);
  writeFileSync(`${bm25Path}.tmp-f3`, foreignBytes);
  renameSync(`${bm25Path}.tmp-f3`, bm25Path);
  const foreignSha = sha256File(bm25Path);
  assert.notEqual(foreignSha, recordedBm25Sha, "fixture: foreign bytes differ from recorded (same size)");

  // Partial publish: rewrite hnsw, CARRY bm25. Retention keeps the good gen-0
  // snapshot (the foreign fixed bytes fail its content guard), so carry's
  // identity check detects the replacement and re-checksums the on-disk bytes.
  const rebuiltHnsw = new HnswIndex({ dims: DIMS, embedding_model_version: MV, maxElements: 1024 });
  rebuiltHnsw.add("mem_f3_0", unitVec(40));
  const pub = publishGeneration(MV, { hnsw: rebuiltHnsw });

  assert.equal(
    pub.manifest.members.bm25.sha256,
    foreignSha,
    "carried bm25 re-checksummed to the REAL on-disk digest",
  );
  assert.notEqual(
    pub.manifest.members.bm25.sha256,
    recordedBm25Sha,
    "carried bm25 is NEVER bound with the stale recorded sha over foreign bytes",
  );
  // The generation VERIFIES on the next cold load (recorded == on-disk),
  // instead of being refused for a bm25 checksum mismatch.
  const v = verifyGenerationMembers(dir, pub.manifest.members);
  assert.equal(v.ok, true, `published generation verifies (${JSON.stringify(v.error)})`);
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (F5) evictModelIndices — production-safe eviction of ONE model's cached
// BM25 + HNSW refs (and a pending-save timer) from the module-global cache.
// Touches no on-disk index/manifest/WAL bytes, loses no durable data (an
// un-flushed WAL add replays on the next cold load), and is a no-op on a cold
// model. The after-verify hook (fires on a cold load, never on a warm hit) is
// the cache-drop seam: load(cold) -> load(warm) -> evict -> load(cold, fires
// again) proves the refs were dropped.
// ---------------------------------------------------------------------------
await test("F5 evictModelIndices drops the cached model refs and a pending-save timer; touches no on-disk bytes", async () => {
  _resetCaches();
  const { evictModelIndices, _indexCacheHas, _setAfterVerifyHook, scheduleSaveIndices } =
    await import("../../lib/recall/index-cache.js");
  const MV = "f5-evict";
  const dir = dirFor(MV);

  // A real generation on disk.
  const pair = freshIndices(MV);
  addFact(pair, "mem_f5_0", "sigmaglyph", 50);
  saveIndices(MV, pair);
  _resetCaches();

  // Count cold loads via the after-verify hook (fires on a cold manifest-gated
  // load, never on a warm cache hit).
  let coldLoads = 0;
  _setAfterVerifyHook(() => {
    coldLoads += 1;
  });

  const cold = loadIndices(MV); // cold: hook fires
  assert.equal(coldLoads, 1, "first load is cold (hook fired)");
  assert.ok(_indexCacheHas(MV), "model cached after the cold load");
  const warm = loadIndices(MV); // warm: hook does NOT fire
  assert.equal(coldLoads, 1, "second load is a warm hit (no cold verify)");
  assert.equal(warm.bm25, cold.bm25, "warm hit returns the same cached bm25 object");

  // Schedule a debounced save so there is a pending-save TIMER to cancel.
  const entry = bm25EntryFor("mem_f5_1", "tauglyph");
  const vector = unitVec(51);
  cold.bm25.add(entry);
  cold.hnsw.add("mem_f5_1", vector);
  const sched = scheduleSaveIndices(
    MV,
    { bm25: cold.bm25, hnsw: cold.hnsw },
    { factId: "mem_f5_1", bm25Entry: entry, vector },
  );
  assert.equal(sched.flushed, false, "batch=1000: the scheduled add is pending, not flushed");

  // Snapshot on-disk identities to prove eviction touches nothing.
  const dirFp = () =>
    readdirSync(dir)
      .sort()
      .map((f) => {
        const s = statSync(join(dir, f));
        return `${f}:${s.size}:${s.mtimeMs}`;
      })
      .join("|");
  const before = dirFp();

  const res = evictModelIndices(MV);
  assert.deepEqual(res, { evicted: true, hadPending: true }, "cached entry + pending save evicted");
  assert.equal(_indexCacheHas(MV), false, "cache no longer holds the model");
  assert.equal(dirFp(), before, "eviction touched no on-disk bytes");

  // Next load is COLD again (hook fires): proves the in-memory refs were
  // dropped; and the un-flushed WAL add replays (no durable data lost).
  const reloaded = loadIndices(MV);
  assert.equal(coldLoads, 2, "post-evict load is cold again (refs were dropped)");
  assert.ok(reloaded.hnsw.has("mem_f5_1"), "un-flushed WAL add replays on the cold reload (no data loss)");
  assert.ok(reloaded.hnsw.has("mem_f5_0"), "base generation still served");

  _setAfterVerifyHook(null);

  // No-op safety on a cold model.
  assert.deepEqual(
    evictModelIndices("f5-never-loaded-model"),
    { evicted: false, hadPending: false },
    "no-op on a cold model",
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
