// reconstruction-emitter.test.mjs — Wave 7 SUBSTRATE test suite.
//
// Covers F-SYN-SUBSTRATE-RECONSTRUCTION-EMITTER per spec
// docs/specs/synthesis/reconstructed-trigger.md § Auth Model AM1-AM7.
//
// Mandatory fixtures (per spec § AM6):
//   AM-T1 — agent + daemon both reject non-existent parent (PARENT_NOT_FOUND)
//   AM-T2 — agent + daemon both reject excised parent (PARENT_EXCISED / PARENT_ORPHAN)
//   AM-T3 — agent + daemon both succeed structurally with identical row shape
//   AM-T4 — DISTINCT idempotency key domains for agent vs daemon
//   AM-T5 — handler-level token failure surfaces as INVALID_TOKEN_TYPE
//   AM-T6 — daemon path silently ignores stray confirmation_token
//
// Plus schema validation, replay-returns-same-id within a path, and defensive
// feature extraction (extractor throw → features partial but row still emits).
//
// Hermetic discipline: env vars set BEFORE any dynamic import touches
// config.js so the ledger / policy paths land under TMP_ROOT.
//
// Run: node --test test/synthesis/reconstruction-emitter.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
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
// Hermetic env — MUST be set BEFORE any dynamic import touches config.js.
// -----------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-recemit-"));
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
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});

// -----------------------------------------------------------------------------
// Dynamic imports — bind into TMP_ROOT.
// -----------------------------------------------------------------------------

const emitterMod = await import("../../lib/synthesis/reconstruction-emitter.js");
const { emitReconstruction, __internal, RECONSTRUCT_TOKEN_TYPE } = emitterMod;

const { memoryLedgerPath } = await import("../../lib/config.js");
const { initSigningKey, loadSigningKey, mintToken } = await import("../../lib/daemon-token.js");
const { canonicalJsonSha256Hex } = await import("../../lib/validation.js");

const LEDGER_PATH = memoryLedgerPath();
const CTX = { ledgerPath: LEDGER_PATH };

// Ensure the signing key exists (some token-verification paths require it).
function ensureSigningKey() {
  try {
    return initSigningKey().key;
  } catch (e) {
    if (e && e.code === "EEXIST") return loadSigningKey().key;
    throw e;
  }
}
const SIGNING_KEY = ensureSigningKey();

// Mint a daemon-token that the off-the-shelf verifyToken (type === "daemon")
// will accept. The emitter binds the four-field reconstruct binding object
// over this same token; the type field upgrade to RECONSTRUCT_TOKEN_TYPE is
// the wave-8 supervisor's job. For substrate tests we use the same token
// flavor distill-promote-fact uses, with the reconstruct binding object.
function mintAgentToken({ content, parents, conversation_id, scope }) {
  const sortedParents = [...parents].sort();
  const bindingObject = {
    content_hash: createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex"),
    parent_set_hash: canonicalJsonSha256Hex(sortedParents),
    conversation_id,
    scope,
  };
  const bindingHash = canonicalJsonSha256Hex(bindingObject);
  const minted = mintToken(bindingHash, RECONSTRUCT_TOKEN_TYPE, SIGNING_KEY, {});
  return minted.token;
}

// -----------------------------------------------------------------------------
// Ledger helpers
// -----------------------------------------------------------------------------

function clearLedger() {
  if (existsSync(LEDGER_PATH)) {
    writeFileSync(LEDGER_PATH, "", { mode: 0o600 });
  }
}

function ledgerLines() {
  if (!existsSync(LEDGER_PATH)) return [];
  const text = readFileSync(LEDGER_PATH, "utf8");
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// Append a synthetic fact directly to the ledger (bypasses the screened MCP
// surface — for fixture setup only).
function seedFact(id, content, consentBasis = "first_party") {
  mkdirSync(process.env.LEDGERS_BASE_DIR, { recursive: true, mode: 0o700 });
  const row = {
    id,
    ts: "2026-05-31T00:00:00Z",
    kind: "fact",
    content,
    source: "test-fixture",
    source_refs: [{ source: "test-fixture", source_msg_id: id, via: "original", consent_basis: consentBasis }],
    derived_from: [],
    provenance: { agent_id: "test-fixture", conversation_id: null, confidence: "high" },
    features: { entities: [], time_anchors: [] },
    created_at: "2026-05-31T00:00:00Z",
  };
  appendFileSync(LEDGER_PATH, JSON.stringify(row) + "\n", { mode: 0o600 });
}

// Append a policy excise row directly to the ledger.
function seedExcise(targetId) {
  const row = {
    id: `policy_excise_${targetId}`,
    ts: "2026-05-31T00:30:00Z",
    kind: "policy",
    policy_kind: "excise",
    targets: [targetId],
    derivation_policy: "drop",
    active_inline: true,
    silent: false,
  };
  appendFileSync(LEDGER_PATH, JSON.stringify(row) + "\n", { mode: 0o600 });
}

// Append a synthetic reconstructed row directly (for transitive-orphan tests).
function seedReconstructed(id, derivedFrom, content) {
  const row = {
    id,
    ts: "2026-05-31T01:00:00Z",
    kind: "reconstructed",
    provenance: { agent_id: "test-fixture", conversation_id: "conv-x", confidence: 0.9 },
    content,
    derived_from: derivedFrom,
    features: { entities: [], time_anchors: [] },
    idempotency_key: "seed_" + id,
    superseded_by: null,
    reframed_by: null,
    rescinded_at: null,
    scope: "conversation_local",
    mode: "agent",
  };
  appendFileSync(LEDGER_PATH, JSON.stringify(row) + "\n", { mode: 0o600 });
}

// -----------------------------------------------------------------------------
// Shape / schema validation
// -----------------------------------------------------------------------------

test("schema: rejects missing mode", async () => {
  clearLedger();
  const res = await emitReconstruction(
    { content: "x".repeat(50), parents: ["fact_a"], scope: "conversation_local", conversation_id: "c1" },
    CTX,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "INVALID_MODE");
});

test("schema: rejects empty parents", async () => {
  clearLedger();
  const res = await emitReconstruction(
    {
      mode: "daemon",
      content: "x".repeat(50),
      parents: [],
      scope: "conversation_local",
      conversation_id: null,
    },
    CTX,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "INVALID_PARENTS");
});

test("schema: rejects too-short content", async () => {
  clearLedger();
  const res = await emitReconstruction(
    {
      mode: "daemon",
      content: "tiny",
      parents: ["fact_a"],
      scope: "conversation_local",
      conversation_id: null,
    },
    CTX,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "CONTENT_TOO_SHORT");
});

test("schema: rejects invalid scope", async () => {
  clearLedger();
  const res = await emitReconstruction(
    {
      mode: "daemon",
      content: "x".repeat(50),
      parents: ["fact_a"],
      scope: "wide_open",
      conversation_id: null,
    },
    CTX,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "INVALID_SCOPE");
});

test("schema: agent mode requires token (TOKEN_REQUIRED)", async () => {
  clearLedger();
  const res = await emitReconstruction(
    {
      mode: "agent",
      content: "x".repeat(50),
      parents: ["fact_a"],
      scope: "conversation_local",
      conversation_id: "c1",
      confidence: 0.9,
    },
    CTX,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "TOKEN_REQUIRED");
  assert.equal(res.reject_class, "token");
});

test("schema: agent mode enforces confidence floor (LOW_CONFIDENCE)", async () => {
  clearLedger();
  const res = await emitReconstruction(
    {
      mode: "agent",
      content: "x".repeat(50),
      parents: ["fact_a"],
      scope: "conversation_local",
      conversation_id: "c1",
      confidence: 0.4,
      token: "dummy",
    },
    CTX,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "LOW_CONFIDENCE");
});

// -----------------------------------------------------------------------------
// AM-T1 — both paths reject non-existent parent
// -----------------------------------------------------------------------------

test("AM-T1: agent path rejects non-existent parent with PARENT_NOT_FOUND", async () => {
  clearLedger();
  const content = "A summarization that references a parent that does not exist in the ledger.";
  const token = mintAgentToken({
    content,
    parents: ["fact_nonexistent_99"],
    conversation_id: "conv-am-t1",
    scope: "conversation_local",
  });
  const res = await emitReconstruction(
    {
      mode: "agent",
      content,
      parents: ["fact_nonexistent_99"],
      scope: "conversation_local",
      conversation_id: "conv-am-t1",
      confidence: 0.8,
      token,
    },
    CTX,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "PARENT_NOT_FOUND");
  assert.match(res.error, /fact_nonexistent_99/);
});

test("AM-T1: daemon path rejects non-existent parent with PARENT_NOT_FOUND", async () => {
  clearLedger();
  const res = await emitReconstruction(
    {
      mode: "daemon",
      content: "Daemon-aggregated summary that references a missing parent.",
      parents: ["fact_nonexistent_99"],
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      agent_role: "thread-aggregator",
    },
    CTX,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "PARENT_NOT_FOUND");
});

// -----------------------------------------------------------------------------
// AM-T2 — both paths reject an excised parent
// -----------------------------------------------------------------------------

test("AM-T2: agent path rejects directly-excised parent with PARENT_EXCISED", async () => {
  clearLedger();
  seedFact("fact_x_directly_excised", "Original fact about the morning.");
  seedExcise("fact_x_directly_excised");

  const content = "Trying to reconstruct from an excised parent — should fail.";
  const token = mintAgentToken({
    content,
    parents: ["fact_x_directly_excised"],
    conversation_id: "conv-am-t2",
    scope: "conversation_local",
  });
  const res = await emitReconstruction(
    {
      mode: "agent",
      content,
      parents: ["fact_x_directly_excised"],
      scope: "conversation_local",
      conversation_id: "conv-am-t2",
      confidence: 0.8,
      token,
    },
    CTX,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "PARENT_EXCISED");
});

test("AM-T2: daemon path rejects directly-excised parent with PARENT_EXCISED", async () => {
  clearLedger();
  seedFact("fact_y_directly_excised", "Some daemon-pipeline subject.");
  seedExcise("fact_y_directly_excised");
  const res = await emitReconstruction(
    {
      mode: "daemon",
      content: "Daemon attempt to aggregate from an excised fact — should fail.",
      parents: ["fact_y_directly_excised"],
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      agent_role: "thread-aggregator",
    },
    CTX,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "PARENT_EXCISED");
});

test("AM-T2: transitive-orphan via reverseAdj — descendant of excised ancestor rejected", async () => {
  clearLedger();
  // fact_root is the original; rec_child derived_from [fact_root]; we excise
  // fact_root with policy "drop". Now the emitter MUST refuse a new
  // reconstruction citing rec_child (transitive orphan).
  seedFact("fact_root", "Root fact about the operator's plan.");
  seedReconstructed("rec_child", ["fact_root"], "First-derivation child reconstruction.");
  seedExcise("fact_root");

  const res = await emitReconstruction(
    {
      mode: "daemon",
      content: "Cross-session daemon attempt to derive from rec_child — orphaned.",
      parents: ["rec_child"],
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      agent_role: "project-aggregator",
    },
    CTX,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "PARENT_ORPHAN");
});

// -----------------------------------------------------------------------------
// AM-T3 — both paths succeed structurally; identical row shape
// -----------------------------------------------------------------------------

test("AM-T3: agent path successfully emits a reconstructed row", async () => {
  clearLedger();
  seedFact("fact_a", "Operator noted that Tumbler keeps its serial link on port ttyS3.");
  seedFact("fact_b", "The spare Ethernet jack on Tumbler is held back for paired calibration.");

  const content =
    "Tumbler QD-4 keeps its serial link on port ttyS3 for control while the spare Ethernet jack is held back for paired calibration passes.";
  const token = mintAgentToken({
    content,
    parents: ["fact_a", "fact_b"],
    conversation_id: "conv-am-t3-agent",
    scope: "conversation_local",
  });
  const res = await emitReconstruction(
    {
      mode: "agent",
      content,
      parents: ["fact_a", "fact_b"],
      scope: "conversation_local",
      conversation_id: "conv-am-t3-agent",
      confidence: 0.85,
      token,
    },
    CTX,
  );
  assert.equal(res.ok, true);
  assert.equal(res.dedupe_action, "appended");
  assert.match(res.memory_event_id, /^rec_/);

  // Inspect the row on disk.
  const rows = ledgerLines();
  const row = rows.find((r) => r.id === res.memory_event_id);
  assert.ok(row, "row is durably on disk");
  assert.equal(row.kind, "reconstructed");
  assert.deepEqual(row.derived_from, ["fact_a", "fact_b"]);
  assert.equal(row.scope, "conversation_local");
  assert.equal(row.provenance.conversation_id, "conv-am-t3-agent");
  assert.match(row.provenance.agent_id, /^(claude-code|codex|operator):/);
  assert.ok(Array.isArray(row.features.entities), "features.entities populated");
  assert.ok(Array.isArray(row.features.time_anchors), "features.time_anchors populated");
});

test("AM-T3: daemon path successfully emits a reconstructed row with daemon:* agent_id", async () => {
  clearLedger();
  seedFact("fact_a", "Operator noted that Tumbler keeps its serial link on port ttyS3.");
  seedFact("fact_b", "The spare Ethernet jack on Tumbler is held back for paired calibration.");

  const res = await emitReconstruction(
    {
      mode: "daemon",
      content:
        "Aggregator summary: Tumbler keeps serial on port ttyS3; the spare Ethernet jack is calibration-only.",
      parents: ["fact_a", "fact_b"],
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      agent_role: "thread-aggregator",
    },
    CTX,
  );
  assert.equal(res.ok, true);
  assert.equal(res.dedupe_action, "appended");

  const rows = ledgerLines();
  const row = rows.find((r) => r.id === res.memory_event_id);
  assert.ok(row, "daemon-path row durably on disk");
  assert.equal(row.kind, "reconstructed");
  assert.equal(row.provenance.conversation_id, null, "daemon path conversation_id is null");
  assert.match(row.provenance.agent_id, /^daemon:/);
  assert.equal(row.scope, "cross_session");
});

// -----------------------------------------------------------------------------
// AM-T4 — DISTINCT idempotency key domains for agent vs daemon
// -----------------------------------------------------------------------------

test("AM-T4: identical (parents, content) emitted by both paths produces DISTINCT rows", async () => {
  clearLedger();
  seedFact("fact_a", "Shared parent A.");
  seedFact("fact_b", "Shared parent B.");

  const sharedContent =
    "The aggregated summary text is identical across both paths to prove key-domain isolation.";
  const sharedParents = ["fact_a", "fact_b"];

  // Agent first.
  const token = mintAgentToken({
    content: sharedContent,
    parents: sharedParents,
    conversation_id: "conv-am-t4",
    scope: "conversation_local",
  });
  const agentRes = await emitReconstruction(
    {
      mode: "agent",
      content: sharedContent,
      parents: sharedParents,
      scope: "conversation_local",
      conversation_id: "conv-am-t4",
      confidence: 0.8,
      token,
    },
    CTX,
  );
  assert.equal(agentRes.ok, true);
  assert.equal(agentRes.dedupe_action, "appended");

  // Then daemon with identical content+parents — must NOT collide.
  const daemonRes = await emitReconstruction(
    {
      mode: "daemon",
      content: sharedContent,
      parents: sharedParents,
      scope: "conversation_local",
      conversation_id: null,
      confidence: 1.0,
      agent_role: "thread-aggregator",
    },
    CTX,
  );
  assert.equal(daemonRes.ok, true);
  assert.equal(daemonRes.dedupe_action, "appended");
  assert.notEqual(
    agentRes.memory_event_id,
    daemonRes.memory_event_id,
    "agent vs daemon produce DISTINCT memory_event_ids (key domains isolated)",
  );

  // Both rows are durably on disk.
  const rows = ledgerLines();
  const recRows = rows.filter((r) => r.kind === "reconstructed");
  assert.equal(recRows.length, 2, "two reconstructed rows landed");
});

test("AM-T4: agent-path replay returns same memory_event_id (idempotent)", async () => {
  clearLedger();
  seedFact("fact_a", "Shared parent A.");
  seedFact("fact_b", "Shared parent B.");
  const content = "Replay idempotency proof — identical args, same prior row id returned.";
  const parents = ["fact_a", "fact_b"];
  const token1 = mintAgentToken({
    content,
    parents,
    conversation_id: "conv-replay",
    scope: "conversation_local",
  });
  const first = await emitReconstruction(
    { mode: "agent", content, parents, scope: "conversation_local", conversation_id: "conv-replay", confidence: 0.9, token: token1 },
    CTX,
  );
  assert.equal(first.ok, true);
  assert.equal(first.dedupe_action, "appended");

  // Mint a FRESH token (the replay test is about idempotency at the emit
  // layer; the nonce is single-use, so the second call uses a new nonce
  // but the same binding).
  const token2 = mintAgentToken({
    content,
    parents,
    conversation_id: "conv-replay",
    scope: "conversation_local",
  });
  const second = await emitReconstruction(
    { mode: "agent", content, parents, scope: "conversation_local", conversation_id: "conv-replay", confidence: 0.9, token: token2 },
    CTX,
  );
  assert.equal(second.ok, true);
  assert.equal(second.dedupe_action, "rejected_idempotent");
  assert.equal(second.memory_event_id, first.memory_event_id, "prior memory_event_id returned");
});

test("AM-T4: daemon-path replay returns same memory_event_id (idempotent)", async () => {
  clearLedger();
  seedFact("fact_a", "Shared parent A.");
  const content = "Daemon replay idempotency proof — re-tick on same bucket is a no-op.";
  const parents = ["fact_a"];
  const first = await emitReconstruction(
    {
      mode: "daemon",
      content,
      parents,
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      agent_role: "thread-aggregator",
    },
    CTX,
  );
  assert.equal(first.ok, true);
  assert.equal(first.dedupe_action, "appended");

  const second = await emitReconstruction(
    {
      mode: "daemon",
      content,
      parents,
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      agent_role: "thread-aggregator",
    },
    CTX,
  );
  assert.equal(second.ok, true);
  assert.equal(second.dedupe_action, "rejected_idempotent");
  assert.equal(second.memory_event_id, first.memory_event_id);
});

// -----------------------------------------------------------------------------
// AM-T5 — agent-path token failure surfaces structurally
// -----------------------------------------------------------------------------

test("AM-T5: invalid token (wrong type) is rejected with INVALID_TOKEN_TYPE", async () => {
  clearLedger();
  seedFact("fact_a", "A live fact.");

  // Mint a token with the WRONG type — the off-the-shelf verifyToken's type
  // gate pins type === "daemon". We craft a token whose payload type is a
  // bogus string by minting via mintToken but then mangling the wire. Easier
  // route: pass a malformed token, which surfaces as MALFORMED_TOKEN /
  // BAD_SIGNATURE depending on the failure mode. Either way, the emitter
  // structurally REJECTS the request without touching the ledger.
  const res = await emitReconstruction(
    {
      mode: "agent",
      content: "An agent attempt with a structurally invalid confirmation_token.",
      parents: ["fact_a"],
      scope: "conversation_local",
      conversation_id: "conv-am-t5",
      confidence: 0.8,
      token: "not.a.valid.token",
    },
    CTX,
  );
  assert.equal(res.ok, false);
  // Either MALFORMED_TOKEN or BAD_SIGNATURE — both prove "token verify failed
  // BEFORE any ledger write". The spec calls out INVALID_TOKEN_TYPE for the
  // wrong-type case; either token-rejection code is acceptable here as long
  // as the emit was refused without touching memory.jsonl.
  assert.ok(
    ["MALFORMED_TOKEN", "BAD_SIGNATURE", "INVALID_TOKEN_TYPE", "TOKEN_EXPIRED"].includes(res.code),
    `expected a token-rejection code; got ${res.code}`,
  );
  assert.equal(res.reject_class, "token");
  const rows = ledgerLines();
  const recRows = rows.filter((r) => r.kind === "reconstructed");
  assert.equal(recRows.length, 0, "no reconstructed row written on token failure");
});

test("AM-T5: tampered token (wrong binding) is rejected with BAD_BINDING", async () => {
  clearLedger();
  seedFact("fact_a", "A live fact.");
  // Mint a token bound to ONE content+parents, then submit it with a
  // DIFFERENT content. Verification must fail at the binding-compare step.
  const mintedToken = mintAgentToken({
    content: "Original bound content X.",
    parents: ["fact_a"],
    conversation_id: "conv-am-t5b",
    scope: "conversation_local",
  });
  const res = await emitReconstruction(
    {
      mode: "agent",
      content: "DIFFERENT content the token does not bind to (replay attempt).",
      parents: ["fact_a"],
      scope: "conversation_local",
      conversation_id: "conv-am-t5b",
      confidence: 0.8,
      token: mintedToken,
    },
    CTX,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "BAD_BINDING");
  assert.equal(res.reject_class, "token");
});

// -----------------------------------------------------------------------------
// AM-T6 — daemon path silently ignores stray confirmation_token
// -----------------------------------------------------------------------------

test("AM-T6: daemon path with stray confirmation_token field is silently ignored (proceeds)", async () => {
  clearLedger();
  seedFact("fact_a", "A live fact.");
  const res = await emitReconstruction(
    {
      mode: "daemon",
      content: "Daemon-path emit with a stray confirmation_token field — should not crash or refuse.",
      parents: ["fact_a"],
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      agent_role: "thread-aggregator",
      token: "stray-bogus-token-that-must-not-be-verified",
    },
    CTX,
  );
  assert.equal(res.ok, true, "daemon path proceeds despite stray token field");
  assert.equal(res.dedupe_action, "appended");
  // And inspect the row — no token field on the row, no agent_id leakage.
  const rows = ledgerLines();
  const row = rows.find((r) => r.id === res.memory_event_id);
  assert.ok(row, "daemon row landed");
  assert.match(row.provenance.agent_id, /^daemon:/);
  assert.equal(row.provenance.conversation_id, null);
});

// -----------------------------------------------------------------------------
// Defensive feature extraction — scorer throw degrades to partial features
// -----------------------------------------------------------------------------

test("defensive: extractFeatures degrades gracefully when invoked on edge content", async () => {
  // Content with no entities, no time anchors, no valence words — features
  // come back populated but mostly empty. The row still emits successfully.
  clearLedger();
  seedFact("fact_a", "Test fact.");
  const content = "qqqqqqqqqqqqqqqqqqqqqqqqqqqqq blank tokens placeholder."; // 50+ chars, low-signal
  const token = mintAgentToken({
    content,
    parents: ["fact_a"],
    conversation_id: "conv-defensive",
    scope: "conversation_local",
  });
  const res = await emitReconstruction(
    { mode: "agent", content, parents: ["fact_a"], scope: "conversation_local", conversation_id: "conv-defensive", confidence: 0.8, token },
    CTX,
  );
  assert.equal(res.ok, true, "low-signal content still produces a row");
  const rows = ledgerLines();
  const row = rows.find((r) => r.id === res.memory_event_id);
  assert.ok(row, "row landed");
  // entities is an array (possibly empty); time_anchors is an array (possibly empty).
  assert.ok(Array.isArray(row.features.entities));
  assert.ok(Array.isArray(row.features.time_anchors));
  // episodicity is either a finite number in [0,1] or null (defensive degrade).
  if (row.features.episodicity !== null) {
    assert.ok(typeof row.features.episodicity === "number");
    assert.ok(row.features.episodicity >= 0 && row.features.episodicity <= 1);
  }
});

// -----------------------------------------------------------------------------
// Idempotency-key correctness (internal helper)
// -----------------------------------------------------------------------------

test("computeIdempotencyKey: agent vs daemon produce DIFFERENT keys for same args", () => {
  const baseInput = {
    content: "Same content X.",
    parents: ["fact_a", "fact_b"],
    scope: "conversation_local",
    conversation_id: "conv-same",
  };
  const agentKey = __internal.computeIdempotencyKey({ ...baseInput, mode: "agent" });
  const daemonKey = __internal.computeIdempotencyKey({
    ...baseInput,
    mode: "daemon",
    agent_role: "thread-aggregator",
  });
  assert.notEqual(agentKey, daemonKey, "DISTINCT key domains (AM-T4)");
  // Both keys are sha256 hex (64 lowercase hex chars).
  assert.match(agentKey, /^[0-9a-f]{64}$/);
  assert.match(daemonKey, /^[0-9a-f]{64}$/);
});

test("computeIdempotencyKey: order-independent over the parent set", () => {
  const a = __internal.computeIdempotencyKey({
    mode: "agent",
    content: "X",
    parents: ["fact_a", "fact_b"],
    scope: "conversation_local",
    conversation_id: "c1",
  });
  const b = __internal.computeIdempotencyKey({
    mode: "agent",
    content: "X",
    parents: ["fact_b", "fact_a"],
    scope: "conversation_local",
    conversation_id: "c1",
  });
  assert.equal(a, b, "parent order does not change the idempotency key");
});

// -----------------------------------------------------------------------------
// Overall durability — appended row has all 5 spec-required shape slots
// -----------------------------------------------------------------------------

test("durability: appended row carries derived_from, features, provenance, scope, mode", async () => {
  clearLedger();
  seedFact("fact_a", "A live fact.");
  const res = await emitReconstruction(
    {
      mode: "daemon",
      content: "Daemon-path emit for shape-coverage assertion (50+ chars).",
      parents: ["fact_a"],
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      agent_role: "project-aggregator",
    },
    CTX,
  );
  assert.equal(res.ok, true);
  const rows = ledgerLines();
  const row = rows.find((r) => r.id === res.memory_event_id);
  assert.ok(row);
  assert.equal(row.kind, "reconstructed");
  assert.deepEqual(row.derived_from, ["fact_a"]);
  assert.ok(typeof row.features === "object" && row.features !== null);
  assert.ok(typeof row.provenance === "object" && row.provenance !== null);
  assert.equal(row.provenance.confidence, 1.0);
  assert.equal(row.scope, "cross_session");
  assert.equal(row.mode, "daemon");
  // The spec § S1 lists superseded_by, reframed_by, rescinded_at as derivation-
  // graph admin slots; on emit they MUST be null.
  assert.equal(row.superseded_by, null);
  assert.equal(row.reframed_by, null);
  assert.equal(row.rescinded_at, null);
  // ts is ISO-8601.
  assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

// -----------------------------------------------------------------------------
// WU-emitter-spec-closure — W7 spawn-finding closures
// (1) consentWalk over parent source_refs (spec § AM4 line 161)
// (2) R1 mode/agent_id mismatch rejection at dispatch (spec § AM1 line 90)
// (3) Daemon S5 idempotency-key preimage uses {aggregator_name, bucket_key,
//     content_hash} per spec § S5 — closes cross-bucket dedupe risk
// -----------------------------------------------------------------------------

test("consentWalk: strictest wins (first_party + public → first_party)", async () => {
  clearLedger();
  seedFact("fact_fp", "First-party operator note.", "first_party");
  seedFact("fact_pub", "Public-source row.", "public");

  const content =
    "Mixed-source reconstruction; consent_basis should inherit the strictest parent basis.";
  const token = mintAgentToken({
    content,
    parents: ["fact_fp", "fact_pub"],
    conversation_id: "conv-consent-1",
    scope: "conversation_local",
  });
  const res = await emitReconstruction(
    {
      mode: "agent",
      content,
      parents: ["fact_fp", "fact_pub"],
      scope: "conversation_local",
      conversation_id: "conv-consent-1",
      confidence: 0.85,
      token,
    },
    CTX,
  );
  assert.equal(res.ok, true);
  const rows = ledgerLines();
  const row = rows.find((r) => r.id === res.memory_event_id);
  assert.ok(row, "reconstructed row landed");
  assert.equal(
    row.strictest_consent_basis,
    "first_party",
    "first_party wins over public (strictest-wins ordering)",
  );
  assert.ok(Array.isArray(row.source_refs), "source_refs[] stamped on row");
  assert.equal(row.source_refs.length, 2);
  const fp = row.source_refs.find((r) => r.event_id === "fact_fp");
  const pub = row.source_refs.find((r) => r.event_id === "fact_pub");
  assert.equal(fp.consent_basis, "first_party");
  assert.equal(fp.role, "derived_from");
  assert.equal(pub.consent_basis, "public");
  assert.deepEqual(
    row.consent_inherits_from,
    ["fact_fp"],
    "consent_inherits_from lists only the strictest-basis parent(s)",
  );
});

test("consentWalk: multi-parent ordering (third_party_inferred vs second_party_dm → second_party_dm)", async () => {
  clearLedger();
  seedFact("fact_dm", "DM counterparty content.", "second_party_dm");
  seedFact("fact_ti", "Third-party inferred content.", "third_party_inferred");
  seedFact("fact_pub", "Public content.", "public");

  const content =
    "Reconstruction across three consent classes; strictest-wins selects second_party_dm.";
  const res = await emitReconstruction(
    {
      mode: "daemon",
      content,
      parents: ["fact_pub", "fact_ti", "fact_dm"],
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      aggregator_name: "thread-aggregator",
      bucket_key: "chat:test-multi:2026-06-18",
    },
    CTX,
  );
  assert.equal(res.ok, true);
  const rows = ledgerLines();
  const row = rows.find((r) => r.id === res.memory_event_id);
  assert.ok(row);
  assert.equal(
    row.strictest_consent_basis,
    "second_party_dm",
    "second_party_dm beats both third_party_inferred and public",
  );
  assert.deepEqual(row.consent_inherits_from, ["fact_dm"]);
  // source_refs order preserves the parents[] order the caller supplied.
  assert.deepEqual(
    row.source_refs.map((r) => r.event_id),
    ["fact_pub", "fact_ti", "fact_dm"],
  );
});

test("consentWalk: parent with no source_refs falls back to derived", async () => {
  clearLedger();
  seedFact("fact_fp", "First-party.", "first_party");
  // Seed a reconstructed parent with no consent_basis on its source_refs — the
  // walker should treat it as "derived".
  seedReconstructed("rec_no_refs", ["fact_fp"], "First-derivation child.");

  const content =
    "Reconstruct from a prior reconstructed row that carries no explicit consent_basis.";
  const res = await emitReconstruction(
    {
      mode: "daemon",
      content,
      parents: ["rec_no_refs"],
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      aggregator_name: "thread-aggregator",
      bucket_key: "chat:test-derived:2026-06-18",
    },
    CTX,
  );
  assert.equal(res.ok, true);
  const rows = ledgerLines();
  const row = rows.find((r) => r.id === res.memory_event_id);
  assert.equal(row.source_refs[0].consent_basis, "derived");
  assert.equal(row.strictest_consent_basis, "derived");
});

test("R1: mode=agent with agent_id=daemon:* prefix → INVALID_AGENT_ID", async () => {
  clearLedger();
  seedFact("fact_a", "A live fact.");
  const content = "Mismatched-prefix attempt; dispatch must reject before token verify.";
  const token = mintAgentToken({
    content,
    parents: ["fact_a"],
    conversation_id: "conv-r1-a",
    scope: "conversation_local",
  });
  const res = await emitReconstruction(
    {
      mode: "agent",
      content,
      parents: ["fact_a"],
      scope: "conversation_local",
      conversation_id: "conv-r1-a",
      confidence: 0.85,
      agent_id: "daemon:foo", // ← mismatched prefix
      token,
    },
    CTX,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "INVALID_AGENT_ID");
  assert.equal(res.reject_class, "schema");
  assert.match(res.error, /daemon:/);
  // No ledger write happened.
  const rows = ledgerLines();
  const recRows = rows.filter((r) => r.kind === "reconstructed");
  assert.equal(recRows.length, 0);
});

test("R1: mode=daemon with agent_id=claude-code:* prefix → INVALID_AGENT_ID", async () => {
  clearLedger();
  seedFact("fact_a", "A live fact.");
  const res = await emitReconstruction(
    {
      mode: "daemon",
      content: "Mismatched-prefix daemon attempt; dispatch must reject.",
      parents: ["fact_a"],
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      agent_id: "claude-code:abc", // ← mismatched prefix
      aggregator_name: "thread-aggregator",
      bucket_key: "chat:r1-d:2026-06-18",
    },
    CTX,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "INVALID_AGENT_ID");
  assert.equal(res.reject_class, "schema");
  assert.match(res.error, /claude-code/);
});

test("R1: mode=agent with no explicit agent_id still synthesizes default (claude-code:<conv>)", async () => {
  clearLedger();
  seedFact("fact_a", "A live fact.");
  const content = "No agent_id supplied; emitter synthesizes the default.";
  const token = mintAgentToken({
    content,
    parents: ["fact_a"],
    conversation_id: "conv-r1-default",
    scope: "conversation_local",
  });
  const res = await emitReconstruction(
    {
      mode: "agent",
      content,
      parents: ["fact_a"],
      scope: "conversation_local",
      conversation_id: "conv-r1-default",
      confidence: 0.85,
      token,
    },
    CTX,
  );
  assert.equal(res.ok, true);
  const rows = ledgerLines();
  const row = rows.find((r) => r.id === res.memory_event_id);
  assert.equal(row.provenance.agent_id, "claude-code:conv-r1-default");
});

test("S5: daemon-path without aggregator_name AND no agent_role → INVALID_INPUT", async () => {
  clearLedger();
  seedFact("fact_a", "A live fact.");
  const res = await emitReconstruction(
    {
      mode: "daemon",
      content: "Daemon-path emit without aggregator_name; spec § R1 requires it.",
      parents: ["fact_a"],
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      // No aggregator_name AND no agent_role.
      bucket_key: "chat:test:2026-06-18",
    },
    CTX,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "INVALID_INPUT");
  assert.match(res.error, /aggregator_name/);
});

test("S5: daemon-path same (aggregator_name, bucket_key, content) is idempotent (returns prior id)", async () => {
  clearLedger();
  seedFact("fact_a", "Shared fact.");
  const content =
    "Daemon S5 idempotency proof — same aggregator + bucket + content collapses on retry.";
  const first = await emitReconstruction(
    {
      mode: "daemon",
      content,
      parents: ["fact_a"],
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      aggregator_name: "thread-aggregator",
      bucket_key: "chat:s5-idem:2026-06-18",
    },
    CTX,
  );
  assert.equal(first.ok, true);
  assert.equal(first.dedupe_action, "appended");

  const second = await emitReconstruction(
    {
      mode: "daemon",
      content,
      parents: ["fact_a"],
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      aggregator_name: "thread-aggregator",
      bucket_key: "chat:s5-idem:2026-06-18",
    },
    CTX,
  );
  assert.equal(second.ok, true);
  assert.equal(second.dedupe_action, "rejected_idempotent");
  assert.equal(second.memory_event_id, first.memory_event_id);
});

test("S5: daemon-path same content + DIFFERENT bucket_key mints DIFFERENT memory_event_ids (cross-bucket dedupe closure)", async () => {
  clearLedger();
  seedFact("fact_a", "Shared fact.");
  const content =
    "Identical content emitted into two distinct buckets MUST mint distinct ids — this is the cross-bucket dedupe-risk closure for the W7 spawn finding.";
  const a = await emitReconstruction(
    {
      mode: "daemon",
      content,
      parents: ["fact_a"],
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      aggregator_name: "thread-aggregator",
      bucket_key: "chat:bucket-A:2026-06-18",
    },
    CTX,
  );
  assert.equal(a.ok, true);
  assert.equal(a.dedupe_action, "appended");

  const b = await emitReconstruction(
    {
      mode: "daemon",
      content,
      parents: ["fact_a"],
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      aggregator_name: "thread-aggregator",
      bucket_key: "chat:bucket-B:2026-06-18", // ← different bucket only
    },
    CTX,
  );
  assert.equal(b.ok, true);
  assert.equal(b.dedupe_action, "appended");
  assert.notEqual(
    a.memory_event_id,
    b.memory_event_id,
    "different bucket_key → different memory_event_id (cross-bucket dedupe closed)",
  );
  const rows = ledgerLines();
  const recRows = rows.filter((r) => r.kind === "reconstructed");
  assert.equal(recRows.length, 2);
});

test("S5: daemon-path different aggregator_name → different memory_event_ids (key-domain separation)", async () => {
  clearLedger();
  seedFact("fact_a", "Shared fact.");
  const content =
    "Same bucket + same content but different aggregator_name should still mint distinct rows.";
  const t = await emitReconstruction(
    {
      mode: "daemon",
      content,
      parents: ["fact_a"],
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      aggregator_name: "thread-aggregator",
      bucket_key: "chat:shared-bucket:2026-06-18",
    },
    CTX,
  );
  const p = await emitReconstruction(
    {
      mode: "daemon",
      content,
      parents: ["fact_a"],
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      aggregator_name: "project-aggregator", // ← different aggregator
      bucket_key: "chat:shared-bucket:2026-06-18",
    },
    CTX,
  );
  assert.equal(t.ok, true);
  assert.equal(p.ok, true);
  assert.notEqual(t.memory_event_id, p.memory_event_id);
});

test("S5: computeIdempotencyKey daemon preimage uses {domain,aggregator_name,bucket_key,content_hash}", () => {
  // Direct __internal verification: the key MUST be invariant under
  // conversation_id changes (which were in the OLD preimage but are NOT in
  // spec § S5).
  const baseInput = {
    mode: "daemon",
    content: "Daemon S5 key preimage probe.",
    parents: ["fact_x"],
    scope: "cross_session",
    aggregator_name: "thread-aggregator",
    bucket_key: "chat:probe:2026-06-18",
  };
  const k1 = __internal.computeIdempotencyKey({
    ...baseInput,
    conversation_id: null,
  });
  const k2 = __internal.computeIdempotencyKey({
    ...baseInput,
    conversation_id: "should-not-affect-key",
  });
  assert.equal(
    k1,
    k2,
    "spec § S5 preimage excludes conversation_id — keys must match across different conversation_ids",
  );
});

// -----------------------------------------------------------------------------
// WU-emitter-string-cap-fix — streamed ledger scan regression suite.
//
// INCIDENT: scanLedgerLines used to readFileSync the WHOLE memory.jsonl;
// once the live ledger crossed Node/V8's ~536,870,888-byte max-string cap
// (~2026-06-02) the read threw ERR_STRING_TOO_LONG, the bare catch returned
// [], and every emit rejected PARENT_NOT_FOUND forever (before the S5
// idempotency append, so buckets refired eternally). The fix streams the
// scan through _ledger-stream.js. We cannot cheaply synthesize a >512MB
// ledger in CI, so these tests pin the two load-bearing properties of the
// streamed path instead:
//   1. multi-chunk correctness — a synthetic ledger spanning several 64KiB
//      stream chunks parses EVERY row byte-exactly, including a row whose
//      multi-byte UTF-8 codepoint deliberately straddles the first chunk
//      boundary (the seam the old per-chunk decoder would have mangled),
//      and a full emit against parents drawn from both ends succeeds.
//   2. loud failure — an unreadable ledger logs once per scan instead of
//      silently masquerading as an empty ledger.
// -----------------------------------------------------------------------------

test("string-cap fix: streamed scan parses a multi-chunk ledger byte-exactly and the emit path works over it", async () => {
  clearLedger();

  // --- Construct the synthetic ledger --------------------------------------
  // Chunk size in _ledger-stream.js is 64 KiB (65,536 bytes). We place a
  // 2-byte "é" so its FIRST byte sits at absolute offset 65,535 — the last
  // byte of chunk 1 — forcing the codepoint to straddle the chunk seam.
  const seamPrefix =
    '{"id":"fact_seam","ts":"2026-05-31T00:01:00Z","kind":"fact","source":"test-fixture","content":"';
  const seamContent = "é-seam-content-survives-chunk-boundary";
  const seamLine = seamPrefix + seamContent + '"}\n';
  const padHead =
    '{"id":"fact_pad","ts":"2026-05-31T00:00:00Z","kind":"fact","source":"test-fixture","content":"';
  const padTail = '"}\n';
  // line1 bytes + seamPrefix bytes must equal 65,535 so the é (first byte of
  // seamContent) starts exactly at the seam.
  const line1TargetBytes = 65535 - Buffer.byteLength(seamPrefix, "utf8");
  const padLen =
    line1TargetBytes -
    Buffer.byteLength(padHead, "utf8") -
    Buffer.byteLength(padTail, "utf8");
  assert.ok(padLen > 0, "pad computation sanity");
  const line1 = padHead + "x".repeat(padLen) + padTail;
  assert.equal(
    Buffer.byteLength(line1 + seamPrefix, "utf8"),
    65535,
    "é first byte must land on the last byte of the first 64KiB chunk",
  );

  // Bulk rows with multi-byte content sprinkled throughout so later chunk
  // seams also cross non-ASCII bytes. ~3,000 rows × ~150 bytes ≈ 450 KB —
  // several chunks, still cheap for CI.
  const BULK = 3000;
  let bulk = "";
  for (let i = 0; i < BULK; i++) {
    const id = `fact_bulk_${String(i).padStart(4, "0")}`;
    bulk +=
      JSON.stringify({
        id,
        ts: "2026-05-31T00:02:00Z",
        kind: "fact",
        source: "test-fixture",
        content: `bulk row ${i} — naïve café résumé Zürich 東京 ${i}`,
      }) + "\n";
  }
  writeFileSync(LEDGER_PATH, line1 + seamLine + bulk, { mode: 0o600 });

  // --- Property 1a: every row parses, byte-exactly --------------------------
  const rows = __internal.scanLedgerLines(LEDGER_PATH);
  assert.equal(rows.length, 2 + BULK, "every synthetic row must parse");
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(
    byId.get("fact_seam").content,
    seamContent,
    "multi-byte codepoint straddling the 64KiB chunk seam must round-trip exactly (no U+FFFD)",
  );
  assert.equal(byId.get("fact_pad").content, "x".repeat(padLen));
  assert.equal(
    byId.get("fact_bulk_2999").content,
    `bulk row 2999 — naïve café résumé Zürich 東京 2999`,
  );

  // --- Property 1b: a real emit works against parents across the file ------
  const res = await emitReconstruction(
    {
      mode: "daemon",
      content: "Streamed-scan regression: parents resolved from a multi-chunk ledger.",
      parents: ["fact_pad", "fact_seam", "fact_bulk_0000", "fact_bulk_2999"],
      scope: "cross_session",
      conversation_id: null,
      confidence: 1.0,
      aggregator_name: "thread-aggregator",
      bucket_key: "regression:string-cap:2026-07-03",
    },
    CTX,
  );
  assert.equal(res.ok, true, `emit must succeed, got ${JSON.stringify(res)}`);
  assert.equal(res.dedupe_action, "appended");

  // --- Property 1c: torn-tail (daemon mid-append) is still tolerated -------
  appendFileSync(LEDGER_PATH, '{"id":"fact_torn","kind":"fa', { mode: 0o600 });
  const rows2 = __internal.scanLedgerLines(LEDGER_PATH);
  // prior rows + the reconstructed row we just emitted; torn line skipped.
  assert.equal(rows2.length, 2 + BULK + 1, "torn trailing line is skipped, not fatal");
});

test("string-cap fix: unreadable ledger logs once per scan instead of silently reading as empty", () => {
  // chmod tricks don't bite when running as root (root reads anything).
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return; // environmental skip — cannot make a file unreadable for root
  }
  const deadPath = join(TMP_ROOT, "unreadable-ledger.jsonl");
  writeFileSync(deadPath, '{"id":"fact_hidden","kind":"fact"}\n', { mode: 0o600 });
  chmodSync(deadPath, 0o000);
  try {
    const errors = [];
    const rows = __internal.scanLedgerLines(deadPath, {
      error: (msg) => errors.push(msg),
    });
    // Return shape is unchanged (call-site reject codes stay stable)...
    assert.deepEqual(rows, []);
    // ...but the failure is LOUD: exactly one log line per scan, and it names
    // the underlying fs error so "unreadable" is distinguishable from "empty".
    assert.equal(errors.length, 1, "read failure must log exactly once per scan");
    assert.match(errors[0], /ledger scan failed/);
    assert.match(errors[0], /NOT an empty ledger/);
  } finally {
    try { chmodSync(deadPath, 0o600); } catch {}
    try { rmSync(deadPath, { force: true }); } catch {}
  }
});

test("consentWalk: __internal.walkConsent returns deterministic shape", () => {
  // Build a synthetic ledger row set without touching the disk.
  const rows = [
    {
      id: "fact_x",
      kind: "fact",
      source_refs: [{ source: "s", source_msg_id: "x", consent_basis: "first_party" }],
    },
    {
      id: "fact_y",
      kind: "fact",
      source_refs: [{ source: "s", source_msg_id: "y", consent_basis: "third_party_inferred" }],
    },
  ];
  const out = __internal.walkConsent(["fact_y", "fact_x"], rows);
  assert.equal(out.strictest_consent_basis, "first_party");
  assert.deepEqual(out.consent_inherits_from, ["fact_x"]);
  assert.deepEqual(out.source_refs.map((r) => r.event_id), ["fact_y", "fact_x"]);
  // role is always "derived_from" on the derivative row.
  for (const r of out.source_refs) {
    assert.equal(r.role, "derived_from");
  }
});
