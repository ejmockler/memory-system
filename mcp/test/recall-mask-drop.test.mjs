// recall-mask-drop.test.mjs — B1a regression gate (consent-mask hard drop at
// Layer-2 output).
//
// AUTHORITATIVE problem statement (B1 Claim 1, CONFIRMED):
//   applyHardGates sets predicate_mask=0 + dropped_reason="consent_blocked"
//   for consent-blocked candidates but RETURNS them; computeScore zeroes only
//   the multiplicative branch — the additive branch (entity 0.7 + time-anchor
//   1.5 + decay 0.3 + valence 0.2) is unmasked, so a recently-blocked memory
//   outranks clean candidates and flows through sort → dedup → Flash rerank →
//   MMR → the surfaced brief. Likewise dropped_by_additive_floor is computed
//   by computeScore and consumed NOWHERE.
//
// THE FIX (this test guards): a partition at Layer-2 output (post-sort,
// pre-dedup) hard-drops predicate_mask=0 and dropped_by_additive_floor
// candidates from the surfaceable set. The dropped set is RETAINED in the
// recall event's candidates_pre_truncation with full drop provenance
// (dropped_at_layer2_output, predicate_mask, dropped_by_additive_floor,
// dropped_reason) so off-policy estimators keep seeing it, plus an additive
// layer2_dropped_count on the event.
//
// FIXTURE RANKING MODEL (deterministic, degraded BM25-only path): GEMINI key
// vars are scrubbed so s_emb=0 for every candidate; the probe query carries no
// time expressions (no resolved time anchor) and fixture rows carry no
// entities/valence — so ranking reduces to SCORE_WEIGHT_TIME_DECAY (0.3) ×
// power_law_decay, strictly monotonic in recency. MASKED (ts = 1h ago) ranks
// #1 pre-fix above 5 clean facts (ts 2025-01-01). FLOOR (embed_state:true,
// both embeddings null → fallback branch; ts 2015-01-01 → 0.3×decay ≈ 0.086 <
// RECALL_ADDITIVE_FLOOR_FALLBACK 0.10) trips dropped_by_additive_floor.
//
// HERMETICITY: mkdtempSync root + env vars set BEFORE any dynamic import of
// memory-system modules (standing C-NEW-2 pattern, copied from
// test/recall/ledger-streaming-recall.test.mjs). Production paths are
// snapshotted pre/post: append-tolerant on the ledger (external daemon
// appends pass; truncation/rewrite fail), strict elsewhere.

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

skipIfDaemonActive("B1a recall-mask-drop");

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
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-b1a-mask-drop-"));
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
// The BM25-only degraded path makes ranking purely additive → deterministic.
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;
// b4: Layer-3 needs its own OFF switch — unsetting the gemini keys is not
// enough. _localRerankerEnabled() falls through to CAPS.LOCAL_RERANKER_ENABLED
// (true) when the var is UNSET, which skips the gemini key gate entirely and
// sends the default backend at _baseUrl() to the LIVE rerank daemon on :8360.
// The explicit "0" is the tri-state OFF override that beats the CAP; a
// `delete` would be inert. Restores the api_key_missing degrade, zero sockets.
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
const { Bm25Index } = await import("../lib/recall/bm25-index.js");
const { HnswIndex } = await import("../lib/recall/hnsw-index.js");
const { CAPS } = await import("../lib/validation.js");
const recallMod = await import("../lib/tools/recall.js");

// l5-fallback-removal — this section's fixture is keyed to the ACTIVE embed
// model, not the legacy Gemini one. It used to be keyed to
// GEMINI_CLIENT_CONSTANTS.GEMINI_EMBEDDING_MODEL_VERSION and reached recall
// ONLY through the both-active-trees-empty legacy-coverage fallback branch in
// recall.js step c; with that branch deleted, a legacy-keyed index is never
// loaded and sections (a)-(e) came back empty (measured: 88 passed/0 failed ->
// 77 passed/11 failed). Re-keyed to the SAME constant the queryd section below
// already uses (CAPS.ACTIVE_EMBED_MODEL_VERSION) rather than a second
// mechanism; the row labels ride along because they all read MODEL_VERSION, so
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
// Fixture ledger: 5 clean facts + 1 consent-blocked + 1 additive-floor row.
// Every content string shares the probe tokens ("quokka rottnest marsupial")
// plus a unique per-row suffix so content-dedup never collapses them and BM25
// retrieves all rows for the probe query.
// ---------------------------------------------------------------------------
const NOW_MS = Date.now();
const CTX_TIME = new Date(NOW_MS).toISOString();
const MASKED_TS = new Date(NOW_MS - 3600 * 1000).toISOString(); // 1h ago
const CLEAN_TS = "2025-01-01T00:00:00.000Z";
const FLOOR_TS = "2015-01-01T00:00:00.000Z"; // very old: 0.3*decay < 0.10

const MASKED_ID = "fact_masked_blocked";
const FLOOR_ID = "fact_floor_dropped";
const CLEAN_IDS = [
  "fact_clean_alpha",
  "fact_clean_bravo",
  "fact_clean_charlie",
  "fact_clean_delta",
  "fact_clean_echo",
];

function factRow(id, content, { ts, consent_basis, features } = {}) {
  return {
    id,
    kind: "fact",
    content,
    created_at: ts,
    ts,
    source_refs: [{ source: "test", consent_basis }],
    features,
  };
}

const rows = [];
for (let i = 0; i < CLEAN_IDS.length; i++) {
  rows.push(
    factRow(
      CLEAN_IDS[i],
      `quokka rottnest marsupial clean note number ${i} ${CLEAN_IDS[i]}`,
      {
        ts: CLEAN_TS,
        consent_basis: "first_party",
        features: { embedding_model_version: MODEL_VERSION },
      },
    ),
  );
}
// Consent-blocked row, MOST RECENT ts → highest additive decay score → ranks
// #1 pre-fix despite predicate_mask=0 (the leak under test).
rows.push(
  factRow(MASKED_ID, "quokka rottnest marsupial blocked secret sighting", {
    ts: MASKED_TS,
    consent_basis: "consent_blocked",
    features: { embedding_model_version: MODEL_VERSION },
  }),
);
// Fallback-branch row (embed_state marker with BOTH embeddings null) old
// enough that the additive sum falls below RECALL_ADDITIVE_FLOOR_FALLBACK.
rows.push(
  factRow(FLOOR_ID, "quokka rottnest marsupial ancient faded archive entry", {
    ts: FLOOR_TS,
    consent_basis: "first_party",
    features: {
      embedding_model_version: MODEL_VERSION,
      embed_state: true,
      embedding_4096: null,
      embedding_3072: null,
    },
  }),
);

writeFileSync(
  memoryLedgerPath(),
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  { mode: 0o600 },
);

// BM25 index over the fixture rows; empty HNSW (degraded path ignores it).
const bm25 = new Bm25Index();
for (const r of rows) {
  bm25.add({
    memory_id: r.id,
    content: r.content,
    kind: r.kind,
    ts: r.ts,
    entities: [],
  });
}
const hnsw = new HnswIndex({
  // Active-model geometry, matching the version this tree is saved under
  // (the same CAPS.EMBEDDING_DIM_4096 the queryd section below uses). Still
  // EMPTY: the degraded BM25-only path under test never searches it.
  dims: CAPS.EMBEDDING_DIM_4096,
  embedding_model_version: MODEL_VERSION,
});
saveIndices(MODEL_VERSION, { bm25, hnsw });
_resetCaches();

// Sanity: BM25 retrieves every fixture row for the probe query.
{
  const hits = bm25.search("quokka rottnest marsupial", 50);
  const hitIds = new Set(hits.map((h) => h.memory_id));
  check(
    "fixture: BM25 retrieves all 7 fixture rows for the probe query",
    rows.every((r) => hitIds.has(r.id)),
    `hits=${[...hitIds].join(",")}`,
  );
}

// ---------------------------------------------------------------------------
// End-to-end recall. Probe query carries NO time expressions (no resolved
// time anchor) so ranking is decay-only across the fixture.
// ---------------------------------------------------------------------------
let env = null;
let threw = false;
try {
  env = await recallMod.TOOL.handler({
    surrounding_context: {
      current_query: "tell me about the quokka rottnest marsupial notes",
      recent_turns: [{ role: "user", content: "quokka rottnest facts please" }],
      agent_role: "assistant",
      time: CTX_TIME,
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: "conv_b1a_mask_drop",
    max_items: 12,
    max_chars: 4000,
  });
} catch (e) {
  threw = true;
  console.error(`recall handler threw: ${e && e.stack ? e.stack : e}`);
}

// (a) envelope + degraded path.
check("recall handler does not throw on the fixture ledger", threw === false);
check(
  "(a) recall returns ok envelope",
  env != null && env.ok === true,
  env ? JSON.stringify(env).slice(0, 300) : "no env",
);
const data = env && env.data ? env.data : {};
check(
  "(a) recall degraded to BM25-only (no Gemini key) as designed",
  data.degraded_recall === true,
);

// (b) THE RED ASSERTION — brief must not contain the masked/floor rows.
const memIds = Array.isArray(data.memories) ? data.memories.map((m) => m.id) : [];
check(
  "(b) memories[] does NOT contain MASKED_ID (consent_blocked hard drop)",
  !memIds.includes(MASKED_ID),
  `memories=${memIds.join(",")}`,
);
check(
  "(b) memories[] does NOT contain FLOOR_ID (additive-floor hard drop)",
  !memIds.includes(FLOOR_ID),
  `memories=${memIds.join(",")}`,
);
check(
  "(b) memories[] still surfaces at least one clean id (partition does not empty the pipeline)",
  CLEAN_IDS.some((id) => memIds.includes(id)),
  `memories=${memIds.join(",")}`,
);

// ---------------------------------------------------------------------------
// (c)-(e) recall event assertions against the persisted recall.jsonl row.
// ---------------------------------------------------------------------------
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
const surfaced = event && Array.isArray(event.surfaced) ? event.surfaced : [];
const pre = event && Array.isArray(event.candidates_pre_truncation)
  ? event.candidates_pre_truncation
  : [];
const surfacedIds = surfaced.map((s) => s.memory_id);
check(
  "(c) event surfaced[] contains neither MASKED_ID nor FLOOR_ID",
  !surfacedIds.includes(MASKED_ID) && !surfacedIds.includes(FLOOR_ID),
  `surfaced=${surfacedIds.join(",")}`,
);
const maskedEntry = pre.find((c) => c.memory_id === MASKED_ID) || null;
const floorEntry = pre.find((c) => c.memory_id === FLOOR_ID) || null;
check(
  "(c) candidates_pre_truncation retains MASKED_ID (OPE substrate)",
  maskedEntry != null,
  `pre=${pre.map((c) => c.memory_id).join(",")}`,
);
check(
  "(c) MASKED entry carries dropped_at_layer2_output === true",
  maskedEntry != null && maskedEntry.dropped_at_layer2_output === true,
  maskedEntry ? JSON.stringify(maskedEntry) : "no entry",
);
check(
  "(c) MASKED entry carries predicate_mask === 0",
  maskedEntry != null && maskedEntry.predicate_mask === 0,
  maskedEntry ? JSON.stringify(maskedEntry) : "no entry",
);
check(
  '(c) MASKED entry carries dropped_reason === "consent_blocked"',
  maskedEntry != null && maskedEntry.dropped_reason === "consent_blocked",
  maskedEntry ? JSON.stringify(maskedEntry) : "no entry",
);
check(
  "(c) candidates_pre_truncation retains FLOOR_ID (OPE substrate)",
  floorEntry != null,
  `pre=${pre.map((c) => c.memory_id).join(",")}`,
);
check(
  "(c) FLOOR entry carries dropped_at_layer2_output === true",
  floorEntry != null && floorEntry.dropped_at_layer2_output === true,
  floorEntry ? JSON.stringify(floorEntry) : "no entry",
);
check(
  "(c) FLOOR entry carries dropped_by_additive_floor === true",
  floorEntry != null && floorEntry.dropped_by_additive_floor === true,
  floorEntry ? JSON.stringify(floorEntry) : "no entry",
);

// (d) ordering + shape: every kept entry precedes every dropped one; dropped
// entries have rerank_score === null.
{
  const firstDroppedIdx = pre.findIndex((c) => c.dropped_at_layer2_output === true);
  const lastKeptIdx = pre.reduce(
    (acc, c, i) => (c.dropped_at_layer2_output === true ? acc : i),
    -1,
  );
  check(
    "(d) every kept pre-truncation entry precedes every dropped one",
    firstDroppedIdx !== -1 && lastKeptIdx < firstDroppedIdx,
    `firstDropped=${firstDroppedIdx} lastKept=${lastKeptIdx}`,
  );
  const dropped = pre.filter((c) => c.dropped_at_layer2_output === true);
  check(
    "(d) dropped entries have rerank_score === null (never fed to Flash)",
    dropped.length === 2 && dropped.every((c) => c.rerank_score === null),
    JSON.stringify(dropped),
  );
}

// (e) additive drop counter on the event.
check(
  "(e) event.layer2_dropped_count === 2",
  event != null && event.layer2_dropped_count === 2,
  `layer2_dropped_count=${event ? event.layer2_dropped_count : "no event"}`,
);

// (f) production-path guard (hermeticity invariant, append-tolerant — REG).
{
  check(
    "(f) test-process ledger path is hermetic (config resolves under TMP_ROOT, never production)",
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
    "(f) production memory.jsonl never truncated (size same-or-grown; external appends tolerated)",
    after.memorySize >= PROD_BEFORE.memorySize,
    `before=${PROD_BEFORE.memorySize} after=${after.memorySize}`,
  );
  check(
    "(f) production memory.jsonl head bytes unchanged (no rewrite)",
    after.memoryHead === PROD_BEFORE.memoryHead,
    `before=${PROD_BEFORE.memoryHead} after=${after.memoryHead}`,
  );
  check(
    "(f) production indices/ untouched (mtime:size identical)",
    after.indices === PROD_BEFORE.indices,
    `before=${PROD_BEFORE.indices} after=${after.indices}`,
  );
}

// ===========================================================================
// RC — Finding 2 (HIGH, codex#5): index-only exclusion reapply, and
//      Finding 1 (MEDIUM): daemon vector_fetch degrade to a complete brief.
//
// This section runs the LIVE local-4096 path (NOT the degraded BM25-only path
// the B1a scenario above uses): the query embeds to a real 4096 vector via the
// MOCKED local-embed fetch (_setFetchForTests — no server needed), and the
// active 4096 index tree is rebuilt over the same hermetic TMP_ROOT.
//
// Case A (in-process) — a durable 4096 exclusion predicate + a candidate whose
//   MATCHING embedding is INDEX-ONLY (its row carries no same-dim vector, so
//   the batch hard-gate at f. SKIPS it; its 4096 vector lives only in the HNSW,
//   resolvable via getVectorByMemoryId). PRE-FIX the candidate reaches the
//   surfaced brief (RED — the batch gate missed it). POST-FIX the reapply gate,
//   run after the same-generation vector overlay, drops it (predicate_mask=0,
//   dropped_reason="predicate_excluded:<id>", retained in
//   candidates_pre_truncation for OPE).
//
// Case B (daemon) — the daemon-mode Layer-2 vector_fetch throws
//   QuerydUnavailableError mid-recall (queryd loading/restart). PRE-FIX recall
//   escalates it into a whole-recall queryd_unavailable ToolError (RED). POST-
//   FIX it degrades the ENRICHMENT overlay to empty (s_emb=0 for overlay-
//   needing candidates) and returns a COMPLETE brief — candidates were already
//   retrieved before this enrichment-only step.
// ===========================================================================
{
  const { _setFetchForTests } = await import(
    "../lib/local-embedder-client.js"
  );
  const { _resetTransitiveOrphanCaches } = await import(
    "../lib/recall/hard-gates.js"
  );
  const {
    QuerydUnavailableError,
    QuerydBadRequestError,
    getQuerydClient,
    _resetQuerydForTest,
  } = await import("../lib/recall/queryd-client.js");

  const ACTIVE_VERSION = CAPS.ACTIVE_EMBED_MODEL_VERSION;
  const DIM = CAPS.EMBEDDING_DIM_4096; // 4096 — the active query geometry

  // Deterministic 4096-d unit vectors in a 3-axis subspace.
  const Q_AXIS = 3; // query direction
  const CLEAN_AXIS = 5; // off-query component the clean facts carry
  const EXCLUDE_AXIS = 50; // the exclusion predicate's direction
  const unit = (axis) => {
    const v = new Array(DIM).fill(0);
    v[axis] = 1;
    return v;
  };
  const subspaceVec = (qComp, offAxis) => {
    const v = new Array(DIM).fill(0);
    v[Q_AXIS] = qComp;
    v[offAxis] = Math.sqrt(1 - qComp * qComp);
    return v;
  };
  const RC_QUERY_VEC = unit(Q_AXIS); // e3
  const VEC_CLEAN_A = subspaceVec(0.92, CLEAN_AXIS); // cos(q)=0.92, 0 on e50
  const VEC_CLEAN_B = subspaceVec(0.9, CLEAN_AXIS); // cos(q)=0.90, 0 on e50
  const VEC_EXCLUDE = unit(EXCLUDE_AXIS); // e50 — pure exclusion axis (s_emb=0)
  const PREDICATE_VEC = unit(EXCLUDE_AXIS); // e50 — cos(VEC_EXCLUDE)=1.0

  const RC_CLEAN_A = "fact_rc_clean_alpha";
  const RC_CLEAN_B = "fact_rc_clean_bravo";
  const RC_EXCLUDED = "fact_rc_index_only_excluded";
  const RC_PREDICATE_ID = "pred_rc_durable_4096_exclusion";
  const RC_TS = "2026-06-01T00:00:00.000Z";

  // Fixture rows: two clean facts carry a ROW embedding_4096; the excluded fact
  // carries NO embedding on its row (index-only) so the batch gate cannot see
  // its vector. All share the probe tokens so BM25 retrieves every row.
  const rcRow = (id, content, embedding) => ({
    id,
    kind: "fact",
    content,
    created_at: RC_TS,
    ts: RC_TS,
    source_refs: [{ source: "test", consent_basis: "first_party" }],
    features:
      embedding == null
        ? { embedding_model_version: ACTIVE_VERSION }
        : { embedding_model_version: ACTIVE_VERSION, embedding_4096: embedding },
  });
  const rcRows = [
    rcRow(RC_CLEAN_A, "quokka rottnest marsupial clean note alpha", VEC_CLEAN_A),
    rcRow(RC_CLEAN_B, "quokka rottnest marsupial clean note bravo", VEC_CLEAN_B),
    // Index-only: null row embedding; its 4096 vector goes into the HNSW only.
    rcRow(
      RC_EXCLUDED,
      "quokka rottnest marsupial secret excluded sighting",
      null,
    ),
  ];
  writeFileSync(
    memoryLedgerPath(),
    rcRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    { mode: 0o600 },
  );

  // Durable 4096 exclusion predicate on disk (loadActivePredicates reads
  // POLICY_DIR/predicates.jsonl). embedding_dim must equal query_embedding.length.
  writeFileSync(
    join(POLICY_DIR, "predicates.jsonl"),
    JSON.stringify({
      policy_kind: "exclude",
      predicate_id: RC_PREDICATE_ID,
      active: true,
      query_embedding: PREDICATE_VEC,
      embedding_dim: DIM,
      embedding_model_version: ACTIVE_VERSION,
      similarity_threshold: 0.85,
      context_entities: [],
      scope: null,
      captured_at: RC_TS,
    }) + "\n",
    { mode: 0o600 },
  );

  // Active 4096 index tree: BM25 over all rows + HNSW carrying EVERY row's
  // vector — including the excluded fact's (its vector is index-only, exactly
  // the historical-fact shape the batch gate misses).
  const rcBm25 = new Bm25Index();
  const rcHnsw = new HnswIndex({
    dims: DIM,
    embedding_model_version: ACTIVE_VERSION,
  });
  const rcVecById = {
    [RC_CLEAN_A]: VEC_CLEAN_A,
    [RC_CLEAN_B]: VEC_CLEAN_B,
    [RC_EXCLUDED]: VEC_EXCLUDE,
  };
  for (const r of rcRows) {
    rcBm25.add({
      memory_id: r.id,
      content: r.content,
      kind: r.kind,
      ts: r.ts,
      entities: [],
    });
    rcHnsw.add(r.id, rcVecById[r.id]);
  }
  saveIndices(ACTIVE_VERSION, { bm25: rcBm25, hnsw: rcHnsw });
  _resetCaches();
  _resetTransitiveOrphanCaches();

  const rcArgs = {
    surrounding_context: {
      current_query: "tell me about the quokka rottnest marsupial notes",
      recent_turns: [{ role: "user", content: "quokka rottnest facts please" }],
      agent_role: "assistant",
      time: "2026-06-02T12:00:00.000Z",
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: "conv_rc_index_only_exclusion",
    max_items: 12,
    max_chars: 4000,
  };

  const readLastEvent = () => {
    try {
      const lines = readFileSync(recallLedgerPath(), "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "");
      return JSON.parse(lines[lines.length - 1]);
    } catch {
      return null;
    }
  };

  // Mock the local embed server so the recall query embeds to RC_QUERY_VEC.
  // NAMED (not inline) because Case B's `finally` tears the mock down and Case
  // B2 below re-installs the SAME mock for its healthy-prefetch rerun.
  const rcEmbedFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const texts = Array.isArray(body.texts) ? body.texts : [];
    return {
      ok: true,
      async text() {
        return JSON.stringify({
          embeddings: texts.map(() => RC_QUERY_VEC),
          model_version: ACTIVE_VERSION,
          dim: DIM,
          count: texts.length,
          elapsed_ms: 1,
        });
      },
    };
  };
  _setFetchForTests(rcEmbedFetch);

  // -----------------------------------------------------------------------
  // Case A — in-process (MEMORY_QUERYD=off): index-only exclusion reapply.
  // -----------------------------------------------------------------------
  process.env.MEMORY_QUERYD = "off";
  _resetQuerydForTest();

  let aEnv = null;
  let aThrew = null;
  try {
    aEnv = await recallMod.TOOL.handler(rcArgs);
  } catch (e) {
    aThrew = e;
  }
  check(
    "RC-A recall handler does not throw on the index-only-exclusion fixture",
    aThrew === null,
    aThrew ? String(aThrew && aThrew.message) : "",
  );
  const aData = aEnv && aEnv.data ? aEnv.data : {};
  check(
    "RC-A live local-4096 path (degraded_recall === false)",
    aData.degraded_recall === false,
    `degraded_recall=${aData.degraded_recall}`,
  );
  const aMemIds = Array.isArray(aData.memories)
    ? aData.memories.map((m) => m.id)
    : [];
  // THE RED ASSERTION: pre-fix the batch gate misses the index-only vector, so
  // the excluded fact reaches the brief. Post-fix the reapply drops it.
  check(
    "RC-A (RED->GREEN) excluded index-only fact is NOT surfaced post-fix",
    !aMemIds.includes(RC_EXCLUDED),
    `memories=${aMemIds.join(",")}`,
  );
  check(
    "RC-A clean facts still surface (reapply only ADDS drops)",
    aMemIds.includes(RC_CLEAN_A) || aMemIds.includes(RC_CLEAN_B),
    `memories=${aMemIds.join(",")}`,
  );
  const aEvent = readLastEvent();
  const aSurfaced =
    aEvent && Array.isArray(aEvent.surfaced)
      ? aEvent.surfaced.map((s) => s.memory_id)
      : [];
  check(
    "RC-A recall event surfaced[] excludes the index-only fact",
    !aSurfaced.includes(RC_EXCLUDED),
    `surfaced=${aSurfaced.join(",")}`,
  );
  const aPre =
    aEvent && Array.isArray(aEvent.candidates_pre_truncation)
      ? aEvent.candidates_pre_truncation
      : [];
  const aExcludedEntry = aPre.find((c) => c.memory_id === RC_EXCLUDED) || null;
  check(
    "RC-A candidates_pre_truncation RETAINS the excluded fact (OPE substrate)",
    aExcludedEntry != null,
    `pre=${aPre.map((c) => c.memory_id).join(",")}`,
  );
  check(
    "RC-A excluded entry carries predicate_mask === 0",
    aExcludedEntry != null && aExcludedEntry.predicate_mask === 0,
    aExcludedEntry ? JSON.stringify(aExcludedEntry) : "no entry",
  );
  check(
    `RC-A excluded entry carries dropped_reason "predicate_excluded:${RC_PREDICATE_ID}"`,
    aExcludedEntry != null &&
      aExcludedEntry.dropped_reason === `predicate_excluded:${RC_PREDICATE_ID}`,
    aExcludedEntry ? JSON.stringify(aExcludedEntry) : "no entry",
  );
  check(
    "RC-A excluded entry carries dropped_at_layer2_output === true",
    aExcludedEntry != null && aExcludedEntry.dropped_at_layer2_output === true,
    aExcludedEntry ? JSON.stringify(aExcludedEntry) : "no entry",
  );

  // -----------------------------------------------------------------------
  // Case B — daemon (MEMORY_QUERYD=required): vector_fetch failure degrades
  // to a complete brief instead of a queryd_unavailable ToolError.
  // -----------------------------------------------------------------------
  const GEN = "rc-gen-1";
  // Candidate-generation stubs, shared by Case B (throwing prefetch) and Case
  // B2 (healthy prefetch) so the ONLY difference between the two cases is
  // qc.vectorFetch — that is what makes B2 a positive control rather than a
  // second fixture.
  const rcStubQuerydSearches = (client) => {
    // status: report a non-empty active tree so recall stays on the active
    // path. Carrying ACTIVE_VERSION also keeps querydModelMissing false, so
    // the `!degradedRecall` prefetch guard in recall.js is satisfied and the
    // prefetch actually runs.
    client.status = async () => ({
      models: [
        {
          model_version: ACTIVE_VERSION,
          bm25_size: rcRows.length,
          hnsw_size: rcRows.length,
          generation: GEN,
        },
      ],
    });
    // bm25_search: return every fixture row so all three become candidates.
    client.bm25Search = async () => ({
      results: rcRows.map((r, rank) => ({
        memory_id: r.id,
        score: 10 - rank,
        rank,
      })),
      generation: GEN,
    });
    // hnsw_search: empty dense leg is enough (BM25 covers candidate generation).
    client.hnswSearch = async () => ({ results: [], generation: GEN });
  };

  process.env.MEMORY_QUERYD = "required";
  _resetQuerydForTest();
  const qc = getQuerydClient();
  rcStubQuerydSearches(qc);
  // vector_fetch: the ENRICHMENT step fails mid-recall (queryd loading).
  let vectorFetchCalls = 0;
  qc.vectorFetch = async () => {
    vectorFetchCalls += 1;
    throw new QuerydUnavailableError("queryd loading mid-recall", {
      reason: "loading",
    });
  };

  let bEnv = null;
  let bThrew = null;
  try {
    bEnv = await recallMod.TOOL.handler({
      ...rcArgs,
      conversation_id: "conv_rc_daemon_vector_fetch_degrade",
    });
  } catch (e) {
    bThrew = e;
  } finally {
    _setFetchForTests(null);
    process.env.MEMORY_QUERYD = "off";
    _resetQuerydForTest();
  }

  check(
    "RC-B daemon vector_fetch WAS invoked (overlay-needing candidate present)",
    vectorFetchCalls > 0,
    `vectorFetchCalls=${vectorFetchCalls}`,
  );
  // THE RED ASSERTION: pre-fix the vector_fetch failure throws a whole-recall
  // queryd_unavailable ToolError; post-fix it degrades to a complete brief.
  check(
    "RC-B (RED->GREEN) recall does NOT throw a queryd_unavailable ToolError on vector_fetch failure",
    bThrew === null,
    bThrew
      ? `threw ${bThrew && bThrew.details ? bThrew.details.code : bThrew && bThrew.message}`
      : "",
  );
  check(
    "RC-B recall returns a complete ok brief (enrichment degraded, candidates already retrieved)",
    bEnv != null && bEnv.ok === true,
    bEnv ? JSON.stringify(bEnv).slice(0, 200) : "no env",
  );
  const bMemIds =
    bEnv && bEnv.data && Array.isArray(bEnv.data.memories)
      ? bEnv.data.memories.map((m) => m.id)
      : [];
  check(
    "RC-B brief still surfaces the clean facts (s_emb=0 overlay, not an empty brief)",
    bMemIds.includes(RC_CLEAN_A) || bMemIds.includes(RC_CLEAN_B),
    `memories=${bMemIds.join(",")}`,
  );

  // -----------------------------------------------------------------------
  // b2-silent-recall-degrade (RED -> GREEN): the RC-Finding-1 degrade above is
  // CORRECT (a complete brief beats a thrown recall) but it was SILENT — the
  // envelope reported degraded_recall:false, so an operator could not tell a
  // queryd blip that zeroed s_emb for every overlay-needing candidate apart
  // from "nothing was semantically relevant". The dense leg really was lost
  // for this call; the envelope must say so.
  //
  // VISIBILITY ONLY: the marker is OR-ed at the envelope sites, never assigned
  // to the behavior-gating `degradedRecall` (FU2 precedent) — RC-B's brief
  // below is byte-identical to the pre-fix brief in every field except the new
  // degraded_* keys, which is exactly what the surfaced-facts check above and
  // the B2 control below pin down.
  const bData = bEnv && bEnv.data ? bEnv.data : {};
  check(
    "RC-B degraded_recall === true (the vector_fetch failure is no longer silent)",
    bData.degraded_recall === true,
    `degraded_recall=${bData.degraded_recall}`,
  );
  check(
    'RC-B degraded_reason === "vector_prefetch_failed"',
    bData.degraded_reason === "vector_prefetch_failed",
    `degraded_reason=${JSON.stringify(bData.degraded_reason)}`,
  );
  // The marker carries the machine-readable failure CLASS only — queryd-
  // client's logging discipline: never err.message, never candidate ids,
  // never query text.
  const bMarker = bData.vector_prefetch_degraded;
  check(
    "RC-B vector_prefetch_degraded carries {code, reason, ids_requested} and nothing else",
    bMarker != null &&
      typeof bMarker === "object" &&
      bMarker.code === "queryd_unavailable" &&
      bMarker.reason === "loading" &&
      typeof bMarker.ids_requested === "number" &&
      bMarker.ids_requested > 0 &&
      Object.keys(bMarker).sort().join(",") === "code,ids_requested,reason",
    JSON.stringify(bMarker),
  );
  const bEvent = readLastEvent();
  check(
    "RC-B recall LEDGER event carries the same degrade stamp (both envelope sites wired)",
    bEvent != null &&
      bEvent.degraded_recall === true &&
      bEvent.degraded_reason === "vector_prefetch_failed" &&
      bEvent.vector_prefetch_degraded != null &&
      bEvent.vector_prefetch_degraded.code === "queryd_unavailable",
    bEvent
      ? `degraded_recall=${bEvent.degraded_recall} degraded_reason=${JSON.stringify(
          bEvent.degraded_reason,
        )}`
      : "no event",
  );

  // -----------------------------------------------------------------------
  // Case B2 — POSITIVE CONTROL for the flag added above. Identical fixture and
  // identical stubs; the ONLY change is that qc.vectorFetch RESOLVES with a
  // byId Map carrying the fixture vectors. A flag that is always on is not a
  // signal, so this case must be green BOTH before and after the recall.js
  // edit: pre-change because degraded_recall was already false on this path,
  // post-change because the new marker only ever fires from the catch.
  // -----------------------------------------------------------------------
  _setFetchForTests(rcEmbedFetch);
  process.env.MEMORY_QUERYD = "required";
  _resetQuerydForTest();
  const qc2 = getQuerydClient();
  rcStubQuerydSearches(qc2);
  let b2VectorFetchCalls = 0;
  let b2IdsRequested = 0;
  qc2.vectorFetch = async (_modelVersion, ids) => {
    b2VectorFetchCalls += 1;
    const idList = Array.isArray(ids) ? ids : [];
    b2IdsRequested += idList.length;
    const byId = new Map();
    for (const id of idList) {
      if (rcVecById[id] != null) byId.set(id, rcVecById[id]);
    }
    return { byId, generation: GEN };
  };

  let b2Env = null;
  let b2Threw = null;
  try {
    b2Env = await recallMod.TOOL.handler({
      ...rcArgs,
      conversation_id: "conv_rc_daemon_vector_fetch_healthy",
    });
  } catch (e) {
    b2Threw = e;
  } finally {
    _setFetchForTests(null);
    process.env.MEMORY_QUERYD = "off";
    _resetQuerydForTest();
  }

  check(
    "RC-B2 healthy vector_fetch WAS invoked (same overlay-needing candidate)",
    b2VectorFetchCalls > 0 && b2IdsRequested > 0,
    `calls=${b2VectorFetchCalls} ids=${b2IdsRequested}`,
  );
  check(
    "RC-B2 recall returns a complete ok brief (no throw on the healthy path)",
    b2Threw === null && b2Env != null && b2Env.ok === true,
    b2Threw ? String(b2Threw && b2Threw.message) : "",
  );
  const b2Data = b2Env && b2Env.data ? b2Env.data : {};
  check(
    "RC-B2 (POSITIVE CONTROL) degraded_recall === false on a healthy prefetch",
    b2Data.degraded_recall === false,
    `degraded_recall=${b2Data.degraded_recall}`,
  );
  check(
    "RC-B2 (POSITIVE CONTROL) no degraded_reason / vector_prefetch_degraded key on a healthy prefetch",
    !("degraded_reason" in b2Data) &&
      !("vector_prefetch_degraded" in b2Data),
    `keys=${Object.keys(b2Data).filter((k) => k.startsWith("degraded") || k.startsWith("vector_")).join(",")}`,
  );
  const b2MemIds =
    b2Env && b2Env.data && Array.isArray(b2Env.data.memories)
      ? b2Env.data.memories.map((m) => m.id)
      : [];
  check(
    "RC-B2 (POSITIVE CONTROL) brief still surfaces the clean facts",
    b2MemIds.includes(RC_CLEAN_A) || b2MemIds.includes(RC_CLEAN_B),
    `memories=${b2MemIds.join(",")}`,
  );
  const b2Event = readLastEvent();
  check(
    "RC-B2 recall LEDGER event stays undegraded (additive keys absent)",
    b2Event != null &&
      b2Event.degraded_recall === false &&
      !("degraded_reason" in b2Event) &&
      !("vector_prefetch_degraded" in b2Event),
    b2Event
      ? `degraded_recall=${b2Event.degraded_recall} degraded_reason=${JSON.stringify(
          b2Event.degraded_reason,
        )}`
      : "no event",
  );

  // =======================================================================
  // b2-silent-recall-degrade run 2 — THE NON-THROWING FAILURE.
  //
  // Cases B/B2 above only ever exercise a THROWN vector_fetch. queryd's
  // handler answers `ok:true` with `{ id, vector: null }` for every id it
  // cannot resolve ("unknown/tombstoned ids are structured nulls") and
  // queryd-client stores those as PRESENT keys with null values, so the
  // failure mode this node exists for — a generation swap, which makes ids
  // unresolvable without making anything throw — never reaches that catch.
  //
  // The naive predicate `resolved < requested` is REFUSED by measurement, not
  // by argument: a lexical doc with no vector is a normal permanent state.
  // MEASURED on the live tree: 31 of its 14,442 bm25.json doc ids are already
  // absent from hnsw.bin.meta.json's 124,890-entry id_map. PROJECTED: the
  // pending full BM25 rebuild takes the lexical side to roughly the ledger's
  // ~1.5M rows against that same vector count, making `resolved < requested`
  // always-on. B5 is the fixture that pins that refusal.
  //
  // The discriminator used instead is an ATTESTED-RESIDENT id: one the dense
  // leg just returned as a hit (HnswIndex.search maps through _memoryIdForId
  // and post-filters _tombstones) AND that the prefetch then asked for.
  // =======================================================================
  const RC_LEXONLY = "fact_rc_lexical_only_floor";
  const RC_OLD_TS = "2015-01-01T00:00:00.000Z"; // 0.3 x decay < the 0.10 floor
  const GEN2 = "rc-gen-2";

  // A BM25-ONLY row: no row embedding AND no index vector — exactly the shape
  // the full BM25 rebuild is about to create ~1.4M of. It is a candidate (BM25
  // retrieves it) and it lacks a same-dim row vector, so it ENTERS
  // wantedVectorIds and comes back as a structured null. It is never a dense
  // hit, so it is never attested.
  const rcLexRow = {
    ...rcRow(RC_LEXONLY, "quokka rottnest marsupial lexical only ancient note", null),
    created_at: RC_OLD_TS,
    ts: RC_OLD_TS,
  };
  const rc2Rows = [...rcRows, rcLexRow];
  writeFileSync(
    memoryLedgerPath(),
    rc2Rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    { mode: 0o600 },
  );
  const rc2Bm25 = new Bm25Index();
  const rc2Hnsw = new HnswIndex({
    dims: DIM,
    embedding_model_version: ACTIVE_VERSION,
  });
  for (const r of rc2Rows) {
    rc2Bm25.add({
      memory_id: r.id,
      content: r.content,
      kind: r.kind,
      ts: r.ts,
      entities: [],
    });
    // RC_LEXONLY deliberately gets NO hnsw entry.
    if (rcVecById[r.id] != null) rc2Hnsw.add(r.id, rcVecById[r.id]);
  }
  saveIndices(ACTIVE_VERSION, { bm25: rc2Bm25, hnsw: rc2Hnsw });
  _resetCaches();
  _resetTransitiveOrphanCaches();

  // Reuses rcStubQuerydSearches for status (same GEN, non-empty tree) and then
  // overrides the two search legs: bm25_search must surface the 4th row, and
  // hnsw_search must return REAL hits (the shared stub returns results: [],
  // which would leave the attested set empty).
  const rc2StubSearches = (client, denseIds) => {
    rcStubQuerydSearches(client);
    client.bm25Search = async () => ({
      results: rc2Rows.map((r, rank) => ({
        memory_id: r.id,
        score: 10 - rank,
        rank,
      })),
      generation: GEN,
    });
    client.hnswSearch = async () => ({
      results: denseIds.map((id, rank) => ({
        memory_id: id,
        cosine_distance: 0.1 + rank * 0.01,
        rank,
      })),
      generation: GEN,
    });
  };

  // Runs one daemon-mode recall with a caller-supplied vectorFetch stub.
  // `searchOverride` (optional, run 3) runs AFTER rc2StubSearches so a case can
  // replace a single retrieval leg — B8 uses it to make ONLY hnsw_search reject
  // with QuerydBadRequestError while bm25_search keeps answering.
  const rc2Run = async (
    conversationId,
    denseIds,
    vectorFetchStub,
    searchOverride = null,
  ) => {
    _setFetchForTests(rcEmbedFetch);
    process.env.MEMORY_QUERYD = "required";
    _resetQuerydForTest();
    const client = getQuerydClient();
    rc2StubSearches(client, denseIds);
    if (typeof searchOverride === "function") searchOverride(client);
    let calls = 0;
    let requested = [];
    client.vectorFetch = async (modelVersion, ids) => {
      calls += 1;
      requested = Array.isArray(ids) ? [...ids] : [];
      return vectorFetchStub(requested);
    };
    let env = null;
    let threw = null;
    try {
      env = await recallMod.TOOL.handler({
        ...rcArgs,
        conversation_id: conversationId,
      });
    } catch (e) {
      threw = e;
    } finally {
      _setFetchForTests(null);
      process.env.MEMORY_QUERYD = "off";
      _resetQuerydForTest();
    }
    return {
      env,
      threw,
      calls,
      requested,
      data: env && env.data ? env.data : {},
      event: readLastEvent(),
    };
  };

  const nullById = (ids) => {
    const byId = new Map();
    for (const id of ids) byId.set(id, null); // structured nulls, ok:true
    return byId;
  };
  const realOrNullById = (ids) => {
    const byId = new Map();
    for (const id of ids) byId.set(id, rcVecById[id] != null ? rcVecById[id] : null);
    return byId;
  };
  const markerKeys = (m) =>
    m != null && typeof m === "object" ? Object.keys(m).sort().join(",") : "";

  // -----------------------------------------------------------------------
  // Case B3 (RED -> GREEN) — STRUCTURED NULLS, same generation, ok:true, no
  // throw. Pre-fix degraded_recall === false (the whole defect); post-fix the
  // marker fires with reason "attested_ids_unresolved".
  // -----------------------------------------------------------------------
  const b3 = await rc2Run(
    "conv_rc_structured_nulls_same_gen",
    [RC_EXCLUDED, RC_CLEAN_A],
    (ids) => ({ byId: nullById(ids), generation: GEN }),
  );
  check(
    "RC-B3 vector_fetch WAS invoked and requested the attested dense-hit id",
    b3.calls > 0 && b3.requested.includes(RC_EXCLUDED),
    `calls=${b3.calls} requested=${b3.requested.join(",")}`,
  );
  check(
    "RC-B3 recall returns a complete ok brief (structured nulls never throw)",
    b3.threw === null && b3.env != null && b3.env.ok === true,
    b3.threw ? String(b3.threw && b3.threw.message) : "",
  );
  // THE RED ASSERTION: pre-fix nothing threw, so the catch never ran and the
  // envelope asserted health while the dense overlay had resolved NOTHING.
  check(
    "RC-B3 (RED->GREEN) degraded_recall === true on a non-throwing unresolved prefetch",
    b3.data.degraded_recall === true,
    `degraded_recall=${b3.data.degraded_recall}`,
  );
  const b3Marker = b3.data.vector_prefetch_degraded;
  check(
    'RC-B3 (RED->GREEN) code === "vector_prefetch_unresolved"',
    b3Marker != null && b3Marker.code === "vector_prefetch_unresolved",
    JSON.stringify(b3Marker),
  );
  check(
    'RC-B3 (RED->GREEN) reason === "attested_ids_unresolved" with attested_missing > 0',
    b3Marker != null &&
      b3Marker.reason === "attested_ids_unresolved" &&
      typeof b3Marker.attested_missing === "number" &&
      b3Marker.attested_missing > 0,
    JSON.stringify(b3Marker),
  );
  // Leak discipline: failure class + integer counts ONLY. An exact key-set
  // check plus a value-type check is the assertable form of "no err.message,
  // no candidate id, no query text".
  check(
    "RC-B3 marker key set is exactly {attested_missing,code,ids_requested,ids_resolved,reason} with scalar values only",
    markerKeys(b3Marker) ===
      "attested_missing,code,ids_requested,ids_resolved,reason" &&
      typeof b3Marker.code === "string" &&
      typeof b3Marker.reason === "string" &&
      typeof b3Marker.ids_requested === "number" &&
      typeof b3Marker.ids_resolved === "number" &&
      typeof b3Marker.attested_missing === "number",
    `keys=${markerKeys(b3Marker)} marker=${JSON.stringify(b3Marker)}`,
  );
  check(
    "RC-B3 ids_resolved === 0 (every requested id came back a structured null)",
    b3Marker != null && b3Marker.ids_resolved === 0,
    JSON.stringify(b3Marker),
  );
  check(
    "RC-B3 recall LEDGER event carries the same stamp (both envelope sites wired)",
    b3.event != null &&
      b3.event.degraded_recall === true &&
      b3.event.degraded_reason === "vector_prefetch_failed" &&
      b3.event.vector_prefetch_degraded != null &&
      b3.event.vector_prefetch_degraded.code === "vector_prefetch_unresolved",
    b3.event
      ? `degraded_recall=${b3.event.degraded_recall} reason=${JSON.stringify(b3.event.degraded_reason)}`
      : "no event",
  );

  // -----------------------------------------------------------------------
  // Case B6 (RED -> GREEN) — the SCORING consequence of B3, pinned observably.
  //
  // Pre-fix the marker stayed null on this path, so the scoring view still
  // emitted vector_resolved:false for RC_LEXONLY; multi-feature-score's
  // discriminator took the fallback branch and the 0.10 additive floor zeroed
  // it (final_score 0, dropped_by_additive_floor true). Post-fix the marker is
  // set, vector_resolved is OMITTED, the legacy features.embed_state predicate
  // governs (this row carries no embed_state), and the candidate keeps its
  // additive score. Direction: NON-DECREASING, degraded calls only.
  // -----------------------------------------------------------------------
  const b3Pre = b3.event && Array.isArray(b3.event.candidates_pre_truncation)
    ? b3.event.candidates_pre_truncation
    : [];
  const b3LexEntry = b3Pre.find((c) => c.memory_id === RC_LEXONLY) || null;
  console.log(
    `  [B6 measured] ${RC_LEXONLY} final_score=${b3LexEntry ? b3LexEntry.score : "ABSENT"} ` +
      `dropped_by_additive_floor=${b3LexEntry ? b3LexEntry.dropped_by_additive_floor : "n/a"}`,
  );
  check(
    "RC-B6 the below-floor BM25-only candidate is present in candidates_pre_truncation",
    b3LexEntry != null,
    `pre=${b3Pre.map((c) => c.memory_id).join(",")}`,
  );
  check(
    "RC-B6 (RED->GREEN) vector_resolved OMITTED on the degraded path: the below-floor candidate is NOT zeroed by the fallback floor",
    b3LexEntry != null &&
      b3LexEntry.score > 0 &&
      b3LexEntry.dropped_by_additive_floor !== true,
    b3LexEntry ? JSON.stringify(b3LexEntry) : "no entry",
  );

  // -----------------------------------------------------------------------
  // Case B4 (RED -> GREEN) — GENERATION CHANGE. Every attested id resolves to
  // a real vector, but the prefetch answers from a DIFFERENT generation than
  // the retrieval leg. Pre-fix that inequality was silently discarded by the
  // `querydGeneration == null &&` guard on the stamp.
  // -----------------------------------------------------------------------
  const b4 = await rc2Run(
    "conv_rc_generation_changed",
    [RC_EXCLUDED, RC_CLEAN_A],
    (ids) => ({ byId: realOrNullById(ids), generation: GEN2 }),
  );
  check(
    "RC-B4 recall returns a complete ok brief (a generation change never throws)",
    b4.threw === null && b4.env != null && b4.env.ok === true,
    b4.threw ? String(b4.threw && b4.threw.message) : "",
  );
  const b4Marker = b4.data.vector_prefetch_degraded;
  check(
    "RC-B4 (RED->GREEN) degraded_recall === true when the prefetch generation differs",
    b4.data.degraded_recall === true,
    `degraded_recall=${b4.data.degraded_recall}`,
  );
  check(
    'RC-B4 (RED->GREEN) reason === "generation_changed"',
    b4Marker != null &&
      b4Marker.code === "vector_prefetch_unresolved" &&
      b4Marker.reason === "generation_changed",
    JSON.stringify(b4Marker),
  );
  check(
    "RC-B4 marker key set is exactly {attested_missing,code,ids_requested,ids_resolved,reason} with scalar values only",
    markerKeys(b4Marker) ===
      "attested_missing,code,ids_requested,ids_resolved,reason" &&
      typeof b4Marker.ids_resolved === "number" &&
      typeof b4Marker.attested_missing === "number",
    `keys=${markerKeys(b4Marker)} marker=${JSON.stringify(b4Marker)}`,
  );
  check(
    "RC-B4 the attested id DID resolve (this is the generation discriminator alone, not an unresolved-id one)",
    b4Marker != null && b4Marker.attested_missing === 0,
    JSON.stringify(b4Marker),
  );

  // -----------------------------------------------------------------------
  // Case B5 (POSITIVE CONTROL — the anti-always-on case, and the binding
  // evidence for GOAL invariant #5 in the OTHER direction).
  //
  // One generation. The attested dense-hit id RC_EXCLUDED resolves to a real
  // vector; the BM25-only id RC_LEXONLY comes back a structured null because
  // it genuinely has no vector — the normal post-rebuild state of ~1.4M docs.
  // This is a PARTIAL resolve: `resolved < requested` is TRUE here, so the
  // refused predicate would fire. The attested predicate must not. Green BOTH
  // before and after the recall.js edit.
  // -----------------------------------------------------------------------
  const b5 = await rc2Run(
    "conv_rc_partial_resolve_control",
    [RC_EXCLUDED, RC_CLEAN_A, RC_CLEAN_B],
    (ids) => ({ byId: realOrNullById(ids), generation: GEN }),
  );
  check(
    "RC-B5 fixture really is a PARTIAL resolve (the refused `resolved < requested` predicate WOULD fire)",
    b5.requested.includes(RC_EXCLUDED) &&
      b5.requested.includes(RC_LEXONLY) &&
      rcVecById[RC_LEXONLY] == null,
    `requested=${b5.requested.join(",")}`,
  );
  check(
    "RC-B5 recall returns a complete ok brief",
    b5.threw === null && b5.env != null && b5.env.ok === true,
    b5.threw ? String(b5.threw && b5.threw.message) : "",
  );
  check(
    "RC-B5 (POSITIVE CONTROL) degraded_recall === false on a partial resolve where every ATTESTED id resolved",
    b5.data.degraded_recall === false,
    `degraded_recall=${b5.data.degraded_recall}`,
  );
  check(
    "RC-B5 (POSITIVE CONTROL) no degraded_reason / vector_prefetch_degraded / dense_search_degraded key in the response",
    !("degraded_reason" in b5.data) &&
      !("vector_prefetch_degraded" in b5.data) &&
      !("dense_search_degraded" in b5.data),
    `keys=${Object.keys(b5.data)
      .filter(
        (k) =>
          k.startsWith("degraded") ||
          k.startsWith("vector_") ||
          k.startsWith("dense_"),
      )
      .join(",")}`,
  );
  check(
    "RC-B5 (POSITIVE CONTROL) recall LEDGER event stays undegraded (additive keys absent)",
    b5.event != null &&
      b5.event.degraded_recall === false &&
      !("degraded_reason" in b5.event) &&
      !("vector_prefetch_degraded" in b5.event),
    b5.event
      ? `degraded_recall=${b5.event.degraded_recall} degraded_reason=${JSON.stringify(b5.event.degraded_reason)}`
      : "no event",
  );
  check(
    "RC-B5 (POSITIVE CONTROL) brief still surfaces the clean facts",
    Array.isArray(b5.data.memories) &&
      b5.data.memories.some(
        (m) => m.id === RC_CLEAN_A || m.id === RC_CLEAN_B,
      ),
    `memories=${(b5.data.memories || []).map((m) => m.id).join(",")}`,
  );
  // -----------------------------------------------------------------------
  // RC-B5b (ANTI-VACUITY CONTROL for run 3's WITHHOLD — non-negotiable).
  //
  // Run 3 adds `vectorPrefetchUnverifiable` (attestedRequested === 0) to the
  // `vector_resolved` spread guard in recall.js. A withhold that fired
  // EVERYWHERE would pass B7 below and would be the same lie as always-off.
  // This fixture is VERIFIED healthy: the attested dense-hit id RC_EXCLUDED
  // was requested AND resolved, so attestedRequested > 0 and the prefetch's
  // health is genuinely MEASURED. `vector_resolved` must therefore STILL be
  // emitted, and RC_LEXONLY (no vector anywhere) must STILL be floored.
  // GREEN both before and after the recall.js edit — byte-identical literals.
  // -----------------------------------------------------------------------
  const b5Pre = b5.event && Array.isArray(b5.event.candidates_pre_truncation)
    ? b5.event.candidates_pre_truncation
    : [];
  const b5LexEntry = b5Pre.find((c) => c.memory_id === RC_LEXONLY) || null;
  console.log(
    `  [B5b measured] ${RC_LEXONLY} final_score=${b5LexEntry ? b5LexEntry.score : "ABSENT"} ` +
      `dropped_by_additive_floor=${b5LexEntry ? b5LexEntry.dropped_by_additive_floor : "n/a"}`,
  );
  check(
    "RC-B5b the below-floor BM25-only candidate is present in candidates_pre_truncation",
    b5LexEntry != null,
    `pre=${b5Pre.map((c) => c.memory_id).join(",")}`,
  );
  check(
    "RC-B5b (ANTI-ALWAYS-ON) on a VERIFIED-healthy prefetch vector_resolved is STILL emitted: the below-floor candidate stays floored",
    b5LexEntry != null &&
      b5LexEntry.score === 0 &&
      b5LexEntry.dropped_by_additive_floor === true,
    b5LexEntry ? JSON.stringify(b5LexEntry) : "no entry",
  );

  // =======================================================================
  // b2-silent-recall-degrade run 3 — THE ZERO-ATTESTED BLIND SPOT.
  //
  // `attestedRequested === 0` means the dense leg returned NO hit that the
  // prefetch then asked for, so there is no attested set and the run-2
  // classifier is structurally blind. Run 2 folded that UNMEASURABLE state
  // into the NEGATIVE result: no marker (correct — an empty dense leg is
  // normal for a lexical-only query) but ALSO `vector_resolved: false` for
  // every candidate (WRONG — that is a positive assertion of health derived
  // from an unmeasurable state, and it converts an availability failure into
  // a mass hard-drop via the 0.10 fallback floor).
  //
  // F72's rule: an unmeasurable state gets its own bucket and may NEVER
  // produce a positive assertion of health. B7 and B8 are the DIFFERENTIAL —
  // the SAME prefetch answer (every id a structured null) and the SAME empty
  // attested set, told apart by the CAUSE of the empty dense leg.
  // =======================================================================

  // -----------------------------------------------------------------------
  // Case B7 (RED -> GREEN on the SCORING half; POSITIVE CONTROL on the
  // MARKER half) — the dense leg SUCCEEDS with zero results, same generation,
  // nothing throws, and every prefetch id comes back a structured null.
  //
  // (i) MUST stay quiet: a genuinely empty dense leg is the normal answer for
  //     a lexical-only query, so degraded_recall stays false and no marker is
  //     raised. This is the anti-always-on control for B8's detector.
  // (ii) MUST NOT hard-drop: with the prefetch unverifiable, recall may not
  //     assert vector_resolved, so the legacy features.embed_state predicate
  //     governs and RC_LEXONLY keeps its additive score. FAILS pre-edit.
  // -----------------------------------------------------------------------
  const b7 = await rc2Run(
    "conv_rc_zero_attested_blindspot",
    [], // dense leg SUCCEEDS with zero results — no throw, no attested id
    (ids) => ({ byId: nullById(ids), generation: GEN }),
  );
  check(
    "RC-B7 recall returns a complete ok brief (an empty dense leg never throws)",
    b7.threw === null && b7.env != null && b7.env.ok === true,
    b7.threw ? String(b7.threw && b7.threw.message) : "",
  );
  check(
    "RC-B7 fixture really is the ZERO-ATTESTED shape (ids requested, none of them a dense hit)",
    b7.calls > 0 && b7.requested.includes(RC_LEXONLY),
    `calls=${b7.calls} requested=${b7.requested.join(",")}`,
  );
  check(
    "RC-B7 (POSITIVE CONTROL) degraded_recall === false: an empty-by-SUCCESS dense leg is not a degrade",
    b7.data.degraded_recall === false,
    `degraded_recall=${b7.data.degraded_recall}`,
  );
  check(
    "RC-B7 (POSITIVE CONTROL) no vector_prefetch_degraded and no dense-leg key in the response",
    !("vector_prefetch_degraded" in b7.data) &&
      !("dense_search_degraded" in b7.data) &&
      !("degraded_reason" in b7.data),
    `keys=${Object.keys(b7.data)
      .filter((k) => k.startsWith("degraded") || k.startsWith("vector_") || k.startsWith("dense_"))
      .join(",")}`,
  );
  const b7Pre = b7.event && Array.isArray(b7.event.candidates_pre_truncation)
    ? b7.event.candidates_pre_truncation
    : [];
  const b7LexEntry = b7Pre.find((c) => c.memory_id === RC_LEXONLY) || null;
  console.log(
    `  [B7 measured] ${RC_LEXONLY} final_score=${b7LexEntry ? b7LexEntry.score : "ABSENT"} ` +
      `dropped_by_additive_floor=${b7LexEntry ? b7LexEntry.dropped_by_additive_floor : "n/a"}`,
  );
  check(
    "RC-B7 the below-floor BM25-only candidate is present in candidates_pre_truncation",
    b7LexEntry != null,
    `pre=${b7Pre.map((c) => c.memory_id).join(",")}`,
  );
  check(
    "RC-B7 (RED->GREEN) UNVERIFIABLE prefetch withholds vector_resolved: the below-floor candidate is NOT zeroed by the fallback floor",
    b7LexEntry != null &&
      b7LexEntry.score > 0 &&
      b7LexEntry.dropped_by_additive_floor !== true,
    b7LexEntry ? JSON.stringify(b7LexEntry) : "no entry",
  );

  // -----------------------------------------------------------------------
  // Case B8 (RED -> GREEN) — THE DISCRIMINATING DETECTOR.
  //
  // Identical prefetch answer to B7 (structured nulls, empty attested set),
  // but the dense leg is empty because hnsw_search was REFUSED: recall's
  // `emptyOnBadRequest` swallows a QuerydBadRequestError into
  // `{results: [], generation: null}`, so run 2 reported degraded_recall
  // false on the exact fault a model/generation swap causes (queryd's
  // `_execute` returns `bad("unknown model_version; configured: ...")` when
  // the model entry is absent, and HnswIndex.search-labelled dims/unit-norm
  // throws deliberately stay bad_request).
  //
  // NOT always-on, proven at the queryd symbol: a model MID-RELOAD is
  // refused by the per-model admission gate (`this._reloadingModels.has(mv)`
  // -> ERROR_CODES.LOADING) which queryd-client maps to
  // QuerydUnavailableError, and a corrupt resident index takes `_execute`'s
  // `internal(msg)` branch. Only a genuine request-shape refusal reaches
  // QuerydBadRequestError, so this counter is 0 on every healthy call and on
  // every reload — B7 above is the differential.
  // -----------------------------------------------------------------------
  const b8 = await rc2Run(
    "conv_rc_dense_leg_bad_request",
    [RC_EXCLUDED, RC_CLEAN_A], // irrelevant: hnsw_search never answers
    (ids) => ({ byId: nullById(ids), generation: GEN }),
    (client) => {
      client.hnswSearch = async () => {
        throw new QuerydBadRequestError(
          "unknown model_version; configured: some-other-model",
        );
      };
    },
  );
  check(
    "RC-B8 recall returns a complete ok brief (a refused dense leg must not throw the recall)",
    b8.threw === null && b8.env != null && b8.env.ok === true,
    b8.threw ? String(b8.threw && b8.threw.message) : "",
  );
  check(
    "RC-B8 the lexical leg still answered (only the DENSE leg was emptied)",
    Array.isArray(b8.data.memories) && b8.data.memories.length > 0,
    `memories=${(b8.data.memories || []).map((m) => m.id).join(",")}`,
  );
  check(
    "RC-B8 (RED->GREEN) degraded_recall === true when the dense leg is emptied by a bad_request",
    b8.data.degraded_recall === true,
    `degraded_recall=${b8.data.degraded_recall}`,
  );
  const b8Marker = b8.data.dense_search_degraded;
  console.log(
    `  [B8 measured] degraded_recall=${b8.data.degraded_recall} ` +
      `degraded_reason=${JSON.stringify(b8.data.degraded_reason)} ` +
      `dense_search_degraded=${JSON.stringify(b8Marker)}`,
  );
  check(
    'RC-B8 (RED->GREEN) dense-leg key present with code "dense_search_bad_request" and its own degraded_reason',
    b8Marker != null &&
      b8Marker.code === "dense_search_bad_request" &&
      b8.data.degraded_reason === "dense_search_bad_request",
    `marker=${JSON.stringify(b8Marker)} reason=${JSON.stringify(b8.data.degraded_reason)}`,
  );
  check(
    "RC-B8 dense-leg marker key set is exactly {code,legs_emptied,legs_requested} with scalar values only (no err.message, no ids, no query text)",
    markerKeys(b8Marker) === "code,legs_emptied,legs_requested" &&
      typeof b8Marker.code === "string" &&
      typeof b8Marker.legs_requested === "number" &&
      typeof b8Marker.legs_emptied === "number" &&
      b8Marker.legs_emptied > 0 &&
      b8Marker.legs_requested >= b8Marker.legs_emptied,
    `keys=${markerKeys(b8Marker)} marker=${JSON.stringify(b8Marker)}`,
  );
  check(
    "RC-B8 recall LEDGER event carries the same dense-leg stamp (both envelope sites wired)",
    b8.event != null &&
      b8.event.degraded_recall === true &&
      b8.event.degraded_reason === "dense_search_bad_request" &&
      b8.event.dense_search_degraded != null &&
      b8.event.dense_search_degraded.code === "dense_search_bad_request",
    b8.event
      ? `degraded_recall=${b8.event.degraded_recall} reason=${JSON.stringify(b8.event.degraded_reason)} marker=${JSON.stringify(b8.event.dense_search_degraded)}`
      : "no event",
  );
  // The dense-leg marker is DISTINCT from the prefetch-scoped one: attributing
  // a retrieval refusal to the enrichment prefetch would be a false
  // attribution, and the prefetch here is merely unverifiable, not failed.
  check(
    "RC-B8 the dense-leg marker does NOT overload vector_prefetch_degraded (distinct scopes, no false attribution)",
    !("vector_prefetch_degraded" in b8.data),
    `keys=${Object.keys(b8.data)
      .filter((k) => k.startsWith("vector_"))
      .join(",")}`,
  );

  // -----------------------------------------------------------------------
  // Case B9 — SPREAD PRECEDENCE under CO-OCCURRENCE.
  //
  // Both run-3 markers fire on one call: hnsw_search is refused
  // (dense_search_bad_request) AND the prefetch answers from a different
  // generation than the lexical leg already stamped (vector_prefetch_failed).
  // The new dense-leg spread is placed FIRST at both envelope sites and later
  // spreads win on key collision, so the PRE-EXISTING degraded_reason string
  // must be unchanged — byte-identical to the value B4 pins — while the
  // dedicated dense_search_degraded key survives the collision intact.
  // -----------------------------------------------------------------------
  const b9 = await rc2Run(
    "conv_rc_dense_bad_request_plus_generation_change",
    [RC_EXCLUDED, RC_CLEAN_A],
    (ids) => ({ byId: realOrNullById(ids), generation: GEN2 }),
    (client) => {
      client.hnswSearch = async () => {
        throw new QuerydBadRequestError("vector dims mismatch (HnswIndex.search)");
      };
    },
  );
  check(
    "RC-B9 both markers really do co-occur on this fixture",
    b9.data.dense_search_degraded != null &&
      b9.data.vector_prefetch_degraded != null,
    `dense=${JSON.stringify(b9.data.dense_search_degraded)} prefetch=${JSON.stringify(b9.data.vector_prefetch_degraded)}`,
  );
  check(
    'RC-B9 (PRECEDENCE) the pre-existing degraded_reason "vector_prefetch_failed" is UNCHANGED by the new first-placed spread',
    b9.data.degraded_reason === "vector_prefetch_failed" &&
      b9.event != null &&
      b9.event.degraded_reason === "vector_prefetch_failed",
    `response=${JSON.stringify(b9.data.degraded_reason)} event=${JSON.stringify(b9.event && b9.event.degraded_reason)}`,
  );
  check(
    "RC-B9 (PRECEDENCE) the dedicated dense-leg key survives the collision at BOTH envelope sites",
    b9.data.dense_search_degraded.code === "dense_search_bad_request" &&
      b9.event.dense_search_degraded != null &&
      b9.event.dense_search_degraded.code === "dense_search_bad_request",
    `response=${JSON.stringify(b9.data.dense_search_degraded)} event=${JSON.stringify(b9.event.dense_search_degraded)}`,
  );
  check(
    "RC-B9 the prefetch marker keeps its exact 5-key shape under co-occurrence",
    markerKeys(b9.data.vector_prefetch_degraded) ===
      "attested_missing,code,ids_requested,ids_resolved,reason",
    `keys=${markerKeys(b9.data.vector_prefetch_degraded)}`,
  );

  // Hermeticity re-check: production paths untouched by this section too.
  check(
    "RC production memory.jsonl head bytes unchanged (section hermetic)",
    headHash(PROD_MEMORY_JSONL) === PROD_BEFORE.memoryHead,
  );
  check(
    "RC production indices/ untouched (section hermetic)",
    snap(PROD_INDICES_DIR) === PROD_BEFORE.indices,
  );
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
  process.exit(1);
}
console.log("all B1a recall-mask-drop tests passed");
