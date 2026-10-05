// time-index.test.mjs — F-SYN-SUBSTRATE-TIME-INDEX substrate verification.
//
// Coverage matrix:
//   T1  module surface
//   T2  rebuild on a fixture ledger with mixed time_anchors[] shapes
//   T3  multi-anchor row produces multiple sorted entries pointing back
//       to one memory_id (review_question §1)
//   T4  queryTimeRange windows the sorted structure correctly
//   T5  queryProximity returns nearest first with deterministic tie-break
//   T6  queryProximity honors window_ms and max_results
//   T7  cache hit when ledger mtime unchanged
//   T8  cache invalidated when ledger mtime/size changes
//   T9  persistTimeIndex + reload round-trip yields byte-identical structure
//   T10 malformed anchors / recurring anchors are silently skipped
//   T11 foundation-schema shape (parsed.iso) accepted in addition to the
//       resolver-substrate flat shape (instant_iso)
//
// Run: node --test test/synthesis/time-index.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic env (mirrors other synthesis-tier tests).
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-time-index-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");

mkdirSync(MEMORY_ROOT, { recursive: true });

const {
  TIME_INDEX_VERSION,
  TIME_ANCHOR_KINDS,
  TIME_BUCKET_THRESHOLDS_MS,
  rebuildTimeIndex,
  loadOrRebuildTimeIndex,
  persistTimeIndex,
  queryTimeRange,
  queryProximity,
  __internal,
} = await import("../../lib/synthesis/time-index.js");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Write a JSONL ledger to a fresh path under TMP_ROOT.
 * Returns the absolute path.
 */
function writeLedger(name, rows) {
  const dir = join(TMP_ROOT, "ledgers");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path, text, "utf8");
  return path;
}

/**
 * Build a sample row carrying features.time_anchors[].
 */
function makeRow(id, anchors, extras = {}) {
  return {
    id,
    kind: extras.kind || "fact",
    created_at: extras.created_at || "2026-01-01T00:00:00Z",
    content: extras.content || `content for ${id}`,
    features: { time_anchors: anchors },
    ...extras,
  };
}

// Anchors in the resolver-substrate shape (flat instant_iso).
function flatAnchor(instant_iso, kind = "absolute") {
  return {
    kind,
    instant_iso,
    duration_ms: null,
    raw_phrase: `${instant_iso}`,
    span: [0, 0],
    confidence: 0.95,
  };
}

// Anchors in the foundation-schema shape (parsed.iso).
function schemaAnchor(parsedIso, kind = "relative") {
  return {
    kind,
    raw_phrase: `parsed at ${parsedIso}`,
    parsed: {
      iso: parsedIso,
      offset_from: "event_ts",
      offset_seconds: 0,
    },
    extractor_confidence: 0.92,
    extractor_version: "chrono-node@2.7.4+lex-v1",
  };
}

// ---------------------------------------------------------------------------
// T1 — module surface
// ---------------------------------------------------------------------------

test("T1: exports the documented public surface", () => {
  assert.equal(TIME_INDEX_VERSION, "v1");
  assert.ok(Array.isArray(TIME_ANCHOR_KINDS));
  for (const k of ["absolute", "relative", "recurring"]) {
    assert.ok(TIME_ANCHOR_KINDS.includes(k), `missing kind ${k}`);
  }
  // bucket thresholds are frozen
  assert.equal(Object.isFrozen(TIME_BUCKET_THRESHOLDS_MS), true);
  assert.equal(TIME_BUCKET_THRESHOLDS_MS.day, 86_400_000);
  assert.equal(typeof rebuildTimeIndex, "function");
  assert.equal(typeof loadOrRebuildTimeIndex, "function");
  assert.equal(typeof persistTimeIndex, "function");
  assert.equal(typeof queryTimeRange, "function");
  assert.equal(typeof queryProximity, "function");
});

// ---------------------------------------------------------------------------
// T2 — rebuild on a fixture ledger
// ---------------------------------------------------------------------------

test("T2: rebuildTimeIndex parses a JSONL ledger with mixed anchor shapes", async () => {
  const path = writeLedger("t2.jsonl", [
    makeRow("mem_a", [flatAnchor("2026-06-15T12:00:00Z")]),
    makeRow("mem_b", [schemaAnchor("2026-06-20T08:30:00Z", "relative")]),
    // A row with no anchors — must be skipped.
    { id: "mem_c", kind: "fact", features: {} },
  ]);
  const idx = await rebuildTimeIndex({ ledgerPath: path });
  assert.equal(idx.schema_version, "v1");
  assert.ok(idx.byMemoryId instanceof Map);
  assert.equal(idx.byMemoryId.size, 2);
  assert.equal(idx.sortedByInstant.length, 2);
  // Sorted ascending by instant_iso (which matches instant_ms ordering
  // because both anchors are in UTC).
  assert.ok(
    idx.sortedByInstant[0].instant_iso < idx.sortedByInstant[1].instant_iso,
    "sorted ascending",
  );
  // mem_c has no anchors → not in the byMemoryId map.
  assert.equal(idx.byMemoryId.has("mem_c"), false);
});

// ---------------------------------------------------------------------------
// T3 — multi-anchor row (review_question §1)
// ---------------------------------------------------------------------------

test("T3: a single row with multiple anchors produces one sorted entry per anchor pointing to the same memory_id", async () => {
  const path = writeLedger("t3.jsonl", [
    makeRow("mem_multi", [
      flatAnchor("2026-01-15T00:00:00Z", "absolute"),
      flatAnchor("2026-03-20T00:00:00Z", "absolute"),
      flatAnchor("2026-08-01T00:00:00Z", "relative"),
    ]),
  ]);
  const idx = await rebuildTimeIndex({ ledgerPath: path });
  assert.equal(idx.sortedByInstant.length, 3);
  for (const e of idx.sortedByInstant) {
    assert.equal(e.memory_id, "mem_multi");
  }
  // byMemoryId carries the per-row list, also length 3.
  assert.equal(idx.byMemoryId.get("mem_multi").length, 3);
  // Strict ascending by instant_iso.
  const isos = idx.sortedByInstant.map((e) => e.instant_iso);
  const sorted = [...isos].sort();
  assert.deepEqual(isos, sorted);
});

// ---------------------------------------------------------------------------
// T4 — queryTimeRange windows correctly
// ---------------------------------------------------------------------------

test("T4: queryTimeRange returns memory_ids whose anchors fall in the [start, end] window", async () => {
  const path = writeLedger("t4.jsonl", [
    makeRow("mem_jan", [flatAnchor("2026-01-15T00:00:00Z")]),
    makeRow("mem_jun", [flatAnchor("2026-06-15T00:00:00Z")]),
    makeRow("mem_dec", [flatAnchor("2026-12-15T00:00:00Z")]),
  ]);
  const idx = await rebuildTimeIndex({ ledgerPath: path });
  // 1-day window in June.
  const dayWindow = queryTimeRange(idx, {
    start_iso: "2026-06-15T00:00:00Z",
    end_iso: "2026-06-15T23:59:59Z",
  });
  assert.deepEqual(dayWindow, ["mem_jun"]);
  // Full-year window.
  const yearWindow = queryTimeRange(idx, {
    start_iso: "2026-01-01T00:00:00Z",
    end_iso: "2026-12-31T23:59:59Z",
  });
  assert.deepEqual(yearWindow, ["mem_dec", "mem_jan", "mem_jun"]);
  // Empty window (end < start).
  const inverted = queryTimeRange(idx, {
    start_iso: "2026-07-01T00:00:00Z",
    end_iso: "2026-06-01T00:00:00Z",
  });
  assert.deepEqual(inverted, []);
});

test("T4b: queryTimeRange filters by kinds when supplied", async () => {
  const path = writeLedger("t4b.jsonl", [
    makeRow("mem_abs", [flatAnchor("2026-06-15T00:00:00Z", "absolute")]),
    makeRow("mem_rel", [flatAnchor("2026-06-15T01:00:00Z", "relative")]),
  ]);
  const idx = await rebuildTimeIndex({ ledgerPath: path });
  const absOnly = queryTimeRange(idx, {
    start_iso: "2026-06-15T00:00:00Z",
    end_iso: "2026-06-15T23:59:59Z",
    kinds: ["absolute"],
  });
  assert.deepEqual(absOnly, ["mem_abs"]);
  const both = queryTimeRange(idx, {
    start_iso: "2026-06-15T00:00:00Z",
    end_iso: "2026-06-15T23:59:59Z",
    kinds: ["absolute", "relative"],
  });
  assert.deepEqual(both, ["mem_abs", "mem_rel"]);
});

// ---------------------------------------------------------------------------
// T5 — queryProximity nearest-first
// ---------------------------------------------------------------------------

test("T5: queryProximity returns nearest anchors first with deterministic tie-break", async () => {
  const path = writeLedger("t5.jsonl", [
    makeRow("mem_far_past", [flatAnchor("2025-06-01T00:00:00Z")]),
    makeRow("mem_near_before", [flatAnchor("2026-06-17T22:00:00Z")]),
    makeRow("mem_near_after", [flatAnchor("2026-06-18T02:00:00Z")]),
    makeRow("mem_far_future", [flatAnchor("2027-01-01T00:00:00Z")]),
  ]);
  const idx = await rebuildTimeIndex({ ledgerPath: path });
  const results = queryProximity(idx, {
    target_iso: "2026-06-18T00:00:00Z",
    max_results: 4,
  });
  assert.equal(results.length, 4);
  // Distances are ascending.
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i - 1].distance_ms <= results[i].distance_ms,
      `distances not ascending at idx ${i}: ${JSON.stringify(results)}`,
    );
  }
  // Nearest pair (each 2h off — 7,200,000 ms) — tie-break by memory_id ASC
  // puts mem_near_after before mem_near_before (alphabetical on the
  // "_after" suffix).
  assert.equal(results[0].distance_ms, 2 * 60 * 60 * 1000);
  assert.equal(results[1].distance_ms, 2 * 60 * 60 * 1000);
  assert.deepEqual(
    [results[0].memory_id, results[1].memory_id].sort(),
    ["mem_near_after", "mem_near_before"],
  );
  // Each result carries anchor_kind.
  for (const r of results) {
    assert.ok(TIME_ANCHOR_KINDS.includes(r.anchor_kind));
  }
});

// ---------------------------------------------------------------------------
// T6 — queryProximity honors window_ms + max_results
// ---------------------------------------------------------------------------

test("T6: queryProximity drops entries beyond window_ms and respects max_results", async () => {
  const path = writeLedger("t6.jsonl", [
    makeRow("mem_a", [flatAnchor("2026-06-17T23:00:00Z")]), // 1h before
    makeRow("mem_b", [flatAnchor("2026-06-18T01:00:00Z")]), // 1h after
    makeRow("mem_c", [flatAnchor("2026-06-19T00:00:00Z")]), // 24h after
    makeRow("mem_d", [flatAnchor("2026-06-25T00:00:00Z")]), // 7d after
  ]);
  const idx = await rebuildTimeIndex({ ledgerPath: path });
  // Window: ±2 hours. Should pick up mem_a and mem_b only.
  const within2h = queryProximity(idx, {
    target_iso: "2026-06-18T00:00:00Z",
    window_ms: 2 * 60 * 60 * 1000,
    max_results: 12,
  });
  const within2hIds = within2h.map((r) => r.memory_id).sort();
  assert.deepEqual(within2hIds, ["mem_a", "mem_b"]);
  // max_results = 1 → only the very nearest survives.
  const top1 = queryProximity(idx, {
    target_iso: "2026-06-18T00:00:00Z",
    max_results: 1,
  });
  assert.equal(top1.length, 1);
});

// ---------------------------------------------------------------------------
// T7 — cache hit on unchanged ledger
// ---------------------------------------------------------------------------

test("T7: loadOrRebuildTimeIndex returns the cached payload when ledger fingerprint matches", async () => {
  const path = writeLedger("t7.jsonl", [
    makeRow("mem_q", [flatAnchor("2026-06-15T00:00:00Z")]),
  ]);
  const cachePath = join(TMP_ROOT, "cache", "t7-cache.json");

  const first = await loadOrRebuildTimeIndex({ ledgerPath: path, cachePath });
  assert.equal(first.sortedByInstant.length, 1);
  assert.ok(existsSync(cachePath), "persistTimeIndex should have written cache");

  // Load again — should hit cache and return the same structure.
  const second = await loadOrRebuildTimeIndex({ ledgerPath: path, cachePath });
  assert.equal(second.sortedByInstant.length, 1);
  assert.equal(second.ledger_mtime_ms, first.ledger_mtime_ms);
  assert.equal(second.ledger_size, first.ledger_size);
  assert.equal(second.built_at, first.built_at, "byte-stable across reloads");
});

// ---------------------------------------------------------------------------
// T8 — cache invalidation on ledger change
// ---------------------------------------------------------------------------

test("T8: cache invalidates when ledger mtime/size changes", async () => {
  const path = writeLedger("t8.jsonl", [
    makeRow("mem_one", [flatAnchor("2026-06-15T00:00:00Z")]),
  ]);
  const cachePath = join(TMP_ROOT, "cache", "t8-cache.json");
  const first = await loadOrRebuildTimeIndex({ ledgerPath: path, cachePath });
  assert.equal(first.sortedByInstant.length, 1);
  // Append a row and bump mtime forward.
  writeLedger("t8.jsonl", [
    makeRow("mem_one", [flatAnchor("2026-06-15T00:00:00Z")]),
    makeRow("mem_two", [flatAnchor("2026-07-15T00:00:00Z")]),
  ]);
  // Force mtime to advance even on coarse-granularity filesystems.
  const future = new Date(Date.now() + 5_000);
  utimesSync(path, future, future);

  const second = await loadOrRebuildTimeIndex({ ledgerPath: path, cachePath });
  assert.equal(second.sortedByInstant.length, 2);
  assert.notEqual(second.ledger_mtime_ms, first.ledger_mtime_ms);
});

// ---------------------------------------------------------------------------
// T9 — persist + reload round-trip
// ---------------------------------------------------------------------------

test("T9: persistTimeIndex + read back yields byte-identical sortedByInstant", async () => {
  const path = writeLedger("t9.jsonl", [
    makeRow("mem_a", [flatAnchor("2026-01-01T00:00:00Z")]),
    makeRow("mem_b", [flatAnchor("2026-06-01T00:00:00Z"), flatAnchor("2026-09-01T00:00:00Z")]),
  ]);
  const cachePath = join(TMP_ROOT, "cache", "t9-cache.json");
  const idx = await rebuildTimeIndex({ ledgerPath: path });
  await persistTimeIndex(idx, cachePath);
  assert.ok(existsSync(cachePath));
  const raw = readFileSync(cachePath, "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.schema_version, "v1");
  assert.equal(parsed.sorted.length, 3);
  // Reload via loadOrRebuildTimeIndex — should hit cache (fingerprint matches).
  const reloaded = await loadOrRebuildTimeIndex({ ledgerPath: path, cachePath });
  assert.deepEqual(reloaded.sortedByInstant, idx.sortedByInstant);
  assert.equal(reloaded.byMemoryId.get("mem_b").length, 2);
});

// ---------------------------------------------------------------------------
// T10 — malformed + recurring anchors skipped
// ---------------------------------------------------------------------------

test("T10: malformed instants and recurring anchors are silently skipped", async () => {
  const path = writeLedger("t10.jsonl", [
    makeRow("mem_good", [flatAnchor("2026-06-15T00:00:00Z")]),
    makeRow("mem_bad_iso", [{
      kind: "absolute",
      instant_iso: "not-a-date",
      duration_ms: null,
      raw_phrase: "garbage",
      span: [0, 0],
      confidence: 0.1,
    }]),
    makeRow("mem_recurring", [{
      kind: "recurring",
      instant_iso: null,
      duration_ms: null,
      raw_phrase: "every Tuesday",
      span: [0, 0],
      confidence: 0.9,
    }]),
    makeRow("mem_unknown_kind", [{
      kind: "fake_kind",
      instant_iso: "2026-06-15T00:00:00Z",
      duration_ms: null,
      raw_phrase: "x",
      span: [0, 0],
      confidence: 0.5,
    }]),
  ]);
  const idx = await rebuildTimeIndex({ ledgerPath: path });
  const memoryIds = [...idx.byMemoryId.keys()].sort();
  assert.deepEqual(memoryIds, ["mem_good"]);
  assert.equal(idx.sortedByInstant.length, 1);
});

// ---------------------------------------------------------------------------
// T11 — accepts foundation-schema parsed.iso shape
// ---------------------------------------------------------------------------

test("T11: anchors with foundation-schema parsed.iso are indexed alongside resolver-flat anchors", async () => {
  const path = writeLedger("t11.jsonl", [
    makeRow("mem_flat", [flatAnchor("2026-06-10T00:00:00Z", "absolute")]),
    makeRow("mem_schema", [schemaAnchor("2026-06-12T00:00:00Z", "relative")]),
  ]);
  const idx = await rebuildTimeIndex({ ledgerPath: path });
  assert.equal(idx.sortedByInstant.length, 2);
  const ids = idx.sortedByInstant.map((e) => e.memory_id).sort();
  assert.deepEqual(ids, ["mem_flat", "mem_schema"]);
});

// ---------------------------------------------------------------------------
// T12 — corrupt cache forces rebuild (spec error-modes section)
// ---------------------------------------------------------------------------

test("T12: a corrupt cache file triggers a full rebuild rather than throwing", async () => {
  const path = writeLedger("t12.jsonl", [
    makeRow("mem_x", [flatAnchor("2026-06-15T00:00:00Z")]),
  ]);
  const cachePath = join(TMP_ROOT, "cache", "t12-cache.json");
  mkdirSync(join(TMP_ROOT, "cache"), { recursive: true });
  writeFileSync(cachePath, "not-json-at-all", "utf8");
  const idx = await loadOrRebuildTimeIndex({ ledgerPath: path, cachePath });
  assert.equal(idx.sortedByInstant.length, 1);
  // After the rebuild, the cache should now be valid.
  const reloaded = await loadOrRebuildTimeIndex({ ledgerPath: path, cachePath });
  assert.deepEqual(reloaded.sortedByInstant, idx.sortedByInstant);
});

// ---------------------------------------------------------------------------
// T13 — determinism: two rebuilds from the same ledger produce identical
//        sortedByInstant + built_at (review_question §2 / spec determinism)
// ---------------------------------------------------------------------------

test("T13: two rebuilds against the same ledger snapshot produce byte-identical sortedByInstant", async () => {
  const path = writeLedger("t13.jsonl", [
    makeRow("mem_b", [flatAnchor("2026-06-15T00:00:00Z")]),
    makeRow("mem_a", [flatAnchor("2026-06-15T00:00:00Z")]), // tie at same instant
    makeRow("mem_c", [flatAnchor("2026-06-15T00:00:00Z")]),
  ]);
  const idx1 = await rebuildTimeIndex({ ledgerPath: path });
  const idx2 = await rebuildTimeIndex({ ledgerPath: path });
  assert.deepEqual(idx1.sortedByInstant, idx2.sortedByInstant);
  assert.equal(idx1.built_at, idx2.built_at);
  // Tie-break on memory_id ASC: mem_a precedes mem_b precedes mem_c at the
  // same instant.
  assert.deepEqual(
    idx1.sortedByInstant.map((e) => e.memory_id),
    ["mem_a", "mem_b", "mem_c"],
  );
});

// ---------------------------------------------------------------------------
// T14 — empty / missing ledger paths handled gracefully
// ---------------------------------------------------------------------------

test("T14: a missing ledger file produces an empty index, never throws", async () => {
  const idx = await rebuildTimeIndex({ ledgerPath: join(TMP_ROOT, "does-not-exist.jsonl") });
  assert.equal(idx.sortedByInstant.length, 0);
  assert.equal(idx.byMemoryId.size, 0);
  assert.equal(idx.ledger_size, 0);
});

// ---------------------------------------------------------------------------
// T15 — __internal binary search behaves correctly
// ---------------------------------------------------------------------------

test("T15: __internal.binarySearch is correct on bound predicates", () => {
  const arr = [1, 3, 5, 7, 9, 11];
  // Find first idx where x >= 5 → 2
  assert.equal(__internal.binarySearch(arr, (x) => x >= 5), 2);
  // Find first idx where x > 11 → 6 (past end)
  assert.equal(__internal.binarySearch(arr, (x) => x > 11), 6);
  // Find first idx where x >= -100 → 0
  assert.equal(__internal.binarySearch(arr, (x) => x >= -100), 0);
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});
