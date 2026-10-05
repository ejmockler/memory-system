// embed-callers-migrate.test.mjs — l14-embed-callers-migrate red-first suite.
//
// WHAT THIS LOCKS. Two production modules used to take their embedding
// function from mcp/lib/gemini-client.js:
//
//   mcp/lib/tools/distill-promote-fact.js  (the memory_distill_promote_fact
//                                           MCP handler's promote-time embed)
//   mcp/lib/ingest/_corroborate.js         (defaultEmbed)
//
// Both now take it from mcp/lib/local-embedder-client.js. That is NOT a
// drop-in: the signatures differ (gemini {text,taskType,dims,source} vs local
// {text,isQuery}), the dimensionality differs (3072->768 MRL slice vs full
// 4096), and the failure class differs (KeyPoolExhaustedError vs
// LocalEmbedUnavailableError). The assertions below cover the three things
// that could ship silently:
//
//   R1  the handler issues EXACTLY ONE POST to /embed, and its body carries
//       is_query === false and dim === 4096.
//   R2  the appended row carries embedding_model_version ===
//       "qwen3-embedding-8b-fp16", embed_state === false, and NEITHER
//       embedding_3072 NOR embedding_mrl_768. With
//       MEMORY_LEDGER_ROW_EMBEDDING_4096=1 the same promote additionally
//       carries features.embedding_4096 of length 4096.
//   R3  POLARITY. A wrong isQuery embeds a DOCUMENT with query-side polarity:
//       no error, degraded recall, invisible to any test that only checks a
//       vector came back. R3 pairs the NEGATIVE assertion (the handler's
//       request has is_query !== true) with a POSITIVE control that drives
//       local.embedSingle({isQuery:true}) through the SAME stub and observes
//       is_query === true — so R1/R3's negative cannot pass vacuously on a
//       stub that never records anything.
//   R3b THE HIGHEST-RISK LINE. salienceCtx.hnsw must load the ACTIVE (4096)
//       index tree, not the gemini (768) one — a 4096 vector kNN'd against a
//       768-dim index is silent garbage. Asserted on the model version
//       ACTUALLY LOADED via index-cache._indexCacheHas, not by reading source.
//   R4  embed failure degrades IDENTICALLY to the old Gemini-outage path: the
//       row still lands, every embedding field is an EXPLICIT null,
//       embed_state === true, and no index write occurs.
//   R5  _corroborate.CORROBORATE_INTERNALS.defaultEmbed through the same stub
//       returns { vector: <length 4096>, embedding_model_version: "qwen3-..." }.
//   R6  two-sided static check on both files: NO gemini-client import line AND
//       the local-embedder-client import IS present.
//   R7  FROZEN-ALLOWLIST census of every importer of mcp/lib/gemini-client.js
//       across the WHOLE repo (l17). This is an ALLOWLIST, not a denylist: the
//       discovered set must EQUAL GEMINI_CLIENT_IMPORTERS, so an UNEXPECTED
//       importer FAILS and a silently-vanished one FAILS too. A denylist of
//       the names known on the day it was written is the exact defect F74
//       recorded, and is why R6's two-file check could not catch l17's target.
//       Four import shapes are matched, because prior sweeps of this program
//       each missed a different one: `import ... from "<...>gemini-client.js"`,
//       the multi-line continuation `} from "<...>gemini-client.js"`,
//       `await import("<...>gemini-client.js")`, and
//       `require("<...>gemini-client.js")`. The walk starts at the REPO ROOT
//       derived from THIS FILE's location — NOT from config.js MEMORY_ROOT,
//       which section 1 above has already repointed at the hermetic tmp tree.
//       Two live importers sit OUTSIDE mcp/lib (mcp/daemon/queryd.js and
//       repo-root scripts/backfill-embeddings.mjs) and were missed by every
//       `mcp/lib`-rooted grep in this program, hence the root-relative walk.
//
// HERMETICITY DISCIPLINE (standing C-NEW-2 pattern):
//   - mkdtempSync root + MEMORY_ROOT / POLICY_BASE_DIR / STORAGE_BASE_DIR /
//     LEDGERS_BASE_DIR set BEFORE any dynamic import of a memory-system module.
//   - EVERY embed goes through local-embedder-client._setFetchForTests. The
//     live embed server at 127.0.0.1:8359 is never contacted. Note that
//     monkey-patching global.fetch does NOT work against this client by design
//     (local-embedder-client.js:151-177 uses node:http with agent:false — undici
//     is banned there after it killed the watermark daemon twice on 2026-07-03).

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { skipIfDaemonActive } from "./_hermetic-daemon-skip.mjs";
// e10 — ONE definition of "this is a scratch root", shared with the other
// whole-repo scanners. A second hand-rolled copy of this rule is the exact
// defect this import exists to remove.
import { isScratchDirName } from "../scripts/_scan-exclusions.mjs";
skipIfDaemonActive("embed-callers-migrate");

// ---------------------------------------------------------------------------
// 1. Hermetic root + env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-embed-callers-"));
const HERMETIC_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(HERMETIC_ROOT, "policy");
const STORAGE_DIR = join(HERMETIC_ROOT, "storage");
const SOURCES_DIR = join(STORAGE_DIR, "sources");
const LEDGERS_DIR = join(HERMETIC_ROOT, "ledgers");
const INDICES_DIR = join(HERMETIC_ROOT, "indices");

for (const d of [
  HERMETIC_ROOT,
  POLICY_DIR,
  STORAGE_DIR,
  SOURCES_DIR,
  LEDGERS_DIR,
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

process.env.MEMORY_ROOT = HERMETIC_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;
// Default-OFF rollout flags this suite depends on being OFF: the BM25 decouple
// gate would write the lexical index on the embed-failure path (R4 asserts no
// index write), and the row-embedding flag changes the R2 row shape.
delete process.env.MEMORY_BM25_DECOUPLE_EMBED;
delete process.env.MEMORY_LEDGER_ROW_EMBEDDING_4096;
delete process.env.MEMORY_SALIENCE_BYPASS;
// LOCAL_EMBED_URL is never dialed (the fetch seam intercepts first) but pin it
// away from any operator override so a misconfigured shell cannot reach a real
// server if the seam were ever bypassed.
process.env.LOCAL_EMBED_URL = "http://127.0.0.1:9/blackhole";

// ---------------------------------------------------------------------------
// 2. Production-path snapshot (hermeticity claim).
// ---------------------------------------------------------------------------
const PROD_MEMORY_JSONL = join(homedir(), "memory-system", "ledgers", "memory.jsonl");
const PROD_INDICES_DIR = join(homedir(), "memory-system", "indices");
function snapshotPath(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const PROD_BEFORE = {
  memory: snapshotPath(PROD_MEMORY_JSONL),
  indices: snapshotPath(PROD_INDICES_DIR),
};

// ---------------------------------------------------------------------------
// 3. Dynamic imports AFTER env is set.
// ---------------------------------------------------------------------------
const localMod = await import("../lib/local-embedder-client.js");
const daemonTokenMod = await import("../lib/daemon-token.js");
const { CAPS, canonicalJsonSha256Hex } = await import("../lib/validation.js");
const indexCacheMod = await import("../lib/recall/index-cache.js");
const promoteFactMod = await import("../lib/tools/distill-promote-fact.js");
const corroborateMod = await import("../lib/ingest/_corroborate.js");

const ACTIVE_MODEL = CAPS.ACTIVE_EMBED_MODEL_VERSION;
const GEMINI_MODEL = CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT;

// ---------------------------------------------------------------------------
// 4. Micro test framework.
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

// ---------------------------------------------------------------------------
// 5. The one and only embed seam. Every request is recorded so the polarity
//    assertions have something to read; `mode` switches the stub between a
//    well-formed 4096 response and a transport failure.
// ---------------------------------------------------------------------------
const EMBED_REQUESTS = [];
let stubMode = "ok";

function buildUnitVector4096(seed) {
  const v = new Array(4096);
  let sum = 0;
  for (let i = 0; i < 4096; i++) {
    const x = Math.sin((i + 1) * 0.017 + seed) + 1.5;
    v[i] = x;
    sum += x * x;
  }
  const n = Math.sqrt(sum);
  for (let i = 0; i < 4096; i++) v[i] = v[i] / n;
  return v;
}

localMod._setFetchForTests(async (url, init) => {
  const body = init && typeof init.body === "string" ? JSON.parse(init.body) : null;
  EMBED_REQUESTS.push({ url, body });
  if (stubMode === "throw") {
    // Transport-level failure. _postEmbed wraps ANY fetch rejection into a
    // LocalEmbedUnavailableError, which is the class the migrated call sites
    // must degrade on (it replaces gemini's KeyPoolExhaustedError).
    throw new Error("simulated local embed server down (test stub)");
  }
  const texts = body && Array.isArray(body.texts) ? body.texts : [""];
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        embeddings: texts.map((_t, i) => buildUnitVector4096(i)),
        model_version: ACTIVE_MODEL,
        dim: 4096,
        count: texts.length,
        elapsed_ms: 1,
      }),
  };
});

// ---------------------------------------------------------------------------
// 6. Fixture: signing key + a source-ledger row the handler can resolve.
// ---------------------------------------------------------------------------
daemonTokenMod.initSigningKey();
const SIGNING_KEY = daemonTokenMod.loadSigningKey().key;

const SOURCE_NAME = "chat-test-runtime";
const SOURCE_MSG_ID = "test_msg_id_embed_callers_migrate";
writeFileSync(
  join(SOURCES_DIR, `${SOURCE_NAME}.jsonl`),
  JSON.stringify({
    id: SOURCE_MSG_ID,
    ts: "2026-08-15T00:00:00.000Z",
    source: SOURCE_NAME,
    source_msg_id: SOURCE_MSG_ID,
    source_policy: { consent_basis: "first_party" },
    raw_content: { user_text: "test user", assistant_text: "test ack" },
  }) + "\n",
  { mode: 0o600 },
);

const MEMORY_JSONL = join(LEDGERS_DIR, "memory.jsonl");

function buildArgs(content) {
  const sourceRefs = [{ source: SOURCE_NAME, source_msg_id: SOURCE_MSG_ID }];
  const contentHash = createHash("sha256")
    .update(Buffer.from(content, "utf8"))
    .digest("hex");
  const bindingHash = canonicalJsonSha256Hex({
    content_hash: contentHash,
    source_refs_hash: canonicalJsonSha256Hex(sourceRefs),
  });
  const minted = daemonTokenMod.mintToken(
    bindingHash,
    "memory_distill_promote_fact",
    SIGNING_KEY,
  );
  return {
    source_refs: sourceRefs,
    content,
    derived_from: [],
    provenance: {
      agent_id: "test-embed-callers-migrate",
      conversation_id: "conv_test_embed_callers_migrate",
      confidence: "medium",
    },
    confirmation_token: minted.token,
  };
}

function lastMemoryRow() {
  if (!existsSync(MEMORY_JSONL)) return null;
  const lines = readFileSync(MEMORY_JSONL, "utf8")
    .split("\n")
    .filter((l) => l !== "");
  if (lines.length === 0) return null;
  return JSON.parse(lines[lines.length - 1]);
}

// Recursive fingerprint of the hermetic indices/ tree — the R4 "no index
// write" assertion needs to see the WAL append too, not just bm25.json.
function fingerprintIndices() {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${p}=${snapshotPath(p)}`);
    }
  }
  walk(INDICES_DIR);
  return out.join("|");
}

// ---------------------------------------------------------------------------
// R1 + R2 + R3(negative) + R3b — the happy-path promote.
// ---------------------------------------------------------------------------
let happyRow = null;
await test(
  "R1/R2/R3: promote embeds ONCE via the local client (is_query=false, dim=4096) and stamps the active model on the row",
  async () => {
    indexCacheMod._resetCaches();
    EMBED_REQUESTS.length = 0;
    stubMode = "ok";

    const env = await promoteFactMod.TOOL.handler(
      buildArgs("R1_HAPPY_local_embed_migration_fixture_qZ7"),
    );
    if (!env || env.ok !== true) {
      fail("R1 handler returned non-ok envelope", JSON.stringify(env).slice(0, 400));
      return;
    }

    // R1: exactly one POST, to /embed, with the document-side polarity and the
    // 4096 dim the local server speaks.
    if (EMBED_REQUESTS.length !== 1) {
      fail(
        "R1 expected exactly ONE /embed request from one promote",
        `count=${EMBED_REQUESTS.length} urls=${JSON.stringify(EMBED_REQUESTS.map((r) => r.url))}`,
      );
      return;
    }
    const req = EMBED_REQUESTS[0];
    if (typeof req.url !== "string" || !req.url.endsWith("/embed")) {
      fail("R1 request url is not the local embed endpoint", `url=${req.url}`);
      return;
    }
    if (!req.body || typeof req.body !== "object") {
      fail("R1 request had no JSON body", `body=${JSON.stringify(req.body)}`);
      return;
    }
    if (req.body.dim !== 4096) {
      fail("R1 request body dim !== 4096", `dim=${JSON.stringify(req.body.dim)}`);
      return;
    }
    // R3 NEGATIVE half — a document must not be embedded with query polarity.
    // The positive control below proves this assertion is discriminating.
    if (req.body.is_query === true) {
      fail(
        "R3 POLARITY DEFECT: the promote handler embedded a DOCUMENT with is_query=true",
        `body=${JSON.stringify({ is_query: req.body.is_query, dim: req.body.dim })}`,
      );
      return;
    }
    if (req.body.is_query !== false) {
      fail(
        "R1 request body is_query is not the boolean false",
        `is_query=${JSON.stringify(req.body.is_query)}`,
      );
      return;
    }

    // R2: the row's embedding contract.
    const row = lastMemoryRow();
    if (row == null) {
      fail("R2 memory.jsonl has no rows after a successful promote");
      return;
    }
    happyRow = row;
    const f = row.features;
    if (!f || typeof f !== "object") {
      fail("R2 row.features missing", JSON.stringify(row).slice(0, 300));
      return;
    }
    if (f.embedding_model_version !== ACTIVE_MODEL) {
      fail(
        "R2 features.embedding_model_version is not the active local model",
        `got=${JSON.stringify(f.embedding_model_version)} want=${ACTIVE_MODEL}`,
      );
      return;
    }
    if (f.embed_state !== false) {
      fail(
        "R2 features.embed_state must be false on the success branch (it is the additive-fallback discriminator)",
        `got=${JSON.stringify(f.embed_state)}`,
      );
      return;
    }
    if ("embedding_3072" in f || "embedding_mrl_768" in f) {
      fail(
        "R2 legacy gemini embedding keys present on a local-embed row",
        `keys=${JSON.stringify(Object.keys(f).filter((k) => k.startsWith("embedding")))}`,
      );
      return;
    }
    // v3-ledger-embedding-reroute: with the flag OFF the vector travels
    // out-of-band, so the key must be ABSENT — not null (an explicit null is
    // the null-embed branch's signature).
    if ("embedding_4096" in f) {
      fail(
        "R2 embedding_4096 must be ABSENT with MEMORY_LEDGER_ROW_EMBEDDING_4096 off",
        `value=${f.embedding_4096 === null ? "null" : "present"}`,
      );
      return;
    }

    pass(
      `R1/R2/R3: one /embed POST (is_query=false, dim=4096); row stamped ${ACTIVE_MODEL} + embed_state=false with no legacy keys`,
    );
  },
);

// ---------------------------------------------------------------------------
// R3b — THE HIGHEST-RISK LINE, asserted independently of R1 so it is still
// exercised (and still fails) when an earlier assertion trips. Reads what the
// index cache ACTUALLY holds after the promote above; the cache is populated
// by the salienceCtx.hnsw loadIndices call and by updateIndicesForFact, and
// _resetCaches() ran immediately before that promote.
// ---------------------------------------------------------------------------
await test(
  "R3b: the promote path loads the ACTIVE (4096) index tree and never the gemini (768) tree",
  async () => {
    if (indexCacheMod._indexCacheHas(GEMINI_MODEL)) {
      fail(
        "R3b the promote path loaded the GEMINI (768-dim) index tree — a 4096 vector kNN'd against that geometry is silent garbage",
        `loaded=${GEMINI_MODEL}`,
      );
      return;
    }
    if (!indexCacheMod._indexCacheHas(ACTIVE_MODEL)) {
      fail(
        "R3b the promote path never loaded the ACTIVE index tree",
        `expected an index-cache entry for ${ACTIVE_MODEL}`,
      );
      return;
    }
    pass(`R3b: index tree actually loaded = ${ACTIVE_MODEL}; ${GEMINI_MODEL} never loaded`);
  },
);

// ---------------------------------------------------------------------------
// R3 POSITIVE CONTROL — the negative assertion above is only meaningful if the
// SAME stub can observe is_query === true. Drive the query polarity through it.
// ---------------------------------------------------------------------------
await test(
  "R3 positive control: embedSingle({isQuery:true}) through the SAME stub records is_query === true",
  async () => {
    EMBED_REQUESTS.length = 0;
    stubMode = "ok";
    const r = await localMod.embedSingle({
      text: "a recall query, embedded with query polarity",
      isQuery: true,
    });
    if (EMBED_REQUESTS.length !== 1) {
      fail("R3 control: stub did not record the request", `count=${EMBED_REQUESTS.length}`);
      return;
    }
    if (EMBED_REQUESTS[0].body.is_query !== true) {
      fail(
        "R3 control: the stub cannot observe is_query=true — the R1 negative assertion would be VACUOUS",
        `body=${JSON.stringify(EMBED_REQUESTS[0].body.is_query)}`,
      );
      return;
    }
    if (!Array.isArray(r.vector_4096) || r.vector_4096.length !== 4096) {
      fail("R3 control: returned vector is not 4096-dim", `len=${r.vector_4096 && r.vector_4096.length}`);
      return;
    }
    pass(
      "R3 positive control: same stub, isQuery:true -> is_query===true in the request body (so the handler's is_query===false is a discriminating observation)",
    );
  },
);

// ---------------------------------------------------------------------------
// R2b — MEMORY_LEDGER_ROW_EMBEDDING_4096=1 restores the inline vector.
// ---------------------------------------------------------------------------
await test(
  "R2b: MEMORY_LEDGER_ROW_EMBEDDING_4096=1 puts features.embedding_4096 (len 4096) back on the row",
  async () => {
    EMBED_REQUESTS.length = 0;
    stubMode = "ok";
    process.env.MEMORY_LEDGER_ROW_EMBEDDING_4096 = "1";
    try {
      const env = await promoteFactMod.TOOL.handler(
        buildArgs("R2b_INLINE_VECTOR_local_embed_fixture_mW3"),
      );
      if (!env || env.ok !== true) {
        fail("R2b handler returned non-ok envelope", JSON.stringify(env).slice(0, 300));
        return;
      }
      const f = lastMemoryRow().features;
      if (!Array.isArray(f.embedding_4096) || f.embedding_4096.length !== 4096) {
        fail(
          "R2b features.embedding_4096 wrong shape",
          `len=${f.embedding_4096 && f.embedding_4096.length}`,
        );
        return;
      }
      if (f.embedding_model_version !== ACTIVE_MODEL || f.embed_state !== false) {
        fail(
          "R2b model_version / embed_state drifted under the revert flag",
          `model=${f.embedding_model_version} embed_state=${f.embed_state}`,
        );
        return;
      }
      pass("R2b: inline features.embedding_4096 length 4096 under the revert flag; stamps unchanged");
    } finally {
      delete process.env.MEMORY_LEDGER_ROW_EMBEDDING_4096;
    }
  },
);

// ---------------------------------------------------------------------------
// R4 — embed failure must degrade IDENTICALLY to the pre-migration Gemini
// outage: row lands, every embedding field explicit null, embed_state=true,
// no index write.
// ---------------------------------------------------------------------------
await test(
  "R4: LocalEmbedUnavailableError -> row lands with explicit-null embeddings + embed_state=true, and no index write",
  async () => {
    EMBED_REQUESTS.length = 0;
    stubMode = "throw";

    // Prove the class first: the same stub, through the same client, produces
    // the typed error the migrated call sites must degrade on.
    let sawTyped = false;
    try {
      await localMod.embedSingle({ text: "probe", isQuery: false });
    } catch (e) {
      sawTyped =
        e instanceof localMod.LocalEmbedUnavailableError ||
        (e && e.name === "LocalEmbedUnavailableError");
    }
    if (!sawTyped) {
      fail("R4 stub did not produce a LocalEmbedUnavailableError — the degrade path is not being exercised");
      return;
    }

    const fpBefore = fingerprintIndices();
    const env = await promoteFactMod.TOOL.handler(
      buildArgs("R4_OUTAGE_local_embed_down_fixture_pL8"),
    );
    if (!env || env.ok !== true) {
      fail(
        "R4 handler must still succeed on embed failure (data capture has priority)",
        JSON.stringify(env).slice(0, 300),
      );
      return;
    }
    const row = lastMemoryRow();
    if (row == null || row.content !== "R4_OUTAGE_local_embed_down_fixture_pL8") {
      fail("R4 last ledger row is not the outage fixture", `content=${row && row.content}`);
      return;
    }
    const f = row.features;
    for (const k of [
      "embedding_4096",
      "embedding_3072",
      "embedding_mrl_768",
      "embedding_model_version",
    ]) {
      if (!(k in f) || f[k] !== null) {
        fail(
          `R4 features.${k} must be an EXPLICIT null on the outage path`,
          `got=${JSON.stringify(f[k])} present=${k in f}`,
        );
        return;
      }
    }
    if (f.embed_state !== true) {
      fail("R4 features.embed_state must be true on the outage path", `got=${JSON.stringify(f.embed_state)}`);
      return;
    }
    if ("embedding_pending" in f) {
      fail("R4 retired embedding_pending marker reappeared", `features=${JSON.stringify(Object.keys(f))}`);
      return;
    }
    const fpAfter = fingerprintIndices();
    if (fpAfter !== fpBefore) {
      fail(
        "R4 the indices tree was written on the embed-failure path",
        `before=${fpBefore}\n        after=${fpAfter}`,
      );
      return;
    }
    pass(
      "R4: outage row landed with explicit-null embeddings + embed_state=true; indices tree byte-identical (no index update)",
    );
  },
);

// ---------------------------------------------------------------------------
// R5 — _corroborate.defaultEmbed through the same stub.
// ---------------------------------------------------------------------------
await test(
  "R5: _corroborate CORROBORATE_INTERNALS.defaultEmbed returns a 4096 vector stamped with the active model",
  async () => {
    EMBED_REQUESTS.length = 0;
    stubMode = "ok";
    const internals = corroborateMod.CORROBORATE_INTERNALS;
    if (!internals || typeof internals.defaultEmbed !== "function") {
      fail(
        "R5 CORROBORATE_INTERNALS.defaultEmbed is not exported as a function",
        `keys=${internals ? JSON.stringify(Object.keys(internals)) : "none"}`,
      );
      return;
    }
    const r = await internals.defaultEmbed("a corroboration candidate");
    if (!Array.isArray(r.vector) || r.vector.length !== 4096) {
      fail("R5 defaultEmbed().vector is not a 4096-dim array", `len=${r.vector && r.vector.length}`);
      return;
    }
    if (r.embedding_model_version !== ACTIVE_MODEL) {
      fail(
        "R5 defaultEmbed().embedding_model_version is not the active local model",
        `got=${JSON.stringify(r.embedding_model_version)} want=${ACTIVE_MODEL}`,
      );
      return;
    }
    if (EMBED_REQUESTS.length !== 1 || EMBED_REQUESTS[0].body.is_query !== false) {
      fail(
        "R5 defaultEmbed must issue exactly one document-polarity request",
        `count=${EMBED_REQUESTS.length} is_query=${JSON.stringify(EMBED_REQUESTS[0] && EMBED_REQUESTS[0].body.is_query)}`,
      );
      return;
    }
    pass(`R5: defaultEmbed -> { vector: len 4096, embedding_model_version: "${ACTIVE_MODEL}" }, one is_query=false request`);
  },
);

// ---------------------------------------------------------------------------
// R6 — two-sided static check on both migrated files.
// ---------------------------------------------------------------------------
await test(
  "R6: neither migrated file imports from gemini-client.js, and both import from local-embedder-client.js",
  async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const targets = [
      join(here, "..", "lib", "tools", "distill-promote-fact.js"),
      join(here, "..", "lib", "ingest", "_corroborate.js"),
    ];
    for (const p of targets) {
      const src = readFileSync(p, "utf8");
      const importLines = src
        .split("\n")
        .filter((l) => /^\s*import\b/.test(l) || /^\s*\}\s*from\s+["']/.test(l));
      const geminiImport = importLines.filter((l) => l.includes("gemini-client.js"));
      if (geminiImport.length > 0) {
        fail(
          `R6 ${p} still imports from gemini-client.js`,
          geminiImport.join(" ; ").slice(0, 300),
        );
        return;
      }
      const localImport = importLines.filter((l) =>
        l.includes("local-embedder-client.js"),
      );
      if (localImport.length === 0) {
        fail(`R6 ${p} has no local-embedder-client.js import`, "expected exactly one");
        return;
      }
    }
    pass("R6: both files import local-embedder-client.js and neither imports gemini-client.js");
  },
);

// ---------------------------------------------------------------------------
// R7 — frozen-allowlist census of every gemini-client.js importer, repo-wide.
// ---------------------------------------------------------------------------

// Repo root, derived from this file's own location (mcp/test/ -> ../..).
// Deliberately NOT config.js MEMORY_ROOT: section 1 repoints that at TMP_ROOT.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Directory basenames never walked: vendored code, VCS internals, and the
// three live data trees (a census must not stat production data).
//
// e10 — THIS LIST IS NO LONGER THE WHOLE RULE, and it must not be. It was a
// hand-rolled second copy of the scratch-root exclusion, and it was missing
// ".claude", so this census descended into the orchestrator's own worktrees:
// measured 2026-08-20 at 2,713 files examined against 712 tracked, exit 1,
// with UNEXPECTED importers named as paths inside .claude/worktrees/. A gate
// that reports another agent's scratch copy as a forbidden importer of the
// module it is protecting is injuring itself, and it red-gated three correct
// nodes before anyone read the paths in its output.
//
// The scratch class now comes from ONE definition — isScratchDirName in
// mcp/scripts/_scan-exclusions.mjs, which is dot-dirs plus named vendor roots,
// so the next scratch dir some tool invents is covered without editing a list.
// What survives here is only this census's OWN distinct concern: the live data
// trees (indices/, ledgers/) are not scratch, they are production data a census
// must not stat. Keeping those two here and nothing else is the point — a
// second copy of the SCRATCH rule is the regression; a census-specific data
// rule is not.
const CENSUS_SKIP_DIRS = new Set([
  "indices",
  "ledgers",
]);
const CENSUS_EXTS = [".js", ".mjs", ".cjs", ".ts"];

// Strips a line's `//` comment tail so that PROSE ABOUT an import is never
// counted as one. Required, not cosmetic: lib/observability/embed-cost.js
// carries two commented-out `import { embedSingle } from "../gemini-client.js"`
// examples, and the R7 docblock above quotes all four shapes verbatim — every
// one of those is a false UNEXPECTED importer without this. Quote-aware so a
// `//` inside a string literal (e.g. a "http://..." URL) does not truncate
// real code. Block comments are not stripped; no line in the matched corpus
// needs it, and a half-implemented stripper would be worse than none.
function censusCodePart(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "/" && line[i + 1] === "/") {
      return line.slice(0, i);
    }
  }
  return line;
}

// The four import shapes. Shapes 1 and 2 stay anchored at line start as a
// second line of defense behind censusCodePart.
const CENSUS_SHAPES = [
  ["static-import", /^\s*import\b[^\n]*["'][^"']*gemini-client\.js["']/],
  ["static-continuation", /^\s*\}\s*from\s*["'][^"']*gemini-client\.js["']/],
  ["dynamic-import", /\bimport\s*\(\s*["'][^"']*gemini-client\.js["']\s*\)/],
  ["require", /\brequire\s*\(\s*["'][^"']*gemini-client\.js["']\s*\)/],
];

// FROZEN ALLOWLIST — repo-root-relative, POSIX separators, sorted.
// Adding an importer of the Gemini embed client is a deliberate act; it must
// be recorded here in the same commit, with the reason it is allowed.
const GEMINI_CLIENT_IMPORTERS = Object.freeze([
  // PRODUCTION / SCRIPT (4).
  "mcp/daemon/queryd.js", // GEMINI_CLIENT_CONSTANTS.GEMINI_EMBEDDING_MODEL_VERSION
  "mcp/lib/gemini-flash-client.js", // acquireGeminiKey (shared key pool)
  "mcp/lib/recall/rerank.js", // geminiKeyPoolSize (key-availability gate)
  "scripts/backfill-embeddings.mjs", // embedBatch + GEMINI_TASK_TYPES + constants
  // TESTS (9) — all dynamic `await import`, except throttled-structural-error
  // which uses the multi-line continuation shape.
  "mcp/test/gemini-client-key-pool.test.mjs",
  "mcp/test/gemini-client.test.mjs",
  "mcp/test/gemini-flash-client.test.mjs",
  "mcp/test/integration-phase3-v0.test.mjs",
  "mcp/test/integration-phase3-v1-rerank.test.mjs",
  "mcp/test/predicate-lifecycle.test.mjs",
  "mcp/test/rerank.test.mjs",
  "mcp/test/throttled-structural-error.test.mjs",
  "mcp/test/vector-math.test.mjs",
]);

function* censusWalk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir is not a signal
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (isScratchDirName(e.name) || CENSUS_SKIP_DIRS.has(e.name)) continue;
      yield* censusWalk(join(dir, e.name));
    } else if (e.isFile() && CENSUS_EXTS.some((x) => e.name.endsWith(x))) {
      yield join(dir, e.name);
    }
  }
}

await test(
  "R7: the set of gemini-client.js importers EQUALS the frozen allowlist (repo-wide, 4 import shapes)",
  async () => {
    let examined = 0;
    const sites = [];
    for (const abs of censusWalk(REPO_ROOT)) {
      examined += 1;
      const rel = relative(REPO_ROOT, abs).split(sep).join("/");
      let lines;
      try {
        lines = readFileSync(abs, "utf8").split("\n");
      } catch {
        continue;
      }
      for (let i = 0; i < lines.length; i += 1) {
        const code = censusCodePart(lines[i]);
        if (!code.includes("gemini-client.js")) continue;
        for (const [shape, re] of CENSUS_SHAPES) {
          if (re.test(code)) {
            sites.push({ rel, line: i + 1, shape, text: lines[i].trim() });
          }
        }
      }
    }

    const found = [...new Set(sites.map((s) => s.rel))].sort();
    const allowed = [...GEMINI_CLIENT_IMPORTERS].sort();
    const unexpected = found.filter((f) => !allowed.includes(f));
    const missing = allowed.filter((a) => !found.includes(a));

    if (unexpected.length > 0 || missing.length > 0) {
      const detail = [];
      for (const u of unexpected) {
        const s = sites.filter((x) => x.rel === u);
        detail.push(
          `UNEXPECTED importer ${u} -> ` +
            s.map((x) => `:${x.line} [${x.shape}] ${x.text}`).join(" ; "),
        );
      }
      for (const m of missing) {
        detail.push(
          `ALLOWLISTED but NOT FOUND ${m} (importer removed? update the allowlist in the same commit)`,
        );
      }
      fail(
        `R7 gemini-client.js importer set != frozen allowlist ` +
          `(${examined} files examined / ${sites.length} import sites classified across ${found.length} files)`,
        detail.join("\n        "),
      );
      return;
    }

    pass(
      `R7: ${examined} files examined / ${sites.length} import sites classified across ` +
        `${found.length} files — set equals the frozen allowlist`,
    );
  },
);

// ---------------------------------------------------------------------------
// 7. Hermeticity assertion + cleanup.
// ---------------------------------------------------------------------------
localMod._setFetchForTests(null);

const PROD_AFTER = {
  memory: snapshotPath(PROD_MEMORY_JSONL),
  indices: snapshotPath(PROD_INDICES_DIR),
};
if (
  PROD_BEFORE.memory !== PROD_AFTER.memory ||
  PROD_BEFORE.indices !== PROD_AFTER.indices
) {
  failures += 1;
  console.log(
    `  FAIL: hermeticity — production paths mutated: before=${JSON.stringify(PROD_BEFORE)} after=${JSON.stringify(PROD_AFTER)}`,
  );
} else {
  passes += 1;
  console.log("  pass: hermeticity — production tree paths byte-identical");
}

try {
  rmSync(TMP_ROOT, { recursive: true, force: true });
} catch {
  // best-effort
}

console.log("");
console.log(`embed-callers-migrate.test.mjs: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
process.exit(0);
