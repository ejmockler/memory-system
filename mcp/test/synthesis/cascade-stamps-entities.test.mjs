// F-SYN-INTEGRATION-CASCADE-STAMPS-ENTITIES — integration test.
//
// Verifies that the v0 entity-extractor is invoked from the salience cascade's
// PROMOTE chokepoint (mcp/lib/tools/distill-promote-fact.js appendFactRow)
// and that the resulting features.entities slot on the appended fact row is
// populated.
//
// Hot path under test:
//
//   watermark daemon / MCP handler
//     → scoreCandidate (PROMOTE)
//       → promoteSourceRow / handler
//         → appendFactRow         <─── extractEntities() called here
//           → memory.jsonl row carries features.entities=[...] +
//             features.entity_extractor_version="v0.1.0"
//
// Test discipline:
//   - HERMETIC: all writes under TMP_ROOT; no real storage paths touched.
//   - Drives `promoteSourceRow` directly (the non-MCP entry point) so we
//     don't need to mint daemon-signed tokens / consent-walk the source
//     ledger. The same appendFactRow runs on both paths.
//   - At least 5 assertions across 5 separately named tests.
//
// Run:
//   node --test test/synthesis/cascade-stamps-entities.test.mjs

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

// -----------------------------------------------------------------------------
// Hermetic env. MUST be set BEFORE any dynamic import touches config.js so the
// ledger / policy paths land under TMP_ROOT.
// -----------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-syn-cascade-entities-"));
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
const entityExtractorMod = await import(
  "../../lib/synthesis/entity-extractor.js"
);

const LEDGER_PATH = join(process.env.LEDGERS_BASE_DIR, "memory.jsonl");

function memoryLedgerLines() {
  if (!existsSync(LEDGER_PATH)) return [];
  const text = readFileSync(LEDGER_PATH, "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

// Synthetic salience PROMOTE result. Mirrors the shape scoreCandidate
// produces; only the fields appendFactRow / promoteSourceRow consume are
// populated. embedding_mrl_768 is null because we don't need an HNSW push
// for this test — entities stamp BEFORE the index update branch.
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

// -----------------------------------------------------------------------------
// T1 — happy path: a git-log style content string is run through
// promoteSourceRow; the resulting row carries features.entities with at least
// one project canonical_id whose surface derives from the project name.
// -----------------------------------------------------------------------------
test("T1: promoteSourceRow stamps features.entities with a project canonical_id", async () => {
  // The WU prompt's canonical example: "uploading ExRepo-Check to version
  // control". The v0 extractor's hand-written patterns include GitHub repo
  // paths and other structural shapes. To produce a project entity we
  // include the surrounding repo path the operator's git history uses.
  const content =
    "uploading ExRepo-Check to version control: alex-example/ExRepo-Check#main";

  const event = {
    source_msg_id: "git_test_1",
    source: "git-log",
    ts: "2026-06-01T12:00:00Z",
    raw_content: {
      subject: content,
    },
    source_policy: { consent_basis: "first_party" },
  };

  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "git-log",
    salience: fakePromote(),
  });
  assert.equal(r.ok, true, "promoteSourceRow returns ok=true on PROMOTE");
  assert.ok(typeof r.memory_event_id === "string", "memory_event_id present");

  const rows = memoryLedgerLines();
  assert.ok(rows.length >= 1, "memory.jsonl has at least one row");
  const row = rows.find((x) => x.id === r.memory_event_id);
  assert.ok(row, "the appended row is locatable by memory_event_id");

  // Core assertion: features.entities is an array populated by the extractor.
  assert.ok(
    Array.isArray(row.features.entities),
    "features.entities is an array",
  );
  // The alex-example/ExRepo-Check repo path → org:git-log:alex_example +
  // project:git-log:exrepo_check (the slugify pipeline lowercases + collapses
  // the dash).
  const projectIds = row.features.entities
    .filter((e) => e.kind === "project")
    .map((e) => e.canonical_id);
  assert.ok(
    projectIds.length >= 1,
    `expected at least one project entity; got entities=${JSON.stringify(row.features.entities)}`,
  );
  assert.ok(
    projectIds.some((id) => id.startsWith("project:git-log:")),
    "project canonical_id is source-scoped to 'git-log'",
  );
});

// -----------------------------------------------------------------------------
// T2 — extractor_version is stamped alongside the entities. Without this,
// drift detection (F-SYN-OPERATIONAL-DRIFT-DETECTION) has no anchor.
// -----------------------------------------------------------------------------
test("T2: features.entity_extractor_version mirrors ENTITY_EXTRACTOR_VERSION", async () => {
  const content =
    "Check https://github.com/example-org/widget10 for the latest updates please.";
  const event = {
    source_msg_id: "git_test_2",
    source: "git-log",
    ts: "2026-06-01T13:00:00Z",
    raw_content: { subject: content },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "git-log",
    salience: fakePromote(),
  });
  const rows = memoryLedgerLines();
  const row = rows.find((x) => x.id === r.memory_event_id);
  assert.ok(row, "row is on disk");
  assert.equal(
    row.features.entity_extractor_version,
    entityExtractorMod.ENTITY_EXTRACTOR_VERSION,
    "entity_extractor_version on the row matches the module constant",
  );
  // The URL maps to an artifact entity (kind:'artifact').
  const artifactIds = row.features.entities
    .filter((e) => e.kind === "artifact")
    .map((e) => e.canonical_id);
  assert.ok(
    artifactIds.length >= 1,
    "URL is harvested as an artifact entity",
  );
});

// -----------------------------------------------------------------------------
// T3 — defensive degradation: when the extractor module throws, the cascade
// MUST NOT crash. The row still lands with features.entities=[].
//
// We achieve the throw by manually invoking appendFactRow with a content
// string that is technically valid AND a source that is intentionally NOT
// in ENTITY_SOURCE_SCOPES — extractEntities throws "unknown source" on
// invalid scopes. The integration's try/catch must catch this and degrade.
// -----------------------------------------------------------------------------
test("T3: extractor throw on unknown source scope degrades to features.entities=[]", async () => {
  // 'unknown-source' is NOT in ENTITY_SOURCE_SCOPES — extractEntities throws.
  // We thread this through promoteSourceRow's args.source_refs[0].source
  // mechanic by reaching into the watermark-path entry directly.
  const event = {
    source_msg_id: "unknown_test_3",
    source: "unknown-source",
    ts: "2026-06-01T14:00:00Z",
    raw_content: { text: "Some content uploading ExRepo-Check to repo." },
    source_policy: { consent_basis: "first_party" },
  };
  // promoteSourceRow does not validate against ENTITY_SOURCE_SCOPES — it just
  // builds args.source_refs[0].source = source. appendFactRow will then call
  // extractEntities() with an unknown source, the try/catch will fire, and
  // the row must still land.
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "unknown-source",
    salience: fakePromote(),
  });
  assert.equal(r.ok, true, "row still PROMOTES when extractor throws");
  const rows = memoryLedgerLines();
  const row = rows.find((x) => x.id === r.memory_event_id);
  assert.ok(row, "the row is durably on disk despite extractor throw");
  assert.ok(
    Array.isArray(row.features.entities),
    "features.entities is still an array",
  );
  assert.equal(
    row.features.entities.length,
    0,
    "extractor throw degrades to features.entities=[]",
  );
  // WORKUNIT A-promote-projection (sentinel discipline, MAP finding N2.2):
  // entity_extractor_version is now ALWAYS stamped to the module constant — even
  // on the degrade path — because the constant is safe to read regardless of
  // scorer state and a null/absent version would silently exempt a degraded row
  // from drift-detection re-stamp passes. The degenerate signal is no longer an
  // absent version; it is the explicit features.synth_degraded.reasons[] entry.
  assert.equal(
    row.features.entity_extractor_version,
    entityExtractorMod.ENTITY_EXTRACTOR_VERSION,
    "entity_extractor_version is ALWAYS stamped (sentinel discipline), even on degrade",
  );
  assert.ok(
    row.features.synth_degraded &&
      Array.isArray(row.features.synth_degraded.reasons) &&
      row.features.synth_degraded.reasons.includes("entity_extractor_threw"),
    "the degrade path records synth_degraded.reasons=['entity_extractor_threw']",
  );
});

// -----------------------------------------------------------------------------
// T4 — the same row's features.entities list is sorted ascending by
// canonical_id (foundation spec §4.3, invariant I3). Recall-side comparisons
// rely on stable ordering for the BM25 entry contract.
// -----------------------------------------------------------------------------
test("T4: features.entities are sorted ascending by canonical_id", async () => {
  const content =
    "see https://example.com/x and reach me at user@example.com about " +
    "alex-example/sample-mcp please, also #cascade tag.";
  const event = {
    source_msg_id: "git_test_4",
    source: "git-log",
    ts: "2026-06-01T15:00:00Z",
    raw_content: { subject: content },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "git-log",
    salience: fakePromote(),
  });
  const rows = memoryLedgerLines();
  const row = rows.find((x) => x.id === r.memory_event_id);
  assert.ok(row, "the row exists");
  const ids = row.features.entities.map((e) => e.canonical_id);
  const sorted = [...ids].sort();
  assert.deepEqual(
    ids,
    sorted,
    `features.entities must be ascending by canonical_id; got ${JSON.stringify(ids)}`,
  );
  assert.ok(ids.length >= 2, "multi-pattern content yields multiple entities");
});

// -----------------------------------------------------------------------------
// T5 — every entity record carries a non-empty canonical_id (the recall layer
// only consumes canonical_ids; a malformed entity record would break
// entity_overlap_jaccard silently).
// -----------------------------------------------------------------------------
test("T5: every stamped entity has a non-empty canonical_id with the source-scope prefix", async () => {
  const content =
    "Reach out via user@example.com or call +15555550123 about " +
    "alex-example/ExRepo-Check please.";
  const event = {
    source_msg_id: "git_test_5",
    source: "git-log",
    ts: "2026-06-01T16:00:00Z",
    raw_content: { subject: content },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "git-log",
    salience: fakePromote(),
  });
  const rows = memoryLedgerLines();
  const row = rows.find((x) => x.id === r.memory_event_id);
  assert.ok(row, "the row exists");
  assert.ok(row.features.entities.length >= 1, "at least one entity stamped");
  for (const e of row.features.entities) {
    assert.ok(
      typeof e.canonical_id === "string" && e.canonical_id.length > 0,
      `entity has non-empty canonical_id: ${JSON.stringify(e)}`,
    );
    // The canonical_id format is `<kind>:<source_scope>:<slug>`. For this
    // git-log promote, every canonical_id must be scoped to 'git-log'.
    assert.ok(
      e.canonical_id.includes(":git-log:"),
      `canonical_id must be source-scoped to 'git-log': ${e.canonical_id}`,
    );
    assert.ok(
      typeof e.kind === "string" && e.kind.length > 0,
      "entity carries a kind",
    );
  }
});
