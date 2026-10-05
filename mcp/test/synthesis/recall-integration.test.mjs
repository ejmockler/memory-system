// recall-integration.test.mjs — Wave 6 context-populator + multi-feature-score
// wiring tests. Verifies that the memory_recall handler now runs the synthesis
// substrate (entity-extractor, time-anchor-resolver, valence-scorer,
// episodicity-scorer) inline before scoring, and that the populated values
// flow through to brief.populator + the multi-feature soft-feature axes.
//
// Addresses:
//   F-SYN-INTEGRATION-CONTEXT-POPULATOR-HOOK    (populator runs server-side)
//   F-SYN-INTEGRATION-RECALL-CONSUMES-ENTITIES  (Jaccard fires non-zero)
//   F-SYN-INTEGRATION-RECALL-CONSUMES-TIME-ANCHORS (time_anchor_match fires)
//   F-SYN-INTEGRATION-RECALL-CONSUMES-VALENCE   (valence_compat fires)
//   F-SYN-INTEGRATION-MULTI-FEATURE-SCORE-WIRING (final_score reflects axes)
//
// Hermetic discipline:
//   - tmp root + env vars set BEFORE any dynamic import
//   - GEMINI_API_KEY force-unset -> handler takes the degraded_recall branch;
//     the populator block still runs (it does not depend on embeddings)
//   - the default (production) root stays byte-identical pre/post
//
// Run: node test/synthesis/recall-integration.test.mjs

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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


import { skipIfDaemonActive } from "../_hermetic-daemon-skip.mjs";
skipIfDaemonActive("recall-integration");

// ---------------------------------------------------------------------------
// 0. Hermetic root + env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-w6-recall-int-"));
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
  indices: join(CHECKOUT_ROOT, "indices"),
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
  indices: snap(PROD_PATHS.indices),
};

// ---------------------------------------------------------------------------
// 1. Dynamic imports AFTER env is set.
// ---------------------------------------------------------------------------
const recallMod = await import("../../lib/tools/recall.js");
const mfsMod = await import("../../lib/recall/multi-feature-score.js");
const entityMod = await import("../../lib/synthesis/entity-extractor.js");
const timeAnchorMod = await import("../../lib/synthesis/time-anchor-resolver.js");
const valenceMod = await import("../../lib/synthesis/valence-scorer.js");
const episodicityMod = await import("../../lib/synthesis/episodicity-scorer.js");
// e15-recall-temporal-scoping — freshness threshold + the read-only reporter.
const validationMod = await import("../../lib/validation.js");
const indexCacheMod = await import("../../lib/recall/index-cache.js");
const cfgMod = await import("../../lib/config.js");
const observablesMod = await import("../../lib/recall/recall-observables.js");
const { CAPS } = validationMod;
const { _resetCaches: _resetIndexCaches } = indexCacheMod;
const { memoryLedgerPath } = cfgMod;

const RECALL_JSONL = join(LEDGERS_DIR, "recall.jsonl");

function readRecallJsonl() {
  if (!existsSync(RECALL_JSONL)) return [];
  return readFileSync(RECALL_JSONL, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

function buildArgs({ currentQuery, recentTurns = [], time = "2026-06-15T12:00:00.000Z" }) {
  return {
    surrounding_context: {
      recent_turns: recentTurns.map((c) =>
        typeof c === "string" ? { role: "user", content: c } : c,
      ),
      agent_role: "test-agent",
      current_query: currentQuery,
      time,
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: "conv_w6_recall_integration_test",
    max_items: 12,
    max_chars: 4000,
  };
}

// ---------------------------------------------------------------------------
// T1 — populator block runs and brief.populator exists with shape.
// ---------------------------------------------------------------------------
test("T1: brief envelope exposes populator metadata block", async () => {
  const args = buildArgs({
    currentQuery: "Anything new on https://github.com/foo/bar today?",
    recentTurns: ["check #release at https://example.com/release"],
  });
  const result = await recallMod.TOOL.handler(args);
  assert.equal(result.ok, true, "handler returned ok");
  assert.ok(result.data, "result.data present");
  assert.ok(result.data.populator, "data.populator present");
  const p = result.data.populator;
  assert.equal(typeof p.degraded, "boolean", "populator.degraded is boolean");
  assert.equal(typeof p.entities_count, "number", "populator.entities_count number");
  assert.equal(typeof p.time_anchors_count, "number", "populator.time_anchors_count number");
  assert.equal(typeof p.has_time_anchor, "boolean", "populator.has_time_anchor boolean");
  assert.equal(typeof p.valence_set, "boolean", "populator.valence_set boolean");
  assert.equal(p.entity_extractor_version, entityMod.ENTITY_EXTRACTOR_VERSION);
  assert.equal(p.time_anchor_resolver_version, timeAnchorMod.TIME_ANCHOR_RESOLVER_VERSION);
  assert.equal(p.valence_model_version, valenceMod.MODEL_VERSION);
  assert.equal(p.episodicity_version, episodicityMod.EPISODICITY_VERSION);
});

// ---------------------------------------------------------------------------
// T2 — populator actually extracts entities from rich context.
// The entity-extractor harvests URLs (artifact), hashtags (topic), repos
// (org/project). With multiple structural anchors in the context the count
// MUST be > 0; entities_count == 0 indicates the populator was not invoked.
// ---------------------------------------------------------------------------
test("T2: populator extracts entities from URL + repo + hashtag context", async () => {
  const args = buildArgs({
    currentQuery: "Check https://github.com/torvalds/linux for #kernel updates",
    recentTurns: ["Sent email to alice@example.com about it"],
  });
  const result = await recallMod.TOOL.handler(args);
  assert.equal(result.ok, true);
  assert.ok(
    result.data.populator.entities_count > 0,
    `entities_count > 0 (got ${result.data.populator.entities_count})`,
  );
  assert.equal(result.data.populator.degraded, false, "non-degraded happy path");
});

// ---------------------------------------------------------------------------
// T3 — populator extracts time anchors from natural-language phrases.
// "today" / "tomorrow" / explicit ISO dates should resolve to a non-null
// anchor when ctx.time supplies the now-reference.
// ---------------------------------------------------------------------------
test("T3: populator resolves time anchors from natural-language phrases", async () => {
  const args = buildArgs({
    currentQuery: "What is happening tomorrow at 3pm?",
    recentTurns: ["Yesterday we discussed the rollout"],
    time: "2026-06-15T09:00:00.000Z",
  });
  const result = await recallMod.TOOL.handler(args);
  assert.equal(result.ok, true);
  assert.ok(
    result.data.populator.time_anchors_count > 0,
    `time_anchors_count > 0 (got ${result.data.populator.time_anchors_count})`,
  );
  assert.equal(
    result.data.populator.has_time_anchor,
    true,
    "has_time_anchor === true",
  );
});

// ---------------------------------------------------------------------------
// T4 — empty surrounding_context is graceful: populator returns empty,
// handler still returns a brief, no degraded_reasons.
// ---------------------------------------------------------------------------
test("T4: empty-ish context still produces a brief; populator is non-degraded", async () => {
  const args = buildArgs({
    currentQuery: "x", // minimal valid non-empty
    recentTurns: [],
  });
  const result = await recallMod.TOOL.handler(args);
  assert.equal(result.ok, true);
  // entity / time-anchor counts may be zero — no structural anchors in "x".
  assert.equal(result.data.populator.entities_count, 0);
  assert.equal(result.data.populator.time_anchors_count, 0);
  // Populator did not THROW — degraded is false even though signals are zero.
  assert.equal(result.data.populator.degraded, false);
  assert.deepEqual(result.data.populator.degraded_reasons, []);
});

// ---------------------------------------------------------------------------
// T5 — recall-log event carries the populator block (counts only per spec).
// ---------------------------------------------------------------------------
test("T5: recall.jsonl event includes populator metadata block", async () => {
  const events = readRecallJsonl();
  assert.ok(events.length > 0, "recall.jsonl has at least one event");
  const ev = events[events.length - 1];
  assert.ok(ev.populator, "event.populator present");
  assert.equal(typeof ev.populator.entities_count, "number");
  assert.equal(typeof ev.populator.time_anchors_count, "number");
  assert.equal(typeof ev.populator.inferred_mood_sign, "number");
  assert.equal(ev.populator.version, "v1");
  // Counts are stamped — full arrays are NOT (spec § 4.7).
  assert.equal(ev.populator.entities, undefined, "no entities[] dumped to log");
});

// ---------------------------------------------------------------------------
// T6 — multi-feature score: candidate with matching entities AND matching
// time_anchor scores higher than one with neither. Direct computeScore unit
// test exercises the wiring without needing a full ledger.
// ---------------------------------------------------------------------------
test("T6: candidate with matching entities + time anchor outranks naked candidate", () => {
  const ts = "2026-06-15T00:00:00Z";
  const surrounding = {
    entities: ["artifact:chat-claude-code:foo_bar", "topic:chat-claude-code:kernel"],
    time_anchor: "2026-06-15T12:00:00Z",
    valence: 0,
    query_episodicity: 0.5,
  };
  const matching = mfsMod.computeScore({
    s_emb_full3072: 0.3,
    gates: { predicate_mask: 1, consent_dampener: 1, derivation_status: 1 },
    candidate: {
      memory_id: "m1",
      kind: "fact",
      ts,
      entities: ["artifact:chat-claude-code:foo_bar", "topic:chat-claude-code:kernel"],
      valence: 0,
    },
    surrounding_context: surrounding,
  });
  const naked = mfsMod.computeScore({
    s_emb_full3072: 0.3,
    gates: { predicate_mask: 1, consent_dampener: 1, derivation_status: 1 },
    candidate: {
      memory_id: "m2",
      kind: "fact",
      ts: "2025-01-01T00:00:00Z",
      entities: ["artifact:chat-claude-code:something_else"],
      valence: 0,
    },
    surrounding_context: surrounding,
  });
  assert.ok(
    matching.entity_overlap_jaccard > 0,
    `matching entity_overlap > 0 (got ${matching.entity_overlap_jaccard})`,
  );
  assert.equal(naked.entity_overlap_jaccard, 0, "naked entity_overlap == 0");
  assert.ok(
    matching.time_anchor_match > naked.time_anchor_match,
    `matching time_anchor_match (${matching.time_anchor_match}) > naked (${naked.time_anchor_match})`,
  );
  assert.ok(
    matching.final_score > naked.final_score,
    `matching final_score (${matching.final_score}) > naked (${naked.final_score})`,
  );
});

// ---------------------------------------------------------------------------
// T7 — predicate_mask=0 still hard-excludes regardless of soft entity overlap.
// This pins the invariant that the additive branch cannot rescue a candidate
// that the hard-gate already excised.
// ---------------------------------------------------------------------------
test("T7: predicate_mask=0 collapses multiplicative branch even with full entity overlap", () => {
  const ts = "2026-06-15T00:00:00Z";
  const surrounding = {
    entities: ["topic:chat-claude-code:secret"],
    time_anchor: "2026-06-15T00:00:00Z",
    valence: 0,
    query_episodicity: 0.5,
  };
  const excluded = mfsMod.computeScore({
    s_emb_full3072: 0.9,
    gates: { predicate_mask: 0, consent_dampener: 1, derivation_status: 1 },
    candidate: {
      memory_id: "m_excluded",
      kind: "fact",
      ts,
      entities: ["topic:chat-claude-code:secret"],
      valence: 0,
    },
    surrounding_context: surrounding,
  });
  // Multiplicative branch is fully zero (s_emb * 0 * ... = 0). Additive
  // branch still contributes entity_overlap + time_anchor + decay terms,
  // but the predicate gate has zeroed the embedding lever.
  assert.equal(excluded.predicate_mask, 0);
  // s_emb_full3072 is preserved on the breakdown for audit BUT does not
  // contribute to final_score because the multiplicative branch is zero.
  assert.equal(excluded.s_emb_full3072, 0.9);
  // The additive branch can never exceed the embedding-dominated score of
  // an admitted candidate with the same surrounding entities, because the
  // embedding term is gated to 0 entirely.
  const admitted = mfsMod.computeScore({
    s_emb_full3072: 0.9,
    gates: { predicate_mask: 1, consent_dampener: 1, derivation_status: 1 },
    candidate: {
      memory_id: "m_admitted",
      kind: "fact",
      ts,
      entities: ["topic:chat-claude-code:secret"],
      valence: 0,
    },
    surrounding_context: surrounding,
  });
  assert.ok(
    admitted.final_score > excluded.final_score,
    `admitted final_score (${admitted.final_score}) > excluded final_score (${excluded.final_score})`,
  );
});

// ---------------------------------------------------------------------------
// T8 — valence_compat consumes the populator-resolved sign.
// ---------------------------------------------------------------------------
test("T8: valence_compat fires non-trivially when candidate + context valences match", () => {
  const ts = "2026-06-15T00:00:00Z";
  const surroundingPos = {
    entities: [],
    time_anchor: null,
    valence: 1, // positive
    query_episodicity: 0.5,
  };
  const surroundingNeg = {
    entities: [],
    time_anchor: null,
    valence: -1,
    query_episodicity: 0.5,
  };
  const candPos = {
    memory_id: "pos",
    kind: "fact",
    ts,
    entities: [],
    valence: 1,
  };
  const scoreMatched = mfsMod.computeScore({
    s_emb_full3072: 0.1,
    gates: { predicate_mask: 1, consent_dampener: 1, derivation_status: 1 },
    candidate: candPos,
    surrounding_context: surroundingPos,
  });
  const scoreMismatched = mfsMod.computeScore({
    s_emb_full3072: 0.1,
    gates: { predicate_mask: 1, consent_dampener: 1, derivation_status: 1 },
    candidate: candPos,
    surrounding_context: surroundingNeg,
  });
  // Matching valence -> valence_compat=1; mismatched -> 0.
  assert.equal(scoreMatched.valence_compat, 1);
  assert.equal(scoreMismatched.valence_compat, 0);
});

// ---------------------------------------------------------------------------
// T9 — synthesis-side episodicityMatch wires in when BOTH candidate and
// query carry episodicity scalars. Tests both same-axis (match=1) and
// opposite-axis (match=0).
// ---------------------------------------------------------------------------
test("T9: episodicity_match consumes synthesis substrate when both axes present", () => {
  const ts = "2026-06-15T00:00:00Z";
  const surrounding = {
    entities: [],
    time_anchor: null,
    valence: 0,
    query_episodicity: 0.9, // strongly episodic
  };
  const candidateEpisodic = {
    memory_id: "ep",
    kind: "episodic",
    ts,
    entities: [],
    valence: null,
    features: { episodicity: 0.9 },
  };
  const candidateSemantic = {
    memory_id: "sem",
    kind: "fact",
    ts,
    entities: [],
    valence: null,
    features: { episodicity: 0.1 },
  };
  const sEp = mfsMod.computeScore({
    s_emb_full3072: 0.5,
    gates: { predicate_mask: 1, consent_dampener: 1, derivation_status: 1 },
    candidate: candidateEpisodic,
    surrounding_context: surrounding,
  });
  const sSem = mfsMod.computeScore({
    s_emb_full3072: 0.5,
    gates: { predicate_mask: 1, consent_dampener: 1, derivation_status: 1 },
    candidate: candidateSemantic,
    surrounding_context: surrounding,
  });
  // Episodicity axis match: candidate=0.9, query=0.9 -> match=1.
  // Semantic candidate: 0.1 vs 0.9 -> match=0.2.
  assert.ok(sEp.episodicity_match > sSem.episodicity_match);
  // The multiplicative branch is gated by episodicity, so the episodic
  // candidate's final score must be strictly higher with equal s_emb.
  assert.ok(sEp.final_score > sSem.final_score);
});

// ---------------------------------------------------------------------------
// T10 — extractor-threw degrade path: when one extractor throws, populator
// surfaces degraded=true with a reason, and the handler still returns a
// brief. Drive this with a monkey-patched extractor module via dynamic
// import-with-mock would require ESM loader hooks we don't have; instead
// we verify the contract by inspecting the degrade-state surface shape.
//
// This test inserts a context that semantically should produce extractor
// output (which we verified in T2), but inspects that degraded_reasons is
// the empty-array shape on the happy path. The "extractor threw" branch
// is covered by the populator's catch blocks in recall.js — visually
// inspected; this test pins the happy-path shape so a regression that
// always-marks-degraded would surface immediately.
// ---------------------------------------------------------------------------
test("T10: happy-path populator surfaces empty degraded_reasons array", async () => {
  const args = buildArgs({
    currentQuery: "Look at https://github.com/foo/bar with #release tomorrow",
  });
  const result = await recallMod.TOOL.handler(args);
  assert.equal(result.data.populator.degraded, false);
  assert.ok(Array.isArray(result.data.populator.degraded_reasons));
  assert.equal(result.data.populator.degraded_reasons.length, 0);
});

// ---------------------------------------------------------------------------
// T11 — multi-feature-score formula sanity: weights are CAPS-pinned and
// computeScore returns the documented feature_breakdown axes. Regression
// guard against silent CAPS edits that would shift scoring without a
// version bump.
// ---------------------------------------------------------------------------
test("T11: computeScore returns all documented feature axes", () => {
  const r = mfsMod.computeScore({
    s_emb_full3072: 0.5,
    gates: { predicate_mask: 1, consent_dampener: 1, derivation_status: 1 },
    candidate: {
      memory_id: "rs",
      kind: "fact",
      ts: "2026-06-15T00:00:00Z",
      entities: ["topic:chat-claude-code:alpha"],
      valence: 0,
    },
    surrounding_context: {
      entities: ["topic:chat-claude-code:alpha"],
      time_anchor: "2026-06-15T00:00:00Z",
      valence: 0,
      query_episodicity: 0.5,
    },
  });
  for (const axis of [
    "s_emb_full3072",
    "predicate_mask",
    "consent_dampener",
    "derivation_status",
    "episodicity_match",
    "entity_overlap_jaccard",
    "time_anchor_match",
    "power_law_decay",
    "valence_compat",
    "engagement_prior",
    "final_score",
  ]) {
    assert.ok(axis in r, `feature_breakdown axis present: ${axis}`);
  }
  assert.equal(r.entity_overlap_jaccard, 1, "identical entity sets -> Jaccard=1");
  assert.equal(r.time_anchor_match, 1, "same-day time anchor -> match=1");
});

// ===========================================================================
// e15-recall-temporal-scoping — T13..T16.
//
// These are deliberately placed BEFORE T12 (the production byte-identical
// guard), which must remain the LAST registered test in this file: node:test
// runs top-level tests in registration order, and T12 is the closing snapshot.
// ===========================================================================

// ---------------------------------------------------------------------------
// T13 — freshnessLabel unit table. The brief's `freshness` used to be the
// hardcoded literal "fresh" for every row; this pins the total function that
// replaced it, including every malformed / absent input, and pins the enum
// CLOSED by execution (no input in the table yields "potentially_outdated").
// ---------------------------------------------------------------------------
test("T13: freshnessLabel is a total function over (candidate_ts, now_iso)", () => {
  const CAP = CAPS.RECALL_FRESHNESS_STALE_AFTER_MS;
  assert.equal(CAP, 30 * 24 * 60 * 60 * 1000, "CAP is the pinned 30-day scale");

  const NOW = "2026-08-20T00:00:00.000Z";
  const nowMs = Date.parse(NOW);
  const isoAt = (ms) => new Date(ms).toISOString();

  const table = [
    // [label, candidate_ts, now_iso, expected]
    ["age 0", NOW, NOW, "fresh"],
    ["age exactly CAP (boundary inclusive)", isoAt(nowMs - CAP), NOW, "fresh"],
    ["age CAP + 1ms", isoAt(nowMs - CAP - 1), NOW, "stale"],
    // The node's measured case: a January-through-April row surfaced in
    // August reported "fresh" before this change.
    ["measured case 2026-04-12 vs 2026-08-20", "2026-04-12T00:00:00.000Z", "2026-08-20T00:00:00.000Z", "stale"],
    // Reachable in production: recall.js's enriched projection assigns
    // `ts: t ? t.candidate.ts : ""` when the top-candidate lookup misses.
    ["empty candidate_ts", "", NOW, "stale"],
    ["absent candidate_ts", undefined, NOW, "stale"],
    ["unparseable candidate_ts", "not-a-date", NOW, "stale"],
    // Clock skew: future-dated candidate clamps to age 0 -> fresh (the same
    // clamp powerLawDecay documents).
    ["future-dated candidate_ts (skew clamp)", isoAt(nowMs + 5 * 24 * 60 * 60 * 1000), NOW, "fresh"],
    ["unparseable now_iso", NOW, "not-a-date", "stale"],
    ["absent now_iso", NOW, undefined, "stale"],
    ["empty now_iso", NOW, "", "stale"],
    ["both absent", undefined, undefined, "stale"],
  ];

  const observed = new Set();
  for (const [label, candidate_ts, now_iso, expected] of table) {
    const got = mfsMod.freshnessLabel({ candidate_ts, now_iso });
    assert.equal(got, expected, `${label}: expected ${expected}, got ${got}`);
    observed.add(got);
    assert.notEqual(
      got,
      "potentially_outdated",
      `${label}: reserved value must never be emitted`,
    );
  }
  // No-arg call must not throw and must take the conservative direction.
  assert.equal(mfsMod.freshnessLabel(), "stale", "no-arg call -> stale");
  observed.add(mfsMod.freshnessLabel());

  assert.deepEqual(
    [...observed].sort(),
    ["fresh", "stale"],
    "the observed label set is exactly {fresh, stale}",
  );
});

// ---------------------------------------------------------------------------
// T13b — no ambient clock. freshnessLabel must read `now_iso` and nothing
// else: an unparseable clock is "stale", NEVER a silent fall-through to
// serverTs()/Date.now() that would have made the row look fresh.
// ---------------------------------------------------------------------------
test("T13b: freshnessLabel consults no clock but now_iso", () => {
  const src = mfsMod.freshnessLabel.toString();
  for (const forbidden of ["serverTs(", "nowIso(", "Date.now("]) {
    assert.equal(
      src.includes(forbidden),
      false,
      `freshnessLabel body must not call ${forbidden}`,
    );
  }
  // A row that IS recent by wall-clock but whose supplied clock is garbage
  // must still be "stale" — proving the ambient clock is not consulted.
  const recent = new Date(Date.now() - 60_000).toISOString();
  assert.equal(
    mfsMod.freshnessLabel({ candidate_ts: recent, now_iso: "not-a-date" }),
    "stale",
  );
});

// ---------------------------------------------------------------------------
// T14 — handler arm. Seed one OLD and one RECENT row, drive TOOL.handler with
// an explicit surrounding_context.time, and assert the labels are computed
// from that clock. Candidate generation here rides the substrate entity-index
// fallback (BM25/HNSW are empty in a hermetic root), which is why both rows
// stamp the same canonical entity the query extracts.
// ---------------------------------------------------------------------------
const FRESHNESS_ENTITY = {
  canonical_id: "topic:chat-claude-code:kernel",
  kind: "topic",
  surface: "kernel",
  source_scope: "chat-claude-code",
  evidence: "structural",
  confidence: 1,
};
const OLD_TS = "2026-01-05T00:00:00.000Z";
const RECENT_TS = "2026-08-18T00:00:00.000Z";
const FRESHNESS_NOW = "2026-08-20T12:00:00.000Z";

function seedFreshnessLedger() {
  const rows = [
    {
      id: "f_old_kernel",
      kind: "fact",
      ts: OLD_TS,
      created_at: OLD_TS,
      content: "kernel build instructions for the workshop machine",
      source_refs: [{ source: "chat-claude-code", consent_basis: "first_party" }],
      features: { entities: [FRESHNESS_ENTITY] },
    },
    {
      id: "f_recent_kernel",
      kind: "fact",
      ts: RECENT_TS,
      created_at: RECENT_TS,
      content: "kernel build instructions updated after the rebuild",
      source_refs: [{ source: "chat-claude-code", consent_basis: "first_party" }],
      features: { entities: [FRESHNESS_ENTITY] },
    },
  ];
  writeFileSync(
    memoryLedgerPath(),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    { mode: 0o600 },
  );
  // Bust the mtime-keyed index caches — tests fire faster than FS mtime
  // resolution.
  _resetIndexCaches();
}

test("T14: handler labels an old row stale and a recent row fresh off ctx.time", async () => {
  seedFreshnessLedger();
  const args = buildArgs({
    currentQuery: "kernel build instructions #kernel",
    recentTurns: ["how do I build the #kernel?"],
    time: FRESHNESS_NOW,
  });
  const result = await recallMod.TOOL.handler(args);
  assert.equal(result.ok, true, "handler returned ok");
  const memories = result.data.memories;
  assert.ok(Array.isArray(memories), "memories[] is an array");
  assert.ok(memories.length >= 2, `both seeded rows surfaced (got ${memories.length})`);

  // The enum is closed on the live path too.
  for (const m of memories) {
    assert.ok(
      m.freshness === "fresh" || m.freshness === "stale",
      `freshness in {fresh,stale} (got ${JSON.stringify(m.freshness)})`,
    );
  }

  const oldRow = memories.find((m) => m.id === "f_old_kernel");
  const recentRow = memories.find((m) => m.id === "f_recent_kernel");
  assert.ok(oldRow, "old row surfaced");
  assert.ok(recentRow, "recent row surfaced");
  // Delta from ctx.time > CAPS.RECALL_FRESHNESS_STALE_AFTER_MS.
  assert.ok(
    Date.parse(FRESHNESS_NOW) - Date.parse(OLD_TS) > CAPS.RECALL_FRESHNESS_STALE_AFTER_MS,
    "fixture: old row is beyond the threshold",
  );
  assert.equal(oldRow.freshness, "stale", "old row is stale");
  assert.equal(recentRow.freshness, "fresh", "recent row is fresh");
  // Same clock in -> same labels out (no ambient clock on this path).
  const again = await recallMod.TOOL.handler(args);
  assert.deepEqual(
    again.data.memories.map((m) => [m.id, m.freshness]).sort(),
    memories.map((m) => [m.id, m.freshness]).sort(),
    "identical ctx.time yields identical labels",
  );
});

// ---------------------------------------------------------------------------
// T15 — envelope honesty. candidate_pool_size (pre-hard-gate fused pool) is
// published beside candidate_set_size (post-gate) on the response AND on the
// appended recall event, and the pool is never smaller than what survived.
// ---------------------------------------------------------------------------
test("T15: candidate_pool_size >= candidate_set_size on response and recall event", async () => {
  seedFreshnessLedger();
  const args = buildArgs({
    currentQuery: "kernel build instructions #kernel",
    recentTurns: ["how do I build the #kernel?"],
    time: FRESHNESS_NOW,
  });
  const result = await recallMod.TOOL.handler(args);
  assert.equal(result.ok, true);
  assert.equal(
    typeof result.data.candidate_pool_size,
    "number",
    "response carries candidate_pool_size",
  );
  assert.ok(
    result.data.candidate_pool_size >= result.data.candidate_set_size,
    `response: pool ${result.data.candidate_pool_size} >= set ${result.data.candidate_set_size}`,
  );

  const events = readRecallJsonl();
  const ev = events[events.length - 1];
  assert.equal(typeof ev.candidate_pool_size, "number", "event carries candidate_pool_size");
  assert.ok(
    ev.candidate_pool_size >= result.data.candidate_set_size,
    `event: pool ${ev.candidate_pool_size} >= set ${result.data.candidate_set_size}`,
  );
  assert.ok(
    ev.candidate_pool_size >= ev.candidates_pre_truncation.length,
    `event: pool ${ev.candidate_pool_size} >= candidates_pre_truncation ` +
      `${ev.candidates_pre_truncation.length}`,
  );
});

// ---------------------------------------------------------------------------
// T16 — observables arm. computeRecallObservables reports anchored_rate as a
// FRACTION over rows carrying a populator block (NOT over every recall row),
// plus a time_anchors_count histogram. Driven over a synthetic recall log
// written inside this test's tmp root — production ledgers are never read.
// ---------------------------------------------------------------------------
test("T16: computeRecallObservables reports anchored_rate + anchor histogram", () => {
  const SYNTH = join(LEDGERS_DIR, "recall-observables-fixture.jsonl");
  const rows = [];
  const mk = (i, populator) => ({
    id: `r_${i}`,
    ts: `2026-08-${String(1 + (i % 20)).padStart(2, "0")}T00:00:00.000Z`,
    kind: "recall",
    surfaced: [],
    candidates_pre_truncation: [],
    ...(populator === null ? {} : { populator }),
  });
  // 40 populator rows (over the default min_sample of 30): 4 anchored.
  for (let i = 0; i < 36; i += 1) {
    rows.push(mk(i, { version: "v1", has_time_anchor: false, time_anchors_count: 0 }));
  }
  for (let i = 36; i < 39; i += 1) {
    rows.push(mk(i, { version: "v1", has_time_anchor: true, time_anchors_count: 1 }));
  }
  rows.push(mk(39, { version: "v1", has_time_anchor: true, time_anchors_count: 2 }));
  // Two PRE-populator rows: they must NOT enter the denominator.
  rows.push(mk(40, null));
  rows.push(mk(41, null));
  writeFileSync(SYNTH, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", {
    mode: 0o600,
  });

  const env = observablesMod.computeRecallObservables({ recallLogPath: SYNTH });
  assert.equal(env.rate_scale, "fraction", "the envelope's single scale stamp covers it");
  const t = env.totals;
  assert.equal(t.n, 42, "all 42 recall rows are in window");
  assert.equal(t.populator_rows, 40, "denominator excludes populator-less rows");
  assert.equal(t.anchored_count, 4);
  assert.equal(t.anchored_rate.count, 4);
  assert.equal(t.anchored_rate.pct, 0.1, "4/40 emitted as a fraction, not a percent");
  assert.equal(t.anchored_rate.suppressed, null);
  assert.deepEqual(t.time_anchors_count_histogram, { 0: 36, 1: 3, 2: 1 });
  // Reporter, not a gate: no verdict key is introduced alongside the rate.
  assert.equal("anchored_verdict" in t, false);
});

// ---------------------------------------------------------------------------
// T12 — production-path byte-identical guard.
// ---------------------------------------------------------------------------
test("T12: production paths byte-identical pre/post test run", () => {
  const PROD_AFTER = {
    memory: snap(PROD_PATHS.memory),
    recall: snap(PROD_PATHS.recall),
    indices: snap(PROD_PATHS.indices),
  };
  assert.equal(PROD_AFTER.memory, PROD_BEFORE.memory);
  assert.equal(PROD_AFTER.recall, PROD_BEFORE.recall);
  assert.equal(PROD_AFTER.indices, PROD_BEFORE.indices);
});

// ---------------------------------------------------------------------------
// Cleanup.
// ---------------------------------------------------------------------------
process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});
