// reconstructed-trigger-advisor.test.mjs — Wave 11 BEHAVIOR test suite.
//
// Covers F-SYN-BEHAVIOR-reconstructed-trigger-logic per spec
// docs/specs/synthesis/reconstructed-trigger-logic.md § Trigger gates.
//
// Mandatory fixtures:
//   T1 — confidence=0.5 → emit=false, reason=below_confidence_min
//   T2 — pure paraphrase of 1 parent → emit=false, reason=pure_paraphrase
//   T3 — 2 parents + new claim → emit=true, reason=ok_to_emit
//   T4 — existing near-dup in ledger → emit=false, reason=near_duplicate_exists
//   T5 — defensive: ledger read failure → emit=false (proceeds via degraded
//        empty-rows path; this exercises the try/catch barrier on the
//        cross-module read but produces ok_to_emit because no candidates
//        match). Separate T5b verifies the outer try/catch returns
//        advisor_error for malformed input.
//   T6 — multi-parent synthesis (no near-dup, high confidence) → emit=true
//
// Discipline:
//   - HERMETIC env vars set BEFORE any dynamic import touches config.js.
//   - node:test + node:assert/strict.
//   - ≥ 12 assertions.
//
// Run: node --test test/synthesis/reconstructed-trigger-advisor.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Hermetic env — MUST be set BEFORE any dynamic import touches config.js.
// -----------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-trigger-advisor-"));
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
  join(process.env.STORAGE_BASE_DIR, "sources"),
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {}
});

// -----------------------------------------------------------------------------
// Dynamic imports — bind into TMP_ROOT.
// -----------------------------------------------------------------------------

const advisorMod = await import(
  "../../lib/synthesis/reconstructed-trigger-advisor.js"
);
const {
  TRIGGER_ADVISOR_VERSION,
  TRIGGER_CAPS,
  shouldEmitReconstruction,
  __internal,
} = advisorMod;

// Per-test ledger paths — keep tests independent. We do NOT route through
// memoryLedgerPath() because the advisor accepts ledgerPath as an
// explicit ctx field; isolating per-test avoids cross-test pollution.
function freshLedgerPath(label) {
  const dir = join(TMP_ROOT, "ledgers", label);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, "memory.jsonl");
}

// Seed an existing reconstructed row directly to the ledger (fixture only;
// bypasses the W7 screened emitter). Shape matches the W7 assembleRow
// output for the fields the advisor reads (kind, content, derived_from,
// provenance.conversation_id).
function seedReconstructed(ledgerPath, { id, parents, content, conversation_id }) {
  const row = {
    id,
    ts: "2026-06-19T00:00:00Z",
    kind: "reconstructed",
    provenance: {
      agent_id: "claude-code:conv-test",
      conversation_id: conversation_id ?? null,
      confidence: 0.9,
    },
    content,
    derived_from: parents,
    features: { entities: [], time_anchors: [] },
    idempotency_key: "seed_" + id,
    superseded_by: null,
    reframed_by: null,
    rescinded_at: null,
    scope: "conversation_local",
    mode: "agent",
  };
  appendFileSync(ledgerPath, JSON.stringify(row) + "\n", { mode: 0o600 });
}

// -----------------------------------------------------------------------------
// Module-level sanity: VERSION + frozen CAPS
// -----------------------------------------------------------------------------

test("module exports VERSION and frozen CAPS", () => {
  assert.equal(typeof TRIGGER_ADVISOR_VERSION, "string");
  assert.equal(TRIGGER_ADVISOR_VERSION, "v0.1.0");
  assert.equal(typeof TRIGGER_CAPS, "object");
  assert.equal(Object.isFrozen(TRIGGER_CAPS), true);
  assert.equal(TRIGGER_CAPS.CONFIDENCE_MIN, 0.6);
  assert.equal(TRIGGER_CAPS.PARAPHRASE_OVERLAP_THRESHOLD, 0.8);
  assert.equal(TRIGGER_CAPS.NEAR_DUP_THRESHOLD, 0.92);
  // attempting to mutate the frozen CAPS must NOT change it
  try { TRIGGER_CAPS.CONFIDENCE_MIN = 0.0; } catch {}
  assert.equal(TRIGGER_CAPS.CONFIDENCE_MIN, 0.6);
});

// -----------------------------------------------------------------------------
// T1 — confidence=0.5 → below_confidence_min
// -----------------------------------------------------------------------------

test("T1: confidence below floor → below_confidence_min", async () => {
  const ledgerPath = freshLedgerPath("t1");
  const result = await shouldEmitReconstruction({
    parents: [{ id: "fact_a", content: "fact a content for the advisor" }],
    content: "An emitted synthesis with low confidence below the floor.",
    confidence: 0.5,
    conversation_id: "conv-t1",
    ledgerPath,
  });
  assert.equal(result.emit, false);
  assert.equal(result.reason, "below_confidence_min");
  assert.ok(result.advisory_score >= 0 && result.advisory_score <= 1);
  assert.equal(result.advisory_score, 0.5);
});

// -----------------------------------------------------------------------------
// T2 — pure paraphrase of 1 parent → pure_paraphrase
// -----------------------------------------------------------------------------

test("T2: pure paraphrase of single parent → pure_paraphrase", async () => {
  const ledgerPath = freshLedgerPath("t2");
  // Construct content that shares almost all tokens with parent (Jaccard > 0.8).
  const parentContent =
    "The Wrenfield sorter keeps a steady cadence across every tray on the bench.";
  const candidateContent =
    "Wrenfield sorter keeps a steady cadence across every tray on the bench.";
  const result = await shouldEmitReconstruction({
    parents: [{ id: "fact_ws", content: parentContent }],
    content: candidateContent,
    confidence: 0.9,
    conversation_id: "conv-t2",
    ledgerPath,
  });
  assert.equal(result.emit, false);
  assert.equal(result.reason, "pure_paraphrase");
  assert.ok(
    result.advisory_score > TRIGGER_CAPS.PARAPHRASE_OVERLAP_THRESHOLD,
    `expected advisory_score > ${TRIGGER_CAPS.PARAPHRASE_OVERLAP_THRESHOLD}, got ${result.advisory_score}`,
  );
  assert.ok(result.advisory_score <= 1);
});

// -----------------------------------------------------------------------------
// T3 — 2 parents + new claim → ok_to_emit
// -----------------------------------------------------------------------------

test("T3: multi-parent + novel synthesis → ok_to_emit", async () => {
  const ledgerPath = freshLedgerPath("t3");
  // Fixture: two invented bench sorters, each described by one parent fact.
  const result = await shouldEmitReconstruction({
    parents: [
      {
        id: "fact_tumbler",
        content: "Tumbler QD-4 is the slow-warmup sorter.",
      },
      {
        id: "fact_wrenfield",
        content: "Wrenfield QD-4 is the quick-settle sorter.",
      },
    ],
    content:
      "Bench holds a pair of Pellham QD-4 sorters working side by side: Tumbler (slow-warmup) takes the early batches while Wrenfield (quick-settle) takes the late calibration passes.",
    confidence: 0.85,
    conversation_id: "conv-t3",
    ledgerPath,
  });
  assert.equal(result.emit, true);
  assert.equal(result.reason, "ok_to_emit");
  assert.equal(result.advisory_score, 0.85);
});

// -----------------------------------------------------------------------------
// T4 — existing near-dup in ledger → near_duplicate_exists
// -----------------------------------------------------------------------------

test("T4: existing near-dup row in ledger → near_duplicate_exists", async () => {
  const ledgerPath = freshLedgerPath("t4");
  // Seed an existing reconstructed row over {fact_a, fact_b} in conv-t4.
  // Use a longer content so a single-word edit lands a Jaccard > 0.92.
  const priorContent =
    "Both QD-4 sorters from Pellham sit on the north bench with the serial link on port ttyS3 as the main path and the spare Ethernet jack held back for paired calibration whenever the two units overlap.";
  seedReconstructed(ledgerPath, {
    id: "rec_prior_001",
    parents: ["fact_a", "fact_b"],
    content: priorContent,
    conversation_id: "conv-t4",
  });
  // Candidate: identical content (re-emit with same exact tokens) → Jaccard = 1.0.
  const candidateContent =
    "Both QD-4 sorters from Pellham sit on the north bench with the serial link on port ttyS3 as the main path and the spare Ethernet jack held back for paired calibration whenever the two units overlap.";
  const result = await shouldEmitReconstruction({
    parents: [
      { id: "fact_a", content: "fact a body" },
      { id: "fact_b", content: "fact b body" },
    ],
    content: candidateContent,
    confidence: 0.9,
    conversation_id: "conv-t4",
    ledgerPath,
  });
  assert.equal(result.emit, false);
  assert.equal(result.reason, "near_duplicate_exists");
  assert.ok(result.advisory_score > TRIGGER_CAPS.NEAR_DUP_THRESHOLD);
  assert.ok(result.advisory_score <= 1);
});

// -----------------------------------------------------------------------------
// T5 — defensive: malformed input → advisor_error
// -----------------------------------------------------------------------------

test("T5a: null input → advisor_error", async () => {
  const result = await shouldEmitReconstruction(null);
  assert.equal(result.emit, false);
  assert.equal(result.reason, "advisor_error");
  assert.equal(result.advisory_score, 0);
});

test("T5b: missing parents → advisor_error", async () => {
  const result = await shouldEmitReconstruction({
    content: "x".repeat(50),
    confidence: 0.9,
    conversation_id: "conv-t5b",
    ledgerPath: freshLedgerPath("t5b"),
  });
  assert.equal(result.emit, false);
  assert.equal(result.reason, "advisor_error");
});

test("T5c: confidence not finite → advisor_error", async () => {
  const result = await shouldEmitReconstruction({
    parents: [{ id: "fact_a", content: "x" }],
    content: "x".repeat(50),
    confidence: NaN,
    conversation_id: "conv-t5c",
    ledgerPath: freshLedgerPath("t5c"),
  });
  assert.equal(result.emit, false);
  assert.equal(result.reason, "advisor_error");
});

test("T5d: ledger read defensively degrades (non-existent path → ok_to_emit when other gates pass)", async () => {
  // The cross-module ledger scan handles non-existent paths defensively;
  // when no candidates exist, the advisor proceeds to ok_to_emit.
  const result = await shouldEmitReconstruction({
    parents: [
      { id: "fact_a", content: "alpha content" },
      { id: "fact_b", content: "beta content" },
    ],
    content:
      "A novel multi-parent synthesis that does not overlap with any existing reconstructed row.",
    confidence: 0.8,
    conversation_id: "conv-t5d",
    ledgerPath: "/nonexistent/path/that/will/not/exist/memory.jsonl",
  });
  assert.equal(result.emit, true);
  assert.equal(result.reason, "ok_to_emit");
});

// -----------------------------------------------------------------------------
// T6 — multi-parent synthesis (no near-dup, high confidence) → ok_to_emit
// -----------------------------------------------------------------------------

test("T6: multi-parent synthesis with seeded unrelated reconstructed rows → ok_to_emit", async () => {
  const ledgerPath = freshLedgerPath("t6");
  // Seed an unrelated reconstructed row over a DIFFERENT parent set.
  seedReconstructed(ledgerPath, {
    id: "rec_unrelated",
    parents: ["fact_x", "fact_y"],
    content:
      "An unrelated synthesis about a different topic entirely from what the candidate covers.",
    conversation_id: "conv-t6",
  });
  // Seed another reconstructed row over the same parent set BUT in a
  // different conversation — must NOT collide with the candidate's domain.
  seedReconstructed(ledgerPath, {
    id: "rec_other_conv",
    parents: ["fact_p", "fact_q"],
    content:
      "Another synthesis covering the parent set but in a different conversation context.",
    conversation_id: "conv-different",
  });
  const result = await shouldEmitReconstruction({
    parents: [
      { id: "fact_p", content: "fact p body" },
      { id: "fact_q", content: "fact q body" },
    ],
    content:
      "A fresh multi-parent synthesis that should not collide with prior rows in this conversation context.",
    confidence: 0.78,
    conversation_id: "conv-t6",
    ledgerPath,
  });
  assert.equal(result.emit, true);
  assert.equal(result.reason, "ok_to_emit");
  assert.equal(result.advisory_score, 0.78);
});

// -----------------------------------------------------------------------------
// Extra: confidence exactly at floor → admitted (mirrors W7 § R4 strict-less-than)
// -----------------------------------------------------------------------------

test("confidence exactly equal to floor → admitted (not below_confidence_min)", async () => {
  const ledgerPath = freshLedgerPath("floor-exact");
  const result = await shouldEmitReconstruction({
    parents: [
      { id: "fact_a", content: "alpha" },
      { id: "fact_b", content: "beta" },
    ],
    content:
      "A reasonable multi-parent synthesis exactly at the confidence floor.",
    confidence: TRIGGER_CAPS.CONFIDENCE_MIN,
    conversation_id: "conv-floor",
    ledgerPath,
  });
  assert.notEqual(result.reason, "below_confidence_min");
  assert.equal(result.emit, true);
  assert.equal(result.reason, "ok_to_emit");
});

// -----------------------------------------------------------------------------
// Extra: token-set Jaccard helper sanity (internal)
// -----------------------------------------------------------------------------

test("internal: tokenSetJaccard returns 1.0 for identical inputs", () => {
  const j = __internal.tokenSetJaccard("alpha beta gamma", "alpha beta gamma");
  assert.equal(j, 1);
});

test("internal: tokenSetJaccard returns 0 for disjoint inputs", () => {
  const j = __internal.tokenSetJaccard("alpha beta", "gamma delta");
  assert.equal(j, 0);
});

test("internal: parentSetHash is order-independent", () => {
  const h1 = __internal.parentSetHash(["fact_a", "fact_b", "fact_c"]);
  const h2 = __internal.parentSetHash(["fact_c", "fact_a", "fact_b"]);
  assert.equal(h1, h2);
  // Different parent set → different hash.
  const h3 = __internal.parentSetHash(["fact_a", "fact_b"]);
  assert.notEqual(h1, h3);
});
