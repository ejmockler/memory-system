// conversation-stamp.test.mjs — WU-forward-conversation-stamp BEHAVIOR coverage.
//
// WHAT THIS LOCKS IN:
//   The forward-only conversational-provenance stamp. At promote time the
//   promote path derives "daemon:thread:<bucket_key>" from the in-scope source
//   row and writes it onto provenance.conversation_id of the NEW fact row. The
//   recall read path (recall/context-prefix.js) already parses that exact shape,
//   so a stamped row lights up the "Conversation:" segment with ZERO read-side
//   change. Forward-only: existing rows are never touched (thesis #1).
//
// COVERAGE:
//   U1  — deriveConversationId over each source shape (imessage chat_guid,
//         whatsapp session_jid, git-log repo/author, generic codex-cli
//         conversation_id) returns "daemon:thread:<bucket_key>".
//   U2  — byte-identical to extractThreadKey: the forward stamp and the daemon
//         aggregator path MUST collide on the same bucket_key.
//   U3  — imessage chat_identifier still wins when present (legacy fixtures /
//         future backfills) — back-compat for the patched branch.
//   U4  — defensive degrade: null row, non-object, no source, no raw_content,
//         non-thread-bearing source (screentime) → null, never throws.
//   I1  — WATERMARK PATH: a promoted iMessage fact carrying chat_guid gets
//         provenance.conversation_id = "daemon:thread:chat:<guid>:day:<date>"
//         on the durable ledger row.
//   I2  — WATERMARK PATH: a promoted whatsapp fact carrying session_jid gets
//         the chat:<session_jid> descriptor.
//   I3  — WATERMARK PATH: a source event WITHOUT a derivable thread key
//         (screentime) promotes fine — conversation_id is null (field omitted,
//         no throw); back-compat: the row is still appended with content.
//   R1  — READ PATH end-to-end: the stamped descriptor flows through
//         context-prefix.buildContextPrefix and produces a "Conversation:"
//         segment; an unstamped (null) row degrades to no segment, no throw.
//
// Hermetic discipline: env vars set BEFORE any dynamic import touches config.js
// so config.js binds into TMP_ROOT and production stays byte-identical.
//
// Run: node --test test/synthesis/conversation-stamp.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 0. Hermetic root + env BEFORE any dynamic import touches config.js.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-conv-stamp-"));
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

const {
  deriveConversationId,
  THREAD_DESCRIPTOR_PREFIX,
} = await import("../../lib/synthesis/conversation-stamp.js");
const { __internal } = await import(
  "../../lib/synthesis/thread-aggregator.js"
);
const { extractThreadKey } = __internal;
const promoteFactMod = await import("../../lib/tools/distill-promote-fact.js");
const { buildContextPrefix } = await import(
  "../../lib/recall/context-prefix.js"
);

const LEDGER_PATH = join(process.env.LEDGERS_BASE_DIR, "memory.jsonl");

function memoryLedgerLines() {
  if (!existsSync(LEDGER_PATH)) return [];
  return readFileSync(LEDGER_PATH, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function rowFor(memoryEventId) {
  return memoryLedgerLines().find((x) => x.id === memoryEventId) || null;
}

// fakePromote — PROMOTE-shaped salience the cascade would hand promoteSourceRow.
function fakePromote(extra = {}) {
  return {
    decision: "PROMOTE",
    score: 0.42,
    components: {
      recency: 0.5,
      authorship: 1.0,
      content_mass: 0.5,
      source_prior: 0.6,
      structural: 0.5,
      novelty: 1.0,
      last_retrieved_ts: 0,
      use_count: 0,
    },
    weights_hash: "test-weights-hash",
    version: "v1",
    embedding_mrl_768: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// U1 — deriveConversationId over each source shape.
// ---------------------------------------------------------------------------
test("U1: deriveConversationId resolves per-source thread descriptors", () => {
  const imsg = deriveConversationId({
    source: "imessage",
    ts: "2026-06-19T05:00:00Z",
    source_msg_id: "m1",
    raw_content: { chat_guid: "iMessage;-;+15551234567" },
  });
  assert.equal(
    imsg,
    "daemon:thread:chat:iMessage;-;+15551234567:day:2026-06-19",
    "imessage stamps chat:<chat_guid>",
  );

  const wa = deriveConversationId({
    source: "whatsapp",
    ts: "2026-06-19T05:00:00Z",
    source_msg_id: "w1",
    raw_content: { session_jid: "123@s.whatsapp.net" },
  });
  assert.equal(
    wa,
    "daemon:thread:chat:123@s.whatsapp.net:day:2026-06-19",
    "whatsapp stamps chat:<session_jid>",
  );

  const git = deriveConversationId({
    source: "git-log",
    ts: "2026-06-19T05:00:00Z",
    source_msg_id: "g1",
    raw_content: { repo_path: "/home/alex/r", author_email: "a@example.com" },
  });
  assert.equal(
    git,
    "daemon:thread:repo:/home/alex/r:author:a@example.com:day:2026-06-19",
    "git-log stamps repo:<repo>:author:<email>",
  );

  const codex = deriveConversationId({
    source: "codex-cli",
    ts: "2026-06-19T05:00:00Z",
    source_msg_id: "c1",
    raw_content: { conversation_id: "conv-xyz" },
  });
  assert.equal(
    codex,
    "daemon:thread:codex-cli:conv-xyz:day:2026-06-19",
    "codex-cli stamps via the generic conversation_id fallback",
  );
});

// ---------------------------------------------------------------------------
// U2 — byte-identical to the daemon aggregator's extractThreadKey path.
// ---------------------------------------------------------------------------
test("U2: forward stamp is byte-identical to extractThreadKey bucket_key", () => {
  const srcRow = {
    source: "imessage",
    ts: "2026-06-19T05:00:00Z",
    source_msg_id: "m9",
    raw_content: { chat_guid: "iMessage;-;groupGUID" },
  };
  const forward = deriveConversationId(srcRow);
  // Reconstruct what the aggregator would produce from the same raw_content.
  const aggKey = extractThreadKey({
    source: srcRow.source,
    ts: srcRow.ts,
    raw_content: srcRow.raw_content,
  });
  assert.ok(aggKey && typeof aggKey.bucket_key === "string", "agg key derived");
  assert.equal(
    forward,
    `${THREAD_DESCRIPTOR_PREFIX}${aggKey.bucket_key}`,
    "forward descriptor == prefix + aggregator bucket_key",
  );
  assert.equal(
    THREAD_DESCRIPTOR_PREFIX,
    "daemon:thread:",
    "prefix matches the marker context-prefix.js strips",
  );
});

// ---------------------------------------------------------------------------
// U3 — back-compat: imessage chat_identifier still wins when present.
// ---------------------------------------------------------------------------
test("U3: imessage chat_identifier wins over chat_guid (legacy back-compat)", () => {
  const both = deriveConversationId({
    source: "imessage",
    ts: "2026-06-19T05:00:00Z",
    source_msg_id: "m2",
    raw_content: {
      chat_identifier: "+15550001111",
      chat_guid: "iMessage;-;SHOULD_NOT_WIN",
    },
  });
  assert.equal(
    both,
    "daemon:thread:chat:+15550001111:day:2026-06-19",
    "chat_identifier is preferred when present",
  );
});

// ---------------------------------------------------------------------------
// U4 — defensive degrade: every malformed / keyless input returns null, no throw.
// ---------------------------------------------------------------------------
test("U4: deriveConversationId degrades to null defensively (never throws)", () => {
  assert.equal(deriveConversationId(null), null, "null -> null");
  assert.equal(deriveConversationId(undefined), null, "undefined -> null");
  assert.equal(deriveConversationId(42), null, "non-object -> null");
  assert.equal(
    deriveConversationId({ ts: "2026-06-19T05:00:00Z", raw_content: {} }),
    null,
    "missing source -> null",
  );
  assert.equal(
    deriveConversationId({ source: "imessage", ts: "2026-06-19T05:00:00Z" }),
    null,
    "missing raw_content -> null",
  );
  assert.equal(
    deriveConversationId({
      source: "screentime",
      ts: "2026-06-19T05:00:00Z",
      raw_content: { app: "Safari" },
    }),
    null,
    "non-thread-bearing source (screentime) -> null",
  );
  // Unparseable ts -> dayBucket 'unknown' -> null (still no throw).
  assert.equal(
    deriveConversationId({
      source: "imessage",
      ts: "not-a-date",
      raw_content: { chat_guid: "g" },
    }),
    null,
    "unparseable ts -> null",
  );
});

// ---------------------------------------------------------------------------
// I1 — WATERMARK PATH: promoted iMessage fact carries the thread descriptor.
// ---------------------------------------------------------------------------
test("I1: promoted iMessage fact stamps provenance.conversation_id from chat_guid", async () => {
  const event = {
    source_msg_id: "imsg_conv_1",
    source: "imessage",
    ts: "2026-06-02T09:30:00Z",
    parties: ["user", "u2468@hub.example.org"],
    raw_content: { text: "ok thanks", chat_guid: "iMessage;-;+15559998888" },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "imessage",
    salience: fakePromote(),
  });
  assert.equal(r.ok, true, "promote returns ok");
  const row = rowFor(r.memory_event_id);
  assert.ok(row, "row located by memory_event_id");
  assert.ok(
    row.provenance && typeof row.provenance === "object",
    "row carries a provenance object",
  );
  assert.equal(
    row.provenance.conversation_id,
    "daemon:thread:chat:iMessage;-;+15559998888:day:2026-06-02",
    "conversation_id stamped from chat_guid + day bucket",
  );
  // Forward stamp must not clobber the rest of provenance.
  assert.equal(
    row.provenance.agent_id,
    "daemons/watermark.js",
    "agent_id preserved",
  );
  assert.equal(
    row.provenance.confidence,
    "pre_distilled",
    "confidence preserved",
  );
});

// ---------------------------------------------------------------------------
// I2 — WATERMARK PATH: whatsapp fact stamps chat:<session_jid>.
// ---------------------------------------------------------------------------
test("I2: promoted whatsapp fact stamps provenance.conversation_id from session_jid", async () => {
  const event = {
    source_msg_id: "wa_conv_1",
    source: "whatsapp",
    ts: "2026-06-03T14:00:00Z",
    parties: ["user", "447700900000@s.whatsapp.net"],
    raw_content: {
      text: "see you then",
      session_jid: "447700900000@s.whatsapp.net",
    },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "whatsapp",
    salience: fakePromote(),
  });
  assert.equal(r.ok, true, "promote returns ok");
  const row = rowFor(r.memory_event_id);
  assert.ok(row, "whatsapp row located");
  assert.equal(
    row.provenance.conversation_id,
    "daemon:thread:chat:447700900000@s.whatsapp.net:day:2026-06-03",
    "conversation_id stamped from session_jid + day bucket",
  );
});

// ---------------------------------------------------------------------------
// I3 — WATERMARK PATH: keyless source promotes fine; field omitted (null).
// ---------------------------------------------------------------------------
test("I3: source event WITHOUT a thread key promotes fine (conversation_id null, no throw)", async () => {
  const event = {
    source_msg_id: "st_conv_1",
    source: "screentime",
    ts: "2026-06-04T08:00:00Z",
    parties: [],
    // screentime is not thread-bearing in extractThreadKey -> no key derivable.
    raw_content: { app: "com.apple.Safari", duration_s: 120 },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "screentime",
    salience: fakePromote(),
  });
  assert.equal(r.ok, true, "keyless source still promotes (no throw)");
  const row = rowFor(r.memory_event_id);
  assert.ok(row, "screentime row appended");
  assert.equal(
    row.provenance.conversation_id,
    null,
    "conversation_id omitted (null) when no key derivable",
  );
  // Back-compat: the row is otherwise a normal, durable fact row.
  assert.equal(row.kind, "fact", "row is a fact");
  assert.equal(typeof row.content, "string", "row carries content");
  assert.equal(
    row.source,
    "screentime",
    "top-level source preserved (back-compat)",
  );
});

// ---------------------------------------------------------------------------
// R1 — READ PATH end-to-end: stamped descriptor -> "Conversation:" segment.
// ---------------------------------------------------------------------------
test("R1: stamped descriptor flows through context-prefix; null degrades cleanly", () => {
  const convId = deriveConversationId({
    source: "imessage",
    ts: "2026-06-19T05:00:00Z",
    source_msg_id: "m1",
    raw_content: { chat_guid: "iMessage;-;+15551234567" },
  });
  const stampedRow = {
    id: "fact_read_1",
    kind: "fact",
    content: "yea sure",
    source: "imessage",
    source_refs: [{ source: "imessage", source_msg_id: "m1" }],
    provenance: {
      agent_id: "daemons/watermark.js",
      conversation_id: convId,
      confidence: "pre_distilled",
    },
    features: { entities: [] },
    created_at: "2026-06-19T05:00:00Z",
  };
  const prefix = buildContextPrefix(stampedRow);
  assert.equal(typeof prefix, "string", "prefix is a string");
  assert.ok(
    prefix.includes("Conversation:"),
    `stamped row yields a Conversation segment: ${JSON.stringify(prefix)}`,
  );
  assert.ok(
    prefix.includes("+15551234567"),
    "the chat handle survives into the descriptor",
  );

  // Unstamped (conversation_id null) row degrades: no Conversation segment,
  // no throw — proving the read path was already null-tolerant (zero read-side
  // change required by this WU).
  const unstampedRow = {
    ...stampedRow,
    provenance: { ...stampedRow.provenance, conversation_id: null },
  };
  const prefix2 = buildContextPrefix(unstampedRow);
  assert.equal(typeof prefix2, "string", "unstamped prefix is a string");
  assert.ok(
    !prefix2.includes("Conversation:"),
    `unstamped row omits the Conversation segment: ${JSON.stringify(prefix2)}`,
  );
});
