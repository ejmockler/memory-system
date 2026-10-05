// gemini-client.test.mjs — Phase 3 v0 foundations.
//
// Hermetic discipline (C-NEW-2 pattern, standing): set MEMORY_ROOT and the
// POLICY/STORAGE/LEDGERS dirs to mkdtempSync paths BEFORE any dynamic import
// of memory-system modules. The production tree (the live install) must
// not be touched.
//
// The gemini-client module does not actually touch the ledger/policy trees,
// but we set MEMORY_ROOT anyway: (a) future-proofing in case the module later
// integrates with config.js, (b) ensuring lint/conformance consistency with
// the rest of the test suite.
//
// Tests 5/6/7 call the real Gemini API. This is intentional — the architecture
// report explicitly mandates a CI integration test for the asymmetric task-type
// margin (risk #2 in the risks table). Skips gracefully if GEMINI_API_KEY is
// absent so dev-machine `npm test` works without the key.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hermeticity: stake out tmp dirs and overwrite env BEFORE dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-gemini-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");

// Dynamic import AFTER env override.
const gemini = await import("../lib/gemini-client.js");
const {
  embedSingle,
  embedBatch,
  embedSegments,
  GEMINI_TASK_TYPES,
  GEMINI_CLIENT_CONSTANTS,
  KeyPoolExhaustedError,
  _resetKeyPoolForTests,
} = gemini;

// The L2 / MRL primitives moved to lib/vector-math.js. T2/T3/T4 below still
// live in THIS suite — it is registered in scripts/run-all-tests.mjs, and
// relocating them into the (unregistered) vector-math suite would open a
// coverage hole in the gate. They exercise the same functions via their new
// home.
const { l2Renormalize, l2NormAssert, mrlSlice } = await import(
  "../lib/vector-math.js"
);

// ---------------------------------------------------------------------------
// Test framework: ad-hoc assert-with-label, matches other test/*.test.mjs style.
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

function cosine(a, b) {
  if (a.length !== b.length) {
    throw new Error(`cosine: length mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const d = Math.sqrt(normA) * Math.sqrt(normB);
  if (d === 0) throw new Error("cosine: zero vector");
  return dot / d;
}

// Snapshot + restore process.env.GEMINI_API_KEY / GEMINI_API_KEYS for the
// missing-key test. R29: the pool reads BOTH env vars, so we must clear and
// restore BOTH or T1's "no key" assertion races against the multi-key var.
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
// Test 1: GEMINI_API_KEY missing -> embedSingle throws with actionable message.
// ---------------------------------------------------------------------------
await test("T1: missing GEMINI_API_KEY -> actionable error", async () => {
  clearKey();
  try {
    await embedSingle({ text: "hi", taskType: GEMINI_TASK_TYPES.RETRIEVAL_DOCUMENT });
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
// Test 2: l2Renormalize: known input renormalized to unit norm.
// ---------------------------------------------------------------------------
await test("T2: l2Renormalize produces unit-norm vector", async () => {
  const input = [3, 4, 0, 0]; // L2 norm = 5
  const out = l2Renormalize(input);
  let sumSq = 0;
  for (const v of out) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (Math.abs(norm - 1.0) > 1e-6) {
    fail(`T2: renormalized norm = ${norm}, expected 1.0`);
    return;
  }
  // And input must be untouched (new array semantics).
  if (input[0] !== 3 || input[1] !== 4) {
    fail("T2: input mutated; renormalize must return a NEW array");
    return;
  }
  pass(`T2: renormalized ||v||=${norm}`);
});

// ---------------------------------------------------------------------------
// Test 3: l2NormAssert: throws on non-unit; passes on unit.
// ---------------------------------------------------------------------------
await test("T3: l2NormAssert enforces unit-norm invariant", async () => {
  const unit = l2Renormalize([1, 2, 3, 4, 5]);
  try {
    l2NormAssert(unit, "T3-unit");
    pass("T3: passes on unit-norm input");
  } catch (err) {
    fail("T3: unexpectedly threw on unit input", err);
    return;
  }
  try {
    l2NormAssert([1, 0, 0, 0, 0.5], "T3-nonunit");
    fail("T3: failed to throw on non-unit input");
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (!msg.includes("invariant violated")) {
      fail("T3: threw but message missing 'invariant violated'", err);
      return;
    }
    pass("T3: throws on non-unit");
  }
});

// ---------------------------------------------------------------------------
// Test 4: mrlSlice -> 768 dims AND norm = 1.0 +/- 1e-6.
// ---------------------------------------------------------------------------
await test("T4: mrlSlice(v3072, 768) -> 768 dims, unit norm", async () => {
  // Construct a deterministic 3072d vector with nontrivial values.
  const v3072 = new Array(3072);
  for (let i = 0; i < 3072; i++) {
    // Mix of magnitudes so the truncated head is not pathologically aligned.
    v3072[i] = Math.sin(i * 0.13) + 0.01 * i + 0.5;
  }
  // First, renormalize the full 3072 so we are simulating Gemini's actual
  // unit-norm output.
  const v3072_unit = l2Renormalize(v3072);

  const sliced = mrlSlice(v3072_unit, 768);
  if (sliced.length !== 768) {
    fail(`T4: sliced length = ${sliced.length}, expected 768`);
    return;
  }
  let sumSq = 0;
  for (const v of sliced) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (Math.abs(norm - 1.0) > 1e-6) {
    fail(`T4: sliced norm = ${norm}, expected 1.0`);
    return;
  }

  // Also sanity-check: BEFORE the renorm step inside mrlSlice, a bare slice
  // would NOT be unit-norm. Demonstrate by truncating + computing raw norm.
  let rawSumSq = 0;
  for (let i = 0; i < 768; i++) rawSumSq += v3072_unit[i] * v3072_unit[i];
  const rawNorm = Math.sqrt(rawSumSq);
  if (Math.abs(rawNorm - 1.0) <= 1e-6) {
    fail(
      `T4: raw (un-renormalized) 768d slice happens to have unit norm = ${rawNorm}; ` +
        "this means the test vector was pathologically constructed and the test does not " +
        "actually verify the renorm-required property. Choose a different input."
    );
    return;
  }
  pass(
    `T4: 768d slice unit-norm = ${norm}, raw (pre-renorm) = ${rawNorm} ` +
      "(demonstrates renorm is required)"
  );
});

// ---------------------------------------------------------------------------
// Tests 5/6/7: real-API tests. Skip with a banner if GEMINI_API_KEY absent.
// ---------------------------------------------------------------------------
const REAL_API_AVAILABLE = typeof process.env.GEMINI_API_KEY === "string" && process.env.GEMINI_API_KEY.length > 0;
if (!REAL_API_AVAILABLE) {
  console.log("");
  console.log("==============================================================");
  console.log("SKIPPING tests T5/T6/T7: GEMINI_API_KEY not set in env.");
  console.log("Set it (export GEMINI_API_KEY=...) to exercise the real API.");
  console.log("==============================================================");
  console.log("");
}

// Test 5: ASYMMETRIC MARGIN CI TEST.
//
// The architecture report (kb/research-retrieval-frontiers.md § Gemini
// integration specifics) frames the asymmetric advantage as a *separation*
// between matched and distractor pairs ("Phase A measured the asymmetric
// margin at +0.1119 vs +0.0826 symmetric (~35% larger separation) — flag for
// re-verification before locking, see critic §2").
//
// On a SINGLE matched pair, absolute cosine under (DOC + QUERY) is often
// LOWER than under (SIM + SIM) — the query and document encoders pull the
// two strings toward different sub-spaces and dot product drops in absolute
// terms. What matters operationally is that the GAP between (matched) and
// (distractor) cosines is WIDER under asymmetric encoding, so a ranker built
// on cosine ordering separates true memories from distractors more cleanly.
//
// This test therefore measures both:
//   (a) Single-pair cosines under each scheme (the literal numbers the task
//       spec asks us to print), AND
//   (b) The separation margin (matched cosine - distractor cosine) under
//       each scheme. ASSERTION: asymmetric separation > symmetric separation
//       by > 0.02 (architecture-report lower bound, lifted from Phase A).
await test("T5: asymmetric task-type margin > symmetric (CI gate)", async () => {
  if (!REAL_API_AVAILABLE) {
    console.log("  skip (no GEMINI_API_KEY)");
    return;
  }
  const docText = "the user's partner is Robin";
  const queryText = "who is the user married to?";
  // Distractor: same domain, plausibly retrievable, but the wrong answer.
  const distractorText = "the user's favorite programming language is Rust";

  // Asymmetric pair: doc encoded as RETRIEVAL_DOCUMENT, query as RETRIEVAL_QUERY.
  const asymDoc = await embedSingle({
    text: docText,
    taskType: GEMINI_TASK_TYPES.RETRIEVAL_DOCUMENT,
  });
  const asymDistractor = await embedSingle({
    text: distractorText,
    taskType: GEMINI_TASK_TYPES.RETRIEVAL_DOCUMENT,
  });
  const asymQuery = await embedSingle({
    text: queryText,
    taskType: GEMINI_TASK_TYPES.RETRIEVAL_QUERY,
  });
  const cosAsymMatched = cosine(asymDoc.vector_3072, asymQuery.vector_3072);
  const cosAsymDistractor = cosine(asymDistractor.vector_3072, asymQuery.vector_3072);
  const asymSeparation = cosAsymMatched - cosAsymDistractor;

  // Symmetric pair: all three as SEMANTIC_SIMILARITY.
  const symDoc = await embedSingle({
    text: docText,
    taskType: GEMINI_TASK_TYPES.SEMANTIC_SIMILARITY,
  });
  const symDistractor = await embedSingle({
    text: distractorText,
    taskType: GEMINI_TASK_TYPES.SEMANTIC_SIMILARITY,
  });
  const symQuery = await embedSingle({
    text: queryText,
    taskType: GEMINI_TASK_TYPES.SEMANTIC_SIMILARITY,
  });
  const cosSymMatched = cosine(symDoc.vector_3072, symQuery.vector_3072);
  const cosSymDistractor = cosine(symDistractor.vector_3072, symQuery.vector_3072);
  const symSeparation = cosSymMatched - cosSymDistractor;

  // Single-pair absolute cosines (literal print per task spec).
  console.log(`  cosine_asymmetric  (DOC + QUERY, matched)     = ${cosAsymMatched.toFixed(6)}`);
  console.log(`  cosine_symmetric   (SIM + SIM,   matched)     = ${cosSymMatched.toFixed(6)}`);
  console.log(`  cosine_asymmetric  (DOC + QUERY, distractor)  = ${cosAsymDistractor.toFixed(6)}`);
  console.log(`  cosine_symmetric   (SIM + SIM,   distractor)  = ${cosSymDistractor.toFixed(6)}`);

  // Separation under each scheme.
  console.log(`  separation_asymmetric (matched - distractor)  = ${asymSeparation.toFixed(6)}`);
  console.log(`  separation_symmetric  (matched - distractor)  = ${symSeparation.toFixed(6)}`);
  const separationMargin = asymSeparation - symSeparation;
  console.log(`  separation_margin (asym_sep - sym_sep)        = ${separationMargin.toFixed(6)}`);

  // The architecture-report claim: asymmetric encoding produces a WIDER
  // matched-vs-distractor gap than symmetric, by > 0.02.
  if (!(asymSeparation > symSeparation)) {
    fail(
      `T5: asymmetric separation (${asymSeparation}) not > symmetric separation (${symSeparation})`
    );
    return;
  }
  if (!(separationMargin > 0.02)) {
    fail(
      `T5: separation margin ${separationMargin} <= 0.02 lower bound (Phase A claim)`
    );
    return;
  }
  pass(
    `T5: asymmetric separation = ${asymSeparation.toFixed(6)}, symmetric separation = ${symSeparation.toFixed(6)}, margin = ${separationMargin.toFixed(6)} > 0.02`
  );
});

// Test 6: embedBatch round-trip: 5 strings, batched, each 3072d + nontrivial.
await test("T6: embedBatch round-trip (5 strings)", async () => {
  if (!REAL_API_AVAILABLE) {
    console.log("  skip (no GEMINI_API_KEY)");
    return;
  }
  const items = [
    "the user lives in Larkhaven",
    "the user works on memory systems",
    "Python is a programming language",
    "blue is a color",
    "espresso requires high pressure",
  ];
  const results = await embedBatch({
    items,
    taskType: GEMINI_TASK_TYPES.RETRIEVAL_DOCUMENT,
  });
  if (results.length !== 5) {
    fail(`T6: expected 5 results, got ${results.length}`);
    return;
  }
  for (let i = 0; i < 5; i++) {
    const r = results[i];
    if (r.index !== i) {
      fail(`T6: result ${i} index = ${r.index}, expected ${i}`);
      return;
    }
    if (!Array.isArray(r.vector_3072) || r.vector_3072.length !== 3072) {
      fail(`T6: result ${i} vector_3072 has length ${r.vector_3072 && r.vector_3072.length}`);
      return;
    }
    // Nontrivial: at least one nonzero and not all-the-same.
    const first = r.vector_3072[0];
    let allSame = true;
    let allZero = true;
    for (let j = 0; j < r.vector_3072.length; j++) {
      if (r.vector_3072[j] !== first) allSame = false;
      if (r.vector_3072[j] !== 0) allZero = false;
      if (!allSame && !allZero) break;
    }
    if (allSame || allZero) {
      fail(`T6: result ${i} vector is degenerate (allSame=${allSame}, allZero=${allZero})`);
      return;
    }
    if (r.embedding_model_version !== GEMINI_CLIENT_CONSTANTS.GEMINI_EMBEDDING_MODEL_VERSION) {
      fail(`T6: result ${i} embedding_model_version mismatch: ${r.embedding_model_version}`);
      return;
    }
  }
  pass("T6: 5 round-trip vectors, each 3072d, nontrivial, unit-norm asserted internally");
});

// Test 7: embedSegments: 3 segments with different roles; role preserved.
await test("T7: embedSegments preserves segment_role", async () => {
  if (!REAL_API_AVAILABLE) {
    console.log("  skip (no GEMINI_API_KEY)");
    return;
  }
  const segments = [
    { segment_role: "current_query", text: "where did the user go last night?" },
    { segment_role: "recent_turn", text: "I had dinner at the Example Bistro" },
    { segment_role: "agent_role", text: "personal-memory-assistant" },
  ];
  const results = await embedSegments({
    segments,
    taskType: GEMINI_TASK_TYPES.RETRIEVAL_QUERY,
  });
  if (results.length !== 3) {
    fail(`T7: expected 3 results, got ${results.length}`);
    return;
  }
  for (let i = 0; i < 3; i++) {
    const r = results[i];
    if (r.segment_role !== segments[i].segment_role) {
      fail(`T7: result ${i} role = ${r.segment_role}, expected ${segments[i].segment_role}`);
      return;
    }
    if (!Array.isArray(r.vector_3072) || r.vector_3072.length !== 3072) {
      fail(`T7: result ${i} vector_3072 wrong shape`);
      return;
    }
  }
  pass("T7: 3 segments embedded, segment_role preserved on each output");
});

// ---------------------------------------------------------------------------
// R29 key-pool tests (hermetic; no real-API calls). These exercise the parse,
// rotation, cooldown, and exhausted-pool paths against a stubbed global.fetch.
// All synthetic key values are obvious placeholders ("FAKE_KEY_*") and never
// resemble real Gemini key bytes; do NOT use real key bytes in tests.
// ---------------------------------------------------------------------------

const ORIG_FETCH = globalThis.fetch;
function restoreFetch() {
  globalThis.fetch = ORIG_FETCH;
}

// Build a synthetic unit-norm 3072d vector for the stubbed Gemini response.
function _fakeUnitVec3072() {
  const v = new Array(3072);
  // 1/sqrt(3072) per component so the L2 norm equals 1.0 exactly.
  const c = 1 / Math.sqrt(3072);
  for (let i = 0; i < 3072; i++) v[i] = c;
  return v;
}

// Test 8: pool parse — GEMINI_API_KEYS overrides GEMINI_API_KEY when both set;
// trims, skips empties, dedupes.
await test("T8: pool parse — multi overrides single; trim/skip/dedup", async () => {
  clearKey();
  // R29.1: fixtures use AIza-prefixed synthetic keys so the boot-time
  // shape validator accepts them; "FAKE" infix preserves the canary discipline.
  process.env.GEMINI_API_KEY = "AIzaFAKE_LEGACY_xxxxxxxxxxxxxxxxxxxxxxx";
  process.env.GEMINI_API_KEYS = "AIzaFAKE_A_xxxxxxxxxxxxxxxxxxxxxxxxxxxx , AIzaFAKE_B_xxxxxxxxxxxxxxxxxxxxxxxxxxxx,, AIzaFAKE_A_xxxxxxxxxxxxxxxxxxxxxxxxxxxx ,AIzaFAKE_C_xxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  _resetKeyPoolForTests();

  // Stub fetch to count which key reaches the URL; capture the key from
  // the URL's `?key=...` segment.
  const seenKeys = [];
  globalThis.fetch = async (url) => {
    const m = String(url).match(/[?&]key=([^&]+)/);
    if (m) seenKeys.push(decodeURIComponent(m[1]));
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ embedding: { values: _fakeUnitVec3072() } }),
    };
  };

  try {
    await embedSingle({
      text: "x",
      taskType: GEMINI_TASK_TYPES.RETRIEVAL_DOCUMENT,
    });
  } finally {
    restoreFetch();
    restoreKey();
  }

  if (seenKeys.length !== 1) {
    fail(`T8: expected 1 request, got ${seenKeys.length}`);
    return;
  }
  // First active key after parse should be FAKE_KEY_A (the legacy single key
  // must have been overridden; "FAKE_KEY_LEGACY" must not appear).
  if (seenKeys[0] !== "AIzaFAKE_A_xxxxxxxxxxxxxxxxxxxxxxxxxxxx") {
    fail(`T8: first key used = ${seenKeys[0]}, expected AIzaFAKE_A_...`);
    return;
  }
  pass("T8: multi overrides single; trim/skip/dedup OK");
});

// Test 9: 429 rotation — first key hits 429, second key succeeds, first key
// is cooled down.
await test("T9: 429 rotation — first key cooled, second key serves", async () => {
  clearKey();
  // R29.1: AIza-prefixed fixtures for boot-time shape validator.
  const FAKE_1 = "AIzaFAKE_1_xxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const FAKE_2 = "AIzaFAKE_2_xxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  process.env.GEMINI_API_KEYS = `${FAKE_1},${FAKE_2}`;
  _resetKeyPoolForTests();

  let calls = 0;
  const seenKeys = [];
  globalThis.fetch = async (url) => {
    calls++;
    const m = String(url).match(/[?&]key=([^&]+)/);
    const k = m ? decodeURIComponent(m[1]) : null;
    seenKeys.push(k);
    if (k === FAKE_1) {
      return {
        ok: false,
        status: 429,
        text: async () =>
          JSON.stringify({ error: { message: "quota exhausted" } }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ embedding: { values: _fakeUnitVec3072() } }),
    };
  };

  let result = null;
  try {
    result = await embedSingle({
      text: "x",
      taskType: GEMINI_TASK_TYPES.RETRIEVAL_DOCUMENT,
    });
  } finally {
    restoreFetch();
    restoreKey();
  }

  if (calls !== 2) {
    fail(`T9: expected 2 fetch calls (1 fail + 1 success), got ${calls}`);
    return;
  }
  if (seenKeys[0] !== FAKE_1 || seenKeys[1] !== FAKE_2) {
    fail(`T9: expected key sequence [FAKE_1, FAKE_2], got [${seenKeys.join(", ")}]`);
    return;
  }
  if (!result || !Array.isArray(result.vector_3072) || result.vector_3072.length !== 3072) {
    fail(`T9: expected a 3072d result vector after rotation`);
    return;
  }
  pass("T9: rotated to next key on 429, returned successful result");
});

// Test 10: all keys exhausted -> KeyPoolExhaustedError with next_retry_at_iso.
await test("T10: all-keys-exhausted -> KeyPoolExhaustedError", async () => {
  clearKey();
  // R29.1: AIza-prefixed fixtures for boot-time shape validator.
  process.env.GEMINI_API_KEYS = "AIzaFAKE_X_xxxxxxxxxxxxxxxxxxxxxxxxxxxx,AIzaFAKE_Y_xxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  _resetKeyPoolForTests();

  globalThis.fetch = async (_url) => ({
    ok: false,
    status: 429,
    text: async () =>
      JSON.stringify({ error: { message: "daily quota" } }),
  });

  let caught = null;
  try {
    await embedSingle({
      text: "x",
      taskType: GEMINI_TASK_TYPES.RETRIEVAL_DOCUMENT,
    });
  } catch (err) {
    caught = err;
  } finally {
    restoreFetch();
    restoreKey();
  }

  if (caught == null) {
    fail("T10: expected an error, got success");
    return;
  }
  if (caught.name !== "KeyPoolExhaustedError") {
    fail(`T10: expected KeyPoolExhaustedError, got ${caught && caught.name}: ${caught && caught.message}`);
    return;
  }
  if (!(caught instanceof KeyPoolExhaustedError)) {
    fail("T10: exported KeyPoolExhaustedError did not match thrown instance");
    return;
  }
  if (typeof caught.next_retry_at_iso !== "string") {
    fail(`T10: next_retry_at_iso missing (got ${typeof caught.next_retry_at_iso})`);
    return;
  }
  // Must be a valid ISO 8601 timestamp in the future.
  const t = Date.parse(caught.next_retry_at_iso);
  if (!Number.isFinite(t) || t <= Date.now()) {
    fail(`T10: next_retry_at_iso (${caught.next_retry_at_iso}) is not a future ISO timestamp`);
    return;
  }
  pass(`T10: KeyPoolExhaustedError thrown with next_retry_at_iso = ${caught.next_retry_at_iso}`);
});

// Test 11: secret hygiene — stderr never contains full key bytes; only the
// 6-char redacted prefix. Capture stderr writes around a forced rotation.
await test("T11: secret hygiene — full key never leaked to stderr", async () => {
  clearKey();
  // R29.1: AIza-prefixed fixtures for boot-time shape validator.
  const FULL_KEY = "AIzaFAKE_SECRET_DO_NOT_LEAK_1234567890ABCDEF";
  const SECOND_KEY = "AIzaFAKE_BACKUP_ALSO_SECRET_FEDCBA0987654321";
  process.env.GEMINI_API_KEYS = `${FULL_KEY},${SECOND_KEY}`;
  _resetKeyPoolForTests();

  // Capture stderr.
  const captured = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    captured.push(String(chunk));
    return true;
  };

  globalThis.fetch = async (url) => {
    const m = String(url).match(/[?&]key=([^&]+)/);
    const k = m ? decodeURIComponent(m[1]) : null;
    if (k === FULL_KEY) {
      return {
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: { message: "quota" } }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ embedding: { values: _fakeUnitVec3072() } }),
    };
  };

  try {
    await embedSingle({
      text: "x",
      taskType: GEMINI_TASK_TYPES.RETRIEVAL_DOCUMENT,
    });
  } finally {
    process.stderr.write = origWrite;
    restoreFetch();
    restoreKey();
  }

  const allOut = captured.join("");
  if (allOut.length === 0) {
    fail("T11: expected at least one stderr line (rotation diagnostic)");
    return;
  }
  if (allOut.includes(FULL_KEY)) {
    fail("T11: stderr LEAKED the full first key");
    return;
  }
  if (allOut.includes(SECOND_KEY)) {
    fail("T11: stderr LEAKED the full second key");
    return;
  }
  // Should contain the 6-char prefix form for at least one key.
  if (!allOut.includes(FULL_KEY.slice(0, 6) + "...")) {
    fail(`T11: stderr did not contain the redacted 6-char prefix; got ${JSON.stringify(allOut)}`);
    return;
  }
  pass("T11: rotation diagnostics emitted; full key bytes redacted to 6-char prefix");
});

// Test 12: missing-key error stays actionable when neither env var is set.
await test("T12: empty pool — actionable error mentions GEMINI_API_KEYS", async () => {
  clearKey();
  _resetKeyPoolForTests();
  let caught = null;
  try {
    await embedSingle({
      text: "x",
      taskType: GEMINI_TASK_TYPES.RETRIEVAL_DOCUMENT,
    });
  } catch (err) {
    caught = err;
  } finally {
    restoreKey();
  }
  if (caught == null) {
    fail("T12: expected an error");
    return;
  }
  const msg = caught.message || String(caught);
  if (!msg.includes("GEMINI_API_KEYS")) {
    fail(`T12: error did not mention GEMINI_API_KEYS; got: ${msg}`);
    return;
  }
  if (!msg.includes("LaunchAgents") && !msg.includes("EnvironmentVariables")) {
    fail(`T12: error not actionable (no plist guidance); got: ${msg}`);
    return;
  }
  pass("T12: empty pool yields actionable error referencing GEMINI_API_KEYS");
});

// ---------------------------------------------------------------------------
// Cleanup + summary.
// ---------------------------------------------------------------------------
try {
  rmSync(TMP_ROOT, { recursive: true, force: true });
} catch (_e) {
  // Non-fatal — tmp dir cleanup is best-effort.
}

console.log("");
console.log(`gemini-client.test.mjs: ${passes} passed, ${failures} failed`);
if (failures > 0) {
  process.exit(1);
}
process.exit(0);
