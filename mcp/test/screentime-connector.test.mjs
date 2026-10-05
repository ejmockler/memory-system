// screentime-connector.test.mjs — Phase 2b ScreenTime connector unit tests.
//
// Exercises lib/connectors/screentime.js against a synthetic knowledgeC.db
// built from test/fixtures/screentime-fixture.sql. NEVER reads the real
// ~/Library/Application Support/Knowledge/knowledgeC.db.
//
// Tests:
//   T1 — /app/usage row -> ledger row source="screentime" with
//        source_policy.consent_basis="first_party" and the source_msg_id
//        shape "screentime:<Z_PK>". Verifies the page-filter drops the
//        /audio/now-playing row not in ALLOWED_STREAMS.
//   T2 — Mac Absolute Time conversion: ZSTARTDATE 770000000 maps to
//        2025-05-29T13:33:20.000Z in raw_content.start_date.
//   T3 — Focus folding: synthetic Assertions.json with an active mode
//        whose AssertionStartDateTimestamp predates the event ->
//        raw_content.focus_mode contains the mode identifier.
//   T4 — Cursor restart: runOnce twice; second pollOnce appends 0 because
//        last_z_pk is past the highest fixture Z_PK.
//   T5 — Missing knowledgeC.db -> pollOnce returns {appended:0, errors:[...]}
//        and reportHealth().status === "failed".
//   T6 — /safari/history row produces raw_content.url + raw_content.title
//        populated from ZSTRUCTUREDMETADATA per spec § 1.
//   T7 — /search/queryusage row produces raw_content.query_text populated
//        from ZSTRUCTUREDMETADATA per spec § 1.
//   T8 — /focus/state row produces raw_content.focus_mode_active boolean
//        from the ZSTRUCTUREDMETADATA active column.
//   T9 — Unrecognized stream name (/coreduet/clientstate) is SKIPPED
//        SILENTLY (no error_count increment); cursor still advances past it.
//
// HERMETICITY: TEST_ROOT under mkdtempSync; env vars are set before the
// dynamic imports so config.js binds the right MEMORY_ROOT / per-dir
// overrides. The production <checkout>/ledgers/memory.jsonl
// is pre-snapshot'd; a leak fails the test.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { skipIfDaemonActive } from "./_hermetic-daemon-skip.mjs";
skipIfDaemonActive("screentime-connector");

// ---------------------------------------------------------------------------
// Hermetic root + env wiring — MUST precede dynamic imports.
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "screentime-conn-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage", "sources"), { recursive: true });
mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.CONNECTORS_BASE_DIR = join(TEST_ROOT, "connectors");
// W9: this suite exercises stream extraction across all schemas the connector
// supports, including streams the production CAPTURED_STREAMS allowlist
// filters out (/safari/history, /search/queryusage, /focus/state). Set the
// override BEFORE the dynamic import of the connector so the module-private
// allowlist is constructed wide enough to test extraction for every stream.
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
const { ScreenTimeConnector, pickActiveFocusMode } = await import(
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

// Build a synthetic knowledgeC.db at the given path from the SQL fixture.
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

const LEDGER_PATH = join(TEST_ROOT, "storage", "sources", "screentime.jsonl");

// ===========================================================================
// T1 — /app/usage row -> ledger row first_party + page-filter drops /audio
// ===========================================================================
console.log("\n--- T1: app-usage ledger row + page-filter ---");
{
  const dbPath = join(TEST_ROOT, "knowledgeC-t1.db");
  buildFixtureDb(dbPath);
  const c = new ScreenTimeConnector({
    knowledgeDbPath: dbPath,
    dndAssertionsPath: join(TEST_ROOT, "no-such-assertions.json"),
  });
  const result = await c.pollOnce();
  check("T1.a pollOnce returns appended>=1", result.appended >= 1, JSON.stringify(result));
  const rows = readLedger(LEDGER_PATH);
  // Allowed rows: Z_PK 10,11,12,13,15,16 + R23 fixtures 18,19,20 (= 9 rows).
  // Filtered: Z_PK 14 (/audio/now-playing) and Z_PK 17 (/coreduet/clientstate)
  // pre-existing; R27 HIGH-G additions Z_PK 21 (/knowledge-sync-deletion-
  // bookmark/<UUID>) and Z_PK 22 (/display/isBacklit) silently skipped too.
  check("T1.b ledger contains exactly 9 allowed-stream rows (audio+coreduet+knowledge-sync+display dropped)",
    rows.length === 9,
    `rows=${rows.length}: ${rows.map((r) => r.source_msg_id).join(",")}`);

  const audioRow = rows.find((r) => r.raw_content?.stream === "/audio/now-playing");
  check("T1.c /audio/now-playing was filtered out", audioRow == null);
  const coreduetRow = rows.find((r) => r.raw_content?.stream === "/coreduet/clientstate");
  check("T1.c2 /coreduet/clientstate (unrecognized) was filtered out",
    coreduetRow == null);
  // R27 HIGH-G: real prod knowledgeC.db has 827 daily /display/isBacklit rows
  // and 100+ daily /knowledge-sync-deletion-bookmark/<UUID> rows. Both must be
  // silently dropped (not emitted, not error-tagged).
  const knowledgeSyncRow = rows.find((r) =>
    typeof r.raw_content?.stream === "string" &&
    r.raw_content.stream.startsWith("/knowledge-sync-deletion-bookmark/"));
  check("T1.c3 /knowledge-sync-deletion-bookmark/<UUID> (HIGH-G) was filtered out",
    knowledgeSyncRow == null);
  const displayRow = rows.find((r) => r.raw_content?.stream === "/display/isBacklit");
  check("T1.c4 /display/isBacklit (HIGH-G) was filtered out", displayRow == null);

  const usage = rows.find((r) => r.source_msg_id === "screentime:10");
  check("T1.d source_msg_id shape 'screentime:<Z_PK>'", usage != null);
  check("T1.e source stamped = screentime", usage?.source === "screentime");
  check("T1.f consent_basis = first_party",
    usage?.source_policy?.consent_basis === "first_party");
  check("T1.g deletion_semantics = full_excise",
    usage?.source_policy?.deletion_semantics === "full_excise");
  check("T1.h raw_content.stream preserved", usage?.raw_content?.stream === "/app/usage");
  check("T1.i raw_content.app_bundle_id present for /app/usage",
    usage?.raw_content?.app_bundle_id === "com.apple.Safari");
  check("T1.j parties is ['user']",
    Array.isArray(usage?.parties) && usage.parties.length === 1 && usage.parties[0] === "user");
  check("T1.k id stamped (ulid_)", typeof usage?.id === "string" && usage.id.startsWith("ulid_"));
  check("T1.l checksum stamped", typeof usage?.checksum === "string" && /^[0-9a-f]{32}$/.test(usage.checksum));

  // Stream-specific fields: /safari/history row should have .url set, not bundle id.
  const safari = rows.find((r) => r.source_msg_id === "screentime:12");
  check("T1.m safari/history row has url",
    safari?.raw_content?.url === "https://example.com/page");
  check("T1.n safari/history row has null app_bundle_id",
    safari?.raw_content?.app_bundle_id == null);

  // /search/queryusage row should have .query_text set (spec § 1).
  const spotlight = rows.find((r) => r.source_msg_id === "screentime:13");
  check("T1.o spotlight row has query_text",
    spotlight?.raw_content?.query_text === "screen time research",
    `got=${spotlight?.raw_content?.query_text}`);
}

// ===========================================================================
// T2 — Mac Absolute Time -> ISO-8601 unix epoch in raw_content.start_date
// ===========================================================================
console.log("\n--- T2: Mac Absolute Time -> ISO unix epoch ---");
{
  // ZSTARTDATE 770000000 (Mac Abs) + 978307200 = 1748307200 unix sec
  // -> 2025-05-27T00:53:20.000Z
  const rows = readLedger(LEDGER_PATH);
  const usage = rows.find((r) => r.source_msg_id === "screentime:10");
  check("T2.a start_date is ISO-8601",
    typeof usage?.raw_content?.start_date === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(usage.raw_content.start_date));
  check("T2.b 770000000 Mac-abs == 2025-05-27T00:53:20.000Z",
    usage?.raw_content?.start_date === "2025-05-27T00:53:20.000Z",
    `got ${usage?.raw_content?.start_date}`);
  check("T2.c end_date is ISO-8601 60s after start",
    usage?.raw_content?.end_date === "2025-05-27T00:54:20.000Z",
    `got ${usage?.raw_content?.end_date}`);

  // pickActiveFocusMode pure-function sanity check.
  const sampleAssertions = {
    "uuid-1": {
      ModeAssertionEnabled: true,
      ModeIdentifier: "com.apple.donotdisturb.mode.work",
      // 769999000 Mac-abs is ~16 minutes before our event, so it should win.
      AssertionStartDateTimestamp: 769999000,
    },
  };
  const fm = pickActiveFocusMode(sampleAssertions, "2025-05-27T00:53:20.000Z");
  check("T2.d pickActiveFocusMode picks active mode preceding event",
    fm === "com.apple.donotdisturb.mode.work", `got ${fm}`);

  // Future-start assertions are ignored.
  const futureAssertions = {
    "uuid-x": {
      ModeAssertionEnabled: true,
      ModeIdentifier: "com.apple.donotdisturb.mode.future",
      AssertionStartDateTimestamp: 999999999, // far in the future relative to event
    },
  };
  const fmFut = pickActiveFocusMode(futureAssertions, "2025-05-27T00:53:20.000Z");
  check("T2.e pickActiveFocusMode ignores future-start assertion", fmFut === null);

  // Disabled assertions are ignored.
  const offAssertions = {
    "uuid-off": {
      ModeAssertionEnabled: false,
      ModeIdentifier: "com.apple.donotdisturb.mode.off",
      AssertionStartDateTimestamp: 769999000,
    },
  };
  const fmOff = pickActiveFocusMode(offAssertions, "2025-05-27T00:53:20.000Z");
  check("T2.f pickActiveFocusMode ignores ModeAssertionEnabled=false", fmOff === null);
}

// ===========================================================================
// T3 — Focus folding into raw_content via end-to-end pollOnce.
// ===========================================================================
console.log("\n--- T3: Focus/DND folded from Assertions.json ---");
{
  const dbPath = join(TEST_ROOT, "knowledgeC-t3.db");
  buildFixtureDb(dbPath);
  const assertionsPath = join(TEST_ROOT, "Assertions.json");
  writeFileSync(
    assertionsPath,
    JSON.stringify({
      "uuid-active": {
        ModeAssertionEnabled: true,
        ModeIdentifier: "com.apple.donotdisturb.mode.deepwork",
        // 769999000 Mac-abs = 1748519800 unix = 2025-05-29T13:16:40Z, well
        // before our fixture event ZSTARTDATE=770000000.
        AssertionStartDateTimestamp: 769999000,
      },
    }),
    { mode: 0o600 },
  );

  // Fresh tmp connectors dir to avoid T1's cursor (we want a clean append).
  const cursorPath = join(TEST_ROOT, "connectors", "screentime-t3", "state.json");
  const ledgerPath = join(TEST_ROOT, "storage", "sources", "screentime-t3.jsonl");
  const c = new ScreenTimeConnector({
    knowledgeDbPath: dbPath,
    dndAssertionsPath: assertionsPath,
    sourceLedgerPath: ledgerPath,
    cursorPath,
  });
  const result = await c.pollOnce();
  check("T3.a pollOnce appended rows", result.appended >= 1);
  const rows = readLedger(ledgerPath);
  const usage = rows.find((r) => r.source_msg_id === "screentime:10");
  check("T3.b raw_content.focus_mode folded in",
    usage?.raw_content?.focus_mode === "com.apple.donotdisturb.mode.deepwork",
    `got ${usage?.raw_content?.focus_mode}`);

  // Missing Assertions.json -> focus_mode stays null but pollOnce succeeds.
  const cursorPath2 = join(TEST_ROOT, "connectors", "screentime-t3b", "state.json");
  const ledgerPath2 = join(TEST_ROOT, "storage", "sources", "screentime-t3b.jsonl");
  const c2 = new ScreenTimeConnector({
    knowledgeDbPath: dbPath,
    dndAssertionsPath: join(TEST_ROOT, "no-such-file.json"),
    sourceLedgerPath: ledgerPath2,
    cursorPath: cursorPath2,
  });
  const r2 = await c2.pollOnce();
  check("T3.c pollOnce succeeds when Assertions.json missing", r2.appended >= 1);
  const rows2 = readLedger(ledgerPath2);
  const u2 = rows2.find((r) => r.source_msg_id === "screentime:10");
  check("T3.d focus_mode null when Assertions.json absent",
    u2?.raw_content?.focus_mode == null);
}

// ===========================================================================
// T4 — Cursor restart: second pollOnce appends 0.
// ===========================================================================
console.log("\n--- T4: cursor restart -> idempotent ---");
{
  const dbPath = join(TEST_ROOT, "knowledgeC-t4.db");
  buildFixtureDb(dbPath);
  const cursorPath = join(TEST_ROOT, "connectors", "screentime-t4", "state.json");
  const ledgerPath = join(TEST_ROOT, "storage", "sources", "screentime-t4.jsonl");
  const c = new ScreenTimeConnector({
    knowledgeDbPath: dbPath,
    dndAssertionsPath: join(TEST_ROOT, "no-such-file.json"),
    sourceLedgerPath: ledgerPath,
    cursorPath,
  });

  const r1 = await c.runOnce();
  check("T4.a first runOnce appended rows", r1.appended >= 6,
    `appended=${r1.appended}`);
  const rowsAfter1 = readLedger(ledgerPath);
  const r2 = await c.runOnce();
  check("T4.b second runOnce appends 0 (cursor advanced)", r2.appended === 0,
    `r2.appended=${r2.appended}`);
  const rowsAfter2 = readLedger(ledgerPath);
  check("T4.c ledger size unchanged on second poll",
    rowsAfter2.length === rowsAfter1.length,
    `before=${rowsAfter1.length} after=${rowsAfter2.length}`);

  // Cursor state surfaces last_z_pk for restart recovery.
  const cursorRaw = readFileSync(cursorPath, "utf8");
  const cursorState = JSON.parse(cursorRaw);
  check("T4.d cursor state carries last_z_pk", Number.isInteger(cursorState.last_z_pk));
  // Highest fixture Z_PK after R27 HIGH-G additions is 22 (/display/isBacklit).
  // Cursor must advance past it even though the row is silently skipped, or
  // every poll would re-scan and re-skip a real-prod 827-rows/day stream.
  check("T4.e last_z_pk advanced past highest fixture Z_PK (22)",
    cursorState.last_z_pk >= 22, `last_z_pk=${cursorState.last_z_pk}`);
  check("T4.f cursor state carries last_cursor_advance_ts",
    typeof cursorState.last_cursor_advance_ts === "string");
}

// ===========================================================================
// T5 — Missing knowledgeC.db -> graceful error + reportHealth status=failed.
// ===========================================================================
console.log("\n--- T5: missing knowledgeC.db -> failed status ---");
{
  const missingDb = join(TEST_ROOT, "no-such-knowledgeC.db");
  const cursorPath = join(TEST_ROOT, "connectors", "screentime-t5", "state.json");
  const ledgerPath = join(TEST_ROOT, "storage", "sources", "screentime-t5.jsonl");
  const c = new ScreenTimeConnector({
    knowledgeDbPath: missingDb,
    dndAssertionsPath: join(TEST_ROOT, "no-such-assertions.json"),
    sourceLedgerPath: ledgerPath,
    cursorPath,
  });

  const result = await c.pollOnce();
  check("T5.a missing DB -> pollOnce returns appended=0", result.appended === 0);
  check("T5.b errors array has the knowledgeC_missing tag",
    Array.isArray(result.errors) && result.errors.length === 1 &&
    result.errors[0].kind === "knowledgeC_missing");
  check("T5.c ledger never created", !existsSync(ledgerPath));

  const h = c.reportHealth();
  check("T5.d reportHealth() returns status=failed", h.status === "failed",
    `status=${h.status}`);

  // Subsequent runs with the DB present recover and clear the failed status.
  const recoveredDb = join(TEST_ROOT, "knowledgeC-t5-recovered.db");
  buildFixtureDb(recoveredDb);
  const c2 = new ScreenTimeConnector({
    knowledgeDbPath: recoveredDb,
    dndAssertionsPath: join(TEST_ROOT, "no-such-assertions.json"),
    sourceLedgerPath: ledgerPath,
    cursorPath,
  });
  const r2 = await c2.pollOnce();
  check("T5.e poll after recovery appends rows", r2.appended >= 1,
    `appended=${r2.appended}`);
  const h2 = c2.reportHealth();
  check("T5.f reportHealth() recovers to ok after first successful page",
    h2.status === "ok", `status=${h2.status}`);
}

// ===========================================================================
// T6 — /safari/history row carries raw_content.url + raw_content.title from
//      ZSTRUCTUREDMETADATA per spec § 1.
// ===========================================================================
console.log("\n--- T6: /safari/history url+title from ZSTRUCTUREDMETADATA ---");
{
  const dbPath = join(TEST_ROOT, "knowledgeC-t6.db");
  buildFixtureDb(dbPath);
  const ledgerPath = join(TEST_ROOT, "storage", "sources", "screentime-t6.jsonl");
  const cursorPath = join(TEST_ROOT, "connectors", "screentime-t6", "state.json");
  const c = new ScreenTimeConnector({
    knowledgeDbPath: dbPath,
    dndAssertionsPath: join(TEST_ROOT, "no-such-assertions.json"),
    sourceLedgerPath: ledgerPath,
    cursorPath,
  });
  await c.pollOnce();
  const rows = readLedger(ledgerPath);
  const safari = rows.find((r) => r.source_msg_id === "screentime:12");
  check("T6.a /safari/history row exists", safari != null);
  check("T6.b raw_content.url populated from metadata",
    safari?.raw_content?.url === "https://example.com/page",
    `got=${safari?.raw_content?.url}`);
  check("T6.c raw_content.title populated from metadata",
    safari?.raw_content?.title === "Example Page Title",
    `got=${safari?.raw_content?.title}`);
  check("T6.d raw_content.stream preserved", safari?.raw_content?.stream === "/safari/history");
}

// ===========================================================================
// T7 — /search/queryusage row carries raw_content.query_text from
//      ZSTRUCTUREDMETADATA per spec § 1.
// ===========================================================================
console.log("\n--- T7: /search/queryusage query_text from ZSTRUCTUREDMETADATA ---");
{
  const dbPath = join(TEST_ROOT, "knowledgeC-t7.db");
  buildFixtureDb(dbPath);
  const ledgerPath = join(TEST_ROOT, "storage", "sources", "screentime-t7.jsonl");
  const cursorPath = join(TEST_ROOT, "connectors", "screentime-t7", "state.json");
  const c = new ScreenTimeConnector({
    knowledgeDbPath: dbPath,
    dndAssertionsPath: join(TEST_ROOT, "no-such-assertions.json"),
    sourceLedgerPath: ledgerPath,
    cursorPath,
  });
  await c.pollOnce();
  const rows = readLedger(ledgerPath);
  const spotlight = rows.find((r) => r.source_msg_id === "screentime:13");
  check("T7.a /search/queryusage row exists", spotlight != null);
  check("T7.b raw_content.query_text populated",
    spotlight?.raw_content?.query_text === "screen time research",
    `got=${spotlight?.raw_content?.query_text}`);
  check("T7.c raw_content.stream preserved",
    spotlight?.raw_content?.stream === "/search/queryusage");
}

// ===========================================================================
// T8 — /focus/state row carries raw_content.focus_mode_active boolean from
//      the metadata active column.
// ===========================================================================
console.log("\n--- T8: /focus/state focus_mode_active boolean ---");
{
  const dbPath = join(TEST_ROOT, "knowledgeC-t8.db");
  buildFixtureDb(dbPath);
  const ledgerPath = join(TEST_ROOT, "storage", "sources", "screentime-t8.jsonl");
  const cursorPath = join(TEST_ROOT, "connectors", "screentime-t8", "state.json");
  const c = new ScreenTimeConnector({
    knowledgeDbPath: dbPath,
    dndAssertionsPath: join(TEST_ROOT, "no-such-assertions.json"),
    sourceLedgerPath: ledgerPath,
    cursorPath,
  });
  await c.pollOnce();
  const rows = readLedger(ledgerPath);
  const focusState = rows.find((r) => r.source_msg_id === "screentime:16");
  check("T8.a /focus/state row exists", focusState != null);
  check("T8.b raw_content.focus_mode_active is a boolean",
    typeof focusState?.raw_content?.focus_mode_active === "boolean",
    `type=${typeof focusState?.raw_content?.focus_mode_active}`);
  check("T8.c raw_content.focus_mode_active === true (active assertion)",
    focusState?.raw_content?.focus_mode_active === true,
    `got=${focusState?.raw_content?.focus_mode_active}`);
  check("T8.d raw_content.stream preserved",
    focusState?.raw_content?.stream === "/focus/state");
}

// ===========================================================================
// T9 — unrecognized stream name is SKIPPED SILENTLY (no error_count
//      increment); the cursor still advances past it.
// ===========================================================================
console.log("\n--- T9: unrecognized stream skipped silently ---");
{
  const dbPath = join(TEST_ROOT, "knowledgeC-t9.db");
  buildFixtureDb(dbPath);
  const ledgerPath = join(TEST_ROOT, "storage", "sources", "screentime-t9.jsonl");
  const cursorPath = join(TEST_ROOT, "connectors", "screentime-t9", "state.json");
  const c = new ScreenTimeConnector({
    knowledgeDbPath: dbPath,
    dndAssertionsPath: join(TEST_ROOT, "no-such-assertions.json"),
    sourceLedgerPath: ledgerPath,
    cursorPath,
  });
  const result = await c.pollOnce();
  // The unrecognized-stream rows are Z_PK=17 (/coreduet/clientstate), Z_PK=21
  // (/knowledge-sync-deletion-bookmark/<UUID>), and Z_PK=22 (/display/isBacklit).
  // None should emit a ledger row.
  const rows = readLedger(ledgerPath);
  const coreduet = rows.find((r) => r.raw_content?.stream === "/coreduet/clientstate");
  check("T9.a no ledger row emitted for /coreduet/clientstate", coreduet == null);
  // R27 HIGH-G assertions: real prod has 827 daily isBacklit rows + 100+
  // daily knowledge-sync rows. Both must be silently dropped.
  const knowledgeSync = rows.find((r) =>
    typeof r.raw_content?.stream === "string" &&
    r.raw_content.stream.startsWith("/knowledge-sync-deletion-bookmark/"));
  check("T9.a2 no ledger row for /knowledge-sync-deletion-bookmark/<UUID> (HIGH-G)",
    knowledgeSync == null);
  const display = rows.find((r) => r.raw_content?.stream === "/display/isBacklit");
  check("T9.a3 no ledger row for /display/isBacklit (HIGH-G)", display == null);

  // No error tag should fire — the rows are silently skipped, not errors.
  const cursorState = JSON.parse(readFileSync(cursorPath, "utf8"));
  const errorCount = Number(cursorState.error_count || 0);
  check("T9.b cursor.error_count is 0 (silent skip across all 3 unrecognized streams)",
    errorCount === 0, `error_count=${errorCount}`);

  // Cursor must advance past the highest unrecognized Z_PK (22) so that
  // future polls don't re-scan and re-skip thousands of real-prod rows.
  check("T9.c cursor.last_z_pk advanced past Z_PK=22 (highest unrecognized row)",
    cursorState.last_z_pk >= 22, `last_z_pk=${cursorState.last_z_pk}`);

  // The result.errors array (per-call) should also be empty.
  check("T9.d pollOnce errors[] is empty",
    Array.isArray(result.errors) && result.errors.length === 0,
    `errors=${JSON.stringify(result.errors)}`);
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
console.log(`\nAll screentime-connector assertions passed.`);
