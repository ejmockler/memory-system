#!/usr/bin/env node
// sample-held-out-events.mjs
//
// F-SYN-OPERATIONAL-held-out-labeled-set-v2 — STRATIFIED SAMPLER.
//
// Streams ledgers/recall.jsonl + samples up to TARGET_SIZE events stratified by
// (agent_role, time-of-day-bucket, recent_recall_density) per the W7 spec at
// mcp/docs/specs/synthesis/held-out-labeled-set.md § 3.
//
// Outputs label-CANDIDATES (with empty expected_ids[]/forbidden_ids[]/abstain)
// for the operator to fill in. Does NOT generate labels — that's operator product
// judgement, not engineering work.
//
// Usage:
//   node mcp/scripts/sample-held-out-events.mjs \
//     [--recall=path/to/recall.jsonl] \
//     [--output=path/to/label-candidates.jsonl] \
//     [--target-size=150]
//
// Output shape: NDJSON, one row per candidate:
//   {recall_id, ts, query_hash, surfaced: [{memory_id, position}],
//    stratum: {agent_role, time_of_day, density_bucket},
//    expected_ids: [], forbidden_ids: [], abstain: null, labeler_notes: null}

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

// Data root comes from lib/config.js (MEMORY_ROOT, default: this checkout),
// the same LEDGERS_DIR run-held-out-eval.mjs reads from.
import { LEDGERS_DIR } from "../lib/config.js";

export const SAMPLER_VERSION = "v0.1.0";
export const SAMPLER_CAPS = Object.freeze({
  DEFAULT_TARGET_SIZE: 150,
  TIME_OF_DAY_BUCKETS: Object.freeze(["night", "morning", "afternoon", "evening"]),
  TIME_OF_DAY_BOUNDS: Object.freeze({ night: [0, 6], morning: [6, 12], afternoon: [12, 18], evening: [18, 24] }),
  DENSITY_BUCKETS: Object.freeze(["low", "medium", "high"]),
  DENSITY_P33_DEFAULT: 5,
  DENSITY_P66_DEFAULT: 12,
});

function parseArgs(argv) {
  const opts = {
    recall: join(LEDGERS_DIR, "recall.jsonl"),
    output: join(LEDGERS_DIR, "held-out-label-candidates.jsonl"),
    targetSize: SAMPLER_CAPS.DEFAULT_TARGET_SIZE,
  };
  for (const arg of argv.slice(2)) {
    const [k, v] = arg.split("=");
    if (k === "--recall") opts.recall = v;
    else if (k === "--output") opts.output = v;
    else if (k === "--target-size") opts.targetSize = parseInt(v, 10);
  }
  return opts;
}

function timeOfDayBucket(tsIso) {
  const d = new Date(tsIso);
  const hour = d.getUTCHours();
  for (const [bucket, [lo, hi]] of Object.entries(SAMPLER_CAPS.TIME_OF_DAY_BOUNDS)) {
    if (hour >= lo && hour < hi) return bucket;
  }
  return "night";
}

function densityBucket(candidatesCount, p33, p66) {
  if (candidatesCount <= p33) return "low";
  if (candidatesCount <= p66) return "medium";
  return "high";
}

function computeQuantiles(densities) {
  if (!densities.length) return { p33: SAMPLER_CAPS.DENSITY_P33_DEFAULT, p66: SAMPLER_CAPS.DENSITY_P66_DEFAULT };
  const sorted = [...densities].sort((a, b) => a - b);
  const p33 = sorted[Math.floor(sorted.length * 0.33)] || SAMPLER_CAPS.DENSITY_P33_DEFAULT;
  const p66 = sorted[Math.floor(sorted.length * 0.66)] || SAMPLER_CAPS.DENSITY_P66_DEFAULT;
  return { p33, p66 };
}

export function stratifySample({ events, targetSize }) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const densities = events.map((e) => e.candidates_pre_truncation || 0);
  const { p33, p66 } = computeQuantiles(densities);

  const strata = new Map();
  for (const e of events) {
    const agentRole = e?.query?.agent_role || "default";
    const todB = timeOfDayBucket(e.ts);
    const denB = densityBucket(e.candidates_pre_truncation || 0, p33, p66);
    const key = `${agentRole}::${todB}::${denB}`;
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push({ event: e, stratum: { agent_role: agentRole, time_of_day: todB, density_bucket: denB } });
  }

  // Proportional allocation with floor=3 per non-empty cell when feasible
  const perCellFloor = Math.min(3, Math.floor(targetSize / Math.max(strata.size, 1)));
  const sample = [];
  for (const items of strata.values()) {
    const take = Math.min(Math.max(perCellFloor, 1), items.length);
    const stride = items.length / take;
    for (let i = 0; i < take; i++) {
      const idx = Math.floor(i * stride);
      sample.push(items[idx]);
    }
  }

  // If under target, fill from remaining items in order
  const taken = new Set(sample.map((s) => s.event.id));
  for (const items of strata.values()) {
    if (sample.length >= targetSize) break;
    for (const it of items) {
      if (sample.length >= targetSize) break;
      if (!taken.has(it.event.id)) {
        sample.push(it);
        taken.add(it.event.id);
      }
    }
  }

  return sample.slice(0, targetSize);
}

export function toLabelCandidate(sampleItem) {
  const { event, stratum } = sampleItem;
  return {
    recall_id: event.id,
    ts: event.ts,
    query_hash: event?.query?.surrounding_context_hash || null,
    surfaced: (event.surfaced || []).map((s, i) => ({
      memory_id: s.memory_id,
      position: i,
    })),
    stratum,
    candidates_pre_truncation: event.candidates_pre_truncation || 0,
    density_flag: event.density_flag || null,
    expected_ids: [],
    forbidden_ids: [],
    abstain: null,
    labeler_notes: null,
    sampler_version: SAMPLER_VERSION,
  };
}

function readRecallEvents(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.kind === "recall") out.push(r);
    } catch {}
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv);
  const events = readRecallEvents(opts.recall);
  const sample = stratifySample({ events, targetSize: opts.targetSize });
  const candidates = sample.map(toLabelCandidate);
  mkdirSync(dirname(resolve(opts.output)), { recursive: true });
  writeFileSync(opts.output, candidates.map((c) => JSON.stringify(c)).join("\n") + "\n", { mode: 0o600 });
  console.log(JSON.stringify({
    sampler_version: SAMPLER_VERSION,
    recall_events_read: events.length,
    candidates_emitted: candidates.length,
    target_size: opts.targetSize,
    output: opts.output,
    strata_covered: new Set(candidates.map((c) => `${c.stratum.agent_role}::${c.stratum.time_of_day}::${c.stratum.density_bucket}`)).size,
  }, null, 2));
}

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
  main();
}
