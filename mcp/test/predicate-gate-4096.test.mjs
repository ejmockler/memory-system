// predicate-gate-4096.test.mjs — B1a2 red-first suite (+ B1a2b hardening legs).
//
// Proves the memory_exclude → predicates.jsonl → loadActivePredicates →
// applyHardGates chain end-to-end in the PREDICATE's own vector geometry
// (4096 on the primary local path), plus legacy query_embedding_3072
// compatibility, cross-dimension safety, inert-row skip, and active:false
// last-write-wins tombstones.
//
// B1a2b legs (G–K): empty-context-embedding exclude rejection (no inert row
// ever persists), 0600 file mode, gate-path rescind (tombstone reaches
// loadActivePredicates, not just the in-memory Map), restart survival via a
// child process sharing POLICY_BASE_DIR (hydration makes persisted predicates
// rescindable/introspectable after restart), Float32Array candidate pins
// through applyHardGates, and cap reconciliation across a restart.
//
// Run: cd mcp && node test/predicate-gate-4096.test.mjs
// Exits 0 on pass, non-zero on any failure.
//
// HERMETICITY (standing C-NEW-2 pattern, copied from
// predicate-lifecycle.test.mjs:17-33): config.js binds every path at FIRST
// import, and static ESM imports are hoisted, so env overrides MUST be set
// before any dynamic `await import(...)` of mcp lib modules. LEDGERS_BASE_DIR
// must also point into TEST_ROOT because exclude.js fire-and-forgets
// propagateForgettingThroughSynthesis against memoryLedgerPath().
//
// All vectors are unit-norm one-hot basis vectors: cosineSimilarity is
// dot-product-only (hard-gates.js), so identical basis vectors give cos 1
// (> PREDICATE_MATCH_COSINE_THRESHOLD 0.85) and orthogonal ones give 0.

import { spawnSync } from "node:child_process";
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

const TEST_ROOT = mkdtempSync(join(tmpdir(), "predicate-gate-4096-"));
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.on("exit", () => {
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// Dynamic import AFTER env override.
const { TOOL: excludeTool } = await import("../lib/tools/exclude.js");
const { TOOL: rescindTool } = await import("../lib/tools/rescind-policy.js");
const { recordRecall } = await import("../lib/recall-log.js");
const { applyHardGates, loadActivePredicates } = await import(
  "../lib/recall/hard-gates.js"
);
const { CAPS } = await import("../lib/validation.js");

const PREDICATES_PATH = join(process.env.POLICY_BASE_DIR, "predicates.jsonl");

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function oneHot(dim, idx) {
  const v = new Array(dim).fill(0);
  v[idx] = 1;
  return v;
}

// Unit-norm vector whose dot product with oneHot(dim, 0) is exactly `c`
// (cosineSimilarity in hard-gates.js is dot-product-only): [c, sqrt(1-c^2), 0…]
// has norm 1 and cosine c against e0.
function vecCosToE0(dim, c) {
  const v = new Array(dim).fill(0);
  v[0] = c;
  v[1] = Math.sqrt(1 - c * c);
  return v;
}

const e0_4096 = oneHot(4096, 0);
const e1_4096 = oneHot(4096, 1); // orthogonal to e0_4096
const e0_3072 = oneHot(3072, 0);

// ---------------------------------------------------------------------------
// Leg A (primary red leg): exclude persists a 4096 predicate; loader returns
// it dim-tagged; gate masks a 4096-embedded candidate.
// ---------------------------------------------------------------------------
recordRecall("rc_test_1", {
  logged_at: new Date().toISOString(), // lookupRecall TTL-checks this field
  query: {
    context_embedding: e0_4096,
    embedding_model_version: CAPS.ACTIVE_EMBED_MODEL_VERSION,
  },
});

let excludeEnv = null;
let excludeErr = null;
try {
  excludeEnv = await excludeTool.handler({
    recall_id: "rc_test_1",
    predicate: {
      context_entities: ["mem_x"],
      similarity_threshold: 0.9,
      scope: { agent_role: "assistant" },
    },
    conversation_id: "c1",
    agent_role: "assistant",
  });
} catch (err) {
  excludeErr = err;
}
check(
  "A: exclude handler returned ok",
  excludeErr === null && excludeEnv?.ok === true,
  excludeErr ? `threw ${excludeErr.message}` : JSON.stringify(excludeEnv),
);

const predsA = await loadActivePredicates();
check(
  "A: loader returns exactly 1 predicate",
  predsA.length === 1,
  `got ${predsA.length}`,
);
const predA = predsA[0];
check(
  "A: predicate query_embedding.length === 4096",
  Array.isArray(predA?.query_embedding) && predA.query_embedding.length === 4096,
  `got ${predA?.query_embedding?.length}`,
);
check(
  "A: predicate embedding_dim === 4096",
  predA?.embedding_dim === 4096,
  `got ${predA?.embedding_dim}`,
);

const gatedA = applyHardGates(
  [{ memory_id: "m1", embedding_4096: e0_4096, consent_basis: "first_party" }],
  { activePredicates: predsA, embedding_model_version: "any-nonempty" },
);
check(
  "A: 4096 candidate predicate_mask === 0",
  gatedA[0].predicate_mask === 0,
  `got ${gatedA[0].predicate_mask}`,
);
check(
  "A: dropped_reason === predicate_excluded:<id>",
  predA != null &&
    gatedA[0].dropped_reason === `predicate_excluded:${predA.predicate_id}`,
  `got "${gatedA[0].dropped_reason}"`,
);

check(
  "A: <POLICY_BASE_DIR>/predicates.jsonl exists",
  existsSync(PREDICATES_PATH),
  PREDICATES_PATH,
);
let rowsA = [];
if (existsSync(PREDICATES_PATH)) {
  rowsA = readFileSync(PREDICATES_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}
check(
  "A: persisted single row with policy_kind exclude",
  rowsA.length === 1 && rowsA[0].policy_kind === "exclude",
  `rows=${rowsA.length} policy_kind=${rowsA[0]?.policy_kind}`,
);
check(
  "A: persisted row embedding_dim === 4096",
  rowsA[0]?.embedding_dim === 4096,
  `got ${rowsA[0]?.embedding_dim}`,
);

// ---------------------------------------------------------------------------
// Leg B (legacy compat): hand-written query_embedding_3072 row loads
// normalized and masks an embedding_3072 candidate.
// ---------------------------------------------------------------------------
appendFileSync(
  PREDICATES_PATH,
  JSON.stringify({
    predicate_id: "pred_legacy",
    active: true,
    query_embedding_3072: e0_3072,
  }) + "\n",
);
const predsB = await loadActivePredicates();
const legacy = predsB.find((p) => p.predicate_id === "pred_legacy");
check(
  "B: legacy row loads normalized (query_embedding len 3072)",
  Array.isArray(legacy?.query_embedding) && legacy.query_embedding.length === 3072,
  `got ${legacy?.query_embedding?.length}`,
);
check(
  "B: legacy row embedding_dim === 3072",
  legacy?.embedding_dim === 3072,
  `got ${legacy?.embedding_dim}`,
);
const gatedB = applyHardGates(
  [{ memory_id: "m2", embedding_3072: e0_3072, consent_basis: "first_party" }],
  {
    activePredicates: legacy ? [legacy] : [],
    embedding_model_version: "any-nonempty",
  },
);
check(
  "B: 3072 candidate masked by legacy predicate",
  gatedB[0].predicate_mask === 0 &&
    gatedB[0].dropped_reason === "predicate_excluded:pred_legacy",
  `mask=${gatedB[0].predicate_mask} reason="${gatedB[0].dropped_reason}"`,
);

// ---------------------------------------------------------------------------
// Leg C (geometry guard): 4096 predicate vs 3072-only candidate → mask stays
// 1 (cannot evaluate → per-predicate skip; never a cross-dim cosine), no
// throw.
// ---------------------------------------------------------------------------
let gatedC = null;
let cThrew = null;
try {
  gatedC = applyHardGates(
    [{ memory_id: "m3", embedding_3072: e0_3072, consent_basis: "first_party" }],
    { activePredicates: predsA, embedding_model_version: "any-nonempty" },
  );
} catch (err) {
  cThrew = err;
}
check("C: no throw on cross-dim evaluation", cThrew === null, cThrew?.message);
check(
  "C: 4096 predicate vs 3072-only candidate → predicate_mask === 1",
  gatedC?.[0]?.predicate_mask === 1 && gatedC?.[0]?.dropped_reason === null,
  `mask=${gatedC?.[0]?.predicate_mask} reason=${gatedC?.[0]?.dropped_reason}`,
);

// ---------------------------------------------------------------------------
// Leg D (below threshold): 4096 predicate vs orthogonal 4096 candidate →
// mask stays 1 (cos 0 < 0.85).
// ---------------------------------------------------------------------------
const gatedD = applyHardGates(
  [{ memory_id: "m4", embedding_4096: e1_4096, consent_basis: "first_party" }],
  { activePredicates: predsA, embedding_model_version: "any-nonempty" },
);
check(
  "D: orthogonal 4096 candidate → predicate_mask === 1",
  gatedD[0].predicate_mask === 1 && gatedD[0].dropped_reason === null,
  `mask=${gatedD[0].predicate_mask} reason=${gatedD[0].dropped_reason}`,
);

// ---------------------------------------------------------------------------
// Leg E (inert-row skip): a row with query_embedding: [] / embedding_dim: 0
// must be skipped by the loader, never returned.
// ---------------------------------------------------------------------------
appendFileSync(
  PREDICATES_PATH,
  JSON.stringify({
    predicate_id: "pred_inert",
    active: true,
    query_embedding: [],
    embedding_dim: 0,
  }) + "\n",
);
const predsE = await loadActivePredicates();
check(
  "E: inert (dim-0) row is skipped by loader",
  !predsE.some((p) => p.predicate_id === "pred_inert"),
  JSON.stringify(predsE.map((p) => p.predicate_id)),
);

// ---------------------------------------------------------------------------
// Leg F (last-write-wins): an active:false tombstone appended for the leg-A
// predicate_id removes it from the loader's output. Pre-wires the
// rescind-persistence follow-up.
// ---------------------------------------------------------------------------
const legAId = predA?.predicate_id ?? "pred_missing_from_leg_a";
appendFileSync(
  PREDICATES_PATH,
  JSON.stringify({ predicate_id: legAId, active: false }) + "\n",
);
const predsF = await loadActivePredicates();
check(
  "F: tombstoned leg-A predicate no longer returned (last-write-wins)",
  !predsF.some((p) => p.predicate_id === legAId),
  JSON.stringify(predsF.map((p) => p.predicate_id)),
);
check(
  "F: legacy predicate still returned after unrelated tombstone",
  predsF.some((p) => p.predicate_id === "pred_legacy"),
  JSON.stringify(predsF.map((p) => p.predicate_id)),
);

// ---------------------------------------------------------------------------
// Leg G (B1a2b red leg): exclude against a recall entry with a MISSING or
// EMPTY context_embedding must throw — never ok:true, never a persisted inert
// row, and no NEW per-row loader console.error afterwards. Also pins the
// 0600 file mode (rows carry conversation_id, rationale, full query
// embedding — same sensitivity class as recall-log.js LEDGER_FILE_MODE).
// ---------------------------------------------------------------------------
async function loaderErrorCount() {
  const orig = console.error;
  let n = 0;
  console.error = () => {
    n += 1;
  };
  try {
    await loadActivePredicates();
  } finally {
    console.error = orig;
  }
  return n;
}

const fileBeforeG = readFileSync(PREDICATES_PATH, "utf8");
const errsBeforeG = await loaderErrorCount(); // baseline: leg-E's inert row already logs

recordRecall("rc_test_degraded", {
  logged_at: new Date().toISOString(),
  // No query.context_embedding at all — the degraded/BM25-only recall shape.
  query: { embedding_model_version: CAPS.ACTIVE_EMBED_MODEL_VERSION },
});
let gEnv = null;
let gErr = null;
try {
  gEnv = await excludeTool.handler({
    recall_id: "rc_test_degraded",
    predicate: {
      context_entities: ["mem_g"],
      similarity_threshold: 0.9,
      scope: { agent_role: "assistant" },
    },
    conversation_id: "c1",
    agent_role: "assistant",
  });
} catch (err) {
  gErr = err;
}
check(
  "G: exclude on embedding-less recall throws (no ok:true)",
  gErr != null && gEnv === null,
  gEnv ? JSON.stringify(gEnv) : `err=${gErr?.message}`,
);
check(
  "G: thrown error is ToolError INVALID_ARGUMENTS",
  gErr?.name === "ToolError" && gErr?.code === "INVALID_ARGUMENTS",
  `got name=${gErr?.name} code=${gErr?.code}`,
);

recordRecall("rc_test_empty_vec", {
  logged_at: new Date().toISOString(),
  query: {
    context_embedding: [], // present but empty — same inert class
    embedding_model_version: CAPS.ACTIVE_EMBED_MODEL_VERSION,
  },
});
let gErr2 = null;
let gEnv2 = null;
try {
  gEnv2 = await excludeTool.handler({
    recall_id: "rc_test_empty_vec",
    predicate: {
      context_entities: ["mem_g2"],
      similarity_threshold: 0.9,
      scope: { agent_role: "assistant" },
    },
    conversation_id: "c1",
    agent_role: "assistant",
  });
} catch (err) {
  gErr2 = err;
}
check(
  "G: exclude on empty-array embedding recall throws INVALID_ARGUMENTS",
  gEnv2 === null && gErr2?.code === "INVALID_ARGUMENTS",
  gEnv2 ? JSON.stringify(gEnv2) : `got code=${gErr2?.code}`,
);

check(
  "G: predicates.jsonl gained no row from rejected excludes",
  readFileSync(PREDICATES_PATH, "utf8") === fileBeforeG,
  "file content changed",
);
const errsAfterG = await loaderErrorCount();
check(
  "G: no NEW per-row loader console.error after rejected excludes",
  errsAfterG === errsBeforeG,
  `before=${errsBeforeG} after=${errsAfterG}`,
);
check(
  "G: predicates.jsonl mode is 0600",
  (statSync(PREDICATES_PATH).mode & 0o777) === 0o600,
  `got 0${(statSync(PREDICATES_PATH).mode & 0o777).toString(8)}`,
);

// ---------------------------------------------------------------------------
// Leg H (B1a2b red leg, gate-path rescind): exclude → recall gate masks the
// candidate (mask 0) → rescind via the rescind-policy HANDLER → the next
// loadActivePredicates (the gate's fresh per-recall read) must no longer
// return the predicate and applyHardGates must leave the mask at 1. Fails
// pre-fix because rescind flipped only the in-memory Map.
// ---------------------------------------------------------------------------
recordRecall("rc_test_2", {
  logged_at: new Date().toISOString(),
  query: {
    context_embedding: e1_4096,
    embedding_model_version: CAPS.ACTIVE_EMBED_MODEL_VERSION,
  },
});
const exH = await excludeTool.handler({
  recall_id: "rc_test_2",
  predicate: {
    context_entities: ["mem_h"],
    similarity_threshold: 0.9,
    scope: { agent_role: "assistant" },
  },
  conversation_id: "c1",
  agent_role: "assistant",
});
const predHId = exH.data.predicate_id;
const candH = { memory_id: "mH", embedding_4096: e1_4096, consent_basis: "first_party" };
const gatedH1 = applyHardGates([candH], {
  activePredicates: await loadActivePredicates(),
  embedding_model_version: "any-nonempty",
});
check(
  "H: candidate masked while exclude active (real gate path)",
  gatedH1[0].predicate_mask === 0 &&
    gatedH1[0].dropped_reason === `predicate_excluded:${predHId}`,
  `mask=${gatedH1[0].predicate_mask} reason="${gatedH1[0].dropped_reason}"`,
);

let rsEnv = null;
let rsErr = null;
try {
  rsEnv = await rescindTool.handler({
    policy_event_id: predHId,
    conversation_id: "c1",
    agent_role: "assistant",
  });
} catch (err) {
  rsErr = err;
}
check(
  "H: rescind handler ok with was_active true",
  rsErr === null && rsEnv?.ok === true && rsEnv?.data?.was_active === true,
  rsErr ? rsErr.message : JSON.stringify(rsEnv),
);

const rowsH = readFileSync(PREDICATES_PATH, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l));
const tombH = rowsH[rowsH.length - 1];
check(
  "H: rescind appended a tombstone row with the required shape",
  tombH?.policy_kind === "exclude" &&
    tombH?.predicate_id === predHId &&
    tombH?.active === false &&
    typeof tombH?.rescinded_at === "string" &&
    tombH?.emitted_by?.conversation_id === "c1" &&
    tombH?.emitted_by?.agent_role === "assistant",
  JSON.stringify(tombH),
);

const predsH2 = await loadActivePredicates();
check(
  "H: rescinded predicate absent from loader output (tombstone persisted)",
  !predsH2.some((p) => p.predicate_id === predHId),
  JSON.stringify(predsH2.map((p) => p.predicate_id)),
);
const gatedH2 = applyHardGates([candH], {
  activePredicates: predsH2,
  embedding_model_version: "any-nonempty",
});
check(
  "H: candidate mask back to 1 after rescind",
  gatedH2[0].predicate_mask === 1 && gatedH2[0].dropped_reason === null,
  `mask=${gatedH2[0].predicate_mask} reason="${gatedH2[0].dropped_reason}"`,
);

// ---------------------------------------------------------------------------
// Leg I (B1a2b red leg, restart survival): a child process sharing
// POLICY_BASE_DIR (fresh module instances = simulated server restart) must
// hydrate the persisted predicate, rescind it through the handler, and the
// tombstone must be visible to the parent's gate and to a SECOND restart
// (stays gone, still introspectable as active:false via get_predicate).
// ---------------------------------------------------------------------------
recordRecall("rc_test_3", {
  logged_at: new Date().toISOString(),
  query: {
    context_embedding: oneHot(4096, 2),
    embedding_model_version: CAPS.ACTIVE_EMBED_MODEL_VERSION,
  },
});
const exI = await excludeTool.handler({
  recall_id: "rc_test_3",
  predicate: {
    context_entities: ["mem_i"],
    similarity_threshold: 0.9,
    scope: { agent_role: "assistant" },
  },
  conversation_id: "c1",
  agent_role: "assistant",
});
const predIId = exI.data.predicate_id;

const LIB_HREF = new URL("../lib/", import.meta.url).href;
function runChild(scriptName, source, extraEnv = {}) {
  const scriptPath = join(TEST_ROOT, scriptName);
  writeFileSync(scriptPath, source);
  const res = spawnSync(process.execPath, [scriptPath], {
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });
  const line = (res.stdout || "")
    .split("\n")
    .find((l) => l.startsWith("RESULT "));
  let parsed = null;
  if (line) {
    try {
      parsed = JSON.parse(line.slice("RESULT ".length));
    } catch {
      // fall through — caller sees null + raw output
    }
  }
  return { parsed, raw: `status=${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}` };
}

const child1 = runChild(
  "restart-rescind.mjs",
  `const LIB = ${JSON.stringify(LIB_HREF)};
const PRED_ID = process.env.PRED_ID;
const { activePredicates } = await import(LIB + "tools/exclude.js");
const { TOOL: rescindTool } = await import(LIB + "tools/rescind-policy.js");
const { loadActivePredicates } = await import(LIB + "recall/hard-gates.js");
const out = { hydrated: activePredicates.get(PRED_ID)?.active === true };
try {
  const env = await rescindTool.handler({
    policy_event_id: PRED_ID,
    conversation_id: "c_restart",
    agent_role: "assistant",
  });
  out.rescindOk = env?.ok === true;
  out.wasActive = env?.data?.was_active === true;
} catch (err) {
  out.rescindErr = err.code ?? String(err);
}
const preds = await loadActivePredicates();
out.stillGating = preds.some((p) => p.predicate_id === PRED_ID);
console.log("RESULT " + JSON.stringify(out));
`,
  { PRED_ID: predIId },
);
check(
  "I: restarted process hydrates persisted predicate into the registry",
  child1.parsed?.hydrated === true,
  child1.raw,
);
check(
  "I: post-restart rescind succeeds through the handler (was_active true)",
  child1.parsed?.rescindOk === true && child1.parsed?.wasActive === true,
  child1.raw,
);
check(
  "I: predicate stops gating inside the restarted process",
  child1.parsed?.stillGating === false,
  child1.raw,
);

const predsI = await loadActivePredicates();
check(
  "I: child's rescind tombstone visible to parent gate",
  !predsI.some((p) => p.predicate_id === predIId),
  JSON.stringify(predsI.map((p) => p.predicate_id)),
);

const child2 = runChild(
  "restart-introspect.mjs",
  `const LIB = ${JSON.stringify(LIB_HREF)};
const PRED_ID = process.env.PRED_ID;
const { loadActivePredicates } = await import(LIB + "recall/hard-gates.js");
const { TOOL: getPredicateTool } = await import(LIB + "tools/get-predicate.js");
const out = {};
const preds = await loadActivePredicates();
out.gone = !preds.some((p) => p.predicate_id === PRED_ID);
try {
  const env = await getPredicateTool.handler({ predicate_id: PRED_ID });
  out.getOk = env?.ok === true;
  out.getActive = env?.data?.active;
} catch (err) {
  out.getErr = err.code ?? String(err);
}
console.log("RESULT " + JSON.stringify(out));
`,
  { PRED_ID: predIId },
);
check(
  "I: rescinded predicate stays gone after a second restart",
  child2.parsed?.gone === true,
  child2.raw,
);
check(
  "I: rescinded predicate still introspectable after restart (active:false)",
  child2.parsed?.getOk === true && child2.parsed?.getActive === false,
  child2.raw,
);

// ---------------------------------------------------------------------------
// Leg J (Float32Array pin): typed-array candidates must gate exactly like
// plain arrays — freezes the array-like acceptance in _resolveGateVector
// (hard-gates.js), which is otherwise protected only by a comment.
// ---------------------------------------------------------------------------
const gatedJ1 = applyHardGates(
  [
    {
      memory_id: "mJ1",
      embedding_4096: Float32Array.from(e0_4096),
      consent_basis: "first_party",
    },
  ],
  {
    activePredicates: [
      { predicate_id: "pred_f32_new", query_embedding: e0_4096, embedding_dim: 4096 },
    ],
    embedding_model_version: "any-nonempty",
  },
);
check(
  "J: Float32Array embedding_4096 masked by new-shape 4096 predicate",
  gatedJ1[0].predicate_mask === 0 &&
    gatedJ1[0].dropped_reason === "predicate_excluded:pred_f32_new",
  `mask=${gatedJ1[0].predicate_mask} reason="${gatedJ1[0].dropped_reason}"`,
);
const gatedJ2 = applyHardGates(
  [
    {
      memory_id: "mJ2",
      embedding_3072: Float32Array.from(e0_3072),
      consent_basis: "first_party",
    },
  ],
  {
    activePredicates: [
      { predicate_id: "pred_f32_legacy", query_embedding_3072: e0_3072 },
    ],
    embedding_model_version: "any-nonempty",
  },
);
check(
  "J: Float32Array embedding_3072 masked by legacy query_embedding_3072 predicate",
  gatedJ2[0].predicate_mask === 0 &&
    gatedJ2[0].dropped_reason === "predicate_excluded:pred_f32_legacy",
  `mask=${gatedJ2[0].predicate_mask} reason="${gatedJ2[0].dropped_reason}"`,
);

// ---------------------------------------------------------------------------
// Leg K (B1a2b red leg, cap reconciliation across restart): seed a SEPARATE
// policy dir with exactly PREDICATE_MAX_ACTIVE active rows (a prior process's
// output), then a fresh process (child, POLICY_BASE_DIR=capDir) emits one
// more. Pre-fix the child's empty in-memory Map lets the emit through, the
// file exceeds the cap, and the loader's pass-2 break silently stops gating
// one persisted active row. Post-fix: STATE_CONFLICT, no appended row, and
// every persisted active row still gates.
// ---------------------------------------------------------------------------
const CAP_DIR = join(TEST_ROOT, "policy-cap");
mkdirSync(CAP_DIR, { recursive: true });
const capDim = 8;
let capRows = "";
for (let i = 0; i < CAPS.PREDICATE_MAX_ACTIVE; i++) {
  const v = new Array(capDim).fill(0);
  v[i % capDim] = 1;
  capRows +=
    JSON.stringify({
      policy_kind: "exclude",
      predicate_id: `pred_cap_${i}`,
      active: true,
      captured_at: new Date().toISOString(),
      emitted_by: { conversation_id: "c_cap_seed", agent_role: "assistant" },
      context_entities: [`cap_${i}`],
      similarity_threshold: 0.9,
      scope: { agent_role: "assistant" },
      rationale: null,
      recall_id: `rc_cap_${i}`,
      query_embedding: v,
      embedding_dim: capDim,
      embedding_model_version: "test-cap",
    }) + "\n";
}
writeFileSync(join(CAP_DIR, "predicates.jsonl"), capRows);

const childK = runChild(
  "cap-emit.mjs",
  `const LIB = ${JSON.stringify(LIB_HREF)};
const { TOOL: excludeTool } = await import(LIB + "tools/exclude.js");
const { recordRecall } = await import(LIB + "recall-log.js");
const { loadActivePredicates } = await import(LIB + "recall/hard-gates.js");
recordRecall("rc_cap_extra", {
  logged_at: new Date().toISOString(),
  query: {
    context_embedding: [1, 0, 0, 0, 0, 0, 0, 0],
    embedding_model_version: "test-cap",
  },
});
const out = {};
try {
  const env = await excludeTool.handler({
    recall_id: "rc_cap_extra",
    predicate: {
      context_entities: ["cap_extra_entity"],
      similarity_threshold: 0.5,
      scope: { agent_role: "assistant" },
    },
    conversation_id: "c_cap",
    agent_role: "assistant",
  });
  out.ok = env?.ok === true;
} catch (err) {
  out.code = err.code ?? String(err);
}
const preds = await loadActivePredicates();
out.loaderCount = preds.length;
console.log("RESULT " + JSON.stringify(out));
`,
  { POLICY_BASE_DIR: CAP_DIR },
);
check(
  "K: emit at cap after restart throws STATE_CONFLICT (no phantom over-cap success)",
  childK.parsed?.code === "STATE_CONFLICT" && childK.parsed?.ok !== true,
  childK.raw,
);
const capLinesAfter = readFileSync(join(CAP_DIR, "predicates.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");
check(
  "K: no row appended past the cap",
  capLinesAfter.length === CAPS.PREDICATE_MAX_ACTIVE,
  `got ${capLinesAfter.length} rows (cap ${CAPS.PREDICATE_MAX_ACTIVE})`,
);
check(
  "K: every persisted active row still gates (loader returns full cap, no silent truncation)",
  childK.parsed?.loaderCount === CAPS.PREDICATE_MAX_ACTIVE,
  `loader returned ${childK.parsed?.loaderCount} of ${CAPS.PREDICATE_MAX_ACTIVE}`,
);

// ---------------------------------------------------------------------------
// Leg L (Finding 2, per-predicate threshold — persisted chain): a predicate
// persisted with similarity_threshold=0.99 must be carried by the loader and
// HONORED at match. A candidate whose cosine is 0.9 (0.85 < 0.9 < 0.99) is
// masked TODAY (loader drops the threshold; gate uses the global 0.85 cap) but
// must NOT be masked post-fix; a 0.995 candidate (> 0.99) still masks. Proves
// the full exclude -> loadActivePredicates -> applyHardGates chain honors the
// durable knob instead of persisting-and-ignoring it.
// ---------------------------------------------------------------------------
recordRecall("rc_t99", {
  logged_at: new Date().toISOString(),
  query: {
    context_embedding: e0_4096,
    embedding_model_version: CAPS.ACTIVE_EMBED_MODEL_VERSION,
  },
});
const exL = await excludeTool.handler({
  recall_id: "rc_t99",
  predicate: {
    context_entities: ["mem_t99"],
    similarity_threshold: 0.99,
    scope: { agent_role: "assistant" },
  },
  conversation_id: "c1",
  agent_role: "assistant",
});
const predLId = exL.data.predicate_id;
const predsL = await loadActivePredicates();
const predL = predsL.find((p) => p.predicate_id === predLId);
check(
  "L: loader carries similarity_threshold=0.99 onto the predicate",
  predL?.similarity_threshold === 0.99,
  `got ${predL?.similarity_threshold}`,
);
check(
  "L: loader carries context_entities onto the predicate",
  Array.isArray(predL?.context_entities) &&
    predL.context_entities.length === 1 &&
    predL.context_entities[0] === "mem_t99",
  JSON.stringify(predL?.context_entities),
);
const gatedL_below = applyHardGates(
  [{ memory_id: "mL_0p9", embedding_4096: vecCosToE0(4096, 0.9), consent_basis: "first_party" }],
  { activePredicates: [predL], embedding_model_version: "any-nonempty" },
);
check(
  "L: cos 0.9 candidate NOT masked at threshold 0.99 (no over-suppression)",
  gatedL_below[0].predicate_mask === 1 && gatedL_below[0].dropped_reason === null,
  `mask=${gatedL_below[0].predicate_mask} reason="${gatedL_below[0].dropped_reason}"`,
);
const gatedL_above = applyHardGates(
  [{ memory_id: "mL_0p995", embedding_4096: vecCosToE0(4096, 0.995), consent_basis: "first_party" }],
  { activePredicates: [predL], embedding_model_version: "any-nonempty" },
);
check(
  "L: cos 0.995 candidate IS masked at threshold 0.99 (real boundary)",
  gatedL_above[0].predicate_mask === 0 &&
    gatedL_above[0].dropped_reason === `predicate_excluded:${predLId}`,
  `mask=${gatedL_above[0].predicate_mask} reason="${gatedL_above[0].dropped_reason}"`,
);

// ---------------------------------------------------------------------------
// Leg M (Finding 2, low per-predicate threshold): a predicate with
// similarity_threshold=0.5 suppresses MORE — a cos 0.6 candidate is masked
// post-fix (not masked today, where the gate ignores the knob and uses 0.85).
// Legacy back-compat: a predicate WITHOUT a threshold still falls back to the
// global 0.85 cap.
// ---------------------------------------------------------------------------
const predM = {
  predicate_id: "pred_low_05",
  query_embedding: e0_4096,
  embedding_dim: 4096,
  similarity_threshold: 0.5,
};
const gatedM = applyHardGates(
  [{ memory_id: "mM", embedding_4096: vecCosToE0(4096, 0.6), consent_basis: "first_party" }],
  { activePredicates: [predM], embedding_model_version: "any-nonempty" },
);
check(
  "M: cos 0.6 candidate masked at threshold 0.5 (low threshold suppresses more)",
  gatedM[0].predicate_mask === 0 &&
    gatedM[0].dropped_reason === "predicate_excluded:pred_low_05",
  `mask=${gatedM[0].predicate_mask} reason="${gatedM[0].dropped_reason}"`,
);
const predMlegacy = {
  predicate_id: "pred_no_threshold",
  query_embedding: e0_4096,
  embedding_dim: 4096,
  // no similarity_threshold -> falls back to CAPS.PREDICATE_MATCH_COSINE_THRESHOLD
};
const gatedMlegacy = applyHardGates(
  [{ memory_id: "mMl", embedding_4096: vecCosToE0(4096, 0.6), consent_basis: "first_party" }],
  { activePredicates: [predMlegacy], embedding_model_version: "any-nonempty" },
);
check(
  "M: threshold-less predicate still uses the global 0.85 cap (0.6 not masked)",
  gatedMlegacy[0].predicate_mask === 1,
  `mask=${gatedMlegacy[0].predicate_mask}`,
);

// ---------------------------------------------------------------------------
// Leg N (Finding 2, entity-overlap channel): a predicate whose context_entities
// shares a tag with a candidate's entities masks it independent of vector
// geometry — even when the candidate's vector is ORTHOGONAL (cos 0). A
// non-overlapping candidate is untouched.
// ---------------------------------------------------------------------------
const predN = {
  predicate_id: "pred_entity_only",
  query_embedding: e0_4096,
  embedding_dim: 4096,
  context_entities: ["ent_tag"],
};
const gatedN = applyHardGates(
  [{ memory_id: "mN", embedding_4096: e1_4096, entities: ["ent_tag"], consent_basis: "first_party" }],
  { activePredicates: [predN], embedding_model_version: "any-nonempty" },
);
check(
  "N: entity-overlap masks an orthogonal-vector candidate sharing a tag",
  gatedN[0].predicate_mask === 0 &&
    gatedN[0].dropped_reason === "predicate_excluded:pred_entity_only",
  `mask=${gatedN[0].predicate_mask} reason="${gatedN[0].dropped_reason}"`,
);
const gatedNmiss = applyHardGates(
  [{ memory_id: "mNmiss", embedding_4096: e1_4096, entities: ["ent_other"], consent_basis: "first_party" }],
  { activePredicates: [predN], embedding_model_version: "any-nonempty" },
);
check(
  "N: non-overlapping entities + orthogonal vector NOT masked",
  gatedNmiss[0].predicate_mask === 1 && gatedNmiss[0].dropped_reason === null,
  `mask=${gatedNmiss[0].predicate_mask}`,
);

// ---------------------------------------------------------------------------
// Leg O (Finding 2, fail-closed scope authz): a memory_exclude carrying an
// authz-NARROWING scope dim (parties or time_range) the match layer cannot yet
// enforce must be REJECTED at the tool boundary (fail-closed — never
// persisted-and-ignored, which would make the exclusion act GLOBAL). The
// standard Phase-0 forms { agent_role } and {} still succeed; scope "global"
// stays PRIVILEGE_REQUIRED.
// ---------------------------------------------------------------------------
async function excludeScope(scope, recallId, entities) {
  let env = null;
  let err = null;
  try {
    env = await excludeTool.handler({
      recall_id: recallId,
      predicate: { context_entities: entities, similarity_threshold: 0.9, scope },
      conversation_id: "c1",
      agent_role: "assistant",
    });
  } catch (e) {
    err = e;
  }
  return { env, err };
}
// parties / time_range are rejected before the recall lookup even runs.
const oParties = await excludeScope({ parties: ["alice"] }, "rc_scope_reject", ["mem_o1"]);
check(
  "O: parties-scoped exclude rejected fail-closed (INVALID_ARGUMENTS, not persisted)",
  oParties.env === null && oParties.err?.code === "INVALID_ARGUMENTS",
  oParties.env ? JSON.stringify(oParties.env) : `code=${oParties.err?.code}`,
);
const oTime = await excludeScope(
  { time_range: { start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" } },
  "rc_scope_reject",
  ["mem_o2"],
);
check(
  "O: time_range-scoped exclude rejected fail-closed (INVALID_ARGUMENTS)",
  oTime.env === null && oTime.err?.code === "INVALID_ARGUMENTS",
  oTime.env ? JSON.stringify(oTime.env) : `code=${oTime.err?.code}`,
);
// agent_role-only and {} still succeed (valid recall required).
recordRecall("rc_scope_role", {
  logged_at: new Date().toISOString(),
  query: { context_embedding: e0_4096, embedding_model_version: CAPS.ACTIVE_EMBED_MODEL_VERSION },
});
const oRole = await excludeScope({ agent_role: "assistant" }, "rc_scope_role", ["mem_o_role"]);
check(
  "O: agent_role-scope exclude still succeeds",
  oRole.err === null && oRole.env?.ok === true,
  oRole.err ? oRole.err.message : JSON.stringify(oRole.env),
);
recordRecall("rc_scope_empty", {
  logged_at: new Date().toISOString(),
  query: { context_embedding: e0_4096, embedding_model_version: CAPS.ACTIVE_EMBED_MODEL_VERSION },
});
const oEmpty = await excludeScope({}, "rc_scope_empty", ["mem_o_empty"]);
check(
  "O: {} scope exclude still succeeds",
  oEmpty.err === null && oEmpty.env?.ok === true,
  oEmpty.err ? oEmpty.err.message : JSON.stringify(oEmpty.env),
);

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll predicate-gate-4096 assertions passed.`);
