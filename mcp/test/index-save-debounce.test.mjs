// index-save-debounce.test.mjs — W2-debounced-index-persistence,
// S2-ported to WAL semantics.
//
// Hermetic tests for:
//   - lib/recall/index-cache.js scheduleSaveIndices (count/age debounce,
//     self-contained index-wal.jsonl WAL appends, cursor-advance retirement
//     + compaction after success, WAL/cursor retention on flush failure)
//   - lib/recall/index-cache.js loadIndices replay (legacy pending-adds
//     crash repair + idempotency — the upgrade path — plus WAL replay)
//   - lib/recall/hnsw-index.js save() atomicity (native branch tmp+rename)
//
// S2 PORT NOTE (coverage translated, never deleted): the pre-S2 journal was
// truncated to empty at each successful flush, so this suite asserted
// "journal reset". Retirement is now an applied-cursor advance + compaction
// iff no unretired tail: "journal kept on failed flush" became "WAL intact +
// cursor not advanced"; "journal reset after success" became "cursor
// advanced past the flushed records + WAL compacted". Legacy-journal replay
// tests (c)/(d) still write pending-adds.jsonl directly — that replay path
// survives as the upgrade path.
//
// Discipline (matches sibling test/*.test.mjs, e.g. bm25-rebuild.test.mjs):
//   - mkdtempSync rooted in tmpdir; overwrite MEMORY_ROOT + POLICY_BASE_DIR
//     + STORAGE_BASE_DIR + LEDGERS_BASE_DIR BEFORE any dynamic import of
//     memory-system modules. Live indices / live ledger are NEVER touched.
//   - never reads (or writes) ledgers/memory.jsonl — the journal is
//     self-contained by design; a test even asserts the ledger file was
//     never created inside the temp tree.
//   - small synthetic dims=8 unit vectors; per-test model versions so
//     per-model-version pending state never crosses trees.
//   - node:test + node:assert/strict; _resetCaches() between tests.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Hermeticity: stake tmp dirs + overwrite env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-index-debounce-"));
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
  loadIndices,
  saveIndices,
  scheduleSaveIndices,
  flushIndicesNow,
  _resetCaches,
} = await import("../lib/recall/index-cache.js");
const { WAL_FILE, readAppliedCursor, readWalTail } = await import(
  "../lib/recall/index-wal.js"
);
const { HnswIndex, HNSW_BACKEND } = await import("../lib/recall/hnsw-index.js");
const { Bm25Index } = await import("../lib/recall/bm25-index.js");

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
const DIMS = 8;

// Deterministic dims=8 unit vector per seed (distinct directions so exact
// self-queries rank first).
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

function bm25EntryFor(i, extraToken = "") {
  return {
    memory_id: `mem_${i}`,
    kind: "fact",
    content: `synthetic fact number ${i} token_${i} ${extraToken}`.trim(),
    ts: "2026-07-10T00:00:00Z",
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

// Spy on the expensive persist: saveIndices calls hnsw.save(hnswPath); an
// instance property shadows the prototype method, so this counts REAL disk
// saves without altering their behavior.
function spyHnswSaves(hnsw) {
  const spy = { count: 0, paths: [] };
  const proto = Object.getPrototypeOf(hnsw);
  hnsw.save = function (path) {
    spy.count += 1;
    spy.paths.push(path);
    return proto.save.call(this, path);
  };
  return spy;
}

// Add to the in-memory indices AND schedule the debounced persist — mirrors
// updateIndicesForFact's exact sequence in distill-promote-fact.js.
function addAndSchedule(modelVersion, { bm25, hnsw }, i) {
  const entry = bm25EntryFor(i);
  const vector = unitVec(i);
  bm25.add(entry);
  hnsw.add(entry.memory_id, vector);
  return scheduleSaveIndices(
    modelVersion,
    { bm25, hnsw },
    { factId: entry.memory_id, bm25Entry: entry, vector },
  );
}

function pendingPathFor(modelVersion) {
  return join(MEMORY_ROOT, "indices", modelVersion, "pending-adds.jsonl");
}

function indexDirFor(modelVersion) {
  return join(MEMORY_ROOT, "indices", modelVersion);
}

// LEGACY journal reader — only the upgrade-path tests (c)/(d) below still
// read pending-adds.jsonl directly.
function legacyJournalLines(modelVersion) {
  const p = pendingPathFor(modelVersion);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

// S2: the WAL replaces direct pending-adds.jsonl reads. unretiredRecords
// replays the WAL PAST the applied cursor — i.e. exactly the records a crash
// right now would still owe to the next flush.
function unretiredRecords(modelVersion) {
  const dir = indexDirFor(modelVersion);
  const cursor = readAppliedCursor(dir);
  assert.equal(cursor.error, null, "applied cursor readable");
  const recs = [];
  const r = readWalTail(
    dir,
    { afterSeq: cursor.applied_seq, fromOffset: cursor.applied_offset },
    (rec, seq) => recs.push({ seq, rec }),
  );
  assert.equal(r.error, null, "WAL tail readable");
  return recs;
}

function walSize(modelVersion) {
  const p = join(indexDirFor(modelVersion), WAL_FILE);
  return existsSync(p) ? statSync(p).size : 0;
}

function writeJournal(modelVersion, records) {
  const dir = join(MEMORY_ROOT, "indices", modelVersion);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    pendingPathFor(modelVersion),
    records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n",
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// (a) 100 schedules -> <=2 real saves (count threshold).
// ---------------------------------------------------------------------------
await test("100 scheduled adds produce <=2 real index saves (batch=64)", () => {
  _resetCaches();
  process.env.INDEX_SAVE_BATCH = "64";
  process.env.INDEX_SAVE_MAX_AGE_S = "3600";
  const MV = "w2-test-count";
  const { bm25, hnsw } = freshIndices(MV);
  const spy = spyHnswSaves(hnsw);

  let flushSignals = 0;
  for (let i = 0; i < 100; i++) {
    const res = addAndSchedule(MV, { bm25, hnsw }, i);
    if (res.flushed) flushSignals += 1;
  }

  assert.ok(spy.count >= 1, "at least one real save happened");
  assert.ok(spy.count <= 2, `<=2 real saves for 100 adds (got ${spy.count})`);
  assert.equal(spy.count, 1, "batch=64 over 100 adds flushes exactly once");
  assert.equal(flushSignals, 1, "exactly one schedule call reported flushed");

  // S2: the flush RETIRED the first 64 records (cursor advance + compaction —
  // no truncation); only the post-flush tail (100 - 64 = 36 adds) remains
  // unretired, with seq continuing monotonically past the compaction.
  const cursor = readAppliedCursor(indexDirFor(MV));
  assert.equal(cursor.applied_seq, 64, "cursor advanced past the flushed batch");
  const tail = unretiredRecords(MV);
  assert.equal(tail.length, 36, "WAL owes only the unflushed tail");
  assert.equal(tail[0].seq, 65, "seq monotonic across the compaction");
  const rec = tail[0].rec;
  assert.equal(rec.fact_id, "mem_64", "first tail record is the 65th add");
  assert.ok(Array.isArray(rec.vector) && rec.vector.length === DIMS);
  assert.equal(rec.bm25_entry.memory_id, "mem_64");
  assert.equal(typeof rec.ts, "string");

  // The persisted files exist and the persisted generation holds the first
  // 64 adds (persist happened AT the flush, not after).
  assert.ok(existsSync(join(MEMORY_ROOT, "indices", MV, "bm25.json")));
  assert.ok(existsSync(join(MEMORY_ROOT, "indices", MV, "hnsw.bin")));
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (b) age-based flush fires without reaching the count threshold.
// ---------------------------------------------------------------------------
await test("age threshold flushes a quiet period via the unref'd timer", async () => {
  _resetCaches();
  process.env.INDEX_SAVE_BATCH = "1000";
  process.env.INDEX_SAVE_MAX_AGE_S = "1"; // 1s
  const MV = "w2-test-age";
  const { bm25, hnsw } = freshIndices(MV);
  const spy = spyHnswSaves(hnsw);

  for (let i = 0; i < 3; i++) addAndSchedule(MV, { bm25, hnsw }, i);
  assert.equal(spy.count, 0, "no save before the age threshold");
  assert.equal(unretiredRecords(MV).length, 3, "3 unretired WAL records");

  await sleep(1500); // > INDEX_SAVE_MAX_AGE_S; the timer must fire unaided.

  assert.equal(spy.count, 1, "age-based flush fired exactly once");
  assert.equal(unretiredRecords(MV).length, 0, "all records retired after age flush");
  assert.equal(walSize(MV), 0, "WAL compacted (no unretired tail remained)");
  assert.equal(readAppliedCursor(indexDirFor(MV)).applied_seq, 3, "cursor past all 3");
  assert.ok(existsSync(join(MEMORY_ROOT, "indices", MV, "hnsw.bin")));
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (c) crash sim: non-empty journal + stale on-disk indices -> loadIndices
//     replays and search finds the journaled facts. Read path stays
//     write-free (journal survives the load).
// ---------------------------------------------------------------------------
await test("crash replay: loadIndices replays journaled adds into stale indices", () => {
  _resetCaches();
  const MV = "w2-test-crash";
  const { bm25, hnsw } = freshIndices(MV);
  // Two base facts persisted for real (the stale on-disk generation).
  for (let i = 0; i < 2; i++) {
    bm25.add(bm25EntryFor(i));
    hnsw.add(`mem_${i}`, unitVec(i));
  }
  saveIndices(MV, { bm25, hnsw });

  // Crash window: two more facts made it into the journal but never into a
  // flushed generation. Journal lines are SELF-CONTAINED — no ledger read.
  writeJournal(MV, [
    {
      fact_id: "mem_j1",
      ts: "2026-07-10T01:00:00Z",
      bm25_entry: bm25EntryFor("j1", "zelphwyn"),
      vector: unitVec(101),
    },
    {
      fact_id: "mem_j2",
      ts: "2026-07-10T01:00:01Z",
      bm25_entry: { ...bm25EntryFor("j2", "quokkatron"), memory_id: "mem_j2" },
      vector: unitVec(102),
    },
    "{torn json line", // malformed line must be skipped, not fatal
  ]);
  // Fix the j1 entry's memory_id to match its fact_id (bm25EntryFor("j1")
  // already produced memory_id "mem_j1" — assert to keep the fixture honest).
  assert.equal(bm25EntryFor("j1").memory_id, "mem_j1");

  _resetCaches(); // simulate a fresh process: no warm cache
  const loaded = loadIndices(MV);

  // HNSW finds the journaled vectors.
  const hits1 = loaded.hnsw.search(unitVec(101), 3);
  assert.equal(hits1[0].memory_id, "mem_j1", "hnsw finds journaled mem_j1");
  const hits2 = loaded.hnsw.search(unitVec(102), 3);
  assert.equal(hits2[0].memory_id, "mem_j2", "hnsw finds journaled mem_j2");
  // BM25 finds the journaled content.
  const b1 = loaded.bm25.search("zelphwyn", 10);
  assert.equal(b1.length, 1);
  assert.equal(b1[0].memory_id, "mem_j1", "bm25 finds journaled mem_j1");
  const b2 = loaded.bm25.search("quokkatron", 10);
  assert.equal(b2[0].memory_id, "mem_j2", "bm25 finds journaled mem_j2");
  // Base facts still present.
  assert.equal(loaded.hnsw.size(), 4, "2 base + 2 replayed");
  assert.equal(loaded.bm25.size(), 4);

  // Read path is write-free: the legacy journal was NOT migrated/removed by
  // load (migration happens only at a successful flush).
  assert.equal(
    legacyJournalLines(MV).length,
    3,
    "journal intact after replay (2 records + 1 torn line)",
  );

  // The debounce/journal/replay machinery never touches the memory ledger:
  // nothing in this suite created ledgers/memory.jsonl.
  assert.equal(
    existsSync(join(MEMORY_ROOT, "ledgers", "memory.jsonl")),
    false,
    "no ledger file was ever created or read",
  );
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (d) replay idempotency: journaled facts already present in the loaded
//     index are not double-added (flush-succeeded-but-truncate-crashed).
// ---------------------------------------------------------------------------
await test("replay is idempotent for facts already in the loaded index", () => {
  _resetCaches();
  const MV = "w2-test-idem";
  const { bm25, hnsw } = freshIndices(MV);
  bm25.add(bm25EntryFor(0));
  hnsw.add("mem_0", unitVec(0));
  saveIndices(MV, { bm25, hnsw });

  // Journal claims mem_0 (already persisted — the truncate-crashed window)
  // plus a genuinely new mem_1.
  writeJournal(MV, [
    {
      fact_id: "mem_0",
      ts: "2026-07-10T02:00:00Z",
      bm25_entry: bm25EntryFor(0),
      vector: unitVec(0),
    },
    {
      fact_id: "mem_1",
      ts: "2026-07-10T02:00:01Z",
      bm25_entry: bm25EntryFor(1),
      vector: unitVec(1),
    },
  ]);

  _resetCaches();
  const first = loadIndices(MV);
  assert.equal(first.hnsw.size(), 2, "mem_0 not double-added; mem_1 replayed");
  assert.equal(first.bm25.size(), 2);

  // A second cold load replays the SAME journal again — still no growth and
  // no duplicate-add throw (hnsw.add would throw on a true double-add).
  _resetCaches();
  const second = loadIndices(MV);
  assert.equal(second.hnsw.size(), 2, "second replay is a no-op");
  assert.equal(second.bm25.size(), 2);
  assert.equal(
    second.hnsw.search(unitVec(1), 1)[0].memory_id,
    "mem_1",
    "replayed fact still searchable after idempotent second load",
  );
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (e) atomicity: during a save no partial file is ever visible at the live
//     hnsw.bin / .meta.json paths (tmp-suffix naming + rename observed).
// ---------------------------------------------------------------------------
await test("hnsw save is atomic: tmp-suffix write + rename over the live path", () => {
  _resetCaches();
  const MV = "w2-test-atomic";
  const dir = join(MEMORY_ROOT, "indices", MV);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hnswPath = join(dir, "hnsw.bin");

  const { hnsw } = freshIndices(MV);
  hnsw.add("mem_gen1", unitVec(1));
  hnsw.save(hnswPath); // first generation on disk
  const gen1Stat = statSync(hnswPath);

  hnsw.add("mem_gen2", unitVec(2));

  if (HNSW_BACKEND === "hnswlib-node") {
    // Interpose on the native writer: while the new generation is being
    // written, the LIVE path must still be the untouched first generation,
    // and the write target must be a `.tmp-<pid>` sibling — the rename is
    // what publishes it.
    const realNative = hnsw._native;
    const captured = [];
    hnsw._native = {
      writeIndexSync(p) {
        captured.push(p);
        assert.notEqual(p, hnswPath, "native write goes to a tmp path");
        assert.match(
          p,
          new RegExp(`\\.tmp-${process.pid}$`),
          "tmp path carries the .tmp-<pid> suffix",
        );
        const liveStat = statSync(hnswPath);
        assert.equal(
          liveStat.mtimeMs,
          gen1Stat.mtimeMs,
          "live hnsw.bin untouched while the tmp generation is written",
        );
        assert.equal(liveStat.size, gen1Stat.size);
        return realNative.writeIndexSync(p);
      },
    };
    try {
      hnsw.save(hnswPath);
    } finally {
      hnsw._native = realNative;
    }
    assert.equal(captured.length, 1, "exactly one tmp-path native write");
  } else {
    // Linear-scan branch was already tmp+fsync+rename (untouched by W2);
    // exercise it for parity.
    hnsw.save(hnswPath);
  }

  // Rename observed: live path now holds the NEW generation...
  const loaded = HnswIndex.load(hnswPath);
  assert.equal(loaded.size(), 2, "live path holds the complete new generation");
  assert.ok(loaded.has("mem_gen1"));
  assert.ok(loaded.has("mem_gen2"));
  // ...and no tmp debris remains at any name in the dir.
  const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "no .tmp-* files left after a save");
  if (HNSW_BACKEND === "hnswlib-node") {
    // Meta sidecar was also swapped in whole (parses + matches the new gen).
    const meta = JSON.parse(readFileSync(hnswPath + ".meta.json", "utf8"));
    assert.equal(meta.id_map.length, 2, "meta sidecar matches the binary");
  }
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (f) flush failure keeps the WAL intact + cursor unmoved; a later flush
//     recovers, retires (cursor advance), and compacts.
// ---------------------------------------------------------------------------
await test("failed flush keeps WAL + cursor; next flush retires and compacts", () => {
  _resetCaches();
  process.env.INDEX_SAVE_BATCH = "2";
  process.env.INDEX_SAVE_MAX_AGE_S = "3600";
  const MV = "w2-test-flushfail";
  const { bm25, hnsw } = freshIndices(MV);

  // Break the persist.
  hnsw.save = () => {
    throw new Error("simulated ENOSPC");
  };

  const r1 = addAndSchedule(MV, { bm25, hnsw }, 0);
  assert.equal(r1.flushed, false);
  const r2 = addAndSchedule(MV, { bm25, hnsw }, 1); // hits batch=2 -> flush fails
  assert.equal(r2.flushed, false, "failed flush is reported, not thrown");
  assert.equal(unretiredRecords(MV).length, 2, "WAL intact after failed flush");
  assert.equal(
    readAppliedCursor(indexDirFor(MV)).applied_seq,
    0,
    "cursor NOT advanced by a failed flush",
  );
  // The failed flush released the single-writer lease (no wedged slot).
  assert.equal(
    existsSync(join(indexDirFor(MV), "index-wal.lock")),
    false,
    "flush lease released after failure",
  );

  // Heal the persist (drop the instance override; prototype save returns).
  delete hnsw.save;
  const spy = spyHnswSaves(hnsw);
  const r3 = addAndSchedule(MV, { bm25, hnsw }, 2); // count=3 >= 2 -> flush
  assert.equal(r3.flushed, true, "recovered flush succeeds");
  assert.equal(spy.count, 1, "exactly one real save on recovery");
  assert.equal(unretiredRecords(MV).length, 0, "all records retired on recovery");
  assert.equal(readAppliedCursor(indexDirFor(MV)).applied_seq, 3, "cursor past all 3");
  assert.equal(walSize(MV), 0, "WAL compacted (no unretired tail)");

  // The recovered generation contains ALL three facts (the failed-flush adds
  // were never lost — they lived in memory + WAL).
  _resetCaches();
  const loaded = loadIndices(MV);
  assert.equal(loaded.hnsw.size(), 3);
  assert.equal(loaded.bm25.size(), 3);
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (g) S2 legacy upgrade: a non-empty pending-adds.jsonl is replayed at load,
//     persisted by the next flush, then renamed (never unlinked) to
//     pending-adds.jsonl.migrated-<epoch-ms>.
// ---------------------------------------------------------------------------
await test("legacy pending-adds.jsonl is migrated (renamed, never unlinked) at flush", () => {
  _resetCaches();
  process.env.INDEX_SAVE_BATCH = "1000";
  process.env.INDEX_SAVE_MAX_AGE_S = "3600";
  const MV = "w2-test-migrate";
  const { bm25, hnsw } = freshIndices(MV);
  bm25.add(bm25EntryFor(0));
  hnsw.add("mem_0", unitVec(0));
  saveIndices(MV, { bm25, hnsw });

  // Pre-upgrade crash tail in the LEGACY journal.
  writeJournal(MV, [
    {
      fact_id: "mem_legacy",
      ts: "2026-07-10T03:00:00Z",
      bm25_entry: bm25EntryFor("legacy", "vintagetoken"),
      vector: unitVec(201),
    },
  ]);
  assert.equal(bm25EntryFor("legacy").memory_id, "mem_legacy");

  // Fresh load replays the legacy journal; a scheduled add + flush persists
  // the combined state and migrates the journal.
  _resetCaches();
  const loaded = loadIndices(MV);
  assert.ok(loaded.hnsw.has("mem_legacy"), "legacy record replayed at load");
  const res = addAndSchedule(MV, loaded, 1);
  assert.equal(res.flushed, false, "batch=1000: not auto-flushed");
  assert.equal(flushIndicesNow(MV), true, "flush succeeds");

  assert.equal(existsSync(pendingPathFor(MV)), false, "legacy journal renamed away");
  const migrated = readdirSync(indexDirFor(MV)).filter((f) =>
    /^pending-adds\.jsonl\.migrated-\d+$/.test(f),
  );
  assert.equal(migrated.length, 1, "exactly one .migrated-<epoch-ms> file");
  const kept = readFileSync(join(indexDirFor(MV), migrated[0]), "utf8");
  assert.ok(kept.includes("mem_legacy"), "migrated file still holds the data (never unlinked)");

  // The saved base holds base + legacy + scheduled adds.
  _resetCaches();
  const reloaded = loadIndices(MV);
  assert.ok(reloaded.hnsw.has("mem_legacy"));
  assert.ok(reloaded.hnsw.has("mem_1"));
  assert.equal(reloaded.bm25.search("vintagetoken", 5)[0].memory_id, "mem_legacy");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// API preservation: saveIndices keeps its exact signature/behavior.
// ---------------------------------------------------------------------------
await test("saveIndices export is preserved with its current signature", () => {
  _resetCaches();
  const MV = "w2-test-api";
  const { bm25, hnsw } = freshIndices(MV);
  bm25.add(bm25EntryFor(0));
  hnsw.add("mem_0", unitVec(0));
  assert.equal(typeof saveIndices, "function");
  saveIndices(MV, { bm25, hnsw }); // direct call still persists immediately
  assert.ok(existsSync(join(MEMORY_ROOT, "indices", MV, "bm25.json")));
  assert.ok(existsSync(join(MEMORY_ROOT, "indices", MV, "hnsw.bin")));
  assert.throws(() => saveIndices(MV, {}), TypeError);
  _resetCaches();
});
