// F-CCS-CONNECTOR-screentime-structural — W3-CCS connector test.
//
// Verifies that lib/connectors/screentime.js stamps a structured_features
// payload on screentime rows so the salience cascade can merge connector-
// known surfaces (app_bundle, web_url, contact_handle) into fact.features
// at promote time. Per W9 the screentime cascade is captured_only today —
// the structured payload still lands on the captured ledger as a record +
// future cascade-on switch.
//
// Per-stream mapping (matches the workunit predicate):
//   /app/intents (INSendMessageIntent):
//     contact_handle (related_contact_ids OR derived_intent_id) → person
//     app_bundle_id                                              → artifact
//   /app/usage:
//     app_bundle_id → artifact
//   /app/webUsage:
//     web_url     → artifact
//     web_domain  → artifact
//     app_bundle  → artifact
//
// Fixtures are inline, synthetic rows in the raw_content shapes the
// connector writes to storage/sources/screentime.jsonl (one per stream
// kind), so the test runs on any machine without a screentime ledger.
//
// 12+ assertions across multiple separately-named tests per the WU
// engineering discipline.
//
// Run:
//   node --test mcp/test/synthesis/screentime-structural.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Hermetic env. MUST be set BEFORE any dynamic import touches config.js.
// -----------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-ccs-screentime-structural-"));
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
// Dynamic imports (after env). The screentime module exports the structural
// helper + frozen VERSION + CAPS bag per the W2-W12 discipline.
// -----------------------------------------------------------------------------

const {
  buildStructuredFeatures,
  VERSION,
  CAPS,
  STRUCTURED_FEATURES_SCHEMA_VERSION,
  STRUCTURED_FEATURES_EMITTER_VERSION,
  STRUCTURED_FEATURES_SOURCE_SCOPE,
} = await import("../../lib/connectors/screentime.js");

const entityModule = await import("../../lib/synthesis/entity-extractor.js");
const { slugify, ENTITY_SOURCE_SCOPES } = entityModule;

// -----------------------------------------------------------------------------
// Inline fixtures, one per raw_content shape the connector writes to
// storage/sources/screentime.jsonl: (a) an INSendMessageIntent row with a
// populated related_contact_ids (UUID:ABPerson form), (b) an
// INSendMessageIntent row whose contact handle lives in the
// derived_intent_id "notificationThreadIdentifier(<urlencoded>)" form,
// (c) a /app/usage row, and (d) a /app/webUsage row. Every identifier,
// handle, timestamp and URL below is invented; nothing is read from disk,
// because the slug discipline is what is under test.
// -----------------------------------------------------------------------------

const FIXTURES = {
  intentWithRelatedContact: {
    raw_content: {
      stream: "/app/intents",
      start_date: "2026-04-11T15:22:40.000Z",
      end_date: "2026-04-11T15:22:40.000Z",
      focus_mode: null,
      app_bundle_id: "Messages",
      intent_class: "INSendMessageIntent",
      intent_verb: "SendMessage",
      direction: 2,
      intent_type: 1,
      handling_status: 3,
      interaction_id: "00000000-0000-4000-8000-0000000000A1",
      derived_intent_id:
        "notificationThreadIdentifier(%2B15555550144)",
      related_contact_ids:
        "00000000-0000-4000-8000-0000000000B2:ABPerson",
      donated_by_siri: false,
    },
  },
  intentWithDerivedOnly: {
    raw_content: {
      stream: "/app/intents",
      start_date: "2026-04-12T08:41:05.000Z",
      end_date: "2026-04-12T08:41:05.000Z",
      focus_mode: null,
      app_bundle_id: "Messages",
      intent_class: "INSendMessageIntent",
      intent_verb: "SendMessage",
      direction: 2,
      intent_type: 1,
      handling_status: 0,
      interaction_id: "00000000-0000-4000-8000-0000000000C3",
      // notificationThreadIdentifier with URL-encoded phone — the
      // extractor should URL-decode "%2B15555550155" -> "+15555550155".
      derived_intent_id:
        "notificationThreadIdentifier(%2B15555550155)",
      related_contact_ids: null,
      donated_by_siri: false,
    },
  },
  appUsage: {
    raw_content: {
      stream: "/app/usage",
      start_date: "2026-04-13T11:03:10.000Z",
      end_date: "2026-04-13T11:10:02.000Z",
      focus_mode: null,
      app_bundle_id: "com.google.Chrome",
      url: null,
      query: null,
      duration_sec: 412,
    },
  },
  webUsage: {
    raw_content: {
      stream: "/app/webUsage",
      start_date: "2026-04-14T19:15:30.000Z",
      end_date: "2026-04-14T19:15:33.000Z",
      focus_mode: null,
      app_bundle_id: "com.apple.Safari",
      web_domain: "www.example.com",
      web_url:
        "https://www.example.com/search?client=safari&rls=en&q=sample+query&ie=UTF-8&oe=UTF-8",
      usage_type: 1,
    },
  },
};

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

test("module exports VERSION + frozen CAPS pinned to foundation spec", () => {
  // CAPS surface for the WU engineering discipline (Module exports VERSION
  // + frozen CAPS). VERSION matches the on-row emitter_version.
  assert.equal(VERSION, "screentime-structural@1.0.0");
  assert.equal(STRUCTURED_FEATURES_SCHEMA_VERSION, "v1");
  assert.equal(STRUCTURED_FEATURES_EMITTER_VERSION, "screentime-structural@1.0.0");
  assert.equal(STRUCTURED_FEATURES_SOURCE_SCOPE, "screentime");
  assert.equal(CAPS.SCHEMA_VERSION, "v1");
  assert.equal(CAPS.EMITTER_VERSION, "screentime-structural@1.0.0");
  assert.equal(CAPS.SOURCE_SCOPE, "screentime");
  // Frozen bag: mutation MUST throw in strict mode (ESM is strict by default).
  assert.throws(() => {
    CAPS.SCHEMA_VERSION = "v2";
  });
  // The emitter-version regex from time-anchor-schema.md §8 I8 must match
  // the literal we publish (CI alignment between this module + the spec).
  const emitterRegex = /^[a-z0-9_\-]+@[0-9]+\.[0-9]+\.[0-9]+(\+[a-z0-9_\-]+)*$/;
  assert.match(VERSION, emitterRegex);
  // source_scope MUST be in the closed entity-extractor enum so canonical_id
  // collation byte-matches the cascade text-extractor path.
  assert.ok(
    ENTITY_SOURCE_SCOPES.includes(STRUCTURED_FEATURES_SOURCE_SCOPE),
    "source_scope is a member of the closed enum",
  );
});

test("/app/intents — INSendMessageIntent with related_contact_ids emits person + artifact", () => {
  const out = buildStructuredFeatures(
    FIXTURES.intentWithRelatedContact.raw_content,
  );
  assert.notEqual(out, null, "structured_features emitted for INSendMessageIntent");
  assert.equal(out.schema_version, "v1");
  assert.equal(out.emitter_version, "screentime-structural@1.0.0");

  // Two entities — the contact handle person + the Messages bundle artifact.
  assert.ok(Array.isArray(out.entities));
  assert.equal(out.entities.length, 2, "person + artifact");
  // Sort invariant (foundation spec §3.1).
  for (let i = 1; i < out.entities.length; i++) {
    assert.ok(
      out.entities[i - 1].canonical_id < out.entities[i].canonical_id,
      "entities sorted ascending by canonical_id",
    );
  }

  // person from related_contact_ids — the UUID prefix (strip :ABPerson).
  const related = FIXTURES.intentWithRelatedContact.raw_content.related_contact_ids;
  const colonIdx = related.indexOf(":");
  const expectedContactSurface = colonIdx >= 0 ? related.slice(0, colonIdx) : related;
  const expectedContactSlug = slugify(expectedContactSurface);
  const expectedPersonId = `person:screentime:${expectedContactSlug}`;
  const personEnt = out.entities.find((e) => e.kind === "person");
  assert.ok(personEnt, "person entity present");
  assert.equal(personEnt.canonical_id, expectedPersonId);
  assert.equal(personEnt.surface, expectedContactSurface);
  assert.equal(personEnt.source_scope, "screentime");
  assert.equal(personEnt.evidence, "handle");
  assert.equal(personEnt.confidence, 1.0);
  assert.equal(personEnt.extractor_version, "screentime-structural@1.0.0");

  // artifact from Messages bundle.
  const artifactEnt = out.entities.find((e) => e.kind === "artifact");
  assert.ok(artifactEnt, "artifact entity present");
  const bundle = FIXTURES.intentWithRelatedContact.raw_content.app_bundle_id;
  assert.equal(artifactEnt.canonical_id, `artifact:screentime:${slugify(bundle)}`);
  assert.equal(artifactEnt.surface, bundle);
  assert.equal(artifactEnt.evidence, "structural");

  // parties[] is the canonicalized projection — person canonical_id only.
  assert.deepEqual(out.parties, [expectedPersonId]);
});

test("/app/intents — INSendMessageIntent with derived_intent_id falls back, URL-decodes inner", () => {
  const out = buildStructuredFeatures(
    FIXTURES.intentWithDerivedOnly.raw_content,
  );
  assert.notEqual(out, null);
  const personEnt = out.entities.find((e) => e.kind === "person");
  assert.ok(personEnt, "person entity extracted from derived_intent_id");
  // The extractor URL-decoded "%2B" -> "+"; the surface keeps the + and the
  // slug pipeline strips it (non-alphanumeric → underscore → trimmed).
  const derived = FIXTURES.intentWithDerivedOnly.raw_content.derived_intent_id;
  const m = derived.match(/^notificationThreadIdentifier\((.+)\)$/);
  const decoded = decodeURIComponent(m[1]);
  assert.equal(personEnt.surface, decoded, "surface preserves decoded handle");
  assert.equal(
    personEnt.canonical_id,
    `person:screentime:${slugify(decoded)}`,
  );
  assert.equal(personEnt.evidence, "handle");
  // parties[] mirrors the person canonical_id.
  assert.deepEqual(out.parties, [personEnt.canonical_id]);
});

test("/app/intents — INSendMessageIntent with conversationIdentifier emits NO person entity", () => {
  // conversationIdentifier(<numeric>) is an opaque thread id, NOT a
  // contact handle. Slugifying it would mint a bogus person entity (FM-1
  // hazard). The extractor must skip it.
  const rc = {
    stream: "/app/intents",
    start_date: "2026-05-04T07:59:31.000Z",
    end_date: "2026-05-04T07:59:31.000Z",
    focus_mode: null,
    app_bundle_id: "Messages",
    intent_class: "INSendMessageIntent",
    intent_verb: "SendMessage",
    direction: 2,
    intent_type: 1,
    handling_status: 0,
    interaction_id: "00000000-0000-4000-8000-0000000000E5",
    derived_intent_id: "conversationIdentifier(10000000042)",
    related_contact_ids: null,
    donated_by_siri: false,
  };
  const out = buildStructuredFeatures(rc);
  assert.notEqual(out, null, "still emits (bundle artifact remains)");
  const personEnt = out.entities.find((e) => e.kind === "person");
  assert.equal(personEnt, undefined, "no person entity from thread id");
  // The Messages bundle is still emitted.
  const artifactEnt = out.entities.find((e) => e.kind === "artifact");
  assert.ok(artifactEnt, "Messages bundle artifact still emitted");
  // parties[] is empty (no person extracted).
  assert.deepEqual(out.parties, []);
});

test("/app/intents — non-INSendMessageIntent intents do NOT mint person entities", () => {
  // INStartCallIntent / INPlayMediaIntent / etc. carry related_contact_ids
  // sometimes too but the workunit predicate gates the person extraction
  // to INSendMessageIntent. This pins the gate.
  const rc = {
    stream: "/app/intents",
    start_date: "2026-05-04T10:00:00.000Z",
    end_date: "2026-05-04T10:00:00.000Z",
    focus_mode: null,
    app_bundle_id: "com.apple.mobilephone",
    intent_class: "INStartCallIntent",
    intent_verb: "StartCall",
    direction: 1,
    intent_type: 1,
    handling_status: 0,
    interaction_id: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    derived_intent_id: "notificationThreadIdentifier(%2B15551234567)",
    related_contact_ids: "12345678-1234-1234-1234-123456789012:ABPerson",
    donated_by_siri: false,
  };
  const out = buildStructuredFeatures(rc);
  assert.notEqual(out, null);
  // Only the bundle artifact — no person entity from a call intent.
  const personEnt = out.entities.find((e) => e.kind === "person");
  assert.equal(personEnt, undefined, "non-Send intents skip person");
  const artifactEnt = out.entities.find((e) => e.kind === "artifact");
  assert.ok(artifactEnt, "bundle artifact still emitted");
});

test("/app/usage — bundle id mapped to artifact entity", () => {
  const out = buildStructuredFeatures(FIXTURES.appUsage.raw_content);
  assert.notEqual(out, null);
  assert.equal(out.entities.length, 1, "single artifact entity");
  const artifactEnt = out.entities[0];
  assert.equal(artifactEnt.kind, "artifact");
  const bundle = FIXTURES.appUsage.raw_content.app_bundle_id;
  assert.equal(artifactEnt.canonical_id, `artifact:screentime:${slugify(bundle)}`);
  assert.equal(artifactEnt.surface, bundle);
  assert.equal(artifactEnt.source_scope, "screentime");
  assert.equal(artifactEnt.evidence, "structural");
  assert.equal(artifactEnt.confidence, 1.0);
  // No persons in /app/usage rows.
  assert.deepEqual(out.parties, []);
});

test("/app/webUsage — url + domain + bundle mapped to artifact entities", () => {
  const out = buildStructuredFeatures(FIXTURES.webUsage.raw_content);
  assert.notEqual(out, null);
  // Three artifacts unless slug collision happened (extremely rare here).
  assert.ok(out.entities.length >= 2, "url + domain + (optional) bundle");
  assert.ok(out.entities.length <= 3, "no more than 3 expected artifacts");
  for (const e of out.entities) {
    assert.equal(e.kind, "artifact");
    assert.equal(e.source_scope, "screentime");
    assert.equal(e.evidence, "structural");
  }
  // URL entity canonical_id matches the slugify pipeline.
  const url = FIXTURES.webUsage.raw_content.web_url;
  const urlSlug = slugify(url);
  const urlEnt = out.entities.find((e) => e.surface === url);
  assert.ok(urlEnt, "URL artifact present");
  assert.equal(urlEnt.canonical_id, `artifact:screentime:${urlSlug}`);
  // Domain entity canonical_id.
  const domain = FIXTURES.webUsage.raw_content.web_domain;
  const domainSlug = slugify(domain);
  const domainEnt = out.entities.find((e) => e.surface === domain);
  assert.ok(domainEnt, "domain artifact present");
  assert.equal(domainEnt.canonical_id, `artifact:screentime:${domainSlug}`);
  // Bundle entity.
  const bundle = FIXTURES.webUsage.raw_content.app_bundle_id;
  const bundleEnt = out.entities.find((e) => e.surface === bundle);
  assert.ok(bundleEnt, "Safari bundle artifact present");
  assert.equal(bundleEnt.canonical_id, `artifact:screentime:${slugify(bundle)}`);
});

test("time_anchors — start_date becomes absolute anchor with UTC-normalized iso + structural=true", () => {
  const out = buildStructuredFeatures(FIXTURES.appUsage.raw_content);
  assert.ok(Array.isArray(out.time_anchors));
  assert.equal(out.time_anchors.length, 1);
  const ta = out.time_anchors[0];
  assert.equal(ta.kind, "absolute");
  assert.equal(ta.structural, true);
  assert.equal(ta.extractor_confidence, 1.0);
  assert.equal(ta.extractor_version, "screentime-structural@1.0.0");
  assert.equal(ta.raw_phrase, FIXTURES.appUsage.raw_content.start_date);
  // parsed.iso is UTC-normalized via Date(...).toISOString().
  const expectedIso = new Date(
    Date.parse(FIXTURES.appUsage.raw_content.start_date),
  ).toISOString();
  assert.equal(ta.parsed.iso, expectedIso);
  assert.match(ta.parsed.iso, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/);
});

test("backwards-compat — malformed raw_content returns null without throwing", () => {
  // Every flavour of malformed input must route to the text-extractor-only
  // fallback path per foundation spec §7. The cascade is the consumer; the
  // connector MUST NEVER throw on the hot path.
  const malformed = [
    null,
    undefined,
    "a string is not an object",
    42,
    [],
    {},
    // missing/non-string stream
    { stream: 123 },
    { stream: null },
    // unrecognized stream
    { stream: "/discoverability/signals", app_bundle_id: "X" },
    // empty stream string
    { stream: "" },
  ];
  for (const m of malformed) {
    let out;
    let threw = false;
    try {
      out = buildStructuredFeatures(m);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, `should not throw on ${JSON.stringify(m)}`);
    assert.equal(out, null, `should return null on ${JSON.stringify(m)}`);
  }
});

test("partial parse — /app/usage with missing bundle still attempts time anchor", () => {
  // The defensive-degradation discipline: a partially-parseable row should
  // emit as much structural signal as it can without suppressing the rest.
  // A /app/usage row with no bundle (rare; column was NULL on the JOIN)
  // should still emit the time anchor.
  const out = buildStructuredFeatures({
    stream: "/app/usage",
    start_date: "2026-06-01T12:00:00.000Z",
    end_date: "2026-06-01T12:05:00.000Z",
    focus_mode: null,
    app_bundle_id: null,
    url: null,
    query: null,
    duration_sec: 300,
  });
  assert.notEqual(out, null, "still emits when only time anchor is structural");
  assert.equal(out.entities.length, 0, "no bundle → no artifact");
  assert.equal(out.time_anchors.length, 1, "time anchor still present");
  assert.deepEqual(out.parties, []);
});

test("partial parse — /app/usage with unparseable start_date drops time anchor only", () => {
  const out = buildStructuredFeatures({
    stream: "/app/usage",
    start_date: "not-an-iso-timestamp",
    end_date: "2026-06-01T12:05:00.000Z",
    focus_mode: null,
    app_bundle_id: "com.example.app",
    url: null,
    query: null,
    duration_sec: 300,
  });
  assert.notEqual(out, null);
  assert.equal(out.entities.length, 1, "bundle artifact still emitted");
  assert.equal(out.time_anchors.length, 0, "unparseable ts → no anchor");
});

test("schema_version + emitter_version present on every emission", () => {
  // Foundation spec §3.1: schema_version and emitter_version are REQUIRED
  // on every payload. Validator (when it lands) will reject rows missing
  // either. Pin the invariant at the emitter so we don't ship rows the
  // validator would reject.
  const inputs = [
    FIXTURES.intentWithRelatedContact.raw_content,
    FIXTURES.intentWithDerivedOnly.raw_content,
    FIXTURES.appUsage.raw_content,
    FIXTURES.webUsage.raw_content,
  ];
  for (const rc of inputs) {
    const out = buildStructuredFeatures(rc);
    assert.ok(out, `non-null for stream=${rc.stream}`);
    assert.equal(typeof out.schema_version, "string");
    assert.equal(out.schema_version, "v1");
    assert.equal(typeof out.emitter_version, "string");
    assert.equal(out.emitter_version, "screentime-structural@1.0.0");
    assert.match(
      out.emitter_version,
      /^[a-z0-9_\-]+@[0-9]+\.[0-9]+\.[0-9]+(\+[a-z0-9_\-]+)*$/,
    );
  }
});

test("canonical_id byte-stability — slug exactly matches entity-extractor pipeline", () => {
  // Foundation spec §6 union-by-canonical-id invariant: the connector's
  // canonical_id MUST be byte-identical to what the cascade text-extractor
  // would produce for the same surface. We verify the connector routes
  // through the same slugify() (i.e. zero drift between the two paths).
  const cases = [
    { kind: "artifact", surface: "Messages" },
    { kind: "artifact", surface: "com.google.Chrome" },
    { kind: "artifact", surface: "com.apple.Safari" },
    { kind: "artifact", surface: "www.example.com" },
    {
      kind: "person",
      surface: "00000000-0000-4000-8000-0000000000B2",
    },
    { kind: "person", surface: "+18005551212" },
  ];
  for (const { kind, surface } of cases) {
    // Drive the connector via an inputs that exercises the right path.
    let out;
    if (kind === "person") {
      out = buildStructuredFeatures({
        stream: "/app/intents",
        start_date: "2026-01-01T00:00:00.000Z",
        end_date: "2026-01-01T00:00:00.000Z",
        focus_mode: null,
        app_bundle_id: "Messages",
        intent_class: "INSendMessageIntent",
        intent_verb: "SendMessage",
        direction: 2,
        intent_type: 1,
        handling_status: 0,
        interaction_id: "00000000-0000-0000-0000-000000000000",
        // Force the derived-id path for the phone surface, the
        // related_contact_ids path for the UUID surface.
        derived_intent_id: surface.startsWith("+")
          ? `notificationThreadIdentifier(${encodeURIComponent(surface)})`
          : null,
        related_contact_ids: surface.startsWith("+") ? null : `${surface}:ABPerson`,
        donated_by_siri: false,
      });
      const personEnt = out.entities.find((e) => e.kind === "person");
      assert.ok(personEnt, `person entity for ${surface}`);
      assert.equal(personEnt.canonical_id, `person:screentime:${slugify(surface)}`);
    } else {
      // Use whichever stream cleanly hosts the artifact surface.
      const rc =
        surface === "www.example.com"
          ? {
              stream: "/app/webUsage",
              start_date: "2026-01-01T00:00:00.000Z",
              end_date: "2026-01-01T00:00:00.000Z",
              focus_mode: null,
              app_bundle_id: null,
              web_domain: surface,
              web_url: null,
              usage_type: 1,
            }
          : {
              stream: "/app/usage",
              start_date: "2026-01-01T00:00:00.000Z",
              end_date: "2026-01-01T00:00:01.000Z",
              focus_mode: null,
              app_bundle_id: surface,
              url: null,
              query: null,
              duration_sec: 1,
            };
      out = buildStructuredFeatures(rc);
      const artifactEnt = out.entities.find((e) => e.surface === surface);
      assert.ok(artifactEnt, `artifact entity for ${surface}`);
      assert.equal(
        artifactEnt.canonical_id,
        `artifact:screentime:${slugify(surface)}`,
      );
    }
  }
});

test("captured_only mode preserved — CAPTURED_STREAMS gate still drops non-allowlisted streams at the connector", async () => {
  // W9 invariant: the connector emits only rows whose stream is in
  // CAPTURED_STREAMS. Adding structured_features to allowed streams MUST
  // NOT relax that gate. We drive a ScreenTimeConnector against a
  // synthetic knowledgeC.db that carries one allowed-stream row and one
  // dropped-stream row, then assert only the allowed row landed on the
  // ledger AND that the allowed row carries the structured_features
  // payload.
  const { DatabaseSync } = await import("node:sqlite");
  const dbDir = mkdtempSync(join(tmpdir(), "memsys-ccs-screentime-db-"));
  const dbPath = join(dbDir, "knowledgeC.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE ZSTRUCTUREDMETADATA (
      Z_PK INTEGER PRIMARY KEY
    );
    CREATE TABLE ZOBJECT (
      Z_PK INTEGER PRIMARY KEY,
      ZSTREAMNAME TEXT,
      ZSTARTDATE INTEGER,
      ZENDDATE INTEGER,
      ZVALUESTRING TEXT,
      ZSTRUCTUREDMETADATA INTEGER
    );
    INSERT INTO ZOBJECT VALUES
      (1, '/app/usage',         800000000, 800000001, 'com.google.Chrome', NULL),
      (2, '/discoverability/signals', 800000002, 800000003, 'spotlight_invocation', NULL);
  `);
  db.close();

  const ledgerPath = join(TMP_ROOT, "captured-only-ledger.jsonl");
  const cursorPath = join(TMP_ROOT, "captured-only-cursor.json");
  const { ScreenTimeConnector } = await import("../../lib/connectors/screentime.js");
  const conn = new ScreenTimeConnector({
    knowledgeDbPath: dbPath,
    dndAssertionsPath: join(TMP_ROOT, "missing-assertions.json"),
    sourceLedgerPath: ledgerPath,
    cursorPath,
  });
  const result = await conn.pollOnce({ now: "2026-06-21T00:00:00.000Z" });
  assert.equal(result.appended, 1, "only one row appended (allowed stream)");
  assert.equal(result.errors.length, 0, "no errors emitted");

  // Read the ledger and confirm the allowed row carries structured_features
  // while the dropped stream produced NO ledger row at all.
  const ledgerRaw = readFileSync(ledgerPath, "utf8");
  const lines = ledgerRaw.split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1, "exactly one ledger row");
  const row = JSON.parse(lines[0]);
  assert.equal(row.source, "screentime");
  assert.equal(row.raw_content.stream, "/app/usage");
  assert.ok(row.structured_features, "structured_features attached on captured row");
  assert.equal(row.structured_features.schema_version, "v1");
  assert.equal(row.structured_features.emitter_version, "screentime-structural@1.0.0");
  // The /app/usage row's structural payload is the bundle artifact.
  assert.equal(row.structured_features.entities.length, 1);
  assert.equal(row.structured_features.entities[0].kind, "artifact");
  assert.equal(
    row.structured_features.entities[0].canonical_id,
    `artifact:screentime:${slugify("com.google.Chrome")}`,
  );
  // The cursor reflects the dropped stream in the filtered_at_connector map.
  const cursor = JSON.parse(readFileSync(cursorPath, "utf8"));
  assert.equal(cursor.last_z_pk, 2, "cursor advanced past the dropped row");
  assert.ok(
    cursor.filtered_at_connector
      && typeof cursor.filtered_at_connector === "object"
      && cursor.filtered_at_connector["/discoverability/signals"] === 1,
    "dropped stream tallied on the cursor",
  );
});
