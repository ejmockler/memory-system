// ledger-streaming-recall.test.mjs — WU-RR2b-ledger-streaming regression gate.
//
// AUTHORITATIVE problem statement (WU-RR2b):
//   ledgers/memory.jsonl reached 1.78 GB (1.45M facts). Three recall-path
//   readers did readFileSync(ledgerPath, "utf8"), which throws
//   ERR_STRING_TOO_LONG ("Cannot create a string longer than 0x1fffffe8
//   characters") once the file crosses Node's ~512 MiB MAX_STRING_LENGTH —
//   BEFORE any candidate resolves. Recall therefore returned
//   candidate_set_size=0 for EVERY query even though BM25 (1.45M-fact index)
//   returned candidate ids. The crash is in candidate RESOLUTION, not
//   retrieval.
//
// THE FIX (this test guards):
//   1. index-cache.js
//        - NEW loadLedgerRowsByIds(idSet) streams ONLY the wanted rows.
//        - loadLedger() rewritten to stream (crash-safe) + SAFETY cap
//          (OOM-safe).
//   2. recall.js step (e) uses loadLedgerRowsByIds(neededIds) (scoped) and a
//      SECOND scoped stream for reconstructed candidates' derived_from parents.
//   3. hard-gates.loadDerivationExciseSet + multi-feature-score
//      .buildLatestBackfillMap stream the ledger instead of readFileSync.
//
// We cannot allocate a 1.78 GB string in CI, so we cannot reproduce the
// ERR_STRING_TOO_LONG directly. Instead we build a hermetic fixture ledger
// LARGER in row-count than a trivial case (2000+ fact rows + policy/backfill +
// a reconstructed row) and assert the STREAMING + SCOPING behavior that the
// fix introduces:
//   - loadLedgerRowsByIds returns ONLY the requested rows, not all 2000.
//   - loadLedger does not throw and materializes the rows (or the cap).
//   - hard-gates streams the fixture and builds reverseAdj for the
//     reconstructed row's derived_from.
//   - buildLatestBackfillMap streams + returns the right backfill overlay.
//   - Recall end-to-end on the fixture returns candidate_set_size>=1 and the
//     BM25-matched fact in memories[] (this is the load-bearing assertion: it
//     is exactly the path that returned 0 before the fix).
//
// HERMETICITY: mkdtempSync root + env vars set BEFORE any dynamic import of
// memory-system modules (standing C-NEW-2 pattern). GEMINI keys are unset so
// the recall handler's embed step fails fast (no network) and degrades to the
// BM25-only path — which still resolves candidates through the scoped reader.
// b4: the key scrub governs Layer-1 and the gemini Layer-3 backend only, so
// Layer-3 is ALSO pinned LOCAL_RERANKER_ENABLED="0" at the env seam below.
// Without it recall reached the live rerank daemon on :8360, which answered —
// making this paragraph's "no network" false AND turning the two Layer-3
// degrade assertions red for an environmental reason (see the seam comment).
// Production paths are snapshotted pre/post: append-tolerant on the ledger
// (external daemon appends pass; truncation/rewrite fail), strict elsewhere.

import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skipIfDaemonActive } from "../_hermetic-daemon-skip.mjs";

// Snapshot the production ledger + indices BEFORE we touch anything, so the
// final byte-identity guard is meaningful. (We never write production paths,
// but the snapshot makes that contract enforceable.)
skipIfDaemonActive("WU-RR2b ledger-streaming-recall");

// The checkout this suite runs from. Its default (un-overridden) ledgers,
// policy and indices are what the byte-identity guards below watch; the
// suite itself works under a temp MEMORY_ROOT.
const CHECKOUT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
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
// REG (memperf) — APPEND-TOLERANT production-ledger guard. The strict
// `${mtimeMs}:${size}` fingerprint flaked whenever an EXTERNAL process (the
// live watermark daemon promoting rows) appended to memory.jsonl mid-run —
// through no fault of the test. The guard now captures pre-run size + a
// sha256 over the first HEAD_SPAN bytes (bounded read; NEVER a full parse of
// the multi-GB ledger) and post-run asserts size same-or-grown AND head
// bytes unchanged: monotonic external appends pass, any truncation or
// in-place rewrite still fails. The test process's own hermeticity is
// asserted separately below (config-resolved paths pinned under TMP_ROOT).
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
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-rr2b-ledger-stream-"));
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
// Force the recall embed step to fail fast (no network): unset both key vars.
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;
// b4: unsetting the gemini keys does NOT stop Layer-3. _localRerankerEnabled()
// falls through to CAPS.LOCAL_RERANKER_ENABLED (true) when the var is UNSET,
// which skips the gemini key gate and sends the default backend at _baseUrl()
// to the LIVE rerank daemon on :8360 — which answered, so the two Layer-3
// degrade assertions below observed degraded_recall_layer3=false /
// rerank_failed_reason=null and failed. "0" is the tri-state OFF override (a
// `delete` is inert against a true CAP) and restores the api_key_missing
// degrade this file has always asserted, with no socket.
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
const { memoryLedgerPath } = await import("../../lib/config.js");
const indexCacheMod = await import("../../lib/recall/index-cache.js");
const { loadLedger, loadLedgerRowsByIds, saveIndices, _resetCaches } =
  indexCacheMod;
const {
  loadDerivationExciseSet,
  loadDerivationGraph,
  _resetTransitiveOrphanCaches,
} = await import("../../lib/recall/hard-gates.js");
const { buildLatestBackfillMap } = await import(
  "../../lib/recall/multi-feature-score.js"
);
const { FEATURE_BACKFILL_KIND } = await import(
  "../../lib/synthesis/feature-backfill.js"
);
const { Bm25Index } = await import("../../lib/recall/bm25-index.js");
const { HnswIndex } = await import("../../lib/recall/hnsw-index.js");
const { CAPS } = await import("../../lib/validation.js");
// l5-fallback-removal — see the MODEL_VERSION note below; this fixture is
// keyed to the ACTIVE embed model now, so GEMINI_CLIENT_CONSTANTS has no
// reader left in this file.
const recallMod = await import("../../lib/tools/recall.js");

// l5-fallback-removal — this fixture is keyed to the ACTIVE embed model. It
// used to be keyed to GEMINI_CLIENT_CONSTANTS.GEMINI_EMBEDDING_MODEL_VERSION
// and reached recall ONLY through the both-active-trees-empty legacy-coverage
// fallback branch in recall.js step c. With that branch deleted a legacy-keyed
// index is never loaded, so the recall section came back with
// candidate_set_size=0 and an empty memories[]. Re-keyed to the active
// version; the row labels ride along because they all read MODEL_VERSION, so
// the hard-gates exclusion comparison stays self-consistent.
const MODEL_VERSION = CAPS.ACTIVE_EMBED_MODEL_VERSION;

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
// Build a fixture ledger LARGER in row-count than a trivial case.
//   - 2000 filler fact rows (bulk_0000 .. bulk_1999)
//   - a few known-id fact rows with distinctive BM25-matchable content
//   - 2 policy.feature_backfill rows targeting a known fact (latest-wins)
//   - 1 reconstructed row with derived_from -> a known parent fact
//   - 1 policy.excise row seeding the derivation reverse-adjacency check
// ---------------------------------------------------------------------------
const TS = "2026-06-01T00:00:00.000Z";
const KNOWN_QUERY_FACT_ID = "fact_known_quokka";
const PARENT_FACT_ID = "fact_parent_alpha";
const RECON_ID = "recon_zeta";
const BACKFILL_TARGET_ID = "fact_backfill_target";
const EXCISE_SEED_ID = "fact_excise_seed";

function factRow(id, content, extra = {}) {
  return {
    id,
    kind: "fact",
    content,
    created_at: TS,
    ts: TS,
    source_refs: [{ source: "test", consent_basis: "first_party" }],
    features: { embedding_model_version: MODEL_VERSION },
    ...extra,
  };
}

const rows = [];
// 2000 filler facts. Their content shares no tokens with the probe query so
// they do not pollute the BM25 result for the known fact.
for (let i = 0; i < 2000; i++) {
  const id = `bulk_${String(i).padStart(4, "0")}`;
  rows.push(factRow(id, `filler ledger row number ${i} padding padding`));
}
// Known fact the probe query targets (distinctive token: "quokka").
rows.push(
  factRow(
    KNOWN_QUERY_FACT_ID,
    "the rare quokka marsupial smiled at the camera on rottnest island",
  ),
);
// Parent fact referenced by the reconstructed row's derived_from.
rows.push(factRow(PARENT_FACT_ID, "alpha parent fact content for derivation"));
// Backfill-target fact.
rows.push(
  factRow(BACKFILL_TARGET_ID, "backfill target fact awaiting feature overlay"),
);
// Excise-seed fact (its id is the excise target; the reconstructed row derives
// from PARENT_FACT_ID, and EXCISE_SEED_ID is a separate direct excise target —
// we assert reverseAdj keys, see below).
rows.push(factRow(EXCISE_SEED_ID, "excise seed fact content"));

// Reconstructed row with derived_from -> PARENT_FACT_ID + EXCISE_SEED_ID.
rows.push({
  id: RECON_ID,
  kind: "reconstructed",
  content: "reconstructed synthesis derived from alpha and seed quokka note",
  created_at: TS,
  ts: TS,
  derived_from: [PARENT_FACT_ID, EXCISE_SEED_ID],
  source_refs: [{ source: "test", consent_basis: "first_party" }],
  features: { embedding_model_version: MODEL_VERSION },
});

// Two policy.feature_backfill rows for BACKFILL_TARGET_ID — latest-wins by
// backfill_version (v2 should win over v1).
rows.push({
  id: "policy_backfill_v1",
  kind: "policy",
  policy_kind: FEATURE_BACKFILL_KIND,
  target_fact_id: BACKFILL_TARGET_ID,
  backfill_version: 1,
  ts: "2026-06-01T00:00:01.000Z",
  payload: { note: "v1" },
});
rows.push({
  id: "policy_backfill_v2",
  kind: "policy",
  policy_kind: FEATURE_BACKFILL_KIND,
  target_fact_id: BACKFILL_TARGET_ID,
  backfill_version: 2,
  ts: "2026-06-01T00:00:02.000Z",
  payload: { note: "v2" },
});

// One policy.excise row seeding the direct-excise set.
rows.push({
  id: "policy_excise_1",
  kind: "policy",
  policy_kind: "excise",
  targets: [EXCISE_SEED_ID],
  ts: "2026-06-01T00:00:03.000Z",
});

function writeFixtureLedger() {
  const path = memoryLedgerPath();
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path, body, { mode: 0o600 });
  _resetCaches();
  _resetTransitiveOrphanCaches();
}
writeFixtureLedger();

const TOTAL_ROWS = rows.length;
check(
  "fixture: ledger has >2000 rows (non-trivial)",
  TOTAL_ROWS > 2000,
  `got ${TOTAL_ROWS}`,
);

// ===========================================================================
// 1. loadLedgerRowsByIds returns ONLY the requested rows (scoped stream).
// ===========================================================================
{
  const wanted = new Set([KNOWN_QUERY_FACT_ID, PARENT_FACT_ID, RECON_ID]);
  const scoped = loadLedgerRowsByIds(wanted);
  check(
    "loadLedgerRowsByIds returns a byId Map",
    scoped && scoped.byId instanceof Map,
  );
  check(
    "loadLedgerRowsByIds resolves exactly the 3 wanted ids (not all 2000+)",
    scoped.byId.size === 3,
    `got ${scoped.byId.size}`,
  );
  check(
    "loadLedgerRowsByIds resolves the known fact row content",
    scoped.byId.get(KNOWN_QUERY_FACT_ID)?.content?.includes("quokka") === true,
  );
  check(
    "loadLedgerRowsByIds resolves the reconstructed row (kind preserved, not fact-only)",
    scoped.byId.get(RECON_ID)?.kind === "reconstructed",
  );
  check(
    "loadLedgerRowsByIds does NOT include a non-requested filler id",
    scoped.byId.has("bulk_0001") === false,
  );
  const empty = loadLedgerRowsByIds(new Set());
  check(
    "loadLedgerRowsByIds with empty set returns empty Map",
    empty.byId instanceof Map && empty.byId.size === 0,
  );
  const arrForm = loadLedgerRowsByIds([KNOWN_QUERY_FACT_ID]);
  check(
    "loadLedgerRowsByIds tolerates array input",
    arrForm.byId.size === 1 && arrForm.byId.has(KNOWN_QUERY_FACT_ID),
  );
}

// ===========================================================================
// 2. loadLedger() does not throw on the fixture; returns the rows.
// ===========================================================================
{
  let threw = false;
  let ledger = null;
  try {
    ledger = loadLedger();
  } catch (e) {
    threw = true;
    console.error(`loadLedger threw: ${e && e.message}`);
  }
  check("loadLedger() does not throw on the fixture", threw === false);
  check(
    "loadLedger() materializes all fixture rows into byId",
    ledger != null && ledger.byId instanceof Map && ledger.byId.size === TOTAL_ROWS,
    ledger ? `got ${ledger.byId.size} want ${TOTAL_ROWS}` : "no ledger",
  );
  check(
    "loadLedger().all has the same count as byId",
    ledger != null && Array.isArray(ledger.all) && ledger.all.length === TOTAL_ROWS,
  );
  check(
    "loadLedger() resolves the known fact via byId",
    ledger != null && ledger.byId.get(KNOWN_QUERY_FACT_ID)?.id === KNOWN_QUERY_FACT_ID,
  );
}

// ===========================================================================
// 3. hard-gates streams the fixture: loadDerivationExciseSet resolves the
//    direct excise target, and loadDerivationGraph exposes the reverseAdj
//    built by the same streamed scan — including the reconstructed row's
//    derived_from edges (PARENT_FACT_ID -> RECON_ID, EXCISE_SEED_ID -> RECON_ID).
// ===========================================================================
{
  let exciseSet = null;
  let reverseAdj = null;
  let threw = false;
  try {
    exciseSet = await loadDerivationExciseSet();
    reverseAdj = await loadDerivationGraph();
  } catch (e) {
    threw = true;
    console.error(`hard-gates scan threw: ${e && e.message}`);
  }
  check("hard-gates streams the fixture ledger without throwing", threw === false);
  check("loadDerivationExciseSet returns a Set", exciseSet instanceof Set);
  check(
    "loadDerivationExciseSet resolves the direct excise target from the streamed policy.excise row",
    exciseSet instanceof Set && exciseSet.has(EXCISE_SEED_ID),
    exciseSet instanceof Set ? `set=${[...exciseSet].join(",")}` : "no set",
  );
  // reverseAdj: Map<ancestor_id, Set<descendant_id>>. The reconstructed row's
  // two derived_from parents each get a reverse edge to RECON_ID.
  check(
    "loadDerivationGraph (streamed scan) returns the reverseAdj Map",
    reverseAdj instanceof Map,
  );
  check(
    "reverseAdj has an edge PARENT_FACT_ID -> RECON_ID from the reconstructed row's derived_from",
    reverseAdj instanceof Map &&
      reverseAdj.get(PARENT_FACT_ID) instanceof Set &&
      reverseAdj.get(PARENT_FACT_ID).has(RECON_ID),
  );
  check(
    "reverseAdj has an edge EXCISE_SEED_ID -> RECON_ID from the reconstructed row's derived_from",
    reverseAdj instanceof Map &&
      reverseAdj.get(EXCISE_SEED_ID) instanceof Set &&
      reverseAdj.get(EXCISE_SEED_ID).has(RECON_ID),
  );
}

// ===========================================================================
// 4. buildLatestBackfillMap streams + returns the latest overlay for the
//    right target_fact_id (v2 wins over v1).
// ===========================================================================
{
  let map = null;
  let threw = false;
  try {
    map = buildLatestBackfillMap(memoryLedgerPath());
  } catch (e) {
    threw = true;
    console.error(`buildLatestBackfillMap threw: ${e && e.message}`);
  }
  check("buildLatestBackfillMap streams the fixture without throwing", threw === false);
  check("buildLatestBackfillMap returns a Map", map instanceof Map);
  const overlay = map instanceof Map ? map.get(BACKFILL_TARGET_ID) : null;
  check(
    "buildLatestBackfillMap keyed the right target_fact_id",
    overlay != null,
  );
  check(
    "buildLatestBackfillMap selected the latest backfill_version (v2 wins)",
    overlay != null && overlay.backfill_version === 2,
    overlay ? `got v${overlay.backfill_version}` : "no overlay",
  );
  check(
    "buildLatestBackfillMap does NOT key a non-backfill fact id",
    map instanceof Map && map.has(KNOWN_QUERY_FACT_ID) === false,
  );
}

// ===========================================================================
// 5. Recall end-to-end on the fixture: build a BM25 index over the fixture
//    facts, save indices, then run the recall handler. A query that
//    BM25-matches the known fact must return candidate_set_size>=1 and the
//    known fact in memories[]. This is the path that returned 0 before the fix.
// ===========================================================================
{
  // Build BM25 over the fact + reconstructed rows.
  const bm25 = new Bm25Index();
  for (const r of rows) {
    if (r.kind !== "fact" && r.kind !== "reconstructed") continue;
    bm25.add({
      memory_id: r.id,
      content: r.content,
      kind: r.kind,
      ts: r.ts,
      entities: [],
    });
  }
  // Empty HNSW (no embeddings) — the degraded BM25-only path ignores it.
  const hnsw = new HnswIndex({
    // Active-model geometry, matching the version this tree is saved under.
    // Still EMPTY: the degraded BM25-only path under test never searches it.
    dims: CAPS.EMBEDDING_DIM_4096,
    embedding_model_version: MODEL_VERSION,
  });
  saveIndices(MODEL_VERSION, { bm25, hnsw });
  _resetCaches();

  // Sanity: BM25 alone finds the known fact for the probe query.
  const bm25Hits = bm25.search("quokka marsupial rottnest", 50);
  check(
    "BM25 fixture index returns the known fact id for the probe query",
    bm25Hits.some((h) => h.memory_id === KNOWN_QUERY_FACT_ID),
    `hits=${bm25Hits.map((h) => h.memory_id).slice(0, 5).join(",")}`,
  );

  let env = null;
  let threw = false;
  try {
    env = await recallMod.TOOL.handler({
      surrounding_context: {
        current_query: "tell me about the quokka marsupial on rottnest",
        recent_turns: [{ role: "user", content: "quokka facts please" }],
        agent_role: "assistant",
        time: "2026-06-02T12:00:00.000Z",
        ambient: null,
        recent_recall_ids: [],
      },
      conversation_id: "conv_rr2b_stream",
      max_items: 12,
      max_chars: 4000,
    });
  } catch (e) {
    threw = true;
    console.error(`recall handler threw: ${e && e.stack ? e.stack : e}`);
  }
  check("recall handler does not throw on the fixture ledger", threw === false);
  check(
    "recall handler returns an ok envelope",
    env != null && env.ok === true,
    env ? JSON.stringify(env).slice(0, 300) : "no env",
  );
  const data = env && env.data ? env.data : {};
  // degraded_recall is EXPECTED here (no Gemini key) — BM25-only is the path
  // under test. The fix is proven by candidate resolution succeeding anyway.
  check(
    "recall degraded to BM25-only (no Gemini key) as designed",
    data.degraded_recall === true,
  );
  // F1 (memperf): with both key vars scrubbed and candidate_set_size >= 1,
  // rerank IS attempted and gate-degrades — the PUBLIC payload must mark the
  // layer3 degrade AND surface its reason (pre-fix: rerank_failed_reason was
  // stored only in the ledger event; the response field was undefined).
  check(
    "recall response marks layer3 degraded",
    data.degraded_recall_layer3 === true,
    `degraded_recall_layer3=${data.degraded_recall_layer3}`,
  );
  check(
    "recall response surfaces rerank_failed_reason",
    data.rerank_failed_reason === "api_key_missing",
    `rerank_failed_reason=${data.rerank_failed_reason}`,
  );
  check(
    "recall candidate_set_size >= 1 (was 0 before the streaming fix)",
    typeof data.candidate_set_size === "number" && data.candidate_set_size >= 1,
    `candidate_set_size=${data.candidate_set_size}`,
  );
  const memIds = Array.isArray(data.memories)
    ? data.memories.map((m) => m.id)
    : [];
  check(
    "recall surfaces the BM25-matched known fact in memories[]",
    memIds.includes(KNOWN_QUERY_FACT_ID),
    `memories=${memIds.slice(0, 8).join(",")}`,
  );
}

// ===========================================================================
// 6. Production-path guard (hermeticity invariant, append-tolerant — REG).
// ===========================================================================
{
  // The test process itself must be incapable of writing production paths:
  // every write in this file goes through the config-resolved seams, so
  // pinning those under TMP_ROOT is the process-local no-write proof (the
  // external-append tolerance below never excuses a write from HERE).
  check(
    "test-process ledger path is hermetic (config resolves under TMP_ROOT, never production)",
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
    "production memory.jsonl never truncated (size same-or-grown; external appends tolerated)",
    after.memorySize >= PROD_BEFORE.memorySize,
    `before=${PROD_BEFORE.memorySize} after=${after.memorySize}`,
  );
  check(
    "production memory.jsonl head bytes unchanged (no rewrite)",
    after.memoryHead === PROD_BEFORE.memoryHead,
    `before=${PROD_BEFORE.memoryHead} after=${after.memoryHead}`,
  );
  check(
    "production indices/ untouched (byte-identical mtime:size)",
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
console.log("all WU-RR2b ledger-streaming-recall tests passed");
