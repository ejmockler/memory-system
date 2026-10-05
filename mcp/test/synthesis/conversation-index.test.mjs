// conversation-index.test.mjs — WU-backward-conversation-index.
//
// Guards the BACKWARD conversation index (lib/synthesis/conversation-index.js)
// and its wiring into context-prefix.js. This is the Tier-0 backfill that
// raises context-prefix thread coverage from the documented 0% on the EXISTING
// corpus by joining each fact's source_refs[].source_msg_id to its retained,
// append-only source row and deriving the daemon's `daemon:thread:<bucket_key>`
// descriptor (reusing thread-aggregator.extractThreadKey — byte-identical).
//
// What this suite proves:
//   A. JOIN: a fixture fact joins to its source row -> correct conversation_id
//      + thread_label, per source (imessage / git-log / codex-cli / whatsapp).
//   B. CACHE: persist + reload round-trip; invalidation on mtime+size bump;
//      corrupt cache -> silent rebuild; cold start (missing ledger).
//   C. WIRING: buildContextPrefix(row, opts) uses the REAL label when the index
//      resolves one, and falls back to current behavior when absent/miss.
//   D. THESIS #1: the index NEVER mutates the fact ledger (byte-identical
//      before/after a build).
//
// HERMETICITY (standing): mkdtempSync root + env overrides BEFORE any dynamic
// import. The default (production) data root is never touched;
// every ledger/source/cache lives under the tmp MEMORY_ROOT.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  utimesSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-convidx-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
mkdirSync(join(MEMORY_ROOT, "storage", "sources"), { recursive: true });
mkdirSync(join(MEMORY_ROOT, "ledgers"), { recursive: true });

const mod = await import("../../lib/synthesis/conversation-index.js");
const {
  rebuildConversationIndex,
  loadOrRebuildConversationIndex,
  loadConversationIndexFromCacheSync,
  lookupConversation,
  persistConversationIndex,
  CONVERSATION_INDEX_SCHEMA_VERSION,
  CONVERSATION_INDEX_VERSION,
  CONVERSATION_INDEX_CAPS,
  __internal,
} = mod;

const cpMod = await import("../../lib/recall/context-prefix.js");
const { buildContextPrefix } = cpMod;

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Fixtures — source rows mirror the LIVE storage/sources/*.jsonl shapes
// (investigated): imessage uses raw_content.chat_guid (chat_identifier is
// null on production rows); git-log uses repo_path + author_email; codex-cli
// uses raw_content.conversation_id; whatsapp uses raw_content.session_jid.
// ---------------------------------------------------------------------------

function sourceRow({ source, source_msg_id, ts, raw_content, parties }) {
  return JSON.stringify({
    id: `ulid_${source_msg_id}`,
    ts,
    source,
    source_msg_id,
    parties: parties || ["user"],
    raw_content,
    attachments: [],
    source_policy: { deletion_semantics: "full_excise", consent_basis: "first_party" },
    checksum: "deadbeef",
  });
}

function factRow({ id, source, source_msg_id, ts, content }) {
  return JSON.stringify({
    id,
    kind: "fact",
    content: content || `content for ${id}`,
    source,
    ts,
    created_at: ts,
    source_refs: [
      { source, source_msg_id, via: "original", consent_basis: "first_party" },
    ],
    derived_from: [],
    provenance: { agent_id: "daemons/watermark.js", conversation_id: null },
    features: { entities: [] },
  });
}

// A workspace with: 4 facts across 4 sources, each joinable to a source row;
// plus one fact whose source_msg_id has NO matching source row (unjoinable).
function makeWorkspace(name) {
  const ws = join(TMP_ROOT, name);
  mkdirSync(join(ws, "storage", "sources"), { recursive: true });
  mkdirSync(join(ws, "ledgers"), { recursive: true });
  const ledgerPath = join(ws, "ledgers", "memory.jsonl");
  const sourceLedgerPath = (src) => join(ws, "storage", "sources", `${src}.jsonl`);
  return { ws, ledgerPath, sourceLedgerPath };
}

const DAY = "2026-06-01";
const TS = `${DAY}T12:00:00.000Z`;

// ---------------------------------------------------------------------------
// T0: surface presence + frozen CAPS
// ---------------------------------------------------------------------------
test("module surface + frozen CAPS", () => {
  assert.equal(typeof rebuildConversationIndex, "function");
  assert.equal(typeof loadOrRebuildConversationIndex, "function");
  assert.equal(typeof lookupConversation, "function");
  assert.equal(typeof persistConversationIndex, "function");
  assert.equal(CONVERSATION_INDEX_SCHEMA_VERSION, "v1");
  assert.ok(CONVERSATION_INDEX_VERSION.startsWith("conversation-index@"));
  assert.ok(Object.isFrozen(CONVERSATION_INDEX_CAPS));
  assert.ok(CONVERSATION_INDEX_CAPS.THREAD_BEARING_SOURCES.includes("imessage"));
  assert.equal(CONVERSATION_INDEX_CAPS.CONVERSATION_ID_PREFIX, "daemon:thread:");
});

// ---------------------------------------------------------------------------
// T1: JOIN — facts join to their source rows with correct descriptors.
// ---------------------------------------------------------------------------
test("join: facts resolve correct conversation_id + thread_label per source", async () => {
  const { ledgerPath, sourceLedgerPath } = makeWorkspace("ws-join");

  // Source rows.
  writeFileSync(
    sourceLedgerPath("imessage"),
    sourceRow({
      source: "imessage",
      source_msg_id: "IM-1",
      ts: TS,
      raw_content: { text: "hey", chat_guid: "any;-;+15555550111", chat_identifier: null },
    }) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    sourceLedgerPath("git-log"),
    sourceRow({
      source: "git-log",
      source_msg_id: "git:abc123",
      ts: TS,
      raw_content: { repo_path: "/home/alex/projects/example-repo", author_email: "alex@example.com", subject: "fix" },
    }) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    sourceLedgerPath("codex-cli"),
    sourceRow({
      source: "codex-cli",
      source_msg_id: "codex:conv-xyz:1",
      ts: TS,
      raw_content: { conversation_id: "conv-xyz", user_text: "hi", assistant_text: "yo" },
    }) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    sourceLedgerPath("whatsapp"),
    sourceRow({
      source: "whatsapp",
      source_msg_id: "WA-1",
      ts: TS,
      raw_content: { text: "ping", session_jid: "15550100001@s.whatsapp.net" },
    }) + "\n",
    { mode: 0o600 },
  );

  // Facts (provenance.conversation_id is null — this is the historical case).
  const facts = [
    factRow({ id: "fact-im", source: "imessage", source_msg_id: "IM-1", ts: TS }),
    factRow({ id: "fact-git", source: "git-log", source_msg_id: "git:abc123", ts: TS }),
    factRow({ id: "fact-codex", source: "codex-cli", source_msg_id: "codex:conv-xyz:1", ts: TS }),
    factRow({ id: "fact-wa", source: "whatsapp", source_msg_id: "WA-1", ts: TS }),
    // Unjoinable: no source row carries this source_msg_id.
    factRow({ id: "fact-orphan", source: "imessage", source_msg_id: "IM-MISSING", ts: TS }),
  ];
  writeFileSync(ledgerPath, facts.join("\n") + "\n", { mode: 0o600 });

  const idx = await rebuildConversationIndex({ ledgerPath, sourceLedgerPath });

  // imessage -> chat:<chat_guid>:day:<DAY>
  const im = lookupConversation(idx, "fact-im");
  assert.equal(im.conversation_id, `daemon:thread:chat:any;-;+15555550111:day:${DAY}`);
  assert.equal(im.thread_label, `any;-;+15555550111 ${DAY}`);

  // git-log -> repo:<repo>:author:<email>:day:<DAY>
  const git = lookupConversation(idx, "fact-git");
  assert.equal(
    git.conversation_id,
    `daemon:thread:repo:/home/alex/projects/example-repo:author:alex@example.com:day:${DAY}`,
  );
  assert.equal(git.thread_label, `/home/alex/projects/example-repo ${DAY}`);

  // codex-cli -> codex-cli:<conversation_id>:day:<DAY>
  const codex = lookupConversation(idx, "fact-codex");
  assert.equal(codex.conversation_id, `daemon:thread:codex-cli:conv-xyz:day:${DAY}`);
  assert.equal(codex.thread_label, `conv-xyz ${DAY}`);

  // whatsapp -> chat:<session_jid>:day:<DAY>
  const wa = lookupConversation(idx, "fact-wa");
  assert.equal(
    wa.conversation_id,
    `daemon:thread:chat:15550100001@s.whatsapp.net:day:${DAY}`,
  );

  // Unjoinable fact -> no entry.
  assert.equal(lookupConversation(idx, "fact-orphan"), null);
  // Unknown fact -> null (never throws on a miss).
  assert.equal(lookupConversation(idx, "fact-does-not-exist"), null);

  // Stats: 5 facts seen, 4 joined.
  assert.equal(idx.stats.facts_seen, 5);
  assert.equal(idx.stats.facts_joined, 4);
});

// ---------------------------------------------------------------------------
// T2: byte-identical to thread-aggregator's daemon descriptor.
// ---------------------------------------------------------------------------
test("descriptor is byte-identical to thread-aggregator's daemon descriptor", async () => {
  const taMod = await import("../../lib/synthesis/thread-aggregator.js");
  const srcRow = {
    source: "git-log",
    ts: TS,
    raw_content: { repo_path: "/r", author_email: "a@example.com" },
  };
  const key = taMod.__internal.extractThreadKey(srcRow);
  const desc = __internal.deriveDescriptorFromSourceRow(srcRow);
  // The conversation_id is EXACTLY `daemon:thread:${bucket_key}` — the same
  // string the daemon stamps onto reconstructed events.
  assert.equal(desc.conversation_id, `daemon:thread:${key.bucket_key}`);
});

// ---------------------------------------------------------------------------
// T3: CACHE — persist + reload round-trip (cache hit).
// ---------------------------------------------------------------------------
test("cache: persist + reload round-trip returns the same entries", async () => {
  const { ledgerPath, sourceLedgerPath } = makeWorkspace("ws-cache");
  const cachePath = join(TMP_ROOT, "ws-cache", "conv-index.cache.json");

  writeFileSync(
    sourceLedgerPath("git-log"),
    sourceRow({
      source: "git-log",
      source_msg_id: "git:cache1",
      ts: TS,
      raw_content: { repo_path: "/repo", author_email: "e@example.com" },
    }) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    ledgerPath,
    factRow({ id: "fact-c", source: "git-log", source_msg_id: "git:cache1", ts: TS }) + "\n",
    { mode: 0o600 },
  );

  const built = await rebuildConversationIndex({ ledgerPath, cachePath, sourceLedgerPath });
  assert.ok(existsSync(cachePath), "cache file written after rebuild-with-cachePath");
  const onDisk = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.equal(onDisk.schema_version, "v1");
  assert.equal(onDisk.ledger_mtime_ms, built.ledgerMtime);
  assert.equal(onDisk.ledger_size_bytes, built.ledgerSize);

  const reloaded = await loadOrRebuildConversationIndex({ ledgerPath, cachePath, sourceLedgerPath });
  const hit = lookupConversation(reloaded, "fact-c");
  assert.equal(
    hit.conversation_id,
    `daemon:thread:repo:/repo:author:e@example.com:day:${DAY}`,
  );
  assert.equal(reloaded.ledgerMtime, built.ledgerMtime);
});

// ---------------------------------------------------------------------------
// T4: CACHE — invalidation on ledger mtime+size bump.
// ---------------------------------------------------------------------------
test("cache: invalidates and rebuilds after ledger mtime+size bump", async () => {
  const { ledgerPath, sourceLedgerPath } = makeWorkspace("ws-invalidate");
  const cachePath = join(TMP_ROOT, "ws-invalidate", "conv-index.cache.json");

  writeFileSync(
    sourceLedgerPath("git-log"),
    sourceRow({ source: "git-log", source_msg_id: "git:v1", ts: TS, raw_content: { repo_path: "/r1", author_email: "a@example.com" } }) + "\n" +
    sourceRow({ source: "git-log", source_msg_id: "git:v2", ts: TS, raw_content: { repo_path: "/r2", author_email: "b@example.com" } }) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    ledgerPath,
    factRow({ id: "fact-v1", source: "git-log", source_msg_id: "git:v1", ts: TS }) + "\n",
    { mode: 0o600 },
  );

  const first = await loadOrRebuildConversationIndex({ ledgerPath, cachePath, sourceLedgerPath });
  assert.ok(lookupConversation(first, "fact-v1") !== null, "initial build sees fact-v1");
  assert.equal(lookupConversation(first, "fact-v2"), null, "fact-v2 not present yet");

  // Append a fact AND force a newer mtime (HFS+ 1s granularity guard — the
  // size delta alone is also enough to invalidate).
  writeFileSync(
    ledgerPath,
    factRow({ id: "fact-v1", source: "git-log", source_msg_id: "git:v1", ts: TS }) + "\n" +
    factRow({ id: "fact-v2", source: "git-log", source_msg_id: "git:v2", ts: TS }) + "\n",
    { mode: 0o600 },
  );
  const future = new Date(Date.now() + 5000);
  utimesSync(ledgerPath, future, future);

  const second = await loadOrRebuildConversationIndex({ ledgerPath, cachePath, sourceLedgerPath });
  assert.ok(lookupConversation(second, "fact-v2") !== null, "rebuilt index sees fact-v2");
  assert.notEqual(second.ledgerMtime, first.ledgerMtime, "ledgerMtime changed across rebuild");
});

// ---------------------------------------------------------------------------
// T5: CACHE — corrupt cache -> silent rebuild; cold start -> empty.
// ---------------------------------------------------------------------------
test("cache: corrupt cache rebuilds; missing ledger -> empty index", async () => {
  const { ledgerPath, sourceLedgerPath } = makeWorkspace("ws-corrupt");
  const cachePath = join(TMP_ROOT, "ws-corrupt", "conv-index.cache.json");

  writeFileSync(
    sourceLedgerPath("git-log"),
    sourceRow({ source: "git-log", source_msg_id: "git:c1", ts: TS, raw_content: { repo_path: "/r", author_email: "c@example.com" } }) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    ledgerPath,
    factRow({ id: "fact-cor", source: "git-log", source_msg_id: "git:c1", ts: TS }) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(cachePath, "this is not valid json {{{", { mode: 0o600 });

  const idx = await loadOrRebuildConversationIndex({ ledgerPath, cachePath, sourceLedgerPath });
  assert.ok(lookupConversation(idx, "fact-cor") !== null, "rebuild proceeds despite garbage cache");

  // Cold start: a ledger path that does not exist.
  const cold = await rebuildConversationIndex({
    ledgerPath: join(TMP_ROOT, "ws-corrupt", "nope.jsonl"),
    sourceLedgerPath,
  });
  assert.equal(cold.byFactId.size, 0, "missing ledger -> empty index");
  assert.equal(cold.ledgerMtime, 0, "missing ledger -> mtime 0");
});

// ---------------------------------------------------------------------------
// T6: persist writes a mode-0600 file (operator-only).
// ---------------------------------------------------------------------------
test("persist: cache file written with mode 0600", async () => {
  const { ledgerPath, sourceLedgerPath } = makeWorkspace("ws-mode");
  const cachePath = join(TMP_ROOT, "ws-mode", "conv-index.cache.json");
  writeFileSync(
    sourceLedgerPath("git-log"),
    sourceRow({ source: "git-log", source_msg_id: "git:m1", ts: TS, raw_content: { repo_path: "/r", author_email: "m@example.com" } }) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    ledgerPath,
    factRow({ id: "fact-m", source: "git-log", source_msg_id: "git:m1", ts: TS }) + "\n",
    { mode: 0o600 },
  );
  const idx = await rebuildConversationIndex({ ledgerPath, sourceLedgerPath });
  await persistConversationIndex(idx, cachePath);
  const perm = statSync(cachePath).mode & 0o777;
  assert.equal(perm, 0o600);
});

// ---------------------------------------------------------------------------
// T7: WIRING — buildContextPrefix uses the REAL label when index resolves it.
// ---------------------------------------------------------------------------
test("context-prefix: uses the real backward label when the index resolves it", async () => {
  // A historical fact: provenance.conversation_id is null, so the on-row path
  // alone would NOT produce a Conversation label.
  const row = {
    id: "fact-im",
    kind: "fact",
    content: "yea sure",
    source: "imessage",
    created_at: TS,
    provenance: { conversation_id: null },
    features: { entities: [] },
  };

  // Without the index: no Conversation label (current/degraded behavior).
  const plain = buildContextPrefix(row);
  assert.ok(!plain.includes("Conversation:"), "no Conversation label without index");

  // With a pre-resolved entry threaded in: real Conversation label appears.
  const withEntry = buildContextPrefix(row, {
    conversationEntry: {
      conversation_id: `daemon:thread:chat:any;-;+15555550111:day:${DAY}`,
      thread_label: `any;-;+15555550111 ${DAY}`,
    },
  });
  assert.ok(withEntry.includes("Conversation:"), "real Conversation label with index entry");
  assert.ok(withEntry.includes("any;-;+15555550111"), "label carries the chat handle");

  // With the index object + lookup fn threaded in (probe by row.id).
  const idxObj = { byFactId: new Map([["fact-im", {
    conversation_id: `daemon:thread:chat:any;-;+15555550111:day:${DAY}`,
    thread_label: `any;-;+15555550111 ${DAY}`,
  }]]) };
  const withIndex = buildContextPrefix(row, {
    conversationIndex: idxObj,
    lookupConversation,
  });
  assert.ok(withIndex.includes("Conversation:"), "real label resolved via index probe");
  // Determinism: entry path and index path yield the same prefix.
  assert.equal(withIndex, withEntry, "entry path == index path (deterministic)");
});

// ---------------------------------------------------------------------------
// T8: WIRING — defensive: index miss / throwing lookup -> current behavior.
// ---------------------------------------------------------------------------
test("context-prefix: degrades to current behavior on index miss or throw", () => {
  const row = {
    id: "fact-unknown",
    kind: "fact",
    content: "remove excess console logs",
    source: "git-log",
    created_at: TS,
    provenance: { conversation_id: null },
    features: { entities: [{ kind: "project", canonical_id: "project:git-log:memory_system", surface: "memory-system" }] },
  };

  // Index MISS (row.id not in the index) -> falls back to project label.
  const miss = buildContextPrefix(row, {
    conversationIndex: { byFactId: new Map() },
    lookupConversation,
  });
  assert.ok(miss.includes("Conversation: memory-system"), "miss falls back to project label");

  // Throwing lookup -> swallowed, falls back to project label, no throw.
  const thrown = buildContextPrefix(row, {
    conversationIndex: { byFactId: new Map() },
    lookupConversation: () => {
      throw new Error("boom");
    },
  });
  assert.ok(thrown.includes("Conversation: memory-system"), "throwing lookup degrades gracefully");

  // opts omitted entirely -> byte-identical to single-arg behavior.
  assert.equal(buildContextPrefix(row), buildContextPrefix(row, undefined));
});

// ---------------------------------------------------------------------------
// T9: THESIS #1 — building the index NEVER mutates the fact ledger.
// ---------------------------------------------------------------------------
test("thesis #1: fact ledger is byte-identical before and after a build", async () => {
  const { ledgerPath, sourceLedgerPath } = makeWorkspace("ws-thesis");
  writeFileSync(
    sourceLedgerPath("git-log"),
    sourceRow({ source: "git-log", source_msg_id: "git:t1", ts: TS, raw_content: { repo_path: "/r", author_email: "t@example.com" } }) + "\n",
    { mode: 0o600 },
  );
  const ledgerBytes =
    factRow({ id: "fact-t", source: "git-log", source_msg_id: "git:t1", ts: TS }) + "\n";
  writeFileSync(ledgerPath, ledgerBytes, { mode: 0o600 });

  const before = readFileSync(ledgerPath);
  const cachePath = join(TMP_ROOT, "ws-thesis", "conv-index.cache.json");
  await rebuildConversationIndex({ ledgerPath, cachePath, sourceLedgerPath });
  const after = readFileSync(ledgerPath);
  assert.ok(before.equals(after), "memory.jsonl bytes unchanged by index build");
});

// ---------------------------------------------------------------------------
// T10: malformed source rows / facts are tolerated (defensive rebuild).
// ---------------------------------------------------------------------------
test("tolerant: malformed source rows and non-thread sources are skipped", async () => {
  const { ledgerPath, sourceLedgerPath } = makeWorkspace("ws-tolerant");
  // git source ledger: one good row, one torn line, one row with no key.
  writeFileSync(
    sourceLedgerPath("git-log"),
    sourceRow({ source: "git-log", source_msg_id: "git:ok", ts: TS, raw_content: { repo_path: "/r", author_email: "ok@example.com" } }) + "\n" +
    "{this is torn json\n" +
    sourceRow({ source: "git-log", source_msg_id: "git:nokey", ts: TS, raw_content: { subject: "no repo or author" } }) + "\n",
    { mode: 0o600 },
  );
  const facts = [
    factRow({ id: "fact-ok", source: "git-log", source_msg_id: "git:ok", ts: TS }),
    factRow({ id: "fact-nokey", source: "git-log", source_msg_id: "git:nokey", ts: TS }),
    // A screentime fact: source NOT in THREAD_BEARING_SOURCES -> never joined.
    factRow({ id: "fact-st", source: "screentime", source_msg_id: "screentime:1", ts: TS }),
    // A non-fact row (kind != fact) -> ignored entirely.
    JSON.stringify({ id: "policy-1", kind: "policy", ts: TS }),
  ];
  writeFileSync(ledgerPath, facts.join("\n") + "\n", { mode: 0o600 });

  const idx = await rebuildConversationIndex({ ledgerPath, sourceLedgerPath });
  assert.ok(lookupConversation(idx, "fact-ok") !== null, "well-formed git fact joins");
  assert.equal(lookupConversation(idx, "fact-nokey"), null, "source row with no derivable key -> no join");
  assert.equal(lookupConversation(idx, "fact-st"), null, "screentime not a thread-bearing source");
  // facts_seen is the coverage DENOMINATOR = every kind=fact row (ok + nokey +
  // screentime = 3; the kind=policy row is not a fact). Only 1 joins, so the
  // coverage fraction is honest about non-thread-bearing facts that can never
  // get a conversation label.
  assert.equal(idx.stats.facts_seen, 3, "facts_seen counts all fact rows (coverage denominator)");
  assert.equal(idx.stats.facts_joined, 1, "only the well-formed git fact joins");
});

// ---------------------------------------------------------------------------
// T11: deriveBackwardThreadLabel unit coverage.
// ---------------------------------------------------------------------------
test("deriveBackwardThreadLabel pulls the descriptive head + day", () => {
  assert.equal(
    __internal.deriveBackwardThreadLabel({ source: "git-log", thread_id: "/repo::alex@example.com", day: DAY }),
    `/repo ${DAY}`,
  );
  assert.equal(
    __internal.deriveBackwardThreadLabel({ source: "imessage", thread_id: "chatguid", day: DAY }),
    `chatguid ${DAY}`,
  );
  assert.equal(__internal.deriveBackwardThreadLabel(null), null);
  assert.equal(__internal.deriveBackwardThreadLabel({}), null);
});

// ---------------------------------------------------------------------------
// T12: loadConversationIndexFromCacheSync — cache-only, never rebuilds.
// ---------------------------------------------------------------------------
test("loadConversationIndexFromCacheSync: cache-only, fingerprint-gated, never rebuilds", async () => {
  const { ledgerPath, sourceLedgerPath } = makeWorkspace("ws-sync");
  const cachePath = join(TMP_ROOT, "ws-sync", "conv-index.cache.json");
  writeFileSync(
    sourceLedgerPath("git-log"),
    sourceRow({ source: "git-log", source_msg_id: "git:s1", ts: TS, raw_content: { repo_path: "/r", author_email: "s@example.com" } }) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    ledgerPath,
    factRow({ id: "fact-s", source: "git-log", source_msg_id: "git:s1", ts: TS }) + "\n",
    { mode: 0o600 },
  );

  // No cache yet -> null (does NOT rebuild).
  assert.equal(
    loadConversationIndexFromCacheSync({ ledgerPath, cachePath }),
    null,
    "absent cache -> null (no rebuild)",
  );

  // Build + persist the cache, then the sync load returns a usable index.
  await rebuildConversationIndex({ ledgerPath, cachePath, sourceLedgerPath });
  const loaded = loadConversationIndexFromCacheSync({ ledgerPath, cachePath });
  assert.ok(loaded !== null, "fresh cache -> index returned");
  assert.ok(loaded.byFactId instanceof Map, "returns a byFactId Map");
  assert.ok(lookupConversation(loaded, "fact-s") !== null, "sync-loaded index joins");

  // Stale fingerprint (ledger grew) -> null under requireFresh (default).
  writeFileSync(
    ledgerPath,
    factRow({ id: "fact-s", source: "git-log", source_msg_id: "git:s1", ts: TS }) + "\n" +
    factRow({ id: "fact-s2", source: "git-log", source_msg_id: "git:s1", ts: TS }) + "\n",
    { mode: 0o600 },
  );
  const future = new Date(Date.now() + 5000);
  utimesSync(ledgerPath, future, future);
  assert.equal(
    loadConversationIndexFromCacheSync({ ledgerPath, cachePath }),
    null,
    "stale cache -> null under requireFresh",
  );
  // But requireFresh:false accepts the stale-but-valid projection.
  assert.ok(
    loadConversationIndexFromCacheSync({ ledgerPath, cachePath, requireFresh: false }) !== null,
    "requireFresh:false accepts stale projection",
  );

  // Corrupt cache -> null (never throws).
  writeFileSync(cachePath, "garbage {{{", { mode: 0o600 });
  assert.equal(
    loadConversationIndexFromCacheSync({ ledgerPath, cachePath }),
    null,
    "corrupt cache -> null",
  );
});

// ---------------------------------------------------------------------------
// T14: WU-github-join-recovery — github-events facts resolve a repo-based
// thread label (was 0% coverage — extractThreadKey's shared git-log/github
// branch demanded an author_email github-events rows never carry).
//
// Fixtures follow the stored storage/sources/github-events.jsonl row shape
// (sam-sample/sample-tool PR events + a member event; all values invented): raw_content carries `repo`
// + a login surface (actor_login / pr_author / member_login) but NEVER
// author_email. Pre-fix every one of these joined to null.
// ---------------------------------------------------------------------------
test("github-events: facts resolve repo-based conversation_id + PR/issue label", async () => {
  const { ledgerPath, sourceLedgerPath } = makeWorkspace("ws-ghe");

  // Three stored-shape github-events source rows: a PR event, an issue-comment
  // event, and a member event (no pr/issue surface).
  writeFileSync(
    sourceLedgerPath("github-events"),
    sourceRow({
      source: "github-events",
      source_msg_id: "gh-event:1000000001",
      ts: TS,
      parties: ["user", "gh:sam-sample"],
      raw_content: {
        event_type: "PullRequestEvent",
        action: "merged",
        pr_number: 6,
        pr_title: null,
        pr_author: null,
        repo: "sam-sample/sample-tool",
        public: true,
        created_at: "2026-05-04T16:45:30Z",
      },
    }) + "\n" +
    sourceRow({
      source: "github-events",
      source_msg_id: "gh-event:issuecomment",
      ts: TS,
      raw_content: {
        event_type: "IssueCommentEvent",
        action: "created",
        issue_number: 20,
        issue_title: "Add export v2 confirmation flow",
        repo: "example-org/memory-system",
        public: true,
        created_at: "2026-05-07T10:00:00Z",
      },
    }) + "\n" +
    sourceRow({
      source: "github-events",
      source_msg_id: "gh-event:1000000002",
      ts: TS,
      raw_content: {
        event_type: "MemberEvent",
        action: "added",
        member_login: "alex-example",
        repo: "jo-placeholder/sample-finetune",
        public: true,
        created_at: "2026-05-08T11:02:45Z",
      },
    }) + "\n",
    { mode: 0o600 },
  );

  const facts = [
    factRow({ id: "fact-ghe-pr", source: "github-events", source_msg_id: "gh-event:1000000001", ts: TS }),
    factRow({ id: "fact-ghe-issue", source: "github-events", source_msg_id: "gh-event:issuecomment", ts: TS }),
    factRow({ id: "fact-ghe-member", source: "github-events", source_msg_id: "gh-event:1000000002", ts: TS }),
  ];
  writeFileSync(ledgerPath, facts.join("\n") + "\n", { mode: 0o600 });

  const idx = await rebuildConversationIndex({ ledgerPath, sourceLedgerPath });

  // PR event -> repo:<repo>:day:<DAY>, label sharpened with PR #6.
  const pr = lookupConversation(idx, "fact-ghe-pr");
  assert.ok(pr !== null, "PR fact joined (was null pre-fix)");
  assert.equal(
    pr.conversation_id,
    `daemon:thread:repo:sam-sample/sample-tool:day:${DAY}`,
    "PR conversation_id is repo:<repo>:day:<DAY>",
  );
  assert.equal(pr.thread_label, `sam-sample/sample-tool PR #6 ${DAY}`, "PR label carries repo + PR #6");

  // Issue-comment event -> issue # in the label.
  const issue = lookupConversation(idx, "fact-ghe-issue");
  assert.ok(issue !== null, "issue fact joined");
  assert.equal(issue.conversation_id, `daemon:thread:repo:example-org/memory-system:day:${DAY}`);
  assert.equal(issue.thread_label, `example-org/memory-system issue #20 ${DAY}`);

  // Member event (no pr/issue surface) -> bare repo label.
  const member = lookupConversation(idx, "fact-ghe-member");
  assert.ok(member !== null, "member fact joined");
  assert.equal(member.conversation_id, `daemon:thread:repo:jo-placeholder/sample-finetune:day:${DAY}`);
  assert.equal(member.thread_label, `jo-placeholder/sample-finetune ${DAY}`, "member label is bare repo (no PR/issue)");

  // COVERAGE: github-events coverage is now > 0 (was 0). All 3 facts joined.
  assert.equal(idx.stats.facts_seen, 3, "3 facts seen");
  assert.equal(idx.stats.facts_joined, 3, "all 3 github-events facts joined (>0 coverage)");
  assert.ok(idx.stats.sources["github-events"], "github-events appears in per-source stats");
  assert.equal(idx.stats.sources["github-events"].joined, 3, "github-events per-source joined > 0");
});

// ---------------------------------------------------------------------------
// T15: WU-github-join-recovery — content-fallback when the SOURCE row is
// genuinely missing. A WU-A2-era fact retains its own raw_content.repo; the
// fallback recovers the repo label even with no matching source row.
// ---------------------------------------------------------------------------
test("github-events: missing source row -> content-fallback recovers repo label", async () => {
  const { ledgerPath, sourceLedgerPath } = makeWorkspace("ws-ghe-fallback");

  // Source ledger has ONE github-events row; the second fact references a
  // source_msg_id that is NOT in the source ledger (pruned / quarantined).
  writeFileSync(
    sourceLedgerPath("github-events"),
    sourceRow({
      source: "github-events",
      source_msg_id: "gh-event:present",
      ts: TS,
      raw_content: { event_type: "PushEvent", repo: "alex-example/sample-mcp", public: true, created_at: "2026-06-01T00:00:00Z" },
    }) + "\n",
    { mode: 0o600 },
  );

  // Build two facts. The fallback fact carries its OWN raw_content.repo (the
  // WU-A2 content composer retained repo on newer facts), so even with no
  // source row it resolves a label.
  const factPresent = factRow({ id: "fact-ghe-present", source: "github-events", source_msg_id: "gh-event:present", ts: TS });
  const factMissingSrc = JSON.stringify({
    id: "fact-ghe-missing-src",
    kind: "fact",
    content: "PushEvent example-org/memory-system refs/heads/main",
    source: "github-events",
    ts: TS,
    created_at: TS,
    source_refs: [
      { source: "github-events", source_msg_id: "gh-event:GONE", via: "original", consent_basis: "third_party_inferred" },
    ],
    derived_from: [],
    provenance: { agent_id: "daemons/watermark.js", conversation_id: null },
    // WU-A2-era fact: raw_content retained on the fact row, carrying repo + PR.
    raw_content: { event_type: "PullRequestEvent", repo: "example-org/memory-system", pr_number: 99, created_at: TS },
    features: { entities: [] },
  });
  writeFileSync(ledgerPath, factPresent + "\n" + factMissingSrc + "\n", { mode: 0o600 });

  const idx = await rebuildConversationIndex({ ledgerPath, sourceLedgerPath });

  // The present fact joins via the source row.
  const present = lookupConversation(idx, "fact-ghe-present");
  assert.ok(present !== null, "fact with present source row joins");
  assert.equal(present.conversation_id, `daemon:thread:repo:alex-example/sample-mcp:day:${DAY}`);

  // The fact whose source row is MISSING still resolves via content-fallback.
  const missing = lookupConversation(idx, "fact-ghe-missing-src");
  assert.ok(missing !== null, "fact with MISSING source row recovered via content-fallback");
  assert.equal(missing.conversation_id, `daemon:thread:repo:example-org/memory-system:day:${DAY}`);
  assert.equal(missing.thread_label, `example-org/memory-system PR #99 ${DAY}`, "fallback label carries repo + PR");

  // Both facts joined -> coverage > 0 even with a missing source row.
  assert.equal(idx.stats.facts_joined, 2, "both facts joined (source-row + content-fallback)");
});

// ---------------------------------------------------------------------------
// T16: WU-github-join-recovery — deriveGithubEventsDescriptor unit coverage +
// git-log regression (the shared branch must stay byte-identical for git-log).
// ---------------------------------------------------------------------------
test("github-events: descriptor unit cases + git-log regression intact", async () => {
  const d = __internal.deriveGithubEventsDescriptor;

  // repo-only (no PR/issue) -> bare repo head.
  const bare = d({ source: "github-events", ts: TS, raw_content: { repo: "a/b" } });
  assert.equal(bare.conversation_id, `daemon:thread:repo:a/b:day:${DAY}`);
  assert.equal(bare.thread_label, `a/b ${DAY}`);

  // PR wins over issue when both present (PR is the more specific surface).
  const both = d({ source: "github-events", ts: TS, raw_content: { repo: "a/b", pr_number: 5, issue_number: 7 } });
  assert.equal(both.thread_label, `a/b PR #5 ${DAY}`, "pr_number wins over issue_number");

  // pr_number 0 / negative / non-int -> not a valid surface (bare repo).
  assert.equal(d({ source: "github-events", ts: TS, raw_content: { repo: "a/b", pr_number: 0 } }).thread_label, `a/b ${DAY}`);
  assert.equal(d({ source: "github-events", ts: TS, raw_content: { repo: "a/b", pr_number: -3 } }).thread_label, `a/b ${DAY}`);
  assert.equal(d({ source: "github-events", ts: TS, raw_content: { repo: "a/b", pr_number: "5" } }).thread_label, `a/b ${DAY}`);

  // No repo -> null (no stable key).
  assert.equal(d({ source: "github-events", ts: TS, raw_content: { event_type: "X" } }), null);
  // No raw_content -> null.
  assert.equal(d({ source: "github-events", ts: TS }), null);
  // Unparseable ts -> null (no day bucket).
  assert.equal(d({ source: "github-events", ts: "not-a-date", raw_content: { repo: "a/b" } }), null);
  // raw_content via source_refs[0] (alternate carrier) still resolves.
  const viaRefs = d({ source: "github-events", ts: TS, source_refs: [{ raw_content: { repo: "x/y", pr_number: 2 } }] });
  assert.equal(viaRefs.thread_label, `x/y PR #2 ${DAY}`);

  // REGRESSION: git-log goes through the UNCHANGED extractThreadKey path
  // (repo + author_email), NOT the new github-events branch. Byte-identical.
  const gitRow = { source: "git-log", ts: TS, raw_content: { repo_path: "/r", author_email: "a@example.com" } };
  const git = __internal.deriveDescriptorFromSourceRow(gitRow);
  assert.equal(git.conversation_id, `daemon:thread:repo:/r:author:a@example.com:day:${DAY}`, "git-log still author-scoped (regression)");
  assert.equal(git.thread_label, `/r ${DAY}`);
});

// ---------------------------------------------------------------------------
// T13: lookupConversation arg validation.
// ---------------------------------------------------------------------------
test("lookupConversation validates the index shape + tolerates bad fact ids", () => {
  assert.throws(() => lookupConversation(null, "x"), /byFactId Map/);
  assert.throws(() => lookupConversation({}, "x"), /byFactId Map/);
  const idx = { byFactId: new Map() };
  assert.equal(lookupConversation(idx, ""), null);
  assert.equal(lookupConversation(idx, 42), null);
  assert.equal(lookupConversation(idx, "missing"), null);
});
