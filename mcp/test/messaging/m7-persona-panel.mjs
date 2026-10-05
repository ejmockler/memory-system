// m7-persona-panel.mjs — the FINDABILITY persona panel (authorized standing fixture).
//
// WHY THIS EXISTS: the buried-stranger error (a cold first-contact who matters but
// looks like spam) CANNOT be mined from the operator's live ledgers — a person there
// collapses into ONE thread, so the cold-first/deep-later shape never occurs (see
// m7-cohort.mjs). The old recall=1.0 metric was therefore VACUOUS (empty cohort over a
// never-hard-drop surface). This module supplies a small FIXED panel of known-important
// people as authored L1 envelopes, injected into the live corpus, so the eval can assert
// the one thing that matters: are they FINDABLE in the rendered list at the real limit?
//
// Each persona is a real attention shape the surface must get right:
//   - mira    : a SAVED CONTACT (explicit human vouch) -> must render, relationship tier.
//   - nadia   : the BECAME-REAL arc — a cold first thread (turns 0, old) AND a later deep
//               two-way thread (turns>=3, recent). The latency-gap case live data collapses.
//   - theo    : a COLD-BUT-IMPORTANT STRANGER — one recent, substantive, directed first
//               message, NOT a contact. The exact buried-stranger case: honestly UNKNOWN,
//               but must NOT be buried below the noise floor / out of the rendered window.
//
// THESIS #1: pure data. No I/O, no mutation. ts values are positioned relative to the
// `now` passed in (Date.now is not called here). 0 platform tokens beyond opaque labels.

const DAY = 24 * 60 * 60 * 1000;

// A minimal valid L1 envelope (the loadEnvelopesFromSources / adapter output shape).
// thread_type "dm" makes it inherently directed-at-me (a 1:1), so the classifier scores
// it without needing platform-specific mention plumbing.
function mkEnv({ platform, thread_id, sid, name, kind, fromMe, ts, content, smid }) {
  return {
    platform,
    thread_id,
    thread_type: "dm",
    sender: fromMe
      ? { id: "self", name: "me", kind: "person" }
      : { id: sid, name: name ?? null, kind: kind ?? "person" },
    recipients: [],
    is_from_me: fromMe === true,
    ts,
    content,
    mentions: [],
    directed_at_me_signals: {
      mention_me: false,
      reply_to_me: false,
      addressed_to_me: fromMe !== true, // an inbound DM is addressed to me
    },
    capabilities: {
      reply_to_available: false,
      structured_mentions: false,
      self_identity_reliable: true,
      addressing_first_class: false,
    },
    source_msg_id: smid,
  };
}

/**
 * buildPersonaPanel(now) -> { envelopes, contactHandles, panel }
 *   envelopes      : authored L1 envelopes to concat into the live corpus.
 *   contactHandles : handles the eval must add to the saved-contact key-set (mira).
 *   panel          : [{ key, handle, label, expect }] — the findability assertions.
 *                    `key` is the soft dedup key `${platform}:${sid}` buildCatchup forms
 *                    when N7 does not collapse a persona (these handles are panel-unique).
 */
export function buildPersonaPanel(now) {
  const t = typeof now === "number" && Number.isFinite(now) ? now : 0;
  const envs = [];

  // --- mira: a saved contact with an established, STEADY cadence (~weekly inbound
  //     over a month) — the established-friend shape. EXPECT relationship tier,
  //     arc "steady", topic "dinner plans", findable. (A single message would
  //     faithfully derive "new", so the steady scenario is authored as real data.)
  const miraSid = "+15105550147";
  envs.push(mkEnv({ platform: "imessage", thread_id: "panel-mira", sid: miraSid, name: "Mira Chen", kind: "person", fromMe: false, ts: t - 24 * DAY, content: "loved that new place — let's make dinner a monthly thing", smid: "panel-mira-1" }));
  envs.push(mkEnv({ platform: "imessage", thread_id: "panel-mira", sid: miraSid, name: "Mira Chen", kind: "person", fromMe: false, ts: t - 17 * DAY, content: "can we move dinner to friday this week?", smid: "panel-mira-2" }));
  envs.push(mkEnv({ platform: "imessage", thread_id: "panel-mira", sid: miraSid, name: "Mira Chen", kind: "person", fromMe: false, ts: t - 10 * DAY, content: "booked us a table for dinner saturday at 7", smid: "panel-mira-3" }));
  envs.push(mkEnv({ platform: "imessage", thread_id: "panel-mira", sid: miraSid, name: "Mira Chen", kind: "person", fromMe: false, ts: t - 3 * DAY, content: "are we still on for dinner saturday?", smid: "panel-mira-4" }));

  // --- nadia: BECAME-REAL. Cold first thread (old, turns 0) + a later deep thread
  //     (recent, turns>=3). Not a contact. EXPECT findable (a real relationship by history). ---
  const nadiaSid = "+2348030000077";
  envs.push(mkEnv({ platform: "whatsapp", thread_id: "panel-nadia-a", sid: nadiaSid, name: "Nadia Okafor", kind: "person", fromMe: false, ts: t - 60 * DAY, content: "Hello! We met at the Lagos workshop — I run the maternal-health pilot.", smid: "panel-nadia-a1" }));
  envs.push(mkEnv({ platform: "whatsapp", thread_id: "panel-nadia-b", sid: nadiaSid, name: "Nadia Okafor", kind: "person", fromMe: false, ts: t - 2 * DAY, content: "Following up on the dataset we discussed — does the schema work?", smid: "panel-nadia-b1" }));
  envs.push(mkEnv({ platform: "whatsapp", thread_id: "panel-nadia-b", sid: nadiaSid, fromMe: true, ts: t - 2 * DAY + 3600000, content: "Yes — sending the cleaned version now.", smid: "panel-nadia-b2" }));
  envs.push(mkEnv({ platform: "whatsapp", thread_id: "panel-nadia-b", sid: nadiaSid, name: "Nadia Okafor", kind: "person", fromMe: false, ts: t - 1 * DAY, content: "Got it, this is perfect. Thursday works on my end.", smid: "panel-nadia-b3" }));
  envs.push(mkEnv({ platform: "whatsapp", thread_id: "panel-nadia-b", sid: nadiaSid, fromMe: true, ts: t - 1 * DAY + 3600000, content: "Great, locking Thursday 3pm.", smid: "panel-nadia-b4" }));

  // --- theo: COLD-BUT-IMPORTANT STRANGER. One recent, substantive, directed first
  //     message. Not a contact, no history. EXPECT unknown tier BUT findable (not buried). ---
  const theoSid = "+14155550182";
  envs.push(mkEnv({ platform: "imessage", thread_id: "panel-theo", sid: theoSid, name: null, kind: "person", fromMe: false, ts: t - 1 * DAY, content: "Hello, Sam Sample pointed me your way regarding the library fund. Would a short 20-minute call sometime this week work for you?", smid: "panel-theo-1" }));

  return {
    envelopes: envs,
    contactHandles: [miraSid], // the eval adds these to the saved-contact key-set
    panel: [
      { platform: "imessage", sid: miraSid, name: "Mira Chen", key: `imessage:${miraSid}`, handle: miraSid, label: "mira (recent DM)", expect: "findable", truth: { role: "personal/friend", topics: ["dinner plans"], arc: { trend: "steady" } } },
      { platform: "whatsapp", sid: nadiaSid, name: "Nadia Okafor", key: `whatsapp:${nadiaSid}`, handle: nadiaSid, label: "nadia (became-real)", expect: "findable", truth: { role: "collaborator", topics: ["maternal-health pilot", "dataset/schema", "scheduling"], arc: { trend: "accelerating" } } },
      { platform: "imessage", sid: theoSid, name: null, key: `imessage:${theoSid}`, handle: theoSid, label: "theo (cold important stranger)", expect: "findable (unknown ok)", truth: { role: "unknown", topics: ["library fund", "intro call"], arc: { trend: "new" } } },
    ],
  };
}
