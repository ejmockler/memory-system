// transitive-orphan.test.mjs — Phase 3 v0+ transitive derivation-orphan
// propagation through the recall-layer hard-gates pipeline.
//
// Authoritative design: kb/transitive-orphan-design.md (the design doc that
// pulled this forward from v2 to v0+). Cross-references:
//   - kb/research-retrieval-frontiers.md § Risks #10 (the open problem)
//   - kb/phase3-v0-contracts.md § 1, § 3 (IndexEntry/ScoreComponents)
//   - kb/agent-integration.md § Failure modes (excise behavior)
//
// Hermeticity discipline (standing C-NEW-2 pattern):
//   Set MEMORY_ROOT, POLICY_BASE_DIR, STORAGE_BASE_DIR, LEDGERS_BASE_DIR to
//   mkdtempSync paths BEFORE any dynamic import of memory-system modules.
//   Per-test we write a synthetic memory.jsonl into the hermetic LEDGERS_DIR
//   so the loaders read only what this file produces.
//
// Test inventory (12 cases per design § 7):
//   1. Direct orphan (d=1) regression -> status 0.5
//   2. 2-deep transitive             -> status 0.3352, distance 2
//   3. 4-deep transitive (floor)     -> status 0.25,   distance 4
//   4. Cycle defense                 -> BFS terminates
//   5. Cap overflow                  -> partial coverage, warn emitted
//   6. Corroboration rescue          -> rescued, status 1.0
//   7. memory_replace does NOT seed -> A is NOT orphan
//   8. silent excise is opaque       -> A is NOT orphan
//   9. derivation_policy:retain      -> A is NOT orphan
//  10. Rescinded excise              -> A is NOT orphan
//  11. Performance (10^4 events)     -> cold < 200ms, warm < 5ms
//  12. Cache invalidation on append  -> new excise is reflected

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hermeticity: stake tmp dirs and overwrite env BEFORE dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-transitive-orphan-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(MEMORY_ROOT, "policy");
const STORAGE_DIR = join(MEMORY_ROOT, "storage");
const LEDGERS_DIR = join(MEMORY_ROOT, "ledgers");
mkdirSync(POLICY_DIR, { recursive: true });
mkdirSync(STORAGE_DIR, { recursive: true });
mkdirSync(LEDGERS_DIR, { recursive: true });

process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// Dynamic import AFTER env override.
const {
  applyHardGates,
  loadDerivationExciseSet,
  loadDerivationGraph,
  loadTransitiveOrphanMap,
  derivationStatusForDistance,
  _resetTransitiveOrphanCaches,
} = await import("../lib/recall/hard-gates.js");
const { CAPS } = await import("../lib/validation.js");

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const LEDGER_PATH = join(LEDGERS_DIR, "memory.jsonl");
const MODEL_VERSION = CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT;

// ---------------------------------------------------------------------------
// Helpers: synthetic ledger writer + IndexEntry stub.
// ---------------------------------------------------------------------------
function writeLedger(rows) {
  const lines = rows.map((r) => JSON.stringify(r));
  writeFileSync(LEDGER_PATH, lines.join("\n") + "\n", "utf8");
  // Bust any module-internal cache between tests so each scenario starts
  // from a clean slate; production code relies on mtime+size keys, but
  // mkdtemp + rewriting the same path can occasionally produce identical
  // mtimes within the same millisecond on some filesystems.
  _resetTransitiveOrphanCaches();
}

function stubEntry(id, derived_from = [], consent = "first_party") {
  return {
    memory_id: id,
    embedding_3072: null, // not used by the derivation gate
    consent_basis: consent,
    derived_from,
    embedding_model_version: MODEL_VERSION,
  };
}

function approxEqual(a, b, eps = 1e-9) {
  return Math.abs(a - b) < eps;
}

// ===========================================================================
// Test 1: Regression — direct orphan (d=1) still flagged at 0.5.
// ===========================================================================
{
  writeLedger([
    { id: "B", kind: "fact", content: "ancestor" },
    {
      id: "exc_1",
      kind: "policy",
      policy_kind: "excise",
      targets: ["B"],
      derivation_policy: "drop",
    },
    { id: "A", kind: "fact", content: "child", derived_from: ["B"] },
  ]);

  const orphanMap = await loadTransitiveOrphanMap();
  const aInfo = orphanMap.get("A");
  check("T1 A is in orphan map", aInfo != null);
  check(
    "T1 A distance_to_nearest_excised === 1",
    aInfo != null && aInfo.distance_to_nearest_excised === 1,
    aInfo ? `got ${aInfo.distance_to_nearest_excised}` : "missing",
  );
  check(
    "T1 A transitive_orphan === true",
    aInfo != null && aInfo.transitive_orphan === true,
  );

  const gated = applyHardGates([stubEntry("A", ["B"])], {
    activePredicates: [],
    transitive_orphan_map: orphanMap,
    embedding_model_version: MODEL_VERSION,
  });
  check(
    "T1 derivation_status === 0.5 (v0 backward compat anchor)",
    gated[0].derivation_status === CAPS.DERIVATION_STATUS_ORPHAN,
    `got ${gated[0].derivation_status}`,
  );
  check("T1 derivation_distance === 1", gated[0].derivation_distance === 1);
}

// ===========================================================================
// Test 2: 2-deep transitive. B -> A -> C, excise B.
// ===========================================================================
{
  writeLedger([
    { id: "B", kind: "fact", content: "ancestor" },
    {
      id: "exc_2",
      kind: "policy",
      policy_kind: "excise",
      targets: ["B"],
      derivation_policy: "drop",
    },
    { id: "A", kind: "fact", content: "mid", derived_from: ["B"] },
    { id: "C", kind: "fact", content: "leaf", derived_from: ["A"] },
  ]);

  const orphanMap = await loadTransitiveOrphanMap();
  const aInfo = orphanMap.get("A");
  const cInfo = orphanMap.get("C");
  check(
    "T2 A distance === 1",
    aInfo != null && aInfo.distance_to_nearest_excised === 1,
  );
  check(
    "T2 C distance === 2",
    cInfo != null && cInfo.distance_to_nearest_excised === 2,
    cInfo ? `got ${cInfo.distance_to_nearest_excised}` : "missing",
  );

  const expectedC = derivationStatusForDistance(2);
  check(
    "T2 derivationStatusForDistance(2) ≈ 0.3352",
    approxEqual(expectedC, 0.5 * Math.exp(-0.4), 1e-9) &&
      approxEqual(expectedC, 0.33516002301223, 1e-6),
    `got ${expectedC}`,
  );

  const gated = applyHardGates(
    [stubEntry("A", ["B"]), stubEntry("C", ["A"])],
    {
      activePredicates: [],
      transitive_orphan_map: orphanMap,
      embedding_model_version: MODEL_VERSION,
    },
  );
  check(
    "T2 A derivation_status === 0.5",
    gated[0].derivation_status === CAPS.DERIVATION_STATUS_ORPHAN,
  );
  check(
    "T2 C derivation_status === depth-aware d=2",
    approxEqual(gated[1].derivation_status, expectedC, 1e-9),
    `got ${gated[1].derivation_status}`,
  );
  check("T2 C derivation_distance === 2", gated[1].derivation_distance === 2);
}

// ===========================================================================
// Test 3: 4-deep transitive (E at d=4 must floor to 0.25).
// ===========================================================================
{
  writeLedger([
    { id: "B", kind: "fact", content: "root" },
    {
      id: "exc_3",
      kind: "policy",
      policy_kind: "excise",
      targets: ["B"],
      derivation_policy: "drop",
    },
    { id: "A", kind: "fact", derived_from: ["B"] },
    { id: "C", kind: "fact", derived_from: ["A"] },
    { id: "D", kind: "fact", derived_from: ["C"] },
    { id: "E", kind: "fact", derived_from: ["D"] },
  ]);

  const orphanMap = await loadTransitiveOrphanMap();
  const eInfo = orphanMap.get("E");
  check(
    "T3 E distance === 4 (THE 4-deep reach)",
    eInfo != null && eInfo.distance_to_nearest_excised === 4,
    eInfo ? `got ${eInfo.distance_to_nearest_excised}` : "missing",
  );

  const gated = applyHardGates(
    [
      stubEntry("A", ["B"]),
      stubEntry("C", ["A"]),
      stubEntry("D", ["C"]),
      stubEntry("E", ["D"]),
    ],
    {
      activePredicates: [],
      transitive_orphan_map: orphanMap,
      embedding_model_version: MODEL_VERSION,
    },
  );
  // Round-18 hot-fix: FLOOR lowered 0.25 -> 0.05 so the depth-aware dampener
  // is genuinely depth-aware across d=1..6 instead of flatlining at d>=3.
  // d=4 formula value: exp(-1.2) * 0.5 ≈ 0.15060 — above the new FLOOR=0.05.
  const expectedE = Math.max(
    CAPS.DERIVATION_STATUS_ORPHAN_FLOOR,
    Math.exp(-CAPS.DERIVATION_ORPHAN_LAMBDA * (4 - 1)) * CAPS.DERIVATION_STATUS_ORPHAN,
  );
  check(
    "T3 E derivation_status === depth-aware d=4 (no longer flatlined)",
    approxEqual(gated[3].derivation_status, expectedE, 1e-9),
    `got ${gated[3].derivation_status} expected ${expectedE}`,
  );
  check("T3 E derivation_distance === 4", gated[3].derivation_distance === 4);
  // d=3 formula value: exp(-0.8) * 0.5 ≈ 0.22466 — also above the new FLOOR=0.05.
  const expectedD = Math.max(
    CAPS.DERIVATION_STATUS_ORPHAN_FLOOR,
    Math.exp(-CAPS.DERIVATION_ORPHAN_LAMBDA * (3 - 1)) * CAPS.DERIVATION_STATUS_ORPHAN,
  );
  check(
    "T3 D derivation_status === depth-aware d=3 (no longer flatlined)",
    approxEqual(gated[2].derivation_status, expectedD, 1e-9),
    `got ${gated[2].derivation_status} expected ${expectedD}`,
  );
  check("T3 D derivation_distance === 3", gated[2].derivation_distance === 3);
}

// ===========================================================================
// Test 4: Cycle defense. A.derived_from=[B], B.derived_from=[A].
// BFS must terminate; visited Set protects against infinite loops.
// ===========================================================================
{
  writeLedger([
    { id: "S", kind: "fact", content: "seed" },
    {
      id: "exc_4",
      kind: "policy",
      policy_kind: "excise",
      targets: ["S"],
      derivation_policy: "drop",
    },
    { id: "A", kind: "fact", derived_from: ["S", "B"] },
    { id: "B", kind: "fact", derived_from: ["A"] },
  ]);

  // A wall-clock guard: if the BFS infinite-loops, we want a visible failure
  // rather than the test runner timing out. 250ms is generous.
  const t0 = Date.now();
  const orphanMap = await loadTransitiveOrphanMap();
  const elapsed = Date.now() - t0;
  check("T4 BFS terminates in < 250ms (no infinite loop)", elapsed < 250,
    `elapsed=${elapsed}ms`);
  check("T4 A flagged", orphanMap.has("A"));
  check("T4 B flagged (cycle-reached)", orphanMap.has("B"));
  const aInfo = orphanMap.get("A");
  const bInfo = orphanMap.get("B");
  // A is reachable in one step from S; B is reachable in two (S->A->B).
  // Cycle does not change BFS-shortest-path distances (visited Set blocks
  // the back-edge B->A relaxation).
  check(
    "T4 A distance === 1",
    aInfo != null && aInfo.distance_to_nearest_excised === 1,
    aInfo ? `got ${aInfo.distance_to_nearest_excised}` : "missing",
  );
  check(
    "T4 B distance === 2",
    bInfo != null && bInfo.distance_to_nearest_excised === 2,
    bInfo ? `got ${bInfo.distance_to_nearest_excised}` : "missing",
  );
}

// ===========================================================================
// Test 5: Cap overflow. Synthesize > CAPS.TRANSITIVE_ORPHAN_DESCENDANTS_CAP
// descendants from a single root; assert cap, warn emission, partial coverage.
// ===========================================================================
{
  const CAP = CAPS.TRANSITIVE_ORPHAN_DESCENDANTS_CAP;
  const TOTAL = CAP + 200; // overflow by 200
  const rows = [
    { id: "ROOT", kind: "fact", content: "root" },
    {
      id: "exc_5",
      kind: "policy",
      policy_kind: "excise",
      targets: ["ROOT"],
      derivation_policy: "drop",
    },
  ];
  // Wide fan-out: every descendant points at ROOT, so all of them are at d=1.
  for (let i = 0; i < TOTAL; i++) {
    rows.push({
      id: `D_${i}`,
      kind: "fact",
      derived_from: ["ROOT"],
    });
  }
  writeLedger(rows);

  // Intercept console.warn so we can assert the cap-exceeded line.
  const origWarn = console.warn;
  let warnLines = [];
  console.warn = (msg) => warnLines.push(String(msg));
  try {
    const orphanMap = await loadTransitiveOrphanMap();
    // Returned map should hold exactly CAP entries (the seed counts as one,
    // so the descendant slice is CAP-1). Either way, total size is CAP.
    check(
      "T5 orphanMap.size === CAP (partial coverage at the limit)",
      orphanMap.size === CAP,
      `got ${orphanMap.size} expected ${CAP}`,
    );
    check(
      "T5 console.warn emitted with cap-exceeded marker",
      warnLines.some((l) =>
        l.includes("policy.recall.transitive_orphan_cap_exceeded"),
      ),
      `warn lines: ${warnLines.length}`,
    );
    // Sanity: the first descendant IS flagged (BFS proceeded normally up to
    // the cap); no crash.
    check(
      "T5 D_0 IS in orphan map",
      orphanMap.has("D_0"),
    );
  } finally {
    console.warn = origWarn;
  }
}

// ===========================================================================
// Test 6: Corroboration rescue.
// B -> A; excise B; A has a corroboration policy event linking to S
// (a non-excised, non-orphan fact). Expect A.transitive_orphan === false,
// rescued_by_corroboration === true.
// ===========================================================================
{
  writeLedger([
    { id: "B", kind: "fact", content: "ancestor" },
    {
      id: "exc_6",
      kind: "policy",
      policy_kind: "excise",
      targets: ["B"],
      derivation_policy: "drop",
    },
    { id: "S", kind: "fact", content: "independent source" },
    { id: "A", kind: "fact", derived_from: ["B"] },
    {
      id: "corr_6",
      kind: "policy",
      policy_kind: "corroboration",
      targets: ["A"],
      payload: {
        source_ref: {
          target_memory_id: "S",
          via: "corroboration",
        },
      },
    },
  ]);

  const orphanMap = await loadTransitiveOrphanMap();
  const aInfo = orphanMap.get("A");
  check("T6 A still in orphan map (with rescue flag)", aInfo != null);
  check(
    "T6 A transitive_orphan === false (rescued)",
    aInfo != null && aInfo.transitive_orphan === false,
    aInfo ? `got ${aInfo.transitive_orphan}` : "missing",
  );
  check(
    "T6 A rescued_by_corroboration === true",
    aInfo != null && aInfo.rescued_by_corroboration === true,
  );

  // Critical: applyHardGates must see A as NORMAL (rescue collapses the
  // dampener), NOT as a depth-aware orphan.
  const gated = applyHardGates([stubEntry("A", ["B"])], {
    activePredicates: [],
    transitive_orphan_map: orphanMap,
    embedding_model_version: MODEL_VERSION,
  });
  check(
    "T6 A derivation_status === NORMAL (1.0)",
    gated[0].derivation_status === CAPS.DERIVATION_STATUS_NORMAL,
    `got ${gated[0].derivation_status}`,
  );
  check(
    "T6 A derivation_distance === null (rescued)",
    gated[0].derivation_distance === null,
  );
}

// ===========================================================================
// Test 7: memory_replace does NOT propagate.
// A policy row with policy_kind="replace" (NOT excise) over B; A derived from
// B. A must NOT be orphan-flagged.
// ===========================================================================
{
  writeLedger([
    { id: "B", kind: "fact", content: "old" },
    { id: "B_new", kind: "fact", content: "replacement" },
    {
      id: "rep_7",
      kind: "policy",
      policy_kind: "replace",
      targets: ["B_new", "B"],
      payload: { new_event_id: "B_new", old_id: "B" },
    },
    { id: "A", kind: "fact", derived_from: ["B"] },
  ]);

  const orphanMap = await loadTransitiveOrphanMap();
  check(
    "T7 orphanMap is empty (replace does not seed)",
    orphanMap.size === 0,
    `got size=${orphanMap.size}`,
  );
}

// ===========================================================================
// Test 8: silent excise is opaque to recall.
// ===========================================================================
{
  writeLedger([
    { id: "B", kind: "fact", content: "ancestor" },
    {
      id: "exc_8",
      kind: "policy",
      policy_kind: "excise",
      targets: ["B"],
      derivation_policy: "drop",
      silent: true,
    },
    { id: "A", kind: "fact", derived_from: ["B"] },
  ]);

  const orphanMap = await loadTransitiveOrphanMap();
  check(
    "T8 orphanMap is empty (silent excise NOT a seed)",
    orphanMap.size === 0,
    `got size=${orphanMap.size}`,
  );
  // loadDerivationExciseSet (v0 compat) must also exclude silent.
  const direct = await loadDerivationExciseSet();
  check(
    "T8 loadDerivationExciseSet is empty (silent excise excluded)",
    direct.size === 0,
    `got size=${direct.size}`,
  );
}

// ===========================================================================
// Test 9: derivation_policy: "retain" does NOT propagate.
// User explicitly asked to keep descendants live.
// ===========================================================================
{
  writeLedger([
    { id: "B", kind: "fact", content: "ancestor" },
    {
      id: "exc_9",
      kind: "policy",
      policy_kind: "excise",
      targets: ["B"],
      derivation_policy: "retain",
    },
    { id: "A", kind: "fact", derived_from: ["B"] },
  ]);

  const orphanMap = await loadTransitiveOrphanMap();
  check(
    "T9 orphanMap is empty (retain does not seed)",
    orphanMap.size === 0,
    `got size=${orphanMap.size}`,
  );
}

// ===========================================================================
// Test 10: Rescinded excise does NOT propagate.
// Both rescind forms are tested:
//   (a) inline active: false on the excise row
//   (b) separate policy_kind: "rescind" row targeting the excise's id
// ===========================================================================
{
  // Form (a): inline active=false.
  writeLedger([
    { id: "B", kind: "fact" },
    {
      id: "exc_10a",
      kind: "policy",
      policy_kind: "excise",
      targets: ["B"],
      derivation_policy: "drop",
      active: false,
    },
    { id: "A", kind: "fact", derived_from: ["B"] },
  ]);
  let orphanMap = await loadTransitiveOrphanMap();
  check(
    "T10a inline active=false excludes seed",
    orphanMap.size === 0,
    `got size=${orphanMap.size}`,
  );

  // Form (b): separate rescind policy row.
  writeLedger([
    { id: "B", kind: "fact" },
    {
      id: "exc_10b",
      kind: "policy",
      policy_kind: "excise",
      targets: ["B"],
      derivation_policy: "drop",
    },
    {
      id: "rescind_10b",
      kind: "policy",
      policy_kind: "rescind",
      targets: ["exc_10b"],
    },
    { id: "A", kind: "fact", derived_from: ["B"] },
  ]);
  orphanMap = await loadTransitiveOrphanMap();
  check(
    "T10b separate rescind row excludes seed",
    orphanMap.size === 0,
    `got size=${orphanMap.size}`,
  );
}

// ===========================================================================
// Test 11: Performance — 10^4 events with random fanin avg 2 + 10% excise.
// Cold-cache build < 200ms (loose budget per design § 3); warm-cache < 5ms.
// ===========================================================================
{
  const N = 10000;
  const rows = [];
  // 10% excise: every 10th event becomes a fact that is then excised.
  // To avoid degenerate trees, every later event randomly picks 1-3 ancestors
  // from the running set of facts emitted so far. Deterministic PRNG (xorshift32
  // seeded with a constant) for repeatability.
  let seed = 0x9E3779B9;
  function xorshift() {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xFFFFFFFF;
  }

  const factIds = [];
  for (let i = 0; i < N; i++) {
    const id = `f_${i}`;
    const ancestors = [];
    if (i > 0) {
      const fanin = 1 + Math.floor(xorshift() * 3); // 1..3
      for (let k = 0; k < fanin; k++) {
        const idx = Math.floor(xorshift() * factIds.length);
        const a = factIds[idx];
        if (a != null && !ancestors.includes(a)) ancestors.push(a);
      }
    }
    rows.push({
      id,
      kind: "fact",
      derived_from: ancestors,
    });
    factIds.push(id);

    // Every 10th iteration, emit an excise on the most-recently-added fact.
    if (i > 0 && i % 10 === 0) {
      rows.push({
        id: `exc_${i}`,
        kind: "policy",
        policy_kind: "excise",
        targets: [`f_${i - 1}`],
        derivation_policy: "drop",
      });
    }
  }
  writeLedger(rows);

  const t0 = Date.now();
  const orphanMapCold = await loadTransitiveOrphanMap();
  const coldMs = Date.now() - t0;
  check(
    `T11 cold-cache build < 200ms (got ${coldMs}ms)`,
    coldMs < 200,
    `target was 200ms`,
  );
  check(
    "T11 orphan map produced non-trivial result",
    orphanMapCold.size > 0,
    `got size=${orphanMapCold.size}`,
  );

  // Second call: cache hit; should be <5ms even on slow machines.
  const t1 = Date.now();
  const orphanMapWarm = await loadTransitiveOrphanMap();
  const warmMs = Date.now() - t1;
  check(
    `T11 warm-cache lookup < 5ms (got ${warmMs}ms)`,
    warmMs < 5,
    `target was 5ms`,
  );
  check(
    "T11 warm cache returns the same Map instance",
    orphanMapCold === orphanMapWarm,
    `cache should return cached reference`,
  );
}

// ===========================================================================
// Test 12: Cache invalidation on ledger append.
// First recall sees no excise; append an excise; second recall must see it.
// ===========================================================================
{
  writeLedger([
    { id: "B", kind: "fact", content: "ancestor" },
    { id: "A", kind: "fact", derived_from: ["B"] },
  ]);
  const orphanMap1 = await loadTransitiveOrphanMap();
  check(
    "T12 pre-excise: orphan map is empty",
    orphanMap1.size === 0,
    `got size=${orphanMap1.size}`,
  );

  // Append the excise row directly without resetting caches: the loader's
  // mtime+size cache key MUST detect this and recompute. Force a small delay
  // so the mtime tick is observable on filesystems with second-level mtime
  // resolution (HFS+).
  await new Promise((r) => setTimeout(r, 25));
  appendFileSync(
    LEDGER_PATH,
    JSON.stringify({
      id: "exc_12",
      kind: "policy",
      policy_kind: "excise",
      targets: ["B"],
      derivation_policy: "drop",
    }) + "\n",
    "utf8",
  );

  // No _resetTransitiveOrphanCaches() — we are testing the production cache
  // invalidation path.
  const orphanMap2 = await loadTransitiveOrphanMap();
  check(
    "T12 post-excise: A is in orphan map (cache busted)",
    orphanMap2.has("A"),
    `orphan map size=${orphanMap2.size}`,
  );
  check(
    "T12 orphan map identity DIFFERS pre/post append",
    orphanMap1 !== orphanMap2,
  );
}

// ---------------------------------------------------------------------------
// Bonus: assert loadDerivationGraph stays consistent.
// ---------------------------------------------------------------------------
{
  writeLedger([
    { id: "X", kind: "fact" },
    { id: "Y", kind: "fact", derived_from: ["X"] },
    { id: "Z", kind: "fact", derived_from: ["X", "Y"] },
  ]);
  const graph = await loadDerivationGraph();
  const xKids = graph.get("X");
  const yKids = graph.get("Y");
  check(
    "Graph: X has 2 descendants",
    xKids != null && xKids.size === 2 && xKids.has("Y") && xKids.has("Z"),
    xKids ? `got ${[...xKids].join(",")}` : "missing",
  );
  check(
    "Graph: Y has 1 descendant",
    yKids != null && yKids.size === 1 && yKids.has("Z"),
    yKids ? `got ${[...yKids].join(",")}` : "missing",
  );
}

// ---------------------------------------------------------------------------
// Test 13 (Q4 — memperf): a FRESH PROCESS cold-seeding from the persisted
// checkpoint-validated scan cache + delta fold yields an orphan map
// DEEP-EQUAL to a full scan — over a transitive chain, with a duplicate-id
// row in the delta. (Reversal-in-delta coverage lives in hard-gates.test.mjs
// Test 6; this pins the transitive-BFS output over the same cold seed.)
// ---------------------------------------------------------------------------
{
  const hg = await import("../lib/recall/hard-gates.js");
  const cachePath = join(STORAGE_DIR, "hard-gates-scan.cache.json");

  writeLedger([
    { id: "root", kind: "fact" },
    { id: "mid", kind: "reconstructed", derived_from: ["root"] },
    {
      id: "ex_root",
      kind: "policy",
      policy_kind: "excise",
      targets: ["root"],
      derivation_policy: "drop",
    },
  ]);
  // Drain persists SCHEDULED BY EARLIER TESTS before clearing the cache file:
  // the Bonus block's loadDerivationGraph cold seed schedules a fire-and-
  // forget persist that would otherwise race this test — firing after the
  // rmSync below and re-landing a STALE (pre-rewrite) cache payload over the
  // fresh one, so the post-delta cold seed fails closed into a full rebuild
  // (correct but not the incremental mode this test pins).
  await hg._awaitPendingScanCachePersists();
  try {
    rmSync(cachePath, { force: true });
  } catch {}

  const primed = await loadTransitiveOrphanMap();
  check("T13 cold prime orphans mid", primed.get("mid")?.transitive_orphan === true);
  check(
    "T13 cold prime was a full rebuild",
    hg.__peekScanColdStatsForTests()?.mode === "full-rebuild",
  );
  await hg._awaitPendingScanCachePersists();

  // Delta: a grandchild (reaches distance 2 through the CACHED prefix graph)
  // plus a duplicate-id row for `mid` adding a second parent.
  appendFileSync(
    LEDGER_PATH,
    [
      JSON.stringify({ id: "grand", kind: "reconstructed", derived_from: ["mid"] }),
      JSON.stringify({ id: "mid", kind: "reconstructed", derived_from: ["root", "other"] }),
    ].join("\n") + "\n",
    "utf8",
  );
  _resetTransitiveOrphanCaches(); // fresh-process simulation (disk cache stays)

  const merged = await loadTransitiveOrphanMap();
  const stats = hg.__peekScanColdStatsForTests();
  check("T13 fresh process cold seed is incremental", stats?.mode === "incremental",
    JSON.stringify(stats));
  check("T13 delta folds exactly 2 rows", stats?.rows_folded === 2, `got ${stats?.rows_folded}`);
  check(
    "T13 appended grandchild reached through the cached prefix graph",
    merged.get("grand")?.transitive_orphan === true &&
      merged.get("grand")?.distance_to_nearest_excised === 2,
  );

  // Ground truth: full scan with the disk cache removed.
  rmSync(cachePath, { force: true });
  _resetTransitiveOrphanCaches();
  const full = await loadTransitiveOrphanMap();
  const canon = (m) => {
    const out = {};
    for (const [k, v] of m) {
      out[k] = [v.distance_to_nearest_excised, v.transitive_orphan, v.rescued_by_corroboration];
    }
    return JSON.stringify(out);
  };
  check(
    "T13 cache+delta orphan map deep-equals full scan (duplicate id included)",
    canon(merged) === canon(full),
    `merged=${canon(merged)} full=${canon(full)}`,
  );
  await hg._awaitPendingScanCachePersists();
}

// ---------------------------------------------------------------------------
// Exit.
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nAll transitive-orphan tests passed.");
