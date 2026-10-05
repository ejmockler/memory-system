// recall-log-write-engagement.test.mjs — Wave 10 KEYSTONE coverage for
// F-SYN-BEHAVIOR-recall-log-write-engagement (first behavior-tier ship).
//
// COVERAGE:
//   - recall.js handler emits one signal_kind="surfacing" row per surfaced
//     memory via damping-log.appendSurfacing.
//   - Each row carries the canonical envelope shape (memory_id,
//     turn_window_id, recall_id, conversation_id_hash, fields).
//   - policy/recall-context.json sidecar is written atomically with mode
//     0600 and the canonical shape the hook expects.
//   - A simulated damping-log surfacing failure does NOT tip the recall
//     response (defensive contract).
//
// Hermetic discipline (matches recall-integration.test.mjs):
//   - tmp root + env vars set BEFORE any dynamic import
//   - GEMINI_API_KEY force-unset -> handler takes the degraded_recall branch
//     (we are not testing rerank quality here)
//   - the default (production) root stays byte-identical
//
// Run: node test/synthesis/recall-log-write-engagement.test.mjs

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
skipIfDaemonActive("recall-log-write-engagement");

// ---------------------------------------------------------------------------
// 0. Hermetic root + env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-w10-recall-surf-"));
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
// Production-path snapshot guard.
const PROD_PATHS = {
  memory: join(CHECKOUT_ROOT, "ledgers", "memory.jsonl"),
  recall: join(CHECKOUT_ROOT, "ledgers", "recall.jsonl"),
  damping: join(CHECKOUT_ROOT, "policy", "damping-log.jsonl"),
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
  ctx: snap(PROD_PATHS.ctx),
};

// ---------------------------------------------------------------------------
// 1. Dynamic imports AFTER env is set.
// ---------------------------------------------------------------------------
const recallMod = await import("../../lib/tools/recall.js");
const dampingLogMod = await import("../../lib/synthesis/damping-log.js");
const { CAPS } = await import("../../lib/validation.js");

const RECALL_CONTEXT_PATH = join(POLICY_DIR, "recall-context.json");

function buildArgs({ conversationId = "conv_w10_test", recentTurns = [] } = {}) {
  return {
    surrounding_context: {
      recent_turns: recentTurns.map((c) =>
        typeof c === "string" ? { role: "user", content: c } : c,
      ),
      agent_role: "test-agent",
      current_query: "what's the status of the deploy?",
      time: "2026-06-19T12:00:00.000Z",
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: conversationId,
    max_items: 12,
    max_chars: 4000,
  };
}

// ---------------------------------------------------------------------------
// T1 — recall.js writes the recall-context.json sidecar atomically + mode 0600.
// ---------------------------------------------------------------------------
test("T1: recall handler writes policy/recall-context.json sidecar with mode 0600", async () => {
  // Reset damping log + sidecar between tests.
  try { dampingLogMod._resetForTest(); } catch { /* ignore */ }
  try { rmSync(RECALL_CONTEXT_PATH, { force: true }); } catch { /* ignore */ }

  const args = buildArgs({
    conversationId: "conv_w10_sidecar",
    recentTurns: [
      { role: "user", content: "checking on the deploy" },
    ],
  });
  const result = await recallMod.TOOL.handler(args);
  assert.ok(result && (result.ok || result.data), "recall handler returns successfully");

  assert.ok(existsSync(RECALL_CONTEXT_PATH), "recall-context.json sidecar exists after recall");
  const st = statSync(RECALL_CONTEXT_PATH);
  // Mode check: mask to permission bits. 0o600 = owner read+write only.
  const mode = st.mode & 0o777;
  assert.equal(mode, 0o600, `sidecar mode must be 0600; got ${mode.toString(8)}`);

  const parsed = JSON.parse(readFileSync(RECALL_CONTEXT_PATH, "utf8"));
  assert.ok(parsed && typeof parsed === "object", "sidecar is a JSON object");
  assert.ok(
    typeof parsed.prior_recall_id === "string" && /^rec_[0-9a-f]{16}$/.test(parsed.prior_recall_id),
    "prior_recall_id is rec_<16hex>",
  );
  assert.ok(typeof parsed.ts === "string" && parsed.ts.length > 0, "ts is non-empty");
  assert.ok(
    parsed.prior_recall_brief && typeof parsed.prior_recall_brief === "object",
    "prior_recall_brief envelope present",
  );
  assert.equal(
    parsed.prior_recall_brief.recall_id,
    parsed.prior_recall_id,
    "recall_id matches the top-level prior_recall_id",
  );
  assert.ok(
    Array.isArray(parsed.prior_recall_brief.surfaced),
    "prior_recall_brief.surfaced is an array (may be empty)",
  );
  // Each surfaced item carries memory_id + content (the hook tokenizes content).
  for (const s of parsed.prior_recall_brief.surfaced) {
    assert.ok(typeof s.memory_id === "string", "surfaced[].memory_id is a string");
    assert.equal(typeof s.content, "string", "surfaced[].content is a string");
  }
});

// ---------------------------------------------------------------------------
// T2 — recall.js writes one signal_kind=surfacing row per surfaced memory.
// ---------------------------------------------------------------------------
test("T2: recall handler appends one surfacing row per surfaced memory", async () => {
  // Reset damping log + ledger so we observe a clean recall row set.
  try { dampingLogMod._resetForTest(); } catch { /* ignore */ }
  try { rmSync(RECALL_CONTEXT_PATH, { force: true }); } catch { /* ignore */ }

  const args = buildArgs({
    conversationId: "conv_w10_surfacing",
    recentTurns: [
      { role: "user", content: "what does my partner do?" },
    ],
  });
  const result = await recallMod.TOOL.handler(args);
  assert.ok(result && (result.ok || result.data), "recall handler returns successfully");

  // Surfaced count from the response.
  const surfacedCount = Array.isArray(result.data && result.data.memories)
    ? result.data.memories.length
    : 0;

  // Read damping log directly — we don't depend on memories being non-empty
  // (the degraded-recall path may return [] surfaced if there are no candidates),
  // but we DO assert that the number of surfacing rows equals the number of
  // surfaced memories.
  const rows = await dampingLogMod.readWindowedSignals({
    signal_kinds: ["surfacing"],
  });
  assert.equal(
    rows.length,
    surfacedCount,
    `damping log has one surfacing row per surfaced memory (expected ${surfacedCount}, got ${rows.length})`,
  );

  // If we have surfaced rows, validate envelope shape.
  if (rows.length > 0) {
    const row = rows[0];
    assert.equal(row.schema_version, 1, "envelope schema_version=1");
    assert.equal(row.signal_kind, "surfacing", "signal_kind=surfacing");
    assert.ok(typeof row.memory_id === "string" && row.memory_id.length > 0);
    assert.ok(typeof row.turn_window_id === "string" && row.turn_window_id.length > 0);
    assert.match(row.recall_id || "", /^rec_[0-9a-f]{16}$/, "recall_id is rec_<16hex>");
    assert.ok(
      typeof row.conversation_id_hash === "string" && row.conversation_id_hash.length > 0,
      "conversation_id_hash is non-empty",
    );
    assert.ok(typeof row.ts === "string" && row.ts.length > 0, "row ts populated");
    assert.ok(
      row.fields && typeof row.fields === "object" && !Array.isArray(row.fields),
      "fields is a plain object",
    );
    assert.equal(typeof row.fields.position, "number");
    assert.equal(typeof row.fields.score, "number");
    assert.equal(typeof row.fields.propensity, "number");
    assert.equal(
      typeof row.fields.surfaced_strength,
      "number",
      "surfaced_strength populated by damping-log",
    );
  }
});

// ---------------------------------------------------------------------------
// T3 — turn_window_id derived correctly + conversation_id_hash matches the
// canonical helper.
// ---------------------------------------------------------------------------
test("T3: surfacing rows use canonical turn_window_id + conversation_id_hash", async () => {
  try { dampingLogMod._resetForTest(); } catch { /* ignore */ }
  try { rmSync(RECALL_CONTEXT_PATH, { force: true }); } catch { /* ignore */ }

  const conversationId = "conv_w10_canonical_ids";
  const args = buildArgs({
    conversationId,
    recentTurns: [
      { role: "user", content: "alpha bravo charlie" },
      { role: "user", content: "delta echo foxtrot" },
    ],
  });
  const result = await recallMod.TOOL.handler(args);
  assert.ok(result && (result.ok || result.data), "recall handler returns successfully");

  const rows = await dampingLogMod.readWindowedSignals({
    signal_kinds: ["surfacing"],
  });

  // Recompute expected turn_window_id + conversation_id_hash using the
  // canonical helpers. recent_turns.length=2 → base_turn_index = floor(2/3) = 0.
  const windowSize = CAPS.RECALL_K_TURN_WINDOW;
  const baseTurnIndex = Math.floor(2 / windowSize);
  const expectedTurnWindowId = dampingLogMod.computeTurnWindowId({
    conversation_id: conversationId,
    base_turn_index: baseTurnIndex,
    window_size: windowSize,
  });
  const expectedHash = dampingLogMod.computeConversationIdHash(conversationId);

  for (const row of rows) {
    assert.equal(
      row.turn_window_id,
      expectedTurnWindowId,
      "turn_window_id matches canonical encoding (§ 4.5)",
    );
    assert.equal(
      row.conversation_id_hash,
      expectedHash,
      "conversation_id_hash matches canonical helper (§ 4.6)",
    );
  }
});

// ---------------------------------------------------------------------------
// T4 — Surfacing write failure does NOT tip the recall response (defensive
// contract).
// ---------------------------------------------------------------------------
test("T4: recall returns brief even when damping-log surfacing throws", async () => {
  try { dampingLogMod._resetForTest(); } catch { /* ignore */ }
  try { rmSync(RECALL_CONTEXT_PATH, { force: true }); } catch { /* ignore */ }

  // Monkey-patch the damping log path to a directory (so write FAILS).
  // We achieve this by pointing POLICY_BASE_DIR at a path that does NOT
  // exist — damping-log opens the storage with O_CREAT, so this should
  // still create. Instead we simulate by making damping-log's lock path
  // unwritable. The simplest defensive simulation: corrupt the existing
  // damping log file into a directory so openSync fails. We then assert
  // the handler still returns ok.
  const dampingPath = join(POLICY_DIR, "damping-log.jsonl");
  try { rmSync(dampingPath, { force: true }); } catch { /* ignore */ }
  // Replace with a directory — the substrate's openSync for write should fail
  // (EISDIR) and the recall.js try/catch swallows it.
  mkdirSync(dampingPath, { recursive: true });

  const args = buildArgs({
    conversationId: "conv_w10_resilience",
    recentTurns: [{ role: "user", content: "test resilience path" }],
  });
  // Should NOT throw despite the corrupted damping log path.
  const result = await recallMod.TOOL.handler(args);
  assert.ok(
    result && (result.ok || result.data),
    "recall handler returns successfully despite damping-log write failure",
  );
  // Sidecar should STILL be written (separate try/catch).
  assert.ok(existsSync(RECALL_CONTEXT_PATH), "sidecar written despite damping-log failure");

  // Cleanup: remove the directory so subsequent tests can write the file.
  try { rmSync(dampingPath, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// T5 — Sidecar is atomically replaced across two consecutive recalls (last
// writer wins; no torn read).
// ---------------------------------------------------------------------------
test("T5: consecutive recalls atomically replace the sidecar", async () => {
  try { dampingLogMod._resetForTest(); } catch { /* ignore */ }
  try { rmSync(RECALL_CONTEXT_PATH, { force: true }); } catch { /* ignore */ }

  const args1 = buildArgs({
    conversationId: "conv_w10_replace_1",
    recentTurns: [{ role: "user", content: "first turn" }],
  });
  const r1 = await recallMod.TOOL.handler(args1);
  assert.ok(r1 && (r1.ok || r1.data));
  const first = JSON.parse(readFileSync(RECALL_CONTEXT_PATH, "utf8"));

  const args2 = buildArgs({
    conversationId: "conv_w10_replace_2",
    recentTurns: [{ role: "user", content: "second turn" }],
  });
  const r2 = await recallMod.TOOL.handler(args2);
  assert.ok(r2 && (r2.ok || r2.data));
  const second = JSON.parse(readFileSync(RECALL_CONTEXT_PATH, "utf8"));

  assert.notEqual(
    first.prior_recall_id,
    second.prior_recall_id,
    "sidecar reflects the latest recall id (no stale read)",
  );
});

// ---------------------------------------------------------------------------
// T6 — Sidecar shape is exactly what the hook parser expects.
// ---------------------------------------------------------------------------
test("T6: sidecar shape matches hooks/recall-engagement-detect.sh parser contract", async () => {
  try { dampingLogMod._resetForTest(); } catch { /* ignore */ }
  try { rmSync(RECALL_CONTEXT_PATH, { force: true }); } catch { /* ignore */ }

  const args = buildArgs({
    conversationId: "conv_w10_shape",
    recentTurns: [{ role: "user", content: "shape contract check" }],
  });
  const r = await recallMod.TOOL.handler(args);
  assert.ok(r && (r.ok || r.data));

  const parsed = JSON.parse(readFileSync(RECALL_CONTEXT_PATH, "utf8"));
  // Hook reads exactly these fields:
  //   ctx.prior_recall_id           — top-level string
  //   ctx.prior_recall_brief        — object
  //   ctx.prior_recall_brief.recall_id   (consumer of detector)
  //   ctx.prior_recall_brief.surfaced[]  (memory_id + content per item)
  const keys = new Set(Object.keys(parsed));
  assert.ok(keys.has("prior_recall_id"), "top-level prior_recall_id key present");
  assert.ok(keys.has("prior_recall_brief"), "top-level prior_recall_brief key present");
  assert.ok(keys.has("ts"), "top-level ts key present");
  assert.equal(typeof parsed.prior_recall_id, "string");
  assert.ok(parsed.prior_recall_brief);
  assert.equal(typeof parsed.prior_recall_brief.recall_id, "string");
  assert.ok(Array.isArray(parsed.prior_recall_brief.surfaced));
});

// ---------------------------------------------------------------------------
// T7 — Production hermeticity: no production paths touched.
// ---------------------------------------------------------------------------
test("T7: production paths byte-identical pre/post", () => {
  const after = {
    memory: snap(PROD_PATHS.memory),
    recall: snap(PROD_PATHS.recall),
    damping: snap(PROD_PATHS.damping),
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
