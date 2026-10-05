// eval-gate-can-fail.test.mjs — F8 / A2.
//
// THE POINT OF THIS SUITE: prove `mcp/scripts/run-held-out-eval.mjs --assert`
// CAN FAIL. Before this node the script was a pure reporter — feeding it a
// substrate where the ranker surfaced twelve ids that appear in no label at
// all still produced exit 0 (measured: recall_at_12 / mrr / ndcg all 0,
// exit 0). An assertion that cannot fail is not a gate, so a case earns its
// place here by being anchored on a fixture whose expected exit code is
// DIFFERENT from what the pre-change script produced. Two later cases are
// deliberate boundary pins that do NOT meet that bar and say so by name — see
// below rather than reading this paragraph as covering all of them.
//
// Cases:
//   a. honest 13-label fixture + --assert            -> exit 0
//   b. same labels, fabricated surfaced[] + --assert -> exit 1, reason names recall
//   c. case (b) WITHOUT --assert                     -> exit 0, recall_at_12 === 0
//      (pins the default-off contract: the flag, not the metrics, decides)
//   d. 13 is_synthetic labels == surfaced[:3] + --assert -> exit 1,
//      SELF_REFERENTIAL_LABELS
//   e. 13 labels == surfaced[1:4] (a SHIFTED copy, stamped and unstamped)
//      + --assert                                    -> exit 1, 13/13
//   f. 12 synthetic + 1 honest label + --assert       -> exit 1, 12/13
//      …and its mirror, 1 synthetic + 12 honest       -> exit 0 + a WARNING
//      (the rule is a majority test; a gate that refuses everything is as
//      useless as the pure reporter it replaced)
//   g. 13 honest labels on 1-wide surfaced rows + --assert -> exit 0
//      (unjudgeable, not self-referential — the check must not refuse honest work)
//   h. the (e), (f), (j) and (k1) fixtures WITHOUT --assert -> exit 0
//   i. ONE width-1 honest label shape, two ranker qualities (13/13 hits and
//      3/13) + --assert -> the SAME self-reference verdict from both, and exit 0
//      on the good ranker. THE regression test for the inverted gate: the
//      width-1 window comparison had degenerated into the ranker's hit rate,
//      so labeling honestly and precisely got you refused 13/13 while a bad
//      ranker got you accepted.
//   j. 13 labels == surfaced[2:4] — a genuine WIDTH-2 window copy, neutral
//      labeler, 6-wide rows + --assert -> still exit 1, window_copy=13. The
//      floor's upper edge: it must narrow the check, not disable it.
//   k. mixed-density fixtures the all-6-wide cases above structurally cannot
//      express: 7 sparse (1-wide) rows + 6 dense honest labels, run twice.
//      k1 sparse half STAMPED   -> exit 1, provenance=7, 7/13
//      k2 sparse half UNSTAMPED -> exit 0, indeterminate=7, UNJUDGED 6/13
//
// Cases e-i were all measured against the pre-change script first: e and f
// exited 0 (bypasses), g exited 1 (a false positive on honest labels), and i's
// good-ranker arm exited 1 (the inversion). Each one's expected exit code is
// DIFFERENT from what the pre-change script produced, which is the standing bar
// for adding a case to this suite.
//
// Cases (j) and (k1) are DELIBERATE exceptions that do NOT meet that bar, and
// say so rather than implying otherwise: a width-2 window copy was refused
// before the floor and is refused after it, and a stamped sparse majority was
// caught on provenance before and after. They are boundary pins, not fixes —
// (j) fails if someone later raises MIN_WINDOW_COPY_WIDTH past 2 and thereby
// disables the check on the narrowest copies it can still see, and (k1) fails
// if the PROVENANCE > sparsity precedence is ever reordered so that a sparse
// row launders a generator stamp. (k2) does pin new arithmetic: the
// `narrow`/`indeterminate` denominator and the partially-unjudged warning.
//
// HERMETICITY (standing pattern, hard-gates.test.mjs:6-12): subprocess spawn
// plus mkdtemp fixtures only. No memory-system module is imported here, and
// EVERY spawn passes explicit --labels= and --recall= so the production
// defaults at run-held-out-eval.mjs:109-110 are never reached. Nothing under
// ledgers/, indices/ or policy/ is read or written by this suite.
//
// DELIBERATELY NOT ASSERTED: what the LIVE ledger does under --assert. Today
// that is exit 1 / SELF_REFERENTIAL_LABELS: 13/13, but the operator replacing
// the synthetic bootstrap with real labels is expected and out of scope for
// F8 — pinning the live result here would turn `npm test` red the moment the
// substrate got HONEST. That would be exactly backwards.
//
// Run: node test/eval-gate-can-fail.test.mjs

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "run-held-out-eval.mjs");

const N_LABELS = 13; // == ASSERT_CAPS.MIN_LABELS; below it INSUFFICIENT_LABELS fires.
const SURFACED_PER_ROW = 6; // > 3 so honest expected_ids can avoid the top-3 window.

const scratch = mkdtempSync(join(tmpdir(), "eval-gate-can-fail-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function surfacedRow(rowIdx, count, prefix) {
  return Array.from({ length: count }, (_, i) => ({
    memory_id: `mem_${prefix}_${rowIdx}_${i}`,
    score: 1 - i * 0.01,
    position: i,
    propensity: 0.5,
  }));
}

/** Honest fixture: a label that is GENUINELY INDEPENDENT of the ranking, not
 *  merely offset from it. Two expected ids come from surfaced positions 4-5
 *  and the third (`mem_missed_<r>`) was never surfaced at all, so the set is
 *  not equal to any contiguous window of surfaced[] at any offset. No
 *  metadata.is_synthetic, no bootstrap labeler.
 *
 *  This used to be `surfaced.slice(3, 6)` — a contiguous window at offset 3,
 *  structurally indistinguishable from the window-shifted copy case (e)
 *  refuses. That it scored recall_at_12 === 1 was itself the tell: an "honest"
 *  operator whose expectations are exactly a slice of the ranker's own output
 *  is not evidence about the ranker. The missed id is what makes recall 2/3
 *  and makes this fixture able to disagree with the ranker at all. */
function writeHonestFixture(dir) {
  const labels = [];
  const recalls = [];
  for (let r = 0; r < N_LABELS; r++) {
    const recallId = `rec_honest_${r}`;
    const surfaced = surfacedRow(r, SURFACED_PER_ROW, "real");
    recalls.push({ kind: "recall", id: recallId, ts: "2026-01-01T00:00:00.000Z", surfaced });
    labels.push(honestLabel(`holb_honest_${r}`, recallId, surfaced, r));
  }
  return writePair(dir, "honest", labels, recalls);
}

/** One independent label for a 6-wide surfaced row: positions 4 and 5 plus one
 *  id the ranker never returned. Shared by the honest fixture and by the single
 *  honest label inside the partial-contamination fixture (f). */
function honestLabel(labelId, recallId, surfaced, r) {
  return {
    id: labelId,
    kind: "held_out_label",
    derived_from: [recallId],
    ts: "2026-01-02T00:00:00.000Z",
    payload: {
      expected_ids: [surfaced[4].memory_id, surfaced[5].memory_id, `mem_missed_${r}`],
      forbidden_ids: [],
      abstain: false,
      labeled_at: "2026-01-02T00:00:00.000Z",
      labeler_notes: "operator-labeled fixture",
    },
    metadata: { labeler: "operator-fixture" },
  };
}

/** Junk fixture: the SAME honest labels, but every recall row's surfaced[] is
 *  replaced by twelve ids that appear in no label. The ranker returned pure
 *  noise; recall@12 is 0. */
function writeJunkFixture(dir) {
  const { labels, recalls } = readBack(writeHonestFixture(dir));
  const junked = recalls.map((row, r) => ({
    ...row,
    surfaced: surfacedRow(r, 12, "fabricated"),
  }));
  return writePair(dir, "junk", labels, junked);
}

/** All-synthetic fixture: what bootstrap-synthetic-held-out-labels.mjs emits
 *  — is_synthetic:true and expected_ids copied straight out of surfaced[:3].
 *  Every metric is tautologically perfect, which is the whole problem. */
function writeSyntheticFixture(dir) {
  const labels = [];
  const recalls = [];
  for (let r = 0; r < N_LABELS; r++) {
    const recallId = `rec_synth_${r}`;
    const surfaced = surfacedRow(r, SURFACED_PER_ROW, "real");
    recalls.push({ kind: "recall", id: recallId, ts: "2026-01-01T00:00:00.000Z", surfaced });
    labels.push({
      id: `holb_synth_${r}`,
      kind: "held_out_label",
      derived_from: [recallId],
      ts: "2026-01-02T00:00:00.000Z",
      payload: {
        expected_ids: surfaced.slice(0, 3).map((s) => s.memory_id),
        forbidden_ids: [],
        abstain: false,
        labeled_at: "2026-01-02T00:00:00.000Z",
        labeler_notes: "v0 synthetic bootstrap",
      },
      metadata: { is_synthetic: true, supersede_with_v1: true, labeler: "synthetic-v0-bootstrap" },
    });
  }
  return writePair(dir, "synthetic", labels, recalls);
}

/** Window-SHIFTED fixture (case e): expected_ids are surfaced[1:4] — still a
 *  verbatim contiguous slice of the ranker's own output, just not the offset-0
 *  window the old check hardcoded. `metadata` is a parameter so the same shape
 *  can be run twice: once carrying the bootstrap labeler (caught on provenance)
 *  and once with a neutral labeler (caught only by the any-offset window
 *  comparison, which is the branch this case exists to exercise).
 *
 *  `slice` is a parameter so case (j) can reuse this builder for the narrowest
 *  copy the width floor still judges — surfaced[2:4], width 2 — instead of
 *  cloning thirty lines to change two numbers. Default [1, 4] keeps every
 *  existing call site byte-identical. */
function writeShiftedFixture(dir, name, metadata, [sliceStart, sliceEnd] = [1, 4]) {
  const labels = [];
  const recalls = [];
  for (let r = 0; r < N_LABELS; r++) {
    const recallId = `rec_shift_${r}`;
    const surfaced = surfacedRow(r, SURFACED_PER_ROW, "real");
    recalls.push({ kind: "recall", id: recallId, ts: "2026-01-01T00:00:00.000Z", surfaced });
    labels.push({
      id: `holb_shift_${r}`,
      kind: "held_out_label",
      derived_from: [recallId],
      ts: "2026-01-02T00:00:00.000Z",
      payload: {
        expected_ids: surfaced.slice(sliceStart, sliceEnd).map((s) => s.memory_id),
        forbidden_ids: [],
        abstain: false,
        labeled_at: "2026-01-02T00:00:00.000Z",
        labeler_notes: `window-shifted copy of the ranking (surfaced[${sliceStart}:${sliceEnd}])`,
      },
      metadata,
    });
  }
  return writePair(dir, name, labels, recalls);
}

/** Partial-contamination fixture (case f): 12 synthetic labels + 1 genuinely
 *  independent one. Under the old all-or-nothing rule that single honest label
 *  silenced the check entirely. The honest label must be independent, not just
 *  offset — reusing honestLabel() keeps it out of the window comparison so the
 *  refusal reads 12/13 rather than 13/13. */
function writePartialFixture(dir) {
  const labels = [];
  const recalls = [];
  for (let r = 0; r < N_LABELS; r++) {
    const recallId = `rec_part_${r}`;
    const surfaced = surfacedRow(r, SURFACED_PER_ROW, "real");
    recalls.push({ kind: "recall", id: recallId, ts: "2026-01-01T00:00:00.000Z", surfaced });
    if (r === 0) {
      labels.push(honestLabel(`holb_part_${r}`, recallId, surfaced, r));
      continue;
    }
    labels.push({
      id: `holb_part_${r}`,
      kind: "held_out_label",
      derived_from: [recallId],
      ts: "2026-01-02T00:00:00.000Z",
      payload: {
        expected_ids: surfaced.slice(0, 3).map((s) => s.memory_id),
        forbidden_ids: [],
        abstain: false,
        labeled_at: "2026-01-02T00:00:00.000Z",
        labeler_notes: "v0 synthetic bootstrap",
      },
      metadata: { is_synthetic: true, supersede_with_v1: true, labeler: "synthetic-v0-bootstrap" },
    });
  }
  return writePair(dir, "partial", labels, recalls);
}

/** Minority-contamination fixture (case f, second half): the mirror of
 *  writePartialFixture — 1 synthetic label among 12 independent ones. Below the
 *  refusal threshold, so it must WARN and still exit 0. Without this the gate
 *  could be silently retuned to refuse on any contamination at all, and a rule
 *  that refuses everything is as useless as the pure reporter it replaced. */
function writeMinorityFixture(dir) {
  const { labels, recalls } = readBack(writePartialFixture(dir));
  const flipped = labels.map((label, r) =>
    r === 0
      ? {
          ...label,
          payload: { ...label.payload, expected_ids: recalls[r].surfaced.slice(0, 3).map((s) => s.memory_id) },
          metadata: { is_synthetic: true, supersede_with_v1: true, labeler: "synthetic-v0-bootstrap" },
        }
      : honestLabel(label.id, label.derived_from[0], recalls[r].surfaced, r),
  );
  return writePair(dir, "minority", flipped, recalls);
}

/** Sparse-honest fixture (case g): every recall row surfaced exactly ONE id and
 *  the operator honestly labeled that id. expected == surfaced trivially, but
 *  there was nothing else to name — this is an unjudgeable row, not a copy. The
 *  pre-change rule refused all 13 of these. 93 of the 280 rows in the live
 *  recall ledger surface fewer than 4 ids, so this is the common shape, not a
 *  corner case. */
function writeSparseHonestFixture(dir) {
  const labels = [];
  const recalls = [];
  for (let r = 0; r < N_LABELS; r++) {
    const recallId = `rec_sparse_${r}`;
    const surfaced = surfacedRow(r, 1, "real");
    recalls.push({ kind: "recall", id: recallId, ts: "2026-01-01T00:00:00.000Z", surfaced });
    labels.push({
      id: `holb_sparse_${r}`,
      kind: "held_out_label",
      derived_from: [recallId],
      ts: "2026-01-02T00:00:00.000Z",
      payload: {
        expected_ids: [surfaced[0].memory_id],
        forbidden_ids: [],
        abstain: false,
        labeled_at: "2026-01-02T00:00:00.000Z",
        labeler_notes: "operator-labeled fixture",
      },
      metadata: { labeler: "operator-fixture" },
    });
  }
  return writePair(dir, "sparse", labels, recalls);
}

/** Width-1 honest fixture (case i): the operator names the ONE memory that was
 *  actually right for each of 13 DENSE (6-wide) rows. No synthetic stamps.
 *
 *  `hits` moves the RANKER, never the labels: the labels this returns are
 *  byte-identical for every value of `hits`, and only the first `hits` recall
 *  rows put the named memory at position 0. That separation is the whole case —
 *  a self-reference verdict that changes when only the ranker changed is not
 *  measuring the labels at all. Pre-floor, hits=13 produced
 *  `SELF_REFERENTIAL_LABELS: 13/13 window_copy=13` and hits=3 passed. */
function writeWidthOneFixture(dir, name, hits) {
  const labels = [];
  const recalls = [];
  for (let r = 0; r < N_LABELS; r++) {
    const recallId = `rec_w1_${r}`;
    const surfaced = surfacedRow(r, SURFACED_PER_ROW, "real");
    if (r < hits) surfaced[0].memory_id = `mem_target_${r}`;
    recalls.push({ kind: "recall", id: recallId, ts: "2026-01-01T00:00:00.000Z", surfaced });
    labels.push({
      id: `holb_w1_${r}`,
      kind: "held_out_label",
      derived_from: [recallId],
      ts: "2026-01-02T00:00:00.000Z",
      payload: {
        expected_ids: [`mem_target_${r}`],
        forbidden_ids: [],
        abstain: false,
        labeled_at: "2026-01-02T00:00:00.000Z",
        labeler_notes: "operator named the one memory that was actually right",
      },
      metadata: { labeler: "operator-fixture" },
    });
  }
  return writePair(dir, name, labels, recalls);
}

/** Mixed-density fixture (case k): SPARSE_ROWS 1-wide rows followed by dense
 *  6-wide honest ones. Every other fixture in this suite is uniformly 6-wide or
 *  uniformly 1-wide, so none of them can express the interaction between the
 *  sparse-row exclusion and the rest of the denominator — which is exactly
 *  where a laundering path would hide.
 *
 *  `sparseMetadata` decides which arm this is: the bootstrap stamp (k1, caught
 *  on provenance BEFORE sparsity is even consulted) or a neutral labeler (k2,
 *  excluded as indeterminate and dropped from the denominator). The dense half
 *  reuses honestLabel() unchanged, so in both arms the honest labels are the
 *  same six labels — only the sparse half's provenance moves. */
const SPARSE_ROWS = 7; // > N_LABELS/2, so the stamped arm clears MAX_SELF_REF_FRACTION.

function writeMixedDensityFixture(dir, name, sparseMetadata) {
  const labels = [];
  const recalls = [];
  for (let r = 0; r < N_LABELS; r++) {
    const recallId = `rec_mixed_${r}`;
    if (r < SPARSE_ROWS) {
      const surfaced = surfacedRow(r, 1, "real");
      recalls.push({ kind: "recall", id: recallId, ts: "2026-01-01T00:00:00.000Z", surfaced });
      labels.push({
        id: `holb_mixed_${r}`,
        kind: "held_out_label",
        derived_from: [recallId],
        ts: "2026-01-02T00:00:00.000Z",
        payload: {
          expected_ids: [surfaced[0].memory_id],
          forbidden_ids: [],
          abstain: false,
          labeled_at: "2026-01-02T00:00:00.000Z",
          labeler_notes: "single surfaced id on a 1-wide row",
        },
        metadata: sparseMetadata,
      });
      continue;
    }
    const surfaced = surfacedRow(r, SURFACED_PER_ROW, "real");
    recalls.push({ kind: "recall", id: recallId, ts: "2026-01-01T00:00:00.000Z", surfaced });
    labels.push(honestLabel(`holb_mixed_${r}`, recallId, surfaced, r));
  }
  return writePair(dir, name, labels, recalls);
}

function writePair(dir, name, labels, recalls) {
  const labelsPath = join(dir, `${name}-labels.jsonl`);
  const recallPath = join(dir, `${name}-recall.jsonl`);
  writeFileSync(labelsPath, labels.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  writeFileSync(recallPath, recalls.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return { labelsPath, recallPath, labels, recalls };
}

function readBack(fixture) {
  return { labels: fixture.labels, recalls: fixture.recalls };
}

/** Always passes explicit --labels/--recall: the production defaults must
 *  never be reached from a test. */
function runEval({ labelsPath, recallPath }, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [SCRIPT, `--labels=${labelsPath}`, `--recall=${recallPath}`, ...extraArgs],
    { encoding: "utf8" },
  );
}

test("a. honest labels + --assert -> exit 0", () => {
  const fx = writeHonestFixture(scratch);
  const res = runEval(fx, ["--assert"]);
  assert.equal(
    res.status,
    0,
    `expected exit 0 on an honest fixture; got ${res.status}\nstderr:\n${res.stderr}`,
  );
  assert.doesNotMatch(res.stderr, /PROMOTE REFUSED/);
  assert.doesNotMatch(res.stderr, /SELF_REFERENTIAL_LABELS/);
  const metrics = JSON.parse(res.stdout);
  assert.equal(metrics.n_labels_used, N_LABELS);
  // 2 of the 3 expected ids were surfaced; the third never was. An honest eval
  // scoring exactly 1.0 was the tell that the old fixture was a copy of the
  // ranking rather than an independent judgement of it.
  assert.equal(metrics.recall_at_12, 2 / 3);
  assert.ok(
    metrics.bootstrap_ci.recall[0] > 0,
    `honest fixture must keep a positive recall lower bound; got ${metrics.bootstrap_ci.recall[0]}`,
  );
});

test("b. fabricated surfaced[] + --assert -> exit 1 naming recall", () => {
  const fx = writeJunkFixture(scratch);
  const res = runEval(fx, ["--assert"]);
  assert.equal(
    res.status,
    1,
    `the gate MUST refuse a substrate with zero recall; got exit ${res.status}\nstderr:\n${res.stderr}`,
  );
  assert.match(res.stderr, /PROMOTE REFUSED/);
  assert.match(res.stderr, /recall/);
  assert.match(res.stderr, /RECALL_CI_LOWER_BOUND_NOT_POSITIVE/);
});

test("c. same junk fixture WITHOUT --assert -> exit 0, metrics still emitted", () => {
  const fx = writeJunkFixture(scratch);
  const res = runEval(fx);
  assert.equal(
    res.status,
    0,
    `default-off contract broken: no --assert must still exit 0; got ${res.status}\nstderr:\n${res.stderr}`,
  );
  assert.doesNotMatch(res.stderr, /PROMOTE REFUSED/);
  const metrics = JSON.parse(res.stdout);
  assert.equal(metrics.recall_at_12, 0);
  assert.equal(metrics.n_labels_used, N_LABELS);
});

test("d. all-synthetic labels + --assert -> exit 1 SELF_REFERENTIAL_LABELS", () => {
  const fx = writeSyntheticFixture(scratch);
  const res = runEval(fx, ["--assert"]);
  assert.equal(
    res.status,
    1,
    `a label set copied from the ranker's own top-3 MUST be refused; got exit ${res.status}\nstderr:\n${res.stderr}`,
  );
  assert.match(res.stderr, /PROMOTE REFUSED/);
  assert.match(res.stderr, /SELF_REFERENTIAL_LABELS/);
  assert.match(res.stderr, new RegExp(`SELF_REFERENTIAL_LABELS: ${N_LABELS}/${N_LABELS} `));
  // The metrics themselves look perfect — that is precisely why the metric
  // thresholds alone could never have caught this.
  const metrics = JSON.parse(res.stdout);
  assert.equal(metrics.recall_at_12, 1);
});

test("e. window-SHIFTED copy of surfaced[] + --assert -> exit 1", () => {
  // Measured against the pre-change script: BOTH of these exited 0. The check
  // only compared expected_ids to surfaced[:3], so shifting the copied window
  // by one position laundered a fully tautological label set.
  const stamped = writeShiftedFixture(scratch, "shifted", { labeler: "synthetic-v0-bootstrap" });
  const resStamped = runEval(stamped, ["--assert"]);
  assert.equal(
    resStamped.status,
    1,
    `a shifted copy of the ranking MUST be refused; got exit ${resStamped.status}\nstderr:\n${resStamped.stderr}`,
  );
  assert.match(resStamped.stderr, /PROMOTE REFUSED/);
  assert.match(resStamped.stderr, new RegExp(`SELF_REFERENTIAL_LABELS: ${N_LABELS}/${N_LABELS} `));
  assert.match(resStamped.stderr, /provenance=13/);

  // Same fixture with a NEUTRAL labeler: no provenance stamp anywhere, so the
  // only thing that can catch it is the any-offset window comparison. Without
  // this half, the window_copy branch would never be exercised by the suite.
  const neutral = writeShiftedFixture(scratch, "shifted-neutral", { labeler: "operator-fixture" });
  const resNeutral = runEval(neutral, ["--assert"]);
  assert.equal(
    resNeutral.status,
    1,
    `an unstamped shifted copy MUST still be refused; got exit ${resNeutral.status}\nstderr:\n${resNeutral.stderr}`,
  );
  assert.match(resNeutral.stderr, new RegExp(`SELF_REFERENTIAL_LABELS: ${N_LABELS}/${N_LABELS} `));
  assert.match(resNeutral.stderr, /window_copy=13/);
});

test("f. 12 synthetic + 1 honest label + --assert -> exit 1, 12/13", () => {
  // Measured against the pre-change script: exit 0. The old aggregate refused
  // only when EVERY joined label was self-referential, so one honest label
  // silenced the check for the other twelve.
  const fx = writePartialFixture(scratch);
  const res = runEval(fx, ["--assert"]);
  assert.equal(
    res.status,
    1,
    `a majority-synthetic label set MUST be refused; got exit ${res.status}\nstderr:\n${res.stderr}`,
  );
  assert.match(res.stderr, /PROMOTE REFUSED/);
  assert.match(res.stderr, new RegExp(`SELF_REFERENTIAL_LABELS: 12/${N_LABELS} `));
  assert.match(res.stderr, /provenance=12/);
  assert.match(res.stderr, /window_copy=0/);

  // The mirror image: 1 synthetic among 12 independent labels is BELOW the
  // threshold. It must warn and still exit 0 — the rule is a majority test,
  // not "any contamination refuses". A gate that refuses every substrate is as
  // useless as the pure reporter this replaced, so this direction is pinned too.
  const minority = writeMinorityFixture(scratch);
  const resMinority = runEval(minority, ["--assert"]);
  assert.equal(
    resMinority.status,
    0,
    `minority contamination must NOT refuse; got exit ${resMinority.status}\nstderr:\n${resMinority.stderr}`,
  );
  assert.doesNotMatch(resMinority.stderr, /PROMOTE REFUSED/);
  assert.match(resMinority.stderr, new RegExp(`SELF_REFERENCE_SUBTHRESHOLD: 1/${N_LABELS} `));
  // ANCHOR PROPERTY, asserted rather than asserted-in-a-comment: the refusal
  // token must not appear on a passing run. The warning used to be spelled
  // SELF_REFERENTIAL_LABELS_SUBTHRESHOLD, so `grep SELF_REFERENTIAL_LABELS`
  // matched this exit-0 run as a prefix. This line is what makes the rename
  // falsifiable — flip the token back and it fails here.
  assert.doesNotMatch(resMinority.stderr, /SELF_REFERENTIAL_LABELS/);
});

test("g. honest labels on SPARSE rows + --assert -> exit 0 (no false positive)", () => {
  // Measured against the pre-change script: exit 1, SELF_REFERENTIAL_LABELS
  // 13/13. Every row surfaced exactly one id, so an honest label naming that
  // id was indistinguishable from a copy under the old rule. Refusing honest
  // work is the failure mode that makes an operator stop trusting the gate.
  const fx = writeSparseHonestFixture(scratch);
  const res = runEval(fx, ["--assert"]);
  assert.equal(
    res.status,
    0,
    `honest labels on 1-wide rows must NOT be refused; got exit ${res.status}\nstderr:\n${res.stderr}`,
  );
  assert.doesNotMatch(res.stderr, /PROMOTE REFUSED/);
  assert.doesNotMatch(res.stderr, /SELF_REFERENTIAL_LABELS/);
  // Unjudged is reported, not silently passed: the operator learns the check
  // could not run rather than reading exit 0 as a clean bill of health.
  assert.match(res.stderr, /SELF_REFERENCE_UNJUDGED: 0\/13 /);
  assert.match(res.stderr, /indeterminate=13/);
});

test("h. every refusable fixture WITHOUT --assert -> exit 0 (default-off parity)", () => {
  // The flag, not the substrate, decides the exit code. Every tightening above
  // lives inside `if (opts.assert)`; without it these refusable fixtures must
  // still exit 0 and still emit their metrics JSON. The width floor is a
  // NARROWING of that same branch — no new flag — so the newly-refusable
  // fixtures (j, k1) belong in this loop too.
  for (const fx of [
    writeShiftedFixture(scratch, "shifted", { labeler: "synthetic-v0-bootstrap" }),
    writeShiftedFixture(scratch, "shifted-neutral", { labeler: "operator-fixture" }),
    writePartialFixture(scratch),
    writeShiftedFixture(scratch, "width2", { labeler: "operator-fixture" }, [2, 4]),
    writeMixedDensityFixture(scratch, "mixed-stamped", {
      is_synthetic: true,
      supersede_with_v1: true,
      labeler: "synthetic-v0-bootstrap",
    }),
  ]) {
    const res = runEval(fx);
    assert.equal(
      res.status,
      0,
      `default-off contract broken for ${fx.labelsPath}; got ${res.status}\nstderr:\n${res.stderr}`,
    );
    assert.doesNotMatch(res.stderr, /PROMOTE REFUSED/);
    assert.doesNotMatch(res.stderr, /SELF_REFERENTIAL_LABELS/);
    const metrics = JSON.parse(res.stdout);
    assert.equal(metrics.n_labels_used, N_LABELS);
  }
});

test("i. width-1 honest labels: the self-reference verdict must not move with the ranker", () => {
  // THE regression test for the inverted gate. Measured against the pre-change
  // script on this exact fixture shape: hits=13 -> exit 1,
  // `SELF_REFERENTIAL_LABELS: 13/13 … window_copy=13`; hits=3 -> exit 0. An
  // operator who labeled honestly and precisely was accused of copying in
  // PROPORTION to how well recall performed, which is a gate pointing backwards.
  //
  // The labels are identical in both arms; only the recall rows differ. So any
  // difference in the self-reference verdict between the two arms is, by
  // construction, the check reading the ranker instead of the labels.
  const DEGRADED_HITS = 3; // measured below: keeps bootstrap_ci.recall[0] > 0.
  const perfect = writeWidthOneFixture(scratch, "w1-perfect", N_LABELS);
  const degraded = writeWidthOneFixture(scratch, "w1-degraded", DEGRADED_HITS);
  assert.deepEqual(
    perfect.labels,
    degraded.labels,
    "the two arms must differ ONLY in the ranker; identical labels is the premise of this case",
  );

  const resPerfect = runEval(perfect, ["--assert"]);
  const resDegraded = runEval(degraded, ["--assert"]);

  assert.equal(
    resPerfect.status,
    0,
    `honest width-1 labels against a GOOD ranker must not be refused; got exit ${resPerfect.status}\nstderr:\n${resPerfect.stderr}`,
  );
  assert.doesNotMatch(resPerfect.stderr, /PROMOTE REFUSED/);

  // The degraded arm is chosen so the RECALL condition cannot confound the
  // reading: 3/13 hits still leaves a positive bootstrap lower bound, so if this
  // arm ever refuses it is about self-reference, not about recall. bootstrapCI
  // seeds off vals.length (eval-harness.js:389), so this is deterministic.
  const degradedMetrics = JSON.parse(resDegraded.stdout);
  assert.ok(
    degradedMetrics.bootstrap_ci.recall[0] > 0,
    `the degraded arm must isolate self-reference from the recall condition; got lower bound ${degradedMetrics.bootstrap_ci.recall[0]}`,
  );
  assert.equal(
    resDegraded.status,
    0,
    `the degraded arm must also pass; got exit ${resDegraded.status}\nstderr:\n${resDegraded.stderr}`,
  );

  // INVARIANCE: same verdict, same counts, from both rankers.
  for (const [arm, res] of [["perfect", resPerfect], ["degraded", resDegraded]]) {
    assert.doesNotMatch(
      res.stderr,
      /SELF_REFERENTIAL_LABELS/,
      `honest width-1 labels must never be called self-referential (${arm} arm)\nstderr:\n${res.stderr}`,
    );
    assert.match(res.stderr, /window_copy=0/, `${arm} arm\nstderr:\n${res.stderr}`);
    assert.match(res.stderr, /narrow=13/, `${arm} arm\nstderr:\n${res.stderr}`);
    // Exit 0 is NOT sold as a clean self-reference bill of health: the whole
    // set left the denominator, and the operator is told so.
    assert.match(
      res.stderr,
      /SELF_REFERENCE_UNJUDGED: 0\/13 /,
      `${arm} arm must announce the unjudged set\nstderr:\n${res.stderr}`,
    );
  }
});

test("j. a genuine WIDTH-2 window copy is still refused (the floor's upper edge)", () => {
  // NOT a behavior change: this fixture was refused before the width floor and
  // is refused after it. It exists so that raising MIN_WINDOW_COPY_WIDTH above
  // 2 — the easy way to make a noisy check quiet — fails a test instead of
  // silently blinding the comparison on its narrowest judgeable case.
  // Neutral labeler, so provenance cannot be what catches it; 6-wide rows, so
  // the sparse exclusion cannot fire either. Only the window loop can refuse.
  const fx = writeShiftedFixture(scratch, "width2", { labeler: "operator-fixture" }, [2, 4]);
  const res = runEval(fx, ["--assert"]);
  assert.equal(
    res.status,
    1,
    `a width-2 contiguous copy of the ranking MUST still be refused; got exit ${res.status}\nstderr:\n${res.stderr}`,
  );
  assert.match(res.stderr, /PROMOTE REFUSED/);
  assert.match(res.stderr, new RegExp(`SELF_REFERENTIAL_LABELS: ${N_LABELS}/${N_LABELS} `));
  assert.match(res.stderr, /window_copy=13/);
  assert.match(res.stderr, /provenance=0/);
  assert.match(res.stderr, /narrow=0/);
});

test("k. mixed density: sparsity must not launder a stamp, nor drag honest labels down", () => {
  // k1 — 7 SPARSE stamped rows + 6 DENSE honest labels. The sparse exclusion
  // runs AFTER the provenance check, so the stamped rows stay in the
  // denominator and the majority rule fires: 7/13 >= 0.5.
  const stamped = writeMixedDensityFixture(scratch, "mixed-stamped", {
    is_synthetic: true,
    supersede_with_v1: true,
    labeler: "synthetic-v0-bootstrap",
  });
  const resStamped = runEval(stamped, ["--assert"]);
  assert.equal(
    resStamped.status,
    1,
    `a sparse row must not launder the generator's stamp; got exit ${resStamped.status}\nstderr:\n${resStamped.stderr}`,
  );
  assert.match(resStamped.stderr, /PROMOTE REFUSED/);
  assert.match(resStamped.stderr, new RegExp(`SELF_REFERENTIAL_LABELS: ${SPARSE_ROWS}/${N_LABELS} `));
  assert.match(resStamped.stderr, new RegExp(`provenance=${SPARSE_ROWS}`));
  assert.match(resStamped.stderr, /indeterminate=0/);

  // k2 — the SAME 7 sparse rows unstamped, naming the single id their row
  // surfaced, plus the same 6 dense honest labels. Now the sparse rows are
  // unjudgeable: they leave the denominator (13 -> 6) without dragging the six
  // honest dense labels into a refusal, and the warning reports the survivors.
  const neutral = writeMixedDensityFixture(scratch, "mixed-neutral", { labeler: "operator-fixture" });
  const resNeutral = runEval(neutral, ["--assert"]);
  assert.equal(
    resNeutral.status,
    0,
    `unjudgeable sparse rows must not refuse honest dense labels; got exit ${resNeutral.status}\nstderr:\n${resNeutral.stderr}`,
  );
  assert.doesNotMatch(resNeutral.stderr, /PROMOTE REFUSED/);
  assert.doesNotMatch(resNeutral.stderr, /SELF_REFERENTIAL_LABELS/);
  assert.match(
    resNeutral.stderr,
    new RegExp(`SELF_REFERENCE_UNJUDGED: ${N_LABELS - SPARSE_ROWS}/${N_LABELS} `),
  );
  assert.match(resNeutral.stderr, new RegExp(`indeterminate=${SPARSE_ROWS}`));
  // contaminated === 0: nothing here came from the ranker, so neither the
  // refusal nor the sub-threshold warning may fire.
  assert.match(resNeutral.stderr, /provenance=0/);
  assert.match(resNeutral.stderr, /window_copy=0/);
  assert.doesNotMatch(resNeutral.stderr, /SELF_REFERENCE_SUBTHRESHOLD/);
});
