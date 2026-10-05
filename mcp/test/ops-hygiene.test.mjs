// ops-hygiene — mechanical bars around the four "ops defect" claims raised by
// the 2026-08-11 log/ledger investigation. Exactly ONE of the four was real;
// the other three were misreadings of correct behaviour, so this file pins the
// correct behaviour as a guard against someone "fixing" it into a defect.
//
//   T1  RED-FIRST, the real defect: memory_health's `ledger_byte_counts` was
//       computed from the frozen 3-entry SOURCE_LEDGERS registry
//       (lib/tools/health.js:211-215), so seven production ledgers under
//       storage/sources/ (codex-cli 267MB, mail 350MB, git-log 123MB,
//       screentime, whatsapp, imessage, github-events — 805MB total) were
//       invisible. kb/mcp-surface.md:994-995 declares the map OPEN:
//       `"<source>": integer  // one entry per active source ledger`.
//   T2  GUARD: `source_event_counts` stays CLOSED at three keys.
//   T3  GUARD: `ledger_missing: auto-memory.jsonl` is signal, not noise.
//   T4  GUARD: policy-events disk-bytes vs. active-file semantics (the "51MB
//       active file" claim was the cross-month SUM).
//
// The fifth claim (WAL `applied_offset: 0` == 4h of lag) is falsified by an
// EXISTING test — see the closing comment block; a duplicated copy of a
// passing assertion is not a guard.
//
// Run: node --test test/ops-hygiene.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// HERMETIC PREAMBLE (shape copied from test/health-real-data.test.mjs:35-52).
//
// lib/config.js binds MEMORY_ROOT / POLICY_DIR / STORAGE_DIR / LEDGERS_DIR /
// TELEMETRY_DIR at MODULE LOAD (config.js:34/37/40/43/199), so every env var
// must be set BEFORE the first dynamic import below. Without this pinning,
// buildHealthData() would mkdir under the production storage/health-reducer-
// state/, read the 3.05GB production memory.jsonl, and stat the live policy
// dir. This is a LIVE PRODUCTION SYSTEM — nothing here may touch it.
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "ops-hygiene-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.TELEMETRY_BASE_DIR = join(TEST_ROOT, "telemetry");
process.on("exit", () => {
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const { buildHealthData } = await import("../lib/tools/health.js");
const { policyEventsDiskBytes, currentActiveFile } = await import("../lib/policy-events.js");

// ---------------------------------------------------------------------------
// Shared fixture for T1/T2/T3: ONE buildHealthData call, three assertions.
//
// The sourcesDir holds five one-line ledgers and deliberately NOT
// auto-memory.jsonl — that mirrors production exactly (see T3).
// `scheduleRebuild: () => {}` is resolveOpts' documented override seam
// (lib/tools/health.js:743-746); without it a reducer-state rebuild would be
// spawned as a detached child process.
// ---------------------------------------------------------------------------
const SOURCES_DIR = join(TEST_ROOT, "storage", "sources");
mkdirSync(SOURCES_DIR, { recursive: true });

// Distinct payload lengths so a byte assertion can't pass by coincidence.
const WRITTEN_LEDGERS = {
  "chat-claude-code.jsonl": { ts: "2026-08-11T00:00:00.000Z", source: "chat_claude_code" },
  "telegram.jsonl": { ts: "2026-08-11T00:00:01.000Z", source: "telegram", chat_type: "dm" },
  "codex-cli.jsonl": { ts: "2026-08-11T00:00:02.000Z", source: "codex-cli", body: "xxxxxxxxxx" },
  "mail.jsonl": { ts: "2026-08-11T00:00:03.000Z", source: "mail", body: "xxxxxxxxxxxxxxxxxxxx" },
  "git-log.jsonl": { ts: "2026-08-11T00:00:04.000Z", source: "git-log", body: "xxx" },
};
for (const [name, row] of Object.entries(WRITTEN_LEDGERS)) {
  writeFileSync(join(SOURCES_DIR, name), `${JSON.stringify(row)}\n`, "utf8");
}
// Decoys the discovery pass must NOT pick up: dotfiles and further-suffixed
// siblings that live next to real ledgers in production (.chat-claude-code.lock,
// *.jsonl.offsets, *.jsonl.migrated-*, *.r14-backup).
writeFileSync(join(SOURCES_DIR, ".chat-claude-code.lock"), "lock\n", "utf8");
writeFileSync(join(SOURCES_DIR, ".gitkeep"), "", "utf8");
writeFileSync(join(SOURCES_DIR, "mail.jsonl.offsets"), "0\n", "utf8");
writeFileSync(join(SOURCES_DIR, "codex-cli.jsonl.migrated-1750000000"), "{}\n", "utf8");
writeFileSync(join(SOURCES_DIR, "telegram.jsonl.r14-backup"), "{}\n", "utf8");
mkdirSync(join(SOURCES_DIR, "nested.jsonl"), { recursive: true }); // directory, not a file

const data = await buildHealthData({
  sourcesDir: SOURCES_DIR,
  now: new Date("2026-08-11T06:39:00.000Z"),
  scheduleRebuild: () => {},
});

// ---------------------------------------------------------------------------
// T1 — RED FIRST. The one real defect.
//
// kb/mcp-surface.md:994-995 declares ledger_byte_counts an OPEN map: one entry
// per ACTIVE source ledger. Before the fix, lib/tools/health.js:889-903
// derived it from the same frozen SOURCE_LEDGERS registry that drives the
// CLOSED source_event_counts block, so the map had exactly three keys and the
// 805MB of codex-cli/mail/git-log/screentime/whatsapp/imessage/github-events
// ledgers in production were invisible to memory_health.
//
// The three SOURCE_LEDGERS names must SURVIVE the widening (auto-memory.jsonl
// at 0 bytes is required by T3's note contract), so this asserts a SUPERSET,
// not an exact key set.
// ---------------------------------------------------------------------------
test("T1 ledger_byte_counts is the OPEN union of SOURCE_LEDGERS + every *.jsonl in sourcesDir", () => {
  const keys = Object.keys(data.ledger_byte_counts);
  for (const name of Object.keys(WRITTEN_LEDGERS)) {
    assert.ok(
      keys.includes(name),
      `ledger_byte_counts is missing discovered ledger ${name}; keys=${JSON.stringify(keys.sort())}`,
    );
  }
  // auto-memory.jsonl was NOT written, yet the canonical registry key must
  // still be present (at 0) — the widening must not drop it.
  assert.ok(
    keys.includes("auto-memory.jsonl"),
    `ledger_byte_counts dropped the canonical auto-memory.jsonl key; keys=${JSON.stringify(keys.sort())}`,
  );
  assert.equal(data.ledger_byte_counts["auto-memory.jsonl"], 0);

  // Real byte sizes, not placeholders.
  for (const name of Object.keys(WRITTEN_LEDGERS)) {
    assert.equal(
      data.ledger_byte_counts[name],
      statSync(join(SOURCES_DIR, name)).size,
      `${name} byte count must equal the on-disk size`,
    );
  }

  // Discovery is *.jsonl regular files only: no dotfiles, no further-suffixed
  // siblings, no directories.
  for (const decoy of [
    ".chat-claude-code.lock",
    ".gitkeep",
    "mail.jsonl.offsets",
    "codex-cli.jsonl.migrated-1750000000",
    "telegram.jsonl.r14-backup",
    "nested.jsonl",
  ]) {
    assert.ok(
      !keys.includes(decoy),
      `ledger_byte_counts picked up non-ledger entry ${decoy}`,
    );
  }
});

// ---------------------------------------------------------------------------
// T2 — GUARD: source_event_counts stays a CLOSED 3-key block.
//
// kb/mcp-surface.md:979 "AUTHORITATIVE FIELD SET — single closed block; ... no
// field outside this list may be returned", :981 BEGIN-CANONICAL
// health_envelope_schema_v1 (the block is hash-pinned; the spec must not be
// edited), :989-993 the three keys. This mirrors — rather than duplicates —
// test/health-real-data.test.mjs:211-219, which pins the TOP-LEVEL field set;
// here the bar is on the inner closed block, so a future "just add codex_cli
// to source_event_counts while you're widening the byte map" cannot land.
//
// MUST PASS BEFORE AND AFTER the health.js change: the widening is confined to
// ledger_byte_counts.
// ---------------------------------------------------------------------------
test("T2 source_event_counts stays the closed canonical 3-key block", () => {
  assert.deepEqual(Object.keys(data.source_event_counts).sort(), [
    "auto_memory",
    "chat_claude_code",
    "telegram",
  ]);
});

// ---------------------------------------------------------------------------
// T3 — GUARD: `ledger_missing: auto-memory.jsonl` is SIGNAL, not log noise.
//
// storage/sources/auto-memory.jsonl was never built — the auto-memory bridge
// has not landed (lib/tools/distill-promote-fact.js:27-28: "storage/sources/
// <source>.jsonl files do not yet exist in Phase 1 (the auto-memory bridge has
// not landed)"). The `auto_memory` key is nevertheless REQUIRED by the closed
// canonical block, and lib/tools/health.js:207-210 deliberately chose
// "Missing files contribute 0 + a health_note rather than throwing".
//
// So the note is the designed report of a known gap. Silencing it (by removing
// the note, or by dropping auto-memory.jsonl from the byte map now that the
// map is open) is a recorded rejection. MUST PASS BEFORE AND AFTER.
//
// This also pins the cost discipline of the T1 widening: discovered ledgers
// exist by construction, so the fix adds ZERO new ledger_missing:/
// ledger_stat_error: notes and runs ZERO extra countLines calls — production's
// 267-350MB ledgers must never be line-counted (LINE_COUNT_MAX_BYTES,
// health.js:220).
// ---------------------------------------------------------------------------
test("T3 the auto-memory ledger_missing note survives, and discovery adds no new notes", () => {
  assert.ok(
    data.health_notes.includes("ledger_missing: auto-memory.jsonl"),
    `expected the auto-memory ledger_missing note; got ${JSON.stringify(data.health_notes)}`,
  );
  // Exactly one ledger_missing note (auto-memory.jsonl) and no stat errors:
  // the five written ledgers exist, and the discovery pass must not invent
  // notes for the files it finds.
  const ledgerNotes = data.health_notes.filter(
    (n) => n.startsWith("ledger_missing:") || n.startsWith("ledger_stat_error:"),
  );
  assert.deepEqual(ledgerNotes, ["ledger_missing: auto-memory.jsonl"]);
  // And no line-count work was provoked for the discovered ledgers.
  const skipNotes = data.health_notes.filter((n) =>
    n.startsWith("source_event_count_skipped:") || n.startsWith("source_event_count_read_error:"),
  );
  assert.deepEqual(skipNotes, []);
});

// ---------------------------------------------------------------------------
// T4 — GUARD: policy-events disk-bytes vs. active-file semantics.
//
// FALSIFICATION RECORDED: the brief's "51MB policy-events active file" was
// `policy_events_disk_bytes`, which is the CROSS-MONTH SUM across every
// rotated file (lib/policy-events.js:807-820):
//     32,964 + 11,875,244 + 36,504,648 + 2,860,080 = 51,272,936
// The ACTIVE file (`policy_events_active_file`, lib/policy-events.js:798-803)
// measured 2,860,080 bytes on 2026-08-11. There is no rotation defect.
//
// Genuinely uncovered before this test: no other test in the tree imports
// policyEventsDiskBytes. The decoys pin listRotatedFiles' two filters — the
// FILE_SUFFIX check at lib/policy-events.js:785 and the /^\d{4}-\d{2}$/
// well-formedness check at :786-790, which keeps an operator's archival
// sandbox out of the daemon's view of history.
// ---------------------------------------------------------------------------
test("T4 policyEventsDiskBytes sums well-formed monthly files only; currentActiveFile is the month", () => {
  const policyDir = process.env.POLICY_BASE_DIR;
  mkdirSync(policyDir, { recursive: true });

  // Four well-formed monthly files with distinct known byte sizes.
  const monthly = {
    "policy-events-2026-05.jsonl": 11,
    "policy-events-2026-06.jsonl": 222,
    "policy-events-2026-07.jsonl": 3333,
    "policy-events-2026-08.jsonl": 44444,
  };
  let expectedSum = 0;
  for (const [name, size] of Object.entries(monthly)) {
    writeFileSync(join(policyDir, name), "x".repeat(size), "utf8");
    expectedSum += size;
  }
  assert.equal(expectedSum, 11 + 222 + 3333 + 44444);

  // Decoys: prefix+suffix match but the YYYY-MM segment does not, and a
  // further-suffixed backup. Both must be excluded. Sized non-zero so the
  // exclusion is observable.
  writeFileSync(join(policyDir, "policy-events-corrupt.jsonl"), "x".repeat(999), "utf8");
  writeFileSync(
    join(policyDir, "policy-events-2026-05.jsonl.r14-backup"),
    "x".repeat(9999),
    "utf8",
  );

  assert.equal(
    policyEventsDiskBytes(),
    expectedSum,
    "policy_events_disk_bytes must be the sum of the four well-formed monthly files only",
  );

  // (b) The ACTIVE file is one month's file, resolved from local-time
  // year/month (lib/policy-events.js:588-593) — NOT the sum above.
  assert.ok(
    currentActiveFile({ now: new Date("2026-08-11T12:00:00") }).endsWith(
      "policy-events-2026-08.jsonl",
    ),
  );
  assert.ok(
    currentActiveFile({ now: new Date("2026-07-31T12:00:00") }).endsWith(
      "policy-events-2026-07.jsonl",
    ),
  );
  // And the active file is a small fraction of the sum — the exact shape of
  // the misreading this guard exists to prevent.
  assert.ok(statSync(currentActiveFile({ now: new Date("2026-08-11T12:00:00") })).size < expectedSum);
});

// ---------------------------------------------------------------------------
// CLAIM 4, FALSIFIED — NO TEST WRITTEN HERE ON PURPOSE.
//
// The brief read the index-WAL applied cursor `{applied_seq: N,
// applied_offset: 0}` as ~4 hours of un-applied lag. It is the opposite: it is
// the fully-applied POST-COMPACTION state.
//
//   lib/recall/index-wal.js:1123-1129 — compactWal rewrites the cursor to
//   "{applied_seq: unchanged, applied_offset: 0} and THEN atomically replaces
//   the WAL with an empty file", and only "Iff the applied cursor covers the
//   ENTIRE WAL".
//   lib/recall/index-wal.js:87-88 — "compactWal empties the WAL file once
//   everything is applied, but applied_seq is NEVER reset".
//   lib/recall/index-cache.js:828-836 — _absorbWalTail replays any
//   un-compacted WAL tail into the cached in-memory indices on warm hits, so
//   WAL-resident records are searchable even before compaction. There is no
//   window in which a non-zero WAL tail means stale recall results.
//
// That invariant is ALREADY pinned, exactly, by
// test/recall/index-wal.test.mjs:611-641 (T7 "seq monotonic across
// compaction"), which asserts applied_seq unchanged, applied_offset === 0,
// statSync(walPath).size === 0, and that the next append continues at seq+1.
// Duplicating a passing assertion here would add maintenance surface and zero
// bar. The mechanical guard against a future "WAL lag alarm" keying on
// `applied_offset === 0` is that existing T7 — extend it there, not here.
// ---------------------------------------------------------------------------
