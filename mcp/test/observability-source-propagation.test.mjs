// observability-source-propagation.test.mjs — regression tests for
// F-NEW-W7-EMBED-COST-SOURCE-LABEL + F-NEW-W7-STAGE0-COUNTERS-FIELDS.
//
// W7 audit found two observability cornerstones producing no observability:
//   1. ALL 301 embed-cost calls labeled source="unknown_source" — the
//      cascade promote path (watermark -> wrappedEmbedder -> ctx.embedder)
//      never threaded `source` through to gemini-client.embedSingle /
//      embedBatch.
//   2. AUDIT claim: stage0_counter rows carried decision=null reason=null
//      source=null. The actual sink files showed populated fields, but the
//      reviewer asked for an explicit regression test pinning the contract.
//
// Both gaps are fixed by the W7 work unit; this test pins the contracts
// so a future cascade-path refactor cannot silently re-drop the source
// label.
//
// HERMETIC: MEMORY_ROOT is scoped to a per-run tempdir before the
// telemetry / embed-cost modules load so STORAGE_DIR resolves into the
// temp dir and JSONL flushes do not contaminate the operator's real
// storage. Each test resetForTests() so in-process state never leaks.
//
// Runnable as `node test/observability-source-propagation.test.mjs`,
// matching the convention used by every neighbouring test file.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Per-run hermetic root. MUST be set before importing the telemetry +
// embed-cost modules so STORAGE_DIR resolves into the tempdir.
const HERMETIC_ROOT = mkdtempSync(join(tmpdir(), "obs-source-prop-test-"));
process.env.MEMORY_ROOT = HERMETIC_ROOT;
process.env.STORAGE_BASE_DIR = join(HERMETIC_ROOT, "storage");

const embedCost = await import("../lib/observability/embed-cost.js");
const stage0Telemetry = await import("../lib/ingest/stage0/telemetry.js");
const stage0Index = await import("../lib/ingest/stage0/index.js");

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  ok ${msg}`);
}

process.on("exit", () => {
  try {
    rmSync(HERMETIC_ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// F-NEW-W7-EMBED-COST-SOURCE-LABEL
// ---------------------------------------------------------------------------
// recordEmbedCall MUST attribute the call to the supplied source label,
// not the "unknown_source" fallback. The fallback exists to keep the
// counter consistent when a caller forgets — but a well-formed caller
// must produce a non-fallback row.
console.log("# embed-cost — recordEmbedCall propagates source");
{
  embedCost.resetForTests();
  embedCost.recordEmbedCall({
    model: "gemini-embedding-001",
    input_tokens: 100,
    output_tokens: 0,
    source: "imessage",
  });
  embedCost.recordEmbedCall({
    model: "gemini-embedding-001",
    input_tokens: 50,
    output_tokens: 0,
    source: "git-log",
  });
  const snap = embedCost.snapshotCounters();
  const iMsg = snap.find(
    (r) => r.source === "imessage" && r.model === "gemini-embedding-001",
  );
  const gitLog = snap.find(
    (r) => r.source === "git-log" && r.model === "gemini-embedding-001",
  );
  const unknown = snap.find((r) => r.source === "unknown_source");
  assert.ok(iMsg, "expected an imessage row in the snapshot");
  assert.strictEqual(iMsg.call_count, 1);
  assert.strictEqual(iMsg.input_tokens, 100);
  assert.ok(gitLog, "expected a git-log row in the snapshot");
  assert.strictEqual(gitLog.call_count, 1);
  assert.strictEqual(unknown, undefined, "no unknown_source row should exist");
  ok("recordEmbedCall keys the snapshot by the supplied source label");
}

// When a caller forgets source, the fallback "unknown_source" still keeps
// the counter alive — production callers must thread source for real
// attribution, but the fallback prevents silent drops of billable calls.
console.log("# embed-cost — missing source falls back to unknown_source");
{
  embedCost.resetForTests();
  embedCost.recordEmbedCall({
    model: "gemini-embedding-001",
    input_tokens: 25,
    output_tokens: 0,
    // source intentionally omitted
  });
  const snap = embedCost.snapshotCounters();
  const unknown = snap.find((r) => r.source === "unknown_source");
  assert.ok(unknown, "missing-source falls back to unknown_source bucket");
  assert.strictEqual(unknown.call_count, 1);
  assert.strictEqual(unknown.input_tokens, 25);
  ok("missing source -> unknown_source fallback, never dropped");
}

// ---------------------------------------------------------------------------
// F-NEW-W7-STAGE0-COUNTERS-FIELDS
// ---------------------------------------------------------------------------
// stage0Dispatch MUST pass source, decision, and reason into recordDrop
// so the JSONL sink rows carry populated fields. Simulate the
// screentime '/discoverability/signals' path called out by the audit
// finding: source='screentime', decision='DROP', reason='discoverability_signals'.
console.log("# stage0 dispatch — populates source/decision/reason in counter");
{
  stage0Telemetry.resetForTests();
  const event = {
    source: "screentime",
    raw_content: { stream: "/discoverability/signals" },
  };
  const out = stage0Index.stage0Dispatch(event);
  assert.strictEqual(out.decision, "DROP");
  assert.strictEqual(out.reason, "discoverability_signals");
  assert.strictEqual(out.source, "screentime");

  const snap = stage0Telemetry.snapshotCounters();
  const row = snap.find(
    (r) =>
      r.source === "screentime" &&
      r.decision === "DROP" &&
      r.reason === "discoverability_signals",
  );
  assert.ok(
    row,
    `expected screentime::DROP::discoverability_signals counter row, got: ${JSON.stringify(snap)}`,
  );
  assert.strictEqual(row.count, 1);
  // CRITIC INVARIANT: every populated counter row must have all three
  // fields non-null. Even the PASS / unknown-source synthetic buckets
  // canonicalise via the telemetry layer's safeSource / canonicalReason
  // / safeDecision guards, so the JSONL sink never holds a (null, null,
  // null) row.
  for (const r of snap) {
    assert.ok(
      typeof r.source === "string" && r.source.length > 0,
      `counter row has empty source: ${JSON.stringify(r)}`,
    );
    assert.ok(
      typeof r.decision === "string" && r.decision.length > 0,
      `counter row has empty decision: ${JSON.stringify(r)}`,
    );
    assert.ok(
      typeof r.reason === "string" && r.reason.length > 0,
      `counter row has empty reason: ${JSON.stringify(r)}`,
    );
  }
  ok("stage0Dispatch screentime->DROP populates all three counter fields");
}

// PASS-decision row also fully populated (denominator for drop-rate).
console.log("# stage0 dispatch — PASS path also populates all three fields");
{
  stage0Telemetry.resetForTests();
  // A long imessage with no a2p / otp pattern lands as PASS.
  const event = {
    source: "imessage",
    raw_content: {
      text: "yeah for the meeting tuesday i was thinking 2-4",
      handle_id: "+15551234567",
    },
  };
  const out = stage0Index.stage0Dispatch(event);
  assert.strictEqual(out.decision, "PASS");
  assert.strictEqual(out.source, "imessage");
  const snap = stage0Telemetry.snapshotCounters();
  // Telemetry canonicalises a null reason on PASS into "pass" so the
  // denominator bucket is observable. The source MUST still be
  // "imessage" (not "unknown_source"), and decision MUST be "PASS"
  // (not the safeDecision fallback).
  const row = snap.find(
    (r) => r.source === "imessage" && r.decision === "PASS",
  );
  assert.ok(row, "expected imessage::PASS row in the snapshot");
  assert.strictEqual(typeof row.reason, "string");
  assert.ok(row.reason.length > 0, "PASS row reason canonicalised, not null");
  ok("stage0Dispatch imessage->PASS populates source/decision and canonicalises reason");
}

// 2/3-arg dispatch alias (the production watermark + salience call shape)
// also produces a fully-populated counter row.
console.log("# stage0 dispatch — alias dispatch(source, event) populates counter");
{
  stage0Telemetry.resetForTests();
  // dispatch(source, event) is the production call shape from
  // daemons/watermark.js:957 and mcp/lib/ingest/salience.js:442.
  const out = stage0Index.dispatch("screentime", {
    raw_content: { stream: "/discoverability/signals" },
  });
  assert.strictEqual(out.decision, "DROP");
  assert.strictEqual(out.source, "screentime");
  const snap = stage0Telemetry.snapshotCounters();
  const row = snap.find(
    (r) =>
      r.source === "screentime" &&
      r.decision === "DROP" &&
      r.reason === "discoverability_signals",
  );
  assert.ok(
    row,
    `alias dispatch must populate counter; got: ${JSON.stringify(snap)}`,
  );
  ok("dispatch(source, event) alias populates source/decision/reason");
}

console.log(`\nPASS ${passed} assertions`);
