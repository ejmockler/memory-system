// recall-mood-vocabulary.test.mjs — substrate-minor-polish (#3) coverage
// for F-SYN-INTEGRATION-RECALL-CONSUMES-VALENCE mood vocabulary table.
//
// COVERAGE:
//   - SYNTH_MOOD_STRING_TO_VALENCE exported + frozen (closed enum invariant).
//   - moodStringToValence() returns the canonical {sign, magnitude} for
//     every CAPS-table key.
//   - Unknown mood strings return null AND increment mood_table_miss.
//   - Whitespace/case insensitivity in the lookup.
//   - Non-string inputs are accepted defensively (return null, no throw).
//   - RECALL_VALENCE_VOCAB_VERSION exported as a non-empty string.
//   - getMoodTelemetry returns a frozen snapshot.
//
// Hermetic env-before-dynamic-import setup matches the rest of the
// substrate test suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 0. Hermetic root + env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-mood-vocab-"));
const HERMETIC_ROOT = join(TMP_ROOT, "memory-system");
const POLICY_DIR = join(HERMETIC_ROOT, "policy");
const STORAGE_DIR = join(HERMETIC_ROOT, "storage");
const LEDGERS_DIR = join(HERMETIC_ROOT, "ledgers");
for (const d of [HERMETIC_ROOT, POLICY_DIR, STORAGE_DIR, LEDGERS_DIR]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}
process.env.MEMORY_ROOT = HERMETIC_ROOT;
process.env.POLICY_BASE_DIR = POLICY_DIR;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
process.env.LEDGERS_BASE_DIR = LEDGERS_DIR;

const {
  SYNTH_MOOD_STRING_TO_VALENCE,
  RECALL_VALENCE_VOCAB_VERSION,
  moodStringToValence,
  getMoodTelemetry,
  resetMoodTelemetry,
} = await import("../../lib/tools/recall.js");

test("mood vocabulary table is exported and frozen", () => {
  assert.equal(typeof SYNTH_MOOD_STRING_TO_VALENCE, "object");
  assert.ok(SYNTH_MOOD_STRING_TO_VALENCE != null);
  assert.ok(Object.isFrozen(SYNTH_MOOD_STRING_TO_VALENCE),
    "CAPS table must be frozen (closed enum discipline)");
  // Each entry is itself frozen.
  for (const k of Object.keys(SYNTH_MOOD_STRING_TO_VALENCE)) {
    assert.ok(
      Object.isFrozen(SYNTH_MOOD_STRING_TO_VALENCE[k]),
      `entry ${k} must be frozen`,
    );
  }
});

test("RECALL_VALENCE_VOCAB_VERSION is a non-empty string", () => {
  assert.equal(typeof RECALL_VALENCE_VOCAB_VERSION, "string");
  assert.ok(RECALL_VALENCE_VOCAB_VERSION.length > 0);
});

test("required workunit mood strings present", () => {
  // Per the task: "frustrated" → {sign:-1,magnitude:0.7},
  //               "excited"    → {sign:+1,magnitude:0.7}
  assert.deepEqual(SYNTH_MOOD_STRING_TO_VALENCE.frustrated,
    { sign: -1, magnitude: 0.7 });
  assert.deepEqual(SYNTH_MOOD_STRING_TO_VALENCE.excited,
    { sign: 1, magnitude: 0.7 });
});

test("every CAPS-table entry has sign ∈ {-1,0,1} and magnitude ∈ [0,1]", () => {
  for (const [k, v] of Object.entries(SYNTH_MOOD_STRING_TO_VALENCE)) {
    assert.ok(
      v.sign === -1 || v.sign === 0 || v.sign === 1,
      `entry ${k}: bad sign ${v.sign}`,
    );
    assert.ok(typeof v.magnitude === "number",
      `entry ${k}: magnitude must be number`);
    assert.ok(v.magnitude >= 0 && v.magnitude <= 1,
      `entry ${k}: magnitude out of range ${v.magnitude}`);
    // I4 (sign-magnitude consistency) — neutral entries have magnitude=0.
    if (v.sign === 0) assert.equal(v.magnitude, 0,
      `entry ${k}: sign=0 must have magnitude=0`);
  }
});

test("moodStringToValence returns canonical shape for known strings", () => {
  const r = moodStringToValence("frustrated");
  assert.deepEqual(r, { sign: -1, magnitude: 0.7 });
});

test("moodStringToValence is whitespace + case insensitive", () => {
  const a = moodStringToValence("  EXCITED  ");
  const b = moodStringToValence("excited");
  assert.deepEqual(a, b);
  const c = moodStringToValence("Frustrated");
  assert.deepEqual(c, { sign: -1, magnitude: 0.7 });
});

test("moodStringToValence returns null + increments mood_table_miss for unknown", () => {
  resetMoodTelemetry();
  const before = getMoodTelemetry().mood_table_miss;
  const r = moodStringToValence("xenophilic");
  assert.equal(r, null);
  const after = getMoodTelemetry().mood_table_miss;
  assert.equal(after - before, 1, "mood_table_miss incremented by 1");
});

test("moodStringToValence does NOT count miss for known string", () => {
  resetMoodTelemetry();
  const before = getMoodTelemetry().mood_table_miss;
  moodStringToValence("happy");
  moodStringToValence("sad");
  moodStringToValence("calm");
  const after = getMoodTelemetry().mood_table_miss;
  assert.equal(after, before, "no miss when string is in the table");
});

test("moodStringToValence is defensive on non-string + empty inputs", () => {
  resetMoodTelemetry();
  assert.equal(moodStringToValence(null), null);
  assert.equal(moodStringToValence(undefined), null);
  assert.equal(moodStringToValence(42), null);
  assert.equal(moodStringToValence({}), null);
  assert.equal(moodStringToValence([]), null);
  assert.equal(moodStringToValence(""), null);
  assert.equal(moodStringToValence("   "), null);
  // None of those non-string forms should count as a miss; whitespace-only
  // is a string but trims to empty so it is also not a miss.
  assert.equal(getMoodTelemetry().mood_table_miss, 0,
    "no miss counted for non-string / empty");
});

test("getMoodTelemetry returns a frozen snapshot", () => {
  const t = getMoodTelemetry();
  assert.ok(Object.isFrozen(t), "telemetry snapshot must be frozen");
  assert.equal(typeof t.mood_table_miss, "number");
});

test("resetMoodTelemetry zeroes the counter", () => {
  moodStringToValence("xyzzy"); // unknown, ticks counter
  assert.ok(getMoodTelemetry().mood_table_miss > 0);
  resetMoodTelemetry();
  assert.equal(getMoodTelemetry().mood_table_miss, 0);
});

test("cleanup", () => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) {}
});
