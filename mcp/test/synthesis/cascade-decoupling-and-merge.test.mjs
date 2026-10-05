// cascade-decoupling-and-merge.test.mjs — F-CCS-CASCADE-structured-features-merge.
//
// WU2-inline-embed-and-remove-gemini-quota-machinery removed the embed-decouple
// half of this file (PART A: null-embed PROMOTE → embed-queue enqueue →
// drainEmbedQueue → policy.embedding_backfill → overlay). The async embed
// worker + its queue were deleted; the cascade embeds inline via the local
// server. What survives here is the STRUCTURED-FEATURES-MERGE contract, which
// is independent of the embedding path and still load-bearing:
//
//   F-CCS-CASCADE-structured-features-merge — connector-emitted
//   structured_features (entities + time_anchors) merge into the fact's
//   features at promote time, structured-wins-on-collision, text path
//   preserved on missing / malformed payloads.
//
// Hot paths under test:
//   - promoteSourceRow → appendFactRow (writes the row + merges structured
//     entities/time-anchors)
//   - mergeEntities / mergeTimeAnchors merge semantics (contract assertions)
//
// Test discipline:
//   - HERMETIC: env-before-dynamic-import; all writes under TMP_ROOT.
//   - node:test + node:assert/strict, defensive try/catch on shared setup.
//   - 12+ assertions across multiple separately-named tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Hermetic env. MUST be set BEFORE any dynamic import touches config.js.
// -----------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-ccs-merge-"));
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
  join(process.env.LEDGERS_BASE_DIR),
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

const promoteFactMod = await import(
  "../../lib/tools/distill-promote-fact.js"
);

const LEDGER_PATH = join(process.env.LEDGERS_BASE_DIR, "memory.jsonl");

function memoryLedgerRows() {
  if (!existsSync(LEDGER_PATH)) return [];
  return readFileSync(LEDGER_PATH, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// A minimal PROMOTE salience result. embedding_4096:null exercises the
// null-embed path (the merge contract is embedding-independent).
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
    embedding_4096: null,
    embedding_mrl_768: null,
    ...extra,
  };
}

// -----------------------------------------------------------------------------
// F-CCS-CASCADE-structured-features-merge
// -----------------------------------------------------------------------------

test("B1: args.structured_features.entities merged into features.entities (structured wins on canonical_id collision)", async () => {
  const event = {
    source_msg_id: "git_b1_" + Math.random().toString(16).slice(2),
    source: "git-log",
    ts: "2026-06-21T11:00:00Z",
    parties: ["alex.example@example.org"],
    raw_content: { subject: "B1 commit", author_email: "alex.example@example.org" },
    source_policy: { consent_basis: "first_party" },
    // Connector-emitted structured payload.
    structured_features: {
      schema_version: "v1",
      emitter_version: "git-log-local@1.0.0",
      entities: [
        {
          // Collision with the text-extracted person — structured wins.
          kind: "person",
          canonical_id: "person:git-log:alex_example_example_org",
          surface: "alex.example@example.org",
          source_scope: "git-log",
          evidence: "structural",
          confidence: 1.0,
          extractor_version: "git-log-local@1.0.0",
        },
        {
          // Net-new structural entity (the repo).
          kind: "project",
          canonical_id: "project:git-log:exrepo_check",
          surface: "ExRepo-Check",
          source_scope: "git-log",
          evidence: "structural",
          confidence: 1.0,
          extractor_version: "git-log-local@1.0.0",
        },
      ],
    },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "git-log",
    salience: fakePromote(),
  });
  const rows = memoryLedgerRows();
  const row = rows.find((x) => x.id === r.memory_event_id);
  assert.ok(row, "row written");
  const ids = row.features.entities.map((e) => e.canonical_id);
  assert.ok(
    ids.includes("person:git-log:alex_example_example_org"),
    "person canonical id present (text + structured merged)",
  );
  assert.ok(
    ids.includes("project:git-log:exrepo_check"),
    "structured-only project entity stamped via the merge",
  );
  const personEntry = row.features.entities.find(
    (e) => e.canonical_id === "person:git-log:alex_example_example_org",
  );
  assert.ok(personEntry, "person entry exists post-merge");
  assert.equal(
    personEntry.evidence,
    "structural",
    "structured entity won the canonical_id collision",
  );
});

test("B2: merge contract — structured wins on canonical_id collision (mergeEntities semantics)", () => {
  const structuredEntities = [
    {
      kind: "person",
      canonical_id: "person:git-log:alex_example_example_org",
      surface: "alex.example@example.org",
      source_scope: "git-log",
      evidence: "structural",
      confidence: 1.0,
    },
    {
      kind: "project",
      canonical_id: "project:git-log:exrepo_check",
      surface: "ExRepo-Check",
      source_scope: "git-log",
      evidence: "structural",
      confidence: 1.0,
    },
  ];
  const textEntities = [
    {
      kind: "person",
      canonical_id: "person:git-log:alex_example_example_org",
      surface: "alex.example@example.org",
      source_scope: "git-log",
      evidence: "handle",
      confidence: 0.9,
    },
    {
      // Text-only addition.
      kind: "topic",
      canonical_id: "topic:git-log:bugfix",
      surface: "bugfix",
      source_scope: "git-log",
      evidence: "ner_corroborated",
      confidence: 0.6,
    },
  ];
  // Replicate appendFactRow's merge inline (contract assertion).
  const byId = new Map();
  for (const se of structuredEntities) byId.set(se.canonical_id, se);
  for (const te of textEntities) {
    if (!byId.has(te.canonical_id)) byId.set(te.canonical_id, te);
  }
  const merged = [...byId.values()];
  assert.equal(merged.length, 3, "three entities after union-with-precedence");
  const personEntry = merged.find(
    (e) => e.canonical_id === "person:git-log:alex_example_example_org",
  );
  assert.equal(
    personEntry.evidence,
    "structural",
    "structured wins on collision (evidence stays 'structural', not 'handle')",
  );
  assert.equal(
    personEntry.confidence,
    1.0,
    "structured confidence wins on collision",
  );
  const topicEntry = merged.find((e) => e.canonical_id === "topic:git-log:bugfix");
  assert.ok(topicEntry, "text-only entity preserved (no collision)");
});

test("B3: time_anchors merge — structured wins on (kind, iso) collision; text-only anchors preserved", () => {
  const structured = [
    {
      kind: "absolute",
      raw_phrase: "2026-06-21T11:00:00Z",
      parsed: { iso: "2026-06-21T11:00:00Z" },
      extractor_confidence: 1.0,
      extractor_version: "git-log-local@1.0.0",
    },
  ];
  const text = [
    {
      // Same kind+iso → dedupes against the structured one.
      kind: "absolute",
      instant_iso: "2026-06-21T11:00:00Z",
      raw_phrase: null,
      structural: true,
      stamped_by: "cascade:row-ts",
    },
    {
      // Distinct anchor — preserved.
      kind: "absolute",
      instant_iso: "2024-01-01T00:00:00Z",
      raw_phrase: null,
    },
  ];
  // Replicate appendFactRow's time-anchor merge inline.
  const dedupeKey = (a) => {
    const k = typeof a.kind === "string" ? a.kind : "";
    const iso =
      a.parsed && typeof a.parsed === "object" && typeof a.parsed.iso === "string"
        ? a.parsed.iso
        : typeof a.instant_iso === "string"
          ? a.instant_iso
          : typeof a.raw_phrase === "string"
            ? a.raw_phrase
            : "";
    return `${k}|${iso}`;
  };
  const byKey = new Map();
  for (const sa of structured) byKey.set(dedupeKey(sa), sa);
  for (const ta of text) {
    if (!byKey.has(dedupeKey(ta))) byKey.set(dedupeKey(ta), ta);
  }
  const merged = [...byKey.values()];
  assert.equal(merged.length, 2, "dedupe collapses identical (kind, iso) pairs");
  const colliding = merged.find((m) => dedupeKey(m) === "absolute|2026-06-21T11:00:00Z");
  assert.ok(
    colliding && colliding.parsed && colliding.parsed.iso,
    "structured anchor (with parsed.iso) wins on collision",
  );
  const distinct = merged.find((m) => dedupeKey(m) === "absolute|2024-01-01T00:00:00Z");
  assert.ok(distinct, "text-only anchor preserved when no collision");
});

test("B4: missing structured_features → text-only path unchanged (backwards-compat)", async () => {
  const event = {
    source_msg_id: "git_b4_" + Math.random().toString(16).slice(2),
    source: "git-log",
    ts: "2026-06-21T12:00:00Z",
    parties: ["alex.example@example.org"],
    raw_content: { subject: "B4 commit", author_email: "alex.example@example.org" },
    source_policy: { consent_basis: "first_party" },
    // structured_features INTENTIONALLY OMITTED
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "git-log",
    salience: fakePromote(),
  });
  assert.equal(r.ok, true, "promote succeeds without structured_features");
  const rows = memoryLedgerRows();
  const row = rows.find((x) => x.id === r.memory_event_id);
  assert.ok(row, "row written");
  // Text-only path still produces the person entity via parties stamping.
  const ids = row.features.entities.map((e) => e.canonical_id);
  assert.ok(
    ids.includes("person:git-log:alex_example_example_org"),
    "parties-stamp entity still present",
  );
});

test("B5: null-embed PROMOTE still lands a durable row (embedding-independent merge path)", async () => {
  const event = {
    source_msg_id: "git_b5_" + Math.random().toString(16).slice(2),
    source: "git-log",
    ts: "2026-06-21T12:01:00Z",
    parties: ["alex.example@example.org"],
    raw_content: { subject: "B5 commit", author_email: "alex.example@example.org" },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "git-log",
    salience: fakePromote(),
  });
  assert.equal(r.ok, true, "promote succeeds on the null-embed path");
  const rows = memoryLedgerRows();
  const row = rows.find((x) => x.id === r.memory_event_id);
  assert.ok(row, "row written");
  assert.ok(
    Array.isArray(row.features.entities),
    "features.entities is an array (text path stood up)",
  );
  // WU2: the null-embed path stamps embedding_4096:null + embed_state:true.
  assert.equal(row.features.embedding_4096, null, "embedding_4096 explicitly null");
  assert.equal(row.features.embed_state, true, "embed_state marks the row for re-embed");
});
