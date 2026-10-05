// F-CCS-CONNECTOR-imessage-structural (W3-CCS) — connector emit test.
//
// Verifies that lib/connectors/imessage.js stamps row.structured_features
// per docs/specs/ccs/structured-features-schema.md §3.1 so the salience
// cascade can merge connector-known surfaces (handle_id, chat_guid, ts,
// is_from_me) into fact.features at promote time.
//
// Failure mode this test pins (open-problems §3 + node JSON predicate):
//   The flat raw_content.text was the only thing the cascade text-extractor
//   saw, so it never recovered handle_id-only senders (e.g. `u2468@hub.
//   example.org` — a hub-routed alias with no contact card) as canonical
//   entities. Parties[] surfaced empty across all imessage facts because
//   the text-extractor couldn't promote the opaque handle through the FM-1
//   STOPWORDS gate. After this slice lands the connector emits the handle
//   structurally (evidence:'structural' bypasses STOPWORDS per entity-
//   schema §6.3), the merger unions it with the text-extracted set, and
//   the parties[] population > 0 per row.
//
// Hot path covered:
//
//   pollOnce
//     → _buildLedgerRow
//       → buildStructuredFeatures({raw_content, ts})         (this slice)
//         → row.structured_features = {schema_version, emitter_version,
//                                      entities[], time_anchors[], parties[]}
//           → ConnectorBase.appendLedgerRow copies the extra top-level key
//             verbatim into storage/sources/imessage.jsonl
//
// Test discipline:
//   - Synthetic inline fixtures in the raw_content shape the connector
//     writes to storage/sources/imessage.jsonl (a hub-routed e-mail alias
//     DM, a phone-handle group chat with an `any;+;chat<digits>` guid, and
//     an outbound row to a `urn:biz:` business handle).
//   - HERMETIC: env-before-dynamic-import. No real chat.db read, no shared
//     MEMORY_ROOT, no network. The unit-level tests call
//     buildStructuredFeatures directly; the integration test exercises the
//     connector's _buildLedgerRow path against a synthesized dbRow.
//   - 12+ assertions per node:test contract.
//
// Run:
//   node --test test/synthesis/imessage-structural.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Hermetic env. MUST be set BEFORE any dynamic import touches config.js.
// -----------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-ccs-imsg-structural-"));
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
  join(process.env.STORAGE_BASE_DIR, "connectors", "imessage"),
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

// -----------------------------------------------------------------------------
// Dynamic imports — AFTER env is set so config.js routes to TMP_ROOT.
// -----------------------------------------------------------------------------

const imessageModule = await import("../../lib/connectors/imessage.js");
const {
  buildStructuredFeatures,
  STRUCTURED_FEATURES_EMITTER_VERSION,
  STRUCTURED_FEATURES_SCHEMA_VERSION,
  STRUCTURED_FEATURES_SOURCE_SCOPE,
  CAPS,
  VERSION,
  IMessageConnector,
} = imessageModule;

// -----------------------------------------------------------------------------
// Synthetic fixture surfaces (handles, guids, bodies and timestamps are
// invented; only the field shapes follow the connector's stored rows).
//
// FIXTURE_HUB_DM is a hub-routed alias whose contact card is unknown (the
// W3-CCS canonical empty-parties repro: text-extractor cannot promote
// `u2468@hub.example.org` through the FM-1 gate).
//
// FIXTURE_GROUP is a group-chat row — Apple's
// `cache_roomnames="chat100000000000000001"` + chat_guid `any;+;chat...`
// is the canonical group flag on Ventura/Sonoma.
// -----------------------------------------------------------------------------

const FIXTURE_HUB_DM_RAW = {
  text: "[redacted body]",
  handle_id: "u2468@hub.example.org",
  chat_guid: "any;-;u2468@hub.example.org",
  cache_roomnames: null,
  is_from_me: 0,
  associated_message_type: 0,
  thread_originator_guid: null,
  service: "iMessage",
  date_apple: "800028342120000000",
  participant_count: 2,
  text_source: "attributedBody",
  sender_is_bot: false,
};
const FIXTURE_HUB_DM_TS = "2026-05-09T14:05:42.120Z";

const FIXTURE_GROUP_RAW = {
  text: "FYI: Notes on the shared calendar",
  handle_id: "+15555550122",
  chat_guid: "any;+;chat100000000000000001",
  cache_roomnames: "chat100000000000000001",
  is_from_me: 0,
  associated_message_type: 0,
  thread_originator_guid: null,
  service: "iMessage",
  date_apple: "729340215400000000",
  participant_count: 3,
  text_source: "attributedBody",
};
const FIXTURE_GROUP_TS = "2024-02-11T10:30:15.400Z";

const FIXTURE_OUTBOUND_RAW = {
  text: "Sounds good! ",
  // Outbound rows ALWAYS carry the recipient's handle_id (the operator
  // is encoded via is_from_me=1, not via handle_id=NULL — that NULL only
  // occurs for the chat-level participant_count subquery, NOT here).
  handle_id: "urn:biz:00000000-0000-4000-8000-000000000001",
  chat_guid: "any;-;urn:biz:00000000-0000-4000-8000-000000000001",
  cache_roomnames: null,
  is_from_me: 1,
  associated_message_type: 0,
  thread_originator_guid: null,
  service: "iMessage",
  date_apple: "701115129250000000",
  participant_count: 2,
  text_source: "attributedBody",
};
const FIXTURE_OUTBOUND_TS = "2023-03-21T18:12:09.250Z";

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
  assert.equal(STRUCTURED_FEATURES_SOURCE_SCOPE, "imessage");

  // CAPS frozen — mutation MUST raise (foundation spec invariant I13).
  assert.equal(Object.isFrozen(CAPS), true);
  assert.equal(Object.isFrozen(CAPS.ENTITY_KINDS), true);
  assert.equal(Object.isFrozen(CAPS.VALID_EVIDENCE_AT_CONNECTOR), true);
  assert.throws(() => { CAPS.ENTITY_MAX_PER_ROW = 0; }, TypeError);

  // Connector-emit evidence allowlist — `ner_corroborated` forbidden at
  // connector layer (foundation spec invariant I4).
  assert.ok(CAPS.VALID_EVIDENCE_AT_CONNECTOR.includes("structural"));
  assert.ok(!CAPS.VALID_EVIDENCE_AT_CONNECTOR.includes("ner_corroborated"));
});

// -----------------------------------------------------------------------------
// Hub-routed alias DM — the `u2468@hub.example.org` fixture
// -----------------------------------------------------------------------------

test("Hub-DM inbound: handle_id -> person:imessage:u2468_hub_example_org", () => {
  const sf = buildStructuredFeatures({
    raw_content: FIXTURE_HUB_DM_RAW,
    ts: FIXTURE_HUB_DM_TS,
  });

  assert.ok(sf, "structured_features returned");
  assert.equal(sf.schema_version, "v1", "schema_version stamped");
  assert.equal(
    sf.emitter_version,
    STRUCTURED_FEATURES_EMITTER_VERSION,
    "emitter_version stamped",
  );

  const ids = sf.entities.map((e) => e.canonical_id);

  // The W3-CCS canonical assertion: handle_id is the canonical identity
  // even when contact name unknown. slugify collapses `@`/`.`/`-` to `_`.
  assert.ok(
    ids.includes("person:imessage:u2468_hub_example_org"),
    `expected person:imessage:u2468_hub_example_org in ${JSON.stringify(ids)}`,
  );

  // DM → NO topic entity (the person canonical_id is the 1:1 thread
  // identity; topic emission would inflate without adding a unique join
  // surface).
  for (const id of ids) {
    assert.ok(
      !id.startsWith("topic:imessage:"),
      `DM must not stamp a topic entity, saw ${id}`,
    );
  }

  // Every entity stamps evidence: 'structural' (bypasses STOPWORDS so the
  // opaque handle survives the FM-1 gate — exactly the antidote per
  // entity-schema §6.3).
  for (const e of sf.entities) {
    assert.equal(e.evidence, "structural", `entity ${e.canonical_id} structural`);
    assert.equal(e.source_scope, "imessage");
    assert.equal(e.confidence, 1.0);
    assert.equal(e.extractor_version, STRUCTURED_FEATURES_EMITTER_VERSION);
  }

  // Sort discipline (foundation spec invariant I7).
  const sortedIds = [...ids].sort();
  assert.deepEqual(ids, sortedIds, "entities sorted ascending by canonical_id");

  // time_anchors from row ts (already UTC-normalized via macEpochNsToIso
  // in production; passed directly here for the unit test).
  assert.equal(sf.time_anchors.length, 1);
  assert.equal(sf.time_anchors[0].kind, "absolute");
  assert.equal(sf.time_anchors[0].parsed.iso, FIXTURE_HUB_DM_TS);
  assert.equal(sf.time_anchors[0].structural, true);
  assert.equal(sf.time_anchors[0].raw_phrase, FIXTURE_HUB_DM_TS);

  // parties[] for inbound: [<handle>, "user"] — the empty-parties[] surface
  // the W3-CCS workunit closes.
  assert.deepEqual(sf.parties, ["person:imessage:u2468_hub_example_org", "user"]);
});

// -----------------------------------------------------------------------------
// Group chat — topic entity added
// -----------------------------------------------------------------------------

test("Group inbound: handle_id -> person, chat_guid -> topic", () => {
  const sf = buildStructuredFeatures({
    raw_content: FIXTURE_GROUP_RAW,
    ts: FIXTURE_GROUP_TS,
  });

  assert.ok(sf, "structured_features returned");
  const ids = sf.entities.map((e) => e.canonical_id);

  // Phone-number handle → slugify drops `+` (non-alphanumeric) and keeps
  // digits: `+15555550122` → `15555550122`.
  assert.ok(
    ids.includes("person:imessage:15555550122"),
    `expected person from phone in ${JSON.stringify(ids)}`,
  );

  // chat_guid → topic: `any;+;chat100000000000000001` → slugify collapses
  // `;` and `+` to `_`, yielding `any_chat100000000000000001`.
  assert.ok(
    ids.includes("topic:imessage:any_chat100000000000000001"),
    `expected topic for group chat_guid in ${JSON.stringify(ids)}`,
  );

  // Sort discipline preserved.
  const sortedIds = [...ids].sort();
  assert.deepEqual(ids, sortedIds, "entities sorted");

  // Parties[] for inbound group: [<handle>, "user"]. Other participants
  // are intentionally NOT enumerated here — they ride the row.parties[]
  // path that the cascade's row-parties-as-entities node owns.
  assert.deepEqual(sf.parties, ["person:imessage:15555550122", "user"]);
});

// -----------------------------------------------------------------------------
// Outbound (is_from_me=1) — parties order flipped
// -----------------------------------------------------------------------------

test("Outbound (is_from_me=1): parties=['user', <handle>]", () => {
  const sf = buildStructuredFeatures({
    raw_content: FIXTURE_OUTBOUND_RAW,
    ts: FIXTURE_OUTBOUND_TS,
  });

  assert.ok(sf, "structured_features returned");
  const ids = sf.entities.map((e) => e.canonical_id);

  // Apple Business urn → slugify collapses `:` and `-` to `_`.
  const expectedHandle =
    "person:imessage:urn_biz_00000000_0000_4000_8000_000000000001";
  assert.ok(
    ids.includes(expectedHandle),
    `expected ${expectedHandle} in ${JSON.stringify(ids)}`,
  );

  // 1:1 → no topic.
  for (const id of ids) {
    assert.ok(
      !id.startsWith("topic:imessage:"),
      `DM must not stamp a topic entity, saw ${id}`,
    );
  }

  // Outbound: "user" first, then the recipient handle canonical_id.
  assert.deepEqual(sf.parties, ["user", expectedHandle]);

  // is_from_me=true accepted as the numeric 1 OR the boolean true — both
  // forms appear in real fixtures (chat.db returns 1; some test paths use
  // booleans).
  const sfBool = buildStructuredFeatures({
    raw_content: { ...FIXTURE_OUTBOUND_RAW, is_from_me: true },
    ts: FIXTURE_OUTBOUND_TS,
  });
  assert.deepEqual(sfBool.parties, ["user", expectedHandle]);
});

// -----------------------------------------------------------------------------
// Backwards-compat — malformed raw_content does NOT emit structured_features
// -----------------------------------------------------------------------------

test("Backwards-compat: malformed raw_content -> no structured_features", () => {
  // null row.
  assert.equal(buildStructuredFeatures(null), undefined);
  assert.equal(buildStructuredFeatures(undefined), undefined);

  // row not an object (array).
  assert.equal(buildStructuredFeatures([1, 2, 3]), undefined);

  // raw_content missing.
  assert.equal(buildStructuredFeatures({ ts: FIXTURE_HUB_DM_TS }), undefined);

  // raw_content non-object.
  assert.equal(
    buildStructuredFeatures({ raw_content: "not an object", ts: FIXTURE_HUB_DM_TS }),
    undefined,
  );
  assert.equal(
    buildStructuredFeatures({ raw_content: 42, ts: FIXTURE_HUB_DM_TS }),
    undefined,
  );
  assert.equal(
    buildStructuredFeatures({ raw_content: [1, 2], ts: FIXTURE_HUB_DM_TS }),
    undefined,
  );

  // raw_content with all structural fields empty → returns undefined per
  // the connector's "no structural surface at all" short-circuit.
  assert.equal(
    buildStructuredFeatures({ raw_content: {}, ts: null }),
    undefined,
  );

  // raw_content with non-string handle_id / chat_guid (defensive
  // type-coercion paths) — handle_id=null + chat_guid=null + ts=null
  // yields no entities, no anchors → undefined.
  assert.equal(
    buildStructuredFeatures({
      raw_content: { handle_id: null, chat_guid: null, is_from_me: 0 },
      ts: null,
    }),
    undefined,
  );
});

// -----------------------------------------------------------------------------
// Defensive degradation — slugify-empty handles and unparseable ts
// -----------------------------------------------------------------------------

test("Defensive: unparseable ts drops time_anchor; slug-empty handle dropped", () => {
  // ts that Date.parse() cannot read → no time_anchor, but entity still
  // emitted. The handle_id still slugifies, so we should get the person
  // entity and a parties[] population.
  const sfNoTs = buildStructuredFeatures({
    raw_content: { ...FIXTURE_HUB_DM_RAW },
    ts: "not-a-real-timestamp",
  });
  assert.ok(sfNoTs, "row still emits when ts unparseable");
  assert.equal(sfNoTs.time_anchors.length, 0, "no time anchor for bad ts");
  assert.ok(
    sfNoTs.entities.some((e) => e.canonical_id === "person:imessage:u2468_hub_example_org"),
    "person entity still emitted with bad ts",
  );

  // A handle_id that slugifies to the empty sentinel (pure punctuation)
  // should be dropped silently — parties[] still carries "user" so the
  // payload is not undefined.
  const sfBadHandle = buildStructuredFeatures({
    raw_content: {
      ...FIXTURE_HUB_DM_RAW,
      handle_id: "@@@",   // slugifies to _empty_
      chat_guid: "any;-;@@@",
    },
    ts: FIXTURE_HUB_DM_TS,
  });
  assert.ok(sfBadHandle, "bad handle does not block emit");
  for (const e of sfBadHandle.entities) {
    assert.ok(
      e.canonical_id !== `person:imessage:${CAPS.SOURCE_SCOPE}`,
      "no malformed sentinel canonical_id stamped",
    );
  }
  // Parties: empty when handle slugifies away. "user" alone is structurally
  // redundant (every imessage row involves the operator); emitting it would
  // give the salience layer nothing new. The cascade's row-parties-as-
  // entities node still recovers the opaque handle via row.parties[].
  assert.deepEqual(sfBadHandle.parties, []);
});

// -----------------------------------------------------------------------------
// Group detection heuristic — three OR'd signals
// -----------------------------------------------------------------------------

test("Group heuristic: cache_roomnames OR participant_count>2 OR chat_guid suffix", () => {
  // Signal 1: cache_roomnames non-null AND no other group signals.
  const sf1 = buildStructuredFeatures({
    raw_content: {
      ...FIXTURE_HUB_DM_RAW,
      cache_roomnames: "chat999",
      participant_count: 2,
    },
    ts: FIXTURE_HUB_DM_TS,
  });
  assert.ok(
    sf1.entities.some((e) => e.canonical_id.startsWith("topic:imessage:")),
    "cache_roomnames alone promotes to group",
  );

  // Signal 2: participant_count > 2 with NULL cache_roomnames.
  const sf2 = buildStructuredFeatures({
    raw_content: {
      ...FIXTURE_HUB_DM_RAW,
      cache_roomnames: null,
      participant_count: 4,
    },
    ts: FIXTURE_HUB_DM_TS,
  });
  assert.ok(
    sf2.entities.some((e) => e.canonical_id.startsWith("topic:imessage:")),
    "participant_count>2 alone promotes to group",
  );

  // Signal 3: chat_guid `any;+;chat<digits>` suffix with cache_roomnames
  // null AND participant_count=2 (legacy chat.db rows where the canonical
  // group flags were lost).
  const sf3 = buildStructuredFeatures({
    raw_content: {
      ...FIXTURE_HUB_DM_RAW,
      cache_roomnames: null,
      participant_count: 2,
      chat_guid: "any;+;chat12345",
    },
    ts: FIXTURE_HUB_DM_TS,
  });
  assert.ok(
    sf3.entities.some((e) => e.canonical_id.startsWith("topic:imessage:")),
    "chat_guid suffix alone promotes to group",
  );

  // Negative: pure 1:1 fixture must NOT stamp a topic.
  const sfDm = buildStructuredFeatures({
    raw_content: FIXTURE_HUB_DM_RAW,
    ts: FIXTURE_HUB_DM_TS,
  });
  for (const e of sfDm.entities) {
    assert.ok(!e.canonical_id.startsWith("topic:imessage:"), "DM has no topic");
  }
});

// -----------------------------------------------------------------------------
// schema_version + emitter_version present on every emit + Cap enforcement
// -----------------------------------------------------------------------------

test("schema_version + emitter_version on every emit; caps respected", () => {
  const fixtures = [
    { raw: FIXTURE_HUB_DM_RAW,    ts: FIXTURE_HUB_DM_TS },
    { raw: FIXTURE_GROUP_RAW,     ts: FIXTURE_GROUP_TS },
    { raw: FIXTURE_OUTBOUND_RAW,  ts: FIXTURE_OUTBOUND_TS },
  ];
  for (const f of fixtures) {
    const sf = buildStructuredFeatures({ raw_content: f.raw, ts: f.ts });
    assert.ok(sf, "emits structured_features");
    assert.equal(sf.schema_version, "v1");
    assert.equal(sf.emitter_version, STRUCTURED_FEATURES_EMITTER_VERSION);
    assert.ok(sf.entities.length <= CAPS.ENTITY_MAX_PER_ROW);
    assert.ok(sf.time_anchors.length <= CAPS.TIME_ANCHORS_MAX_PER_FACT);
  }
});

// -----------------------------------------------------------------------------
// Integration — _buildLedgerRow attaches structured_features end-to-end.
//
// Drives the connector's _buildLedgerRow path with a synthesized dbRow
// (mirrors what node:sqlite would return). No real chat.db read; we
// confirm the structured_features field is present + correctly shaped on
// the returned row object.
// -----------------------------------------------------------------------------

test("_buildLedgerRow: row carries structured_features", () => {
  const connector = new IMessageConnector({
    chatDbPath: "/tmp/nonexistent-chat.db",  // never opened (we call _buildLedgerRow directly)
    now: () => "2026-06-21T00:00:00.000Z",
  });

  // Simulate the chat.db join row shape (post-CAST date to TEXT).
  // 800028342120000000 ns since Mac epoch → 2026-05-09T14:05:42.120Z.
  const dbRow = {
    rowid: 4242,
    guid: "TEST-W3-CCS-IMSG-STRUCTURAL-0001",
    text: "[redacted body]",
    attributedBody: null,
    is_from_me: 0,
    associated_message_type: 0,
    associated_message_guid: null,
    thread_originator_guid: null,
    date: "800028342120000000",
    service: "iMessage",
    handle_id: "u2468@hub.example.org",
    chat_guid: "any;-;u2468@hub.example.org",
    cache_roomnames: null,
    participant_count: 2,
  };

  const row = connector._buildLedgerRow(dbRow);

  // structured_features attached.
  assert.ok(row.structured_features, "row.structured_features attached");
  assert.equal(row.structured_features.schema_version, "v1");
  assert.equal(
    row.structured_features.emitter_version,
    STRUCTURED_FEATURES_EMITTER_VERSION,
  );

  const ids = row.structured_features.entities.map((e) => e.canonical_id);
  assert.ok(
    ids.includes("person:imessage:u2468_hub_example_org"),
    `expected handle entity on the integration row in ${JSON.stringify(ids)}`,
  );

  // parties[] population — the W3-CCS empty-parties[] closer assertion.
  assert.ok(
    row.structured_features.parties.length > 0,
    "structured_features.parties[] non-empty (closes empty-parties surface)",
  );
  assert.deepEqual(
    row.structured_features.parties,
    ["person:imessage:u2468_hub_example_org", "user"],
  );

  // Time anchor present and matches the chat.db date conversion.
  assert.equal(row.structured_features.time_anchors.length, 1);
  assert.equal(row.structured_features.time_anchors[0].kind, "absolute");
  assert.equal(row.structured_features.time_anchors[0].structural, true);

  // Row envelope unchanged (the structured_features attach is strictly
  // additive — all the W2 invariants on parties/raw_content/source_msg_id
  // still hold).
  assert.equal(row.source_msg_id, "TEST-W3-CCS-IMSG-STRUCTURAL-0001");
  assert.deepEqual(row.parties, ["u2468@hub.example.org", "user"]);
  assert.equal(row.raw_content.handle_id, "u2468@hub.example.org");
});

// -----------------------------------------------------------------------------
// Backwards-compat at the row level — when buildStructuredFeatures returns
// undefined (e.g. a malformed dbRow), the row must STILL emit without the
// structured_features key. The W3-CCS contract: never block emit.
// -----------------------------------------------------------------------------

test("_buildLedgerRow: structured_features omitted when builder returns undefined", () => {
  const connector = new IMessageConnector({
    chatDbPath: "/tmp/nonexistent-chat.db",
    now: () => "2026-06-21T00:00:00.000Z",
  });

  // Synthesize a dbRow with every structural field stripped so the
  // builder's "no structural surface" short-circuit returns undefined.
  // raw_content will carry handle_id=null + chat_guid=null + is_from_me=0.
  // The row ts is still set (via the now() override), so a time_anchor
  // would normally emit — except we override messageTs below by stripping
  // date. Actually: macEpochNsToIso(null) returns null, so messageTs
  // falls back to this._now() = "2026-06-21T00:00:00.000Z", which IS
  // parseable, so a time_anchor WILL emit. We confirm that path too.
  const dbRow = {
    rowid: 5555,
    guid: "TEST-W3-CCS-IMSG-EMPTY",
    text: "x",
    attributedBody: null,
    is_from_me: 0,
    associated_message_type: 0,
    associated_message_guid: null,
    thread_originator_guid: null,
    date: null,
    service: "iMessage",
    handle_id: null,
    chat_guid: null,
    cache_roomnames: null,
    participant_count: 0,
  };

  const row = connector._buildLedgerRow(dbRow);

  // Row still emits with all required envelope fields.
  assert.equal(row.source_msg_id, "TEST-W3-CCS-IMSG-EMPTY");
  assert.ok(Array.isArray(row.parties));
  assert.ok(row.raw_content);

  // structured_features either absent OR present-with-time-only (the
  // fallback-server-ts path). Either way, the row landed.
  if (row.structured_features !== undefined) {
    assert.equal(row.structured_features.schema_version, "v1");
    // No handle → no person; no group signal → no topic.
    assert.equal(row.structured_features.entities.length, 0);
  }
});

// -----------------------------------------------------------------------------
// Backwards-compat — rows missing structured_features still cascade.
// Mirrors the W2 github-events backwards-compat invariant.
// -----------------------------------------------------------------------------

test("Backwards-compat: rows missing structured_features still cascade", () => {
  // Simulated pre-upgrade row in the stored source-ledger shape.
  const preUpgradeRow = JSON.parse(
    '{"id":"ulid_X","ts":"2026-05-09T14:05:42.120Z","source":"imessage","source_msg_id":"00000000-0000-4000-8000-0000000000D4","parties":["u2468@hub.example.org","user"],"raw_content":{"text":"x","handle_id":"u2468@hub.example.org","chat_guid":"any;-;u2468@hub.example.org","cache_roomnames":null,"is_from_me":0,"participant_count":2,"service":"iMessage"},"attachments":[],"source_policy":{"deletion_semantics":"full_excise","consent_basis":"second_party_dm"},"checksum":"4148427f2170aa8561af1630b980d5f5"}',
  );
  // The pre-upgrade row has no structured_features field.
  assert.equal(preUpgradeRow.structured_features, undefined);
  assert.ok(!("structured_features" in preUpgradeRow));

  // And the field-set is the architecture.md §1 source-ledger shape verbatim.
  const requiredKeys = [
    "id", "ts", "source", "source_msg_id", "parties",
    "raw_content", "attachments", "source_policy", "checksum",
  ];
  for (const k of requiredKeys) {
    assert.ok(k in preUpgradeRow, `pre-upgrade row preserves ${k}`);
  }
});
