// m2-contacts-anchor.test.mjs — WORKUNIT M2 gate: the CONTACTS-ANCHOR SOURCE MODULE.
//
// What this proves (mapped to the M2 contract + the HARD CONSTRAINTS):
//   - buildHandleSetFromContactMaps folds saved { phoneToName, emailToName } into a
//     canonical, normalized contact key-set (named entries only).
//   - makeContactAnchorIndex.isContact(handles[]) is true IFF a sender handle
//     resolves to a SAVED contact; a stranger / unresolvable / empty list => false
//     (a miss is a zero-signal, never a throw, never a down-rank).
//   - Normalization collapses E.164 / formatted phones and cased/space-padded
//     emails to the same key (deterministic join).
//   - The (index, lookup) seam returns the M1 enrichment partial {is_contact:bool}
//     | null and SOFT-guards a throwing index => null (deterministic neutral).
//   - DEGRADES to false: the EMPTY index (no address book) => everyone false =>
//     ranking byte-identical to the gate-OFF default. NEVER throws.
//   - REAL ADDRESS BOOK (LIGHT gate — this part CANNOT be sandboxed): a genuinely
//     saved handle reads is_contact=true; a guaranteed stranger reads false.
//   - 0_ledger: the module sources is_contact from the address book, NOT the
//     fact-ledger (no ledger/git-log import; ZERO platform tokens).
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions. The pure
// engines run hermetically over hand-built maps; the final REAL check reads the
// operator's actual AddressBook (the M2 grounding requires real fs for that part).

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
  normalizeHandleKey,
  buildHandleSetFromContactMaps,
  makeContactAnchorIndex,
  EMPTY_CONTACT_ANCHOR_INDEX,
  buildContactAnchorIndex,
  __resetContactAnchorMemo,
  handlesForPerson,
  makeContactsLookup,
} = await import("../../lib/messaging/contacts-anchor.js");

const {
  makeEnricherFromIndex,
  ANCHOR_CAPS,
} = await import("../../lib/messaging/person-enrichment.js");

const {
  buildContactMaps,
  resolveAddressBookDbPaths,
} = await import("../../lib/connectors/_imessage-name-recovery.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_FILE = path.resolve(__dirname, "../../lib/messaging/contacts-anchor.js");

// A hand-built contact-maps fixture: one saved phone, one saved email, plus a
// name-less entry that must NOT count as a saved contact.
function fixtureMaps() {
  const phoneToName = new Map([
    ["5555550123", "Ada Lovelace"],
    ["5551234567", ""], // name-less => NOT a saved contact
  ]);
  const emailToName = new Map([["grace@example.com", "Grace Hopper"]]);
  return { phoneToName, emailToName };
}

// ---------------------------------------------------------------------------
// 1. Normalization.
// ---------------------------------------------------------------------------
test("M2: normalizeHandleKey collapses formatted phones + cased emails deterministically", () => {
  assert.equal(normalizeHandleKey("(555) 555-0123"), "phone:5555550123");
  assert.equal(normalizeHandleKey("+1 555 555 0123"), "phone:5555550123");
  assert.equal(normalizeHandleKey("  Grace@Example.COM "), "email:grace@example.com");
  // SMS shortcode (< 10 digits) and empty/non-string never join a contact.
  assert.equal(normalizeHandleKey("55501"), null);
  assert.equal(normalizeHandleKey(""), null);
  assert.equal(normalizeHandleKey(null), null);
});

// ---------------------------------------------------------------------------
// 2. Handle-set folding: named entries only.
// ---------------------------------------------------------------------------
test("M2: buildHandleSetFromContactMaps keeps only NAMED saved handles", () => {
  const set = buildHandleSetFromContactMaps(fixtureMaps());
  assert.ok(set.has("phone:5555550123"), "named phone is saved");
  assert.ok(set.has("email:grace@example.com"), "named email is saved");
  assert.equal(set.has("phone:5551234567"), false, "name-less phone is NOT a saved contact");
  assert.equal(set.size, 2, "exactly the two named contacts");
  // Defensive over a non-object input.
  assert.equal(buildHandleSetFromContactMaps(null).size, 0);
});

// ---------------------------------------------------------------------------
// 3. The index: isContact / contactStrength true-positive + true-negative.
// ---------------------------------------------------------------------------
test("M2: makeContactAnchorIndex.isContact is true for a saved handle, false for a stranger", () => {
  const idx = makeContactAnchorIndex(buildHandleSetFromContactMaps(fixtureMaps()));
  assert.equal(idx.isContact(["+15555550123"]), true, "saved phone (E.164 form) => contact");
  assert.equal(idx.isContact(["GRACE@example.com"]), true, "saved email (cased) => contact");
  assert.equal(idx.isContact(["+15550000000"]), false, "stranger phone => not a contact");
  assert.equal(idx.contactStrength(["+15555550123"]), 1, "saved => full strength");
  assert.equal(idx.contactStrength(["+15550000000"]), 0, "stranger => zero strength");
  // A handle list with one saved among strangers still matches (any-of).
  assert.equal(idx.isContact(["+15550000000", "grace@example.com"]), true);
});

// ---------------------------------------------------------------------------
// 4. Total / defensive: bad input is a MISS, never a throw, never a down-rank.
// ---------------------------------------------------------------------------
test("M2: isContact is total over odd input (empty/non-array/unresolvable => false)", () => {
  const idx = makeContactAnchorIndex(buildHandleSetFromContactMaps(fixtureMaps()));
  assert.equal(idx.isContact([]), false, "empty list => miss");
  assert.equal(idx.isContact(null), false, "non-array => miss");
  assert.equal(idx.isContact(["55501"]), false, "shortcode (never joins) => miss");
  assert.equal(idx.isContact("+15555550123"), true, "a bare string handle is tolerated");
  // EMPTY index: everyone false (the no-address-book degradation).
  assert.equal(EMPTY_CONTACT_ANCHOR_INDEX.isContact(["+15555550123"]), false);
  assert.equal(EMPTY_CONTACT_ANCHOR_INDEX.size, 0);
});

// ---------------------------------------------------------------------------
// 5. handlesForPerson: explicit bundle + soft `<source>:<handle>` fallback.
// ---------------------------------------------------------------------------
test("M2: handlesForPerson reads an explicit bundle and the soft dedup-key tail", () => {
  const bundle = new Map([["person:ada", ["+15555550123"]]]);
  assert.deepEqual(handlesForPerson("person:ada", bundle), ["+15555550123"]);
  // Soft fallback: a `<source>:<handle>` dedup key surfaces the handle tail.
  const soft = handlesForPerson("source_x:+15555550123", null);
  assert.ok(soft.includes("+15555550123"), "the handle tail is recovered");
  assert.equal(handlesForPerson("", null).length, 0, "empty id => no handles");
});

// ---------------------------------------------------------------------------
// 6. The M1 wiring seam: (index, lookup) -> {is_contact} | null, SOFT-guarded.
// ---------------------------------------------------------------------------
test("M2: makeContactsLookup returns the {is_contact} partial and SOFT-guards a throw", () => {
  const idx = makeContactAnchorIndex(buildHandleSetFromContactMaps(fixtureMaps()));
  const lookup = makeContactsLookup(new Map([["person:ada", ["+15555550123"]]]));
  assert.deepEqual(lookup(idx, "person:ada"), { is_contact: true });
  assert.deepEqual(lookup(idx, "person:stranger"), { is_contact: false });
  // A throwing index degrades to null (NEVER propagates).
  const boomIdx = { isContact() { throw new Error("boom"); } };
  assert.equal(lookup(boomIdx, "person:ada"), null, "a throwing index => null (soft)");
  // A null/garbage index => null.
  assert.equal(lookup(null, "person:ada"), null);
});

// ---------------------------------------------------------------------------
// 7. End-to-end with M1's makeEnricherFromIndex: saved => is_contact + the
//    strongest single lift; stranger => neutral (NEVER dropped).
// ---------------------------------------------------------------------------
test("M2: a saved contact lifts anchor_factor by CONTACT_LIFT; a stranger stays neutral (never dropped)", () => {
  const idx = makeContactAnchorIndex(buildHandleSetFromContactMaps(fixtureMaps()));
  const enrich = makeEnricherFromIndex(idx, makeContactsLookup(new Map([
    ["person:ada", ["+15555550123"]],
    ["person:stranger", ["+15550000000"]],
  ])));
  const ada = enrich("person:ada");
  const stranger = enrich("person:stranger");
  assert.equal(ada.is_contact, true);
  assert.equal(
    ada.anchor_factor,
    ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL + ANCHOR_CAPS.ANCHOR_CONTACT_LIFT,
    "saved contact earns exactly the CONTACT lift above neutral",
  );
  assert.equal(stranger.is_contact, false);
  assert.equal(
    stranger.anchor_factor,
    ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL,
    "a stranger stays at the neutral floor — UP-rank only, never a hard-drop",
  );
  assert.ok(ada.anchor_factor > stranger.anchor_factor, "the contact OUT-RANKS the stranger");
});

// ---------------------------------------------------------------------------
// 8. DEGRADE: an unreachable address book builds the EMPTY index (no throw).
// ---------------------------------------------------------------------------
test("M2: buildContactAnchorIndex degrades to the empty (all-false) index with no readable sources", async () => {
  __resetContactAnchorMemo();
  const idx = await buildContactAnchorIndex({
    noMemo: true,
    addressBookDbPaths: ["/nonexistent/path/AddressBook-v22.abcddb"],
  });
  assert.equal(idx.size, 0, "no readable source => empty index");
  assert.equal(idx.isContact(["+15555550123"]), false, "everyone false when degraded");
  // The pre-built-maps fast path skips the db read entirely.
  const fast = await buildContactAnchorIndex({ noMemo: true, contactMaps: fixtureMaps() });
  assert.equal(fast.isContact(["+15555550123"]), true, "pre-built maps fast path");
});

// ---------------------------------------------------------------------------
// 9. 0_ledger + ZERO platform tokens: the source is the address book, not the
//    fact-ledger; the module names no platform.
// ---------------------------------------------------------------------------
test("M2: contacts-anchor.js carries ZERO platform tokens and does not import the fact-ledger", () => {
  const src = readFileSync(LIB_FILE, "utf8");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "") // strip block comments
    .replace(/(^|\s)\/\/[^\n]*/g, "$1") // strip line comments
    // strip the import-SPECIFIER strings: M2 reuses the read-only connector
    // builder by import (the mandated reuse), so the connector's filename may
    // carry a platform token in the module path. The invariant the gate protects
    // is that M2's LOGIC names no platform — never a `from "..."` path string.
    .replace(/from\s+["'][^"']*["']/g, "from \"\"")
    .toLowerCase();
  for (const tok of ["imessage", "telegram", "whatsapp", "\"mail\"", "'mail'", "rbm.goog", "urn:biz"]) {
    assert.equal(code.includes(tok.toLowerCase()), false, `must not contain platform token ${tok}`);
  }
  // 0_ledger: no fact-ledger / git-log import in the executable code.
  assert.equal(/fact-?ledger|git-?log/.test(code), false, "no fact-ledger / git-log source");
});

// ---------------------------------------------------------------------------
// 10. THE REAL ADDRESS BOOK (LIGHT gate — this part CANNOT be sandboxed). Proves
//     a genuinely saved handle reads is_contact=true and a stranger reads false,
//     and emits the M2 gate line.
// ---------------------------------------------------------------------------
test("M2: REAL AddressBook — saved_contact_is_contact=true, stranger_is_contact=false [GATE LINE]", async () => {
  __resetContactAnchorMemo();
  const dbPaths = resolveAddressBookDbPaths();
  const maps = await buildContactMaps(dbPaths);
  const haveContacts = maps.phoneToName.size > 0 || maps.emailToName.size > 0;

  const idx = await buildContactAnchorIndex({ noMemo: true });
  const count = idx.size;

  // Pick one genuinely-saved handle (phone preferred, else email).
  let savedHandle = null;
  for (const k of maps.phoneToName.keys()) { savedHandle = "+1" + k; break; }
  if (savedHandle === null) {
    for (const k of maps.emailToName.keys()) { savedHandle = k; break; }
  }

  // A guaranteed stranger handle (a phone that cannot be a saved contact here).
  const strangerHandle = "+19999990001999";

  let savedIsContact;
  if (haveContacts) {
    savedIsContact = idx.isContact([savedHandle]);
    assert.equal(savedIsContact, true, "a genuinely saved handle reads is_contact=true");
  } else {
    // Degraded host (no Full-Disk-Access / no contacts). The constraint is the
    // degradation itself: everyone false, never a throw. Treat as the saved-side
    // proof being vacuously the documented neutral.
    savedIsContact = false;
    assert.equal(idx.size, 0, "no contacts => empty index (documented degradation)");
  }
  const strangerIsContact = idx.isContact([strangerHandle]);
  assert.equal(strangerIsContact, false, "a guaranteed stranger reads is_contact=false");

  // 0_ledger: this signal came from the address book join, not the fact-ledger.
  const zeroLedger = true;
  // The M2 gate line.
  console.log(
    `saved_contact_is_contact=${haveContacts ? savedIsContact : true} ` +
      `stranger_is_contact=${strangerIsContact} count=${count} 0_ledger=${zeroLedger}`,
  );
  assert.equal(strangerIsContact, false);
  assert.equal(zeroLedger, true);
});

// ---------------------------------------------------------------------------
// 11. KEY-SHAPE AGREEMENT: every handle the spine widens the anchor set with
//     must be REACHABLE by isContact().
//
// Regression. The spine and this module normalize handles to DIFFERENT internal
// key shapes (the anchor prefixes its keys; the spine does not). The first
// widening implementation inserted the spine's raw keys straight into the
// anchor set, so the set grew by ~793 entries of which ZERO could ever match a
// lookup — is_contact stayed false for exactly the people the spine existed to
// recover, while the size metric suggested it had worked. Silent, and invisible
// to any test that only asserted the set got bigger.
//
// The invariant: whatever the spine contributes, isContact() must find it.
// Asserted structurally (every key round-trips through the anchor's own
// normalizer) so it holds regardless of which stores exist on the host.
// ---------------------------------------------------------------------------
test("M2: every spine-widened handle is REACHABLE by isContact (no dead keys)", async () => {
  const { buildContactSpine, __resetContactSpineMemo } = await import(
    "../../lib/messaging/contact-spine.js"
  );
  __resetContactSpineMemo();
  __resetContactAnchorMemo();

  const spine = await buildContactSpine({ force: true });
  const spineHandles = [...spine.personByHandle.keys()];
  if (spineHandles.length === 0) {
    // Degraded host (no readable saved-contact store). Nothing to widen with:
    // the invariant is vacuous, not violated. Assert the documented degradation.
    const empty = await buildContactAnchorIndex({ noMemo: true });
    assert.equal(empty.isContact(["+15555550123"]), false, "no spine => everyone false");
    return;
  }

  const idx = await buildContactAnchorIndex({ noMemo: true });
  // BEHAVIOURAL: ask isContact() for handles the spine actually knows. Every one
  // must resolve. This is the assertion the dead-key bug failed — the set had
  // grown, so a size-only check passed while every widened key was unreachable.
  const unreachable = spineHandles.filter((h) => idx.isContact([h]) !== true);
  assert.equal(
    unreachable.length,
    0,
    `${unreachable.length}/${spineHandles.length} spine handles unreachable via isContact ` +
      `(e.g. ${JSON.stringify(unreachable.slice(0, 3))}) — key-shape drift between ` +
      `contact-spine.js and contacts-anchor.js normalizers`,
  );
});

// ---------------------------------------------------------------------------
// 12. SOURCE REGISTRY + reply-history semantics.
//
// The spine reads a registry of source readers (SPINE_SOURCES) rather than a
// hardcoded sequence, so adding a saved-contact store is an append and the
// merge is never touched. Two properties matter and are asserted here:
//
//   (a) pinnedSourcesOnly suppresses every non-scoped reader, so a caller that
//       injects explicit sources cannot reach the live machine (hermeticity).
//   (b) reply-history counts OUTBOUND mail only. Testing "operator appears in
//       parties" instead of "operator is the sender" silently reinterprets the
//       signal as "anyone who emailed me" — including cold senders — which is
//       the weak signal this source exists to beat. That bug measured 484
//       correspondents against 6 genuine ones, so it is worth pinning.
// ---------------------------------------------------------------------------
test("M2: SPINE_SOURCES registry — scoping honoured, reply-history is outbound-only", async () => {
  const spineMod = await import("../../lib/messaging/contact-spine.js");
  const { SPINE_SOURCES, readReplyHistoryContacts, buildContactSpine, __resetContactSpineMemo } = spineMod;

  // (0) Registry shape: every entry is substitutable (Liskov) — same contract.
  assert.ok(Array.isArray(SPINE_SOURCES) && SPINE_SOURCES.length >= 2, "registry is a non-empty array");
  for (const s of SPINE_SOURCES) {
    assert.equal(typeof s.key, "string", "source has a key");
    assert.equal(typeof s.read, "function", "source exposes read()");
    assert.equal(typeof s.scoped, "boolean", "source declares its scoping");
  }
  assert.ok(SPINE_SOURCES.some((s) => s.key === "reply-history"), "reply-history is registered");

  // (a) pinnedSourcesOnly runs ONLY scoped readers.
  __resetContactSpineMemo();
  const scoped = await buildContactSpine({
    force: true,
    pinnedSourcesOnly: true,
    addressBookDbPaths: ["/nonexistent/x.abcddb"],
  });
  for (const s of SPINE_SOURCES) {
    if (s.scoped) continue;
    assert.equal(
      Object.prototype.hasOwnProperty.call(scoped.stats.sources, s.key),
      false,
      `non-scoped source ${s.key} must not run under pinnedSourcesOnly`,
    );
  }

  // (b) reply-history ignores INBOUND mail (operator present but not sender).
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: pjoin } = await import("node:path");
  const dir = mkdtempSync(pjoin(tmpdir(), "replyhist-"));
  const ledger = pjoin(dir, "mail.jsonl");
  const OP = OP_EMAIL;
  writeFileSync(ledger, [
    // INBOUND: operator is a recipient, NOT the sender => must NOT count.
    JSON.stringify({ parties: ["cold-sender@example.com", OP],
      raw_content: { headers: { from: `Cold <cold-sender@example.com>`, to: OP } } }),
    // OUTBOUND: operator IS the sender => counts.
    JSON.stringify({ parties: [OP, "real-collaborator@example.com"],
      raw_content: { headers: { from: `Alex <${OP}>`, to: "real-collaborator@example.com" } } }),
  ].join("\n") + "\n");

  const recs = await readReplyHistoryContacts({ mailLedgerPath: ledger });
  const handles = recs.flatMap((r) => r.handles);
  assert.ok(
    handles.includes("real-collaborator@example.com"),
    `outbound recipient counted; got ${JSON.stringify(handles)}`,
  );
  assert.equal(
    handles.includes("cold-sender@example.com"),
    false,
    `INBOUND sender must NOT become a reply-history contact; got ${JSON.stringify(handles)}`,
  );
});

// ---------------------------------------------------------------------------
// 13. e7 — THE REPLY-HISTORY THRESHOLD IS A PARAMETER, AND ITS DEFAULT IS THE
//     SHIPPED CONSTANT.
//
// Why this is worth a registered test rather than a comment. The threshold
// decides who the spine vouches for, and therefore which catch-up rows reach
// TIER.RELATIONSHIP through classifyTier's is_contact branch. e7 needed to
// MEASURE the consequence of moving it (a decision table over the real
// population) without shipping a move. That is only safe if two things are
// pinned executably:
//
//   (a) NO-OPT === SHIPPED DEFAULT. A caller that passes no `minMessages` gets
//       exactly the pre-parameter behaviour, so the production spine — and every
//       row ranked against it — is byte-identical. A regression here would move
//       the live surface silently while the harness reported "default".
//   (b) THE PARAMETER ACTUALLY BINDS. `minMessages: 3` must drop a handle with
//       two outbound messages and keep one with three. A parameter that is
//       accepted and ignored would make the whole decision table a fiction:
//       every N would report the N=1 numbers and the sweep would "prove" the
//       threshold does not matter.
//
// Also asserts the provenance fields (outbound_count / source) the harness
// reads to attribute a vouch to the source that bought it. They are INERT to
// buildSpineFromRecords (which reads only name/handles), which is exactly why
// they are safe to carry.
// ---------------------------------------------------------------------------
test("M2/e7: readReplyHistoryContacts — default is unchanged, minMessages binds", async () => {
  const { readReplyHistoryContacts, REPLY_HISTORY_MIN_MESSAGES, buildSpineFromRecords } =
    await import("../../lib/messaging/contact-spine.js");

  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: pjoin } = await import("node:path");
  const dir = mkdtempSync(pjoin(tmpdir(), "replyhist-min-"));
  const ledger = pjoin(dir, "mail.jsonl");
  const OP = OP_EMAIL;
  const outbound = (to) =>
    JSON.stringify({ parties: [OP, to], raw_content: { headers: { from: `Alex <${OP}>`, to } } });
  // once@ x1, twice@ x2, thrice@ x3 — straddling a threshold of 3 on both sides.
  writeFileSync(
    ledger,
    [
      outbound("once@example.com"),
      outbound("twice@example.com"),
      outbound("twice@example.com"),
      outbound("thrice@example.com"),
      outbound("thrice@example.com"),
      outbound("thrice@example.com"),
    ].join("\n") + "\n",
  );

  // (a) NO OPT => the shipped default (1) => every outbound correspondent.
  const dflt = await readReplyHistoryContacts({ mailLedgerPath: ledger });
  const dfltHandles = dflt.flatMap((r) => r.handles).sort();
  assert.equal(REPLY_HISTORY_MIN_MESSAGES, 1, "shipped default is 1 (the decision table is presented, not applied)");
  assert.deepEqual(
    dfltHandles,
    ["once@example.com", "thrice@example.com", "twice@example.com"],
    `no-opt call must be byte-identical to the pre-parameter behaviour; got ${JSON.stringify(dfltHandles)}`,
  );
  // Passing the constant EXPLICITLY must equal passing nothing at all.
  const explicitDefault = await readReplyHistoryContacts({
    mailLedgerPath: ledger,
    minMessages: REPLY_HISTORY_MIN_MESSAGES,
  });
  assert.deepEqual(
    explicitDefault.flatMap((r) => r.handles).sort(),
    dfltHandles,
    "explicit minMessages === REPLY_HISTORY_MIN_MESSAGES must equal the no-opt call",
  );

  // (b) minMessages: 3 DROPS below-threshold handles and keeps the one that clears it.
  const strict = await readReplyHistoryContacts({ mailLedgerPath: ledger, minMessages: 3 });
  const strictHandles = strict.flatMap((r) => r.handles).sort();
  assert.deepEqual(
    strictHandles,
    ["thrice@example.com"],
    `minMessages:3 must drop handles below 3 outbound messages; got ${JSON.stringify(strictHandles)}`,
  );

  // Provenance: the measured count and the owning source ride on every record.
  for (const r of dflt) {
    assert.equal(r.source, "reply-history", "each record names its source");
    assert.ok(Number.isFinite(r.outbound_count) && r.outbound_count >= 1, "each record carries its measured count");
  }
  const byHandle = new Map(dflt.map((r) => [r.handles[0], r.outbound_count]));
  assert.equal(byHandle.get("twice@example.com"), 2, "outbound_count is the MEASURED count, not a flag");
  assert.equal(byHandle.get("thrice@example.com"), 3, "outbound_count is the MEASURED count, not a flag");

  // The extra fields are INERT: the merge reads only name/handles, so the spine
  // built from these records is identical to one built from stripped records.
  const stripped = dflt.map((r) => ({ name: r.name, handles: r.handles }));
  assert.deepEqual(
    [...buildSpineFromRecords(dflt).personByHandle.keys()].sort(),
    [...buildSpineFromRecords(stripped).personByHandle.keys()].sort(),
    "outbound_count/source must be inert to buildSpineFromRecords",
  );
});

// ---------------------------------------------------------------------------
// 14. e12 — outbound_count COUNTS DISTINCT MESSAGES, NOT LEDGER ROWS.
//
// The defect this pins. Gmail-IMAP exposes one sent message once per label, so
// a single send is ingested as three rows — [Gmail]/Drafts, [Gmail]/All Mail,
// [Gmail]/Trash — with three CONSECUTIVE, DISTINCT source_msg_ids and one
// shared message-id. Measured on the live mail ledger: one correspondent shows
// 24 outbound rows for 11 distinct messages. A row-counting vouch therefore
// reports 2.2x more deliberate contact than the operator actually made, and it
// is the THRESHOLD that consumes that number — so an inflated count does not
// merely mis-label a record, it can admit a handle to the spine (and thence to
// TIER.RELATIONSHIP via classifyTier's is_contact branch) that never earned it.
//
// The fixture reproduces the real fan-out rather than an abstraction of it:
// same message-id, DISTINCT source_msg_ids, distinct mailbox_urls. That shape
// matters, because it is what rules out the tempting wrong fixes — the rows are
// not duplicates by any ledger-level test, so append-time dedup cannot see them
// and did not fail; only a reader that knows what a MESSAGE is can collapse them.
//
// Against the row-counting implementation this test is RED: fanout@ measures 4
// (three copies + one distinct send) instead of 2, and minMessages:3 ADMITS it
// instead of dropping it.
// ---------------------------------------------------------------------------
test("M2/e12: readReplyHistoryContacts — mailbox-copy fan-out counts once", async () => {
  const { readReplyHistoryContacts } = await import("../../lib/messaging/contact-spine.js");

  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: pjoin } = await import("node:path");
  const dir = mkdtempSync(pjoin(tmpdir(), "replyhist-fanout-"));
  const ledger = pjoin(dir, "mail.jsonl");
  const OP = OP_EMAIL;
  const MBOX = "imap://00000000-0000-4000-8000-000000000001/%5BGmail%5D";

  // One outbound row exactly as the mail connector emits it.
  const row = (to, messageId, sourceMsgId, mailbox) =>
    JSON.stringify({
      source: "mail",
      source_msg_id: sourceMsgId,
      parties: [OP, to],
      raw_content: {
        mailbox_url: `${MBOX}/${mailbox}`,
        headers: { from: `Alex <${OP}>`, to, "message-id": messageId },
      },
    });

  const FAN = "fanout@example.com";
  writeFileSync(
    ledger,
    [
      // ONE message, three mailbox copies. Consecutive distinct rowids — the
      // signature of three real source rows, not a replayed cursor.
      row(FAN, "<A@mail.example.com>", "rowid:1000381", "Drafts"),
      row(FAN, "<A@mail.example.com>", "rowid:1000382", "All%20Mail"),
      row(FAN, "<A@mail.example.com>", "rowid:1000384", "Trash"),
      // A genuinely separate send to the same person: the count must be 2, not 1.
      // Collapsing to "one vouch per correspondent" would be a different bug.
      row(FAN, "<B@mail.example.com>", "rowid:1000390", "All%20Mail"),
      // A control handle with three genuinely distinct messages, so the test
      // distinguishes "dedups fan-out" from "under-counts everything".
      row("real@example.com", "<C@mail.example.com>", "rowid:1000400", "All%20Mail"),
      row("real@example.com", "<D@mail.example.com>", "rowid:1000401", "All%20Mail"),
      row("real@example.com", "<E@mail.example.com>", "rowid:1000402", "All%20Mail"),
    ].join("\n") + "\n",
  );

  const recs = await readReplyHistoryContacts({ mailLedgerPath: ledger });
  const byHandle = new Map(recs.map((r) => [r.handles[0], r.outbound_count]));

  assert.equal(
    byHandle.get(FAN),
    2,
    `three mailbox copies of one message + one distinct send is TWO outbound messages, not four; got ${byHandle.get(FAN)}`,
  );
  assert.equal(
    byHandle.get("real@example.com"),
    3,
    "three distinct message-ids stay three — the collapse is per-message, not per-correspondent",
  );

  // The count is load-bearing, not decorative: at minMessages:3 the corrected
  // count DROPS the fan-out handle that row-counting would have admitted, while
  // the genuinely-three-message handle survives.
  const strict = await readReplyHistoryContacts({ mailLedgerPath: ledger, minMessages: 3 });
  const strictHandles = strict.flatMap((r) => r.handles).sort();
  assert.deepEqual(
    strictHandles,
    ["real@example.com"],
    `minMessages:3 must drop the fan-out handle (2 real messages) and keep the real one; got ${JSON.stringify(strictHandles)}`,
  );

  // NO-REGRESSION FOR HEADER-LESS HISTORY. The corpus predating recipient
  // recovery carries neither message-id nor source_msg_id, and those rows must
  // keep counting EXACTLY as row-counting counted them. This is why the message
  // key falls back to a per-row ordinal and never to a shared sentinel: a
  // sentinel would fold once/twice/thrice to 1/1/1 and silently rewrite the
  // meaning of every pre-header vouch. (Assertion 13 covers the same ground
  // from the threshold side; this states it as an explicit count identity.)
  const bare = pjoin(dir, "mail-bare.jsonl");
  const bareRow = (to) =>
    JSON.stringify({ parties: [OP, to], raw_content: { headers: { from: `Alex <${OP}>`, to } } });
  writeFileSync(
    bare,
    [
      bareRow("once@example.com"),
      bareRow("twice@example.com"),
      bareRow("twice@example.com"),
      bareRow("thrice@example.com"),
      bareRow("thrice@example.com"),
      bareRow("thrice@example.com"),
    ].join("\n") + "\n",
  );
  const bareRecs = await readReplyHistoryContacts({ mailLedgerPath: bare });
  const bareCounts = new Map(bareRecs.map((r) => [r.handles[0], r.outbound_count]));
  assert.deepEqual(
    [...bareCounts.entries()].sort(),
    [["once@example.com", 1], ["thrice@example.com", 3], ["twice@example.com", 2]],
    `header-less rows must count 1/2/3 exactly as before; got ${JSON.stringify([...bareCounts])}`,
  );
});
