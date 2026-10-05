// promote-time-embedding.test.mjs — Phase 3 v0 wire-up.
//
// Covers distill-promote-fact.js promote-time embedding. l14-embed-callers-
// migrate repointed that embed from gemini-client.embedSingle(RETRIEVAL_DOCUMENT)
// to local-embedder-client.embedSingle({isQuery:false}), so both the MOCK
// MECHANISM and the asserted row contract changed here. Two scenarios:
//
//   T1: HAPPY PATH — the local embed server returns a 4096-dim unit vector.
//       The appended fact row carries features.embedding_model_version =
//       "qwen3-embedding-8b-fp16" and features.embed_state = false, and NO
//       inline vector (v3-ledger-embedding-reroute sends it out-of-band to the
//       index WAL; MEMORY_LEDGER_ROW_EMBEDDING_4096=1 restores the inline
//       shape, asserted in the second half of T1). The legacy Gemini keys
//       embedding_3072 / embedding_mrl_768 must be ABSENT. BM25 + HNSW indices
//       under indices/<ACTIVE_EMBED_MODEL_VERSION>/ grow by one entry.
//
//   T2: GRACEFUL DEGRADE — the embed server is unreachable
//       (LocalEmbedUnavailableError). The fact row STILL lands (priority is
//       data capture) with every embedding field an EXPLICIT null and
//       features.embed_state = true, no embedding_pending marker (R29.3
//       retired it), and no index update.
//
// MOCK MECHANISM (do not "simplify" this back to global.fetch):
//   local-embedder-client.js BANS undici by design — it speaks node:http with
//   agent:false (:151-177) after undici's keep-alive pool killed the watermark
//   daemon twice on 2026-07-03. Replacing global.fetch therefore does NOT
//   intercept it; the only seam is _setFetchForTests (:243). The live server at
//   127.0.0.1:8359 is never contacted.
//
// HERMETICITY DISCIPLINE (standing C-NEW-2 pattern):
//   - mkdtempSync builds a fresh hermetic root before ANY dynamic import of
//     memory-system modules.
//   - MEMORY_ROOT + POLICY_BASE_DIR + STORAGE_BASE_DIR + LEDGERS_BASE_DIR
//     env vars are set BEFORE the first dynamic import.
//   - Production <checkout>/{ledgers,indices,policy}/* MUST
//     be byte-identical before/after this test runs.

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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { skipIfDaemonActive } from "./_hermetic-daemon-skip.mjs";
skipIfDaemonActive("promote-time-embedding");

// ---------------------------------------------------------------------------
// 0. Daemon-quiesce gate (R29.2 CRIT-3, converged at e18).
//
// The hermeticity assertion at step 8 stats production ledgers/indices
// before and after this test and expects byte-equality. A concurrent
// watermark daemon invalidates that through no fault of this test.
//
// This file used to carry a SECOND, private copy of the gate right here: a
// two-entry list whose first entry (policy/distillation-state.json) stopped
// existing when R32 retired the distiller, and whose second entry watched 1
// of the 10 declared cascade sources. So the suite ran two competing gates —
// the imported one above and a strictly worse one below it — and the worse
// one could skip the suite with exit 0 on a phantom path. Both are now the
// one gate: skipIfDaemonActive at the top of this file, whose set is derived
// from CAPS.WATERMARK_SOURCES and tiered. See kb/test-discipline.md section 2
// and mcp/test/_hermetic-daemon-skip.mjs.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. Stake out hermetic root + set env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-promote-embed-"));
const HERMETIC_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(HERMETIC_ROOT, "policy");
const STORAGE_DIR = join(HERMETIC_ROOT, "storage");
const SOURCES_DIR = join(STORAGE_DIR, "sources");
const LEDGERS_DIR = join(HERMETIC_ROOT, "ledgers");

for (const d of [HERMETIC_ROOT, POLICY_DIR, STORAGE_DIR, SOURCES_DIR, LEDGERS_DIR]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

process.env.MEMORY_ROOT = HERMETIC_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;
// l14-embed-callers-migrate — no GEMINI_API_KEY defensive stub any more: the
// promote path under test no longer imports gemini-client at all. Instead pin
// LOCAL_EMBED_URL away from any operator override so that even a bypassed
// fetch seam could not reach a real embed server, and clear the two default-OFF
// rollout flags this suite's assertions depend on.
process.env.LOCAL_EMBED_URL = "http://127.0.0.1:9/blackhole";
delete process.env.MEMORY_BM25_DECOUPLE_EMBED;
delete process.env.MEMORY_LEDGER_ROW_EMBEDDING_4096;

// ---------------------------------------------------------------------------
// 2. Pre-test snapshot of production paths (for the hermeticity claim).
// ---------------------------------------------------------------------------
// Checkout root, derived from this file's location (never from MEMORY_ROOT,
// which this suite redirects to a temp tree).
const CHECKOUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROD_MEMORY_JSONL = join(CHECKOUT_ROOT, "ledgers", "memory.jsonl");
const PROD_INDICES_DIR = join(CHECKOUT_ROOT, "indices");
function snapshotPath(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const PROD_SNAPSHOT_BEFORE = {
  memory: snapshotPath(PROD_MEMORY_JSONL),
  indices: snapshotPath(PROD_INDICES_DIR),
};

// ---------------------------------------------------------------------------
// 3. Dynamic imports AFTER env is set.
// ---------------------------------------------------------------------------
// l2Renormalize / mrlSlice moved out of gemini-client.js into vector-math.js.
// This module was imported for those two functions and nothing else, so the
// binding repoints wholesale rather than keeping a dead gemini-client handle.
const vectorMathMod = await import("../lib/vector-math.js");
const daemonTokenMod = await import("../lib/daemon-token.js");
const { CAPS, canonicalJsonSha256Hex } = await import("../lib/validation.js");
// l14-embed-callers-migrate — the ONLY embed seam for this suite.
const localEmbedMod = await import("../lib/local-embedder-client.js");
const promoteFactMod = await import("../lib/tools/distill-promote-fact.js");

// The index tree the promote path now reads AND writes. Both the salience
// kNN (salienceCtx.hnsw) and updateIndicesForFact route here post-l14.
const ACTIVE_MODEL = CAPS.ACTIVE_EMBED_MODEL_VERSION;

// ---------------------------------------------------------------------------
// 4. Test framework.
// ---------------------------------------------------------------------------
let passes = 0;
let failures = 0;
function pass(label) {
  passes += 1;
  console.log(`  pass: ${label}`);
}
function fail(label, detail) {
  failures += 1;
  console.log(`  FAIL: ${label}`);
  if (detail) console.log(`        ${detail}`);
}
async function test(label, fn) {
  console.log(`test: ${label}`);
  try {
    await fn();
  } catch (err) {
    fail(label, err && err.stack ? err.stack : String(err));
  }
}

function l2Norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

// Build a deterministic unit-norm 4096d vector — the shape the local Qwen3
// server returns (full fidelity, no MRL slice).
function buildMockVector4096() {
  const v = new Array(4096);
  for (let i = 0; i < 4096; i++) {
    v[i] = Math.sin(i * 0.13) + 0.01 * i + 0.5;
  }
  return vectorMathMod.l2Renormalize(v);
}

// Install the local-embedder fetch seam for the duration of `fn`. `mode` is
// "ok" (well-formed 4096 payload) or "down" (transport failure, which
// _postEmbed wraps into LocalEmbedUnavailableError).
async function withLocalEmbedStub(mode, fn) {
  localEmbedMod._setFetchForTests(async (_url, init) => {
    if (mode === "down") {
      throw new Error("simulated local embed server outage (test mock)");
    }
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    const texts = Array.isArray(body.texts) ? body.texts : [""];
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          embeddings: texts.map(() => buildMockVector4096()),
          model_version: ACTIVE_MODEL,
          dim: 4096,
          count: texts.length,
          elapsed_ms: 1,
        }),
    };
  });
  try {
    return await fn();
  } finally {
    localEmbedMod._setFetchForTests(null);
  }
}

// ---------------------------------------------------------------------------
// 5. Test fixture setup: signing key + a fake source-ledger row.
// ---------------------------------------------------------------------------
daemonTokenMod.initSigningKey();
const SIGNING_KEY = daemonTokenMod.loadSigningKey().key;

const SOURCE_NAME = "chat-test-runtime";
const SOURCE_LEDGER_PATH = join(SOURCES_DIR, `${SOURCE_NAME}.jsonl`);
const SOURCE_MSG_ID = "test_msg_id_promote_embed_fixture";
writeFileSync(
  SOURCE_LEDGER_PATH,
  JSON.stringify({
    id: SOURCE_MSG_ID,
    ts: "2026-06-02T00:00:00.000Z",
    source: SOURCE_NAME,
    source_msg_id: SOURCE_MSG_ID,
    source_policy: { consent_basis: "first_party" },
    raw_content: { user_text: "test user", assistant_text: "test ack" },
  }) + "\n",
  { mode: 0o600 },
);

const MEMORY_JSONL = join(LEDGERS_DIR, "memory.jsonl");

// Helper: build a fresh argv + confirmation_token for a unique content string.
function buildArgsAndToken(content) {
  const sourceRefs = [{ source: SOURCE_NAME, source_msg_id: SOURCE_MSG_ID }];
  const contentHash = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
  const sourceRefsHash = canonicalJsonSha256Hex(sourceRefs);
  const bindingObject = { content_hash: contentHash, source_refs_hash: sourceRefsHash };
  const bindingHash = canonicalJsonSha256Hex(bindingObject);
  const minted = daemonTokenMod.mintToken(
    bindingHash,
    "memory_distill_promote_fact",
    SIGNING_KEY,
  );
  return {
    args: {
      source_refs: sourceRefs,
      content,
      derived_from: [],
      provenance: {
        agent_id: "test-promote-embed",
        conversation_id: "conv_test_promote_embed",
        confidence: "medium",
      },
      confirmation_token: minted.token,
    },
    nonce_hash: minted.nonce_hash,
  };
}

function readMemoryJsonlLastRow() {
  if (!existsSync(MEMORY_JSONL)) return null;
  const raw = readFileSync(MEMORY_JSONL, "utf8");
  const lines = raw.split("\n").filter((l) => l !== "");
  if (lines.length === 0) return null;
  return JSON.parse(lines[lines.length - 1]);
}

// ---------------------------------------------------------------------------
// 6. T1: HAPPY PATH — local embed server returns a 4096-dim unit vector.
// ---------------------------------------------------------------------------
await test(
  "T1: happy path — row stamped with the ACTIVE model + embed_state=false, no legacy gemini keys, no inline vector; indices updated",
  async () => {
    await withLocalEmbedStub("ok", async () => {
      const { args } = buildArgsAndToken("T1_HAPPY_PATH_CONTENT_unique_aXqY");
      const env = await promoteFactMod.TOOL.handler(args);
      if (!env || env.ok !== true) {
        fail("T1 handler returned non-ok envelope", JSON.stringify(env).slice(0, 400));
        return;
      }
      const row = readMemoryJsonlLastRow();
      if (row == null) {
        fail("T1 memory.jsonl has no rows");
        return;
      }
      const feats = row.features;
      if (!feats || typeof feats !== "object") {
        fail("T1 row.features missing", JSON.stringify(row).slice(0, 400));
        return;
      }
      // R29.2 regression: top-level row.source must mirror source_refs[0].source.
      if (row.source !== SOURCE_NAME) {
        fail(
          "T1 R29.2 top-level row.source mismatch",
          `got=${JSON.stringify(row.source)} expected=${SOURCE_NAME}`,
        );
        return;
      }
      if (
        !Array.isArray(row.source_refs) ||
        row.source_refs.length === 0 ||
        row.source_refs[0].source !== SOURCE_NAME
      ) {
        fail(
          "T1 R29.2 source_refs[0].source mismatch (writer regression)",
          `source_refs=${JSON.stringify(row.source_refs)}`,
        );
        return;
      }
      // l14 contract: the local-embed success branch stamps the ACTIVE model
      // version and embed_state=false. embed_state is the additive-fallback
      // discriminator in multi-feature-score.js and must not move.
      if (feats.embedding_model_version !== ACTIVE_MODEL) {
        fail(
          "T1 features.embedding_model_version mismatch",
          `got=${JSON.stringify(feats.embedding_model_version)} expected=${ACTIVE_MODEL}`,
        );
        return;
      }
      if (feats.embed_state !== false) {
        fail("T1 features.embed_state must be false on the success branch", `got=${JSON.stringify(feats.embed_state)}`);
        return;
      }
      // The legacy Gemini keys must be gone entirely — not null, ABSENT.
      if ("embedding_3072" in feats || "embedding_mrl_768" in feats) {
        fail(
          "T1 legacy gemini embedding keys present on a local-embed row",
          `keys=${JSON.stringify(Object.keys(feats).filter((k) => k.startsWith("embedding")))}`,
        );
        return;
      }
      // v3-ledger-embedding-reroute: with MEMORY_LEDGER_ROW_EMBEDDING_4096 off
      // the vector goes out-of-band, so the key is ABSENT (an explicit null is
      // the null-embed branch's signature and must not be confused with this).
      if ("embedding_4096" in feats) {
        fail(
          "T1 embedding_4096 must be ABSENT with MEMORY_LEDGER_ROW_EMBEDDING_4096 off",
          `value=${feats.embedding_4096 === null ? "null" : "present"}`,
        );
        return;
      }
      if (feats.embedding_pending === true) {
        fail("T1 unexpected embedding_pending=true on happy path");
        return;
      }

      // W2: promote no longer rewrites the full index per fact — it appends to
      // the fsync'd pending-adds journal and defers the on-disk flush (64 adds
      // or 300s). Force the flush so this test keeps asserting the REAL on-disk
      // materialization. l14: the tree is the ACTIVE one now, not the gemini one.
      const { flushIndicesNow } = await import("../lib/recall/index-cache.js");
      flushIndicesNow(ACTIVE_MODEL);

      const bm25Path = join(HERMETIC_ROOT, "indices", ACTIVE_MODEL, "bm25.json");
      if (!existsSync(bm25Path)) {
        fail("T1 BM25 index file not written", `path=${bm25Path}`);
        return;
      }
      // WU-RR1: on-disk bm25.json is v2 line-delimited NDJSON (first line =
      // header, then ["P"|"L"|"M"|"E"|"D",...]). Probe doc_len via "L" lines.
      const bm25Raw = readFileSync(bm25Path, "utf8");
      const idsInIndex = [];
      for (const line of bm25Raw.split("\n")) {
        if (!line.startsWith('["L"')) continue;
        try {
          const e = JSON.parse(line);
          if (typeof e[1] === "string") idsInIndex.push(e[1]);
        } catch {
          // skip malformed line
        }
      }
      if (!idsInIndex.includes(row.id)) {
        fail(
          "T1 BM25 index missing the new memory_id",
          `idsInIndex=${JSON.stringify(idsInIndex)} expected=${row.id}`,
        );
        return;
      }

      // HNSW: linear-scan backend writes streamed NDJSON (header + {id,iid,v});
      // hnswlib-node writes a .meta.json sidecar carrying id_map.
      const hnswPath = join(HERMETIC_ROOT, "indices", ACTIVE_MODEL, "hnsw.bin");
      const hnswSidecar = hnswPath + ".meta.json";
      if (!existsSync(hnswPath) && !existsSync(hnswSidecar)) {
        fail("T1 HNSW index files not written", `path=${hnswPath}`);
        return;
      }
      let hnswIds = [];
      if (existsSync(hnswSidecar)) {
        const sidecarJson = JSON.parse(readFileSync(hnswSidecar, "utf8"));
        hnswIds = Array.isArray(sidecarJson.id_map)
          ? sidecarJson.id_map.map((e) => e[0])
          : [];
      } else {
        const ndjsonLines = readFileSync(hnswPath, "utf8").split("\n");
        for (let li = 1; li < ndjsonLines.length; li++) {
          const ln = ndjsonLines[li].trim();
          if (!ln) continue;
          try {
            const o = JSON.parse(ln);
            if (o && typeof o.id === "string") hnswIds.push(o.id);
          } catch (_e) {
            // tolerate a malformed/partial NDJSON line in this probe
          }
        }
      }
      if (!hnswIds.includes(row.id)) {
        fail(
          "T1 HNSW index missing the new memory_id",
          `hnswIds=${JSON.stringify(hnswIds)} expected=${row.id}`,
        );
        return;
      }

      // The vector itself is only observable on the row under the revert flag.
      // Exercise that branch so the 4096 unit-norm invariant stays covered.
      process.env.MEMORY_LEDGER_ROW_EMBEDDING_4096 = "1";
      try {
        const inline = buildArgsAndToken("T1_INLINE_VECTOR_CONTENT_unique_aXqY2");
        const env2 = await promoteFactMod.TOOL.handler(inline.args);
        if (!env2 || env2.ok !== true) {
          fail("T1 inline-flag handler returned non-ok envelope", JSON.stringify(env2).slice(0, 300));
          return;
        }
        const f2 = readMemoryJsonlLastRow().features;
        if (!Array.isArray(f2.embedding_4096) || f2.embedding_4096.length !== 4096) {
          fail(
            "T1 features.embedding_4096 wrong shape under MEMORY_LEDGER_ROW_EMBEDDING_4096=1",
            `len=${f2.embedding_4096 && f2.embedding_4096.length}`,
          );
          return;
        }
        const norm4096 = l2Norm(f2.embedding_4096);
        if (Math.abs(norm4096 - 1.0) > 1e-6) {
          fail("T1 ||embedding_4096||=1.0 invariant violated", `norm=${norm4096}`);
          return;
        }
        pass(
          `T1: row stamped ${ACTIVE_MODEL} + embed_state=false, no legacy keys, vector out-of-band; indices/${ACTIVE_MODEL} updated; inline vector under the revert flag len=4096 norm=${norm4096.toFixed(8)}`,
        );
      } finally {
        delete process.env.MEMORY_LEDGER_ROW_EMBEDDING_4096;
      }
    });
  },
);

// ---------------------------------------------------------------------------
// 7. T2: GRACEFUL DEGRADE — the local embed server is unreachable.
// ---------------------------------------------------------------------------
await test(
  "T2: local embed outage — explicit-null embedding fields + embed_state=true; no embedding_pending marker (R29.3); no index update",
  async () => {
    await withLocalEmbedStub("down", async () => {
      const bm25Path = join(HERMETIC_ROOT, "indices", ACTIVE_MODEL, "bm25.json");
      const hnswPath = join(HERMETIC_ROOT, "indices", ACTIVE_MODEL, "hnsw.bin");
      const hnswSidecar = hnswPath + ".meta.json";
      const fpBefore = {
        bm25: snapshotPath(bm25Path),
        hnsw: snapshotPath(hnswPath),
        hnswMeta: snapshotPath(hnswSidecar),
      };

      const { args } = buildArgsAndToken("T2_PENDING_CONTENT_unique_bMpZ");
      const env = await promoteFactMod.TOOL.handler(args);
      if (!env || env.ok !== true) {
        fail(
          "T2 handler returned non-ok envelope (data capture should still succeed)",
          JSON.stringify(env).slice(0, 400),
        );
        return;
      }
      const row = readMemoryJsonlLastRow();
      if (row == null) {
        fail("T2 memory.jsonl has no rows");
        return;
      }
      if (row.content !== "T2_PENDING_CONTENT_unique_bMpZ") {
        fail("T2 last row is not the T2 fixture", `content=${row.content}`);
        return;
      }
      const feats = row.features;
      if (!feats) {
        fail("T2 row has no features object", JSON.stringify(row).slice(0, 400));
        return;
      }
      // R29.3: the embedding_pending marker is retired — must NOT be present.
      if ("embedding_pending" in feats) {
        fail(
          "T2 R29.3 violation: features.embedding_pending must NOT be present",
          `features=${JSON.stringify(Object.keys(feats))}`,
        );
        return;
      }
      // W5-CCS / l14: outage-degrade writes EXPLICIT nulls + embed_state=true.
      // This is byte-identical to the pre-migration Gemini-outage degrade —
      // the backend swap must not change what the failure path reports.
      for (const k of [
        "embedding_4096",
        "embedding_3072",
        "embedding_mrl_768",
        "embedding_model_version",
      ]) {
        if (!(k in feats) || feats[k] !== null) {
          fail(
            `T2 features.${k} must be an EXPLICIT null on the outage path`,
            `got=${JSON.stringify(feats[k])} present=${k in feats}`,
          );
          return;
        }
      }
      if (feats.embed_state !== true) {
        fail("T2 features.embed_state must be true on the outage path", `got=${JSON.stringify(feats.embed_state)}`);
        return;
      }

      // Indices MUST be unchanged on the outage path.
      const fpAfter = {
        bm25: snapshotPath(bm25Path),
        hnsw: snapshotPath(hnswPath),
        hnswMeta: snapshotPath(hnswSidecar),
      };
      if (
        fpAfter.bm25 !== fpBefore.bm25 ||
        fpAfter.hnsw !== fpBefore.hnsw ||
        fpAfter.hnswMeta !== fpBefore.hnswMeta
      ) {
        fail(
          "T2 indices were mutated on the outage path",
          `before=${JSON.stringify(fpBefore)} after=${JSON.stringify(fpAfter)}`,
        );
        return;
      }
      pass(
        "T2: outage row appended with explicit-null embedding fields + embed_state=true, no embedding_pending marker; indices untouched",
      );
    });
  },
);


// ---------------------------------------------------------------------------
// 8. Hermeticity assertion: production paths byte-identical.
// ---------------------------------------------------------------------------
const PROD_SNAPSHOT_AFTER = {
  memory: snapshotPath(PROD_MEMORY_JSONL),
  indices: snapshotPath(PROD_INDICES_DIR),
};
if (
  PROD_SNAPSHOT_BEFORE.memory !== PROD_SNAPSHOT_AFTER.memory ||
  PROD_SNAPSHOT_BEFORE.indices !== PROD_SNAPSHOT_AFTER.indices
) {
  failures += 1;
  console.log(
    `  FAIL: hermeticity — production paths mutated: before=${JSON.stringify(PROD_SNAPSHOT_BEFORE)} after=${JSON.stringify(PROD_SNAPSHOT_AFTER)}`,
  );
} else {
  passes += 1;
  console.log("  pass: hermeticity — production checkout paths byte-identical");
}

// ---------------------------------------------------------------------------
// 9. Cleanup + summary.
// ---------------------------------------------------------------------------
try {
  rmSync(TMP_ROOT, { recursive: true, force: true });
} catch {
  // best-effort
}

console.log("");
console.log(`promote-time-embedding.test.mjs: ${passes} passed, ${failures} failed`);
if (failures > 0) {
  process.exit(1);
}
process.exit(0);
