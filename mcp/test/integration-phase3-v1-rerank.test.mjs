// integration-phase3-v1-rerank.test.mjs — END-TO-END proof of the Phase 3 v1
// Layer-3 Gemini 2.5 Flash listwise reranker wired into the recall pipeline.
//
// Authoritative spec sources (read these for ANY change here):
//   kb/phase3-v1-rerank-contracts.md
//   kb/research-retrieval-frontiers.md
//   kb/phase3-v1-reranker-model.md
//
// Two scenarios (steps 1-7 happy path + step 8 negative path). Each prints
// PASS or FAIL with a diagnostic. The test process exits non-zero on any
// FAIL. The production tree (the live install) must be byte-identical pre/post
// (snapshot-comparison gate at the bottom).
//
// *** THIS SUITE REQUIRES LIVE LOCAL SERVERS — IT IS NOT HERMETIC ***
//   - the rerank server on http://127.0.0.1:8360  (local-embedder/rerank_server.py)
//   - the embed  server on http://127.0.0.1:8359  (local-embedder/embed_server.py)
// It is a DELIBERATE exception to the b4 test-side pin. Every other registered
// suite that reached Layer-3 was pinned LOCAL_RERANKER_ENABLED="0"; this one
// cannot be, because Step 8 must rerank NON-degraded in the SAME process that
// Step 9 then forces to fail. A process-wide OFF override would take Step 8's
// subject away. Step 9 therefore breaks BOTH backend base URLs by fetch
// injection instead of pinning the flag (see the b4 note at Step 9).
// CONSEQUENCE, carried openly: the registered gate is not hermetic with
// respect to :8360 — with the rerank daemon down, this suite fails for an
// environmental reason rather than a code defect. Re-derive the current
// dialing population any time with mcp/scripts/rerank-hermeticity-probe.mjs.
//
// HERMETICITY DISCIPLINE (standing C-NEW-2):
//   - mkdtempSync builds a fresh hermetic root BEFORE any dynamic import of
//     memory-system modules.
//   - MEMORY_ROOT / POLICY_BASE_DIR / STORAGE_BASE_DIR / LEDGERS_BASE_DIR
//     env vars set BEFORE the first dynamic import.
//   - GEMINI_API_KEY must already be in process.env (launchd-set or shell
//     export). If missing we fall back to the dotenv file named by
//     MEMORY_TEST_DOTENV, when that is set, as a developer convenience (NOT
//     production wiring). REQUIRE_FLASH_SMOKE=1
//     makes the missing-key case a hard fail (same pattern as
//     gemini-flash-client.test.mjs T2 post round-18 fix 3).

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { skipIfDaemonActive } from "./_hermetic-daemon-skip.mjs";
skipIfDaemonActive("integration-phase3-v1-rerank");

// ---------------------------------------------------------------------------
// 0. Hermetic root + env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-p3v1-e2e-"));
const HERMETIC_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(HERMETIC_ROOT, "policy");
const STORAGE_DIR = join(HERMETIC_ROOT, "storage");
const SOURCES_DIR = join(STORAGE_DIR, "sources");
// R34 CLOSE-3: removed the four QUEUE_* dir consts. The Phase 3 v1 rerank
// E2E never reads or writes them; the watermark daemon retired the queue
// tree in R32.1. Those mkdir entries were vestigial scaffolding that
// surfaced in spec-sweep as legacy_pattern_seen hits. The two scenarios
// below exercise promote-fact + recall + Layer-3 rerank directly and
// remain byte-identical in behavior.
const LEDGERS_DIR = join(HERMETIC_ROOT, "ledgers");
const HOOKS_DIR = join(HERMETIC_ROOT, "hooks");
const DAEMONS_DIR = join(HERMETIC_ROOT, "daemons");
const INDICES_DIR = join(HERMETIC_ROOT, "indices");
for (const d of [
  HERMETIC_ROOT,
  POLICY_DIR,
  STORAGE_DIR,
  SOURCES_DIR,
  LEDGERS_DIR,
  HOOKS_DIR,
  DAEMONS_DIR,
  INDICES_DIR,
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

process.env.MEMORY_ROOT = HERMETIC_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;
process.env.HOOKS_BASE_DIR = HOOKS_DIR;
process.env.DAEMONS_BASE_DIR = DAEMONS_DIR;
// R25: legacy integration test pre-dates the salience cascade. The fixture
// facts include semantically-close pairs that the chat-claude-code
// corroboration threshold (0.25) would fold into one row, breaking the
// "every promote produces a new fact row" assumption. Bypass is hermetic
// to this process; production never sets MEMORY_SALIENCE_BYPASS.
process.env.MEMORY_SALIENCE_BYPASS = "1";

// GEMINI_API_KEY: prefer env (launchd/shell). Dev-convenience fallback to the
// dotenv file named by MEMORY_TEST_DOTENV ONLY if env is empty (no fallback
// when that variable is unset). REQUIRE_FLASH_SMOKE=1 makes a
// missing key a HARD failure (this is an integration test — the real API is
// the load-bearing surface; silent skips defeat the gate).
if (!process.env.GEMINI_API_KEY) {
  const DEV_ENV = process.env.MEMORY_TEST_DOTENV;
  if (DEV_ENV && existsSync(DEV_ENV)) {
    const raw = readFileSync(DEV_ENV, "utf8");
    const m = raw.match(/^GEMINI_API_KEY=(.+)$/m);
    if (m) process.env.GEMINI_API_KEY = m[1].trim();
  }
}
const REQUIRE_FLASH_SMOKE = process.env.REQUIRE_FLASH_SMOKE === "1";
if (!process.env.GEMINI_API_KEY) {
  if (REQUIRE_FLASH_SMOKE) {
    console.error("");
    console.error("==============================================================");
    console.error("FAIL: GEMINI_API_KEY required (REQUIRE_FLASH_SMOKE=1)");
    console.error("integration-phase3-v1-rerank.test.mjs requires the real Flash");
    console.error("API. Set GEMINI_API_KEY in shell/launchd or unset");
    console.error("REQUIRE_FLASH_SMOKE for dev-machine skips.");
    console.error("==============================================================");
    process.exit(1);
  }
  console.log("");
  console.log("==============================================================");
  console.log("SKIPPING integration-phase3-v1-rerank.test.mjs:");
  console.log("  GEMINI_API_KEY not set. Set it (export GEMINI_API_KEY=...) to");
  console.log("  exercise the real Flash API. Set REQUIRE_FLASH_SMOKE=1 to");
  console.log("  make this skip a HARD failure.");
  console.log("==============================================================");
  console.log("");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Pre-test snapshot of production paths (the hermeticity-invariant gate).
// ---------------------------------------------------------------------------
const PROD_MEMORY_JSONL = join(homedir(), "memory-system", "ledgers", "memory.jsonl");
const PROD_RECALL_JSONL = join(homedir(), "memory-system", "ledgers", "recall.jsonl");
const PROD_INDICES_DIR = join(homedir(), "memory-system", "indices");
const PROD_SIGNING_KEY = join(homedir(), "memory-system", "policy", "distillation-signing-key.json");
function snap(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const PROD_BEFORE = {
  memory: snap(PROD_MEMORY_JSONL),
  recall: snap(PROD_RECALL_JSONL),
  indices: snap(PROD_INDICES_DIR),
  signing_key: snap(PROD_SIGNING_KEY),
};

// ---------------------------------------------------------------------------
// 2. Dynamic imports AFTER env is set.
// ---------------------------------------------------------------------------
const daemonTokenMod = await import("../lib/daemon-token.js");
const { canonicalJsonSha256Hex } = await import("../lib/validation.js");
const promoteFactMod = await import("../lib/tools/distill-promote-fact.js");
const recallMod = await import("../lib/tools/recall.js");
const indexCacheMod = await import("../lib/recall/index-cache.js");
const backfillMod = await import("../../scripts/backfill-embeddings.mjs");

// R37: this end-to-end rerank test makes >5 real embed calls inside a 60s
// window against a single live key (Steps 2-6 promote 5 facts; Steps 8-9
// run recalls that re-embed the query). The production-default RPM-tracker
// would block calls 6+ proactively. Disable the proactive filter for the
// duration of this test; the 60s cooldown on observed 429/403 remains
// active.
const geminiClientMod = await import("../lib/gemini-client.js");
if (typeof geminiClientMod._setRpmLimitForTests === "function") {
  geminiClientMod._setRpmLimitForTests(0);
}

// ---------------------------------------------------------------------------
// 3. Test framework.
// ---------------------------------------------------------------------------
let failures = 0;
const stepResults = [];
function recordStep(label, ok, diagnostic) {
  stepResults.push({ label, ok, diagnostic });
  if (ok) {
    console.log(`PASS  ${label}  ${diagnostic ? "-- " + diagnostic : ""}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}  -- ${diagnostic || "(no diagnostic)"}`);
  }
}

// Source-ledger fixture for the consent walk.
const SOURCE_NAME = "chat-claude-code";
const SOURCE_LEDGER_PATH = join(SOURCES_DIR, `${SOURCE_NAME}.jsonl`);
function ensureSourceRow(sourceMsgId) {
  const row =
    JSON.stringify({
      id: sourceMsgId,
      ts: "2026-06-02T00:00:00.000Z",
      source: SOURCE_NAME,
      source_msg_id: sourceMsgId,
      source_policy: { consent_basis: "first_party" },
      raw_content: { user_text: "test", assistant_text: "ack" },
    }) + "\n";
  if (!existsSync(SOURCE_LEDGER_PATH)) {
    writeFileSync(SOURCE_LEDGER_PATH, row, { mode: 0o600 });
  } else {
    const existing = readFileSync(SOURCE_LEDGER_PATH, "utf8");
    writeFileSync(SOURCE_LEDGER_PATH, existing + row, { mode: 0o600 });
  }
}

function buildPromoteArgs(content, sourceMsgId, signingKey) {
  ensureSourceRow(sourceMsgId);
  const sourceRefs = [{ source: SOURCE_NAME, source_msg_id: sourceMsgId }];
  const contentHash = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
  const sourceRefsHash = canonicalJsonSha256Hex(sourceRefs);
  const bindingObject = { content_hash: contentHash, source_refs_hash: sourceRefsHash };
  const bindingHash = canonicalJsonSha256Hex(bindingObject);
  const minted = daemonTokenMod.mintToken(
    bindingHash,
    "memory_distill_promote_fact",
    signingKey,
  );
  return {
    source_refs: sourceRefs,
    content,
    derived_from: [],
    provenance: {
      agent_id: "p3v1-e2e",
      conversation_id: "conv_p3v1_e2e",
      confidence: "medium",
    },
    confirmation_token: minted.token,
  };
}

function readMemoryJsonl() {
  const path = join(LEDGERS_DIR, "memory.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}
function readRecallJsonl() {
  const path = join(LEDGERS_DIR, "recall.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// STEP 1 — INITIALIZE
// ---------------------------------------------------------------------------
console.log("\n=== STEP 1: INITIALIZE ===");
let signingKey = null;
try {
  daemonTokenMod.initSigningKey();
  signingKey = daemonTokenMod.loadSigningKey().key;
  const dirsOk =
    existsSync(LEDGERS_DIR) &&
    existsSync(POLICY_DIR) &&
    existsSync(STORAGE_DIR) &&
    existsSync(INDICES_DIR);
  recordStep("Step 1 INITIALIZE", dirsOk, `dirs=${dirsOk}`);
} catch (e) {
  recordStep("Step 1 INITIALIZE", false, `exception: ${e && e.message}`);
}

// ---------------------------------------------------------------------------
// STEPS 2-6 — PROMOTE 5 FACTS
// ---------------------------------------------------------------------------
const FACTS = [
  { label: "Robin/Montreal", content: "the user's partner is Robin; they live in Montreal", msg: "msg_p3v1_fact1" },
  { label: "Robin=SWE",      content: "Robin works as a software engineer at a startup",     msg: "msg_p3v1_fact2" },
  { label: "cold-brew",      content: "the user prefers cold-brew coffee over espresso",     msg: "msg_p3v1_fact3" },
  { label: "brother",        content: "the user's brother lives in Portland",                msg: "msg_p3v1_fact4" },
  { label: "shellfish",      content: "the user is allergic to shellfish",                   msg: "msg_p3v1_fact5" },
];
const factIds = {};
for (let i = 0; i < FACTS.length; i++) {
  const f = FACTS[i];
  const stepNum = i + 2;
  console.log(`\n=== STEP ${stepNum}: PROMOTE FACT ${i + 1} (${f.label}) ===`);
  try {
    const args = buildPromoteArgs(f.content, f.msg, signingKey);
    const env = await promoteFactMod.TOOL.handler(args);
    if (!env || env.ok !== true) {
      recordStep(
        `Step ${stepNum} PROMOTE FACT ${i + 1}`,
        false,
        `non-ok envelope: ${JSON.stringify(env).slice(0, 300)}`,
      );
      continue;
    }
    const rows = readMemoryJsonl();
    const row = rows[rows.length - 1];
    factIds[f.label] = row && row.id;
    const ok = row && row.content === f.content;
    recordStep(
      `Step ${stepNum} PROMOTE FACT ${i + 1}`,
      ok,
      `id=${factIds[f.label]} label=${f.label}`,
    );
  } catch (e) {
    recordStep(`Step ${stepNum} PROMOTE FACT ${i + 1}`, false, `exception: ${e && e.message}`);
  }
}

// ---------------------------------------------------------------------------
// STEP 7 — BUILD INDICES (via backfill script)
// ---------------------------------------------------------------------------
console.log("\n=== STEP 7: BUILD INDICES (backfill) ===");
try {
  indexCacheMod._resetCaches();
  const logged = [];
  const logger = { log: (...a) => logged.push(a.join(" ")), warn: () => {} };
  const summary = await backfillMod.runBackfill({
    dryRun: false,
    sleepMs: 0,
    logger,
  });
  const bm25Path = join(INDICES_DIR, "gemini-embedding-001", "bm25.json");
  const hnswPath = join(INDICES_DIR, "gemini-embedding-001", "hnsw.bin");
  const hnswMeta = hnswPath + ".meta.json";
  const bm25Exists = existsSync(bm25Path);
  const hnswExists = existsSync(hnswPath) || existsSync(hnswMeta);
  const bm25Data = bm25Exists ? JSON.parse(readFileSync(bm25Path, "utf8")) : null;
  const bm25Docs = bm25Data && Array.isArray(bm25Data.doc_len) ? bm25Data.doc_len.length : 0;
  const ok =
    summary.fact_rows === FACTS.length &&
    summary.bm25_size === FACTS.length &&
    summary.hnsw_size === FACTS.length &&
    bm25Exists &&
    hnswExists &&
    bm25Docs === FACTS.length;
  recordStep(
    "Step 7 BUILD INDICES",
    ok,
    `fact_rows=${summary.fact_rows} bm25_size=${summary.bm25_size} hnsw_size=${summary.hnsw_size} bm25_docs=${bm25Docs}`,
  );
} catch (e) {
  recordStep("Step 7 BUILD INDICES", false, `exception: ${e && e.message}`);
}

// ---------------------------------------------------------------------------
// STEP 8 — RECALL (HAPPY PATH WITH FLASH LAYER 3)
// ---------------------------------------------------------------------------
console.log("\n=== STEP 8: RECALL HAPPY PATH (Flash Layer 3 active) ===");
let happyRerankScores = [];
let happyLatencyMs = -1;
let happyEntropy = -1;
let happyTopId = null;
let happyRobinIds = new Set([factIds["Robin/Montreal"], factIds["Robin=SWE"]]);
try {
  indexCacheMod._resetCaches();
  const env = await recallMod.TOOL.handler({
    surrounding_context: {
      current_query: "what does the user's partner do?",
      recent_turns: [{ role: "user", content: "tell me about Robin" }],
      agent_role: "default",
      time: "2026-06-02T12:00:00.000Z",
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: "conv_p3v1_e2e_recall",
    max_items: 12,
    max_chars: 4000,
  });
  if (!env || env.ok !== true) {
    recordStep("Step 8 RECALL HAPPY", false, `non-ok envelope: ${JSON.stringify(env).slice(0, 400)}`);
  } else {
    const mems = env.data.memories;
    happyTopId = mems.length > 0 ? mems[0].id : null;
    const briefNonEmpty = mems.length > 0;
    const topIsRobin = happyRobinIds.has(happyTopId);
    const degradedLayer3 = env.data.degraded_recall_layer3;
    happyLatencyMs = env.data.layer3_latency_ms;
    const inCount = env.data.rerank_input_count;
    const outCount = env.data.rerank_output_count;

    // Verify the recall event in ledger.
    const recallEvents = readRecallJsonl();
    const last = recallEvents[recallEvents.length - 1];
    const kindOk = last && last.kind === "recall";
    const rerankAttemptedLogged = last && last.rerank_attempted === true;
    const rerankFailedReasonNull = last && last.rerank_failed_reason === null;
    const layer3DegradedLogged = last && last.degraded_recall_layer3 === false;

    // Per-surfaced rerank_score numeric in [0,1] (approx; spec says "approximately").
    const surfacedRerankScores =
      last && Array.isArray(last.surfaced)
        ? last.surfaced.map((s) => s.rerank_score)
        : [];
    happyRerankScores = surfacedRerankScores.filter(
      (x) => typeof x === "number" && Number.isFinite(x),
    );
    const allSurfacedNumeric =
      surfacedRerankScores.length > 0 &&
      surfacedRerankScores.every(
        (x) => typeof x === "number" && Number.isFinite(x) && x >= -0.05 && x <= 1.05,
      );

    // candidates_pre_truncation: top-25 entries must have rerank_score populated,
    // positions 25..49 must be null (positions beyond 25 only exist if we had more
    // than 25 candidates; 5 facts means all are < 25, so ALL must be numeric).
    const cpt = (last && last.candidates_pre_truncation) || [];
    const cptRerankNumericForTop25 = cpt
      .slice(0, 25)
      .every((c) => typeof c.rerank_score === "number" && Number.isFinite(c.rerank_score));
    const cptRerankNullBeyond25 = cpt
      .slice(25)
      .every((c) => c.rerank_score === null);

    // Propensity sum ~= 1.0
    const surfacedPropSum =
      last && Array.isArray(last.surfaced)
        ? last.surfaced.reduce(
            (s, x) => s + (typeof x.propensity === "number" ? x.propensity : 0),
            0,
          )
        : 0;
    const propSumOk = Math.abs(surfacedPropSum - 1.0) < 0.05;

    // Entropy of propensity distribution (compute over recall-log surfaced[]).
    let entropy = 0;
    if (last && Array.isArray(last.surfaced)) {
      for (const s of last.surfaced) {
        const p = typeof s.propensity === "number" ? s.propensity : 0;
        if (p > 0) entropy -= p * Math.log(p);
      }
    }
    happyEntropy = entropy;
    const entropyNonTrivial = entropy > 0;

    const ok =
      briefNonEmpty &&
      topIsRobin &&
      degradedLayer3 === false &&
      typeof happyLatencyMs === "number" &&
      happyLatencyMs > 0 &&
      typeof inCount === "number" && inCount > 0 &&
      typeof outCount === "number" && outCount > 0 &&
      allSurfacedNumeric &&
      kindOk &&
      rerankAttemptedLogged &&
      rerankFailedReasonNull &&
      layer3DegradedLogged &&
      cptRerankNumericForTop25 &&
      cptRerankNullBeyond25 &&
      propSumOk &&
      entropyNonTrivial;
    recordStep(
      "Step 8 RECALL HAPPY",
      ok,
      `brief_len=${mems.length} top=${happyTopId} top_is_robin=${topIsRobin} ` +
        `degraded_layer3=${degradedLayer3} latency_ms=${happyLatencyMs} ` +
        `in=${inCount} out=${outCount} surfaced_all_numeric=${allSurfacedNumeric} ` +
        `cpt_top25_numeric=${cptRerankNumericForTop25} cpt_beyond25_null=${cptRerankNullBeyond25} ` +
        `prop_sum=${surfacedPropSum.toFixed(4)} entropy=${entropy.toFixed(4)}`,
    );
  }
} catch (e) {
  recordStep("Step 8 RECALL HAPPY", false, `exception: ${e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : String(e)}`);
}

// ---------------------------------------------------------------------------
// STEP 9 — NEGATIVE PATH (Layer-3 backend forced to fail; embed leg healthy)
// ---------------------------------------------------------------------------
// Monkeypatch global.fetch so that ONLY the Layer-3 RANKING call throws, while
// :embedContent calls still hit the real Gemini endpoint. This isolates the
// Layer-3 outage from the Layer-1 embed outage (covered by phase3-v0 Step 8).
//
// b4: the matcher must cover WHICHEVER backend rerank.js selects, not just the
// gemini one. It matched `:generateContent` alone, which is Flash-specific;
// once CAPS.LOCAL_RERANKER_ENABLED shipped TRUE the selected backend became
// local-reranker-client.js POSTing http://127.0.0.1:8360/rerank, the injection
// became a NO-OP, the live server answered for real, and this step observed
// degraded_layer3=false / all_surfaced_rerank_null=false and failed. A
// process-wide LOCAL_RERANKER_ENABLED=0 cannot fix it: Step 8 above needs the
// SAME process to rerank non-degraded. Breaking both backend URLs keeps the
// step asserting exactly what it always meant — a Layer-3 backend outage must
// degrade reorder-only — under either backend.
console.log("\n=== STEP 9: RECALL NEGATIVE PATH (Layer-3 backend forced to fail) ===");
let negTopId = null;
try {
  indexCacheMod._resetCaches();
  const realFetch = global.fetch;
  // Both Layer-3 backends: gemini Flash (:generateContent) and the local
  // Qwen3-Reranker (local-reranker-client.js _baseUrl(): env LOCAL_RERANKER_URL
  // or http://127.0.0.1:8360). The embed leg lives on a different base (:8359 /
  // :embedContent) and is deliberately left reachable.
  const localRerankBase = (
    process.env.LOCAL_RERANKER_URL || "http://127.0.0.1:8360"
  ).replace(/\/+$/, "");
  global.fetch = async (url, init) => {
    const u = typeof url === "string" ? url : (url && url.url) || "";
    if (u.includes(":generateContent") || u.startsWith(localRerankBase)) {
      throw new Error("simulated Layer-3 backend outage (p3v1 step 9)");
    }
    return realFetch(url, init);
  };
  let env;
  try {
    env = await recallMod.TOOL.handler({
      surrounding_context: {
        current_query: "what does the user's partner do?",
        recent_turns: [{ role: "user", content: "tell me about Robin" }],
        agent_role: "default",
        time: "2026-06-02T12:30:00.000Z",
        ambient: null,
        recent_recall_ids: [],
      },
      conversation_id: "conv_p3v1_e2e_negative",
      max_items: 12,
      max_chars: 4000,
    });
  } finally {
    global.fetch = realFetch;
  }
  if (!env || env.ok !== true) {
    recordStep("Step 9 RECALL NEGATIVE", false, `non-ok envelope: ${JSON.stringify(env).slice(0, 400)}`);
  } else {
    const mems = env.data.memories;
    negTopId = mems.length > 0 ? mems[0].id : null;
    const briefNonEmpty = mems.length > 0;
    const topIsRobin = happyRobinIds.has(negTopId);
    const degradedLayer3 = env.data.degraded_recall_layer3;
    // Layer-1 embed leg is NOT being failed in this step — only :generateContent
    // is intercepted — so degraded_recall (Layer 1) should remain false.
    const degradedRecall = env.data.degraded_recall;

    const recallEvents = readRecallJsonl();
    const last = recallEvents[recallEvents.length - 1];
    const failedReason = last && last.rerank_failed_reason;
    const rerankAttemptedLogged = last && last.rerank_attempted === true;
    const layer3DegradedLogged = last && last.degraded_recall_layer3 === true;

    // Per spec: rerank_score in surfaced items must be null on the degraded path.
    const surfacedRerankScores =
      last && Array.isArray(last.surfaced)
        ? last.surfaced.map((s) => s.rerank_score)
        : [];
    const allNull =
      surfacedRerankScores.length > 0 && surfacedRerankScores.every((x) => x === null);

    // The brief envelope's surfaced positions should ALSO show rerank_score=null
    // via the recall.jsonl record — already covered. The brief envelope itself
    // does not expose per-item rerank_score (it lives in surfaced[]); the brief
    // .memories[] shape is the legacy ABI surface.
    const reasonValid =
      typeof failedReason === "string" &&
      failedReason.length > 0 &&
      ["api_key_missing", "timeout", "network", "malformed_response",
       "all_ids_unmatched", "internal_error"].includes(failedReason) ||
      (typeof failedReason === "string" && failedReason.startsWith("http_"));

    const ok =
      briefNonEmpty &&
      topIsRobin &&
      degradedLayer3 === true &&
      degradedRecall === false &&
      allNull &&
      rerankAttemptedLogged &&
      layer3DegradedLogged &&
      reasonValid;
    recordStep(
      "Step 9 RECALL NEGATIVE",
      ok,
      `brief_len=${mems.length} top=${negTopId} top_is_robin=${topIsRobin} ` +
        `degraded_layer3=${degradedLayer3} degraded_recall=${degradedRecall} ` +
        `all_surfaced_rerank_null=${allNull} failed_reason=${failedReason} ` +
        `rerank_attempted=${rerankAttemptedLogged}`,
    );
  }
} catch (e) {
  recordStep("Step 9 RECALL NEGATIVE", false, `exception propagated: ${e && e.message}`);
}

// ---------------------------------------------------------------------------
// HERMETICITY GATE — production paths must be byte-identical.
// ---------------------------------------------------------------------------
const PROD_AFTER = {
  memory: snap(PROD_MEMORY_JSONL),
  recall: snap(PROD_RECALL_JSONL),
  indices: snap(PROD_INDICES_DIR),
  signing_key: snap(PROD_SIGNING_KEY),
};
const hermeticOk =
  PROD_BEFORE.memory === PROD_AFTER.memory &&
  PROD_BEFORE.recall === PROD_AFTER.recall &&
  PROD_BEFORE.indices === PROD_AFTER.indices &&
  PROD_BEFORE.signing_key === PROD_AFTER.signing_key;
if (hermeticOk) {
  console.log("PASS  Hermeticity -- production tree byte-identical");
} else {
  failures += 1;
  console.log(
    `FAIL  Hermeticity -- before=${JSON.stringify(PROD_BEFORE)} after=${JSON.stringify(PROD_AFTER)}`,
  );
}

// ---------------------------------------------------------------------------
// Cleanup + summary
// ---------------------------------------------------------------------------
try {
  rmSync(TMP_ROOT, { recursive: true, force: true });
} catch {
  // best-effort
}

console.log("\n=== SUMMARY ===");
for (const s of stepResults) {
  console.log(`${s.ok ? "PASS" : "FAIL"}  ${s.label}`);
}
if (happyRerankScores.length > 0) {
  const sorted = happyRerankScores.slice().sort((a, b) => a - b);
  const minS = sorted[0];
  const maxS = sorted[sorted.length - 1];
  const ordering = happyRerankScores.map((x) => x.toFixed(3)).join(" > ");
  console.log(`rerank_score distribution: min=${minS.toFixed(4)} max=${maxS.toFixed(4)} n=${happyRerankScores.length}`);
  console.log(`rerank_score ordering (surfaced): ${ordering}`);
}
if (happyLatencyMs >= 0) {
  console.log(`layer3_latency_ms (happy path) = ${happyLatencyMs}`);
}
if (happyEntropy >= 0) {
  console.log(`propensity entropy (happy path) = ${happyEntropy.toFixed(4)} (nats; >0 means non-trivial)`);
}
console.log(`\nintegration-phase3-v1-rerank.test.mjs: ${stepResults.length - failures} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
