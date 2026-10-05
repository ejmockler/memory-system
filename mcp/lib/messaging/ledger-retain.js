// ledger-retain.js — the raw-row RETAIN primitive: the per-source ring bound
// and THE per-row since-filter/ring fold, owned by a module that imports
// NOTHING.
//
// WHY THIS FILE EXISTS (f5-catchup-seam). These bindings used to live in
// catchup.js, and envelope-projection.js imported them back — so catchup.js
// imported envelope-projection.js and envelope-projection.js imported
// catchup.js. That cycle was survivable only by a hand-maintained convention
// ("both modules dereference the other's bindings inside function bodies only,
// never at module eval"), asserted in prose in two header comments and enforced
// by nothing. A single module-scope dereference in either file would have
// turned the convention into a live TDZ ReferenceError whose symptom depends on
// which module the process imported FIRST — a defect that reproduces in
// production and not in a test that happens to import the other end first.
//
// Extracting the shared bindings downward makes the messaging module graph a
// strict DAG:
//
//        catchup.js ──────► envelope-projection.js
//             │                        │
//             └────────► ledger-retain.js ◄──────┘   (imports nothing)
//
// The TDZ class is then structurally impossible rather than conventionally
// avoided, and test/messaging/no-static-import-cycles.test.mjs keeps it that
// way. This file MUST stay import-free: it is the sink of that DAG.
//
// LAYERING. This is L1 wiring, not part of the L2-5 "never changes when a
// platform is added" set — it holds no classifier, identity, attention, or
// catch-up POLICY, only a size bound and a chronological ring. It is
// nevertheless registered in n10-invariant-eval.mjs's L2to5_SOURCES so the
// platform-token grep gate WIDENS with the move rather than silently shrinking:
// bytes that were scanned inside catchup.js stay scanned after leaving it.
// (Verified at extraction time: this file contains zero tokens from N10's
// PLATFORM_WORD_TOKENS / PLATFORM_LITERAL_FRAGMENTS. It names no platform.)
//
// ANTI-RECURRENCE (do not "finish the job" by moving more of catchup.js here).
// catchup.js is ~58% comment over ~1014 code lines and was touched 9 times in
// 101 commits; the last four scoring commits EACH spanned the CATCHUP_CAPS
// table AND the scoring block AND the rank loop inside buildCatchupCore. The
// L445-822 scoring cluster is therefore structurally separable but
// behaviourally INSEPARABLE — splitting it on line count would convert one
// atomic edit into three coordinated ones. It must not be re-proposed. What
// justified THIS extraction was not size, it was the cycle.
//
// SINGLE OWNER. LEDGER_RETAIN_CEILING has exactly one definition site
// repo-wide: here. envelope-projection.js bounds its persisted raw-row tail
// with THIS constant — imported, never duplicated — so the on-disk projection
// can never outgrow the widest window the reader itself would ever retain.
//
// THIRD COPY, DECLARED. `isPlainObject` below is the THIRD copy of a 3-line
// predicate in this directory; the other two are module-private by design and
// stay that way: catchup.js:759 `isPlainObject` and envelope-projection.js:147
// `isPlainObjectValue`. Importing either would re-introduce an edge into this
// module and undo the DAG — the whole point of the file. Naming the siblings
// here makes the duplication a declared cost rather than an accident.

// The retain FLOOR: no matter how small the caller's `limit`, at least this
// many recent raw rows per source are retained. Exported so catchup.js's
// `ledgerRetainCap` (which stays there — it is the one symbol of this cluster
// that reads CATCHUP_CAPS.DEFAULT_LIMIT, so this leaf needs no CAPS import)
// clamps against the same number the fold defaults to.
export const LEDGER_RETAIN_FLOOR = 2000;

// The hard per-source retain ceiling. Capped hard so a pathological `limit`
// can never blow the retain buffer, and so the persisted projection tail is
// bounded by the same number.
export const LEDGER_RETAIN_CEILING = 50000;

// See "THIRD COPY, DECLARED" above.
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Parse a raw row's timestamp to epoch ms, DATA-only (the field name is the
// generic source-ledger `ts` convention, an ISO-8601 string; `created_at` is the
// tolerated fallback, mirroring streamLedgerRowsInTimeWindow). Returns null when
// no parseable ts is present — the caller then KEEPS the row (no silent drop).
function rawRowTsMs(row) {
  if (!isPlainObject(row)) return null;
  const f =
    (typeof row.ts === "string" && row.ts) ||
    (typeof row.created_at === "string" && row.created_at) ||
    null;
  if (f === null) {
    if (typeof row.ts === "number" && Number.isFinite(row.ts)) return row.ts;
    return null;
  }
  const ms = Date.parse(f);
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// C1 — makeLedgerRetainFold: THE per-row since-filter/ring lambda, extracted so
// the full-stream path, the projection delta-fold path, and the projection's
// own stored-tail bound all run the IDENTICAL normalization (byte-identical
// output is the C1 equivalence gate; a second copy of this logic is exactly the
// drift the gate exists to catch).
//
// `cutoff` — epoch-ms floor (rows provably older are dropped; rows with NO
//   parseable ts are KEPT — no silent drop), or null for no window.
// `retainCap` — ring capacity: only the most-recent `retainCap` passing rows
//   are retained, in insertion (chronological) order.
// Returns { push, rows, count, wrapped }:
//   push(row)  — fold one parsed ledger row (extra args ignored, so it slots
//                directly into streamLedgerLines' onRow seat);
//   rows()     — materialize the retained window in insertion order;
//   count()    — total rows pushed post-filter (the C1 serve-equivalence
//                certificate reads this);
//   wrapped()  — true iff the ring evicted (count > retainCap).
// ---------------------------------------------------------------------------
export function makeLedgerRetainFold(cutoff, retainCap) {
  const cap =
    Number.isInteger(retainCap) && retainCap > 0 ? retainCap : LEDGER_RETAIN_FLOOR;
  const effCutoff =
    typeof cutoff === "number" && Number.isFinite(cutoff) ? cutoff : null;
  const ring = new Array(cap);
  let count = 0; // total rows pushed (post since-filter)
  return {
    push(row) {
      if (!isPlainObject(row)) return;
      if (effCutoff !== null) {
        const ts = rawRowTsMs(row);
        // KEEP rows with no parseable ts (no silent drop); drop only rows we
        // can prove are older than the window.
        if (ts !== null && ts < effCutoff) return;
      }
      ring[count % cap] = row;
      count += 1;
    },
    // Materialize the ring in CHRONOLOGICAL (insertion) order. When the ring did
    // not wrap, rows 0..count-1 are already in order; when it wrapped, the oldest
    // retained row sits at (count % cap).
    rows() {
      if (count <= cap) return ring.slice(0, count);
      const start = count % cap;
      return ring.slice(start).concat(ring.slice(0, start));
    },
    count() {
      return count;
    },
    wrapped() {
      return count > cap;
    },
  };
}
