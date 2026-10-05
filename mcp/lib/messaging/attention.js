// attention.js — Wave-2 N8 ATTENTION / RESPONSE-STATE ENGINE (L4).
//
// Over an Envelope[] (the L1 contract frozen by N1) this module computes a
// per-thread, read-only "are they waiting on me?" projection. Three orthogonal,
// platform-agnostic signals fuse into one AttentionRecord per thread:
//
//   1. they-spoke-last (unanswered): the chronologically last message in a
//      thread is NOT is_from_me. A thread where *I* spoke last is answered
//      (drop); a thread where *they* spoke last is a candidate to surface.
//   2. staleness: now - last_ts (ms), bucketed for ranking.
//   3. substance: REUSE the synthesis valence scorer to decide whether the
//      trailing inbound run is real content or a closer-only tail
//      ("ah cool!", "thanks!", "👍"). A they-spoke-last thread whose trailing
//      inbound content is a pure closer must NOT surface — the discriminating
//      gate of this node.
//
// N8 also consumes N2's directed_at_me as a per-message gate: a message only
// counts toward "they are waiting on me" if it was plausibly directed at me. In
// a 1:1 DM this is structurally true; in a group it filters undirected chatter.
//
// THE ABSTRACTION INVARIANT (live-proven here exactly as in N2/N1): this file
// imports NO adapter and contains NO platform string literal. Every platform's
// behavior arrives as DATA via envelope.capabilities{} / directed_at_me_signals{}
// (consumed through the injected N2 classifier) — never via `if (platform===)`.
// A grep for any platform token over this file returns 0; that is half the gate.
//
// THE SUBSTANCE TRAP (the load-bearing design finding — see N8.md Findings):
//   scoreValence(text).magnitude is NOT a monotone "substance" proxy. It is an
//   EMOTIONAL-POSITIVITY proxy. Empirically:
//     "ah cool!"                     -> magnitude 0.707  (a CLOSER)
//     "sounds good" / "lol nice"     -> magnitude ~0.7-1.0 (CLOSERS)
//     "can you send me the q3 deck?" -> magnitude 0.000  (SUBSTANTIVE)
//     "what time tomorrow?"          -> magnitude 0.000  (SUBSTANTIVE)
//   So a naive `isCloser = magnitude <= floor` is BACKWARDS — it would surface
//   "ah cool!" and drop "can you send the deck?". The valence magnitude is used
//   here ONLY as the POSITIVE-closer arm of a composite rule: a message is a
//   closer when it is SHORT and carries no actionable content (no question, no
//   ask-word), where "short positive interjection" is one closer shape and
//   "short pure-stopword / emoji-only" is the other. A question mark or an
//   ask/request token, or sufficient length, makes a run SUBSTANTIVE regardless
//   of valence. This is documented in N8.md MAP-2/MAP-3.
//
// PURITY (Thesis #1, read-only projection): pure and synchronous (the scorers it
// reuses are pure). `now` is injected (default Date.now()) so staleness is
// deterministic under test. It NEVER mutates an input envelope (inputs are
// treated as frozen; we clone before annotating) and NEVER writes a source or
// fact row. It THROWS TypeError on a top-level contract violation (envelopes not
// an array) — mirroring valence-scorer.js:249 — but is total over individual
// malformed envelopes (they are skipped and counted in _telemetry.skipped).

import { scoreValence } from "../synthesis/valence-scorer.js";
import { scoreEpisodicity } from "../synthesis/episodicity-scorer.js";
import { classifyDirectedAtMe } from "./classifier.js";

export const MODEL_VERSION = "attention-v1";

// ---------------------------------------------------------------------------
// ATTENTION_CAPS — the single, frozen source of every magic number. Bumping any
// value REQUIRES a MODEL_VERSION bump (downstream the catch-up surface pins to
// the emitted version). Object.freeze enforces single-producer discipline.
// ---------------------------------------------------------------------------
export const ATTENTION_CAPS = Object.freeze({
  // Substance floor. A trailing inbound run whose composite substance score is
  // <= this is a closer (non-substantive) and the thread does NOT surface. The
  // composite score is in [0,1]; see substanceOfLastInboundRun for its build.
  SUBSTANCE_FLOOR: 0.5,

  // Staleness bucket upper bounds (ms), evaluated in order. The first bound the
  // age is strictly LESS than wins. ">= the last bound" => the terminal bucket.
  // Ordered ascending; bucket index is monotone in age (the A6 invariant).
  STALENESS_BUCKETS: Object.freeze([
    { name: "fresh", maxMs: 60 * 60 * 1000 },          // < 1h
    { name: "today", maxMs: 24 * 60 * 60 * 1000 },     // < 24h
    { name: "stale", maxMs: 7 * 24 * 60 * 60 * 1000 }, // < 7d
    // terminal bucket "dead" applies at >= 7d (no maxMs).
  ]),
  STALENESS_TERMINAL_BUCKET: "dead",

  // N2 directed gate threshold — N8's OWN attention threshold, deliberately
  // BELOW N2's binary DIRECTED_THRESHOLD (0.5). Rationale: N2's 0.5 boundary is
  // tuned for "is this strictly addressed to me"; for ATTENTION ("did they put
  // the ball in my court") a weaker structural signal still counts. With N2's
  // frozen weights in a GROUP (GROUP_PRIOR=0): a lone @-mention scores 0.32, a
  // lone reply-to-me scores 0.48, first-class addressing scores 0.50, and pure
  // undirected chatter scores 0.00. A threshold of 0.30 captures mention / reply
  // / addressing (all real "you're being pulled in" signals) while still
  // dropping undirected chatter. A bare DM scores DM_PRIOR=0.50 >= 0.30, so DMs
  // are structurally directed. This is a per-node knob (the task permits N8 to
  // choose its own threshold over N2's score); N2 itself is unchanged.
  DIRECTED_THRESHOLD: 0.3,

  // Substance composite knobs (all in the closer-vs-substantive rule):
  //   SHORT_TOKEN_MAX  — a run of <= this many word-tokens is "short" and is a
  //                      closer-candidate (subject to the actionable-content
  //                      escape below).
  //   LONG_TOKEN_MIN   — a run of >= this many word-tokens is substantive by
  //                      length alone (people don't write paragraph closers).
  SHORT_TOKEN_MAX: 4,
  LONG_TOKEN_MIN: 8,

  // Episodicity is consulted as a weak secondary substance signal over
  // SYNTHESIZED inputs (a raw envelope has no features block — see MAP-2). It
  // contributes only via EP_WEIGHT to the composite; the primary discriminator
  // is the actionable-content / length rule. Kept small so a faint episodic
  // read never overrides a clear closer.
  EP_WEIGHT: 0.0,
});

// ---------------------------------------------------------------------------
// Actionable-content lexicon — the SUBSTANTIVE arm. These are surface tokens
// that signal a question / ask / request (the thing that "puts the ball in my
// court"). Frozen + auditable. NOT platform names. A run carrying any of these,
// OR a literal "?", is substantive regardless of its valence magnitude.
// ---------------------------------------------------------------------------
const ASK_TOKENS = Object.freeze(new Set([
  // interrogatives
  "what", "when", "where", "who", "why", "how", "which", "whom",
  // requests / asks
  "can", "could", "would", "will", "please", "pls", "plz",
  "send", "share", "resend", "forward", "reply", "respond", "confirm",
  "need", "want", "let", "lemme", "give", "tell", "ask", "check",
  "review", "look", "update", "ping", "call", "email", "schedule",
  "available", "free", "thoughts", "wdyt", "deck", "doc", "file", "link",
  // modal / pending-action
  "should", "shall", "do", "did", "does", "are", "is", "ready",
  "waiting", "wait", "actually", "question",
]));

// ---------------------------------------------------------------------------
// Module-level telemetry. Observation side-channel ONLY — never part of the
// pure projection. The same envelopes always yield the same records regardless
// of telemetry state. Mirrors valence-scorer.js / classifier.js discipline.
// ---------------------------------------------------------------------------
const _telemetry = {
  skipped: 0,           // individual malformed envelopes dropped (not thrown)
  excluded_nonperson: 0, // inbound bot/service/system senders excluded (N11 A2)
  threads: 0,           // thread groups formed
  surfaced: 0,          // records with surface=true
  closer_dropped: 0,    // they-spoke-last+directed but closer -> not surfaced
};

export function getAttentionTelemetry() {
  return Object.freeze({ ..._telemetry });
}

export function resetAttentionTelemetry() {
  for (const k of Object.keys(_telemetry)) _telemetry[k] = 0;
}

// ---------------------------------------------------------------------------
// Defensive predicates / readers. N8 conforms to N1 but does not assume the
// caller pre-validated: a malformed envelope is skipped (counted), never thrown.
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// An envelope is USABLE here when it carries the minimal fields N8 reads: a
// non-empty thread_id, an integer-ms ts (N1 guarantees this on valid envelopes;
// we re-check defensively so a bad row cannot poison the sort), and a sender
// with an id. is_from_me / content are read with safe coercion below.
function isUsableEnvelope(env) {
  if (!isPlainObject(env)) return false;
  if (typeof env.thread_id !== "string" || env.thread_id.length === 0) return false;
  if (typeof env.ts !== "number" || !Number.isInteger(env.ts) || env.ts <= 0) return false;
  if (!isPlainObject(env.sender)) return false;
  if (typeof env.sender.id !== "string" || env.sender.id.length === 0) return false;
  return true;
}

// is_from_me is a strict boolean on a valid N1 envelope; coerce defensively.
// Anything that is not strictly true is treated as inbound (the conservative
// reading for "they are waiting on me" — an ambiguous row counts as theirs).
function isFromMe(env) {
  return env && env.is_from_me === true;
}

// Read the sender's KIND as DATA (N11, A2). Absent => "person" (backward-compat:
// an old envelope with no kind is a person). This is the ONLY thing the engine
// needs to exclude bot/service/system senders — there is NO platform branch here;
// the adapter already encoded the kind, and we merely read the agnostic field.
function senderKind(env) {
  const k = env && env.sender && env.sender.kind;
  return k === "bot" || k === "service" || k === "system" ? k : "person";
}

// An INBOUND envelope counts toward "they are waiting on me" only when its sender
// is a person. A service/bot/system inbound message (a login code, a broadcast)
// never "puts the ball in my court" — it is excluded as DATA. Outbound (mine)
// envelopes are always kept (they answer the thread regardless of kind).
function isExcludedInbound(env) {
  return !isFromMe(env) && senderKind(env) !== "person";
}

// Inbound = NOT from me (the falsy-is_from_me partition).
function isInbound(env) {
  return !isFromMe(env);
}

// Resolve the effective sort key for an envelope: ts is the primary key; the
// tie-break is source_msg_id (string compare) then thread-internal nothing —
// deterministic across platforms when two messages share a ts (the A9 case).
function tieBreakKey(env) {
  return typeof env.source_msg_id === "string" ? env.source_msg_id : "";
}

// Stable ascending comparator: ts asc, then source_msg_id asc. Deterministic.
function compareEnvelopes(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  const ka = tieBreakKey(a);
  const kb = tieBreakKey(b);
  if (ka < kb) return -1;
  if (ka > kb) return 1;
  return 0;
}

// Shallow-clone an envelope so downstream annotation never touches the input
// object (Thesis #1 / R2 mutation guard). We never WRITE to these clones in the
// current projection, but cloning at the group boundary makes the no-mutation
// guarantee structural rather than incidental.
function cloneEnvelope(env) {
  return { ...env };
}

// ---------------------------------------------------------------------------
// groupThreads — partition envelopes into threads, each sorted ascending by ts.
//
// Grouping key: by default the raw thread_id (per-platform thread). When an
// injected resolvePerson yields a stable person-id AND the thread is a DM, the
// thread is RE-KEYED on the person so the same person's 1:1 conversation across
// platforms dedups into ONE thread (the N7 SOFT edge). Group/channel threads are
// NEVER person-merged (many participants; thread_id is the identity). With the
// identity stub (resolvePerson = s => s.id) this reduces to per-thread keys.
// ---------------------------------------------------------------------------

/**
 * @param {Array} envelopes
 * @param {{resolvePerson?: (sender:object)=>string}} [opts]
 * @returns {Map<string, Array>} threadKey -> sorted Envelope[] (clones)
 */
export function groupThreads(envelopes, opts = {}) {
  if (!Array.isArray(envelopes)) {
    throw new TypeError(
      `groupThreads: expected an array of envelopes, got ${typeof envelopes}`,
    );
  }
  const resolvePerson = typeof opts.resolvePerson === "function"
    ? opts.resolvePerson
    : (s) => (s && typeof s.id === "string" ? s.id : null);

  // Pass 1 — keep only usable envelopes (clones) and, for each DM thread_id,
  // establish the COUNTERPARTY person-key from its inbound (!is_from_me)
  // senders. A DM's identity is the conversation partner, NOT the per-message
  // sender: my own OUTBOUND message in a DM has sender.id="user" and must NOT
  // split the thread into a separate "me" group. We therefore derive ONE
  // person-key per DM thread_id (from whoever they are) and route ALL messages
  // of that thread_id — mine and theirs — to it. Two different thread_ids that
  // resolve to the SAME counterparty person then collapse into one group
  // (cross-platform DM dedup; the N7 SOFT edge). With the identity stub
  // (resolvePerson = s => s.id) distinct counterparties keep distinct keys.
  const usable = [];
  const dmCounterpartyKey = new Map(); // thread_id -> personId (counterparty)
  for (const raw of envelopes) {
    if (!isUsableEnvelope(raw)) {
      _telemetry.skipped += 1;
      continue;
    }
    // N11 (A2): an inbound message from a non-person sender (bot/service/system)
    // never counts toward "they are waiting on me". Excluded here as DATA — the
    // adapter stamped sender.kind; we read it, never a platform name. My own
    // outbound messages are always kept (they still answer a thread).
    if (isExcludedInbound(raw)) {
      _telemetry.excluded_nonperson += 1;
      continue;
    }
    const env = cloneEnvelope(raw);
    usable.push(env);
    if (env.thread_type === "dm" && !isFromMe(env)) {
      let pid = null;
      try {
        const r = resolvePerson(env.sender);
        if (typeof r === "string" && r.length > 0) pid = r;
      } catch {
        pid = null;
      }
      // First inbound sender wins per thread_id (deterministic; a DM has one
      // counterparty). A later differing inbound id would be anomalous; we do
      // not overwrite so the key is stable across the pass.
      if (pid && !dmCounterpartyKey.has(env.thread_id)) {
        dmCounterpartyKey.set(env.thread_id, pid);
      }
    }
  }

  // Pass 2 — assign each usable envelope to its group key.
  const groups = new Map();
  for (const env of usable) {
    // Cross-platform DM dedup ONLY when the thread is a 1:1 DM AND we resolved a
    // counterparty person-key for its thread_id. Otherwise key on the raw
    // thread_id (per-platform thread identity — groups/channels always).
    const counterparty = env.thread_type === "dm"
      ? dmCounterpartyKey.get(env.thread_id)
      : null;
    const key = counterparty
      ? `person:${counterparty}`
      : `thread:${env.thread_id}`;

    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(env);
  }

  // Sort each thread ascending (ts, then source_msg_id) — deterministic.
  for (const bucket of groups.values()) {
    bucket.sort(compareEnvelopes);
  }
  _telemetry.threads += groups.size;
  return groups;
}

// ---------------------------------------------------------------------------
// reciprocityOfThread — the FIRST PERSONA ATTRIBUTE (P2). A relationship is
// TWO-WAY: have you EVER reciprocated in this thread? Computed purely from
// envelope.is_from_me over the thread's Envelope[] (the same DATA the attention
// gate already reads) — ZERO platform tokens, ZERO new source. It distinguishes
// a genuine two-way relationship from a one-directional channel (spam that looks
// human, cold outreach, automated notifications structurally shaped like a
// person) that P1's STRUCTURAL gate cannot catch.
//
// Shape: { reciprocated, outbound_count, inbound_count, turn_count,
//          last_outbound_ts }
//   - reciprocated  : true iff >=1 outbound (is_from_me === true) EVER in thread.
//   - outbound_count: count of is_from_me === true envelopes.
//   - inbound_count : count of inbound (NOT is_from_me) envelopes.
//   - turn_count    : count of DIRECTION TRANSITIONS walking the thread in
//                     ts-order (inbound->outbound or outbound->inbound). A pure
//                     monologue (all inbound, or all outbound) has 0 turns; a
//                     single back-and-forth has 1; a real conversation has many.
//                     This is the "strength" of the relationship (how many
//                     genuine exchanges), distinct from mere presence of a reply.
//   - last_outbound_ts: ts of the most-recent outbound (recency of YOUR last
//                     reciprocation), or null if you never replied.
//
// CONSERVATIVE: this is a read-only SIGNAL. The catch-up surface (L5) folds it in
// as a SOFT down-rank factor and NEVER hard-drops a zero-reciprocity thread — a
// genuine brand-new contact (0 reciprocity, first message) still appears, lower.
// ---------------------------------------------------------------------------

/**
 * @param {Array} threadEnvelopes  sorted ascending by ts (as groupThreads emits)
 * @returns {{reciprocated:boolean, outbound_count:number, inbound_count:number, turn_count:number, last_outbound_ts:(number|null)}}
 */
export function reciprocityOfThread(threadEnvelopes) {
  if (!Array.isArray(threadEnvelopes) || threadEnvelopes.length === 0) {
    return {
      reciprocated: false,
      outbound_count: 0,
      inbound_count: 0,
      turn_count: 0,
      last_outbound_ts: null,
    };
  }
  let outbound = 0;
  let inbound = 0;
  let turns = 0;
  let lastOutboundTs = null;
  let prevFromMe = null; // direction of the previous (ts-earlier) message
  for (const env of threadEnvelopes) {
    const fromMe = isFromMe(env);
    if (fromMe) {
      outbound += 1;
      if (typeof env.ts === "number" && Number.isFinite(env.ts)) {
        // thread is ts-ascending, so the LAST outbound seen is the most recent.
        lastOutboundTs = env.ts;
      }
    } else {
      inbound += 1;
    }
    // A direction transition (inbound<->outbound) is one conversational turn.
    if (prevFromMe !== null && prevFromMe !== fromMe) turns += 1;
    prevFromMe = fromMe;
  }
  return {
    reciprocated: outbound > 0,
    outbound_count: outbound,
    inbound_count: inbound,
    turn_count: turns,
    last_outbound_ts: lastOutboundTs,
  };
}

// ---------------------------------------------------------------------------
// isUnanswered — they-spoke-last. True iff the last (max-ts) envelope is inbound
// (is_from_me falsy). A thread where I spoke last is answered (false); an empty
// thread is defensively false (nothing to answer).
// ---------------------------------------------------------------------------

/**
 * @param {Array} threadEnvelopes  sorted ascending by ts (as groupThreads emits)
 * @returns {boolean}
 */
export function isUnanswered(threadEnvelopes) {
  if (!Array.isArray(threadEnvelopes) || threadEnvelopes.length === 0) return false;
  const last = threadEnvelopes[threadEnvelopes.length - 1];
  return isInbound(last);
}

// ---------------------------------------------------------------------------
// staleness — age of the last message + its bucket. now is INJECTED so this is
// deterministic. Returns { ms, bucket }. ms can be negative if now precedes the
// last ts (clock skew); the bucket clamps to "fresh" in that case (age < 1h).
// ---------------------------------------------------------------------------

/**
 * @param {Array} threadEnvelopes  sorted ascending by ts
 * @param {number} now             epoch ms (injected)
 * @param {Array<{name:string,maxMs:number}>} [buckets]
 * @returns {{ms:number, bucket:string}}
 */
export function staleness(threadEnvelopes, now, buckets = ATTENTION_CAPS.STALENESS_BUCKETS) {
  if (!Array.isArray(threadEnvelopes) || threadEnvelopes.length === 0) {
    return { ms: 0, bucket: bucketForAge(0, buckets) };
  }
  const last = threadEnvelopes[threadEnvelopes.length - 1];
  const lastTs = typeof last.ts === "number" && Number.isFinite(last.ts) ? last.ts : now;
  const ms = now - lastTs;
  return { ms, bucket: bucketForAge(ms, buckets) };
}

// Map an age (ms) to a bucket name. Monotone: a larger age never maps to an
// earlier bucket (the A6 invariant). The first bucket whose maxMs strictly
// exceeds the age wins; past the last bound it is the terminal bucket.
function bucketForAge(ms, buckets) {
  const list = Array.isArray(buckets) ? buckets : ATTENTION_CAPS.STALENESS_BUCKETS;
  const age = Number.isFinite(ms) ? ms : 0;
  for (const b of list) {
    if (b && typeof b.maxMs === "number" && age < b.maxMs) return b.name;
  }
  return ATTENTION_CAPS.STALENESS_TERMINAL_BUCKET;
}

// ---------------------------------------------------------------------------
// Trailing-inbound-run extraction. The "run" is the maximal contiguous suffix of
// inbound messages at the END of the (ts-sorted) thread. It is the unit the
// substance + directed gates operate on: only the LAST uninterrupted thing they
// said matters for "are they waiting on me right now". As soon as an is_from_me
// message is hit walking backwards, the run stops (I already replied to anything
// before it). Order is preserved (ascending ts) so the LAST substantive message
// in the run wins (the A4b ordering case).
// ---------------------------------------------------------------------------

function trailingInboundRun(threadEnvelopes) {
  if (!Array.isArray(threadEnvelopes) || threadEnvelopes.length === 0) return [];
  const run = [];
  for (let i = threadEnvelopes.length - 1; i >= 0; i -= 1) {
    const env = threadEnvelopes[i];
    if (isInbound(env)) run.push(env);
    else break;
  }
  run.reverse(); // restore ascending-ts order
  return run;
}

// Word-token count of a string (lexicon-agnostic; just whitespace words over
// the letter-stripped form, matching the valence tokenizer's spirit).
function wordTokens(text) {
  if (typeof text !== "string") return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s?]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// Does the text carry actionable content? A literal "?" OR any ASK_TOKENS hit.
function hasActionableContent(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  if (text.includes("?")) return true;
  for (const t of wordTokens(text)) {
    // strip a trailing '?' token artifact so "deck?" matches "deck"
    const bare = t.replace(/\?+$/g, "");
    if (ASK_TOKENS.has(bare)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// substanceOfLastInboundRun — the closer discriminator.
//
// Concatenate the trailing inbound run's content and decide whether it carries
// real substance or is a closer-only tail. Returns { score in [0,1], isCloser,
// text, valence_magnitude, ep }.
//
// The composite rule (see THE SUBSTANCE TRAP at the top of the file):
//   - actionable content present (a "?" or an ask/request token) -> SUBSTANTIVE
//     (score 1), regardless of valence. This is the case the naive
//     valence-magnitude proxy gets BACKWARDS.
//   - else, a LONG run (>= LONG_TOKEN_MIN tokens) -> SUBSTANTIVE (people don't
//     write paragraph closers).
//   - else, a SHORT run (<= SHORT_TOKEN_MAX tokens) with no actionable content
//     -> CLOSER (score 0). This captures BOTH closer shapes: positive
//     interjections ("ah cool!", high valence) AND pure stopword/emoji/empty
//     ("👍", "", "ok") which the valence scorer collapses to magnitude 0.
//   - the mid-length, non-actionable band interpolates: score = 0.5 at the
//     SHORT_TOKEN_MAX boundary rising toward 1 at LONG_TOKEN_MIN, so a 5-7 token
//     statement (no question) reads as borderline-substantive rather than a
//     hard closer.
// EP_WEIGHT (default 0) optionally blends a synthesized-episodicity nudge; left
// at 0 so the primary rule is the sole discriminator (documented in N8.md).
// ---------------------------------------------------------------------------

/**
 * @param {Array} threadEnvelopes  sorted ascending by ts
 * @param {{substanceFloor?:number}} [opts]
 * @returns {{score:number, isCloser:boolean, text:string, valence_magnitude:number, ep:number, n_tokens:number}}
 */
export function substanceOfLastInboundRun(threadEnvelopes, opts = {}) {
  const floor = typeof opts.substanceFloor === "number"
    ? opts.substanceFloor
    : ATTENTION_CAPS.SUBSTANCE_FLOOR;

  const run = trailingInboundRun(threadEnvelopes);
  const text = run
    .map((e) => (typeof e.content === "string" ? e.content : ""))
    .join(" ")
    .trim();

  const tokens = wordTokens(text);
  const nTokens = tokens.length;

  // Valence magnitude — used only to DOCUMENT the positive-closer arm; the
  // composite rule does not invert on it (see THE SUBSTANCE TRAP).
  let valenceMag = 0;
  try {
    valenceMag = scoreValence(text).magnitude;
  } catch {
    valenceMag = 0;
  }

  // Optional synthesized-episodicity nudge (MAP-2: no features block on a raw
  // envelope, so we synthesize the four sigmoid inputs from the run shape).
  let ep = 0.5;
  if (ATTENTION_CAPS.EP_WEIGHT > 0) {
    try {
      ep = scoreEpisodicity({
        has_time_anchor: false,
        corroboration_count: Math.max(0, run.length - 1),
        entity_generality: 0.5,
        narrative_valence_magnitude: valenceMag,
      });
    } catch {
      ep = 0.5;
    }
  }

  let baseScore;
  if (nTokens === 0) {
    // Empty/whitespace/emoji-only trailing run -> a closer (non-substantive).
    baseScore = 0;
  } else if (hasActionableContent(text)) {
    baseScore = 1;
  } else if (nTokens >= ATTENTION_CAPS.LONG_TOKEN_MIN) {
    baseScore = 1;
  } else if (nTokens <= ATTENTION_CAPS.SHORT_TOKEN_MAX) {
    baseScore = 0;
  } else {
    // mid-length, non-actionable: interpolate 0.5..1 over (SHORT_MAX, LONG_MIN).
    const span = ATTENTION_CAPS.LONG_TOKEN_MIN - ATTENTION_CAPS.SHORT_TOKEN_MAX;
    const frac = span > 0
      ? (nTokens - ATTENTION_CAPS.SHORT_TOKEN_MAX) / span
      : 1;
    baseScore = 0.5 + 0.5 * Math.max(0, Math.min(1, frac));
  }

  // Blend the (optional) episodicity nudge. With EP_WEIGHT=0 score===baseScore.
  let score = (1 - ATTENTION_CAPS.EP_WEIGHT) * baseScore + ATTENTION_CAPS.EP_WEIGHT * ep;
  if (!Number.isFinite(score)) score = 0;
  if (score < 0) score = 0;
  if (score > 1) score = 1;

  const isCloser = score <= floor;
  return { score, isCloser, text, valence_magnitude: valenceMag, ep, n_tokens: nTokens };
}

// ---------------------------------------------------------------------------
// directedGate — at least one message in the trailing inbound run scores as
// directed-at-me per the injected N2 classifier (score >= threshold). In a 1:1
// DM the DM prior makes this trivially true; in a group it filters undirected
// chatter. The classifier is injected so N8 stays decoupled and tests can stub.
// ---------------------------------------------------------------------------

/**
 * @param {Array} threadEnvelopes  sorted ascending by ts
 * @param {(env:object)=>{score:number}} [classify]  N2 classifier (injected)
 * @param {{directedThreshold?:number}} [opts]
 * @returns {boolean}
 */
export function directedGate(threadEnvelopes, classify = classifyDirectedAtMe, opts = {}) {
  const threshold = typeof opts.directedThreshold === "number"
    ? opts.directedThreshold
    : ATTENTION_CAPS.DIRECTED_THRESHOLD;
  const run = trailingInboundRun(threadEnvelopes);
  if (run.length === 0) return false;
  const fn = typeof classify === "function" ? classify : classifyDirectedAtMe;
  for (const env of run) {
    let res;
    try {
      res = fn(env);
    } catch {
      res = null;
    }
    const score = res && typeof res.score === "number" && Number.isFinite(res.score)
      ? res.score
      : 0;
    if (score >= threshold) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// computeAttention — the JOIN. Group -> per-thread record. surface = unanswered
// && directed && !substance.isCloser. Pure; now injected; inputs never mutated.
// ---------------------------------------------------------------------------

/**
 * @param {Array} envelopes
 * @param {{
 *   now?: number,
 *   resolvePerson?: (sender:object)=>string,
 *   classify?: (env:object)=>{score:number},
 *   substanceFloor?: number,
 *   stalenessBuckets?: Array<{name:string,maxMs:number}>,
 *   directedThreshold?: number,
 * }} [opts]
 * @returns {Array} AttentionRecord[]
 */
export function computeAttention(envelopes, opts = {}) {
  if (!Array.isArray(envelopes)) {
    throw new TypeError(
      `computeAttention: expected an array of envelopes, got ${typeof envelopes}`,
    );
  }
  const now = typeof opts.now === "number" && Number.isFinite(opts.now)
    ? opts.now
    : Date.now();
  const resolvePerson = typeof opts.resolvePerson === "function"
    ? opts.resolvePerson
    : (s) => (s && typeof s.id === "string" ? s.id : null);
  const classify = typeof opts.classify === "function"
    ? opts.classify
    : classifyDirectedAtMe;
  const buckets = Array.isArray(opts.stalenessBuckets)
    ? opts.stalenessBuckets
    : ATTENTION_CAPS.STALENESS_BUCKETS;
  const substanceOpts = { substanceFloor: opts.substanceFloor };
  const directedOpts = { directedThreshold: opts.directedThreshold };

  const groups = groupThreads(envelopes, { resolvePerson });

  const records = [];
  for (const [threadKey, thread] of groups.entries()) {
    if (thread.length === 0) continue; // impossible post-group; defensive.

    const last = thread[thread.length - 1];
    const unanswered = isUnanswered(thread);
    const stale = staleness(thread, now, buckets);
    const substance = substanceOfLastInboundRun(thread, substanceOpts);
    const directed = directedGate(thread, classify, directedOpts);
    const run = trailingInboundRun(thread);
    // P2 — the FIRST PERSONA ATTRIBUTE: have you ever reciprocated in this
    // thread? Computed over the WHOLE thread (not just the trailing run) from
    // is_from_me DATA. A read-only signal the catch-up surface (L5) folds into
    // its rank as a SOFT down-rank; never a hard drop here.
    const reciprocity = reciprocityOfThread(thread);

    const surface = unanswered && directed && !substance.isCloser;

    // person_id: re-resolve from the last sender (defensive); null on failure.
    let personId = null;
    try {
      const pid = resolvePerson(last.sender);
      if (typeof pid === "string" && pid.length > 0) personId = pid;
    } catch {
      personId = null;
    }

    if (surface) _telemetry.surfaced += 1;
    if (unanswered && directed && substance.isCloser) _telemetry.closer_dropped += 1;

    records.push({
      thread_key: threadKey,
      thread_id: last.thread_id,
      thread_type: typeof last.thread_type === "string" ? last.thread_type : null,
      person_id: personId,
      unanswered,
      directed,
      staleness: { ms: stale.ms, bucket: stale.bucket },
      substance: { score: substance.score, isCloser: substance.isCloser },
      // P2 — reciprocity (the first persona attribute), surfaced on the record.
      reciprocity: {
        reciprocated: reciprocity.reciprocated,
        outbound_count: reciprocity.outbound_count,
        inbound_count: reciprocity.inbound_count,
        turn_count: reciprocity.turn_count,
        last_outbound_ts: reciprocity.last_outbound_ts,
      },
      surface,
      last_ts: last.ts,
      last_sender: {
        id: last.sender && typeof last.sender.id === "string" ? last.sender.id : null,
        name: last.sender && (typeof last.sender.name === "string" || last.sender.name === null)
          ? last.sender.name
          : null,
      },
      n_inbound_trailing: run.length,
      source_msg_ids: run.map((e) => (typeof e.source_msg_id === "string" ? e.source_msg_id : null)),
      model_version: MODEL_VERSION,
    });
  }

  // Deterministic record ordering: most-stale-unanswered first is a ranking
  // concern downstream; here we sort by thread_key for byte-stable JSON (the A8
  // determinism invariant). The caller (N9) re-ranks by staleness as needed.
  records.sort((a, b) => (a.thread_key < b.thread_key ? -1 : a.thread_key > b.thread_key ? 1 : 0));
  return records;
}
