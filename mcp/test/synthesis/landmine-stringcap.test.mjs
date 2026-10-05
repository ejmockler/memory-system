// landmine-stringcap.test.mjs — s4-landmine-sites-stream.
//
// DEFECT CLASS (7th+ bite): a ledger consumer does
//   readFileSync(ledgerPath, "utf8")
// inside a bare `catch { return []; }`. Node/V8's max string length is
// 536,870,888 bytes; the live ledgers/memory.jsonl is 3,054,950,767 bytes, so
// the read throws ERR_STRING_TOO_LONG and the bare catch makes an UNREADABLE
// ledger return exactly what an EMPTY ledger returns. See the incident
// write-up at lib/synthesis/reconstruction-emitter.js:371-401.
//
// This suite pins the two remaining DORMANT sites (no production callers
// today — landmines that go live the instant anyone wires them):
//   1. lib/synthesis/forgetting-propagation.js  readCascadeEventsFromLedger
//   2. lib/synthesis/reconstructed-trigger-advisor.js  scanLedgerLines
//      (module-internal; reached in production via shouldEmitReconstruction)
//
// Cases:
//   (A) Sparse OVER-CAP ledger (apparent size > MAX_STRING_LENGTH, ~8 KiB
//       actually allocated) — the cascade reader must surface cascade rows
//       from BOTH the head and the tail segment, and only cascade rows.
//   (B) Same sparse ledger, advisor via the PUBLIC api — a verbatim-identical
//       reconstructed row in the tail must be seen (token-set Jaccard 1.0 >
//       TRIGGER_CAPS.NEAR_DUP_THRESHOLD 0.92) => reason "near_duplicate_exists".
//   (C) Unreadable (chmod 0o000) is NOT empty — each function logs EXACTLY
//       once (through the passed logger when given, through console.error when
//       not) with a message saying so, still returns [], never throws; and a
//       logger whose .error() throws does not propagate.
//   (D) Torn tail (daemon mid-append) is still tolerated by both readers.
//
// Hermeticity: every artifact lives under a mkdtemp root and is removed in a
// finally / on exit. The real ledgers/memory.jsonl is NEVER referenced.
//
// Run: node --test test/synthesis/landmine-stringcap.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { constants as bufferConstants } from "node:buffer";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 0. Hermetic env BEFORE any memory-system import (mirrors
//    test/synthesis/forgetting-propagation.test.mjs:47-64).
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-s4-landmine-"));
const HERMETIC_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(HERMETIC_ROOT, "policy");
const STORAGE_DIR = join(HERMETIC_ROOT, "storage");
const LEDGERS_DIR = join(HERMETIC_ROOT, "ledgers");
const INDICES_DIR = join(HERMETIC_ROOT, "indices");
for (const d of [HERMETIC_ROOT, POLICY_DIR, STORAGE_DIR, LEDGERS_DIR, INDICES_DIR]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}
process.env.MEMORY_ROOT = HERMETIC_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort tmp cleanup
  }
});

// ---------------------------------------------------------------------------
// 1. Dynamic imports AFTER env override.
// ---------------------------------------------------------------------------
const forgettingMod = await import("../../lib/synthesis/forgetting-propagation.js");
const advisorMod = await import("../../lib/synthesis/reconstructed-trigger-advisor.js");

const { PROPAGATION_CASCADE_KIND, readCascadeEventsFromLedger } = forgettingMod;
const { TRIGGER_CAPS, shouldEmitReconstruction, __internal: advisorInternal } =
  advisorMod;

// ---------------------------------------------------------------------------
// 2. Fixtures.
// ---------------------------------------------------------------------------

const MAX_STRING_LENGTH = bufferConstants.MAX_STRING_LENGTH;

// Apparent file size of the sparse fixture. > MAX_STRING_LENGTH (536,870,888)
// so readFileSync(path, "utf8") throws ERR_STRING_TOO_LONG, but only the head
// and tail segments are ever allocated on disk (~8 KiB).
const HOLE_END = 600_000_000;

// The near-duplicate payload shared by the seeded reconstructed row and the
// case-(B) candidate. Identical text => token-set Jaccard 1.0.
const RECON_CONTENT =
  "Bob consolidated the memory-system ledger streaming primitives in July 2026.";

const HEAD_CASCADE = {
  id: "mem_head_cascade",
  kind: "policy",
  policy_kind: "derivation.cascade_orphan",
  schema_version: "v0.1.0",
  excised_memory_id: "fact_head_excised",
  orphaned_memory_ids: ["r_head_orphan"],
  orphan_count: 1,
  ts: "2026-06-20T12:00:00.000Z",
};

const HEAD_NON_CASCADE = {
  id: "fact_head_noise",
  kind: "fact",
  content: "head-segment non-cascade row that must NOT be returned",
  ts: "2026-06-20T12:00:01.000Z",
};

const TAIL_CASCADE = {
  id: "mem_tail_cascade",
  kind: "policy",
  policy_kind: "derivation.cascade_orphan",
  schema_version: "v0.1.0",
  excised_memory_id: "fact_tail_excised",
  orphaned_memory_ids: ["r_tail_orphan"],
  orphan_count: 1,
  ts: "2026-06-20T12:00:02.000Z",
};

const TAIL_RECON = {
  id: "recon_tail_dupe",
  kind: "reconstructed",
  content: RECON_CONTENT,
  derived_from: ["fact_a", "fact_b"],
  provenance: { conversation_id: null },
  ts: "2026-06-20T12:00:03.000Z",
};

const TAIL_NON_CASCADE = {
  id: "mem_tail_other_policy",
  kind: "policy",
  policy_kind: "recall.feedback",
  ts: "2026-06-20T12:00:04.000Z",
};

/**
 * Build a JSONL ledger whose APPARENT size exceeds Node's max string length
 * while costing ~8 KiB of disk: head lines, an ftruncate hole, tail lines.
 * The tail write MUST begin with "\n" — the NUL hole trips maxLineBytes and
 * sets abandonLine inside streamLedgerLines (_ledger-stream.js:191-198); the
 * newline is what re-synchronizes the scanner onto the tail rows.
 */
function buildSparseOverCapLedger(path) {
  const headLines =
    JSON.stringify(HEAD_CASCADE) + "\n" + JSON.stringify(HEAD_NON_CASCADE) + "\n";
  const tailLines =
    JSON.stringify(TAIL_CASCADE) +
    "\n" +
    JSON.stringify(TAIL_RECON) +
    "\n" +
    JSON.stringify(TAIL_NON_CASCADE) +
    "\n";
  const fd = openSync(path, "w");
  try {
    writeSync(fd, headLines, 0, "utf8");
    ftruncateSync(fd, HOLE_END);
    writeSync(fd, "\n" + tailLines, HOLE_END, "utf8");
  } finally {
    closeSync(fd);
  }
  return path;
}

/** Collect console.error output around a synchronous call. */
function captureConsoleError(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  let value;
  try {
    value = fn();
  } finally {
    console.error = orig;
  }
  return { value, lines };
}

function makeLogger() {
  const errors = [];
  return { errors, error: (msg) => errors.push(String(msg)) };
}

const THROWING_LOGGER = {
  error() {
    throw new Error("logger exploded");
  },
};

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

// ---------------------------------------------------------------------------
// (A) Sparse over-cap ledger — cascade reader.
// ---------------------------------------------------------------------------
test("(A) cascade reader: over-cap sparse ledger yields head AND tail cascade rows (not [])", () => {
  const p = join(TMP_ROOT, "overcap-cascade.jsonl");
  try {
    buildSparseOverCapLedger(p);
    const size = statSync(p).size;
    assert.ok(
      size > MAX_STRING_LENGTH,
      `fixture must exceed the V8 string cap: ${size} vs ${MAX_STRING_LENGTH}`,
    );

    const events = readCascadeEventsFromLedger(p);
    assert.ok(Array.isArray(events), "reader must return an Array");
    const ids = events.map((e) => e.id).sort();
    assert.deepEqual(
      ids,
      ["mem_head_cascade", "mem_tail_cascade"],
      "an over-cap ledger must NOT read as empty — both cascade rows must surface",
    );
    for (const e of events) {
      assert.equal(e.kind, "policy");
      assert.equal(e.policy_kind, PROPAGATION_CASCADE_KIND);
    }
    assert.deepEqual(
      events.find((e) => e.id === "mem_head_cascade").orphaned_memory_ids,
      ["r_head_orphan"],
    );
    assert.deepEqual(
      events.find((e) => e.id === "mem_tail_cascade").orphaned_memory_ids,
      ["r_tail_orphan"],
    );
  } finally {
    try {
      rmSync(p, { force: true });
    } catch {
      // ignore
    }
  }
});

// ---------------------------------------------------------------------------
// (B) Sparse over-cap ledger — advisor via the PUBLIC api.
// ---------------------------------------------------------------------------
test("(B) advisor: over-cap sparse ledger still sees the seeded near-duplicate", async () => {
  const p = join(TMP_ROOT, "overcap-advisor.jsonl");
  try {
    buildSparseOverCapLedger(p);
    assert.ok(statSync(p).size > MAX_STRING_LENGTH, "fixture must exceed the cap");

    const res = await shouldEmitReconstruction({
      parents: ["fact_a", "fact_b"],
      content: RECON_CONTENT,
      confidence: 0.9,
      conversation_id: null,
      ledgerPath: p,
    });
    assert.equal(
      res.reason,
      "near_duplicate_exists",
      `identical content must trip the near-dup gate, got ${JSON.stringify(res)}`,
    );
    assert.equal(res.emit, false);
    assert.ok(
      res.advisory_score > TRIGGER_CAPS.NEAR_DUP_THRESHOLD,
      "advisory_score is the observed Jaccard (1.0) and must exceed the threshold",
    );
  } finally {
    try {
      rmSync(p, { force: true });
    } catch {
      // ignore
    }
  }
});

// ---------------------------------------------------------------------------
// (C) Unreadable is NOT empty — both modules, both logging paths.
// ---------------------------------------------------------------------------
test("(C) cascade reader: unreadable ledger logs exactly once and says it is not empty", () => {
  if (isRoot) return; // chmod tricks don't bite as root
  const p = join(TMP_ROOT, "unreadable-cascade.jsonl");
  writeFileSync(p, JSON.stringify(HEAD_CASCADE) + "\n", { mode: 0o600 });
  chmodSync(p, 0o000);
  try {
    // 1. explicit logger
    const logger = makeLogger();
    const rows = readCascadeEventsFromLedger(p, logger);
    assert.ok(Array.isArray(rows), "must still return an Array");
    assert.deepEqual(rows, [], "return shape unchanged");
    assert.equal(logger.errors.length, 1, "read failure must log exactly once");
    assert.match(logger.errors[0], /NOT an empty ledger/);

    // 2. no logger — the dormant production path must still be LOUD.
    const cap = captureConsoleError(() => readCascadeEventsFromLedger(p));
    assert.deepEqual(cap.value, []);
    assert.equal(cap.lines.length, 1, "console.error fallback must fire exactly once");
    assert.match(cap.lines[0], /NOT an empty ledger/);

    // 3. a throwing logger must not propagate.
    assert.deepEqual(readCascadeEventsFromLedger(p, THROWING_LOGGER), []);
  } finally {
    try {
      chmodSync(p, 0o600);
    } catch {
      // ignore
    }
    try {
      rmSync(p, { force: true });
    } catch {
      // ignore
    }
  }
});

test("(C) advisor scan: unreadable ledger logs exactly once and says it is not empty", () => {
  if (isRoot) return;
  const p = join(TMP_ROOT, "unreadable-advisor.jsonl");
  writeFileSync(p, JSON.stringify(TAIL_RECON) + "\n", { mode: 0o600 });
  chmodSync(p, 0o000);
  try {
    const logger = makeLogger();
    const rows = advisorInternal.scanLedgerLines(p, logger);
    assert.ok(Array.isArray(rows), "must still return an Array");
    assert.deepEqual(rows, []);
    assert.equal(logger.errors.length, 1, "read failure must log exactly once");
    assert.match(logger.errors[0], /NOT an empty ledger/);

    // The live call site (advisor:308) passes NO logger, so console.error is
    // the fallback that will actually fire in production.
    const cap = captureConsoleError(() => advisorInternal.scanLedgerLines(p));
    assert.deepEqual(cap.value, []);
    assert.equal(cap.lines.length, 1, "console.error fallback must fire exactly once");
    assert.match(cap.lines[0], /NOT an empty ledger/);

    assert.deepEqual(advisorInternal.scanLedgerLines(p, THROWING_LOGGER), []);
  } finally {
    try {
      chmodSync(p, 0o600);
    } catch {
      // ignore
    }
    try {
      rmSync(p, { force: true });
    } catch {
      // ignore
    }
  }
});

test("(C) missing / empty path stays silent — ENOENT is the benign errno", () => {
  const cap = captureConsoleError(() => [
    readCascadeEventsFromLedger(""),
    readCascadeEventsFromLedger("/nonexistent/path"),
    advisorInternal.scanLedgerLines(""),
    advisorInternal.scanLedgerLines("/nonexistent/path"),
  ]);
  for (const r of cap.value) assert.deepEqual(r, []);
  assert.equal(cap.lines.length, 0, "a missing ledger must NOT fire the degrade log");
});

// ---------------------------------------------------------------------------
// (D) Torn tail (daemon mid-append) tolerated by both readers.
// ---------------------------------------------------------------------------
test("(D) torn trailing line is skipped, not fatal, for both readers", () => {
  const p = join(TMP_ROOT, "torn-tail.jsonl");
  try {
    writeFileSync(
      p,
      JSON.stringify(HEAD_CASCADE) +
        "\n" +
        JSON.stringify(HEAD_NON_CASCADE) +
        "\n" +
        JSON.stringify(TAIL_CASCADE) +
        "\n" +
        JSON.stringify(TAIL_RECON) +
        "\n",
      { mode: 0o600 },
    );
    appendFileSync(p, '{"id":"mem_torn","kind":"pol', { mode: 0o600 });

    const events = readCascadeEventsFromLedger(p);
    assert.deepEqual(
      events.map((e) => e.id).sort(),
      ["mem_head_cascade", "mem_tail_cascade"],
      "good cascade rows survive a torn tail",
    );

    const rows = advisorInternal.scanLedgerLines(p);
    assert.deepEqual(
      rows.map((r) => r.id),
      ["recon_tail_dupe"],
      "advisor scan returns the reconstructed rows and skips the torn line",
    );
  } finally {
    try {
      rmSync(p, { force: true });
    } catch {
      // ignore
    }
  }
});
