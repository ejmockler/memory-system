// test-ops-daemon-quiesce.test.mjs — R29.2 CRIT-3 helper coverage.
//
// Verifies the pure-Node daemon-quiesce detection convention used by
// promote-time-embedding.test.mjs (and any other test that asserts
// hermeticity on production memory.jsonl / HNSW / BM25 / state.json).
//
// Convention: a state file modified inside the last 30s signals an active
// daemon; missing or stale files signal quiesced.
//
// HERMETICITY: this test uses mkdtempSync; no production paths touched.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";

// Mirror the helper from promote-time-embedding.test.mjs. Keeping it inline
// (not a shared import) preserves the convention's single-file readability
// for any operator copying it into a new test.
const DAEMON_ACTIVE_THRESHOLD_MS = 30_000;
function makeIsDaemonActive(stateFiles) {
  return function isDaemonActive() {
    for (const p of stateFiles) {
      try {
        const st = statSync(p);
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs < DAEMON_ACTIVE_THRESHOLD_MS) {
          return { active: true, path: p, ageMs };
        }
      } catch {
        // missing — not a signal
      }
    }
    return { active: false };
  };
}

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-quiesce-helper-"));
mkdirSync(TMP_ROOT, { recursive: true });

let passes = 0;
let failures = 0;
function pass(label) {
  passes += 1;
  console.log(`  pass: ${label}`);
}
function fail(label, detail) {
  failures += 1;
  console.log(`  FAIL: ${label}`);
  if (detail) console.log(`        ${detail}`);
}
function test(label, fn) {
  console.log(`test: ${label}`);
  try {
    fn();
  } catch (err) {
    fail(label, err && err.stack ? err.stack : String(err));
  }
}

// --- T1: fresh state file -> active = true ---------------------------------
test("T1: fresh state file (mtime now) reports active=true", () => {
  const p = join(TMP_ROOT, "fresh-state.json");
  writeFileSync(p, '{"tick":1}', { mode: 0o600 });
  // Default mtime is now; no utimes needed.
  const helper = makeIsDaemonActive([p]);
  const r = helper();
  if (r.active !== true) {
    fail("T1 expected active=true", JSON.stringify(r));
    return;
  }
  if (r.path !== p) {
    fail("T1 reported path mismatch", `got=${r.path} expected=${p}`);
    return;
  }
  // mtimeMs is sub-ms-precise while Date.now() is integer ms, so a freshly
  // written file can yield a tiny negative ageMs. Accept a small band.
  if (typeof r.ageMs !== "number" || r.ageMs < -10 || r.ageMs > 5_000) {
    fail("T1 ageMs out of expected just-now band", `ageMs=${r.ageMs}`);
    return;
  }
  pass(`T1: fresh file detected as active (ageMs=${r.ageMs})`);
});

// --- T2: stale state file -> active = false --------------------------------
test("T2: stale state file (mtime 5 min ago) reports active=false", () => {
  const p = join(TMP_ROOT, "stale-state.json");
  writeFileSync(p, '{"tick":1}', { mode: 0o600 });
  const fiveMinAgo = (Date.now() - 5 * 60 * 1000) / 1000;
  utimesSync(p, fiveMinAgo, fiveMinAgo);
  const helper = makeIsDaemonActive([p]);
  const r = helper();
  if (r.active !== false) {
    fail("T2 expected active=false", JSON.stringify(r));
    return;
  }
  pass("T2: stale file correctly reports inactive");
});

// --- T3: missing state file -> active = false ------------------------------
test("T3: missing state file reports active=false", () => {
  const p = join(TMP_ROOT, "does-not-exist.json");
  const helper = makeIsDaemonActive([p]);
  const r = helper();
  if (r.active !== false) {
    fail("T3 expected active=false for missing file", JSON.stringify(r));
    return;
  }
  pass("T3: missing file correctly reports inactive");
});

// --- T4: mixed list (one fresh, one stale) -> active = true ----------------
test("T4: list with any fresh file reports active=true", () => {
  const stale = join(TMP_ROOT, "mixed-stale.json");
  const fresh = join(TMP_ROOT, "mixed-fresh.json");
  writeFileSync(stale, "{}", { mode: 0o600 });
  writeFileSync(fresh, "{}", { mode: 0o600 });
  const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
  utimesSync(stale, oneHourAgo, oneHourAgo);
  const helper = makeIsDaemonActive([stale, fresh]);
  const r = helper();
  if (r.active !== true) {
    fail("T4 expected active=true (one fresh in list)", JSON.stringify(r));
    return;
  }
  if (r.path !== fresh) {
    fail("T4 reported wrong path", `got=${r.path} expected=${fresh}`);
    return;
  }
  pass("T4: mixed list correctly identifies the fresh file as the trigger");
});

// --- T5: exactly-at-threshold boundary -------------------------------------
test("T5: file just OVER 30s old reports active=false", () => {
  const p = join(TMP_ROOT, "boundary-state.json");
  writeFileSync(p, "{}", { mode: 0o600 });
  // 31s ago: comfortably past the 30s threshold.
  const thirtyOneSecAgo = (Date.now() - 31_000) / 1000;
  utimesSync(p, thirtyOneSecAgo, thirtyOneSecAgo);
  const helper = makeIsDaemonActive([p]);
  const r = helper();
  if (r.active !== false) {
    fail("T5 expected active=false for 31s-old file", JSON.stringify(r));
    return;
  }
  pass("T5: file just past threshold correctly reports inactive");
});

// --- cleanup ---------------------------------------------------------------
try {
  rmSync(TMP_ROOT, { recursive: true, force: true });
} catch {
  // best-effort
}

console.log("");
console.log(`test-ops-daemon-quiesce.test.mjs: ${passes} passed, ${failures} failed`);
if (failures > 0) {
  process.exit(1);
}
process.exit(0);
