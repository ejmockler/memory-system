#!/usr/bin/env node
// backfill-seed-row-marker.mjs — R29.5 one-shot backfill.
//
// Reads <MEMORY_ROOT>/ledgers/memory.jsonl line-by-line and, for
// any row matching the LEGACY smoke heuristic (provenance.conversation_id ===
// "conv_smoke", content matching known smoke fixtures, or created_at before
// WIPE_THRESHOLD), sets provenance.is_seed_row = true if not already set.
//
// R29.5 convention: any future writer of seed/smoke rows MUST set
// provenance.is_seed_row = true at row-construction time. This backfill exists
// to retrofit the 3 legacy rows that pre-date the marker convention. After
// this script has been run once, the legacy fallback in
// verify-cascade-correctness.mjs becomes a defense-in-depth check that should
// match zero new rows.
//
// Atomicity: writes to <ledger>.tmp, fsync, rename. Idempotent on re-run.
//
// ===========================================================================
// WU-scripts-stringcap SAFETY INTERLOCK — 2026-08-11
// ===========================================================================
// THIS SCRIPT IS DELIBERATELY LEFT UNREPAIRED. Do not "fix" its readFileSync.
//
// The header above claims this backfill retrofits "the 3 legacy rows" that
// pre-date the marker convention. kb/api-key-pool.md:319-330 repeats the
// claim. Replaying matchesLegacySmokeHeuristic() read-only over the live
// ledger on 2026-08-11 measured, instead:
//
//   WOULD_MARK_is_seed_row_true: 1410113      already_marked: 0
//   why_matched: { conv_smoke: 0, known_content: 0,
//                  created_at_before_wipe: 1410113 }
//   by_source:   git-log 1268763, codex-cli 116469, imessage 24705,
//                telegram 80, whatsapp 71, github-events 24,
//                chat-claude-code 1
//   join_output_chars: 3055024714   (= 5.69x MAX_STRING_LENGTH)
//
// CAUSE: every one of the 1,410,113 matches fires solely through the
// `created_at < WIPE_THRESHOLD ("2026-06-03T03:57:00Z")` branch. The git-log
// backfill imported 1.27M historical commits carrying GENUINE old timestamps
// (mem_0000000000000001 @ 2023-01-07, mem_0000000000000002 @ 2025-09-18, ...),
// so a dated constant silently became a corpus-wide match.
//
// BLAST RADIUS: marking sets provenance.is_seed_row = true, which
// verify-cascade-correctness.mjs:66 reads AT DISPATCH as "throwaway smoke,
// exclude". Running this would permanently brand ~92.8% of the corpus as
// synthetic test data inside a durable append-only ledger, and it commits via
// renameSync over the live 3 GB file while the watermark daemon is appending
// to it — so every concurrently-appended row is lost too. `already_marked: 0`
// proves this has never run. The string cap has been its only interlock.
//
// There is also a SECOND, previously-uncounted cap site below at the
// outLines.join("\n") (3,055,024,714 chars), so repairing the read alone would
// merely move the throw ~74 lines down.
//
// WHAT LANDED INSTEAD: a statSync size guard that refuses (exit 4) on any
// over-cap ledger, an explicit --i-understand-this-rewrites-the-live-ledger
// opt-in as the only bypass, and an always-allowed --dry-run rerouted through
// streamLedgerLines so an operator can obtain the real 1,410,113 count without
// a crash and without a write. Deciding WHICH rows are genuinely seed rows is
// not this change's call; making the script safe is.
// ===========================================================================
//
// Usage:
//   node backfill-seed-row-marker.mjs [--ledger=PATH] [--dry-run]
//                                     [--i-understand-this-rewrites-the-live-ledger]
//
// Exit codes:
//   0 = success (also prints {total, updated, unchanged} JSON summary)
//   2 = ledger file not found
//   3 = write failure
//   4 = REFUSED: ledger exceeds Node's max string length (see interlock above).
//       Bypass with --i-understand-this-rewrites-the-live-ledger, or use
//       --dry-run, which is always permitted and never writes.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  statSync,
} from "node:fs";
import { constants as bufferConstants } from "node:buffer"; import { dirname, join, resolve } from "node:path"; import { fileURLToPath } from "node:url";

import { streamLedgerLines } from "../lib/synthesis/_ledger-stream.js";

// Match the WIPE_THRESHOLD convention from verify-cascade-correctness.mjs.
// Rows before this threshold are considered pre-wipe smoke.
const WIPE_THRESHOLD = "2026-06-03T03:57:00Z";

const KNOWN_SMOKE_CONTENT = new Set([
  "USER: hi\nASSISTANT: hello",
  "REPLAY-TEST-CONTENT-uniqueA1",
]);

const args = process.argv.slice(2);
const ledgerArg = args.find((a) => a.startsWith("--ledger="));
const DRY_RUN = args.includes("--dry-run");
// The ONLY way past the over-cap refusal below. Named to be unbluffable.
const ACK_REWRITE = args.includes("--i-understand-this-rewrites-the-live-ledger");
const ledgerPath = ledgerArg
  ? ledgerArg.split("=")[1]
  : join(process.env.MEMORY_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "ledgers", "memory.jsonl");

if (!existsSync(ledgerPath)) {
  process.stderr.write("backfill-seed-row-marker: " + ledgerPath + " not found\n");
  process.exit(2);
}

// Legacy heuristic — same shape verify-cascade uses as fallback.
function matchesLegacySmokeHeuristic(r) {
  if (r?.provenance?.conversation_id === "conv_smoke") return true;
  if (typeof r?.content === "string" && KNOWN_SMOKE_CONTENT.has(r.content))
    return true;
  if (typeof r?.created_at === "string" && r.created_at < WIPE_THRESHOLD)
    return true;
  return false;
}

// ---------------------------------------------------------------------------
// ALWAYS-ALLOWED DRY RUN (WU-scripts-stringcap).
//
// Routed through streamLedgerLines with COUNTING-ONLY retention — no outLines
// array, no JSON.stringify of rows, only the ≤50 sample ids the summary
// already reported. This is what gives an operator the real 1,410,113 number
// on the live 3 GB ledger instead of ERR_STRING_TOO_LONG. It runs BEFORE the
// size guard because a dry run cannot write, and it returns before the
// readFileSync below is ever reached.
// ---------------------------------------------------------------------------
if (DRY_RUN) {
  let dUpdated = 0;
  let dUnchanged = 0;
  let dNonMatching = 0;
  const dUpdatedIds = [];
  const dCounts = streamLedgerLines(ledgerPath, (r) => {
    if (!matchesLegacySmokeHeuristic(r)) {
      dNonMatching++;
      return;
    }
    if (r.provenance && r.provenance.is_seed_row === true) {
      dUnchanged++;
      return;
    }
    dUpdated++;
    if (dUpdatedIds.length < 50) dUpdatedIds.push(r.id || "?");
  });
  if (dCounts.readError) {
    process.stderr.write(
      "backfill-seed-row-marker: read failed on " + ledgerPath + ": " +
        dCounts.readError + "\n"
    );
    process.exit(2);
  }
  const drySummary = {
    ledger: ledgerPath,
    // Streaming counts non-blank lines; blank lines (absent from a well-formed
    // ledger) are not represented, unlike the write path's split("\n").
    total_lines: dCounts.totalLines,
    updated: dUpdated,
    unchanged: dUnchanged,
    non_matching: dNonMatching,
    malformed: dCounts.totalLines - dCounts.parsedLines,
    dry_run: true,
    updated_ids_first_50: dUpdatedIds,
  };
  process.stdout.write(JSON.stringify(drySummary, null, 2) + "\n");
  process.stderr.write(
    "backfill-seed-row-marker: DRY-RUN updated=" + dUpdated +
      " unchanged=" + dUnchanged + " non_matching=" + dNonMatching + "\n"
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// REFUSAL GUARD (WU-scripts-stringcap). See the interlock block at the top of
// this file. Everything below this point rewrites the live append-only ledger.
// ---------------------------------------------------------------------------
const MAX_STRING_LENGTH = bufferConstants.MAX_STRING_LENGTH;
const ledgerBytes = statSync(ledgerPath).size;
if (ledgerBytes > MAX_STRING_LENGTH && !ACK_REWRITE) {
  process.stderr.write(
    "backfill-seed-row-marker: REFUSED\n" +
      "  " + ledgerPath + " is " + ledgerBytes + " bytes, over Node's max\n" +
      "  string cap of " + MAX_STRING_LENGTH + " bytes (" +
      (ledgerBytes / MAX_STRING_LENGTH).toFixed(2) + "x).\n" +
      "\n" +
      "  This is a ONE-SHOT R29.5 backfill written for a ~3-row ledger. On the\n" +
      "  current corpus its `created_at < WIPE_THRESHOLD` heuristic matches\n" +
      "  ~1,410,113 LEGITIMATE production rows (measured 2026-08-11; the\n" +
      "  git-log import carries genuine pre-threshold timestamps), and it\n" +
      "  rewrites the live append-only ledger IN PLACE via renameSync while\n" +
      "  the watermark daemon is appending to it.\n" +
      "\n" +
      "  Marking sets provenance.is_seed_row=true, which verify-cascade-\n" +
      "  correctness.mjs reads at dispatch as \"throwaway smoke, exclude\".\n" +
      "\n" +
      "  Run with --dry-run (always allowed, never writes) to see the real\n" +
      "  count. To proceed anyway, pass\n" +
      "  --i-understand-this-rewrites-the-live-ledger\n"
  );
  process.exit(4);
}

// DELIBERATE, GUARDED, ALLOWLISTED readFileSync — do NOT convert this to
// streamLedgerLines. It is left unrepaired on purpose: the refusal guard
// directly above is the interlock, and the string cap is the backstop behind
// it (see the WU-scripts-stringcap block at the top of this file). Converting
// it would remove the last thing standing between ~1.41M legitimate rows and
// a permanent is_seed_row=true branding. The second cap site at the
// outLines.join("\n") below sits behind the same guard.
const raw = readFileSync(ledgerPath, "utf8");
// Preserve final-newline convention: split on \n, count trailing empty as
// a marker of "ended with newline" so we re-emit exactly the same shape.
const endsWithNewline = raw.endsWith("\n");
const allLines = raw.split("\n");
// Drop the trailing empty token if file ended with \n.
const lines = endsWithNewline ? allLines.slice(0, -1) : allLines;

let updated = 0;
let unchanged = 0;
let nonMatching = 0;
let malformed = 0;
const updatedIds = [];

const outLines = lines.map((line) => {
  if (line.trim().length === 0) {
    // preserve blank lines verbatim (shouldn't occur in a well-formed ledger)
    return line;
  }
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    malformed++;
    return line; // pass through malformed lines unchanged
  }
  if (!matchesLegacySmokeHeuristic(r)) {
    nonMatching++;
    return line;
  }
  if (r.provenance && r.provenance.is_seed_row === true) {
    unchanged++; // idempotent
    return line;
  }
  // Apply marker. Preserve existing provenance fields.
  if (!r.provenance || typeof r.provenance !== "object") {
    r.provenance = {};
  }
  r.provenance.is_seed_row = true;
  updated++;
  if (updatedIds.length < 50) updatedIds.push(r.id || "?");
  return JSON.stringify(r);
});

const summary = {
  ledger: ledgerPath,
  total_lines: lines.length,
  updated,
  unchanged,
  non_matching: nonMatching,
  malformed,
  dry_run: DRY_RUN,
  updated_ids_first_50: updatedIds,
};

// (--dry-run is handled by the always-allowed streaming path above and exits
// before reaching this point, so no dry-run branch is needed here.)

if (updated === 0) {
  // No-op: idempotent re-run on already-marked ledger.
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.stderr.write(
    "backfill-seed-row-marker: no-op updated=0 (all matching rows already marked)\n"
  );
  process.exit(0);
}

const outBuf = outLines.join("\n") + (endsWithNewline ? "\n" : "");
const tmpPath = ledgerPath + ".tmp.r29p5-backfill." + process.pid;
try {
  writeFileSync(tmpPath, outBuf, "utf8");
  // fsync the tmp file before rename so the new bytes are durable.
  const fd = openSync(tmpPath, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmpPath, ledgerPath);
} catch (err) {
  process.stderr.write(
    "backfill-seed-row-marker: write failure: " + (err && err.message) + "\n"
  );
  process.exit(3);
}

process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.stderr.write(
  "backfill-seed-row-marker: updated=" + updated +
    " unchanged=" + unchanged + " non_matching=" + nonMatching + "\n"
);
process.exit(0);
