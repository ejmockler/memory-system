// funnel-alert.js — M3 pass-rate funnel alarm for Stage-0 ingest.
//
// Motivation: stage0/mail.js silently dropped 100% of 277,928 emails and no
// assertion existed that a 100% drop rate would fail (M1 audit,
// 2026-07-10). This module is the missing tripwire: a window where EVERY
// event drops is pathological — even the most aggressive bulk filter should
// let SOME human mail through over a large-enough sample.
//
// PURE MODULE, DELIBERATELY UN-WIRED: zero imports, no I/O, no env reads,
// no daemon/dispatcher hookup. Whether (and where) the live pipeline calls
// this is an OPERATOR decision documented by S1 — do not wire it here.

/**
 * Compute the drop rate over a window of Stage-0 decision events and flag
 * an all-drop funnel.
 *
 * An event counts as a PASS iff `event.decision === "PASS"`; every other
 * shape (DROP, REDACT_DROP, missing/malformed decision) counts as a drop —
 * conservative, because the alarm only fires when NOTHING passes, so
 * miscounting a malformed event as a drop can never mask a real all-drop
 * window (any single genuine PASS still defuses it).
 *
 * Alert semantics: `alert === (n >= min && dropRate === 1)`. The `min`
 * floor (default 100) suppresses small-sample noise — 10 bulk newsletters
 * in a row is normal; `min` consecutive events with zero passes is the
 * mail.js failure mode this exists to catch.
 *
 * Empty-window case (n === 0): there is no evidence of a funnel failure,
 * so dropRate is defined as 0 (NOT 0/0 = NaN) and alert is false. An idle
 * pipeline is a liveness question for cursor-lag alarms, not this one.
 *
 * @param {Array<{decision?: string}>} events - window of Stage-0 results
 *   (oldest-to-newest or any order; only counts matter).
 * @param {{min?: number}} [opts] - `min`: smallest window size that may
 *   alert (default 100).
 * @returns {{n: number, dropRate: number, alert: boolean}}
 */
export function windowDropRate(events, { min = 100 } = {}) {
  const list = Array.isArray(events) ? events : [];
  const n = list.length;
  if (n === 0) {
    return { n: 0, dropRate: 0, alert: false };
  }
  let drops = 0;
  for (const ev of list) {
    const decision =
      ev && typeof ev === "object" ? ev.decision : undefined;
    if (decision !== "PASS") drops += 1;
  }
  const dropRate = drops / n;
  return { n, dropRate, alert: n >= min && dropRate === 1 };
}
