#!/usr/bin/env node
// backfill-from-sources.mjs — R25 operator-phase one-shot.
//
// Drives the watermark daemon's tickSourcesOnce() in a loop until all
// per-source cursors stop advancing OR until --max-rows is reached.
// Acquires the daemon's file-lock (watermark.js acquireLock, the SAME lock
// mainLoopStart:3589 and runOnceCli:3657 take) before the first tick and
// releases it in a finally, so this can never run concurrently with the
// loaded watermark launchd job. If the daemon holds the lock this script
// REFUSES to start and exits 3 rather than racing it.
//
// 2026-08-13: this header previously read "Acquires the daemon's file-lock
// via runOnceCli". That was FALSE — the file imported tickSourcesOnce and
// called it directly at the tick loop, never touching acquireLock, and
// runOnceCli is not imported here at all. An operator trusting the old
// header would have believed they were protected while driving the cascade
// against a live daemon with no mutual exclusion. The claim is now enforced
// by the code below rather than merely asserted here.
//
// Output: per-tick + per-source decision counts, sample of PROMOTE rows
// every ~5000 events, and a final summary table.

import { join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  tickSourcesOnce,
  listSourceLedgers,
  readSourceCursor,
  WATERMARK_STATE_DIR,
  acquireLock,
  releaseLock,
} from "../daemons/watermark.js";
import { memoryLedgerPath } from "../mcp/lib/config.js";
import { streamLedgerLinesWithOffset } from "../mcp/lib/synthesis/_ledger-stream.js";

const args = process.argv.slice(2);
const allSources = args.includes("--all-sources");
const maxRowsArg = args.find((a) => a.startsWith("--max-rows="));
const MAX_ROWS = maxRowsArg ? parseInt(maxRowsArg.split("=")[1], 10) : Infinity;
const sampleArg = args.find((a) => a.startsWith("--sample-every="));
const SAMPLE_EVERY = sampleArg ? parseInt(sampleArg.split("=")[1], 10) : 5000;

// LOUD FAILURE CHANNEL. streamLedgerLinesWithOffset never throws: an fs error
// is reported on counts.readError and the scan just stops. Without this
// breadcrumb an UNREADABLE ledger would report as `mem_lines: 0` on the stdout
// transcript — indistinguishable from an empty one, which is the exact
// conflation this defect class produces. The breadcrumb goes to STDERR so the
// stdout log shape is unchanged.
function noteMemReadError(fn, path, error) {
  process.stderr.write(
    JSON.stringify({ kind: "mem_read_error", fn, path, error }) + "\n",
  );
}

// memLineCount — RETENTION: O(1). The callback keeps NOTHING; only the
// primitive's own counter survives the call. The un-parsed variant is
// deliberate: JSON.parse on every row just to produce an integer is waste.
//
// PARITY with the pre-change body, which was exactly
//   readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0).length
// Measured this session on six shapes — trailing newline, no trailing newline,
// embedded blank lines, one mid-file unparseable line, a 0-byte file, a
// newlines-only file — counts.totalLines equalled that expression in all six.
// (Blank lines are not counted; an unterminated trailing line IS counted; an
// unparseable line is still a line.)
//
// There is no existsSync pre-check: the primitive returns zeros with
// readError === null on ENOENT, preserving the old missing-file -> 0 contract,
// while any OTHER errno sets readError. Re-adding existsSync would reintroduce
// the unreadable-vs-missing conflation the primitive was fixed to remove.
export function memLineCount() {
  const p = memoryLedgerPath();
  const counts = streamLedgerLinesWithOffset(p, () => {});
  if (counts.readError !== null) noteMemReadError("memLineCount", p, counts.readError);
  return counts.totalLines;
}

// memSample — RETENTION: O(n), n = the caller's argument. A fixed-size ring
// buffer of RAW line strings, never an array of all lines and never an array of
// all rows. The only call site passes 5.
//
// The ring holds RAW lines rather than parsed rows on purpose: the pre-change
// body took the last n NON-EMPTY lines and then dropped whichever of them
// failed JSON.parse, so a window containing a torn line yields n-1 rows. A ring
// over PARSED rows would silently pull an extra row forward and return n.
// Returns parsed row objects — the caller maps redactPii over them.
//
// The n <= 0 / non-finite guard is the one deliberate divergence from the old
// body: a non-finite n cannot be a fixed-size ring, and an unbounded request is
// exactly the retention this rewrite exists to prevent. The only call site
// passes 5.
export function memSample(n) {
  if (!Number.isFinite(n) || n <= 0) return [];
  const size = Math.floor(n);
  const p = memoryLedgerPath();
  const ring = new Array(size);
  let seen = 0;
  const counts = streamLedgerLinesWithOffset(p, (line) => {
    ring[seen % size] = line;
    seen += 1;
  });
  if (counts.readError !== null) noteMemReadError("memSample", p, counts.readError);
  // Unwind the ring in file order: the oldest retained line sits at
  // (seen - size) % size once more than `size` lines have gone by.
  const out = [];
  for (let i = Math.max(0, seen - size); i < seen; i++) {
    try { out.push(JSON.parse(ring[i % size])); } catch { /* skip */ }
  }
  return out;
}

function redactPii(row) {
  const content = String(row.content || "");
  // Coarse PII scrubbing for transcript output.
  let r = content
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<IP>")
    .replace(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, "<EMAIL>")
    .replace(/\b\+?\d[\d\s().-]{8,}\b/g, "<PHONE>")
    .replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "<APIKEY>")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "<HEX>")
    .replace(/AIza[0-9A-Za-z\-_]{30,}/g, "<APIKEY>");
  if (r.length > 200) r = r.slice(0, 200) + "...";
  return {
    id: row.id,
    source: row.source_refs && row.source_refs[0] && row.source_refs[0].source,
    salience: row.features && row.features.salience && row.features.salience.score,
    content: r,
  };
}

async function main() {
  // MUTUAL EXCLUSION WITH THE WATERMARK DAEMON.
  //
  // tickSourcesOnce advances the same per-source cursors under
  // storage/watermark-state/ that the loaded launchd job advances. Two writers
  // interleaving there double-promote rows and can move a cursor past events
  // the other never processed. acquireLock is the daemon's OWN lock (exported
  // from daemons/watermark.js), so taking it here is genuine exclusion, not a
  // second advisory scheme that only excludes other copies of this script.
  //
  // Exit 3 is distinct from the FATAL exit 1 below so an operator can tell
  // "refused, daemon is live" from "ran and threw".
  const acq = acquireLock();
  if (!acq.acquired) {
    process.stderr.write(
      "backfill: REFUSING to run — the watermark daemon holds the lock. " +
        "Unload it first:\n" +
        "  launchctl bootout gui/$(id -u)/com.user.memory-system.watermark\n",
    );
    process.exit(3);
  }
  if (acq.reclaimed_prior_pid != null) {
    process.stderr.write(
      "backfill: reclaimed a stale lock from dead pid " +
        acq.reclaimed_prior_pid +
        "\n",
    );
  }
  try {
    return await runBackfill();
  } finally {
    // Always release, including on throw, so a crashed backfill does not
    // wedge the daemon out of its own lock until the stale-lock TTL expires.
    try {
      releaseLock();
    } catch {
      // Release is best-effort: the daemon's stale-lock reclaim path recovers
      // a lock whose holder died. Never mask the original error with this one.
    }
  }
}

async function runBackfill() {
  const t0 = Date.now();
  const ledgers = listSourceLedgers();
  console.log(JSON.stringify({ kind: "backfill_start", ledgers: ledgers.map((l) => l.source), max_rows: MAX_ROWS === Infinity ? "inf" : MAX_ROWS, mem_before: memLineCount() }));

  const totals = {
    sources_walked: 0,
    rows_read: 0,
    rows_promoted: 0,
    rows_corroborated: 0,
    rows_dropped: 0,
    rows_errored: 0,
    sources_revoked_skipped: 0,
    ticks: 0,
  };
  let lastSampleMark = 0;

  while (true) {
    const r = await tickSourcesOnce({ now: undefined });
    totals.ticks += 1;
    totals.sources_walked += r.sources_walked;
    totals.rows_read += r.rows_read;
    totals.rows_promoted += r.rows_promoted;
    totals.rows_corroborated += r.rows_corroborated;
    totals.rows_dropped += r.rows_dropped;
    totals.rows_errored += r.rows_errored;
    totals.sources_revoked_skipped += r.sources_revoked_skipped;

    // Per-tick log.
    console.log(JSON.stringify({ kind: "tick", t: totals.ticks, delta: r, totals: { rows_read: totals.rows_read, promoted: totals.rows_promoted, corroborated: totals.rows_corroborated, dropped: totals.rows_dropped, errored: totals.rows_errored }, mem_lines: memLineCount() }));

    // Sampling.
    if (totals.rows_read - lastSampleMark >= SAMPLE_EVERY) {
      lastSampleMark = totals.rows_read;
      const sample = memSample(5).map(redactPii);
      console.log(JSON.stringify({ kind: "sample_promoted", at_rows_read: totals.rows_read, sample }));
    }

    if (r.rows_read === 0) {
      // Drained: no source produced rows this tick.
      console.log(JSON.stringify({ kind: "drained" }));
      break;
    }
    if (totals.rows_read >= MAX_ROWS) {
      console.log(JSON.stringify({ kind: "max_rows_reached", rows_read: totals.rows_read }));
      break;
    }
  }

  // Final per-source cursor summary.
  const perSource = {};
  for (const { source } of ledgers) {
    const cur = readSourceCursor(source);
    perSource[source] = cur ? { last_offset: cur.last_offset, last_event_id: cur.last_event_id, error_count: cur.error_count, last_appended_ts: cur.last_appended_ts } : null;
  }

  const memAfter = memLineCount();
  console.log(JSON.stringify({ kind: "backfill_done", elapsed_ms: Date.now() - t0, ticks: totals.ticks, totals, mem_before_to_after: { before: 3, after: memAfter }, per_source_cursors: perSource }));
}

// Main guard (house shape: mcp/scripts/build-ranking-eval-goldset.mjs) so
// memLineCount / memSample can be imported and unit-tested without executing
// the tick loop. Running the file directly is unchanged.
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
  main().catch((err) => {
    process.stderr.write("backfill: FATAL " + (err && err.stack ? err.stack : String(err)) + "\n");
    process.exit(1);
  });
}
