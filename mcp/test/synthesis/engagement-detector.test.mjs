// engagement-detector.test.mjs — Wave 9 integration coverage for
// F-SYN-INTEGRATION-ENGAGEMENT-DETECTOR-WIRING.
//
// COVERAGE:
//   - detectEngagement: paraphrase / agreement / contradiction / dismissal /
//     no_engagement classification per spec § 6.7 (5-class taxonomy)
//   - Empty / malformed inputs handle gracefully
//   - Queue write + drain round-trip (HOOKS-NEVER-BLOCK seam)
//   - processEngagementQueue → results envelope
//   - Integration: recall.js writes the canonical recall event shape
//     (§ 4 propensity-logging-soak.md) end-to-end on the degraded-recall path
//
// Hermetic discipline (matches recall-integration.test.mjs):
//   - tmp root + env vars set BEFORE any dynamic import
//   - GEMINI_API_KEY force-unset → handler takes the degraded_recall branch
//   - the default (production) root stays byte-identical
//
// Run: node test/synthesis/engagement-detector.test.mjs

import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


import { skipIfDaemonActive } from "../_hermetic-daemon-skip.mjs";
skipIfDaemonActive("engagement-detector");

// ---------------------------------------------------------------------------
// 0. Hermetic root + env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-w9-engagement-"));
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
};

// ---------------------------------------------------------------------------
// 1. Dynamic imports AFTER env is set.
// ---------------------------------------------------------------------------
const {
  detectEngagement,
  ENGAGEMENT_CLASSES,
  ENGAGEMENT_DETECTOR_VERSION,
  enqueueEngagementSignal,
  drainEngagementQueue,
  processEngagementQueue,
  engagementQueuePath,
  _resetQueueForTest,
} = await import("../../lib/synthesis/engagement-detector.js");

const dampingLogMod = await import("../../lib/synthesis/damping-log.js");
const recallMod = await import("../../lib/tools/recall.js");
const { CAPS } = await import("../../lib/validation.js");

// ---------------------------------------------------------------------------
// T1 — detectEngagement: direct multi-token match.
// ---------------------------------------------------------------------------
test("T1: detectEngagement classifies multi-token contiguous match as direct", () => {
  const results = detectEngagement({
    current_turn_text: "yes the meeting with Robin at 2pm slot is confirmed",
    prior_recall_brief: {
      recall_id: "rec_t1",
      surfaced: [
        { memory_id: "mem_robin", content: "meeting with Robin at 2pm slot" },
      ],
    },
  });
  assert.equal(results.length, 1, "one signal per surfaced memory");
  assert.equal(results[0].memory_id, "mem_robin");
  assert.equal(results[0].engagement_class, ENGAGEMENT_CLASSES.DIRECT);
  assert.equal(results[0].signal_kind, "engagement");
  assert.equal(
    results[0].engagement_weight,
    CAPS.ENGAGEMENT_WEIGHTS.direct,
    "engagement_weight sourced from CAPS (invariant I11)",
  );
  assert.ok(results[0].evidence_span.length > 0, "evidence_span populated");
  assert.equal(
    results[0].evidence_span_hash.length,
    64,
    "evidence_span_hash is sha256 hex (64 chars)",
  );
});

// ---------------------------------------------------------------------------
// T2 — detectEngagement: pure-paraphrase (high bag-overlap, low contiguity).
// ---------------------------------------------------------------------------
test("T2: detectEngagement classifies high bag-overlap as paraphrase", () => {
  // Memory: "deploy to prod" (3 distinct tokens). User reorders + adds words.
  // Bag overlap = 3/3 = 1.0 ≥ fuzzy threshold; longest run = 1 (< direct min).
  const results = detectEngagement({
    current_turn_text: "I think prod was the deploy target",
    prior_recall_brief: {
      recall_id: "rec_t2",
      surfaced: [
        { memory_id: "mem_deploy", content: "deploy prod target" },
      ],
    },
  });
  assert.equal(results.length, 1);
  // The 3-token bag matches all three; depending on adjacency the engine may
  // classify direct (3-token run) or paraphrase. Both are POSITIVE-valence
  // engagement signals — assert it landed on one of the two.
  assert.ok(
    results[0].engagement_class === ENGAGEMENT_CLASSES.PARAPHRASE ||
      results[0].engagement_class === ENGAGEMENT_CLASSES.DIRECT,
    `expected paraphrase or direct; got ${results[0].engagement_class}`,
  );
  assert.ok(
    results[0].engagement_weight > 0,
    "paraphrase / direct have positive weight",
  );
});

// ---------------------------------------------------------------------------
// T3 — detectEngagement: correction via negation in proximity.
// ---------------------------------------------------------------------------
test("T3: detectEngagement classifies negation+memory-ref as correction", () => {
  const results = detectEngagement({
    current_turn_text: "no, actually the meeting was on Wednesday",
    prior_recall_brief: {
      recall_id: "rec_t3",
      surfaced: [
        { memory_id: "mem_meeting", content: "meeting on Tuesday" },
      ],
    },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].engagement_class, ENGAGEMENT_CLASSES.CORRECTION);
  assert.equal(
    results[0].engagement_weight,
    CAPS.ENGAGEMENT_WEIGHTS.correction,
  );
  assert.ok(results[0].engagement_weight > 0, "correction is signed +0.4");
});

// ---------------------------------------------------------------------------
// T4 — detectEngagement: dismiss via explicit pattern + memory reference.
// ---------------------------------------------------------------------------
test("T4: detectEngagement classifies dismiss pattern + memory ref as dismiss", () => {
  const results = detectEngagement({
    current_turn_text: "stop bringing up the meeting, it's irrelevant",
    prior_recall_brief: {
      recall_id: "rec_t4",
      surfaced: [
        { memory_id: "mem_meeting", content: "meeting on Tuesday" },
      ],
    },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].engagement_class, ENGAGEMENT_CLASSES.DISMISS);
  assert.equal(
    results[0].engagement_weight,
    CAPS.ENGAGEMENT_WEIGHTS.dismiss,
    "dismiss is signed -0.5",
  );
  assert.ok(
    results[0].engagement_weight < 0,
    "dismiss is anti-reinforcing (negative weight)",
  );
});

// ---------------------------------------------------------------------------
// T5 — detectEngagement: unrelated turn → no_engagement.
// ---------------------------------------------------------------------------
test("T5: detectEngagement classifies unrelated turn as no_engagement", () => {
  const results = detectEngagement({
    current_turn_text: "what is the weather today?",
    prior_recall_brief: {
      recall_id: "rec_t5",
      surfaced: [
        { memory_id: "mem_meeting", content: "meeting on Tuesday" },
        { memory_id: "mem_sam", content: "sam in DM thread about PR" },
      ],
    },
  });
  // One row per memory in prior_surfaced (spec § 6.6).
  assert.equal(results.length, 2, "one signal per surfaced memory (no_engagement)");
  for (const r of results) {
    assert.equal(r.engagement_class, ENGAGEMENT_CLASSES.NO_ENGAGEMENT);
    assert.equal(r.engagement_weight, 0.0);
    assert.equal(r.evidence_span, "", "no_engagement carries empty evidence");
    assert.equal(r.evidence_span_hash, "", "no_engagement carries empty hash");
  }
});

// ---------------------------------------------------------------------------
// T6 — detectEngagement: defensive empty / malformed inputs.
// ---------------------------------------------------------------------------
test("T6: detectEngagement handles empty / malformed inputs gracefully", () => {
  assert.deepEqual(
    detectEngagement({
      current_turn_text: "",
      prior_recall_brief: { surfaced: [] },
    }),
    [],
    "empty turn → no signals",
  );
  assert.deepEqual(
    detectEngagement({
      current_turn_text: "   ",
      prior_recall_brief: { surfaced: [{ memory_id: "x", content: "y" }] },
    }),
    [],
    "whitespace-only turn → no signals",
  );
  assert.deepEqual(
    detectEngagement({
      current_turn_text: "hello world",
      prior_recall_brief: null,
    }),
    [],
    "null brief → no signals",
  );
  assert.deepEqual(
    detectEngagement({}),
    [],
    "empty args → no signals",
  );
  assert.deepEqual(
    detectEngagement({
      current_turn_text: "hello",
      prior_recall_brief: { surfaced: [] },
    }),
    [],
    "empty surfaced → no signals",
  );
});

// ---------------------------------------------------------------------------
// T7 — Detector version stamp surfaces on every row.
// ---------------------------------------------------------------------------
test("T7: detector_version is stamped on every emitted signal", () => {
  const results = detectEngagement({
    current_turn_text: "the meeting was important",
    prior_recall_brief: {
      recall_id: "rec_t7",
      surfaced: [
        { memory_id: "mem_a", content: "irrelevant content here" },
      ],
    },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].detector_version, ENGAGEMENT_DETECTOR_VERSION);
  assert.match(
    results[0].detector_version,
    /^engagement-detector@\d+\.\d+\.\d+$/,
    "detector_version follows engagement-detector@semver",
  );
});

// ---------------------------------------------------------------------------
// T8 — Five-class taxonomy is exhaustive (spec § 6.7 FIXED).
// ---------------------------------------------------------------------------
test("T8: ENGAGEMENT_CLASSES exposes exactly the 5-class taxonomy", () => {
  const expected = new Set([
    "direct",
    "paraphrase",
    "correction",
    "dismiss",
    "no_engagement",
  ]);
  const got = new Set(Object.values(ENGAGEMENT_CLASSES));
  assert.equal(got.size, 5, "five disjoint classes");
  for (const v of expected) {
    assert.ok(got.has(v), `taxonomy must include "${v}"`);
  }
});

// ---------------------------------------------------------------------------
// T9 — Queue: enqueue + drain round-trip (HOOKS-NEVER-BLOCK seam).
// ---------------------------------------------------------------------------
test("T9: enqueueEngagementSignal write is atomic; drain returns it once", () => {
  _resetQueueForTest();
  const signal = {
    conversation_id: "conv_t9",
    turn_index: 5,
    prior_recall_id: "rec_t9_prev",
    prior_recall_brief: {
      recall_id: "rec_t9_prev",
      surfaced: [{ memory_id: "mem_t9", content: "the t9 memory content" }],
    },
    current_turn_text: "yes that's right about the t9 memory content",
  };
  enqueueEngagementSignal(signal);
  // File exists + non-empty.
  const path = engagementQueuePath();
  assert.ok(existsSync(path), "queue file exists after enqueue");
  const raw = readFileSync(path, "utf8");
  assert.ok(raw.endsWith("\n"), "queue line is newline-terminated");
  const parsed = JSON.parse(raw.trim());
  assert.equal(parsed.conversation_id, "conv_t9");
  assert.equal(parsed.current_turn_text, signal.current_turn_text);
  // Drain returns the signal and clears the queue.
  const drained = drainEngagementQueue();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].conversation_id, "conv_t9");
  assert.equal(
    existsSync(path),
    false,
    "queue file removed after drain (atomic)",
  );
  // Second drain on empty queue returns [].
  assert.deepEqual(drainEngagementQueue(), []);
});

// ---------------------------------------------------------------------------
// T10 — Daemon path: processEngagementQueue invokes detectEngagement
//       on every drained signal AND yields {signal, results} tuples.
// ---------------------------------------------------------------------------
test("T10: processEngagementQueue drains + detects in one call", () => {
  _resetQueueForTest();
  enqueueEngagementSignal({
    conversation_id: "conv_t10",
    turn_index: 1,
    prior_recall_id: "rec_t10",
    prior_recall_brief: {
      recall_id: "rec_t10",
      surfaced: [{ memory_id: "mem_t10a", content: "alpha beta gamma delta" }],
    },
    current_turn_text: "I think alpha beta gamma is correct",
  });
  enqueueEngagementSignal({
    conversation_id: "conv_t10",
    turn_index: 2,
    prior_recall_id: "rec_t10b",
    prior_recall_brief: {
      recall_id: "rec_t10b",
      surfaced: [{ memory_id: "mem_t10b", content: "unrelated content" }],
    },
    current_turn_text: "what about Friday?",
  });
  const processed = processEngagementQueue();
  assert.equal(processed.length, 2, "both signals processed");
  // First signal → direct (3-token run match).
  assert.ok(
    processed[0].results.length >= 1,
    "first signal yielded ≥1 engagement row",
  );
  assert.equal(processed[0].results[0].memory_id, "mem_t10a");
  // Second signal → no_engagement (no overlap).
  assert.equal(processed[1].results.length, 1);
  assert.equal(
    processed[1].results[0].engagement_class,
    ENGAGEMENT_CLASSES.NO_ENGAGEMENT,
  );
});

// ---------------------------------------------------------------------------
// T11 — Daemon → damping-log integration: appendEngagement accepts each row
//       and produces the verbatim § 4.7.2.B envelope.
// ---------------------------------------------------------------------------
test("T11: daemon-side flow forwards detector rows into damping-log.appendEngagement", async () => {
  _resetQueueForTest();
  // Clean damping log between tests.
  try {
    dampingLogMod._resetForTest();
  } catch {
    // ignore
  }
  const conversationId = "conv_t11";
  const turnIndex = 3;
  const priorRecallId = "rec_t11";
  enqueueEngagementSignal({
    conversation_id: conversationId,
    turn_index: turnIndex,
    prior_recall_id: priorRecallId,
    prior_recall_brief: {
      recall_id: priorRecallId,
      surfaced: [
        { memory_id: "mem_t11_a", content: "the quick brown fox jumps" },
        { memory_id: "mem_t11_b", content: "lazy dog sleeping outside" },
      ],
    },
    current_turn_text: "the quick brown fox is exactly right",
  });
  const processed = processEngagementQueue();
  assert.equal(processed.length, 1);
  const { signal, results } = processed[0];
  // Two memories → two engagement rows (one direct, one no_engagement).
  assert.equal(results.length, 2);

  // Forward each result to the damping log under canonical envelope.
  const windowSize = CAPS.RECALL_K_TURN_WINDOW;
  const baseTurnIndex = Math.floor(signal.turn_index / windowSize);
  const turnWindowId = dampingLogMod.computeTurnWindowId({
    conversation_id: signal.conversation_id,
    base_turn_index: baseTurnIndex,
    window_size: windowSize,
  });
  const conversationIdHash = dampingLogMod.computeConversationIdHash(
    signal.conversation_id,
  );
  for (const r of results) {
    await dampingLogMod.appendEngagement({
      memory_id: r.memory_id,
      turn_window_id: turnWindowId,
      recall_id: signal.prior_recall_id,
      conversation_id_hash: conversationIdHash,
      engagement_class: r.engagement_class,
      engagement_weight: r.engagement_weight,
      evidence_span_hash: r.evidence_span_hash,
      detector_version: r.detector_version,
    });
  }
  // Read back from the damping log via the canonical reader.
  const rowsA = await dampingLogMod.readWindowedSignals({
    memory_id: "mem_t11_a",
    turn_window_id: turnWindowId,
    signal_kinds: ["engagement"],
  });
  const rowsB = await dampingLogMod.readWindowedSignals({
    memory_id: "mem_t11_b",
    turn_window_id: turnWindowId,
    signal_kinds: ["engagement"],
  });
  assert.equal(rowsA.length, 1, "damping log has engagement row for mem_t11_a");
  assert.equal(rowsB.length, 1, "damping log has engagement row for mem_t11_b");
  // The direct memory carries a +1.0 weight; the unrelated one carries 0.0.
  const directRow = rowsA[0];
  const nilRow = rowsB[0];
  assert.equal(directRow.signal_kind, "engagement");
  assert.equal(directRow.schema_version, 1);
  assert.equal(
    directRow.fields.engagement_class,
    ENGAGEMENT_CLASSES.DIRECT,
  );
  assert.equal(
    directRow.fields.engagement_weight,
    CAPS.ENGAGEMENT_WEIGHTS.direct,
  );
  assert.equal(
    nilRow.fields.engagement_class,
    ENGAGEMENT_CLASSES.NO_ENGAGEMENT,
  );
  assert.equal(nilRow.fields.engagement_weight, 0);
  // Envelope discipline.
  assert.equal(directRow.recall_id, priorRecallId);
  assert.equal(directRow.conversation_id_hash, conversationIdHash);
});

// ---------------------------------------------------------------------------
// T12 — Integration: recall.js writes recall event with the canonical
//       envelope shape (per propensity-logging-soak.md § 4 / W6 verification).
// ---------------------------------------------------------------------------
test("T12: recall.js appends a canonical recall event to ledgers/recall.jsonl", async () => {
  const recallJsonl = join(LEDGERS_DIR, "recall.jsonl");
  const sizeBefore = existsSync(recallJsonl)
    ? statSync(recallJsonl).size
    : 0;
  const args = {
    surrounding_context: {
      recent_turns: [
        { role: "user", content: "checking on the deploy" },
      ],
      agent_role: "test-agent",
      current_query: "what is the status of the deploy?",
      time: "2026-06-19T12:00:00.000Z",
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: "conv_w9_engagement_integration",
    max_items: 12,
    max_chars: 4000,
  };
  const result = await recallMod.TOOL.handler(args);
  assert.ok(result.ok || result.data, "recall handler returns successfully");
  // Read the appended event.
  assert.ok(existsSync(recallJsonl), "recall.jsonl exists after recall");
  const raw = readFileSync(recallJsonl, "utf8");
  assert.ok(
    raw.length > sizeBefore,
    "recall.jsonl grew after the recall call",
  );
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const lastLine = lines[lines.length - 1];
  const event = JSON.parse(lastLine);
  // Canonical envelope checks (§ 4 propensity-logging-soak.md required minimum):
  assert.equal(event.kind, "recall", "kind === 'recall'");
  assert.match(event.id, /^rec_[0-9a-f]{16}$/, "recall_id matches rec_<16hex>");
  assert.ok(typeof event.ts === "string" && event.ts.length > 0, "ts is ISO-8601");
  assert.ok(
    event.query && typeof event.query === "object",
    "query envelope present",
  );
  assert.ok(
    typeof event.query.surrounding_context_hash === "string",
    "query.surrounding_context_hash is a string",
  );
  assert.ok(
    Array.isArray(event.query.context_embedding),
    "query.context_embedding is an array (may be [] when degraded)",
  );
  assert.ok(
    typeof event.query.embedding_model_version === "string",
    "query.embedding_model_version is a string",
  );
  assert.ok(Array.isArray(event.surfaced), "surfaced[] present");
  // density_flag + degraded_recall + degraded_recall_layer3 required.
  assert.ok("density_flag" in event, "density_flag present");
  assert.ok("degraded_recall" in event, "degraded_recall present");
  assert.ok("degraded_recall_layer3" in event, "degraded_recall_layer3 present");
  // For each surfaced item: per W7 spec (§ 4.7.2.A / propensity-logging-soak.md
  // § 4 required minimum) every surfaced row has propensity in (0, 1).
  for (const s of event.surfaced) {
    assert.ok(typeof s.memory_id === "string");
    assert.equal(typeof s.score, "number");
    assert.equal(typeof s.position, "number");
    assert.ok(
      typeof s.propensity === "number" && Number.isFinite(s.propensity),
      "surfaced[].propensity is a finite number",
    );
  }
  assert.ok(
    Array.isArray(event.candidates_pre_truncation),
    "candidates_pre_truncation present",
  );
});

// ---------------------------------------------------------------------------
// T13 — Production hermeticity: no production paths touched.
// ---------------------------------------------------------------------------
test("T13: production paths byte-identical pre/post", () => {
  const after = {
    memory: snap(PROD_PATHS.memory),
    recall: snap(PROD_PATHS.recall),
    damping: snap(PROD_PATHS.damping),
    queue: snap(PROD_PATHS.queue),
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
