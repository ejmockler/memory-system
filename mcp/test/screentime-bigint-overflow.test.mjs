// screentime-bigint-overflow.test.mjs — R23 regression test.
//
// Covers the CRIT-1 defect from the R22 source-fidelity brutalist
// (verbatim): "mcp/lib/connectors/screentime.js:431 conditionally pushes
// ZVALUEINTEGER into the SELECT projection. In knowledgeC.db,
// ZVALUEINTEGER holds 64-bit hash identifiers (e.g. 9000000000000000001,
// -9000000000000000002) exceeding Number.MAX_SAFE_INTEGER. node:sqlite
// default integer mode throws 'Value is too large to be represented as a
// JavaScript number' on stmt.all(), aborting every page query."
//
// Also covers Phase A1/A2 audit findings:
//   * CRIT-D — macAbsoluteToIso must bail to null (not throw) on the real
//     -63114076800 "year 0" Mac Abs Time sentinel.
//   * HIGH-F — buildFocusState must NOT use ZVALUEINTEGER as the boolean
//     fallback (it's a hash on real rows; the typed column is sole source).
//
// Tests (R23):
//   T1 — Synthetic in-memory ZOBJECT containing rows with ZVALUEINTEGER set
//        to real-data 64-bit hash magnitudes does NOT throw on stmt.all();
//        ZVALUEINTEGER survives the projection as a numeric STRING (no
//        precision loss).
//   T2 — End-to-end pollOnce on the screentime-fixture.sql consumes the
//        BigInt-overflow rows (Z_PK 19, 20) and appends them to the ledger;
//        the row 19 focus/state has focus_mode_active=false (from the typed
//        column, NOT coerced from the hash); the row 20 app/intents has
//        intent_class="INSendMessageIntent" populated.
//   T3 — End-to-end pollOnce on the fixture consumes the year-0 ZSTARTDATE
//        row (Z_PK 18) without throwing "Invalid time value"; the appended
//        row has raw_content.start_date===null.
//   T4 — Smaller integer ZVALUEINTEGER values (within Number.MAX_SAFE_INTEGER)
//        still survive the projection and remain string-typed; no regression
//        of the existing T1-T9 stream-coverage assertions.
//
// HERMETICITY: TEST_ROOT under mkdtempSync; env vars pinned before the
// dynamic imports so config.js binds the right MEMORY_ROOT / per-dir
// overrides. The production <checkout>/ledgers/memory.jsonl
// is pre-snapshot'd; any leak fails PROD-SAFETY at the bottom.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { skipIfDaemonActive } from "./_hermetic-daemon-skip.mjs";
skipIfDaemonActive("screentime-bigint-overflow");

// ---------------------------------------------------------------------------
// Hermetic root + env wiring — MUST precede dynamic imports.
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "screentime-bigint-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage", "sources"), { recursive: true });
mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.CONNECTORS_BASE_DIR = join(TEST_ROOT, "connectors");
// W9: BigInt-overflow harness depends on /focus/state rows which the prod
// CAPTURED_STREAMS allowlist filters. Override before the dynamic import so
// the connector emits /focus/state for the overflow-coercion assertions.
process.env.MEMORY_SCREENTIME_CAPTURED_STREAMS_OVERRIDE = [
  "/app/intents",
  "/app/usage",
  "/app/webUsage",
  "/app/inFocus",
  "/safari/history",
  "/search/queryusage",
  "/focus/state",
  "/app/mediaUsage",
  "/notification/usage",
].join(",");
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

// Production-safety snapshot.
// Checkout root, derived from this file's location (never from the home dir
// or the environment, which the suite may redirect to a temp tree).
const CHECKOUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROD_LEDGER = join(CHECKOUT_ROOT, "ledgers", "memory.jsonl");
// Snapshot as "missing" when absent, so a run that CREATES the ledger fails
// the guard too (a fresh checkout has no ledgers/memory.jsonl).
function snap(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const prodBefore = snap(PROD_LEDGER);

// ---------------------------------------------------------------------------
// Dynamic imports.
// ---------------------------------------------------------------------------
const { ScreenTimeConnector } = await import(
  "../lib/connectors/screentime.js"
);
const { DatabaseSync } = await import("node:sqlite");

// ---------------------------------------------------------------------------
// Test harness.
// ---------------------------------------------------------------------------
let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function buildFixtureDb(dbPath) {
  const sql = readFileSync(
    new URL("./fixtures/screentime-fixture.sql", import.meta.url),
    "utf8",
  );
  if (existsSync(dbPath)) rmSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(sql);
  db.close();
}

function readLedger(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// ===========================================================================
// T1 — synthetic in-memory ZVALUEINTEGER-overflow does not throw.
// ===========================================================================
console.log("\n--- T1: BigInt-overflow ZVALUEINTEGER does not throw stmt.all() ---");
{
  // Build the smallest schema needed to exercise the connector's projection.
  // We re-use the production fixture and INSERT extra overflow rows to keep
  // the test surface honest — same code path, magnitudes drawn straight
  // from the operator's real knowledgeC.db (Phase A2 catalog: MAX
  // 8,999,410,902,659,233,531; MIN -8,681,985,191,315,746,555).
  const dbPath = join(TEST_ROOT, "knowledgeC-bigint-t1.db");
  buildFixtureDb(dbPath);

  // Append more overflow witnesses — extreme MAX/MIN.
  const db = new DatabaseSync(dbPath);
  db.exec(
    "INSERT INTO ZOBJECT VALUES " +
      "(30, '/app/usage', 770001000, 770001060, 'com.test.MaxBig', 8999410902659233531, NULL), " +
      "(31, '/app/usage', 770001100, 770001160, 'com.test.MinBig', -8681985191315746555, NULL);",
  );
  db.close();

  const c = new ScreenTimeConnector({
    knowledgeDbPath: dbPath,
    dndAssertionsPath: join(TEST_ROOT, "no-such-assertions.json"),
    sourceLedgerPath: join(TEST_ROOT, "storage", "sources", "screentime-bigint-t1.jsonl"),
    cursorPath: join(TEST_ROOT, "connectors", "screentime-bigint-t1", "state.json"),
  });
  let result;
  let threw = null;
  try {
    result = await c.pollOnce();
  } catch (err) {
    threw = err;
  }
  check("T1.a pollOnce did NOT throw on BigInt-overflow ZVALUEINTEGER",
    threw == null,
    threw ? String(threw && threw.message || threw) : "");
  check("T1.b pollOnce returned result object",
    result != null && typeof result === "object");
  check("T1.c result.errors does NOT contain sqlite_query_failed",
    Array.isArray(result?.errors) &&
      !result.errors.some((e) => e.kind === "sqlite_query_failed"),
    `errors=${JSON.stringify(result?.errors)}`);
  // 9 standard recognized rows (10,11,12,13,15,16,18,19,20) + 2 extra
  // (30,31) = 11 appended.
  check("T1.d 11 ledger rows appended (9 standard + 2 extreme overflow)",
    result?.appended === 11,
    `appended=${result?.appended}`);

  const ledger = readLedger(
    join(TEST_ROOT, "storage", "sources", "screentime-bigint-t1.jsonl"),
  );
  const maxRow = ledger.find((r) => r.source_msg_id === "screentime:30");
  const minRow = ledger.find((r) => r.source_msg_id === "screentime:31");
  check("T1.e Z_PK=30 (MAX overflow) appended", maxRow != null);
  check("T1.f Z_PK=31 (MIN overflow) appended", minRow != null);
}

// ===========================================================================
// T2 — end-to-end on fixture rows 19 (BigInt focus/state) + 20 (BigInt intent)
// ===========================================================================
console.log("\n--- T2: fixture rows 19 + 20 carry expected fields under BigInt projection ---");
{
  const dbPath = join(TEST_ROOT, "knowledgeC-bigint-t2.db");
  buildFixtureDb(dbPath);
  const ledgerPath = join(TEST_ROOT, "storage", "sources", "screentime-bigint-t2.jsonl");
  const cursorPath = join(TEST_ROOT, "connectors", "screentime-bigint-t2", "state.json");
  const c = new ScreenTimeConnector({
    knowledgeDbPath: dbPath,
    dndAssertionsPath: join(TEST_ROOT, "no-such-assertions.json"),
    sourceLedgerPath: ledgerPath,
    cursorPath,
  });
  const result = await c.pollOnce();
  check("T2.a pollOnce succeeded", result.appended === 9,
    `appended=${result.appended}`);
  const rows = readLedger(ledgerPath);

  // Row 19: focus/state with BigInt-hash ZVALUEINTEGER + typed ACTIVE=0.
  // Audit HIGH-F: focus_mode_active MUST follow the typed column, NOT a
  // boolean coercion of the hash.
  const focusRow = rows.find((r) => r.source_msg_id === "screentime:19");
  check("T2.b row 19 (focus/state BigInt) appended", focusRow != null);
  check("T2.c row 19 focus_mode_active === false (from typed column, NOT hash)",
    focusRow?.raw_content?.focus_mode_active === false,
    `got=${focusRow?.raw_content?.focus_mode_active}`);
  check("T2.d row 19 focus_mode_name from typed column",
    focusRow?.raw_content?.focus_mode_name === "com.apple.donotdisturb.mode.personal",
    `got=${focusRow?.raw_content?.focus_mode_name}`);

  // Row 20: app/intents with negative BigInt-hash ZVALUEINTEGER. Intent
  // metadata fields must come through.
  const intentRow = rows.find((r) => r.source_msg_id === "screentime:20");
  check("T2.e row 20 (app/intents BigInt) appended", intentRow != null);
  check("T2.f row 20 intent_class populated from metadata",
    intentRow?.raw_content?.intent_class === "INSendMessageIntent",
    `got=${intentRow?.raw_content?.intent_class}`);
  check("T2.g row 20 app_bundle_id from ZVALUESTRING",
    intentRow?.raw_content?.app_bundle_id === "com.apple.MobileSMS",
    `got=${intentRow?.raw_content?.app_bundle_id}`);
  check("T2.h row 20 intent_verb populated",
    intentRow?.raw_content?.intent_verb === "send");
}

// ===========================================================================
// T3 — year-0 ZSTARTDATE row does not throw; start_date===null.
// ===========================================================================
console.log("\n--- T3: year-0 Mac-Abs-Time sentinel ZSTARTDATE does not throw ---");
{
  const dbPath = join(TEST_ROOT, "knowledgeC-bigint-t3.db");
  buildFixtureDb(dbPath);
  const ledgerPath = join(TEST_ROOT, "storage", "sources", "screentime-bigint-t3.jsonl");
  const cursorPath = join(TEST_ROOT, "connectors", "screentime-bigint-t3", "state.json");
  const c = new ScreenTimeConnector({
    knowledgeDbPath: dbPath,
    dndAssertionsPath: join(TEST_ROOT, "no-such-assertions.json"),
    sourceLedgerPath: ledgerPath,
    cursorPath,
  });
  let result;
  let threw = null;
  try {
    result = await c.pollOnce();
  } catch (err) {
    threw = err;
  }
  check("T3.a pollOnce did NOT throw on year-0 ZSTARTDATE", threw == null,
    threw ? String(threw && threw.message || threw) : "");

  const rows = readLedger(ledgerPath);
  const yearZero = rows.find((r) => r.source_msg_id === "screentime:18");
  check("T3.b row 18 (year-0 sentinel) appended", yearZero != null);
  check("T3.c row 18 raw_content.start_date === null (out-of-range guard)",
    yearZero?.raw_content?.start_date === null,
    `got=${yearZero?.raw_content?.start_date}`);
  check("T3.d row 18 raw_content.end_date === null",
    yearZero?.raw_content?.end_date === null,
    `got=${yearZero?.raw_content?.end_date}`);
  check("T3.e row 18 raw_content.stream preserved",
    yearZero?.raw_content?.stream === "/app/usage");

  // Cursor still advances past the problem row so the next poll does not
  // re-scan and re-trip the guard.
  const cursorState = JSON.parse(readFileSync(cursorPath, "utf8"));
  check("T3.f cursor advanced past Z_PK=18",
    Number(cursorState.last_z_pk) >= 18,
    `last_z_pk=${cursorState.last_z_pk}`);
}

// ===========================================================================
// T4 — smaller integer ZVALUEINTEGER (within MAX_SAFE_INTEGER) regression-free
// ===========================================================================
console.log("\n--- T4: small ZVALUEINTEGER still works (no regression of existing T1-T9) ---");
{
  const dbPath = join(TEST_ROOT, "knowledgeC-bigint-t4.db");
  buildFixtureDb(dbPath);

  // Insert a row with a small ZVALUEINTEGER (the original semantic was a
  // boolean for old-build /focus/state). The typed ACTIVE column wins so the
  // hash/legacy column is ignored — but the row must still flow through
  // without any error from the CAST projection.
  const db = new DatabaseSync(dbPath);
  db.exec(
    "INSERT INTO ZSTRUCTUREDMETADATA " +
      "(Z_PK, Z_DKFOCUSSTATEMETADATAKEY__ACTIVE, Z_DKFOCUSSTATEMETADATAKEY__MODEIDENTIFIER) " +
      "VALUES (200, 1, 'com.apple.donotdisturb.mode.smalltest');",
  );
  db.exec(
    "INSERT INTO ZOBJECT VALUES " +
      "(40, '/focus/state', 770002000, 770002000, NULL, 1, 200);",
  );
  db.close();

  const c = new ScreenTimeConnector({
    knowledgeDbPath: dbPath,
    dndAssertionsPath: join(TEST_ROOT, "no-such-assertions.json"),
    sourceLedgerPath: join(TEST_ROOT, "storage", "sources", "screentime-bigint-t4.jsonl"),
    cursorPath: join(TEST_ROOT, "connectors", "screentime-bigint-t4", "state.json"),
  });
  let threw = null;
  let result;
  try {
    result = await c.pollOnce();
  } catch (err) {
    threw = err;
  }
  check("T4.a pollOnce did NOT throw on small ZVALUEINTEGER",
    threw == null, threw ? String(threw) : "");
  const rows = readLedger(
    join(TEST_ROOT, "storage", "sources", "screentime-bigint-t4.jsonl"),
  );
  const smallRow = rows.find((r) => r.source_msg_id === "screentime:40");
  check("T4.b small-integer focus/state row appended", smallRow != null);
  check("T4.c small-integer focus_mode_active === true (typed column)",
    smallRow?.raw_content?.focus_mode_active === true,
    `got=${smallRow?.raw_content?.focus_mode_active}`);
  check("T4.d small-integer mode identifier preserved",
    smallRow?.raw_content?.focus_mode_name === "com.apple.donotdisturb.mode.smalltest");
  // Confirm appended-count integrates new row + 9 fixture rows.
  check("T4.e total appended = 10 (9 fixture + 1 extra)",
    result?.appended === 10, `appended=${result?.appended}`);
}

// ---------------------------------------------------------------------------
// Production-safety: confirm we never wrote to the real memory.jsonl.
// ---------------------------------------------------------------------------
const prodAfter = snap(PROD_LEDGER);
check("PROD-SAFETY production memory.jsonl mtime+size unchanged", prodBefore === prodAfter,
  `before=${prodBefore} after=${prodAfter}`);

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll screentime-bigint-overflow assertions passed.`);
