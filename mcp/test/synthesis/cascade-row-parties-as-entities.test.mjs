// F-CCS-CASCADE-row-parties-as-entities — W1-CCS integration test.
//
// Verifies that the cascade stamps row.parties[] (operator-authored audience
// metadata on the source-ledger row) into features.entities[] as kind='person'
// records, scoped to the row's source per entity-schema §5.3, deduped against
// text-extracted entities, and degraded silently on unfamiliar sources.
//
// Hot path under test:
//
//   watermark daemon
//     → scoreCandidate (PROMOTE)
//       → promoteSourceRow   <─── threads event.parties into args
//         → appendFactRow    <─── buildPartyEntity + dedupe runs here
//           → memory.jsonl row carries features.entities including the
//             party-derived person:<source>:<slug> ids.
//
// Test discipline:
//   - HERMETIC: env-before-dynamic-import; all writes under TMP_ROOT.
//   - Drives promoteSourceRow directly (the same appendFactRow chokepoint
//     also serves the MCP handler path; the parties-stamp branch is the
//     same code).
//   - 12+ assertions across multiple separately-named tests.
//   - Synthetic fixtures: handle strings, email surfaces and gh:<login>
//     parties follow the party shapes the connectors write to
//     storage/sources/*.jsonl; every value is invented.
//
// Run:
//   node --test test/synthesis/cascade-row-parties-as-entities.test.mjs

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
// Hermetic env. MUST be set BEFORE any dynamic import touches config.js.
// -----------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-ccs-row-parties-"));
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

function memoryLedgerLines() {
  if (!existsSync(LEDGER_PATH)) return [];
  return readFileSync(LEDGER_PATH, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

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

// Helper: locate the row this promote produced, and return its features.
function featuresFor(memoryEventId) {
  const rows = memoryLedgerLines();
  const row = rows.find((x) => x.id === memoryEventId);
  if (!row) return null;
  return row.features;
}

// -----------------------------------------------------------------------------
// T1 — iMessage handle stamps as person:imessage:<slug(handle)>.
// Fixture shape: imessage.jsonl rows include parties like
// "urn:biz:00000000-..." and bare-email handles like "u2468@hub.example.org".
// -----------------------------------------------------------------------------
test("T1: iMessage handle party stamps as person:imessage entity", async () => {
  const event = {
    source_msg_id: "imsg_test_1",
    source: "imessage",
    ts: "2026-06-01T12:00:00Z",
    parties: ["user", "u2468@hub.example.org"],
    raw_content: { text: "ok thanks" },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "imessage",
    salience: fakePromote(),
  });
  assert.equal(r.ok, true, "promote returns ok");
  const features = featuresFor(r.memory_event_id);
  assert.ok(features, "row located by memory_event_id");
  assert.ok(Array.isArray(features.entities), "features.entities is an array");
  const ids = features.entities.map((e) => e.canonical_id);
  assert.ok(
    ids.includes("person:imessage:u2468_hub_example_org"),
    `expected person:imessage:u2468_hub_example_org in ${JSON.stringify(ids)}`,
  );
  // The "user" sentinel also lands.
  assert.ok(
    ids.includes("person:imessage:user"),
    `expected person:imessage:user in ${JSON.stringify(ids)}`,
  );
  // Source-scope prefix discipline.
  const partyEntities = features.entities.filter(
    (e) => e.stamped_by === "cascade:row-parties",
  );
  assert.equal(
    partyEntities.length,
    2,
    "two party entities stamped (user + handle)",
  );
  for (const e of partyEntities) {
    assert.equal(e.kind, "person", "party entity kind is person");
    assert.equal(e.evidence, "handle", "party entity evidence is 'handle'");
    assert.equal(
      e.source_scope,
      "imessage",
      "party source_scope matches the row's source",
    );
  }
});

// -----------------------------------------------------------------------------
// T2 — chat-claude-code role markers 'user' / 'assistant' stamp as person
// entities under the chat-claude-code source scope (the closed kind enum has
// no 'role'; person:chat-claude-code:user is the schema-conformant id).
// -----------------------------------------------------------------------------
test("T2: chat-claude-code 'user' / 'assistant' parties stamp as person:chat-claude-code entities", async () => {
  const event = {
    source_msg_id: "cc_test_2",
    source: "chat-claude-code",
    ts: "2026-06-01T13:00:00Z",
    parties: ["user", "assistant"],
    raw_content: {
      user_text: "fix the bug",
      assistant_text: "done",
    },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "chat-claude-code",
    salience: fakePromote(),
  });
  const features = featuresFor(r.memory_event_id);
  assert.ok(features, "row exists");
  const ids = features.entities.map((e) => e.canonical_id);
  assert.ok(
    ids.includes("person:chat-claude-code:user"),
    `expected person:chat-claude-code:user in ${JSON.stringify(ids)}`,
  );
  assert.ok(
    ids.includes("person:chat-claude-code:assistant"),
    `expected person:chat-claude-code:assistant in ${JSON.stringify(ids)}`,
  );
  const stamped = features.entities.filter(
    (e) => e.stamped_by === "cascade:row-parties",
  );
  assert.equal(stamped.length, 2, "two party entities stamped");
});

// -----------------------------------------------------------------------------
// T3 — git-log author email stamps verbatim (the spec: "author-email IS the
// surface"). Test fixture mirrors the github-noreply email pattern that
// the git-log connector stores for GitHub-authored commits.
// -----------------------------------------------------------------------------
test("T3: git-log author email party stamps as person:git-log:<slug(email)>", async () => {
  const event = {
    source_msg_id: "git_test_3",
    source: "git-log",
    ts: "2026-06-01T14:00:00Z",
    parties: ["10000001+sam-sample@users.noreply.github.com"],
    raw_content: {
      subject: "fix: tighten edge case",
      author_email: "10000001+sam-sample@users.noreply.github.com",
    },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "git-log",
    salience: fakePromote(),
  });
  const features = featuresFor(r.memory_event_id);
  assert.ok(features, "row exists");
  const ids = features.entities.map((e) => e.canonical_id);
  assert.ok(
    ids.includes(
      "person:git-log:10000001_sam_sample_users_noreply_github_com",
    ),
    `expected person:git-log:10000001_sam_sample_users_noreply_github_com in ${JSON.stringify(ids)}`,
  );
});

// -----------------------------------------------------------------------------
// T4 — github-events actor parties carry the connector's "gh:" prefix; the
// stamp helper strips it so the canonical_id matches the spec's
// `actor.login` derivation (no "gh:" inside the slug).
// -----------------------------------------------------------------------------
test("T4: github-events 'gh:<login>' party stamps as person:github-events:<login> (prefix stripped)", async () => {
  const event = {
    source_msg_id: "gh_test_4",
    source: "github-events",
    ts: "2026-06-01T15:00:00Z",
    parties: ["user", "gh:sam-sample"],
    raw_content: { event_type: "PullRequestEvent", action: "merged" },
    source_policy: { consent_basis: "third_party_inferred" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "github-events",
    salience: fakePromote(),
  });
  const features = featuresFor(r.memory_event_id);
  assert.ok(features, "row exists");
  const ids = features.entities.map((e) => e.canonical_id);
  assert.ok(
    ids.includes("person:github-events:sam_sample"),
    `expected person:github-events:sam_sample (gh: prefix stripped) in ${JSON.stringify(ids)}`,
  );
  assert.ok(
    ids.includes("person:github-events:user"),
    `expected person:github-events:user in ${JSON.stringify(ids)}`,
  );
  // The literal "gh:sam-sample" surface MUST NOT appear in the slug — the
  // prefix is connector-authored, not part of the actor's identity.
  assert.equal(
    ids.includes("person:github-events:gh_sam_sample"),
    false,
    "the literal gh:<login> form is not in the canonical_id list",
  );
});

// -----------------------------------------------------------------------------
// T5 — empty / missing parties cause no crash and stamp no party entities.
// Backwards-compat: a source row written before this stamp ever shipped (no
// parties field) MUST still PROMOTE.
// -----------------------------------------------------------------------------
test("T5: empty parties does not crash; no party entities stamped", async () => {
  const event = {
    source_msg_id: "empty_test_5",
    source: "git-log",
    ts: "2026-06-01T16:00:00Z",
    // parties intentionally OMITTED — pre-cascade-stamp row shape.
    raw_content: { subject: "small refactor" },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "git-log",
    salience: fakePromote(),
  });
  assert.equal(r.ok, true, "PROMOTE still succeeds without parties");
  const features = featuresFor(r.memory_event_id);
  assert.ok(features, "row exists");
  const stamped = (features.entities || []).filter(
    (e) => e.stamped_by === "cascade:row-parties",
  );
  assert.equal(stamped.length, 0, "no party entities stamped when parties absent");
});

// -----------------------------------------------------------------------------
// T6 — duplicate party in parties[] is stamped exactly once. Dedupe key is
// canonical_id; two raw strings that slugify to the same id collapse.
// -----------------------------------------------------------------------------
test("T6: duplicate party is stamped exactly once (canonical_id dedupe)", async () => {
  const event = {
    source_msg_id: "dedupe_test_6",
    source: "imessage",
    ts: "2026-06-01T17:00:00Z",
    // Same handle repeated; also "user" repeated.
    parties: [
      "user",
      "user",
      "+15551234567",
      "+15551234567",
    ],
    raw_content: { text: "ping" },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "imessage",
    salience: fakePromote(),
  });
  const features = featuresFor(r.memory_event_id);
  assert.ok(features, "row exists");
  const stamped = features.entities.filter(
    (e) => e.stamped_by === "cascade:row-parties",
  );
  // Two distinct canonical_ids: person:imessage:user and
  // person:imessage:15551234567.
  assert.equal(
    stamped.length,
    2,
    `expected exactly 2 party entities after dedupe; got ${JSON.stringify(stamped.map((e) => e.canonical_id))}`,
  );
  const ids = stamped.map((e) => e.canonical_id).sort();
  assert.deepEqual(
    ids,
    ["person:imessage:15551234567", "person:imessage:user"],
    "deduped party canonical_ids",
  );
});

// -----------------------------------------------------------------------------
// T7 — unknown source scope (rss is NOT in ENTITY_SOURCE_SCOPES)
// degrades silently: row promotes, no party entities stamped, no throw
// reaches the caller.
// -----------------------------------------------------------------------------
test("T7: unknown source scope (rss) degrades silently with no party stamps", async () => {
  const event = {
    source_msg_id: "codex_test_7",
    source: "rss",
    ts: "2026-06-01T18:00:00Z",
    parties: ["user", "assistant"],
    raw_content: { user_text: "hi", assistant_text: "hello" },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "rss",
    salience: fakePromote(),
  });
  assert.equal(r.ok, true, "row still PROMOTES under unknown source");
  const features = featuresFor(r.memory_event_id);
  assert.ok(features, "row exists");
  // appendFactRow's entity-extractor branch ALSO degrades on rss
  // (extractEntities throws on unknown source); the features.entities slot
  // is therefore an empty array — and the parties stamp likewise refuses to
  // emit. Net: features.entities is [] OR contains zero stamped_by
  // cascade:row-parties records.
  const stamped = (features.entities || []).filter(
    (e) => e.stamped_by === "cascade:row-parties",
  );
  assert.equal(stamped.length, 0, "no party stamps for unknown source scope");
});

// -----------------------------------------------------------------------------
// T8 — party entity coexists with text-extracted entities on the same row.
// The extractor branch runs first and populates features.entities from the
// content; the parties branch then appends without disturbing them.
// -----------------------------------------------------------------------------
test("T8: party entities coexist with text-extracted entities (no replacement)", async () => {
  const event = {
    source_msg_id: "mixed_test_8",
    source: "git-log",
    ts: "2026-06-01T19:00:00Z",
    parties: ["alex.example@example.org"],
    raw_content: {
      subject:
        "uploading https://github.com/alex-example/ExRepo-Check to version control",
    },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "git-log",
    salience: fakePromote(),
  });
  const features = featuresFor(r.memory_event_id);
  assert.ok(features, "row exists");
  const ids = features.entities.map((e) => e.canonical_id);
  // Party email is stamped.
  assert.ok(
    ids.includes("person:git-log:alex_example_example_org"),
    `expected party email canonical_id; got ${JSON.stringify(ids)}`,
  );
  // Text-extracted artifact (URL) is ALSO present from the extractor branch.
  const artifacts = features.entities.filter((e) => e.kind === "artifact");
  assert.ok(
    artifacts.length >= 1,
    `text-extracted artifact(s) still present; got ${JSON.stringify(ids)}`,
  );
});

// -----------------------------------------------------------------------------
// T9 — when a party string would slugify to the SAME canonical_id that the
// text extractor already produced (e.g. an email body that mentions the
// author's email), the parties branch skips it instead of double-stamping.
// -----------------------------------------------------------------------------
test("T9: party with same canonical_id as a text-extracted entity is skipped (no double stamp)", async () => {
  const event = {
    source_msg_id: "collide_test_9",
    source: "git-log",
    ts: "2026-06-01T20:00:00Z",
    parties: ["author@example.com"],
    raw_content: {
      // Subject ALSO mentions the author email — text extractor will harvest it.
      subject: "follow-up from author@example.com about the patch",
    },
    source_policy: { consent_basis: "first_party" },
  };
  const r = await promoteFactMod.promoteSourceRow({
    event,
    source: "git-log",
    salience: fakePromote(),
  });
  const features = featuresFor(r.memory_event_id);
  assert.ok(features, "row exists");
  const matching = features.entities.filter(
    (e) => e.canonical_id === "person:git-log:author_example_com",
  );
  assert.equal(
    matching.length,
    1,
    `expected exactly one entity with the colliding canonical_id; got ${matching.length}`,
  );
});
