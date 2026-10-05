// test/messaging/m3-feedback-log.test.mjs — WORKUNIT M3 (feedback-log).
//
// The APPEND-ONLY operator-engagement log for the who-matters attention model
// (lib/messaging/feedback-log.js): recordFeedback appends one immutable JSONL row;
// feedbackScore / buildFeedbackIndex + lookupFeedbackScore read it at query time
// into a feedback_score ∈ [0,1] for the M1 person-enrichment seam.
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions. Hermetic: every
// write lands in a mkdtempSync temp file via the opts.path seam; NO real
// storage/feedback/ touched, NO env binding, NO network.
//
// GATE LINE (the workunit's exit criteria):
//   record_readback=true    — recordFeedback writes a row feedbackScore reads back.
//   flagged_lowers=true     — flagged_spam LOWERS the score below a replied subject.
//   neutral_when_empty=true — absent/empty log / never-triaged subject => 0.
//   tool_registered=true    — memory_catchup_feedback is in the dispatch registry.
//   append_only=true        — a second record APPENDS; the first line is unchanged.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Hermetic temp root; cleaned up after the suite. It is ALSO the MEMORY_ROOT,
// set BEFORE the first library import (config.js binds its paths at load), so
// any write through the production feedbackLogPath lands here and never in the
// data root of the install the suite runs in.
const TEST_ROOT = mkdtempSync(join(tmpdir(), "m3-feedback-log-"));
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.MEMORY_OPERATOR_IDENTITY_FILE = fileURLToPath(
  new URL("../fixtures/operator-identity.synthetic.json", import.meta.url),
);

const {
  recordFeedback,
  feedbackScore,
  buildFeedbackIndex,
  buildFeedbackIndexFromLog,
  lookupFeedbackScore,
  FEEDBACK_CAPS,
  NAME,
  TOOL,
  handler,
} = await import("../../lib/messaging/feedback-log.js");
test.after(() => {
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

let _n = 0;
function freshPath() {
  _n += 1;
  return join(TEST_ROOT, `engagement-${_n}.jsonl`);
}

// ---------------------------------------------------------------------------
// neutral_when_empty
// ---------------------------------------------------------------------------

test("M3: feedbackScore on an ABSENT log is NEUTRAL (0) — neutral_when_empty", () => {
  const path = freshPath();
  assert.equal(existsSync(path), false, "log does not exist yet");
  assert.equal(feedbackScore("person:alice", { path }), 0, "absent log => 0 neutral");
  // A read NEVER creates the file (read-only at query time).
  assert.equal(existsSync(path), false, "feedbackScore never writes the log");
});

test("M3: a never-triaged subject is NEUTRAL (0) even when the log has OTHER subjects", () => {
  const path = freshPath();
  recordFeedback({ subject_id: "person:bob", action: "replied" }, { path });
  assert.equal(feedbackScore("person:unknown", { path }), 0, "never-triaged subject => 0, never dropped");
});

test("M3: lookupFeedbackScore is total over a malformed index / bad subject_id", () => {
  assert.equal(lookupFeedbackScore(null, "person:x"), 0, "null index => 0");
  assert.equal(lookupFeedbackScore({}, "person:x"), 0, "index missing aggregates => 0");
  const idx = buildFeedbackIndex([{ subject_id: "person:x", action: "replied" }]);
  assert.equal(lookupFeedbackScore(idx, ""), 0, "empty subject_id => 0");
  assert.equal(lookupFeedbackScore(idx, 123), 0, "non-string subject_id => 0");
});

// ---------------------------------------------------------------------------
// record_readback
// ---------------------------------------------------------------------------

test("M3: recordFeedback writes a row feedbackScore reads back — record_readback", () => {
  const path = freshPath();
  const row = recordFeedback({ subject_id: "person:carol", action: "replied" }, { path });
  assert.equal(row.subject_id, "person:carol", "returned row carries subject_id");
  assert.equal(row.action, "replied", "returned row carries action");
  assert.ok(typeof row.ts === "string" && row.ts.length > 0, "row is server-ts-stamped");
  // Read it back through the public score path.
  const score = feedbackScore("person:carol", { path });
  assert.ok(score > 0, "a replied subject reads back a positive feedback_score");
  assert.ok(score <= 1, "feedback_score never exceeds 1");
});

// ---------------------------------------------------------------------------
// flagged_lowers  (and the monotone / never-drop invariants)
// ---------------------------------------------------------------------------

test("M3: flagged_spam LOWERS the score below a replied subject — flagged_lowers", () => {
  const path = freshPath();
  recordFeedback({ subject_id: "person:good", action: "replied" }, { path });
  recordFeedback({ subject_id: "person:good", action: "opened" }, { path });
  recordFeedback({ subject_id: "person:spam", action: "flagged_spam" }, { path });

  const good = feedbackScore("person:good", { path });
  const spam = feedbackScore("person:spam", { path });
  assert.ok(good > spam, "a replied+opened subject out-scores a flagged one");
  assert.equal(spam, 0, "a net-negative (flagged) subject floors at 0 — NEVER below");
});

test("M3: the 0 FLOOR is the non-drop guarantee — even repeated flags stay >= 0", () => {
  const path = freshPath();
  for (let i = 0; i < 5; i++) {
    recordFeedback({ subject_id: "person:noisy", action: "flagged_spam" }, { path });
  }
  const s = feedbackScore("person:noisy", { path });
  assert.equal(s, 0, "feedback_score never goes below the 0 neutral floor (never hard-drops a human)");
});

test("M3: feedback_score is MONOTONE — more positive engagement => >= score", () => {
  const path = freshPath();
  recordFeedback({ subject_id: "person:m", action: "opened" }, { path });
  const after1 = feedbackScore("person:m", { path });
  recordFeedback({ subject_id: "person:m", action: "replied" }, { path });
  const after2 = feedbackScore("person:m", { path });
  recordFeedback({ subject_id: "person:m", action: "replied" }, { path });
  const after3 = feedbackScore("person:m", { path });
  assert.ok(after2 >= after1, "adding a reply does not lower the score");
  assert.ok(after3 >= after2, "more replies => monotone non-decreasing");
  assert.ok(after3 <= 1, "saturates within [0,1]");
});

test("M3: 'surfaced' is a 0-weight observation — it records exposure without moving the score", () => {
  const path = freshPath();
  recordFeedback({ subject_id: "person:s", action: "surfaced" }, { path });
  recordFeedback({ subject_id: "person:s", action: "surfaced" }, { path });
  assert.equal(feedbackScore("person:s", { path }), 0, "surfaced-only => still neutral 0");
});

// ---------------------------------------------------------------------------
// append_only
// ---------------------------------------------------------------------------

test("M3: recordFeedback is APPEND-ONLY — a second record appends, first line unchanged", () => {
  const path = freshPath();
  recordFeedback({ subject_id: "person:a1", action: "opened" }, { path });
  const afterFirst = readFileSync(path, "utf8");
  const firstLine = afterFirst.split("\n")[0];

  recordFeedback({ subject_id: "person:a2", action: "replied" }, { path });
  const afterSecond = readFileSync(path, "utf8");
  const lines = afterSecond.split("\n").filter((l) => l.length > 0);

  assert.equal(lines.length, 2, "exactly two rows on disk (append, not rewrite)");
  assert.equal(lines[0], firstLine, "the FIRST line is byte-for-byte unchanged (immutable history)");
  assert.ok(afterSecond.startsWith(afterFirst), "the new content is strictly APPENDED to the old");
  assert.ok(JSON.parse(lines[1]).subject_id === "person:a2", "the second appended row is the new action");
});

// ---------------------------------------------------------------------------
// defensive reader — torn / malformed lines degrade, never throw
// ---------------------------------------------------------------------------

test("M3: the reader is DEFENSIVE over a torn / malformed / out-of-vocab log", () => {
  const path = freshPath();
  // A valid row, then a torn JSON line, an out-of-vocab action, a row missing
  // subject_id, and a non-object — all must be skipped, never throw.
  recordFeedback({ subject_id: "person:d", action: "replied" }, { path });
  // Hand-append garbage to prove the reader skips it (never throws).
  appendFileSync(path, '{"subject_id":"person:d","action":"replie\n'); // torn
  appendFileSync(path, '{"subject_id":"person:d","action":"bogus_action"}\n'); // out-of-vocab
  appendFileSync(path, '{"action":"replied"}\n'); // missing subject_id
  appendFileSync(path, "not json at all\n");
  appendFileSync(path, "[]\n"); // non-object

  // Score still reflects ONLY the one valid replied row; no throw.
  const idx = buildFeedbackIndexFromLog({ path });
  const s = lookupFeedbackScore(idx, "person:d");
  assert.ok(s > 0, "the single valid replied row still scores positive");
  assert.equal(idx.aggregates.get("person:d"), FEEDBACK_CAPS.ACTION_WEIGHTS.replied, "only the valid row aggregated");
});

// ---------------------------------------------------------------------------
// pure / deterministic index
// ---------------------------------------------------------------------------

test("M3: buildFeedbackIndex is PURE/DETERMINISTIC — same rows => same aggregates", () => {
  const rows = [
    { subject_id: "person:p", action: "opened" },
    { subject_id: "person:p", action: "replied" },
    { subject_id: "person:q", action: "dismissed" },
  ];
  const a = buildFeedbackIndex(rows);
  const b = buildFeedbackIndex(rows);
  assert.equal(a.aggregates.get("person:p"), b.aggregates.get("person:p"), "deterministic aggregate for p");
  assert.equal(a.aggregates.get("person:q"), b.aggregates.get("person:q"), "deterministic aggregate for q");
  assert.equal(
    a.aggregates.get("person:p"),
    FEEDBACK_CAPS.ACTION_WEIGHTS.opened + FEEDBACK_CAPS.ACTION_WEIGHTS.replied,
    "p aggregate = opened + replied weights (signed sum)",
  );
});

// ---------------------------------------------------------------------------
// write-side validation + lookup signature for M5 wiring
// ---------------------------------------------------------------------------

test("M3: recordFeedback REJECTS an invalid shape (write-side validation)", () => {
  const path = freshPath();
  assert.throws(() => recordFeedback({ action: "replied" }, { path }), /subject_id/, "missing subject_id throws");
  assert.throws(
    () => recordFeedback({ subject_id: "person:z", action: "nope" }, { path }),
    /action/,
    "out-of-vocab action throws",
  );
  assert.equal(existsSync(path), false, "a rejected write never created the log");
});

test("M3: lookupFeedbackScore matches the makeEnricherFromIndex(index, lookup) signature", () => {
  // M5/W2 wires this exact pair into makeEnricherFromIndex. Prove (index, id) -> [0,1].
  const idx = buildFeedbackIndex([
    { subject_id: "person:e", action: "replied" },
    { subject_id: "person:e", action: "opened" },
  ]);
  const score = lookupFeedbackScore(idx, "person:e");
  assert.ok(score >= 0 && score <= 1, "lookup returns a unit-interval score");
  assert.ok(score > 0, "an engaged subject lifts above neutral");
});

// ---------------------------------------------------------------------------
// tool_registered — the MCP tool surface
// ---------------------------------------------------------------------------

test("M3: memory_catchup_feedback TOOL shape is well-formed", () => {
  assert.equal(NAME, "memory_catchup_feedback", "tool name");
  assert.equal(TOOL.name, NAME, "TOOL.name matches");
  assert.equal(typeof TOOL.description, "string", "has a description");
  assert.equal(TOOL.inputSchema.type, "object", "inputSchema is an object schema");
  assert.deepEqual(TOOL.inputSchema.required, ["subject_id", "action"], "subject_id + action required");
  assert.deepEqual(
    TOOL.inputSchema.properties.action.enum,
    FEEDBACK_CAPS.ACTIONS,
    "action enum is the CAPS action vocabulary",
  );
  assert.equal(typeof TOOL.handler, "function", "has a handler");
});

test("M3: memory_catchup_feedback is REGISTERED in dispatch — tool_registered", async () => {
  const dispatch = await import("../../lib/dispatch.js");
  const names = dispatch.listTools().map((t) => t.name);
  assert.ok(names.includes("memory_catchup_feedback"), "tool appears in the dispatch registry");
});

test("M3: the tool handler appends + returns an ok envelope with record-readback", async () => {
  // The handler uses the production feedbackLogPath (env-overridable). Bind the
  // storage base to the temp root so the real write lands hermetically.
  const prev = process.env.STORAGE_BASE_DIR;
  const stRoot = join(TEST_ROOT, "tool-store");
  process.env.STORAGE_BASE_DIR = stRoot;
  try {
    // Re-import config + module fresh so feedbackLogPath() binds the temp STORAGE_BASE_DIR.
    const mod = await import(`../../lib/messaging/feedback-log.js?store=${encodeURIComponent(stRoot)}`);
    const env = await mod.handler({ subject_id: "person:tool", action: "replied" });
    assert.equal(env.ok, true, "handler returns ok envelope");
    assert.equal(env.data.recorded.subject_id, "person:tool", "recorded row echoes subject_id");
    assert.ok(env.data.feedback_score > 0, "record-readback feedback_score is positive after a reply");
    // A second flag on a different subject lowers ITS score relative to the reply.
    const env2 = await mod.handler({ subject_id: "person:tool_spam", action: "flagged_spam" });
    assert.equal(env2.data.feedback_score, 0, "flagged subject reads back 0 (floored, never dropped)");
  } finally {
    if (prev === undefined) delete process.env.STORAGE_BASE_DIR;
    else process.env.STORAGE_BASE_DIR = prev;
  }
});

test("M3: handler REJECTS an invalid action with a ToolError (INVALID_ARGUMENTS)", async () => {
  await assert.rejects(
    () => handler({ subject_id: "person:x", action: "bogus" }),
    /action must be one of/,
    "bad action rejected before any append",
  );
  await assert.rejects(
    () => handler({ action: "replied" }),
    /subject_id/,
    "missing subject_id rejected",
  );
});
