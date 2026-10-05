// m6r-roleaddr-tighten.test.mjs — WORKUNIT M6r (roleaddr-tighten).
//
// TIGHTENS the M6 PREFIX/TAG rule in the SHARED, GENERIC structural sender-kind
// classifier (mcp/lib/messaging/sender-kind.js) isRoleAddress, per the M6
// review:reject. M6 classified ANY "role-word.<anything>@…" as a role address —
// which over-fired on "info.john@" / "team.smith@", a PERSON who merely shares a
// first name with an RFC 2142 role word. M6r adds the missing discriminator:
//
//   a leading role token + separator + a TAG is a role address ONLY when the TAG
//   looks MACHINE-generated — operationalized as "the tail carries at least one
//   DIGIT" (zq4821, batch789, tx12, inv001, x9, abc123). A purely-ALPHABETIC tail
//   (john, smith, team, hand) is a plausible human NAME / word, so it stays
//   PERSON. When ambiguous => PERSON (never hard-drop a human).
//
// Invariants preserved from M6 (regression-guarded below):
//   - the canonical bug case "support.zq4821@…" still => service (digit tail);
//   - naked role / +tag / separator-collapse / non-email all unchanged;
//   - "supportername@" (substring, not a token), "john.support@" (role as a
//     SUFFIX), "firstname.lastname@" all stay person.
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions. Hermetic: NO
// network, NO DB, NO filesystem writes. Reads only the helper source bytes (for
// the purity / generic / 0-platform-token grep gates) and runs the PURE
// predicate over hand-built inputs.
//
// Thesis #1: the predicate is READ-ONLY, PURE (same input => same output, no
// mutation, no I/O), GENERIC (0 platform tokens), and DETERMINISTIC. sender.kind
// flows into the L2-5 EXCLUSION logic, so a false-positive here would DROP a
// human — every misfire guard below is therefore a person-recall guard, and the
// whole point of M6r is to RAISE recall (return humans M6 wrongly excluded).
//
// GATE LINE:
//   support_zq4821_service=true info_john_person=true team_smith_person=true

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
// 1. THE TIGHTENING — the M6r reject fix. role-word + NAME-shaped tail => PERSON.
//    These are the false positives the review flagged: humans, not roles.
// ---------------------------------------------------------------------------

test("M6r: role word + a pure-ALPHA (name-shaped) tail is a PERSON, not a role", () => {
  // The headline review-reject cases.
  assert.equal(isRoleAddress("info.john@corp.example"), false, "info.john — 'john' is a name => PERSON");
  assert.equal(isRoleAddress("team.smith@corp.example"), false, "team.smith — 'smith' is a name => PERSON");
  // More of the same shape across roles + separators — every tail is pure-alpha.
  assert.equal(isRoleAddress("info.maria@x.com"), false, "info.maria");
  assert.equal(isRoleAddress("support.chen@x.com"), false, "support.chen");
  assert.equal(isRoleAddress("sales.rodriguez@x.com"), false, "sales.rodriguez");
  assert.equal(isRoleAddress("admin-lovelace@x.com"), false, "admin-lovelace (dash)");
  assert.equal(isRoleAddress("billing_turing@x.com"), false, "billing_turing (underscore)");
  // Ambiguous role+role (both alpha) — conservative default is PERSON.
  assert.equal(isRoleAddress("support.team@x.com"), false, "support.team (alpha tail, ambiguous => PERSON)");
});

// ---------------------------------------------------------------------------
// 2. THE PRESERVED M6 FIX — a MACHINE tag (digit-bearing) is still a role.
//    Tightening recall must NOT reopen the original bug.
// ---------------------------------------------------------------------------

test("M6r: role word + a MACHINE tag (carries a digit) is STILL a role address", () => {
  // The canonical M6 bug case — must remain service.
  assert.equal(isRoleAddress("support.zq4821@example.com"), true, "support.zq4821 (digit tail)");
  assert.equal(isRoleAddress("notifications.batch789@x.com"), true, "notifications.batch789");
  assert.equal(isRoleAddress("notify-12345@x.com"), true, "notify-12345");
  assert.equal(isRoleAddress("billing_inv001@store.shop"), true, "billing_inv001");
  assert.equal(isRoleAddress("alerts.system.99@x.com"), true, "alerts.system.99 (multi-token digit tail)");
  // A tail that MIXES letters and a digit is still opaque/machine => role.
  assert.equal(isRoleAddress("noreply.abc123@x.com"), true, "noreply.abc123 (alnum tail with digit)");
  assert.equal(isRoleAddress("support.x9@x.com"), true, "support.x9 (short digit tail)");
});

test("M6r: a compound role (separators INSIDE the role) + digit tail still matches", () => {
  // "no-reply" splits to ["no","reply"]; the leading RUN collapses to the role,
  // then the digit tail proves a machine tag.
  assert.equal(isRoleAddress("no-reply.tx12@x.com"), true, "no-reply.tx12");
  assert.equal(isRoleAddress("no_reply.tx12@x.com"), true, "no_reply.tx12");
  assert.equal(isRoleAddress("do_not_reply.x9@x.com"), true, "do_not_reply.x9 (3-token role + digit tag)");
  // …but the SAME compound role + a pure-alpha (name) tail is now PERSON.
  assert.equal(isRoleAddress("no-reply.john@x.com"), false, "no-reply.john (alpha tail => PERSON)");
});

// ---------------------------------------------------------------------------
// 3. RECALL GUARDS carried over from M6 — a human is NEVER classified as a role.
// ---------------------------------------------------------------------------

test("M6r: a normal personal / firstname.lastname email is NOT a role address", () => {
  assert.equal(isRoleAddress("alex@example.com"), false, "single-token personal mailbox");
  assert.equal(isRoleAddress("sam.j.sample@example.com"), false, "first.middle.last");
  assert.equal(isRoleAddress("alex.example@startup.io"), false, "first.last");
  assert.equal(isRoleAddress("ada-lovelace@math.org"), false, "first-last (dash)");
  // A person whose name HAPPENS to contain a digit must still be a person —
  // because the LEADING token is not a role, the digit-tail rule never engages.
  assert.equal(isRoleAddress("alex2.example@x.com"), false, "leading token not a role => PERSON despite digit");
});

test("M6r: a role word that is only a SUBSTRING / SUFFIX does NOT misfire", () => {
  // No separator after the role word => the leading TOKEN is the whole word.
  assert.equal(isRoleAddress("supportername@x.com"), false, "supportername (no separator)");
  assert.equal(isRoleAddress("infomercial@x.com"), false, "infomercial (info is a substring)");
  // Role as a SUFFIX is a person's name — and even with a digit elsewhere.
  assert.equal(isRoleAddress("john.support@x.com"), false, "support as suffix");
  assert.equal(isRoleAddress("john99.support@x.com"), false, "support as suffix, leading token has a digit");
  assert.equal(isRoleAddress("dev.team@x.com"), false, "team as suffix");
});

// ---------------------------------------------------------------------------
// 4. BACKWARD COMPATIBILITY — the pre-M6 paths still hold (naked role, +tag,
//    separator collapse, non-email). The tightening is strictly additive to the
//    PREFIX path; it touches none of these.
// ---------------------------------------------------------------------------

test("M6r: pre-existing role-address paths are unchanged (no regression)", () => {
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
// 5. classifyStructural wiring — a machine-tagged role flows to "service"; the
//    newly-recalled person (role-word.name) yields null => caller defaults person.
// ---------------------------------------------------------------------------

test("M6r: classifyStructural — machine-tag role => service, role+name => person", () => {
  assert.equal(
    classifyStructural({ email: "support.zq4821@example.com" }),
    "service",
    "machine-tag role -> service",
  );
  // The M6r recall win: this is no longer wrongly excluded.
  assert.equal(
    classifyStructural({ email: "info.john@corp.example" }),
    null,
    "info.john -> null (=> person, NOT dropped) — the M6r fix",
  );
  assert.equal(
    classifyStructural({ id: "team.smith@corp.example", handle: "team.smith@corp.example" }),
    null,
    "team.smith riding on handle/id -> null (=> person)",
  );
});

// ---------------------------------------------------------------------------
// 6. PURITY + DETERMINISM — same input => same output, input not mutated.
// ---------------------------------------------------------------------------

test("M6r: the tightened rule is PURE / DETERMINISTIC (same input => same output)", () => {
  for (const e of [
    "support.zq4821@example.com",
    "info.john@corp.example",
    "team.smith@corp.example",
  ]) {
    assert.equal(isRoleAddress(e), isRoleAddress(e), `deterministic for ${e}`);
  }
  // classifyStructural over an input object must not mutate it.
  const input = { id: null, email: "info.john@corp.example", handle: null };
  const snapshot = { ...input };
  classifyStructural(input);
  classifyStructural(input);
  assert.deepEqual(input, snapshot, "classifyStructural did not mutate its input");
});

// ---------------------------------------------------------------------------
// 7. GENERICITY — the helper source names NO concrete platform and does no I/O.
// ---------------------------------------------------------------------------

test("M6r: the helper is GENERIC — source names NO concrete platform and no I/O", () => {
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
  assert.equal(/\bimport\b/.test(code), false, "helper imports nothing");
  assert.equal(/readFileSync|readFile|fetch|require\(|node:fs/.test(code), false, "helper has no I/O");
});

// ---------------------------------------------------------------------------
// 8. THE GATE LINE — the three named witnesses, asserted as one explicit line.
// ---------------------------------------------------------------------------

test("M6r GATE: support_zq4821_service=true info_john_person=true team_smith_person=true", () => {
  const support_zq4821_service =
    classifyStructural({ email: "support.zq4821@example.com" }) === "service";
  const info_john_person =
    classifyStructural({ email: "info.john@corp.example" }) === null;
  const team_smith_person =
    classifyStructural({ email: "team.smith@corp.example" }) === null;

  assert.equal(support_zq4821_service, true, "support.zq4821 classified service");
  assert.equal(info_john_person, true, "info.john stays person (M6r fix)");
  assert.equal(team_smith_person, true, "team.smith stays person (M6r fix)");

  // Emit the literal gate line for the operator log.
  console.log(
    `M6r GATE: support_zq4821_service=${support_zq4821_service} ` +
      `info_john_person=${info_john_person} ` +
      `team_smith_person=${team_smith_person}`,
  );
});
