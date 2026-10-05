// watermark-aggregation-throttle.test.mjs
//
// Regression for the 2026-07-06 production stall: the watermark daemon invoked
// runThreadAggregation / runProjectAggregation EVERY tick (~15s), un-awaited,
// each streaming + JSON.parsing the entire ~1.9GB / ~1.5M-row memory.jsonl
// ledger. Because the calls were fire-and-forget and each now takes minutes,
// successive ticks piled up concurrent full-ledger scans → 5.9GB RSS, GC
// thrash, event-loop starvation, frozen git-log cursor, embed HTTP timeouts.
//
// The fix (daemons/watermark.js) wraps each aggregation in a maybeRun* helper
// that (A) THROTTLES to once per AGGREGATION_CHECK_EVERY_N_TICKS ticks and
// (B) enforces a per-aggregator RE-ENTRANCY GUARD so at most ONE full-ledger
// scan of each kind is ever in flight, regardless of cadence or ledger size.
//
// This test proves both properties in-process, WITHOUT a real ledger, by
// injecting stub runners via _setAggregationRunnersForTest and driving the tick
// counter directly.
//
//   (1) THROTTLE  — over the first N-1 ticks aggregation fires 0 times; on the
//                   Nth tick it fires exactly once.
//   (2) GUARD     — while a launched run's promise is still pending, the next
//                   scheduled cadence cycle does NOT launch a second run; after
//                   the pending promise RESOLVES (and, separately, after one
//                   REJECTS) the in-flight flag clears so a later cycle fires.
//
// Run: node --test mcp/test/daemons/watermark-aggregation-throttle.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Hermetic env — MUST be set BEFORE the dynamic import touches config.js.
// The real aggregation runners are never invoked (we inject stubs), so no real
// ledger is required; these dirs only satisfy config.js at import time.
// -----------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-wm-agg-throttle-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.POLICY_BASE_DIR = join(TMP_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TMP_ROOT, "ledgers");
process.env.HOOKS_BASE_DIR = join(TMP_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(TMP_ROOT, "daemons");
process.env.MEMORY_TEST_STUB_EMBEDDER = "1";
for (const d of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  process.env.HOOKS_BASE_DIR,
  process.env.DAEMONS_BASE_DIR,
  join(process.env.STORAGE_BASE_DIR, "watermark-state"),
  join(process.env.STORAGE_BASE_DIR, "sources"),
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

const wm = await import("../../../daemons/watermark.js");
const {
  maybeRunThreadAggregation,
  maybeRunProjectAggregation,
  _setAggregationRunnersForTest,
  _resetAggregationStateForTest,
  AGGREGATION_CHECK_EVERY_N_TICKS,
} = wm;

// Boot-time structural sanity: every seam this test drives MUST be exported.
for (const [name, value] of Object.entries({
  maybeRunThreadAggregation,
  maybeRunProjectAggregation,
  _setAggregationRunnersForTest,
  _resetAggregationStateForTest,
  AGGREGATION_CHECK_EVERY_N_TICKS,
})) {
  assert.notEqual(value, undefined, `daemons/watermark.js must export ${name}`);
}

const N = AGGREGATION_CHECK_EVERY_N_TICKS;
assert.ok(
  Number.isInteger(N) && N >= 2,
  `AGGREGATION_CHECK_EVERY_N_TICKS must be an integer >= 2 (got ${N})`,
);

// Flush the microtask queue so a settled runner promise's .then/.catch/.finally
// (which clears the in-flight guard) has run before we assert. setImmediate
// fires after the microtask queue drains.
const flush = () => new Promise((r) => setImmediate(r));

// A deferred whose settlement we control, so a "run" can be held pending across
// tick cycles to exercise the re-entrancy guard.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const okCounts = { threads_processed: 0, reconstructed_emitted: 0, errors: 0 };

// -----------------------------------------------------------------------------
// (1) THROTTLE — thread aggregator.
// -----------------------------------------------------------------------------
test("throttle: thread aggregation fires 0 times over N-1 ticks, once on the Nth", async () => {
  _resetAggregationStateForTest();
  let calls = 0;
  _setAggregationRunnersForTest({
    thread: () => {
      calls += 1;
      return Promise.resolve(okCounts);
    },
  });
  try {
    for (let i = 1; i < N; i++) {
      const fired = maybeRunThreadAggregation({ now: undefined });
      assert.equal(fired, false, `tick ${i} below threshold must NOT fire`);
    }
    assert.equal(calls, 0, "no launch before the Nth tick");

    const firedOnN = maybeRunThreadAggregation({ now: undefined });
    assert.equal(firedOnN, true, `tick ${N} crosses threshold and fires`);
    assert.equal(calls, 1, "exactly one launch on the Nth tick");

    await flush(); // let the resolved run settle (clears the guard)

    // Counter reset after firing: another full N ticks are needed to fire again.
    for (let i = 1; i < N; i++) {
      assert.equal(
        maybeRunThreadAggregation({ now: undefined }),
        false,
        `post-reset tick ${i} must NOT fire`,
      );
    }
    assert.equal(maybeRunThreadAggregation({ now: undefined }), true, "fires at 2N");
    assert.equal(calls, 2, "second launch only at the second N-boundary");
  } finally {
    _setAggregationRunnersForTest(null);
  }
});

// -----------------------------------------------------------------------------
// (1b) THROTTLE — project aggregator (independent counter, same cadence).
// -----------------------------------------------------------------------------
test("throttle: project aggregation honors the same N-tick cadence independently", async () => {
  _resetAggregationStateForTest();
  let calls = 0;
  _setAggregationRunnersForTest({
    project: () => {
      calls += 1;
      return Promise.resolve({ projects_processed: 0, reconstructed_emitted: 0, errors: 0 });
    },
  });
  try {
    for (let i = 1; i < N; i++) {
      assert.equal(maybeRunProjectAggregation({ now: undefined }), false, `tick ${i}`);
    }
    assert.equal(calls, 0, "no launch before the Nth tick");
    assert.equal(maybeRunProjectAggregation({ now: undefined }), true, `fires at N`);
    assert.equal(calls, 1, "one launch at the Nth tick");
    await flush();
  } finally {
    _setAggregationRunnersForTest(null);
  }
});

// -----------------------------------------------------------------------------
// (2) GUARD — a pending run blocks the next cadence cycle; RESOLVE clears it.
// -----------------------------------------------------------------------------
test("guard: a still-pending thread run blocks the next cycle; resolve clears the flag", async () => {
  _resetAggregationStateForTest();
  let calls = 0;
  const d = deferred();
  _setAggregationRunnersForTest({
    thread: () => {
      calls += 1;
      return d.promise; // stays pending until we resolve it
    },
  });
  try {
    // Cycle 1: drive to the N-boundary → one launch; its promise is left pending.
    for (let i = 1; i < N; i++) maybeRunThreadAggregation({ now: undefined });
    assert.equal(maybeRunThreadAggregation({ now: undefined }), true, "cycle 1 fires at N");
    assert.equal(calls, 1, "cycle 1 launched exactly one run");
    await flush(); // guard must NOT clear — the run is still pending
    assert.equal(calls, 1, "run still pending, no extra launch after flush");

    // Cycle 2: drive another full N ticks. The Nth tick's throttle WOULD fire,
    // but the guard sees the prior run still in flight and skips → returns false
    // and launches NOTHING. This is the anti-pileup invariant.
    for (let i = 1; i < N; i++) maybeRunThreadAggregation({ now: undefined });
    const firedWhileInFlight = maybeRunThreadAggregation({ now: undefined });
    assert.equal(firedWhileInFlight, false, "guard skips the cadence cycle while in flight");
    assert.equal(calls, 1, "NO second concurrent full-ledger scan launched (the fix)");

    // Resolve the in-flight run → .finally clears the guard.
    d.resolve(okCounts);
    await flush();

    // Cycle 3: another full N ticks now fires again (guard cleared on resolve).
    for (let i = 1; i < N; i++) maybeRunThreadAggregation({ now: undefined });
    assert.equal(maybeRunThreadAggregation({ now: undefined }), true, "cycle 3 fires after resolve");
    assert.equal(calls, 2, "a new run launches only after the prior one settled");
  } finally {
    _setAggregationRunnersForTest(null);
  }
});

// -----------------------------------------------------------------------------
// (2b) GUARD — a REJECTED run also clears the flag (rejection must never wedge).
// -----------------------------------------------------------------------------
test("guard: a rejected thread run clears the flag so a later cycle can fire", async () => {
  _resetAggregationStateForTest();
  let calls = 0;
  let d = deferred();
  _setAggregationRunnersForTest({
    thread: () => {
      calls += 1;
      return d.promise;
    },
  });
  try {
    // Launch one run and leave it pending.
    for (let i = 1; i < N; i++) maybeRunThreadAggregation({ now: undefined });
    assert.equal(maybeRunThreadAggregation({ now: undefined }), true, "fires at N");
    assert.equal(calls, 1);

    // Reject it — the helper's .catch handles it and .finally clears the guard.
    d.reject(new Error("simulated aggregation failure"));
    await flush();

    // Fresh (resolved) deferred for the next launch so it doesn't re-attach to
    // the already-rejected promise (cosmetic: avoids a duplicate stderr line).
    d = deferred();
    d.resolve(okCounts);

    // A later full cadence cycle must be able to fire again (flag not wedged).
    for (let i = 1; i < N; i++) maybeRunThreadAggregation({ now: undefined });
    assert.equal(
      maybeRunThreadAggregation({ now: undefined }),
      true,
      "cadence fires after the prior run REJECTED (guard cleared on reject)",
    );
    assert.equal(calls, 2, "a fresh run launched after the rejection cleared the guard");
  } finally {
    _setAggregationRunnersForTest(null);
  }
});
