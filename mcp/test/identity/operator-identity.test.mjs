// operator-identity.test.mjs
//
// Committed regression test for mcp/lib/identity/operator-identity.js
// (F-NEW-R42-COMMITTED-TESTS).
//
// The module ships no identity: it loads one JSON file, resolved from
// MEMORY_OPERATOR_IDENTITY_FILE or <MEMORY_ROOT>/config/operator-identity.json,
// synchronously at import. This suite therefore points
// MEMORY_OPERATOR_IDENTITY_FILE at the synthetic fixture
// (test/fixtures/operator-identity.synthetic.json) BEFORE the dynamic import
// below. Any other suite that needs an operator must do the same.
//
// Coverage:
//   - isOperator() positive: personal, institutional, send-as and hostname-
//     derived addresses; username; org member; iMessage handle; phone.
//   - isOperator() negative: unrelated addresses and logins, same-domain
//     strangers, and source hints that exclude a list.
//   - org-as-actor: only a login listed in github_org_actor_logins counts as
//     the operator on a GitHub source; another github_orgs entry does not.
//   - getOperatorIdentities() returns the documented five-array shape.
//   - emitHostnameDerivedWarning() fires when hostname-derived authorship
//     exceeds the 5% threshold over a trailing 7-day window
//     (F-NEW-W1-R42-HOSTNAME-OBSERVABILITY reduced from 10% to 5% so the
//     canary catches shared-machine drift earlier).
//   - F-NEW-W1-R42-TEST-EDGE-CASES: frozen-array push rejection on
//     getOperatorIdentities() arrays + null/empty guards on isOperator().
//   - Loader contract, each in a child process: absent file = empty identity
//     + exit 0 + one stderr hint line; the committed example file loads;
//     a malformed file exits non-zero naming the file.
//
// Test style matches sibling test/*.test.mjs (custom `test()` helper +
// node:assert/strict), which the project's package.json test script runs
// in series.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_IDENTITY_FILE = resolve(
  HERE,
  "../fixtures/operator-identity.synthetic.json",
);
const EXAMPLE_IDENTITY_FILE = resolve(
  HERE,
  "../../../config/operator-identity.example.json",
);
const MODULE_URL = pathToFileURL(
  resolve(HERE, "../../lib/identity/operator-identity.js"),
).href;

// MUST precede the import: the module reads its config once, at load.
process.env.MEMORY_OPERATOR_IDENTITY_FILE = SYNTHETIC_IDENTITY_FILE;

const mod = await import("../../lib/identity/operator-identity.js");
const {
  isOperator,
  getOperatorIdentities,
  emitHostnameDerivedWarning,
  getIdentityHealth,
  getHostnameWarnState,
  resetHostnameWarnState,
  OPERATOR_IDENTITY,
} = mod;

// Synthetic identity (mirrors the fixture; no value belongs to a real person).
const PERSONAL = "alex@example.com";
const INSTITUTIONAL = "alex.example@example.org";
const SEND_AS = "ops@example.org";
const HOSTNAME_DERIVED = "alex@devbox.example.com";
const USERNAME = "alex-example";
const ACTOR_ORG = "example-org";
const MEMBER_ORG = "example-labs";
const PHONE = "+15555550101";
const STRANGER = "stranger@example.net";

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

// Import the module in a fresh process with MEMORY_OPERATOR_IDENTITY_FILE
// set to `identityFile`, and report what it loaded as one JSON line on
// stdout. The module is loaded once per process, so every loader-contract
// case needs its own process.
function importInChild(identityFile) {
  const script =
    `const m = await import(${JSON.stringify(MODULE_URL)});` +
    `console.log("RESULT=" + JSON.stringify({` +
    `identity: m.OPERATOR_IDENTITY,` +
    `health: m.getIdentityHealth(),` +
    `defaultKeys: Object.keys(m.default).sort(),` +
    `probes: (process.env.PROBES || "").split(",").filter(Boolean)` +
    `.map((p) => [p, m.isOperator(p), m.isOperator(p, "mail"), m.isOperator(p, "github-events")]),` +
    `}));`;
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MEMORY_OPERATOR_IDENTITY_FILE: identityFile,
        PROBES: [PERSONAL, INSTITUTIONAL, USERNAME, ACTOR_ORG, PHONE, STRANGER].join(","),
      },
    },
  );
  const line = (r.stdout || "").split("\n").find((l) => l.startsWith("RESULT="));
  return {
    status: r.status,
    stderr: r.stderr || "",
    result: line ? JSON.parse(line.slice("RESULT=".length)) : null,
  };
}

// ---------------------------------------------------------------------------
// Test 1: isOperator returns true for the personal address,
// case-insensitively.
// ---------------------------------------------------------------------------
await test("isOperator(personal address) is true, case-insensitive", () => {
  assert.equal(isOperator(PERSONAL), true);
  // Case-insensitive variant.
  assert.equal(isOperator(PERSONAL.toUpperCase()), true);
});

// ---------------------------------------------------------------------------
// Test 2: isOperator returns true for a second registered address.
// ---------------------------------------------------------------------------
await test("isOperator(send-as address) is true", () => {
  assert.equal(isOperator(SEND_AS), true);
});

// ---------------------------------------------------------------------------
// Test 3: isOperator returns true for hostname-derived email. Callers that
// pass this address should already be doing so with awareness that the
// match is hostname-derived (see getIdentityHealth().hostname_derived_emails
// + the review_by marker, both of which come from the config file).
// ---------------------------------------------------------------------------
await test("isOperator(hostname-derived address) is true; health surfaces it", () => {
  assert.equal(isOperator(HOSTNAME_DERIVED), true);
  const health = getIdentityHealth();
  assert.ok(
    health.hostname_derived_emails.includes(HOSTNAME_DERIVED),
    "hostname_derived_emails surface includes the configured address",
  );
  assert.equal(health.review_by, "2030-01-01");
  // Exact key set of the health surface is part of the frozen API.
  assert.deepEqual(Object.keys(health), [
    "schema",
    "loaded_at",
    "counts",
    "hostname_derived_emails",
    "review_by",
  ]);
  assert.equal(health.schema, "operator-identity/v1");
  assert.deepEqual(health.counts, {
    emails: 4,
    github_usernames: 1,
    github_orgs: 2,
    imessage_handles: 1,
    phone_numbers: 1,
  });
});

// ---------------------------------------------------------------------------
// Test 4: isOperator returns false for an unrelated correspondent. Third
// parties surface in mail/imessage corpora because the operator writes to
// them; they MUST NOT be tagged first_party.
// ---------------------------------------------------------------------------
await test("isOperator(unrelated correspondent) is false", () => {
  assert.equal(isOperator(STRANGER), false);
  // Also false under explicit mail-source hint.
  assert.equal(isOperator(STRANGER, "mail"), false);
});

// ---------------------------------------------------------------------------
// Test 5: an org listed in github_org_actor_logins is the operator via the
// org-membership path. Disambiguation: an org lives only in github_orgs,
// never in github_usernames. With no source hint we fall through to the
// all-lists check and hit the org set. With a GitHub source the explicit
// disambiguation branch returns true on the org-membership signal.
// ---------------------------------------------------------------------------
await test("isOperator(actor org) is true (org member, both code paths)", () => {
  assert.equal(isOperator(ACTOR_ORG), true);
  assert.equal(isOperator(ACTOR_ORG, "github-events"), true);
  assert.equal(isOperator(ACTOR_ORG, "github"), true);
  assert.equal(isOperator(ACTOR_ORG.toUpperCase(), "github-events"), true);
  // Confirm the disambiguation invariant: the org is in github_orgs, NOT in
  // github_usernames.
  assert.ok(
    OPERATOR_IDENTITY.github_orgs.includes(ACTOR_ORG),
    "actor org in github_orgs",
  );
  assert.ok(
    !OPERATOR_IDENTITY.github_usernames.includes(ACTOR_ORG),
    "actor org NOT in github_usernames (disambiguated)",
  );
  // The actor rule is GitHub-only: a non-GitHub hint narrows it away.
  assert.equal(isOperator(ACTOR_ORG, "mail"), false);
  // And it is per-login, not per-org: a github_orgs entry that is NOT in
  // github_org_actor_logins matches with no hint (membership) but is not
  // the operator as a GitHub actor.
  assert.equal(isOperator(MEMBER_ORG), true);
  assert.equal(isOperator(MEMBER_ORG, "github-events"), false);
  assert.equal(isOperator(MEMBER_ORG, "github"), false);
});

// ---------------------------------------------------------------------------
// Test 5a: source-hint narrowing for the non-email lists.
// ---------------------------------------------------------------------------
await test("source hints narrow username, iMessage handle and phone lookups", () => {
  // Username: GitHub sources and no-hint only.
  assert.equal(isOperator(USERNAME), true);
  assert.equal(isOperator(USERNAME, "github-events"), true);
  assert.equal(isOperator(USERNAME.toUpperCase(), "github"), true);
  assert.equal(isOperator(USERNAME, "mail"), false);
  assert.equal(isOperator(USERNAME, "imessage"), false);
  // Phone: exact match, iMessage source and no-hint only.
  assert.equal(isOperator(PHONE), true);
  assert.equal(isOperator(PHONE, "imessage"), true);
  assert.equal(isOperator(PHONE, "mail"), false);
  assert.equal(isOperator("+15555550199", "imessage"), false);
  // iMessage handle (an address that is also in emails).
  assert.equal(isOperator(PERSONAL, "imessage"), true);
  // An unknown source name behaves like no hint: every list is checked.
  assert.equal(isOperator(USERNAME, "some-future-source"), true);
});

// ---------------------------------------------------------------------------
// Test 5b: an institutional address is registered as ONE address.
//
// WHY THIS IS PINNED. When an operator address is missing from the identity,
// the omission is observable on the shipped surface rather than merely
// theoretical: mail the operator forwards to themselves parses as an INBOUND
// message from a third party, which the catch-up surface can then rank first
// in its waiting-on-you list. A missing operator identity does not fail
// closed; it manufactures a correspondent. Registering the address also
// stops self-forwards counting as reply history, which is what vouches a
// handle as a contact.
// ---------------------------------------------------------------------------
await test("isOperator(institutional address) is true under every email-routing hint", () => {
  assert.equal(isOperator(INSTITUTIONAL), true);
  // Under the source hints that actually route to the emails list.
  for (const source of ["mail", "git-log", "imessage", "screentime"]) {
    assert.equal(
      isOperator(INSTITUTIONAL, source),
      true,
      `institutional address is operator under source=${source}`,
    );
  }
  // Case-insensitive, like every other entry.
  assert.equal(isOperator("Alex.Example@Example.ORG", "mail"), true);
  assert.ok(
    OPERATOR_IDENTITY.emails.includes(INSTITUTIONAL),
    "institutional address present in the frozen emails export",
  );
  // A DIFFERENT person at the same institution must stay third-party — the
  // registration is one address, not a domain.
  assert.equal(isOperator("someone.else@example.org", "mail"), false);
});

// ---------------------------------------------------------------------------
// Test 5c: every registered address behaves the same way, send-as aliases
// and hostname-derived entries included.
//
// WHY THIS IS PINNED. Send-as aliases are easy to forget: mail addressed to
// an unregistered alias normalizes as addressed to nobody and its inbound
// rows are stored as a third party's. A missing operator identity does not
// fail closed.
// ---------------------------------------------------------------------------
await test("isOperator is true for each registered address and false one step away", () => {
  const PAIRS = [
    [PERSONAL, "someone.else@example.com"],
    [SEND_AS, "ops2@example.org"],
    [HOSTNAME_DERIVED, "alex@otherbox.example.com"],
  ];
  for (const [addr, stranger] of PAIRS) {
    assert.equal(isOperator(addr), true, `${addr} is operator with no hint`);
    // Under the source hints that actually route to the emails list.
    for (const source of ["mail", "git-log", "imessage", "screentime"]) {
      assert.equal(
        isOperator(addr, source),
        true,
        `${addr} is operator under source=${source}`,
      );
    }
    // Case-insensitive, like every other entry.
    assert.equal(
      isOperator(addr.toUpperCase(), "mail"),
      true,
      `${addr} is operator upper-cased under source=mail`,
    );
    assert.ok(
      OPERATOR_IDENTITY.emails.includes(addr),
      `${addr} present in the frozen emails export`,
    );
    // A DIFFERENT address on the same domain must stay third-party — the
    // registration is one address, not a domain.
    assert.equal(
      isOperator(stranger, "mail"),
      false,
      `${stranger} is NOT operator under source=mail`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 6: isOperator returns false for a random address.
// ---------------------------------------------------------------------------
await test("isOperator('random@example.net') is false", () => {
  assert.equal(isOperator("random@example.net"), false);
  // And with several source hints.
  for (const source of ["mail", "imessage", "git-log", "github-events"]) {
    assert.equal(
      isOperator("random@example.net", source),
      false,
      `random@example.net under source=${source}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 7: getOperatorIdentities returns the documented five-array shape.
// ---------------------------------------------------------------------------
await test("getOperatorIdentities returns 5-array shape", () => {
  const ids = getOperatorIdentities();
  const expectedKeys = [
    "emails",
    "github_usernames",
    "github_orgs",
    "imessage_handles",
    "phone_numbers",
  ];
  for (const key of expectedKeys) {
    assert.ok(Array.isArray(ids[key]), `${key} is an Array`);
  }
  // Exactly five keys (no extras leaking through).
  assert.equal(
    Object.keys(ids).length,
    5,
    "getOperatorIdentities surface has exactly 5 keys",
  );
  // Anchor values from the synthetic fixture.
  assert.ok(ids.emails.includes(PERSONAL));
  assert.ok(ids.emails.includes(SEND_AS));
  assert.ok(ids.github_orgs.includes(ACTOR_ORG));
  assert.ok(ids.github_orgs.includes(MEMBER_ORG));
  // OPERATOR_IDENTITY: frozen, the same five keys, the same arrays.
  assert.ok(Object.isFrozen(OPERATOR_IDENTITY), "OPERATOR_IDENTITY is frozen");
  assert.deepEqual(Object.keys(OPERATOR_IDENTITY), expectedKeys);
  for (const key of expectedKeys) {
    assert.equal(OPERATOR_IDENTITY[key], ids[key], `${key} is the same array`);
  }
  // Default export: 5 arrays + 6 functions.
  assert.deepEqual(Object.keys(mod.default).sort(), [
    "emails",
    "emitHostnameDerivedWarning",
    "getHostnameWarnState",
    "getIdentityHealth",
    "getOperatorIdentities",
    "github_orgs",
    "github_usernames",
    "imessage_handles",
    "isOperator",
    "phone_numbers",
    "resetHostnameWarnState",
  ]);
});

// ---------------------------------------------------------------------------
// Test 8: emitHostnameDerivedWarning fires when matches > 5% of total
// (F-NEW-W1-R42-HOSTNAME-OBSERVABILITY reduced threshold from 10% -> 5%).
// 6 hostname-derived hits out of 100 commits = 6% > 5% threshold => warn.
// ---------------------------------------------------------------------------
await test(
  "emitHostnameDerivedWarning fires at 6/100 over 5% threshold",
  () => {
    resetHostnameWarnState();
    // Capture console.warn output.
    const original = console.warn;
    let warned = null;
    console.warn = (msg) => {
      warned = msg;
    };
    try {
      const result = emitHostnameDerivedWarning(100, 6);
      assert.equal(result.triggered, true, "result.triggered=true");
      assert.equal(result.reason, "threshold_exceeded");
      assert.equal(result.total, 100);
      assert.equal(result.matches, 6);
      assert.ok(typeof warned === "string" && warned.length > 0, "warn called");
      assert.ok(
        warned.includes("hostname-derived"),
        "warn message mentions hostname-derived",
      );
      assert.ok(warned.includes("6/100"), "warn message includes 6/100 ratio");
      assert.ok(warned.includes("5%"), "warn message includes 5% threshold");
    } finally {
      console.warn = original;
    }

    // Negative control: 5/100 = exactly 5% should NOT trigger (strict
    // > comparison).
    console.warn = () => {};
    try {
      const result = emitHostnameDerivedWarning(100, 5);
      assert.equal(
        result.triggered,
        false,
        "exactly-at-threshold (5/100) does not trigger",
      );
    } finally {
      console.warn = original;
    }

    // Negative control: 4/100 = under 5% should NOT trigger.
    console.warn = () => {};
    try {
      const result = emitHostnameDerivedWarning(100, 4);
      assert.equal(
        result.triggered,
        false,
        "under-threshold (4/100) does not trigger",
      );
    } finally {
      console.warn = original;
    }

    // Array form: 1 hostname-derived row out of 5 = 20% => triggers.
    let warned2 = null;
    console.warn = (msg) => {
      warned2 = msg;
    };
    try {
      const result = emitHostnameDerivedWarning([
        { author_email: HOSTNAME_DERIVED, ts: "2026-06-01T00:00:00Z" },
        { author_email: SEND_AS, ts: "2026-06-02T00:00:00Z" },
        { author_email: SEND_AS, ts: "2026-06-03T00:00:00Z" },
        { author_email: SEND_AS, ts: "2026-06-04T00:00:00Z" },
        { author_email: SEND_AS, ts: "2026-06-05T00:00:00Z" },
      ]);
      assert.equal(result.triggered, true, "array-form triggers at 1/5");
      assert.ok(warned2, "array-form emits warn");
    } finally {
      console.warn = original;
    }
  },
);

// ---------------------------------------------------------------------------
// Test 9 (F-NEW-W1-R42-TEST-EDGE-CASES): frozen-array push rejection.
// getOperatorIdentities() returns Object.freeze'd arrays — any attempt to
// mutate them MUST throw TypeError in strict mode (the ES module loader
// runs in strict mode by default). This locks in the immutability contract
// so a future refactor cannot silently expose a mutable view.
// ---------------------------------------------------------------------------
await test(
  "getOperatorIdentities() arrays are frozen (push throws TypeError)",
  () => {
    const ids = getOperatorIdentities();
    assert.throws(
      () => ids.emails.push("attacker@evil.example"),
      TypeError,
      "emails.push must throw TypeError on frozen array",
    );
    assert.throws(
      () => ids.github_usernames.push("attacker"),
      TypeError,
      "github_usernames.push must throw TypeError on frozen array",
    );
    assert.throws(
      () => ids.github_orgs.push("attacker_org"),
      TypeError,
      "github_orgs.push must throw TypeError on frozen array",
    );
    assert.throws(
      () => ids.imessage_handles.push("attacker@evil.example"),
      TypeError,
      "imessage_handles.push must throw TypeError on frozen array",
    );
    assert.throws(
      () => ids.phone_numbers.push("+15551234567"),
      TypeError,
      "phone_numbers.push must throw TypeError on frozen array",
    );
    // The OPERATOR_IDENTITY default-export view is also frozen.
    assert.throws(
      () => OPERATOR_IDENTITY.emails.push("attacker@evil.example"),
      TypeError,
      "OPERATOR_IDENTITY.emails.push must throw TypeError on frozen array",
    );
  },
);

// ---------------------------------------------------------------------------
// Test 10 (F-NEW-W1-R42-TEST-EDGE-CASES): null/empty/undefined guards on
// isOperator(). These MUST return false without throwing — connectors
// routinely pass through whatever the source surfaced (which may be
// `null` for missing author_email, `""` for empty handle columns, or
// `undefined` when a column is absent). A throw here would crash the
// ingest hot path.
// ---------------------------------------------------------------------------
await test(
  "isOperator returns false for '', null, undefined without throwing",
  () => {
    assert.equal(isOperator(""), false, "isOperator('') returns false");
    assert.equal(isOperator(null), false, "isOperator(null) returns false");
    assert.equal(
      isOperator(undefined),
      false,
      "isOperator(undefined) returns false",
    );
    // And with source hints — must STILL return false without throwing.
    for (const source of ["mail", "imessage", "git-log", "github-events"]) {
      assert.equal(
        isOperator("", source),
        false,
        `isOperator('', ${source}) returns false`,
      );
      assert.equal(
        isOperator(null, source),
        false,
        `isOperator(null, ${source}) returns false`,
      );
      assert.equal(
        isOperator(undefined, source),
        false,
        `isOperator(undefined, ${source}) returns false`,
      );
    }
    // Non-string types must also be safe (number, boolean, object).
    assert.equal(isOperator(42), false, "isOperator(42) returns false");
    assert.equal(isOperator(true), false, "isOperator(true) returns false");
    assert.equal(isOperator({}), false, "isOperator({}) returns false");
    assert.equal(isOperator([]), false, "isOperator([]) returns false");
  },
);

// ---------------------------------------------------------------------------
// Test 11 (F-NEW-W1-R42-HOSTNAME-OBSERVABILITY): getHostnameWarnState
// surfaces the most-recent warning per source so memory_connectors_list
// can render health.warnings[].
// ---------------------------------------------------------------------------
await test(
  "getHostnameWarnState surfaces last-warn per source after trigger",
  () => {
    resetHostnameWarnState();
    // Pre-trigger: empty map.
    assert.deepEqual(getHostnameWarnState(), {}, "fresh state is {}");
    // Trigger under explicit source.
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      emitHostnameDerivedWarning(100, 10, { source: "git-log-local" });
    } finally {
      console.warn = originalWarn;
    }
    const state = getHostnameWarnState();
    assert.ok(
      state["git-log-local"],
      "warn state has git-log-local entry after trigger",
    );
    assert.equal(state["git-log-local"].total, 100);
    assert.equal(state["git-log-local"].matches, 10);
    assert.equal(state["git-log-local"].threshold_fraction, 0.05);
    assert.ok(
      typeof state["git-log-local"].ts === "string",
      "warn state entry has ts",
    );
    // Default source when opts.source omitted: 'identity'.
    console.warn = () => {};
    try {
      emitHostnameDerivedWarning(100, 10);
    } finally {
      console.warn = originalWarn;
    }
    const state2 = getHostnameWarnState();
    assert.ok(state2.identity, "warn state has 'identity' default-source entry");
    // resetHostnameWarnState clears.
    resetHostnameWarnState();
    assert.deepEqual(getHostnameWarnState(), {}, "reset clears state");
  },
);

// ---------------------------------------------------------------------------
// Test 12: loader contract — absent file. A host with no config file has NO
// operator: every list is empty, nothing throws, the process exits 0, and
// exactly one stderr line says how to configure it.
// ---------------------------------------------------------------------------
await test("absent config file: empty identity, exit 0, one stderr hint line", () => {
  const dir = mkdtempSync(join(tmpdir(), "operator-identity-test-"));
  try {
    const absent = join(dir, "absent.json");
    const { status, stderr, result } = importInChild(absent);
    assert.equal(status, 0, `child exits 0 (stderr: ${stderr})`);
    assert.ok(result, "child reported a result");
    assert.deepEqual(result.identity, {
      emails: [],
      github_usernames: [],
      github_orgs: [],
      imessage_handles: [],
      phone_numbers: [],
    });
    assert.ok(
      !JSON.stringify(result.identity).includes("@"),
      "no address is derived from the running host",
    );
    assert.deepEqual(result.health.hostname_derived_emails, []);
    assert.equal(result.health.review_by, null);
    for (const [probe, ...answers] of result.probes) {
      assert.deepEqual(
        answers,
        [false, false, false],
        `${probe} is not the operator on an unconfigured host`,
      );
    }
    assert.equal(result.defaultKeys.length, 11, "default export keeps 11 keys");
    const lines = stderr.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1, `exactly one stderr line, got: ${stderr}`);
    assert.ok(lines[0].includes(absent), "hint names the resolved path");
    assert.ok(
      lines[0].includes("config/operator-identity.example.json"),
      "hint names the example file",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 13: loader contract — the committed example file is a valid config
// and loads its example.com values (self-documenting keys are ignored).
// ---------------------------------------------------------------------------
await test("example config file loads its example.com values", () => {
  const { status, stderr, result } = importInChild(EXAMPLE_IDENTITY_FILE);
  assert.equal(status, 0, `child exits 0 (stderr: ${stderr})`);
  assert.equal(stderr, "", "a present, valid config is silent on stderr");
  assert.ok(result.identity.emails.includes(PERSONAL));
  assert.ok(
    result.identity.emails.every((e) => /@([a-z0-9-]+\.)*example\.(com|org)$/.test(e)),
    "example emails are all example.com / example.org",
  );
  assert.deepEqual(Object.keys(result.identity), [
    "emails",
    "github_usernames",
    "github_orgs",
    "imessage_handles",
    "phone_numbers",
  ]);
  assert.ok(result.identity.github_usernames.length >= 1);
  assert.ok(result.identity.github_orgs.length >= 1);
  assert.ok(result.identity.imessage_handles.length >= 1);
  assert.ok(result.identity.phone_numbers.length >= 1);
  assert.ok(result.health.hostname_derived_emails.length >= 1);
  assert.equal(typeof result.health.review_by, "string");
  const personal = result.probes.find(([p]) => p === PERSONAL);
  assert.deepEqual(personal.slice(1), [true, true, true]);
});

// ---------------------------------------------------------------------------
// Test 14: loader contract — a PRESENT but malformed file is a loud error.
// A half-read identity would silently mis-attribute rows, so the import
// must fail and name the file.
// ---------------------------------------------------------------------------
await test("malformed config file: import fails, error names the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "operator-identity-test-"));
  try {
    const CASES = {
      "not-json.json": "{ this is not json",
      "not-an-object.json": JSON.stringify(["alex@example.com"]),
      "emails-not-array.json": JSON.stringify({ emails: "alex@example.com" }),
      "non-string-member.json": JSON.stringify({ github_usernames: ["alex-example", 7] }),
      "review-by-not-string.json": JSON.stringify({ hostname_derived_review_by: 20300101 }),
    };
    for (const [name, body] of Object.entries(CASES)) {
      const file = join(dir, name);
      writeFileSync(file, body);
      const { status, stderr, result } = importInChild(file);
      assert.notEqual(status, 0, `${name}: child exits non-zero`);
      assert.equal(result, null, `${name}: nothing was loaded`);
      assert.ok(stderr.includes(file), `${name}: error names the file`);
    }
    // A directory at the path is a read error other than ENOENT: also loud.
    const { status, stderr } = importInChild(dir);
    assert.notEqual(status, 0, "unreadable path: child exits non-zero");
    assert.ok(stderr.includes(dir), "unreadable path: error names the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
