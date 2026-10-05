#!/usr/bin/env node
// verify-embed-work-set.mjs — e2 (embed-population hypergraph).
//
// WHY THIS EXISTS
// ---------------
// The drain's work set has always been a QUEUE (policy/re-embed-sweep.jsonl).
// e1 measured what the queue cannot see: 1,388,515 ledger row ids carry
// `features.embed_state === true` with no vector by any instrument. This gate
// answers the operator's real question — "what would a LEDGER-derived batch
// actually contain, and what does deriving it cost per tick?" — by DERIVING
// one batch and reporting the measurement, so the answer can be checked
// against the ledger by hand.
//
// WHAT IT DOES NOT DO
// -------------------
// It owns NO threshold, NO counter and NO campaign. Every number comes from
// `mcp/lib/recall/embed-work-set.js` (the verify-lexical-coverage-gate.mjs /
// bm25-coverage-probe.js split, copied deliberately). It does not spawn the
// repair child, does not touch the embed server on 8359, signals no daemon,
// and — unless `--commit` is passed — writes NOTHING AT ALL: no cursor, no
// tmp file, no log. `--commit` exists so an operator who has decided to run
// the derived drain can advance the cursor deliberately; it is not part of
// this gate's own run.
//
// READ-ONLY, STATED HONESTLY
// --------------------------
// This FILE contains one mutator call — `writeWorkSetCursor`, reached ONLY on
// `--commit`. Nothing else here can write. The stronger claim that nothing it
// imports TRANSITIVELY mutates would be FALSE and is not made:
// daemons/reembed-drain.mjs (reached through the work-set module, for the one
// definition of the `${id}#${k}` rule and the one atomic cursor writer)
// contains lock-file creation, cursor writes and log appends — but its CLI is
// behind an INVOKED_DIRECTLY guard, so importing it fires no drain, and the
// only symbols reachable on this path are `stripChunkSuffix` (pure) and
// `writeCursorFile` (called only under --commit).
//
// PROVEN OBSERVABLY, NOT ASSERTED (2026-08-19, live tree). A dev+ino+size+mtime
// witness was taken over ledgers/, indices/<model>/, storage/ and policy/
// immediately before and after a 30 s window containing one
// `--batch=1000 --batches=1` run with NO `--commit`, and compared against an
// IDLE CONTROL window of the same length in which nothing was run. The two
// windows moved the SAME two files and only those:
//   policy/distillation-state.lock  and  storage/queryd/queryd.lock
// — both live daemon heartbeats, present in the CONTROL, therefore attributable
// to the daemons and neither claimed nor blamed here. Nothing gate-attributable
// moved; no work-set cursor and no *.tmp.* entry was created under policy/; and
// `git status` over ledgers/ indices/ storage/ policy/ connectors/ was clean
// after. (A separate, longer window that included a 10.5 s full-ledger walk did
// show indices/<model>/vectors.jsonl GROW by 2,606,317 B — that is the REAL
// drain writing its own sidecar on its 900 s tick, which this script never
// opens: it reads hnsw.bin.meta.json only. Attributed to the daemon.)
//
// ABSENCE IS NEVER A VERDICT
// --------------------------
// There is no path to exit 0 that did not complete a derivation over a pinned
// prefix with a measured exclusion set. An unreadable ledger, an invalid
// cursor, a drifted pinned prefix, an unreadable or model-mismatched hnsw
// meta, a bad argument, `--help`, or any unexpected exception exits non-zero
// with `verdict:"refuse"` and NO work set in the payload. `--help`
// deliberately exits 2 for exactly that reason.
//
// e3 — THE QUEUE ARM (`--sweep=PATH`), ADDITIVE AND OFF BY DEFAULT
// ----------------------------------------------------------------
// e3's question #2 is "what does each mechanism cost per tick?", and the only
// honest way to answer it is to time BOTH on ONE footing — same process, same
// node, same clock, same counters. So this gate grew a comparison arm rather
// than a second CLI: with `--sweep=PATH` it additionally measures the SWEEP
// QUEUE (`policy/re-embed-sweep.jsonl` + its `.cursor`) and reports, under
// `sweep_queue`, the same four counters it already reports for the derivation
// — elapsed ms, bytes consumed, distinct ids, rows scanned — in three regimes:
//
//   idle_common_path   what the live drain actually does on a tick with
//                      nothing enqueued: ONE statSync of the queue plus ONE
//                      cursor read, and NO scan at all. This is the number the
//                      KEEP argument rests on.
//   batch_walk         `--batch` distinct ids from the stored cursor — the
//                      drain's `collectBatch` window.
//   whole_file_walk    the queue from byte 0 to eof: its whole id history and
//                      what a from-scratch re-read would cost.
//
// WITHOUT `--sweep` NOTHING CHANGES: no extra read, no extra key in the
// payload, and the exit codes below are untouched (arm `e2 (i)` in
// mcp/test/auto-drain.test.mjs pins that, and never passes `--sweep`).
//
// THE ARM RUNS AFTER THE DERIVATION, DELIBERATELY. The derivation must be
// timed under the same conditions a real tick gives it (cold process, nothing
// else having touched the page cache), so the queue arm is measured last and
// its own cost is reported separately as `cost.sweep_arm_ms`. `cost.elapsed_ms`
// stays what it has always been — whole-process wall time — so with the arm on
// it INCLUDES `sweep_arm_ms`; subtract it to compare against a `--sweep`-less
// run. `cost.hnsw_ms`, `cost.derive_ms_total` and every `batches[]` figure are
// measured on their own clocks and are not affected by the arm at all.
//
// A SECOND SPELLING, DECLARED RATHER THAN DENIED (invariant #4). The queue walk
// below (`walkSweepQueue`) re-states the byte-accounting and DISTINCTNESS rules
// of `collectBatch` in daemons/reembed-drain.mjs — a line is consumed only once
// its terminating "\n" is observed; ids land in a `Set` keyed on the RAW
// `fact_id` string (no `stripChunkSuffix`, because the drain does not strip
// there either); a malformed complete line is skipped but its bytes are still
// consumed. `collectBatch` is module-private, and EXPORTING it would be a
// non-comment edit to a file wired into a LOADED plist with StartInterval 900
// and RunAtLoad true — an edit that goes live unreviewed within 15 minutes.
// e3 forbids itself that. The duplication is therefore PINNED BY TEST instead
// of by symbol: arm `e3 (d)` drives a real sweep-mode `runDrain` and this
// walker over the SAME fixture and asserts they agree on offset, id set and
// malformed count. If they ever diverge that arm goes red.
//
// STILL READ-ONLY. The arm opens the queue and its cursor with readSync /
// readFileSync and nothing else; it never writes, and `--commit` remains the
// only write this file can perform (it touches the work-set cursor only, never
// the sweep cursor).
//
// USAGE
//   node mcp/scripts/verify-embed-work-set.mjs
//     [--model-version=ID] [--ledger=PATH] [--hnsw-meta=PATH] [--cursor=PATH]
//     [--batch=N] [--sample=N] [--batches=N] [--commit]
//     [--sweep=PATH] [--sweep-cursor=PATH]
//
//   --model-version=ID  default: ACTIVE_EMBED_MODEL_VERSION (lib/validation.js).
//                       The hnsw meta MUST be stamped with it or the run refuses.
//   --ledger=PATH       default: memoryLedgerPath() (lib/config.js)
//   --hnsw-meta=PATH    default: <MEMORY_ROOT>/indices/<model>/hnsw.bin.meta.json
//   --cursor=PATH       default: <POLICY_DIR>/re-embed-work-set.cursor. READ
//                       only (a missing file is offset 0, the honest start state).
//   --batch=N           candidates per derived batch (default 1000 — the
//                       installed drain's REEMBED_BATCH).
//   --batches=N         derive N successive batches in memory (default 1) to
//                       measure per-tick cost across a run. Still writes nothing.
//   --sample=N          ids printed in `id_sample` (default 10).
//   --commit            persist the final cursor {v, offset, pin}. THE ONLY
//                       write this file can perform, and it is off by default.
//   --sweep=PATH        e3 comparison arm, OFF unless given. Measures the sweep
//                       QUEUE on the same footing as the derivation. READ ONLY.
//   --sweep-cursor=PATH default: <POLICY_DIR>/re-embed-sweep.cursor. READ only,
//                       and only when --sweep is given.
//   --help              this text (exit 2 — exit 0 means "measured").
//
// EXIT CODES
//   0  permit — a derivation completed over a pinned prefix.
//   3  refuse — an INSTRUMENT INVARIANT broke (the census's own codes: hnsw
//               model mismatch, unsupported meta format, id_map/nextId
//               disagreement). Measured-grade, and still not a permit.
//   2  refuse — nothing measurable: bad arguments, --help, an unreadable
//               ledger, an invalid cursor, a DRIFTED pinned prefix, an
//               EXPLICITLY REQUESTED `--sweep` queue that could not be read
//               (`work_set_sweep_unreadable` — a comparison the operator asked
//               for and did not get is a refusal, never a permit carrying a
//               silent zero), or any other failure.
//
// Output: exactly ONE line of JSON on stdout in EVERY case, including
// refusals, so a refusal is as auditable as a permit.

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import { POLICY_DIR, memoryLedgerPath } from "../lib/config.js";
import { ACTIVE_EMBED_MODEL_VERSION } from "../lib/validation.js";
// The hnsw meta default is the DRAIN's derivation (dirname of the sidecar it
// measures), not a second `indices/<model>/` path built here: one site,
// tree-wide, and the r7 path-constructor census (T15 in
// mcp/test/rebuild-target-retarget.test.mjs) stays closed.
import { defaultHnswMetaPath } from "../../daemons/reembed-drain.mjs";
import { INSTRUMENT_INVARIANT_CODES } from "../lib/recall/embed-population-census.js";
import {
  WORK_SET_VERSION,
  deriveWorkSetBatch,
  readWorkSetCursor,
  readWorkSetExclusions,
  writeWorkSetCursor,
} from "../lib/recall/embed-work-set.js";

// The installed com.user.memory-system.reembed-drain.plist StartInterval, read
// from that file on 2026-08-18. Used ONLY to report the measured elapsed time
// as a fraction of the tick it would run inside.
const DRAIN_START_INTERVAL_SECONDS = 900;

const USAGE = [
  "verify-embed-work-set.mjs — derive one ledger work-set batch and report its measured cost.",
  "",
  "  --model-version=ID  default: ACTIVE_EMBED_MODEL_VERSION",
  "  --ledger=PATH       default: memoryLedgerPath()",
  "  --hnsw-meta=PATH    default: <MEMORY_ROOT>/indices/<model>/hnsw.bin.meta.json",
  "  --cursor=PATH       default: <POLICY_DIR>/re-embed-work-set.cursor (READ only)",
  "  --batch=N           candidates per batch (default 1000)",
  "  --batches=N         successive batches to derive in memory (default 1)",
  "  --sample=N          ids printed in id_sample (default 10)",
  "  --commit            persist the final cursor — the ONLY write this file can do",
  "  --sweep=PATH        e3 arm: also measure the sweep QUEUE (READ only, off by default)",
  "  --sweep-cursor=PATH default: <POLICY_DIR>/re-embed-sweep.cursor (READ only)",
  "  --help              this text (exit 2 — exit 0 means 'measured')",
  "",
  "Exit: 0 permit | 3 refuse (instrument invariant broke) | 2 refuse (nothing measured).",
].join("\n");

function parsePositive(val, name) {
  const n = Number(val);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: { code: "work_set_bad_arguments", message: `${name} must be a positive integer, got ${JSON.stringify(val)}` } };
  }
  return { value: n };
}

function parseArgs(argv) {
  let modelVersion = null;
  let ledgerPath = null;
  let hnswMetaPath = null;
  let cursorPath = null;
  let batch = 1000;
  let batches = 1;
  let sample = 10;
  let commit = false;
  // e3 arm. `null` means OFF — the arm is opt-in and its absence must leave
  // every other code path byte-identical.
  let sweepPath = null;
  let sweepCursorPath = null;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { error: { code: "work_set_help", message: "usage requested" }, usage: true };
    }
    if (arg === "--commit") {
      commit = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const val = eq === -1 ? null : arg.slice(eq + 1);
    if (val === null || val.length === 0) {
      return {
        error: {
          code: "work_set_bad_arguments",
          message: `argument ${JSON.stringify(arg)} must be of the form --flag=value`,
        },
        usage: true,
      };
    }
    switch (key) {
      case "--model-version": modelVersion = val; break;
      case "--ledger": ledgerPath = val; break;
      case "--hnsw-meta": hnswMetaPath = val; break;
      case "--cursor": cursorPath = val; break;
      case "--sweep": sweepPath = val; break;
      case "--sweep-cursor": sweepCursorPath = val; break;
      case "--batch": {
        const p = parsePositive(val, "--batch");
        if (p.error) return { error: p.error, usage: true };
        batch = p.value;
        break;
      }
      case "--batches": {
        const p = parsePositive(val, "--batches");
        if (p.error) return { error: p.error, usage: true };
        batches = p.value;
        break;
      }
      case "--sample": {
        const p = parsePositive(val, "--sample");
        if (p.error) return { error: p.error, usage: true };
        sample = p.value;
        break;
      }
      default:
        return {
          error: { code: "work_set_bad_arguments", message: `unknown argument ${JSON.stringify(key)}` },
          usage: true,
        };
    }
  }

  const model = modelVersion === null ? ACTIVE_EMBED_MODEL_VERSION : modelVersion;
  return {
    error: null,
    modelVersion: model,
    ledgerPath: ledgerPath === null ? memoryLedgerPath() : ledgerPath,
    hnswMetaPath:
      hnswMetaPath === null
        ? defaultHnswMetaPath({ ...process.env, ACTIVE_EMBED_MODEL_VERSION: model })
        : hnswMetaPath,
    cursorPath: cursorPath === null ? join(POLICY_DIR, "re-embed-work-set.cursor") : cursorPath,
    batch,
    batches,
    sample,
    commit,
    // OFF unless `--sweep` was given. `--sweep-cursor` alone does NOT turn the
    // arm on: the queue's cursor without the queue measures nothing.
    sweepPath,
    sweepCursorPath:
      sweepCursorPath === null ? join(POLICY_DIR, "re-embed-sweep.cursor") : sweepCursorPath,
  };
}

// ---------------------------------------------------------------------------
// e3 QUEUE ARM — the sweep mechanism, measured on the derivation's footing.
//
// See the "THE QUEUE ARM" block in the header for why these two functions
// re-state `collectBatch`'s rules instead of importing them, and for the test
// arm that pins the two spellings to each other.
// ---------------------------------------------------------------------------

/**
 * The sweep cursor as the LIVE DRAIN reads it: JSON `{offset}`, a missing file
 * is offset 0 (the honest start state), and a corrupt one is offset 0 too —
 * `readCursorOffset` in daemons/reembed-drain.mjs treats an unparseable cursor
 * as absent rather than throwing, and this reports what the drain would do, not
 * what a stricter reader might prefer. `present` and `parsed` are reported
 * separately so "absent" is never confused with "corrupt, read as 0".
 */
function readSweepCursorState(cursorPath) {
  let raw;
  try {
    raw = readFileSync(cursorPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { present: false, parsed: false, offset: 0 };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    const n = parsed && typeof parsed === "object" ? Number(parsed.offset) : NaN;
    if (Number.isInteger(n) && n >= 0) return { present: true, parsed: true, offset: n };
  } catch { /* corrupt -> the drain reads it as 0 */ }
  return { present: true, parsed: false, offset: 0 };
}

const SWEEP_READ_CHUNK_BYTES = 65536;

/**
 * Walk the sweep queue from `startOffset`, gathering up to `batch` DISTINCT
 * `fact_id` values, and report exactly what the derivation reports: bytes
 * consumed, rows scanned, distinct ids, elapsed ms.
 *
 * `batch === Infinity` walks to eof (the whole-file regime). Memory is bounded
 * by one 64 KiB read buffer plus the id set — never the file.
 */
function walkSweepQueue({ sweepPath, startOffset, batch }) {
  const t0 = process.hrtime.bigint();
  const ids = new Set();
  let offset = startOffset;
  let rowsScanned = 0;
  let skippedMalformed = 0;
  let reachedEof = false;

  const fd = openSync(sweepPath, "r");
  try {
    const buf = Buffer.allocUnsafe(SWEEP_READ_CHUNK_BYTES);
    let remainder = Buffer.alloc(0);
    let readAt = startOffset;
    let filled = false;
    for (;;) {
      const n = readSync(fd, buf, 0, SWEEP_READ_CHUNK_BYTES, readAt);
      if (n === 0) { reachedEof = true; break; }
      readAt += n;
      const chunk = buf.subarray(0, n);
      remainder = remainder.length === 0 ? Buffer.from(chunk) : Buffer.concat([remainder, chunk]);
      let nl;
      while ((nl = remainder.indexOf(0x0a)) !== -1) {
        const lineBuf = remainder.subarray(0, nl);
        const lineBytes = nl + 1; // the "\n" is part of the consumed line
        remainder = remainder.subarray(nl + 1);
        const line = lineBuf.toString("utf8");
        rowsScanned += 1;
        let factId = null;
        if (line.trim().length > 0) {
          try {
            const o = JSON.parse(line);
            if (o && typeof o.fact_id === "string" && o.fact_id.length > 0) factId = o.fact_id;
          } catch { /* malformed */ }
        }
        if (factId === null) {
          if (line.trim().length > 0) skippedMalformed += 1;
        } else {
          ids.add(factId);
        }
        offset += lineBytes;
        if (ids.size >= batch) { filled = true; break; }
      }
      if (filled) break;
    }
  } finally {
    closeSync(fd);
  }

  return {
    from_offset: startOffset,
    next_offset: offset,
    bytes_scanned: offset - startOffset,
    rows_scanned: rowsScanned,
    distinct_ids: ids.size,
    skipped_malformed: skippedMalformed,
    reached_eof: reachedEof,
    elapsed_ms: Number(process.hrtime.bigint() - t0) / 1e6,
  };
}

/**
 * The whole queue arm. Throws a `work_set_sweep_unreadable`-coded error — which
 * the caller's existing catch turns into exit 2 — rather than reporting a zero
 * for an instrument it could not read (invariant #1).
 */
function measureSweepQueue({ sweepPath, cursorPath, batch }) {
  let st;
  let cursor;
  const tIdle = process.hrtime.bigint();
  try {
    // THE IDLE COMMON PATH, in full: this is every byte of I/O the installed
    // drain performs on a tick whose cursor already sits at eof. Timed as one
    // unit because the drain performs it as one.
    st = statSync(sweepPath);
    cursor = readSweepCursorState(cursorPath);
  } catch (err) {
    const e = new Error(
      `sweep queue not measurable at ${sweepPath} / ${cursorPath}: ` +
        (err && err.message ? err.message : String(err)),
    );
    e.code = "work_set_sweep_unreadable";
    throw e;
  }
  const idleMs = Number(process.hrtime.bigint() - tIdle) / 1e6;

  let batchWalk;
  let wholeWalk;
  try {
    batchWalk = walkSweepQueue({ sweepPath, startOffset: Math.min(cursor.offset, st.size), batch });
    wholeWalk = walkSweepQueue({ sweepPath, startOffset: 0, batch: Infinity });
  } catch (err) {
    const e = new Error(
      `sweep queue walk failed at ${sweepPath}: ${err && err.message ? err.message : String(err)}`,
    );
    e.code = "work_set_sweep_unreadable";
    throw e;
  }

  return {
    measured: true,
    sweep_path: sweepPath,
    cursor_path: cursorPath,
    // IDENTITY, not name (invariant #5) — so a later comparison can prove it is
    // the same file rather than the same string.
    sweep_file: { dev: st.dev, ino: st.ino, size: st.size, mtime_ms: st.mtimeMs },
    id_key:
      "the RAW `fact_id` string, in a Set — the drain's collectBatch does not " +
      "strip `#k` there, and this arm reports what the drain does",
    idle_common_path: {
      what: "one statSync of the queue + one cursor read; NO scan. The live drain's tick when nothing is enqueued.",
      elapsed_ms: idleMs,
      cursor_present: cursor.present,
      cursor_parsed: cursor.parsed,
      cursor_offset: cursor.offset,
      sweep_size: st.size,
      bytes_behind: Math.max(0, st.size - Math.min(cursor.offset, st.size)),
      rows_scanned: 0,
      bytes_scanned: 0,
      distinct_ids: 0,
    },
    batch_walk: { batch_size_requested: batch, ...batchWalk },
    whole_file_walk: { batch_size_requested: null, ...wholeWalk },
  };
}

/**
 * The envelope every exit path emits. Contract constants are stamped even on a
 * refusal (a reader must not have to guess the scale); MEASURED fields are
 * OMITTED, never nulled, when nothing was derived — so an un-measured envelope
 * cannot be misread as a measurement of zero.
 */
function baseEnvelope({ verdict, args, errorCode, error }) {
  return {
    verdict,
    measured: false,
    work_set_version: WORK_SET_VERSION,
    model_version: args === null ? null : args.modelVersion,
    ledger_path: args === null ? null : args.ledgerPath,
    hnsw_meta_path: args === null ? null : args.hnswMetaPath,
    cursor_path: args === null ? null : args.cursorPath,
    candidate_predicate:
      "features.embed_state === true (readRowEmbedInputs, the census's own symbol) AND the id " +
      "is NOT an EXACT BARE entry of the hnsw id_map (readHnswMembership().bareEntryIds). " +
      "Chunked parents (`${id}#k` entries only) STAY candidates: presence is not completeness.",
    committed: false,
    error_code: errorCode,
    error,
  };
}

function emit(envelope, code) {
  process.stdout.write(JSON.stringify(envelope) + "\n");
  process.exitCode = code;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error !== null) {
    if (parsed.usage === true) process.stderr.write(USAGE + "\n");
    emit(baseEnvelope({ verdict: "refuse", args: null, errorCode: parsed.error.code, error: parsed.error.message }), 2);
    return;
  }

  let peakRss = process.memoryUsage().rss;
  const rssSamples = Object.create(null);
  const sampleRss = (phase) => {
    const rss = process.memoryUsage().rss;
    rssSamples[phase] = rss;
    if (rss > peakRss) peakRss = rss;
    return rss;
  };
  const rssStart = peakRss;

  let payload;
  try {
    const stored = readWorkSetCursor(parsed.cursorPath);
    sampleRss("after_cursor");

    const tHnsw = process.hrtime.bigint();
    const exclusions = readWorkSetExclusions({
      hnswMetaPath: parsed.hnswMetaPath,
      modelVersion: parsed.modelVersion,
    });
    const hnswMs = Number(process.hrtime.bigint() - tHnsw) / 1e6;
    sampleRss("after_hnsw");

    const batchesOut = [];
    let cursor = stored.offset;
    let pin = stored.pin;
    let ids = [];
    let totalDeriveMs = 0;
    let totalRows = 0;
    let totalBytes = 0;
    for (let i = 0; i < parsed.batches; i += 1) {
      const d = deriveWorkSetBatch({
        ledgerPath: parsed.ledgerPath,
        cursor,
        batch: parsed.batch,
        excludeIds: exclusions.excludeIds,
        pin,
      });
      batchesOut.push({
        ids_count: d.ids.length,
        cursor_before: d.fromOffset,
        cursor_after: d.nextOffset,
        rows_scanned: d.rowsScanned,
        candidate_rows: d.candidateRows,
        // candidate_rows counts ROWS matching the predicate; ids_count counts
        // distinct FACTS. duplicate_rows is exactly their difference minus the
        // exclusions, and without it the operator cannot tell the two apart.
        duplicate_rows: d.duplicateRows,
        excluded_already_embedded: d.excluded,
        bytes_scanned: d.bytesScanned,
        reached_eof: d.reachedEof,
        derive_ms: d.deriveMs,
        pin_source: d.pinSource,
      });
      ids = d.ids;
      cursor = d.nextOffset;
      pin = d.nextPin;
      totalDeriveMs += d.deriveMs;
      totalRows += d.rowsScanned;
      totalBytes += d.bytesScanned;
      sampleRss(`after_batch_${i}`);
      if (d.reachedEof) break;
    }

    let committed = false;
    if (parsed.commit) {
      writeWorkSetCursor(parsed.cursorPath, { offset: cursor, pin });
      committed = true;
    }

    // e3 QUEUE ARM — LAST, so the derivation above was timed under a real
    // tick's conditions and nothing this arm reads warmed a page for it.
    let sweepQueue = null;
    let sweepArmMs = null;
    if (parsed.sweepPath !== null) {
      const tSweep = process.hrtime.bigint();
      sweepQueue = measureSweepQueue({
        sweepPath: parsed.sweepPath,
        cursorPath: parsed.sweepCursorPath,
        batch: parsed.batch,
      });
      sweepArmMs = Number(process.hrtime.bigint() - tSweep) / 1e6;
      sampleRss("after_sweep_arm");
    }
    sampleRss("end");

    payload = {
      ...baseEnvelope({ verdict: "permit", args: parsed, errorCode: null, error: null }),
      measured: true,
      committed,
      cursor_present_before: stored.present,
      cursor_before: stored.offset,
      cursor_after: cursor,
      cursor_advance_bytes: cursor - stored.offset,
      batch_size_requested: parsed.batch,
      batches_derived: batchesOut.length,
      batches: batchesOut,
      last_batch_ids_count: ids.length,
      id_sample: ids.slice(0, parsed.sample),
      exclusion_set: {
        source: "hnsw id_map BARE entries (readHnswMembership().bareEntryIds)",
        size: exclusions.excludeIds.size,
        id_map_entries: exclusions.instrument.id_map_entries,
        id_map_distinct_bare_ids: exclusions.instrument.id_map_distinct_bare_ids,
        id_map_chunk_entries: exclusions.instrument.id_map_chunk_entries,
        id_map_chunked_parent_ids: exclusions.instrument.id_map_chunked_parent_ids,
        tombstones: exclusions.instrument.tombstones,
        read_ms: hnswMs,
        not_excluded_note:
          "OVER-INCLUSION, both arms, bounded not asserted: P-EMBEDDED-SIDECAR-ONLY (e1 bucket " +
          "27,072) and P-INLINE-ONLY (e1 bucket 287 = 284 embedding_4096 + 3 embedding_mrl_768) " +
          "are DELIBERATELY NOT excluded. Excluding the first costs a 12.4 GB vectors.jsonl scan " +
          "per tick (the r6-2 trap); the second is an inline array on the row itself. Both are " +
          "UPPER BOUNDS, never equalities: e1's bucket cascade is inHnsw > inSidecar > inline > " +
          "embed_state, so it never read embed_state for either bucket and how many of them are " +
          "also derived candidates is not in its payload. UNDER-inclusion is reported too and is " +
          "NOT fixable here: P-EMBED-STATE-FALSE-NO-VECTOR (57, exact) physically needs a vector " +
          "and is invisible to a flag-keyed predicate. All ids that do slip through route via the " +
          "child's own done-filter and the drain's CHILD_ALREADY_EMBEDDED full-scan proof: wasted " +
          "work, never wrong work.",
      },
      // OMITTED, never nulled, when the arm did not run — an absent key cannot
      // be misread as a queue that measured zero.
      ...(sweepQueue === null ? {} : { sweep_queue: sweepQueue }),
      cost: {
        hnsw_ms: hnswMs,
        derive_ms_total: totalDeriveMs,
        // Same rule: present only when the arm ran. `elapsed_ms` below is
        // whole-process and INCLUDES this; subtract it to compare a
        // `--sweep` run against a `--sweep`-less one.
        ...(sweepArmMs === null ? {} : { sweep_arm_ms: sweepArmMs }),
        rows_scanned_total: totalRows,
        bytes_scanned_total: totalBytes,
        elapsed_ms: null, // filled below
        peak_rss_bytes: null,
        rss_start_bytes: rssStart,
        rss_samples: rssSamples,
        drain_start_interval_seconds: DRAIN_START_INTERVAL_SECONDS,
        fraction_of_tick: null,
      },
    };
  } catch (err) {
    const code = err && typeof err.code === "string" ? err.code : "work_set_unexpected_error";
    process.stderr.write(
      `verify-embed-work-set: derivation failed (${code}): ${err && err.message ? err.message : String(err)}\n`,
    );
    // An instrument invariant that broke is a MEASURED-grade refusal (3),
    // reported distinctly from an unmeasurable one (2). Neither is a permit.
    emit(
      baseEnvelope({ verdict: "refuse", args: parsed, errorCode: code, error: err && err.message ? err.message : String(err) }),
      INSTRUMENT_INVARIANT_CODES.includes(code) ? 3 : 2,
    );
    return;
  }

  const elapsedMs = Number(process.hrtime.bigint() - START_NS) / 1e6;
  payload.cost.elapsed_ms = elapsedMs;
  payload.cost.peak_rss_bytes = peakRss;
  payload.cost.fraction_of_tick = elapsedMs / (DRAIN_START_INTERVAL_SECONDS * 1000);
  emit(payload, 0);
}

const START_NS = process.hrtime.bigint();
await main();
