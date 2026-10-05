// contextual-bm25.test.mjs — WU1-context-prefix-and-contextual-bm25.
//
// Guards the deterministic THREAD-FIRST context prefix + its wiring into the
// BM25 rebuild (contextual BM25). Tier-0 lever.
//
// What this suite proves:
//   A. buildContextPrefix resolution order: thread/conversation descriptor ->
//      project label -> entities-only; entity display-names + date always
//      appended; deterministic; defensive on missing fields; length-bounded.
//   B. bm25-rebuild indexes prefix+content when contextual is ON and raw
//      content when OFF, gated by opts.contextualPrefix (mirrors
//      CAPS.CONTEXTUAL_BM25_ENABLED).
//   C. THE LOAD-BEARING ASSERTION: a query term present ONLY in the prefix (an
//      entity name the fact omitted via anaphor) is BM25-matchable in the
//      contextual index and NOT in the baseline index.
//
// HERMETICITY (standing C-NEW-2): mkdtempSync root + env overrides BEFORE any
// dynamic import of memory-system modules. The default (production) data
// root must not be touched; we build indices under the tmp MEMORY_ROOT only.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hermeticity: stake tmp dirs + env BEFORE dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-ctxbm25-test-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
mkdirSync(MEMORY_ROOT, { recursive: true });

const cpMod = await import("../../lib/recall/context-prefix.js");
const { buildContextPrefix, VERSION, PREFIX_MAX_TOKENS, __internal } = cpMod;
const rebuildMod = await import("../../lib/recall/bm25-rebuild.js");
const { rebuildBm25IndexFromLedger } = rebuildMod;
const bm25Mod = await import("../../lib/recall/bm25-index.js");
const { Bm25Index } = bm25Mod;
const loaderMod = await import("../../lib/recall/bm25-streaming-loader.js").catch(
  () => null,
);

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Fixtures — entity OBJECTS matching the live ledger shape (investigated):
//   { kind, canonical_id, surface, source_scope, evidence, confidence }
// ---------------------------------------------------------------------------
function ent(kind, surface, scope = "git-log") {
  return {
    kind,
    canonical_id: `${kind}:${scope}:${surface.toLowerCase().replace(/\W+/g, "_")}`,
    surface,
    source_scope: scope,
    evidence: "handle",
    confidence: 1,
  };
}

// A reconstructed-style row: provenance.conversation_id present (thread label
// resolvable) + project entity + a person entity.
const threadRow = {
  id: "mem_thread01",
  kind: "fact",
  content: "yea lets ship it",
  source: "imessage",
  provenance: {
    agent_id: "daemons/watermark.js",
    conversation_id: "daemon:thread:chat:+15551234567:day:2026-06-01",
    confidence: "pre_distilled",
  },
  features: {
    entities: [ent("person", "Alice", "imessage")],
  },
  created_at: "2026-06-01T12:00:00.000Z",
};

// A git-log style row: NO conversation_id -> project label from project/org
// entity. Content is anaphoric ("remove excess console logs") and does NOT
// mention the project name "Atlas" or the date.
const projectRow = {
  id: "mem_project01",
  kind: "fact",
  content: "remove excess console logs",
  source: "git-log",
  provenance: { agent_id: "daemons/watermark.js", conversation_id: null },
  features: {
    entities: [
      ent("person", "ops@example.org"),
      ent("project", "Atlas"),
      ent("org", "Example Labs"),
    ],
  },
  created_at: "2026-06-02T09:30:00.000Z",
};

// An entities-only row: no conversation_id, no project/org/topic entity -> only
// person/artifact entities -> no "Conversation:" label, just Entities + Date.
const entitiesOnlyRow = {
  id: "mem_entonly01",
  kind: "fact",
  content: "sounds good to me",
  source: "whatsapp",
  provenance: { conversation_id: null },
  features: {
    entities: [ent("person", "Bob", "whatsapp")],
  },
  created_at: "2026-04-02T15:21:50.554Z",
};

// ===========================================================================
// A. buildContextPrefix — resolution order, determinism, defensiveness, bound.
// ===========================================================================

test("VERSION export is a stable string", () => {
  assert.equal(typeof VERSION, "string");
  assert.ok(VERSION.startsWith("context-prefix@"));
});

test("thread/conversation label resolves from provenance.conversation_id", () => {
  const p = buildContextPrefix(threadRow);
  assert.ok(p.startsWith("Conversation: "), `got: ${p}`);
  // Descriptor pulls the informative tokens out of the bucket key (chat id +
  // day), NOT the raw "daemon:thread:chat:...:day:..." string.
  assert.ok(p.includes("+15551234567"), `got: ${p}`);
  assert.ok(!p.includes("daemon:thread:"), `leaked raw key: ${p}`);
  // Entities + date appended regardless.
  assert.ok(p.includes("Entities: Alice"), `got: ${p}`);
  assert.ok(p.includes("Date: 2026-06-01"), `got: ${p}`);
});

test("project label is the fallback when no thread/conversation resolves", () => {
  const p = buildContextPrefix(projectRow);
  assert.ok(p.startsWith("Conversation: "), `got: ${p}`);
  // Derived generically from project/org entities (NOT hardcoded).
  assert.ok(p.includes("Atlas"), `got: ${p}`);
  assert.ok(p.includes("Source: git-log"), `got: ${p}`);
  assert.ok(p.includes("Date: 2026-06-02"), `got: ${p}`);
});

test("entities-only is the last resort (no Conversation segment)", () => {
  const p = buildContextPrefix(entitiesOnlyRow);
  assert.ok(!p.includes("Conversation:"), `should have no label: ${p}`);
  assert.ok(p.includes("Entities: Bob"), `got: ${p}`);
  assert.ok(p.includes("Date: 2026-04-02"), `got: ${p}`);
});

test("deterministic — same row yields byte-identical prefix across calls", () => {
  const a = buildContextPrefix(projectRow);
  const b = buildContextPrefix(projectRow);
  const c = buildContextPrefix({ ...projectRow });
  assert.equal(a, b);
  assert.equal(a, c);
});

test("defensive — missing/garbage input never throws, returns ''", () => {
  assert.equal(buildContextPrefix(null), "");
  assert.equal(buildContextPrefix(undefined), "");
  assert.equal(buildContextPrefix(42), "");
  assert.equal(buildContextPrefix("nope"), "");
  assert.equal(buildContextPrefix({}), "");
  // Row with only a source still produces a (short) prefix, never throws.
  const p = buildContextPrefix({ source: "git-log" });
  assert.equal(p, "Source: git-log.");
});

test("defensive — malformed entities entry is skipped, not fatal", () => {
  const row = {
    id: "x",
    source: "git-log",
    created_at: "2026-06-02T00:00:00.000Z",
    features: { entities: [null, 7, {}, ent("person", "Carol"), "[object Object]"] },
  };
  const p = buildContextPrefix(row);
  assert.ok(p.includes("Carol"), `got: ${p}`);
  // The "[object Object]" sentinel (recall index-cache bug output) is rejected.
  assert.ok(!p.toLowerCase().includes("[object object]"), `got: ${p}`);
});

test("prefix length bounded to ~PREFIX_MAX_TOKENS even with many entities", () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push(ent("person", `Person${i}name${i}`));
  const row = {
    id: "y",
    source: "imessage",
    created_at: "2026-06-02T00:00:00.000Z",
    provenance: { conversation_id: "daemon:thread:chat:room:day:2026-06-02" },
    features: { entities: many },
  };
  const p = buildContextPrefix(row);
  const tokenCount = __internal.countWsTokens(p);
  assert.ok(
    tokenCount <= PREFIX_MAX_TOKENS,
    `prefix has ${tokenCount} tokens > ${PREFIX_MAX_TOKENS}: ${p}`,
  );
  // Still well-formed (date survives the entity truncation).
  assert.ok(p.includes("Date: 2026-06-02"), `got: ${p}`);
});

test("entity display-names dedupe case-insensitively, preserve order", () => {
  const row = {
    id: "z",
    source: "git-log",
    created_at: "2026-06-02T00:00:00.000Z",
    features: {
      entities: [ent("person", "Dave"), ent("person", "dave"), ent("person", "Eve")],
    },
  };
  const p = buildContextPrefix(row);
  // "Dave" first-seen wins; "dave" deduped; "Eve" follows.
  assert.match(p, /Entities: Dave, Eve\./);
});

test("__internal.isoDate is UTC-stable and rejects bad timestamps", () => {
  assert.equal(__internal.isoDate({ created_at: "2026-06-01T23:59:59.999Z" }), "2026-06-01");
  assert.equal(__internal.isoDate({ created_at: "not-a-date" }), null);
  assert.equal(__internal.isoDate({}), null);
});

test("__internal.deriveThreadLabel extracts the descriptive tokens", () => {
  assert.equal(
    __internal.deriveThreadLabel("daemon:thread:repo:sample-orchard:author:alex@x:day:2026-06-02"),
    "sample-orchard 2026-06-02",
  );
  assert.equal(__internal.deriveThreadLabel(null), null);
  assert.equal(__internal.deriveThreadLabel(""), null);
});

// ===========================================================================
// B + C. bm25-rebuild wiring + the load-bearing prefix-only-match assertion.
// ===========================================================================

// Build a tiny ledger fixture: one anaphoric git-log fact whose content
// NEVER mentions its project ("samplestable") nor the date, but whose
// features.entities carry the project surface. The query "samplestable"
// must match ONLY in the contextual index.
const LEDGER_ROWS = [
  {
    id: "mem_anaphor01",
    kind: "fact",
    content: "fixed the off by one in the redemption loop",
    source: "git-log",
    provenance: { conversation_id: null },
    features: { entities: [ent("project", "samplestable"), ent("person", "alex@example.com", "git-log")] },
    created_at: "2026-06-10T08:00:00.000Z",
  },
  {
    id: "mem_other01",
    kind: "fact",
    content: "bumped dependency versions",
    source: "git-log",
    provenance: { conversation_id: null },
    features: { entities: [ent("project", "acmebot")] },
    created_at: "2026-06-11T08:00:00.000Z",
  },
];

function writeLedgerFixture() {
  const ledgersDir = join(MEMORY_ROOT, "ledgers");
  mkdirSync(ledgersDir, { recursive: true });
  const ledgerPath = join(ledgersDir, "memory.jsonl");
  writeFileSync(ledgerPath, LEDGER_ROWS.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return ledgerPath;
}

// Load a v2 (NDJSON-section) bm25.json that rebuild wrote into an in-memory
// Bm25Index so we can .search() it. Reuses the streaming loader when present;
// otherwise parses the v2 sections inline (kept self-contained so the test
// does not hard-depend on the loader module's exact export name).
function loadV2Index(path) {
  if (loaderMod && typeof loaderMod.loadBm25IndexFromV2File === "function") {
    return loaderMod.loadBm25IndexFromV2File(path);
  }
  const idx = new Bm25Index();
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  const header = JSON.parse(lines[0]);
  if (header && header.params) {
    idx.k1 = header.params.k1;
    idx.b = header.params.b;
  }
  for (let i = 1; i < lines.length; i++) {
    const v = JSON.parse(lines[i]);
    const tag = v[0];
    if (tag === "P") {
      const inner = new Map();
      for (const [docId, tf] of v[2]) inner.set(docId, tf);
      idx._postings.set(v[1], inner);
    } else if (tag === "L") {
      idx._docLen.set(v[1], v[2]);
    } else if (tag === "M") {
      idx._docMeta.set(v[1], v[2]);
    } else if (tag === "E") {
      idx._entityIndex.set(v[1], new Set(v[2]));
    } else if (tag === "D") {
      idx._docEntities.set(v[1], new Set(v[2]));
    }
  }
  if (typeof header.total_doc_len === "number") idx._totalDocLen = header.total_doc_len;
  return idx;
}

test("rebuild ON: result envelope reports contextual_prefix true", () => {
  const ledgerPath = writeLedgerFixture();
  const res = rebuildBm25IndexFromLedger({
    ledgerPath,
    modelVersion: "test-ctx-on",
    contextualPrefix: true,
  });
  assert.equal(res.contextual_prefix, true);
  assert.equal(res.rows_indexed, 2);
});

test("rebuild OFF: result envelope reports contextual_prefix false", () => {
  const ledgerPath = writeLedgerFixture();
  const res = rebuildBm25IndexFromLedger({
    ledgerPath,
    modelVersion: "test-ctx-off",
    contextualPrefix: false,
  });
  assert.equal(res.contextual_prefix, false);
  assert.equal(res.rows_indexed, 2);
});

test("LOAD-BEARING: a prefix-only term matches contextual, NOT baseline", () => {
  const ledgerPath = writeLedgerFixture();
  rebuildBm25IndexFromLedger({ ledgerPath, modelVersion: "test-ctx-on", contextualPrefix: true });
  rebuildBm25IndexFromLedger({ ledgerPath, modelVersion: "test-ctx-off", contextualPrefix: false });

  const onPath = join(MEMORY_ROOT, "indices", "test-ctx-on", "bm25.json");
  const offPath = join(MEMORY_ROOT, "indices", "test-ctx-off", "bm25.json");
  const onIdx = loadV2Index(onPath);
  const offIdx = loadV2Index(offPath);

  // "samplestable" appears ONLY in the prefix (the fact content never says it).
  const onHits = onIdx.search("samplestable", 10);
  const offHits = offIdx.search("samplestable", 10);

  assert.ok(onHits.length >= 1, "contextual index should match the prefix-only term");
  assert.equal(onHits[0].memory_id, "mem_anaphor01");
  assert.equal(offHits.length, 0, "baseline index must NOT match a prefix-only term");
});

test("contextual index still matches real content terms (no regression)", () => {
  const ledgerPath = writeLedgerFixture();
  rebuildBm25IndexFromLedger({ ledgerPath, modelVersion: "test-ctx-on2", contextualPrefix: true });
  const idx = loadV2Index(join(MEMORY_ROOT, "indices", "test-ctx-on2", "bm25.json"));
  const hits = idx.search("redemption", 10);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].memory_id, "mem_anaphor01");
});

test("baseline content of a contextual doc is a superset of baseline tokens", () => {
  // The contextual doc's token-length must be >= the baseline doc's length
  // (prefix only ADDS tokens). Documents the avgdl/length-norm note in code.
  const ledgerPath = writeLedgerFixture();
  rebuildBm25IndexFromLedger({ ledgerPath, modelVersion: "test-len-on", contextualPrefix: true });
  rebuildBm25IndexFromLedger({ ledgerPath, modelVersion: "test-len-off", contextualPrefix: false });
  const onIdx = loadV2Index(join(MEMORY_ROOT, "indices", "test-len-on", "bm25.json"));
  const offIdx = loadV2Index(join(MEMORY_ROOT, "indices", "test-len-off", "bm25.json"));
  const onLen = onIdx._docLen.get("mem_anaphor01");
  const offLen = offIdx._docLen.get("mem_anaphor01");
  assert.ok(onLen > offLen, `contextual len ${onLen} should exceed baseline ${offLen}`);
  // The added length is modest (~the prefix's post-stopword token count).
  assert.ok(onLen - offLen <= PREFIX_MAX_TOKENS, "prefix length should be bounded");
});
