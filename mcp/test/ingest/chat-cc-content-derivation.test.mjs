// chat-cc-content-derivation.test.mjs — WU-A1-chat-cc-content-fix regression.
//
// BUG: chat-claude-code-promoted facts were landing in memory.jsonl with
// row.content set to raw_content.conversation_id (a UUID string) instead of
// the actual turn text. Observed in the queue:
//   content='1a2b3c4d-0000-4000-8000-0000000000c1'
// which is the literal raw_content.conversation_id of every chat-cc row for
// that session.
//
// ROOT CAUSE: hooks/stop-hook.sh emits chat-claude-code source-ledger rows
// WITHOUT a top-level `content` field — only raw_content is populated. The
// watermark hot path runs the row through normalizeSourceEvent
// (lib/ingest/salience.js) which dispatches by source. Pre-fix, there was no
// case for `chat-claude-code`, so the row fell into the unknown-source
// branch: "for k of Object.keys(raw): if string, derived=v; break". Since
// raw_content's first key is `conversation_id`, the UUID was promoted as the
// row content — which then flowed into args.content in promoteSourceRow ->
// appendFactRow.
//
// FIX (lib/ingest/salience.js#normalizeSourceEvent): add an explicit branch
// for src === "chat-claude-code" || src === "codex-cli" that joins
// raw_content.user_text + raw_content.assistant_text with the same
// "user: <...>\n\nassistant: <...>" shape codex-cli's connector buildContent
// uses. Empty halves are omitted so a tool-only turn ('') derives '' and
// Stage-0 drops it on content_mass=0 (the correct behaviour) instead of
// routing the UUID into content.
//
// BACKWARDS-COMPAT: existing chat-cc facts already on disk are not rewritten;
// only NEW promotions get real turn text. The fix is purely a derivation
// change at the watermark/MCP-handler boundary.
//
// HERMETIC: env set BEFORE dynamic import per repo discipline. No real
// memory.jsonl, no real Gemini, no real source ledger reads. The ledger
// row T7 replays is synthetic: the test writes it to
// <TMP_ROOT>/storage/sources/chat-claude-code.jsonl and reads it back from
// there; nothing outside the scratch root is opened.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-chatcc-content-"));
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

const salienceMod = await import("../../lib/ingest/salience.js");

// Fixture row: the precise shape hooks/stop-hook.sh emits (NO top-level
// `content` field; raw_content carries conversation_id + user_text +
// assistant_text + runtime + cwd). Hard-coded — not read from the real
// ledger so the test stays hermetic.
function makeChatCcRow({
  conversationId,
  userText,
  assistantText,
  cwd = null,
} = {}) {
  return {
    id: "ulid_TEST_CHAT_CC",
    ts: "2026-05-31T14:19:47.228Z",
    source: "chat-claude-code",
    source_msg_id: "test_source_msg_id_chatcc",
    parties: ["user", "assistant"],
    raw_content: {
      conversation_id: conversationId,
      turn_index: null,
      user_text: userText,
      assistant_text: assistantText,
      runtime: "claude-code",
      cwd,
    },
    attachments: [],
    source_policy: {
      deletion_semantics: "full_excise",
      consent_basis: "first_party",
    },
  };
}

// -----------------------------------------------------------------------------
// T1 — Substantive turn: both user_text and assistant_text are non-empty.
// content MUST be the joined "user: ... \n\n assistant: ..." string, NOT the
// conversation_id UUID. This is the direct regression for the queue sample
// where content='1a2b3c4d-0000-4000-8000-0000000000c1'.
// -----------------------------------------------------------------------------
test("T1: chat-claude-code substantive turn derives content from user_text + assistant_text (NOT conversation_id)", () => {
  const row = makeChatCcRow({
    conversationId: "1a2b3c4d-0000-4000-8000-0000000000c1",
    userText: "the nightly export job finished without errors",
    assistantText: "noted; that makes three clean runs in a row for the new scheduler build",
  });

  const out = salienceMod.normalizeSourceEvent(row);

  // (1) adapter returns a string content.
  assert.equal(typeof out.content, "string", "out.content must be a string");
  // (2) NOT the conversation_id UUID — the precise regression we are
  // guarding against. A regression would route raw_content.conversation_id
  // through the unknown-source first-scalar fallback.
  assert.notEqual(
    out.content,
    "1a2b3c4d-0000-4000-8000-0000000000c1",
    "BUG REGRESSION: content === conversation_id UUID; the fix in normalizeSourceEvent has been reverted",
  );
  assert.ok(
    !out.content.includes("1a2b3c4d-0000-4000-8000-0000000000c1"),
    "content must not contain the conversation_id UUID anywhere",
  );
  // (3) content contains the user text verbatim.
  assert.ok(
    out.content.includes("the nightly export job finished without errors"),
    "content must contain user_text verbatim",
  );
  // (4) content contains the assistant text verbatim.
  assert.ok(
    out.content.includes("noted; that makes three clean runs in a row for the new scheduler build"),
    "content must contain assistant_text verbatim",
  );
  // (5) shape matches the codex-cli connector buildContent format —
  // "user: <...>\n\nassistant: <...>" — verified literally so a future
  // shape drift surfaces.
  assert.equal(
    out.content,
    "user: the nightly export job finished without errors\n\nassistant: noted; that makes three clean runs in a row for the new scheduler build",
    "exact shape: user-prefix, double-newline, assistant-prefix",
  );
  // (6) other event fields are passed through unmodified (the adapter is
  // strictly additive; it must not strip parties, ts, source_msg_id, etc.).
  assert.equal(out.source, "chat-claude-code");
  assert.equal(out.source_msg_id, "test_source_msg_id_chatcc");
  assert.deepEqual(out.parties, ["user", "assistant"]);
  // (7) raw_content is preserved verbatim — downstream consumers may still
  // read conversation_id off raw_content (the structured-features connector
  // does exactly this).
  assert.equal(out.raw_content.conversation_id, "1a2b3c4d-0000-4000-8000-0000000000c1");
  assert.equal(out.raw_content.user_text, "the nightly export job finished without errors");
});

// -----------------------------------------------------------------------------
// T2 — User-only turn (assistant_text is empty). content MUST contain only
// the user half; no stray "assistant: " prefix.
// -----------------------------------------------------------------------------
test("T2: chat-claude-code user-only turn omits the empty assistant half", () => {
  const row = makeChatCcRow({
    conversationId: "conv_user_only",
    userText: "what is the architecture of the cascade",
    assistantText: "",
  });
  const out = salienceMod.normalizeSourceEvent(row);
  assert.equal(
    out.content,
    "user: what is the architecture of the cascade",
    "user-only shape: single prefix, no trailing newlines, no assistant prefix",
  );
  assert.ok(!out.content.includes("assistant:"));
});

// -----------------------------------------------------------------------------
// T3 — Assistant-only turn (user_text is empty). Symmetric to T2.
// -----------------------------------------------------------------------------
test("T3: chat-claude-code assistant-only turn omits the empty user half", () => {
  const row = makeChatCcRow({
    conversationId: "conv_assistant_only",
    userText: "",
    assistantText: "the cascade reads source ledgers and promotes via watermark",
  });
  const out = salienceMod.normalizeSourceEvent(row);
  assert.equal(
    out.content,
    "assistant: the cascade reads source ledgers and promotes via watermark",
    "assistant-only shape: single prefix; no user prefix",
  );
  assert.ok(!out.content.includes("user:"));
});

// -----------------------------------------------------------------------------
// T4 — Tool-only turn (both halves empty). The fix's INTENT is to derive ""
// here so Stage-0 drops the row on content_mass=0 (the correct admission
// behaviour) — NOT to route the UUID. This is the exact failure mode the
// queue sample exhibits: 202 rows for conv 1a2b3c4d all carry empty
// user_text + assistant_text and yet were getting promoted with
// content=conv_id. Post-fix they derive "" and the salience cascade drops
// them naturally.
// -----------------------------------------------------------------------------
test("T4: chat-claude-code tool-only turn (both empty) derives empty content — NOT the UUID", () => {
  const row = makeChatCcRow({
    conversationId: "1a2b3c4d-0000-4000-8000-0000000000c1",
    userText: "",
    assistantText: "",
    cwd: "/srv/example/project",
  });
  const out = salienceMod.normalizeSourceEvent(row);
  assert.equal(typeof out.content, "string");
  assert.equal(
    out.content,
    "",
    "both halves empty → empty content (Stage-0 then drops on content_mass=0); MUST NOT fall through to the unknown-source first-scalar branch",
  );
  // The critical anti-regression: even with empty halves, conversation_id
  // does not leak into content.
  assert.notEqual(out.content, "1a2b3c4d-0000-4000-8000-0000000000c1");
  assert.ok(!out.content.includes("1a2b3c4d"));
});

// -----------------------------------------------------------------------------
// T5 — Idempotency: when a caller pre-populates content (e.g. the MCP
// handler path supplies args.content directly), the adapter MUST NOT
// overwrite it. This guards the existing salience-cascade-integration T5
// invariant for the chat-cc source specifically.
// -----------------------------------------------------------------------------
test("T5: chat-claude-code adapter is idempotent when content is pre-filled", () => {
  const row = makeChatCcRow({
    conversationId: "conv_idempotent",
    userText: "raw user",
    assistantText: "raw assistant",
  });
  row.content = "pre-filled by caller";
  const out = salienceMod.normalizeSourceEvent(row);
  assert.equal(
    out.content,
    "pre-filled by caller",
    "pre-filled content must not be clobbered by the adapter",
  );
});

// -----------------------------------------------------------------------------
// T6 — codex-cli source (parallel shape; the connector pre-stamps content
// but a row written without it MUST also derive via the same branch).
// -----------------------------------------------------------------------------
test("T6: codex-cli without pre-filled content also derives via the chat-cc/codex branch", () => {
  const row = {
    id: "ulid_TEST_CODEX",
    ts: "2026-05-31T15:00:00Z",
    source: "codex-cli",
    source_msg_id: "codex:test:0",
    parties: ["user", "assistant"],
    raw_content: {
      conversation_id: "session-abc-123",
      session_file: "rollout-abc.jsonl",
      turn_index: 0,
      user_text: "explain the watermark daemon",
      assistant_text: "it polls source ledgers and routes rows through scoreCandidate",
      sender_is_bot: false,
      cwd: "/srv/example/project",
    },
  };
  const out = salienceMod.normalizeSourceEvent(row);
  assert.equal(
    out.content,
    "user: explain the watermark daemon\n\nassistant: it polls source ledgers and routes rows through scoreCandidate",
    "codex-cli derives the same shape as chat-claude-code",
  );
  // And the codex session id (which would be the conversation_id in the
  // unknown-fallback) does NOT appear.
  assert.ok(!out.content.includes("session-abc-123"));
});

// -----------------------------------------------------------------------------
// T7 — LEDGER ROUND-TRIP: write a source-ledger file in the shape
// hooks/stop-hook.sh produces (a tool-only row first, then a substantive
// row; neither has a top-level `content`), read the first substantive row
// back off disk, and assert the adapter derives the joined turn text from
// it. The ledger lives under the test's scratch root and every row in it is
// synthetic, so the case runs unconditionally on any machine.
// -----------------------------------------------------------------------------
test("T7 (ledger round-trip): a row from <scratch>/storage/sources/chat-claude-code.jsonl derives joined turn text", () => {
  const ledgerPath = join(process.env.STORAGE_BASE_DIR, "sources", "chat-claude-code.jsonl");
  const ledgerRows = [
    makeChatCcRow({
      conversationId: "5e6f7a8b-0000-4000-8000-0000000000c7",
      userText: "",
      assistantText: "",
      cwd: "/srv/example/project",
    }),
    makeChatCcRow({
      conversationId: "5e6f7a8b-0000-4000-8000-0000000000c7",
      userText: "summarise what the watermark daemon does on each poll",
      assistantText: "it reads new source-ledger rows, scores each candidate and promotes the admitted ones",
      cwd: "/srv/example/project",
    }),
  ];
  writeFileSync(ledgerPath, ledgerRows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  assert.ok(existsSync(ledgerPath), "the scratch ledger must exist before it is replayed");
  const raw = readFileSync(ledgerPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 2, "scratch ledger must hold both rows");
  let substantive = null;
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const rc = r && r.raw_content;
    if (!rc) continue;
    const u = typeof rc.user_text === "string" ? rc.user_text : "";
    const a = typeof rc.assistant_text === "string" ? rc.assistant_text : "";
    if (u.length > 10 && a.length > 10 && typeof rc.conversation_id === "string") {
      substantive = r;
      break;
    }
  }
  assert.notEqual(substantive, null, "the scratch ledger must yield a substantive row");
  assert.equal("content" in substantive, false, "ledger rows carry no top-level content");

  const out = salienceMod.normalizeSourceEvent(substantive);
  const rc = substantive.raw_content;

  // Adapter produced a string.
  assert.equal(typeof out.content, "string");
  // Both halves present.
  assert.ok(out.content.includes(rc.user_text), "content must include the ledger row's user_text");
  assert.ok(out.content.includes(rc.assistant_text), "content must include the ledger row's assistant_text");
  // Conversation_id MUST NOT leak in (the original bug).
  assert.notEqual(out.content, rc.conversation_id);
  assert.ok(
    !out.content.includes(rc.conversation_id),
    "ledger round-trip regression: conversation_id leaked into content",
  );
  // Exact shape.
  assert.equal(
    out.content,
    `user: ${rc.user_text}\n\nassistant: ${rc.assistant_text}`,
  );
  assert.equal(
    out.content,
    "user: summarise what the watermark daemon does on each poll\n\nassistant: it reads new source-ledger rows, scores each candidate and promotes the admitted ones",
  );
});
