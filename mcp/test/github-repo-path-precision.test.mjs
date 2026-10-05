// github-repo-path-precision.test.mjs
//
// E2 — the GitHub `owner/repo` precision gate in
// mcp/lib/synthesis/entity-extractor.js, behind MEMORY_GH_REPO_PRECISE.
//
// WHY: the repo-path harvester matches any `word/word`, so ordinary prose
// ("pass/fail", "read/write", "150/300") mints org:<a> + project:<b> entities.
// On the RECALL query side those junk keys are catastrophic: entityMatchKey()
// strips the source segment, so a junk query key matches a junk fact key across
// every connector, and entityOverlapJaccard is a plain set intersection.
//
// WHAT THIS PINS:
//   (a) flag ON  — prose ratios/slashed pairs emit ZERO org and ZERO project
//   (b) flag ON  — real github-events repo paths are untouched
//   (c) flag ON  — a chat text carrying a GitHub marker keeps its repo path
//   (d) flag OFF — byte-identical to the historical behavior (the ship default)
//   (e) property — ON emit set ⊆ OFF emit set for every input (SUBTRACTIVE ONLY)
//   (f) the flag is read at CALL time, not cached at module load
//
// Hermetic: pure function over strings. No I/O, no daemon, no fixtures.

import test from "node:test";
import assert from "node:assert/strict";

import {
  extractEntities,
  __internal,
} from "../lib/synthesis/entity-extractor.js";

const FLAG = "MEMORY_GH_REPO_PRECISE";

/**
 * Run `fn` with the precision flag forced on/off, restoring the prior value in
 * a finally so a FAILING ASSERTION CANNOT LEAK the flag into a sibling test
 * (node:test runs this file's tests in one process).
 */
function withFlag(on, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, FLAG);
  const prev = process.env[FLAG];
  if (on) process.env[FLAG] = "1";
  else delete process.env[FLAG];
  try {
    return fn();
  } finally {
    if (had) process.env[FLAG] = prev;
    else delete process.env[FLAG];
  }
}

const ids = (text, source = "chat-claude-code") =>
  extractEntities(text, { source }).entities.map((e) => e.canonical_id);

const kinds = (text, kind, source = "chat-claude-code") =>
  extractEntities(text, { source }).entities.filter((e) => e.kind === kind);

// A >=12-input corpus mixing junk, real repo paths, marker-bearing text and
// neighbouring harvesters (URL / email / file-path) so the subset property is
// exercised against the WHOLE extractor, not just the repo harvester.
const CORPUS = Object.freeze([
  "150/300",
  "pass/fail",
  "either/or",
  "read/write",
  "and/or",
  "input/output ratio 2/3",
  "he said yes/no then 12/34 and a/b",
  "the ratio was 1/2 or 3/4",
  "refs #1234 in owner/repo",
  "example-org/example-repo",
  "claude/memory-system",
  "see https://github.com/example-org/example-repo and bare example-org/example-repo",
  "git@github.com:example-org/example-repo.git plus bare claude/memory-system",
  "gh repo clone example-org/example-repo",
  "alex@example.com pushed example-org/example-repo see https://github.com/example-org/example-repo",
  "src/lib/foo.js and a/b/c.ts",
]);

// The junk inputs the gate exists to kill. Each is ordinary prose or arithmetic.
const JUNK = Object.freeze([
  "150/300",
  "pass/fail",
  "either/or",
  "read/write",
  "and/or",
  "input/output ratio 2/3",
]);

// ---------------------------------------------------------------------------
// (a) Flag ON — the junk corpus emits no org and no project
// ---------------------------------------------------------------------------

test("(a) flag ON: prose slash-pairs and ratios emit zero org and zero project", () => {
  withFlag(true, () => {
    for (const text of JUNK) {
      const orgs = kinds(text, "org");
      const projects = kinds(text, "project");
      assert.equal(
        orgs.length, 0,
        `expected 0 org for ${JSON.stringify(text)}, got ${orgs.map((e) => e.canonical_id).join(",")}`,
      );
      assert.equal(
        projects.length, 0,
        `expected 0 project for ${JSON.stringify(text)}, got ${projects.map((e) => e.canonical_id).join(",")}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Flag ON — github-events repo paths survive (source allowlist)
// ---------------------------------------------------------------------------

test("(b) flag ON: a github-events repo path still emits org + project", () => {
  withFlag(true, () => {
    const got = ids("example-org/example-repo", "github-events");
    assert.ok(
      got.includes("org:github-events:example_org"),
      `missing org:github-events:example_org in ${got.join(",")}`,
    );
    assert.ok(
      got.includes("project:github-events:example_repo"),
      `missing project:github-events:example_repo in ${got.join(",")}`,
    );
  });
});

test("(b') flag ON: github-events keeps the invariant-I5 STOPWORDS bypass ('claude/memory-system')", () => {
  withFlag(true, () => {
    const got = ids("claude/memory-system", "github-events");
    assert.ok(got.includes("org:github-events:claude"), got.join(","));
    assert.ok(got.includes("project:github-events:memory_system"), got.join(","));
  });
});

// ---------------------------------------------------------------------------
// (c) Flag ON — marker allowlist on a non-github source
// ---------------------------------------------------------------------------

test("(c) flag ON: chat text carrying a github.com marker keeps its bare repo path", () => {
  withFlag(true, () => {
    const text =
      "see https://github.com/example-org/example-repo and bare example-org/example-repo";
    const got = ids(text);
    assert.ok(got.includes("org:chat-claude-code:example_org"), got.join(","));
    assert.ok(got.includes("project:chat-claude-code:example_repo"), got.join(","));
  });
});

test("(c') flag ON: 'git@github' and 'gh repo' also arm the allowlist", () => {
  withFlag(true, () => {
    for (const text of [
      "git@github.com:example-org/x.git plus bare claude/memory-system",
      "gh repo clone example-org/example-repo",
    ]) {
      const orgs = kinds(text, "org");
      assert.ok(orgs.length > 0, `marker text lost all orgs: ${JSON.stringify(text)}`);
    }
  });
});

test("(c'') flag ON: the marker is SUBTRACTIVE-ONLY — a URL alone mints no repo entities", () => {
  withFlag(true, () => {
    // The lookbehind already prevents `https://github.com/o/r` from matching
    // the repo pattern. Arming the allowlist must not change that.
    const text = "https://github.com/example-org/example-repo";
    assert.equal(kinds(text, "org").length, 0);
    assert.equal(kinds(text, "project").length, 0);
  });
});

// ---------------------------------------------------------------------------
// (d) Flag OFF — historical behavior is byte-identical (the ship default)
// ---------------------------------------------------------------------------

test("(d) flag OFF: 'pass/fail' still emits org:pass + project:fail", () => {
  withFlag(false, () => {
    const got = ids("pass/fail");
    assert.ok(got.includes("org:chat-claude-code:pass"), got.join(","));
    assert.ok(got.includes("project:chat-claude-code:fail"), got.join(","));
  });
});

test("(d') flag OFF: 'either/or' emits EXACTLY 1 org and 0 project ('or' is below MIN_ENTITY_LENGTH)", () => {
  withFlag(false, () => {
    const orgs = kinds("either/or", "org");
    const projects = kinds("either/or", "project");
    assert.equal(orgs.length, 1, orgs.map((e) => e.canonical_id).join(","));
    assert.equal(orgs[0].canonical_id, "org:chat-claude-code:either");
    assert.equal(projects.length, 0, projects.map((e) => e.canonical_id).join(","));
  });
});

test("(d'') flag OFF: a non-'1' value does NOT arm the gate", () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, FLAG);
  const prev = process.env[FLAG];
  process.env[FLAG] = "true";
  try {
    assert.equal(__internal.repoPrecisionEnabled(), false);
    assert.ok(ids("pass/fail").includes("org:chat-claude-code:pass"));
  } finally {
    if (had) process.env[FLAG] = prev;
    else delete process.env[FLAG];
  }
});

// ---------------------------------------------------------------------------
// (e) Property — ON ⊆ OFF for every input
// ---------------------------------------------------------------------------

test("(e) property: the ON canonical_id set is a subset of the OFF set for every corpus input", () => {
  assert.ok(CORPUS.length >= 12, "corpus must be >= 12 inputs");
  for (const text of CORPUS) {
    const off = new Set(withFlag(false, () => ids(text)));
    const on = new Set(withFlag(true, () => ids(text)));
    for (const id of on) {
      assert.ok(
        off.has(id),
        `flag ON ADDED ${id} for ${JSON.stringify(text)} — the gate must be subtractive only`,
      );
    }
  }
});

test("(e') property holds on the github-events source too", () => {
  for (const text of CORPUS) {
    const off = new Set(withFlag(false, () => ids(text, "github-events")));
    const on = new Set(withFlag(true, () => ids(text, "github-events")));
    for (const id of on) {
      assert.ok(off.has(id), `flag ON ADDED ${id} for ${JSON.stringify(text)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// (f) The flag is read at CALL time, not cached at module load
// ---------------------------------------------------------------------------

test("(f) repoPrecisionEnabled() is read per call — flipping the env between two calls changes the output", () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, FLAG);
  const prev = process.env[FLAG];
  try {
    delete process.env[FLAG];
    assert.equal(__internal.repoPrecisionEnabled(), false);
    const before = ids("pass/fail");

    process.env[FLAG] = "1";
    assert.equal(__internal.repoPrecisionEnabled(), true);
    const after = ids("pass/fail");

    assert.notDeepEqual(before, after, "flag flip had no effect — the env read is cached");
    assert.ok(before.includes("org:chat-claude-code:pass"));
    assert.equal(after.length, 0);
  } finally {
    if (had) process.env[FLAG] = prev;
    else delete process.env[FLAG];
  }
});

test("(f') GH_MARKER_RE is stateless — repeated .test() on the same input is stable", () => {
  const re = __internal.GH_MARKER_RE;
  assert.equal(re.global, false, "a /g marker regex would alternate via lastIndex");
  const s = "see https://github.com/a/b";
  assert.equal(re.test(s), true);
  assert.equal(re.test(s), true);
  assert.equal(re.test(s), true);
});

// ---------------------------------------------------------------------------
// Determinism under the flag (invariant I1 stays true on BOTH paths)
// ---------------------------------------------------------------------------

test("determinism: two calls on the same input are byte-identical with the flag ON", () => {
  withFlag(true, () => {
    const text =
      "alex@example.com pushed example-org/example-repo see https://github.com/example-org/example-repo";
    const a = extractEntities(text, { source: "git-log" });
    const b = extractEntities(text, { source: "git-log" });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});
