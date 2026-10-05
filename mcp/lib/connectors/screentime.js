// screentime.js — Phase 2b ScreenTime / knowledgeC.db connector.
//
// Reads ~/Library/Application Support/Knowledge/knowledgeC.db (a SQLite
// database CoreDuet writes whenever Screen Time / focus / search / Safari
// activity occurs on the Mac) and folds active Focus / DND state from
// ~/Library/DoNotDisturb/Assertions.json as an enrichment column on every
// emitted row.
//
// Authoritative spec: kb/source-fidelity-spec.md § 1 (per-stream row builders).
// Round-21 brutalist downgrade and 2026-06-02 post-activation inspection
// surfaced that the v1 connector queried a static IN-list of stream names and
// returned the bundle-id-only shape on every row, hiding URL / query /
// notification / intent metadata sitting one JOIN away in
// ZSTRUCTUREDMETADATA. This v2 fixes that:
//
//   * ONE query per page joining ZOBJECT to ZSTRUCTUREDMETADATA. SELECT every
//     column the dispatch table cares about; the per-stream row-builder
//     picks the ones meaningful for its stream.
//   * Per-stream dispatch table. Streams not in the table are SKIPPED
//     SILENTLY — the cursor advances past them so the next poll does not
//     re-scan, but error_count is NOT incremented (unrecognized rows are
//     noise, not failures).
//   * Per-stream row-builders carry the full meaningful field set
//     (app_bundle_id / url / title / query_text / intent_class / etc.)
//     instead of collapsing every stream to {bundle, url, query}.
//
// The knowledgeC.db schema (the bits this connector touches):
//
//   ZOBJECT
//     Z_PK              INTEGER PRIMARY KEY  -- monotonic; the cursor field
//     ZSTREAMNAME       VARCHAR              -- "/app/usage" etc.
//     ZSTARTDATE        TIMESTAMP            -- Mac Absolute Time as INTEGER
//                                            -- seconds since 2001-01-01Z
//                                            -- (= unix_epoch - 978307200);
//                                            -- magnitudes ≤ ~8.0e8, BIGINT-safe.
//     ZENDDATE          TIMESTAMP            -- Mac Absolute Time INTEGER seconds.
//     ZVALUESTRING      VARCHAR              -- bundle id / URL / query string
//                                            -- (stream-dependent meaning)
//     ZVALUEINTEGER     INTEGER              -- 64-bit hash / id / bool sidecar.
//                                            -- BIGINT-UNSAFE: 92% of real rows
//                                            -- exceed Number.MAX_SAFE_INTEGER
//                                            -- (R23 catalog), so the SELECT
//                                            -- projects it as CAST(...AS TEXT)
//                                            -- and downstream consumers treat
//                                            -- it as a string.
//     ZSTRUCTUREDMETADATA INTEGER (rowid)    -- FK -> ZSTRUCTUREDMETADATA
//
//   ZSTRUCTUREDMETADATA (a wide column-per-key table; SQL not bplist)
//     Z_PK                                            INTEGER PRIMARY KEY
//     Z_DKSAFARIHISTORYMETADATAKEY__URL               VARCHAR
//     Z_DKSAFARIHISTORYMETADATAKEY__TITLE             VARCHAR
//     Z_DKSEARCHQUERYUSAGEMETADATAKEY__QUERYSTRING    VARCHAR
//     Z_DKFOCUSSTATEMETADATAKEY__ACTIVE               INTEGER
//     Z_DKFOCUSSTATEMETADATAKEY__MODEIDENTIFIER       VARCHAR
//     Z_DKINTENTMETADATAKEY__INTENTCLASS              VARCHAR
//     Z_DKINTENTMETADATAKEY__INTENTVERB               VARCHAR
//     Z_DKINTENTMETADATAKEY__DIRECTION                INTEGER
//     Z_DKINTENTMETADATAKEY__INTENTTYPE               INTEGER
//     Z_DKINTENTMETADATAKEY__INTENTHANDLINGSTATUS     INTEGER
//     Z_DKINTENTMETADATAKEY__INTERACTIONIDENTIFIER    VARCHAR
//     Z_DKINTENTMETADATAKEY__DERIVEDINTENTIDENTIFIER  VARCHAR
//     Z_DKINTENTMETADATAKEY__RELATEDCONTACTIDENTIFIERS VARCHAR
//     Z_DKINTENTMETADATAKEY__DONATEDBYSIRI            INTEGER
//     Z_DKNOTIFICATIONUSAGEMETADATAKEY__BUNDLEID      VARCHAR
//     Z_DKNOTIFICATIONUSAGEMETADATAKEY__IDENTIFIER    VARCHAR
//     Z_DKAPPMEDIAUSAGEMETADATAKEY__MEDIAURL          VARCHAR
//     Z_DKAPPMEDIAUSAGEMETADATAKEY__URL               VARCHAR
//     Z_DKDIGITALHEALTHMETADATAKEY__WEBDOMAIN         VARCHAR
//     Z_DKDIGITALHEALTHMETADATAKEY__WEBPAGEURL        VARCHAR
//     Z_DKDIGITALHEALTHMETADATAKEY__USAGETYPE         INTEGER
//     Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__OSBUILD  VARCHAR
//
// The real production table carries ~200 columns; we project only the ones
// the dispatch table references. The test fixture mirrors the same shape.
//
// CONSENT CLASSIFIER (round-20 close, kb/connectors-survey.md § screentime):
//   Every row -> {deletion_semantics: "full_excise", consent_basis:
//   "first_party"}. The operator is the sole subject of every ZOBJECT row
//   on their own machine.
//
// CURSOR CHOICE (Z_PK over ZSTARTDATE):
//   Z_PK is monotonic-per-insert; ZSTARTDATE can be re-issued out of order
//   when CoreDuet backfills. Z_PK guarantees exactly-once advance and trivial
//   restart-recovery (WHERE Z_PK > cursor ORDER BY Z_PK ASC LIMIT N).
//
// NO NEW NPM DEPS: node:sqlite + node:fs only. The metadata table is regular
// SQL (column-per-key), NOT a binary plist, so no bplist parser is needed —
// confirmed against the real knowledgeC.db on macOS Tahoe 26.x.
//
// HERMETICITY:
//   Production paths flow through env vars (MEMORY_ROOT / per-dir
//   overrides). Tests redirect every disk write/read by pinning
//   CONNECTORS_BASE_DIR + STORAGE_BASE_DIR + MEMORY_ROOT before the first
//   dynamic import. Synthetic fixtures (test/fixtures/screentime-fixture.sql)
//   cover every code path; the real ~/Library/Application Support/Knowledge/
//   knowledgeC.db is never opened during `npm test`.

import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

import { ConnectorBase } from "./index.js";
import { serverTs } from "../envelope.js";

// F-CCS-CONNECTOR-screentime-structural (W3-CCS) — slugify + canonical-id
// discipline lives in the substrate entity-extractor module. Re-using it here
// guarantees connector-stamped canonical_ids are byte-identical to the
// cascade text-extractor's canonical_ids for the same surface (foundation
// spec §6 merge invariant). We mirror the W2 git-log-structural pattern of
// importing slugify+SLUG_EMPTY_SENTINEL+ENTITY_SLUG_REGEX (NOT
// buildCanonicalId; that raises on the empty-slug sentinel while we want
// the connector to degrade gracefully — drop the entity, keep the row).
import {
  slugify as entitySlugify,
  ENTITY_SLUG_REGEX,
  SLUG_EMPTY_SENTINEL,
} from "../synthesis/entity-extractor.js";

// =============================================================================
// W9 STREAM NARROWING — CAPTURED_STREAMS allowlist (WU-screentime-stream-narrow).
// =============================================================================
//
// Wave 9 audit found the screentime streams have wildly different
// signal/noise ratios per observations on the operator install:
//
//   /app/intents              KEEP   — Apple Intents (INStartCallIntent,
//                                      MTCreateAlarmIntent, TBQuickOpenLinkIntent,
//                                      INPlayMediaIntent, INSendMessageIntent).
//                                      ~1,179/week. Some noise but real signal,
//                                      and the cross-source-dedup substrate's
//                                      screentime contract is anchored here.
//   /app/usage                KEEP   — App foreground intervals with duration.
//                                      ~719/week. Useful for time-shape.
//   /app/webUsage             KEEP   — Safari URLs with web_domain/web_url.
//                                      0 in current data but signal-bearing
//                                      when present.
//   /discoverability/signals  DROP   — Largest noise class historically (5,361
//                                      rows in an earlier audit). Already 0 in
//                                      current data; STREAM_DISPATCH no longer
//                                      lists it (F-T2-SCREENTIME-F6). The
//                                      CAPTURED_STREAMS gate makes the drop
//                                      explicit in case the dispatch row is
//                                      ever restored without re-considering.
//   /notification/usage       DROP   — ~92% iterm2 shell-pings; 831/week with
//                                      ~99% noise.
//   /app/mediaUsage           DROP   — Null-everywhere on every observed row.
//
// The other historically-dispatched streams (/app/inFocus, /safari/history,
// /search/queryusage, /focus/state) currently emit 0 rows in observed data
// and are not in the W9 audit's keep-set, so the allowlist excludes them
// too. To flip any stream back on:
//   1. Make sure STREAM_DISPATCH has a row-builder for it.
//   2. Add the stream string to CAPTURED_STREAMS below.
// To turn one off in the future, just delete it from CAPTURED_STREAMS — the
// row-builder can stay around, so the change is reversible without touching
// the metadata projection.
//
// This filter sits at the CONNECTOR (emission) layer, not Stage-0. Existing
// rows already on the source ledger are untouched; the narrowing applies
// only to NEW captures going forward. Stage-0's defense-in-depth rules at
// lib/ingest/stage0/screentime.js still gate anything that slips through
// (e.g. via a replay tool that bypasses the connector).
// Test-only override: MEMORY_SCREENTIME_CAPTURED_STREAMS_OVERRIDE = comma-
// separated stream list replaces the default allowlist. Tests that exercise
// the wide stream set (screentime-connector T6-T8 against /safari/history,
// /search/queryusage, /focus/state; screentime-bigint-overflow against
// /focus/state) set this before importing the module.
const _capturedStreamsOverride =
  typeof process !== "undefined" &&
  typeof process.env?.MEMORY_SCREENTIME_CAPTURED_STREAMS_OVERRIDE === "string" &&
  process.env.MEMORY_SCREENTIME_CAPTURED_STREAMS_OVERRIDE !== ""
    ? process.env.MEMORY_SCREENTIME_CAPTURED_STREAMS_OVERRIDE
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
const CAPTURED_STREAMS = new Set(
  _capturedStreamsOverride !== null
    ? _capturedStreamsOverride
    : ["/app/intents", "/app/usage", "/app/webUsage"]
);

// Mac Absolute Time epoch offset. ZSTARTDATE/ZENDDATE in knowledgeC.db are
// stored as seconds since 2001-01-01T00:00:00Z; add this offset to get a
// real unix epoch. (978307200 == seconds between 1970-01-01 and 2001-01-01.)
//
// R23 audit-bigint-catalog correction: ZSTARTDATE/ZENDDATE on this operator's
// real knowledgeC.db are stored as INTEGER seconds (not REAL as an earlier
// comment claimed). MAX observed ≈ 802,049,782 (well within JS safe-int) so
// SELECTing them as raw INTEGER does NOT throw the node:sqlite BigInt range
// error. Magnitudes encountered in the wild: -63114076800 (≈ year 0 in Mac
// Abs Time, surfaced as a "no start date" sentinel) through ~8.0e8 (now).
const MAC_ABSOLUTE_EPOCH_OFFSET = 978307200;

// JavaScript Date can represent ±100,000,000 days from the epoch. Calling
// `new Date(ms).toISOString()` outside that window throws "Invalid time
// value". Mac Abs Time sentinels like -63114076800 (≈ year 0001-01-01) land
// far outside the representable range; we guard so the whole page does not
// blow up on a single ancient ZOBJECT row. The guard window is generous
// (±50,000,000,000,000 ms ≈ ±1584 years from the unix epoch) — safely
// inside Date's hard limit while excluding every plausibly-real Apple
// timestamp.
const ISO_GUARD_MS = 50_000_000_000_000;

// Page size for the sqlite3 SELECT. The daemon's pollOnce is human-cadence
// (one call per launchd kick, default 30s); 1000 rows per page comfortably
// catches up a multi-day backlog in a handful of iterations while keeping
// per-call latency under a second on a healthy Mac.
const PAGE_SIZE = 1000;

// Default on-disk paths the operator uses in production. Tests override via
// constructor args.
function defaultKnowledgeDbPath() {
  return join(homedir(), "Library", "Application Support", "Knowledge", "knowledgeC.db");
}
function defaultDndAssertionsPath() {
  return join(homedir(), "Library", "DoNotDisturb", "DB", "Assertions.json");
}

// First-party-everywhere classifier per kb/connectors-survey.md § screentime
// — the operator is the sole subject of every ZOBJECT row.
function firstPartyPolicy(/* row */) {
  return { deletion_semantics: "full_excise", consent_basis: "first_party" };
}

// Convert Mac Absolute Time (seconds since 2001-01-01) into an ISO-8601
// string. Returns null when the input is null/undefined/NaN — the upstream
// row carries the source-native field as well, so a null derived field is
// the right shape for downstream consumers.
function macAbsoluteToIso(macAbs) {
  if (macAbs == null) return null;
  // R23: tolerate string-projected INTEGER (defensive against future
  // CAST(... AS TEXT) sites). Number() coerces both number and numeric-
  // string inputs; non-numeric returns NaN below.
  const n = typeof macAbs === "string" ? Number(macAbs) : Number(macAbs);
  if (!Number.isFinite(n)) return null;
  const unixMs = (n + MAC_ABSOLUTE_EPOCH_OFFSET) * 1000;
  // R23 audit-fixture-drift CRIT-D: real ZSTARTDATE values include
  // -63114076800 (≈ year 0 in Mac Abs Time), which when fed into
  // `new Date().toISOString()` throws "Invalid time value" and aborts the
  // whole pollOnce. Guard the window so the connector returns null (the
  // same shape an absent column would produce) instead.
  if (!Number.isFinite(unixMs)) return null;
  if (unixMs < -ISO_GUARD_MS || unixMs > ISO_GUARD_MS) return null;
  try {
    return new Date(unixMs).toISOString();
  } catch {
    return null;
  }
}

// Pick the active Focus/DND mode at the given iso timestamp from the
// Assertions.json record. Returns the ModeIdentifier of the assertion whose
// start is the latest non-future timestamp at iso, or null if none active.
export function pickActiveFocusMode(assertionsJson, isoAtEvent) {
  if (assertionsJson == null || typeof assertionsJson !== "object") return null;
  const eventUnixSec = Date.parse(isoAtEvent) / 1000;
  if (!Number.isFinite(eventUnixSec)) return null;
  let bestIdent = null;
  let bestStart = -Infinity;
  for (const key of Object.keys(assertionsJson)) {
    const entry = assertionsJson[key];
    if (entry == null || typeof entry !== "object") continue;
    if (entry.ModeAssertionEnabled !== true) continue;
    const startMac = Number(entry.AssertionStartDateTimestamp);
    if (!Number.isFinite(startMac)) continue;
    const startUnix = startMac + MAC_ABSOLUTE_EPOCH_OFFSET;
    if (startUnix > eventUnixSec) continue; // assertion is future relative to event
    if (startUnix > bestStart) {
      bestStart = startUnix;
      bestIdent = typeof entry.ModeIdentifier === "string" ? entry.ModeIdentifier : null;
    }
  }
  return bestIdent;
}

// Read Assertions.json into a plain object, or return null on any error.
function safeReadAssertions(path) {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    if (raw === "") return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// =============================================================================
// Per-stream row-builders.
// =============================================================================
//
// Each row-builder takes the joined SQLite row (`r`) plus the page-scope
// `focus_mode` enrichment string and returns a `raw_content` plain object
// matching the spec § 1 per-stream shape. Common fields (`stream`,
// `start_date`, `end_date`, `focus_mode`) are folded in by `buildRowForRow`
// after the per-stream builder runs, so the builder only has to return its
// stream-specific keys.
//
// String fields are returned as null when the source column is NULL — never
// undefined and never coerced to "" — so downstream JSON comparisons stay
// stable across Node versions.
//
// Integer fields that semantically represent booleans (e.g.
// /focus/state.ACTIVE) are coerced via `n === 1` to a strict boolean so
// JSON.stringify emits `true`/`false` not `1`/`0`.

function strOrNull(v) {
  return typeof v === "string" && v !== "" ? v : null;
}
function intOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function boolFromInt(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n === 1;
}

function buildAppUsage(r) {
  // /app/usage — bundle in ZVALUESTRING; duration computed from start/end.
  const startSec = Number(r.ZSTARTDATE);
  const endSec = Number(r.ZENDDATE);
  const duration_sec =
    Number.isFinite(startSec) && Number.isFinite(endSec) && endSec >= startSec
      ? endSec - startSec
      : null;
  return {
    app_bundle_id: strOrNull(r.ZVALUESTRING),
    url: null,
    query: null,
    duration_sec,
  };
}

function buildAppInFocus(r) {
  // /app/inFocus — focused-app slice; bundle in ZVALUESTRING.
  return {
    app_bundle_id: strOrNull(r.ZVALUESTRING),
    url: null,
    query: null,
  };
}

function buildSafariHistory(r) {
  // /safari/history — URL + title from ZSTRUCTUREDMETADATA. ZVALUESTRING is
  // sometimes the URL on older builds; prefer the typed metadata column and
  // fall back to ZVALUESTRING when the metadata is null.
  const metaUrl = strOrNull(r.Z_DKSAFARIHISTORYMETADATAKEY__URL);
  const fallbackUrl = strOrNull(r.ZVALUESTRING);
  return {
    app_bundle_id: null,
    url: metaUrl != null ? metaUrl : fallbackUrl,
    title: strOrNull(r.Z_DKSAFARIHISTORYMETADATAKEY__TITLE),
    query: null,
  };
}

function buildSearchQueryUsage(r) {
  // /search/queryusage — query text from typed metadata column. Older builds
  // store the query in ZVALUESTRING; prefer typed metadata when present and
  // fall back to ZVALUESTRING so we never lose the canonical text.
  const metaQuery = strOrNull(r.Z_DKSEARCHQUERYUSAGEMETADATAKEY__QUERYSTRING);
  const fallbackQuery = strOrNull(r.ZVALUESTRING);
  return {
    app_bundle_id: null,
    url: null,
    query_text: metaQuery != null ? metaQuery : fallbackQuery,
  };
}

function buildFocusState(r) {
  // /focus/state — boolean active + mode identifier. Active is sourced
  // exclusively from the typed metadata column.
  //
  // R23 audit-fixture-drift HIGH-F: 92% of real ZVALUEINTEGER values on this
  // operator's knowledgeC.db are 64-bit hash identifiers (not 0/1 booleans).
  // Now that R23 projects ZVALUEINTEGER as TEXT (CRIT-1 fix), the legacy
  // fallback `boolFromInt(ZVALUEINTEGER)` would yield NaN for every hash and
  // collapse to null anyway; for the rare row where the string parses to a
  // number, the value is overwhelmingly a hash that is NOT 1, so the result
  // would silently be `focus_mode_active=false`. We drop the fallback so the
  // typed column is the sole source of truth — if it is absent, the field is
  // null (which is the right shape for "unknown").
  const active = boolFromInt(r.Z_DKFOCUSSTATEMETADATAKEY__ACTIVE);
  return {
    app_bundle_id: null,
    focus_mode_active: active,
    focus_mode_name: strOrNull(r.Z_DKFOCUSSTATEMETADATAKEY__MODEIDENTIFIER),
  };
}

function buildAppIntents(r) {
  // /app/intents — Messages send intents, calendar intents, etc. Bundle id is
  // in ZVALUESTRING; intent metadata in the typed columns.
  return {
    app_bundle_id: strOrNull(r.ZVALUESTRING),
    intent_class: strOrNull(r.Z_DKINTENTMETADATAKEY__INTENTCLASS),
    intent_verb: strOrNull(r.Z_DKINTENTMETADATAKEY__INTENTVERB),
    direction: intOrNull(r.Z_DKINTENTMETADATAKEY__DIRECTION),
    intent_type: intOrNull(r.Z_DKINTENTMETADATAKEY__INTENTTYPE),
    handling_status: intOrNull(r.Z_DKINTENTMETADATAKEY__INTENTHANDLINGSTATUS),
    interaction_id: strOrNull(r.Z_DKINTENTMETADATAKEY__INTERACTIONIDENTIFIER),
    derived_intent_id: strOrNull(r.Z_DKINTENTMETADATAKEY__DERIVEDINTENTIDENTIFIER),
    related_contact_ids: strOrNull(r.Z_DKINTENTMETADATAKEY__RELATEDCONTACTIDENTIFIERS),
    donated_by_siri: boolFromInt(r.Z_DKINTENTMETADATAKEY__DONATEDBYSIRI),
  };
}

function buildNotificationUsage(r) {
  // /notification/usage — action in ZVALUESTRING ("Receive"/"Engage"), the
  // notifying app bundle + notification identifier in typed metadata.
  return {
    action: strOrNull(r.ZVALUESTRING),
    notifying_bundle_id: strOrNull(r.Z_DKNOTIFICATIONUSAGEMETADATAKEY__BUNDLEID),
    notification_id: strOrNull(r.Z_DKNOTIFICATIONUSAGEMETADATAKEY__IDENTIFIER),
  };
}

function buildAppWebUsage(r) {
  // /app/webUsage — Safari URL + domain + usage type (foreground/background)
  // in typed metadata; the app's bundle id sits in ZVALUESTRING.
  return {
    app_bundle_id: strOrNull(r.ZVALUESTRING),
    web_domain: strOrNull(r.Z_DKDIGITALHEALTHMETADATAKEY__WEBDOMAIN),
    web_url: strOrNull(r.Z_DKDIGITALHEALTHMETADATAKEY__WEBPAGEURL),
    usage_type: intOrNull(r.Z_DKDIGITALHEALTHMETADATAKEY__USAGETYPE),
  };
}

// F-T2-SCREENTIME-F6 — buildDiscoverabilitySignals has been REMOVED from
// the STREAM_DISPATCH table below. Spotlight invocation pings are
// universally noise (5,361 rows = ~28.2% of the screentime ledger on the
// operator's machine) and Stage-0 already DROPs every one. Moving the
// drop into the connector eliminates 5,361 ledger row writes per backfill
// without changing observable semantics: Stage-0's defense-in-depth rule
// at lib/ingest/stage0/screentime.js still DROPs any straggler from a
// non-dispatch path (test fixture, replay tooling) so the row-loss
// contract is unchanged.
//
// W9 STREAM-NARROW: /discoverability/signals is also NOT in
// CAPTURED_STREAMS (defined at the top of this file). That allowlist is
// now the authoritative gate; the STREAM_DISPATCH removal is the
// belt-and-suspenders second layer. Even if someone re-adds the
// dispatch entry below without thinking, CAPTURED_STREAMS will still
// drop the row before any builder runs. The SQL query intentionally does
// NOT filter ZSTREAMNAME — the cursor still needs to advance past every
// row, and filtering in JS keeps "what streams matter" in one place.
//
// To re-enable (e.g. for spotlight-usage research), restore the original
// row-builder, re-add the "/discoverability/signals" entry to
// STREAM_DISPATCH, AND add the same string to CAPTURED_STREAMS. Reference
// shape of the dropped row-builder:
//
//   function buildDiscoverabilitySignals(r) {
//     return {
//       signal: strOrNull(r.ZVALUESTRING),
//       os_build: strOrNull(r.Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__OSBUILD),
//     };
//   }
//
// pollOnce's unknown-stream silent-skip (lib/connectors/screentime.js
// pollOnce → "Unrecognized stream: SKIP SILENTLY") absorbs the deleted
// stream now that it is not in STREAM_DISPATCH.

function buildAppMediaUsage(r) {
  // /app/mediaUsage — media playback intervals. Bundle in ZVALUESTRING; URL
  // columns are typically null on this operator but included for portability
  // (some streams populate them on other machines / iOS-synced data).
  return {
    app_bundle_id: strOrNull(r.ZVALUESTRING),
    media_url: strOrNull(r.Z_DKAPPMEDIAUSAGEMETADATAKEY__MEDIAURL),
    app_url: strOrNull(r.Z_DKAPPMEDIAUSAGEMETADATAKEY__URL),
  };
}

// Dispatch table — keyed by ZSTREAMNAME. Each value is the row-builder
// function. Streams NOT in this table are skipped silently (no error, no
// ledger row); the cursor still advances past them so subsequent polls do
// not re-scan. This is the spec § 1 "Rows where the stream is not in the
// configured set MUST be skipped silently" discipline.
const STREAM_DISPATCH = Object.freeze({
  "/app/usage": buildAppUsage,
  "/app/inFocus": buildAppInFocus,
  "/safari/history": buildSafariHistory,
  "/search/queryusage": buildSearchQueryUsage,
  "/focus/state": buildFocusState,
  "/app/intents": buildAppIntents,
  "/notification/usage": buildNotificationUsage,
  "/app/webUsage": buildAppWebUsage,
  // F-T2-SCREENTIME-F6 — "/discoverability/signals" intentionally REMOVED
  // from this dispatch table. The unrecognized-stream silent-skip in
  // pollOnce absorbs the stream and the cursor still advances past every
  // row so the next poll does not re-scan. Saves ~28.2% of ledger writes
  // per backfill. See the buildDiscoverabilitySignals removal comment
  // above for re-enable instructions.
  "/app/mediaUsage": buildAppMediaUsage,
});

// The full set of metadata columns the JOIN'd SELECT projects. Keeping the
// list in one place lets the SELECT and the row-builders stay in lock-step.
// Real-DB columns that the fixture omits will SELECT as NULL — `strOrNull` +
// `intOrNull` collapse those to null gracefully. Fixture-only or test-only
// columns are tolerated the same way.
const METADATA_COLUMNS = [
  "Z_DKSAFARIHISTORYMETADATAKEY__URL",
  "Z_DKSAFARIHISTORYMETADATAKEY__TITLE",
  "Z_DKSEARCHQUERYUSAGEMETADATAKEY__QUERYSTRING",
  "Z_DKFOCUSSTATEMETADATAKEY__ACTIVE",
  "Z_DKFOCUSSTATEMETADATAKEY__MODEIDENTIFIER",
  "Z_DKINTENTMETADATAKEY__INTENTCLASS",
  "Z_DKINTENTMETADATAKEY__INTENTVERB",
  "Z_DKINTENTMETADATAKEY__DIRECTION",
  "Z_DKINTENTMETADATAKEY__INTENTTYPE",
  "Z_DKINTENTMETADATAKEY__INTENTHANDLINGSTATUS",
  "Z_DKINTENTMETADATAKEY__INTERACTIONIDENTIFIER",
  "Z_DKINTENTMETADATAKEY__DERIVEDINTENTIDENTIFIER",
  "Z_DKINTENTMETADATAKEY__RELATEDCONTACTIDENTIFIERS",
  "Z_DKINTENTMETADATAKEY__DONATEDBYSIRI",
  "Z_DKNOTIFICATIONUSAGEMETADATAKEY__BUNDLEID",
  "Z_DKNOTIFICATIONUSAGEMETADATAKEY__IDENTIFIER",
  "Z_DKAPPMEDIAUSAGEMETADATAKEY__MEDIAURL",
  "Z_DKAPPMEDIAUSAGEMETADATAKEY__URL",
  "Z_DKDIGITALHEALTHMETADATAKEY__WEBDOMAIN",
  "Z_DKDIGITALHEALTHMETADATAKEY__WEBPAGEURL",
  "Z_DKDIGITALHEALTHMETADATAKEY__USAGETYPE",
  "Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__OSBUILD",
];

// =============================================================================
// F-CCS-CONNECTOR-screentime-structural — buildStructuredFeatures (per-row)
// =============================================================================
//
// The salience cascade currently re-derives entities and time anchors from
// raw text every time it promotes a fact. The connector ALREADY KNOWS — at
// emit time — what app the row references (raw_content.app_bundle_id),
// what URL the operator visited (raw_content.web_url), and (for
// INSendMessageIntent rows) who the operator sent a message to
// (raw_content.related_contact_ids / derived_intent_id). The
// structured_features payload pins all three so the cascade does not have to
// re-derive them.
//
// W9 NOTE: screentime is in captured_only mode today (the cascade is
// SKIPPED for this source per F-CCS-CASCADE-source-policy-captured-only) —
// but structured_features is still useful for the captured ledger as a
// record + future cascade-on switch. Emitting it now means a future
// "captured_only → captured_and_cascaded" policy flip ships with no
// connector edits.
//
// Per-stream mapping (from the workunit predicate):
//   /app/intents:
//     contact_handle → person  (INSendMessageIntent only; extracted from
//                               related_contact_ids first, then the
//                               derived_intent_id "notificationThreadIdentifier(...)" form)
//     app_bundle     → artifact
//   /app/usage:
//     app_bundle     → artifact
//   /app/webUsage:
//     web_url        → artifact
//     web_domain     → artifact (when distinct from web_url's slug)
//     app_bundle     → artifact (Safari etc.)
//
// time_anchors[]: one absolute anchor from raw_content.start_date when
// present (ISO-8601 string emitted by macAbsoluteToIso).
//
// Shape pinned by mcp/docs/specs/ccs/structured-features-schema.md §3.1 +
// worked example §5.1. CAPS frozen at module scope per W2-W12 discipline.

/** Frozen schema discriminator for the v0 ship of structured_features. */
export const STRUCTURED_FEATURES_SCHEMA_VERSION = "v1";

/**
 * Frozen emitter version stamped on every structured_features payload
 * produced by this module. Matches the time-anchor-schema §8 I8 regex
 * `/^[a-z0-9_\-]+@[0-9]+\.[0-9]+\.[0-9]+(\+[a-z0-9_\-]+)*$/`.
 */
export const STRUCTURED_FEATURES_EMITTER_VERSION = "screentime-structural@1.0.0";

/**
 * The entity-schema source_scope this connector stamps. Matches
 * ENTITY_SOURCE_SCOPES from lib/synthesis/entity-extractor.js (the closed
 * 6-source enum). Stamping a non-enum source_scope would make the
 * canonical_id drift from the cascade text-extractor path and break the
 * union-by-canonical-id merge invariant.
 */
export const STRUCTURED_FEATURES_SOURCE_SCOPE = "screentime";

/**
 * Per-row evidence kind. Connector-emit allowlist is {handle, structural,
 * kb_lookup} per foundation spec §3.2; screentime's contact_handle is a
 * `handle` (opaque identifier the OS hands us, not a verified human-typed
 * surface) — `structural` is reserved for fields whose semantic meaning is
 * fixed by the source schema. We stamp `structural` for app_bundle / url
 * (the source schema fixes their meaning) and `handle` for the contact
 * surface from INSendMessageIntent (which IS an opaque routing identifier).
 */
const STRUCTURED_EVIDENCE_STRUCTURAL = "structural";
const STRUCTURED_EVIDENCE_HANDLE = "handle";

// Module-VERSION export for the WU engineering discipline ("Module exports
// VERSION + frozen CAPS"). Bumped when the structured-features emission
// logic changes (NOT when the SQLite query / row-builder shape changes —
// those do not affect the pinned canonical_id discipline).
export const VERSION = STRUCTURED_FEATURES_EMITTER_VERSION;

// Frozen CAPS bag for the WU discipline + test introspection.
export const CAPS = Object.freeze({
  SCHEMA_VERSION: STRUCTURED_FEATURES_SCHEMA_VERSION,
  EMITTER_VERSION: STRUCTURED_FEATURES_EMITTER_VERSION,
  SOURCE_SCOPE: STRUCTURED_FEATURES_SOURCE_SCOPE,
});

/**
 * _structuralEntity: build one Entity (entity-schema §4 shape) from a raw
 * surface. Returns null when slugification fails (defensive degradation —
 * the cascade still has the text-extractor path for that surface).
 *
 * Pure function. No I/O.
 */
function _structuralEntity(kind, surface, evidence) {
  if (typeof surface !== "string" || surface === "") return null;
  let slug;
  try {
    slug = entitySlugify(surface);
  } catch {
    return null;
  }
  if (slug === SLUG_EMPTY_SENTINEL) return null;
  if (!ENTITY_SLUG_REGEX.test(slug)) return null;
  return {
    kind,
    canonical_id: `${kind}:${STRUCTURED_FEATURES_SOURCE_SCOPE}:${slug}`,
    surface,
    source_scope: STRUCTURED_FEATURES_SOURCE_SCOPE,
    evidence,
    confidence: 1.0,
    extractor_version: STRUCTURED_FEATURES_EMITTER_VERSION,
  };
}

/**
 * _extractContactHandle: pull a contact surface out of the
 * INSendMessageIntent metadata. Preference order:
 *   1. related_contact_ids — typically "<UUID>:ABPerson" (Address Book ref).
 *      The UUID is the stable handle; the suffix is type metadata.
 *   2. derived_intent_id — typically "notificationThreadIdentifier(<URL-encoded handle>)"
 *      or "conversationIdentifier(<numeric id>)". We URL-decode the inner
 *      argument so `%2B15555550142` becomes `+15555550142` and slugifies
 *      to `15555550142`.
 *
 * Returns the extracted surface or null. We DO NOT include
 * "conversationIdentifier" payloads — those are opaque numeric thread
 * ids, not contact handles, and slugifying them would mint a "person"
 * entity from a thread id (FM-1 hazard).
 *
 * Pure function.
 */
function _extractContactHandle(rawContent) {
  const related =
    typeof rawContent.related_contact_ids === "string"
      ? rawContent.related_contact_ids
      : "";
  if (related !== "") {
    // Strip the trailing `:ABPerson` (or any other type-tag suffix).
    const colonIdx = related.indexOf(":");
    const handle = colonIdx >= 0 ? related.slice(0, colonIdx) : related;
    if (handle.length > 0) return handle;
  }
  const derived =
    typeof rawContent.derived_intent_id === "string"
      ? rawContent.derived_intent_id
      : "";
  if (derived !== "") {
    // notificationThreadIdentifier(<URL-encoded>) → decoded inner.
    const m = derived.match(/^notificationThreadIdentifier\((.+)\)$/);
    if (m) {
      let inner;
      try {
        inner = decodeURIComponent(m[1]);
      } catch {
        inner = m[1];
      }
      if (typeof inner === "string" && inner.length > 0) return inner;
    }
    // conversationIdentifier(<numeric>) — INTENTIONALLY NOT EXTRACTED.
    // Numeric thread ids are not contact handles; slugifying them would
    // mint a bogus person entity.
  }
  return null;
}

/**
 * buildStructuredFeatures: derive the structured_features payload for a
 * single screentime row from its raw_content. Returns the payload object
 * on success OR null when the raw_content is too malformed to extract
 * anything structurally (defensive degradation per the brutalist hot-path
 * discipline — the connector emits the row WITHOUT structured_features
 * and the cascade falls back to the text-extractor path, which is the
 * explicit backwards-compat invariant from foundation spec §7).
 *
 * Inputs we read from raw_content (per-stream):
 *   /app/intents (INSendMessageIntent):
 *     related_contact_ids / derived_intent_id → person (handle evidence)
 *     app_bundle_id                           → artifact (structural)
 *   /app/usage:
 *     app_bundle_id                           → artifact (structural)
 *   /app/webUsage:
 *     web_url                                 → artifact (structural)
 *     web_domain                              → artifact (structural)
 *     app_bundle_id                           → artifact (structural)
 *
 * Time anchor: start_date (ISO-8601 from macAbsoluteToIso) → absolute.
 *
 * Failure modes that route to null (NOT throw):
 *   - rawContent is null / not a plain object / array
 *   - stream is missing or not in the per-stream switch
 *   - every structural field failed to slugify
 */
export function buildStructuredFeatures(rawContent) {
  if (rawContent == null || typeof rawContent !== "object" || Array.isArray(rawContent)) {
    return null;
  }

  const stream = typeof rawContent.stream === "string" ? rawContent.stream : "";
  if (stream === "") return null;

  const entities = [];

  switch (stream) {
    case "/app/intents": {
      // app_bundle → artifact. Always emit if present (regardless of
      // intent_class) — the bundle is meaningful for any intent.
      const bundleEntity = _structuralEntity(
        "artifact",
        rawContent.app_bundle_id,
        STRUCTURED_EVIDENCE_STRUCTURAL,
      );
      if (bundleEntity) entities.push(bundleEntity);

      // contact_handle → person (INSendMessageIntent only). Gated on
      // intent_class so we don't mint a person entity from a
      // INStartCallIntent's "phone number" handle (different semantic
      // shape; the workunit predicate scopes to INSendMessageIntent).
      const intentClass =
        typeof rawContent.intent_class === "string"
          ? rawContent.intent_class
          : "";
      if (intentClass === "INSendMessageIntent") {
        const contactSurface = _extractContactHandle(rawContent);
        if (contactSurface !== null) {
          const personEntity = _structuralEntity(
            "person",
            contactSurface,
            STRUCTURED_EVIDENCE_HANDLE,
          );
          if (personEntity) entities.push(personEntity);
        }
      }
      break;
    }
    case "/app/usage": {
      // app_bundle → artifact. The whole row is "operator used app X for
      // N seconds"; the bundle IS the structural payload.
      const bundleEntity = _structuralEntity(
        "artifact",
        rawContent.app_bundle_id,
        STRUCTURED_EVIDENCE_STRUCTURAL,
      );
      if (bundleEntity) entities.push(bundleEntity);
      break;
    }
    case "/app/webUsage": {
      // web_url → artifact. The URL is the load-bearing surface; the
      // cascade dedupes by canonical_id so the same URL across multiple
      // visits collapses to one entity (intentional — we want recall
      // by URL, not by visit-event).
      const urlEntity = _structuralEntity(
        "artifact",
        rawContent.web_url,
        STRUCTURED_EVIDENCE_STRUCTURAL,
      );
      if (urlEntity) entities.push(urlEntity);
      // web_domain → artifact. Distinct from web_url because the slug
      // pipeline collapses `https://www.google.com/search?q=...` and
      // `https://www.google.com/maps` to different slugs but their
      // domain is shared. The merger dedupes by canonical_id so if
      // domain happens to collide with url's slug (extremely unlikely
      // after the 64-char truncation), we'd emit one entity not two.
      const domainEntity = _structuralEntity(
        "artifact",
        rawContent.web_domain,
        STRUCTURED_EVIDENCE_STRUCTURAL,
      );
      if (domainEntity) {
        // Skip if it duplicates the URL entity's canonical_id (rare).
        const dupe = entities.some(
          (e) => e.canonical_id === domainEntity.canonical_id,
        );
        if (!dupe) entities.push(domainEntity);
      }
      // app_bundle → artifact. Safari's bundle id; useful for
      // cross-source corroboration with /app/usage rows for the same
      // bundle (the cascade can compute "URL X was visited while Safari
      // was foregrounded" by canonical_id intersection).
      const bundleEntity = _structuralEntity(
        "artifact",
        rawContent.app_bundle_id,
        STRUCTURED_EVIDENCE_STRUCTURAL,
      );
      if (bundleEntity) {
        const dupe = entities.some(
          (e) => e.canonical_id === bundleEntity.canonical_id,
        );
        if (!dupe) entities.push(bundleEntity);
      }
      break;
    }
    default: {
      // Stream not in the per-stream mapping. Return null so the row
      // emits without structured_features (cascade falls back to the
      // text-extractor path, which is the explicit backwards-compat
      // invariant). The captured_only mode (W9) means cascade is
      // skipped today anyway, but we keep the discipline intact for
      // the future cascade-on switch.
      return null;
    }
  }

  // Absolute time anchor from start_date. macAbsoluteToIso already
  // UTC-normalized the value so parsed.iso is byte-stable across TZ
  // offsets. raw_phrase preserves the same string verbatim (the source-
  // native form is also already UTC-Z; no original-TZ form to preserve).
  const timeAnchors = [];
  const startDate = rawContent.start_date;
  if (typeof startDate === "string" && startDate !== "") {
    const parsedMs = Date.parse(startDate);
    if (Number.isFinite(parsedMs)) {
      let iso;
      try {
        iso = new Date(parsedMs).toISOString();
      } catch {
        iso = null;
      }
      if (typeof iso === "string" && iso !== "") {
        timeAnchors.push({
          kind: "absolute",
          raw_phrase: startDate,
          parsed: { iso },
          extractor_confidence: 1.0,
          extractor_version: STRUCTURED_FEATURES_EMITTER_VERSION,
          // structural=true pins this anchor as coming from a typed
          // field (start_date), so the merger's tie-break logic prefers
          // it over text-extracted anchors of the same (kind, iso).
          structural: true,
        });
      }
    }
  }

  // parties[] is the canonicalized projection of row.parties[] — keyed
  // by person canonical_id. screentime rows have parties=["user"]; the
  // user is not a structurally-known person (we don't have an email
  // surface in the source schema), so this is empty unless the
  // contact_handle from INSendMessageIntent produced a person entity.
  const parties = [];
  for (const e of entities) {
    if (e.kind === "person") parties.push(e.canonical_id);
  }

  // If we found NOTHING structural at all, return null so the row emits
  // without structured_features (backwards-compat path).
  if (entities.length === 0 && timeAnchors.length === 0 && parties.length === 0) {
    return null;
  }

  // Sort entities by canonical_id (foundation spec §3.1 — array MUST be
  // sorted ascending for byte-stable merge / dedupe).
  entities.sort((a, b) =>
    a.canonical_id < b.canonical_id ? -1 : a.canonical_id > b.canonical_id ? 1 : 0,
  );

  return {
    schema_version: STRUCTURED_FEATURES_SCHEMA_VERSION,
    emitter_version: STRUCTURED_FEATURES_EMITTER_VERSION,
    entities,
    time_anchors: timeAnchors,
    parties,
  };
}

// Query a single page of joined ZOBJECT + ZSTRUCTUREDMETADATA rows above the
// cursor via node:sqlite. Returns an array of plain-object rows. We do NOT
// filter ZSTREAMNAME in SQL — every row is fetched and the dispatch table
// decides whether to emit a ledger row, skip silently, or recognize a new
// stream. Filtering in SQL would force a roundtrip every time we wanted to
// support a new stream; doing it in JS keeps the connector code the single
// place that owns "what streams matter".
//
// We open the DB read-only and close it at the end of every page; node:sqlite
// does not pool. Read-only is important: even pointing the connector at an
// active CoreDuet DB never takes a write lock that could throttle Spotlight /
// Knowledge.
//
// Production knowledgeC.db DOES NOT have a foreign-key constraint on
// ZOBJECT.ZSTRUCTUREDMETADATA; some rows reference a Z_PK that does not
// exist in ZSTRUCTUREDMETADATA, and rows whose stream carries no typed
// metadata sit at ZSTRUCTUREDMETADATA=NULL. LEFT JOIN handles both: missing
// metadata rows surface every metadata column as NULL.
//
// The metadata column projection is built from METADATA_COLUMNS via wrapping
// each as `IFNULL(m.<col>, NULL) AS <col>`. Real knowledgeC.db carries all
// the columns; the test fixture carries only the subset its row-builders
// touch. We tolerate "column not found" via a fallback path that builds a
// minimal projection list intersected with the table's actual columns.
function queryZobjectPage(dbPath, lastZPk) {
  const cursor = Number.isInteger(lastZPk) ? lastZPk : 0;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // Determine which metadata columns actually exist on this DB; SELECTing a
    // missing column raises a sqlite error and the connector would tag every
    // poll as failed. The fixture only models a subset; production has them
    // all. PRAGMA table_info is the canonical introspection.
    let metaCols;
    try {
      const tableInfo = db.prepare("PRAGMA table_info(ZSTRUCTUREDMETADATA);").all();
      const present = new Set(tableInfo.map((r) => r.name));
      metaCols = METADATA_COLUMNS.filter((c) => present.has(c));
    } catch {
      metaCols = [];
    }
    // R23 audit-bigint-catalog: any INTEGER column whose semantics could be
    // a 64-bit hash / ns-epoch / arbitrary 64-bit value MUST be projected as
    // CAST(... AS TEXT) — otherwise node:sqlite throws "Value is too large
    // to be represented as a JavaScript number" on stmt.all() and aborts
    // the entire page.
    //
    // BIGINT_UNSAFE_COLUMNS: per Phase A2 catalog, the only column on
    // knowledgeC.db that empirically exceeds Number.MAX_SAFE_INTEGER on this
    // operator is ZOBJECT.ZVALUEINTEGER (MAX = 8,999,410,902,659,233,531;
    // MIN = -8,681,985,191,315,746,555; 16,924 / 18,361 rows overflow).
    // Z_PK is safe at this scale (MAX = 896,468); ZSTARTDATE/ZENDDATE are
    // safe INTEGER seconds (MAX ≈ 802,049,782).
    const BIGINT_UNSAFE_COLUMNS = new Set(["ZVALUEINTEGER"]);
    const metaProjection = metaCols
      .map((c) => `m.${c} AS ${c}`)
      .join(", ");
    // ZVALUEINTEGER may or may not exist depending on test fixture; include
    // a graceful fallback. Production always has it.
    let zoCols = ["Z_PK", "ZSTREAMNAME", "ZSTARTDATE", "ZENDDATE", "ZVALUESTRING"];
    try {
      const tableInfo = db.prepare("PRAGMA table_info(ZOBJECT);").all();
      const present = new Set(tableInfo.map((r) => r.name));
      if (present.has("ZVALUEINTEGER")) zoCols.push("ZVALUEINTEGER");
    } catch {
      // ignore — defaults above are safe
    }
    const zoProjection = zoCols
      .map((c) =>
        BIGINT_UNSAFE_COLUMNS.has(c)
          ? `CAST(o.${c} AS TEXT) AS ${c}`
          : `o.${c} AS ${c}`,
      )
      .join(", ");
    const sql =
      `SELECT ${zoProjection}` +
      (metaProjection ? `, ${metaProjection}` : "") +
      " FROM ZOBJECT o" +
      " LEFT JOIN ZSTRUCTUREDMETADATA m ON m.Z_PK = o.ZSTRUCTUREDMETADATA" +
      " WHERE o.Z_PK > ? ORDER BY o.Z_PK ASC LIMIT " +
      String(PAGE_SIZE) +
      ";";
    const stmt = db.prepare(sql);
    const rows = stmt.all(cursor);
    return Array.isArray(rows) ? rows : [];
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// =============================================================================
// ScreenTimeConnector — daemon entry point.
// =============================================================================

export class ScreenTimeConnector extends ConnectorBase {
  constructor({ knowledgeDbPath, dndAssertionsPath, sourceLedgerPath, cursorPath } = {}) {
    super({
      source: "screentime",
      sourceLedgerPath,
      cursorPath,
      sourcePolicyForRow: firstPartyPolicy,
    });
    this.knowledgeDbPath = knowledgeDbPath || defaultKnowledgeDbPath();
    this.dndAssertionsPath = dndAssertionsPath || defaultDndAssertionsPath();
  }

  // pollOnce — single page of work.
  //
  // opts.now is an override-for-test injection so the tests can assert
  // deterministic timestamps; production callers omit it and the base
  // class's serverTs() chains take over.
  //
  // Returns {appended, errors}:
  //   appended — number of newly-appended ledger rows in this call
  //   errors   — array of {kind, detail} describing per-row failures.
  //              UNRECOGNIZED-STREAM rows are NOT errors — they are skipped
  //              silently and the cursor still advances past them.
  async pollOnce(opts = {}) {
    if (!existsSync(this.knowledgeDbPath)) {
      await this.tagError("knowledgeC_missing");
      const prev = (await this.readCursor()) || {};
      await this.writeCursor({ ...prev, status: "failed" });
      return { appended: 0, errors: [{ kind: "knowledgeC_missing", detail: this.knowledgeDbPath }] };
    }

    const cursorState = (await this.readCursor()) || {};
    const lastZPk = Number.isInteger(cursorState.last_z_pk) ? cursorState.last_z_pk : 0;

    let rows;
    try {
      rows = queryZobjectPage(this.knowledgeDbPath, lastZPk);
    } catch (err) {
      await this.tagError("sqlite_query_failed");
      return { appended: 0, errors: [{ kind: "sqlite_query_failed", detail: String(err && err.message || err) }] };
    }

    if (rows.length === 0) {
      // c3-cursor-stamp-class fix (ports telegram.js:255-264): this branch is
      // entered ONLY when the page came back empty (`rows.length === 0` on the
      // line above), so no row was read and last_z_pk provably did not move —
      // it can never represent a cursor advance. Carry the prior stamp forward
      // instead of restamping now(). The prior `typeof opts.now === "string" ?
      // opts.now : serverTs()` was a ternary between two now()-flavoured
      // values, i.e. an unconditional stamp wearing a conditional's clothes; it
      // refreshed the timestamp forever and defeated the staleness classifiers
      // (index.js _healthFromState :601,607-611 / metadataFromState
      // :701,707-711 compare this field against CAPS.CONNECTOR_HEALTH_STALE_SECONDS).
      //
      // The writeCursor call itself is DELIBERATELY kept even though the
      // resulting bytes are now identical on a quiet poll: listInstalledConnectors
      // (index.js:673-674) enumerates a connector only when its state.json
      // exists, so dropping the write would make a cold-start screentime vanish
      // from memory_connectors_list.
      await this.writeCursor({
        ...cursorState,
        last_z_pk: lastZPk,
        last_cursor_advance_ts:
          typeof cursorState.last_cursor_advance_ts === "string" ? cursorState.last_cursor_advance_ts : null,
      });
      return { appended: 0, errors: [] };
    }

    // Fold Focus assertions once per page — the file rarely changes mid-poll
    // and reading it per-row would be O(N) IO for no signal.
    const assertions = safeReadAssertions(this.dndAssertionsPath);

    const errors = [];
    let appendedCount = 0;
    let highestPk = lastZPk;
    let lastTs = cursorState.last_appended_ts || null;
    let lastId = cursorState.last_appended_id || null;
    // W9 stream-narrow observability — per-stream count of rows the
    // CAPTURED_STREAMS allowlist dropped on this page. Folded into the
    // cursor state at the end so the operator can `jq` the cursor for a
    // running tally without having to add a separate metrics file.
    const filteredAtConnector = Object.create(null);

    for (const r of rows) {
      const pk = Number(r.Z_PK);
      if (!Number.isFinite(pk)) {
        errors.push({ kind: "malformed_row", detail: "Z_PK not a number" });
        continue;
      }
      // Always advance the cursor past this row, even if we skip it (silent
      // skip on unrecognized stream, error skip on builder failure). The
      // alternative — leaving highestPk behind — would force the next poll
      // to re-scan the same rows forever.
      highestPk = Math.max(highestPk, pk);

      const stream = typeof r.ZSTREAMNAME === "string" ? r.ZSTREAMNAME : null;
      // W9 CAPTURED_STREAMS gate — runs BEFORE the dispatch lookup so a
      // dropped stream never builds a row, never touches Focus enrichment,
      // and never reaches appendLedgerRow. This is the connector-layer
      // filter described at the top of the file. The cursor was already
      // advanced above so the row will not be re-scanned next poll.
      if (stream != null && !CAPTURED_STREAMS.has(stream)) {
        filteredAtConnector[stream] = (filteredAtConnector[stream] || 0) + 1;
        continue;
      }
      const builder = stream != null ? STREAM_DISPATCH[stream] : null;
      if (builder == null) {
        // Unrecognized stream: SKIP SILENTLY (no error_count increment).
        // The cursor was already advanced above; this row will not be
        // re-scanned on the next poll. (A stream listed in CAPTURED_STREAMS
        // but missing from STREAM_DISPATCH lands here too — a noisy config
        // error, but still safer to silent-skip than to crash the page.)
        continue;
      }

      const startIso = macAbsoluteToIso(r.ZSTARTDATE);
      const endIso = macAbsoluteToIso(r.ZENDDATE);
      const focusAt = startIso || (typeof opts.now === "string" ? opts.now : serverTs());
      const focus_mode = pickActiveFocusMode(assertions, focusAt);

      let streamSpecific;
      try {
        streamSpecific = builder(r);
      } catch (err) {
        // A per-stream builder threw — log and skip. The cursor still
        // advances so we don't reflow the same broken row.
        errors.push({
          kind: "screentime_row_builder_failed",
          detail: `${stream}: ${String(err && err.message || err)}`,
        });
        await this.tagError("screentime_row_builder_failed");
        continue;
      }

      const raw_content = {
        stream,
        start_date: startIso,
        end_date: endIso,
        focus_mode,
        ...streamSpecific,
      };

      const row = {
        source_msg_id: "screentime:" + String(pk),
        parties: ["user"],
        raw_content,
      };

      // F-CCS-CONNECTOR-screentime-structural — attach connector-known
      // surfaces (app_bundle / url / contact_handle) as
      // structured_features so the merger does not have to re-derive
      // them from raw_content. captured_only mode (W9) means the
      // cascade is skipped for screentime today; the structured payload
      // sits on the captured ledger as a record + future cascade-on
      // switch flips it on with zero connector edits. Defensive
      // try/catch so a malformed row never blocks emit.
      let structuredFeatures;
      try {
        structuredFeatures = buildStructuredFeatures(raw_content);
      } catch (err) {
        // Should never happen — buildStructuredFeatures is defensive
        // everywhere — but the hot path absolutely cannot throw.
        structuredFeatures = undefined;
        try {
          errors.push({
            kind: "structured_features_build_failed",
            detail: String(err && err.message || err),
          });
        } catch { /* ignore push failures */ }
      }
      if (structuredFeatures != null) {
        row.structured_features = structuredFeatures;
      }

      try {
        const res = await this.appendLedgerRow(row);
        if (res.appended) {
          appendedCount += 1;
          lastId = res.id;
        }
        lastTs = typeof opts.now === "string" ? opts.now : serverTs();
      } catch (err) {
        errors.push({ kind: "append_failed", detail: String(err && err.message || err) });
      }
    }

    // Cursor advance — write once at end of page, after every row is
    // durably on the ledger. A crash between row N and row N+1 just means
    // the next pollOnce re-scans the page; appendLedgerRow's bounded
    // dedupe absorbs the replay.
    //
    // W9 stream-narrow: roll the per-page filteredAtConnector totals into a
    // monotonic counter on the cursor so the operator can see how much
    // noise the allowlist is excluding without standing up a metrics
    // pipeline. Object.create(null) on both sides keeps prototype keys out.
    const prevFiltered =
      (cursorState && typeof cursorState.filtered_at_connector === "object" && cursorState.filtered_at_connector !== null)
        ? cursorState.filtered_at_connector
        : {};
    const mergedFiltered = { ...prevFiltered };
    for (const k of Object.keys(filteredAtConnector)) {
      mergedFiltered[k] = (Number(mergedFiltered[k]) || 0) + filteredAtConnector[k];
    }
    const nowTs = typeof opts.now === "string" ? opts.now : serverTs();
    // c3-cursor-stamp-class fix (ports telegram.js:255-264): stamp an advance
    // ONLY when the page actually moved the cursor. `lastZPk` is the watermark
    // read at the top of pollOnce; `highestPk` starts there and is raised per
    // row, then written as last_z_pk just below — so `highestPk > lastZPk` is
    // exactly "the cursor moved". Skipping past an unrecognized / filtered row
    // counts as a genuine advance by design (highestPk is raised BEFORE the
    // stream allowlist and dispatch gates, precisely so a 827-rows/day noise
    // stream is not re-scanned forever); the rationale is recorded at
    // mcp/test/screentime-connector.test.mjs:346-349, and it mirrors telegram's
    // "append OR skip-past progress".
    const cursorAdvanced = highestPk > lastZPk;
    const carriedAdvanceTs =
      typeof cursorState.last_cursor_advance_ts === "string" ? cursorState.last_cursor_advance_ts : null;
    await this.writeCursor({
      ...cursorState,
      last_z_pk: highestPk,
      last_appended_ts: lastTs,
      last_appended_id: lastId,
      last_cursor_advance_ts: cursorAdvanced ? nowTs : carriedAdvanceTs,
      filtered_at_connector: mergedFiltered,
      // If the previous run marked status=failed (e.g. missing DB) but we
      // are now succeeding, clear the marker.
      status: cursorState.status === "failed" ? undefined : cursorState.status,
    });

    return { appended: appendedCount, errors };
  }

  async runOnce(opts = {}) {
    return this.pollOnce(opts);
  }

  async runForever({ signal, intervalMs = 30000 } = {}) {
    while (signal == null || !signal.aborted) {
      try {
        await this.pollOnce();
      } catch (err) {
        await this.tagError(String(err && err.code || "loop_unhandled"));
      }
      if (signal != null && signal.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

// =============================================================================
// CLI shim — `node screentime.js --check | --once | --forever`
// =============================================================================

async function cliMain(argv) {
  const args = new Set(argv.slice(2));
  const c = new ScreenTimeConnector({});
  if (args.has("--check")) {
    const h = c.reportHealth();
    process.stdout.write(JSON.stringify(h) + "\n");
    return 0;
  }
  if (args.has("--once")) {
    const out = await c.runOnce();
    process.stdout.write(JSON.stringify(out) + "\n");
    return 0;
  }
  if (args.has("--forever")) {
    await c.runForever({});
    return 0;
  }
  process.stderr.write("usage: screentime.js [--check|--once|--forever]\n");
  return 2;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  cliMain(process.argv).then(
    (code) => process.exit(code || 0),
    (err) => {
      process.stderr.write(String(err && err.stack || err) + "\n");
      process.exit(1);
    },
  );
}
