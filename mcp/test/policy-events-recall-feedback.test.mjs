// policy-events-recall-feedback.test.mjs — Wave-13 (CWF sweep)
// coverage for the WAVE-9 EVENT_KINDS addition + per-kind shape validator.
//
// Pins the runtime parity edge of F-SYN-OPERATIONAL-token-event-table-update:
//   1. EVENT_KINDS contains the new "policy.salience.recall_feedback" kind.
//   2. The VERSION + POLICY_EVENT_CAPS module exports are present, frozen,
//      and shaped.
//   3. validatePerKindShape accepts a complete recall_feedback row.
//   4. validatePerKindShape rejects rows with missing required fields.
//   5. validatePerKindShape rejects rows with structurally bad fields
//      (negative position, out-of-range propensity, oversized arrays, etc).
//   6. Pre-existing kinds still pass through unchanged (back-compat posture).
//   7. The audit log emits a real recall_feedback row end-to-end and the
//      checksum + kind round-trip on disk.
//
// HERMETICITY: set MEMORY_ROOT + POLICY_BASE_DIR before dynamic-importing
// mcp/lib/policy-events.js. Static ESM imports are hoisted; dynamic import()
// after env mutation is the only way to override paths cleanly. Without
// this, the writer would touch the live <checkout>/policy directory.
//
// Run: node test/policy-events-recall-feedback.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "memsys-policy-events-rf-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.on("exit", () => {
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; tmpdir reaper will collect on next boot anyway.
  }
});

const {
  appendPolicyEvent,
  EVENT_KINDS,
  POLICY_EVENT_CAPS,
  VERSION,
  currentActiveFile,
  listRotatedFiles,
} = await import("../lib/policy-events.js");

// ----------------------------------------------------------------------------
// Fixture helpers — a "good" payload that passes validation, and per-field
// mutators that drop one required field at a time. Co-located so every test
// shares the same baseline and divergences are explicit.
// ----------------------------------------------------------------------------

function goodRecallFeedbackEvent() {
  return {
    kind: "policy.salience.recall_feedback",
    recall_id: "rec_test_001",
    surfaced_memory_ids: ["mem_a", "mem_b", "mem_c"],
    surface_position_by_id: { mem_a: 0, mem_b: 1, mem_c: 2 },
    scoring_weights: { recency: 0.15, novelty: 0.25, episodicity: 0.1 },
    propensities_by_id: { mem_a: 0.7, mem_b: 0.2, mem_c: 0.1 },
    emitter_module: "recall-feedback-emitter",
    emitter_version: "v1",
  };
}

// ----------------------------------------------------------------------------
// 1. EVENT_KINDS membership + module-surface invariants
// ----------------------------------------------------------------------------

test("EVENT_KINDS contains 'policy.salience.recall_feedback'", () => {
  assert.ok(
    EVENT_KINDS.includes("policy.salience.recall_feedback"),
    "EVENT_KINDS must enumerate the new synthesis-wave kind",
  );
});

test("EVENT_KINDS is frozen (Object.freeze invariant)", () => {
  assert.ok(Object.isFrozen(EVENT_KINDS), "EVENT_KINDS must be frozen");
});

test("VERSION export is present and a non-empty string", () => {
  assert.equal(typeof VERSION, "string");
  assert.ok(VERSION.length > 0, "VERSION must be a non-empty string");
});

test("POLICY_EVENT_CAPS export is frozen and carries recall_feedback bounds", () => {
  assert.ok(Object.isFrozen(POLICY_EVENT_CAPS), "POLICY_EVENT_CAPS must be frozen");
  assert.equal(typeof POLICY_EVENT_CAPS.RECALL_FEEDBACK_MAX_SURFACED_IDS, "number");
  assert.ok(
    POLICY_EVENT_CAPS.RECALL_FEEDBACK_MAX_SURFACED_IDS > 0,
    "RECALL_FEEDBACK_MAX_SURFACED_IDS must be positive",
  );
  assert.equal(POLICY_EVENT_CAPS.RECALL_FEEDBACK_MIN_PROPENSITY_VALUE, 0.0);
  assert.equal(POLICY_EVENT_CAPS.RECALL_FEEDBACK_MAX_PROPENSITY_VALUE, 1.0);
});

// ----------------------------------------------------------------------------
// 2. Validation — happy path through appendPolicyEvent
// ----------------------------------------------------------------------------

test("appendPolicyEvent accepts a complete recall_feedback row", () => {
  const result = appendPolicyEvent(goodRecallFeedbackEvent());
  assert.ok(result.written_to, "result must include written_to path");
  assert.equal(typeof result.checksum, "string");
  assert.ok(result.checksum.length > 0, "checksum must be non-empty");
});

test("appendPolicyEvent round-trips the row on disk with the checksum field", () => {
  const event = goodRecallFeedbackEvent();
  event.recall_id = "rec_test_roundtrip_002";
  const result = appendPolicyEvent(event);
  const lines = readFileSync(result.written_to, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  // Find the line we just wrote — the file may already carry rows from
  // earlier tests in this suite.
  const ours = lines
    .map((l) => JSON.parse(l))
    .find((row) => row.recall_id === "rec_test_roundtrip_002");
  assert.ok(ours, "the just-written row must be readable from disk");
  assert.equal(ours.kind, "policy.salience.recall_feedback");
  assert.equal(typeof ours.checksum, "string");
  assert.deepEqual(ours.surfaced_memory_ids, ["mem_a", "mem_b", "mem_c"]);
});

// ----------------------------------------------------------------------------
// 3. Validation — rejection paths (missing required fields)
// ----------------------------------------------------------------------------

test("appendPolicyEvent rejects recall_feedback missing recall_id", () => {
  const event = goodRecallFeedbackEvent();
  delete event.recall_id;
  assert.throws(
    () => appendPolicyEvent(event),
    /recall_id must be a non-empty string/,
  );
});

test("appendPolicyEvent rejects recall_feedback missing surfaced_memory_ids", () => {
  const event = goodRecallFeedbackEvent();
  delete event.surfaced_memory_ids;
  assert.throws(
    () => appendPolicyEvent(event),
    /surfaced_memory_ids must be an array/,
  );
});

test("appendPolicyEvent rejects recall_feedback missing surface_position_by_id", () => {
  const event = goodRecallFeedbackEvent();
  delete event.surface_position_by_id;
  assert.throws(
    () => appendPolicyEvent(event),
    /surface_position_by_id must be a plain object/,
  );
});

test("appendPolicyEvent rejects recall_feedback missing scoring_weights", () => {
  const event = goodRecallFeedbackEvent();
  delete event.scoring_weights;
  assert.throws(
    () => appendPolicyEvent(event),
    /scoring_weights must be a plain object/,
  );
});

test("appendPolicyEvent rejects recall_feedback missing propensities_by_id", () => {
  const event = goodRecallFeedbackEvent();
  delete event.propensities_by_id;
  assert.throws(
    () => appendPolicyEvent(event),
    /propensities_by_id must be a plain object/,
  );
});

test("appendPolicyEvent rejects recall_feedback missing emitter_module", () => {
  const event = goodRecallFeedbackEvent();
  delete event.emitter_module;
  assert.throws(
    () => appendPolicyEvent(event),
    /emitter_module must be a non-empty string/,
  );
});

test("appendPolicyEvent rejects recall_feedback missing emitter_version", () => {
  const event = goodRecallFeedbackEvent();
  delete event.emitter_version;
  assert.throws(
    () => appendPolicyEvent(event),
    /emitter_version must be a non-empty string/,
  );
});

// ----------------------------------------------------------------------------
// 4. Validation — structural rejection paths (bad field types/values)
// ----------------------------------------------------------------------------

test("appendPolicyEvent rejects recall_feedback with non-string surfaced_memory_ids entry", () => {
  const event = goodRecallFeedbackEvent();
  event.surfaced_memory_ids = ["mem_a", 42, "mem_c"];
  assert.throws(
    () => appendPolicyEvent(event),
    /surfaced_memory_ids\[1\] must be a non-empty string/,
  );
});

test("appendPolicyEvent rejects recall_feedback with negative surface_position", () => {
  const event = goodRecallFeedbackEvent();
  event.surface_position_by_id = { mem_a: -1, mem_b: 1, mem_c: 2 };
  assert.throws(
    () => appendPolicyEvent(event),
    /surface_position_by_id\["mem_a"\] must be a non-negative integer/,
  );
});

test("appendPolicyEvent rejects recall_feedback with propensity > 1.0", () => {
  const event = goodRecallFeedbackEvent();
  event.propensities_by_id = { mem_a: 1.5, mem_b: 0.2, mem_c: 0.1 };
  assert.throws(
    () => appendPolicyEvent(event),
    /propensities_by_id\["mem_a"\] must be in \[0, 1\]/,
  );
});

test("appendPolicyEvent rejects recall_feedback with NaN scoring_weight", () => {
  const event = goodRecallFeedbackEvent();
  event.scoring_weights = { recency: Number.NaN };
  assert.throws(
    () => appendPolicyEvent(event),
    /scoring_weights\["recency"\] must be a finite number/,
  );
});

test("appendPolicyEvent rejects recall_feedback with oversized surfaced_memory_ids array", () => {
  const event = goodRecallFeedbackEvent();
  const oversize = [];
  for (let i = 0; i <= POLICY_EVENT_CAPS.RECALL_FEEDBACK_MAX_SURFACED_IDS; i++) {
    oversize.push(`mem_${i}`);
  }
  event.surfaced_memory_ids = oversize;
  assert.throws(
    () => appendPolicyEvent(event),
    /surfaced_memory_ids length exceeds POLICY_EVENT_CAPS\.RECALL_FEEDBACK_MAX_SURFACED_IDS/,
  );
});

// ----------------------------------------------------------------------------
// 5. Back-compat — pre-existing kinds still pass through
// ----------------------------------------------------------------------------

test("appendPolicyEvent still accepts a minimal policy.daemon.lock_reclaimed row (back-compat)", () => {
  // Pre-existing kind — must not be retroactively validated. A minimal
  // payload (kind only) must NOT throw via the per-kind validator (the
  // EVENT_KINDS_SET check + forbidden-field guard still gate it).
  const result = appendPolicyEvent({
    kind: "policy.daemon.lock_reclaimed",
    prior_pid: 12345,
    prior_mtime: new Date().toISOString(),
    reclaimed_at: new Date().toISOString(),
  });
  assert.ok(result.written_to);
  assert.equal(typeof result.checksum, "string");
});

test("appendPolicyEvent rejects unknown kinds (EVENT_KINDS_SET membership)", () => {
  assert.throws(
    () => appendPolicyEvent({ kind: "policy.unknown.fictional_kind" }),
    /unknown event\.kind/,
  );
});

// ----------------------------------------------------------------------------
// 6. End-to-end durability — rotated-file enumeration + active-file resolution
// ----------------------------------------------------------------------------

test("listRotatedFiles surfaces the active month after a recall_feedback emit", () => {
  appendPolicyEvent(goodRecallFeedbackEvent());
  const files = listRotatedFiles();
  const active = currentActiveFile();
  assert.ok(
    files.includes(active),
    `active file ${active} should be in listRotatedFiles() output`,
  );
});
