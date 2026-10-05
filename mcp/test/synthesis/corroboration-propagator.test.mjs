// corroboration-propagator.test.mjs — Wave 12 BEHAVIOR coverage for the
// rank-time corroboration boost computer
// (F-SYN-BEHAVIOR-corroboration-propagation).
//
// Coverage matrix (12+ assertions enforced by the goal):
//   1. Module surface exports (VERSION + frozen CAPS).
//   2. No descendants → BASE (ranking-neutral).
//   3. One descendant → BASE + 1 × BOOST_PER_DESCENDANT.
//   4. N descendants (cap-bounded) → MAX_BOOST.
//   5. Multi-hop walk respects MAX_HOPS cap.
//   6. Disjoint candidates don't cross-pollinate.
//   7. Cycle defense: cyclic adjacency terminates.
//   8. Defensive: null graph → BASE.
//   9. Defensive: undefined memory_id → BASE.
//  10. Defensive: empty-string memory_id → BASE.
//  11. Defensive: graph with no reverseAdj fall back to forwardAdj.
//  12. Defensive: graph with neither adjacency → BASE.
//  13. Result is always within [BASE, MAX_BOOST].
//
// Run: node --test test/synthesis/corroboration-propagator.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../lib/synthesis/corroboration-propagator.js");
const {
  CORROBORATION_PROPAGATOR_VERSION,
  CORROBORATION_CAPS,
  computeCorroborationBoost,
} = mod;

// Helper — build a minimal derivation-graph-shaped object. We construct
// reverseAdj manually because the substrate's loadOrRebuildDerivationGraph
// requires a full ledger fixture; for unit-tests of the BOOST computation
// the Map shape is sufficient (the boost function is pure over the Map).
function makeGraph(reverseEdges = [], forwardEdges = null) {
  const reverseAdj = new Map();
  for (const [parent, child] of reverseEdges) {
    let s = reverseAdj.get(parent);
    if (s == null) {
      s = new Set();
      reverseAdj.set(parent, s);
    }
    s.add(child);
  }
  const forwardAdj = new Map();
  if (Array.isArray(forwardEdges)) {
    for (const [child, parent] of forwardEdges) {
      let s = forwardAdj.get(child);
      if (s == null) {
        s = new Set();
        forwardAdj.set(child, s);
      }
      s.add(parent);
    }
  }
  return { reverseAdj, forwardAdj, kindOf: new Map() };
}

// ---------------------------------------------------------------------------
// 1. SURFACE
// ---------------------------------------------------------------------------
test("module surface: VERSION + frozen CAPS", () => {
  assert.equal(CORROBORATION_PROPAGATOR_VERSION, "v0.1.0", "VERSION pinned");
  assert.equal(typeof computeCorroborationBoost, "function", "exports fn");
  assert.equal(CORROBORATION_CAPS.BASE, 1.0, "BASE=1.0");
  assert.equal(CORROBORATION_CAPS.MAX_BOOST, 1.3, "MAX_BOOST=1.3");
  assert.equal(CORROBORATION_CAPS.BOOST_PER_DESCENDANT, 0.05, "boost-per=0.05");
  assert.equal(CORROBORATION_CAPS.MAX_HOPS, 2, "MAX_HOPS=2");
  assert.throws(() => {
    "use strict";
    CORROBORATION_CAPS.NEW_KEY = 1;
  }, "CORROBORATION_CAPS is frozen");
});

// ---------------------------------------------------------------------------
// 2. NO DESCENDANTS → BASE.
// ---------------------------------------------------------------------------
test("isolated node with no descendants → BASE", () => {
  const graph = makeGraph();
  const boost = computeCorroborationBoost({
    memory_id: "f_isolated",
    derivationGraph: graph,
  });
  assert.equal(boost, CORROBORATION_CAPS.BASE);
});

// ---------------------------------------------------------------------------
// 3. ONE DESCENDANT → BASE + 1 × BOOST_PER_DESCENDANT.
// ---------------------------------------------------------------------------
test("one descendant → BASE + 1 × BOOST_PER_DESCENDANT", () => {
  const graph = makeGraph([["f_root", "r_child_1"]]);
  const boost = computeCorroborationBoost({
    memory_id: "f_root",
    derivationGraph: graph,
  });
  assert.equal(boost, CORROBORATION_CAPS.BASE + CORROBORATION_CAPS.BOOST_PER_DESCENDANT);
});

// ---------------------------------------------------------------------------
// 4. N DESCENDANTS — boost scales linearly, capped at MAX_BOOST.
// ---------------------------------------------------------------------------
test("N descendants → BASE + N × BOOST clamped at MAX_BOOST", () => {
  // 4 direct children: BASE + 4 * 0.05 = 1.2 (below cap).
  const fourChildren = makeGraph([
    ["f_root", "r1"],
    ["f_root", "r2"],
    ["f_root", "r3"],
    ["f_root", "r4"],
  ]);
  const fourBoost = computeCorroborationBoost({
    memory_id: "f_root",
    derivationGraph: fourChildren,
  });
  assert.equal(fourBoost, CORROBORATION_CAPS.BASE + 4 * CORROBORATION_CAPS.BOOST_PER_DESCENDANT);

  // 20 direct children: BASE + 20 * 0.05 = 2.0 → clamp at MAX_BOOST=1.3.
  const manyEdges = [];
  for (let i = 0; i < 20; i++) {
    manyEdges.push(["f_root", `r${i}`]);
  }
  const manyChildren = makeGraph(manyEdges);
  const manyBoost = computeCorroborationBoost({
    memory_id: "f_root",
    derivationGraph: manyChildren,
  });
  assert.equal(manyBoost, CORROBORATION_CAPS.MAX_BOOST, "saturates at MAX_BOOST");
});

// ---------------------------------------------------------------------------
// 5. MULTI-HOP — walk respects MAX_HOPS cap.
// ---------------------------------------------------------------------------
test("multi-hop walk respects MAX_HOPS", () => {
  // Chain: f_root → r1 → r2 → r3
  // MAX_HOPS=2 means we visit r1 (hop 1) and r2 (hop 2), NOT r3.
  const graph = makeGraph([
    ["f_root", "r1"],
    ["r1", "r2"],
    ["r2", "r3"],
  ]);
  const boost = computeCorroborationBoost({
    memory_id: "f_root",
    derivationGraph: graph,
  });
  // Expected: 2 descendants counted (r1, r2). r3 is beyond MAX_HOPS.
  assert.equal(
    boost,
    CORROBORATION_CAPS.BASE + 2 * CORROBORATION_CAPS.BOOST_PER_DESCENDANT,
    "MAX_HOPS bounds the walk",
  );
});

// ---------------------------------------------------------------------------
// 6. DISJOINT — candidates with no edge → BASE; other candidate unaffected.
// ---------------------------------------------------------------------------
test("disjoint candidates don't cross-pollinate", () => {
  const graph = makeGraph([
    ["f_root_A", "r_A1"],
    ["f_root_B", "r_B1"],
    ["f_root_B", "r_B2"],
  ]);
  const a = computeCorroborationBoost({
    memory_id: "f_root_A",
    derivationGraph: graph,
  });
  const b = computeCorroborationBoost({
    memory_id: "f_root_B",
    derivationGraph: graph,
  });
  const c = computeCorroborationBoost({
    memory_id: "f_NOT_PRESENT",
    derivationGraph: graph,
  });
  assert.ok(b > a, "B has more descendants than A");
  assert.equal(c, CORROBORATION_CAPS.BASE, "missing node → BASE");
});

// ---------------------------------------------------------------------------
// 7. CYCLE DEFENSE — BFS terminates on cyclic adjacency.
// ---------------------------------------------------------------------------
test("cycle defense: BFS terminates on cyclic adjacency", () => {
  // a → b → c → a  (cycle). The walk's visited Set should halt the loop.
  const graph = makeGraph([
    ["a", "b"],
    ["b", "c"],
    ["c", "a"],
  ]);
  const boost = computeCorroborationBoost({
    memory_id: "a",
    derivationGraph: graph,
  });
  // Must return a finite value within bounds — no hang, no overflow.
  assert.ok(boost >= CORROBORATION_CAPS.BASE);
  assert.ok(boost <= CORROBORATION_CAPS.MAX_BOOST);
});

// ---------------------------------------------------------------------------
// 8. DEFENSIVE — null graph → BASE.
// ---------------------------------------------------------------------------
test("null graph → BASE", () => {
  const boost = computeCorroborationBoost({
    memory_id: "f_root",
    derivationGraph: null,
  });
  assert.equal(boost, CORROBORATION_CAPS.BASE);
});

// ---------------------------------------------------------------------------
// 9. DEFENSIVE — undefined memory_id → BASE.
// ---------------------------------------------------------------------------
test("undefined memory_id → BASE", () => {
  const graph = makeGraph([["f_root", "r1"]]);
  const boost = computeCorroborationBoost({ derivationGraph: graph });
  assert.equal(boost, CORROBORATION_CAPS.BASE);
});

// ---------------------------------------------------------------------------
// 10. DEFENSIVE — empty-string memory_id → BASE.
// ---------------------------------------------------------------------------
test("empty-string memory_id → BASE", () => {
  const graph = makeGraph([["f_root", "r1"]]);
  const boost = computeCorroborationBoost({
    memory_id: "",
    derivationGraph: graph,
  });
  assert.equal(boost, CORROBORATION_CAPS.BASE);
});

// ---------------------------------------------------------------------------
// 11. FALLBACK ADJACENCY — graph with only forwardAdj still produces a walk.
// ---------------------------------------------------------------------------
test("graph with only forwardAdj falls back defensively", () => {
  // No reverseAdj: only forwardAdj. The reader should defensively use
  // forwardAdj. Sanity check the function does NOT throw — exact value
  // depends on the fallback semantics; ≥ BASE is the invariant.
  const graph = {
    forwardAdj: new Map([["child", new Set(["f_root"])]]),
    kindOf: new Map(),
  };
  const boost = computeCorroborationBoost({
    memory_id: "child",
    derivationGraph: graph,
  });
  assert.ok(boost >= CORROBORATION_CAPS.BASE);
  assert.ok(boost <= CORROBORATION_CAPS.MAX_BOOST);
});

// ---------------------------------------------------------------------------
// 12. DEFENSIVE — graph with NEITHER adjacency map → BASE.
// ---------------------------------------------------------------------------
test("graph missing both adjacency maps → BASE", () => {
  const graph = { kindOf: new Map() };
  const boost = computeCorroborationBoost({
    memory_id: "f_root",
    derivationGraph: graph,
  });
  assert.equal(boost, CORROBORATION_CAPS.BASE);
});

// ---------------------------------------------------------------------------
// 13. INVARIANT — every result is in [BASE, MAX_BOOST].
// ---------------------------------------------------------------------------
test("result always within [BASE, MAX_BOOST]", () => {
  const cases = [
    null,
    { reverseAdj: new Map(), forwardAdj: new Map() },
    makeGraph([["f", "r1"]]),
    makeGraph([
      ["f", "r1"],
      ["f", "r2"],
      ["f", "r3"],
      ["f", "r4"],
      ["f", "r5"],
      ["f", "r6"],
      ["f", "r7"],
      ["f", "r8"],
      ["f", "r9"],
      ["f", "r10"],
    ]),
  ];
  for (const graph of cases) {
    const boost = computeCorroborationBoost({
      memory_id: "f",
      derivationGraph: graph,
    });
    assert.ok(
      boost >= CORROBORATION_CAPS.BASE,
      `boost ≥ BASE; got ${boost}`,
    );
    assert.ok(
      boost <= CORROBORATION_CAPS.MAX_BOOST,
      `boost ≤ MAX_BOOST; got ${boost}`,
    );
  }
});
