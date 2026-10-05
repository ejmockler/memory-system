// lib/messaging/feedback-log.js — WORKUNIT M3 (feedback-log), a W1 source module
// for the WHO-MATTERS attention model (companion to M2's contacts-anchor).
//
// MISSION (per TOPOLOGY.md): the catch-up surface (memory_catchup) shows the
// operator a ranked "waiting on you" list. M3 closes the LOOP: every triage the
// operator performs on a surfaced row — opened it, replied, dismissed it, flagged
// it as spam — is an OBSERVATION about who matters. This module is the
// APPEND-ONLY engagement log that captures those actions and the read-side that
// folds them into a feedback_score ∈ [0,1] for the M1 person-enrichment seam.
//
// WHAT THIS FILE IS (two halves, one append + one read, never coupled):
//   (1) recordFeedback({subject_id, action, ts, note?}) — APPENDS one immutable
//       JSONL row to storage/feedback/engagement.jsonl (0600, atomic O_APPEND).
//       NEVER mutates or rewrites history (Thesis #1: append-only log). The
//       subject_id is the OPAQUE person_id (or thread_id) the catch-up surfaced;
//       this module branches on NO platform (0 platform tokens).
//   (2) feedbackScore(subject_id, opts?) — reads the log at QUERY TIME, builds a
//       per-subject aggregate of positive (opened/replied) vs. negative
//       (dismissed/flagged_spam) actions, and returns a MONOTONE score in [0,1]:
//         - NO events for a subject => NEUTRAL (0). A subject the operator has
//           never triaged is NOT penalized — feedback only ever LIFTS in M5's
//           anchorFactor (feedback_score scaled by ANCHOR_FEEDBACK_WEIGHT, a
//           non-negative lift). 0 is the floor, so an unknown / never-triaged /
//           freshly-flagged subject stays at the existing NEW_CONTACT rank.
//           NEVER drops a human (the hard constraint).
//         - positive actions raise the score toward 1; negative actions LOWER it
//           toward the 0 floor (flagged_spam the strongest negative). The score
//           is the read-side signal M5 multiplies UP by; it can never push a row
//           BELOW the neutral floor (a 0 feedback_score is a ×1.0 no-op lift in
//           anchorFactor — structurally a non-drop).
//
// For the buildFeedbackIndex / lookupFeedbackScore COMPOSITION pattern M5/W2
// wires via makeEnricherFromIndex (M1), this module also exports a pure index
// builder over PRE-LOADED rows (buildFeedbackIndex(rows) -> index;
// lookupFeedbackScore(index, subject_id) -> [0,1]) so the rank loop does an O(1)
// cached lookup, never a per-person file read (M1's injection contract).
//
// HARD CONSTRAINTS (brutalist, non-negotiable):
//   - APPEND-ONLY: recordFeedback only ever appends; it never reads-modify-writes
//     the log. Immutable history. (Thesis #1.)
//   - READ-ONLY at rank time: feedbackScore / the index are a query-time
//     projection; no live store coupling, no fs write in the rank loop.
//   - NEUTRAL WHEN EMPTY: missing log / malformed line / no events for a subject
//     => 0 (neutral). Degrades silently; NEVER throws into the rank loop.
//   - MONOTONE / NEVER-DROP: feedback_score ∈ [0,1]; 0 is neutral (a ×1.0 no-op
//     in anchorFactor). flagged_spam LOWERS the score but the FLOOR is 0 — the
//     row is down-weighted relative to a replied-to thread, never hard-dropped.
//   - DEFENSIVE READERS: total over odd input; a non-string subject_id, a bad
//     action, a torn final line — all degrade, never throw.
//   - 0 PLATFORM TOKENS: this module names no platform. subject_id is opaque.
//
// PURE read-side: feedbackScore is deterministic over the same log bytes (same
// log => same score). The only side effect lives in recordFeedback (the append).

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { dirname } from "node:path";

import { feedbackLogPath } from "../config.js";
import { ok, serverTs } from "../envelope.js";
import { ERROR_CODES, ToolError } from "../error-codes.js";

// ---------------------------------------------------------------------------
// FEEDBACK_CAPS — the single frozen source of every weight. Object.freeze
// enforces single-producer discipline: a future tuning pass changes a number
// HERE (DATA), never by branching on an action in a function body.
// ---------------------------------------------------------------------------
export const FEEDBACK_CAPS = Object.freeze({
  // The NEUTRAL score: a never-triaged subject (no events) earns EXACTLY this. It
  // is the floor of feedbackScore — a ×1.0 no-op lift in M5's anchorFactor, so an
  // unknown subject's rank is unchanged (monotone UP-rank only; never a drop).
  FEEDBACK_NEUTRAL: 0,

  // ----- per-action WEIGHTS. Positive (>0) lift the aggregate toward 1; negative
  // (<0) pull it toward the 0 floor. Magnitudes encode the strength of the signal:
  // a reply is the strongest positive (you engaged), flagged_spam the strongest
  // negative (explicit reject). "surfaced" is a 0-weight observation (the row was
  // shown but not yet acted on) — it records exposure without moving the score.
  ACTION_WEIGHTS: Object.freeze({
    surfaced: 0,
    opened: 0.5,
    replied: 1.0,
    dismissed: -0.5,
    flagged_spam: -1.0,
  }),

  // The aggregate (signed sum of action weights) is squashed into [0,1] by a
  // logistic centered at 0 with this steepness. A net-zero history => 0.5 is too
  // HOT a neutral for a never-strongly-engaged subject, so we instead anchor the
  // empty/zero-net case at the NEUTRAL floor (0) and let only NET-POSITIVE
  // engagement lift above it (see scoreFromAggregate). Steepness controls how fast
  // accumulated replies saturate toward 1.
  LOGISTIC_STEEPNESS: 0.6,

  // VALID action vocabulary (the MCP tool's enum + the reader's allowlist). An
  // out-of-vocabulary action is dropped by the reader (defensive) and rejected by
  // recordFeedback (validated write).
  ACTIONS: Object.freeze(["surfaced", "opened", "replied", "dismissed", "flagged_spam"]),
});

const ACTION_SET = new Set(FEEDBACK_CAPS.ACTIONS);

// ---------------------------------------------------------------------------
// fs open-flags (sourced from fs.constants — see damping-log.js header: os.constants
// silently yields undefined and OR-collapses to a plain O_RDONLY).
// ---------------------------------------------------------------------------
const O_WRONLY = fsConstants.O_WRONLY;
const O_APPEND = fsConstants.O_APPEND;
const O_CREAT = fsConstants.O_CREAT;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW;
const APPEND_FLAGS = O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

// ---------------------------------------------------------------------------
// Defensive helpers (total over odd input; never throw).
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// Clamp a number into [0,1]; non-finite => 0 (the conservative neutral floor).
function clamp01(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function nowIso() {
  return new Date().toISOString();
}

// Normalize a caller-supplied ts to an ISO string. Accepts an integer ms epoch or
// an ISO string; anything else => server-stamped now (we never trust a bad ts to
// poison ordering, and the log is append-only so ts is descriptive, not a key).
function normalizeTs(ts) {
  if (typeof ts === "number" && Number.isFinite(ts)) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (isNonEmptyString(ts)) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return nowIso();
}

// ---------------------------------------------------------------------------
// (1) WRITE — recordFeedback: append ONE immutable JSONL row. Never mutates.
// ---------------------------------------------------------------------------

/**
 * recordFeedback({subject_id, action, ts?, note?}, opts?) -> the appended row.
 *
 * APPENDS one JSONL line to the feedback log (storage/feedback/engagement.jsonl,
 * 0600). The write is a single O_APPEND writeSync — POSIX guarantees a small
 * append is atomic w.r.t. concurrent appenders, so two writers never interleave a
 * line. NEVER reads-modify-writes: history is immutable (Thesis #1, append-only).
 *
 * Throws on an invalid shape (a non-string subject_id, or an out-of-vocabulary
 * action) so the MCP tool surfaces INVALID_ARGUMENTS; the READ side is separately
 * defensive over whatever bytes are on disk.
 *
 * `opts.path` overrides the log path (hermetic tests). `opts.now` is unused by the
 * writer (ts is normalized from the caller or stamped) but accepted for symmetry.
 *
 * @returns {{subject_id:string, action:string, ts:string, note?:string}} the row.
 */
export function recordFeedback(entry, opts = {}) {
  const e = isPlainObject(entry) ? entry : {};
  if (!isNonEmptyString(e.subject_id)) {
    throw new Error("feedback-log.recordFeedback: subject_id must be a non-empty string");
  }
  if (!ACTION_SET.has(e.action)) {
    throw new Error(
      `feedback-log.recordFeedback: action must be one of ${FEEDBACK_CAPS.ACTIONS.join(", ")}; got ${JSON.stringify(e.action)}`,
    );
  }

  const row = {
    subject_id: e.subject_id,
    action: e.action,
    ts: normalizeTs(e.ts),
  };
  if (isNonEmptyString(e.note)) {
    // Bound the note so a runaway caller cannot bloat the log line.
    row.note = e.note.length > 512 ? e.note.slice(0, 512) : e.note;
  }

  const path = isNonEmptyString(opts.path) ? opts.path : feedbackLogPath();
  appendOneRow(path, row);
  return row;
}

function appendOneRow(path, row) {
  // Ensure the parent dir exists (idempotent). 0700 — operator-only.
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
  let fd = -1;
  try {
    fd = openSync(path, APPEND_FLAGS, FILE_MODE);
    // O_NOFOLLOW + nlink check: refuse to append through a symlink / hardlink swap.
    const st = fstatSync(fd);
    if (st.nlink !== 1) {
      throw new Error("feedback-log: log file has unexpected nlink (refusing append)");
    }
    const line = JSON.stringify(row) + "\n";
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        // ignore close error — the append already durably landed (fsync above).
      }
    }
  }
}

// ---------------------------------------------------------------------------
// (2) READ — pure projection from the log bytes to a feedback_score in [0,1].
// ---------------------------------------------------------------------------

// Parse the raw log bytes into VALID rows. Defensive: a torn final line, a
// non-JSON line, a row missing subject_id/action, or an out-of-vocabulary action
// is SKIPPED, never thrown. Returns [] for empty / absent input.
function parseRows(raw) {
  if (!isNonEmptyString(raw)) return [];
  const out = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    if (line.length === 0) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // torn / non-JSON line — skip.
    }
    if (!isPlainObject(obj)) continue;
    if (!isNonEmptyString(obj.subject_id)) continue;
    if (!ACTION_SET.has(obj.action)) continue;
    out.push({ subject_id: obj.subject_id, action: obj.action });
  }
  return out;
}

// Read the log file defensively. A missing file => "" (neutral / empty index). A
// read error (permissions, etc.) also degrades to "" — the rank loop must never
// throw on a feedback read.
function readLogBytes(path) {
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * buildFeedbackIndex(rows) -> { aggregates: Map<subject_id, number>, score(...) }.
 *
 * A PURE index over PRE-LOADED rows (the M5/W2 composition pattern: built ONCE at
 * buildCatchup, queried O(1) per person in the rank loop — never a per-person file
 * read). `rows` may be the parsed log rows OR the raw envelope/row array; each row
 * needs only {subject_id, action}. Defensive: malformed rows are ignored.
 *
 * The aggregate per subject is the SIGNED SUM of ACTION_WEIGHTS over that subject's
 * events. lookupFeedbackScore squashes the aggregate into [0,1] (see
 * scoreFromAggregate). Index is deterministic over the same rows.
 */
export function buildFeedbackIndex(rows) {
  const aggregates = new Map();
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (!isPlainObject(r)) continue;
      const sid = r.subject_id;
      const action = r.action;
      if (!isNonEmptyString(sid) || !ACTION_SET.has(action)) continue;
      const w = FEEDBACK_CAPS.ACTION_WEIGHTS[action];
      aggregates.set(sid, (aggregates.get(sid) || 0) + w);
    }
  }
  return { aggregates };
}

/**
 * buildFeedbackIndexFromLog(opts?) -> index. Convenience: read the log file
 * (opts.path override), parse it defensively, and build the index. A missing /
 * malformed log => an empty index (every lookup neutral). This is the entry the
 * M5 wiring calls once per buildCatchup.
 */
export function buildFeedbackIndexFromLog(opts = {}) {
  const path = isNonEmptyString(opts.path) ? opts.path : feedbackLogPath();
  const raw = readLogBytes(path);
  return buildFeedbackIndex(parseRows(raw));
}

// Squash a signed aggregate into [0,1] with the NEUTRAL floor at a net-zero/empty
// history. We anchor the floor at 0 (not the logistic's 0.5) so a never-triaged or
// net-negative subject earns the NEUTRAL no-op lift — feedback only ever LIFTS in
// M5's anchorFactor; it must never push a row below the existing floor.
//
//   - aggregate <= 0  => 0  (NEUTRAL: empty, or net-negative/flagged. The 0 floor
//                            is the non-drop guarantee — a flagged subject is
//                            down-weighted RELATIVE to engaged ones, not dropped.)
//   - aggregate  > 0  => logistic(aggregate) re-based from its 0.5 midpoint up to
//                        1, so a single "opened" (0.5) gives a small lift and
//                        accumulated replies saturate toward 1. Monotone in the
//                        aggregate.
function scoreFromAggregate(aggregate) {
  if (typeof aggregate !== "number" || !Number.isFinite(aggregate)) return 0;
  if (aggregate <= 0) return FEEDBACK_CAPS.FEEDBACK_NEUTRAL; // 0
  const k = FEEDBACK_CAPS.LOGISTIC_STEEPNESS;
  const logistic = 1 / (1 + Math.exp(-k * aggregate)); // (0.5, 1) for aggregate>0
  // Re-base (0.5,1) -> (0,1): map the positive half of the logistic onto the full
  // [0,1] so a net-positive history spans the score range and stays MONOTONE.
  const rebased = (logistic - 0.5) * 2;
  return clamp01(rebased);
}

/**
 * lookupFeedbackScore(index, subject_id) -> a feedback_score in [0,1].
 *
 * The M5/W2 lookup signature consumed by makeEnricherFromIndex(index, lookup): an
 * O(1) read off the precomputed index. NEUTRAL (0) when:
 *   - the index is malformed / missing aggregates,
 *   - subject_id is not a non-empty string,
 *   - the subject has no events (never triaged), or
 *   - the subject's net aggregate is <= 0 (net-negative / flagged).
 * NEVER throws (a defensive lookup the rank loop can trust). Deterministic.
 */
export function lookupFeedbackScore(index, subject_id) {
  if (!isPlainObject(index) || !(index.aggregates instanceof Map)) return 0;
  if (!isNonEmptyString(subject_id)) return 0;
  const aggregate = index.aggregates.get(subject_id);
  if (aggregate === undefined) return 0; // never-triaged => NEUTRAL.
  return scoreFromAggregate(aggregate);
}

/**
 * feedbackScore(subject_id, opts?) -> a feedback_score in [0,1].
 *
 * The convenience single-shot read for the M1 enrichment: reads the log
 * (opts.path override), builds the index, and looks up the subject. Use the
 * index + lookupFeedbackScore pair in the rank loop (O(1) per person); use THIS
 * for a one-off score / the MCP tool's readback / tests.
 *
 * NEUTRAL (0) when the log is absent/empty/malformed or the subject has no
 * net-positive engagement. Defensive: never throws. Deterministic over the log
 * bytes (the M3 read-side purity invariant).
 */
export function feedbackScore(subject_id, opts = {}) {
  const index = buildFeedbackIndexFromLog(opts);
  return lookupFeedbackScore(index, subject_id);
}

// ---------------------------------------------------------------------------
// MCP TOOL — memory_catchup_feedback. The thin wrapper that lets the operator
// RECORD a triage action on a catch-up row (open/reply/dismiss/flag). Mirrors the
// memory_catchup / memory_put TOOL shape (name / description / inputSchema /
// handler). Registered in dispatch.js. The handler APPENDS one immutable row and
// returns the appended row + a record-readback feedback_score for the subject so
// the caller can see the effect (the gate's record_readback=true).
// ---------------------------------------------------------------------------

export const NAME = "memory_catchup_feedback";

/**
 * handler(args) — validate {subject_id, action, note?}, append one engagement row,
 * return ok(NAME, {recorded, feedback_score}). `ts` is server-stamped (the writer
 * normalizes / stamps it; the caller never controls log ordering). Throws
 * ToolError(INVALID_ARGUMENTS) on a bad shape; dispatch converts it to an errEnv.
 */
export async function handler(args) {
  const a = isPlainObject(args) ? args : {};
  if (!isNonEmptyString(a.subject_id)) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "subject_id must be a non-empty string");
  }
  if (!ACTION_SET.has(a.action)) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `action must be one of ${FEEDBACK_CAPS.ACTIONS.join(", ")}`,
    );
  }
  let note = undefined;
  if (a.note !== undefined && a.note !== null) {
    if (typeof a.note !== "string") {
      throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "note must be a string");
    }
    note = a.note;
  }

  let recorded;
  try {
    // ts is server-stamped (the writer normalizes a missing ts to now); the
    // operator never controls append ordering.
    recorded = recordFeedback({ subject_id: a.subject_id, action: a.action, note });
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, e && e.message ? e.message : "failed to record feedback");
  }

  // Record-readback: surface the subject's feedback_score AFTER the append so the
  // operator sees the effect of the action they just recorded.
  const score = feedbackScore(a.subject_id);

  return ok(NAME, {
    recorded,
    subject_id: a.subject_id,
    feedback_score: score,
    generated_at: serverTs(),
  });
}

export const TOOL = {
  name: NAME,
  description:
    "Record a triage action on a memory_catchup row (the who-matters engagement loop). action ∈ {surfaced, opened, replied, dismissed, flagged_spam}; subject_id is the surfaced person_id (or thread_id). Append-only — flag a noisy sender or dismiss a row and the who-matters ranking learns from it over time. Read it back as a feedback_score in [0,1] (replies/opens lift, flag/dismiss lower; a never-triaged subject stays neutral and is never dropped).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["subject_id", "action"],
    properties: {
      subject_id: { type: "string", minLength: 1, maxLength: 512 },
      action: { type: "string", enum: FEEDBACK_CAPS.ACTIONS.slice() },
      note: { type: "string", maxLength: 512 },
    },
  },
  handler,
};
