// recall-observables.js — e5. READ-ONLY OBSERVABLES over ledgers/recall.jsonl.
//
// REPORTER, NOT A GATE — the deliberate difference from its sibling.
//   `recall-liveness-probe.js` collapses one rate into a pass/fail colour and
//   exists to be able to fail a build. THIS module does the opposite on
//   purpose: it holds no quality constant, compares nothing against one, and
//   emits no colour of any kind. Everything it returns is a count, a
//   histogram bucket, a percentile or a fraction — an observation, never a
//   judgement. In particular an EMPTY result set is reported as a rate and is
//   never labelled a failure: a query that legitimately matches nothing is
//   healthy, and this file has no way to say otherwise.
//
// WHY COUNTERS AND HISTOGRAMS, NEVER RETAINED ROWS.
//   Every `kind:"recall"` row carries `query.context_embedding`, a 3072-float
//   array — ~74 KB of JSON per row, which is why a 283-row recall.jsonl is
//   21 MB on disk. The two convenient window helpers in this repo
//   (`streamLedgerRowsInWindow` in coverage-probe.js and
//   `streamLedgerRowsInTimeWindow` in _ledger-stream.js) both RETAIN every
//   in-window row in an array, so their peak heap grows linearly with the
//   log and each retained element drags an embedding with it. This module
//   therefore drives `streamLedgerLines` directly and accumulates ONLY
//   integer counters and `Map<int,count>` / `Map<string,count>` histograms.
//   No row outlives its `onRow` call, no whole-file string is ever built, and
//   no unbounded sorted array is kept. Peak heap is a function of the number
//   of DISTINCT bucket keys, not of the number of rows.
//
// LOUD ABSENCE — A MIS-PATHED LOG IS NOT AN EMPTY ONE.
//   `streamLedgerLines` classifies ENOENT as its one benign errno and returns
//   all-zero counts with `readError` null, so a typo'd path would otherwise
//   flow straight through this module and come out as an honest-looking
//   all-zero envelope. Two checks stop that, mirroring the two contracts
//   already on disk: `statSync(recallLogPath)` runs FIRST and THROWS when the
//   path is missing or cannot be stat-ed (the LOUD ABSENCE contract in
//   recall-liveness-probe.js), and a non-null `counts.readError` after the
//   scan THROWS rather than reporting counters off a head-biased truncated
//   read (the LOUD-FAILURE contract in coverage-probe.js). Absence is never
//   an answer here.
//
// ONE DECLARED SCALE — FRACTIONS, STAMPED ONCE.
//   This repo has a live percent-vs-fraction trap: coverage-probe.js's `pct()`
//   returns a FRACTION in [0,1] while bm25-coverage-probe.js returns a
//   PERCENT in [0,100]. Every rate this module emits is a FRACTION, the
//   envelope stamps `rate_scale:"fraction"` once, and there is no `* 100`
//   anywhere in this file. A reader never has to guess which convention a
//   given key follows.
//
// THREE INDEPENDENT DEGRADE AXES, NEVER SUMMED.
//   (a) `degraded_recall_flag_count` — the raw `degraded_recall === true`
//       count off the ledger row.
//   (b) `degrade_cause_histogram` — an OPEN histogram over whatever
//       `degraded_reason` string values actually appear on flagged rows, with
//       an explicit "(unattributed)" bucket for a flagged row that carries no
//       reason. The set of keys is NOT hard-coded from any spec: only the
//       four conditional spreads in recall.js's recall-event literal (the
//       `indexUnservable` / `denseSearchDegraded` / `vectorPrefetchDegraded` /
//       `indexGenerationRefused` spreads) can ever put a `degraded_reason` on
//       a ledger row, and a row can take none of those branches while still
//       being flagged — which is precisely what "(unattributed)" names.
//   (c) `degraded_recall_layer3_count` and `layer3_reason_histogram`, under
//       keys of their own. Layer 3 is the RERANK stage, not retrieval:
//       recall.js assigns `degradedRecallLayer3` from `rerankResult.degraded`
//       and the recall event's `degraded_recall` value is an OR over
//       `degradedRecall`, `indexGenerationRefused`, `vectorPrefetchDegraded`,
//       `denseSearchDegraded` and `indexUnservable` — `degradedRecallLayer3`
//       is not a term in it. That non-conflation is enforced at the symbol,
//       and this module keeps it: axis (c) is never OR-ed into, summed into,
//       or averaged with axis (a).
//
// SINGLE RATE SOURCE FOR THE ONE RATE THIS FILE SHARES WITH THE DASHBOARD.
//   `degraded_recall_pct` on the operator dashboard comes from
//   coverage-probe.js's own degrade test, which counts a row when EITHER
//   `degraded_recall === true` OR `populator.degraded === true`. Re-deriving
//   that here would let this reporter silently disagree with memory_health.
//   So the test itself is imported (`isRecallDegraded`) and BOTH numbers are
//   published under distinct names: `degraded_recall_flag_count` (raw flag)
//   and `degraded_wide_count` (the dashboard's wider test). When the two
//   diverge the divergence is legible in the envelope instead of hiding
//   inside whichever one this file happened to pick.
//
// SMALL-n HONESTY.
//   Below `min_sample` no percentage is emitted at all: a rate becomes
//   `{count, pct:null, suppressed:"n<min_sample"}` and a length distribution
//   emits its raw sorted `values` instead of a p50/p90 label. The live
//   at-or-after segment of a freshly-split log is routinely n=1, and one row
//   must never render as "100%".
//
// SEGMENTATION IS A PARAMETER, NEVER A CONSTANT.
//   `splitAt` is supplied by the caller and stamped verbatim into the
//   envelope, so the report describes its own boundary. No publish instant
//   and no index generation is baked into this file: the index manifest moves
//   on its own schedule and any constant here would rot into a false claim.
//
// ABSOLUTELY READ-ONLY: `statSync` is the only `node:fs` import, and the only
// other filesystem contact is `streamLedgerLines`, which opens with "r".

import { statSync } from "node:fs";

import { isRecallDegraded } from "../synthesis/coverage-probe.js";
import { streamLedgerLines } from "../synthesis/_ledger-stream.js";

/**
 * Sample floor beneath which a percentage is suppressed. 30 is the caller-
 * overridable default. It is not a quality constant: the only thing ever
 * tested against it is the segment's own row count, and the only outcome is
 * whether a ratio may be printed at all.
 */
export const DEFAULT_MIN_SAMPLE = 30;

/** Bucket name for a degrade that carries no reason string of its own. */
export const UNATTRIBUTED = "(unattributed)";

/** How many histogram modes each length distribution publishes. */
const TOP_MODES = 5;

/** 4dp, matching the rounding already used across the synthesis probes. */
function round4(x) {
  return Math.round(x * 10000) / 10000;
}

function tick(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

/**
 * Parse a caller-supplied instant (ISO string, Date, or epoch ms) into ms.
 * THROWS on anything unparseable — a boundary nobody can parse must not
 * silently become "no boundary", which would fold two segments into one and
 * change every number in the envelope without saying so.
 */
function parseInstant(value, name) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isFinite(ms)) return ms;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  } else if (typeof value === "string" && value.length > 0) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  throw new Error(
    `recall_observables: ${name} is not a parseable instant: ${JSON.stringify(value)}`,
  );
}

/**
 * A rate, always a FRACTION and always honest about its sample.
 * n === 0 or n < minSample yields pct:null plus an explicit suppression
 * reason; a percentage off one row is never emitted.
 */
function rateOf(count, n, minSample) {
  if (n === 0 || n < minSample) {
    return { count, pct: null, suppressed: "n<min_sample" };
  }
  return { count, pct: round4(count / n), suppressed: null };
}

/**
 * Nearest-rank percentile over an integer histogram: the value at 1-based
 * rank ceil(p * total) of the sorted sample. No interpolation, so the result
 * is always a value the substrate actually produced.
 */
function nearestRank(sortedKeys, map, total, p) {
  const rank = Math.max(1, Math.ceil(p * total));
  let seen = 0;
  for (const k of sortedKeys) {
    seen += map.get(k);
    if (seen >= rank) return k;
  }
  return sortedKeys[sortedKeys.length - 1];
}

/**
 * Summarize an integer histogram.
 *
 * Modes are published alongside the percentiles because a p50 alone HIDES
 * bimodality, and bimodality is the whole signal on this substrate: a log
 * whose candidate counts pile up at 0 and again at 50 has a perfectly
 * unremarkable median and two completely different populations inside it.
 *
 * Below minSample the raw sorted `values` are emitted instead of p50/p90 —
 * bounded by construction, since that branch only runs when the count is
 * under the floor.
 */
function histSummary(map, minSample) {
  const keys = [...map.keys()].sort((a, b) => a - b);
  let total = 0;
  let sum = 0;
  for (const k of keys) {
    const c = map.get(k);
    total += c;
    sum += k * c;
  }
  const modes = [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, TOP_MODES)
    .map(([value, count]) => ({ value, count }));

  if (total === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      p50: null,
      p90: null,
      modes: [],
      values: [],
      suppressed: "n<min_sample",
    };
  }

  const min = keys[0];
  const max = keys[keys.length - 1];
  const mean = round4(sum / total);

  if (total < minSample) {
    const values = [];
    for (const k of keys) {
      const c = map.get(k);
      for (let i = 0; i < c; i += 1) values.push(k);
    }
    return {
      count: total,
      min,
      max,
      mean,
      p50: null,
      p90: null,
      modes,
      values,
      suppressed: "n<min_sample",
    };
  }

  return {
    count: total,
    min,
    max,
    mean,
    p50: nearestRank(keys, map, total, 0.5),
    p90: nearestRank(keys, map, total, 0.9),
    modes,
    values: null,
    suppressed: null,
  };
}

/** Sort a string histogram into a plain object, most frequent first. */
function histToObject(map) {
  const out = {};
  const entries = [...map.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  for (const [k, v] of entries) out[k] = v;
  return out;
}

function newAccumulator(label, since, until, interval) {
  return {
    label,
    since,
    until,
    interval,
    n: 0,
    surfaced: new Map(),
    surfacedAbsent: 0,
    candidates: new Map(),
    candidatesAbsent: 0,
    emptySurfaced: 0,
    emptyCandidates: 0,
    emptyBoth: 0,
    degradedFlag: 0,
    degradedWide: 0,
    degradeCause: new Map(),
    layer3: 0,
    layer3Reason: new Map(),
    reasonWithoutLayer3: 0,
    // e15-recall-temporal-scoping — time-anchor RESOLUTION observables.
    // Three integer counters and one Map<int,count>; no row is retained, per
    // the no-retained-rows contract in this file's header.
    populatorRows: 0,
    anchored: 0,
    timeAnchors: new Map(),
  };
}

/**
 * Fold one recall row into one accumulator. The row is READ and dropped —
 * nothing about it, least of all its embedding, survives this call.
 */
function observe(acc, row) {
  acc.n += 1;

  const s = row.surfaced;
  const sIsArray = Array.isArray(s);
  if (sIsArray) {
    tick(acc.surfaced, s.length);
    if (s.length === 0) acc.emptySurfaced += 1;
  } else {
    acc.surfacedAbsent += 1;
  }

  const c = row.candidates_pre_truncation;
  const cIsArray = Array.isArray(c);
  if (cIsArray) {
    tick(acc.candidates, c.length);
    if (c.length === 0) acc.emptyCandidates += 1;
  } else {
    acc.candidatesAbsent += 1;
  }

  // The coincidence is its own observable: "nothing came back" and "nothing
  // was ever a candidate" are different facts, and the interesting case is
  // when they are the SAME rows.
  if (sIsArray && cIsArray && s.length === 0 && c.length === 0) {
    acc.emptyBoth += 1;
  }

  // AXIS (a) — the raw flag off the ledger row.
  const flagged = row.degraded_recall === true;
  if (flagged) {
    acc.degradedFlag += 1;
    // AXIS (b) — open cause histogram, "(unattributed)" when the row is
    // flagged but carries no reason string.
    const reason =
      typeof row.degraded_reason === "string" && row.degraded_reason.length > 0
        ? row.degraded_reason
        : UNATTRIBUTED;
    tick(acc.degradeCause, reason);
  }

  // The dashboard's wider test, imported rather than re-derived so this
  // reporter cannot silently disagree with memory_health.
  if (isRecallDegraded(row)) acc.degradedWide += 1;

  // AXIS (c) — Layer 3 (rerank). Kept strictly apart from (a) and (b).
  const l3 = row.degraded_recall_layer3 === true;
  const rr =
    typeof row.rerank_failed_reason === "string" && row.rerank_failed_reason.length > 0
      ? row.rerank_failed_reason
      : null;
  if (l3) {
    acc.layer3 += 1;
    tick(acc.layer3Reason, rr === null ? UNATTRIBUTED : rr);
  } else if (rr !== null) {
    // A reason string with no Layer-3 flag: a divergence between the two
    // fields, published as its own count instead of being folded into either.
    acc.reasonWithoutLayer3 += 1;
  }

  // AXIS (d) — e15-recall-temporal-scoping. How often does the query-side
  // populator actually RESOLVE a time anchor? The denominator is deliberately
  // "rows carrying a populator block", NOT acc.n: the populator block was
  // added in Wave 6, so dividing by every recall row ever written would
  // silently deflate the rate with pre-Wave-6 rows that could not have
  // reported an anchor either way.
  //
  // WHAT THIS RATE IS NOT: a measure of how many queries used time LANGUAGE.
  // The recall ledger stores `query.surrounding_context_hash` and
  // `query.context_embedding` and NO raw query text, so the share of queries
  // that MENTIONED a time is not measurable from this substrate at all. This
  // is a floor on anchor RESOLUTION, and nothing more.
  const pop = row.populator;
  if (pop != null && typeof pop === "object" && !Array.isArray(pop)) {
    acc.populatorRows += 1;
    if (pop.has_time_anchor === true) acc.anchored += 1;
    if (Number.isInteger(pop.time_anchors_count)) {
      tick(acc.timeAnchors, pop.time_anchors_count);
    }
  }
}

function renderSegment(acc, minSample) {
  return {
    label: acc.label,
    since: acc.since,
    until: acc.until,
    interval: acc.interval,
    n: acc.n,

    surfaced: histSummary(acc.surfaced, minSample),
    candidates_pre_truncation: histSummary(acc.candidates, minSample),
    rows_without_surfaced_array: acc.surfacedAbsent,
    rows_without_candidates_array: acc.candidatesAbsent,

    empty_surfaced_count: acc.emptySurfaced,
    empty_candidate_count: acc.emptyCandidates,
    empty_surfaced_and_candidate_count: acc.emptyBoth,
    empty_surfaced_rate: rateOf(acc.emptySurfaced, acc.n, minSample),
    empty_candidate_rate: rateOf(acc.emptyCandidates, acc.n, minSample),
    empty_surfaced_and_candidate_rate: rateOf(acc.emptyBoth, acc.n, minSample),

    degraded_recall_flag_count: acc.degradedFlag,
    degraded_recall_flag_rate: rateOf(acc.degradedFlag, acc.n, minSample),
    degraded_wide_count: acc.degradedWide,
    degraded_wide_rate: rateOf(acc.degradedWide, acc.n, minSample),
    degrade_cause_histogram: histToObject(acc.degradeCause),

    degraded_recall_layer3_count: acc.layer3,
    degraded_recall_layer3_rate: rateOf(acc.layer3, acc.n, minSample),
    layer3_reason_histogram: histToObject(acc.layer3Reason),
    rerank_reason_without_layer3_count: acc.reasonWithoutLayer3,

    // e15-recall-temporal-scoping — time-anchor resolution.
    // `anchored_rate` is a FRACTION over `populator_rows` (the only honest
    // denominator; see observe()), covered by the envelope's single
    // rate_scale:"fraction" stamp. `time_anchors_count_histogram` buckets the
    // per-recall anchor COUNT so "resolved zero" and "resolved several" stay
    // distinguishable rather than collapsing into one boolean.
    populator_rows: acc.populatorRows,
    anchored_count: acc.anchored,
    anchored_rate: rateOf(acc.anchored, acc.populatorRows, minSample),
    time_anchors_count_histogram: histToObject(acc.timeAnchors),
  };
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  for (const k of Object.keys(value)) deepFreeze(value[k]);
  return Object.freeze(value);
}

/**
 * Compute read-only recall observables over a recall.jsonl.
 *
 * @param {object}       opts
 * @param {string}       opts.recallLogPath - absolute (or cwd-relative) path
 *                                            to recall.jsonl
 * @param {string|Date|number} [opts.since]  - window start, inclusive
 * @param {string|Date|number} [opts.until]  - window end, inclusive; defaults
 *                                             to `now`
 * @param {string|Date|number} [opts.splitAt] - boundary producing exactly two
 *                                              segments: `before` over
 *                                              [since, splitAt) and
 *                                              `at_or_after` over
 *                                              [splitAt, until]. Omit for a
 *                                              single `all` segment.
 * @param {number}       [opts.minSample=30] - floor beneath which a segment
 *                                             emits counts and pct:null
 * @param {Date|number}  [opts.now]          - clock anchor; production omits
 *
 * @returns {Readonly<object>} a deeply frozen envelope:
 *   {
 *     recall_log_path, generated_at, rate_scale: "fraction", min_sample,
 *     since, until, split_at,          // caller's values, stamped verbatim
 *     window: {since, until},          // resolved instants
 *     scan: {total_lines, parsed_lines, skipped, recall_rows_seen,
 *            in_window_rows, out_of_window_rows, non_recall_rows},
 *     totals: <segment shape over the whole window>,
 *     segments: [<segment shape>, ...]
 *   }
 *
 * THROWS when `recallLogPath` is absent, empty, or cannot be stat-ed; when
 * `since` / `until` / `splitAt` cannot be parsed; and when the scan ends with
 * a non-null `readError`. It never returns a zero-filled envelope for a path
 * it could not read.
 */
export function computeRecallObservables(opts) {
  const o = opts || {};
  const recallLogPath = typeof o.recallLogPath === "string" ? o.recallLogPath : null;

  // LOUD ABSENCE, first thing, before any counter exists.
  if (recallLogPath === null || recallLogPath.length === 0) {
    throw new Error(
      `recall_observables: recall log unreadable or absent: ${JSON.stringify(
        o.recallLogPath ?? null,
      )}`,
    );
  }
  try {
    statSync(recallLogPath);
  } catch (e) {
    throw new Error(
      `recall_observables: recall log unreadable or absent: ${recallLogPath}` +
        `${e && e.code ? ` (${e.code})` : ""}`,
    );
  }

  const nowMs =
    o.now instanceof Date
      ? o.now.getTime()
      : Number.isFinite(o.now)
        ? o.now
        : Date.now();

  const sinceMs = o.since == null ? Number.NEGATIVE_INFINITY : parseInstant(o.since, "since");
  const untilMs = o.until == null ? nowMs : parseInstant(o.until, "until");
  const splitMs = o.splitAt == null ? null : parseInstant(o.splitAt, "splitAt");

  const minSample =
    Number.isFinite(o.minSample) && o.minSample >= 0 ? o.minSample : DEFAULT_MIN_SAMPLE;

  const sinceEcho = o.since == null ? null : String(o.since);
  const untilEcho = o.until == null ? null : String(o.until);
  const splitEcho = o.splitAt == null ? null : String(o.splitAt);

  const totals = newAccumulator(
    "in_window_total",
    sinceEcho,
    untilEcho,
    "[since, until]",
  );

  const segments =
    splitMs === null
      ? [newAccumulator("all", sinceEcho, untilEcho, "[since, until]")]
      : [
          newAccumulator("before", sinceEcho, splitEcho, "[since, split_at)"),
          newAccumulator("at_or_after", splitEcho, untilEcho, "[split_at, until]"),
        ];

  let recallRowsSeen = 0;
  let inWindowRows = 0;
  let outOfWindowRows = 0;
  let nonRecallRows = 0;

  const counts = streamLedgerLines(recallLogPath, (parsed) => {
    if (parsed == null || typeof parsed !== "object") return;
    if (parsed.kind !== "recall") {
      nonRecallRows += 1;
      return;
    }
    recallRowsSeen += 1;

    // Same field tolerance the synthesis helpers use: newer writers stamp
    // `created_at`, older rows and hermetic fixtures stamp `ts`.
    const tsField =
      (typeof parsed.ts === "string" && parsed.ts) ||
      (typeof parsed.created_at === "string" && parsed.created_at) ||
      null;
    const tsMs = tsField ? Date.parse(tsField) : NaN;
    if (!Number.isFinite(tsMs)) {
      outOfWindowRows += 1;
      return;
    }
    if (tsMs < sinceMs || tsMs > untilMs) {
      outOfWindowRows += 1;
      return;
    }

    inWindowRows += 1;
    observe(totals, parsed);

    if (splitMs === null) {
      observe(segments[0], parsed);
    } else if (tsMs < splitMs) {
      // Half-open: a row exactly ON the boundary belongs to `at_or_after`.
      observe(segments[0], parsed);
    } else {
      observe(segments[1], parsed);
    }
  });

  // LOUD FAILURE: counters off a truncated scan are biased toward the head of
  // the file (the oldest rows), which is worse than no answer.
  if (counts.readError !== null && counts.readError !== undefined) {
    throw new Error(
      `recall_observables: recall log scan failed (${counts.readError}) at ${recallLogPath}; ` +
        "refusing to report counters off a truncated scan — " +
        "an unreadable log is NOT an empty log",
    );
  }

  return deepFreeze({
    recall_log_path: recallLogPath,
    generated_at: new Date(nowMs).toISOString(),
    // Stamped ONCE. Every pct in this envelope is a fraction in [0,1].
    rate_scale: "fraction",
    min_sample: minSample,
    since: sinceEcho,
    until: untilEcho,
    split_at: splitEcho,
    window: {
      since: Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null,
      until: new Date(untilMs).toISOString(),
    },
    scan: {
      total_lines: counts.totalLines,
      parsed_lines: counts.parsedLines,
      skipped: counts.skipped,
      recall_rows_seen: recallRowsSeen,
      in_window_rows: inWindowRows,
      out_of_window_rows: outOfWindowRows,
      non_recall_rows: nonRecallRows,
    },
    totals: renderSegment(totals, minSample),
    segments: segments.map((a) => renderSegment(a, minSample)),
  });
}
