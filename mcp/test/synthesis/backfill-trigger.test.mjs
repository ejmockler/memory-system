// backfill-trigger.test.mjs — W4-CCS coverage for F-CCS-BACKFILL-trigger.
//
// Asserts the drift-detector's backfill-trigger extension contract:
//   - extractor_version_bump alert → backfill-queue.jsonl entry appended.
//   - Queue drain (drainBackfillQueue) reads + returns parsed task entries.
//   - Defensive: queue read on a missing/empty/corrupt file → no crash.
//   - Idempotence: same alert firing twice → only ONE queue entry, gated by
//     the backfillAlertId({kind, axis, sorted(current)}) dedupe key.
//   - Module-surface invariants: BACKFILL_QUEUE_VERSION + frozen
//     BACKFILL_QUEUE_CAPS + backfillQueuePath() + enqueueBackfillTask() +
//     readBackfillQueue() + drainBackfillQueue() + backfillAlertId() are
//     all exported.
//   - The detectDrift() default code-path does NOT touch the queue (opt-in
//     only). Preserves the existing W12 health surface's no-side-effect
//     contract.
//
// Discipline:
//   - HERMETIC: env vars + tmpdir BEFORE any dynamic import so the queue
//     path resolves under TMP_ROOT (mirrors the engagement-queue test
//     hermeticity pattern from W9).
//   - node:test + node:assert/strict.
//   - 12+ assertions across the suite.
//
// Run:
//   node --test test/synthesis/backfill-trigger.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hermetic env. MUST be set BEFORE any dynamic import touches config.js so
// the backfill-queue path lands under TMP_ROOT.
// ---------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-backfill-trigger-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.POLICY_BASE_DIR = join(TMP_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TMP_ROOT, "ledgers");
process.env.HOOKS_BASE_DIR = join(TMP_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(TMP_ROOT, "daemons");

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
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {}
});

// Defensive imports — try/catch documents the module-load contract.
let driftMod;
try {
  driftMod = await import("../../lib/synthesis/drift-detector.js");
} catch (err) {
  console.error("FATAL: drift-detector import failed:", err);
  process.exit(1);
}

const {
  detectDrift,
  DRIFT_ALERT_KINDS,
  BACKFILL_QUEUE_VERSION,
  BACKFILL_QUEUE_CAPS,
  backfillQueuePath,
  backfillAlertId,
  enqueueBackfillTask,
  readBackfillQueue,
  drainBackfillQueue,
  _resetBackfillQueueForTest,
} = driftMod;

// Helper: write JSONL rows to a file. One row per line, trailing newline.
function writeJsonl(path, rows) {
  const text =
    rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  writeFileSync(path, text, { mode: 0o600 });
}

// Clock anchor. Fixed so window-filter assertions are deterministic.
const NOW = new Date("2026-06-20T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const isoDaysAgo = (daysAgo) =>
  new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();

function factWithVersion(id, daysAgo, opts) {
  const o = opts || {};
  return {
    id,
    kind: "fact",
    ts: isoDaysAgo(daysAgo),
    content: "backfill-trigger fixture",
    features: {
      entities: [{ canonical_id: "topic:test:a", kind: "topic" }],
      entity_extractor_version: o.entityVersion || "v0.1.0",
      time_anchors: [
        { instant_iso: isoDaysAgo(daysAgo), kind: "explicit", resolver: "test" },
      ],
      time_anchor_resolver_version: o.timeAnchorVersion || "v0.1.0",
      valence: 0.2,
      valence_model_version: "lexicon-v1",
      episodicity: 0.6,
      episodicity_version: "v0.1.0",
    },
  };
}

const LEDGER_PATH = join(TMP_ROOT, "ledgers", "memory.jsonl");
const RECALL_PATH = join(TMP_ROOT, "ledgers", "recall.jsonl");

// ---------------------------------------------------------------------------
// T0 — module-surface invariant: VERSION + frozen CAPS + helper exports.
// ---------------------------------------------------------------------------
test("T0: module exports BACKFILL_QUEUE_VERSION + frozen CAPS + helpers", () => {
  assert.equal(
    typeof BACKFILL_QUEUE_VERSION,
    "string",
    "BACKFILL_QUEUE_VERSION is exported as string",
  );
  assert.equal(BACKFILL_QUEUE_VERSION, "v0.1.0", "queue version matches WU pin");
  assert.equal(
    Object.isFrozen(BACKFILL_QUEUE_CAPS),
    true,
    "BACKFILL_QUEUE_CAPS is frozen (cap-discipline)",
  );
  assert.equal(
    BACKFILL_QUEUE_CAPS.TASKS_PER_TICK,
    5,
    "TASKS_PER_TICK pinned per spec §5.2",
  );
  assert.equal(typeof backfillQueuePath, "function", "backfillQueuePath exported");
  assert.equal(typeof backfillAlertId, "function", "backfillAlertId exported");
  assert.equal(
    typeof enqueueBackfillTask,
    "function",
    "enqueueBackfillTask exported",
  );
  assert.equal(typeof readBackfillQueue, "function", "readBackfillQueue exported");
  assert.equal(typeof drainBackfillQueue, "function", "drainBackfillQueue exported");
  assert.ok(
    backfillQueuePath().startsWith(TMP_ROOT),
    `queue path is under TMP_ROOT (got ${backfillQueuePath()})`,
  );
  assert.ok(
    backfillQueuePath().endsWith("backfill-queue.jsonl"),
    "queue file name is backfill-queue.jsonl",
  );
});

// ---------------------------------------------------------------------------
// T1 — extractor_version_bump alert → backfill-queue.jsonl entry appended
// when enqueueBackfill:true is passed to detectDrift.
// ---------------------------------------------------------------------------
test("T1: version-bump alert with enqueueBackfill:true → queue entry written", async () => {
  _resetBackfillQueueForTest();
  const rows = [
    // Baseline: all v0.1.0
    factWithVersion("b1", 14, { entityVersion: "v0.1.0" }),
    factWithVersion("b2", 16, { entityVersion: "v0.1.0" }),
    factWithVersion("b3", 18, { entityVersion: "v0.1.0" }),
    // Alert window: interleaved v0.1.0 + v0.2.0 → fires version_bump
    factWithVersion("c1", 1, { entityVersion: "v0.1.0" }),
    factWithVersion("c2", 2, { entityVersion: "v0.2.0" }),
    factWithVersion("c3", 3, { entityVersion: "v0.2.0" }),
  ];
  writeJsonl(LEDGER_PATH, rows);
  writeJsonl(RECALL_PATH, []);

  const env = await detectDrift({
    ledgerPath: LEDGER_PATH,
    recallLogPath: RECALL_PATH,
    now: NOW,
    enqueueBackfill: true,
  });

  const bumpAlerts = env.alerts.filter(
    (a) => a.kind === DRIFT_ALERT_KINDS.EXTRACTOR_VERSION_BUMP,
  );
  assert.ok(bumpAlerts.length >= 1, "version-bump alert fired");

  const queue = readBackfillQueue();
  assert.ok(
    queue.length >= 1,
    `expected ≥1 queue entry after version-bump enqueue, got ${queue.length}`,
  );
  const entry = queue[0];
  assert.equal(entry.reason, "extractor_version_bump", "reason populated");
  assert.equal(entry.axis, "entity_extractor_version", "axis populated");
  assert.ok(
    Array.isArray(entry.current_versions) &&
      entry.current_versions.includes("v0.2.0"),
    "current_versions snapshot includes v0.2.0",
  );
  assert.deepEqual(
    entry.fact_ids,
    ["*"],
    "fact_ids defaults to ['*'] (backfill all) when trigger has no specific list",
  );
  assert.equal(entry.queue_version, BACKFILL_QUEUE_VERSION, "queue_version stamped");
  assert.equal(typeof entry.alert_id, "string", "alert_id present (dedupe surface)");
  assert.equal(typeof entry.scheduled_at, "string", "scheduled_at ISO present");
});

// ---------------------------------------------------------------------------
// T2 — default detectDrift call (enqueueBackfill omitted) is a no-op on
// the queue. Guards the W12 health surface against a surprise side effect.
// ---------------------------------------------------------------------------
test("T2: detectDrift without enqueueBackfill leaves queue untouched", async () => {
  _resetBackfillQueueForTest();
  const rows = [
    factWithVersion("b1", 14, { entityVersion: "v0.1.0" }),
    factWithVersion("c1", 1, { entityVersion: "v0.1.0" }),
    factWithVersion("c2", 2, { entityVersion: "v0.2.0" }),
  ];
  writeJsonl(LEDGER_PATH, rows);
  writeJsonl(RECALL_PATH, []);

  const env = await detectDrift({
    ledgerPath: LEDGER_PATH,
    recallLogPath: RECALL_PATH,
    now: NOW,
    // enqueueBackfill omitted → default false
  });

  assert.ok(env.alerts.length >= 1, "alerts still computed in default path");
  const queue = readBackfillQueue();
  assert.equal(
    queue.length,
    0,
    `default detectDrift must not touch queue (got ${queue.length})`,
  );
});

// ---------------------------------------------------------------------------
// T3 — drainBackfillQueue reads + removes queue entries (rename-to-tmp
// pattern). After drain the queue file is empty / absent.
// ---------------------------------------------------------------------------
test("T3: drainBackfillQueue reads + empties the queue", () => {
  _resetBackfillQueueForTest();
  enqueueBackfillTask({
    alert_id: "extractor_version_bump|entity_extractor_version|v0.1.0,v0.2.0",
    reason: "extractor_version_bump",
    axis: "entity_extractor_version",
    baseline_versions: ["v0.1.0"],
    current_versions: ["v0.1.0", "v0.2.0"],
  });
  enqueueBackfillTask({
    alert_id: "extractor_version_bump|episodicity_version|v0.1.0,v0.2.0",
    reason: "extractor_version_bump",
    axis: "episodicity_version",
    baseline_versions: ["v0.1.0"],
    current_versions: ["v0.1.0", "v0.2.0"],
  });

  const preDrain = readBackfillQueue();
  assert.equal(preDrain.length, 2, "two entries staged before drain");

  const drained = drainBackfillQueue();
  assert.equal(drained.length, 2, "drain returns both entries");
  assert.equal(
    drained[0].axis,
    "entity_extractor_version",
    "first entry preserved in order",
  );
  assert.equal(
    drained[1].axis,
    "episodicity_version",
    "second entry preserved in order",
  );

  const postDrain = readBackfillQueue();
  assert.equal(postDrain.length, 0, "queue empty after drain");

  // Second drain on an empty queue returns [] (idempotent at the drainer)
  const secondDrain = drainBackfillQueue();
  assert.equal(
    secondDrain.length,
    0,
    "second drain on empty queue returns empty array",
  );
});

// ---------------------------------------------------------------------------
// T4 — defensive: missing/empty/corrupt queue file → no crash, return [].
// ---------------------------------------------------------------------------
test("T4: defensive — missing + corrupt queue file degrade to []", () => {
  _resetBackfillQueueForTest();

  // Missing file
  assert.equal(
    existsSync(backfillQueuePath()),
    false,
    "queue file absent at start",
  );
  assert.deepEqual(
    readBackfillQueue(),
    [],
    "read on missing file returns empty array (no throw)",
  );
  assert.deepEqual(
    drainBackfillQueue(),
    [],
    "drain on missing file returns empty array (no throw)",
  );

  // Corrupt mid-file: valid line, then garbage, then another valid line.
  // The reader must SKIP the garbage and surface the two valid lines.
  const goodA = JSON.stringify({
    ts: NOW.toISOString(),
    alert_id: "alpha",
    reason: "extractor_version_bump",
    axis: "entity_extractor_version",
    baseline_versions: [],
    current_versions: ["v0.2.0"],
    fact_ids: ["*"],
    scheduled_at: NOW.toISOString(),
    queue_version: BACKFILL_QUEUE_VERSION,
  });
  const goodB = JSON.stringify({
    ts: NOW.toISOString(),
    alert_id: "beta",
    reason: "extractor_version_bump",
    axis: "episodicity_version",
    baseline_versions: [],
    current_versions: ["v0.2.0"],
    fact_ids: ["*"],
    scheduled_at: NOW.toISOString(),
    queue_version: BACKFILL_QUEUE_VERSION,
  });
  writeFileSync(
    backfillQueuePath(),
    goodA + "\n{this is not json}\n" + goodB + "\n",
    { mode: 0o600 },
  );
  const read = readBackfillQueue();
  assert.equal(
    read.length,
    2,
    `corrupt mid-file: reader surfaces 2 valid lines, skipped garbage; got ${read.length}`,
  );
  assert.equal(read[0].alert_id, "alpha", "first valid line preserved");
  assert.equal(read[1].alert_id, "beta", "second valid line preserved");

  _resetBackfillQueueForTest();

  // Empty file
  writeFileSync(backfillQueuePath(), "", { mode: 0o600 });
  assert.deepEqual(
    readBackfillQueue(),
    [],
    "read on empty file returns empty array",
  );
  assert.deepEqual(
    drainBackfillQueue(),
    [],
    "drain on empty file returns empty array",
  );
});

// ---------------------------------------------------------------------------
// T5 — idempotence: same alert firing twice produces ONE queue entry.
// Both via direct enqueueBackfillTask and via repeated detectDrift().
// ---------------------------------------------------------------------------
test("T5: idempotence — repeated alert with same id dedupes to ONE entry", async () => {
  _resetBackfillQueueForTest();

  // Direct dedupe via enqueueBackfillTask
  const alertId = "extractor_version_bump|entity_extractor_version|v0.1.0,v0.2.0";
  const first = enqueueBackfillTask({
    alert_id: alertId,
    reason: "extractor_version_bump",
    axis: "entity_extractor_version",
    baseline_versions: ["v0.1.0"],
    current_versions: ["v0.1.0", "v0.2.0"],
  });
  const second = enqueueBackfillTask({
    alert_id: alertId,
    reason: "extractor_version_bump",
    axis: "entity_extractor_version",
    baseline_versions: ["v0.1.0"],
    current_versions: ["v0.1.0", "v0.2.0"],
  });
  assert.equal(first, true, "first enqueue → true (appended)");
  assert.equal(second, false, "second enqueue with same alert_id → false (deduped)");
  const queueAfterDirect = readBackfillQueue();
  assert.equal(
    queueAfterDirect.length,
    1,
    "queue holds ONE entry after duplicate enqueue (dedupe by alert_id)",
  );

  _resetBackfillQueueForTest();

  // End-to-end dedupe via detectDrift fired twice
  const rows = [
    factWithVersion("b1", 14, { entityVersion: "v0.1.0" }),
    factWithVersion("b2", 16, { entityVersion: "v0.1.0" }),
    factWithVersion("c1", 1, { entityVersion: "v0.1.0" }),
    factWithVersion("c2", 2, { entityVersion: "v0.2.0" }),
    factWithVersion("c3", 3, { entityVersion: "v0.2.0" }),
  ];
  writeJsonl(LEDGER_PATH, rows);
  writeJsonl(RECALL_PATH, []);

  await detectDrift({
    ledgerPath: LEDGER_PATH,
    recallLogPath: RECALL_PATH,
    now: NOW,
    enqueueBackfill: true,
  });
  const after1 = readBackfillQueue().length;
  await detectDrift({
    ledgerPath: LEDGER_PATH,
    recallLogPath: RECALL_PATH,
    now: NOW,
    enqueueBackfill: true,
  });
  const after2 = readBackfillQueue().length;
  assert.equal(
    after1,
    after2,
    `repeated detectDrift on same fixture must not grow queue (${after1} → ${after2})`,
  );
  assert.ok(
    after1 >= 1,
    `first detectDrift enqueued at least one entry (got ${after1})`,
  );
});

// ---------------------------------------------------------------------------
// T6 — backfillAlertId is stable across permuted current-version arrays.
// Same {kind, axis, set-of-current-versions} → same id regardless of order.
// ---------------------------------------------------------------------------
test("T6: backfillAlertId is order-independent on current_versions", () => {
  const a = backfillAlertId({
    kind: DRIFT_ALERT_KINDS.EXTRACTOR_VERSION_BUMP,
    axis: "entity_extractor_version",
    current: ["v0.1.0", "v0.2.0"],
    baseline: ["v0.1.0"],
  });
  const b = backfillAlertId({
    kind: DRIFT_ALERT_KINDS.EXTRACTOR_VERSION_BUMP,
    axis: "entity_extractor_version",
    current: ["v0.2.0", "v0.1.0"],
    baseline: ["v0.1.0"],
  });
  assert.equal(a, b, "permuted current arrays produce identical alert_id");
  assert.ok(
    a.startsWith("extractor_version_bump|entity_extractor_version|"),
    `alert_id has the expected shape (got ${a})`,
  );

  const differentAxis = backfillAlertId({
    kind: DRIFT_ALERT_KINDS.EXTRACTOR_VERSION_BUMP,
    axis: "episodicity_version",
    current: ["v0.1.0", "v0.2.0"],
    baseline: ["v0.1.0"],
  });
  assert.notEqual(
    a,
    differentAxis,
    "different axis must produce a different alert_id",
  );
  assert.equal(
    backfillAlertId(null),
    null,
    "null input degrades to null (no throw)",
  );
  assert.equal(
    backfillAlertId("not-an-object"),
    null,
    "non-object input degrades to null",
  );
});

// ---------------------------------------------------------------------------
// T7 — drainBackfillQueue honours maxTasks cap and re-enqueues the tail.
// Daemon idle tick passes BACKFILL_QUEUE_CAPS.TASKS_PER_TICK; tail must
// survive until the next drain.
// ---------------------------------------------------------------------------
test("T7: drainBackfillQueue maxTasks cap re-enqueues the tail", () => {
  _resetBackfillQueueForTest();

  // Stage 8 entries; cap=3 → first drain returns 3 + leaves 5 for next tick.
  for (let i = 0; i < 8; i++) {
    enqueueBackfillTask({
      alert_id: `synthetic|axis|v0.${i}.0`,
      reason: "extractor_version_bump",
      axis: "entity_extractor_version",
      baseline_versions: ["v0.1.0"],
      current_versions: [`v0.${i}.0`],
    });
  }
  assert.equal(readBackfillQueue().length, 8, "8 entries staged");

  const firstDrain = drainBackfillQueue({ maxTasks: 3 });
  assert.equal(firstDrain.length, 3, "first drain returns 3 entries (cap)");
  const afterFirst = readBackfillQueue();
  assert.equal(afterFirst.length, 5, "5 entries re-enqueued for next tick");

  const secondDrain = drainBackfillQueue({ maxTasks: 3 });
  assert.equal(secondDrain.length, 3, "second drain returns next 3 entries");
  assert.equal(
    readBackfillQueue().length,
    2,
    "2 entries remain after second drain",
  );

  const thirdDrain = drainBackfillQueue({ maxTasks: 100 });
  assert.equal(thirdDrain.length, 2, "third drain returns final 2 entries");
  assert.equal(readBackfillQueue().length, 0, "queue empty after final drain");
});

// ---------------------------------------------------------------------------
// T8 — enqueueBackfillTask rejects malformed input loudly. The drift-
// detector wraps the call site in try/catch; this asserts the underlying
// helper's contract.
// ---------------------------------------------------------------------------
test("T8: enqueueBackfillTask validates input shape", () => {
  _resetBackfillQueueForTest();
  assert.throws(
    () => enqueueBackfillTask(null),
    /task must be an object/,
    "null task rejected",
  );
  assert.throws(
    () => enqueueBackfillTask({}),
    /alert_id required/,
    "missing alert_id rejected",
  );
  assert.throws(
    () => enqueueBackfillTask({ alert_id: "" }),
    /alert_id required/,
    "empty alert_id rejected",
  );
  // Successful enqueue after the throw cluster — proves the queue is still
  // usable post-error (no half-open file descriptor leak).
  const ok = enqueueBackfillTask({
    alert_id: "post-error-sanity",
    reason: "extractor_version_bump",
    axis: "entity_extractor_version",
    baseline_versions: [],
    current_versions: ["v0.2.0"],
  });
  assert.equal(ok, true, "enqueue still works after validation throws");
  assert.equal(readBackfillQueue().length, 1, "one entry post-error");
});
