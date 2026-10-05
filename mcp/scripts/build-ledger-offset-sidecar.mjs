#!/usr/bin/env node
// build-ledger-offset-sidecar.mjs — WU-recall-latency-fix.
//
// One-shot, operator/Gate-initiated build of the LEDGER BYTE-OFFSET SIDECAR
// (`ledgers/memory.jsonl.offsets`). The sidecar maps memory_id -> {offset,len}
// so recall candidate resolution SEEKS each wanted row by byte offset instead of
// streaming the whole 1.8 GB ledger per query.
//
// WHY THIS EXISTS (measured grounding plan):
//   loadLedgerRowsByIds streamed the entire 1.8 GB ledger per query (~5.2s, 83%
//   of recall latency) just to materialize a few hundred candidate rows. The
//   offset index turns that into K random-access reads. The in-process index is
//   built lazily on the first recall (one cold full scan ~3s, then ~17ms/query
//   warm). This sidecar persists that index to disk so a FRESH recall process
//   skips even the cold scan and is fast from its very first query.
//
// SAFETY (thesis #1 — never mutate fact rows; indices are derived projections):
//   - The ledger is APPEND-ONLY, so every row's byte offset is stable. The
//     sidecar is a pure DERIVED projection of the ledger bytes; recall ALWAYS
//     re-reads + re-verifies the actual ledger bytes at the recorded offset (the
//     parsed row.id must equal the wanted id) before use. A stale/wrong offset
//     never returns a wrong row — recall falls back to a scoped stream for it.
//   - This script writes ONLY the sidecar (atomic tmp+rename, mode 0600). It
//     NEVER touches memory.jsonl or the indices/ tree.
//
// HOW THE GATE REBUILDS THE LIVE SIDECAR:
//   node mcp/scripts/build-ledger-offset-sidecar.mjs
//   (run after a bulk ledger edit / recovery, or on a cadence; the daemon may
//   also invoke it on an idle tick. It is idempotent: re-running rebuilds the
//   sidecar to match the current ledger size+mtime. The sidecar is OPTIONAL —
//   if absent or stale, recall builds the index in-process and tail-merges, so
//   correctness never depends on the sidecar being present or fresh.)
//
// USAGE:
//   node mcp/scripts/build-ledger-offset-sidecar.mjs [--dry-run]
//     --dry-run : build the in-memory index + report counts, do NOT write disk.
//
// OUTPUT (one JSON line to stdout):
//   { ledger_path, sidecar_path, rows_indexed, ledger_bytes, wrote_sidecar,
//     entries_written, duration_ms }
//
// EXIT CODES:
//   0 — built (or --dry-run completed).
//   1 — ledger missing, or sidecar write failed (the OLD sidecar, if any, is
//       intact via the atomic tmp+rename; recall continues unaffected).

import { existsSync, statSync } from "node:fs";
import { memoryLedgerPath } from "../lib/config.js";
import {
  buildOffsetIndex,
  writeOffsetSidecar,
  offsetSidecarPath,
} from "../lib/recall/ledger-offset-index.js";

function parseArgs(argv) {
  const opts = { dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/build-ledger-offset-sidecar.mjs [--dry-run]",
      );
      process.exit(0);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv);
  const t0 = Date.now();
  const ledgerPath = memoryLedgerPath();
  const sidecarPath = offsetSidecarPath(ledgerPath);

  if (!existsSync(ledgerPath)) {
    console.error(
      JSON.stringify({ error: "ledger_missing", ledger_path: ledgerPath }),
    );
    process.exit(1);
  }

  const index = buildOffsetIndex(ledgerPath);
  if (index == null) {
    console.error(
      JSON.stringify({ error: "index_build_failed", ledger_path: ledgerPath }),
    );
    process.exit(1);
  }
  const ledgerBytes = (() => {
    try {
      return statSync(ledgerPath).size;
    } catch {
      return -1;
    }
  })();

  if (opts.dryRun) {
    console.log(
      JSON.stringify({
        ledger_path: ledgerPath,
        sidecar_path: sidecarPath,
        rows_indexed: index.byId.size,
        ledger_bytes: ledgerBytes,
        wrote_sidecar: false,
        entries_written: 0,
        duration_ms: Date.now() - t0,
      }),
    );
    process.exit(0);
  }

  const written = writeOffsetSidecar(ledgerPath);
  if (written < 0) {
    console.error(
      JSON.stringify({
        error: "sidecar_write_failed",
        ledger_path: ledgerPath,
        sidecar_path: sidecarPath,
      }),
    );
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      ledger_path: ledgerPath,
      sidecar_path: sidecarPath,
      rows_indexed: index.byId.size,
      ledger_bytes: ledgerBytes,
      wrote_sidecar: true,
      entries_written: written,
      duration_ms: Date.now() - t0,
    }),
  );
  process.exit(0);
}

main();
