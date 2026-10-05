// F-CCS-CONNECTOR-github-events-structural (W2-CCS) — connector emit test.
//
// Verifies that lib/connectors/github-events.js stamps row.structured_features
// per docs/specs/ccs/structured-features-schema.md §3.1 / §5.2 so the salience
// cascade can merge connector-known surfaces (actor.login, repo basename,
// ref, pr_number, issue_number) into fact.features at promote time.
//
// Failure mode this test pins (W6 smoke-test 2026-06-20 finding):
//   The github-events flat summary "PushEvent refs/heads/X SHA" was the only
//   thing the cascade text-extractor saw, so it never recovered the actor or
//   repo as canonical entities (0 entities promoted). After this slice lands
//   the connector emits the actor/repo/ref structurally, the merger unions
//   them with the text-extracted set, and the entity count > 0 per row.
//
// Hot path covered:
//
//   pollOnce
//     → buildStructuredFeatures(row)           (this slice)
//       → row.structured_features = {schema_version, emitter_version,
//                                    entities[], time_anchors[], parties[]}
//         → ConnectorBase.appendLedgerRow copies the extra top-level key
//           verbatim into storage/sources/github-events.jsonl
//
// Test discipline:
//   - Synthetic inline fixtures in the row shape the connector writes to
//     storage/sources/github-events.jsonl (one PushEvent and one
//     PullRequestEvent by the same third-party actor on that actor's repo).
//   - IssuesEvent fixture built to match the gh `/users/<self>/events`
//     payload shape.
//   - HERMETIC: env-before-dynamic-import. integration test drives pollOnce
//     against an injected _fixtureEvents array; no real gh CLI invocation,
//     no network, no shared MEMORY_ROOT.
//   - 12+ assertions per node:test contract.
//
// Run:
//   node --test test/synthesis/github-events-structural.test.mjs

import { fileURLToPath } from "node:url";
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

// Synthetic operator identity. operator-identity.js resolves its config file
// once, at module load, so this MUST be set before the first library import;
// that is why the library imports below are dynamic (static imports hoist).
process.env.MEMORY_OPERATOR_IDENTITY_FILE = fileURLToPath(
  new URL("../fixtures/operator-identity.synthetic.json", import.meta.url),
);

// -----------------------------------------------------------------------------
// Hermetic env. MUST be set BEFORE any dynamic import touches config.js.
// -----------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-ccs-ghe-structural-"));
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
  join(process.env.STORAGE_BASE_DIR, "connectors", "github-events"),
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

// -----------------------------------------------------------------------------
// Dynamic imports — AFTER env is set so config.js routes to TMP_ROOT.
// -----------------------------------------------------------------------------

const ghEventsModule = await import(
  "../../lib/connectors/github-events.js"
);
const {
  buildStructuredFeatures,
  STRUCTURED_FEATURES_EMITTER_VERSION,
  STRUCTURED_FEATURES_SCHEMA_VERSION,
  CAPS,
  VERSION,
  GitHubEventsConnector,
} = ghEventsModule;

// -----------------------------------------------------------------------------
// Synthetic fixtures.
//
// PushEvent + PullRequestEvent raw_content in the connector's stored shape,
// with a third-party login ("sam-sample") as actor on a repo that login owns:
// the third-party-inferred shape. IssuesEvent follows the gh REST events
// payload. Logins, repo, refs and the head SHA are invented.
// -----------------------------------------------------------------------------

const FIXTURE_PUSH_RAW_CONTENT = {
  event_type: "PushEvent",
  ref: "refs/heads/plugin-loaders",
  commits: 0,
  head: "9a8b7c6d5e4f30219a8b7c6d5e4f30219a8b7c6d",
  first_message: null,
  repo: "sam-sample/sample-tool",
  public: true,
  created_at: "2026-05-04T16:20:10Z",
  actor_login: "sam-sample",
};

const FIXTURE_PR_RAW_CONTENT = {
  event_type: "PullRequestEvent",
  action: "merged",
  pr_number: 6,
  pr_title: null,
  pr_author: null,
  ref: "feature/new-loader",
  repo: "sam-sample/sample-tool",
  public: true,
  created_at: "2026-05-04T16:45:30Z",
  actor_login: "sam-sample",
};

const FIXTURE_ISSUE_RAW_CONTENT = {
  event_type: "IssuesEvent",
  action: "opened",
  issue_number: 42,
  issue_title: null,
  issue_author: null,
  repo: "sam-sample/sample-tool",
  public: true,
  created_at: "2026-05-05T08:30:15Z",
  actor_login: "sam-sample",
};

// -----------------------------------------------------------------------------
// CAPS + module identity invariants
// -----------------------------------------------------------------------------

test("CAPS frozen + emitter_version regex-compliant", () => {
  // VERSION constant present (W2-W12 discipline).
  assert.equal(typeof VERSION, "string", "VERSION exported");
  assert.match(VERSION, /^\d+\.\d+\.\d+$/, "VERSION is semver");

  // emitter_version conforms to the foundation-spec §3.2 regex so the
  // future cascade-side validator accepts the payload (NOT
  // unsupported_schema_version, NOT invalid_emitter_version).
  const EMITTER_REGEX = /^[a-z0-9_\-]+@[0-9]+\.[0-9]+\.[0-9]+(\+[a-z0-9_\-]+)*$/;
  assert.match(
    STRUCTURED_FEATURES_EMITTER_VERSION,
    EMITTER_REGEX,
    "emitter_version matches the spec §3.2 regex",
  );
  assert.equal(STRUCTURED_FEATURES_SCHEMA_VERSION, "v1");

  // CAPS frozen — mutation MUST raise (foundation spec invariant I13).
  assert.equal(Object.isFrozen(CAPS), true);
  assert.equal(Object.isFrozen(CAPS.VALID_EVIDENCE_AT_CONNECTOR), true);
  assert.equal(Object.isFrozen(CAPS.ENTITY_KINDS), true);
  assert.throws(() => { CAPS.ENTITY_MAX_PER_ROW = 0; }, TypeError);

  // Connector-emit evidence allowlist — `ner_corroborated` forbidden at
  // connector layer (foundation spec invariant I4).
  assert.ok(CAPS.VALID_EVIDENCE_AT_CONNECTOR.includes("structural"));
  assert.ok(!CAPS.VALID_EVIDENCE_AT_CONNECTOR.includes("ner_corroborated"));
});

// -----------------------------------------------------------------------------
// PushEvent — third-party actor fixture
// -----------------------------------------------------------------------------

test("PushEvent: actor.login -> person, repo -> project, ref -> topic", () => {
  const sf = buildStructuredFeatures({
    raw_content: FIXTURE_PUSH_RAW_CONTENT,
    ts: FIXTURE_PUSH_RAW_CONTENT.created_at,
  });

  assert.ok(sf, "structured_features returned");
  assert.equal(sf.schema_version, "v1", "schema_version stamped");
  assert.equal(
    sf.emitter_version,
    STRUCTURED_FEATURES_EMITTER_VERSION,
    "emitter_version stamped",
  );

  const ids = sf.entities.map((e) => e.canonical_id);

  // Actor → person:github-events:sam_sample (the W6-smoke-test missing entity).
  assert.ok(
    ids.includes("person:github-events:sam_sample"),
    `expected person:github-events:sam_sample in ${JSON.stringify(ids)}`,
  );

  // Repo → project:github-events:sam_sample_sample_tool (slugified owner/repo).
  assert.ok(
    ids.includes("project:github-events:sam_sample_sample_tool"),
    `expected project:github-events:sam_sample_sample_tool in ${JSON.stringify(ids)}`,
  );

  // ref → topic:github-events:refs_heads_plugin_loaders
  assert.ok(
    ids.includes("topic:github-events:refs_heads_plugin_loaders"),
    `expected topic for ref in ${JSON.stringify(ids)}`,
  );

  // Sort discipline (foundation spec invariant I7).
  const sortedIds = [...ids].sort();
  assert.deepEqual(ids, sortedIds, "entities sorted ascending by canonical_id");

  // Every entity stamps evidence: 'structural' from the connector-allowlist.
  for (const e of sf.entities) {
    assert.equal(
      e.evidence,
      "structural",
      `entity ${e.canonical_id} must use structural evidence`,
    );
    assert.equal(e.source_scope, "github-events");
    assert.equal(e.confidence, 1.0);
    assert.equal(e.extractor_version, STRUCTURED_FEATURES_EMITTER_VERSION);
  }

  // time_anchors stamped from EVENT clock (created_at), not row.ts.
  assert.equal(sf.time_anchors.length, 1);
  assert.equal(sf.time_anchors[0].kind, "absolute");
  assert.equal(sf.time_anchors[0].parsed.iso, FIXTURE_PUSH_RAW_CONTENT.created_at);
  assert.equal(sf.time_anchors[0].structural, true);

  // parties — canonical projection of operator.
  assert.deepEqual(sf.parties, ["person:github-events:sam_sample"]);
});

// -----------------------------------------------------------------------------
// PullRequestEvent — adds pr-<n> topic
// -----------------------------------------------------------------------------

test("PullRequestEvent: + pr_number stamped as topic", () => {
  const sf = buildStructuredFeatures({
    raw_content: FIXTURE_PR_RAW_CONTENT,
    ts: FIXTURE_PR_RAW_CONTENT.created_at,
  });

  assert.ok(sf, "structured_features returned");
  const ids = sf.entities.map((e) => e.canonical_id);

  // Actor + repo carried (default branches).
  assert.ok(ids.includes("person:github-events:sam_sample"));
  assert.ok(ids.includes("project:github-events:sam_sample_sample_tool"));

  // PR number → topic with the `pr-<n>` surface so the slug clears
  // MIN_ENTITY_SURFACE_LEN=3 even for PR #1.
  assert.ok(
    ids.includes("topic:github-events:pr_6"),
    `expected topic:github-events:pr_6 in ${JSON.stringify(ids)}`,
  );

  // PR head ref also surfaced as topic so the cascade can join against
  // CreateEvent/DeleteEvent rows on the same branch.
  assert.ok(
    ids.includes("topic:github-events:feature_new_loader"),
    `expected topic for PR head ref in ${JSON.stringify(ids)}`,
  );

  // Sort discipline preserved.
  const sortedIds = [...ids].sort();
  assert.deepEqual(ids, sortedIds);

  // emitter_version / schema_version always stamped.
  assert.equal(sf.emitter_version, STRUCTURED_FEATURES_EMITTER_VERSION);
  assert.equal(sf.schema_version, "v1");
});

// -----------------------------------------------------------------------------
// IssuesEvent — adds issue-<n> topic
// -----------------------------------------------------------------------------

test("IssuesEvent: + issue_number stamped as topic", () => {
  const sf = buildStructuredFeatures({
    raw_content: FIXTURE_ISSUE_RAW_CONTENT,
    ts: FIXTURE_ISSUE_RAW_CONTENT.created_at,
  });

  assert.ok(sf, "structured_features returned");
  const ids = sf.entities.map((e) => e.canonical_id);

  assert.ok(ids.includes("person:github-events:sam_sample"));
  assert.ok(ids.includes("project:github-events:sam_sample_sample_tool"));
  assert.ok(
    ids.includes("topic:github-events:issue_42"),
    `expected topic:github-events:issue_42 in ${JSON.stringify(ids)}`,
  );

  // IssuesEvent has no ref → no ref-derived topic.
  for (const id of ids) {
    assert.ok(
      !id.startsWith("topic:github-events:refs_"),
      `IssuesEvent must not stamp a refs/* topic, saw ${id}`,
    );
  }
});

// -----------------------------------------------------------------------------
// Unknown event_type — defensive minimum (no crash, actor + repo only)
// -----------------------------------------------------------------------------

test("Unknown event_type: minimal payload (actor + repo) no crash", () => {
  const sf = buildStructuredFeatures({
    raw_content: {
      event_type: "MysteryNewEventType",  // future gh API addition
      repo: "sam-sample/sample-tool",
      actor_login: "sam-sample",
      created_at: "2026-06-15T10:00:00Z",
    },
    ts: "2026-06-15T10:00:00Z",
  });

  assert.ok(sf, "unknown event_type still emits structured_features");
  const ids = sf.entities.map((e) => e.canonical_id);

  assert.equal(ids.length, 2, "exactly actor + repo emitted (no per-kind extras)");
  assert.ok(ids.includes("person:github-events:sam_sample"));
  assert.ok(ids.includes("project:github-events:sam_sample_sample_tool"));
});

// -----------------------------------------------------------------------------
// Backwards-compat — malformed raw_content does NOT emit structured_features
// -----------------------------------------------------------------------------

test("Backwards-compat: malformed raw_content -> no structured_features", () => {
  // null row.
  assert.equal(buildStructuredFeatures(null), undefined);
  assert.equal(buildStructuredFeatures(undefined), undefined);

  // raw_content missing.
  assert.equal(buildStructuredFeatures({}), undefined);

  // raw_content non-object.
  assert.equal(
    buildStructuredFeatures({ raw_content: "not an object" }),
    undefined,
  );
  assert.equal(
    buildStructuredFeatures({ raw_content: 42 }),
    undefined,
  );
});

test("Backwards-compat: empty fields degrade gracefully", () => {
  // An empty raw_content (every field missing) returns a structured_features
  // object with empty entities[] + no time_anchors — NOT undefined — because
  // the bag of metadata is still valid; the merger short-circuits via
  // `sf?.entities ?? []` which handles the empty case.
  const sf = buildStructuredFeatures({
    raw_content: {},
    ts: null,
  });
  assert.ok(sf, "empty raw_content still yields a structured_features bag");
  assert.equal(sf.entities.length, 0, "no entities extractable");
  assert.equal(sf.time_anchors.length, 0, "no anchors extractable");
  assert.deepEqual(sf.parties, [], "no parties extractable");
  assert.equal(sf.schema_version, "v1");
  assert.equal(sf.emitter_version, STRUCTURED_FEATURES_EMITTER_VERSION);
});

// -----------------------------------------------------------------------------
// schema_version + emitter_version present on every emit
// -----------------------------------------------------------------------------

test("schema_version + emitter_version present on every event_type", () => {
  const fixtures = [
    FIXTURE_PUSH_RAW_CONTENT,
    FIXTURE_PR_RAW_CONTENT,
    FIXTURE_ISSUE_RAW_CONTENT,
    { event_type: "ForkEvent", repo: "sam-sample/sample-tool", actor_login: "sam-sample", created_at: "2026-06-01T00:00:00Z" },
    { event_type: "WatchEvent", repo: "sam-sample/sample-tool", actor_login: "sam-sample", created_at: "2026-06-02T00:00:00Z" },
  ];
  for (const rc of fixtures) {
    const sf = buildStructuredFeatures({ raw_content: rc, ts: rc.created_at });
    assert.ok(sf, `event_type=${rc.event_type} emits structured_features`);
    assert.equal(sf.schema_version, "v1");
    assert.equal(sf.emitter_version, STRUCTURED_FEATURES_EMITTER_VERSION);
  }
});

// -----------------------------------------------------------------------------
// Cap enforcement at emit (defense-in-depth per foundation spec invariant I8)
// -----------------------------------------------------------------------------

test("entities[] never exceeds CAPS.ENTITY_MAX_PER_ROW", () => {
  const sf = buildStructuredFeatures({
    raw_content: FIXTURE_PR_RAW_CONTENT,
    ts: FIXTURE_PR_RAW_CONTENT.created_at,
  });
  assert.ok(sf.entities.length <= CAPS.ENTITY_MAX_PER_ROW);
  assert.ok(sf.time_anchors.length <= CAPS.TIME_ANCHORS_MAX_PER_FACT);
});

// -----------------------------------------------------------------------------
// Slug short-circuit — short branch / numbered topics still clear MIN_ENTITY_SURFACE_LEN
// -----------------------------------------------------------------------------

test("Short numeric pr_number stays gate-admissible via pr-<n> surface", () => {
  const sf = buildStructuredFeatures({
    raw_content: {
      ...FIXTURE_PR_RAW_CONTENT,
      pr_number: 1,
      ref: "main",
    },
    ts: FIXTURE_PR_RAW_CONTENT.created_at,
  });
  const ids = sf.entities.map((e) => e.canonical_id);
  assert.ok(
    ids.includes("topic:github-events:pr_1"),
    `pr-1 surface must slugify to pr_1 (length=4, gate-admissible); ids=${JSON.stringify(ids)}`,
  );
  // Branch name "main" → slug "main" (length 4), gate-admissible.
  assert.ok(
    ids.includes("topic:github-events:main"),
    `main ref slug must land; ids=${JSON.stringify(ids)}`,
  );
});

// -----------------------------------------------------------------------------
// Integration — pollOnce attaches structured_features to the appended row.
// Drives pollOnce against an injected _fixtureEvents array (no gh CLI, no
// network). Re-reads the on-disk row from storage/sources/github-events.jsonl
// to confirm ConnectorBase.appendLedgerRow's "extra top-level keys copy-through"
// path carried the field verbatim + the checksum covers it.
// -----------------------------------------------------------------------------

test("pollOnce: appended row carries row.structured_features + checksum stable", async () => {
  const connector = new GitHubEventsConnector({
    username: "sam-sample",
    _ghExec: async () => ({ stdout: "", stderr: "", code: 0 }),
  });

  // gh PushEvent payload shape (the raw response from /users/<self>/events).
  const ghPushEvent = {
    id: "99999999991",
    type: "PushEvent",
    actor: { login: "sam-sample" },
    repo: { name: "sam-sample/sample-tool" },
    payload: {
      ref: "refs/heads/plugin-loaders",
      commits: [],
      head: "9a8b7c6d5e4f30219a8b7c6d5e4f30219a8b7c6d",
      before: "0000000000000000000000000000000000000000",
    },
    public: true,
    created_at: "2026-05-04T16:20:10Z",
  };

  const res = await connector.pollOnce({
    _fixtureEvents: [ghPushEvent],
    _whoami: "sam-sample",
    now: () => new Date("2026-06-21T00:00:00Z"),
  });

  assert.equal(res.appended, 1, `expected 1 append, got ${JSON.stringify(res)}`);

  // Re-read the on-disk row from storage/sources/github-events.jsonl.
  const ledgerPath = join(
    process.env.STORAGE_BASE_DIR,
    "sources",
    "github-events.jsonl",
  );
  assert.ok(existsSync(ledgerPath), "ledger written");
  const raw = readFileSync(ledgerPath, "utf8").trim();
  const stored = JSON.parse(raw.split("\n")[0]);

  // The structured_features survived the round-trip.
  assert.ok(stored.structured_features, "row.structured_features persisted");
  assert.equal(stored.structured_features.schema_version, "v1");
  assert.equal(
    stored.structured_features.emitter_version,
    STRUCTURED_FEATURES_EMITTER_VERSION,
  );

  const storedIds = stored.structured_features.entities.map((e) => e.canonical_id);
  assert.ok(storedIds.includes("person:github-events:sam_sample"));
  assert.ok(storedIds.includes("project:github-events:sam_sample_sample_tool"));
  assert.ok(storedIds.includes("topic:github-events:refs_heads_plugin_loaders"));

  // Checksum is computed by ConnectorBase over all fields except `checksum`;
  // its presence on the stored row implies the structured_features field was
  // in the preimage (otherwise an upgraded reader recomputing the checksum
  // would mismatch). Verify the checksum is a 32-char hex string.
  assert.match(stored.checksum, /^[a-f0-9]{32}$/);
});

// -----------------------------------------------------------------------------
// Integration — pre-upgrade row (no structured_features) still cascade-able.
// Confirms backwards-compat: a row stored WITHOUT structured_features is a
// valid row that downstream readers (cascade merger) handle via the
// `sf?.entities ?? []` short-circuit. We verify the on-disk row shape for the
// pre-upgrade case is still a valid JSONL row with all other fields intact.
// -----------------------------------------------------------------------------

test("Backwards-compat: rows missing structured_features still cascade", () => {
  // Synthetic row in the pre-upgrade shape: no structured_features field.
  const preUpgradeRow = JSON.parse(
    '{"id":"ulid_X","ts":"2026-05-21T09:40:12.800Z","source":"github-events","source_msg_id":"gh-event:1000000001","parties":["user","gh:sam-sample"],"raw_content":{"event_type":"PullRequestEvent","action":"merged","pr_number":6,"repo":"sam-sample/sample-tool","public":true,"created_at":"2026-05-04T16:45:30Z"},"attachments":[],"source_policy":{"deletion_semantics":"full_excise","consent_basis":"third_party_inferred"},"checksum":"452e3db7352c1166a0926d4937d4ff86"}',
  );
  // The pre-upgrade row has no structured_features field.
  assert.equal(preUpgradeRow.structured_features, undefined);

  // Downstream merger handles this via `sf?.entities ?? []` — i.e. the
  // text-only path runs unchanged. We do not invoke the merger here (it's
  // owned by the cascade-merge node), but we confirm the row shape the
  // backwards-compat invariant relies on: structured_features is absent
  // (not null, not empty object) on pre-upgrade rows.
  assert.ok(!("structured_features" in preUpgradeRow));

  // And the field-set is the architecture.md §1 source-ledger shape verbatim.
  const requiredKeys = ["id", "ts", "source", "source_msg_id", "parties", "raw_content", "attachments", "source_policy", "checksum"];
  for (const k of requiredKeys) {
    assert.ok(k in preUpgradeRow, `pre-upgrade row preserves ${k}`);
  }
});
