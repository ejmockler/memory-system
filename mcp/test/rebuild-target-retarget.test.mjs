// rebuild-target-retarget.test.mjs — l11: the argument-less BM25 rebuild target
// is the ACTIVE embedding model, not the legacy Gemini tree.
//
// WHY THIS FILE EXISTS. `daemons/watermark.js` calls `maybeRunBm25Rebuild()`
// with NO arguments, and `publishGeneration` (lib/recall/index-cache.js)
// mkdirs its target tree unconditionally. So the value
// `_defaultRebuildModelVersion()` returns with every flag unset decides which
// directory the periodic rebuild RESURRECTS. T2 below is the resurrection
// assertion: an argument-less rebuild must leave indices/gemini-embedding-001
// non-existent.
//
// Hermetic: every ledger, state file, sidecar and published generation this
// file creates lives under TMP_ROOT (mkdtemp), removed on process exit. No
// fixture ever points at the real MEMORY_ROOT. Env is assigned BEFORE the
// dynamic import()s because lib/config.js binds MEMORY_ROOT / STORAGE_DIR at
// module-eval time.
//
// Registered in scripts/run-all-tests.mjs by node l9-suite-gate on 2026-08-15
// (it shipped unregistered only so concurrent nodes would not collide on that
// file, which is also why the runner exits 2 on disk-vs-registry drift).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TMP_ROOT = mkdtempSync(
  join(tmpdir(), "memory-system-rebuild-target-retarget-"),
);
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
delete process.env.MEMORY_BM25_MODEL_NEUTRAL;
delete process.env.MEMORY_BM25_REBUILD_TARGET_ACTIVE;
delete process.env.MEMORY_BM25_REBUILD_TARGET_LEGACY;
delete process.env.MEMORY_BM25_REBUILD_OBJECT_ENTITIES;

for (const dir of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  join(MEMORY_ROOT, "indices"),
]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort fixture cleanup
  }
});

const REBUILD_MODULE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "lib",
  "recall",
  "bm25-rebuild.js",
);

const {
  BM25_REBUILD_LEGACY_MODEL_VERSION,
  BM25_REBUILD_OBJECT_ENTITIES_FLAG,
  BM25_REBUILD_TARGET_ACTIVE_FLAG,
  BM25_REBUILD_TARGET_LEGACY_FLAG,
  _defaultRebuildModelVersion,
  maybeRunBm25Rebuild,
  readRebuildState,
  rebuildBm25IndexFromLedger,
} = await import("../lib/recall/bm25-rebuild.js");
const { BM25_MODEL_NEUTRAL_FLAG, LEXICAL_INDEX_KEY } = await import(
  "../lib/recall/bm25-projection.js"
);
const { loadBm25IndexFromV2File } = await import(
  "../lib/recall/bm25-streaming-loader.js"
);
const { CAPS } = await import("../lib/validation.js");

// l7 — the deletion-predicate verifier. Imported for its PURE exports only;
// the module's `main()` is guarded behind a direct-execution check precisely
// so this import cannot spawn the coverage gate against the live tree. The
// end-to-end arms below spawn it as a child process instead.
const DELETABLE_VERIFIER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "verify-legacy-tree-deletable.mjs",
);
const {
  LEGACY_TREE_FRESHNESS_WINDOW_MS,
  assessResurrectionPredicates,
  evaluateFreshness,
  inventoryTree,
} = await import(pathToFileURL(DELETABLE_VERIFIER).href);

const ACTIVE_MODEL = CAPS.ACTIVE_EMBED_MODEL_VERSION;
const LEGACY_MODEL = CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT;
const GEMINI_DIR = join(MEMORY_ROOT, "indices", "gemini-embedding-001");
const ACTIVE_DIR = join(MEMORY_ROOT, "indices", ACTIVE_MODEL);
const STATE_PATH = join(process.env.STORAGE_BASE_DIR, "bm25-rebuild-state.json");
const SIDECAR_PATH = join(
  process.env.STORAGE_BASE_DIR,
  "bm25-growth-check.json",
);

function clearFlags() {
  delete process.env[BM25_MODEL_NEUTRAL_FLAG];
  delete process.env[BM25_REBUILD_TARGET_ACTIVE_FLAG];
  delete process.env.MEMORY_BM25_REBUILD_TARGET_LEGACY;
  if (typeof BM25_REBUILD_TARGET_LEGACY_FLAG === "string") {
    delete process.env[BM25_REBUILD_TARGET_LEGACY_FLAG];
  }
  delete process.env[BM25_REBUILD_OBJECT_ENTITIES_FLAG];
}

function removeIfPresent(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function clearSchedulerState() {
  removeIfPresent(STATE_PATH);
  removeIfPresent(SIDECAR_PATH);
}

function writeLedger(name, rows) {
  const path = join(process.env.LEDGERS_BASE_DIR, `${name}.jsonl`);
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return path;
}

function factRows(count, tag) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      id: `mem_${tag}_${String(i).padStart(4, "0")}`,
      kind: "fact",
      content: `${tag} row ${i} shared lexical payload alpha_${i % 7}`,
      created_at: `2026-08-15T00:${String(i % 60).padStart(2, "0")}:00.000Z`,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// T1 — flag-off default flips to the ACTIVE model.
// ---------------------------------------------------------------------------
await test("T1 flag-off default resolves the ACTIVE model, never gemini", () => {
  clearFlags();
  assert.equal(_defaultRebuildModelVersion(), ACTIVE_MODEL);
  assert.notEqual(_defaultRebuildModelVersion(), "gemini-embedding-001");
  assert.notEqual(ACTIVE_MODEL, "gemini-embedding-001");
});

// ---------------------------------------------------------------------------
// T2 — THE RESURRECTION ASSERTION. An argument-less rebuild (exactly what the
// watermark daemon performs) must publish into the ACTIVE tree and must NOT
// re-create indices/gemini-embedding-001.
// ---------------------------------------------------------------------------
await test("T2 argument-less rebuild publishes to ACTIVE and creates no gemini tree", () => {
  clearFlags();
  clearSchedulerState();
  assert.equal(
    existsSync(GEMINI_DIR),
    false,
    "precondition: no gemini tree in the hermetic root",
  );

  const ledgerPath = writeLedger("t2-default-target", factRows(5, "t2"));
  const result = rebuildBm25IndexFromLedger({
    ledgerPath,
    contextualPrefix: false,
  });

  assert.equal(result.model_version, ACTIVE_MODEL);
  assert.equal(result.rows_indexed, 5);
  assert.equal(result.wrote_index, true);
  assert.equal(
    result.bm25_path,
    join(MEMORY_ROOT, "indices", ACTIVE_MODEL, "bm25.json"),
  );
  assert.ok(existsSync(result.bm25_path), "ACTIVE bm25.json on disk");
  assert.equal(
    existsSync(GEMINI_DIR),
    false,
    "the argument-less rebuild must not resurrect indices/gemini-embedding-001",
  );
});

// ---------------------------------------------------------------------------
// T3 — the full precedence lattice, read at CALL time. Every case is a pure
// resolver assertion or a dry run, so this test creates no gemini tree (T6
// re-checks that at the end of the file).
// ---------------------------------------------------------------------------
await test("T3 precedence: explicit > LEGACY > ACTIVE > NEUTRAL > active default", () => {
  clearFlags();

  // The legacy escape hatch exists and names the legacy tree.
  assert.equal(BM25_REBUILD_LEGACY_MODEL_VERSION, "gemini-embedding-001");
  assert.equal(
    BM25_REBUILD_TARGET_LEGACY_FLAG,
    "MEMORY_BM25_REBUILD_TARGET_LEGACY",
  );

  // Nothing set -> active.
  assert.equal(_defaultRebuildModelVersion(), ACTIVE_MODEL);

  // Exact "1" discipline: "true" is not truthy for any flag.
  process.env[BM25_REBUILD_TARGET_LEGACY_FLAG] = "true";
  assert.equal(_defaultRebuildModelVersion(), ACTIVE_MODEL);
  process.env[BM25_REBUILD_TARGET_LEGACY_FLAG] = "1";
  assert.equal(_defaultRebuildModelVersion(), LEGACY_MODEL);

  // LEGACY beats ACTIVE.
  process.env[BM25_REBUILD_TARGET_ACTIVE_FLAG] = "1";
  assert.equal(
    _defaultRebuildModelVersion(),
    LEGACY_MODEL,
    "the explicit legacy opt-in wins over the ACTIVE alias",
  );

  // ACTIVE alias still beats NEUTRAL (pre-existing pin, preserved).
  delete process.env[BM25_REBUILD_TARGET_LEGACY_FLAG];
  process.env[BM25_MODEL_NEUTRAL_FLAG] = "1";
  assert.equal(_defaultRebuildModelVersion(), ACTIVE_MODEL);
  process.env[BM25_REBUILD_TARGET_ACTIVE_FLAG] = "true";
  assert.equal(
    _defaultRebuildModelVersion(),
    LEXICAL_INDEX_KEY,
    "a non-exact ACTIVE flag does not shadow the neutral projection",
  );
  delete process.env[BM25_REBUILD_TARGET_ACTIVE_FLAG];
  assert.equal(_defaultRebuildModelVersion(), LEXICAL_INDEX_KEY);

  // Call-time reads, not import-time: flipping env between two calls in the
  // same test changes the answer.
  clearFlags();
  assert.equal(_defaultRebuildModelVersion(), ACTIVE_MODEL);
  process.env[BM25_REBUILD_TARGET_LEGACY_FLAG] = "1";
  assert.equal(_defaultRebuildModelVersion(), LEGACY_MODEL);

  // The legacy tree is still reachable end-to-end through the flag (dry run:
  // this test never writes a gemini tree).
  const ledgerPath = writeLedger("t3-legacy-optin", factRows(3, "t3"));
  const viaFlag = rebuildBm25IndexFromLedger({
    ledgerPath,
    dryRun: true,
    contextualPrefix: false,
  });
  assert.equal(viaFlag.model_version, LEGACY_MODEL);

  // Explicit opts.modelVersion beats every flag, in both directions.
  process.env[BM25_MODEL_NEUTRAL_FLAG] = "1";
  process.env[BM25_REBUILD_TARGET_ACTIVE_FLAG] = "1";
  const explicitLegacy = rebuildBm25IndexFromLedger({
    ledgerPath,
    modelVersion: "gemini-embedding-001",
    dryRun: true,
    contextualPrefix: false,
  });
  assert.equal(explicitLegacy.model_version, "gemini-embedding-001");

  clearFlags();
  const explicitOther = rebuildBm25IndexFromLedger({
    ledgerPath,
    modelVersion: "l11-explicit-model",
    dryRun: true,
    contextualPrefix: false,
  });
  assert.equal(explicitOther.model_version, "l11-explicit-model");
  clearFlags();
});

// ---------------------------------------------------------------------------
// T4 — the model-aware trigger. bm25-rebuild-state.json is ONE GLOBAL FILE,
// not per-model, so without this the retarget is inert: the daemon would
// compare the (empty) active tree against the legacy tree's recorded baseline
// and skip. Four directions, plus backward compatibility for state files
// written before last_rebuild_model_version existed.
// ---------------------------------------------------------------------------
function seedState({ model, factCount, ledgerSize }) {
  clearSchedulerState();
  const state = {
    last_rebuild_ts: "2026-08-01T00:00:00.000Z",
    last_rebuild_ledger_size: ledgerSize,
    last_rebuild_fact_count: factCount,
  };
  if (model !== undefined) state.last_rebuild_model_version = model;
  writeFileSync(STATE_PATH, JSON.stringify(state));
}

await test("T4 model mismatch rebuilds; matching model keeps skip semantics", () => {
  clearFlags();
  const rows = factRows(6, "t4");
  const ledgerPath = writeLedger("t4-trigger", rows);
  const currentSize = readFileSync(ledgerPath).length;

  // ARMING. Every call below now sets MEMORY_BM25_REBUILD_TARGET_ACTIVE=1.
  // That is l11's wave-4 arming gate (T7), not a weakening of this test: the
  // flag only selects the SAME target the flags-cleared default resolves
  // (T1/T3 pin that equivalence), so every action string asserted here is the
  // one an armed daemon would see. Without it the gate short-circuits to
  // "disabled" before the state file is ever read and the model-mismatch
  // property below would not be exercised at all.
  process.env[BM25_REBUILD_TARGET_ACTIVE_FLAG] = "1";

  // (a) mismatch + GROWN ledger -> rebuilt (delta would otherwise be
  // 6 - 1_500_000, far below threshold).
  //
  // THIS SUB-CASE ENCODED THE PRODUCTION HAZARD. Before the arming gate, this
  // is exactly the state the live system was in — storage/bm25-rebuild-state.json
  // records last_rebuild_model_version "gemini-embedding-001" while the
  // retargeted default resolves the ACTIVE model — so the argument-less
  // watermark tick would have taken this "rebuilt" branch on its next restart
  // and published a full rebuild over the served tree. The model-awareness
  // proved here is correct and stays; T7 is what makes it require an operator.
  seedState({
    model: "gemini-embedding-001",
    factCount: 1_500_000,
    ledgerSize: 1,
  });
  const a = maybeRunBm25Rebuild({ ledgerPath, threshold: 5000 });
  assert.equal(a.action, "rebuilt");
  assert.equal(a.result.model_version, ACTIVE_MODEL);
  assert.equal(
    a.last_rebuild_fact_count,
    null,
    "a cross-tree baseline must not be reported as this tree's last count",
  );
  assert.equal(
    a.delta,
    a.current_fact_count,
    "first-run semantics: delta is the full fact count, not a cross-tree difference",
  );

  // (b) matching model + same high baseline + grown ledger ->
  // skipped_below_threshold.
  seedState({ model: ACTIVE_MODEL, factCount: 1_500_000, ledgerSize: 1 });
  const b = maybeRunBm25Rebuild({ ledgerPath, threshold: 5000 });
  assert.equal(b.action, "skipped_below_threshold");
  assert.equal(b.last_rebuild_fact_count, 1_500_000);

  // (c) mismatch + NOT-grown ledger -> rebuilt. This is the case that would
  // otherwise leave the retarget inert forever: the cheap no-growth pre-check
  // returns before the fact count is ever consulted.
  seedState({
    model: "gemini-embedding-001",
    factCount: 1_500_000,
    ledgerSize: currentSize + 4096,
  });
  const c = maybeRunBm25Rebuild({ ledgerPath, threshold: 5000 });
  assert.equal(c.action, "rebuilt");
  assert.equal(c.result.model_version, ACTIVE_MODEL);
  assert.equal(c.last_rebuild_fact_count, null);

  // (b') matching model + NOT-grown ledger -> skipped_no_growth (untouched).
  seedState({
    model: ACTIVE_MODEL,
    factCount: 1_500_000,
    ledgerSize: currentSize + 4096,
  });
  const bPrime = maybeRunBm25Rebuild({ ledgerPath, threshold: 5000 });
  assert.equal(bPrime.action, "skipped_no_growth");
  assert.equal(bPrime.last_rebuild_fact_count, 1_500_000);

  // Backward compatibility: a state file with NO last_rebuild_model_version
  // (every file written before that key existed) is NOT a mismatch and keeps
  // the pre-change decisions in both directions.
  seedState({ model: undefined, factCount: 1_500_000, ledgerSize: 1 });
  const legacyStateGrown = maybeRunBm25Rebuild({ ledgerPath, threshold: 5000 });
  assert.equal(legacyStateGrown.action, "skipped_below_threshold");
  assert.equal(legacyStateGrown.last_rebuild_fact_count, 1_500_000);

  seedState({
    model: undefined,
    factCount: 1_500_000,
    ledgerSize: currentSize + 4096,
  });
  const legacyStateFlat = maybeRunBm25Rebuild({ ledgerPath, threshold: 5000 });
  assert.equal(legacyStateFlat.action, "skipped_no_growth");
  assert.equal(legacyStateFlat.last_rebuild_fact_count, 1_500_000);

  clearSchedulerState();
  clearFlags();
});

// ---------------------------------------------------------------------------
// T5 — single-symbol containment. A later node deletes the CAPS key
// GEMINI_EMBEDDING_MODEL_DEFAULT; this pin is what makes that a one-line edit
// instead of two TypeErrors.
// ---------------------------------------------------------------------------
function nonCommentLines(source) {
  const out = [];
  let inBlock = false;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes("*/")) inBlock = false;
      continue;
    }
    if (trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("*")) continue;
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlock = true;
      continue;
    }
    out.push(line);
  }
  return out;
}

await test("T5 GEMINI_EMBEDDING_MODEL_DEFAULT survives in one non-comment line", () => {
  const source = readFileSync(REBUILD_MODULE_PATH, "utf8");
  const stripped = nonCommentLines(source);
  const hits = stripped.filter((line) =>
    line.includes("GEMINI_EMBEDDING_MODEL_DEFAULT"),
  );
  assert.equal(
    hits.length,
    1,
    `expected exactly one non-comment reference, got ${hits.length}:\n${hits.join("\n")}`,
  );
  // ...and that one reference is the legacy-symbol declaration, so the
  // downstream purge deletes a `const`, not a live decision site.
  assert.match(
    stripped.join("\n"),
    /export const BM25_REBUILD_LEGACY_MODEL_VERSION\s*=\s*CAPS\.GEMINI_EMBEDDING_MODEL_DEFAULT\s*;/,
  );
});

// ---------------------------------------------------------------------------
// T5b — the downstream-purge degradation path, exercised rather than asserted
// by inspection. A copy of the module with its single CAPS reference replaced
// by "" (what l6's deletion degrades to) must fall through to the ACTIVE model
// under the legacy opt-in, NOT return an empty path component that would make
// publishGeneration mkdir join(root, "indices", "").
// ---------------------------------------------------------------------------
await test("T5b an empty legacy constant degrades to the ACTIVE model, not an empty path", async () => {
  clearFlags();
  const source = readFileSync(REBUILD_MODULE_PATH, "utf8");
  const libDir = join(dirname(REBUILD_MODULE_PATH), "..");
  const recallDir = dirname(REBUILD_MODULE_PATH);
  const rewritten = source
    .replace(/from "\.\.\//g, `from "${pathToFileURL(libDir).href}/`)
    .replace(/from "\.\//g, `from "${pathToFileURL(recallDir).href}/`)
    .replace(/CAPS\.GEMINI_EMBEDDING_MODEL_DEFAULT/g, '""');
  assert.ok(
    !rewritten.includes("CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT"),
    "stub actually removed the CAPS reference",
  );

  const stubPath = join(TMP_ROOT, "bm25-rebuild-legacy-deleted.mjs");
  writeFileSync(stubPath, rewritten);
  const stub = await import(pathToFileURL(stubPath).href);

  assert.equal(stub._defaultRebuildModelVersion(), ACTIVE_MODEL);
  process.env[BM25_REBUILD_TARGET_LEGACY_FLAG] = "1";
  assert.equal(
    stub._defaultRebuildModelVersion(),
    ACTIVE_MODEL,
    "with the legacy constant gone the opt-in is inert, never an empty model id",
  );
  clearFlags();
});

// ---------------------------------------------------------------------------
// T6 — nothing in this file ever created the legacy tree.
// ---------------------------------------------------------------------------
await test("T6 no gemini tree exists anywhere under the hermetic root", () => {
  assert.equal(existsSync(GEMINI_DIR), false);
});

// ---------------------------------------------------------------------------
// T7/T8/T9 — the DAEMON-SEAM arming gate and the entity-drop refusal.
//
// Retargeting the argument-less default (T1/T2) is necessary but NOT
// sufficient. The watermark daemon dispatches `maybeRunBm25Rebuild()` with no
// arguments (daemons/watermark.js:2777), so after the retarget that periodic
// full rebuild aims at the tree queryd actually serves
// (QUERYD_MODEL_VERSIONS=qwen3-embedding-8b-fp16 in
// com.user.memory-system.queryd.plist). Two independent problems follow, and
// these three tests pin the fix for both:
//
//   T7 — ARMING. A full rebuild of the live tree is an operator action, never
//        a daemon surprise. Unless a target is chosen EXPLICITLY (an
//        opts.modelVersion argument or one of the exact-"1" env opt-ins),
//        maybeRunBm25Rebuild must return before any I/O and write nothing.
//
//   T8 — ENTITY-DROP REFUSAL. Even when armed, the string-only entity
//        projection silently drops production-shaped {canonical_id} entities
//        unless MEMORY_BM25_REBUILD_OBJECT_ENTITIES=1. Publishing that over a
//        served index would replace it with one holding no entities at all, so
//        the rebuild REFUSES instead of writing.
//
//   T9 — the regression pin the two layers exist for: over a ledger carrying
//        the production entity shape, a fully argument-less call must never
//        report "rebuilt".
// ---------------------------------------------------------------------------

// Production entity shape, as written by the synthesis entity extractor:
// objects carrying {canonical_id, kind, surface}. Measured on the live ledger
// tail in this session (last 500 lines: 85 rows with entities, 429
// object-shaped, 0 string-shaped) — the string form the default projection
// accepts does not occur there.
function objectEntityRows(count, tag) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      id: `mem_${tag}_${String(i).padStart(4, "0")}`,
      kind: "fact",
      content: `${tag} row ${i} carries a production shaped entity`,
      created_at: `2026-08-15T01:${String(i % 60).padStart(2, "0")}:00.000Z`,
      features: {
        entities: [
          {
            kind: "PERSON",
            canonical_id: `person:${tag}:${i % 3}`,
            surface: `Person ${i % 3}`,
          },
        ],
      },
    });
  }
  return rows;
}

function clearIndexTrees() {
  // Hermetic fixture only — both paths are inside TMP_ROOT.
  rmSync(ACTIVE_DIR, { recursive: true, force: true });
  rmSync(GEMINI_DIR, { recursive: true, force: true });
}

await test("T7 unarmed maybeRunBm25Rebuild is disabled and writes nothing anywhere", () => {
  clearFlags();
  clearSchedulerState();
  clearIndexTrees();
  assert.equal(existsSync(ACTIVE_DIR), false, "precondition: no ACTIVE tree");
  assert.equal(existsSync(GEMINI_DIR), false, "precondition: no legacy tree");

  // A GROWN ledger with no state file at all: pre-gate this was an
  // unconditional first-run rebuild.
  const ledgerPath = writeLedger("t7-unarmed", factRows(12, "t7"));

  const res = maybeRunBm25Rebuild({ ledgerPath, threshold: 5000 });
  assert.equal(res.action, "disabled");
  assert.equal(res.reason, "no_explicit_rebuild_target");
  assert.equal(res.delta, 0);
  assert.equal(res.threshold, 5000);
  assert.equal(res.current_fact_count, 0);
  assert.equal(res.last_rebuild_fact_count, null);

  assert.equal(
    existsSync(ACTIVE_DIR),
    false,
    "the unarmed daemon path must not publish into the tree queryd serves",
  );
  assert.equal(
    existsSync(GEMINI_DIR),
    false,
    "nor resurrect the legacy tree",
  );
  assert.equal(readRebuildState(), null, "no state persisted by a no-op");

  // Arming by env flag alone (no argument) still reaches the ACTIVE tree —
  // the gate withholds the DEFAULT, it does not disable the feature.
  process.env[BM25_REBUILD_TARGET_ACTIVE_FLAG] = "1";
  const armed = maybeRunBm25Rebuild({ ledgerPath, threshold: 5000 });
  assert.equal(armed.action, "rebuilt");
  assert.equal(armed.result.model_version, ACTIVE_MODEL);
  assert.equal(existsSync(join(ACTIVE_DIR, "bm25.json")), true);

  clearFlags();
  clearSchedulerState();
  clearIndexTrees();
});

await test("T8 armed + object entities refuses to publish; the opt-in publishes", () => {
  clearFlags();
  clearSchedulerState();
  clearIndexTrees();

  const rows = objectEntityRows(8, "t8");
  const ledgerPath = writeLedger("t8-object-entities", rows);

  // Seed a legacy-model state so the model-mismatch first-run path is taken
  // and the decision genuinely reaches the rebuild (not a threshold skip).
  const seeded = {
    last_rebuild_ts: "2026-08-01T00:00:00.000Z",
    last_rebuild_ledger_size: 1,
    last_rebuild_fact_count: 1_500_000,
    last_rebuild_model_version: "gemini-embedding-001",
  };
  writeFileSync(STATE_PATH, JSON.stringify(seeded));
  const stateBefore = readFileSync(STATE_PATH);

  // (a) armed, object-entity acceptance OFF -> refuse, write nothing.
  process.env[BM25_REBUILD_TARGET_ACTIVE_FLAG] = "1";
  const refused = maybeRunBm25Rebuild({ ledgerPath, threshold: 5000 });
  assert.equal(refused.action, "rebuild_failed");
  assert.equal(refused.error, "would_drop_object_entities");
  assert.equal(refused.result.object_entities_dropped, rows.length);
  assert.equal(refused.result.wrote_index, false);
  assert.equal(refused.result.bytes_written, 0);
  assert.equal(
    existsSync(join(ACTIVE_DIR, "bm25.json")),
    false,
    "a refusal must leave the served index untouched",
  );
  assert.deepEqual(
    readFileSync(STATE_PATH),
    stateBefore,
    "a refusal must not advance the rebuild state — the next tick re-tries",
  );

  // (b) same call with the object-entity opt-in -> rebuilt, entities indexed.
  process.env[BM25_REBUILD_OBJECT_ENTITIES_FLAG] = "1";
  const built = maybeRunBm25Rebuild({ ledgerPath, threshold: 5000 });
  assert.equal(built.action, "rebuilt");
  assert.equal(built.result.model_version, ACTIVE_MODEL);
  assert.equal(built.result.object_entities_dropped, 0);
  assert.equal(built.result.wrote_index, true);
  const index = loadBm25IndexFromV2File(built.result.bm25_path);
  assert.ok(
    index.searchEntities(["person:t8:0"]).length > 0,
    "the seeded canonical_id must be searchable in the published index",
  );
  assert.equal(readRebuildState().last_rebuild_model_version, ACTIVE_MODEL);

  clearFlags();
  clearSchedulerState();
  clearIndexTrees();
});

await test("T9 a fully argument-less rebuild over production-shaped entities never rebuilds", () => {
  clearFlags();
  clearSchedulerState();
  clearIndexTrees();

  // Written at memoryLedgerPath() so the call below is argument-less in the
  // exact sense daemons/watermark.js:2777 is — no ledgerPath, no modelVersion,
  // no threshold override.
  writeFileSync(
    join(process.env.LEDGERS_BASE_DIR, "memory.jsonl"),
    objectEntityRows(9, "t9").map((r) => JSON.stringify(r)).join("\n") + "\n",
  );

  const res = maybeRunBm25Rebuild();
  assert.notEqual(
    res.action,
    "rebuilt",
    "re-arming the argument-less daemon default would drop every production entity",
  );
  assert.equal(res.action, "disabled");
  assert.equal(res.reason, "no_explicit_rebuild_target");
  assert.equal(existsSync(ACTIVE_DIR), false);
  assert.equal(existsSync(GEMINI_DIR), false);

  clearSchedulerState();
  clearIndexTrees();
});

await test("T10 MEMORY_BM25_MODEL_NEUTRAL alone does not arm the daemon rebuild", () => {
  // MEMORY_BM25_MODEL_NEUTRAL is a recall-side READ selector: it is consumed by
  // resolveBm25Member (lib/recall/bm25-projection.js) to choose WHICH bm25 path
  // recall loads. Naming a target is not authorization to write one, so it must
  // not arm the argument-less daemon seam. This test is the pin for that.
  clearFlags();
  clearSchedulerState();
  clearIndexTrees();

  // clearIndexTrees() only knows ACTIVE_DIR and GEMINI_DIR; the neutral flag
  // names a third target, so this test clears that one too. Hermetic: the
  // assertion below proves the path is inside the mkdtemp root before any rm.
  const LEXICAL_DIR = join(MEMORY_ROOT, "indices", LEXICAL_INDEX_KEY);
  assert.equal(
    LEXICAL_DIR.startsWith(TMP_ROOT),
    true,
    "fixture containment: the lexical tree must live under TMP_ROOT",
  );
  rmSync(LEXICAL_DIR, { recursive: true, force: true });

  assert.equal(existsSync(ACTIVE_DIR), false, "precondition: no ACTIVE tree");
  assert.equal(existsSync(GEMINI_DIR), false, "precondition: no legacy tree");
  assert.equal(existsSync(LEXICAL_DIR), false, "precondition: no lexical tree");

  // ONLY the read-side selector. Both TARGET opt-ins stay unset (clearFlags).
  process.env[BM25_MODEL_NEUTRAL_FLAG] = "1";

  // Load-bearing: the flag is still fully effective for target NAMING. Without
  // this, T10 could pass merely because the flag had become inert — what is
  // being asserted below is that ARMING is withheld, not that the flag is dead.
  assert.equal(_defaultRebuildModelVersion(), LEXICAL_INDEX_KEY);

  const ledgerPath = writeLedger("t10-neutral-unarmed", factRows(12, "t10"));
  const res = maybeRunBm25Rebuild({ ledgerPath, threshold: 5000 });

  assert.equal(res.action, "disabled");
  assert.equal(res.reason, "no_explicit_rebuild_target");
  assert.equal(res.delta, 0);
  assert.equal(res.threshold, 5000);
  assert.equal(res.current_fact_count, 0);
  assert.equal(res.last_rebuild_fact_count, null);

  assert.equal(
    existsSync(ACTIVE_DIR),
    false,
    "a read-side flag must not reach the tree queryd serves",
  );
  assert.equal(existsSync(GEMINI_DIR), false, "nor resurrect the legacy tree");
  assert.equal(existsSync(LEXICAL_DIR), false, "nor publish a neutral tree");
  assert.equal(readRebuildState(), null, "no state persisted by a no-op");
  assert.equal(existsSync(SIDECAR_PATH), false, "no growth-check sidecar");

  // Positive control: with the neutral flag STILL set, adding the explicit
  // ACTIVE opt-in arms the same argument-less call. T3 already pins that ACTIVE
  // outranks NEUTRAL in target resolution, so ACTIVE_MODEL is the expected
  // target here.
  process.env[BM25_REBUILD_TARGET_ACTIVE_FLAG] = "1";
  const armed = maybeRunBm25Rebuild({ ledgerPath, threshold: 5000 });
  assert.equal(armed.action, "rebuilt");
  assert.equal(armed.result.model_version, ACTIVE_MODEL);

  clearFlags();
  clearSchedulerState();
  clearIndexTrees();
  rmSync(LEXICAL_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// l7 — DELETION-PREDICATE ARMS.
//
// These live here, in the suite that already owns "the argument-less rebuild
// must not resurrect indices/gemini-embedding-001" (T2), rather than in a new
// file: scripts/run-all-tests.mjs's suite parity is exact (293 registered ==
// 293 on disk) and an unregistered new test/**/*.test.mjs re-trips the
// runner's exit-2 drift gate. Same predicate, same home.
//
// Hermetic: every path below is under TMP_ROOT. No arm reads MEMORY_ROOT's
// real indices/ tree, and the spawn arms are constructed so the verifier
// refuses BEFORE it reaches the coverage-gate spawn — the refusal order in
// verify-legacy-tree-deletable.mjs is load-bearing for that, and T14 pins it.
// ---------------------------------------------------------------------------

function runDeletableVerifier(args, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
  }
  const res = spawnSync(process.execPath, [DELETABLE_VERIFIER, ...args], {
    encoding: "utf8",
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
  let envelope = null;
  try {
    const line = String(res.stdout ?? "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .pop();
    envelope = line ? JSON.parse(line) : null;
  } catch {
    envelope = null;
  }
  return { status: res.status, envelope, stderr: String(res.stderr ?? "") };
}

// ---------------------------------------------------------------------------
// T11 — freshness is the REFUSAL condition, and it fails CLOSED.
// ---------------------------------------------------------------------------
await test("T11 evaluateFreshness treats a recently written manifest as a refusal", () => {
  const now = 1_787_000_000_000;
  const win = LEGACY_TREE_FRESHNESS_WINDOW_MS;

  assert.equal(typeof win, "number");
  assert.ok(win > 0, "the default window must be a positive duration");

  // Written one second ago: still moving -> refuse.
  assert.deepEqual(
    evaluateFreshness({ manifestMtimeMs: now - 1000, nowMs: now }),
    { fresh: true, age_ms: 1000, window_ms: win },
  );

  // Written one millisecond outside the window: settled -> may proceed.
  const settled = evaluateFreshness({ manifestMtimeMs: now - win - 1, nowMs: now });
  assert.equal(settled.fresh, false);
  assert.equal(settled.age_ms, win + 1);

  // Exactly ON the boundary — age === window — is NOT fresh: the comparison is
  // a strict `<`, so the window is half-open and the two arms above cannot both
  // claim the same instant.
  assert.equal(
    evaluateFreshness({ manifestMtimeMs: now - win, nowMs: now }).fresh,
    false,
  );

  // Age zero — the manifest written at this very instant — IS the freshest
  // possible tree, and must refuse.
  assert.equal(evaluateFreshness({ manifestMtimeMs: now, nowMs: now }).fresh, true);

  // A zero window therefore DISABLES the guard rather than refusing everything.
  // Recorded here so nobody reads `--freshness-window-ms=0` as "strictest".
  assert.equal(
    evaluateFreshness({ manifestMtimeMs: now, nowMs: now, windowMs: 0 }).fresh,
    false,
  );

  // FAIL CLOSED. A future-stamped manifest (clock skew, or a writer mid-flight)
  // must not read as "very old", and an unreadable stat must not read as
  // "settled": both are refusals.
  assert.equal(evaluateFreshness({ manifestMtimeMs: now + 5000, nowMs: now }).fresh, true);
  assert.equal(evaluateFreshness({ manifestMtimeMs: NaN, nowMs: now }).fresh, true);
  assert.equal(
    evaluateFreshness({ manifestMtimeMs: now - 10 * win, nowMs: NaN }).fresh,
    true,
  );

  // An explicit window is honoured rather than silently replaced by the default.
  assert.equal(
    evaluateFreshness({ manifestMtimeMs: now - 5000, nowMs: now, windowMs: 1000 }).fresh,
    false,
  );
});

// ---------------------------------------------------------------------------
// T12 — the resurrection predicates are the REAL resolvers, called, not
// grepped: flipping the legacy opt-in must flip the verdict.
// ---------------------------------------------------------------------------
await test("T12 assessResurrectionPredicates calls the live resolvers", () => {
  clearFlags();

  const clear = assessResurrectionPredicates();
  assert.equal(clear.ok, true);
  assert.equal(clear.legacy_model_version, LEGACY_MODEL);
  assert.equal(clear.checks.length, 2);
  const byName = new Map(clear.checks.map((c) => [c.name, c]));
  assert.equal(byName.get("default_rebuild_target_is_not_legacy").value, ACTIVE_MODEL);
  assert.equal(
    byName.get("lexical_projection_publish_target_is_not_legacy").value,
    ACTIVE_MODEL,
  );
  for (const c of clear.checks) {
    assert.equal(c.ok, true);
    assert.match(c.symbol, /bm25-rebuild\.js/);
  }

  // Load-bearing negative control: if this stayed ok:true with the legacy
  // opt-in armed, the predicate would be measuring nothing.
  process.env[BM25_REBUILD_TARGET_LEGACY_FLAG] = "1";
  const armed = assessResurrectionPredicates();
  assert.equal(armed.ok, false);
  const armedByName = new Map(armed.checks.map((c) => [c.name, c]));
  assert.equal(
    armedByName.get("default_rebuild_target_is_not_legacy").value,
    LEGACY_MODEL,
  );
  assert.equal(armedByName.get("default_rebuild_target_is_not_legacy").ok, false);
  // The projection redirect is env-independent and must NOT move.
  assert.equal(
    armedByName.get("lexical_projection_publish_target_is_not_legacy").ok,
    true,
  );

  clearFlags();
  assert.equal(assessResurrectionPredicates().ok, true, "flags restored");
});

// ---------------------------------------------------------------------------
// T13 — inventoryTree counts each INODE once. A hardlinked pair is the whole
// reason the reclaim number and the naive size sum differ, and the deliverable
// quotes the reclaim number.
// ---------------------------------------------------------------------------
await test("T13 inventoryTree charges a hardlinked pair once and reports it", () => {
  const dir = join(TMP_ROOT, "t13-inventory");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const payload = "x".repeat(4096);
  writeFileSync(join(dir, "hnsw.bin"), payload);
  linkSync(join(dir, "hnsw.bin"), join(dir, "hnsw.gen-3.bin"));
  writeFileSync(join(dir, "bm25.json"), "y".repeat(100));

  const inv = inventoryTree(dir);
  assert.equal(inv.error, null);
  assert.equal(inv.entries.length, 3);
  assert.equal(inv.naive_bytes, 4096 + 4096 + 100);
  assert.equal(
    inv.unique_bytes,
    4096 + 100,
    "the second name for one inode frees no additional bytes",
  );
  assert.equal(inv.multi_link_inodes.length, 1);
  assert.equal(inv.multi_link_inodes[0], statSync(join(dir, "hnsw.bin")).ino);
  for (const e of inv.entries) {
    assert.equal(typeof e.ino, "number");
    assert.equal(typeof e.nlink, "number");
    assert.equal(typeof e.mtime_ms, "number");
  }

  // Absence is not a clean inventory.
  const missing = inventoryTree(join(TMP_ROOT, "t13-does-not-exist"));
  assert.equal(missing.error.code, "legacy_tree_absent");
  assert.equal(missing.unique_bytes, null);

  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// T14 — end to end. Exit codes are the operator's actual interface, and the
// REFUSAL ORDER matters: a tree that is still being written, or one that a
// default writer would re-create, must be refused BEFORE the verifier spends
// ten seconds hashing the ACTIVE index. Every arm here is hermetic and none
// of them may reach the coverage gate.
// ---------------------------------------------------------------------------
await test("T14 verify-legacy-tree-deletable refuses by exit code, before any coverage spawn", () => {
  clearFlags();
  const dir = join(TMP_ROOT, "t14-tree");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // A shape-valid manifest: readActiveManifest fails closed on anything else,
  // so a malformed fixture would pass T14 for the wrong reason.
  const manifest = {
    format: 1,
    generation: 4,
    created_at: "2026-08-17T13:21:19.475Z",
    embedding_model_version: LEGACY_MODEL,
    wal_cursor: { applied_seq: 0, applied_offset: 0 },
    members: {
      bm25: { file: "bm25.json", size: 3, sha256: "0".repeat(64) },
      hnsw: null,
      hnsw_meta: null,
    },
    previous: null,
  };
  const manifestPath = join(dir, "index-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(dir, "bm25.json"), "abc");

  const args = [`--tree=${dir}`, `--scan-root=${dir}`];
  const cleanEnv = {
    MEMORY_BM25_REBUILD_TARGET_LEGACY: undefined,
    MEMORY_BM25_REBUILD_TARGET_ACTIVE: undefined,
    MEMORY_BM25_MODEL_NEUTRAL: undefined,
  };

  // (a) FRESHNESS. The manifest was written milliseconds ago.
  const fresh = runDeletableVerifier(args, cleanEnv);
  assert.equal(fresh.status, 3, "a tree written seconds ago is a measured refusal");
  assert.equal(fresh.envelope.verdict, "refuse");
  assert.equal(fresh.envelope.error_code, "legacy_tree_recently_written");
  assert.equal(fresh.envelope.freshness.fresh, true);
  assert.equal(
    fresh.envelope.coverage_gate,
    undefined,
    "the coverage gate must not have been spawned",
  );
  assert.equal(fresh.envelope.manifest_generation, 4);

  // (b) SETTLED but RESURRECTABLE. Backdate the manifest well past the window,
  // then arm the legacy opt-in in the CHILD's environment only: the refusal
  // must now come from the resurrection predicate, and must come FIRST — the
  // envelope carries no inventory because the check ran before any stat.
  const old = Date.now() / 1000 - 86_400;
  utimesSync(manifestPath, old, old);
  const resurrectable = runDeletableVerifier(args, {
    ...cleanEnv,
    MEMORY_BM25_REBUILD_TARGET_LEGACY: "1",
  });
  assert.equal(resurrectable.status, 3);
  assert.equal(resurrectable.envelope.error_code, "legacy_tree_would_be_recreated");
  assert.equal(resurrectable.envelope.resurrection.ok, false);
  assert.equal(
    resurrectable.envelope.inventory,
    undefined,
    "the resurrection predicate must short-circuit before the inventory",
  );

  // (c) HARDLINKED OUTSIDE the tree. Same settled manifest, no legacy opt-in.
  const outsideDir = join(TMP_ROOT, "t14-outside");
  rmSync(outsideDir, { recursive: true, force: true });
  mkdirSync(outsideDir, { recursive: true, mode: 0o700 });
  linkSync(join(dir, "bm25.json"), join(outsideDir, "bm25.someone-elses-name.json"));
  const linked = runDeletableVerifier(
    [`--tree=${dir}`, `--scan-root=${TMP_ROOT}`],
    cleanEnv,
  );
  assert.equal(linked.status, 3);
  assert.equal(linked.envelope.error_code, "member_hardlinked_outside_tree");
  assert.equal(linked.envelope.hardlinks.outside.length, 1);
  assert.match(linked.envelope.hardlinks.outside[0], /bm25\.someone-elses-name\.json$/);
  assert.equal(
    linked.envelope.coverage_gate,
    undefined,
    "the coverage gate must not have been spawned",
  );
  rmSync(outsideDir, { recursive: true, force: true });

  // (d) ABSENCE IS NOT A PERMIT. A tree that is not there is exit 2, never 0:
  // "nothing to delete" and "safe to delete" are different findings.
  const absent = runDeletableVerifier(
    [`--tree=${join(TMP_ROOT, "t14-nope")}`, `--scan-root=${TMP_ROOT}`],
    cleanEnv,
  );
  assert.equal(absent.status, 2);
  assert.equal(absent.envelope.verdict, "refuse");
  assert.equal(absent.envelope.measured, false);
  assert.equal(absent.envelope.error_code, "legacy_tree_absent");

  // (e) --help is exit 2 for the same reason: exit 0 must mean "measured".
  const help = runDeletableVerifier(["--help"], cleanEnv);
  assert.equal(help.status, 2);
  assert.equal(help.envelope.error_code, "gate_help");

  // (f) A bad invocation is never a measurement.
  const bad = runDeletableVerifier(["--freshness-window-ms=abc"], cleanEnv);
  assert.equal(bad.status, 2);
  assert.equal(bad.envelope.error_code, "gate_bad_arguments");

  rmSync(dir, { recursive: true, force: true });
  clearFlags();
});

// ---------------------------------------------------------------------------
// T15 (r7) — the `indices/` PATH-CONSTRUCTOR set is CLOSED.
//
// INDICES_CONSTRUCTOR_CENSUS (the map below) is a per-site census of what
// reads indices/gemini-embedding-001/, and a census is only a census while its
// domain is closed. Its closure argument: every path this repo opens under
// indices/ is built from a literal "indices" path SEGMENT in one of the five
// code trees below. The two caller-supplied-`dir` surfaces the document also
// classifies — index-manifest.js's retainActiveGeneration/gcGenerations and
// health.js's `o.indicesDir` — construct no segment of their own; they are
// reached only from a site inside this map (measured 2026-08-18T05:04Z:
// gcGenerations has exactly two in-repo callers, index-cache.js's
// _publishGenerationLocked and bm25-projection.js's projectBm25ToLexical).
//
// Freezing the map is what makes a NEWLY ADDED constructor fail HERE, loudly,
// instead of silently invalidating the document's per-site classifications.
// Keyed by FILE with a per-file count — never by line number: this tree is
// written continuously and line coordinates drift under the document.
//
// Comment lines are stripped with the SAME nonCommentLines() T5 uses, so a
// prose mention of `indices/` in a header block never enters the map.
//
// Re-derive (must reproduce this map exactly):
//   node --test mcp/test/rebuild-target-retarget.test.mjs
// ---------------------------------------------------------------------------
const CENSUS_REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const CENSUS_SCAN_DIRS = [
  "mcp/lib",
  "mcp/daemon",
  "daemons",
  "scripts",
  "mcp/scripts",
];

// Matches an "indices" path segment in every quote form the tree uses:
//   join(MEMORY_ROOT, "indices", modelVersion)   'indices'   `indices/...`
const INDICES_SEGMENT_RE = /['"`]indices['"`/]/;

// file -> count of NON-COMMENT lines constructing an `indices/` path.
// Measured 2026-08-18T05:10:48Z: 230 code files scanned, 15 files, 29 sites.
// TRUE-AS-OF NOTE (2026-08-18, node e1-population-census): the map below now
// carries 17 files / 31 sites — the frozen figure above is the ORIGINAL
// measurement and is deliberately left as written; the two additions since
// (daemons/reembed-drain.mjs by r6, mcp/scripts/verify-embed-population-census.mjs
// by e1) each carry their own comment and their own § 3 row. Two later
// additions (mcp/lib/tools/distill-promote-fact.js and
// mcp/scripts/no-nul-bytes-scan.mjs) carry their classification inline below.
// Every entry carries a classification in FINDINGS.md § 3.
const INDICES_CONSTRUCTOR_CENSUS = {
  // r6-drain-work-proof added a real sidecar-path constructor here
  //   reembed-drain.mjs: join(REPO, "indices", modelVersion, "vectors.jsonl")
  // AFTER this census was frozen. Verified as CODE, not prose: the adjacent
  // mention in that file's header comment is stripped by the scanner, which
  // is why the count is 1 and not 2. Added rather than excluded because the
  // constructor is genuine and the census is meant to track reality.
  "daemons/reembed-drain.mjs": 1,
  "mcp/daemon/queryd.js": 1,
  "mcp/lib/recall/bm25-projection.js": 4,
  "mcp/lib/recall/bm25-rebuild.js": 7,
  "mcp/lib/recall/index-cache.js": 1,
  // The first-run put predicate (standaloneLexicalFirstRun) resolves
  //   join(MEMORY_ROOT, "indices", CAPS.ACTIVE_EMBED_MODEL_VERSION)
  // to screen the on-disk tree before any index is deserialized. Classified
  // before this line was added, per this gate's own instruction: READ-ONLY
  // (statSync / readdirSync / the manifest parse / one small sidecar read; no
  // write, rename or unlink), ACTIVE model only — the model version is the
  // CAPS constant, never a caller-supplied or legacy value, so this site
  // cannot reach indices/gemini-embedding-001/. Verified as CODE, not prose:
  // the `indices/` mentions in the predicate's comment block are stripped by
  // nonCommentLines(), which is why the count is 1.
  "mcp/lib/tools/distill-promote-fact.js": 1,
  "mcp/lib/tools/health.js": 1,
  "mcp/scripts/build-contextual-eval-goldset.mjs": 1,
  "mcp/scripts/heal-index-manifest.mjs": 1,
  // The tracked-file NUL scanner lists "indices" in RUNTIME_DATA_DIRS, the set
  // of top-level runtime-data directory NAMES it skips. The segment pattern
  // matches the quoted name, so it is recorded here to keep the census equal
  // to what the scan finds. Classified: NOT a path constructor and not a
  // reader — the entry EXCLUDES indices/ (every model tree, legacy included)
  // from that scan; nothing under indices/ is opened through this site.
  "mcp/scripts/no-nul-bytes-scan.mjs": 1,
  "mcp/scripts/r25-startup-smoke.mjs": 1,
  "mcp/scripts/rebuild-bm25-index.mjs": 2,
  "mcp/scripts/reembed-local-4096.mjs": 1,
  "mcp/scripts/run-contextual-eval.mjs": 5,
  // e1-population-census added a read-only census CLI that resolves
  //   join(MEMORY_ROOT, "indices", model)
  // for the vectors/hnsw-meta/legacy-sidecar defaults. Classified as B20 in
  // FINDINGS.md § 3 BEFORE this line was touched, per this gate's own
  // instruction. Verified as CODE, not prose: the several `indices/` mentions
  // in that file's header block are stripped by nonCommentLines(), which is
  // why the count is 1.
  "mcp/scripts/verify-embed-population-census.mjs": 1,
  "mcp/scripts/verify-legacy-tree-deletable.mjs": 1,
  "mcp/scripts/verify-lexical-coverage-gate.mjs": 1,
  "scripts/backfill-embeddings.mjs": 1,
  "scripts/snapshot-test-protected.mjs": 1,
};

function scanIndicesPathConstructors(repoRoot) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an absent scan dir is not a constructor
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  for (const d of CENSUS_SCAN_DIRS) walk(join(repoRoot, d));
  files.sort();
  const found = {};
  for (const file of files) {
    const hits = nonCommentLines(readFileSync(file, "utf8")).filter((line) =>
      INDICES_SEGMENT_RE.test(line),
    );
    if (hits.length > 0) found[relative(repoRoot, file)] = hits.length;
  }
  return found;
}

await test("T15 the indices/ path-constructor set is closed to the r7 census", () => {
  const found = scanIndicesPathConstructors(CENSUS_REPO_ROOT);
  assert.deepEqual(
    found,
    INDICES_CONSTRUCTOR_CENSUS,
    "the set of sites that build a path under indices/ has drifted from the " +
      "per-site census in INDICES_CONSTRUCTOR_CENSUS (this file). " +
      "A site added here is a site NOBODY classified: re-read it, decide " +
      "whether it can reach indices/gemini-embedding-001/, classify it, " +
      "and only then update this map. Do NOT update the map without " +
      "classifying the site — that converts a census back into a sample.",
  );
});
