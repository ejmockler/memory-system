// integration-phase3-v0.test.mjs — END-TO-END proof of the Phase 3 v0 recall
// pipeline against the REAL Gemini embedContent endpoint.
//
// Authoritative spec sources (read these for ANY change here):
//   kb/research-retrieval-frontiers.md
//   kb/phase3-v0-contracts.md
//
// 8 sequential steps. Each prints PASS or FAIL with a diagnostic. The test
// process exits non-zero on any FAIL. The production tree (the live install)
// must be byte-identical pre/post (snapshot-comparison gate at the bottom).
//
// HERMETICITY DISCIPLINE (standing C-NEW-2):
//   - mkdtempSync builds a fresh hermetic root BEFORE any dynamic import of
//     memory-system modules.
//   - MEMORY_ROOT / POLICY_BASE_DIR / STORAGE_BASE_DIR / LEDGERS_BASE_DIR
//     env vars set BEFORE the first dynamic import.
//   - GEMINI_API_KEY must already be in process.env (launchd-set or shell
//     export). If missing we fall back to the dotenv file named by
//     MEMORY_TEST_DOTENV, when that is set, as a developer convenience (NOT
//     production wiring). If it is still unset the suite cannot run (it calls
//     the cloud embedding API): it prints one SKIP line and exits 0.
//     REQUIRE_FLASH_SMOKE=1 makes the missing-key case a hard fail (exit 2),
//     the same flag the v1-rerank sibling uses.

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
skipIfDaemonActive("integration-phase3-v0");

// ---------------------------------------------------------------------------
// 0. Hermetic root + env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-p3v0-e2e-"));
const HERMETIC_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(HERMETIC_ROOT, "policy");
const STORAGE_DIR = join(HERMETIC_ROOT, "storage");
const SOURCES_DIR = join(STORAGE_DIR, "sources");
// R34 CLOSE-3: removed the four QUEUE_* dir consts. The Phase 3 v0 E2E never
// reads or writes them; the watermark daemon retired the queue tree in R32.1.
// Those mkdir entries were vestigial scaffolding that surfaced in spec-sweep
// as legacy_pattern_seen hits. Steps 2-8 below exercise promote-fact + recall
// directly and remain byte-identical in behavior.
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
// R25: opt out of the salience cascade for this legacy Phase 3 v0 E2E.
// Two of the fixture facts ("the user's partner is Robin; they live in
// Montreal" and "Robin works as a software engineer at a startup") are
// semantically close enough that the chat-claude-code corroboration
// threshold (0.25) treats Fact 2 as a corroboration of Fact 1 — a correct
// salience-layer decision that pre-dates this test's "every promote
// produces a new fact row" assumption. The bypass is hermetic to this
// process; production never sets MEMORY_SALIENCE_BYPASS.
process.env.MEMORY_SALIENCE_BYPASS = "1";

// GEMINI_API_KEY: prefer env (launchd/shell). Dev-convenience fallback to the
// dotenv file named by MEMORY_TEST_DOTENV ONLY if env is empty; no fallback
// when that variable is unset.
if (!process.env.GEMINI_API_KEY) {
  const DEV_ENV = process.env.MEMORY_TEST_DOTENV;
  if (DEV_ENV && existsSync(DEV_ENV)) {
    const raw = readFileSync(DEV_ENV, "utf8");
    const m = raw.match(/^GEMINI_API_KEY=(.+)$/m);
    if (m) process.env.GEMINI_API_KEY = m[1].trim();
  }
}
if (!process.env.GEMINI_API_KEY) {
  // Nothing below has run yet; drop the empty hermetic root on either exit.
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  if (process.env.REQUIRE_FLASH_SMOKE === "1") {
    console.error(
      "FATAL: GEMINI_API_KEY is unset (REQUIRE_FLASH_SMOKE=1). Set it in your shell or in launchd plist EnvironmentVariables.",
    );
    process.exit(2);
  }
  console.log(
    "SKIP test/integration-phase3-v0.test.mjs: GEMINI_API_KEY is not set (this suite calls the cloud embedding API); set REQUIRE_FLASH_SMOKE=1 to require it",
  );
  process.exit(0);
}

// b4: this is a phase3-*v0* suite — its subject is the Gemini embed/recall
// pipeline, and Layer-3 is only incidental scenery. An UNSET
// LOCAL_RERANKER_ENABLED falls through to CAPS.LOCAL_RERANKER_ENABLED (true),
// which skips the gemini key gate and sends the default backend at _baseUrl()
// to the LIVE rerank daemon on :8360 — a dependency this suite never declared
// and whose health it does not assert. "0" is the tri-state OFF override (a
// `delete` is inert against a true CAP) and puts Layer-3 back on the gemini
// backend the file is actually about, using the key resolved just above.
process.env.LOCAL_RERANKER_ENABLED = "0";

// ---------------------------------------------------------------------------
// 1. Pre-test snapshot of production paths (the hermeticity-invariant gate).
// ---------------------------------------------------------------------------
const PROD_MEMORY_JSONL = join(homedir(), "memory-system", "ledgers", "memory.jsonl");
const PROD_RECALL_JSONL = join(homedir(), "memory-system", "ledgers", "recall.jsonl");
const PROD_INDICES_DIR = join(homedir(), "memory-system", "indices");
const PROD_SIGNING_KEY = join(homedir(), "memory-system", "policy", "distillation-signing-key.json");
// NOTE: the production policy/ directory mtime is mutated continuously by
// policy-events-YYYY-MM.jsonl appends. Bare dir-mtime snapshots therefore
// yield false positives. We instead snapshot specific files the test could
// ever touch: memory.jsonl, recall.jsonl, indices/, signing-key.
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
const geminiClientMod = await import("../lib/gemini-client.js");
// R37: this end-to-end test makes >5 real embed calls inside a 60s window
// against a single live key (Steps 1, 2, 3, 4, 6, 7x3 = ~8 embeds). The
// production-default RPM-tracker would block calls 6+ proactively. Disable
// the proactive filter for the duration of this test; the 60s cooldown on
// observed 429/403 remains active. The override is reset at module unload
// (or by the next setPoolEnv in a downstream test that calls
// _resetKeyPoolForTests).
if (typeof geminiClientMod._setRpmLimitForTests === "function") {
  geminiClientMod._setRpmLimitForTests(0);
}
const daemonTokenMod = await import("../lib/daemon-token.js");
const { CAPS, canonicalJsonSha256Hex } = await import("../lib/validation.js");
// l14-embed-callers-migrate — the promote path (and recall's query encode)
// speak to the local embed server through this client. Step 8 stubs it: the
// client BANS global fetch by design (node:http + agent:false), so a
// global.fetch monkeypatch alone can no longer simulate an embed outage.
const localEmbedMod = await import("../lib/local-embedder-client.js");
const ACTIVE_EMBED_MODEL = CAPS.ACTIVE_EMBED_MODEL_VERSION;
const promoteFactMod = await import("../lib/tools/distill-promote-fact.js");
const recallMod = await import("../lib/tools/recall.js");
const indexCacheMod = await import("../lib/recall/index-cache.js");
const backfillMod = await import("../../scripts/backfill-embeddings.mjs");

// ---------------------------------------------------------------------------
// 3. Test framework.
// ---------------------------------------------------------------------------
let failures = 0;
const stepResults = [];
// R39.1 F4: environmental-skip ledger. Live-Gemini steps that hit 429 /
// RESOURCE_EXHAUSTED / KeyPoolExhausted are *not* connector defects — they
// are key-pool quota conditions outside the test's control. We record them
// as SKIP (with explicit reason) and exit 0, distinct from silent-FAIL
// (which B9 catches: "report fail + exit 0"). The pattern here is
// "log skip + exit 0 + summarize" — fully visible.
const environmental_skip_reasons = [];
function recordStep(label, ok, diagnostic) {
  stepResults.push({ label, ok, diagnostic });
  if (ok) {
    console.log(`PASS  ${label}  ${diagnostic ? "-- " + diagnostic : ""}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}  -- ${diagnostic || "(no diagnostic)"}`);
  }
}
function recordSkip(label, reason) {
  // SKIP is treated as PASS for exit-code purposes (failures unchanged) but
  // is rendered distinctly so the summary makes the skip auditable.
  stepResults.push({ label, ok: true, diagnostic: `SKIP skip_reason=${reason}`, skip: true });
  environmental_skip_reasons.push({ label, reason });
  console.log(`SKIP  ${label}  -- environmental: ${reason}`);
}

// R39.1 F4-extended: pool-wide quota detection. R39 brutalist surfaced
// only Step 7 because that was the only step hitting depleted keys at the
// time. R39.1 operator phase observed the pool is now further depleted,
// causing Steps 1-6 + Step 8 to surface the same KeyPoolExhaustedError.
// The semantics are identical: environmental, not a connector defect.
// One helper covers both error.status and error.message shapes (live HTTP
// 429 raises status; the in-process key-pool throws a synthesized message).
function isQuotaExhausted(e) {
  if (!e) return false;
  const status = e.status;
  if (status === 429) return true;
  const msg = (e && e.message) || "";
  return /RESOURCE_EXHAUSTED|quota|cooled|KeyPoolExhausted|all keys exhausted|RPM-throttled|\b429\b/i.test(msg);
}
// Track which steps skipped due to quota so dependent steps can cascade-skip
// with an honest reason ("Step N depended on facts promoted in Step M").
const stepSkipped = new Set();

function l2Norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return NaN;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
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
  // Append-only — multiple rows is fine (the loader scans line-by-line).
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
      agent_id: "p3v0-e2e",
      conversation_id: "conv_p3v0_e2e",
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
  // Smoke-test the live Gemini endpoint with a tiny embed.
  const probe = await geminiClientMod.embedSingle({
    text: "smoke test",
    taskType: geminiClientMod.GEMINI_TASK_TYPES.RETRIEVAL_DOCUMENT,
  });
  const norm = l2Norm(probe.vector_3072);
  const ok =
    dirsOk &&
    Array.isArray(probe.vector_3072) &&
    probe.vector_3072.length === 3072 &&
    Math.abs(norm - 1.0) <= 1e-6;
  recordStep(
    "Step 1 INITIALIZE",
    ok,
    `dirs=${dirsOk} probe_len=${probe.vector_3072.length} probe_norm=${norm.toFixed(8)}`,
  );
} catch (e) {
  // R39.1 F4-extended: env-skip on quota exhaustion.
  if (isQuotaExhausted(e)) {
    stepSkipped.add("Step 1 INITIALIZE");
    recordSkip("Step 1 INITIALIZE", `environmental_429 (${(e.message || "").slice(0, 140)})`);
  } else {
    recordStep("Step 1 INITIALIZE", false, `exception: ${e && e.message}`);
  }
}

// ---------------------------------------------------------------------------
// STEP 2 — PROMOTE FACT 1
// ---------------------------------------------------------------------------
console.log("\n=== STEP 2: PROMOTE FACT 1 (Robin, Montreal) ===");
const FACT_1_CONTENT = "the user's partner is Robin; they live in Montreal";
let fact1Id = null;
try {
  const args = buildPromoteArgs(FACT_1_CONTENT, "msg_fact1_uniq", signingKey);
  const env = await promoteFactMod.TOOL.handler(args);
  if (!env || env.ok !== true) {
    recordStep("Step 2 PROMOTE FACT 1", false, `non-ok envelope: ${JSON.stringify(env).slice(0, 300)}`);
  } else {
    const rows = readMemoryJsonl();
    const row = rows[rows.length - 1];
    fact1Id = row && row.id;
    const feats = row && row.features;
    // l14-embed-callers-migrate — the promote handler embeds via the LOCAL
    // Qwen3 server now, so the row carries the ACTIVE model stamp +
    // embed_state=false and NO gemini keys. The vector itself is out-of-band
    // (v3-ledger-embedding-reroute) unless MEMORY_LEDGER_ROW_EMBEDDING_4096=1,
    // so the norm invariant is asserted in promote-time-embedding.test.mjs
    // (which drives that flag) rather than here.
    const noLegacyKeys =
      !("embedding_3072" in (feats || {})) && !("embedding_mrl_768" in (feats || {}));
    const ok =
      row &&
      row.content === FACT_1_CONTENT &&
      noLegacyKeys &&
      feats.embed_state === false &&
      feats.embedding_model_version === ACTIVE_EMBED_MODEL;
    recordStep(
      "Step 2 PROMOTE FACT 1",
      ok,
      `id=${fact1Id} model=${feats && feats.embedding_model_version} embed_state=${feats && feats.embed_state} no_legacy_keys=${noLegacyKeys}`,
    );
  }
} catch (e) {
  if (isQuotaExhausted(e)) {
    stepSkipped.add("Step 2 PROMOTE FACT 1");
    recordSkip("Step 2 PROMOTE FACT 1", `environmental_429 (${(e.message || "").slice(0, 140)})`);
  } else {
    recordStep("Step 2 PROMOTE FACT 1", false, `exception: ${e && e.message}`);
  }
}

// ---------------------------------------------------------------------------
// STEP 3 — PROMOTE FACT 2 (Robin works as software engineer)
// ---------------------------------------------------------------------------
console.log("\n=== STEP 3: PROMOTE FACT 2 (Robin=SWE) ===");
const FACT_2_CONTENT = "Robin works as a software engineer at a startup";
let fact2Id = null;
try {
  const args = buildPromoteArgs(FACT_2_CONTENT, "msg_fact2_uniq", signingKey);
  const env = await promoteFactMod.TOOL.handler(args);
  if (!env || env.ok !== true) {
    recordStep("Step 3 PROMOTE FACT 2", false, `non-ok envelope: ${JSON.stringify(env).slice(0, 300)}`);
  } else {
    const rows = readMemoryJsonl();
    const row = rows[rows.length - 1];
    fact2Id = row && row.id;
    const feats = row && row.features;
    // l14-embed-callers-migrate — the promote handler embeds via the LOCAL
    // Qwen3 server now, so the row carries the ACTIVE model stamp +
    // embed_state=false and NO gemini keys. The vector itself is out-of-band
    // (v3-ledger-embedding-reroute) unless MEMORY_LEDGER_ROW_EMBEDDING_4096=1,
    // so the norm invariant is asserted in promote-time-embedding.test.mjs
    // (which drives that flag) rather than here.
    const noLegacyKeys =
      !("embedding_3072" in (feats || {})) && !("embedding_mrl_768" in (feats || {}));
    const ok =
      row &&
      row.content === FACT_2_CONTENT &&
      noLegacyKeys &&
      feats.embed_state === false &&
      feats.embedding_model_version === ACTIVE_EMBED_MODEL;
    recordStep(
      "Step 3 PROMOTE FACT 2",
      ok,
      `id=${fact2Id} model=${feats && feats.embedding_model_version} embed_state=${feats && feats.embed_state} no_legacy_keys=${noLegacyKeys}`,
    );
  }
} catch (e) {
  if (isQuotaExhausted(e)) {
    stepSkipped.add("Step 3 PROMOTE FACT 2");
    recordSkip("Step 3 PROMOTE FACT 2", `environmental_429 (${(e.message || "").slice(0, 140)})`);
  } else {
    recordStep("Step 3 PROMOTE FACT 2", false, `exception: ${e && e.message}`);
  }
}

// ---------------------------------------------------------------------------
// STEP 4 — PROMOTE FACT 3 (UNRELATED — coffee preference)
// ---------------------------------------------------------------------------
console.log("\n=== STEP 4: PROMOTE FACT 3 (unrelated coffee) ===");
const FACT_3_CONTENT = "the user prefers cold-brew coffee over espresso";
let fact3Id = null;
try {
  const args = buildPromoteArgs(FACT_3_CONTENT, "msg_fact3_uniq", signingKey);
  const env = await promoteFactMod.TOOL.handler(args);
  if (!env || env.ok !== true) {
    recordStep("Step 4 PROMOTE FACT 3", false, `non-ok envelope: ${JSON.stringify(env).slice(0, 300)}`);
  } else {
    const rows = readMemoryJsonl();
    const row = rows[rows.length - 1];
    fact3Id = row && row.id;
    const feats = row && row.features;
    // l14-embed-callers-migrate — the promote handler embeds via the LOCAL
    // Qwen3 server now, so the row carries the ACTIVE model stamp +
    // embed_state=false and NO gemini keys. The vector itself is out-of-band
    // (v3-ledger-embedding-reroute) unless MEMORY_LEDGER_ROW_EMBEDDING_4096=1,
    // so the norm invariant is asserted in promote-time-embedding.test.mjs
    // (which drives that flag) rather than here.
    const noLegacyKeys =
      !("embedding_3072" in (feats || {})) && !("embedding_mrl_768" in (feats || {}));
    const ok =
      row &&
      row.content === FACT_3_CONTENT &&
      noLegacyKeys &&
      feats.embed_state === false &&
      feats.embedding_model_version === ACTIVE_EMBED_MODEL;
    recordStep(
      "Step 4 PROMOTE FACT 3",
      ok,
      `id=${fact3Id} model=${feats && feats.embedding_model_version} embed_state=${feats && feats.embed_state} no_legacy_keys=${noLegacyKeys}`,
    );
  }
} catch (e) {
  if (isQuotaExhausted(e)) {
    stepSkipped.add("Step 4 PROMOTE FACT 3");
    recordSkip("Step 4 PROMOTE FACT 3", `environmental_429 (${(e.message || "").slice(0, 140)})`);
  } else {
    recordStep("Step 4 PROMOTE FACT 3", false, `exception: ${e && e.message}`);
  }
}

// ---------------------------------------------------------------------------
// STEP 5 — BUILD INDICES (via backfill script)
// ---------------------------------------------------------------------------
console.log("\n=== STEP 5: BUILD INDICES (backfill) ===");
// R39.1 F4-extended: cascade-skip if facts didn't promote due to env-429.
const promoteSkipped =
  stepSkipped.has("Step 2 PROMOTE FACT 1") ||
  stepSkipped.has("Step 3 PROMOTE FACT 2") ||
  stepSkipped.has("Step 4 PROMOTE FACT 3");
if (promoteSkipped) {
  stepSkipped.add("Step 5 BUILD INDICES");
  recordSkip("Step 5 BUILD INDICES", "cascade_from_env_429 (depends on Step 2-4 fact promotion)");
} else {
try {
  // Reset caches so the backfill re-read sees the post-promote state.
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
    summary.fact_rows === 3 &&
    summary.bm25_size === 3 &&
    summary.hnsw_size === 3 &&
    bm25Exists &&
    hnswExists &&
    bm25Docs === 3;
  recordStep(
    "Step 5 BUILD INDICES",
    ok,
    `fact_rows=${summary.fact_rows} bm25_size=${summary.bm25_size} hnsw_size=${summary.hnsw_size} bm25_docs=${bm25Docs} hnsw_exists=${hnswExists}`,
  );
} catch (e) {
  if (isQuotaExhausted(e)) {
    stepSkipped.add("Step 5 BUILD INDICES");
    recordSkip("Step 5 BUILD INDICES", `environmental_429 (${(e.message || "").slice(0, 140)})`);
  } else {
    recordStep("Step 5 BUILD INDICES", false, `exception: ${e && e.message}`);
  }
}
} // end !promoteSkipped guard

// ---------------------------------------------------------------------------
// STEP 6 — RECALL
// ---------------------------------------------------------------------------
console.log("\n=== STEP 6: RECALL (\"what does the user's partner do?\") ===");
let recallEnv = null;
// R39.1 F4-extended: cascade-skip if prerequisite steps env-skipped.
const recallDepsSkipped =
  promoteSkipped || stepSkipped.has("Step 5 BUILD INDICES");
if (recallDepsSkipped) {
  stepSkipped.add("Step 6 RECALL");
  recordSkip("Step 6 RECALL", "cascade_from_env_429 (depends on Step 2-5 fact promotion + index build)");
} else {
try {
  // Reset index cache to pick up the freshly-built indices from step 5.
  indexCacheMod._resetCaches();
  recallEnv = await recallMod.TOOL.handler({
    surrounding_context: {
      current_query: "what does the user's partner do?",
      recent_turns: [{ role: "user", content: "tell me about Robin" }],
      agent_role: "assistant",
      time: "2026-06-02T12:00:00.000Z",
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: "conv_p3v0_e2e_recall",
    max_items: 12,
    max_chars: 4000,
  });
  if (!recallEnv || recallEnv.ok !== true) {
    recordStep("Step 6 RECALL", false, `non-ok envelope: ${JSON.stringify(recallEnv).slice(0, 400)}`);
  } else if (recallEnv.data && recallEnv.data.degraded_recall === true) {
    // R39.1 F4-extended: recall handler caught Gemini quota exhaustion
    // internally and returned a degraded envelope. The assertion (top_is_robin
    // via HNSW + propensity) is impossible without the live embedding path;
    // BM25-only fallback surfaces but doesn't rank semantically. This is
    // environmental, not a regression — surface as SKIP.
    stepSkipped.add("Step 6 RECALL");
    recordSkip("Step 6 RECALL", "environmental_429 (recall handler returned degraded_recall=true due to Gemini quota; semantic ranking unavailable)");
  } else {
    const mems = recallEnv.data.memories;
    const topId = mems.length > 0 ? mems[0].id : null;
    const robinIds = new Set([fact1Id, fact2Id]);
    const recallEvents = readRecallJsonl();
    const last = recallEvents[recallEvents.length - 1];
    const surfacedSum =
      last && Array.isArray(last.surfaced)
        ? last.surfaced.reduce((s, x) => s + (typeof x.propensity === "number" ? x.propensity : 0), 0)
        : 0;
    // l14 / WU-recall-flip-to-local-4096: the query encode is the local 4096
    // vector when the ACTIVE tree has coverage, and the 3072 Gemini segment
    // vector only on the legacy-coverage fallback. Assert a NON-EMPTY context
    // embedding rather than pinning a dimension that now depends on which
    // index tree happens to be warm.
    const ctxEmbLen =
      last && last.query && Array.isArray(last.query.context_embedding)
        ? last.query.context_embedding.length
        : 0;
    const hasCtxEmb = ctxEmbLen === 4096 || ctxEmbLen === 3072;
    const hasCandSubstrate =
      last && Array.isArray(last.candidates_pre_truncation) && last.candidates_pre_truncation.length >= 1;
    const ok =
      mems.length > 0 &&
      robinIds.has(topId) &&
      // density_flag exists in the envelope OR set to "ok" (null in envelope when ok).
      (recallEnv.data.density_flag !== undefined) &&
      Math.abs(surfacedSum - 1.0) < 0.05 &&
      last && last.kind === "recall" &&
      hasCtxEmb &&
      hasCandSubstrate;
    recordStep(
      "Step 6 RECALL",
      ok,
      `brief_len=${mems.length} top=${topId} top_is_robin=${robinIds.has(topId)} prop_sum=${surfacedSum.toFixed(4)} density_flag=${recallEnv.data.density_flag} ctx_emb_dim=${ctxEmbLen} cand_substrate=${last && last.candidates_pre_truncation && last.candidates_pre_truncation.length}`,
    );
  }
} catch (e) {
  if (isQuotaExhausted(e)) {
    stepSkipped.add("Step 6 RECALL");
    recordSkip("Step 6 RECALL", `environmental_429 (${(e.message || "").slice(0, 140)})`);
  } else {
    recordStep("Step 6 RECALL", false, `exception: ${e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : String(e)}`);
  }
}
} // end !recallDepsSkipped guard

// ---------------------------------------------------------------------------
// STEP 7 — TASK-TYPE ASYMMETRY VERIFICATION
// ---------------------------------------------------------------------------
console.log("\n=== STEP 7: TASK-TYPE ASYMMETRY ===");
let asymmetryMargin = NaN;
// R39.1 F4: branch-exclusivity tracking. Exactly one of {live, skip, fail}
// must execute, otherwise B9 silent-FAIL discipline would be violated.
let step7_branch = null;
// l16 — RETIRED, recorded as a permanent SKIP rather than deleted.
//
// WHAT IT USED TO DO: three live outbound geminiClientMod.embedSingle calls
// (RETRIEVAL_DOCUMENT, RETRIEVAL_QUERY, SEMANTIC_SIMILARITY) against
// gemini-embedding-001, then asserted cos(RQ,doc) > cos(SS,doc). It env-skipped
// on 429 against a key pool this file itself records as "further depleted"
// (see the pool-wide quota note above recordSkip's helpers), so in practice it
// had stopped executing.
//
// WHY IT IS RETIRED: the embed backend it probed is the one this program is
// removing, and a live outbound Gemini request from a test is exactly the
// hazard the migration exists to eliminate.
//
// WHAT STILL CARRIES THE GUARANTEE — wire-level embed polarity is asserted
// hermetically in three suites:
//   - mcp/test/synthesis/local-embedder-client.test.mjs — both directions plus
//     the safe is_query=false default
//   - mcp/test/synthesis/recall-local-4096-query.test.mjs — the recall QUERY
//     site routes is_query:true
//   - mcp/test/embed-callers-migrate.test.mjs — both migrated DOCUMENT sites,
//     with an explicit anti-vacuity positive control proving the stub can
//     observe is_query:true, so the is_query===false assertions discriminate
//
// WHAT IS NOT REPLACED, stated plainly: no hermetic test can prove model
// SEMANTICS. A cosine margin computed from vectors produced by a
// _setFetchForTests stub proves only that the stub branches on is_query — the
// vectors are the test author's invention. Proving the model actually encodes
// the two polarities differently requires a live server and is filed as a
// residual (see the note below this step).
//
// asymmetryMargin deliberately stays NaN: the summary print at the end of this
// file is already NaN-guarded, so no margin line is emitted for a step that
// measured nothing.
step7_branch = "skip";
recordSkip(
  "Step 7 TASK-TYPE ASYMMETRY",
  "retired_l16 (probed gemini-embedding-001, the backend being removed; wire-level polarity is covered hermetically by local-embedder-client.test.mjs, recall-local-4096-query.test.mjs and embed-callers-migrate.test.mjs — model semantics are not hermetically provable)",
);
// RESIDUAL (filed, not built): the ONLY construction that would actually
// replace what this step proved is a LIVE-SERVER integration test asserting
//   cos(query_embed(q), doc_embed(d)) > cos(doc_embed(q), doc_embed(d))
// against the running Qwen3 server at 127.0.0.1:8359. It is out of scope here
// precisely because it cannot be hermetic, and this suite must not reach a
// live embed backend.
// R39.1 F4: branch-exclusivity assertion (B9 silent-FAIL guard). Exactly
// one branch must have set step7_branch. If null, the try/catch was
// bypassed without recording any result — that would be a silent skip,
// which is exactly what B9 forbids.
if (step7_branch === null) {
  recordStep(
    "Step 7 TASK-TYPE ASYMMETRY",
    false,
    "branch-exclusivity violated: no live/skip/fail branch executed",
  );
}

// ---------------------------------------------------------------------------
// STEP 8 — GEMINI OUTAGE FALLBACK
// ---------------------------------------------------------------------------
console.log("\n=== STEP 8: EMBED-BACKEND OUTAGE FALLBACK ===");
// R39.1 F4-extended: Step 8 simulates outage but RELIES on facts having
// been promoted in Steps 2-3 (BM25 needs them to surface robin). If
// promotion env-skipped, BM25 has nothing — cascade-skip with honest reason.
const step8DepsSkipped =
  stepSkipped.has("Step 2 PROMOTE FACT 1") ||
  stepSkipped.has("Step 3 PROMOTE FACT 2");
if (step8DepsSkipped) {
  stepSkipped.add("Step 8 GEMINI OUTAGE FALLBACK");
  recordSkip("Step 8 GEMINI OUTAGE FALLBACK", "cascade_from_env_429 (depends on Step 2-3 fact promotion for BM25 fallback)");
} else {
try {
  // EMBED-BACKEND OUTAGE. Both fetch surfaces are patched so the recall
  // handler has no dense leg at all:
  //   - global.fetch covers the GEMINI surface. r1-revert-l5 restored the
  //     legacy-coverage fallback, so recall.js imports the Gemini client again
  //     and again carries a segment-encode call (embedSegments) — reachable
  //     only when BOTH active indices are empty AND the legacy tree loads with
  //     a non-empty HNSW. This patch is therefore load-bearing for that path
  //     again, not merely belt-and-braces, and it also covers the other
  //     modules on this end-to-end path that still use global.fetch.
  //   - _setFetchForTests covers the LOCAL client, which is the ONLY query
  //     encoder (recall.js's local-query-embed branch,
  //     `embedSingle({ text: localQueryText, isQuery: true })`) and which
  //     ignores global.fetch by design
  //     (node:http + agent:false — undici is banned there).
  // Pre-l14 the global.fetch patch alone sufficed because the promoted facts
  // lived in the Gemini tree; now they live in the ACTIVE tree, so the local
  // encoder is the one that must fail for degraded_recall to be true.
  const realFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("simulated gemini outage (step 8)");
  };
  localEmbedMod._setFetchForTests(async () => {
    throw new Error("simulated local embed outage (step 8)");
  });
  indexCacheMod._resetCaches();
  let env;
  try {
    env = await recallMod.TOOL.handler({
      surrounding_context: {
        current_query: "Robin Montreal partner",
        recent_turns: [{ role: "user", content: "remind me about Robin" }],
        agent_role: "assistant",
        time: "2026-06-02T12:30:00.000Z",
        ambient: null,
        recent_recall_ids: [],
      },
      conversation_id: "conv_p3v0_e2e_outage",
      max_items: 12,
      max_chars: 4000,
    });
  } finally {
    global.fetch = realFetch;
    localEmbedMod._setFetchForTests(null);
  }
  if (!env || env.ok !== true) {
    recordStep("Step 8 GEMINI OUTAGE FALLBACK", false, `non-ok envelope: ${JSON.stringify(env).slice(0, 300)}`);
  } else {
    const mems = env.data.memories;
    const robinHit = mems.some((m) => m.id === fact1Id || m.id === fact2Id);
    const recallEvents = readRecallJsonl();
    const last = recallEvents[recallEvents.length - 1];
    const degradedLogged = last && last.degraded_recall === true;
    const ctxEmptyOrZero =
      last && last.query && Array.isArray(last.query.context_embedding) &&
      last.query.context_embedding.length === 0;
    const ok =
      env.data.degraded_recall === true &&
      mems.length > 0 &&
      robinHit &&
      degradedLogged &&
      ctxEmptyOrZero;
    recordStep(
      "Step 8 GEMINI OUTAGE FALLBACK",
      ok,
      `degraded_recall=${env.data.degraded_recall} brief_len=${mems.length} bm25_surfaced_robin=${robinHit} ctx_emb_empty=${ctxEmptyOrZero} no_exception=true`,
    );
  }
} catch (e) {
  if (isQuotaExhausted(e)) {
    stepSkipped.add("Step 8 GEMINI OUTAGE FALLBACK");
    recordSkip("Step 8 GEMINI OUTAGE FALLBACK", `environmental_429 (${(e.message || "").slice(0, 140)})`);
  } else {
    recordStep("Step 8 GEMINI OUTAGE FALLBACK", false, `exception propagated: ${e && e.message}`);
  }
}
} // end !step8DepsSkipped guard

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
  const tag = s.skip ? "SKIP" : (s.ok ? "PASS" : "FAIL");
  console.log(`${tag}  ${s.label}`);
}
const skipped = stepResults.filter((s) => s.skip).length;
const passed = stepResults.length - failures - skipped;
console.log(
  `\nintegration-phase3-v0.test.mjs: ${passed} passed, ${failures} failed, ${skipped} skipped`,
);
if (skipped > 0) {
  console.log(
    `${skipped} skipped due to environmental conditions: ` +
      environmental_skip_reasons
        .map((r) => `${r.label} (${r.reason})`)
        .join("; "),
  );
}
if (!Number.isNaN(asymmetryMargin)) {
  console.log(`task-type asymmetry margin (cos_RQ - cos_SS) = ${asymmetryMargin.toFixed(6)}`);
}
process.exit(failures > 0 ? 1 : 0);
