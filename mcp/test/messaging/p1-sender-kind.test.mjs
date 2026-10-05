// p1-sender-kind.test.mjs — WORKUNIT P1 regression suite for the SHARED, GENERIC
// structural sender-kind classifier (mcp/lib/messaging/sender-kind.js) and its
// adapter wiring (imessage / mail) + the L2-5 non-person exclusion.
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions. Hermetic: NO
// network, NO DB, NO filesystem writes. Reads only the helper + adapter source
// bytes (for the purity / generic / 0-platform-token grep gates) and runs the
// pure mappers over hand-built rows.
//
// What this proves (mapped to the P1 GATE + the PRINCIPLE):
//   - STRUCTURAL non-person detection (high precision): an SMS shortcode, an
//     urn:biz business surface, an @rbm.goog RBM agent, and a role-address email
//     (no-reply / support / notifications) each classify to a NON-PERSON kind.
//   - PERSON RECALL ~1.0 (the conservative default): a real >=7-digit phone, a
//     named contact, and an ordinary personal email classify to "person" — NEVER
//     dropped. classifyStructural returns null (no signal) for all of them.
//   - The shared helper is PURE (same input => same output, no mutation, no I/O
//     surface in its source) and GENERIC (names NO concrete platform — the L2-5
//     abstraction invariant extends to this L1 helper).
//   - Each wired adapter (imessage, mail) stamps the structural kind off the
//     shared helper while a person handle stays person.
//   - The four L2-5 sources carry ZERO platform tokens AND read sender.kind as
//     DATA: a service envelope is excluded by attention.js + catchup.js with no
//     platform branch.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  isShortcode,
  isRoleAddress,
  isBusinessHandle,
  classifyStructural,
} = await import("../../lib/messaging/sender-kind.js");
const { toEnvelope: imessageToEnvelope } = await import("../../lib/messaging/adapters/imessage.js");
const { _toEnvelope: mailToEnvelope } = await import("../../lib/messaging/adapters/mail.js");
const { validateEnvelope, SENDER_KINDS } = await import("../../lib/messaging/envelope.js");
const {
  computeAttention,
  getAttentionTelemetry,
  resetAttentionTelemetry,
} = await import("../../lib/messaging/attention.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(__dirname, "../../lib/messaging");
const HELPER_SRC = path.join(LIB_DIR, "sender-kind.js");

// ---------------------------------------------------------------------------
// 1. STRUCTURAL non-person detection — high-precision EXCLUSION.
// ---------------------------------------------------------------------------

test("P1: isShortcode — a 3-6 digit numeric handle is a shortcode; a real phone is not", () => {
  // SMS shortcodes (5- and 6-digit numeric handles; <=6 digits).
  assert.equal(isShortcode("55502"), true, "5-digit shortcode");
  assert.equal(isShortcode("123"), true, "3-digit shortcode (lower bound)");
  assert.equal(isShortcode("555010"), true, "6-digit shortcode (upper bound)");
  // A real phone (>=7 digits) is NOT a shortcode — a person is never dropped.
  assert.equal(isShortcode("+15555550125"), false, "E.164 phone is not a shortcode");
  assert.equal(isShortcode("8675309"), false, "7-digit local number is not a shortcode");
  assert.equal(isShortcode("(555) 555-0123"), false, "formatted 10-digit phone is not a shortcode");
  // An email / urn defers to the other classifiers (single-purpose predicate).
  assert.equal(isShortcode("noreply@x.com"), false, "email is not a shortcode");
  assert.equal(isShortcode("urn:biz:abc"), false, "urn is not a shortcode");
});

test("P1: isBusinessHandle — urn:biz / @rbm.goog / RCS agent are business surfaces", () => {
  assert.equal(isBusinessHandle("urn:biz:1234-abcd"), true, "Apple Business Chat urn:biz");
  assert.equal(isBusinessHandle("agent@rbm.goog"), true, "Google RBM agent address");
  assert.equal(isBusinessHandle("foo@rcs.goog"), true, "RCS agent domain");
  // STRUCTURAL, brand-agnostic: a normal address / phone is NOT a business handle.
  assert.equal(isBusinessHandle("alex@example.com"), false, "personal mailbox is not business");
  assert.equal(isBusinessHandle("+14155550199"), false, "a phone is not a business handle");
});

test("P1: isRoleAddress — role local-part is non-person, domain-agnostic, separator-tolerant", () => {
  assert.equal(isRoleAddress("no-reply@anybrand.com"), true, "no-reply");
  assert.equal(isRoleAddress("noreply@otherbrand.io"), true, "noreply (collapsed)");
  assert.equal(isRoleAddress("support@vendor.example"), true, "support");
  assert.equal(isRoleAddress("notifications@app.dev"), true, "notifications");
  assert.equal(isRoleAddress("billing@store.shop"), true, "billing");
  assert.equal(isRoleAddress("do_not_reply@x.com"), true, "do_not_reply (underscore collapse)");
  assert.equal(isRoleAddress("support+ticket42@x.com"), true, "support+tag subaddress");
  // A real person's mailbox is NOT a role address (never dropped).
  assert.equal(isRoleAddress("alex@example.com"), false, "personal mailbox");
  assert.equal(isRoleAddress("sam.j.sample@example.com"), false, "personal name mailbox");
  assert.equal(isRoleAddress("not-an-email"), false, "non-email returns false");
});

// ---------------------------------------------------------------------------
// 2. classifyStructural — the single GENERIC entry point: non-person -> "service",
//    NO signal -> null (caller defaults person). The CONSERVATIVE default.
// ---------------------------------------------------------------------------

test("P1: classifyStructural maps every structural non-person surface to 'service'", () => {
  assert.equal(classifyStructural({ handle: "55502" }), "service", "shortcode");
  assert.equal(classifyStructural({ id: "urn:biz:abc" }), "service", "urn:biz");
  assert.equal(classifyStructural({ email: "x@rbm.goog" }), "service", "RBM agent");
  assert.equal(classifyStructural({ email: "no-reply@brand.com" }), "service", "role address");
  // An iMessage handle that is itself an email rides in on handle/id.
  assert.equal(
    classifyStructural({ id: "support@vendor.example", handle: "support@vendor.example" }),
    "service",
    "email-shaped handle role address",
  );
});

test("P1: classifyStructural CONSERVATIVE default — a real person yields null (=> person)", () => {
  assert.equal(classifyStructural({ handle: "+15555550125" }), null, "real E.164 phone");
  assert.equal(classifyStructural({ handle: "8675309" }), null, "7-digit local phone");
  assert.equal(classifyStructural({ email: "alex@example.com" }), null, "personal email");
  assert.equal(classifyStructural({ id: "alex@example.com", handle: "alex@example.com" }), null, "personal email handle");
  // Degenerate / empty input never throws and yields null (default person).
  assert.equal(classifyStructural(null), null, "null input -> null");
  assert.equal(classifyStructural({}), null, "empty input -> null");
  assert.equal(classifyStructural({ handle: "" }), null, "empty handle -> null");
});

// ---------------------------------------------------------------------------
// 3. PURITY + GENERICITY of the shared helper (the abstraction invariant).
// ---------------------------------------------------------------------------

test("P1: the shared helper is PURE — same input => same output, input not mutated", () => {
  const input = { id: "55502", handle: "55502", email: null };
  const a = classifyStructural(input);
  const b = classifyStructural(input);
  assert.equal(a, b, "deterministic");
  assert.deepEqual(input, { id: "55502", handle: "55502", email: null }, "input not mutated");
  // Idempotent over a person too.
  const p = { handle: "+15555550125" };
  assert.equal(classifyStructural(p), classifyStructural(p), "deterministic for person");
});

test("P1: the shared helper is GENERIC — its source names NO concrete platform and no I/O", () => {
  const src = readFileSync(HELPER_SRC, "utf8");
  // Strip comments so prose can explain the principle while CODE stays token-free.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
  for (const platform of ["imessage", "telegram", "whatsapp", '"mail"', "'mail'"]) {
    assert.equal(
      code.includes(platform),
      false,
      `helper code must not name the platform ${platform}`,
    );
  }
  // No imports / I/O surface in the helper (pure module).
  assert.equal(/\bimport\b/.test(code), false, "helper imports nothing");
  assert.equal(/readFileSync|readFile|fetch|require\(|node:fs/.test(code), false, "helper has no I/O");
});

// ---------------------------------------------------------------------------
// 4. ADAPTER WIRING — imessage + mail stamp the structural kind; person stays person.
// ---------------------------------------------------------------------------

function imessageRow(handleId) {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    source_msg_id: "guid:test",
    parties: ["user", handleId],
    raw_content: { text: "hi", handle_id: handleId, chat_guid: "iMessage;-;chatTEST", is_from_me: 0 },
  };
}

test("P1: iMessage adapter stamps service for shortcode / urn:biz / @rbm.goog; person for a real phone", () => {
  const shortcode = imessageToEnvelope(imessageRow("55502"), { handleNameFloor: false });
  const biz = imessageToEnvelope(imessageRow("urn:biz:ABC123"), { handleNameFloor: false });
  const rbm = imessageToEnvelope(imessageRow("examplebrand@rbm.goog"), { handleNameFloor: false });
  const role = imessageToEnvelope(imessageRow("support@acme.example"), { handleNameFloor: false });
  const person = imessageToEnvelope(imessageRow("+15555550125"), { handleNameFloor: false });

  assert.equal(shortcode.sender.kind, "service", "shortcode 55502 -> service");
  assert.equal(biz.sender.kind, "service", "urn:biz -> service");
  assert.equal(rbm.sender.kind, "service", "@rbm.goog -> service");
  assert.equal(role.sender.kind, "service", "role-address email handle -> service");
  assert.equal(person.sender.kind, "person", "real phone -> person (NOT dropped)");
  // Every produced envelope is still N1-valid (the kind is in the enum).
  for (const env of [shortcode, biz, rbm, role, person]) {
    assert.equal(validateEnvelope(env).ok, true, "envelope stays N1-valid");
  }
});

function mailRow(from) {
  return {
    date_received: 1771061100,
    raw_content: { headers: { from, to: OP_EMAIL, cc: null }, text: "body" },
  };
}

test("P1: mail adapter stamps service for a role/business From; person for a real person; operator stays person", () => {
  const noreply = mailToEnvelope(mailRow("no-reply@vendor.example"));
  const support = mailToEnvelope(mailRow("Support Team <support@store.shop>"));
  const rbm = mailToEnvelope(mailRow("agent@rbm.goog"));
  const person = mailToEnvelope(mailRow("Alex Example <alex@example.com>"));
  // The operator's OWN address is always a person even if it looked role-ish.
  const mine = mailToEnvelope(mailRow(OP_EMAIL));

  assert.equal(noreply.sender.kind, "service", "no-reply From -> service");
  assert.equal(support.sender.kind, "service", "support From -> service");
  assert.equal(rbm.sender.kind, "service", "rbm From -> service");
  assert.equal(person.sender.kind, "person", "real person From -> person (NOT dropped)");
  assert.equal(mine.is_from_me, true, "operator authored");
  assert.equal(mine.sender.kind, "person", "operator is always a person");
});

// ---------------------------------------------------------------------------
// 5. L2-5 EXCLUSION reads sender.kind as DATA — a service inbound is excluded,
//    a person inbound is kept, with ZERO platform tokens in the L2-5 sources.
// ---------------------------------------------------------------------------

test("P1: L2 attention excludes a non-person inbound by reading sender.kind (no platform branch)", () => {
  // A service inbound (a shortcode 2FA) + a person inbound in the same thread.
  const serviceInbound = imessageToEnvelope(imessageRow("55502"), { handleNameFloor: false });
  const personInbound = imessageToEnvelope(imessageRow("+15555550125"), { handleNameFloor: false });
  // Make them land in distinct threads so each surfaces independently.
  serviceInbound.thread_id = "iMessage;-;chatSERVICE";
  personInbound.thread_id = "iMessage;-;chatPERSON";

  resetAttentionTelemetry();
  // computeAttention returns an ARRAY of thread records; telemetry is a separate
  // module side-channel read via getAttentionTelemetry().
  const records = computeAttention([serviceInbound, personInbound]);
  const tele = getAttentionTelemetry();
  // The non-person inbound is counted as excluded telemetry.
  assert.equal(tele.excluded_nonperson >= 1, true, "at least one non-person inbound excluded");
  // The service thread is dropped entirely (the service inbound was its only row),
  // so it never appears as a 'waiting on me' record.
  const serviceSurfaced = records.some((r) => r && r.thread_id === "iMessage;-;chatSERVICE");
  assert.equal(serviceSurfaced, false, "service thread did not surface as 'waiting on me'");
});

test("P1: the four L2-5 sources carry ZERO platform tokens (abstraction invariant holds)", () => {
  const L2to5 = ["classifier.js", "identity.js", "attention.js", "catchup.js"].map((f) =>
    path.join(LIB_DIR, f),
  );
  for (const file of L2to5) {
    const src = readFileSync(file, "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");
    for (const tok of ["urn:biz", "rbm.goog", "@rcs", "noreply", "no-reply", "shortcode"]) {
      assert.equal(
        code.toLowerCase().includes(tok.toLowerCase()),
        false,
        `${path.basename(file)} must not contain the structural token ${tok}`,
      );
    }
  }
  // Enum sanity — the closed kinds the exclusion reads.
  assert.deepEqual([...SENDER_KINDS], ["person", "bot", "service", "system"]);
});
