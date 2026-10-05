// Smoke test for the active-predicate lifecycle: exclude → get_predicate → rescind → get_predicate.
// Asserts the four-file coherence the review-5 critical demanded:
// after rescind, get_predicate must observe active:false and list_predicates
// must reflect the dropped active count. Also asserts duplicate-predicate
// dedup throws STATE_CONFLICT (the third spec-5 smoke assertion).
//
// Run: node test/predicate-lifecycle.test.mjs
// Exits 0 on pass, non-zero on any failure.
//
// HERMETICITY (standing C-NEW-2 pattern): the new Phase 3 v0 recall handler
// writes to ledgers/recall.jsonl, reads policy/predicates.jsonl, and reads
// ledgers/memory.jsonl. Redirect everything to a tmpdir BEFORE the dynamic
// imports so config.js binds inside the tmpdir. Static `import` statements
// are hoisted ahead of any top-level statements, so we MUST use dynamic
// `await import(...)` to get the env-override discipline.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const TEST_ROOT = mkdtempSync(join(tmpdir(), "predicate-lifecycle-"));
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
// Layer-3 pinned OFF ("0" is the tri-state override): an unset value falls
// through to the CAP default and dials the rerank daemon on :8360.
process.env.LOCAL_RERANKER_ENABLED = "0";
process.on("exit", () => { try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {} });

// HERMETIC EMBEDDER (stranger machines have no embed server on :8359). The
// recall query embeds through the local client; an unreachable server degrades
// the recall to BM25-only, and memory_exclude (correctly) refuses to bind to a
// recall that carried no query embedding. Stub the transport through the
// client's own seam with one deterministic L2-unit 4096-dim vector, in the
// same response shape as test/synthesis/recall-local-4096-query.test.mjs, so
// the suite exercises the embedding path with no live server.
{
  const { _setFetchForTests } = await import("../lib/local-embedder-client.js");
  const { CAPS: STUB_CAPS } = await import("../lib/validation.js");
  const STUB_DIM = STUB_CAPS.EMBEDDING_DIM_4096;
  const unitSpike = (idx, dim = STUB_DIM) => {
    const v = new Array(dim).fill(0);
    v[idx % dim] = 1;
    return v;
  };
  _setFetchForTests(async (url, init) => {
    const body = JSON.parse(init.body);
    const texts = Array.isArray(body.texts) ? body.texts : [];
    const embeddings = texts.map(() => unitSpike(7));
    return {
      ok: true,
      async text() {
        return JSON.stringify({
          embeddings,
          model_version: STUB_CAPS.ACTIVE_EMBED_MODEL_VERSION,
          dim: STUB_DIM,
          count: embeddings.length,
          elapsed_ms: 1,
        });
      },
    };
  });
  process.on("exit", () => _setFetchForTests(null));
}

const { TOOL: recallTool } = await import("../lib/tools/recall.js");
const { TOOL: excludeTool } = await import("../lib/tools/exclude.js");
const { TOOL: rescindTool } = await import("../lib/tools/rescind-policy.js");
const { TOOL: getPredicateTool } = await import("../lib/tools/get-predicate.js");
const { TOOL: listPredicatesTool } = await import("../lib/tools/list-predicates.js");
const { GEMINI_CLIENT_CONSTANTS } = await import("../lib/gemini-client.js");
const { CAPS } = await import("../lib/validation.js");
// WU-recall-flip-to-local-4096 — the recall query now embeds via the local
// Qwen3 server (active 4096 model) when it is reachable, falling back to the
// legacy Gemini encoder only when the active index is absent + Gemini fills in.
// memory_exclude snapshots whichever model_version the recall event recorded,
// so the EXPECTED snapshot is the active model on the live local path, with the
// legacy Gemini version as the accepted fallback (server down / mid-migration).
const ACTIVE_EMBEDDING_MODEL_VERSION = CAPS.ACTIVE_EMBED_MODEL_VERSION;
const GEMINI_EMBEDDING_MODEL_VERSION =
  GEMINI_CLIENT_CONSTANTS.GEMINI_EMBEDDING_MODEL_VERSION;

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function call(tool, args) {
  const env = await tool.handler(args).catch((err) => ({
    ok: false,
    error: { code: err.code ?? "INTERNAL_ERROR", message: err.message },
    data: null,
    meta: { tool: tool.name },
  }));
  return env;
}

// --- 1. Create a recall to bind exclude against ---
const recall = await call(recallTool, {
  surrounding_context: {
    recent_turns: [{ role: "user", content: "stop bringing up tofu" }],
    agent_role: "assistant",
    current_query: "stop bringing up tofu",
    time: "2026-05-31T06:30:00Z",
  },
  conversation_id: "conv_test",
});
check("recall returned ok", recall.ok === true);
const recallId = recall.data?.recall_id;
check("recall_id present", typeof recallId === "string" && recallId.length > 0);

// --- 2. exclude returns a predicate_id ---
const ex1 = await call(excludeTool, {
  recall_id: recallId,
  predicate: {
    context_entities: ["tofu"],
    similarity_threshold: 0.7,
    scope: { agent_role: "assistant" },
  },
  conversation_id: "conv_test",
  agent_role: "assistant",
});
check("exclude returned ok", ex1.ok === true, JSON.stringify(ex1));
const predicateId = ex1.data?.predicate_id;
check("predicate_id present", typeof predicateId === "string");

// --- 3. get_predicate observes active:true initially ---
const gp1 = await call(getPredicateTool, { predicate_id: predicateId });
check("get_predicate ok before rescind", gp1.ok === true);
check(
  "get_predicate.active is true before rescind",
  gp1.data?.active === true,
  `got active=${gp1.data?.active}`,
);
check(
  "get_predicate carries snapshotted embedding_model_version",
  gp1.data?.embedding_model_version === ACTIVE_EMBEDDING_MODEL_VERSION ||
    gp1.data?.embedding_model_version === GEMINI_EMBEDDING_MODEL_VERSION,
  `got ${gp1.data?.embedding_model_version} (expected ${ACTIVE_EMBEDDING_MODEL_VERSION} on the live local path, or ${GEMINI_EMBEDDING_MODEL_VERSION} on the Gemini fallback)`,
);

// --- 4. list_predicates reflects total_active >= 1 ---
const lp1 = await call(listPredicatesTool, {});
check("list_predicates ok before rescind", lp1.ok === true);
check(
  "list_predicates.total_active >= 1 before rescind",
  lp1.data?.total_active >= 1,
  `got total_active=${lp1.data?.total_active}`,
);
check(
  "list_predicates includes our predicate",
  Array.isArray(lp1.data?.predicates) &&
    lp1.data.predicates.some((p) => p.predicate_id === predicateId),
);

// --- 5. DUPLICATE exclude (same recall_id + scope + threshold + entities) → STATE_CONFLICT ---
const dup = await call(excludeTool, {
  recall_id: recallId,
  predicate: {
    context_entities: ["tofu"],
    similarity_threshold: 0.7,
    scope: { agent_role: "assistant" },
  },
  conversation_id: "conv_test",
  agent_role: "assistant",
});
check("duplicate exclude returned error", dup.ok === false);
check(
  "duplicate exclude returned STATE_CONFLICT",
  dup.error?.code === "STATE_CONFLICT",
  `got code=${dup.error?.code}`,
);

// --- 6. rescind flips was_active true ---
const rs1 = await call(rescindTool, {
  policy_event_id: predicateId,
  conversation_id: "conv_test",
  agent_role: "assistant",
});
check("rescind ok (first call)", rs1.ok === true, JSON.stringify(rs1));
check(
  "rescind.was_active true on first call",
  rs1.data?.was_active === true,
  `got was_active=${rs1.data?.was_active}`,
);
check(
  "rescind.policy_kind resolved to exclude",
  rs1.data?.policy_kind === "exclude",
);
check(
  "rescind.active_predicates_count present for exclude kind",
  typeof rs1.data?.active_predicates_count === "number",
);

// --- 7. AFTER RESCIND: get_predicate.active is false (the critical fix) ---
const gp2 = await call(getPredicateTool, { predicate_id: predicateId });
check("get_predicate ok after rescind", gp2.ok === true);
check(
  "get_predicate.active is FALSE after rescind (C1 fix)",
  gp2.data?.active === false,
  `got active=${gp2.data?.active}`,
);

// --- 8. AFTER RESCIND: list_predicates reflects dropped total_active ---
const lp2 = await call(listPredicatesTool, {});
check("list_predicates ok after rescind", lp2.ok === true);
check(
  "list_predicates excludes the rescinded predicate",
  Array.isArray(lp2.data?.predicates) &&
    !lp2.data.predicates.some((p) => p.predicate_id === predicateId),
);
check(
  "list_predicates.total_active dropped after rescind",
  lp2.data?.total_active === lp1.data.total_active - 1,
  `before=${lp1.data?.total_active} after=${lp2.data?.total_active}`,
);

// --- 9. rescind is idempotent ---
const rs2 = await call(rescindTool, {
  policy_event_id: predicateId,
  conversation_id: "conv_test",
  agent_role: "assistant",
});
check("rescind ok (second call)", rs2.ok === true);
check(
  "rescind.was_active false on second call (idempotent)",
  rs2.data?.was_active === false,
);

// --- 10. NOT_FOUND for unknown predicate ---
const rs3 = await call(rescindTool, {
  policy_event_id: "pred_does_not_exist",
  conversation_id: "conv_test",
  agent_role: "assistant",
});
check("rescind on unknown id returns error", rs3.ok === false);
check(
  "rescind on unknown id returns NOT_FOUND",
  rs3.error?.code === "NOT_FOUND",
  `got code=${rs3.error?.code}`,
);

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll predicate-lifecycle assertions passed.`);
