// connector-base.test.mjs — Phase 2b connector-base unit tests.
//
// Exercises lib/connectors/index.js:
//   T1 — appendLedgerRow: first append succeeds, dup source_msg_id rejects.
//   T2 — writeCursor/readCursor round-trip + atomic-write semantics
//        (tmp-without-rename leaves prior state intact).
//   T3 — applyConnectorRevoke appends kind:"policy" policy_kind:
//        "connector_revoke" to ledgers/memory.jsonl.
//   T4 — reportHealth returns status="degraded" once error_count >=
//        CAPS.CONNECTOR_ERROR_THRESHOLD.
//   T5 — listInstalledConnectors enumerates only connectors/<source>/ dirs
//        that contain a state.json; subdirs without state files are ignored.
//   T6 — _isDuplicate tail-read is BYTE-bounded (regression for the
//        whole-file readFileSync that dies past Node's ~512 MiB max string
//        length, whose catch-all silently disabled dedup). Synthetic ledger
//        larger than the byte window; in-window dup caught, out-of-window
//        dups slip through per the documented contract; non-ENOENT read
//        errors reject loudly instead of failing open.
//
// HERMETICITY: per the standing C-NEW-2 discipline, all env vars are set
// BEFORE the dynamic imports. Every disk write lands inside mkdtempSync;
// the live install is untouched. Post-exit cleanup
// rmSync's the tmpdir.
//
// Run: node test/connector-base.test.mjs

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";

import { skipIfDaemonActive } from "./_hermetic-daemon-skip.mjs";
skipIfDaemonActive("connector-base");

// ---------------------------------------------------------------------------
// Hermetic root — MUST happen before any dynamic import of the module under
// test or any module it transitively imports (config.js binds MEMORY_ROOT
// at module-init via the `process.env.MEMORY_ROOT || homedir()/..."` rule).
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "connector-base-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage", "sources"), { recursive: true });
mkdirSync(join(TEST_ROOT, "connectors"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.CONNECTORS_BASE_DIR = join(TEST_ROOT, "connectors");
process.on("exit", () => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

// Production-safety pre-snapshot: capture mtime+size of the real memory.jsonl
// so we can re-stat at exit and fail loudly if a test write leaked.
const PROD_LEDGER = join(homedir(), "memory-system", "ledgers", "memory.jsonl");
let prodBefore = null;
try { const st = statSync(PROD_LEDGER); prodBefore = { mtimeMs: st.mtimeMs, size: st.size }; } catch {}

// ---------------------------------------------------------------------------
// Dynamic imports — bind inside TEST_ROOT.
// ---------------------------------------------------------------------------
const {
  ConnectorBase,
  listInstalledConnectors,
  applyConnectorRevoke,
  DEDUP_TAIL_AVG_LINE_BYTES,
  DEDUP_TAIL_MIN_READ_BYTES,
} = await import("../lib/connectors/index.js");
const {
  memoryLedgerPath,
  connectorStatePath,
  connectorsDir,
  STORAGE_DIR,
} = await import("../lib/config.js");
const { CAPS } = await import("../lib/validation.js");

// ---------------------------------------------------------------------------
// Test harness
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

// First-party constant classifier the four impl agents would supply.
function firstPartyPolicy(/* row */) {
  return { deletion_semantics: "full_excise", consent_basis: "first_party" };
}

// ===========================================================================
// T1 — appendLedgerRow dedupes on source_msg_id
// ===========================================================================
console.log("\n--- T1: appendLedgerRow dedupes on source_msg_id ---");
{
  const source = "imessage";
  const c = new ConnectorBase({ source, sourcePolicyForRow: firstPartyPolicy });
  const ledgerPath = join(STORAGE_DIR, "sources", `${source}.jsonl`);

  const r1 = await c.appendLedgerRow({
    source_msg_id: "imsg_ROWID_1",
    parties: ["user", "+15551234567"],
    raw_content: { text: "hi", is_from_me: 1 },
  });
  check("T1.a first append returns appended=true", r1.appended === true, JSON.stringify(r1));
  check("T1.b source_msg_id round-trips on the return shape", r1.source_msg_id === "imsg_ROWID_1");
  check("T1.c ledger file exists", existsSync(ledgerPath));

  // Verify the on-disk line carries the stamped fields.
  const raw = readFileSync(ledgerPath, "utf8").trim();
  const lines = raw.split("\n");
  check("T1.d exactly one row on disk", lines.length === 1, `got ${lines.length}`);
  const row = JSON.parse(lines[0]);
  check("T1.e source stamped", row.source === source);
  check("T1.f source_msg_id preserved", row.source_msg_id === "imsg_ROWID_1");
  check(
    "T1.g source_policy stamped via classifier",
    row.source_policy?.consent_basis === "first_party" &&
      row.source_policy?.deletion_semantics === "full_excise",
  );
  check("T1.h ts stamped (ISO-8601)", typeof row.ts === "string" && /^\d{4}-/.test(row.ts));
  check("T1.i id stamped", typeof row.id === "string" && row.id.startsWith("ulid_"));
  check("T1.j checksum stamped (hex 32 chars)", typeof row.checksum === "string" && /^[0-9a-f]{32}$/.test(row.checksum));
  check("T1.k parties[] preserved", Array.isArray(row.parties) && row.parties.length === 2);
  check("T1.l raw_content preserved", row.raw_content?.text === "hi");

  // Second append with the SAME source_msg_id → dedupe hit.
  const r2 = await c.appendLedgerRow({
    source_msg_id: "imsg_ROWID_1",
    parties: ["user", "+15551234567"],
    raw_content: { text: "hi (duplicate path)", is_from_me: 1 },
  });
  check("T1.m duplicate source_msg_id returns appended=false", r2.appended === false, JSON.stringify(r2));

  // File should still have exactly 1 line.
  const raw2 = readFileSync(ledgerPath, "utf8").trim();
  check("T1.n no second row appended on dedupe hit", raw2.split("\n").length === 1);

  // A different source_msg_id appends normally.
  const r3 = await c.appendLedgerRow({
    source_msg_id: "imsg_ROWID_2",
    parties: ["user", "+15551234567"],
    raw_content: { text: "second message", is_from_me: 0 },
  });
  check("T1.o distinct source_msg_id appends", r3.appended === true);
  const raw3 = readFileSync(ledgerPath, "utf8").trim();
  check("T1.p ledger now has 2 rows", raw3.split("\n").length === 2);
}

// ===========================================================================
// T2 — writeCursor/readCursor round-trip + atomic-write semantics
// ===========================================================================
console.log("\n--- T2: writeCursor/readCursor round-trip ---");
{
  const source = "screentime-knowledgec";
  const c = new ConnectorBase({ source, sourcePolicyForRow: firstPartyPolicy });
  const cursorPath = connectorStatePath(source);

  // Initial: no cursor on disk.
  const c0 = await c.readCursor();
  check("T2.a readCursor returns null when state.json absent", c0 === null);

  // Write a cursor and read it back.
  const state1 = {
    cursor: 12345,
    last_appended_ts: "2026-06-02T12:00:00.000Z",
    last_appended_id: "ulid_AAAA",
    last_cursor_advance_ts: "2026-06-02T12:00:00.000Z",
    error_count: 0,
  };
  await c.writeCursor(state1);
  check("T2.b state.json exists after writeCursor", existsSync(cursorPath));
  const c1 = await c.readCursor();
  check("T2.c round-trip preserves cursor", c1?.cursor === 12345);
  check("T2.d round-trip preserves last_appended_ts", c1?.last_appended_ts === state1.last_appended_ts);
  check("T2.e round-trip preserves last_appended_id", c1?.last_appended_id === state1.last_appended_id);

  // mode 0600 enforced
  const st = statSync(cursorPath);
  check("T2.f cursor file mode is 0600", (st.mode & 0o777) === 0o600, `mode=${(st.mode & 0o777).toString(8)}`);

  // Atomic-across-crash: simulate by writing a tmp-file that is never
  // renamed. The previous state.json must still be readable. We hand-craft
  // a tmp file alongside the real cursor and verify readCursor still returns
  // the LAST SUCCESSFUL state.
  const dir = dirname(cursorPath);
  const orphanTmp = join(dir, "state.json.tmp.orphan");
  writeFileSync(orphanTmp, "{\"cursor\": 99999, \"corrupt\": true}", { mode: 0o600 });
  const c2 = await c.readCursor();
  check("T2.g readCursor ignores orphan .tmp file", c2?.cursor === 12345, `got cursor=${c2?.cursor}`);
  check("T2.h orphan tmp does not corrupt state", c2?.last_appended_id === state1.last_appended_id);
  // Cleanup the orphan so it doesn't affect later tests.
  rmSync(orphanTmp);

  // Subsequent write overwrites cleanly.
  const state2 = { ...state1, cursor: 67890, error_count: 0 };
  await c.writeCursor(state2);
  const c3 = await c.readCursor();
  check("T2.i second writeCursor overwrites prior state", c3?.cursor === 67890);
}

// ===========================================================================
// T3 — applyConnectorRevoke appends kind:"policy" connector_revoke to memory.jsonl
// ===========================================================================
console.log("\n--- T3: applyConnectorRevoke ---");
{
  const ledgerPath = memoryLedgerPath();
  const beforeSize = existsSync(ledgerPath) ? statSync(ledgerPath).size : 0;

  const row = await applyConnectorRevoke({
    source: "imessage",
    opts: { reason: "operator_requested_via_mcp" },
  });

  check("T3.a applyConnectorRevoke returned a row", row != null && typeof row === "object");
  check("T3.b kind is policy", row.kind === "policy");
  check("T3.c policy_kind is connector_revoke", row.policy_kind === "connector_revoke");
  check("T3.d target_source matches", row.target_source === "imessage");
  check("T3.e ts is ISO-8601", typeof row.ts === "string" && /^\d{4}-/.test(row.ts));
  check("T3.f id stamped", typeof row.id === "string" && row.id.startsWith("mem_"));
  check("T3.g checksum stamped", typeof row.checksum === "string" && /^[0-9a-f]{32}$/.test(row.checksum));
  check("T3.h reason preserved", row.reason === "operator_requested_via_mcp");

  check("T3.i memory.jsonl exists after revoke", existsSync(ledgerPath));
  const tailLine = readFileSync(ledgerPath, "utf8").trim().split("\n").pop();
  const parsed = JSON.parse(tailLine);
  check("T3.j on-disk row matches return", parsed.policy_kind === "connector_revoke" && parsed.target_source === "imessage");

  // Second revoke for a different source — verifies append-only semantics
  // and that opts.reason is optional.
  const row2 = await applyConnectorRevoke({ source: "screentime-knowledgec" });
  check("T3.k second revoke succeeds", row2.target_source === "screentime-knowledgec");
  check("T3.l second revoke without opts has no reason field", row2.reason === undefined);
  const afterSize = statSync(ledgerPath).size;
  check("T3.m memory.jsonl grew", afterSize > beforeSize);
}

// ===========================================================================
// T4 — reportHealth returns status="degraded" once error_count >= threshold
// ===========================================================================
console.log("\n--- T4: reportHealth degraded gating ---");
{
  const source = "git-log-local";
  const c = new ConnectorBase({ source, sourcePolicyForRow: firstPartyPolicy });

  // Fresh: no state -> status=ok.
  const h0 = c.reportHealth();
  check("T4.a no state -> status=ok", h0.status === "ok");
  check("T4.b no state -> error_rate=0", h0.error_rate === 0);
  check("T4.c source echoed", h0.source === source);

  // Below threshold -> still ok.
  await c.writeCursor({
    cursor: 0,
    last_appended_ts: new Date().toISOString(),
    last_appended_id: null,
    last_cursor_advance_ts: new Date().toISOString(),
    error_count: 1,
  });
  const h1 = c.reportHealth();
  check("T4.d 1 error -> status=ok (below threshold)", h1.status === "ok");
  check("T4.e error_rate scales below threshold", h1.error_rate > 0 && h1.error_rate < 1);

  // At threshold -> degraded.
  await c.writeCursor({
    cursor: 0,
    last_appended_ts: new Date().toISOString(),
    last_appended_id: null,
    last_cursor_advance_ts: new Date().toISOString(),
    error_count: CAPS.CONNECTOR_ERROR_THRESHOLD,
  });
  const h2 = c.reportHealth();
  check("T4.f at threshold -> status=degraded", h2.status === "degraded", `status=${h2.status} count=${CAPS.CONNECTOR_ERROR_THRESHOLD}`);
  check("T4.g error_rate clamped to 1.0", h2.error_rate === 1);

  // Above threshold -> still degraded.
  await c.writeCursor({
    cursor: 0,
    last_appended_ts: new Date().toISOString(),
    last_appended_id: null,
    last_cursor_advance_ts: new Date().toISOString(),
    error_count: CAPS.CONNECTOR_ERROR_THRESHOLD * 3,
  });
  const h3 = c.reportHealth();
  check("T4.h above threshold -> still degraded", h3.status === "degraded");

  // tagError increments correctly.
  await c.writeCursor({ cursor: 0, error_count: 0, last_cursor_advance_ts: new Date().toISOString() });
  await c.tagError("sqlite_locked");
  const after = await c.readCursor();
  check("T4.i tagError increments error_count", after?.error_count === 1);
  check("T4.j tagError records last_error_kind", after?.last_error_kind === "sqlite_locked");
}

// ===========================================================================
// T5 — listInstalledConnectors enumerates only dirs with state.json
// ===========================================================================
console.log("\n--- T5: listInstalledConnectors ---");
{
  const baseDir = connectorsDir();
  // Clean any prior connectors/* state from T2 + T4 so we control the set.
  for (const ent of readdirSync(baseDir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      rmSync(join(baseDir, ent.name), { recursive: true, force: true });
    }
  }

  // Connector A: has state.json
  mkdirSync(join(baseDir, "imessage"), { recursive: true, mode: 0o700 });
  writeFileSync(join(baseDir, "imessage", "state.json"), JSON.stringify({
    cursor: 100,
    last_appended_ts: "2026-06-02T10:00:00.000Z",
    last_appended_id: "ulid_X",
    last_cursor_advance_ts: new Date().toISOString(),
    error_count: 0,
  }), { mode: 0o600 });

  // Connector B: has state.json, error_count above threshold -> degraded
  mkdirSync(join(baseDir, "github-events"), { recursive: true, mode: 0o700 });
  writeFileSync(join(baseDir, "github-events", "state.json"), JSON.stringify({
    cursor: "etag_xyz",
    last_appended_ts: "2026-06-01T08:00:00.000Z",
    last_appended_id: "ulid_Y",
    last_cursor_advance_ts: "2026-06-01T08:00:00.000Z",
    error_count: CAPS.CONNECTOR_ERROR_THRESHOLD + 2,
  }), { mode: 0o600 });

  // Connector C: directory exists BUT no state.json -> should be skipped.
  mkdirSync(join(baseDir, "screentime-knowledgec"), { recursive: true, mode: 0o700 });
  // intentionally no state.json

  // Non-directory entry: should also be skipped.
  writeFileSync(join(baseDir, "stray-file"), "noise", { mode: 0o600 });

  const list = listInstalledConnectors();
  check("T5.a exactly 2 connectors listed", list.length === 2, `got ${list.length}: ${JSON.stringify(list)}`);
  const sources = list.map((c) => c.source).sort();
  check("T5.b sources are the two with state.json", JSON.stringify(sources) === JSON.stringify(["github-events", "imessage"]));
  const imsg = list.find((c) => c.source === "imessage");
  check("T5.c imessage status is ok", imsg.status === "ok", `status=${imsg.status}`);
  check("T5.d imessage last_appended_ts surfaced", imsg.last_appended_ts === "2026-06-02T10:00:00.000Z");
  const gh = list.find((c) => c.source === "github-events");
  check("T5.e github-events status is degraded (error_count above threshold)", gh.status === "degraded");
}

// ===========================================================================
// T6 — bounded dedup tail-read (regression for whole-ledger readFileSync)
// ===========================================================================
// The dedup-window CONTRACT under test (lib/connectors/index.js header § 3 +
// the CAPS.CONNECTOR_DEDUP_TAIL_LINES comment in validation.js): only the
// last dedupTailLines lines are scanned, and out-of-window duplicates slip
// through BY DESIGN (salience-layer corroboration absorbs the long tail).
// What changed in the fix: the read feeding that scan is now byte-bounded
// (positional readSync of the last max(N * avg, floor) bytes) instead of
// readFileSync of the whole file, and non-ENOENT read errors rethrow instead
// of silently returning "not a duplicate".
console.log("\n--- T6: bounded dedup tail-read ---");
{
  const source = "bounded-dedup";
  const dedupTailLines = 8;
  const c = new ConnectorBase({ source, sourcePolicyForRow: firstPartyPolicy, dedupTailLines });
  const ledgerPath = join(STORAGE_DIR, "sources", `${source}.jsonl`);
  const windowBytes = Math.max(
    dedupTailLines * DEDUP_TAIL_AVG_LINE_BYTES,
    DEDUP_TAIL_MIN_READ_BYTES,
  );

  // Build a synthetic ledger of ~1 KiB rows whose total size EXCEEDS the
  // byte window, so line 1 lies beyond what the bounded read can see.
  const pad = "x".repeat(900);
  const mkLine = (id) => JSON.stringify({
    id: "ulid_SYNTHETIC",
    ts: "2026-07-01T00:00:00.000Z",
    source,
    source_msg_id: id,
    parties: [],
    raw_content: { pad },
    attachments: [],
    source_policy: { deletion_semantics: "full_excise", consent_basis: "first_party" },
  }) + "\n";
  const lineCount = Math.ceil(windowBytes / mkLine("sizing_probe").length) + 60;
  const ids = ["dup_beyond_byte_window"];
  for (let i = 1; i < lineCount; i++) ids.push(`filler_${i}`);
  ids[ids.length - 20] = "dup_in_bytes_but_out_of_line_window"; // inside byte window, outside 8-line window
  ids[ids.length - 3] = "dup_in_tail"; // inside the 8-line window
  writeFileSync(ledgerPath, ids.map(mkLine).join(""), { mode: 0o600 });
  const ledgerSize = statSync(ledgerPath).size;
  check("T6.a synthetic ledger exceeds the byte window", ledgerSize > windowBytes,
    `size=${ledgerSize} window=${windowBytes}`);

  // In-window duplicate (3 lines from the end) is caught — this exercises
  // the positional read + partial-first-line drop on a file bigger than the
  // window.
  const rTail = await c.appendLedgerRow({ source_msg_id: "dup_in_tail", raw_content: { pad } });
  check("T6.b tail duplicate within the line window returns appended=false",
    rTail.appended === false, JSON.stringify(rTail));

  // Inside the byte window but OUTSIDE the dedupTailLines budget: slips
  // through per the documented out-of-window contract — the byte bound must
  // not silently WIDEN the line window either.
  const rLines = await c.appendLedgerRow({
    source_msg_id: "dup_in_bytes_but_out_of_line_window",
    raw_content: { pad },
  });
  check("T6.c duplicate beyond the line window slips through (documented contract)",
    rLines.appended === true, JSON.stringify(rLines));

  // ...and now that it was re-appended it IS in the tail, so a further
  // append dedupes.
  const rLines2 = await c.appendLedgerRow({
    source_msg_id: "dup_in_bytes_but_out_of_line_window",
    raw_content: { pad },
  });
  check("T6.d re-append of the now-in-tail id dedupes", rLines2.appended === false);

  // Beyond the byte window entirely (line 1 of the ledger): slips through —
  // same out-of-window semantics, now byte-bounded.
  const rBytes = await c.appendLedgerRow({ source_msg_id: "dup_beyond_byte_window", raw_content: { pad } });
  check("T6.e duplicate beyond the byte window slips through", rBytes.appended === true);

  // Failure-mode split: ENOENT stays "not a duplicate" (first-ever append —
  // T1 covers it end-to-end); any OTHER read error must reject loudly
  // instead of silently disabling dedup. A symlinked ledger trips
  // O_NOFOLLOW with ELOOP (never ENOENT) on both macOS and Linux.
  const eloopSource = "bounded-dedup-eloop";
  const realTarget = join(STORAGE_DIR, "sources", `${eloopSource}-target.jsonl`);
  writeFileSync(realTarget, mkLine("target_row"), { mode: 0o600 });
  const eloopLedger = join(STORAGE_DIR, "sources", `${eloopSource}.jsonl`);
  symlinkSync(realTarget, eloopLedger);
  const cEloop = new ConnectorBase({ source: eloopSource, sourcePolicyForRow: firstPartyPolicy });
  let thrown = null;
  try {
    await cEloop.appendLedgerRow({ source_msg_id: "eloop_probe", raw_content: {} });
  } catch (e) {
    thrown = e;
  }
  check("T6.f non-ENOENT ledger read error rejects loudly (no silent dedup-off)",
    thrown != null && thrown.code === "ELOOP",
    `err=${thrown && (thrown.code || thrown.message)}`);
}

// ---------------------------------------------------------------------------
// Production-safety: confirm we never wrote to the real memory.jsonl.
// ---------------------------------------------------------------------------
let prodAfter = null;
try { const st = statSync(PROD_LEDGER); prodAfter = { mtimeMs: st.mtimeMs, size: st.size }; } catch {}
if (prodBefore != null && prodAfter != null) {
  const intact = prodBefore.mtimeMs === prodAfter.mtimeMs && prodBefore.size === prodAfter.size;
  check("PROD-SAFETY production memory.jsonl mtime+size unchanged", intact,
    `before=${JSON.stringify(prodBefore)} after=${JSON.stringify(prodAfter)}`);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll connector-base assertions passed.`);
