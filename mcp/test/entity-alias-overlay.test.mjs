import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

// Operator identity is resolved ONCE, when lib/identity/operator-identity.js
// is first loaded. Point it at the synthetic identity file before any library
// module is imported (hence the dynamic imports below: a static import would
// be hoisted above this assignment).
const IDENTITY_FILE = fileURLToPath(
  new URL("./fixtures/operator-identity.synthetic.json", import.meta.url),
);
process.env.MEMORY_OPERATOR_IDENTITY_FILE = IDENTITY_FILE;

const {
  OPERATOR_ENTITY_ALIAS,
  buildAliasOverlay,
  resolveAlias,
} = await import("../lib/synthesis/entity-alias-overlay.js");
const { slugify } = await import("../lib/synthesis/entity-extractor.js");

// Expected values are derived from the identity file, never re-hardcoded.
const IDENTITY = JSON.parse(readFileSync(IDENTITY_FILE, "utf8"));
const OPERATOR_EMAIL = IDENTITY.emails[0];
const OPERATOR_EMAIL_ALT = IDENTITY.emails[1];
const OPERATOR_LOGIN = IDENTITY.github_usernames[0];
const MAIL_PERSON_ID = `person:mail:${slugify(OPERATOR_EMAIL)}`;
const GITHUB_PERSON_ID = `person:github-events:${slugify(OPERATOR_LOGIN)}`;
const GITHUB_ORG_ID = `org:github-events:${slugify(OPERATOR_LOGIN)}`;

const FLAG = "MEMORY_ENTITY_ALIAS_OVERLAY";
const originalFlag = process.env[FLAG];

afterEach(() => {
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
});

test("buildAliasOverlay uses extractor slugs and deduplicates identity surfaces", () => {
  const overlay = buildAliasOverlay();

  assert.equal(overlay instanceof Map, true);
  assert.equal(
    overlay.get(slugify(OPERATOR_EMAIL)),
    OPERATOR_ENTITY_ALIAS,
  );
  assert.equal(
    overlay.get(slugify(OPERATOR_EMAIL_ALT)),
    OPERATOR_ENTITY_ALIAS,
  );
  assert.equal(overlay.has("user"), false);
  assert.equal(overlay.has("assistant"), false);
  assert.equal(overlay.has("system"), false);
});

test("flag off is byte-identical for matching and non-matching ids", () => {
  delete process.env[FLAG];
  const overlay = buildAliasOverlay();
  const input = [
    MAIL_PERSON_ID,
    GITHUB_PERSON_ID,
    "person:imessage:user",
    GITHUB_ORG_ID,
  ];
  const output = input.map((id) => resolveAlias(id, overlay));

  const before = Buffer.from(JSON.stringify(input));
  const after = Buffer.from(JSON.stringify(output));
  assert.equal(Buffer.compare(before, after), 0);
  assert.deepEqual(output, input);
});

test("flag on collapses matching person ids across sources", () => {
  process.env[FLAG] = "1";
  const overlay = buildAliasOverlay();

  assert.equal(
    resolveAlias(MAIL_PERSON_ID, overlay),
    OPERATOR_ENTITY_ALIAS,
  );
  assert.equal(
    resolveAlias(GITHUB_PERSON_ID, overlay),
    OPERATOR_ENTITY_ALIAS,
  );
});

test("flag on preserves roles and rejects a missing overlay hand-off", () => {
  process.env[FLAG] = "1";
  const overlay = buildAliasOverlay();

  for (const role of ["user", "assistant", "system"]) {
    const id = `person:imessage:${role}`;
    assert.equal(resolveAlias(id, overlay), id);
  }
  assert.equal(resolveAlias("person:operator", overlay), "person:operator");
  assert.throws(
    () => resolveAlias(MAIL_PERSON_ID),
    /requires a Map overlay/,
  );
});
