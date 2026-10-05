// entity-index.test.mjs — coverage for the substrate-tier inverted entity
// index (F-SYN-SUBSTRATE-ENTITY-INDEX).
//
// Run: node test/synthesis/entity-index.test.mjs

import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermeticity: even though entity-index does not read MEMORY_ROOT directly
// (the ledger path flows in as a parameter), follow the existing convention
// for consistency with the other synthesis suites.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-ei-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");

const {
  rebuildEntityIndex,
  loadOrRebuildIndex,
  lookupByEntity,
  addToIndex,
  persistIndex,
  ENTITY_INDEX_SCHEMA_VERSION,
} = await import("../../lib/synthesis/entity-index.js");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

function assertEqual(actual, expected, msg) {
  const ok = actual === expected;
  if (ok) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}\n   actual:   ${JSON.stringify(actual)}\n   expected: ${JSON.stringify(expected)}`);
  }
}

function assertDeepEqual(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}\n   actual:   ${JSON.stringify(actual)}\n   expected: ${JSON.stringify(expected)}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureDir(path) {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function makeRow({ id, entities, kind = "fact" }) {
  return JSON.stringify({
    id,
    kind,
    ts: "2026-06-18T00:00:00Z",
    features: {
      entities,
    },
  });
}

// ---------------------------------------------------------------------------
// T1: surface presence
// ---------------------------------------------------------------------------
assert(typeof rebuildEntityIndex === "function", "rebuildEntityIndex exported as function");
assert(typeof loadOrRebuildIndex === "function", "loadOrRebuildIndex exported as function");
assert(typeof lookupByEntity === "function", "lookupByEntity exported as function");
assert(typeof addToIndex === "function", "addToIndex exported as function");
assert(typeof persistIndex === "function", "persistIndex exported as function");
assertEqual(ENTITY_INDEX_SCHEMA_VERSION, "v1", "schema version is v1");

// ---------------------------------------------------------------------------
// T2: rebuild over a fixture ledger with 3 rows
// ---------------------------------------------------------------------------
{
  const ws = join(TMP_ROOT, "ws-rebuild");
  await ensureDir(ws);
  const ledgerPath = join(ws, "memory.jsonl");
  const rows = [
    makeRow({
      id: "fact-001",
      entities: [
        { kind: "person", canonical_id: "person:git-log:sam_example_com", surface: "sam@example.com" },
        { kind: "project", canonical_id: "project:git-log:memory_system", surface: "memory-system" },
      ],
    }),
    makeRow({
      id: "fact-002",
      entities: [
        { kind: "person", canonical_id: "person:git-log:sam_example_com", surface: "sam@example.com" },
        { kind: "artifact", canonical_id: "artifact:git-log:mcp_lib_validation_js", surface: "mcp/lib/validation.js" },
      ],
    }),
    makeRow({
      id: "fact-003",
      entities: [
        { kind: "project", canonical_id: "project:git-log:memory_system", surface: "memory-system" },
        { kind: "org", canonical_id: "org:github-events:alex", surface: "alex" },
      ],
    }),
  ];
  writeFileSync(ledgerPath, rows.join("\n") + "\n", { mode: 0o600 });

  const idx = await rebuildEntityIndex({ ledgerPath });
  assert(idx.entitiesByCanonicalId instanceof Map, "rebuild: returned Map");
  assertEqual(idx.entitiesByCanonicalId.size, 4, "rebuild: 4 distinct canonical_ids indexed");

  // lookupByEntity for the cross-row entity returns both rows in ledger order.
  const samHits = lookupByEntity(idx, "person:git-log:sam_example_com");
  assertDeepEqual(samHits, ["fact-001", "fact-002"], "lookup: sam appears in both rows in order");

  const projectHits = lookupByEntity(idx, "project:git-log:memory_system");
  assertDeepEqual(projectHits, ["fact-001", "fact-003"], "lookup: project hit in rows 1 + 3");

  const artifactHits = lookupByEntity(idx, "artifact:git-log:mcp_lib_validation_js");
  assertDeepEqual(artifactHits, ["fact-002"], "lookup: artifact in row 2 only");

  // ledgerMtime is the file's mtimeMs.
  const expectedMtime = statSync(ledgerPath).mtimeMs;
  assertEqual(idx.ledgerMtime, expectedMtime, "rebuild: ledgerMtime matches statSync");

  assert(typeof idx.built_at === "string" && idx.built_at.endsWith("Z"), "rebuild: built_at is an ISO-Z string");
}

// ---------------------------------------------------------------------------
// T3: lookup of unknown canonical_id returns []
// ---------------------------------------------------------------------------
{
  const idx = await rebuildEntityIndex({
    ledgerPath: join(TMP_ROOT, "ws-rebuild", "memory.jsonl"),
  });
  assertDeepEqual(lookupByEntity(idx, "person:imessage:does_not_exist"), [], "lookup: unknown id → []");
  assertDeepEqual(lookupByEntity(idx, ""), [], "lookup: empty id → []");
}

// ---------------------------------------------------------------------------
// T4: cache persist + reload round-trip
// ---------------------------------------------------------------------------
{
  const ws = join(TMP_ROOT, "ws-roundtrip");
  await ensureDir(ws);
  const ledgerPath = join(ws, "memory.jsonl");
  const cachePath = join(ws, "entity-index-cache.json");
  const rows = [
    makeRow({
      id: "fact-a",
      entities: [{ kind: "topic", canonical_id: "topic:manual:sample_orchard", surface: "#sample-orchard" }],
    }),
    makeRow({
      id: "fact-b",
      entities: [{ kind: "topic", canonical_id: "topic:manual:sample_orchard", surface: "#sample-orchard" }],
    }),
  ];
  writeFileSync(ledgerPath, rows.join("\n") + "\n", { mode: 0o600 });

  const built = await rebuildEntityIndex({ ledgerPath, cachePath });
  assert(existsSync(cachePath), "persist: cache file exists after rebuild-with-cachePath");
  const onDisk = JSON.parse(readFileSync(cachePath, "utf8"));
  assertEqual(onDisk.schema_version, "v1", "persist: schema_version on disk");
  assertEqual(onDisk.ledger_mtime_ms, built.ledgerMtime, "persist: ledger_mtime_ms matches in-memory");

  // Reload via loadOrRebuildIndex — should hit the cache.
  const reloaded = await loadOrRebuildIndex({ ledgerPath, cachePath });
  const ids = lookupByEntity(reloaded, "topic:manual:sample_orchard");
  assertDeepEqual(ids, ["fact-a", "fact-b"], "reload: cache hit returns same memory_ids");
  assertEqual(reloaded.ledgerMtime, built.ledgerMtime, "reload: ledgerMtime preserved through round-trip");
}

// ---------------------------------------------------------------------------
// T5: cache invalidation on ledger mtime bump
// ---------------------------------------------------------------------------
{
  const ws = join(TMP_ROOT, "ws-invalidate");
  await ensureDir(ws);
  const ledgerPath = join(ws, "memory.jsonl");
  const cachePath = join(ws, "entity-index-cache.json");

  writeFileSync(ledgerPath, makeRow({
    id: "fact-x1",
    entities: [{ kind: "person", canonical_id: "person:git-log:alice_example_com", surface: "alice@example.com" }],
  }) + "\n", { mode: 0o600 });

  const first = await loadOrRebuildIndex({ ledgerPath, cachePath });
  assertDeepEqual(lookupByEntity(first, "person:git-log:alice_example_com"), ["fact-x1"], "stale-test: initial build sees fact-x1");

  // Append a row AND force a newer mtime so macOS HFS+'s 1s granularity does
  // not mask the bump.
  writeFileSync(
    ledgerPath,
    makeRow({
      id: "fact-x1",
      entities: [{ kind: "person", canonical_id: "person:git-log:alice_example_com", surface: "alice@example.com" }],
    }) + "\n" + makeRow({
      id: "fact-x2",
      entities: [{ kind: "person", canonical_id: "person:git-log:bob_example_com", surface: "bob@example.com" }],
    }) + "\n",
    { mode: 0o600 },
  );
  const future = new Date(Date.now() + 5000);
  utimesSync(ledgerPath, future, future);

  const second = await loadOrRebuildIndex({ ledgerPath, cachePath });
  assertDeepEqual(
    lookupByEntity(second, "person:git-log:bob_example_com"),
    ["fact-x2"],
    "invalidation: cache rebuilt after ledger mtime bump (bob appears)",
  );
  // Old row should still be there too.
  assertDeepEqual(
    lookupByEntity(second, "person:git-log:alice_example_com"),
    ["fact-x1"],
    "invalidation: original entity preserved across rebuild",
  );
  assert(second.ledgerMtime !== first.ledgerMtime, "invalidation: ledgerMtime changed across rebuild");

  // The cache file was overwritten with the new fingerprint.
  const onDisk = JSON.parse(readFileSync(cachePath, "utf8"));
  assertEqual(onDisk.ledger_mtime_ms, second.ledgerMtime, "invalidation: persisted cache reflects new mtime");
}

// ---------------------------------------------------------------------------
// T6: addToIndex on a loaded index (in-memory add, no persist)
// ---------------------------------------------------------------------------
{
  const ws = join(TMP_ROOT, "ws-add");
  await ensureDir(ws);
  const ledgerPath = join(ws, "memory.jsonl");
  writeFileSync(ledgerPath, makeRow({
    id: "fact-only",
    entities: [{ kind: "person", canonical_id: "person:git-log:alex_example_com", surface: "alex@example.com" }],
  }) + "\n", { mode: 0o600 });

  const idx = await rebuildEntityIndex({ ledgerPath });

  addToIndex(idx, "fact-new", [
    { kind: "person", canonical_id: "person:git-log:alex_example_com" },
    { kind: "project", canonical_id: "project:git-log:sample_orchard" },
  ]);

  assertDeepEqual(
    lookupByEntity(idx, "person:git-log:alex_example_com"),
    ["fact-only", "fact-new"],
    "addToIndex: extends existing bucket in order",
  );
  assertDeepEqual(
    lookupByEntity(idx, "project:git-log:sample_orchard"),
    ["fact-new"],
    "addToIndex: opens a new bucket for an unseen canonical_id",
  );

  // Idempotent re-add: re-adding the same (memory_id, canonical_id) pair must
  // not double-count it in the bucket.
  addToIndex(idx, "fact-new", [
    { kind: "project", canonical_id: "project:git-log:sample_orchard" },
  ]);
  assertDeepEqual(
    lookupByEntity(idx, "project:git-log:sample_orchard"),
    ["fact-new"],
    "addToIndex: idempotent re-add does not duplicate",
  );

  // Tolerates malformed inputs.
  addToIndex(idx, "fact-malformed", null);                              // no entities
  addToIndex(idx, "fact-malformed", []);                                // empty
  addToIndex(idx, "fact-malformed", [null, undefined, "not-an-object"]); // bad shapes
  addToIndex(idx, "fact-malformed", [{ canonical_id: "" }]);            // empty id
  addToIndex(idx, "fact-malformed", [{ canonical_id: 42 }]);            // non-string id
  addToIndex(idx, "", [{ canonical_id: "person:git-log:should_be_ignored" }]); // empty memory_id

  assertDeepEqual(
    lookupByEntity(idx, "person:git-log:should_be_ignored"),
    [],
    "addToIndex: empty memory_id is silently ignored",
  );
}

// ---------------------------------------------------------------------------
// T7: missing ledger → empty index (cold start)
// ---------------------------------------------------------------------------
{
  const ws = join(TMP_ROOT, "ws-coldstart");
  await ensureDir(ws);
  const ledgerPath = join(ws, "memory.jsonl"); // does not exist
  const idx = await rebuildEntityIndex({ ledgerPath });
  assertEqual(idx.entitiesByCanonicalId.size, 0, "cold-start: empty map when ledger missing");
  assertEqual(idx.ledgerMtime, 0, "cold-start: ledgerMtime=0 when ledger missing");
  assertDeepEqual(lookupByEntity(idx, "person:foo:bar"), [], "cold-start: lookup → []");
}

// ---------------------------------------------------------------------------
// T8: corrupt cache → silent rebuild
// ---------------------------------------------------------------------------
{
  const ws = join(TMP_ROOT, "ws-corrupt");
  await ensureDir(ws);
  const ledgerPath = join(ws, "memory.jsonl");
  const cachePath = join(ws, "entity-index-cache.json");
  writeFileSync(ledgerPath, makeRow({
    id: "fact-c1",
    entities: [{ kind: "person", canonical_id: "person:git-log:carol_example_com", surface: "carol@example.com" }],
  }) + "\n", { mode: 0o600 });
  writeFileSync(cachePath, "this is not valid json {{{", { mode: 0o600 });

  const idx = await loadOrRebuildIndex({ ledgerPath, cachePath });
  assertDeepEqual(
    lookupByEntity(idx, "person:git-log:carol_example_com"),
    ["fact-c1"],
    "corrupt: rebuild proceeds despite garbage in cache",
  );
}

// ---------------------------------------------------------------------------
// T9: rows without features.entities are skipped (tolerant rebuild)
// ---------------------------------------------------------------------------
{
  const ws = join(TMP_ROOT, "ws-skip");
  await ensureDir(ws);
  const ledgerPath = join(ws, "memory.jsonl");
  const rows = [
    JSON.stringify({ id: "no-features", kind: "fact", ts: "2026-06-18T00:00:00Z" }),
    JSON.stringify({ id: "no-entities", kind: "fact", ts: "2026-06-18T00:00:00Z", features: {} }),
    JSON.stringify({ id: "empty-entities", kind: "fact", ts: "2026-06-18T00:00:00Z", features: { entities: [] } }),
    JSON.stringify({ kind: "fact", features: { entities: [{ canonical_id: "person:foo:x" }] } }), // missing id field entirely
    makeRow({
      id: "real-row",
      entities: [{ kind: "person", canonical_id: "person:git-log:dave_example_com", surface: "dave@example.com" }],
    }),
    "{this is torn json",
    "",
  ];
  writeFileSync(ledgerPath, rows.join("\n") + "\n", { mode: 0o600 });

  const idx = await rebuildEntityIndex({ ledgerPath });
  assertEqual(idx.entitiesByCanonicalId.size, 1, "tolerant rebuild: only the one well-formed row contributes");
  assertDeepEqual(
    lookupByEntity(idx, "person:git-log:dave_example_com"),
    ["real-row"],
    "tolerant rebuild: well-formed row indexed correctly",
  );
}

// ---------------------------------------------------------------------------
// T10: persist writes mode-0600 file
// ---------------------------------------------------------------------------
{
  const ws = join(TMP_ROOT, "ws-mode");
  await ensureDir(ws);
  const ledgerPath = join(ws, "memory.jsonl");
  const cachePath = join(ws, "entity-index-cache.json");
  writeFileSync(ledgerPath, makeRow({
    id: "fact-m1",
    entities: [{ kind: "person", canonical_id: "person:git-log:eve_example_com" }],
  }) + "\n", { mode: 0o600 });

  const idx = await rebuildEntityIndex({ ledgerPath });
  await persistIndex(idx, cachePath);
  const s = statSync(cachePath);
  // mode is the high bits + permission bits; check only the low 9 bits.
  const perm = s.mode & 0o777;
  assertEqual(perm, 0o600, "persist: cache file written with mode 0600");
}

// ---------------------------------------------------------------------------
// T11: schema_version mismatch on cache → rebuild
// ---------------------------------------------------------------------------
{
  const ws = join(TMP_ROOT, "ws-schema");
  await ensureDir(ws);
  const ledgerPath = join(ws, "memory.jsonl");
  const cachePath = join(ws, "entity-index-cache.json");
  writeFileSync(ledgerPath, makeRow({
    id: "fact-s1",
    entities: [{ kind: "person", canonical_id: "person:git-log:frank_example_com" }],
  }) + "\n", { mode: 0o600 });

  // Bogus schema version on the cache file — should force a rebuild.
  writeFileSync(cachePath, JSON.stringify({
    schema_version: "v999",
    ledger_mtime_ms: statSync(ledgerPath).mtimeMs,
    entries: { "person:git-log:WHATEVER": ["should-be-overwritten"] },
    built_at: new Date().toISOString(),
  }), { mode: 0o600 });

  const idx = await loadOrRebuildIndex({ ledgerPath, cachePath });
  assertDeepEqual(
    lookupByEntity(idx, "person:git-log:WHATEVER"),
    [],
    "schema-mismatch: stale cache contents discarded",
  );
  assertDeepEqual(
    lookupByEntity(idx, "person:git-log:frank_example_com"),
    ["fact-s1"],
    "schema-mismatch: rebuilt index reflects ledger truth",
  );
  // And the cache is now correctly versioned.
  const onDisk = JSON.parse(readFileSync(cachePath, "utf8"));
  assertEqual(onDisk.schema_version, "v1", "schema-mismatch: cache file rewritten with current version");
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
rmSync(TMP_ROOT, { recursive: true, force: true });

console.log(`entity-index.test.mjs: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
