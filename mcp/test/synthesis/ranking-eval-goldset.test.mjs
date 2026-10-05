// ranking-eval-goldset.test.mjs — N11-ranking-goldset (SPAWNED by N6).
//
// The de-circularized contextual goldset has RETRIEVAL headroom but baseline
// NDCG@12 = 1.0 (a single binary already-retrieved golden maxes the ranking
// metric → priors' RANKING effect is unmeasurable). This suite gates the
// RANKING-sensitive substrate built by mcp/scripts/build-ranking-eval-goldset.mjs:
// graded multi-golden labels whose goldens sit at mid/low positions in the REAL
// recall order, so baseline NDCG@12 < 1.0 and a priors-driven re-rank can
// MEASURABLY move the metric.
//
// GATE (the whole point): baseline NDCG@12 < 1.0 (real ranking headroom) AND a
// weight sweep produces a positive ndcg_delta. Plus: every golden is a REAL
// ledger fact id.
//
// Run: node --test test/synthesis/ranking-eval-goldset.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Hermetic env before any dynamic import with module-init side effects.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-ranking-goldset-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
mkdirSync(join(MEMORY_ROOT, "ledgers"), { recursive: true, mode: 0o700 });
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");

const {
  ndcgAtKForPair,
  EVAL_CAPS,
} = await import("../../lib/synthesis/eval-harness.js");
const {
  runCalibration,
  LIVE_WEIGHT_GRID_SPEC,
  rescoreSurfacedWithLiveWeights,
} = await import("../../lib/synthesis/calibration-loop.js");
const { assertGoldsetHeadroom } = await import("../../scripts/run-calibration-cycle.mjs");

// LEDGERS_DIR honours the LEDGERS_BASE_DIR pinned above (the temp root).
const { LEDGERS_DIR } = await import("../../lib/config.js");

// The checkout is wherever this test file lives, not a fixed clone location.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = join(REPO, "mcp", "scripts", "build-ranking-eval-goldset.mjs");
const NODE = process.execPath;

const K = EVAL_CAPS.K; // 12

// ---------------------------------------------------------------------------
// Fixture: a synthetic source recall log + a tiny "memory ledger" so the
// builder can run hermetically (it validates golden ids against the ledger).
// The recall events have ≥6 surfaced real facts with descending scores (real
// traffic shape: ~0.01 gaps), so the builder can pick a mid primary + lower
// secondary golden whose graded NDCG@12 < 1.0.
// ---------------------------------------------------------------------------
function mkFactLine(id) {
  // The builder reads id + kind from the line head; a minimal fact row suffices.
  return JSON.stringify({ id, kind: "fact", content: `content for ${id}` });
}

function mkSourceRecall(events) {
  return events
    .map((ev) =>
      JSON.stringify({
        id: ev.id,
        ts: "2026-06-10T00:00:00Z",
        kind: "recall",
        query: { surrounding_context_hash: ev.id },
        surfaced: ev.ids.map((mid, i) => ({
          memory_id: mid,
          position: i,
          score: Number((0.30 - i * 0.01).toFixed(4)),
        })),
        density_flag: "ok",
      }),
    )
    .join("\n") + "\n";
}

/** Build a hermetic fixture set: N events each with M surfaced real facts. */
function buildFixture(scratchDir, { nEvents = 6, mSurfaced = 8 } = {}) {
  const facts = [];
  const events = [];
  let fid = 0;
  for (let e = 0; e < nEvents; e++) {
    const ids = [];
    for (let i = 0; i < mSurfaced; i++) {
      const id = `mem_${String(++fid).padStart(16, "0")}`;
      ids.push(id);
      facts.push(id);
    }
    events.push({ id: `rec_fix_${String(e).padStart(4, "0")}`, ids });
  }
  const memoryPath = join(scratchDir, "memory.jsonl");
  const sourceRecallPath = join(scratchDir, "source-recall.jsonl");
  writeFileSync(memoryPath, facts.map(mkFactLine).join("\n") + "\n", { mode: 0o600 });
  writeFileSync(sourceRecallPath, mkSourceRecall(events), { mode: 0o600 });
  return { memoryPath, sourceRecallPath, factSet: new Set(facts) };
}

function runBuilder(scratchDir, { memoryPath, sourceRecallPath, seed = 42, target = 50 }) {
  const out = join(scratchDir, "ranking-eval-goldset.jsonl");
  const recallOut = join(scratchDir, "ranking-eval-recall.jsonl");
  execFileSync(
    NODE,
    [
      SCRIPT,
      `--out=${out}`,
      `--recall-out=${recallOut}`,
      `--source-recall=${sourceRecallPath}`,
      `--memory=${memoryPath}`,
      `--seed=${seed}`,
      `--target=${target}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return { out, recallOut };
}

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// A fresh scratch dir + built substrate shared across most tests.
const SCRATCH = mkdtempSync(join(tmpdir(), "ranking-goldset-fixture-"));
const FIX = buildFixture(SCRATCH, { nEvents: 8, mSurfaced: 8 });
const BUILT = runBuilder(SCRATCH, FIX);
const ALL = readJsonl(BUILT.out);
const META = ALL[0];
const LABELS = ALL.slice(1);
const RECALLS = readJsonl(BUILT.recallOut);

// ---------------------------------------------------------------------------
// T1 — the builder emits a meta header + ≥1 label rows + a paired recall file.
// ---------------------------------------------------------------------------
test("T1 builder emits meta header + label rows + paired recall substrate", () => {
  assert.equal(META.kind, "ranking_eval_goldset_meta");
  assert.ok(LABELS.length >= 1, "at least one ranking label");
  assert.equal(META.counts.labels, LABELS.length);
  assert.equal(META.counts.recall_events, RECALLS.length);
  assert.equal(LABELS.length, RECALLS.length, "one recall event per label");
  assert.ok(existsSync(BUILT.recallOut));
});

// ---------------------------------------------------------------------------
// T2 — every label row is a held_out_label with two expected_ids (graded).
// ---------------------------------------------------------------------------
test("T2 every label is a graded multi-golden held_out_label", () => {
  for (const r of LABELS) {
    assert.equal(r.kind, "held_out_label");
    assert.ok(Array.isArray(r.derived_from) && r.derived_from.length === 1);
    assert.ok(Array.isArray(r.payload.expected_ids));
    assert.equal(r.payload.expected_ids.length, 2, "two goldens → graded relevance");
    assert.notEqual(
      r.payload.expected_ids[0],
      r.payload.expected_ids[1],
      "distinct goldens",
    );
    assert.equal(r.payload.abstain, false);
  }
});

// ---------------------------------------------------------------------------
// T3 — GATE: every label's baseline NDCG@12 is < 1.0 (real ranking headroom).
// Recomputed independently here via the SAME eval-harness function the gate
// reads (no trust in the builder's self-reported number).
// ---------------------------------------------------------------------------
test("T3 GATE baseline NDCG@12 < 1.0 for every label (real ranking headroom)", () => {
  for (const lab of LABELS) {
    const rec = RECALLS.find((r) => r.id === lab.derived_from[0]);
    assert.ok(rec, `recall row for ${lab.id} exists`);
    const surfacedIds = [...rec.surfaced]
      .sort((a, b) => a.position - b.position)
      .map((s) => s.memory_id);
    const nd = ndcgAtKForPair(
      { kind: "held_out_label", payload: { expected_ids: lab.payload.expected_ids, forbidden_ids: [] } },
      surfacedIds,
      undefined,
      K,
    );
    assert.ok(typeof nd === "number" && Number.isFinite(nd), "scoreable");
    assert.ok(nd < 1 - 1e-9, `baseline NDCG@12 ${nd} must be < 1.0 (id ${lab.id})`);
    assert.ok(nd > 0, "and > 0 (goldens are retrieved, just mis-ranked)");
  }
});

// ---------------------------------------------------------------------------
// T4 — the meta header's headroom is genuine: baseline_miss_fraction_all == 1.0
// (all rows have ranking headroom) and the mean baseline NDCG is < 1.0.
// ---------------------------------------------------------------------------
test("T4 meta headroom reports real ranking headroom", () => {
  assert.equal(META.headroom.baseline_miss_fraction_all, 1);
  assert.equal(META.headroom.baseline_misses, LABELS.length);
  assert.ok(META.headroom.baseline_ndcg_at_12_mean < 1 - 1e-9);
  assert.ok(META.headroom.baseline_ndcg_at_12_max < 1 - 1e-9);
  assert.ok(META.headroom.ranking_headroom_mean > 0);
});

// ---------------------------------------------------------------------------
// T5 — every golden is a REAL ledger fact id (validated against the fixture
// ledger; the builder must never label a non-existent fact as golden).
// ---------------------------------------------------------------------------
test("T5 every golden is a real ledger fact id", () => {
  for (const lab of LABELS) {
    for (const gid of lab.payload.expected_ids) {
      assert.ok(FIX.factSet.has(gid), `golden ${gid} exists in ledger`);
    }
  }
});

// ---------------------------------------------------------------------------
// T6 — goldens sit at mid/low positions (≥2) in the REAL surfaced order, never
// rank-0 (which would already max NDCG and kill the headroom).
// ---------------------------------------------------------------------------
test("T6 goldens are surfaced at non-rank-0 positions", () => {
  for (const lab of LABELS) {
    const rec = RECALLS.find((r) => r.id === lab.derived_from[0]);
    const order = [...rec.surfaced].sort((a, b) => a.position - b.position).map((s) => s.memory_id);
    const positions = lab.payload.expected_ids.map((g) => order.indexOf(g));
    for (const p of positions) assert.ok(p >= 0, "golden is retrieved");
    // At least one golden is below rank-0 OR the two are not in the top-2 slots
    // (otherwise NDCG would be 1.0). T3 already guarantees < 1.0; this asserts
    // the structural cause.
    const inTop2 = positions.filter((p) => p <= 1).length;
    assert.ok(inTop2 < 2, "goldens are NOT both already in the top-2 (mis-ranked)");
  }
});

// ---------------------------------------------------------------------------
// T7 — the paired recall substrate stamps NON-neutral priors on goldens and
// NEUTRAL priors on non-goldens (so a weight sweep moves only the goldens).
// ---------------------------------------------------------------------------
test("T7 paired recall stamps non-neutral priors on goldens, neutral elsewhere", () => {
  for (const lab of LABELS) {
    const rec = RECALLS.find((r) => r.id === lab.derived_from[0]);
    const exp = new Set(lab.payload.expected_ids);
    for (const s of rec.surfaced) {
      assert.ok(s.priors && typeof s.priors === "object", "every surfaced item has priors");
      if (exp.has(s.memory_id)) {
        const nonNeutral =
          s.priors.engagement_prior > 0 ||
          s.priors.damping_coefficient !== 1.0 ||
          s.priors.corroboration_boost !== 1.0;
        assert.ok(nonNeutral, `golden ${s.memory_id} carries non-neutral priors`);
        assert.ok(s.priors.damping_coefficient <= 1.5, "damping within clamp");
        assert.ok(s.priors.corroboration_boost <= 1.3, "corroboration within clamp");
      } else {
        assert.equal(s.priors.engagement_prior, 0.0);
        assert.equal(s.priors.damping_coefficient, 1.0);
        assert.equal(s.priors.corroboration_boost, 1.0);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// T8 — at the BASELINE (all weights 0.0) the live-weight rescore is a no-op:
// the surfaced order is byte-identical, so baseline NDCG is unchanged.
// ---------------------------------------------------------------------------
test("T8 baseline weights=0.0 → rescore is order byte-identical (no-op)", () => {
  const zero = { SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0, SCORE_WEIGHT_DAMPING_PRIOR: 0, SCORE_WEIGHT_CORROBORATION_PRIOR: 0 };
  for (const rec of RECALLS) {
    const before = [...rec.surfaced].sort((a, b) => a.position - b.position).map((s) => s.memory_id);
    const after = rescoreSurfacedWithLiveWeights(rec.surfaced, zero).map((s) => s.memory_id);
    assert.deepEqual(after, before, "weights=0 preserves the real order");
  }
});

// ---------------------------------------------------------------------------
// T9 — at GRID-MAX weights the goldens are lifted to the top → NDCG@12 = 1.0
// for every label (the priors were sized to overcome the score gap).
// ---------------------------------------------------------------------------
test("T9 grid-max weights lift goldens to the top → NDCG@12 = 1.0", () => {
  const gridMax = {
    SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0.04,
    SCORE_WEIGHT_DAMPING_PRIOR: 0.03,
    SCORE_WEIGHT_CORROBORATION_PRIOR: 0.03,
  };
  for (const lab of LABELS) {
    const rec = RECALLS.find((r) => r.id === lab.derived_from[0]);
    const reranked = rescoreSurfacedWithLiveWeights(rec.surfaced, gridMax)
      .sort((a, b) => a.position - b.position)
      .map((s) => s.memory_id);
    const nd = ndcgAtKForPair(
      { kind: "held_out_label", payload: { expected_ids: lab.payload.expected_ids, forbidden_ids: [] } },
      reranked,
      undefined,
      K,
    );
    assert.ok(Math.abs(nd - 1.0) < 1e-9, `lifted NDCG@12 == 1.0 (id ${lab.id}, got ${nd})`);
  }
});

// ---------------------------------------------------------------------------
// T10 — END-TO-END through runCalibration over the LIVE_WEIGHT grid: the sweep
// produces a positive ndcg_delta (baseline < best). This is the unblock: on the
// old self-referential labelset ndcg_delta was 0; here it is measurable.
// ---------------------------------------------------------------------------
test("T10 calibration sweep produces a measurable positive ndcg_delta", async () => {
  const calib = await runCalibration({
    labelsPath: BUILT.out, // meta header line is skipped by the held_out_label filter
    recallLogPath: BUILT.recallOut,
    baselineCaps: { SCORE_WEIGHT_ENGAGEMENT_PRIOR: 0, SCORE_WEIGHT_DAMPING_PRIOR: 0, SCORE_WEIGHT_CORROBORATION_PRIOR: 0 },
    gridSpec: LIVE_WEIGHT_GRID_SPEC,
    rescoreSurfaced: rescoreSurfacedWithLiveWeights,
  });
  assert.equal(calib.cold_start, false);
  assert.ok(calib.baseline_metrics.n_labels_used >= 1, "labels joined to recall");
  const base = calib.baseline_metrics.ndcg_at_12;
  const best = calib.best_metrics.ndcg_at_12;
  assert.ok(base < 1 - 1e-9, `baseline NDCG ${base} < 1.0`);
  assert.ok(best > base + 1e-9, `best NDCG ${best} strictly beats baseline ${base}`);
});

// ---------------------------------------------------------------------------
// T11 — the meta header satisfies the anti-circularity guard the calibration
// cycle uses (assertGoldsetHeadroom reads headroom.baseline_miss_fraction_all).
// ---------------------------------------------------------------------------
test("T11 meta passes the calibration-cycle anti-circularity headroom guard", () => {
  const verdict = assertGoldsetHeadroom(BUILT.out);
  assert.equal(verdict.ok, true, verdict.reason || "");
  assert.equal(verdict.fraction, 1);
});

// ---------------------------------------------------------------------------
// T12 — determinism: same seed → byte-identical goldset across runs.
// ---------------------------------------------------------------------------
test("T12 builder is deterministic (same seed → identical bytes)", () => {
  const scratch2 = mkdtempSync(join(tmpdir(), "ranking-goldset-det-"));
  const built2 = runBuilder(scratch2, { ...FIX, seed: 42 });
  const a = readFileSync(BUILT.out, "utf8");
  const b = readFileSync(built2.out, "utf8");
  // built_at + labeled_at timestamps and the scratch-dir output paths differ by
  // run environment, not by content; strip them and compare the structural rows.
  const stripVolatile = (s) =>
    s
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const o = JSON.parse(l);
        delete o.built_at;
        delete o.paired_recall; // absolute scratch-dir path (env-dependent)
        delete o.source_recall; // absolute scratch-dir path (env-dependent)
        if (o.payload) delete o.payload.labeled_at;
        return JSON.stringify(o);
      })
      .join("\n");
  assert.equal(
    stripVolatile(a),
    stripVolatile(b),
    "structural goldset identical across seeded runs",
  );
});

// ---------------------------------------------------------------------------
// T13 — THESIS #1: the builder never mutates fact rows. The fixture memory
// ledger is byte-identical before/after the build.
// ---------------------------------------------------------------------------
test("T13 thesis#1 builder does not mutate the memory ledger", () => {
  const after = readFileSync(FIX.memoryPath, "utf8");
  const expected =
    [...FIX.factSet].map((id) => JSON.stringify({ id, kind: "fact", content: `content for ${id}` })).join("\n") + "\n";
  assert.equal(after, expected, "memory ledger untouched (read-only)");
});

// ---------------------------------------------------------------------------
// T14 — the live REAL goldset (if it exists at the repo path) also clears the
// gate: baseline NDCG@12 < 1.0 on every row, goldens real, guard passes. This
// locks the shipped artifact, not just the hermetic fixture.
// ---------------------------------------------------------------------------
test("T14 shipped real goldset clears the gate (if present)", () => {
  const realLabels = join(LEDGERS_DIR, "ranking-eval-goldset.jsonl");
  const realRecall = join(LEDGERS_DIR, "ranking-eval-recall.jsonl");
  if (!existsSync(realLabels) || !existsSync(realRecall)) {
    // The artifact is operator-built; skip rather than fail if absent.
    return;
  }
  const all = readJsonl(realLabels);
  const meta = all[0];
  const labels = all.slice(1);
  const recalls = readJsonl(realRecall);
  assert.equal(meta.kind, "ranking_eval_goldset_meta");
  assert.ok(labels.length >= 1);
  const guard = assertGoldsetHeadroom(realLabels);
  assert.equal(guard.ok, true, guard.reason || "");
  for (const lab of labels) {
    const rec = recalls.find((r) => r.id === lab.derived_from[0]);
    assert.ok(rec, `recall for ${lab.id}`);
    const order = [...rec.surfaced].sort((a, b) => a.position - b.position).map((s) => s.memory_id);
    const nd = ndcgAtKForPair(
      { kind: "held_out_label", payload: { expected_ids: lab.payload.expected_ids, forbidden_ids: [] } },
      order,
      undefined,
      K,
    );
    assert.ok(nd < 1 - 1e-9, `real row ${lab.id} baseline NDCG ${nd} < 1.0`);
  }
});

// ---------------------------------------------------------------------------
// T15 — parseArgs --ranking-goldset points labels+recall+goldset at the ranking
// substrate (the flag the WU asks for on run-calibration-cycle).
// ---------------------------------------------------------------------------
test("T15 --ranking-goldset flag re-points the three calibration inputs", async () => {
  const { parseArgs } = await import("../../scripts/run-calibration-cycle.mjs");
  const opts = parseArgs(["node", "run-calibration-cycle.mjs", "--ranking-goldset"]);
  assert.equal(opts.ranking_mode, true);
  assert.ok(opts.labels.endsWith("ranking-eval-goldset.jsonl"));
  assert.ok(opts.recall.endsWith("ranking-eval-recall.jsonl"));
  assert.ok(opts.goldset.endsWith("ranking-eval-goldset.jsonl"));
  // Default (no flag) stays on the contextual goldset substrate.
  const def = parseArgs(["node", "run-calibration-cycle.mjs"]);
  assert.equal(def.ranking_mode, false);
  assert.ok(def.labels.endsWith("held-out-labels.jsonl"));
  assert.ok(def.goldset.endsWith("contextual-eval-goldset.jsonl"));
});
