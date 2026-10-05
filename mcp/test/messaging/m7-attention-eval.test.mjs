// m7-attention-eval.test.mjs — WORKUNIT M7 (honest-eval): the W3 CLOSURE gate for
// the WHO-MATTERS attention model.
//
// THE INVISIBLE ERROR M7 EXISTS TO MEASURE:
//   M1-M5 inverted the catch-up surface from a DENYLIST to a POSITIVE who-matters
//   anchor + an honest UNKNOWN tier that is NEVER hard-dropped. The whole point is
//   to SURVIVE a genuine first-contact stranger long enough that operator feedback
//   + time can convert them into a relationship. But the existing goldsets
//   (ranking-eval-goldset.jsonl, held-out-labels.jsonl) are RECIPROCITY-SATURATED:
//   every label already has a two-way history (turn_count>=2). They can measure
//   RANKING (NDCG) but they are STRUCTURALLY BLIND to the silent failure — a
//   stranger whose FIRST message looks exactly like spam, who the surface might
//   bury or drop before they ever become real. No metric on the saturated set sees
//   it. So M7 BUILDS the cohort that can (m7-cohort.mjs), then measures:
//
//   (1) PRECISION of the relationship tier — no NOISE row tops the surface above a
//       real relationship (the positive-anchor promise: who-matters out-ranks noise).
//   (2) THE SILENT-ERROR metric (the headline) — RECALL of the became-real cohort
//       in the surfaced set: every genuine stranger-who-became-real must be PRESENT
//       (not hard-dropped) in the UNKNOWN tier, and ideally ranked ABOVE pure spam
//       within unknown. A drop here is the invisible failure; recall<1.0 fails.
//
// HONEST CONTROL: we run the SAME corpus with the anchor OFF (neutral, gate-OFF)
// and ON (the M5 composite). The became-real cohort must SURVIVE in BOTH (the
// non-drop is structural, not anchor-dependent); the anchor is what lifts a saved
// relationship ABOVE the reciprocity-only noise so the relationship-tier precision
// holds. This separates "did we drop the stranger" (always no) from "did we rank
// who-matters first" (anchor on).
//
// COHORT SIZE + LABELING: stated in the first test (mined, never hand-stamped — the
// labels are DERIVED from per-thread reciprocity over the corpus by m7-cohort.mjs).
//
// ESM, defensive, node:test + node:assert/strict. >=12 assertions. Hermetic: NO
// network, NO live DB, NO fs writes (contacts INJECTED via contactMaps + noMemo).
// 0 platform tokens in the eval path; sources are loaded ONCE into a corpus.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  buildCatchup,
  buildAdapterRegistry,
  loadEnvelopesFromSources,
} from "../../lib/messaging/catchup.js";
import { TIER, anchorFactor } from "../../lib/messaging/person-enrichment.js";
import { buildPersonIndex, lookup as personLookup } from "../../lib/messaging/identity.js";

import { buildAttentionCohort, contactKeySet } from "./m7-cohort.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(__dirname, "../../lib/messaging");

// ---------------------------------------------------------------------------
// Corpus — a realistic mixed catch-up window across THREE opaque platforms (the
// imessage / whatsapp / telegram stand-ins; the eval never branches on the name).
// Built from minimal N1 envelopes; DM threads (structurally directed); pinned now.
// The corpus is intentionally NOT reciprocity-saturated: it deliberately contains
// genuine first-contacts that LATER became real — the cohort the goldsets lack.
// ---------------------------------------------------------------------------
const NOW = 1700010000000;
const HOUR = 60 * 60 * 1000;
let _mid = 0;
function env({ thread_id, platform = "imessage", is_from_me = false, content = "hi", ts, sender_id, sender_name = null }) {
  _mid += 1;
  return {
    platform,
    thread_id,
    thread_type: "dm",
    sender: { id: is_from_me ? "user" : (sender_id || `peer_${thread_id}`), name: is_from_me ? null : sender_name, kind: "person" },
    recipients: ["user"],
    is_from_me,
    ts: typeof ts === "number" ? ts : NOW - HOUR + _mid * 1000,
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

// ---- The handles ----
const MOM_PHONE = "+15551110001";       // SAVED contact (relationship).
const ADA_PHONE = "+15551110002";       // SAVED contact (relationship).
// The became-real cohort: each sent a COLD first-contact (one inbound, no reply) in
// an EARLY thread, then LATER built a real two-way history (turn_count>=3) in a
// SECOND thread — so the LATEST thread grades ABOVE the new-contact neutral.
const SAM_PHONE = "+15552220001";       // stranger -> became real (a future friend).
const KAI_PHONE = "+15552220002";       // stranger -> became real (a recruiter who landed).
const NEW_PHONE = "+15552220003";       // a genuine new contact that has NOT yet replied
                                        //   (cold, single substantive inbound, max_turns 0 ->
                                        //   noise floor, but MUST still survive — the live
                                        //   first-contact the surface protects).
// The noise cohort: services / businesses / unsolicited pitches that SURFACE (look
// person-shaped + substantive — past the N8 closer-gate) but never become a saved
// relationship. The OBVIOUS noise (short spam / OTP codes) is already filtered
// UPSTREAM by N8 (isCloser) and never reaches the who-matters surface — that is the
// DENYLIST tier doing its job; M7 measures the HARDER, surfacing noise.
const SPAM_EMAIL = "pat.sample1854@example.com"; // an unsolicited account-phishing pitch.
const BIZ_PHONE = "+18005550000";       // a shipping/notification service (substantive).
const TAXI_PHONE = "+15553334444";      // a chatty BUSINESS with a long two-way history
                                        //   (reciprocity-only — NOT saved; the M5b case).

// ONLY the two saved phones resolve to a name (the address-book vouch).
function contactMaps() {
  return {
    phoneToName: new Map([
      ["5551110001", "Mom"],
      ["5551110002", "Ada"],
    ]),
    emailToName: new Map(),
  };
}

// Build the full corpus across three platforms. Returns { sources, contactKeys }.
function buildCorpus() {
  const imessage = [];
  const whatsapp = [];
  const telegram = [];

  // --- (c) relationships: saved contacts (single cold inbound each — the anchor,
  //         NOT reciprocity, is what makes them relationships). ---
  imessage.push(env({ thread_id: "dm_mom", platform: "imessage", sender_id: MOM_PHONE, sender_name: "Mom", content: "hey hon, call me when you get a sec?", ts: NOW - 30 * 60000 }));
  whatsapp.push(env({ thread_id: "dm_ada", platform: "whatsapp", sender_id: ADA_PHONE, sender_name: "Ada", content: "can you look at the q3 deck today?", ts: NOW - 25 * 60000 }));

  // --- (a) became-real: Sam. EARLY cold first-contact (one inbound, no reply) in an
  //         old thread; LATER a deep two-way history in a new thread. ---
  imessage.push(env({ thread_id: "dm_sam_first", platform: "imessage", sender_id: SAM_PHONE, sender_name: "Sam", content: "hi! a mutual friend suggested I reach out about the co-op", ts: NOW - 30 * 24 * HOUR }));
  // ... 20 days later they actually connected (alternating turns => turn_count high).
  for (let i = 0; i < 4; i++) {
    imessage.push(env({ thread_id: "dm_sam_now", platform: "imessage", sender_id: SAM_PHONE, sender_name: "Sam", content: `re: plan, point ${i}`, ts: NOW - (10 * HOUR) + i * 600000 }));
    imessage.push(env({ thread_id: "dm_sam_now", platform: "imessage", sender_id: "user", is_from_me: true, content: `got it, ${i}`, ts: NOW - (10 * HOUR) + i * 600000 + 120000 }));
  }
  imessage.push(env({ thread_id: "dm_sam_now", platform: "imessage", sender_id: SAM_PHONE, sender_name: "Sam", content: "are we still on for tomorrow?", ts: NOW - 3000 }));

  // --- (a) became-real: Kai (on a different platform). Same shape: cold first, then real. ---
  telegram.push(env({ thread_id: "tg_kai_first", platform: "telegram", sender_id: KAI_PHONE, sender_name: "Kai", content: "hello — saw your project, are you open to a chat?", ts: NOW - 21 * 24 * HOUR }));
  for (let i = 0; i < 3; i++) {
    telegram.push(env({ thread_id: "tg_kai_now", platform: "telegram", sender_id: KAI_PHONE, sender_name: "Kai", content: `following up ${i}`, ts: NOW - (8 * HOUR) + i * 600000 }));
    telegram.push(env({ thread_id: "tg_kai_now", platform: "telegram", sender_id: "user", is_from_me: true, content: `sounds good ${i}`, ts: NOW - (8 * HOUR) + i * 600000 + 120000 }));
  }
  telegram.push(env({ thread_id: "tg_kai_now", platform: "telegram", sender_id: KAI_PHONE, sender_name: "Kai", content: "did you get the doc?", ts: NOW - 5000 }));

  // --- a LIVE genuine first-contact that has NOT yet become real (single cold
  //     substantive inbound, max_turns 0). It is the floor case M5 protects:
  //     indistinguishable from spam in the message, MUST survive in unknown.
  //     (Labeled "noise" by the reciprocity-derived cohort because it has no two-way
  //     history YET — that is honest; the survival + within-tier checks cover it.) ---
  whatsapp.push(env({ thread_id: "dm_new", platform: "whatsapp", sender_id: NEW_PHONE, sender_name: "Jordan", content: "hi, I was referred by Priya — could we talk this week about the role?", ts: NOW - 1500 }));

  // --- (b) noise: SURFACING noise — substantive, person-shaped, but never a saved
  //     relationship. Single inbound (spam / service) + one chatty reciprocity-only
  //     business (the M5b QUICKTAXISERVICE case: high turn_count but NOT saved). ---
  imessage.push(env({ thread_id: "dm_spam", platform: "imessage", sender_id: SPAM_EMAIL, sender_name: "Pat", content: "can you confirm your account details to claim your prize today?", ts: NOW - 2000 }));
  imessage.push(env({ thread_id: "dm_biz", platform: "imessage", sender_id: BIZ_PHONE, sender_name: "Store", content: "your order has shipped, reply here if you need any help", ts: NOW - 2500 }));
  // A chatty business: a LONG two-way history (high turn_count) but NOT a saved
  // contact — reciprocity ALONE would float it; the anchor must keep it below saved
  // humans. It is reciprocity-saturated, so the cohort labels it "saturated" (not in
  // the became-real / noise / relationship sets) — it is the RANKING foil, present
  // in the corpus to stress the relationship-tier precision.
  for (let i = 0; i < 5; i++) {
    imessage.push(env({ thread_id: "dm_taxi", platform: "imessage", sender_id: TAXI_PHONE, sender_name: "QUICKTAXI", content: `your driver is ${i} minutes away from the pickup point`, ts: NOW - (20 - i) * 60000 }));
    imessage.push(env({ thread_id: "dm_taxi", platform: "imessage", sender_id: "user", is_from_me: true, content: "ok thanks", ts: NOW - (20 - i) * 60000 + 30000 }));
  }
  imessage.push(env({ thread_id: "dm_taxi", platform: "imessage", sender_id: TAXI_PHONE, sender_name: "QUICKTAXI", content: "can you confirm the pickup address for tomorrow morning?", ts: NOW - 1800 }));

  return {
    sources: { imessage, whatsapp, telegram },
    contactKeys: contactKeySet([MOM_PHONE, ADA_PHONE]),
  };
}

const PLATFORMS = ["imessage", "whatsapp", "telegram"];

// Mine the labeled cohort over the corpus using the SAME N7 resolver buildCatchup
// uses, so each cohort person_key matches the surfaced row's person_id. Returns
// { envelopes, cohort, resolvePerson }.
async function mineCohort({ becameRealTurns = 3 } = {}) {
  const { sources, contactKeys } = buildCorpus();
  const reg = fixtureRegistry(PLATFORMS);
  const envelopes = await loadEnvelopesFromSources(sources, reg);
  const index = buildPersonIndex(envelopes);
  const resolvePerson = (platform, senderId) => {
    try {
      return personLookup(index, platform, senderId);
    } catch {
      return null;
    }
  };
  const cohort = buildAttentionCohort(envelopes, { contactKeys, becameRealTurns, resolvePerson });
  return { sources, contactKeys, reg, envelopes, cohort, resolvePerson };
}

// Map a cohort person_key (the resolved person_id, else the soft `${platform}:${id}`)
// to the surfaced rows for that person. The projected row carries `person_id` (the
// resolved id) and `person` (= person_id when resolved); we match on either.
function rowsForPerson(rows, person_key) {
  return rows.filter(
    (r) => r.person_id === person_key || r.person === person_key,
  );
}

// ---------------------------------------------------------------------------
// 1. The COHORT — mined + labeled (never hand-stamped). State the SIZE + labeling.
// ---------------------------------------------------------------------------

test("M7: the cohort is MINED from per-thread reciprocity (not hand-stamped) — SIZE + labeling stated", async () => {
  const { cohort } = await mineCohort();

  // LABELING (derived from the corpus, NOT hand-stamped): a person is
  //   relationship = a saved contact (address-book vouch),
  //   became_real  = FIRST thread cold (turn_count===0) AND max turn_count>=N later,
  //   noise        = never reached a two-way history AND not saved (the honest floor),
  //   saturated    = a non-contact ALREADY two-way on the first thread (the existing
  //                  goldsets' coverage — EXCLUDED from all three cohorts).
  // The SIZE is the sum of the three labeled cohorts.
  assert.ok(cohort.size >= 6, `cohort SIZE=${cohort.size} (>=6: a sized, non-trivial eval set)`);
  assert.equal(cohort.relationship.length, 2, "2 saved relationships (Mom, Ada)");
  assert.equal(cohort.becameReal.length, 2, "2 became-real strangers (Sam, Kai) — cold first, real later");
  assert.ok(cohort.noise.length >= 3, `>=3 noise (phishing pitch / shipping service / the not-yet-real new contact), got ${cohort.noise.length}`);

  // The became-real labels are GENUINELY latency-gap: their FIRST thread had no
  // reply (turn_count 0) yet they later crossed the relationship threshold.
  for (const pk of cohort.becameReal) {
    const rec = cohort.people.get(pk);
    assert.equal(rec.first_thread_turns, 0, `${pk} first contact was COLD (turn_count 0)`);
    assert.ok(rec.max_turns >= 3, `${pk} LATER became real (max turn_count ${rec.max_turns} >= 3)`);
    assert.equal(rec.is_contact, false, `${pk} was NOT a saved contact at first (a genuine stranger)`);
  }
});

// ---------------------------------------------------------------------------
// 2. THE SILENT-ERROR metric (headline) — RECALL of the became-real cohort in the
//    surfaced set. A genuine stranger-who-became-real must NOT be hard-dropped.
//    This is the invisible failure no saturated goldset can see.
// ---------------------------------------------------------------------------

test("M7 (SILENT ERROR): every became-real stranger SURVIVES the surface (recall=1.0) — anchor OFF", async () => {
  const { sources, reg, cohort } = await mineCohort();
  // The CONTROL: gate OFF (neutral enricher). Survival must NOT depend on the anchor.
  const res = await buildCatchup({ sources, now: NOW, registry: reg, min_score: 0.1, limit: 100 });

  let survived = 0;
  for (const pk of cohort.becameReal) {
    if (rowsForPerson(res.rows, pk).length > 0) survived += 1;
  }
  const recall = survived / cohort.becameReal.length;
  // THE HEADLINE: recall must be 1.0 — NOT ONE became-real stranger is dropped.
  assert.equal(recall, 1.0, `SILENT-ERROR recall (anchor OFF) = ${recall} — every became-real stranger survived`);
  assert.equal(survived, cohort.becameReal.length, "no became-real stranger was hard-dropped (the invisible failure did NOT occur)");
});

test("M7 (SILENT ERROR): the became-real cohort also survives with the anchor ON (recall=1.0)", async () => {
  const { sources, reg, cohort } = await mineCohort();
  const res = await buildCatchup({
    sources, now: NOW, registry: reg, min_score: 0.1, limit: 100,
    anchor: { contacts: { contactMaps: contactMaps(), noMemo: true } },
  });

  let survived = 0;
  for (const pk of cohort.becameReal) {
    if (rowsForPerson(res.rows, pk).length > 0) survived += 1;
  }
  assert.equal(survived, cohort.becameReal.length, "anchor ON: every became-real stranger STILL surfaces (non-drop is structural)");
});

// ---------------------------------------------------------------------------
// 3. The became-real stranger, now grown a two-way history, is correctly TIERED as
//    a RELATIONSHIP at the LATEST thread (the latency gap has closed) — yet was
//    UNKNOWN at the cold first contact. This is the conversion M5 enables.
// ---------------------------------------------------------------------------

test("M7: a became-real stranger's LATEST thread is now RELATIONSHIP (reciprocity grew); a cold first-contact stays UNKNOWN", async () => {
  const { sources, reg } = await mineCohort();
  const res = await buildCatchup({ sources, now: NOW, registry: reg, min_score: 0.1, limit: 100 });

  // Sam's most-recent surfaced thread (dm_sam_now) has a deep two-way history ->
  // reciprocity_strength above the new-contact neutral -> RELATIONSHIP tier.
  const sam = res.rows.find((r) => r.thread_id === "dm_sam_now");
  assert.ok(sam, "Sam's grown thread surfaces");
  assert.equal(sam.tier, TIER.RELATIONSHIP, "a grown two-way history is now a RELATIONSHIP (conversion happened)");

  // The live, not-yet-real new contact (Jordan) stays UNKNOWN — honest, not dropped.
  const jordan = res.rows.find((r) => r.thread_id === "dm_new");
  assert.ok(jordan, "the live new contact surfaces (never dropped)");
  assert.equal(jordan.tier, TIER.UNKNOWN, "a genuine cold new contact is honestly UNKNOWN");
  assert.ok(jordan.score > 0, "and carries a real positive score (present in the list)");
});

// ---------------------------------------------------------------------------
// 4. PRECISION of the who-matters surface — measured on the SCORE within a platform
//    group (the final cross-platform DIVERSITY INTERLEAVE deliberately round-robins
//    platforms, so a linear position scan would conflate interleave with a ranking
//    error). The honest precision claim:
//      (i) within each platform group, every UNKNOWN row scores at-or-below the
//          RELATIONSHIP rows (no noise out-SCORES a relationship — tier holds), and
//      (ii) the M5b inversion: a SAVED human out-ranks a chatty reciprocity-only
//          business that, by reciprocity ALONE, would have topped them.
//    NOTE (honest finding): a chatty business with turns>=TURN_RELATIONSHIP grades to
//    full reciprocity_strength and is classified RELATIONSHIP by reciprocity alone —
//    that is the EXACT failure M5b's saved-contact SUB-SORT corrects (not by demoting
//    the business out of the tier, but by ranking the saved human above it).
// ---------------------------------------------------------------------------

test("M7 (PRECISION): within each platform, no UNKNOWN out-scores a RELATIONSHIP; a saved human out-ranks the chatty business (M5b inversion)", async () => {
  const { sources, reg } = await mineCohort();
  const res = await buildCatchup({
    sources, now: NOW, registry: reg, min_score: 0.1, limit: 100,
    anchor: { contacts: { contactMaps: contactMaps(), noMemo: true } },
  });

  // (i) Per platform, the MIN relationship score must be >= the MAX unknown score
  //     (no noise out-SCORES a relationship; the interleave only reorders ACROSS
  //     platforms, never within one). Measured on the raw score, interleave-agnostic.
  const byPlatform = new Map();
  for (const r of res.rows) {
    let g = byPlatform.get(r.platform);
    if (g === undefined) { g = { rel: [], unk: [] }; byPlatform.set(r.platform, g); }
    (r.tier === TIER.RELATIONSHIP ? g.rel : g.unk).push(r.score);
  }
  let violations = 0;
  for (const { rel, unk } of byPlatform.values()) {
    if (rel.length === 0 || unk.length === 0) continue;
    const minRel = Math.min(...rel);
    const maxUnk = Math.max(...unk);
    if (maxUnk > minRel) violations += 1;
  }
  assert.equal(violations, 0, "within every platform group, no UNKNOWN row out-scores a RELATIONSHIP row (precision holds)");

  // (ii) The M5b inversion: the saved human (Mom) out-ranks the chatty business
  //      (taxi) DESPITE the business having far more reciprocity. The anchor (a
  //      contact lift) is what inverts the reciprocity-only ordering.
  const mom = res.rows.find((r) => r.thread_id === "dm_mom");
  const taxi = res.rows.find((r) => r.thread_id === "dm_taxi");
  assert.ok(mom && taxi, "both the saved human and the chatty business surface (none dropped)");
  assert.ok(mom.anchor_factor > 1, `the saved human is anchored (anchor_factor=${mom.anchor_factor} > 1)`);
  assert.equal(taxi.anchor_factor, 1, "the business is NOT anchored (no saved-contact lift)");
  assert.ok(mom.score > taxi.score, `the saved human (${mom.score.toExponential(2)}) out-scores the chatty business (${taxi.score.toExponential(2)})`);
});

// ---------------------------------------------------------------------------
// 5. WITHIN the unknown tier, the became-real cohort + a substantive cold contact are
//    not buried at the very floor: the anchor must NOT push the genuine new contact
//    below the reciprocity-only business it (honestly) cannot yet out-score. The
//    honest claim: the new contact SURVIVES in unknown and is not strictly dominated
//    out of the visible window — measured as its presence + a real positive score.
// ---------------------------------------------------------------------------

test("M7: in the UNKNOWN tier, a substantive cold contact survives with a real score and is not floored out of the window", async () => {
  const { sources, reg } = await mineCohort();
  const res = await buildCatchup({ sources, now: NOW, registry: reg, min_score: 0.1, limit: 100 });

  const unknownRows = res.rows.filter((r) => r.tier === TIER.UNKNOWN);
  assert.ok(unknownRows.length >= 3, `several unknown rows surfaced (got ${unknownRows.length})`);

  const jordan = unknownRows.find((r) => r.thread_id === "dm_new"); // a substantive referral.
  assert.ok(jordan, "the substantive cold contact is in the unknown tier (surfaced, not dropped)");
  assert.ok(jordan.score > 0, "the cold contact carries a real positive score (not floored to zero / out)");

  // It is NOT dead-last: at least one unknown row ranks at or below it (it is not the
  // single most-buried unknown despite being the newest cold node).
  const ji = res.rows.indexOf(jordan);
  const lastUnknownIdx = res.rows.map((r) => r.tier).lastIndexOf(TIER.UNKNOWN);
  assert.ok(ji <= lastUnknownIdx, "the cold contact is within the unknown tier window (never below it)");
});

// ---------------------------------------------------------------------------
// 6. The cohort builder is DETERMINISTIC + TOTAL (the eval-harness purity invariant).
// ---------------------------------------------------------------------------

test("M7: the cohort builder is DETERMINISTIC over the corpus and TOTAL over odd input (never throws)", async () => {
  const { sources, contactKeys } = buildCorpus();
  const reg = fixtureRegistry(PLATFORMS);
  const envelopes = await loadEnvelopesFromSources(sources, reg);
  const a = buildAttentionCohort(envelopes, { contactKeys });
  const b = buildAttentionCohort(envelopes, { contactKeys });
  assert.deepEqual([...a.becameReal].sort(), [...b.becameReal].sort(), "became-real cohort is deterministic");
  assert.deepEqual([...a.noise].sort(), [...b.noise].sort(), "noise cohort is deterministic");
  assert.deepEqual([...a.relationship].sort(), [...b.relationship].sort(), "relationship cohort is deterministic");

  // TOTAL: malformed / empty corpus -> empty cohort, never a throw.
  assert.doesNotThrow(() => buildAttentionCohort(null));
  assert.doesNotThrow(() => buildAttentionCohort([null, 42, {}, { thread_id: "x" }]));
  assert.equal(buildAttentionCohort([]).size, 0, "an empty corpus yields an empty cohort");
});

// ---------------------------------------------------------------------------
// 7. The eval path holds the abstraction invariant: 0 platform tokens in the cohort
//    builder (the new diagnostic must not re-introduce a platform branch above L1),
//    and it does NOT import the fact-ledger (NOT-the-fact-ledger hard constraint).
// ---------------------------------------------------------------------------

test("M7: the cohort builder names 0 platform tokens and does NOT import the fact-ledger (the invariants hold)", () => {
  const src = readFileSync(path.join(__dirname, "m7-cohort.mjs"), "utf8");
  // ZERO platform tokens: no literal platform name in the diagnostic (it reads
  // opaque platform/sender strings only). Mirror the n10/n11 grep gate's tokens.
  const PLATFORM_TOKENS = [/\bimessage\b/i, /\bwhatsapp\b/i, /\btelegram\b/i, /\bsignal\b/i, /\bmail\b/i];
  // Strip comments + strings is overkill here; assert no token appears as a code
  // identifier by checking the raw source has none OUTSIDE comment lines.
  const codeLines = src
    .split("\n")
    .filter((ln) => !ln.trimStart().startsWith("//"));
  const code = codeLines.join("\n");
  for (const re of PLATFORM_TOKENS) {
    assert.ok(!re.test(code), `cohort builder code names no platform token (${re})`);
  }
  // NOT the fact-ledger: the builder imports only attention + contacts-anchor.
  assert.ok(!/memory\.jsonl|fact-ledger|ledger\.js|memory-ledger/i.test(code), "cohort builder does not import the fact-ledger");
  assert.ok(/reciprocityOfThread/.test(src), "labels are derived from per-thread reciprocity (the honest, mined signal)");
});
