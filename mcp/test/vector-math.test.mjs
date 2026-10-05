// vector-math.test.mjs — l12-vector-math-extract.
//
// Guards the extraction of the L2/MRL primitives out of gemini-client.js into
// mcp/lib/vector-math.js. Node l9-suite-gate registered this suite in
// scripts/run-all-tests.mjs on 2026-08-15, so it now runs under the gate; it
// was shipped UNREGISTERED only so concurrent nodes would not collide on that
// one file. It still runs standalone:
//
//   node mcp/test/vector-math.test.mjs
//
// WHAT THIS PROVES, and why each group exists:
//
//   R1  The new module owns the three functions and the dims constant.
//
//   R2  gemini-client.js no longer OWNS those names. Checked with `in` /
//       Object.keys against the module namespace, NOT `typeof x === "undefined"`.
//       Those are different facts: a re-export would still be `typeof
//       "function"`, and only "the name is absent from the namespace" is the
//       claim being made. If a later change re-exports them from gemini-client
//       for convenience, this group SHOULD go red and be consciously updated.
//
//   R3  Bit-exact behavior parity against goldens captured by running the
//       PRE-EXTRACTION gemini-client.js. The literals below were printed by
//       that build, not re-derived from the post-move code — re-deriving them
//       afterwards would make this group tautological. The non-unit
//       l2NormAssert message is asserted verbatim including its interpolated
//       `0.000001`: that substring is L2_NORM_INVARIANT_EPSILON stringified,
//       so matching it proves the constant MOVED rather than being silently
//       re-declared at a different magnitude.
//
//   R4  Anti-vacuity. mrlSlice's default-dims path is resolved THROUGH the new
//       module's own exported constant before the slice is asserted. The
//       BEHAVIORAL assertions in this group (R4b/R4c/R4d) cannot by themselves
//       distinguish `dims = DEFAULT_MRL_DIMS` from a hardcoded `dims = 768` —
//       see the derivation at R4-src below for why no runtime input can. The
//       SOURCE-TEXT assertion R4-src is what rules out the hardcoded literal,
//       and it is the only claim in this group that does so.
//
// Hermeticity: tmp dirs staked out and env overridden BEFORE any dynamic
// import, per the standing C-NEW-2 pattern. gemini-client.js is imported here
// (R2 needs its namespace), so the production tree must stay untouched.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-vector-math-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");

// Dynamic imports AFTER env override.
const vectorMath = await import("../lib/vector-math.js");
const geminiClient = await import("../lib/gemini-client.js");

const {
  l2Renormalize,
  l2NormAssert,
  mrlSlice,
  DEFAULT_MRL_DIMS,
  L2_NORM_INVARIANT_EPSILON,
} = vectorMath;

// ---------------------------------------------------------------------------
// Ad-hoc harness (matches sibling test/*.test.mjs style).
// ---------------------------------------------------------------------------
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
async function test(label, fn) {
  console.log(`test: ${label}`);
  try {
    await fn();
  } catch (err) {
    fail(label, err && err.stack ? err.stack : String(err));
  }
}
function assert(cond, label, detail) {
  if (cond) pass(label);
  else fail(label, detail);
}

// Capture the message of whatever `fn` throws. Returns a sentinel if it does
// not throw, so "no throw" fails loudly instead of comparing undefined.
function throwMessage(fn) {
  try {
    fn();
    return "<<<NO THROW>>>";
  } catch (err) {
    return err && err.message !== undefined ? err.message : String(err);
  }
}

const j = (x) => JSON.stringify(x);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// GOLDENS — printed by mcp/lib/gemini-client.js BEFORE the extraction.
// Do not regenerate these from the current tree; that would defeat R3.
// ---------------------------------------------------------------------------
const GOLDEN_A = [0.6, 0.8, 0, 0];
const GOLDEN_B = [
  0.13483997249264842, 0.26967994498529685, 0.40451991747794525,
  0.5393598899705937, 0.674199862463242,
];
const GOLDEN_C_SHA256 =
  "d7ed12a35bad8331da07785186263ffc5cba9f10f828c0844fcdaea78a3d9109";
const GOLDEN_C_FIRST4 = [
  0.003675252134115094, 0.004701633495431823, 0.0057119339134419555,
  0.006690343830256468,
];
const GOLDEN_C_LAST4 = [
  0.05295335470325645, 0.05342043523195313, 0.05399697782119405,
  0.05467449310241267,
];
const GOLDEN_THROW_ZERO_VECTOR =
  "l2Renormalize: cannot renormalize a zero vector (norm=0); input may be uninitialized";
const GOLDEN_THROW_ASSERT_NONARRAY =
  "l2NormAssert(golden): vector must be a non-empty array";
const GOLDEN_THROW_ASSERT_NONUNIT =
  "l2NormAssert(golden): unit-norm invariant violated; ||v||=5 (expected 1.0 +/- 0.000001)";
const GOLDEN_THROW_MRL_DIMS_EXCEEDS =
  "mrlSlice: dims (4) exceeds input length (3)";

// The 3072d probe input the C goldens were taken over.
function buildProbe3072() {
  const v = new Array(3072);
  for (let i = 0; i < 3072; i++) v[i] = Math.sin(i * 0.13) + 0.01 * i + 0.5;
  return v;
}

// ---------------------------------------------------------------------------
// R1 — import site: the new module owns the symbols.
// ---------------------------------------------------------------------------
await test("R1: vector-math.js exports the three functions + both constants", async () => {
  assert(
    typeof l2Renormalize === "function",
    "R1a: l2Renormalize is a function"
  );
  assert(typeof l2NormAssert === "function", "R1b: l2NormAssert is a function");
  assert(typeof mrlSlice === "function", "R1c: mrlSlice is a function");
  assert(
    DEFAULT_MRL_DIMS === 768,
    "R1d: DEFAULT_MRL_DIMS === 768",
    `got ${DEFAULT_MRL_DIMS}`
  );
  assert(
    L2_NORM_INVARIANT_EPSILON === 1e-6,
    "R1e: L2_NORM_INVARIANT_EPSILON === 1e-6",
    `got ${L2_NORM_INVARIANT_EPSILON}`
  );
});

// ---------------------------------------------------------------------------
// R2 — negative import site: gemini-client.js no longer OWNS these names.
// `in` / Object.keys, not typeof: a re-export and a removed export differ, and
// only removal is the claim.
// ---------------------------------------------------------------------------
await test("R2: gemini-client.js namespace no longer owns the moved names", async () => {
  const moved = [
    "l2Renormalize",
    "l2NormAssert",
    "mrlSlice",
    "DEFAULT_MRL_DIMS",
    "L2_NORM_INVARIANT_EPSILON",
  ];
  const geminiKeys = Object.keys(geminiClient);
  for (const name of moved) {
    assert(
      !(name in geminiClient),
      `R2a: "${name}" absent from gemini-client namespace ('in' check)`,
      `"${name}" is still reachable via gemini-client.js`
    );
    assert(
      !geminiKeys.includes(name),
      `R2b: "${name}" absent from Object.keys(gemini-client)`,
      `Object.keys still lists "${name}"`
    );
  }
  // Positive control: the namespace is non-empty and still owns a symbol that
  // was NOT part of this move. Without this, R2 would also pass against a
  // module that failed to load anything at all.
  assert(
    geminiKeys.length > 0 && "GEMINI_CLIENT_CONSTANTS" in geminiClient,
    "R2c: positive control — gemini-client still owns GEMINI_CLIENT_CONSTANTS",
    `keys=${geminiKeys.length}`
  );
});

// ---------------------------------------------------------------------------
// R2.5 — the frozen constants object keeps its exact observable shape.
// Names AND order, because Object.keys order is part of what callers see.
// ---------------------------------------------------------------------------
await test("R2.5: GEMINI_CLIENT_CONSTANTS shape is unchanged by the move", async () => {
  const GOLDEN_KEYS = [
    "GEMINI_MODEL",
    "GEMINI_EMBEDDING_MODEL_VERSION",
    "GEMINI_BATCH_SIZE_MAX",
    "DEFAULT_OUTPUT_DIMENSIONALITY",
    "DEFAULT_MRL_DIMS",
    "L2_NORM_INVARIANT_EPSILON",
  ];
  const GOLDEN_VALUES = {
    GEMINI_MODEL: "gemini-embedding-001",
    GEMINI_EMBEDDING_MODEL_VERSION: "gemini-embedding-001",
    GEMINI_BATCH_SIZE_MAX: 100,
    DEFAULT_OUTPUT_DIMENSIONALITY: 3072,
    DEFAULT_MRL_DIMS: 768,
    L2_NORM_INVARIANT_EPSILON: 1e-6,
  };
  const actual = geminiClient.GEMINI_CLIENT_CONSTANTS;
  assert(
    j(Object.keys(actual)) === j(GOLDEN_KEYS),
    "R2.5a: same six keys in the same order",
    `got ${j(Object.keys(actual))}`
  );
  for (const k of GOLDEN_KEYS) {
    assert(
      actual[k] === GOLDEN_VALUES[k],
      `R2.5b: ${k} === golden value`,
      `got ${j(actual[k])}, want ${j(GOLDEN_VALUES[k])}`
    );
  }
  assert(Object.isFrozen(actual), "R2.5c: still frozen");
  // The two moved constants must be the SAME bindings the new module exports —
  // this is what makes gemini-client a re-exporter rather than a second source
  // of truth for 768 / 1e-6.
  assert(
    actual.DEFAULT_MRL_DIMS === DEFAULT_MRL_DIMS,
    "R2.5d: DEFAULT_MRL_DIMS member === vector-math's export"
  );
  assert(
    actual.L2_NORM_INVARIANT_EPSILON === L2_NORM_INVARIANT_EPSILON,
    "R2.5e: L2_NORM_INVARIANT_EPSILON member === vector-math's export"
  );
});

// ---------------------------------------------------------------------------
// R3 — behavior parity, bit-exact, against pre-move goldens.
// ---------------------------------------------------------------------------
await test("R3a: l2Renormalize([3,4,0,0]) matches golden per-component", async () => {
  const out = l2Renormalize([3, 4, 0, 0]);
  assert(
    out.length === GOLDEN_A.length,
    "R3a-len: length 4",
    `got ${out.length}`
  );
  for (let i = 0; i < GOLDEN_A.length; i++) {
    assert(
      Object.is(out[i], GOLDEN_A[i]),
      `R3a-[${i}]: bit-exact ${GOLDEN_A[i]}`,
      `got ${out[i]}`
    );
  }
  assert(Array.isArray(out), "R3a-type: returns a plain Array");
});

await test("R3b: l2Renormalize([1,2,3,4,5]) matches golden per-component (irrational norm)", async () => {
  const out = l2Renormalize([1, 2, 3, 4, 5]);
  assert(
    out.length === GOLDEN_B.length,
    "R3b-len: length 5",
    `got ${out.length}`
  );
  for (let i = 0; i < GOLDEN_B.length; i++) {
    assert(
      out[i] === GOLDEN_B[i],
      `R3b-[${i}]: bit-exact ${GOLDEN_B[i]}`,
      `got ${out[i]} (accumulation-order drift in _l2Norm would land here)`
    );
  }
});

await test("R3c: mrlSlice(l2Renormalize(v3072), 768) matches golden sha256", async () => {
  const unit3072 = l2Renormalize(buildProbe3072());
  const out = mrlSlice(unit3072, 768);
  assert(out.length === 768, "R3c-len: 768 components", `got ${out.length}`);
  assert(
    sha256(j(out)) === GOLDEN_C_SHA256,
    "R3c-sha: sha256(JSON) matches pre-move golden",
    `got ${sha256(j(out))}, want ${GOLDEN_C_SHA256}`
  );
  for (let i = 0; i < 4; i++) {
    assert(
      out[i] === GOLDEN_C_FIRST4[i],
      `R3c-first[${i}]: ${GOLDEN_C_FIRST4[i]}`,
      `got ${out[i]}`
    );
  }
  for (let i = 0; i < 4; i++) {
    assert(
      out[out.length - 4 + i] === GOLDEN_C_LAST4[i],
      `R3c-last[${i}]: ${GOLDEN_C_LAST4[i]}`,
      `got ${out[out.length - 4 + i]}`
    );
  }
});

await test("R3d: all four throw messages are verbatim-identical to pre-move", async () => {
  assert(
    throwMessage(() => l2Renormalize([0, 0, 0])) === GOLDEN_THROW_ZERO_VECTOR,
    "R3d-1: l2Renormalize zero-vector message verbatim",
    `got ${j(throwMessage(() => l2Renormalize([0, 0, 0])))}`
  );
  assert(
    throwMessage(() => l2NormAssert(null, "golden")) ===
      GOLDEN_THROW_ASSERT_NONARRAY,
    "R3d-2: l2NormAssert non-array message verbatim",
    `got ${j(throwMessage(() => l2NormAssert(null, "golden")))}`
  );
  const nonUnitMsg = throwMessage(() => l2NormAssert([3, 4, 0, 0], "golden"));
  assert(
    nonUnitMsg === GOLDEN_THROW_ASSERT_NONUNIT,
    "R3d-3: l2NormAssert non-unit message verbatim (interpolates the epsilon)",
    `got ${j(nonUnitMsg)}`
  );
  // Explicit sub-assertion: the epsilon really was interpolated from the
  // constant. If someone re-declared 1e-6 as, say, 1e-5 in the new module,
  // R3d-3 above would fail here and nowhere else.
  assert(
    nonUnitMsg.includes(`+/- ${L2_NORM_INVARIANT_EPSILON}`),
    "R3d-3b: message interpolates vector-math's own L2_NORM_INVARIANT_EPSILON",
    `epsilon stringifies as ${String(L2_NORM_INVARIANT_EPSILON)}`
  );
  assert(
    throwMessage(() => mrlSlice([1, 2, 3], 4)) ===
      GOLDEN_THROW_MRL_DIMS_EXCEEDS,
    "R3d-4: mrlSlice dims-exceeds-length message verbatim",
    `got ${j(throwMessage(() => mrlSlice([1, 2, 3], 4)))}`
  );
});

await test("R3e: remaining throw paths fire on the same inputs (throw ORDER preserved for all three functions)", async () => {
  // SCOPE OF THE ORDERING CLAIM — audited by mutant for EACH function, and the
  // three discriminating cases are the first three entries in the table below.
  //
  // A PRIOR REVISION OF THIS COMMENT CLAIMED l2Renormalize/l2NormAssert
  // ORDERING WAS "NOT FALSIFIABLE BY INPUT". THAT WAS FALSE, and the
  // counterexamples were already sitting in this very table. Recorded here
  // because the claim read as a structural proof and was not one — the exact
  // defect class this file exists to guard against.
  //
  // mrlSlice: `mrlSlice([1,2], 2.5)` trips BOTH the non-integer guard and the
  //   dims>length guard. Swapping them turns that case red.
  //
  // l2Renormalize: `l2Renormalize([])` trips BOTH guards — length===0 AND
  //   _l2Norm([])===0. The second guard is reachable on an empty array because
  //   the norm of an empty vector computes fine (it is 0); it is NOT gated on
  //   the first guard having rejected. Swapping emits "cannot renormalize a
  //   zero vector (norm=0)" instead of "vector must be a non-empty array".
  //
  // l2NormAssert: `l2NormAssert([])` likewise trips both — length===0 AND
  //   |0 - 1.0| > epsilon. Swapping emits the unit-norm violation message
  //   instead of the non-empty-array message.
  //
  // MEASURED, this session, with a control proving the harness valid:
  //   control (unmutated, same rewritten specifiers) -> 67 passed / 0 failed
  //   M7 (l2Renormalize guards swapped)              -> RED at "empty array throws verbatim"
  //   M8 (l2NormAssert guards swapped)               -> RED at "unlabeled fallback throws verbatim"
  // The control matters: an earlier mutant run went red on ERR_MODULE_NOT_FOUND
  // because only one of the file's TWO import specifiers had been rewritten.
  // A red that never reached an assertion proves nothing.
  const cases = [
    [
      () => l2Renormalize([]),
      "l2Renormalize: vector must be a non-empty array",
      "empty array",
    ],
    [
      () => l2NormAssert([]),
      "l2NormAssert(<unlabeled>): vector must be a non-empty array",
      "unlabeled fallback",
    ],
    [() => mrlSlice(null), "mrlSlice: vector must be an array", "null vector"],
    [
      () => mrlSlice([1, 2, 3], 0),
      "mrlSlice: dims must be a positive integer, got 0",
      "dims=0",
    ],
    [
      () => mrlSlice([1, 2, 3], 1.5),
      "mrlSlice: dims must be a positive integer, got 1.5",
      "non-integer dims",
    ],
    // THE ordering discriminator. Both dims predicates are true here
    // (2.5 is non-integer AND 2.5 > length 2), so this is the only case in the
    // table whose expected message depends on which guard runs first.
    // Original order -> the positive-integer message; swapped -> "dims (2.5)
    // exceeds input length (2)". Measured against both.
    [
      () => mrlSlice([1, 2], 2.5),
      "mrlSlice: dims must be a positive integer, got 2.5",
      "dual-trip: non-integer AND dims>length — pins guard order",
    ],
    // Guard-1-vs-guard-2 ordering pin: a bad vector AND a bad dims together.
    // HONEST SCOPE: measured, this does NOT distinguish the swapped-dims-guard
    // mutant — the vector guard short-circuits first under BOTH orderings, so
    // both emit this same message. It pins a different axis (that the vector
    // check precedes every dims check) and must not be read as an
    // ordering discriminator for the two dims guards; the case above is.
    [
      () => mrlSlice(null, 2.5),
      "mrlSlice: vector must be an array",
      "dual-trip: bad vector AND bad dims — vector guard wins",
    ],
  ];
  for (const [fn, want, name] of cases) {
    const got = throwMessage(fn);
    assert(got === want, `R3e: ${name} throws verbatim`, `got ${j(got)}`);
  }
  // A unit vector must NOT throw — the invariant is two-sided. Without this,
  // an l2NormAssert that threw unconditionally would satisfy every case above.
  let threw = false;
  try {
    l2NormAssert(l2Renormalize([1, 2, 3, 4, 5]), "R3e-unit");
  } catch (_err) {
    threw = true;
  }
  assert(!threw, "R3e: unit-norm vector does not throw");
});

// ---------------------------------------------------------------------------
// R4 — anti-vacuity: the default-dims path resolves THROUGH the new module's
// own constant. Ordering matters — the constant is proven to drive the slice
// BEFORE the slice output is trusted.
// ---------------------------------------------------------------------------
await test("R4: mrlSlice default-dims resolves through vector-math's DEFAULT_MRL_DIMS", async () => {
  // Step 1: the constant this module exports is the one under test.
  assert(
    DEFAULT_MRL_DIMS === 768,
    "R4a: DEFAULT_MRL_DIMS resolves to 768 through the new module",
    `got ${DEFAULT_MRL_DIMS}`
  );

  // Step 1.5 — R4-src: the ONLY assertion in this group that can tell
  // `dims = DEFAULT_MRL_DIMS` apart from `dims = 768`.
  //
  // WHY A SOURCE-TEXT CHECK, which is otherwise an unusual thing to assert:
  // DEFAULT_MRL_DIMS is an `export const` ES-module binding. Module bindings
  // are immutable from outside the module — there is no assignment, no
  // defineProperty, and no namespace write that can change what
  // vector-math.js's own `dims = DEFAULT_MRL_DIMS` default resolves to. So the
  // literal 768 and the constant DEFAULT_MRL_DIMS can NEVER disagree at
  // runtime, and no input to mrlSlice can make them disagree.
  //
  // That is exactly why R4b below cannot discriminate: it compares
  // DEFAULT_MRL_DIMS against a length that equals it BY CONSTRUCTION. R4b is
  // non-discriminating by DESIGN, not by oversight — keep it as a
  // regression tripwire on the default path, but do not read it as proof that
  // the default is sourced from the constant.
  //
  // Reading the function's source text is therefore the only mechanism
  // available to distinguish the two, and this paragraph is what licenses it.
  // Verified by mutant: replacing `dims = DEFAULT_MRL_DIMS` with `dims = 768`
  // flips R4-src-pos to false and R4-src-neg to true; the whole rest of the
  // suite stays green.
  const mrlSliceSignature = String(mrlSlice).split("{")[0];
  assert(
    /dims\s*=\s*DEFAULT_MRL_DIMS/.test(mrlSliceSignature),
    "R4-src-pos: mrlSlice's signature defaults dims to the NAMED constant",
    `signature was ${j(mrlSliceSignature)}`
  );
  // Negative control: without this, R4-src-pos could pass vacuously against a
  // signature that happened to mention the name in a comment or a second
  // parameter while still defaulting to a literal.
  assert(
    !/dims\s*=\s*\d/.test(mrlSliceSignature),
    "R4-src-neg: mrlSlice's signature defaults dims to NO numeric literal",
    `signature was ${j(mrlSliceSignature)}`
  );

  // Step 2: mrlSlice's DEFAULT parameter yields exactly DEFAULT_MRL_DIMS
  // components. This pins the default path against a wrong-length regression;
  // per R4-src above it CANNOT detect a hardcoded literal, because the literal
  // and the constant are unable to disagree at runtime.
  const unit3072 = l2Renormalize(buildProbe3072());
  const viaDefault = mrlSlice(unit3072);
  assert(
    viaDefault.length === DEFAULT_MRL_DIMS,
    "R4b: default-dims output length === DEFAULT_MRL_DIMS",
    `got ${viaDefault.length}, constant is ${DEFAULT_MRL_DIMS}`
  );
  // Step 3: and only now is the output compared to the golden.
  assert(
    sha256(j(viaDefault)) === GOLDEN_C_SHA256,
    "R4c: default-dims output is bit-identical to the explicit-768 golden",
    `got ${sha256(j(viaDefault))}`
  );
  // Step 4: a dims value that disagrees with the constant must produce a
  // different length, proving the parameter is live rather than ignored.
  const via512 = mrlSlice(unit3072, 512);
  assert(
    via512.length === 512 && via512.length !== DEFAULT_MRL_DIMS,
    "R4d: explicit dims=512 is honored (parameter is not ignored)",
    `got ${via512.length}`
  );
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
console.log(`vector-math.test.mjs: ${passes} passed, ${failures} failed`);
if (failures > 0) {
  process.exit(1);
}
process.exit(0);
