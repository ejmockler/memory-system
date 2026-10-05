// engagement-detector.js — integration-tier helper for W9
// F-SYN-INTEGRATION-ENGAGEMENT-DETECTOR-WIRING.
//
// PURPOSE:
//   Classify a single user turn against the surfaced brief from the prior
//   recall and emit one engagement signal per surfaced memory. The signals
//   are then handed to `damping-log.appendEngagement` by the caller (the
//   watermark daemon's idle tick, NOT the hook itself).
//
// HOOKS-NEVER-BLOCK DISCIPLINE (kb/agent-integration.md, architect review):
//   Semantic classification runs in the daemon, NOT in the runtime path. The
//   UserPromptSubmit hook collects raw signal (current_turn text +
//   prior_recall context) and fire-and-forgets a queue line — it does NOT
//   invoke this detector. The daemon's idle tick (or any out-of-band poller)
//   reads the queue, invokes `detectEngagement`, and calls
//   `damping-log.appendEngagement`.
//
// V0 SCOPE (keyword heuristic; spec § 6.7):
//   - direct       — ≥ CAPS.ENGAGEMENT_DIRECT_MIN_TOKENS contiguous-word
//                    run-length match between user turn and memory.content
//                    (case-insensitive, token-bag over word characters).
//   - paraphrase   — fuzzy similarity heuristic: high single-word overlap
//                    fraction over the memory content without a direct
//                    multi-token run match. v0 is keyword-bag — v1 swaps to
//                    Gemini embedding cosine ≥ CAPS.ENGAGEMENT_FUZZY_THRESHOLD.
//   - correction   — negation token ("no", "wrong", "actually", "but",
//                    "incorrect") in proximity to a memory token.
//   - dismiss      — explicit dismissal pattern ("stop bringing", "not
//                    relevant", "forget that", "irrelevant").
//   - no_engagement — none of the above fired for this memory in this turn.
//
// V1+ ROADMAP (out of scope):
//   - Swap the keyword bag for a small LM classifier
//   - Add Gemini-embedding paraphrase detection at the spec's 0.75 cosine
//   - Add a single-judge fallback for ambiguous cases
//
// EMISSION CONTRACT (spec § 6.6):
//   For every memory in `prior_recall_brief.surfaced`, emit EXACTLY ONE
//   result row (including `no_engagement` when nothing fired). The absence
//   of an engagement signal in the next user turn is itself a signal — the
//   scorer's `decay(turns_since)` formula handles the "absence" case
//   automatically.
//
// SHAPE:
//   detectEngagement({current_turn_text, prior_recall_brief}) returns
//     Array<{ memory_id, signal_kind, engagement_class, engagement_weight,
//             strength, confidence, evidence_span, evidence_span_hash }>
//
// FIELDS NOTE:
//   `signal_kind` is the substrate row signal kind ("engagement"). The 5-class
//   taxonomy is in `engagement_class`. `strength` and `confidence` are
//   integration-tier convenience fields (per the WU prompt's signature) — the
//   substrate row stores only engagement_class / engagement_weight /
//   evidence_span_hash / detector_version.

import { createHash } from "node:crypto";
import { CAPS } from "../validation.js";

export const ENGAGEMENT_DETECTOR_VERSION = "engagement-detector@1.0.0";

// Disjoint 5-class taxonomy; spec § 6.7 (FIXED).
export const ENGAGEMENT_CLASSES = Object.freeze({
  DIRECT: "direct",
  PARAPHRASE: "paraphrase",
  CORRECTION: "correction",
  DISMISS: "dismiss",
  NO_ENGAGEMENT: "no_engagement",
});

// Lowercase-only word-character tokenisation. Hyphens and apostrophes are
// kept because hyphenated identifiers ("acme-raven") and contractions
// ("isn't") carry signal. Everything else falls to whitespace.
function tokenize(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const lower = text.toLowerCase();
  // Match runs of [a-z0-9_'-]+. Note: keeping ' and - intra-token preserves
  // contractions and hyphenated tokens; punctuation is stripped on the edges.
  const tokens = [];
  const re = /[a-z0-9_'-]+/g;
  let m;
  while ((m = re.exec(lower)) !== null) {
    const t = m[0].replace(/^[-']+|[-']+$/g, "");
    if (t.length > 0) tokens.push(t);
  }
  return tokens;
}

// Longest contiguous run-length between two token arrays. v0 direct-match
// substrate: ≥ CAPS.ENGAGEMENT_DIRECT_MIN_TOKENS contiguous tokens match.
function longestContiguousRun(userTokens, memoryTokens) {
  if (userTokens.length === 0 || memoryTokens.length === 0) {
    return { runLength: 0, startIdxInUser: -1 };
  }
  // Simple O(n*m) sliding-window. Token arrays are small (turn ≤ a few
  // hundred tokens; memory excerpt ≤ ~120 tokens at 600 chars).
  let best = 0;
  let bestStart = -1;
  for (let i = 0; i < userTokens.length; i++) {
    for (let j = 0; j < memoryTokens.length; j++) {
      let k = 0;
      while (
        i + k < userTokens.length &&
        j + k < memoryTokens.length &&
        userTokens[i + k] === memoryTokens[j + k]
      ) {
        k++;
      }
      if (k > best) {
        best = k;
        bestStart = i;
      }
    }
  }
  return { runLength: best, startIdxInUser: bestStart };
}

// Bag-of-words fraction: how many *distinct* memory tokens appear anywhere
// in the user turn. v0 paraphrase substrate; v1 swaps to embedding cosine.
function bagOverlapFraction(userTokens, memoryTokens) {
  if (memoryTokens.length === 0) return 0;
  const memSet = new Set(memoryTokens);
  if (memSet.size === 0) return 0;
  const userSet = new Set(userTokens);
  let hits = 0;
  for (const t of memSet) {
    if (userSet.has(t)) hits++;
  }
  return hits / memSet.size;
}

const NEGATION_TOKENS = new Set([
  "no",
  "not",
  "wrong",
  "actually",
  "but",
  "incorrect",
  "nope",
  "false",
]);

// Correction detector: a negation token within NEGATION_PROXIMITY tokens
// of any memory token in the user turn. Proximity is a small window because
// "no, actually it was X" — the negation precedes the corrective content.
const NEGATION_PROXIMITY = 6;

function detectCorrection(userTokens, memoryTokens) {
  if (userTokens.length === 0 || memoryTokens.length === 0) return null;
  const memSet = new Set(memoryTokens);
  for (let i = 0; i < userTokens.length; i++) {
    if (!NEGATION_TOKENS.has(userTokens[i])) continue;
    const lo = Math.max(0, i - NEGATION_PROXIMITY);
    const hi = Math.min(userTokens.length, i + NEGATION_PROXIMITY + 1);
    for (let j = lo; j < hi; j++) {
      if (j === i) continue;
      if (memSet.has(userTokens[j])) {
        return { startIdx: i, hitIdx: j, hitToken: userTokens[j] };
      }
    }
  }
  return null;
}

// Dismissal pattern matching. v0 uses inline regex; CAPS.DISMISS_PATTERNS
// is the configurable list per spec § 7 — exposed here as a constant so the
// caps block stays plain JSON (no regex objects in CAPS).
const DISMISS_PATTERNS = [
  /\bstop\s+bringing\b/i,
  /\bnot\s+relevant\b/i,
  /\birrelevant\b/i,
  /\bforget\s+(that|it)\b/i,
  /\bdrop\s+(it|that)\b/i,
  /\bdon't\s+(care|mention)\b/i,
];

function detectDismiss(text, memoryTokens) {
  if (typeof text !== "string" || text.length === 0) return null;
  if (memoryTokens.length === 0) return null;
  // A dismiss only counts if it ALSO references the memory — otherwise it is
  // an unrelated dismissal of a different topic. Spec § 6.7 trigger:
  // "matches a dismiss pattern referencing the memory".
  const memSet = new Set(memoryTokens);
  const userTokens = tokenize(text);
  let hasMemoryReference = false;
  for (const t of userTokens) {
    if (memSet.has(t)) {
      hasMemoryReference = true;
      break;
    }
  }
  if (!hasMemoryReference) return null;
  for (const rx of DISMISS_PATTERNS) {
    const m = rx.exec(text);
    if (m) {
      return { matchedText: m[0] };
    }
  }
  return null;
}

function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Classify a single user turn against the prior surfaced brief.
 *
 * @param {object} args
 * @param {string} args.current_turn_text - the just-submitted user turn
 * @param {object} args.prior_recall_brief - {recall_id, surfaced:[{memory_id, content}]}
 * @returns {Array<{memory_id, signal_kind, engagement_class, engagement_weight, strength, confidence, evidence_span, evidence_span_hash}>}
 */
export function detectEngagement({ current_turn_text, prior_recall_brief } = {}) {
  // Defensive: empty / malformed inputs return no signals (caller-side: a
  // no-op queue line; no damping rows written).
  if (typeof current_turn_text !== "string") return [];
  const turn = current_turn_text;
  const trimmed = turn.trim();
  if (trimmed.length === 0) return [];
  if (prior_recall_brief == null || typeof prior_recall_brief !== "object") return [];
  const surfaced = Array.isArray(prior_recall_brief.surfaced)
    ? prior_recall_brief.surfaced
    : [];
  if (surfaced.length === 0) return [];

  const userTokens = tokenize(turn);
  const minDirectTokens = Number.isInteger(CAPS.ENGAGEMENT_DIRECT_MIN_TOKENS)
    ? CAPS.ENGAGEMENT_DIRECT_MIN_TOKENS
    : 3;
  const fuzzyThreshold = Number.isFinite(CAPS.ENGAGEMENT_FUZZY_THRESHOLD)
    ? CAPS.ENGAGEMENT_FUZZY_THRESHOLD
    : 0.75;
  const weights = CAPS.ENGAGEMENT_WEIGHTS || {
    direct: 1.0,
    paraphrase: 0.6,
    correction: 0.4,
    dismiss: -0.5,
    no_engagement: 0.0,
  };

  const out = [];
  for (const item of surfaced) {
    if (item == null || typeof item !== "object") continue;
    const memoryId = typeof item.memory_id === "string" ? item.memory_id : null;
    if (memoryId == null || memoryId === "") continue;
    const content = typeof item.content === "string" ? item.content : "";
    const memoryTokens = tokenize(content);

    // Classify in priority order. Each pass is independent so a memory can
    // match exactly one class per turn — the first that fires wins.
    let cls = ENGAGEMENT_CLASSES.NO_ENGAGEMENT;
    let evidenceSpan = "";
    let strength = 0.0;
    let confidence = 1.0;

    // 1. dismiss — explicit pattern + memory reference.
    const dismissHit = detectDismiss(turn, memoryTokens);
    if (dismissHit) {
      cls = ENGAGEMENT_CLASSES.DISMISS;
      evidenceSpan = dismissHit.matchedText;
      strength = Math.abs(weights[ENGAGEMENT_CLASSES.DISMISS] || 0);
      confidence = 0.8;
    }

    // 2. correction — negation in proximity to memory token.
    if (cls === ENGAGEMENT_CLASSES.NO_ENGAGEMENT) {
      const corrHit = detectCorrection(userTokens, memoryTokens);
      if (corrHit) {
        cls = ENGAGEMENT_CLASSES.CORRECTION;
        evidenceSpan = `${userTokens.slice(
          Math.max(0, corrHit.startIdx),
          Math.min(userTokens.length, corrHit.hitIdx + 1),
        ).join(" ")}`;
        strength = Math.abs(weights[ENGAGEMENT_CLASSES.CORRECTION] || 0);
        confidence = 0.7;
      }
    }

    // 3. direct — ≥ minDirectTokens contiguous-token run.
    if (cls === ENGAGEMENT_CLASSES.NO_ENGAGEMENT && memoryTokens.length > 0) {
      const run = longestContiguousRun(userTokens, memoryTokens);
      if (run.runLength >= minDirectTokens) {
        cls = ENGAGEMENT_CLASSES.DIRECT;
        evidenceSpan = userTokens
          .slice(run.startIdxInUser, run.startIdxInUser + run.runLength)
          .join(" ");
        strength = weights[ENGAGEMENT_CLASSES.DIRECT] || 1.0;
        confidence = 1.0;
      }
    }

    // 4. paraphrase — bag-overlap ≥ fuzzyThreshold AND not direct.
    if (cls === ENGAGEMENT_CLASSES.NO_ENGAGEMENT && memoryTokens.length > 0) {
      const overlap = bagOverlapFraction(userTokens, memoryTokens);
      if (overlap >= fuzzyThreshold) {
        cls = ENGAGEMENT_CLASSES.PARAPHRASE;
        // Pick a representative span: the longest run available (even if it
        // didn't pass the direct threshold).
        const run = longestContiguousRun(userTokens, memoryTokens);
        evidenceSpan =
          run.runLength > 0
            ? userTokens
                .slice(run.startIdxInUser, run.startIdxInUser + run.runLength)
                .join(" ")
            : "";
        strength = weights[ENGAGEMENT_CLASSES.PARAPHRASE] || 0.6;
        // Confidence scales with overlap above threshold.
        confidence = Math.min(1.0, 0.5 + (overlap - fuzzyThreshold) * 2);
      }
    }

    const weight = weights[cls];
    out.push({
      memory_id: memoryId,
      signal_kind: "engagement",
      engagement_class: cls,
      engagement_weight: typeof weight === "number" ? weight : 0.0,
      strength,
      confidence,
      evidence_span: evidenceSpan,
      evidence_span_hash:
        evidenceSpan === "" ? "" : sha256Hex(evidenceSpan.toLowerCase()),
      detector_version: ENGAGEMENT_DETECTOR_VERSION,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Queue surface — the watermark daemon's idle tick consumes this.
//
// The hook side (recall-engagement-detect.sh) appends ONE line per assistant
// turn boundary; the daemon reads + truncates the queue under flock, calls
// detectEngagement, and forwards each result to damping-log.appendEngagement.
//
// Queue line shape:
//   {
//     ts: <ISO-8601>,
//     conversation_id: <string>,
//     turn_index: <integer>,           // index of the just-submitted user turn
//     prior_recall_id: <string | null>,
//     prior_recall_brief: {
//       recall_id, surfaced: [{memory_id, content}]
//     },
//     current_turn_text: <string>
//   }
//
// The exported helpers below are the integration seam consumed by the daemon
// and exercised by the hook tests. They DO NOT call into damping-log.js
// themselves — the daemon owns that wiring so this module remains side-
// effect-free (pure detection + queue I/O).
// ---------------------------------------------------------------------------

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { CHECKOUT_ROOT } from "../config.js";

// Lazy on purpose: MEMORY_ROOT is read at call time (tests set it after
// import); the default is the checkout this module lives in.
function memoryRootForQueue() {
  return process.env.MEMORY_ROOT || CHECKOUT_ROOT;
}
function policyDirForQueue() {
  return process.env.POLICY_BASE_DIR || join(memoryRootForQueue(), "policy");
}
export function engagementQueuePath() {
  return join(policyDirForQueue(), "engagement-queue.jsonl");
}

const QUEUE_O_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_NOFOLLOW;
const QUEUE_FILE_MODE = 0o600;

/**
 * Append one queue line. Fire-and-forget per HOOKS-NEVER-BLOCK; the caller
 * (the hook node block) MUST swallow exceptions and return immediately.
 *
 * Hermetic on MEMORY_ROOT / POLICY_BASE_DIR — see config.js discipline.
 */
export function enqueueEngagementSignal(signal) {
  if (signal == null || typeof signal !== "object") {
    throw new TypeError("enqueueEngagementSignal: signal must be an object");
  }
  const dir = policyDirForQueue();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const line = JSON.stringify({
    ts: typeof signal.ts === "string" ? signal.ts : new Date().toISOString(),
    conversation_id:
      typeof signal.conversation_id === "string" ? signal.conversation_id : null,
    turn_index: Number.isInteger(signal.turn_index) ? signal.turn_index : null,
    prior_recall_id:
      typeof signal.prior_recall_id === "string" ? signal.prior_recall_id : null,
    prior_recall_brief:
      signal.prior_recall_brief && typeof signal.prior_recall_brief === "object"
        ? signal.prior_recall_brief
        : null,
    current_turn_text:
      typeof signal.current_turn_text === "string" ? signal.current_turn_text : "",
  }) + "\n";
  const fd = openSync(engagementQueuePath(), QUEUE_O_FLAGS, QUEUE_FILE_MODE);
  try {
    const bytes = Buffer.from(line, "utf8");
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Drain the queue file: rename the live queue to a per-PID `.draining.<ts>`
 * sidecar BEFORE reading, then read the sidecar, then unlink the sidecar.
 *
 * W10 race fix (spawn-finding minor closure):
 *   The prior implementation was `readFileSync(path) → unlinkSync(path)`.
 *   Between the read and the unlink, a concurrent enqueue (hook side, opened
 *   with O_APPEND on the same path) could write a line that we would BOTH
 *   observe in `raw` AND wipe out on unlink — silent loss.
 *
 *   The rename-to-tmp pattern closes the window:
 *     1. renameSync(queue, queue + ".draining.<pid>.<ts>") — atomic on the
 *        same volume. Subsequent enqueues open the ORIGINAL path with
 *        O_CREAT|O_APPEND, so the OS creates a NEW queue file and appends
 *        there; the daemon's drain operates on the renamed sidecar and
 *        cannot observe nor wipe those new appends.
 *     2. readFileSync(sidecar) — reads only the bytes captured at rename
 *        time. Concurrent enqueues are in a different inode.
 *     3. unlinkSync(sidecar) — clean up. Failure here is non-fatal; the
 *        sidecar is uniquely named so it cannot collide with a future drain.
 *
 *   If the rename itself races (ENOENT — another drainer beat us) we return
 *   [] and let the next tick try again. ENOENT on the original path with no
 *   sidecar means the queue is truly empty.
 *
 * Loss-tolerant by design — engagement signals are statistical, not
 * load-bearing — but this closes the avoidable per-tick loss window the
 * previous read-then-unlink pattern had.
 *
 * @returns {object[]} parsed signal objects (corrupt lines silently skipped)
 */
export function drainEngagementQueue() {
  const path = engagementQueuePath();
  if (!existsSync(path)) return [];
  // Atomic rename-to-tmp. The sidecar name includes pid + hi-res ts so two
  // concurrent drainers do not stomp on each other's sidecar. We tolerate
  // both ENOENT (another drainer beat us OR the queue evaporated) and
  // EEXIST (vanishingly unlikely under hi-res ts but still graceful).
  const sidecar =
    path + ".draining." + process.pid + "." + Date.now() + "." + Math.floor(Math.random() * 1e6);
  try {
    renameSync(path, sidecar);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    // Any other rename failure: bail safely; the next tick will retry.
    return [];
  }
  let raw;
  try {
    raw = readFileSync(sidecar, "utf8");
  } catch {
    // Sidecar disappeared between rename and read — extremely unlikely but
    // tolerated.
    try { unlinkSync(sidecar); } catch { /* ignore */ }
    return [];
  }
  try {
    unlinkSync(sidecar);
  } catch {
    // best-effort cleanup; the sidecar is uniquely named so it cannot
    // collide with future drains.
  }
  if (raw === "") return [];
  const out = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip corrupt lines (mid-file corruption tolerated).
    }
  }
  return out;
}

/**
 * Convenience adapter: drain the queue, run `detectEngagement` over each
 * signal, and yield {signal, results} tuples. The caller (the daemon) owns
 * the damping-log write so this module stays free of writer dependencies.
 */
export function processEngagementQueue() {
  const signals = drainEngagementQueue();
  const out = [];
  for (const signal of signals) {
    try {
      const results = detectEngagement({
        current_turn_text: signal.current_turn_text,
        prior_recall_brief: signal.prior_recall_brief,
      });
      out.push({ signal, results });
    } catch (err) {
      // Defensive: never propagate detector failures through the daemon.
      out.push({ signal, results: [], error: String(err && err.message) });
    }
  }
  return out;
}

// Test seam — production daemons do not call this.
export function _resetQueueForTest() {
  const path = engagementQueuePath();
  try {
    unlinkSync(path);
  } catch (e) {
    if (!(e && e.code === "ENOENT")) throw e;
  }
}

// (W10: renameSync is now used directly by drainEngagementQueue to close
// the read-then-unlink race window. Prior version had a `void renameSync`
// guard for an unused import; the import is now load-bearing.)
