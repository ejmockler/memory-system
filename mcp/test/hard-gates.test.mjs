// hard-gates.test.mjs — Phase 3 v0 Layer 2 hard gates.
//
// Authoritative spec: kb/research-retrieval-frontiers.md
// Authoritative shape contract: kb/phase3-v0-contracts.md § 1, § 3, § 6.
//
// Hermeticity discipline (standing C-NEW-2 pattern):
//   Set MEMORY_ROOT, POLICY_BASE_DIR, STORAGE_BASE_DIR, LEDGERS_BASE_DIR to
//   mkdtempSync paths BEFORE any dynamic import of memory-system modules.
//   Verified via npm test snapshot-comparison: the live install's
//   {ledgers,policy,indices}/* mtime+size MUST be
//   IDENTICAL pre/post `npm test`. Static ESM imports are hoisted, so this
//   file uses dynamic await import() exclusively for memory-system code.
//
// Five tests per the task spec:
//   1. no active predicates -> all candidates pass with predicate_mask = 1.
//   2. one active predicate cosines > 0.85 to candidate A -> A masked out
//      with correct dropped_reason; candidate B unmasked.
//   3. third_party_inferred candidate -> consent_dampener = 0.6.
//   4. candidate with derived_from in excise set -> derivation_status = ORPHAN
//      (0.5); other candidate -> NORMAL (1.0).
//   5. missing predicates.jsonl -> loadActivePredicates returns [].

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hermeticity: stake tmp dirs and overwrite env BEFORE dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-hard-gates-test-"));
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
  predicateMaskForCandidate,
  loadActivePredicates,
  loadDerivationExciseSet,
  loadTransitiveOrphanMap,
  _resetTransitiveOrphanCaches,
  _awaitPendingScanCachePersists,
  __peekScanColdStatsForTests,
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

// ---------------------------------------------------------------------------
// Helpers: unit-norm vector synthesis.
// ---------------------------------------------------------------------------
// We don't need real gemini embeddings — only well-formed unit-norm 3072d
// number arrays where we can control cosine similarity. Two convenient
// constructions:
//   - basisVec(i): standard basis e_i. cosine(basisVec(i), basisVec(j)) =
//                   1 if i === j, else 0.
//   - blendedVec(a, b, alpha): alpha * basisVec(a) + (1-alpha) * basisVec(b),
//                              then renormalize. cosine vs basisVec(a) is
//                              alpha / sqrt(alpha^2 + (1-alpha)^2).
const DIM = CAPS.GEMINI_EMBEDDING_DIMS_FULL;

function basisVec(idx) {
  const v = new Array(DIM).fill(0);
  v[idx] = 1;
  return v;
}

function blendedVec(a, b, alpha) {
  const v = new Array(DIM).fill(0);
  v[a] = alpha;
  v[b] = 1 - alpha;
  // Renormalize.
  let n2 = 0;
  for (let i = 0; i < DIM; i++) n2 += v[i] * v[i];
  const n = Math.sqrt(n2);
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}

const MODEL_VERSION = CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT;

// ---------------------------------------------------------------------------
// Test 1: no active predicates -> all candidates pass with predicate_mask=1.
// ---------------------------------------------------------------------------
{
  const candA = {
    memory_id: "mem_a",
    embedding_3072: basisVec(0),
    consent_basis: "first_party",
    derived_from: [],
    embedding_model_version: MODEL_VERSION,
  };
  const candB = {
    memory_id: "mem_b",
    embedding_3072: basisVec(1),
    consent_basis: "first_party",
    derived_from: [],
    embedding_model_version: MODEL_VERSION,
  };
  const out = applyHardGates([candA, candB], {
    activePredicates: [],
    embedding_model_version: MODEL_VERSION,
    derivation_excise_set: new Set(),
  });
  check("T1 length matches", out.length === 2);
  check("T1 candA predicate_mask=1", out[0].predicate_mask === 1);
  check("T1 candA dropped_reason=null", out[0].dropped_reason === null);
  check("T1 candB predicate_mask=1", out[1].predicate_mask === 1);
  check("T1 candB dropped_reason=null", out[1].dropped_reason === null);
  check(
    "T1 candA consent_dampener=1.0",
    out[0].consent_dampener === CAPS.CONSENT_DAMPENER_FIRST_PARTY,
  );
  check(
    "T1 candA derivation_status=NORMAL",
    out[0].derivation_status === CAPS.DERIVATION_STATUS_NORMAL,
  );
}

// ---------------------------------------------------------------------------
// Test 2: one active predicate whose embedding cosines > 0.85 to a candidate
// -> predicate_mask=0 + correct dropped_reason. Other candidate unmasked.
// ---------------------------------------------------------------------------
{
  // candA embedding equals predicate embedding exactly => cosine = 1.0 > 0.85.
  // candB embedding is orthogonal => cosine = 0.
  const predEmbedding = basisVec(0);
  const candA = {
    memory_id: "mem_a",
    embedding_3072: basisVec(0),
    consent_basis: "first_party",
    derived_from: [],
    embedding_model_version: MODEL_VERSION,
  };
  const candB = {
    memory_id: "mem_b",
    embedding_3072: basisVec(1),
    consent_basis: "first_party",
    derived_from: [],
    embedding_model_version: MODEL_VERSION,
  };
  const predicate = {
    predicate_id: "pred_tofu",
    query_embedding_3072: predEmbedding,
    scope: "global",
    active: true,
    embedding_model_version: MODEL_VERSION,
  };
  const out = applyHardGates([candA, candB], {
    activePredicates: [predicate],
    embedding_model_version: MODEL_VERSION,
    derivation_excise_set: new Set(),
  });
  check("T2 candA predicate_mask=0", out[0].predicate_mask === 0);
  check(
    "T2 candA dropped_reason=predicate_excluded:pred_tofu",
    out[0].dropped_reason === "predicate_excluded:pred_tofu",
    `got "${out[0].dropped_reason}"`,
  );
  check("T2 candB predicate_mask=1", out[1].predicate_mask === 1);
  check("T2 candB dropped_reason=null", out[1].dropped_reason === null);

  // Also verify the entry is RETURNED, not dropped — caller logs it.
  check("T2 candA entry retained", out[0].entry === candA);

  // Boundary: a candidate whose cosine is just BELOW 0.85 should NOT be
  // masked. Build a blended vec at alpha=0.85 / sqrt(0.85^2 + 0.15^2) ~= 0.985.
  // To land below threshold we want cosine ~= 0.80; pick alpha so that
  // alpha / sqrt(alpha^2 + (1-alpha)^2) = 0.80 => solve algebraically:
  // alpha^2 / (alpha^2 + (1-alpha)^2) = 0.64
  // 0.36 alpha^2 = 0.64 (1-alpha)^2 => 0.6 alpha = 0.8 (1-alpha)
  // 0.6 alpha + 0.8 alpha = 0.8 => alpha = 0.5714...
  const candC = {
    memory_id: "mem_c",
    embedding_3072: blendedVec(0, 1, 0.5714285714285714),
    consent_basis: "first_party",
    derived_from: [],
    embedding_model_version: MODEL_VERSION,
  };
  const out2 = applyHardGates([candC], {
    activePredicates: [predicate],
    embedding_model_version: MODEL_VERSION,
    derivation_excise_set: new Set(),
  });
  check(
    "T2 candC below-threshold predicate_mask=1",
    out2[0].predicate_mask === 1,
    `cos ~= 0.80 should NOT mask`,
  );
}

// ---------------------------------------------------------------------------
// Test 3: third_party_inferred candidate gets consent_dampener=0.6.
// ---------------------------------------------------------------------------
{
  const candA = {
    memory_id: "mem_a",
    embedding_3072: basisVec(0),
    consent_basis: "third_party_inferred",
    derived_from: [],
    embedding_model_version: MODEL_VERSION,
  };
  const candB = {
    memory_id: "mem_b",
    embedding_3072: basisVec(1),
    consent_basis: "first_party",
    derived_from: [],
    embedding_model_version: MODEL_VERSION,
  };
  const candC = {
    memory_id: "mem_c",
    embedding_3072: basisVec(2),
    // No consent_basis set -> unknown -> 1.0 (per spec).
    derived_from: [],
    embedding_model_version: MODEL_VERSION,
  };
  const out = applyHardGates([candA, candB, candC], {
    activePredicates: [],
    embedding_model_version: MODEL_VERSION,
    derivation_excise_set: new Set(),
  });
  check(
    "T3 candA consent_dampener=0.6",
    out[0].consent_dampener === CAPS.CONSENT_DAMPENER_THIRD_PARTY_INFERRED,
    `got ${out[0].consent_dampener}`,
  );
  check(
    "T3 candB consent_dampener=1.0",
    out[1].consent_dampener === CAPS.CONSENT_DAMPENER_FIRST_PARTY,
  );
  check(
    "T3 candC (unknown) consent_dampener=1.0",
    out[2].consent_dampener === CAPS.CONSENT_DAMPENER_FIRST_PARTY,
  );
  check("T3 candA predicate_mask=1 (dampener does NOT drop)",
    out[0].predicate_mask === 1);

  // Bonus: consent_blocked candidate gets DROPPED.
  const candD = {
    memory_id: "mem_d",
    embedding_3072: basisVec(3),
    consent_basis: "consent_blocked",
    derived_from: [],
    embedding_model_version: MODEL_VERSION,
  };
  const out2 = applyHardGates([candD], {
    activePredicates: [],
    embedding_model_version: MODEL_VERSION,
    derivation_excise_set: new Set(),
  });
  check("T3 candD (consent_blocked) predicate_mask=0",
    out2[0].predicate_mask === 0);
  check(
    "T3 candD dropped_reason=consent_blocked",
    out2[0].dropped_reason === "consent_blocked",
  );
}

// ---------------------------------------------------------------------------
// Test 4: candidate with derived_from in excise_set gets derivation_status
// = ORPHAN; one without does not.
// ---------------------------------------------------------------------------
{
  const candA = {
    memory_id: "mem_a",
    embedding_3072: basisVec(0),
    consent_basis: "first_party",
    derived_from: ["mem_parent_excised"],
    embedding_model_version: MODEL_VERSION,
  };
  const candB = {
    memory_id: "mem_b",
    embedding_3072: basisVec(1),
    consent_basis: "first_party",
    derived_from: ["mem_parent_healthy"],
    embedding_model_version: MODEL_VERSION,
  };
  const candC = {
    memory_id: "mem_c",
    embedding_3072: basisVec(2),
    consent_basis: "first_party",
    derived_from: [], // no parents at all
    embedding_model_version: MODEL_VERSION,
  };
  const exciseSet = new Set(["mem_parent_excised"]);
  const out = applyHardGates([candA, candB, candC], {
    activePredicates: [],
    embedding_model_version: MODEL_VERSION,
    derivation_excise_set: exciseSet,
  });
  check(
    "T4 candA derivation_status=ORPHAN",
    out[0].derivation_status === CAPS.DERIVATION_STATUS_ORPHAN,
    `got ${out[0].derivation_status}`,
  );
  check(
    "T4 candB derivation_status=NORMAL",
    out[1].derivation_status === CAPS.DERIVATION_STATUS_NORMAL,
  );
  check(
    "T4 candC (no parents) derivation_status=NORMAL",
    out[2].derivation_status === CAPS.DERIVATION_STATUS_NORMAL,
  );
  // Orphan does NOT drop — it dampens via the multi-feature score, not the gate.
  check("T4 candA predicate_mask=1 (orphan does NOT drop)",
    out[0].predicate_mask === 1);

  // Bonus: empty excise_set means everything is NORMAL regardless of derived_from.
  const out2 = applyHardGates([candA], {
    activePredicates: [],
    embedding_model_version: MODEL_VERSION,
    derivation_excise_set: new Set(),
  });
  check(
    "T4 candA with empty excise_set => NORMAL",
    out2[0].derivation_status === CAPS.DERIVATION_STATUS_NORMAL,
  );
}

// ---------------------------------------------------------------------------
// Test 5: loadActivePredicates handles missing predicates.jsonl gracefully.
// ---------------------------------------------------------------------------
{
  // No predicates.jsonl exists in the hermetic POLICY_DIR yet.
  const path = join(POLICY_DIR, "predicates.jsonl");
  check("T5 predicates.jsonl absent at start", !existsSync(path));
  const preds = await loadActivePredicates({});
  check(
    "T5 loadActivePredicates returns [] on missing file",
    Array.isArray(preds) && preds.length === 0,
  );

  // Now write a predicates.jsonl with: one active row, one inactive row, one
  // malformed line. Verify only the active row is returned.
  const lines = [
    JSON.stringify({
      predicate_id: "pred_active",
      query_embedding_3072: basisVec(0),
      scope: "global",
      active: true,
      embedding_model_version: MODEL_VERSION,
    }),
    JSON.stringify({
      predicate_id: "pred_rescinded",
      query_embedding_3072: basisVec(1),
      scope: "global",
      active: false,
      embedding_model_version: MODEL_VERSION,
    }),
    "not-json",
    "",
  ];
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  const preds2 = await loadActivePredicates({});
  check(
    "T5 loadActivePredicates filters to active=true rows",
    preds2.length === 1,
    `got ${preds2.length}`,
  );
  check(
    "T5 loaded predicate_id is pred_active",
    preds2[0]?.predicate_id === "pred_active",
  );
  check(
    "T5 loaded query_embedding_3072 has correct dims",
    Array.isArray(preds2[0]?.query_embedding_3072) &&
      preds2[0].query_embedding_3072.length === DIM,
  );

  // Also verify loadDerivationExciseSet handles missing memory.jsonl
  // gracefully (LEDGERS_DIR is empty in this hermetic test).
  const exciseSet = await loadDerivationExciseSet({});
  check(
    "T5 loadDerivationExciseSet returns empty Set on missing file",
    exciseSet instanceof Set && exciseSet.size === 0,
  );

  // Write a memory.jsonl with one policy/excise row and one unrelated fact.
  const ledgerPath = join(LEDGERS_DIR, "memory.jsonl");
  const ledgerLines = [
    JSON.stringify({
      id: "mem_fact_keep",
      kind: "fact",
      content: "harmless",
    }),
    JSON.stringify({
      id: "mem_excise_1",
      kind: "policy",
      policy_kind: "excise",
      targets: ["mem_target_a", "mem_target_b"],
    }),
    JSON.stringify({
      id: "mem_excise_rescinded",
      kind: "policy",
      policy_kind: "excise",
      targets: ["mem_target_c"],
      active: false,
    }),
  ];
  writeFileSync(ledgerPath, ledgerLines.join("\n") + "\n", "utf8");
  const exciseSet2 = await loadDerivationExciseSet({});
  check(
    "T5 loadDerivationExciseSet collects active excise targets",
    exciseSet2.has("mem_target_a") && exciseSet2.has("mem_target_b"),
  );
  check(
    "T5 loadDerivationExciseSet skips rescinded excise rows",
    !exciseSet2.has("mem_target_c"),
  );
  check(
    "T5 loadDerivationExciseSet size == 2",
    exciseSet2.size === 2,
    `got ${exciseSet2.size}`,
  );
}

// ---------------------------------------------------------------------------
// Test 6 (Q4 — memperf): persisted checkpoint-validated raw-scan cache.
// A FRESH PROCESS (simulated via _resetTransitiveOrphanCaches, which clears
// every in-memory cache but leaves the disk cache) must cold-seed from the
// persisted scan cache + fold ONLY the appended delta — with semantics
// IDENTICAL to a full scan, including the reversal-bearing paths:
//   - rescind-in-delta: a rescind row appended AFTER the cache was persisted
//     must retire an excise that IS inside the cached prefix;
//   - corroboration-rescue-in-delta: a corroboration row appended after the
//     persist must rescue an orphan that IS inside the cached prefix;
//   - duplicate ids: a duplicated excise row (same policy_event_id) folds the
//     same way in the delta as in a full scan.
//
// RED-RUN RECORD (2026-07-15, this workspace): with _foldScanRows sabotaged to
// fold nothing (rows:0, error:null), the rescind-in-delta and rescue-in-delta
// checks below FAILED (root_b stayed orphaned; grandchild_a stayed
// un-rescued) — the delta-fold path is load-bearing, not vacuous.
// ---------------------------------------------------------------------------
{
  const ledgerPath = join(LEDGERS_DIR, "memory.jsonl");
  const cachePath = join(STORAGE_DIR, "hard-gates-scan.cache.json");
  const ts = "2026-06-01T00:00:00Z";
  const rows = (rs) => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";

  // Base ledger: two excised roots with derivation chains.
  const base = [
    { id: "root_a", kind: "fact", ts },
    { id: "root_b", kind: "fact", ts },
    { id: "clean_c", kind: "fact", ts },
    { id: "child_a", kind: "reconstructed", ts, derived_from: ["root_a"] },
    { id: "grandchild_a", kind: "reconstructed", ts, derived_from: ["child_a"] },
    { id: "child_b", kind: "reconstructed", ts, derived_from: ["root_b"] },
    { id: "ex_a", kind: "policy", policy_kind: "excise", ts, targets: ["root_a"] },
    { id: "ex_b", kind: "policy", policy_kind: "excise", ts, targets: ["root_b"] },
  ];
  // Drain the earlier sections' undrained fire-and-forget scan-cache persists
  // first, so a stale one cannot rename onto the cache path after T6's own.
  await _awaitPendingScanCachePersists();
  writeFileSync(ledgerPath, rows(base), "utf8");
  try {
    rmSync(cachePath, { force: true });
  } catch {}
  _resetTransitiveOrphanCaches();

  // Cold prime: full rebuild, then the persist lands OFF the critical path.
  const primed = await loadTransitiveOrphanMap({});
  check("T6 cold prime is a full rebuild", __peekScanColdStatsForTests()?.mode === "full-rebuild",
    `got ${JSON.stringify(__peekScanColdStatsForTests())}`);
  check("T6 primed map orphans child_b", primed.get("child_b")?.transitive_orphan === true);
  check("T6 primed map orphans grandchild_a", primed.get("grandchild_a")?.transitive_orphan === true);
  check(
    "T6 persist is scheduled, not inline (cache absent right after load)",
    !existsSync(cachePath),
  );
  await _awaitPendingScanCachePersists();
  check("T6 scheduled persist landed", existsSync(cachePath));

  // Exact-eof cold hit: zero delta, ZERO disk writes.
  const bytesBefore = readFileSync(cachePath);
  const statBefore = statSync(cachePath);
  await new Promise((resolve) => setTimeout(resolve, 5));
  _resetTransitiveOrphanCaches();
  const exact = await loadTransitiveOrphanMap({});
  check("T6 exact-eof cold hit mode", __peekScanColdStatsForTests()?.mode === "cache-hit-exact",
    `got ${JSON.stringify(__peekScanColdStatsForTests())}`);
  check("T6 exact-eof hit map intact", exact.get("child_a")?.transitive_orphan === true);
  await _awaitPendingScanCachePersists();
  check("T6 exact-eof hit wrote nothing (bytes)", bytesBefore.equals(readFileSync(cachePath)));
  check(
    "T6 exact-eof hit wrote nothing (mtime)",
    statBefore.mtimeMs === statSync(cachePath).mtimeMs,
  );

  // Delta: rescind ex_b (retires an excise INSIDE the cached prefix), rescue
  // grandchild_a via corroboration to clean_c, and a DUPLICATE excise row.
  const delta = [
    { id: "resc_1", kind: "policy", policy_kind: "rescind", ts, targets: ["ex_b"] },
    {
      id: "corr_1",
      kind: "policy",
      policy_kind: "corroboration",
      ts,
      targets: ["grandchild_a"],
      payload: { source_ref: { target_memory_id: "clean_c" } },
    },
    { id: "ex_a", kind: "policy", policy_kind: "excise", ts, targets: ["root_a"] }, // duplicate id
  ];
  appendFileSync(ledgerPath, rows(delta), "utf8");

  // Fresh-process cold seed: cache + delta fold.
  _resetTransitiveOrphanCaches();
  const merged = await loadTransitiveOrphanMap({});
  const stats = __peekScanColdStatsForTests();
  check("T6 delta cold seed is incremental", stats?.mode === "incremental",
    `got ${JSON.stringify(stats)}`);
  check("T6 delta folds exactly the 3 appended rows", stats?.rows_folded === 3,
    `got ${stats?.rows_folded}`);
  check(
    "T6 rescind-in-delta retires prefix excise (root_b not orphaned)",
    !merged.has("root_b") && !merged.has("child_b"),
  );
  check(
    "T6 corroboration-rescue-in-delta rescues prefix orphan",
    merged.get("grandchild_a")?.transitive_orphan === false &&
      merged.get("grandchild_a")?.rescued_by_corroboration === true,
  );
  check("T6 unaffected orphan chain intact", merged.get("child_a")?.transitive_orphan === true);
  const excisedMerged = await loadDerivationExciseSet({});

  // Ground truth: FULL scan with the disk cache removed.
  rmSync(cachePath, { force: true });
  _resetTransitiveOrphanCaches();
  const full = await loadTransitiveOrphanMap({});
  check("T6 ground truth is a full rebuild", __peekScanColdStatsForTests()?.mode === "full-rebuild");
  const canon = (m) => {
    const out = {};
    for (const [k, v] of m) {
      out[k] = [v.distance_to_nearest_excised, v.transitive_orphan, v.rescued_by_corroboration];
    }
    return out;
  };
  check(
    "T6 cache+delta orphan map deep-equals full scan",
    JSON.stringify(canon(merged)) === JSON.stringify(canon(full)),
    `merged=${JSON.stringify(canon(merged))} full=${JSON.stringify(canon(full))}`,
  );
  const excisedFull = await loadDerivationExciseSet({});
  check(
    "T6 cache+delta excise set deep-equals full scan",
    JSON.stringify(Array.from(excisedMerged).sort()) ===
      JSON.stringify(Array.from(excisedFull).sort()),
  );
  await _awaitPendingScanCachePersists();
}

// ---------------------------------------------------------------------------
// Test 7 (Q4 FIX CYCLE 2 — reviewer's torn-tail seam): a RESCIND row torn at
// cold-seed time must be applied by the WARM grow of the SAME process once its
// "\n" lands — the orphan it retires MUST be rescinded. The defect: the
// checkpoint cold seed folded to cp.eof but the projection layer recorded
// safeOffset = raw st.size, so the torn bytes were never re-read and the
// completed rescind was lost for the life of the process (orphan kept).
// RED-RUN RECORD (2026-07-16, this workspace): before the fullRebuild
// {struct, resumeOffset} out-channel landed, the warm-grow check below FAILED
// (child_t stayed orphaned after the rescind completed).
// ---------------------------------------------------------------------------
{
  const ledgerPath = join(LEDGERS_DIR, "memory.jsonl");
  const cachePath = join(STORAGE_DIR, "hard-gates-scan.cache.json");
  const ts = "2026-06-01T00:00:00Z";
  const rows = (rs) => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const base = [
    { id: "root_t", kind: "fact", ts },
    { id: "child_t", kind: "reconstructed", ts, derived_from: ["root_t"] },
    { id: "ex_t", kind: "policy", policy_kind: "excise", ts, targets: ["root_t"] },
  ];
  writeFileSync(ledgerPath, rows(base), "utf8");
  try {
    rmSync(cachePath, { force: true });
  } catch {}
  _resetTransitiveOrphanCaches();

  // Cold prime + persisted checkpoint cache.
  const primed = await loadTransitiveOrphanMap({});
  check("T7 primed: child_t orphaned", primed.get("child_t")?.transitive_orphan === true);
  await _awaitPendingScanCachePersists();

  // A TORN rescind (no "\n") lands, then a fresh process cold-seeds from the
  // disk cache. The torn row must NOT be applied (it is not durable yet).
  const tornRescind = JSON.stringify({
    id: "resc_t",
    kind: "policy",
    policy_kind: "rescind",
    ts,
    targets: ["ex_t"],
  });
  appendFileSync(ledgerPath, tornRescind, "utf8"); // torn — no trailing "\n"
  _resetTransitiveOrphanCaches();
  const seeded = await loadTransitiveOrphanMap({});
  check(
    "T7 torn rescind NOT applied at cold-seed time (child_t still orphaned)",
    seeded.get("child_t")?.transitive_orphan === true,
  );
  const seedMode = __peekScanColdStatsForTests()?.mode;
  check(
    "T7 cold seed used the disk cache (exact/incremental, not full rebuild)",
    seedMode === "cache-hit-exact" || seedMode === "incremental",
    `got ${seedMode}`,
  );

  // The daemon completes the row. SAME process, NO reset: the warm grow must
  // resume at the checkpoint eof (not raw pre-completion size) and apply the
  // completed rescind — the orphan must be rescinded.
  appendFileSync(ledgerPath, "\n", "utf8");
  const warm = await loadTransitiveOrphanMap({});
  check(
    "T7 completed torn rescind applied by the warm grow (orphan rescinded)",
    !warm.has("child_t") && !warm.has("root_t"),
    `child_t=${JSON.stringify(warm.get("child_t"))}`,
  );

  // Equivalence: warm-grown result == fresh full scan over the whole file.
  rmSync(cachePath, { force: true });
  _resetTransitiveOrphanCaches();
  const full = await loadTransitiveOrphanMap({});
  const canonT7 = (m) => {
    const out = {};
    for (const [k, v] of m) {
      out[k] = [v.distance_to_nearest_excised, v.transitive_orphan, v.rescued_by_corroboration];
    }
    return out;
  };
  check(
    "T7 warm-grown orphan map deep-equals full scan",
    JSON.stringify(canonT7(warm)) === JSON.stringify(canonT7(full)),
    `warm=${JSON.stringify(canonT7(warm))} full=${JSON.stringify(canonT7(full))}`,
  );
  await _awaitPendingScanCachePersists();
}

// ---------------------------------------------------------------------------
// Test 8 (Finding 1 — proto-key trap): a scan struct whose string-keyed maps
// carry the hostile key "__proto__" (as a connector-revoked SOURCE and as a
// derived_from ANCESTOR) must survive the persisted-cache serialize->deserialize
// round-trip. Pre-fix, _serializeScanStruct wrote dynamic keys onto a plain {}
// so "__proto__" invoked the inherited setter, JSON dropped it, and the
// Object.keys() deserialize lost it entirely — the REVOKED source then resolved
// NO memory ids on the next cold load (regaining recall eligibility) and the
// "__proto__"-ancestor's descendant stopped being orphaned.
//
// RED-RUN RECORD (2026-07-19, this workspace): with the pre-fix plain-{}
// serializer, "T8 round-trip: revoked '__proto__' source still excises
// mem_secret" and "T8 round-trip: '__proto__'-ancestor descendant still
// orphaned" FAILED after the cold reload (mem_secret absent from the excise set,
// kid_of_proto no longer orphaned) while the full-rebuild prime saw them — the
// loss was purely the cache round-trip. "constructor"/"prototype" survive both
// pre- and post-fix (own-enumerable shadowing) and lock the lossless contract.
// ---------------------------------------------------------------------------
{
  const ledgerPath = join(LEDGERS_DIR, "memory.jsonl");
  const cachePath = join(STORAGE_DIR, "hard-gates-scan.cache.json");
  const ts = "2026-06-01T00:00:00Z";
  const rows = (rs) => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";

  const base = [
    // memoryIdsBySource hostile SOURCE key "__proto__": a fact sourced from
    // "__proto__" with a descendant; a connector_revoke on that source.
    { id: "mem_secret", kind: "fact", ts, source_refs: [{ source: "__proto__" }] },
    { id: "mem_derived", kind: "reconstructed", ts, derived_from: ["mem_secret"] },
    { id: "revoke_proto", kind: "policy", policy_kind: "connector_revoke", ts, target_source: "__proto__" },
    // reverseAdj hostile ANCESTOR key "__proto__": a directly-excised fact whose
    // id is literally "__proto__", with a descendant reached only via the map.
    { id: "__proto__", kind: "fact", ts },
    { id: "kid_of_proto", kind: "reconstructed", ts, derived_from: ["__proto__"] },
    { id: "ex_proto_id", kind: "policy", policy_kind: "excise", ts, targets: ["__proto__"] },
    // "constructor" source + revoke (own-enumerable; must round-trip losslessly).
    { id: "mem_ctor", kind: "fact", ts, source_refs: [{ source: "constructor" }] },
    { id: "revoke_ctor", kind: "policy", policy_kind: "connector_revoke", ts, target_source: "constructor" },
    // "prototype" ancestor + excise (own-enumerable; must round-trip losslessly).
    { id: "prototype", kind: "fact", ts },
    { id: "kid_of_prototype", kind: "reconstructed", ts, derived_from: ["prototype"] },
    { id: "ex_prototype_id", kind: "policy", policy_kind: "excise", ts, targets: ["prototype"] },
  ];
  writeFileSync(ledgerPath, rows(base), "utf8");
  try {
    rmSync(cachePath, { force: true });
  } catch {}
  _resetTransitiveOrphanCaches();

  // Prime via a FULL rebuild (no cache yet) — the ground-truth path.
  const excisedPrime = await loadDerivationExciseSet({});
  const orphanPrime = await loadTransitiveOrphanMap({});
  check(
    "T8 prime is a full rebuild",
    __peekScanColdStatsForTests()?.mode === "full-rebuild",
    `got ${JSON.stringify(__peekScanColdStatsForTests())}`,
  );
  check("T8 prime: '__proto__' source excises mem_secret", excisedPrime.has("mem_secret"));
  check("T8 prime: 'constructor' source excises mem_ctor", excisedPrime.has("mem_ctor"));
  check(
    "T8 prime: '__proto__'-ancestor descendant orphaned",
    orphanPrime.get("kid_of_proto")?.transitive_orphan === true,
  );
  check(
    "T8 prime: mem_derived (child of revoked-source fact) orphaned",
    orphanPrime.get("mem_derived")?.transitive_orphan === true,
  );
  await _awaitPendingScanCachePersists();
  check("T8 scheduled persist landed", existsSync(cachePath));

  // Fresh-process cold reload: exact-eof cache hit -> deserialize path.
  _resetTransitiveOrphanCaches();
  const excisedReload = await loadDerivationExciseSet({});
  const orphanReload = await loadTransitiveOrphanMap({});
  const reloadMode = __peekScanColdStatsForTests()?.mode;
  check(
    "T8 reload used the disk cache (deserialize path)",
    reloadMode === "cache-hit-exact" || reloadMode === "incremental",
    `got ${reloadMode}`,
  );
  // The load-bearing RED assertions: hostile keys survive the round-trip.
  check(
    "T8 round-trip: revoked '__proto__' source still excises mem_secret",
    excisedReload.has("mem_secret"),
    "revoked source lost its memory ids after cache load",
  );
  check(
    "T8 round-trip: '__proto__'-ancestor descendant still orphaned",
    orphanReload.get("kid_of_proto")?.transitive_orphan === true,
    "reverseAdj['__proto__'] lost after cache load",
  );
  check(
    "T8 round-trip: mem_derived still orphaned via revoked-source seed",
    orphanReload.get("mem_derived")?.transitive_orphan === true,
  );
  // Belt-and-suspenders: 'constructor'/'prototype' also lossless.
  check("T8 round-trip: 'constructor' source still excises mem_ctor", excisedReload.has("mem_ctor"));
  check(
    "T8 round-trip: 'prototype'-ancestor descendant still orphaned",
    orphanReload.get("kid_of_prototype")?.transitive_orphan === true,
  );

  // Deep-equivalence: cache round-trip == a fresh full rebuild.
  rmSync(cachePath, { force: true });
  _resetTransitiveOrphanCaches();
  const excisedFull = await loadDerivationExciseSet({});
  const orphanFull = await loadTransitiveOrphanMap({});
  check(
    "T8 round-trip excise set deep-equals full scan",
    JSON.stringify(Array.from(excisedReload).sort()) ===
      JSON.stringify(Array.from(excisedFull).sort()),
    `reload=${JSON.stringify(Array.from(excisedReload).sort())} full=${JSON.stringify(Array.from(excisedFull).sort())}`,
  );
  const canonT8 = (m) => {
    const out = {};
    for (const [k, v] of m) {
      out[k] = [v.distance_to_nearest_excised, v.transitive_orphan, v.rescued_by_corroboration];
    }
    return out;
  };
  check(
    "T8 round-trip orphan map deep-equals full scan",
    JSON.stringify(canonT8(orphanReload)) === JSON.stringify(canonT8(orphanFull)),
  );
  await _awaitPendingScanCachePersists();
}

// ---------------------------------------------------------------------------
// Test 9 (Finding 3 — exported single-candidate predicate-gate fn): the pure
// predicateMaskForCandidate is the single source of truth reused by
// applyHardGates and (in a later node) by RC's post-vector-overlay reapply. It
// masks a matching candidate given an EXPLICIT resolved embedding (dim-matched
// cosine) and, independently, via entity-overlap.
// ---------------------------------------------------------------------------
{
  const gv = basisVec(0); // 3072-dim, unit norm
  const pred = {
    predicate_id: "pred_gate",
    query_embedding: gv,
    embedding_dim: DIM,
    similarity_threshold: 0.85,
  };

  // (a) RC path: an explicit resolvedVector is used even when the entry carries
  // NO stored embedding (proves the overlay vector is honored).
  const rA = predicateMaskForCandidate({ memory_id: "g1" }, gv, [pred]);
  check(
    "T9 explicit resolvedVector masks a dim-matched candidate",
    rA.masked === true && rA.predicate_id === "pred_gate",
    JSON.stringify(rA),
  );

  // (b) Batch path parity: resolvedVector=null falls back to the stored vector.
  const rB = predicateMaskForCandidate(
    { memory_id: "g2", embedding_3072: gv },
    null,
    [pred],
  );
  check(
    "T9 null resolvedVector falls back to stored same-dim embedding",
    rB.masked === true && rB.predicate_id === "pred_gate",
    JSON.stringify(rB),
  );

  // (c) Below threshold: orthogonal candidate is not masked.
  const rC = predicateMaskForCandidate(
    { memory_id: "g3", embedding_3072: basisVec(1) },
    null,
    [pred],
  );
  check("T9 orthogonal candidate not masked", rC.masked === false && rC.predicate_id === null);

  // (d) Entity-overlap channel: candidate with NO same-dim vector but a shared
  // context entity is masked, independent of geometry.
  const predEnt = {
    predicate_id: "pred_ent",
    query_embedding: gv,
    embedding_dim: DIM,
    context_entities: ["ent_shared"],
  };
  const rD = predicateMaskForCandidate(
    { memory_id: "e1", entities: ["ent_other", "ent_shared"] },
    null,
    [predEnt],
  );
  check(
    "T9 entity-overlap masks a candidate with no same-dim vector",
    rD.masked === true && rD.predicate_id === "pred_ent",
    JSON.stringify(rD),
  );
  const rE = predicateMaskForCandidate(
    { memory_id: "e2", entities: ["ent_unrelated"] },
    null,
    [predEnt],
  );
  check("T9 non-overlapping entities not masked", rE.masked === false);

  // (e) Null entry / empty predicates are safe no-ops.
  check(
    "T9 null entry is a safe no-op",
    predicateMaskForCandidate(null, gv, [pred]).masked === false,
  );
  check(
    "T9 empty predicate list is a safe no-op",
    predicateMaskForCandidate({ memory_id: "g4", embedding_3072: gv }, null, []).masked === false,
  );

  // (f) applyHardGates reuses the same helper — no behavior change on the
  // existing cosine path (cross-check against the batch API).
  const batch = applyHardGates(
    [{ memory_id: "g5", embedding_3072: gv, consent_basis: "first_party" }],
    { activePredicates: [pred], embedding_model_version: MODEL_VERSION },
  );
  check(
    "T9 applyHardGates masks via the shared helper (predicate_excluded:pred_gate)",
    batch[0].predicate_mask === 0 &&
      batch[0].dropped_reason === "predicate_excluded:pred_gate",
    `mask=${batch[0].predicate_mask} reason="${batch[0].dropped_reason}"`,
  );
}

// ---------------------------------------------------------------------------
// Exit.
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nAll hard-gates tests passed.");
