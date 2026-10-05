#!/usr/bin/env node
// run-feature-backfill.mjs — operator CLI for W3-CCS BACKFILL.
// (F-CCS-BACKFILL-engine — spec §5.1)
//
// Walks a memory.jsonl ledger; for each fact whose features are missing
// or stale, the engine appends ONE policy.feature_backfill row carrying
// the W2-W6 extractor stack outputs. Re-running with no extractor
// changes is a no-op (byte-equal overlay → skip emission). Safe to
// invoke from cron or a post-deploy hook.
//
// USAGE
//   node mcp/scripts/run-feature-backfill.mjs
//   node mcp/scripts/run-feature-backfill.mjs --ledger /path/to/memory.jsonl
//   node mcp/scripts/run-feature-backfill.mjs --since-version 2
//   node mcp/scripts/run-feature-backfill.mjs --fact-ids mem_F1,mem_F2
//   node mcp/scripts/run-feature-backfill.mjs --dry-run
//
// DISCIPLINE
//   - This CLI is NOT a writer. It imports runBackfill() from the engine
//     (which is the sole producer of policy.feature_backfill rows under
//     mcp/lib/). The CLI MUST NOT contain the literal "feature_backfill"
//     anywhere (single-producer CI guard).
//   - Non-zero exit only on fatal config errors. Individual fact failures
//     are logged inside the engine and counted in `errors`.

import { resolve } from "node:path";

import { runBackfill, BACKFILL_CAPS } from "../lib/synthesis/feature-backfill.js";

function parseArgs(argv) {
  const opts = {
    ledgerPath: null,
    sinceVersion: undefined,
    factIds: undefined,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ledger" || a === "--ledger-path") {
      opts.ledgerPath = argv[++i];
    } else if (a === "--since-version") {
      const v = Number(argv[++i]);
      if (Number.isFinite(v)) opts.sinceVersion = v;
    } else if (a === "--fact-ids") {
      const csv = argv[++i] || "";
      opts.factIds = csv
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (a === "--dry-run") {
      opts.dryRun = true;
    } else if (a === "--help" || a === "-h") {
      opts.help = true;
    }
  }
  return opts;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node mcp/scripts/run-feature-backfill.mjs [options]",
      "",
      "Options:",
      "  --ledger <path>           Path to memory.jsonl (default: env MEMORY_LEDGER_PATH)",
      "  --since-version <n>       Re-stamp facts whose backfill_version < n",
      "  --fact-ids <a,b,c>        Restrict to comma-separated fact ids",
      "  --dry-run                 Compute overlays but do not write to ledger",
      "  --help, -h                Show this help",
      "",
      `Engine version: ${BACKFILL_CAPS.FEATURE_BACKFILL_VERSION}; per-tick BATCH_SIZE=${BACKFILL_CAPS.BATCH_SIZE}.`,
      "",
    ].join("\n"),
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  const ledgerPath =
    opts.ledgerPath != null
      ? resolve(opts.ledgerPath)
      : process.env.MEMORY_LEDGER_PATH || null;
  if (ledgerPath == null || ledgerPath.length === 0) {
    process.stderr.write(
      "run-feature-backfill: --ledger or MEMORY_LEDGER_PATH is required\n",
    );
    process.exit(2);
  }
  const result = await runBackfill({
    ledgerPath,
    sinceVersion: opts.sinceVersion,
    factIds: opts.factIds,
    dryRun: opts.dryRun,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  // Engine errors are per-fact and do not flip exit code; only fatal
  // config errors (handled above) exit non-zero.
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(
    `run-feature-backfill: unexpected failure: ${err && err.message ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
