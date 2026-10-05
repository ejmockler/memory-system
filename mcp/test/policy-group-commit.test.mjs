// policy-group-commit.test.mjs — W3 coverage for the policy-event
// group-commit API (appendPolicyEventsBatch) + the watermark tick
// reentrancy guard (runGuardedTick).
//
// Pins:
//   (a) fsync amplification: a batch of 50 events costs exactly ONE
//       data-file fsync (observed via the _getDataFsyncCountForTest seam;
//       the lock-body fsync in tryCreateLock is NOT counted).
//   (b) format regression: batch output is BYTE-IDENTICAL to the same 50
//       events written via sequential appendPolicyEvent calls with the same
//       pinned `now` — row schema, JSONL format, and checksum discipline
//       unchanged for the recovery scanner.
//   (c) rotation: a July-timestamped batch lands wholly in the 2026-07
//       month file, a following August-timestamped batch lands in the
//       2026-08 file, and every written line's checksum re-verifies via a
//       canonicalJson recompute (blake2b512 truncated to 16 bytes).
//   (d) reentrancy: with a controllable-promise tick body injected via
//       _setTickBodyForTest, a second runGuardedTick while the first is
//       pending returns {ran:false} + exactly one "tick overlap suppressed"
//       stderr line; after resolution the next invocation proceeds; the
//       flag clears even when the body REJECTS.
//   (e) wrapper regression: appendPolicyEvent (now a batch of one) keeps its
//       exact return shape and its exact pre-existing error strings.
//
// HERMETICITY: MEMORY_ROOT + per-dir env overrides are set BEFORE the
// dynamic import of any consumer module (the policy-events-recall-feedback
// idiom). Production policy/ledger/storage dirs are never touched, and
// ledgers/memory.jsonl is never read.
//
// Run: cd mcp && node --test test/policy-group-commit.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "memsys-policy-group-commit-"));
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.env.HOOKS_BASE_DIR = join(TEST_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(TEST_ROOT, "daemons");
for (const d of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  process.env.HOOKS_BASE_DIR,
  process.env.DAEMONS_BASE_DIR,
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}
process.on("exit", () => {
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; tmpdir reaper will collect on next boot anyway.
  }
});

const {
  appendPolicyEvent,
  appendPolicyEventsBatch,
  _getDataFsyncCountForTest,
  _resetDataFsyncCountForTest,
} = await import("../lib/policy-events.js");
const { canonicalJson } = await import("../lib/validation.js");

const POLICY_DIR = process.env.POLICY_BASE_DIR;

// ----------------------------------------------------------------------------
// Fixture helpers
// ----------------------------------------------------------------------------

// Pre-existing kind with NO per-kind structural validation — payload mirrors
// the watermark stage0 mirror emit exactly.
function droppedEvent(i, tsIso) {
  return {
    kind: "policy.salience.dropped",
    source: "mail",
    source_msg_id: `msg-${i}`,
    reason: "stage0_test_fixture",
    ts: tsIso,
  };
}

function makeEvents(count, tsIso) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(droppedEvent(i, tsIso));
  return out;
}

function readLines(filePath) {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

// Recovery-scanner recompute: blake2b512 truncated to 16 bytes, lowercase
// hex, over canonicalJson of the row WITHOUT its checksum field.
function recomputeChecksum(row) {
  const { checksum, ...rest } = row;
  return createHash("blake2b512")
    .update(Buffer.from(canonicalJson(rest), "utf8"))
    .digest()
    .subarray(0, 16)
    .toString("hex");
}

// ----------------------------------------------------------------------------
// (a) batch of 50 -> exactly 1 data-file fsync
// ----------------------------------------------------------------------------

test("batch of 50 events performs exactly one data-file fsync", () => {
  const now = new Date("2026-06-15T12:00:00");
  _resetDataFsyncCountForTest();
  const results = appendPolicyEventsBatch(makeEvents(50, now.toISOString()), { now });
  assert.equal(_getDataFsyncCountForTest(), 1, "50 events must cost exactly 1 fsync");
  assert.equal(results.length, 50);
  for (const r of results) {
    assert.equal(typeof r.written_to, "string");
    assert.match(r.checksum, /^[0-9a-f]{32}$/);
  }
});

test("empty batch returns [] and performs no fsync", () => {
  _resetDataFsyncCountForTest();
  const results = appendPolicyEventsBatch([]);
  assert.deepEqual(results, []);
  assert.equal(_getDataFsyncCountForTest(), 0);
});

test("an invalid event anywhere in the batch writes nothing (all-or-nothing)", () => {
  const now = new Date("2026-06-15T12:00:00");
  const filePath = appendPolicyEventsBatch(
    [droppedEvent(9990, now.toISOString())],
    { now },
  )[0].written_to;
  const linesBefore = readLines(filePath).length;
  const bad = makeEvents(10, now.toISOString());
  bad[7] = { kind: "policy.not_a_real_kind" };
  assert.throws(
    () => appendPolicyEventsBatch(bad, { now }),
    /unknown event\.kind/,
  );
  assert.equal(
    readLines(filePath).length,
    linesBefore,
    "a failed batch must not land any of its rows",
  );
});

// ----------------------------------------------------------------------------
// (b) format regression — batch bytes === sequential appendPolicyEvent bytes
// ----------------------------------------------------------------------------

test("batch of 50 is byte-identical to 50 sequential appendPolicyEvent calls", () => {
  // Pinned to a month no other test writes to, so the file holds exactly
  // these 50 rows. Local-time parse (no Z suffix) matches activeFilePath's
  // local-timezone month derivation.
  const now = new Date("2026-05-15T12:00:00");
  const tsIso = now.toISOString();

  const batchResults = appendPolicyEventsBatch(makeEvents(50, tsIso), { now });
  const filePath = batchResults[0].written_to;
  assert.ok(filePath.endsWith("policy-events-2026-05.jsonl"));
  const batchBytes = readFileSync(filePath);

  unlinkSync(filePath);

  const seqResults = [];
  for (const event of makeEvents(50, tsIso)) {
    seqResults.push(appendPolicyEvent(event, { now }));
  }
  const seqBytes = readFileSync(filePath);

  assert.ok(
    batchBytes.equals(seqBytes),
    "batch output must be byte-identical to sequential single appends",
  );
  // Checksums per event match between the two write paths too.
  assert.deepEqual(
    batchResults.map((r) => r.checksum),
    seqResults.map((r) => r.checksum),
  );
});

// ----------------------------------------------------------------------------
// (c) rotation — one writeTime per batch; no batch spans two month files
// ----------------------------------------------------------------------------

test("July batch lands wholly in 2026-07; August batch in 2026-08; checksums re-verify", () => {
  const julyFile = join(POLICY_DIR, "policy-events-2026-07.jsonl");
  const augustFile = join(POLICY_DIR, "policy-events-2026-08.jsonl");
  const julyLinesBefore = existsSync(julyFile) ? readLines(julyFile).length : 0;
  assert.equal(existsSync(augustFile), false, "hermetic root must start without an August file");

  const julyNow = new Date("2026-07-31T23:59:59");
  const julyResults = appendPolicyEventsBatch(
    makeEvents(20, julyNow.toISOString()),
    { now: julyNow },
  );
  for (const r of julyResults) assert.equal(r.written_to, julyFile);
  assert.equal(
    readLines(julyFile).length,
    julyLinesBefore + 20,
    "the July batch must land wholly in the 2026-07 file",
  );
  assert.equal(existsSync(augustFile), false, "July batch must not touch the 2026-08 file");

  const augustNow = new Date("2026-08-01T00:00:01");
  const augustResults = appendPolicyEventsBatch(
    makeEvents(20, augustNow.toISOString()),
    { now: augustNow },
  );
  for (const r of augustResults) assert.equal(r.written_to, augustFile);
  assert.equal(readLines(augustFile).length, 20);
  assert.equal(
    readLines(julyFile).length,
    julyLinesBefore + 20,
    "the August batch must not touch the 2026-07 file",
  );

  // Recovery-scanner compatibility: every line's stored checksum re-verifies
  // against the canonicalJson recompute of the line sans checksum.
  for (const filePath of [julyFile, augustFile]) {
    for (const line of readLines(filePath)) {
      const row = JSON.parse(line);
      assert.equal(typeof row.checksum, "string");
      assert.equal(
        row.checksum,
        recomputeChecksum(row),
        `checksum must re-verify for line in ${filePath}`,
      );
    }
  }
});

// ----------------------------------------------------------------------------
// (d) tick reentrancy guard — runGuardedTick + injectable tick body
// ----------------------------------------------------------------------------

test("overlapping runGuardedTick is suppressed with exactly one stderr line", async () => {
  const wm = await import("../../daemons/watermark.js");
  const stderrLines = [];
  const origWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    stderrLines.push(String(chunk));
    return true;
  };
  try {
    let resolveTick;
    const gate = new Promise((resolve) => {
      resolveTick = resolve;
    });
    let bodyCalls = 0;
    wm._setTickBodyForTest(() => {
      bodyCalls += 1;
      return gate;
    });

    const first = wm.runGuardedTick({});
    assert.equal(first.ran, true, "first tick must run");
    assert.equal(bodyCalls, 1);

    const second = wm.runGuardedTick({});
    assert.equal(second.ran, false, "overlapping tick must be suppressed");
    assert.equal(bodyCalls, 1, "suppressed tick must not invoke the body");
    const suppressed = stderrLines.filter((l) =>
      l.includes("tick overlap suppressed"),
    );
    assert.equal(suppressed.length, 1, "exactly one suppression stderr line");

    resolveTick();
    await first.done;

    const third = wm.runGuardedTick({});
    assert.equal(third.ran, true, "tick after settlement must proceed");
    assert.equal(bodyCalls, 2);
    await third.done;
  } finally {
    process.stderr.write = origWrite;
    wm._resetTickGuardForTest();
  }
});

test("the in-flight flag clears even when the tick body rejects", async () => {
  const wm = await import("../../daemons/watermark.js");
  const origWrite = process.stderr.write;
  process.stderr.write = () => true; // silence the guarded-tick failure line
  try {
    wm._setTickBodyForTest(() => Promise.reject(new Error("boom")));
    const first = wm.runGuardedTick({});
    assert.equal(first.ran, true);
    await first.done; // done never rejects; flag cleared in finally

    let ranAfter = 0;
    wm._setTickBodyForTest(async () => {
      ranAfter += 1;
    });
    const next = wm.runGuardedTick({});
    assert.equal(next.ran, true, "a rejecting tick must never wedge the guard");
    await next.done;
    assert.equal(ranAfter, 1);
  } finally {
    process.stderr.write = origWrite;
    wm._resetTickGuardForTest();
  }
});

// ----------------------------------------------------------------------------
// (e) wrapper regression — appendPolicyEvent shape + exact error strings
// ----------------------------------------------------------------------------

test("appendPolicyEvent still returns {written_to, checksum}", () => {
  const now = new Date("2026-06-15T12:00:00");
  const result = appendPolicyEvent(droppedEvent(12345, now.toISOString()), { now });
  assert.deepEqual(Object.keys(result).sort(), ["checksum", "written_to"]);
  assert.ok(result.written_to.startsWith(POLICY_DIR));
  assert.match(result.checksum, /^[0-9a-f]{32}$/);
});

test("appendPolicyEvent keeps the exact pre-existing error strings", () => {
  assert.throws(
    () => appendPolicyEvent({ kind: "policy.not_a_real_kind" }),
    (err) =>
      err.message ===
      'appendPolicyEvent: unknown event.kind "policy.not_a_real_kind" (not in EVENT_KINDS)',
  );
  assert.throws(
    () =>
      appendPolicyEvent({
        kind: "policy.salience.dropped",
        source: "mail",
        token: "raw-secret",
      }),
    (err) =>
      err.message ===
      'appendPolicyEvent: event contains forbidden field "token" (secret-leak guard)',
  );
  assert.throws(
    () =>
      appendPolicyEvent({
        kind: "policy.salience.dropped",
        source: "mail",
        checksum: "deadbeef",
      }),
    (err) =>
      err.message ===
      "appendPolicyEvent: event must not carry a checksum field; it is computed here",
  );
});
