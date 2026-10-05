#!/usr/bin/env node
// run-held-out-eval.mjs — CI-callable wrapper around the offline-eval
// harness (F-SYN-OPERATIONAL-offline-eval-harness, Wave 11).
//
// Spec: docs/specs/synthesis/held-out-labeled-set.md
//   - § 6 (eval metrics)
//   - § 9 (CI gate — promotion refusal)
//
// CLI:
//   node mcp/scripts/run-held-out-eval.mjs
//       [--labels=<path>] [--recall=<path>] [--output=<path>] [--assert]
//
// Defaults:
//   --labels  = <MEMORY_ROOT>/ledgers/held-out-labels.jsonl  (index file)
//   --recall  = <MEMORY_ROOT>/ledgers/recall.jsonl            (soak substrate)
//   --output  = stdout (write JSON to disk only if --output is provided)
//   --assert  = OFF. When absent this script is a pure reporter: it emits
//               metrics and exits 0 no matter how bad the metrics are.
//
// Exit codes:
//   0 — eval ran; metrics JSON emitted. Under --assert, additionally: no
//       refusal condition fired (PROMOTE OK for the conditions checked below).
//       An exit-0 run may still print `run-held-out-eval: WARNING <TOKEN>: …`
//       lines on stderr; warnings never change the exit code and the
//       `PROMOTE REFUSED` header never appears on one.
//   1 — labels file missing (the gate cannot run; the operator must label
//       the held-out set first per held-out-labeled-set.md § 5), OR the eval
//       itself threw, OR — under --assert only — PROMOTE REFUSED: at least
//       one refusal condition fired. Every failed condition is named on
//       stderr, one indented line each, after a `PROMOTE REFUSED` header.
//
// WHAT --assert ENFORCES (and what it deliberately does NOT)
//   Spec: docs/specs/synthesis/held-out-labeled-set.md § 9.1 (line 451) —
//   "exit 0 (PROMOTE OK) iff: Recall@12 lower-bound > 0 AND NDCG@12
//   lower-bound >= 0 AND Abstain F1 lower-bound >= 0 AND harm rate
//   upper-bound <= baseline harm rate."
//
//   A spec is a claim about the code, so this header states the gap rather
//   than implying full § 9.1 compliance. --assert enforces:
//     - Recall@12 bootstrap CI lower bound > 0            (§ 9.1 condition 1)
//     - harm rate == 0                                    (§ 9.1 condition 4,
//       degenerate single-run form: with no baseline run the only harm rate
//       provably <= baseline is zero)
//     - a minimum joined-label count (n_labels_used >= ASSERT_CAPS.MIN_LABELS)
//     - non-self-referential labels — NOT in § 9.1; added because a label set
//       synthesized from the ranker's own top-K makes every § 9.1 metric
//       tautologically 1.0. A joined (label, recall) pair is contaminated when
//       EITHER it carries the synthetic generator's provenance (is_synthetic,
//       supersede_with_v1, or labeler == BOOTSTRAP_CAPS.LABELER_NAME) OR its
//       expected_ids are set-equal to a contiguous window of that row's
//       surfaced[] at any offset AND name at least
//       ASSERT_CAPS.MIN_WINDOW_COPY_WIDTH ids. TWO kinds of pair are
//       UNJUDGEABLE and are excluded from the denominator — not counted as
//       clean, and not counted as contaminated either:
//         · the ROW is too narrow — it surfaced fewer than
//           ASSERT_CAPS.MIN_JUDGEABLE_SURFACED ids, so an honest label had no
//           alternative to name (reported as `indeterminate`);
//         · the LABEL is too narrow — it names fewer than
//           ASSERT_CAPS.MIN_WINDOW_COPY_WIDTH ids, so there is no ordering in
//           it to have been copied (reported as `narrow`).
//       Exclusion precedence is PROVENANCE > sparsity > width > window: a
//       stamped label is caught whatever its shape. --assert refuses when
//       contaminated / judgeable >= ASSERT_CAPS.MAX_SELF_REF_FRACTION, i.e. a
//       simple majority, not unanimity. Sub-threshold contamination and any
//       unjudgeable pairs are reported as non-refusing WARNING lines, so exit 0
//       on an unjudgeable substrate is never a clean bill of health.
//
//   The window comparison is a heuristic, and the width floor is where its
//   false-positive rate is bounded. For an honest label naming w ids against a
//   k-wide ranking, the chance its id set coincidentally equals SOME contiguous
//   w-window is (k-w+1)/C(k,w). At w=1 that is exactly 1.0 — every single-id
//   label matches a 1-wide window of any ranking that surfaced it, so the
//   comparison was not measuring independence at all, it was measuring the
//   ranker's hit rate: 13 honest operator labels naming the one right memory
//   each were refused 13/13 by a good ranker and accepted by a bad one. At
//   w=2, k=6 the residual is 5/15 = 0.33 — still a weak signal, and the honest
//   cost this gate accepts; w=2 is simply the narrowest set on which the
//   comparison can FAIL at all, which is why the floor is 2 and not higher.
//   Above the floor the original trade stands — a generator variant copying
//   surfaced[1:4] used to pass — so operator labels of width >= 2 must differ
//   from the ranking somewhere to be recognized as independent.
//
//   --assert does NOT enforce, and no caller may read exit 0 as evidence of:
//     - NDCG@12 lower bound >= 0        (§ 9.1 condition 2) — unchecked.
//     - Abstain F1 lower bound >= 0     (§ 9.1 condition 3) — unchecked; the
//       harness returns a point Abstain F1, not a bootstrap CI, so the lower
//       bound named by the spec is not computable here.
//     - harm rate upper bound <= BASELINE harm rate (§ 9.1 condition 4 in its
//       true, baseline-relative form) — this single-run CLI has no baseline
//       to compare against. The full baseline-vs-candidate gate the spec
//       describes (`--baseline v0 --candidate v1`) does not exist yet.
//
//   Making the substrate honest is out of scope here: --assert makes a
//   tautological label set REFUSABLE, it does not make it truthful.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { evaluate, EVAL_HARNESS_VERSION } from "../lib/synthesis/eval-harness.js";
import { LEDGERS_DIR } from "../lib/config.js";
// BOOTSTRAP_CAPS.TOP_K_EXPECTED is the window the synthetic bootstrap copies
// out of surfaced[] (`synthesizeLabel`: surfaced.slice(0, TOP_K_EXPECTED)).
// Binding the self-reference check to that export instead of hardcoding 3
// keeps the two in lock-step if the generator's window ever changes. The
// generator's main() is guarded by a real-path is-main check, so
// importing it here does not run it.
import { BOOTSTRAP_CAPS } from "./bootstrap-synthetic-held-out-labels.mjs";

// Data root comes from lib/config.js (MEMORY_ROOT, default: this checkout),
// never from the home directory.
const DEFAULT_LABELS = join(LEDGERS_DIR, "held-out-labels.jsonl");
const DEFAULT_RECALL = join(LEDGERS_DIR, "recall.jsonl");

// Thresholds the --assert gate refuses below. MIN_LABELS is a floor on the
// joined (label, recall) pair count: below it the bootstrap CI is resampling
// too few distinct events to mean anything. TOP_K_EXPECTED is NOT a local
// choice — it is the synthetic generator's own window, imported so the
// self-reference check cannot drift away from what it is detecting.
const ASSERT_CAPS = Object.freeze({
  MIN_LABELS: 13,
  TOP_K_EXPECTED: BOOTSTRAP_CAPS.TOP_K_EXPECTED,
  // Refuse at or above this contaminated share of the JUDGEABLE labels. Not
  // 1.0: a set where a single honest label is buried among synthetic ones is
  // contaminated, and the old all-or-nothing rule let exactly that through.
  MAX_SELF_REF_FRACTION: 0.5,
  // A recall row must have surfaced MORE ids than the window the generator
  // copies for "expected == a window of surfaced" to be evidence of copying.
  // On a row that surfaced 1-3 ids there is nothing else an honest labeler
  // could have named, so such rows are unjudgeable, not guilty. Derived from
  // the generator's own window for the same lock-step reason as TOP_K_EXPECTED.
  MIN_JUDGEABLE_SURFACED: BOOTSTRAP_CAPS.TOP_K_EXPECTED + 1,
  // Minimum expected_ids WIDTH at which "expected == a contiguous window of
  // surfaced[]" is evidence rather than arithmetic. A derivation, not a taste
  // call: for an honest w-id label against a k-wide ranking, the probability
  // that its id set coincidentally equals SOME contiguous w-window is
  // (k-w+1)/C(k,w) — there are k-w+1 windows among C(k,w) equally likely
  // subsets. At w=1 that is exactly (k-1+1)/k = 1.0, i.e. a width-1 match
  // carries ZERO ordering evidence and says only "the ranker surfaced the right
  // answer"; that is why the pre-floor check degenerated into the ranker's own
  // hit rate. The residual is stated rather than hidden: at w=2, k=6 it is
  // 5/15 = 0.33, still a weak signal. 2 is the LOWEST width at which the
  // comparison can fail at all, and that is why the floor is 2 rather than
  // higher — raising it would buy precision by blinding the check to the narrow
  // copies it exists to catch.
  //
  // Deliberately NOT derived from BOOTSTRAP_CAPS.TOP_K_EXPECTED, unlike
  // TOP_K_EXPECTED and MIN_JUDGEABLE_SURFACED above, which are lock-stepped to
  // the generator on purpose. This is an independent evidentiary floor about
  // what a set comparison can prove at all; tying it to the generator's window
  // would let a generator change silently widen the blind spot.
  MIN_WINDOW_COPY_WIDTH: 2,
});

function parseArgs(argv) {
  const opts = {
    labels: DEFAULT_LABELS,
    recall: DEFAULT_RECALL,
    output: null,
    assert: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--labels=")) opts.labels = arg.slice("--labels=".length);
    else if (arg.startsWith("--recall=")) opts.recall = arg.slice("--recall=".length);
    else if (arg.startsWith("--output=")) opts.output = arg.slice("--output=".length);
    else if (arg === "--assert") opts.assert = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: run-held-out-eval.mjs [--labels=path] [--recall=path] [--output=path] [--assert]\n" +
          "  --assert  exit 1 (PROMOTE REFUSED) when a refusal condition fires;\n" +
          "            default OFF — without it this script always exits 0.\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`run-held-out-eval: unknown arg ${arg}\n`);
      process.exit(2);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// --assert audit helpers (module-private)
//
// DELIBERATE THIRD COPY. eval-harness.js keeps readJsonl (:79),
// indexRecallById (:105), joinPairs (:124) and surfacedIdsFromRecall (:144)
// module-private and does not export the joined pairs, and this node's blast
// radius forbids editing that file. calibration-loop.js:344 already carries
// its own copy for the same reason; this is the third. The alternative —
// widening eval-harness.js's public surface — is a larger change to the one
// module that computes the promotion metrics.
//
// All of this runs ONLY inside the --assert branch, so the default path does
// zero extra I/O.
// ---------------------------------------------------------------------------

/** Parse a .jsonl file into rows. Missing file → []; corrupt line → dropped
 *  (same defensive posture as the harness reader it mirrors). */
function readJsonlLocal(path) {
  if (!existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return rows;
}

/** surfaced[] memory_ids in brief (position-ascending) order. */
function surfacedIdsLocal(recall) {
  if (recall == null || typeof recall !== "object") return [];
  if (!Array.isArray(recall.surfaced)) return [];
  const withPos = [];
  for (const item of recall.surfaced) {
    if (item == null || typeof item !== "object") continue;
    const mid = item.memory_id;
    if (typeof mid !== "string" || mid.length === 0) continue;
    const pos = typeof item.position === "number" ? item.position : withPos.length;
    withPos.push({ memory_id: mid, position: pos });
  }
  withPos.sort((a, b) => a.position - b.position);
  return withPos.map((x) => x.memory_id);
}

/** Join each held_out_label to its derived_from[0] recall event. Mirrors the
 *  harness join exactly so the audit sees the same pair set the metrics saw. */
function joinPairsLocal(labels, recallRows) {
  const idx = new Map();
  for (const row of recallRows) {
    if (row == null || typeof row !== "object") continue;
    if (row.kind !== "recall") continue;
    if (typeof row.id !== "string" || row.id.length === 0) continue;
    idx.set(row.id, row);
  }
  const pairs = [];
  for (const label of labels) {
    if (label == null || typeof label !== "object") continue;
    if (label.kind !== "held_out_label") continue;
    if (!Array.isArray(label.derived_from) || label.derived_from.length === 0) continue;
    const recall = idx.get(label.derived_from[0]);
    if (recall === undefined) continue;
    pairs.push({ label, recall });
  }
  return pairs;
}

/** Canonical key for a set of ids (order-insensitive, duplicate-insensitive). */
function idSetKey(ids) {
  return Array.from(new Set(ids)).sort().join("\u0000");
}

/** The five verdicts `classifySelfReference` can return. Only PROVENANCE and
 *  WINDOW_COPY count as contamination; INDETERMINATE and NARROW are each
 *  excluded from the denominator entirely (see below).
 *
 *  NARROW is a distinct value rather than a second use of INDETERMINATE on
 *  purpose: the two exclusions have different causes — the ROW was too narrow
 *  to offer alternatives vs. the LABEL was too narrow to encode an ordering —
 *  and the operator-facing warning has to be able to name which one fired. */
const SELF_REF = Object.freeze({
  PROVENANCE: "provenance",
  WINDOW_COPY: "window_copy",
  INDETERMINATE: "indeterminate",
  NARROW: "narrow",
  INDEPENDENT: "independent",
});

/** Did this label come from the ranker it is supposed to be judging?
 *
 *  PRECEDENCE — evaluated in this order, and the order is part of the contract
 *  because two of the three exclusions can apply to the same row:
 *      PROVENANCE  >  sparsity (INDETERMINATE)  >  width (NARROW)  >  window
 *
 *  PROVENANCE   — the label carries the generator's own stamp. All three marks
 *                 `synthesizeLabel` writes are read (is_synthetic,
 *                 supersede_with_v1, labeler == BOOTSTRAP_CAPS.LABELER_NAME),
 *                 not just the first: stripping one flag must not launder a
 *                 synthetic set. Checked FIRST, so neither a sparse row nor a
 *                 narrow expected set can launder a stamped label.
 *  INDEPENDENT  — nothing links the label to the ranking (includes the empty
 *                 expected_ids case: an abstain label copies nothing).
 *  INDETERMINATE— the ROW surfaced fewer than MIN_JUDGEABLE_SURFACED ids. With
 *                 1-3 candidates on offer, "expected == surfaced" is a row with
 *                 no alternatives, not evidence of copying. Measured on the live
 *                 substrate: 93 of 280 recall rows surfaced fewer than 4 ids, so
 *                 judging them would manufacture false positives at scale.
 *                 Checked BEFORE the width floor so a sparse row keeps
 *                 reporting as `indeterminate` even when its label is also
 *                 width-1 — the row's poverty is the more specific cause.
 *  NARROW       — the LABEL names fewer than MIN_WINDOW_COPY_WIDTH ids. A
 *                 width-1 set is set-equal to a 1-wide window of ANY ranking
 *                 that surfaced it, so judging it turned the check into "did
 *                 the ranker surface the right answer": 13 honest operator
 *                 labels, each naming the one memory that was actually right,
 *                 were refused 13/13 against a good ranker and accepted
 *                 against a bad one. Excluded from the denominator, and
 *                 announced as SELF_REFERENCE_UNJUDGED — reported, not
 *                 laundered into a clean verdict.
 *  WINDOW_COPY  — expected_ids are set-EQUAL to SOME contiguous window of
 *                 surfaced[] of the same length, at ANY offset, for widths at
 *                 or above MIN_WINDOW_COPY_WIDTH.
 *
 *  ANY offset, not just [0:TOP_K_EXPECTED]: pinning the check to offset 0 meant
 *  a generator variant emitting surfaced[1:4] — or an operator transcribing
 *  "the ones the ranker showed me" from anywhere in the list — sailed through.
 *  Offset-freedom is kept for every width the floor admits; only width 1 is
 *  withdrawn, because at width 1 offset-freedom degenerates into "matches
 *  somewhere, always". Above the floor the known false positive stands and is
 *  accepted: an honest label that happens to be exactly a window of the ranking
 *  is indistinguishable from a copy of it (residual 5/15 at w=2, k=6), which is
 *  why the honest fixture in the suite names one id the ranker never surfaced.
 *
 *  Set-EQUALITY, not subset, is still load-bearing: a subset test would refuse
 *  every label whose ids all appear somewhere in the ranking, which is most
 *  honest labels. Equality plus the width floor is what leaves an honest
 *  labeler room — name one id and the pair is UNJUDGED, name two or more that
 *  are not a slice of the ranking and it is INDEPENDENT. */
function classifySelfReference(label, recall) {
  const meta = label?.metadata;
  if (
    meta?.is_synthetic === true ||
    meta?.supersede_with_v1 === true ||
    meta?.labeler === BOOTSTRAP_CAPS.LABELER_NAME
  ) {
    return SELF_REF.PROVENANCE;
  }

  const expected = Array.isArray(label?.payload?.expected_ids)
    ? label.payload.expected_ids
    : [];
  if (expected.length === 0) return SELF_REF.INDEPENDENT;

  const surfaced = surfacedIdsLocal(recall);
  if (surfaced.length < ASSERT_CAPS.MIN_JUDGEABLE_SURFACED) return SELF_REF.INDETERMINATE;

  // Width floor, checked after sparsity and before the window loop: below it
  // the loop below can only ever return WINDOW_COPY, so running it would be
  // measuring the ranker, not the label. See ASSERT_CAPS.MIN_WINDOW_COPY_WIDTH.
  if (expected.length < ASSERT_CAPS.MIN_WINDOW_COPY_WIDTH) return SELF_REF.NARROW;

  const width = expected.length;
  if (width > surfaced.length) return SELF_REF.INDEPENDENT;
  const expectedKey = idSetKey(expected);
  for (let start = 0; start + width <= surfaced.length; start++) {
    if (idSetKey(surfaced.slice(start, start + width)) === expectedKey) {
      return SELF_REF.WINDOW_COPY;
    }
  }
  return SELF_REF.INDEPENDENT;
}

/**
 * Every refusal condition that fired, plus non-refusing warnings, as
 * operator-readable strings. Each line opens with a stable machine token
 * (grep/regex anchor) and continues with a lowercase detail carrying the
 * measured value.
 *
 * EVERY failed condition is emitted, not just the first — a junk substrate
 * routinely trips more than one, and reporting only the first would hide the
 * others from the operator reading the refusal.
 *
 * Empty `reasons` ⇒ nothing fired ⇒ the caller exits 0. `warnings` NEVER
 * affect the exit code and are never printed under the `PROMOTE REFUSED`
 * header; they exist so a sub-threshold or unjudgeable substrate is visible
 * instead of passing silently.
 *
 * NOT exported: this file calls main() unconditionally at module scope, so
 * importing it would run the eval and process.exit(). The suite drives the
 * whole script via spawnSync instead.
 */
function refusalReasons({ result, labels, recallRows } = {}) {
  const reasons = [];
  const warnings = [];

  const recallCi = result?.bootstrap_ci?.recall;
  const lower = Array.isArray(recallCi) ? recallCi[0] : undefined;
  if (!(typeof lower === "number" && Number.isFinite(lower) && lower > 0)) {
    reasons.push(
      `RECALL_CI_LOWER_BOUND_NOT_POSITIVE: bootstrap_ci.recall[0]=${lower} <= 0`,
    );
  }

  const harm = result?.harm_rate;
  if (typeof harm === "number" && Number.isFinite(harm) && harm > 0) {
    reasons.push(`HARM_RATE_POSITIVE: harm_rate=${harm} > 0`);
  }

  const nUsed = result?.n_labels_used;
  if (!(typeof nUsed === "number" && nUsed >= ASSERT_CAPS.MIN_LABELS)) {
    reasons.push(
      `INSUFFICIENT_LABELS: n_labels_used=${nUsed} < ${ASSERT_CAPS.MIN_LABELS}`,
    );
  }

  const pairs = joinPairsLocal(
    Array.isArray(labels) ? labels : [],
    Array.isArray(recallRows) ? recallRows : [],
  );
  if (pairs.length > 0) {
    let provenance = 0;
    let windowCopy = 0;
    let indeterminate = 0;
    let narrow = 0;
    const distinctExpected = new Set();
    for (const { label, recall } of pairs) {
      const verdict = classifySelfReference(label, recall);
      if (verdict === SELF_REF.PROVENANCE) provenance++;
      else if (verdict === SELF_REF.WINDOW_COPY) windowCopy++;
      else if (verdict === SELF_REF.INDETERMINATE) indeterminate++;
      else if (verdict === SELF_REF.NARROW) narrow++;
      const expected = Array.isArray(label?.payload?.expected_ids)
        ? label.payload.expected_ids
        : [];
      distinctExpected.add(idSetKey(expected));
    }
    // Aggregate rule: refuse when contamination reaches MAX_SELF_REF_FRACTION
    // of the JUDGEABLE labels. Three deliberate properties:
    //   - indeterminate rows (the ROW surfaced too few ids) are excluded from
    //     the denominator, so a set of honest labels on sparse rows can never
    //     be refused for self-reference;
    //   - narrow labels (the LABEL names too few ids) are excluded from BOTH
    //     the numerator and the denominator. Excluding from both is the whole
    //     point: counting them clean would let a pile of unjudgeable width-1
    //     labels dilute a real refusal below the threshold, and counting them
    //     dirty is the inversion this floor exists to undo;
    //   - the threshold is a majority, not unanimity, so salting a synthetic
    //     set with one honest label no longer silences the check.
    const judged = pairs.length - indeterminate - narrow;
    const contaminated = provenance + windowCopy;
    const detail =
      `(provenance=${provenance} window_copy=${windowCopy} ` +
      `narrow=${narrow} indeterminate=${indeterminate} ` +
      `distinct expected_ids sets=${distinctExpected.size})`;
    if (judged > 0 && contaminated / judged >= ASSERT_CAPS.MAX_SELF_REF_FRACTION) {
      reasons.push(
        `SELF_REFERENTIAL_LABELS: ${contaminated}/${judged} judged labels came ` +
          `from the ranker they judge — stamped by the synthetic generator, or ` +
          `at least ${ASSERT_CAPS.MIN_WINDOW_COPY_WIDTH} expected_ids set-equal to ` +
          `a contiguous window of surfaced[] at some offset ${detail}`,
      );
    } else if (contaminated > 0) {
      // Token family note: this is SELF_REFERENCE_*, not SELF_REFERENTIAL_*.
      // The refusal above owns the `SELF_REFERENTIAL_LABELS` string outright,
      // so a bare `grep SELF_REFERENTIAL_LABELS` matches refusals ONLY — it
      // used to also match this passing warning as a prefix. The suite asserts
      // that absence on every exit-0 case rather than trusting this comment.
      warnings.push(
        `SELF_REFERENCE_SUBTHRESHOLD: ${contaminated}/${judged} judged ` +
          `labels came from the ranker they judge, below the ` +
          `${ASSERT_CAPS.MAX_SELF_REF_FRACTION} refusal threshold — NOT refused, ` +
          `but the metrics are partly tautological ${detail}`,
      );
    } else if (indeterminate + narrow > 0) {
      // Fires on ANY unjudgeable pair, not only when judged === 0: a partially
      // unjudgeable set used to pass in silence. The text names both counts and
      // both causes because a narrow expected set and a sparse row are
      // different failures of evidence, and the old wording ("every row
      // surfaced fewer than N ids") is simply false for the former.
      warnings.push(
        `SELF_REFERENCE_UNJUDGED: ${judged}/${pairs.length} joined labels were ` +
          `judgeable for self-reference — ${indeterminate} row(s) surfaced fewer ` +
          `than ${ASSERT_CAPS.MIN_JUDGEABLE_SURFACED} ids and ${narrow} label(s) ` +
          `named fewer than ${ASSERT_CAPS.MIN_WINDOW_COPY_WIDTH} expected_ids, so ` +
          `they carry no ordering evidence and were excluded from the denominator ` +
          `— exit 0 is NOT a clean self-reference verdict for them ${detail}`,
      );
    }
  }

  return { reasons, warnings };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!existsSync(opts.labels)) {
    process.stderr.write(
      `run-held-out-eval: labels file missing: ${opts.labels}\n` +
        `  expected per held-out-labeled-set.md § 5 (operator labeling pass).\n` +
        `  exit 1 — the gate cannot run.\n`,
    );
    process.exit(1);
  }

  let result;
  try {
    result = await evaluate({
      labelsPath: opts.labels,
      recallLogPath: opts.recall,
      // derivationGraph optional; CLI does not build it (the +1 neighbor
      // graded gain is then absent; spec § 6.3 still computes correctly).
    });
  } catch (err) {
    process.stderr.write(
      `run-held-out-eval: eval failed: ${err && err.message}\n`,
    );
    process.exit(1);
  }

  const payload = {
    ...result,
    harness_version: EVAL_HARNESS_VERSION,
    inputs: { labels: opts.labels, recall: opts.recall },
  };
  const json = JSON.stringify(payload, null, 2);
  if (opts.output) {
    try {
      writeFileSync(opts.output, json + "\n", { mode: 0o600 });
      process.stderr.write(`run-held-out-eval: wrote ${opts.output}\n`);
    } catch (err) {
      process.stderr.write(
        `run-held-out-eval: failed writing output ${opts.output}: ${err && err.message}\n`,
      );
      process.exit(1);
    }
  } else {
    process.stdout.write(json + "\n");
  }

  // --assert ONLY. Everything above is byte-for-byte what the default path
  // already did; the audit read below never happens without the flag.
  if (opts.assert) {
    const { reasons, warnings } = refusalReasons({
      result,
      labels: readJsonlLocal(opts.labels),
      recallRows: readJsonlLocal(opts.recall),
    });
    // Warnings first and OUTSIDE the refusal block: `PROMOTE REFUSED` must
    // never appear on a run that exits 0 (the suite asserts its absence).
    for (const warning of warnings) {
      process.stderr.write(`run-held-out-eval: WARNING ${warning}\n`);
    }
    if (reasons.length > 0) {
      process.stderr.write("run-held-out-eval: PROMOTE REFUSED\n");
      for (const reason of reasons) process.stderr.write(`  ${reason}\n`);
      process.exit(1);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`run-held-out-eval: unhandled error ${err && err.stack}\n`);
  process.exit(1);
});
