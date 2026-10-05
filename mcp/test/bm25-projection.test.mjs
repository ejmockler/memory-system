// bm25-projection.test.mjs — B2 model-neutral BM25 selection.
// Hermetic: MEMORY_ROOT is fixed before dynamic imports; no production path is
// read or written.  The fixture publisher writes only side-by-side generations.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-bm25-projection-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
delete process.env.MEMORY_BM25_MODEL_NEUTRAL;

for (const dir of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  join(MEMORY_ROOT, "indices"),
]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort fixture cleanup
  }
});

const {
  BM25_MODEL_NEUTRAL_FLAG,
  Bm25ProjectionError,
  activateBm25Projection,
  isModelNeutralBm25Enabled,
  resolveBm25Member,
  resolveBm25Path,
} = await import("../lib/recall/bm25-projection.js");
const { Bm25Index } = await import("../lib/recall/bm25-index.js");
const { writeBm25IndexV2Atomic } = await import("../lib/recall/bm25-rebuild.js");
const {
  activateManifest,
  buildManifest,
  checksumMemberFile,
  readActiveManifest,
} = await import("../lib/recall/index-manifest.js");
const { loadBm25IndexFromV2File } = await import(
  "../lib/recall/bm25-streaming-loader.js"
);

const SOURCE_MODEL = "gemini-embedding-001";
const ACTIVE_MODEL = "qwen3-embedding-8b-fp16";
const LEDGER = join(process.env.LEDGERS_BASE_DIR, "memory.jsonl");

function modelDir(model) {
  return join(MEMORY_ROOT, "indices", model);
}

function makeSource(model, rows) {
  const dir = modelDir(model);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bm25 = new Bm25Index();
  for (const row of rows) {
    bm25.add({
      memory_id: row.id,
      content: row.content,
      kind: "fact",
      ts: "2026-08-06T00:00:00Z",
      entities: [],
    });
  }
  writeFileSync(LEDGER, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  writeBm25IndexV2Atomic(join(dir, "bm25.json"), bm25);
  const members = {
    bm25: checksumMemberFile(dir, "bm25.json"),
    hnsw: null,
    hnsw_meta: null,
  };
  const manifest = buildManifest({
    generation: 7,
    embedding_model_version: model,
    wal_cursor: { applied_seq: rows.length, applied_offset: statSync(LEDGER).size },
    members,
  });
  activateManifest(dir, manifest);
  return { dir, manifest, bm25Path: join(dir, "bm25.json") };
}

await test("flag is exact and default-off", () => {
  assert.equal(isModelNeutralBm25Enabled({}), false);
  assert.equal(isModelNeutralBm25Enabled({ [BM25_MODEL_NEUTRAL_FLAG]: "true" }), false);
  assert.equal(isModelNeutralBm25Enabled({ [BM25_MODEL_NEUTRAL_FLAG]: "1" }), true);

  const resolved = resolveBm25Member(ACTIVE_MODEL, { memoryRoot: MEMORY_ROOT });
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.model_neutral, false);
  assert.equal(resolved.bm25Path, join(modelDir(ACTIVE_MODEL), "bm25.json"));
});

await test("flag-on refuses a missing neutral manifest instead of falling back", () => {
  assert.throws(
    () => resolveBm25Path(ACTIVE_MODEL, { memoryRoot: MEMORY_ROOT, enabled: true }),
    (error) =>
      error instanceof Bm25ProjectionError &&
      error.code === "bm25_projection_unavailable",
  );
});

await test("coverage-proven source is copied and activated under the neutral key", () => {
  const rows = [
    { id: "mem_1", content: "apricot lexical memory" },
    { id: "mem_2", content: "blueberry lexical memory" },
    { id: "mem_3", content: "clementine lexical memory" },
  ];
  const source = makeSource(SOURCE_MODEL, rows);
  const sourceBefore = {
    size: statSync(source.bm25Path).size,
    bytes: readFileSync(source.bm25Path),
  };

  const published = activateBm25Projection({
    memoryRoot: MEMORY_ROOT,
    sourceModelVersion: SOURCE_MODEL,
    ledgerPath: LEDGER,
    minCoveragePct: 99,
  });

  // B1's probe is the proof: no hand-counted substitute in the projection.
  assert.equal(published.coverage.indexed_docs, 3);
  assert.equal(published.coverage.eligible_rows, 3);
  assert.equal(published.coverage.coverage_pct, 100);
  assert.equal(published.coverage.index_integrity, "manifest-verified");

  const active = readActiveManifest(published.lexicalDir);
  assert.equal(active.error, null);
  assert.equal(active.manifest.embedding_model_version, null);
  assert.equal(active.manifest.members.hnsw, null);
  assert.equal(active.manifest.members.hnsw_meta, null);
  assert.equal(active.manifest.members.bm25.file, "bm25.gen-0.json");

  const selected = resolveBm25Member(ACTIVE_MODEL, {
    memoryRoot: MEMORY_ROOT,
    enabled: true,
  });
  assert.equal(selected.model_neutral, true);
  assert.equal(selected.bm25Path, published.bm25Path);
  assert.equal(loadBm25IndexFromV2File(selected.bm25Path).size(), 3);

  // Side-by-side publication did not replace or rewrite the source member.
  assert.equal(statSync(source.bm25Path).size, sourceBefore.size);
  assert.deepEqual(readFileSync(source.bm25Path), sourceBefore.bytes);
  assert.notEqual(selected.bm25Path, source.bm25Path);
});

await test("flag-off remains on the dense-model path after neutral activation", () => {
  const selected = resolveBm25Member(ACTIVE_MODEL, {
    memoryRoot: MEMORY_ROOT,
    enabled: false,
  });
  assert.equal(selected.bm25Path, join(modelDir(ACTIVE_MODEL), "bm25.json"));
  assert.equal(selected.manifest, null);
});

await test("flag-on fails closed when the active neutral member no longer matches", () => {
  const lexical = resolveBm25Member(ACTIVE_MODEL, {
    memoryRoot: MEMORY_ROOT,
    enabled: true,
  });
  appendFileSync(lexical.bm25Path, "torn\n");
  assert.throws(
    () => resolveBm25Path(ACTIVE_MODEL, { memoryRoot: MEMORY_ROOT, enabled: true }),
    (error) =>
      error instanceof Bm25ProjectionError &&
      error.code === "index_manifest_member_mismatch",
  );
});

await test("an unverified source never activates a neutral manifest", () => {
  const model = "source-with-bad-checksum";
  const source = makeSource(model, [
    { id: "mem_bad", content: "source is changed after manifest publication" },
  ]);
  appendFileSync(source.bm25Path, "torn\n");

  const isolatedRoot = join(TMP_ROOT, "unverified-root");
  mkdirSync(join(isolatedRoot, "indices", model), { recursive: true, mode: 0o700 });
  // Use the already-corrupt fixture through its own root by copying its small
  // source tree.  This keeps the assertion independent of the prior neutral
  // generation used by the other cases.
  const targetDir = join(isolatedRoot, "indices", model);
  writeFileSync(join(targetDir, "bm25.json"), readFileSync(source.bm25Path));
  writeFileSync(
    join(targetDir, "index-manifest.json"),
    readFileSync(join(source.dir, "index-manifest.json")),
  );
  const isolatedLedger = join(isolatedRoot, "memory.jsonl");
  writeFileSync(isolatedLedger, JSON.stringify({ id: "mem_bad", content: "source is changed after manifest publication" }) + "\n");

  assert.throws(
    () =>
      activateBm25Projection({
        memoryRoot: isolatedRoot,
        sourceModelVersion: model,
        ledgerPath: isolatedLedger,
        minCoveragePct: 0,
      }),
    (error) =>
      error instanceof Bm25ProjectionError &&
      error.code === "bm25_projection_source_unverified",
  );
  assert.equal(readActiveManifest(join(isolatedRoot, "indices", "_lexical")).manifest, null);
});
