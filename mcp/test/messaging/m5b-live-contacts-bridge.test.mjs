// m5b-live-contacts-bridge.test.mjs — WORKUNIT M5b gate: the LIVE contacts-bridge.
//
// M5 shipped the composite enrichPerson (M2 contacts + M3 feedback + P2r) and the
// honest tier. M5b LOCKS the seam the M5-review regression exposed: in the LIVE
// buildCatchup path the person_id->handles BRIDGE (buildHandlesByPerson) must be
// built over the loaded envelopes and threaded into the M2 contacts-anchor lookup,
// so the EXACT opaque key the rank loop computes for a candidate (the resolved N7
// person_id, else the soft `${platform}:${sender_id}` fallback) resolves back to
// the sender HANDLES it collapsed — which the contact index then joins to the
// saved address book. Without that bridge, isContact() sees no handles, every row
// degrades to is_contact=false / anchor_factor=1.0, and tiering collapses to
// reciprocity-only: a chatty BUSINESS out-ranks a saved human. That is the bug.
//
// What this proves (mapped to the M5b WORKUNIT + the HARD CONSTRAINTS):
//   - buildHandlesByPerson keys the sender handle under BOTH the soft dedup key
//     AND the resolved person_id, so whichever key the rank loop computes hits it.
//   - the bridge ONLY indexes inbound senders (is_from_me=true contributes nothing).
//   - END-TO-END through buildCatchup({ anchor }) (the live composition, NOT a hand-
//     built contactIndex): a saved CONTACT anchors (anchor_factor>1) and lands in
//     RELATIONSHIP, while a reciprocity-only BUSINESS (high two-way turns, NOT
//     saved) stays UNKNOWN — and the contact out-ranks the business.
//   - the live bridge resolves the SOFT fallback key (no resolver) too.
//   - a genuine NEW contact still SURVIVES in unknown (never hard-dropped).
//   - the bridge is BENIGN when no contact index is wired: byte-identical neutral.
//   - SOFT: malformed envelopes / a throwing resolver contribute nothing, no throw.
//   - the bridge carries the saved handle even when the sender's display NAME would
//     not join (the join is on the HANDLE, the operator's vouch — not the name).
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions. Hermetic: NO
// network, NO live DB, NO fs writes (contacts INJECTED via contactMaps + noMemo).

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCatchup,
  buildAdapterRegistry,
  loadEnvelopesFromSources,
  buildHandlesByPerson,
  makeWhoMattersEnricher,
} from "../../lib/messaging/catchup.js";

import { TIER, anchorFactor } from "../../lib/messaging/person-enrichment.js";
import { buildPersonIndex, lookup as personLookup } from "../../lib/messaging/identity.js";

// ---------------------------------------------------------------------------
// Fixtures — minimal N1 envelopes; DM threads (structurally directed). Pinned now.
// ---------------------------------------------------------------------------
const NOW = 1700010000000;
let _mid = 0;
function env({ thread_id, platform = "source_a", is_from_me = false, content = "hi", ts, sender_id, sender_name = null }) {
  _mid += 1;
  return {
    platform,
    thread_id,
    thread_type: "dm",
    sender: { id: is_from_me ? "user" : (sender_id || `peer_${thread_id}`), name: is_from_me ? null : sender_name, kind: "person" },
    recipients: ["user"],
    is_from_me,
    ts: typeof ts === "number" ? ts : NOW - 60 * 60 * 1000 + _mid * 1000,
    content,
    mentions: [],
    directed_at_me_signals: { mention_me: false, reply_to_me: false, addressed_to_me: false },
    capabilities: { reply_to_available: true, structured_mentions: true, self_identity_reliable: true, addressing_first_class: false },
    source_msg_id: `${platform}:${thread_id}:${_mid}`,
  };
}

function fixtureRegistry(platforms) {
  return buildAdapterRegistry(platforms.map((p) => ({ PLATFORM: p, _toEnvelope: (row) => row })));
}

// The handles. The CONTACT phone is saved; the BUSINESS and STRANGER are not.
const CONTACT_PHONE = "+15551112222"; // saved -> "Mom"
const BUSINESS_PHONE = "+15553334444"; // NOT saved (a chatty service)
const STRANGER_PHONE = "+15559998888"; // NOT saved (a genuine new contact)

// A contact-maps fixture: ONLY the contact phone resolves to a saved name. The
// business / stranger are absent (a miss -> is_contact=false -> neutral).
function contactMaps() {
  return {
    phoneToName: new Map([["5551112222", "Mom"]]),
    emailToName: new Map(),
  };
}

// The headline M5b scenario (the QUICKTAXISERVICE-vs-real-human regression in the
// small): a saved CONTACT with ZERO reciprocity (a single first-contact inbound),
// vs a NOT-saved BUSINESS the operator has gone back-and-forth with many times
// (high reciprocity). Reciprocity ALONE would float the business above the human;
// the contact ANCHOR must invert that.
function contactVsBusinessSources() {
  const business = [];
  // Build a long two-way history with the business: alternating inbound/outbound.
  for (let i = 0; i < 6; i++) {
    business.push(env({ thread_id: "dm_biz", sender_id: BUSINESS_PHONE, sender_name: "QUICKTAXISERVICE", is_from_me: false, content: `your driver is ${i} minutes away`, ts: NOW - (20 - i) * 60000 }));
    business.push(env({ thread_id: "dm_biz", sender_id: "user", is_from_me: true, content: "thanks, ok", ts: NOW - (20 - i) * 60000 + 30000 }));
  }
  // The business spoke LAST (unanswered), substantively.
  business.push(env({ thread_id: "dm_biz", sender_id: BUSINESS_PHONE, sender_name: "QUICKTAXISERVICE", is_from_me: false, content: "can you confirm the pickup address for tomorrow?", ts: NOW - 2000 }));
  return {
    source_a: [
      // The saved contact: a SINGLE inbound first-contact (zero reciprocity).
      env({ thread_id: "dm_mom", sender_id: CONTACT_PHONE, sender_name: "Mom", is_from_me: false, content: "hey hon, can you call me when you get a sec?", ts: NOW - 1000 }),
      ...business,
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. buildHandlesByPerson — the BRIDGE the regression was missing in the live path.
// ---------------------------------------------------------------------------

test("M5b: buildHandlesByPerson keys the sender handle under BOTH the soft dedup key AND the resolved person_id", async () => {
  const sources = { source_a: [env({ thread_id: "dm_mom", sender_id: CONTACT_PHONE, sender_name: "Mom", is_from_me: false, content: "call me", ts: NOW - 1000 })] };
  const reg = fixtureRegistry(["source_a"]);
  const envelopes = await loadEnvelopesFromSources(sources, reg);
  const idx = buildPersonIndex(envelopes);
  const resolve = (p, s) => { try { return personLookup(idx, p, s); } catch { return null; } };
  const map = buildHandlesByPerson(envelopes, resolve);

  // The soft dedup key (the rank-loop fallback) carries the raw handle.
  const softKey = `source_a:${CONTACT_PHONE}`;
  assert.ok(map.has(softKey), "the soft dedup key is in the bridge");
  assert.ok(map.get(softKey).includes(CONTACT_PHONE), "the soft key resolves to the sender handle");

  // The resolved person_id ALSO points at the same handle (so whichever dedup key
  // the rank loop computes — resolved person_id OR soft fallback — hits the handle).
  const pid = resolve("source_a", CONTACT_PHONE);
  if (typeof pid === "string" && pid.length > 0) {
    assert.ok(map.has(pid), "the resolved person_id is in the bridge");
    assert.ok(map.get(pid).includes(CONTACT_PHONE), "the person_id resolves to the same handle");
  } else {
    // No cross-platform collapse here; the soft key is the rank-loop dedup key.
    assert.ok(true, "no resolver collapse — the soft key is the live dedup key");
  }
});

test("M5b: buildHandlesByPerson indexes ONLY inbound senders — the 'user' (outbound) id is never a handle", async () => {
  const sources = {
    source_a: [
      env({ thread_id: "dm_mom", sender_id: CONTACT_PHONE, is_from_me: false, content: "hi", ts: NOW - 2000 }),
      env({ thread_id: "dm_mom", sender_id: "user", is_from_me: true, content: "hey", ts: NOW - 1000 }),
    ],
  };
  const reg = fixtureRegistry(["source_a"]);
  const envelopes = await loadEnvelopesFromSources(sources, reg);
  const map = buildHandlesByPerson(envelopes, () => null);
  for (const [, handles] of map) {
    assert.ok(!handles.includes("user"), "the outbound 'user' id is never indexed as a contact handle");
  }
  assert.ok(map.has(`source_a:${CONTACT_PHONE}`), "the inbound sender handle IS indexed");
});

test("M5b: buildHandlesByPerson is SOFT over malformed input — odd envelopes / a throwing resolver contribute nothing, never throws", () => {
  const throwingResolver = () => { throw new Error("resolver boom"); };
  const map = buildHandlesByPerson(
    [
      null,
      42,
      {},
      { is_from_me: false, sender: null, platform: "source_a" },
      { is_from_me: false, sender: { id: 99 }, platform: "source_a" },
      { is_from_me: true, sender: { id: "+19999999999" }, platform: "source_a" }, // outbound, skipped
      { is_from_me: false, sender: { id: CONTACT_PHONE }, platform: "source_a" }, // the only valid one
    ],
    throwingResolver,
  );
  // The throwing resolver is swallowed; the one valid inbound still indexes its soft key.
  assert.ok(map.has(`source_a:${CONTACT_PHONE}`), "the lone valid inbound is indexed despite a throwing resolver");
  assert.ok(map.get(`source_a:${CONTACT_PHONE}`).includes(CONTACT_PHONE), "its handle is recovered");
  // A non-array input is tolerated (empty map, no throw).
  assert.equal(buildHandlesByPerson(null, () => null).size, 0, "a non-array envelope set => empty bridge");
});

// ---------------------------------------------------------------------------
// 2. THE HEADLINE GATE — end-to-end through buildCatchup({ anchor }) (the LIVE
//    composition): a saved CONTACT out-ranks a reciprocity-only BUSINESS.
// ---------------------------------------------------------------------------

test("M5b (GATE, end-to-end live path): a saved CONTACT anchors ABOVE a reciprocity-only BUSINESS — the bridge is wired in buildCatchup", async () => {
  const res = await buildCatchup({
    sources: contactVsBusinessSources(),
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0.3,
    // The LIVE composition: buildCatchup builds the handle bridge over the loaded
    // envelopes itself and reads the (injected) contacts — NO hand-built contactIndex,
    // NO pre-built handlesByPerson. This is the exact seam the regression broke.
    anchor: { contacts: { contactMaps: contactMaps(), noMemo: true } },
  });

  const mom = res.rows.find((r) => r.thread_id === "dm_mom");
  const biz = res.rows.find((r) => r.thread_id === "dm_biz");
  assert.ok(mom, "the saved contact surfaces");
  assert.ok(biz, "the business STILL surfaces (never hard-dropped)");

  // The bridge lifted the contact: is_contact=true, anchor_factor>1, relationship.
  assert.equal(mom.enrichment.is_contact, true, "the saved contact resolved is_contact=true via the bridge");
  assert.ok(mom.anchor_factor > 1, `the contact ANCHORED (anchor_factor=${mom.anchor_factor} > 1)`);
  assert.equal(mom.tier, TIER.RELATIONSHIP, "the saved contact => relationship tier");

  // The business is NOT saved -> no anchor, regardless of its reciprocity.
  assert.equal(biz.enrichment.is_contact, false, "the business is NOT a saved contact (is_contact=false)");

  // The INVERSION the regression failed: the human out-ranks the chatty business.
  const momIdx = res.rows.findIndex((r) => r.thread_id === "dm_mom");
  const bizIdx = res.rows.findIndex((r) => r.thread_id === "dm_biz");
  assert.ok(momIdx < bizIdx, `the saved contact (#${momIdx}) out-ranks the reciprocity-only business (#${bizIdx})`);
  assert.equal(mom.tier, TIER.RELATIONSHIP, "the contact's tier is the strongest tier");
});

// ---------------------------------------------------------------------------
// 3. The genuine NEW contact still SURVIVES in unknown (never hard-dropped).
// ---------------------------------------------------------------------------

test("M5b (end-to-end live path): a genuine NEW contact survives in the UNKNOWN tier — surfaced + labeled, NOT dropped", async () => {
  const sources = {
    source_a: [
      env({ thread_id: "dm_mom", sender_id: CONTACT_PHONE, sender_name: "Mom", is_from_me: false, content: "call me when you can?", ts: NOW - 2000 }),
      env({ thread_id: "dm_new", sender_id: STRANGER_PHONE, sender_name: "Sam", is_from_me: false, content: "hi — a mutual friend suggested I reach out about the project, can we chat?", ts: NOW - 1000 }),
    ],
  };
  const res = await buildCatchup({
    sources,
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0.3,
    anchor: { contacts: { contactMaps: contactMaps(), noMemo: true } },
  });
  const fresh = res.rows.find((r) => r.thread_id === "dm_new");
  assert.ok(fresh, "the genuine new contact is STILL surfaced (not hard-dropped)");
  assert.equal(fresh.tier, TIER.UNKNOWN, "an unsaved, zero-history sender => unknown tier");
  assert.equal(fresh.anchor_factor, 1, "the new contact stays at the neutral floor (no down-rank)");
  assert.equal(fresh.enrichment.is_contact, false, "the new contact is not (yet) a saved contact");
});

// ---------------------------------------------------------------------------
// 4. The bridge is BENIGN with no contacts wired (gate-OFF byte-identical).
// ---------------------------------------------------------------------------

test("M5b: the bridge is NEUTRAL when no contact index is wired — buildCatchup(anchor: empty contacts) leaves every row at the neutral floor", async () => {
  const res = await buildCatchup({
    sources: contactVsBusinessSources(),
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0.3,
    // An EMPTY contact set: the bridge still builds, but every isContact() misses.
    anchor: { contacts: { contactMaps: { phoneToName: new Map(), emailToName: new Map() }, noMemo: true } },
  });
  for (const r of res.rows) {
    assert.equal(r.enrichment.is_contact, false, "no saved contacts => every row is_contact=false");
    assert.equal(r.anchor_factor, 1, "no saved contacts => every row at the neutral anchor floor");
  }
});

// ---------------------------------------------------------------------------
// 5. The join is on the HANDLE (the operator's vouch), NOT the sender's display
//    name — a saved handle anchors even if the inbound name would never match.
// ---------------------------------------------------------------------------

test("M5b: the contact lift joins on the saved HANDLE, not the inbound display NAME — a saved handle with a mismatched/absent name STILL anchors", async () => {
  const sources = {
    // The inbound carries a DIFFERENT display name than the saved contact name
    // ("Mom"); a name-based join would miss. The HANDLE is what the operator saved.
    source_a: [
      env({ thread_id: "dm_mom", sender_id: CONTACT_PHONE, sender_name: "Mobile", is_from_me: false, content: "can you grab milk on the way home?", ts: NOW - 1000 }),
    ],
  };
  const res = await buildCatchup({
    sources,
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0.3,
    anchor: { contacts: { contactMaps: contactMaps(), noMemo: true } },
  });
  const row = res.rows.find((r) => r.thread_id === "dm_mom");
  assert.ok(row, "the saved-handle row surfaces");
  assert.equal(row.enrichment.is_contact, true, "the saved HANDLE anchors even with a mismatched display name");
  assert.ok(row.anchor_factor > 1, "the handle vouch lifts the row regardless of the display name");
});

// ---------------------------------------------------------------------------
// 6. The composite enricher resolves the EXACT soft-fallback key the rank loop
//    hands it (the bridge + the contact index agree on the key shape).
// ---------------------------------------------------------------------------

test("M5b: makeWhoMattersEnricher resolves is_contact for the SOFT-fallback dedup key via the bridge (key-shape agreement)", () => {
  // The bridge maps the soft key to the raw saved handle.
  const handlesByPerson = new Map([[`source_a:${CONTACT_PHONE}`, [CONTACT_PHONE]]]);
  // A contact index built the same way the live one is (normalized last-10 digits).
  const contactIndex = {
    isContact(handles) {
      const norm = (h) => (typeof h === "string" ? h.replace(/\D/g, "").slice(-10) : "");
      return Array.isArray(handles) && handles.some((h) => norm(h) === "5551112222");
    },
  };
  const enrich = makeWhoMattersEnricher({ contactIndex, handlesByPerson });

  const saved = enrich(`source_a:${CONTACT_PHONE}`);
  assert.equal(saved.is_contact, true, "the soft-fallback dedup key resolves to the saved contact via the bridge");
  assert.ok(anchorFactor(saved) > 1, "a contact anchors UP (anchor_factor > 1)");

  const miss = enrich(`source_a:${STRANGER_PHONE}`);
  assert.equal(miss.is_contact, false, "an unsaved soft key stays a zero-signal");
  assert.equal(anchorFactor(miss), 1, "an unsaved soft key stays at the neutral floor (never down)");
});
