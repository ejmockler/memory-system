// bm25-rebuild.test.mjs — WU-RR1-bm25-rebuild.
//
// Hermetic test for the BM25 full-rebuild module:
//   - lib/recall/bm25-rebuild.js (rebuildBm25IndexFromLedger,
//     countFactRowsStreamed, maybeRunBm25Rebuild, readRebuildState)
//   - scripts/rebuild-bm25-index.mjs (one-shot CLI wrapper)
//
// Discipline (matches sibling test/*.test.mjs):
//   - mkdtempSync rooted in tmpdir; overwrite MEMORY_ROOT + POLICY_BASE_DIR
//     + STORAGE_BASE_DIR + LEDGERS_BASE_DIR BEFORE any dynamic import of
//     memory-system modules. Production trees must not be touched.
//   - node:test + node:assert/strict — but the existing recall-layer test
//     (bm25-index.test.mjs) uses an ad-hoc test() helper; we use the
//     SAME shape for consistency, while satisfying the 12+ assertions
//     gate via node:assert/strict.
//   - try { rmSync(tmp) } in a process.on("exit") to ensure cleanup even
//     if a test mid-stream throws.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Hermeticity: stake tmp dirs + overwrite env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-bm25-rebuild-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");

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
const {
  rebuildBm25IndexFromLedger,
  countFactRowsStreamed,
  maybeRunBm25Rebuild,
  readRebuildState,
} = await import("../lib/recall/bm25-rebuild.js");
const { Bm25Index } = await import("../lib/recall/bm25-index.js");
const { CAPS } = await import("../lib/validation.js");
const { isV2File, loadBm25IndexFromV2File } = await import(
  "../lib/recall/bm25-streaming-loader.js"
);
// S2y writer regression pins — the rebuild must publish through the S3
// generation-manifest seam (publishGeneration) and respect the S2 flush
// lease; these imports let the pins observe the manifest + cold-load result.
const { loadIndices, saveIndices, _resetCaches } = await import(
  "../lib/recall/index-cache.js"
);
const { readActiveManifest } = await import("../lib/recall/index-manifest.js");
const { WAL_LEASE_FILE } = await import("../lib/recall/index-wal.js");
const { HnswIndex } = await import("../lib/recall/hnsw-index.js");

// ---------------------------------------------------------------------------
// Test framework: ad-hoc test() matching bm25-index.test.mjs.
// ---------------------------------------------------------------------------
let failures = 0;
let passes = 0;

function pass(label) {
  passes++;
  console.log(`  pass: ${label}`);
}
function fail(label, err) {
  failures++;
  console.log(`  FAIL: ${label}`);
  if (err) {
    console.log(`        ${err && err.stack ? err.stack : err}`);
  }
}
async function test(label, fn) {
  console.log(`test: ${label}`);
  try {
    await fn();
  } catch (err) {
    fail(label, err);
  }
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
// l11 DELIBERATELY FLIPPED THE ARGUMENT-LESS REBUILD TARGET off the legacy
// Gemini tree and onto the ACTIVE embedding model, so this registered
// baseline moves with it. Every other test in this file passes
// `modelVersion: MODEL_VERSION` explicitly and is target-agnostic — it simply
// builds into whichever hermetic tree this constant names. Only the two CLI
// spawns below actually consume the library default; re-pointing the constant
// makes them assert the NEW default instead of passing vacuously.
const MODEL_VERSION = CAPS.ACTIVE_EMBED_MODEL_VERSION;
const LEDGER_PATH = join(MEMORY_ROOT, "ledgers", "memory.jsonl");
const BM25_PATH = join(MEMORY_ROOT, "indices", MODEL_VERSION, "bm25.json");
const STATE_PATH = join(MEMORY_ROOT, "storage", "bm25-rebuild-state.json");

function makeFactRow(id, content, opts = {}) {
  return {
    id,
    kind: "fact",
    content,
    source: opts.source || "test",
    source_refs: [],
    derived_from: [],
    provenance: {},
    features: {
      entities: Array.isArray(opts.entities) ? opts.entities : [],
      embedding_model_version: MODEL_VERSION,
    },
    created_at: opts.ts || "2026-06-01T00:00:00Z",
    checksum: "deadbeef",
  };
}

function writeLedger(rows, extraLines = []) {
  const lines = rows.map((r) => JSON.stringify(r));
  for (const e of extraLines) lines.push(e);
  writeFileSync(LEDGER_PATH, lines.join("\n") + "\n", "utf8");
}

function resetWorld() {
  // Clear any prior state between tests so they remain order-independent.
  try {
    rmSync(LEDGER_PATH, { force: true });
  } catch {
    // ignore
  }
  try {
    rmSync(BM25_PATH, { force: true });
  } catch {
    // ignore
  }
  try {
    rmSync(STATE_PATH, { force: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Test 1: rebuild produces a non-empty index file with the expected shape
// (term → posting list), and Bm25Index.deserialize accepts it.
// ---------------------------------------------------------------------------
await test("rebuild produces non-empty bm25.json with expected shape", () => {
  resetWorld();
  const rows = [];
  for (let i = 0; i < 50; i++) {
    rows.push(
      makeFactRow(
        `mem_${i.toString().padStart(3, "0")}`,
        `the alpha quick brown fox jumps over the lazy dog token_${i}`,
        { entities: i % 5 === 0 ? ["Alex", "Fernwick"] : ["Alex"] },
      ),
    );
  }
  writeLedger(rows);

  const res = rebuildBm25IndexFromLedger({ modelVersion: MODEL_VERSION });

  assert.equal(res.wrote_index, true, "wrote_index true on success");
  assert.equal(res.rows_total, 50, "rows_total = 50");
  assert.equal(res.rows_indexed, 50, "rows_indexed = 50");
  assert.equal(res.rows_skipped, 0, "rows_skipped = 0");
  assert.ok(res.bytes_written > 0, "bytes_written > 0");
  assert.equal(res.model_version, MODEL_VERSION, "model_version echoed");
  assert.equal(res.bm25_path, BM25_PATH, "bm25_path uses MEMORY_ROOT override");

  // File on disk is the v2 line-delimited format. First line is the header
  // {"version":2,"params":{...},"total_doc_len":N}; subsequent lines are
  // ["P"|"L"|"M"|"E"|"D", ...] entries.
  assert.ok(existsSync(BM25_PATH), "bm25.json exists after rebuild");
  assert.equal(isV2File(BM25_PATH), true, "file detected as v2 format");
  const raw = readFileSync(BM25_PATH, "utf8");
  assert.ok(raw.length > 100, "bm25.json non-trivial size");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  assert.ok(lines.length > 1, "v2 has many lines, not one blob");

  const header = JSON.parse(lines[0]);
  assert.equal(header.version, 2, "header version == 2");
  assert.ok(header.params, "header has params");
  assert.equal(typeof header.params.k1, "number", "k1 is number");
  assert.equal(typeof header.params.b, "number", "b is number");
  assert.equal(typeof header.total_doc_len, "number", "total_doc_len present");

  // Spot-check at least one P (posting) entry shape.
  const pLines = lines.slice(1).filter((l) => l.startsWith('["P"'));
  assert.ok(pLines.length > 0, "at least one posting entry on disk");
  const p0 = JSON.parse(pLines[0]);
  assert.equal(p0[0], "P", "tag is P");
  assert.equal(typeof p0[1], "string", "token is string");
  assert.ok(Array.isArray(p0[2]), "posting list is array");

  // doc_len entries — one per indexed row.
  const lLines = lines.slice(1).filter((l) => l.startsWith('["L"'));
  assert.equal(lLines.length, 50, "doc_len entries == rows_indexed");
  pass("rebuild shape OK (v2)");
});

// ---------------------------------------------------------------------------
// Test 1b: the rebuild indexes OBJECT-shaped entities.
//
// The cascade stamps features.entities as OBJECTS —
// {kind, canonical_id, surface} — but this rebuild accepted only
// `typeof e === "string"`, so every entity was silently dropped and a rebuilt
// index carried 0 entity terms. searchEntities() then returns [] against it,
// starving entity_overlap_jaccard and the Layer-1c entity fallback. Measured
// on the real tree: the rebuilt gemini index had 0 entity terms while the
// incrementally-maintained qwen3 index had 10,071.
//
// It went unnoticed because every fixture in this file passes plain strings
// (["Alex", "Fernwick"]) — a shape production never writes. This test pins
// the production shape; the legacy string form is asserted alongside it since
// index-cache.js still accepts both.
//
// Guards a landmine: repointing the rebuild at the ACTIVE model — the obvious
// fix for its coverage gap — would otherwise wipe the working entity index on
// the first run.
// ---------------------------------------------------------------------------
await test("rebuild indexes object-shaped entities, not just strings", () => {
  resetWorld();
  writeLedger([
    makeFactRow("mem_obj", "shanghai logistics planning", {
      entities: [
        { kind: "person", canonical_id: "person:telegram:Alex", surface: "Alex" },
        { kind: "project", canonical_id: "project:git-log:Fernwick" },
      ],
    }),
    makeFactRow("mem_legacy", "legacy string entity row", {
      entities: ["person:manual:alice"],
    }),
    makeFactRow("mem_none", "row with no entities at all"),
  ]);

  let res;
  process.env.MEMORY_BM25_REBUILD_OBJECT_ENTITIES = "1";
  try {
    res = rebuildBm25IndexFromLedger({ modelVersion: MODEL_VERSION });
  } finally {
    delete process.env.MEMORY_BM25_REBUILD_OBJECT_ENTITIES;
  }
  assert.equal(res.wrote_index, true, "wrote_index true");
  assert.equal(res.rows_indexed, 3, "all three rows indexed");

  const lines = readFileSync(BM25_PATH, "utf8").split("\n").filter((l) => l.length > 0);
  const eLines = lines.filter((l) => l.startsWith('["E"'));
  assert.ok(
    eLines.length > 0,
    "entity terms present on disk (0 here is the silent-drop regression)",
  );

  const entityTerms = new Set(eLines.map((l) => JSON.parse(l)[1]));
  assert.ok(
    entityTerms.has("person:telegram:alex"),
    `object entity indexed lowercased; got ${JSON.stringify([...entityTerms])}`,
  );
  assert.ok(
    entityTerms.has("project:git-log:fernwick"),
    "second object entity indexed",
  );
  assert.ok(
    entityTerms.has("person:manual:alice"),
    "legacy string entity still indexed",
  );

  // Round-trip: the rebuilt index must actually resolve an entity lookup.
  const idx = loadBm25IndexFromV2File(BM25_PATH);
  const hits = idx.searchEntities(["person:telegram:alex"]);
  assert.ok(
    Array.isArray(hits) && hits.length > 0,
    "searchEntities resolves the object-shaped entity after rebuild",
  );

  pass("rebuild indexes object + legacy-string entities");
});

// ---------------------------------------------------------------------------
// Test 2: Recall against the fixture finds facts via BM25 round-trip
// (rebuild → deserialize → search).
// ---------------------------------------------------------------------------
await test("recall against rebuilt index finds the fact via BM25", () => {
  resetWorld();
  const rows = [
    makeFactRow("mem_alpha", "alpha bravo charlie"),
    makeFactRow("mem_bravo", "bravo delta echo"),
    makeFactRow(
      "mem_unique",
      "zelphwyn quetzalcoatl niflheim qwopzxc unobtanium",
    ),
  ];
  writeLedger(rows);

  const res = rebuildBm25IndexFromLedger({ modelVersion: MODEL_VERSION });
  assert.equal(res.rows_indexed, 3);

  // v2 round-trip via the streaming loader (loadIndices in index-cache.js
  // does exactly this in production after isV2File detection).
  const idx = loadBm25IndexFromV2File(BM25_PATH);
  assert.equal(idx.size(), 3, "index size matches");

  // Unique term hits exactly one doc and that doc is mem_unique.
  const uniq = idx.search("zelphwyn", 50);
  assert.equal(uniq.length, 1, "unique term hits 1 doc");
  assert.equal(uniq[0].memory_id, "mem_unique");

  // Shared term hits two docs.
  const shared = idx.search("bravo", 50);
  assert.equal(shared.length, 2, "shared term hits 2 docs");
  const ids = new Set(shared.map((r) => r.memory_id));
  assert.ok(ids.has("mem_alpha"));
  assert.ok(ids.has("mem_bravo"));
  pass("recall round-trip OK");
});

// ---------------------------------------------------------------------------
// Test 3: defensive — malformed ledger lines are skipped, partial good
// rows still indexed.
// ---------------------------------------------------------------------------
await test("malformed ledger lines are skipped", () => {
  resetWorld();
  const goodRows = [
    makeFactRow("mem_good_1", "alpha bravo"),
    makeFactRow("mem_good_2", "charlie delta"),
    makeFactRow("mem_good_3", "echo foxtrot"),
  ];
  // Mix in: a torn JSON line, a row missing id, a row missing content, a
  // row whose value is "null" (parses to null, not an object), and an
  // empty line. None should crash; rows_skipped should reflect them.
  const badLines = [
    "{not valid json",
    JSON.stringify({ kind: "fact", content: "no id" }),
    JSON.stringify({ id: "mem_no_content", kind: "fact" }),
    "null",
    "",
  ];
  writeLedger(goodRows, badLines);

  const res = rebuildBm25IndexFromLedger({ modelVersion: MODEL_VERSION });
  // streamLedgerLines drops the torn-JSON line and the empty line BEFORE
  // invoking our onRow, so they DO NOT appear in rows_total. The three
  // valid-JSON-but-shape-invalid rows hit onRow and get counted as
  // rows_skipped.
  assert.equal(res.rows_total, 3 + 3, "rows_total counts all parsed rows");
  assert.equal(res.rows_indexed, 3, "rows_indexed = 3 valid facts");
  assert.equal(res.rows_skipped, 3, "rows_skipped = 3 invalid-shape rows");
  assert.equal(res.wrote_index, true);
  pass("malformed lines handled defensively");
});

// ---------------------------------------------------------------------------
// Test 4: --dry-run does not write the index file but still reports the
// row counts.
// ---------------------------------------------------------------------------
await test("dryRun does not write the index file", () => {
  resetWorld();
  writeLedger([
    makeFactRow("mem_dry_1", "dry run one"),
    makeFactRow("mem_dry_2", "dry run two"),
  ]);
  assert.equal(existsSync(BM25_PATH), false, "no index before dry run");

  const res = rebuildBm25IndexFromLedger({
    modelVersion: MODEL_VERSION,
    dryRun: true,
  });
  assert.equal(res.wrote_index, false, "wrote_index false in dry run");
  assert.equal(res.bytes_written, 0, "bytes_written 0 in dry run");
  assert.equal(res.rows_indexed, 2, "still indexed in memory");
  assert.equal(
    existsSync(BM25_PATH),
    false,
    "index file NOT created in dry run",
  );
  pass("dry run does not touch disk");
});

// ---------------------------------------------------------------------------
// Test 5: atomic write — no .tmp file left behind after a successful
// rebuild; the resulting file is fully valid JSON.
// ---------------------------------------------------------------------------
await test("atomic write leaves no .tmp behind and writes valid JSON", () => {
  resetWorld();
  writeLedger([makeFactRow("mem_atomic", "atomic write test content")]);
  const res = rebuildBm25IndexFromLedger({ modelVersion: MODEL_VERSION });
  assert.equal(res.wrote_index, true);
  assert.equal(
    existsSync(BM25_PATH + ".tmp"),
    false,
    "no leftover .tmp after rename",
  );
  // File parses cleanly via the v2 loader; a torn write would either fail
  // isV2File (header missing) or throw inside the loader on the header.
  assert.equal(isV2File(BM25_PATH), true);
  const idx = loadBm25IndexFromV2File(BM25_PATH);
  assert.equal(idx.size(), 1, "atomic write produced loadable v2 file");
  pass("atomic write OK");
});

// ---------------------------------------------------------------------------
// Test 6: countFactRowsStreamed reports ledger size + fact count.
// ---------------------------------------------------------------------------
await test("countFactRowsStreamed reports correct fact_count", () => {
  resetWorld();
  const rows = [];
  for (let i = 0; i < 7; i++) {
    rows.push(makeFactRow(`mem_count_${i}`, `content ${i}`));
  }
  // Add a non-fact-shaped row that should NOT count.
  writeLedger(rows, [JSON.stringify({ kind: "policy", policy_kind: "ping" })]);

  const counts = countFactRowsStreamed(LEDGER_PATH);
  assert.equal(counts.fact_count, 7, "fact_count = 7 (non-fact row excluded)");
  assert.ok(counts.ledger_size > 0, "ledger_size > 0");
  assert.equal(counts.total_lines, 8, "total_lines includes the policy row");
  pass("countFactRowsStreamed OK");
});

// ---------------------------------------------------------------------------
// Test 7: maybeRunBm25Rebuild — first run (no state file) triggers rebuild
// and persists state.
// ---------------------------------------------------------------------------
await test("maybeRunBm25Rebuild first-run triggers rebuild + persists state", () => {
  resetWorld();
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push(makeFactRow(`mem_first_${i}`, `first run content ${i}`));
  }
  writeLedger(rows);

  assert.equal(readRebuildState(), null, "no state file before first run");
  const res = maybeRunBm25Rebuild({ modelVersion: MODEL_VERSION, threshold: 5 });
  assert.equal(res.action, "rebuilt", "first run rebuilds");
  assert.equal(res.delta, 10);
  assert.equal(res.current_fact_count, 10);
  assert.equal(res.last_rebuild_fact_count, null);
  assert.ok(res.result && res.result.wrote_index, "rebuild wrote index");

  // State file persisted.
  const state = readRebuildState();
  assert.ok(state != null, "state file persisted");
  assert.equal(state.last_rebuild_fact_count, 10);
  assert.equal(state.last_rebuild_model_version, MODEL_VERSION);
  assert.ok(typeof state.last_rebuild_ts === "string");
  assert.ok(state.last_rebuild_ledger_size > 0);
  pass("first run rebuild + state persisted");
});

// ---------------------------------------------------------------------------
// Test 8: maybeRunBm25Rebuild — second run with no growth is a cheap skip.
// ---------------------------------------------------------------------------
await test("maybeRunBm25Rebuild skip on no growth", () => {
  // Inherit the state from the previous test (same ledger, no changes).
  const sizeBefore = statSync(LEDGER_PATH).size;
  const res = maybeRunBm25Rebuild({ modelVersion: MODEL_VERSION, threshold: 5 });
  assert.equal(res.action, "skipped_no_growth", "no-growth path skipped");
  assert.equal(statSync(LEDGER_PATH).size, sizeBefore, "ledger unchanged");
  pass("no-growth skip OK");
});

// ---------------------------------------------------------------------------
// Test 9: maybeRunBm25Rebuild — growth below threshold skips; above
// threshold rebuilds and updates state.
// ---------------------------------------------------------------------------
await test("maybeRunBm25Rebuild threshold gating", () => {
  // Append 3 rows (below threshold=5).
  const more1 = [];
  for (let i = 10; i < 13; i++) {
    more1.push(JSON.stringify(makeFactRow(`mem_first_${i}`, `c ${i}`)));
  }
  const existing = readFileSync(LEDGER_PATH, "utf8");
  writeFileSync(LEDGER_PATH, existing + more1.join("\n") + "\n", "utf8");

  const stateBefore = readRebuildState();
  const res1 = maybeRunBm25Rebuild({
    modelVersion: MODEL_VERSION,
    threshold: 5,
  });
  assert.equal(res1.action, "skipped_below_threshold", "below threshold skips");
  assert.equal(res1.delta, 3);
  // State unchanged on a skip.
  const stateAfterSkip = readRebuildState();
  assert.equal(
    stateAfterSkip.last_rebuild_fact_count,
    stateBefore.last_rebuild_fact_count,
    "state untouched on threshold skip",
  );

  // Append 5 more (total delta = 8, above threshold=5).
  const more2 = [];
  for (let i = 13; i < 18; i++) {
    more2.push(JSON.stringify(makeFactRow(`mem_first_${i}`, `c ${i}`)));
  }
  const existing2 = readFileSync(LEDGER_PATH, "utf8");
  writeFileSync(LEDGER_PATH, existing2 + more2.join("\n") + "\n", "utf8");

  const res2 = maybeRunBm25Rebuild({
    modelVersion: MODEL_VERSION,
    threshold: 5,
  });
  assert.equal(res2.action, "rebuilt", "above threshold rebuilds");
  assert.equal(res2.delta, 8);
  assert.equal(res2.current_fact_count, 18);

  // State now reflects the new count.
  const stateAfter = readRebuildState();
  assert.equal(stateAfter.last_rebuild_fact_count, 18);
  pass("threshold gating OK");
});

// ---------------------------------------------------------------------------
// Test 10: CAPS kill-switch: threshold <= 0 disables the auto-trigger.
// ---------------------------------------------------------------------------
await test("maybeRunBm25Rebuild disabled when threshold <= 0", () => {
  const res = maybeRunBm25Rebuild({ modelVersion: MODEL_VERSION, threshold: 0 });
  assert.equal(res.action, "disabled", "threshold=0 returns disabled");
  assert.equal(res.delta, 0);
  pass("disabled gate OK");
});

// ---------------------------------------------------------------------------
// Test 11: One-shot CLI script — produces a JSON envelope on stdout +
// exits 0 + writes the index file.
// ---------------------------------------------------------------------------
await test("rebuild-bm25-index.mjs CLI script runs end-to-end", () => {
  resetWorld();
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push(
      makeFactRow(`mem_cli_${i}`, `cli script content gamma_${i} shared`),
    );
  }
  writeLedger(rows);

  // Resolve the script path relative to this test file.
  const here = fileURLToPath(import.meta.url);
  const scriptPath = join(
    here,
    "..",
    "..",
    "scripts",
    "rebuild-bm25-index.mjs",
  );

  // l11 — with the argument-less default now on the ACTIVE model, the script's
  // PRE-EXISTING live-tree write guard refuses an uncontained non-dry-run
  // publish. --memory-root pins the OUTPUT at this suite's hermetic root (the
  // same directory MEMORY_ROOT already names), which is what the guard asks
  // for. The default MODEL RESOLUTION is still exercised: no --target and no
  // --model-version are passed, so model_version below comes from
  // _defaultRebuildModelVersion().
  const proc = spawnSync("node", [scriptPath, `--memory-root=${MEMORY_ROOT}`], {
    env: process.env, // MEMORY_ROOT et al already pinned at the top.
    encoding: "utf8",
  });
  assert.equal(proc.status, 0, `CLI exit 0 (stderr: ${proc.stderr})`);
  const out = proc.stdout.trim();
  assert.ok(out.length > 0, "CLI stdout non-empty");
  const env = JSON.parse(out);
  assert.equal(env.wrote_index, true);
  assert.equal(env.rows_indexed, 12);
  assert.equal(env.model_version, MODEL_VERSION);
  assert.ok(existsSync(BM25_PATH), "CLI wrote bm25.json");
  pass("CLI script end-to-end OK");
});

// ---------------------------------------------------------------------------
// Test 12: CLI script --dry-run does not touch disk.
// ---------------------------------------------------------------------------
await test("rebuild-bm25-index.mjs --dry-run leaves index untouched", () => {
  resetWorld();
  writeLedger([makeFactRow("mem_cli_dry", "dry run content")]);

  const here = fileURLToPath(import.meta.url);
  const scriptPath = join(
    here,
    "..",
    "..",
    "scripts",
    "rebuild-bm25-index.mjs",
  );

  const proc = spawnSync("node", [scriptPath, "--dry-run"], {
    env: process.env,
    encoding: "utf8",
  });
  assert.equal(proc.status, 0, `CLI dry-run exit 0 (stderr: ${proc.stderr})`);
  const env = JSON.parse(proc.stdout.trim());
  assert.equal(env.wrote_index, false);
  assert.equal(existsSync(BM25_PATH), false, "no file written in dry run");
  pass("CLI dry-run OK");
});

// ---------------------------------------------------------------------------
// Test 13 (S2y writer regression pin): rebuildBm25IndexFromLedger must
// (a) advance the generation (manifest rebound through publishGeneration),
// (b) carry the untouched hnsw member's recorded checksum forward, and
// (c) produce a generation a cold loadIndices actually serves.
// A revert of the rebuild writer to a bare fixed-path write fails (a): the
// manifest generation stops advancing while bm25.json changes underneath it
// — the exact out-of-band outage S3 fix cycle 2 closed.
//
// FAIL-ABILITY EVIDENCE (honest gate; the writer is already fixed, so this
// pin cannot be red against the current tree) — verbatim failing run against
// an isolated scratchpad copy whose rebuild was reverted to
// `bytesWritten = writeBm25IndexAtomic(bm25Path, idx)` (no publishGeneration),
// 2026-07-15:
//
//   FAIL: S2y writer pin: rebuild advances the generation, carries the hnsw checksum, serves on cold load
//         AssertionError [ERR_ASSERTION]: rebuild ADVANCED the generation (manifest rebound, not a bare fixed-path write)
//
//   0 !== 1
// ---------------------------------------------------------------------------
await test("S2y writer pin: rebuild advances the generation, carries the hnsw checksum, serves on cold load", () => {
  resetWorld();
  _resetCaches();

  // Seed a generation WITH an hnsw member so the carry is observable.
  const seedBm25 = new Bm25Index();
  seedBm25.add({
    memory_id: "mem_seeded",
    kind: "fact",
    content: "synthetic seeded anchorglyph",
    ts: "2026-07-15T00:00:00Z",
    entities: [],
    valence: null,
    consent_basis: "first_party",
  });
  const seedHnsw = new HnswIndex({
    dims: 8,
    embedding_model_version: MODEL_VERSION,
    maxElements: 64,
  });
  seedHnsw.add("mem_seeded", [1, 0, 0, 0, 0, 0, 0, 0]);
  saveIndices(MODEL_VERSION, { bm25: seedBm25, hnsw: seedHnsw });
  _resetCaches();

  const dir = join(MEMORY_ROOT, "indices", MODEL_VERSION);
  const before = readActiveManifest(dir).manifest;
  assert.ok(
    before != null && before.members.hnsw != null,
    "fixture: seeded generation has an hnsw member",
  );

  writeLedger([
    makeFactRow("mem_reb_1", "rebuilt content pivotglyph one"),
    makeFactRow("mem_reb_2", "rebuilt content pivotglyph two"),
  ]);
  const res = rebuildBm25IndexFromLedger({ modelVersion: MODEL_VERSION });
  assert.equal(res.wrote_index, true, "rebuild wrote the index");

  const after = readActiveManifest(dir).manifest;
  assert.ok(after != null, "manifest present after rebuild");
  assert.equal(
    after.generation,
    before.generation + 1,
    "rebuild ADVANCED the generation (manifest rebound, not a bare fixed-path write)",
  );
  assert.ok(after.members.bm25 != null, "rebuilt bm25 member bound");
  assert.notEqual(
    after.members.bm25.sha256,
    before.members.bm25 != null ? before.members.bm25.sha256 : null,
    "rebuilt bm25 member re-checksummed",
  );
  assert.equal(
    after.members.hnsw.sha256,
    before.members.hnsw.sha256,
    "untouched hnsw member's recorded checksum carried forward",
  );

  _resetCaches();
  const served = loadIndices(MODEL_VERSION);
  assert.equal(
    served.bm25.search("pivotglyph", 5).length,
    2,
    "cold load serves the rebuilt content",
  );
  assert.ok(served.hnsw.has("mem_seeded"), "carried hnsw member still served");
  _resetCaches();
  pass("writer regression pin OK");
});

// ---------------------------------------------------------------------------
// Test 14 (S2y source pin, T11-style): the LIVE reembed script —
// mcp/scripts/reembed-local-4096.mjs, NOT the stale repo-root scripts/ copy —
// must publish its HNSW output through publishGeneration and contain no bare
// fixed-path hnsw.save call. A revert to `hnsw.save(HNSW_PATH)` fails here.
//
// FAIL-ABILITY EVIDENCE (honest gate) — verbatim failing run against an
// isolated scratchpad copy whose reembed script was reverted to
// `hnsw.save(HNSW_PATH)`, 2026-07-15:
//
//   FAIL: S2y source pin: reembed-local-4096.mjs publishes via publishGeneration, never bare hnsw.save
//         AssertionError [ERR_ASSERTION]: reembed publishes through the ONE sanctioned publication seam
// ---------------------------------------------------------------------------
await test("S2y source pin: reembed-local-4096.mjs publishes via publishGeneration, never bare hnsw.save", () => {
  const here = fileURLToPath(import.meta.url);
  const scriptPath = join(here, "..", "..", "scripts", "reembed-local-4096.mjs");
  assert.ok(existsSync(scriptPath), `pinned script exists at ${scriptPath}`);
  const src = readFileSync(scriptPath, "utf8");
  // Strip comment-only lines so prose ABOUT the old bug does not trip the pin.
  const code = src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
  assert.match(
    code,
    /publishGeneration\s*\(\s*OUTPUT_MODEL_VERSION\s*,\s*\{\s*hnsw\s*\}\s*\)/,
    "reembed publishes through the ONE sanctioned publication seam",
  );
  assert.doesNotMatch(
    code,
    /\bhnsw\s*\.\s*save\s*\(/,
    "no bare fixed-path hnsw.save left in the reembed script",
  );
  pass("source pin OK");
});

// ---------------------------------------------------------------------------
// Test 15 (S2y publisher mutual exclusion, daemon tolerance): with the S2
// flush lease held by a live process, the rebuild's publishGeneration is
// refused with a structured lease-busy error; maybeRunBm25Rebuild surfaces
// it as its defensive "rebuild_failed" envelope with state UNTOUCHED, so the
// watermark daemon simply retries on its next tick — and succeeds once the
// lease is free.
//
// RED-FIRST EVIDENCE — verbatim failing run against the pre-S2y
// index-cache.js (2026-07-15, branch memperf, isolated scratchpad copy —
// RED-RUN ISOLATION; the live tree was never reverted):
//
//   FAIL: S2y lease-busy: maybeRunBm25Rebuild tolerates a held flush lease and retries next tick
//         AssertionError [ERR_ASSERTION]: lease-busy surfaces as the daemon's structured failure envelope
//   + actual - expected
//
//   + 'rebuilt'
//   - 'rebuild_failed'
// ---------------------------------------------------------------------------
await test("S2y lease-busy: maybeRunBm25Rebuild tolerates a held flush lease and retries next tick", () => {
  resetWorld();
  _resetCaches();
  const rows = [];
  for (let i = 0; i < 6; i++) {
    rows.push(makeFactRow(`mem_lease_${i}`, `lease content ${i}`));
  }
  writeLedger(rows);

  const dir = join(MEMORY_ROOT, "indices", MODEL_VERSION);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const leasePath = join(dir, WAL_LEASE_FILE);
  // Another process holds the flush lease: LIVE pid, fresh mtime.
  writeFileSync(
    leasePath,
    JSON.stringify({ pid: process.pid, heartbeat_ts: new Date().toISOString() }),
    { mode: 0o600 },
  );
  try {
    const res = maybeRunBm25Rebuild({ modelVersion: MODEL_VERSION, threshold: 5 });
    assert.equal(
      res.action,
      "rebuild_failed",
      "lease-busy surfaces as the daemon's structured failure envelope",
    );
    assert.match(res.error, /flush lease busy/, "the error names the busy lease");
    assert.equal(
      readRebuildState(),
      null,
      "state untouched on the skip: the next tick retries the same delta",
    );
  } finally {
    rmSync(leasePath, { force: true });
  }

  const res2 = maybeRunBm25Rebuild({ modelVersion: MODEL_VERSION, threshold: 5 });
  assert.equal(res2.action, "rebuilt", "the next tick's retry succeeds once the lease is free");
  assert.ok(readRebuildState() != null, "state persisted after the successful rebuild");
  pass("lease-busy tolerance OK");
});

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log(`\nresults: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
process.exit(0);
