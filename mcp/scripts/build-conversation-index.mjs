#!/usr/bin/env node
// build-conversation-index.mjs — WU-backward-conversation-index.
//
// One-shot, operator-initiated rebuild of the BACKWARD conversation index: a
// DERIVED projection fact_id -> { conversation_id, thread_label } built by
// joining each promoted fact's source_refs[].source_msg_id to its retained,
// append-only source row (storage/sources/<source>.jsonl) and deriving the
// SAME `daemon:thread:<bucket_key>` descriptor the daemon thread-aggregator
// emits (it reuses thread-aggregator.extractThreadKey, so forward + backward
// labels are byte-identical).
//
// WHY (operator-facing):
//   context-prefix.js historically saw 0% thread coverage on the EXISTING
//   corpus because provenance.conversation_id is null on facts promoted before
//   the forward-stamp fix. This index reconstructs the conversation label for
//   those historical facts WITHOUT mutating any fact row (thesis #1). Wiring
//   the index into the contextual-BM25 rebuild then gives those facts a real
//   thread label in their context prefix.
//
// CADENCE:
//   - Hand-run by an operator after the forward-stamp ships, to backfill the
//     pre-existing corpus.
//   - Safe to re-run any time: the cache invalidates on memory.jsonl mtime +
//     size, and the projection is rebuilt from the (append-only) ledgers.
//
// USAGE:
//   node mcp/scripts/build-conversation-index.mjs [--dry-run] [--cache=PATH] [--ledger=PATH]
//
//   --dry-run    : build in memory + print stats, but do NOT write the cache.
//   --cache=PATH : override the cache file path. Defaults to
//                  $STORAGE_DIR/conversation-index.cache.json.
//   --ledger=PATH: override the memory ledger path (default memoryLedgerPath()).
//
// OUTPUT (one JSON line to stdout):
//   {
//     ledger_path, cache_path, wrote_cache,
//     facts_seen, facts_joined, coverage_pct,
//     by_source: { <source>: { seen, joined } },
//     duration_ms
//   }
//
// EXIT CODES:
//   0 — build succeeded (or --dry-run completed).
//   1 — fatal error (unreadable ledger path arg, persist failure).

import { join } from "node:path";

import { STORAGE_DIR, memoryLedgerPath } from "../lib/config.js";
import {
  rebuildConversationIndex,
} from "../lib/synthesis/conversation-index.js";

function parseArgs(argv) {
  const opts = { dryRun: false, cachePath: undefined, ledgerPath: undefined };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") opts.dryRun = true;
    else if (a.startsWith("--cache=")) opts.cachePath = a.slice("--cache=".length);
    else if (a.startsWith("--ledger=")) opts.ledgerPath = a.slice("--ledger=".length);
    else if (a === "--help" || a === "-h") {
      process.stderr.write(
        "usage: build-conversation-index.mjs [--dry-run] [--cache=PATH] [--ledger=PATH]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`build-conversation-index: unknown arg ${a}\n`);
      process.exit(2);
    }
  }
  return opts;
}

async function main() {
  const t0 = Date.now();
  const opts = parseArgs(process.argv);
  const ledgerPath =
    typeof opts.ledgerPath === "string" && opts.ledgerPath.length > 0
      ? opts.ledgerPath
      : memoryLedgerPath();
  const cachePath =
    typeof opts.cachePath === "string" && opts.cachePath.length > 0
      ? opts.cachePath
      : join(STORAGE_DIR, "conversation-index.cache.json");

  let index;
  try {
    index = await rebuildConversationIndex({
      ledgerPath,
      // dry-run: do NOT persist (pass no cachePath to the rebuild).
      cachePath: opts.dryRun ? undefined : cachePath,
    });
  } catch (err) {
    process.stderr.write(
      `build-conversation-index: build failed: ${
        err && err.message ? err.message : String(err)
      }\n`,
    );
    process.exit(1);
  }

  const seen = index.stats?.facts_seen ?? 0;
  const joined = index.stats?.facts_joined ?? 0;
  const coverage = seen > 0 ? (joined / seen) * 100 : 0;

  const out = {
    ledger_path: ledgerPath,
    cache_path: opts.dryRun ? null : cachePath,
    wrote_cache: !opts.dryRun,
    facts_seen: seen,
    facts_joined: joined,
    coverage_pct: Math.round(coverage * 100) / 100,
    by_source: index.stats?.sources ?? {},
    duration_ms: Date.now() - t0,
  };
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
}

main();
