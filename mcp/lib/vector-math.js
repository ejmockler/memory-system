// vector-math.js
//
// L2 norm / renormalization / MRL-slice primitives for embedding vectors.
//
// These four functions were extracted from mcp/lib/gemini-client.js, where
// they had accumulated consumers across three tiers: the recall index layer
// (recall/hnsw-index.js), the ingest cascade (ingest/_hnsw.js,
// ingest/_corroborate.js), the promote path (tools/distill-promote-fact.js,
// tools/recall.js), and three offline scripts. None of that math is
// Gemini-specific: it operates on plain numeric arrays and is used unchanged
// against the local Qwen3 4096d embedder as well as the 3072d Gemini vectors.
//
// SCOPE / DEPENDENCIES:
//   This file has ZERO import statements, node stdlib included. That is a
//   deliberate structural property, not an accident of the current contents:
//   gemini-client.js imports FROM here, so any import added here risks an
//   ES-module cycle through a consumer. Keep it dependency-free.
//
// THE UNIT-NORM INVARIANT:
//   Sliced vectors are NOT unit-norm. Truncating a unit 3072d vector to its
//   first 768 components leaves norm well below 1.0, so a dot product over
//   the slice is not a cosine. mrlSlice() therefore renormalizes after
//   truncating, and l2NormAssert() is the runtime enforcement point that
//   catches a missing renorm at whichever layer skipped it — the `label`
//   argument is interpolated into the thrown message to name that layer.
//
// FLOAT DISCIPLINE:
//   _l2Norm accumulates in a single forward loop. Summation order determines
//   the low bits of the result, which in turn determines whether a vector
//   sitting near the epsilon boundary passes or throws, so the loop is not
//   safe to "optimize" into a reduce/SIMD/pairwise form without re-deriving
//   every caller's tolerance.

// MRL slice default — 768d is the operating point per the architecture report
// § "MRL strategy" (storage cost ~25%, MTEB loss ~0.26%).
export const DEFAULT_MRL_DIMS = 768;

// L2 norm invariant tolerance. Tight enough to catch real bugs (no-renorm on
// slice) but loose enough for float32 quantization noise.
export const L2_NORM_INVARIANT_EPSILON = 1e-6;

// Compute L2 norm of a numeric vector.
function _l2Norm(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    const v = vector[i];
    sum += v * v;
  }
  return Math.sqrt(sum);
}

// L2-renormalize a vector. Returns a NEW Array<number> with the same length.
// Asserts the input is not all-zeros (would divide by zero).
export function l2Renormalize(vector) {
  if (!vector || typeof vector.length !== "number" || vector.length === 0) {
    throw new Error("l2Renormalize: vector must be a non-empty array");
  }
  const norm = _l2Norm(vector);
  if (norm === 0 || !Number.isFinite(norm)) {
    throw new Error(
      "l2Renormalize: cannot renormalize a zero vector (norm=0); input may be uninitialized"
    );
  }
  const out = new Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    out[i] = vector[i] / norm;
  }
  return out;
}

// Assert ||v||=1.0 +/- L2_NORM_INVARIANT_EPSILON. Throws on violation.
// `label` is included in the error message to locate the failing layer.
export function l2NormAssert(vector, label) {
  if (!vector || typeof vector.length !== "number" || vector.length === 0) {
    throw new Error(
      `l2NormAssert(${label || "<unlabeled>"}): vector must be a non-empty array`
    );
  }
  const norm = _l2Norm(vector);
  if (Math.abs(norm - 1.0) > L2_NORM_INVARIANT_EPSILON) {
    throw new Error(
      `l2NormAssert(${label || "<unlabeled>"}): unit-norm invariant violated; ||v||=${norm} (expected 1.0 +/- ${L2_NORM_INVARIANT_EPSILON})`
    );
  }
}

// MRL slice: truncate the first `dims` components of a full 3072d vector, then
// L2-renormalize. Per Phase A: sliced vectors are NOT unit-norm; renorm is
// REQUIRED before any cosine via dot product.
export function mrlSlice(vector_3072, dims = DEFAULT_MRL_DIMS) {
  if (!vector_3072 || typeof vector_3072.length !== "number") {
    throw new Error("mrlSlice: vector must be an array");
  }
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new Error(`mrlSlice: dims must be a positive integer, got ${dims}`);
  }
  if (dims > vector_3072.length) {
    throw new Error(
      `mrlSlice: dims (${dims}) exceeds input length (${vector_3072.length})`
    );
  }
  const sliced = new Array(dims);
  for (let i = 0; i < dims; i++) sliced[i] = vector_3072[i];
  return l2Renormalize(sliced);
}
