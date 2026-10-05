// stage0-screentime-real-stream-names.test.mjs
//
// R25.7 CRIT-A5 reconciliation: verifies the ScreenTime Stage-0 rule fires
// against the ZSTREAMNAME / raw_content.stream values macOS knowledgeC emits
// (the stream names themselves are fixed by the OS schema, not by any one
// user's data). The R25 design specified "/discoverability/signals"
// — this test pins that the literal rule matches *only* that stream and
// PASSes the other 5 common streams, so a future refactor that
// (e.g.) widens the rule to a regex over a category prefix breaks loudly.
//
// HERMETIC: synthetic event objects only; no real knowledgeC.db reads; no
// filesystem touches. Mirrors stage0-modules.test.mjs structure.
//
// The six common knowledgeC streams this test covers:
//   "/discoverability/signals"  — only stream the rule fires on
//   "/app/intents"               — substantive app/intent data, PASS
//   "/notification/usage"        — notification surface, PASS
//   "/app/usage"                 — first-party app use, PASS
//   "/app/mediaUsage"            — first-party media playback, PASS
//   "/app/webUsage"              — first-party browser use, PASS
//
// Note: "/discoverability/signals" is typically the single largest stream, so
// this one literal rule accounts for most ScreenTime Stage-0 drops; the
// earlier design's drop-band estimate was an extrapolation from a small
// sample. See kb/salience-design.md § Empirical Justification (R25.7 footnote).

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// Synthetic operator identity, resolved once at operator-identity.js load, so
// it is set before the first library import.
process.env.MEMORY_OPERATOR_IDENTITY_FILE = fileURLToPath(
  new URL("../fixtures/operator-identity.synthetic.json", import.meta.url),
);

const { stage0: screentimeStage0 } = await import("../../lib/ingest/stage0/screentime.js");

let passed = 0;
function ok(msg) { passed++; console.log(`  ok ${msg}`); }

console.log("# stage0/screentime.js — common stream-name fixtures (R25.7)");

// Fixture rows mirror the actual on-disk row shape (raw_content.stream),
// one per common knowledgeC stream.
const FIXTURES = [
  {
    label: "/discoverability/signals (top by count)",
    stream: "/discoverability/signals",
    expectDecision: "DROP",
    expectReason: "discoverability_signals",
  },
  {
    label: "/app/intents (Siri intent donations)",
    stream: "/app/intents",
    expectDecision: "PASS",
    expectReason: null,
  },
  {
    label: "/notification/usage (notification interactions)",
    stream: "/notification/usage",
    expectDecision: "PASS",
    expectReason: null,
  },
  {
    label: "/app/usage (foreground/background app sessions)",
    stream: "/app/usage",
    expectDecision: "PASS",
    expectReason: null,
  },
  {
    label: "/app/mediaUsage (audio/video playback)",
    stream: "/app/mediaUsage",
    expectDecision: "PASS",
    expectReason: null,
  },
  {
    label: "/app/webUsage (Safari browsing summary)",
    stream: "/app/webUsage",
    expectDecision: "PASS",
    expectReason: null,
  },
];

for (const fx of FIXTURES) {
  const event = {
    source: "screentime",
    raw_content: {
      stream: fx.stream,
      // Other fields are intentionally omitted; the Stage-0 rule reads only
      // raw_content.stream / raw_content.ZSTREAMNAME.
    },
  };
  const r = screentimeStage0(event);
  assert.strictEqual(
    r.decision, fx.expectDecision,
    `${fx.label}: expected decision=${fx.expectDecision}, got ${r.decision}`,
  );
  assert.strictEqual(
    r.reason, fx.expectReason,
    `${fx.label}: expected reason=${fx.expectReason}, got ${r.reason}`,
  );
  ok(`${fx.label} → ${fx.expectDecision}${fx.expectReason ? " " + fx.expectReason : ""}`);
}

// Defensive: confirm the rule does NOT fire on near-miss stream names.
// (e.g., missing leading slash, plural, sibling category) — these should
// PASS so the Stage-0 rule remains as specified in the design and any
// future widening is an explicit edit, not silent.
const NEAR_MISSES = [
  "discoverability/signals",       // missing leading slash
  "/discoverability/signal",        // singular
  "/discoverability/signals/x",     // sub-stream
  "/discoverability",               // parent only
  "DISCOVERABILITY/SIGNALS",        // wrong case
];
for (const stream of NEAR_MISSES) {
  const r = screentimeStage0({ source: "screentime", raw_content: { stream } });
  assert.strictEqual(
    r.decision, "PASS",
    `near-miss ${JSON.stringify(stream)}: expected PASS, got ${r.decision}`,
  );
}
ok("near-miss stream names (missing slash, singular, sub-stream, wrong case) → PASS");

// Defensive: confirm the ZSTREAMNAME fallback still works when the source
// row uses the legacy column name (the connector pre-R23 wrote ZSTREAMNAME
// directly; later runs normalise to `stream`). The rule reads
// raw_content.stream first, falling back to raw_content.ZSTREAMNAME.
{
  const r = screentimeStage0({
    source: "screentime",
    raw_content: { ZSTREAMNAME: "/discoverability/signals" },
  });
  assert.strictEqual(r.decision, "DROP");
  assert.strictEqual(r.reason, "discoverability_signals");
}
ok("ZSTREAMNAME fallback fires DROP on legacy-shape row");

console.log(`\n# PASS ${passed}/${passed}`);
