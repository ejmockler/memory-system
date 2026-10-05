// bm25-index.test.mjs — Phase 3 v0 recall layer foundations.
//
// Hermetic discipline (standing C-NEW-2 pattern): set MEMORY_ROOT and the
// POLICY/STORAGE/LEDGERS dirs to mkdtempSync paths BEFORE any dynamic import
// of memory-system modules. The default data root (the checkout that contains
// mcp/) must not be touched.
//
// The Bm25Index module is pure in-memory and does not currently touch
// MEMORY_ROOT, but we set the env vars regardless: (a) future-proofing in
// case the module integrates with config.js, (b) symmetry with the rest of
// the test suite, (c) belt-and-braces against accidental drift.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Hermeticity: stake out tmp dirs and overwrite env BEFORE dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-bm25-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");

// Dynamic import AFTER env override.
const mod = await import("../lib/recall/bm25-index.js");
const { Bm25Index, _internals } = mod;

// ---------------------------------------------------------------------------
// Test framework: ad-hoc assert-with-label, matches sibling test/*.test.mjs.
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
// Shared fixtures.
// ---------------------------------------------------------------------------

// Five entries; "alpha" appears in 3 of 5 docs (m1, m2, m3); "rare" only in
// m4; "exclusive" only in m5. IDF should rank rare/exclusive matches above
// alpha-only matches.
const FIXTURE_ENTRIES = [
  {
    memory_id: "mem_a",
    kind: "fact",
    content: "alpha bravo charlie delta",
    ts: "2026-06-01T00:00:00Z",
    entities: ["Alex", "Example Team"],
  },
  {
    memory_id: "mem_b",
    kind: "fact",
    content: "alpha echo foxtrot",
    ts: "2026-06-01T00:00:01Z",
    entities: ["Alex"],
  },
  {
    memory_id: "mem_c",
    kind: "fact",
    content: "alpha golf hotel india",
    ts: "2026-06-01T00:00:02Z",
    entities: ["Fernwick", "lab"],
  },
  {
    memory_id: "mem_d",
    kind: "fact",
    content: "rare juliet kilo lima",
    ts: "2026-06-01T00:00:03Z",
    entities: [],
  },
  {
    memory_id: "mem_e",
    kind: "fact",
    content: "exclusive mike november oscar",
    ts: "2026-06-01T00:00:04Z",
    entities: ["Alex", "Fernwick"],
  },
];

// ---------------------------------------------------------------------------
// Test 1: add 5 entries with known content; query for keywords present in
// 3 of them; verify top-3 ranking + IDF penalizes common terms.
// ---------------------------------------------------------------------------
await test(
  "Test 1: BM25 ranks rare-term matches above common-term matches",
  () => {
    const idx = new Bm25Index({});
    idx.addBulk(FIXTURE_ENTRIES);
    assert.equal(idx.size(), 5, "size after bulk add");

    // Query "alpha" returns exactly the 3 docs containing it.
    const alphaResults = idx.search("alpha", 50);
    assert.equal(alphaResults.length, 3, "alpha hits exactly 3 docs");
    const alphaIds = new Set(alphaResults.map((r) => r.memory_id));
    for (const id of ["mem_a", "mem_b", "mem_c"]) {
      assert.ok(alphaIds.has(id), `alpha results include ${id}`);
    }

    // Query with both a common ("alpha") and a rare ("rare") term: the doc
    // matching the rare term should outrank the alpha-only matches because
    // IDF of "rare" >> IDF of "alpha".
    const mixed = idx.search("alpha rare", 50);
    assert.ok(mixed.length >= 4, "mixed query hits at least 4 docs");
    assert.equal(
      mixed[0].memory_id,
      "mem_d",
      "rare-only match outranks alpha-only matches (IDF penalty)",
    );
    // Verify all returned items carry the rank field in sorted order.
    for (let i = 0; i < mixed.length; i++) {
      assert.equal(mixed[i].rank, i, `rank monotonically increases at ${i}`);
    }
    // Verify scores are monotonically non-increasing.
    for (let i = 1; i < mixed.length; i++) {
      assert.ok(
        mixed[i - 1].score >= mixed[i].score,
        `scores monotone non-increasing at ${i}`,
      );
    }
    pass("alpha returns 3 docs; rare-only doc outranks alpha-only");
  },
);

// ---------------------------------------------------------------------------
// Test 2: tokenization handles punctuation + casing.
// ---------------------------------------------------------------------------
await test("Test 2: tokenization is case-insensitive + punctuation-robust", () => {
  const idx = new Bm25Index({});
  idx.add({
    memory_id: "mem_punct",
    kind: "fact",
    content: "Hello, World! It's a test... of TOKENIZATION; well-formed.",
    ts: "2026-06-01T00:00:00Z",
    entities: [],
  });

  // Lowercase query matches mixed-case content.
  const r1 = idx.search("hello", 10);
  assert.equal(r1.length, 1, "lowercase 'hello' matches 'Hello,'");
  assert.equal(r1[0].memory_id, "mem_punct");

  // Punctuation inside the source content does NOT break the token.
  const r2 = idx.search("tokenization", 10);
  assert.equal(r2.length, 1, "'tokenization' matches 'TOKENIZATION;'");

  // Hyphenated word is split on \W+ (well-formed -> well, formed).
  const r3 = idx.search("formed", 10);
  assert.equal(r3.length, 1, "'formed' matches 'well-formed'");

  // Stopwords are dropped: "of" is a stopword; "of test" should still match
  // via "test", but querying ONLY "of" returns nothing.
  const r4 = idx.search("of", 10);
  assert.equal(r4.length, 0, "stopword-only query returns 0 results");

  // Apostrophe split: "it's" -> "it", "s". "it" is a stopword so dropped;
  // "s" is a single-char non-stopword token that should still exist.
  const tokens = _internals.tokenize("It's");
  assert.deepEqual(tokens, ["s"], "tokenize('It\\'s') drops stopword 'it'");

  pass("punctuation, casing, hyphens, stopwords all handled");
});

// ---------------------------------------------------------------------------
// Test 3: serialize/deserialize round-trip preserves search results.
// ---------------------------------------------------------------------------
await test("Test 3: serialize/deserialize round-trip preserves search", () => {
  const idx = new Bm25Index({ k1: 1.5, b: 0.5 });
  idx.addBulk(FIXTURE_ENTRIES);

  const before = idx.search("alpha rare exclusive", 50);
  const beforeEntities = idx.searchEntities(["Alex", "Fernwick"], 50);
  const beforeSize = idx.size();

  const blob = idx.serialize();

  // Confirm the blob is plain-JSON round-trippable.
  const json = JSON.stringify(blob);
  const parsed = JSON.parse(json);

  const restored = Bm25Index.deserialize(parsed);
  assert.equal(restored.size(), beforeSize, "size preserved");
  assert.equal(restored.k1, 1.5, "k1 preserved");
  assert.equal(restored.b, 0.5, "b preserved");

  const after = restored.search("alpha rare exclusive", 50);
  assert.equal(after.length, before.length, "result length preserved");
  for (let i = 0; i < after.length; i++) {
    assert.equal(
      after[i].memory_id,
      before[i].memory_id,
      `memory_id preserved at rank ${i}`,
    );
    assert.ok(
      Math.abs(after[i].score - before[i].score) < 1e-9,
      `score preserved at rank ${i}`,
    );
  }

  const afterEntities = restored.searchEntities(["Alex", "Fernwick"], 50);
  assert.equal(
    afterEntities.length,
    beforeEntities.length,
    "entity result length preserved",
  );
  for (let i = 0; i < afterEntities.length; i++) {
    assert.equal(
      afterEntities[i].memory_id,
      beforeEntities[i].memory_id,
      `entity memory_id preserved at rank ${i}`,
    );
    assert.equal(
      afterEntities[i].count,
      beforeEntities[i].count,
      `entity count preserved at rank ${i}`,
    );
  }
  pass("round-trip preserves BM25 + entity search results");
});

// ---------------------------------------------------------------------------
// Test 4: searchEntities returns memories tagged with given entities.
// ---------------------------------------------------------------------------
await test("Test 4: searchEntities returns memories by entity overlap", () => {
  const idx = new Bm25Index({});
  idx.addBulk(FIXTURE_ENTRIES);

  // Alex appears in mem_a, mem_b, mem_e (3 docs). Querying ["Alex"] should
  // return exactly those 3, each with count=1.
  const r1 = idx.searchEntities(["Alex"], 50);
  assert.equal(r1.length, 3, "Alex returns 3 memories");
  for (const item of r1) {
    assert.equal(item.count, 1, `count=1 for ${item.memory_id}`);
  }
  const r1Ids = new Set(r1.map((r) => r.memory_id));
  for (const id of ["mem_a", "mem_b", "mem_e"]) {
    assert.ok(r1Ids.has(id), `Alex results include ${id}`);
  }

  // Querying ["Alex", "Fernwick"]: mem_e has both (count=2), mem_a + mem_b
  // have Alex only (count=1), mem_c has Fernwick only (count=1).
  const r2 = idx.searchEntities(["Alex", "Fernwick"], 50);
  assert.equal(r2.length, 4, "Alex+Fernwick returns 4 memories");
  assert.equal(r2[0].memory_id, "mem_e", "mem_e ranks first (count=2)");
  assert.equal(r2[0].count, 2);
  for (let i = 1; i < r2.length; i++) {
    assert.equal(r2[i].count, 1, `subsequent counts = 1 at ${i}`);
  }

  // Case-insensitive: lowercase query matches mixed-case entity.
  const r3 = idx.searchEntities(["alex"], 50);
  assert.equal(r3.length, 3, "lowercase 'alex' matches 'Alex'");

  // Unknown entity returns empty.
  const r4 = idx.searchEntities(["nonexistent_entity"], 50);
  assert.equal(r4.length, 0, "unknown entity returns []");

  pass("entity search counts + ranks correctly; case-insensitive");
});

// ---------------------------------------------------------------------------
// Test 5: remove(memory_id) drops from postings + doc-stats; subsequent
// searches don't return it.
// ---------------------------------------------------------------------------
await test("Test 5: remove(memory_id) excises from BM25 + entity indices", () => {
  const idx = new Bm25Index({});
  idx.addBulk(FIXTURE_ENTRIES);
  const initialSize = idx.size();
  assert.equal(initialSize, 5);

  // Pre-remove: mem_d shows up for "rare".
  const pre = idx.search("rare", 50);
  assert.ok(pre.some((r) => r.memory_id === "mem_d"), "mem_d in pre-remove");

  // Pre-remove: mem_e shows up for "Fernwick" entity.
  const preEnt = idx.searchEntities(["Fernwick"], 50);
  assert.ok(
    preEnt.some((r) => r.memory_id === "mem_e"),
    "mem_e in pre-remove entity search",
  );

  // Remove mem_d (BM25 hit) and mem_e (entity + BM25 hit).
  idx.remove("mem_d");
  idx.remove("mem_e");
  assert.equal(idx.size(), 3, "size decremented after 2 removes");

  // Post-remove: mem_d not returned for "rare".
  const post = idx.search("rare", 50);
  assert.ok(
    !post.some((r) => r.memory_id === "mem_d"),
    "mem_d absent post-remove",
  );

  // Post-remove: mem_e not returned for "exclusive".
  const post2 = idx.search("exclusive", 50);
  assert.ok(
    !post2.some((r) => r.memory_id === "mem_e"),
    "mem_e absent post-remove",
  );

  // Post-remove: mem_e not returned for entity "Fernwick".
  const postEnt = idx.searchEntities(["Fernwick"], 50);
  assert.ok(
    !postEnt.some((r) => r.memory_id === "mem_e"),
    "mem_e absent post-remove entity search",
  );

  // Removing an unknown id is a no-op (not an error).
  idx.remove("mem_does_not_exist");
  assert.equal(idx.size(), 3, "no-op remove leaves size unchanged");

  // Re-adding a previously-removed doc works and shows up in search.
  idx.add(FIXTURE_ENTRIES[3]); // mem_d
  const reAdd = idx.search("rare", 50);
  assert.ok(
    reAdd.some((r) => r.memory_id === "mem_d"),
    "mem_d re-added is searchable",
  );
  assert.equal(idx.size(), 4);

  pass("remove drops postings + entity index; re-add works");
});

// ---------------------------------------------------------------------------
// Cleanup tmp dir + exit code.
// ---------------------------------------------------------------------------
try {
  rmSync(TMP_ROOT, { recursive: true, force: true });
} catch (_) {
  // best-effort
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
