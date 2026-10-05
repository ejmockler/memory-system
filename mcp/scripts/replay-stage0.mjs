#!/usr/bin/env node
// replay-stage0.mjs — R25 Stage-0 hard-drop replay tool.
//
// Authoritative spec source:
//   kb/salience-design.md § "Layer 1 source-tiered
//   Stage-0 hard-drops" + § "Replay-script duty"
//   kb/ingestion.md § Stage-0 cascade
//
// Purpose
// -------
// Re-run the per-source Stage-0 dispatcher against every row in
// storage/sources/*.jsonl. Two outcomes matter:
//
//   (1) "newly drops" — a row that WAS previously promoted into memory.jsonl
//       but under the CURRENT Stage-0 rules would be hard-dropped (e.g. the
//       iMessage tapback rule tightened, or the github WatchEvent rule added).
//       For these rows we emit a retroactive-drop sidecar event that the
//       recall surface honors via hard-gates.
//
//   (2) "newly passes" — a row that WAS previously hard-dropped but under
//       the CURRENT rules would now PASS Stage-0. These are NOT auto-promoted
//       (the promote pipeline owns the actual append; this script only stages
//       the IDs for the operator). We emit them to a candidates list and log
//       a count.
//
// Sidecar-vs-policy-events decision
// ---------------------------------
// The integration map's Phase A6 owns CAPS additions AND the EVENT_KINDS
// taxonomy in policy-events.js. New event kinds like
// `policy.salience.retroactive_drop` cannot be appended to that enum from
// this script — and even if they could, the per-run row volume can dwarf
// the rest of the audit log. R25.5 CRIT-3 wires the retroactive-drop
// sidecar to the recall layer via hard-gates.js _scanLedger, which reads
// the directory at every recall (cached on directory mtime). The path and
// schema are owned jointly by:
//
//   producer:  mcp/scripts/replay-stage0.mjs (this file)
//   consumer:  mcp/lib/recall/hard-gates.js  (RETROACTIVE_DROP_SIDECAR_VERSION)
//
// Paths:
//   $MEMORY_ROOT/storage/salience-sidecars/retroactive-drop-<run_id>.jsonl
//   $MEMORY_ROOT/storage/salience-sidecars/stage0-newly-pass-<run_id>.jsonl
//
// Each retroactive-drop row schema (RETROACTIVE_DROP_SIDECAR_VERSION=1):
//   {
//     dropped_at_ts:    ISO-8601 string
//     target_memory_id: string (the memory.jsonl row id to excise)
//     reason:           string (the Stage-0 rule name that fired)
//     replay_run_id:    string (also encoded in the filename)
//     version:          number (1)
//   }
//
// Both files are append-only and byte-idempotent — re-running replay-stage0
// against the same run_id appends to the same file and de-dupes via the
// target_memory_id key. The hard-gates reader version-gates so a future
// breaking-change bump can be rolled out consumer-first.
//
// Stage-0 module-loader contract
// ------------------------------
// The Stage-0 dispatcher lives at mcp/lib/ingest/stage0/index.js
// (Phase A2 owner). This script imports it lazily and falls back to a stub
// "dispatch=PASS for every row" when the module is not yet present. Once A2
// lands, replaying against the new rules just works.
//
// CLI
// ---
//   node mcp/scripts/replay-stage0.mjs                     # all sources
//   node mcp/scripts/replay-stage0.mjs --source imessage   # just one
//   node mcp/scripts/replay-stage0.mjs --dry-run
//   node mcp/scripts/replay-stage0.mjs --quiet
//
// Hermeticity
// -----------
// Reads memory.jsonl + storage/sources/*; writes only the sidecar files
// under storage/. Production memory.jsonl is NEVER mutated by this script.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  STORAGE_DIR,
  memoryLedgerPath,
  sourceLedgerPath,
} from "../lib/config.js";
import { canonicalJson } from "../lib/validation.js";
import { serverTs } from "../lib/envelope.js";
// WU-scripts-stringcap: the three whole-file readFileSync sites below crossed
// Node's max string length. memory.jsonl is 3,056,314,513 B (5.69x the
// 536,870,888-byte cap) and storage/sources/mail.jsonl is 349,643,964 B
// (0.651x and climbing), so readJsonl was a landmine on the same fuse.
import { streamLedgerLines } from "../lib/synthesis/_ledger-stream.js";

// Sources covered by the watermark daemon (R26 integration map § D).
const SOURCES = Object.freeze([
  "imessage",
  "screentime",
  "git-log",
  "github-events",
  "chat-claude-code",
]);

// ---------------------------------------------------------------------------
// Lazy load of the Stage-0 dispatcher. Returns a "passthrough" stub when
// the production dispatcher module is not yet present (Phase A2 not landed).
// ---------------------------------------------------------------------------
async function loadDispatcher() {
  try {
    const mod = await import("../lib/ingest/stage0/index.js");
    if (typeof mod.dispatch === "function") return mod.dispatch;
  } catch {
    // module not present — fall through
  }
  // Stub: PASS everything (so "newly drops" is empty until rules are wired).
  return (_source, _event) => ({
    decision: "PASS",
    reason: null,
    structural_score: null,
  });
}

// ---------------------------------------------------------------------------
// Sidecar paths. R25.5 CRIT-3 — aligned with hard-gates.js consumer glob.
// ---------------------------------------------------------------------------
// run_id is encoded in the filename so a re-run is a NEW file (operators
// can rescind a single run by deleting its file). When the caller omits a
// run_id, one is synthesized from the current ISO-8601 timestamp. The
// hard-gates consumer reads every matching file under salience-sidecars/.
export const SALIENCE_SIDECAR_DIRNAME = "salience-sidecars";
export const RETROACTIVE_DROP_FILE_PREFIX = "retroactive-drop-";
export const NEWLY_PASS_FILE_PREFIX = "stage0-newly-pass-";
export const RETROACTIVE_DROP_SIDECAR_VERSION = 1;

function sidecarDir() {
  return join(STORAGE_DIR, SALIENCE_SIDECAR_DIRNAME);
}

export function retroactiveDropPath(runId) {
  const safeId = sanitizeRunId(runId);
  return join(sidecarDir(), `${RETROACTIVE_DROP_FILE_PREFIX}${safeId}.jsonl`);
}
export function newlyPassPath(runId) {
  const safeId = sanitizeRunId(runId);
  return join(sidecarDir(), `${NEWLY_PASS_FILE_PREFIX}${safeId}.jsonl`);
}

function sanitizeRunId(runId) {
  if (typeof runId === "string" && runId !== "") {
    // Filename-safe: ASCII alnum + dash + underscore + dot only.
    return runId.replace(/[^A-Za-z0-9._-]/g, "_");
  }
  // Default: ISO-8601 with colons replaced (filesystem-safe).
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ---------------------------------------------------------------------------
// I/O helpers. Same shape as replay-salience.mjs — sidecars are append-only
// and re-running is a no-op (we skip source_msg_ids already recorded).
// ---------------------------------------------------------------------------
// WU-scripts-stringcap: streams instead of readFileSync. Called at
// replayOneSource() on storage/sources/<source>.jsonl (mail.jsonl measured at
// 349,643,964 B = 0.651x the string cap and growing) and by readSidecarKeySet
// on the salience sidecars. Return shape is still an Array — readSidecarKeySet
// iterates it.
//
// The existsSync short-circuit is GONE per the B1c3 rationale at
// _ledger-stream.js:118-127: existsSync returns false for a file behind
// EACCES / ELOOP / ENOTDIR, so an unreadable-but-present path silently became
// "empty file". streamLedgerLines keeps ENOENT -> zeros with readError null
// (missing file is still legitimately empty) and reports every other errno on
// counts.readError, which we raise.
function readJsonl(path) {
  const out = [];
  const counts = streamLedgerLines(path, (row) => {
    out.push(row);
  });
  if (counts.readError) {
    throw new Error(
      `replay-stage0: cannot read ${path}: ${counts.readError}`,
    );
  }
  return out;
}

function readSidecarKeySet(path, keyFn) {
  const rows = readJsonl(path);
  const s = new Set();
  for (const r of rows) {
    const k = keyFn(r);
    if (typeof k === "string" && k.length > 0) s.add(k);
  }
  return s;
}

function atomicAppendJsonl(path, newRows, existingTextHint) {
  if (newRows.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  let body = "";
  if (typeof existingTextHint === "string") {
    body = existingTextHint;
  } else if (existsSync(path)) {
    body = readFileSync(path, "utf8");
  }
  if (body !== "" && !body.endsWith("\n")) body += "\n";
  for (const r of newRows) {
    body += canonicalJson(r) + "\n";
  }
  const partial = `${path}.partial`;
  writeFileSync(partial, body, { mode: 0o600 });
  renameSync(partial, path);
}

// ---------------------------------------------------------------------------
// Build the index of source_msg_ids that have already been promoted into
// memory.jsonl. This is how we tell "previously promoted" from "previously
// dropped" — if a source-ledger row has a memory.jsonl source_refs entry
// pointing back at its source_msg_id, it was promoted; otherwise dropped.
// ---------------------------------------------------------------------------
// WU-scripts-stringcap: streams instead of readFileSync (memory.jsonl is
// 5.69x Node's max string length). RETENTION IS UNCHANGED and deliberately
// uncapped — measured on the full live ledger, both this map and the one
// below retain only 110,280 distinct (source, source_msg_id) pairs across 8
// sources. That is small; a row cap here would silently change semantics.
export function loadPromotedSourceIds(ledgerPath) {
  const promoted = new Map(); // source -> Set<source_msg_id>
  for (const s of SOURCES) promoted.set(s, new Set());
  const counts = streamLedgerLines(ledgerPath, (row) => {
    if (!row || row.kind !== "fact" || !Array.isArray(row.source_refs)) return;
    for (const ref of row.source_refs) {
      if (
        ref &&
        typeof ref.source === "string" &&
        typeof ref.source_msg_id === "string" &&
        promoted.has(ref.source)
      ) {
        promoted.get(ref.source).add(ref.source_msg_id);
      }
    }
  });
  if (counts.readError) {
    throw new Error(
      `replay-stage0: cannot read ledger ${ledgerPath}: ${counts.readError}`,
    );
  }
  return promoted;
}

// R25.5 CRIT-3 — source_msg_id → memory_id (per source). The sidecar schema
// stores target_memory_id (not source_msg_id) so the hard-gates excise-set
// consumer can be the same code path as connector_revoke + direct-excise.
// Build the inverse map by scanning memory.jsonl source_refs[]. A single
// source_msg_id can map to multiple memory_ids when corroboration projects
// the same source onto another fact; we record the first-seen (the original
// fact-row), which is the row the retroactive drop should excise.
// WU-scripts-stringcap: streams instead of readFileSync. First-seen-wins
// retention is preserved exactly (the `!m.has(...)` guard below).
export function loadSourceMsgIdToMemoryId(ledgerPath) {
  const out = new Map(); // source -> Map<source_msg_id, memory_id>
  for (const s of SOURCES) out.set(s, new Map());
  const counts = streamLedgerLines(ledgerPath, (row) => {
    if (
      !row ||
      row.kind !== "fact" ||
      typeof row.id !== "string" ||
      !Array.isArray(row.source_refs)
    ) {
      return;
    }
    for (const ref of row.source_refs) {
      if (
        !ref ||
        typeof ref.source !== "string" ||
        typeof ref.source_msg_id !== "string" ||
        !out.has(ref.source)
      ) {
        continue;
      }
      const m = out.get(ref.source);
      if (!m.has(ref.source_msg_id)) {
        m.set(ref.source_msg_id, row.id);
      }
    }
  });
  if (counts.readError) {
    throw new Error(
      `replay-stage0: cannot read ledger ${ledgerPath}: ${counts.readError}`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-source replay. Returns counts + the new sidecar rows ready to write.
// ---------------------------------------------------------------------------
export async function replayOneSource(source, opts = {}) {
  const dispatch = opts.dispatch || (await loadDispatcher());
  const ledger = sourceLedgerPath(source);
  const promoted = opts.promoted || loadPromotedSourceIds(memoryLedgerPath());
  const promotedIds = promoted.get(source) || new Set();
  // R25.5 CRIT-3: the sidecar schema names target_memory_id (not source_msg_id)
  // so we look up the memory_id for every previously-promoted source_msg_id.
  // Rows whose source_msg_id is in promotedIds but missing from this map
  // are a malformed-ledger signal — surfaced as console.error, skipped.
  const sidToMid =
    opts.sourceMsgIdToMemoryId ||
    loadSourceMsgIdToMemoryId(memoryLedgerPath());
  const sourceSidToMid = sidToMid.get(source) || new Map();

  const sourceRows = readJsonl(ledger);
  const runId = opts.replayRunId || sanitizeRunId(opts.runId);
  const dropPath = opts.retroactivePath || retroactiveDropPath(runId);
  const passPath = opts.newlyPassPath || newlyPassPath(runId);
  // De-dupe by target_memory_id (R25.5 schema) AND legacy source_msg_id
  // (any pre-R25.5 sidecar lines re-read here). The legacy key is harmless
  // — the new schema has no source_msg_id field so the read returns "".
  const droppedAlready = readSidecarKeySet(
    dropPath,
    (r) =>
      (typeof r.target_memory_id === "string" && r.target_memory_id) ||
      (typeof r.source_msg_id === "string" && r.source_msg_id) ||
      "",
  );
  const passedAlready = readSidecarKeySet(passPath, (r) => r.source_msg_id);

  const newRetroDrops = [];
  const newNewlyPasses = [];
  let passCount = 0;
  let dropCount = 0;
  const ts = opts.now || serverTs();

  // Deterministic order so re-runs are byte-stable.
  sourceRows.sort((a, b) => {
    const sa = typeof a.source_msg_id === "string" ? a.source_msg_id : "";
    const sb = typeof b.source_msg_id === "string" ? b.source_msg_id : "";
    return sa.localeCompare(sb);
  });

  for (const row of sourceRows) {
    if (!row || typeof row.source_msg_id !== "string") continue;
    const sid = row.source_msg_id;
    const result = dispatch(source, row);
    if (!result || typeof result.decision !== "string") continue;

    const isDrop = result.decision === "DROP" || result.decision === "REDACT_DROP";
    if (isDrop) dropCount += 1;
    else passCount += 1;

    const wasPromoted = promotedIds.has(sid);

    if (isDrop && wasPromoted) {
      const memId = sourceSidToMid.get(sid);
      if (typeof memId !== "string" || memId === "") {
        // Should not happen — promotedIds was built from the same scan.
        // Surface as drift and skip.
        console.error(
          `replay-stage0: ${source}/${sid} marked promoted but no memory_id resolved; skipping retroactive_drop emit`,
        );
        continue;
      }
      if (droppedAlready.has(memId)) continue;
      newRetroDrops.push({
        dropped_at_ts: ts,
        target_memory_id: memId,
        reason: result.reason || "stage0_rule_tightened",
        replay_run_id: runId,
        version: RETROACTIVE_DROP_SIDECAR_VERSION,
      });
      // Defend against duplicates within this run (multiple source_msg_ids
      // mapping to the same memory_id — should not happen but cheap to gate).
      droppedAlready.add(memId);
    } else if (!isDrop && !wasPromoted && !passedAlready.has(sid)) {
      newNewlyPasses.push({
        kind: "policy.salience.stage0_newly_pass",
        ts,
        source,
        source_msg_id: sid,
        structural_score:
          typeof result.structural_score === "number"
            ? result.structural_score
            : null,
      });
    }
  }

  return {
    source,
    scanned: sourceRows.length,
    stage0_pass: passCount,
    stage0_drop: dropCount,
    new_retroactive_drops: newRetroDrops,
    new_newly_passes: newNewlyPasses,
  };
}

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------
export async function runReplayStage0(opts = {}) {
  const sources = opts.source ? [opts.source] : SOURCES;
  const dryRun = opts.dryRun === true;
  const quiet = opts.quiet === true;
  const log = quiet ? () => {} : (m) => console.log(m);

  const dispatch = opts.dispatch || (await loadDispatcher());
  const ledgerPath = opts.ledgerPath || memoryLedgerPath();
  const promoted = loadPromotedSourceIds(ledgerPath);
  const sidToMid = loadSourceMsgIdToMemoryId(ledgerPath);

  // Single run_id per invocation — every source writes into the SAME sidecar
  // pair so a future rescind operates on the run as a unit.
  const runId = sanitizeRunId(opts.runId);
  const dropPath = opts.retroactivePath || retroactiveDropPath(runId);
  const passPath = opts.newlyPassPath || newlyPassPath(runId);

  log(`replay-stage0: sources=${sources.join(",")} dry_run=${dryRun} run_id=${runId}`);

  const allDrops = [];
  const allPasses = [];
  const summary = [];

  for (const s of sources) {
    if (!SOURCES.includes(s)) {
      console.error(`replay-stage0: unknown source ${s}`);
      continue;
    }
    const r = await replayOneSource(s, {
      dispatch,
      promoted,
      sourceMsgIdToMemoryId: sidToMid,
      retroactivePath: dropPath,
      newlyPassPath: passPath,
      replayRunId: runId,
      now: opts.now,
    });
    summary.push(r);
    for (const d of r.new_retroactive_drops) allDrops.push(d);
    for (const p of r.new_newly_passes) allPasses.push(p);
    log(
      `replay-stage0: ${s} scanned=${r.scanned} pass=${r.stage0_pass} ` +
        `drop=${r.stage0_drop} new_retro_drops=${r.new_retroactive_drops.length} ` +
        `new_newly_pass=${r.new_newly_passes.length}`,
    );
  }

  if (dryRun) {
    log(
      `replay-stage0: dry-run; total_new_retro=${allDrops.length} ` +
        `total_new_pass=${allPasses.length}`,
    );
    return {
      summary,
      wrote_retro: 0,
      wrote_pass: 0,
      total_retro: allDrops.length,
      total_pass: allPasses.length,
    };
  }

  atomicAppendJsonl(dropPath, allDrops);
  atomicAppendJsonl(passPath, allPasses);

  log(
    `replay-stage0: wrote retro=${allDrops.length} pass=${allPasses.length}`,
  );
  return {
    summary,
    wrote_retro: allDrops.length,
    wrote_pass: allPasses.length,
    total_retro: allDrops.length,
    total_pass: allPasses.length,
  };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------
const isDirect = process.argv[1] && process.argv[1].endsWith("replay-stage0.mjs");
if (isDirect) {
  const args = process.argv.slice(2);
  let dryRun = false;
  let quiet = false;
  let source = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--quiet") quiet = true;
    else if (a === "--source") {
      source = args[i + 1];
      i += 1;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: replay-stage0.mjs [--dry-run] [--quiet] [--source <name>]",
      );
      process.exit(0);
    } else {
      console.error(`replay-stage0: unknown arg ${a}`);
      process.exit(1);
    }
  }
  try {
    const res = await runReplayStage0({ dryRun, quiet, source });
    if (!quiet) {
      console.log(
        `replay-stage0: DONE wrote_retro=${res.wrote_retro} wrote_pass=${res.wrote_pass}`,
      );
    }
    process.exit(0);
  } catch (e) {
    console.error(`replay-stage0: FAILED ${e.message}`);
    process.exit(2);
  }
}
