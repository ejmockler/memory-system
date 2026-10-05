#!/usr/bin/env node
// catchup-equivalence.mjs — C1 gate 1: the projection-path catch-up source rows
// are BYTE-IDENTICAL to the full-stream path, proven over the REAL source
// ledgers (read-only) with per-source PINNED prefixes.
//
// METHOD (per registry source, everything under a throwaway temp root):
//   1. Pin an S1 checkpoint of the REAL ledger (captureCheckpoint — O_RDONLY).
//      The pinned newline-safe prefix [0, eof) is the corpus: live daemons may
//      append while this script runs, so both paths are run over the SAME
//      pinned bytes, copied once into a temp root laid out like production
//      (storage/sources/<key>.jsonl).
//   2. Split the pinned prefix at a newline boundary near 90%: copy the head,
//      build the projection there via the REAL rebuild entrypoint
//      (rebuildProjectionForSource — the same code the server runs), then
//      append the remaining ~10% as the DELTA. The projection path therefore
//      exercises verifyPrefix + readAppended + the delta fold over REAL rows.
//   3. For each query-window combo, serve three ways and byte-diff the rows
//      JSON: full stream (projection:false), disk-tier projection (+delta
//      fold), and memory-tier projection (a warmed second call).
//   4. Non-vacuity: for the default window the projection path MUST actually
//      have served (mode "projection"; disk tier with a non-zero delta when a
//      split exists) — a gate that silently full-streamed everywhere proves
//      nothing and FAILS.
//   5. Read-only witness: after each source, verifyPrefix(realLedger, pinned)
//      must still hold — this run rewrote nothing of the real prefix.
//
// RED-RUN ISOLATION: CATCHUP_EQUIV_RED=1 deliberately perturbs one projection
// output before the diff — the script MUST then exit non-zero. Run it once
// before trusting a green run.
//
// Exit codes: 0 all sources byte-identical + non-vacuous; 1 any diff/vacuous
// gate; 2 harness error.

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MEMORY_ROOT } from "../lib/config.js";
import {
  ADAPTER_REGISTRY,
  loadSourcesFromLedgers,
} from "../lib/messaging/catchup.js";
import {
  captureCheckpoint,
  verifyPrefix,
} from "../lib/synthesis/ledger-checkpoint.js";
import {
  projectionFilePath,
  rebuildProjectionForSource,
  _awaitPendingProjectionPersists,
  _clearProjectionMemoryCacheForTests,
  _peekProjectionDiagnosticsForTests,
} from "../lib/messaging/envelope-projection.js";

const RED_RUN = process.env.CATCHUP_EQUIV_RED === "1";
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

// The query windows to prove equivalence under. since_ms/limit are QUERY-TIME
// parameters (never baked into the stored projection) — the combos exercise
// the no-window default, the production catch-up shape, and a wide window.
const COMBOS = [
  {},
  { since_ms: 7 * DAY, limit: 15 },
  { limit: 500 },
];

// ---------------------------------------------------------------------------
// Byte-range helpers (all O_RDONLY on the source side).
// ---------------------------------------------------------------------------

const COPY_CHUNK = 4 * 1024 * 1024;

function copyRange(srcPath, dstPath, start, end, { append = false } = {}) {
  if (end <= start) {
    if (!append) writeFileSync(dstPath, "");
    return;
  }
  const fd = openSync(srcPath, "r");
  try {
    if (!append) writeFileSync(dstPath, "");
    const buf = Buffer.alloc(Math.min(COPY_CHUNK, end - start));
    let pos = start;
    while (pos < end) {
      const want = Math.min(buf.length, end - pos);
      const n = readSync(fd, buf, 0, want, pos);
      if (n <= 0) throw new Error(`short read copying ${srcPath} at ${pos}`);
      appendFileSync(dstPath, buf.subarray(0, n));
      pos += n;
    }
  } finally {
    closeSync(fd);
  }
}

// Last newline at or before `limit`; returns the byte just past it (a valid
// line-boundary split point), or 0 when none exists.
function newlineSafeCut(path, limit) {
  if (limit <= 0) return 0;
  const fd = openSync(path, "r");
  try {
    const WINDOW = 64 * 1024;
    const buf = Buffer.alloc(WINDOW);
    let end = limit;
    while (end > 0) {
      const start = Math.max(0, end - WINDOW);
      const want = end - start;
      const n = readSync(fd, buf, 0, want, start);
      if (n !== want) return 0;
      const idx = buf.subarray(0, want).lastIndexOf(0x0a);
      if (idx >= 0) return start + idx + 1;
      end = start;
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) {
      return { at: i, a: a.slice(Math.max(0, i - 40), i + 40), b: b.slice(Math.max(0, i - 40), i + 40) };
    }
  }
  return { at: n, a: `len=${a.length}`, b: `len=${b.length}` };
}

// ---------------------------------------------------------------------------
// Per-source equivalence run.
// ---------------------------------------------------------------------------

const report = { version: "catchup-equivalence@1", now: NOW, red_run: RED_RUN, sources: {} };
let failures = 0;
let projectionExercised = 0;
let redApplied = false;

function runLoad(rootDir, key, combo, projection) {
  const out = loadSourcesFromLedgers(ADAPTER_REGISTRY, {
    root: rootDir,
    now: NOW,
    platforms: [key],
    ...(projection ? {} : { projection: false }),
    ...combo,
  });
  return JSON.stringify(out[key] ?? null);
}

for (const [key, entry] of ADAPTER_REGISTRY.entries()) {
  const realPath = join(MEMORY_ROOT, entry.ledgerPath);
  const pinned = captureCheckpoint(realPath);
  if (pinned === null || pinned.eof === 0) {
    report.sources[key] = { skipped: true, reason: "ledger missing or empty" };
    continue;
  }
  const src = {
    pinned_eof: pinned.eof,
    pinned_size: pinned.size,
    combos: [],
    read_only_witness: null,
  };
  report.sources[key] = src;

  const T = mkdtempSync(join(tmpdir(), "catchup-equiv-"));
  try {
    mkdirSync(join(T, "storage", "sources"), { recursive: true });
    const tLedger = join(T, "storage", "sources", `${key}.jsonl`);
    const cut = newlineSafeCut(realPath, Math.floor(pinned.eof * 0.9));
    src.split_at = cut;

    // Head copy + pinned projection build (the REAL rebuild entrypoint).
    copyRange(realPath, tLedger, 0, cut);
    _clearProjectionMemoryCacheForTests();
    let pinnedProjectionBytes = null;
    if (cut > 0) {
      const r = rebuildProjectionForSource({ root: T, sourceKey: key, ledgerAbsPath: tLedger });
      src.rebuild = r;
      if (!r.ok) {
        failures += 1;
        src.fail = `pinned projection rebuild failed: ${r.reason}`;
        continue;
      }
      pinnedProjectionBytes = readFileSync(projectionFilePath(T, key));
    }
    // Append the delta: the temp ledger is now EXACTLY the pinned prefix.
    copyRange(realPath, tLedger, cut, pinned.eof, { append: true });

    for (let ci = 0; ci < COMBOS.length; ci += 1) {
      const combo = COMBOS[ci];
      const comboRes = { combo, pass: true };
      src.combos.push(comboRes);

      const fullJson = runLoad(T, key, combo, false);

      // Disk tier + delta fold: restore the pinned projection file, drop the
      // memory tier, serve once.
      let diskJson = null;
      let memJson = null;
      if (pinnedProjectionBytes !== null) {
        await _awaitPendingProjectionPersists();
        writeFileSync(projectionFilePath(T, key), pinnedProjectionBytes, { mode: 0o600 });
        _clearProjectionMemoryCacheForTests();
        diskJson = runLoad(T, key, combo, true);
        comboRes.disk_mode = _peekProjectionDiagnosticsForTests().serves[key] ?? null;

        // Memory tier: restore + warm, then measure the second (warm) serve.
        await _awaitPendingProjectionPersists();
        writeFileSync(projectionFilePath(T, key), pinnedProjectionBytes, { mode: 0o600 });
        _clearProjectionMemoryCacheForTests();
        runLoad(T, key, combo, true); // warm
        memJson = runLoad(T, key, combo, true);
        comboRes.mem_mode = _peekProjectionDiagnosticsForTests().serves[key] ?? null;
        await _awaitPendingProjectionPersists();

        if (RED_RUN && !redApplied) {
          memJson = `${memJson}RED`;
          redApplied = true;
          comboRes.red_perturbed = true;
        }

        if (diskJson !== fullJson) {
          comboRes.pass = false;
          comboRes.disk_diff = firstDiff(fullJson, diskJson);
        }
        if (memJson !== fullJson) {
          comboRes.pass = false;
          comboRes.mem_diff = firstDiff(fullJson, memJson);
        }
        if (
          ci === 0 &&
          (comboRes.disk_mode?.mode !== "projection" || comboRes.mem_mode?.mode !== "projection")
        ) {
          comboRes.pass = false;
          comboRes.vacuous = "default window did not exercise the projection path";
        }
        if (ci === 0 && comboRes.pass) projectionExercised += 1;
      } else {
        comboRes.note = "no newline-safe split (tiny ledger) — full-stream only";
      }
      if (!comboRes.pass) failures += 1;
    }

    // Read-only witness over the REAL ledger: the pinned prefix must still
    // verify (this script never opened it for writing; appends by live
    // daemons do not disturb the prefix).
    const w = verifyPrefix(realPath, pinned);
    src.read_only_witness = w;
    if (!w.ok) {
      failures += 1;
      src.fail = `read-only witness failed: ${w.reason}`;
    }
  } catch (e) {
    failures += 1;
    src.fail = `harness error: ${e && e.message ? e.message : String(e)}`;
  } finally {
    await _awaitPendingProjectionPersists();
    _clearProjectionMemoryCacheForTests();
    rmSync(T, { recursive: true, force: true });
  }
}

if (projectionExercised === 0) {
  failures += 1;
  report.vacuous = "no source exercised the projection path — the gate proved nothing";
}
report.projection_exercised_sources = projectionExercised;
report.failures = failures;
report.pass = failures === 0;

console.log(JSON.stringify(report, null, 2));
if (report.pass) {
  console.log(
    `\nEQUIVALENCE PASSED: projection-path rows byte-identical to full-stream over pinned prefixes (${projectionExercised} sources exercised)`,
  );
  process.exit(0);
} else {
  console.error(`\nEQUIVALENCE FAILED: ${failures} failing check(s) — see report above`);
  process.exit(1);
}
