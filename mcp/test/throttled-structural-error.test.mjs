// throttled-structural-error.test.mjs — R29.5 regression test for the
// ThrottledStructuralError marker base class hierarchy.
//
// Architectural-invariant test: callers (watermark wrapper-catch + D1
// prefetch-catch) decide whether to throttle a stderr log on
// `err instanceof ThrottledStructuralError`. This pins:
//
//   - KeyPoolExhaustedError IS a subclass of ThrottledStructuralError.
//   - KeyPoolExhaustedError IS still a subclass of Error (prototype chain).
//   - The `.name` string contract is preserved at "KeyPoolExhaustedError"
//     so operator dashboards filtering on .name keep working.
//   - A plain Error is NOT instanceof ThrottledStructuralError (negative).
//   - A future synthetic structural-error subclass IS recognized via
//     instanceof without any throttle-layer code change (extensibility
//     guarantee — the discipline of the marker base class).
//   - next_retry_at_iso is preserved on KeyPoolExhaustedError (back-compat
//     with the R29.0 / R29.3 carrier contract that downstream logs use to
//     surface the cooldown ETA).
//
// HERMETIC: pure import + assert. No env mutation, no fs, no fetch, no
// timers.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ThrottledStructuralError,
  KeyPoolExhaustedError,
} from "../lib/gemini-client.js";

test("T1: KeyPoolExhaustedError IS instanceof ThrottledStructuralError AND Error", () => {
  const e = new KeyPoolExhaustedError("pool exhausted");
  assert.ok(
    e instanceof ThrottledStructuralError,
    "KeyPoolExhaustedError must extend ThrottledStructuralError so throttle " +
      "layers in watermark.js (wrapper-catch + prefetch-catch) recognize it " +
      "via instanceof",
  );
  assert.ok(
    e instanceof Error,
    "ThrottledStructuralError must extend Error so try/catch + standard " +
      "error-handling layers still match",
  );
  assert.ok(
    e instanceof KeyPoolExhaustedError,
    "instanceof on the leaf class itself must still work",
  );
});

test("T2: KeyPoolExhaustedError.name === 'KeyPoolExhaustedError' (string contract)", () => {
  const e = new KeyPoolExhaustedError("pool exhausted");
  assert.equal(
    e.name,
    "KeyPoolExhaustedError",
    "operator dashboards / log greppers filter on the literal name string; " +
      "do NOT regress to constructor.name fallback for this leaf",
  );
});

test("T3: a plain Error is NOT instanceof ThrottledStructuralError (negative)", () => {
  const generic = new Error("transport blew up");
  assert.ok(
    !(generic instanceof ThrottledStructuralError),
    "per-instance noise (transport errors, etc.) must NOT be silently " +
      "throttled — only structural errors in the marker hierarchy",
  );
  // Also: a TypeError must not match.
  const t = new TypeError("not a function");
  assert.ok(
    !(t instanceof ThrottledStructuralError),
    "subclasses of Error that are NOT in the structural hierarchy must " +
      "also fail the instanceof check",
  );
});

test("T4: a future synthetic subclass IS recognized via instanceof", () => {
  // Synthetic future class. The whole point of the marker base is that
  // throttle layers pick this up with zero code change.
  class KeyPoolNotConfiguredErrorSynthetic extends ThrottledStructuralError {
    constructor(message) {
      super(message);
      // Note: the base sets .name = this.constructor.name automatically.
    }
  }
  const e = new KeyPoolNotConfiguredErrorSynthetic("no keys in env");
  assert.ok(
    e instanceof ThrottledStructuralError,
    "future structural-error subclasses must be recognized by throttle " +
      "layers via the marker base — this is the discipline",
  );
  assert.ok(e instanceof Error, "must also be a real Error");
  assert.equal(
    e.name,
    "KeyPoolNotConfiguredErrorSynthetic",
    "base-class constructor must default .name to constructor.name when " +
      "the subclass does not pin its own literal",
  );
  // Default retryable: structural errors are non-retryable by base contract.
  assert.equal(
    e.retryable,
    false,
    "base contract: structural errors are non-retryable so the transport " +
      "retry layer does not hot-loop on them",
  );
});

test("T5: KeyPoolExhaustedError preserves next_retry_at_iso (R29 carrier contract)", () => {
  const iso = "2026-06-04T20:57:00.000Z";
  const e = new KeyPoolExhaustedError("pool exhausted until " + iso, {
    next_retry_at_iso: iso,
  });
  assert.equal(
    e.next_retry_at_iso,
    iso,
    "next_retry_at_iso must be preserved as a top-level property — " +
      "downstream logs / status emitters read it directly",
  );

  // Missing opts → null (back-compat with R29.0 default).
  const e2 = new KeyPoolExhaustedError("no opts");
  assert.equal(
    e2.next_retry_at_iso,
    null,
    "missing opts must yield next_retry_at_iso = null (not undefined)",
  );

  // Non-string iso → null (defensive against accidental Date / number args).
  const e3 = new KeyPoolExhaustedError("bad opts", { next_retry_at_iso: 12345 });
  assert.equal(
    e3.next_retry_at_iso,
    null,
    "non-string iso input must be normalized to null (defensive)",
  );

  // Back-compat: retryable is false (inherited from ThrottledStructuralError).
  assert.equal(
    e.retryable,
    false,
    "KeyPoolExhaustedError inherits retryable=false from the base — this " +
      "preserves the R29.0 contract that the embed-retry layer does not " +
      "hot-loop on pool exhaustion",
  );
});
