// A1 — recall-liveness gate. A VERDICT ADAPTER over the existing
// synthesis-coverage probe, NOT a second ledger parser.
//
// PURPOSE:
//   coverage-probe.js already measures how often the recall handler
//   populated `scoringContext` on a real memory_recall invocation
//   (`populator.entities_count > 0` — coverage-probe.js:224). What it does
//   NOT do is REJECT anything: it reports a number and the number is
//   allowed to be terrible forever. This module is the missing gate. It
//   turns that one measured rate into a three-state verdict the operator
//   (and CI) can fail on.
//
//   Gate honesty: a truthful RED is a SUCCESS. `threshold` and `minSample`
//   exist to be met, never to be tuned down until the light turns green.
//   'inconclusive' is NOT a pass — it means "we never found out", and a
//   caller that counts it as a pass has defeated the gate.
//
// SINGLE RATE SOURCE (F9 — A1 is a verdict adapter, not a second parser):
//   The ONLY rate source in this file is `computeSynthesisCoverage`. There
//   is deliberately no readFileSync / createReadStream / readline / JSON
//   parse loop over recall.jsonl here. A second parser would be free to
//   disagree with the dashboard, and then the gate and the dashboard would
//   need reconciling every time either moved.
//
// FACT 1 — pct() RETURNS A FRACTION, NOT A PERCENT.
//   coverage-probe.js:130 `pct()` computes
//   `Math.round((populated / total) * 10000) / 10000` — a value in [0, 1]
//   rounded to 4 decimal places. So `non_empty_entities_pct` of 0.0214
//   means 2.14%, not 2.14e-4%. `threshold` here is on the SAME scale: the
//   default 0.5 means "half of all recalls must carry at least one entity",
//   and it is compared directly against the fraction with no ×100 anywhere
//   in this file. Documented once, here, so no sibling re-derives it.
//
// DEFECT GUARD — `ledgerPath` IS ACCEPTED AND DELIBERATELY IGNORED.
//   `evaluateRecallLiveness` takes a `ledgerPath` key purely for signature
//   symmetry with `computeSynthesisCoverage`, and NEVER forwards it.
//   coverage-probe.js:322 gates the memory.jsonl scan on `if (ledgerPath)`;
//   memory.jsonl is 2.9 GB and this probe runs at windowDays 3650, so
//   forwarding it would stream the entire ledger on the health path to
//   compute a number this gate does not read. That guard is the only thing
//   standing between this module and a full-ledger scan. The omission is
//   asserted in test/recall-liveness-gate.test.mjs (a supplied ledgerPath
//   must produce a byte-identical result to omitting it).
//
// DENOMINATOR DECISION (recorded on disk so it is not re-litigated):
//   The verdict's denominator is `snapshot.recall_population.recalls_in_window`
//   — every `kind:"recall"` row in the window (280 live at time of writing).
//   The spec's stricter "honest" denominator counts only rows that actually
//   CARRY a `populator` block (266 live). Measured today both denominators
//   yield the SAME verdict: 0.0214 vs 0.0226, both an order of magnitude
//   below the 0.5 threshold. Since the stricter denominator would require a
//   second scan of recall.jsonl — i.e. the second parser this module exists
//   to avoid — pure reuse wins. The returned object carries
//   `denominator: 'recalls_in_window'` so the choice is legible at the call
//   site rather than inferred. A row missing its populator block counts as
//   NOT-populated, which is the conservative direction: it can only make
//   the gate harder to pass, never easier.
//
// TEST-CLOCK SEAM (departure from A1.md, which lists no `now`):
//   coverage-probe.js:258 documents `opts.now` precisely so tests can pin
//   the clock. `evaluateRecallLiveness` forwards it for the same reason:
//   `evaluated_at` is derived from the snapshot's `built_at`, so without a
//   pinnable clock two back-to-back calls can straddle a millisecond and
//   the "ledgerPath changes nothing" byte-identity assertion goes flaky.
//   `now` is never a ledger path and never widens what gets read.
//
// LOUD ABSENCE — A MIS-PATHED RECALL LOG IS NOT AN EMPTY ONE.
//   The shared stream classifies ENOENT as the one benign errno and returns
//   zeros with `readError` null (_ledger-stream.js:146), and the coverage
//   probe destructures only `{ rows }` from it (coverage-probe.js:374), so
//   the signal is discarded before it can reach here. Without a check a
//   TYPO'D PATH yields sample 0 -> 'inconclusive', indistinguishable from a
//   genuinely empty window — and 'inconclusive' silently becomes the answer
//   to a question that was never asked. So this module stats `recallLogPath`
//   FIRST and THROWS when it is missing or unreadable, per the THROWS
//   contract below. The check lives HERE, not in the shared probe: other
//   consumers depend on _ledger-stream / coverage-probe never throwing, and
//   a statSync on one caller-supplied path is a liveness check, never a
//   second parser: it opens no bytes and produces no rate, so the SINGLE
//   RATE SOURCE rule above is untouched.

import { statSync } from "node:fs";

import { computeSynthesisCoverage } from "./coverage-probe.js";

// A1 window: 3650 days ≈ 10 years — effectively "all of recall.jsonl".
// The gate asks whether the query side is alive AT ALL, so it must not be
// able to go green (or inconclusive) merely because the last 7 days were
// quiet. recall.jsonl is ~20 MB; the wide window is cheap here and only
// here BECAUSE ledgerPath is never forwarded (see DEFECT GUARD above).
export const DEFAULT_LIVENESS_WINDOW_DAYS = 3650;

// Half of all recalls must carry at least one entity. Not a tuning knob.
export const DEFAULT_LIVENESS_THRESHOLD = 0.5;

// Below this many in-window recalls the rate is noise, so the gate reports
// 'inconclusive' rather than manufacturing either colour. This subsumes the
// zero-row case: 0 < minSample, so an empty ledger is 'inconclusive', never
// a green off a 0/0 divide.
export const DEFAULT_LIVENESS_MIN_SAMPLE = 100;

/**
 * Evaluate query-side entity liveness and return a falsifiable verdict.
 *
 * @param {object}      opts
 * @param {string}      opts.recallLogPath        - absolute path to recall.jsonl
 * @param {string}     [opts.ledgerPath]          - ACCEPTED AND IGNORED; see
 *                                                  DEFECT GUARD in the header.
 *                                                  Never forwarded downstream.
 * @param {number}     [opts.windowDays=3650]     - rolling-window length in days
 * @param {number}     [opts.threshold=0.5]       - min FRACTION (not percent) of
 *                                                  in-window recalls carrying
 *                                                  >=1 entity for a green
 * @param {number}     [opts.minSample=100]       - min in-window recalls before
 *                                                  any colour is claimed
 * @param {Date|number} [opts.now]                - clock anchor; production omits
 *
 * @returns {Promise<Readonly<object>>} frozen verdict:
 *   {
 *     verdict: 'green' | 'red' | 'inconclusive',
 *     rate: number,          // FRACTION in [0,1], 4dp (see FACT 1)
 *     sample: number,        // recalls_in_window
 *     threshold: number,
 *     minSample: number,
 *     window_days: number,
 *     denominator: 'recalls_in_window',
 *     rate_basis: 'recall_population.non_empty_entities_pct',
 *     evaluated_at: string,  // ISO-8601, from the snapshot's clock anchor
 *   }
 *
 * VERDICT RULES, in order:
 *   sample < minSample            -> 'inconclusive'   (subsumes 0 rows)
 *   else rate >= threshold        -> 'green'
 *   else                          -> 'red'
 *
 * The sample gate is checked BEFORE the threshold, deliberately: a 100%
 * rate off 3 recalls is not evidence of liveness.
 *
 * THROWS when `recallLogPath` is not a non-empty string, or does not exist,
 * or cannot be stat-ed — plus whatever the underlying probe throws for an
 * unreadable ledger (coverage-probe.js's LOUD-FAILURE contract). An absent
 * or mis-pathed ledger is NOT an empty one, and neither may be laundered
 * into 'inconclusive'. The health call site catches this and pushes a
 * `recall_liveness_probe_unreachable` note, leaving the key ABSENT rather
 * than publishing a verdict off a path nobody read (health.js:1180).
 */
export async function evaluateRecallLiveness(opts) {
  const o = opts || {};
  const recallLogPath = typeof o.recallLogPath === "string" ? o.recallLogPath : null;
  const windowDays =
    Number.isFinite(o.windowDays) && o.windowDays > 0
      ? o.windowDays
      : DEFAULT_LIVENESS_WINDOW_DAYS;
  const threshold = Number.isFinite(o.threshold) ? o.threshold : DEFAULT_LIVENESS_THRESHOLD;
  const minSample =
    Number.isFinite(o.minSample) && o.minSample >= 0
      ? o.minSample
      : DEFAULT_LIVENESS_MIN_SAMPLE;

  // LOUD ABSENCE (see header). A missing or unreadable recall log must not
  // become 'inconclusive' — downstream cannot tell that apart from a real
  // empty window, and the whole point of a three-state verdict is that
  // "we never found out" stays distinguishable from "we found out nothing
  // was there". statSync only; the bytes still come from the single rate
  // source below.
  if (recallLogPath === null || recallLogPath.length === 0) {
    const given = JSON.stringify(o.recallLogPath ?? null);
    throw new Error(`recall_liveness: recall log unreadable or absent: ${given}`);
  }
  try {
    statSync(recallLogPath);
  } catch (e) {
    throw new Error(
      `recall_liveness: recall log unreadable or absent: ${recallLogPath}` +
        `${e && e.code ? ` (${e.code})` : ""}`,
    );
  }

  // THE ONLY RATE SOURCE. `ledgerPath` is intentionally absent from this
  // object literal — see DEFECT GUARD in the header. Do not "fix" this by
  // threading o.ledgerPath through; that reintroduces the 2.9 GB scan.
  const snapshot = await computeSynthesisCoverage({
    recallLogPath,
    windowDays,
    now: o.now,
  });

  const pop = (snapshot && snapshot.recall_population) || null;
  const sample =
    pop && Number.isFinite(pop.recalls_in_window) ? pop.recalls_in_window : 0;
  const rate =
    pop && Number.isFinite(pop.non_empty_entities_pct) ? pop.non_empty_entities_pct : 0;

  let verdict;
  if (sample < minSample) verdict = "inconclusive";
  else if (rate >= threshold) verdict = "green";
  else verdict = "red";

  return Object.freeze({
    verdict,
    rate,
    sample,
    threshold,
    minSample,
    window_days: windowDays,
    // SELF-DESCRIBING RATE. This verdict is nested inside a synthesis_coverage
    // envelope that carries its OWN rate over a DIFFERENT window (health-
    // reducers.js:1400 computes the enclosing snapshot at coverage-probe.js:56
    // DEFAULT_WINDOW_DAYS = 7; this verdict runs at 3650). These three keys
    // exist so a reader can tell the two apart in the same JSON without
    // reading any code: `window_days` is MY window, `denominator` is MY row
    // count, `rate_basis` is the exact snapshot field `rate` came from. The
    // health call site adds `enclosing_window_days` alongside them.
    denominator: "recalls_in_window",
    // 280-row (recalls_in_window) vs 266-row (rows carrying a populator
    // block) denominators agree on the verdict; reuse won. Decided once —
    // see DENOMINATOR DECISION in this file's header, do not re-litigate.
    rate_basis: "recall_population.non_empty_entities_pct",
    evaluated_at:
      snapshot && typeof snapshot.built_at === "string"
        ? snapshot.built_at
        : new Date().toISOString(),
  });
}
