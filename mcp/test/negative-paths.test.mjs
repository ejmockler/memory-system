// Negative-path tests for the spec's central invariants. The lifecycle test
// covers the happy paths and one error case per tool; this file covers the
// system's THESIS invariants — the things the spec specifically promises and
// that a regression loosening validation would silently break.
//
// Run: node test/negative-paths.test.mjs
//
// HERMETICITY (standing C-NEW-2 pattern): redirect every memory-system path
// to a tmpdir BEFORE the dynamic import so the new Phase 3 v0 recall
// writes (ledgers/recall.jsonl) land in the tmp tree. Static imports are
// hoisted ahead of top-level statements; we MUST use dynamic
// `await import(...)` for env-override to take effect on config.js.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const TEST_ROOT = mkdtempSync(join(tmpdir(), "negative-paths-"));
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.TELEMETRY_BASE_DIR = join(TEST_ROOT, "telemetry");
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

const { executeTool } = await import("../lib/dispatch.js");

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- Helper: create a fresh recall_id for tests that need one ---
async function freshRecallId(query) {
  const r = await executeTool("memory_recall", {
    surrounding_context: {
      recent_turns: [{ role: "user", content: query }],
      agent_role: "assistant",
      current_query: query,
      time: "2026-05-31T08:30:00Z",
    },
    conversation_id: "conv_test_neg",
  });
  if (!r.ok) throw new Error(`recall failed: ${JSON.stringify(r)}`);
  return r.data.recall_id;
}

// --- 1. memory_exclude scope:"global" returns PRIVILEGE_REQUIRED ---
// Spec § memory_exclude: global scope is privileged in Phase 0 (token issuance
// ships in Phase 2). Verifies the spec's "deferred to Phase 2" claim is
// actually enforced in code.
{
  const recallId = await freshRecallId("test global block");
  const env = await executeTool("memory_exclude", {
    recall_id: recallId,
    predicate: {
      context_entities: ["x"],
      similarity_threshold: 0.5,
      scope: "global",
    },
    conversation_id: "conv_test_neg",
    agent_role: "assistant",
  });
  check("exclude scope:'global' returns error", env.ok === false);
  check(
    "exclude scope:'global' returns PRIVILEGE_REQUIRED (not PASS, not INVALID_ARGUMENTS)",
    env.error?.code === "PRIVILEGE_REQUIRED",
    `got code=${env.error?.code}`,
  );
}

// --- 2. memory_exclude with extra "context_embedding" field is REJECTED ---
// The spec's central integrity invariant (mcp-surface.md § memory_exclude):
// "a hand-crafted vector cannot reach the predicate store because there is
// no field to put it in." Enforced via additionalProperties:false +
// assertObjectShape. A regression loosening the shape check would let an
// agent inject an embedding directly, reopening the prior denial-of-recall
// attack surface. This test guards that.
{
  const recallId = await freshRecallId("test embedding injection");
  const env = await executeTool("memory_exclude", {
    recall_id: recallId,
    predicate: {
      context_entities: ["x"],
      similarity_threshold: 0.5,
      scope: { agent_role: "assistant" },
      context_embedding: new Array(384).fill(0.1),  // hand-crafted; MUST be rejected
    },
    conversation_id: "conv_test_neg",
    agent_role: "assistant",
  });
  check(
    "exclude with hand-crafted context_embedding is REJECTED (no-caller-embedding invariant)",
    env.ok === false,
    JSON.stringify(env),
  );
  check(
    "exclude rejection is INVALID_ARGUMENTS (additionalProperties:false in action)",
    env.error?.code === "INVALID_ARGUMENTS",
    `got code=${env.error?.code}`,
  );
}

// --- 3. memory_exclude with oversized context_entities (>32) rejected ---
{
  const recallId = await freshRecallId("test oversized entities");
  const entities = Array.from({ length: 50 }, (_, i) => `entity_${i}`);
  const env = await executeTool("memory_exclude", {
    recall_id: recallId,
    predicate: {
      context_entities: entities,
      similarity_threshold: 0.5,
      scope: { agent_role: "assistant" },
    },
    conversation_id: "conv_test_neg",
    agent_role: "assistant",
  });
  check("oversized context_entities rejected", env.ok === false);
  check(
    "oversized context_entities returns INVALID_ARGUMENTS",
    env.error?.code === "INVALID_ARGUMENTS",
    `got code=${env.error?.code}`,
  );
}

// --- 4. memory_recall with bad time (non-ISO-8601) is REJECTED ---
{
  const env = await executeTool("memory_recall", {
    surrounding_context: {
      recent_turns: [{ role: "user", content: "hi" }],
      agent_role: "assistant",
      current_query: "hi",
      time: "Jan 5 2026",  // not ISO-8601
    },
    conversation_id: "conv_test_neg",
  });
  check("recall with bad time rejected", env.ok === false);
  check(
    "recall with bad time returns INVALID_ARGUMENTS",
    env.error?.code === "INVALID_ARGUMENTS",
    `got code=${env.error?.code}`,
  );
}

// --- 5. memory_exclude with non-existent recall_id returns NOT_FOUND ---
{
  const env = await executeTool("memory_exclude", {
    recall_id: "rec_does_not_exist",
    predicate: {
      context_entities: ["x"],
      similarity_threshold: 0.5,
      scope: { agent_role: "assistant" },
    },
    conversation_id: "conv_test_neg",
    agent_role: "assistant",
  });
  check("exclude with bogus recall_id returns error", env.ok === false);
  check(
    "exclude with bogus recall_id returns NOT_FOUND",
    env.error?.code === "NOT_FOUND",
    `got code=${env.error?.code}`,
  );
}

// --- 6. CROSS-RECALL dedup: two distinct recall_ids with identical predicate
// body — current impl gates dedup on recall_id FIRST, so this should succeed
// (NOT dedupe). Documents Phase 0 dedup scope: per-recall, NOT cross-recall.
// Spec note added to mcp-surface.md § memory_exclude § STATE_CONFLICT clarifies. ---
{
  const r1 = await freshRecallId("cross-recall dedup probe — recall 1");
  const r2 = await freshRecallId("cross-recall dedup probe — recall 2");
  const baseInput = (recallId) => ({
    recall_id: recallId,
    predicate: {
      context_entities: ["topic_x"],
      similarity_threshold: 0.7,
      scope: { agent_role: "assistant" },
    },
    conversation_id: "conv_test_neg",
    agent_role: "assistant",
  });
  const e1 = await executeTool("memory_exclude", baseInput(r1));
  const e2 = await executeTool("memory_exclude", baseInput(r2));
  check("first cross-recall exclude succeeds", e1.ok === true, JSON.stringify(e1));
  check(
    "second cross-recall exclude with identical predicate body ALSO succeeds (per-recall dedup, not cross-recall)",
    e2.ok === true,
    `Phase 0 dedup is per-recall-id; cross-recall dedup is deferred. Got e2=${JSON.stringify(e2)}`,
  );
}

// --- 7. memory_health with extra field rejected (additionalProperties:false) ---
{
  const env = await executeTool("memory_health", { extra: "should be rejected" });
  check("health with extra field rejected", env.ok === false);
  check(
    "health rejection is INVALID_ARGUMENTS",
    env.error?.code === "INVALID_ARGUMENTS",
    `got code=${env.error?.code}`,
  );
}

// --- 8. RECALL_LOG_TTL_SECONDS is actually enforced ---
// Verifies the security control (anti-stockpiling). lookupRecall accepts a
// `now` argument for tests; we simulate the recall being older than the TTL
// and assert that memory_exclude can no longer bind to it.
{
  const { lookupRecall, recordRecall, _resetRecallLog } = await import("../lib/recall-log.js");
  const { CAPS } = await import("../lib/validation.js");
  const fakeRecallId = "rec_ttl_probe_" + Math.floor(Math.random() * 1e6);
  const loggedAt = "2026-05-31T00:00:00Z";
  const loggedAtMs = Date.parse(loggedAt);
  recordRecall(fakeRecallId, {
    query: {
      context_embedding: new Array(384).fill(0),
      embedding_model_version: "stub-0.0.1",
      surrounding_context_hash: "deadbeef",
    },
    logged_at: loggedAt,
  });
  // Within TTL: lookup succeeds.
  const insideTtl = lookupRecall(fakeRecallId, loggedAtMs + 1000);
  check("lookupRecall returns entry within TTL", insideTtl != null);
  // Just past TTL: lookup returns null.
  const justPastTtl = lookupRecall(fakeRecallId, loggedAtMs + (CAPS.RECALL_LOG_TTL_SECONDS + 1) * 1000);
  check(
    "lookupRecall returns null just past RECALL_LOG_TTL_SECONDS",
    justPastTtl === null,
    `got ${JSON.stringify(justPastTtl)}`,
  );
  // Way past TTL: also null.
  const wayPastTtl = lookupRecall(fakeRecallId, loggedAtMs + 30 * 86400 * 1000);
  check("lookupRecall returns null far past TTL", wayPastTtl === null);
  // Cleanup so this test doesn't leak state to others.
  _resetRecallLog();
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll negative-path assertions passed.`);
