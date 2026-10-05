// distill-emit-reconstructed.test.mjs — Wave 8 INTEGRATION test suite.
//
// Covers F-SYN-INTEGRATION-RECONSTRUCTED-MCP-TOOL (the agent-callable MCP
// tool that wraps the W7 substrate emitter). Mirrors the
// reconstruction-emitter.test.mjs hermetic discipline but exercises the
// envelope contract (ok / data / error / meta) rather than the substrate's
// raw return shape.
//
// Scope (per the WU prompt):
//   - Valid call with parent fact + valid token → ok:true, memory_event_id
//   - Invalid token shape → envelope error (PRIVILEGE_REQUIRED + reason)
//   - Expired token (iat older than 900s) → TOKEN_EXPIRED maps to envelope
//   - Parent not found → envelope error (NOT_FOUND)
//   - Replay of same {content_hash, parent_set_hash, conversation_id} →
//     returns same memory_event_id, dedupe_action: "rejected_idempotent"
//   - Envelope shape validation (ok/data/error/meta)
//   - At least 10 assertions
//
// Hermetic discipline: env vars set BEFORE any dynamic import touches
// config.js so the ledger / policy paths land under TMP_ROOT.
//
// Run: node test/synthesis/distill-emit-reconstructed.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// -----------------------------------------------------------------------------
// 1. Hermetic env — MUST be set BEFORE any dynamic import touches config.js.
// -----------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-distemit-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.POLICY_BASE_DIR = join(TMP_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TMP_ROOT, "ledgers");
process.env.HOOKS_BASE_DIR = join(TMP_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(TMP_ROOT, "daemons");

for (const d of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  process.env.HOOKS_BASE_DIR,
  process.env.DAEMONS_BASE_DIR,
  join(process.env.STORAGE_BASE_DIR, "sources"),
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {}
});

// -----------------------------------------------------------------------------
// 2. Dynamic imports — bind into TMP_ROOT.
// -----------------------------------------------------------------------------

const toolMod = await import("../../lib/tools/distill-emit-reconstructed.js");
const { TOOL, mapSubstrateCodeToEnvelope } = toolMod;

const { memoryLedgerPath } = await import("../../lib/config.js");
const daemonTokenMod = await import("../../lib/daemon-token.js");
const { canonicalJsonSha256Hex } = await import("../../lib/validation.js");
const { RECONSTRUCT_TOKEN_TYPE } = await import(
  "../../lib/synthesis/reconstruction-emitter.js"
);

const LEDGER_PATH = memoryLedgerPath();

test("substrate schema rejects drive envelope mapping without a copied code list", () => {
  assert.equal(
    mapSubstrateCodeToEnvelope("INVALID_AGENT_ID", "schema"),
    "INVALID_ARGUMENTS",
  );
});

test("planted token reject drives envelope mapping without a copied code list", () => {
  assert.equal(
    mapSubstrateCodeToEnvelope("PLANTED_TOKEN_REJECT", "token"),
    "PRIVILEGE_REQUIRED",
  );
});

// Ensure the signing key exists (verifyAgentToken needs it).
function ensureSigningKey() {
  try {
    return daemonTokenMod.initSigningKey().key;
  } catch (e) {
    if (e && e.code === "EEXIST") return daemonTokenMod.loadSigningKey().key;
    throw e;
  }
}
const SIGNING_KEY = ensureSigningKey();

// -----------------------------------------------------------------------------
// 3. Helpers
// -----------------------------------------------------------------------------

function clearLedger() {
  if (existsSync(LEDGER_PATH)) {
    writeFileSync(LEDGER_PATH, "", { mode: 0o600 });
  }
}

function ledgerLines() {
  if (!existsSync(LEDGER_PATH)) return [];
  const raw = readFileSync(LEDGER_PATH, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function seedFact(id, content) {
  mkdirSync(process.env.LEDGERS_BASE_DIR, { recursive: true, mode: 0o700 });
  const row = {
    id,
    ts: "2026-05-31T00:00:00Z",
    kind: "fact",
    content,
    source: "test-fixture",
    source_refs: [
      {
        source: "test-fixture",
        source_msg_id: id,
        via: "original",
        consent_basis: "first_party",
      },
    ],
    derived_from: [],
    provenance: {
      agent_id: "test-fixture",
      conversation_id: null,
      confidence: "high",
    },
    features: { entities: [], time_anchors: [] },
    created_at: "2026-05-31T00:00:00Z",
  };
  appendFileSync(LEDGER_PATH, JSON.stringify(row) + "\n", { mode: 0o600 });
}

// Mint a token bound to the reconstruct binding-object. Mirrors the substrate
// test's mintAgentToken (the off-the-shelf verifyToken accepts the canonical
// "daemon" type token; the supervisor-side type upgrade lands later).
function mintAgentToken({ content, parents, conversation_id, scope }, opts = {}) {
  const sortedParents = [...parents].sort();
  const bindingObject = {
    content_hash: createHash("sha256")
      .update(Buffer.from(content, "utf8"))
      .digest("hex"),
    parent_set_hash: canonicalJsonSha256Hex(sortedParents),
    conversation_id,
    scope,
  };
  const bindingHash = canonicalJsonSha256Hex(bindingObject);
  const minted = daemonTokenMod.mintToken(
    bindingHash,
    RECONSTRUCT_TOKEN_TYPE,
    SIGNING_KEY,
    opts,
  );
  return minted.token;
}

// Helper to assert the canonical envelope shape from lib/envelope.js.
function assertEnvelopeShape(env, expectedToolName) {
  assert.ok(env && typeof env === "object", "envelope is an object");
  assert.ok("ok" in env, "envelope has ok field");
  assert.equal(typeof env.ok, "boolean", "envelope.ok is a boolean");
  assert.ok("data" in env, "envelope has data field");
  assert.ok("error" in env, "envelope has error field");
  assert.ok("meta" in env, "envelope has meta field");
  assert.equal(env.meta.tool, expectedToolName, "envelope.meta.tool matches");
  assert.equal(typeof env.meta.version, "number", "envelope.meta.version is numeric");
  if (env.ok === true) {
    assert.ok(env.data !== null, "success envelope has data");
    assert.equal(env.error, null, "success envelope has null error");
  } else {
    assert.equal(env.data, null, "error envelope has null data");
    assert.ok(env.error !== null, "error envelope has non-null error");
    assert.equal(typeof env.error.code, "string", "error.code is a string");
    assert.equal(typeof env.error.message, "string", "error.message is a string");
  }
}

// -----------------------------------------------------------------------------
// 4. TOOL export shape — registration / inputSchema integrity
// -----------------------------------------------------------------------------

test("TOOL export: name + description + inputSchema + handler are present", () => {
  assert.equal(TOOL.name, "memory_distill_emit_reconstructed");
  assert.equal(typeof TOOL.description, "string");
  assert.ok(TOOL.description.length > 0);
  assert.equal(typeof TOOL.inputSchema, "object");
  assert.equal(TOOL.inputSchema.type, "object");
  assert.deepEqual(
    [...TOOL.inputSchema.required].sort(),
    [
      "confirmation_token",
      "content",
      "conversation_id",
      "parents",
      "scope",
    ],
  );
  assert.equal(typeof TOOL.handler, "function");
});

test("TOOL inputSchema: additionalProperties is false (unknown keys rejected)", () => {
  assert.equal(TOOL.inputSchema.additionalProperties, false);
});

// -----------------------------------------------------------------------------
// 5. Happy path — valid token + live parent fact → ok envelope
// -----------------------------------------------------------------------------

test("happy path: valid call with parent fact + valid token returns ok envelope", async () => {
  clearLedger();
  seedFact("fact_happy_a", "Operator told Claude the QD-4 sorter's serial link runs through port ttyS3.");

  const content =
    "Summary: the operator's Tumbler QD-4 keeps its serial link on port ttyS3 for control.";
  const token = mintAgentToken({
    content,
    parents: ["fact_happy_a"],
    conversation_id: "conv-happy",
    scope: "conversation_local",
  });
  const env = await TOOL.handler({
    parents: ["fact_happy_a"],
    content,
    scope: "conversation_local",
    confidence: 0.85,
    agent_role: "summarizer",
    conversation_id: "conv-happy",
    confirmation_token: token,
  });
  assertEnvelopeShape(env, "memory_distill_emit_reconstructed");
  assert.equal(env.ok, true, "happy path returns ok:true");
  assert.match(env.data.memory_event_id, /^rec_/);
  assert.equal(env.data.dedupe_action, "appended");
  assert.equal(env.data.dropped, false);

  const rows = ledgerLines();
  const row = rows.find((r) => r.id === env.data.memory_event_id);
  assert.ok(row, "row is durably on disk");
  assert.equal(row.kind, "reconstructed");
  assert.deepEqual(row.derived_from, ["fact_happy_a"]);
  assert.equal(row.scope, "conversation_local");
  assert.match(row.provenance.agent_id, /^(claude-code|codex|operator):/);
});

// -----------------------------------------------------------------------------
// 6. Invalid token shape
// -----------------------------------------------------------------------------

test("invalid token: malformed token string is rejected with PRIVILEGE_REQUIRED + token-reject reason", async () => {
  clearLedger();
  seedFact("fact_invalid_tok", "A live fact for invalid-token test.");

  const env = await TOOL.handler({
    parents: ["fact_invalid_tok"],
    content: "Invalid-token attempt should be refused before any ledger touch.",
    scope: "conversation_local",
    confidence: 0.8,
    conversation_id: "conv-invalid-tok",
    confirmation_token: "not.a.valid.token",
  });
  assertEnvelopeShape(env, "memory_distill_emit_reconstructed");
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "PRIVILEGE_REQUIRED");
  // Reason surfaces the substrate's token-reject code (MALFORMED_TOKEN,
  // BAD_SIGNATURE, INVALID_TOKEN_TYPE, etc.) — any of these prove the
  // token verification short-circuited before the ledger.
  assert.ok(env.error.details && typeof env.error.details.reason === "string");
  assert.ok(
    [
      "MALFORMED_TOKEN",
      "BAD_SIGNATURE",
      "INVALID_TOKEN_TYPE",
      "TOKEN_EXPIRED",
    ].includes(env.error.details.reason),
    `expected a token-reject reason; got ${env.error.details.reason}`,
  );
  const rows = ledgerLines();
  const recRows = rows.filter((r) => r.kind === "reconstructed");
  assert.equal(recRows.length, 0, "no reconstructed row written on token failure");
});

// -----------------------------------------------------------------------------
// 7. Expired token (iat older than TTL window)
// -----------------------------------------------------------------------------

test("expired token: iat older than 900s is rejected with PRIVILEGE_REQUIRED (TOKEN_EXPIRED reason)", async () => {
  clearLedger();
  seedFact("fact_expired_tok", "A live fact for expired-token test.");

  // Mint a token whose issued_at is older than the TTL window. We pass
  // explicit issued_at + expires_at via opts so the verifier sees a
  // structurally-valid token whose freshness gate fails.
  const longAgoIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const longAgoExpires = new Date(Date.now() - 23 * 3600 * 1000).toISOString();
  const content = "Expired-token attempt should be refused on freshness grounds.";
  const token = mintAgentToken(
    {
      content,
      parents: ["fact_expired_tok"],
      conversation_id: "conv-expired-tok",
      scope: "conversation_local",
    },
    { issued_at: longAgoIso, expires_at: longAgoExpires },
  );
  const env = await TOOL.handler({
    parents: ["fact_expired_tok"],
    content,
    scope: "conversation_local",
    confidence: 0.8,
    conversation_id: "conv-expired-tok",
    confirmation_token: token,
  });
  assertEnvelopeShape(env, "memory_distill_emit_reconstructed");
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "PRIVILEGE_REQUIRED");
  // The substrate's tokenVerifyReasonToCode maps "expired" / "stale_issue" /
  // "ttl_overrun" to TOKEN_EXPIRED. Any of these reasons satisfies the
  // expired-token spec contract.
  assert.equal(env.error.details.reason, "TOKEN_EXPIRED");
});

// -----------------------------------------------------------------------------
// 8. Parent not found
// -----------------------------------------------------------------------------

test("parent not found: missing parent id is rejected with NOT_FOUND envelope", async () => {
  clearLedger();
  // No facts seeded; the parent id below does not exist.

  const content =
    "Summarization that references a parent id which is not present in the ledger.";
  const token = mintAgentToken({
    content,
    parents: ["fact_nonexistent_zz"],
    conversation_id: "conv-missing-parent",
    scope: "conversation_local",
  });
  const env = await TOOL.handler({
    parents: ["fact_nonexistent_zz"],
    content,
    scope: "conversation_local",
    confidence: 0.8,
    conversation_id: "conv-missing-parent",
    confirmation_token: token,
  });
  assertEnvelopeShape(env, "memory_distill_emit_reconstructed");
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "NOT_FOUND");
  assert.equal(env.error.details.reason, "PARENT_NOT_FOUND");
  assert.match(env.error.message, /fact_nonexistent_zz/);
  // The substrate burned the nonce before refusing (R3 ordering); we surface
  // dropped:true so callers can branch on "structurally rejected" without
  // parsing the code.
  assert.equal(env.error.details.dropped, true);
});

// -----------------------------------------------------------------------------
// 9. Replay returns same memory_event_id (idempotency)
// -----------------------------------------------------------------------------

test("idempotent replay: same {content_hash, parent_set_hash, conversation_id} returns same memory_event_id", async () => {
  clearLedger();
  seedFact("fact_replay_a", "Shared parent A for replay test.");
  seedFact("fact_replay_b", "Shared parent B for replay test.");

  const content =
    "Idempotency-replay summarization with identical args across calls.";
  const parents = ["fact_replay_a", "fact_replay_b"];
  const token1 = mintAgentToken({
    content,
    parents,
    conversation_id: "conv-replay",
    scope: "conversation_local",
  });
  const first = await TOOL.handler({
    parents,
    content,
    scope: "conversation_local",
    confidence: 0.9,
    conversation_id: "conv-replay",
    confirmation_token: token1,
  });
  assertEnvelopeShape(first, "memory_distill_emit_reconstructed");
  assert.equal(first.ok, true);
  assert.equal(first.data.dedupe_action, "appended");
  const firstId = first.data.memory_event_id;
  assert.match(firstId, /^rec_/);

  // Mint a FRESH token (the nonce is single-use). Same binding-object hash.
  const token2 = mintAgentToken({
    content,
    parents,
    conversation_id: "conv-replay",
    scope: "conversation_local",
  });
  const second = await TOOL.handler({
    parents,
    content,
    scope: "conversation_local",
    confidence: 0.9,
    conversation_id: "conv-replay",
    confirmation_token: token2,
  });
  assertEnvelopeShape(second, "memory_distill_emit_reconstructed");
  assert.equal(second.ok, true);
  assert.equal(second.data.dedupe_action, "rejected_idempotent");
  assert.equal(
    second.data.memory_event_id,
    firstId,
    "replay returns the prior memory_event_id",
  );

  // Only ONE reconstructed row landed on disk despite two calls.
  const recRows = ledgerLines().filter((r) => r.kind === "reconstructed");
  assert.equal(recRows.length, 1, "only one reconstructed row landed");
});

// -----------------------------------------------------------------------------
// 10. Envelope shape on schema-level rejects (validatePayload)
// -----------------------------------------------------------------------------

test("schema reject: missing confirmation_token throws ToolError(INVALID_ARGUMENTS)", async () => {
  clearLedger();
  // The handler throws ToolError; in real dispatch this is caught and
  // marshaled into the envelope. Here we invoke the handler directly so we
  // assert on the throw.
  await assert.rejects(
    async () =>
      TOOL.handler({
        parents: ["fact_x"],
        content: "x".repeat(50),
        scope: "conversation_local",
        conversation_id: "c1",
      }),
    (err) => {
      assert.equal(err.name, "ToolError");
      assert.equal(err.code, "INVALID_ARGUMENTS");
      assert.match(err.message, /confirmation_token/);
      return true;
    },
  );
});

test("schema reject: unknown args field is rejected by assertObjectShape", async () => {
  clearLedger();
  await assert.rejects(
    async () =>
      TOOL.handler({
        parents: ["fact_x"],
        content: "x".repeat(50),
        scope: "conversation_local",
        conversation_id: "c1",
        confirmation_token: "dummy",
        unexpected_field: "this should be rejected",
      }),
    (err) => {
      assert.equal(err.name, "ToolError");
      assert.equal(err.code, "INVALID_ARGUMENTS");
      assert.match(err.message, /unknown field/);
      return true;
    },
  );
});

test("schema reject: too-short content is rejected before token verification", async () => {
  clearLedger();
  await assert.rejects(
    async () =>
      TOOL.handler({
        parents: ["fact_x"],
        content: "short", // < RECONSTRUCT_CONTENT_MIN_CHARS = 24
        scope: "conversation_local",
        conversation_id: "c1",
        confirmation_token: "dummy",
      }),
    (err) => {
      assert.equal(err.name, "ToolError");
      assert.equal(err.code, "INVALID_ARGUMENTS");
      return true;
    },
  );
});

// -----------------------------------------------------------------------------
// 11. Envelope shape integrity across paths
// -----------------------------------------------------------------------------

test("envelope shape: every successful + every refused path returns the canonical envelope", async () => {
  clearLedger();
  seedFact("fact_envelope_a", "A live fact for envelope-shape sweep.");

  // 11a. Happy path envelope shape.
  const content = "Envelope-sweep summarization to assert ok-envelope structure.";
  const token = mintAgentToken({
    content,
    parents: ["fact_envelope_a"],
    conversation_id: "conv-envelope",
    scope: "conversation_local",
  });
  const okEnv = await TOOL.handler({
    parents: ["fact_envelope_a"],
    content,
    scope: "conversation_local",
    confidence: 0.85,
    conversation_id: "conv-envelope",
    confirmation_token: token,
  });
  assertEnvelopeShape(okEnv, "memory_distill_emit_reconstructed");
  assert.equal(okEnv.ok, true);
  assert.equal(typeof okEnv.data.memory_event_id, "string");
  assert.equal(typeof okEnv.data.dedupe_action, "string");

  // 11b. Token-reject envelope shape.
  const tokenRejectEnv = await TOOL.handler({
    parents: ["fact_envelope_a"],
    content: "Token-reject path envelope shape check (different content).",
    scope: "conversation_local",
    confidence: 0.8,
    conversation_id: "conv-envelope",
    confirmation_token: "garbage.garbage",
  });
  assertEnvelopeShape(tokenRejectEnv, "memory_distill_emit_reconstructed");
  assert.equal(tokenRejectEnv.ok, false);
  assert.equal(tokenRejectEnv.error.code, "PRIVILEGE_REQUIRED");

  // 11c. Structural-reject envelope shape (parent not found).
  const missingParentContent =
    "Structural reject envelope shape check — parent does not exist in ledger.";
  const tok2 = mintAgentToken({
    content: missingParentContent,
    parents: ["fact_does_not_exist_xx"],
    conversation_id: "conv-envelope-missing",
    scope: "conversation_local",
  });
  const structRejectEnv = await TOOL.handler({
    parents: ["fact_does_not_exist_xx"],
    content: missingParentContent,
    scope: "conversation_local",
    confidence: 0.8,
    conversation_id: "conv-envelope-missing",
    confirmation_token: tok2,
  });
  assertEnvelopeShape(structRejectEnv, "memory_distill_emit_reconstructed");
  assert.equal(structRejectEnv.ok, false);
  assert.equal(structRejectEnv.error.code, "NOT_FOUND");
});

// -----------------------------------------------------------------------------
// 12. Excised parent is refused (cross-tier with derivation graph)
// -----------------------------------------------------------------------------

test("excised parent: directly-excised parent is rejected with STATE_CONFLICT (PARENT_EXCISED)", async () => {
  clearLedger();
  seedFact("fact_excised", "Fact that will be excised.");
  // Append a policy excise row directly.
  const exciseRow = {
    id: "policy_excise_fact_excised",
    ts: "2026-05-31T00:30:00Z",
    kind: "policy",
    policy_kind: "excise",
    targets: ["fact_excised"],
    derivation_policy: "drop",
    active_inline: true,
    silent: false,
  };
  appendFileSync(LEDGER_PATH, JSON.stringify(exciseRow) + "\n", { mode: 0o600 });

  const content = "Attempting to reconstruct from a directly-excised parent.";
  const token = mintAgentToken({
    content,
    parents: ["fact_excised"],
    conversation_id: "conv-excised",
    scope: "conversation_local",
  });
  const env = await TOOL.handler({
    parents: ["fact_excised"],
    content,
    scope: "conversation_local",
    confidence: 0.8,
    conversation_id: "conv-excised",
    confirmation_token: token,
  });
  assertEnvelopeShape(env, "memory_distill_emit_reconstructed");
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "STATE_CONFLICT");
  assert.equal(env.error.details.reason, "PARENT_EXCISED");
  assert.equal(env.error.details.dropped, true);
});
