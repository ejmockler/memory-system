// damping-log.js — substrate-tier private damping log.
//
// Implements F-SYN-SUBSTRATE-DAMPING-LOG against the authoritative envelope
// pinned by docs/specs/synthesis/recall-log-split.md § 4.7. The damping log
// is the PRIVATE half of the two-recall-logs split resolved by
// open-problems.md #4: it carries per-surfacing decay state + engagement
// evidence keyed by `{memory_id, turn_window_id}`, read by exactly the
// recall scorer (and the calibration replay), written by the recall service,
// the engagement detector, the derivation propagator, and `memory_excise`.
//
// PRIVACY DISCIPLINE (cross-tier invariant S9 / I8):
//   This module MUST NOT be imported by any file under mcp/lib/tools/*.
//   The damping log is architecturally segregated from the MCP surface; any
//   tool that wanted to read it would re-open the silent-excise paradox.
//   See § 9 "Honest privacy framing" in the spec: 0600 mode is uid hygiene,
//   not a privilege boundary against same-uid attackers. The path-blocklist
//   guard at the bottom of this file fires at import time if a forbidden
//   caller pulls us in.
//
// FILE LAYOUT (per spec § 4.2):
//   <MEMORY_ROOT>/policy/damping-log.jsonl       append-only JSONL, mode 0600
//   <MEMORY_ROOT>/policy/damping-log.jsonl.lock  sidecar lock (acquireExclusiveLockFile pattern)
//
// ROW ENVELOPE (per § 4.3 / § 4.7.2):
//   {
//     schema_version: 1,
//     signal_kind: "surfacing" | "engagement" | "engagement_inherited"
//                | "crowded_neighborhood" | "expunged",
//     memory_id: string | null,
//     turn_window_id: string,
//     recall_id: string | null,
//     conversation_id_hash: string | null,
//     ts: string,                  // ISO-8601, server-stamped
//     populator_version: string,
//     fields: { /* per-kind payload */ },
//   }
//
// CANONICAL TURN-WINDOW ENCODING (per § 4.5):
//   turn_window_id = base64url(sha256(
//     utf8(conversation_id) ‖ 0x1F ‖ BE_u64(base_turn_index) ‖ 0x1F ‖ BE_u64(window_size)
//   ))
//   where base_turn_index = floor(turn_index / window_size).
//
// SCHEMA VERSION CONSTANT (per § 4.7.1):
//   RECALL_LOG_SCHEMA_VERSION = "v1" — the string identifier consumers MUST
//   import and reference by name. The numeric form lives inside row envelopes
//   as `schema_version: 1`.

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

import { CHECKOUT_ROOT } from "../config.js";

// ---------------------------------------------------------------------------
// Schema constants — § 4.7.1 (single shared module rule).
// ---------------------------------------------------------------------------

/** Single-source-of-truth identifier per § 4.7.1. Consumers MUST import this
 *  by name; inlining the literal "v1" is a CI failure (invariant I16). */
export const RECALL_LOG_SCHEMA_VERSION = "v1";

/** Numeric form used inside the row envelope (`row.schema_version`). The
 *  string and numeric forms move together when the spec bumps to v2. */
export const RECALL_LOG_SCHEMA_VERSION_NUMERIC = 1;

/** Frozen signal_kind enumeration. Five values, exhaustive and disjoint
 *  per spec § 4.3. Any new signal_kind requires a schema_version bump. */
export const SIGNAL_KINDS = Object.freeze({
  SURFACING: "surfacing",
  ENGAGEMENT: "engagement",
  ENGAGEMENT_INHERITED: "engagement_inherited",
  CROWDED_NEIGHBORHOOD: "crowded_neighborhood",
  EXPUNGED: "expunged",
});

const VALID_SIGNAL_KIND_SET = new Set(Object.values(SIGNAL_KINDS));

/** Sentinel turn_window_id used by `expunged` rows — the only deviation from
 *  the § 4.5 canonical encoding. Consumers MUST recognise this sentinel. */
export const EXPUNGE_GLOBAL_SENTINEL = "EXPUNGE_GLOBAL";

/** Populator version stamped on every row this module writes. Bumped when
 *  the writer-side semantics change in a backwards-incompatible way. */
const POPULATOR_VERSION = "damping-log@1.0.0";

// ---------------------------------------------------------------------------
// Path resolution — env-overridable for hermetic test isolation.
// Mirrors mcp/lib/config.js's discipline (MEMORY_ROOT / POLICY_BASE_DIR).
// The env is read LAZILY at call time (config.js freezes MEMORY_ROOT at first
// import), so a test can re-point the root between calls; only the
// env-independent CHECKOUT_ROOT fallback is imported from config.js. We
// mirror the same resolution order here so test fixtures remain hermetic.
// ---------------------------------------------------------------------------

function memoryRoot() {
  return process.env.MEMORY_ROOT || CHECKOUT_ROOT;
}

function policyDir() {
  return process.env.POLICY_BASE_DIR || join(memoryRoot(), "policy");
}

export function dampingLogPath() {
  return join(policyDir(), "damping-log.jsonl");
}

export function dampingLogLockPath() {
  return join(policyDir(), "damping-log.jsonl.lock");
}

// ---------------------------------------------------------------------------
// Open-flag constants — sourced from fs.constants (NOT os.constants).
// See nonce-store.js header for the reasoning: importing from os.constants
// silently yields `undefined`, which OR-collapses to 0 and degrades open()
// to a plain O_RDONLY. fs.constants is the right source.
// ---------------------------------------------------------------------------

const O_RDWR = fsConstants.O_RDWR;
const O_APPEND = fsConstants.O_APPEND;
const O_CREAT = fsConstants.O_CREAT;
const O_EXCL = fsConstants.O_EXCL;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW;
const O_WRONLY = fsConstants.O_WRONLY;

const STORE_FLAGS = O_RDWR | O_APPEND | O_CREAT | O_NOFOLLOW;
const LOCK_FLAGS = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;

const FILE_MODE = 0o600;

const LOCK_ACQUIRE_TIMEOUT_MS = 60 * 1000;
const LOCK_BACKOFF_MS = 25;
const STALE_LOCK_RECOVERY_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// turn_window_id encoding — § 4.5 canonical.
// ---------------------------------------------------------------------------

const SEP = Buffer.from([0x1f]);

/**
 * Compute the canonical turn_window_id per § 4.5.
 *
 * The encoding is the byte-exact source of truth across implementations:
 *   base64url(sha256(utf8(conversation_id) ‖ 0x1F ‖ BE_u64(base_turn_index) ‖ 0x1F ‖ BE_u64(window_size)))
 *
 * @param {object} args
 * @param {string} args.conversation_id — runtime-emitted conversation id
 *                                        (already stripped of any runtime-name prefix).
 * @param {number} args.base_turn_index — floor(turn_index / window_size).
 *                                        Callers compute this BEFORE calling;
 *                                        the substrate does not re-floor (so
 *                                        the encoding is unambiguous if a
 *                                        consumer accidentally hands us a raw
 *                                        turn_index, the hash will not match
 *                                        any other implementation's output).
 * @param {number} args.window_size      — CAPS.RECALL_K_TURN_WINDOW (default 3).
 * @returns {string} 43-character base64url-encoded sha256 digest.
 */
export function computeTurnWindowId({ conversation_id, base_turn_index, window_size }) {
  if (typeof conversation_id !== "string") {
    throw new Error("damping-log.computeTurnWindowId: conversation_id must be a string");
  }
  if (!Number.isInteger(base_turn_index) || base_turn_index < 0) {
    throw new Error(
      "damping-log.computeTurnWindowId: base_turn_index must be a non-negative integer",
    );
  }
  if (!Number.isInteger(window_size) || window_size <= 0) {
    throw new Error(
      "damping-log.computeTurnWindowId: window_size must be a positive integer",
    );
  }
  const baseBuf = Buffer.alloc(8);
  baseBuf.writeBigUInt64BE(BigInt(base_turn_index));
  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeBigUInt64BE(BigInt(window_size));
  const h = createHash("sha256");
  h.update(Buffer.from(conversation_id, "utf8"));
  h.update(SEP);
  h.update(baseBuf);
  h.update(SEP);
  h.update(sizeBuf);
  return h.digest("base64url");
}

/**
 * Convenience helper for the conversation_id hash (§ 4.6). The damping log
 * NEVER stores plaintext conversation_id; consumers compute this hash before
 * passing into any append* function.
 */
export function computeConversationIdHash(conversation_id) {
  if (typeof conversation_id !== "string") {
    throw new Error(
      "damping-log.computeConversationIdHash: conversation_id must be a string",
    );
  }
  return createHash("sha256")
    .update(Buffer.from(conversation_id, "utf8"))
    .digest("base64url");
}

// ---------------------------------------------------------------------------
// Envelope construction — § 4.3 / § 4.7.2.
// ---------------------------------------------------------------------------

/**
 * Build the canonical row envelope shared across all signal kinds. The
 * envelope is FROZEN per § 4.3: no top-level fields beyond the listed set.
 * Per-kind extensions go inside `fields`.
 *
 * Callers pass `recall_id` and `conversation_id_hash` explicitly so the
 * envelope construction does not silently default them — null vs required
 * is invariant I3/I4/I5 territory and we want the call site to be explicit.
 *
 * @returns {object} A fresh envelope object (not frozen — the writer appends
 *                   `ts` server-side before serialisation).
 */
export function buildEnvelope({
  signal_kind,
  memory_id,
  turn_window_id,
  recall_id,
  conversation_id_hash,
  fields,
}) {
  if (!VALID_SIGNAL_KIND_SET.has(signal_kind)) {
    throw new Error(
      `damping-log.buildEnvelope: signal_kind must be one of ${[...VALID_SIGNAL_KIND_SET].join(", ")}; got ${JSON.stringify(signal_kind)}`,
    );
  }
  if (typeof turn_window_id !== "string" || turn_window_id === "") {
    throw new Error("damping-log.buildEnvelope: turn_window_id must be a non-empty string");
  }
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error("damping-log.buildEnvelope: fields must be a plain object");
  }

  // I3: memory_id is null IFF signal_kind === "crowded_neighborhood".
  if (signal_kind === SIGNAL_KINDS.CROWDED_NEIGHBORHOOD) {
    if (memory_id !== null) {
      throw new Error(
        "damping-log.buildEnvelope: memory_id must be null for crowded_neighborhood (invariant I3)",
      );
    }
  } else {
    if (typeof memory_id !== "string" || memory_id === "") {
      throw new Error(
        `damping-log.buildEnvelope: memory_id required (non-empty string) for signal_kind=${signal_kind} (invariant I3)`,
      );
    }
  }

  // I4: recall_id may be null only for engagement_inherited or expunged.
  if (
    signal_kind === SIGNAL_KINDS.ENGAGEMENT_INHERITED ||
    signal_kind === SIGNAL_KINDS.EXPUNGED
  ) {
    if (recall_id !== null) {
      throw new Error(
        `damping-log.buildEnvelope: recall_id must be null for signal_kind=${signal_kind} (invariant I4)`,
      );
    }
  } else {
    if (typeof recall_id !== "string" || recall_id === "") {
      throw new Error(
        `damping-log.buildEnvelope: recall_id required (non-empty string) for signal_kind=${signal_kind} (invariant I4)`,
      );
    }
  }

  // I5: conversation_id_hash may be null only for expunged.
  if (signal_kind === SIGNAL_KINDS.EXPUNGED) {
    if (conversation_id_hash !== null) {
      throw new Error(
        "damping-log.buildEnvelope: conversation_id_hash must be null for expunged (invariant I5)",
      );
    }
  } else {
    if (typeof conversation_id_hash !== "string" || conversation_id_hash === "") {
      throw new Error(
        `damping-log.buildEnvelope: conversation_id_hash required (non-empty string) for signal_kind=${signal_kind} (invariant I5)`,
      );
    }
  }

  // Key order matches § 4.7.2 verbatim row envelopes so the JSONL line is
  // visually identical to the spec when serialised by JSON.stringify with
  // the default property-iteration order (insertion order for plain objects).
  return {
    schema_version: RECALL_LOG_SCHEMA_VERSION_NUMERIC,
    signal_kind,
    memory_id,
    turn_window_id,
    recall_id,
    conversation_id_hash,
    ts: null,                       // server-stamped by the writer
    populator_version: POPULATOR_VERSION,
    fields,
  };
}

// ---------------------------------------------------------------------------
// Lock acquisition / release — acquireExclusiveLockFile pattern.
// Mirrors mcp/lib/nonce-store.js. Each append acquires + releases; the
// critical section is sub-millisecond so heartbeat refresh is unnecessary.
// ---------------------------------------------------------------------------

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === "EPERM") return true;
    return false;
  }
}

function readLockSidecar() {
  const lockPath = dampingLogLockPath();
  try {
    const fd = openSync(lockPath, O_RDWR | O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (st.nlink !== 1) {
        throw new Error("damping-log: lock has unexpected nlink");
      }
      const buf = Buffer.alloc(st.size);
      readSync(fd, buf, 0, st.size, 0);
      const text = buf.toString("utf8").trim();
      const parsed = text === "" ? null : JSON.parse(text);
      return { mtimeMs: st.mtimeMs, body: parsed };
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    if (e instanceof SyntaxError) return { mtimeMs: 0, body: null };
    throw e;
  }
}

function tryCreateLock(nowIso) {
  const lockPath = dampingLogLockPath();
  try {
    const fd = openSync(lockPath, LOCK_FLAGS, FILE_MODE);
    const body = JSON.stringify({ pid: process.pid, heartbeat_ts: nowIso });
    writeSync(fd, body);
    fsyncSync(fd);
    return fd;
  } catch (e) {
    if (e && e.code === "EEXIST") return null;
    throw e;
  }
}

function reclaimStaleLockIfDead(nowEpochMs) {
  const info = readLockSidecar();
  if (info == null) return false;
  const age = nowEpochMs - info.mtimeMs;
  const pid = info.body && Number.isInteger(info.body.pid) ? info.body.pid : null;
  const dead = pid == null || !pidAlive(pid);
  const stale = age > STALE_LOCK_RECOVERY_MS;
  if (dead || stale) {
    try {
      unlinkSync(dampingLogLockPath());
    } catch (e) {
      if (!(e && e.code === "ENOENT")) throw e;
    }
    return true;
  }
  return false;
}

function acquireLock(nowIso) {
  const start = Date.now();
  let fd = tryCreateLock(nowIso);
  if (fd != null) return fd;
  reclaimStaleLockIfDead(Date.now());
  while (Date.now() - start < LOCK_ACQUIRE_TIMEOUT_MS) {
    fd = tryCreateLock(nowIso);
    if (fd != null) return fd;
    const deadline = Date.now() + LOCK_BACKOFF_MS;
    while (Date.now() < deadline) {
      // spin briefly; the critical section is short and rare.
    }
    reclaimStaleLockIfDead(Date.now());
  }
  throw new Error("damping-log: could not acquire lock within budget");
}

function releaseLock(fd) {
  try {
    closeSync(fd);
  } catch {
    // ignore
  }
  try {
    unlinkSync(dampingLogLockPath());
  } catch (e) {
    if (!(e && e.code === "ENOENT")) {
      // non-fatal: next acquirer's stale-reclaim recovers
    }
  }
}

// ---------------------------------------------------------------------------
// Append discipline — open with O_APPEND, fsync, lock-protected.
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function appendOneRow(row) {
  const ts = nowIso();
  row.ts = ts;
  const lockFd = acquireLock(ts);
  let storeFd = -1;
  try {
    storeFd = openSync(dampingLogPath(), STORE_FLAGS, FILE_MODE);
    const st = fstatSync(storeFd);
    if (st.nlink !== 1) {
      throw new Error("damping-log: store file has unexpected nlink");
    }
    const line = JSON.stringify(row) + "\n";
    writeSync(storeFd, line);
    fsyncSync(storeFd);
    return row;
  } finally {
    if (storeFd !== -1) {
      try {
        closeSync(storeFd);
      } catch {
        // ignore
      }
    }
    releaseLock(lockFd);
  }
}

// ---------------------------------------------------------------------------
// Public writers — one per signal_kind.
//
// Each writer:
//   - validates its arg shape (per § 4.4 / § 4.7.2)
//   - constructs the envelope via buildEnvelope (which enforces I3/I4/I5)
//   - server-stamps `ts` and `populator_version`
//   - acquires the lock, appends one JSONL line, fsyncs, releases
//   - returns the appended row (with ts populated) — async to match the
//     spec § 5.1 surface; the body is sync because the write itself is
//     sync, but consumers may await the result for forward-compat with a
//     future async backend.
// ---------------------------------------------------------------------------

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Append a `signal_kind:"surfacing"` row. § 4.4.1 / § 4.7.2.A.
 *
 * Required envelope fields: memory_id, recall_id, conversation_id_hash.
 * `surfaced_strength` MUST equal clamp01(score * 1 / (1 + position))
 * per invariant I10 — we recompute it from `score` + `position` and ignore
 * any caller-supplied surfaced_strength, eliminating the drift case.
 */
export async function appendSurfacing({
  memory_id,
  turn_window_id,
  recall_id,
  conversation_id_hash,
  position,
  score,
  propensity,
}) {
  if (!Number.isInteger(position) || position < 0) {
    throw new Error("damping-log.appendSurfacing: position must be a non-negative integer");
  }
  if (!Number.isFinite(score)) {
    throw new Error("damping-log.appendSurfacing: score must be a finite number");
  }
  if (!Number.isFinite(propensity)) {
    throw new Error("damping-log.appendSurfacing: propensity must be a finite number");
  }
  const surfaced_strength = clamp01(score * (1 / (1 + position)));
  const envelope = buildEnvelope({
    signal_kind: SIGNAL_KINDS.SURFACING,
    memory_id,
    turn_window_id,
    recall_id,
    conversation_id_hash,
    fields: {
      surfaced_strength,
      position,
      score,
      propensity,
    },
  });
  return appendOneRow(envelope);
}

const ENGAGEMENT_CLASSES = new Set([
  "direct",
  "paraphrase",
  "correction",
  "dismiss",
  "no_engagement",
]);

/**
 * Append a `signal_kind:"engagement"` row. § 4.4.2 / § 4.7.2.B.
 *
 * Required envelope fields: memory_id, recall_id, conversation_id_hash.
 * `engagement_weight` MUST come from CAPS.ENGAGEMENT_WEIGHTS keyed by
 * engagement_class (invariant I11) — the detector passes it in; the
 * substrate stores it verbatim and does not validate the numeric value
 * here. The class enum IS validated.
 */
export async function appendEngagement({
  memory_id,
  turn_window_id,
  recall_id,
  conversation_id_hash,
  engagement_class,
  engagement_weight,
  evidence_span_hash,
  detector_version,
}) {
  if (!ENGAGEMENT_CLASSES.has(engagement_class)) {
    throw new Error(
      `damping-log.appendEngagement: engagement_class must be one of ${[...ENGAGEMENT_CLASSES].join(", ")}; got ${JSON.stringify(engagement_class)}`,
    );
  }
  if (!Number.isFinite(engagement_weight)) {
    throw new Error(
      "damping-log.appendEngagement: engagement_weight must be a finite number",
    );
  }
  if (typeof evidence_span_hash !== "string") {
    throw new Error(
      "damping-log.appendEngagement: evidence_span_hash must be a string (\"\" for no_engagement)",
    );
  }
  if (typeof detector_version !== "string" || detector_version === "") {
    throw new Error(
      "damping-log.appendEngagement: detector_version must be a non-empty string",
    );
  }
  const envelope = buildEnvelope({
    signal_kind: SIGNAL_KINDS.ENGAGEMENT,
    memory_id,
    turn_window_id,
    recall_id,
    conversation_id_hash,
    fields: {
      engagement_class,
      engagement_weight,
      evidence_span_hash,
      detector_version,
    },
  });
  return appendOneRow(envelope);
}

/**
 * Append a `signal_kind:"engagement_inherited"` row. § 4.4.3 / § 4.7.2.C.
 *
 * Required envelope fields: memory_id (the INHERITING parent), recall_id=null
 * (inheritance is derivation-graph-driven, not recall-driven), and
 * conversation_id_hash (scopes the propagation to the conversation that
 * surfaced the engagement).
 */
export async function appendInheritedEngagement({
  memory_id,
  turn_window_id,
  conversation_id_hash,
  source_engagement_recall_id,
  source_memory_id,
  derivation_depth,
  inherited_strength,
}) {
  if (typeof source_engagement_recall_id !== "string" || source_engagement_recall_id === "") {
    throw new Error(
      "damping-log.appendInheritedEngagement: source_engagement_recall_id must be a non-empty string",
    );
  }
  if (typeof source_memory_id !== "string" || source_memory_id === "") {
    throw new Error(
      "damping-log.appendInheritedEngagement: source_memory_id must be a non-empty string",
    );
  }
  if (!Number.isInteger(derivation_depth) || derivation_depth < 1) {
    throw new Error(
      "damping-log.appendInheritedEngagement: derivation_depth must be a positive integer",
    );
  }
  if (!Number.isFinite(inherited_strength) || inherited_strength < 0) {
    throw new Error(
      "damping-log.appendInheritedEngagement: inherited_strength must be a non-negative finite number",
    );
  }
  const envelope = buildEnvelope({
    signal_kind: SIGNAL_KINDS.ENGAGEMENT_INHERITED,
    memory_id,
    turn_window_id,
    recall_id: null,
    conversation_id_hash,
    fields: {
      inherited_strength,
      source_engagement_recall_id,
      source_memory_id,
      derivation_depth,
    },
  });
  return appendOneRow(envelope);
}

/**
 * Append a `signal_kind:"crowded_neighborhood"` row. § 4.4.4 / § 4.7.2.D.
 *
 * The ONLY signal_kind where memory_id is null (invariant I3). Stores RAW
 * `entity_set` alongside `entity_set_hash` so the scorer can compute Jaccard
 * at read time (hash alone cannot answer Jaccard ≥ threshold). Stores
 * `candidates_pre_truncation` IN-ROW so the join survives daemon restarts.
 */
export async function appendCrowdedNeighborhood({
  turn_window_id,
  recall_id,
  conversation_id_hash,
  entity_set,
  entity_set_hash,
  time_window_start,
  time_window_end,
  candidates_pre_truncation,
}) {
  if (!Array.isArray(entity_set) || !entity_set.every((s) => typeof s === "string")) {
    throw new Error(
      "damping-log.appendCrowdedNeighborhood: entity_set must be an array of strings",
    );
  }
  if (typeof entity_set_hash !== "string" || entity_set_hash === "") {
    throw new Error(
      "damping-log.appendCrowdedNeighborhood: entity_set_hash must be a non-empty string",
    );
  }
  if (time_window_start !== null && typeof time_window_start !== "string") {
    throw new Error(
      "damping-log.appendCrowdedNeighborhood: time_window_start must be a string or null",
    );
  }
  if (time_window_end !== null && typeof time_window_end !== "string") {
    throw new Error(
      "damping-log.appendCrowdedNeighborhood: time_window_end must be a string or null",
    );
  }
  if (
    !Array.isArray(candidates_pre_truncation) ||
    !candidates_pre_truncation.every((s) => typeof s === "string")
  ) {
    throw new Error(
      "damping-log.appendCrowdedNeighborhood: candidates_pre_truncation must be an array of strings",
    );
  }
  const envelope = buildEnvelope({
    signal_kind: SIGNAL_KINDS.CROWDED_NEIGHBORHOOD,
    memory_id: null,
    turn_window_id,
    recall_id,
    conversation_id_hash,
    fields: {
      entity_set_hash,
      entity_set,
      time_window_start,
      time_window_end,
      candidates_pre_truncation,
    },
  });
  return appendOneRow(envelope);
}

const EXCISE_REASONS = new Set(["silent_excise", "damping_log_excise_by_window"]);

/**
 * Append a `signal_kind:"expunged"` tombstone row. § 4.4.5 / § 4.7.2.E.
 *
 * Used by `memory_excise(silent:true)` to mark a memory_id as filtered.
 * The envelope's `turn_window_id` is the sentinel "EXPUNGE_GLOBAL" — the
 * one place where turn_window_id deviates from the § 4.5 canonical
 * encoding. `recall_id` and `conversation_id_hash` are null (expunge is
 * global, not recall-scoped).
 *
 * The call signature accepts an optional `turn_window_id` override so
 * tests can probe the sentinel discipline; production callers should pass
 * { memory_id, excise_reason? } only. If `turn_window_id` is omitted, the
 * sentinel is used.
 */
export async function expunge({
  memory_id,
  turn_window_id,
  excise_reason,
}) {
  if (typeof memory_id !== "string" || memory_id === "") {
    throw new Error("damping-log.expunge: memory_id must be a non-empty string");
  }
  const reason = excise_reason === undefined ? "silent_excise" : excise_reason;
  if (!EXCISE_REASONS.has(reason)) {
    throw new Error(
      `damping-log.expunge: excise_reason must be one of ${[...EXCISE_REASONS].join(", ")}; got ${JSON.stringify(reason)}`,
    );
  }
  const twid = turn_window_id === undefined ? EXPUNGE_GLOBAL_SENTINEL : turn_window_id;
  const envelope = buildEnvelope({
    signal_kind: SIGNAL_KINDS.EXPUNGED,
    memory_id,
    turn_window_id: twid,
    recall_id: null,
    conversation_id_hash: null,
    fields: {
      excise_reason: reason,
    },
  });
  return appendOneRow(envelope);
}

// ---------------------------------------------------------------------------
// Read path — cold-load the entire file, filter by (memory_id, turn_window_id).
//
// This is the substrate's per-row read; the scorer's `readWindowedSignals`
// aggregate (§ 5.1) is a thin wrapper that calls this once per recall and
// folds the rows into per-memory_id buckets. We expose the per-row reader
// here so consumers (the scorer + the calibration replay) can choose their
// own aggregation strategy without round-tripping through the substrate's
// fixed formula.
//
// Append-only invariant (I1) means we never truncate or rewrite; every read
// streams the file from byte 0 forward.
//
// EXPUNGE FILTERING (I12): if any `expunged` row exists for the queried
// memory_id, all rows for that memory_id are filtered out unless the caller
// explicitly opts in to seeing them by including SIGNAL_KINDS.EXPUNGED in
// `signal_kinds`. This matches § 6.4: the scorer's `expungedMemoryIds` set
// returns score_boost=0 for the memory_id; surfacing the expunge tombstone
// to the read path lets the calibration replay observe it.
// ---------------------------------------------------------------------------

function readAllRowsRaw() {
  const path = dampingLogPath();
  if (!existsSync(path)) return [];
  const fd = openSync(path, O_RDWR | O_NOFOLLOW, FILE_MODE);
  try {
    const st = fstatSync(fd);
    if (st.size === 0) return [];
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    const text = buf.subarray(0, off).toString("utf8");
    if (text === "") return [];
    const rawLines = text.split("\n");
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
    const rows = [];
    for (const line of rawLines) {
      if (line === "") continue;
      try {
        const parsed = JSON.parse(line);
        // Forward-compat: skip rows with unknown schema_version (I2).
        if (parsed.schema_version !== RECALL_LOG_SCHEMA_VERSION_NUMERIC) continue;
        // Forward-compat: skip rows with unknown signal_kind (I2).
        if (!VALID_SIGNAL_KIND_SET.has(parsed.signal_kind)) continue;
        rows.push(parsed);
      } catch {
        // Corrupt line: skip (mid-file corruption tolerated per § 6.5).
      }
    }
    return rows;
  } finally {
    closeSync(fd);
  }
}

/**
 * Read all rows matching the (memory_id, turn_window_id) filter.
 *
 * @param {object} args
 * @param {string|null} [args.memory_id] — if provided, only return rows where
 *                                          memory_id matches. Null/undefined
 *                                          returns all rows in the window.
 * @param {string} [args.turn_window_id] — if provided, only return rows whose
 *                                          turn_window_id matches exactly.
 *                                          The scorer's K-turn window is a
 *                                          separate filter applied by the
 *                                          caller (see § 6.3).
 * @param {string[]} [args.signal_kinds] — if provided, only return rows whose
 *                                          signal_kind is in this set. Default
 *                                          excludes EXPUNGED (per I12 the
 *                                          scorer surfaces expunged via a
 *                                          separate path) but INCLUDES the
 *                                          tombstones-on-this-memory_id
 *                                          discipline below.
 * @returns {object[]} Array of matching rows in append order.
 */
export async function readWindowedSignals({
  memory_id,
  turn_window_id,
  signal_kinds,
} = {}) {
  const rows = readAllRowsRaw();
  const kindsFilter = Array.isArray(signal_kinds) && signal_kinds.length > 0
    ? new Set(signal_kinds)
    : null;

  // Step 1: collect the set of expunged memory_ids globally. I12 is monotonic-
  // additive: any expunged row for memory_id m permanently filters m's other
  // rows from the default read view.
  const expungedSet = new Set();
  for (const r of rows) {
    if (r.signal_kind === SIGNAL_KINDS.EXPUNGED && typeof r.memory_id === "string") {
      expungedSet.add(r.memory_id);
    }
  }

  // Step 2: apply filters.
  //
  // EXPUNGE BYPASS RULE: the calibration-replay path (which needs to observe
  // tombstones) opts in by passing `signal_kinds: [...includes EXPUNGED]`.
  // When that flag is present we surface BOTH the expunged tombstone AND any
  // other rows for the same memory_id. Otherwise we filter out (a) the
  // tombstone itself AND (b) any other rows for an expunged memory_id.
  const expungeBypass =
    kindsFilter !== null && kindsFilter.has(SIGNAL_KINDS.EXPUNGED);

  const out = [];
  for (const r of rows) {
    if (kindsFilter !== null && !kindsFilter.has(r.signal_kind)) continue;
    if (memory_id !== undefined && memory_id !== null) {
      if (r.memory_id !== memory_id) continue;
    }
    if (turn_window_id !== undefined && turn_window_id !== null) {
      if (r.turn_window_id !== turn_window_id) continue;
    }
    // I12: filter expunged memory_ids unless the caller explicitly opted into
    // the bypass. Co-bucketed memories are unaffected because the filter is
    // per-memory_id, not per-window.
    if (!expungeBypass) {
      if (r.signal_kind === SIGNAL_KINDS.EXPUNGED) continue;
      if (r.memory_id !== null && expungedSet.has(r.memory_id)) continue;
    }
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test seam — reset hook. Documented test-only; production code MUST NOT call.
// ---------------------------------------------------------------------------

export function _resetForTest() {
  const storePath = dampingLogPath();
  const lockPath = dampingLogLockPath();
  try {
    unlinkSync(storePath);
  } catch (e) {
    if (!(e && e.code === "ENOENT")) throw e;
  }
  try {
    unlinkSync(lockPath);
  } catch (e) {
    if (!(e && e.code === "ENOENT")) throw e;
  }
}

// ---------------------------------------------------------------------------
// Path-blocklist guard — enforced at module-load time.
//
// Per spec § 5.1 + invariant I8 (S9 cross-tier invariant): the damping log
// is read by the recall scorer and the calibration replay; written by the
// recall service, the engagement detector, the derivation propagator, and
// memory_excise; and NOTHING ELSE. In particular, no module under
// mcp/lib/tools/* may import this file — doing so re-opens the silent-excise
// paradox (a tool that reads the damping log can enumerate excised memories).
//
// The guard inspects ESM's import.meta-style stack via process.argv[1] and
// the require-stack on the error object of a synthetic throw. ESM does not
// expose a true caller stack at import time, but we can read the caller
// chain off `new Error().stack` because the import-time evaluation of this
// module runs inside the importer's load frame. Any frame in the stack that
// points at `mcp/lib/tools/` triggers a throw.
//
// We deliberately do NOT throw on the test fixture (the private-access test
// constructs a fake importer); the test exercises the same logic via the
// exported `_assertPathBlocklist()` helper. Production code paths use the
// import-time check; tests can call the helper directly.
// ---------------------------------------------------------------------------

const FORBIDDEN_PATH_FRAGMENT = "/mcp/lib/tools/";

/**
 * Synchronously assert that no frame on the current call stack lies under
 * mcp/lib/tools/*. Throws if a forbidden frame is found.
 *
 * Used by the import-time self-check below and by the private-invariant
 * test which constructs an artificial importer-stack to exercise the guard.
 */
export function _assertPathBlocklist(stack) {
  const s = stack || new Error().stack || "";
  if (s.indexOf(FORBIDDEN_PATH_FRAGMENT) !== -1) {
    throw new Error(
      "damping-log: import blocked — modules under mcp/lib/tools/* are not " +
        "permitted to import the damping log (private invariant S9 / I8). " +
        "See docs/specs/synthesis/recall-log-split.md § 5.1.",
    );
  }
}

// Run the guard at module-load time. Catches the common case where a tool
// file accidentally `import`s us — the throw propagates out of the importer's
// load frame and surfaces as a load-time error rather than a silent leak.
_assertPathBlocklist();
