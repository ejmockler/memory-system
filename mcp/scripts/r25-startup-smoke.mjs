// r25-startup-smoke.mjs
//
// R25.5 STARTUP SMOKE: run the watermark cascade for one in-process tick
// against the REAL <MEMORY_ROOT>/storage/sources/ ledgers, then
// PRINT a per-source would-promote / would-corroborate / would-drop count.
// Writes ABSOLUTELY NOTHING to production memory.jsonl, recall.jsonl, or
// the production watermark-state cursors.
//
// Intended use: Phase C operator runs this BEFORE wiping the production
// watermark-state cursors and invoking the real backfill driver. If the
// per-source breakdown matches the design's empirical estimates, the fix
// landed cleanly. If everything reports 0 PROMOTE again, the cascade is
// still broken — operator does NOT wipe cursors.
//
// Discipline:
//   - Diverts STORAGE_BASE_DIR + LEDGERS_BASE_DIR to a one-shot mkdtempSync
//     scratch tree. The real source ledgers are read from the production
//     path by symlinking them into the scratch tree's storage/sources/.
//     Production cursors stay untouched.
//   - GEMINI_API_KEY is force-unset; embedding is degraded so the smoke
//     runs offline. The promote path still appends to (scratch) memory.jsonl
//     so the counters are real, but production memory.jsonl is untouched.
//   - Exit 0 even when one or more sources report 0 PROMOTE — the operator
//     reads the output and decides; non-zero exit is reserved for a hard
//     crash of the cascade.
//
// Run: node mcp/scripts/r25-startup-smoke.mjs

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const PROD_SOURCES_DIR = join(REPO_ROOT, "storage", "sources");

if (!existsSync(PROD_SOURCES_DIR)) {
  console.error(`r25-startup-smoke: production sources dir missing: ${PROD_SOURCES_DIR}`);
  process.exit(2);
}

// Scratch tree — hermetic. Symlink production source ledgers in.
const SCRATCH = mkdtempSync(join(tmpdir(), "r25-startup-smoke-"));
const SCRATCH_ROOT = join(SCRATCH, "memory-system");
const POLICY_DIR = join(SCRATCH_ROOT, "policy");
const STORAGE_DIR = join(SCRATCH_ROOT, "storage");
const LEDGERS_DIR = join(SCRATCH_ROOT, "ledgers");
const INDICES_DIR = join(SCRATCH_ROOT, "indices");
const SOURCES_DIR = join(STORAGE_DIR, "sources");
const WATERMARK_STATE_DIR = join(STORAGE_DIR, "watermark-state");

// R32.1: removed QUEUE_DIR + queue subdir mkdirSync entries. The
// conversational-distillation queue (storage/distillation-queue/) was
// retired in R32; tickSourcesOnce — the cascade entry this smoke exercises
// — has no queue surface. See kb/legacy-archive.md.

for (const d of [
  SCRATCH_ROOT,
  POLICY_DIR,
  STORAGE_DIR,
  LEDGERS_DIR,
  INDICES_DIR,
  SOURCES_DIR,
  WATERMARK_STATE_DIR,
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

const sourceLedgers = readdirSync(PROD_SOURCES_DIR).filter((n) => n.endsWith(".jsonl"));
for (const name of sourceLedgers) {
  try {
    symlinkSync(join(PROD_SOURCES_DIR, name), join(SOURCES_DIR, name));
  } catch (e) {
    console.error(`symlink failed: ${name} -> ${e.message}`);
  }
}

process.env.MEMORY_ROOT = SCRATCH_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;
delete process.env.GEMINI_API_KEY;

const cleanup = () => {
  try {
    rmSync(SCRATCH, { recursive: true, force: true });
  } catch {
    // best-effort
  }
};
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

// ---------------------------------------------------------------------------
// Take per-source sizes BEFORE the tick. We don't read every row count
// (would be 100k+ I/O); we just print the ledger sizes the cascade scanned.
// ---------------------------------------------------------------------------
const beforeSizes = new Map();
for (const name of sourceLedgers) {
  const source = name.replace(/\.jsonl$/, "");
  try {
    beforeSizes.set(source, statSync(join(SOURCES_DIR, name)).size);
  } catch {
    beforeSizes.set(source, -1);
  }
}

// ---------------------------------------------------------------------------
// One in-process tick. tickSourcesOnce mutates the scratch tree; nothing
// touches the production memory ledger or production cursors.
// ---------------------------------------------------------------------------
const wm = await import("../../daemons/watermark.js");

console.log("r25-startup-smoke: starting tick (scratch root = " + SCRATCH_ROOT + ")");
const startedMs = Date.now();
let result = null;
let err = null;
try {
  result = await wm.tickSourcesOnce({ now: Date.now() });
} catch (e) {
  err = e;
}
const elapsedMs = Date.now() - startedMs;

if (err != null) {
  console.error(`r25-startup-smoke: tickSourcesOnce THREW ${err.name}: ${err.message}`);
  console.error(err.stack || "(no stack)");
  process.exit(3);
}

// ---------------------------------------------------------------------------
// Per-source breakdown via scratch cursors + tick counters.
// tickSourcesOnce returns aggregate counters; per-source we read each
// cursor's last_offset and infer rows_read by comparing to startOffset (0
// on fresh smoke). We separately report from the aggregate.
// ---------------------------------------------------------------------------
console.log(`r25-startup-smoke: tick complete in ${elapsedMs}ms`);
console.log(`  aggregate: rows_read=${result.rows_read} promoted=${result.rows_promoted} corroborated=${result.rows_corroborated} dropped=${result.rows_dropped} errored=${result.rows_errored} sources_walked=${result.sources_walked} sources_revoked_skipped=${result.sources_revoked_skipped}`);

console.log("");
console.log("per-source cursor advance (would-promote signal):");
for (const name of sourceLedgers) {
  const source = name.replace(/\.jsonl$/, "");
  const cursorPath = join(WATERMARK_STATE_DIR, `${source}.json`);
  let cursorTxt = "absent";
  if (existsSync(cursorPath)) {
    try {
      const { readFileSync } = await import("node:fs");
      const obj = JSON.parse(readFileSync(cursorPath, "utf8"));
      cursorTxt = `last_offset=${obj.last_offset} error_count=${obj.error_count || 0}`;
    } catch {
      cursorTxt = "unreadable";
    }
  }
  const size = beforeSizes.get(source);
  console.log(`  ${source.padEnd(20)} size=${size}  cursor=${cursorTxt}`);
}

// Count how many fact rows actually landed in scratch memory.jsonl. This is
// the would-promote count the operator wants.
const SCRATCH_MEMORY = join(LEDGERS_DIR, "memory.jsonl");
let scratchPromotedRows = 0;
const promotedBySource = new Map();
if (existsSync(SCRATCH_MEMORY)) {
  const { readFileSync } = await import("node:fs");
  const body = readFileSync(SCRATCH_MEMORY, "utf8");
  for (const line of body.split("\n")) {
    if (line === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    scratchPromotedRows += 1;
    if (row && Array.isArray(row.source_refs)) {
      for (const ref of row.source_refs) {
        if (ref && typeof ref.source === "string") {
          promotedBySource.set(ref.source, (promotedBySource.get(ref.source) || 0) + 1);
        }
      }
    } else if (row && typeof row.source === "string") {
      promotedBySource.set(row.source, (promotedBySource.get(row.source) || 0) + 1);
    }
  }
}

console.log("");
console.log(`per-source would-promote breakdown (scratch memory.jsonl rows = ${scratchPromotedRows}):`);
const allSources = Array.from(
  new Set([...promotedBySource.keys(), ...sourceLedgers.map((n) => n.replace(/\.jsonl$/, ""))]),
).sort();
for (const s of allSources) {
  const cnt = promotedBySource.get(s) || 0;
  console.log(`  ${s.padEnd(20)} would-promote=${cnt}`);
}

console.log("");
console.log(
  scratchPromotedRows === 0
    ? "r25-startup-smoke: WARNING — 0 rows promoted across all sources. Cascade fix not effective. DO NOT WIPE CURSORS."
    : `r25-startup-smoke: OK — ${scratchPromotedRows} rows would promote on a clean tick. Safe to wipe production cursors and run real backfill.`,
);
