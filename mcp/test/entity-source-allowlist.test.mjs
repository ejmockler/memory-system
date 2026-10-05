// Regression coverage for the 2026-07 connector source expansion.
//
// Run: node --test test/entity-source-allowlist.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ENTITY_SOURCE_SCOPES,
  ENTITY_EXTRACTOR_VERSION,
  buildCanonicalId,
  extractEntities,
  __internal,
} from "../lib/synthesis/entity-extractor.js";

const ORIGINAL_SOURCES = Object.freeze([
  "imessage",
  "git-log",
  "github-events",
  "screentime",
  "chat-claude-code",
  "manual",
]);

function slugPart(canonicalId) {
  return canonicalId.split(":").slice(2).join(":");
}

function assertExtractsOnlyFrom(source, text) {
  let out;
  assert.doesNotThrow(() => {
    out = extractEntities(text, { source });
  });
  assert.ok(out.entities.length >= 1, `expected entities for ${source}`);
  for (const entity of out.entities) {
    assert.equal(entity.source_scope, source);
    const escapedSource = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(entity.canonical_id, new RegExp(`^[a-z-]+:${escapedSource}:`));
  }
  return out.entities;
}

test("ENTITY_SOURCE_SCOPES preserves existing source order and extractor version", () => {
  assert.deepEqual([...ENTITY_SOURCE_SCOPES].slice(0, ORIGINAL_SOURCES.length), ORIGINAL_SOURCES);
  assert.equal(ENTITY_EXTRACTOR_VERSION, "v0.1.0");
});

test("existing source spot-check remains byte-identical for a git-log fixture", () => {
  const subject = "publishing Demo-Widget to https://github.com/example-org/example-repo";
  const out = extractEntities(subject, { source: "git-log" });
  assert.deepEqual(
    out.entities.map((entity) => entity.canonical_id),
    ["artifact:git-log:https_github_com_example_org_example_repo"],
  );
  assert.equal(out.model_version, "v0.1.0");
  assert.equal(out.entities[0].extractor_version, "v0.1.0");
});

test("telegram mirrors imessage phone handle canonicalization", () => {
  const surface = "+15551234567";
  assert.equal(
    buildCanonicalId({ source: "telegram", kind: "person", text: surface }),
    "person:telegram:15551234567",
  );

  const [entity] = assertExtractsOnlyFrom("telegram", surface);
  assert.equal(entity.canonical_id, "person:telegram:15551234567");
  const mirrorId = buildCanonicalId({ source: "imessage", kind: "person", text: surface });
  assert.equal(slugPart(entity.canonical_id), slugPart(mirrorId));
});

test("whatsapp mirrors imessage phone handle canonicalization", () => {
  const surface = "+15557654321";
  assert.equal(
    buildCanonicalId({ source: "whatsapp", kind: "person", text: surface }),
    "person:whatsapp:15557654321",
  );

  const [entity] = assertExtractsOnlyFrom("whatsapp", surface);
  assert.equal(entity.canonical_id, "person:whatsapp:15557654321");
  const mirrorId = buildCanonicalId({ source: "imessage", kind: "person", text: surface });
  assert.equal(slugPart(entity.canonical_id), slugPart(mirrorId));
});

test("mail mirrors git-log email canonicalization", () => {
  const surface = "alex@example.com";
  assert.equal(
    buildCanonicalId({ source: "mail", kind: "person", text: surface }),
    "person:mail:alex_example_com",
  );

  const [entity] = assertExtractsOnlyFrom("mail", surface);
  assert.equal(entity.canonical_id, "person:mail:alex_example_com");
  const mirrorId = buildCanonicalId({ source: "git-log", kind: "person", text: surface });
  assert.equal(slugPart(entity.canonical_id), slugPart(mirrorId));
});

test("slack mirrors chat-claude-code artifact canonicalization", () => {
  const surface = "/tmp/x/y.js";
  const [entity] = assertExtractsOnlyFrom("slack", surface);
  assert.equal(entity.canonical_id, "artifact:slack:tmp_x_y_js");

  const [mirror] = extractEntities(surface, { source: "chat-claude-code" }).entities;
  assert.equal(mirror.canonical_id, "artifact:chat-claude-code:tmp_x_y_js");
  assert.equal(slugPart(entity.canonical_id), slugPart(mirror.canonical_id));
});

test("codex-cli mirrors chat-claude-code artifact canonicalization", () => {
  const surface = "/tmp/x/y.js";
  const [entity] = assertExtractsOnlyFrom("codex-cli", surface);
  assert.equal(entity.canonical_id, "artifact:codex-cli:tmp_x_y_js");

  const [mirror] = extractEntities(surface, { source: "chat-claude-code" }).entities;
  assert.equal(mirror.canonical_id, "artifact:chat-claude-code:tmp_x_y_js");
  assert.equal(slugPart(entity.canonical_id), slugPart(mirror.canonical_id));
});

test("unknown sources are still rejected at every guard site", () => {
  assert.throws(() => extractEntities("x", { source: "rss" }), /unknown source/);
  assert.throws(
    () => buildCanonicalId({ source: "rss", kind: "person", text: "alex@example.com" }),
    /unknown source_scope/,
  );
  assert.deepEqual(
    __internal.admitEntity({
      source: "rss",
      kind: "person",
      surface: "alex@example.com",
      evidence: "structural",
    }),
    { admit: false, reason: "unknown_source" },
  );
});
