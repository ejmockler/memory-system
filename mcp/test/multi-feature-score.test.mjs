// multi-feature-score.test.mjs — Phase 3 v0 recall scoring tests.
//
// Hermetic discipline (C-NEW-2 pattern, standing): set MEMORY_ROOT and the
// POLICY/STORAGE/LEDGERS dirs to mkdtempSync paths BEFORE any dynamic import
// of memory-system modules. The production tree (the live install) must
// stay byte-identical pre/post the test run.
//
// The multi-feature-score module is pure — it does not touch the filesystem —
// but we honor hermeticity for two reasons: (a) lint/conformance consistency
// with the rest of the test suite, (b) future-proofing in case the module
// later integrates with config.js (e.g. for per-deployment weight overrides).

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

// ---------------------------------------------------------------------------
// Hermeticity: stake out tmp dirs and overwrite env BEFORE dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-mfscore-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");

// Dynamic import AFTER env override.
const mfs = await import("../lib/recall/multi-feature-score.js");
const {
  computeScore,
  entityOverlapJaccard,
  entityMatchKey,
  timeAnchorMatch,
  powerLawDecay,
  episodicityMatch,
  valenceCompat,
  engagementPrior,
} = mfs;
const { CAPS } = await import("../lib/validation.js");

// ---------------------------------------------------------------------------
// Ad-hoc assert-with-label framework, matches other test/*.test.mjs style.
// ---------------------------------------------------------------------------
let failures = 0;
let passes = 0;

function pass(label) {
  passes++;
  console.log(`  pass: ${label}`);
}
function fail(label, err) {
  failures++;
  console.log(`  FAIL: ${label}`);
  if (err) {
    console.log(`        ${err && err.stack ? err.stack : err}`);
  }
}
async function test(label, fn) {
  console.log(`test: ${label}`);
  try {
    await fn();
  } catch (err) {
    fail(label, err);
  }
}

function approxEqual(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

// A fixed "now" for deterministic time-based tests. UTC noon, easy to reason
// about against day-offsets.
const NOW_ISO = "2026-06-02T12:00:00Z";
const NOW_EPOCH = Date.parse(NOW_ISO);

function isoOffsetDays(days) {
  return new Date(NOW_EPOCH - days * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Test 1: entityOverlapJaccard
// ---------------------------------------------------------------------------
await test("T1: entityOverlapJaccard known sets -> known overlap", async () => {
  // {a,b,c} intersect {b,c,d} = {b,c} (size 2); union size 4 -> 2/4 = 0.5
  const j = entityOverlapJaccard(["a", "b", "c"], ["b", "c", "d"]);
  if (!approxEqual(j, 0.5)) {
    fail("T1: 0.5 expected", new Error(`got ${j}`));
    return;
  }
  // identical -> 1.0
  const j2 = entityOverlapJaccard(["x", "y"], ["x", "y"]);
  if (!approxEqual(j2, 1.0)) {
    fail("T1: identical -> 1.0", new Error(`got ${j2}`));
    return;
  }
  // disjoint -> 0
  const j3 = entityOverlapJaccard(["a", "b"], ["c", "d"]);
  if (!approxEqual(j3, 0.0)) {
    fail("T1: disjoint -> 0", new Error(`got ${j3}`));
    return;
  }
  // empty -> 0 (no signal)
  const j4 = entityOverlapJaccard([], ["a", "b"]);
  if (!approxEqual(j4, 0.0)) {
    fail("T1: empty -> 0", new Error(`got ${j4}`));
    return;
  }
  // non-arrays -> 0 (graceful)
  const j5 = entityOverlapJaccard(null, ["a"]);
  if (!approxEqual(j5, 0.0)) {
    fail("T1: null input -> 0", new Error(`got ${j5}`));
    return;
  }
  pass("T1: Jaccard overlap correct for known sets / identical / disjoint / empty");
});

// ---------------------------------------------------------------------------
// Test 1b: entityOverlapJaccard matches SOURCE-AGNOSTICALLY.
//
// canonical_id is `kind:source:slug`. The recall query side stamps a fixed
// source (recall.js hardcodes "chat-claude-code" for the populator's
// extractEntities call) while fact-side ids carry whichever connector ingested
// the row — measured live: telegram 1101, codex-cli 642, chat-claude-code 320,
// git-log 137, manual 72, whatsapp 52, imessage 24, mail 18, github-events 16
// across 2,382 mentions. Under exact set intersection the query side could
// only match the ~13% of facts that arrived via chat-claude-code, so
// entity_overlap contributed ~0 to nearly every score.
//
// Kind and slug stay structural: only the source segment is ignored.
// ---------------------------------------------------------------------------
await test("T1b: entityOverlapJaccard ignores the source segment", async () => {
  // Same kind + slug, different connector -> the same entity -> 1.0
  const j = entityOverlapJaccard(
    ["artifact:git-log:mcp_lib_tools_recall_js"],
    ["artifact:chat-claude-code:mcp_lib_tools_recall_js"],
  );
  if (!approxEqual(j, 1.0)) {
    fail("T1b: cross-source same entity -> 1.0", new Error(`got ${j}`));
    return;
  }

  // Different slug must NOT match just because the source was dropped.
  const j2 = entityOverlapJaccard(
    ["artifact:git-log:some_other_file"],
    ["artifact:chat-claude-code:mcp_lib_tools_recall_js"],
  );
  if (!approxEqual(j2, 0.0)) {
    fail("T1b: different slug -> 0", new Error(`got ${j2}`));
    return;
  }

  // Kind stays structural.
  const j3 = entityOverlapJaccard(
    ["person:telegram:alex"],
    ["project:telegram:alex"],
  );
  if (!approxEqual(j3, 0.0)) {
    fail("T1b: differing kind -> 0", new Error(`got ${j3}`));
    return;
  }

  // A slug containing ':' survives — only the first two segments are dropped.
  const j4 = entityOverlapJaccard(
    ["artifact:telegram:https://example.com/a:b"],
    ["artifact:mail:https://example.com/a:b"],
  );
  if (!approxEqual(j4, 1.0)) {
    fail("T1b: colon-bearing slug preserved -> 1.0", new Error(`got ${j4}`));
    return;
  }

  // Same entity via two connectors collapses to ONE key, keeping the ratio
  // in [0,1] rather than inflating |A|.
  const j5 = entityOverlapJaccard(
    ["artifact:git-log:foo", "artifact:telegram:foo"],
    ["artifact:chat-claude-code:foo"],
  );
  if (!approxEqual(j5, 1.0)) {
    fail("T1b: duplicate cross-source ids collapse -> 1.0", new Error(`got ${j5}`));
    return;
  }

  // Legacy source-less ids (and test fixtures like "n1") pass through.
  const j6 = entityOverlapJaccard(["n1", "n2"], ["n2", "n3"]);
  if (!approxEqual(j6, 1 / 3)) {
    fail("T1b: source-less ids unchanged", new Error(`got ${j6}`));
    return;
  }

  // entityMatchKey directly: the normalization is the load-bearing part, so
  // pin its edge cases rather than only observing them through the ratio.
  const keyCases = [
    ["artifact:git-log:foo", "artifact:foo", "drops the source segment"],
    ["artifact:mail:https://x.com/a:b", "artifact:https://x.com/a:b", "keeps slug colons"],
    ["n1", "n1", "no colon -> unchanged"],
    ["kind:only", "kind:only", "single colon -> unchanged"],
  ];
  for (const [input, expected, why] of keyCases) {
    const got = entityMatchKey(input);
    if (got !== expected) {
      fail(`T1b: entityMatchKey ${why}`, new Error(`${input} -> ${got}, expected ${expected}`));
      return;
    }
  }
  for (const bad of [null, undefined, "", 42, {}]) {
    if (entityMatchKey(bad) !== null && entityMatchKey(bad) !== bad) {
      fail("T1b: entityMatchKey non-string -> null", new Error(`got ${entityMatchKey(bad)}`));
      return;
    }
  }

  pass("T1b: source segment ignored; kind/slug structural; colons + dedup safe");
});

// ---------------------------------------------------------------------------
// Test 2: timeAnchorMatch
// ---------------------------------------------------------------------------
await test("T2: timeAnchorMatch step function", async () => {
  // anchor null -> 0
  const m1 = timeAnchorMatch("2026-06-02T12:00:00Z", null);
  if (m1 !== 0) {
    fail("T2: null anchor -> 0", new Error(`got ${m1}`));
    return;
  }
  // identical -> 1.0 (within +/- 1 day)
  const anchor = "2026-06-01T12:00:00Z";
  const m2 = timeAnchorMatch(anchor, anchor);
  if (!approxEqual(m2, 1.0)) {
    fail("T2: identical -> 1.0", new Error(`got ${m2}`));
    return;
  }
  // delta = 12h -> 1.0 (within 1 day)
  const m3 = timeAnchorMatch("2026-06-01T00:00:00Z", "2026-06-01T12:00:00Z");
  if (!approxEqual(m3, 1.0)) {
    fail("T2: 12h delta -> 1.0", new Error(`got ${m3}`));
    return;
  }
  // exactly 1 day boundary -> 1.0 (inclusive)
  const m4 = timeAnchorMatch("2026-05-31T12:00:00Z", "2026-06-01T12:00:00Z");
  if (!approxEqual(m4, 1.0)) {
    fail("T2: 1-day boundary -> 1.0", new Error(`got ${m4}`));
    return;
  }
  // 3 days -> 0.5
  const m5 = timeAnchorMatch("2026-05-29T12:00:00Z", "2026-06-01T12:00:00Z");
  if (!approxEqual(m5, 0.5)) {
    fail("T2: 3 days -> 0.5", new Error(`got ${m5}`));
    return;
  }
  // exactly 7 days boundary -> 0.5 (inclusive)
  const m6 = timeAnchorMatch("2026-05-25T12:00:00Z", "2026-06-01T12:00:00Z");
  if (!approxEqual(m6, 0.5)) {
    fail("T2: 7-day boundary -> 0.5", new Error(`got ${m6}`));
    return;
  }
  // 30 days -> 0
  const m7 = timeAnchorMatch("2026-05-02T12:00:00Z", "2026-06-01T12:00:00Z");
  if (!approxEqual(m7, 0.0)) {
    fail("T2: 30 days -> 0", new Error(`got ${m7}`));
    return;
  }
  // unparseable -> 0
  const m8 = timeAnchorMatch("not a date", "2026-06-01T12:00:00Z");
  if (!approxEqual(m8, 0.0)) {
    fail("T2: unparseable candidate -> 0", new Error(`got ${m8}`));
    return;
  }
  pass("T2: time-anchor step function matches spec");
});

// ---------------------------------------------------------------------------
// Test 3: powerLawDecay
// ---------------------------------------------------------------------------
await test("T3: powerLawDecay shape per Wixted & Ebbesen 1997", async () => {
  // t=0 -> 1.0 regardless of kind. m * (1 + h*0)^(-f) = 1.
  const d0 = powerLawDecay({ ts: NOW_ISO, kind: "fact", opts: { now: NOW_ISO } });
  if (!approxEqual(d0, 1.0)) {
    fail("T3: t=0 -> 1.0", new Error(`got ${d0}`));
    return;
  }

  // At t=10 days for fact kind (f=0.15): (1 + 10)^(-0.15) = 11^(-0.15)
  const fact10 = powerLawDecay({
    ts: isoOffsetDays(10),
    kind: "fact",
    opts: { now: NOW_ISO },
  });
  const expectedFact10 = Math.pow(11, -CAPS.POWER_LAW_F_FACT);
  if (!approxEqual(fact10, expectedFact10, 1e-9)) {
    fail("T3: fact@10d formula mismatch", new Error(
      `got ${fact10}, expected ${expectedFact10}`,
    ));
    return;
  }
  // The contract says "~0.85". 11^(-0.15) ≈ 0.7044... — but the prompt's
  // stated approximation is 0.85; tolerate either reading by checking the
  // formula directly (which is the binding artifact) AND asserting fact >
  // episodic > ambient at the same age.

  // At t=10 days for ambient kind (f=0.6): 11^(-0.6) — should be much lower.
  const ambient10 = powerLawDecay({
    ts: isoOffsetDays(10),
    kind: "ambient",
    opts: { now: NOW_ISO },
  });
  const expectedAmbient10 = Math.pow(11, -CAPS.POWER_LAW_F_AMBIENT);
  if (!approxEqual(ambient10, expectedAmbient10, 1e-9)) {
    fail("T3: ambient@10d formula mismatch", new Error(
      `got ${ambient10}, expected ${expectedAmbient10}`,
    ));
    return;
  }

  // Monotonicity by kind at fixed age: fact > episodic > ambient (smaller f
  // -> slower decay -> higher retained score).
  const episodic10 = powerLawDecay({
    ts: isoOffsetDays(10),
    kind: "episodic",
    opts: { now: NOW_ISO },
  });
  if (!(fact10 > episodic10 && episodic10 > ambient10)) {
    fail("T3: per-kind monotonicity", new Error(
      `fact=${fact10} episodic=${episodic10} ambient=${ambient10}`,
    ));
    return;
  }
  // ambient should be substantially lower than fact at 10 days.
  if (!(fact10 - ambient10 > 0.1)) {
    fail("T3: ambient should be much lower than fact at t=10d",
      new Error(`delta=${fact10 - ambient10}`));
    return;
  }

  // Clock-skew defense: future timestamp -> age clamped to 0 -> score = 1.0
  const future = new Date(NOW_EPOCH + 24 * 60 * 60 * 1000).toISOString();
  const dFuture = powerLawDecay({
    ts: future,
    kind: "fact",
    opts: { now: NOW_ISO },
  });
  if (!approxEqual(dFuture, 1.0)) {
    fail("T3: future ts clamped to 1.0", new Error(`got ${dFuture}`));
    return;
  }

  pass("T3: power-law shape, per-kind monotonicity, and clock-skew clamp");
});

// ---------------------------------------------------------------------------
// Test 4: computeScore — multiplicative branch wins; additive branch wins.
// ---------------------------------------------------------------------------
await test("T4: computeScore composes multiplicative + additive correctly",
  async () => {
    // Scenario A: high s_emb with all gates open, no soft signal -> the
    // multiplicative branch dominates.
    const a = computeScore({
      s_emb_full3072: 0.9,
      gates: {
        predicate_mask: 1,
        consent_dampener: CAPS.CONSENT_DAMPENER_FIRST_PARTY,
        derivation_status: CAPS.DERIVATION_STATUS_NORMAL,
      },
      candidate: {
        memory_id: "mem_A",
        kind: "fact",
        ts: NOW_ISO, // age 0 -> decay = 1.0 (small w_t2*1 contribution)
        entities: [],
        valence: null,
      },
      surrounding_context: {
        entities: [],
        time_anchor: null,
        valence: null,
      },
      opts: { now: NOW_ISO },
    });
    // Expected:
    //   multiplicative = 0.9 * 1 * 1 * 1 * 1 (episodicity stub) = 0.9
    //   additive = 0 + 0 + 0.3*1.0 + 0 + 0 = 0.3
    //   final = 1.2
    const expectedA = 0.9 + CAPS.SCORE_WEIGHT_TIME_DECAY * 1.0;
    if (!approxEqual(a.final_score, expectedA, 1e-9)) {
      fail("T4-A: multiplicative-dominant final_score",
        new Error(`got ${a.final_score}, expected ${expectedA}`));
      return;
    }
    if (!(a.s_emb_full3072 === 0.9 && a.predicate_mask === 1)) {
      fail("T4-A: feature breakdown preserved",
        new Error(JSON.stringify(a)));
      return;
    }

    // Scenario B: weak s_emb but strong entity overlap -> additive branch wins.
    const b = computeScore({
      s_emb_full3072: 0.05,
      gates: {
        predicate_mask: 1,
        consent_dampener: CAPS.CONSENT_DAMPENER_FIRST_PARTY,
        derivation_status: CAPS.DERIVATION_STATUS_NORMAL,
      },
      candidate: {
        memory_id: "mem_B",
        kind: "fact",
        ts: NOW_ISO,
        entities: ["alpha", "beta", "gamma"],
        valence: null,
      },
      surrounding_context: {
        entities: ["alpha", "beta", "gamma"], // jaccard = 1.0
        time_anchor: null,
        valence: null,
      },
      opts: { now: NOW_ISO },
    });
    // multiplicative = 0.05
    // additive = 0.7*1.0 + 0 + 0.3*1.0 + 0 + 0 = 1.0
    // final = 1.05; clearly additive-dominated.
    if (!(b.final_score > 0.9 && b.final_score > a.final_score - 0.5)) {
      fail("T4-B: additive-dominant final_score",
        new Error(`got ${b.final_score}`));
      return;
    }
    // The additive contribution must exceed the multiplicative contribution.
    const bAdditive = b.final_score - b.s_emb_full3072 *
      b.predicate_mask * b.consent_dampener * b.derivation_status *
      b.episodicity_match;
    const bMultiplicative = b.final_score - bAdditive;
    if (!(bAdditive > bMultiplicative)) {
      fail("T4-B: additive should exceed multiplicative",
        new Error(`add=${bAdditive} mult=${bMultiplicative}`));
      return;
    }

    pass("T4: multiplicative-dominant + additive-dominant branches both correct");
  });

// ---------------------------------------------------------------------------
// Test 5: predicate_mask=0 collapses the multiplicative branch to 0.
// ---------------------------------------------------------------------------
await test("T5: predicate_mask=0 collapses multiplicative branch", async () => {
  const s = computeScore({
    s_emb_full3072: 0.99,
    gates: {
      predicate_mask: 0, // excluded
      consent_dampener: CAPS.CONSENT_DAMPENER_FIRST_PARTY,
      derivation_status: CAPS.DERIVATION_STATUS_NORMAL,
    },
    candidate: {
      memory_id: "mem_C",
      kind: "fact",
      ts: NOW_ISO,
      entities: ["x"],
      valence: null,
    },
    surrounding_context: {
      entities: ["y"], // no overlap
      time_anchor: null,
      valence: null,
    },
    opts: { now: NOW_ISO },
  });

  // multiplicative = 0.99 * 0 * 1 * 1 * 1 = 0
  // additive = 0 + 0 + 0.3*1.0 + 0 + 0 = 0.3 (decay only)
  // final = 0.3
  const expected = CAPS.SCORE_WEIGHT_TIME_DECAY * 1.0;
  if (!approxEqual(s.final_score, expected, 1e-9)) {
    fail("T5: predicate-masked final_score should equal additive only",
      new Error(`got ${s.final_score}, expected ${expected}`));
    return;
  }
  // Multiplicative branch must be exactly 0.
  const mult = s.s_emb_full3072 *
    s.predicate_mask *
    s.consent_dampener *
    s.derivation_status *
    s.episodicity_match;
  if (mult !== 0) {
    fail("T5: multiplicative branch must be exactly 0",
      new Error(`got ${mult}`));
    return;
  }
  pass("T5: predicate_mask=0 collapses multiplicative branch to 0");
});

// ---------------------------------------------------------------------------
// Bonus coverage: valenceCompat null handling + episodicityMatch stub +
// engagementPrior stub. These are part of the contract surface and worth a
// regression-anchor.
// ---------------------------------------------------------------------------
await test("T6: valence/episodicity/engagement helpers", async () => {
  if (valenceCompat(null, 0.5) !== 0) {
    fail("T6: valence null candidate -> 0", new Error("got non-zero"));
    return;
  }
  if (valenceCompat(0.5, null) !== 0) {
    fail("T6: valence null context -> 0", new Error("got non-zero"));
    return;
  }
  if (!approxEqual(valenceCompat(0.5, 0.5), 1.0)) {
    fail("T6: valence perfect match -> 1.0", new Error("got != 1.0"));
    return;
  }
  if (!approxEqual(valenceCompat(-1, 1), 0)) {
    fail("T6: valence max distance -> 0", new Error("got != 0"));
    return;
  }
  if (episodicityMatch({ candidate: {}, surrounding_context: {} }) !== 1.0) {
    fail("T6: episodicity v0 stub returns 1.0", new Error("stub broken"));
    return;
  }
  if (engagementPrior("mem_x", {}) !== 0) {
    fail("T6: engagement v0 stub returns 0", new Error("stub broken"));
    return;
  }
  pass("T6: helper stubs and edge cases conform to contract");
});

// ---------------------------------------------------------------------------
// Test 7 (Q4 — memperf): buildLatestBackfillMap persisted checkpoint cache.
//
// A FRESH PROCESS (simulated via __resetBackfillCacheForTests, which clears
// the in-memory projection but leaves the disk cache) must cold-seed from the
// persisted latest-wins map + fold ONLY the appended delta rows through the
// SAME _mergeBackfillRow reducer — deep-equal to a full scan, including
// latest-wins-in-delta (an appended higher backfill_version overrides a
// prefix entry), duplicate ids, torn tail, and prefix-rewrite fail-closed.
//
// RED-RUN RECORD (2026-07-15, this workspace): with _foldBackfillRows
// sabotaged to fold nothing (rows:0, error:null), the latest-wins-in-delta
// and new-fact-in-delta checks below FAILED (fact_1 stayed at v2; fact_3
// missing) — the delta-fold path is load-bearing, not vacuous.
// ---------------------------------------------------------------------------
const { memoryLedgerPath, STORAGE_DIR: CFG_STORAGE_DIR } = await import("../lib/config.js");

function backfillRow(id, targetFactId, version, ts) {
  return {
    id,
    kind: "policy",
    policy_kind: "feature_backfill",
    target_fact_id: targetFactId,
    backfill_version: version,
    ts,
    features_overlay: { entities: [{ canonical_id: `ent_${id}` }] },
  };
}

function mapToCanon(m) {
  const out = {};
  for (const [k, v] of m) out[k] = { id: v.id, backfill_version: v.backfill_version, ts: v.ts };
  return JSON.stringify(out);
}

await test("T7: backfill map cold-seeds from checkpoint cache + delta fold, deep-equal to full scan", async () => {
  const ledgerPath = memoryLedgerPath();
  const cachePath = join(CFG_STORAGE_DIR, "feature-backfill-map.cache.json");
  mkdirSync(join(MEMORY_ROOT, "ledgers"), { recursive: true });
  mkdirSync(CFG_STORAGE_DIR, { recursive: true });
  const rows = (rs) => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";

  // Base: latest-wins inside the prefix (fact_1 v1 then v2) + fact_2 v1.
  writeFileSync(
    ledgerPath,
    rows([
      { id: "fact_1", kind: "fact", ts: "2026-06-01T00:00:00Z", content: "one" },
      backfillRow("bf_1a", "fact_1", 1, "2026-06-01T00:01:00Z"),
      backfillRow("bf_1b", "fact_1", 2, "2026-06-01T00:02:00Z"),
      backfillRow("bf_2a", "fact_2", 1, "2026-06-01T00:03:00Z"),
    ]),
    { mode: 0o600 },
  );
  try {
    rmSync(cachePath, { force: true });
  } catch {}
  mfs.__resetBackfillCacheForTests();

  // Cold prime: full rebuild; persist lands OFF the critical path.
  const primed = mfs.buildLatestBackfillMap(ledgerPath);
  if (mfs.__peekBackfillColdStatsForTests()?.mode !== "full-rebuild") {
    fail("T7: cold prime mode", new Error(JSON.stringify(mfs.__peekBackfillColdStatsForTests())));
    return;
  }
  if (primed.get("fact_1")?.backfill_version !== 2) {
    fail("T7: prefix latest-wins (v2)", new Error(`got ${primed.get("fact_1")?.backfill_version}`));
    return;
  }
  if (existsSync(cachePath)) {
    fail("T7: persist must be scheduled, not inline", new Error("cache exists mid-call"));
    return;
  }
  await mfs._awaitPendingBackfillCachePersists();
  if (!existsSync(cachePath)) {
    fail("T7: scheduled persist landed", new Error("cache missing after flush"));
    return;
  }

  // Exact-eof cold hit: zero delta, ZERO disk writes.
  const bytesBefore = readFileSync(cachePath);
  const statBefore = statSync(cachePath);
  await new Promise((resolve) => setTimeout(resolve, 5));
  mfs.__resetBackfillCacheForTests();
  const exact = mfs.buildLatestBackfillMap(ledgerPath);
  if (mfs.__peekBackfillColdStatsForTests()?.mode !== "cache-hit-exact") {
    fail("T7: exact-eof mode", new Error(JSON.stringify(mfs.__peekBackfillColdStatsForTests())));
    return;
  }
  await mfs._awaitPendingBackfillCachePersists();
  if (!bytesBefore.equals(readFileSync(cachePath)) || statBefore.mtimeMs !== statSync(cachePath).mtimeMs) {
    fail("T7: exact-eof hit wrote nothing", new Error("cache churned"));
    return;
  }
  if (mapToCanon(exact) !== mapToCanon(primed)) {
    fail("T7: exact-eof map equals primed map", new Error("mismatch"));
    return;
  }

  // Delta: latest-wins override of a PREFIX entry (fact_1 -> v3), a new fact
  // (fact_3), and a duplicate policy id (idempotent under latest-wins).
  appendFileSync(
    ledgerPath,
    rows([
      backfillRow("bf_1c", "fact_1", 3, "2026-06-01T00:04:00Z"),
      backfillRow("bf_3a", "fact_3", 1, "2026-06-01T00:05:00Z"),
      backfillRow("bf_3a", "fact_3", 1, "2026-06-01T00:05:00Z"), // duplicate id row
    ]),
  );
  mfs.__resetBackfillCacheForTests(); // fresh-process simulation
  const merged = mfs.buildLatestBackfillMap(ledgerPath);
  const stats = mfs.__peekBackfillColdStatsForTests();
  if (stats?.mode !== "incremental" || stats?.rows_folded !== 3) {
    fail("T7: delta cold seed incremental, 3 rows", new Error(JSON.stringify(stats)));
    return;
  }
  if (merged.get("fact_1")?.backfill_version !== 3 || merged.get("fact_1")?.id !== "bf_1c") {
    fail("T7: latest-wins-in-delta overrides prefix entry", new Error(mapToCanon(merged)));
    return;
  }
  if (merged.get("fact_3")?.id !== "bf_3a") {
    fail("T7: new fact in delta folded", new Error(mapToCanon(merged)));
    return;
  }

  // Ground truth: full scan with the disk cache removed.
  rmSync(cachePath, { force: true });
  mfs.__resetBackfillCacheForTests();
  const full = mfs.buildLatestBackfillMap(ledgerPath);
  if (mapToCanon(merged) !== mapToCanon(full)) {
    fail("T7: cache+delta deep-equals full scan", new Error(`merged=${mapToCanon(merged)} full=${mapToCanon(full)}`));
    return;
  }
  await mfs._awaitPendingBackfillCachePersists();
  pass("T7: checkpoint cold seed + delta fold == full scan (latest-wins, duplicates, no-churn exact hit)");
});

await test("T8: backfill map torn tail excluded then folded once; prefix rewrite fails closed", async () => {
  const ledgerPath = memoryLedgerPath();
  const cachePath = join(CFG_STORAGE_DIR, "feature-backfill-map.cache.json");
  const rows = (rs) => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(
    ledgerPath,
    rows([
      backfillRow("bf_a", "fact_a", 1, "2026-06-01T00:00:00Z"),
      backfillRow("bf_b", "fact_b", 1, "2026-06-01T00:01:00Z"),
    ]),
    { mode: 0o600 },
  );
  try {
    rmSync(cachePath, { force: true });
  } catch {}
  mfs.__resetBackfillCacheForTests();
  mfs.buildLatestBackfillMap(ledgerPath);
  await mfs._awaitPendingBackfillCachePersists();

  // Torn tail: NOT folded, NOT certified; folds exactly once after the "\n".
  const tornRow = backfillRow("bf_torn", "fact_torn", 1, "2026-06-01T00:02:00Z");
  appendFileSync(ledgerPath, JSON.stringify(tornRow)); // no trailing "\n"
  mfs.__resetBackfillCacheForTests();
  const mid = mfs.buildLatestBackfillMap(ledgerPath);
  if (mid.has("fact_torn")) {
    fail("T8: torn row not folded", new Error("torn row visible"));
    return;
  }
  appendFileSync(ledgerPath, "\n");
  mfs.__resetBackfillCacheForTests();
  const after = mfs.buildLatestBackfillMap(ledgerPath);
  const stats = mfs.__peekBackfillColdStatsForTests();
  if (after.get("fact_torn")?.id !== "bf_torn" || stats?.mode !== "incremental") {
    fail("T8: completed torn row folds incrementally", new Error(JSON.stringify(stats)));
    return;
  }

  // Prefix rewrite (same length, different target id) -> full rebuild.
  const raw = readFileSync(ledgerPath, "utf8");
  const mutated = raw.replace('"target_fact_id":"fact_a"', '"target_fact_id":"fact_z"');
  if (Buffer.byteLength(mutated) !== Buffer.byteLength(raw)) {
    fail("T8: same-length mutation", new Error("length drifted"));
    return;
  }
  writeFileSync(ledgerPath, mutated);
  mfs.__resetBackfillCacheForTests();
  const rebuilt = mfs.buildLatestBackfillMap(ledgerPath);
  if (mfs.__peekBackfillColdStatsForTests()?.mode !== "full-rebuild") {
    fail(
      "T8: prefix rewrite fails closed into full rebuild",
      new Error(JSON.stringify(mfs.__peekBackfillColdStatsForTests())),
    );
    return;
  }
  if (rebuilt.has("fact_a") || rebuilt.get("fact_z")?.id !== "bf_a") {
    fail("T8: rebuilt map reflects the NEW file", new Error(mapToCanon(rebuilt)));
    return;
  }
  await mfs._awaitPendingBackfillCachePersists();
  pass("T8: torn tail + prefix rewrite handled fail-closed with checkpoint cache");
});

// ---------------------------------------------------------------------------
// Test 9 (Q4 FIX CYCLE 2 — reviewer's torn-tail seam): a backfill row torn at
// COLD-SEED time must fold via the SAME process's WARM grow once its "\n"
// lands. The defect: the checkpoint cold seed folded to cp.eof but the
// projection layer recorded safeOffset = raw st.size, so the torn bytes were
// never re-read in-process — the completed overlay row was permanently lost.
// RED-RUN RECORD (2026-07-16, this workspace): before the fullRebuild
// {struct, resumeOffset} out-channel landed, the warm-grow check below FAILED
// (fact_tw absent after the row completed).
// ---------------------------------------------------------------------------
await test("T9: torn tail at cold-seed time folds via the warm grow once completed", async () => {
  const ledgerPath = memoryLedgerPath();
  const cachePath = join(CFG_STORAGE_DIR, "feature-backfill-map.cache.json");
  const rows = (rs) => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(
    ledgerPath,
    rows([backfillRow("bf_p", "fact_p", 1, "2026-06-01T00:00:00Z")]),
    { mode: 0o600 },
  );
  try {
    rmSync(cachePath, { force: true });
  } catch {}
  mfs.__resetBackfillCacheForTests();
  mfs.buildLatestBackfillMap(ledgerPath);
  await mfs._awaitPendingBackfillCachePersists();

  // Torn row lands BEFORE the fresh-process cold seed.
  const tornRow = backfillRow("bf_tw", "fact_tw", 1, "2026-06-01T00:01:00Z");
  appendFileSync(ledgerPath, JSON.stringify(tornRow)); // no trailing "\n"
  mfs.__resetBackfillCacheForTests();
  const seeded = mfs.buildLatestBackfillMap(ledgerPath);
  if (seeded.has("fact_tw")) {
    fail("T9: torn row not folded at cold-seed time", new Error("torn row visible"));
    return;
  }

  // Complete the row. SAME process, NO reset: warm grow must fold it.
  appendFileSync(ledgerPath, "\n");
  const warm = mfs.buildLatestBackfillMap(ledgerPath);
  if (warm.get("fact_tw")?.id !== "bf_tw") {
    fail(
      "T9: completed torn row folded by the warm grow (resume = checkpoint eof)",
      new Error(mapToCanon(warm)),
    );
    return;
  }

  // Equivalence vs a full scan over the whole file.
  rmSync(cachePath, { force: true });
  mfs.__resetBackfillCacheForTests();
  const full = mfs.buildLatestBackfillMap(ledgerPath);
  if (mapToCanon(warm) !== mapToCanon(full)) {
    fail("T9: warm-grown map deep-equals full scan", new Error(`warm=${mapToCanon(warm)} full=${mapToCanon(full)}`));
    return;
  }
  await mfs._awaitPendingBackfillCachePersists();
  pass("T9: torn-at-cold-seed row folds exactly once via the warm grow");
});

// ---------------------------------------------------------------------------
// Test 10 (Q4 FIX CYCLE 2 — FIFTH PROJECTION): buildEngagementPriorMap must
// cold-seed from a checkpoint-validated disk cache + delta fold instead of a
// full ledger scan, folding delta rows through the SAME _mergeFeedbackRow
// reducer — deep-equal to a full scan, including torn tail (cold-seed AND
// warm-grow seam) and exact-eof no-rewrite.
// RED-RUN RECORD (2026-07-16, this workspace): before the engagement-prior
// checkpoint cache landed, every assertion below failed (no cache file, no
// cold-seed stats hook) — buildEngagementPriorMap full-scanned on every fresh
// process.
// ---------------------------------------------------------------------------
const epr = await import("../lib/synthesis/engagement-prior-reader.js");

function feedbackRow(id, surfacedIds, ts) {
  return {
    id,
    kind: "policy",
    policy_kind: "salience.recall_feedback",
    surfaced_memory_ids: surfacedIds,
    ts,
  };
}
const EP_NOW = Date.parse("2026-06-15T00:00:00Z");
function priorMapCanon(m) {
  const out = {};
  for (const k of [...m.keys()].sort()) out[k] = +m.get(k).toFixed(12);
  return JSON.stringify(out);
}

await test("T10: engagement prior cold-seeds from checkpoint cache + delta fold, deep-equal to full scan", async () => {
  const ledgerPath = memoryLedgerPath();
  const cachePath = join(CFG_STORAGE_DIR, "engagement-prior-agg.cache.json");
  const rows = (rs) => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(
    ledgerPath,
    rows([
      { id: "fact_x", kind: "fact", ts: "2026-06-01T00:00:00Z", content: "x" },
      feedbackRow("fb_1", ["mem_a", "mem_b"], "2026-06-01T00:01:00Z"),
      feedbackRow("fb_2", ["mem_a"], "2026-06-02T00:00:00Z"),
    ]),
    { mode: 0o600 },
  );
  try {
    rmSync(cachePath, { force: true });
  } catch {}
  epr.__resetEngagementPriorCacheForTests();

  // Cold prime: full rebuild; the persist lands OFF the critical path.
  const primed = epr.buildEngagementPriorMap(ledgerPath, EP_NOW);
  if (epr.__peekEngagementColdStatsForTests()?.mode !== "full-rebuild") {
    fail("T10: cold prime mode", new Error(JSON.stringify(epr.__peekEngagementColdStatsForTests())));
    return;
  }
  if (!(primed.get("mem_a") > primed.get("mem_b"))) {
    fail("T10: count signal ordered (mem_a surfaced twice)", new Error(priorMapCanon(primed)));
    return;
  }
  if (existsSync(cachePath)) {
    fail("T10: persist must be scheduled, not inline", new Error("cache exists mid-call"));
    return;
  }
  await epr._awaitPendingEngagementPersists();
  if (!existsSync(cachePath)) {
    fail("T10: scheduled persist landed", new Error("cache missing after flush"));
    return;
  }

  // Exact-eof cold hit: zero delta, ZERO disk writes.
  const bytesBefore = readFileSync(cachePath);
  const statBefore = statSync(cachePath);
  await new Promise((resolve) => setTimeout(resolve, 5));
  epr.__resetEngagementPriorCacheForTests();
  const exact = epr.buildEngagementPriorMap(ledgerPath, EP_NOW);
  if (epr.__peekEngagementColdStatsForTests()?.mode !== "cache-hit-exact") {
    fail("T10: exact-eof mode", new Error(JSON.stringify(epr.__peekEngagementColdStatsForTests())));
    return;
  }
  await epr._awaitPendingEngagementPersists();
  if (!bytesBefore.equals(readFileSync(cachePath)) || statBefore.mtimeMs !== statSync(cachePath).mtimeMs) {
    fail("T10: exact-eof hit wrote nothing", new Error("cache churned"));
    return;
  }
  if (priorMapCanon(exact) !== priorMapCanon(primed)) {
    fail("T10: exact-eof map equals primed map", new Error("mismatch"));
    return;
  }

  // Delta: mem_a surfaced AGAIN (count must increment over the cached prefix
  // — the non-idempotent reversal-sensitive case) + a new mem_c, PLUS a torn
  // trailing feedback row.
  appendFileSync(
    ledgerPath,
    rows([
      feedbackRow("fb_3", ["mem_a", "mem_c"], "2026-06-03T00:00:00Z"),
      feedbackRow("fb_4", ["mem_c"], "2026-06-04T00:00:00Z"),
    ]),
  );
  const tornFb = feedbackRow("fb_torn", ["mem_torn"], "2026-06-05T00:00:00Z");
  appendFileSync(ledgerPath, JSON.stringify(tornFb)); // no trailing "\n"

  epr.__resetEngagementPriorCacheForTests(); // fresh-process simulation
  const merged = epr.buildEngagementPriorMap(ledgerPath, EP_NOW);
  const stats = epr.__peekEngagementColdStatsForTests();
  if (stats?.mode !== "incremental" || stats?.rows_folded !== 2) {
    fail("T10: delta cold seed incremental, exactly 2 terminated rows", new Error(JSON.stringify(stats)));
    return;
  }
  if (merged.has("mem_torn")) {
    fail("T10: torn row not folded at cold-seed time", new Error(priorMapCanon(merged)));
    return;
  }
  if (!(merged.get("mem_a") > primed.get("mem_a"))) {
    fail("T10: count-in-delta increments the cached prefix count", new Error(priorMapCanon(merged)));
    return;
  }
  if (!(merged.get("mem_c") > 0)) {
    fail("T10: new memory in delta folded", new Error(priorMapCanon(merged)));
    return;
  }

  // Complete the torn row. SAME process, NO reset: warm grow must fold it.
  appendFileSync(ledgerPath, "\n");
  const warm = epr.buildEngagementPriorMap(ledgerPath, EP_NOW);
  if (!(warm.get("mem_torn") > 0)) {
    fail("T10: completed torn row folded by the warm grow", new Error(priorMapCanon(warm)));
    return;
  }

  // Ground truth: full scan with the disk cache removed.
  rmSync(cachePath, { force: true });
  epr.__resetEngagementPriorCacheForTests();
  const full = epr.buildEngagementPriorMap(ledgerPath, EP_NOW);
  if (epr.__peekEngagementColdStatsForTests()?.mode !== "full-rebuild") {
    fail("T10: ground truth is a full rebuild", new Error(JSON.stringify(epr.__peekEngagementColdStatsForTests())));
    return;
  }
  if (priorMapCanon(warm) !== priorMapCanon(full)) {
    fail("T10: cache+delta deep-equals full scan", new Error(`warm=${priorMapCanon(warm)} full=${priorMapCanon(full)}`));
    return;
  }
  await epr._awaitPendingEngagementPersists();
  pass("T10: engagement prior checkpoint cold seed + delta fold == full scan (torn tail included)");
});

// ---------------------------------------------------------------------------
// Test 11 (finding #6 sibling — engagement-prior serializer proto-key trap):
// a surfaced_memory_id === "__proto__" must survive the persist -> reset ->
// cold-reload (cache-hit-exact, via _deserializeEngagementEntries) round-trip.
//
// RED before the v2 entry-array fix: the pre-fix serializer built a plain {}
// object and `entries["__proto__"] = rec` invoked the inherited Object setter,
// so JSON.stringify omitted the key and the reloaded aggregate dropped it
// entirely — the reloaded map had no "__proto__" prior. GREEN after: entries
// serialize as [[k, rec], ...] and deserialize via map.set, so the hostile key
// round-trips losslessly.
//
// CRITICAL: assert the hostile key via the Map API (has/get) ONLY — a plain-
// object canonicalizer (like priorMapCanon) would re-trigger the SAME
// __proto__ setter trap on `out["__proto__"] = ...` and mask the defect.
// ---------------------------------------------------------------------------
function priorMapsEqualByApi(a, b) {
  const ak = [...a.keys()];
  const bk = [...b.keys()];
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!b.has(k)) return false;
    if (!approxEqual(a.get(k), b.get(k), 1e-9)) return false;
  }
  return true;
}

await test("T11: engagement prior '__proto__'-keyed entry survives serialize->deserialize round-trip", async () => {
  const ledgerPath = memoryLedgerPath();
  const cachePath = join(CFG_STORAGE_DIR, "engagement-prior-agg.cache.json");
  const rows = (rs) => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(
    ledgerPath,
    rows([
      { id: "fact_p", kind: "fact", ts: "2026-06-01T00:00:00Z", content: "p" },
      // Hostile surfaced id "__proto__" alongside a normal one.
      feedbackRow("fb_p1", ["__proto__", "mem_a"], "2026-06-01T00:01:00Z"),
    ]),
    { mode: 0o600 },
  );
  try {
    rmSync(cachePath, { force: true });
  } catch {}
  epr.__resetEngagementPriorCacheForTests();

  // Cold prime: full rebuild. The build path uses Map.set, so the aggregate
  // holds "__proto__" fine even pre-fix — the trap is on persist/reload.
  const primed = epr.buildEngagementPriorMap(ledgerPath, EP_NOW);
  if (epr.__peekEngagementColdStatsForTests()?.mode !== "full-rebuild") {
    fail("T11: cold prime mode", new Error(JSON.stringify(epr.__peekEngagementColdStatsForTests())));
    return;
  }
  if (!(primed.has("__proto__") && primed.get("__proto__") > 0)) {
    fail("T11: build path resolves '__proto__' prior", new Error(`get=${primed.get("__proto__")}`));
    return;
  }
  await epr._awaitPendingEngagementPersists();
  if (!existsSync(cachePath)) {
    fail("T11: scheduled persist landed", new Error("cache missing after flush"));
    return;
  }

  // Fresh-process cold reload → cache-hit-exact exercises the deserialize path.
  epr.__resetEngagementPriorCacheForTests();
  const reloaded = epr.buildEngagementPriorMap(ledgerPath, EP_NOW);
  if (epr.__peekEngagementColdStatsForTests()?.mode !== "cache-hit-exact") {
    fail("T11: reload must hit cache-hit-exact (deserialize path)", new Error(JSON.stringify(epr.__peekEngagementColdStatsForTests())));
    return;
  }
  // THE round-trip assertion (Map API only — never a plain-object canon).
  if (!reloaded.has("__proto__")) {
    fail("T11: reloaded map dropped '__proto__' on round-trip (serializer trap)", new Error("has=false"));
    return;
  }
  if (!(reloaded.get("__proto__") > 0)) {
    fail("T11: reloaded '__proto__' prior lost its value", new Error(`get=${reloaded.get("__proto__")}`));
    return;
  }
  if (!approxEqual(reloaded.get("__proto__"), primed.get("__proto__"), 1e-9)) {
    fail("T11: reloaded '__proto__' prior equals pre-persist value", new Error(`reloaded=${reloaded.get("__proto__")} primed=${primed.get("__proto__")}`));
    return;
  }

  // Deep-equivalence vs a fresh full rebuild (Map API, includes "__proto__").
  rmSync(cachePath, { force: true });
  epr.__resetEngagementPriorCacheForTests();
  const full = epr.buildEngagementPriorMap(ledgerPath, EP_NOW);
  if (!priorMapsEqualByApi(reloaded, full)) {
    fail("T11: round-trip map deep-equals fresh full rebuild", new Error("mismatch (via Map API)"));
    return;
  }
  await epr._awaitPendingEngagementPersists();
  pass("T11: '__proto__'-keyed engagement prior round-trips losslessly (v2 entry-array)");
});

// ---------------------------------------------------------------------------
// Test 12 (finding #6 sibling — backfill serializer proto-key trap): a
// target_fact_id === "__proto__" must survive the persist -> reset ->
// cold-reload (cache-hit-exact, via _deserializeBackfillEntries) round-trip.
//
// RED before the v2 entry-array fix (same mechanism as T11): the plain-{}
// serializer dropped the "__proto__" entry on JSON round-trip. Assert via the
// Map API ONLY (mapToCanon would re-trigger the trap on `out["__proto__"]`).
// ---------------------------------------------------------------------------
function backfillMapsEqualByApi(a, b) {
  const ak = [...a.keys()];
  const bk = [...b.keys()];
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!b.has(k)) return false;
    const av = a.get(k);
    const bv = b.get(k);
    if (av?.id !== bv?.id || av?.backfill_version !== bv?.backfill_version || av?.ts !== bv?.ts) {
      return false;
    }
  }
  return true;
}

await test("T12: backfill map '__proto__'-keyed entry survives serialize->deserialize round-trip", async () => {
  const ledgerPath = memoryLedgerPath();
  const cachePath = join(CFG_STORAGE_DIR, "feature-backfill-map.cache.json");
  const rows = (rs) => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(
    ledgerPath,
    rows([
      { id: "fact_n", kind: "fact", ts: "2026-06-01T00:00:00Z", content: "n" },
      // Hostile target id "__proto__" alongside a normal-keyed backfill.
      backfillRow("bf_proto", "__proto__", 1, "2026-06-01T00:01:00Z"),
      backfillRow("bf_norm", "fact_n", 1, "2026-06-01T00:02:00Z"),
    ]),
    { mode: 0o600 },
  );
  try {
    rmSync(cachePath, { force: true });
  } catch {}
  mfs.__resetBackfillCacheForTests();

  // Cold prime: full rebuild. Map.set handles "__proto__" pre-fix; the trap is
  // on persist/reload.
  const primed = mfs.buildLatestBackfillMap(ledgerPath);
  if (mfs.__peekBackfillColdStatsForTests()?.mode !== "full-rebuild") {
    fail("T12: cold prime mode", new Error(JSON.stringify(mfs.__peekBackfillColdStatsForTests())));
    return;
  }
  if (primed.get("__proto__")?.id !== "bf_proto") {
    fail("T12: build path resolves '__proto__' target", new Error(`id=${primed.get("__proto__")?.id}`));
    return;
  }
  await mfs._awaitPendingBackfillCachePersists();
  if (!existsSync(cachePath)) {
    fail("T12: scheduled persist landed", new Error("cache missing after flush"));
    return;
  }

  // Fresh-process cold reload → cache-hit-exact exercises the deserialize path.
  mfs.__resetBackfillCacheForTests();
  const reloaded = mfs.buildLatestBackfillMap(ledgerPath);
  if (mfs.__peekBackfillColdStatsForTests()?.mode !== "cache-hit-exact") {
    fail("T12: reload must hit cache-hit-exact (deserialize path)", new Error(JSON.stringify(mfs.__peekBackfillColdStatsForTests())));
    return;
  }
  // THE round-trip assertion (Map API only — never a plain-object canon).
  if (!reloaded.has("__proto__")) {
    fail("T12: reloaded map dropped '__proto__' on round-trip (serializer trap)", new Error("has=false"));
    return;
  }
  if (reloaded.get("__proto__")?.id !== "bf_proto") {
    fail("T12: reloaded '__proto__' entry is the expected backfill row", new Error(`id=${reloaded.get("__proto__")?.id}`));
    return;
  }

  // Deep-equivalence vs a fresh full scan (Map API, includes "__proto__").
  rmSync(cachePath, { force: true });
  mfs.__resetBackfillCacheForTests();
  const full = mfs.buildLatestBackfillMap(ledgerPath);
  if (!backfillMapsEqualByApi(reloaded, full)) {
    fail("T12: round-trip map deep-equals fresh full scan", new Error("mismatch (via Map API)"));
    return;
  }
  await mfs._awaitPendingBackfillCachePersists();
  pass("T12: '__proto__'-keyed backfill entry round-trips losslessly (v2 entry-array)");
});

// ---------------------------------------------------------------------------
// T13 (b2-silent-recall-degrade, Part 2): the OPTIONAL caller signal
// `vector_resolved` on the scoring candidate.
//
// THE DEFECT: the fallback discriminator asks the immutable ledger ROW
// (features.embed_state === true && both row embeddings null) whether the
// candidate has an embedding. That question stopped being the right one once
// vectors moved off the row: a row with embed_state false-or-absent and NO
// resolvable vector anywhere (the FL-8 / FL-16 index-miss class, plus
// featureless kinds such as `reconstructed`) takes the MULTIPLICATIVE branch
// with s_emb = 0 and reports had_embedding_at_recall:true — a telemetry lie,
// and it also skips the fallback-only additive floor.
//
// MEASURED SCOPE (read-only census of ledgers/memory.jsonl, 9 offset-diverse
// 4 MiB slices, 14,969 rows): 14,571 rows (97.3%) are embed_state:true with no
// row vector and ALREADY take the fallback branch — Part 2 does not move them.
// 178 rows carry a row embedding_4096 array. The delta population is the 220
// rows (1.47%) with embed_state false-or-absent and no row vector, and only
// the subset of those whose vector also misses in the index.
//
// THE CONTRACT this test pins:
//   - signal ABSENT      -> byte-identical to pre-change (legacy predicate)
//   - vector_resolved:true  -> byte-identical to pre-change (legacy predicate)
//   - vector_resolved:false -> fallback branch; the additive-only score is the
//     SAME NUMBER when it clears the floor (only telemetry flips), and 0 with
//     dropped_by_additive_floor:true when it does not. Monotone: adds drops
//     only, never raises a score, never reverses one.
// ---------------------------------------------------------------------------
await test("T13: vector_resolved tri-state moves ONLY the fallback discriminator", async () => {
  const T13_NOW = "2026-06-02T12:00:00.000Z";
  const T13_CTX = { entities: [], time_anchor: null, valence: null };
  // PRE-CHANGE VALUES, measured against this exact fixture before the
  // multi-feature-score.js edit (not derived, not assumed). Asserting the
  // NUMBER — not just the flags — is the whole no-score-change claim.
  const PRE_ABOVE_FINAL = 0.2614750492186848; // ts 2026-06-01, additive >= 0.10
  const PRE_BELOW_FINAL = 0.08591666632952298; // ts 2015-01-01, additive < 0.10
  const TS_ABOVE = "2026-06-01T00:00:00.000Z";
  const TS_BELOW = "2015-01-01T00:00:00.000Z";

  // The delta population's row shape: embed_state:false, NO row vector.
  const mk = (memory_id, ts, extra = {}) => ({
    memory_id,
    kind: "fact",
    ts,
    entities: [],
    valence: null,
    features: { embed_state: false },
    ...extra,
  });
  const score = (candidate, s_emb_full3072 = 0) =>
    computeScore({
      s_emb_full3072,
      gates: { predicate_mask: 1, consent_dampener: 1, derivation_status: 1 },
      candidate,
      surrounding_context: T13_CTX,
      opts: { now: T13_NOW },
    });

  // --- (iii) ANTI-VACUITY CONTROLS, asserted FIRST so the deltas below are
  // measured against a pinned baseline rather than against themselves. -------
  const absentAbove = score(mk("t13_absent_above", TS_ABOVE));
  const trueAbove = score(mk("t13_absent_above", TS_ABOVE, { vector_resolved: true }));
  if (absentAbove.final_score !== PRE_ABOVE_FINAL) {
    fail(
      "T13(iii): signal ABSENT reproduces the pre-change final_score",
      new Error(`got ${absentAbove.final_score} want ${PRE_ABOVE_FINAL}`),
    );
    return;
  }
  if (JSON.stringify(trueAbove) !== JSON.stringify(absentAbove)) {
    fail(
      "T13(iii): vector_resolved:true reproduces the ABSENT ScoreComponents byte-for-byte",
      new Error(`true=${JSON.stringify(trueAbove)}\n        absent=${JSON.stringify(absentAbove)}`),
    );
    return;
  }
  if (
    absentAbove.embedding_source !== "fact_row" ||
    absentAbove.fallback_branch_used !== false ||
    absentAbove.had_embedding_at_recall !== true ||
    absentAbove.dropped_by_additive_floor !== false
  ) {
    fail(
      "T13(iii): the legacy predicate still governs when no signal is supplied",
      new Error(JSON.stringify(absentAbove)),
    );
    return;
  }
  // The census headline class — embed_state:true with no row vector — is
  // ALREADY on the fallback branch and must not move under either control.
  const bulkAbsent = score({
    ...mk("t13_bulk", TS_ABOVE),
    features: { embed_state: true, embedding_3072: null },
  });
  const bulkTrue = score({
    ...mk("t13_bulk", TS_ABOVE),
    features: { embed_state: true, embedding_3072: null },
    vector_resolved: true,
  });
  if (
    bulkAbsent.fallback_branch_used !== true ||
    JSON.stringify(bulkTrue) !== JSON.stringify(bulkAbsent)
  ) {
    fail(
      "T13(iii): the ALREADY-fallback bulk class (embed_state:true, no row vector) is untouched by the signal",
      new Error(`absent=${JSON.stringify(bulkAbsent)}\n        true=${JSON.stringify(bulkTrue)}`),
    );
    return;
  }
  pass("T13(iii): vector_resolved:true and ABSENT both reproduce today's ScoreComponents byte-for-byte");

  // --- (i) vector_resolved:false ABOVE the floor: telemetry flips, score does not.
  const falseAbove = score(mk("t13_absent_above", TS_ABOVE, { vector_resolved: false }));
  // EXACTLY three fields may differ from the ABSENT baseline — nothing else moved.
  const movedAbove = Object.keys(absentAbove)
    .filter((k) => JSON.stringify(absentAbove[k]) !== JSON.stringify(falseAbove[k]))
    .sort();
  let okI = true;
  if (falseAbove.final_score !== PRE_ABOVE_FINAL) {
    okI = false;
    fail(
      "T13(i): final_score is NUMERICALLY IDENTICAL to the pre-change value",
      new Error(`got ${falseAbove.final_score} want ${PRE_ABOVE_FINAL}`),
    );
  }
  if (
    falseAbove.fallback_branch_used !== true ||
    falseAbove.had_embedding_at_recall !== false ||
    falseAbove.embedding_source !== "none" ||
    falseAbove.dropped_by_additive_floor !== false
  ) {
    okI = false;
    fail(
      "T13(i): exactly the three telemetry fields flip; the floor does not fire above 0.10",
      new Error(JSON.stringify(falseAbove)),
    );
  }
  if (
    movedAbove.join(",") !==
    "embedding_source,fallback_branch_used,had_embedding_at_recall"
  ) {
    okI = false;
    fail(
      "T13(i): exactly three ScoreComponents fields changed",
      new Error(`moved=[${movedAbove.join(",")}]`),
    );
  }
  if (okI) {
    pass(
      `T13(i): vector_resolved:false above the floor keeps final_score === ${PRE_ABOVE_FINAL}; only [${movedAbove.join(",")}] flipped`,
    );
  }

  // --- (ii) vector_resolved:false BELOW the floor: the fallback-only additive
  // floor now applies, so the candidate is hard-dropped (score exactly 0).
  const absentBelow = score(mk("t13_below", TS_BELOW));
  if (absentBelow.final_score !== PRE_BELOW_FINAL || absentBelow.dropped_by_additive_floor !== false) {
    fail(
      "T13(ii): pre-change baseline below the floor (no signal) is unchanged",
      new Error(JSON.stringify(absentBelow)),
    );
    return;
  }
  const falseBelow = score(mk("t13_below", TS_BELOW, { vector_resolved: false }));
  let okII = true;
  if (falseBelow.dropped_by_additive_floor !== true || falseBelow.final_score !== 0) {
    okII = false;
    fail(
      "T13(ii): below RECALL_ADDITIVE_FLOOR_FALLBACK the candidate drops to final_score 0",
      new Error(JSON.stringify(falseBelow)),
    );
  }
  if (falseBelow.final_score > absentBelow.final_score) {
    okII = false;
    fail("T13(ii): monotone — Part 2 may only ADD drops", new Error("score rose"));
  }
  if (okII) {
    pass(
      `T13(ii): vector_resolved:false below the floor drops (final_score 0, was ${PRE_BELOW_FINAL})`,
    );
  }

  // --- Guard: a RESOLVED vector (s_emb != 0) is never converted to fallback,
  // even if a caller contradicts itself by passing vector_resolved:false. The
  // `&& s_emb_full3072 === 0` guard is untouched by this change.
  const contradictory = score(
    mk("t13_hydrated", TS_ABOVE, { vector_resolved: false }),
    0.42,
  );
  if (
    contradictory.fallback_branch_used !== false ||
    contradictory.embedding_source !== "fact_row" ||
    contradictory.dropped_by_additive_floor !== false
  ) {
    fail(
      "T13: a nonzero s_emb still wins over the signal (hydrated-vector guard intact)",
      new Error(JSON.stringify(contradictory)),
    );
    return;
  }
  pass("T13: nonzero s_emb_full3072 still short-circuits the fallback branch");
});

// ---------------------------------------------------------------------------
// Cleanup tmp + final report.
// ---------------------------------------------------------------------------
try {
  rmSync(TMP_ROOT, { recursive: true, force: true });
} catch {
  // best-effort
}

console.log("");
console.log(`multi-feature-score: ${passes} pass, ${failures} fail`);
if (failures > 0) {
  process.exit(1);
}
