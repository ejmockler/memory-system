// watermark-breaker-tick-abort.test.mjs — regression battery for the Jul 2026
// per-source circuit-breaker + cascade-load defect cluster in
// daemons/watermark.js:
//
//   F-WM-BREAKER-RESET (DEFECT 2): error_count used to be lifetime-cumulative,
//     so transient error drips eventually muted a source forever. A tick that
//     processes >= 1 row with zero errors must now reset error_count to 0.
//
//   F-WM-AUTOMUTE-SIGNAL (DEFECT 1): a source at error_count >=
//     WATERMARK_SOURCE_ERROR_THRESHOLD used to be skipped with a bare
//     `continue` — no stderr, no policy event (git-log sat silently muted for
//     a month). The mute must now emit ONE stderr line + ONE
//     policy.daemon.source_auto_muted event per mute window, re-armed when
//     the breaker resets.
//
//   F-WM-CASCADE-LOAD-TICK-ABORT + F-WM-CASCADE-LOAD-RETRY (DEFECT 3): a
//     cascade module-load failure used to (a) be memoised as a REJECTED
//     promise for the process lifetime and (b) surface as per-row
//     decision:"ERROR", bumping error_count AND advancing the cursor past
//     rows that were never judged. A load failure must now abort the source
//     walk for the tick (cursors pinned, error_count untouched, one stderr
//     line) and the next tick must RETRY the import.
//
// HERMETIC: tmp MEMORY_ROOT set BEFORE any import touches config.js (the
// cascade-inline-local-embed.test.mjs idiom). Production ledgers / policy /
// cursors are never touched. The load failure is injected via the
// _setCascadeLoadFailureForTest seam; clean ticks run either a stage0-DROP
// mods override (_setCascadeModsForTest) or — for the retry test — the REAL
// cascade modules with MEMORY_TEST_STUB_EMBEDDER=1 (no network).
//
// node:test + node:assert/strict.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Hermetic env — MUST be set BEFORE any dynamic import touches config.js.
// MEMORY_TEST_STUB_EMBEDDER keeps the real-module retry tick off the network
// (deterministic 4096-dim stub inside loadCascadeModulesLazy).
// -----------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-wm-breaker-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.POLICY_BASE_DIR = join(TMP_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TMP_ROOT, "ledgers");
process.env.HOOKS_BASE_DIR = join(TMP_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(TMP_ROOT, "daemons");
process.env.MEMORY_TEST_STUB_EMBEDDER = "1";

const WATERMARK_STATE_DIR = join(process.env.STORAGE_BASE_DIR, "watermark-state");
const SOURCES_DIR = join(process.env.STORAGE_BASE_DIR, "sources");
for (const d of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  process.env.HOOKS_BASE_DIR,
  process.env.DAEMONS_BASE_DIR,
  WATERMARK_STATE_DIR,
  SOURCES_DIR,
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

const watermarkMod = await import("../../../daemons/watermark.js");

const NOW = new Date("2026-07-03T00:00:00Z");
const THRESHOLD = watermarkMod.WATERMARK_SOURCE_ERROR_THRESHOLD;

// -----------------------------------------------------------------------------
// Helpers.
// -----------------------------------------------------------------------------

function sourceLedgerPath(source) {
  return join(SOURCES_DIR, `${source}.jsonl`);
}

function makeRow(source, i) {
  return {
    id: `ulid_${source}_${String(i).padStart(6, "0")}`,
    ts: new Date(NOW.getTime() + i * 1000).toISOString(),
    source,
    source_msg_id: `${source}-${i}`,
    parties: ["user"],
    raw_content: { text: `${source} synthetic row ${i}` },
    attachments: [],
    source_policy: { deletion_semantics: "full_excise", consent_basis: "first_party" },
    checksum: `cksum-${source}-${i}`,
  };
}

function seedRows(source, count) {
  const lines = [];
  for (let i = 0; i < count; i++) lines.push(JSON.stringify(makeRow(source, i)));
  const path = sourceLedgerPath(source);
  writeFileSync(path, lines.join("\n") + "\n");
  return statSync(path).size;
}

function writeCursor(source, overrides = {}) {
  const cursor = { ...watermarkMod.emptyCursor(source, { now: NOW }), ...overrides };
  watermarkMod.writeSourceCursorAtomic(cursor, { now: NOW });
  return cursor;
}

function readCursor(source) {
  return watermarkMod.readSourceCursor(source);
}

// Stage0-DROP mods override: every row hard-drops at Stage-0, so a clean
// tick needs neither the salience layer nor an embedder. prefetchEmbeddings
// short-circuits (no localEmbedBatch / normalizeSourceEvent functions).
function dropAllMods() {
  return {
    stage0: { dispatch: () => ({ decision: "DROP", reason: "test_drop_all" }) },
    salience: null,
    promote: null,
    normalizeSourceEvent: null,
    localEmbedBatch: null,
    indexCache: null,
  };
}

// Capture everything written to process.stderr while fn runs.
async function withCapturedStderr(fn) {
  const orig = process.stderr.write;
  let captured = "";
  process.stderr.write = (chunk, ...rest) => {
    captured += typeof chunk === "string" ? chunk : String(chunk);
    // Swallow: keep test output clean; callers assert on `captured`.
    void rest;
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return captured;
}

// Scan the hermetic policy dir for events matching a predicate.
function readPolicyEvents(predicate) {
  const dir = process.env.POLICY_BASE_DIR;
  if (!existsSync(dir)) return [];
  const matches = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("policy-events-") || !name.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (line === "") continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (predicate(row)) matches.push(row);
    }
  }
  return matches;
}

async function tickWithMods(mods) {
  watermarkMod._setCascadeModsForTest(mods);
  try {
    return await watermarkMod.tickSourcesOnce({ now: NOW });
  } finally {
    watermarkMod._setCascadeModsForTest(null);
  }
}

// -----------------------------------------------------------------------------
// T1 — F-WM-BREAKER-RESET: a clean tick (>= 1 row, zero errors) resets a
// non-zero error_count to 0 (the chat-claude-code 34/50 death-on-a-delay
// scenario).
// -----------------------------------------------------------------------------
test("T1: clean tick resets accumulated error_count to 0", async () => {
  const source = "imessage";
  const eof = seedRows(source, 3);
  writeCursor(source, { error_count: 34 });

  const res = await tickWithMods(dropAllMods());

  assert.equal(res.cascade_load_failed, false);
  assert.ok(res.rows_read >= 3, `expected >=3 rows read, got ${res.rows_read}`);
  const cursor = readCursor(source);
  assert.ok(cursor != null, "imessage cursor must exist after the tick");
  assert.equal(cursor.error_count, 0, "clean tick must reset error_count");
  assert.equal(BigInt(cursor.last_offset), BigInt(eof), "cursor must advance to EOF");
});

// -----------------------------------------------------------------------------
// T2 — F-WM-BREAKER-RESET boundary: a tick with ANY error does NOT reset (the
// threshold semantics are otherwise unchanged — errors within a tick sum).
// -----------------------------------------------------------------------------
test("T2: tick containing a parse error does NOT reset error_count", async () => {
  const source = "imessage";
  // One malformed line between two good rows: 1 error + 2 ok this tick.
  const path = sourceLedgerPath(source);
  writeFileSync(
    path,
    JSON.stringify(makeRow(source, 10)) + "\n" +
      "this is not valid JSON {\n" +
      JSON.stringify(makeRow(source, 11)) + "\n",
  );
  writeCursor(source, { error_count: 7 });

  await withCapturedStderr(async () => {
    await tickWithMods(dropAllMods());
  });

  const cursor = readCursor(source);
  assert.equal(
    cursor.error_count,
    8,
    "dirty tick must accumulate (7 + 1 parse error), not reset",
  );
});

// -----------------------------------------------------------------------------
// T3 — F-WM-AUTOMUTE-SIGNAL: a source at threshold is skipped WITH an
// observable signal (stderr line + policy.daemon.source_auto_muted), emitted
// once per mute window (not once per tick), and re-armed after a breaker
// reset.
// -----------------------------------------------------------------------------
test("T3: auto-mute emits one stderr line + one policy event per mute window", async () => {
  const source = "git-log";
  seedRows(source, 1);
  writeCursor(source, { error_count: THRESHOLD });

  // First muted tick: signal fires.
  const stderr1 = await withCapturedStderr(async () => {
    await tickWithMods(dropAllMods());
  });
  assert.match(
    stderr1,
    /watermark: source=git-log auto-muted error_count=\d+ threshold=\d+/,
    "first muted tick must log the auto-mute to stderr",
  );
  const cursorAfterMute = readCursor(source);
  assert.equal(
    cursorAfterMute.last_offset,
    "0",
    "muted source must NOT be tailed (cursor pinned)",
  );
  const events1 = readPolicyEvents(
    (e) => e.kind === "policy.daemon.source_auto_muted" && e.source === source,
  );
  assert.equal(events1.length, 1, "exactly one auto-mute policy event");
  assert.equal(events1[0].error_count, THRESHOLD);
  assert.equal(events1[0].threshold, THRESHOLD);

  // Second muted tick: throttled — no new stderr line, no new event.
  const stderr2 = await withCapturedStderr(async () => {
    await tickWithMods(dropAllMods());
  });
  assert.doesNotMatch(
    stderr2,
    /source=git-log auto-muted/,
    "repeat muted tick must NOT re-log (once per daemon lifetime per window)",
  );
  assert.equal(
    readPolicyEvents(
      (e) => e.kind === "policy.daemon.source_auto_muted" && e.source === source,
    ).length,
    1,
    "repeat muted tick must NOT re-emit the policy event",
  );

  // Operator clears the breaker; a clean tick processes the pending row and
  // re-arms the signal throttle...
  writeCursor(source, { error_count: 0 });
  await tickWithMods(dropAllMods());
  assert.equal(readCursor(source).error_count, 0);

  // ...so a LATER re-trip signals again (new mute window).
  writeCursor(source, {
    error_count: THRESHOLD,
    last_offset: readCursor(source).last_offset,
  });
  const stderr3 = await withCapturedStderr(async () => {
    await tickWithMods(dropAllMods());
  });
  assert.match(
    stderr3,
    /source=git-log auto-muted/,
    "a re-tripped breaker (new mute window) must signal again",
  );
  assert.equal(
    readPolicyEvents(
      (e) => e.kind === "policy.daemon.source_auto_muted" && e.source === source,
    ).length,
    2,
    "the re-trip emits a second policy event",
  );
});

// -----------------------------------------------------------------------------
// T4 — F-WM-CASCADE-LOAD-TICK-ABORT: a cascade module-load failure aborts the
// source walk for the tick — no cursor writes, no error_count bumps, one
// stderr line — and F-WM-CASCADE-LOAD-RETRY: the rejected loader promise is
// evicted so the NEXT tick retries the import and processes the rows.
// -----------------------------------------------------------------------------
test("T4: cascade load failure tick-aborts, then retries on the next tick", async () => {
  const source = "github-events";
  const eof = seedRows(source, 2);
  // No cursor file yet — a poisoned tick must not create one either.

  watermarkMod._setCascadeLoadFailureForTest(
    new Error("synthetic cascade load failure (test)"),
  );
  let res1;
  const stderr1 = await withCapturedStderr(async () => {
    res1 = await watermarkMod.tickSourcesOnce({ now: NOW });
  });
  watermarkMod._setCascadeLoadFailureForTest(null);

  assert.equal(res1.cascade_load_failed, true, "tick must report the load abort");
  assert.equal(res1.sources_walked, 0, "no source may be walked on a load-failed tick");
  assert.equal(res1.rows_read, 0, "no row may be read on a load-failed tick");
  assert.equal(res1.rows_errored, 0, "a systemic failure must not be charged per-row");
  assert.equal(
    readCursor(source),
    null,
    "load-failed tick must not create/advance the cursor",
  );
  assert.match(
    stderr1,
    /cascade module load failed — aborting source walk this tick/,
    "the abort must be observable on stderr",
  );

  // F-WM-CASCADE-LOAD-RETRY discriminator: inject a DIFFERENT error for the
  // second tick. If the first tick's REJECTED promise were still memoised,
  // the loader would replay error ONE without re-entering the import body;
  // seeing error TWO on stderr proves the memo was evicted and the import
  // genuinely retried.
  watermarkMod._setCascadeLoadFailureForTest(
    new Error("synthetic cascade load failure TWO (test)"),
  );
  let res2;
  const stderr2 = await withCapturedStderr(async () => {
    res2 = await watermarkMod.tickSourcesOnce({ now: NOW });
  });
  watermarkMod._setCascadeLoadFailureForTest(null);
  assert.equal(res2.cascade_load_failed, true);
  assert.match(
    stderr2,
    /synthetic cascade load failure TWO/,
    "second tick must surface the NEW error — a memoised rejection would replay the first",
  );
  assert.equal(
    readCursor(source),
    null,
    "cursor still untouched after the second aborted tick",
  );

  // Third tick: loader healthy again (mods override) — the pending rows
  // process and the aborted ticks left no residue behind.
  const res3 = await tickWithMods(dropAllMods());
  assert.equal(res3.cascade_load_failed, false);
  const cursor = readCursor(source);
  assert.ok(cursor != null, "healthy tick must process the pending rows");
  assert.equal(BigInt(cursor.last_offset), BigInt(eof), "cursor advances to EOF");
  assert.equal(cursor.error_count, 0, "no residual error_count from the aborted ticks");
});
