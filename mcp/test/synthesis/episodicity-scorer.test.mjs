// episodicity-scorer.test.mjs — Wave 5 substrate test for
// F-SYN-SUBSTRATE-EPISODICITY-SCORER. Recovered after Wave 5 DO agent
// died mid-response (API Error: Connection closed mid-response). The
// module was shipped to disk before the agent dropped; this file
// completes the missing test surface per the WU brief.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EPISODICITY_VERSION,
  W_ANCHOR,
  W_CORRO,
  W_GENERAL,
  W_VAL,
  W_INTERCEPT,
  scoreEpisodicity,
  computeFromFeatures,
  computeQueryEpisodicity,
  episodicityMatch,
  meanEntityGenerality,
} from "../../lib/synthesis/episodicity-scorer.js";

// ---------------------------------------------------------------
// CAPS contract — v0 PRIOR weights flagged as not-yet-measured.
// The values are hand-tuned per spec § 3.5 / O5 calibration deferral.
// ---------------------------------------------------------------

test("VERSION constant matches v0.1.0", () => {
  assert.equal(EPISODICITY_VERSION, "v0.1.0");
});

test("v0 PRIOR weights are the documented values (not yet re-fit by O5)", () => {
  assert.equal(W_ANCHOR, 1.2, "w_anchor — strongest episodic signal");
  assert.equal(W_CORRO, 0.4, "w_corro — log-saturated corroboration boost");
  assert.equal(W_GENERAL, 0.7, "w_general — topic-heavy collapse");
  assert.equal(W_VAL, 0.3, "w_val — amygdala-modulated affective encoding");
  assert.equal(W_INTERCEPT, -1.5, "intercept — semantic-leaning baseline");
});

// ---------------------------------------------------------------
// scoreEpisodicity — pure sigmoid over four numeric inputs
// ---------------------------------------------------------------

test("scoreEpisodicity: spec § 7.1 Robin iMessage (mildly episodic, ≈0.55–0.65)", () => {
  // has_time_anchor=true, corroboration=2, entity_generality=0.1 (person-dominant), valence_magnitude=0.4
  const ep = scoreEpisodicity({
    has_time_anchor: true,
    corroboration_count: 2,
    entity_generality: 0.1,
    narrative_valence_magnitude: 0.4,
  });
  assert.ok(ep > 0.5, `expected > 0.5 (mildly episodic), got ${ep}`);
  assert.ok(ep < 0.75, `expected < 0.75, got ${ep}`);
});

test("scoreEpisodicity: spec § 7.2 Wixted research-note (strongly semantic, ≈0.05–0.20)", () => {
  // No time anchor, no corroboration, generality=0.9 (topic-heavy), valence=0
  const ep = scoreEpisodicity({
    has_time_anchor: false,
    corroboration_count: 0,
    entity_generality: 0.9,
    narrative_valence_magnitude: 0,
  });
  assert.ok(ep < 0.2, `expected < 0.2 (strongly semantic), got ${ep}`);
  assert.ok(ep >= 0, `expected ≥ 0, got ${ep}`);
});

test("scoreEpisodicity: all-zeros → semantic baseline below 0.5", () => {
  const ep = scoreEpisodicity({
    has_time_anchor: false,
    corroboration_count: 0,
    entity_generality: 0,
    narrative_valence_magnitude: 0,
  });
  // z = W_INTERCEPT = -1.5 → sigmoid(-1.5) ≈ 0.182
  assert.ok(ep < 0.25, `expected < 0.25, got ${ep}`);
  assert.ok(ep > 0.1, `expected > 0.1, got ${ep}`);
});

test("scoreEpisodicity: all-maxed → high episodicity", () => {
  const ep = scoreEpisodicity({
    has_time_anchor: true,
    corroboration_count: 100,
    entity_generality: 0,
    narrative_valence_magnitude: 1,
  });
  assert.ok(ep > 0.85, `expected > 0.85 (episodic-dominant), got ${ep}`);
});

test("scoreEpisodicity: null/undefined input collapses to NEUTRAL 0.5", () => {
  assert.equal(scoreEpisodicity(null), 0.5);
  assert.equal(scoreEpisodicity(undefined), 0.5);
  assert.equal(scoreEpisodicity("not-an-object"), 0.5);
});

test("scoreEpisodicity: result always clamped to [0,1]", () => {
  const samples = [
    { has_time_anchor: true, corroboration_count: 1e9, entity_generality: 0, narrative_valence_magnitude: 1 },
    { has_time_anchor: false, corroboration_count: 0, entity_generality: 1, narrative_valence_magnitude: 0 },
    { has_time_anchor: true, corroboration_count: -50, entity_generality: 2, narrative_valence_magnitude: -1 },
  ];
  for (const s of samples) {
    const ep = scoreEpisodicity(s);
    assert.ok(ep >= 0 && ep <= 1, `clamp violated: ${ep} for input ${JSON.stringify(s)}`);
  }
});

test("scoreEpisodicity: NaN/Infinity inputs collapse defensively", () => {
  const ep = scoreEpisodicity({
    has_time_anchor: true,
    corroboration_count: Number.NaN,
    entity_generality: Number.POSITIVE_INFINITY,
    narrative_valence_magnitude: Number.NaN,
  });
  assert.ok(Number.isFinite(ep), `result must be finite, got ${ep}`);
  assert.ok(ep >= 0 && ep <= 1);
});

// ---------------------------------------------------------------
// computeFromFeatures — sugar over features blob
// ---------------------------------------------------------------

test("computeFromFeatures: reads time_anchors / entities / valence from features blob", () => {
  const ep = computeFromFeatures({
    time_anchors: [{ kind: "absolute", instant_iso: "2023-01-07T10:00:00Z" }],
    entities: [{ kind: "person" }, { kind: "place" }],
    valence: { source: "lexicon", sign: 1, magnitude: 0.5 },
    corroboration_count: 1,
  });
  assert.ok(ep > 0.5, `expected episodic-leaning given anchor + person/place + valence, got ${ep}`);
});

test("computeFromFeatures: null/missing → NEUTRAL", () => {
  assert.equal(computeFromFeatures(null), 0.5);
  assert.equal(computeFromFeatures(undefined), 0.5);
});

test("computeFromFeatures: low-confidence time anchor is skipped per spec § 5.1", () => {
  const epLow = computeFromFeatures({
    time_anchors: [{ kind: "absolute", instant_iso: "2023-01-07T10:00:00Z", extractor_confidence: 0.3 }],
    entities: [{ kind: "topic" }],
  });
  const epHigh = computeFromFeatures({
    time_anchors: [{ kind: "absolute", instant_iso: "2023-01-07T10:00:00Z", extractor_confidence: 0.9 }],
    entities: [{ kind: "topic" }],
  });
  assert.ok(epHigh > epLow, `high-confidence anchor should outscore low-confidence: ${epHigh} vs ${epLow}`);
});

// ---------------------------------------------------------------
// computeQueryEpisodicity — recall-time twin
// ---------------------------------------------------------------

test("computeQueryEpisodicity: reads from surrounding_context (no corroboration at v0 query side)", () => {
  const ep = computeQueryEpisodicity({
    time_anchors: [{ kind: "absolute", instant_iso: "2023-01-07T10:00:00Z" }],
    entities: [{ kind: "person" }],
    ambient: { inferred_mood: { source: "lexicon", magnitude: 0.5 } },
  });
  assert.ok(ep > 0.4, `expected episodic-leaning, got ${ep}`);
});

test("computeQueryEpisodicity: empty context → NEUTRAL or low-semantic baseline", () => {
  const ep = computeQueryEpisodicity({});
  assert.ok(ep >= 0 && ep <= 1, `expected finite scalar in [0,1], got ${ep}`);
});

test("computeQueryEpisodicity: null context → NEUTRAL", () => {
  assert.equal(computeQueryEpisodicity(null), 0.5);
  assert.equal(computeQueryEpisodicity(undefined), 0.5);
});

// ---------------------------------------------------------------
// episodicityMatch — the multi-feature score's multiplicative gate
// ---------------------------------------------------------------

test("episodicityMatch: identical → 1.0", () => {
  assert.equal(episodicityMatch(0.8, 0.8), 1.0);
});

test("episodicityMatch: 0.8 vs 0.2 → 0.4", () => {
  const m = episodicityMatch(0.8, 0.2);
  assert.ok(Math.abs(m - 0.4) < 1e-6, `expected 0.4, got ${m}`);
});

test("episodicityMatch: opposite extremes (0, 1) → 0", () => {
  assert.equal(episodicityMatch(0, 1), 0);
  assert.equal(episodicityMatch(1, 0), 0);
});

test("episodicityMatch: null fact_ep collapses directly to NEUTRAL 0.5", () => {
  // Per spec § 6.4: null fact gates as "ambiguous" → return 0.5.
  // Substitution-then-compute would erroneously give 1.0 when query is also 0.5.
  assert.equal(episodicityMatch(null, 0.5), 0.5);
  assert.equal(episodicityMatch(undefined, 0.8), 0.5);
});

test("episodicityMatch: null query_ep also → NEUTRAL", () => {
  assert.equal(episodicityMatch(0.7, null), 0.5);
});

test("episodicityMatch: symmetric (I-EPI-6)", () => {
  const a = episodicityMatch(0.3, 0.7);
  const b = episodicityMatch(0.7, 0.3);
  assert.equal(a, b);
});

// ---------------------------------------------------------------
// meanEntityGenerality helper — shared with the populator and the
// re-stamp pass; ENTITY_SPECIFICITY_PRIORS mirror is CI-cross-checked.
// ---------------------------------------------------------------

test("meanEntityGenerality: empty/null → null (caller substitutes NEUTRAL)", () => {
  assert.equal(meanEntityGenerality([]), null);
  assert.equal(meanEntityGenerality(null), null);
});

test("meanEntityGenerality: person-only is low generality (~0.1)", () => {
  const g = meanEntityGenerality([{ kind: "person" }]);
  assert.ok(g !== null && g < 0.2, `expected < 0.2, got ${g}`);
});

test("meanEntityGenerality: topic-only is high generality (~0.9)", () => {
  const g = meanEntityGenerality([{ kind: "topic" }]);
  assert.ok(g !== null && g > 0.8, `expected > 0.8, got ${g}`);
});

test("meanEntityGenerality: mixed kinds average correctly", () => {
  // person (gen=0.1) + topic (gen=0.9) → mean = 0.5
  const g = meanEntityGenerality([{ kind: "person" }, { kind: "topic" }]);
  assert.ok(g !== null && Math.abs(g - 0.5) < 0.01, `expected ~0.5, got ${g}`);
});

test("meanEntityGenerality: unknown kinds are skipped (defensive on bad upstream)", () => {
  const g = meanEntityGenerality([{ kind: "person" }, { kind: "alien" }]);
  // Only person counts → generality ≈ 0.1
  assert.ok(g !== null && g < 0.2, `expected ~0.1 (alien skipped), got ${g}`);
});
