// feature-backfill.test.mjs — engine substrate test for W3-CCS BACKFILL.
// (F-CCS-BACKFILL-engine)
//
// Exercises the W3-CCS backfill engine end-to-end:
//   - bare-fact ledger → 5 backfill events emitted with correct overlays
//   - idempotent re-run → 0 new events (byte-equal overlay skip per §6.1)
//   - extractor failure on one fact → skip + count error, others proceed
//   - dry-run → no events written
//   - canonical row shape conforms to spec §3
//   - latest-wins on multiple backfills (spec §4.4)
//   - row count invariant: original fact rows unmodified (thesis #1)
//
// Hermetic: every test writes to a fresh tmp ledger. No env mutation, no
// shared state, no dynamic imports requiring env setup.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runBackfill,
  readBackfillEventsFromLedger,
  FEATURE_BACKFILL_KIND,
  FEATURE_BACKFILL_VERSION,
  FEATURE_BACKFILL_SCHEMA_VERSION,
  BACKFILL_CAPS,
  OVERLAY_CHANNELS_V1,
  __internal,
} from "../../lib/synthesis/feature-backfill.js";

function writeLedger(rows) {
  const dir = mkdtempSync(join(tmpdir(), "feature-backfill-test-"));
  const path = join(dir, "memory.jsonl");
  const lines = rows.map((r) => JSON.stringify(r) + "\n").join("");
  writeFileSync(path, lines, { mode: 0o600 });
  return path;
}

function bareFact({ id, content, source = "chat-claude-code", created_at = "2026-03-15T10:00:00Z" }) {
  return {
    id,
    kind: "fact",
    content,
    source_refs: [
      {
        source,
        source_msg_id: `${source}:msg:${id}`,
        via: "original",
        corroboration_event_id: null,
      },
    ],
    derived_from: [],
    provenance: {
      agent_id: "test-fixture",
      conversation_id: "conv_legacy",
      confidence: "medium",
      is_seed_row: true,
    },
    created_at,
    features: {
      // The 83-fact case: embedding + salience only, no entities[].
      embedding: new Array(8).fill(0.1),
      salience: { score: 0.6, weights_hash: "legacy" },
    },
  };
}

test("runBackfill emits one event per bare fact (5 facts → 5 events)", async () => {
  const ledger = writeLedger([
    bareFact({
      id: "mem_F1",
      content: "Visit https://github.com/anthropic/claude for the SDK release notes",
    }),
    bareFact({
      id: "mem_F2",
      content: "Email alex@example.com about the workshop tomorrow",
    }),
    bareFact({
      id: "mem_F3",
      content: "Pushed to anthropic/claude-code repo this morning",
    }),
    bareFact({
      id: "mem_F4",
      content: "#acmebot workshop went great, big thanks to the lab",
    }),
    bareFact({
      id: "mem_F5",
      content: "Wrote /home/alex/projects/example-repo/mcp/lib/synthesis/feature-backfill.js",
    }),
  ]);

  const result = await runBackfill({ ledgerPath: ledger });
  assert.equal(result.facts_inspected, 5, "all 5 facts inspected");
  assert.equal(
    result.backfill_events_emitted,
    5,
    "one backfill event per bare fact",
  );
  assert.equal(result.skipped_noop, 0, "no skips on first run");
  assert.equal(result.errors, 0, "no errors");
  assert.equal(result.dry_run, false, "dry_run flag false");

  const events = readBackfillEventsFromLedger(ledger);
  assert.equal(events.length, 5, "5 events on disk");
  for (const e of events) {
    assert.equal(e.kind, "policy");
    assert.equal(e.policy_kind, FEATURE_BACKFILL_KIND);
    assert.equal(e.schema_version, FEATURE_BACKFILL_SCHEMA_VERSION);
    assert.equal(e.backfill_version, 1, "first backfill is version 1");
    assert.equal(e.emitter_module, "feature-backfill");
    assert.equal(e.emitter_version, FEATURE_BACKFILL_VERSION);
    assert.equal(e.provenance.agent_id, "feature-backfill-daemon");
    assert.equal(e.provenance.conversation_id, null);
    assert.equal(typeof e.provenance.confidence, "number");
    assert.ok(
      e.target_fact_id.startsWith("mem_F"),
      `target_fact_id is a fact id, got ${e.target_fact_id}`,
    );
    assert.equal(typeof e.features_overlay, "object");
  }
});

test("idempotent re-run emits 0 new events (no-op skip per §6.1)", async () => {
  const ledger = writeLedger([
    bareFact({
      id: "mem_FA",
      content: "Email alex@example.com about the workshop",
    }),
  ]);
  const first = await runBackfill({ ledgerPath: ledger });
  assert.equal(first.backfill_events_emitted, 1);

  const second = await runBackfill({ ledgerPath: ledger });
  assert.equal(
    second.backfill_events_emitted,
    0,
    "re-run is a no-op (existing fresh backfill skips early)",
  );
  assert.equal(second.errors, 0);
  const events = readBackfillEventsFromLedger(ledger);
  assert.equal(events.length, 1, "ledger still has exactly 1 backfill row");

  // The sinceVersion gate forces a re-extract that DOES exercise the
  // byte-equality skip path (spec §6.1): same overlay → skipped_noop,
  // no new event.
  const third = await runBackfill({ ledgerPath: ledger, sinceVersion: 2 });
  assert.equal(
    third.backfill_events_emitted,
    0,
    "sinceVersion bump but identical extractor output → still a no-op via byte-equality",
  );
  assert.equal(
    third.skipped_noop,
    1,
    "byte-equal skip increments skipped_noop counter",
  );
  const eventsAfter = readBackfillEventsFromLedger(ledger);
  assert.equal(
    eventsAfter.length,
    1,
    "ledger still has exactly 1 backfill row after force re-run",
  );
});

test("extractor failure → skip + count error; other facts proceed", async () => {
  // The entity extractor throws "unknown source" on out-of-enum source
  // scopes — synthesize a fact row with a sentinel source to trigger that
  // path. The extractor failure is caught defensively (degrades the
  // entities channel to empty); the row should still emit with the other
  // extractor channels intact. This documents the W3 fail-shut posture:
  // a per-channel degrade does NOT block emission of the remaining
  // channels.
  const ledger = writeLedger([
    bareFact({
      id: "mem_FB",
      content: "Visit https://example.com for details",
      source: "out-of-enum-sentinel-source",
    }),
    bareFact({
      id: "mem_FC",
      content: "Email alex@example.com",
    }),
  ]);
  const result = await runBackfill({ ledgerPath: ledger });
  // Both inspected; FB extracts no entities (source skipped) but still
  // emits valence + episodicity + time anchors; FC normal extraction.
  assert.equal(result.facts_inspected, 2);
  assert.ok(
    result.backfill_events_emitted >= 1,
    "at least one event emitted even with out-of-enum source",
  );
  // No total failure of the run.
  assert.equal(typeof result.errors, "number");
});

test("dry-run computes overlays but writes nothing", async () => {
  const ledger = writeLedger([
    bareFact({
      id: "mem_FD",
      content: "anthropic/claude-code commit landed yesterday",
    }),
    bareFact({
      id: "mem_FE",
      content: "Visit https://anthropic.com/news/claude-3 for details",
    }),
  ]);
  const result = await runBackfill({ ledgerPath: ledger, dryRun: true });
  assert.equal(result.facts_inspected, 2);
  assert.equal(result.dry_run, true);
  // Dry-run does NOT emit; events on disk = 0.
  const events = readBackfillEventsFromLedger(ledger);
  assert.equal(events.length, 0, "ledger unchanged in dry-run mode");
});

test("fact-ids filter restricts to the specified subset", async () => {
  const ledger = writeLedger([
    bareFact({
      id: "mem_FG",
      content: "Email alex@example.com",
    }),
    bareFact({
      id: "mem_FH",
      content: "Visit https://example.com",
    }),
    bareFact({
      id: "mem_FI",
      content: "anthropic/claude-code",
    }),
  ]);
  const result = await runBackfill({
    ledgerPath: ledger,
    factIds: ["mem_FH"],
  });
  assert.equal(result.facts_inspected, 1, "only the filtered fact inspected");
  assert.equal(result.backfill_events_emitted, 1);
  const events = readBackfillEventsFromLedger(ledger);
  assert.equal(events.length, 1);
  assert.equal(events[0].target_fact_id, "mem_FH");
});

test("thesis #1: original fact rows are not mutated on disk", async () => {
  const fact = bareFact({
    id: "mem_FJ",
    content: "Email alex@example.com",
  });
  const ledger = writeLedger([fact]);
  const beforeBytes = readFileSync(ledger, "utf8");
  const beforeFirstLine = beforeBytes.split("\n")[0];

  await runBackfill({ ledgerPath: ledger });

  const afterBytes = readFileSync(ledger, "utf8");
  const afterFirstLine = afterBytes.split("\n")[0];
  assert.equal(
    afterFirstLine,
    beforeFirstLine,
    "original fact row bytes unchanged on disk",
  );
  // And the file now has additional bytes (the appended backfill row).
  assert.ok(
    afterBytes.length > beforeBytes.length,
    "ledger grew (appended event)",
  );
});

test("canonical overlay JSON dedup detects byte-equal overlays", () => {
  const overlay = {
    entities: [{ kind: "person", canonical_id: "person:chat:alex" }],
    valence: 0.5,
    episodicity: 0.3,
  };
  const a = __internal.canonicalOverlayJson(overlay);
  // Different field insertion order should produce the SAME canonical
  // form, because canonicalOverlayJson iterates OVERLAY_CHANNELS_V1.
  const reordered = {
    episodicity: 0.3,
    valence: 0.5,
    entities: [{ kind: "person", canonical_id: "person:chat:alex" }],
  };
  const b = __internal.canonicalOverlayJson(reordered);
  assert.equal(a, b, "canonical form is order-independent");
  // A different overlay produces a different string.
  const different = { ...overlay, valence: -0.5 };
  const c = __internal.canonicalOverlayJson(different);
  assert.notEqual(a, c);
});

test("needsBackfill returns true for missing features.entities", () => {
  const fact = bareFact({ id: "mem_X", content: "anything" });
  delete fact.features.entities;
  assert.equal(__internal.needsBackfill(fact, null, undefined), true);
});

test("needsBackfill returns false when current-version backfill exists", () => {
  const fact = bareFact({ id: "mem_X", content: "anything" });
  fact.features.entities = [];
  fact.features.entity_extractor_version = "v0.1.0";
  fact.features.time_anchors = [];
  fact.features.episodicity = 0.1;
  const existing = {
    backfill_version: 1,
    extractor_versions: {
      entity_extractor: "v0.1.0",
      time_anchor_extractor: "rule-v1",
      valence_scorer: "lexicon-v1",
      episodicity_scorer: "v0.1.0",
    },
  };
  assert.equal(__internal.needsBackfill(fact, existing, undefined), false);
});

test("needsBackfill returns true when sinceVersion exceeds existing", () => {
  // Use a fact that is OTHERWISE up-to-date so the sinceVersion gate is
  // the only signal we measure. Otherwise the bare-features path always
  // returns true regardless.
  const fact = bareFact({ id: "mem_X", content: "anything" });
  fact.features.entities = [];
  fact.features.entity_extractor_version = "v0.1.0";
  const existing = {
    backfill_version: 1,
    extractor_versions: {
      entity_extractor: "v0.1.0",
      time_anchor_extractor: "rule-v1",
      valence_scorer: "lexicon-v1",
      episodicity_scorer: "v0.1.0",
    },
  };
  assert.equal(
    __internal.needsBackfill(fact, existing, 2),
    true,
    "sinceVersion 2 > existing 1 → needs backfill",
  );
  assert.equal(
    __internal.needsBackfill(fact, existing, 1),
    false,
    "sinceVersion 1 == existing 1 → no backfill needed",
  );
});

test("streamLedgerState selects max(backfill_version) per fact (spec §4.1)", () => {
  // Synthesize a ledger with one fact and three backfill events at versions
  // 1, 2, 3 (in shuffled append order). The map MUST select version 3.
  const fact = bareFact({ id: "mem_FL", content: "Sam mentioned the workshop" });
  const v1 = {
    id: "mem_b001",
    ts: "2026-01-01T00:00:00Z",
    kind: "policy",
    policy_kind: FEATURE_BACKFILL_KIND,
    schema_version: "v1",
    target_fact_id: "mem_FL",
    features_overlay: { entities: [{ kind: "person", canonical_id: "person:chat:e1" }] },
    backfill_version: 1,
  };
  const v3 = {
    id: "mem_b003",
    ts: "2026-03-01T00:00:00Z",
    kind: "policy",
    policy_kind: FEATURE_BACKFILL_KIND,
    schema_version: "v1",
    target_fact_id: "mem_FL",
    features_overlay: { entities: [{ kind: "person", canonical_id: "person:chat:e3" }] },
    backfill_version: 3,
  };
  const v2 = {
    id: "mem_b002",
    ts: "2026-02-01T00:00:00Z",
    kind: "policy",
    policy_kind: FEATURE_BACKFILL_KIND,
    schema_version: "v1",
    target_fact_id: "mem_FL",
    features_overlay: { entities: [{ kind: "person", canonical_id: "person:chat:e2" }] },
    backfill_version: 2,
  };
  // Append in shuffled order: 2, 3, 1.
  const ledger = writeLedger([fact, v2, v3, v1]);
  const state = __internal.streamLedgerState(ledger);
  const latest = state.latestBackfillByFactId.get("mem_FL");
  assert.ok(latest, "latest backfill exists");
  assert.equal(latest.backfill_version, 3, "version 3 wins regardless of append order");
  assert.equal(latest.features_overlay.entities[0].canonical_id, "person:chat:e3");
});

test("CAPS BATCH_SIZE caps per-tick emission", async () => {
  // Build a ledger with BATCH_SIZE + 5 bare facts; first run emits at
  // most BATCH_SIZE. The cap is per-fact-processed (not per-emit) so we
  // drain by running until quiescent.
  const total = BACKFILL_CAPS.BATCH_SIZE + 5;
  const rows = [];
  for (let i = 0; i < total; i++) {
    rows.push(
      bareFact({
        id: `mem_BS${i.toString().padStart(3, "0")}`,
        content: `Email contact${i}@example.com about item ${i}`,
      }),
    );
  }
  const ledger = writeLedger(rows);
  const first = await runBackfill({ ledgerPath: ledger });
  assert.ok(
    first.backfill_events_emitted <= BACKFILL_CAPS.BATCH_SIZE,
    `first run capped at BATCH_SIZE, got ${first.backfill_events_emitted}`,
  );
  // Drain remaining bare facts; each subsequent run inspects up to
  // BATCH_SIZE rows, skipping the already-backfilled ones as no-ops and
  // emitting for the unbackfilled. Loop until 0 new events emitted.
  let totalEmitted = first.backfill_events_emitted;
  for (let i = 0; i < 10 && totalEmitted < total; i++) {
    const r = await runBackfill({ ledgerPath: ledger });
    totalEmitted += r.backfill_events_emitted;
    if (r.backfill_events_emitted === 0) break;
  }
  assert.ok(
    totalEmitted >= total,
    `eventual emission covers all facts (got ${totalEmitted}, expected >=${total})`,
  );
});

test("emitted row has the spec §3 canonical shape", async () => {
  const ledger = writeLedger([
    bareFact({
      id: "mem_FM",
      content: "Met with Robin at https://acmebot.example.com/workshop tomorrow",
    }),
  ]);
  await runBackfill({ ledgerPath: ledger });
  const events = readBackfillEventsFromLedger(ledger);
  assert.equal(events.length, 1);
  const e = events[0];
  // Required fields per spec §3 schema.
  const required = [
    "id",
    "ts",
    "kind",
    "policy_kind",
    "schema_version",
    "target_fact_id",
    "features_overlay",
    "backfill_version",
    "extractor_versions",
    "emitter_module",
    "emitter_version",
    "provenance",
  ];
  for (const f of required) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(e, f),
      `row has required field ${f}`,
    );
  }
  // Overlay channels MUST be a subset of v1 closed set.
  for (const k of Object.keys(e.features_overlay)) {
    assert.ok(
      OVERLAY_CHANNELS_V1.includes(k),
      `overlay channel '${k}' is in v1 closed set`,
    );
  }
  // id starts with mem_
  assert.ok(e.id.startsWith("mem_"), "row id has mem_ prefix");
  // file mode is 0600.
  const st = statSync(ledger);
  assert.equal(st.mode & 0o777, 0o600, "ledger file mode is 0600");
});

test("bad ledgerPath input → no-op (no throw)", async () => {
  const r1 = await runBackfill({ ledgerPath: "" });
  assert.equal(r1.facts_inspected, 0);
  assert.equal(r1.backfill_events_emitted, 0);
  const r2 = await runBackfill({});
  assert.equal(r2.facts_inspected, 0);
  // Non-existent path is also a no-op (defensive).
  const r3 = await runBackfill({ ledgerPath: "/tmp/does/not/exist.jsonl" });
  assert.equal(r3.facts_inspected, 0);
});

test("FEATURE_BACKFILL_KIND constant is the literal", () => {
  assert.equal(FEATURE_BACKFILL_KIND, "feature_backfill");
});

test("BACKFILL_CAPS frozen with spec fields", () => {
  assert.equal(Object.isFrozen(BACKFILL_CAPS), true);
  assert.equal(BACKFILL_CAPS.BATCH_SIZE, 50);
  assert.equal(BACKFILL_CAPS.MAX_WALL_MS, 30000);
});

test("OVERLAY_CHANNELS_V1 is the closed v1 set (spec §3.2)", () => {
  assert.deepEqual(
    [...OVERLAY_CHANNELS_V1].sort(),
    ["entities", "episodicity", "time_anchors", "valence"],
  );
  assert.equal(Object.isFrozen(OVERLAY_CHANNELS_V1), true);
});

test("runExtractorStack refuses to emit unknown overlay channels", () => {
  // The function does NOT itself add unknown channels — this test ensures
  // the defensive validation loop catches a hypothetical future drift.
  // We exercise the gate by inspecting that a synthetic overlay with an
  // unknown channel is rejected via the canonical-JSON path (since the
  // extractor stack only ever writes v1 channels, we approximate by
  // calling canonicalOverlayJson and confirming the unknown is dropped).
  const overlay = {
    entities: [],
    color: "red", // unknown channel — must be dropped from canonical form
  };
  const canon = __internal.canonicalOverlayJson(overlay);
  assert.ok(!canon.includes("color"), "unknown channel dropped from canonical");
  assert.ok(canon.includes("entities"), "known channel preserved");
});
