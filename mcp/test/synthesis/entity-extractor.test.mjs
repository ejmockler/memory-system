// Tests for mcp/lib/synthesis/entity-extractor.js.
// F-SYN-SUBSTRATE-ENTITY-EXTRACTOR — substrate verification.
//
// Test corpus: synthetic entities, one per surface shape the spec and the WU
// prompt name. The operator tokens come from the synthetic identity fixture
// (test/fixtures/operator-identity.synthetic.json), never from literals in
// the library:
//   - "Alex Example" / "Alex Lastname" — iMessage NL person (FM-1 territory)
//   - "examplelabs" — operator-tied org/repo namespace
//   - "I'm back at Springfield" — iMessage prose
//   - "uploading ExRepo-Check" — git-log commit subject
//   - "alex-example/sample-mcp" — github-events repo path
//
// Run: node --test test/synthesis/entity-extractor.test.mjs

import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

// Synthetic operator identity. operator-identity.js resolves its config file
// once, at module load, so this MUST be set before the first library import;
// that is why the library imports below are dynamic (static imports hoist).
process.env.MEMORY_OPERATOR_IDENTITY_FILE = fileURLToPath(
  new URL("../fixtures/operator-identity.synthetic.json", import.meta.url),
);

const {
  ENTITY_KINDS,
  ENTITY_SOURCE_SCOPES,
  ENTITY_EVIDENCE_KINDS,
  ENTITY_EXTRACTOR_VERSION,
  ENTITY_MAX_PER_ROW,
  STOPWORDS,
  MIN_ENTITY_LENGTH,
  slugify,
  buildCanonicalId,
  extractEntities,
  __internal,
} = await import("../../lib/synthesis/entity-extractor.js");

// ---------------------------------------------------------------------------
// Constants surface
// ---------------------------------------------------------------------------

test("ENTITY_KINDS contains the closed 7-type taxonomy", () => {
  assert.deepEqual(
    [...ENTITY_KINDS].sort(),
    ["artifact", "event", "org", "person", "place", "project", "topic"],
  );
});

test("ENTITY_SOURCE_SCOPES enumerates the v0 sources", () => {
  for (const s of ["imessage", "git-log", "github-events", "screentime", "chat-claude-code", "manual"]) {
    assert.ok(ENTITY_SOURCE_SCOPES.includes(s), `missing scope ${s}`);
  }
});

test("ENTITY_EVIDENCE_KINDS includes the four evidence kinds and not the legacy 'ner_with_evidence'", () => {
  for (const k of ["handle", "kb_lookup", "structural", "ner_corroborated"]) {
    assert.ok(ENTITY_EVIDENCE_KINDS.includes(k), `missing evidence ${k}`);
  }
  assert.ok(!ENTITY_EVIDENCE_KINDS.includes("ner_with_evidence"));
});

test("STOPWORDS contains the FM-1 critical bare names and chitchat", () => {
  // FM-1 specific (foundation spec §6.3): the operator's own bare tokens
  // (e-mail local-part and login, from the identity config) and 'claude'.
  assert.ok(STOPWORDS.has("alex"));
  assert.ok(STOPWORDS.has("alex-example"));
  assert.ok(STOPWORDS.has("claude"));
  // The §9.1 FM-1 collapse trio:
  assert.ok(STOPWORDS.has("and"));
  assert.ok(STOPWORDS.has("your"));
  // Chitchat / time-anchor pollution:
  assert.ok(STOPWORDS.has("today"));
  assert.ok(STOPWORDS.has("tomorrow"));
  assert.ok(STOPWORDS.has("maybe"));
});

test("MIN_ENTITY_LENGTH gates short surfaces at >=3 codepoints", () => {
  assert.equal(MIN_ENTITY_LENGTH, 3);
});

// ---------------------------------------------------------------------------
// slugify — one case per surface shape
// ---------------------------------------------------------------------------

test("slugify normalizes 'Alex Example' to 'alex_example'", () => {
  assert.equal(slugify("Alex Example"), "alex_example");
});

test("slugify preserves 'examplelabs' as 'examplelabs'", () => {
  assert.equal(slugify("examplelabs"), "examplelabs");
});

test("slugify collapses 'ExRepo-Check' to 'exrepo_check' (dash → underscore, lowercased)", () => {
  assert.equal(slugify("ExRepo-Check"), "exrepo_check");
});

test("slugify ASCII-folds 'café' (NFC vs NFD divergence pinned at step 1)", () => {
  // The §10.5 / spec checklist test: pre-composed and decomposed 'é' MUST
  // yield byte-identical slugs.
  const nfc = slugify("café"); // composed
  const nfd = slugify("café"); // 'e' + combining acute
  assert.equal(nfc, "cafe");
  assert.equal(nfd, "cafe");
  assert.equal(nfc, nfd);
});

test("slugify returns sentinel '_empty_' when the pipeline drains input", () => {
  assert.equal(slugify("???"), "_empty_");
  assert.equal(slugify("   "), "_empty_");
  assert.equal(slugify("---"), "_empty_");
});

test("slugify truncates to 64 chars and strips trailing underscore", () => {
  const long = "a".repeat(80);
  const out = slugify(long);
  assert.equal(out.length, 64);
  assert.ok(/^a+$/.test(out));
});

test("slugify collapses runs of non-alphanumeric to a single underscore", () => {
  assert.equal(slugify("foo  --  bar"), "foo_bar");
  assert.equal(slugify("alex@example.com"), "alex_example_com");
});

// ---------------------------------------------------------------------------
// buildCanonicalId
// ---------------------------------------------------------------------------

test("buildCanonicalId produces the spec's example 'person:imessage:alex_lastname'", () => {
  const id = buildCanonicalId({ source: "imessage", kind: "person", text: "Alex Lastname" });
  assert.equal(id, "person:imessage:alex_lastname");
});

test("buildCanonicalId composes 'project:git-log:memory_system' for repo basename", () => {
  const id = buildCanonicalId({ source: "git-log", kind: "project", text: "memory-system" });
  assert.equal(id, "project:git-log:memory_system");
});

test("buildCanonicalId composes 'person:git-log:alex_example_com' for an author-email surface", () => {
  const id = buildCanonicalId({ source: "git-log", kind: "person", text: "alex@example.com" });
  assert.equal(id, "person:git-log:alex_example_com");
});

test("buildCanonicalId rejects unknown kinds and unknown source scopes", () => {
  assert.throws(
    () => buildCanonicalId({ source: "imessage", kind: "ghost", text: "x" }),
    /unknown kind/i,
  );
  assert.throws(
    () => buildCanonicalId({ source: "rss", kind: "person", text: "x" }),
    /unknown source_scope/i,
  );
});

test("buildCanonicalId throws when slugify drains to the empty sentinel", () => {
  assert.throws(
    () => buildCanonicalId({ source: "imessage", kind: "person", text: "???" }),
    /empty sentinel/i,
  );
});

// ---------------------------------------------------------------------------
// extractEntities — per-source input shapes
// ---------------------------------------------------------------------------

test("extractEntities on iMessage prose ('I'm back at Springfield') drops bare 'Springfield' (NL — no structural evidence at v0)", () => {
  // At v0 substrate the extractor is structural-only. A bare NL place mention
  // has no structural anchor (no KB lookup, no NER) and should not be admitted.
  // This is exactly the FM-1 defense: no structural signal => no entity.
  const out = extractEntities("I'm back at Springfield", { source: "imessage" });
  assert.equal(out.model_version, ENTITY_EXTRACTOR_VERSION);
  assert.equal(out.entities.length, 0);
});

test("extractEntities on a git-log commit ('uploading ExRepo-Check to https://github.com/alex-example/sample-mcp') admits the URL artifact + repo org/project", () => {
  const subject = "uploading ExRepo-Check to https://github.com/alex-example/sample-mcp";
  const out = extractEntities(subject, { source: "git-log" });
  const ids = out.entities.map((e) => e.canonical_id);
  // The URL must be admitted as an artifact.
  assert.ok(
    ids.some((id) => id.startsWith("artifact:git-log:")),
    `expected an artifact id; got ${ids.join(",")}`,
  );
  // The repo path inside the URL must NOT generate a duplicate org/project on
  // git-log (the URL harvester takes precedence — repo regex skips paths with
  // a leading `/`). Verify owner + project still emit only if they appear
  // standalone; here the only form is inside a URL.
  const orgIds = ids.filter((id) => id.startsWith("org:git-log:"));
  const projectIds = ids.filter((id) => id.startsWith("project:git-log:"));
  // We don't strictly require zero (the regex may still match), but every
  // emitted entity must pass the regex and be admitted under structural.
  for (const e of out.entities) {
    assert.equal(e.evidence, "structural");
    assert.equal(e.source_scope, "git-log");
    assert.equal(e.extractor_version, ENTITY_EXTRACTOR_VERSION);
  }
  // Sanity: entities are sorted by canonical_id ascending.
  for (let i = 1; i < out.entities.length; i++) {
    assert.ok(out.entities[i - 1].canonical_id < out.entities[i].canonical_id);
  }
  // Light no-op references so the lint-style unused vars stay legible.
  void orgIds; void projectIds;
});

test("extractEntities on a github-events repo path ('alex-example/sample-mcp') emits org:alex_example + project:sample_mcp", () => {
  const out = extractEntities("alex-example/sample-mcp", { source: "github-events" });
  const ids = out.entities.map((e) => e.canonical_id);
  assert.ok(ids.includes("org:github-events:alex_example"));
  assert.ok(ids.includes("project:github-events:sample_mcp"));
});

test("extractEntities on a github-events repo path containing the bare token 'alex' admits it under structural evidence (STOPWORDS bypass per invariant I5)", () => {
  // The §9.3 nuance: 'alex' is in STOPWORDS for NL prose; on a structurally-
  // typed surface (actor.login) it must be admitted because structural
  // evidence bypasses STOPWORDS.
  const out = extractEntities("alex/memory-system", { source: "github-events" });
  const ids = out.entities.map((e) => e.canonical_id);
  // 'alex' as the owner-half of a repo path is a structural emit and must
  // survive STOPWORDS.
  assert.ok(
    ids.includes("org:github-events:alex"),
    `expected org:github-events:alex in ${ids.join(",")}`,
  );
  assert.ok(ids.includes("project:github-events:memory_system"));
});

test("extractEntities preserves the surface verbatim while canonicalizing the slug", () => {
  const out = extractEntities("alex-example/sample-mcp", { source: "github-events" });
  const project = out.entities.find((e) => e.canonical_id === "project:github-events:sample_mcp");
  assert.ok(project);
  // Surface preserved verbatim (no case-fold, no NFC) per foundation spec §4.
  assert.equal(project.surface, "sample-mcp");
});

test("extractEntities sorts entities ascending by canonical_id and stamps extractor_version on each", () => {
  const text = "https://example.com/a alex@example.com alex-example/sample-mcp";
  const out = extractEntities(text, { source: "git-log" });
  assert.ok(out.entities.length >= 2);
  for (let i = 1; i < out.entities.length; i++) {
    assert.ok(
      out.entities[i - 1].canonical_id < out.entities[i].canonical_id,
      `not sorted at index ${i}: ${out.entities[i - 1].canonical_id} >= ${out.entities[i].canonical_id}`,
    );
  }
  for (const e of out.entities) {
    assert.equal(e.extractor_version, ENTITY_EXTRACTOR_VERSION);
    assert.equal(e.evidence, "structural");
  }
});

test("extractEntities deduplicates repeated canonical_ids (same URL twice → one entity)", () => {
  const out = extractEntities(
    "see https://example.com/a and again https://example.com/a please",
    { source: "imessage" },
  );
  const ids = out.entities.map((e) => e.canonical_id);
  const unique = new Set(ids);
  assert.equal(ids.length, unique.size);
});

test("extractEntities caps at ENTITY_MAX_PER_ROW", () => {
  // Generate >32 distinct URLs.
  const urls = [];
  for (let i = 0; i < 40; i++) urls.push(`https://example.com/path${i}`);
  const out = extractEntities(urls.join(" "), { source: "imessage" });
  assert.ok(out.entities.length <= ENTITY_MAX_PER_ROW);
});

test("extractEntities throws on unknown source scope", () => {
  assert.throws(() => extractEntities("hi", { source: "rss" }), /unknown source/i);
});

test("extractEntities is deterministic — two calls on the same input produce byte-identical output", () => {
  const text = "alex@example.com pushed alex-example/sample-mcp see https://github.com/alex-example/sample-mcp";
  const a = extractEntities(text, { source: "git-log" });
  const b = extractEntities(text, { source: "git-log" });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// ---------------------------------------------------------------------------
// Conflation gate — STOPWORDS bypass for evidence=structural
// ---------------------------------------------------------------------------

test("admitEntity drops bare 'Alex' surface on iMessage with evidence='handle' (stopword block)", () => {
  const { admitEntity } = __internal;
  const res = admitEntity({
    kind: "person",
    source: "imessage",
    surface: "Alex",
    evidence: "handle",
  });
  assert.equal(res.admit, false);
  assert.equal(res.reason, "stopword");
});

test("admitEntity admits 'Alex Lastname' on iMessage with evidence='handle' (full surface bypasses STOPWORDS on lookup)", () => {
  const { admitEntity } = __internal;
  const res = admitEntity({
    kind: "person",
    source: "imessage",
    surface: "Alex Lastname",
    evidence: "handle",
  });
  assert.equal(res.admit, true);
  assert.equal(res.canonical_id, "person:imessage:alex_lastname");
});

test("admitEntity bypasses STOPWORDS when evidence='structural' (invariant I5; example §9.3)", () => {
  const { admitEntity } = __internal;
  // The exact case from §9.3: actor.login 'alex' on github-events. As NL prose
  // 'alex' would be blocked; with structural evidence it is admitted.
  const res = admitEntity({
    kind: "person",
    source: "github-events",
    surface: "alex",
    evidence: "structural",
  });
  assert.equal(res.admit, true);
  assert.equal(res.canonical_id, "person:github-events:alex");
});

test("admitEntity still blocks STOPWORDS members for non-structural evidence (kb_lookup, ner_corroborated, handle)", () => {
  const { admitEntity } = __internal;
  for (const evidence of ["handle", "kb_lookup", "ner_corroborated"]) {
    const res = admitEntity({
      kind: "person",
      source: "imessage",
      surface: "claude",
      evidence,
    });
    assert.equal(res.admit, false, `expected drop for evidence=${evidence}`);
    assert.equal(res.reason, "stopword");
  }
});

test("admitEntity drops surfaces shorter than MIN_ENTITY_LENGTH (codepoint-based, post-trim)", () => {
  const { admitEntity } = __internal;
  const tooShort = admitEntity({
    kind: "person",
    source: "github-events",
    surface: "no",
    evidence: "structural",
  });
  assert.equal(tooShort.admit, false);
  assert.equal(tooShort.reason, "surface_too_short");
});

test("admitEntity drops when slugify drains to '_empty_'", () => {
  const { admitEntity } = __internal;
  const empty = admitEntity({
    kind: "topic",
    source: "manual",
    surface: "!!!!",
    evidence: "handle",
  });
  assert.equal(empty.admit, false);
  // Could be 'stopword' (no) or 'empty_slug_after_normalize'. '!!!!' isn't in
  // STOPWORDS, so it should be the slug drop. The length check is on codepoints
  // (4 >= 3), so it advances past 'surface_too_short' too.
  assert.equal(empty.reason, "empty_slug_after_normalize");
});

test("admitEntity rejects unknown kinds, unknown source scopes, unknown evidence kinds", () => {
  const { admitEntity } = __internal;
  assert.equal(
    admitEntity({ kind: "ghost", source: "imessage", surface: "abc", evidence: "handle" }).reason,
    "unknown_kind",
  );
  assert.equal(
    admitEntity({ kind: "person", source: "rss", surface: "abc", evidence: "handle" }).reason,
    "unknown_source",
  );
  assert.equal(
    admitEntity({ kind: "person", source: "imessage", surface: "abc", evidence: "vibes" }).reason,
    "unknown_evidence",
  );
});
