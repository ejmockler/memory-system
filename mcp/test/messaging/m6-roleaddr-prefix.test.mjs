// m6-roleaddr-prefix.test.mjs — WORKUNIT M6 (p1-roleaddr-prefix-fix).
//
// Extends the SHARED, GENERIC structural sender-kind classifier
// (mcp/lib/messaging/sender-kind.js) isRoleAddress to be PREFIX/TAG-aware: a
// local-part is a role address when its LEADING separator-delimited token run
// collapses to a known role mailbox (no-reply / support / notifications / …)
// AND is followed by a machine-generated tag — "support.zq4821@example.com",
// "notifications.batch789@…", "no-reply.tx12@…". The fix is CONSERVATIVE:
//   - it NEVER hard-drops a human: a normal personal email and a
//     firstname.lastname@ mailbox both stay person (no leading-token run of
//     theirs collapses to a role);
//   - it matches only on TOKEN boundaries: "supportername@" (no separator after
//     the role word) stays person — the leading token is the whole word, not
//     "support";
//   - it matches only the LEADING token: "john.support@" (role as a SUFFIX)
//     stays person.
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions. Hermetic: NO
// network, NO DB, NO filesystem writes. Reads only the helper source bytes (for
// the purity / generic / 0-platform-token grep gates) and runs the PURE
// predicate over hand-built inputs.
//
// Thesis #1: the predicate is READ-ONLY, PURE (same input => same output, no
// mutation, no I/O), GENERIC (0 platform tokens), and DETERMINISTIC. sender.kind
// flows into the L2-5 EXCLUSION logic, so a false-positive here would drop a
// human — every misfire guard below is therefore a recall guard.
//
// GATE LINE:
//   support_zq4821_service=true normal_personal_email_person=true firstname_lastname_person=true

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  isRoleAddress,
  classifyStructural,
} from "../../lib/messaging/sender-kind.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(__dirname, "../../lib/messaging");
const HELPER_SRC = path.join(LIB_DIR, "sender-kind.js");

// ---------------------------------------------------------------------------
// 1. THE HEADLINE FIX — role-PREFIX + machine tag is a role address.
//    (the class the bug missed: support.zq4821@… returned false => person.)
// ---------------------------------------------------------------------------

test("M6: role PREFIX + tag (dot/dash/underscore) is a role address", () => {
  // The canonical bug case from the work unit.
  assert.equal(
    isRoleAddress("support.zq4821@example.com"),
    true,
    "support.zq4821 — role prefix + dotted tag",
  );
  // Same shape across separators and roles.
  assert.equal(isRoleAddress("notifications.batch789@x.com"), true, "notifications.batch789 (dot)");
  assert.equal(isRoleAddress("notify-12345@x.com"), true, "notify-12345 (dash)");
  assert.equal(isRoleAddress("billing_inv001@store.shop"), true, "billing_inv001 (underscore)");
  assert.equal(isRoleAddress("alerts.system.99@x.com"), true, "alerts.system.99 (multi-tag, digit)");
  // M6r-TIGHTENED: a role word + a NAME-shaped (pure-alpha) tail is now PERSON,
  // not service — "info.john@" is a person who shares a first name with a role.
  assert.equal(isRoleAddress("info.john@corp.example"), false, "info.john — alpha tail 'john' is a name => PERSON (M6r)");
});

test("M6: a compound role (separators INSIDE the role) + tag still matches", () => {
  // "no-reply" itself splits to ["no","reply"]; the leading RUN must collapse to
  // the role before the tag is reached. M6r: the tail must be machine-shaped
  // (carry a digit) — every tag below does.
  assert.equal(isRoleAddress("no-reply.tx123@x.com"), true, "no-reply.tx123");
  assert.equal(isRoleAddress("no_reply.tx123@x.com"), true, "no_reply.tx123");
  assert.equal(isRoleAddress("do_not_reply.x9@x.com"), true, "do_not_reply.x9 (3-token role + digit tag)");
  // M6r-TIGHTENED: a pure-alpha tail ("ABC") is ambiguous (could be a name/word)
  // => PERSON now. A digit-bearing tail ("abc123") stays a role.
  assert.equal(isRoleAddress("donotreply.abc123@x.com"), true, "donotreply.abc123 (collapsed role + digit tag)");
});

// ---------------------------------------------------------------------------
// 2. RECALL GUARDS — a human is NEVER classified as a role (never hard-dropped).
//    These are the conservative invariants the prefix rule must NOT break.
// ---------------------------------------------------------------------------

test("M6: a normal personal email is NOT a role address (person recall)", () => {
  assert.equal(isRoleAddress("alex@example.com"), false, "single-token personal mailbox");
  assert.equal(isRoleAddress("alexexample@example.com"), false, "longer single-token personal mailbox");
  assert.equal(isRoleAddress("sam@example.org"), false, "single-token personal mailbox on a custom domain");
});

test("M6: a firstname.lastname mailbox is NOT a role address (person recall)", () => {
  assert.equal(isRoleAddress("sam.j.sample@example.com"), false, "first.middle.last");
  assert.equal(isRoleAddress("alex.example@startup.io"), false, "first.last");
  assert.equal(isRoleAddress("ada-lovelace@math.org"), false, "first-last (dash)");
  assert.equal(isRoleAddress("alan_turing@bletchley.uk"), false, "first_last (underscore)");
});

test("M6: a role word that is only a PREFIX of one token does NOT misfire", () => {
  // No separator after the role word => the leading TOKEN is the whole word, not
  // the role. These would be false-drops if we matched on substring instead of
  // token boundary.
  assert.equal(isRoleAddress("supportername@x.com"), false, "supportername (no separator)");
  assert.equal(isRoleAddress("infomercial@x.com"), false, "infomercial (info is a substring, not a token)");
  assert.equal(isRoleAddress("teammate@x.com"), false, "teammate (team is a substring)");
  assert.equal(isRoleAddress("newsletterly@x.com"), false, "newsletterly");
  assert.equal(isRoleAddress("helping.hand@x.com"), false, "helping.hand (help is a substring of token 1)");
});

test("M6: a role word as a SUFFIX (not leading) does NOT misfire", () => {
  // The role is the LEADING signal — a trailing role token is a person's name.
  assert.equal(isRoleAddress("john.support@x.com"), false, "support as suffix");
  assert.equal(isRoleAddress("maria.sales@x.com"), false, "sales as suffix");
  assert.equal(isRoleAddress("dev.team@x.com"), false, "team as suffix");
});

// ---------------------------------------------------------------------------
// 3. BACKWARD COMPATIBILITY — the pre-M6 paths still hold (naked role, +tag,
//    separator collapse, non-email).
// ---------------------------------------------------------------------------

test("M6: pre-existing role-address paths are unchanged (no regression)", () => {
  assert.equal(isRoleAddress("no-reply@anybrand.com"), true, "naked no-reply");
  assert.equal(isRoleAddress("noreply@otherbrand.io"), true, "naked noreply (collapsed)");
  assert.equal(isRoleAddress("support@vendor.example"), true, "naked support");
  assert.equal(isRoleAddress("do_not_reply@x.com"), true, "do_not_reply (underscore collapse)");
  assert.equal(isRoleAddress("support+ticket42@x.com"), true, "support+tag subaddress");
  assert.equal(isRoleAddress("not-an-email"), false, "non-email returns false");
  assert.equal(isRoleAddress("@nolocal.com"), false, "empty local-part returns false");
  assert.equal(isRoleAddress(null), false, "null returns false (no throw)");
  assert.equal(isRoleAddress(undefined), false, "undefined returns false (no throw)");
});

// ---------------------------------------------------------------------------
// 4. classifyStructural wiring — the prefixed role flows to "service"; a person
//    yields null (caller defaults person). The CONSERVATIVE default.
// ---------------------------------------------------------------------------

test("M6: classifyStructural maps a prefixed role address to 'service'", () => {
  assert.equal(
    classifyStructural({ email: "support.zq4821@example.com" }),
    "service",
    "prefixed role -> service",
  );
  assert.equal(
    classifyStructural({ id: "notifications.batch789@x.com", handle: "notifications.batch789@x.com" }),
    "service",
    "prefixed role riding on handle/id -> service",
  );
  // A firstname.lastname person yields null => caller defaults person (kept).
  assert.equal(
    classifyStructural({ email: "sam.j.sample@example.com" }),
    null,
    "firstname.lastname -> null (=> person, not dropped)",
  );
  assert.equal(
    classifyStructural({ email: "alex@example.com" }),
    null,
    "personal email -> null (=> person, not dropped)",
  );
});

// ---------------------------------------------------------------------------
// 5. PURITY + DETERMINISM — same input => same output, input not mutated.
// ---------------------------------------------------------------------------

test("M6: the prefix rule is PURE / DETERMINISTIC (same input => same output)", () => {
  const e = "support.zq4821@example.com";
  const a = isRoleAddress(e);
  const b = isRoleAddress(e);
  assert.equal(a, b, "deterministic for a role prefix");
  assert.equal(a, true, "and it is the role classification");
  // classifyStructural over a frozen input object must not mutate it.
  const input = { id: null, email: "notifications.batch789@x.com", handle: null };
  const snapshot = { ...input };
  classifyStructural(input);
  classifyStructural(input);
  assert.deepEqual(input, snapshot, "classifyStructural did not mutate its input");
  // Determinism over a person too (the recall side).
  const p = "sam.j.sample@example.com";
  assert.equal(isRoleAddress(p), isRoleAddress(p), "deterministic for a person");
});

// ---------------------------------------------------------------------------
// 6. GENERICITY — the helper source names NO concrete platform and does no I/O.
//    sender.kind feeds L2-5 exclusion; the abstraction invariant extends here.
// ---------------------------------------------------------------------------

test("M6: the helper is GENERIC — source names NO concrete platform and no I/O", () => {
  const src = readFileSync(HELPER_SRC, "utf8");
  // Strip comments so prose can explain the principle while CODE stays token-free.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
  // The abstraction invariant: the helper names no concrete PLATFORM. (The
  // urn:biz / rbm.goog / rcs tokens are STRUCTURAL business-surface SHAPE
  // primitives in isBusinessHandle — RFC/scheme shapes, not platform brands —
  // so they are part of the helper's legitimate code, exactly as the P1 gate
  // scopes it.)
  for (const platform of ["imessage", "telegram", "whatsapp", '"mail"', "'mail'"]) {
    assert.equal(
      code.includes(platform),
      false,
      `helper code must not name the platform ${platform}`,
    );
  }
  assert.equal(/\bimport\b/.test(code), false, "helper imports nothing");
  assert.equal(/readFileSync|readFile|fetch|require\(|node:fs/.test(code), false, "helper has no I/O");
});

// ---------------------------------------------------------------------------
// 7. THE GATE LINE — the three named witnesses, asserted as one explicit line.
// ---------------------------------------------------------------------------

test("M6 GATE: support_zq4821_service=true normal_personal_email_person=true firstname_lastname_person=true", () => {
  const support_zq4821_service =
    classifyStructural({ email: "support.zq4821@example.com" }) === "service";
  const normal_personal_email_person =
    classifyStructural({ email: "alex@example.com" }) === null;
  const firstname_lastname_person =
    classifyStructural({ email: "sam.j.sample@example.com" }) === null;

  assert.equal(support_zq4821_service, true, "support.zq4821 classified service");
  assert.equal(normal_personal_email_person, true, "normal personal email stays person");
  assert.equal(firstname_lastname_person, true, "firstname.lastname stays person");

  // Emit the literal gate line for the operator log.
  console.log(
    `M6 GATE: support_zq4821_service=${support_zq4821_service} ` +
      `normal_personal_email_person=${normal_personal_email_person} ` +
      `firstname_lastname_person=${firstname_lastname_person}`,
  );
});
