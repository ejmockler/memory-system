// embed-cost.js — F-META-EMBED-COST-TELEMETRY
//
// Quantifies embedder cost (tokens, USD/month, compute/month) so the operator
// can answer "is this engineering effort justified" before/after each Stage-0
// fix. The audit roadmap claims "reduces embed cost" without a $/month
// baseline; 96% of a $5/mo corpus is $4.80, 96% of a $500/mo corpus is $480.
//
// Surfaces:
//   1. recordEmbedCall({ model, input_tokens, output_tokens, source }) —
//      bump the daily counter for the (model, source) pair. Caller is the
//      gemini-client wrapper; per-source modules do NOT call this directly.
//   2. flushDaily({ sync?: boolean }) — append today's snapshot as a JSONL
//      row to storage/telemetry/embed-cost-<UTC-YYYY-MM-DD>.jsonl. Auto-
//      called every FLUSH_EVERY_N records and on graceful shutdown.
//   3. snapshotCounters() — read-only deep copy of the current
//      Map<(model,source) -> {input_tokens, output_tokens, call_count}>,
//      surfaced via memory_connectors_list for operator inspection.
//   4. wrapEmbedSingle(fn, opts) / wrapEmbedBatch(fn, opts) — higher-order
//      wrappers around the gemini-client embed surfaces. Caller does:
//        import { embedSingle } from "../gemini-client.js";
//        import { wrapEmbedSingle } from "../observability/embed-cost.js";
//        const trackedEmbedSingle = wrapEmbedSingle(embedSingle);
//      The wrappers token-count the input + output, call recordEmbedCall,
//      and pass through the original return value unchanged.
//   5. resetForTests() — clear the in-process state. Test-only.
//
// Cost model:
//   PRICE_TABLE maps model_id -> { input_per_1k_usd, output_per_1k_usd }.
//   gemini-embedding-001 pricing as of 2026-06: $0.00015 per 1k input
//   tokens (embeddings are input-only; there is no output token cost).
//   The table is operator-tunable via storage/embed-cost-pricing.json
//   so price changes do not require code edits. Missing entries default
//   to {input: 0, output: 0} and emit a stderr warning at first miss
//   per model.
//
// Token counting:
//   Embeddings consume input tokens approximately equal to the UTF-8 byte
//   length divided by 4 (Gemini's tokenizer averages ~4 bytes/token for
//   English text). A more accurate count requires the @google/generative-ai
//   countTokens API, which is itself a network call. We use the byte/4
//   approximation with a documented error bar of ~15% over-count for
//   English prose and ~30% over-count for code (more whitespace and
//   punctuation -> fewer tokens). The estimate is conservative (over-counts)
//   so cost-reduction claims are credible.
//
// Daily rotation: the JSONL sink is keyed by UTC date. Each flush re-derives
// the filename so a long-running process naturally rolls forward at UTC
// midnight without an explicit rotator.
//
// HERMETICITY: the sink directory is derived from STORAGE_DIR in lib/config.js,
// so MEMORY_ROOT / STORAGE_BASE_DIR env-override discipline works for tests
// + hermetic e2e harnesses.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { STORAGE_DIR } from "../config.js";
import { serverTs } from "../envelope.js";

// ---------------------------------------------------------------------------
// Caps / constants. Production values are not env-overridable; drift in
// flush cadence is a code change, not a config change.
// ---------------------------------------------------------------------------
export const FLUSH_EVERY_N = 100;
export const TOKEN_BYTES_PER_TOKEN = 4;
export const PRICING_OVERRIDE_PATH = join(
  STORAGE_DIR,
  "embed-cost-pricing.json",
);

// USD prices per 1000 tokens. Default reflects gemini-embedding-001 list
// price as of 2026-06. Operator can override via embed-cost-pricing.json.
// Missing models default to zero with a one-time stderr warning so the
// operator notices schema drift.
const DEFAULT_PRICE_TABLE = Object.freeze({
  "gemini-embedding-001": { input_per_1k_usd: 0.00015, output_per_1k_usd: 0 },
  // Aliases the runtime may stamp through (the gemini-client pins
  // GEMINI_EMBEDDING_MODEL_VERSION = "gemini-embedding-001" today; keep this
  // table in sync if that pinning changes).
});

// ---------------------------------------------------------------------------
// In-process state. Resets on daemon restart; the JSONL sink is the durable
// surface. Daily counts are reconstructable from the sink.
// ---------------------------------------------------------------------------

// Map<"<model>::<source>", { input_tokens, output_tokens, call_count }>
let _counters = new Map();
let _writesSinceFlush = 0;
let _priceTable = null;            // lazy-loaded; merged from default + override
let _missingModelsWarned = new Set();
let _shutdownHandlersRegistered = false;

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

function _loadPriceTable() {
  if (_priceTable !== null) return _priceTable;
  const merged = { ...DEFAULT_PRICE_TABLE };
  if (existsSync(PRICING_OVERRIDE_PATH)) {
    try {
      const raw = readFileSync(PRICING_OVERRIDE_PATH, "utf8");
      if (raw !== "") {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const key of Object.keys(parsed)) {
            const entry = parsed[key];
            if (
              entry &&
              typeof entry === "object" &&
              typeof entry.input_per_1k_usd === "number" &&
              typeof entry.output_per_1k_usd === "number"
            ) {
              merged[key] = {
                input_per_1k_usd: entry.input_per_1k_usd,
                output_per_1k_usd: entry.output_per_1k_usd,
              };
            }
          }
        }
      }
    } catch (err) {
      try {
        process.stderr.write(
          `embed-cost: failed to read pricing override ${PRICING_OVERRIDE_PATH}: ${
            err && err.message ? err.message : String(err)
          }; using defaults\n`,
        );
      } catch {
        /* never let logging fail */
      }
    }
  }
  _priceTable = merged;
  return _priceTable;
}

function _priceForModel(model) {
  const table = _loadPriceTable();
  if (Object.prototype.hasOwnProperty.call(table, model)) {
    return table[model];
  }
  if (!_missingModelsWarned.has(model)) {
    _missingModelsWarned.add(model);
    try {
      process.stderr.write(
        `embed-cost: no price table entry for model "${model}"; defaulting to $0/1k tokens. ` +
          `Add entry to ${PRICING_OVERRIDE_PATH} to fix cost estimates.\n`,
      );
    } catch {
      /* never let logging fail */
    }
  }
  return { input_per_1k_usd: 0, output_per_1k_usd: 0 };
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

// Estimate input tokens for a string by UTF-8 byte length / 4. Conservative:
// over-counts by ~15-30% relative to the actual Gemini tokenizer. Documented
// trade-off — the cost telemetry deliberately biases upward so cost-reduction
// claims (engineering hours justified) are credible.
export function estimateInputTokens(text) {
  if (typeof text !== "string") return 0;
  if (text.length === 0) return 0;
  const byteLength = Buffer.byteLength(text, "utf8");
  return Math.ceil(byteLength / TOKEN_BYTES_PER_TOKEN);
}

// Estimate tokens for a batch. Returns the SUM across all items, not a list.
export function estimateBatchInputTokens(items) {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const item of items) {
    if (typeof item === "string") {
      total += estimateInputTokens(item);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

function _counterKey(model, source) {
  // Use a separator that is unlikely in either field. "::" is the same
  // shape used by the stage-0 telemetry layer for consistency.
  const safeModel = typeof model === "string" && model.length > 0 ? model : "unknown_model";
  const safeSource =
    typeof source === "string" && source.length > 0 ? source : "unknown_source";
  return `${safeModel}::${safeSource}`;
}

// recordEmbedCall — bump the daily counter for (model, source). Inputs:
//   - model         : string. Gemini model id (e.g. "gemini-embedding-001").
//   - input_tokens  : non-negative integer. Estimated input tokens.
//   - output_tokens : non-negative integer. Always 0 for embeddings today;
//                     supplied for future generative-model extensions.
//   - source        : string. The connector source label that triggered the
//                     embed (e.g. "git-log", "imessage", "recall-time").
//
// Side effects:
//   - In-process Map mutation.
//   - When _writesSinceFlush hits FLUSH_EVERY_N, an async flushDaily() fires.
//   - Registers shutdown handlers on first call so graceful exit persists
//     the tail window.
export function recordEmbedCall({ model, input_tokens, output_tokens, source } = {}) {
  if (typeof input_tokens !== "number" || !Number.isFinite(input_tokens) || input_tokens < 0) {
    return;
  }
  const outTokens =
    typeof output_tokens === "number" && Number.isFinite(output_tokens) && output_tokens >= 0
      ? output_tokens
      : 0;

  const key = _counterKey(model, source);
  let entry = _counters.get(key);
  if (!entry) {
    entry = { input_tokens: 0, output_tokens: 0, call_count: 0 };
    _counters.set(key, entry);
  }
  entry.input_tokens += input_tokens;
  entry.output_tokens += outTokens;
  entry.call_count += 1;

  _writesSinceFlush += 1;
  _ensureShutdownHandlers();
  if (_writesSinceFlush >= FLUSH_EVERY_N) {
    flushDaily({ sync: false });
  }
}

// snapshotCounters — read-only deep copy of the current state. Surfaced via
// memory_connectors_list for operator inspection (per-source $/day so post-
// Stage-0 deltas are attributable).
export function snapshotCounters() {
  const out = [];
  for (const [key, entry] of _counters.entries()) {
    const [model, source] = key.split("::");
    const price = _priceForModel(model);
    const estimated_usd =
      (entry.input_tokens / 1000) * price.input_per_1k_usd +
      (entry.output_tokens / 1000) * price.output_per_1k_usd;
    out.push({
      model,
      source,
      input_tokens: entry.input_tokens,
      output_tokens: entry.output_tokens,
      call_count: entry.call_count,
      estimated_usd_today: Number(estimated_usd.toFixed(6)),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function _todaySinkPath() {
  const ts = serverTs();
  // serverTs returns ISO-8601; date portion is the first 10 chars (YYYY-MM-DD).
  const date = ts.slice(0, 10);
  return join(STORAGE_DIR, "telemetry", `embed-cost-${date}.jsonl`);
}

// flushDaily — append the current counter snapshot as a single JSONL row to
// the daily sink and zero out the in-process Map. The row records per-
// (model, source) totals plus the computed USD estimate, so re-aggregating
// across daily files is straightforward.
//
// opts.sync — when true, opens the file synchronously and calls fsyncSync
// before close. Used by shutdown handlers; production hot path uses async
// appendFile semantics. Failures are caught and logged via stderr; we never
// let a flush failure crash the daemon.
export function flushDaily({ sync = false } = {}) {
  if (_counters.size === 0) {
    _writesSinceFlush = 0;
    return;
  }
  const path = _todaySinkPath();
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    /* best-effort */
  }

  const rows = snapshotCounters();
  const ts = serverTs();
  const lines =
    rows
      .map((r) =>
        JSON.stringify({
          ts,
          model: r.model,
          source: r.source,
          input_tokens: r.input_tokens,
          output_tokens: r.output_tokens,
          call_count: r.call_count,
          estimated_usd: r.estimated_usd_today,
        }),
      )
      .join("\n") + "\n";

  try {
    if (sync) {
      const fd = openSync(path, "a", 0o600);
      try {
        writeSync(fd, lines);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } else {
      appendFileSync(path, lines, { mode: 0o600 });
    }
  } catch (err) {
    try {
      process.stderr.write(
        `embed-cost: flush failed to ${path}: ${err && err.message ? err.message : String(err)}\n`,
      );
    } catch {
      /* never let logging fail */
    }
    return;
  }

  // Successful flush — clear in-process state so the next window starts
  // empty. snapshotCounters is the read-only view; flush owns the reset.
  _counters = new Map();
  _writesSinceFlush = 0;
}

// ---------------------------------------------------------------------------
// Shutdown handlers
// ---------------------------------------------------------------------------

function _ensureShutdownHandlers() {
  if (_shutdownHandlersRegistered) return;
  _shutdownHandlersRegistered = true;
  const handler = () => {
    try {
      flushDaily({ sync: true });
    } catch {
      /* never let shutdown crash */
    }
  };
  // beforeExit fires when the event loop drains. We do NOT register exit
  // (synchronous-only) because we want appendFile semantics; the shutdown
  // path uses sync: true above.
  try {
    process.on("beforeExit", handler);
    process.on("SIGTERM", handler);
    process.on("SIGINT", handler);
  } catch {
    /* test environments may forbid signal handlers; non-fatal */
  }
}

// ---------------------------------------------------------------------------
// Higher-order wrappers around gemini-client embed surfaces
// ---------------------------------------------------------------------------

// wrapEmbedSingle — wrap an embedSingle({text, taskType, dims}) function so
// every call increments the cost counter keyed on the source label.
//
// Usage:
//   import { embedSingle } from "../gemini-client.js";
//   import { wrapEmbedSingle } from "../observability/embed-cost.js";
//   const trackedEmbedSingle = wrapEmbedSingle(embedSingle, { source: "git-log" });
//   await trackedEmbedSingle({ text, taskType: "RETRIEVAL_DOCUMENT" });
//
// The wrapper preserves the return value (and any thrown errors) exactly.
// Cost is recorded BEFORE the underlying call returns — token count is
// derivable from the input alone, so we attribute even failed embeddings
// (which still incur a network round-trip and may be billed by Gemini).
//
// opts.source is the source label to attribute. Defaults to "unknown_source".
// opts.model overrides the model id stamped on the counter; defaults to
// "gemini-embedding-001" (matches gemini-client.GEMINI_EMBEDDING_MODEL_VERSION).
export function wrapEmbedSingle(fn, opts = {}) {
  if (typeof fn !== "function") {
    throw new Error("wrapEmbedSingle: fn must be a function");
  }
  const source = typeof opts.source === "string" ? opts.source : "unknown_source";
  const model = typeof opts.model === "string" ? opts.model : "gemini-embedding-001";
  return async function trackedEmbedSingle(args) {
    const text = args && typeof args.text === "string" ? args.text : "";
    const input_tokens = estimateInputTokens(text);
    recordEmbedCall({ model, input_tokens, output_tokens: 0, source });
    return fn(args);
  };
}

// wrapEmbedBatch — wrap an embedBatch({items, taskType}) function. Sum tokens
// across all items; record as a SINGLE recordEmbedCall (the batch is one
// network round-trip).
//
// opts shape matches wrapEmbedSingle.
export function wrapEmbedBatch(fn, opts = {}) {
  if (typeof fn !== "function") {
    throw new Error("wrapEmbedBatch: fn must be a function");
  }
  const source = typeof opts.source === "string" ? opts.source : "unknown_source";
  const model = typeof opts.model === "string" ? opts.model : "gemini-embedding-001";
  return async function trackedEmbedBatch(args) {
    const items = args && Array.isArray(args.items) ? args.items : [];
    const input_tokens = estimateBatchInputTokens(items);
    recordEmbedCall({ model, input_tokens, output_tokens: 0, source });
    return fn(args);
  };
}

// ---------------------------------------------------------------------------
// Test-only seam
// ---------------------------------------------------------------------------

export function resetForTests() {
  _counters = new Map();
  _writesSinceFlush = 0;
  _priceTable = null;
  _missingModelsWarned = new Set();
}
