#!/usr/bin/env node
// backfill-embeddings.mjs — Phase 3 v0 (recall layer) one-shot ingestion.
//
// Authoritative spec source:
//   kb/research-retrieval-frontiers.md
//   § "Recommended Phase 3 architecture", § "Gemini integration specifics",
//   § "Staged rollout plan".
// Authoritative shape contracts:
//   kb/phase3-v0-contracts.md § 1 IndexEntry,
//   § 7 File layout, § 9 graceful-degrade.
//
// Purpose
// -------
// Embed every existing memory-ledger fact that lacks an embedding using
// gemini-embedding-001 with taskType=RETRIEVAL_DOCUMENT, then build/refresh
// the per-version BM25 + HNSW indices under indices/<embedding_model_version>/.
// This is the one-shot pre-recall ingestion step plus the recovery path for
// any promote-time Gemini outage that landed rows without inline embeddings.
// R29.3 retired the features.embedding_pending=true marker; this script
// detects facts needing embedding by structural absence of the embedding
// fields instead of by the legacy flag.
//
// V0 design choice: sidecar embeddings (NOT in-place ledger mutation)
// ------------------------------------------------------------------
// The memory ledger is append-only (kb/architecture.md § Memory ledger). We
// CANNOT mutate prior rows in place. Two strategies were on the table:
//
//   (a) Emit a "reconstructed" kind=embedding_backfill event per the
//       authoritative event-kind taxonomy, carrying derived_from=[<orig_id>]
//       and the embedding fields. The recall pipeline would then overlay
//       these amendment events at IndexEntry construction time.
//
//   (b) Write embedding payloads to a SIDECAR JSONL alongside the
//       per-version indices at
//       indices/<embedding_model_version>/embeddings-sidecar.jsonl, with
//       rows {memory_id, embedding_3072, embedding_mrl_768, embedded_at,
//       embedding_model_version}. The recall pipeline joins these sidecar
//       rows to ledger events at IndexEntry construction time.
//
// We pick (b) for v0:
//   - simpler: no event-kind taxonomy growth; no derivation walk surprises;
//   - preserves ledger immutability: the memory.jsonl bytes are not
//     touched by backfill (re-running the script never changes the ledger);
//   - colocated with indices: the sidecar shares the per-version directory
//     so a model-version migration cleanly rebuilds {hnsw.bin, bm25.json,
//     embeddings-sidecar.jsonl} as a single unit;
//   - supports --force re-embed under model migrations: rewriting the
//     sidecar is a single-file replace, not a multi-event ledger amendment.
//
// Strategy (a) remains the right answer once we ship recall-time learning
// (v3); the sidecar is a Phase 3 v0 implementation expedient, called out
// here so a future contributor migrating to the amendment path has the
// rationale.
//
// CLI
// ---
//   node scripts/backfill-embeddings.mjs                # default paths
//   node scripts/backfill-embeddings.mjs --dry-run      # list, no writes
//   node scripts/backfill-embeddings.mjs --force        # re-embed all facts
//                                                       # (model-version migration)
//
// Behavior
// --------
//   1. Read $LEDGERS_BASE_DIR/memory.jsonl (env-overridable via config.js).
//   2. Read any existing sidecar at
//      $MEMORY_ROOT/indices/gemini-embedding-001/embeddings-sidecar.jsonl.
//   3. Filter facts that need embedding:
//        - kind === "fact"
//        - AND (NOT --force ? (no sidecar row for this memory_id
//                              AND no inline features.embedding_3072)
//                            : every fact)
//        Rows lacking an inline embedding (R29.3 retired the legacy
//        embedding_pending=true marker) are picked up structurally.
//   4. Call gemini-client.embedBatch with taskType=RETRIEVAL_DOCUMENT in
//      chunks of GEMINI_BATCH_SIZE_MAX (100); sleep 200ms between chunks.
//   5. For each embedded item: MRL-slice to 768d + L2-renormalize, assert
//      ||v||=1.0 invariant at both 3072d and 768d, write a sidecar row.
//   6. Build BM25 (over content) + HNSW (over MRL-768d) indices from the
//      union of (every fact-kind ledger row) + (sidecar embeddings). Save
//      to indices/gemini-embedding-001/{bm25.json,hnsw.bin}.
//   7. Progress: log every 100 events; print total elapsed at end.
//
// Hermeticity
// -----------
// All filesystem paths flow through lib/config.js — env vars MEMORY_ROOT,
// LEDGERS_BASE_DIR, etc. are honored. The associated unit test sets these
// to mkdtempSync paths BEFORE the dynamic import. Production
// <MEMORY_ROOT>/ledgers/memory.jsonl is READ but never mutated
// by this script (per the standing discipline).
//
// Time helper
// -----------
// Uses envelope.serverTs() for ISO-8601 timestamps (the same helper
// validation.js + the privileged-tool handlers use). For test code that
// needs deterministic time, the helpers accept opts.now (string or function
// returning epoch ms) — see runBackfill() signature.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import { constants as bufferConstants } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// s10-remaining-stringcap-sites-2: the memory-ledger read below is streamed
// rather than materialized as one V8 string. streamLedgerLines is stdlib-only
// (node:fs + node:string_decoder) and reports fs failures on counts.readError
// instead of returning a silently-empty result.
import { streamLedgerLines } from "../mcp/lib/synthesis/_ledger-stream.js";

// All paths flow through config.js for hermetic override support.
import { MEMORY_ROOT, memoryLedgerPath } from "../mcp/lib/config.js";
import { serverTs } from "../mcp/lib/envelope.js";
import {
  embedBatch,
  GEMINI_TASK_TYPES,
  // Still sourced here: :140 reads GEMINI_CLIENT_CONSTANTS.GEMINI_BATCH_SIZE_MAX.
  GEMINI_CLIENT_CONSTANTS,
} from "../mcp/lib/gemini-client.js";
import { mrlSlice, l2NormAssert } from "../mcp/lib/vector-math.js";
import { Bm25Index } from "../mcp/lib/recall/bm25-index.js";
import { HnswIndex } from "../mcp/lib/recall/hnsw-index.js";
// S3 FIX CYCLE 2 — index publication goes through the generation-manifest
// publisher (see step 5 below); bare fixed-path writes are forbidden.
import { publishGeneration } from "../mcp/lib/recall/index-cache.js";
import { CAPS } from "../mcp/lib/validation.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_VERSION = CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT; // "gemini-embedding-001"
const MRL_DIMS = CAPS.GEMINI_EMBEDDING_DIMS_MRL; // 768
const BATCH_SIZE = GEMINI_CLIENT_CONSTANTS.GEMINI_BATCH_SIZE_MAX; // 100
const INTER_BATCH_SLEEP_MS = 200; // rate-limit politeness
const PROGRESS_EVERY = 100;

// Path helpers (resolved at call time so env overrides take effect).
function indicesDirFor(modelVersion) {
  return join(MEMORY_ROOT, "indices", modelVersion);
}
function sidecarPathFor(modelVersion) {
  return join(indicesDirFor(modelVersion), "embeddings-sidecar.jsonl");
}
function bm25PathFor(modelVersion) {
  return join(indicesDirFor(modelVersion), "bm25.json");
}
function hnswPathFor(modelVersion) {
  return join(indicesDirFor(modelVersion), "hnsw.bin");
}

// ---------------------------------------------------------------------------
// Ledger + sidecar I/O
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// s10-remaining-stringcap-sites-2 — REFUSE OVER THE CAP, STREAM UNDER IT.
//
// The former body of readLedger() was `readFileSync(path, "utf8")` +
// `split("\n")` on memoryLedgerPath(). MEASURED THIS SESSION (2026-08-12):
// ledgers/memory.jsonl is 3,072,964,265 B (statSync) against this build's
// 536,870,888-byte MAX_STRING_LENGTH (vendor/node v24.15.0) — 5.723x. That size
// is a floor, not a constant: the ledger is append-only and the cascade is live,
// so re-stat before quoting it. The throw was reproduced in-session on a
// 600,000,120-byte sparse fixture costing 8,192 B of real disk: the stack named
// readLedger() -> runBackfill() and the CLI exited 1 on a raw
// ERR_STRING_TOO_LONG ("Cannot create a string longer than 0x1fffffe8
// characters").
//
// WHY THIS IS A REFUSAL AND NOT A STRAIGHT STREAM SWAP. Streaming alone would
// take a script that currently fails closed and make it RUN. What it would then
// do, verified this session rather than assumed:
//   * MODEL_VERSION is pinned to CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT, which
//     resolves to "gemini-embedding-001"; step 5 calls
//     publishGeneration(MODEL_VERSION, ...), i.e. it publishes into
//     indices/gemini-embedding-001 (its manifest: generation 3, created
//     2026-08-08T06:17:54.597Z).
//   * The generation this system actually publishes today is
//     indices/qwen3-embedding-8b-fp16 (manifest: generation 87,
//     embedding_model_version qwen3-embedding-8b-fp16, dims 4096, created
//     2026-08-12T00:43:35.800Z).
//   * Nothing schedules this script: `crontab -l` -> no crontab installed, and
//     `launchctl list | grep -i backfill` -> no match. A repo-wide grep for
//     "backfill-embeddings" outside node_modules returns no invocation at all:
//     the only code that reaches this module is three test imports
//     (mcp/test/backfill-embeddings.test.mjs:63, integration-phase3-v0.test.mjs
//     :146, integration-phase3-v1-rerank.test.mjs:150); every other hit is a
//     comment, a docs mention, or the package.json `test:backfill-embeddings`
//     alias — which runs the TEST file, not this script.
//   * The re-embed path that IS wired is daemons/reembed-drain.mjs
//     defaultRepair() spawning mcp/scripts/reembed-local-4096.mjs, which reads
//     both the ledger and the sidecar with createReadStream.
// So the cap throw is, today, the only thing stopping a 1.5M-fact walk that
// ends in publishGeneration for the pinned model version. Replacing it with a
// silent success is the FINDINGS F7 / F16 shape — a remedy worse than the
// defect. In-tree precedent for the alternative: mcp/test/scripts-stringcap.test.mjs
// T4 made backfill-seed-row-marker.mjs REFUSE with exit 4 and a named cause
// rather than repairing the read.
//
// What the refusal is NOT allowed to be is the old opaque V8 error, and what
// the UNDER-cap path is not allowed to be is a whole-file read: below the cap
// the ledger streams, so this file no longer carries the defect class at all.
// ---------------------------------------------------------------------------
const LEDGER_STRING_CAP_BYTES = bufferConstants.MAX_STRING_LENGTH;

// Byte size of `path`, or null when it cannot be stat'd (missing file, and
// every other stat failure — the read path below reports those itself).
function ledgerSizeBytesOrNull(path) {
  try {
    return statSync(path).size;
  } catch (_e) {
    return null;
  }
}

// Throws a typed refusal when the ledger cannot be a JS string on this build.
// Byte size is a CONSERVATIVE proxy for string length (UTF-8 multi-byte
// content makes the string shorter than the file), so this can refuse a file
// whose decoded length would have squeaked under. That direction is
// deliberate: over the cap, the honest answer is "use the supported tool".
function assertLedgerUnderStringCap(path) {
  const size = ledgerSizeBytesOrNull(path);
  if (size === null || size <= LEDGER_STRING_CAP_BYTES) return;
  const ratio = (size / LEDGER_STRING_CAP_BYTES).toFixed(3);
  const err = new Error(
    `backfill: REFUSING to run — the ledger is over this build's string cap. ` +
      `${path} is ${size} B; MAX_STRING_LENGTH on this build is ` +
      `${LEDGER_STRING_CAP_BYTES} B (${ratio}x over). This script publishes a ` +
      `generation for model_version=${MODEL_VERSION}; the supported re-embed ` +
      `path for a ledger this size is mcp/scripts/reembed-local-4096.mjs ` +
      `(spawned by daemons/reembed-drain.mjs), which reads the ledger and the ` +
      `sidecar as streams. Refusing rather than streaming here is deliberate: ` +
      `see mcp/test/remaining-stringcap-sites-2.test.mjs T9/T10.`,
  );
  err.code = "LEDGER_OVER_STRING_CAP";
  err.ledger_path = path;
  err.ledger_bytes = size;
  err.string_cap_bytes = LEDGER_STRING_CAP_BYTES;
  throw err;
}

// readLedgerFacts — streamed replacement for the former readLedger().
//
// RETENTION (F7/F16 discipline — "the caller decides what to retain",
// _ledger-stream.js:31). The old shape retained THREE things: the whole-file
// string, the split("\n") array, and an array of every row carrying a string
// id — including the non-fact rows, which the caller only ever used to compute
// `allRows.length`. This retains ONLY the fact rows (which steps 3-4 genuinely
// need, one per embed candidate and per BM25/HNSW posting) plus an integer.
// Test T13 measures the end-to-end heap cost through runBackfill against a
// half-fact fixture and asserts a budget; the before/after figures live there,
// next to the code that produces them.
//
// PRESERVED EXACTLY: `ledgerRows` counts rows that parse AND carry a string id
// (the old filter), `facts` is those rows with kind === "fact" in file order,
// torn/invalid lines are skipped silently, and a MISSING ledger yields zeros
// (streamLedgerLines classifies ENOENT as readError null, _ledger-stream.js:146
// — same as the old existsSync guard).
//
// CHANGED DELIBERATELY: an UNREADABLE-but-present ledger. readFileSync threw
// (EACCES et al) and nothing caught it, so the script aborted; streamLedgerLines
// never throws, so without this check a permission failure would become
// ledger_rows=0 -> "nothing to embed" -> a silent no-op publish. That is the
// UNREADABLE-becomes-EMPTY conflation this node exists to close, so the
// readError is re-raised and the script stays fail-closed (test T12).
function readLedgerFacts(path) {
  const facts = [];
  let ledgerRows = 0;
  const counts = streamLedgerLines(path, (row) => {
    // Same acceptance filter as the pre-stream readLedger().
    if (!row || typeof row !== "object" || typeof row.id !== "string") return;
    ledgerRows += 1;
    if (row.kind === "fact") facts.push(row);
  });
  if (counts.readError != null) {
    const err = new Error(
      `backfill: ledger read FAILED (${path}): ${counts.readError} — refusing to ` +
        `treat an unreadable ledger as an empty one.`,
    );
    err.code = "LEDGER_UNREADABLE";
    err.ledger_path = path;
    throw err;
  }
  return { facts, ledgerRows };
}

function readSidecar(path) {
  // Map<memory_id, {embedding_3072, embedding_mrl_768, embedded_at, model_version}>
  const out = new Map();
  if (!existsSync(path)) return out;
  const raw = readFileSync(path, "utf8");
  if (raw === "") return out;
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    if (row && typeof row.memory_id === "string") {
      out.set(row.memory_id, row);
    }
  }
  return out;
}

// Append a single sidecar row. The sidecar is JSON-Lines; rows for the same
// memory_id are append-only (later rows win on read). Under --force we
// rewrite the file in full; under normal backfill we append only new rows.
function appendSidecarRow(path, row) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  appendFileSync(path, JSON.stringify(row) + "\n", "utf8");
}

function rewriteSidecar(path, rows) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
  writeFileSync(path, body, "utf8");
}

// ---------------------------------------------------------------------------
// Eligibility filter
// ---------------------------------------------------------------------------

// Returns true if the row needs embedding given the existing sidecar state.
// Rules:
//   - row.kind must be "fact" (other kinds: recall/policy/reconstructed are
//     not embedded in v0; recall events carry their own query embedding).
//   - row.content must be a non-empty string (Gemini rejects empty inputs).
//   - if --force: always true (caller is doing a model-version re-embed).
//   - else: true if NO sidecar row exists for this memory_id AND the row
//     does NOT already carry a valid inline features.embedding_3072
//     (legacy in-line embedding from promote-time wiring; sidecar wins on
//     read but we don't re-embed it).
//   - R29.3 retired the legacy features.embedding_pending=true marker;
//     promote-time Gemini outages land rows without inline embedding
//     fields, which this filter picks up via the missing-embedding_3072
//     branch — no separate flag check needed.
function needsEmbedding(row, sidecar, force) {
  if (row.kind !== "fact") return false;
  if (typeof row.content !== "string" || row.content.length === 0) return false;
  if (force) return true;
  const f = row.features || {};
  if (sidecar.has(row.id)) return false;
  if (Array.isArray(f.embedding_3072) && f.embedding_3072.length === 3072) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

// runBackfill — programmatic entry point. Returns a summary object so tests
// can introspect what happened without scraping stdout.
//
// opts:
//   dryRun: boolean — list only; no embed calls, no writes
//   force: boolean — re-embed every fact regardless of sidecar/inline state
//   now: () => epoch_ms | string — override-for-test time helper. When set,
//        the embedded_at timestamp uses opts.now() (epoch ms) or
//        Date.parse(opts.now); when unset, envelope.serverTs() is used.
//   sleepMs: number — override inter-batch sleep (tests pass 0).
//   embed: async ({items, taskType}) => Array — override gemini-client.embedBatch
//          (tests pass a stub so the script never hits the network).
//   logger: {log, warn} — override console for hermetic test capture.
export async function runBackfill(opts = {}) {
  const dryRun = opts.dryRun === true;
  const force = opts.force === true;
  const sleepMs = typeof opts.sleepMs === "number" ? opts.sleepMs : INTER_BATCH_SLEEP_MS;
  const embed = typeof opts.embed === "function" ? opts.embed : embedBatch;
  const logger = opts.logger || console;

  // Time helper. Same pattern as gemini-client._nowMs.
  function nowIso() {
    if (typeof opts.now === "function") {
      return new Date(opts.now()).toISOString();
    }
    if (typeof opts.now === "string") {
      return new Date(Date.parse(opts.now)).toISOString();
    }
    return serverTs();
  }

  const t0 = typeof opts.now === "function" ? opts.now() : Date.now();

  // Resolve paths AFTER any env override has been applied.
  const ledgerPath = memoryLedgerPath();
  const indicesDir = indicesDirFor(MODEL_VERSION);
  const sidecarPath = sidecarPathFor(MODEL_VERSION);
  const bm25Path = bm25PathFor(MODEL_VERSION);
  const hnswPath = hnswPathFor(MODEL_VERSION);

  logger.log(`backfill: model_version=${MODEL_VERSION}`);
  logger.log(`backfill: ledger=${ledgerPath}`);
  logger.log(`backfill: indices_dir=${indicesDir}`);
  if (dryRun) logger.log("backfill: DRY-RUN mode (no writes, no embed calls)");
  if (force) logger.log("backfill: FORCE mode (re-embed every fact)");

  // -------------------------------------------------------------------------
  // 1. Read ledger + existing sidecar.
  // -------------------------------------------------------------------------
  // s10: refuse an over-cap ledger BEFORE any work, with a named cause. The
  // "backfill: ledger=<path>" line above has already told the operator which
  // file this is about.
  assertLedgerUnderStringCap(ledgerPath);
  const { facts, ledgerRows } = readLedgerFacts(ledgerPath);
  const sidecar = readSidecar(sidecarPath);

  logger.log(`backfill: ledger_rows=${ledgerRows} fact_rows=${facts.length} sidecar_rows=${sidecar.size}`);

  // -------------------------------------------------------------------------
  // 2. Filter to facts that need embedding.
  // -------------------------------------------------------------------------
  const toEmbed = facts.filter((r) => needsEmbedding(r, sidecar, force));
  logger.log(`backfill: facts_to_embed=${toEmbed.length}`);

  if (toEmbed.length === 0 && !force) {
    // Even with nothing to embed, we still (re)build the indices to keep the
    // on-disk state consistent with the current ledger + existing sidecar.
    // This is the "fresh ledger but stale indices" recovery path.
    logger.log("backfill: nothing to embed; rebuilding indices from existing sidecar");
  }

  if (dryRun) {
    // Emit the would-embed list as a structured chunk for test inspection.
    for (const r of toEmbed) {
      logger.log(`backfill: WOULD embed memory_id=${r.id} content_len=${r.content.length}`);
    }
    const t1 = typeof opts.now === "function" ? opts.now() : Date.now();
    logger.log(`backfill: dry-run complete in ${t1 - t0}ms`);
    return {
      model_version: MODEL_VERSION,
      ledger_rows: ledgerRows,
      fact_rows: facts.length,
      sidecar_rows_before: sidecar.size,
      to_embed: toEmbed.length,
      embedded: 0,
      dry_run: true,
      bm25_size: 0,
      hnsw_size: 0,
      elapsed_ms: t1 - t0,
    };
  }

  // -------------------------------------------------------------------------
  // 3. Embed in chunks of BATCH_SIZE; sleep between batches.
  // -------------------------------------------------------------------------
  // newSidecarRows[] is the canonical list under --force (we rewrite the
  // entire sidecar from this list); under normal mode we APPEND each row
  // as it lands so a crash mid-run still preserves the work done so far.
  const newSidecarRows = [];
  let embedded = 0;
  const newRowsByMemoryId = new Map();

  for (let chunkStart = 0; chunkStart < toEmbed.length; chunkStart += BATCH_SIZE) {
    const chunkEnd = Math.min(chunkStart + BATCH_SIZE, toEmbed.length);
    const chunk = toEmbed.slice(chunkStart, chunkEnd);
    const items = chunk.map((r) => r.content);

    let results;
    try {
      results = await embed({
        items,
        taskType: GEMINI_TASK_TYPES.RETRIEVAL_DOCUMENT,
      });
    } catch (e) {
      // The graceful-degrade discipline (kb/phase3-v0-contracts.md § 9)
      // dictates: promote-time Gemini outages land rows without inline
      // embeddings (R29.3 retired the embedding_pending=true marker);
      // backfill-time outages are fatal because backfill IS the recovery
      // path. We surface the error loudly so the operator can re-run after
      // Gemini recovers.
      throw new Error(
        `backfill: embedBatch failed at chunk ${chunkStart}-${chunkEnd}: ${e.message}`,
      );
    }

    if (!Array.isArray(results) || results.length !== chunk.length) {
      throw new Error(
        `backfill: embedBatch returned ${results && results.length} results for ${chunk.length} items`,
      );
    }

    for (let i = 0; i < chunk.length; i++) {
      const row = chunk[i];
      const res = results[i];
      if (!res || !Array.isArray(res.vector_3072) || res.vector_3072.length !== 3072) {
        throw new Error(
          `backfill: embedBatch result[${i}] missing 3072d vector`,
        );
      }
      // Invariant assertions at every layer (per the L2-norm pipeline-wide
      // discipline). gemini-client.embedBatch already asserts the 3072d
      // unit norm; we re-assert here as a defense-in-depth check before
      // committing the sidecar row.
      l2NormAssert(res.vector_3072, "backfill.vector_3072");
      const vector_mrl_768 = mrlSlice(res.vector_3072, MRL_DIMS);
      l2NormAssert(vector_mrl_768, "backfill.vector_mrl_768");

      const sidecarRow = {
        memory_id: row.id,
        embedding_3072: res.vector_3072,
        embedding_mrl_768: vector_mrl_768,
        embedding_model_version: MODEL_VERSION,
        embedded_at: nowIso(),
        task_type: GEMINI_TASK_TYPES.RETRIEVAL_DOCUMENT,
      };
      newSidecarRows.push(sidecarRow);
      newRowsByMemoryId.set(row.id, sidecarRow);

      // Under non-force mode, append-as-you-go so a partial run is
      // recoverable on the next invocation.
      if (!force) {
        appendSidecarRow(sidecarPath, sidecarRow);
      }

      embedded++;
      if (embedded % PROGRESS_EVERY === 0) {
        logger.log(`backfill: embedded ${embedded}/${toEmbed.length}`);
      }
    }

    if (chunkEnd < toEmbed.length && sleepMs > 0) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  // Under --force, rewrite the sidecar in full from the new rows. The
  // previous sidecar contents are replaced (this IS the model-migration
  // path; if you want preserve-old, run with a new MEMORY_ROOT).
  if (force) {
    rewriteSidecar(sidecarPath, newSidecarRows);
  }

  // -------------------------------------------------------------------------
  // 4. Build BM25 + HNSW indices from (every fact row) + (sidecar map).
  //    We rebuild from scratch so we never carry stale postings forward.
  // -------------------------------------------------------------------------
  const finalSidecar = readSidecar(sidecarPath);

  // Overlay any in-process new rows (in case fs caching lags on macOS HFS+).
  for (const [mid, row] of newRowsByMemoryId) {
    finalSidecar.set(mid, row);
  }

  const bm25 = new Bm25Index();
  const hnsw = new HnswIndex({
    dims: MRL_DIMS,
    embedding_model_version: MODEL_VERSION,
  });

  for (const fact of facts) {
    const features = fact.features || {};
    // Roll up entities. Phase 1 facts may not carry features.entities; default [].
    const entities = Array.isArray(features.entities)
      ? features.entities.map((e) => String(e).toLowerCase()).filter((e) => e !== "")
      : [];
    bm25.add({
      memory_id: fact.id,
      kind: "fact",
      content: typeof fact.content === "string" ? fact.content : "",
      ts: typeof fact.created_at === "string" ? fact.created_at : "",
      entities,
    });

    const sc = finalSidecar.get(fact.id);
    if (sc && Array.isArray(sc.embedding_mrl_768) && sc.embedding_mrl_768.length === MRL_DIMS) {
      // Re-validate the unit-norm invariant on read. If a sidecar row was
      // corrupted on disk (mid-write torn line, manual edit, etc.) we
      // fail loudly rather than poison the ANN index.
      l2NormAssert(sc.embedding_mrl_768, `backfill.sidecar[${fact.id}].embedding_mrl_768`);
      hnsw.add(fact.id, sc.embedding_mrl_768);
    } else if (
      Array.isArray(features.embedding_mrl_768) &&
      features.embedding_mrl_768.length === MRL_DIMS
    ) {
      // Inline-embedded fact (promote-time happy path). The sidecar is for
      // legacy/backfill use only; promote-time writes embeddings INLINE on
      // features.embedding_mrl_768 + features.embedding_3072. Honor that
      // shape so a full-rebuild from backfill never silently empties the
      // ANN index for the steady-state ingestion path.
      l2NormAssert(features.embedding_mrl_768, `backfill.inline[${fact.id}].embedding_mrl_768`);
      hnsw.add(fact.id, features.embedding_mrl_768);
    }
    // Facts without ANY embedding (e.g. promote-time outage that hasn't yet
    // been backfilled, or `embedBatch` skipped due to a content sanitization
    // issue) are intentionally indexed in BM25 only — the graceful-degrade
    // discipline holds: they remain reachable via the lexical channel.
  }

  // -------------------------------------------------------------------------
  // 5. Persist indices — through the S3 generation-manifest publisher.
  //    FIX CYCLE 2: the old writeFileSync(bm25Path, ...) mutated bm25.json
  //    IN PLACE — a retention hardlink shares that inode, so the write also
  //    corrupted the immutable fallback snapshot — and neither member write
  //    rebound the manifest, so a manifest-managed tree REFUSED the whole
  //    generation on the next cold load. publishGeneration writes both
  //    members (bm25 via the tmp+rename callback below — byte-identical v1
  //    JSON blob, same as before; hnsw via hnsw.save), re-checksums them,
  //    and activates the new generation with a single atomic manifest
  //    rename.
  // -------------------------------------------------------------------------
  if (!existsSync(indicesDir)) {
    mkdirSync(indicesDir, { recursive: true, mode: 0o700 });
  }
  publishGeneration(MODEL_VERSION, {
    bm25: (fixedPath) => {
      const tmpPath = `${fixedPath}.tmp-${process.pid}`;
      writeFileSync(tmpPath, JSON.stringify(bm25.serialize()), {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(tmpPath, fixedPath);
    },
    hnsw,
  });

  const t1 = typeof opts.now === "function" ? opts.now() : Date.now();
  logger.log(
    `backfill: complete embedded=${embedded} bm25_size=${bm25.size()} hnsw_size=${hnsw.size()} elapsed_ms=${t1 - t0}`,
  );

  return {
    model_version: MODEL_VERSION,
    ledger_rows: ledgerRows,
    fact_rows: facts.length,
    sidecar_rows_before: sidecar.size,
    to_embed: toEmbed.length,
    embedded,
    dry_run: false,
    bm25_size: bm25.size(),
    hnsw_size: hnsw.size(),
    sidecar_path: sidecarPath,
    bm25_path: bm25Path,
    hnsw_path: hnswPath,
    elapsed_ms: t1 - t0,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const out = { dryRun: false, force: false };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/backfill-embeddings.mjs [--dry-run] [--force]",
      );
      process.exit(0);
    } else {
      console.error(`backfill: unknown arg "${a}"`);
      process.exit(2);
    }
  }
  return out;
}

const __isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (__isMain) {
  const opts = parseArgv(process.argv.slice(2));
  runBackfill(opts).then(
    (summary) => {
      // Final structured line for shell consumption.
      console.log(`backfill: summary=${JSON.stringify(summary)}`);
      process.exit(0);
    },
    (err) => {
      // s10-remaining-stringcap-sites-2: the over-cap refusal gets its own exit
      // code and prints its MESSAGE, not a V8 stack — matching the in-tree
      // refusal convention (backfill-seed-row-marker.mjs, pinned by
      // mcp/test/scripts-stringcap.test.mjs T4). Exit 1 + full stack is
      // preserved verbatim for every other failure.
      if (err && err.code === "LEDGER_OVER_STRING_CAP") {
        console.error(err.message);
        process.exit(4);
      }
      console.error(`backfill: FATAL ${err && err.stack ? err.stack : err}`);
      process.exit(1);
    },
  );
}
