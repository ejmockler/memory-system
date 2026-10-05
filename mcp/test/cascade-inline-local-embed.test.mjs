// cascade-inline-local-embed.test.mjs — WU2-inline-embed-and-remove-gemini-
// quota-machinery regression battery.
//
// Pins the PART A cutover: the watermark cascade embeds INLINE via the local
// Qwen3 server (mcp/lib/local-embedder-client.js) over each tick's row
// contents, and PROMOTES the fact row WITH the full 4096-dim embedding
// (features.embedding_4096 + embedding_model_version = ACTIVE_EMBED_MODEL_VERSION).
//
// And the null+sweep fallback: when the local server is down (the cascade's
// localEmbedBatch throws LocalEmbedUnavailableError), the row PROMOTES with
// embedding=null + embed_state=true and the fact id is recorded to the SIMPLE
// re-embed sweep file (policy/re-embed-sweep.jsonl) — NOT an async queue. The
// cursor still advances (no EMBED_DEFERRED park).
//
// HERMETIC: tmp MEMORY_ROOT; the cascade modules are injected via
// _setCascadeModsForTest so the REAL stage0 + salience + promote run, but the
// embed call site is a deterministic mock (success → fixed 4096 unit vector;
// failure → throws LocalEmbedUnavailableError). No live embed server, no
// network, no real index. Captures the localEmbedBatch call args to prove the
// is_query:false document-embed contract.
//
// node:test + node:assert/strict; 12+ assertions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Hermetic env — MUST be set BEFORE any dynamic import touches config.js.
// -----------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-wu2-inline-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.POLICY_BASE_DIR = join(TMP_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TMP_ROOT, "ledgers");
process.env.HOOKS_BASE_DIR = join(TMP_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(TMP_ROOT, "daemons");

const WATERMARK_STATE_DIR = join(process.env.STORAGE_BASE_DIR, "watermark-state");
const SOURCES_DIR = join(process.env.STORAGE_BASE_DIR, "sources");
for (const d of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  process.env.HOOKS_BASE_DIR,
  process.env.DAEMONS_BASE_DIR,
  WATERMARK_STATE_DIR,
  SOURCES_DIR,
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

const watermarkMod = await import("../../daemons/watermark.js");
const salienceMod = await import("../lib/ingest/salience.js");
const stage0Mod = await import("../lib/ingest/stage0/index.js");
const promoteMod = await import("../lib/tools/distill-promote-fact.js");
const { CAPS, ACTIVE_EMBED_MODEL_VERSION } = await import("../lib/validation.js");
const { LocalEmbedUnavailableError } = await import(
  "../lib/local-embedder-client.js"
);

const LEDGER_PATH = join(process.env.LEDGERS_BASE_DIR, "memory.jsonl");
const RE_EMBED_SWEEP_PATH = join(process.env.POLICY_BASE_DIR, "re-embed-sweep.jsonl");
const NOW = new Date("2026-06-22T00:00:00Z");

function memoryFactRows() {
  if (!existsSync(LEDGER_PATH)) return [];
  return readFileSync(LEDGER_PATH, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
    .filter((r) => r.kind === "fact");
}

function sweepLines() {
  if (!existsSync(RE_EMBED_SWEEP_PATH)) return [];
  return readFileSync(RE_EMBED_SWEEP_PATH, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// Seed a single imessage source row + clear its cursor so the tick processes
// it. Also truncates the memory ledger + the re-embed sweep file so each test
// asserts against a clean slate (the cascade appends to the shared
// memory.jsonl across tests otherwise).
function seedRow(tag, text) {
  return seedRows(tag, [text]);
}

// Multi-row variant (E1 T4): one source row per text, ids `ulid_<tag>_<n>`,
// same clean-slate semantics as seedRow.
function seedRows(tag, texts) {
  const source = "imessage";
  const ledgerPath = join(SOURCES_DIR, `${source}.jsonl`);
  const lines = texts.map((text, n) => {
    const rowTag = texts.length === 1 ? tag : `${tag}_${n}`;
    return JSON.stringify({
      id: `ulid_${rowTag}`,
      ts: NOW.toISOString(),
      source,
      source_msg_id: `${source}-${rowTag}`,
      raw_content: { text, handle_id: "+15555550199" },
      source_policy: { deletion_semantics: "full_excise", consent_basis: "first_party" },
      checksum: `cksum-${rowTag}`,
    });
  });
  writeFileSync(ledgerPath, lines.join("\n") + "\n");
  try { writeFileSync(join(WATERMARK_STATE_DIR, `${source}.json`), ""); } catch {}
  try { writeFileSync(LEDGER_PATH, ""); } catch {}
  try { writeFileSync(RE_EMBED_SWEEP_PATH, ""); } catch {}
  return source;
}

const STUB_VEC_4096 = new Array(4096).fill(0).map((_, i) => (i === 0 ? 1 : 0));

// Build a cascade-mods bundle wired to the REAL stage0/salience/promote and a
// mock localEmbedBatch. captured.calls records each localEmbedBatch invocation
// so the is_query:false contract is assertable.
function buildMods(localEmbedBatch) {
  return {
    stage0: stage0Mod,
    salience: salienceMod,
    promote: promoteMod,
    normalizeSourceEvent: salienceMod.normalizeSourceEvent,
    localEmbedBatch,
    indexCache: { loadIndices: () => ({ hnsw: null }) },
  };
}

// ---------------------------------------------------------------------------
// T1 — SUCCESS: the cascade calls localEmbedBatch (is_query:false) and the
// promoted fact row carries features.embedding_4096 (4096 dims) +
// embedding_model_version = ACTIVE_EMBED_MODEL_VERSION + embed_state=false.
// ---------------------------------------------------------------------------
test("T1: cascade embeds inline via the local client and promotes WITH embedding_4096", async () => {
  const source = seedRow("t1", "WU2 inline local embed success row alpha");

  const calls = [];
  const localEmbedBatch = async (args) => {
    calls.push(args);
    return args.items.map((_t, i) => ({
      index: i,
      vector_4096: STUB_VEC_4096.slice(),
      embedding_model_version: ACTIVE_EMBED_MODEL_VERSION,
    }));
  };
  watermarkMod._setCascadeModsForTest(buildMods(localEmbedBatch));
  // v3-ledger-embedding-reroute: the row-inline embedding is now behind the
  // default-OFF MEMORY_LEDGER_ROW_EMBEDDING_4096 revert flag. This suite is the
  // regression net for the LEGACY row shape, so it drives the promote with the
  // flag ON and keeps every assertion below intact.
  const prevRowEmbedFlag = process.env.MEMORY_LEDGER_ROW_EMBEDDING_4096;
  process.env.MEMORY_LEDGER_ROW_EMBEDDING_4096 = "1";
  let result;
  try {
    result = await watermarkMod.tickSourcesOnce({ now: NOW });
  } finally {
    watermarkMod._setCascadeModsForTest(null);
    if (prevRowEmbedFlag === undefined) delete process.env.MEMORY_LEDGER_ROW_EMBEDDING_4096;
    else process.env.MEMORY_LEDGER_ROW_EMBEDDING_4096 = prevRowEmbedFlag;
  }

  // The local client was called exactly once for the tick's row set, with the
  // DOCUMENT instruction prefix (is_query:false).
  assert.equal(calls.length, 1, "localEmbedBatch called once for the tick");
  assert.equal(calls[0].isQuery, false, "documents embed with is_query:false");
  assert.ok(Array.isArray(calls[0].items) && calls[0].items.length === 1, "one item embedded");

  assert.ok(result.rows_promoted >= 1, "at least one row promoted");
  assert.equal(result.rows_errored, 0, "no cascade errors on the success path");

  const facts = memoryFactRows();
  assert.equal(facts.length, 1, "exactly one fact row written");
  const f = facts[0].features;
  assert.ok(Array.isArray(f.embedding_4096), "features.embedding_4096 is an array");
  assert.equal(f.embedding_4096.length, CAPS.EMBEDDING_DIM_4096, "embedding_4096 is 4096 dims");
  assert.equal(
    f.embedding_model_version,
    ACTIVE_EMBED_MODEL_VERSION,
    "model_version stamped to the active local model",
  );
  assert.equal(f.embed_state, false, "embed_state=false on the inline-embed success path");
  // The legacy Gemini fields are NOT stamped on the local path.
  assert.equal(f.embedding_3072, undefined, "no legacy embedding_3072 on the local path");

  // No sweep file is written on the success path.
  assert.equal(sweepLines().length, 0, "re-embed sweep file is empty on success");
});

// ---------------------------------------------------------------------------
// T2 — FALLBACK: localEmbedBatch throws LocalEmbedUnavailableError. The row
// PROMOTES with embedding_4096=null + embed_state=true, and the fact id is
// recorded to the simple re-embed sweep file. The cursor still advances (no
// EMBED_DEFERRED park) — rows_promoted>=1.
// ---------------------------------------------------------------------------
test("T2: local server down → promote with null embedding + record to re-embed sweep file", async () => {
  const source = seedRow("t2", "WU2 inline local embed fallback row beta");

  const localEmbedBatch = async () => {
    throw new LocalEmbedUnavailableError(
      "local-embedder-client: cannot reach embed server at http://127.0.0.1:8359/embed",
    );
  };
  watermarkMod._setCascadeModsForTest(buildMods(localEmbedBatch));
  let result;
  try {
    result = await watermarkMod.tickSourcesOnce({ now: NOW });
  } finally {
    watermarkMod._setCascadeModsForTest(null);
  }

  // The row still PROMOTES (the cursor advances; no park / deferral).
  assert.ok(result.rows_promoted >= 1, "row promoted even with the local server down");
  assert.equal(result.rows_errored, 0, "local-unavailable is not a cascade error");

  const facts = memoryFactRows();
  assert.equal(facts.length, 1, "exactly one fact row written on the fallback path");
  const f = facts[0].features;
  assert.equal(f.embedding_4096, null, "embedding_4096 explicitly null on the fallback path");
  assert.equal(f.embed_state, true, "embed_state=true marks the row for re-embed");

  // The fact id is recorded to the SIMPLE re-embed sweep file (a plain list).
  const sweep = sweepLines();
  assert.equal(sweep.length, 1, "exactly one fact id recorded to the re-embed sweep file");
  assert.equal(
    sweep[0].fact_id,
    facts[0].id,
    "the recorded fact id matches the promoted-without-embed row",
  );
});

// ---------------------------------------------------------------------------
// T4 — E1 zero-norm-embedding-root-cause: a ROW-SCOPED degenerate vector. The
// client (already having retried the row alone) returns three records with
// the middle one { vector_4096: null, degenerate: "zero_norm" }. Rows 0 and 2
// promote WITH embedding_4096; row 1 promotes with null and is the ONLY sweep
// line; the tick logs the `degenerate vectors` line exactly once and NOT the
// `local embed server unavailable` line; telemetry sees one
// recordDrop(source, "embed_degenerate_vector", "WARN").
// ---------------------------------------------------------------------------
test("T4: one degenerate row nulls ONE fact (sweep + WARN), siblings keep their vectors", async () => {
  const source = seedRows("t4", [
    "E1 degenerate row-scoped test row zero keeps its vector",
    "E1 degenerate row-scoped test row one is the zero-norm row",
    "E1 degenerate row-scoped test row two keeps its vector",
  ]);

  const calls = [];
  const localEmbedBatch = async (args) => {
    calls.push(args);
    return args.items.map((_t, i) =>
      i === 1
        ? { index: 1, vector_4096: null, embedding_model_version: ACTIVE_EMBED_MODEL_VERSION, degenerate: "zero_norm" }
        : { index: i, vector_4096: STUB_VEC_4096.slice(), embedding_model_version: ACTIVE_EMBED_MODEL_VERSION },
    );
  };
  const drops = [];
  const telemetry = { recordDrop: (...a) => { drops.push(a); return a[1]; } };
  watermarkMod._setCascadeModsForTest({ ...buildMods(localEmbedBatch), telemetry });

  const prevRowEmbedFlag = process.env.MEMORY_LEDGER_ROW_EMBEDDING_4096;
  process.env.MEMORY_LEDGER_ROW_EMBEDDING_4096 = "1";
  const stderrLines = [];
  const origWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    stderrLines.push(String(chunk));
    return origWrite.call(process.stderr, chunk, ...rest);
  };
  let result;
  try {
    result = await watermarkMod.tickSourcesOnce({ now: NOW });
  } finally {
    process.stderr.write = origWrite;
    watermarkMod._setCascadeModsForTest(null);
    if (prevRowEmbedFlag === undefined) delete process.env.MEMORY_LEDGER_ROW_EMBEDDING_4096;
    else process.env.MEMORY_LEDGER_ROW_EMBEDDING_4096 = prevRowEmbedFlag;
  }

  assert.equal(calls.length, 1, "one batched localEmbedBatch call for the tick");
  assert.equal(calls[0].items.length, 3, "all three rows embedded in one batch");
  assert.ok(result.rows_promoted >= 3, "all three rows promoted (cursor advances past the degenerate row)");
  assert.equal(result.rows_errored, 0, "a degenerate row is not a cascade error");

  const facts = memoryFactRows();
  assert.equal(facts.length, 3, "three fact rows written");
  for (const i of [0, 2]) {
    const f = facts[i].features;
    assert.ok(Array.isArray(f.embedding_4096), `fact ${i} carries an embedding_4096 array`);
    assert.equal(f.embedding_4096.length, CAPS.EMBEDDING_DIM_4096, `fact ${i} embedding is 4096 dims`);
  }
  assert.equal(facts[1].features.embedding_4096, null, "the degenerate row promotes with embedding_4096=null");

  const sweep = sweepLines();
  assert.equal(sweep.length, 1, "exactly ONE sweep line — the degenerate row only");
  assert.equal(sweep[0].fact_id, facts[1].id, "the sweep line names the degenerate row's fact id");

  const joined = stderrLines.join("");
  const degenerateLines = joined.split("\n").filter((l) =>
    l.startsWith("watermark: local embed degenerate vectors source="),
  );
  assert.equal(degenerateLines.length, 1, "exactly one `degenerate vectors` line for the tick");
  assert.match(degenerateLines[0], /source=imessage count=1 items=3/, "the line names source, count and items");
  assert.equal(
    joined.includes("watermark: local embed server unavailable for source="),
    false,
    "the server-unavailable line does NOT fire for a degenerate-only batch",
  );

  assert.equal(drops.length, 1, "telemetry saw exactly one recordDrop");
  assert.deepEqual(drops[0], [source, "embed_degenerate_vector", "WARN"], "recordDrop(source, embed_degenerate_vector, WARN)");
});

// ---------------------------------------------------------------------------
// T3 — the local client is the SOLE embed call site: there is no per-row
// Gemini embedder fallback and no embed-backfill queue. A successful tick
// touches localEmbedBatch and nothing else embed-shaped.
// ---------------------------------------------------------------------------
test("T3: localEmbedBatch is the single embed call site (no Gemini fallback)", async () => {
  seedRow("t3", "WU2 single embed call-site row gamma");

  let embedCalls = 0;
  const localEmbedBatch = async (args) => {
    embedCalls += 1;
    return args.items.map((_t, i) => ({
      index: i,
      vector_4096: STUB_VEC_4096.slice(),
    }));
  };
  // A mods bundle that ONLY provides localEmbedBatch as an embed surface — no
  // embedSingle / embedBatch / mrlSlice / allKeysCooled fields exist any more.
  const mods = buildMods(localEmbedBatch);
  assert.equal(mods.embedSingle, undefined, "no Gemini embedSingle on the cascade mods");
  assert.equal(mods.embedBatch, undefined, "no Gemini embedBatch on the cascade mods");
  assert.equal(mods.allKeysCooled, undefined, "no allKeysCooled circuit-breaker on the cascade mods");

  watermarkMod._setCascadeModsForTest(mods);
  try {
    await watermarkMod.tickSourcesOnce({ now: NOW });
  } finally {
    watermarkMod._setCascadeModsForTest(null);
  }
  assert.equal(embedCalls, 1, "exactly one local embed call for the single-row tick");
});
