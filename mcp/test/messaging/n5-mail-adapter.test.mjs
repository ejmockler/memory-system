// n5-mail-adapter.test.mjs — WORKUNIT N5 regression suite for the Email (Mail)
// adapter (mcp/lib/messaging/adapters/mail.js + fixtures/n5/).
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions. Hermetic:
// reads ONLY the N5 fixture corpus + the adapter/validator lib source (the
// adapter loads the operator identity map read-only at module scope; no DB, no
// network, no daemon, no embed server, no writes). Runs in well under 2s.
//
// What this suite proves (mapped to the N5 REVIEW + TESTS + GATE checks):
//   - addressed_to_me fires off To:/Cc: membership (the first-class signal).
//   - is_from_me detects operator authorship via the union isOperatorEmail.
//   - thread_type stays "dm" even for multi-recipient mail (no group promotion).
//   - reply_to_id: In-Reply-To precedence, else LAST References id.
//   - thread_id = References root; a reply + its parent share a thread_id.
//   - reply_to_me is NOT faked from reply_to_id's mere presence (honest L1).
//   - mentions=[] and structured_mentions=false (email has no @mention).
//   - the capabilities{} keystone equals the documented mail literal.
//   - ts is integer ms == date_received_seconds * 1000 (the unit trap).
//   - EVERY fixture passes the REAL N1 validateEnvelope (valid == total).
//   - case-insensitive operator addressing matches (lowercasing path).
//   - purity / Thesis #1: a deep-frozen input is not mutated, no throw.
//   - orphan row degrades to source_msg_id == "rowid:<n>".
//   - abstraction invariant: the adapter file carries ZERO foreign-platform
//     tokens, and the emitted envelope keys ⊆ the frozen contract.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Operator identity for this suite: the SYNTHETIC identity file. The env var MUST
// be set before the first import of library code (the identity module reads its
// config once, at load), so every library module below is loaded with a
// top-level dynamic import — a static import would hoist above this assignment.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SYNTHETIC_IDENTITY_FILE = path.join(
  REPO_ROOT,
  "mcp/test/fixtures/operator-identity.synthetic.json",
);
process.env.MEMORY_OPERATOR_IDENTITY_FILE = SYNTHETIC_IDENTITY_FILE;
const SYNTHETIC_IDENTITY = JSON.parse(readFileSync(SYNTHETIC_IDENTITY_FILE, "utf8"));
// Operator addresses come from that file; nothing is hardcoded here.
const [OP_EMAIL] = SYNTHETIC_IDENTITY.emails;

const {
  _toEnvelope,
  MAIL_CAPABILITIES,
  PLATFORM,
} = await import("../../lib/messaging/adapters/mail.js");
const { validateEnvelope } = await import("../../lib/messaging/envelope.js");
const { runtimeCensusConvention } = await import("../../scripts/audit-source-claims.mjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_FILE = path.resolve(
  __dirname,
  "../../lib/messaging/adapters/mail.js",
);
const FIXTURES_DIR = path.resolve(
  __dirname,
  "../../lib/messaging/fixtures/n5",
);

// The exact key set of the frozen N1 contract (reply_to_id is optional but
// always emitted by this adapter). Used by the abstraction-invariant test.
const CONTRACT_KEYS = new Set([
  "platform",
  "thread_id",
  "thread_type",
  "sender",
  "recipients",
  "is_from_me",
  "ts",
  "content",
  "reply_to_id",
  "mentions",
  "directed_at_me_signals",
  "capabilities",
  "source_msg_id",
]);

function fixtureFiles() {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".fixture.json"))
    .sort();
}

function readFixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

function load(name) {
  const fx = readFixture(name);
  return { fx, env: _toEnvelope(fx.raw_mail_row) };
}

// T14 (gate-critical) — EVERY fixture's projected envelope passes the REAL N1
// validator, and matches its declared expected_envelope field-for-field.
test("every N5 fixture projects a valid envelope matching expected (valid==total)", () => {
  const files = fixtureFiles();
  assert.ok(files.length >= 6, "expected at least 6 N5 fixtures");
  let valid = 0;
  for (const f of files) {
    const { fx, env } = load(f);
    const res = validateEnvelope(env);
    assert.equal(res.ok, true, `${f} must validate; errors=${JSON.stringify(res.errors)}`);
    assert.deepEqual(env, fx.expected_envelope, `${f} projection must equal expected_envelope`);
    valid += 1;
  }
  assert.equal(valid, files.length, "valid == total");
});

// T1/T2/T3 (gate-critical) — addressed_to_me fires off To:/Cc: membership.
test("addressed_to_me: operator-in-To true, operator-absent false, Cc-only true", () => {
  const toTrue = load("addressed-true.fixture.json").env;
  assert.equal(toTrue.directed_at_me_signals.addressed_to_me, true);

  const absent = load("addressed-false.fixture.json").env;
  assert.equal(absent.directed_at_me_signals.addressed_to_me, false);

  const ccOnly = load("cc-only-operator.fixture.json").env;
  assert.equal(ccOnly.directed_at_me_signals.addressed_to_me, true, "Cc membership counts as addressing");
});

// T4/T5 — is_from_me authorship via the union isOperatorEmail.
test("is_from_me: operator From true (+ sender.id), non-operator From false", () => {
  const mine = load("operator-from.fixture.json").env;
  assert.equal(mine.is_from_me, true);
  assert.equal(mine.sender.id, OP_EMAIL);
  // Authored-by-me mail does NOT address me (operator not in To/Cc).
  assert.equal(mine.directed_at_me_signals.addressed_to_me, false);

  const theirs = load("addressed-true.fixture.json").env;
  assert.equal(theirs.is_from_me, false);
});

// T6 / REVIEW R3 — multi-recipient mail stays "dm" (NOT promoted to group).
test("thread_type stays 'dm' for a 4-recipient mail; recipients carries the breadth", () => {
  const { env } = load("multi-recipient.fixture.json");
  assert.equal(env.thread_type, "dm");
  assert.equal(env.recipients.length, 4);
  // Every fixture is "dm" — the L1 invariant holds across the whole corpus.
  for (const f of fixtureFiles()) {
    assert.equal(load(f).env.thread_type, "dm", `${f} must be dm`);
  }
});

// T7 — In-Reply-To precedence for reply_to_id.
test("reply_to_id uses In-Reply-To when present", () => {
  const { env } = load("reply.fixture.json");
  assert.equal(env.reply_to_id, "<parent-prev-101@mail.example.com>");
});

// T8 — References fallback (last id) when In-Reply-To is absent.
test("reply_to_id falls back to the LAST References id when no In-Reply-To", () => {
  const { env } = load("references-only.fixture.json");
  assert.equal(env.reply_to_id, "<parent-prev-102@mail.example.com>");
});

// T9 / REVIEW R4 — a reply and its parent share a thread_id (References root).
test("reply and its parent share thread_id (References-root grouping)", () => {
  const reply = load("reply.fixture.json").env;
  const parent = load("parent.fixture.json").env;
  assert.equal(reply.thread_id, "<thread-root-100@mail.example.com>");
  assert.equal(parent.thread_id, "<thread-root-100@mail.example.com>");
  assert.equal(reply.thread_id, parent.thread_id, "reply + parent must group under one thread_id");
});

// T10 / REVIEW R5 — reply_to_me is NOT faked from reply_to_id presence.
test("reply_to_me is the honest per-row value (false) despite a resolved reply_to_id", () => {
  const { env } = load("reply.fixture.json");
  assert.ok(env.reply_to_id, "reply fixture must carry a reply_to_id");
  assert.equal(env.directed_at_me_signals.reply_to_me, false, "no faked cross-message L1 signal");
});

// T11 — email has no structured mention primitive.
test("mentions is [] and structured_mentions is false on every fixture", () => {
  for (const f of fixtureFiles()) {
    const { env } = load(f);
    assert.deepEqual(env.mentions, [], `${f} mentions must be []`);
    assert.equal(env.capabilities.structured_mentions, false, `${f} structured_mentions must be false`);
  }
});

// T12 — the capabilities{} keystone equals the documented mail literal.
test("capabilities keystone equals the documented mail literal (frozen)", () => {
  assert.deepEqual(
    { ...MAIL_CAPABILITIES },
    {
      reply_to_available: true,
      structured_mentions: false,
      self_identity_reliable: true,
      addressing_first_class: true,
    },
  );
  assert.equal(Object.isFrozen(MAIL_CAPABILITIES), true, "keystone literal must be frozen");
  // Every emitted envelope carries the same keystone (degradation/promotion as DATA).
  for (const f of fixtureFiles()) {
    assert.deepEqual(load(f).env.capabilities, { ...MAIL_CAPABILITIES }, `${f} capabilities`);
  }
});

// T13 — ts is integer ms == date_received_seconds * 1000 (the unit trap).
test("ts is integer ms equal to date_received_seconds * 1000", () => {
  const { fx, env } = load("addressed-true.fixture.json");
  assert.equal(Number.isInteger(env.ts), true);
  assert.equal(env.ts, fx.raw_mail_row.date_received * 1000);
  assert.equal(env.ts, 1771060500000);
});

// T15 — case-insensitive operator addressing end-to-end (lowercasing path).
test("UPPERCASE operator address in To is still recognized as addressing", () => {
  const row = {
    source_msg_id: "<msg-ci-008@mail.example.com>",
    date_received: 1771061300,
    raw_content: {
      text: "hi",
      headers: {
        from: "Alice Example <alice@example.com>",
        to: OP_EMAIL.toUpperCase(),
        cc: null,
        "message-id": "<msg-ci-008@mail.example.com>",
      },
    },
  };
  const env = _toEnvelope(row);
  assert.equal(env.directed_at_me_signals.addressed_to_me, true);
  assert.deepEqual(env.recipients, [OP_EMAIL], "recipient is lowercased");
  assert.equal(validateEnvelope(env).ok, true);
});

// T16 / REVIEW R7 — purity / Thesis #1: deep-frozen input is not mutated, no throw.
test("purity: deep-frozen input is not mutated and the call does not throw", () => {
  const fx = readFixture("reply.fixture.json");
  const row = fx.raw_mail_row;
  // Deep-freeze the input graph.
  const deepFreeze = (o) => {
    if (o && typeof o === "object" && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const v of Object.values(o)) deepFreeze(v);
    }
    return o;
  };
  deepFreeze(row);
  const before = JSON.stringify(row);
  let env;
  assert.doesNotThrow(() => {
    env = _toEnvelope(row);
  }, "_toEnvelope must not throw on a frozen input");
  assert.equal(JSON.stringify(row), before, "input must be byte-identical after the call");
  // The returned envelope is a fresh object (not the input).
  assert.notEqual(env, row);
  assert.equal(validateEnvelope(env).ok, true);
});

// T18 / REVIEW R8 — orphan row degrades to source_msg_id == "rowid:<n>".
test("orphan row (no body, empty document_id) yields source_msg_id rowid:<n>", () => {
  const { env } = load("orphan-rowid.fixture.json");
  assert.equal(env.source_msg_id, "rowid:90210");
  assert.equal(env.thread_id, "rowid:90210", "thread_id falls back to source_msg_id when no Message-Id");
  assert.equal(env.content, null, "no body => content null (legal)");
  assert.equal(env.sender.id, "noreply@vendor.example");
  assert.equal(validateEnvelope(env).ok, true);
});

// T17 / REVIEW R6 — abstraction invariant: the adapter file carries ZERO
// foreign-platform tokens, and the emitted envelope keys ⊆ the frozen contract.
test("abstraction invariant: zero foreign-platform tokens; envelope keys subset of contract", () => {
  const src = readFileSync(ADAPTER_FILE, "utf8");
  const FOREIGN = /whatsapp|imessage|telegram|\bjid\b|chat_guid/i;
  assert.equal(FOREIGN.test(src), false, "adapter must carry no foreign-platform tokens");

  for (const f of fixtureFiles()) {
    const { env } = load(f);
    for (const k of Object.keys(env)) {
      assert.equal(CONTRACT_KEYS.has(k), true, `${f} emits non-contract key '${k}'`);
    }
    // No connector-layer leakage into the envelope.
    assert.equal("mailbox_url" in env, false);
    assert.equal("dkim_d_domain" in env, false);
  }
  assert.equal(PLATFORM, "mail");
});

test("marked mail-adapter census comment names a producer and embeds no result", () => {
  const audit = runtimeCensusConvention(
    readFileSync(ADAPTER_FILE, "utf8"),
    "lib/messaging/adapters/mail.js",
  );
  assert.ok(audit.paragraphs.length > 0, "expected a RUNTIME-CENSUS convention marker");
  assert.deepEqual(audit.violations, [], JSON.stringify(audit.violations, null, 2));
});

// Sanity — the adapter reads the connector's curated raw_content.headers shape
// (the REAL row shape) too, not just the snake_case stub form. Proves the
// MAP-M3 headers-tolerance accessor works on the connector's actual output.
test("tolerates the connector's raw_content.headers shape (real row), resolving reply linkage", () => {
  // A row shaped like the connector's _buildLedgerRow output: ISO ts + curated
  // headers, PLUS a full headers map attached as `headers` (the recommended
  // follow-up) carrying in-reply-to/references the curated subset omits.
  const row = {
    source_msg_id: "<real-009@mail.example.com>",
    ts: "2026-02-14T09:15:00.000Z",
    raw_content: {
      text: "real-shape body",
      headers: {
        from: "Alice <alice@example.com>",
        to: OP_EMAIL,
        cc: null,
        "message-id": "<real-009@mail.example.com>",
      },
    },
    // Full extractor headers map carrying the reply linkage.
    headers: {
      "in-reply-to": "<root-200@mail.example.com>",
      references: "<root-200@mail.example.com>",
    },
  };
  const env = _toEnvelope(row);
  assert.equal(env.reply_to_id, "<root-200@mail.example.com>");
  assert.equal(env.thread_id, "<root-200@mail.example.com>");
  assert.equal(env.ts, Date.parse("2026-02-14T09:15:00.000Z"), "ISO ts resolves to ms");
  assert.equal(env.directed_at_me_signals.addressed_to_me, true);
  assert.equal(validateEnvelope(env).ok, true);
});

// ---------------------------------------------------------------------------
// N5-BROADCAST — sender.kind must never hard-drop a human posting via a list.
//
// sender.kind is NOT advisory on this path: a non-person INBOUND envelope is
// dropped at messaging/attention.js:273 (isExcludedInbound) before an attention
// record exists, and again at messaging/catchup.js:763. Both precede the contact
// anchor (catchup.js:825), which can only multiply a score UPWARD. So any rule
// that stamps "service" is a HARD DROP no contact vouch can reverse.
//
// An earlier revision keyed this on list membership alone, which would delete a
// colleague replying on a Google Group. The discriminator must be ORIGIN: a true
// broadcast is sent BY the list (sender domain == list domain); a person merely
// posts THROUGH one. Ambiguity resolves to "person".
// ---------------------------------------------------------------------------
test("N5: list-origin broadcast => service; human posting via a list stays person", () => {
  const mk = (from, listId) => _toEnvelope({
    raw_content: {
      headers: { from, to: OP_EMAIL, subject: "s", "list-id": listId },
      text: "body",
    },
  });

  // (a) True broadcast: sender domain IS the list domain.
  assert.equal(
    mk("Daily Brief <news@dailybrief.example.com>", "<newsletter.dailybrief.example.com>").sender.kind,
    "service",
    "same-origin list mail is a broadcast",
  );

  // (b) THE INVARIANT: a human on a third-party list is NOT dropped.
  assert.equal(
    mk("Alice Smith <alice@acme.com>", "<eng.group.googlegroups.com>").sender.kind,
    "person",
    "a person posting THROUGH a list must stay a person (never hard-drop a human)",
  );

  // (c) Subdomain of the same org still counts as broadcast.
  assert.equal(
    mk("News <news@mail.example.com>", "<list.example.com>").sender.kind,
    "service",
    "sender subdomain of the list domain is same-origin",
  );

  // (d) No List-Id at all => untouched by this rule.
  assert.equal(
    mk("Bob <bob@acme.com>", null).sender.kind,
    "person",
    "absent List-Id leaves classification to the role-address rule",
  );

  // (e) The pre-existing role-address rule still wins regardless of origin.
  assert.equal(
    mk("No Reply <noreply@acme.com>", "<other.example.org>").sender.kind,
    "service",
    "role-address classification is unaffected by the origin test",
  );
});
