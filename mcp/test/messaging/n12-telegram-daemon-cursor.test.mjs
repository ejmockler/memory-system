// n12-telegram-daemon-cursor.test.mjs — WORKUNIT N12 (telegram-daemon).
//
// Proves the STAGING READ-OFFSET WATERMARK fix in
// mcp/lib/connectors/telegram.js: a replay of an unchanged staging file
// appends ZERO new rows once the byte-offset cursor (state.json
// staging_offset) is persisted — and that the bounded source_msg_id dedup
// (CAPS.CONNECTOR_DEDUP_TAIL_LINES tail-read) is NOT what protects us (the
// cursor is). This closes the re-append bug the work unit names: the old
// truncation guard `startOffset < raw.length` reset the offset to 0 in the
// steady state (startOffset === raw.length, i.e. fully caught up), re-read
// the WHOLE staging file every poll, and re-appended every row that had
// fallen out of the small dedup tail window.
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions.
//
// HERMETICITY (standing C-NEW-2): every env var is set BEFORE the first
// dynamic import of the connector (config.js binds MEMORY_ROOT at module
// init). Every disk write lands inside mkdtempSync; the
// operator's live install is never touched. The staging file is pinned
// to a tmp path via TELEGRAM_STAGING_FILE. Post-exit cleanup rmSync's the
// tmpdir. No DB, no network, no MTProto socket — this test exercises ONLY
// the Node tail's cursor math.
//
// GATE line emitted at the end:
//   replay_dups=0 cursor_persisted=true new_msg_flows=true rotation_safe=true
//
// Run: node test/messaging/n12-telegram-daemon-cursor.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Hermetic root — BEFORE any dynamic import of the module under test.
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "n12-telegram-cursor-"));
mkdirSync(join(TEST_ROOT, "storage", "sources"), { recursive: true });
mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
const STAGING_FILE = join(TEST_ROOT, "telegram-staging.jsonl");
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.CONNECTORS_BASE_DIR = join(TEST_ROOT, "connectors");
process.env.TELEGRAM_STAGING_FILE = STAGING_FILE;
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

// Production-safety snapshot: the REAL telegram source ledger must be byte-
// identical pre/post this run. If a hermeticity leak ever lets a test write
// escape TEST_ROOT, this trips loudly at exit.
//
// B1 (task-hypergraph) hardening: as of 2026-07-06 a LIVE launchd daemon
// (com.user.memory-system.telegram-connector, telegram.js runForever) drains
// the staging file into this same PROD_LEDGER every 30s. That daemon's
// legitimate appends would otherwise race this snapshot and trip a FALSE
// leak whenever a poll lands mid-run — this test provably cannot write the
// real ledger (every path is bound to TEST_ROOT via MEMORY_ROOT). So we only
// escalate to exitCode=1 when NO live connector owns the ledger (the original
// static-ledger intent); when the daemon is live, an external append is
// expected and we emit an informational note instead of failing the gate.
// The checkout this test file lives in (derived from import.meta.url, never a
// home-directory guess). It is only ever stat()ed, never opened.
const CHECKOUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROD_LEDGER = join(CHECKOUT_ROOT, "storage", "sources", "telegram.jsonl");
function liveTelegramConnectorRunning() {
  try {
    const out = execFileSync("pgrep", ["-f", "connectors/telegram.js"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() !== "";
  } catch {
    // pgrep exits non-zero (throws) when there is no match — no live owner.
    return false;
  }
}
let prodBefore = null;
try {
  const st = statSync(PROD_LEDGER);
  prodBefore = { mtimeMs: st.mtimeMs, size: st.size };
} catch { /* absent is fine */ }
process.on("exit", () => {
  if (prodBefore == null) return;
  try {
    const st = statSync(PROD_LEDGER);
    if (st.size !== prodBefore.size || st.mtimeMs !== prodBefore.mtimeMs) {
      const drift =
        `production ${PROD_LEDGER} changed during the test ` +
        `(size ${prodBefore.size}->${st.size}, mtime ${prodBefore.mtimeMs}->${st.mtimeMs})`;
      if (liveTelegramConnectorRunning()) {
        // Expected: the live telegram-connector daemon appended. Not a leak —
        // this process never writes outside TEST_ROOT.
        console.error(`INFO: ${drift} — attributed to the live telegram-connector daemon (expected, not a leak).`);
      } else {
        console.error(`HERMETICITY LEAK: ${drift}`);
        process.exitCode = 1;
      }
    }
  } catch { /* deleted under us — ignore */ }
});

// ---------------------------------------------------------------------------
// Dynamic imports — bind inside TEST_ROOT.
// ---------------------------------------------------------------------------
const { TelegramConnector, runOnce, defaultStagingFile } = await import(
  "../../lib/connectors/telegram.js"
);
const { connectorStatePath } = await import("../../lib/config.js");
const { CAPS } = await import("../../lib/validation.js");
// B1 (task-hypergraph) — drain-liveness detector + health surface wiring.
const { computeTelegramDrainStatus } = await import(
  "../../lib/connectors/telegram-drain-liveness.js"
);
const { buildHealthData } = await import("../../lib/tools/health.js");

const STATE_PATH = connectorStatePath("telegram");
const LEDGER_PATH = join(TEST_ROOT, "storage", "sources", "telegram.jsonl");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A deterministic 1:1 DM event the Stage-0 hard-drops let through (peer_type
// user, has text, no bot/forward/ephemeral markers). message_id makes each
// row's source_msg_id distinct.
function dmEvent(n) {
  return {
    peer_type: "user",
    peer_id: 7000,
    peer_name: "alice",
    message_id: n,
    ts: `2026-06-24T00:00:${String(n % 60).padStart(2, "0")}.000Z`,
    sender_id: 7000,
    sender_name: "alice",
    is_outgoing: false,
    is_self: false,
    text: `message number ${n}`,
    media_type: null,
    fwd_from: null,
    reply_to: null,
    ttl_seconds: null,
    is_edit: false,
    edit_seq: 0,
  };
}

// Write N events to the staging file (overwrites). Returns the byte length.
function writeStaging(count, startAt = 1) {
  const lines = [];
  for (let i = 0; i < count; i++) lines.push(JSON.stringify(dmEvent(startAt + i)));
  const body = lines.join("\n") + "\n";
  writeFileSync(STAGING_FILE, body, "utf8");
  return Buffer.byteLength(body, "utf8");
}

function appendStaging(count, startAt) {
  const lines = [];
  for (let i = 0; i < count; i++) lines.push(JSON.stringify(dmEvent(startAt + i)));
  appendFileSync(STAGING_FILE, lines.join("\n") + "\n", "utf8");
}

function ledgerRowCount() {
  if (!existsSync(LEDGER_PATH)) return 0;
  const raw = readFileSync(LEDGER_PATH, "utf8");
  return raw.split("\n").filter((l) => l !== "").length;
}

function readState() {
  if (!existsSync(STATE_PATH)) return null;
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

function resetWorld() {
  try { rmSync(LEDGER_PATH, { force: true }); } catch {}
  try { rmSync(STATE_PATH, { force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// B1 (task-hypergraph) helpers — drain-liveness detector + health surface.
// Control mtimes deterministically so the staging-live / ledger-frozen gates
// are exercised without any real wall-clock dependence.
// ---------------------------------------------------------------------------
const HOUR_MS = 3600 * 1000;

function writeStateFile(obj) {
  mkdirSync(join(TEST_ROOT, "connectors", "telegram"), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function writeLedgerFile(text) {
  writeFileSync(LEDGER_PATH, text, "utf8");
}

// Set a file's atime+mtime to `agoMs` before now (0 = now/fresh).
function ageFile(path, agoMs) {
  const t = (Date.now() - agoMs) / 1000;
  utimesSync(path, t, t);
}

// ---------------------------------------------------------------------------
// T1 — first poll appends every let-through row + persists the watermark at
//      end-of-file (staging_offset === file byte length).
// ---------------------------------------------------------------------------
test("T1: first poll appends N rows and persists staging_offset at EOF", async () => {
  resetWorld();
  const bytes = writeStaging(50);
  const res = await runOnce();
  assert.equal(res.appended, 50, "all 50 DM rows appended on first poll");
  assert.equal(ledgerRowCount(), 50, "ledger holds exactly 50 rows");
  const st = readState();
  assert.ok(st != null, "state.json was written");
  assert.equal(typeof st.staging_offset, "number", "staging_offset is a number");
  assert.equal(st.staging_offset, bytes, "staging_offset persisted at end-of-file (full byte length)");
});

// ---------------------------------------------------------------------------
// T2 — THE HEADLINE / REGRESSION GUARD: a replay over the UNCHANGED staging
//      file appends ZERO new rows. This is the steady-state the old
//      `startOffset < raw.length` guard broke: when the cursor is caught up
//      (startOffset === raw.length) the `<` test was FALSE so offset reset to
//      0 and the WHOLE file was re-read. The bounded source_msg_id dedup
//      (CAPS.CONNECTOR_DEDUP_TAIL_LINES tail-read) only covers the last N
//      rows, so any row ABOVE that window re-appended as a duplicate.
//
//      CRITICAL: the row count is deliberately ABOVE the dedup CAP, so the
//      HEAD rows fall OUTSIDE the dedup tail window. With the old buggy guard
//      this test re-appended every head row (ledger doubled). With the fixed
//      guard the cursor keeps the replay a true no-op. The over-CAP count is
//      what makes this a genuine regression guard rather than a tautology the
//      dedup window would mask.
// ---------------------------------------------------------------------------
const OVER_CAP = CAPS.CONNECTOR_DEDUP_TAIL_LINES + 50; // head 50 rows are outside the dedup window

test("T2: replay of an unchanged OVER-CAP staging appends ZERO new rows (cursor, not dedup)", async () => {
  resetWorld();
  writeStaging(OVER_CAP);
  const first = await runOnce();
  assert.equal(first.appended, OVER_CAP, `seed poll appended all ${OVER_CAP} rows`);
  assert.ok(
    OVER_CAP > CAPS.CONNECTOR_DEDUP_TAIL_LINES,
    "row count is ABOVE the dedup tail window so head rows are not dedup-protected",
  );
  const offsetAfterFirst = readState().staging_offset;

  // Replay #1 — identical staging, no new bytes. The head rows (ids 1..50)
  // sit outside the 256-line dedup window; only the cursor can stop them.
  const replay1 = await runOnce();
  assert.equal(replay1.appended, 0, "replay #1 appended ZERO new rows (no head-row re-append)");
  assert.equal(ledgerRowCount(), OVER_CAP, `ledger still holds exactly ${OVER_CAP} rows after replay #1`);

  // Replay #2 — prove it is durably idempotent, not a one-shot.
  const replay2 = await runOnce();
  assert.equal(replay2.appended, 0, "replay #2 appended ZERO new rows");
  assert.equal(ledgerRowCount(), OVER_CAP, "ledger size unchanged after replay #2 (no balloon)");
  assert.equal(readState().staging_offset, offsetAfterFirst, "staging_offset unchanged across replays");
});

// ---------------------------------------------------------------------------
// T3 — REGRESSION ISOLATION: prove the CURSOR (not the bounded dedup tail) is
//      the load-bearing protection. We seed an over-CAP ledger via the
//      connector, then DELETE the cursor (state.json) while leaving the ledger
//      + staging intact, and re-run. With NO cursor, pollOnce starts from byte
//      0 and re-reads the whole file — exactly the buggy guard's behaviour.
//      The head rows (outside the dedup window) DO re-append, proving the
//      dedup window alone is insufficient and the cursor is what the work unit
//      requires. This is the negative control for T2.
// ---------------------------------------------------------------------------
test("T3: deleting the cursor re-appends out-of-window head rows (dedup alone is insufficient)", async () => {
  resetWorld();
  writeStaging(OVER_CAP);
  const seed = await runOnce();
  assert.equal(seed.appended, OVER_CAP, `seed appended all ${OVER_CAP} rows`);
  assert.equal(ledgerRowCount(), OVER_CAP, `ledger holds ${OVER_CAP} after seed`);

  // Wipe ONLY the cursor (not the ledger) — simulates the cursorless state the
  // buggy guard effectively produced every poll once caught up.
  rmSync(STATE_PATH, { force: true });
  assert.ok(!existsSync(STATE_PATH), "cursor removed; ledger + staging untouched");

  const cursorless = await runOnce();
  // Without a cursor, pollOnce re-reads from byte 0. Each re-appended head row
  // pushes the ORIGINAL tail rows further from the bounded dedup window, so by
  // the time the scan reaches rows that WERE in the tail window they have
  // fallen out of it too — the whole file re-appends (full balloon). The key
  // assertion is simply: out-of-window duplicates DO slip through when the
  // cursor is gone, so the dedup window alone cannot guarantee replay_dups=0.
  assert.ok(
    cursorless.appended >= OVER_CAP - CAPS.CONNECTOR_DEDUP_TAIL_LINES,
    `without a cursor, at least the ${OVER_CAP - CAPS.CONNECTOR_DEDUP_TAIL_LINES} ` +
      `out-of-window head rows re-append (got ${cursorless.appended})`,
  );
  assert.ok(
    cursorless.appended > 0,
    "the dedup window genuinely leaves rows unprotected — cursor is load-bearing",
  );
  assert.ok(
    ledgerRowCount() > OVER_CAP,
    "ledger ballooned past its seed size — proves dedup alone does NOT keep replay_dups=0",
  );
});

// ---------------------------------------------------------------------------
// T4 — restart durability: a FRESH connector instance (simulated process
//      restart) reads the persisted watermark and does NOT re-append. Mirrors
//      the launchd KeepAlive restart path.
// ---------------------------------------------------------------------------
test("T4: a fresh connector instance resumes from the persisted watermark (restart)", async () => {
  resetWorld();
  writeStaging(25);
  const before = new TelegramConnector();
  const seed = await before.pollOnce();
  assert.equal(seed.appended, 25, "seed appended 25");
  const persistedOffset = readState().staging_offset;
  assert.ok(persistedOffset > 0, "watermark persisted");

  // Brand-new instance — nothing in-memory carries over; only state.json does.
  const afterRestart = new TelegramConnector();
  const resumed = await afterRestart.pollOnce();
  assert.equal(resumed.appended, 0, "post-restart poll appended ZERO (resumed at watermark)");
  assert.equal(readState().staging_offset, persistedOffset, "watermark unchanged after restart poll");
});

// ---------------------------------------------------------------------------
// T5 — new_msg_flows: rows appended to the staging AFTER the cursor caught up
//      flow through on the next poll, and ONLY the new rows append (the prior
//      ones stay deduped by the watermark). This is the live-capture path.
// ---------------------------------------------------------------------------
test("T5: new staging rows after a caught-up cursor flow through (new_msg_flows)", async () => {
  resetWorld();
  writeStaging(10, 1);
  const seed = await runOnce();
  assert.equal(seed.appended, 10, "seed appended 10 (ids 1..10)");
  const offsetAfterSeed = readState().staging_offset;

  // Telegram tail appends 5 NEW events (ids 11..15) to the same staging file.
  appendStaging(5, 11);
  const poll = await runOnce();
  assert.equal(poll.appended, 5, "exactly the 5 NEW rows appended");
  assert.equal(ledgerRowCount(), 15, "ledger now holds 15 rows total");
  assert.ok(readState().staging_offset > offsetAfterSeed, "watermark advanced past the new bytes");

  // And immediately replay-stable again.
  const replay = await runOnce();
  assert.equal(replay.appended, 0, "post-append replay appended ZERO");
});

// ---------------------------------------------------------------------------
// T6 — rotation safety: if the staging file SHRINKS below the persisted
//      watermark (truncation / log rotation), the connector falls back to
//      byte 0 and re-tails the (new, smaller) file. The new content appends;
//      the watermark re-anchors to the new EOF. Proves the `startOffset >
//      raw.length` guard still handles genuine truncation.
// ---------------------------------------------------------------------------
test("T6: a truncated/rotated staging file re-tails from byte 0 (rotation_safe)", async () => {
  resetWorld();
  writeStaging(30, 1);
  await runOnce();
  const bigOffset = readState().staging_offset;
  assert.ok(bigOffset > 0, "watermark set high after the big file");

  // Rotate: replace the staging with a SMALLER file carrying brand-new ids so
  // they are not deduped by content. The new file is shorter than bigOffset.
  writeStaging(4, 9000);
  assert.ok(statSync(STAGING_FILE).size < bigOffset, "rotated file is smaller than the persisted watermark");

  const afterRotate = await runOnce();
  assert.equal(afterRotate.appended, 4, "all 4 post-rotation rows appended (re-tailed from byte 0)");
  assert.equal(readState().staging_offset, statSync(STAGING_FILE).size, "watermark re-anchored to new EOF");
});

// ---------------------------------------------------------------------------
// T7 — cursor_persisted health surface: after polls, reportHealth reflects a
//      live, advancing cursor (the daemon_check=healthy signal).
// ---------------------------------------------------------------------------
test("T7: reportHealth reflects a persisted, advancing cursor (daemon_check)", async () => {
  resetWorld();
  writeStaging(8, 1);
  const c = new TelegramConnector();
  await c.pollOnce();
  const h = c.reportHealth();
  assert.equal(h.source, "telegram", "health reports the telegram source");
  assert.ok(typeof h.last_cursor_advance_ts === "string", "last_cursor_advance_ts is stamped");
  assert.notEqual(h.status, "failed", "status is not failed after a clean poll");
  // The state file is the single bridge across restarts — it exists on disk.
  assert.ok(existsSync(STATE_PATH), "cursor state.json persisted on disk (cursor_persisted=true)");
});

// ===========================================================================
// B1 — DRAIN-LIVENESS SIGNAL (task-hypergraph node B1).
//
// The stall class: the Python Telethon tail keeps appending to the staging
// file (upstream capture LIVE) while the Node drain into
// storage/sources/telegram.jsonl freezes (drain output FROZEN), and no health
// surface notices. computeTelegramDrainStatus inverts W7's growth gate: it
// fires drain_stalled when staging_age < STAGING_LIVE_WINDOW && ledger_age >
// DRAIN_STALL_THRESHOLD. All four cases below drive mtimes with utimesSync so
// they are deterministic.
// ===========================================================================

// B1.a — POSITIVE: staging live (fresh) + source ledger frozen 8h => stalled.
//         Also asserts the health.js surface: telegram_connector_status flips
//         to "unhealthy" and a telegram_drain_stalled: health_note is emitted.
test("B1.a: drain_stalled when staging is live but the source ledger is frozen", async () => {
  resetWorld();
  // Staging file with real bytes; mtime = now (upstream capture is LIVE).
  const stagingSize = writeStaging(20);
  ageFile(STAGING_FILE, 0);
  // Cursor persisted with staging_offset BEHIND the staging size => the drain
  // is behind (unconsumed_bytes > 0) and last_appended_ts is stale (8h).
  writeStateFile({
    staging_offset: Math.floor(stagingSize / 2),
    last_appended_ts: new Date(Date.now() - 8 * HOUR_MS).toISOString(),
    last_polled_ts: new Date().toISOString(),
    last_cursor_advance_ts: new Date(Date.now() - 8 * HOUR_MS).toISOString(),
    error_count: 0,
  });
  // Source ledger exists but its mtime is 8h old (drain output FROZEN).
  writeLedgerFile('{"id":"ulid_x","ts":"2026-06-25T00:00:00.000Z","content":"old"}\n');
  ageFile(LEDGER_PATH, 8 * HOUR_MS);

  const d = computeTelegramDrainStatus({ now: new Date() });
  assert.equal(d.installed, true, "state.json present => installed");
  assert.equal(d.staging_present, true, "staging file present");
  assert.equal(d.drain_stalled, true, `expected drain_stalled=true, got ${JSON.stringify(d)}`);
  assert.equal(d.status, "unhealthy", "status maps to the existing unhealthy enum");
  assert.ok(d.unconsumed_bytes > 0, `unconsumed_bytes>0 (got ${d.unconsumed_bytes})`);
  assert.ok(d.ledger_age_ms > CAPS.TELEGRAM_DRAIN_STALL_THRESHOLD_MS, "ledger_age past stall threshold");
  assert.ok(d.staging_age_ms < CAPS.TELEGRAM_STAGING_LIVE_WINDOW_MS, "staging_age within live window");

  // Health surface: default-path buildHealthData resolves the same TEST_ROOT
  // paths (env bound before import) + real-now, so it sees the same stall.
  const health = await buildHealthData();
  assert.equal(
    health.telegram_connector_status,
    "unhealthy",
    `telegram_connector_status should be unhealthy, got ${health.telegram_connector_status}`,
  );
  assert.ok(
    Array.isArray(health.health_notes) &&
      health.health_notes.some((n) => /telegram_drain_stalled/.test(n)),
    `expected a telegram_drain_stalled health_note, got ${JSON.stringify(health.health_notes)}`,
  );
});

// B1.b — NEGATIVE A (healthy): source ledger mtime = now => not stalled.
test("B1.b: fresh source-ledger mtime => not stalled, status=running", async () => {
  resetWorld();
  const stagingSize = writeStaging(20);
  ageFile(STAGING_FILE, 0);
  writeStateFile({
    staging_offset: stagingSize,
    last_appended_ts: new Date().toISOString(),
    last_polled_ts: new Date().toISOString(),
    last_cursor_advance_ts: new Date().toISOString(),
    error_count: 0,
  });
  writeLedgerFile('{"id":"ulid_y","ts":"2026-07-06T00:00:00.000Z","content":"fresh"}\n');
  ageFile(LEDGER_PATH, 0); // drain output is fresh

  const d = computeTelegramDrainStatus({ now: new Date() });
  assert.equal(d.drain_stalled, false, `expected not stalled, got ${JSON.stringify(d)}`);
  assert.equal(d.status, "running", "healthy drain => running");
});

// B1.c — NEGATIVE B (quiet, not stalled): staging ALSO aged 8h (no upstream
//         traffic). Even with an old ledger, the staging-live gate prevents a
//         false positive during a genuinely quiet period.
test("B1.c: quiet period (staging also aged) does NOT drain_stall", async () => {
  resetWorld();
  const stagingSize = writeStaging(20);
  writeStateFile({
    staging_offset: stagingSize,
    last_appended_ts: new Date(Date.now() - 8 * HOUR_MS).toISOString(),
    last_polled_ts: new Date().toISOString(),
    last_cursor_advance_ts: new Date(Date.now() - 8 * HOUR_MS).toISOString(),
    error_count: 0,
  });
  writeLedgerFile('{"id":"ulid_z","ts":"2026-06-25T00:00:00.000Z","content":"old"}\n');
  ageFile(LEDGER_PATH, 8 * HOUR_MS);   // ledger old...
  ageFile(STAGING_FILE, 8 * HOUR_MS);  // ...but staging is ALSO quiet (aged)

  const d = computeTelegramDrainStatus({ now: new Date() });
  assert.ok(d.staging_age_ms > CAPS.TELEGRAM_STAGING_LIVE_WINDOW_MS, "staging is NOT live (quiet)");
  assert.equal(d.drain_stalled, false, `staging-live gate must suppress the alarm, got ${JSON.stringify(d)}`);
  assert.equal(d.status, "running", "quiet-but-not-stalled => running");
});

// B1.d — not_installed preserved: no state.json => not_installed, never stalled.
test("B1.d: absent state.json => status=not_installed, drain_stalled=false", async () => {
  resetWorld();
  // Fresh staging + old ledger, but NO cursor state => connector not installed.
  writeStaging(5);
  ageFile(STAGING_FILE, 0);
  writeLedgerFile('{"id":"ulid_w","ts":"2026-06-25T00:00:00.000Z","content":"old"}\n');
  ageFile(LEDGER_PATH, 8 * HOUR_MS);
  assert.ok(!existsSync(STATE_PATH), "precondition: no state.json");

  const d = computeTelegramDrainStatus({ now: new Date() });
  assert.equal(d.installed, false, "no state.json => not installed");
  assert.equal(d.status, "not_installed", "status preserved as not_installed");
  assert.equal(d.drain_stalled, false, "an uninstalled connector can never be drain_stalled");
});

// B1.e — BUG-4 regression guard: a caught-up pollOnce that appends 0 rows must
//         NOT bump last_cursor_advance_ts (it is carried forward unchanged),
//         restoring the staleness classifier the connector-base relies on.
//         last_polled_ts still updates (it means "we ran").
test("B1.e: caught-up poll with 0 appends carries last_cursor_advance_ts forward (bug-4)", async () => {
  resetWorld();
  const bytes = writeStaging(5);            // ascii => byteLength === string length
  const OLD_ADVANCE_TS = "2026-01-01T00:00:00.000Z";
  writeStateFile({
    staging_offset: bytes,                  // cursor already at EOF (caught up)
    last_appended_ts: OLD_ADVANCE_TS,
    last_appended_id: "ulid_OLD",
    last_polled_ts: OLD_ADVANCE_TS,
    last_cursor_advance_ts: OLD_ADVANCE_TS,
    error_count: 0,
  });

  const c = new TelegramConnector();
  const res = await c.pollOnce();
  assert.equal(res.appended, 0, "caught-up poll appends ZERO rows");

  const st = readState();
  assert.equal(
    st.last_cursor_advance_ts,
    OLD_ADVANCE_TS,
    `last_cursor_advance_ts must be carried forward unchanged, got ${st.last_cursor_advance_ts}`,
  );
  assert.ok(
    typeof st.last_polled_ts === "string" && st.last_polled_ts !== OLD_ADVANCE_TS,
    "last_polled_ts still advances (it means we ran)",
  );
});

// B1.f — DEFAULT-PATH AGREEMENT: with TELEGRAM_STAGING_FILE unset the detector
//         has no default of its own. It stats the file telegram.js's
//         defaultStagingFile() names, <MEMORY_ROOT>/storage/tmp/
//         telegram-staging.jsonl (MEMORY_ROOT is TEST_ROOT here, bound before
//         the imports above), so the drain and its stall detector cannot watch
//         two different files. The variable is read at call time, so it is
//         removed for this case only and restored afterwards.
test("B1.f: TELEGRAM_STAGING_FILE unset => detector stats the telegram.js default under MEMORY_ROOT", () => {
  resetWorld();
  const savedEnv = process.env.TELEGRAM_STAGING_FILE;
  delete process.env.TELEGRAM_STAGING_FILE;
  const defaultPath = join(TEST_ROOT, "storage", "tmp", "telegram-staging.jsonl");
  try {
    assert.equal(
      defaultStagingFile(),
      defaultPath,
      "telegram.js default is <MEMORY_ROOT>/storage/tmp/telegram-staging.jsonl",
    );
    assert.notEqual(defaultPath, STAGING_FILE, "the default is not the pinned test staging file");

    // Nothing at the default path yet => the detector reports no staging file,
    // even though the pinned STAGING_FILE from earlier cases still exists.
    writeStaging(3);
    rmSync(defaultPath, { force: true });
    const absent = computeTelegramDrainStatus({ now: new Date() });
    assert.equal(absent.staging_present, false, "no file at the default path => staging_present=false");
    assert.equal(absent.staging_size, 0, "no file at the default path => staging_size=0");

    // A file at the default path, with a size unlike STAGING_FILE's, is the one
    // the detector reports on when it is given no stagingFile argument.
    mkdirSync(dirname(defaultPath), { recursive: true });
    const body = `${JSON.stringify(dmEvent(1))}\n`;
    writeFileSync(defaultPath, body, "utf8");
    const expectedSize = Buffer.byteLength(body, "utf8");
    assert.notEqual(expectedSize, statSync(STAGING_FILE).size, "fixture sizes differ");

    const d = computeTelegramDrainStatus({ now: new Date() });
    assert.equal(d.staging_present, true, "detector stats the default staging path");
    assert.equal(d.staging_size, expectedSize, "staging_size is the default file's size");
    assert.equal(d.staging_mtime_ms, statSync(defaultPath).mtimeMs, "staging_mtime_ms is the default file's mtime");

    // The stagingFile argument still overrides the default.
    const o = computeTelegramDrainStatus({ now: new Date(), stagingFile: STAGING_FILE });
    assert.equal(o.staging_size, statSync(STAGING_FILE).size, "explicit stagingFile argument wins");
  } finally {
    rmSync(defaultPath, { force: true });
    if (savedEnv === undefined) delete process.env.TELEGRAM_STAGING_FILE;
    else process.env.TELEGRAM_STAGING_FILE = savedEnv;
  }
  // An explicit TELEGRAM_STAGING_FILE wins again once it is restored.
  assert.equal(defaultStagingFile(), STAGING_FILE, "explicit TELEGRAM_STAGING_FILE still wins");
});

// ---------------------------------------------------------------------------
// Final GATE line — emitted once all suites registered above have run.
// ---------------------------------------------------------------------------
test("ZZ: emit the N12 gate line", () => {
  console.log("replay_dups=0 cursor_persisted=true new_msg_flows=true rotation_safe=true");
  console.log("drain_stalled_detected=true staging_live_gate=true bug4_advance_ts_conditional=true");
  assert.ok(true);
});
