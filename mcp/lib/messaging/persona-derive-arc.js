// persona-derive-arc.js — the ARC facet deriver (RECENT-arc scout).
//
// A PURE, read-only projection: deriveArc(thread, {now}) -> the bare arc facet
//
//     arc { last_ts: number|null, gist: string, trend: <enum> }
//
// computed from ONE person's ts-ascending thread envelopes. It answers "what is
// the shape of the recent back-and-forth with this person right now":
//   - last_ts : the most-recent PLAUSIBLE inbound (!is_from_me) timestamp, the
//               recency anchor, clamped through plausibleTs so a corrupt ~epoch-0
//               row can never floor a real contact's recency (outbound ts ignored).
//   - gist    : a short STRUCTURAL summary of the latest substantive inbound run
//               ('closer' / 'quiet' / a <=GIST_TOKEN_MAX leading-word slice).
//   - trend   : the direction of the inter-inbound cadence, read from consecutive
//               gaps (accelerating / steady / cooling), plus the two endpoint
//               buckets (new / dormant).
//
// TREND ENUM: { new, accelerating, steady, cooling, dormant }.
//   The four cadence/dormancy values are the original contract. 'new' is an
//   EXPLICIT extension for a brand-new FIRST CONTACT: a single, recent,
//   UN-reciprocated inbound (a fresh cold open) — the prior enum had no faithful
//   bucket for "they just reached out for the first time and I have not replied".
//   It is distinct from 'dormant' (a stale / aged-out / sub-threshold history).
//
// REUSE, NOT DUPLICATE — this module owns NO closer detection, NO tokenization,
// NO staleness math, and NO timestamp-plausibility. It consumes:
//   - substanceOfLastInboundRun .. lib/messaging/attention.js (closer + tail text)
//   - staleness ................... lib/messaging/attention.js (last-inbound age)
//   - plausibleTs / MIN_PLAUSIBLE_TS_MS  lib/messaging/catchup.js (ts clamp + floor)
//   - NEUTRAL_PERSONA ............. lib/messaging/persona.js (the arc slice shape)
// It returns the BARE arc facet (it does NOT wrap in normalizePersona), mirroring
// the way deriveTopics returns a bare string[]; the persona-resolver folds it in.
//
// HARD CONSTRAINTS (non-negotiable, mirroring the sibling derivers):
//   - PURE / READ-ONLY / TOTAL / DETERMINISTIC: no I/O, no persistence, never
//     throws on odd / empty / non-array input, same input => deep-equal output.
//   - NON-MUTATING: input envelopes (especially .ts) are NEVER written; every
//     working structure is built fresh.
//   - ZERO platform tokens: envelope fields (.ts, .is_from_me, .content) are read
//     as OPAQUE DATA. This module names no platform and branches on no source.
//   - now is INJECTED (opts.now finite else Date.now()) so staleness / trend are
//     deterministic under test.
//   - REUSE-not-duplicate: it imports the closer / staleness / plausibility logic
//     and edits none of attention.js, catchup.js, or persona.js.

import { substanceOfLastInboundRun, staleness } from "./attention.js";
import { plausibleTs, MIN_PLAUSIBLE_TS_MS } from "./catchup.js";
import { NEUTRAL_PERSONA } from "./persona.js";

// ---------------------------------------------------------------------------
// CAPS — the single, frozen source of every threshold (all numeric control is
// DATA; no magic number lives in a function body), mirroring persona.js and the
// sibling derivers' PERSONA_CAPS discipline.
// ---------------------------------------------------------------------------
const CAPS = Object.freeze({
  // Max whitespace tokens kept in a substantive gist (the leading-word slice).
  GIST_TOKEN_MAX: 12,
  // Minimum plausible-inbound count before an inter-message cadence can be read;
  // below it the arc is an endpoint bucket (new / dormant), not a trend.
  MIN_INBOUND_FOR_TREND: 2,
  // Dormancy age cutoff: a last-inbound older than this reads as gone-quiet. This
  // REUSES the 7-day scale of attention.js's terminal "stale" staleness bucket.
  DORMANCY_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
  // Gap-ratio tolerance band (most-recent gap / mean of the earlier gaps):
  //   ratio <= SHRINK_RATIO -> the spacing is tightening  -> accelerating
  //   ratio >= GROW_RATIO   -> the spacing is widening     -> cooling
  //   in-band               -> the spacing holds           -> steady
  SHRINK_RATIO: 0.8,
  GROW_RATIO: 1.2,
});

// Trend vocabulary — the closed output enum (single producer; bodies branch on
// these names, never on bare string literals).
const TREND = Object.freeze({
  NEW: "new",
  ACCELERATING: "accelerating",
  STEADY: "steady",
  COOLING: "cooling",
  DORMANT: "dormant",
});

// Structural gist sentinels for the two non-prose tail shapes.
const GIST_CLOSER = "closer"; // a non-empty closer-only trailing inbound run
const GIST_QUIET = "quiet"; // an empty / whitespace / media-only trailing run

// The arc slice's key set, taken FROM the persona contract so this bare facet can
// never drift from persona.js's arc shape. (Order: last_ts, gist, trend.)
const ARC_KEYS = Object.freeze(Object.keys(NEUTRAL_PERSONA.arc));

// ---------------------------------------------------------------------------
// Defensive helpers (total over odd input; never throw). Mirror the siblings.
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Assemble a fresh, frozen arc facet projected onto EXACTLY the contract's arc
// key set. Building from ARC_KEYS keeps the shape locked to persona.js's slice.
function makeArc(last_ts, gist, trend) {
  const values = { last_ts, gist, trend };
  const out = {};
  for (const k of ARC_KEYS) out[k] = values[k];
  return Object.freeze(out);
}

// The neutral default returned on the TOTAL guard. A fresh frozen copy each call
// (scalars only, so a fresh build is deep-equal to the frozen reference below).
function neutralArc() {
  return makeArc(null, "", TREND.DORMANT);
}

// Frozen reference neutral default ({ last_ts:null, gist:'', trend:'dormant' }),
// exported for tests and downstream wiring. NOTE: trend:'dormant' is a POPULATED
// value, so the neutral arc is NOT merge-neutral — the resolver decides whether
// an empty-thread arc is suppressed to null.
const NEUTRAL_ARC = neutralArc();

// ---------------------------------------------------------------------------
// gist — a short structural summary of the latest substantive inbound run. The
// closer / tail-text discrimination is REUSED wholesale from attention.js; this
// only labels the two non-prose shapes and slices the leading words of prose.
// gist is ALWAYS a string.
// ---------------------------------------------------------------------------
function deriveGist(thread) {
  const { isCloser, text } = substanceOfLastInboundRun(thread);
  const trimmed = typeof text === "string" ? text.trim() : "";
  // Empty / whitespace / media-only trailing inbound run (or none at all): quiet.
  if (trimmed.length === 0) return GIST_QUIET;
  // A non-empty closer-only tail (e.g. "ok thanks 👍"): the closer sentinel.
  if (isCloser) return GIST_CLOSER;
  // Substantive prose: the leading <=GIST_TOKEN_MAX whitespace tokens.
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
  return tokens.slice(0, CAPS.GIST_TOKEN_MAX).join(" ");
}

// ---------------------------------------------------------------------------
// trend — the direction of the inter-inbound cadence. Always one of the 5-enum.
//   inboundTs    : the ascending list of plausible-inbound timestamps.
//   inboundEnvs  : the matching ascending envelopes (for the staleness age read).
//   hasOutbound  : whether ANY outbound (is_from_me === true) exists (reciprocity).
// ---------------------------------------------------------------------------
function deriveTrend(inboundTs, inboundEnvs, hasOutbound, now) {
  const n = inboundTs.length;
  if (n === 0) return TREND.DORMANT;

  // Last-inbound age via the REUSED staleness reading over the inbound-only run.
  // The envelopes are ascending, so staleness reads the latest one: ms = now -
  // last_ts (the same plausible ts that anchors last_ts, so the two never drift).
  const age = staleness(inboundEnvs, now).ms;
  const recent = age <= CAPS.DORMANCY_WINDOW_MS;

  // Endpoint bucket: too few inbound to read a cadence.
  if (n < CAPS.MIN_INBOUND_FOR_TREND) {
    // FIRST CONTACT: a single, recent, UN-reciprocated inbound (a fresh cold open).
    if (!hasOutbound && recent) return TREND.NEW;
    return TREND.DORMANT;
  }

  // Enough inbound, but the last one has aged out beyond the dormancy window.
  if (!recent) return TREND.DORMANT;

  // Consecutive inter-inbound gaps (n-1 of them) over the ascending timestamps.
  const gaps = [];
  for (let i = 1; i < n; i += 1) gaps.push(inboundTs[i] - inboundTs[i - 1]);
  const g = gaps.length;
  // A single interval carries no acceleration / deceleration evidence: steady.
  if (g < 2) return TREND.STEADY;

  // Compare the most-recent gap to the mean of the earlier gaps via the band.
  const recentGap = gaps[g - 1];
  let earlierSum = 0;
  for (let i = 0; i < g - 1; i += 1) earlierSum += gaps[i];
  const earlierRef = earlierSum / (g - 1);
  if (!(earlierRef > 0) || !Number.isFinite(recentGap)) return TREND.STEADY;

  const ratio = recentGap / earlierRef;
  if (ratio <= CAPS.SHRINK_RATIO) return TREND.ACCELERATING; // gaps tightening
  if (ratio >= CAPS.GROW_RATIO) return TREND.COOLING; // gaps widening
  return TREND.STEADY; // spacing holds
}

/**
 * deriveArc(thread, opts) -> the bare arc facet { last_ts, gist, trend }.
 *
 * PURE deriver of the persona.arc facet from a person's ts-ascending thread:
 *   - last_ts : max plausibleTs-clamped INBOUND (!is_from_me) ts, else null
 *               (outbound ts and ts < MIN_PLAUSIBLE_TS_MS are excluded).
 *   - gist    : the structural summary of the latest substantive inbound run.
 *   - trend   : the inter-inbound cadence direction (5-enum).
 *
 * @param {Array} thread  ts-ascending envelopes for ONE person.
 * @param {{now?:number}} [opts]  now is injected (finite) else Date.now().
 * @returns {{last_ts:number|null, gist:string, trend:string}} frozen bare facet.
 *
 * TOTAL: a non-array, empty, or structurally-empty thread degrades to the neutral
 * default { last_ts:null, gist:'', trend:'dormant' }. Never throws. Never mutates.
 * Same input => deep-equal output.
 */
export function deriveArc(thread, opts = {}) {
  // now is INJECTED for determinism; a non-finite / missing now falls back to wall clock.
  const safeOpts = opts && typeof opts === "object" ? opts : {};
  const now = Number.isFinite(safeOpts.now) ? safeOpts.now : Date.now();

  // TOTAL guard: a non-array, or an array carrying no structured envelope at all
  // (empty / junk-only), is "no data" and yields the byte-neutral default.
  if (!Array.isArray(thread) || !thread.some(isPlainObject)) {
    return neutralArc();
  }

  // Build, fresh, the ascending list of plausible-inbound { env, ts } pairs and
  // note whether ANY outbound exists (reciprocity). plausibleTs is REUSED to clamp
  // a corrupt / epoch-0 ts to null so it can never anchor recency.
  const inbound = [];
  let hasOutbound = false;
  for (const env of thread) {
    if (!isPlainObject(env)) continue;
    if (env.is_from_me === true) {
      hasOutbound = true;
      continue; // outbound ts is never a recency anchor
    }
    const ts = plausibleTs(env.ts, now);
    if (ts === null) continue;
    inbound.push({ env, ts });
  }
  inbound.sort((a, b) => a.ts - b.ts); // ascending by clamped ts (deterministic)

  const inboundTs = inbound.map((p) => p.ts);
  const inboundEnvs = inbound.map((p) => p.env);

  // last_ts: the maximum plausible-inbound ts (the ascending tail), else null.
  const last_ts = inboundTs.length > 0 ? inboundTs[inboundTs.length - 1] : null;

  const gist = deriveGist(thread);
  const trend = deriveTrend(inboundTs, inboundEnvs, hasOutbound, now);

  return makeArc(last_ts, gist, trend);
}

export default deriveArc;

// Test-only views: the frozen thresholds (bodies branch on CAPS, never literals)
// and the frozen neutral default.
export const _capsForTest = CAPS;
export { NEUTRAL_ARC };

// Re-export the REUSED recency floor so the arc's plausibility boundary has one
// canonical name (callers / tests need not also reach into catchup.js for it).
export { MIN_PLAUSIBLE_TS_MS };
