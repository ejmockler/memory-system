// put.test.mjs — WORKUNIT N8 — memory_put operator-authored direct write.
//
// Proves the named properties from the N8 spec TESTS section (>=12 assertions):
//   1.  Registration — memory_put is routed (not NOT_FOUND); toolCount==prior+1.
//   2.  Gate OFF — SCOPE_BLOCKED with ledger + policy bytes unchanged, proven
//       two ways: (i) explicit opt-out MEMORY_PUT_ENABLED=0 on an empty root;
//       (ii) flag unset on a root whose active HNSW holds a vector (a
//       configured install stays dark by default).
//   2F. First run — flag unset + empty root (no vector index, no queryd) =>
//       put ok, the row is in the ACTIVE BM25, the HNSW is untouched, and
//       memory_recall serves it lexical-only, marked degraded
//       (dense_leg_unservable).
//   2F-d. Still first run after the install publishes its OWN generation — a
//       real manifest plus an empty hnsw.bin on disk, caches dropped (a
//       restart): flag unset => a second put is ok and lexically indexed.
//   2(iii). Configured root, damaged on disk — a published generation holding
//       a vector whose manifest is truncated to invalid JSON: flag unset =>
//       SCOPE_BLOCKED; ledger, policy log and index-wal.jsonl byte-identical.
//   2(iv). Same published generation with hnsw.bin truncated (corrupt member,
//       intact manifest): flag unset => SCOPE_BLOCKED; same three byte
//       snapshots identical. Neither case loads the index before the put.
//   3.  Gate ON happy path — valid put => ok with non-null memory_event_id +
//       promoted_at.
//   4.  Append-only / thesis #1 — prior ledger lines byte-identical; exactly one
//       new line appended.
//   5.  Consent stamp — appended row's source_refs[].consent_basis=="first_party".
//   6.  Synthesis cascade fires — features.entities present, features.time_anchors
//       carries the stamped_by:"cascade:row-ts" structural anchor, episodicity in
//       [0,1].
//   7.  Embed-outage non-blocking — v0 default omits inline embed; row lands with
//       embedding_4096=null + embed_state=true and the put still returns ok.
//   8.  Audit event — exactly one policy.memory.put on success; zero on the
//       gate-blocked path.
//   9.  Payload validation — empty content / over-cap content / unknown top-level
//       key => INVALID_ARGUMENTS.
//   10. No daemon token required — put succeeds WITHOUT a confirmation_token.
//   11. Dedupe boundary — two identical puts produce two distinct
//       memory_event_ids (v0 has no operator-put dedupe; explicit contract).
//   12. Get-visible / recallable — the minted id + content + first_party consent
//       are present on a row readable straight out of the ledger.
//
// HERMETICITY: env vars set BEFORE the dynamic import of the tool modules.
// All disk writes redirect into mkdtempSync. Production memory.jsonl +
// policy-events MUST NOT change across this run.
//
// Run: node test/tools/put.test.mjs   (exits 0 on pass, non-zero on failure)

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  existsSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Hermetic root setup — MUST happen before any dynamic import.
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "memsys-put-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage", "sources"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.TELEMETRY_BASE_DIR = join(TEST_ROOT, "telemetry");
// The put gate's first-run rule depends on the queryd mode and on the active
// vector index, so pin both ends of that decision: never probe for (or talk to)
// a query daemon, never reach a real embedder (dead port => the recall query
// embed degrades), no BM25 rollout flag, and no mid-test index flush.
process.env.MEMORY_QUERYD = "off";
process.env.LOCAL_EMBED_URL = "http://127.0.0.1:1";
process.env.INDEX_SAVE_MAX_STALENESS_MS = "600000";
delete process.env.MEMORY_BM25_DECOUPLE_EMBED;
delete process.env.GEMINI_API_KEY;
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

const LEDGER_PATH = join(TEST_ROOT, "ledgers", "memory.jsonl");
const POLICY_DIR = join(TEST_ROOT, "policy");

// Production-safety pre-snapshot: capture mtime+size of the real memory.jsonl
// so we can re-stat at exit and fail loudly if the test accidentally wrote to
// production.
const PROD_LEDGER = join(homedir(), "memory-system", "ledgers", "memory.jsonl");
let prodBefore = null;
try { const st = statSync(PROD_LEDGER); prodBefore = { mtimeMs: st.mtimeMs, size: st.size }; } catch {}
process.on("exit", () => {
  if (prodBefore == null) return;
  try {
    const st = statSync(PROD_LEDGER);
    if (st.mtimeMs !== prodBefore.mtimeMs || st.size !== prodBefore.size) {
      console.error("FATAL: production memory.jsonl changed during put test");
      process.exitCode = 2;
    }
  } catch {}
});

// ---------------------------------------------------------------------------
// Imports (after env redirect).
// ---------------------------------------------------------------------------
const { executeTool, toolCount, listTools } = await import("../../lib/dispatch.js");
const { ERROR_CODES } = await import("../../lib/error-codes.js");
const { loadIndices, saveIndices, flushIndicesNow, _resetCaches } = await import(
  "../../lib/recall/index-cache.js"
);
const { CAPS } = await import("../../lib/validation.js");
const activeIndices = () => loadIndices(CAPS.ACTIVE_EMBED_MODEL_VERSION);
const ACTIVE_INDEX_DIR = join(TEST_ROOT, "indices", CAPS.ACTIVE_EMBED_MODEL_VERSION);
const MANIFEST_PATH = join(ACTIVE_INDEX_DIR, "index-manifest.json");
const HNSW_BIN_PATH = join(ACTIVE_INDEX_DIR, "hnsw.bin");
const INDEX_WAL_PATH = join(ACTIVE_INDEX_DIR, "index-wal.jsonl");

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
function ledgerLines() {
  if (!existsSync(LEDGER_PATH)) return [];
  const raw = readFileSync(LEDGER_PATH, "utf8");
  return raw.split("\n").filter((l) => l.trim() !== "");
}
function ledgerBytes() {
  if (!existsSync(LEDGER_PATH)) return Buffer.alloc(0);
  return readFileSync(LEDGER_PATH);
}
function lineHashes() {
  return ledgerLines().map((l) =>
    createHash("sha256").update(Buffer.from(l, "utf8")).digest("hex"),
  );
}
function policyEventsBytesTotal() {
  let total = 0;
  let names = [];
  try { names = readdirSync(POLICY_DIR); } catch { return 0; }
  for (const n of names) {
    if (n.startsWith("policy-events-") && n.endsWith(".jsonl")) {
      try { total += statSync(join(POLICY_DIR, n)).size; } catch {}
    }
  }
  return total;
}
// Byte snapshot of everything a blocked put must leave untouched: the memory
// ledger, every file in the policy dir, and the active model's index WAL.
// Reads files only — it never loads an index. Compared with assert.deepEqual.
function writeSurfaceSnapshot() {
  const policy = {};
  let names = [];
  try { names = readdirSync(POLICY_DIR).sort(); } catch {}
  for (const n of names) {
    const full = join(POLICY_DIR, n);
    if (statSync(full).isFile()) policy[n] = readFileSync(full);
  }
  return {
    ledger: ledgerBytes(),
    policy,
    wal: existsSync(INDEX_WAL_PATH) ? readFileSync(INDEX_WAL_PATH) : null,
  };
}
function policyEvents() {
  const out = [];
  let names = [];
  try { names = readdirSync(POLICY_DIR); } catch { return out; }
  for (const n of names) {
    if (!n.startsWith("policy-events-") || !n.endsWith(".jsonl")) continue;
    const raw = readFileSync(join(POLICY_DIR, n), "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  }
  return out;
}
function lastFactRow() {
  const lines = ledgerLines();
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(lines[i]);
      if (row && row.kind === "fact") return row;
    } catch {}
  }
  return null;
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    process.stdout.write(`PASS  ${name}\n`);
  } catch (e) {
    failures++;
    process.stdout.write(`FAIL  ${name}\n      ${e && e.message ? e.message : e}\n`);
  }
}

// content with a structural entity (GitHub URL) so the entity extractor over
// the "manual" source scope yields >=1 entity.
const PUT_CONTENT =
  "Operator note: the example project lives at https://github.com/example-org/example-project and ships Phase 1.";

// ===========================================================================
// 1. Registration + toolCount.
// ===========================================================================
check("1: memory_put registered; toolCount==14; listTools includes it", () => {
  // The 14th dispatch tool is memory_catchup_feedback (messaging/feedback-log.js).
  assert.equal(toolCount(), 14, "toolCount should include memory_catchup_feedback");
  const names = listTools().map((t) => t.name);
  assert.ok(names.includes("memory_put"), "listTools must include memory_put");
  const t = listTools().find((x) => x.name === "memory_put");
  assert.ok(t.description && t.description.length > 0, "non-empty description");
  assert.equal(t.inputSchema.type, "object", "valid inputSchema");
  assert.equal(t.inputSchema.additionalProperties, false, "strict schema");
});

// ===========================================================================
// 2 + 8(gate side). Gate OFF => SCOPE_BLOCKED, zero writes. Shared assertion
// body for the two ways the gate is dark.
// ===========================================================================
async function assertDarkPut(label) {
  const ledgerBefore = ledgerBytes();
  const policyBefore = policyEventsBytesTotal();
  const putsBefore = policyEvents().filter((e) => e.kind === "policy.memory.put").length;
  const bm25Before = activeIndices().bm25.size();
  // An INVALID payload on purpose (unknown top-level key): the gate must fire
  // BEFORE payload validation, so the answer is SCOPE_BLOCKED, never
  // INVALID_ARGUMENTS (R2 ordering).
  const res = await executeTool("memory_put", {
    content: PUT_CONTENT,
    provenance: { confidence: "high" },
    bogus_top_level_key: true,
  });
  check(`2${label}: returns SCOPE_BLOCKED (not NOT_FOUND, not INVALID_ARGUMENTS)`, () => {
    assert.equal(res.ok, false, "blocked put must not be ok");
    assert.equal(res.error.code, ERROR_CODES.SCOPE_BLOCKED, "SCOPE_BLOCKED");
    assert.notEqual(res.error.code, ERROR_CODES.NOT_FOUND, "routed, not NOT_FOUND");
  });
  check(`2b${label}: ledger + policy bytes unchanged, no BM25 add`, () => {
    assert.deepEqual(ledgerBytes(), ledgerBefore, "ledger bytes unchanged");
    assert.equal(policyEventsBytesTotal(), policyBefore, "policy bytes unchanged");
    const putsAfter = policyEvents().filter((e) => e.kind === "policy.memory.put").length;
    assert.equal(putsAfter, putsBefore, "no policy.memory.put on blocked path");
    assert.equal(activeIndices().bm25.size(), bm25Before, "no BM25 entry on blocked path");
  });
}

// (i) Explicit opt-out on an EMPTY root: MEMORY_PUT_ENABLED=0 wins over the
// first-run rule that would otherwise turn the put on here.
await (async () => {
  process.env.MEMORY_PUT_ENABLED = "0";
  check("2(i) precondition: empty root — active HNSW and BM25 are empty", () => {
    assert.equal(activeIndices().hnsw.size(), 0, "no vector index yet");
    assert.equal(activeIndices().bm25.size(), 0, "no lexical index yet");
  });
  await assertDarkPut("(i) MEMORY_PUT_ENABLED=0 on an empty root");
  process.env.MEMORY_PUT_ENABLED = "false";
  await assertDarkPut("(i') MEMORY_PUT_ENABLED=false on an empty root");
})();

// ===========================================================================
// 2F. First run: flag UNSET + empty root (no queryd, no vector index, no
// embedder) => the put works, is lexically indexed at write time, and recall
// serves it lexical-only and says so.
// ===========================================================================
const FIRST_RUN_CONTENT =
  "First run note: the synthetic codeword is quillwort-ferrite-harbor.";
await (async () => {
  delete process.env.MEMORY_PUT_ENABLED;
  const hnswBefore = activeIndices().hnsw.size();
  const bm25Before = activeIndices().bm25.size();
  const legacyBm25Before = loadIndices(CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT).bm25.size();
  const putsBefore = policyEvents().filter((e) => e.kind === "policy.memory.put").length;

  const res = await executeTool("memory_put", {
    content: FIRST_RUN_CONTENT,
    provenance: { agent_id: "first-run-test", conversation_id: "first-run-conv" },
  });
  check("2F-a: flag unset + empty root => put ok", () => {
    assert.equal(res.ok, true, "first-run put should succeed: " + JSON.stringify(res.error));
    assert.ok(res.data.memory_event_id.startsWith("mem_"), "id is a mem_ id");
    const row = lastFactRow();
    assert.equal(row.id, res.data.memory_event_id, "row landed in the ledger");
    assert.equal(row.source_refs[0].consent_basis, "first_party", "still first_party");
    assert.equal(row.features.embedding_4096, null, "no vector was minted");
    const putsAfter = policyEvents().filter((e) => e.kind === "policy.memory.put").length;
    assert.equal(putsAfter, putsBefore + 1, "exactly one policy.memory.put");
  });
  check("2F-b: the put is in the ACTIVE BM25; HNSW size unchanged; legacy tree untouched", () => {
    const { bm25, hnsw } = activeIndices();
    assert.equal(bm25.size(), bm25Before + 1, "one BM25 document added");
    assert.ok(
      bm25.search("quillwort", 10).some((r) => r.memory_id === res.data.memory_event_id),
      "BM25 finds the put by its content",
    );
    assert.equal(hnsw.size(), hnswBefore, "no vector added");
    assert.equal(hnsw.size(), 0, "vector index still empty");
    assert.equal(
      loadIndices(CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT).bm25.size(),
      legacyBm25Before,
      "never lands in the legacy model tree",
    );
  });

  const recall = await executeTool("memory_recall", {
    conversation_id: "first-run-conv",
    surrounding_context: {
      recent_turns: [],
      agent_role: "assistant",
      current_query: "What is the synthetic codeword? quillwort-ferrite-harbor",
      time: new Date().toISOString(),
    },
  });
  check("2F-c: memory_recall returns the put, marked degraded (dense_leg_unservable)", () => {
    assert.equal(recall.ok, true, "recall ok: " + JSON.stringify(recall.error));
    const memories = recall.data.memories;
    assert.ok(Array.isArray(memories) && memories.length >= 1, "at least one memory surfaced");
    assert.ok(
      JSON.stringify(memories).includes(FIRST_RUN_CONTENT),
      "the surfaced memory carries the put content",
    );
    assert.equal(recall.data.degraded_recall, true, "lexical-only recall is reported degraded");
    assert.equal(recall.data.degraded_reason, "dense_leg_unservable", "names the reason");
  });
})();

// ===========================================================================
// 2F-d. The first index flush publishes the install's OWN generation: a real
// manifest plus an empty hnsw.bin. That shape — and a restart on top of it —
// is still a first run, so the next put works with no configuration.
// ===========================================================================
await (async () => {
  delete process.env.MEMORY_PUT_ENABLED;
  const flushed = flushIndicesNow(CAPS.ACTIVE_EMBED_MODEL_VERSION);
  check("2F-d precondition: the flush published a manifest + an empty hnsw.bin", () => {
    assert.equal(flushed, true, "the pending first-run batch was flushed");
    assert.ok(existsSync(MANIFEST_PATH), "index-manifest.json exists on disk");
    assert.ok(existsSync(HNSW_BIN_PATH), "hnsw.bin exists on disk");
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    assert.ok(manifest.members.hnsw, "the manifest binds an hnsw member");
    assert.equal(statSync(HNSW_BIN_PATH).size, manifest.members.hnsw.size, "member intact");
  });
  // Drop every in-process cache: the gate must decide from disk, as a
  // restarted server would.
  _resetCaches();
  const putsBefore = policyEvents().filter((e) => e.kind === "policy.memory.put").length;
  const linesBefore = ledgerLines().length;
  const SECOND_CONTENT =
    "Second first-run note: the synthetic codeword is marlstone-juniper-ratchet.";
  const res = await executeTool("memory_put", {
    content: SECOND_CONTENT,
    provenance: { agent_id: "first-run-test", conversation_id: "first-run-conv" },
  });
  check("2F-d: flag unset + self-published empty-HNSW generation => put still ok, in the ACTIVE BM25", () => {
    assert.equal(res.ok, true, "second first-run put should succeed: " + JSON.stringify(res.error));
    assert.equal(ledgerLines().length, linesBefore + 1, "exactly one new ledger line");
    assert.equal(lastFactRow().id, res.data.memory_event_id, "row landed in the ledger");
    const putsAfter = policyEvents().filter((e) => e.kind === "policy.memory.put").length;
    assert.equal(putsAfter, putsBefore + 1, "exactly one policy.memory.put");
    const { bm25, hnsw, generation_refused } = activeIndices();
    assert.equal(generation_refused, null, "the published generation loads clean");
    assert.equal(hnsw.size(), 0, "vector index still empty");
    assert.ok(
      bm25.search("marlstone", 10).some((r) => r.memory_id === res.data.memory_event_id),
      "BM25 finds the second put by its content",
    );
    assert.ok(
      bm25.search("quillwort", 10).length >= 1,
      "the first put survived the flush + cache drop",
    );
  });
})();

// (ii) Flag unset on a CONFIGURED root: once the active HNSW holds a vector the
// first-run rule no longer applies and the put is dark again. The vector is
// seeded straight into the loadIndices cache (the object the gate reads).
await (async () => {
  delete process.env.MEMORY_PUT_ENABLED;
  const seed = new Array(CAPS.EMBEDDING_DIM_4096).fill(0);
  seed[0] = 1;
  activeIndices().hnsw.add("mem_put_test_seed_vector", seed);
  check("2(ii) precondition: active HNSW is non-empty", () => {
    assert.equal(activeIndices().hnsw.size(), 1, "one seeded vector");
  });
  await assertDarkPut("(ii) flag unset + non-empty active HNSW");
})();

// ===========================================================================
// 2(iii) + 2(iv). Configured root whose ON-DISK index is damaged. loadIndices
// does not throw for these: it serves EMPTY indices and reports the fault in
// generation_refused, so a gate that only asked "is the loaded HNSW empty?"
// would open the put. Publish a real generation holding the seeded vector,
// damage one artefact, drop the caches, and put WITHOUT loading the index
// first: the answer must be SCOPE_BLOCKED with zero bytes written to the
// ledger, the policy log and the index WAL.
// ===========================================================================
async function assertDarkPutOnDamagedTree(label) {
  _resetCaches();
  const before = writeSurfaceSnapshot();
  // A VALID payload on purpose: nothing but the gate stands between this call
  // and a ledger append.
  const res = await executeTool("memory_put", {
    content: "Damaged-index probe: the synthetic codeword is tamarack-oxide-lantern.",
    provenance: { agent_id: "damaged-index-test", conversation_id: "damaged-index-conv" },
  });
  const after = writeSurfaceSnapshot();
  check(`2${label}: returns SCOPE_BLOCKED`, () => {
    assert.equal(res.ok, false, "put on a damaged index tree must not be ok");
    assert.equal(res.error.code, ERROR_CODES.SCOPE_BLOCKED, "SCOPE_BLOCKED");
  });
  check(`2${label}: ledger, policy log and index-wal.jsonl byte-identical`, () => {
    assert.deepEqual(after.ledger, before.ledger, "ledger bytes unchanged");
    assert.deepEqual(after.policy, before.policy, "policy files byte-identical");
    assert.ok(before.wal != null, "the index WAL exists before the put");
    assert.deepEqual(after.wal, before.wal, "index-wal.jsonl bytes unchanged");
  });
}
await (async () => {
  delete process.env.MEMORY_PUT_ENABLED;
  saveIndices(CAPS.ACTIVE_EMBED_MODEL_VERSION, activeIndices());
  const manifestBytes = readFileSync(MANIFEST_PATH);
  const hnswBytes = readFileSync(HNSW_BIN_PATH);
  check("2(iii)/(iv) precondition: a real generation holding the seeded vector is on disk", () => {
    assert.ok(existsSync(MANIFEST_PATH), "index-manifest.json exists");
    assert.ok(existsSync(HNSW_BIN_PATH), "hnsw.bin exists");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    assert.equal(manifest.members.hnsw.size, hnswBytes.length, "manifest binds hnsw.bin");
    assert.ok(hnswBytes.length > 4096, "hnsw.bin holds a vector, not an empty graph");
    assert.equal(activeIndices().hnsw.size(), 1, "the published index holds the seed vector");
  });

  // (iii) manifest truncated to a prefix that is invalid JSON.
  const truncatedManifest = manifestBytes.subarray(0, Math.floor(manifestBytes.length / 2));
  check("2(iii) precondition: the truncated manifest is invalid JSON", () => {
    assert.throws(() => JSON.parse(truncatedManifest.toString("utf8")));
  });
  writeFileSync(MANIFEST_PATH, truncatedManifest);
  try {
    await assertDarkPutOnDamagedTree("(iii) flag unset + manifest truncated to invalid JSON");
  } finally {
    writeFileSync(MANIFEST_PATH, manifestBytes);
  }

  // (iv) hnsw.bin truncated to half its size under an intact manifest.
  truncateSync(HNSW_BIN_PATH, Math.floor(hnswBytes.length / 2));
  try {
    check("2(iv) precondition: hnsw.bin is shorter than the manifest records", () => {
      assert.equal(statSync(HNSW_BIN_PATH).size, Math.floor(hnswBytes.length / 2));
      assert.deepEqual(readFileSync(MANIFEST_PATH), manifestBytes, "manifest restored intact");
    });
    await assertDarkPutOnDamagedTree("(iv) flag unset + hnsw.bin truncated");
  } finally {
    writeFileSync(HNSW_BIN_PATH, hnswBytes);
  }

  // Back to the intact published generation for the configured-install cases
  // below: same seeded vector, same lexical documents, loaded clean from disk.
  _resetCaches();
  check("2(iii)/(iv) restore: the intact generation loads clean with the seed vector", () => {
    const { hnsw, generation_refused } = activeIndices();
    assert.equal(generation_refused, null, "restored generation is not refused");
    assert.equal(hnsw.size(), 1, "one seeded vector");
    assert.ok(hnsw.has("mem_put_test_seed_vector"), "the seed vector is the one on disk");
  });
})();

// ===========================================================================
// Enable the gate for the happy-path block. The active HNSW stays non-empty
// from here on, so everything below is the configured-install path.
// ===========================================================================
process.env.MEMORY_PUT_ENABLED = "1";

// ===========================================================================
// 3 + 4 + 5 + 6 + 7 + 8 + 10 + 12. The happy path captures pre/post state.
// ===========================================================================
let firstPutId = null;
await (async () => {
  const hashesBefore = lineHashes();
  const linesBefore = hashesBefore.length;
  const putsBefore = policyEvents().filter((e) => e.kind === "policy.memory.put").length;
  const bm25Before = activeIndices().bm25.size();

  const res = await executeTool("memory_put", {
    content: PUT_CONTENT,
    provenance: { agent_id: "operator", confidence: "high" },
  });

  check("3b: configured install — an embeddingless put adds NO BM25 entry", () => {
    assert.equal(
      activeIndices().bm25.size(),
      bm25Before,
      "BM25 stays coupled to a successful embed once a vector index exists",
    );
  });

  check("3: gate ON happy path returns ok + non-null memory_event_id + promoted_at", () => {
    assert.equal(res.ok, true, "put should succeed: " + JSON.stringify(res.error));
    assert.ok(
      typeof res.data.memory_event_id === "string" && res.data.memory_event_id.length > 0,
      "non-null memory_event_id",
    );
    assert.ok(
      typeof res.data.promoted_at === "string" && res.data.promoted_at.length > 0,
      "non-null promoted_at",
    );
    assert.ok(res.data.memory_event_id.startsWith("mem_"), "id is a mem_ id");
  });
  firstPutId = res.data.memory_event_id;

  check("4: append-only / thesis #1 — prior lines byte-identical, exactly one new line", () => {
    const hashesAfter = lineHashes();
    assert.equal(hashesAfter.length, linesBefore + 1, "exactly one new ledger line");
    for (let i = 0; i < linesBefore; i++) {
      assert.equal(hashesAfter[i], hashesBefore[i], `prior line ${i} byte-identical`);
    }
  });

  const row = lastFactRow();
  check("5: consent stamp — every source_ref consent_basis is first_party", () => {
    assert.ok(row, "appended fact row present");
    assert.ok(Array.isArray(row.source_refs) && row.source_refs.length > 0, "has source_refs");
    for (const r of row.source_refs) {
      assert.equal(r.consent_basis, "first_party", "consent_basis must be first_party");
    }
    // The synthetic ref defaults to the "manual" source scope.
    assert.equal(row.source_refs[0].source, "manual", "default operator source is manual");
  });

  check("6: synthesis cascade fires (entities + row-ts time anchor + episodicity)", () => {
    assert.ok(row.features && typeof row.features === "object", "features present");
    assert.ok(Array.isArray(row.features.entities), "features.entities is an array");
    assert.ok(
      row.features.entities.length >= 1,
      "entity extractor recovered >=1 entity from the GitHub URL",
    );
    assert.ok(
      Array.isArray(row.features.time_anchors) && row.features.time_anchors.length >= 1,
      "features.time_anchors present",
    );
    const structural = row.features.time_anchors.find(
      (a) => a && a.stamped_by === "cascade:row-ts",
    );
    assert.ok(structural, "row-ts structural anchor stamped_by cascade:row-ts present");
    assert.equal(structural.kind, "absolute", "structural anchor kind is absolute");
    assert.equal(structural.instant_iso, row.created_at, "structural anchor == created_at");
    assert.equal(typeof row.features.episodicity, "number", "episodicity is a number");
    assert.ok(
      row.features.episodicity >= 0 && row.features.episodicity <= 1,
      "episodicity in [0,1]",
    );
  });

  check("7: embed-outage non-blocking — v0 lands embeddingless (null + embed_state)", () => {
    // v0 default omits inline embed: row lands with explicit null embedding +
    // embed_state=true; the put still returned ok above.
    assert.equal(row.features.embedding_4096, null, "embedding_4096 is null at v0");
    assert.equal(row.features.embed_state, true, "embed_state=true (backfill picks up)");
  });

  check("8: audit event — exactly one new policy.memory.put on success", () => {
    const putsAfter = policyEvents().filter((e) => e.kind === "policy.memory.put");
    assert.equal(putsAfter.length, putsBefore + 1, "exactly one new policy.memory.put");
    const ev = putsAfter[putsAfter.length - 1];
    assert.equal(ev.memory_event_id, firstPutId, "audit event references the minted id");
    assert.equal(ev.consent_basis, "first_party", "audit records first_party basis");
    assert.equal(ev.tool, "memory_put", "audit records the tool name");
  });

  check("10: no daemon token required — put succeeded with no confirmation_token", () => {
    // The happy-path put above carried NO confirmation_token field and returned
    // ok; assert the schema does not even allow it (additionalProperties:false).
    const t = listTools().find((x) => x.name === "memory_put");
    assert.ok(
      !Object.prototype.hasOwnProperty.call(t.inputSchema.properties, "confirmation_token"),
      "memory_put schema has no confirmation_token property",
    );
  });

  check("12: get-visible / recallable — minted row carries content + first_party", () => {
    assert.equal(row.id, firstPutId, "row id matches the returned memory_event_id");
    assert.equal(row.content, PUT_CONTENT, "row content matches the put payload");
    assert.equal(row.kind, "fact", "row is a fact-kind row");
    assert.equal(row.source_refs[0].consent_basis, "first_party", "first_party visible on read");
  });
})();

// ===========================================================================
// 9. Payload validation.
// ===========================================================================
await (async () => {
  const r1 = await executeTool("memory_put", {
    content: "",
    provenance: { confidence: "high" },
  });
  check("9a: empty content => INVALID_ARGUMENTS", () => {
    assert.equal(r1.ok, false);
    assert.equal(r1.error.code, ERROR_CODES.INVALID_ARGUMENTS);
  });

  const r2 = await executeTool("memory_put", {
    content: "x".repeat(16384 + 1),
    provenance: { confidence: "high" },
  });
  check("9b: over-cap content => INVALID_ARGUMENTS", () => {
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, ERROR_CODES.INVALID_ARGUMENTS);
  });

  const r3 = await executeTool("memory_put", {
    content: "valid content",
    provenance: { confidence: "high" },
    bogus_top_level_key: true,
  });
  check("9c: unknown top-level key => INVALID_ARGUMENTS (additionalProperties:false)", () => {
    assert.equal(r3.ok, false);
    assert.equal(r3.error.code, ERROR_CODES.INVALID_ARGUMENTS);
  });

  const r4 = await executeTool("memory_put", {
    content: "valid content",
    provenance: { confidence: "pre_distilled" }, // daemon-only level excluded
  });
  check("9d: daemon-only confidence (pre_distilled) => INVALID_ARGUMENTS", () => {
    assert.equal(r4.ok, false);
    assert.equal(r4.error.code, ERROR_CODES.INVALID_ARGUMENTS);
  });
})();

// ===========================================================================
// 11. Dedupe boundary — two identical puts => two distinct ids.
// ===========================================================================
await (async () => {
  const a = await executeTool("memory_put", {
    content: "dedupe-probe identical content",
    provenance: { confidence: "high" },
  });
  const b = await executeTool("memory_put", {
    content: "dedupe-probe identical content",
    provenance: { confidence: "high" },
  });
  check("11: two identical puts produce two distinct memory_event_ids (v0 no dedupe)", () => {
    assert.equal(a.ok, true, "first dedupe put ok");
    assert.equal(b.ok, true, "second dedupe put ok");
    assert.notEqual(
      a.data.memory_event_id,
      b.data.memory_event_id,
      "distinct ids — v0 has no operator-put dedupe",
    );
  });
})();

// ===========================================================================
// 11b. Optional default-confidence path — provenance with no confidence works.
// ===========================================================================
await (async () => {
  const res = await executeTool("memory_put", {
    content: "no-confidence path defaults to high",
    provenance: {},
  });
  check("11b: provenance.confidence optional (defaults to high)", () => {
    assert.equal(res.ok, true, "put without confidence should succeed");
    const row = lastFactRow();
    assert.equal(row.provenance.confidence, "high", "default confidence high");
  });
})();

// ---------------------------------------------------------------------------
if (failures > 0) {
  process.stdout.write(`\nFAIL  put.test.mjs — ${failures} failing assertion group(s)\n`);
  process.exit(1);
}
process.stdout.write("\nALL PASS  put.test.mjs\n");
process.exit(0);
