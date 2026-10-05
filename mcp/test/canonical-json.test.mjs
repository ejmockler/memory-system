// Conformance test for canonical_json / canonicalJsonSha256Hex.
// Asserts the frozen test vector from kb/mcp-surface.md § Privilege levels +
// the non-ASCII probe that catches NFC-normalization bugs (RFC 8785 §3.2.2.2).
//
// Run: node test/canonical-json.test.mjs
// Exits 0 on pass, non-zero on any failure.

import assert from "node:assert/strict";
import { canonicalJson, canonicalJsonSha256Hex } from "../lib/validation.js";

let failures = 0;
function check(label, actual, expected) {
  try {
    assert.equal(actual, expected);
    console.log(`PASS  ${label}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL  ${label}`);
    console.error(`      expected: ${expected}`);
    console.error(`      actual:   ${actual}`);
  }
}

// --- Frozen test vector: memory_excise binding_object ---
const binding = {
  target: "mem_01HZX8K9PQRS",
  scope: "memory_ledger_only",
  derivation_policy: "retain",
  silent: false,
};
check(
  "binding_object canonical bytes (102)",
  Buffer.from(canonicalJson(binding), "utf8").length,
  102,
);
check(
  "binding_object canonical string",
  canonicalJson(binding),
  '{"derivation_policy":"retain","scope":"memory_ledger_only","silent":false,"target":"mem_01HZX8K9PQRS"}',
);
check(
  "binding_object sha256 (FROZEN)",
  canonicalJsonSha256Hex(binding),
  "5d6109a311a8ed773135c518c8a5e72bc226d68ef7d592d74c3321a1dc30a17d",
);

// --- Non-ASCII probe: catches NFC-normalization bugs ---
// 'Å' as a single pre-composed codepoint (U+00C5).
const probePrecomposed = { target: "Å" };
check(
  "non-ASCII precomposed sha256 (FROZEN)",
  canonicalJsonSha256Hex(probePrecomposed),
  "568cccda11871a435749f7503e3657bb283794efa33633771813bc2c9e9a9023",
);

// 'Å' as decomposed sequence: 'A' (U+0041) + combining ring above (U+030A).
const probeDecomposed = { target: "Å" };
check(
  "non-ASCII decomposed sha256 (FROZEN)",
  canonicalJsonSha256Hex(probeDecomposed),
  "ecaa0f3a5eaf4bd3b38de5c2b6284002e2387eb75b208d0638caff0fa4e9e535",
);

// Critical invariant: pre-composed and decomposed MUST produce different
// canonical bytes (otherwise the implementation is silently NFC-normalizing).
check(
  "precomposed != decomposed (no NFC)",
  canonicalJson(probePrecomposed) !== canonicalJson(probeDecomposed),
  true,
);

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll ${6} canonical_json conformance checks passed.`);
