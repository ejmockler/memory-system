// derivation-graph.test.mjs — coverage for the substrate-tier derivation
// graph module (F-SYN-SUBSTRATE-DERIVATION-GRAPH).
//
// Run: node --test test/synthesis/derivation-graph.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic env: pin MEMORY_ROOT etc BEFORE the dynamic import below so any
// module-init side effects (none expected today, but defensively the
// convention) see a sandboxed root.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-dg-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");

const mod = await import("../../lib/synthesis/derivation-graph.js");
const {
  PROPAGATION_DEPTH_MAX,
  DECAY_PER_HOP,
  THRESHOLD_FLOOR,
  DERIVATION_GRAPH_SCHEMA_VERSION,
  rebuildDerivationGraph,
  loadOrRebuildDerivationGraph,
  walkExcisePropagation,
  walkEngagementPropagation,
  detectCycles,
  persistGraphCache,
} = mod;

function ensureDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function writeRows(ledgerPath, rows) {
  writeFileSync(
    ledgerPath,
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    { mode: 0o600 },
  );
}

// ---------------------------------------------------------------------------
// T1: surface + constants
// ---------------------------------------------------------------------------
test("constants are pinned to spec values", () => {
  assert.equal(PROPAGATION_DEPTH_MAX, 3, "PROPAGATION_DEPTH_MAX === 3");
  assert.equal(DECAY_PER_HOP, 0.5, "DECAY_PER_HOP === 0.5");
  assert.equal(THRESHOLD_FLOOR, 0.01, "THRESHOLD_FLOOR === 0.01");
  assert.equal(DERIVATION_GRAPH_SCHEMA_VERSION, "v2", "schema version is v2 (R2/WI1 sectioned binary)");
  assert.equal(typeof rebuildDerivationGraph, "function");
  assert.equal(typeof loadOrRebuildDerivationGraph, "function");
  assert.equal(typeof walkExcisePropagation, "function");
  assert.equal(typeof walkEngagementPropagation, "function");
  assert.equal(typeof detectCycles, "function");
  assert.equal(typeof persistGraphCache, "function");
});

// ---------------------------------------------------------------------------
// T2: rebuild from fixture ledger with fact + reconstructed rows
// ---------------------------------------------------------------------------
test("rebuild populates forwardAdj, reverseAdj, kindOf from fact+reconstructed rows", async () => {
  const ws = join(TMP_ROOT, "ws-rebuild");
  ensureDir(ws);
  const ledgerPath = join(ws, "memory.jsonl");
  // Fixture: f1, f2 are facts; r1 derives from f1; r2 derives from f1, f2; r3 derives from r1.
  const rows = [
    { id: "f1", kind: "fact", ts: "2026-06-18T00:00:00Z" },
    { id: "f2", kind: "fact", ts: "2026-06-18T00:00:01Z" },
    {
      id: "r1",
      kind: "reconstructed",
      ts: "2026-06-18T00:00:02Z",
      derived_from: ["f1"],
    },
    {
      id: "r2",
      kind: "reconstructed",
      ts: "2026-06-18T00:00:03Z",
      derived_from: ["f1", "f2"],
    },
    {
      id: "r3",
      kind: "reconstructed",
      ts: "2026-06-18T00:00:04Z",
      derived_from: ["r1"],
    },
  ];
  writeRows(ledgerPath, rows);

  const graph = await rebuildDerivationGraph({ ledgerPath });

  assert.ok(graph.forwardAdj instanceof Map, "forwardAdj is a Map");
  assert.ok(graph.reverseAdj instanceof Map, "reverseAdj is a Map");
  assert.ok(graph.kindOf instanceof Map, "kindOf is a Map");

  // forwardAdj: child → parents
  assert.deepEqual(
    Array.from(graph.forwardAdj.get("r1") ?? []).sort(),
    ["f1"],
    "r1.parents = [f1]",
  );
  assert.deepEqual(
    Array.from(graph.forwardAdj.get("r2") ?? []).sort(),
    ["f1", "f2"],
    "r2.parents = [f1, f2]",
  );
  assert.deepEqual(
    Array.from(graph.forwardAdj.get("r3") ?? []).sort(),
    ["r1"],
    "r3.parents = [r1]",
  );

  // reverseAdj: parent → children
  assert.deepEqual(
    Array.from(graph.reverseAdj.get("f1") ?? []).sort(),
    ["r1", "r2"],
    "f1.children = [r1, r2]",
  );
  assert.deepEqual(
    Array.from(graph.reverseAdj.get("f2") ?? []).sort(),
    ["r2"],
    "f2.children = [r2]",
  );
  assert.deepEqual(
    Array.from(graph.reverseAdj.get("r1") ?? []).sort(),
    ["r3"],
    "r1.children = [r3]",
  );

  // kindOf
  assert.equal(graph.kindOf.get("f1"), "fact");
  assert.equal(graph.kindOf.get("r1"), "reconstructed");
  assert.equal(graph.kindOf.get("r3"), "reconstructed");

  // Total derivation edges ≥ 3 (spec requirement)
  let edgeCount = 0;
  for (const set of graph.forwardAdj.values()) edgeCount += set.size;
  assert.ok(edgeCount >= 3, `≥3 derivation edges; got ${edgeCount}`);

  // ledger_mtime_ms matches statSync
  const expectedMtime = statSync(ledgerPath).mtimeMs;
  assert.equal(graph.ledger_mtime_ms, expectedMtime, "ledger_mtime_ms matches");
  assert.ok(typeof graph.built_at === "string" && graph.built_at.endsWith("Z"));
});

// ---------------------------------------------------------------------------
// T3: walkExcisePropagation — depth 3 cap, decay weights
// ---------------------------------------------------------------------------
test("walkExcisePropagation surfaces downstream reconstructions to depth 3, not 4", () => {
  // Build a depth-4 chain manually so we exercise the DEPTH-CAP.
  const forwardAdj = new Map();
  const reverseAdj = new Map();
  const kindOf = new Map();

  // f → r1 → r2 → r3 → r4
  const chain = [
    ["f", "r1"],
    ["r1", "r2"],
    ["r2", "r3"],
    ["r3", "r4"],
  ];
  for (const [parent, child] of chain) {
    let children = reverseAdj.get(parent);
    if (!children) {
      children = new Set();
      reverseAdj.set(parent, children);
    }
    children.add(child);
    let parents = forwardAdj.get(child);
    if (!parents) {
      parents = new Set();
      forwardAdj.set(child, parents);
    }
    parents.add(parent);
  }
  kindOf.set("f", "fact");
  kindOf.set("r1", "reconstructed");
  kindOf.set("r2", "reconstructed");
  kindOf.set("r3", "reconstructed");
  kindOf.set("r4", "reconstructed");
  const graph = { forwardAdj, reverseAdj, kindOf };

  const visited = Array.from(walkExcisePropagation(graph, "f"));
  const byId = new Map(visited.map((v) => [v.memoryId, v]));

  assert.ok(byId.has("r1"), "r1 visited at depth 1");
  assert.equal(byId.get("r1").depth, 1, "r1 depth === 1");
  assert.equal(byId.get("r1").decayed_weight, 1.0, "r1 decay = 0.5^0 = 1.0");

  assert.ok(byId.has("r2"), "r2 visited at depth 2");
  assert.equal(byId.get("r2").depth, 2);
  assert.equal(byId.get("r2").decayed_weight, 0.5, "r2 decay = 0.5");

  assert.ok(byId.has("r3"), "r3 visited at depth 3 (within cap)");
  assert.equal(byId.get("r3").depth, 3);
  assert.equal(byId.get("r3").decayed_weight, 0.25, "r3 decay = 0.25");

  assert.ok(!byId.has("r4"), "r4 NOT visited (depth 4 > PROPAGATION_DEPTH_MAX)");

  // Root itself is NOT yielded.
  assert.ok(!byId.has("f"), "root is not yielded");
});

// ---------------------------------------------------------------------------
// T4: walkEngagementPropagation — decay 0.5/hop to all parents
// ---------------------------------------------------------------------------
test("walkEngagementPropagation propagates to all parents with 0.5/hop decay", () => {
  // r2 derives from r1, p; r1 derives from f.
  // Engagement on r2 (baseWeight=1.0) should reach:
  //   - r1 at depth 1, weight 1.0
  //   - p  at depth 1, weight 1.0 (but kind=fact → STOP-AT-EVIDENCE; no further)
  //   - f  at depth 2, weight 0.5 (via r1 → f); STOP-AT-EVIDENCE there.
  const forwardAdj = new Map();
  forwardAdj.set("r2", new Set(["r1", "p"]));
  forwardAdj.set("r1", new Set(["f"]));
  const reverseAdj = new Map();
  reverseAdj.set("r1", new Set(["r2"]));
  reverseAdj.set("p", new Set(["r2"]));
  reverseAdj.set("f", new Set(["r1"]));
  const kindOf = new Map();
  kindOf.set("r1", "reconstructed");
  kindOf.set("r2", "reconstructed");
  kindOf.set("p", "fact");
  kindOf.set("f", "fact");
  const graph = { forwardAdj, reverseAdj, kindOf };

  const visited = Array.from(walkEngagementPropagation(graph, "r2", 1.0));
  const byId = new Map(visited.map((v) => [v.parentId, v]));

  assert.equal(visited.length, 3, "three ancestors reached");
  assert.equal(byId.get("r1").depth, 1);
  assert.equal(byId.get("r1").propagated_weight, 1.0);
  assert.equal(byId.get("p").depth, 1);
  assert.equal(byId.get("p").propagated_weight, 1.0);
  assert.equal(byId.get("f").depth, 2);
  assert.equal(byId.get("f").propagated_weight, 0.5);

  // Engagement with custom baseWeight scales linearly.
  const halfVisited = Array.from(walkEngagementPropagation(graph, "r2", 0.4));
  const halfById = new Map(halfVisited.map((v) => [v.parentId, v]));
  assert.equal(halfById.get("r1").propagated_weight, 0.4, "baseWeight 0.4 scales r1");
  assert.equal(halfById.get("f").propagated_weight, 0.2, "baseWeight 0.4 → f gets 0.2");
});

// ---------------------------------------------------------------------------
// T5: detectCycles — synthetic cycle
// ---------------------------------------------------------------------------
test("detectCycles finds a synthetic cycle", () => {
  // Cycle: a → b → c → a (illegal per spec, but the validator may be bypassed)
  const forwardAdj = new Map();
  forwardAdj.set("a", new Set(["b"]));
  forwardAdj.set("b", new Set(["c"]));
  forwardAdj.set("c", new Set(["a"]));
  const reverseAdj = new Map();
  reverseAdj.set("b", new Set(["a"]));
  reverseAdj.set("c", new Set(["b"]));
  reverseAdj.set("a", new Set(["c"]));
  const graph = { forwardAdj, reverseAdj, kindOf: new Map() };

  const cycles = detectCycles(graph);
  assert.ok(cycles.length >= 1, "at least one cycle reported");
  // Canonical form starts with smallest node "a".
  assert.equal(cycles[0], "a → b → c → a", `cycle path: ${cycles[0]}`);
});

test("detectCycles returns empty array on a DAG", () => {
  const forwardAdj = new Map();
  forwardAdj.set("r1", new Set(["f"]));
  forwardAdj.set("r2", new Set(["r1"]));
  const reverseAdj = new Map();
  reverseAdj.set("f", new Set(["r1"]));
  reverseAdj.set("r1", new Set(["r2"]));
  const graph = { forwardAdj, reverseAdj, kindOf: new Map() };

  const cycles = detectCycles(graph);
  assert.equal(cycles.length, 0, "DAG has no cycles");
});

// ---------------------------------------------------------------------------
// T6: Multi-parent — ORPHAN-FLIP semantics surface descendants in walk
// ---------------------------------------------------------------------------
test("multi-parent reconstructed: excising 1 of 3 parents still surfaces descendant", () => {
  // r derives from p1, p2, p3. Excise p1; walkExcisePropagation(p1) must
  // include r as a downstream descendant (the ORPHAN-FLIP classifier
  // determines status; this BFS surfaces the candidate).
  const forwardAdj = new Map();
  forwardAdj.set("r", new Set(["p1", "p2", "p3"]));
  const reverseAdj = new Map();
  reverseAdj.set("p1", new Set(["r"]));
  reverseAdj.set("p2", new Set(["r"]));
  reverseAdj.set("p3", new Set(["r"]));
  const graph = { forwardAdj, reverseAdj, kindOf: new Map([
    ["p1", "fact"], ["p2", "fact"], ["p3", "fact"], ["r", "reconstructed"],
  ]) };

  const visited = Array.from(walkExcisePropagation(graph, "p1"));
  const ids = visited.map((v) => v.memoryId);
  assert.deepEqual(ids, ["r"], "r appears as p1's descendant (not orphan-flipped here)");

  // Sanity: excising p2 and p3 separately would also each surface r.
  const fromP2 = Array.from(walkExcisePropagation(graph, "p2")).map((v) => v.memoryId);
  const fromP3 = Array.from(walkExcisePropagation(graph, "p3")).map((v) => v.memoryId);
  assert.deepEqual(fromP2, ["r"]);
  assert.deepEqual(fromP3, ["r"]);
});

// ---------------------------------------------------------------------------
// T7: cycle defense in walkers (BFS terminates gracefully)
// ---------------------------------------------------------------------------
test("walkExcisePropagation terminates on a cycle", () => {
  // Pathological cycle a → b → a. Walker must not loop infinitely.
  const forwardAdj = new Map([
    ["a", new Set(["b"])],
    ["b", new Set(["a"])],
  ]);
  const reverseAdj = new Map([
    ["a", new Set(["b"])],
    ["b", new Set(["a"])],
  ]);
  const graph = { forwardAdj, reverseAdj, kindOf: new Map() };

  const visited = Array.from(walkExcisePropagation(graph, "a"));
  const ids = visited.map((v) => v.memoryId);
  assert.ok(ids.includes("b"), "b visited via reverseAdj");
  assert.ok(!ids.includes("a"), "root a not revisited");
});

test("walkEngagementPropagation terminates on a cycle", () => {
  const forwardAdj = new Map([
    ["a", new Set(["b"])],
    ["b", new Set(["a"])],
  ]);
  const reverseAdj = new Map([
    ["a", new Set(["b"])],
    ["b", new Set(["a"])],
  ]);
  const kindOf = new Map([
    ["a", "reconstructed"],
    ["b", "reconstructed"],
  ]);
  const graph = { forwardAdj, reverseAdj, kindOf };

  const visited = Array.from(walkEngagementPropagation(graph, "a", 1.0));
  const ids = visited.map((v) => v.parentId);
  assert.ok(ids.includes("b"), "b visited");
  assert.ok(!ids.includes("a"), "root a not yielded");
});

// ---------------------------------------------------------------------------
// T8: cache invalidation on ledger mtime change
// ---------------------------------------------------------------------------
test("cache invalidation rebuilds on ledger mtime bump", async () => {
  const ws = join(TMP_ROOT, "ws-invalidate");
  ensureDir(ws);
  const ledgerPath = join(ws, "memory.jsonl");
  const cachePath = join(ws, "derivation-graph-cache.json");

  // Build v1: single reconstructed row.
  writeRows(ledgerPath, [
    { id: "f1", kind: "fact" },
    { id: "r1", kind: "reconstructed", derived_from: ["f1"] },
  ]);
  const built1 = await rebuildDerivationGraph({ ledgerPath, cachePath });
  assert.ok(existsSync(cachePath), "cache file written");
  // R2/WI1: the cache is the v2 sectioned binary — the header is the first
  // line only, never a whole-file JSON.parse.
  const cacheBuf = readFileSync(cachePath);
  const onDisk = JSON.parse(cacheBuf.toString("utf8", 0, cacheBuf.indexOf(0x0a)));
  assert.equal(onDisk.schema_version, "v2");
  assert.equal(onDisk.ledger_mtime_ms, built1.ledger_mtime_ms, "cache mtime matches build");

  // Reload via loadOrRebuild — should hit cache (same mtime).
  const reloaded = await loadOrRebuildDerivationGraph({ ledgerPath, cachePath });
  assert.equal(reloaded.ledger_mtime_ms, built1.ledger_mtime_ms, "cache hit preserves mtime");
  assert.deepEqual(
    Array.from(reloaded.forwardAdj.get("r1") ?? []).sort(),
    ["f1"],
    "cache round-trip preserves forwardAdj",
  );

  // Mutate ledger → bump mtime → expect rebuild.
  writeRows(ledgerPath, [
    { id: "f1", kind: "fact" },
    { id: "r1", kind: "reconstructed", derived_from: ["f1"] },
    { id: "r2", kind: "reconstructed", derived_from: ["r1"] },
  ]);
  // Force a discernible mtime delta — utimesSync to be safe across fast disks.
  const now = new Date();
  utimesSync(ledgerPath, now, new Date(now.getTime() + 5000));

  const reloaded2 = await loadOrRebuildDerivationGraph({ ledgerPath, cachePath });
  assert.notEqual(reloaded2.ledger_mtime_ms, built1.ledger_mtime_ms, "mtime bumped");
  assert.deepEqual(
    Array.from(reloaded2.forwardAdj.get("r2") ?? []).sort(),
    ["r1"],
    "new row picked up after invalidation",
  );
});

// ---------------------------------------------------------------------------
// T9: persistGraphCache round-trip
// ---------------------------------------------------------------------------
test("persistGraphCache round-trips through loadOrRebuildDerivationGraph", async () => {
  const ws = join(TMP_ROOT, "ws-persist");
  ensureDir(ws);
  const ledgerPath = join(ws, "memory.jsonl");
  const cachePath = join(ws, "cache.json");
  writeRows(ledgerPath, [
    { id: "f1", kind: "fact" },
    { id: "f2", kind: "fact" },
    { id: "r1", kind: "reconstructed", derived_from: ["f1", "f2"] },
  ]);

  const built = await rebuildDerivationGraph({ ledgerPath });
  await persistGraphCache(built, cachePath);
  assert.ok(existsSync(cachePath), "cache file present after explicit persist");

  const reloaded = await loadOrRebuildDerivationGraph({ ledgerPath, cachePath });
  assert.deepEqual(
    Array.from(reloaded.forwardAdj.get("r1") ?? []).sort(),
    ["f1", "f2"],
    "forwardAdj survived persist + reload",
  );
  assert.deepEqual(
    Array.from(reloaded.reverseAdj.get("f1") ?? []).sort(),
    ["r1"],
    "reverseAdj survived persist + reload",
  );
  assert.equal(reloaded.kindOf.get("r1"), "reconstructed");
});

// ---------------------------------------------------------------------------
// T10: STOP-AT-EVIDENCE — engagement BFS halts at fact ancestors
// ---------------------------------------------------------------------------
test("STOP-AT-EVIDENCE halts engagement BFS at a fact ancestor", () => {
  // r derives from f; f has a derivation edge upward to g (e.g. via
  // source_refs corroboration). Engagement on r should reach f but NOT g
  // because f is kind=fact (evidence floor).
  const forwardAdj = new Map([
    ["r", new Set(["f"])],
    ["f", new Set(["g"])],
  ]);
  const reverseAdj = new Map([
    ["f", new Set(["r"])],
    ["g", new Set(["f"])],
  ]);
  const kindOf = new Map([
    ["r", "reconstructed"],
    ["f", "fact"],
    ["g", "fact"],
  ]);
  const graph = { forwardAdj, reverseAdj, kindOf };

  const visited = Array.from(walkEngagementPropagation(graph, "r", 1.0));
  const ids = visited.map((v) => v.parentId);
  assert.ok(ids.includes("f"), "f reached (evidence)");
  assert.ok(!ids.includes("g"), "g NOT reached (STOP-AT-EVIDENCE at f)");
});

// ---------------------------------------------------------------------------
// T11: empty / cold-start
// ---------------------------------------------------------------------------
test("rebuild on a missing ledger returns empty graph (cold start)", async () => {
  const ws = join(TMP_ROOT, "ws-cold");
  ensureDir(ws);
  const ledgerPath = join(ws, "memory.jsonl");
  // No file written.
  const graph = await rebuildDerivationGraph({ ledgerPath });
  assert.equal(graph.forwardAdj.size, 0);
  assert.equal(graph.reverseAdj.size, 0);
  assert.equal(graph.kindOf.size, 0);
  assert.equal(graph.ledger_mtime_ms, 0);
});

test("rebuildDerivationGraph rejects missing ledgerPath", async () => {
  await assert.rejects(() => rebuildDerivationGraph({}), TypeError);
  await assert.rejects(() => loadOrRebuildDerivationGraph({}), TypeError);
});
