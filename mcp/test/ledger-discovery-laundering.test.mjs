// ledger-discovery-laundering.test.mjs — the DISCOVERED half of
// memory_health's `ledger_byte_counts` must not launder absence into a value,
// and must be covered by the same string-cap probe as the registry half.
//
// WHY THIS SUITE EXISTS. `buildHealthData` fills `ledger_byte_counts` from two
// halves: a loop over the frozen 3-entry SOURCE_LEDGERS registry, and a
// discovery pass that walks readdirSync(sourcesDir, { withFileTypes: true }) and
// adds every other *.jsonl file. The discovery pass did exactly one thing per
// candidate:
//
//     ledgerByteCounts[name] = safeStatBytes(pathFor(sourcesDir, name)).bytes;
//
// safeStatBytes returns { bytes, exists, error } and collapses EVERY failure to
// bytes: 0. Throwing away `exists` and `error` republishes an unreadable ledger
// to the operator as a confident `0` — the same "absence reported as a value"
// failure that made an unreadable 3 GB ledger indistinguishable from an empty
// one for ten weeks, recurring inside the reporting layer built to report it.
//
// Second, the `ledger_over_string_cap:` probe was applied to the two main
// ledgers and the three registry ledgers but NOT to discovered ones. Node's
// string cap on this machine is
// require("node:buffer").constants.MAX_STRING_LENGTH = 536,870,888 bytes
// (measured this session, Node v24.15.0). Measured live this session via
// `ls -la storage/sources`: mail.jsonl = 349,643,964 bytes (0.6513x of the cap
// and growing), codex-cli.jsonl = 267,613,242, git-log.jsonl = 123,854,983 —
// these are LIVE append-only files, so the last is a moving snapshot (it read
// 123,652,041 in the brief written earlier the same day).
// All three are DISCOVERED, not registry — the three largest ledgers in the
// tree were invisible to the check that exists to warn about them.
//
// T5 is the non-vacuity control: a healthy tree must emit NONE of the probes.
// Without it every probe here could be hardcoded always-on and the suite would
// still be green.
//
// HERMETICITY: one mkdtempSync tree per case, `scheduleRebuild: () => {}` in
// every opts object (the real scheduler spawns a DETACHED child process), and
// no production path is ever passed to buildHealthData. This is a live system:
// nothing under ledgers/, indices/, storage/ or connectors/ is touched.
//
// Run: node --test test/ledger-discovery-laundering.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  statSync,
  chmodSync,
  openSync,
  writeSync,
  ftruncateSync,
  closeSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/config.js binds its paths at module-load time, so these MUST be set
// before the dynamic import below (pattern: health-read-failures.test.mjs).
// Probes that take no path override (telegram drain, effective-empty-rate,
// cursor lag) resolve through config.js and would otherwise read the LIVE tree.
const ENV_ROOT = mkdtempSync(join(tmpdir(), "memsys-ledger-discovery-env-"));
mkdirSync(join(ENV_ROOT, "policy"), { recursive: true });
mkdirSync(join(ENV_ROOT, "storage"), { recursive: true });
mkdirSync(join(ENV_ROOT, "ledgers"), { recursive: true });
process.env.MEMORY_ROOT = ENV_ROOT;
process.env.POLICY_BASE_DIR = join(ENV_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(ENV_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(ENV_ROOT, "ledgers");
process.env.TELEMETRY_BASE_DIR = join(ENV_ROOT, "telemetry");

const TEMP_ROOTS = [ENV_ROOT];
process.on("exit", () => {
  for (const dir of TEMP_ROOTS) {
    try {
      // Defensive: a case that chmod-ed a dir 0444 and died before its finally
      // would otherwise leave an undeletable tree behind.
      chmodSync(join(dir, "storage", "sources"), 0o755);
    } catch {
      /* not every root has one */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

const { buildHealthData } = await import("../lib/tools/health.js");

const NOW = new Date("2026-08-11T12:00:00Z");

// Measured this session: require("node:buffer").constants.MAX_STRING_LENGTH on
// Node v24.15.0 (`node --version`) === 536870888.
const REAL_STRING_CAP = 536870888;

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "memsys-ledger-discovery-"));
  TEMP_ROOTS.push(root);
  mkdirSync(join(root, "ledgers"), { recursive: true });
  mkdirSync(join(root, "storage", "sources"), { recursive: true });
  mkdirSync(join(root, "storage", "health-reducer-state"), { recursive: true });
  mkdirSync(join(root, "indices"), { recursive: true });
  return root;
}

function optsFor(root, extra) {
  return {
    sourcesDir: join(root, "storage", "sources"),
    memoryLedgerPath: join(root, "ledgers", "memory.jsonl"),
    recallLogPath: join(root, "ledgers", "recall.jsonl"),
    indicesDir: join(root, "indices"),
    healthStateDir: join(root, "storage", "health-reducer-state"),
    now: NOW,
    // MUST be stubbed: the real scheduler spawns a detached rebuild child.
    scheduleRebuild: () => {},
    // Defeat the in-process warm envelope cache between calls.
    envelopeCacheBucketMs: 1,
    ...(extra || {}),
  };
}

// Deterministic filler, same shape as health-read-failures.test.mjs so the
// healthy reducer path is exercised, not just the throw path.
function jsonlBytes(approxBytes) {
  const lines = [];
  let total = 0;
  let i = 0;
  while (total < approxBytes) {
    const line =
      JSON.stringify({
        ts: "2026-08-11T00:00:00.000Z",
        type: "fact",
        id: `f${i}`,
        pad: "x".repeat(40),
      }) + "\n";
    lines.push(line);
    total += Buffer.byteLength(line);
    i += 1;
  }
  return lines.join("");
}

// A SPARSE over-the-real-cap ledger. Apparent length 600,000,011 bytes for
// 8,192 bytes of real disk — measured this session with `du -k` on the produced
// file ("8  <path>"), build time 0 ms. This is what lets T1 assert against the
// DEFAULT cap (536,870,888) instead of an injected toy cap.
function writeSparseOverCapLedger(absPath) {
  const fd = openSync(absPath, "w");
  try {
    writeSync(fd, Buffer.from('{"ts":"2026-08-11T00:00:00.000Z","type":"fact"}\n'));
    ftruncateSync(fd, 600_000_000);
    const tail = Buffer.from('{"t":"zz"}\n'); // exactly 11 bytes
    writeSync(fd, tail, 0, tail.length, 600_000_000);
  } finally {
    closeSync(fd);
  }
  return 600_000_011;
}

// ---------------------------------------------------------------------------
// T1 — a DISCOVERED ledger past the REAL cap. No cap injection: this is the
// production configuration, exercised against the production threshold.
// ---------------------------------------------------------------------------
test("T1 discovered over-cap ledger is named at the real default cap, with no line count", async () => {
  const root = makeRoot();
  const p = join(root, "storage", "sources", "mail.jsonl");
  const apparentBytes = writeSparseOverCapLedger(p);

  // (a) FIXTURE-VALIDITY POSITIVE CONTROL. If this does not throw, the fixture
  // is not actually over the string cap and every assertion below is vacuous —
  // so the suite must fail loudly here rather than pass on a shrunken file.
  // Measured this session: throws ERR_STRING_TOO_LONG in 224 ms.
  let readErr = null;
  try {
    readFileSync(p, "utf8");
  } catch (e) {
    readErr = e;
  }
  assert.ok(readErr, "fixture invalid: readFileSync(utf8) must throw on an over-cap file");
  assert.equal(
    readErr.code,
    "ERR_STRING_TOO_LONG",
    `fixture invalid: expected ERR_STRING_TOO_LONG, got ${readErr.code}`,
  );
  assert.equal(statSync(p).size, apparentBytes, "fixture invalid: apparent size drifted");

  // stringCapBytes deliberately NOT overridden — the real 536,870,888 applies.
  const data = await buildHealthData(optsFor(root));
  const notes = data.health_notes;

  // (b) the note exists and carries bytes/cap/ratio.
  const capNotes = notes.filter((n) => n.startsWith("ledger_over_string_cap: mail.jsonl"));
  assert.ok(
    capNotes.length > 0,
    `expected a ledger_over_string_cap: mail.jsonl note, got ${JSON.stringify(notes)}`,
  );
  const note = capNotes[0];
  assert.ok(note.includes(`bytes=${apparentBytes}`), `note must carry bytes=600000011, got ${note}`);
  assert.ok(note.includes(`cap=${REAL_STRING_CAP}`), `note must carry cap=536870888, got ${note}`);
  assert.match(note, /ratio=\d+\.\d+/, "note must carry ratio=");

  // (c) the byte count is the real measured size, not a laundered 0.
  assert.equal(data.ledger_byte_counts["mail.jsonl"], apparentBytes);

  // (d) THE NON-VACUOUS NO-LINE-COUNT BAR. countLines() readFileSync's the whole
  // file and refuses anything over LINE_COUNT_MAX_BYTES = 1,048,576 bytes by
  // pushing `source_event_count_skipped:`. This fixture is 600,000,011 bytes —
  // 572x that budget — so if ANYONE ever wires a discovered ledger into
  // countLines, the skip note (or a read_error note on the ERR_STRING_TOO_LONG)
  // appears and this assertion fails. That is precisely why the bar is
  // falsifiable rather than decorative: a 4 KB fixture could never fail it.
  for (const prefix of ["source_event_count_skipped:", "source_event_count_read_error:"]) {
    assert.ok(
      !notes.some((n) => n.startsWith(prefix)),
      `a discovered ledger must never be line-counted; got ${prefix} in ${JSON.stringify(notes)}`,
    );
  }
  // source_event_counts stays the CLOSED canonical 3-key block: discovery must
  // never widen it (kb/mcp-surface.md; ops-hygiene.test.mjs T2).
  assert.deepEqual(Object.keys(data.source_event_counts).sort(), [
    "auto_memory",
    "chat_claude_code",
    "telegram",
  ]);

  // (e) one fault, one note: mail.jsonl is not in SOURCE_LEDGERS, so the
  // registry half must not also fire for it.
  assert.equal(
    capNotes.length,
    1,
    `exactly one ledger_over_string_cap: note may mention mail.jsonl, got ${JSON.stringify(capNotes)}`,
  );
});

// ---------------------------------------------------------------------------
// T2 — registry/discovery PARITY at an injected tiny cap.
//
// MEASURED PRE-FIX, verbatim from this file's RED run against the unmodified
// health.js — only the registry half fired:
//   AssertionError [ERR_ASSERTION]: discovered mail.jsonl must emit
//   ledger_over_string_cap: — got ["ledger_over_string_cap: auto-memory.jsonl
//   bytes=4202 cap=1024 ratio=4.10 — whole-file readFileSync(utf8) of this
//   ledger throws ERR_STRING_TOO_LONG","ledger_missing: chat-claude-code.jsonl",
//   "ledger_missing: telegram.jsonl","rederive jobs not yet implemented (Phase 2)"]
// Two byte-identical 4,202-byte files, one on each side of the same threshold,
// and only one of them was reported.
// ---------------------------------------------------------------------------
test("T2 registry and discovered ledgers both trip the cap at an injected cap", async () => {
  const root = makeRoot();
  const sources = join(root, "storage", "sources");
  const payload = jsonlBytes(4096);
  writeFileSync(join(sources, "auto-memory.jsonl"), payload); // registry half
  writeFileSync(join(sources, "mail.jsonl"), payload); // discovered half

  const data = await buildHealthData(optsFor(root, { stringCapBytes: 1024 }));
  const notes = data.health_notes;

  const registryNote = notes.find((n) => n.startsWith("ledger_over_string_cap: auto-memory.jsonl"));
  assert.ok(
    registryNote,
    `registry auto-memory.jsonl must emit ledger_over_string_cap: — got ${JSON.stringify(notes)}`,
  );
  const discoveredNote = notes.find((n) => n.startsWith("ledger_over_string_cap: mail.jsonl"));
  assert.ok(
    discoveredNote,
    `discovered mail.jsonl must emit ledger_over_string_cap: — got ${JSON.stringify(notes)}`,
  );

  // Same single formatter on both sides: the strings may not drift.
  assert.match(discoveredNote, /cap=1024/, "note must carry the effective cap=");
  assert.match(discoveredNote, /ratio=\d+\.\d+/, "note must carry ratio=");
  const bytes = statSync(join(sources, "mail.jsonl")).size;
  assert.ok(discoveredNote.includes(`bytes=${bytes}`), `note must carry the real byte count`);

  // Both byte counts are still published.
  assert.equal(data.ledger_byte_counts["auto-memory.jsonl"], bytes);
  assert.equal(data.ledger_byte_counts["mail.jsonl"], bytes);
});

// ---------------------------------------------------------------------------
// T3 — THE LAUNDERING. An unreadable ledger must be ABSENT from the map, never
// present at 0.
//
// chmod 0444 on sourcesDir leaves it readable (readdirSync succeeds) but not
// searchable (statSync on any entry throws EACCES). Measured this session on
// uid 501 / Node v24.15.0: readdirSync returned [["x.jsonl",true]] while
// statSync on that same entry threw EACCES — i.e. readdir+stat is a genuine
// TOCTOU/permission pair, not a theoretical one.
//
// null is unavailable for ledger_byte_counts (kb/mcp-surface.md's
// health_envelope_schema_v1 block is hash-pinned to `integer`), so a failed
// stat means NO KEY and the signal rides in health_notes.
// ---------------------------------------------------------------------------
test("T3 an unreadable discovered ledger is absent from ledger_byte_counts, not 0", async (t) => {
  const root = makeRoot();
  const sources = join(root, "storage", "sources");
  writeFileSync(join(sources, "mail.jsonl"), jsonlBytes(2048)); // discovered, non-zero
  writeFileSync(join(sources, "telegram.jsonl"), jsonlBytes(2048)); // registry

  chmodSync(sources, 0o444);
  try {
    // FIXTURE-EFFECTIVENESS GATE. Under uid 0 the mode bits are bypassed and
    // statSync succeeds, which would make every assertion below vacuously
    // green. Skip loudly instead of passing silently.
    let gateErr = null;
    try {
      statSync(join(sources, "mail.jsonl"));
    } catch (e) {
      gateErr = e;
    }
    if (!gateErr || gateErr.code !== "EACCES") {
      t.skip(
        `fixture ineffective: statSync on a 0444 sourcesDir did not throw EACCES ` +
          `(code=${gateErr ? gateErr.code : "none"}, process.getuid()=${
            typeof process.getuid === "function" ? process.getuid() : "n/a"
          }) — permission bits are being bypassed, so this case cannot be exercised here`,
      );
      return;
    }

    const data = await buildHealthData(optsFor(root));
    const notes = data.health_notes;

    // (a) the laundering itself: NO key at all for an unmeasurable ledger.
    assert.equal(
      Object.prototype.hasOwnProperty.call(data.ledger_byte_counts, "mail.jsonl"),
      false,
      `an unreadable ledger must be ABSENT from ledger_byte_counts, never present at 0; ` +
        `got ${JSON.stringify(data.ledger_byte_counts)}`,
    );

    // (b) the signal rides in health_notes instead.
    assert.ok(
      notes.includes("ledger_stat_error: mail.jsonl: EACCES"),
      `expected "ledger_stat_error: mail.jsonl: EACCES", got ${JSON.stringify(notes)}`,
    );

    // (c) unreadable is NOT missing.
    assert.ok(
      !notes.some((n) => n.startsWith("ledger_missing: mail.jsonl")),
      "an unreadable discovered ledger must not be laundered into ledger_missing:",
    );

    // (d) the registry half under the same fault: same discipline, one note.
    const telegramStatErrors = notes.filter((n) => n.startsWith("ledger_stat_error: telegram.jsonl"));
    assert.deepEqual(
      telegramStatErrors,
      ["ledger_stat_error: telegram.jsonl: EACCES"],
      `the registry telegram.jsonl must emit its EACCES exactly once (no duplicate from the ` +
        `discovery pass re-statting the same name), got ${JSON.stringify(telegramStatErrors)}`,
    );
    assert.ok(
      !notes.some((n) => n.startsWith("ledger_missing: telegram.jsonl")),
      "an unreadable registry ledger must not ALSO be reported as missing",
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(data.ledger_byte_counts, "telegram.jsonl"),
      false,
      "a stat-errored registry ledger must not be published at a laundered 0 either",
    );
  } finally {
    chmodSync(sources, 0o755);
  }
});

// ---------------------------------------------------------------------------
// T4 — SYMLINK CONSISTENCY (secondary bar).
//
// HONESTY NOTE: a default install has no symlinked ledger under
// storage/sources (`find <MEMORY_ROOT>/storage/sources -maxdepth 1 -type l`
// prints nothing). This is a CONSISTENCY fix, not a live defect: the registry
// half already counted a symlinked ledger (safeStatBytes -> statSync follows
// links) while the discovery half silently dropped it, because dirent.isFile()
// is false for a symlink. Two halves of one map disagreeing about what a ledger
// is, is the bug.
// ---------------------------------------------------------------------------
test("T4 symlinked ledgers are counted at target size; dangling ones error; decoys stay out", async () => {
  const root = makeRoot();
  const sources = join(root, "storage", "sources");
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });

  const bigTarget = join(outside, "mail-target.jsonl");
  const smallTarget = join(outside, "telegram-target.jsonl");
  writeFileSync(bigTarget, "x".repeat(5000));
  writeFileSync(smallTarget, "y".repeat(600));
  assert.equal(statSync(bigTarget).size, 5000, "fixture invalid: target size drifted");
  assert.equal(statSync(smallTarget).size, 600, "fixture invalid: target size drifted");

  symlinkSync(bigTarget, join(sources, "mail.jsonl")); // discovered, via symlink
  symlinkSync(smallTarget, join(sources, "telegram.jsonl")); // registry, via symlink
  symlinkSync(join(outside, "nope-does-not-exist.jsonl"), join(sources, "ghost.jsonl"));

  // Decoy discipline (mirrors ops-hygiene.test.mjs's fixture) must survive the
  // widened type gate: a DIRECTORY named *.jsonl, a dotfile, and further-
  // suffixed siblings are all still non-ledgers.
  mkdirSync(join(sources, "nested.jsonl"), { recursive: true });
  writeFileSync(join(sources, ".gitkeep"), "");
  writeFileSync(join(sources, "mail.jsonl.offsets"), "0\n");
  writeFileSync(join(sources, "telegram.jsonl.r14-backup"), "{}\n");

  const data = await buildHealthData(optsFor(root));
  const notes = data.health_notes;
  const counts = data.ledger_byte_counts;

  assert.equal(
    counts["mail.jsonl"],
    5000,
    `a discovered symlink-to-file must be counted at its TARGET size; got ${JSON.stringify(counts)}`,
  );
  assert.equal(
    counts["telegram.jsonl"],
    600,
    `the registry half already followed symlinks; got ${JSON.stringify(counts)}`,
  );

  // A dangling symlink: readdir saw it, stat says ENOENT. No key, and the note
  // is a stat error — `ledger_missing:` is the registry half's contract for the
  // three canonical names, not a vocabulary the discovery pass may borrow.
  assert.equal(
    Object.prototype.hasOwnProperty.call(counts, "ghost.jsonl"),
    false,
    "a dangling symlink must not be published at a laundered 0",
  );
  assert.ok(
    notes.includes("ledger_stat_error: ghost.jsonl: ENOENT"),
    `expected "ledger_stat_error: ghost.jsonl: ENOENT", got ${JSON.stringify(notes)}`,
  );
  assert.ok(
    !notes.some((n) => n.startsWith("ledger_missing: ghost.jsonl")),
    "a discovered dangling symlink is not a canonical registry ledger going missing",
  );

  for (const decoy of [
    ".gitkeep",
    "mail.jsonl.offsets",
    "telegram.jsonl.r14-backup",
    "nested.jsonl",
  ]) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(counts, decoy),
      `ledger_byte_counts picked up non-ledger entry ${decoy}; keys=${JSON.stringify(
        Object.keys(counts).sort(),
      )}`,
    );
  }
  // A directory named *.jsonl must be rejected by the type gate, silently —
  // not turned into a stat-error note.
  assert.ok(
    !notes.some((n) => n.includes("nested.jsonl")),
    `a directory decoy must produce no note at all, got ${JSON.stringify(notes)}`,
  );
});

// ---------------------------------------------------------------------------
// T5 — NON-VACUITY CONTROL. A healthy tree: readable, under the default cap, no
// symlinks, all three registry ledgers present plus two discovered ones. Every
// probe this suite asserts must be SILENT here. Without this case each probe
// could be hardcoded always-on and T1-T4 would still be green.
// ---------------------------------------------------------------------------
test("T5 negative control: a healthy tree emits none of the probes and counts every file exactly", async () => {
  const root = makeRoot();
  const sources = join(root, "storage", "sources");
  const registry = ["auto-memory.jsonl", "chat-claude-code.jsonl", "telegram.jsonl"];
  const discovered = ["mail.jsonl", "codex-cli.jsonl"];
  // Distinct payload lengths so a byte assertion cannot pass by coincidence.
  let n = 1;
  for (const name of [...registry, ...discovered]) {
    writeFileSync(join(sources, name), jsonlBytes(1024 * n));
    n += 1;
  }

  // stringCapBytes deliberately left at its default (MAX_STRING_LENGTH).
  const data = await buildHealthData(optsFor(root));
  const notes = data.health_notes;

  for (const prefix of [
    "ledger_over_string_cap:",
    "ledger_stat_error:",
    "source_event_count_skipped:",
    "source_event_count_read_error:",
  ]) {
    assert.ok(
      !notes.some((n2) => n2.startsWith(prefix)),
      `healthy tree must not emit ${prefix} — got ${JSON.stringify(notes)}`,
    );
  }
  // All five files present and readable => nothing is missing either.
  assert.ok(
    !notes.some((n2) => n2.startsWith("ledger_missing:")),
    `healthy tree must not emit ledger_missing: — got ${JSON.stringify(notes)}`,
  );

  for (const name of [...registry, ...discovered]) {
    assert.equal(
      data.ledger_byte_counts[name],
      statSync(join(sources, name)).size,
      `${name} must be published at exactly its statSync size`,
    );
  }
  // And source_event_counts is still the closed 3-key block with real counts.
  assert.deepEqual(Object.keys(data.source_event_counts).sort(), [
    "auto_memory",
    "chat_claude_code",
    "telegram",
  ]);
  for (const key of ["auto_memory", "chat_claude_code", "telegram"]) {
    assert.ok(
      Number.isInteger(data.source_event_counts[key]) && data.source_event_counts[key] > 0,
      `${key} must have a real line count, got ${data.source_event_counts[key]}`,
    );
  }
});
