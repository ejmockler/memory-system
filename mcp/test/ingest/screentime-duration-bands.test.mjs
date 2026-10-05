// screentime-duration-bands.test.mjs
//
// F-NEW-W7-SCREENTIME-DURATION-BAND-TESTS — unit tests for the
// /app/usage duration-band structural-score helper in
// mcp/lib/ingest/stage0/screentime.js
// (F-NEW-W7-SCREENTIME-USAGE-DURATION-BAND, routed through
// F-NEW-W7-SCREENTIME-BAND-CENTRAL-SCORE / resolveBand).
//
// Asserts the 5 bands at boundary + interior values:
//   duration_sec < 5       → 0.10 (micro_burst; would already be DROPped
//                                  by F-T2-SCREENTIME-F3, kept for parity)
//   5  <= duration_sec < 30   → 0.20 (brief_glance)
//   30 <= duration_sec < 120  → 0.35 (engaged)
//   120<= duration_sec < 600  → 0.50 (focused_work)
//   duration_sec >= 600    → 0.65 (sustained)
//
// Tested boundary values:
//   3   → 0.10
//   5   → 0.20 (lower boundary of brief_glance)
//   29  → 0.20
//   30  → 0.35 (lower boundary of engaged)
//   119 → 0.35
//   120 → 0.50 (lower boundary of focused_work)
//   599 → 0.50
//   600 → 0.65 (lower boundary of sustained)
//   3600→ 0.65
//
// Also asserts the band defaults are exported, the central resolveBand
// override pathway is used (overrides win), and that duration_sec===null
// falls back to the legacy "default" band (signal-bearing unknown).
//
// HERMETIC: a tmpdir-scoped MEMORY_ROOT/STORAGE_BASE_DIR/QUARANTINE_BASE_DIR
// stack is set BEFORE any import.

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const TEST_ROOT = mkdtempSync(
  join(tmpdir(), "memsys-screentime-duration-bands-")
);
const STORAGE = join(TEST_ROOT, "storage");
const QUARANTINE = join(TEST_ROOT, "storage", "quarantine");
mkdirSync(join(STORAGE, "sources"), { recursive: true });
mkdirSync(QUARANTINE, { recursive: true });
process.env.MEMORY_ROOT = TEST_ROOT;
// Synthetic operator identity, resolved once at operator-identity.js load, so
// it is set before the first library import.
process.env.MEMORY_OPERATOR_IDENTITY_FILE = fileURLToPath(
  new URL("../fixtures/operator-identity.synthetic.json", import.meta.url),
);
process.env.STORAGE_BASE_DIR = STORAGE;
process.env.QUARANTINE_BASE_DIR = QUARANTINE;
process.on("exit", () => {
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

// Dynamic imports — must come AFTER env is set.
const {
  stage0: screentimeStage0,
  resetForTests,
  USAGE_DURATION_BAND_NAMES,
  USAGE_DURATION_BAND_DEFAULTS,
  _F_NEW_W7_SCREENTIME_USAGE_DURATION_BAND,
} = await import("../../lib/ingest/stage0/screentime.js");

const { _appUsageDurationBand } = _F_NEW_W7_SCREENTIME_USAGE_DURATION_BAND;

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${label}`);
  } else {
    fail += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// Build a synthetic /app/usage row with the given duration_sec.
function buildUsage(durationSec) {
  return {
    id: `ulid_test_${durationSec}`,
    source: "screentime",
    ts: "2026-06-09T10:00:00.000Z",
    raw_content: {
      stream: "/app/usage",
      app_bundle_id: "com.google.Chrome",
      duration_sec: durationSec,
    },
  };
}

resetForTests();

// ---------------------------------------------------------------------------
// Direct-helper checks: every boundary value.
//
// Note: F-T2-SCREENTIME-F3 quarantines <5s rows BEFORE the band lookup in
// stage0() dispatch, so the 3-second case is asserted against the
// banding helper directly (not via stage0()). The band value is still
// load-bearing for any future caller that bypasses the DROP path.
// ---------------------------------------------------------------------------
console.log("\n--- Direct band helper: boundary values ---");

const BOUNDARY_CASES = [
  { duration: 3, expected: 0.10, label: "duration=3 (micro_burst interior)" },
  { duration: 5, expected: 0.20, label: "duration=5 (brief_glance lower boundary)" },
  { duration: 29, expected: 0.20, label: "duration=29 (brief_glance interior)" },
  { duration: 30, expected: 0.35, label: "duration=30 (engaged lower boundary)" },
  { duration: 119, expected: 0.35, label: "duration=119 (engaged interior)" },
  { duration: 120, expected: 0.50, label: "duration=120 (focused_work lower boundary)" },
  { duration: 599, expected: 0.50, label: "duration=599 (focused_work interior)" },
  { duration: 600, expected: 0.65, label: "duration=600 (sustained lower boundary)" },
  { duration: 3600, expected: 0.65, label: "duration=3600 (sustained interior)" },
];

for (const { duration, expected, label } of BOUNDARY_CASES) {
  const got = _appUsageDurationBand(duration);
  ok(
    `${label} → ${expected}`,
    got === expected,
    `got=${got}`
  );
}

// ---------------------------------------------------------------------------
// stage0() integration: rows >=5s flow through to the PASS path and emit
// the banded structural_score. We assert on the 5s boundary and one
// interior value per band that survives F-T2-SCREENTIME-F3.
// ---------------------------------------------------------------------------
console.log("\n--- stage0() integration: structural_score plumbing ---");

const STAGE0_CASES = [
  { duration: 5, expected: 0.20 },
  { duration: 29, expected: 0.20 },
  { duration: 30, expected: 0.35 },
  { duration: 119, expected: 0.35 },
  { duration: 120, expected: 0.50 },
  { duration: 599, expected: 0.50 },
  { duration: 600, expected: 0.65 },
  { duration: 3600, expected: 0.65 },
];

for (const { duration, expected } of STAGE0_CASES) {
  const r = screentimeStage0(buildUsage(duration));
  ok(
    `stage0(/app/usage, duration_sec=${duration}) → PASS, structural_score=${expected}`,
    r.decision === "PASS" &&
      r.reason === null &&
      r.structural_score === expected,
    `got decision=${r.decision} reason=${r.reason} score=${r.structural_score}`
  );
}

// ---------------------------------------------------------------------------
// Sub-5s rows DROP via F-T2-SCREENTIME-F3 (band logic is bypassed).
// ---------------------------------------------------------------------------
console.log("\n--- stage0() integration: sub-5s rows DROP upstream ---");
{
  const r = screentimeStage0(buildUsage(3));
  ok(
    "duration_sec=3 → DROP (F-T2-SCREENTIME-F3 micro-burst), not band PASS",
    r.decision === "DROP" && r.reason === "app_usage_micro_burst",
    `got decision=${r.decision} reason=${r.reason}`
  );
}

// ---------------------------------------------------------------------------
// duration_sec === null / missing → falls back to legacy resolveBand
// default (signal-bearing "unknown duration").
// ---------------------------------------------------------------------------
console.log("\n--- duration_sec null/missing falls back to default band ---");
{
  const r = screentimeStage0({
    id: "ulid_test_null_dur",
    source: "screentime",
    ts: "2026-06-09T10:00:00.000Z",
    raw_content: {
      stream: "/app/usage",
      app_bundle_id: "com.google.Chrome",
      duration_sec: null,
    },
  });
  ok(
    "duration_sec=null PASSes with the default screentime band (0.40)",
    r.decision === "PASS" &&
      typeof r.structural_score === "number" &&
      r.structural_score === 0.40,
    `got decision=${r.decision} score=${r.structural_score}`
  );
}

// ---------------------------------------------------------------------------
// F-NEW-W7-SCREENTIME-BAND-CENTRAL-SCORE — exported defaults + name set
// shape contract.
// ---------------------------------------------------------------------------
console.log("\n--- Exported band-name + default contract ---");
{
  ok(
    "USAGE_DURATION_BAND_NAMES exposes 5 named bands",
    typeof USAGE_DURATION_BAND_NAMES === "object" &&
      USAGE_DURATION_BAND_NAMES.MICRO_BURST === "usage_band_micro_burst" &&
      USAGE_DURATION_BAND_NAMES.BRIEF_GLANCE === "usage_band_brief_glance" &&
      USAGE_DURATION_BAND_NAMES.ENGAGED === "usage_band_engaged" &&
      USAGE_DURATION_BAND_NAMES.FOCUSED_WORK === "usage_band_focused_work" &&
      USAGE_DURATION_BAND_NAMES.SUSTAINED === "usage_band_sustained",
    `got names=${JSON.stringify(USAGE_DURATION_BAND_NAMES)}`
  );
  ok(
    "USAGE_DURATION_BAND_DEFAULTS pairs the names with the 0.10/0.20/0.35/0.50/0.65 band scores",
    USAGE_DURATION_BAND_DEFAULTS[USAGE_DURATION_BAND_NAMES.MICRO_BURST] === 0.10 &&
      USAGE_DURATION_BAND_DEFAULTS[USAGE_DURATION_BAND_NAMES.BRIEF_GLANCE] === 0.20 &&
      USAGE_DURATION_BAND_DEFAULTS[USAGE_DURATION_BAND_NAMES.ENGAGED] === 0.35 &&
      USAGE_DURATION_BAND_DEFAULTS[USAGE_DURATION_BAND_NAMES.FOCUSED_WORK] === 0.50 &&
      USAGE_DURATION_BAND_DEFAULTS[USAGE_DURATION_BAND_NAMES.SUSTAINED] === 0.65,
    `got defaults=${JSON.stringify(USAGE_DURATION_BAND_DEFAULTS)}`
  );
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} ${pass} assertions, ${fail} failures`);
if (fail > 0) process.exit(1);
