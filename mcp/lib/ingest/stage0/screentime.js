// Stage-0 hard-drop module for the `screentime` source.
//
// Rules (verbatim from kb/salience-design.md § Layer 1, extended by
// F-T1-SCREENTIME-F2, F-T2-SCREENTIME-F3, F-T2-SCREENTIME-F4,
// F-T2-SCREENTIME-F6, and F-NEW-W1-SCREENTIME-APPLE-BUNDLE-COVERAGE
// per the critic's modifications):
//   1. raw_content.stream == "/discoverability/signals" → DROP (discoverability_signals)
//      Note: F-T2-SCREENTIME-F6 moves the *primary* drop to the connector
//      (we delete the dispatch entry there so the row is never emitted).
//      This Stage-0 rule stays as defense-in-depth so any straggler that
//      slips past the connector deletion is still dropped here.
//   2. raw_content.stream == "/notification/usage" AND
//      notifying_bundle_id == "com.googlecode.iterm2" AND
//      title AND body both empty/whitespace            → QUARANTINE
//         (reason: "screentime_iterm2_empty_notif", 30d retention)
//      Rationale: iterm2 dings are mostly content-free OS chatter, but
//      long-task-completion / exit-code pings ARE real attention events;
//      retain anything with a title/body. We never blanket-drop iterm2.
//   3. raw_content.stream == "/notification/usage" AND
//      notifying_bundle_id matches the Apple system-chrome bundle pattern
//      (broad, per F-T1-SCREENTIME-F2 spec) AND notifying_bundle_id does
//      NOT match the operator-retain bundle pattern (Tips / Sharing) AND
//      text does NOT match the Security-Update / Critical retention
//      pattern                                          → QUARANTINE
//         (reason: "screentime_apple_chrome_notif", 30d retention)
//      F-NEW-W1-SCREENTIME-APPLE-BUNDLE-COVERAGE: the v1 pattern was a
//      narrow 5-bundle list (controlcenter/systempreferences/software_update/
//      BTM/accountsd); the spec's sysBundlePat includes _SYSTEM_CENTER_,
//      notificationcenter, wifi.usernotifications, tips, cmio, sharingd,
//      and followup. The W1 reviewer flagged this undershoots the 21.2%
//      impact target. We expand to the full spec list and add an explicit
//      APPLE_RETAIN_BUNDLE_PAT pre-check exempting com.apple.sharingd and
//      com.apple.tips (user-visible "AirDrop received" / "Tip of the day"
//      notifications stay in the ledger).
//   4. raw_content.stream == "/app/usage" AND duration_sec is a finite
//      number AND duration_sec < 5                      → QUARANTINE
//         (reason: "app_usage_micro_burst", F-T2-SCREENTIME-F3 30d retention)
//      Rationale: ZSTARTDATE == ZENDDATE (zero-duration bookkeeping rows)
//      and sub-5-second Cmd-Tab flickers carry no recall value but together
//      account for ~3.79% of the screentime ledger. Rows with
//      duration_sec === null (unknown / not derivable from start/end) are
//      preserved — "unknown" is not the same as "short" and may still be a
//      meaningful glance.
//   5. raw_content.stream == "/app/intents" AND app_bundle_id is null AND
//      intent_class matches the EMPTY_PAYLOAD_INTENT_PAT (the known set of
//      bundle-id-omitted boilerplate intents: ANXSuggestionsIntent,
//      TBQuickOpenLinkIntent, MTUpdateAlarmIntent, etc.) → QUARANTINE
//         (reason: "empty_payload_intent", F-T2-SCREENTIME-F4 30d retention)
//      Rationale: ~1.19% of the ledger is bundle-id-null intent pings whose
//      payload carries no recall-relevant signal. The bundle=null clause
//      protects the URL-bearing TBQuickOpenLink rows that DO carry an
//      app_bundle_id so a future URL-extraction subrule can pick them up.
//   6. otherwise                                        → PASS
//
// Critic-driven change: rules 2 & 3 are NOT true permanent DROPs. We route
// through F-INFRA-QUARANTINE (lib/ingest/quarantine.js) so the operator can
// restore false positives during the 30-day retention window. The dispatcher
// still sees decision="DROP" + a specific reason string so the per-reason
// telemetry counter fires for dashboards and tests; the durable side-effect
// of the DROP is the quarantine JSONL, not a true row loss.
//
// Note: the connector ledger uses `raw_content.stream` for the
// ZSTREAMNAME column; the design doc names the source column directly. We
// match on the ledger-shape field name (`stream`) and fall back to
// `ZSTREAMNAME` defensively in case a future schema revision changes
// nomenclature.

import { CAPS } from "../../validation.js";
import { quarantineRow } from "../quarantine.js";
import { isContentFree } from "../../predicates/content-free.js";
import { checkCrossSourceDuplicate, canonicalizeHandle } from "../cross-source-dedup.js";
// F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION — central band helper.
// screentime's PASS path is a flat default (no length-cliff band), so the
// central helper is consulted via resolveBand("screentime", "default")
// rather than computeStructuralScore. The central import documents that
// screentime participates in the canonical structural-score interface
// even though its band table has only one entry.
import { resolveBand } from "../structural-score.js";
// F-NEW-W5-SCREENTIME-F4-COUNT-ONLY-TELEMETRY — recordPass is the
// dedicated PASS-with-reason telemetry helper for direct-call sites
// (tests, future non-dispatcher callers). The production dispatch path
// at lib/ingest/stage0/index.js already calls recordDrop with the
// returned reason+decision=PASS, so production never invokes recordPass
// from within the stage0 module — the import documents the wiring and
// gives tests a single import surface.
import { recordPass } from "./telemetry.js";

const DISCOVERABILITY_STREAM = "/discoverability/signals";
const NOTIFICATION_STREAM = "/notification/usage";
const APP_USAGE_STREAM = "/app/usage";
const APP_INTENTS_STREAM = "/app/intents";

const ITERM2_BUNDLE_ID = "com.googlecode.iterm2";

// Apple system-chrome notification bundles whose drops we route through
// quarantine. F-NEW-W1-SCREENTIME-APPLE-BUNDLE-COVERAGE: this pattern is
// the broad spec list from F-T1-SCREENTIME-F2.predicate — includes
// _SYSTEM_CENTER_ (the macOS Notification Center system anchor), the
// chrome family (controlcenter / systempreferences / software_update /
// BTM / accountsd), and the broader OS-notification bundles
// (notificationcenter, wifi.usernotifications, cmio, followup). The
// operator-visible Tips / Sharing carve-outs are handled by the SEPARATE
// APPLE_RETAIN_BUNDLE_PAT pre-check below.
const APPLE_CHROME_BUNDLE_PAT =
  /^(?:_SYSTEM_CENTER_|com\.apple\.(?:controlcenter|systempreferences|software_update|BTM|accountsd|notificationcenter|wifi\.usernotifications|cmio|followup))/;

// Operator-visible chrome bundles to EXEMPT from the quarantine. Pre-check
// runs before APPLE_CHROME_BUNDLE_PAT so a sharingd "AirDrop received"
// ping or a tips "Tip of the day" PASSes unconditionally even though it
// originates from a chrome-family bundle. Documented carve-out per the
// W1 review — narrow exemption so the 21.2% impact target is approached
// without destroying user-visible signal.
const APPLE_RETAIN_BUNDLE_PAT = /^com\.apple\.(?:sharingd|tips)/;

// Retention pattern for Apple system-chrome notifications that MUST PASS
// even when they originate from a chrome bundle. "Security Update" /
// "Critical" cover the macOS security-update push notification and the
// battery-critical / disk-critical family. Case-insensitive.
const APPLE_RETAIN_PAT = /security update|critical/i;

// F-T2-SCREENTIME-F3 — /app/usage micro-burst threshold. Rows with
// duration_sec strictly below this value (and not null) are quarantined
// as Cmd-Tab flickers / zero-duration bookkeeping rows. 5 seconds is the
// observation threshold from the spec.
const APP_USAGE_MICRO_BURST_SEC = 5;

// F-T2-SCREENTIME-F4 — known-empty-payload intent classes whose rows
// emit no bundle id. The set is exhaustive against the last 30 days of
// /app/intents drops (see node review_questions). New intent classes that
// land in /app/intents with bundle=null go through PASS and surface in
// the dispatcher telemetry as denominator volume; the operator adds them
// here only after observation.
const EMPTY_PAYLOAD_INTENT_PAT =
  /^(?:ANXSuggestionsIntent|TBQuickOpenLinkIntent|MTUpdateAlarmIntent|MTCreateAlarmIntent|WeatherIntent|TodayIntent|INCreateTimerIntent|INRunWorkflowIntent|LocateDeviceIntent)$/;

// F-NEW-W5-SCREENTIME-F4-COUNT-ONLY-TELEMETRY — env-gated activation
// knob for the F-NEW-W3-SCREENTIME-F4-INIINTENT-VERB-NULL branch.
//
// Modes:
//   "drop"       — production default (matches W3 ship state). The
//                  INIntent + bundle=null + verb=null path quarantines
//                  the row and returns DROP with reason
//                  REASON_EMPTY_PAYLOAD_INTENT.
//   "count_only" — observation mode. The branch returns PASS with
//                  reason "iniintent_null_verb_count_only" and does NOT
//                  quarantine. The dispatcher's recordDrop wrapper bumps
//                  the per-(source, decision=PASS, reason) counter so
//                  the operator can size the would-be-drop population
//                  without actually mutating ingest behaviour.
//
// Observation window discipline (node spec): the recommended count-only
// window is >=7 days. After the window closes the operator either:
//   (a) leaves the env unset / "drop" — the rule fires as a hard DROP
//       per its original W3 shape; or
//   (b) leaves it in count_only with a widened structural guard if the
//       observed false-positive rate is non-trivial.
//
// Time-gate option (node spec): SCREENTIME_INIINTENT_NULL_VERB_UNTIL
// accepts an ISO-8601 timestamp. When set AND count_only mode is active,
// the count-only path auto-flips to DROP after the timestamp passes.
// This lets the operator schedule the observation-window-close in
// advance without needing a redeploy. Parser is permissive: an
// unparseable / past timestamp falls back to count_only behaviour so a
// typo cannot silently re-arm the DROP path.
//
// Both env vars are read at module load (stable across a daemon's
// lifetime) and re-read inside iniIntentNullVerbMode() so tests that
// toggle them between assertions see the current value.
const INIINTENT_NULL_VERB_MODE_ENV = "SCREENTIME_INIINTENT_NULL_VERB_MODE";
const INIINTENT_NULL_VERB_UNTIL_ENV = "SCREENTIME_INIINTENT_NULL_VERB_UNTIL";
const INIINTENT_NULL_VERB_COUNT_ONLY_REASON = "iniintent_null_verb_count_only";

function iniIntentNullVerbMode(nowMs = Date.now()) {
  if (typeof process === "undefined" || !process.env) return "drop";
  const raw = process.env[INIINTENT_NULL_VERB_MODE_ENV];
  if (raw !== "count_only") return "drop";
  // Time-gate: if SCREENTIME_INIINTENT_NULL_VERB_UNTIL parses to a
  // timestamp <= now, the observation window has closed; flip back to
  // drop. Unparseable / past values default to count_only so a typo
  // cannot silently re-arm the DROP path.
  const untilRaw = process.env[INIINTENT_NULL_VERB_UNTIL_ENV];
  if (typeof untilRaw === "string" && untilRaw.length > 0) {
    const untilMs = Date.parse(untilRaw);
    if (Number.isFinite(untilMs) && untilMs <= nowMs) return "drop";
  }
  return "count_only";
}

// Per-rule reason strings. These are the canonical telemetry reasons fed
// to the Stage-0 dispatcher's recordDrop wrapper; they MUST be present in
// telemetry.js REASON_ALLOWLIST or the dispatcher will bucket them into
// "invalid_reason" and warn.
const REASON_ITERM2_EMPTY = "screentime_iterm2_empty_notif";
const REASON_APPLE_CHROME = "screentime_apple_chrome_notif";
const REASON_APP_USAGE_MICRO_BURST = "app_usage_micro_burst";
const REASON_EMPTY_PAYLOAD_INTENT = "empty_payload_intent";
// F-NEW-W7-SCREENTIME-INSENDMESSAGE-BURST-COLLAPSE — intra-source
// defense-in-depth for the prospective-tail observation that the
// CONTRACT_SCREENTIME_IMESSAGE cross-source-dedup substrate fails open
// silently on INSendMessageIntent bursts (4-6 row clusters within 1-3
// seconds all PASSing). The intra-source LRU below is a narrower probe:
// same canonical handle (from related_contact_ids or interaction_id) seen
// within INSENDMESSAGE_BURST_WINDOW_MS quarantines as a same-source
// duplicate. This does NOT subsume the cross-source contract — the
// cross-source rule still fires for the FIRST row of a burst (when an
// imessage twin exists); the intra-source rule collapses the 2..N tail
// that arrives within 5 seconds of any prior in-burst row.
const REASON_INSENDMESSAGE_BURST_DUP = "screentime_insendmessage_burst_dup";

// F-NEW-W7-SCREENTIME-INSENDMESSAGE-BURST-COLLAPSE — LRU cache parameters.
// The cache is process-local and bounded at INSENDMESSAGE_LRU_CAP entries.
// Eviction order is insertion-order (Map iteration preserves it); when
// size exceeds the cap we delete the oldest entry. Lifetime is the
// daemon process — entries naturally age out via the window check rather
// than a TTL sweep (a stale entry simply fails the 5-second freshness
// test on next probe). Capacity of 1000 distinct handles is conservative
// vs the observed ~hundreds-of-distinct-handles-per-day screentime cohort
// per the operator's ledger; the cap protects against a runaway handle
// space (e.g. spam shortcodes) silently growing memory.
const INSENDMESSAGE_LRU_CAP = 1000;
const INSENDMESSAGE_BURST_WINDOW_MS = 5_000;
const INSENDMESSAGE_LRU = new Map(); // key=canonical handle → last-seen ms

// Quarantine retention. The quarantine layer's retention window is global
// (QUARANTINE_RETENTION_DAYS env override, default 30d); we record the
// intent here for forward-compat with a per-call override if the layer
// adopts one.
const QUARANTINE_RETENTION_DAYS = 30;

// isEmptyString — null/undefined/whitespace-only → true. Mirrors the
// content-free predicate's notion of "empty text".
function isEmptyString(v) {
  if (v === null || v === undefined) return true;
  if (typeof v !== "string") return false;
  return v.trim().length === 0;
}

// readNotificationField — case-insensitive, defensive lookup for the title
// and body fields on a /notification/usage row. Some screentime exports
// nest the payload directly on raw_content; the connector row builders
// preserve source-native casing.
function readNotificationField(rc, name) {
  if (!rc || typeof rc !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(rc, name)) return rc[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(rc)) {
    if (k.toLowerCase() === lower) return rc[k];
  }
  return undefined;
}

// F-NEW-W7-SCREENTIME-INSENDMESSAGE-BURST-COLLAPSE — derive the canonical
// handle for an INSendMessageIntent row. Mirrors the substrate's
// _extractScreentimeSendMessage handle selection (related_contact_ids
// first, interaction_id fallback) and runs it through canonicalizeHandle
// so phone/E.164 variants collapse to the same key. Returns "" when no
// handle is derivable — caller treats that as "skip the LRU probe", since
// keyless burst collapse would over-aggregate every keyless intent ping.
//
// F-NEW-W7-SCREENTIME-HANDLE-NORMALIZE-ALIGN — the candidate set
// (related_contact_ids, then interaction_id) MUST match
// cross-source-dedup.js::_extractScreentimeSendMessage exactly. Both
// burst-collapse and the cross-source contract therefore key on the
// identical canonical handle: a row whose burst-collapse fingerprint
// differs from its cross-source fingerprint would silently disagree on
// which rows are dups. The derived_intent_id fallback that previously
// lived here would have widened the burst-collapse key surface beyond
// what the cross-source substrate sees; removed for parity. Both paths
// now call canonicalizeHandle() with source="screentime" so phone/E.164
// percent-decoded variants collapse identically.
function _deriveInsendmessageHandle(rc) {
  if (!rc || typeof rc !== "object") return "";
  const handleRaw =
    (typeof rc.related_contact_ids === "string" && rc.related_contact_ids) ||
    (typeof rc.interaction_id === "string" && rc.interaction_id) ||
    "";
  return canonicalizeHandle(handleRaw, "screentime");
}

// F-NEW-W7-SCREENTIME-INSENDMESSAGE-BURST-COLLAPSE — LRU probe. Returns
// the last-seen timestamp (ms) if the handle is in cache, else null.
// Always stamps `nowMs` as the freshest seen time AFTER the probe so a
// late arrival in a long burst still extends the freshness window forward
// (the burst keeps collapsing while events keep arriving within 5s of
// the most recent — desirable behaviour: a sustained 30-row 8s tail
// stays collapsed to a single PASS even though no individual pair is
// more than 5s apart from the LAST observed, not the first).
function _probeAndStampInsendmessageLru(handle, nowMs) {
  if (!handle) return null;
  const prev = INSENDMESSAGE_LRU.get(handle);
  // Map preserves insertion order; re-set to move to the end (LRU bump).
  if (prev !== undefined) INSENDMESSAGE_LRU.delete(handle);
  INSENDMESSAGE_LRU.set(handle, nowMs);
  // Enforce cap by evicting oldest entries.
  while (INSENDMESSAGE_LRU.size > INSENDMESSAGE_LRU_CAP) {
    const oldestKey = INSENDMESSAGE_LRU.keys().next().value;
    if (oldestKey === undefined) break;
    INSENDMESSAGE_LRU.delete(oldestKey);
  }
  return prev !== undefined ? prev : null;
}

// F-NEW-W7-SCREENTIME-USAGE-DURATION-BAND — banded structural-score for
// /app/usage rows. Replaces the flat 0.40 default with a duration-aware
// banding so salience downstream can distinguish a 7-minute focused work
// session (worth keeping) from a 2-second flicker (noise; already
// quarantined by the F-T2-SCREENTIME-F3 < 5s rule). The 0.10/0.20 band
// values overlap with the < 5s DROP path (defense-in-depth: if a future
// MIN_PROMOTE_STRUCTURAL_SCORE-driven re-route reads the score before
// the quarantine path fires, the score still labels the row as low
// signal). Bands derived from the operator's observation buckets:
//   <5s: micro-burst (already DROPped above; kept for completeness)
//   5-30s: brief glance — switched apps, noticed but did not engage
//   30-120s: engaged — read a short reply, watched a UI animation
//   120-600s: focused work session — meaningful attention block
//   >=600s: sustained activity — recall-worthy
// Rows with duration_sec == null fall through to the legacy resolveBand
// default (signal-bearing unknown, not assumed-low).
//
// F-NEW-W7-SCREENTIME-BAND-CENTRAL-SCORE — the band score for each name
// is resolved via resolveBand("screentime", <name>) so a central per-
// source override in CAPS.SALIENCE_STRUCTURAL_RULES.screentime can
// re-tune any band without editing screentime.js. The constants below
// are the module-local defaults applied when the central table has no
// entry for that band name; the name strings are stable identifiers
// shared between the module-local defaults and the central table.
export const USAGE_DURATION_BAND_NAMES = Object.freeze({
  MICRO_BURST: "usage_band_micro_burst",
  BRIEF_GLANCE: "usage_band_brief_glance",
  ENGAGED: "usage_band_engaged",
  FOCUSED_WORK: "usage_band_focused_work",
  SUSTAINED: "usage_band_sustained",
});

export const USAGE_DURATION_BAND_DEFAULTS = Object.freeze({
  [USAGE_DURATION_BAND_NAMES.MICRO_BURST]: 0.10,
  [USAGE_DURATION_BAND_NAMES.BRIEF_GLANCE]: 0.20,
  [USAGE_DURATION_BAND_NAMES.ENGAGED]: 0.35,
  [USAGE_DURATION_BAND_NAMES.FOCUSED_WORK]: 0.50,
  [USAGE_DURATION_BAND_NAMES.SUSTAINED]: 0.65,
});

// _resolveUsageBand — look up the named band via the central helper,
// fall back to the module-local default when CAPS has no override. Kept
// as a single-entry function so the band-resolution logic has one
// callsite to audit.
function _resolveUsageBand(name) {
  const central = resolveBand("screentime", name);
  if (typeof central === "number" && Number.isFinite(central)) return central;
  return USAGE_DURATION_BAND_DEFAULTS[name];
}

function _appUsageDurationBand(durationSec) {
  if (typeof durationSec !== "number" || !Number.isFinite(durationSec)) {
    return null;
  }
  if (durationSec < 5) {
    return _resolveUsageBand(USAGE_DURATION_BAND_NAMES.MICRO_BURST);
  }
  if (durationSec < 30) {
    return _resolveUsageBand(USAGE_DURATION_BAND_NAMES.BRIEF_GLANCE);
  }
  if (durationSec < 120) {
    return _resolveUsageBand(USAGE_DURATION_BAND_NAMES.ENGAGED);
  }
  if (durationSec < 600) {
    return _resolveUsageBand(USAGE_DURATION_BAND_NAMES.FOCUSED_WORK);
  }
  return _resolveUsageBand(USAGE_DURATION_BAND_NAMES.SUSTAINED);
}

export function stage0(event) {
  if (!event || typeof event !== "object") {
    return { decision: "PASS", reason: null };
  }
  const rc = event.raw_content || {};
  const streamName =
    (typeof rc.stream === "string" && rc.stream) ||
    (typeof rc.ZSTREAMNAME === "string" && rc.ZSTREAMNAME) ||
    "";
  if (streamName === DISCOVERABILITY_STREAM) {
    // F-T2-SCREENTIME-F6: the connector now deletes this stream from its
    // STREAM_DISPATCH so the row never reaches Stage-0. This rule survives
    // as defense-in-depth for any straggler emitted via a non-dispatch
    // path (e.g. test fixtures, future replay tooling). Discoverability
    // signals are spotlight invocation pings — universally noise.
    return { decision: "DROP", reason: "discoverability_signals" };
  }

  // F-T1-SCREENTIME-F2 — iterm2 + Apple system-chrome notification rules.
  if (streamName === NOTIFICATION_STREAM) {
    const bundleId =
      typeof rc.notifying_bundle_id === "string" ? rc.notifying_bundle_id : "";
    const title = readNotificationField(rc, "title");
    const body = readNotificationField(rc, "body");
    const titleEmpty = isEmptyString(title);
    const bodyEmpty = isEmptyString(body);

    // Rule 2 — iterm2: quarantine only when title AND body are both empty.
    // Long-task completion pings (any non-empty title or body) are real
    // attention events and PASS.
    if (bundleId === ITERM2_BUNDLE_ID) {
      if (titleEmpty && bodyEmpty) {
        // Defensive parity-check with the shared content-free predicate.
        // For /notification/usage the manifest spec is ["body","title"]; if
        // either is populated the predicate returns drop=false and we
        // should NOT quarantine even when our local empties check says so
        // (e.g. attachments-only payload would be a future extension).
        const cf = isContentFree(event, "screentime");
        if (cf && cf.drop) {
          quarantineRow(event, REASON_ITERM2_EMPTY, {
            rule_id: "F-T1-SCREENTIME-F2/iterm2_empty",
            source: "screentime",
          });
          // Note: quarantineRow already bumps its own in-process drop
          // counter (lib/ingest/quarantine.js). The dispatcher's
          // REASON_ALLOWLIST counter fires on the returned decision below.
          return { decision: "DROP", reason: REASON_ITERM2_EMPTY };
        }
      }
      // iterm2 with any title/body content — real attention event. PASS.
    } else if (
      APPLE_CHROME_BUNDLE_PAT.test(bundleId) &&
      !APPLE_RETAIN_BUNDLE_PAT.test(bundleId)
    ) {
      // Rule 3 — Apple system-chrome bundles (broad pattern per the W1
      // follow-up). The retain bundle pre-check (Tips / Sharing) runs
      // first and unconditionally PASSes those operator-visible
      // notifications. Then the text-level retain pattern carves out
      // Security-Update / Critical even when the row originates from a
      // chrome bundle. Everything else quarantines.
      const titleStr = typeof title === "string" ? title : "";
      const bodyStr = typeof body === "string" ? body : "";
      const retain =
        APPLE_RETAIN_PAT.test(titleStr) || APPLE_RETAIN_PAT.test(bodyStr);
      if (!retain) {
        quarantineRow(event, REASON_APPLE_CHROME, {
          rule_id: "F-T1-SCREENTIME-F2/apple_chrome",
          source: "screentime",
        });
        return { decision: "DROP", reason: REASON_APPLE_CHROME };
      }
      // Security-Update / Critical — PASS even from a chrome bundle.
    }
  }

  // F-T2-SCREENTIME-F3 — /app/usage micro-burst quarantine.
  // Sub-5-second app usage rows (and zero-duration bookkeeping rows where
  // ZSTARTDATE == ZENDDATE) carry no recall value. duration_sec===null is
  // explicitly preserved — "unknown duration" is signal-bearing (we don't
  // know whether the operator looked at the app for 1s or 1h).
  if (streamName === APP_USAGE_STREAM) {
    const dur = rc.duration_sec;
    if (typeof dur === "number" && Number.isFinite(dur) && dur < APP_USAGE_MICRO_BURST_SEC) {
      quarantineRow(event, REASON_APP_USAGE_MICRO_BURST, {
        rule_id: "F-T2-SCREENTIME-F3/app_usage_micro_burst",
        source: "screentime",
      });
      return { decision: "DROP", reason: REASON_APP_USAGE_MICRO_BURST };
    }
  }

  // F-T2-SCREENTIME-F4 — /app/intents empty-payload intent quarantine.
  // Rows where app_bundle_id is null AND intent_class is on the known
  // empty-payload allowlist (ANXSuggestionsIntent, TBQuickOpenLinkIntent,
  // ...) carry no recall value. Bundle-id-present rows are PRESERVED so
  // a TBQuickOpenLink that DID stamp a bundle (because the destination
  // app was inferred) reaches a future URL-extraction subrule.
  //
  // F-NEW-W3-SCREENTIME-F4-INIINTENT-VERB-NULL — second clause of the
  // original F4 predicate that was deferred at W2 ship time. INIntent is
  // the macOS SiriKit base class used by every system-generated intent;
  // an INIntent-class row with intent_verb==null (no SendMessage, no
  // SearchForMessages, no SetTaskAttribute — just a bare INIntent ping
  // with no verb attached) carries no recall-relevant signal. We add the
  // clause as an OR so the original allowlist branch still fires for
  // the legacy ANXSuggestionsIntent / TBQuickOpenLinkIntent / ... case,
  // AND any INIntent emission with a null verb also drops (quarantined
  // for 30d so a future analysis can reclassify if operator behaviour
  // produces an unforeseen INIntent shape).
  //
  // SAFETY: gated by bundleId==null AND intent_verb==null. An INIntent
  // with bundleId set OR a non-null intent_verb (e.g.
  // intent_class="INSendMessageIntent" or intent_class="INIntent" +
  // intent_verb="SendMessage") PASSes through unchanged.
  //
  // F-NEW-W5-SCREENTIME-F4-COUNT-ONLY-TELEMETRY — reversible activation
  // path for the iniIntentNullVerb branch (W5 closeout for the deferred
  // W3 review-question Q3 "count-only telemetry pre-stage present and
  // documented"). The branch defaults to DROP (production-since-W3
  // behaviour); operator can flip it to count_only mode via the env
  // SCREENTIME_INIINTENT_NULL_VERB_MODE=count_only knob (see the
  // iniIntentNullVerbMode resolver above). In count_only mode the
  // branch:
  //   * does NOT quarantine,
  //   * returns PASS with a distinct reason
  //     "iniintent_null_verb_count_only", and
  //   * relies on the dispatcher's recordDrop wrapper to bump the
  //     per-(source, decision=PASS, reason) counter so the would-be-drop
  //     volume is sized over the >=7-day observation window before the
  //     operator either restores DROP behaviour or widens the structural
  //     guard. The allowlist branch (legacy boilerplate intents) is NOT
  //     affected by the count-only mode — it continues to DROP as
  //     before, because the W3 spec for that branch was already
  //     operator-reviewed at W2 ship time and is not on the deferred-
  //     review queue. Only the iniIntentNullVerb arm is gated.
  if (streamName === APP_INTENTS_STREAM) {
    const bundleId = rc.app_bundle_id;
    const intentClass = typeof rc.intent_class === "string" ? rc.intent_class : "";
    const intentVerb = rc.intent_verb;
    const allowlistHit =
      bundleId == null && EMPTY_PAYLOAD_INTENT_PAT.test(intentClass);
    // F-NEW-W3: INIntent base-class + null verb. `intentVerb == null`
    // catches both null and undefined; whitespace-only strings still
    // PASS because operator-typed verbs can be short but never empty.
    const iniIntentNullVerb =
      bundleId == null &&
      intentClass === "INIntent" &&
      intentVerb == null;
    if (iniIntentNullVerb && iniIntentNullVerbMode() === "count_only") {
      // F-NEW-W5-SCREENTIME-F4-COUNT-ONLY-TELEMETRY — PASS+log mode.
      // Returning reason here is sufficient for the dispatcher to bump
      // the per-reason PASS counter; we additionally call recordPass
      // for direct-call sites (tests, future bypass-dispatch callers)
      // so the counter fires regardless of caller path. recordPass is
      // idempotent w.r.t. the dispatcher's recordDrop only in the sense
      // that both feed the same Map — the operator should treat the
      // count_only counter as authoritative for the sizing decision
      // and NOT as a sub-total of dispatcher PASS volume. Production
      // ingest exclusively goes through the dispatcher so the explicit
      // call below is a no-op in the production hot path; we wrap it
      // in try/catch so direct-call sites (tests) cannot crash the
      // module if telemetry is mid-flush.
      try {
        recordPass("screentime", INIINTENT_NULL_VERB_COUNT_ONLY_REASON);
      } catch {
        /* never crash hot path on telemetry write */
      }
      return {
        decision: "PASS",
        reason: INIINTENT_NULL_VERB_COUNT_ONLY_REASON,
      };
    }
    if (allowlistHit || iniIntentNullVerb) {
      quarantineRow(event, REASON_EMPTY_PAYLOAD_INTENT, {
        rule_id: iniIntentNullVerb
          ? "F-NEW-W3-SCREENTIME-F4-INIINTENT-VERB-NULL/iniintent_null_verb"
          : "F-T2-SCREENTIME-F4/empty_payload_intent",
        source: "screentime",
      });
      return { decision: "DROP", reason: REASON_EMPTY_PAYLOAD_INTENT };
    }
  }

  // F-T2-SCREENTIME-F8 / F-NEW-W3-SCREENTIME-F8-XSRC-PROBE-SUBSTRATE —
  // cross-source dedup contract (INSendMessageIntent vs iMessage source).
  // Now WIRED via the generic Layer-1.5 substrate at
  // lib/ingest/cross-source-dedup.js (F-CROSS-CROSS-SOURCE-DEDUP / R50).
  // The substrate owns the lookup against the iMessage ledger (canonical
  // handle equality, +/- 5min window per CONTRACT_SCREENTIME_IMESSAGE);
  // Stage-0 here owns the DROP decision.
  //
  // Scope gate: only /app/intents rows with intent_class ==
  // 'INSendMessageIntent' are candidates — the substrate's extract_a
  // returns null for everything else, but we gate at the call site so
  // non-candidate rows do not incur the cache lookup. Fail-open: any
  // substrate error returns is_dup=false; the dispatch is never blocked.
  if (streamName === APP_INTENTS_STREAM) {
    const intentClass =
      typeof rc.intent_class === "string" ? rc.intent_class : "";
    if (intentClass === "INSendMessageIntent") {
      // F-NEW-W7-SCREENTIME-INSENDMESSAGE-BURST-COLLAPSE — intra-source
      // defense-in-depth before the cross-source substrate. The audit
      // observed prospective-tail clusters of 4-6 INSendMessageIntent
      // rows for the same canonical handle within 1-3 seconds all
      // PASSing because the cross-source contract fails open when the
      // paired iMessage row hasn't landed yet (or never does). We probe
      // a process-local LRU keyed by canonical handle: any row whose
      // handle was last seen within INSENDMESSAGE_BURST_WINDOW_MS (5s)
      // quarantines as a same-source burst duplicate. Keyless rows
      // (no handle derivable from related_contact_ids / interaction_id)
      // skip the probe — the cross-source substrate may still pick
      // them up via interaction_id parity.
      //
      // Ordering rationale: this runs BEFORE the cross-source substrate
      // call so the substrate's window-and-cache state is not polluted
      // by the burst tail. The FIRST row in a burst still flows through
      // the substrate; 2..N quarantine here.
      const burstNowMs = Number.isFinite(Date.parse(event?.ts))
        ? Date.parse(event.ts)
        : Date.now();
      const burstHandle = _deriveInsendmessageHandle(rc);
      if (burstHandle) {
        const lastSeenMs = _probeAndStampInsendmessageLru(
          burstHandle,
          burstNowMs
        );
        if (
          typeof lastSeenMs === "number" &&
          Number.isFinite(lastSeenMs) &&
          burstNowMs - lastSeenMs <= INSENDMESSAGE_BURST_WINDOW_MS &&
          burstNowMs - lastSeenMs >= 0
        ) {
          try {
            quarantineRow(event, REASON_INSENDMESSAGE_BURST_DUP, {
              rule_id:
                "F-NEW-W7-SCREENTIME-INSENDMESSAGE-BURST-COLLAPSE/intra_source_burst",
              source: "screentime",
              handle: burstHandle,
              delta_ms: burstNowMs - lastSeenMs,
              window_ms: INSENDMESSAGE_BURST_WINDOW_MS,
            });
          } catch {
            /* hot path safety — never crash Stage-0 on quarantine write */
          }
          return {
            decision: "DROP",
            reason: REASON_INSENDMESSAGE_BURST_DUP,
          };
        }
      }
      let xsrc;
      try {
        xsrc = checkCrossSourceDuplicate(event, "screentime");
      } catch {
        // Substrate is fail-open by contract; this catch is defense-in-
        // depth so any thrown error here never crashes Stage-0.
        xsrc = { is_dup: false };
      }
      if (xsrc && xsrc.is_dup === true) {
        const reason =
          typeof xsrc.reason === "string" && xsrc.reason.length > 0
            ? xsrc.reason
            : "cross_source_dup_screentime_imessage";
        try {
          quarantineRow(event, reason, {
            rule_id: "F-T2-SCREENTIME-F8/cross_source_dup_imessage",
            source: "screentime",
            paired_source: xsrc.paired_source,
            paired_id: xsrc.paired_id,
            contract: xsrc.contract,
          });
        } catch {
          /* hot path safety — never crash Stage-0 on quarantine write */
        }
        return { decision: "DROP", reason };
      }
    }
  }

  // F-NEW-W5-STRUCTURAL-SCORE-CENTRAL-EXTRACTION: resolve the screentime
  // default band via the central helper. Functionally identical to the
  // pre-W5 inline `rules.default ?? 0.4` lookup; routed through
  // structural-score.js so a future re-calibration touches one place.
  const defaultScore = resolveBand("screentime", "default");
  const fallbackScore = typeof defaultScore === "number" ? defaultScore : 0.4;

  // F-NEW-W7-SCREENTIME-USAGE-DURATION-BAND — banded scoring for the
  // /app/usage stream. A flat 0.40 default treats a 4-second Chrome blip
  // (already quarantined upstream by F-T2-SCREENTIME-F3 < 5s rule, but
  // for completeness) the same as a 7-minute mail read. With banding the
  // downstream salience layer can distinguish "the operator used Chrome for 7
  // minutes" (0.50, focused-work) from "Chrome flickered for 12 seconds"
  // (0.20, brief glance). Rows where duration_sec is null or non-numeric
  // fall back to the legacy resolveBand default — "unknown duration" is
  // explicitly signal-bearing, not assumed-low. The banding is applied
  // here (in the trailing PASS path) because all DROP paths above have
  // already filtered the noise floor; this is the residual /app/usage
  // population that survives Stage-0.
  if (streamName === APP_USAGE_STREAM) {
    const dur = rc.duration_sec;
    const band = _appUsageDurationBand(dur);
    if (typeof band === "number") {
      return {
        decision: "PASS",
        reason: null,
        structural_score: band,
      };
    }
  }

  return {
    decision: "PASS",
    reason: null,
    structural_score: fallbackScore,
  };
}

export function structuralRules() {
  return { ...(CAPS.SALIENCE_STRUCTURAL_RULES?.screentime || {}) };
}

// Exported constants are test handles and operator-tooling read surfaces.
// They are deliberately not part of the runtime stage0() contract.
export const _F_T1_SCREENTIME_F2 = Object.freeze({
  REASON_ITERM2_EMPTY,
  REASON_APPLE_CHROME,
  ITERM2_BUNDLE_ID,
  APPLE_CHROME_BUNDLE_PAT,
  APPLE_RETAIN_BUNDLE_PAT,
  APPLE_RETAIN_PAT,
  QUARANTINE_RETENTION_DAYS,
});

// F-T2-SCREENTIME-F3 / F4 / W1 follow-up — test handles for the new rules.
export const _F_T2_SCREENTIME_F3 = Object.freeze({
  REASON_APP_USAGE_MICRO_BURST,
  APP_USAGE_MICRO_BURST_SEC,
  APP_USAGE_STREAM,
});

export const _F_T2_SCREENTIME_F4 = Object.freeze({
  REASON_EMPTY_PAYLOAD_INTENT,
  EMPTY_PAYLOAD_INTENT_PAT,
  APP_INTENTS_STREAM,
});

// F-NEW-W5-SCREENTIME-F4-COUNT-ONLY-TELEMETRY — test handles for the
// count-only mode resolver. Exposed for the W5 closeout test that
// asserts:
//   * default mode is "drop" (no regression vs W3 ship state);
//   * SCREENTIME_INIINTENT_NULL_VERB_MODE=count_only flips to count_only;
//   * SCREENTIME_INIINTENT_NULL_VERB_UNTIL with a past timestamp flips
//     back to drop.
export const _F_NEW_W5_SCREENTIME_F4_COUNT_ONLY = Object.freeze({
  INIINTENT_NULL_VERB_MODE_ENV,
  INIINTENT_NULL_VERB_UNTIL_ENV,
  INIINTENT_NULL_VERB_COUNT_ONLY_REASON,
  iniIntentNullVerbMode,
});

// F-NEW-W7-SCREENTIME-INSENDMESSAGE-BURST-COLLAPSE — test handles for the
// intra-source LRU dedup. The Map itself is exported by reference so
// tests can resetForTests() the cache (clearing INSENDMESSAGE_LRU between
// runs is sufficient — no module-state TTL sweep). _deriveHandle and
// _probe expose the helpers so unit tests can assert canonicalisation
// parity with the cross-source substrate's _extractScreentimeSendMessage.
export const _F_NEW_W7_SCREENTIME_INSENDMESSAGE_BURST = Object.freeze({
  REASON_INSENDMESSAGE_BURST_DUP,
  INSENDMESSAGE_LRU_CAP,
  INSENDMESSAGE_BURST_WINDOW_MS,
  INSENDMESSAGE_LRU,
  _deriveHandle: _deriveInsendmessageHandle,
  _probe: _probeAndStampInsendmessageLru,
});

// F-NEW-W7-SCREENTIME-LRU-RESET-TEST-HELPER — hermetic test setup.
// Clears every piece of in-process state owned by this module so a test
// runner can run assertions in any order without one test's LRU residue
// bleeding into the next. Currently the only in-process state is the
// INSENDMESSAGE_LRU map (the count-only mode reads process.env on each
// call, so it has no module-state to reset). Future module-state
// additions MUST extend this function — the helper is the single
// audited setup hook tests rely on.
export function resetForTests() {
  INSENDMESSAGE_LRU.clear();
}

// F-NEW-W7-SCREENTIME-USAGE-DURATION-BAND — test handles for the duration-
// banded structural-score helper. The band function is exposed so tests
// can assert the boundary values (4s → 0.10, 5s → 0.20, 30s → 0.35,
// 120s → 0.50, 600s → 0.65) independent of stage0() dispatch.
export const _F_NEW_W7_SCREENTIME_USAGE_DURATION_BAND = Object.freeze({
  _appUsageDurationBand,
});
