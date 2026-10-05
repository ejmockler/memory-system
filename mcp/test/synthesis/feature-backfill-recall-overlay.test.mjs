// feature-backfill-recall-overlay.test.mjs — W3-CCS recall consumer test.
// (F-CCS-BACKFILL-recall-consumer)
//
// Exercises the recall-side overlay applier end-to-end:
//   - pre-overlay candidate scores X
//   - post-overlay candidate (with entity-rich backfill) scores Y > X due
//     to entity_overlap firing
//   - absent backfill → score unchanged
//   - overlay map is mtime-invalidated (re-writing the ledger triggers a
//     rebuild)
//   - in-memory immutability: applyBackfillOverlay returns a NEW object;
//     the original candidate is NOT mutated (thesis #1)
//   - per-channel REPLACE: overlay entities REPLACE original entities
//     (do NOT merge per spec §4.3)
//
// Hermetic: each test writes to a fresh tmp ledger and resets the
// module-level cache between rebuilds.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyBackfillOverlay,
  buildLatestBackfillMap,
  computeScore,
  LATEST_BACKFILL_CACHE_MAX_AGE_MS,
  __resetBackfillCacheForTests,
} from "../../lib/recall/multi-feature-score.js";
import {
  FEATURE_BACKFILL_KIND,
} from "../../lib/synthesis/feature-backfill.js";

function freshLedgerPath() {
  const dir = mkdtempSync(join(tmpdir(), "backfill-overlay-test-"));
  return join(dir, "memory.jsonl");
}

function writeRows(path, rows) {
  const data = rows.map((r) => JSON.stringify(r) + "\n").join("");
  writeFileSync(path, data, { mode: 0o600 });
}

function makeBackfillRow({
  id,
  ts,
  target_fact_id,
  backfill_version,
  features_overlay,
}) {
  return {
    id,
    ts,
    kind: "policy",
    policy_kind: FEATURE_BACKFILL_KIND,
    schema_version: "v1",
    target_fact_id,
    features_overlay,
    backfill_version,
    extractor_versions: { entity_extractor: "v0.1.0" },
    emitter_module: "feature-backfill",
    emitter_version: "v0.1.0",
    provenance: {
      agent_id: "feature-backfill-daemon",
      conversation_id: null,
      confidence: 0.8,
    },
  };
}

test("buildLatestBackfillMap returns empty map for missing / empty ledger", () => {
  __resetBackfillCacheForTests();
  const m1 = buildLatestBackfillMap("");
  assert.equal(m1.size, 0);
  const m2 = buildLatestBackfillMap("/tmp/does/not/exist.jsonl");
  assert.equal(m2.size, 0);
});

test("buildLatestBackfillMap selects max(backfill_version) per fact (§4.1)", () => {
  __resetBackfillCacheForTests();
  const ledger = freshLedgerPath();
  writeRows(ledger, [
    makeBackfillRow({
      id: "mem_b001",
      ts: "2026-01-01T00:00:00Z",
      target_fact_id: "mem_F1",
      backfill_version: 1,
      features_overlay: { entities: [{ kind: "person", canonical_id: "person:chat:v1" }] },
    }),
    makeBackfillRow({
      id: "mem_b002",
      ts: "2026-02-01T00:00:00Z",
      target_fact_id: "mem_F1",
      backfill_version: 2,
      features_overlay: { entities: [{ kind: "person", canonical_id: "person:chat:v2" }] },
    }),
    // Different fact, no contention.
    makeBackfillRow({
      id: "mem_b003",
      ts: "2026-02-15T00:00:00Z",
      target_fact_id: "mem_F2",
      backfill_version: 1,
      features_overlay: { valence: -0.3 },
    }),
  ]);
  const map = buildLatestBackfillMap(ledger);
  assert.equal(map.size, 2);
  const f1 = map.get("mem_F1");
  assert.ok(f1);
  assert.equal(f1.backfill_version, 2, "version 2 wins");
  assert.equal(
    f1.features_overlay.entities[0].canonical_id,
    "person:chat:v2",
    "overlay reflects winning version",
  );
});

test("applyBackfillOverlay returns input unchanged when no backfill exists", () => {
  __resetBackfillCacheForTests();
  const map = new Map();
  const candidate = {
    memory_id: "mem_F1",
    id: "mem_F1",
    features: { embedding: [0.1], salience: { score: 0.5 } },
  };
  const result = applyBackfillOverlay(candidate, map);
  assert.equal(result, candidate, "returns original reference when no overlay");
});

test("applyBackfillOverlay returns a NEW object (thesis #1: no mutation)", () => {
  __resetBackfillCacheForTests();
  const map = new Map();
  map.set(
    "mem_F1",
    makeBackfillRow({
      id: "mem_b1",
      ts: "2026-06-01T00:00:00Z",
      target_fact_id: "mem_F1",
      backfill_version: 1,
      features_overlay: {
        entities: [{ kind: "person", canonical_id: "person:chat:alex" }],
        valence: 0.5,
        episodicity: 0.4,
      },
    }),
  );
  const candidate = {
    memory_id: "mem_F1",
    id: "mem_F1",
    features: { embedding: [0.1], salience: { score: 0.5 } },
  };
  const beforeKeys = JSON.stringify(Object.keys(candidate.features).sort());
  const result = applyBackfillOverlay(candidate, map);
  assert.notEqual(result, candidate, "new object returned");
  assert.notEqual(
    result.features,
    candidate.features,
    "features object is also new (not aliased)",
  );
  // Original candidate features bag must be byte-identical to before.
  const afterKeys = JSON.stringify(Object.keys(candidate.features).sort());
  assert.equal(afterKeys, beforeKeys, "original features keys unchanged");
  assert.equal(
    candidate.features.entities,
    undefined,
    "original features.entities still undefined post-overlay",
  );
  // The NEW object carries the overlay.
  assert.ok(Array.isArray(result.features.entities));
  assert.equal(result.features.entities[0].canonical_id, "person:chat:alex");
  assert.equal(result.features.valence, 0.5);
  assert.equal(result.features.episodicity, 0.4);
  // Original embedding/salience preserved on the new object.
  assert.deepEqual(result.features.embedding, [0.1]);
});

test("per-channel REPLACE (not merge): overlay entities REPLACE original", () => {
  __resetBackfillCacheForTests();
  const map = new Map();
  map.set(
    "mem_F1",
    makeBackfillRow({
      id: "mem_b1",
      ts: "2026-06-01T00:00:00Z",
      target_fact_id: "mem_F1",
      backfill_version: 1,
      features_overlay: {
        entities: [{ kind: "person", canonical_id: "person:chat:E1" }],
      },
    }),
  );
  const candidate = {
    memory_id: "mem_F1",
    id: "mem_F1",
    features: {
      entities: [{ kind: "person", canonical_id: "person:chat:E_OLD" }],
      embedding: [0.5],
    },
  };
  const result = applyBackfillOverlay(candidate, map);
  // E_OLD must be GONE (per spec §4.3 REPLACE rule).
  assert.equal(result.features.entities.length, 1);
  assert.equal(result.features.entities[0].canonical_id, "person:chat:E1");
});

test("absent overlay channel preserves the original (§4.3)", () => {
  __resetBackfillCacheForTests();
  const map = new Map();
  // Overlay carries valence only — entities must be preserved from original.
  map.set(
    "mem_F1",
    makeBackfillRow({
      id: "mem_b1",
      ts: "2026-06-01T00:00:00Z",
      target_fact_id: "mem_F1",
      backfill_version: 1,
      features_overlay: { valence: -0.7 },
    }),
  );
  const candidate = {
    memory_id: "mem_F1",
    id: "mem_F1",
    features: {
      entities: [{ kind: "person", canonical_id: "person:chat:keep_me" }],
    },
  };
  const result = applyBackfillOverlay(candidate, map);
  assert.equal(
    result.features.entities[0].canonical_id,
    "person:chat:keep_me",
    "original entities preserved when overlay omits the channel",
  );
  assert.equal(result.features.valence, -0.7);
});

test("computeScore: post-overlay entity_overlap fires; pre-overlay does not", () => {
  __resetBackfillCacheForTests();
  // Build a candidate with NO entities (the 83-fact case). The
  // surrounding_context has entities — entity_overlap should be 0 pre-
  // overlay and >0 post-overlay.
  const candidateBare = {
    memory_id: "mem_F1",
    id: "mem_F1",
    kind: "fact",
    ts: "2026-03-15T10:00:00Z",
    entities: [], // legacy bare fact
    valence: null,
    features: { embedding_3072: [0.1, 0.2], embed_state: false },
  };
  const surrounding_context = {
    entities: ["person:chat:alex", "artifact:chat:fernwick"],
    time_anchor: null,
    valence: null,
  };
  const preScore = computeScore({
    s_emb_full3072: 0.5,
    gates: { predicate_mask: 1, consent_dampener: 1.0, derivation_status: 1.0 },
    candidate: candidateBare,
    surrounding_context,
  });
  assert.equal(preScore.entity_overlap_jaccard, 0, "no overlap pre-backfill");

  // Now apply an overlay that supplies the matching entities.
  const map = new Map();
  map.set(
    "mem_F1",
    makeBackfillRow({
      id: "mem_b1",
      ts: "2026-06-01T00:00:00Z",
      target_fact_id: "mem_F1",
      backfill_version: 1,
      features_overlay: {
        entities: [
          { kind: "person", canonical_id: "person:chat:alex" },
          { kind: "artifact", canonical_id: "artifact:chat:fernwick" },
        ],
      },
    }),
  );
  const overlaid = applyBackfillOverlay(candidateBare, map);
  const postScore = computeScore({
    s_emb_full3072: 0.5,
    gates: { predicate_mask: 1, consent_dampener: 1.0, derivation_status: 1.0 },
    candidate: overlaid,
    surrounding_context,
  });
  assert.ok(
    postScore.entity_overlap_jaccard > 0,
    `entity_overlap > 0 post-backfill, got ${postScore.entity_overlap_jaccard}`,
  );
  assert.ok(
    postScore.final_score > preScore.final_score,
    `final_score increased post-backfill (pre=${preScore.final_score}, post=${postScore.final_score})`,
  );
});

test("cache is mtime-invalidated: re-writing ledger rebuilds the map", async () => {
  __resetBackfillCacheForTests();
  const ledger = freshLedgerPath();
  writeRows(ledger, [
    makeBackfillRow({
      id: "mem_b1",
      ts: "2026-06-01T00:00:00Z",
      target_fact_id: "mem_F1",
      backfill_version: 1,
      features_overlay: {
        entities: [{ kind: "person", canonical_id: "person:chat:v1" }],
      },
    }),
  ]);
  const m1 = buildLatestBackfillMap(ledger);
  assert.equal(m1.size, 1);
  assert.equal(
    m1.get("mem_F1").features_overlay.entities[0].canonical_id,
    "person:chat:v1",
  );
  // Wait briefly so the mtime advances on coarse-grained filesystems.
  await new Promise((r) => setTimeout(r, 25));
  // Append a v2 row. mtime + size must invalidate cache.
  appendFileSync(
    ledger,
    JSON.stringify(
      makeBackfillRow({
        id: "mem_b2",
        ts: "2026-06-02T00:00:00Z",
        target_fact_id: "mem_F1",
        backfill_version: 2,
        features_overlay: {
          entities: [{ kind: "person", canonical_id: "person:chat:v2" }],
        },
      }),
    ) + "\n",
  );
  const m2 = buildLatestBackfillMap(ledger);
  // Cache MUST rebuild because mtime+size changed.
  assert.equal(
    m2.get("mem_F1").features_overlay.entities[0].canonical_id,
    "person:chat:v2",
    "cache invalidated; v2 overlay now reflected",
  );
});

test("LATEST_BACKFILL_CACHE_MAX_AGE_MS is exported and reasonable", () => {
  assert.equal(typeof LATEST_BACKFILL_CACHE_MAX_AGE_MS, "number");
  assert.ok(
    LATEST_BACKFILL_CACHE_MAX_AGE_MS > 0,
    "cache age ceiling is positive",
  );
  assert.ok(
    LATEST_BACKFILL_CACHE_MAX_AGE_MS <= 5 * 60_000,
    "cache age ceiling does not exceed 5 minutes",
  );
});

test("non-Map latestBackfillMap input → candidate returned unchanged", () => {
  const candidate = { id: "mem_F1", features: {} };
  assert.equal(applyBackfillOverlay(candidate, null), candidate);
  assert.equal(applyBackfillOverlay(candidate, {}), candidate);
  assert.equal(applyBackfillOverlay(candidate, "not a map"), candidate);
});

test("candidate without id / memory_id → returned unchanged", () => {
  const map = new Map();
  map.set(
    "mem_F1",
    makeBackfillRow({
      id: "mem_b1",
      ts: "2026-06-01T00:00:00Z",
      target_fact_id: "mem_F1",
      backfill_version: 1,
      features_overlay: { valence: 0.5 },
    }),
  );
  const candidate = { features: {} };
  assert.equal(applyBackfillOverlay(candidate, map), candidate);
});

test("computeScore-readable shape: overlay flattens entities to canonical_id strings", () => {
  __resetBackfillCacheForTests();
  const map = new Map();
  map.set(
    "mem_F1",
    makeBackfillRow({
      id: "mem_b1",
      ts: "2026-06-01T00:00:00Z",
      target_fact_id: "mem_F1",
      backfill_version: 1,
      features_overlay: {
        entities: [
          { kind: "person", canonical_id: "person:chat:alex" },
          { kind: "artifact", canonical_id: "artifact:chat:fernwick" },
        ],
      },
    }),
  );
  const candidate = { id: "mem_F1", memory_id: "mem_F1", features: {} };
  const result = applyBackfillOverlay(candidate, map);
  assert.ok(Array.isArray(result.entities), "candidate.entities populated");
  assert.deepEqual(
    result.entities.sort(),
    ["artifact:chat:fernwick", "person:chat:alex"],
    "entities flattened to canonical_id strings for scorer consumption",
  );
});
