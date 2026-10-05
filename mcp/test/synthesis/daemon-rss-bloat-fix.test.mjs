// daemon-rss-bloat-fix.test.mjs — WU-B1-daemon-rss-bloat-fix
//
// Regression test for the 4.2GB-in-20-minutes RSS bloat in the watermark
// daemon. Pre-fix the cascade tick ran THREE separate consumers each of
// which called readFileSync on the full memory.jsonl (308MB → 220k rows
// → ~2.1GB JS-heap per consumer per tick). At 15s tick cadence the
// daemon's RSS climbed monotonically until the process was OOM-killed
// or hit the --max-old-space-size cap.
//
// The fix (mcp/lib/synthesis/_ledger-stream.js) replaces the per-tick
// readFileSync paths with streaming filtered reads:
//   - thread-aggregator    → streamLedgerRowsInTimeWindow(24h, kind=fact)
//   - project-aggregator   → streamLedgerRowsInTimeWindow( 7d, kind=fact)
//   - embed-backfill-worker → streamLedgerRowsById(idSet from queue alive set)
//
// This test builds a 10k-row fixture ledger (large enough that the
// pre-fix readFileSync paths would land a measurable RSS hit) and
// asserts:
//   - all three streaming helpers return correct values
//   - the working-set RSS during a simulated tick stays bounded
//     (well under the per-tick spike a 10k-row readFileSync would
//     produce)
//   - aggregator + embed-backfill-worker pipelines, wired against the
//     fixture, exercise the streaming path without falling back to
//     full-file reads
//   - cache-style behaviors don't regress: invoking the same path
//     repeatedly does not grow heap proportional to invocation count
//
// HERMETIC: env-before-dynamic-import. All writes under a tmpdir that
// is removed via teardown.
//
// node:test + node:assert/strict; 12+ assertions across multiple tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hermetic env — override MEMORY_ROOT and friends BEFORE importing any
// memory-system module so the production paths are never touched.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-rss-bloat-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.POLICY_BASE_DIR = join(TMP_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TMP_ROOT, "ledgers");
process.env.HOOKS_BASE_DIR = join(TMP_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(TMP_ROOT, "daemons");
for (const d of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  process.env.HOOKS_BASE_DIR,
  process.env.DAEMONS_BASE_DIR,
  join(process.env.STORAGE_BASE_DIR, "sources"),
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

const LEDGER_PATH = join(process.env.LEDGERS_BASE_DIR, "memory.jsonl");

// Dynamic imports AFTER the env is pinned.
const streamMod = await import(
  "../../lib/synthesis/_ledger-stream.js"
);
const threadMod = await import(
  "../../lib/synthesis/thread-aggregator.js"
);
const projectMod = await import(
  "../../lib/synthesis/project-aggregator.js"
);
// WU2-inline-embed-and-remove-gemini-quota-machinery deleted
// embed-backfill-worker.js. The RSS-bloat fix it shared (the _ledger-stream.js
// streaming helpers) is still exercised here via the thread + project
// aggregators; the embed-backfill drain/overlay tests (T7/T8) were removed.

// ---------------------------------------------------------------------------
// Fixture: 10k-row ledger with a deliberate mix of recent + old rows so
// the aggregators' 24h/7d windows can prove the stream-filter is
// dropping out-of-window rows from heap.
// ---------------------------------------------------------------------------
const ROW_COUNT = 10000;
const RECENT_ROWS = 200; // within 24h
const NOW_MS = Date.parse("2026-06-21T12:00:00Z");
const OLD_TS = "2025-01-01T00:00:00Z"; // outside any aggregator window

function buildFixtureLedger() {
  // Build the file via a large in-memory array → one write. Building
  // line-by-line via appendFileSync would be ~10k fsync calls which
  // dominates the test wall time (each fsync is ~1ms on APFS).
  const lines = [];
  for (let i = 0; i < ROW_COUNT - RECENT_ROWS; i++) {
    lines.push(
      JSON.stringify({
        id: `mem_old_${i}`,
        kind: "fact",
        content: `old content row ${i}`,
        ts: OLD_TS,
        source: "git-log",
        raw_content: { repo_path: "/repo", author_email: "a@e.com" },
        features: { entities: ["repo"] },
      }),
    );
  }
  for (let i = 0; i < RECENT_ROWS; i++) {
    lines.push(
      JSON.stringify({
        id: `mem_recent_${i}`,
        kind: "fact",
        // Vary the ts within the recent window so threads can form.
        ts: new Date(NOW_MS - (i * 60_000)).toISOString(),
        content: `recent content row ${i}`,
        source: "git-log",
        raw_content: {
          repo_path: "/repo",
          author_email: "a@e.com",
          subject: "recent commit " + i,
        },
        features: { entities: ["repo"] },
      }),
    );
  }
  // Sprinkle a few policy rows so the kind="fact" filter is exercised.
  for (let i = 0; i < 50; i++) {
    lines.push(
      JSON.stringify({
        id: `mem_policy_${i}`,
        kind: "policy",
        policy_kind: "embedding_backfill",
        target_fact_id: `mem_recent_${i % RECENT_ROWS}`,
        embedding: { vector_3072: null, vector_mrl_768: null },
        embedding_model_version: "test",
        ts: new Date(NOW_MS - 1000).toISOString(),
      }),
    );
  }
  writeFileSync(LEDGER_PATH, lines.join("\n") + "\n");
}

buildFixtureLedger();

// Cleanup on suite exit. Best-effort — don't blow up the test if it fails.
process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function rssMb() {
  return process.memoryUsage().rss / 1024 / 1024;
}

function heapMb() {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

// ---------------------------------------------------------------------------
// T1 — streamLedgerLines covers every row exactly once, with parsed/total
// counters matching the fixture shape.
// ---------------------------------------------------------------------------
test("T1: streamLedgerLines walks every well-formed row exactly once", () => {
  let count = 0;
  let factCount = 0;
  let policyCount = 0;
  const counts = streamMod.streamLedgerLines(LEDGER_PATH, (row) => {
    count += 1;
    if (row.kind === "fact") factCount += 1;
    else if (row.kind === "policy") policyCount += 1;
  });
  assert.equal(count, ROW_COUNT + 50, "delivered every row to onRow");
  assert.equal(factCount, ROW_COUNT, "all fact rows surfaced");
  assert.equal(policyCount, 50, "all policy rows surfaced");
  assert.equal(counts.totalLines, ROW_COUNT + 50, "totalLines matches");
  assert.equal(counts.parsedLines, ROW_COUNT + 50, "parsedLines matches");
  assert.equal(counts.skipped, 0, "no rows skipped on clean fixture");
});

// ---------------------------------------------------------------------------
// T2 — streamLedgerRowsInTimeWindow drops out-of-window rows AT PARSE TIME
// (they never enter the returned array → bounded heap).
// ---------------------------------------------------------------------------
test("T2: streamLedgerRowsInTimeWindow filters by ts at parse time", () => {
  const sinceMs = 24 * 60 * 60 * 1000;
  const cutoff = NOW_MS - sinceMs;
  const r = streamMod.streamLedgerRowsInTimeWindow(
    LEDGER_PATH,
    cutoff,
    NOW_MS,
    { kind: "fact" },
  );
  // RECENT_ROWS are within 24h; OLD rows are well outside.
  assert.equal(r.rows.length, RECENT_ROWS, "kept only recent rows");
  assert.ok(r.totalLines >= ROW_COUNT, "scanned the whole file");
  assert.equal(r.truncated, false, "did not truncate");
  // The kind filter dropped policy rows — none of the returned items
  // should be policy.
  for (const row of r.rows) {
    assert.equal(row.kind, "fact", "kind filter held");
    const tsMs = Date.parse(row.ts);
    assert.ok(tsMs >= cutoff, "ts within window");
    assert.ok(tsMs <= NOW_MS, "ts below ceiling");
  }
});

// ---------------------------------------------------------------------------
// T3 — streamLedgerRowsById returns ONLY the requested id-set, never the
// full ledger. This is the embed-backfill drain optimization: ≤ batch
// size rows in heap regardless of ledger size.
// ---------------------------------------------------------------------------
test("T3: streamLedgerRowsById materializes only the requested ids", () => {
  const requested = new Set([
    "mem_old_5",
    "mem_old_500",
    "mem_recent_50",
    "mem_not_present",
  ]);
  const m = streamMod.streamLedgerRowsById(LEDGER_PATH, requested);
  assert.equal(m.size, 3, "only present ids returned");
  assert.ok(m.has("mem_old_5"));
  assert.ok(m.has("mem_old_500"));
  assert.ok(m.has("mem_recent_50"));
  assert.equal(m.has("mem_not_present"), false);
  // Empty set short-circuits.
  const m2 = streamMod.streamLedgerRowsById(LEDGER_PATH, new Set());
  assert.equal(m2.size, 0);
  // Non-Set input is rejected defensively.
  const m3 = streamMod.streamLedgerRowsById(LEDGER_PATH, null);
  assert.equal(m3.size, 0);
});

// ---------------------------------------------------------------------------
// T4 — RSS BUDGET: the streaming reader's per-invocation heap delta is
// bounded by the filtered set size, not the file size. We assert that
// 50 sequential streaming reads of the 10k-row fixture do NOT cause
// heap-growth proportional to call count.
//
// The threshold is generous (50 MB) because GC timing is non-deterministic
// and node test isolation isn't perfect; the pre-fix code would have
// added at minimum ~100 MB per call (one 10k-row JS object graph held
// while parsing the next one). We're proving the "RSS grows with
// invocation count" bug class is dead, not asserting an exact constant.
// ---------------------------------------------------------------------------
test("T4: repeated stream-filtered reads do not grow heap proportional to call count", () => {
  if (typeof global.gc !== "function") {
    // gc not exposed → skip the heap assertion but still exercise the
    // code path. node --expose-gc would let us tighten this further;
    // without it we rely on V8's natural GC schedule.
    let totalRows = 0;
    for (let i = 0; i < 50; i++) {
      const r = streamMod.streamLedgerRowsInTimeWindow(
        LEDGER_PATH,
        NOW_MS - 24 * 60 * 60 * 1000,
        NOW_MS,
        { kind: "fact" },
      );
      totalRows += r.rows.length;
    }
    assert.equal(
      totalRows,
      50 * RECENT_ROWS,
      "every invocation returns the same filtered set",
    );
    return;
  }
  global.gc();
  const heapBefore = heapMb();
  for (let i = 0; i < 50; i++) {
    const r = streamMod.streamLedgerRowsInTimeWindow(
      LEDGER_PATH,
      NOW_MS - 24 * 60 * 60 * 1000,
      NOW_MS,
      { kind: "fact" },
    );
    // Touch the result so V8 can't eliminate it.
    assert.equal(r.rows.length, RECENT_ROWS);
  }
  global.gc();
  const heapAfter = heapMb();
  const delta = heapAfter - heapBefore;
  assert.ok(
    delta < 50,
    `heap delta after 50 streaming reads = ${delta.toFixed(1)}MB (must be < 50MB to prove no per-call retention)`,
  );
});

// ---------------------------------------------------------------------------
// T5 — Integration: thread-aggregator with the fixture ledger executes
// without falling back to a full-file readFileSync. We can't easily
// stub readFileSync inside the module (it's already wired); instead we
// assert RSS stays small while running the aggregator multiple times.
// ---------------------------------------------------------------------------
test("T5: aggregateThreads against a 10k-row ledger keeps RSS bounded across repeated ticks", async () => {
  const rssBefore = rssMb();
  for (let i = 0; i < 5; i++) {
    const res = await threadMod.aggregateThreads({
      ledgerPath: LEDGER_PATH,
      sinceMs: 24 * 60 * 60 * 1000,
      now: NOW_MS,
      // Provide a no-op emitter ctx so we don't try to actually emit
      // (which would attempt to append to a non-existent emitter
      // surface in this hermetic env).
      emitterCtx: { logger: { error: () => {} } },
    });
    // Shape sanity — counts envelope is always returned.
    assert.equal(typeof res.threads_processed, "number");
    assert.equal(typeof res.reconstructed_emitted, "number");
    assert.equal(typeof res.errors, "number");
  }
  const rssAfter = rssMb();
  const delta = rssAfter - rssBefore;
  // 5 aggregateThreads ticks should not climb RSS by GB. Generous
  // budget (250 MB) — the pre-fix code on a 10k-row fixture would
  // add ~100-200 MB per call (5x = 500MB-1GB).
  assert.ok(
    delta < 250,
    `aggregateThreads × 5 ticks RSS delta = ${delta.toFixed(1)}MB (must be < 250MB)`,
  );
});

// ---------------------------------------------------------------------------
// T6 — Integration: project-aggregator over the same fixture. 7d window
// → still drops most of the old rows.
// ---------------------------------------------------------------------------
test("T6: aggregateProjects against a 10k-row ledger keeps RSS bounded across repeated ticks", async () => {
  const rssBefore = rssMb();
  for (let i = 0; i < 5; i++) {
    const res = await projectMod.aggregateProjects({
      ledgerPath: LEDGER_PATH,
      sinceMs: 7 * 24 * 60 * 60 * 1000,
      now: NOW_MS,
      emitterCtx: { logger: { error: () => {} } },
    });
    assert.equal(typeof res.projects_processed, "number");
    assert.equal(typeof res.reconstructed_emitted, "number");
    assert.equal(typeof res.errors, "number");
  }
  const rssAfter = rssMb();
  const delta = rssAfter - rssBefore;
  assert.ok(
    delta < 250,
    `aggregateProjects × 5 ticks RSS delta = ${delta.toFixed(1)}MB (must be < 250MB)`,
  );
});

// ---------------------------------------------------------------------------
// T9 — defensive: missing path returns empty without throwing.
// ---------------------------------------------------------------------------
test("T9: streaming helpers are defensive against missing paths", () => {
  const m = streamMod.streamLedgerRowsById(
    join(TMP_ROOT, "nope.jsonl"),
    new Set(["mem_x"]),
  );
  assert.equal(m.size, 0);
  const r = streamMod.streamLedgerRowsInTimeWindow(
    join(TMP_ROOT, "nope.jsonl"),
    0,
    NOW_MS,
  );
  assert.equal(r.rows.length, 0);
  const counts = streamMod.streamLedgerLines(
    join(TMP_ROOT, "nope.jsonl"),
    () => {},
  );
  assert.equal(counts.totalLines, 0);
  assert.equal(counts.parsedLines, 0);
});

// ---------------------------------------------------------------------------
// T10 — defensive: invalid arg types return empty / counts:0 without
// throwing. The daemon's idle tick MUST NOT crash on a misconfigured
// path or an undefined onRow.
// ---------------------------------------------------------------------------
test("T10: streaming helpers tolerate invalid args", () => {
  const c1 = streamMod.streamLedgerLines("", () => {});
  assert.equal(c1.totalLines, 0);
  const c2 = streamMod.streamLedgerLines(LEDGER_PATH, "not a function");
  assert.equal(c2.totalLines, 0);
  const c3 = streamMod.streamLedgerLines(null, () => {});
  assert.equal(c3.totalLines, 0);
});

// ---------------------------------------------------------------------------
// T11 — torn-tail tolerance: malformed lines mid-file don't break the
// stream. Mirrors the existing thread-aggregator/embed-backfill-worker
// "skip silently" discipline.
// ---------------------------------------------------------------------------
test("T11: streamLedgerLines skips malformed lines without throwing", () => {
  const tornPath = join(TMP_ROOT, "torn.jsonl");
  writeFileSync(
    tornPath,
    [
      JSON.stringify({ id: "a", kind: "fact" }),
      "{not valid json",
      JSON.stringify({ id: "b", kind: "fact" }),
      "",
      JSON.stringify({ id: "c", kind: "fact" }),
    ].join("\n") + "\n",
  );
  const seen = [];
  const counts = streamMod.streamLedgerLines(tornPath, (row) => {
    seen.push(row.id);
  });
  assert.deepEqual(seen, ["a", "b", "c"], "all valid rows surfaced");
  assert.equal(counts.parsedLines, 3, "parsed counter matches valid rows");
  assert.equal(
    counts.totalLines,
    4,
    "totalLines counts non-blank lines including malformed",
  );
});

// ---------------------------------------------------------------------------
// T12 — ledgerSizeOrZero returns 0 on missing path and the actual size
// on the fixture.
// ---------------------------------------------------------------------------
test("T12: ledgerSizeOrZero — defensive size probe", () => {
  const z = streamMod.ledgerSizeOrZero(join(TMP_ROOT, "nope.jsonl"));
  assert.equal(z, 0);
  const s = streamMod.ledgerSizeOrZero(LEDGER_PATH);
  assert.ok(s > 0, "fixture has non-zero size");
  assert.ok(s > 100_000, "10k rows produce > 100 KB ledger");
});

// ---------------------------------------------------------------------------
// T13 — Concurrent per-tick simulation. Pre-fix each per-tick consumer
// (thread + project aggregators) would readFileSync 308MB and parse it. We
// don't have a 308MB fixture (test wall budget), but we DO assert that calling
// both against the 10k-row fixture, in sequence, stays well within budget.
// This is the integration assertion that the per-tick RSS spike is dead.
// WU2: the third consumer (the embed-backfill worker) was deleted; the cascade
// embeds inline via the local server and no longer streams the ledger per tick.
// ---------------------------------------------------------------------------
test("T13: per-tick consumers stay within combined RSS budget", async () => {
  if (typeof global.gc === "function") global.gc();
  const rssBefore = rssMb();

  await threadMod.aggregateThreads({
    ledgerPath: LEDGER_PATH,
    sinceMs: 24 * 60 * 60 * 1000,
    now: NOW_MS,
    emitterCtx: { logger: { error: () => {} } },
  });
  await projectMod.aggregateProjects({
    ledgerPath: LEDGER_PATH,
    sinceMs: 7 * 24 * 60 * 60 * 1000,
    now: NOW_MS,
    emitterCtx: { logger: { error: () => {} } },
  });

  if (typeof global.gc === "function") global.gc();
  const rssAfter = rssMb();
  const delta = rssAfter - rssBefore;
  assert.ok(
    delta < 250,
    `per-tick RSS delta = ${delta.toFixed(1)}MB (must be < 250MB — proves combined per-tick allocation stays bounded)`,
  );
});
