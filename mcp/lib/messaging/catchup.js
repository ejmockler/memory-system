// catchup.js — WORKUNIT N9, the CATCH-UP surface (Layer 5) and its MCP tool.
//
// Fuses the three platform-agnostic engines — addressing (N2 classifier),
// identity (N7 person resolver), attention (N8 response-state) — into ONE
// unified, RANKED, DEDUPED "waiting on you" list spanning every platform, and
// exposes it as the `memory_catchup` MCP tool.
//
// It answers the mission question directly: WHO is waiting on me, and WHERE.
//
// THE ABSTRACTION INVARIANT (the live proof this node owns, restated at the TOP
// of the stack): this file contains ZERO platform-name branches. It NEVER
// compares the platform field against any platform-name string literal. Instead
// it loops a generic ADAPTER REGISTRY — a
// Map<platform, {toEnvelope, ledgerPath}> built by importing each L1 adapter and
// reading the adapter's OWN `PLATFORM` constant as DATA. Adding Slack/Signal is
// ONE new registry import; not a single line in the loop, the rank, or the dedup
// changes. A grep for any platform token over this file returns 0 matches; that
// is the half of N10's gate this node carries (TOPOLOGY.md:52). Platform identity
// reaches this surface ONLY as the envelope's `platform` DATA field, carried
// through from L1 and surfaced for display — never as control flow.
//
// THESIS #1 (READ-ONLY DERIVED PROJECTION joined at query time): catch-up is a
// transient JOIN over source-derived `Envelope[]` + the engine outputs. It reads
// retained source-ledger rows through the adapters (which are themselves pure,
// read-only mappers) and emits an EPHEMERAL ranked list. It writes NO source row,
// NO fact row, NO engine store. The ranked ANSWER is never persisted; C1 persists
// only derived, regenerable PARSE projections (envelope-projection.js) off the
// critical path — `buildCatchup` itself does no fs WRITE.
//
// DAEMON OFF: pure compute over injected rows; no network, no live DB read in the
// gate path. The wave's tests feed the registry a fixture corpus loader.
//
// LAYERING: N9 does NOT edit envelope.js (N1), classifier.js (N2), identity.js
// (N7), or attention.js (N8). It only CONSUMES their exports. `buildCatchupCore`
// takes the three engines as INJECTED function params (so the core is pure and
// unit-testable against fakes); `buildCatchup` wires the REAL engines + the real
// adapter registry; the MCP `TOOL` is the thin wrapper.

import { join } from "node:path";

import { ok, serverTs } from "../envelope.js";
import { ERROR_CODES, ToolError } from "../error-codes.js";
import { MEMORY_ROOT } from "../config.js";
import { streamLedgerLines } from "../synthesis/_ledger-stream.js";
import {
  assertObjectShape,
  assertOptionalIntInRange,
  assertOptionalStringArray,
  assertNumberInRange,
} from "../validation.js";

import { computeAttention } from "./attention.js";
import { classifyDirectedAtMe } from "./classifier.js";
import { buildPersonIndex, lookup as personLookup } from "./identity.js";
// M1 — the injected, bounded, cached PERSON-ENRICHMENT resolver. anchorFactor is
// the MONOTONE up-rank multiplier in [NEUTRAL, MAX] (cold/unknown => 1.0 neutral,
// NEVER a hard-drop); makeNeutralEnricher is the DEFAULT (gate-OFF) resolver that
// returns anchor_factor=1.0 for every person, keeping ranking byte-identical.
// M5 — classifyTier/tierRank/TIER name the honest UNKNOWN/first-contact tier (a
// cold node is surfaced + labeled + ranked BELOW relationships, NEVER dropped);
// makeEnricherFromIndex builds the real resolver from a precomputed cached index.
import {
  anchorFactor,
  makeNeutralEnricher,
  makeEnricherFromIndex,
  classifyTier,
  tierRank,
  TIER,
} from "./person-enrichment.js";
// M2 (contacts-anchor) + M3 (feedback-log) — the W1 SOURCE modules M5 COMPOSES
// into the real enrichPerson resolver. Each is built ONCE (read-only, memoized /
// query-time projection), then queried O(1) per person in the rank loop. Both
// DEGRADE to neutral on any failure (no address book / no feedback log => empty
// index => is_contact=false / feedback_score=0 => ranking byte-identical).
import {
  buildContactAnchorIndex,
  makeContactsLookup,
} from "./contacts-anchor.js";
import {
  buildFeedbackIndexFromLog,
  lookupFeedbackScore,
} from "./feedback-log.js";
// e9 — the persona CONTRACT only (shape normalization + deep freeze). persona.js
// is a leaf module: it imports NOTHING, so this static import cannot form a cycle
// (unlike persona-resolver.js, which imports THIS file and is therefore loaded
// dynamically). Used at exactly one seat: the dedup head's tier promotion, where a
// frozen persona must be REPLACED rather than mutated.
import { normalizePersona } from "./persona.js";

// The L1 adapter modules, imported as an OPAQUE list from the adapter barrel.
// Each module exposes a PURE `_toEnvelope(row) -> Envelope` mapper and a
// `PLATFORM` string constant; we read their OWN identity off `PLATFORM` as DATA.
// The barrel is the ONE place that names concrete platform files — concentrating
// those imports there keeps THIS file token-free (the N10 grep gate). This file
// never writes a platform literal.
import { ADAPTER_MODULES } from "./adapters/registry.js";

// C1 — the checkpointed envelope-projection layer (cache the PARSE, not the
// answer). `tryServeSourceFromProjection` serves a source's bounded raw-row
// tail from a verified S1-checkpointed projection plus a delta fold of only the
// appended ledger bytes; `scheduleProjectionRebuild` rebuilds the projection
// best-effort AFTER a full-stream serve, off the critical path. The module is
// as platform-token-free as this file (source keys are registry DATA). The edge
// is ONE-WAY and gets nothing back: both files reach DOWN to the leaf
// ledger-retain.js instead of importing each other, so the messaging graph is a
// strict DAG and the module-eval TDZ the old cycle avoided only by convention is
// structurally impossible (rationale: that file's header; gate:
// test/messaging/no-static-import-cycles.test.mjs).
import {
  tryServeSourceFromProjection,
  scheduleProjectionRebuild,
} from "./envelope-projection.js";

// The retain primitive, from the leaf that owns it. `ledgerRetainCap` stays
// HERE — it is the one symbol of that cluster that reads
// CATCHUP_CAPS.DEFAULT_LIMIT, so the leaf needs no CAPS import.
import {
  LEDGER_RETAIN_CEILING,
  LEDGER_RETAIN_FLOOR,
  makeLedgerRetainFold,
} from "./ledger-retain.js";

// ---------------------------------------------------------------------------
// CATCHUP_CAPS — the single, frozen source of every magic number. Object.freeze
// enforces single-producer discipline; a nested freeze prevents weight mutation
// through a reference.
// ---------------------------------------------------------------------------
export const CATCHUP_CAPS = Object.freeze({
  // Default cap on returned rows when the caller passes no `limit`.
  DEFAULT_LIMIT: 50,
  // Hard ceiling the tool will accept for `limit` (defends the projection).
  MAX_LIMIT: 500,
  // Default directedness floor: a thread whose latest inbound classifier score
  // is below this is not "for me" enough to surface. Tunable per-call via
  // `min_score`. Set at N2's binary boundary so the default surfaces only
  // clearly-directed threads; lowering it widens the net.
  DEFAULT_MIN_SCORE: 0.5,
  // Staleness normalizer half-life (ms): the age at which stalenessFactor
  // reaches 0.5. One day.
  //
  // e17 — stalenessFactor IS NO LONGER A rankScore TERM. It used to multiply into
  // the score alongside recencyFactor, and the two read the SAME quantity (see the
  // block above rankScore), so the pair formed an undesigned band-pass: a
  // just-arrived directed message scored ~0 and a two-day-old one peaked. The
  // factor was DELETED from the product; nothing about the function changed and it
  // stays EXPORTED for the consumers that read it as a curve rather than as a rank
  // term — the e7 harness (which bisects this half-life to derive the saturation
  // age, and which scores time-term candidates from it), the e17 test itself
  // (which asserts the curve survived the deletion: still exported, still exactly
  // 0 at age 0, still monotone non-decreasing in [0,1)), and the factor cases in
  // n9-catchup.test.mjs / p2-reciprocity.test.mjs. attention.js does NOT read it:
  // its staleness BUCKETS are its own ATTENTION_CAPS data, and e17 did not touch
  // that file.
  STALENESS_HALFLIFE_MS: 24 * 60 * 60 * 1000,
  // Recency normalizer window (ms): newer last-inbound ranks higher within this
  // window. One week — beyond it recency contributes its floor.
  //
  // e17 — THIS IS NOW THE WHOLE TIME TERM. The sentence that used to stand here
  // ("Recency and staleness pull in opposite directions; together they privilege
  // 'recently arrived AND now sitting unanswered' over 'ancient and forgotten'")
  // described an intent the arithmetic did not have: because both factors read the
  // same age, "recently arrived" and "sitting unanswered" were not two conditions
  // being conjoined, they were one variable being multiplied against itself, and
  // the product ZEROED the freshest rows. rankScore now uses recencyFactor alone,
  // so the time term is monotone non-increasing in age with no interior peak.
  // NEITHER VALUE BELOW IS TUNED BY e17 — the window and the floor are exactly
  // what they were. Past the window the term is a CONSTANT, so the ts-desc
  // tiebreak rather than the score orders rows that have reached the floor.
  RECENCY_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
  RECENCY_FLOOR: 0.05,
  // DIVERSITY CAP (generic; NO platform-name branch). When one platform dominates
  // the ledger, a pure score sort can saturate the visible window with that single
  // platform before the truncation at `limit`, hiding every other platform's
  // waiting threads. To keep the surface representative, the final ordering is an
  // INTERLEAVE: rows are grouped by their `platform` DATA field, each group stays
  // in score order, and we round-robin across groups. The cap is a count, never a
  // platform name; the grouping key is the envelope's own `platform` value (DATA),
  // so adding a platform changes nothing.
  //
  // f7 — THE INHERITED DEFAULT (DIVERSITY_DEFAULT_MAX_PER_PLATFORM: 6) IS DELETED,
  // NOT RETUNED, and the sweep that condemns it is carried here so the next reader
  // inherits the measurement rather than the number. It was a fixed per-round take
  // that knew nothing about `limit`, and the weave runs BEFORE truncation, so it
  // failed in BOTH directions at once.
  //
  // ONE FROZEN POPULATION, replayed with projection:false (identified by the
  // dev_ino/size/mtime_ms triple in the f7 harness header, never the live surface):
  // 407 deduped rows — a higher-priority band of 11 and a lower-priority band of
  // 396, over three platform buckets. The lower band's budget is `limit` minus the
  // 11 rows ahead of it. Cited by SYMBOL only; the platform-partitioned tables live
  // in the harness header and the node record.
  //
  //   limit  low-band budget   fixed 6      DERIVED   high band, fixed 6
  //     12          1          NO-OP        NO-OP     REORDERED
  //     14          3          NO-OP        acts      REORDERED
  //     16          5          NO-OP        acts      REORDERED
  //     17          6          NO-OP        acts      REORDERED
  //     18          7          acts         acts      REORDERED
  //     20          9          acts         acts      REORDERED
  //     24         13          acts         acts      REORDERED
  //     50         39          acts         acts      REORDERED
  //
  // FAILURE ONE — SILENT NO-OP WHERE IT MATTERS MOST. At every limit whose band
  // budget was <= the take (four of the eight swept, i.e. every limit at or below
  // 17, which includes the small windows the interleave exists to protect) the cut
  // fell inside the dominant bucket's very first run and the emitted window was
  // BYTE-IDENTICAL TO PURE RANK. No integer fixes this: the threshold is a function
  // of `limit`, which a constant cannot see.
  //
  // FAILURE TWO — COST WITH NO BENEFIT WHERE IT DOES NOT. The 11-row high-priority
  // band FITS inside every limit swept, so none of its rows was ever at risk of
  // being cut — yet the fixed take reordered it at EVERY limit, paying 2 inverted
  // adjacent pairs (a lower-scoring row emitted above a higher-scoring one) with
  // score gaps of 0.104 and 0.439 — the widest inversions anywhere on the surface —
  // to gain exactly zero rows of visibility.
  //
  // THE FIX. The quantum is DERIVED per band inside the weave (see
  // diversifyByPlatform): a band that fits entirely inside its remaining budget is
  // not woven at all, and a band that spills gets its budget shared across the
  // buckets actually present in it. Both failures close, tier_crossings stays 0 in
  // every measured cell in both directions, and there is no default constant left
  // to inherit or to tune.
  //   DIVERSITY_ROUND_ROBIN_FLOOR: the minimum per-round take. This is a
  //     CORRECTNESS bound, not a tuned value and not a sweep candidate: a take of 0
  //     makes no progress through the buckets, so the derived quantum floors here
  //     whenever the budget is smaller than the bucket count. It is named rather
  //     than inlined so no bare literal enters the ordering path.
  DIVERSITY_ROUND_ROBIN_FLOOR: 1,
  // RECIPROCITY DOWN-RANK FLOOR (P2 — the first persona attribute). A thread you
  // have NEVER reciprocated (zero outbound is_from_me ever) is a one-directional
  // channel — either a genuine brand-new contact OR spam-that-looks-human (a
  // gibberish-domain email, an unsolicited pitch) that P1's STRUCTURAL gate
  // cannot catch because the sender is structurally person-shaped. We DOWN-RANK
  // such a thread by multiplying its rank score by this floor (in (0,1]). It is a
  // SOFT signal: reciprocated threads keep factor 1; zero-reciprocity threads are
  // pushed DOWN but NEVER hard-dropped, so a real new human still appears (lower).
  // CAPS-gated: tunable per call via opts.reciprocity_floor; an explicit >=1
  // disables the down-rank (pure rank, back-compat).
  RECIPROCITY_FLOOR: 0.3,

  // ----- P2-REFINE — GRADED reciprocity (relationship STRENGTH, not binary) -----
  // The binary "ever replied" factor was gamed by A2P marketing: one outbound
  // "STOP" against 45 inbound, turns=1, flipped reciprocated=true and TOPPED the
  // list. reciprocity is GRADED relationship strength. The PRIMARY signal is
  // turn_count (real back-and-forth depth: a friend turns=174 vs marketing
  // turns=1). The KEY discrimination at LOW turns is INBOUND VOLUME: a BROADCAST
  // (turns<=1, inbound high, outbound<=1) is one-directional and sinks; a genuine
  // NEW CONTACT (turns==0, inbound low — just arrived) is CONSERVATIVELY neutral
  // and survives. reciprocityStrength returns a factor in
  // [RECIPROCITY_BROADCAST_FLOOR, RECIPROCITY_RELATIONSHIP_MAX]; it is a SOFT rank
  // factor (never a hard drop). All thresholds below are CAPS-tunable DATA (counts
  // + ratios, never platform names) so the abstraction invariant holds.
  //
  // BROADCAST_FLOOR: the strongest down-rank — the A2P/marketing one-directional
  //   channel. The per-call opts.reciprocity_floor overrides THIS (an explicit >=1
  //   disables the down-rank entirely, pure rank, back-compat).
  RECIPROCITY_BROADCAST_FLOOR: 0.3,
  // RELATIONSHIP_MAX: the ceiling a deep two-way relationship earns (full weight).
  RECIPROCITY_RELATIONSHIP_MAX: 1,
  // TURN_RELATIONSHIP: turn_count at/above which a thread is a "real relationship"
  //   and earns the full RELATIONSHIP_MAX factor (the primary signal saturates).
  RECIPROCITY_TURN_RELATIONSHIP: 6,
  // BROADCAST_INBOUND_MIN: at turns<=1 AND outbound<=1, an inbound volume >= this
  //   is the BROADCAST pattern (a high-volume one-directional channel) -> floor.
  RECIPROCITY_BROADCAST_INBOUND_MIN: 5,
  // NEW_CONTACT_INBOUND_MAX: at turns==0, an inbound count STRICTLY BELOW this is a
  //   just-arrived NEW CONTACT (1-2 messages) -> NEUTRAL (survives, CONSERVATIVE).
  RECIPROCITY_NEW_CONTACT_INBOUND_MAX: 3,
  // NEW_CONTACT_NEUTRAL: the neutral factor a genuine brand-new first-contact human
  //   earns — well ABOVE the broadcast floor (never confuse a new human with spam),
  //   but below full (no relationship history yet). CONSERVATIVE: never drop a human.
  RECIPROCITY_NEW_CONTACT_NEUTRAL: 0.7,

  // ----- M5c — the HIGH reciprocity-only RELATIONSHIP-tier threshold -----
  // RELATIONSHIP_RECIP_MIN: the HIGH reciprocity_strength at/above which a row may
  //   be classified "relationship" on RECIPROCITY ALONE (no saved contact, no
  //   operator feedback) — AND ONLY when the latest inbound sender.kind === "person".
  //   Set WELL ABOVE the new-contact neutral (0.7) so a MODERATE-reciprocity business
  //   that auto-replies (e.g. a taxi/booking service, reciprocity ≈ 0.77) does NOT
  //   qualify — it is DEMOTED to the honest "unknown" tier (still surfaced + labeled,
  //   NEVER dropped). A genuine deep two-way PERSON history (a real relationship,
  //   high turn_count => reciprocity_strength at/above this) STILL qualifies. The
  //   reciprocityStrength factor saturates to RELATIONSHIP_MAX (1.0) at
  //   TURN_RELATIONSHIP turns, so 0.9 is reached only by a genuinely deep thread.
  //   This is the single frozen source of the M5c tightening; classifyTier reads it
  //   as INJECTED DATA (never a platform branch).
  RELATIONSHIP_RECIP_MIN: 0.9,

  // ----- e17 — SUBSTANCE_LOW_FACTOR_MIN: the DOWN-RANK a rescued closer takes -----
  //
  // WHAT IT GATES. A row N8 graded a closer (substance.isCloser) that this surface
  // KEEPS on context evidence — a saved-contact vouch, or an inbound run that
  // answers something the operator sent — is multiplied by
  //     substanceFactor(s) = MIN + (1 - MIN) * s
  // where `s` is N8's own graded substance score in [0,1], already on the record.
  // This is the FLOOR of that multiplier: the weakest text (s = 0) keeps this
  // fraction of its score, and the multiplier rises monotonically with s.
  //
  // WHY A FLOOR AND NOT A DROP. The rescue exists because the drop was wrong for
  // these rows; re-introducing it as a near-zero multiplier would be the same
  // decision in arithmetic. The factor is bounded strictly above 0 so a rescued row
  // can never be zeroed out of existence, which is the standing invariant for every
  // factor in this file — no factor may hard-drop a row, and truncation is by
  // `limit` alone.
  //
  // WHY THIS VALUE. Every rescuable row has s <= ATTENTION_CAPS.SUBSTANCE_FLOOR
  // (that inequality is what `isCloser` MEANS), so at MIN = 0.3 the multiplier is
  // confined to [0.30, 0.65]: a rescued closer can never reach even two thirds of
  // an otherwise identical substantive row's score, and rescued rows are ordered
  // among themselves by how much text N8 actually found. Both ends of the
  // multiplier are therefore set by the two ends of the graded score, not by a
  // number picked to move a row.
  //
  // The rescue is gated on context evidence rather than applied without it.
  // The alternative of keeping closers without that gate is refused because it
  // admits rows with no saved-contact or outbound-history evidence. The value below was
  // fixed before the empirical comparison; treat it as a policy value, not a
  // number inferred from the captured output.
  //
  // The alternative of no down-rank at all (MIN = 1) is refused because it would
  // let a one-word "ok" from a vouched contact out-rank a paragraph-long question
  // from the same person on nothing but recency.
  //
  // ONE HONEST CONSEQUENCE, from the same table: the two vouched rescues head
  // their partition and one lands at rank 0. That is the TIER key doing it — a
  // saved contact is TIER.RELATIONSHIP and sorts above every UNKNOWN row whatever
  // its score — not this multiplier defeating itself. Within its own tier the
  // rescued row is below where its score would otherwise have put it.
  SUBSTANCE_LOW_FACTOR_MIN: 0.3,
});

export const DEFAULT_MIN_SCORE = CATCHUP_CAPS.DEFAULT_MIN_SCORE;

export const NAME = "memory_catchup";

// ---------------------------------------------------------------------------
// ADAPTER REGISTRY — the keystone of the abstraction invariant.
//
// A Map<platform, {toEnvelope, ledgerPath}>. The platform KEY is read from each
// adapter's OWN `PLATFORM` constant (DATA), never hard-coded here. `toEnvelope`
// is the adapter's pure row->Envelope mapper (exported as `_toEnvelope`).
// `ledgerPath` is the adapter's source-ledger slug under storage/sources/ —
// also DATA (the adapter knows its own ledger; the loop does not branch on it).
//
// buildCatchup loops this registry GENERICALLY. To add a platform: import its
// adapter module and add ONE entry here — no other line in this file changes.
// ---------------------------------------------------------------------------

// Pick the pure mapper an adapter exposes. Adapters variously export
// `_toEnvelope` (the N1 registry convention) and/or a `toEnvelope` alias; both
// point at the one impl. We read by capability, never by platform identity.
function adapterMapper(mod) {
  if (mod == null || typeof mod !== "object") return null;
  if (typeof mod._toEnvelope === "function") return mod._toEnvelope;
  if (typeof mod.toEnvelope === "function") return mod.toEnvelope;
  if (typeof mod.default === "function") return mod.default;
  return null;
}

// Read an adapter's self-declared platform id (DATA). Falls back to null when an
// adapter does not export PLATFORM (it is then skipped — defensive, never throws).
function adapterPlatform(mod) {
  return mod && typeof mod.PLATFORM === "string" && mod.PLATFORM.length > 0
    ? mod.PLATFORM
    : null;
}

// Read an adapter's OPTIONAL context-preparer (DATA, read by capability). An
// adapter that needs a read-only side-load (a name sidecar, a label map, …) to
// enrich its row->Envelope mapping exports `prepareContext()`; this loop calls it
// ONCE and threads the result into that adapter's toEnvelope(row, ctx) — with NO
// platform branch. An adapter without it yields null here and is fed {} (the
// common case: most adapters need no context). Generic by construction.
function adapterPrepareContext(mod) {
  return mod && typeof mod.prepareContext === "function" ? mod.prepareContext : null;
}

// Read an adapter's OPTIONAL batch row-fold (DATA, read by capability). An
// adapter whose ledger carries derived rows that must collapse onto their parent
// BEFORE mapping (e.g. a late enrichment row) exports a pure `foldRows(rows)`;
// the loaders apply it to that adapter's raw rows with NO platform branch. An
// adapter without it yields null and its rows map exactly as before.
function adapterFoldRows(mod) {
  return mod && typeof mod.foldRows === "function" ? mod.foldRows : null;
}

// safeFold — apply a fold, degrading to the unfolded rows on ANY failure: a
// throw or a non-Array result returns `rows` untouched. Never throws.
function safeFold(fold, rows) {
  try {
    const folded = fold(rows);
    return Array.isArray(folded) ? folded : rows;
  } catch {
    return rows;
  }
}

// Build the registry from a list of adapter modules. Keyed by each module's own
// PLATFORM. `ledgerPath` is derived generically as the adapter's own ledger slug
// (storage/sources/<platform>.jsonl) — a convention, not a branch: every adapter
// reads its same-named ledger. A module missing PLATFORM or a mapper is skipped.
export function buildAdapterRegistry(modules) {
  const registry = new Map();
  const list = Array.isArray(modules) ? modules : [];
  for (const mod of list) {
    const platform = adapterPlatform(mod);
    const toEnvelope = adapterMapper(mod);
    if (platform === null || toEnvelope === null) continue;
    if (registry.has(platform)) continue; // first wins; deterministic
    registry.set(platform, {
      toEnvelope,
      // OPTIONAL context-preparer (null when the adapter exports none). Read as
      // a capability, never by platform identity — the loop stays generic.
      prepareContext: adapterPrepareContext(mod),
      // OPTIONAL pure batch row-fold (null when the adapter exports none). Read
      // as a capability, like prepareContext — never by platform identity.
      foldRows: adapterFoldRows(mod),
      // Generic ledger slug from the adapter's own id. No platform literal.
      ledgerPath: `storage/sources/${platform}.jsonl`,
    });
  }
  return registry;
}

// The DEFAULT registry over the landed adapters (read from the opaque barrel).
// Built once at module load by looping the modules generically.
export const ADAPTER_REGISTRY = buildAdapterRegistry(ADAPTER_MODULES);

// ---------------------------------------------------------------------------
// Monotone rank normalizers (each in [0, 1]); exported so TESTS can unit them.
// The product is the sort key (descending). All are documented + total.
// ---------------------------------------------------------------------------

/**
 * directednessFactor(score) — N2's directed score IS the directedness factor,
 * clamped to [0,1]. A non-finite / missing score degrades to 0 (won't surface).
 */
export function directednessFactor(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return 0;
  if (score < 0) return 0;
  if (score > 1) return 1;
  return score;
}

/**
 * stalenessFactor(ageMs) — older-is-higher via a half-life curve in (0,1):
 *   age 0   -> ~0 (just arrived, not yet overdue)
 *   age = H -> 0.5
 *   age ->∞ -> ->1
 * Monotone non-decreasing in age. Negative age (clock skew) clamps to 0.
 *
 * e17 — NOT A rankScore TERM ANY MORE. This function is unchanged and still
 * exported, but nothing in the scoring path multiplies by it: it was the second
 * of two factors reading the same age, and their product was a band-pass that
 * scored a just-arrived directed message at ~0 (see the block above rankScore).
 * Its consumers are now measurement and tests — the e7 harness's saturation
 * bisection and time-term candidates, and the factor cases in the gate suites.
 */
export function stalenessFactor(ageMs, halfLifeMs = CATCHUP_CAPS.STALENESS_HALFLIFE_MS) {
  const age = typeof ageMs === "number" && Number.isFinite(ageMs) && ageMs > 0 ? ageMs : 0;
  const h = typeof halfLifeMs === "number" && halfLifeMs > 0 ? halfLifeMs : CATCHUP_CAPS.STALENESS_HALFLIFE_MS;
  // 1 - 2^(-age/H): 0 at age 0, 0.5 at age H, ->1 as age grows. Monotone.
  return 1 - Math.pow(2, -age / h);
}

// Data hygiene: the earliest ts we treat as a REAL message time. Anything older is a
// parse artifact (a corrupt ~epoch-0 value reads as ~56yr stale and silently floors a
// real contact's recency). 2008-01-01, before any supported platform's message history.
export const MIN_PLAUSIBLE_TS_MS = 1199145600000;

/**
 * plausibleTs(ts, now) — return ts iff it is a finite, in-range message time (>= the
 * MIN_PLAUSIBLE floor and not implausibly far in the future); else null. Used to clamp a
 * corrupt timestamp at read time so it does not corrupt recency. Pure / total.
 */
export function plausibleTs(ts, now) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  if (ts < MIN_PLAUSIBLE_TS_MS) return null;
  if (typeof now === "number" && Number.isFinite(now) && ts > now + 24 * 60 * 60 * 1000) return null;
  return ts;
}

/**
 * recencyFactor(lastInboundTs, now) — newer-is-higher, decaying linearly across
 * RECENCY_WINDOW_MS to RECENCY_FLOOR. A future ts (skew) clamps to the max (1).
 * Monotone non-increasing in (now - lastInboundTs).
 */
export function recencyFactor(lastInboundTs, now, windowMs = CATCHUP_CAPS.RECENCY_WINDOW_MS) {
  if (typeof lastInboundTs !== "number" || !Number.isFinite(lastInboundTs)) return CATCHUP_CAPS.RECENCY_FLOOR;
  if (typeof now !== "number" || !Number.isFinite(now)) return CATCHUP_CAPS.RECENCY_FLOOR;
  const age = now - lastInboundTs;
  if (age <= 0) return 1;
  const w = typeof windowMs === "number" && windowMs > 0 ? windowMs : CATCHUP_CAPS.RECENCY_WINDOW_MS;
  const frac = Math.max(0, 1 - age / w);
  return CATCHUP_CAPS.RECENCY_FLOOR + (1 - CATCHUP_CAPS.RECENCY_FLOOR) * frac;
}

/**
 * reciprocityFactor(reciprocated, floor) — P2's SOFT down-rank for a
 * one-directional thread (the first persona attribute folded into rank).
 *   reciprocated === true  -> 1   (a two-way relationship; full weight)
 *   reciprocated !== true   -> floor in (0,1]  (never replied: down-rank, NOT drop)
 * The floor defaults to CATCHUP_CAPS.RECIPROCITY_FLOOR (CAPS-gated). A floor >= 1
 * disables the down-rank (pure rank). A non-finite / negative floor clamps to 0
 * (which would zero a zero-reciprocity row's score but STILL keep the row — the
 * filter never drops on score; truncation is by limit, not by score). Monotone.
 */
export function reciprocityFactor(reciprocated, floor = CATCHUP_CAPS.RECIPROCITY_FLOOR) {
  if (reciprocated === true) return 1;
  let f = typeof floor === "number" && Number.isFinite(floor) ? floor : CATCHUP_CAPS.RECIPROCITY_FLOOR;
  if (f < 0) f = 0;
  if (f > 1) f = 1;
  return f;
}

/**
 * reciprocityStrength({ turn_count, outbound_count, inbound_count }, floor) —
 * P2-REFINE's GRADED reciprocity rank factor: relationship STRENGTH, not a binary
 * "ever replied". Returns a factor in [floor, RELATIONSHIP_MAX]. SOFT (never a
 * hard drop). All thresholds are CAPS-gated DATA (counts + ratios, no platform).
 *
 * `floor` is the BROADCAST_FLOOR (the strongest down-rank); it defaults to
 * CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR and is overridable per call. A floor
 * >= 1 disables the down-rank (every thread earns >= 1 => pure rank, back-compat);
 * a non-finite/negative floor clamps to 0 (still never DROPS the row).
 *
 * The grading (in priority order):
 *   (a) RELATIONSHIP (turn_count >= TURN_RELATIONSHIP): full RELATIONSHIP_MAX —
 *       a deep two-way history (the friend at turns=174).
 *   (b) GRADED RELATIONSHIP (2 <= turn_count < TURN_RELATIONSHIP): scales linearly
 *       from a neutral base up toward RELATIONSHIP_MAX with turns. MONOTONE in
 *       turns. This is the "some real back-and-forth" middle band.
 *   (c) BROADCAST (turn_count <= 1 AND outbound_count <= 1 AND inbound_count >=
 *       BROADCAST_INBOUND_MIN): one-directional high-volume channel (A2P/marketing,
 *       out=1 "STOP" in=45 turns=1) -> the floor (strong down-rank).
 *   (d) NEW CONTACT (turn_count == 0 AND inbound_count < NEW_CONTACT_INBOUND_MAX):
 *       a just-arrived first-contact human (out=0 in=1 turns=0) -> NEUTRAL, well
 *       ABOVE the floor. CONSERVATIVE: never confuse a new human with spam.
 *   (e) ELSE (the graded middle: turns<=1 not matching the above — e.g. a single
 *       reply, or a moderate-volume monologue): NEUTRAL-ish, between floor and
 *       NEW_CONTACT_NEUTRAL by inbound imbalance.
 */
export function reciprocityStrength(reciprocity, floor = CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR) {
  // Resolve + clamp the broadcast floor (the strongest down-rank).
  let bFloor = typeof floor === "number" && Number.isFinite(floor)
    ? floor
    : CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR;
  if (bFloor < 0) bFloor = 0;
  if (bFloor > 1) bFloor = 1;

  const MAX = CATCHUP_CAPS.RECIPROCITY_RELATIONSHIP_MAX;
  const NEUTRAL = CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL;
  const TURN_REL = CATCHUP_CAPS.RECIPROCITY_TURN_RELATIONSHIP;
  const BROADCAST_IN = CATCHUP_CAPS.RECIPROCITY_BROADCAST_INBOUND_MIN;
  const NEW_IN_MAX = CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_INBOUND_MAX;

  // A floor >= 1 means "no down-rank at all" — every thread earns full weight.
  if (bFloor >= 1) return MAX;

  // Total / defensive: a missing or malformed block reads as zero-history. The
  // conservative reading is NEW-CONTACT neutral (never punish on absent data).
  const turns = reciprocity && Number.isFinite(reciprocity.turn_count) && reciprocity.turn_count > 0
    ? reciprocity.turn_count : 0;
  const outbound = reciprocity && Number.isFinite(reciprocity.outbound_count) && reciprocity.outbound_count > 0
    ? reciprocity.outbound_count : 0;
  const inbound = reciprocity && Number.isFinite(reciprocity.inbound_count) && reciprocity.inbound_count > 0
    ? reciprocity.inbound_count : 0;

  // The neutral base is always >= the floor (clamp so a high custom floor can lift
  // the neutral band rather than letting it dip below the floor).
  const neutral = Math.max(NEUTRAL, bFloor);

  // (a) RELATIONSHIP: deep two-way history saturates at full weight.
  if (turns >= TURN_REL) return MAX;

  // (b) GRADED RELATIONSHIP: some real back-and-forth (turns 2..TURN_REL-1) scales
  //     linearly from the neutral base toward MAX. MONOTONE non-decreasing in turns.
  if (turns >= 2) {
    const span = TURN_REL > 2 ? (turns - 2) / (TURN_REL - 2) : 1; // [0,1)
    return neutral + (MAX - neutral) * span;
  }

  // ----- LOW TURNS (turns <= 1): inbound VOLUME is the discriminator. -----

  // (c) BROADCAST: a high-volume one-directional channel. turns<=1, you replied at
  //     most once, they spoke many times -> the floor (the A2P/marketing case).
  //
  //     WHAT THIS BRANCH IS ENTITLED TO CLAIM. Its inputs are counts over the
  //     envelopes the caller loaded, and buildCatchup's loader retains only a
  //     bounded per-source tail (ledgerRetainCap, this file). outbound_count === 0
  //     therefore means "no reply inside the read window", NOT "never replied": a
  //     long relationship whose last reply predates the window is COUNT-IDENTICAL
  //     here to a cold blast, and this function — a pure function of the counts —
  //     cannot separate them. It is not permitted to guess: the branch keeps its
  //     verdict on the counts alone, and the seat that DOES hold out-of-band
  //     evidence (buildCatchupCore, where M2's is_contact vouch is in hand) is the
  //     seat that raises this row's floor. For a waiting-on-you list the distinction
  //     matters most here — an unanswered message from someone the operator has
  //     saved is a high-value row, and the down-rank must key on being a
  //     one-directional CHANNEL, never on the operator not having answered yet.
  if (turns <= 1 && outbound <= 1 && inbound >= BROADCAST_IN) return bFloor;

  // (d) ESTABLISHED LOW-TURN: a single reply DID occur (turns==1, outbound>=1) and
  //     it is NOT the broadcast pattern (low inbound, caught above) -> NEUTRAL. One
  //     real reply is relationship, so it is never weaker than a fresh new contact
  //     (this also keeps the factor MONOTONE non-decreasing in turns).
  if (turns === 1 && outbound >= 1) return neutral;

  // (e) NEW CONTACT: turns==0 and a just-arrived low inbound volume -> NEUTRAL.
  //     CONSERVATIVE — a genuine first-contact human survives well above the floor.
  if (turns === 0 && inbound < NEW_IN_MAX) return neutral;

  // (f) GRADED MIDDLE: a moderate-volume monologue (turns==0, inbound between
  //     NEW_IN_MAX and BROADCAST_IN), or a turns==1 thread with no recorded
  //     outbound. Grade DOWN from the neutral base toward the floor as inbound
  //     volume climbs toward the broadcast threshold. MONOTONE non-increasing in
  //     inbound: a growing one-directional run leans toward the broadcast floor.
  const denom = BROADCAST_IN > 0 ? BROADCAST_IN : 1;
  const volFrac = Math.min(1, inbound / denom); // [0,1], 1 at the broadcast edge
  return bFloor + (neutral - bFloor) * (1 - volFrac);
}

/**
 * substanceFactor(score) — e17's SOFT down-rank for a row N8 graded a closer that
 * the catch-up seat RESCUED on context evidence. Returns
 *     MIN + (1 - MIN) * clamp01(score)
 * with MIN = CATCHUP_CAPS.SUBSTANCE_LOW_FACTOR_MIN, i.e. a multiplier in
 * [MIN, 1]. MONOTONE non-decreasing in N8's graded substance score, TOTAL (a
 * missing / non-finite / out-of-range score degrades to the strongest down-rank,
 * never to a throw and never to 0), and BOUNDED STRICTLY ABOVE 0 so it can only
 * move a row DOWN within its tier — never out of the result.
 *
 * It does NOT re-grade any text: `score` is N8's own `substance.score`, read off
 * the attention record. Applied at exactly one seat (the catchup emit loop) and
 * only to rows whose isCloser flag is true, so a substantive row multiplies by
 * nothing at all.
 */
export function substanceFactor(score) {
  const min = CATCHUP_CAPS.SUBSTANCE_LOW_FACTOR_MIN;
  let s = typeof score === "number" && Number.isFinite(score) ? score : 0;
  if (s < 0) s = 0;
  if (s > 1) s = 1;
  return min + (1 - min) * s;
}

// ---------------------------------------------------------------------------
// WHAT THE SCORING PIPELINE IS FOR — stated once, here, at its first seat,
// because the five stages below are one mechanism and were being maintained as
// five. From this function to the emitted row:
//
//     rankScore   turns a candidate row's signals into ONE number that means
//                 "how much does the operator owe this person a reply".
//     the comparator turns that number into an ORDER. The order is ORDER_KEY_SEQUENCE
//                 — read that constant for what the keys are and in what order;
//                 this comment deliberately does not restate them, because a
//                 restatement is a copy that can drift from the one that runs.
//     the substance gate decides whether a row is a REPLY-WORTHY thing at all,
//                 or a closer ("thanks!") that needs nothing from the operator.
//     the dedup head collapses a person's threads to one row — and it picks the
//                 head with DEFAULT_COMPARE_DESC, the same function object the
//                 line above sorts with, so ONE comparator decides both the order
//                 and WHICH THREAD of a person is shown.
//     the emit loop attaches the reasons, the tier, the persona and the counts
//                 that let the row explain itself.
//
// Everything a change can touch here is one of those five, and each of them is
// consumed by the next — which is why a factor added "just for ranking" also
// changes which thread of a person the operator sees.
//
// e17 — THE FINDING THAT MADE THIS FIX A REMOVAL, AND NOT A NEW FACTOR. rankScore
// took BOTH `lastInboundTs` and `ageMs` and fed them to two different normalizers.
// For a they-spoke-last thread — the only kind this surface emits — those two
// arguments are THE SAME QUANTITY: the caller's `ageMs` is `rec.staleness.ms`,
// which attention.js computes as `now - last_ts` over a thread whose LAST envelope
// is inbound, i.e. exactly `now - lastInboundTs`. So
//     recencyFactor(ts, now) * stalenessFactor(ageMs)
// was a BAND-PASS IN ONE VARIABLE that nobody designed: 0 at age 0 (a message that
// arrived a minute ago was unrankable), a peak in the middle, and decay after.
// The fix DELETES the second factor. It
// introduces no constant, no branch and no threshold; `ageMs` is no longer read at
// this seat at all, and stalenessFactor stays exported for its other consumers.
//
// RUNTIME-CENSUS: run mcp/test/messaging/e7-catchup-join-eval.mjs against a
// pinned snapshot for the candidate table, before/after churn, rescue effects,
// and floor population. Keep the dated output with the investigation; do not
// copy it into source.
//
// The candidate comparison chose recency alone because it removes the fresh-end
// suppression without turning stale rows into an overdue lift. A directedness
// gate is inert at this seat because the earlier minimum-score filter has already
// admitted the same signal. compareDesc is also the dedup head-selection key, so
// score changes can change which thread represents a person even when membership
// does not change; the harness reports that separately from rank churn.
//
// WHAT THE DELETION DOES NOT FIX, stated at the seat rather than discovered
// later: rows can still sit at RECENCY_FLOOR, so past RECENCY_WINDOW_MS the
// time term is a constant and the ts-desc tiebreak — not
// the score — is what orders them. That is now the honest rule; before e17 it was
// the decaying float tail of stalenessFactor doing it by accident (the fraction is
// re-measured at compareDesc's score-key commentary, which is where the ordering
// consequence now lives).
// ---------------------------------------------------------------------------

/**
 * rankScore — the composite sort key: recency × directedness × reciprocity ×
 * anchor. Each of the first three factors is monotone and in [0,1]; the anchor
 * factor is the M1 monotone UP-rank multiplier in [1, ANCHOR_MAX]
 * (neutral 1.0 by default => no-op). Higher = more "you should reply to this next".
 *
 * THE TIME TERM IS recencyFactor ALONE (e17), and it is the whole of the score's
 * dependence on time: MONOTONE NON-INCREASING in the age of the latest inbound
 * message, with no interior peak. `ageMs` is still ACCEPTED for call-site
 * compatibility and is DELIBERATELY IGNORED — it is the same quantity as
 * (now - lastInboundTs) for every row this surface emits (see the block above),
 * and reading it twice is what produced the band-pass e17 deleted.
 *
 * P2-REFINE: the reciprocity factor is GRADED relationship strength. When a
 * `reciprocity` counts block ({turn_count, outbound_count, inbound_count}) is
 * supplied, reciprocityStrength grades it (a deep two-way history -> full weight;
 * an A2P/marketing broadcast -> the floor; a genuine new contact -> neutral). When
 * NO counts block is supplied, it degrades to the binary reciprocityFactor on the
 * `reciprocated` flag (back-compat for callers that pass only the boolean).
 *
 * M1: `anchor` is a precomputed MONOTONE multiplier in [1, ANCHOR_MAX] (the M1
 * person-enrichment anchorFactor — anchored people UP-rank; cold/unknown stay at
 * 1.0). It DEFAULTS to 1.0 (a no-op in the product) so when no enrichPerson is
 * wired the score is BYTE-IDENTICAL to pre-M1. A non-finite / <1 anchor clamps to
 * the neutral 1.0 (NEVER below — the anchor only ever lifts, never hard-drops).
 */
export function rankScore({ lastInboundTs, directed, now, reciprocated, reciprocity, reciprocityFloor, anchor }) {
  const reciprocityTerm = isPlainObject(reciprocity)
    ? reciprocityStrength(reciprocity, reciprocityFloor)
    : reciprocityFactor(reciprocated, reciprocityFloor);
  // M1 anchor: neutral (no-op) unless a >=1 finite multiplier is supplied. Clamp
  // to >= 1 so the anchor can ONLY up-rank — never a hard-drop below the base.
  const anchorTerm = typeof anchor === "number" && Number.isFinite(anchor) && anchor > 1 ? anchor : 1;
  return (
    // e17 — ONE time factor. `ageMs`, if the caller passed it, is not read here.
    recencyFactor(lastInboundTs, now) *
    directednessFactor(directed) *
    reciprocityTerm *
    anchorTerm
  );
}

// ---------------------------------------------------------------------------
// THE RANK ORDER, DECLARED ONCE AS A SEQUENCE OF NAMED KEYS.
//
// WHAT THIS BLOCK REPLACED, AND WHY IT IS A REMOVAL. The comparator used to be a
// hand-written if-ladder inside buildCatchupCore, and its key order was ALSO
// restated in prose in three source comments and re-implemented by hand a fourth
// time in the measurement harness (e7-catchup-join-eval.mjs's mirrorCompare).
// Five statements of one fact, four of which could drift from the one that runs.
// There is now ONE statement — ORDER_KEY_SEQUENCE below — and every other seat
// either consumes it or names it. NOTHING ABOUT THE ORDER CHANGED: the default
// sequence and the default contact reader reproduce the previous ladder exactly,
// key for key, including its tie behaviour and its clamp.
//
// THE KEYS, in the order ORDER_KEY_SEQUENCE declares them. Read that constant,
// not this list, when you need to know what the order IS — this list says what
// each key MEANS:
//   KEY_TIER     the honest who-matters tier (GOAL invariant 3: tier is the
//                PRIMARY key). RELATIONSHIP rows sort ABOVE UNKNOWN rows; the
//                cold-node tier is GROUPED below, never dropped. No key below
//                this one can move a row across a tier boundary, which is what
//                makes "tier crossings 0" a property of the STRUCTURE and not a
//                lucky reading of a population.
//   KEY_CONTACT  M5b — the operator's address-book vouch, the strongest single
//                who-matters signal, read as DATA off the row's enrichment (no
//                platform branch). WITHIN a tier a saved contact sorts ABOVE a
//                non-contact, BEFORE score: the M5b regression was a chatty
//                business out-SCORING a saved human on raw recency x reciprocity
//                while both sat in the relationship tier. MONOTONE — it only ever
//                promotes the saved human, never demotes anyone below their tier.
//   KEY_SCORE    the composite rank score, compared at FULL DOUBLE WIDTH under a
//                totality clamp. The clamp is mandatory and its argument lives on
//                the key itself, below.
//   KEY_TS       the explicit recency tiebreak, newest first.
//   KEY_THREAD   the final total tiebreak, thread_id ascending, so the order is a
//                function of the input and nothing else.
//
// WHAT A CHANGE HERE CAN AND CANNOT REACH — the honest bound, measured, not argued
// from reading the source. KEY_SCORE sits strictly BELOW KEY_TIER and KEY_CONTACT,
// so no row can cross a tier boundary in either direction (tier_crossings = 0 in
// every cell of every published table) and no row is dropped. It does NOT follow
// that nothing else moves: this comparator is ALSO the dedup HEAD-SELECTION key
// below, and the head is what carries score, thread_id, ts, platform, last_msg,
// reciprocity, anchor, enrichment and persona onto the emitted row. A change here
// can therefore change WHICH THREAD OF A PERSON the operator is shown. On the
// snapshot named in the e7 harness header that count is head_changed = 0, measured
// over 143 collapsed dedup groups (1151 threads, largest group 71); latent is not
// the same as impossible, which is why the instrument measures it rather than this
// comment asserting it.
//
// WHAT THIS BLOCK DOES NOT DO. It adds NO configuration seam to the surface:
// buildCatchupCore takes no ordering option and never will from here. The factory
// is parameterised so a MEASUREMENT can re-rank a frozen population without a
// second hand-written comparator existing anywhere; the shipped path constructs
// exactly one instance, DEFAULT_COMPARE_DESC, from the declared defaults.
// ---------------------------------------------------------------------------

/**
 * The M5b saved-contact vouch, read off an EMITTED row's enrichment. MODULE-LOCAL
 * on purpose: it is the DEFAULT reading of one key, not a second export to keep in
 * step. Its totality (null, a row with no enrichment, a row whose enrichment omits
 * the vouch) is covered through DEFAULT_COMPARE_DESC's observable behaviour.
 */
function isContactRow(r) {
  return isPlainObject(r) && isPlainObject(r.enrichment) && r.enrichment.is_contact === true;
}

/**
 * THE DECLARED KEY SEQUENCE — the single statement of the rank order. Every other
 * seat (the pipeline comment, the anchor-lift bound, the dedup head comment, the
 * measurement harness) points here rather than restating it.
 */
export const ORDER_KEY_SEQUENCE = Object.freeze([
  "KEY_TIER",
  "KEY_CONTACT",
  "KEY_SCORE",
  "KEY_TS",
  "KEY_THREAD",
]);

// The five key comparators. Each returns a NEGATIVE number when `a` sorts first,
// POSITIVE when `b` does, and EXACTLY 0 when this key cannot separate the pair —
// which is the ONLY thing that hands the decision to the next key in the sequence.
// A non-zero "equal" return would silently truncate the sequence. `ctx` carries the
// one injected reading (the contact reader) so the key functions stay data-free.
const ORDER_KEYS = Object.freeze({
  KEY_TIER: (a, b) => {
    const ra = tierRank(a.tier);
    const rb = tierRank(b.tier);
    return ra !== rb ? ra - rb : 0; // RELATIONSHIP (0) before UNKNOWN (1).
  },
  KEY_CONTACT: (a, b, ctx) => {
    const ca = ctx.readContact(a);
    const cb = ctx.readContact(b);
    return ca !== cb ? (ca ? -1 : 1) : 0; // a saved contact sorts first.
  },
  // THE SCORE KEY IS THE RAW SCORE, COMPARED AT FULL DOUBLE WIDTH, under a
  // TOTALITY CLAMP. f1 retired the quantization grid this seat used to run: the
  // grid was sized for a near-tie band that the second time factor created, and
  // deleting that factor emptied the band. Re-measured on one frozen population
  // (406 deduped rows, 171 of them pinned at RECENCY_FLOOR): of the 166 adjacent
  // pinned pairs this key decides, 160 collide EXACTLY and reach the explicit
  // tiebreak unaided, and the 6 that do not are separated by 2.0e-3 or more —
  // none within 8 ulps of its operands. The published table showed 0 rank moves
  // and 0 tier crossings at every grid from 1e-15 through 1e-6, i.e. the shipped
  // grid was already indistinguishable from this comparison. It absorbed nothing,
  // so it is gone rather than kept as an unexercised mechanism.
  //
  // WHY THE CLAMP IS MANDATORY, and it is a CLAMP and not a threshold — no CAPS
  // entry belongs here. A bare subtraction of the two scores is a consistent
  // strict weak ordering on FINITE doubles only. On a missing, non-numeric or
  // non-finite score the subtraction yields NaN, and per ECMA-262 SortCompare a
  // NaN comparator result is coerced to +0 — "equal to everything". Beside
  // elements that ARE strictly ordered among themselves that is not a transitive
  // equivalence, so the relation stops being a strict weak ordering,
  // Array.prototype.sort becomes implementation-defined, and (because this
  // comparator is ALSO the dedup head-selection key) so does the head the
  // operator is shown. Degrading such a score to 0 restores totality: every row
  // has a finite non-negative key, every comparison is a real subtraction of two
  // finite doubles, and a degenerate row simply collides with a zero-scored one
  // and falls to KEY_TS. The `> 0` form reproduces exactly what the retired
  // quantizer degraded to bucket 0, so a negative score and a zero score still
  // collide, as they did before.
  KEY_SCORE: (a, b) => {
    const sa = typeof a.score === "number" && Number.isFinite(a.score) && a.score > 0 ? a.score : 0;
    const sb = typeof b.score === "number" && Number.isFinite(b.score) && b.score > 0 ? b.score : 0;
    return sb !== sa ? sb - sa : 0;
  },
  KEY_TS: (a, b) => {
    // FINITE, not `typeof === "number"`. NaN IS a number by typeof, and NaN
    // fails the guard's intent in the worst possible way: `NaN !== NaN` is
    // true, so the branch is taken and `NaN - NaN` returns NaN — neither
    // negative, positive, nor exactly 0. makeCompareDesc's loop breaks on
    // `d !== 0`, so NaN TRUNCATES the sequence before KEY_THREAD ever runs,
    // and SortCompare then coerces it to +0. Measured before this guard:
    // three rows with a NaN ts emitted z,a,m instead of a,m,z — the order
    // became insertion-dependent. Same failure mode KEY_SCORE's clamp exists
    // to prevent, one key down; the block above this table asserts all five
    // keys return exactly 0 when they cannot separate, and this is what makes
    // that true of KEY_TS. -Infinity is the deliberate fallback: two absent
    // timestamps compare equal (`-Infinity !== -Infinity` is false, so no
    // subtraction happens) and a real ts outranks an absent one.
    const ta = Number.isFinite(a.ts) ? a.ts : -Infinity;
    const tb = Number.isFinite(b.ts) ? b.ts : -Infinity;
    return tb !== ta ? tb - ta : 0;
  },
  KEY_THREAD: (a, b) => {
    const ka = a.thread_id || "";
    const kb = b.thread_id || "";
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  },
});

/**
 * makeCompareDesc({ sequence, readContact }) — build THE comparator from a declared
 * sequence of key names. The defaults reproduce the shipped order exactly:
 * ORDER_KEY_SEQUENCE and the enrichment.is_contact reader above. There is no third
 * parameter, and buildCatchupCore never passes a first or second one.
 *
 * `readContact` exists because a measurement compares DIGEST rows, which carry the
 * vouch as a flat `is_contact` field rather than nested under `enrichment`; the KEY
 * ORDER is the same object in both cases, which is the whole point.
 *
 * THROWS on an unknown key name — a typo in a candidate sequence must fail loudly
 * at construction, never silently drop a key and publish a table under a comparator
 * nobody declared.
 */
export function makeCompareDesc({ sequence = ORDER_KEY_SEQUENCE, readContact = isContactRow } = {}) {
  const seq = Array.isArray(sequence) ? sequence : ORDER_KEY_SEQUENCE;
  const read = typeof readContact === "function" ? readContact : isContactRow;
  const keys = [];
  for (const name of seq) {
    const k = ORDER_KEYS[name];
    if (typeof k !== "function") {
      throw new Error(`makeCompareDesc: unknown ordering key ${JSON.stringify(name)}`);
    }
    keys.push(k);
  }
  const ctx = { readContact: read };
  return function compareDesc(a, b) {
    for (const k of keys) {
      const d = k(a, b, ctx);
      if (d !== 0) return d;
    }
    return 0;
  };
}

/**
 * THE ONE COMPARATOR THE SURFACE RUNS. Constructed once, at module load, from the
 * declared defaults — so the dedup HEAD-SELECTION seat and the EMITTED-ORDER seat
 * in buildCatchupCore consume the SAME function object and provably cannot
 * disagree about the order.
 */
const DEFAULT_COMPARE_DESC = makeCompareDesc();

// ---------------------------------------------------------------------------
// Defensive helpers.
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Read the latest message's sender KIND as DATA (N11, A2). Absent => "person"
// (backward-compat). Defense-in-depth: N8 already drops non-person inbound
// senders, but the catch-up surface ALSO reads this agnostic field so a row from
// a bot/service/system sender can never surface here — with NO platform branch.
function isPersonSender(env) {
  const k = env && env.sender && env.sender.kind;
  return !(k === "bot" || k === "service" || k === "system");
}

// Map a list of raw source rows through an adapter's pure mapper, dropping any
// row that throws or yields a non-object (defensive: one bad row never poisons
// the projection). NEVER mutates the input rows. `ctx` is the OPTIONAL context
// object the adapter's prepareContext() produced (an opaque per-adapter sidecar);
// it is threaded into toEnvelope(row, ctx) unchanged. Defaults to {} so an
// adapter with no preparer maps exactly as before.
function rowsToEnvelopes(rows, toEnvelope, ctx = {}) {
  const out = [];
  if (!Array.isArray(rows) || typeof toEnvelope !== "function") return out;
  const opts = isPlainObject(ctx) ? ctx : {};
  for (const row of rows) {
    let env = null;
    try {
      env = toEnvelope(row, opts);
    } catch {
      env = null;
    }
    if (isPlainObject(env)) out.push(env);
  }
  return out;
}

// The latest INBOUND envelope of a thread is the one whose response we owe; the
// attention record already encodes they-spoke-last, but we re-derive the latest
// inbound envelope here so we can run N2's classifier on the ACTUAL message (the
// rank's directedness input). Returns null if no inbound envelope exists.
function latestInboundEnvelope(threadEnvelopes) {
  if (!Array.isArray(threadEnvelopes)) return null;
  let best = null;
  for (const e of threadEnvelopes) {
    if (!isPlainObject(e)) continue;
    if (e.is_from_me === true) continue;
    if (typeof e.ts !== "number") continue;
    if (best === null || e.ts >= best.ts) best = e;
  }
  return best;
}

// ---------------------------------------------------------------------------
// diversifyByPlatform — a GENERIC per-platform diversity interleave. Takes the
// score-sorted, deduped rows and re-orders them so the visible window spans
// platforms instead of being saturated by whichever platform dominates the
// ledger. The rank order is PRESERVED WITHIN each platform; only the CROSS-
// platform interleave changes.
//
// ZERO platform-name branch: the grouping key is each row's own `platform` DATA
// field — we never compare it to a literal. Adding a platform changes nothing.
//
// Algorithm (a stable round-robin / "weave"):
//   1. Partition rows into buckets keyed by `platform`, each bucket keeping the
//      incoming (score-desc) order. First-seen platform order is the bucket order
//      (so the top-ranked platform leads each round — deterministic, rank-aware).
//   2. Repeatedly walk the buckets in that order, taking up to `perRound` rows
//      from each non-empty bucket per pass, until all buckets are drained.
// With perRound=1 this is strict round-robin (one per platform per pass): the #1
// thread of every platform precedes any platform's #2. The result is a permutation
// of the input (no row dropped, no row added); truncation to `limit` happens
// AFTER, on the interleaved order.
//
// WHAT A LARGER perRound DOES — AND DOES NOT — GUARANTEE (f7, corrected). The old
// text here read "a larger perRound lets a hot platform surface a small run before
// yielding — bounding (not eliminating) its dominance". That is only true of the
// FULL permutation. It is FALSE of the VISIBLE WINDOW, which is the thing the
// operator reads, and the shipped configuration used to land on the false side:
// the weave runs before truncation, so when a band's remaining slot budget is
// <= perRound the cut falls INSIDE the dominant bucket's very first run and the
// emitted window is byte-identical to pure rank. A fixed perRound therefore bounds
// dominance only at limits large enough to reach the first yield; below that it is
// a no-op, and it cannot know where that threshold is because it does not know the
// budget. Measured, on the frozen population named in the harness header: at a
// fixed perRound of 6 the weave was a NO-OP for every limit whose band budget was
// <= 6 (four of the eight swept limits) and only began to act above it.
//
// THE FIX IS TO DERIVE THE QUANTUM FROM THE BUDGET, not to pick a bigger number.
// Pass `perRound = null` plus the band's REMAINING slot budget; the quantum is then
// resolved in two steps (both spelled out at the code below):
//   (a) a band that FITS entirely inside its budget is not woven at all — nothing
//       is hidden, so there is nothing to protect and a weave would only invert
//       peers for free; and
//   (b) a band that SPILLS gets floor(budget / bucketCount), floored at
//       DIVERSITY_ROUND_ROBIN_FLOOR.
// So the interleave acts at every limit where it can help and stands down where it
// cannot, with no constant to inherit.
//
// THE PROPERTY THAT HOLDS AT THE SHIPPED CONFIGURATION, stated exactly, and true of
// BOTH branches: if a band's remaining budget is >= the number of distinct platform
// buckets in that band, EVERY one of those buckets contributes at least one row to
// the visible window. (Under (a) that is trivial — the whole band is emitted.)
// Nothing stronger is claimed: the buckets do NOT get equal shares once one of them
// runs dry, and the emitted order is not score-desc.
//
// @param {Array<{platform:string}>} rows — score-desc, deduped rows.
// @param {number|null} perRound — rows to take per platform per pass. An integer
//        >=1 is used verbatim (the explicit caller opt). <=0 or a non-integer =>
//        no interleave (pure rank), guarded here to a no-op copy. `null` => DERIVE
//        the quantum from `budget` and the bucket count, below.
// @param {number} budget — the caller's REMAINING slot budget for this band (the
//        limit minus the rows already emitted ahead of it). Read ONLY when
//        perRound is null.
// @returns {Array} a re-ordered copy (input not mutated).
// ---------------------------------------------------------------------------
function diversifyByPlatform(rows, perRound, budget = 0) {
  const list = Array.isArray(rows) ? rows : [];
  // An EXPLICIT quantum resolves now; `null` defers until the bucket count is known.
  const explicit = perRound === null
    ? null
    : (Number.isInteger(perRound) && perRound > 0 ? perRound : 0);
  // No interleave requested, or nothing to weave: return a shallow copy unchanged.
  if (explicit === 0 || list.length <= 1) return list.slice();

  // Partition into per-platform buckets, preserving incoming (score) order and
  // first-seen platform order. A null/absent platform is its own stable bucket
  // (keyed by the empty string) so a malformed row never crashes the weave.
  const order = [];
  const buckets = new Map();
  for (const r of list) {
    const key = r && typeof r.platform === "string" ? r.platform : "";
    let b = buckets.get(key);
    if (b === undefined) {
      b = [];
      buckets.set(key, b);
      order.push(key);
    }
    b.push(r);
  }
  // Single platform => interleave is a no-op; preserve the pure rank order.
  if (order.length <= 1) return list.slice();

  // THE DERIVED QUANTUM (perRound === null). Two steps, in this order.
  //
  // (1) A BAND THAT FITS ENTIRELY INSIDE ITS BUDGET IS NOT WOVEN AT ALL. Diversity
  //     exists to stop one bucket saturating the VISIBLE window; if every row in
  //     the band survives the cut, nothing is hidden and there is nothing to
  //     protect. Weaving anyway is pure cost: it inverts adjacent peers — emits a
  //     lower-scoring row above a higher-scoring one — and buys no visibility in
  //     exchange. Measured on the frozen population in the f7 harness header, this
  //     is not a corner case: the higher-priority band is 11 rows and fits inside
  //     EVERY limit swept, so at the shipped fixed quantum it paid 2 inverted
  //     adjacent pairs (score gaps 0.104 and 0.439 — the widest inversion anywhere
  //     in the surface) at every single limit, for zero rows gained.
  //
  // (2) Otherwise share the remaining budget evenly across the buckets ACTUALLY
  //     PRESENT in this band, so one full round costs at most the whole budget and
  //     every bucket is reached inside it. The floor is a CORRECTNESS bound, not a
  //     tuning knob: a take of 0 makes no progress, so it is named rather than
  //     inlined. A non-positive or non-finite budget floors to it too.
  //
  // An EXPLICIT quantum skips both steps and is honoured verbatim — a caller that
  // names a perRound is not asking for a policy, it is asking for that weave.
  const slots = Number.isFinite(budget) ? budget : 0;
  if (explicit === null && list.length <= slots) return list.slice();
  const take = explicit !== null
    ? explicit
    : Math.max(CATCHUP_CAPS.DIVERSITY_ROUND_ROBIN_FLOOR, Math.floor(slots / order.length));

  // Round-robin across buckets in first-seen (rank-led) order, `take` per pass.
  const out = [];
  const cursors = new Map(order.map((k) => [k, 0]));
  let remaining = list.length;
  while (remaining > 0) {
    for (const key of order) {
      const b = buckets.get(key);
      let i = cursors.get(key);
      for (let n = 0; n < take && i < b.length; n++, i++) {
        out.push(b[i]);
        remaining--;
      }
      cursors.set(key, i);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// buildCatchupCore — the PURE compute core. All engines are INJECTED function
// params (NOT imports) so the core is testable against fakes and free of any
// platform-aware import. Pure, total, never throws.
//
// @param {object} args
// @param {Array}  args.envelopes      — flat Envelope[] across all platforms.
// @param {(env)=>{score:number}} args.classify   — N2 classifier (injected).
// @param {(envs,opts)=>Array} args.attention     — N8 computeAttention (injected).
// @param {(platform,sender_id)=>string|null} args.resolvePerson — N7 (injected,
//        SOFT: when it returns null we fall back to `${platform}:${sender_id}`).
// @param {(person_id)=>Enrichment} args.enrichPerson — M1 (injected, BOUNDED,
//        CACHED). Defaults to the NEUTRAL enricher (anchor_factor=1.0 for every
//        person => ranking byte-identical to pre-M1). Called ONCE per candidate on
//        the RESOLVED person_id; its anchorFactor multiplies into rankScore as a
//        monotone UP-rank (never a hard-drop). NEVER a live call / mutable store.
// @param {(person_id, ctx)=>Persona} [args.personaResolver] — persona-surface's
//        OPTIONAL injection seam (mirrors enrichPerson). When EXPLICITLY injected it
//        resolves a read-only Persona attached as `row.persona` (purely additive
//        query-time DATA; NEVER enters rankScore/compareDesc, never reorders/drops).
//        When ABSENT (the production default) NOTHING is attached and rows are
//        BYTE-IDENTICAL to today. SOFT: a throwing resolver degrades that one row to
//        no persona (null => no attach); buildCatchupCore still never throws.
// @param {number} args.now            — epoch ms (injected; never read clock).
// @param {object} args.opts           — {limit, since_ms, platforms, min_score}.
// @returns {{rows, generated_at, stats}}
// ---------------------------------------------------------------------------
export function buildCatchupCore({
  envelopes,
  classify,
  attention,
  resolvePerson,
  enrichPerson,
  personaResolver,
  now,
  opts = {},
} = {}) {
  const nowMs = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const classifyFn = typeof classify === "function" ? classify : classifyDirectedAtMe;
  const attentionFn = typeof attention === "function" ? attention : computeAttention;
  // SOFT N7 edge: a missing/throwing resolver degrades to per-platform scope.
  const resolveFn = typeof resolvePerson === "function" ? resolvePerson : () => null;
  // M1: the injected person-enrichment resolver. DEFAULT = the NEUTRAL enricher
  // (anchor_factor=1.0 for every person => ranking byte-identical to pre-M1, the
  // gate-OFF safety). It is called ONCE per candidate on the resolved person_id;
  // never inside a scan, never against a live mutable store (deterministic tests).
  const enrichFn = typeof enrichPerson === "function" ? enrichPerson : makeNeutralEnricher();
  // persona-surface — the OPTIONAL persona INJECTION SEAM (mirrors enrichFn). A
  // resolver is attached to surfaced rows ONLY when EXPLICITLY injected; absent (the
  // production default) personaFn is null => NOTHING is attached => rows are byte-
  // identical to today. No import is needed for the gate-off default (a plain null);
  // importing the neutral resolver from persona-resolver.js would create a cycle (it
  // imports this file). Persona is purely additive: it never enters rank/dedup.
  const personaFn = typeof personaResolver === "function" ? personaResolver : null;

  const limit = Number.isInteger(opts.limit) && opts.limit > 0
    ? Math.min(opts.limit, CATCHUP_CAPS.MAX_LIMIT)
    : CATCHUP_CAPS.DEFAULT_LIMIT;
  const minScore = typeof opts.min_score === "number" && Number.isFinite(opts.min_score)
    ? opts.min_score
    : CATCHUP_CAPS.DEFAULT_MIN_SCORE;
  const sinceMs = Number.isInteger(opts.since_ms) && opts.since_ms > 0 ? opts.since_ms : null;
  const platformFilter = Array.isArray(opts.platforms) && opts.platforms.length > 0
    ? new Set(opts.platforms)
    : null;
  // Diversity interleave depth (rows per platform per round-robin pass). DATA-only
  // (a count, never a platform name). An EXPLICIT opts.max_per_platform wins
  // VERBATIM — including an explicit 0 and the sentinel `false`, which DISABLE the
  // interleave so the surface returns the pure rank order (back-compat for callers
  // that want it). When the key is ABSENT the quantum is `null` => DERIVED per tier
  // band from that band's own remaining slot budget, at the band loop below. There
  // is deliberately no inherited constant on this line: f7 measured that a fixed
  // default cannot know the budget and so is a silent no-op at small limits.
  const maxPerPlatform =
    opts.max_per_platform === false
      ? 0
      : Number.isInteger(opts.max_per_platform) && opts.max_per_platform >= 0
        ? opts.max_per_platform
        : null;
  // P2 reciprocity down-rank floor (CAPS-gated). DATA-only (a number, never a
  // platform name). Default from CAPS; opts.reciprocity_floor overrides in [0,1];
  // an explicit >=1 disables the down-rank (pure rank order, back-compat).
  // P2-REFINE: this floor IS the graded reciprocityStrength's BROADCAST_FLOOR (the
  // strongest down-rank — the A2P/marketing one-directional channel).
  const reciprocityFloor =
    typeof opts.reciprocity_floor === "number" && Number.isFinite(opts.reciprocity_floor)
      ? Math.max(0, Math.min(1, opts.reciprocity_floor))
      : CATCHUP_CAPS.RECIPROCITY_BROADCAST_FLOOR;

  const env = Array.isArray(envelopes) ? envelopes : [];

  // Index envelopes by their attention thread_key so, given an attention record,
  // we can recover that thread's envelopes to (a) read the latest inbound msg for
  // the classifier and (b) read its platform/sender for dedup + display. N8 keys
  // a DM thread on the resolved person (cross-platform DM dedup) when a resolver
  // is present, so we re-group with the SAME resolver to keep keys aligned.
  let attentionRecords = [];
  try {
    attentionRecords = attentionFn(env, {
      now: nowMs,
      classify: classifyFn,
      resolvePerson: (sender) =>
        resolveFn(
          sender && typeof sender.platform === "string" ? sender.platform : null,
          sender && typeof sender.id === "string" ? sender.id : null,
        ),
    });
  } catch {
    attentionRecords = [];
  }
  if (!Array.isArray(attentionRecords)) attentionRecords = [];

  const threadsConsidered = attentionRecords.length;

  // Build a thread_key -> envelopes[] index from the SAME grouping the attention
  // engine used, by replaying the attention record's source_msg_ids back onto the
  // envelope set. The attention record carries `source_msg_ids` of the trailing
  // inbound run and `thread_id`/`last_ts`; to read the latest inbound envelope we
  // match envelopes by source_msg_id (the join key back to L1).
  const envBySourceMsgId = new Map();
  for (const e of env) {
    if (isPlainObject(e) && typeof e.source_msg_id === "string") {
      envBySourceMsgId.set(e.source_msg_id, e);
    }
  }

  // ---- FILTER + per-thread candidate rows. ----
  const candidates = [];
  let afterFilter = 0;
  // e17 — rows this seat dropped because N8 graded their trailing inbound run a
  // CLOSER and this row carried no context evidence to rescue it. Counted so no
  // dropped row is unmeasurable (the drop used to be silent). See the substance
  // block below the tier classification.
  let droppedLowSubstance = 0;
  for (const rec of attentionRecords) {
    if (!isPlainObject(rec)) continue;

    // they-spoke-last: the half of the N8 conjunction that is a STRUCTURAL fact
    // about the thread (the last envelope is inbound), so it stays here, at the
    // top of the filter, where it costs nothing to evaluate.
    //
    // e17 — THE SUBSTANCE HALF MOVED. It used to be tested on this same line, one
    // expression away from `rec.unanswered`, and that placement was the bug: it
    // decided "this message needs no reply" from N8's text grade ALONE, before
    // this loop had recovered the row's enrichment, its reciprocity or its tier —
    // i.e. before it knew whether the message came from someone the operator has
    // saved, or whether the inbound run was ANSWERING something the operator sent.
    // The decision now lives below the enrichment/reciprocity/tier block, where
    // that context is in hand. Nothing about N8 changed: `substanceOfLastInboundRun`,
    // ATTENTION_CAPS.SUBSTANCE_FLOOR and the `surface` flag are untouched.
    const theySpokeLast = rec.unanswered === true;
    if (!theySpokeLast) continue;

    // Recover the trailing-run envelopes for this record to read the latest
    // inbound message (the classifier's input) and the platform/sender for
    // dedup + display. source_msg_ids is the trailing inbound run, ascending.
    const runEnvelopes = Array.isArray(rec.source_msg_ids)
      ? rec.source_msg_ids
          .map((id) => envBySourceMsgId.get(id))
          .filter((e) => isPlainObject(e))
      : [];
    const latest = latestInboundEnvelope(runEnvelopes)
      // Fallback: the record's last_sender on a synthetic single-message run.
      || (runEnvelopes.length > 0 ? runEnvelopes[runEnvelopes.length - 1] : null);
    if (latest === null) continue;

    const platform = typeof latest.platform === "string" ? latest.platform : null;
    if (platform === null) continue;

    // N11 (A2): exclude a row whose latest inbound sender is non-person
    // (bot/service/system). Read as DATA off sender.kind — never a platform name.
    if (!isPersonSender(latest)) continue;

    // Platform filter (DATA membership test — NOT a platform-name branch).
    if (platformFilter && !platformFilter.has(platform)) continue;

    // since_ms window over the last inbound ts. C2 pins the DECIDED SEMANTICS:
    // a THREAD qualifies by its LAST-ACTIVITY (latest inbound) ts — the natural
    // reading of the tool's "since_ms" — and THIS check is the authoritative
    // enforcement point (query time, after envelope load). A thread whose last
    // inbound message predates now - since_ms is never RETURNED, and because
    // the drop happens BEFORE afterFilter increments, stats.after_filter stays
    // honest. Rows older than the cutoff may still inform query-time context
    // (personas / identity) for the threads that DO qualify; the pre-corpus
    // ledger cutoff in loadSourcesFromLedgers is a bounded-READ optimization of
    // the same window, never a substitute for this filter (the C1 projection
    // stores a parameter-independent tail and applies the caller's cutoff at
    // query time through the same fold — gate: catchup-since-ms.test.mjs).
    // Data hygiene: clamp a corrupt/implausible
    // ts at read time (a ~epoch-0 parse artifact must not floor a real contact's recency);
    // fall back to the record's tracked last_ts, else keep the raw value (recencyFactor's
    // floor). Rendered tier-order is unaffected — this is raw-score hygiene only.
    const rawLatestTs = typeof latest.ts === "number" ? latest.ts : rec.last_ts;
    const lastInboundTs = plausibleTs(rawLatestTs, nowMs) ?? plausibleTs(rec.last_ts, nowMs) ?? rawLatestTs;
    if (sinceMs !== null && typeof lastInboundTs === "number" && lastInboundTs < nowMs - sinceMs) {
      continue;
    }

    // Directedness: re-run N2 on the ACTUAL latest inbound message so the rank's
    // directedness and the min_score filter read the live classifier score.
    let directed = 0;
    try {
      const c = classifyFn(latest);
      directed = c && typeof c.score === "number" ? c.score : 0;
    } catch {
      directed = 0;
    }
    if (directednessFactor(directed) < minScore) continue;

    // e17 — `afterFilter` USED TO BE INCREMENTED HERE. It moved to just above
    // candidates.push, below the substance decision, because the substance drop is
    // now the LAST filter: incrementing before it would make stats.after_filter
    // count rows that never reach the surface. The identity the counter has always
    // had — after_filter === candidates.length — is preserved exactly.

    const senderId = latest.sender && typeof latest.sender.id === "string" ? latest.sender.id : null;
    // DEDUP key: N7 person-id; SOFT fallback to `${platform}:${sender_id}`.
    let personId = null;
    try {
      personId = resolveFn(platform, senderId);
    } catch {
      personId = null;
    }
    const dedupKey = (typeof personId === "string" && personId.length > 0)
      ? personId
      : `${platform}:${senderId === null ? "" : senderId}`;

    // M1 — PERSON ENRICHMENT (the who-matters anchor). Call the injected resolver
    // ONCE on the EFFECTIVE person identity (the SAME opaque `dedupKey` used to
    // collapse a person — the resolved N7 person_id when present, else the soft
    // `${platform}:${sender_id}` fallback), a CACHED O(1) lookup — never a scan,
    // never a live store. SOFT-guard: any throw / odd result degrades to the
    // NEUTRAL enrichment (anchor_factor=1.0 => no-op). anchorFactor is a MONOTONE
    // up-rank multiplier in [1, MAX]: anchored people UP-rank; cold/unknown stay at
    // the existing floor (NEVER a hard-drop).
    let enrichment = null;
    try {
      enrichment = enrichFn(dedupKey);
    } catch {
      enrichment = null;
    }
    const anchor = anchorFactor(enrichment);

    // e17 — THE SECOND READING OF THE AGE IS GONE. This seat used to compute an
    // `ageMs` (preferring the attention record's `rec.staleness.ms`, falling back
    // to nowMs - lastInboundTs) purely to feed rankScore's staleness factor. Those
    // two expressions are the same quantity for a they-spoke-last thread, which is
    // why the factor was deleted; with it gone the local is dead, so it is deleted
    // rather than left computed-and-unused. ONE CONSEQUENCE, deliberate: the time
    // term now reads `lastInboundTs`, which plausibleTs has already clamped, so a
    // corrupt ~epoch-0 timestamp can no longer enter the score through the
    // unclamped `rec.staleness.ms` path. `rec.staleness` is still emitted by N8
    // and still read by N8's own consumers; this surface simply no longer scores
    // on it.

    // P2 — reciprocity (the first persona attribute), read off the attention
    // record as DATA. Absent (old record) => treat as zero-reciprocity (the
    // conservative reading; an un-annotated row gets the soft down-rank, never
    // dropped). reciprocated drives the SOFT rank factor below.
    const reciprocity = isPlainObject(rec.reciprocity) ? rec.reciprocity : null;
    const reciprocated = reciprocity ? reciprocity.reciprocated === true : false;

    // -----------------------------------------------------------------------
    // e7 — THE VOUCH OVERRIDES THE WINDOW.
    //
    // WHAT no_reciprocity ACTUALLY MEANS HERE (the product decision, written down
    // because the code was making it implicitly): reciprocityOfThread counts
    // is_from_me over the envelopes THIS BUILD LOADED. The loaded set is a bounded
    // per-source TAIL — ledgerRetainCap(limit) (this file) retains the last
    // LEDGER_RETAIN_MULTIPLE × limit rows of each source ledger. So
    // outbound_count === 0 states "you did not reply INSIDE THE READ WINDOW"; it
    // does NOT state "you have never replied". reciprocityStrength's broadcast
    // branch nevertheless spends its strongest down-rank (the floor, the treatment
    // reserved for an A2P/marketing blast) on exactly that absence — turning
    // absence of evidence into a verdict.
    //
    // The M2 vouch is INDEPENDENT of that window: `is_contact` is decided by a
    // saved-contact join, not by a count over the loaded tail, so it cannot be
    // truncated by a tail read. classifyTier (below) already treats it as
    // SUFFICIENT evidence of a relationship, admitting a vouched person to
    // TIER.RELATIONSHIP with no reciprocity at all — yet the SAME row was still
    // being multiplied by the broadcast floor, so the surface asserted "this is a
    // relationship" and "this is a marketing channel" about one person at once.
    //
    // WHAT `is_contact` IS, EXACTLY — the three sources, named, because an earlier
    // revision of this comment attributed the signal to the address book alone and
    // that was measurably wrong about the very row it cited. contacts-anchor.js widens
    // its index with contact-spine.js's SPINE_SOURCES REGISTRY, which today holds
    // exactly three readers (pinned by a registered test in p2-reciprocity.test.mjs
    // so appending a fourth cannot leave this paragraph stale):
    //   - "address-book"        the operator's system address book. A CURATED
    //                           human act.
    //   - "messaging-contacts"  a messaging client's saved-contact mirror. Also
    //                           curated.
    //   - "reply-history"       DERIVED, not curated: addresses the operator has
    //                           WRITTEN TO, at REPLY_HISTORY_MIN_MESSAGES = 1
    //                           outbound message (contact-spine.js). One reply is
    //                           enough to enter the spine.
    //
    // THE TWO COVERAGE BOUNDS reply-history documents about itself, recorded here
    // because they bound what this floor can ever reach. (Stated STRUCTURALLY, by
    // symbol — this file's standing invariant is that it names no platform, and
    // the bound is a property of which LEDGER is read, not of any platform name.)
    //   (1) IT IS SINGLE-SOURCE. It reads exactly ONE source ledger — the one
    //       contact-spine.js names as DEFAULT_MAIL_LEDGER_PATH — so it can never
    //       vouch a sender who appears only in the OTHER source ledgers, no matter
    //       how much the operator has replied to them there. Two of the three
    //       readers are therefore silent for most of ADAPTER_REGISTRY.
    //   (2) IT IS BOUNDED BY THAT CONNECTOR'S OWN HISTORY. Rows written before the
    //       connector's recipient-recovery fix carry no recipient headers at all,
    //       so they contribute nothing until re-ingested (contact-spine.js records
    //       this on readReplyHistoryContacts itself).
    //
    // WHAT THE VOUCH IS AND IS NOT EVIDENCE OF. It proves the person is not
    // spam-that-looks-human — which is the exact hazard the down-rank was built
    // for (see the RECIPROCITY_FLOOR comment in CATCHUP_CAPS). It does NOT prove
    // depth of history. So the vouch raises this row's floor to
    // RECIPROCITY_NEW_CONTACT_NEUTRAL — the constant CAPS already defines as "a
    // real human, no measured relationship history yet", which is precisely the
    // epistemic state of a vouched correspondent whose replies fall outside the
    // window. It is applied through reciprocityStrength's OWN floor parameter, so
    // no new threshold and no bare literal enters the scoring path, and the grader
    // stays a pure function of the counts.
    //
    // BOUNDS THIS RESPECTS:
    //   - MONOTONE UP-RANK ONLY. The floor can only rise, and every branch of
    //     reciprocityStrength is non-decreasing in the floor, so a row's term can
    //     only rise. Nothing is dropped, nothing is down-ranked.
    //   - IT DOES NOT FLATTEN THE GRADING. A vouched person who DOES have measured
    //     history keeps the higher value the counts earned (the floor is a floor);
    //     only rows the grader put BELOW the neutral — the broadcast and graded-
    //     middle verdicts — move, and they move exactly to the neutral.
    //   - TIER-PRESERVING AND MONOTONE — the bound that is provable, replacing an
    //     earlier absolute ("cannot promote a stranger") that overstated it. The
    //     lift keys on enrichment.is_contact, the SAME signal classifyTier branch
    //     (a) reads, so every row it can touch is ALREADY in TIER.RELATIONSHIP;
    //     and ORDER_KEY_SEQUENCE declares KEY_TIER first, strictly above the key
    //     this lift can reach. The lift therefore re-orders rows only WITHIN
    //     the relationship tier and cannot move a row across a tier boundary in
    //     either direction. What it does NOT claim: that everything `is_contact`
    //     admits is a person the operator would call a relationship — that is a
    //     property of the SOURCES above, not of this arithmetic.
    //   - GATE-OFF BYTE-IDENTITY. makeNeutralEnricher (the default when no
    //     `anchor` is wired) returns NEUTRAL_ENRICHMENT, whose is_contact is
    //     false, so `vouched` is false and this row's floor is the caller's floor
    //     unchanged.
    //
    // F7-2 — THE PRODUCT DECISION ABOUT SAVED BUSINESSES, recorded ONCE, here,
    // NOW FROM THE MEASUREMENT INSTEAD OF FROM AN ASSUMPTION. Measured over the
    // full 401-thread deduped population by e7-catchup-join-eval.mjs
    // `--vouch-source`, which iterates SPINE_SOURCES itself and joins each source's
    // normalized handles onto the vouched rows: all 11 relationship rows enter
    // through classifyTier branch (a), and their vouching sources are
    //   address-book+messaging-contacts 3 · messaging-contacts 4 ·
    //   address-book 2 · reply-history 2.
    // `Example Harbour Hotel` is one of the reply-history two: it is NOT in any
    // address book. It is in the spine because the operator sent 24 outbound
    // messages to its reservations address. So the hotel's tier was bought by the
    // operator's own replies, not by a curation act — and that is a STRONGER
    // vouch, not a weaker one, which is why the earlier address-book reading of
    // this row was both wrong and flattering.
    //
    // THAT IT IS ELIGIBLE FOR THE FLOOR IS STILL INTENDED. A correspondent the
    // operator has written to 24 times is a correspondent they chose to keep, and
    // this seat has no evidence that outranks that act. The alternative — inferring
    // "business" from a sender domain, a display name, or a platform — is exactly
    // the sender-domain blocklist this node is forbidden to build: it would be a
    // guess layered on top of a fact, and it would silently demote the operator's
    // own correspondents (a hard-drop in effect, violating MONOTONE UP-RANK ONLY).
    // If a saved business must ever rank below a saved individual, the separating
    // evidence is an is_org/entity-kind signal carried on the CONTACT record by the
    // M2 join (person-enrichment.js `enrichment`), decided at that seat where the
    // source's own typing is in hand — never re-derived from the message here.
    //
    // THE THRESHOLD IS PUBLISHED, NOT PICKED. REPLY_HISTORY_MIN_MESSAGES stays at
    // its shipped 1. The decision table (`--min-messages 1,2,3,5`, one frozen
    // snapshot on every side, all 401 threads) says raising it costs one row and
    // buys nothing here: N=1 -> 11 vouched rows; N in {2,3,5} -> 10, with ONE tier
    // crossing, always the same one and always DOWNWARD (`Example, Alex`, a single
    // outbound message, out of relationship), 9 rows up / 1 down / 391 unchanged,
    // and zero crossings into relationship. The hotel is unaffected at every N
    // because its count is 24. Moving the number is the operator's call, made
    // against that table — not a side effect of this diff.
    //
    // SNAPSHOT PROVENANCE FOR EVERY FIGURE ABOVE (e9 stamp; nothing removed, only
    // identified). They all come from ONE frozen snapshot, pinned by its clock:
    //     now = 1787172615822  (2026-08-19T20:50:15.822Z), deduped population 401
    // The per-source identity of that snapshot — {dev_ino, size, mtime_ms} for each
    // of the four ADAPTER_REGISTRY ledgers — is written out in full at the
    // harness's own MEASURED, ROUND 3 header (that file is the seat allowed to name
    // sources; this one is not). Reproducing it is two commands, in this order:
    //     node mcp/test/messaging/e7-catchup-join-eval.mjs --snapshot <file>
    //     node mcp/test/messaging/e7-catchup-join-eval.mjs --sources <file> \
    //          --min-messages 1,2,3,5
    // The first FREEZES the bytes; every later command must be handed
    // `--sources <that file>` or it measures ledger growth instead of the code.
    //
    // Churn output depends on the pinned source bytes and clock. If a later run
    // differs, compare the snapshot identities before calling it a regression;
    // append-only source growth changes which rows moved even when the rule did
    // not change.
    // -----------------------------------------------------------------------
    const vouched = isPlainObject(enrichment) && enrichment.is_contact === true;
    const rowReciprocityFloor = vouched
      ? Math.max(reciprocityFloor, CATCHUP_CAPS.RECIPROCITY_NEW_CONTACT_NEUTRAL)
      : reciprocityFloor;

    // P2-REFINE — GRADED relationship strength from the counts (turn_count is the
    // PRIMARY signal; inbound VOLUME discriminates broadcast vs new-contact at low
    // turns). A null block degrades to zero-history (the new-contact neutral, the
    // conservative reading). Surfaced on the row as a persona attribute.
    const reciprocityStrengthValue = reciprocityStrength(
      reciprocity || { turn_count: 0, outbound_count: 0, inbound_count: 0 },
      rowReciprocityFloor,
    );

    const baseScore = rankScore({
      lastInboundTs,
      directed,
      now: nowMs,
      reciprocated,
      reciprocity: reciprocity || { turn_count: 0, outbound_count: 0, inbound_count: 0 },
      // e7 — the SAME per-row floor the surfaced reciprocity_strength was graded
      // with. THAT CLAIM COVERED EXACTLY TWO COPIES: the `reciprocity_strength`
      // emitted on the row and the reciprocity term folded into `score`. Both are
      // this one `reciprocityStrengthValue`, graded once above, so those two can
      // not diverge.
      //
      // e9 — A THIRD COPY EXISTED ON THE SAME EMITTED ROW and was NOT covered:
      // `row.persona.relationship.reciprocity_strength` (and, alongside it,
      // `row.persona.relationship.tier`). The persona resolver re-derived both from
      // the per-person projection, without this per-row floor and without this
      // row's enrichment, so a vouched row could read 0.7 / "relationship" on the
      // row and 0.3 / "unknown" on its own persona. The persona copy is now the
      // SAME VALUE BY CONSTRUCTION — a single producer (this seat) grades it once
      // and hands the RESULT to the resolver on the ctx below — rather than by the
      // coincidence of two derivations agreeing.
      reciprocityFloor: rowReciprocityFloor,
      // M1 — the monotone UP-rank anchor (1.0 neutral by default => no-op).
      anchor,
    });

    const personName = latest.sender && typeof latest.sender.name === "string"
      ? latest.sender.name
      : null;

    // M5/M5c — the honest TIER. Classify this candidate from the who-matters
    // signals: the enrichment's is_contact (M2) / feedback_score (M3) PLUS the
    // per-thread reciprocity_strength (P2r) AND the latest inbound sender.kind.
    // "relationship" = a saved contact, OR positive feedback, OR a deep HIGH-turn
    // two-way history with a PERSON (reciprocity_strength >= RELATIONSHIP_RECIP_MIN
    // AND sender.kind === "person"). "unknown" = everything else — a cold node (a
    // genuine new contact, spam, a moderate-reciprocity business — the message
    // cannot tell them apart). M5c: a moderate-reciprocity business (≈0.77 < the
    // high threshold) is DEMOTED here from relationship to unknown. The UNKNOWN tier
    // is surfaced + labeled + ranked BELOW relationships, NEVER dropped (the hard
    // constraint). RELATIONSHIP_RECIP_MIN is injected as DATA (no platform branch);
    // sender_kind is read agnostically off the envelope (latest.sender.kind).
    const senderKind = latest.sender && typeof latest.sender.kind === "string"
      ? latest.sender.kind
      : "person";
    const tier = classifyTier(
      {
        is_contact: isPlainObject(enrichment) ? enrichment.is_contact === true : false,
        reciprocity_strength: reciprocityStrengthValue,
        feedback_score: isPlainObject(enrichment) && Number.isFinite(enrichment.feedback_score)
          ? enrichment.feedback_score
          : 0,
        sender_kind: senderKind,
      },
      { recip_min: CATCHUP_CAPS.RELATIONSHIP_RECIP_MIN },
    );

    // -----------------------------------------------------------------------
    // e17 — THE SUBSTANCE DECISION, MADE WITH THE ROW'S CONTEXT IN HAND.
    //
    // N8 grades the trailing inbound run's TEXT and sets `substance.isCloser`
    // when that text scores at or below ATTENTION_CAPS.SUBSTANCE_FLOOR. That grade
    // is a property of the words alone, and it is correct about the words: "ok",
    // "thanks!", "👍" close a conversation. It becomes wrong when it is the ONLY
    // input to a DROP, because the same three characters mean different things
    // depending on who sent them and what they answer — and this seat, unlike N8,
    // knows who sent them.
    //
    // THE RESCUE KEYS — the smallest evidence set, both ALREADY COMPUTED ABOVE
    // for other reasons, neither of them a new signal and neither of them the text:
    //   (i)  enrichment.is_contact === true — the saved-contact vouch. This is the
    //        SAME signal classifyTier branch (a) already treats as sufficient
    //        evidence of a relationship, and the same signal the e7 vouch lift
    //        already treats as sufficient to raise a row's reciprocity floor. If it
    //        is enough to call someone a relationship, it is enough to keep their
    //        short message on the list.
    //   (ii) reciprocity.last_outbound_ts !== null — the operator has written into
    //        this thread. Because N8's trailing inbound run STOPS at the first
    //        outbound, a non-null last-outbound means this run came AFTER something
    //        the operator sent: the short message ANSWERS them. That is exactly the
    //        measured "no money" case — a one-word reply to the operator's own
    //        question, dropped as a closer.
    //
    // WHAT WAS REJECTED, AND WHY — recorded so the next reader does not re-propose:
    //   - MEDIA / ATTACHMENT PRESENCE ("a photo with no caption is not a closer").
    //     The L1 Envelope contract has NO media or attachment field — `content` is
    //     `string|null` — so this rescue would require an L1 change, which N9 is
    //     forbidden to make. It is a real gap and it is not this node's to close.
    //   - `directed`. It is ALREADY the min_score filter AND already a rankScore
    //     factor. Reusing it a third time here would be the same defect the time
    //     term was just fixed for: one signal spent at two seats, double-counted.
    //   - `reciprocity_strength` as a rescue key. Same double-count — it is the
    //     reciprocity term in the score already. Note the rescue uses
    //     `last_outbound_ts`, which is a FACT about the thread, not the graded
    //     strength derived from it.
    //
    // THE ACTION IS THE IMPORTANT HALF: a rescued row is KEPT and DOWN-RANKED,
    // never silently kept at full weight and never silently dropped. Its score is
    // multiplied by a substance term derived from `rec.substance.score` — which N8
    // already graded into [0,1] and already put on the record, so this seat does NOT
    // re-grade any text — and a `low_substance` token is pushed into the row's
    // reasons so the row explains itself on the surface.
    //
    // A row with NO context evidence keeps today's behaviour and is dropped. What
    // changes is that the drop is COUNTED (`stats.dropped_low_substance`) instead
    // of being invisible.
    //
    // THE ALTERNATIVE NOT TAKEN — keep every closer, drop nothing — is refused on
    // the POPULATION, not on the rule: on the frozen snapshot the context-gated
    // rescue admits 3 rows and displaces none, while the ungated version would
    // admit all 51 — the same 3 plus 48 whose only evidence is that a sender the
    // operator has never saved and never written to said a word. The full table
    // is quoted at CATCHUP_CAPS.SUBSTANCE_LOW_FACTOR_MIN and reproduced by
    // `e7-catchup-join-eval.mjs --sources <snap> --substance`.
    // -----------------------------------------------------------------------
    const lowSubstance = isPlainObject(rec.substance) && rec.substance.isCloser === true;
    const vouchedContact = isPlainObject(enrichment) && enrichment.is_contact === true;
    const answersOutbound = reciprocity !== null && typeof reciprocity.last_outbound_ts === "number";
    if (lowSubstance && !vouchedContact && !answersOutbound) {
      droppedLowSubstance += 1;
      continue;
    }
    // The DOWN-RANK. substanceFactor is monotone in the graded score and bounded
    // strictly above 0, so a rescued row moves DOWN within its tier and can never
    // be zeroed out of existence. A substantive row multiplies by exactly 1.
    const score = lowSubstance
      ? baseScore * substanceFactor(isPlainObject(rec.substance) ? rec.substance.score : 0)
      : baseScore;

    // persona-surface — resolve this row's read-only Persona on the SAME opaque
    // `dedupKey`, ONLY when a personaResolver was EXPLICITLY injected. Evaluated HERE
    // (after tier/reciprocity/anchor are known) so the context object can carry them.
    // SOFT-guard: any throw / odd resolver degrades THIS row to persona=null (no
    // attach) — never a crash. When personaFn is null (the gate-OFF default) we skip
    // entirely and attach nothing, keeping the row byte-identical. Persona is purely
    // ADDITIVE context: it is NOT read by rankScore, compareDesc, or the dedup below.
    //
    // e9 — SINGLE PRODUCER. The ctx carries the two graded quantities THIS seat
    // already computed for THIS row: `tier` (classified above from this row's
    // enrichment) and `reciprocity_strength` (graded above against this row's
    // floor). A resolver that honours them surfaces the row's own numbers instead
    // of re-deriving a second, per-person answer that can disagree with the row it
    // rides on. Passing a value is not a new seam — this ctx object already
    // existed and is already evaluated after tier/reciprocity/anchor are known.
    let persona = null;
    if (personaFn !== null) {
      try {
        persona = personaFn(dedupKey, {
          enrichment,
          tier,
          reciprocity,
          anchor,
          reciprocity_strength: reciprocityStrengthValue,
        });
      } catch {
        persona = null;
      }
    }

    // e17 — the counter moved here from above the enrichment block, so that
    // after_filter counts exactly the rows that become candidates (the identity
    // after_filter === candidates.length, unchanged) now that the substance drop
    // is the last filter.
    afterFilter += 1;

    candidates.push({
      dedup_key: dedupKey,
      person_id: (typeof personId === "string" && personId.length > 0) ? personId : null,
      person_name: personName,
      platform,
      thread_id: typeof rec.thread_id === "string" ? rec.thread_id : (typeof latest.thread_id === "string" ? latest.thread_id : null),
      thread_type: typeof latest.thread_type === "string" ? latest.thread_type : (typeof rec.thread_type === "string" ? rec.thread_type : null),
      last_msg: typeof latest.content === "string" ? latest.content : null,
      ts: typeof lastInboundTs === "number" ? lastInboundTs : null,
      score,
      // P2-REFINE — the GRADED relationship strength (a persona attribute) in
      // [BROADCAST_FLOOR, RELATIONSHIP_MAX]. The very factor folded into `score`.
      reciprocity_strength: reciprocityStrengthValue,
      // M1 — the who-matters anchor (a persona attribute). anchor_factor is the
      // MONOTONE up-rank multiplier in [1, MAX] folded into `score` (1.0 = neutral
      // => no-op, the gate-OFF default). The enrichment bundle surfaces the
      // signals (is_contact / reciprocity_strength / feedback_score) for the row.
      anchor_factor: anchor,
      // M5 — the honest first-class TIER ("relationship" | "unknown"). The UNKNOWN
      // tier surfaces strangers (incl genuine new contacts) below relationships,
      // labeled — NEVER dropped. The PRIMARY ranking key (tier before score).
      tier,
      enrichment: isPlainObject(enrichment)
        ? {
            person_id: typeof enrichment.person_id === "string" ? enrichment.person_id : null,
            is_contact: enrichment.is_contact === true,
            reciprocity_strength: Number.isFinite(enrichment.reciprocity_strength) ? enrichment.reciprocity_strength : 0,
            feedback_score: Number.isFinite(enrichment.feedback_score) ? enrichment.feedback_score : 0,
            anchor_factor: anchor,
          }
        : { person_id: null, is_contact: false, reciprocity_strength: 0, feedback_score: 0, anchor_factor: anchor },
      // P2 — surface reciprocity on the row (the first persona attribute). A
      // null reciprocity record degrades to an explicit zero-reciprocity shape.
      reciprocity: reciprocity
        ? {
            reciprocated: reciprocity.reciprocated === true,
            outbound_count: Number.isFinite(reciprocity.outbound_count) ? reciprocity.outbound_count : 0,
            inbound_count: Number.isFinite(reciprocity.inbound_count) ? reciprocity.inbound_count : 0,
            turn_count: Number.isFinite(reciprocity.turn_count) ? reciprocity.turn_count : 0,
            last_outbound_ts: typeof reciprocity.last_outbound_ts === "number" ? reciprocity.last_outbound_ts : null,
          }
        : { reciprocated: false, outbound_count: 0, inbound_count: 0, turn_count: 0, last_outbound_ts: null },
      reasons: buildReasons({ theySpokeLast, lowSubstance, directed, reciprocated }),
      // persona-surface — attach the resolved Persona ONLY when a resolver was
      // injected AND returned one (non-null). The gate-OFF default never adds this
      // key, so the row stays byte-identical to today. Additive query-time DATA only.
      ...(persona != null ? { persona } : {}),
    });
  }

  // ---- RANK (descending), under DEFAULT_COMPARE_DESC — the one comparator this
  // module constructs, whose key order is declared once as ORDER_KEY_SEQUENCE and
  // whose per-key meaning (including the M5b saved-contact vouch and KEY_SCORE's
  // totality clamp) is argued at that declaration. Nothing about the order is
  // restated here. ----
  candidates.sort(DEFAULT_COMPARE_DESC);

  // ---- DEDUP by person. `candidates` is already sorted by DEFAULT_COMPARE_DESC,
  // so the FIRST member of a person's group encountered here becomes the HEAD and
  // the rest attach as `also_waiting_on[]`. The collapse is what makes a
  // cross-platform human appear once with their per-platform thread refs
  // attached.
  //
  // NAME THE REAL KEY. The head is the DEFAULT_COMPARE_DESC-first member, under
  // the key order ORDER_KEY_SEQUENCE declares — go read that constant; it is not
  // re-listed here. What matters at THIS seat is the consequence: the head is NOT
  // "the highest-scoring member". A lower-scoring member in a stronger tier heads
  // the group, and among members whose scores collide EXACTLY (the majority of the
  // pinned band, where the time term is a constant) the tiebreak below KEY_SCORE
  // decides it. Every "carried from the head" comment below means that key order
  // and not a maximum over scores. ----
  const byKey = new Map(); // dedup_key -> head row
  for (const c of candidates) {
    const head = byKey.get(c.dedup_key);
    if (head === undefined) {
      byKey.set(c.dedup_key, {
        person: c.person_id || c.person_name || c.dedup_key,
        person_id: c.person_id,
        person_name: c.person_name,
        platform: c.platform,
        thread_id: c.thread_id,
        thread_type: c.thread_type,
        last_msg: c.last_msg,
        ts: c.ts,
        score: c.score,
        // P2-REFINE — the graded strength, carried from the compareDesc head.
        reciprocity_strength: c.reciprocity_strength,
        // P2 — the first persona attribute, carried from the compareDesc head.
        reciprocity: c.reciprocity,
        // M1 — the who-matters anchor, carried from the compareDesc head. 1.0 =
        // neutral (gate-OFF default => byte-identical). enrichment surfaces signals.
        anchor_factor: c.anchor_factor,
        enrichment: c.enrichment,
        // M5 — the honest TIER, carried from the compareDesc head. A later member
        // with a STRONGER tier (relationship over unknown) promotes the head below
        // (the person collapses to their best who-matters tier across platforms).
        tier: c.tier,
        reasons: c.reasons,
        // persona-surface — carry the persona from the compareDesc head (consistent
        // with enrichment/tier/reciprocity carriage). Only present when a resolver
        // was injected; absent => no key => byte-identical head row.
        ...(c.persona != null ? { persona: c.persona } : {}),
        platforms: [c.platform],
        also_waiting_on: [],
      });
    } else {
      // candidates are in compareDesc order, so the head is already this person's
      // compareDesc-first member; the current one is a secondary platform/thread
      // for the same person.
      if (!head.platforms.includes(c.platform)) head.platforms.push(c.platform);
      // M5 — promote the head's tier to its BEST across members (a person who is a
      // relationship on ANY platform is a relationship on the collapsed row). Never
      // demote (tierRank lower = stronger). NEVER drops the row either way.
      //
      // e9 — PROMOTE THE PERSONA'S TIER AT THE SAME SEAT. The head's persona was
      // carried from the compareDesc head and carries THAT member's tier; promoting
      // only `head.tier` would re-open, at the collapse, exactly the row-vs-persona
      // tier divergence the single-producer ctx just closed. Rebuilt via
      // normalizePersona (the persona is frozen — it is replaced, never mutated) and
      // soft-guarded: a failure leaves the carried persona untouched.
      //
      // HONEST ABOUT REACH: candidates were sorted by DEFAULT_COMPARE_DESC, and
      // ORDER_KEY_SEQUENCE declares KEY_TIER first — so the head of a dedup group
      // ALREADY holds the strongest
      // tier among its members and this branch does not fire today. It is kept
      // because the promotion it guards is written here and would silently
      // desynchronise the persona the moment the sort key changed; keeping the two
      // in lockstep at the one seat that can move the tier costs nothing.
      //
      // reciprocity_strength is deliberately NOT promoted: it is a PER-THREAD
      // quantity and the head already carries the compareDesc head's own copy,
      // which is the same copy `head.reciprocity_strength` holds. Inventing a
      // cross-member maximum would create a number no thread produced.
      if (tierRank(c.tier) < tierRank(head.tier)) {
        head.tier = c.tier;
        if (head.persona != null) {
          try {
            head.persona = normalizePersona(
              { ...head.persona, relationship: { ...head.persona.relationship, tier: c.tier } },
              head.person_id,
            );
          } catch {
            /* keep the carried persona verbatim */
          }
        }
      }
      head.also_waiting_on.push({
        platform: c.platform,
        thread_id: c.thread_id,
        thread_type: c.thread_type,
        ts: c.ts,
        score: c.score,
        last_msg: c.last_msg,
      });
      // Prefer a non-null person_name on the head if it lacked one.
      if (head.person_name === null && c.person_name !== null) head.person_name = c.person_name;
    }
  }

  // Emit rows in head order (the map preserves first-insertion order, and heads
  // were inserted in rank order, so the rows are already ranked). Re-sort
  // defensively to guarantee a stable base — literally the SAME function object
  // (DEFAULT_COMPARE_DESC, constructed once at module load), so the head chosen
  // above and the position emitted here can never disagree.
  let rows = Array.from(byKey.values());
  rows.sort(DEFAULT_COMPARE_DESC);

  const afterDedup = rows.length;

  // DIVERSITY INTERLEAVE (generic; no platform branch). Re-order the score-desc
  // rows so the visible window spans platforms instead of being saturated by the
  // dominant one (when a single platform's ledger floods the corpus). Rank order
  // is preserved WITHIN each platform; only the cross-platform weave changes.
  // Applied BEFORE the truncation so the cut keeps a representative slice, not the
  // top-N of one platform. A maxPerPlatform of 0 disables it (pure rank order); a
  // maxPerPlatform of null asks for the BUDGET-DERIVED quantum (the shipped path).
  //
  // TIER-BANDED: the weave runs WITHIN each tier band (in tierRank order), never
  // across bands — so the cross-platform interleave can NEVER lift an UNKNOWN above a
  // RELATIONSHIP. Tier stays the primary key the operator sees; diversity only
  // re-orders peers within a tier. (tierRank is DATA, not a platform branch.)
  //
  // f7 — THE BUDGET IS THREADED INTO THE LOOP. Bands are consumed in tierRank order
  // and the truncation to `limit` happens below, so the slots a band can actually
  // occupy are `limit` minus everything already woven ahead of it. Passing that
  // REMAINING budget lets each band size its own quantum against the window it will
  // really get, instead of against a constant that knows nothing about `limit`.
  if (maxPerPlatform !== 0) {
    const bands = new Map(); // tierRank -> rows[] (contiguous; rows are tier-sorted)
    for (const r of rows) {
      const k = tierRank(r.tier);
      let b = bands.get(k);
      if (b === undefined) { b = []; bands.set(k, b); }
      b.push(r);
    }
    const woven = [];
    for (const k of [...bands.keys()].sort((a, b) => a - b)) {
      const remainingBudget = limit - woven.length;
      for (const r of diversifyByPlatform(bands.get(k), maxPerPlatform, remainingBudget)) woven.push(r);
    }
    rows = woven;
  }

  const truncated = rows.length > limit;
  if (truncated) rows = rows.slice(0, limit);

  const platformsInResult = new Set();
  // M5 — tally the honest tiers in the surfaced window so the operator (and the
  // gate) can SEE how many cold-node UNKNOWN rows were surfaced vs anchored
  // relationships. Both are present in `rows`; this is a diagnostic, not a filter.
  let relationshipCount = 0;
  let unknownCount = 0;
  for (const r of rows) {
    for (const p of r.platforms) platformsInResult.add(p);
    for (const w of r.also_waiting_on) platformsInResult.add(w.platform);
    if (r.tier === TIER.RELATIONSHIP) relationshipCount += 1;
    else unknownCount += 1;
  }

  return {
    rows,
    generated_at: nowMs,
    stats: {
      threads_considered: threadsConsidered,
      after_filter: afterFilter,
      after_dedup: afterDedup,
      truncated,
      // e17 — ADDITIVE. Rows this build dropped because N8 graded their trailing
      // inbound run a closer AND they carried no context evidence to rescue them
      // (no saved-contact vouch, no outbound from the operator in the thread).
      // The drop is as old as N9; the COUNT is new, so that no row leaves the
      // surface unmeasured. Additive-only: every pre-existing key keeps its name
      // and its meaning, which is what catchup-since-ms.test.mjs pins.
      dropped_low_substance: droppedLowSubstance,
      platforms: [...platformsInResult].sort(),
      // M5 — the honest tier breakdown of the surfaced window. UNKNOWN rows are
      // surfaced + labeled + ranked below relationships, NEVER dropped.
      tiers: { relationship: relationshipCount, unknown: unknownCount },
    },
  };
}

// Agnostic reason tokens (NOT platform names) explaining why a row surfaced.
//
// e17 — the `substantive` token is now the COMPLEMENT of an explicit
// `low_substance` token rather than the only thing said about substance. A row
// N8 graded a closer that this surface KEPT on context evidence emits
// `low_substance`, so the operator can see WHY a one-word message is on the list
// and that it was ranked down for it; a row N8 graded substantive emits
// `substantive` exactly as before. The two are mutually exclusive by construction
// and every emitted row carries one of them, so no row is silent about substance.
function buildReasons({ theySpokeLast, lowSubstance, directed, reciprocated }) {
  const reasons = [];
  if (theySpokeLast) reasons.push("they_spoke_last");
  if (lowSubstance === true) reasons.push("low_substance");
  else reasons.push("substantive");
  if (directednessFactor(directed) >= CATCHUP_CAPS.DEFAULT_MIN_SCORE) reasons.push("directed_at_me");
  // P2 — the first persona attribute as an explanatory token. A two-way history
  // reads as "reciprocated"; a one-directional channel (never replied) reads as
  // "no_reciprocity" (the soft down-rank's reason; the row is kept, just lower).
  reasons.push(reciprocated === true ? "reciprocated" : "no_reciprocity");
  return reasons;
}

// ---------------------------------------------------------------------------
// loadEnvelopesFromSources — wire the REAL adapter registry over a `sources`
// map { platform -> rawRows[] }. Loops the registry GENERICALLY: for each
// platform the registry knows, (1) call that adapter's OPTIONAL prepareContext()
// ONCE to obtain an opaque per-adapter context sidecar, then (2) map its rows
// through the adapter's pure mapper, threading the context into toEnvelope(row,
// ctx). An adapter with no preparer gets {} — its rows map exactly as before. A
// platform present in `sources` but absent from the registry is skipped (no
// adapter to read it).
//
// ASYNC: a prepareContext() may do a read-only side-load (e.g. open a local DB
// read-only to build a name sidecar); we await it ONCE per adapter. The call is
// GENERIC — the loop never names a platform; it only invokes a capability the
// registry entry carries. A preparer that throws/rejects degrades to {} so one
// adapter's context failure never aborts the whole load.
//
// THESIS #1: this writes nothing. A preparer's own read-only discipline (it owns
// its DB handle) is the adapter's concern; the loop only consumes the result.
//
// @param {object} sources — { [platform]: rawRow[] }
// @param {Map} [registry] — defaults to ADAPTER_REGISTRY.
// @returns {Promise<Array>} flat Envelope[]
// ---------------------------------------------------------------------------
export async function loadEnvelopesFromSources(sources, registry = ADAPTER_REGISTRY) {
  const out = [];
  if (!isPlainObject(sources) || !(registry instanceof Map)) return out;
  for (const [platform, entry] of registry.entries()) {
    const rows = sources[platform];
    if (!Array.isArray(rows)) continue;
    // Build the adapter's context ONCE (generic — read by capability, no branch).
    // A missing preparer, a throw, or a rejection all degrade to {}.
    let ctx = {};
    if (typeof entry.prepareContext === "function") {
      try {
        const built = await entry.prepareContext();
        if (isPlainObject(built)) ctx = built;
      } catch {
        ctx = {};
      }
    }
    // Fold derived rows onto their parents (capability; failure => raw rows).
    const folded = typeof entry.foldRows === "function" ? safeFold(entry.foldRows, rows) : rows;
    const mapped = rowsToEnvelopes(folded, entry.toEnvelope, ctx);
    for (const e of mapped) out.push(e);
  }
  return out;
}

// loadEnvelopesFromSourcesSync — the CONTEXT-FREE synchronous load. Identical to
// the async path except it NEVER invokes prepareContext (so every adapter maps
// with ctx={}). Used by callers that drive a fixture registry whose adapters
// declare no preparer (the N10 invariant eval), keeping that synchronous gate
// path unchanged. Still fully GENERIC — no platform branch.
//
// @param {object} sources — { [platform]: rawRow[] }
// @param {Map} [registry] — defaults to ADAPTER_REGISTRY.
// @returns {Array} flat Envelope[]
export function loadEnvelopesFromSourcesSync(sources, registry = ADAPTER_REGISTRY) {
  const out = [];
  if (!isPlainObject(sources) || !(registry instanceof Map)) return out;
  for (const [platform, entry] of registry.entries()) {
    const rows = sources[platform];
    if (!Array.isArray(rows)) continue;
    // Same capability fold as the async path, so both loaders see one population.
    const folded = typeof entry.foldRows === "function" ? safeFold(entry.foldRows, rows) : rows;
    const mapped = rowsToEnvelopes(folded, entry.toEnvelope);
    for (const e of mapped) out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// loadSourcesFromLedgers — the GENERIC source-ledger reader. Loops the registry
// and, for EACH entry, tail-reads its OWN `ledgerPath` (relative to `root`) into
// a BOUNDED window of recent raw rows, returning the { platform -> rawRow[] }
// sources map the catch-up surface consumes. This is the production complement of
// the fixture loader: the same generic loop, sourced from disk instead of a
// fixture object.
//
// ABSTRACTION INVARIANT: ZERO platform branches. The loop reads each entry's
// `ledgerPath` (which the registry derived from the adapter's OWN id — DATA) and
// joins it under `root`. It never names a platform, never compares the key
// against a literal, and never imports a platform-named file. Adding a platform
// is ONE adapter; this reader does not change.
//
// THESIS #1 (SOURCE LEDGERS READ-ONLY): every source-ledger read — the full
// stream AND the C1 projection layer's checkpoint/verify/delta reads — opens the
// ledger O_RDONLY and writes NOTHING to it. A missing ledger yields []
// (streamLedgerLines returns zero counts on a non-existent path). One adapter's
// unreadable ledger never aborts the others. The ONLY writes the loader ever
// causes are the C1 projection cache files under storage/catchup-projection/
// (atomic tmp+rename, mode 0600), persisted best-effort AFTER the rows are
// returned — never on the critical path, and never from unverified bytes.
//
// BOUNDED (resource discipline; the ledgers are large append-only files):
//   - `since_ms`: drop rows whose ts is older than `now - since_ms` (a row's ts
//     is parsed defensively; a row with no parseable ts is KEPT — the surface's
//     own time math tolerates a missing ts — recencyFactor returns its floor for
//     one — and dropping un-timestamped rows
//     here would be a silent data loss the reader has no mandate for). C2: this
//     pre-corpus cutoff is a bounded-READ optimization only; the AUTHORITATIVE
//     since_ms semantics (a thread qualifies by its last-activity ts) are
//     enforced at query time in buildCatchupCore, after envelope load.
//   - `limit`: retain only the most RECENT `limit` rows per platform via a ring
//     buffer (the ledger is append-only / roughly time-ordered, so the tail is
//     the recent window). The ring caps heap to O(limit) rows per platform even
//     on a multi-hundred-MB ledger — never materializing the whole file.
//   The per-platform retain cap is scaled above the caller's row `limit` (the
//   final catch-up `limit` counts DEDUPED people, and the attention/filter stages
//   discard most rows), so the reader does not starve the ranker of candidates.
//
// `platforms` (optional): when present, ONLY those platform keys are read (a DATA
// membership test over the registry keys — NOT a platform-name branch). This lets
// the tool's `platforms` filter avoid opening ledgers it will discard anyway.
//
// @param {Map} registry — Map<platform, { ledgerPath, ... }> (the adapter registry).
// @param {object} [opts]
// @param {string} [opts.root] — base dir the ledgerPath is resolved under
//        (default MEMORY_ROOT). Tests pass a temp root to redirect every read.
// @param {number} [opts.now] — epoch ms for the since-window (default Date.now()).
// @param {number} [opts.since_ms] — keep rows newer than now - since_ms.
// @param {number} [opts.limit] — caller's catch-up row cap (drives the retain cap).
// @param {string[]} [opts.platforms] — restrict to these platform keys.
// @param {(sourceKey, {failed,stage,error})=>void} [opts.onSourceStatus] — C2:
//        OPTIONAL per-source status observer, called ONCE per source read with
//        { failed: boolean, stage: "projection"|"full-stream", error: string|null }.
//        `failed` is true iff the serving full-stream read reported a
//        counts.readError (an EXISTING-but-unreadable ledger — EACCES, ELOOP, a
//        mid-stream read fault; streamLedgerLines never throws) or the
//        belt-and-suspenders catch fired. ENOENT stays an honest empty (zeros,
//        readError null => failed:false) and a projection-serve THROW alone is
//        NOT a failure (fail-closed fallthrough; the full stream that then
//        serves is what gets inspected). The observer is an ADDITIVE seam: the
//        { platform -> rawRow[] } return shape is byte-identical with or
//        without it, source keys flow to it as DATA, and a throwing observer is
//        swallowed (it can never break the read).
// @returns {{ [platform]: rawRow[] }}
// ---------------------------------------------------------------------------

// How many recent raw rows to retain per platform, derived from the caller's
// catch-up `limit`. The final list counts DEDUPED people after the attention +
// directedness filter prunes most rows, so we read a generous multiple of the
// requested row cap to keep enough candidates without unbounding the heap. Capped
// hard so a pathological `limit` can never blow the retain buffer.
// (LEDGER_RETAIN_FLOOR and LEDGER_RETAIN_CEILING are owned by the leaf
// ledger-retain.js and imported at the top of this file — one definition site
// each, repo-wide.)
const LEDGER_RETAIN_MULTIPLE = 40;

function ledgerRetainCap(limit) {
  const base = Number.isInteger(limit) && limit > 0 ? limit : CATCHUP_CAPS.DEFAULT_LIMIT;
  const scaled = base * LEDGER_RETAIN_MULTIPLE;
  return Math.min(LEDGER_RETAIN_CEILING, Math.max(LEDGER_RETAIN_FLOOR, scaled));
}

export function loadSourcesFromLedgers(registry = ADAPTER_REGISTRY, opts = {}) {
  const sources = {};
  if (!(registry instanceof Map)) return sources;

  const root =
    typeof opts.root === "string" && opts.root.length > 0 ? opts.root : MEMORY_ROOT;
  const now =
    typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();
  const sinceMs =
    Number.isInteger(opts.since_ms) && opts.since_ms > 0 ? opts.since_ms : null;
  const cutoff = sinceMs === null ? null : now - sinceMs;
  const retainCap = ledgerRetainCap(opts.limit);
  // Platform restriction is a DATA membership test over registry keys, never a
  // platform-name branch.
  const platformFilter =
    Array.isArray(opts.platforms) && opts.platforms.length > 0
      ? new Set(opts.platforms)
      : null;
  // C1 — the projection fast path is ON by default. `opts.projection === false`
  // is the harness seam (the equivalence gate compares both paths over the same
  // bytes); CATCHUP_PROJECTION=0 is the ops kill-switch (instant rollback to
  // the pre-C1 full-stream behavior without a code change).
  const useProjection =
    opts.projection !== false && process.env.CATCHUP_PROJECTION !== "0";
  // C2 — the OPTIONAL per-source status observer (contract in the doc block
  // above). SOFT-guarded: an observer throw is swallowed so reporting can never
  // break the read; absent => zero behavior change (pure additive seam).
  const onSourceStatus =
    typeof opts.onSourceStatus === "function" ? opts.onSourceStatus : null;
  const noteSourceStatus = (sourceKey, status) => {
    if (onSourceStatus === null) return;
    try {
      onSourceStatus(sourceKey, status);
    } catch {
      // the observer must never break the read
    }
  };

  for (const [platform, entry] of registry.entries()) {
    if (platformFilter && !platformFilter.has(platform)) continue;
    if (!entry || typeof entry.ledgerPath !== "string" || entry.ledgerPath.length === 0) {
      continue;
    }
    const absPath = join(root, entry.ledgerPath);

    // ---- C1 projection fast path (fail-closed) -----------------------------
    // Serve the bounded tail from a VERIFIED checkpointed projection plus a
    // delta fold of only the appended bytes — through the SAME fold lambda the
    // full stream uses. ANY doubt (missing/corrupt projection, prefix drift,
    // truncation, torn delta, unprovable window) returns null and we fall
    // through to the full stream below. A projection-layer THROW is likewise
    // swallowed: it is an optimization layer, never the correctness path.
    if (useProjection) {
      let served = null;
      try {
        served = tryServeSourceFromProjection({
          root,
          sourceKey: platform,
          ledgerAbsPath: absPath,
          cutoff,
          retainCap,
        });
      } catch {
        served = null;
      }
      if (served !== null) {
        sources[platform] = served;
        // C2 — a verified projection serve is a clean read (the checkpoint
        // certificate re-verified the ledger prefix O_RDONLY on THIS call).
        noteSourceStatus(platform, { failed: false, stage: "projection", error: null });
        continue;
      }
    }

    // ---- full-stream correctness path (pre-C1 behavior, byte-for-byte) -----
    // Ring buffer of the most-recent `retainCap` rows passing the since window.
    // The ledger is append-only / roughly ascending, so the tail is the recent
    // slice; the ring keeps heap bounded even on a hundreds-of-MB file.
    const fold = makeLedgerRetainFold(cutoff, retainCap);
    let readError = null;
    try {
      // C2 — streamLedgerLines NEVER throws; it reports an existing-but-
      // unreadable ledger (EACCES at open, ELOOP, a mid-stream read fault) via
      // counts.readError, which was silently DISCARDED before C2 — the exact
      // silent-[]-success this loader must not produce. ENOENT stays zeros
      // with readError null (a missing ledger is an honest empty, not a fault).
      const counts = streamLedgerLines(absPath, fold.push);
      readError =
        counts && counts.readError != null ? String(counts.readError) : null;
    } catch (e) {
      // Defensive: any unexpected stream/parse failure for one platform degrades
      // to [] for that platform without aborting the others — the VISIBLE
      // source-failure convention (never silently succeed from a stale cache).
      // (streamLedgerLines is itself defensive, so this is belt-and-suspenders.)
      sources[platform] = [];
      noteSourceStatus(platform, {
        failed: true,
        stage: "full-stream",
        error: e && e.message ? e.message : String(e),
      });
      continue;
    }
    sources[platform] = fold.rows();
    // C2 — the rows served (possibly partial on a mid-stream fault, [] on an
    // unopenable ledger) are returned UNCHANGED either way; the status is what
    // makes the degradation visible instead of silent.
    noteSourceStatus(platform, {
      failed: readError !== null,
      stage: "full-stream",
      error: readError,
    });

    // C1 — after a full-stream serve, rebuild this source's projection
    // best-effort, OFF the critical path (setImmediate, deduped per ledger).
    // The rebuild does its OWN checkpointed read — the projection is only ever
    // persisted from bytes a fresh S1 checkpoint certifies, never from the
    // (parameter-filtered) rows served above.
    if (useProjection) {
      try {
        scheduleProjectionRebuild({ root, sourceKey: platform, ledgerAbsPath: absPath });
      } catch {
        // best-effort by contract
      }
    }
  }

  return sources;
}

// ---------------------------------------------------------------------------
// M5 — buildHandlesByPerson: a query-time index Map<person_key, handles[]> so the
// M2 contacts-anchor lookup can resolve a dedup key (the resolved N7 person_id, or
// the soft `${platform}:${sender_id}` fallback) to the sender HANDLES it collapsed.
// Built ONCE over the loaded envelopes (Thesis #1 — ephemeral projection, no store).
//
// For each inbound (NOT is_from_me) envelope, the sender's id is a candidate
// handle. We key it under BOTH the resolved person_id (when the resolver returns
// one) AND the soft `${platform}:${sender_id}` fallback, so whichever dedup key the
// rank loop computed resolves to the same handle set. Defensive: a throwing
// resolver / odd envelope contributes nothing. NEVER branches on a platform name —
// `platform` is read as DATA only to build the soft key.
// ---------------------------------------------------------------------------
export function buildHandlesByPerson(envelopes, resolvePerson) {
  const map = new Map();
  if (!Array.isArray(envelopes)) return map;
  const resolveFn = typeof resolvePerson === "function" ? resolvePerson : () => null;
  const add = (key, handle) => {
    if (typeof key !== "string" || key.length === 0) return;
    if (typeof handle !== "string" || handle.length === 0) return;
    let arr = map.get(key);
    if (arr === undefined) {
      arr = [];
      map.set(key, arr);
    }
    if (!arr.includes(handle)) arr.push(handle);
  };
  for (const e of envelopes) {
    if (!isPlainObject(e)) continue;
    if (e.is_from_me === true) continue; // only inbound senders carry a contact handle.
    const platform = typeof e.platform === "string" ? e.platform : null;
    const senderId = e.sender && typeof e.sender.id === "string" ? e.sender.id : null;
    if (senderId === null) continue;
    // The soft dedup key (`${platform}:${sender_id}`) — the rank loop's fallback.
    const softKey = `${platform === null ? "" : platform}:${senderId}`;
    add(softKey, senderId);
    // The resolved N7 person_id (when the resolver collapses cross-platform DMs).
    let personId = null;
    try {
      personId = resolveFn(platform, senderId);
    } catch {
      personId = null;
    }
    if (typeof personId === "string" && personId.length > 0) add(personId, senderId);
  }
  return map;
}

// ---------------------------------------------------------------------------
// M5 — makeWhoMattersEnricher: COMPOSE the W1 source modules (M2 contacts-anchor +
// M3 feedback-log) into the REAL enrichPerson resolver injected at buildCatchup,
// REPLACING the neutral default. The contract is M1's makeEnricherFromIndex:
//   (1) a precomputed `index` (built ONCE, read-only — the contact-anchor index +
//       the feedback index + the handle map),
//   (2) a `lookup(index, person_id) -> partial-enrichment | null` that MERGES the
//       M2 is_contact + M3 feedback_score signals for a person.
// The resolver is CACHED O(1) per person in the rank loop (no scan, no live store);
// any throw / miss degrades to the NEUTRAL enrichment (anchor_factor=1.0 — never a
// hard-drop). The anchorFactor (M1) folds the merged signals into a MONOTONE up-rank.
//
// reciprocity_strength is NOT merged here — it is a PER-THREAD signal already
// computed in the rank loop (P2r) and threaded onto the row + the tier directly.
//
// @param {object} [parts]
// @param {{isContact:Function}} [parts.contactIndex] M2 (from buildContactAnchorIndex).
// @param {{aggregates:Map}} [parts.feedbackIndex] M3 (from buildFeedbackIndexFromLog).
// @param {Map<string,string[]>} [parts.handlesByPerson] person_key -> handles[].
// @returns {(person_id:string)=>Enrichment} the injected enrichPerson resolver.
// ---------------------------------------------------------------------------
export function makeWhoMattersEnricher(parts = {}) {
  const p = isPlainObject(parts) ? parts : {};
  const contactIndex = p.contactIndex && typeof p.contactIndex.isContact === "function" ? p.contactIndex : null;
  const feedbackIndex = isPlainObject(p.feedbackIndex) && p.feedbackIndex.aggregates instanceof Map ? p.feedbackIndex : null;
  const handlesByPerson = p.handlesByPerson instanceof Map ? p.handlesByPerson : null;
  // No real source wired at all => neutral (gate-OFF, byte-identical). This keeps
  // the composite resolver SAFE to construct unconditionally.
  if (contactIndex === null && feedbackIndex === null) return makeNeutralEnricher();

  const contactsLookup = makeContactsLookup(handlesByPerson);
  // The composite index bundle the lookup closes over (all precomputed, read-only).
  const index = { contactIndex, feedbackIndex };
  // The MERGE lookup: M2 is_contact + M3 feedback_score for a person_id. Returns a
  // partial enrichment makeEnricherFromIndex normalizes (recomputing anchorFactor
  // MONOTONE from the merged signals — a lookup can never inject an out-of-band
  // factor). SOFT: any sub-lookup that throws contributes its neutral default.
  const lookup = (idx, person_id) => {
    let is_contact = false;
    let feedback_score = 0;
    try {
      const c = contactsLookup(idx && idx.contactIndex ? idx.contactIndex : null, person_id);
      if (isPlainObject(c) && c.is_contact === true) is_contact = true;
    } catch {
      is_contact = false;
    }
    try {
      const fb = lookupFeedbackScore(idx ? idx.feedbackIndex : null, person_id);
      if (typeof fb === "number" && Number.isFinite(fb)) feedback_score = fb;
    } catch {
      feedback_score = 0;
    }
    return { is_contact, feedback_score };
  };
  return makeEnricherFromIndex(index, lookup);
}

// ---------------------------------------------------------------------------
// M5 — buildWhoMattersEnricher: the ASYNC wiring that builds the W1 source indexes
// ONCE (M2 contact-anchor — a READ-ONLY, memoized address-book join; M3 feedback
// index — a query-time read of the append-only engagement log) + the handle map
// over the loaded envelopes, then composes them via makeWhoMattersEnricher.
//
// SOFT-guarded end to end: ANY failure (no address book / no feedback log / a
// throwing source) degrades to the NEUTRAL enricher (ranking byte-identical). The
// indexes are built ONCE here, BEFORE the rank loop, then queried O(1) per person
// (M1's injection contract — never a live source read inside the loop).
//
// `anchor === true` reads the REAL operator sources (production). `anchor` as an
// options object injects pre-built indexes / source options (hermetic tests):
//   { contactIndex?, feedbackIndex?, contacts?, feedback? }.
// ---------------------------------------------------------------------------
async function buildWhoMattersEnricher({ anchor, envelopes, resolvePerson } = {}) {
  try {
    const o = isPlainObject(anchor) ? anchor : {};

    // M2 — the contact-anchor index (READ-ONLY, memoized). An explicit contactIndex
    // wins (tests); else build it from `contacts` opts (or the real address book).
    let contactIndex = null;
    if (o.contactIndex && typeof o.contactIndex.isContact === "function") {
      contactIndex = o.contactIndex;
    } else {
      try {
        contactIndex = await buildContactAnchorIndex(isPlainObject(o.contacts) ? o.contacts : {});
      } catch {
        contactIndex = null;
      }
    }

    // M3 — the feedback index (query-time read of the append-only log). An explicit
    // feedbackIndex wins (tests); else build it from `feedback` opts (or the real log).
    let feedbackIndex = null;
    if (isPlainObject(o.feedbackIndex) && o.feedbackIndex.aggregates instanceof Map) {
      feedbackIndex = o.feedbackIndex;
    } else {
      try {
        feedbackIndex = buildFeedbackIndexFromLog(isPlainObject(o.feedback) ? o.feedback : {});
      } catch {
        feedbackIndex = null;
      }
    }

    // The handle map (person_key -> handles[]) so M2 can resolve a dedup key to the
    // sender handles it collapsed. Built ONCE over the loaded envelopes.
    const handlesByPerson = buildHandlesByPerson(envelopes, resolvePerson);

    return makeWhoMattersEnricher({ contactIndex, feedbackIndex, handlesByPerson });
  } catch {
    // Belt-and-suspenders: any unexpected failure degrades to neutral (byte-identical).
    return makeNeutralEnricher();
  }
}

// ---------------------------------------------------------------------------
// buildCatchup — the WORKUNIT signature. Wires the REAL engines + the real
// adapter registry over a `sources` map, then defers to the pure core.
//
//   buildCatchup({ sources, now, limit, ... }) -> { rows, generated_at, stats }
//
// `sources` is { platform -> rawRow[] } (the per-platform source-ledger rows).
// The four engines (N2/N7/N8) are the REAL imports here; the registry is the
// REAL ADAPTER_REGISTRY. The N7 resolver is built once from the loaded envelopes
// (a query-time, ephemeral person index — Thesis #1) and SOFT-guarded: any
// failure degrades to per-platform dedup, never crashes.
// ---------------------------------------------------------------------------
export async function buildCatchup({
  sources,
  now = Date.now(),
  limit,
  since_ms,
  platforms,
  min_score,
  // f7 — THE FORWARDING SEAM. This key was ABSENT from this list, so every caller
  // that passed it (m7r-rendered-order's two weave tests among them) had it dropped
  // silently by the object rest and the core always ran at the derived/CAPS default.
  // It is destructured HERE and forwarded verbatim in `opts` below; the resolution
  // (including the `false` sentinel and an explicit 0) stays in the core, unchanged.
  max_per_platform,
  reciprocity_floor,
  registry = ADAPTER_REGISTRY,
  // M1 — the injected person-enrichment resolver. DEFAULT (when absent) is the
  // NEUTRAL enricher (anchor_factor=1.0 for every person => ranking byte-identical
  // to pre-M1). An explicit resolver is passed through verbatim (tests / advanced
  // callers). M5's real composite resolver is built when `anchor` opts in (below).
  enrichPerson,
  // M5 — the ANCHOR opt-in. When truthy, buildCatchup COMPOSES the W1 sources
  // (M2 contacts-anchor + M3 feedback-log) into the REAL enrichPerson resolver
  // (the who-matters anchor), REPLACING the neutral default. `anchor` may be:
  //   - true: read the REAL operator address book (READ-ONLY, memoized) + the REAL
  //     feedback log (the production MCP path).
  //   - an options object { contacts?, feedback?, contactIndex?, feedbackIndex? }:
  //     inject pre-built indexes / source options (hermetic tests). `contacts` is
  //     forwarded to buildContactAnchorIndex (e.g. { contactMaps } / { noMemo });
  //     `feedback` to buildFeedbackIndexFromLog (e.g. { path }).
  // An EXPLICIT enrichPerson always wins over `anchor` (the lower-level seam).
  // ABSENT/false `anchor` => the neutral default (byte-identical, hermetic).
  anchor,
  // persona-surface — the OPTIONAL persona injection seam, forwarded VERBATIM to
  // buildCatchupCore (pass-through only; no resolver is constructed here). The MCP
  // handler does NOT pass it, so production stays byte-identical (no persona key)
  // until a downstream node opts in — mirroring M5's anchor opt-in. Callers/tests
  // build one via makePersonaResolver(ctx) from ./persona-resolver.js.
  personaResolver,
  // persona — the LIVE-WIRING opt-in (mirrors M5's `anchor`). When truthy AND no
  // explicit personaResolver is injected, buildCatchup builds the real resolver
  // INTERNALLY (below) from the already-loaded `envelopes` + the already-built N7
  // person `index`/`resolvePerson` — REUSE-first, never a second envelope load or
  // person-index rebuild — via a DYNAMIC import of makePersonaResolver (a STATIC
  // import of persona-resolver.js would be a module cycle: it imports THIS file). An
  // EXPLICIT personaResolver still WINS (the lower-level seam, like enrichPerson vs
  // anchor). DEFAULT false => no resolver => rows BYTE-IDENTICAL (only handler() opts
  // in, with persona:true). SOFT-guarded end to end: any build failure => no
  // resolver, personas simply absent; the build NEVER throws.
  persona = false,
  // TEST-ONLY seam: authored L1 envelopes appended to the loaded corpus before
  // ranking (the M7 findability persona panel — m7-persona-panel.mjs). Production
  // never passes it, so the live path is byte-identical. Read-only; the personas are
  // ranked by the SAME pipeline as real rows, which is the point of the panel.
  extraEnvelopes,
} = {}) {
  const loadedEnvelopes = await loadEnvelopesFromSources(sources, registry);
  const envelopes = Array.isArray(extraEnvelopes) && extraEnvelopes.length > 0
    ? loadedEnvelopes.concat(extraEnvelopes)
    : loadedEnvelopes;

  // Build the N7 person index ONCE over the loaded envelopes (ephemeral,
  // query-time projection). SOFT-guard: a failure yields a null-returning
  // resolver so dedup degrades to per-platform scope.
  let resolvePerson;
  // Hoisted so the SAME already-built index is reusable at the persona build site
  // below (REUSE-first: the persona resolver never rebuilds the person index).
  let index = null;
  try {
    index = buildPersonIndex(envelopes);
    resolvePerson = (platform, senderId) => {
      try {
        return personLookup(index, platform, senderId);
      } catch {
        return null;
      }
    };
  } catch {
    resolvePerson = () => null;
  }

  // M1/M5 — the enrichment resolver. PRECEDENCE:
  //   1. an EXPLICIT enrichPerson function (verbatim — the lowest-level seam),
  //   2. else the M5 COMPOSITE (M2 contacts + M3 feedback) when `anchor` opts in,
  //   3. else the NEUTRAL enricher (gate-OFF => byte-identical, the default).
  let enrichFn;
  if (typeof enrichPerson === "function") {
    enrichFn = enrichPerson;
  } else if (anchor) {
    enrichFn = await buildWhoMattersEnricher({ anchor, envelopes, resolvePerson });
  } else {
    enrichFn = makeNeutralEnricher();
  }

  // persona — the LIVE resolver build (mirrors the M5 anchor composite above).
  // PRECEDENCE:
  //   1. an EXPLICIT personaResolver wins (verbatim — the lower-level seam),
  //   2. else, when `persona` opts in, build the REAL resolver INTERNALLY from the
  //      already-loaded `envelopes` + the already-built N7 `index`/`resolvePerson`
  //      (REUSE — no second envelope load, no person-index rebuild), via a DYNAMIC
  //      import (a static import of persona-resolver.js is a module cycle — it imports
  //      THIS file),
  //   3. else nothing (persona absent/false => the explicit/undefined value rides
  //      through => byte-identical rows).
  // SOFT-GUARD: a failed import / build degrades to NO resolver (personas absent) and
  // NEVER throws; the per-row resolver call in buildCatchupCore is already guarded.
  let personaFn = personaResolver;
  if (typeof personaFn !== "function" && persona) {
    try {
      const { makePersonaResolver } = await import("./persona-resolver.js");
      personaFn = makePersonaResolver({ envelopes, resolvePerson, index, now });
    } catch {
      personaFn = undefined;
    }
  }

  return buildCatchupCore({
    envelopes,
    classify: classifyDirectedAtMe,
    attention: computeAttention,
    resolvePerson,
    enrichPerson: enrichFn,
    // persona-surface — the explicit injected resolver, else the internally-built
    // live resolver (when `persona` opted in), else undefined (gate-off, additive).
    personaResolver: personaFn,
    now,
    opts: { limit, since_ms, platforms, min_score, max_per_platform, reciprocity_floor },
  });
}

// ---------------------------------------------------------------------------
// MCP TOOL — the thin wrapper. Mirrors the memory_recall / memory_put TOOL shape
// (name / description / inputSchema / handler). Registered in dispatch.js.
// ---------------------------------------------------------------------------

// The default source loader the tool uses. It performs the REAL, BOUNDED
// tail-read of each adapter's source ledger via loadSourcesFromLedgers —
// looping the registry generically (each entry's own `ledgerPath` under the
// configured root), honoring the caller's since/limit/platforms window. It opens
// the ledgers O_RDONLY and never writes to them (THESIS #1); the C1 projection
// layer inside the reader may persist derived cache files under
// storage/catchup-projection/ AFTER serving (best-effort, off the critical
// path). The loader is a function of the (validated) tool args + the registry,
// and is injectable via setDefaultSourceLoader so tests can pin a temp root (or
// a fixture corpus) without touching the real ledgers.
//
// `parsed` carries the validated { limit, since_ms, platforms } filters; the
// loader threads them into the reader so it tail-reads only the requested window
// and only the requested platforms. `now` is passed so the since-window is
// computed against the SAME clock the catch-up build stamps with.
function _realLedgerSourceLoader(parsed = {}, ctx = {}) {
  return loadSourcesFromLedgers(ADAPTER_REGISTRY, {
    root: typeof ctx.root === "string" && ctx.root.length > 0 ? ctx.root : MEMORY_ROOT,
    now: typeof ctx.now === "number" && Number.isFinite(ctx.now) ? ctx.now : Date.now(),
    since_ms: parsed.since_ms,
    limit: parsed.limit,
    platforms: parsed.platforms,
    // C2 — thread the handler's per-source status sink into the reader so an
    // existing-but-unreadable ledger surfaces in the response stats instead of
    // dissolving into a silent []. Optional and additive; source keys reach
    // the sink as DATA (registry keys), never as literals.
    onSourceStatus:
      typeof ctx.onSourceStatus === "function" ? ctx.onSourceStatus : undefined,
  });
}

let _defaultSourceLoader = _realLedgerSourceLoader;

export function setDefaultSourceLoader(fn) {
  _defaultSourceLoader = typeof fn === "function" ? fn : _realLedgerSourceLoader;
}

// Test/ops seam: restore the production reader after a test injected a loader.
export function resetDefaultSourceLoader() {
  _defaultSourceLoader = _realLedgerSourceLoader;
}

/**
 * handler(args) — validate optional filters, build the catch-up list over the
 * default source loader, return ok(NAME, result). Stamps generated_at
 * server-side via serverTs() (never accepts ts from the caller). Throws
 * ToolError(INVALID_ARGUMENTS, …) on bad input; dispatch converts to an errEnv.
 */
export async function handler(args) {
  let parsed;
  try {
    parsed = validateArgs(args || {});
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, e && e.message ? e.message : "invalid arguments");
  }

  const nowMs = Date.now();

  // C2 — collect per-source read statuses from the loader (the additive
  // onSourceStatus seam on loadSourcesFromLedgers). Keys are registry keys
  // (DATA); the normalized status shape is what stamps the response stats
  // below. A loader that reports nothing (e.g. an injected fixture loader)
  // yields an empty map => sources_failed: [] (nothing observed, nothing
  // marked).
  const sourceStatus = {};
  const noteSourceStatus = (sourceKey, status) => {
    if (typeof sourceKey !== "string" || sourceKey.length === 0) return;
    const s = isPlainObject(status) ? status : {};
    sourceStatus[sourceKey] = {
      failed: s.failed === true,
      stage: typeof s.stage === "string" ? s.stage : null,
      error: typeof s.error === "string" && s.error.length > 0 ? s.error : null,
    };
  };

  let sources = {};
  try {
    // The loader reads each adapter's source ledger (bounded by the validated
    // since/limit/platforms window), threading the SAME nowMs the build stamps
    // with so the since-window is coherent. A loader may be async (a future
    // loader could await a side-load); we await defensively.
    const s = await _defaultSourceLoader(parsed, { now: nowMs, onSourceStatus: noteSourceStatus });
    if (isPlainObject(s)) sources = s;
  } catch (e) {
    sources = {};
    // C2 — a loader-level throw is a failure of EVERY requested source, and it
    // must be marked as such — never a silent empty surface. "Requested" is the
    // caller's platforms filter when present, else every registry key (both
    // flow as DATA; no platform literal, no branch).
    const requested =
      Array.isArray(parsed.platforms) && parsed.platforms.length > 0
        ? parsed.platforms
        : [...ADAPTER_REGISTRY.keys()];
    const msg = e && e.message ? e.message : String(e);
    for (const key of requested) {
      noteSourceStatus(key, { failed: true, stage: "loader", error: msg });
    }
  }

  const result = await buildCatchup({
    sources,
    now: nowMs,
    limit: parsed.limit,
    since_ms: parsed.since_ms,
    platforms: parsed.platforms,
    min_score: parsed.min_score,
    reciprocity_floor: parsed.reciprocity_floor,
    // M5 — the production surface OPTS IN to the who-matters anchor: COMPOSE the
    // real M2 contacts (READ-ONLY address book, memoized) + M3 feedback log into
    // the enrichPerson resolver, UP-rank anchored relationships, and surface the
    // honest UNKNOWN/first-contact tier. SOFT: no address book / no feedback log
    // degrades to neutral (ranking byte-identical, every row tier-classified from
    // reciprocity alone). NEVER drops a human.
    anchor: true,
    // persona — the production surface OPTS IN to LIVE personas by default: each
    // surfaced row carries `row.persona` (who they are, what they discuss, the recent
    // arc), built internally from the same loaded envelopes + person index. A caller
    // may disable it (persona:false) to keep the surface byte-identical. SOFT: any
    // build failure simply omits personas — catchup never breaks.
    persona: parsed.persona,
  });

  // C2 — stamp the per-source read outcome ADDITIVELY into the stats: the
  // existing keys (threads_considered, after_filter, after_dedup, truncated,
  // platforms, tiers) and the row shape are untouched; `sources_failed` (the
  // sorted failed keys) + `source_status` (the full per-source map) are new
  // keys. A failed source degrades VISIBLY here while the healthy sources'
  // rows still serve above — never an abort, never a silent [] success.
  const sourcesFailed = Object.keys(sourceStatus)
    .filter((k) => sourceStatus[k].failed === true)
    .sort();
  const stats = {
    ...result.stats,
    sources_failed: sourcesFailed,
    source_status: sourceStatus,
  };

  // Stamp generated_at as a server ISO timestamp (envelope.js discipline) while
  // keeping the numeric build clock available for callers that want it.
  return ok(NAME, {
    rows: result.rows,
    count: result.rows.length,
    generated_at: serverTs(),
    generated_at_ms: result.generated_at,
    stats,
  });
}

// Validate the optional filter args. Throws ToolError(INVALID_ARGUMENTS) on a
// shape/type violation (the M4 helpers throw ToolError(INVALID_ARGUMENTS) too).
function validateArgs(args) {
  assertObjectShape(args, "args", ["limit", "since_ms", "platforms", "min_score", "reciprocity_floor", "persona"]);
  const limit = assertOptionalIntInRange(args.limit, "limit", { min: 1, max: CATCHUP_CAPS.MAX_LIMIT });
  const since_ms = assertOptionalIntInRange(args.since_ms, "since_ms", { min: 1, max: Number.MAX_SAFE_INTEGER });
  const platforms = assertOptionalStringArray(args.platforms, "platforms", { maxItems: 64, maxItemChars: 128 });
  let min_score = undefined;
  if (args.min_score !== undefined && args.min_score !== null) {
    min_score = assertNumberInRange(args.min_score, "min_score", { min: 0, max: 1 });
  }
  // P2 — optional reciprocity down-rank floor in [0,1] (1 disables the down-rank).
  let reciprocity_floor = undefined;
  if (args.reciprocity_floor !== undefined && args.reciprocity_floor !== null) {
    reciprocity_floor = assertNumberInRange(args.reciprocity_floor, "reciprocity_floor", { min: 0, max: 1 });
  }
  // persona — the optional LIVE-personas toggle. DEFAULT true (production renders
  // row.persona); a caller may pass false to keep the surface byte-identical. Only a
  // boolean is accepted (validation.js has no boolean helper; a non-boolean is a hard
  // INVALID_ARGUMENTS, never a silent coercion).
  let persona = true;
  if (args.persona !== undefined && args.persona !== null) {
    if (typeof args.persona !== "boolean") {
      throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "persona must be a boolean");
    }
    persona = args.persona;
  }
  return {
    limit: limit == null ? undefined : limit,
    since_ms: since_ms == null ? undefined : since_ms,
    platforms: platforms.length > 0 ? platforms : undefined,
    min_score,
    reciprocity_floor,
    persona,
  };
}

export const TOOL = {
  name: NAME,
  description:
    "Cross-platform 'waiting on you' inbox: a ranked, deduped list of threads where someone spoke last and addressed you — fused across every messaging platform via the adapter registry. A short closing message ('ok', 'thanks') is dropped UNLESS the thread carries context that says otherwise (a saved contact, or a reply to something you sent), in which case it is kept and ranked down with a low_substance reason. Read-only; the right instrument for 'catch me up', not memory_recall.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      limit: { type: "integer", minimum: 1, maximum: CATCHUP_CAPS.MAX_LIMIT },
      since_ms: { type: "integer", minimum: 1 },
      platforms: { type: "array", items: { type: "string" } },
      min_score: { type: "number", minimum: 0, maximum: 1 },
      reciprocity_floor: { type: "number", minimum: 0, maximum: 1 },
      persona: { type: "boolean" },
    },
  },
  handler,
};

export default TOOL;
