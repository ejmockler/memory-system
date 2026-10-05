// n11f-imessage-floor-diversity.test.mjs — WORKUNIT N11f gate.
//
// THREE deliverables, ESM, defensive, node:test + node:assert/strict, >=12 tests.
// Hermetic: NO chat.db, NO AddressBook, NO network, NO fs writes. Reads only
// in-memory rows + the L1 adapter + the L5 surface + the L2-5 sources (grep gate).
//
//   (1) iMessage DISPLAY FLOOR: when no contact name resolves for an inbound
//       handle, sender.name is a FORMATTED handle (readable number for a phone
//       handle; the email for an email handle; a short label for urn:biz /
//       shortcode) — NEVER null, NEVER person:<hash> — for a handle-bearing inbound
//       row. A real contact name (stamped recovered_handle_name, or a ctx contact
//       map) still WINS. The floor is OPT-OUT via handleNameFloor:false.
//
//   (2) GENERIC per-platform DIVERSITY CAP on the catch-up rank/output: a CAPS-
//       gated interleave (default <=6 per platform per pass) re-orders the ranked
//       rows so the visible window spans platforms instead of being saturated by
//       the dominant one — ZERO platform-name branch (groups by the row's own
//       `platform` DATA field).
//
//   (3) The previously-RED N4 grep test is GREEN (the adapter imports nothing from
//       connectors/* and names no source surface) + 0 platform tokens in L2-5.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  toEnvelope as imToEnvelope,
  _toEnvelope as imToEnvelopeAlias,
  formatHandleFloor,
  prepareContext as imPrepareContext,
  __resetPrepareContextMemo,
  PLATFORM as IM_PLATFORM,
} from "../../lib/messaging/adapters/imessage.js";
import { validateEnvelope } from "../../lib/messaging/envelope.js";
import { buildCatchupCore } from "../../lib/messaging/catchup.js";
import { grepPlatformTokens, L2to5_SOURCES } from "../../lib/messaging/n10-invariant-eval.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_SRC = path.resolve(__dirname, "../../lib/messaging/adapters/imessage.js");

// A synthetic INBOUND iMessage ledger row with a NULL stamped name (live default).
function imInboundRow(handle, { stampedName = null, text = "hey are we still on?", smid } = {}) {
  return {
    ts: "2026-06-20T12:00:00.000Z",
    source_msg_id: smid || `im-${handle}`,
    parties: [handle, "user"],
    raw_content: {
      text,
      handle_id: handle,
      chat_guid: `iMessage;-;${handle}`,
      cache_roomnames: null,
      is_from_me: 0,
      thread_originator_guid: null,
      participant_count: 2,
      recovered_handle_name: stampedName,
    },
  };
}

// A plain inbound DM envelope on an arbitrary platform slug (DATA), addressed to
// me so it surfaces at the catch-up. `ageMin` controls recency/staleness ranking.
function dmEnvelope({ platform, sender_id, name, ageMin = 60, smid, content = "can you confirm tomorrow?" }, now) {
  return {
    platform,
    thread_id: `${platform}:thread:${sender_id}`,
    thread_type: "dm",
    sender: { id: sender_id, name, kind: "person" },
    recipients: ["user"],
    is_from_me: false,
    ts: now - ageMin * 60 * 1000,
    content,
    reply_to_id: null,
    mentions: [],
    directed_at_me_signals: { mention_me: false, reply_to_me: false, addressed_to_me: true },
    capabilities: {
      reply_to_available: true,
      structured_mentions: false,
      self_identity_reliable: true,
      addressing_first_class: false,
    },
    source_msg_id: smid || `${platform}:${sender_id}`,
  };
}

// ===========================================================================
// (1) — the iMessage DISPLAY FLOOR.
// ===========================================================================

test("N11f-1: formatHandleFloor formats an E.164 NANP phone into a readable number", () => {
  assert.equal(formatHandleFloor("+15555550123"), "+1 555 555 0123");
  assert.equal(formatHandleFloor("+15555550125"), "+1 555 555 0125");
});

test("N11f-2: formatHandleFloor handles a bare 10-digit phone + non-canonical formats", () => {
  assert.equal(formatHandleFloor("5555550123"), "(555) 555-0123");
  // Stored with separators still collapses to the same digits -> readable form.
  assert.equal(formatHandleFloor("(555) 555-0123"), "(555) 555-0123");
});

test("N11f-3: formatHandleFloor returns the email as-is for an email handle", () => {
  assert.equal(formatHandleFloor("friend@example.com"), "friend@example.com");
  assert.equal(formatHandleFloor("a.b+tag@host.co.uk"), "a.b+tag@host.co.uk");
});

test("N11f-4: formatHandleFloor returns a short label for a shortcode / urn:biz handle", () => {
  // An SMS shortcode (fewer than 10 digits) is shown as the raw short label.
  assert.equal(formatHandleFloor("55501"), "55501");
  // A business urn handle is shown as-is (a short, stable label, never a hash).
  assert.equal(formatHandleFloor("urn:biz:acme"), "urn:biz:acme");
});

test("N11f-5: formatHandleFloor returns null ONLY for an absent/empty handle", () => {
  assert.equal(formatHandleFloor(null), null);
  assert.equal(formatHandleFloor(""), null);
  assert.equal(formatHandleFloor(undefined), null);
});

test("N11f-6: inbound w/o contact -> sender.name is the FORMATTED number (never null/hash)", () => {
  const env = imToEnvelope(imInboundRow("+15105551212"));
  assert.equal(env.sender.name, "+1 510 555 1212", "floored to a readable number");
  assert.notEqual(env.sender.name, null, "never null for a handle-bearing inbound row");
  assert.ok(!String(env.sender.name).startsWith("person:"), "never a person:<hash>");
  assert.equal(env.sender.id, "+15105551212", "sender.id stays the raw handle (join key)");
  assert.equal(validateEnvelope(env).ok, true, "the floored envelope validates against N1");
});

test("N11f-7: inbound EMAIL handle w/o contact -> sender.name is the email; shortcode -> the code", () => {
  const email = imToEnvelope(imInboundRow("buddy@example.com"));
  assert.equal(email.sender.name, "buddy@example.com");
  const shortcode = imToEnvelope(imInboundRow("55501"));
  assert.equal(shortcode.sender.name, "55501");
  for (const e of [email, shortcode]) assert.equal(validateEnvelope(e).ok, true);
});

test("N11f-8: a REAL contact name (stamped recovered_handle_name) WINS over the floor", () => {
  const env = imToEnvelope(imInboundRow("+15105551212", { stampedName: "Dana Reyes" }));
  assert.equal(env.sender.name, "Dana Reyes", "the stamped contact name beats the number floor");
  assert.notEqual(env.sender.name, "+1 510 555 1212", "the floor did not override a real name");
});

test("N11f-9: a ctx contact map WINS over the floor; the floor only fills a genuine null", () => {
  // A pure in-memory contactMaps ctx (no DB) — the phone normalizes to last-10.
  const contactMaps = {
    phoneToName: new Map([["5105551212", "Sam Park"]]),
    emailToName: new Map(),
  };
  const env = imToEnvelope(imInboundRow("+15105551212"), { contactMaps });
  assert.equal(env.sender.name, "Sam Park", "the ctx contact name beats the floor");
  // A different handle the map does NOT know falls to the floor (never null).
  const unknown = imToEnvelope(imInboundRow("+14045550000"), { contactMaps });
  assert.equal(unknown.sender.name, "+1 404 555 0000", "unknown handle -> the number floor");
});

test("N11f-10: the floor is OPT-OUT via handleNameFloor:false (the genuine-resolution metric)", () => {
  const floored = imToEnvelope(imInboundRow("+15105551212"));
  const raw = imToEnvelope(imInboundRow("+15105551212"), { handleNameFloor: false });
  assert.equal(floored.sender.name, "+1 510 555 1212", "floor ON (default) shows the number");
  assert.equal(raw.sender.name, null, "floor OFF reads the unmasked genuine null");
});

test("N11f-11: outbound rows are NEVER floored — sender stays the operator self", () => {
  const outbound = {
    ...imInboundRow("+15105551212"),
    parties: ["user", "+15105551212"],
    raw_content: { ...imInboundRow("+15105551212").raw_content, is_from_me: 1 },
  };
  const env = imToEnvelope(outbound);
  assert.equal(env.is_from_me, true);
  assert.equal(env.sender.id, "user");
  assert.equal(env.sender.name, "user", "outbound self is never replaced by a floor");
});

test("N11f-12: a genuinely HANDLE-LESS inbound row stays null (person:<hash> legitimately applies)", () => {
  // No handle_id at all -> the floor has nothing to format -> null (the only null case).
  const row = imInboundRow("+15105551212");
  row.raw_content.handle_id = null;
  const env = imToEnvelope(row);
  assert.equal(env.sender.id, null, "no handle");
  assert.equal(env.sender.name, null, "no handle -> floor is a no-op -> null (downstream hash is correct here)");
});

// ===========================================================================
// (2) — the GENERIC per-platform diversity cap on the catch-up output.
// ===========================================================================

test("N11f-13: diversity cap surfaces multiple platforms when one dominates the ledger", () => {
  const now = Date.parse("2026-06-20T18:00:00.000Z");
  // 10 iMessage threads + 1 telegram + 1 whatsapp. The interleave must pull the
  // minority platforms into a small window whichever way the score orders them.
  //
  // e17 INVERTED WHICH ROWS DOMINATE, and the comment that stood here said the
  // opposite of the truth: it read "older => more stale => higher score", which was
  // the band-pass talking (rankScore multiplied recency by staleness). The time
  // term is now recencyFactor alone, so FRESHER ranks higher and the 10 old
  // iMessage rows are the ones a pure sort buries. This case does not depend on the
  // direction — it asserts the cap surfaces >=3 platforms in a 3-row window — so
  // only the reasoning is corrected. N11f-14 and N11f-17, which DO depend on which
  // platform saturates, have their fixtures re-derived rather than their prose.
  const envelopes = [];
  for (let i = 0; i < 10; i++) {
    envelopes.push(dmEnvelope({ platform: "imessage", sender_id: `+1909000${1000 + i}`, name: `+1 909 000 ${1000 + i}`, ageMin: 2000 + i, smid: `im${i}` }, now));
  }
  envelopes.push(dmEnvelope({ platform: "telegram", sender_id: "tg:55501", name: "Ada Lovelace", ageMin: 30, smid: "tg1" }, now));
  envelopes.push(dmEnvelope({ platform: "whatsapp", sender_id: "wa:99901", name: "Bo Diddley", ageMin: 20, smid: "wa1" }, now));

  // A small visible window (limit 3) is exactly where saturation hides minorities.
  const res = buildCatchupCore({ envelopes, now, opts: { min_score: 0.3, limit: 3, max_per_platform: 1 } });
  const platforms = new Set(res.rows.map((r) => r.platform));
  assert.equal(res.rows.length, 3, "limit honored");
  assert.ok(platforms.size >= 3, `expected >=3 platforms in the top-3 window, got ${[...platforms]}`);
  assert.ok(platforms.has("telegram") && platforms.has("whatsapp"), "minority platforms surface despite imessage dominance");
});

test("N11f-14: pure-rank (max_per_platform:false) lets the dominant platform saturate — the cap is load-bearing", () => {
  const now = Date.parse("2026-06-20T18:00:00.000Z");
  // e17 — THE FIXTURE IS RE-DERIVED, NOT THE ASSERTION. The property under test is
  // "a pure rank can saturate the window with one platform, so the cap is
  // load-bearing", and it needs a DOMINANT platform to exist. Before e17 dominance
  // meant OLDEST (the deleted staleness factor); the time term is now recencyFactor
  // alone, so dominance means FRESHEST. The iMessage rows are therefore the fresh
  // ones here and the telegram row is the old one — the same shape, the same
  // assertion, the ages swapped to keep the shape true.
  const envelopes = [];
  for (let i = 0; i < 10; i++) {
    envelopes.push(dmEnvelope({ platform: "imessage", sender_id: `+1909000${1000 + i}`, name: `+1 909 000 ${1000 + i}`, ageMin: 5 + i, smid: `im${i}` }, now));
  }
  envelopes.push(dmEnvelope({ platform: "telegram", sender_id: "tg:55501", name: "Ada Lovelace", ageMin: 2000, smid: "tg1" }, now));

  // With the interleave OFF the higher-ranked iMessage rows fill the whole window.
  const off = buildCatchupCore({ envelopes, now, opts: { min_score: 0.3, limit: 3, max_per_platform: false } });
  const offPlatforms = new Set(off.rows.map((r) => r.platform));
  assert.equal(offPlatforms.size, 1, "pure rank saturates the window with one platform");
  assert.equal([...offPlatforms][0], "imessage", "the dominant platform is the one that saturates");
  // With the interleave ON the minority platform is pulled into the window.
  const on = buildCatchupCore({ envelopes, now, opts: { min_score: 0.3, limit: 3, max_per_platform: 1 } });
  assert.ok(new Set(on.rows.map((r) => r.platform)).has("telegram"), "the cap pulls the minority platform in");
});

test("N11f-15: the interleave is a PERMUTATION — no row dropped/added, rank preserved WITHIN a platform", () => {
  const now = Date.parse("2026-06-20T18:00:00.000Z");
  // e17 — the rank is recency × directedness × reciprocity × anchor. The time term
  // is recencyFactor alone, so the NEWEST of two threads ranks higher and within a
  // platform the NEWEST thread leads. (Before e17 the deleted staleness factor
  // inverted this for ages under a couple of days, and the expectation below read
  // C,B,A.) We assert the weave preserves THAT order within a platform.
  const envelopes = [
    dmEnvelope({ platform: "imessage", sender_id: "+19090001000", name: "+1 909 000 1000", ageMin: 10, smid: "imA" }, now),
    dmEnvelope({ platform: "imessage", sender_id: "+19090001001", name: "+1 909 000 1001", ageMin: 20, smid: "imB" }, now),
    dmEnvelope({ platform: "imessage", sender_id: "+19090001002", name: "+1 909 000 1002", ageMin: 30, smid: "imC" }, now),
    dmEnvelope({ platform: "telegram", sender_id: "tg:1", name: "Ada", ageMin: 40, smid: "tg1" }, now),
    dmEnvelope({ platform: "telegram", sender_id: "tg:2", name: "Bo", ageMin: 50, smid: "tg2" }, now),
  ];
  const baseline = buildCatchupCore({ envelopes, now, opts: { min_score: 0.3, limit: 100, max_per_platform: false } });
  const res = buildCatchupCore({ envelopes, now, opts: { min_score: 0.3, limit: 100, max_per_platform: 1 } });
  assert.equal(res.rows.length, baseline.rows.length, "no row dropped or added (permutation)");
  assert.equal(res.rows.length, 5, "all five threads surface");
  // The set of thread_ids is identical (permutation, not a filter).
  assert.deepEqual(
    new Set(res.rows.map((r) => r.thread_id)),
    new Set(baseline.rows.map((r) => r.thread_id)),
    "interleave is a permutation of the ranked set",
  );
  // Within iMessage the rank order (newest-first, by recency) is preserved: A,B,C.
  const imOrder = res.rows.filter((r) => r.platform === "imessage").map((r) => r.thread_id);
  assert.deepEqual(
    imOrder,
    ["imessage:thread:+19090001000", "imessage:thread:+19090001001", "imessage:thread:+19090001002"],
    "rank order preserved within the platform",
  );
  // Strict round-robin (perRound=1): the first two rows are different platforms.
  assert.notEqual(res.rows[0].platform, res.rows[1].platform, "weave alternates platforms at the top");
});

test("N11f-16: single-platform corpus -> interleave is a NO-OP (pure rank order preserved)", () => {
  const now = Date.parse("2026-06-20T18:00:00.000Z");
  const envelopes = [
    dmEnvelope({ platform: "imessage", sender_id: "+19090001000", name: "+1 909 000 1000", ageMin: 10, smid: "imA" }, now),
    dmEnvelope({ platform: "imessage", sender_id: "+19090001001", name: "+1 909 000 1001", ageMin: 20, smid: "imB" }, now),
    dmEnvelope({ platform: "imessage", sender_id: "+19090001002", name: "+1 909 000 1002", ageMin: 30, smid: "imC" }, now),
  ];
  const withCap = buildCatchupCore({ envelopes, now, opts: { min_score: 0.3, limit: 100 } });
  const pureRank = buildCatchupCore({ envelopes, now, opts: { min_score: 0.3, limit: 100, max_per_platform: false } });
  // One platform => the interleave must not reorder vs pure rank.
  assert.deepEqual(
    withCap.rows.map((r) => r.thread_id),
    pureRank.rows.map((r) => r.thread_id),
    "single-platform: interleave does not change the order",
  );
  // And the rows are non-increasing in score (the single-platform monotone gate).
  for (let i = 1; i < withCap.rows.length; i++) {
    assert.ok(withCap.rows[i - 1].score >= withCap.rows[i].score, "single-platform rows stay non-increasing");
  }
});

test("N11f-17: the diversity cap default is ON (a multi-platform corpus weaves without an explicit opt)", () => {
  const now = Date.parse("2026-06-20T18:00:00.000Z");
  const envelopes = [];
  // e17 — SAME RE-DERIVATION AS N11f-14: dominance is now FRESHNESS, so the
  // iMessage rows are the fresh ones and the minority mail row is the old one. The
  // assertion (the default cap surfaces the minority; pure rank buries it) is
  // unchanged.
  for (let i = 0; i < 8; i++) {
    envelopes.push(dmEnvelope({ platform: "imessage", sender_id: `+1909000${1000 + i}`, name: `n${i}`, ageMin: 5 + i, smid: `im${i}` }, now));
  }
  envelopes.push(dmEnvelope({ platform: "mail", sender_id: "boss@co.com", name: "boss@co.com", ageMin: 2000, smid: "mail1" }, now));
  // NO max_per_platform passed -> default (6) interleave. The mail row (oldest, so
  // lowest pure rank) must still appear in the window because the weave yields a
  // round-robin turn to it after the per-platform run cap.
  const res = buildCatchupCore({ envelopes, now, opts: { min_score: 0.3, limit: 8 } });
  const platforms = new Set(res.rows.map((r) => r.platform));
  assert.ok(platforms.has("mail"), "default interleave (cap ON) surfaces the minority mail thread in the window");
  // Control: with pure rank (cap off) the 8 dominant iMessage rows fill the window.
  const pure = buildCatchupCore({ envelopes, now, opts: { min_score: 0.3, limit: 8, max_per_platform: false } });
  assert.ok(!new Set(pure.rows.map((r) => r.platform)).has("mail"), "pure rank buries the fresh minority below the window");
});

// ===========================================================================
// (3) — the previously-RED N4 grep gate is GREEN + 0 platform tokens in L2-5.
// ===========================================================================

test("N11f-18: the adapter imports NOTHING from connectors/* (the previously-red N4 invariant)", () => {
  const src = readFileSync(ADAPTER_SRC, "utf8");
  assert.equal(
    /from\s+["'][^"']*connectors\//.test(src),
    false,
    "adapter must not import from the frozen connector layer",
  );
});

test("N11f-19: the adapter NAMES no source surface (Contacts/AddressBook/chat.db/sqlite) in its code", () => {
  const src = readFileSync(ADAPTER_SRC, "utf8");
  // Strip line comments (the N4 gate's own discipline) — the pure mapper must not
  // re-query any source; the AddressBook read lives in the _imessage-context sibling.
  const noLineComments = src.replace(/^\s*\/\/.*$/gm, "");
  assert.equal(
    /_imessage-name-recovery|AddressBook|Contacts\b|chat\.db|sqlite/i.test(noLineComments),
    false,
    "adapter must name no source surface (read-only over the row)",
  );
});

test("N11f-20: L2-5 (classifier/identity/attention/catchup) carry ZERO platform tokens", () => {
  const { count, matches } = grepPlatformTokens();
  assert.equal(count, 0, `expected 0 platform tokens in L2-5, got ${count}: ${JSON.stringify(matches.slice(0, 5))}`);
  // Five since f5-catchup-seam registered lib/messaging/ledger-retain.js (the
  // retain leaf carved out of catchup.js to break the catchup <-> projection
  // import cycle) — the gate WIDENED with the move, it did not shrink.
  assert.equal(L2to5_SOURCES.length, 5, "the gate scans exactly the five L2-5 sources");
});

test("N11f-21: the _toEnvelope alias is the toEnvelope impl (registry dispatch key) + PLATFORM is DATA", () => {
  assert.equal(imToEnvelopeAlias, imToEnvelope, "_toEnvelope is the toEnvelope alias");
  assert.equal(IM_PLATFORM, "imessage", "the adapter declares its own platform as DATA");
  // prepareContext is re-exported from the context sibling (registry capability).
  assert.equal(typeof imPrepareContext, "function", "prepareContext is exported (registry reads it as a capability)");
  assert.equal(typeof __resetPrepareContextMemo, "function", "the memo reset is re-exported for tests");
});
