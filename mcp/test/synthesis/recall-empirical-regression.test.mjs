// recall-empirical-regression.test.mjs — WU-RR3 closure.
//
// PURPOSE
//
// Asserts EMPIRICALLY that memory_recall returns at least one memory whose
// content matches a known ledger-specific token, for four query
// shapes that the RR1 (BM25 full-rebuild) + RR2 (substrate-aware Layer-1c
// fallback) work units were designed to repair. Pre-RR1+RR2 these queries
// returned candidate_set_size=0 on the live ledger because:
//   - HNSW was mostly empty (99.9% of facts have features.embedding=null
//     because the Gemini-quota outage froze the embedding-backfill daemon).
//   - The BM25 inverted index had drifted from the canonical ledger through
//     months of incremental-promote churn — full rebuilds had been skipped.
//
// This test is the EMPIRICAL signal that those fixes actually move the
// needle on operator-shaped queries against the live substrate. The four
// queries below are placeholders: point them at tokens your own ledger holds.
//
// DESIGN
//
//   - Run against the LIVE ledger when the daemon is quiescent.
//     skipIfDaemonActive() exits cleanly when the watermark daemon has
//     touched its state files within the last 30s — preserves npm-test
//     hermeticity (the live-ledger path is read-only; the daemon's
//     concurrent writes can still race the bm25/hnsw index-cache load).
//
//   - GEMINI_API_KEY is force-unset before any dynamic import. This puts
//     recall on the degraded_recall branch (BM25-only candidate gen), which
//     is the path operators actually hit while the Gemini quota is exhausted.
//     The empirical assertion that BM25 + substrate-fallback alone return
//     hits is the load-bearing signal of the RR1+RR2 wins.
//
//   - Each per-query test is graceful: if the live ledger does not contain
//     content matching the ledger-specific token (hermetic CI machine, or
//     ledger that has never ingested the relevant connector), the test
//     SKIPS rather than fails. The pre-flight ledger scan classifies each
//     query before the recall call so the skip reason is precise.
//
//   - The four queries are pinned in QUERY_FIXTURES below; each carries a
//     content-token matcher (regex) that the surfaced memory MUST satisfy.
//
//   - To bypass the daemon-skip during the manual empirical verification
//     pass (the WU-RR3 "report which queries pass/fail" step), the operator
//     can set MEMSYS_FORCE_EMPIRICAL_RECALL=1 in the environment. The npm-
//     test path never sets this; CI stays hermetic.
//
// DISCIPLINE
//
//   - ESM, defensive try/catch on every external surface.
//   - node:test + node:assert/strict.
//   - 12+ assertions per spec.
//   - No production ledger writes — the recall handler appends to
//     recall.jsonl + the damping-log, but those are append-only audit
//     surfaces (the same surfaces every operator turn touches). We do not
//     assert byte-identity on either; doing so would require quiescing the
//     daemon, which the skip guard already enforces upstream.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// 0. Daemon-skip guard + empirical-opt-in.
//
// npm-test discipline: this test asserts against the LIVE ledger (no
// MEMORY_ROOT override). The watermark daemon writes the same ledger
// concurrently, which would (a) race the bm25/hnsw index-cache reads and
// (b) make any byte-identity assertion non-hermetic. To keep npm test
// >=113/114 we DEFAULT-SKIP unless the operator opts in with
// MEMSYS_FORCE_EMPIRICAL_RECALL=1.
//
// Two layers of defence:
//   (1) skipIfDaemonActive() — exits cleanly when the daemon has touched a
//       state file within the last 30s. Mirrors the r25-end-to-end pattern.
//   (2) MEMSYS_FORCE_EMPIRICAL_RECALL!=1 fallback skip — the empirical pass
//       is operator-driven, not CI-driven. The bypass is intentionally NOT
//       plumbed through skipIfDaemonActive itself so npm-test never picks
//       it up by accident, even if daemon state files happen to be stale
//       (a long-idle daemon still holds locks and produces non-determinism).
// ---------------------------------------------------------------------------
if (process.env.MEMSYS_FORCE_EMPIRICAL_RECALL !== "1") {
  const { skipIfDaemonActive } = await import("../_hermetic-daemon-skip.mjs");
  skipIfDaemonActive("recall-empirical-regression");
  // If skipIfDaemonActive returned (state files all > 30s stale or missing),
  // we still default-skip the empirical assertion under npm test. The
  // explicit opt-in env is the operator-driven empirical pass.
  console.log(
    "  SKIP: recall-empirical-regression requires MEMSYS_FORCE_EMPIRICAL_RECALL=1",
  );
  console.log(
    "        (operator-driven empirical verification — not part of CI suite)",
  );
  console.log("0 passed, 0 failed (skipped — empirical-opt-in)");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Env discipline BEFORE any dynamic import.
//
// Force degraded_recall by unsetting Gemini keys. The empirical signal lives
// on the BM25 + substrate-fallback path; that is the path operators hit
// while the Gemini quota is exhausted. We do NOT override MEMORY_ROOT — the
// test asserts against the LIVE ledger by design.
// ---------------------------------------------------------------------------
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;

// ---------------------------------------------------------------------------
// 2. Dynamic imports AFTER env is set.
// ---------------------------------------------------------------------------
const recallMod = await import("../../lib/tools/recall.js");
const configMod = await import("../../lib/config.js");

const LEDGER_PATH = configMod.memoryLedgerPath();
const LIVE_LEDGER_AVAILABLE = (() => {
  try {
    const st = statSync(LEDGER_PATH);
    // < 1 MB ledger is effectively empty for the ledger-specific queries we
    // probe; CI-style hermetic environments will fall in this bucket and the
    // per-query skips will fire.
    return st.size > 1024 * 1024;
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// 3. Pre-flight scan: classify which ledger-specific tokens are actually
// present in the live ledger. Without this, a CI machine without the
// imessage / whatsapp / git-log connectors wired would FAIL spuriously.
//
// We stream the ledger line-by-line (the production ledger is ~1.8GB —
// readFileSync would OOM the test process). Each fixture's `presenceRegex`
// is tested against the line; first match wins. We bail early once every
// fixture has been classified, so on a healthy ledger the scan is bounded
// to the prefix where all four tokens are present.
// ---------------------------------------------------------------------------
const QUERY_FIXTURES = [
  {
    label: "acmebot-setup",
    currentQuery: "Acmebot setup",
    // The presence regex MUST match the content_excerpt field downstream.
    // We test against the raw row line in the pre-flight; the runtime check
    // tests against the surfaced memory's content field.
    presenceRegex: /acmebot/i,
    contentMatch: /acmebot/i,
  },
  {
    label: "sam-sample-sample-tool",
    currentQuery: "sam-sample sample-tool",
    presenceRegex: /sam-sample|sample-?tool/i,
    contentMatch: /sam-sample|sample-?tool/i,
  },
  {
    label: "example-telecom-refund",
    currentQuery: "Example-Telecom refund",
    presenceRegex: /example-?telecom|refund|warranty|data plan/i,
    contentMatch: /example-?telecom|refund|warranty|data plan/i,
  },
  {
    label: "release-checklist-template",
    currentQuery: "release checklist template",
    presenceRegex: /release checklist|release.checklist.*template|template.*release/i,
    contentMatch: /release checklist|template/i,
  },
];

const PRESENT_LABELS = new Set();

async function preflightScanLedger() {
  if (!LIVE_LEDGER_AVAILABLE) return;
  // Bail conditions:
  //   - all fixtures matched, OR
  //   - MAX_PREFLIGHT_BYTES read (cap to keep test runtime bounded on
  //     pathological ledgers; the probed content lives near the
  //     historical mid-ledger so a 256MB cap is safe).
  const MAX_PREFLIGHT_BYTES = 256 * 1024 * 1024;
  let bytesRead = 0;
  const rl = createInterface({
    input: createReadStream(LEDGER_PATH, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      bytesRead += line.length + 1; // newline
      if (bytesRead > MAX_PREFLIGHT_BYTES) break;
      if (line === "") continue;
      for (const fx of QUERY_FIXTURES) {
        if (PRESENT_LABELS.has(fx.label)) continue;
        if (fx.presenceRegex.test(line)) {
          PRESENT_LABELS.add(fx.label);
        }
      }
      if (PRESENT_LABELS.size === QUERY_FIXTURES.length) break;
    }
  } catch (err) {
    // Defensive: a partial / corrupt ledger read should not tip the test.
    // PRESENT_LABELS stays at whatever we accumulated; missing fixtures
    // will skip with their own reason.
    void err;
  } finally {
    rl.close();
  }
}

await preflightScanLedger();

// ---------------------------------------------------------------------------
// 4. Recall invocation helper.
// ---------------------------------------------------------------------------
function buildArgs(currentQuery) {
  return {
    surrounding_context: {
      recent_turns: [{ role: "user", content: currentQuery }],
      agent_role: "rr3-empirical-regression",
      current_query: currentQuery,
      time: new Date().toISOString(),
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: "conv_rr3_empirical_regression_test",
    max_items: 12,
    max_chars: 4000,
  };
}

async function callRecall(currentQuery) {
  return recallMod.TOOL.handler(buildArgs(currentQuery));
}

// Reusable assertion helper: returns the surfaced memory matching the
// content regex, or null if none did. Captures `null memories[]` and
// `non-array memories[]` defensively.
function findMatchingMemory(result, contentMatch) {
  if (!result || result.ok !== true) return null;
  const data = result.data;
  if (!data || !Array.isArray(data.memories)) return null;
  for (const m of data.memories) {
    if (m == null) continue;
    const content = typeof m.content === "string" ? m.content : "";
    if (contentMatch.test(content)) return m;
  }
  return null;
}

// ---------------------------------------------------------------------------
// T0 — substrate availability sentinel.
//
// Asserts that LIVE_LEDGER_AVAILABLE is a boolean (always true on operator
// machines, may be false in CI). This is the SHAPE assertion that makes the
// downstream skips legible — a failing T0 means the pre-flight code itself
// is broken, independent of substrate state.
// ---------------------------------------------------------------------------
test("T0: live ledger probe returns a boolean availability flag", () => {
  assert.equal(typeof LIVE_LEDGER_AVAILABLE, "boolean");
  assert.equal(typeof LEDGER_PATH, "string");
  assert.ok(LEDGER_PATH.endsWith("memory.jsonl"), "ledger path resolves to memory.jsonl");
  // PRESENT_LABELS is always a Set, even when pre-flight skipped.
  assert.ok(PRESENT_LABELS instanceof Set, "PRESENT_LABELS is a Set");
});

// ---------------------------------------------------------------------------
// T1 — Acmebot setup. iMessage / whatsapp content.
// ---------------------------------------------------------------------------
test("T1: 'Acmebot setup' surfaces at least one acmebot-content memory", async (t) => {
  if (!LIVE_LEDGER_AVAILABLE) {
    t.skip("live ledger not present (<1MB) — empirical signal requires operator substrate");
    return;
  }
  if (!PRESENT_LABELS.has("acmebot-setup")) {
    t.skip("ledger-specific acmebot content not in pre-flight scan window");
    return;
  }
  const result = await callRecall("Acmebot setup");
  assert.equal(result.ok, true, "handler returned ok=true");
  assert.ok(result.data, "result.data present");
  assert.ok(Array.isArray(result.data.memories), "memories is array");
  assert.ok(
    result.data.memories.length >= 1,
    `memories.length >= 1 (got ${result.data.memories.length}, candidate_set_size=${result.data.candidate_set_size})`,
  );
  const fx = QUERY_FIXTURES.find((q) => q.label === "acmebot-setup");
  const hit = findMatchingMemory(result, fx.contentMatch);
  assert.ok(
    hit != null,
    `at least one surfaced memory content matches /acmebot/i; first content=${
      result.data.memories[0] ? JSON.stringify(result.data.memories[0].content) : "null"
    }`,
  );
  assert.equal(typeof hit.id, "string", "matching memory has string id");
  assert.ok(hit.id.length > 0, "matching memory id is non-empty");
});

// ---------------------------------------------------------------------------
// T2 — sam-sample / sample-tool. git-log committer / repo content.
// ---------------------------------------------------------------------------
test("T2: 'sam-sample sample-tool' surfaces sam-sample-or-sample-tool content", async (t) => {
  if (!LIVE_LEDGER_AVAILABLE) {
    t.skip("live ledger not present (<1MB) — empirical signal requires operator substrate");
    return;
  }
  if (!PRESENT_LABELS.has("sam-sample-sample-tool")) {
    t.skip("ledger-specific sam-sample/sample-tool content not in pre-flight scan window");
    return;
  }
  const result = await callRecall("sam-sample sample-tool");
  assert.equal(result.ok, true, "handler returned ok=true");
  assert.ok(Array.isArray(result.data.memories), "memories is array");
  assert.ok(
    result.data.memories.length >= 1,
    `memories.length >= 1 (got ${result.data.memories.length}, candidate_set_size=${result.data.candidate_set_size})`,
  );
  const fx = QUERY_FIXTURES.find((q) => q.label === "sam-sample-sample-tool");
  const hit = findMatchingMemory(result, fx.contentMatch);
  assert.ok(
    hit != null,
    `at least one surfaced memory content matches /sam-sample|sample-?tool/i; first content=${
      result.data.memories[0] ? JSON.stringify(result.data.memories[0].content) : "null"
    }`,
  );
  assert.equal(typeof hit.content, "string", "matching memory has string content");
});

// ---------------------------------------------------------------------------
// T3 — Example-Telecom refund. iMessage group-thread content
// (data plan / warranty / Example-Telecom refund conversation).
// ---------------------------------------------------------------------------
test("T3: 'Example-Telecom refund' surfaces Example-Telecom/warranty/data-plan thread content", async (t) => {
  if (!LIVE_LEDGER_AVAILABLE) {
    t.skip("live ledger not present (<1MB) — empirical signal requires operator substrate");
    return;
  }
  if (!PRESENT_LABELS.has("example-telecom-refund")) {
    t.skip("ledger-specific Example-Telecom content not in pre-flight scan window");
    return;
  }
  const result = await callRecall("Example-Telecom refund");
  assert.equal(result.ok, true, "handler returned ok=true");
  assert.ok(Array.isArray(result.data.memories), "memories is array");
  assert.ok(
    result.data.memories.length >= 1,
    `memories.length >= 1 (got ${result.data.memories.length}, candidate_set_size=${result.data.candidate_set_size})`,
  );
  const fx = QUERY_FIXTURES.find((q) => q.label === "example-telecom-refund");
  const hit = findMatchingMemory(result, fx.contentMatch);
  assert.ok(
    hit != null,
    `at least one surfaced memory matches /example-telecom|refund|warranty|data plan/i; first content=${
      result.data.memories[0] ? JSON.stringify(result.data.memories[0].content) : "null"
    }`,
  );
});

// ---------------------------------------------------------------------------
// T4 — release checklist template. whatsapp content
// ("the release checklist is just a template we copy each time...").
// ---------------------------------------------------------------------------
test("T4: 'release checklist template' surfaces release-checklist/template content", async (t) => {
  if (!LIVE_LEDGER_AVAILABLE) {
    t.skip("live ledger not present (<1MB) — empirical signal requires operator substrate");
    return;
  }
  if (!PRESENT_LABELS.has("release-checklist-template")) {
    t.skip("ledger-specific release-checklist content not in pre-flight scan window");
    return;
  }
  const result = await callRecall("release checklist template");
  assert.equal(result.ok, true, "handler returned ok=true");
  assert.ok(Array.isArray(result.data.memories), "memories is array");
  assert.ok(
    result.data.memories.length >= 1,
    `memories.length >= 1 (got ${result.data.memories.length}, candidate_set_size=${result.data.candidate_set_size})`,
  );
  const fx = QUERY_FIXTURES.find((q) => q.label === "release-checklist-template");
  const hit = findMatchingMemory(result, fx.contentMatch);
  assert.ok(
    hit != null,
    `at least one surfaced memory matches /release checklist|template/i; first content=${
      result.data.memories[0] ? JSON.stringify(result.data.memories[0].content) : "null"
    }`,
  );
});

// ---------------------------------------------------------------------------
// T5 — pipeline-shape sentinel.
//
// Independent of any per-query content. Asserts the handler still produces
// a well-shaped brief envelope on a benign query. Without this we'd report
// "all four queries skipped" without distinguishing a substrate-absent CI
// from a handler-broken regression.
// ---------------------------------------------------------------------------
test("T5: handler envelope is well-shaped on benign query", async () => {
  const result = await callRecall("hello");
  assert.equal(result.ok, true, "handler returned ok=true");
  assert.ok(result.data, "result.data present");
  assert.equal(typeof result.data.recall_id, "string");
  assert.ok(Array.isArray(result.data.memories), "memories is array");
  // degraded_recall MUST be true — we force-unset GEMINI_API_KEY above.
  assert.equal(
    result.data.degraded_recall,
    true,
    "degraded_recall=true under forced no-Gemini-keys env",
  );
  assert.equal(typeof result.data.candidate_set_size, "number");
  assert.ok(result.data.populator, "populator block present");
});

// Sanity note: when the daemon is active and MEMSYS_FORCE_EMPIRICAL_RECALL is
// not set, this file silently no-ops at import (skipIfDaemonActive calls
// process.exit(0)). That preserves npm-test hermeticity — the live-ledger
// path is read-only but the bm25/hnsw index-cache reads can race the
// daemon's concurrent index writes.
