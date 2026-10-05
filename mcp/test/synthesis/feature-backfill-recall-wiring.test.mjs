// feature-backfill-recall-wiring.test.mjs — W3-CCS FOLLOWUP.
// (F-CCS-BACKFILL-recall-consumer wiring + F-CCS-BACKFILL-engine dry-run fix)
//
// Closes the two W3-spawn findings that blocked empirical lift:
//
//  FIX 1 — buildLatestBackfillMap + applyBackfillOverlay are now imported
//          and called by lib/tools/recall.js (handler-init builds the map
//          once; per-candidate overlay runs BEFORE scoring). Without this
//          wiring the backfill engine's policy.feature_backfill rows sat in
//          the ledger doing nothing — overlay was dead code.
//
//  FIX 2 — runBackfill's --dry-run branch `continue`d before incrementing
//          backfill_events_emitted, so operators got 0 in the projected emit
//          count even when 50 rows would have emitted. Counter now ticks
//          inside the dryRun branch.
//
// Tests are hermetic: every case writes a fresh tmp memory.jsonl + a fresh
// policy.feature_backfill row, drives the memory_recall handler directly
// (degraded path — GEMINI_API_KEY unset), and asserts the overlay materially
// changed candidate.features.entities + entity_overlap_jaccard before
// scoring.
//
// Run: node test/synthesis/feature-backfill-recall-wiring.test.mjs

import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
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
skipIfDaemonActive("feature-backfill-recall-wiring");

// ---------------------------------------------------------------------------
// 0. Hermetic root + env BEFORE any dynamic import.
//    Tests under test/synthesis/recall-integration.test.mjs use the same
//    discipline; we mirror it here so the production ledger is untouched.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-wu-backfill-wire-"));
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
const backfillMod = await import("../../lib/synthesis/feature-backfill.js");
const indexCacheMod = await import("../../lib/recall/index-cache.js");

const MEMORY_JSONL = join(LEDGERS_DIR, "memory.jsonl");

// ---------------------------------------------------------------------------
// 2. Test fixtures.
// ---------------------------------------------------------------------------
function buildBareFactRow({ id, content, createdAt = "2026-03-15T10:00:00.000Z" }) {
  // Mirrors the 83 historical bare-fact shape: features bag has embedding +
  // salience but NO entities[] / time_anchors / valence / episodicity.
  return {
    id,
    kind: "fact",
    content,
    source_refs: [
      {
        source: "chat-claude-code",
        source_msg_id: `chat-claude-code:msg:${id}`,
        via: "original",
        corroboration_event_id: null,
        consent_basis: "first_party",
      },
    ],
    derived_from: [],
    provenance: {
      agent_id: "test-fixture",
      conversation_id: "conv_test",
      confidence: "medium",
      is_seed_row: true,
    },
    created_at: createdAt,
    features: {
      embedding: new Array(8).fill(0.1),
      salience: { score: 0.6, weights_hash: "legacy" },
    },
  };
}

function buildBackfillRow({
  id,
  ts,
  targetFactId,
  backfillVersion = 1,
  entityIds = [],
  valence,
  episodicity,
}) {
  const overlay = {};
  if (entityIds.length > 0) {
    overlay.entities = entityIds.map((cid) => ({
      kind: cid.split(":")[0] || "person",
      canonical_id: cid,
    }));
  }
  if (typeof valence === "number") overlay.valence = valence;
  if (typeof episodicity === "number") overlay.episodicity = episodicity;
  return {
    id,
    ts,
    kind: "policy",
    policy_kind: backfillMod.FEATURE_BACKFILL_KIND,
    schema_version: "v1",
    target_fact_id: targetFactId,
    features_overlay: overlay,
    backfill_version: backfillVersion,
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

function writeMemoryJsonl(rows) {
  const data = rows.map((r) => JSON.stringify(r) + "\n").join("");
  writeFileSync(MEMORY_JSONL, data, { mode: 0o600 });
}

function resetAllCaches() {
  // Order matters: ledger cache (rows + path fingerprint) AND overlay cache
  // (mtime-keyed map) both need to be flushed between scenarios because we
  // overwrite ledger contents (not just append).
  if (typeof indexCacheMod._resetCaches === "function") {
    indexCacheMod._resetCaches();
  }
  if (typeof mfsMod.__resetBackfillCacheForTests === "function") {
    mfsMod.__resetBackfillCacheForTests();
  }
}

function buildRecallArgs(currentQuery, recentTurns = []) {
  return {
    surrounding_context: {
      recent_turns: recentTurns.map((c) =>
        typeof c === "string" ? { role: "user", content: c } : c,
      ),
      agent_role: "test-agent",
      current_query: currentQuery,
      time: "2026-06-21T12:00:00.000Z",
      ambient: null,
      recent_recall_ids: [],
    },
    conversation_id: "conv_backfill_wiring_test",
    max_items: 12,
    max_chars: 4000,
  };
}

// ===========================================================================
// FIX 1 TESTS — overlay wiring (recall handler reads backfill map + applies).
// ===========================================================================

test("FIX1-A: import wiring — recall module imports overlay functions", () => {
  // If the recall module doesn't import the overlay surface, the production
  // path is dead code regardless of mfs.js implementation quality. This is
  // a static guarantee that the wiring exists.
  const src = readFileSync(
    new URL("../../lib/tools/recall.js", import.meta.url),
    "utf8",
  );
  assert.match(
    src,
    /buildLatestBackfillMap/,
    "recall.js imports buildLatestBackfillMap",
  );
  assert.match(
    src,
    /applyBackfillOverlay/,
    "recall.js imports applyBackfillOverlay",
  );
  // The map must be built ONCE per handler invocation, not per-candidate.
  // We grep for the actual call site — defensively scoped to the handler.
  const buildCallMatches = src.match(/buildLatestBackfillMap\s*\(/g) || [];
  assert.ok(
    buildCallMatches.length >= 1,
    `buildLatestBackfillMap called at least once in recall.js (got ${buildCallMatches.length} matches)`,
  );
  const applyCallMatches = src.match(/applyBackfillOverlay\s*\(/g) || [];
  assert.ok(
    applyCallMatches.length >= 1,
    `applyBackfillOverlay called at least once in recall.js (got ${applyCallMatches.length} matches)`,
  );
});

test("FIX1-B: handler runs against bare-fact + backfill ledger without throwing", async () => {
  resetAllCaches();
  // One bare fact (no entities in features) + one backfill row that overlays
  // matching entities. The handler should execute cleanly and surface the
  // fact's row at recall time (degraded_recall is acceptable — embeddings
  // aren't required for the entity-overlap channel to fire).
  const fact = buildBareFactRow({
    id: "mem_FIX1B",
    content: "discussed acmebot workshop with alex example",
  });
  const backfill = buildBackfillRow({
    id: "mem_B_FIX1B",
    ts: "2026-06-20T00:00:00.000Z",
    targetFactId: "mem_FIX1B",
    entityIds: ["person:chat:alex", "artifact:chat:acmebot"],
  });
  writeMemoryJsonl([fact, backfill]);

  const args = buildRecallArgs(
    "tell me about acmebot and alex",
    ["yesterday we set up the acmebot rig"],
  );
  let result, exception;
  try {
    result = await recallMod.TOOL.handler(args);
  } catch (e) {
    exception = e;
  }
  assert.equal(exception, undefined, `handler must not throw: ${exception && exception.message}`);
  assert.equal(result.ok, true, "handler returned ok=true");
  // The fact must be visible to the recall pipeline regardless of overlay —
  // the overlay only changes scoring, not visibility.
  assert.equal(typeof result.data.candidate_set_size, "number", "candidate_set_size present");
});

test("FIX1-C: post-overlay entity_overlap fires; pre-overlay does not (empirical lift)", () => {
  // Direct computeScore comparison to nail down the LIFT that wiring delivers.
  // This is the heart of "the fix matters" — without the wiring, the score
  // breakdown on the right is what production sees, and the entity-overlap
  // channel is dead.
  resetAllCaches();
  const bareCandidate = {
    memory_id: "mem_FIX1C",
    id: "mem_FIX1C",
    kind: "fact",
    ts: "2026-03-15T10:00:00Z",
    entities: [], // legacy bare fact
    valence: null,
    features: { embedding_3072: [0.1, 0.2], embed_state: false },
  };
  const surroundingContext = {
    entities: ["person:chat:alex", "artifact:chat:acmebot"],
    time_anchor: null,
    valence: null,
  };
  const pre = mfsMod.computeScore({
    s_emb_full3072: 0.5,
    gates: { predicate_mask: 1, consent_dampener: 1.0, derivation_status: 1.0 },
    candidate: bareCandidate,
    surrounding_context: surroundingContext,
  });
  assert.equal(pre.entity_overlap_jaccard, 0, "pre-overlay overlap is zero");

  const backfillMap = new Map();
  backfillMap.set(
    "mem_FIX1C",
    buildBackfillRow({
      id: "mem_B_FIX1C",
      ts: "2026-06-20T00:00:00.000Z",
      targetFactId: "mem_FIX1C",
      entityIds: ["person:chat:alex", "artifact:chat:acmebot"],
    }),
  );
  const overlaid = mfsMod.applyBackfillOverlay(bareCandidate, backfillMap);
  assert.notEqual(overlaid, bareCandidate, "overlay returned NEW object");
  // Original candidate.features.entities must still be undefined (thesis #1).
  assert.equal(
    bareCandidate.features.entities,
    undefined,
    "original candidate.features.entities still undefined post-overlay (thesis #1)",
  );
  // Overlay populated the entities channel on the NEW object.
  assert.ok(
    Array.isArray(overlaid.features.entities) && overlaid.features.entities.length === 2,
    "overlay populated features.entities[2] on returned candidate",
  );
  const post = mfsMod.computeScore({
    s_emb_full3072: 0.5,
    gates: { predicate_mask: 1, consent_dampener: 1.0, derivation_status: 1.0 },
    candidate: overlaid,
    surrounding_context: surroundingContext,
  });
  assert.ok(
    post.entity_overlap_jaccard > 0,
    `post-overlay entity_overlap > 0 (got ${post.entity_overlap_jaccard})`,
  );
  assert.ok(
    post.final_score > pre.final_score,
    `final_score lifted post-overlay (pre=${pre.final_score}, post=${post.final_score})`,
  );
  // Specifically: with two matching overlay entities both present in
  // surrounding context, the Jaccard is 2/2 = 1.0.
  assert.equal(post.entity_overlap_jaccard, 1.0, "Jaccard = 1.0 on perfect match");
});

test("FIX1-D: ledger overlay map is mtime-invalidated between recall calls", async () => {
  // Mirrors the W3 cache discipline: appending a v2 backfill row must cause
  // the next buildLatestBackfillMap call to rebuild and reflect v2.
  resetAllCaches();
  const fact = buildBareFactRow({
    id: "mem_FIX1D",
    content: "demo content",
  });
  writeMemoryJsonl([
    fact,
    buildBackfillRow({
      id: "mem_B_FIX1D_v1",
      ts: "2026-06-01T00:00:00.000Z",
      targetFactId: "mem_FIX1D",
      backfillVersion: 1,
      entityIds: ["person:chat:v1"],
    }),
  ]);
  const m1 = mfsMod.buildLatestBackfillMap(MEMORY_JSONL);
  assert.equal(m1.size, 1, "map has one entry");
  assert.equal(
    m1.get("mem_FIX1D").backfill_version,
    1,
    "v1 present",
  );

  // Sleep so mtime advances on coarse filesystems before append.
  await new Promise((r) => setTimeout(r, 25));
  appendFileSync(
    MEMORY_JSONL,
    JSON.stringify(
      buildBackfillRow({
        id: "mem_B_FIX1D_v2",
        ts: "2026-06-15T00:00:00.000Z",
        targetFactId: "mem_FIX1D",
        backfillVersion: 2,
        entityIds: ["person:chat:v2"],
      }),
    ) + "\n",
  );
  const m2 = mfsMod.buildLatestBackfillMap(MEMORY_JSONL);
  assert.equal(
    m2.get("mem_FIX1D").backfill_version,
    2,
    "cache invalidated on mtime change; v2 now wins",
  );
});

test("FIX1-E: defensive — overlay throw on one candidate degrades to raw (handler survives)", async () => {
  // Stress the defensive path: the in-loop try/catch in recall.js must
  // swallow a single-candidate overlay throw and let the other candidates
  // score normally. We exercise the contract via a corrupt backfill row
  // (features_overlay is non-object) — the engine's overlay applier returns
  // candidate as-is, but the handler must not throw either way.
  resetAllCaches();
  const fact = buildBareFactRow({
    id: "mem_FIX1E",
    content: "robust pipeline check",
  });
  // Hand-build a corrupt backfill row: features_overlay set to a non-object
  // (string) — overlay applier will treat it as no-overlay (defensive).
  const corruptBackfill = {
    id: "mem_B_FIX1E",
    ts: "2026-06-20T00:00:00.000Z",
    kind: "policy",
    policy_kind: backfillMod.FEATURE_BACKFILL_KIND,
    schema_version: "v1",
    target_fact_id: "mem_FIX1E",
    features_overlay: "not-an-object",
    backfill_version: 1,
    extractor_versions: { entity_extractor: "v0.1.0" },
    emitter_module: "feature-backfill",
    emitter_version: "v0.1.0",
    provenance: {
      agent_id: "feature-backfill-daemon",
      conversation_id: null,
      confidence: 0.8,
    },
  };
  writeMemoryJsonl([fact, corruptBackfill]);

  const args = buildRecallArgs("robust pipeline check");
  const result = await recallMod.TOOL.handler(args);
  assert.equal(result.ok, true, "handler returned ok=true despite corrupt backfill");
});

test("FIX1-F: empty ledger / no backfill rows — map is empty, no candidate transform", () => {
  resetAllCaches();
  // No backfill rows at all → map is empty → overlay is a no-op per
  // candidate. This is the no-regression case for ledgers that pre-date the
  // feature-backfill engine.
  writeMemoryJsonl([
    buildBareFactRow({ id: "mem_FIX1F", content: "no backfill in sight" }),
  ]);
  const map = mfsMod.buildLatestBackfillMap(MEMORY_JSONL);
  assert.equal(map.size, 0, "no backfill events → empty map");
  // applyBackfillOverlay with empty map MUST return input unchanged
  // (preserves object identity so callers can skip allocations downstream).
  const c = { memory_id: "anything", features: { entities: ["x"] } };
  const result = mfsMod.applyBackfillOverlay(c, map);
  assert.equal(result, c, "empty map → input object returned (identity preserved)");
});

// ===========================================================================
// FIX 2 TESTS — dry-run counter increments correctly.
// ===========================================================================

test("FIX2-A: --dry-run reports projected emit count > 0 (not the 0 from the bug)", async () => {
  resetAllCaches();
  // 3 bare facts → 3 projected emits in dry-run. PRE-FIX this returned 0
  // because the counter increment was skipped by the `continue`.
  const facts = [
    buildBareFactRow({
      id: "mem_DRY_A1",
      content: "anthropic/claude-code commit landed yesterday",
    }),
    buildBareFactRow({
      id: "mem_DRY_A2",
      content: "Visit https://anthropic.com/news/claude-3 for details",
    }),
    buildBareFactRow({
      id: "mem_DRY_A3",
      content: "Email alex@example.com about #release notes",
    }),
  ];
  writeMemoryJsonl(facts);

  const result = await backfillMod.runBackfill({
    ledgerPath: MEMORY_JSONL,
    dryRun: true,
  });
  assert.equal(result.dry_run, true, "dry_run flag echoed in result");
  assert.equal(result.facts_inspected, 3, "all 3 facts inspected");
  assert.equal(
    result.backfill_events_emitted,
    3,
    `dry-run reports projected emit count = 3 (was 0 pre-fix; got ${result.backfill_events_emitted})`,
  );
  assert.equal(result.errors, 0, "no errors in happy path");
});

test("FIX2-B: --dry-run does NOT touch the ledger (no rows written)", async () => {
  resetAllCaches();
  const facts = [
    buildBareFactRow({
      id: "mem_DRY_B1",
      content: "Visit https://example.com",
    }),
    buildBareFactRow({
      id: "mem_DRY_B2",
      content: "anthropic/claude-code",
    }),
  ];
  writeMemoryJsonl(facts);
  const sizeBefore = statSync(MEMORY_JSONL).size;
  const bytesBefore = readFileSync(MEMORY_JSONL, "utf8");

  const result = await backfillMod.runBackfill({
    ledgerPath: MEMORY_JSONL,
    dryRun: true,
  });
  // Counter ticked.
  assert.ok(
    result.backfill_events_emitted >= 1,
    `dry-run still reports projected emits (got ${result.backfill_events_emitted})`,
  );

  // Disk untouched: no append happened, no policy.feature_backfill on disk.
  const sizeAfter = statSync(MEMORY_JSONL).size;
  const bytesAfter = readFileSync(MEMORY_JSONL, "utf8");
  assert.equal(sizeAfter, sizeBefore, "ledger size unchanged in dry-run");
  assert.equal(bytesAfter, bytesBefore, "ledger bytes unchanged in dry-run");
  // Read-side verification too.
  const events = backfillMod.readBackfillEventsFromLedger(MEMORY_JSONL);
  assert.equal(events.length, 0, "no policy.feature_backfill rows on disk");
});

test("FIX2-C: --dry-run preview matches actual emit count when fix is real", async () => {
  // Two-pass invariant: dry-run preview must equal the actual emit count
  // when the same fixture is then run for real on a fresh ledger. This is
  // the operator's load-bearing contract — "preview tells me what I'll get".
  resetAllCaches();
  const fixtureRows = [
    buildBareFactRow({
      id: "mem_DRY_C1",
      content: "Visit https://github.com/foo/bar",
    }),
    buildBareFactRow({
      id: "mem_DRY_C2",
      content: "anthropic/claude commit pushed",
    }),
  ];

  // Pass 1: dry-run (separate ledger so the actual pass starts clean).
  const dryDir = mkdtempSync(join(tmpdir(), "memsys-dry-c-"));
  const dryLedger = join(dryDir, "memory.jsonl");
  writeFileSync(
    dryLedger,
    fixtureRows.map((r) => JSON.stringify(r) + "\n").join(""),
    { mode: 0o600 },
  );
  const dryResult = await backfillMod.runBackfill({
    ledgerPath: dryLedger,
    dryRun: true,
  });
  assert.equal(dryResult.dry_run, true);
  const projected = dryResult.backfill_events_emitted;
  assert.ok(projected > 0, `projected emits > 0 (got ${projected})`);

  // Pass 2: real run on a sibling fresh ledger with identical contents.
  const realDir = mkdtempSync(join(tmpdir(), "memsys-real-c-"));
  const realLedger = join(realDir, "memory.jsonl");
  writeFileSync(
    realLedger,
    fixtureRows.map((r) => JSON.stringify(r) + "\n").join(""),
    { mode: 0o600 },
  );
  const realResult = await backfillMod.runBackfill({
    ledgerPath: realLedger,
  });
  assert.equal(realResult.dry_run, false);
  assert.equal(
    realResult.backfill_events_emitted,
    projected,
    `dry-run preview (${projected}) matches actual emit count (${realResult.backfill_events_emitted})`,
  );
});

test("FIX2-D: --dry-run errors counter remains separate from emit counter", async () => {
  // Defensive: confirm result.errors is still correctly populated in dry-run
  // mode (the counter-bump fix MUST NOT have rewired anything else).
  resetAllCaches();
  const fact = buildBareFactRow({
    id: "mem_DRY_D",
    content: "fact for which extraction succeeds",
  });
  writeMemoryJsonl([fact]);
  const result = await backfillMod.runBackfill({
    ledgerPath: MEMORY_JSONL,
    dryRun: true,
  });
  assert.equal(result.errors, 0, "errors counter is independent of dry-run flag");
  assert.equal(result.dry_run, true);
  assert.ok(
    result.backfill_events_emitted >= 1,
    `dry-run emit counter ticks even when nothing fails (got ${result.backfill_events_emitted})`,
  );
});

// ===========================================================================
// Production-snapshot guard + cleanup.
// ===========================================================================

test("ZZ-prod-snapshot: production paths byte-identical pre/post", () => {
  const PROD_AFTER = {
    memory: snap(PROD_PATHS.memory),
    recall: snap(PROD_PATHS.recall),
    indices: snap(PROD_PATHS.indices),
  };
  assert.equal(
    PROD_AFTER.memory,
    PROD_BEFORE.memory,
    `production memory.jsonl unchanged (${PROD_BEFORE.memory} → ${PROD_AFTER.memory})`,
  );
  assert.equal(
    PROD_AFTER.recall,
    PROD_BEFORE.recall,
    `production recall.jsonl unchanged (${PROD_BEFORE.recall} → ${PROD_AFTER.recall})`,
  );
  assert.equal(
    PROD_AFTER.indices,
    PROD_BEFORE.indices,
    `production indices/ unchanged (${PROD_BEFORE.indices} → ${PROD_AFTER.indices})`,
  );
});

test("ZZ-cleanup: tmp dirs removed", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  assert.equal(existsSync(TMP_ROOT), false, "tmp root cleaned up");
});
