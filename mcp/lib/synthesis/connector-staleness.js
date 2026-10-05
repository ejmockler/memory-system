// connector-staleness.js — c2 (task-hypergraph) SOURCE CAPTURE-liveness detector.
//
// THE GAP THIS CLOSES. memory_health could not tell the operator that a data
// source had STOPPED PRODUCING. Measured on the live tree 2026-08-11:
// `github-events` had appended no row in 88.6 hours and `mail` none in 54.6
// hours, while every health surface read clean. This module answers exactly
// one question — "when did this source last capture anything?" — from the only
// two pieces of honest evidence on disk:
//
//   1. connectors/<source>/state.json .last_appended_ts  (tiny file, read)
//   2. statSync(storage/sources/<source>.jsonl).mtimeMs  (STAT ONLY, never read)
//
// Liveness is max(those two, whichever exist); a source is `stale` when that
// age exceeds its per-source threshold (CAPS.SOURCE_CAPTURE_STALE_*).
//
// ---------------------------------------------------------------------------
// REJECTED SIGNALS — recorded beside the code, as this tree does.
// ---------------------------------------------------------------------------
//
// REJECTED (a): storage/watermark-state/<source>.json — the CASCADE cursor,
// and the basis of the W7 cursor-lag alarm (daemons/watermark.js
// computeCursorLagSnapshot, surfaced in lib/tools/health.js). It measures
// cascade BACKLOG: tail-row-ts minus cursor-ts. When a source stops entirely
// the cursor catches up and the lag COLLAPSES TO ZERO, so a dead source and a
// healthy one read identically — live proof 2026-08-11: github-events, silent
// 88.6h, reported lag_h=0.0, byte-identical to chat-claude-code which had
// appended seconds earlier. Worse, keying on that cursor false-fires forever on
// `screentime`: it is listed in CAPS.WATERMARK_CAPTURED_ONLY_SOURCES
// (lib/validation.js:556-564, rationale at :545-550) by a deliberate Wave-9
// decision, so its cursor has been frozen at 2026-06-01 since 2026-06-21 ON
// PURPOSE while its connector captures normally (screentime.jsonl was
// 26,719,535 bytes with a tail row minutes old). This module therefore never
// touches watermark-state/ at all — mechanically pinned by T9 in
// test/connector-staleness.test.mjs.
//
// REJECTED (b): connectors/<source>/state.json .last_cursor_advance_ts — the
// field lib/connectors/index.js:707-711 (metadataFromState) uses for
// status:"stale". It is stamped UNCONDITIONALLY on every poll by four
// connectors (screentime.js:1180, slack.js:551, codex-cli.js:1361,
// git-log-local.js:2001), so it refreshes forever whether or not anything was
// captured. The identical bug was found and fixed for telegram ALONE
// (lib/connectors/telegram.js:246-256 records the incident). Live proof: slack
// has NEVER appended a row (no last_appended_ts key at all, no
// storage/sources/slack.jsonl) yet reported a cursor advance 6 minutes old.
// last_appended_ts, in contrast, moves only on a real append.
//
// REJECTED (c): state.json .error_count — monotonic, never decays: codex-cli
// carried error_count 100,675 while capturing normally at 18:50Z. It is also
// evaluated BEFORE the stale branch in metadataFromState
// (lib/connectors/index.js:705-706), so a dead-but-noisy source is masked as
// "degraded" and can never reach "stale".
//
// ---------------------------------------------------------------------------
// e13 (capture-holes) — POLL AXIS + ERROR CAUSE. Findings F13-1..F13-5, each
// read off live disk by this node; no number below is inherited from a spec.
// ---------------------------------------------------------------------------
//
// WHY A SECOND AXIS. `last_appended_ts` answers "did anything get captured?".
// It cannot separate the two ways that answer turns to "no": the connector RAN
// and found nothing upstream, versus the connector STOPPED RUNNING. Those need
// opposite operator actions (fix the upstream/credential vs restart the agent).
// The discriminator already sits in the SAME state.json this module parses at
// :217-227 and then discarded: `last_polled_ts`. Reading it costs zero extra
// I/O, so each entry now also carries last_polled_ts / poll_age_ms /
// poll_liveness ∈ {live, stale, unmeasurable}, judged against the SAME
// resolveThresholdMs table — no second threshold is invented.
//
// F13-1 — A SLACK CONNECTOR EXISTS AND IS AUTH-DEAD. lib/connectors/slack.js
// is installed and scheduled (a launchd agent with a 600 s StartInterval) and
// was RUNNING AND FAILING every poll: the connector's stdout tails
// {"appended":0,"errors":1,"channels":0,"workspaces":1}, and
// connectors/slack/state.json carried an error count in the thousands,
// last_error_kind "slack_auth_invalid_auth", a last_error_ts minutes old at
// read, last_appended_ts null, and NO storage/sources/slack.jsonl on disk at
// all. The token is dead: slack.js maps invalid_auth ->
// `slack_auth_invalid_auth`, resolveSelfUserId returns null after tagging it,
// and the workspace is then skipped, so pollOnce can never reach an append.
// "slack has never appended" is TRUE; "slack is an absent feature" is
// FALSE. The fix is an operator CREDENTIAL ROTATION — not code, and emphatically
// not a new connector. This module's job is to make that legible, which is what
// the never_appended_erroring reason below does.
//
// F13-2 — THE webUsage ROWS DO CARRY DOMAINS; REFUSED as a premise. A full
// scan of storage/sources/screentime.jsonl found N rows on stream
// "/app/webUsage" spread across M distinct domains, and every one of them
// carries a non-null raw_content.web_domain and web_url (none missing). The
// reader is not dropping URLs: screentime.js maps
// Z_DKDIGITALHEALTHMETADATAKEY__WEBDOMAIN/__WEBPAGEURL straight through. The
// real gaps are two, and NEITHER is a code defect here:
//   (a) all webUsage rows come from a single browser bundle. macOS
//       knowledgeC emits /app/webUsage for Safari alone, so other browsers'
//       "/app/usage" rows carry no URL BY SOURCE DESIGN — unobtainable
//       from this connector at any effort;
//   (b) nothing downstream resolves those domains because screentime sits in
//       CAPS.WATERMARK_CAPTURED_ONLY_SOURCES (lib/validation.js), i.e.
//       its cascade is frozen ON PURPOSE.
// Recorded as an honest gap. No code follows from it.
//
// F13-3 — "SLACK AND ZOOM REACH NO LEDGER AT ALL" is FALSE for presence.
// Same read: screentime "/app/usage" already captures both apps' foreground
// hours. What is missing is CONTENT, not the hours.
// Zoom content would need new credentials and a new external scope, which this
// node is forbidden to wire; it is left as a prose proposal only.
//
// F13-4 — A TWO-DAY CAPTURE HOLE IS REAL, BUT ROW COUNTS ARE NOT LIVENESS
// EVIDENCE. Scanning every row's `ts` showed three sources with exactly zero
// rows on two non-adjacent days, bracketing a one-day git-log spike — a
// capture hole, not a quiet weekend. But the reasoning "the passive
// message sources kept flowing, therefore the machine was up" does NOT follow,
// because `ts` means different things per source: telegram rows carry ts =
// MESSAGE time in offset format while screentime rows carry ts = APPEND time
// (a screentime row appended today can describe an event whose start_date is
// years old). Backfilled message time and append time
// are not the same clock, so cross-source row counts cannot establish that a
// capture process was alive. That is precisely why the poll HEARTBEAT added
// here — a timestamp the connector writes when it RUNS — is the right primitive
// and a row count is not.
//
// F13-5 — REFUSED SUB-INSTRUCTION: no "poll_liveness=unmeasurable" suffix on
// the source_capture_stale line. Two already-green tests pin that line
// byte-identically for fixtures that carry NO last_polled_ts —
// test/connector-staleness.test.mjs:408 ("source_capture_stale: t7stale
// last_append_h=9 threshold_h=6") and :579 (same shape, unregistered-connector)
// — so appending a suffix in the unmeasurable case would edit T7/T11's bodies to
// land. The suffix is therefore emitted ONLY when the poll axis is MEASURABLE
// (live / stale), which is exactly when it discriminates. Silence is the honest
// rendering of unmeasurable: health_notes is an exception channel, and saying
// nothing is not a claim of health. The verdict is still typed on the entry
// (poll_liveness === "unmeasurable"), which is where T16 asserts it.
//
// POLL-HEARTBEAT COVERAGE, enumerated from each state.json (never asserted): of
// the 9 installed connectors, only 4 stamp last_polled_ts — codex-cli, git-log,
// slack and telegram. Five do NOT write the key at all: github-events,
// imessage, mail, screentime, whatsapp. Those five are typed `unmeasurable` and
// MUST NOT be described as healthy on the poll axis (GOAL invariant 1: absence
// is never a verdict). PROPOSAL FOR THE OPERATOR, deliberately not done here:
// stamp last_polled_ts unconditionally in those five connectors' pollOnce, in
// the same shape as slack.js does. Editing a live connector is a daemon
// behaviour change that stays inert until a restart this node is forbidden to
// perform, and it would write under connectors/*/state.json.
//
// ERROR FIELDS ARE CAUSE ANNOTATION, NOT A VERDICT INPUT. last_error_kind /
// last_error_ts / error_count are copied onto an entry whose reason was ALREADY
// decided by capture evidence, plus a derived `erroring_now` (the error is more
// recent than the freshest capture evidence AND within the source threshold).
// REJECTED (c) below stands verbatim and unamended: error_count is still never
// an input to the verdict. Proof that it must not be: a connector can carry
// an error count in the hundreds of thousands with last_error_kind
// "parse_error" while capturing normally, its last_error_ts weeks older than
// its last_appended_ts — so erroring_now is false for it. Only the recency
// comparison, never the count, gates the annotation.
//
// ---------------------------------------------------------------------------
// HARD RULE — never read a source ledger's content. Mirrors
// lib/connectors/telegram-drain-liveness.js:18-22: storage/sources/mail.jsonl
// was 349,643,964 bytes and codex-cli.jsonl 267,592,307 bytes on 2026-08-11,
// either of which can exceed Node's string cap. We statSync the source ledger
// for mtimeMs + size and NEVER open it. The only file read here is the tiny
// connector state.json. Mechanically enforced by T6.
//
// Pure + side-effect-free, like the B1 detector: injectable `now`, injectable
// `thresholds`, injectable dirs; no writes of any kind (no mkdirSync, no
// writeFileSync, no cache file), no daemon RPC, no bare Date.now(). It NEVER
// throws — every filesystem touch goes through safeStat / try-catch — because
// its consumer (memory_health) must stay "read-only, cheap, safe to call from
// a status line".
//
// NOTE: lib/connectors/index.js metadataFromState is deliberately NOT reused —
// it calls bare Date.now() (index.js:708) and is therefore not injectable-pure.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

import {
  connectorsDir as defaultConnectorsDir,
  connectorStatePath,
  sourceLedgerPath as defaultSourceLedgerPath,
} from "../config.js";
import { CAPS } from "../validation.js";

// statSync wrapper — never throws. Absent/error => {exists:false, mtimeMs:0,
// size:0} so callers treat a missing file as "no signal" rather than crashing.
// Copied from lib/connectors/telegram-drain-liveness.js:44-51.
function safeStat(path) {
  try {
    const st = statSync(path);
    return { exists: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 };
  }
}

// Wildcard roster entries ("chat-claude-code-*") are owned by the chat-ledger
// pipeline and have no single <source>.jsonl. Skipped exactly as
// daemons/watermark.js:754 (listSourceLedgers) skips them.
function isWildcardEntry(entry) {
  return entry.includes("*");
}

// Directory names under connectorsDir that carry a state.json. A connector can
// be installed before it is registered in CAPS.WATERMARK_SOURCES; unioning this
// in means such a source is still covered. Never throws.
function installedConnectorDirs(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    try {
      if (existsSync(`${dir}/${d.name}/state.json`)) out.push(d.name);
    } catch {
      /* unreadable entry contributes no signal */
    }
  }
  return out;
}

function resolveDir(arg, fallback) {
  if (typeof arg === "string" && arg !== "") return arg;
  if (typeof arg === "function") {
    try {
      const v = arg();
      if (typeof v === "string" && v !== "") return v;
    } catch {
      /* fall through to the default */
    }
  }
  return fallback();
}

// Per-source threshold. `thresholds` is a plain {default_ms, overrides_ms}
// object so the caller — and the hermetic tests — can inject the whole table
// without an env seam, keeping the detector pure.
function resolveThresholdMs(source, thresholds) {
  const t = thresholds && typeof thresholds === "object" ? thresholds : {};
  const defaultMs =
    Number.isFinite(t.default_ms) && t.default_ms > 0
      ? t.default_ms
      : CAPS.SOURCE_CAPTURE_STALE_DEFAULT_MS;
  const overrides =
    t.overrides_ms && typeof t.overrides_ms === "object"
      ? t.overrides_ms
      : CAPS.SOURCE_CAPTURE_STALE_OVERRIDES_MS;
  const v = overrides ? overrides[source] : undefined;
  return Number.isFinite(v) && v > 0 ? v : defaultMs;
}

// Age of the freshest capture evidence = the SMALLER of the two ages (the
// larger of the two timestamps). Derived, not stored, so the entry shape stays
// exactly the one the spec pins; used by both the verdict and the formatter.
function livenessAgeMs(entry) {
  const ages = [entry.append_age_ms, entry.ledger_age_ms].filter(
    (v) => typeof v === "number" && Number.isFinite(v)
  );
  if (ages.length === 0) return null;
  return Math.min(...ages);
}

// computeSourceCaptureStaleness — pure detector. One entry per roster source,
// sorted by source name for stable operator/test diffing.
export function computeSourceCaptureStaleness({
  now = new Date(),
  sources,
  thresholds,
  connectorsDir,
  sourcesDir,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const nowSafe = Number.isFinite(nowMs) ? nowMs : 0;
  const connDir = resolveDir(connectorsDir, defaultConnectorsDir);

  const ledgerPathFor = (source) =>
    typeof sourcesDir === "string" && sourcesDir !== ""
      ? `${sourcesDir}/${source}.jsonl`
      : defaultSourceLedgerPath(source);

  // Roster: registered sources (minus wildcards) UNION installed connector dirs.
  const base = Array.isArray(sources) ? sources : CAPS.WATERMARK_SOURCES;
  const roster = new Set();
  for (const entry of base) {
    if (typeof entry !== "string" || entry === "") continue;
    if (isWildcardEntry(entry)) continue;
    roster.add(entry);
  }
  for (const name of installedConnectorDirs(connDir)) roster.add(name);

  const out = [];
  for (const source of [...roster].sort()) {
    const statePath = `${connDir}/${source}/state.json`;
    const stateStat = safeStat(statePath);
    const stateExists = stateStat.exists;

    // The tiny connector cursor — the ONLY file this module reads. A present
    // but unreadable/unparseable state.json is a TYPED failure, never silently
    // healthy (s5-typed-read-failures).
    let state = null;
    let stateUnreadable = false;
    if (stateExists) {
      try {
        const raw = readFileSync(statePath, "utf8");
        state = raw === "" ? null : JSON.parse(raw);
        if (state === null || typeof state !== "object") stateUnreadable = raw !== "";
      } catch {
        stateUnreadable = true;
        state = null;
      }
    }

    const lastAppendedTs =
      state && typeof state.last_appended_ts === "string" ? state.last_appended_ts : null;
    const parsedAppend = lastAppendedTs != null ? Date.parse(lastAppendedTs) : NaN;
    const appendAgeMs = Number.isFinite(parsedAppend) ? nowSafe - parsedAppend : null;

    // The POLL axis (e13). Same already-parsed state object, zero extra I/O.
    // A connector that does not write the key is unmeasurable, never "live".
    const lastPolledTs =
      state && typeof state.last_polled_ts === "string" ? state.last_polled_ts : null;
    const parsedPoll = lastPolledTs != null ? Date.parse(lastPolledTs) : NaN;
    const pollAgeMs = Number.isFinite(parsedPoll) ? nowSafe - parsedPoll : null;

    // Error CAUSE annotation (e13). Never a verdict input — see header.
    const lastErrorKind =
      state && typeof state.last_error_kind === "string" && state.last_error_kind !== ""
        ? state.last_error_kind
        : null;
    const lastErrorTs =
      state && typeof state.last_error_ts === "string" ? state.last_error_ts : null;
    const parsedError = lastErrorTs != null ? Date.parse(lastErrorTs) : NaN;
    const errorAgeMs = Number.isFinite(parsedError) ? nowSafe - parsedError : null;
    const errorCount =
      state && Number.isFinite(state.error_count) ? state.error_count : null;

    // Source ledger — STAT ONLY (mtimeMs + size). Never opened. See header.
    const ledgerStat = safeStat(ledgerPathFor(source));
    const ledgerMtimeMs = ledgerStat.mtimeMs;
    const ledgerSize = ledgerStat.size;
    const ledgerHasBytes = ledgerStat.exists && ledgerSize > 0;
    const ledgerAgeMs = ledgerHasBytes && ledgerMtimeMs > 0 ? nowSafe - ledgerMtimeMs : null;

    const thresholdMs = resolveThresholdMs(source, thresholds);
    const entry = {
      source,
      // A capture footprint on disk: a connector state.json OR a source ledger.
      installed: stateExists || ledgerStat.exists,
      last_appended_ts: lastAppendedTs,
      append_age_ms: appendAgeMs,
      ledger_mtime_ms: ledgerMtimeMs,
      ledger_age_ms: ledgerAgeMs,
      ledger_size: ledgerSize,
      threshold_ms: thresholdMs,
      // POLL axis — independent of the capture verdict below.
      last_polled_ts: lastPolledTs,
      poll_age_ms: pollAgeMs,
      poll_liveness:
        pollAgeMs == null ? "unmeasurable" : pollAgeMs <= thresholdMs ? "live" : "stale",
      // Error CAUSE annotation — read, never weighed.
      last_error_kind: lastErrorKind,
      error_age_ms: errorAgeMs,
      error_count: errorCount,
      erroring_now: false,
      reason: "fresh",
      stale: false,
    };

    // erroring_now: is the connector failing RIGHT NOW, as opposed to carrying
    // an ancient tombstone? True only when the last error is more recent than
    // the freshest capture evidence (or there is none) AND is itself inside the
    // source's own staleness window. error_count plays no part.
    const age = livenessAgeMs(entry);
    entry.erroring_now =
      errorAgeMs != null && errorAgeMs <= thresholdMs && (age == null || errorAgeMs < age);

    // Reason precedence (spec-pinned; e13 inserts one rung):
    //   not_installed -> state_unreadable -> never_appended_erroring ->
    //   never_appended -> stale -> fresh
    if (!stateExists && !ledgerStat.exists) {
      entry.reason = "not_installed";
    } else if (stateUnreadable) {
      entry.reason = "state_unreadable";
    } else if (age == null && entry.erroring_now) {
      // The live `slack` shape WITH a cause: never appended, and failing now.
      entry.reason = "never_appended_erroring";
    } else if (age == null) {
      // No last_appended_ts AND no ledger bytes, silently — no cause on file.
      entry.reason = "never_appended";
    } else if (age > thresholdMs) {
      entry.reason = "stale";
      entry.stale = true; // stale===true ONLY here
    } else {
      entry.reason = "fresh";
    }
    out.push(entry);
  }
  return out;
}

// Round hours the way lib/tools/health.js's telegram block does.
function hoursLabel(ms) {
  return typeof ms === "number" && Number.isFinite(ms)
    ? Math.round((ms / 3600000) * 10) / 10
    : "unknown";
}

// Poll-axis annotation for the source_capture_stale line. It answers the
// question the append timestamp alone cannot: did the connector RUN?
//   poll_liveness=live   — it ran and found nothing (look upstream/at creds)
//   poll_liveness=stale  — it stopped running (look at the agent)
// `unmeasurable` deliberately appends NOTHING; see F13-5 in the header. Silence
// is not a claim of health, whereas a suffix on a line two green tests pin
// byte-for-byte would be an edit to their bodies. Reuses hoursLabel — no second
// rounding convention.
function pollSuffix(entry) {
  const v = entry.poll_liveness;
  if (v !== "live" && v !== "stale") return "";
  return ` poll_liveness=${v} polled_h=${hoursLabel(entry.poll_age_ms)}`;
}

// buildCaptureStalenessHealthNotes — pure formatter, split from the computation
// exactly as buildEmptyRateHealthNotes is (lib/ingest/source-effective-empty-
// rate.js). `fresh` and `not_installed` emit NOTHING: health_notes is an
// exception channel, not an inventory.
export function buildCaptureStalenessHealthNotes(snapshot) {
  const notes = [];
  if (!Array.isArray(snapshot)) return notes;
  for (const entry of snapshot) {
    if (!entry || typeof entry !== "object") continue;
    switch (entry.reason) {
      case "stale":
        notes.push(
          `source_capture_stale: ${entry.source} last_append_h=${hoursLabel(
            livenessAgeMs(entry)
          )} threshold_h=${hoursLabel(entry.threshold_ms)}${pollSuffix(entry)}`
        );
        break;
      case "never_appended_erroring":
        // The escalation: same silence as never_appended, but with a cause an
        // operator can act on. Live shape 2026-08-20 — slack, invalid_auth.
        notes.push(
          `source_never_appended_erroring: ${entry.source} last_error_kind=${
            entry.last_error_kind
          } error_count=${
            entry.error_count == null ? "unknown" : entry.error_count
          } error_age_h=${hoursLabel(entry.error_age_ms)}`
        );
        break;
      case "never_appended":
        notes.push(`source_never_appended: ${entry.source}`);
        break;
      case "state_unreadable":
        notes.push(`source_state_unreadable: ${entry.source}`);
        break;
      default:
        break; // fresh / not_installed / unknown => silent
    }
  }
  return notes;
}
