// github-events-content-composer.test.mjs — WU-A2-github-events-content-fix.
//
// Regression battery for the github-events content composer in
// mcp/lib/ingest/salience.js. Pre-fix, normalizeSourceEvent fell back to
// `raw_content.action` (e.g. "merged", "opened", "published") whenever
// `raw_content.body` was missing — so the fact.content emitted for
// PushEvent / PullRequestEvent / IssuesEvent / ReleaseEvent etc. was a
// bare action verb, and the substantive payload (PR title, issue title,
// commit message, release tag, repo, etc.) was silently discarded.
//
// Post-fix _composeGithubEventContent dispatches per event_type and
// stitches the connector-known surfaces (raw_content.pr_title,
// issue_title, first_message, release_name, tag_name, comment_body,
// review_body, repo, ref, ...) into a substantive single-line summary.
//
// HERMETIC: pure-function tests against the exported normalizeSourceEvent.
// No fs, no spawn, no env coupling.

// IMPORTANT: env-before-dynamic-import discipline. The salience module
// loads CAPS + policy-events at import time; we set NODE_ENV first so
// any env-gated branch sees a stable value.
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import test from "node:test";
import assert from "node:assert/strict";

const salience = await import("../../lib/ingest/salience.js");

test("WU-A2 (github-events content composer): real-shape fixtures produce substantive content", () => {
  assert.equal(
    typeof salience.normalizeSourceEvent,
    "function",
    "salience.js must export normalizeSourceEvent",
  );

  // -----------------------------------------------------------------------
  // Fixture 1: real-shape PushEvent. Mirrors what
  // mcp/lib/connectors/github-events.js summarizeEvent() writes for the
  // PushEvent case + the connector's raw_content envelope (repo, public,
  // created_at, actor_login).
  // -----------------------------------------------------------------------
  const pushEvent = {
    source: "github-events",
    raw_content: {
      event_type: "PushEvent",
      ref: "refs/heads/main",
      commits: 3,
      head: "abc123def456",
      first_message: "Fix R25.5 cascade interlocked bugs",
      repo: "example-org/memory-system",
      public: true,
      created_at: "2026-06-15T12:00:00Z",
      actor_login: "example-org",
    },
  };
  const pushOut = salience.normalizeSourceEvent(pushEvent);
  assert.equal(
    typeof pushOut.content,
    "string",
    "PushEvent normalized output must have a string content",
  );
  assert.ok(
    pushOut.content.includes("Fix R25.5 cascade interlocked bugs"),
    `PushEvent content must carry the first commit message; got "${pushOut.content}"`,
  );
  assert.ok(
    pushOut.content.includes("example-org/memory-system"),
    `PushEvent content must carry the repo; got "${pushOut.content}"`,
  );
  assert.ok(
    pushOut.content.includes("refs/heads/main"),
    `PushEvent content must carry the ref; got "${pushOut.content}"`,
  );
  // Regression guard: the bug was that content was a bare action verb.
  // Push doesn't carry an action so we assert the content is NOT just
  // "PushEvent" or "merged"/"opened"/"published".
  assert.ok(
    pushOut.content.length > "PushEvent".length,
    `PushEvent content must be richer than bare event_type; got "${pushOut.content}"`,
  );

  // -----------------------------------------------------------------------
  // Fixture 2: real-shape PullRequestEvent. Mirrors summarizeEvent() for
  // the PullRequestEvent case + the connector's envelope. The connector
  // does NOT write raw_content.body for PR events; pre-fix this fell
  // back to raw.action ("opened") and dropped the title.
  // -----------------------------------------------------------------------
  const prEvent = {
    source: "github-events",
    raw_content: {
      event_type: "PullRequestEvent",
      action: "opened",
      pr_number: 42,
      pr_title: "Add WU-A2 github-events content composer",
      pr_author: "example-org",
      ref: "feature/wu-a2-content-fix",
      repo: "example-org/memory-system",
      public: true,
      created_at: "2026-06-15T13:00:00Z",
      actor_login: "example-org",
    },
  };
  const prOut = salience.normalizeSourceEvent(prEvent);
  assert.equal(
    typeof prOut.content,
    "string",
    "PullRequestEvent normalized output must have a string content",
  );
  assert.ok(
    prOut.content.includes("Add WU-A2 github-events content composer"),
    `PullRequestEvent content must carry the PR title; got "${prOut.content}"`,
  );
  assert.ok(
    prOut.content.includes("#42"),
    `PullRequestEvent content must carry the PR number; got "${prOut.content}"`,
  );
  assert.ok(
    prOut.content.includes("example-org/memory-system"),
    `PullRequestEvent content must carry the repo; got "${prOut.content}"`,
  );
  assert.ok(
    prOut.content.includes("opened"),
    `PullRequestEvent content must carry the action verb; got "${prOut.content}"`,
  );
  // Regression guard: pre-fix this WAS just "opened".
  assert.notEqual(
    prOut.content.trim(),
    "opened",
    "PullRequestEvent content must not be bare action verb",
  );

  // -----------------------------------------------------------------------
  // Fixture 3: IssuesEvent — same pattern, different surfaces.
  // -----------------------------------------------------------------------
  const issueEvent = {
    source: "github-events",
    raw_content: {
      event_type: "IssuesEvent",
      action: "closed",
      issue_number: 7,
      issue_title: "Memory system distillation queue stalls on 5xx",
      issue_author: "example-org",
      repo: "example-org/memory-system",
      public: true,
      created_at: "2026-06-15T14:00:00Z",
      actor_login: "example-org",
    },
  };
  const issueOut = salience.normalizeSourceEvent(issueEvent);
  assert.ok(
    issueOut.content.includes("Memory system distillation queue stalls on 5xx"),
    `IssuesEvent content must carry the issue title; got "${issueOut.content}"`,
  );
  assert.ok(
    issueOut.content.includes("#7"),
    `IssuesEvent content must carry the issue number; got "${issueOut.content}"`,
  );
  assert.ok(
    issueOut.content.includes("closed"),
    `IssuesEvent content must carry the action; got "${issueOut.content}"`,
  );

  // -----------------------------------------------------------------------
  // Fixture 4: ReleaseEvent — tag + body composition.
  // -----------------------------------------------------------------------
  const releaseEvent = {
    source: "github-events",
    raw_content: {
      event_type: "ReleaseEvent",
      action: "published",
      tag_name: "v1.2.0",
      release_name: "Phase 1 ship",
      release_body: "Wave 7 lands the github-events content composer fix among other things.",
      repo: "example-org/memory-system",
      public: true,
      created_at: "2026-06-15T15:00:00Z",
      actor_login: "example-org",
    },
  };
  const releaseOut = salience.normalizeSourceEvent(releaseEvent);
  assert.ok(
    releaseOut.content.includes("v1.2.0"),
    `ReleaseEvent content must carry the tag; got "${releaseOut.content}"`,
  );
  assert.ok(
    releaseOut.content.includes("example-org/memory-system"),
    `ReleaseEvent content must carry the repo; got "${releaseOut.content}"`,
  );
  // Regression guard: pre-fix this WAS just "published".
  assert.notEqual(
    releaseOut.content.trim(),
    "published",
    "ReleaseEvent content must not be bare action verb",
  );

  // -----------------------------------------------------------------------
  // Fixture 5: defensive — malformed/empty raw_content must NOT throw and
  // must produce a string output (length>=0; cascade Layer 2 handles
  // content_mass==0 naturally).
  // -----------------------------------------------------------------------
  const malformed = {
    source: "github-events",
    raw_content: {
      event_type: "PullRequestEvent",
      // numeric where string expected, missing pr_title, missing repo
      pr_number: "not-a-number",
      pr_title: 12345,
    },
  };
  let malformedOut;
  assert.doesNotThrow(() => {
    malformedOut = salience.normalizeSourceEvent(malformed);
  }, "malformed raw_content must not throw");
  assert.equal(
    typeof malformedOut.content,
    "string",
    "malformed raw_content still produces string content",
  );
  assert.ok(
    malformedOut.content.length > 0,
    "malformed raw_content still produces non-empty content",
  );

  // -----------------------------------------------------------------------
  // Fixture 6: backwards-compat — pre-stamped raw_content.body still wins
  // (the IssueCommentEvent path some upstream flatteners use).
  // -----------------------------------------------------------------------
  const bodyWinsEvent = {
    source: "github-events",
    raw_content: {
      event_type: "IssueCommentEvent",
      body: "This is the canonical comment body that should win.",
      action: "created",
      repo: "example-org/memory-system",
    },
  };
  const bodyOut = salience.normalizeSourceEvent(bodyWinsEvent);
  assert.ok(
    bodyOut.content.startsWith("This is the canonical comment body"),
    `body wins when present; got "${bodyOut.content}"`,
  );

  // -----------------------------------------------------------------------
  // Fixture 7: pre-stamped event.content is idempotent (caller-supplied
  // content is never overwritten).
  // -----------------------------------------------------------------------
  const preStamped = {
    source: "github-events",
    content: "caller-supplied content stays",
    raw_content: { event_type: "PushEvent", first_message: "should be ignored" },
  };
  const preOut = salience.normalizeSourceEvent(preStamped);
  assert.equal(
    preOut.content,
    "caller-supplied content stays",
    "pre-stamped content is not overwritten",
  );

  // -----------------------------------------------------------------------
  // Fixture 8: regression — none of the five bug-named action verbs
  // ("merged", "opened", "published", "added", "created") show up as the
  // ENTIRE content for any real-shape fixture above. This is the literal
  // bug under test.
  // -----------------------------------------------------------------------
  const bugActions = ["merged", "opened", "published", "added", "created"];
  for (const out of [pushOut, prOut, issueOut, releaseOut]) {
    assert.ok(
      !bugActions.includes(out.content.trim()),
      `content must not be bare action verb; got "${out.content}"`,
    );
  }
});
