// cursor-lag-alarm.test.mjs — F-NEW-W7-CURSOR-LAG-UNIT-TESTS.
//
// Hermetic regression for the cursor-lag alarm path in daemons/watermark.js.
// Authoritative spec: F-NEW-W7-CURSOR-LAG-ALARM + the W7 cleanup spec
// (computeCursorLagSnapshot is pure, emitCursorLagAlarms calls recordDrop
// per-source, maybeRunCursorLagCheck fires only every N ticks).
//
// Owner contract:
//
//   - computeCursorLagSnapshot returns one entry per source ledger with
//     {source, cursor_ts, tail_ts, lag_ms, ledger_size_bytes,
//      ledger_mtime_ms, ledger_growing, warned}. The pure function NEVER
//     touches telemetry / stderr; tests treat it as a fold over
//     listSourceLedgers + readSourceCursor + readLedgerTailTs.
//
//   - emitCursorLagAlarms bumps a telemetry counter PER ENTRY whose
//     warned=true. The first positional argument to recordDrop is the
//     per-entry source (NOT the literal "watermark"); the docstring fix
//     and code path were jointly corrected by F-NEW-W7-CURSOR-LAG-
//     DOCSTRING-DRIFT.
//
//   - maybeRunCursorLagCheck increments an internal tick counter and
//     fires emitCursorLagAlarms only on every CURSOR_LAG_CHECK_EVERY_N_TICKS
//     tick. Below the threshold it is a no-op. After firing, the counter
//     resets to 0 so the next firing also requires N ticks.
//
// Hermetic discipline:
//
//   - MEMORY_ROOT / POLICY_BASE_DIR / STORAGE_BASE_DIR / LEDGERS_BASE_DIR
//     are overridden to a mkdtempSync path BEFORE the first dynamic
//     import of daemons/watermark.js.
//   - Synthetic source ledgers + cursor files are written directly to
//     the hermetic STORAGE root; the daemon process itself is never
//     spawned. We invoke the exported functions in-process.
//   - emitCursorLagAlarms accepts an injected snapshot + telemetry stub
//     so the test does not need to touch the real Stage-0 telemetry
//     module or the real disk-walking snapshot.
//
// Run: node mcp/test/cursor-lag-alarm.test.mjs
// Exits 0 on pass, 1 on any failure.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hermetic MEMORY_ROOT — bind BEFORE first dynamic import of watermark.js.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "cursor-lag-alarm-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(MEMORY_ROOT, "policy");
const STORAGE_DIR = join(MEMORY_ROOT, "storage");
const LEDGERS_DIR = join(MEMORY_ROOT, "ledgers");
const SOURCES_DIR = join(STORAGE_DIR, "sources");
const WATERMARK_STATE_DIR = join(STORAGE_DIR, "watermark-state");

for (const d of [POLICY_DIR, STORAGE_DIR, LEDGERS_DIR, SOURCES_DIR, WATERMARK_STATE_DIR]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;

process.on("exit", () => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Dynamic imports (post-env-binding).
// ---------------------------------------------------------------------------
const wm = await import("../../daemons/watermark.js");
const {
  computeCursorLagSnapshot,
  emitCursorLagAlarms,
  maybeRunCursorLagCheck,
  _resetCursorLagTickCounterForTest,
  CURSOR_LAG_WARN_THRESHOLD_MS,
  CURSOR_LAG_LEDGER_GROWTH_WINDOW_MS,
  CURSOR_LAG_CHECK_EVERY_N_TICKS,
} = wm;

// Boot-time sanity: every symbol the spec names MUST be exported. A failure
// here is a structural drift; surface it loudly before any test runs.
for (const [name, value] of Object.entries({
  computeCursorLagSnapshot,
  emitCursorLagAlarms,
  maybeRunCursorLagCheck,
  _resetCursorLagTickCounterForTest,
  CURSOR_LAG_WARN_THRESHOLD_MS,
  CURSOR_LAG_LEDGER_GROWTH_WINDOW_MS,
  CURSOR_LAG_CHECK_EVERY_N_TICKS,
})) {
  if (value === undefined) {
    console.log(`FATAL: daemons/watermark.js must export ${name} per F-NEW-W7 spec.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Test harness — assert-with-label, matches sibling tests.
// ---------------------------------------------------------------------------
let failures = 0;
let passes = 0;
let assertions = 0;

function pass(label) {
  passes++;
  console.log(`  pass: ${label}`);
}
function fail(label, err) {
  failures++;
  console.log(`  FAIL: ${label}`);
  if (err) console.log(`        ${err && err.stack ? err.stack : err}`);
}
function assertEq(actual, expected, label) {
  assertions++;
  if (actual !== expected) {
    throw new Error(`assertEq(${label}): expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}
function assertTrue(cond, label) {
  assertions++;
  if (!cond) throw new Error(`assertTrue(${label}): expected truthy, got ${JSON.stringify(cond)}`);
}
function assertFalse(cond, label) {
  assertions++;
  if (cond) throw new Error(`assertFalse(${label}): expected falsy, got ${JSON.stringify(cond)}`);
}
async function test(label, fn) {
  console.log(`test: ${label}`);
  try {
    await fn();
  } catch (err) {
    fail(label, err);
  }
}

// ---------------------------------------------------------------------------
// Per-source fixture writer. Writes one ledger row at storage/sources/<src>.jsonl
// (so the source appears in listSourceLedgers + readLedgerTailTs picks up its
// ts and mtime) plus one cursor at storage/watermark-state/<src>.json.
//
// `tailTsIso` — the ts field of the ledger's last row (what
//               readLedgerTailTs returns as tail.ts).
// `cursorTsIso` — the cursor's last_appended_ts (what computeCursorLagSnapshot
//                 reads as cursorTs).
// `ledgerMtimeAdjustMs` — optional offset from "now" applied to the ledger's
//                         mtime via utimesSync, used to simulate a stale
//                         ledger (no growth in the last hour).
//
// `source` MUST be one of CAPS.WATERMARK_SOURCES so listSourceLedgers picks
// it up. We pick "imessage" / "git-log" / "github-events" since those are all
// in the bare-name list and the test does not exercise the chat-* wildcard
// path.
// ---------------------------------------------------------------------------
import { utimesSync } from "node:fs";

function writeSourceFixture({ source, tailTsIso, cursorTsIso, ledgerMtimeMs }) {
  // Ledger row.
  const row = {
    id: "ulid_FIXTURE_" + source,
    ts: tailTsIso,
    source,
    source_msg_id: "msg_" + source,
    parties: [],
    raw_content: { text: "fixture row" },
    attachments: [],
    source_policy: {
      deletion_semantics: "soft_delete_retain_audit",
      consent_basis: "operator_consent",
    },
  };
  const ledgerPath = join(SOURCES_DIR, `${source}.jsonl`);
  writeFileSync(ledgerPath, JSON.stringify(row) + "\n", { mode: 0o600 });
  if (Number.isFinite(ledgerMtimeMs)) {
    const sec = ledgerMtimeMs / 1000;
    utimesSync(ledgerPath, sec, sec);
  }
  // Cursor file.
  const cursor = {
    version: 1,
    source,
    last_offset: "0",
    last_appended_ts: cursorTsIso,
    last_event_id: null,
    error_count: 0,
    muted_until: null,
    updated_at: new Date().toISOString(),
  };
  const cursorPath = join(WATERMARK_STATE_DIR, `${source}.json`);
  writeFileSync(cursorPath, JSON.stringify(cursor), { mode: 0o600 });
}

function clearFixtures() {
  for (const f of [SOURCES_DIR, WATERMARK_STATE_DIR]) {
    rmSync(f, { recursive: true, force: true });
    mkdirSync(f, { recursive: true, mode: 0o700 });
  }
}

// ---------------------------------------------------------------------------
// T1: computeCursorLagSnapshot with no stuck cursors -> all warned=false.
// Set tail_ts == cursor_ts so lag_ms == 0. ledger_growing is irrelevant
// because lag_ms < threshold.
// ---------------------------------------------------------------------------
await test("T1: computeCursorLagSnapshot with no stuck cursors -> all entries warned=false", async () => {
  clearFixtures();
  const now = Date.now();
  const tsIso = new Date(now - 60_000).toISOString(); // 1 minute ago
  writeSourceFixture({
    source: "imessage",
    tailTsIso: tsIso,
    cursorTsIso: tsIso, // cursor is fully caught up
    ledgerMtimeMs: now, // ledger is fresh (growing)
  });
  writeSourceFixture({
    source: "git-log",
    tailTsIso: tsIso,
    cursorTsIso: tsIso,
    ledgerMtimeMs: now,
  });

  const snap = computeCursorLagSnapshot({ now });
  assertTrue(snap.length >= 2, "snapshot length >= 2");
  for (const entry of snap) {
    if (entry.source !== "imessage" && entry.source !== "git-log") continue;
    assertFalse(entry.warned, `entry.warned for ${entry.source}`);
    // lag_ms is 0 (or near-zero); MUST be below the 24h threshold.
    assertTrue(
      entry.lag_ms != null && entry.lag_ms < CURSOR_LAG_WARN_THRESHOLD_MS,
      `entry.lag_ms below threshold for ${entry.source}`,
    );
  }
  pass("T1: caught-up cursors produce warned=false");
});

// ---------------------------------------------------------------------------
// T2: cursor 25h behind + growing ledger -> entry.warned=true.
// ---------------------------------------------------------------------------
await test("T2: cursor 25h behind + growing ledger -> entry.warned=true", async () => {
  clearFixtures();
  const now = Date.now();
  const tailTs = new Date(now - 60_000).toISOString(); // 1 min ago
  const cursorTs = new Date(now - 25 * 3600 * 1000).toISOString(); // 25h ago
  writeSourceFixture({
    source: "imessage",
    tailTsIso: tailTs,
    cursorTsIso: cursorTs,
    ledgerMtimeMs: now, // ledger is fresh -> ledger_growing=true
  });

  const snap = computeCursorLagSnapshot({ now });
  const imsg = snap.find((e) => e.source === "imessage");
  assertTrue(imsg != null, "imessage entry present");
  assertTrue(imsg.warned, "imessage warned=true");
  assertTrue(imsg.ledger_growing, "imessage ledger_growing=true");
  assertTrue(
    imsg.lag_ms > CURSOR_LAG_WARN_THRESHOLD_MS,
    "imessage lag_ms exceeds threshold",
  );
  pass("T2: 25h-behind cursor on growing ledger flips warned=true");
});

// ---------------------------------------------------------------------------
// T3: cursor 25h behind BUT ledger NOT growing -> warned=false (idle source).
// We simulate "not growing" by forcing the ledger mtime to be older than
// CURSOR_LAG_LEDGER_GROWTH_WINDOW_MS.
// ---------------------------------------------------------------------------
await test("T3: cursor 25h behind + idle ledger -> entry.warned=false (idle source)", async () => {
  clearFixtures();
  const now = Date.now();
  const tailTs = new Date(now - 25 * 3600 * 1000).toISOString(); // 25h ago
  const cursorTs = new Date(now - 50 * 3600 * 1000).toISOString(); // 50h ago
  // mtime is 2h old -> outside the 1h growth window.
  const staleMtime = now - 2 * 3600 * 1000;
  writeSourceFixture({
    source: "imessage",
    tailTsIso: tailTs,
    cursorTsIso: cursorTs,
    ledgerMtimeMs: staleMtime,
  });

  const snap = computeCursorLagSnapshot({ now });
  const imsg = snap.find((e) => e.source === "imessage");
  assertTrue(imsg != null, "imessage entry present");
  assertFalse(imsg.ledger_growing, "imessage ledger_growing=false (mtime stale)");
  assertFalse(imsg.warned, "imessage warned=false (idle source not actionable)");
  // Sanity: lag_ms IS still huge, but the warned gate filters it.
  assertTrue(
    imsg.lag_ms > CURSOR_LAG_WARN_THRESHOLD_MS,
    "imessage lag_ms still > threshold (the gate was ledger_growing, not lag_ms)",
  );
  pass("T3: idle-source cursor lag is suppressed (ledger_growing=false gate)");
});

// ---------------------------------------------------------------------------
// T4: emitCursorLagAlarms calls recordDrop with source from EACH entry
// (NOT just the literal "watermark"). This is the docstring-drift fix:
// every warned entry contributes its own source to the telemetry counter.
// ---------------------------------------------------------------------------
await test("T4: emitCursorLagAlarms passes per-entry source to recordDrop", async () => {
  // Hand-craft a 3-entry snapshot: two warned, one not warned. The stub
  // telemetry records each recordDrop call so we can assert on the
  // per-entry source attribution.
  const injectedSnap = [
    {
      source: "imessage",
      cursor_ts: "2026-06-04T00:00:00Z",
      tail_ts: "2026-06-09T00:00:00Z",
      lag_ms: 5 * 24 * 3600 * 1000,
      ledger_size_bytes: 100,
      ledger_mtime_ms: Date.now(),
      ledger_growing: true,
      warned: true,
    },
    {
      source: "git-log",
      cursor_ts: "2026-06-05T00:00:00Z",
      tail_ts: "2026-06-09T00:00:00Z",
      lag_ms: 4 * 24 * 3600 * 1000,
      ledger_size_bytes: 100,
      ledger_mtime_ms: Date.now(),
      ledger_growing: true,
      warned: true,
    },
    {
      source: "github-events",
      cursor_ts: "2026-06-09T00:00:00Z",
      tail_ts: "2026-06-09T00:00:00Z",
      lag_ms: 0,
      ledger_size_bytes: 100,
      ledger_mtime_ms: Date.now(),
      ledger_growing: true,
      warned: false,
    },
  ];

  const calls = [];
  const telemetryStub = {
    recordDrop(source, reason, decision) {
      calls.push({ source, reason, decision });
    },
  };

  await emitCursorLagAlarms({
    now: Date.now(),
    snapshot: injectedSnap,
    telemetry: telemetryStub,
  });

  // Exactly 2 calls (one per warned entry); the non-warned entry must be
  // skipped. Each call's source MUST equal the per-entry source (NOT the
  // literal "watermark"); this is the docstring-drift regression guard.
  assertEq(calls.length, 2, "recordDrop call count == warned-entry count");
  const sources = calls.map((c) => c.source).sort();
  assertEq(sources[0], "git-log", "first warned source");
  assertEq(sources[1], "imessage", "second warned source");
  for (const c of calls) {
    assertEq(c.reason, "cursor_lag_warn", `reason for source=${c.source}`);
    assertEq(c.decision, "WARN", `decision for source=${c.source}`);
    assertTrue(c.source !== "watermark", `source !== literal "watermark" for ${c.source}`);
  }
  pass("T4: recordDrop called once per warned entry with per-entry source");
});

// ---------------------------------------------------------------------------
// T5: maybeRunCursorLagCheck fires only every CURSOR_LAG_CHECK_EVERY_N_TICKS
// ticks. We reset the internal counter, call it N-1 times (no firing),
// then once more (firing), then N more times (one more firing).
//
// Detection mechanism: the public function returns true on the firing tick
// and false otherwise. We don't need to observe emitCursorLagAlarms's side
// effects here — the return signal is the test contract.
// ---------------------------------------------------------------------------
await test("T5: maybeRunCursorLagCheck fires only every CURSOR_LAG_CHECK_EVERY_N_TICKS ticks", async () => {
  _resetCursorLagTickCounterForTest();
  const N = CURSOR_LAG_CHECK_EVERY_N_TICKS;
  assertTrue(N >= 2, "N >= 2 (otherwise the cadence test is meaningless)");

  // Below the threshold: every call returns false.
  for (let i = 1; i < N; i++) {
    const fired = maybeRunCursorLagCheck({ now: undefined });
    assertFalse(fired, `tick ${i} below threshold (must not fire)`);
  }
  // Nth call -> fires + resets the counter.
  const firedOnN = maybeRunCursorLagCheck({ now: undefined });
  assertTrue(firedOnN, `tick ${N} crosses threshold (must fire)`);

  // After reset, we need ANOTHER N calls before the next firing.
  for (let i = 1; i < N; i++) {
    const fired = maybeRunCursorLagCheck({ now: undefined });
    assertFalse(fired, `tick ${N + i} below post-reset threshold`);
  }
  const firedOn2N = maybeRunCursorLagCheck({ now: undefined });
  assertTrue(firedOn2N, `tick ${2 * N} crosses threshold again`);

  pass(`T5: maybeRunCursorLagCheck cadence honored (every ${N} ticks)`);
});

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log("");
console.log(
  `cursor-lag-alarm.test.mjs: ${passes} passed, ${failures} failed, ${assertions} assertions`,
);
if (failures > 0 || assertions < 5) {
  if (assertions < 5) {
    console.log(`FAIL: spec requires at least 5 assertions; got ${assertions}`);
  }
  process.exit(1);
}
process.exit(0);
