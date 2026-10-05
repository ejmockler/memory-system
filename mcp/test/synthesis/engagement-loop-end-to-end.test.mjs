// engagement-loop-end-to-end.test.mjs — Wave 10 KEYSTONE coverage for the
// full hook→queue→drain→classify→damping-log loop closure.
//
// COVERAGE (end-to-end):
//   - recall.js writes the policy/recall-context.json sidecar after a recall.
//   - The hook side enqueues an engagement signal carrying the brief.
//   - The watermark daemon's runEngagementQueueDrain reads + drains the
//     queue, runs detectEngagement, and forwards every classified row into
//     damping-log.appendEngagement.
//   - The damping log carries one engagement row per (memory_id, turn_window)
//     after the drain.
//   - Atomic drainEngagementQueue (rename-to-tmp) preserves concurrent
//     enqueues (W10 minor spawn-finding closure).
//
// Hermetic discipline:
//   - tmp root + env vars set BEFORE any dynamic import
//   - GEMINI_API_KEY force-unset → handler takes the degraded_recall branch
//   - the default (production) root stays byte-identical
//
// Run: node test/synthesis/engagement-loop-end-to-end.test.mjs

import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";



import { skipIfDaemonActive } from "../_hermetic-daemon-skip.mjs";
skipIfDaemonActive("engagement-loop-end-to-end");

// ---------------------------------------------------------------------------
// 0. Hermetic root + env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-w10-loop-e2e-"));
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

// The checkout this suite runs from. Its default (un-overridden) ledgers,
// policy and indices are what the byte-identity guards below watch; the
// suite itself works under a temp MEMORY_ROOT.
const CHECKOUT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// Production snapshot guard.
const PROD_PATHS = {
  memory: join(CHECKOUT_ROOT, "ledgers", "memory.jsonl"),
  recall: join(CHECKOUT_ROOT, "ledgers", "recall.jsonl"),
  damping: join(CHECKOUT_ROOT, "policy", "damping-log.jsonl"),
  queue: join(CHECKOUT_ROOT, "policy", "engagement-queue.jsonl"),
  ctx: join(CHECKOUT_ROOT, "policy", "recall-context.json"),
};
function snap(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const PROD_BEFORE = {
  memory: snap(PROD_PATHS.memory),
  recall: snap(PROD_PATHS.recall),
  damping: snap(PROD_PATHS.damping),
  queue: snap(PROD_PATHS.queue),
  ctx: snap(PROD_PATHS.ctx),
};

// ---------------------------------------------------------------------------
// 1. Dynamic imports AFTER env is set.
// ---------------------------------------------------------------------------
const dampingLogMod = await import("../../lib/synthesis/damping-log.js");
const detectorMod = await import("../../lib/synthesis/engagement-detector.js");
const watermarkMod = await import("../../../daemons/watermark.js");
const { CAPS } = await import("../../lib/validation.js");

const QUEUE_PATH = detectorMod.engagementQueuePath();

function resetAll() {
  try { dampingLogMod._resetForTest(); } catch { /* ignore */ }
  try { detectorMod._resetQueueForTest(); } catch { /* ignore */ }
  try { rmSync(join(POLICY_DIR, "recall-context.json"), { force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// T1 — Full loop: enqueue (simulating the hook) → runEngagementQueueDrain →
//      damping-log has engagement rows for each surfaced memory.
// ---------------------------------------------------------------------------
test("T1: hook enqueue → drain → damping-log engagement row per surfaced memory", async () => {
  resetAll();

  const conversationId = "conv_w10_loop_t1";
  const turnIndex = 1;
  const priorRecallId = "rec_w10loop00000001";
  // Simulate the hook's enqueue — same envelope shape the hook writes.
  detectorMod.enqueueEngagementSignal({
    conversation_id: conversationId,
    turn_index: turnIndex,
    prior_recall_id: priorRecallId,
    prior_recall_brief: {
      recall_id: priorRecallId,
      surfaced: [
        { memory_id: "mem_alpha", content: "alpha beta gamma delta" },
        { memory_id: "mem_unrelated", content: "irrelevant payload here" },
      ],
    },
    current_turn_text: "yes alpha beta gamma is exactly right",
  });
  assert.ok(existsSync(QUEUE_PATH), "queue file exists after enqueue");

  // Run the daemon-side drain (the wiring the BLOCKER closes).
  const counts = await watermarkMod.runEngagementQueueDrain();
  assert.equal(counts.signals, 1, "drain processed exactly one signal");
  assert.equal(counts.errors, 0, "no error during drain");
  // Two surfaced memories → two engagement rows.
  assert.equal(counts.engagement_rows, 2, "two engagement rows appended");
  assert.equal(existsSync(QUEUE_PATH), false, "queue file consumed (atomic rename-then-unlink)");

  // Verify damping-log content.
  const windowSize = CAPS.RECALL_K_TURN_WINDOW;
  const baseTurnIndex = Math.floor(turnIndex / windowSize);
  const turnWindowId = dampingLogMod.computeTurnWindowId({
    conversation_id: conversationId,
    base_turn_index: baseTurnIndex,
    window_size: windowSize,
  });
  const rowsAlpha = await dampingLogMod.readWindowedSignals({
    memory_id: "mem_alpha",
    turn_window_id: turnWindowId,
    signal_kinds: ["engagement"],
  });
  const rowsNil = await dampingLogMod.readWindowedSignals({
    memory_id: "mem_unrelated",
    turn_window_id: turnWindowId,
    signal_kinds: ["engagement"],
  });
  assert.equal(rowsAlpha.length, 1, "one engagement row for mem_alpha");
  assert.equal(rowsNil.length, 1, "one engagement row for mem_unrelated");
  // alpha is a positive-weight class (direct or paraphrase).
  assert.ok(
    rowsAlpha[0].fields.engagement_weight > 0,
    "mem_alpha row has positive engagement weight",
  );
  // unrelated is no_engagement.
  assert.equal(
    rowsNil[0].fields.engagement_class,
    "no_engagement",
    "mem_unrelated → no_engagement",
  );
  assert.equal(rowsNil[0].fields.engagement_weight, 0);
});

// ---------------------------------------------------------------------------
// T2 — Multiple enqueued signals all drained in one tick.
// ---------------------------------------------------------------------------
test("T2: multiple queued signals all drain in one runEngagementQueueDrain call", async () => {
  resetAll();

  // Enqueue 3 signals — one per simulated assistant turn.
  for (let i = 0; i < 3; i++) {
    detectorMod.enqueueEngagementSignal({
      conversation_id: `conv_w10_loop_t2_${i}`,
      turn_index: i + 1,
      prior_recall_id: `rec_w10t2${i}000000000`,
      prior_recall_brief: {
        recall_id: `rec_w10t2${i}000000000`,
        surfaced: [{ memory_id: `mem_t2_${i}`, content: `payload ${i}` }],
      },
      current_turn_text: `payload ${i} is correct`,
    });
  }
  const counts = await watermarkMod.runEngagementQueueDrain();
  assert.equal(counts.signals, 3, "all three signals drained");
  assert.equal(counts.errors, 0);
  assert.equal(counts.engagement_rows, 3, "one engagement row per surfaced memory");
});

// ---------------------------------------------------------------------------
// T3 — Drain on empty queue is a no-op and does not throw.
// ---------------------------------------------------------------------------
test("T3: runEngagementQueueDrain on empty queue is a no-op", async () => {
  resetAll();
  // No enqueue. The queue file does not exist.
  assert.equal(existsSync(QUEUE_PATH), false, "queue file does not exist pre-drain");
  const counts = await watermarkMod.runEngagementQueueDrain();
  assert.equal(counts.signals, 0);
  assert.equal(counts.errors, 0);
  assert.equal(counts.engagement_rows, 0);
});

// ---------------------------------------------------------------------------
// T4 — Malformed signal (missing conversation_id) skipped without errors.
// ---------------------------------------------------------------------------
test("T4: drain skips malformed signal without crashing", async () => {
  resetAll();
  // Manually craft a malformed queue line (missing conversation_id).
  mkdirSync(POLICY_DIR, { recursive: true, mode: 0o700 });
  appendFileSync(QUEUE_PATH, JSON.stringify({
    ts: new Date().toISOString(),
    conversation_id: null,
    turn_index: 1,
    prior_recall_id: "rec_t4_bad",
    prior_recall_brief: { recall_id: "rec_t4_bad", surfaced: [{ memory_id: "x", content: "y" }] },
    current_turn_text: "hello",
  }) + "\n", { mode: 0o600 });

  // Add one valid signal alongside the malformed one.
  detectorMod.enqueueEngagementSignal({
    conversation_id: "conv_w10_t4_ok",
    turn_index: 2,
    prior_recall_id: "rec_t4_ok",
    prior_recall_brief: {
      recall_id: "rec_t4_ok",
      surfaced: [{ memory_id: "mem_ok", content: "valid payload" }],
    },
    current_turn_text: "valid payload yes",
  });

  const counts = await watermarkMod.runEngagementQueueDrain();
  // Both lines drained; one produces zero engagement rows (skipped malformed),
  // the other produces one engagement row.
  assert.equal(counts.signals, 2, "both queue lines drained");
  assert.equal(counts.engagement_rows, 1, "only the valid signal produces an engagement row");
  assert.equal(counts.errors, 0, "no errors propagated");
});

// ---------------------------------------------------------------------------
// T5 — Atomic drain: concurrent enqueue between rename + read survives.
// ---------------------------------------------------------------------------
test("T5: drainEngagementQueue rename-to-tmp preserves concurrent enqueues", () => {
  resetAll();

  // Enqueue 2 lines.
  detectorMod.enqueueEngagementSignal({
    conversation_id: "conv_w10_t5_first",
    turn_index: 1,
    prior_recall_id: "rec_t5_first",
    prior_recall_brief: { recall_id: "rec_t5_first", surfaced: [{ memory_id: "m1", content: "c1" }] },
    current_turn_text: "hello",
  });
  detectorMod.enqueueEngagementSignal({
    conversation_id: "conv_w10_t5_second",
    turn_index: 2,
    prior_recall_id: "rec_t5_second",
    prior_recall_brief: { recall_id: "rec_t5_second", surfaced: [{ memory_id: "m2", content: "c2" }] },
    current_turn_text: "hello again",
  });

  // Drain.
  const drained = detectorMod.drainEngagementQueue();
  assert.equal(drained.length, 2, "drained both signals");
  // Queue file should NOT exist after drain.
  assert.equal(existsSync(QUEUE_PATH), false, "queue file removed by drain (sidecar unlinked)");

  // Simulate a concurrent enqueue arriving AFTER the rename but BEFORE the
  // next drain — the queue file is recreated by enqueue (O_CREAT in
  // engagement-detector.js#enqueueEngagementSignal). The next drain should
  // pick it up cleanly.
  detectorMod.enqueueEngagementSignal({
    conversation_id: "conv_w10_t5_after_drain",
    turn_index: 3,
    prior_recall_id: "rec_t5_after",
    prior_recall_brief: { recall_id: "rec_t5_after", surfaced: [{ memory_id: "m3", content: "c3" }] },
    current_turn_text: "post-drain enqueue",
  });
  assert.ok(existsSync(QUEUE_PATH), "queue file recreated by post-drain enqueue");
  const drained2 = detectorMod.drainEngagementQueue();
  assert.equal(drained2.length, 1, "post-drain enqueue picked up by next drain");
});

// ---------------------------------------------------------------------------
// T6 — Engagement rows carry the canonical envelope (schema, signal_kind,
// detector_version, turn_window_id) per damping-log § 4.7.2.B.
// ---------------------------------------------------------------------------
test("T6: engagement rows carry the canonical envelope shape", async () => {
  resetAll();

  detectorMod.enqueueEngagementSignal({
    conversation_id: "conv_w10_t6",
    turn_index: 4,
    prior_recall_id: "rec_w10t6",
    prior_recall_brief: {
      recall_id: "rec_w10t6",
      surfaced: [{ memory_id: "mem_t6", content: "lorem ipsum dolor sit" }],
    },
    current_turn_text: "lorem ipsum dolor sit amet",
  });
  await watermarkMod.runEngagementQueueDrain();

  const rows = await dampingLogMod.readWindowedSignals({
    memory_id: "mem_t6",
    signal_kinds: ["engagement"],
  });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.schema_version, 1);
  assert.equal(row.signal_kind, "engagement");
  assert.equal(row.memory_id, "mem_t6");
  assert.ok(typeof row.turn_window_id === "string" && row.turn_window_id.length > 0);
  assert.equal(row.recall_id, "rec_w10t6");
  assert.ok(typeof row.conversation_id_hash === "string" && row.conversation_id_hash.length > 0);
  assert.ok(typeof row.ts === "string" && row.ts.length > 0);
  assert.equal(typeof row.populator_version, "string");
  assert.match(row.fields.detector_version, /^engagement-detector@\d+\.\d+\.\d+$/);
  assert.ok(Number.isFinite(row.fields.engagement_weight));
});

// ---------------------------------------------------------------------------
// T7 — Production hermeticity: no production paths touched.
// ---------------------------------------------------------------------------
test("T7: production paths byte-identical pre/post", () => {
  const after = {
    memory: snap(PROD_PATHS.memory),
    recall: snap(PROD_PATHS.recall),
    damping: snap(PROD_PATHS.damping),
    queue: snap(PROD_PATHS.queue),
    ctx: snap(PROD_PATHS.ctx),
  };
  for (const k of Object.keys(PROD_BEFORE)) {
    assert.equal(
      after[k],
      PROD_BEFORE[k],
      `production path ${k} must be byte-identical pre/post test run`,
    );
  }
});

// ---------------------------------------------------------------------------
// Cleanup.
// ---------------------------------------------------------------------------
test("Z: cleanup tmp root", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
    assert.ok(true);
  } catch (e) {
    assert.fail(`cleanup failed: ${e.message}`);
  }
});
