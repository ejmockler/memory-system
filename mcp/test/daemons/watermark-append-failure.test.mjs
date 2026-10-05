// watermark-append-failure.test.mjs — regression battery for G1
// (F-G1-WM-ERROR-ADVANCE) in daemons/watermark.js.
//
// THE DEFECT. The source row walk deliberately has NO cursor-park branch:
// "every visited row advances the cursor" (watermark.js, WU2 note above the
// DROP/CORROBORATE/PROMOTE fan-out). That is the right call — parking on a
// poison row head-of-line-blocks an entire source forever. But it means the
// ERROR branch advances `last_offset` PAST a row the cascade never judged,
// and the cursor is the only on-disk record of what was processed. The row
// is then unrecoverable: nothing anywhere says which row was skipped or why.
//
// THE FIX (default-off, additive). Before the cursor advance, the ERROR
// branch hands the verbatim source row to the EXISTING Stage-0 quarantine
// writer (mcp/lib/ingest/quarantine.js quarantineRow) — same path scheme,
// same id+checksum stamping, same restore path. No new writer and no
// parallel path scheme in the daemon.
//
// RETENTION IS UNWIRED — stated plainly because the earlier revision of this
// header implied otherwise ("no new retention policy", as if quarantine.js
// already owned one). quarantine.js DOES implement and export
// purgeExpiredQuarantine (mcp/lib/ingest/quarantine.js:573), but before this
// battery a repo-wide grep for that identifier returned four hits and ALL
// FOUR were inside quarantine.js itself: no production caller, no scheduler,
// no launchd job, no cron. Quarantine retention is therefore UNBOUNDED
// today — the module header's "A 30-day retention purge runs daily" was
// simply false, and is corrected in that file (comment-only) alongside this
// battery. G1's flag adds a SECOND, higher-volume writer into that unbounded
// store, so the growth it causes is monotonic until an operator schedules the
// purge. T6 pins what purgeExpiredQuarantine actually does (it had ZERO
// coverage before this battery); T7 pins that the watermark daemon is a
// WRITER into quarantine and never a REAPER.
//
// WHAT THIS BATTERY PINS.
//   T1 — flag OFF is byte-for-byte today: cursor still advances to EOF,
//        error_count still +1 per ERROR row, and NOTHING is created under
//        storage/quarantine.
//   T2 — flag ON adds recoverability WITHOUT adding a head-of-line block:
//        the row lands in quarantine under its own rule_id AND the cursor
//        still advances to EOF. Both halves matter; asserting only the
//        quarantine write would pass on a re-introduced cursor park.
//   T3 — the TICK-START systemic-fault abort is untouched. When the cascade
//        modules fail to load at the top of tickSourcesOnce
//        (watermark.js:2022-2049) the tick returns before ANY source is
//        walked: sources_walked === 0, cascade_load_failed === true, no
//        cursor created, nothing quarantined — identically under BOTH flag
//        states.
//   T4 — quarantine is strictly best-effort. With QUARANTINE_BASE_DIR
//        forced underneath a REGULAR FILE, quarantineRow throws ENOTDIR for
//        real (no mock, no injected seam). The tick must still complete and
//        every seeded row must still be visited and advanced past.
//   T5 — the PER-ROW twin of T3's abort (watermark.js:2276-2300), which T3
//        never reaches. When the loader starts failing MID-WALK, the source
//        the walk is already inside must abort with `break`: the cursor
//        stays pinned at the last genuinely processed row (NOT 0, NOT EOF),
//        error_count is NOT bumped, and — with the flag ON — nothing is
//        quarantined, because a systemic fault is not a poison row. The
//        discriminator against T3 is deliberate and asserted:
//        cascade_load_failed === false and sources_walked === 1 here,
//        true / 0 there.
//   T6 — purgeExpiredQuarantine's actual semantics: an out-of-window daily
//        file is deleted, an in-window one is retained, and a filename that
//        is not YYYY-MM-DD.jsonl is retained (an operator's stray file is
//        not a quarantine entry). Zero coverage before this.
//   T7 — the DISOWNING, made falsifiable: a flag-ON tick writes a new
//        quarantine entry AND leaves a long-expired pre-seeded file exactly
//        where it was. If anyone later wires a purge into the tick, this
//        goes red and forces a deliberate decision instead of a silent
//        unlink inside a live daemon.
//
// HERMETIC: tmp MEMORY_ROOT + per-tier BASE_DIRs are exported BEFORE the
// dynamic import reaches mcp/lib/config.js (the watermark-breaker-tick-abort
// idiom). Production ledgers / policy / cursors / quarantine are never read
// or written. The feature flag and QUARANTINE_BASE_DIR are restored in
// finally blocks so no subtest leaks env into another.
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
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Hermetic env — MUST be set BEFORE any dynamic import touches config.js.
// MEMORY_TEST_STUB_EMBEDDER keeps any real-module path off the network.
// -----------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-wm-quarantine-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.POLICY_BASE_DIR = join(TMP_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TMP_ROOT, "ledgers");
process.env.HOOKS_BASE_DIR = join(TMP_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(TMP_ROOT, "daemons");
process.env.MEMORY_TEST_STUB_EMBEDDER = "1";
// Start from a known-clean flag state; every subtest sets/restores it itself.
delete process.env.MEMORY_WATERMARK_ERROR_QUARANTINE_ENABLED;
delete process.env.QUARANTINE_BASE_DIR;

const WATERMARK_STATE_DIR = join(process.env.STORAGE_BASE_DIR, "watermark-state");
const SOURCES_DIR = join(process.env.STORAGE_BASE_DIR, "sources");
// Default quarantine root (quarantine.js: QUARANTINE_BASE_DIR || STORAGE_DIR/quarantine).
const QUARANTINE_DIR = join(process.env.STORAGE_BASE_DIR, "quarantine");
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
// T6/T7 exercise the EXISTING retention reaper directly — quarantine.js
// resolves QUARANTINE_BASE_DIR at CALL time (the same property T4 exploits),
// so this import is safe to take once here and re-point per subtest.
const { purgeExpiredQuarantine } = await import("../../lib/ingest/quarantine.js");

const NOW = new Date("2026-07-03T00:00:00Z");
const DAY_TAG = "2026-07-03"; // quarantine.js dayTag(NOW), UTC.
const FLAG = "MEMORY_WATERMARK_ERROR_QUARANTINE_ENABLED";
const RULE_ID = "F-G1-WM-ERROR-ADVANCE";

// -----------------------------------------------------------------------------
// Helpers (shared idioms with watermark-breaker-tick-abort.test.mjs).
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

// Byte offset of the END of row `i` (0-based) in the ledger seedRows() wrote —
// i.e. exactly the value the daemon stores in cursor.last_offset after
// visiting that row (readSourceRowsInRange reports offset_end as the start of
// the next line). Derived from the same makeRow() the seeder uses, so it
// tracks any future change to the row shape.
function offsetEndOfRow(source, i) {
  let acc = 0;
  for (let k = 0; k <= i; k++) {
    acc += Buffer.byteLength(JSON.stringify(makeRow(source, k)), "utf8") + 1; // +1 = "\n"
  }
  return acc;
}

function writeCursor(source, overrides = {}) {
  const cursor = { ...watermarkMod.emptyCursor(source, { now: NOW }), ...overrides };
  watermarkMod.writeSourceCursorAtomic(cursor, { now: NOW });
  return cursor;
}

function readCursor(source) {
  return watermarkMod.readSourceCursor(source);
}

// Capture everything written to process.stderr while fn runs.
async function withCapturedStderr(fn) {
  const orig = process.stderr.write;
  let captured = "";
  process.stderr.write = (chunk, ...rest) => {
    captured += typeof chunk === "string" ? chunk : String(chunk);
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

// Every row throws inside Stage-0 dispatch. runSourceCascade catches it and
// returns {decision:"ERROR", reason:"stage0_throw:..."} — which does NOT
// start with "cascade_load_failed", so it lands in the per-row ERROR branch
// under test (NOT the systemic-abort branch above it).
function throwAllMods() {
  return {
    stage0: {
      dispatch: () => {
        throw new Error("synthetic stage0 failure (test)");
      },
    },
    salience: null,
    promote: null,
    normalizeSourceEvent: null,
    localEmbedBatch: null,
    indexCache: null,
  };
}

async function tickWithMods(mods) {
  watermarkMod._setCascadeModsForTest(mods);
  try {
    return await watermarkMod.tickSourcesOnce({ now: NOW });
  } finally {
    watermarkMod._setCascadeModsForTest(null);
  }
}

// Read every quarantine entry recorded for `source` on the test clock's day.
// `root` defaults to the default quarantine root; T7 re-points it at the tmp
// root it also pre-seeds an expired file under.
function readQuarantineEntries(source, root = QUARANTINE_DIR) {
  const path = join(root, source, `${DAY_TAG}.jsonl`);
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line === "") continue;
    out.push(JSON.parse(line));
  }
  return out;
}

// Recursive listing so "nothing was created" is a claim about the whole
// subtree, not just the top level.
function listTree(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    out.push(p);
    if (statSync(p).isDirectory()) out.push(...listTree(p));
  }
  return out;
}

async function withFlag(value, fn) {
  const prev = process.env[FLAG];
  if (value === null) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

// -----------------------------------------------------------------------------
// T1 — flag OFF: today's behavior, byte for byte. The ERROR row advances the
// cursor to EOF and bumps error_count by exactly one per row, and NOTHING is
// written under storage/quarantine.
//
// This runs first on purpose: at this point the quarantine root has never
// been touched, so "the subtree is empty" is an unambiguous assertion.
// -----------------------------------------------------------------------------
test("T1: flag OFF — ERROR advances the cursor and writes no quarantine", async () => {
  const source = "imessage";
  const ROWS = 3;
  const eof = seedRows(source, ROWS);
  writeCursor(source, { error_count: 0 });

  await withFlag(null, async () => {
    await withCapturedStderr(async () => {
      await tickWithMods(throwAllMods());
    });
  });

  const cursor = readCursor(source);
  assert.ok(cursor != null, "cursor must exist after the tick");
  assert.equal(
    BigInt(cursor.last_offset),
    BigInt(eof),
    "every visited row must still advance the cursor to EOF (no head-of-line block)",
  );
  assert.equal(
    cursor.error_count,
    ROWS,
    "error_count must be exactly +1 per ERROR row — the auto-mute gate depends on it",
  );

  assert.deepEqual(
    listTree(QUARANTINE_DIR),
    [],
    "flag OFF must create nothing under storage/quarantine",
  );
});

// -----------------------------------------------------------------------------
// T2 — flag ON: the row becomes recoverable AND the cursor still advances.
//
// Asserting only the quarantine write would also pass on an implementation
// that parked the cursor, which is the exact failure mode the ERROR branch
// exists to avoid. Both halves are asserted.
// -----------------------------------------------------------------------------
test("T2: flag ON — the ERROR row is quarantined AND the cursor still advances", async () => {
  const source = "git-log";
  const ROWS = 2;
  const eof = seedRows(source, ROWS);
  writeCursor(source, { error_count: 0 });

  const stderr = await withFlag("1", async () => {
    return await withCapturedStderr(async () => {
      await tickWithMods(throwAllMods());
    });
  });

  // (a) recoverability
  const entries = readQuarantineEntries(source);
  assert.equal(
    entries.length,
    ROWS,
    `expected ${ROWS} quarantine entries under ${QUARANTINE_DIR}/${source}/${DAY_TAG}.jsonl`,
  );
  for (let i = 0; i < ROWS; i++) {
    const seeded = makeRow(source, i);
    const entry = entries.find((e) => e.source_msg_id === seeded.source_msg_id);
    assert.ok(
      entry != null,
      `no quarantine entry for source_msg_id=${seeded.source_msg_id}`,
    );
    assert.equal(entry.rule_id, RULE_ID, "entry must carry the G1 rule_id");
    assert.equal(entry.source, source);
    assert.equal(entry.reason, "watermark_cascade_error");
    // The VERBATIM source row is preserved, so restoreFromQuarantine can
    // re-emit it: raw_content survives the round trip.
    assert.deepEqual(
      entry.row.raw_content,
      seeded.raw_content,
      "the verbatim row body must survive into quarantine",
    );
  }

  // (b) no head-of-line block
  const cursor = readCursor(source);
  assert.ok(cursor != null, "cursor must exist after the tick");
  assert.equal(
    BigInt(cursor.last_offset),
    BigInt(eof),
    "quarantine must ADD recoverability, never introduce a cursor park",
  );
  assert.equal(
    cursor.error_count,
    ROWS,
    "the quarantine write must not contribute a second error_count bump",
  );

  assert.match(
    stderr,
    /cascade error at offset .*\(quarantined: /,
    "the quarantine path must be observable on the existing stderr line",
  );
});

// -----------------------------------------------------------------------------
// T3 — the TICK-START systemic-fault abort is untouched by G1.
//
// SCOPE, precisely. _setCascadeLoadFailureForTest makes loadCascadeModulesLazy
// reject; with no mods override installed, the FIRST caller is the tick-start
// load at watermark.js:2023, whose catch sets cascade_load_failed and RETURNS
// (watermark.js:2038-2048) before the `for (const {source, path} of ledgers)`
// loop runs at all. So this subtest asserts sources_walked === 0 and
// rows_read === 0: no row loop ever executes here, and the stderr string it
// matches is the tick-start one ("aborting source walk this tick",
// watermark.js:2041) — NOT the per-row one.
//
// The per-row twin (watermark.js:2276-2300, "aborting this source's row
// walk") is a DIFFERENT branch and is covered by T5 below, which drives the
// loader into failure MID-WALK so the row loop is already running.
//
// A cascade module-load failure is not a property of any row: no row was
// judged, so no row may be charged, no cursor may advance, and nothing may be
// quarantined. Asserted under BOTH flag states — if the flag could reach this
// path at all, the ON pass would diverge.
// -----------------------------------------------------------------------------
test("T3: cascade load failure at TICK START aborts before any source is walked, under both flag states", async () => {
  const source = "github-events";
  seedRows(source, 2);
  // No cursor file: a poisoned tick must not create one either.

  for (const flagValue of [null, "1"]) {
    const label = flagValue === null ? "flag OFF" : "flag ON";
    let res;
    const stderr = await withFlag(flagValue, async () => {
      return await withCapturedStderr(async () => {
        watermarkMod._setCascadeLoadFailureForTest(
          new Error("synthetic cascade load failure (test)"),
        );
        try {
          res = await watermarkMod.tickSourcesOnce({ now: NOW });
        } finally {
          watermarkMod._setCascadeLoadFailureForTest(null);
        }
      });
    });

    assert.equal(res.cascade_load_failed, true, `${label}: tick must report the load abort`);
    assert.equal(res.sources_walked, 0, `${label}: no source may be walked`);
    assert.equal(res.rows_read, 0, `${label}: no row may be read`);
    assert.equal(res.rows_errored, 0, `${label}: a systemic fault is not charged per-row`);
    assert.equal(
      readCursor(source),
      null,
      `${label}: a load-failed tick must not create/advance the cursor`,
    );
    assert.match(
      stderr,
      /cascade module load failed — aborting source walk this tick/,
      `${label}: the abort must stay observable on stderr`,
    );
    assert.deepEqual(
      readQuarantineEntries(source),
      [],
      `${label}: a systemic fault must never be quarantined as a per-row poison`,
    );
  }

  // Leave no unprocessed ledger behind for the next subtest's tick.
  rmSync(sourceLedgerPath(source), { force: true });
});

// -----------------------------------------------------------------------------
// T4 — quarantine is strictly best-effort: a REAL write failure cannot abort
// a tick, and cannot stall the source at the first poison row.
//
// No new seam is introduced. quarantine.js resolves QUARANTINE_BASE_DIR at
// CALL time, so pointing it underneath a REGULAR FILE makes the real
// mkdirSync inside ensureDir throw ENOTDIR — the genuine failure mode
// (ENOSPC / EACCES / a file where a directory belongs), not a mocked one.
// -----------------------------------------------------------------------------
test("T4: a quarantine write failure cannot abort the tick or stall the source", async () => {
  const source = "codex-cli";
  const ROWS = 3;
  const eof = seedRows(source, ROWS);
  writeCursor(source, { error_count: 0 });

  // A regular FILE where quarantineRoot()'s parent directory must be.
  const blocker = join(TMP_ROOT, "qblock");
  writeFileSync(blocker, "not a directory\n");

  const prevBase = process.env.QUARANTINE_BASE_DIR;
  process.env.QUARANTINE_BASE_DIR = join(blocker, "nope");
  let res;
  let stderr;
  try {
    await withFlag("1", async () => {
      stderr = await withCapturedStderr(async () => {
        res = await tickWithMods(throwAllMods());
      });
    });
  } finally {
    if (prevBase === undefined) delete process.env.QUARANTINE_BASE_DIR;
    else process.env.QUARANTINE_BASE_DIR = prevBase;
  }

  // DISCRIMINATOR: without this, T4 would also pass if the quarantine write
  // had quietly SUCCEEDED (proving nothing about the failure path). The
  // flag is ON, so a successful write would append "(quarantined: ...)" to
  // every ERROR stderr line — exactly as T2 asserts it does. Its absence
  // here is the observable proof that quarantineRow genuinely threw.
  assert.equal(
    (stderr.match(/cascade error at offset /g) || []).length,
    ROWS,
    "every row must still reach the ERROR branch and log",
  );
  assert.doesNotMatch(
    stderr,
    /\(quarantined: /,
    "the quarantine write must have actually FAILED — otherwise T4 proves nothing",
  );

  assert.ok(res != null, "the tick must return normally, not throw");
  assert.equal(res.cascade_load_failed, false, "a quarantine failure is not a load failure");
  assert.ok(
    res.rows_read >= ROWS,
    `every seeded row must still be read (got rows_read=${res.rows_read})`,
  );

  const cursor = readCursor(source);
  assert.ok(cursor != null, "cursor must exist after the tick");
  assert.equal(
    cursor.error_count,
    ROWS,
    "each row must still be visited and charged exactly once — the first failure " +
      "must not abort the row loop",
  );
  assert.equal(
    BigInt(cursor.last_offset),
    BigInt(eof),
    "the cursor must still advance to EOF despite the quarantine failure",
  );

  // The failed writes left nothing behind, and the blocker is still a file.
  assert.ok(statSync(blocker).isFile(), "the blocker must still be a regular file");
});

// -----------------------------------------------------------------------------
// T5 — the PER-ROW cascade_load_failed branch (watermark.js:2276-2300).
//
// WHY THIS EXISTS. T3 above is titled for the same fault but can only ever
// reach the TICK-START abort: with no mods override installed, the first
// caller of the rejecting loader is watermark.js:2023, which returns at :2048
// before the ledger loop runs. Nothing in this battery — and nothing in
// watermark-breaker-tick-abort.test.mjs — had ever executed the per-row twin,
// so its `break` and its "cursor pinned" stderr line were unpinned code.
//
// MECHANISM — composed from the TWO EXISTING seams, entirely test-side. No
// new seam is added to daemons/watermark.js:
//   * tick start takes the override path (watermark.js:2017-2020), so
//     loadCascadeModulesLazy is never called and its memo stays null;
//   * row 0's runSourceCascade resolves mods from the override
//     (watermark.js:1660-1661) and THEN calls stage0.dispatch, which
//     side-effects _setCascadeModsForTest(null) +
//     _setCascadeLoadFailureForTest(err) on its first invocation only and
//     returns DROP — so row 0 completes normally and legitimately advances
//     the cursor;
//   * row 1 finds no override, falls through to loadCascadeModulesLazy(),
//     which rejects, and runSourceCascade returns
//     {decision:"ERROR", reason:"cascade_load_failed:…"} at
//     watermark.js:1671 — landing squarely in the per-row branch.
// mods.localEmbedBatch / normalizeSourceEvent stay null so prefetchEmbeddings
// short-circuits at watermark.js:1918-1924 with no network path.
//
// The rejected loader promise self-evicts from the memo
// (watermark.js:1286-1291, F-WM-CASCADE-LOAD-RETRY), so the second loop
// iteration below re-arms cleanly and no poisoned promise leaks into T6/T7.
// -----------------------------------------------------------------------------
test("T5: a MID-WALK cascade load failure breaks the row walk with the cursor pinned mid-ledger", async () => {
  const source = "telegram"; // unused by T1/T2/T3/T4 — see the disarm note below.
  const ROWS = 3;

  // ISOLATION. T1/T2/T4 left fully-consumed ledgers behind (imessage,
  // git-log, codex-cli). Their cursors sit at EOF so they contribute zero
  // rows, but sources_walked is incremented for every ledger before any skip
  // check (watermark.js:2095-2096). Clearing them is what makes
  // `sources_walked === 1` below an EXACT discriminator against T3's
  // `=== 0`, instead of an incidental count. It also guarantees no other
  // source is mid-walk at the instant the override is disarmed.
  for (const f of existsSync(SOURCES_DIR) ? readdirSync(SOURCES_DIR) : []) {
    if (f.endsWith(".jsonl")) rmSync(join(SOURCES_DIR, f), { force: true });
  }

  const row0End = offsetEndOfRow(source, 0);

  try {
    for (const flagValue of [null, "1"]) {
      const label = flagValue === null ? "flag OFF" : "flag ON";
      const eof = seedRows(source, ROWS);
      writeCursor(source, { last_offset: "0", error_count: 0 });

      let dispatchCalls = 0;
      const mods = {
        stage0: {
          dispatch: () => {
            dispatchCalls += 1;
            if (dispatchCalls === 1) {
              // Disarm the override and arm the loader failure — AFTER this
              // row's mods were already resolved, so row 0 finishes cleanly
              // and only row 1 onward sees the systemic fault.
              watermarkMod._setCascadeModsForTest(null);
              watermarkMod._setCascadeLoadFailureForTest(
                new Error("synthetic per-row load failure (test)"),
              );
            }
            return { decision: "DROP", reason: "stage0_test" };
          },
        },
        salience: null,
        promote: null,
        normalizeSourceEvent: null,
        localEmbedBatch: null,
        indexCache: null,
      };

      let res;
      const stderr = await withFlag(flagValue, async () => {
        return await withCapturedStderr(async () => {
          watermarkMod._setCascadeModsForTest(mods);
          try {
            res = await watermarkMod.tickSourcesOnce({ now: NOW });
          } finally {
            watermarkMod._setCascadeModsForTest(null);
            watermarkMod._setCascadeLoadFailureForTest(null);
          }
        });
      });

      // (1) The literal per-row string. This substring exists at exactly one
      // place in the daemon (watermark.js:2291-2296) and cannot be emitted
      // unless that branch executed. The tick-start abort emits a DIFFERENT
      // sentence ("aborting source walk this tick", watermark.js:2041), which
      // T3 matches — the two are not interchangeable.
      assert.match(
        stderr,
        new RegExp(
          "source=" + source +
            " cascade module load failed — aborting this source's row walk " +
            "\\(cursor pinned at offset ",
        ),
        `${label}: the per-row abort line must be emitted verbatim`,
      );
      assert.doesNotMatch(
        stderr,
        /aborting source walk this tick/,
        `${label}: this must NOT be the tick-start abort`,
      );

      // (2) DISCRIMINATOR against T3, which asserts true / 0 for these two.
      assert.equal(
        res.cascade_load_failed,
        false,
        `${label}: the tick-start abort never fired — the walk got as far as the rows`,
      );
      assert.equal(
        res.sources_walked,
        1,
        `${label}: the source WAS walked (T3's tick-start abort walks zero)`,
      );

      // (3) The cursor is pinned at the last GENUINELY processed row: row 0's
      // offset_end. Neither 0 (which would mean earlier rows lost their
      // legitimate advancement) nor EOF (which would mean the unjudged rows
      // were silently consumed).
      const cursor = readCursor(source);
      assert.ok(cursor != null, `${label}: cursor must exist after the tick`);
      assert.equal(
        BigInt(cursor.last_offset),
        BigInt(row0End),
        `${label}: cursor must pin at row 0's offset_end`,
      );
      assert.ok(
        BigInt(cursor.last_offset) > 0n,
        `${label}: earlier rows must keep their legitimate advancement`,
      );
      assert.ok(
        BigInt(cursor.last_offset) < BigInt(eof),
        `${label}: the unjudged rows must NOT be consumed`,
      );

      // (4) A systemic fault is never charged per-row, so the auto-mute gate
      // at watermark.js:2134 (WATERMARK_SOURCE_ERROR_THRESHOLD = 50,
      // mcp/lib/validation.js:546) is untouched. Seeded at 0, so a stray +1
      // would show as 1 — the clean-tick breaker reset cannot mask it,
      // because that reset only fires when tickRowErrors === 0.
      assert.equal(
        cursor.error_count,
        0,
        `${label}: a systemic fault must not bump error_count toward auto-mute`,
      );
      assert.equal(
        res.rows_errored,
        0,
        `${label}: a systemic fault is not counted as a row error`,
      );

      // (5) `break`, not `continue`: row 2 is never read.
      assert.equal(
        res.rows_read,
        2,
        `${label}: the walk must BREAK at the failing row, not skip past it`,
      );
      assert.ok(
        res.rows_read < ROWS,
        `${label}: strictly fewer rows read than seeded`,
      );
      assert.equal(res.rows_dropped, 1, `${label}: exactly row 0 was judged`);

      // (6) Flag ON: the systemic branch sits ABOVE the quarantine write
      // (watermark.js:2276 vs :2302), so nothing may be quarantined — the
      // load-bearing G1 claim. Asserted recursively, and as an absence of
      // the source's directory entirely.
      assert.deepEqual(
        readQuarantineEntries(source),
        [],
        `${label}: a systemic fault must never be quarantined as a poison row`,
      );
      assert.equal(
        existsSync(join(QUARANTINE_DIR, source)),
        false,
        `${label}: no quarantine directory may be created for this source`,
      );
      assert.deepEqual(
        listTree(QUARANTINE_DIR).filter((p) => p.includes(source)),
        [],
        `${label}: nothing anywhere under the quarantine root may mention this source`,
      );
    }
  } finally {
    // Belt and braces: both seams disarmed even if an assertion threw
    // mid-loop, so no later subtest inherits a poisoned cascade.
    watermarkMod._setCascadeModsForTest(null);
    watermarkMod._setCascadeLoadFailureForTest(null);
    // Leave no unprocessed ledger behind for T7's tick.
    rmSync(sourceLedgerPath(source), { force: true });
  }
});

// -----------------------------------------------------------------------------
// T6 — purgeExpiredQuarantine (mcp/lib/ingest/quarantine.js:573) had ZERO
// coverage. It is implemented, exported, documented as "runs daily" — and
// called by nothing in the repo. Before disowning it in T7, pin what it
// actually does, so the operator wiring it into the daily job surface has a
// contract to wire against.
//
// quarantine.js resolves QUARANTINE_BASE_DIR at CALL time (the same property
// T4 exploits), so pointing it at a tmp subdir is sufficient isolation; the
// files are hand-written rather than produced by a tick so the day tags are
// exact.
// -----------------------------------------------------------------------------
test("T6: purgeExpiredQuarantine deletes out-of-window dailies and retains everything else", () => {
  const root = join(TMP_ROOT, "quarantine-purge");
  const src = "mail";
  mkdirSync(join(root, src), { recursive: true, mode: 0o700 });

  // 2026-01-01 + 30d = 2026-01-31, well before NOW (2026-07-03) -> expired.
  const expired = join(root, src, "2026-01-01.jsonl");
  // NOW's own day tag -> expires 2026-08-02 -> in window.
  const inWindow = join(root, src, `${DAY_TAG}.jsonl`);
  // Ends in .jsonl but is not YYYY-MM-DD: an operator's stray file is not a
  // quarantine entry and the reaper must refuse to delete it
  // (quarantine.js:588-593).
  const stray = join(root, src, "operator-notes.jsonl");
  writeFileSync(expired, JSON.stringify({ note: "expired" }) + "\n");
  writeFileSync(inWindow, JSON.stringify({ note: "in window" }) + "\n");
  writeFileSync(stray, "operator scratch, not a quarantine entry\n");

  const prevBase = process.env.QUARANTINE_BASE_DIR;
  process.env.QUARANTINE_BASE_DIR = root;
  let res;
  try {
    res = purgeExpiredQuarantine({ now: NOW, retentionDays: 30 });
  } finally {
    if (prevBase === undefined) delete process.env.QUARANTINE_BASE_DIR;
    else process.env.QUARANTINE_BASE_DIR = prevBase;
  }

  assert.deepEqual(res.deleted, [expired], "only the out-of-window daily may be deleted");
  assert.equal(existsSync(expired), false, "the expired daily must be gone from disk");

  assert.equal(res.retained, 2, "the in-window daily AND the stray name are both retained");
  assert.ok(existsSync(inWindow), "an in-window daily must survive the purge");
  assert.ok(existsSync(stray), "a non-YYYY-MM-DD filename must survive the purge");
});

// -----------------------------------------------------------------------------
// T7 — the DISOWNING, made falsifiable.
//
// The watermark daemon is a WRITER into quarantine and never a REAPER. That
// is a deliberate choice, not an oversight: scheduling retention is the
// operator's to land (see the corrected header in
// mcp/lib/ingest/quarantine.js), and a live ingestion daemon must not
// unlinkSync files as a tick side effect. This subtest pins the choice so a
// future "just purge inside the tick" goes RED and forces a deliberate
// decision instead of a silent delete.
// -----------------------------------------------------------------------------
test("T7: a flag-ON tick WRITES into quarantine and never REAPS it", async () => {
  const root = join(TMP_ROOT, "quarantine-disown");
  const staleSource = "github-events";
  mkdirSync(join(root, staleSource), { recursive: true, mode: 0o700 });
  // 2025-01-01: long past any plausible retention window.
  const stale = join(root, staleSource, "2025-01-01.jsonl");
  writeFileSync(stale, JSON.stringify({ note: "long expired" }) + "\n");

  const source = "slack";
  const ROWS = 2;
  const eof = seedRows(source, ROWS);
  writeCursor(source, { last_offset: "0", error_count: 0 });

  const prevBase = process.env.QUARANTINE_BASE_DIR;
  process.env.QUARANTINE_BASE_DIR = root;
  try {
    await withFlag("1", async () => {
      await withCapturedStderr(async () => {
        await tickWithMods(throwAllMods());
      });
    });

    // (a) the daemon WROTE — otherwise "it did not reap" would be vacuous,
    // since a tick that quarantined nothing proves nothing about reaping.
    const entries = readQuarantineEntries(source, root);
    assert.equal(entries.length, ROWS, "the flag-ON tick must quarantine every ERROR row");
    const cursor = readCursor(source);
    assert.equal(
      BigInt(cursor.last_offset),
      BigInt(eof),
      "and must still advance the cursor to EOF",
    );

    // (b) the daemon did NOT reap.
    assert.ok(
      existsSync(stale),
      "the watermark tick must never delete a quarantine file — retention is " +
        "the operator's scheduled job, not a daemon side effect",
    );

    // FALSIFIABILITY, IN BAND: prove the survivor was genuinely purge-ELIGIBLE
    // for the whole tick, so (b) is a claim about the DAEMON and not about the
    // retention window happening to cover it. Running the reaper BY HAND now
    // removes exactly that file — and leaves today's freshly written entries.
    const purged = purgeExpiredQuarantine({ now: NOW, retentionDays: 30 });
    assert.ok(
      purged.deleted.includes(stale),
      "the pre-seeded file must have been purge-eligible all along",
    );
    assert.equal(existsSync(stale), false, "the hand-run reaper removes it");
    assert.equal(
      readQuarantineEntries(source, root).length,
      ROWS,
      "the entries this tick wrote are in-window and survive the reaper",
    );
  } finally {
    if (prevBase === undefined) delete process.env.QUARANTINE_BASE_DIR;
    else process.env.QUARANTINE_BASE_DIR = prevBase;
    rmSync(sourceLedgerPath(source), { force: true });
  }
});
