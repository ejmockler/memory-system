// hnsw-delta-flush.test.mjs — W3 HNSW append-delta flush (bounded
// index-write budget).
//
// The pre-W3 flush policy rewrote the FULL index (multi-GB hnsw.bin + meta +
// bm25) every INDEX_SAVE_BATCH=64 adds or 5 minutes (~288x/day, ~544GB/day of
// SSD writes at the measured ~1,800-fact/day promote cadence). Since S2 the
// crc-framed, sequenced WAL is the durable record of every add (replayed on
// every load) and S3's manifest gates publication — the full save exists only
// to BOUND COLD-LOAD REPLAY COST. W3 changes the trigger to replay-cost
// budgets over the UNRETIRED WAL:
//   depth  > INDEX_SAVE_WAL_RECORDS      (default 8192 records)
//   bytes  > INDEX_SAVE_WAL_BYTES        (default 64 MiB)
//   oldest > INDEX_SAVE_MAX_STALENESS_MS (default 6h)
// with INDEX_SAVE_BATCH / INDEX_SAVE_MAX_AGE_S honored ONLY when explicitly
// set (legacy/test override) and flushIndicesNow still forcing a save.
//
// RED-FIRST EVIDENCE — verbatim failing run against the UNMODIFIED pre-W3
// index-cache.js (2026-07-16, branch memperf, run in isolation before any
// source change; pre-fix the default count trigger fired a FULL SAVE at
// add 64):
//
//   ✖ P1 RED-FIRST: 65 scheduled adds with the new defaults produce ZERO full saves (606.722875ms)
//     AssertionError [ERR_ASSERTION]: no schedule call reported a flush
//       actual: 1,
//       expected: 0,
//   ✖ P7 write-volume: a simulated day at fixture cadence saves at most ceil(day/staleness) times (17322.82425ms)
//     AssertionError [ERR_ASSERTION]: at most ceil(day/staleness)=4 full saves (got 47; pre-W3 policy: 288)
//
//   (P2/P3/P4/P6/P9 fail pre-fix for the same root cause — the WAL-budget
//   envs did not exist and the 64-count default flushed inside every window;
//   P5 [explicit legacy override + forced flush] and P8 [replay speed] were
//   already green pre-fix, as expected: neither depends on the new policy.)
//
// The same suite is green post-fix (WAL-budget triggers, legacy honored only
// when set).
//
// Discipline (matches test/recall/index-wal.test.mjs):
//   - mkdtempSync rooted in tmpdir; MEMORY_ROOT + POLICY_BASE_DIR +
//     STORAGE_BASE_DIR + LEDGERS_BASE_DIR overwritten BEFORE any dynamic
//     import. Live indices / live ledger are NEVER touched.
//   - INDEX_SAVE_BATCH / INDEX_SAVE_MAX_AGE_S explicitly DELETED so the new
//     defaults govern (they are legacy/test overrides, honored only when set).
//   - full saves observed via the PUBLIC surface (manifest generation +
//     hnsw.bin/bm25.json stat fingerprints + applied cursor), never via
//     module internals.
//   - fixtures only; a final assertion pins that ledgers/memory.jsonl was
//     never created inside the temp tree.
//   - small synthetic dims=8 unit vectors; per-test model versions.
//   - node:test + node:assert/strict; _resetCaches() between tests.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { crc32 } from "node:zlib";
import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Hermeticity: stake tmp dirs + overwrite env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-hnsw-delta-flush-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
process.env.TELEMETRY_BASE_DIR = join(MEMORY_ROOT, "telemetry");
// W3 — the NEW defaults must govern this suite: the legacy overrides are
// honored only when explicitly set, so delete them (and the W3 budgets) here.
delete process.env.INDEX_SAVE_BATCH;
delete process.env.INDEX_SAVE_MAX_AGE_S;
delete process.env.INDEX_SAVE_WAL_RECORDS;
delete process.env.INDEX_SAVE_WAL_BYTES;
delete process.env.INDEX_SAVE_MAX_STALENESS_MS;

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
const { WAL_FILE, appendWalRecord, readAppliedCursor, readWalTail } = await import(
  "../../lib/recall/index-wal.js"
);
const { readActiveManifest } = await import(
  "../../lib/recall/index-manifest.js"
);
const { HnswIndex, HNSW_BACKEND } = await import(
  "../../lib/recall/hnsw-index.js"
);
const { Bm25Index } = await import("../../lib/recall/bm25-index.js");

// ---------------------------------------------------------------------------
// Fixtures (index-wal.test.mjs conventions).
// ---------------------------------------------------------------------------
const DIMS = 8;

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

function bm25EntryFor(id, token = "") {
  return {
    memory_id: id,
    kind: "fact",
    content: `synthetic fact ${id} ${token}`.trim(),
    ts: "2026-07-16T00:00:00Z",
    entities: [],
    valence: null,
    consent_basis: "first_party",
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
function addAndSchedule(modelVersion, { bm25, hnsw }, i) {
  const id = `mem_${i}`;
  const entry = bm25EntryFor(id, `token_${i}`);
  const vector = unitVec(i);
  bm25.add(entry);
  hnsw.add(id, vector);
  return scheduleSaveIndices(
    modelVersion,
    { bm25, hnsw },
    { factId: id, bm25Entry: entry, vector },
  );
}

// PUBLIC observation surface for "a full save happened": the S3 manifest's
// generation advances by exactly one per publication, and the member files
// are rewritten (stat fingerprint moves). No module internals.
function generationOf(modelVersion) {
  const m = readActiveManifest(dirFor(modelVersion)).manifest;
  return m != null ? m.generation : null;
}

function fpOf(path) {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}

function walSize(modelVersion) {
  const p = join(dirFor(modelVersion), WAL_FILE);
  return existsSync(p) ? statSync(p).size : 0;
}

function unretiredCount(modelVersion) {
  const dir = dirFor(modelVersion);
  const cursor = readAppliedCursor(dir);
  assert.equal(cursor.error, null, "applied cursor readable");
  let n = 0;
  const r = readWalTail(
    dir,
    { afterSeq: cursor.applied_seq, fromOffset: cursor.applied_offset },
    () => n++,
  );
  assert.equal(r.error, null, "WAL tail readable");
  return n;
}

// ---------------------------------------------------------------------------
// (P1) RED-FIRST policy test: with the new defaults (legacy envs unset), 65
// scheduled adds produce ZERO full saves. Pre-fix the default count trigger
// (INDEX_SAVE_BATCH fallback 64) fired a full save at add 64.
// ---------------------------------------------------------------------------
await test("P1 RED-FIRST: 65 scheduled adds with the new defaults produce ZERO full saves", () => {
  _resetCaches();
  const MV = "w3-p1-no-save-at-64";
  seedBase(MV, 0);
  const dir = dirFor(MV);
  const genBefore = generationOf(MV);
  const hnswFpBefore = fpOf(join(dir, "hnsw.bin"));
  const bm25FpBefore = fpOf(join(dir, "bm25.json"));
  const cursorBefore = readAppliedCursor(dir).applied_seq;

  const { bm25, hnsw } = loadIndices(MV);
  let flushSignals = 0;
  for (let i = 0; i < 65; i++) {
    const r = addAndSchedule(MV, { bm25, hnsw }, i);
    if (r.flushed) flushSignals += 1;
  }

  assert.equal(flushSignals, 0, "no schedule call reported a flush");
  assert.equal(
    generationOf(MV),
    genBefore,
    "manifest generation unchanged (no full save at add 64 or 65)",
  );
  assert.equal(
    fpOf(join(dir, "hnsw.bin")),
    hnswFpBefore,
    "hnsw.bin never rewritten",
  );
  assert.equal(
    fpOf(join(dir, "bm25.json")),
    bm25FpBefore,
    "bm25.json never rewritten",
  );
  assert.equal(
    readAppliedCursor(dir).applied_seq,
    cursorBefore,
    "no WAL records retired",
  );
  assert.equal(unretiredCount(MV), 65, "all 65 adds owed to the WAL");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (P2) WAL-depth trigger: with a tiny INDEX_SAVE_WAL_RECORDS budget, the
// flush fires exactly when the unretired record count EXCEEDS the budget.
// ---------------------------------------------------------------------------
await test("P2 WAL-depth trigger fires exactly when unretired records exceed INDEX_SAVE_WAL_RECORDS", () => {
  _resetCaches();
  process.env.INDEX_SAVE_WAL_RECORDS = "5";
  try {
    const MV = "w3-p2-depth";
    seedBase(MV, 0);
    const dir = dirFor(MV);
    const genBefore = generationOf(MV);
    const { bm25, hnsw } = loadIndices(MV);
    for (let i = 0; i < 5; i++) {
      const r = addAndSchedule(MV, { bm25, hnsw }, i);
      assert.equal(r.flushed, false, `add ${i + 1}: depth ${i + 1} <= 5, no flush`);
    }
    assert.equal(generationOf(MV), genBefore, "no full save AT the budget boundary");
    const r6 = addAndSchedule(MV, { bm25, hnsw }, 5);
    assert.equal(r6.flushed, true, "depth 6 > 5: flush fires");
    assert.equal(generationOf(MV), genBefore + 1, "exactly one new generation");
    assert.equal(readAppliedCursor(dir).applied_seq, 6, "all 6 records retired");
    assert.equal(walSize(MV), 0, "WAL compacted (no unretired tail)");
  } finally {
    delete process.env.INDEX_SAVE_WAL_RECORDS;
  }
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (P3) WAL-bytes trigger: the flush fires when the unretired WAL bytes
// exceed INDEX_SAVE_WAL_BYTES (budget derived from a measured record so the
// test never guesses the frame size).
// ---------------------------------------------------------------------------
await test("P3 WAL-bytes trigger fires when unretired WAL bytes exceed INDEX_SAVE_WAL_BYTES", () => {
  _resetCaches();
  const MV = "w3-p3-bytes";
  seedBase(MV, 0);
  const dir = dirFor(MV);
  const genBefore = generationOf(MV);
  const { bm25, hnsw } = loadIndices(MV);

  const r1 = addAndSchedule(MV, { bm25, hnsw }, 0);
  assert.equal(r1.flushed, false, "default 64MiB byte budget: no flush");
  const oneRecordBytes = walSize(MV);
  assert.ok(oneRecordBytes > 0, "one framed record on disk");

  // Budget = 1.5 records: the second append (2 records ≈ 2x bytes) exceeds it.
  process.env.INDEX_SAVE_WAL_BYTES = String(Math.floor(oneRecordBytes * 1.5));
  try {
    const r2 = addAndSchedule(MV, { bm25, hnsw }, 1);
    assert.equal(r2.flushed, true, "2 records > 1.5-record byte budget: flush fires");
    assert.equal(generationOf(MV), genBefore + 1, "exactly one new generation");
    assert.equal(readAppliedCursor(dir).applied_seq, 2, "both records retired");
    assert.equal(walSize(MV), 0, "WAL compacted");
  } finally {
    delete process.env.INDEX_SAVE_WAL_BYTES;
  }
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (P4) staleness trigger: aged unflushed records flush via the unref()'d
// quiet-period timer armed on INDEX_SAVE_MAX_STALENESS_MS (tiny budget).
// ---------------------------------------------------------------------------
await test("P4 staleness trigger: aged records flush via the unref'd timer", async () => {
  _resetCaches();
  process.env.INDEX_SAVE_MAX_STALENESS_MS = "300";
  try {
    const MV = "w3-p4-staleness";
    seedBase(MV, 0);
    const dir = dirFor(MV);
    const genBefore = generationOf(MV);
    const { bm25, hnsw } = loadIndices(MV);
    for (let i = 0; i < 2; i++) {
      assert.equal(
        addAndSchedule(MV, { bm25, hnsw }, i).flushed,
        false,
        "no flush before the staleness budget",
      );
    }
    assert.equal(generationOf(MV), genBefore, "no save before the budget ages out");

    await sleep(900); // > 300ms: the timer must fire unaided

    assert.equal(generationOf(MV), genBefore + 1, "staleness flush fired exactly once");
    assert.equal(readAppliedCursor(dir).applied_seq, 2, "both records retired");
    assert.equal(walSize(MV), 0, "WAL compacted after the staleness flush");
  } finally {
    delete process.env.INDEX_SAVE_MAX_STALENESS_MS;
  }
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (P5) legacy override + forced flush: INDEX_SAVE_BATCH still triggers at the
// set count when EXPLICITLY set, and flushIndicesNow always forces a save.
// ---------------------------------------------------------------------------
await test("P5 explicit INDEX_SAVE_BATCH is honored; flushIndicesNow still forces a save", () => {
  _resetCaches();
  process.env.INDEX_SAVE_BATCH = "3";
  try {
    const MV = "w3-p5-legacy";
    seedBase(MV, 0);
    const genBefore = generationOf(MV);
    const { bm25, hnsw } = loadIndices(MV);
    assert.equal(addAndSchedule(MV, { bm25, hnsw }, 0).flushed, false);
    assert.equal(addAndSchedule(MV, { bm25, hnsw }, 1).flushed, false);
    assert.equal(
      addAndSchedule(MV, { bm25, hnsw }, 2).flushed,
      true,
      "legacy batch=3 flushes at exactly the 3rd add",
    );
    assert.equal(generationOf(MV), genBefore + 1, "legacy flush published a generation");
    assert.equal(readAppliedCursor(dirFor(MV)).applied_seq, 3, "all 3 retired");
  } finally {
    delete process.env.INDEX_SAVE_BATCH;
  }

  // flushIndicesNow: forced save regardless of any budget (new defaults).
  const MV2 = "w3-p5-forced";
  seedBase(MV2, 0);
  const gen2Before = generationOf(MV2);
  const loaded = loadIndices(MV2);
  addAndSchedule(MV2, loaded, 0);
  assert.equal(flushIndicesNow(MV2), true, "forced flush succeeds");
  assert.equal(generationOf(MV2), gen2Before + 1, "forced flush persisted a generation");
  assert.equal(readAppliedCursor(dirFor(MV2)).applied_seq, 1, "record retired");
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (P6) crash safety PAST the old 64-batch (index-wal.test.mjs T2 pattern
// extended): >64 WAL appends with no flush, simulated crash (no cursor
// advance) -> the next cold load recovers EVERY add; re-replay after a
// save-without-retire stays idempotent.
// ---------------------------------------------------------------------------
await test("P6 crash past the old 64-batch: every WAL add recovered on the next cold load", () => {
  _resetCaches();
  const MV = "w3-p6-crash";
  seedBase(MV, 0);
  const dir = dirFor(MV);
  const N = 70; // strictly past the old INDEX_SAVE_BATCH=64 flush point

  const { bm25, hnsw } = loadIndices(MV);
  for (let i = 0; i < N; i++) {
    assert.equal(
      addAndSchedule(MV, { bm25, hnsw }, i).flushed,
      false,
      "new defaults: no auto-flush inside the budget",
    );
  }
  assert.equal(
    readAppliedCursor(dir).applied_seq,
    0,
    "cursor never advanced (crash window covers all 70 adds)",
  );

  // Simulated crash: all process state dropped; only ledger-durable WAL bytes
  // survive. The next cold load must replay every add.
  _resetCaches();
  const loaded = loadIndices(MV);
  assert.equal(loaded.hnsw.size(), N + 1, "base + all 70 crash-window adds recovered");
  assert.equal(loaded.bm25.size(), N + 1);
  for (let i = 0; i < N; i++) {
    assert.ok(loaded.hnsw.has(`mem_${i}`), `mem_${i} recovered by WAL replay`);
  }

  // T2 extension: persist the replayed base WITHOUT advancing the cursor
  // (crash between saveIndices and retire) — the re-replay on the next cold
  // load is idempotent, every fact present exactly once.
  saveIndices(MV, { bm25: loaded.bm25, hnsw: loaded.hnsw });
  assert.equal(readAppliedCursor(dir).applied_seq, 0, "cursor still un-advanced");
  _resetCaches();
  const again = loadIndices(MV);
  assert.equal(again.hnsw.size(), N + 1, "re-replay past the saved base is idempotent");
  assert.equal(again.bm25.size(), N + 1);
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (P7) write-volume gate: a simulated day at the measured fixture cadence
// (1800 adds, hourly clock ticks injected via a Date.now offset) performs at
// most ceil(day / staleness budget) full saves — NOT the 288 (24h / 5min)
// the old count-OR-age policy produced.
// ---------------------------------------------------------------------------
await test("P7 write-volume: a simulated day at fixture cadence saves at most ceil(day/staleness) times", () => {
  _resetCaches();
  const MV = "w3-p7-day";
  seedBase(MV, 0);
  const genBefore = generationOf(MV);

  const HOUR_MS = 3600 * 1000;
  const ADDS_PER_HOUR = 75; // 75 * 24 = 1800/day — the measured promote cadence
  // Clock injection: an OFFSET over the real clock (not a frozen value) so
  // real time keeps flowing for lock backoff spins while the staleness math
  // sees hourly jumps. Only the module's Date.now() staleness reads care.
  const realNow = Date.now.bind(Date);
  let offsetMs = 0;
  Date.now = () => realNow() + offsetMs;
  let n = 0;
  try {
    const { bm25, hnsw } = loadIndices(MV);
    for (let hour = 0; hour < 24; hour++) {
      for (let k = 0; k < ADDS_PER_HOUR; k++) {
        addAndSchedule(MV, { bm25, hnsw }, n++);
      }
      offsetMs += HOUR_MS;
    }
  } finally {
    Date.now = realNow;
  }
  assert.equal(n, 1800, "full simulated day at fixture cadence");

  const saves = generationOf(MV) - genBefore;
  const maxSaves = Math.ceil(24 / 6); // day / INDEX_SAVE_MAX_STALENESS_MS default (6h)
  assert.ok(saves >= 1, `at least one staleness flush over the day (got ${saves})`);
  assert.ok(
    saves <= maxSaves,
    `at most ceil(day/staleness)=${maxSaves} full saves (got ${saves}; pre-W3 policy: 288)`,
  );
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (P8) cold-load replay budget: a WAL at the full INDEX_SAVE_WAL_RECORDS
// default (8192 records) replays in under ~1s at fixture scale. The WAL is
// staged directly in the documented stable frame ({"seq":N,"crc":...,
// "rec":...}\n, crc32 over the exact rec bytes — the same format
// index-wal.test.mjs pins) so the fixture build does not pay 8192 fsyncs.
//
// PRODUCTION EXPECTATION (documented, not asserted): cold-load replay cost is
// record-count x per-add cost. At the production operating point (4096-dim
// vectors, native hnswlib add ~1-3ms) a max-budget 8192-record WAL replays in
// ~8-25s worst case; at the measured ~1,800-fact/day cadence the 6h staleness
// budget bounds the WAL to ~450 records (~0.5-1.5s replay), and the
// records/bytes budgets cap the worst case. The same budgets that bound WAL
// growth bound this replay — that is the W3 invariant this test pins.
// ---------------------------------------------------------------------------
await test("P8 cold-load replay of a max-budget WAL completes under ~1s at fixture scale", () => {
  _resetCaches();
  const MV = "w3-p8-replay";
  seedBase(MV, 0);
  const dir = dirFor(MV);
  const BUDGET = 8192; // INDEX_SAVE_WAL_RECORDS default

  const lines = [];
  for (let i = 1; i <= BUDGET; i++) {
    const rec = JSON.stringify({
      fact_id: `mem_r${i}`,
      ts: "2026-07-16T00:00:00Z",
      bm25_entry: bm25EntryFor(`mem_r${i}`, `walreplay_${i}`),
      vector: unitVec(i),
    });
    const crc = (crc32(Buffer.from(rec, "utf8")) >>> 0)
      .toString(16)
      .padStart(8, "0");
    lines.push(`{"seq":${i},"crc":"${crc}","rec":${rec}}`);
  }
  writeFileSync(join(dir, WAL_FILE), lines.join("\n") + "\n", { mode: 0o600 });
  assert.equal(unretiredCount(MV), BUDGET, "WAL staged at the full records budget");

  // Best of up to three cold loads: a single wall-clock sample is at the mercy
  // of whatever else the machine is doing (npm test runs other suites
  // alongside). Each attempt is a full cold replay of the same unretired WAL.
  let elapsedMs = Infinity;
  for (let attempt = 0; attempt < 3 && elapsedMs >= 1000; attempt++) {
    assert.equal(unretiredCount(MV), BUDGET, "WAL still holds the full records budget before each cold load");
    _resetCaches();
    const t0 = performance.now();
    const loaded = loadIndices(MV); // cold load: deserialize base + replay the full tail
    elapsedMs = Math.min(elapsedMs, performance.now() - t0);

    assert.equal(loaded.hnsw.size(), BUDGET + 1, "every WAL record replayed");
    assert.ok(loaded.hnsw.has("mem_r1"), "first record present");
    assert.ok(loaded.hnsw.has(`mem_r${BUDGET}`), "last record present");
  }
  assert.ok(
    elapsedMs < 1000,
    `cold-load replay of ${BUDGET} records took ${elapsedMs.toFixed(0)}ms (budget ~1s)`,
  );
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (P9) telemetry: each full save emits exactly ONE structured stderr JSON
// line ({event:"index_full_save", model_version, trigger, bytes_written,
// member_bytes, wal_records_retired}) so FINAL can table writes/day
// before-vs-after.
// ---------------------------------------------------------------------------
await test("P9 telemetry: each full save emits exactly one structured stderr line with member bytes", () => {
  _resetCaches();
  const MV = "w3-p9-telemetry";
  seedBase(MV, 0);
  const { bm25, hnsw } = loadIndices(MV);
  for (let i = 0; i < 3; i++) {
    assert.equal(addAndSchedule(MV, { bm25, hnsw }, i).flushed, false);
  }

  const captured = [];
  const realErr = console.error;
  console.error = (...args) => {
    captured.push(args.map(String).join(" "));
  };
  let flushed;
  try {
    flushed = flushIndicesNow(MV);
  } finally {
    console.error = realErr;
  }
  assert.equal(flushed, true, "forced flush succeeds");

  const events = captured
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((j) => j != null && j.event === "index_full_save");
  assert.equal(events.length, 1, "exactly one index_full_save line per full save");
  const ev = events[0];
  assert.equal(ev.model_version, MV);
  assert.equal(ev.trigger, "forced", "flushIndicesNow reports the forced trigger");
  assert.equal(ev.wal_records_retired, 3, "retired-record count reported");
  assert.ok(
    Number.isSafeInteger(ev.bytes_written) && ev.bytes_written > 0,
    "total bytes written reported",
  );
  assert.ok(ev.member_bytes.bm25 > 0, "bm25.json bytes reported");
  assert.ok(ev.member_bytes.hnsw > 0, "hnsw.bin bytes reported");
  if (HNSW_BACKEND === "hnswlib-node") {
    assert.ok(ev.member_bytes.hnsw_meta > 0, "meta sidecar bytes reported");
  }
  assert.equal(
    ev.bytes_written,
    (ev.member_bytes.bm25 ?? 0) +
      (ev.member_bytes.hnsw ?? 0) +
      (ev.member_bytes.hnsw_meta ?? 0),
    "total is the sum of the member bytes",
  );
  _resetCaches();
});

// ---------------------------------------------------------------------------
// (P10) REG (memperf) — CROSS-PROCESS STALENESS SEED. Pre-REG a fresh
// pending entry seeded oldestTs = Date.now(), so records left unretired by
// ANOTHER process (a crashed flusher, a short-lived per-session MCP spawn)
// never aged the staleness trigger: every new process restarted the clock
// and the foreign records could stay unflushed indefinitely. Post-REG the
// seed is the WAL HEAD record's ts (the oldest unretired add), so the FIRST
// schedule call in a fresh process flushes when that head is already past
// the staleness budget. Pre-fix this test fails: r.flushed === false (the
// clock restarted; only the unref'd timer a full budget later would flush).
// ---------------------------------------------------------------------------
await test("P10 cross-process staleness seeds from the WAL head ts: a fresh process's first schedule flushes stale foreign records", () => {
  _resetCaches();
  const MV = "w3-p10-cross-process-staleness";
  seedBase(MV, 0);
  const dir = dirFor(MV);

  // ANOTHER process appended 2 minutes ago and died before flushing.
  const foreignEntry = bm25EntryFor("mem_foreign", "foreigntoken");
  appendWalRecord(dir, {
    fact_id: "mem_foreign",
    ts: new Date(Date.now() - 120_000).toISOString(),
    bm25_entry: foreignEntry,
    vector: unitVec(99),
  });

  process.env.INDEX_SAVE_MAX_STALENESS_MS = "60000"; // 1 min budget
  try {
    const genBefore = generationOf(MV);
    // Fresh process: cold load replays the foreign record into memory...
    const { bm25, hnsw } = loadIndices(MV);
    // ...and the FIRST schedule call must fire the staleness trigger off the
    // 2-minutes-old WAL head (2 min > 1 min budget), not a restarted clock.
    const r = addAndSchedule(MV, { bm25, hnsw }, 0);
    assert.equal(
      r.flushed,
      true,
      "first schedule in a fresh process flushes: staleness seeded from the WAL head ts, not Date.now()",
    );
    assert.equal(generationOf(MV), genBefore + 1, "full save published");
    assert.equal(unretiredCount(MV), 0, "foreign + own records both retired");
    _resetCaches();
    assert.ok(
      loadIndices(MV).hnsw.has("mem_foreign"),
      "the foreign record made it into the persisted base",
    );
  } finally {
    delete process.env.INDEX_SAVE_MAX_STALENESS_MS;
  }
  _resetCaches();
});

// ---------------------------------------------------------------------------
// Hermeticity pin: the flush machinery never touches the memory ledger.
// ---------------------------------------------------------------------------
await test("ledgers/memory.jsonl was never created by this suite", () => {
  assert.equal(
    existsSync(join(MEMORY_ROOT, "ledgers", "memory.jsonl")),
    false,
    "no ledger file was ever created or read",
  );
});
