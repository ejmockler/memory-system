// screentime-burst-collapse.test.mjs
//
// F-NEW-W7-SCREENTIME-BURST-TESTS — unit tests for the intra-source
// INSendMessageIntent burst-collapse LRU in
// mcp/lib/ingest/stage0/screentime.js
// (F-NEW-W7-SCREENTIME-INSENDMESSAGE-BURST-COLLAPSE).
//
// Asserts:
//   1. Same canonical handle within 5s → second row DROPped with reason
//      'screentime_insendmessage_burst_dup'.
//   2. Same handle after 6s → both PASS (window has elapsed).
//   3. Different handles within 5s → both PASS (no collision in LRU).
//   4. LRU cap at 1000: insert 1001 distinct entries; first inserted key
//      is evicted (no longer in the map).
//   5. resetForTests() clears the LRU map.
//   6. F-NEW-W7-SCREENTIME-HANDLE-NORMALIZE-ALIGN: burst-collapse handle
//      derivation matches the cross-source-dedup substrate's extractor on
//      the same row (canonical key parity).
//
// HERMETIC: a tmpdir-scoped MEMORY_ROOT/STORAGE_BASE_DIR/QUARANTINE_BASE_DIR
// stack is set BEFORE any import of stage0/screentime so quarantineRow
// writes do not touch the operator's real ledger.

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// HERMETICITY: env vars MUST be set before dynamic-imports of any module
// that resolves STORAGE_DIR / QUARANTINE_BASE_DIR via config.js.
const TEST_ROOT = mkdtempSync(
  join(tmpdir(), "memsys-screentime-burst-collapse-")
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
  _F_NEW_W7_SCREENTIME_INSENDMESSAGE_BURST,
} = await import("../../lib/ingest/stage0/screentime.js");
const { canonicalizeHandle } = await import(
  "../../lib/ingest/cross-source-dedup.js"
);

const {
  REASON_INSENDMESSAGE_BURST_DUP,
  INSENDMESSAGE_LRU_CAP,
  INSENDMESSAGE_BURST_WINDOW_MS,
  INSENDMESSAGE_LRU,
  _deriveHandle,
} = _F_NEW_W7_SCREENTIME_INSENDMESSAGE_BURST;

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

// Helper: build a synthetic INSendMessageIntent screentime row at a given
// timestamp (ISO ms) with a given recipient handle.
function buildIntent(handle, isoTs) {
  return {
    id: `ulid_test_${handle}_${isoTs}`,
    source: "screentime",
    ts: isoTs,
    raw_content: {
      stream: "/app/intents",
      intent_class: "INSendMessageIntent",
      related_contact_ids: handle,
      app_bundle_id: "com.apple.MobileSMS",
    },
  };
}

// ---------------------------------------------------------------------------
// Case 1: Same handle within 5s → second row DROPped with burst reason.
// ---------------------------------------------------------------------------
console.log("\n--- Case 1: same handle within 5s window ---");
resetForTests();
{
  const handle = "+15555550001";
  const t0 = "2026-06-09T10:00:00.000Z";
  const t1 = "2026-06-09T10:00:03.000Z"; // 3s later, within 5s window
  const r0 = screentimeStage0(buildIntent(handle, t0));
  const r1 = screentimeStage0(buildIntent(handle, t1));
  ok(
    "first row PASSes (no prior burst-collapse hit)",
    r0.decision === "PASS",
    `got decision=${r0.decision} reason=${r0.reason}`
  );
  ok(
    "second row within 5s DROPs with burst reason",
    r1.decision === "DROP" &&
      r1.reason === REASON_INSENDMESSAGE_BURST_DUP &&
      r1.reason === "screentime_insendmessage_burst_dup",
    `got decision=${r1.decision} reason=${r1.reason}`
  );
}

// ---------------------------------------------------------------------------
// Case 2: Same handle after 6s → both PASS.
// ---------------------------------------------------------------------------
console.log("\n--- Case 2: same handle after window elapses (6s) ---");
resetForTests();
{
  const handle = "+15555550002";
  const t0 = "2026-06-09T10:00:00.000Z";
  const t1 = "2026-06-09T10:00:06.000Z"; // 6s later, > 5s window
  const r0 = screentimeStage0(buildIntent(handle, t0));
  const r1 = screentimeStage0(buildIntent(handle, t1));
  ok(
    "first row PASSes",
    r0.decision === "PASS",
    `got decision=${r0.decision}`
  );
  ok(
    "second row 6s later PASSes (window elapsed)",
    r1.decision === "PASS",
    `got decision=${r1.decision} reason=${r1.reason}`
  );
}

// ---------------------------------------------------------------------------
// Case 3: Different handles within 5s → both PASS.
// ---------------------------------------------------------------------------
console.log("\n--- Case 3: distinct handles within 5s ---");
resetForTests();
{
  const t0 = "2026-06-09T10:00:00.000Z";
  const t1 = "2026-06-09T10:00:02.000Z";
  const r0 = screentimeStage0(buildIntent("+15555550003", t0));
  const r1 = screentimeStage0(buildIntent("+15555550004", t1));
  ok(
    "first handle PASSes",
    r0.decision === "PASS",
    `got decision=${r0.decision}`
  );
  ok(
    "second distinct handle PASSes (no LRU collision)",
    r1.decision === "PASS",
    `got decision=${r1.decision} reason=${r1.reason}`
  );
}

// ---------------------------------------------------------------------------
// Case 4: LRU cap eviction (1000 entries; first should be evicted).
// ---------------------------------------------------------------------------
console.log("\n--- Case 4: LRU cap eviction ---");
resetForTests();
{
  ok(
    "INSENDMESSAGE_LRU_CAP is 1000",
    INSENDMESSAGE_LRU_CAP === 1000,
    `got cap=${INSENDMESSAGE_LRU_CAP}`
  );
  // Insert 1001 distinct handles, each canonicalized to a unique key.
  // Use timestamps spaced ~10s apart so no two adjacent inserts collide
  // on the burst window (irrelevant for capacity, but keeps the loop's
  // semantics clean).
  const baseMs = Date.parse("2026-06-09T10:00:00.000Z");
  const firstHandle = "+15550000000";
  const firstCanonical = canonicalizeHandle(firstHandle, "screentime");
  screentimeStage0(buildIntent(firstHandle, new Date(baseMs).toISOString()));
  ok(
    "first handle present in LRU after first insert",
    INSENDMESSAGE_LRU.has(firstCanonical),
    `firstCanonical=${firstCanonical} mapSize=${INSENDMESSAGE_LRU.size}`
  );
  for (let i = 1; i <= 1000; i += 1) {
    // Generate distinct E.164-style handles. 10-digit suffix keeps them
    // canonicalized as bare-digit phone numbers (different keys).
    const handle = `+1555${String(i).padStart(7, "0")}`;
    const isoTs = new Date(baseMs + i * 10_000).toISOString();
    screentimeStage0(buildIntent(handle, isoTs));
  }
  ok(
    "LRU size is bounded at the cap (1000) after 1001 inserts",
    INSENDMESSAGE_LRU.size === INSENDMESSAGE_LRU_CAP,
    `got size=${INSENDMESSAGE_LRU.size}`
  );
  ok(
    "first inserted key was evicted (oldest-out FIFO)",
    !INSENDMESSAGE_LRU.has(firstCanonical),
    `firstCanonical=${firstCanonical} still present`
  );
}

// ---------------------------------------------------------------------------
// Case 5: resetForTests() clears the LRU state.
// ---------------------------------------------------------------------------
console.log("\n--- Case 5: resetForTests() clears LRU ---");
{
  const handle = "+15555559999";
  screentimeStage0(
    buildIntent(handle, "2026-06-09T10:00:00.000Z")
  );
  ok(
    "LRU is non-empty after stage0 call",
    INSENDMESSAGE_LRU.size > 0,
    `got size=${INSENDMESSAGE_LRU.size}`
  );
  resetForTests();
  ok(
    "resetForTests() empties the LRU map",
    INSENDMESSAGE_LRU.size === 0,
    `got size=${INSENDMESSAGE_LRU.size}`
  );
}

// ---------------------------------------------------------------------------
// Case 6: F-NEW-W7-SCREENTIME-HANDLE-NORMALIZE-ALIGN — burst-collapse
// handle derivation matches cross-source-dedup canonical key.
// ---------------------------------------------------------------------------
console.log(
  "\n--- Case 6: burst-collapse handle aligns with cross-source-dedup canonical key ---"
);
{
  const phone = "+15555558888";
  const rc = {
    stream: "/app/intents",
    intent_class: "INSendMessageIntent",
    related_contact_ids: phone,
  };
  const burstHandle = _deriveHandle(rc);
  const xsrcHandle = canonicalizeHandle(phone, "screentime");
  ok(
    "burst-collapse handle equals cross-source canonical key",
    burstHandle === xsrcHandle && burstHandle.length > 0,
    `burst=${burstHandle} xsrc=${xsrcHandle}`
  );
  // Percent-encoded variant should canonicalize identically (and so the
  // burst-collapse key matches a substrate lookup keyed on the E.164 form).
  const pctHandle = _deriveHandle({
    stream: "/app/intents",
    intent_class: "INSendMessageIntent",
    related_contact_ids: "%2B15555558888",
  });
  ok(
    "percent-encoded handle canonicalizes to same key (substrate parity)",
    pctHandle === xsrcHandle,
    `pct=${pctHandle} xsrc=${xsrcHandle}`
  );
  // Window-ms constant sanity check.
  ok(
    "INSENDMESSAGE_BURST_WINDOW_MS is 5000",
    INSENDMESSAGE_BURST_WINDOW_MS === 5_000,
    `got window=${INSENDMESSAGE_BURST_WINDOW_MS}`
  );
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} ${pass} assertions, ${fail} failures`);
if (fail > 0) process.exit(1);
