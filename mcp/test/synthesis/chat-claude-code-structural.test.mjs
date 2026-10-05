// F-CCS-CONNECTOR-chat-claude-code-structural (W3-CCS) — connector emit test.
//
// Verifies that lib/connectors/chat-claude-code.js stamps row.structured_features
// per docs/specs/ccs/structured-features-schema.md §3.1 so the salience cascade
// can merge connector-known surfaces (conversation_id, cwd) into fact.features
// at promote time.
//
// Failure mode this test pins (W9 audit 2026-06-19 finding):
//   The chat-cc source ran a 59.8% empty-rate over the trailing 7d window,
//   and the substantive remainder landed without a structural anchor so the
//   cascade text-extractor re-derived ad-hoc entities per turn instead of
//   collapsing on the canonical conversation_id + cwd pair. After this slice
//   lands the emit-time helper stamps a topic per conversation_id and a
//   project per cwd-basename so merger union-by-canonical-id collapses N
//   turns of the same session into the same anchor.
//
// Hot path covered:
//
//   future stop-hook update / future feature-backfill engine
//     → buildStructuredFeatures(row)             (this slice)
//       → row.structured_features = {schema_version, emitter_version,
//                                    entities[], time_anchors[], parties[]}
//
// Test discipline:
//   - Synthetic inline fixtures in the row shape hooks/stop-hook.sh writes
//     to storage/sources/chat-claude-code.jsonl (a UUID conversation_id
//     with an absolute cwd, and a short id with cwd:null).
//   - HERMETIC: env-before-dynamic-import. No real connector daemon (chat-cc
//     rows are emitted by hooks/stop-hook.sh, a bash script; this module is
//     a pure helper consumed by the future stop-hook update + the backfill
//     engine). The test exercises buildStructuredFeatures directly.
//   - 12+ assertions per node:test contract.
//
// Run:
//   node --test test/synthesis/chat-claude-code-structural.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Hermetic env. MUST be set BEFORE any dynamic import touches config.js.
// The chat-cc connector helper is pure — no I/O — but the entity-extractor
// import path it pulls in transitively reads config.js, so we route through
// a tmp MEMORY_ROOT for parity with the other structural-emitter tests.
// -----------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-ccs-chatcc-structural-"));
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

// -----------------------------------------------------------------------------
// Dynamic imports — AFTER env is set.
// -----------------------------------------------------------------------------

const chatCcModule = await import(
  "../../lib/connectors/chat-claude-code.js"
);
const {
  buildStructuredFeatures,
  STRUCTURED_FEATURES_SCHEMA_VERSION,
  STRUCTURED_FEATURES_EMITTER_VERSION,
  STRUCTURED_FEATURES_SOURCE_SCOPE,
  VERSION,
  CAPS,
  _internals,
} = chatCcModule;

// -----------------------------------------------------------------------------
// Synthetic fixtures (ids, hashes, texts, timestamps and cwd are invented).
//
// The FIXTURE_WITH_CWD row is a turn taken inside a nested project
// directory (/home/alex/projects/example-repo/mcp); the FIXTURE_WITHOUT_CWD row
// is a smoke turn carrying cwd:null (the pre-cwd-stamp row shape).
// -----------------------------------------------------------------------------

const FIXTURE_WITH_CWD = {
  id: "ulid_00EXAMPLECHATROW0001",
  ts: "2026-06-11T09:42:18.640Z",
  source: "chat-claude-code",
  source_msg_id:
    "1111111111111111222222222222222233333333333333334444444444444444",
  parties: ["user", "assistant"],
  raw_content: {
    conversation_id: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
    turn_index: null,
    user_text: "now wire up the structural emitter",
    assistant_text:
      "Emitter wired: the row carries this turn's prompt and my reply.",
    runtime: "claude-code",
    cwd: "/home/alex/projects/example-repo/mcp",
  },
};

const FIXTURE_WITHOUT_CWD = {
  id: "ulid_00EXAMPLECHATROW0002",
  ts: "2026-05-28T07:10:44.905Z",
  source: "chat-claude-code",
  source_msg_id:
    "5555555555555555666666666666666677777777777777778888888888888888",
  parties: ["user", "assistant"],
  raw_content: {
    conversation_id: "conv_smoke",
    turn_index: null,
    user_text: "hi",
    assistant_text: "hello",
    runtime: "claude-code",
    cwd: null,
  },
};

// =============================================================================
// CAPS + module identity invariants
// =============================================================================

test("CAPS frozen + emitter_version regex-compliant", () => {
  // VERSION constant present (W2-W12 discipline).
  assert.equal(typeof VERSION, "string", "VERSION exported");

  // emitter_version conforms to the foundation-spec §3.2 regex so the
  // future cascade-side validator accepts the payload.
  const EMITTER_REGEX = /^[a-z0-9_\-]+@[0-9]+\.[0-9]+\.[0-9]+(\+[a-z0-9_\-]+)*$/;
  assert.match(
    STRUCTURED_FEATURES_EMITTER_VERSION,
    EMITTER_REGEX,
    "emitter_version matches spec §3.2 regex",
  );
  assert.equal(STRUCTURED_FEATURES_SCHEMA_VERSION, "v1");
  assert.equal(STRUCTURED_FEATURES_SOURCE_SCOPE, "chat-claude-code");

  // CAPS frozen — mutation MUST raise (foundation spec invariant I13).
  assert.equal(Object.isFrozen(CAPS), true, "CAPS frozen");
  assert.equal(Object.isFrozen(CAPS.VALID_EVIDENCE_AT_CONNECTOR), true);
  assert.equal(Object.isFrozen(CAPS.ENTITY_KINDS), true);
  assert.throws(() => {
    CAPS.ENTITY_MAX_PER_ROW = 0;
  }, TypeError);

  // Connector-emit evidence allowlist — `ner_corroborated` forbidden at
  // connector layer (foundation spec invariant I4).
  assert.ok(CAPS.VALID_EVIDENCE_AT_CONNECTOR.includes("structural"));
  assert.ok(!CAPS.VALID_EVIDENCE_AT_CONNECTOR.includes("ner_corroborated"));

  // CAPS surface mirrors the W2 sibling emitters (git-log + github-events).
  assert.equal(CAPS.SCHEMA_VERSION, "v1");
  assert.equal(CAPS.EMITTER_VERSION, STRUCTURED_FEATURES_EMITTER_VERSION);
  assert.equal(CAPS.SOURCE_SCOPE, "chat-claude-code");
  assert.equal(CAPS.ENTITY_MAX_PER_ROW, 32);
});

// =============================================================================
// Fixture WITH cwd — full structural payload
// =============================================================================

test("stored-shape turn (with cwd): conversation_id → topic, cwd → project", () => {
  const sf = buildStructuredFeatures(FIXTURE_WITH_CWD);

  assert.ok(sf, "structured_features returned");
  assert.equal(sf.schema_version, "v1", "schema_version stamped");
  assert.equal(
    sf.emitter_version,
    STRUCTURED_FEATURES_EMITTER_VERSION,
    "emitter_version stamped",
  );

  const ids = sf.entities.map((e) => e.canonical_id);

  // Conversation id → topic. The UUID slugifies to the lowercase hyphen-
  // collapsed form (`1f2e3d4c_5b6a_4978_8a9b_0c1d2e3f4a5b`).
  assert.ok(
    ids.includes(
      "topic:chat-claude-code:1f2e3d4c_5b6a_4978_8a9b_0c1d2e3f4a5b",
    ),
    `expected topic for conversation_id in ${JSON.stringify(ids)}`,
  );

  // cwd basename `mcp` → project. Length 3 clears MIN_ENTITY_LENGTH=3.
  assert.ok(
    ids.includes("project:chat-claude-code:mcp"),
    `expected project:chat-claude-code:mcp in ${JSON.stringify(ids)}`,
  );

  // Sort discipline (foundation spec invariant I7).
  const sortedIds = [...ids].sort();
  assert.deepEqual(ids, sortedIds, "entities sorted ascending by canonical_id");

  // Every entity stamps evidence: 'structural' from the connector allowlist.
  for (const e of sf.entities) {
    assert.equal(
      e.evidence,
      "structural",
      `entity ${e.canonical_id} must use structural evidence`,
    );
    assert.equal(e.source_scope, "chat-claude-code");
    assert.equal(e.confidence, 1.0);
    assert.equal(e.extractor_version, STRUCTURED_FEATURES_EMITTER_VERSION);
  }

  // time_anchors stamped from row.ts (the turn clock the stop-hook writes).
  assert.equal(sf.time_anchors.length, 1, "exactly one time anchor stamped");
  assert.equal(sf.time_anchors[0].kind, "absolute");
  assert.equal(
    sf.time_anchors[0].parsed.iso,
    FIXTURE_WITH_CWD.ts,
    "anchor parsed.iso equals row.ts (already canonical UTC)",
  );
  assert.equal(sf.time_anchors[0].structural, true, "structural:true wins ties");
  assert.equal(sf.time_anchors[0].raw_phrase, FIXTURE_WITH_CWD.ts);

  // parties — canonical projection of ["user","assistant"] per chat-cc
  // semantics. Insertion order is [user, assistant] mirroring the stop-hook
  // contract (`parties: ["user","assistant"]` literal in hooks/stop-hook.sh).
  assert.deepEqual(
    sf.parties,
    [
      "person:chat-claude-code:user",
      "person:chat-claude-code:assistant",
    ],
    "parties canonicalize user+assistant in stop-hook insertion order",
  );
});

// =============================================================================
// Fixture WITHOUT cwd — no project entity, no crash
// =============================================================================

test("cwd absent (null): no project entity stamped, no crash", () => {
  const sf = buildStructuredFeatures(FIXTURE_WITHOUT_CWD);

  assert.ok(sf, "structured_features returned even without cwd");
  const ids = sf.entities.map((e) => e.canonical_id);

  // Topic for the (admittedly short) conversation_id. `conv_smoke` slugifies
  // to `conv_smoke` (length 10 >= MIN_ENTITY_LENGTH=3).
  assert.ok(
    ids.includes("topic:chat-claude-code:conv_smoke"),
    `expected topic:chat-claude-code:conv_smoke in ${JSON.stringify(ids)}`,
  );

  // No project entity (cwd was null).
  for (const id of ids) {
    assert.ok(
      !id.startsWith("project:chat-claude-code:"),
      `cwd-null row must NOT stamp a project entity, saw ${id}`,
    );
  }

  // time_anchors still stamped from row.ts.
  assert.equal(sf.time_anchors.length, 1);
  assert.equal(sf.time_anchors[0].parsed.iso, FIXTURE_WITHOUT_CWD.ts);
  assert.equal(sf.time_anchors[0].structural, true);

  // parties still ["user","assistant"] — those are invariant per stop-hook.
  assert.equal(sf.parties.length, 2);
  assert.ok(sf.parties.includes("person:chat-claude-code:user"));
  assert.ok(sf.parties.includes("person:chat-claude-code:assistant"));
});

// =============================================================================
// cwd present but trailing-slash / pure-root — basename degrades safely
// =============================================================================

test("cwd basename: trailing slash trimmed; nested path collapses to leaf", () => {
  const sfTrailing = buildStructuredFeatures({
    ts: "2026-06-21T10:00:00.000Z",
    raw_content: {
      conversation_id: "conv-trail-1",
      cwd: "/home/alex/projects/example-repo/mcp/",
    },
  });
  const idsTrailing = sfTrailing.entities.map((e) => e.canonical_id);
  assert.ok(
    idsTrailing.includes("project:chat-claude-code:mcp"),
    `trailing-slash cwd must basename to "mcp"; ids=${JSON.stringify(idsTrailing)}`,
  );

  // Pure root "/" basenames to "" → no project (defensive, NOT crash).
  const sfRoot = buildStructuredFeatures({
    ts: "2026-06-21T10:00:00.000Z",
    raw_content: {
      conversation_id: "conv-root-1",
      cwd: "/",
    },
  });
  const idsRoot = sfRoot.entities.map((e) => e.canonical_id);
  for (const id of idsRoot) {
    assert.ok(
      !id.startsWith("project:chat-claude-code:"),
      `cwd=/ must NOT stamp a project, saw ${id}`,
    );
  }

  // _basename internals exposed for direct assertion.
  assert.equal(_internals._basename("/home/alex/projects/example-repo/mcp"), "mcp");
  assert.equal(_internals._basename("/home/alex/projects/example-repo/mcp/"), "mcp");
  assert.equal(_internals._basename(""), "");
  assert.equal(_internals._basename(null), "");
});

// =============================================================================
// Backwards-compat — malformed row → undefined (no crash, no structured_features)
// =============================================================================

test("Backwards-compat: malformed row -> undefined (no structured_features stamped)", () => {
  // null / undefined.
  assert.equal(buildStructuredFeatures(null), undefined);
  assert.equal(buildStructuredFeatures(undefined), undefined);

  // Non-object inputs.
  assert.equal(buildStructuredFeatures("not a row"), undefined);
  assert.equal(buildStructuredFeatures(42), undefined);
  assert.equal(buildStructuredFeatures([]), undefined);

  // raw_content missing.
  assert.equal(buildStructuredFeatures({ ts: "2026-06-21T00:00:00Z" }), undefined);

  // raw_content non-object.
  assert.equal(
    buildStructuredFeatures({ raw_content: "not an object" }),
    undefined,
  );
  assert.equal(buildStructuredFeatures({ raw_content: 42 }), undefined);
  assert.equal(buildStructuredFeatures({ raw_content: [] }), undefined);
});

test("Backwards-compat: empty raw_content yields valid-but-minimal payload", () => {
  // An empty raw_content still returns a structured_features object — the
  // bag of metadata (parties always user+assistant, schema_version,
  // emitter_version) is valid even when no extractable entities exist.
  // Mirrors the github-events pattern.
  const sf = buildStructuredFeatures({
    ts: "2026-06-21T00:00:00.000Z",
    raw_content: {},
  });
  assert.ok(sf, "empty raw_content still yields a structured_features bag");
  assert.equal(sf.entities.length, 0, "no entities extractable");
  // ts present → one time anchor still stamped.
  assert.equal(sf.time_anchors.length, 1);
  // parties are stop-hook invariant — always present.
  assert.equal(sf.parties.length, 2);
  assert.equal(sf.schema_version, "v1");
  assert.equal(sf.emitter_version, STRUCTURED_FEATURES_EMITTER_VERSION);
});

test("Backwards-compat: missing row.ts -> no time anchor (no crash)", () => {
  const sf = buildStructuredFeatures({
    raw_content: {
      conversation_id: "conv-no-ts-1",
      cwd: "/home/alex/some-project",
    },
  });
  assert.ok(sf, "missing ts still yields payload");
  assert.equal(sf.time_anchors.length, 0, "no anchor when ts missing");

  // Unparseable ts → no anchor (NOT a crash).
  const sfBadTs = buildStructuredFeatures({
    ts: "not-a-real-iso-date-string",
    raw_content: {
      conversation_id: "conv-bad-ts-1",
    },
  });
  assert.equal(sfBadTs.time_anchors.length, 0, "no anchor when ts unparseable");
});

// =============================================================================
// Conversation_id slug degradation — short ids degrade safely
// =============================================================================

test("conversation_id below MIN_ENTITY_LENGTH degrades to no topic (no crash)", () => {
  // 2-char conversation_id slugifies to "ab" which is < MIN_ENTITY_LENGTH=3.
  // The structural-entity gate drops it → no topic stamp; parties + ts
  // still produced.
  const sf = buildStructuredFeatures({
    ts: "2026-06-21T00:00:00.000Z",
    raw_content: {
      conversation_id: "ab",
      cwd: "/home/alex/projects/memory-system",
    },
  });
  assert.ok(sf, "structured_features still returned");
  const ids = sf.entities.map((e) => e.canonical_id);
  // No conversation_id-derived topic.
  for (const id of ids) {
    assert.ok(
      !id.startsWith("topic:chat-claude-code:"),
      `short conv_id must NOT stamp a topic, saw ${id}`,
    );
  }
  // cwd-derived project still stamps (memory-system slugifies to length 13).
  assert.ok(
    ids.includes("project:chat-claude-code:memory_system"),
    `cwd-derived project still stamps; ids=${JSON.stringify(ids)}`,
  );
});

// =============================================================================
// schema_version + emitter_version present on EVERY non-undefined emit
// =============================================================================

test("schema_version + emitter_version present on every emit shape", () => {
  const fixtures = [
    FIXTURE_WITH_CWD,
    FIXTURE_WITHOUT_CWD,
    { ts: "2026-06-21T00:00:00.000Z", raw_content: { conversation_id: "conv-only" } },
    {
      ts: "2026-06-21T00:00:00.000Z",
      raw_content: { cwd: "/home/alex/mcp-only" },
    },
    { ts: "2026-06-21T00:00:00.000Z", raw_content: {} },
  ];
  for (const row of fixtures) {
    const sf = buildStructuredFeatures(row);
    assert.ok(sf, `row emits structured_features: ${JSON.stringify(row.raw_content)}`);
    assert.equal(sf.schema_version, "v1");
    assert.equal(sf.emitter_version, STRUCTURED_FEATURES_EMITTER_VERSION);
    // Caps invariants always honored.
    assert.ok(sf.entities.length <= CAPS.ENTITY_MAX_PER_ROW);
    assert.ok(sf.time_anchors.length <= CAPS.TIME_ANCHORS_MAX_PER_FACT);
  }
});

// =============================================================================
// parties invariant — chat-cc ALWAYS stamps both user + assistant
// =============================================================================

test("parties[] always canonicalizes [user, assistant] regardless of raw_content", () => {
  // Even with empty raw_content the parties projection is stable — the
  // stop-hook contract guarantees both sides participate in every turn.
  const cases = [
    { ts: "2026-06-21T00:00:00.000Z", raw_content: {} },
    {
      ts: "2026-06-21T00:00:00.000Z",
      raw_content: { user_text: "", assistant_text: "" },
    },
    FIXTURE_WITH_CWD,
    FIXTURE_WITHOUT_CWD,
  ];
  for (const row of cases) {
    const sf = buildStructuredFeatures(row);
    assert.equal(sf.parties.length, 2, "exactly user + assistant");
    assert.ok(sf.parties.includes("person:chat-claude-code:user"));
    assert.ok(sf.parties.includes("person:chat-claude-code:assistant"));
  }
});
