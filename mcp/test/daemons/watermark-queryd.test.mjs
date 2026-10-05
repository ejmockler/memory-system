// watermark-queryd.test.mjs — Q3 (memperf): the watermark daemon's salience
// KNN routed through queryd (one resident HNSW).
//
// Pins the four Q3 contracts against daemons/watermark.js +
// mcp/lib/ingest/salience.js:
//
//   (a) EQUIVALENCE — with a live queryd, the queryd-backed ctx.hnsw handle
//       returns KNN results deep-equal to the in-process loadIndices path
//       (ids + rank exact, cosine distances within float tolerance), in the
//       unchanged {memory_id, cosine_distance, rank} shape.
//   (b) LATE-DAEMON PICKUP — a queryd started AFTER the (long-lived)
//       watermark daemon is adopted within the SALIENCE_QUERYD_REPROBE_TICKS
//       re-probe cadence, without restarting watermark. The tick immediately
//       after the daemon start stays in-process (adoption is cadence-driven).
//   (c) FAILURE DEGRADE — queryd death mid-tick degrades the remainder of
//       that tick to the null-hnsw contract (hnsw=null -> novelty 0.5, no
//       corroboration) with a loud stderr breadcrumb; never a crash, never a
//       silent Promise-shaped result; the NEXT tick re-probes and (in auto
//       mode) falls back to in-process. MEMORY_QUERYD=off pins in-process;
//       required pins daemon (a dead queryd degrades, NEVER loadIndices).
//   (d) SINGLE RESIDENT HNSW — in daemon mode the watermark performs ZERO
//       in-process HNSW loads, spied via mods.indexCache.loadIndices on the
//       cascade mods (_setCascadeModsForTest idiom).
//
// Plus the seam itself: real scoreCandidate AWAITS an async ctx.hnsw.search
// (the queryd handle is async; the sync HnswIndex is unaffected by the
// added await).
//
// HERMETIC (breaker-test idiom): tmp MEMORY_ROOT staked BEFORE any dynamic
// import touches config.js; SHORT mkdtemp prefix because the queryd unix
// socket path caps at ~104 bytes on macOS. Production ledgers / indices /
// live daemons (watermark AND queryd) are never touched or signaled — the
// queryd under test is an in-process Queryd instance on the hermetic socket.
// The 2.18GB ledgers/memory.jsonl is never read: fixtures only (dims=8
// synthetic unit vectors; a final assertion pins that no memory ledger was
// ever created in the temp tree).
//
// RED-RUN RECORD (2026-07-16, this workspace, hermetic temp state only):
//   - salience.js seam sabotaged back to the pre-Q3 sync call
//     (`knnResults = hnsw.search(emb, k) || [];`): T1 FAILED —
//     "async hnsw.search must be awaited (got PROMOTE; a leaked Promise
//     reads as knn-empty -> novelty 1.0 -> PROMOTE)". The await is
//     load-bearing, not vacuous.
//   - watermark.js __resolveSalienceHnswForTick sabotaged with
//     `alive = false` after the probe: T3 FAILED ("tick after the re-probe
//     cadence must be daemon-mode (async queryd handle)") and T4 failed
//     downstream (never entered daemon mode) — late-daemon adoption really
//     observes the probe result.
//   - watermark.js runSourceCascade daemon branch sabotaged to fall back to
//     mods.indexCache.loadIndices when the handle is dead/null: T4 FAILED
//     ("rows after the failure must see hnsw=null") and T7 FAILED
//     ("required + dead queryd degrades to null-hnsw") — a herd-ban
//     violation is caught on both degrade paths (the loadIndicesCalls spy
//     assertions sit right behind these and pin the same invariant).
//   - watermark.js __salienceQuerydDegrade sabotaged to write "" instead of
//     the breadcrumb: T4 + T7 FAILED on the
//     /queryd unavailable for salience KNN/ match — the loud-degrade
//     breadcrumb is asserted, not assumed.
// All sabotages fully reverted before completion; every run under the
// hermetic mkdtemp root (never live storage).
//
// node:test + node:assert/strict. Run:
//   node test/daemons/watermark-queryd.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Hermetic env — MUST be set BEFORE any dynamic import touches config.js.
// SHORT prefix: the queryd unix socket lives under STORAGE_BASE_DIR and
// AF_UNIX sun_path caps at ~104 bytes on macOS.
// -----------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "wmq3-"));
const MEMORY_ROOT = join(TMP_ROOT, "m");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
process.env.TELEMETRY_BASE_DIR = join(MEMORY_ROOT, "telemetry");
process.env.HOOKS_BASE_DIR = join(MEMORY_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(MEMORY_ROOT, "daemons");
// High save thresholds: nothing auto-flushes; the fixture generation is
// published explicitly via saveIndices.
process.env.INDEX_SAVE_BATCH = "1000";
process.env.INDEX_SAVE_MAX_AGE_S = "3600";
// The suite drives auto/off/required explicitly; start in auto.
delete process.env.MEMORY_QUERYD;

const SOURCES_DIR = join(process.env.STORAGE_BASE_DIR, "sources");
const WATERMARK_STATE_DIR = join(
  process.env.STORAGE_BASE_DIR,
  "watermark-state",
);
for (const d of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  process.env.TELEMETRY_BASE_DIR,
  process.env.HOOKS_BASE_DIR,
  process.env.DAEMONS_BASE_DIR,
  SOURCES_DIR,
  WATERMARK_STATE_DIR,
  join(MEMORY_ROOT, "indices"),
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}
process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// Dynamic imports AFTER env override.
const watermarkMod = await import("../../../daemons/watermark.js");
const {
  loadIndices,
  saveIndices,
  _resetCaches,
  evictModelIndices,
  _indexCacheHas,
} = await import("../../lib/recall/index-cache.js");
const { Bm25Index } = await import("../../lib/recall/bm25-index.js");
const { HnswIndex } = await import("../../lib/recall/hnsw-index.js");
const { Queryd, querydPaths, defaultModelVersions } = await import(
  "../../daemon/queryd.js"
);
const { ACTIVE_EMBED_MODEL_VERSION, CAPS } = await import(
  "../../lib/validation.js"
);
const salienceMod = await import("../../lib/ingest/salience.js");

const { socketPath: SOCKET_PATH } = querydPaths();
// macOS sun_path cap (~104 bytes). Fail loudly rather than mysteriously.
assert.ok(
  Buffer.byteLength(SOCKET_PATH) < 100,
  `socket path too long for AF_UNIX: ${SOCKET_PATH}`,
);

// -----------------------------------------------------------------------------
// Fixture: one published generation under the ACTIVE model version — the
// exact version salience queries (spec note 3) and queryd serves by default.
// -----------------------------------------------------------------------------
const DIMS = 8;
const N_FIXTURE = 6;

function unitVec(seed) {
  const v = [];
  let x = (seed + 1) * 2654435761;
  for (let i = 0; i < DIMS; i++) {
    x = (x * 1103515245 + 12345) % 2147483647;
    v.push((x % 1000) / 1000 + 0.01);
  }
  const norm = Math.sqrt(v.reduce((s, a) => s + a * a, 0));
  return v.map((a) => a / norm);
}

{
  const bm25 = new Bm25Index();
  const hnsw = new HnswIndex({
    dims: DIMS,
    embedding_model_version: ACTIVE_EMBED_MODEL_VERSION,
    maxElements: 1024,
  });
  for (let i = 0; i < N_FIXTURE; i++) {
    const id = `mem_q3_${i}`;
    bm25.add({
      memory_id: id,
      kind: "fact",
      content: `synthetic fact ${id} q3tok${i}`,
      ts: "2026-07-14T00:00:00Z",
      entities: [],
      valence: null,
      consent_basis: "first_party",
    });
    hnsw.add(id, unitVec(i));
  }
  saveIndices(ACTIVE_EMBED_MODEL_VERSION, { bm25, hnsw });
  _resetCaches();
}

// -----------------------------------------------------------------------------
// Source-row seeding (breaker-test row shape) + tick/capture harness.
// -----------------------------------------------------------------------------
const NOW = new Date("2026-07-16T00:00:00Z");
const SOURCE = "imessage";
const LEDGER_PATH = join(SOURCES_DIR, `${SOURCE}.jsonl`);
let rowSeq = 0;

function appendSourceRow() {
  const i = rowSeq++;
  const row = {
    id: `ulid_q3_${String(i).padStart(6, "0")}`,
    ts: new Date(NOW.getTime() + i * 1000).toISOString(),
    source: SOURCE,
    source_msg_id: `imsg-q3-${i}`,
    parties: ["user"],
    raw_content: { text: `q3 synthetic row ${i}` },
    attachments: [],
    source_policy: {
      deletion_semantics: "full_excise",
      consent_basis: "first_party",
    },
    checksum: `cksum-q3-${i}`,
  };
  appendFileSync(LEDGER_PATH, JSON.stringify(row) + "\n");
}

// SPY (acceptance d): counts every in-process HNSW load the cascade performs.
// Delegates to the REAL index-cache so in-process ticks stay byte-equivalent
// (same objects, same warm-cache semantics) — the count is the only addition.
let loadIndicesCalls = 0;
const spyIndexCache = {
  loadIndices: (mv) => {
    loadIndicesCalls += 1;
    return loadIndices(mv);
  },
  // Finding 3 (memperf): the in-process -> daemon adoption edge evicts the
  // module-global in-process copy. Delegate to the REAL evictModelIndices so
  // the eviction hits the same cache the spy's loadIndices populated —
  // _indexCacheHas then observes the release (not merely zero-new-calls).
  evictModelIndices: (mv) => evictModelIndices(mv),
};

// Per-row capture of the exact ctx.hnsw the cascade handed scoreCandidate:
// null-ness, sync size(), whether search() returned a thenable (the daemon
// handle is async; the in-process HnswIndex is sync — the mode
// discriminator), the awaited results, and any rejection.
const QUERY_VEC = unitVec(99);
const K = 3;
const captures = [];
let onFirstCapture = null; // one-shot hook, fires after a row's capture (T4)

async function captureScoreCandidate(_event, ctx) {
  const rec = {
    hnswNull: ctx.hnsw == null,
    size: null,
    wasThenable: null,
    results: null,
    searchError: null,
  };
  if (ctx.hnsw != null) {
    rec.size = ctx.hnsw.size();
    try {
      const r = ctx.hnsw.search(QUERY_VEC, K);
      rec.wasThenable = r != null && typeof r.then === "function";
      rec.results = (await r) || [];
    } catch (err) {
      rec.searchError = err;
    }
  }
  captures.push(rec);
  if (onFirstCapture != null) {
    const fn = onFirstCapture;
    onFirstCapture = null;
    await fn();
  }
  return { decision: "DROP", reason: "q3_capture" };
}

const mods = {
  stage0: null,
  salience: { scoreCandidate: captureScoreCandidate },
  promote: null,
  normalizeSourceEvent: null,
  localEmbedBatch: null,
  indexCache: spyIndexCache,
  contentIndex: null,
};

async function tick() {
  watermarkMod._setCascadeModsForTest(mods);
  try {
    return await watermarkMod.tickSourcesOnce({ now: NOW });
  } finally {
    watermarkMod._setCascadeModsForTest(null);
  }
}

function lastCapture() {
  return captures[captures.length - 1];
}

// Capture everything written to process.stderr while fn runs.
async function withCapturedStderr(fn) {
  const orig = process.stderr.write;
  let captured = "";
  process.stderr.write = (chunk, ...rest) => {
    captured += typeof chunk === "string" ? chunk : String(chunk);
    void rest;
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return captured;
}

let daemon = null;
let inProcResults = null;

// -----------------------------------------------------------------------------
// T0 — active-model check (spec note 3): the version salience queries is
// served by queryd's default model set.
// -----------------------------------------------------------------------------
test("T0: queryd's defaultModelVersions serves ACTIVE_EMBED_MODEL_VERSION", () => {
  assert.equal(ACTIVE_EMBED_MODEL_VERSION, CAPS.ACTIVE_EMBED_MODEL_VERSION);
  assert.ok(
    defaultModelVersions().includes(ACTIVE_EMBED_MODEL_VERSION),
    `queryd defaults ${JSON.stringify(defaultModelVersions())} must include ` +
      `the active embed model ${ACTIVE_EMBED_MODEL_VERSION}`,
  );
});

// -----------------------------------------------------------------------------
// T1 — the salience seam: scoreCandidate must AWAIT an async ctx.hnsw.search
// (the queryd handle contract). With a near-dup neighbour from an async stub
// the decision must be CORROBORATE; pre-Q3 (sync-only call) the Promise
// leaked into noveltyAndCorroborationFromKnn and the row PROMOTEd.
// -----------------------------------------------------------------------------
test("T1: real scoreCandidate awaits an async ctx.hnsw.search -> CORROBORATE", async () => {
  salienceMod._setStage0DispatchForTest(() => ({ decision: "PASS" }));
  try {
    const thr = CAPS.SALIENCE_CORROBORATE_THRESHOLD["imessage"];
    assert.ok(typeof thr === "number" && thr > 0);
    const size = Math.max(CAPS.SALIENCE_CORROBORATE_MIN_INDEX_SIZE, 50);
    const emb768 = new Array(768).fill(0);
    emb768[0] = 1.0;
    const asyncHnsw = {
      size: () => size,
      search: async () => [
        { memory_id: "mem_q3_near_dup", cosine_distance: thr / 2, rank: 0 },
      ],
    };
    const r = await salienceMod.scoreCandidate(
      {
        source: "imessage",
        source_msg_id: "imsg_q3_async_seam",
        content:
          "Queryd async-handle seam regression: a substantive sentence so " +
          "contentMassScore is non-zero and Layer 3 actually runs.",
        consent_basis: "first_party",
        ts: "2026-07-15T00:00:00Z",
        raw_content: { text: "queryd async-handle seam regression body" },
      },
      { embedding_mrl_768: emb768, hnsw: asyncHnsw, now: NOW },
    );
    assert.equal(
      r.decision,
      "CORROBORATE",
      `async hnsw.search must be awaited (got ${r.decision}; a leaked ` +
        "Promise reads as knn-empty -> novelty 1.0 -> PROMOTE)",
    );
    assert.equal(r.target_id, "mem_q3_near_dup");
  } finally {
    salienceMod._setStage0DispatchForTest(null);
  }
});

// -----------------------------------------------------------------------------
// T2 — no queryd: auto mode resolves in-process; the cascade hands
// scoreCandidate the loadIndices-backed HNSW exactly as today. Baseline KNN
// for the equivalence gate.
// -----------------------------------------------------------------------------
test("T2: no queryd -> in-process mode (loadIndices path); baseline KNN captured", async () => {
  assert.ok(!existsSync(SOCKET_PATH), "precondition: no queryd socket yet");
  watermarkMod._resetSalienceQuerydForTest();
  appendSourceRow();
  const callsBefore = loadIndicesCalls;
  const capBase = captures.length;
  const res = await tick();
  assert.equal(res.cascade_load_failed, false);
  assert.equal(res.rows_dropped, 1);
  assert.equal(captures.length, capBase + 1);
  const c = lastCapture();
  assert.equal(c.hnswNull, false, "in-process mode must hand a real HNSW");
  assert.equal(c.size, N_FIXTURE);
  assert.equal(
    c.wasThenable,
    false,
    "in-process HnswIndex.search is synchronous (byte-equivalent path)",
  );
  assert.ok(
    loadIndicesCalls > callsBefore,
    "in-process mode resolves via mods.indexCache.loadIndices",
  );
  assert.equal(c.searchError, null);
  assert.ok(Array.isArray(c.results) && c.results.length === K);
  for (const r of c.results) {
    assert.equal(typeof r.memory_id, "string");
    assert.equal(typeof r.cosine_distance, "number");
    assert.ok(Number.isInteger(r.rank));
  }
  inProcResults = c.results;
});

// -----------------------------------------------------------------------------
// T3 — late-daemon pickup + equivalence + single-resident-HNSW: a queryd
// started AFTER the watermark is adopted within the re-probe cadence, no
// watermark restart; daemon-served KNN deep-equals the in-process baseline;
// zero in-process loads while in daemon mode.
// -----------------------------------------------------------------------------
test("T3: queryd started later is adopted within the re-probe cadence; daemon KNN deep-equals in-process; zero loadIndices", async () => {
  daemon = new Queryd({
    modelVersions: [ACTIVE_EMBED_MODEL_VERSION],
    watchIntervalMs: 60_000,
  });
  await daemon.start();
  await daemon.ready;
  assert.equal(daemon.state, "ready");

  // The tick immediately after the daemon start must STAY in-process —
  // adoption is cadence-driven (cheap probe every N ticks), not per-tick.
  appendSourceRow();
  let callsBefore = loadIndicesCalls;
  await tick();
  let c = lastCapture();
  assert.equal(
    c.wasThenable,
    false,
    "tick right after a late daemon start stays in-process until the re-probe",
  );
  assert.ok(loadIndicesCalls > callsBefore);

  // Advance the re-probe cadence with empty ticks (the backend is resolved
  // at tick start; no rows needed).
  for (let i = 0; i < watermarkMod.SALIENCE_QUERYD_REPROBE_TICKS; i++) {
    await tick();
  }

  // The next row-carrying tick runs in daemon mode.
  appendSourceRow();
  callsBefore = loadIndicesCalls;
  const res = await tick();
  assert.equal(res.rows_dropped, 1);
  c = lastCapture();
  assert.equal(c.hnswNull, false);
  assert.equal(c.searchError, null);
  assert.equal(
    c.wasThenable,
    true,
    "tick after the re-probe cadence must be daemon-mode (async queryd handle)",
  );
  assert.equal(
    c.size,
    N_FIXTURE,
    "size() must be answered synchronously from the tick's one cached status()",
  );
  assert.equal(
    loadIndicesCalls,
    callsBefore,
    "SINGLE RESIDENT HNSW: zero loadIndices calls while in daemon mode",
  );
  // Finding 3 (memperf) — SINGLE RESIDENT HNSW proven by cache INTROSPECTION,
  // not merely call-count: the in-process copy loaded by T2 + T3's early ticks
  // was EVICTED on the in-process -> daemon adoption edge, so the module-global
  // cache no longer holds ACTIVE_EMBED_MODEL_VERSION. RED before the fix (the
  // copy was retained; the old test only checked zero-new-loadIndices-calls).
  assert.equal(
    _indexCacheHas(ACTIVE_EMBED_MODEL_VERSION),
    false,
    "in-process HNSW copy must be evicted after queryd adoption (one resident HNSW)",
  );
  // EQUIVALENCE GATE: ids + rank exact; distances within float tolerance;
  // shape unchanged through the cascade seam.
  assert.equal(c.results.length, inProcResults.length);
  for (let i = 0; i < inProcResults.length; i++) {
    assert.equal(c.results[i].memory_id, inProcResults[i].memory_id);
    assert.equal(c.results[i].rank, inProcResults[i].rank);
    assert.ok(
      Math.abs(c.results[i].cosine_distance - inProcResults[i].cosine_distance) <
        1e-9,
      `distance[${i}] daemon=${c.results[i].cosine_distance} ` +
        `in-process=${inProcResults[i].cosine_distance}`,
    );
  }
});

// -----------------------------------------------------------------------------
// T4 — daemon death mid-tick: the failing row surfaces a loud rejection (the
// awaited handle — never a silent Promise), every later row that tick sees
// hnsw=null (the novelty-0.5 / no-corroboration contract), one stderr
// breadcrumb, no crash, and NO in-process fallback inside the tick.
// -----------------------------------------------------------------------------
test("T4: queryd death mid-tick -> loud null-hnsw degrade for the rest of the tick; never loadIndices", async () => {
  appendSourceRow();
  appendSourceRow();
  appendSourceRow();
  const callsBefore = loadIndicesCalls;
  const capBase = captures.length;
  // Stop the daemon right after row 1's successful search completes.
  onFirstCapture = async () => {
    await daemon.stop();
  };
  let res;
  const stderr = await withCapturedStderr(async () => {
    res = await tick();
  });
  assert.equal(captures.length, capBase + 3, "all 3 rows must be judged");
  const [c1, c2, c3] = captures.slice(capBase);
  // Row 1: healthy daemon-mode search.
  assert.equal(c1.searchError, null);
  assert.equal(c1.wasThenable, true);
  // Row 2: in-flight failure -> a real rejection through the await (in
  // production scoreCandidate's try/catch degrades the row to knn-empty).
  assert.ok(
    c2.searchError != null,
    "the failing row's search must reject loudly, not hang or fake results",
  );
  // Row 3: dead handle -> the null-hnsw contract for the rest of the tick.
  assert.equal(
    c3.hnswNull,
    true,
    "rows after the failure must see hnsw=null (novelty 0.5, no corroboration)",
  );
  assert.match(
    stderr,
    /queryd unavailable for salience KNN/,
    "the degrade must leave a loud stderr breadcrumb",
  );
  // The tick itself never crashed; every row advanced.
  assert.equal(res.rows_dropped, 3);
  assert.equal(res.rows_errored, 0);
  // HERD BAN (single resident HNSW): the degrade never loads in-process.
  assert.equal(
    loadIndicesCalls,
    callsBefore,
    "HERD BAN: a daemon-mode failure must not fall back to loadIndices",
  );
});

// -----------------------------------------------------------------------------
// T5 — after the death, the next tick force-re-probes and (auto mode) falls
// back to in-process, exactly today's behavior.
// -----------------------------------------------------------------------------
test("T5: the tick after the death re-probes and falls back to in-process", async () => {
  assert.ok(!existsSync(SOCKET_PATH), "daemon.stop() unlinked the socket");
  appendSourceRow();
  const callsBefore = loadIndicesCalls;
  await tick();
  const c = lastCapture();
  assert.equal(c.hnswNull, false);
  assert.equal(c.searchError, null);
  assert.equal(c.wasThenable, false, "fallback tick must be in-process");
  assert.equal(c.size, N_FIXTURE);
  assert.ok(
    loadIndicesCalls > callsBefore,
    "in-process fallback resolves via loadIndices again",
  );
});

// -----------------------------------------------------------------------------
// T6 — MEMORY_QUERYD=off pins in-process even with a live queryd.
// -----------------------------------------------------------------------------
test("T6: MEMORY_QUERYD=off pins in-process even with a live queryd", async () => {
  daemon = new Queryd({
    modelVersions: [ACTIVE_EMBED_MODEL_VERSION],
    watchIntervalMs: 60_000,
  });
  await daemon.start();
  await daemon.ready;
  process.env.MEMORY_QUERYD = "off";
  watermarkMod._resetSalienceQuerydForTest();
  appendSourceRow();
  const callsBefore = loadIndicesCalls;
  await tick();
  const c = lastCapture();
  assert.equal(c.hnswNull, false);
  assert.equal(c.wasThenable, false, "off must pin today's in-process path");
  assert.ok(loadIndicesCalls > callsBefore);
});

// -----------------------------------------------------------------------------
// T7 — MEMORY_QUERYD=required pins daemon; with queryd dead it degrades to
// the null-hnsw contract and NEVER loads in-process.
// -----------------------------------------------------------------------------
test("T7: MEMORY_QUERYD=required pins daemon; dead queryd degrades, never in-process", async () => {
  process.env.MEMORY_QUERYD = "required";
  watermarkMod._resetSalienceQuerydForTest();
  appendSourceRow();
  let callsBefore = loadIndicesCalls;
  await tick();
  let c = lastCapture();
  assert.equal(c.wasThenable, true, "required mode must use the daemon");
  assert.equal(c.size, N_FIXTURE);
  assert.equal(loadIndicesCalls, callsBefore);

  await daemon.stop();
  daemon = null;
  appendSourceRow();
  callsBefore = loadIndicesCalls;
  let res;
  const stderr = await withCapturedStderr(async () => {
    res = await tick();
  });
  c = lastCapture();
  assert.equal(
    c.hnswNull,
    true,
    "required + dead queryd degrades to null-hnsw (novelty 0.5)",
  );
  assert.match(stderr, /queryd unavailable for salience KNN/);
  assert.equal(res.rows_dropped, 1, "the tick still advances, never crashes");
  assert.equal(
    loadIndicesCalls,
    callsBefore,
    "required NEVER falls back to in-process index loading",
  );
  delete process.env.MEMORY_QUERYD;
  watermarkMod._resetSalienceQuerydForTest();
});

// -----------------------------------------------------------------------------
// T8 — Finding 1 (memperf): a LIVE queryd that does NOT carry the ACTIVE model
// version (a deployment mismatch — daemon spawned on another tree) must degrade
// LOUDLY to the null-hnsw contract (novelty 0.5, no corroboration), NEVER a
// silent size-0 KNN handle (which reads as "index empty" and quietly kills
// salience corroboration). Mirrors recall's queryd_model_missing discipline.
// The herd ban holds: zero loadIndices. RED before the fix: models.find misses
// -> hnswSize=0 -> a LIVE size-0 handle (hnswNull===false && size===0), and no
// queryd_model_missing breadcrumb.
// -----------------------------------------------------------------------------
test("T8: queryd missing the active model -> loud null-hnsw degrade, not a silent size-0 handle; never loadIndices", async () => {
  const OTHER = `${ACTIVE_EMBED_MODEL_VERSION}-other-tree`;
  daemon = new Queryd({
    modelVersions: [OTHER],
    watchIntervalMs: 60_000,
  });
  await daemon.start();
  await daemon.ready;
  assert.equal(daemon.state, "ready");

  process.env.MEMORY_QUERYD = "required";
  watermarkMod._resetSalienceQuerydForTest();
  appendSourceRow();
  const callsBefore = loadIndicesCalls;
  // Teardown in `finally` so a failing assertion (the RED run) can NEVER leak
  // the live daemon into T9 — state never bleeds across tests.
  try {
    let res;
    const stderr = await withCapturedStderr(async () => {
      res = await tick();
    });
    const c = lastCapture();
    assert.equal(
      c.hnswNull,
      true,
      "model-missing must hand hnsw=null (null-hnsw contract), NEVER a size-0 handle",
    );
    assert.match(
      stderr,
      /queryd_model_missing/,
      "the mismatch must leave a loud degraded_reason=queryd_model_missing breadcrumb",
    );
    assert.equal(res.rows_dropped, 1, "the tick still advances, never crashes");
    assert.equal(
      loadIndicesCalls,
      callsBefore,
      "HERD BAN: a model-missing daemon must not fall back to loadIndices",
    );
  } finally {
    await daemon.stop();
    daemon = null;
    delete process.env.MEMORY_QUERYD;
    watermarkMod._resetSalienceQuerydForTest();
  }
});

// -----------------------------------------------------------------------------
// T9 — Finding 2 (memperf): an UNRECOGNIZED MEMORY_QUERYD value (a typo like
// "requird") must FAIL TOWARD the herd ban ("required"), single-sourced from
// queryd-client._readModeEnv — never a silent "auto" that re-enables in-process
// loadIndices. With queryd dead it degrades to the null-hnsw contract; exactly
// one stderr warning names the raw value. RED before the fix: the local parser
// mapped "requird" -> "auto" -> probe -> in-process loadIndices
// (hnswNull===false, loadIndicesCalls increments, no warning).
// -----------------------------------------------------------------------------
test("T9: unrecognized MEMORY_QUERYD (typo) fails toward required, degrades to null-hnsw; never auto/in-process", async () => {
  assert.ok(!existsSync(SOCKET_PATH), "precondition: no live queryd");
  process.env.MEMORY_QUERYD = "requird";
  watermarkMod._resetSalienceQuerydForTest();
  appendSourceRow();
  const callsBefore = loadIndicesCalls;
  let res;
  const stderr = await withCapturedStderr(async () => {
    res = await tick();
  });
  const c = lastCapture();
  assert.equal(
    c.hnswNull,
    true,
    "a typo must resolve to required and (dead queryd) degrade to null-hnsw, NOT auto -> in-process",
  );
  assert.equal(
    loadIndicesCalls,
    callsBefore,
    "unrecognized value must NOT fall back to in-process loadIndices (fail toward the herd ban)",
  );
  assert.match(
    stderr,
    /requird/,
    "exactly one stderr warning must name the unrecognized raw value",
  );
  assert.equal(res.rows_dropped, 1, "the tick still advances, never crashes");
  delete process.env.MEMORY_QUERYD;
  watermarkMod._resetSalienceQuerydForTest();
});

// -----------------------------------------------------------------------------
// Hermeticity pin.
// -----------------------------------------------------------------------------
test("hermeticity: ledgers/memory.jsonl was never created by this suite", () => {
  assert.ok(
    !existsSync(join(process.env.LEDGERS_BASE_DIR, "memory.jsonl")),
    "suite must never touch a memory ledger",
  );
});
