#!/usr/bin/env node
// bootstrap-synthetic-held-out-labels.mjs
//
// F-SYN-OPERATIONAL-held-out-labeled-set-v2 — SYNTHETIC v0 BASELINE.
//
// Generates v0 synthetic held_out_label ledger events from recall.jsonl using
// heuristic rules. Explicitly marks each label with `is_synthetic: true,
// supersede_with_v1: true` so operator-labeled v1 labels can replace them.
//
// PURPOSE: bootstrap the eval-harness with REAL EVAL INPUT TODAY so the harness
// can run end-to-end without waiting for operator labeling. The v1 supersession
// path is documented in held-out-labeled-set.md § 4.2 (label schema v2).
//
// Heuristic rules per recall event:
//   - expected_ids: surfaced memories at position 0-2 (top-3 are "expected to be
//     here" as v0 baseline; operator may overrule)
//   - forbidden_ids: empty by default (no forbidden inferable without operator
//     intent)
//   - abstain: true if surfaced.length === 0 OR density_flag indicates abstain
//
// Usage:
//   node mcp/scripts/bootstrap-synthetic-held-out-labels.mjs \
//     [--candidates=path/to/label-candidates.jsonl] \
//     [--output=path/to/held-out-labels.jsonl]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { createHash } from "node:crypto";

// Data root comes from lib/config.js (MEMORY_ROOT, default: this checkout),
// the same LEDGERS_DIR the sampler writes to and run-held-out-eval.mjs reads.
import { LEDGERS_DIR } from "../lib/config.js";

export const BOOTSTRAP_VERSION = "v0.1.0";
export const BOOTSTRAP_CAPS = Object.freeze({
  TOP_K_EXPECTED: 3,
  LABELER_NAME: "synthetic-v0-bootstrap",
});

function parseArgs(argv) {
  const opts = {
    candidates: join(LEDGERS_DIR, "held-out-label-candidates.jsonl"),
    output: join(LEDGERS_DIR, "held-out-labels.jsonl"),
  };
  for (const arg of argv.slice(2)) {
    const [k, v] = arg.split("=");
    if (k === "--candidates") opts.candidates = v;
    else if (k === "--output") opts.output = v;
  }
  return opts;
}

function deterministicLabelId(recall_id) {
  // ULID-shaped synthetic id derived from recall_id so re-runs are stable.
  const h = createHash("sha256").update(`held_out_label::${recall_id}`).digest("hex");
  return `holb_${h.slice(0, 20)}`;
}

export function synthesizeLabel(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const surfaced = Array.isArray(candidate.surfaced) ? candidate.surfaced : [];
  const expected_ids = surfaced.slice(0, BOOTSTRAP_CAPS.TOP_K_EXPECTED).map((s) => s.memory_id).filter(Boolean);
  const abstain = surfaced.length === 0 || candidate.density_flag === "abstain_emit";
  const id = deterministicLabelId(candidate.recall_id);

  return {
    id,
    kind: "held_out_label",
    derived_from: [candidate.recall_id],
    ts: new Date().toISOString(),
    payload: {
      expected_ids: abstain ? [] : expected_ids,
      forbidden_ids: [],
      abstain,
      labeled_at: new Date().toISOString(),
      labeler_notes: "v0 synthetic bootstrap — top-3 surfaced treated as expected unless empty/abstain. Supersede with operator-labeled v1.",
    },
    metadata: {
      is_synthetic: true,
      supersede_with_v1: true,
      bootstrap_version: BOOTSTRAP_VERSION,
      labeler: BOOTSTRAP_CAPS.LABELER_NAME,
      stratum: candidate.stratum || null,
    },
  };
}

function readCandidates(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv);
  const candidates = readCandidates(opts.candidates);
  const labels = candidates.map(synthesizeLabel).filter(Boolean);
  mkdirSync(dirname(resolve(opts.output)), { recursive: true });
  writeFileSync(opts.output, labels.map((l) => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });

  const abstainCount = labels.filter((l) => l.payload.abstain).length;
  console.log(JSON.stringify({
    bootstrap_version: BOOTSTRAP_VERSION,
    candidates_read: candidates.length,
    labels_emitted: labels.length,
    abstain_labels: abstainCount,
    expected_only_labels: labels.length - abstainCount,
    output: opts.output,
    notes: "v0 SYNTHETIC labels — all carry is_synthetic:true + supersede_with_v1:true",
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
