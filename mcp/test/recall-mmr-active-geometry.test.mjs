// recall-mmr-active-geometry.test.mjs — B1b regression gate (MMR + density
// flag on active-geometry resolved vectors).
//
// AUTHORITATIVE problem statement (B1 Claim 2, CONFIRMED):
//   Layer-4 MMR (recall.js mmrInput), the brief `enriched` projection, and the
//   density flag's selectedForDensity ALL read candidate.embedding_3072 — a
//   field 0% of sampled live rows carry post WU-recall-flip-to-local-4096
//   (ingest writes embedding_4096). Every MMR vector is therefore a 3072-dim
//   zero stub, all pairwise similarities are 0, and MMR degenerates to pure
//   relevance ordering: near-duplicate memories fill the brief.
//
// THE FIX (this test guards): the _resolveCandidateEmbedding result already
// computed for s_emb in the scoring loop is hoisted onto the scored entry as
// resolved_embedding and threaded into mmrInput / enriched /
// selectedForDensity; the zero-stub length becomes the QUERY dim
// (firstSegmentVec3072.length — 4096 on the primary local path), not the
// hardcoded Gemini 3072.
//
// FIXTURE GEOMETRY (deterministic, exact): 4096-dim unit vectors built in a
// 3-axis subspace (spikes at indices 7/11/23). Query q = e0.
//   dupA     = 0.97 e0 + sqrt(1-0.97^2) e1   (cos to q = 0.97)
//   dupB     = 0.96 e0 + sqrt(1-0.96^2) e1   (cos to q = 0.96; cos(dupA,dupB)
//                                             = 0.9993 — near-duplicate)
//   distinct = 0.94 e0 + sqrt(1-0.94^2) e2   (cos to q = 0.94; cos to dupA
//                                             = 0.9118 — off the dup plane)
// Relevance order (final_score, driven by s_emb; all additive features equal
// across the fixture) is (dupA, dupB, distinct). MMR lambda=0.7 over the REAL
// vectors must reorder to (dupA, distinct, dupB):
//   step 2:  0.7*(score_dupB - score_distinct) <= 0.7*0.02*epis(0.5) = 0.007
//          < 0.3*(cos(dupB,dupA) - cos(distinct,dupA)) = 0.3*0.0875 = 0.026.
// PRE-FIX FAILURE MODE (recorded red run): zero stubs make every pairwise sim
// 0, so the brief preserves pure relevance order (dupA, dupB, distinct) and
// density_flag stays "ok" (avg pairwise cosine identically 0).
// POST-FIX: brief order (dupA, distinct, dupB); density_flag "crowded" (avg
// pairwise cosine 0.9378 > DENSITY_FLAG_PAIRWISE_COSINE_THRESHOLD 0.85).
//
// HERMETICITY: mkdtempSync root + env vars set BEFORE any dynamic import of
// memory-system modules (standing C-NEW-2 pattern, copied from
// test/synthesis/recall-local-4096-query.test.mjs). The local embed fetch is
// MOCKED via local-embedder-client._setFetchForTests (no live server); GEMINI
// keys are scrubbed and LOCAL_RERANKER_ENABLED is pinned to "0" so Layer-3
// rerank degrades to the deterministic final_score sort without dialing the
// live :8360 rerank server. Production paths are snapshotted pre/post:
// append-tolerant on the ledger (external daemon appends pass; truncation/
// rewrite fail), strict elsewhere.
//
// Run: node test/recall-mmr-active-geometry.test.mjs

import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { skipIfDaemonActive } from "./_hermetic-daemon-skip.mjs";

skipIfDaemonActive("B1b recall-mmr-active-geometry");

// Checkout root, derived from this file's location (never from MEMORY_ROOT,
// which this suite redirects to a temp tree).
const CHECKOUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROD_MEMORY_JSONL = join(CHECKOUT_ROOT, "ledgers", "memory.jsonl");
const PROD_INDICES_DIR = join(CHECKOUT_ROOT, "indices");
function snap(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
// REG (memperf) — APPEND-TOLERANT production-ledger guard (see
// test/recall/ledger-streaming-recall.test.mjs for the full rationale): the
// strict mtime:size fingerprint flaked on external watermark-daemon appends.
// Pre-run size + head-hash (sha256 over the first HEAD_SPAN bytes; bounded
// read, never a full ledger parse); post-run size same-or-grown AND head
// unchanged — truncation/rewrite still fail. The test process's own
// hermeticity is asserted separately (config paths pinned under TMP_ROOT).
const HEAD_SPAN = 65536;
function headHash(p, span = HEAD_SPAN) {
  let fd;
  try {
    fd = openSync(p, "r");
  } catch {
    return "missing";
  }
  try {
    const len = Math.min(span, fstatSync(fd).size);
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, off);
      if (n === 0) break;
      off += n;
    }
    return createHash("sha256").update(buf.subarray(0, off)).digest("hex");
  } catch {
    return "unreadable";
  } finally {
    closeSync(fd);
  }
}
function sizeOf(p) {
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
}
const PROD_BEFORE = {
  memorySize: sizeOf(PROD_MEMORY_JSONL),
  memoryHead: headHash(PROD_MEMORY_JSONL),
  indices: snap(PROD_INDICES_DIR),
};

// ---------------------------------------------------------------------------
// Hermetic root + env BEFORE dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-b1b-mmr-geometry-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(MEMORY_ROOT, "policy");
const STORAGE_DIR = join(MEMORY_ROOT, "storage");
const LEDGERS_DIR = join(MEMORY_ROOT, "ledgers");
const INDICES_DIR = join(MEMORY_ROOT, "indices");
for (const d of [POLICY_DIR, STORAGE_DIR, LEDGERS_DIR, INDICES_DIR]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;
// Scrub every non-deterministic rerank/embed surface: Gemini keys gone (Flash
// rerank degrades to final_score sort) and the local reranker forced OFF.
// b4: CAPS.LOCAL_RERANKER_ENABLED ships TRUE, so a `delete` here was inert —
// _localRerankerEnabled() falls through to the CAP when the var is unset, and
// this suite would dial the live :8360 server. An explicit "0" is the OFF
// override that the tri-state resolver honours over the CAP.
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;
process.env.LOCAL_RERANKER_ENABLED = "0";

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// Dynamic imports AFTER env override.
// ---------------------------------------------------------------------------
const { memoryLedgerPath, recallLedgerPath } = await import("../lib/config.js");
const { saveIndices, _resetCaches } = await import(
  "../lib/recall/index-cache.js"
);
const { _resetTransitiveOrphanCaches } = await import(
  "../lib/recall/hard-gates.js"
);
const { Bm25Index } = await import("../lib/recall/bm25-index.js");
const { HnswIndex } = await import("../lib/recall/hnsw-index.js");
const { CAPS } = await import("../lib/validation.js");
const { _setFetchForTests } = await import("../lib/local-embedder-client.js");
const recallMod = await import("../lib/tools/recall.js");

const ACTIVE_VERSION = CAPS.ACTIVE_EMBED_MODEL_VERSION;
const DIM = CAPS.EMBEDDING_DIM_4096; // 4096 — the active query geometry

// ---------------------------------------------------------------------------
// Tiny assertion harness.
// ---------------------------------------------------------------------------
let failures = 0;
let passes = 0;
function check(label, cond, detail) {
  if (cond) {
    passes += 1;
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Deterministic 4096-dim unit vectors in a 3-axis subspace.
// ---------------------------------------------------------------------------
const Q_AXIS = 7; // query direction
const DUP_AXIS = 11; // shared off-query component of the near-duplicate pair
const DIST_AXIS = 23; // off-query component of the distinct candidate

function subspaceVec(queryComponent, offAxis) {
  const v = new Array(DIM).fill(0);
  v[Q_AXIS] = queryComponent;
  v[offAxis] = Math.sqrt(1 - queryComponent * queryComponent);
  return v;
}

const QUERY_VEC = (() => {
  const v = new Array(DIM).fill(0);
  v[Q_AXIS] = 1;
  return v;
})();
const VEC_DUP_A = subspaceVec(0.97, DUP_AXIS); // cos(q)=0.97
const VEC_DUP_B = subspaceVec(0.96, DUP_AXIS); // cos(q)=0.96; cos(dupA)=0.9993
const VEC_DISTINCT = subspaceVec(0.94, DIST_AXIS); // cos(q)=0.94; cos(dupA)=0.9118

const DUP_A_ID = "fact_dup_alpha";
const DUP_B_ID = "fact_dup_bravo";
const DISTINCT_ID = "fact_distinct";

// ---------------------------------------------------------------------------
// Local-embed mock: the recall query embeds to QUERY_VEC (unit spike at e0).
// ---------------------------------------------------------------------------
_setFetchForTests(async (url, init) => {
  const body = JSON.parse(init.body);
  const texts = Array.isArray(body.texts) ? body.texts : [];
  return {
    ok: true,
    async text() {
      return JSON.stringify({
        embeddings: texts.map(() => QUERY_VEC),
        model_version: ACTIVE_VERSION,
        dim: DIM,
        count: texts.length,
        elapsed_ms: 1,
      });
    },
  };
});

// ---------------------------------------------------------------------------
// Fixture ledger: identical ts + no entities/valence, so every additive
// feature is EQUAL across the three rows and final_score order is exactly the
// s_emb order (dupA > dupB > distinct). Distinct content suffixes keep
// content-dedup a pass-through and BM25 retrieval covers all rows.
// ---------------------------------------------------------------------------
const TS = "2026-06-01T00:00:00.000Z";

function factRow(id, content, embedding) {
  return {
    id,
    kind: "fact",
    content,
    created_at: TS,
    ts: TS,
    source_refs: [{ source: "test", consent_basis: "first_party" }],
    features: {
      embedding_model_version: ACTIVE_VERSION,
      embedding_4096: embedding,
    },
  };
}

const rows = [
  factRow(DUP_A_ID, "quokka rottnest marsupial sighting note alpha", VEC_DUP_A),
  factRow(DUP_B_ID, "quokka rottnest marsupial sighting note bravo", VEC_DUP_B),
  factRow(
    DISTINCT_ID,
    "quokka rottnest marsupial ferry logistics distinct",
    VEC_DISTINCT,
  ),
];

writeFileSync(
  memoryLedgerPath(),
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  { mode: 0o600 },
);

// Active 4096 index tree: BM25 over content + HNSW at each row's vector.
const bm25 = new Bm25Index();
const hnsw = new HnswIndex({
  dims: DIM,
  embedding_model_version: ACTIVE_VERSION,
});
for (const r of rows) {
  bm25.add({
    memory_id: r.id,
    content: r.content,
    kind: r.kind,
    ts: r.ts,
    entities: [],
  });
  hnsw.add(r.id, r.features.embedding_4096);
}
saveIndices(ACTIVE_VERSION, { bm25, hnsw });
_resetCaches();
_resetTransitiveOrphanCaches();

// ---------------------------------------------------------------------------
// End-to-end recall. Query carries no time expressions/entities; ranking is
// s_emb-dominated (all other features equal by construction).
// ---------------------------------------------------------------------------
let env = null;
let threw = false;
try {
  env = await recallMod.TOOL.handler({
    surrounding_context: {
      current_query: "tell me about the quokka rottnest marsupial notes",
      recent_turns: [{ role: "user", content: "quokka rottnest facts please" }],
      agent_role: "assistant",
      time: "2026-06-02T12:00:00.000Z",
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: "conv_b1b_mmr_geometry",
    max_items: 12,
    max_chars: 4000,
  });
} catch (e) {
  threw = true;
  console.error(`recall handler threw: ${e && e.stack ? e.stack : e}`);
} finally {
  _setFetchForTests(null);
}

// (a) envelope + non-degraded local 4096 path.
check("recall handler does not throw on the fixture ledger", threw === false);
check(
  "(a) recall returns ok envelope",
  env != null && env.ok === true,
  env ? JSON.stringify(env).slice(0, 300) : "no env",
);
const data = env && env.data ? env.data : {};
check(
  "(a) local 4096 path is live (degraded_recall === false)",
  data.degraded_recall === false,
  `degraded_recall=${data.degraded_recall}`,
);

// (b) fixture precondition — RELEVANCE order is (dupA, dupB, distinct). Reads
// the score-sorted candidates_pre_truncation off the persisted recall event,
// so it holds on BOTH pre-fix and post-fix code (an honest-gate control: if
// this fails, the fixture never produced the relevance order the MMR
// assertion below claims to reorder).
let event = null;
try {
  const lines = readFileSync(recallLedgerPath(), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  event = JSON.parse(lines[lines.length - 1]);
} catch (e) {
  console.error(`could not read recall ledger event: ${e && e.message}`);
}
check("recall event persisted to recall.jsonl", event != null);
const preIds =
  event && Array.isArray(event.candidates_pre_truncation)
    ? event.candidates_pre_truncation.map((c) => c.memory_id)
    : [];
check(
  "(b) relevance (final_score) order is dupA, dupB, distinct",
  preIds.length === 3 &&
    preIds[0] === DUP_A_ID &&
    preIds[1] === DUP_B_ID &&
    preIds[2] === DISTINCT_ID,
  `candidates_pre_truncation=${preIds.join(",")}`,
);

// (c) THE RED ASSERTION — MMR over the REAL 4096 vectors must break up the
// near-duplicate pair: brief order (dupA, distinct, dupB). Pre-fix the zero
// stubs preserve pure relevance order (dupA, dupB, distinct).
const memIds = Array.isArray(data.memories) ? data.memories.map((m) => m.id) : [];
check(
  "(c) MMR reorders the brief to dupA, distinct, dupB (diversity term live)",
  memIds.length === 3 &&
    memIds[0] === DUP_A_ID &&
    memIds[1] === DISTINCT_ID &&
    memIds[2] === DUP_B_ID,
  `memories=${memIds.join(",")}`,
);
const surfacedIds =
  event && Array.isArray(event.surfaced)
    ? event.surfaced.map((s) => s.memory_id)
    : [];
check(
  "(c) recall event surfaced[] records the same MMR order",
  surfacedIds.length === 3 &&
    surfacedIds[0] === DUP_A_ID &&
    surfacedIds[1] === DISTINCT_ID &&
    surfacedIds[2] === DUP_B_ID,
  `surfaced=${surfacedIds.join(",")}`,
);

// (d) density flag — selectedForDensity must see the resolved vectors too:
// avg pairwise cosine over {dupA, dupB, distinct} = 0.9378 > threshold 0.85
// -> "crowded". Pre-fix the zero stubs give avg 0 -> "ok".
check(
  '(d) density_flag is "crowded" (avg pairwise cosine over real vectors)',
  event != null && event.density_flag === "crowded",
  `density_flag=${event ? event.density_flag : "no event"}`,
);

// (e) production-path guard (hermeticity invariant, append-tolerant — REG).
{
  check(
    "(e) test-process ledger path is hermetic (config resolves under TMP_ROOT, never production)",
    memoryLedgerPath().startsWith(TMP_ROOT) &&
      memoryLedgerPath() !== PROD_MEMORY_JSONL,
    `memoryLedgerPath()=${memoryLedgerPath()}`,
  );
  const after = {
    memorySize: sizeOf(PROD_MEMORY_JSONL),
    memoryHead: headHash(PROD_MEMORY_JSONL),
    indices: snap(PROD_INDICES_DIR),
  };
  check(
    "(e) production memory.jsonl never truncated (size same-or-grown; external appends tolerated)",
    after.memorySize >= PROD_BEFORE.memorySize,
    `before=${PROD_BEFORE.memorySize} after=${after.memorySize}`,
  );
  check(
    "(e) production memory.jsonl head bytes unchanged (no rewrite)",
    after.memoryHead === PROD_BEFORE.memoryHead,
    `before=${PROD_BEFORE.memoryHead} after=${after.memoryHead}`,
  );
  check(
    "(e) production indices/ untouched (mtime:size identical)",
    after.indices === PROD_BEFORE.indices,
    `before=${PROD_BEFORE.indices} after=${after.indices}`,
  );
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
  process.exit(1);
}
console.log("all B1b recall-mmr-active-geometry tests passed");
