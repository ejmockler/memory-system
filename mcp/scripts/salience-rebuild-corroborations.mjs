#!/usr/bin/env node
// salience-rebuild-corroborations.mjs — R25 corroboration-threshold replay.
//
// Authoritative spec source:
//   kb/salience-design.md § "Layer 3 ECN
//   corroboration" + § "Replay-script duty"
//
// Purpose
// -------
// Walk every previously-emitted `policy.corroboration` event (sidecar or, if
// Phase A6 has landed, the policy-events store) and decide its fate against
// the CURRENT CAPS.CORROBORATE_THRESHOLD[source] table:
//
//   - LOOSENED   (current threshold >= recorded threshold):
//                 the corroboration is STILL VALID. No emit.
//   - TIGHTENED  (current threshold < recorded threshold):
//                 the recorded cosine_distance is now ABOVE threshold, i.e.
//                 the two facts are not close enough to merge under the
//                 current rules. Emit policy.salience.upgrade {target_id,
//                 source_ref} so the recall surface treats the source_ref as
//                 a standalone fact (via a hard-gates extension).
//
// Operator workflow
// -----------------
//   1. Operator tightens CAPS.CORROBORATE_THRESHOLD[<source>] in validation.js.
//   2. Operator runs this script. It scans the corroboration history and
//      emits upgrade events for the now-unsupported merges.
//   3. (Optional) operator runs distill-promote-fact against the source_refs
//      flagged for upgrade — they become real fact rows in memory.jsonl.
//
// Sidecar input/output
// --------------------
// INPUT  (corroboration history):
//   $STORAGE/salience-corroborations.jsonl
//      (emitted by Phase A3 of the integration bundle; sidecar until
//      policy-events EVENT_KINDS gains the kind in Phase A6.)
//
// OUTPUT (upgrade events):
//   $STORAGE/salience-corroboration-upgrades.jsonl
//      (one row per upgrade; the recall hard-gates extension reads this.)
//
// Both are append-only, byte-idempotent on re-run (we skip target_ids already
// flagged).
//
// CLI
// ---
//   node mcp/scripts/salience-rebuild-corroborations.mjs
//   node mcp/scripts/salience-rebuild-corroborations.mjs --dry-run
//   node mcp/scripts/salience-rebuild-corroborations.mjs --quiet
//
// Hermeticity
// -----------
// All paths via lib/config.js. memory.jsonl is read but never mutated.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { STORAGE_DIR } from "../lib/config.js";
import { CAPS, canonicalJson } from "../lib/validation.js";
import { serverTs } from "../lib/envelope.js";

// Defaults if Phase A6 (CAPS.CORROBORATE_THRESHOLD) has not yet landed.
const DESIGN_DOC_BASELINE_THRESHOLD = Object.freeze({
  imessage: 0.18,
  "git-log": 0.28,
  "github-events": 0.3,
  screentime: 0.35,
  "chat-claude-code": 0.25,
});

export function currentThresholds() {
  if (CAPS && typeof CAPS === "object" && CAPS.CORROBORATE_THRESHOLD) {
    return { ...CAPS.CORROBORATE_THRESHOLD };
  }
  return { ...DESIGN_DOC_BASELINE_THRESHOLD };
}

export function corroborationHistoryPath() {
  return join(STORAGE_DIR, "salience-corroborations.jsonl");
}
export function corroborationUpgradePath() {
  return join(STORAGE_DIR, "salience-corroboration-upgrades.jsonl");
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  if (raw === "") return [];
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // skip
    }
  }
  return out;
}

function atomicAppendJsonl(path, newRows) {
  if (newRows.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  let body = "";
  if (existsSync(path)) {
    body = readFileSync(path, "utf8");
    if (body !== "" && !body.endsWith("\n")) body += "\n";
  }
  for (const r of newRows) body += canonicalJson(r) + "\n";
  const partial = `${path}.partial`;
  writeFileSync(partial, body, { mode: 0o600 });
  renameSync(partial, path);
}

// ---------------------------------------------------------------------------
// Classify a single corroboration event under a current-threshold table.
// Returns "LOOSENED" / "TIGHTENED" / "UNCHANGED".
// ---------------------------------------------------------------------------
export function classifyCorroboration(event, thresholds) {
  if (event == null || typeof event !== "object") {
    throw new Error("classifyCorroboration: event must be an object");
  }
  const src = event.source_ref && event.source_ref.source;
  if (typeof src !== "string") {
    throw new Error("classifyCorroboration: event.source_ref.source required");
  }
  const recorded = event.threshold_at_emit;
  if (typeof recorded !== "number" || !Number.isFinite(recorded)) {
    throw new Error(
      "classifyCorroboration: event.threshold_at_emit must be a finite number",
    );
  }
  const current = thresholds[src];
  if (typeof current !== "number" || !Number.isFinite(current)) {
    // No current threshold for the source — treat as UNCHANGED (cannot decide).
    return "UNCHANGED";
  }
  if (current > recorded) return "LOOSENED"; // still valid
  if (current < recorded) {
    // Tightened. The corroboration was admitted because the cosine_distance
    // was BELOW the recorded threshold (i.e. close enough). The current rule
    // is stricter; if the recorded cosine_distance is no longer below it,
    // upgrade.
    const cd = event.cosine_distance;
    if (typeof cd !== "number" || !Number.isFinite(cd)) {
      // Missing cosine_distance is conservative: cannot prove still-valid,
      // so flag for upgrade.
      return "TIGHTENED";
    }
    return cd < current ? "LOOSENED" : "TIGHTENED";
  }
  return "UNCHANGED";
}

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------
export function runRebuildCorroborations(opts = {}) {
  const historyPath = opts.historyPath || corroborationHistoryPath();
  const upgradePath = opts.upgradePath || corroborationUpgradePath();
  const thresholds = opts.thresholds || currentThresholds();
  const dryRun = opts.dryRun === true;
  const quiet = opts.quiet === true;
  const log = quiet ? () => {} : (m) => console.log(m);

  log(`rebuild-corroborations: history=${historyPath}`);
  log(`rebuild-corroborations: upgrade=${upgradePath} dry_run=${dryRun}`);

  const events = readJsonl(historyPath);
  const existingUpgrades = new Set();
  for (const r of readJsonl(upgradePath)) {
    if (
      r &&
      typeof r.corroboration_event_id === "string" &&
      r.corroboration_event_id.length > 0
    ) {
      existingUpgrades.add(r.corroboration_event_id);
    }
  }

  // Deterministic processing order so re-runs are byte-stable.
  events.sort((a, b) => {
    const ea = typeof a.corroboration_event_id === "string"
      ? a.corroboration_event_id
      : "";
    const eb = typeof b.corroboration_event_id === "string"
      ? b.corroboration_event_id
      : "";
    return ea.localeCompare(eb);
  });

  const upgrades = [];
  let loosened = 0;
  let tightened = 0;
  let unchanged = 0;
  let skipped = 0;
  const ts = opts.now || serverTs();

  for (const ev of events) {
    let cls;
    try {
      cls = classifyCorroboration(ev, thresholds);
    } catch {
      skipped += 1;
      continue;
    }
    if (cls === "LOOSENED") {
      loosened += 1;
      continue;
    }
    if (cls === "UNCHANGED") {
      unchanged += 1;
      continue;
    }
    tightened += 1;
    const eid =
      typeof ev.corroboration_event_id === "string"
        ? ev.corroboration_event_id
        : null;
    if (eid && existingUpgrades.has(eid)) continue; // already upgraded
    upgrades.push({
      kind: "policy.salience.upgrade",
      ts,
      corroboration_event_id: eid,
      target_id: ev.target_memory_id || ev.target || null,
      source_ref: ev.source_ref,
      reason: "threshold_tightened",
      previous_threshold: ev.threshold_at_emit,
      current_threshold: thresholds[ev.source_ref && ev.source_ref.source],
    });
  }

  log(
    `rebuild-corroborations: loosened=${loosened} tightened=${tightened} ` +
      `unchanged=${unchanged} skipped=${skipped} new_upgrades=${upgrades.length}`,
  );

  if (dryRun) {
    log("rebuild-corroborations: dry-run; no sidecar write");
    return {
      loosened,
      tightened,
      unchanged,
      skipped,
      wrote: 0,
    };
  }

  atomicAppendJsonl(upgradePath, upgrades);
  log(`rebuild-corroborations: wrote ${upgrades.length} upgrade event(s)`);
  return {
    loosened,
    tightened,
    unchanged,
    skipped,
    wrote: upgrades.length,
  };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------
const isDirect =
  process.argv[1] && process.argv[1].endsWith("salience-rebuild-corroborations.mjs");
if (isDirect) {
  const args = process.argv.slice(2);
  let dryRun = false;
  let quiet = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--quiet") quiet = true;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: salience-rebuild-corroborations.mjs [--dry-run] [--quiet]");
      process.exit(0);
    } else {
      console.error(`rebuild-corroborations: unknown arg ${a}`);
      process.exit(1);
    }
  }
  try {
    const res = runRebuildCorroborations({ dryRun, quiet });
    if (!quiet) {
      console.log(
        `rebuild-corroborations: DONE wrote=${res.wrote} ` +
          `loosened=${res.loosened} tightened=${res.tightened} ` +
          `unchanged=${res.unchanged}`,
      );
    }
    process.exit(0);
  } catch (e) {
    console.error(`rebuild-corroborations: FAILED ${e.message}`);
    process.exit(2);
  }
}
