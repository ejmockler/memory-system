// index-wal.test.mjs — S2 single-writer lease + sequenced WAL for index
// mutations.
//
// T1 is the RED-FIRST multi-process lost-update reproduction, expressed only
// through the public index-cache.js API so it is valid pre- and post-fix:
// process B's fsync'd journal append is erased by process A's flush
// (truncate-on-flush, index-cache.js pre-S2 :425-433).
//
// RED-FIRST EVIDENCE — verbatim failing run against the UNMODIFIED pre-S2
// index-cache.js (2026-07-12, branch memperf, before index-wal.js existed):
//
//   ✖ T1 lost update: a child process's unflushed journal append survives the parent's flush (71.514125ms)
//   ✔ ledgers/memory.jsonl was never created by this suite (0.135375ms)
//   ...
//   test at test/recall/index-wal.test.mjs:178:7
//   ✖ T1 lost update: a child process's unflushed journal append survives the parent's flush (71.514125ms)
//     AssertionError [ERR_ASSERTION]: fact_B (child's unflushed append) present in hnsw after parent flush
//         at TestContext.<anonymous> (file:///<checkout>/mcp/test/recall/index-wal.test.mjs:211:10)
//         at Test.runInAsyncScope (node:async_hooks:227:14)
//         at Test.run (node:internal/test_runner/test:1201:25)
//         at Test.start (node:internal/test_runner/test:1096:17)
//         at startSubtestAfterBootstrap (node:internal/test_runner/harness:385:17)
//         at async file:///<checkout>/mcp/test/recall/index-wal.test.mjs:178:1 {
//       generatedMessage: false,
//       code: 'ERR_ASSERTION',
//       actual: false,
//       expected: true,
//       operator: '==',
//       diff: 'simple'
//     }
//
// The same test is green post-fix (WAL + applied-cursor retirement).
//
// Discipline (matches test/index-save-debounce.test.mjs):
//   - mkdtempSync rooted in tmpdir; MEMORY_ROOT + POLICY_BASE_DIR +
//     STORAGE_BASE_DIR + LEDGERS_BASE_DIR overwritten BEFORE any dynamic
//     import. Live indices / live ledger are NEVER touched.
//   - fixtures only; a final assertion pins that ledgers/memory.jsonl was
//     never created inside the temp tree.
//   - small synthetic dims=8 unit vectors; per-test model versions.
//   - node:test + node:assert/strict; _resetCaches() between tests.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Hermeticity: stake tmp dirs + overwrite env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-index-wal-"));
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

// Dynamic import AFTER env override.
const {
  loadIndices,
  saveIndices,
  scheduleSaveIndices,
  flushIndicesNow,
  _resetCaches,
} = await import("../../lib/recall/index-cache.js");
const {
  WAL_FILE,
  WAL_CURSOR_FILE,
  WAL_LEASE_FILE,
  appendWalRecord,
  readWalTail,
  readAppliedCursor,
  advanceAppliedCursor,
  compactWal,
  readWalQuarantineNotes,
} = await import("../../lib/recall/index-wal.js");
const { HnswIndex } = await import("../../lib/recall/hnsw-index.js");
const { Bm25Index } = await import("../../lib/recall/bm25-index.js");

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
const DIMS = 8;
const INDEX_CACHE_URL = pathToFileURL(
  join(import.meta.dirname, "..", "..", "lib", "recall", "index-cache.js"),
).href;

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
    ts: "2026-07-12T00:00:00Z",
    entities: [],
    valence: null,
    consent_basis: "first_party",
  };
}

function walRecordFor(id, token, seed) {
  return {
    fact_id: id,
    // REG (memperf) — a FRESH record ts, like the ones scheduleSaveIndices
    // actually appends. The old fixed 4-day-old ts predated the W3
    // cross-process staleness seed (_walHeadTsMs); with the seed live it
    // made the first schedule call fire an implicit (correctly refused)
    // staleness flush that consumed the "first corrupt sighting refuses"
    // step T5/T10b/T15 pin explicitly. The bm25_entry ts stays fixed — it is
    // content metadata, never read by the staleness math.
    ts: new Date().toISOString(),
    bm25_entry: bm25EntryFor(id, token),
    vector: unitVec(seed),
  };
}

// Seed a dims=8 base generation on disk so loadIndices() serves dims=8
// indices that accept the test vectors (public API end to end).
function seedBase(modelVersion, seed = 0) {
  const bm25 = new Bm25Index();
  const hnsw = new HnswIndex({
    dims: DIMS,
    embedding_model_version: modelVersion,
    maxElements: 1024,
  });
  const entry = bm25EntryFor(`mem_base_${seed}`, `basetoken${seed}`);
  bm25.add(entry);
  hnsw.add(entry.memory_id, unitVec(seed));
  saveIndices(modelVersion, { bm25, hnsw });
  _resetCaches();
}

// Add to the in-memory indices AND schedule the debounced persist — mirrors
// updateIndicesForFact's exact sequence in distill-promote-fact.js.
function addAndSchedule(modelVersion, { bm25, hnsw }, id, token, seed) {
  const entry = bm25EntryFor(id, token);
  const vector = unitVec(seed);
  bm25.add(entry);
  hnsw.add(id, vector);
  return scheduleSaveIndices(
    modelVersion,
    { bm25, hnsw },
    { factId: id, bm25Entry: entry, vector },
  );
}

// Child process: loadIndices -> add ONE fact -> scheduleSaveIndices -> exit
// WITHOUT flushing. Only its fsync'd journal/WAL append survives the exit.
// Public API only, same env/tmp tree as the parent.
const CHILD_SCRIPT = join(TMP_ROOT, "child-append.mjs");
writeFileSync(
  CHILD_SCRIPT,
  `
const [, , mv, factId, token, seedStr] = process.argv;
const seed = Number(seedStr);
const DIMS = ${DIMS};
function unitVec(s) {
  const v = [];
  let x = (s + 1) * 2654435761;
  for (let i = 0; i < DIMS; i++) {
    x = (x * 1103515245 + 12345) % 2147483647;
    v.push((x % 1000) / 1000 + 0.01);
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  return v.map((a) => a / norm);
}
const { loadIndices, scheduleSaveIndices } = await import(${JSON.stringify(INDEX_CACHE_URL)});
const { bm25, hnsw } = loadIndices(mv);
const entry = {
  memory_id: factId,
  kind: "fact",
  content: "synthetic fact " + factId + " " + token,
  ts: "2026-07-12T00:00:01Z",
  entities: [],
  valence: null,
  consent_basis: "first_party",
};
const vector = unitVec(seed);
bm25.add(entry);
hnsw.add(factId, vector);
const res = scheduleSaveIndices(mv, { bm25, hnsw }, { factId, bm25Entry: entry, vector });
if (res.flushed) {
  console.error("child: unexpected auto-flush");
  process.exit(2);
}
process.exit(0);
`,
  { mode: 0o600 },
);

function runChildAppend(modelVersion, factId, token, seed) {
  const res = spawnSync(
    process.execPath,
    [CHILD_SCRIPT, modelVersion, factId, token, String(seed)],
    { env: { ...process.env }, encoding: "utf8" },
  );
  assert.equal(
    res.status,
    0,
    `child append exited 0 (stderr: ${res.stderr})`,
  );
}

// Child process variant for T8: loadIndices -> add ONE fact ->
// scheduleSaveIndices -> flushIndicesNow -> exit. Unlike CHILD_SCRIPT this
// child FLUSHES, so it persists a new base generation and retires+compacts
// the WAL before the parent's own flush runs. Public API only, same env/tmp.
const CHILD_FLUSH_SCRIPT = join(TMP_ROOT, "child-append-flush.mjs");
writeFileSync(
  CHILD_FLUSH_SCRIPT,
  `
const [, , mv, factId, token, seedStr] = process.argv;
const seed = Number(seedStr);
const DIMS = ${DIMS};
function unitVec(s) {
  const v = [];
  let x = (s + 1) * 2654435761;
  for (let i = 0; i < DIMS; i++) {
    x = (x * 1103515245 + 12345) % 2147483647;
    v.push((x % 1000) / 1000 + 0.01);
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  return v.map((a) => a / norm);
}
const { loadIndices, scheduleSaveIndices, flushIndicesNow } = await import(${JSON.stringify(INDEX_CACHE_URL)});
const { bm25, hnsw } = loadIndices(mv);
const entry = {
  memory_id: factId,
  kind: "fact",
  content: "synthetic fact " + factId + " " + token,
  ts: "2026-07-12T00:00:01Z",
  entities: [],
  valence: null,
  consent_basis: "first_party",
};
const vector = unitVec(seed);
bm25.add(entry);
hnsw.add(factId, vector);
scheduleSaveIndices(mv, { bm25, hnsw }, { factId, bm25Entry: entry, vector });
if (!flushIndicesNow(mv)) {
  console.error("child: flush failed");
  process.exit(2);
}
process.exit(0);
`,
  { mode: 0o600 },
);

function runChildAppendAndFlush(modelVersion, factId, token, seed) {
  const res = spawnSync(
    process.execPath,
    [CHILD_FLUSH_SCRIPT, modelVersion, factId, token, String(seed)],
    { env: { ...process.env }, encoding: "utf8" },
  );
  assert.equal(
    res.status,
    0,
    `child append+flush exited 0 (stderr: ${res.stderr})`,
  );
}

// Child process variant for T15 (S2y cross-process strike): loadIndices ->
// add ONE fact -> scheduleSaveIndices -> attempt EXACTLY ONE flush -> report
// {flushed} as JSON on stdout -> exit 0 regardless of the flush outcome
// (a refused flush is a legitimate outcome under test, not a child failure).
const CHILD_ONE_FLUSH_SCRIPT = join(TMP_ROOT, "child-one-flush.mjs");
writeFileSync(
  CHILD_ONE_FLUSH_SCRIPT,
  `
const [, , mv, factId, token, seedStr] = process.argv;
const seed = Number(seedStr);
const DIMS = ${DIMS};
function unitVec(s) {
  const v = [];
  let x = (s + 1) * 2654435761;
  for (let i = 0; i < DIMS; i++) {
    x = (x * 1103515245 + 12345) % 2147483647;
    v.push((x % 1000) / 1000 + 0.01);
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  return v.map((a) => a / norm);
}
const { loadIndices, scheduleSaveIndices, flushIndicesNow } = await import(${JSON.stringify(INDEX_CACHE_URL)});
const { bm25, hnsw } = loadIndices(mv);
const entry = {
  memory_id: factId,
  kind: "fact",
  content: "synthetic fact " + factId + " " + token,
  ts: "2026-07-12T00:00:01Z",
  entities: [],
  valence: null,
  consent_basis: "first_party",
};
const vector = unitVec(seed);
bm25.add(entry);
hnsw.add(factId, vector);
scheduleSaveIndices(mv, { bm25, hnsw }, { factId, bm25Entry: entry, vector });
const flushed = flushIndicesNow(mv);
console.log(JSON.stringify({ flushed }));
process.exit(0);
`,
  { mode: 0o600 },
);

function runChildOneFlush(modelVersion, factId, token, seed) {
  const res = spawnSync(
    process.execPath,
    [CHILD_ONE_FLUSH_SCRIPT, modelVersion, factId, token, String(seed)],
    { env: { ...process.env }, encoding: "utf8" },
  );
  assert.equal(
    res.status,
    0,
    `child one-flush exited 0 (stderr: ${res.stderr})`,
  );
  const line = res.stdout.trim().split("\n").pop();
  return JSON.parse(line);
}

// ---------------------------------------------------------------------------
// (T1) RED-FIRST: multi-process lost update. Parent schedules fact_A, child
// process schedules fact_B and exits unflushed, parent flushes. BOTH facts
// must survive into the next cold load.
// ---------------------------------------------------------------------------
await test("T1 lost update: a child process's unflushed journal append survives the parent's flush", () => {
  _resetCaches();
  const MV = "s2-t1-lost-update";
  seedBase(MV, 0);

  // Parent: load, add fact_A in memory, schedule (no flush yet).
  const { bm25, hnsw } = loadIndices(MV);
  const entryA = bm25EntryFor("mem_fact_A", "alphaglyph");
  const vecA = unitVec(11);
  bm25.add(entryA);
  hnsw.add("mem_fact_A", vecA);
  const rA = scheduleSaveIndices(
    MV,
    { bm25, hnsw },
    { factId: "mem_fact_A", bm25Entry: entryA, vector: vecA },
  );
  assert.equal(rA.flushed, false, "batch=1000: parent add not auto-flushed");

  // Child: a REAL separate node process appends fact_B and exits without
  // flushing. Its fsync'd append is the only trace of fact_B.
  runChildAppend(MV, "mem_fact_B", "betaglyph", 12);

  // Parent flushes its debounced batch.
  assert.equal(flushIndicesNow(MV), true, "parent flush succeeds");

  // Cold load: BOTH facts must be present.
  _resetCaches();
  const loaded = loadIndices(MV);
  assert.ok(loaded.hnsw.has("mem_fact_A"), "fact_A present in hnsw");
  const bA = loaded.bm25.search("alphaglyph", 5);
  assert.equal(bA.length, 1, "fact_A present in bm25");
  assert.equal(bA[0].memory_id, "mem_fact_A");

  assert.ok(
    loaded.hnsw.has("mem_fact_B"),
    "fact_B (child's unflushed append) present in hnsw after parent flush",
  );
  const bB = loaded.bm25.search("betaglyph", 5);
  assert.equal(bB.length, 1, "fact_B present in bm25");
  assert.equal(bB[0].memory_id, "mem_fact_B");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T2) crash between saveIndices and cursor advance: the already-applied
// record is re-replayed on the next cold load — idempotent, present exactly
// once, no throw.
// ---------------------------------------------------------------------------
await test("T2 crash between save and retire: re-replay is idempotent", () => {
  _resetCaches();
  const MV = "s2-t2-crash-window";
  seedBase(MV, 0);
  const dir = dirFor(MV);

  // Append one record, replay it into memory, persist the base — but do NOT
  // advance the cursor (the simulated crash window).
  appendWalRecord(dir, walRecordFor("mem_t2", "gammaglyph", 21));
  const { bm25, hnsw } = loadIndices(MV); // fresh load replays the WAL record
  assert.ok(hnsw.has("mem_t2"), "record replayed into the loaded indices");
  saveIndices(MV, { bm25, hnsw }); // base now contains mem_t2; cursor still {0,0}
  assert.equal(readAppliedCursor(dir).applied_seq, 0, "cursor NOT advanced");

  // Next cold load re-replays the already-applied record.
  _resetCaches();
  const loaded = loadIndices(MV);
  assert.ok(loaded.hnsw.has("mem_t2"));
  assert.equal(loaded.hnsw.size(), 2, "base + mem_t2, exactly once (no double-add)");
  assert.equal(loaded.bm25.size(), 2);
  const hits = loaded.bm25.search("gammaglyph", 5);
  assert.equal(hits.length, 1, "bm25 holds mem_t2 exactly once");

  // And a second cold replay is still a no-op (hnsw.add throws on true dupes).
  _resetCaches();
  const again = loadIndices(MV);
  assert.equal(again.hnsw.size(), 2, "second re-replay is a no-op");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T3) lease contention with a LIVE holder: flush is denied, index files are
// not rewritten, WAL bytes and cursor are untouched.
// ---------------------------------------------------------------------------
await test("T3 live-holder lease contention: flush denied, WAL and cursor untouched", () => {
  _resetCaches();
  const MV = "s2-t3-lease-live";
  seedBase(MV, 0);
  const dir = dirFor(MV);
  const walPath = join(dir, WAL_FILE);
  const leasePath = join(dir, WAL_LEASE_FILE);

  const { bm25, hnsw } = loadIndices(MV);
  addAndSchedule(MV, { bm25, hnsw }, "mem_t3", "deltaglyph", 31);

  const walBefore = readFileSync(walPath);
  const cursorBefore = readAppliedCursor(dir);
  const bm25Before = statSync(join(dir, "bm25.json"));
  const hnswBefore = statSync(join(dir, "hnsw.bin"));

  // Another process holds the flush lease: LIVE pid, fresh mtime.
  writeFileSync(
    leasePath,
    JSON.stringify({ pid: process.pid, heartbeat_ts: new Date().toISOString() }),
    { mode: 0o600 },
  );
  try {
    assert.equal(flushIndicesNow(MV), false, "flush denied under contention");

    const walAfter = readFileSync(walPath);
    assert.ok(walBefore.equals(walAfter), "WAL byte-identical after denied flush");
    const cursorAfter = readAppliedCursor(dir);
    assert.equal(cursorAfter.applied_seq, cursorBefore.applied_seq, "cursor seq unchanged");
    assert.equal(cursorAfter.applied_offset, cursorBefore.applied_offset, "cursor offset unchanged");
    const bm25After = statSync(join(dir, "bm25.json"));
    const hnswAfter = statSync(join(dir, "hnsw.bin"));
    assert.equal(bm25After.mtimeMs, bm25Before.mtimeMs, "bm25.json not rewritten");
    assert.equal(bm25After.size, bm25Before.size);
    assert.equal(hnswAfter.mtimeMs, hnswBefore.mtimeMs, "hnsw.bin not rewritten");
    assert.equal(hnswAfter.size, hnswBefore.size);
    assert.ok(existsSync(leasePath), "the holder's lease file was not stolen");
  } finally {
    unlinkSync(leasePath);
  }
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T4) stale-lease takeover: dead pid + mtime aged past ttl -> the flush
// reclaims the lease, succeeds, and releases it.
// ---------------------------------------------------------------------------
await test("T4 stale-lease takeover: dead pid + aged mtime -> flush succeeds", () => {
  _resetCaches();
  const MV = "s2-t4-lease-stale";
  seedBase(MV, 0);
  const dir = dirFor(MV);
  const leasePath = join(dir, WAL_LEASE_FILE);

  const { bm25, hnsw } = loadIndices(MV);
  addAndSchedule(MV, { bm25, hnsw }, "mem_t4", "epsilonglyph", 41);

  // A DEAD pid: spawn a real node process that exits immediately.
  const deadProc = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(deadProc.status, 0);
  const deadPid = deadProc.pid;
  assert.ok(Number.isInteger(deadPid) && deadPid > 0);

  writeFileSync(
    leasePath,
    JSON.stringify({ pid: deadPid, heartbeat_ts: new Date().toISOString() }),
    { mode: 0o600 },
  );
  // Age the lock past the STALE_LOCK_RECOVERY_SECONDS=60 ttl.
  const past = new Date(Date.now() - 120 * 1000);
  utimesSync(leasePath, past, past);

  assert.equal(flushIndicesNow(MV), true, "stale takeover: flush succeeds");
  assert.equal(existsSync(leasePath), false, "lease re-owned then RELEASED");
  assert.equal(readAppliedCursor(dir).applied_seq, 1, "record retired");

  _resetCaches();
  const loaded = loadIndices(MV);
  assert.ok(loaded.hnsw.has("mem_t4"), "flushed fact persisted");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T5) crc-corrupt record: fail-closed. Only the prefix before the corrupt
// record is delivered/applied; the cursor never advances past it.
// ---------------------------------------------------------------------------
await test("T5 crc corruption fails closed: prefix-only delivery, no retire past it", () => {
  _resetCaches();
  const MV = "s2-t5-crc";
  seedBase(MV, 0);
  const dir = dirFor(MV);
  const walPath = join(dir, WAL_FILE);

  appendWalRecord(dir, walRecordFor("mem_r1", "zetaglyph", 51));
  appendWalRecord(dir, walRecordFor("mem_r2", "etaglyph", 52));
  appendWalRecord(dir, walRecordFor("mem_r3", "thetaglyph", 53));

  // Flip bytes INSIDE record 2's rec payload (framing intact, crc now wrong).
  const lines = readFileSync(walPath, "utf8").split("\n");
  assert.ok(lines[1].includes("etaglyph"));
  lines[1] = lines[1].replace("etaglyph", "XXXglyph");
  writeFileSync(walPath, lines.join("\n"), { mode: 0o600 });

  // readWalTail delivers ONLY record 1 and sets error.
  const seen = [];
  const r = readWalTail(dir, { afterSeq: 0, fromOffset: 0 }, (rec) =>
    seen.push(rec.fact_id),
  );
  assert.deepEqual(seen, ["mem_r1"], "nothing at/after the corrupt record is delivered");
  assert.ok(r.error != null && /crc mismatch/.test(r.error), `error set (${r.error})`);
  assert.equal(r.lastSeq, 1, "lastSeq stops at the last GOOD record");

  // loadIndices applies only record 1.
  _resetCaches();
  const loaded = loadIndices(MV);
  assert.ok(loaded.hnsw.has("mem_r1"), "record before the corruption applied");
  assert.equal(loaded.hnsw.has("mem_r2"), false, "corrupt record not applied");
  assert.equal(loaded.hnsw.has("mem_r3"), false, "record after the corruption not applied");

  // A flush attempt must refuse to advance the cursor past record 1.
  addAndSchedule(MV, loaded, "mem_t5d", "iotaglyph", 54); // appends seq 4 (tail record is intact)
  assert.equal(flushIndicesNow(MV), false, "flush refuses on WAL corruption");
  const cursor = readAppliedCursor(dir);
  assert.ok(cursor.applied_seq <= 1, `cursor never past the corruption (got ${cursor.applied_seq})`);
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T6) warm-hit cross-process visibility: a fingerprint-identical warm
// loadIndices returns records appended by ANOTHER process.
// ---------------------------------------------------------------------------
await test("T6 warm hit sees another process's WAL append", () => {
  _resetCaches();
  const MV = "s2-t6-warm";
  seedBase(MV, 0);

  // Parent: fresh load — the cache entry (with its WAL marker) is now warm.
  const first = loadIndices(MV);
  assert.equal(first.hnsw.has("mem_fact_C"), false);

  // Child process appends fact_C via the public API and exits unflushed.
  // bm25.json/hnsw.bin are untouched, so the parent's fingerprint still hits.
  runChildAppend(MV, "mem_fact_C", "kappaglyph", 61);

  // Parent warm hit: must absorb the child's WAL tail.
  const warm = loadIndices(MV);
  assert.equal(warm.bm25, first.bm25, "fingerprint-identical warm hit (same cached objects)");
  assert.ok(warm.hnsw.has("mem_fact_C"), "warm hit sees the child's append");
  const hits = warm.bm25.search("kappaglyph", 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].memory_id, "mem_fact_C");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T7) seq is monotonic across compaction: flush retires + compacts (WAL
// emptied), yet the next append continues the sequence — never resets.
// ---------------------------------------------------------------------------
await test("T7 seq monotonic across compaction; replay from cursor sees only the new record", () => {
  _resetCaches();
  const MV = "s2-t7-seq";
  seedBase(MV, 0);
  const dir = dirFor(MV);
  const walPath = join(dir, WAL_FILE);

  const { bm25, hnsw } = loadIndices(MV);
  addAndSchedule(MV, { bm25, hnsw }, "mem_t7a", "lambdaglyph", 71); // seq 1
  assert.equal(flushIndicesNow(MV), true, "flush succeeds");

  const cursor = readAppliedCursor(dir);
  assert.equal(cursor.applied_seq, 1, "cursor advanced to the flushed record");
  assert.equal(cursor.applied_offset, 0, "compaction rewrote the offset to 0");
  assert.equal(statSync(walPath).size, 0, "WAL compacted to empty");
  assert.ok(existsSync(join(dir, WAL_CURSOR_FILE)));

  // Next append continues the sequence — seq NEVER resets.
  const appended = appendWalRecord(dir, walRecordFor("mem_t7b", "muglyph", 72));
  assert.equal(appended.seq, 2, "seq continues after compaction (no reset)");

  // Replay from the cursor delivers exactly the new record.
  const seen = [];
  const r = readWalTail(
    dir,
    { afterSeq: cursor.applied_seq, fromOffset: cursor.applied_offset },
    (rec, seq) => seen.push(`${seq}:${rec.fact_id}`),
  );
  assert.equal(r.error, null);
  assert.deepEqual(seen, ["2:mem_t7b"], "exactly the post-compaction record");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T8) S2b RED-FIRST: two-flusher stale-base clobber. Parent schedules fact_A
// against the base it loaded; a child process loads (replaying fact_A from
// the WAL), adds fact_B, FLUSHES (new base = base+A+B, WAL retired+compacted)
// and exits; then the parent flushes its own pending batch. Pre-fix the
// parent's lease-serialized save wrote its STALE base (base+A, no B) over the
// child's generation — a last-writer-wins clobber the lease cannot prevent.
//
// RED-FIRST EVIDENCE — verbatim failing run against the pre-S2x
// index-cache.js (2026-07-14, branch memperf, before the stale-base
// fingerprint check landed):
//
//   ✖ T8 two-flusher clobber: parent flush over a child's flushed base keeps BOTH facts (120.404666ms)
//     AssertionError [ERR_ASSERTION]: fact_B (child's flushed base) present in hnsw after parent flush
//       actual: false,
//       expected: true,
//       operator: '==',
//
// (T1-T7 stayed green on the same run.) The same test is green post-fix
// (schedule-time base fingerprints + on-mismatch reload-and-replay).
// ---------------------------------------------------------------------------
await test("T8 two-flusher clobber: parent flush over a child's flushed base keeps BOTH facts", () => {
  _resetCaches();
  const MV = "s2-t8-two-flushers";
  seedBase(MV, 0);

  // Parent: load, add fact_A in memory, schedule (batch=1000: no flush yet).
  const { bm25, hnsw } = loadIndices(MV);
  const entryA = bm25EntryFor("mem_fact_A", "nuglyph");
  const vecA = unitVec(81);
  bm25.add(entryA);
  hnsw.add("mem_fact_A", vecA);
  const rA = scheduleSaveIndices(
    MV,
    { bm25, hnsw },
    { factId: "mem_fact_A", bm25Entry: entryA, vector: vecA },
  );
  assert.equal(rA.flushed, false, "batch=1000: parent add not auto-flushed");

  // Child: a REAL separate node process loads (its fresh load replays fact_A
  // from the WAL), adds fact_B, and FLUSHES — persisting base+A+B, advancing
  // the cursor past both records, and compacting the WAL — then exits.
  runChildAppendAndFlush(MV, "mem_fact_B", "xiglyph", 82);

  // Parent flushes its pending batch over the child's newer base.
  assert.equal(flushIndicesNow(MV), true, "parent flush succeeds");

  // Cold load: BOTH facts must be present.
  _resetCaches();
  const loaded = loadIndices(MV);
  assert.ok(loaded.hnsw.has("mem_fact_A"), "fact_A present in hnsw");
  const bA = loaded.bm25.search("nuglyph", 5);
  assert.equal(bA.length, 1, "fact_A present in bm25");

  assert.ok(
    loaded.hnsw.has("mem_fact_B"),
    "fact_B (child's flushed base) present in hnsw after parent flush",
  );
  const bB = loaded.bm25.search("xiglyph", 5);
  assert.equal(bB.length, 1, "fact_B present in bm25");
  assert.equal(bB[0].memory_id, "mem_fact_B");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T9) S2.1/S2c RED-FIRST: compactWal crash-window offset ABA. compactWal's
// pre-fix order was WAL-swap FIRST, cursor rewrite second; a crash between
// the two leaves an empty WAL under a stale cursor {applied_seq:1,
// applied_offset:S}. If the WAL then regrows to EXACTLY S bytes with
// never-applied records, byte-offset equality aliases "fully applied":
// readWalTail's EOF fast return skips the new record and compactWal
// destroys it.
//
// RED-FIRST EVIDENCE — verbatim failing run against the pre-S2x
// index-wal.js (2026-07-14, branch memperf, before the seq-identity checks
// and the cursor-first compaction order landed):
//
//   ✖ T9a offset ABA: readWalTail delivers a never-applied record despite fromOffset===size (20.398916ms)
//     AssertionError [ERR_ASSERTION]: the never-applied seq-2 record is delivered (offset equality is not identity)
//       actual: [],
//       expected: [ '2:mem_two' ],
//       operator: 'deepStrictEqual',
//
//   ✖ T9b offset ABA: compactWal refuses to destroy a never-applied record (32.528375ms)
//     AssertionError [ERR_ASSERTION]: compaction refused: WAL tail seq != applied_seq
//       actual: true,
//       expected: false,
//       operator: 'strictEqual',
//
// (T1-T7 stayed green on the same run.) Both are green post-fix (backward
// tail-peek seq === applied_seq verification + cursor-first compaction).
// ---------------------------------------------------------------------------
// Rebuild the demonstrated crash window: append+retire seq 1, swap the WAL
// empty with the cursor rewrite "crashed" (stale {1, S}), then regrow the
// WAL to exactly S bytes with a same-byte-length seq-2 record.
function buildCompactionAbaWindow(MV) {
  const dir = dirFor(MV);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const walPath = join(dir, WAL_FILE);

  // Fixed-shape payloads: same-length fact_id, no floats -> identical byte
  // length, so seq 1 and seq 2 lines are the same size (both single-digit
  // seq, crc always 8 hex).
  const a1 = appendWalRecord(dir, { fact_id: "mem_one" });
  assert.equal(a1.seq, 1);
  // Simulate a flush retiring seq 1 (cursor at {1, S}) without compaction.
  const adv = advanceAppliedCursor(dir, {
    applied_seq: 1,
    applied_offset: a1.offset,
  });
  assert.equal(adv.error, null);
  // Simulate the compaction crash window: WAL swapped to empty, cursor
  // rewrite never happened (pre-fix compactWal order).
  writeFileSync(walPath, "", { mode: 0o600 });
  // WAL regrows: a NEVER-APPLIED seq-2 record of the same byte length lands,
  // so the file size returns to exactly the stale applied_offset.
  const a2 = appendWalRecord(dir, { fact_id: "mem_two" });
  assert.equal(a2.seq, 2, "append seeds seq from the cursor after the swap");
  assert.equal(
    statSync(walPath).size,
    a1.offset,
    "fixture: WAL regrew to exactly the stale applied_offset",
  );
  return { dir, walPath, cursor: readAppliedCursor(dir) };
}

await test("T9a offset ABA: readWalTail delivers a never-applied record despite fromOffset===size", () => {
  _resetCaches();
  const { dir, cursor } = buildCompactionAbaWindow("s2-t9a-aba-read");
  assert.equal(cursor.applied_seq, 1);

  const seen = [];
  const r = readWalTail(
    dir,
    { afterSeq: cursor.applied_seq, fromOffset: cursor.applied_offset },
    (rec, seq) => seen.push(`${seq}:${rec.fact_id}`),
  );
  assert.equal(r.error, null);
  assert.deepEqual(
    seen,
    ["2:mem_two"],
    "the never-applied seq-2 record is delivered (offset equality is not identity)",
  );
  assert.equal(r.lastSeq, 2);
  _resetCaches();
});

await test("T9b offset ABA: compactWal refuses to destroy a never-applied record", () => {
  _resetCaches();
  const { walPath } = buildCompactionAbaWindow("s2-t9b-aba-compact");
  const bytesBefore = readFileSync(walPath);
  assert.ok(bytesBefore.includes("mem_two"), "fixture: seq-2 record on disk");

  const c = compactWal(dirFor("s2-t9b-aba-compact"));
  assert.equal(c.compacted, false, "compaction refused: WAL tail seq != applied_seq");
  const bytesAfter = readFileSync(walPath);
  assert.ok(
    bytesAfter.equals(bytesBefore),
    "the never-applied seq-2 record survives (bytes untouched)",
  );
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T10a) S2d: corrupt FINAL record. Pre-S2d appendWalRecord threw on EVERY
// append (seq assignment reads the last record), bricking every promote for
// the model version. Now: the WAL is quarantined (renamed — bytes retained,
// NEVER unlinked), a structured note is logged, and the append proceeds on a
// fresh WAL.
//
// S2y MONOTONIC CONTRACT (supersedes the original S2d "seed from the applied
// cursor" behavior this test used to pin with `a.seq === 1`): the append-path
// quarantine (1) carries the valid unretired prefix (seq > applied_seq,
// before the corruption) forward into the fresh WAL, and (2) reseeds the
// stream PAST every previously-issued seq — the applied cursor advances to
// max(last good seq, corrupt record's framed seq) with offset 0, carried
// records re-append as floor+1.., and the new record continues after them.
// No seq is ever issued to two different facts, so another process's warm
// {walSeq} marker can never silently filter a post-quarantine record.
//
// RED-FIRST EVIDENCE (S2y) — verbatim failing run against the pre-S2y
// index-wal.js (2026-07-15, branch memperf, isolated scratchpad copy —
// RED-RUN ISOLATION; the live tree was never reverted):
//
//   ✖ T10a corrupt FINAL record: append quarantines (rename, never unlink) and proceeds; seq stays monotonic (35.053292ms)
//     AssertionError [ERR_ASSERTION]: append continues past every previously-issued seq (floor 2 + 1 carried record + 1)
//
//     1 !== 4
//
//       actual: 1,
//       expected: 4,
//       operator: 'strictEqual',
//
// RED-FIRST EVIDENCE (S2d, backfilled per the T8/T9 discipline) — verbatim
// failing run against the reconstructed pre-S2d index-wal.js/index-cache.js
// (scanWalTail throwing on an unreadable last record; no quarantine path; no
// warm-hit corruption pin; flush error branch refusing unconditionally),
// 2026-07-15, isolated scratchpad copy:
//
//   ✖ T10a corrupt FINAL record: append quarantines (rename, never unlink) and proceeds; seq stays monotonic (20.788583ms)
//     Error: index-wal: last WAL record unreadable: crc mismatch at seq 2 (recorded 04cf69d9, computed e7a8de0a)
//         at scanWalTail (file:///.../s2y-pre-s2d/mcp/lib/recall/index-wal.js:582:11)
//         at appendWalRecord (file:///.../s2y-pre-s2d/mcp/lib/recall/index-wal.js:618:18)
//         at TestContext.<anonymous> (file:///.../s2y-pre-s2d/mcp/test/recall/index-wal.test.mjs:862:13)
//
// i.e. the append that should recover threw, and kept throwing on every
// retry — every promote for the model version was bricked.
// ---------------------------------------------------------------------------
await test("T10a corrupt FINAL record: append quarantines (rename, never unlink) and proceeds; seq stays monotonic", () => {
  _resetCaches();
  const MV = "s2-t10a-append-quarantine";
  const dir = dirFor(MV);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const walPath = join(dir, WAL_FILE);

  appendWalRecord(dir, walRecordFor("mem_q1", "omicronglyph", 91)); // seq 1
  appendWalRecord(dir, walRecordFor("mem_q2", "piiiglyph", 92)); // seq 2
  // Corrupt the LAST record's payload in place (framing intact, crc wrong).
  const lines = readFileSync(walPath, "utf8").split("\n");
  assert.ok(lines[1].includes("piiiglyph"));
  lines[1] = lines[1].replace("piiiglyph", "pXiiglyph");
  writeFileSync(walPath, lines.join("\n"), { mode: 0o600 });
  const corruptBytes = readFileSync(walPath);

  // The append that pre-S2d threw forever. S2y: seqs 1 and 2 were both
  // issued (seq 2 to the now-corrupt record), so the stream reseeds at
  // floor=2; the carried valid unretired mem_q1 re-appends as seq 3; the
  // new record continues at seq 4. Pre-S2y this reissued seq 1.
  const a = appendWalRecord(dir, walRecordFor("mem_q3", "rhoglyph", 93));
  assert.equal(
    a.seq,
    4,
    "append continues past every previously-issued seq (floor 2 + 1 carried record + 1)",
  );

  const corruptFiles = readdirSync(dir).filter((f) =>
    /^index-wal\.jsonl\.corrupt-\d+$/.test(f),
  );
  assert.equal(corruptFiles.length, 1, "exactly one quarantined WAL");
  const kept = readFileSync(join(dir, corruptFiles[0]));
  assert.ok(
    kept.equals(corruptBytes),
    "quarantined file retains every byte (renamed, never unlinked)",
  );

  // Structured note — the data memory_health surfaces as a health_note.
  const notes = readWalQuarantineNotes(dir);
  assert.equal(notes.events.length, 1, "one structured quarantine event");
  const ev = notes.events[0];
  assert.equal(ev.quarantined_file, corruptFiles[0]);
  assert.equal(ev.applied_seq, 0, "note reports the PRE-quarantine cursor");
  assert.equal(ev.reseed_seq, 2, "note reports the reseeded floor (max issued seq)");
  assert.equal(ev.requeued, 1, "note reports the carried-forward record count");
  assert.match(ev.reason, /crc mismatch/);
  assert.equal(typeof ev.ts, "string");

  // The cursor advanced to the reseed floor (offset 0): nothing above it was
  // lost — the carried record lives ABOVE the floor in the fresh WAL.
  const cursor = readAppliedCursor(dir);
  assert.equal(cursor.applied_seq, 2, "cursor at the reseed floor");
  assert.equal(cursor.applied_offset, 0, "fresh stream starts at offset 0");

  // The active stream is fully operational AND still serves the carried
  // valid unretired record: replay from the cursor (exactly what a cold
  // loadIndices does) delivers mem_q1 (carried, seq 3) then mem_q3 (seq 4).
  const seen = [];
  const r = readWalTail(
    dir,
    { afterSeq: cursor.applied_seq, fromOffset: cursor.applied_offset },
    (rec, seq) => seen.push(`${seq}:${rec.fact_id}`),
  );
  assert.equal(r.error, null);
  assert.deepEqual(
    seen,
    ["3:mem_q1", "4:mem_q3"],
    "carried prefix survives in the ACTIVE stream, new record follows",
  );
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T10b) S2d: PERSISTENT mid-WAL corruption. Pre-S2d: the flush refused
// forever, the WAL grew unboundedly, and — because the strict fast path
// re-hit the corrupt record and fell back — EVERY warm loadIndices paid a
// full-WAL scan. Now: warm cost is pinned to one statSync, and the second
// (persistent) flush attempt persists the valid prefix, retires up to (never
// past) the corruption, and quarantines the WAL.
//
// RED-FIRST EVIDENCE (S2d, backfilled per the T8/T9 discipline) — verbatim
// failing run against the reconstructed pre-S2d index-wal.js/index-cache.js
// (no warm-hit corruption pin; flush error branch refusing unconditionally),
// 2026-07-15, isolated scratchpad copy (RED-RUN ISOLATION; the live tree was
// never reverted):
//
//   ✖ T10b persistent mid-WAL corruption: warm cost bounded, flush quarantines + recovers, bytes retained (8160.763625ms)
//     AssertionError [ERR_ASSERTION]: warm hits must not re-run the corrupt-WAL scan (got 25 tail-error logs)
//
//     25 !== 0
//
//       actual: 25,
//       expected: 0,
//       operator: 'strictEqual',
//
// i.e. all 25 warm hits fell back to a full scan of the corrupt WAL (one
// "WAL tail error" breadcrumb each), and — with the quarantine block also
// removed — the second flush attempt kept refusing forever exactly like the
// first (flush returned false; no .corrupt-* file was ever created).
// ---------------------------------------------------------------------------
await test("T10b persistent mid-WAL corruption: warm cost bounded, flush quarantines + recovers, bytes retained", () => {
  _resetCaches();
  const MV = "s2-t10b-quarantine-recovery";
  seedBase(MV, 0);
  const dir = dirFor(MV);
  const walPath = join(dir, WAL_FILE);

  appendWalRecord(dir, walRecordFor("mem_p1", "sigmaglyph", 101)); // seq 1
  appendWalRecord(dir, walRecordFor("mem_p2", "tauglyph", 102)); // seq 2
  appendWalRecord(dir, walRecordFor("mem_p3", "upsilonglyph", 103)); // seq 3
  // Corrupt record 2 IN THE MIDDLE (framing intact, crc wrong; the last
  // record stays valid so appends are unaffected).
  const lines0 = readFileSync(walPath, "utf8").split("\n");
  assert.ok(lines0[1].includes("tauglyph"));
  lines0[1] = lines0[1].replace("tauglyph", "tXuglyph");
  writeFileSync(walPath, lines0.join("\n"), { mode: 0o600 });

  // Cold load: valid prefix applied, corruption marker pinned.
  const loaded = loadIndices(MV);
  assert.ok(loaded.hnsw.has("mem_p1"), "record before the corruption applied");
  assert.equal(loaded.hnsw.has("mem_p2"), false, "corrupt record not applied");
  assert.equal(loaded.hnsw.has("mem_p3"), false, "record after the corruption not applied");

  // 1000 subsequent appends keep growing the WAL past the corruption.
  for (let i = 0; i < 1000; i++) {
    appendWalRecord(dir, { fact_id: `mem_bulk_${i}` });
  }

  // DEGRADATION CAP: warm hits must not re-scan the corrupt WAL per request.
  // The tail-error breadcrumb is the observable: without the inode pin every
  // warm hit fell back to a full scan and logged it (25 logs here); with the
  // pin the absorb is skipped for the cost of the statSync alone.
  const realErr = console.error;
  let tailErrorLogs = 0;
  console.error = (...args) => {
    if (String(args[0]).includes("WAL tail error")) tailErrorLogs += 1;
    return realErr.apply(console, args);
  };
  let warmStart;
  try {
    warmStart = process.hrtime.bigint();
    for (let i = 0; i < 25; i++) {
      const warm = loadIndices(MV);
      assert.equal(warm.bm25, loaded.bm25, "warm hit (same cached objects)");
    }
  } finally {
    console.error = realErr;
  }
  const warmMs = Number(process.hrtime.bigint() - warmStart) / 1e6;
  assert.equal(
    tailErrorLogs,
    0,
    `warm hits must not re-run the corrupt-WAL scan (got ${tailErrorLogs} tail-error logs)`,
  );
  assert.ok(warmMs < 1000, `25 warm hits stay cheap (${warmMs.toFixed(1)}ms)`);

  // Flush: attempt 1 refuses (fail-closed on a possibly-transient error);
  // attempt 2 — persistent — quarantines and succeeds.
  addAndSchedule(MV, loaded, "mem_sched", "omegaglyph", 104);
  const walBytesPreQuarantine = readFileSync(walPath);
  assert.equal(flushIndicesNow(MV), false, "first corrupt flush refuses (fail-closed)");
  assert.ok(
    readFileSync(walPath).equals(walBytesPreQuarantine),
    "WAL untouched by the refused flush",
  );
  // REG (memperf, W3 followup) — P9-style telemetry assertion on the
  // quarantine path: the recovery IS a full save, so it must emit exactly
  // ONE structured index_full_save stderr line with trigger "quarantine"
  // (pre-REG this was the one flush path with no telemetry line — FINAL's
  // writes/day table undercounted every corruption recovery).
  const quarantineFlushLogs = [];
  const realErrQ = console.error;
  console.error = (...args) => {
    quarantineFlushLogs.push(args.map(String).join(" "));
    return realErrQ.apply(console, args);
  };
  let quarantineFlushed;
  try {
    quarantineFlushed = flushIndicesNow(MV);
  } finally {
    console.error = realErrQ;
  }
  assert.equal(
    quarantineFlushed,
    true,
    "persistent corruption: flush persists the valid prefix and quarantines",
  );
  const quarantineSaveEvents = quarantineFlushLogs
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((j) => j != null && j.event === "index_full_save");
  assert.equal(
    quarantineSaveEvents.length,
    1,
    "exactly one index_full_save line for the quarantine recovery",
  );
  assert.equal(quarantineSaveEvents[0].model_version, MV);
  assert.equal(
    quarantineSaveEvents[0].trigger,
    "quarantine",
    "the quarantine recovery reports its own trigger",
  );
  assert.equal(
    quarantineSaveEvents[0].wal_records_retired,
    1,
    "retired up to the last GOOD record (seq 1), never past the corruption",
  );

  const corruptFiles = readdirSync(dir).filter((f) =>
    /^index-wal\.jsonl\.corrupt-\d+$/.test(f),
  );
  assert.equal(corruptFiles.length, 1, "WAL quarantined");
  const kept = readFileSync(join(dir, corruptFiles[0]));
  assert.ok(
    kept.equals(walBytesPreQuarantine),
    "quarantined file retains ALL bytes (the 1000 appends included; never unlinked)",
  );
  const cursor = readAppliedCursor(dir);
  assert.equal(cursor.applied_seq, 1, "retired up to the last GOOD record, never past the corruption");
  assert.equal(cursor.applied_offset, 0, "active stream reset from the applied cursor");
  assert.equal(readWalQuarantineNotes(dir).events.length, 1, "structured quarantine note emitted");

  // Recovery: the valid prefix AND the scheduled add were persisted...
  _resetCaches();
  const reloaded = loadIndices(MV);
  assert.ok(reloaded.hnsw.has("mem_p1"), "valid prefix persisted by the quarantine flush");
  assert.ok(reloaded.hnsw.has("mem_sched"), "scheduled add persisted (in memory + saved base)");
  // ...and the flush pipeline is fully operational again.
  addAndSchedule(MV, reloaded, "mem_after", "alefglyph", 105);
  assert.equal(flushIndicesNow(MV), true, "flush recovers after quarantine");
  _resetCaches();
  assert.ok(loadIndices(MV).hnsw.has("mem_after"), "post-quarantine flush persists normally");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T11) mid-save append window, BEHAVIORAL pin. Acceptance #2 of S2 ("cursor
// captured BEFORE the save so mid-save appends survive unretired") was
// previously proven only by source order in index-cache.js; this test fails
// if a refactor moves the readWalTail capture after saveIndices. A spied
// hnsw.save appends fact_D DURING saveIndices (simulating another process's
// promote landing mid-persist).
// ---------------------------------------------------------------------------
await test("T11 mid-save append: cursor stays at the pre-save capture; fact_D survives unretired", () => {
  _resetCaches();
  const MV = "s2-t11-mid-save";
  seedBase(MV, 0);
  const dir = dirFor(MV);
  const walPath = join(dir, WAL_FILE);

  const { bm25, hnsw } = loadIndices(MV);
  addAndSchedule(MV, { bm25, hnsw }, "mem_fact_C", "chiglyph", 111); // seq 1
  const preSaveSize = statSync(walPath).size;

  // Spy: DURING saveIndices (inside hnsw.save), append fact_D to the WAL.
  const proto = Object.getPrototypeOf(hnsw);
  let midSaveAppend = null;
  hnsw.save = function (path) {
    midSaveAppend = appendWalRecord(dir, walRecordFor("mem_fact_D", "psiglyph", 112));
    return proto.save.call(this, path);
  };
  try {
    assert.equal(flushIndicesNow(MV), true, "flush succeeds despite the mid-save append");
  } finally {
    delete hnsw.save;
  }
  assert.ok(midSaveAppend != null, "spy ran during saveIndices");
  assert.equal(midSaveAppend.seq, 2, "fact_D appended mid-save as seq 2");

  // Cursor is exactly the PRE-SAVE captured position: fact_D NOT retired.
  const cursor = readAppliedCursor(dir);
  assert.equal(cursor.applied_seq, 1, "cursor at the pre-save capture (fact_D unretired)");
  assert.equal(cursor.applied_offset, preSaveSize, "cursor offset equals the pre-save WAL size");
  // Compaction was skipped: the WAL kept its unretired tail.
  assert.ok(statSync(walPath).size > preSaveSize, "compaction skipped (WAL non-empty)");

  // fact_D is still owed to the next flush...
  const seen = [];
  const r = readWalTail(
    dir,
    { afterSeq: cursor.applied_seq, fromOffset: cursor.applied_offset },
    (rec, seq) => seen.push(`${seq}:${rec.fact_id}`),
  );
  assert.equal(r.error, null);
  assert.deepEqual(seen, ["2:mem_fact_D"], "exactly fact_D unretired");

  // ...and a cold load serves it (base holds fact_C; WAL replay adds fact_D).
  _resetCaches();
  const loaded = loadIndices(MV);
  assert.ok(loaded.hnsw.has("mem_fact_C"), "flushed fact_C in the saved base");
  assert.ok(loaded.hnsw.has("mem_fact_D"), "cold load contains the mid-save append");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T12) S2d: memory_health surfaces the quarantine as a structured
// health_note (not stderr-only). Runs after T10a/T10b left quarantine logs
// under this suite's hermetic indices tree.
// ---------------------------------------------------------------------------
await test("T12 memory_health surfaces index_wal_quarantined as a health_note", async () => {
  const { buildHealthData } = await import("../../lib/tools/health.js");
  const data = await buildHealthData({
    sourcesDir: join(MEMORY_ROOT, "storage", "sources"),
    memoryLedgerPath: join(MEMORY_ROOT, "ledgers", "memory.jsonl"),
    recallLogPath: join(MEMORY_ROOT, "ledgers", "recall.jsonl"),
    indicesDir: join(MEMORY_ROOT, "indices"),
  });
  assert.ok(Array.isArray(data.health_notes), "health_notes is an array");
  const notes = data.health_notes.filter((n) =>
    n.startsWith("index_wal_quarantined: "),
  );
  assert.ok(notes.length >= 1, "quarantine surfaced in health_notes");
  const mine = notes.find((n) => n.includes("s2-t10a-append-quarantine"));
  assert.ok(mine != null, "note names the quarantined model version");
  assert.match(
    mine,
    /file=index-wal\.jsonl\.corrupt-\d+ applied_seq=0 ts=\S+ reason=/,
    "note carries the structured event fields",
  );
});

// ---------------------------------------------------------------------------
// (T13) S2y RED-FIRST: warm-absorb marker offset ABA. _absorbWalTail's
// unchanged-WAL early return trusted `size === entry.walOffset` with no
// identity verification — the exact byte-offset-equality-is-not-identity
// class S2c closed for the ON-DISK cursor (T9a/T9b), left open for the
// IN-MEMORY warm marker. Another process's flush+compaction swaps the WAL
// (new inode, size 0); if the WAL then regrows to EXACTLY the cached
// walOffset, a warm hit early-returns and silently misses the never-applied
// records until the next size change. Fix: the early return is taken only
// when the WAL inode matches the entry's last-seen inode (the walCorruptIno
// pin already proved inode identity works — compaction/quarantine always
// swap inodes); on mismatch the marker re-bootstraps from the applied
// cursor.
//
// RED-FIRST EVIDENCE — verbatim failing run against the pre-S2y
// index-cache.js (2026-07-15, branch memperf, isolated scratchpad copy —
// RED-RUN ISOLATION; the live tree was never reverted):
//
//   ✖ T13 warm-absorb ABA: cross-process compaction + regrowth to the exact cached walOffset is absorbed (61.702458ms)
//     AssertionError [ERR_ASSERTION]: warm hit absorbs the never-applied seq-2 record (offset equality is not identity)
//       actual: false,
//       expected: true,
//       operator: '==',
// ---------------------------------------------------------------------------
await test("T13 warm-absorb ABA: cross-process compaction + regrowth to the exact cached walOffset is absorbed", () => {
  _resetCaches();
  const MV = "s2y-t13-warm-aba";
  seedBase(MV, 0);
  const dir = dirFor(MV);
  const walPath = join(dir, WAL_FILE);

  // Cold load, then a fixed-shape append: SAME id length, SAME token length,
  // SAME seed (identical vector bytes) as the regrown record below, so both
  // WAL lines have identical byte length (seq 1 vs 2: same digit count).
  const cold = loadIndices(MV);
  const a1 = appendWalRecord(dir, walRecordFor("mem_aa1", "tokaglyph", 7)); // seq 1
  const warm1 = loadIndices(MV);
  assert.equal(warm1.bm25, cold.bm25, "warm hit (same cached objects)");
  assert.ok(warm1.hnsw.has("mem_aa1"), "warm marker advanced to {1, S}");

  // ANOTHER PROCESS's flush+compaction: retire seq 1, then compactWal swaps
  // in an empty WAL (NEW inode) under cursor {1, 0}.
  const adv = advanceAppliedCursor(dir, { applied_seq: 1, applied_offset: a1.offset });
  assert.equal(adv.error, null);
  const c = compactWal(dir);
  assert.equal(c.compacted, true, "fixture: compaction swapped the WAL");
  assert.equal(statSync(walPath).size, 0, "fixture: WAL emptied");

  // The WAL regrows to EXACTLY the cached walOffset with a never-applied
  // seq-2 record.
  const a2 = appendWalRecord(dir, walRecordFor("mem_aa2", "tokbglyph", 7)); // seq 2
  assert.equal(a2.seq, 2, "regrown record continues the sequence");
  assert.equal(
    statSync(walPath).size,
    a1.offset,
    "fixture: WAL regrew to exactly the cached walOffset",
  );

  // Warm hit: member files untouched, so the fingerprints still match; the
  // marker says {walSeq:1, walOffset:S} and the file size is S again. The
  // never-applied seq-2 record MUST still be served.
  const warm2 = loadIndices(MV);
  assert.equal(warm2.bm25, cold.bm25, "still the warm cached objects");
  assert.ok(
    warm2.hnsw.has("mem_aa2"),
    "warm hit absorbs the never-applied seq-2 record (offset equality is not identity)",
  );
  const hits = warm2.bm25.search("tokbglyph", 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].memory_id, "mem_aa2");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T14) S2y RED-FIRST: append-path quarantine must carry the valid unretired
// prefix forward and never reissue a seq. Process A appends fact_X (valid,
// unretired, cursor {0,0}) and exits without flushing; the WAL's FINAL
// record is then corrupted in place; the next appendWalRecord triggers the
// quarantine. Pre-S2y the fresh WAL restarted at seq 1: fact_X silently left
// the active stream (parked in the .corrupt file only) and its seq was
// reissued to a different fact — which another process's warm {walSeq:2}
// marker then filtered out (seq > afterSeq fails) until the next fingerprint
// change.
//
// RED-FIRST EVIDENCE — verbatim failing run against the pre-S2y
// index-wal.js (2026-07-15, branch memperf, isolated scratchpad copy —
// RED-RUN ISOLATION; the live tree was never reverted):
//
//   ✖ T14 append-path quarantine: valid unretired prefix carried forward; no seq reuse; warm marker absorbs (111.813208ms)
//     AssertionError [ERR_ASSERTION]: new fact never reuses a previously-issued seq (floor 2 + 1 carried + 1)
//
//     1 !== 4
//
//       actual: 1,
//       expected: 4,
//       operator: 'strictEqual',
// ---------------------------------------------------------------------------
await test("T14 append-path quarantine: valid unretired prefix carried forward; no seq reuse; warm marker absorbs", () => {
  _resetCaches();
  const MV = "s2y-t14-append-carry";
  seedBase(MV, 0);
  const dir = dirFor(MV);
  const walPath = join(dir, WAL_FILE);

  // Warm the parent's cache entry, then process A (a REAL child process)
  // appends fact_X via the public API and exits WITHOUT flushing.
  const warm0 = loadIndices(MV);
  runChildAppend(MV, "mem_fact_X", "sandglyph", 141); // seq 1 (valid, unretired)
  appendWalRecord(dir, walRecordFor("mem_fx2", "dustglyph", 142)); // seq 2

  // The parent's warm marker absorbs BOTH records (walSeq now 2) — the
  // "another process's warm entry with walSeq=2" of the acceptance gate.
  const warm1 = loadIndices(MV);
  assert.equal(warm1.bm25, warm0.bm25, "warm hit (same cached objects)");
  assert.ok(warm1.hnsw.has("mem_fact_X"), "marker absorbed seq 1");
  assert.ok(warm1.hnsw.has("mem_fx2"), "marker absorbed seq 2 (walSeq=2)");

  // Corrupt the FINAL record (seq 2) in place — framing intact, crc wrong.
  const lines = readFileSync(walPath, "utf8").split("\n");
  assert.ok(lines[1].includes("dustglyph"));
  lines[1] = lines[1].replace("dustglyph", "dXstglyph");
  writeFileSync(walPath, lines.join("\n"), { mode: 0o600 });
  const corruptBytes = readFileSync(walPath);

  // Process B's append triggers the quarantine. Deliberately a LONGER token
  // than mem_fx2's so the fresh WAL's size differs from the stale marker
  // offset — exercising the seq-filter path, not (only) the T13 inode path.
  const b = appendWalRecord(dir, walRecordFor("mem_fact_new", "longestglyphever", 143));
  assert.equal(
    b.seq,
    4,
    "new fact never reuses a previously-issued seq (floor 2 + 1 carried + 1)",
  );

  // (d) The quarantined file retains every original byte.
  const corruptFiles = readdirSync(dir).filter((f) =>
    /^index-wal\.jsonl\.corrupt-\d+$/.test(f),
  );
  assert.equal(corruptFiles.length, 1, "exactly one quarantined WAL");
  assert.ok(
    readFileSync(join(dir, corruptFiles[0])).equals(corruptBytes),
    "quarantined file is byte-identical to the pre-quarantine WAL",
  );

  // (c) The warm entry (walSeq=2) absorbs the post-quarantine records.
  const warm2 = loadIndices(MV);
  assert.equal(warm2.bm25, warm0.bm25, "still the warm cached objects");
  assert.ok(
    warm2.hnsw.has("mem_fact_new"),
    "warm {walSeq:2} marker absorbs the post-quarantine record (no seq was reused under it)",
  );

  // (a) A cold load serves fact_X from the ACTIVE stream (base + WAL replay;
  // the .corrupt file is never read). The corrupted record's fact is gone
  // from the active stream — fail-closed — and retained only in quarantine.
  _resetCaches();
  const loaded = loadIndices(MV);
  assert.ok(
    loaded.hnsw.has("mem_fact_X"),
    "fact_X (valid unretired prefix) served from the ACTIVE stream after quarantine",
  );
  const bX = loaded.bm25.search("sandglyph", 5);
  assert.equal(bX.length, 1, "fact_X present in bm25 after cold load");
  assert.ok(loaded.hnsw.has("mem_fact_new"), "the new fact is served too");
  assert.equal(
    loaded.hnsw.has("mem_fx2"),
    false,
    "the corrupted record's fact is NOT resurrected (bytes retained in quarantine only)",
  );
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T15) S2y RED-FIRST: cross-process corruption strike. The 2-strike
// counter (pending.walTailErrors) lived on the in-memory pending entry, so
// quarantine required TWO failed flush attempts within ONE process lifetime.
// The production MCP server is spawned per session: every session flushed
// once, refused once, and exited — attempt #1 forever, the WAL growing
// unboundedly across sessions, quarantine never firing. Fix: the first
// strike is persisted to index-wal.corrupt-strike.json; a second sighting of
// the SAME error in ANY process quarantines.
//
// RED-FIRST EVIDENCE — verbatim failing run against the pre-S2y
// index-cache.js (2026-07-15, branch memperf, isolated scratchpad copy —
// RED-RUN ISOLATION; the live tree was never reverted):
//
//   ✖ T15 cross-process strike: the second process's single flush attempt quarantines (152.669834ms)
//     AssertionError [ERR_ASSERTION]: second process's flush quarantines (persisted strike)
//
//     false !== true
//
//       actual: false,
//       expected: true,
//       operator: 'strictEqual',
// ---------------------------------------------------------------------------
await test("T15 cross-process strike: the second process's single flush attempt quarantines", () => {
  _resetCaches();
  const MV = "s2y-t15-cross-process-strike";
  seedBase(MV, 0);
  const dir = dirFor(MV);
  const walPath = join(dir, WAL_FILE);
  const strikePath = join(dir, "index-wal.corrupt-strike.json");

  appendWalRecord(dir, walRecordFor("mem_r1", "hailglyph", 151)); // seq 1
  appendWalRecord(dir, walRecordFor("mem_r2", "sleetglyph", 152)); // seq 2
  appendWalRecord(dir, walRecordFor("mem_r3", "snowglyph", 153)); // seq 3
  // Corrupt record 2 IN THE MIDDLE (framing intact, crc wrong; the final
  // record stays valid so appends keep working).
  const lines = readFileSync(walPath, "utf8").split("\n");
  assert.ok(lines[1].includes("sleetglyph"));
  lines[1] = lines[1].replace("sleetglyph", "sXeetglyph");
  writeFileSync(walPath, lines.join("\n"), { mode: 0o600 });

  // Process 1: ONE flush attempt. Fail-closed refusal (first sighting), but
  // the strike is persisted for the next process.
  const r1 = runChildOneFlush(MV, "mem_cs1", "firstsession", 154);
  assert.equal(r1.flushed, false, "first process's flush refuses (fail-closed)");
  assert.equal(
    readdirSync(dir).filter((f) => /^index-wal\.jsonl\.corrupt-\d+$/.test(f)).length,
    0,
    "no quarantine after the first sighting",
  );
  // Recorded here, asserted after the core defect gate below (so the red run
  // fails at the DEFECT, not at this fix-mechanism detail).
  const strikeSurvivedFirstProcess = existsSync(strikePath);

  // Process 2: a FRESH process (in-memory counters gone) makes its own
  // single flush attempt against the same mid-corrupt WAL.
  const r2 = runChildOneFlush(MV, "mem_cs2", "secondsession", 155);
  assert.equal(r2.flushed, true, "second process's flush quarantines (persisted strike)");
  assert.ok(strikeSurvivedFirstProcess, "the strike survived the first process's exit");

  const corruptFiles = readdirSync(dir).filter((f) =>
    /^index-wal\.jsonl\.corrupt-\d+$/.test(f),
  );
  assert.equal(corruptFiles.length, 1, "WAL quarantined by the second process");
  assert.equal(existsSync(strikePath), false, "strike cleared by the quarantine");
  const cursor = readAppliedCursor(dir);
  assert.equal(cursor.applied_seq, 1, "retired up to the last GOOD record, never past");

  // The valid prefix and the second process's own add were persisted; the
  // records at/after the corruption are parked in the .corrupt file only.
  const loaded = loadIndices(MV);
  assert.ok(loaded.hnsw.has("mem_r1"), "valid prefix persisted");
  assert.ok(loaded.hnsw.has("mem_cs2"), "quarantining process's add persisted");
  assert.equal(loaded.hnsw.has("mem_r2"), false, "corrupt record fail-closed");
  assert.equal(loaded.hnsw.has("mem_r3"), false, "post-corruption record fail-closed (parked)");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (T16) S2y RED-FIRST: walCorruptIno pin TOCTOU. loadIndices used to pin the
// corruption marker with a statSync of the WAL PATH taken AFTER the failed
// scan — a quarantine landing between the scan and the stat pinned the FRESH
// healthy WAL's inode, so every warm hit skipped absorption of live appends
// until the next inode swap. Fix: readWalTail reports fstatSync(fd).ino of
// the fd it ACTUALLY scanned, and loadIndices pins that.
//
// The interleave is reproduced deterministically: the WAL is swapped (rename
// + fresh append — exactly what a concurrent quarantine does) from inside
// the hnsw.add of the corrupt WAL's replayed prefix record, i.e. strictly
// after readWalTail opened+buffered the corrupt file and strictly before
// loadIndices pins.
//
// RED-FIRST EVIDENCE — verbatim failing run against the pre-S2y
// index-cache.js (2026-07-15, branch memperf, isolated scratchpad copy —
// RED-RUN ISOLATION; the live tree was never reverted):
//
//   ✖ T16 TOCTOU: the corruption pin binds the scanned fd's inode, not the post-scan path (50.83425ms)
//     AssertionError [ERR_ASSERTION]: warm hit re-absorbs from the fresh WAL (pin must not match the fresh inode)
//       actual: false,
//       expected: true,
//       operator: '==',
// ---------------------------------------------------------------------------
await test("T16 TOCTOU: the corruption pin binds the scanned fd's inode, not the post-scan path", () => {
  _resetCaches();
  const MV = "s2y-t16-pin-toctou";
  seedBase(MV, 0);
  const dir = dirFor(MV);
  const walPath = join(dir, WAL_FILE);

  appendWalRecord(dir, walRecordFor("mem_p", "reedglyph", 161)); // seq 1 (valid)
  appendWalRecord(dir, walRecordFor("mem_c", "kelpglyph", 162)); // seq 2 -> corrupted
  const lines = readFileSync(walPath, "utf8").split("\n");
  assert.ok(lines[1].includes("kelpglyph"));
  lines[1] = lines[1].replace("kelpglyph", "kXlpglyph");
  writeFileSync(walPath, lines.join("\n"), { mode: 0o600 });

  // Fixture sanity + API-contract capture (asserted AFTER the behavioral
  // gate below, so a red run fails at the DEFECT, not at the new field).
  const scannedIno = statSync(walPath).ino;
  const r = readWalTail(dir, { afterSeq: 0, fromOffset: 0 }, () => {});
  assert.ok(r.error != null && /crc mismatch/.test(r.error), `fixture: scan errors (${r.error})`);

  // Deterministic interleave: swap the WAL while loadIndices' failed scan is
  // mid-replay (inside hnsw.add of the seq-1 record), BEFORE the pin.
  const realAdd = HnswIndex.prototype.add;
  let swapped = false;
  HnswIndex.prototype.add = function (id, vector) {
    if (!swapped && id === "mem_p") {
      swapped = true;
      // Exactly what a concurrent quarantine does: rename the corrupt WAL
      // away (bytes retained) and start a fresh stream.
      renameSync(walPath, `${walPath}.corrupt-${Date.now()}`);
      appendWalRecord(dir, walRecordFor("mem_fresh", "newstreamglyph", 163)); // fresh seq 1
    }
    return realAdd.call(this, id, vector);
  };
  let loaded;
  try {
    loaded = loadIndices(MV); // cold load: scans the CORRUPT fd, then pins
  } finally {
    HnswIndex.prototype.add = realAdd;
  }
  assert.ok(swapped, "interleave hook fired during the cold load's WAL replay");
  assert.ok(loaded.hnsw.has("mem_p"), "valid prefix applied");
  assert.equal(loaded.hnsw.has("mem_fresh"), false, "fresh record not yet visible (scan saw the old fd)");
  assert.notEqual(
    statSync(walPath).ino,
    scannedIno,
    "fixture: the WAL on disk is now a different inode than the scanned one",
  );

  // The pin must NOT match the fresh WAL's inode: the very next warm hit
  // re-absorbs the fresh stream instead of skipping it until the next swap.
  const warm = loadIndices(MV);
  assert.equal(warm.bm25, loaded.bm25, "warm hit (same cached objects)");
  assert.ok(
    warm.hnsw.has("mem_fresh"),
    "warm hit re-absorbs from the fresh WAL (pin must not match the fresh inode)",
  );
  // API contract behind the fix: readWalTail reports the inode of the fd it
  // actually scanned, and that is what loadIndices pins.
  assert.equal(r.ino, scannedIno, "readWalTail reports the scanned fd's inode");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (F4) RED-FIRST: reader-side generation-0 adoption must hold the flush lease.
// Pre-fix loadIndices adopted (activateManifest) UNLEASED on a members-present
// / manifest-absent tree: a slow reader that began adoption while a publisher
// activated a higher generation then overwrote the manifest back to gen-0 — a
// generation ROLLBACK that discarded the WAL cursor and stranded facts. The
// flush lease is the single-writer gate (I4): while a publisher holds it, the
// reader must NOT adopt (it still serves the legacy members unmanaged), and
// the publisher's higher generation is always the final one, cursor intact.
//
// Deterministic in-process interleave: the on-disk lease IS the sync point —
// post-fix the reader takes it before adopting, so a held lease
// deterministically blocks the reader's adoption (no racy child timing needed;
// acquireFlushLease will not reclaim a live same-pid lease). Pre-fix the reader
// ignores the lease and writes a gen-0 manifest.
//
// RED pre-fix: after the reader's load, a gen-0 manifest EXISTS (adopted under
// the held lease) — the write the fix forbids.
// ---------------------------------------------------------------------------
await test("F4 reader adoption never rolls back a lease-holding publisher's generation (cursor preserved)", async () => {
  _resetCaches();
  const { publishGeneration } = await import("../../lib/recall/index-cache.js");
  const { acquireFlushLease, releaseLease } = await import(
    "../../lib/recall/index-wal.js"
  );
  const { readActiveManifest, MANIFEST_FILE } = await import(
    "../../lib/recall/index-manifest.js"
  );
  const { writeBm25IndexV2Atomic } = await import("../../lib/recall/bm25-rebuild.js");
  const MV = "f4-unleased-adoption";
  const dir = dirFor(MV);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Members-present / manifest-absent tree (a pre-S3 legacy tree awaiting
  // gen-0 adoption on its first load).
  const legacyBm25 = new Bm25Index();
  legacyBm25.add(bm25EntryFor("mem_legacy", "legacyglyph"));
  const legacyHnsw = new HnswIndex({
    dims: DIMS,
    embedding_model_version: MV,
    maxElements: 1024,
  });
  legacyHnsw.add("mem_legacy", unitVec(1));
  writeBm25IndexV2Atomic(join(dir, "bm25.json"), legacyBm25);
  legacyHnsw.save(join(dir, "hnsw.bin"));
  const manifestPath = join(dir, MANIFEST_FILE);
  assert.equal(existsSync(manifestPath), false, "fixture: members present, no manifest");

  // A publisher is mid-flight: it holds the flush lease.
  const held = acquireFlushLease(dir);
  assert.ok(held != null, "fixture: publisher holds the flush lease");

  // The reader loads while the lease is held. It must NOT adopt a gen-0
  // manifest under the held lease (that unleased write, landing after the
  // publisher activates a higher generation, is the rollback). It still SERVES
  // the legacy members unmanaged.
  const readerView = loadIndices(MV);
  assert.equal(
    existsSync(manifestPath),
    false,
    "reader never adopts (writes) a manifest while a publisher holds the lease",
  );
  assert.ok(readerView.hnsw.has("mem_legacy"), "reader still serves the legacy members unmanaged");
  assert.equal(
    readerView.bm25.search("legacyglyph", 5).length,
    1,
    "legacy bm25 served unmanaged",
  );

  // The publisher completes under its held lease: adopt gen 0 + publish gen 1,
  // embedding a distinctive WAL cursor.
  const CURSOR = { applied_seq: 7, applied_offset: 512 };
  const biggerBm25 = new Bm25Index();
  biggerBm25.add(bm25EntryFor("mem_legacy", "legacyglyph"));
  biggerBm25.add(bm25EntryFor("mem_pub", "pubglyph"));
  publishGeneration(
    MV,
    { bm25: (p) => writeBm25IndexV2Atomic(p, biggerBm25) },
    { _leaseHeld: true, walCursor: CURSOR },
  );
  releaseLease(held);

  // Final on-disk manifest is the publisher's higher generation; the WAL cursor
  // it embedded is intact (never reset by a reader's gen-0 rollback).
  const after = readActiveManifest(dir).manifest;
  assert.equal(
    after.generation,
    1,
    "final manifest is the publisher's higher generation (adopt gen0 -> publish gen1)",
  );
  assert.equal(after.wal_cursor.applied_seq, CURSOR.applied_seq, "WAL cursor seq preserved");
  assert.equal(after.wal_cursor.applied_offset, CURSOR.applied_offset, "WAL cursor offset preserved");

  // A fresh cold load serves the publisher's generation.
  _resetCaches();
  const served = loadIndices(MV);
  assert.equal(served.generation_refused, null, "publisher generation serves cleanly");
  assert.equal(
    served.bm25.search("pubglyph", 5)[0].memory_id,
    "mem_pub",
    "publisher content served",
  );
  _resetCaches();
});

// The debounce/WAL machinery never touches the memory ledger.
await test("ledgers/memory.jsonl was never created by this suite", () => {
  assert.equal(
    existsSync(join(MEMORY_ROOT, "ledgers", "memory.jsonl")),
    false,
    "no ledger file was ever created or read",
  );
});
