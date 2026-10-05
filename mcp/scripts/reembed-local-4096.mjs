#!/usr/bin/env node
// reembed-local-4096.mjs — re-embed canonical facts through the LOCAL Qwen3-8B
// server at FULL fidelity. NO TRUNCATION. The model's context is 40,960 tokens
// and the corpus max is ~9,206 tokens, so every fact embeds in full.
//
// Throughput is recovered WITHOUT losing information via LENGTH-BUCKETING:
// short facts (p50=13 tokens) batch huge and fast; the rare long ones batch
// small. Mixing them would pad short texts up to the longest, wasting the GPU —
// that padding artifact (not the context window) was the only "slowness".
//
// Storage (thesis #1: never mutate fact rows):
//   - vectors -> indices/<ACTIVE_EMBED_MODEL_VERSION>/vectors.jsonl  (sidecar:
//     {id, v} per line; recall s_emb reads this for facts that don't carry
//     embedding_4096 on the row, i.e. every pre-existing fact)
//   - HNSW index built from the same vectors for Layer-1 kNN
//
// Usage:
//   node reembed-local-4096.mjs --limit N         # embed first N canonical (validation)
//   node reembed-local-4096.mjs --sample-longest   # embed the longest fact only (lossless proof)
//   node reembed-local-4096.mjs                    # full canonical set
//   node reembed-local-4096.mjs --build-hnsw       # (re)build HNSW from the sidecar
//   node reembed-local-4096.mjs --contextual       # N5: situate-then-embed into
//                                                  #   indices/<model>-contextual/
//                                                  #   (prefix + content; baseline tree untouched).
//                                                  #   Combine with --build-hnsw to build the
//                                                  #   contextual HNSW from the contextual sidecar.

import { createReadStream, existsSync, mkdirSync, readFileSync, appendFileSync, statSync } from "node:fs";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path"; import { fileURLToPath } from "node:url";
import http from "node:http";
import { execSync } from "node:child_process";

// N5-contextual-retrieval — the dense leg of contextual retrieval (situate-
// then-embed). When the contextual mode is on we prefix each fact's text with
// the SAME deterministic descriptor the contextual-BM25 rebuild uses
// (buildContextPrefix) BEFORE chunking, then embed; the vectors land in a
// PARALLEL <model>-contextual/ tree so the baseline tree is never touched
// (thesis #1). The conversation-index is the backward left-join projection that
// recovers a real thread label for facts whose row carries no conversation_id.
import { buildContextPrefix } from "../lib/recall/context-prefix.js";
import {
  loadConversationIndexFromCacheSync,
  lookupConversation,
} from "../lib/synthesis/conversation-index.js";
import { CAPS } from "../lib/validation.js";
// E3 2026-09 — the byte-split ledger reader (splits on the \n BYTE only; never
// node:readline over a ledger). See collectContents for the defect class.
import { streamLedgerRowsById } from "../lib/synthesis/_ledger-stream.js";

const REPO = process.env.MEMORY_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LEDGER = join(REPO, "ledgers", "memory.jsonl");
const CONTENT_INDEX = join(REPO, "storage", "content-index.cache.json");
const CONVERSATION_INDEX_CACHE = join(REPO, "storage", "conversation-index.cache.json");
const MODEL_VERSION = process.env.ACTIVE_EMBED_MODEL_VERSION || "qwen3-embedding-8b-fp16";
const EMBED_URL = process.env.LOCAL_EMBED_URL || "http://127.0.0.1:8359";
const TIMEOUT_MS = Number(process.env.LOCAL_EMBED_TIMEOUT_MS || 600_000); // generous; a long batch is fine

const args = process.argv.slice(2);
const LIMIT = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
const SAMPLE_LONGEST = args.includes("--sample-longest");
const BUILD_HNSW = args.includes("--build-hnsw");
// N5 — contextual dense kill-switch. The explicit --contextual flag wins (for a
// hermetic A/B build into the -contextual tree without flipping the global CAP);
// otherwise fall back to CAPS.CONTEXTUAL_DENSE_ENABLED (default false). When on,
// the output tree is forced to <model>-contextual so the baseline sidecar/HNSW
// are never clobbered.
const CONTEXTUAL = args.includes("--contextual") || CAPS.CONTEXTUAL_DENSE_ENABLED === true;
// The output tree: baseline <model>/ or the parallel <model>-contextual/.
const OUTPUT_MODEL_VERSION = CONTEXTUAL ? `${MODEL_VERSION}-contextual` : MODEL_VERSION;
const INDEX_DIR = join(REPO, "indices", OUTPUT_MODEL_VERSION);
const SIDECAR = join(INDEX_DIR, "vectors.jsonl");
const HNSW_PATH = join(INDEX_DIR, "hnsw.bin");
// --ids-file <path>: embed EXACTLY the newline-delimited fact ids in <path>,
// bypassing the canonical content-index filter. This is the VALIDATION path:
// it GUARANTEES coverage of an explicit id set (e.g. the goldset's
// golden_fact_ids + all giants) so the eval can actually find them, even for
// real ledger facts that the dedup content-index does not list as canonical.
const IDS_FILE = args.includes("--ids-file") ? args[args.indexOf("--ids-file") + 1] : null;
// --- R6 throttle flags — STRICT NO-OPS WHEN ABSENT ---------------------------
// daemons/reembed-drain.mjs advances its sweep cursor on child exit 0 alone and
// expects a flag-absent child to drain its ENTIRE ids-file batch; these flags
// therefore change NOTHING unless explicitly passed (an unconditional slice
// default would let a child exit 0 half-drained and silently strand ids).
//   --batch-texts N  cap texts per HTTP /embed call AND cap the batch's padded
//                    compute at N * MODEL_CONTEXT_TOKENS padded tokens (the
//                    server pads every text in a batch to the batch max; any
//                    sustained long batch inflates MPS ~30GB/min — R6).
//   --slice N        embed at most N pending FACTS this run, then exit 0. The
//                    sidecar IS the cursor: re-running the identical command
//                    resumes. At slice end (only), boundary hygiene may
//                    kickstart the embed server if it sits above 30GB — a
//                    scheduled restart at an idle boundary, never mid-batch.
//   --pause-ms M     awaited sleep between batches so MPS allocator pressure
//                    settles before the next batch.
const BATCH_TEXTS = args.includes("--batch-texts") ? Number(args[args.indexOf("--batch-texts") + 1]) : null;
const SLICE = args.includes("--slice") ? Number(args[args.indexOf("--slice") + 1]) : null;
const PAUSE_MS = args.includes("--pause-ms") ? Number(args[args.indexOf("--pause-ms") + 1]) : null;

function log(...a) { process.stderr.write(a.join(" ") + "\n"); }

// --- 1. canonical fact id set (distinct values of the content-index) ---
function loadCanonicalIds() {
  const raw = JSON.parse(readFileSync(CONTENT_INDEX, "utf8"));
  const map = raw.byContentHash || raw.entries || raw;
  const ids = new Set(Object.values(map).filter((v) => typeof v === "string"));
  return ids;
}

// --- 2. already-embedded ids (resume safety; never re-embed) ---
// STREAM the sidecar — at full corpus it is multi-GB (each line is a 4096-float
// vector), far past Node's ~512MB MAX_STRING_LENGTH, so readFileSync(...,"utf8")
// FATALs ("Cannot create a string longer than 0x1fffffe8 characters"). We only
// need the ids, never the whole file in memory.
async function loadDoneIds() {
  const done = new Set();
  if (!existsSync(SIDECAR)) return done;
  const rl = createInterface({ input: createReadStream(SIDECAR), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try { const o = JSON.parse(line); if (o.id) done.add(o.id); } catch {}
  }
  return done;
}

// --- 3. stream ledger, collect FULL content for wanted canonical ids ---
// Returns a Map id -> { content, row }. We retain the WHOLE row (not just
// content) so the contextual dense path can read id/source/created_at/
// features.entities/provenance for buildContextPrefix — without re-streaming the
// ledger. The row is otherwise unused by the baseline path (it reads .content),
// so this is additive and thesis-#1-safe (we never mutate the row).
//
// E3 2026-09 — DEFECT CLASS: node:readline over a ledger. readline treats
// U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR as line terminators,
// and JSON.stringify does NOT escape them, so a fact whose content carries one
// is torn into fragments that all fail JSON.parse and the row is SILENTLY
// dropped. This child then resolved N-1 of N, the parent's exact reconciliation
// (reembed-drain.mjs classifyWorkProof rule 2, `m === pending`) could never
// hold, and the drain's cursor froze on that batch — live: mem_0000000000000001
// (4,070 chars, U+2028), 599 refused ticks at offset 7092821 between
// 2026-09-04 and 2026-09-15. The mail connector hit the same class first:
// mcp/lib/connectors/mail-body-coverage.js:119-130 ("DO NOT 'simplify' this
// back to node:readline") and its pin mcp/test/mail-body-coverage.test.mjs:340;
// the memory note ledger-readline-u2028-class lists the readers still on
// readline, and this one is now retired. streamLedgerRowsById
// (../lib/synthesis/_ledger-stream.js) splits on the \n BYTE only, keeps
// kind === "fact" + id-in-set with latest-write-wins, and never loads the whole
// 3.65 GB file (readFileSync would hit the string cap). E4 (2026-09) removed
// the helper's first-seen short-circuit that had made the latest-write-wins
// claim false (a re-appended id resolved to its FIRST row; pinned by
// test/synthesis/ledger-stream-by-id.test.mjs and E1b below). Its 8 MiB maxLineBytes
// default is ~8x the longest live row (1,043,546 chars, measured 2026-09-09).
// Why NOT readline: it is the only reader here that splits on characters
// instead of bytes; the sidecar readers below (loadDoneIds, buildHnsw) stay on
// it because a sidecar line is ids + floats and can never carry U+2028.
export async function collectContents(wantIds, opts = {}) {
  const ledgerPath = typeof opts.ledgerPath === "string" ? opts.ledgerPath : LEDGER;
  const byId = new Map();
  const want = wantIds instanceof Set ? wantIds : new Set(wantIds || []);
  const rows = streamLedgerRowsById(ledgerPath, want);
  for (const [id, r] of rows) {
    const c = (r.content || "");
    if (c.length === 0) continue;
    byId.set(id, { content: c, row: r }); // FULL content — no slice, no truncation
  }
  return byId;
}

// N5 — load the backward conversation-index ONCE (sync, cache-only) so the
// contextual prefix can resolve a real thread label for facts whose row carries
// no provenance.conversation_id. Best-effort + defensive: a missing / stale /
// corrupt cache returns null and buildContextPrefix degrades to the on-row
// resolution (the SAME degrade the contextual-BM25 rebuild uses,
// bm25-rebuild.js:317-320). opts.cachePath overrides for hermetic tests.
function loadConversationIndexForContextual(opts = {}) {
  const cachePath =
    typeof opts.cachePath === "string" ? opts.cachePath : CONVERSATION_INDEX_CACHE;
  const ledgerPath = typeof opts.ledgerPath === "string" ? opts.ledgerPath : LEDGER;
  try {
    return loadConversationIndexFromCacheSync({ ledgerPath, cachePath });
  } catch {
    return null;
  }
}

// buildEmbedTextForRow — PURE. Given a fact row + its content + the contextual
// toggle (and an optional conversation-index), return the exact text that will
// be CHUNKED then embedded. This is the dense analogue of the BM25 concat at
// bm25-rebuild.js:317-326: prefix + "\n\n" + content. Applied to the WHOLE fact
// BEFORE chunksFor, so chunk #0 of a giant carries the situating context (the
// cookbook situates the whole doc; per-chunk re-prefixing would multiply the
// prefix cost on giants and add no recall the doc-level situation lacks).
//
//   - contextual === false  -> returns content byte-identical (no-op; the
//                              baseline embedded text is unchanged).
//   - contextual === true   -> prefix + "\n\n" + content when the prefix is
//                              non-empty; content alone when nothing resolves
//                              (a prefix-less row degrades to the baseline text,
//                              so the contextual vector is never WORSE).
//
// Never throws (buildContextPrefix is itself pure + defensive); a thrown prefix
// degrades to the raw content.
export function buildEmbedTextForRow(row, content, opts = {}) {
  const base = typeof content === "string" ? content : "";
  if (opts.contextual !== true) return base;
  let prefix = "";
  try {
    const idx = opts.conversationIndex;
    prefix =
      idx != null
        ? buildContextPrefix(row, { conversationIndex: idx, lookupConversation })
        : buildContextPrefix(row);
  } catch {
    prefix = "";
  }
  if (typeof prefix === "string" && prefix.length > 0) {
    return prefix + "\n\n" + base;
  }
  return base;
}

// Use Node's http (NOT undici fetch) with agent:false — a FRESH socket per
// request, no connection pool to corrupt. fetch's pooled keep-alive against this
// HTTP/1.0 server accumulated half-open/reset sockets over a long run, producing
// bursts of "fetch failed" the in-process retry couldn't escape (a fresh `curl`
// always worked — the server was never the problem). agent:false sidesteps it.
function embedBatchOnce(texts) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ texts, is_query: false, dim: 4096 });
    const u = new URL(EMBED_URL);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: "/embed",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Connection: "close",
        },
        agent: false, // no keep-alive pool — fresh connection every request
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`embed HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          }
          let j;
          try { j = JSON.parse(body); } catch (e) { return reject(new Error(`embed bad json: ${e.message}`)); }
          if (!Array.isArray(j.embeddings) || j.embeddings.length !== texts.length) {
            return reject(new Error(`embed shape mismatch: got ${j.embeddings?.length} for ${texts.length}`));
          }
          resolve(j.embeddings);
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("embed timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// RETRY transient failures instead of FATAL-ing a multi-hour backfill. A dropped
// connection ("fetch failed" / ECONNRESET) on a long-held embed request is a
// transient blip — the embed-server is the single source of truth and stays
// healthy, so re-issue the SAME batch with backoff rather than aborting the run
// (one blip after 3,056 good embeds killed an earlier pass). Only a persistent
// failure across all attempts propagates.
async function embedBatch(texts) {
  const MAX_ATTEMPTS = 8;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await embedBatchOnce(texts);
    } catch (e) {
      lastErr = e;
      if (attempt === MAX_ATTEMPTS) break;
      const backoffMs = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
      log(`WARN embed attempt ${attempt}/${MAX_ATTEMPTS} failed (${e.message}); retry in ${backoffMs}ms`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

// Adaptive batch size: large for short text, small for long — bounds the
// per-request padded compute so no request stalls AND throughput stays high.
export function batchSizeForCharLen(maxChars) {
  if (maxChars <= 200) return 256;
  if (maxChars <= 1000) return 128;
  if (maxChars <= 4000) return 48;
  if (maxChars <= 16000) return 12;
  return 4; // very long (still FULL text, just fewer per request)
}

// ---------------------------------------------------------------------------
// FULL-FIDELITY CHUNKING (no silent truncation).
//
// The model context is 40,960 tokens. Using the same chars/4 token proxy the
// Map phase used, that is ~163,840 chars. We keep a SAFETY MARGIN below the
// ceiling so even token-dense (code / CJK) text stays in-window: WINDOW chars
// embed whole; anything longer is split into overlapping windows. EVERY window
// is embedded in FULL — no slice() ever drops a token (the only failure mode is
// a single un-splittable segment > the ceiling, which is logged LOUD, never
// silently sliced).
//
// TURN-AWARE: the giant facts are debate/transcript captures whose natural
// boundary is the turn delimiter the Map found ("\n---\n", 76 occurrences in a
// sampled 160K-char giant; "\n\n## " section headers are a secondary boundary).
// We split on those boundaries FIRST and pack whole turns into windows so a
// chunk edge never lands mid-sentence; only a single turn that ALONE exceeds the
// window falls back to a hard char-window (still full, just sub-turn).
// ---------------------------------------------------------------------------
export const CHARS_PER_TOKEN = 4;            // chars/4 token proxy (Map phase)
// EFFECTIVE server cap, not the advertised 40,960. The Qwen3-8B model wedges the
// MPS GPU on multi-thousand-token sequences ("Invalid buffer size: ... GiB"), so
// the embed server truncates at EMBED_MAX_SEQ_TOKENS=2048. To embed giants in
// FULL (no server-side truncation) every chunk must stay UNDER that cap, so the
// window targets ~1800 tokens of headroom below 2048.
export const MODEL_CONTEXT_TOKENS = 2_048;   // effective server cap (see embed_server.py)
// Window kept under the 2048-token server cap: ~1800 tokens => ~7200 chars.
export const WINDOW = 7_200;
export const OVERLAP = 720;                   // ~10% boundary context across edges
// Turn delimiters, most-specific first. The capturing form keeps the delimiter
// attached to the FOLLOWING turn so a turn's marker is embedded with its body.
export const TURN_DELIMITERS = ["\n---\n", "\n\n## "];

// Split text into turn-segments on the first delimiter that actually occurs.
// Returns the original text as a single segment when no delimiter is present.
export function splitTurns(text) {
  for (const delim of TURN_DELIMITERS) {
    if (text.indexOf(delim) === -1) continue;
    const parts = text.split(delim);
    const segs = [];
    for (let i = 0; i < parts.length; i++) {
      // Re-attach the delimiter to every segment after the first so no boundary
      // text is lost and each turn keeps its leading marker.
      segs.push(i === 0 ? parts[i] : delim + parts[i]);
    }
    return segs.filter((s) => s.length > 0);
  }
  return [text];
}

// Pack a single text into multi-vector chunks (turn-aware, overlapping).
// - text within WINDOW -> one chunk, id unchanged (no '#k' suffix).
// - longer -> turn segments packed greedily into <=WINDOW windows; consecutive
//   windows overlap by ~OVERLAP chars (the previous window's tail is prepended)
//   so a span crossing a boundary is embedded in both.
// - a single turn > WINDOW is hard char-windowed (sub-turn) — still full text.
// Every emitted chunk id is `${id}#${k}` when there is more than one chunk.
export function chunksFor(id, text, opts = {}) {
  const window = opts.window || WINDOW;
  const overlap = opts.overlap != null ? opts.overlap : OVERLAP;
  const onWarn = typeof opts.onWarn === "function" ? opts.onWarn : null;
  const ceilingChars = MODEL_CONTEXT_TOKENS * CHARS_PER_TOKEN;
  if (typeof text !== "string" || text.length === 0) return [];
  if (text.length <= window) {
    // Single-chunk fast path. Even here, never ship a vector silently built
    // from text past the model ceiling — warn LOUD (truncation-impossible).
    if (text.length > ceilingChars && onWarn) {
      onWarn(`fact ${id} is ${text.length} chars (~${Math.round(text.length / CHARS_PER_TOKEN)} tokens) > context ${MODEL_CONTEXT_TOKENS}; window=${window} disabled chunking — embedding in full (server may truncate)`);
    }
    return [{ id, text }];
  }

  // 1. Turn-aware segmentation. Any single segment longer than the window is
  //    hard char-windowed into <=window pieces (last resort; still full text).
  const rawSegs = splitTurns(text);
  const segs = [];
  for (const s of rawSegs) {
    if (s.length <= window) { segs.push(s); continue; }
    // Hard char-window a too-long single turn (e.g. one enormous code block).
    for (let p = 0; p < s.length; p += window) segs.push(s.slice(p, p + window));
  }

  // 2. Greedy pack segments into windows; carry an OVERLAP tail across edges.
  const windows = [];
  let cur = "";
  for (const seg of segs) {
    if (cur.length === 0) { cur = seg; continue; }
    if (cur.length + seg.length <= window) { cur += seg; continue; }
    // Flush cur; seed the next window with cur's tail for boundary context.
    windows.push(cur);
    const tail = overlap > 0 ? cur.slice(Math.max(0, cur.length - overlap)) : "";
    cur = tail + seg;
    // Guard: tail+seg could exceed window for a near-window segment — hard-window.
    while (cur.length > window) {
      windows.push(cur.slice(0, window));
      cur = cur.slice(window - overlap);
    }
  }
  if (cur.length > 0) windows.push(cur);

  // 3. Hard ceiling check — never silently slice past the model context.
  const out = [];
  for (let k = 0; k < windows.length; k++) {
    const w = windows[k];
    if (w.length > ceilingChars && onWarn) {
      onWarn(`chunk ${id}#${k} is ${w.length} chars (~${Math.round(w.length / CHARS_PER_TOKEN)} tokens) > context ${MODEL_CONTEXT_TOKENS}; embedding in full anyway (server may truncate)`);
    }
    out.push({ id: `${id}#${k}`, text: w });
  }
  return out;
}

// planEmbedItems — PURE (no I/O, no module-scope state). Turns the resolved
// contents into the embed work list and counts what item-level resume skipped.
// E3 2026-09: extracted from main() so the completeness count is testable.
//
//   contents          Map id -> { content, row } (collectContents' shape), or
//                     id -> content string.
//   done              Set of sidecar ids already present (bare AND `${id}#k`).
//   want              Set of the fact ids this run was asked to embed. Ids in
//                     `want` that are ABSENT from `contents` (unresolvable
//                     ledger rows) STAY PENDING — the safe direction of failure
//                     the parent's R6 doctrine requires: it must stall LOUDLY
//                     on a row it cannot read, never advance past it.
//   contextual        N5 situate-then-embed toggle; conversationIndex feeds it.
//   onWarn            chunksFor's LOUD ceiling warning sink (optional).
//
// Returns { items, pendingAfterResume, resumedChunkItems, chunkedFacts,
//           chunkVectors, prefixedFacts }.
//
// pendingAfterResume is the completeness count residual r6-4 was waiting on
// (daemons/reembed-drain.mjs, "a completeness check that knows the expected
// chunk count"). A fact is COMPLETE iff EVERY chunk id chunksFor yields for its
// CURRENT text is in `done` (a whole fact is its single bare id; a giant is
// `${id}#0..#k`), and pendingAfterResume = want.size - completeFacts. The
// bare-id done-filter in main() cannot see `${id}#k` sidecar lines, so without
// this a fully-embedded chunked giant was reported pending on every run while
// item-level resume wrote nothing for it — the parent's `m === pending` rule
// then never reconciled and the cursor froze (12 such giants in the live batch
// at offset 7092821). Trust boundary: completeness is computed from CURRENT
// content under the CURRENT WINDOW/OVERLAP; if either changed since the chunks
// were embedded the expected chunk set differs and the fact is re-embedded —
// exactly item-level resume's existing behaviour, not a new exposure.
export function planEmbedItems({ contents, done, want, contextual, conversationIndex, onWarn } = {}) {
  const src = contents instanceof Map ? contents : new Map();
  const doneSet = done instanceof Set ? done : new Set();
  const wantSize = want instanceof Set ? want.size : src.size;
  const isContextual = contextual === true;
  const items = [];
  let chunkedFacts = 0, chunkVectors = 0, prefixedFacts = 0, resumedChunkItems = 0, completeFacts = 0;
  for (const [id, entry] of src.entries()) {
    const rawContent = entry && typeof entry === "object" ? entry.content : entry;
    const row = entry && typeof entry === "object" ? entry.row : { id, content: rawContent };
    const embedText = buildEmbedTextForRow(row, rawContent, {
      contextual: isContextual,
      conversationIndex,
    });
    const rawLen = typeof rawContent === "string" ? rawContent.length : 0;
    if (isContextual && embedText.length > rawLen) prefixedFacts++;
    const cs = chunksFor(id, embedText, { onWarn });
    if (cs.length > 1) { chunkedFacts++; chunkVectors += cs.length; }
    // Nothing to embed (empty text) is never "complete" — it stays pending.
    let complete = cs.length > 0;
    for (const c of cs) {
      // Item-level resume (R6): chunked facts write ONLY `${id}#k` sidecar
      // lines, so the bare-id done-filter above never skips a giant — without
      // this, every resumed run re-embeds every giant, and under --slice the
      // same giants would be re-selected by EVERY run and starve progress.
      // Pure cost-saving, no correctness change: buildHnsw's seen-set dedups
      // chunk-ids regardless.
      if (doneSet.has(c.id)) { resumedChunkItems++; continue; }
      complete = false;
      items.push(c);
    }
    if (complete) completeFacts++;
  }
  return {
    items,
    pendingAfterResume: Math.max(0, wantSize - completeFacts),
    resumedChunkItems,
    chunkedFacts,
    chunkVectors,
    prefixedFacts,
  };
}

// --- R6 slice-boundary hygiene (only runs under --slice) ---------------------
// At slice end the process is IDLE by construction (no batch in flight), so a
// server restart here can never strand a half-done batch. If the server's
// phys_footprint sits above 30GB we kickstart it and wait for /health before
// exiting 0 — the next slice then starts against a fresh ~18GB baseline instead
// of racing the 45GB watchdog threshold. The watchdog stays the sole EMERGENCY
// actor; this is the scheduled, cooperative counterpart.
const BOUNDARY_KICKSTART_GB = 30;
const EMBED_SERVER_LABEL = "com.user.memory-system.embed-server";

function shQuiet(cmd) {
  try { return execSync(cmd, { encoding: "utf8", timeout: 15_000 }); } catch { return ""; }
}

function healthOk() {
  return new Promise((resolve) => {
    const u = new URL(EMBED_URL);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: "/health", method: "GET", agent: false, timeout: 3_000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try { resolve(res.statusCode === 200 && JSON.parse(body).ok === true); }
          catch { resolve(false); }
        });
      }
    );
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function sliceBoundaryHygiene() {
  // Same pid-resolution idiom as embed-watchdog.sh:68.
  const pid = shQuiet(
    `launchctl list 2>/dev/null | awk '$3 == "${EMBED_SERVER_LABEL}" { print $1; exit }'`,
  ).trim();
  if (!/^[0-9]+$/.test(pid)) {
    log(`slice-boundary: no running pid for ${EMBED_SERVER_LABEL}; skipping hygiene`);
    return;
  }
  const raw = shQuiet(`/usr/bin/footprint -p ${pid} 2>/dev/null | awk '/phys_footprint:/ { print; exit }'`).trim();
  const m = raw.match(/phys_footprint:\s+([0-9]+(?:\.[0-9]+)?)\s+(GB|MB|KB)/);
  if (!m) {
    log(`slice-boundary: unparseable footprint for pid=${pid} (raw: '${raw.slice(0, 200)}'); skipping hygiene`);
    return;
  }
  let gb = Number(m[1]);
  if (m[2] === "MB") gb /= 1024;
  else if (m[2] === "KB") gb /= 1048576;
  if (!(gb > BOUNDARY_KICKSTART_GB)) {
    log(`slice-boundary: server pid=${pid} footprint=${gb.toFixed(1)}GB <= ${BOUNDARY_KICKSTART_GB}GB; no restart needed`);
    return;
  }
  log(`slice-boundary: server pid=${pid} footprint=${gb.toFixed(1)}GB > ${BOUNDARY_KICKSTART_GB}GB -> scheduled kickstart (idle boundary, never mid-batch)`);
  shQuiet(`launchctl kickstart -k gui/${process.getuid()}/${EMBED_SERVER_LABEL}`);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await healthOk()) {
      log("slice-boundary: server healthy after scheduled kickstart");
      return;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  log("slice-boundary: server not healthy within 60s of kickstart (launchd KeepAlive will finish the reload; exiting 0 regardless)");
}

async function main() {
  // Loud validation of throttle flags (here, not at module top level, so
  // importing this file's exports can never exit the importer's process).
  for (const [name, v] of [["--batch-texts", BATCH_TEXTS], ["--slice", SLICE], ["--pause-ms", PAUSE_MS]]) {
    if (v === null) continue;
    const min = name === "--pause-ms" ? 0 : 1;
    if (!Number.isFinite(v) || v < min) {
      throw new Error(`${name} requires a number >= ${min}, got '${v}'`);
    }
  }
  mkdirSync(INDEX_DIR, { recursive: true, mode: 0o700 });
  const done = await loadDoneIds();
  let targetIds;
  if (IDS_FILE) {
    const explicit = new Set(
      readFileSync(IDS_FILE, "utf8").split("\n").map((s) => s.trim()).filter(Boolean),
    );
    log(`--ids-file ${IDS_FILE}: ${explicit.size.toLocaleString()} explicit ids already_embedded=${done.size.toLocaleString()}`);
    targetIds = explicit;
  } else {
    const canonical = loadCanonicalIds();
    log(`canonical=${canonical.size.toLocaleString()} already_embedded=${done.size.toLocaleString()}`);
    targetIds = canonical;
  }

  let want = new Set([...targetIds].filter((id) => !done.has(id)));
  log(`pending after done-filter: ${want.size.toLocaleString()} facts`);
  if (SLICE !== null) {
    // --slice: truncate the pending FACT-id list BEFORE collectContents so this
    // process embeds at most SLICE facts, then exits 0. The sidecar is the
    // cursor — the next run's done-filter advances past whatever completed.
    want = new Set([...want].slice(0, SLICE));
    log(`--slice ${SLICE}: processing ${want.size.toLocaleString()} pending facts this run (sidecar is the cursor; re-run to resume)`);
  }
  const contents = await collectContents(want);
  log(`contents resolved: ${contents.size.toLocaleString()}`);
  if (contents.size < want.size) {
    // E3 2026-09 — NAME the rows the ledger did not yield (they stay pending in
    // planEmbedItems and stall the parent loudly), so the next unresolvable
    // row is read off the drain log instead of rediscovered by streaming 3.65 GB
    // by hand. Capped at 10 ids so one line stays readable.
    const unresolved = [...want].filter((id) => !contents.has(id));
    log(`contents unresolved: ${unresolved.length.toLocaleString()} (sample: ${unresolved.slice(0, 10).join(", ")})`);
  }

  // N5 — contextual dense: load the backward conversation-index ONCE so the
  // prefix resolves a real thread label, and report whether the join is live (a
  // null index silently degrades to the on-row resolution — the same 0%-coverage
  // failure the earlier eval hit if the cache is stale, so we log it loudly).
  let conversationIndex = null;
  if (CONTEXTUAL) {
    conversationIndex = loadConversationIndexForContextual();
    const joined = conversationIndex && conversationIndex.byFactId instanceof Map
      ? conversationIndex.byFactId.size
      : 0;
    log(`CONTEXTUAL dense: output tree=${OUTPUT_MODEL_VERSION} conversation_index=${conversationIndex ? `LIVE (${joined.toLocaleString()} facts joined)` : "ABSENT/STALE -> on-row degrade"}`);
  }

  // Build [id, text] list. Facts within the context window embed whole; facts
  // that EXCEED it are CHUNKED into overlapping windows — every window embedded
  // in full, stored multi-vector as `${factId}#${k}`. No token is ever dropped.
  // N5 — when contextual, the prefix is applied to the WHOLE fact text BEFORE
  // chunksFor, so chunk #0 carries the situating context (situate-then-embed).
  // E3 2026-09 — the loop lives in planEmbedItems (pure, exported, tested); it
  // also counts the facts whose EVERY chunk is already in the sidecar, which is
  // the completeness check residual r6-4 was waiting on.
  const plan = planEmbedItems({
    contents,
    done,
    want,
    contextual: CONTEXTUAL,
    conversationIndex,
    onWarn: (m) => log("WARN", m),
  });
  let items = plan.items;
  const { chunkedFacts, chunkVectors, prefixedFacts, resumedChunkItems, pendingAfterResume } = plan;
  if (resumedChunkItems > 0) {
    log(`skipped ${resumedChunkItems.toLocaleString()} already-embedded chunk-ids (item-level resume)`);
  }
  // E3 2026-09 — the ONE line added to the child's stderr contract. The parent
  // (daemons/reembed-drain.mjs parseChildWorkEvidence) prefers it over the
  // bare-id `pending after done-filter` line above (kept byte-identical for the
  // log census), because the bare-id filter cannot see `${id}#k` sidecar lines
  // and so reports a fully-embedded chunked giant as pending forever. Ids that
  // never resolved from the ledger are STILL counted here: unresolved work must
  // stall the parent loudly, never advance it.
  log(`pending after item-level resume: ${pendingAfterResume.toLocaleString()} facts`);
  if (chunkedFacts > 0) {
    log(`chunked ${chunkedFacts} over-context facts into ${chunkVectors} chunk-vectors (multi-vector; full coverage, no truncation)`);
  }
  if (CONTEXTUAL) {
    log(`CONTEXTUAL dense: prefixed ${prefixedFacts.toLocaleString()}/${contents.size.toLocaleString()} facts (non-empty prefix); the rest degraded to raw content`);
  }
  // Drop empty/whitespace-only chunks: the model maps them to a zero vector,
  // and normalize_embeddings then divides by zero -> NaN, which both poisons the
  // index and breaks the JSON write. A delimiter-only turn ("\n---\n") carries
  // no retrievable signal, so dropping it loses nothing. (Real content is never
  // dropped — only blank fragments.)
  const beforeFilter = items.length;
  items = items.filter((it) => typeof it.text === "string" && it.text.trim().length > 0);
  if (items.length < beforeFilter) {
    log(`dropped ${beforeFilter - items.length} empty/whitespace-only chunks (zero-vector/NaN guard)`);
  }
  items.sort((a, b) => a.text.length - b.text.length);

  if (SAMPLE_LONGEST) {
    items = items.slice(-1); // the single longest fact — prove it embeds in full
    log(`SAMPLE_LONGEST: id=${items[0].id} chars=${items[0].text.length}`);
  } else if (Number.isFinite(LIMIT)) {
    // For a representative validation, take a spread: shortest..longest.
    if (items.length > LIMIT) {
      const step = items.length / LIMIT;
      const picked = [];
      for (let i = 0; i < LIMIT; i++) picked.push(items[Math.floor(i * step)]);
      items = picked;
    }
    log(`LIMIT ${LIMIT}: embedding ${items.length} (length-spread sample)`);
  }

  let embedded = 0, started = Date.now();
  const factsWritten = new Set();
  let i = 0;
  while (i < items.length) {
    const head = items[i];
    let bs = batchSizeForCharLen(head.text.length * 1.2); // current bucket's scale
    let end = i + bs;
    if (BATCH_TEXTS !== null) {
      // --batch-texts: hard cap on texts per HTTP call, PLUS a padded-token cap.
      // The server pads every text in a batch to the batch max; the global
      // length-sort above keeps batches near-homogeneous (ascending), so the
      // candidate at `end` is always the batch max. Stop extending the batch
      // once padding all members to that max would exceed
      // BATCH_TEXTS * MODEL_CONTEXT_TOKENS padded tokens (~N full-window texts
      // of compute) — bounded shapes keep the MPS allocator from inflating.
      bs = Math.min(bs, BATCH_TEXTS);
      end = i + 1; // the head always ships (progress is guaranteed)
      while (end < items.length && end - i < bs) {
        const paddedTokens = (end - i + 1) * Math.ceil(items[end].text.length / CHARS_PER_TOKEN);
        if (paddedTokens > BATCH_TEXTS * MODEL_CONTEXT_TOKENS) break;
        end++;
      }
    }
    const slice = items.slice(i, end);
    const maxChars = Math.max(...slice.map((x) => x.text.length));
    const t0 = Date.now();
    const vecs = await embedBatch(slice.map((x) => x.text));
    const dt = (Date.now() - t0) / 1000;
    // Append to sidecar (id -> vector). Append-only, resumable, no row mutation.
    // VALIDATE each vector is finite (no NaN/Inf): a degenerate input can still
    // slip a non-finite vector through the server; writing it would corrupt the
    // sidecar JSON AND poison the HNSW. Skip+log such a vector (the fact simply
    // gets no dense vector this pass — never a crash, never a NaN in the index).
    let buf = "", wrote = 0, skipped = 0;
    for (let k = 0; k < slice.length; k++) {
      const v = vecs[k];
      const ok = Array.isArray(v) && v.length === 4096 && v.every((x) => Number.isFinite(x));
      if (!ok) { skipped++; log(`  SKIP non-finite/badshape vector for ${slice[k].id} (len=${Array.isArray(v) ? v.length : "n/a"})`); continue; }
      buf += JSON.stringify({ id: slice[k].id, v }) + "\n";
      wrote++;
      factsWritten.add(slice[k].id.replace(/#\d+$/, ""));
    }
    if (buf) appendFileSync(SIDECAR, buf, { mode: 0o600 });
    embedded += wrote;
    i += slice.length;
    const rate = embedded / ((Date.now() - started) / 1000);
    log(`+${slice.length} (bs=${slice.length} maxchars=${maxChars} ${dt.toFixed(1)}s) total=${embedded.toLocaleString()} rate=${rate.toFixed(1)}/s remaining=${(items.length - i).toLocaleString()}`);
    // --pause-ms: let MPS allocator pressure settle between batches.
    if (PAUSE_MS !== null && PAUSE_MS > 0 && i < items.length) {
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
  }
  log(`DONE embedded=${embedded.toLocaleString()} facts=${factsWritten.size.toLocaleString()} in ${((Date.now() - started) / 1000 / 60).toFixed(1)}min sidecar=${SIDECAR}`);
  if (SLICE !== null) {
    await sliceBoundaryHygiene();
  }
}

// --- --build-hnsw — (re)build the 4096 HNSW from the sidecar -----------------
// The sidecar is the SINGLE canonical producer (thesis #1: derived projection).
// Each sidecar line is {id, v}; id may be a chunk-id `${factId}#${k}`. The HNSW
// stores one entry per chunk-id (recall strips/dedupes chunk-ids back to facts).
async function buildHnsw() {
  if (!existsSync(SIDECAR)) throw new Error(`no sidecar at ${SIDECAR}`);
  const { HnswIndex } = await import("../lib/recall/hnsw-index.js");
  // The local embed server returns near-unit vectors (||v|| ~ 0.9999..1.0003)
  // that drift outside HnswIndex.add's strict 1e-6 unit-norm invariant. The
  // index contract is "caller renormalizes before add", so we L2-renormalize
  // every sidecar vector to EXACT unit norm here. cosine == dot is preserved.
  const { l2Renormalize } = await import("../lib/vector-math.js");
  // N5 — stamp the OUTPUT tree's model version (baseline <model> or the
  // -contextual variant) so the on-disk HNSW is self-describing: a loaded
  // contextual index reports its own contextual model id, never the baseline's.
  const hnsw = new HnswIndex({ dims: 4096, embedding_model_version: OUTPUT_MODEL_VERSION });
  const rl = createInterface({ input: createReadStream(SIDECAR), crlfDelay: Infinity });
  let added = 0, skipped = 0, seen = new Set();
  for await (const line of rl) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { skipped++; continue; }
    if (!o || typeof o.id !== "string" || !Array.isArray(o.v)) { skipped++; continue; }
    if (seen.has(o.id)) { skipped++; continue; } // dedup chunk-ids defensively
    seen.add(o.id);
    try { hnsw.add(o.id, l2Renormalize(o.v)); added++; }
    catch (e) { skipped++; if (skipped <= 5) log("WARN hnsw.add skipped", o.id, e.message); }
  }
  // S3 FIX CYCLE 2 — a bare hnsw.save(HNSW_PATH) was an out-of-band
  // fixed-path rewrite: on a manifest-managed tree the next cold load
  // REFUSED the whole generation (checksum mismatch against the stale
  // manifest) and this rebuild's output was silently discarded/clobbered.
  // publishGeneration performs the identical hnsw.save at the same fixed
  // path (config.js MEMORY_ROOT resolves exactly like REPO above), then
  // re-checksums it and rebinds the generation manifest atomically; the
  // untouched bm25 member's recorded checksum is carried forward.
  const { publishGeneration } = await import("../lib/recall/index-cache.js");
  publishGeneration(OUTPUT_MODEL_VERSION, { hnsw });
  log(`BUILD_HNSW done: added=${added.toLocaleString()} skipped=${skipped} -> ${HNSW_PATH} size=${hnsw.size()}`);
}

// Auto-run only when invoked directly (so tests can import the pure helpers
// — chunksFor / splitTurns / batchSizeForCharLen — without firing a re-embed).
// Main-module check that survives spaces and symlinks in the invocation path:
// compare real filesystem paths, never a hand-built file:// string.
const INVOKED_DIRECTLY = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (INVOKED_DIRECTLY) {
  const run = BUILD_HNSW ? buildHnsw : main;
  run().catch((e) => { log("FATAL", e.message); process.exit(1); });
}
