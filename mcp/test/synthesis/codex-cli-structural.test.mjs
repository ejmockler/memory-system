// F-CCS-CONNECTOR-codex-cli-structural — W3-CCS integration test.
//
// Verifies that the codex-cli connector emits a `structured_features` payload
// per row carrying:
//
//   parties       = ["user", "assistant"]   (literal, mirrors row.parties)
//   entities      = [
//     {kind:"topic",   canonical_id:"topic:codex-cli:<slug(conversation_id)>"},
//     {kind:"project", canonical_id:"project:codex-cli:<slug(basename(cwd))>"},
//   ] (project optional — only when cwd is present and slugifies non-empty)
//   time_anchors  = [{kind:"absolute", instant_iso:turn_ts, structural:true}]
//   schema_version  = "v1"
//   emitter_version = "codex-cli-structural@1.0.0"
//
// Mirrors the W2 git-log-structural + github-events-structural shape. The
// connector ALREADY KNOWS these fields from the codex rollout file (the
// session_meta carries cwd, every response_item carries its session's
// conversation_id, and turn timestamps are strict ISO-8601). The structural
// emit stops forcing the cascade text-extractor to re-discover them and is
// the FM-1 antidote per salience-design.md Appendix A.1 + foundation spec §3.
//
// The fixture is one inline, synthetic row in the shape the connector
// writes to storage/sources/codex-cli.jsonl.
//
// Backwards-compat invariant: rows whose raw_content cannot be parsed (null,
// missing fields, non-object) MUST cascade WITHOUT structured_features
// (foundation spec §7 — strict superset semantics). The test pins this by
// passing malformed inputs and asserting buildStructuredFeatures returns
// null without throwing.
//
// 12+ assertions across multiple separately-named tests per the WU
// engineering discipline.
//
// Run:
//   node --test mcp/test/synthesis/codex-cli-structural.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Hermetic env. Set BEFORE any dynamic import touches config.js. The connector
// module itself does not touch the env at import time, but the entity-
// extractor + downstream config helpers do; the env-before-import discipline
// is the universal hot-path test convention.
// -----------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-ccs-codex-structural-"));
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
// Dynamic imports (after env).
// -----------------------------------------------------------------------------

const codexModule = await import("../../lib/connectors/codex-cli.js");
const {
  buildStructuredFeatures,
  VERSION,
  STRUCTURED_FEATURES_CAPS,
  STRUCTURED_FEATURES_SCHEMA_VERSION,
  STRUCTURED_FEATURES_EMITTER_VERSION,
  STRUCTURED_FEATURES_SOURCE_SCOPE,
} = codexModule;

const entitySchema = await import("../../lib/synthesis/entity-extractor.js");
const { slugify } = entitySchema;

// -----------------------------------------------------------------------------
// Inline fixture: one synthetic row in the shape the connector writes to
// storage/sources/codex-cli.jsonl. Every codex row carries conversation_id +
// turn_index + user_text + assistant_text in raw_content, and the row-level
// ts is the turn timestamp. Ids, session file name, texts and cwd are
// invented; nothing is read from disk, because the slug discipline is what
// is under test.
// -----------------------------------------------------------------------------

const FIXTURE = {
  id: "ulid_00EXAMPLECODEXROW0001",
  ts: "2025-10-02T14:20:05.300Z",
  source: "codex-cli",
  source_msg_id:
    "codex:0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d:1",
  parties: ["user", "assistant"],
  raw_content: {
    conversation_id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    session_file:
      "rollout-2025-10-02T07-20-01-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.jsonl",
    turn_index: 1,
    user_text: "Show the test files under the current directory",
    assistant_text: "Reading the current directory for test files now.",
    cwd: "/home/alex/projects/example-repo/mcp",
  },
};

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

test("module exports VERSION + frozen CAPS pinned to W3 spec", () => {
  // CAPS surface for the WU engineering discipline (Module exports VERSION
  // + frozen CAPS). VERSION matches the pinned emitter_version.
  assert.equal(VERSION, "codex-cli-structural@1.0.0");
  assert.equal(STRUCTURED_FEATURES_SCHEMA_VERSION, "v1");
  assert.equal(STRUCTURED_FEATURES_EMITTER_VERSION, "codex-cli-structural@1.0.0");
  assert.equal(STRUCTURED_FEATURES_SOURCE_SCOPE, "codex-cli");
  assert.equal(STRUCTURED_FEATURES_CAPS.SCHEMA_VERSION, "v1");
  assert.equal(STRUCTURED_FEATURES_CAPS.EMITTER_VERSION, "codex-cli-structural@1.0.0");
  assert.equal(STRUCTURED_FEATURES_CAPS.SOURCE_SCOPE, "codex-cli");
  // Frozen bag: mutation MUST throw in strict mode (test files are ESM =
  // strict mode by default).
  assert.throws(() => {
    STRUCTURED_FEATURES_CAPS.SCHEMA_VERSION = "v2";
  });
  // The emitter-version regex from time-anchor-schema.md §8 I8 must match
  // the literal we publish (CI alignment between this module + the spec).
  const emitterRegex = /^[a-z0-9_\-]+@[0-9]+\.[0-9]+\.[0-9]+(\+[a-z0-9_\-]+)*$/;
  assert.match(VERSION, emitterRegex);
  assert.match(STRUCTURED_FEATURES_EMITTER_VERSION, emitterRegex);
});

test("stored-shape fixture — structural emit surfaces thread_id + project + parties", () => {
  // Drive buildStructuredFeatures with the fixture's raw_content +
  // turn_ts hoisted from the row-level ts (the connector hot path passes
  // both via {...rawContent, turn_ts: row.ts}).
  const input = {
    ...FIXTURE.raw_content,
    turn_ts: FIXTURE.ts,
  };
  const out = buildStructuredFeatures(input);
  assert.notEqual(out, null, "expected structured_features for the codex fixture");
  assert.equal(out.schema_version, "v1");
  assert.equal(out.emitter_version, "codex-cli-structural@1.0.0");

  // parties is the literal pair per WU spec — fixed for every codex turn.
  assert.deepEqual(out.parties, ["user", "assistant"]);

  // Entities array — pinned by canonical_id, sorted ascending per
  // foundation spec §3.1 (byte-stable merge / dedupe).
  assert.ok(Array.isArray(out.entities), "entities is an array");
  for (let i = 1; i < out.entities.length; i++) {
    assert.ok(
      out.entities[i - 1].canonical_id < out.entities[i].canonical_id,
      "entities sorted ascending by canonical_id",
    );
  }

  // topic:codex-cli:<slug(conversation_id)> — thread_id is surfaced as a
  // topic entity. The conversation_id is the most stable cross-turn join
  // key; per operator memory.md notes, codex thread_ids are tracked via
  // `--json thread_id` capture.
  const expectedTopicSlug = slugify(FIXTURE.raw_content.conversation_id);
  const expectedTopicId = `topic:codex-cli:${expectedTopicSlug}`;
  const topicEnt = out.entities.find((e) => e.kind === "topic");
  assert.ok(topicEnt, "topic entity present (thread_id surfaced)");
  assert.equal(topicEnt.canonical_id, expectedTopicId);
  assert.equal(topicEnt.surface, FIXTURE.raw_content.conversation_id);
  assert.equal(topicEnt.source_scope, "codex-cli");
  assert.equal(topicEnt.evidence, "structural");
  assert.equal(topicEnt.confidence, 1.0);
  assert.equal(topicEnt.extractor_version, "codex-cli-structural@1.0.0");
});

test("project entity from basename(cwd) when cwd is present", () => {
  const out = buildStructuredFeatures({
    conversation_id: "abc-123-def",
    cwd: "/home/alex/projects/example-repo/mcp",
    turn_ts: "2026-06-01T12:00:00Z",
  });
  assert.notEqual(out, null);
  const projectEnt = out.entities.find((e) => e.kind === "project");
  assert.ok(projectEnt, "project entity present");
  // basename of /home/alex/projects/example-repo/mcp is "mcp" → slug "mcp".
  assert.equal(projectEnt.canonical_id, "project:codex-cli:mcp");
  assert.equal(projectEnt.surface, "mcp");
  assert.equal(projectEnt.source_scope, "codex-cli");
  assert.equal(projectEnt.evidence, "structural");
  // A cwd with dashes (the workunit ID convention) collapses to underscores.
  const out2 = buildStructuredFeatures({
    conversation_id: "x-y-z",
    cwd: "/home/alex/projects/sample-tool",
    turn_ts: "2026-06-01T12:00:00Z",
  });
  const projectEnt2 = out2.entities.find((e) => e.kind === "project");
  assert.ok(projectEnt2);
  assert.equal(projectEnt2.canonical_id, "project:codex-cli:sample_tool");
});

test("absolute time_anchor uses instant_iso per WU spec + structural:true", () => {
  const out = buildStructuredFeatures({
    conversation_id: "abc-123",
    cwd: "/home/alex/x",
    turn_ts: "2026-06-01T12:00:00Z",
  });
  assert.ok(Array.isArray(out.time_anchors), "time_anchors is an array");
  assert.equal(out.time_anchors.length, 1);
  const ta = out.time_anchors[0];
  assert.equal(ta.kind, "absolute");
  assert.equal(ta.structural, true, "structural pinning per foundation spec OQ5");
  assert.equal(ta.extractor_confidence, 1.0);
  assert.equal(ta.extractor_version, "codex-cli-structural@1.0.0");
  // WU spec: time_anchors use instant_iso (NOT parsed.iso). The cascade
  // merger's dedupe key (distill-promote-fact.js §783-795) accepts both
  // forms; we follow WU verbatim.
  assert.equal(ta.instant_iso, "2026-06-01T12:00:00Z");
  // raw_phrase preserves the original verbatim string (audit anchor).
  assert.equal(ta.raw_phrase, "2026-06-01T12:00:00Z");
});

test("turn_ts falls back to raw_content.ts when turn_ts is absent", () => {
  // A tail-read of the on-disk ledger sees row.ts only — raw_content does
  // not replicate the row-level ts. The helper must accept raw_content.ts
  // as a fallback so re-extract works against historical rows.
  const out = buildStructuredFeatures({
    conversation_id: "fallback-thread",
    cwd: "/tmp/x",
    ts: "2026-06-21T01:02:03Z",
  });
  assert.notEqual(out, null);
  assert.equal(out.time_anchors.length, 1);
  assert.equal(out.time_anchors[0].instant_iso, "2026-06-21T01:02:03Z");
});

test("cwd absent — emits topic + time anchor but no project entity", () => {
  // Old codex versions / synthetic fixtures may omit cwd from session_meta.
  // Defensive degradation: still emit the topic + anchor; just no project.
  const out = buildStructuredFeatures({
    conversation_id: "no-cwd-thread",
    turn_ts: "2026-06-01T12:00:00Z",
  });
  assert.notEqual(out, null);
  const projectEnt = out.entities.find((e) => e.kind === "project");
  assert.equal(projectEnt, undefined, "no project entity when cwd absent");
  const topicEnt = out.entities.find((e) => e.kind === "topic");
  assert.ok(topicEnt);
  assert.equal(topicEnt.canonical_id, "topic:codex-cli:no_cwd_thread");
  assert.equal(out.time_anchors.length, 1);
});

test("canonical_id byte-stability — slug exactly matches entity-extractor pipeline", () => {
  // Foundation spec §6 union-by-canonical-id invariant: the connector's
  // canonical_id MUST be byte-identical to what the entity-extractor's
  // slugify() would produce for the same surface. We verify the connector
  // routes through the same slugify() (i.e. zero drift between the two
  // paths). conversation_ids that include hyphens, mixed case, or
  // non-ASCII MUST collapse identically.
  const surfaces = [
    "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    "ABC-XYZ-123",
    "thread_with_underscores",
    "memory-system",
    "ExRepo-Check",
  ];
  for (const s of surfaces) {
    const out = buildStructuredFeatures({
      conversation_id: s,
      turn_ts: "2026-01-01T00:00:00Z",
    });
    assert.notEqual(out, null);
    const topicEnt = out.entities.find((e) => e.kind === "topic");
    assert.ok(topicEnt, `topic entity for ${s}`);
    assert.equal(
      topicEnt.canonical_id,
      `topic:codex-cli:${slugify(s)}`,
      `byte-identical slug for ${s}`,
    );
    // Slug regex compliance (entity-schema §5.2 step 7).
    const slugPart = topicEnt.canonical_id.split(":").pop();
    assert.match(slugPart, /^[a-z0-9]+(_[a-z0-9]+)*$/);
  }
});

test("backwards-compat — malformed raw_content returns null, never throws", () => {
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
    { conversation_id: 123, cwd: false, turn_ts: null },
    { conversation_id: "", cwd: "", turn_ts: "" },
    // All structural fields missing.
    { user_text: "hello", assistant_text: "world" },
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

test("partial parse — unparseable turn_ts yields no time_anchors but still emits entities", () => {
  // The defensive-degradation discipline: a partially-parseable
  // raw_content should emit as much structural signal as it can without
  // suppressing the rest. turn_ts unparseable should NOT drop topic +
  // project entities.
  const out = buildStructuredFeatures({
    conversation_id: "thread-xyz",
    cwd: "/home/alex/projects/memory-system",
    turn_ts: "not-an-iso-timestamp",
  });
  assert.notEqual(out, null);
  assert.equal(out.time_anchors.length, 0, "unparseable ts -> empty anchors");
  // Entities still emit.
  const topicEnt = out.entities.find((e) => e.kind === "topic");
  assert.ok(topicEnt, "topic entity present even without ts");
  assert.equal(topicEnt.canonical_id, "topic:codex-cli:thread_xyz");
  const projectEnt = out.entities.find((e) => e.kind === "project");
  assert.ok(projectEnt);
  assert.equal(projectEnt.canonical_id, "project:codex-cli:memory_system");
});

test("schema_version + emitter_version + parties present on every emission", () => {
  // Foundation spec §3.1: schema_version and emitter_version are REQUIRED
  // on every payload. The validator (when it lands in mcp/lib/validation.js)
  // will reject rows missing either field. Pin the invariant at the
  // emitter so we don't ship rows the validator would reject. parties is
  // also pinned to the literal ["user","assistant"] pair on every emission
  // per WU spec.
  const inputs = [
    { ...FIXTURE.raw_content, turn_ts: FIXTURE.ts },
    {
      conversation_id: "thread-1",
      cwd: "/home/alex/code/atlas",
      turn_ts: "2026-06-01T12:00:00Z",
    },
    {
      conversation_id: "thread-2",
      turn_ts: "2026-06-15T08:30:00Z",
    },
  ];
  for (const rc of inputs) {
    const out = buildStructuredFeatures(rc);
    assert.ok(out, `out non-null for ${JSON.stringify(rc).slice(0, 80)}`);
    assert.equal(typeof out.schema_version, "string");
    assert.equal(out.schema_version, "v1");
    assert.equal(typeof out.emitter_version, "string");
    assert.equal(out.emitter_version, "codex-cli-structural@1.0.0");
    // emitter_version matches the regex pinned in time-anchor-schema.md §8 I8.
    assert.match(
      out.emitter_version,
      /^[a-z0-9_\-]+@[0-9]+\.[0-9]+\.[0-9]+(\+[a-z0-9_\-]+)*$/,
    );
    // parties is the literal pair on every emission per WU spec.
    assert.deepEqual(out.parties, ["user", "assistant"]);
  }
});

test("conversation_id slug discipline — uuid hyphens collapse to underscores", () => {
  // The specific shape that matters for the fixture: UUIDs with
  // hyphens. slugify collapses [^a-z0-9]+ to a single underscore (step 4)
  // so `0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d` slugifies to
  // `0a1b2c3d_4e5f_4a6b_8c7d_9e0f1a2b3c4d` — exactly the canonical_id we
  // promise downstream consumers.
  const conv = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const out = buildStructuredFeatures({
    conversation_id: conv,
    turn_ts: "2026-01-01T00:00:00Z",
  });
  const topicEnt = out.entities.find((e) => e.kind === "topic");
  assert.equal(
    topicEnt.canonical_id,
    "topic:codex-cli:0a1b2c3d_4e5f_4a6b_8c7d_9e0f1a2b3c4d",
  );
});
