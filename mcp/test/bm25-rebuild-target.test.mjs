// B4 — periodic rebuild target selection and writer hygiene.
// Hermetic: every ledger, state file, and index generation is under TMP_ROOT.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-bm25-rebuild-target-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
delete process.env.MEMORY_BM25_MODEL_NEUTRAL;
delete process.env.MEMORY_BM25_REBUILD_TARGET_ACTIVE;
// l11 — the legacy target became an explicit opt-in; clear it like its sibling.
delete process.env.MEMORY_BM25_REBUILD_TARGET_LEGACY;
delete process.env.MEMORY_BM25_REBUILD_OBJECT_ENTITIES;

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
  BM25_REBUILD_OBJECT_ENTITIES_FLAG,
  BM25_REBUILD_TARGET_ACTIVE_FLAG,
  BM25_REBUILD_TARGET_LEGACY_FLAG,
  _defaultRebuildModelVersion,
  maybeRunBm25Rebuild,
  readRebuildState,
  rebuildBm25IndexFromLedger,
  writeBm25IndexV2Atomic,
} = await import("../lib/recall/bm25-rebuild.js");
const {
  BM25_MODEL_NEUTRAL_FLAG,
  LEXICAL_INDEX_KEY,
} = await import("../lib/recall/bm25-projection.js");
const { Bm25Index } = await import("../lib/recall/bm25-index.js");
const { loadBm25IndexFromV2File } = await import(
  "../lib/recall/bm25-streaming-loader.js"
);
const { readActiveManifest } = await import("../lib/recall/index-manifest.js");
const { CAPS } = await import("../lib/validation.js");

const LEGACY_MODEL = CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT;
const ACTIVE_MODEL = CAPS.ACTIVE_EMBED_MODEL_VERSION;
const LEXICAL_DIR = join(MEMORY_ROOT, "indices", LEXICAL_INDEX_KEY);

function writeLedger(name, rows) {
  const path = join(process.env.LEDGERS_BASE_DIR, `${name}.jsonl`);
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return path;
}

function removeIfPresent(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function clearRebuildSchedulerState() {
  removeIfPresent(join(process.env.STORAGE_BASE_DIR, "bm25-rebuild-state.json"));
  removeIfPresent(join(process.env.STORAGE_BASE_DIR, "bm25-growth-check.json"));
}

function clearFlags() {
  delete process.env[BM25_MODEL_NEUTRAL_FLAG];
  delete process.env[BM25_REBUILD_TARGET_ACTIVE_FLAG];
  // l11 — without this the new legacy opt-in leaks across tests in this file.
  delete process.env[BM25_REBUILD_TARGET_LEGACY_FLAG];
  delete process.env[BM25_REBUILD_OBJECT_ENTITIES_FLAG];
}

// This is intentionally not a call back through rebuildBm25IndexFromLedger.
// It re-implements the pre-B4 row projection and writes with the shared stable
// v2 encoder, so an entity-shape change in the production callback diverges.
function writeLegacyOracle(path, rows) {
  const index = new Bm25Index();
  for (const row of rows) {
    if (row == null || typeof row !== "object") continue;
    if (typeof row.id !== "string" || row.id.length === 0) continue;
    if (typeof row.content !== "string" || row.content.length === 0) continue;
    const features =
      row.features && typeof row.features === "object" ? row.features : {};
    const raw = Array.isArray(features.entities) ? features.entities : [];
    const entities = raw.filter(
      (entity) => typeof entity === "string" && entity.length > 0,
    );
    index.add({
      memory_id: row.id,
      kind: typeof row.kind === "string" ? row.kind : "fact",
      content: row.content,
      ts: typeof row.created_at === "string" ? row.created_at : "",
      entities,
    });
  }
  writeBm25IndexV2Atomic(path, index);
}

function parityRows(count) {
  let state = 0x6d2b79f5;
  const next = () => {
    state = (Math.imul(state ^ (state >>> 15), 1 | state) + 0x9e3779b9) >>> 0;
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return (state ^ (state >>> 14)) >>> 0;
  };
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const n = next();
    const entities = [
      {
        kind: "PERSON",
        canonical_id: `person:fuzz:${n.toString(16)}`,
        surface: `Person ${n % 97}`,
      },
    ];
    if (i % 5 === 0) entities.push(`legacy:string:${n % 211}`);
    if (i % 17 === 0) entities.push("   ");
    if (i % 29 === 0) entities.push({ canonical_id: "" });
    rows.push({
      id: `mem_parity_${i.toString().padStart(5, "0")}`,
      kind: i % 13 === 0 ? undefined : "fact",
      content: `token_${n % 997} cohort_${i % 41} stable legacy payload`,
      created_at: i % 19 === 0 ? null : `2026-08-06T00:${String(i % 60).padStart(2, "0")}:00.000Z`,
      features: { entities },
    });
  }
  return rows;
}

// l11 DELIBERATELY FLIPPED THE DEFAULT. This test used to pin the flags-cleared
// resolution to LEGACY_MODEL; it is now ACTIVE_MODEL, because the watermark
// daemon's argument-less maybeRunBm25Rebuild() was re-creating the legacy tree
// through publishGeneration's unconditional mkdir. The legacy target survives
// as the explicit BM25_REBUILD_TARGET_LEGACY_FLAG opt-in, pinned below. The
// exactness ("true" is not "1") and call-time discipline are unchanged.
await test("default target flags are exact, call-time, and explicit about precedence", () => {
  clearFlags();
  assert.equal(_defaultRebuildModelVersion(), ACTIVE_MODEL);

  process.env[BM25_REBUILD_TARGET_ACTIVE_FLAG] = "true";
  assert.equal(_defaultRebuildModelVersion(), ACTIVE_MODEL);
  process.env[BM25_REBUILD_TARGET_ACTIVE_FLAG] = "1";
  assert.equal(_defaultRebuildModelVersion(), ACTIVE_MODEL);

  // l11 — the legacy escape hatch: exact "1", and it outranks the ACTIVE alias.
  process.env[BM25_REBUILD_TARGET_LEGACY_FLAG] = "true";
  assert.equal(_defaultRebuildModelVersion(), ACTIVE_MODEL);
  process.env[BM25_REBUILD_TARGET_LEGACY_FLAG] = "1";
  assert.equal(_defaultRebuildModelVersion(), LEGACY_MODEL);
  delete process.env[BM25_REBUILD_TARGET_LEGACY_FLAG];
  assert.equal(_defaultRebuildModelVersion(), ACTIVE_MODEL);

  process.env[BM25_MODEL_NEUTRAL_FLAG] = "1";
  assert.equal(
    _defaultRebuildModelVersion(),
    ACTIVE_MODEL,
    "the dedicated ACTIVE target wins when both opt-ins are present",
  );
  delete process.env[BM25_REBUILD_TARGET_ACTIVE_FLAG];
  assert.equal(_defaultRebuildModelVersion(), LEXICAL_INDEX_KEY);
  clearFlags();
});

// SERIALIZER REGRESSION PIN — the property under test is BYTES, not target
// resolution. l11 deliberately flipped the argument-less default off
// LEGACY_MODEL, so the legacy model is now passed EXPLICITLY here: that keeps
// the oracle comparison running against the same tree it always did while the
// default moves out from under it. Nothing about the serialized output changed.
await test("legacy-target bytes match an independent legacy oracle over 28,000 seeded rows", () => {
  clearFlags();
  const rows = parityRows(28_000);
  const ledgerPath = writeLedger("flag-off-parity", rows);
  const oraclePath = join(TMP_ROOT, "legacy-oracle.bm25.json");
  writeLegacyOracle(oraclePath, rows);

  const actual = rebuildBm25IndexFromLedger({
    ledgerPath,
    modelVersion: LEGACY_MODEL,
    contextualPrefix: false,
  });
  assert.equal(actual.model_version, LEGACY_MODEL);
  assert.deepEqual(readFileSync(actual.bm25_path), readFileSync(oraclePath));
  assert.equal(existsSync(LEXICAL_DIR), false);

  const index = loadBm25IndexFromV2File(actual.bm25_path);
  assert.deepEqual(index.searchEntities(["person:fuzz:1"]), []);
});

await test("ACTIVE target flag drives the periodic production writer and state", () => {
  clearFlags();
  clearRebuildSchedulerState();
  const ledgerPath = writeLedger("periodic-active", [
    { id: "mem_active_1", kind: "fact", content: "one active memory" },
    { id: "mem_active_2", kind: "fact", content: "two active memories" },
  ]);

  process.env[BM25_REBUILD_TARGET_ACTIVE_FLAG] = "1";
  const run = maybeRunBm25Rebuild({ ledgerPath, threshold: 1 });
  assert.equal(run.action, "rebuilt");
  assert.equal(run.result.model_version, ACTIVE_MODEL);
  assert.equal(run.result.rows_indexed, 2);
  assert.equal(
    run.result.bm25_path,
    join(MEMORY_ROOT, "indices", ACTIVE_MODEL, "bm25.json"),
  );
  assert.equal(loadBm25IndexFromV2File(run.result.bm25_path).size(), 2);
  assert.equal(readRebuildState().last_rebuild_model_version, ACTIVE_MODEL);
  clearFlags();
});

await test("neutral dry-run reports no fictional loose bm25.json", () => {
  clearFlags();
  const ledgerPath = writeLedger("neutral-dry-run", [
    { id: "mem_dry", kind: "fact", content: "dry neutral projection" },
  ]);
  process.env[BM25_MODEL_NEUTRAL_FLAG] = "1";
  const result = rebuildBm25IndexFromLedger({
    ledgerPath,
    dryRun: true,
    contextualPrefix: false,
  });
  assert.equal(result.model_version, LEXICAL_INDEX_KEY);
  assert.equal(result.bm25_path, null);
  assert.equal(result.wrote_index, false);
  assert.equal(existsSync(join(LEXICAL_DIR, "bm25.json")), false);
  clearFlags();
});

await test("neutral periodic publications GC generations older than fallback", () => {
  clearFlags();
  const ledgerPath = writeLedger("periodic-neutral", [
    { id: "mem_neutral_1", kind: "fact", content: "one projected memory" },
    { id: "mem_neutral_2", kind: "fact", content: "two projected memories" },
    { id: "mem_neutral_3", kind: "fact", content: "three projected memories" },
  ]);
  process.env[BM25_MODEL_NEUTRAL_FLAG] = "1";

  for (let i = 0; i < 3; i += 1) {
    const result = rebuildBm25IndexFromLedger({
      ledgerPath,
      contextualPrefix: false,
    });
    assert.equal(result.model_version, LEXICAL_INDEX_KEY);
    assert.equal(loadBm25IndexFromV2File(result.bm25_path).size(), 3);
  }

  const active = readActiveManifest(LEXICAL_DIR);
  assert.equal(active.error, null);
  assert.equal(active.manifest.embedding_model_version, null);
  assert.equal(active.manifest.members.hnsw, null);
  assert.equal(active.manifest.members.hnsw_meta, null);
  assert.equal(active.manifest.generation, 2);
  assert.equal(active.manifest.previous.generation, 1);
  assert.deepEqual(
    readdirSync(LEXICAL_DIR)
      .filter((name) => /^bm25\.gen-\d+\.json$/.test(name))
      .sort(),
    ["bm25.gen-1.json", "bm25.gen-2.json"],
  );
  clearFlags();
});

await test("explicit modelVersion wins over both default-target flags", () => {
  clearFlags();
  const explicitModel = `${ACTIVE_MODEL}-b4-explicit`;
  const ledgerPath = writeLedger("explicit-wins", [
    { id: "mem_explicit", kind: "fact", content: "explicit tree only" },
  ]);
  const neutralManifestBefore = readFileSync(join(LEXICAL_DIR, "index-manifest.json"));

  process.env[BM25_MODEL_NEUTRAL_FLAG] = "1";
  process.env[BM25_REBUILD_TARGET_ACTIVE_FLAG] = "1";
  const result = rebuildBm25IndexFromLedger({
    ledgerPath,
    modelVersion: explicitModel,
    contextualPrefix: false,
  });
  assert.equal(result.model_version, explicitModel);
  assert.equal(
    result.bm25_path,
    join(MEMORY_ROOT, "indices", explicitModel, "bm25.json"),
  );
  assert.equal(loadBm25IndexFromV2File(result.bm25_path).size(), 1);
  assert.deepEqual(
    readFileSync(join(LEXICAL_DIR, "index-manifest.json")),
    neutralManifestBefore,
  );
  clearFlags();
});

await test("object entity projection has its own default-off exact flag", () => {
  clearFlags();
  const canonicalId = "person:telegram:Alex";
  const ledgerPath = writeLedger("entity-shape", [
    {
      id: "mem_entity_object",
      kind: "fact",
      content: "Alex owns the entity pin",
      features: {
        entities: [
          { kind: "PERSON", canonical_id: canonicalId, surface: "Alex" },
          "person:legacy:ALICE",
        ],
      },
    },
  ]);

  const legacy = rebuildBm25IndexFromLedger({
    ledgerPath,
    modelVersion: "entity-default-off",
    contextualPrefix: false,
  });
  const legacyIndex = loadBm25IndexFromV2File(legacy.bm25_path);
  assert.deepEqual(legacyIndex.searchEntities([canonicalId]), []);
  assert.equal(legacyIndex.searchEntities(["person:legacy:alice"]).length, 1);

  process.env[BM25_REBUILD_OBJECT_ENTITIES_FLAG] = "true";
  const stillOff = rebuildBm25IndexFromLedger({
    ledgerPath,
    modelVersion: "entity-nonexact-off",
    contextualPrefix: false,
  });
  assert.deepEqual(
    loadBm25IndexFromV2File(stillOff.bm25_path).searchEntities([canonicalId]),
    [],
  );

  process.env[BM25_REBUILD_OBJECT_ENTITIES_FLAG] = "1";
  const enabled = rebuildBm25IndexFromLedger({
    ledgerPath,
    modelVersion: "entity-enabled",
    contextualPrefix: false,
  });
  assert.deepEqual(
    loadBm25IndexFromV2File(enabled.bm25_path).searchEntities([canonicalId]),
    [{ memory_id: "mem_entity_object", count: 1, rank: 0 }],
  );
  clearFlags();
});
