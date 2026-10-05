// drop-throttle.js — shared time-bounded throttle for Stage-0 drop breadcrumbs.
//
// WHY THIS IS SHARED. policy.salience.dropped has TWO producers:
//
//   mcp/lib/ingest/salience.js  emitDropped()   — when salience owns the call
//   daemons/watermark.js        ~L1663          — when the watermark
//                                                 short-circuits on a Stage-0
//                                                 DROP before ever reaching
//                                                 salience (the dominant
//                                                 production path)
//
// watermark.js:1649 documents the duplication explicitly. A throttle placed on
// only one of them is a no-op in production: measured after throttling just
// salience.js, 937 consecutive drop rows were emitted with zero suppression,
// because every one came through the watermark's inline mirror.
//
// WHAT IT FIXES. A drop event records that we did NOT remember something
// structurally-certain to be noise. The per-message row carries no audit value
// the aggregate lacks: July 2026 measured 1,080,947 such rows = 202 MB = 92%
// of the month's entire policy-event volume.
//
// SEMANTICS. The FIRST drop for a (source, reason) pair in each window emits,
// carrying suppressed_count = how many rows the PREVIOUS window elided.
// Subsequent drops increment the counter and write nothing. Volume becomes
// bounded by TIME (pairs x windows) rather than by traffic, so neither a mail
// backfill nor a git-log burst can inflate the log again.
//
// The keyspace is bounded — reasons come from the fixed Stage-0 rule set,
// sources from the fixed connector set — so the Map cannot grow without limit.
//
// Convention follows the two throttled kinds already in EVENT_KINDS:
// policy.salience.recall_feedback ("one audit row per recall, not one row per
// surfaced memory — the per-row alternative was rejected at architect time for
// 5-10x ledger inflation without added audit value") and the watermark
// auto-mute signal ("throttled daemon-side to once per mute window").
//
// CONTRACT PRESERVED: the ">=1 dropped event per source" assertion in
// mcp/test/integration/r25-end-to-end-cascade.test.mjs T4 still holds, because
// the first drop of every (source, reason) pair always emits.

export const DROP_THROTTLE_WINDOW_MS = 60 * 60 * 1000;

const _windowByKey = new Map();

/**
 * Decide whether this drop should be written.
 *
 * @param {object} args
 * @param {string} args.source    connector the row came from
 * @param {string} args.reason    Stage-0 drop reason
 * @param {string} [args.nowIso]  event time; falls back to wall clock
 * @returns {{emit: boolean, suppressed: number}} `suppressed` is the count the
 *   PREVIOUS window elided, and is meaningful only when `emit` is true.
 */
export function shouldEmitDrop({ source, reason, nowIso }) {
  const r = typeof reason === "string" && reason.length > 0 ? reason : "unspecified";
  const s = typeof source === "string" ? source : "unknown";
  const key = `${s}\u0000${r}`;

  const parsed = Date.parse(nowIso);
  const now = Number.isFinite(parsed) ? parsed : Date.now();

  const prev = _windowByKey.get(key);
  if (prev != null && now - prev.windowStart < DROP_THROTTLE_WINDOW_MS) {
    prev.suppressed += 1;
    return { emit: false, suppressed: 0 };
  }

  const suppressed = prev != null ? prev.suppressed : 0;
  _windowByKey.set(key, { windowStart: now, suppressed: 0 });
  return { emit: true, suppressed };
}

/** Test-only: clear throttle state so suites stay order-independent. */
export function _resetDropThrottle() {
  _windowByKey.clear();
}
