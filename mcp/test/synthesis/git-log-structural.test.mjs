// F-CCS-CONNECTOR-git-log-structural — W2-CCS integration test.
//
// Verifies that the git-log connector emits a `structured_features` payload
// per row carrying:
//
//   entities      = [{kind:'person',canonical_id:'person:git-log:<slug(email)>'},
//                    {kind:'project',canonical_id:'project:git-log:<slug(repo basename)>'}]
//   time_anchors  = [{kind:'absolute', parsed.iso = UTC-normalized author_ts,
//                     structural:true}]
//   parties       = [person canonical_id]
//   schema_version = "v1"
//   emitter_version = "git-log-local@1.0.0"
//
// The connector ALREADY KNOWS these from raw_content; the structural emit
// stops forcing the cascade text-extractor to re-discover them and is the
// FM-1 antidote per salience-design.md Appendix A.1 + foundation spec §3.
//
// Fixtures are two inline, synthetic rows in the shape the connector writes
// to storage/sources/git-log.jsonl (a human contributor commit and a
// dependabot commit on the same repo). The test runs buildStructuredFeatures
// over their raw_content and asserts the byte-identical slug discipline matches the foundation
// spec's worked-example contract.
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
//   node --test mcp/test/synthesis/git-log-structural.test.mjs

import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Synthetic operator identity. operator-identity.js resolves its config file
// once, at module load, so this MUST be set before the first library import;
// that is why the library imports below are dynamic (static imports hoist).
process.env.MEMORY_OPERATOR_IDENTITY_FILE = fileURLToPath(
  new URL("../fixtures/operator-identity.synthetic.json", import.meta.url),
);

// -----------------------------------------------------------------------------
// Hermetic env. Set BEFORE any dynamic import touches config.js. The connector
// module itself does not touch the env at import time, but the entity-
// extractor + downstream config helpers do; the env-before-import discipline
// is the universal hot-path test convention.
// -----------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-ccs-git-structural-"));
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
// Dynamic imports (after env). The connector module exports both the
// structural helper and the frozen VERSION + CAPS bag.
// -----------------------------------------------------------------------------

const {
  buildStructuredFeatures,
  VERSION,
  CAPS,
  STRUCTURED_FEATURES_SCHEMA_VERSION,
  STRUCTURED_FEATURES_EMITTER_VERSION,
  STRUCTURED_FEATURES_SOURCE_SCOPE,
} = await import("../../lib/connectors/git-log-local.js");

const entitySchema = await import("../../lib/synthesis/entity-extractor.js");
const { slugify } = entitySchema;

// -----------------------------------------------------------------------------
// Inline fixtures. TWO synthetic commits on one repo: a human contributor
// whose author_email is a GitHub noreply address (`<id>+<login>@users.
// noreply.github.com`) and a dependabot commit (bracketed bot login, one
// parent). Nothing is read from disk: the slug discipline is what is under
// test, so the rows only have to carry the connector's raw_content shape.
// -----------------------------------------------------------------------------

const FIXTURES = {
  contributor: {
    raw_content: {
      repo_path: "/home/alex/projects/sample-tool",
      commit_hash: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
      author_name: "sam-sample",
      author_email: "10000001+sam-sample@users.noreply.github.com",
      author_ts: "2026-03-12T09:15:20-07:00",
      subject: "Initial scaffold for the sample command-line tool",
      parents: [],
    },
  },
  dependabot: {
    raw_content: {
      repo_path: "/home/alex/projects/sample-tool",
      commit_hash: "5e6f708192a3b4c5d6e7f8091a2b3c4d1a2b3c4d",
      author_name: "dependabot[bot]",
      author_email:
        "10000002+dependabot[bot]@users.noreply.github.com",
      author_ts: "2026-04-08T06:05:44-07:00",
      subject: "Bump actions/checkout from 3 to 5 (#2)",
      parents: ["708192a3b4c5d6e7f8091a2b3c4d1a2b3c4d5e6f"],
    },
  },
};

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

test("module exports VERSION + frozen CAPS pinned to foundation spec", () => {
  // CAPS surface for the WU engineering discipline (Module exports VERSION
  // + frozen CAPS). VERSION matches the worked example's emitter_version.
  assert.equal(VERSION, "git-log-local@1.0.0");
  assert.equal(STRUCTURED_FEATURES_SCHEMA_VERSION, "v1");
  assert.equal(STRUCTURED_FEATURES_EMITTER_VERSION, "git-log-local@1.0.0");
  assert.equal(STRUCTURED_FEATURES_SOURCE_SCOPE, "git-log");
  assert.equal(CAPS.SCHEMA_VERSION, "v1");
  assert.equal(CAPS.EMITTER_VERSION, "git-log-local@1.0.0");
  assert.equal(CAPS.SOURCE_SCOPE, "git-log");
  // Frozen bag: mutation MUST throw in strict mode (test files are ESM =
  // strict mode by default).
  assert.throws(() => {
    CAPS.SCHEMA_VERSION = "v2";
  });
  // The emitter-version regex from time-anchor-schema.md §8 I8 must match
  // the literal we publish (CI alignment between this module + the spec).
  const emitterRegex = /^[a-z0-9_\-]+@[0-9]+\.[0-9]+\.[0-9]+(\+[a-z0-9_\-]+)*$/;
  assert.match(VERSION, emitterRegex);
});

test("contributor@sample-tool — structural emit pins person + project entities", () => {
  const out = buildStructuredFeatures(FIXTURES.contributor.raw_content);
  assert.notEqual(out, null, "expected structured_features for contributor fixture");
  assert.equal(out.schema_version, "v1");
  assert.equal(out.emitter_version, "git-log-local@1.0.0");

  // Entities array — pinned by canonical_id, sorted ascending.
  assert.ok(Array.isArray(out.entities), "entities is an array");
  assert.equal(out.entities.length, 2, "person + project");
  // Sort invariant (foundation spec §3.1).
  for (let i = 1; i < out.entities.length; i++) {
    assert.ok(
      out.entities[i - 1].canonical_id < out.entities[i].canonical_id,
      "entities sorted ascending by canonical_id",
    );
  }

  // person:git-log:<slug(10000001+sam-sample@users.noreply.github.com)>
  const expectedPersonSlug = slugify(
    "10000001+sam-sample@users.noreply.github.com",
  );
  const expectedPersonId = `person:git-log:${expectedPersonSlug}`;
  const personEnt = out.entities.find((e) => e.kind === "person");
  assert.ok(personEnt, "person entity present");
  assert.equal(personEnt.canonical_id, expectedPersonId);
  assert.equal(
    personEnt.surface,
    "10000001+sam-sample@users.noreply.github.com",
  );
  assert.equal(personEnt.source_scope, "git-log");
  assert.equal(personEnt.evidence, "structural");
  assert.equal(personEnt.confidence, 1.0);
  assert.equal(personEnt.extractor_version, "git-log-local@1.0.0");

  // project:git-log:sample_tool (basename of /home/alex/projects/sample-tool)
  const expectedProjectSlug = slugify("sample-tool");
  assert.equal(
    expectedProjectSlug,
    "sample_tool",
    "slug discipline yields sample_tool",
  );
  const expectedProjectId = `project:git-log:${expectedProjectSlug}`;
  const projectEnt = out.entities.find((e) => e.kind === "project");
  assert.ok(projectEnt, "project entity present");
  assert.equal(projectEnt.canonical_id, expectedProjectId);
  assert.equal(projectEnt.surface, "sample-tool");
  assert.equal(projectEnt.source_scope, "git-log");
  assert.equal(projectEnt.evidence, "structural");

  // parties[] is the canonicalized projection — should carry the person
  // canonical_id only (the project is not a party).
  assert.deepEqual(out.parties, [expectedPersonId]);
});

test("contributor@sample-tool — absolute time_anchor with UTC-normalized iso", () => {
  const out = buildStructuredFeatures(FIXTURES.contributor.raw_content);
  assert.ok(Array.isArray(out.time_anchors), "time_anchors is an array");
  assert.equal(out.time_anchors.length, 1);
  const ta = out.time_anchors[0];
  assert.equal(ta.kind, "absolute");
  assert.equal(ta.structural, true, "structural pinning per foundation spec OQ5");
  assert.equal(ta.extractor_confidence, 1.0);
  assert.equal(ta.extractor_version, "git-log-local@1.0.0");
  // raw_phrase preserves the original-TZ form verbatim (audit anchor).
  assert.equal(ta.raw_phrase, FIXTURES.contributor.raw_content.author_ts);
  // parsed.iso is UTC-normalized. For "2026-03-12T09:15:20-07:00" the
  // UTC instant is 2026-03-12T16:15:20.000Z.
  const expectedIso = new Date(
    Date.parse(FIXTURES.contributor.raw_content.author_ts),
  ).toISOString();
  assert.equal(ta.parsed.iso, expectedIso);
  // Sanity: parsed.iso is a strict ISO-8601 string with the trailing Z.
  assert.match(ta.parsed.iso, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/);
});

test("dependabot@sample-tool — bot author email yields person canonical_id", () => {
  const out = buildStructuredFeatures(FIXTURES.dependabot.raw_content);
  assert.notEqual(out, null);
  // Person entity present even for bot authors — the structural emit is
  // policy-agnostic (third_party_inferred classification lives on
  // source_policy, not on the structural payload).
  const personEnt = out.entities.find((e) => e.kind === "person");
  assert.ok(personEnt, "bot person entity present");
  // The slug discipline routes the dependabot email through the same
  // slugify pipeline (entity-extractor §5.2). The brackets in
  // `dependabot[bot]` collapse to underscores per step 4.
  const email = FIXTURES.dependabot.raw_content.author_email;
  const expectedSlug = slugify(email);
  assert.equal(personEnt.canonical_id, `person:git-log:${expectedSlug}`);
  // Slug regex compliance (entity-schema §5.2 step 7).
  const slugPart = personEnt.canonical_id.split(":").pop();
  assert.match(slugPart, /^[a-z0-9]+(_[a-z0-9]+)*$/);
  // Surface verbatim — no case-fold, no NFC (entity-schema §4).
  assert.equal(personEnt.surface, email);
  // parties[] is the canonicalized projection.
  assert.deepEqual(out.parties, [personEnt.canonical_id]);
  // project canonical_id is shared with the contributor row — both commits live in
  // the same repo (the project IS the repo basename).
  const projectEnt = out.entities.find((e) => e.kind === "project");
  assert.ok(projectEnt, "project entity present");
  assert.equal(projectEnt.canonical_id, "project:git-log:sample_tool");
});

test("canonical_id byte-stability — slug exactly matches entity-extractor pipeline", () => {
  // Foundation spec §6 union-by-canonical-id invariant: the connector's
  // canonical_id MUST be byte-identical to what the cascade text-extractor
  // would produce for the same surface. We verify the connector routes
  // through the same slugify() (i.e. zero drift between the two paths).
  const surfaces = [
    "alex.example@example.org",
    "10000001+sam-sample@users.noreply.github.com",
    "10000002+dependabot[bot]@users.noreply.github.com",
    "ExRepo-Check",
    "sample-tool",
    "memory-system",
  ];
  for (const s of surfaces) {
    // The connector's _structuralEntity is private — we exercise it
    // indirectly by passing a raw_content payload that triggers exactly
    // that path.
    const out = buildStructuredFeatures({
      author_email: s.includes("@") ? s : "x@example.com",
      repo_path: s.includes("@") ? "/home/alex/x" : `/home/alex/${s}`,
      author_ts: "2026-01-01T00:00:00Z",
    });
    if (s.includes("@")) {
      const personEnt = out.entities.find((e) => e.kind === "person");
      assert.ok(personEnt);
      assert.equal(personEnt.canonical_id, `person:git-log:${slugify(s)}`);
    } else {
      const projectEnt = out.entities.find((e) => e.kind === "project");
      assert.ok(projectEnt);
      assert.equal(projectEnt.canonical_id, `project:git-log:${slugify(s)}`);
    }
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
    { repo_path: 123, author_email: false, author_ts: null },
    { author_email: "", repo_path: "", author_ts: "" },
    // All three structural fields missing.
    { commit_hash: "abc", subject: "wat" },
  ];
  for (const m of malformed) {
    let out;
    let threw = false;
    try {
      out = buildStructuredFeatures(m);
    } catch (err) {
      threw = true;
    }
    assert.equal(threw, false, `should not throw on ${JSON.stringify(m)}`);
    assert.equal(out, null, `should return null on ${JSON.stringify(m)}`);
  }
});

test("partial parse — author_ts missing yields no time_anchors but still emits entities", () => {
  // The defensive-degradation discipline: a partially-parseable
  // raw_content should emit as much structural signal as it can without
  // suppressing the rest. author_ts missing should NOT drop the person +
  // project entities.
  const out = buildStructuredFeatures({
    author_email: "alex@devbox.example.com",
    repo_path: "/home/alex/projects/memory-system",
    // author_ts intentionally missing
  });
  assert.notEqual(out, null);
  assert.equal(out.time_anchors.length, 0, "no time anchor when ts missing");
  assert.ok(out.entities.length >= 1, "entities still emitted");
  const personEnt = out.entities.find((e) => e.kind === "person");
  assert.ok(personEnt, "person entity present even without ts");
  assert.equal(personEnt.canonical_id, `person:git-log:${slugify("alex@devbox.example.com")}`);
});

test("partial parse — unparseable author_ts string yields no time_anchors", () => {
  const out = buildStructuredFeatures({
    author_email: "alex.example@example.org",
    repo_path: "/home/alex/projects/ExRepo-Check",
    author_ts: "not-an-iso-timestamp",
  });
  assert.notEqual(out, null);
  assert.equal(out.time_anchors.length, 0, "unparseable ts -> empty anchors");
  // Entities still emit (the email + repo basename are still structurally
  // valid).
  const personEnt = out.entities.find((e) => e.kind === "person");
  assert.ok(personEnt);
  assert.equal(personEnt.canonical_id, "person:git-log:alex_example_example_org");
  const projectEnt = out.entities.find((e) => e.kind === "project");
  assert.ok(projectEnt);
  assert.equal(projectEnt.canonical_id, "project:git-log:exrepo_check");
});

test("schema_version + emitter_version present on every emission", () => {
  // Foundation spec §3.1: schema_version and emitter_version are REQUIRED
  // on every payload. The validator (when it lands in mcp/lib/validation.js)
  // will reject rows missing either field. Pin the invariant at the
  // emitter so we don't ship rows the validator would reject.
  const inputs = [
    FIXTURES.contributor.raw_content,
    FIXTURES.dependabot.raw_content,
    {
      author_email: "alex.example@example.org",
      repo_path: "/home/alex/code/atlas",
      author_ts: "2026-06-01T12:00:00Z",
    },
  ];
  for (const rc of inputs) {
    const out = buildStructuredFeatures(rc);
    assert.ok(out);
    assert.equal(typeof out.schema_version, "string");
    assert.equal(out.schema_version, "v1");
    assert.equal(typeof out.emitter_version, "string");
    assert.equal(out.emitter_version, "git-log-local@1.0.0");
    // emitter_version matches the regex pinned in time-anchor-schema.md §8 I8.
    assert.match(
      out.emitter_version,
      /^[a-z0-9_\-]+@[0-9]+\.[0-9]+\.[0-9]+(\+[a-z0-9_\-]+)*$/,
    );
  }
});
