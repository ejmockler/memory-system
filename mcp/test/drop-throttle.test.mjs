// drop-throttle.test.mjs — the shared Stage-0 drop breadcrumb throttle.
//
// Regression context: policy.salience.dropped has TWO producers —
// mcp/lib/ingest/salience.js emitDropped() and the inline mirror in
// daemons/watermark.js (~L1663) that fires when the watermark short-circuits
// on a Stage-0 DROP before ever reaching salience. The watermark mirror is the
// dominant production path. A throttle applied to only salience.js was a
// measured no-op: 937 consecutive drop rows landed with zero suppression.
//
// These tests pin the mechanism itself. Both producers importing this one
// module is what makes them share a window; that wiring is asserted by the
// import-site check at the bottom.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { shouldEmitDrop, _resetDropThrottle, DROP_THROTTLE_WINDOW_MS } =
  await import("../lib/ingest/drop-throttle.js");

const T0 = "2026-07-29T00:00:00.000Z";
const iso = (ms) => new Date(ms).toISOString();
const t0ms = Date.parse(T0);

test("first drop for a (source, reason) pair emits; the rest are elided", () => {
  _resetDropThrottle();

  const first = shouldEmitDrop({ source: "git-log", reason: "dup", nowIso: T0 });
  assert.equal(first.emit, true, "first drop in a window emits");
  assert.equal(first.suppressed, 0, "no prior window to report");

  for (let i = 1; i <= 500; i++) {
    const r = shouldEmitDrop({
      source: "git-log",
      reason: "dup",
      nowIso: iso(t0ms + i * 1000),
    });
    assert.equal(r.emit, false, `drop #${i} inside the window is elided`);
  }
});

test("the next window emits once and reports the elided count", () => {
  _resetDropThrottle();

  shouldEmitDrop({ source: "git-log", reason: "dup", nowIso: T0 });
  for (let i = 1; i <= 42; i++) {
    shouldEmitDrop({ source: "git-log", reason: "dup", nowIso: iso(t0ms + i * 1000) });
  }

  const next = shouldEmitDrop({
    source: "git-log",
    reason: "dup",
    nowIso: iso(t0ms + DROP_THROTTLE_WINDOW_MS + 1),
  });
  assert.equal(next.emit, true, "a new window emits again");
  assert.equal(next.suppressed, 42, "reports exactly what the prior window elided");
});

test("windows are per (source, reason), not global", () => {
  _resetDropThrottle();

  assert.equal(shouldEmitDrop({ source: "git-log", reason: "dup", nowIso: T0 }).emit, true);
  // Same reason, different source -> independent window.
  assert.equal(shouldEmitDrop({ source: "mail", reason: "dup", nowIso: T0 }).emit, true);
  // Same source, different reason -> independent window.
  assert.equal(shouldEmitDrop({ source: "git-log", reason: "bot", nowIso: T0 }).emit, true);
  // Repeats of an already-open pair stay elided.
  assert.equal(shouldEmitDrop({ source: "git-log", reason: "dup", nowIso: T0 }).emit, false);
});

test("volume is bounded by TIME, not by traffic", () => {
  _resetDropThrottle();

  // One million drops for a single pair spread over 3 windows must produce
  // exactly 3 emitted rows. This is the property that stops a mail backfill or
  // a git-log burst from reproducing July's 1,080,947-row / 202 MB blowup.
  let emitted = 0;
  const span = DROP_THROTTLE_WINDOW_MS * 3;
  for (let i = 0; i < 1_000_000; i++) {
    const at = t0ms + Math.floor((i / 1_000_000) * span);
    if (shouldEmitDrop({ source: "mail", reason: "list_id", nowIso: iso(at) }).emit) emitted++;
  }
  assert.equal(emitted, 3, "3 windows -> 3 rows, regardless of 1M inputs");
});

test("a malformed/absent timestamp still throttles (falls back to wall clock)", () => {
  _resetDropThrottle();

  const a = shouldEmitDrop({ source: "imessage", reason: "x", nowIso: "not-a-date" });
  const b = shouldEmitDrop({ source: "imessage", reason: "x", nowIso: undefined });
  assert.equal(a.emit, true, "first still emits");
  assert.equal(b.emit, false, "second is elided rather than defaulting open");
});

test("both producers import the shared module (wiring guard)", () => {
  // The bug this suite exists for was a wiring bug, not a logic bug: the
  // throttle was correct but sat on the path production does not take.
  const salience = readFileSync(
    new URL("../lib/ingest/salience.js", import.meta.url),
    "utf8",
  );
  const watermark = readFileSync(
    new URL("../../daemons/watermark.js", import.meta.url),
    "utf8",
  );

  assert.ok(
    /import\s*\{[^}]*shouldEmitDrop[^}]*\}\s*from\s*["'][^"']*drop-throttle\.js["']/.test(salience),
    "salience.js imports shouldEmitDrop from the shared module",
  );
  assert.ok(
    /import\s*\{[^}]*shouldEmitDrop[^}]*\}\s*from\s*["'][^"']*drop-throttle\.js["']/.test(watermark),
    "watermark.js imports shouldEmitDrop from the shared module",
  );

  // Neither may carry a private throttle map again.
  assert.ok(
    !salience.includes("__dropThrottleByKey"),
    "salience.js no longer keeps a private throttle map",
  );

  // Every policy.salience.dropped emit site must be throttle-gated.
  for (const [name, src] of [["salience.js", salience], ["watermark.js", watermark]]) {
    const emits = (src.match(/kind:\s*"policy\.salience\.dropped"/g) || []).length;
    const gates = (src.match(/shouldEmitDrop\s*\(/g) || []).length;
    assert.ok(
      gates >= emits,
      `${name}: ${emits} dropped-emit site(s) but only ${gates} throttle gate(s)`,
    );
  }
});
