#!/usr/bin/env node
// run-contextual-eval.mjs — WU2-eval-harness-failure-rate (Phase 0).
//
// Runs the contextual-eval goldset through a chosen retrieval LEG over the LIVE
// indices and prints the Anthropic-comparable failure-rate metrics as NDJSON.
//
//   node mcp/scripts/run-contextual-eval.mjs --leg bm25|dense|fused \
//        --index baseline|contextual [--goldset=path] [--k=20] [--limit=N]
//
// LEGS
//   bm25  : lexical-only. Loads indices/<model>/bm25.json and runs
//           bm25.search(query, k). No embedder needed — always runnable.
//   dense : semantic-only. Embeds each query via the local Qwen3 embed server
//           and runs hnsw.search(vec, k) over the active 4096 HNSW. Requires
//           the embed server (http://127.0.0.1:8359) to be UP; if it is down we
//           emit a degraded NDJSON record and exit 0 (the gate operator re-runs
//           once the server is up — we do NOT fabricate dense numbers).
//   fused : RRF(bm25, dense) via the production hybridRetrieve. Also requires
//           the embed server for the dense leg; degrades to BM25-only-with-
//           warning when the server is down (matching production degraded_recall).
//
// INDEX VARIANT
//   --index baseline   : the whole-fact projection currently on disk (the
//                        pre-contextual index). This is the "before" arm.
//   --index contextual : the contextual-augmented projection (situated /
//                        anaphor-resolved fact text). When no separate
//                        contextual index exists on disk yet, the runner reports
//                        index_variant_available=false so the operator knows the
//                        contextual arm has not been built — it does NOT silently
//                        alias baseline as contextual (that would fake the delta).
//
// MODEL VERSION
//   The lexical (bm25) leg validates against the LARGE gemini-embedding-001
//   index by default (the fully-backfilled lexical substrate, 1.46M facts). The
//   dense/fused legs use the ACTIVE model (qwen3) since only it has a query
//   embedder. Override with --model=<dir>.
//
// HERMETIC-SAFE
//   This runner only READS the on-disk indices and the goldset; it writes
//   nothing to any index or ledger. It does snapshot the live BM25/HNSW files
//   read-only. We call skipIfDaemonActive() so a concurrent rebuild that swaps
//   the index file mid-read cannot make the run report a half-built index as a
//   real result.
//
// OUTPUT: one NDJSON line of metrics to stdout (plus a leading config line).
// Exit 0 on success or graceful degrade; exit 1 only on hard failure
// (missing goldset / unloadable index).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  loadBm25IndexFromV2File,
  isV2File,
} from "../lib/recall/bm25-streaming-loader.js";
import { Bm25Index } from "../lib/recall/bm25-index.js";
import { HnswIndex } from "../lib/recall/hnsw-index.js";
import { hybridRetrieve } from "../lib/recall/hybrid-retriever.js";
import { computeFailureRate } from "../lib/recall/eval-failure-rate.js";
import { l2Renormalize } from "../lib/vector-math.js";
import { MEMORY_ROOT, LEDGERS_DIR } from "../lib/config.js";
import { skipIfDaemonActive } from "../test/_hermetic-daemon-skip.mjs";

// Data root comes from lib/config.js (MEMORY_ROOT, default: this checkout),
// never from the home directory.
const ROOT = MEMORY_ROOT;
const DEFAULT_GOLDSET = join(LEDGERS_DIR, "contextual-eval-goldset.jsonl");
const GEMINI_MODEL = "gemini-embedding-001";
const ACTIVE_MODEL = "qwen3-embedding-8b-fp16";
const EMBED_URL = process.env.LOCAL_EMBED_URL || "http://127.0.0.1:8359";

function parseArgs(argv) {
  const opts = {
    leg: "bm25",
    index: "baseline",
    goldset: DEFAULT_GOLDSET,
    k: 20,
    limit: 0,
    model: null,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--leg=")) opts.leg = arg.slice("--leg=".length);
    else if (arg === "--leg") opts._expectLeg = true;
    else if (opts._expectLeg) { opts.leg = arg; opts._expectLeg = false; }
    else if (arg.startsWith("--index=")) opts.index = arg.slice("--index=".length);
    else if (arg === "--index") opts._expectIndex = true;
    else if (opts._expectIndex) { opts.index = arg; opts._expectIndex = false; }
    else if (arg.startsWith("--goldset=")) opts.goldset = arg.slice("--goldset=".length);
    else if (arg.startsWith("--k=")) opts.k = Number(arg.slice("--k=".length));
    else if (arg.startsWith("--limit=")) opts.limit = Number(arg.slice("--limit=".length));
    else if (arg.startsWith("--model=")) opts.model = arg.slice("--model=".length);
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: run-contextual-eval.mjs --leg bm25|dense|fused --index baseline|contextual " +
          "[--goldset=path] [--k=20] [--limit=N] [--model=dir]\n",
      );
      process.exit(0);
    }
  }
  return opts;
}

// Roll a chunk-id (`${factId}#${k}`) back to its parent fact id. The 4096
// re-embed stores giants multi-vector under `${factId}#${k}`; production recall
// dedupes chunk-hits to the parent fact, so the eval must credit a chunk hit to
// the bare golden_fact_id. This is a retrieval-layer rollup, NOT goldset
// manipulation: a bare fact id (no '#') is returned unchanged.
function baseFactId(id) {
  if (typeof id !== "string") return id;
  const h = id.indexOf("#");
  return h === -1 ? id : id.slice(0, h);
}

function loadGoldset(path) {
  const raw = readFileSync(path, "utf8");
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row && row.kind === "contextual_eval_goldset_meta") continue;
    if (row && typeof row.query === "string" && typeof row.golden_fact_id === "string") {
      rows.push(row);
    }
  }
  return rows;
}

function loadBm25(modelDir) {
  const p = join(ROOT, "indices", modelDir, "bm25.json");
  if (!existsSync(p)) return null;
  try {
    return isV2File(p)
      ? loadBm25IndexFromV2File(p)
      : Bm25Index.deserialize(JSON.parse(readFileSync(p, "utf8")));
  } catch (e) {
    process.stderr.write(`run-contextual-eval: failed to load BM25 ${p}: ${e.message}\n`);
    return null;
  }
}

function loadHnsw(modelDir) {
  const p = join(ROOT, "indices", modelDir, "hnsw.bin");
  if (!existsSync(p) && !existsSync(p + ".meta.json")) return null;
  try {
    return HnswIndex.load(p, { efSearch: 64 });
  } catch (e) {
    process.stderr.write(`run-contextual-eval: failed to load HNSW ${p}: ${e.message}\n`);
    return null;
  }
}

// Embed a query via the local Qwen3 server. Returns the 4096 vector, or null
// if the server is unreachable / mis-shaped (the caller then degrades).
async function embedQuery(text) {
  if (typeof fetch !== "function") return null;
  let resp;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    resp = await fetch(`${EMBED_URL}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: [text], is_query: true, dim: 4096 }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch {
    return null;
  }
  if (!resp || !resp.ok) return null;
  let body;
  try { body = await resp.json(); } catch { return null; }
  const vec = body && Array.isArray(body.embeddings) ? body.embeddings[0] : null;
  if (!Array.isArray(vec) || vec.length === 0) return null;
  // The local embed server returns near-unit vectors (||v|| ~ 0.9999..1.0003)
  // that drift outside hnsw.search's strict 1e-6 unit-norm invariant. The index
  // contract is "caller renormalizes"; do it so search() does not throw (which
  // would silently degrade dense to empty and fake a floor=1.0 failure rate).
  try { return l2Renormalize(vec); } catch { return vec; }
}

// Probe the embed server once so we can fail fast / degrade before running 300
// queries against a dead socket.
async function embedServerUp() {
  const v = await embedQuery("healthcheck probe");
  return Array.isArray(v) && v.length > 0;
}

async function main() {
  const opts = parseArgs(process.argv);
  skipIfDaemonActive("run-contextual-eval");

  const VALID_LEGS = new Set(["bm25", "dense", "fused"]);
  const VALID_INDEX = new Set(["baseline", "contextual"]);
  if (!VALID_LEGS.has(opts.leg)) {
    process.stderr.write(`run-contextual-eval: --leg must be bm25|dense|fused (got ${opts.leg})\n`);
    process.exit(1);
  }
  if (!VALID_INDEX.has(opts.index)) {
    process.stderr.write(`run-contextual-eval: --index must be baseline|contextual (got ${opts.index})\n`);
    process.exit(1);
  }
  if (!existsSync(opts.goldset)) {
    process.stderr.write(`run-contextual-eval: goldset missing: ${opts.goldset}\n`);
    process.exit(1);
  }

  // INDEX VARIANT resolution. baseline = the on-disk whole-fact index.
  // contextual = a separate <model>-contextual/ tree if it exists; otherwise we
  // report it as unavailable rather than aliasing baseline (which would fake a
  // zero delta).
  // bm25 leg → gemini lexical substrate; dense/fused → active model.
  const lexicalModel = opts.model || GEMINI_MODEL;
  const denseModel = opts.model || ACTIVE_MODEL;
  let indexVariantAvailable = true;
  let resolvedLexical = lexicalModel;
  let resolvedDense = denseModel;
  if (opts.index === "contextual") {
    const lexCtx = `${lexicalModel}-contextual`;
    const denCtx = `${denseModel}-contextual`;
    const lexCtxExists = existsSync(join(ROOT, "indices", lexCtx, "bm25.json"));
    const denCtxExists = existsSync(join(ROOT, "indices", denCtx, "hnsw.bin")) ||
      existsSync(join(ROOT, "indices", denCtx, "hnsw.bin.meta.json"));
    if (opts.leg === "bm25") { indexVariantAvailable = lexCtxExists; if (lexCtxExists) resolvedLexical = lexCtx; }
    else if (opts.leg === "dense") { indexVariantAvailable = denCtxExists; if (denCtxExists) resolvedDense = denCtx; }
    else { indexVariantAvailable = lexCtxExists && denCtxExists; if (lexCtxExists) resolvedLexical = lexCtx; if (denCtxExists) resolvedDense = denCtx; }
  }

  let goldset;
  try {
    goldset = loadGoldset(opts.goldset);
  } catch (e) {
    process.stderr.write(`run-contextual-eval: failed to read goldset: ${e.message}\n`);
    process.exit(1);
  }
  if (opts.limit > 0) goldset = goldset.slice(0, opts.limit);

  const config = {
    kind: "contextual_eval_config",
    leg: opts.leg,
    index: opts.index,
    index_variant_available: indexVariantAvailable,
    lexical_model: resolvedLexical,
    dense_model: resolvedDense,
    k: opts.k,
    goldset: opts.goldset,
    goldset_size: goldset.length,
    embed_url: EMBED_URL,
    started_at: new Date().toISOString(),
  };

  // If contextual variant requested but not built, emit a clear degraded record.
  if (opts.index === "contextual" && !indexVariantAvailable) {
    process.stdout.write(JSON.stringify(config) + "\n");
    process.stdout.write(JSON.stringify({
      kind: "contextual_eval_result",
      status: "skipped_no_contextual_index",
      note: "The contextual index variant has not been built on disk yet; " +
        "refusing to alias baseline as contextual. Build the contextual " +
        "projection first, then re-run.",
      config,
    }) + "\n");
    process.exit(0);
  }

  // Load indices for the requested leg.
  const bm25 = (opts.leg === "bm25" || opts.leg === "fused")
    ? loadBm25(resolvedLexical)
    : (opts.leg === "fused" ? loadBm25(resolvedLexical) : null);
  // dense/fused need the active HNSW + embedder.
  let hnsw = null;
  let embedUp = false;
  if (opts.leg === "dense" || opts.leg === "fused") {
    hnsw = loadHnsw(resolvedDense);
    embedUp = await embedServerUp();
  }

  if ((opts.leg === "bm25" || opts.leg === "fused") && bm25 == null) {
    process.stderr.write(`run-contextual-eval: BM25 index unloadable for ${resolvedLexical}\n`);
    process.exit(1);
  }

  config.bm25_size = bm25 ? bm25.size() : 0;
  config.hnsw_size = hnsw && typeof hnsw.size === "function" ? hnsw.size() : 0;
  config.embed_server_up = embedUp;
  process.stdout.write(JSON.stringify(config) + "\n");

  // Build the per-query recallFn for the chosen leg. Returns a per-leg map so
  // computeFailureRate's per_leg attribution works (fused returns all three).
  async function recallFn(query) {
    if (opts.leg === "bm25") {
      return { bm25: bm25.search(query, Math.max(opts.k, 20)) };
    }

    // dense + fused both need a query vector.
    let vec = null;
    if (embedUp) vec = await embedQuery(query);

    if (opts.leg === "dense") {
      if (!vec || hnsw == null || hnsw.size() === 0) return { dense: [] };
      let hits;
      try { hits = hnsw.search(vec, Math.max(opts.k, 20)); } catch { hits = []; }
      // hnsw returns {memory_id, cosine_distance, rank} already in rank order.
      // Roll chunk-ids back to parent facts (giants are stored multi-vector).
      return { dense: hits.map((h) => baseFactId(h.memory_id)) };
    }

    // fused: run the production hybrid retriever (BM25 + dense MaxSim → RRF).
    const segmentVectors = vec ? [{ segment_role: "surrounding_context", vector_mrl_768: vec }] : [];
    let fusedHits = [];
    try {
      fusedHits = await hybridRetrieve({
        segmentVectors,
        queryText: query,
        bm25,
        hnsw: hnsw || { search: () => [] },
        opts: { candidateSetSize: Math.max(opts.k, 50) },
      });
    } catch (e) {
      // Degrade to BM25-only on any fusion error (matches production).
      fusedHits = bm25.search(query, Math.max(opts.k, 20)).map((h) => ({ memory_id: h.memory_id }));
    }
    // Expose all legs so per_leg attribution is meaningful. Chunk-ids from the
    // dense/fused legs roll back to parent facts; bm25 is over whole facts.
    return {
      fused: fusedHits.map((h) => baseFactId(h.memory_id)),
      bm25: bm25.search(query, Math.max(opts.k, 20)).map((h) => h.memory_id),
      dense: (vec && hnsw && hnsw.size() > 0)
        ? (() => { try { return hnsw.search(vec, Math.max(opts.k, 20)).map((h) => baseFactId(h.memory_id)); } catch { return []; } })()
        : [],
    };
  }

  const metrics = await computeFailureRate({ goldset, recallFn, k: opts.k });

  const out = {
    kind: "contextual_eval_result",
    status: (opts.leg !== "bm25" && !embedUp) ? "degraded_no_embed_server" : "ok",
    ...metrics,
    config,
    finished_at: new Date().toISOString(),
  };
  if (opts.leg !== "bm25" && !embedUp) {
    out.note = "embed server unreachable; dense leg returned empty for every " +
      "query (dense/fused failure rates are floor=1.0 and NOT meaningful). " +
      "Bring up the local embed server and re-run for real dense/fused numbers.";
  }
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`run-contextual-eval: unhandled ${e && e.stack}\n`);
  process.exit(1);
});
