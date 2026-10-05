// D3 — default-off IDF weighting for the entity_overlap_jaccard score slot.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep module initialization hermetic even though the scorer performs no I/O.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-entity-idf-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
delete process.env.MEMORY_ENTITY_IDF_ENABLED;

const {
  computeScore,
  entityOverlapIdf,
  entityOverlapJaccard,
  ENTITY_IDF_ENV,
} = await import("../lib/recall/multi-feature-score.js");

const NOW = "2026-08-06T00:00:00.000Z";
const N = 1_000;
const COMMON = "person:telegram:user";
const RARE = "project:chat-claude-code:example_repo";
const ENTITY_DF = new Map([
  ["person:user", 590],
  ["project:example_repo", 1],
]);

function score({
  entities,
  contextEntities,
  env,
  attribution = null,
  entityDf = ENTITY_DF,
}) {
  return computeScore({
    s_emb_full3072: 0.2,
    gates: { predicate_mask: 1, consent_dampener: 1, derivation_status: 1 },
    candidate: {
      memory_id: "mem_d3",
      kind: "fact",
      ts: NOW,
      entities,
      valence: null,
      features: attribution == null ? {} : { attribution },
    },
    surrounding_context: {
      entities: contextEntities,
      time_anchor: null,
      valence: null,
    },
    opts: {
      now: NOW,
      env,
      entity_df: entityDf,
      entity_df_n: N,
    },
  });
}

test("flag off preserves the legacy Jaccard score exactly", () => {
  const entities = [COMMON];
  const contextEntities = [COMMON, RARE];
  const legacy = entityOverlapJaccard(entities, contextEntities);
  const off = score({ entities, contextEntities, env: {} });

  assert.equal(legacy, 0.5);
  assert.equal(off.entity_overlap_jaccard, legacy);
  assert.equal(off.final_score, 0.2 + (0.7 * legacy + 0.3));
  console.log(`# off/on delta baseline=${off.final_score.toFixed(9)} delta=0.000000000`);
});

test("a df=1 project match beats the maximally-common person:user match", () => {
  const context = [COMMON, RARE];
  const commonScore = entityOverlapIdf([COMMON], context, ENTITY_DF, N);
  const rareScore = entityOverlapIdf([RARE], context, ENTITY_DF, N);

  assert.ok(rareScore > commonScore, `rare=${rareScore}, common=${commonScore}`);

  const off = score({ entities: [RARE], contextEntities: context, env: {} });
  const on = score({
    entities: [RARE],
    contextEntities: context,
    env: { [ENTITY_IDF_ENV.ENABLED]: "1" },
  });
  assert.ok(on.final_score > off.final_score);
  console.log(
    `# off/on delta rare baseline=${off.final_score.toFixed(9)} ` +
    `enabled=${on.final_score.toFixed(9)} delta=${(on.final_score - off.final_score).toFixed(9)}`,
  );
});

test("IDF-weighted overlap is bounded in [0,1] and empty sides stay zero", () => {
  const cases = [
    entityOverlapIdf([COMMON], [COMMON], ENTITY_DF, N),
    entityOverlapIdf([COMMON], [RARE], ENTITY_DF, N),
    entityOverlapIdf([COMMON], [COMMON, RARE], ENTITY_DF, N),
    entityOverlapIdf(["topic:x:unknown"], ["topic:y:unknown"], ENTITY_DF, N),
    entityOverlapIdf([COMMON], [COMMON], new Map([["person:user", N * 4]]), N),
    entityOverlapIdf([], [COMMON], ENTITY_DF, N),
    entityOverlapIdf([COMMON], [], ENTITY_DF, N),
  ];
  for (const value of cases) {
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `value=${value}`);
  }
  assert.equal(cases[0], 1);
  assert.equal(cases[1], 0);
  assert.equal(cases.at(-1), 0);
});

test("boilerplate overlap stays positive while attribution discounts channel-wide peers", () => {
  const sender = "person:telegram:alex_example";
  const channel = "person:telegram:example_team";
  const df = new Map([
    ["person:alex_example", 1],
    ["person:example_team", 1],
  ]);
  const attribution = {
    sender_name: "Alex Example",
    peer_name: "Example Team",
    peer_type: "group",
    is_outgoing: false,
    is_self: false,
  };

  const enabled = { [ENTITY_IDF_ENV.ENABLED]: "1" };
  const direct = score({
    entities: [sender, channel],
    contextEntities: [sender],
    env: enabled,
    attribution,
    entityDf: df,
  });
  const channelWide = score({
    entities: [sender, channel],
    contextEntities: [channel],
    env: enabled,
    attribution,
    entityDf: df,
  });
  assert.ok(
    channelWide.entity_overlap_jaccard > 0,
    `channel-wide overlap=${channelWide.entity_overlap_jaccard}`,
  );
  assert.ok(
    direct.entity_overlap_jaccard > channelWide.entity_overlap_jaccard,
    `direct=${direct.entity_overlap_jaccard}, channel=${channelWide.entity_overlap_jaccard}`,
  );
  assert.equal(
    entityOverlapIdf([sender, channel], [channel], df, N),
    0.5,
    "without attribution both df=1 entities remain symmetric",
  );
});
