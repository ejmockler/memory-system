#!/usr/bin/env node
// heal-index-manifest.mjs — S3g INCIDENT REMEDIATION: stale/refused index
// generation manifests on the production trees.
//
// WHAT HAPPENED (verified live 2026-07-16). Both production model-version
// trees served EMPTY memory_recall from every fresh-spawned (new-code)
// process:
//   - qwen3-embedding-8b-fp16: an un-cutover OLD-CODE writer (un-restarted
//     watermark daemon / pre-L1 zombie MCP flush) rewrote bm25.json +
//     hnsw.bin at their fixed paths AFTER the generation-0 manifest was
//     adopted, so verifyGenerationMembers refused the ACTIVE generation
//     (index_manifest_member_mismatch) and the refusal cascade ended EMPTY
//     (gen-0, no retained fallback). Fail-closed by design — the manifest
//     is simply STALE relative to good current bytes.
//   - gemini-embedding-001: the generation VERIFIED but the legacy format-1
//     linear-scan hnsw.bin crashed HnswIndex._loadLegacyMonolithic on the
//     native runtime ("Cannot read properties of undefined (reading
//     'set')"). That is a CODE bug, fixed in hnsw-index.js
//     (_storeLoadedVector) — run this script only with the fix landed, or
//     the re-adopted manifest binds the same bytes and deserialize just
//     crashes again.
//
// WHAT THIS SCRIPT DOES.
//   1. PROBE each production tree with the real loader (loadIndices) from a
//      cold cache: healthy ⇔ bm25 docs > 0 AND hnsw size > 0.
//   2. HEAL only trees that fail the probe, by deleting ONLY derived,
//      rebuildable artifacts:
//        - index-manifest.json          (the stale generation binding)
//        - index-digest-cache.json      (verified-digest sidecar)
//        - bm25.gen-N.json / hnsw.gen-N.bin / hnsw.gen-N.bin.meta.json
//          (retention snapshots, naming per index-manifest.js
//          retentionMemberNames)
//      MEMBER BYTES AND LEDGERS ARE NEVER TOUCHED: bm25.json, hnsw.bin,
//      hnsw.bin.meta.json, vectors.jsonl, embeddings-sidecar.jsonl, WAL and
//      pending journals, and everything under ledgers/ are read-only to
//      this script (a protected-name allowlist enforces it on top of the
//      derived-name match). The next cold load re-adopts generation 0
//      binding the CURRENT bytes (checksum-only; adoptGeneration0 seeds the
//      digest cache so per-session spawns stay stat-level).
//   3. RE-PROBE and require non-empty on both trees; print a before/after
//      report.
//
// RECURRENCE: until the operator cutover kills every pre-S3 writer, any
// old-writer flush rewrites members at the fixed paths with NO manifest
// rebind and re-breaks the adopted manifest. This script only WARNS about
// that (no process is ever killed/restarted here); the cutover plan lives
// in the workspace FINDINGS.
//
// Usage:
//   node scripts/heal-index-manifest.mjs               # probe → heal → re-probe
//   node scripts/heal-index-manifest.mjs --probe-only  # probe both trees;
//       exit 0 only when BOTH load non-empty (never deletes anything)
//
// IMPORTABILITY: the executable probe/heal body runs ONLY under direct
// invocation (real-path is-main check at the foot of the file). Importing
// this module for a test — e.g.
// `import { PROTECTED } from "./heal-index-manifest.mjs"` — triggers ZERO
// probe/heal I/O, so the allowlist can be asserted hermetically.

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { MEMORY_ROOT } from "../lib/config.js";
import { loadIndices, _resetCaches } from "../lib/recall/index-cache.js";
import {
  MANIFEST_FILE,
  DIGEST_CACHE_FILE,
} from "../lib/recall/index-manifest.js";
import {
  WAL_FILE,
  WAL_CURSOR_FILE,
  WAL_QUARANTINE_NOTE_FILE,
  WAL_CORRUPT_STRIKE_FILE,
} from "../lib/recall/index-wal.js";

// The two production trees the 2026-07-16 incident took down. (The
// gemini-embedding-001-contextual tree is bm25-only/experimental and has no
// recall SLO — deliberately out of scope.)
const PRODUCTION_TREES = ["qwen3-embedding-8b-fp16", "gemini-embedding-001"];

// Derived, rebuildable artifacts — the ONLY names this script may unlink.
// Retention-snapshot naming per index-manifest.js retentionMemberNames():
// bm25.gen-N.json, hnsw.gen-N.bin, hnsw.gen-N.bin.meta.json.
const RETENTION_RE = /^(bm25|hnsw)\.gen-\d+\./;

// Belt-and-suspenders: never unlink these even if a matcher above ever
// regresses. Member bytes, sidecars, journals, WAL(+quarantine) are
// read-only to this script.
//
// SINGLE SOURCE OF TRUTH: the WAL-family names DERIVE from the index-wal.js
// constants so this allowlist can never silently drift from the real
// filenames again. (S3g: a hardcoded "index-wal.applied-cursor.json" never
// matched the real WAL_CURSOR_FILE="index-wal.applied.json", so the intended
// hard stop on the live applied-cursor was inert.)
export const PROTECTED = new Set([
  "bm25.json",
  "hnsw.bin",
  "hnsw.bin.meta.json",
  "vectors.jsonl",
  "embeddings-sidecar.jsonl",
  "pending-adds.jsonl",
  WAL_FILE,
  WAL_CURSOR_FILE,
  WAL_QUARANTINE_NOTE_FILE,
  WAL_CORRUPT_STRIKE_FILE,
]);

const indicesDir = join(MEMORY_ROOT, "indices");

// ---------------------------------------------------------------------------
// Probe: cold loadIndices through the real loader; healthy ⇔ bm25 docs > 0
// AND hnsw size > 0. Refusal/deserialize breadcrumbs (loadIndices writes
// structured lines to stderr) are captured for the report while still being
// passed through.
// ---------------------------------------------------------------------------
function probeTree(mv) {
  _resetCaches(); // cold: no warm cache — same as a fresh process spawn
  const breadcrumbs = [];
  const realErr = console.error;
  console.error = (...args) => {
    const s = String(args[0]);
    if (/REFUSING index generation|failed to deserialize|unreadable index manifest|adoption failed/.test(s)) {
      breadcrumbs.push(s);
    }
    return realErr.apply(console, args);
  };
  const t0 = Date.now();
  let bm25Docs = 0;
  let hnswSize = 0;
  let err = null;
  try {
    const { bm25, hnsw } = loadIndices(mv);
    bm25Docs = bm25._docLen instanceof Map ? bm25._docLen.size : 0;
    hnswSize = hnsw.size();
  } catch (e) {
    err = e.message;
  } finally {
    console.error = realErr;
  }
  _resetCaches(); // drop the multi-GB objects; every probe stays cold
  return {
    mv,
    // Healthy means the ACTIVE generation actually served: any refusal
    // breadcrumb marks the tree unhealthy even when WAL replay leaves a
    // token doc count on the empty fallback (observed live 2026-07-17:
    // refused qwen3 probed bm25_docs=1 hnsw_size=1 and passed the old
    // >0 check, so heal skipped the tree it was built to fix).
    ok: err == null && bm25Docs > 0 && hnswSize > 0 && breadcrumbs.length === 0,
    bm25_docs: bm25Docs,
    hnsw_size: hnswSize,
    load_ms: Date.now() - t0,
    error: err,
    breadcrumbs,
  };
}

// ---------------------------------------------------------------------------
// Heal: unlink ONLY the derived artifacts listed above.
// ---------------------------------------------------------------------------
function healTree(mv) {
  const dir = join(indicesDir, mv);
  const removed = [];
  for (const f of readdirSync(dir)) {
    const derived =
      f === MANIFEST_FILE || f === DIGEST_CACHE_FILE || RETENTION_RE.test(f);
    if (!derived) continue;
    if (PROTECTED.has(f)) continue; // can never match, kept as a hard stop
    unlinkSync(join(dir, f));
    removed.push(f);
  }
  return removed;
}

function fmt(p) {
  return (
    `${p.ok ? "OK " : "FAIL"}  bm25_docs=${p.bm25_docs} hnsw_size=${p.hnsw_size} ` +
    `load_ms=${p.load_ms}${p.error != null ? ` error=${JSON.stringify(p.error)}` : ""}`
  );
}

function printProbe(label, p) {
  console.log(`[${label}] ${p.mv}: ${fmt(p)}`);
  for (const b of p.breadcrumbs) console.log(`    breadcrumb: ${b}`);
}

// ---------------------------------------------------------------------------
// Executable body — probe → heal → re-probe. Runs ONLY under direct
// invocation so importing PROTECTED is side-effect-free (no probe/heal I/O).
// --probe-only never unlinks anything.
// ---------------------------------------------------------------------------
function main() {
  const probeOnly = process.argv.includes("--probe-only");

  console.log(
    `heal-index-manifest: root=${MEMORY_ROOT} mode=${probeOnly ? "probe-only" : "heal"}`,
  );

  // REG (memperf) fix: `missing` was hoisted across loop iterations, so once
  // ANY tree was absent every LATER tree was also reported missing (first tree
  // absent + second present reported both). Judge each tree with its own flag;
  // the aggregate any-missing exit(2) is unchanged.
  let missing = false;
  for (const mv of PRODUCTION_TREES) {
    let treeMissing = false;
    try {
      if (!statSync(join(indicesDir, mv)).isDirectory()) treeMissing = true;
    } catch {
      treeMissing = true;
    }
    if (treeMissing) {
      missing = true;
      console.error(`heal-index-manifest: missing tree ${mv}`);
    }
  }
  if (missing) process.exit(2);

  const before = PRODUCTION_TREES.map((mv) => probeTree(mv));
  for (const p of before) printProbe("before", p);

  if (probeOnly) {
    const allOk = before.every((p) => p.ok);
    console.log(
      allOk
        ? "probe-only: BOTH production trees load non-empty."
        : "probe-only: at least one production tree refuses/serves empty — run without --probe-only to heal.",
    );
    process.exit(allOk ? 0 : 1);
  }

  // Heal ONLY the trees that failed the probe.
  const after = [];
  for (const p of before) {
    if (p.ok) {
      console.log(`[heal] ${p.mv}: healthy — nothing removed`);
      after.push(p);
      continue;
    }
    const removed = healTree(p.mv);
    console.log(
      `[heal] ${p.mv}: removed derived artifacts: ${removed.length > 0 ? removed.join(", ") : "(none present)"}`,
    );
    console.log(
      `[heal] ${p.mv}: re-probing (re-adoption checksums the current members; multi-GB trees take a while)...`,
    );
    after.push(probeTree(p.mv));
  }
  for (const p of after) printProbe("after", p);

  console.log("");
  console.log("RECURRENCE WARNING: until the operator cutover kills every");
  console.log("pre-S3 writer (un-restarted watermark daemon / zombie MCP");
  console.log("server), any old-writer flush rewrites index members at their");
  console.log("fixed paths WITHOUT a manifest rebind and re-breaks the adopted");
  console.log("manifest (cold loads refuse → empty recall; memory_health shows");
  console.log("index_generation_refused). Re-run this script if that happens.");
  console.log("The cutover plan lives in the workspace FINDINGS. This script");
  console.log("never kills or restarts processes.");

  const allOk = after.every((p) => p.ok);
  if (!allOk) {
    console.error(
      "heal-index-manifest: HEAL DID NOT RESTORE ALL TREES — see the after report above.",
    );
  }
  process.exit(allOk ? 0 : 1);
}

// Main-module check that survives spaces and symlinks in the invocation path:
// compare real filesystem paths, never a hand-built file:// string.
// (The runtime's own is-main flag is not available on the declared Node floor.)
const INVOKED_DIRECTLY = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (INVOKED_DIRECTLY) main();
