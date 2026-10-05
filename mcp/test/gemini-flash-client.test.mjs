// gemini-flash-client.test.mjs — Phase 3 v1 Layer-3 reranker smoke + CI canary.
//
// Hermetic discipline (C-NEW-2, standing): set MEMORY_ROOT and the
// POLICY/STORAGE/LEDGERS dirs to mkdtempSync paths BEFORE any dynamic import
// of memory-system modules. The production tree (the live install) must
// not be touched.
//
// Plays the same CI-canary role for the rerank surface that
// gemini-client.test.mjs T5 plays for the embedding surface. Asserts:
//   T1: GEMINI_API_KEY missing -> throws with actionable message.
//   T2: smoke generateRanking returns the contract shape (real API).
//   T3: configured model matches CAPS.GEMINI_FLASH_MODEL_DEFAULT.
//
// Tests 2 skips gracefully if GEMINI_API_KEY is absent so dev-machine
// `npm test` works without the key.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hermeticity: stake out tmp dirs and overwrite env BEFORE dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-gemini-flash-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");

// Dynamic import AFTER env override.
const flash = await import("../lib/gemini-flash-client.js");
const { generateRanking, GEMINI_FLASH_CLIENT_CONSTANTS } = flash;
const validation = await import("../lib/validation.js");
const { CAPS } = validation;
// F1 (memperf): key resolution goes through gemini-client.js's shared key
// pool, which lazily parses env ONCE per process — every env mutation below
// must be paired with _resetKeyPoolForTests().
const { _resetKeyPoolForTests } = await import("../lib/gemini-client.js");

// ---------------------------------------------------------------------------
// Test framework: ad-hoc assert-with-label, matches gemini-client.test.mjs.
// ---------------------------------------------------------------------------
let failures = 0;
let passes = 0;

function pass(label) {
  passes++;
  console.log(`  pass: ${label}`);
}
function fail(label, err) {
  failures++;
  console.log(`  FAIL: ${label}`);
  if (err) {
    console.log(`        ${err && err.stack ? err.stack : err}`);
  }
}
async function test(label, fn) {
  console.log(`test: ${label}`);
  try {
    await fn();
  } catch (err) {
    fail(label, err);
  }
}

// Snapshot + restore BOTH key env vars for the missing-key/abort tests.
// F1 (memperf): scrub GEMINI_API_KEYS too (the pool honors both forms) and
// reset the lazy pool on every mutation.
const ORIGINAL_GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ORIGINAL_GEMINI_API_KEYS = process.env.GEMINI_API_KEYS;
function clearKey() {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEYS;
  _resetKeyPoolForTests();
}
function restoreKey() {
  if (ORIGINAL_GEMINI_API_KEY != null) {
    process.env.GEMINI_API_KEY = ORIGINAL_GEMINI_API_KEY;
  } else {
    delete process.env.GEMINI_API_KEY;
  }
  if (ORIGINAL_GEMINI_API_KEYS != null) {
    process.env.GEMINI_API_KEYS = ORIGINAL_GEMINI_API_KEYS;
  } else {
    delete process.env.GEMINI_API_KEYS;
  }
  _resetKeyPoolForTests();
}

// ---------------------------------------------------------------------------
// Test 1: GEMINI_API_KEY missing -> throws with actionable message.
// ---------------------------------------------------------------------------
await test("T1: missing GEMINI_API_KEY -> actionable error", async () => {
  clearKey();
  try {
    await generateRanking({
      instruction: "rank by relevance to: the user's partner",
      candidates: [
        { id: "m1", content: "the user's partner is Robin" },
        { id: "m2", content: "the user lives in Larkhaven" },
        { id: "m3", content: "Python is a programming language" },
      ],
    });
    fail("T1: should have thrown");
    return;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (!msg.includes("GEMINI_API_KEY")) {
      fail("T1: error did not mention GEMINI_API_KEY", err);
      return;
    }
    if (!msg.includes("LaunchAgents") && !msg.includes("EnvironmentVariables")) {
      fail("T1: error not actionable (no plist guidance)", err);
      return;
    }
    pass("T1: actionable missing-key error");
  } finally {
    restoreKey();
  }
});

// ---------------------------------------------------------------------------
// Test T-A (F1 memperf): abort threading. The caller's AbortSignal must reach
// fetch, and an aborted request must reject with an UNWRAPPED AbortError —
// never re-wrapped as a retryable "network failure". Hermetic: fetch is
// monkeypatched; no network. FAILS pre-fix: fetch got no signal, and the
// abort-shaped rejection was wrapped + retried as "network failure".
// ---------------------------------------------------------------------------
await test("T-A: abort signal threads to fetch; AbortError rethrown unwrapped", async () => {
  const realFetch = globalThis.fetch;
  const SAVED_KEY = process.env.GEMINI_API_KEY;
  const SAVED_KEYS = process.env.GEMINI_API_KEYS;
  let seenSignal = null;
  try {
    // Synthetic pool-only key (contains FAKE; AIza shape passes validation).
    delete process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEYS = "AIzaFAKE_flash_abort_xxxxxxxxxxxxxxxxxxxxxx";
    _resetKeyPoolForTests();

    globalThis.fetch = (_url, opts) =>
      new Promise((_resolve, reject) => {
        seenSignal = opts.signal;
        opts.signal.addEventListener(
          "abort",
          () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          },
          { once: true }
        );
      });

    const controller = new AbortController();
    const pending = generateRanking({
      instruction: "rank by relevance to: the user's partner",
      candidates: [
        { id: "m1", content: "the user's partner is Robin" },
        { id: "m2", content: "the user lives in Larkhaven" },
      ],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);

    let rejected = null;
    try {
      await pending;
    } catch (err) {
      rejected = err;
    }
    if (rejected == null) {
      fail("T-A: generateRanking must reject when the signal aborts");
      return;
    }
    if (rejected.name !== "AbortError") {
      fail(
        `T-A: rejection name must be "AbortError", got "${rejected.name}": ${rejected.message}`
      );
      return;
    }
    if (String(rejected.message).includes("network failure")) {
      fail("T-A: AbortError must not be wrapped as a network failure", rejected);
      return;
    }
    if (seenSignal !== controller.signal) {
      fail("T-A: fetch must receive the caller's AbortSignal (opts.signal)");
      return;
    }
    pass("T-A: signal reached fetch; abort rejected unwrapped as AbortError");
  } finally {
    globalThis.fetch = realFetch;
    if (SAVED_KEY != null) process.env.GEMINI_API_KEY = SAVED_KEY;
    else delete process.env.GEMINI_API_KEY;
    if (SAVED_KEYS != null) process.env.GEMINI_API_KEYS = SAVED_KEYS;
    else delete process.env.GEMINI_API_KEYS;
    _resetKeyPoolForTests();
  }
});

// ---------------------------------------------------------------------------
// Test 2: smoke generateRanking call (real API).
// ---------------------------------------------------------------------------
const REAL_API_AVAILABLE =
  typeof process.env.GEMINI_API_KEY === "string" &&
  process.env.GEMINI_API_KEY.length > 0;
// REQUIRE_FLASH_SMOKE (round-18 hot-fix): when set to "1", a missing
// GEMINI_API_KEY is a HARD FAILURE rather than a silent skip. Operators
// running CI in environments where the key MUST be present (production
// gate verification) set this; dev machines without the key continue to
// skip gracefully. Closes the round-18 brutalist finding that T2 was
// silently green when the subagent env lacked the key.
const REQUIRE_FLASH_SMOKE = process.env.REQUIRE_FLASH_SMOKE === "1";
if (!REAL_API_AVAILABLE) {
  if (REQUIRE_FLASH_SMOKE) {
    console.error("");
    console.error("==============================================================");
    console.error("FAIL T2: GEMINI_API_KEY required (REQUIRE_FLASH_SMOKE=1)");
    console.error("This gate exists so CI fails LOUDLY when the key is missing");
    console.error("instead of silently skipping the real-API smoke test.");
    console.error("Unset REQUIRE_FLASH_SMOKE for dev-machine skips, or export");
    console.error("GEMINI_API_KEY=... (see ~/Library/LaunchAgents/com.user.");
    console.error("memory-system.*.plist EnvironmentVariables for production).");
    console.error("==============================================================");
    process.exit(1);
  }
  console.log("");
  console.log("==============================================================");
  console.log("SKIPPING test T2: GEMINI_API_KEY not set in env.");
  console.log("Set it (export GEMINI_API_KEY=...) to exercise the real API.");
  console.log("Set REQUIRE_FLASH_SMOKE=1 to make this skip a HARD failure.");
  console.log("==============================================================");
  console.log("");
}

await test("T2: generateRanking smoke (real API)", async () => {
  if (!REAL_API_AVAILABLE) {
    console.log("  skip (no GEMINI_API_KEY; set REQUIRE_FLASH_SMOKE=1 to fail-loud)");
    return;
  }
  const candidates = [
    { id: "m1", content: "the user's partner is Robin" },
    { id: "m2", content: "the user lives in Larkhaven" },
    { id: "m3", content: "Python is a programming language" },
  ];
  const inputIds = new Set(candidates.map((c) => c.id));

  const t0 = Date.now();
  const ranking = await generateRanking({
    instruction: "rank by relevance to: the user's partner",
    candidates,
  });
  const elapsedMs = Date.now() - t0;
  console.log(`  generateRanking latency = ${elapsedMs}ms`);

  if (!Array.isArray(ranking)) {
    fail(`T2: ranking not an array (got ${typeof ranking})`);
    return;
  }
  if (ranking.length !== candidates.length) {
    fail(
      `T2: ranking length ${ranking.length} != candidates length ${candidates.length}`
    );
    return;
  }
  const seen = new Set();
  for (let i = 0; i < ranking.length; i++) {
    const r = ranking[i];
    if (!r || typeof r !== "object") {
      fail(`T2: ranking[${i}] not an object`);
      return;
    }
    if (typeof r.id !== "string" || r.id.length === 0) {
      fail(`T2: ranking[${i}].id not a non-empty string`);
      return;
    }
    if (!inputIds.has(r.id)) {
      fail(`T2: ranking[${i}].id "${r.id}" not in input id set`);
      return;
    }
    if (seen.has(r.id)) {
      fail(`T2: ranking[${i}].id "${r.id}" appears more than once`);
      return;
    }
    seen.add(r.id);
    if (typeof r.rank_score !== "number" || !Number.isFinite(r.rank_score)) {
      fail(`T2: ranking[${i}].rank_score not a finite number`);
      return;
    }
  }
  // id-set preservation (the model returned exactly the input set).
  if (seen.size !== inputIds.size) {
    fail(
      `T2: ranking id-set size ${seen.size} != input id-set size ${inputIds.size}`
    );
    return;
  }
  for (const id of inputIds) {
    if (!seen.has(id)) {
      fail(`T2: input id "${id}" missing from ranking output`);
      return;
    }
  }
  // Log the ranking order for trend-watching (NOT asserted: the model's
  // ranking decision is downstream-business, not a client-library invariant).
  const order = ranking.map((r) => `${r.id}:${r.rank_score.toFixed(3)}`).join(" > ");
  console.log(`  ranking order = ${order}`);
  pass(
    `T2: ranking shape ok, ${ranking.length} entries, id-set preserved, rank_scores finite`
  );
});

// ---------------------------------------------------------------------------
// Test 3: model-tag stability — configured model matches CAPS.
// ---------------------------------------------------------------------------
await test("T3: configured model matches CAPS.GEMINI_FLASH_MODEL_DEFAULT", async () => {
  const actual = GEMINI_FLASH_CLIENT_CONSTANTS.GEMINI_FLASH_MODEL;
  const expected = CAPS.GEMINI_FLASH_MODEL_DEFAULT;
  if (actual !== expected) {
    fail(
      `T3: client's GEMINI_FLASH_MODEL = "${actual}", CAPS.GEMINI_FLASH_MODEL_DEFAULT = "${expected}"`
    );
    return;
  }
  // Also cross-check the snapshot field is present + a non-empty string.
  // Per Phase A, today it mirrors the alias; tomorrow it carries a dated tag.
  const snap = GEMINI_FLASH_CLIENT_CONSTANTS.GEMINI_FLASH_PINNED_SNAPSHOT;
  if (typeof snap !== "string" || snap.length === 0) {
    fail(`T3: GEMINI_FLASH_PINNED_SNAPSHOT must be a non-empty string, got "${snap}"`);
    return;
  }
  if (snap !== CAPS.GEMINI_FLASH_PINNED_SNAPSHOT) {
    fail(
      `T3: client's PINNED_SNAPSHOT "${snap}" != CAPS.GEMINI_FLASH_PINNED_SNAPSHOT "${CAPS.GEMINI_FLASH_PINNED_SNAPSHOT}"`
    );
    return;
  }
  // Sanity: thinkingBudget must be 0 per the spec's load-bearing knob list.
  if (GEMINI_FLASH_CLIENT_CONSTANTS.THINKING_BUDGET !== 0) {
    fail(
      `T3: THINKING_BUDGET must be 0 per kb/phase3-v1-reranker-model.md, got ${GEMINI_FLASH_CLIENT_CONSTANTS.THINKING_BUDGET}`
    );
    return;
  }
  if (GEMINI_FLASH_CLIENT_CONSTANTS.TEMPERATURE !== 0.0) {
    fail(
      `T3: TEMPERATURE must be 0.0 per spec, got ${GEMINI_FLASH_CLIENT_CONSTANTS.TEMPERATURE}`
    );
    return;
  }
  pass(`T3: model "${actual}", snapshot "${snap}", thinkingBudget 0, temperature 0.0`);
});

// ---------------------------------------------------------------------------
// Summary + exit
// ---------------------------------------------------------------------------
console.log("");
console.log(`gemini-flash-client tests: ${passes} passed, ${failures} failed`);
if (failures > 0) {
  process.exit(1);
}
process.exit(0);
