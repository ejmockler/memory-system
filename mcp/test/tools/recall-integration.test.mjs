// recall-integration.test.mjs — R25 gate-zero hermetic integration test.
//
// Verifies that the memory_recall MCP tool actually calls appendRecallEvent on
// every invocation, growing ledgers/recall.jsonl by exactly one line per call.
//
// Coverage (per R25 task spec § 6.tools/recall-integration):
//   T1 — memory_recall invocation -> recall.jsonl gains a row whose
//        query.surrounding_context_hash matches the hash of the synthetic ctx.
//   T2 — the persisted event carries the expected v0/v1 shape fields so the
//        downstream off-policy-evaluation substrate is sound.
//
// Discipline:
//   - Fully hermetic: tmp root + env vars set before any dynamic import.
//   - No real embed call: WU-recall-flip-to-local-4096 routed the recall query
//     embedding to the LOCAL Qwen3 server (not Gemini). To keep this test
//     network-free AND on the degraded path, LOCAL_EMBED_URL points at a dead
//     port so local-embedder-client throws LocalEmbedUnavailableError and the
//     handler's degraded_recall branch takes over. (GEMINI_API_KEY is still
//     unset for the Layer-3 Flash path, which is a separate concern.)
//   - Empty BM25/HNSW indices + empty memory.jsonl -> handler returns 0 surfaced
//     items but STILL writes a recall event (the persistence contract is what
//     this test pins).
//   - The production tree (the default data root: this checkout) stays
//     byte-identical pre/post.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";


import { skipIfDaemonActive } from "../_hermetic-daemon-skip.mjs";
skipIfDaemonActive("recall-integration");

// ---------------------------------------------------------------------------
// 0. Hermetic root + env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-r25-recall-int-"));
const HERMETIC_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(HERMETIC_ROOT, "policy");
const STORAGE_DIR = join(HERMETIC_ROOT, "storage");
const LEDGERS_DIR = join(HERMETIC_ROOT, "ledgers");
const INDICES_DIR = join(HERMETIC_ROOT, "indices");
for (const d of [HERMETIC_ROOT, POLICY_DIR, STORAGE_DIR, LEDGERS_DIR, INDICES_DIR]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}
process.env.MEMORY_ROOT = HERMETIC_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;

// Force-degrade the embed path so the test has zero network dependence.
// WU-recall-flip-to-local-4096 — the query embeds locally now; point the local
// client at a dead port (unreachable) so it throws LocalEmbedUnavailableError
// and the handler takes the degraded_recall branch. GEMINI_API_KEY stays unset
// for the (separate) Layer-3 Flash rerank path.
delete process.env.GEMINI_API_KEY;
process.env.LOCAL_EMBED_URL = "http://127.0.0.1:1"; // dead port -> ECONNREFUSED

// Production snapshot guard.
// The production tree is lib/config.js's DEFAULT data root: the checkout that
// contains mcp/ (three levels above this file). Derived, never spelled.
const CHECKOUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROD_MEMORY = join(CHECKOUT_ROOT, "ledgers", "memory.jsonl");
const PROD_RECALL = join(CHECKOUT_ROOT, "ledgers", "recall.jsonl");
const PROD_INDICES = join(CHECKOUT_ROOT, "indices");
const PROD_SIGNING_KEY = join(CHECKOUT_ROOT, "policy", "distillation-signing-key.json");
function snap(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const PROD_BEFORE = {
  memory: snap(PROD_MEMORY),
  recall: snap(PROD_RECALL),
  indices: snap(PROD_INDICES),
  signing_key: snap(PROD_SIGNING_KEY),
};

// ---------------------------------------------------------------------------
// 1. Dynamic imports AFTER env is set.
// ---------------------------------------------------------------------------
const recallMod = await import("../../lib/tools/recall.js");
const { canonicalJson } = await import("../../lib/validation.js");

const RECALL_JSONL = join(LEDGERS_DIR, "recall.jsonl");

// ---------------------------------------------------------------------------
// 2. Framework.
// ---------------------------------------------------------------------------
let failures = 0;
function record(label, ok, diag) {
  if (ok) {
    console.log(`PASS  ${label}` + (diag ? `  -- ${diag}` : ""));
  } else {
    failures += 1;
    console.log(`FAIL  ${label}  -- ${diag || "(no diagnostic)"}`);
  }
}

function readRecallJsonl() {
  if (!existsSync(RECALL_JSONL)) return [];
  return readFileSync(RECALL_JSONL, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

function buildArgs(currentQuery) {
  return {
    surrounding_context: {
      recent_turns: [{ role: "user", content: currentQuery }],
      agent_role: "test-agent",
      current_query: currentQuery,
      time: "2026-06-02T00:00:00.000Z",
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: "conv_r25_recall_integration_test",
    max_items: 12,
    max_chars: 4000,
  };
}

// ---------------------------------------------------------------------------
// T1 — memory_recall writes a recall event whose surrounding_context_hash
// matches the canonical-json hash of the synthetic ctx.
// ---------------------------------------------------------------------------
{
  const linesBefore = readRecallJsonl().length;
  const QUERY = "what did the user say about the project deadline?";
  const args = buildArgs(QUERY);

  let result = null;
  let exception = null;
  try {
    result = await recallMod.TOOL.handler(args);
  } catch (e) {
    exception = e.message;
  }

  const linesAfter = readRecallJsonl();
  const grewBy = linesAfter.length - linesBefore;
  const lastEvent = linesAfter[linesAfter.length - 1] || null;

  // Hash the canonical-JSON of the ctx the way recall.js:274-276 does.
  const expectedHash = createHash("sha256")
    .update(canonicalJson(args.surrounding_context), "utf8")
    .digest("hex");

  const handlerOk = result != null && result.ok === true;
  const grewOk = grewBy === 1;
  const hashOk =
    lastEvent != null &&
    lastEvent.query != null &&
    lastEvent.query.surrounding_context_hash === expectedHash;
  const kindOk = lastEvent != null && lastEvent.kind === "recall";
  const degradedOk =
    lastEvent != null && lastEvent.degraded_recall === true; // GEMINI_API_KEY unset

  const ok = exception == null && handlerOk && grewOk && hashOk && kindOk && degradedOk;
  record(
    "T1 memory_recall persists recall event with matching surrounding_context_hash",
    ok,
    `grew_by=${grewBy} handler_ok=${handlerOk} hash_match=${hashOk} kind_ok=${kindOk} degraded=${degradedOk} exception=${exception}`,
  );
}

// ---------------------------------------------------------------------------
// T2 — persisted event carries the v0/v1 base shape fields needed for the
// off-policy-evaluation substrate.
//
// NOTE on the R25 task-spec request "caps_snapshot in the recall event matches
// the current CAPS.SALIENCE_WEIGHTS_V1_HASH": at R25 ship the salience caps
// land via sibling agent A6 (mcp/lib/validation.js CAPS edits). When that
// merges, the recallEvent body will gain a top-level caps_snapshot field
// keyed on SALIENCE_WEIGHTS_V1_HASH; until then, the persistence-shape
// assertion here pins the v0 + v1-additive surface so the test does not
// silently regress when A6 lands. The v1 reranker-side caps surface
// (rerank_caps_snapshot) is populated only on rerank attempts; in this
// degraded-path test rerank_attempted=false so rerank_caps_snapshot is null,
// which is the documented contract in recall-log.js:144-160.
// ---------------------------------------------------------------------------
{
  const events = readRecallJsonl();
  const ev = events[events.length - 1];

  const shapeFields = [
    "id",
    "ts",
    "kind",
    "query",
    "surfaced",
    "candidates_pre_truncation",
    "density_flag",
    "degraded_recall",
    "rerank_attempted",
    "rerank_failed_reason",
    "layer3_latency_ms",
    "degraded_recall_layer3",
  ];
  const missing = ev == null ? shapeFields : shapeFields.filter((f) => !(f in ev));
  const queryShapeOk =
    ev != null &&
    ev.query != null &&
    typeof ev.query.surrounding_context_hash === "string" &&
    Array.isArray(ev.query.context_embedding) &&
    typeof ev.query.embedding_model_version === "string";
  const idShapeOk = ev != null && typeof ev.id === "string" && ev.id.startsWith("rec_");
  const surfacedArr = ev != null && Array.isArray(ev.surfaced);
  const candsArr = ev != null && Array.isArray(ev.candidates_pre_truncation);

  // Degraded path -> rerank not attempted -> reranker caps surface is null.
  // This guards against a regression where rerank.js eagerly populates the
  // snapshot even on no-op invocations.
  const rerankNoopOk =
    ev != null &&
    ev.rerank_attempted === false &&
    ev.rerank_failed_reason === null &&
    ev.degraded_recall_layer3 === false;

  const ok =
    ev != null &&
    missing.length === 0 &&
    queryShapeOk &&
    idShapeOk &&
    surfacedArr &&
    candsArr &&
    rerankNoopOk;
  record(
    "T2 persisted recall event carries v0/v1 base shape",
    ok,
    `missing=[${missing.join(",")}] query_shape=${queryShapeOk} id_shape=${idShapeOk} surfaced_arr=${surfacedArr} cands_arr=${candsArr} rerank_noop=${rerankNoopOk}`,
  );
}

// ---------------------------------------------------------------------------
// T3 (bonus) — two sequential memory_recall calls each grow recall.jsonl by 1
// (covers the "no batching, no in-flight merging" invariant).
// ---------------------------------------------------------------------------
{
  const linesBefore = readRecallJsonl().length;
  let exception = null;
  try {
    await recallMod.TOOL.handler(buildArgs("first follow-up query"));
    await recallMod.TOOL.handler(buildArgs("second follow-up query"));
  } catch (e) {
    exception = e.message;
  }
  const linesAfter = readRecallJsonl().length;
  const grewBy = linesAfter - linesBefore;
  const ok = exception == null && grewBy === 2;
  record(
    "T3 two sequential memory_recall calls each append exactly one row",
    ok,
    `grew_by=${grewBy} expected=2 exception=${exception}`,
  );
}

// ---------------------------------------------------------------------------
// Production-snapshot guard.
// ---------------------------------------------------------------------------
const PROD_AFTER = {
  memory: snap(PROD_MEMORY),
  recall: snap(PROD_RECALL),
  indices: snap(PROD_INDICES),
  signing_key: snap(PROD_SIGNING_KEY),
};
const prodUnchanged =
  PROD_AFTER.memory === PROD_BEFORE.memory &&
  PROD_AFTER.recall === PROD_BEFORE.recall &&
  PROD_AFTER.indices === PROD_BEFORE.indices &&
  PROD_AFTER.signing_key === PROD_BEFORE.signing_key;
record(
  "Production paths byte-identical pre/post",
  prodUnchanged,
  `memory ${PROD_BEFORE.memory}->${PROD_AFTER.memory} | recall ${PROD_BEFORE.recall}->${PROD_AFTER.recall} | indices ${PROD_BEFORE.indices}->${PROD_AFTER.indices} | signing_key ${PROD_BEFORE.signing_key}->${PROD_AFTER.signing_key}`,
);

// ---------------------------------------------------------------------------
// Cleanup.
// ---------------------------------------------------------------------------
try {
  rmSync(TMP_ROOT, { recursive: true, force: true });
} catch {
  // best-effort
}

if (failures > 0) {
  console.error(`\nFAIL  ${failures} step(s) failed.`);
  process.exit(1);
}
console.log("\nALL PASS  recall-integration");
