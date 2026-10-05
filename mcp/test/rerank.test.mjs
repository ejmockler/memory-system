// rerank.test.mjs — Phase 3 v1 Layer-3 reranker unit tests.
//
// AUTHORITATIVE shape contract: kb/phase3-v1-rerank-contracts.md § 7 Test plan.
// Module under test: mcp/lib/recall/rerank.js (buildRerankInstruction,
// serializeCandidateForRerank, rerankCandidates).
//
// HERMETICITY (standing C-NEW-2 pattern): set MEMORY_ROOT and the
// POLICY/STORAGE/LEDGERS dirs to mkdtempSync paths BEFORE any dynamic import
// of memory-system modules. Production trees at <checkout>
// MUST NOT be touched. rerank.js depends on gemini-flash-client.js which
// reads GEMINI_API_KEY from process.env at call time; we manipulate that
// directly in the relevant tests. No real Flash POSTs are issued — every
// rerankCandidates() call here uses opts._generateRanking injection.
//
// Mock strategy:
//   rerank.js exposes `opts._generateRanking` as a function override on
//   rerankCandidates (see mcp/lib/recall/rerank.js line ~297). We pass a stub
//   per-test. No globalThis.fetch monkeypatch needed; no temp fixture module
//   files written. Tests T5 (timeout) and T6 (malformed) use stubs that
//   throw/delay; T7 (api_key_missing) sets process.env.GEMINI_API_KEY to ""
//   and asserts the stub was NEVER invoked.
//
// Run: node test/rerank.test.mjs
// Exits 0 on pass, non-zero on any failure.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Hermeticity: stake out tmp dirs and overwrite env BEFORE dynamic import.
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(join(tmpdir(), "memsys-rerank-test-"));
mkdirSync(join(TEST_ROOT, "policy"), { recursive: true });
mkdirSync(join(TEST_ROOT, "storage"), { recursive: true });
mkdirSync(join(TEST_ROOT, "ledgers"), { recursive: true });
mkdirSync(join(TEST_ROOT, "indices"), { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
process.env.POLICY_BASE_DIR = join(TEST_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TEST_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TEST_ROOT, "ledgers");
process.on("exit", () => {
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

// F1 (memperf): the key gate is skipped entirely when the local reranker is
// enabled — force the env toggle OFF so the gate under test is deterministic.
// b4: an explicit "0" is required, not a delete. _localRerankerEnabled() is
// tri-state and falls through to CAPS.LOCAL_RERANKER_ENABLED (now true) when
// the var is UNSET, so deleting it left the local backend on and the gemini
// key gate skipped — the T7/K2/L1+L2/E2 assertions below all test that gate.
process.env.LOCAL_RERANKER_ENABLED = "0";

// F1 (memperf): key resolution now goes through gemini-client.js's shared
// key pool (GEMINI_API_KEYS plural / legacy GEMINI_API_KEY singular), which
// lazily parses env ONCE per process — so every env mutation must be paired
// with _resetKeyPoolForTests(). Import the pool seam BEFORE staking out key
// state.
const geminiClientMod = await import("../lib/gemini-client.js");
const { _resetKeyPoolForTests } = geminiClientMod;

// Snapshot + restore BOTH key env vars across tests. Most tests need a key
// SET so the rerankCandidates short-circuit (api_key_missing) doesn't fire;
// T7/K2 clear them. We restore after every test to keep state contained.
const ORIGINAL_GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ORIGINAL_GEMINI_API_KEYS = process.env.GEMINI_API_KEYS;
// Drive the SINGULAR var; always clears the plural var so each test's key
// state is exactly what it set. Resets the pool so the mutation is observed.
function setKey(v) {
  delete process.env.GEMINI_API_KEYS;
  if (v == null) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = v;
  _resetKeyPoolForTests();
}
// Drive the PLURAL (pool) var; always clears the singular var.
function setKeys(v) {
  delete process.env.GEMINI_API_KEY;
  if (v == null) delete process.env.GEMINI_API_KEYS;
  else process.env.GEMINI_API_KEYS = v;
  _resetKeyPoolForTests();
}
function clearAllKeys() {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEYS;
  _resetKeyPoolForTests();
}
function restoreKey() {
  if (ORIGINAL_GEMINI_API_KEY != null) {
    process.env.GEMINI_API_KEY = ORIGINAL_GEMINI_API_KEY;
  } else {
    delete process.env.GEMINI_API_KEY;
  }
  if (ORIGINAL_GEMINI_API_KEYS != null) {
    process.env.GEMINI_API_KEYS = ORIGINAL_GEMINI_API_KEYS;
  } else {
    delete process.env.GEMINI_API_KEYS;
  }
  _resetKeyPoolForTests();
}
// Synthetic key for default-state tests. R29.1: must satisfy the boot-time
// shape validator (AIza<35+ chars>); contains "FAKE" — never a real key.
const VALID_FAKE_KEY = "AIzaFAKE_rerank_test_xxxxxxxxxxxxxxxxxxxx";
// Ensure a key is set for the default-state tests.
setKey(VALID_FAKE_KEY);

// Dynamic import AFTER env override.
const rerankMod = await import("../lib/recall/rerank.js");
const {
  buildRerankInstruction,
  serializeCandidateForRerank,
  rerankCandidates,
  RERANK_CONSTANTS,
  _resetRerankDegradeLogForTests,
} = rerankMod;
const { CAPS } = await import("../lib/validation.js");

// ---------------------------------------------------------------------------
// Ad-hoc test harness (matches mmr.test.mjs / gemini-flash-client.test.mjs).
// ---------------------------------------------------------------------------
let failures = 0;
let passes = 0;
function check(label, fn) {
  try {
    fn();
    passes += 1;
    console.log(`PASS  ${label}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL  ${label}`);
    console.error(`      ${e && e.stack ? e.stack : e}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    passes += 1;
    console.log(`PASS  ${label}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL  ${label}`);
    console.error(`      ${e && e.stack ? e.stack : e}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture builders.
// ---------------------------------------------------------------------------

// Minimal IndexEntry — only the fields serializeCandidateForRerank reads.
function mkEntry(overrides = {}) {
  return {
    memory_id: "mem_001",
    kind: "fact",
    ts: "2026-06-01T12:00:00Z",
    entities: ["alice", "bob"],
    consent_basis: "first_party",
    derivation_distance: null,
    valence: null,
    content: "a short content excerpt",
    ...overrides,
  };
}

function mkScoreComponents(final_score = 0.5) {
  return {
    rrf_score: 0.1,
    cosine_3072: 0.8,
    recency_score: 0.5,
    salience_score: 0.5,
    consent_dampener: 1.0,
    derivation_dampener: 1.0,
    final_score,
  };
}

function mkCandidateWithScore(entry_overrides = {}, final_score = 0.5) {
  return {
    candidate: mkEntry(entry_overrides),
    score_components: mkScoreComponents(final_score),
  };
}

// Build N candidates with deterministic memory_ids and descending final_score.
function mkInputPool(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const id = `mem_${String(i + 1).padStart(3, "0")}`;
    // final_score descending so the array is already sorted.
    const final_score = 1 - i * 0.01;
    out.push(mkCandidateWithScore({ memory_id: id, content: `body of ${id}` }, final_score));
  }
  return out;
}

const FIXED_NOW = "2026-06-01T15:00:00Z";

const SURROUNDING = {
  current_query: "what does the user think about the partner project?",
  recent_turns: [
    { role: "user", content: "hey, what's the status of the partner project?" },
    { role: "assistant", content: "you said last week robin was leading it." },
  ],
  agent_role: "primary_assistant",
  entities: ["robin", "partner_project"],
};

// ---------------------------------------------------------------------------
// T1: buildRerankInstruction emits the expected template structure.
// ---------------------------------------------------------------------------
check("T1: buildRerankInstruction template contains required fragments", () => {
  const out = buildRerankInstruction({
    surrounding_context: SURROUNDING,
    candidates: [],
    opts: { now: FIXED_NOW },
  });
  assert.equal(typeof out, "string");
  // Header line.
  assert.ok(
    out.includes("Rank these candidate memories by relevance to the current conversation context."),
    "missing header line"
  );
  // Context block.
  assert.ok(out.includes("Current context:"), "missing Current context block");
  assert.ok(out.includes("- agent role: primary_assistant"), "missing agent role line");
  assert.ok(out.includes(`- time: ${FIXED_NOW}`), "missing time line w/ override");
  assert.ok(out.includes("- recent conversation:"), "missing recent conversation header");
  assert.ok(
    out.includes("  - user: hey, what's the status of the partner project?"),
    "missing first recent turn"
  );
  assert.ok(
    out.includes("  - assistant: you said last week robin was leading it."),
    "missing second recent turn"
  );
  assert.ok(
    out.includes("- entities in context: robin, partner_project"),
    "missing entities line"
  );
  // Ranking rules header + each of the 5 rules.
  assert.ok(out.includes("Ranking rules (apply declaratively):"), "missing rules header");
  assert.ok(out.includes("1. PREFER"), "missing rule 1 PREFER");
  assert.ok(out.includes("2. DAMPEN"), "missing rule 2 DAMPEN");
  assert.ok(out.includes("3. DEMOTE"), "missing rule 3 DEMOTE");
  assert.ok(out.includes("4. AVOID"), "missing rule 4 AVOID");
  assert.ok(out.includes("5. SUPPRESS"), "missing rule 5 SUPPRESS");
  // Tail instructing JSON output.
  assert.ok(
    out.includes("Return a JSON array of {id, rank_score}"),
    "missing JSON return instruction"
  );
  assert.ok(
    out.includes("rank_score in [0,1]"),
    "missing rank_score range hint"
  );
});

// Sub-assertion: entities empty -> "(none)".
check("T1b: buildRerankInstruction renders empty entities as (none)", () => {
  const out = buildRerankInstruction({
    surrounding_context: {
      ...SURROUNDING,
      entities: [],
    },
    candidates: [],
    opts: { now: FIXED_NOW },
  });
  assert.ok(out.includes("- entities in context: (none)"), "expected (none) marker");
});

// ---------------------------------------------------------------------------
// T2: serializeCandidateForRerank truncates content at the CAPS limit and
// renders the header with kind/ts/entities/consent_basis/derivation_orphan/
// valence (incl. null valence as literal "null").
// ---------------------------------------------------------------------------
check("T2: serializeCandidateForRerank truncates content + emits header fields", () => {
  // Build content longer than the cap (400) so we observe truncation.
  const longContent = "x".repeat(CAPS.RECALL_RERANK_CONTENT_EXCERPT_CHARS + 200);
  const entry = mkEntry({
    memory_id: "mem_T2",
    kind: "fact",
    ts: "2026-05-15T09:30:00Z",
    entities: ["alpha", "beta"],
    consent_basis: "third_party_inferred",
    derivation_distance: 2, // -> derivation_orphan=true
    valence: null,
    content: longContent,
  });
  const out = serializeCandidateForRerank({
    entry,
    score_components: mkScoreComponents(0.6),
  });

  // id passthrough (load-bearing: gemini-flash-client uses id as join key).
  assert.equal(out.id, "mem_T2");

  // Header field assertions.
  assert.ok(out.content.startsWith("id=mem_T2 "), "header must start with id=");
  assert.ok(out.content.includes("kind=fact"), "missing kind=");
  assert.ok(out.content.includes("ts=2026-05-15T09:30:00Z"), "missing ts=");
  assert.ok(out.content.includes("entities=[alpha,beta]"), "missing entities=[...]");
  assert.ok(
    out.content.includes("consent_basis=third_party_inferred"),
    "missing consent_basis="
  );
  assert.ok(
    out.content.includes("derivation_orphan=true"),
    "derivation_distance != null must yield derivation_orphan=true"
  );
  // Null valence rendered as the LITERAL string "null".
  assert.ok(out.content.includes("valence=null"), "null valence must render as literal null");

  // Truncation: count chars AFTER the header newline. The content excerpt
  // section starts after the first "\n" following the header colon.
  const newlineIdx = out.content.indexOf("\n");
  assert.ok(newlineIdx > 0, "header/content separator newline missing");
  const excerpt = out.content.slice(newlineIdx + 1);
  assert.equal(
    excerpt.length,
    CAPS.RECALL_RERANK_CONTENT_EXCERPT_CHARS,
    `excerpt must be exactly ${CAPS.RECALL_RERANK_CONTENT_EXCERPT_CHARS} chars (got ${excerpt.length})`
  );
  // No ellipsis discipline: truncation is opaque.
  assert.ok(!excerpt.endsWith("..."), "excerpt must not end with ellipsis");
});

// Sub-assertion: derivation_distance null -> derivation_orphan=false; non-null
// numeric valence rendered as numeric literal.
check("T2b: serializeCandidateForRerank renders non-orphan + numeric valence", () => {
  const entry = mkEntry({
    memory_id: "mem_T2b",
    derivation_distance: null,
    valence: -0.3,
  });
  const out = serializeCandidateForRerank({
    entry,
    score_components: mkScoreComponents(),
  });
  assert.ok(out.content.includes("derivation_orphan=false"), "expected derivation_orphan=false");
  assert.ok(out.content.includes("valence=-0.3"), "expected valence=-0.3 literal");
});

// ---------------------------------------------------------------------------
// T3: rerankCandidates happy path. Mock returns a known reordering of 5 ids;
// assert top-5 sorted by mock rank_score with rerank_position assigned.
// ---------------------------------------------------------------------------
await checkAsync("T3: rerankCandidates happy path with mocked Flash", async () => {
  setKey(VALID_FAKE_KEY);
  const pool = mkInputPool(5);

  // Mock: invert the order — assign higher rank_score to LOWER-final_score ids.
  // The pool has mem_001..mem_005 with final_score desc; we make Flash say
  // mem_005 is best (rank_score=0.95) down to mem_001 worst (0.10).
  const mockScores = {
    mem_001: 0.10,
    mem_002: 0.25,
    mem_003: 0.55,
    mem_004: 0.80,
    mem_005: 0.95,
  };
  let callCount = 0;
  let receivedInstruction = null;
  let receivedCandidates = null;
  const mockGenerate = async ({ instruction, candidates }) => {
    callCount += 1;
    receivedInstruction = instruction;
    receivedCandidates = candidates;
    return candidates
      .map((c) => ({ id: c.id, rank_score: mockScores[c.id] }))
      .sort((a, b) => b.rank_score - a.rank_score);
  };

  const result = await rerankCandidates({
    surrounding_context: SURROUNDING,
    candidates_with_scores: pool,
    opts: { now: FIXED_NOW, _generateRanking: mockGenerate },
  });

  assert.equal(callCount, 1, "mock must be invoked exactly once");
  assert.equal(receivedCandidates.length, 5, "all 5 candidates forwarded to Flash");
  assert.ok(
    receivedInstruction.includes("Rank these candidate memories"),
    "mock should receive built instruction"
  );

  assert.equal(result.degraded, false, "degraded must be false on happy path");
  assert.equal(result.rerank_failed_reason, null, "no failure reason on happy path");
  assert.ok(
    typeof result.layer3_latency_ms === "number" && result.layer3_latency_ms >= 0,
    "layer3_latency_ms must be a non-negative number"
  );

  // Output is bounded by RECALL_RERANK_OUTPUT_SIZE (12); for 5 inputs we get 5.
  assert.equal(result.reranked.length, 5, "reranked length must equal input pool size");

  // Top order driven by mock rank_score desc.
  assert.deepEqual(
    result.reranked.map((r) => r.memory_id),
    ["mem_005", "mem_004", "mem_003", "mem_002", "mem_001"],
    "reranked memory_id order must match descending rank_score"
  );
  // rerank_position 0..N-1 matches array index.
  for (let i = 0; i < result.reranked.length; i += 1) {
    assert.equal(result.reranked[i].rerank_position, i, `rerank_position[${i}] mismatch`);
  }
  // rerank_score round-trip from the mock.
  assert.equal(result.reranked[0].rerank_score, 0.95);
  assert.equal(result.reranked[4].rerank_score, 0.10);
});

// ---------------------------------------------------------------------------
// T4: Partial response (CRITICAL-1 post round-19 fix). Mock returns ranking
// for 3 of 5 ids; omitted ids receive min-explicit-score MINUS epsilon, so
// they rank BELOW every explicitly-scored id. The previous median-fill
// semantics inverted Flash's signal: Flash chose to omit some candidates;
// the gate must not lift them above candidates Flash explicitly scored low.
// ---------------------------------------------------------------------------
await checkAsync("T4: partial response -> floor-fill, omitted below all explicit", async () => {
  setKey(VALID_FAKE_KEY);
  const pool = mkInputPool(5);
  // Mock returns only 3 ids with rank_scores [0.2, 0.5, 0.9].
  // mem_002 and mem_004 are omitted -> they get min(0.2, 0.5, 0.9) - 1e-6
  // = 0.199999 -> rank BELOW the lowest explicit score (mem_001 at 0.2).
  const returnedSubset = [
    { id: "mem_001", rank_score: 0.2 },
    { id: "mem_003", rank_score: 0.5 },
    { id: "mem_005", rank_score: 0.9 },
  ];
  const mockGenerate = async () =>
    returnedSubset.slice().sort((a, b) => b.rank_score - a.rank_score);

  const result = await rerankCandidates({
    surrounding_context: SURROUNDING,
    candidates_with_scores: pool,
    opts: { _generateRanking: mockGenerate },
  });

  assert.equal(result.degraded, false, "partial response is NOT degraded");
  assert.equal(result.rerank_failed_reason, null);
  // No silent disappearance — all 5 inputs survive.
  assert.equal(result.reranked.length, 5, "all 5 inputs must survive partial response");

  // Locate the omitted ids in the output and confirm floor-fill.
  const byId = new Map(result.reranked.map((r) => [r.memory_id, r]));
  const MIN_EXPLICIT = 0.2;
  const FLOOR_FILL_EPSILON = 1e-6;
  const FLOOR = MIN_EXPLICIT - FLOOR_FILL_EPSILON;
  assert.equal(byId.get("mem_002").rerank_score, FLOOR, "mem_002 must get floor-fill rerank_score (below min explicit)");
  assert.equal(byId.get("mem_004").rerank_score, FLOOR, "mem_004 must get floor-fill rerank_score (below min explicit)");
  // Returned ids keep their explicit scores.
  assert.equal(byId.get("mem_001").rerank_score, 0.2);
  assert.equal(byId.get("mem_003").rerank_score, 0.5);
  assert.equal(byId.get("mem_005").rerank_score, 0.9);

  // Order: mem_005 (0.9) > mem_003 (0.5) > mem_001 (0.2) > mem_002,mem_004
  // (both at FLOOR). The two floor-tied entries tiebreak by final_score desc.
  assert.equal(result.reranked[0].memory_id, "mem_005", "highest rank_score first");
  assert.equal(result.reranked[1].memory_id, "mem_003", "0.5 second");
  assert.equal(result.reranked[2].memory_id, "mem_001", "0.2 third (lowest EXPLICIT)");
  // mem_002 and mem_004 (both FLOOR) come after every explicitly-scored id.
  const tail = [result.reranked[3].memory_id, result.reranked[4].memory_id];
  assert.ok(tail.includes("mem_002") && tail.includes("mem_004"),
    "floor-filled omitted ids must rank below every explicitly-scored id");
});

// ---------------------------------------------------------------------------
// T5: Timeout. Mock delays past opts.timeoutMs -> degraded=true with
// rerank_failed_reason="timeout".
// ---------------------------------------------------------------------------
await checkAsync("T5: timeout -> degraded with reason=timeout", async () => {
  setKey(VALID_FAKE_KEY);
  const pool = mkInputPool(5);
  // Mock that never resolves within the timeout budget. We use a 1500ms
  // delay against a 50ms test timeout for headroom.
  const mockGenerate = () =>
    new Promise((resolve) =>
      setTimeout(() => resolve([{ id: "mem_001", rank_score: 0.5 }]), 1500)
    );

  const result = await rerankCandidates({
    surrounding_context: SURROUNDING,
    candidates_with_scores: pool,
    opts: { timeoutMs: 50, _generateRanking: mockGenerate },
  });

  assert.equal(result.degraded, true, "timeout must produce degraded=true");
  assert.equal(
    result.rerank_failed_reason,
    "timeout",
    "rerank_failed_reason must be 'timeout'"
  );
  // Degraded path: sort by final_score desc, all rerank_score=null.
  for (const r of result.reranked) {
    assert.equal(r.rerank_score, null, "degraded items must have rerank_score=null");
  }
  // First by final_score: mem_001 (final_score=1.0 by builder).
  assert.equal(result.reranked[0].memory_id, "mem_001");
  // Latency populated even on failure.
  assert.ok(
    typeof result.layer3_latency_ms === "number" && result.layer3_latency_ms >= 0,
    "layer3_latency_ms still populated on timeout"
  );
});

// ---------------------------------------------------------------------------
// T6: Malformed response. Mock throws a parse-shape error -> degraded with
// reason=malformed_response.
// ---------------------------------------------------------------------------
await checkAsync("T6: malformed response -> degraded with reason=malformed_response", async () => {
  setKey(VALID_FAKE_KEY);
  const pool = mkInputPool(5);
  // Use one of the message substrings _classifyError recognizes.
  const mockGenerate = async () => {
    throw new Error("gemini-flash-client: response JSON missing ranking[] array");
  };

  const result = await rerankCandidates({
    surrounding_context: SURROUNDING,
    candidates_with_scores: pool,
    opts: { _generateRanking: mockGenerate },
  });

  assert.equal(result.degraded, true, "malformed response must be degraded");
  assert.equal(
    result.rerank_failed_reason,
    "malformed_response",
    "reason must be 'malformed_response'"
  );
  assert.equal(result.reranked.length, 5);
  for (const r of result.reranked) {
    assert.equal(r.rerank_score, null);
  }
});

// ---------------------------------------------------------------------------
// T7: GEMINI_API_KEY missing -> degraded with reason=api_key_missing. Mock
// is provided but MUST NOT be invoked (the short-circuit fires before any
// Flash call).
// ---------------------------------------------------------------------------
await checkAsync("T7: missing GEMINI_API_KEY -> degraded without POSTing", async () => {
  setKey(""); // empty string is treated as missing per gemini-flash-client.
  const pool = mkInputPool(5);
  let callCount = 0;
  const mockGenerate = async () => {
    callCount += 1;
    return [];
  };

  const result = await rerankCandidates({
    surrounding_context: SURROUNDING,
    candidates_with_scores: pool,
    opts: { _generateRanking: mockGenerate },
  });

  assert.equal(callCount, 0, "Flash mock MUST NOT be invoked when API key missing");
  assert.equal(result.degraded, true);
  assert.equal(result.rerank_failed_reason, "api_key_missing");
  assert.equal(result.layer3_latency_ms, 0, "no latency when never POSTed");
  // Degraded path still surfaces a candidate set sorted by final_score.
  assert.equal(result.reranked.length, 5);
  assert.equal(result.reranked[0].memory_id, "mem_001");

  // Restore for subsequent tests.
  setKey(VALID_FAKE_KEY);
});

// ---------------------------------------------------------------------------
// T8: Zero-input case. rerankCandidates([], ...) returns reranked=[],
// degraded=false, latency=0. Mock provided but MUST NOT be invoked.
// ---------------------------------------------------------------------------
await checkAsync("T8: zero-input -> trivial success", async () => {
  setKey(VALID_FAKE_KEY);
  let callCount = 0;
  const mockGenerate = async () => {
    callCount += 1;
    return [];
  };
  const result = await rerankCandidates({
    surrounding_context: SURROUNDING,
    candidates_with_scores: [],
    opts: { _generateRanking: mockGenerate },
  });
  assert.equal(callCount, 0, "no Flash call on empty input");
  assert.deepEqual(result.reranked, []);
  assert.equal(result.degraded, false);
  assert.equal(result.layer3_latency_ms, 0);
  assert.equal(result.rerank_failed_reason, null);
  // Round-19 CRITICAL-4 audit-provenance fields are emitted unconditionally.
  // instruction_hash is null on zero-input (no instruction was built).
  assert.equal(result.rerank_instruction_hash, null,
    "rerank_instruction_hash null when no instruction was built");
  assert.equal(typeof result.rerank_caps_snapshot, "object");
  assert.ok(result.rerank_caps_snapshot !== null,
    "rerank_caps_snapshot always emitted (never null)");
  assert.equal(typeof result.rerank_model_version, "string");
  assert.ok(result.rerank_model_version.length > 0,
    "rerank_model_version always emitted (matches CAPS.GEMINI_FLASH_MODEL_DEFAULT)");
});

// ---------------------------------------------------------------------------
// T-salience block (R25 salience-integration). Five sub-cases:
//
//   T-S1: serializeCandidateForRerank emits "salience=<f3>" inside the
//         header parenthesized field list, immediately after valence=.
//   T-S2: Layer-2 final_score reflects salience^alpha multiplier (delegated
//         to multi-feature-score.computeScore; here we assert the rerank
//         path passes the scored components through unchanged).
//   T-S3: buildRerankInstruction includes the 6th Flash rule
//         "6. PREFER salience >= 0.6 when other features tie."
//   T-S4: legacy row (no features.salience) serializes to salience=0.500 +
//         the _resolveSalienceScore helper returns source="legacy_no_score".
//   T-S5: features.salience.weights_hash mismatch -> caps_drift=true on
//         the helper return; the stored score is still used verbatim.
// ---------------------------------------------------------------------------
const { _resolveSalienceScore } = rerankMod;

check("T-S1: serialize emits salience=<f3> after valence in header", () => {
  const entry = mkEntry({
    memory_id: "mem_TS1",
    features: { salience: { score: 0.875, weights_hash: "deadbeef", version: "v1" } },
  });
  const out = serializeCandidateForRerank({
    entry,
    score_components: mkScoreComponents(),
  });
  assert.ok(out.content.includes("valence=null, salience=0.875"),
    "salience=<f3> must immediately follow valence= in header");
  // Header still terminates with "):" before the content excerpt newline.
  const newlineIdx = out.content.indexOf("\n");
  assert.ok(newlineIdx > 0, "header/content separator newline missing");
  const header = out.content.slice(0, newlineIdx);
  assert.ok(header.endsWith("):"), "header must still end with '):'");
  // Exactly 3 decimals (no more, no fewer) — toFixed(3) discipline.
  assert.ok(/salience=\d\.\d{3}\)/.test(header),
    `salience must be 3-decimal float; got header: ${header}`);
});

await checkAsync("T-S2: Layer-2 multiplier reflected through to rerank path", async () => {
  // Two candidates, identical except for features.salience.score. Same
  // final_score on input means the rerank pass-through is a no-op; the
  // multiplier semantic lives in multi-feature-score.computeScore (verified
  // via _resolveSalienceScore unit) and the test below verifies the
  // serialized header conveys the differential to Flash.
  setKey(VALID_FAKE_KEY);
  const high = mkCandidateWithScore({
    memory_id: "mem_HS",
    features: { salience: { score: 0.95, weights_hash: null, version: "v1" } },
  }, 0.5);
  const low = mkCandidateWithScore({
    memory_id: "mem_LS",
    features: { salience: { score: 0.10, weights_hash: null, version: "v1" } },
  }, 0.5);
  let receivedCandidates = null;
  const mockGenerate = async ({ candidates }) => {
    receivedCandidates = candidates;
    return candidates.map((c) => ({ id: c.id, rank_score: 0.5 }));
  };
  await rerankCandidates({
    surrounding_context: SURROUNDING,
    candidates_with_scores: [high, low],
    opts: { _generateRanking: mockGenerate, now: FIXED_NOW },
  });
  assert.equal(receivedCandidates.length, 2);
  const highSerialized = receivedCandidates.find((c) => c.id === "mem_HS").content;
  const lowSerialized = receivedCandidates.find((c) => c.id === "mem_LS").content;
  assert.ok(highSerialized.includes("salience=0.950"),
    "high-salience candidate serialized with salience=0.950");
  assert.ok(lowSerialized.includes("salience=0.100"),
    "low-salience candidate serialized with salience=0.100");
});

check("T-S3: buildRerankInstruction includes 6th Flash rule", () => {
  const out = buildRerankInstruction({
    surrounding_context: SURROUNDING,
    candidates: [],
    opts: { now: FIXED_NOW },
  });
  assert.ok(
    out.includes("6. PREFER salience >= 0.6 when other features tie."),
    "instruction must include the 6th Flash rule verbatim"
  );
  // Original 5 rules still present (no regression).
  assert.ok(out.includes("1. PREFER"));
  assert.ok(out.includes("5. SUPPRESS"));
});

check("T-S4: legacy row (no features.salience) renders 0.500 + source=legacy_no_score", () => {
  // Two flavors of legacy: features absent entirely, or features without salience.
  const legacyA = mkEntry({ memory_id: "mem_LEGA" }); // no .features at all
  const legacyB = mkEntry({
    memory_id: "mem_LEGB",
    features: { embedding_768: [0.1, 0.2] }, // features present but no .salience
  });
  for (const entry of [legacyA, legacyB]) {
    const out = serializeCandidateForRerank({
      entry,
      score_components: mkScoreComponents(),
    });
    assert.ok(out.content.includes("salience=0.500"),
      `legacy row ${entry.memory_id} must default salience=0.500`);
  }
  const resolvedA = _resolveSalienceScore(legacyA);
  assert.equal(resolvedA.score, 0.5);
  assert.equal(resolvedA.source, "legacy_no_score");
  assert.equal(resolvedA.caps_drift, false);
  const resolvedB = _resolveSalienceScore(legacyB);
  assert.equal(resolvedB.source, "legacy_no_score");
});

check("T-S5: weights_hash mismatch -> caps_drift=true, stored score preserved", () => {
  // Force a known weights hash via direct CAPS mutation is forbidden (frozen);
  // instead drive the comparison side by stamping a stored hash and reading
  // the current CAPS hash off the exports. If CAPS.SALIENCE_WEIGHTS_V1_HASH
  // isn't populated yet (A6 hasn't landed), the function falls back to
  // caps_drift=false — assert that contract too.
  const currentHash =
    typeof CAPS.SALIENCE_WEIGHTS_V1_HASH === "string"
      ? CAPS.SALIENCE_WEIGHTS_V1_HASH
      : null;

  // Case 5a: CAPS hash present + stored hash mismatch -> drift true.
  if (currentHash != null) {
    const driftEntry = mkEntry({
      memory_id: "mem_DRIFT",
      features: {
        salience: { score: 0.73, weights_hash: "ffffffffffffffff", version: "v1" },
      },
    });
    const r = _resolveSalienceScore(driftEntry);
    assert.equal(r.score, 0.73, "stored score must be preserved across drift");
    assert.equal(r.source, "scored_drifted",
      "mismatched weights_hash must yield source=scored_drifted");
    assert.equal(r.caps_drift, true, "caps_drift must be true on hash mismatch");

    // Matching-hash case -> no drift.
    const matchEntry = mkEntry({
      memory_id: "mem_MATCH",
      features: {
        salience: { score: 0.42, weights_hash: currentHash, version: "v1" },
      },
    });
    const r2 = _resolveSalienceScore(matchEntry);
    assert.equal(r2.score, 0.42);
    assert.equal(r2.source, "scored");
    assert.equal(r2.caps_drift, false, "matching weights_hash must yield caps_drift=false");
  } else {
    // Case 5b: CAPS hash absent (A6 hasn't landed yet) -> caps_drift defaults
    // to false because we can't detect drift. Stored score still preserved.
    const e = mkEntry({
      memory_id: "mem_NOCAPS",
      features: {
        salience: { score: 0.61, weights_hash: "anyhash", version: "v1" },
      },
    });
    const r = _resolveSalienceScore(e);
    assert.equal(r.score, 0.61);
    assert.equal(r.caps_drift, false,
      "CAPS hash absent -> caps_drift defaults to false (cannot detect drift)");
  }
});

await checkAsync("T-S6: rerank caps snapshot carries salience triple (or null fallbacks)", async () => {
  setKey(VALID_FAKE_KEY);
  const pool = mkInputPool(2);
  const mockGenerate = async ({ candidates }) =>
    candidates.map((c, i) => ({ id: c.id, rank_score: 0.5 - i * 0.01 }));
  const result = await rerankCandidates({
    surrounding_context: SURROUNDING,
    candidates_with_scores: pool,
    opts: { _generateRanking: mockGenerate, now: FIXED_NOW },
  });
  assert.ok(result.rerank_caps_snapshot !== null);
  assert.ok(
    "SALIENCE_VERSION" in result.rerank_caps_snapshot,
    "caps_snapshot must surface SALIENCE_VERSION key (value may be null pre-A6)"
  );
  assert.ok(
    "SALIENCE_WEIGHTS_V1_HASH" in result.rerank_caps_snapshot,
    "caps_snapshot must surface SALIENCE_WEIGHTS_V1_HASH key (value may be null pre-A6)"
  );
  assert.ok(
    "SALIENCE_ALPHA" in result.rerank_caps_snapshot,
    "caps_snapshot must surface SALIENCE_ALPHA key (value may be null pre-A6)"
  );
});

// ---------------------------------------------------------------------------
// F1 (memperf) K-block: key-pool resolution at the rerank gate.
// ---------------------------------------------------------------------------

// K1: pool-only env (GEMINI_API_KEYS plural, singular UNSET) must rerank.
// FAILS pre-fix: the old gate read only process.env.GEMINI_API_KEY and
// degraded with api_key_missing under the production pool-only env.
await checkAsync("K1: pool-only GEMINI_API_KEYS env -> backend invoked, not degraded", async () => {
  setKeys(
    "AIzaFAKE_pool_a_xxxxxxxxxxxxxxxxxxxxxxxxx,AIzaFAKE_pool_b_xxxxxxxxxxxxxxxxxxxxxxxxx"
  );
  const pool = mkInputPool(3);
  let callCount = 0;
  const stub = async ({ candidates }) => {
    callCount += 1;
    return candidates.map((c, i) => ({ id: c.id, rank_score: 0.9 - i * 0.1 }));
  };
  const result = await rerankCandidates({
    surrounding_context: SURROUNDING,
    candidates_with_scores: pool,
    opts: { now: FIXED_NOW, _generateRanking: stub },
  });
  assert.equal(callCount, 1, "ranking backend MUST be invoked under pool-only env");
  assert.equal(result.degraded, false, "pool-only env must NOT degrade");
  assert.equal(result.rerank_failed_reason, null);
});

// K2: neither env var set -> gate degrades, backend never invoked, zero
// latency. (Regression twin of T7 under the pool-backed gate.)
await checkAsync("K2: neither key env var -> degraded api_key_missing, backend never invoked", async () => {
  clearAllKeys();
  const pool = mkInputPool(3);
  let callCount = 0;
  const stub = async () => {
    callCount += 1;
    return [];
  };
  const result = await rerankCandidates({
    surrounding_context: SURROUNDING,
    candidates_with_scores: pool,
    opts: { _generateRanking: stub },
  });
  assert.equal(callCount, 0, "backend MUST NOT be invoked with no key configured");
  assert.equal(result.degraded, true);
  assert.equal(result.rerank_failed_reason, "api_key_missing");
  assert.equal(result.layer3_latency_ms, 0, "no latency when never POSTed");
});

// K3: legacy singular-only env still works (degenerate 1-key pool).
await checkAsync("K3: legacy singular-only GEMINI_API_KEY still reranks", async () => {
  setKey(VALID_FAKE_KEY);
  const pool = mkInputPool(3);
  let callCount = 0;
  const stub = async ({ candidates }) => {
    callCount += 1;
    return candidates.map((c, i) => ({ id: c.id, rank_score: 0.8 - i * 0.1 }));
  };
  const result = await rerankCandidates({
    surrounding_context: SURROUNDING,
    candidates_with_scores: pool,
    opts: { _generateRanking: stub },
  });
  assert.equal(callCount, 1, "backend must be invoked under legacy singular env");
  assert.equal(result.degraded, false);
  assert.equal(result.rerank_failed_reason, null);
});

// ---------------------------------------------------------------------------
// F1 (memperf) L-block: loud degrade — exactly one stderr line per DISTINCT
// reason per process. FAILS pre-fix: zero lines were ever emitted.
// L1 (api_key_missing twice -> 1 line) and L2 (http_500 twice -> 1 more
// line) run in ONE process pass so the once-per-reason Set is exercised
// across two distinct reasons (total exactly 2 DEGRADED lines).
// ---------------------------------------------------------------------------
await checkAsync("L1+L2: degrades emit exactly one stderr line per distinct reason", async () => {
  clearAllKeys();
  _resetRerankDegradeLogForTests();
  const pool = mkInputPool(3);
  const captured = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (chunk, ..._rest) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    // L1: two api_key_missing degrades.
    for (let i = 0; i < 2; i += 1) {
      const r = await rerankCandidates({
        surrounding_context: SURROUNDING,
        candidates_with_scores: pool,
        opts: { _generateRanking: async () => [] },
      });
      assert.equal(r.rerank_failed_reason, "api_key_missing");
    }
    const degradedLines = () =>
      captured.filter((l) => l.includes("memory-recall rerank: DEGRADED"));
    const akLines = degradedLines().filter((l) => l.includes("reason=api_key_missing"));
    assert.equal(
      akLines.length,
      1,
      `expected exactly 1 api_key_missing line, got ${akLines.length}`
    );

    // L2: two http_500 degrades (env mutation emits a gemini-client pool-load
    // line to the patched stderr; we count only DEGRADED lines).
    setKey(VALID_FAKE_KEY);
    const throwing500 = async () => {
      throw Object.assign(new Error("boom"), { statusCode: 500 });
    };
    for (let i = 0; i < 2; i += 1) {
      const r = await rerankCandidates({
        surrounding_context: SURROUNDING,
        candidates_with_scores: pool,
        opts: { _generateRanking: throwing500 },
      });
      assert.equal(r.rerank_failed_reason, "http_500");
    }
    const all = degradedLines();
    assert.equal(
      all.length,
      2,
      `expected exactly 2 DEGRADED lines total (1 per distinct reason), got ${all.length}: ${JSON.stringify(all)}`
    );
    assert.equal(
      all.filter((l) => l.includes("reason=http_500")).length,
      1,
      "expected exactly 1 http_500 line"
    );
  } finally {
    process.stderr.write = realWrite;
  }
});

// ---------------------------------------------------------------------------
// F1 (memperf) A1: the rerank timeout must ABORT the signal handed to the
// ranking backend (real cancellation, not just a Promise.race walk-away).
// FAILS pre-fix: no signal was passed to the backend at all.
// ---------------------------------------------------------------------------
await checkAsync("A1: timeout aborts the AbortSignal handed to the backend", async () => {
  setKey(VALID_FAKE_KEY);
  let capturedSignal = null;
  const neverResolves = ({ signal }) => {
    capturedSignal = signal;
    return new Promise(() => {});
  };
  const result = await rerankCandidates({
    surrounding_context: SURROUNDING,
    candidates_with_scores: mkInputPool(3),
    opts: { timeoutMs: 25, _generateRanking: neverResolves },
  });
  assert.equal(result.degraded, true, "timeout must degrade");
  assert.equal(result.rerank_failed_reason, "timeout");
  assert.ok(capturedSignal != null, "backend must receive an AbortSignal");
  assert.equal(
    capturedSignal.aborted,
    true,
    "the signal handed to the backend must be aborted after the timeout fires"
  );
});

// ---------------------------------------------------------------------------
// E1 (memperf followup, 2026-07-17): entity-heavy candidates must never exceed
// the flash client's MAX_CANDIDATE_CONTENT_CHARS validation cap.
// LATENT SINCE R33, surfaced live by F1's loud-degrade detail line:
//   "generateRanking: candidates[0].content exceeds 600 chars"
// serializeCandidateForRerank capped the excerpt (400) but joined entities
// UNBOUNDED into the header, so chat-log facts with dozens of entities threw
// inside generateRanking BEFORE any HTTP call -> every such recall degraded
// internal_error at 0ms. RED pre-fix: content length 1825 for a 40-entity row.
// ---------------------------------------------------------------------------
check("E1: entity-heavy candidate content stays within the flash validation cap", () => {
  const hostile = {
    memory_id: "mem_hostile_entities",
    kind: "chat_message",
    ts: "2026-07-17T00:00:00Z",
    entities: Array.from({ length: 40 }, (_, i) => `person:very-long-entity-name-${i}`),
    content: "x".repeat(1000),
  };
  const c = serializeCandidateForRerank({ entry: hostile });
  assert.ok(
    c.content.length <= CAPS.RECALL_BRIEF_MAX_CHARS_PER_ITEM,
    `candidate content ${c.content.length} chars exceeds the flash cap ` +
      `${CAPS.RECALL_BRIEF_MAX_CHARS_PER_ITEM} — generateRanking would throw pre-HTTP`
  );
  assert.equal(c.id, "mem_hostile_entities", "join-key id must be preserved");
  assert.ok(
    c.content.startsWith("id=mem_hostile_entities "),
    "header id= prefix must survive the hard cap (the model reads it)"
  );
  assert.ok(c.content.includes(",+32]"), "entity overflow marker present");
});

await checkAsync("E2: entity-heavy pool reranks through the REAL generateRanking validation", async () => {
  setKey(VALID_FAKE_KEY);
  // Real generateRanking with fetch mocked: validation runs (the pre-fix
  // throw site), then the mocked HTTP returns a valid ranking.
  const realFetch = globalThis.fetch;
  const pool = mkInputPool(3).map((c, i) => ({
    ...c,
    candidate: {
      ...c.candidate,
      entities: Array.from({ length: 40 }, (_, j) => `person:e${i}-${j}`),
      content: "y".repeat(900),
    },
  }));
  const ids = pool.map((c) => c.candidate.memory_id);
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    ranking: ids.map((id, r) => ({ id, rank_score: 1 - r * 0.1 })),
                  }),
                },
              ],
            },
          },
        ],
      }),
  });
  try {
    const result = await rerankCandidates({
      surrounding_context: SURROUNDING,
      candidates_with_scores: pool,
      opts: {},
    });
    assert.equal(
      result.rerank_failed_reason,
      null,
      `must not degrade (got ${result.rerank_failed_reason}) — pre-fix this was internal_error from the validation throw`
    );
    assert.equal(result.degraded, false, "entity-heavy pool must rerank");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// Final tally.
// ---------------------------------------------------------------------------
restoreKey();

console.log("");
console.log(`rerank.test.mjs: ${passes} passed, ${failures} failed`);
if (failures > 0) {
  process.exit(1);
}
// RERANK_CONSTANTS sanity (introspection hook): match validation CAPS.
assert.equal(RERANK_CONSTANTS.RERANK_INPUT_SIZE, CAPS.RECALL_RERANK_INPUT_SIZE);
assert.equal(RERANK_CONSTANTS.RERANK_OUTPUT_SIZE, CAPS.RECALL_RERANK_OUTPUT_SIZE);
assert.equal(RERANK_CONSTANTS.RERANK_TIMEOUT_MS, CAPS.RECALL_RERANK_TIMEOUT_MS);
assert.equal(
  RERANK_CONSTANTS.RERANK_CONTENT_EXCERPT_CHARS,
  CAPS.RECALL_RERANK_CONTENT_EXCERPT_CHARS
);
