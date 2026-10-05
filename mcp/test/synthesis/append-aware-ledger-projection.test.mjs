// append-aware-ledger-projection.test.mjs — WU-incrementalize-recall-recomputes
// regression gate.
//
// AUTHORITATIVE problem statement (measured grounding plan):
//   Three recall warm-path projections each recompute the full 1.82 GB ledger
//   per query because their cache keys invalidate on every daemon append. Fix:
//   an append-aware tail-merge (replicating ledger-offset-index.js) shared by
//   derivation-graph (loadOrRebuildDerivationGraph), the backfill overlay
//   (buildLatestBackfillMap), and the entity index (loadOrRebuildIndex).
//
// WHAT THIS TEST GUARDS (the reviewer will check byte-identicality):
//   (a) COLD build == full rebuild over the same file.
//   (b) After appending N rows, the tail-merged struct == a FRESH full rebuild
//       over the WHOLE file (structurally identical) — for all three
//       projections.
//   (c) FILE REPLACED / SHRUNK -> full rebuild (no stale incremental).
//   (d) TORN FINAL LINE tolerance: a half-written trailing row (no "\n") is NOT
//       applied, is re-read once its "\n" lands, and never double-applied.
//   (e) RECALL still gates correctly: a derivation-orphan candidate is still
//       excised by walkExcisePropagation over the tail-merged graph; a
//       backfilled feature is still applied by applyBackfillOverlay over the
//       tail-merged map.
//   (f) The shared helper's own branches (exact-hit / grow / shrink / mtime-
//       regression) behave as documented.
//
// HERMETICITY: mkdtempSync root; the helper takes an explicit ledgerPath so no
// env override is needed for the projection paths. We snapshot production paths
// pre/post and assert byte-identical — we NEVER touch the live ledger.
//
// Run: node test/synthesis/append-aware-ledger-projection.test.mjs

import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The checkout this suite runs from. Its default (un-overridden) ledgers,
// policy and indices are what the byte-identity guards below watch; the
// suite itself works under a temp MEMORY_ROOT.
const CHECKOUT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// ---------------------------------------------------------------------------
// Production-path snapshot BEFORE any work (hermeticity invariant).
// ---------------------------------------------------------------------------
const PROD_MEMORY_JSONL = join(CHECKOUT_ROOT, "ledgers", "memory.jsonl");
function snap(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const PROD_BEFORE = snap(PROD_MEMORY_JSONL);

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-append-aware-"));
process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ---------------------------------------------------------------------------
// Imports (the projection helpers take an explicit ledgerPath; no env needed).
// ---------------------------------------------------------------------------
const projMod = await import("../../lib/synthesis/append-aware-ledger-projection.js");
const {
  appendAwareLedgerProjection,
  _resetAppendAwareProjectionCache,
  _peekAppendAwareProjection,
} = projMod;

const dgMod = await import("../../lib/synthesis/derivation-graph.js");
const {
  loadOrRebuildDerivationGraph,
  rebuildDerivationGraph,
  walkExcisePropagation,
  _resetDerivationGraphCache,
} = dgMod;

const eiMod = await import("../../lib/synthesis/entity-index.js");
const {
  loadOrRebuildIndex,
  rebuildEntityIndex,
  lookupByEntity,
  _resetEntityIndexCache,
} = eiMod;

const mfsMod = await import("../../lib/recall/multi-feature-score.js");
const {
  buildLatestBackfillMap,
  applyBackfillOverlay,
  __resetBackfillCacheForTests,
} = mfsMod;

const fbMod = await import("../../lib/synthesis/feature-backfill.js");
const { FEATURE_BACKFILL_KIND } = fbMod;

// ---------------------------------------------------------------------------
// Fixture helpers.
// ---------------------------------------------------------------------------
const TS = "2026-06-01T00:00:00.000Z";
let counter = 0;
function freshLedgerPath() {
  counter += 1;
  return join(TMP_ROOT, `ledger-${counter}.jsonl`);
}

function factRow(id, extra = {}) {
  return { id, kind: "fact", ts: TS, created_at: TS, ...extra };
}
function reconRow(id, derivedFrom) {
  return { id, kind: "reconstructed", ts: TS, created_at: TS, derived_from: derivedFrom };
}
function entityFactRow(id, canonicalIds) {
  return factRow(id, {
    features: {
      entities: canonicalIds.map((c) => ({ kind: "person", canonical_id: c })),
    },
  });
}
function backfillRow(id, targetFactId, version, overlay) {
  return {
    id,
    kind: "policy",
    policy_kind: FEATURE_BACKFILL_KIND,
    target_fact_id: targetFactId,
    backfill_version: version,
    ts: TS,
    features_overlay: overlay,
  };
}

function writeRows(path, rows) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
}
function appendRows(path, rows) {
  appendFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
}
// Force mtime forward so a coarse-granularity FS does not mask the bump and the
// grow branch fires (st.mtimeMs >= cached.mtimeMs).
function bumpMtimeForward(path) {
  const future = new Date(Date.now() + 5000);
  utimesSync(path, future, future);
}

function adjToObj(adj) {
  const out = {};
  for (const [k, v] of adj) out[k] = Array.from(v).sort();
  return out;
}
function mapToObj(map) {
  const out = {};
  for (const [k, v] of map) out[k] = v.slice().sort();
  return out;
}

// ===========================================================================
// T1 — helper: cold build applies every row; exact-hit returns the SAME object.
// ===========================================================================
test("T1: cold build applies all rows; exact-hit returns cached identity", () => {
  _resetAppendAwareProjectionCache();
  const path = freshLedgerPath();
  writeRows(path, [factRow("a"), factRow("b"), factRow("c")]);
  const seen = [];
  const opts = {
    ledgerPath: path,
    namespace: "t1",
    makeEmpty: () => ({ ids: [] }),
    applyParsedRow: (s, row) => s.ids.push(row.id),
  };
  const s1 = appendAwareLedgerProjection(opts);
  assert.deepEqual(s1.ids, ["a", "b", "c"], "cold build applied every row in order");
  seen.push(s1.ids.length);
  // Exact hit (no file change) returns the SAME struct object — no re-scan.
  const s2 = appendAwareLedgerProjection(opts);
  assert.equal(s2, s1, "exact hit returns the identical cached struct");
  assert.deepEqual(s2.ids, ["a", "b", "c"], "exact hit did not re-apply rows");
});

// ===========================================================================
// T2 — helper: append growth tail-merges ONLY the appended rows (no re-scan of
// the prefix), and the result equals a fresh full rebuild.
// ===========================================================================
test("T2: append-growth tail-merge applies only the appended tail", () => {
  _resetAppendAwareProjectionCache();
  const path = freshLedgerPath();
  writeRows(path, [factRow("a"), factRow("b")]);
  const applied = [];
  const opts = {
    ledgerPath: path,
    namespace: "t2",
    makeEmpty: () => ({ ids: [] }),
    applyParsedRow: (s, row) => {
      applied.push(row.id);
      s.ids.push(row.id);
    },
  };
  const s1 = appendAwareLedgerProjection(opts);
  assert.deepEqual(s1.ids, ["a", "b"], "cold build");
  assert.deepEqual(applied, ["a", "b"], "cold build applied a,b");

  appendRows(path, [factRow("c"), factRow("d")]);
  bumpMtimeForward(path);
  const s2 = appendAwareLedgerProjection(opts);
  assert.equal(s2, s1, "grow branch reused the same cached struct (no rebuild)");
  assert.deepEqual(s2.ids, ["a", "b", "c", "d"], "tail-merge appended c,d");
  // The tail-merge applied ONLY c,d — the prefix a,b was NOT re-applied.
  assert.deepEqual(applied, ["a", "b", "c", "d"], "prefix rows not re-applied on grow");
});

// ===========================================================================
// T3 — helper: file SHRINK / mtime-regression -> full rebuild (no stale data).
// ===========================================================================
test("T3: shrink and mtime-regression force a full rebuild", () => {
  _resetAppendAwareProjectionCache();
  const path = freshLedgerPath();
  writeRows(path, [factRow("a"), factRow("b"), factRow("c")]);
  const opts = {
    ledgerPath: path,
    namespace: "t3",
    makeEmpty: () => ({ ids: [] }),
    applyParsedRow: (s, row) => s.ids.push(row.id),
  };
  const s1 = appendAwareLedgerProjection(opts);
  assert.deepEqual(s1.ids, ["a", "b", "c"]);

  // SHRINK: replace with a smaller file (truncation / rotation).
  writeRows(path, [factRow("z")]);
  bumpMtimeForward(path);
  const s2 = appendAwareLedgerProjection(opts);
  assert.notEqual(s2, s1, "shrink produced a fresh struct (full rebuild)");
  assert.deepEqual(s2.ids, ["z"], "shrink rebuilt from byte 0, no stale a,b,c");

  // MTIME REGRESSION: same/larger size but mtime moves backward.
  writeRows(path, [factRow("p"), factRow("q"), factRow("r"), factRow("s")]);
  const past = new Date(Date.now() - 60_000);
  utimesSync(path, past, past);
  const s3 = appendAwareLedgerProjection(opts);
  assert.notEqual(s3, s2, "mtime regression produced a fresh struct");
  assert.deepEqual(s3.ids, ["p", "q", "r", "s"], "mtime regression rebuilt from byte 0");
});

// ===========================================================================
// T4 — helper: TORN FINAL LINE tolerance. A half-written trailing row (no
// terminating "\n") is NOT applied; once its "\n" lands it is applied exactly
// once; the cached safeOffset never advances past a torn line.
// ===========================================================================
test("T4: torn final line is not applied, then applied exactly once when completed", () => {
  _resetAppendAwareProjectionCache();
  const path = freshLedgerPath();
  writeRows(path, [factRow("a"), factRow("b")]); // a\nb\n
  const applied = [];
  const opts = {
    ledgerPath: path,
    namespace: "t4",
    makeEmpty: () => ({ ids: [] }),
    applyParsedRow: (s, row) => {
      applied.push(row.id);
      s.ids.push(row.id);
    },
  };
  const s1 = appendAwareLedgerProjection(opts);
  assert.deepEqual(s1.ids, ["a", "b"], "cold build a,b");
  const peek1 = _peekAppendAwareProjection("t4", path);
  const safeAfterColdBuild = peek1.safeOffset;
  assert.equal(safeAfterColdBuild, peek1.size, "safeOffset == size when file ends in newline");

  // Append a TORN row: the JSON of "c" WITHOUT a terminating newline.
  appendFileSync(path, JSON.stringify(factRow("c")), { mode: 0o600 }); // ...c (no \n)
  bumpMtimeForward(path);
  const s2 = appendAwareLedgerProjection(opts);
  assert.deepEqual(s2.ids, ["a", "b"], "torn trailing line c is NOT applied");
  assert.deepEqual(applied, ["a", "b"], "torn line never reached applyParsedRow");
  const peek2 = _peekAppendAwareProjection("t4", path);
  assert.equal(
    peek2.safeOffset,
    safeAfterColdBuild,
    "safeOffset did NOT advance past the torn line",
  );
  assert.ok(peek2.size > peek2.safeOffset, "size advanced past the torn bytes; safeOffset did not");

  // Now the daemon finishes the row: append the trailing "\n".
  appendFileSync(path, "\n", { mode: 0o600 });
  bumpMtimeForward(path);
  const s3 = appendAwareLedgerProjection(opts);
  assert.deepEqual(s3.ids, ["a", "b", "c"], "completed line c applied once");
  assert.deepEqual(applied, ["a", "b", "c"], "c applied EXACTLY once (no double-apply)");
});

// ===========================================================================
// T4b — PREFIX-DRIFT GUARD: an in-place rewrite that GROWS the file and bumps
// mtime but CHANGES the already-applied prefix bytes must NOT tail-merge onto a
// stale prefix — the boundary guard forces a full rebuild. (Guards the
// forgetting-propagation cross-subtest re-seed corruption class.)
// ===========================================================================
test("T4b: in-place rewrite with a drifted prefix forces a full rebuild (no stale merge)", () => {
  _resetAppendAwareProjectionCache();
  const path = freshLedgerPath();
  writeRows(path, [factRow("a"), factRow("b")]);
  const opts = {
    ledgerPath: path,
    namespace: "t4b",
    makeEmpty: () => ({ ids: [] }),
    applyParsedRow: (s, row) => s.ids.push(row.id),
  };
  const s1 = appendAwareLedgerProjection(opts);
  assert.deepEqual(s1.ids, ["a", "b"], "cold build a,b");

  // In-place REWRITE: different content, larger file, mtime bumped forward.
  // The naive size>cached.size && mtime>=cached.mtimeMs heuristic would treat
  // this as append-only growth and tail-merge onto the stale [a,b] prefix.
  writeRows(path, [factRow("x"), factRow("y"), factRow("z")]);
  bumpMtimeForward(path);
  const s2 = appendAwareLedgerProjection(opts);
  assert.notEqual(s2, s1, "prefix drift produced a FRESH struct (full rebuild)");
  assert.deepEqual(
    s2.ids,
    ["x", "y", "z"],
    "rebuilt from byte 0 — NO stale a,b carried over",
  );
});

// ===========================================================================
// T5 — DERIVATION-GRAPH: cold == full rebuild; tail-merge == fresh full rebuild.
// ===========================================================================
test("T5: derivation-graph tail-merge == fresh full rebuild (byte-identical adjacency)", async () => {
  _resetDerivationGraphCache();
  const path = freshLedgerPath();
  writeRows(path, [
    factRow("f1"),
    factRow("f2"),
    reconRow("r1", ["f1"]),
  ]);
  const cold = await loadOrRebuildDerivationGraph({ ledgerPath: path });
  const fullCold = await rebuildDerivationGraph({ ledgerPath: path });
  assert.deepEqual(adjToObj(cold.forwardAdj), adjToObj(fullCold.forwardAdj), "cold forwardAdj == full");
  assert.deepEqual(adjToObj(cold.reverseAdj), adjToObj(fullCold.reverseAdj), "cold reverseAdj == full");
  assert.deepEqual(
    Object.fromEntries(cold.kindOf),
    Object.fromEntries(fullCold.kindOf),
    "cold kindOf == full",
  );

  // Append more derivation rows and tail-merge.
  appendRows(path, [
    reconRow("r2", ["r1"]),
    reconRow("r3", ["f2", "r2"]),
  ]);
  bumpMtimeForward(path);
  const merged = await loadOrRebuildDerivationGraph({ ledgerPath: path });
  // Fresh full rebuild over the WHOLE file (cleared cache).
  _resetDerivationGraphCache();
  const freshFull = await rebuildDerivationGraph({ ledgerPath: path });
  assert.deepEqual(
    adjToObj(merged.forwardAdj),
    adjToObj(freshFull.forwardAdj),
    "tail-merged forwardAdj is byte-identical to a fresh full rebuild",
  );
  assert.deepEqual(
    adjToObj(merged.reverseAdj),
    adjToObj(freshFull.reverseAdj),
    "tail-merged reverseAdj is byte-identical to a fresh full rebuild",
  );
  assert.deepEqual(
    Object.fromEntries(merged.kindOf),
    Object.fromEntries(freshFull.kindOf),
    "tail-merged kindOf is byte-identical to a fresh full rebuild",
  );
});

// ===========================================================================
// T6 — RECALL GATING (derivation): a reconstructed candidate whose only parent
// is an excised root is still reached by walkExcisePropagation over the
// TAIL-MERGED graph (the orphan-excise gate still fires).
// ===========================================================================
test("T6: derivation-orphan candidate still excised over the tail-merged graph", async () => {
  _resetDerivationGraphCache();
  const path = freshLedgerPath();
  // f_root is the excise seed; r_child derives from it.
  writeRows(path, [factRow("f_root"), reconRow("r_child", ["f_root"])]);
  await loadOrRebuildDerivationGraph({ ledgerPath: path }); // prime the cache

  // Daemon appends a grandchild via tail-merge.
  appendRows(path, [reconRow("r_grandchild", ["r_child"])]);
  bumpMtimeForward(path);
  const graph = await loadOrRebuildDerivationGraph({ ledgerPath: path });

  // Excise propagation from the seed must reach BOTH the appended grandchild
  // and the original child — proving the tail-merged reverseAdj is complete.
  const reached = new Set();
  for (const d of walkExcisePropagation(graph, "f_root")) reached.add(d.memoryId);
  assert.ok(reached.has("r_child"), "direct child excised");
  assert.ok(reached.has("r_grandchild"), "tail-merged grandchild excised (gate still fires)");
});

// ===========================================================================
// T7 — BACKFILL OVERLAY: tail-merge == fresh full rebuild; latest-wins holds
// across the merge; the backfilled feature is still applied to a candidate.
// ===========================================================================
test("T7: backfill overlay tail-merge == full rebuild; overlay still applies", () => {
  __resetBackfillCacheForTests();
  const path = freshLedgerPath();
  writeRows(path, [
    factRow("fact_1"),
    backfillRow("bf_1_v1", "fact_1", 1, { entities: [{ canonical_id: "person:v1" }] }),
  ]);
  const m1 = buildLatestBackfillMap(path);
  assert.equal(m1.size, 1, "cold: one backfill entry");
  assert.equal(m1.get("fact_1").backfill_version, 1, "cold: v1 present");

  // Append a v2 backfill for the same fact, plus a NEW fact's backfill.
  appendRows(path, [
    backfillRow("bf_1_v2", "fact_1", 2, { entities: [{ canonical_id: "person:v2" }] }),
    backfillRow("bf_2_v1", "fact_2", 1, { entities: [{ canonical_id: "org:acme" }] }),
  ]);
  bumpMtimeForward(path);
  const m2 = buildLatestBackfillMap(path);
  assert.equal(m2.get("fact_1").backfill_version, 2, "tail-merge: latest-wins -> v2 overrides v1");
  assert.equal(m2.get("fact_2").backfill_version, 1, "tail-merge: new target added");

  // Compare to a fresh full rebuild over the whole file (cleared cache).
  __resetBackfillCacheForTests();
  const freshFull = buildLatestBackfillMap(path);
  assert.deepEqual(
    [...m2.keys()].sort(),
    [...freshFull.keys()].sort(),
    "tail-merged key set == fresh full rebuild key set",
  );
  assert.equal(
    m2.get("fact_1").id,
    freshFull.get("fact_1").id,
    "tail-merged winner == full-rebuild winner for fact_1",
  );

  // (e) The backfilled feature is still APPLIED to a candidate via the overlay.
  const candidate = { id: "fact_1", memory_id: "fact_1", features: {} };
  const overlaid = applyBackfillOverlay(candidate, m2);
  assert.notEqual(overlaid, candidate, "overlay returns a NEW candidate (no mutation)");
  assert.deepEqual(
    candidate.features,
    {},
    "original candidate features NOT mutated (thesis #1)",
  );
  assert.deepEqual(
    overlaid.entities,
    ["person:v2"],
    "v2 entity overlay applied to the candidate (latest-wins post tail-merge)",
  );
});

// ===========================================================================
// T8 — ENTITY-INDEX: cold == full rebuild; tail-merge == fresh full rebuild;
// lookup over the tail-merged buckets resolves appended rows.
// ===========================================================================
test("T8: entity-index tail-merge == fresh full rebuild; lookup resolves appended rows", async () => {
  _resetEntityIndexCache();
  const path = freshLedgerPath();
  const cachePath = join(TMP_ROOT, `entity-cache-${counter}.json`);
  writeRows(path, [
    entityFactRow("m1", ["person:alice"]),
    entityFactRow("m2", ["person:bob", "org:acme"]),
  ]);
  const cold = await loadOrRebuildIndex({ ledgerPath: path, cachePath });
  const fullCold = await rebuildEntityIndex({ ledgerPath: path });
  assert.deepEqual(
    mapToObj(cold.entitiesByCanonicalId),
    mapToObj(fullCold.entitiesByCanonicalId),
    "cold entity buckets == full rebuild",
  );

  // Append rows that ADD to an existing bucket and a NEW bucket.
  appendRows(path, [
    entityFactRow("m3", ["person:alice"]),
    entityFactRow("m4", ["person:carol"]),
  ]);
  bumpMtimeForward(path);
  const merged = await loadOrRebuildIndex({ ledgerPath: path, cachePath });
  assert.deepEqual(
    lookupByEntity(merged, "person:alice").sort(),
    ["m1", "m3"],
    "tail-merge ADDED m3 into the existing alice bucket",
  );
  assert.deepEqual(
    lookupByEntity(merged, "person:carol"),
    ["m4"],
    "tail-merge created the new carol bucket",
  );

  // Fresh full rebuild over the whole file (cleared cache) — byte-identical.
  _resetEntityIndexCache();
  const freshFull = await rebuildEntityIndex({ ledgerPath: path });
  assert.deepEqual(
    mapToObj(merged.entitiesByCanonicalId),
    mapToObj(freshFull.entitiesByCanonicalId),
    "tail-merged entity buckets are byte-identical to a fresh full rebuild",
  );
});

// ===========================================================================
// T9 — HERMETICITY: the live production ledger was never touched.
// ===========================================================================
test("T9: production ledger untouched (hermeticity)", () => {
  assert.equal(snap(PROD_MEMORY_JSONL), PROD_BEFORE, "live memory.jsonl unchanged");
});
