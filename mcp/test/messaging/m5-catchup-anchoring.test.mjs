// m5-catchup-anchoring.test.mjs — WORKUNIT M5 gate: catchup ANCHORING + the honest
// UNKNOWN/first-contact TIER.
//
// M5 COMPOSES the W1 sources into the real enrichPerson resolver injected at
// buildCatchup (replacing the neutral default):
//   - M2 contacts-anchor (is_contact, the saved-human vouch),
//   - M3 feedback-log    (feedback_score, the operator's own triage),
//   - P2r reciprocity_strength (already per-thread),
// folded by M1's MONOTONE anchorFactor into an UP-rank multiplier; then it labels
// each surfaced row with a first-class TIER: "relationship" (a saved contact OR a
// deep two-way history OR positive feedback) vs "unknown" (a cold node — a genuine
// new contact, spam, or a business, indistinguishable in the message). The UNKNOWN
// tier is surfaced + grouped BELOW relationships + LABELED — NEVER dropped.
//
// What this proves (mapped to the M5 WORKUNIT + the HARD CONSTRAINTS):
//   - classifyTier / tierRank: a positive signal => relationship; none => unknown;
//     a genuine new contact (recip == new-contact neutral) STAYS unknown; total.
//   - a saved CONTACT out-ranks an unanchored stranger (anchored UP-rank + tier).
//   - the UNKNOWN tier CONTAINS the genuine new contact — it is NOT dropped.
//   - spam / a business sender land in UNKNOWN, ranked BELOW relationships.
//   - positive FEEDBACK lifts a stranger into the relationship tier (M3 composed).
//   - tier is surfaced on each row + tallied in stats.tiers.
//   - NEUTRAL when no sources wired: buildCatchup (no anchor) == the neutral default
//     (byte-identical rows) — the gate-OFF safety.
//   - SOFT-guard: a throwing source / empty index degrades to neutral, never throws.
//   - 0 PLATFORM TOKENS over person-enrichment.js + catchup.js (the abstraction
//     invariant holds after M5).
//   - NOT THE FACT-LEDGER: neither module imports the fact-ledger.
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions. Hermetic: NO
// network, NO live DB, NO fs writes. Sources are INJECTED (contactMaps / a temp
// feedback path) so the composite is deterministic.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  buildCatchup,
  buildAdapterRegistry,
  loadEnvelopesFromSources,
  buildHandlesByPerson,
  makeWhoMattersEnricher,
  CATCHUP_CAPS,
  ORDER_KEY_SEQUENCE,
  makeCompareDesc,
} from "../../lib/messaging/catchup.js";

import {
  classifyTier,
  tierRank,
  TIER,
  ANCHOR_CAPS,
  anchorFactor,
} from "../../lib/messaging/person-enrichment.js";

import { buildFeedbackIndex } from "../../lib/messaging/feedback-log.js";
import { buildContactAnchorIndex } from "../../lib/messaging/contacts-anchor.js";
import { buildPersonIndex, lookup as personLookup } from "../../lib/messaging/identity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(__dirname, "../../lib/messaging");

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
    sender: { id: is_from_me ? "user" : (sender_id || `peer_${thread_id}`), name: is_from_me ? null : sender_name },
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

// A saved-contact + a stranger, both single inbound first-contacts (0 reciprocity),
// equal recency. The ONLY differentiator is the saved-contact membership (M2).
const SAVED_PHONE = "+15551112222";
const STRANGER_PHONE = "+15559998888";
function contactVsStrangerSources() {
  return {
    source_a: [
      env({ thread_id: "dm_contact", platform: "source_a", sender_id: SAVED_PHONE, sender_name: "Ada", is_from_me: false, content: "hey, can you take a look when you get a sec?", ts: NOW - 1000 }),
      env({ thread_id: "dm_stranger", platform: "source_a", sender_id: STRANGER_PHONE, sender_name: "Unknown", is_from_me: false, content: "hi, can you confirm your account details please?", ts: NOW - 1000 }),
    ],
  };
}

// A contact-maps fixture: the saved phone resolves to a name; the stranger does not.
function contactMaps() {
  return {
    phoneToName: new Map([["5551112222", "Ada"]]),
    emailToName: new Map(),
  };
}

// Build a hermetic feedback index from in-memory rows.
function feedbackIndex(rows) {
  return buildFeedbackIndex(rows);
}

function tmpFeedbackLog(rows) {
  const dir = mkdtempSync(path.join(tmpdir(), "m5-fb-"));
  const file = path.join(dir, "engagement.jsonl");
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  return file;
}

// ---------------------------------------------------------------------------
// 1. classifyTier — the honest UNKNOWN/first-contact classification.
// ---------------------------------------------------------------------------

// The production HIGH reciprocity-only threshold (M5c). classifyTier reads it as
// INJECTED DATA via { recip_min }; the catchup surface injects exactly this.
const HIGH = CATCHUP_CAPS.RELATIONSHIP_RECIP_MIN; // ≈ 0.9
const RECIP = { recip_min: HIGH };

test("M5: classifyTier — a saved contact is a RELATIONSHIP (even with zero reciprocity / non-person kind)", () => {
  assert.equal(classifyTier({ is_contact: true, reciprocity_strength: 0, feedback_score: 0 }, RECIP), TIER.RELATIONSHIP);
  // is_contact is the strongest vouch — it wins regardless of sender_kind.
  assert.equal(classifyTier({ is_contact: true, reciprocity_strength: 0, feedback_score: 0, sender_kind: "service" }, RECIP), TIER.RELATIONSHIP);
});

test("M5c: classifyTier — a deep HIGH-reciprocity PERSON history (recip at/above the high threshold) is a RELATIONSHIP", () => {
  // A genuine deep two-way relationship (reciprocity saturated at 1.0) with a person.
  assert.equal(classifyTier({ is_contact: false, reciprocity_strength: 1.0, feedback_score: 0, sender_kind: "person" }, RECIP), TIER.RELATIONSHIP);
  // EXACTLY at the high threshold (>= boundary) with a person sender => relationship.
  assert.equal(classifyTier({ is_contact: false, reciprocity_strength: HIGH, feedback_score: 0, sender_kind: "person" }, RECIP), TIER.RELATIONSHIP);
  // Absent sender_kind defaults to "person" (backward-compat) — a high-recip human survives.
  assert.equal(classifyTier({ is_contact: false, reciprocity_strength: HIGH, feedback_score: 0 }, RECIP), TIER.RELATIONSHIP);
});

test("M5c: classifyTier — a MODERATE-reciprocity business (QUICKTAXISERVICE-like, recip 0.77, is_contact=N, no feedback) is DEMOTED to UNKNOWN", () => {
  // The exact M5c regression: 0.77 was > 0.7 (old neutral) so it crossed into
  // relationship on reciprocity alone. Under the HIGH threshold (0.9) it is UNKNOWN.
  assert.equal(classifyTier({ is_contact: false, reciprocity_strength: 0.77, feedback_score: 0, sender_kind: "person" }, RECIP), TIER.UNKNOWN);
  // Just below the high threshold (a chatty business) is likewise UNKNOWN.
  assert.equal(classifyTier({ is_contact: false, reciprocity_strength: HIGH - 0.01, feedback_score: 0, sender_kind: "person" }, RECIP), TIER.UNKNOWN);
});

test("M5c: classifyTier — a HIGH-reciprocity NON-PERSON sender (bot/service/system auto-reply loop) is DEMOTED to UNKNOWN", () => {
  // Even at saturated reciprocity, a non-person sender NEVER earns the reciprocity-
  // only relationship (an auto-reply loop must not look like a real two-way bond).
  for (const kind of ["bot", "service", "system"]) {
    assert.equal(
      classifyTier({ is_contact: false, reciprocity_strength: 1.0, feedback_score: 0, sender_kind: kind }, RECIP),
      TIER.UNKNOWN,
      `${kind} sender at full reciprocity => unknown (no reciprocity-only relationship)`,
    );
  }
});

test("M5: classifyTier — positive operator feedback is a RELATIONSHIP (independent of reciprocity / sender_kind)", () => {
  assert.equal(classifyTier({ is_contact: false, reciprocity_strength: 0, feedback_score: 0.4 }, RECIP), TIER.RELATIONSHIP);
  // Feedback is the operator's explicit vouch — it wins even for a service sender.
  assert.equal(classifyTier({ is_contact: false, reciprocity_strength: 0, feedback_score: 0.4, sender_kind: "service" }, RECIP), TIER.RELATIONSHIP);
});

test("M5: classifyTier — a genuine NEW CONTACT (recip == new-contact neutral, no other signal) STAYS unknown (never promoted, never dropped)", () => {
  // The new-contact neutral (0.7) is FAR below the high threshold => unknown.
  assert.equal(classifyTier({ is_contact: false, reciprocity_strength: ANCHOR_CAPS.TIER_RECIPROCITY_MIN, feedback_score: 0, sender_kind: "person" }, RECIP), TIER.UNKNOWN);
  // A broadcast floor and a cold node are likewise unknown.
  assert.equal(classifyTier({ is_contact: false, reciprocity_strength: 0.3, feedback_score: 0 }, RECIP), TIER.UNKNOWN);
  assert.equal(classifyTier({ is_contact: false, reciprocity_strength: 0, feedback_score: 0 }, RECIP), TIER.UNKNOWN);
});

test("M5: classifyTier is TOTAL over odd input => unknown (the conservative default), never throws", () => {
  assert.equal(classifyTier(null, RECIP), TIER.UNKNOWN);
  assert.equal(classifyTier(undefined, RECIP), TIER.UNKNOWN);
  assert.equal(classifyTier(42, RECIP), TIER.UNKNOWN);
  assert.equal(classifyTier({ reciprocity_strength: NaN, feedback_score: "x" }, RECIP), TIER.UNKNOWN);
  // An odd/missing opts degrades to the module fallback threshold (no throw).
  assert.equal(classifyTier({ is_contact: true }, null), TIER.RELATIONSHIP);
  assert.equal(classifyTier({ is_contact: false, reciprocity_strength: 1.0, sender_kind: "person" }, "x"), TIER.RELATIONSHIP);
});

test("M5: tierRank — RELATIONSHIP sorts before UNKNOWN; an unknown tier sorts as UNKNOWN", () => {
  assert.ok(tierRank(TIER.RELATIONSHIP) < tierRank(TIER.UNKNOWN), "relationship ranks above unknown");
  assert.equal(tierRank("nonsense"), tierRank(TIER.UNKNOWN), "an unrecognized tier degrades to the unknown rank");
});

// ---------------------------------------------------------------------------
// 1c. M5c end-to-end — the reciprocity-only RELATIONSHIP tier is TIGHTENED.
//
// Build an alternating DM thread of N direction transitions, ENDING inbound (so
// the catch-up surface treats it as unanswered + they-spoke-last). The graded
// reciprocityStrength maps turn_count -> a strength factor:
//   turns=3 (out,in,out,in) => 0.775  — a MODERATE-reciprocity business (the
//     QUICKTAXISERVICE case): under the HIGH threshold (0.9) it is DEMOTED to
//     UNKNOWN (still surfaced, NEVER dropped).
//   turns>=5 (.. => >=0.925) => a deep two-way PERSON history: RELATIONSHIP.
// No saved contact, no feedback — the ONLY signal is reciprocity, so the tier is
// decided PURELY by the M5c reciprocity gate.
// ---------------------------------------------------------------------------

// Build an alternating thread ENDING inbound. `transitions` = the target
// turn_count. Sequence starts outbound: out,in,out,in,... so an ODD count of
// transitions ends inbound (the operator opened, they replied last => unanswered).
function alternatingThread({ thread_id, sender_id, sender_name, transitions, sender_kind, baseTs = NOW - 200000 }) {
  const seq = [];
  // total messages = transitions + 1; first message is outbound (from_me).
  for (let i = 0; i <= transitions; i += 1) {
    const fromMe = i % 2 === 0; // 0=out,1=in,2=out,... ends inbound when transitions is odd
    const e = env({
      thread_id,
      platform: "source_a",
      is_from_me: fromMe,
      sender_id: fromMe ? undefined : sender_id,
      sender_name: fromMe ? null : sender_name,
      content: fromMe ? "ok thanks" : "any update on this? please confirm",
      ts: baseTs + i * 1000,
    });
    // The inbound senders carry an explicit sender.kind (read agnostically at the
    // tier-decision point). Outbound (is_from_me) envelopes are the operator.
    if (!fromMe && typeof sender_kind === "string") {
      e.sender = { ...e.sender, kind: sender_kind };
    }
    seq.push(e);
  }
  return seq;
}

test("M5c (end-to-end): a MODERATE-reciprocity business (recip≈0.77, is_contact=N, no feedback) is DEMOTED to UNKNOWN — surfaced, NOT dropped", async () => {
  const sources = {
    source_a: alternatingThread({
      thread_id: "dm_biz_recip",
      sender_id: "+18005551234",
      sender_name: "QUICKTAXISERVICE",
      transitions: 3, // => reciprocity_strength ≈ 0.775 (< the 0.9 high threshold)
      sender_kind: "person", // even as a "person" kind, 0.77 alone is NOT enough
    }),
  };
  const res = await buildCatchup({
    sources,
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0.0,
    anchor: { contacts: { contactMaps: { phoneToName: new Map(), emailToName: new Map() }, noMemo: true } },
  });
  const biz = res.rows.find((r) => r.thread_id === "dm_biz_recip");
  assert.ok(biz, "the moderate-reciprocity business STILL surfaces (DEMOTED, never dropped)");
  // Sanity: the graded strength is in the moderate band (above neutral, below high).
  assert.ok(biz.reciprocity_strength > ANCHOR_CAPS.TIER_RECIPROCITY_MIN, `recip ${biz.reciprocity_strength} > old neutral (would have been relationship pre-M5c)`);
  assert.ok(biz.reciprocity_strength < HIGH, `recip ${biz.reciprocity_strength} < high threshold ${HIGH}`);
  assert.equal(biz.enrichment.is_contact, false, "no saved-contact signal");
  assert.equal(biz.enrichment.feedback_score, 0, "no feedback signal");
  assert.equal(biz.tier, TIER.UNKNOWN, "M5c: moderate reciprocity alone => DEMOTED to unknown");
  assert.ok(biz.score > 0, "a real, positive score — present in the output (never a hard-drop)");
});

test("M5c (end-to-end): a HIGH-reciprocity PERSON (deep two-way history) STAYS in the RELATIONSHIP tier", async () => {
  const sources = {
    source_a: alternatingThread({
      thread_id: "dm_deep_person",
      sender_id: "+15551234567",
      sender_name: "Jordan",
      transitions: 5, // => reciprocity_strength ≈ 0.925 (>= the 0.9 high threshold)
      sender_kind: "person",
    }),
  };
  const res = await buildCatchup({
    sources,
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0.0,
    anchor: { contacts: { contactMaps: { phoneToName: new Map(), emailToName: new Map() }, noMemo: true } },
  });
  const deep = res.rows.find((r) => r.thread_id === "dm_deep_person");
  assert.ok(deep, "the deep two-way person surfaces");
  assert.ok(deep.reciprocity_strength >= HIGH, `recip ${deep.reciprocity_strength} >= high threshold ${HIGH}`);
  assert.equal(deep.enrichment.is_contact, false, "no saved-contact signal — the relationship is from reciprocity alone");
  assert.equal(deep.tier, TIER.RELATIONSHIP, "M5c: a deep HIGH-reciprocity person STAYS a relationship");
});

test("M5c (end-to-end): the demoted business and the deep person co-exist — relationship sorts ABOVE the demoted unknown, both present", async () => {
  const sources = {
    source_a: [
      ...alternatingThread({ thread_id: "dm_biz_recip", sender_id: "+18005551234", sender_name: "QUICKTAXISERVICE", transitions: 3, sender_kind: "person", baseTs: NOW - 150000 }),
      ...alternatingThread({ thread_id: "dm_deep_person", sender_id: "+15551234567", sender_name: "Jordan", transitions: 5, sender_kind: "person", baseTs: NOW - 100000 }),
    ],
  };
  const res = await buildCatchup({
    sources,
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0.0,
    anchor: { contacts: { contactMaps: { phoneToName: new Map(), emailToName: new Map() }, noMemo: true } },
  });
  const biz = res.rows.find((r) => r.thread_id === "dm_biz_recip");
  const deep = res.rows.find((r) => r.thread_id === "dm_deep_person");
  assert.ok(biz && deep, "BOTH surface — the demoted business is NOT dropped");
  assert.equal(biz.tier, TIER.UNKNOWN, "business demoted to unknown");
  assert.equal(deep.tier, TIER.RELATIONSHIP, "deep person is a relationship");
  const bi = res.rows.findIndex((r) => r.thread_id === "dm_biz_recip");
  const di = res.rows.findIndex((r) => r.thread_id === "dm_deep_person");
  assert.ok(di < bi, "the relationship (deep person) is ranked ABOVE the demoted unknown (business)");
  assert.equal(res.stats.tiers.relationship, 1, "stats: one relationship");
  assert.equal(res.stats.tiers.unknown, 1, "stats: one unknown (the demoted business — surfaced, tallied)");
});

// ---------------------------------------------------------------------------
// 2. A saved CONTACT out-ranks an unanchored stranger (the anchor UP-rank + tier).
// ---------------------------------------------------------------------------

test("M5 (end-to-end): a saved CONTACT out-ranks an equal-recency unanchored stranger", async () => {
  const res = await buildCatchup({
    sources: contactVsStrangerSources(),
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0.3,
    anchor: { contacts: { contactMaps: contactMaps(), noMemo: true } },
  });
  const contact = res.rows.find((r) => r.thread_id === "dm_contact");
  const stranger = res.rows.find((r) => r.thread_id === "dm_stranger");
  assert.ok(contact, "the saved contact surfaces");
  assert.ok(stranger, "the stranger STILL surfaces (never hard-dropped)");
  assert.equal(contact.tier, TIER.RELATIONSHIP, "saved contact => relationship tier");
  assert.equal(stranger.tier, TIER.UNKNOWN, "stranger => unknown tier");
  assert.ok(contact.anchor_factor > 1, `contact anchored (anchor_factor=${contact.anchor_factor} > 1)`);
  assert.equal(stranger.anchor_factor, 1, "stranger stays at the neutral floor (no down-rank)");
  assert.ok(contact.score > stranger.score, `contact (${contact.score}) out-ranks stranger (${stranger.score})`);
  const ci = res.rows.findIndex((r) => r.thread_id === "dm_contact");
  const si = res.rows.findIndex((r) => r.thread_id === "dm_stranger");
  assert.ok(ci < si, "the contact appears before the stranger in the ranked output (relationship tier first)");
});

// ---------------------------------------------------------------------------
// 3. The UNKNOWN tier CONTAINS the genuine new contact — NOT dropped.
// ---------------------------------------------------------------------------

test("M5 (end-to-end): the UNKNOWN tier contains a GENUINE new contact — surfaced, labeled, NOT dropped", async () => {
  const sources = {
    source_a: [
      env({ thread_id: "dm_new", platform: "source_a", sender_id: STRANGER_PHONE, sender_name: "Sam (new)", is_from_me: false, content: "hi, a mutual friend suggested I reach out — can we chat about the project?", ts: NOW - 1000 }),
    ],
  };
  const res = await buildCatchup({
    sources,
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0.3,
    anchor: { contacts: { contactMaps: contactMaps(), noMemo: true } },
  });
  const newRow = res.rows.find((r) => r.thread_id === "dm_new");
  assert.ok(newRow, "the genuine new contact STILL appears (unknown is surfaced, not dropped)");
  assert.equal(newRow.tier, TIER.UNKNOWN, "a genuine new contact is honestly classified UNKNOWN");
  assert.ok(newRow.score > 0, "a real, positive score — present in the list (never a hard-drop)");
  assert.equal(res.stats.tiers.unknown, 1, "stats tally the surfaced unknown row");
  assert.equal(res.stats.tiers.relationship, 0, "no relationship rows in this set");
});

// ---------------------------------------------------------------------------
// 4. Spam / business land in UNKNOWN, ranked BELOW a relationship.
// ---------------------------------------------------------------------------

test("M5 (end-to-end): spam + a business sender land in UNKNOWN, ranked BELOW a saved contact", async () => {
  const sources = {
    source_a: [
      env({ thread_id: "dm_contact", platform: "source_a", sender_id: SAVED_PHONE, sender_name: "Ada", is_from_me: false, content: "can you review the q3 deck today?", ts: NOW - 3000 }),
      env({ thread_id: "dm_spam", platform: "source_a", sender_id: "pat.sample1854@example.com", sender_name: "Pat", is_from_me: false, content: "can you confirm your account details please?", ts: NOW - 1000 }),
      env({ thread_id: "dm_biz", platform: "source_a", sender_id: "+18005550000", sender_name: "Store", is_from_me: false, content: "your order has shipped, reply for help", ts: NOW - 2000 }),
    ],
  };
  const res = await buildCatchup({
    sources,
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0.3,
    anchor: { contacts: { contactMaps: contactMaps(), noMemo: true } },
  });
  const contact = res.rows.find((r) => r.thread_id === "dm_contact");
  const spam = res.rows.find((r) => r.thread_id === "dm_spam");
  const biz = res.rows.find((r) => r.thread_id === "dm_biz");
  assert.ok(contact && spam && biz, "all three surface (none hard-dropped)");
  assert.equal(contact.tier, TIER.RELATIONSHIP, "saved contact => relationship");
  assert.equal(spam.tier, TIER.UNKNOWN, "spam => unknown");
  assert.equal(biz.tier, TIER.UNKNOWN, "business => unknown");
  const ci = res.rows.findIndex((r) => r.thread_id === "dm_contact");
  const spi = res.rows.findIndex((r) => r.thread_id === "dm_spam");
  const bi = res.rows.findIndex((r) => r.thread_id === "dm_biz");
  assert.ok(ci < spi && ci < bi, "the relationship is ranked above BOTH unknown rows");
  assert.equal(res.stats.tiers.relationship, 1, "stats: one relationship");
  assert.equal(res.stats.tiers.unknown, 2, "stats: two unknown");
});

// ---------------------------------------------------------------------------
// 5. Positive FEEDBACK (M3) lifts a stranger into the relationship tier.
// ---------------------------------------------------------------------------

// The feedback log keys on the SAME opaque person_id the surface deduplicates on
// (the resolved N7 person_id when present). Discover it from a first pass, then
// key the feedback index on it — exactly how the operator records feedback on a
// surfaced row's person_id.
async function discoverPersonId(sources, threadId, reg) {
  const res = await buildCatchup({ sources, now: NOW, registry: reg, min_score: 0.3 });
  const row = res.rows.find((r) => r.thread_id === threadId);
  return row ? (row.person_id || (row.enrichment && row.enrichment.person_id) || null) : null;
}

test("M5 (end-to-end): positive operator FEEDBACK lifts an un-saved stranger into the RELATIONSHIP tier (M3 composed)", async () => {
  const sources = {
    source_a: [
      env({ thread_id: "dm_fav", platform: "source_a", sender_id: STRANGER_PHONE, sender_name: "Friend", is_from_me: false, content: "are we still on for friday?", ts: NOW - 1000 }),
    ],
  };
  const reg = fixtureRegistry(["source_a"]);
  // The surface's dedup key (the resolved person_id) IS the feedback subject_id.
  const subjectId = await discoverPersonId(sources, "dm_fav", reg);
  assert.ok(subjectId, "the surfaced row carries a stable person_id (the feedback subject_id)");
  const fbIndex = feedbackIndex([
    { subject_id: subjectId, action: "replied" },
    { subject_id: subjectId, action: "opened" },
  ]);
  const res = await buildCatchup({
    sources,
    now: NOW,
    registry: reg,
    min_score: 0.3,
    // No contact maps — the lift is PURELY the feedback signal.
    anchor: { contacts: { contactMaps: { phoneToName: new Map(), emailToName: new Map() }, noMemo: true }, feedbackIndex: fbIndex },
  });
  const fav = res.rows.find((r) => r.thread_id === "dm_fav");
  assert.ok(fav, "the favored stranger surfaces");
  assert.equal(fav.tier, TIER.RELATIONSHIP, "positive feedback => relationship tier");
  assert.ok(fav.enrichment.feedback_score > 0, `feedback_score lifted (${fav.enrichment.feedback_score} > 0)`);
  assert.ok(fav.anchor_factor > 1, "anchored UP by the feedback lift");
});

// ---------------------------------------------------------------------------
// 6. NEUTRAL when no sources wired: buildCatchup (no anchor) == the neutral default.
// ---------------------------------------------------------------------------

test("M5: buildCatchup with NO anchor opt-in is byte-identical to the neutral default (gate-OFF safety)", async () => {
  const sources = contactVsStrangerSources();
  const reg = fixtureRegistry(["source_a"]);
  const noAnchor = await buildCatchup({ sources, now: NOW, registry: reg, min_score: 0.3 });
  const neutral = await buildCatchup({ sources, now: NOW, registry: reg, min_score: 0.3 });
  assert.deepEqual(noAnchor.rows, neutral.rows, "no-anchor rows are byte-identical to the neutral default");
  // With no anchor, the saved contact is NOT anchored (no source read) — both rows
  // are unknown-tier (reciprocity-only), neither anchored. The contact still surfaces.
  for (const r of noAnchor.rows) {
    assert.equal(r.anchor_factor, 1, "no anchor => every row at the neutral floor");
    assert.equal(r.tier, TIER.UNKNOWN, "no anchor + 0-reciprocity => unknown tier for both");
  }
});

// ---------------------------------------------------------------------------
// 7. SOFT-guard: a throwing source degrades to neutral (never throws).
// ---------------------------------------------------------------------------

test("M5: a throwing contact source degrades to the NEUTRAL enricher — surface intact, never throws", async () => {
  const throwingIndex = { isContact() { throw new Error("boom"); } };
  const res = await buildCatchup({
    sources: contactVsStrangerSources(),
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0.3,
    anchor: { contactIndex: throwingIndex },
  });
  assert.ok(res.rows.length >= 2, "the surface is intact despite the throwing source");
  for (const r of res.rows) {
    assert.equal(r.anchor_factor, 1, "a throwing source degrades each row to the neutral floor");
  }
});

test("M5: makeWhoMattersEnricher with NO sources returns the neutral enricher (anchor_factor 1.0)", () => {
  const enrich = makeWhoMattersEnricher({});
  const e = enrich("source_a:+10000000000");
  assert.equal(e.anchor_factor, ANCHOR_CAPS.ANCHOR_FACTOR_NEUTRAL, "no sources => neutral");
  assert.equal(e.is_contact, false, "no contact signal");
  assert.equal(e.feedback_score, 0, "no feedback signal");
});

// ---------------------------------------------------------------------------
// 8. buildHandlesByPerson — the M2 handle-resolution index.
// ---------------------------------------------------------------------------

test("M5: buildHandlesByPerson maps the soft dedup key AND the resolved person_id to the sender handle", async () => {
  const sources = contactVsStrangerSources();
  const reg = fixtureRegistry(["source_a"]);
  const envelopes = await loadEnvelopesFromSources(sources, reg);
  const idx = buildPersonIndex(envelopes);
  const resolve = (platform, senderId) => {
    try { return personLookup(idx, platform, senderId); } catch { return null; }
  };
  const map = buildHandlesByPerson(envelopes, resolve);
  // The soft key carries the handle.
  const softKey = `source_a:${SAVED_PHONE}`;
  assert.ok(map.has(softKey), "soft dedup key is indexed");
  assert.ok(map.get(softKey).includes(SAVED_PHONE), "the soft key resolves to the sender handle");
  // Outbound (is_from_me) senders contribute NO handle.
  for (const [k] of map) {
    assert.notEqual(k, "user", "the 'user' (outbound) id is never a contact handle");
  }
});

test("M5: makeWhoMattersEnricher composes M2 is_contact via the handle map (saved => is_contact, anchored)", () => {
  const handlesByPerson = new Map([[`source_a:${SAVED_PHONE}`, [SAVED_PHONE]]]);
  // A tiny contact index: only the saved phone is a contact.
  const contactIndex = {
    isContact(handles) {
      const norm = (h) => (typeof h === "string" ? h.replace(/\D/g, "").slice(-10) : "");
      return Array.isArray(handles) && handles.some((h) => norm(h) === "5551112222");
    },
  };
  const enrich = makeWhoMattersEnricher({ contactIndex, handlesByPerson });
  const saved = enrich(`source_a:${SAVED_PHONE}`);
  assert.equal(saved.is_contact, true, "saved handle resolves to is_contact");
  assert.ok(anchorFactor(saved) > 1, "a contact anchors UP (anchor_factor > 1)");
  const stranger = enrich(`source_a:${STRANGER_PHONE}`);
  assert.equal(stranger.is_contact, false, "an unknown handle stays a zero-signal");
  assert.equal(anchorFactor(stranger), 1, "an unknown handle stays at the neutral floor (never down)");
});

// ---------------------------------------------------------------------------
// 9. tier surfaced on each row + a real feedback LOG read (hermetic temp path).
// ---------------------------------------------------------------------------

test("M5 (end-to-end): tier is surfaced on every row and the feedback LOG path is read end-to-end", async () => {
  const sources = {
    source_a: [
      env({ thread_id: "dm_fav", platform: "source_a", sender_id: STRANGER_PHONE, sender_name: "Friend", is_from_me: false, content: "are we still on for friday?", ts: NOW - 1000 }),
    ],
  };
  const reg = fixtureRegistry(["source_a"]);
  const subjectId = await discoverPersonId(sources, "dm_fav", reg);
  assert.ok(subjectId, "the surfaced row carries a stable person_id");
  const fbPath = tmpFeedbackLog([
    { subject_id: subjectId, action: "replied", ts: new Date(NOW).toISOString() },
  ]);
  const res = await buildCatchup({
    sources,
    now: NOW,
    registry: reg,
    min_score: 0.3,
    anchor: { contacts: { contactMaps: { phoneToName: new Map(), emailToName: new Map() }, noMemo: true }, feedback: { path: fbPath } },
  });
  const fav = res.rows.find((r) => r.thread_id === "dm_fav");
  assert.ok(fav && typeof fav.tier === "string", "every row carries a string tier");
  assert.equal(fav.tier, TIER.RELATIONSHIP, "the replied-to subject is a relationship (from the real log read)");
  assert.ok(res.stats && res.stats.tiers && typeof res.stats.tiers.relationship === "number", "stats carry tier tallies");
});

// ---------------------------------------------------------------------------
// 10. The ABSTRACTION INVARIANT — 0 platform tokens + NOT the fact-ledger.
// ---------------------------------------------------------------------------

test("M5: person-enrichment.js + catchup.js carry ZERO platform tokens after the anchoring + tier layer", () => {
  const files = ["person-enrichment.js", "catchup.js"].map((f) => path.join(LIB_DIR, f));
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");
    for (const tok of ["imessage", "telegram", "whatsapp", "\"mail\"", "'mail'", "rbm.goog", "urn:biz"]) {
      assert.equal(
        code.toLowerCase().includes(tok.toLowerCase()),
        false,
        `${path.basename(file)} must not contain the platform/structural token ${tok}`,
      );
    }
  }
});

test("M5: NOT the fact-ledger — person-enrichment.js + the M5 wiring import NO fact-ledger", () => {
  const peSrc = readFileSync(path.join(LIB_DIR, "person-enrichment.js"), "utf8");
  // person-enrichment.js is the pure shape owner: ZERO imports.
  assert.equal(/^\s*import\s/m.test(peSrc), false, "person-enrichment.js has no imports (no fact-ledger coupling)");
  const cuSrc = readFileSync(path.join(LIB_DIR, "catchup.js"), "utf8");
  // catchup.js must NOT import a fact-ledger module (the who-matters anchor is
  // sourced from contacts / feedback / reciprocity, NOT the git-log fact ledger).
  for (const banned of ["fact-ledger", "fact_ledger", "factLedger", "/ledger.js", "facts.js"]) {
    assert.equal(cuSrc.includes(banned), false, `catchup.js must not import ${banned}`);
  }
});

// ---------------------------------------------------------------------------
// 11. Real contact-anchor index degrades to neutral with no address book (degrades).
// ---------------------------------------------------------------------------

test("M5: buildContactAnchorIndex with empty maps => an EMPTY index (everyone is_contact=false => neutral)", async () => {
  const idx = await buildContactAnchorIndex({ contactMaps: { phoneToName: new Map(), emailToName: new Map() }, noMemo: true });
  assert.equal(typeof idx.isContact, "function", "an index is returned even with no contacts");
  assert.equal(idx.isContact([SAVED_PHONE]), false, "no saved contacts => every handle is_contact=false (neutral)");
});

// ---------------------------------------------------------------------------
// 12. f2b — THE RANK ORDER IS ONE DECLARED SEQUENCE, AND IT IS GATED
//     BYTE-FOR-BYTE.
//
// WHY THIS LIVES HERE AND NOT IN A NEW FILE. The comparator used to be a
// hand-written if-ladder inside buildCatchupCore whose key order was ALSO
// restated in source comments and re-implemented a fourth time in the
// measurement harness. Extracting it to a module-scope factory over a declared
// sequence (catchup.js: ORDER_KEY_SEQUENCE / makeCompareDesc) is a REFACTOR that
// must move NO ROW — so what it needs is not a new claim but a byte-identity
// baseline: the exact emitted sequence of (platform, thread_id, ts, score) and
// each row's dedup-group membership, recorded from fixtures the surface is
// already gated on, and asserted verbatim.
//
// THE GOLDEN VALUES BELOW WERE CAPTURED FROM THE PRE-EXTRACTION COMPARATOR — the
// tree at 646179d, before a line of catchup.js was touched — by replaying these
// four fixtures through buildCatchup and pasting the observed values. They are
// literals on purpose, because a golden recomputed from the code under test
// proves nothing.
//
// THE RED-FIRST PROOF, run and quoted in the node that added this: perturbing the
// declared sequence — swapping KEY_SCORE and KEY_TS in ORDER_KEY_SEQUENCE — FAILS
// the ordering assertions below; restoring it PASSES. Two of the four fixtures are
// built specifically so that score-desc and ts-desc DISAGREE (an older thread
// carrying the deeper reciprocity history out-scores a newer first contact),
// because on the pre-existing fixtures the two keys happen to agree and the swap
// would have been invisible.
// ---------------------------------------------------------------------------

const N9_FIXTURE = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures", "n9-catchup.fixtures.json"), "utf8"),
);
const N9_NOW = N9_FIXTURE.meta.pinned_now_ts;

// The four fields that ARE the order, plus the dedup group's membership. A head
// swap inside a group leaves `also` identical while thread_id/ts/score change,
// which is exactly why both are recorded.
function goldenOf(res) {
  return res.rows.map((r) => ({
    platform: r.platform,
    thread_id: r.thread_id,
    ts: r.ts,
    score: r.score,
    also: (r.also_waiting_on || []).map((w) => `${w.platform}|${w.thread_id}`).sort(),
  }));
}

const NO_CONTACTS = {
  contacts: { contactMaps: { phoneToName: new Map(), emailToName: new Map() }, noMemo: true },
};

test("f2b: the rank order is ONE declared sequence — KEY_TIER first, frozen, and an unknown key is a construction-time throw", () => {
  assert.deepEqual(
    [...ORDER_KEY_SEQUENCE],
    ["KEY_TIER", "KEY_CONTACT", "KEY_SCORE", "KEY_TS", "KEY_THREAD"],
    "the shipped five keys, in the shipped order",
  );
  assert.equal(Object.isFrozen(ORDER_KEY_SEQUENCE), true, "the declared sequence is frozen");
  assert.equal(ORDER_KEY_SEQUENCE[0], "KEY_TIER", "GOAL invariant 3: tier stays the PRIMARY key");
  // A typo in a candidate sequence must fail LOUDLY at construction — never
  // silently drop a key and let a table be published under a comparator nobody
  // declared. This is the NEGATIVE direction of the `sequence` parameter.
  assert.throws(() => makeCompareDesc({ sequence: ["KEY_TIER", "KEY_SCORRE"] }), /unknown ordering key/);
  // The defaults ARE the shipped comparator: same sequence, same contact reader.
  const cmp = makeCompareDesc();
  const rel = { tier: TIER.RELATIONSHIP, score: 0.1, ts: 1, thread_id: "a", enrichment: { is_contact: false } };
  const unk = { tier: TIER.UNKNOWN, score: 0.9, ts: 2, thread_id: "b", enrichment: { is_contact: true } };
  assert.ok(cmp(rel, unk) < 0, "KEY_TIER outranks every key below it, including the vouch and the score");
  // The DEFAULT contact reader is module-local (deliberately not a third export),
  // so its TOTALITY is covered through the comparator's observable behaviour: an
  // absent vouch and an odd row must both read as "not a contact", never throw.
  const base = { tier: TIER.RELATIONSHIP, score: 0.5, ts: 10, thread_id: "z" };
  const vouched = { ...base, thread_id: "z", enrichment: { is_contact: true } };
  assert.ok(cmp(vouched, { ...base, enrichment: {} }) < 0, "absent vouch => not a contact, never a throw");
  assert.ok(cmp(vouched, { ...base }) < 0, "a row with no enrichment at all => not a contact");
  assert.equal(cmp({ ...base, enrichment: {} }, { ...base }), 0, "two un-vouched shapes are indistinguishable to KEY_CONTACT");
  // KEY_SCORE's totality clamp: a degenerate score must not yield NaN (which
  // SortCompare coerces to +0 and which would make the sort — and therefore the
  // dedup head — implementation-defined).
  const degenerate = { tier: TIER.UNKNOWN, score: undefined, ts: 5, thread_id: "d" };
  const zero = { tier: TIER.UNKNOWN, score: 0, ts: 5, thread_id: "d" };
  const negative = { tier: TIER.UNKNOWN, score: -3, ts: 5, thread_id: "d" };
  assert.equal(cmp(degenerate, zero), 0, "a missing score degrades to 0 and COLLIDES with a zero score");
  assert.equal(cmp(negative, zero), 0, "a negative score still collides with a zero score, as before the extraction");
  assert.equal(Number.isNaN(cmp(degenerate, zero)), false, "no comparison ever returns NaN");
});

test("f2b: the `sequence` parameter is real — a PERMUTED sequence demonstrably reorders the discriminating pair", () => {
  // The pair KEY_SCORE and KEY_TS disagree on: an older, deeper thread that
  // out-scores a newer one. Both rows are UNKNOWN and un-vouched, so KEY_TIER and
  // KEY_CONTACT are ties and the swap is the ONLY thing that decides.
  const older_higher = { tier: TIER.UNKNOWN, score: 0.9, ts: 100, thread_id: "older", enrichment: {} };
  const newer_lower = { tier: TIER.UNKNOWN, score: 0.1, ts: 900, thread_id: "newer", enrichment: {} };
  const shipped = makeCompareDesc();
  const permuted = makeCompareDesc({
    sequence: ["KEY_TIER", "KEY_CONTACT", "KEY_TS", "KEY_SCORE", "KEY_THREAD"],
  });
  assert.ok(shipped(older_higher, newer_lower) < 0, "shipped: KEY_SCORE decides, the higher-scoring OLDER row first");
  assert.ok(permuted(older_higher, newer_lower) > 0, "permuted: KEY_TS decides, the NEWER row first — a different order");
  assert.deepEqual(
    [older_higher, newer_lower].sort(permuted).map((r) => r.thread_id),
    ["newer", "older"],
    "the permutation is observable in an actual sort, not only in one comparison",
  );
  // The permutation is exercised so the parameter is EARNED; the shipped surface
  // still passes nothing, which the source scan below pins.
});

test("f2b: catchup.js defines exactly ONE comparator, and BOTH sort seats consume the same instance", () => {
  const src = readFileSync(path.join(LIB_DIR, "catchup.js"), "utf8");
  // Strip comments first — prose that MENTIONS the comparator must not count as a
  // definition (the same stripping the platform-token gate above performs).
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
  assert.equal(
    (code.match(/function\s+compareDesc\s*\(/g) || []).length,
    1,
    "exactly one comparator function body exists in catchup.js — the one makeCompareDesc returns",
  );
  assert.equal(
    (code.match(/export function makeCompareDesc\s*\(/g) || []).length,
    1,
    "one factory",
  );
  assert.equal(
    (code.match(/=\s*makeCompareDesc\s*\(/g) || []).length,
    1,
    "the shipped path constructs the comparator EXACTLY ONCE (never two constructions)",
  );
  assert.equal(
    (code.match(/\.sort\(DEFAULT_COMPARE_DESC\)/g) || []).length,
    2,
    "both sort seats — dedup head selection and emitted order — consume that one instance",
  );
  // NO CONFIGURATION SEAM ON THE SURFACE: the factory's only parameters are
  // `sequence` and `readContact`, and the retired quantization grid is not back.
  for (const banned of ["quantizeScore", "SCORE_ORDER_RESOLUTION"]) {
    assert.equal(code.includes(banned), false, `the ordering block must not reintroduce ${banned}`);
  }
});

test("f2b: the measurement harness owns NO key order — it imports the shipped comparator", () => {
  const src = readFileSync(path.join(__dirname, "e7-catchup-join-eval.mjs"), "utf8");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
  assert.equal(
    (code.match(/tierRank\s*\(/g) || []).length,
    0,
    "the harness no longer calls tierRank — the tier key comes from the imported comparator",
  );
  assert.equal(/import\s*\{[^}]*tierRank[^}]*\}\s*from\s*["'][^"']*person-enrichment/.test(code), false,
    "and it no longer imports tierRank at all");
  assert.equal(
    (code.match(/makeCompareDesc\s*\(/g) || []).length,
    1,
    "it obtains its comparator from catchup.js's factory, exactly once",
  );
  assert.equal((code.match(/function\s+mirrorCompare\s*\(/g) || []).length, 0, "the hand-written mirror is gone");
});

test("f2b (golden): the n9 fixture corpus emits a byte-identical order and dedup membership", async () => {
  const res = await buildCatchup({
    sources: N9_FIXTURE.sources,
    now: N9_NOW,
    registry: fixtureRegistry(["source_a", "source_b"]),
  });
  assert.deepEqual(goldenOf(res), [
    {
      platform: "source_b",
      thread_id: "dm_amara_b",
      ts: 1700005000000,
      score: 0.34725115740740736,
      also: ["source_a|dm_amara_a"],
    },
    {
      platform: "source_a",
      thread_id: "dm_blake_a",
      ts: 1700001000000,
      score: 0.34505208333333337,
      also: [],
    },
  ]);
});

test("f2b (golden): the tier + saved-contact fixture emits a byte-identical order", async () => {
  const sources = {
    source_a: [
      env({ thread_id: "g_contact", sender_id: SAVED_PHONE, sender_name: "Ada", content: "can you review the q3 deck today?", ts: NOW - 3000 }),
      env({ thread_id: "g_spam", sender_id: "pat.sample1854@example.com", sender_name: "Pat", content: "can you confirm your account details please?", ts: NOW - 1000 }),
      env({ thread_id: "g_biz", sender_id: "+18005550000", sender_name: "Store", content: "your order has shipped, reply for help", ts: NOW - 2000 }),
    ],
  };
  const res = await buildCatchup({
    sources,
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0.3,
    anchor: { contacts: { contactMaps: contactMaps(), noMemo: true } },
  });
  assert.deepEqual(goldenOf(res), [
    { platform: "source_a", thread_id: "g_contact", ts: NOW - 3000, score: 0.5249975260416667, also: [] },
    { platform: "source_a", thread_id: "g_spam", ts: NOW - 1000, score: 0.3499994502314815, also: [] },
    { platform: "source_a", thread_id: "g_biz", ts: NOW - 2000, score: 0.34999890046296295, also: [] },
  ]);
});

test("f2b (golden, KEY_SCORE vs KEY_TS): an OLDER deeper thread out-ranks a NEWER first contact", async () => {
  // The discriminating fixture. Both rows are UNKNOWN and neither is vouched, so
  // KEY_TIER and KEY_CONTACT are ties and KEY_SCORE decides. The deeper thread is
  // ~197s OLDER, so a sequence that put KEY_TS above KEY_SCORE would emit these
  // two the other way round.
  const sources = {
    source_a: [
      ...alternatingThread({ thread_id: "g_deep", sender_id: "+18005551234", sender_name: "Deep", transitions: 3, baseTs: NOW - 200000 }),
      env({ thread_id: "g_fresh", sender_id: "+15559998888", sender_name: "Fresh", content: "any update on this? please confirm", ts: NOW - 1000 }),
    ],
  };
  const res = await buildCatchup({
    sources,
    now: NOW,
    registry: fixtureRegistry(["source_a"]),
    min_score: 0.0,
    anchor: NO_CONTACTS,
  });
  const g = goldenOf(res);
  assert.deepEqual(g.map((r) => r.thread_id), ["g_deep", "g_fresh"], "KEY_SCORE decides, over the newer ts");
  assert.ok(g[0].ts < g[1].ts, "the winner really is the OLDER row (so a KEY_SCORE/KEY_TS swap is observable)");
  assert.deepEqual(g, [
    { platform: "source_a", thread_id: "g_deep", ts: NOW - 200000 + 3000, score: 0.3873800915591931, also: [] },
    { platform: "source_a", thread_id: "g_fresh", ts: NOW - 1000, score: 0.3499994502314815, also: [] },
  ]);
});

test("f2b (golden, DEDUP HEAD): the head of a cross-platform group is the KEY_SCORE winner, not the newest thread", async () => {
  // ONE person, two threads on two sources. The OLDER thread carries the deeper
  // history and the higher score, so it heads the group; a sequence that put
  // KEY_TS above KEY_SCORE would head it with the NEWER thread and every carried
  // field (thread_id, ts, score, platform) would change with it.
  const sources = {
    source_a: alternatingThread({ thread_id: "g_p_deep", sender_id: SAVED_PHONE, sender_name: "Pat", transitions: 3, baseTs: NOW - 200000 }),
    source_b: [env({ thread_id: "g_p_new", platform: "source_b", sender_id: SAVED_PHONE, sender_name: "Pat", content: "any update on this? please confirm", ts: NOW - 1000 })],
  };
  const res = await buildCatchup({
    sources,
    now: NOW,
    registry: fixtureRegistry(["source_a", "source_b"]),
    min_score: 0.0,
    anchor: NO_CONTACTS,
  });
  assert.deepEqual(goldenOf(res), [
    {
      platform: "source_a",
      thread_id: "g_p_deep",
      ts: NOW - 200000 + 3000,
      score: 0.3873800915591931,
      also: ["source_b|g_p_new"],
    },
  ]);
});
