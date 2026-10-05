// null-marker-scoreable.test.mjs — R5: re-embedded (drained) facts must be
// semantically scoreable despite the immutable fact row's null-embed marker.
//
// Context: distill-promote-fact.js:631-635 stamps null-promoted rows with
// {embedding_4096:null, embedding_3072:null, embed_state:true}; the ledger is
// immutable so the drain (reembed-local-4096.mjs) writes the vector ONLY into
// the sidecar/HNSW index. recall.js:2215-2225 hydrates that index vector into
// s_emb_full3072 at query time; the scorer must trust the hydrated vector and
// only route candidates with NO vector anywhere (s_emb_full3072 === 0) to the
// additive-only fallback.
//
// Hermetic discipline (C-NEW-2 pattern, standing): set MEMORY_ROOT and the
// POLICY/STORAGE/LEDGERS dirs to mkdtempSync paths BEFORE any dynamic import
// of memory-system modules. Pure fixtures only — no ledger reads, no I/O.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hermeticity: stake out tmp dirs and overwrite env BEFORE dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-nullmarker-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");

const { computeScore } = await import("../lib/recall/multi-feature-score.js");
const { CAPS } = await import("../lib/validation.js");

// Deterministic clock (opts.now), matching multi-feature-score.test.mjs T4.
const NOW_ISO = "2026-06-02T12:00:00Z";
const NOW_EPOCH = Date.parse(NOW_ISO);

function isoOffsetDays(days) {
  return new Date(NOW_EPOCH - days * 24 * 60 * 60 * 1000).toISOString();
}

function gatesOpen() {
  return {
    predicate_mask: 1,
    consent_dampener: CAPS.CONSENT_DAMPENER_FIRST_PARTY,
    derivation_status: CAPS.DERIVATION_STATUS_NORMAL,
  };
}

// The WU2 null-promote marker triple, exactly as stamped at
// distill-promote-fact.js:631-635 (and forwarded verbatim by rowToIndexEntry
// → recall.js:2288 candidate.features).
function nullMarkerFeatures() {
  return {
    embedding_4096: null,
    embedding_3072: null,
    embedding_mrl_768: null,
    embedding_model_version: null,
    embed_state: true,
  };
}

// A normal row-carried embedding (cascade PROMOTE with a live embed server):
// embedding_4096 present, embed_state false. computeScore never reads the
// vector itself — only the marker triple — so a small stand-in array is fine.
function rowEmbeddedFeatures() {
  return {
    embedding_4096: [0.1, 0.2, 0.3],
    embedding_3072: null,
    embedding_mrl_768: [0.1, 0.2],
    embedding_model_version: "qwen3-embedding-8b-fp16",
    embed_state: false,
  };
}

function candidateWith(features, overrides = {}) {
  return {
    memory_id: "mem_null_marker_fixture",
    kind: "fact",
    ts: NOW_ISO, // age 0 → power_law_decay = 1.0
    entities: [],
    valence: null,
    features,
    ...overrides,
  };
}

const EMPTY_CONTEXT = { entities: [], time_anchor: null, valence: null };

// ---------------------------------------------------------------------------
// (a) Null row marker + hydrated index vector (nonzero s_emb_full3072):
//     the semantic feature participates — multiplicative branch, truthful
//     telemetry, and final_score EQUAL to an otherwise-identical candidate
//     whose row carries the embedding.
// ---------------------------------------------------------------------------
test("(a) null-marker fact with hydrated index vector scores semantically", () => {
  const S_EMB = 0.83; // per the recall.js:2215-2225 contract: nonzero ⇒ a real vector was resolved

  const hydrated = computeScore({
    s_emb_full3072: S_EMB,
    gates: gatesOpen(),
    candidate: candidateWith(nullMarkerFeatures()),
    surrounding_context: EMPTY_CONTEXT,
    opts: { now: NOW_ISO },
  });

  assert.equal(hydrated.fallback_branch_used, false,
    "hydrated null-marker fact must NOT take the fallback branch");
  assert.equal(hydrated.had_embedding_at_recall, true,
    "telemetry must truthfully report an embedding at recall");
  assert.equal(hydrated.embedding_source, "fact_row",
    "no new embedding_source enum value — frozen 'fact_row'/'none' domain");
  assert.equal(hydrated.dropped_by_additive_floor, false,
    "the fallback-only additive floor must not apply");

  // Semantic participation, not short-circuited: multiplicative = 0.83 * 1 *
  // 1 * 1 * 1 (episodicity stub); additive = w_t2 * decay(0d)=0.3 only.
  const expected = S_EMB + CAPS.SCORE_WEIGHT_TIME_DECAY * 1.0;
  assert.ok(Math.abs(hydrated.final_score - expected) <= 1e-9,
    `final_score ${hydrated.final_score} must include the semantic term (expected ${expected})`);

  // Otherwise-identical candidate whose ROW carries the embedding: same
  // inputs, identical ScoreComponents — proves the marker no longer degrades
  // a hydrated fact relative to a row-embedded one.
  const rowEmbedded = computeScore({
    s_emb_full3072: S_EMB,
    gates: gatesOpen(),
    candidate: candidateWith(rowEmbeddedFeatures()),
    surrounding_context: EMPTY_CONTEXT,
    opts: { now: NOW_ISO },
  });
  assert.equal(hydrated.final_score, rowEmbedded.final_score,
    "hydrated null-marker fact must score EXACTLY like its row-embedded twin");
  assert.equal(rowEmbedded.embedding_source, "fact_row");
  assert.equal(rowEmbedded.fallback_branch_used, false);
});

// ---------------------------------------------------------------------------
// (b) Null row marker + NO vector anywhere (s_emb_full3072 === 0): the exact
//     pre-change additive-only fallback, including the additive-floor drop.
// ---------------------------------------------------------------------------
test("(b) null-marker fact with no vector keeps the exact prior fallback", () => {
  // b1 — above the floor: additive = 0.3 (decay@0d) ≥ 0.10 → survives on the
  // additive branch, fallback telemetry set.
  const aboveFloor = computeScore({
    s_emb_full3072: 0,
    gates: gatesOpen(),
    candidate: candidateWith(nullMarkerFeatures()),
    surrounding_context: EMPTY_CONTEXT,
    opts: { now: NOW_ISO },
  });
  assert.equal(aboveFloor.embedding_source, "none");
  assert.equal(aboveFloor.fallback_branch_used, true);
  assert.equal(aboveFloor.had_embedding_at_recall, false);
  assert.equal(aboveFloor.dropped_by_additive_floor, false);
  const expectedAdditive =
    CAPS.SCORE_WEIGHT_TIME_DECAY * 1.0 +
    CAPS.SCORE_WEIGHT_DAMPING_PRIOR * 1.0 +
    CAPS.SCORE_WEIGHT_CORROBORATION_PRIOR * 1.0;
  assert.ok(Math.abs(aboveFloor.final_score - expectedAdditive) <= 1e-9,
    `additive-only final_score expected ${expectedAdditive}, got ${aboveFloor.final_score}`);

  // b2 — below the floor: ambient kind at 30 days decays hard enough that
  // additive < RECALL_ADDITIVE_FLOOR_FALLBACK → dropped, final_score 0.
  const decay30dAmbient = Math.pow(31, -CAPS.POWER_LAW_F_AMBIENT);
  const additiveB2 =
    CAPS.SCORE_WEIGHT_TIME_DECAY * decay30dAmbient +
    CAPS.SCORE_WEIGHT_DAMPING_PRIOR * 1.0 +
    CAPS.SCORE_WEIGHT_CORROBORATION_PRIOR * 1.0;
  assert.ok(additiveB2 < CAPS.RECALL_ADDITIVE_FLOOR_FALLBACK,
    `fixture precondition: additive ${additiveB2} must sit below the floor ` +
    `${CAPS.RECALL_ADDITIVE_FLOOR_FALLBACK}`);

  const belowFloor = computeScore({
    s_emb_full3072: 0,
    gates: gatesOpen(),
    candidate: candidateWith(nullMarkerFeatures(), {
      kind: "ambient",
      ts: isoOffsetDays(30),
    }),
    surrounding_context: EMPTY_CONTEXT,
    opts: { now: NOW_ISO },
  });
  assert.equal(belowFloor.embedding_source, "none");
  assert.equal(belowFloor.fallback_branch_used, true);
  assert.equal(belowFloor.dropped_by_additive_floor, true,
    "RECALL_ADDITIVE_FLOOR_FALLBACK drop must still fire for no-vector facts");
  assert.equal(belowFloor.final_score, 0,
    "dropped fallback candidates zero out exactly as before");
});

// ---------------------------------------------------------------------------
// (c) Normally-embedded candidates: ScoreComponents byte-identical to the
//     pre-change contract (mirrors multi-feature-score.test.mjs T4-A).
// ---------------------------------------------------------------------------
test("(c) normal candidates keep unchanged ScoreComponents", () => {
  const expectations = (score) => {
    assert.equal(score.embedding_source, "fact_row");
    assert.equal(score.had_embedding_at_recall, true);
    assert.equal(score.fallback_branch_used, false);
    assert.equal(score.dropped_by_additive_floor, false);
    assert.equal(score.predicate_mask, 1);
    assert.equal(score.consent_dampener, CAPS.CONSENT_DAMPENER_FIRST_PARTY);
    assert.equal(score.derivation_status, CAPS.DERIVATION_STATUS_NORMAL);
    assert.equal(score.episodicity_match, 1.0);
    assert.equal(score.entity_overlap_jaccard, 0);
    assert.equal(score.time_anchor_match, 0);
    assert.equal(score.power_law_decay, 1.0);
    assert.equal(score.valence_compat, 0);
    assert.equal(score.engagement_prior, 0);
    assert.equal(score.damping_coefficient, 1.0);
    assert.equal(score.corroboration_boost, 1.0);
    assert.equal(score.salience_source, "legacy_no_score");
    assert.equal(score.salience_multiplier, 1.0);
    const expected = 0.9 + CAPS.SCORE_WEIGHT_TIME_DECAY * 1.0 +
      CAPS.SCORE_WEIGHT_DAMPING_PRIOR * 1.0 +
      CAPS.SCORE_WEIGHT_CORROBORATION_PRIOR * 1.0;
    assert.ok(Math.abs(score.final_score - expected) <= 1e-9,
      `T4-A-equivalent final_score expected ${expected}, got ${score.final_score}`);
  };

  // c1 — row-carried embedding_4096 present (embed_state false).
  expectations(computeScore({
    s_emb_full3072: 0.9,
    gates: gatesOpen(),
    candidate: candidateWith(rowEmbeddedFeatures()),
    surrounding_context: EMPTY_CONTEXT,
    opts: { now: NOW_ISO },
  }));

  // c2 — legacy row lacking embed_state entirely (features null): the marker
  // predicate is false, index-overlay path pre-dates R5 and is unchanged.
  expectations(computeScore({
    s_emb_full3072: 0.9,
    gates: gatesOpen(),
    candidate: candidateWith(null),
    surrounding_context: EMPTY_CONTEXT,
    opts: { now: NOW_ISO },
  }));
});

// ---------------------------------------------------------------------------
// Cleanup.
// ---------------------------------------------------------------------------
test.after(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});
