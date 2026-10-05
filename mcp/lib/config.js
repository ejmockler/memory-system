// Memory-system base-directory configuration. Single source of truth for
// every filesystem path the production code touches.
//
// Tests override via env vars: MEMORY_ROOT (root override) OR per-dir overrides.
// Production code MUST import paths from this module — never hardcode an
// absolute <MEMORY_ROOT>/... path or re-derive the root from the home directory
// anywhere else. Drift here = the path-divergence bug class that bypasses the
// env-override discipline tests rely on for hermetic isolation.
//
// Resolution order:
//   1. Per-dir env var (e.g. POLICY_BASE_DIR)  — wins if set.
//   2. MEMORY_ROOT + conventional suffix       — wins if MEMORY_ROOT is set.
//   3. the checkout that contains mcp/ + suffix — production default. Keyed
//      on this file's own location (import.meta.url), never on cwd or HOME,
//      so a clone at any path (spaces included) is its own data root.
//
// Production runtime is functionally identical to the pre-refactor inline
// constants: when no env vars are set, every helper returns the same string
// it did before. The only observable behaviour change is that tests (and
// hermetic e2e harnesses) can now redirect every disk write/read by pinning
// MEMORY_ROOT before the first import of any consumer module.
//
// Why helpers, not constants, for derived paths: the basename portion (e.g.
// "consumed-nonces.jsonl") is part of the SYMBOL_CONTRACT frozen file
// layout, but the consumer modules used to inline both the prefix and the
// basename. Centralising both keeps the two halves visible side-by-side and
// makes a future rename a one-line change. Caller-supplied parameters
// (chatLedgerPath runtime, policyEventsActivePath YYYY-MM) are passed in so
// this module never has to import the time helper or the runtime registry.

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The checkout that contains mcp/ — two directories above this file.
// fileURLToPath (not URL.pathname) so a percent-encoded path, e.g. one with a
// space, is decoded; resolve() strips the trailing slash. Env-independent:
// CODE assets (venvs, scripts) anchor here even when MEMORY_ROOT redirects
// the DATA root elsewhere.
// Kept as ONE call with no trailing comma: test/no-ledger-readfilesync's
// static resolver reads this expression's shape.
export const CHECKOUT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const DEFAULT_MEMORY_ROOT = CHECKOUT_ROOT;

export const MEMORY_ROOT = process.env.MEMORY_ROOT || DEFAULT_MEMORY_ROOT;

export const POLICY_DIR =
  process.env.POLICY_BASE_DIR || join(MEMORY_ROOT, "policy");

export const STORAGE_DIR =
  process.env.STORAGE_BASE_DIR || join(MEMORY_ROOT, "storage");

export const LEDGERS_DIR =
  process.env.LEDGERS_BASE_DIR || join(MEMORY_ROOT, "ledgers");

export const DAEMONS_DIR =
  process.env.DAEMONS_BASE_DIR || join(MEMORY_ROOT, "daemons");

export const HOOKS_DIR =
  process.env.HOOKS_BASE_DIR || join(MEMORY_ROOT, "hooks");

// ---------------------------------------------------------------------------
// Code-asset helpers. Anchored on CHECKOUT_ROOT (never MEMORY_ROOT): these
// are files that ship with / are installed into the checkout, not data.
// ---------------------------------------------------------------------------

export function sttVenvPythonPath() {
  return join(CHECKOUT_ROOT, ".venv-stt", "bin", "python");
}

export function sttBatchScriptPath() {
  return join(CHECKOUT_ROOT, "scripts", "stt", "stt_batch.py");
}

// ---------------------------------------------------------------------------
// Derived path helpers. Each returns the canonical on-disk path; callers
// MUST NOT re-derive the same path inline.
// ---------------------------------------------------------------------------

export function signingKeyPath() {
  return join(POLICY_DIR, "distillation-signing-key.json");
}

export function consumedNoncesPath() {
  return join(POLICY_DIR, "consumed-nonces.jsonl");
}

export function consumedNoncesLockPath() {
  return join(POLICY_DIR, "consumed-nonces.lock");
}

// R33 close-out: distillationStatePath() removed. It returned
// POLICY_DIR/distillation-state.json — the cursor file for the R32-retired
// conversational-distillation supervisor. R32.1 removed health.js's read of
// that path; the helper had no remaining callers and was a zombie export.
// distillationStateLockPath() stays: daemons/watermark.js still acquires
// POLICY_DIR/distillation-state.lock during its single-writer tickOnce
// successor path (see kb/deprecation-discipline.md). When that consumer is
// migrated to a renamed lock, this helper retires too.
export function distillationStateLockPath() {
  return join(POLICY_DIR, "distillation-state.lock");
}

// Caller passes the YYYY-MM month tag (computed via the writer's local
// timezone, per kb/mcp-surface.md § Privilege levels → Logging). This module
// does not import the time helper so it stays import-cycle-free.
export function policyEventsActivePath(yyyyMm) {
  return join(POLICY_DIR, `policy-events-${yyyyMm}.jsonl`);
}

export function policyEventsLockPath() {
  return join(POLICY_DIR, "policy-events.lock");
}

// runtime defaults to "claude-code" — the only runtime the chat-source bridge
// ships in Phase 1. New runtimes register themselves by passing their tag.
export function chatLedgerPath(runtime) {
  const tag = runtime || "claude-code";
  return join(STORAGE_DIR, "sources", `chat-${tag}.jsonl`);
}

// Round-21 (d) hot-fix: source-ledger path for arbitrary non-chat sources
// (e.g. imessage, screentime, git-log, github-events). Mirrors the inline
// helper in mcp/lib/connectors/index.js so the memory_connectors_revoke tool
// and other callers don't reimplement the path convention.
export function sourceLedgerPath(source) {
  return join(STORAGE_DIR, "sources", `${source}.jsonl`);
}

// R32.1 removed: queuePendingDir / queueInflightDir / queueDoneDir /
// queueFailedDir compat-shim exports. They pointed at
// storage/distillation-queue/{pending,in-flight,done,failed} — the
// conversational-distillation queue retired in R32 (see
// kb/deprecation-discipline.md). The watermark daemon's tickOnce path that
// drained these directories was removed in R32.1; no production consumer
// remains. Historical references live in kb/legacy-archive.md.

export function memoryLedgerPath() {
  return join(LEDGERS_DIR, "memory.jsonl");
}

// R25 gate-zero: append-only audit ledger written by mcp/lib/recall-log.js's
// appendRecallEvent on every memory_recall invocation. Groups with
// memory.jsonl (both are durable, append-only learning substrates) rather
// than storage/ (connector-owned raw). The R19 writer already pins this
// path inline; centralising here so the Phase A integration map has a
// single source of truth.
export function recallLedgerPath() {
  return join(LEDGERS_DIR, "recall.jsonl");
}

// R26 multi-source watermark: per-source cursor state lives in
// storage/watermark-state/<source>.json. Each source has its own atomic
// cursor file (write tmp + rename) so a parse failure on one source does
// not poison another. Schema: { last_offset, last_appended_ts,
// last_event_id, version }.
export function watermarkStateDir() {
  return join(STORAGE_DIR, "watermark-state");
}

export function watermarkSourceCursorPath(source) {
  return join(STORAGE_DIR, "watermark-state", `${source}.json`);
}

// D1 incremental-aggregation: per-aggregator byte-OFFSET checkpoints live in a
// DEDICATED directory (design.md §D-1.1) — structurally uncollidable with any
// current or future connector source cursor under watermark-state/. Names are
// the aggregator grain (`thread`, `project`), NOT connector names. Schema:
// { version, aggregator, last_offset, ino?, ledger_size?, updated_at } written
// atomically by the CKPT primitive (mcp/lib/synthesis/_agg-checkpoint.js).
// STORAGE_DIR honors STORAGE_BASE_DIR, so hermetic tests get an isolated
// checkpoint dir for free.
export function aggregatorStateDir() {
  return join(STORAGE_DIR, "aggregator-state");
}

export function aggregatorCheckpointPath(name) {
  return join(STORAGE_DIR, "aggregator-state", `${name}.json`);
}

export function hookErrorsPath() {
  return join(HOOKS_DIR, "hook-errors.jsonl");
}

// WORKUNIT M3 (feedback-log) — the APPEND-ONLY operator-engagement log for the
// who-matters attention model. memory_catchup surfaces rows; the operator's
// triage actions (surfaced/opened/replied/dismissed/flagged_spam) append here as
// JSONL. lib/messaging/feedback-log.js reads it at query time into a [0,1]
// feedback_score for the M1 person-enrichment seam. Grouped under storage/ (it is
// a derived-from-operator-action engagement substrate, sibling to the
// connector-owned source/ ledgers), each line is immutable; history never
// mutates (Thesis #1). 0600 / operator-only.
export function feedbackLogDir() {
  return join(STORAGE_DIR, "feedback");
}

export function feedbackLogPath() {
  return join(STORAGE_DIR, "feedback", "engagement.jsonl");
}

// Connector state — connectors/<source>/state.json. Phase 2b shared
// abstraction (kb/ingestion.md § Connector contract → CURSOR). Each
// connector daemon (imessage, screentime, git-log-local, github-events,
// chat-codex) owns its own state file at this path. The base helper
// `MEMORY_ROOT + /connectors/<source>` is env-overridable via
// CONNECTORS_BASE_DIR for hermetic tests.
export const CONNECTORS_DIR =
  process.env.CONNECTORS_BASE_DIR || join(MEMORY_ROOT, "connectors");

export function connectorsDir() {
  return CONNECTORS_DIR;
}

export function connectorStatePath(source) {
  return join(CONNECTORS_DIR, source, "state.json");
}

// L3 per-call telemetry: bounded, size-rotated, content-free NDJSON sink
// written by mcp/lib/telemetry.js (one line per executeTool call). Derived
// data, rebuildable from nothing — never a ledger. Env-overridable via
// TELEMETRY_BASE_DIR for hermetic tests, per the standard resolution order.
export const TELEMETRY_DIR =
  process.env.TELEMETRY_BASE_DIR || join(MEMORY_ROOT, "telemetry");

export function telemetryPath() {
  return join(TELEMETRY_DIR, "telemetry.ndjson");
}
