// eval-harness.js — operational-tier offline eval harness for the
// 150-row held-out labeled set
// (F-SYN-OPERATIONAL-offline-eval-harness, Wave 11).
//
// Operational spec: docs/specs/synthesis/held-out-labeled-set.md
//   - § 4 (label schema) — the row shape consumed here
//   - § 6 (eval metrics) — Recall@12, MRR-expected, NDCG@12 w/ graded
//     relevance + negative gain on forbidden_ids, Abstain F1, harm rate
//   - § 6.6 (paired-bootstrap 90% CI, 10k resamples) — variance gate
// Soak/propensity contract (joined ledger): docs/specs/synthesis/propensity-logging-soak.md
//   - § 4 (canonical recall event shape: surfaced[]{memory_id, score,
//     position, propensity, ...}) — the recall side of the (label, recall)
//     pair the metric pipeline joins on.
//
// This module is the ONLY computer of the four offline metrics for the
// v0→v1 promotion gate. It is invoked from the CI-callable wrapper at
// `mcp/scripts/run-held-out-eval.mjs`; downstream consumers (the gate
// script) compare metric deltas against zero with the bootstrap CI.
//
// CROSS-MODULE DEFENSIVE DISCIPLINE
//   Every cross-module call (filesystem reads, derivation-graph join, JSON
//   parse) is wrapped in a try/catch. The harness never throws on a
//   corrupt line — it logs and skips. The only fatal path is "labelsPath
//   does not exist" (the gate has nothing to evaluate).
//
// VERSION + CAPS DISCIPLINE (W2-W10 module convention)
//   - EVAL_HARNESS_VERSION pinned and exported.
//   - EVAL_CAPS frozen; downstream tests assert constant pinning per spec
//     § 11 invariant 8 (BOOTSTRAP_RESAMPLES = 10000 pinned in caps).
//
// PURE FUNCTIONS (NO HIDDEN I/O EXCEPT THE TWO LEDGER READS)
//   - The two ledger reads are line-by-line streams; corrupt rows are
//     silently dropped (defensive).
//   - All metric computation is pure: given the same (labels, recall_rows,
//     derivationGraph) it produces the same metrics + bootstrap CI bytes
//     (when the bootstrap RNG is seeded deterministically).
//
// DERIVATION-GRAPH JOIN (graded gain +1 NEIGHBOR)
//   Spec § 6.3 — `mem_id` is a derivation-graph 1-neighbor of any
//   expected_id ⇒ gain = +1. We consume the optional
//   `derivationGraph.forwardAdj` / `derivationGraph.reverseAdj` produced
//   by `mcp/lib/synthesis/derivation-graph.js`. If absent we fall back to
//   "no neighbors known" (gain still computes: just no +1 boosts).
//
// NDCG NEGATIVE-GAIN INVARIANT (spec § 6.3 + § 11 invariant 7)
//   The harness MUST NOT clip NDCG to [0,1] — forbidden_ids contribute -2
//   to the DCG numerator, and IDCG never includes forbidden_ids, so real
//   NDCG can go below zero. The test suite asserts a synthetic
//   negative-NDCG case to lock this in.

import { existsSync, readFileSync } from "node:fs";

export const EVAL_HARNESS_VERSION = "eval-harness@0.1.0";

// CAPS — every constant the spec pins, frozen at module load.
// Reading the spec while reading this: K matches RECALL_BRIEF_MAX_ITEMS
// (12) per held-out-labeled-set.md § 6.1. BOOTSTRAP_RESAMPLES = 10000
// matches § 6.6 + § 11 invariant 8. CI_LEVEL = 0.90 matches the gate
// pinning. GRADED_GAIN locks the +2 / +1 / 0 / -2 schedule from § 6.3.
export const EVAL_CAPS = Object.freeze({
  K: 12,
  BOOTSTRAP_RESAMPLES: 10000,
  CI_LEVEL: 0.90,
  GRADED_GAIN: Object.freeze({
    expected: 2,
    neighbor: 1,
    filler: 0,
    forbidden: -2,
  }),
});

// ---------------------------------------------------------------------------
// Internal helpers (pure)
// ---------------------------------------------------------------------------

/** Stream a .jsonl file into an array of parsed rows.
 *  - Missing file → throws (caller decides; eval refuses on missing labels).
 *  - Corrupt lines → silently skipped (defensive ledger-read discipline). */
function readJsonl(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const e = new Error(`eval-harness: cannot read ${path}: ${err && err.message}`);
    e.code = "EVAL_HARNESS_FILE_MISSING";
    throw e;
  }
  if (raw.length === 0) return [];
  const lines = raw.split("\n");
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Defensive: corrupt line → drop; do not poison the eval.
      continue;
    }
  }
  return rows;
}

/** Build an index by recall_id over a list of recall events. */
function indexRecallById(recallRows) {
  const idx = new Map();
  for (const row of recallRows) {
    try {
      if (row == null || typeof row !== "object") continue;
      if (row.kind !== "recall") continue;
      if (typeof row.id !== "string" || row.id.length === 0) continue;
      idx.set(row.id, row);
    } catch {
      continue;
    }
  }
  return idx;
}

/** Join each label to its `derived_from[0]` recall event. Labels whose
 *  recall_id cannot be resolved are silently dropped (the recall row may
 *  have been GC'd from the soak window; the harness reports n_labels_used
 *  so the operator can see the join rate). */
function joinPairs(labels, recallIdx) {
  const pairs = [];
  for (const label of labels) {
    try {
      if (label == null || typeof label !== "object") continue;
      if (label.kind !== "held_out_label") continue;
      if (!Array.isArray(label.derived_from) || label.derived_from.length === 0) continue;
      const recallId = label.derived_from[0];
      const recall = recallIdx.get(recallId);
      if (recall === undefined) continue;
      pairs.push({ label, recall });
    } catch {
      continue;
    }
  }
  return pairs;
}

/** Extract the surfaced memory_ids in brief order from a recall row.
 *  Defensive against missing `surfaced[]` (treat as empty per spec § 8.4). */
function surfacedIdsFromRecall(recall) {
  if (recall == null || typeof recall !== "object") return [];
  const surfaced = recall.surfaced;
  if (!Array.isArray(surfaced)) return [];
  // Sort by position ascending if positions are present; otherwise rely on
  // insertion order (recall.js writes in brief order anyway).
  const withPos = [];
  for (const item of surfaced) {
    if (item == null || typeof item !== "object") continue;
    const mid = item.memory_id;
    if (typeof mid !== "string" || mid.length === 0) continue;
    const pos = typeof item.position === "number" ? item.position : withPos.length;
    withPos.push({ memory_id: mid, position: pos });
  }
  withPos.sort((a, b) => a.position - b.position);
  return withPos.map((x) => x.memory_id);
}

/** 1-hop neighbor set for an expected_id via the derivation graph.
 *  - forwardAdj: child → parents (we surface parents as neighbors)
 *  - reverseAdj: parent → children (we surface children as neighbors)
 *  Both directions count as "1-neighbor" per spec § 6.3 (the spec is
 *  agnostic on direction; the engagement BFS treats both as derivation
 *  adjacency). */
function expandNeighbors(expectedIds, derivationGraph) {
  const neighbors = new Set();
  if (derivationGraph == null) return neighbors;
  const fwd = derivationGraph.forwardAdj instanceof Map
    ? derivationGraph.forwardAdj
    : null;
  const rev = derivationGraph.reverseAdj instanceof Map
    ? derivationGraph.reverseAdj
    : null;
  for (const eid of expectedIds) {
    try {
      if (fwd) {
        const parents = fwd.get(eid);
        if (parents) for (const p of parents) neighbors.add(p);
      }
      if (rev) {
        const children = rev.get(eid);
        if (children) for (const c of children) neighbors.add(c);
      }
    } catch {
      continue;
    }
  }
  return neighbors;
}

// ---------------------------------------------------------------------------
// Per-event metrics (pure functions over a single (label, recall) pair)
// ---------------------------------------------------------------------------

/** Recall@K — spec § 6.1.
 *  Abstain-correct: abstain:true AND expected_ids:[] AND surfaced:[] → 1.0
 *  Abstain-failed:  abstain:true AND surfaced:[]!=[]               → 0.0
 *  Non-abstain:     |expected ∩ surfaced[:K]| / |expected|         */
export function recallAtKForPair(label, surfacedIds, k = EVAL_CAPS.K) {
  if (label == null || typeof label !== "object") return null;
  const payload = label.payload || {};
  const expected = Array.isArray(payload.expected_ids) ? payload.expected_ids : [];
  const abstain = payload.abstain === true;
  const surf = Array.isArray(surfacedIds) ? surfacedIds.slice(0, k) : [];

  if (abstain) {
    if (expected.length === 0 && surf.length === 0) return 1.0;
    if (surf.length > 0) return 0.0;
    // abstain w/ expected_ids present is a schema violation; spec § 4.2
    // says this is rejected at write time. Treat as 0 defensively.
    return 0.0;
  }
  if (expected.length === 0) return null; // not scoreable
  const expSet = new Set(expected);
  let hits = 0;
  for (const mid of surf) if (expSet.has(mid)) hits++;
  return hits / expected.length;
}

/** MRR-expected — spec § 6.2.
 *  1 / rank_of_first(expected_id in surfaced), 0 if none, null if no
 *  expected_ids (excluded from MRR mean). */
export function mrrExpectedForPair(label, surfacedIds, k = EVAL_CAPS.K) {
  if (label == null || typeof label !== "object") return null;
  const payload = label.payload || {};
  const expected = Array.isArray(payload.expected_ids) ? payload.expected_ids : [];
  if (expected.length === 0) return null;
  const expSet = new Set(expected);
  const surf = Array.isArray(surfacedIds) ? surfacedIds.slice(0, k) : [];
  for (let i = 0; i < surf.length; i++) {
    if (expSet.has(surf[i])) return 1.0 / (i + 1);
  }
  return 0.0;
}

/** NDCG@K with graded relevance — spec § 6.3.
 *  gain = +2 for expected, +1 for 1-neighbor of expected, -2 for
 *  forbidden, 0 otherwise. IDCG built from a perfect ordering of {+2 per
 *  expected, +1 per neighbor, 0 filler}; forbidden NEVER enters IDCG.
 *
 *  NDCG = DCG / IDCG. May be negative (forbidden gain dominates) — DO
 *  NOT clip (spec § 11 invariant 7). When IDCG == 0 (no expected, no
 *  neighbors) return null so the metric mean excludes it. */
export function ndcgAtKForPair(label, surfacedIds, derivationGraph, k = EVAL_CAPS.K) {
  if (label == null || typeof label !== "object") return null;
  const payload = label.payload || {};
  const expected = Array.isArray(payload.expected_ids) ? payload.expected_ids : [];
  const forbidden = Array.isArray(payload.forbidden_ids) ? payload.forbidden_ids : [];
  const expSet = new Set(expected);
  const forbSet = new Set(forbidden);
  const neighborSet = expandNeighbors(expected, derivationGraph);
  // Neighbors that are ALSO expected get the +2 gain; neighbors stay +1.
  for (const e of expected) neighborSet.delete(e);

  const surf = Array.isArray(surfacedIds) ? surfacedIds.slice(0, k) : [];
  let dcg = 0;
  for (let i = 0; i < surf.length; i++) {
    const mid = surf[i];
    let gain;
    if (forbSet.has(mid)) gain = EVAL_CAPS.GRADED_GAIN.forbidden;
    else if (expSet.has(mid)) gain = EVAL_CAPS.GRADED_GAIN.expected;
    else if (neighborSet.has(mid)) gain = EVAL_CAPS.GRADED_GAIN.neighbor;
    else gain = EVAL_CAPS.GRADED_GAIN.filler;
    // Standard NDCG discount: log2(rank+1), rank is 1-indexed → i+2.
    if (gain !== 0) dcg += gain / Math.log2(i + 2);
  }

  // IDCG: perfect ranking is all +2s (expected) first, then +1s (neighbors),
  // then zeros, truncated to K. forbidden never appears in IDCG.
  const idealGains = [];
  for (let i = 0; i < expected.length && idealGains.length < k; i++) {
    idealGains.push(EVAL_CAPS.GRADED_GAIN.expected);
  }
  for (const _ of neighborSet) {
    if (idealGains.length >= k) break;
    idealGains.push(EVAL_CAPS.GRADED_GAIN.neighbor);
  }
  let idcg = 0;
  for (let i = 0; i < idealGains.length; i++) {
    idcg += idealGains[i] / Math.log2(i + 2);
  }
  if (idcg === 0) return null;
  return dcg / idcg;
}

/** Predicted-abstain inference for the v0 ranker (spec § 6.4).
 *  Ranker is predicted-positive when density_flag === "abstain_emit" OR
 *  the brief is empty (no surfaced[]). */
function predictedAbstain(recall) {
  if (recall == null || typeof recall !== "object") return false;
  if (recall.density_flag === "abstain_emit") return true;
  const surf = Array.isArray(recall.surfaced) ? recall.surfaced : [];
  return surf.length === 0;
}

/** Abstain F1 (binary) — spec § 6.4.
 *  positive class: label.abstain == true.
 *  predicted positive: density_flag == "abstain_emit" OR surfaced[] empty.
 *  Returns {precision, recall, f1, tp, fp, fn, tn}; harmonic-mean f1. */
export function abstainF1ForPairs(pairs) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const { label, recall } of pairs) {
    try {
      const lab = label?.payload?.abstain === true;
      const pred = predictedAbstain(recall);
      if (lab && pred) tp++;
      else if (!lab && pred) fp++;
      else if (lab && !pred) fn++;
      else tn++;
    } catch {
      continue;
    }
  }
  const precision = (tp + fp) === 0 ? 0 : tp / (tp + fp);
  const recall = (tp + fn) === 0 ? 0 : tp / (tp + fn);
  const f1 = (precision + recall) === 0
    ? 0
    : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, tp, fp, fn, tn };
}

/** Harm rate — spec § 6.5. Any forbidden in top-K → harm. */
export function harmRateForPairs(pairs, k = EVAL_CAPS.K) {
  if (pairs.length === 0) return 0;
  let harms = 0;
  for (const { label, recall } of pairs) {
    try {
      const forbidden = Array.isArray(label?.payload?.forbidden_ids)
        ? label.payload.forbidden_ids
        : [];
      if (forbidden.length === 0) continue;
      const forbSet = new Set(forbidden);
      const surf = surfacedIdsFromRecall(recall).slice(0, k);
      for (const mid of surf) {
        if (forbSet.has(mid)) {
          harms++;
          break;
        }
      }
    } catch {
      continue;
    }
  }
  return harms / pairs.length;
}

// ---------------------------------------------------------------------------
// Paired bootstrap — spec § 6.6
// ---------------------------------------------------------------------------

/** Deterministic 32-bit PRNG (mulberry32). Bootstrap is paired and
 *  resampled with replacement; we need reproducible RNG so two harness
 *  runs against the same input emit identical CI bounds.
 *  Seed default: a SHA-256-style fold of the per-event vector length so
 *  changing the input changes the seed deterministically. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paired-bootstrap CI over a per-event metric vector.
 *  Returns [p_lower, p_upper] for the requested CI level (default 90%).
 *  Skips NaN/null entries (those events are excluded from that metric). */
export function bootstrapCI(perEventValues, opts = {}) {
  const resamples = Number.isInteger(opts.resamples) && opts.resamples > 0
    ? opts.resamples
    : EVAL_CAPS.BOOTSTRAP_RESAMPLES;
  const level = typeof opts.level === "number" && opts.level > 0 && opts.level < 1
    ? opts.level
    : EVAL_CAPS.CI_LEVEL;
  // Filter nulls/NaNs out — only scored events contribute to the metric.
  const vals = [];
  for (const v of perEventValues) {
    if (v == null) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    vals.push(v);
  }
  if (vals.length === 0) return [0, 0];
  // Seed: length-folded so determinism is per-input-shape.
  const seed = (vals.length * 2654435761) >>> 0;
  const rng = mulberry32(seed || 1);

  const means = new Array(resamples);
  const n = vals.length;
  for (let r = 0; r < resamples; r++) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n);
      acc += vals[idx];
    }
    means[r] = acc / n;
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  const lowIdx = Math.floor(alpha * resamples);
  const hiIdx = Math.min(resamples - 1, Math.ceil((1 - alpha) * resamples) - 1);
  return [means[lowIdx], means[hiIdx]];
}

// ---------------------------------------------------------------------------
// Public API — evaluate()
// ---------------------------------------------------------------------------

/**
 * Compute the full offline-eval metric suite over a labeled held-out set.
 *
 * @param {object} opts
 * @param {string} opts.labelsPath  — path to held-out-labels.jsonl (index file)
 * @param {string} opts.recallLogPath — path to recall.jsonl (soak substrate)
 * @param {{forwardAdj?: Map, reverseAdj?: Map}} [opts.derivationGraph]
 *        — optional; supplies the +1 neighbor graded gain for NDCG.
 * @returns {Promise<{
 *   recall_at_12: number,
 *   mrr_expected: number,
 *   ndcg_at_12: number,
 *   abstain_f1: number,
 *   harm_rate: number,
 *   n_labels_used: number,
 *   bootstrap_ci: {recall: [number, number], mrr: [number, number], ndcg: [number, number]},
 *   built_at: string,
 *   version: string,
 * }>}
 */
export async function evaluate({ labelsPath, recallLogPath, derivationGraph } = {}) {
  if (typeof labelsPath !== "string" || labelsPath.length === 0) {
    const e = new Error("evaluate: labelsPath required");
    e.code = "EVAL_HARNESS_BAD_ARGS";
    throw e;
  }
  if (typeof recallLogPath !== "string" || recallLogPath.length === 0) {
    const e = new Error("evaluate: recallLogPath required");
    e.code = "EVAL_HARNESS_BAD_ARGS";
    throw e;
  }
  if (!existsSync(labelsPath)) {
    const e = new Error(`evaluate: labelsPath not found: ${labelsPath}`);
    e.code = "EVAL_HARNESS_FILE_MISSING";
    throw e;
  }

  let labels = [];
  try {
    labels = readJsonl(labelsPath);
  } catch (err) {
    // readJsonl already throws on missing; if labels exist but parse fails
    // wholesale, surface a clean error.
    const e = new Error(`evaluate: failed reading labels: ${err.message}`);
    e.code = "EVAL_HARNESS_LABELS_UNREADABLE";
    throw e;
  }

  let recallRows = [];
  try {
    if (existsSync(recallLogPath)) {
      recallRows = readJsonl(recallLogPath);
    }
    // Missing recall log is non-fatal: every label simply fails to join
    // and n_labels_used will be 0. The operator sees the join rate and
    // re-runs after the soak accrues data.
  } catch {
    recallRows = [];
  }

  const recallIdx = indexRecallById(recallRows);
  const pairs = joinPairs(labels, recallIdx);

  // Per-event metric vectors (null/NaN entries are excluded from the
  // mean and from the bootstrap CI).
  const recallVec = [];
  const mrrVec = [];
  const ndcgVec = [];

  for (const { label, recall } of pairs) {
    const surf = surfacedIdsFromRecall(recall);
    let r = null, m = null, n = null;
    try { r = recallAtKForPair(label, surf); } catch { r = null; }
    try { m = mrrExpectedForPair(label, surf); } catch { m = null; }
    try { n = ndcgAtKForPair(label, surf, derivationGraph); } catch { n = null; }
    recallVec.push(r);
    mrrVec.push(m);
    ndcgVec.push(n);
  }

  const meanOf = (arr) => {
    let acc = 0, cnt = 0;
    for (const v of arr) {
      if (v == null) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      acc += v; cnt++;
    }
    return cnt === 0 ? 0 : acc / cnt;
  };

  const recall_at_12 = meanOf(recallVec);
  const mrr_expected = meanOf(mrrVec);
  const ndcg_at_12 = meanOf(ndcgVec);
  const abstain = abstainF1ForPairs(pairs);
  const harm_rate = harmRateForPairs(pairs);

  // Bootstrap CI: paired bootstrap is "resample event indices with
  // replacement and re-mean." For a single-system eval (no baseline yet
  // joined), we report the CI of the metric itself; the gate script
  // diff's two runs and compares delta CIs.
  const bootstrap_ci = {
    recall: bootstrapCI(recallVec),
    mrr: bootstrapCI(mrrVec),
    ndcg: bootstrapCI(ndcgVec),
  };

  return {
    recall_at_12,
    mrr_expected,
    ndcg_at_12,
    abstain_f1: abstain.f1,
    harm_rate,
    n_labels_used: pairs.length,
    bootstrap_ci,
    built_at: new Date().toISOString(),
    version: EVAL_HARNESS_VERSION,
  };
}
