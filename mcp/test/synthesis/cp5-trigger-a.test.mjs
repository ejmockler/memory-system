// cp5-trigger-a.test.mjs — coverage for
// F-SYN-INTEGRATION-CP5-TRIGGER-A-ACTIVATION (Wave 9 integration glue).
//
// Pins the authoritative behavior of mcp/lib/synthesis/recall-feedback-emitter.js:
//   1. RECALL_FEEDBACK_KIND and RECALL_FEEDBACK_SCHEMA_VERSION constants.
//   2. emitRecallFeedback writes the expected row shape to memory.jsonl.
//   3. The emit is BATCHED: 5 surfaced memories produce ONE row, not 5.
//   4. Defensive write-failure path: a torn writer logs + returns
//      {ok:false}, never throws to the caller (the fire-and-forget contract).
//   5. The kind/policy_kind/schema/audit fields are byte-identical to the
//      module's exported constants.
//
// Run: node test/synthesis/cp5-trigger-a.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HERMETIC SETUP — set MEMORY_ROOT + LEDGERS_BASE_DIR before importing
// the module under test. The emitter resolves memoryLedgerPath() at call
// time (not at import time), so this discipline is sufficient.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-cp5-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
const LEDGERS_DIR = join(MEMORY_ROOT, "ledgers");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;
mkdirSync(LEDGERS_DIR, { recursive: true });

const {
  emitRecallFeedback,
  RECALL_FEEDBACK_KIND,
  RECALL_FEEDBACK_SCHEMA_VERSION,
} = await import("../../lib/synthesis/recall-feedback-emitter.js");

// memoryLedgerPath() reads the env vars set above.
const { memoryLedgerPath } = await import("../../lib/config.js");

// Read all rows in the ledger after a write. Each row is one JSONL line.
function readLedgerRows() {
  const path = memoryLedgerPath();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  if (raw.length === 0) return [];
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// Reset the ledger file between tests so per-test assertions are isolated.
function resetLedger() {
  const path = memoryLedgerPath();
  try {
    rmSync(path);
  } catch (e) {
    if (!(e && e.code === "ENOENT")) throw e;
  }
}

test("RECALL_FEEDBACK_KIND constant is 'salience.recall_feedback'", () => {
  assert.equal(RECALL_FEEDBACK_KIND, "salience.recall_feedback");
});

test("RECALL_FEEDBACK_SCHEMA_VERSION constant is 'v1'", () => {
  assert.equal(RECALL_FEEDBACK_SCHEMA_VERSION, "v1");
});

test("emitRecallFeedback writes the expected row shape", async () => {
  resetLedger();
  const res = await emitRecallFeedback({
    recall_id: "rec_test_shape_001",
    surfaced_memory_ids: ["mem_a", "mem_b"],
    surface_position_by_id: { mem_a: 0, mem_b: 1 },
    scoring_weights: { recency: 0.15, novelty: 0.25 },
    propensities_by_id: { mem_a: 0.7, mem_b: 0.3 },
  });

  // The success contract: {ok:true, written_count:1}.
  assert.equal(res.ok, true, "emit returns ok:true");
  assert.equal(res.written_count, 1, "emit returns written_count:1");

  const rows = readLedgerRows();
  assert.equal(rows.length, 1, "exactly one row written");

  const row = rows[0];
  assert.equal(row.kind, "policy", "row.kind === 'policy'");
  assert.equal(
    row.policy_kind,
    RECALL_FEEDBACK_KIND,
    "row.policy_kind === RECALL_FEEDBACK_KIND",
  );
  assert.equal(
    row.schema_version,
    RECALL_FEEDBACK_SCHEMA_VERSION,
    "row.schema_version === RECALL_FEEDBACK_SCHEMA_VERSION",
  );
  assert.equal(row.recall_id, "rec_test_shape_001", "row.recall_id matches");
  assert.deepEqual(
    row.surfaced_memory_ids,
    ["mem_a", "mem_b"],
    "row.surfaced_memory_ids matches input",
  );
  assert.deepEqual(
    row.surface_position_by_id,
    { mem_a: 0, mem_b: 1 },
    "row.surface_position_by_id matches input",
  );
  assert.deepEqual(
    row.scoring_weights,
    { recency: 0.15, novelty: 0.25 },
    "row.scoring_weights matches input",
  );
  assert.deepEqual(
    row.propensities_by_id,
    { mem_a: 0.7, mem_b: 0.3 },
    "row.propensities_by_id matches input",
  );

  // Audit-trail fields are present and identify the module.
  assert.equal(
    row.emitter_module,
    "recall-feedback-emitter",
    "emitter_module audit field",
  );
  assert.equal(row.emitter_version, "v1", "emitter_version audit field");

  // ts is a non-empty string (ISO-8601 from serverTs()).
  assert.equal(typeof row.ts, "string", "ts is a string");
  assert.ok(row.ts.length > 0, "ts is non-empty");

  // id is a non-empty "mem_<hex>" string.
  assert.equal(typeof row.id, "string", "id is a string");
  assert.ok(row.id.startsWith("mem_"), "id has mem_ prefix");
});

test("emitRecallFeedback BATCHES — 5 surfaced memories produce ONE event", async () => {
  resetLedger();
  const ids = ["mem_q", "mem_r", "mem_s", "mem_t", "mem_u"];
  const posMap = {};
  const propMap = {};
  ids.forEach((id, i) => {
    posMap[id] = i;
    propMap[id] = 0.2 - i * 0.04;
  });

  const res = await emitRecallFeedback({
    recall_id: "rec_test_batch_005",
    surfaced_memory_ids: ids,
    surface_position_by_id: posMap,
    scoring_weights: { recency: 0.15 },
    propensities_by_id: propMap,
  });

  assert.equal(res.ok, true);
  // CRITICAL invariant: 1 emit -> 1 row, NEVER 5.
  assert.equal(res.written_count, 1, "5 memories -> ONE batched row");

  const rows = readLedgerRows();
  assert.equal(rows.length, 1, "exactly one ledger row for 5 surfaced memories");
  assert.equal(
    rows[0].surfaced_memory_ids.length,
    5,
    "the single row carries all 5 memory ids",
  );
});

test("emitRecallFeedback is DEFENSIVE — bad input does not throw", async () => {
  resetLedger();
  // Pass nonsense input. The fire-and-forget contract is that we get
  // back {ok:false} and the caller never sees a throw.
  let threw = false;
  let res;
  try {
    res = await emitRecallFeedback({
      // missing recall_id, no surfaced_memory_ids
      surface_position_by_id: {},
      scoring_weights: {},
      propensities_by_id: {},
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "emit did not throw on bad input");
  assert.equal(res.ok, false, "emit returned ok:false on bad input");
  assert.equal(res.written_count, 0, "written_count is 0 on bad input");
  assert.equal(
    typeof res.error_reason,
    "string",
    "error_reason is a string for the logger",
  );

  // No row written on bad input.
  const rows = readLedgerRows();
  assert.equal(rows.length, 0, "no row written when input was bad");
});

test("emitRecallFeedback is DEFENSIVE — write failure is logged + swallowed", async () => {
  // Sabotage the ledger path by making `memory.jsonl` itself a directory.
  // The emitter's openSync(path, O_APPEND|O_WRONLY|O_CREAT|O_NOFOLLOW)
  // will fail with EISDIR when the target is a directory — a deterministic
  // write failure that exercises the catch path without any env-var
  // re-import tricks (which collide with the config.js module cache).
  resetLedger();
  const fs = await import("node:fs");
  const ledgerPath = memoryLedgerPath();
  // Ensure parent dir exists, then create a directory AT the ledger path.
  mkdirSync(ledgerPath, { recursive: true });

  // Capture stderr so the swallowed-error log does not pollute the test
  // runner's output (and so we can assert it fired).
  const origErr = console.error;
  let stderrCaptured = "";
  console.error = (...args) => {
    stderrCaptured += args.join(" ") + "\n";
  };

  let threw = false;
  let res;
  try {
    res = await emitRecallFeedback({
      recall_id: "rec_test_sabotage",
      surfaced_memory_ids: ["mem_x"],
      surface_position_by_id: { mem_x: 0 },
      scoring_weights: {},
      propensities_by_id: { mem_x: 1.0 },
    });
  } catch {
    threw = true;
  } finally {
    console.error = origErr;
    // Cleanup the sabotage directory so the next assertion run starts fresh.
    try {
      fs.rmSync(ledgerPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  assert.equal(threw, false, "emit did not throw on write failure");
  assert.equal(res.ok, false, "emit returned ok:false on write failure");
  assert.equal(res.written_count, 0, "written_count is 0 on write failure");
  assert.equal(
    typeof res.error_reason,
    "string",
    "error_reason string is set on write failure",
  );
  assert.ok(
    stderrCaptured.includes("recall-feedback-emitter"),
    "swallowed-error log mentions the emitter module",
  );
});
