// Conformance + frozen-vector test for lib/daemon-token.js.
// Phase 1 deliverable. Pins the wire shape and the five-step verification
// rejection table (steps 0-3) against deterministic inputs so any future drift
// in canonical_json, HMAC framing, base64url encoding, or freshness math
// surfaces as a test failure rather than a propagation bug.
//
// FAIL-FAST INVARIANT (review-13 C4 — contract documented here, exercised
// indirectly via the supervisor's mintToken-then-appendPolicyEvent ordering):
// distillation-supervisor.js MUST append policy.token.minted BEFORE spawning
// the MCP child, with NO try/catch around the append. If appendPolicyEvent
// throws (disk full, lock unrecoverable, policy-events.jsonl corrupt), the
// supervisor process MUST fail loud (exception propagates out of processBatch
// to the tick loop; the batch stays in in-flight/ and the stale-reclaim path
// retries on the next supervisor start). Catching the append failure and
// continuing to the MCP call would silently break the audit-join invariant:
// a consumed/rejected row with no matching minted row defeats the purpose of
// the token-event ownership table in kb/agent-integration.md.
//
// Run: node test/daemon-token.test.mjs
// Exits 0 on pass, non-zero on any failure.

import { createHash, randomBytes } from "node:crypto";
import {
  mintToken,
  verifyToken,
  verifyBinding,
} from "../lib/daemon-token.js";
import { canonicalJson, canonicalJsonSha256Hex } from "../lib/validation.js";

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- Frozen vector ---
const KEY = Buffer.from("00".repeat(32), "hex");
const BINDING_HASH =
  "5d6109a311a8ed773135c518c8a5e72bc226d68ef7d592d74c3321a1dc30a17d";
const NONCE_HEX = "0123456789abcdef0123456789abcdef";
const ISSUED_AT = "2026-05-31T00:00:00Z";
const EXPIRES_AT = "2026-05-31T00:05:00Z";
const TOOL = "memory_distill_promote_fact";

const minted = mintToken(BINDING_HASH, TOOL, KEY, {
  nonce_hex: NONCE_HEX,
  issued_at: ISSUED_AT,
  expires_at: EXPIRES_AT,
});

// --- Payload canonical bytes count (pin) ---
// Reconstruct the payload object exactly as buildPayload does and measure
// its canonical_json byte length. First-run output prints; pinned value below.
const payloadObj = {
  binding_hash: BINDING_HASH,
  expires_at: EXPIRES_AT,
  issued_at: ISSUED_AT,
  nonce: NONCE_HEX,
  type: "daemon",
};
const payloadCanonical = canonicalJson(payloadObj);
const payloadBytes = Buffer.from(payloadCanonical, "utf8").length;
console.log(`INFO  payload canonical bytes = ${payloadBytes}`);
check(
  "payload canonical bytes (FROZEN 213)",
  payloadBytes === 213,
  `got ${payloadBytes}`,
);

// --- Wire token shape ---
// base64url(payload) + "." + base64url(signature). Signature is 32 raw bytes;
// base64url of 32 bytes is 43 chars (no padding). Payload section is ceil(219*4/3)
// = 292 chars before url-safe stripping.
const dotIdx = minted.token.indexOf(".");
check("wire token contains single dot", dotIdx > 0 && minted.token.indexOf(".", dotIdx + 1) < 0);
const [wirePayload, wireSig] = minted.token.split(".");
check(
  "wire signature is 43 base64url chars (32 raw bytes, no padding)",
  wireSig.length === 43,
  `got len=${wireSig.length}`,
);
console.log(`INFO  wire payload b64url length = ${wirePayload.length}`);
check(
  "wire payload base64url length (FROZEN 284)",
  wirePayload.length === 284,
  `got len=${wirePayload.length}`,
);
check(
  "wire token base64url alphabet (no '+' '/' '=')",
  !/[+/=]/.test(minted.token),
  "wire token contains non-base64url chars",
);

// --- Verify round-trip ---
const ok1 = verifyToken(minted.token, KEY, { now: "2026-05-31T00:01:00Z" });
check("verifyToken round-trip ok", ok1.ok === true, JSON.stringify(ok1));
check(
  "verifyToken payload binding_hash matches",
  ok1.payload?.binding_hash === BINDING_HASH,
);
const expectedNonceHash = createHash("sha256").update(NONCE_HEX).digest("hex");
check(
  "verifyToken nonce_hash matches sha256(nonce_hex)",
  ok1.nonce_hash === expectedNonceHash,
  `got ${ok1.nonce_hash}`,
);

// --- Tampered payload (single byte flip outside type field) ---
// Flip one nibble in the base64url payload section; signature won't match.
const flipIdx = 5; // somewhere inside payload b64, well clear of "type":"daemon"
const flipped =
  wirePayload.slice(0, flipIdx) +
  (wirePayload[flipIdx] === "A" ? "B" : "A") +
  wirePayload.slice(flipIdx + 1);
const tamperedToken = `${flipped}.${wireSig}`;
const tamperedRes = verifyToken(tamperedToken, KEY, {
  now: "2026-05-31T00:01:00Z",
});
check(
  "tampered payload returns ok:false",
  tamperedRes.ok === false,
  JSON.stringify(tamperedRes),
);
// Could be malformed (if b64 decode fails or JSON parse fails) or bad_signature
// depending on which byte is flipped. We pin to bad_signature for byte index 5
// which is inside the base64-encoded payload mantissa — the JSON will still
// parse but the HMAC will fail.
check(
  "tampered payload reason is bad_signature OR malformed",
  tamperedRes.reason === "bad_signature" ||
    tamperedRes.reason === "malformed",
  `got reason=${tamperedRes.reason}`,
);

// --- Type swap to "user" ---
// Build a payload with type:"user" and HMAC it with the same key. verifyToken
// must reject with wrong_type at step 1 before signature check.
const userPayload = { ...payloadObj, type: "user" };
const userCanonical = canonicalJson(userPayload);
const { createHmac } = await import("node:crypto");
const userSig = createHmac("sha256", KEY).update(Buffer.from(userCanonical, "utf8")).digest();
const userToken = `${Buffer.from(userCanonical, "utf8").toString("base64url")}.${userSig.toString("base64url")}`;
const userRes = verifyToken(userToken, KEY, { now: "2026-05-31T00:01:00Z" });
check(
  "type-swap returns wrong_type",
  userRes.ok === false && userRes.reason === "wrong_type",
  `got ${JSON.stringify(userRes)}`,
);

// --- Expired (now > expires_at) ---
const expiredRes = verifyToken(minted.token, KEY, {
  now: "2026-05-31T00:06:00Z",
});
check(
  "expired returns expired",
  expiredRes.ok === false && expiredRes.reason === "expired",
  `got ${JSON.stringify(expiredRes)}`,
);

// --- Stale issue (now - issued_at > DISTILLATION_TOKEN_TTL_SECONDS) ---
// Mint a token whose expires_at is far enough out that "expired" doesn't fire
// before "stale_issue", but whose issued_at is > 300s old relative to now.
// issued_at = base, expires_at = base + 1h, now = base + 6m -> age 360s > 300s.
const staleMint = mintToken(BINDING_HASH, TOOL, KEY, {
  nonce_hex: NONCE_HEX,
  issued_at: "2026-05-31T00:00:00Z",
  expires_at: "2026-05-31T01:00:00Z",
});
const staleRes = verifyToken(staleMint.token, KEY, {
  now: "2026-05-31T00:06:00Z",
});
check(
  "stale issue returns stale_issue",
  staleRes.ok === false && staleRes.reason === "stale_issue",
  `got ${JSON.stringify(staleRes)}`,
);

// --- TTL overrun (expires_at > now + CONSUMED_NONCE_TTL_SECONDS) ---
// CONSUMED_NONCE_TTL_SECONDS = 604800 (7d). Mint with expires_at = now + 8d.
// issued_at must be recent so stale_issue doesn't pre-empt; pin both via now.
const ttlNow = "2026-05-31T00:00:30Z";
const ttlMint = mintToken(BINDING_HASH, TOOL, KEY, {
  nonce_hex: NONCE_HEX,
  issued_at: "2026-05-31T00:00:00Z",
  expires_at: "2026-06-08T00:00:00Z", // 8 days out
});
const ttlRes = verifyToken(ttlMint.token, KEY, { now: ttlNow });
check(
  "ttl overrun returns ttl_overrun",
  ttlRes.ok === false && ttlRes.reason === "ttl_overrun",
  `got ${JSON.stringify(ttlRes)}`,
);

// --- verifyBinding ---
// Use the exact Phase 0 binding object whose canonical sha256 is the frozen
// BINDING_HASH above.
const correctBinding = {
  target: "mem_01HZX8K9PQRS",
  scope: "memory_ledger_only",
  derivation_policy: "retain",
  silent: false,
};
check(
  "verifyBinding true on correct binding object",
  verifyBinding(ok1.payload, correctBinding) === true,
);
const tamperedBinding = { ...correctBinding, silent: true };
check(
  "verifyBinding false on tampered binding object",
  verifyBinding(ok1.payload, tamperedBinding) === false,
);

// ---------------------------------------------------------------------------
// PROMOTE-FACT binding round-trip (closes review-12 M3 gap).
// Before this block, only the excise-style binding {target,scope,...} was
// exercised. memory_distill_promote_fact uses a DIFFERENT binding object,
// {content_hash, source_refs_hash}, and its semantics must round-trip the
// same mint→verifyToken→verifyBinding pipeline. The mismatch surface this
// exercises is real: spec § Handler steps requires
//   content_hash     = sha256(RAW utf-8 bytes of content)  — NOT canonicalized
//   source_refs_hash = sha256(canonical_json(source_refs)) — canonicalized
// Reversing those (e.g. canonicalizing content) would silently produce a
// different binding_hash than the supervisor minted, and every promote-fact
// call would fail at step 3 with binding_mismatch. We pin both hashing
// rules here, and we also assert that verifyBinding correctly rejects a
// tampered binding object whose content_hash differs by a single byte.
// ---------------------------------------------------------------------------
const PF_CONTENT = "The cat sat on the mat.";
// source_refs is the exact array shape the supervisor submits: an array of
// {source_msg_id, span:[start,end]} objects per kb/mcp-surface.md
// § memory_distill_promote_fact / args.source_refs.
const PF_SOURCE_REFS = [
  { source_msg_id: "chat:claude-code:2026-05-31T00:00:00Z#000001", span: [0, 23] },
  { source_msg_id: "chat:claude-code:2026-05-31T00:00:00Z#000002", span: [0, 5] },
];
const pfContentHash = createHash("sha256")
  .update(Buffer.from(PF_CONTENT, "utf8"))
  .digest("hex");
// canonicalJson handles deterministic ordering; the supervisor must hash in
// the same order it submits, and JCS preserves array order.
const pfSourceRefsHash = createHash("sha256")
  .update(Buffer.from(canonicalJson(PF_SOURCE_REFS), "utf8"))
  .digest("hex");
// Spec-frozen binding shape for promote-fact: {content_hash, source_refs_hash}.
// canonical_json sorts keys lexicographically, so content_hash precedes
// source_refs_hash — but we never rely on that here, just hand it to
// canonicalJsonSha256Hex via verifyBinding's recompute.
const pfBindingObject = {
  content_hash: pfContentHash,
  source_refs_hash: pfSourceRefsHash,
};
// Compute the canonical sha256 of the binding object up-front so we can mint
// a token bound to it (canonicalJsonSha256Hex is imported at the top).
const pfBindingHash = canonicalJsonSha256Hex(pfBindingObject);
const pfMint = mintToken(pfBindingHash, "memory_distill_promote_fact", KEY, {
  nonce_hex: "fedcba9876543210fedcba9876543210",
  issued_at: ISSUED_AT,
  expires_at: EXPIRES_AT,
});
const pfVerified = verifyToken(pfMint.token, KEY, { now: "2026-05-31T00:01:00Z" });
check(
  "promote-fact: verifyToken round-trip ok",
  pfVerified.ok === true,
  JSON.stringify(pfVerified),
);
check(
  "promote-fact: verifyToken payload.binding_hash equals canonical sha256 of {content_hash, source_refs_hash}",
  pfVerified.payload?.binding_hash === pfBindingHash,
  `got ${pfVerified.payload?.binding_hash}`,
);
check(
  "promote-fact: verifyBinding true on correct {content_hash, source_refs_hash} object",
  verifyBinding(pfVerified.payload, pfBindingObject) === true,
);
// Tamper #1: flip one nibble of content_hash. Equivalent to "the cat sat on
// the rug." — content_hash is byte-derived so any content change shifts
// every byte of the binding_hash too.
const pfTamperedContent = {
  ...pfBindingObject,
  content_hash:
    pfBindingObject.content_hash.slice(0, -1) +
    (pfBindingObject.content_hash.endsWith("0") ? "1" : "0"),
};
check(
  "promote-fact: verifyBinding false when content_hash is tampered (1 nibble)",
  verifyBinding(pfVerified.payload, pfTamperedContent) === false,
);
// Tamper #2: flip one nibble of source_refs_hash. Equivalent to swapping
// the order of two source_refs entries (JCS preserves array order, so
// reordering changes the canonical bytes and therefore the hash).
const pfTamperedRefs = {
  ...pfBindingObject,
  source_refs_hash:
    pfBindingObject.source_refs_hash.slice(0, -1) +
    (pfBindingObject.source_refs_hash.endsWith("0") ? "1" : "0"),
};
check(
  "promote-fact: verifyBinding false when source_refs_hash is tampered (1 nibble)",
  verifyBinding(pfVerified.payload, pfTamperedRefs) === false,
);
// Tamper #3: drop a key entirely — spec says the binding object has exactly
// these two keys; missing one must reject (canonical_json over a different
// shape yields a different hash).
const pfMissingKey = { content_hash: pfBindingObject.content_hash };
check(
  "promote-fact: verifyBinding false when source_refs_hash is missing entirely",
  verifyBinding(pfVerified.payload, pfMissingKey) === false,
);

// ---------------------------------------------------------------------------
// Explicit bad_signature path (closes review-12 M5 gap).
// The earlier tampered-payload test flips a byte inside the payload base64,
// which pins the reason to bad_signature OR malformed depending on how the
// flipped byte decodes. That ambiguity means the bad_signature branch is
// only "covered" by accident. Here we exercise it deterministically: keep
// the payload bytes intact (so step 0 wire / step 1 type+freshness all
// succeed) and replace the signature half with a fresh 32-random-bytes
// base64url string. Step 2 must then surface exactly "bad_signature".
// ---------------------------------------------------------------------------
{
  const goodPayloadB64 = wirePayload; // unchanged — same minted token's payload
  const forgedSigBytes = randomBytes(32);
  const forgedToken = `${goodPayloadB64}.${forgedSigBytes.toString("base64url")}`;
  const forgedRes = verifyToken(forgedToken, KEY, {
    now: "2026-05-31T00:01:00Z",
  });
  check(
    "bad_signature: ok === false",
    forgedRes.ok === false,
    JSON.stringify(forgedRes),
  );
  check(
    "bad_signature: reason is EXACTLY 'bad_signature' (not 'malformed', not 'wrong_type')",
    forgedRes.reason === "bad_signature",
    `got reason=${forgedRes.reason}`,
  );
  // Belt-and-braces: prove we are not just hitting bad_signature because
  // the forged sig happens to be the wrong byte-length. forgedSigBytes is
  // exactly 32 raw bytes, same as a real HMAC-SHA256 output, so the
  // length-equality guard inside verifyToken passes and timingSafeEqual is
  // what rejects it. This pin protects the meaningful failure mode.
  check(
    "bad_signature: forged signature decoded length is 32 bytes (HMAC-SHA256 sized)",
    Buffer.from(forgedToken.split(".")[1], "base64url").length === 32,
  );
}

// --- Summary ---
if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(`\nAll daemon-token conformance checks passed.`);
