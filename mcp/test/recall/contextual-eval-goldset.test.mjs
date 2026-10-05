// contextual-eval-goldset.test.mjs — WU-goldset-decircularize.
//
// Guards the DECIRCULARIZED contextual-eval goldset
//   ledgers/contextual-eval-goldset.jsonl
// against the failure mode that broke the eval instrument: a goldset with NO
// K=20 headroom, where every (query, golden) pair was selected BECAUSE BM25
// already surfaced the golden in top-20. On such a goldset the BM25 baseline
// scores a perfect 0% top-20 failure rate, so a dense/contextual tier can never
// demonstrate a win — the instrument measures its own selection criterion.
//
// WHAT THIS TEST ASSERTS (the anti-circularity contract):
//   1. Schema: a meta header + well-formed pairs (query, golden_fact_id,
//      stratum, validation block, headroom flag).
//   2. Resolution: every golden_fact_id resolves to a row in the memory ledger
//      under MEMORY_ROOT.
//   3. HEADROOM: a MEANINGFUL fraction of pairs have the golden OUTSIDE BM25
//      top-20 (validation.found_in_topk === false). This is the proof the
//      goldset has room for dense/contextual to win. We assert both the
//      RECORDED fraction (captured at build time) AND — when run with
//      REVALIDATE_BM25=1 — RE-COMPUTE the baseline rank against the LIVE BM25
//      index so the recorded misses cannot drift into stale lies.
//   4. Control cohort: a small minority of headroom:false pairs that BM25 DOES
//      find — proving the baseline-miss fraction is a measured property of the
//      headroom strata, not an artifact of every pair being un-findable noise.
//   5. Curated seed pairs: every pair the builder marks as a curated seed is a
//      semantic_paraphrase headroom miss. A goldset built with no curated seed
//      pairs configured reports an explicit SKIP for this check.
//   6. Stratification across the four strata.
//   7. The eval metric (lib/recall/eval-failure-rate.js) is UNCHANGED in its
//      gate constants (we depend on PRIMARY_K=20) and reads a NON-ZERO BM25
//      baseline failure rate over this goldset (the headroom, end to end).
//
// HERMETICITY: this is a REAL-DATA test (it reads the live ledger + goldset,
// like health-real-data.test.mjs). It writes nothing. It guards against a
// concurrently-running ingest daemon via skipIfDaemonActive so a half-written
// ledger snapshot cannot make a golden-id existence check spuriously fail.
//
// Run: node test/recall/contextual-eval-goldset.test.mjs
//   (set REVALIDATE_BM25=1 to additionally re-rank every pair against the live
//    640MB gemini BM25 index — slow + memory-heavy; opt-in so the default
//    suite stays fast. Requires `node --max-old-space-size=8192`.)

import assert from "node:assert/strict";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

import {
  computeFailureRate,
  FAILURE_RATE_CAPS,
} from "../../lib/recall/eval-failure-rate.js";
import { MEMORY_ROOT } from "../../lib/config.js";
import { skipIfDaemonActive } from "../_hermetic-daemon-skip.mjs";

skipIfDaemonActive("contextual-eval-goldset");

// The data root this run is configured for (MEMORY_ROOT, else the checkout):
// never a home-directory literal. With no goldset under it the suite reports
// SKIP below and exits 0.
const ROOT = MEMORY_ROOT;
const GOLDSET = join(ROOT, "ledgers", "contextual-eval-goldset.jsonl");
const MEMORY_LEDGER = join(ROOT, "ledgers", "memory.jsonl");
const GEMINI_BM25 = join(ROOT, "indices", "gemini-embedding-001", "bm25.json");

// ---------------------------------------------------------------------------
// Lightweight harness (project's ad-hoc style).
// ---------------------------------------------------------------------------
let failures = 0;
let passes = 0;
function check(label, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => { passes += 1; console.log(`PASS  ${label}`); },
        (e) => { failures += 1; console.error(`FAIL  ${label}\n      ${e && e.stack ? e.stack : e}`); },
      );
    }
    passes += 1;
    console.log(`PASS  ${label}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL  ${label}\n      ${e && e.stack ? e.stack : e}`);
  }
}

// ---------------------------------------------------------------------------
// Load the goldset.
// ---------------------------------------------------------------------------
if (!existsSync(GOLDSET)) {
  console.error(`SKIP  contextual-eval-goldset: goldset missing at ${GOLDSET}`);
  process.exit(0);
}
const rawLines = readFileSync(GOLDSET, "utf8").split("\n").filter(Boolean);
const parsed = rawLines.map((l) => JSON.parse(l));
const meta = parsed.find((r) => r && r.kind === "contextual_eval_goldset_meta") || null;
const rows = parsed.filter((r) => r && r.kind !== "contextual_eval_goldset_meta");

const K = FAILURE_RATE_CAPS.PRIMARY_K; // 20 — the gate operating point.

// ===========================================================================
// 1. Meta header present + well-formed.
// ===========================================================================
check("goldset has a meta header with headroom accounting", () => {
  assert.ok(meta, "meta header row present");
  assert.equal(meta.builder, "build-contextual-eval-goldset.mjs");
  assert.equal(meta.validate_k, K, "meta validate_k matches the gate PRIMARY_K");
  assert.ok(meta.headroom && typeof meta.headroom.baseline_miss_fraction_all === "number",
    "meta carries a baseline_miss_fraction_all");
});

// ===========================================================================
// 2. Pair count in the ~150-250 band the WU specifies.
// ===========================================================================
check("pair count is in the ~150-250 band", () => {
  assert.ok(rows.length >= 150, `expected >=150 pairs, got ${rows.length}`);
  assert.ok(rows.length <= 250, `expected <=250 pairs, got ${rows.length}`);
});

// ===========================================================================
// 3. Every row is well-formed (query, golden_fact_id, stratum, validation).
// ===========================================================================
check("every pair is schema-conformant", () => {
  for (const r of rows) {
    assert.equal(typeof r.query, "string");
    assert.ok(r.query.length > 0, `empty query in ${r.id}`);
    assert.ok(typeof r.golden_fact_id === "string" && r.golden_fact_id.startsWith("mem_"),
      `bad golden_fact_id in ${r.id}: ${r.golden_fact_id}`);
    assert.ok(typeof r.stratum === "string" && r.stratum.length > 0, `missing stratum in ${r.id}`);
    assert.ok(r.validation && typeof r.validation.found_in_topk === "boolean",
      `missing validation.found_in_topk in ${r.id}`);
    assert.equal(typeof r.headroom, "boolean", `missing headroom flag in ${r.id}`);
    assert.equal(r.validation.k, K, `validation.k must be ${K} in ${r.id}`);
  }
});

// ===========================================================================
// 4. Goldens are unique (no single fact dominates the metric).
// ===========================================================================
check("golden_fact_id values are unique (no fact dominates)", () => {
  const ids = rows.map((r) => r.golden_fact_id);
  assert.equal(new Set(ids).size, ids.length, "duplicate golden_fact_id present");
});

// ===========================================================================
// 5. Stratification across the four strata.
// ===========================================================================
check("goldset is stratified across the four strata", () => {
  const byStratum = {};
  for (const r of rows) byStratum[r.stratum] = (byStratum[r.stratum] || 0) + 1;
  for (const s of ["semantic_paraphrase", "giant_internal", "whole_fact_entity", "whole_fact_general"]) {
    assert.ok((byStratum[s] || 0) > 0, `stratum ${s} is empty`);
  }
  // The headroom engine (semantic_paraphrase) is the largest single stratum.
  assert.ok(byStratum.semantic_paraphrase >= 40,
    `semantic_paraphrase too small: ${byStratum.semantic_paraphrase}`);
  // All 47 giants should be probed (giant_internal).
  assert.ok(byStratum.giant_internal >= 40, `giant_internal too small: ${byStratum.giant_internal}`);
});

// ===========================================================================
// 6. THE ANTI-CIRCULARITY ASSERTION (recorded): a meaningful fraction of pairs
//    have the golden OUTSIDE BM25 top-20 (real headroom). This is the whole
//    point of the workunit — a goldset where the baseline already wins
//    everything is circular and useless.
// ===========================================================================
check("a meaningful fraction of pairs are BM25-baseline MISSES (real headroom)", () => {
  const misses = rows.filter((r) => r.validation.found_in_topk === false).length;
  const fraction = misses / rows.length;
  console.log(`      recorded baseline_miss_fraction = ${fraction.toFixed(3)} (${misses}/${rows.length})`);
  // The WU asks for a MEANINGFUL fraction. We require at least 50% — far above
  // the prior builder's structural 0% — so dense/contextual has demonstrable
  // room to win on at least half the goldset.
  assert.ok(fraction >= 0.5, `baseline-miss fraction ${fraction.toFixed(3)} below 0.5 — not enough headroom`);
  // And it must agree with the meta accounting (no silent drift in the header).
  assert.ok(Math.abs(fraction - meta.headroom.baseline_miss_fraction_all) < 0.01,
    `meta baseline_miss_fraction ${meta.headroom.baseline_miss_fraction_all} disagrees with rows ${fraction}`);
});

// ===========================================================================
// 7. Headroom-flagged rows are ALL baseline misses (the flag is honest).
// ===========================================================================
check("every headroom:true row is recorded as a BM25 miss", () => {
  const headroom = rows.filter((r) => r.headroom === true);
  assert.ok(headroom.length > 0, "no headroom rows");
  for (const r of headroom) {
    assert.equal(r.validation.found_in_topk, false,
      `headroom:true but found_in_topk!=false in ${r.id}`);
  }
});

// ===========================================================================
// 8. A control cohort EXISTS and is BM25-findable — proving the miss fraction
//    is a real measured property, not "every query matches nothing" noise.
// ===========================================================================
check("a BM25-findable control cohort exists (headroom:false, found_in_topk:true)", () => {
  const controls = rows.filter((r) => r.headroom === false);
  assert.ok(controls.length >= 5, `expected >=5 control rows, got ${controls.length}`);
  for (const r of controls) {
    assert.equal(r.validation.found_in_topk, true,
      `control row not BM25-findable: ${r.id}`);
    assert.ok(r.validation.baseline_rank >= 0 && r.validation.baseline_rank < K,
      `control baseline_rank out of top-${K}: ${r.id}`);
  }
});

// ===========================================================================
// 9. Curated seed pairs (the builder marks each one with
//    derivation "curated_semantic_paraphrase") are ALL semantic_paraphrase
//    headroom misses. Curated pairs are per-host configuration, so a goldset
//    may hold none: that is reported as an explicit SKIP, never as a PASS.
// ===========================================================================
const curated = rows.filter((r) => r.derivation === "curated_semantic_paraphrase");
if (curated.length === 0) {
  console.log("SKIP check 9: no curated seed pairs configured");
} else {
  check("every curated seed pair is a semantic_paraphrase headroom miss", () => {
    for (const r of curated) {
      assert.equal(r.stratum, "semantic_paraphrase",
        `curated seed pair outside semantic_paraphrase: ${r.id}`);
      assert.equal(r.headroom, true, `curated seed pair not flagged headroom: ${r.id}`);
      assert.equal(r.validation.found_in_topk, false,
        `curated seed pair must be a BM25 miss to be headroom: ${r.id}`);
    }
  });
}

// ===========================================================================
// 10. Every golden_fact_id resolves to a row in the memory ledger under
//     MEMORY_ROOT.
//     (Streams the ledger once; stops early when all are found.)
// ===========================================================================
await check("every golden_fact_id exists in the live memory ledger", async () => {
  if (!existsSync(MEMORY_LEDGER)) {
    console.log("      (memory ledger absent — skipping reality check)");
    return;
  }
  const goldenIds = new Set(rows.map((r) => r.golden_fact_id));
  const found = new Set();
  await new Promise((resolve) => {
    const rl = createInterface({ input: createReadStream(MEMORY_LEDGER), crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line || found.size === goldenIds.size) return;
      let row;
      try { row = JSON.parse(line); } catch { return; }
      if (row && typeof row.id === "string" && goldenIds.has(row.id)) {
        found.add(row.id);
        if (found.size === goldenIds.size) rl.close();
      }
    });
    rl.on("close", resolve);
    rl.on("error", () => resolve());
  });
  const missing = [...goldenIds].filter((id) => !found.has(id));
  assert.equal(missing.length, 0, `golden ids absent from ledger: ${missing.slice(0, 5).join(",")}`);
});

// ===========================================================================
// 11. END-TO-END through the UNCHANGED metric: a BM25 recallFn driven by the
//     RECORDED baseline ranks yields a NON-ZERO top-20 failure rate over this
//     goldset (the headroom is visible to the actual gate, not just a label),
//     AND a perfect dense oracle yields 0 — i.e. the goldset can show a delta.
// ===========================================================================
await check("the unchanged metric reads non-zero BM25 failure + a learnable delta", async () => {
  // Drive computeFailureRate with a synthetic recallFn that reconstructs each
  // pair's BM25 ranking from the RECORDED validation: a miss => golden absent;
  // a hit => golden at its recorded rank. This exercises the real metric with
  // no index load, proving the recorded headroom flows through to the gate.
  const byQuery = new Map();
  for (const r of rows) byQuery.set(`${r.id}::${r.query}`, r);
  // Disambiguate duplicate query strings by tagging the goldset rows with id.
  const tagged = rows.map((r) => ({ query: `${r.id}::${r.query}`, golden_fact_id: r.golden_fact_id, stratum: r.stratum }));

  const bm25Fn = (q) => {
    const r = byQuery.get(q);
    if (!r) return [];
    if (r.validation.found_in_topk) {
      // place golden at its recorded rank within a filler list
      const arr = [];
      for (let i = 0; i < K + 5; i++) arr.push(`filler_${i}`);
      const rank = Math.max(0, Math.min(K - 1, r.validation.baseline_rank));
      arr.splice(rank, 0, r.golden_fact_id);
      return arr.slice(0, K + 5);
    }
    // miss: golden absent from top-K
    return Array.from({ length: K + 5 }, (_, i) => `filler_${i}`);
  };
  const denseOracle = (q) => {
    const r = byQuery.get(q);
    return r ? [r.golden_fact_id] : [];
  };

  const bm = await computeFailureRate({ goldset: tagged, recallFn: bm25Fn, k: K });
  const dn = await computeFailureRate({ goldset: tagged, recallFn: denseOracle, k: K });
  console.log(`      metric: bm25_failure=${bm.top_k_failure_rate.toFixed(3)} dense_oracle_failure=${dn.top_k_failure_rate.toFixed(3)}`);

  assert.equal(bm.n_total, rows.length, "metric saw every pair");
  assert.ok(bm.top_k_failure_rate >= 0.5,
    `BM25 baseline failure ${bm.top_k_failure_rate.toFixed(3)} too low — goldset still near-circular`);
  assert.equal(dn.top_k_failure_rate, 0, "a perfect dense oracle should fail nothing");
  assert.ok(bm.top_k_failure_rate > dn.top_k_failure_rate,
    "the goldset must be able to show a baseline->dense delta (the gate's reason to exist)");
});

// ===========================================================================
// 12. The gate constant we depend on is UNCHANGED (the WU forbids touching the
//     metric). If someone re-tunes PRIMARY_K this goldset's headroom claim
//     (built at K=20) would silently mismatch the gate.
// ===========================================================================
check("eval-failure-rate gate constants are unchanged (PRIMARY_K=20)", () => {
  assert.equal(FAILURE_RATE_CAPS.PRIMARY_K, 20, "PRIMARY_K must remain 20 (Anthropic operating point)");
  assert.deepEqual([...FAILURE_RATE_CAPS.RECALL_KS], [5, 10, 20]);
});

// ===========================================================================
// 13 (OPT-IN). Re-validate the recorded baseline misses against the LIVE BM25
//     index so the recorded headroom cannot rot into a stale lie. Slow +
//     memory-heavy; gated behind REVALIDATE_BM25=1.
// ===========================================================================
await check("RECORDED baseline misses match the LIVE BM25 index (opt-in)", async () => {
  if (process.env.REVALIDATE_BM25 !== "1") {
    console.log("      (set REVALIDATE_BM25=1 to re-rank against the live index — skipped)");
    return;
  }
  if (!existsSync(GEMINI_BM25)) {
    console.log("      (gemini BM25 index absent — skipping re-validation)");
    return;
  }
  const { loadBm25IndexFromV2File, isV2File } = await import("../../lib/recall/bm25-streaming-loader.js");
  const { Bm25Index } = await import("../../lib/recall/bm25-index.js");
  const bm25 = isV2File(GEMINI_BM25)
    ? loadBm25IndexFromV2File(GEMINI_BM25)
    : Bm25Index.deserialize(JSON.parse(readFileSync(GEMINI_BM25, "utf8")));
  let mismatches = 0;
  let checked = 0;
  // Sample for speed: re-rank a deterministic subset (every pair would be ~237
  // searches over 1.46M docs — fine, but we cap to keep CI bounded).
  const sample = rows.filter((_, i) => i % 1 === 0); // all rows
  for (const r of sample) {
    checked += 1;
    const hits = bm25.search(r.query, K);
    const found = hits.some((h) => h.memory_id === r.golden_fact_id);
    if (found !== r.validation.found_in_topk) {
      mismatches += 1;
      if (mismatches <= 5) {
        console.error(`      DRIFT ${r.id}: recorded found_in_topk=${r.validation.found_in_topk} live=${found}`);
      }
    }
  }
  console.log(`      re-validated ${checked} pairs against live BM25; mismatches=${mismatches}`);
  assert.equal(mismatches, 0, `${mismatches} recorded baseline ranks drifted from the live index`);
});

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
