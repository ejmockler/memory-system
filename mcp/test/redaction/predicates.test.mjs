// predicates.test.mjs — F-NEW-W1-R49-XAPP-FIXTURE.
//
// Committed regression fixture for the Slack token redaction predicate
// (F-NEW-R49-XAPP-SLACK-FIX). Asserts:
//   - xapp-* app-level tokens are recognised as slack_token and replaced
//     (the F-NEW-R49-XAPP-SLACK-FIX alternation that fixed the missed
//     coverage gap).
//   - xoxb-* classic bot tokens are still recognised (no regression of
//     the historical pattern).
//   - xoxp-* classic user tokens are still recognised.
//   - xoxe-* (rotation/refresh) and xoxr-* are intentionally NOT
//     matched. These were not in the R49 enumeration and have not been
//     observed in this corpus; the non-coverage decision is documented
//     here so a future audit knows it is deliberate (revisit when/if
//     they appear in the wild — see comment block in
//     lib/redaction/predicates.js § slack_token).
//
// Discipline: ES module, node:assert/strict, no filesystem I/O, no env-
// var hermeticity dance (the predicates module is pure data + helpers,
// no MEMORY_ROOT touch). Test-style matches sibling test/*.test.mjs.

import assert from "node:assert/strict";

const mod = await import("../../lib/redaction/predicates.js");
const { redactRow } = mod;

// ---------------------------------------------------------------------------
// Test framework: custom assert-with-label, matches sibling test/*.test.mjs.
// ---------------------------------------------------------------------------
let failures = 0;
let passes = 0;

function pass(label) {
  passes++;
  console.log(`  pass: ${label}`);
}
function fail(label, err) {
  failures++;
  console.log(`  FAIL: ${label}`);
  if (err) {
    console.log(`        ${err && err.stack ? err.stack : err}`);
  }
}
async function test(label, fn) {
  console.log(`test: ${label}`);
  try {
    await fn();
    pass(label);
  } catch (err) {
    fail(label, err);
  }
}

// ---------------------------------------------------------------------------
// Test 1 (F-NEW-W1-R49-XAPP-FIXTURE): xapp- app-level token is
// recognised + redacted. This is the exact regression case from the
// brutalist review of F-NEW-R49-XAPP-SLACK-FIX.
// ---------------------------------------------------------------------------
await test("xapp-1-A123-456-abcd1234ef triggers slack_token redaction", () => {
  const row = { text: "Here is my Slack app token xapp-1-A123-456-abcd1234ef please rotate it" };
  const { row: redacted, triggered_redactions } = redactRow(row);
  assert.ok(
    triggered_redactions.includes("slack_token"),
    `triggered_redactions must include 'slack_token', got: ${JSON.stringify(triggered_redactions)}`,
  );
  assert.ok(
    !redacted.text.includes("xapp-1-A123-456-abcd1234ef"),
    "raw xapp- token must NOT appear in redacted text",
  );
  assert.ok(
    redacted.text.includes("[REDACTED:slack_token]"),
    `redacted text must contain placeholder, got: ${redacted.text}`,
  );
});

// ---------------------------------------------------------------------------
// Test 2: xoxb- classic bot token is still recognised (no regression).
// ---------------------------------------------------------------------------
await test("xoxb- classic bot token still triggers slack_token", () => {
  const row = { body: "xoxb-1234567890-1234567890-AbCdEfGhIjKlMnOpQrStUv" };
  const { row: redacted, triggered_redactions } = redactRow(row);
  assert.ok(
    triggered_redactions.includes("slack_token"),
    "xoxb- must still match slack_token",
  );
  assert.ok(
    !redacted.body.includes("xoxb-1234567890"),
    "xoxb- raw token must be redacted",
  );
});

// ---------------------------------------------------------------------------
// Test 3: xoxp- classic user token is still recognised (no regression).
// ---------------------------------------------------------------------------
await test("xoxp- classic user token still triggers slack_token", () => {
  const row = { note: "found xoxp-1111111111-2222222222-3333333333-abcdef1234" };
  const { row: redacted, triggered_redactions } = redactRow(row);
  assert.ok(
    triggered_redactions.includes("slack_token"),
    "xoxp- must still match slack_token",
  );
  assert.ok(
    !redacted.note.includes("xoxp-1111111111"),
    "xoxp- raw token must be redacted",
  );
});

// ---------------------------------------------------------------------------
// Test 4: xoxe-* (Slack rotation/refresh token) is intentionally NOT
// matched by the current pattern. xoxe and xoxr were not enumerated in
// the R49 spec and have not been observed in this corpus. This test
// LOCKS IN the non-coverage so a future contributor knows the omission
// is deliberate. Revisit + extend the regex when xoxe/xoxr appear in
// telemetry. (See comment block in lib/redaction/predicates.js
// § slack_token for the design decision rationale.)
// ---------------------------------------------------------------------------
await test("xoxe-/xoxr- NOT matched (deliberate non-coverage per R49 spec)", () => {
  const xoxeRow = { text: "xoxe-1-AbCdEfGhIjKl-MnOpQrStUvWxYz-1234567890" };
  const xoxrRow = { text: "xoxr-1-AbCdEfGhIjKl-MnOpQrStUvWxYz-1234567890" };
  const { triggered_redactions: xoxeHits } = redactRow(xoxeRow);
  const { triggered_redactions: xoxrHits } = redactRow(xoxrRow);
  assert.ok(
    !xoxeHits.includes("slack_token"),
    "xoxe- must NOT trigger slack_token (non-coverage is deliberate)",
  );
  assert.ok(
    !xoxrHits.includes("slack_token"),
    "xoxr- must NOT trigger slack_token (non-coverage is deliberate)",
  );
});

// ---------------------------------------------------------------------------
// Test 5: nested xapp- token inside an object subtree is also caught
// (defends the recursive redactValue walk). A bug in tree-walking would
// silently fail the top-level test if the fixture happened to put the
// token at the root.
// ---------------------------------------------------------------------------
await test("xapp- token nested in object subtree is redacted", () => {
  const row = {
    msg_id: "m_001",
    payload: {
      conversation: {
        last_message: "rotate xapp-1-A123-456-abcd1234ef ASAP",
      },
    },
  };
  const { row: redacted, triggered_redactions } = redactRow(row);
  assert.ok(
    triggered_redactions.includes("slack_token"),
    "nested xapp- token must trigger slack_token",
  );
  assert.ok(
    !redacted.payload.conversation.last_message.includes("xapp-1-A123-456-abcd1234ef"),
    "nested raw xapp- token must NOT survive redaction",
  );
});

// ---------------------------------------------------------------------------
// Summary + non-zero exit on failure (matches sibling test discipline).
// ---------------------------------------------------------------------------
console.log("");
console.log(`Passed: ${passes}`);
console.log(`Failed: ${failures}`);
if (failures > 0) {
  process.exit(1);
}
