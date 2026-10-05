// n2-classifier.test.mjs — WORKUNIT N2 regression suite for the L2 addressing
// classifier (mcp/lib/messaging/classifier.js + N1 fixtures/).
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions. No DB, no
// network, no daemon, no filesystem writes — reads only the N1 fixture corpus +
// the classifier source text (for the agnosticism / no-adapter-import greps).
// Hermetic and fast (<2s); imports NO adapter (proving the classifier is
// authorable/testable with no connector on disk).
//
// What this suite proves (mapped to N2 TESTS A1-A14 + REVIEW R1-R8):
//   A1  every N1 fixture -> well-formed result, no throw.
//   A2  is_from_me short-circuit beats all channels (R6).
//   A3  dm prior vs group asymmetry (MAP Q6).
//   A4  GATE CORE: reply_to_available true vs false -> measurable score delta.
//   A5  mention-only on reply-unavailable platform: weight shifts in, not down (R3).
//   A6  reply_to_me null vs false (cap true both) differ; null emits no reply reason (R5).
//   A7  addressed_to_me gated by addressing_first_class (R8, MAP Q5).
//   A8  weight conservation: Σ active weights_used === W (R4).
//   A9  self_identity_reliable false down-weights a mention-driven score (MAP Q4).
//   A10 all channels dead (group, all null) -> score≈0, no NaN (DO §3).
//   A11 determinism + input not mutated (R7).
//   A12 combinatorial sweep: every score ∈ [0,1], never NaN/Infinity (R4).
//   A13 grep platform tokens over classifier.js === 0 (R1, half the GATE).
//   A14 grep connectors import over classifier.js === 0 (R2).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  classifyDirectedAtMe,
  CLASSIFIER_CAPS,
  MODEL_VERSION,
  W,
  REASONS,
  getClassifierTelemetry,
  resetClassifierTelemetry,
} from "../../lib/messaging/classifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(__dirname, "../../lib/messaging");
const FIXTURES_DIR = path.join(LIB_DIR, "fixtures");
const CLASSIFIER_SRC = path.join(LIB_DIR, "classifier.js");

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, rel), "utf8"));
}

const PLATFORM_FIXTURES = ["whatsapp", "imessage", "mail", "telegram"];

// Build a synthetic envelope from explicit signal/capability blocks. We do NOT
// route through validateEnvelope here on purpose: several tests exercise NULL
// signals ("platform cannot tell"), which the classifier handles defensively
// even though N1's strict-boolean validator would not pass them. The classifier
// must be a TOTAL function over the looser input domain.
function synth({
  thread_type = "group",
  is_from_me = false,
  mention_me = null,
  reply_to_me = null,
  addressed_to_me = null,
  reply_to_available = false,
  structured_mentions = false,
  self_identity_reliable = false,
  addressing_first_class = false,
} = {}) {
  return {
    platform: "synthetic_source", // NOTE: never read by the classifier.
    thread_id: "t1",
    thread_type,
    sender: { id: "s1", name: null },
    recipients: ["user"],
    is_from_me,
    ts: 1700000000000,
    content: "x",
    mentions: [],
    directed_at_me_signals: { mention_me, reply_to_me, addressed_to_me },
    capabilities: {
      reply_to_available,
      structured_mentions,
      self_identity_reliable,
      addressing_first_class,
    },
    source_msg_id: "m1",
  };
}

function isWellFormedResult(r) {
  return (
    r
    && typeof r === "object"
    && typeof r.score === "number"
    && Number.isFinite(r.score)
    && r.score >= 0
    && r.score <= 1
    && typeof r.directed === "boolean"
    && Array.isArray(r.reasons)
    && r.reasons.every((t) => typeof t === "string")
    && r.signals
    && typeof r.signals === "object"
    && r.weights_used
    && typeof r.weights_used === "object"
    && r.model_version === MODEL_VERSION
  );
}

// --- A1 — every N1 fixture envelope classifies into a well-formed result. ----
test("A1: every N1 fixture -> well-formed result, no throw", () => {
  for (const p of PLATFORM_FIXTURES) {
    const fx = readJson(`${p}.fixture.json`);
    const r = classifyDirectedAtMe(fx.expected_envelope);
    assert.equal(isWellFormedResult(r), true, `${p} -> well-formed result`);
    // No platform-name leakage into the agnostic reasons vocabulary.
    for (const tok of r.reasons) {
      assert.equal(
        /whatsapp|imessage|telegram|mail|jid|chat_guid/i.test(tok),
        false,
        `${p} reason token "${tok}" must be platform-agnostic`,
      );
    }
  }
});

// --- A2 — is_from_me short-circuit beats every channel (R6). -----------------
test("A2: is_from_me=true short-circuits to score 0 regardless of signals", () => {
  const env = synth({
    is_from_me: true,
    thread_type: "dm",
    mention_me: true,
    reply_to_me: true,
    addressed_to_me: true,
    reply_to_available: true,
    structured_mentions: true,
    self_identity_reliable: true,
    addressing_first_class: true,
  });
  const r = classifyDirectedAtMe(env);
  assert.equal(r.score, 0, "outbound message scores 0");
  assert.equal(r.directed, false, "outbound message is not directed-at-me");
  assert.deepEqual(
    r.reasons,
    [REASONS.IS_FROM_ME_SHORTCIRCUIT],
    "only the short-circuit reason is emitted",
  );
});

// --- A3 — dm prior vs group asymmetry (MAP Q6). ------------------------------
test("A3: bare dm scores the DM prior; bare group scores ~0 (asymmetry)", () => {
  const dm = classifyDirectedAtMe(synth({ thread_type: "dm" }));
  const group = classifyDirectedAtMe(synth({ thread_type: "group" }));
  assert.ok(
    Math.abs(dm.score - CLASSIFIER_CAPS.DM_PRIOR) < 1e-9,
    `bare dm scores DM_PRIOR (got ${dm.score})`,
  );
  assert.equal(dm.directed, true, "bare dm is directed (prior at threshold)");
  assert.ok(group.score < 1e-9, `bare group scores ~0 (got ${group.score})`);
  assert.equal(group.directed, false, "bare group is not directed");
});

// --- A4 — GATE CORE: reply_to_available true vs false -> measurable delta. ----
test("A4: GATE CORE — capability bit-flip moves the score (delta>0)", () => {
  const base = {
    thread_type: "group",
    reply_to_me: true,
    // Hold a second active channel so redistribution has somewhere to move
    // weight when reply_to_me goes dead — making the delta observable.
    mention_me: true,
    structured_mentions: true,
    self_identity_reliable: true,
  };
  const withReply = classifyDirectedAtMe(
    synth({ ...base, reply_to_available: true }),
  );
  const withoutReply = classifyDirectedAtMe(
    synth({ ...base, reply_to_available: false }),
  );
  const delta = Math.abs(withReply.score - withoutReply.score);
  assert.ok(delta > 1e-9, `capability flip must move the score (delta=${delta})`);
  // The reply-available variant must announce the reply evidence; the
  // unavailable variant must announce the redistribution instead.
  assert.equal(withReply.reasons.includes(REASONS.REPLY_TO_ME), true);
  assert.equal(
    withoutReply.reasons.includes(REASONS.REPLY_TO_UNAVAILABLE_REDISTRIBUTED),
    true,
  );
});

// --- A5 — absence != negative: redistribution shifts weight INTO mention. -----
test("A5: mention-only on reply-unavailable platform is not depressed; weight shifts in", () => {
  // Same mention evidence, two platforms. Platform B has reply_to_available
  // but reply_to_me=false (a KNOWN negative); platform A has reply_to_available
  // false (UNKNOWN -> redistributed). A's mention channel must carry MORE
  // effective weight than B's, and A's score must not be lower than B's.
  const common = {
    thread_type: "group",
    mention_me: true,
    structured_mentions: true,
    self_identity_reliable: true,
  };
  const aRedistributed = classifyDirectedAtMe(
    synth({ ...common, reply_to_available: false, reply_to_me: null }),
  );
  const bKnownNegative = classifyDirectedAtMe(
    synth({ ...common, reply_to_available: true, reply_to_me: false }),
  );
  assert.ok(
    aRedistributed.weights_used.mention_me
      > bKnownNegative.weights_used.mention_me + 1e-9,
    "redistribution shifts weight INTO the surviving mention channel",
  );
  assert.ok(
    aRedistributed.score >= bKnownNegative.score - 1e-9,
    "the can't-tell platform is not scored lower than the known-negative one",
  );
});

// --- A6 — null vs false reply_to_me differ (cap true both) (R5). -------------
test("A6: reply_to_me null vs false produce different scores; null emits no reply reason", () => {
  const common = {
    thread_type: "group",
    mention_me: true,
    structured_mentions: true,
    self_identity_reliable: true,
    reply_to_available: true,
  };
  const nullReply = classifyDirectedAtMe(synth({ ...common, reply_to_me: null }));
  const falseReply = classifyDirectedAtMe(
    synth({ ...common, reply_to_me: false }),
  );
  assert.notEqual(
    nullReply.score,
    falseReply.score,
    "null (unknown -> redistribute) must differ from false (known-negative)",
  );
  // null -> reply channel dead, no positive reply reason, mention carries more.
  assert.equal(nullReply.reasons.includes(REASONS.REPLY_TO_ME), false);
  // null should score HIGHER than false here: false keeps a 0-valued channel in
  // the active set (depressing the normalized mention), null redistributes it.
  assert.ok(
    nullReply.score > falseReply.score,
    `null path should not be depressed by a phantom negative (null=${nullReply.score} false=${falseReply.score})`,
  );
});

// --- A7 — addressed_to_me gated by addressing_first_class (R8, MAP Q5). -------
test("A7: addressed_to_me contributes ZERO without first-class addressing; dominates with it", () => {
  const off = classifyDirectedAtMe(
    synth({
      thread_type: "group",
      addressed_to_me: true,
      addressing_first_class: false,
    }),
  );
  // No first-class addressing AND no other signal -> all channels dead -> ~0.
  assert.ok(
    off.score < 1e-9,
    `addressed_to_me must not count without the capability (got ${off.score})`,
  );
  assert.equal(off.reasons.includes(REASONS.ADDRESSED_TO_ME), false);

  const on = classifyDirectedAtMe(
    synth({
      thread_type: "group",
      addressed_to_me: true,
      addressing_first_class: true,
    }),
  );
  assert.ok(
    on.score > off.score + 0.4,
    `first-class addressing dominates (on=${on.score} off=${off.score})`,
  );
  assert.equal(on.reasons.includes(REASONS.ADDRESSED_TO_ME), true);
  assert.equal(on.directed, true, "first-class addressed message is directed");
});

// --- A8 — weight conservation: Σ active weights_used === conservedTotal (R4). -
// Conservation law with PARTIAL redistribution: the active partition's weights
// sum to (activeNominal + FRACTION × deadNominal) — exactly the recoverable
// mass, never more (no leak) and never less (no loss beyond the forfeit). When
// nothing is dead this equals W. The forfeited (1-FRACTION)×deadNominal is the
// measurable evidence-capacity loss that powers the A4 gate delta.
test("A8: sum of active weights_used === conservedTotal across random combos", () => {
  const tri = [true, false, null];
  const bool = [true, false];
  const NOMINAL = CLASSIFIER_CAPS.WEIGHTS;
  const FRAC = CLASSIFIER_CAPS.REDISTRIBUTION_FRACTION;
  const channelKeys = ["addressed_to_me", "reply_to_me", "mention_me"];
  let checked = 0;
  // Deterministic enumeration over a fixed slice of the combo space.
  for (const m of tri)
    for (const rep of tri)
      for (const adr of tri)
        for (const rca of bool)
          for (const aca of bool) {
            const r = classifyDirectedAtMe(
              synth({
                thread_type: "group",
                mention_me: m,
                reply_to_me: rep,
                addressed_to_me: adr,
                reply_to_available: rca,
                addressing_first_class: aca,
                structured_mentions: true,
                self_identity_reliable: true,
              }),
            );
            const sum = channelKeys.reduce(
              (s, k) => s + (r.weights_used[k] ?? 0),
              0,
            );
            // Recompute the expected conserved total independently: which
            // channels are active is a pure function of the inputs.
            const activeNominal =
              (aca && adr !== null ? NOMINAL.addressed_to_me : 0)
              + (rca && rep !== null ? NOMINAL.reply_to_me : 0)
              + (m !== null ? NOMINAL.mention_me : 0);
            const deadNominal = W - activeNominal;
            const expected =
              activeNominal <= 1e-9
                ? 0
                : activeNominal + deadNominal * FRAC;
            assert.ok(
              Math.abs(sum - expected) < 1e-9,
              `Σ active weights_used (${sum}) must equal conservedTotal (${expected})`,
            );
            checked += 1;
          }
  assert.ok(checked >= 50, `swept ${checked} combos (>=50)`);
});

// --- A9 — self_identity_reliable false down-weights mention-driven score. -----
test("A9: unreliable self-identity lowers a mention-driven score + emits reason", () => {
  const common = {
    thread_type: "group",
    mention_me: true,
    structured_mentions: true,
  };
  const reliable = classifyDirectedAtMe(
    synth({ ...common, self_identity_reliable: true }),
  );
  const unreliable = classifyDirectedAtMe(
    synth({ ...common, self_identity_reliable: false }),
  );
  assert.ok(
    unreliable.score < reliable.score,
    `masked self-id down-weights mention (unreliable=${unreliable.score} reliable=${reliable.score})`,
  );
  assert.equal(
    unreliable.reasons.includes(REASONS.SELF_IDENTITY_UNRELIABLE_DOWNWEIGHTED),
    true,
  );
  assert.equal(
    reliable.reasons.includes(REASONS.SELF_IDENTITY_UNRELIABLE_DOWNWEIGHTED),
    false,
  );
});

// --- A10 — all channels dead, group thread -> ~0, no NaN (DO §3). ------------
test("A10: all signals null on a group -> score ~0, directed false, no NaN", () => {
  const r = classifyDirectedAtMe(
    synth({
      thread_type: "group",
      mention_me: null,
      reply_to_me: null,
      addressed_to_me: null,
    }),
  );
  assert.equal(Number.isFinite(r.score), true, "finite score");
  assert.ok(r.score < 1e-9, `degenerate group scores ~0 (got ${r.score})`);
  assert.equal(r.directed, false);
  assert.equal(r.reasons.includes(REASONS.ALL_CHANNELS_DEAD), true);
});

// --- A11 — determinism + input not mutated (R7). -----------------------------
test("A11: classifying twice is deep-equal; input envelope is not mutated", () => {
  const env = synth({
    thread_type: "channel",
    mention_me: true,
    reply_to_me: true,
    reply_to_available: true,
    structured_mentions: true,
    self_identity_reliable: true,
  });
  const before = structuredClone(env);
  const r1 = classifyDirectedAtMe(env);
  const r2 = classifyDirectedAtMe(env);
  assert.deepEqual(r1, r2, "same input -> deep-equal output (deterministic)");
  assert.deepEqual(env, before, "input envelope is not mutated (pure)");
});

// --- A12 — combinatorial sweep: every score ∈ [0,1], never NaN/Infinity. ------
test("A12: total-function safety over the full signal×capability combo space", () => {
  const tri = [true, false, null];
  const bool = [true, false];
  const threads = ["dm", "group", "channel", "bogus", undefined];
  let count = 0;
  for (const tt of threads)
    for (const m of tri)
      for (const rep of tri)
        for (const adr of tri)
          for (const rca of bool)
            for (const sca of bool)
              for (const sir of bool)
                for (const aca of bool) {
                  const r = classifyDirectedAtMe(
                    synth({
                      thread_type: tt,
                      mention_me: m,
                      reply_to_me: rep,
                      addressed_to_me: adr,
                      reply_to_available: rca,
                      structured_mentions: sca,
                      self_identity_reliable: sir,
                      addressing_first_class: aca,
                    }),
                  );
                  assert.equal(
                    Number.isFinite(r.score) && r.score >= 0 && r.score <= 1,
                    true,
                    `score must be finite ∈[0,1] (tt=${tt} got ${r.score})`,
                  );
                  count += 1;
                }
  assert.ok(count > 100, `swept ${count} combos`);
});

// --- A12b — fully malformed / non-object input degrades, never throws. --------
test("A12b: garbage input (non-object / missing blocks) degrades to a safe score", () => {
  for (const junk of [null, undefined, 42, "x", [], {}]) {
    const r = classifyDirectedAtMe(junk);
    assert.equal(isWellFormedResult(r), true, `junk ${String(junk)} -> safe result`);
    assert.ok(r.score >= 0 && r.score <= 1);
  }
});

// --- A13 — platform-token grep over classifier.js === 0 (R1, GATE half). ------
test("A13: classifier.js contains ZERO platform tokens (agnosticism gate)", () => {
  const src = readFileSync(CLASSIFIER_SRC, "utf8");
  const re = /whatsapp|imessage|telegram|\bmail\b|jid|chat_guid|@g\.us|@s\.whatsapp|@lid|cache_roomnames/gi;
  const matches = src.match(re) || [];
  assert.equal(
    matches.length,
    0,
    `classifier.js must carry no platform token; found: ${JSON.stringify(matches)}`,
  );
});

// --- A14 — no adapter/connector import over classifier.js === 0 (R2). --------
test("A14: classifier.js imports NO adapter/connector", () => {
  const src = readFileSync(CLASSIFIER_SRC, "utf8");
  const importsConnector = /from\s+['"][^'"]*connectors[^'"]*['"]/i.test(src);
  const importsAdapter = /from\s+['"][^'"]*adapters[^'"]*['"]/i.test(src);
  assert.equal(importsConnector, false, "no connectors import");
  assert.equal(importsAdapter, false, "no adapters import");
});

// --- A15 — telemetry is an observation side-channel (does not affect score). --
test("A15: telemetry counts degraded paths without altering the pure score", () => {
  resetClassifierTelemetry();
  const env = synth({
    thread_type: "group",
    mention_me: true,
    self_identity_reliable: false,
    structured_mentions: false,
  });
  const r1 = classifyDirectedAtMe(env);
  const t1 = getClassifierTelemetry();
  const r2 = classifyDirectedAtMe(env);
  assert.deepEqual(r1, r2, "score is stable across telemetry accumulation");
  assert.ok(
    t1.self_identity_downweighted >= 1 && t1.unstructured_downweighted >= 1,
    "degraded paths are counted",
  );
  resetClassifierTelemetry();
  const t2 = getClassifierTelemetry();
  assert.equal(t2.self_identity_downweighted, 0, "reset zeroes telemetry");
});
