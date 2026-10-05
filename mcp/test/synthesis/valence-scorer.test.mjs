// valence-scorer.test.mjs — tests for the v0 lexicon-based valence scorer.
//
// Asserts the surface contract specified in WU-valence-scorer-impl AND
// the spec invariants from docs/specs/synthesis/valence-provenance.md:
//   - sign ∈ {-1, 0, +1}; magnitude ∈ [0, 1].
//   - source ∈ {'lexicon', 'model'} (v0 only emits 'lexicon').
//   - model_version is a non-empty string.
//   - sign === 0 IFF magnitude === 0 (I4 sign-magnitude consistency).
//   - Deterministic: same input → same output (I10).
//
// Run: node test/synthesis/valence-scorer.test.mjs
// Exits 0 on pass, non-zero on any failure.

import assert from "node:assert/strict";
import {
  scoreValence,
  MODEL_VERSION,
  VALENCE_SCORER_CAPS,
  overlayLexicons,
  getValenceTelemetry,
  resetValenceTelemetry,
} from "../../lib/synthesis/valence-scorer.js";

let failures = 0;
let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${label}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL  ${label}: ${e.message}`);
  }
}

// --- Required cases from the workunit -----------------------------------

check("'I love this' → sign=+1, magnitude > 0.3", () => {
  const v = scoreValence("I love this thing very much");
  assert.equal(v.sign, 1);
  assert.ok(
    v.magnitude > 0.3,
    `expected magnitude > 0.3, got ${v.magnitude}`,
  );
  assert.equal(v.source, "lexicon");
  assert.equal(v.model_version, MODEL_VERSION);
});

check("'I hate that' → sign=-1", () => {
  const v = scoreValence("I hate that broken garbage");
  assert.equal(v.sign, -1);
  assert.ok(v.magnitude > 0, "negative input should have non-zero magnitude");
  assert.equal(v.source, "lexicon");
});

check("'The weather is nice today' → sign=+1, low magnitude", () => {
  const v = scoreValence("The weather is nice today");
  assert.equal(v.sign, 1);
  // 'nice' is one hit among ~3 meaningful tokens (weather, nice, today) →
  // 1/sqrt(3) ≈ 0.577. Confirm it's still in low-magnitude territory
  // (not saturated near 1).
  assert.ok(v.magnitude < 0.8, `expected low-ish magnitude, got ${v.magnitude}`);
  assert.ok(v.magnitude > 0, "should not collapse to 0");
});

check(
  "plain iMessage-style sentence 'I said I would stop by later to drop something off' → neutral",
  () => {
    const v = scoreValence(
      "I said I would stop by later to drop something off",
    );
    // No lexicon hits → must collapse to absent / neutral.
    assert.equal(v.sign, 0);
    assert.equal(v.magnitude, 0);
  },
);

check("Empty input → sign=0", () => {
  const v = scoreValence("");
  assert.equal(v.sign, 0);
  assert.equal(v.magnitude, 0);
  assert.equal(v.source, "lexicon");
  assert.equal(v.model_version, MODEL_VERSION);
});

// --- Spec invariants ----------------------------------------------------

check("whitespace-only input → neutral", () => {
  const v = scoreValence("   \n\t  ");
  assert.equal(v.sign, 0);
  assert.equal(v.magnitude, 0);
});

check("sign-magnitude consistency invariant (I4)", () => {
  // For a battery of inputs, sign === 0 IFF magnitude === 0.
  const inputs = [
    "",
    "We walked over to the depot and counted the crates",
    "the weather is nice today",
    "I hate everything about this",
    "love love love",
    "good good bad bad",
    "merge conflict resolved cleanly",
  ];
  for (const text of inputs) {
    const v = scoreValence(text);
    const signZero = v.sign === 0;
    const magZero = v.magnitude === 0;
    assert.equal(
      signZero,
      magZero,
      `invariant violated for "${text}": sign=${v.sign}, magnitude=${v.magnitude}`,
    );
  }
});

check("magnitude is always in [0, 1]", () => {
  const inputs = [
    "love love love love love love love love love love",
    "hate hate hate hate hate hate hate hate hate hate",
    "amazing wonderful great fantastic excellent brilliant perfect",
    "terrible horrible awful worst broken stupid useless",
    "",
    "neutral words here",
  ];
  for (const text of inputs) {
    const v = scoreValence(text);
    assert.ok(v.magnitude >= 0, `magnitude < 0: ${v.magnitude} for "${text}"`);
    assert.ok(v.magnitude <= 1, `magnitude > 1: ${v.magnitude} for "${text}"`);
  }
});

check("sign is always in {-1, 0, +1}", () => {
  const inputs = ["", "love", "hate", "the weather is nice", "garbage broken"];
  for (const text of inputs) {
    const v = scoreValence(text);
    assert.ok(
      v.sign === -1 || v.sign === 0 || v.sign === 1,
      `bad sign ${v.sign} for "${text}"`,
    );
  }
});

check("source is always 'lexicon' in v0", () => {
  const inputs = ["", "I love this", "I hate that", "neutral content here"];
  for (const text of inputs) {
    const v = scoreValence(text);
    assert.equal(v.source, "lexicon");
  }
});

check("model_version is a non-empty string on every output", () => {
  const inputs = ["", "love", "hate", "ambiguous neutral content"];
  for (const text of inputs) {
    const v = scoreValence(text);
    assert.equal(typeof v.model_version, "string");
    assert.ok(v.model_version.length > 0);
    assert.equal(v.model_version, MODEL_VERSION);
  }
});

check("determinism: same input yields the same output (I10)", () => {
  const text = "I love this great fantastic amazing thing";
  const a = scoreValence(text);
  const b = scoreValence(text);
  const c = scoreValence(text);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

check("balanced positive/negative collapses toward neutral", () => {
  // 'great' + 'terrible' have roughly equal magnitude; net should be small
  // enough to fall under the sign threshold.
  const v = scoreValence("the meeting was great but the result was terrible");
  // Net = 0 hits cancel → sign=0, magnitude=0.
  assert.equal(v.sign, 0);
  assert.equal(v.magnitude, 0);
});

check("non-string input throws TypeError (spec F1)", () => {
  assert.throws(() => scoreValence(null), TypeError);
  assert.throws(() => scoreValence(undefined), TypeError);
  assert.throws(() => scoreValence(42), TypeError);
  assert.throws(() => scoreValence({}), TypeError);
  assert.throws(() => scoreValence(["love"]), TypeError);
});

check("punctuation does not break the tokenizer", () => {
  const v = scoreValence("I love this!!! It's great!!!");
  assert.equal(v.sign, 1);
  assert.ok(v.magnitude > 0);
});

check("mixed case is normalized to lowercase", () => {
  const v1 = scoreValence("I LOVE this thing");
  const v2 = scoreValence("i love this thing");
  assert.deepEqual(v1, v2);
});

check("strong negative phrase produces sign=-1 and meaningful magnitude", () => {
  const v = scoreValence("I am frustrated and angry and this is wrong");
  assert.equal(v.sign, -1);
  assert.ok(v.magnitude > 0.3, `expected magnitude > 0.3, got ${v.magnitude}`);
});

check("single positive lexicon token in long neutral text yields low magnitude", () => {
  const v = scoreValence(
    "the meeting was scheduled for tuesday and that should work great for everybody",
  );
  // One hit ('great') across many tokens → magnitude should be < 0.5.
  assert.equal(v.sign, 1);
  assert.ok(v.magnitude < 0.5, `expected dilute magnitude, got ${v.magnitude}`);
});

check("output shape matches the workunit contract", () => {
  const v = scoreValence("I love this");
  // Required keys present; no unexpected keys.
  const keys = Object.keys(v).sort();
  assert.deepEqual(keys, ["magnitude", "model_version", "sign", "source"]);
  assert.equal(typeof v.sign, "number");
  assert.equal(typeof v.magnitude, "number");
  assert.equal(typeof v.source, "string");
  assert.equal(typeof v.model_version, "string");
});

check("very short input (below MIN_TOKEN_THRESHOLD) collapses to neutral", () => {
  // After stopword strip, "love" alone is one meaningful token.
  const v = scoreValence("love");
  assert.equal(v.sign, 0);
  assert.equal(v.magnitude, 0);
});

check("'thanks' alone in greeting yields positive sign", () => {
  const v = scoreValence("thanks so much for the help today");
  assert.equal(v.sign, 1);
  assert.ok(v.magnitude > 0);
});

// --- substrate-minor-polish (#2) -----------------------------------------

check("CAPS exported + frozen", () => {
  assert.equal(typeof VALENCE_SCORER_CAPS, "object");
  assert.ok(Object.isFrozen(VALENCE_SCORER_CAPS), "CAPS frozen");
  assert.equal(VALENCE_SCORER_CAPS.SIGN_THRESHOLD, 0.05);
  assert.equal(VALENCE_SCORER_CAPS.MIN_TOKEN_THRESHOLD, 2);
  assert.equal(VALENCE_SCORER_CAPS.STRUCTURAL_OVERRIDE_THRESHOLD, 0.7);
});

check("overlayLexicons returns base sets when overlay is null/undefined", () => {
  const a = overlayLexicons(null);
  const b = overlayLexicons(undefined);
  assert.ok(a.positive instanceof Set);
  assert.ok(a.negative instanceof Set);
  assert.ok(b.positive.has("love"));
  assert.ok(b.negative.has("hate"));
});

check("overlayLexicons applies positive overlay tokens", () => {
  const { positive } = overlayLexicons({ positive: ["gizmo", "WIDGET"] });
  // Case-insensitive merge.
  assert.ok(positive.has("gizmo"), "gizmo added");
  assert.ok(positive.has("widget"), "WIDGET lowercased to widget");
  // Base tokens preserved.
  assert.ok(positive.has("love"), "love preserved");
});

check("overlayLexicons overlay-wins on conflict", () => {
  // 'love' is a base-positive. An overlay that puts it in negative should
  // remove it from positive and add it to negative.
  const { positive, negative } = overlayLexicons({ negative: ["love"] });
  assert.ok(!positive.has("love"), "love removed from positive");
  assert.ok(negative.has("love"), "love present in negative");
});

check("scoreValence with overlay flips polarity of base-positive token", () => {
  // A base-positive token re-mapped to negative via overlay should flip
  // sign in the output.
  const v = scoreValence("love love love love", { overlay: { negative: ["love"] } });
  assert.equal(v.sign, -1, "overlay flipped polarity");
  assert.ok(v.magnitude > 0);
});

check("structural override applies when confidence meets threshold", () => {
  resetValenceTelemetry();
  const v = scoreValence("anything at all goes here", {
    structural: { sign: -1, magnitude: 0.85, confidence: 0.95 },
  });
  assert.equal(v.sign, -1, "structural sign honored");
  assert.equal(v.magnitude, 0.85, "structural magnitude honored");
  const tel = getValenceTelemetry();
  assert.equal(tel.structural_override_applied, 1,
    "structural_override_applied counter incremented");
});

check("structural override ignored when confidence below threshold", () => {
  resetValenceTelemetry();
  const v = scoreValence("I love this thing very much", {
    structural: { sign: -1, magnitude: 0.85, confidence: 0.5 },
  });
  // Below CAPS.STRUCTURAL_OVERRIDE_THRESHOLD (0.7) — lexicon path runs.
  assert.equal(v.sign, 1, "lexicon path ran instead of structural override");
});

check("neutral_bias_emit telemetry distinguishes true-vs-defaulted", () => {
  resetValenceTelemetry();
  // Defaulted-neutral path: empty input.
  scoreValence("");
  // Defaulted-neutral path: too few meaningful tokens.
  scoreValence("the");
  // True-neutral path: meaningful tokens, no lexicon hits.
  scoreValence("the weather is gray and cold");
  const tel = getValenceTelemetry();
  assert.ok(tel.neutral_bias_emit_defaulted >= 2,
    `defaulted >= 2, got ${tel.neutral_bias_emit_defaulted}`);
  assert.ok(tel.neutral_bias_emit_true >= 1,
    `true-neutral >= 1, got ${tel.neutral_bias_emit_true}`);
});

check("balanced positive/negative collapses to true-neutral (not defaulted)", () => {
  resetValenceTelemetry();
  scoreValence("the meeting was great but the result was terrible");
  const tel = getValenceTelemetry();
  // Balanced means we measured but the net normalized score fell below
  // SIGN_THRESHOLD — that is a TRUE neutral, not a defaulted one.
  assert.ok(tel.neutral_bias_emit_true >= 1,
    "balanced cancellation registers as true-neutral");
});

check("backwards-compatible: scoreValence without opts still works", () => {
  // The new opts parameter is optional; legacy single-arg callers must
  // continue to function identically.
  const v = scoreValence("I love this thing very much");
  assert.equal(v.sign, 1);
  assert.ok(v.magnitude > 0);
  assert.equal(v.source, "lexicon");
  assert.equal(v.model_version, MODEL_VERSION);
});

// ------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
