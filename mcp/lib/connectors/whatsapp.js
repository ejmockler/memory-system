// WhatsApp connector — read-only poll of ChatStorage.sqlite (WhatsApp Desktop).
//
// R39 Phase 3b connector. Reads the WhatsApp Desktop SQLite DB
// (~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite
// — note: NOT under a Message/ subdir; the Phase A inventory verified the
// real path on this host) and emits one source-ledger row per ZWAMESSAGE row
// into storage/sources/whatsapp.jsonl. Idempotent on ZSTANZAID (WhatsApp's
// source-native stable XMPP-style message id). Cursor is the max ZWAMESSAGE
// Z_PK seen so far; restart picks up from there.
//
// Authoritative spec:
//   - reviews/r39/inventory.md § per-connector design (WhatsApp).
//   - kb/connectors-survey.md § Top-5 connector skeletons (for the
//     six-point contract this connector inherits via ConnectorBase).
//   - kb/connectors-phase3.md § whatsapp_row_shape (BEGIN-CANONICAL block).
//
// FULL DISK ACCESS REQUIREMENT (operator action):
//   The WhatsApp Desktop data directory at
//   ~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ is gated by
//   the same macOS Transparency-Consent-Control entitlement (Full Disk Access)
//   that protects ~/Library/Messages/. The operator must grant FDA to the
//   node binary that runs this connector, i.e. the one the rendered
//   whatsapp-connector plist names in ProgramArguments:
//
//     1. Open System Settings → Privacy & Security → Full Disk Access.
//     2. Click "+", navigate to that node binary and add it (toggle ON).
//     3. Load the service as described in launchd/README.md.
//
//   The same FDA grant covers the iMessage connector path when both plists
//   name the same node binary, so no additional TCC action is needed when
//   the operator already activated the iMessage connector. Verify with:
//     `node mcp/lib/connectors/whatsapp.js --check`
//   which exits 0 ("ok") on a healthy process — and with `--once` for a
//   single pollOnce that surfaces a permission-denied error code if FDA is
//   missing.
//
// Composition: extends ConnectorBase (lib/connectors/index.js). The base
// owns cursor, idempotent append, source_policy stamping, checksum, and
// health. THIS module owns ChatStorage.sqlite reads, message metadata
// projection, and the 1:1-vs-group consent classifier.
//
// Deps:
//   - node:sqlite (DatabaseSync) — built-in to Node 22+. No npm dep.
//   - read-only open via { readOnly: true } so we never accidentally write
//     to WhatsApp's source-of-truth ChatStorage.sqlite.
//
// HERMETICITY: this module reads from chatStoragePath (default resolved via
// homedir() + the WhatsApp Group Container path); tests pass a synthetic
// in-tmpdir ChatStorage.sqlite via opts.chatStoragePath. The default path is
// never read by the test suite.
//
// KEY/PII_LEAKAGE_ZERO: error telemetry must use stable, non-PII kind codes;
// raw content and operator dialogue must not be logged. The recovery-row path
// uses chat_db_row_processing_failed, whose planted test pins the state shape.
// Keep every new failure kind under the same rule.
//
// CLI shim:
//   node whatsapp.js --check          → prints "ok" exits 0 (process-up health probe)
//   node whatsapp.js --once           → runs runOnce(), prints JSON result, exits
//   node whatsapp.js --backfill-voice → transcribes existing 1:1 voice rows in
//                                       the source ledger into "#stt" enrichment
//                                       rows; prints ONLY a JSON count summary
//   node whatsapp.js                  → runForever() (launchd entry point)

import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ConnectorBase,
  DEDUP_TAIL_AVG_LINE_BYTES,
  DEDUP_TAIL_MIN_READ_BYTES,
} from "./index.js";
import { CAPS } from "../validation.js";
import { isResolvedName } from "./whatsapp-name-recovery.js";
import { resolveSenderForRow, SELF_PARTY } from "./whatsapp-sender-index.js";
import { extractQuotedStanzaId } from "./whatsapp-context-info.js";
import { isWhatsAppIdentifierBodyPlaceholder } from "../predicates/whatsapp-content-shape.js";
import { STORAGE_DIR } from "../config.js";
// Voice-note STT (wa-voice-stt V3). whatsapp-voice.js owns candidate selection,
// media path resolution, the quality gate and row shaping; this module only
// schedules it. The import is circular (whatsapp-voice.js imports classifyRow
// from here) and safe: neither module touches the other's bindings at load.
import {
  TRANSCRIBE_CONSENT,
  MAX_BATCH_AUDIO_S,
  isVoiceCandidate,
  isGamePaused,
  applyTranscriptInBand,
  buildEnrichmentRow,
  transcribeBatch,
  defaultPythonRunner,
  defaultPauseFlag,
  resolveMediaPath,
} from "./whatsapp-voice.js";

// Source identifier. Stamped onto every emitted row; also the basename of
// storage/sources/whatsapp.jsonl and connectors/whatsapp/state.json.
const SOURCE = "whatsapp";

// Default ChatStorage.sqlite path. Tests override via constructor; the
// daemon entry uses this default unless CAPS.WHATSAPP_CHATSTORAGE_PATH is
// configured to override.
function defaultChatStoragePath() {
  if (typeof CAPS.WHATSAPP_CHATSTORAGE_PATH === "string"
      && CAPS.WHATSAPP_CHATSTORAGE_PATH.length > 0) {
    // Substitute leading "~/" with homedir for operator-friendly path config.
    const p = CAPS.WHATSAPP_CHATSTORAGE_PATH;
    if (p.startsWith("~/")) {
      return join(homedir(), p.slice(2));
    }
    return p;
  }
  return join(
    homedir(),
    "Library",
    "Group Containers",
    "group.net.whatsapp.WhatsApp.shared",
    "ChatStorage.sqlite",
  );
}

// Poll interval. Default to 5 min (parity with iMessage's 30-second cadence
// is overkill for WhatsApp Desktop which only syncs on app activation; the
// extra latency is operationally invisible). Operator can override via
// CAPS.WHATSAPP_POLL_INTERVAL_SECONDS.
function defaultPollIntervalMs() {
  const seconds = typeof CAPS.WHATSAPP_POLL_INTERVAL_SECONDS === "number"
    ? CAPS.WHATSAPP_POLL_INTERVAL_SECONDS
    : 300;
  return seconds * 1000;
}

// Core Data epoch (2001-01-01) in unix seconds. WhatsApp's ZMESSAGEDATE is
// Core Data seconds since 2001-01-01 (float). All real values are well
// within Number safe-integer regime (year 5000 sits at ~9.5e10 seconds, far
// below 2^53), so no BigInt path is required.
const COREDATA_EPOCH_UNIX_SECONDS = 978307200;

// Reply linkage has two producer surfaces. ZPARENTMESSAGE is resolved through
// the relational join below. For rows without that FK, ZWAMEDIAITEM.ZMETADATA
// may carry a contextInfo protobuf; whatsapp-context-info.js recognizes only
// its quoted-stanza field and fails closed to no metadata-derived linkage.
// Keep the precedence rule explicit:
//   1. use the relational parent when it is a non-empty stanza id;
//   2. otherwise ask the narrow metadata decoder for a candidate;
//   3. omit linkage when neither surface supplies a validated id.
// The metadata decoder is intentionally not a contextInfo implementation. Its
// contract is limited to the outer protobuf envelope and quoted-stanza field.
// It must not infer a participant, quoted body, timestamp, or nested message.
// Those values are outside the connector's linkage requirement and widening
// the parser would increase the private-format failure surface.
// Treat every metadata candidate as untrusted bytes. The decoder must validate
// the complete outer envelope, the target field's wire type, uniqueness, and
// stanza-id shape before returning it. An unknown field may be skipped only by
// a standard protobuf wire rule supported by the decoder. A malformed key,
// length, payload, duplicate target, unsupported wire type, or trailing byte
// must degrade to no metadata-derived linkage without throwing.
//
// Keep the relational and metadata surfaces additive. Metadata decoding must
// not introduce semantic classification, and it must not replace a relational
// parent. Do not emit the raw metadata blob into the source ledger. Only a
// validated stanza id may populate the existing reply_to and forensic alias.
//
// Keep cursor timestamps behind value-change predicates. The registered
// cursor-stamp-class guard line-pins that rule at the write site below; update
// its citation when edits move the write.
//
// Numeric ZMESSAGETYPE values do not declare reaction semantics here.
// Reaction capture requires a dedicated receipt-info producer; until that
// producer exists, message rows must not emit kind="reaction".

// ZSESSIONTYPE values from ZWACHATSESSION:
//   0 = 1:1 chat
//   1 = group chat
//   2 = broadcast list (status updates)
//   3 = system / metadata pseudo-chat
// Message rows may carry these via the parent chat session.
const ZSESSIONTYPE_ONE_ON_ONE = 0;
const ZSESSIONTYPE_GROUP = 1;
const ZSESSIONTYPE_BROADCAST = 2;

// Convert Core Data seconds (since 2001-01-01) to ISO-8601. Returns null
// on non-finite input.
function coreDataSecondsToIso(seconds) {
  if (seconds == null) return null;
  const asNumber = typeof seconds === "number" ? seconds : Number(seconds);
  if (!Number.isFinite(asNumber)) return null;
  const unixMs = (asNumber + COREDATA_EPOCH_UNIX_SECONDS) * 1000;
  if (!Number.isFinite(unixMs)) return null;
  return new Date(unixMs).toISOString();
}

// Classify a row per the Phase A inventory consent table. Returns
// {consent_basis, deletion_semantics}.
//
//   - is_from_me=1                                → first_party
//   - is_from_me=0, session_type=1:1              → second_party_dm
//   - is_from_me=0, session_type=group            → third_party_inferred
//   - is_from_me=0, session_type=broadcast        → third_party_inferred
export function classifyRow(row) {
  const isFromMe = row.is_from_me === 1 || row.is_from_me === true;
  const sessionType = Number.isInteger(row.session_type)
    ? row.session_type
    : (row.session_type != null ? Number(row.session_type) : null);

  let consentBasis;
  if (isFromMe) {
    consentBasis = "first_party";
  } else if (sessionType === ZSESSIONTYPE_ONE_ON_ONE) {
    consentBasis = "second_party_dm";
  } else if (sessionType === ZSESSIONTYPE_GROUP
             || sessionType === ZSESSIONTYPE_BROADCAST) {
    consentBasis = "third_party_inferred";
  } else {
    // Unknown / null session_type — conservative default.
    consentBasis = "third_party_inferred";
  }

  return {
    consent_basis: consentBasis,
    deletion_semantics: "full_excise",
  };
}

// ---------------------------------------------------------------------------
// Voice-note STT scheduling (wa-voice-stt V3)
// ---------------------------------------------------------------------------
//
// The connector only SCHEDULES transcription; whatsapp-voice.js decides who is
// a candidate, where the audio lives, whether a transcript passes, and how the
// row is shaped. STT never gates the cursor: a failure or a game pause parks
// the job in voice_pending while last_zpk advances exactly as before.
//
// State keys (connectors/whatsapp/state.json, never transcript text):
//   voice_pending   [{zpk, stanza, first_seen, attempts, reason}]  retryable
//   voice_done      [stanza, ...]  capped FIFO idempotency gate (heavy sidecar)
//   voice_failed    [{zpk, stanza, reason, failed_at}]  terminal, last 50
//   voice_pending_n / voice_failed_n / stt_last_batch {n, audio_s, wall_ms}
//   voice_backoff_zpk  Z_PK of the row a poll failed to process; in-band STT is
//                      deferred for zpk >= it until last_zpk reaches it
//
// Retryable-without-attempt reasons beyond the transcribeBatch ones:
//   dedup_inband  an ok in-band transcript whose row append deduped (store
//                 rebuild / crash replay): the late path emits a "#stt" row
//   deferred      in-band STT skipped behind a row-processing failure
//   no_media      1:1 voice row whose media is not downloaded yet
//   env_error     the worker's environment is broken (ffmpeg missing); no
//                 attempt consumed, bounded by the 72h TTL alone
//   worker_crash  the worker exited non-zero with no job lines (import
//                 failure); no attempt consumed, bounded by the TTL alone
// Retryable reason that DOES consume an attempt (beyond no_result/stt_error):
//   append_error  the late path's "#stt" enrichment append threw
// Terminal late-path reason (not retryable, no attempt consumed):
//   row_gone      parent row no longer visible in ChatStorage by Z_PK or stanza
const VOICE_RETRYABLE = new Set([
  "paused", "no_result", "stt_error", "batch_cap", "unreadable",
  "dedup_inband", "deferred", "no_media", "env_error", "worker_crash",
  "append_error",
]);
// Only a real STT run that produced nothing consumes an attempt; a pause,
// batch cap or not-yet-downloaded file waits out the TTL instead.
const VOICE_ATTEMPT_REASONS = new Set(["no_result", "stt_error", "append_error"]);
const VOICE_MAX_ATTEMPTS = 3;
const VOICE_PENDING_TTL_MS = 72 * 3600 * 1000;
const VOICE_FAILED_CAP = 50;
const VOICE_DONE_CAP = 5000;
const VOICE_LATE_BATCH_MAX = 20;
const VOICE_BACKFILL_BATCH_MAX = 8;

// A pending entry whose stanza is already in voice_done is dropped: done is
// the idempotency gate and wins over any stale pending copy. `base` snapshots
// the pending entries as read, so mergeVoiceState can tell what THIS writer
// added, changed or removed from what another writer did meanwhile.
export function readVoiceState(cursor) {
  const c = cursor && typeof cursor === "object" ? cursor : {};
  const done = Array.isArray(c.voice_done)
    ? c.voice_done.filter((x) => typeof x === "string")
    : [];
  const doneSet = new Set(done);
  const pending = Array.isArray(c.voice_pending)
    ? c.voice_pending.filter((e) => e && typeof e.stanza === "string" && !doneSet.has(e.stanza))
    : [];
  return {
    pending,
    done,
    failed: Array.isArray(c.voice_failed) ? c.voice_failed.slice(-VOICE_FAILED_CAP) : [],
    lastBatch: c.stt_last_batch && typeof c.stt_last_batch === "object" ? c.stt_last_batch : null,
    changed: false,
    // Bumped by every settle that really changes pending/done/failed, so a
    // batch can tell whether it moved anything (idle retries must not churn).
    rev: 0,
    base: new Map(pending.map((e) => [e.stanza, JSON.stringify(e)])),
  };
}

// mergeVoiceState — pure per-stanza merge of this writer's voice state `vs`
// onto the voice fields of a FRESHLY re-read cursor, so two writers (the
// daemon's pollOnce and an operator backfillVoice) never lose each other's
// work by overwriting arrays from a stale snapshot. Returns a new state
// object shaped like readVoiceState (feed it to voiceStateFields):
//   done    fresh ∪ ours, FIFO-capped at VOICE_DONE_CAP;
//   pending keyed by stanza: an entry this writer added or changed wins; one
//           it removed (settled or expired: in base, not in ours) stays gone;
//           one it left untouched takes the fresh version (or its absence);
//           every stanza in the merged done set or in the final (capped)
//           failed list is dropped, so no stanza is both pending and failed;
//   failed  keyed by stanza, fresh order then ours, capped at VOICE_FAILED_CAP.
export function mergeVoiceState(freshCursor, vs) {
  const fresh = readVoiceState(freshCursor);
  const base = vs.base instanceof Map ? vs.base : new Map();
  const done = [...fresh.done];
  const doneSet = new Set(done);
  for (const s of vs.done) {
    if (!doneSet.has(s)) { doneSet.add(s); done.push(s); }
  }
  const cappedDone = done.slice(-VOICE_DONE_CAP);
  const ours = new Map(vs.pending.map((e) => [e.stanza, e]));
  const touched = (e) => base.get(e.stanza) !== JSON.stringify(e);
  const pending = [];
  const seen = new Set();
  for (const e of fresh.pending) {
    seen.add(e.stanza);
    const mine = ours.get(e.stanza);
    if (mine) pending.push(touched(mine) ? mine : e);
    else if (!base.has(e.stanza)) pending.push(e); // added by the other writer
    // else: this writer removed it (settled/expired) -> keep it gone
  }
  for (const [stanza, e] of ours) {
    if (seen.has(stanza)) continue;
    if (touched(e)) pending.push(e); // added/changed here; untouched = other writer removed it
  }
  const failedBy = new Map();
  for (const f of [...fresh.failed, ...vs.failed]) {
    if (!f || typeof f !== "object") continue;
    const key = typeof f.stanza === "string" ? f.stanza : JSON.stringify(f);
    if (failedBy.has(key)) failedBy.delete(key);
    failedBy.set(key, f);
  }
  // Oldest first by failed_at (stable), so the cap keeps the newest terminals.
  const failed = [...failedBy.values()]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => String(a.f.failed_at ?? "").localeCompare(String(b.f.failed_at ?? "")) || a.i - b.i)
    .map(({ f }) => f);
  const cappedFailed = failed.slice(-VOICE_FAILED_CAP);
  const failedSet = new Set(cappedFailed.map((f) => f.stanza).filter((s) => typeof s === "string"));
  return {
    pending: pending.filter((e) => !doneSet.has(e.stanza) && !failedSet.has(e.stanza)),
    done: cappedDone,
    failed: cappedFailed,
    lastBatch: vs.lastBatch ?? fresh.lastBatch,
    changed: vs.changed,
    rev: vs.rev,
    base: new Map(),
  };
}

function markVoiceChanged(vs) {
  vs.changed = true;
  vs.rev += 1;
}

function readVoiceBackoff(cursor) {
  const v = cursor && typeof cursor === "object" ? cursor.voice_backoff_zpk : null;
  return Number.isInteger(v) ? v : null;
}

const VOICE_STATE_KEYS = Object.freeze([
  "voice_pending", "voice_done", "voice_failed",
  "voice_pending_n", "voice_failed_n", "stt_last_batch",
]);

function voiceStateFields(vs) {
  const failed = vs.failed.slice(-VOICE_FAILED_CAP);
  return {
    voice_pending: vs.pending,
    voice_done: vs.done.slice(-VOICE_DONE_CAP),
    voice_failed: failed,
    voice_pending_n: vs.pending.length,
    voice_failed_n: failed.length,
    stt_last_batch: vs.lastBatch,
  };
}

// ---------------------------------------------------------------------------
// WhatsAppConnector
// ---------------------------------------------------------------------------

export class WhatsAppConnector extends ConnectorBase {
  constructor({
    chatStoragePath,
    sourceLedgerPath,
    cursorPath,
    now,
    voice,
  } = {}) {
    super({
      source: SOURCE,
      sourceLedgerPath,
      cursorPath,
      sourcePolicyForRow: (row) => {
        const classified = classifyRow(row.raw_content || {});
        return {
          deletion_semantics: classified.deletion_semantics,
          consent_basis: classified.consent_basis,
        };
      },
    });
    this.chatStoragePath = chatStoragePath || defaultChatStoragePath();
    this._now = typeof now === "function" ? now : null;
    // Voice-note STT options. The default runner is created lazily in
    // _voiceRunner() so constructing a connector never prepares a python
    // spawn; tests inject a fake runner. consent can only NARROW the 1:1 set.
    const v = voice && typeof voice === "object" ? voice : {};
    this.voice = {
      enabled: typeof v.enabled === "boolean"
        ? v.enabled
        : process.env.WHATSAPP_VOICE_STT !== "0",
      runner: typeof v.runner === "function" ? v.runner : null,
      mediaRoot: typeof v.mediaRoot === "string" && v.mediaRoot !== "" ? v.mediaRoot : undefined,
      tmpDir: typeof v.tmpDir === "string" && v.tmpDir !== ""
        ? v.tmpDir
        : join(STORAGE_DIR, "tmp", "voice"),
      flagPath: typeof v.flagPath === "string" && v.flagPath !== "" ? v.flagPath : undefined,
      consent: (Array.isArray(v.consent) ? v.consent : TRANSCRIBE_CONSENT)
        .filter((c) => TRANSCRIBE_CONSENT.includes(c)),
    };
  }

  // voice_done grows with the number of transcribed notes, so it lives in the
  // ConnectorBase heavy sidecar (rewritten only when it changes) and is also
  // capped at VOICE_DONE_CAP.
  get heavyCursorKeys() {
    return ["voice_done"];
  }

  // Health: surface the STT counters next to the base envelope when present.
  _healthFromState(state) {
    const h = super._healthFromState(state);
    if (state && typeof state === "object") {
      if (Number.isInteger(state.voice_pending_n)) h.voice_pending_n = state.voice_pending_n;
      if (Number.isInteger(state.voice_failed_n)) h.voice_failed_n = state.voice_failed_n;
      if (state.stt_last_batch && typeof state.stt_last_batch === "object") {
        h.stt_last_batch = state.stt_last_batch;
      }
    }
    return h;
  }

  _voiceRunner() {
    if (!this.voice.runner) this.voice.runner = defaultPythonRunner({ flagPath: this.voice.flagPath });
    return this.voice.runner;
  }

  _voicePaused() {
    return isGamePaused({ flagPath: this.voice.flagPath });
  }

  _voiceIsCandidate(rc) {
    return isVoiceCandidate(rc, classifyRow(rc || {}).consent_basis, {
      allowedConsent: this.voice.consent,
    });
  }

  // A 1:1 voice row that WOULD be a candidate but whose media is not
  // downloaded yet (NULL media_local_path). Reuses whatsapp-voice.js's own
  // selection (type 3, 1:1 session, consent, empty text) by asking it about
  // the same row with a placeholder path, so no selection rule is duplicated.
  _voiceAwaitingMedia(rc) {
    if (!rc || typeof rc !== "object" || rc.media_local_path != null) return false;
    return this._voiceIsCandidate({ ...rc, media_local_path: "media-not-downloaded" });
  }

  // One transcribeBatch call. A throw is caught and reported as null so every
  // job falls through to voice_pending. Returns {results, batch}; the counts-
  // only batch summary is committed to stt_last_batch by _voiceCommitBatch
  // only when the batch changed something (idle retries never rewrite state).
  async _runVoiceBatch(jobs) {
    const t0 = Date.now();
    let results = null;
    try {
      results = await transcribeBatch(jobs, {
        runner: this._voiceRunner(),
        tmpDir: this.voice.tmpDir,
        flagPath: this.voice.flagPath,
        mediaRoot: this.voice.mediaRoot,
        allowedConsent: this.voice.consent,
      });
      if (!Array.isArray(results) || results.length !== jobs.length) results = null;
    } catch {
      results = null;
    }
    // Pause ordering: gamepause touches the flag BEFORE it kills the worker,
    // so a flag present now means a no_result/stt_error was the pause, not a
    // failed run. Re-label before settling so no attempt is consumed.
    if (this._voicePaused()) {
      results = jobs.map((j, k) => {
        const r = results ? results[k] : null;
        if (r && r.ok) return r;
        const reason = r && r.reason ? r.reason : "stt_error";
        return VOICE_ATTEMPT_REASONS.has(reason)
          ? { ...(r || { id: j.id, ok: false, text: null, stt: null }), reason: "paused" }
          : r;
      });
    }
    let audioS = 0;
    jobs.forEach((j, k) => {
      const r = results ? results[k] : null;
      const d = Number(r && r.ok && r.stt ? r.stt.duration_s : j.durationS);
      if (Number.isFinite(d) && d > 0) audioS += d;
    });
    const batch = {
      n: jobs.length,
      audio_s: Math.round(audioS * 10) / 10,
      wall_ms: Date.now() - t0,
    };
    return { results, batch };
  }

  // Commit a batch summary only if settling it changed voice state (rev moved
  // since rev0) or some job reached the runner and came back ok.
  _voiceCommitBatch(vs, batch, rev0, results) {
    if (!batch) return;
    const anyOk = Array.isArray(results) && results.some((r) => r && r.ok);
    if (vs.rev !== rev0 || anyOk) {
      vs.lastBatch = batch;
      vs.changed = true;
    }
  }

  // Settle one job outcome into the voice state. o = {zpk, stanza, ok, reason}.
  // A retryable outcome identical to the parked entry (same reason, attempts
  // and zpk) is put back in place untouched and does not mark a change.
  _voiceSettle(vs, o, nowIso) {
    const idx = vs.pending.findIndex((e) => e.stanza === o.stanza);
    const prior = idx >= 0 ? vs.pending[idx] : null;
    if (idx >= 0) vs.pending.splice(idx, 1);
    if (o.ok) {
      if (!vs.done.includes(o.stanza)) vs.done.push(o.stanza);
      if (vs.done.length > VOICE_DONE_CAP) vs.done.splice(0, vs.done.length - VOICE_DONE_CAP);
      markVoiceChanged(vs);
      return;
    }
    if (o.reason === "duplicate") {
      if (prior) vs.pending.splice(idx, 0, prior);
      return;
    }
    if (VOICE_RETRYABLE.has(o.reason)) {
      const counts = VOICE_ATTEMPT_REASONS.has(o.reason) && !this._voicePaused();
      const entry = {
        zpk: o.zpk,
        stanza: o.stanza,
        first_seen: prior && typeof prior.first_seen === "string" ? prior.first_seen : nowIso,
        attempts: (prior && Number.isInteger(prior.attempts) ? prior.attempts : 0) + (counts ? 1 : 0),
        reason: o.reason,
      };
      const age = Date.parse(nowIso) - Date.parse(entry.first_seen);
      if (entry.attempts >= VOICE_MAX_ATTEMPTS || (Number.isFinite(age) && age > VOICE_PENDING_TTL_MS)) {
        this._voiceFail(vs, entry, entry.reason, nowIso);
      } else if (prior && prior.reason === entry.reason
                 && prior.attempts === entry.attempts && prior.zpk === entry.zpk) {
        vs.pending.splice(idx, 0, prior);
      } else {
        vs.pending.push(entry);
        markVoiceChanged(vs);
      }
      return;
    }
    // Terminal (not_eligible, too_long, quality_gate, anything unknown).
    this._voiceFail(vs, o, o.reason || "unknown", nowIso);
  }

  _voiceFail(vs, o, reason, nowIso) {
    vs.failed.push({ zpk: o.zpk, stanza: o.stanza, reason, failed_at: nowIso });
    if (vs.failed.length > VOICE_FAILED_CAP) vs.failed.splice(0, vs.failed.length - VOICE_FAILED_CAP);
    markVoiceChanged(vs);
  }

  // In-band pass over a prebuilt batch. Mutates built[i] (transcript applied)
  // for ok results and returns {outcomes: Map(index -> {zpk, stanza, ok,
  // reason}), batch, results}. Rows already pending or done are left to the
  // late path. Rows at/after backoffZpk (a row the previous poll failed to
  // process) are "deferred" without a runner call; 1:1 voice rows whose media
  // is not downloaded yet are "no_media".
  async _voiceInBand(rows, built, vs, backoffZpk = null) {
    const out = new Map();
    const none = { outcomes: out, batch: null, results: null };
    const known = new Set([...vs.done, ...vs.pending.map((e) => e.stanza)]);
    const base = (i) => ({ zpk: Number(rows[i].zpk), stanza: built[i].source_msg_id });
    const jobs = [];
    built.forEach((row, i) => {
      const rc = row.raw_content || {};
      if (known.has(row.source_msg_id)) return;
      if (this._voiceAwaitingMedia(rc)) {
        out.set(i, { ...base(i), ok: false, reason: "no_media" });
        return;
      }
      if (!this._voiceIsCandidate(rc)) return;
      if (backoffZpk != null && Number(rows[i].zpk) >= backoffZpk) {
        out.set(i, { ...base(i), ok: false, reason: "deferred" });
        return;
      }
      jobs.push({
        i,
        job: {
          id: row.source_msg_id,
          rawContent: rc,
          durationS: rc.media_duration_s,
          consentBasis: classifyRow(rc).consent_basis,
        },
      });
    });
    if (jobs.length === 0) return none;
    if (this._voicePaused()) {
      for (const { i } of jobs) out.set(i, { ...base(i), ok: false, reason: "paused" });
      return none;
    }
    const { results, batch } = await this._runVoiceBatch(jobs.map((j) => j.job));
    jobs.forEach(({ i }, k) => {
      const r = results ? results[k] : null;
      if (r && r.ok) {
        try {
          built[i] = applyTranscriptInBand(built[i], r);
          out.set(i, { ...base(i), ok: true });
        } catch {
          out.set(i, { ...base(i), ok: false, reason: "not_eligible" });
        }
      } else {
        out.set(i, { ...base(i), ok: false, reason: r && r.reason ? r.reason : "stt_error" });
      }
    });
    return { outcomes: out, batch, results };
  }

  // Late path: retry voice_pending jobs whose parent row is already in the
  // ledger. Re-reads each row read-only by Z_PK (stanza fallback after a store
  // rebuild) through the SAME selectAndJoins, rebuilds the parent, and appends
  // a "#stt" enrichment row. appendLedgerRow dedups on source_msg_id, so a
  // repeated emit is a no-op. Never runs while the game-pause flag is up.
  async _voiceLatePath(db, selectAndJoins, pushByJid, vs, skip) {
    if (vs.pending.length === 0 || this._voicePaused()) return;
    const nowIso = this._serverTs();
    const nowMs = Date.parse(nowIso);
    for (const e of [...vs.pending]) {
      const age = nowMs - Date.parse(e.first_seen);
      if ((Number.isInteger(e.attempts) && e.attempts >= VOICE_MAX_ATTEMPTS)
          || (Number.isFinite(age) && age > VOICE_PENDING_TTL_MS)) {
        vs.pending.splice(vs.pending.indexOf(e), 1);
        this._voiceFail(vs, e, e.reason || "expired", nowIso);
      }
    }
    const eligible = vs.pending.filter((e) => !skip.has(e.stanza));
    if (eligible.length === 0) return;
    let byZpk;
    let byStanza;
    try {
      byZpk = db.prepare(selectAndJoins + " WHERE m.Z_PK = ?");
      byStanza = db.prepare(selectAndJoins + " WHERE m.ZSTANZAID = ? LIMIT 1");
    } catch {
      return;
    }
    // Read-only re-read by Z_PK (stanza fallback after a store rebuild).
    // Returns {zpk, parent, rc}; GONE when neither SELECT finds a row with
    // this stanza (for a "zpk:" id: when the Z_PK SELECT finds nothing); null when transient (a query threw) or visible but
    // unbuildable. Only GONE retires an entry.
    const GONE = { gone: true };
    const reread = (e) => {
      // A "zpk:<Z_PK>" id (ZSTANZAID was NULL/empty at build time) has the
      // Z_PK as its identity: only an empty Z_PK SELECT is GONE. A visible
      // row whose built source_msg_id no longer matches (a real ZSTANZAID
      // appeared, or a rebuilt store reused the Z_PK) is transient below.
      const isZpkId = typeof e.stanza === "string" && e.stanza.startsWith("zpk:");
      let dbRow = null;
      try {
        if (isZpkId) {
          const idZpk = Number(e.stanza.slice(4));
          const zpk = Number.isInteger(idZpk) ? idZpk : e.zpk;
          dbRow = Number.isInteger(zpk) ? byZpk.get(zpk) : null;
        } else {
          dbRow = Number.isInteger(e.zpk) ? byZpk.get(e.zpk) : null;
          if (!dbRow || dbRow.stanza_id !== e.stanza) dbRow = byStanza.get(e.stanza);
        }
      } catch {
        return null; // transient: never counts as gone
      }
      if (!dbRow) return GONE;
      if (!isZpkId && dbRow.stanza_id !== e.stanza) return GONE;
      let parent;
      try {
        parent = this._buildLedgerRow(dbRow, pushByJid);
      } catch {
        return null;
      }
      if (parent.source_msg_id !== e.stanza) return null;
      return { zpk: Number(dbRow.zpk), parent, rc: parent.raw_content || {} };
    };
    // (a) Re-read EVERY eligible entry with the cheap read-only SELECTs, no
    // cap. A row gone by Z_PK and stanza settles terminal (row_gone). A
    // transient/unbuildable re-read, or a no_media/unreadable entry still
    // unready, is left exactly as it is (no settle, no state write). Only
    // visible, ready entries join the runner candidates, so neither a pile of
    // never-downloaded notes nor invisible rows can starve the retries.
    const resolved = new Map(); // entry -> reread result
    const candidates = [];
    for (const e of eligible) {
      const hit = reread(e);
      if (hit === GONE) {
        this._voiceSettle(vs, { zpk: e.zpk, stanza: e.stanza, ok: false, reason: "row_gone" }, nowIso);
        continue;
      }
      if (!hit) continue;
      if (e.reason === "no_media" && this._voiceAwaitingMedia(hit.rc)) continue;
      if (e.reason === "unreadable") {
        if (this._voiceAwaitingMedia(hit.rc)) continue;
        const abs = resolveMediaPath(hit.rc.media_local_path, { mediaRoot: this.voice.mediaRoot });
        if (abs == null || !existsSync(abs)) continue;
      }
      resolved.set(e, hit);
      candidates.push(e);
    }
    // (c) Crash replay: a dedup_inband entry whose parent already sits in the
    // ledger WITH its in-band transcript (the append landed, the state write
    // did not) is done — no "#stt" row, no further runner call.
    let tail;
    const settledIso0 = this._serverTs();
    for (let n = candidates.length - 1; n >= 0; n -= 1) {
      const e = candidates[n];
      if (e.reason !== "dedup_inband") continue;
      if (tail === undefined) tail = this._ledgerTailRows();
      const row = this._findLedgerRowInTail(e.stanza, tail);
      const rc = row && row.raw_content;
      if (rc && rc.text_origin === "stt" && typeof rc.text === "string" && rc.text.trim() !== "") {
        this._voiceSettle(vs, { zpk: e.zpk, stanza: e.stanza, ok: true }, settledIso0);
        candidates.splice(n, 1);
      }
    }
    // (b) The runner batch: fewest attempts first, then oldest.
    const attemptsOf = (e) => (Number.isInteger(e.attempts) ? e.attempts : 0);
    candidates.sort((a, b) => attemptsOf(a) - attemptsOf(b)
      || String(a.first_seen).localeCompare(String(b.first_seen)));
    const ready = candidates.slice(0, VOICE_LATE_BATCH_MAX);
    if (ready.length === 0) return;
    const jobs = [];
    for (const e of ready) {
      const hit = resolved.get(e);
      if (!hit) continue;
      const { rc, parent } = hit;
      if (this._voiceAwaitingMedia(rc)) {
        // Media vanished again: re-park as no_media (unchanged -> no write).
        this._voiceSettle(vs, { zpk: hit.zpk, stanza: e.stanza, ok: false, reason: "no_media" }, nowIso);
        continue;
      }
      const consent = classifyRow(rc).consent_basis;
      jobs.push({
        e,
        parent,
        consent,
        zpk: hit.zpk,
        job: { id: e.stanza, rawContent: rc, durationS: rc.media_duration_s, consentBasis: consent },
      });
    }
    if (jobs.length === 0) return;
    const { results, batch } = await this._runVoiceBatch(jobs.map((j) => j.job));
    const rev0 = vs.rev;
    const settledIso = this._serverTs();
    for (let k = 0; k < jobs.length; k += 1) {
      const j = jobs[k];
      const r = results ? results[k] : null;
      const o = { zpk: j.zpk, stanza: j.e.stanza };
      if (r && r.ok) {
        let enrichment;
        try {
          enrichment = buildEnrichmentRow(j.parent, r, {
            consentBasis: j.consent,
            allowedConsent: this.voice.consent,
          });
        } catch {
          this._voiceSettle(vs, { ...o, ok: false, reason: "not_eligible" }, settledIso);
          continue;
        }
        try {
          await this.appendLedgerRow(enrichment);
        } catch {
          // Append failure: stays pending and consumes one attempt, so a
          // persistently failing append is bounded by VOICE_MAX_ATTEMPTS.
          this._voiceSettle(vs, { ...o, ok: false, reason: "append_error" }, settledIso);
          continue;
        }
        this._voiceSettle(vs, { ...o, ok: true }, settledIso);
      } else {
        this._voiceSettle(vs, { ...o, ok: false, reason: r && r.reason ? r.reason : "stt_error" }, settledIso);
      }
    }
    this._voiceCommitBatch(vs, batch, rev0, results);
  }

  // Bounded tail of the source ledger as complete lines, read exactly like
  // ConnectorBase._isDuplicate (O_NOFOLLOW positional read of the same byte
  // window, trimmed to the same dedupTailLines budget). [] when absent/empty.
  _ledgerTailRows() {
    let fd = -1;
    try {
      fd = openSync(this.sourceLedgerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch {
      return [];
    }
    let tail = "";
    let windowStart = 0;
    try {
      const size = fstatSync(fd).size;
      if (size === 0) return [];
      const windowBytes = Math.max(
        this.dedupTailLines * DEDUP_TAIL_AVG_LINE_BYTES,
        DEDUP_TAIL_MIN_READ_BYTES,
      );
      windowStart = Math.max(0, size - windowBytes);
      const length = size - windowStart;
      const buf = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const n = readSync(fd, buf, read, length - read, windowStart + read);
        if (n === 0) break;
        read += n;
      }
      tail = buf.subarray(0, read).toString("utf8");
    } catch {
      return [];
    } finally {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    if (windowStart > 0) {
      const firstNewline = tail.indexOf("\n");
      if (firstNewline === -1) return [];
      tail = tail.slice(firstNewline + 1);
    }
    const lines = tail.split("\n").filter((l) => l !== "");
    return lines.slice(Math.max(0, lines.length - this.dedupTailLines));
  }

  // The newest parsed ledger row with this source_msg_id inside the tail
  // window (lines from _ledgerTailRows, read on demand), or null.
  _findLedgerRowInTail(sourceMsgId, lines = this._ledgerTailRows()) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes(sourceMsgId)) continue;
      let parsed;
      try { parsed = JSON.parse(lines[i]); } catch { continue; }
      if (parsed && parsed.source_msg_id === sourceMsgId) return parsed;
    }
    return null;
  }

  _serverTs() {
    if (this._now) return this._now();
    return new Date().toISOString();
  }

  // pollOnce — execute one SELECT batch, append new rows, advance cursor.
  // Returns {appended, errors, latest_zpk}.
  //
  // The query joins ZWAMESSAGE → ZWACHATSESSION (for ZSESSIONTYPE used by
  // the classifier) and LEFT joins ZWAMESSAGE again to resolve
  // ZPARENTMESSAGE → parent ZSTANZAID for quoted-reply linkage.
  async pollOnce(opts = {}) {
    const limit = typeof opts.limit === "number" ? opts.limit : 1000;
    if (!existsSync(this.chatStoragePath)) {
      await this.tagError("chat_db_absent");
      return { appended: 0, errors: 1, latest_zpk: null };
    }

    let db;
    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch (err) {
      await this.tagError("sqlite_module_unavailable");
      return { appended: 0, errors: 1, latest_zpk: null };
    }

    try {
      db = new DatabaseSync(this.chatStoragePath, { readOnly: true });
    } catch (err) {
      await this.tagError("chat_db_open_failed");
      return { appended: 0, errors: 1, latest_zpk: null };
    }

    let appended = 0;
    let errors = 0;
    let latestZpk = null;
    // WU-C1-store-rebuild: also track the newest ZMESSAGEDATE (Core-Data
    // seconds) seen this batch so the cursor can persist last_message_date —
    // the anchor a FUTURE store-rebuild recovery uses instead of re-scanning
    // the ledger.
    let latestMsgDate = null;

    try {
      const cursor = (await this.readCursor()) || {};
      const lastZpk =
        Number.isInteger(cursor.last_zpk) ? cursor.last_zpk : 0;

      // WU-C1-store-rebuild — DETECT a Core-Data store rebuild that reset the
      // ZWAMESSAGE.Z_PK sequence. WhatsApp Desktop re-links / restores history
      // periodically; each rebuild assigns a NEW Z_METADATA.Z_UUID and re-seeds
      // Z_PK from a LOWER baseline. Our incremental cursor is a monotonic Z_PK
      // high-water (`WHERE m.Z_PK > last_zpk`), so a persisted last_zpk that is
      // now GREATER than the rebuilt store's MAX(Z_PK) matches ZERO rows
      // forever — silent, permanent data loss while --check reports healthy.
      //
      // Both reads are wrapped in their OWN try/catch that degrades to null,
      // mirroring the ZWAPROFILEPUSHNAME degrade below: the hermetic unit-test
      // fixture has neither Z_METADATA nor a rebuild, so dbUuid stays null and
      // (lastZpk=0) > (dbMaxZpk=8) is false → rebuilt=false → NORMAL path, and
      // the fixture's appended===8 / last_zpk===8 assertions still hold.
      let dbUuid = null;
      try {
        const r = db.prepare("SELECT Z_UUID AS u FROM Z_METADATA").get();
        if (r && typeof r.u === "string") dbUuid = r.u;
      } catch { dbUuid = null; }
      let dbMaxZpk = null;
      try {
        const r = db.prepare("SELECT MAX(Z_PK) AS m FROM ZWAMESSAGE").get();
        if (r && Number.isFinite(Number(r.m))) dbMaxZpk = Number(r.m);
      } catch { dbMaxZpk = null; }

      const prevUuid =
        typeof cursor.store_uuid === "string" ? cursor.store_uuid : null;
      const lastMsgDate =
        Number.isFinite(Number(cursor.last_message_date))
          ? Number(cursor.last_message_date)
          : null;

      // A rebuild is either (a) the store identity changed under a persisted
      // store_uuid, OR (b) the belt-and-suspenders clause that fires on THIS
      // host's already-stranded legacy cursor (last_zpk 23253 > MAX(Z_PK)
      // 15509) even though it predates the store_uuid field. (b) also catches
      // any future rebuild that happens to reuse the UUID.
      const rebuilt =
        (prevUuid != null && dbUuid != null && prevUuid !== dbUuid) ||
        (dbMaxZpk != null && lastZpk > dbMaxZpk);

      // The query. WhatsApp's ZMESSAGEDATE is Core Data seconds (float),
      // always within safe-integer regime, so no CAST AS TEXT precision
      // dance is required. ZMEDIATYPE lives on ZWAMEDIAITEM (joined via
      // ZMEDIAITEM FK). The LEFT JOIN to parent resolves quoted replies'
      // ZPARENTMESSAGE → ZSTANZAID for source-native linkage.
      // F-T2-WHATSAPP-F6 — surface ZSTARRED so the salience tier can boost
      // the row when the operator hit the in-app "star" affordance. Strongest
      // first-party signal currently invisible.
      //
      // WU-C1-store-rebuild: the SELECT + JOIN column list is IDENTICAL on both
      // the normal and recovery paths (downstream _buildLedgerRow depends on
      // every column). Only the WHERE / ORDER / bound value differ.
      //
      // wa-voice-stt: ZWAMEDIAITEM.ZMOVIEDURATION (seconds) feeds the STT audio
      // caps. Probe the column so a store (or fixture) without it degrades to
      // NULL instead of failing the prepare. The expression is one of two
      // constants, never caller data.
      let mediaDurationExpr = "NULL";
      try {
        const cols = db.prepare("PRAGMA table_info(ZWAMEDIAITEM)").all();
        if (cols.some((col) => col && col.name === "ZMOVIEDURATION")) {
          mediaDurationExpr = "media.ZMOVIEDURATION";
        }
      } catch { mediaDurationExpr = "NULL"; }
      const selectAndJoins = `
        SELECT
          m.Z_PK              AS zpk,
          m.ZSTANZAID         AS stanza_id,
          m.ZTEXT             AS text,
          m.ZISFROMME         AS is_from_me,
          m.ZMESSAGETYPE      AS message_type,
          m.ZGROUPEVENTTYPE   AS group_event_type,
          m.ZMESSAGEDATE      AS message_date,
          m.ZFROMJID          AS from_jid,
          m.ZTOJID            AS to_jid,
          m.ZSTARRED          AS starred,
          s.ZSESSIONTYPE      AS session_type,
          s.ZCONTACTJID       AS session_jid,
          s.ZPARTNERNAME      AS session_partner_name,
          parent.ZSTANZAID    AS parent_stanza_id,
          media.ZMEDIALOCALPATH AS media_local_path,
          media.ZMEDIAURL     AS media_url,
          media.ZTITLE        AS media_title,
          media.ZMETADATA     AS media_metadata,
          ${mediaDurationExpr} AS media_duration,
          gm.ZCONTACTNAME     AS member_contact_name,
          gm.ZFIRSTNAME       AS member_first_name,
          gm.ZMEMBERJID       AS member_jid
        FROM ZWAMESSAGE m
        LEFT JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION
        LEFT JOIN ZWAMESSAGE parent ON parent.Z_PK = m.ZPARENTMESSAGE
        LEFT JOIN ZWAMEDIAITEM media ON media.Z_PK = m.ZMEDIAITEM
        -- WU-wa-sender-names: resolve the GROUP-MESSAGE sender. For a @g.us
        -- message ZWAMESSAGE.ZGROUPMEMBER is the FK to the member row whose
        -- ZCONTACTNAME || ZFIRSTNAME is the sender display name and ZMEMBERJID
        -- is the sender's own jid. NULL for 1:1 (where the sender == from_jid).
        LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER
      `;

      // WU-C1-store-rebuild — pick the WHERE predicate.
      //   NORMAL   : monotonic Z_PK high-water.
      //   RECOVERY : a rebuilt store invalidates that ordering. Gate on
      //     ZMESSAGEDATE against the ledger's newest message with a boundary
      //     overlap, then paginate by (ZMESSAGEDATE, Z_PK). Do not adopt the
      //     rebuilt store's MAX(Z_PK) until that recovery range drains: LIMIT
      //     bounds work per poll, not the population the connector must retain.
      let sql;
      let queryBinds;
      let recoveryMessageDateFloor = null;
      let recoveryAfterMessageDate = null;
      let recoveryAfterZpk = null;
      if (rebuilt) {
        // Freeze the lower bound for the whole recovery. A later page must not
        // move its own floor by updating last_message_date. When an older state
        // has no floor, derive the anchor by streaming the source ledger.
        recoveryMessageDateFloor = Number.isFinite(
          Number(cursor.recovery_message_date_floor),
        )
          ? Number(cursor.recovery_message_date_floor)
          : null;
        if (recoveryMessageDateFloor == null) {
          let anchor = lastMsgDate;
          if (anchor == null) {
            const { streamLedgerLines } = await import(
              "../synthesis/_ledger-stream.js"
            );
            let maxDate = null;
            streamLedgerLines(this.sourceLedgerPath, (row) => {
              if (
                row && row.source === SOURCE && row.raw_content &&
                Number.isFinite(Number(row.raw_content.message_date_coredata))
              ) {
                const v = Number(row.raw_content.message_date_coredata);
                if (maxDate == null || v > maxDate) maxDate = v;
              }
            });
            anchor = maxDate != null ? maxDate : 0;
          }
          recoveryMessageDateFloor = anchor - 60;
        }
        recoveryAfterMessageDate = Number.isFinite(
          Number(cursor.recovery_after_message_date),
        )
          ? Number(cursor.recovery_after_message_date)
          : recoveryMessageDateFloor;
        recoveryAfterZpk = Number.isFinite(Number(cursor.recovery_after_zpk))
          ? Number(cursor.recovery_after_zpk)
          : -1;
        sql = selectAndJoins + `
        WHERE CAST(m.ZMESSAGEDATE AS REAL) > ?
          AND (
            CAST(m.ZMESSAGEDATE AS REAL) > ?
            OR (
              CAST(m.ZMESSAGEDATE AS REAL) = ?
              AND m.Z_PK > ?
            )
          )
        ORDER BY m.ZMESSAGEDATE ASC, m.Z_PK ASC
        LIMIT ?
      `;
        queryBinds = [
          recoveryMessageDateFloor,
          recoveryAfterMessageDate,
          recoveryAfterMessageDate,
          recoveryAfterZpk,
        ];
      } else {
        sql = selectAndJoins + `
        WHERE m.Z_PK > ?
        ORDER BY m.Z_PK ASC
        LIMIT ?
      `;
        queryBinds = [lastZpk];
      }

      let stmt;
      try {
        stmt = db.prepare(sql);
      } catch (err) {
        await this.tagError("chat_db_query_prepare_failed");
        return { appended: 0, errors: 1, latest_zpk: null };
      }

      let rows;
      try {
        rows = stmt.all(...queryBinds, limit);
      } catch (err) {
        await this.tagError("chat_db_query_run_failed");
        return { appended: 0, errors: 1, latest_zpk: null };
      }

      // FORWARD NAME CAPTURE (WU-whatsapp-name-recovery). Load the
      // ZWAPROFILEPUSHNAME (ZJID -> ZPUSHNAME) cache ONCE for this batch so a
      // phone-only session (where ZPARTNERNAME is just a formatted number) can
      // still be stamped with the sender's self-set push name. Defensive: a
      // host whose ChatStorage predates this table degrades to {} and the row
      // falls back to ZPARTNERNAME / the JID. The map is read-only.
      let pushByJid = new Map();
      try {
        const pushRows = db
          .prepare("SELECT ZJID AS jid, ZPUSHNAME AS push FROM ZWAPROFILEPUSHNAME")
          .all();
        for (const pr of pushRows) {
          if (typeof pr.jid === "string" && typeof pr.push === "string") {
            pushByJid.set(pr.jid, pr.push);
          }
        }
      } catch {
        pushByJid = new Map(); // no pushname table — degrade to ZPARTNERNAME.
      }

      // wa-voice-stt Phase A — build every row of the batch before any append,
      // stopping at the first build failure (the append loop below then stops
      // there too, exactly where the old build-inside-the-loop did). Voice
      // candidates among the built rows get ONE transcribeBatch call; ok
      // transcripts are applied in-band before append. Nothing here touches
      // the cursor variables.
      const built = [];
      let buildFailed = false;
      for (const dbRow of rows) {
        try {
          built.push(this._buildLedgerRow(dbRow, pushByJid));
        } catch {
          buildFailed = true;
          break;
        }
      }
      const vs = readVoiceState(cursor);
      const prevVoiceBackoff = readVoiceBackoff(cursor);
      let voiceOutcomes = new Map();
      let inBand = null;
      if (this.voice.enabled) {
        try {
          inBand = await this._voiceInBand(rows, built, vs, prevVoiceBackoff);
          voiceOutcomes = inBand.outcomes;
        } catch {
          voiceOutcomes = new Map(); // STT must never fail the poll
        }
      }
      // Per built index: did appendLedgerRow really write the row? An ok
      // in-band transcript on a deduped row never reached the ledger.
      const appendedByIndex = new Map();
      // Per built index: a deduped row whose ledger copy (looked up at dedup
      // time, before later appends shift the tail window) already carries its
      // in-band transcript — a crash replay, so the settle is ok, not
      // dedup_inband.
      const inbandInLedger = new Map();

      // Phase B — the append loop. Cursor logic unchanged.
      let processedRows = 0;
      let rowProcessingFailed = false;
      for (const dbRow of rows.slice(0, built.length)) {
        try {
          const stamped = built[processedRows];
          const result = await this.appendLedgerRow(stamped);
          if (result.appended !== true && voiceOutcomes.get(processedRows)?.ok) {
            try {
              const prev = this._findLedgerRowInTail(stamped.source_msg_id);
              const prc = prev && prev.raw_content;
              if (prc && prc.text_origin === "stt"
                  && typeof prc.text === "string" && prc.text.trim() !== "") {
                inbandInLedger.set(processedRows, true);
              }
            } catch { /* lookup failure: falls back to dedup_inband */ }
          }
          if (result.appended) appended += 1;
          appendedByIndex.set(processedRows, result.appended === true);
          // Track the Z_PK + message_date high-water over ALL seen rows
          // (appended AND deduped), so a boundary-overlap row that dedups
          // still advances the cursor past itself.
          if (Number.isFinite(Number(dbRow.zpk))) {
            const n = Number(dbRow.zpk);
            if (latestZpk == null || n > latestZpk) latestZpk = n;
          }
          if (Number.isFinite(Number(dbRow.message_date))) {
            const d = Number(dbRow.message_date);
            if (latestMsgDate == null || d > latestMsgDate) latestMsgDate = d;
          }
          if (rebuilt) {
            recoveryAfterMessageDate = Number(dbRow.message_date);
            recoveryAfterZpk = Number(dbRow.zpk);
          }
          processedRows += 1;
        } catch (err) {
          errors += 1;
          rowProcessingFailed = true;
          // Preserve fail-soft polling, but stop at the failed row. Continuing
          // would let a later success move the cursor past a row never appended.
          break;
        }
      }
      if (buildFailed && !rowProcessingFailed) {
        errors += 1;
        rowProcessingFailed = true;
      }

      // Settle voice outcomes for rows that actually reached the ledger. A row
      // past a failure is re-read next poll, so its outcome is discarded. An
      // ok transcript whose row deduped (appended:false) is NOT done: it parks
      // as dedup_inband and the late path below emits its "#stt" row.
      if (voiceOutcomes.size > 0) {
        const nowIso = this._serverTs();
        const rev0 = vs.rev;
        for (const [i, o] of voiceOutcomes) {
          if (i >= processedRows) continue;
          const settled = o.ok && appendedByIndex.get(i) !== true
            && inbandInLedger.get(i) !== true
            ? { zpk: o.zpk, stanza: o.stanza, ok: false, reason: "dedup_inband" }
            : o;
          voiceOutcomes.set(i, settled);
          this._voiceSettle(vs, settled, nowIso);
        }
        if (inBand) this._voiceCommitBatch(vs, inBand.batch, rev0, inBand.results);
      }
      // Late path for previously parked jobs (not the ones parked just now,
      // except dedup_inband, whose "#stt" row is emitted in this same tick).
      if (this.voice.enabled) {
        const skip = new Set([...voiceOutcomes.values()]
          .filter((o) => o.reason !== "dedup_inband")
          .map((o) => o.stanza));
        try {
          await this._voiceLatePath(db, selectAndJoins, pushByJid, vs, skip);
        } catch { /* STT must never fail the poll; jobs stay pending */ }
      }

      // A short, fully processed recovery page proves the range drained. A
      // limit-sized page requires another poll because another row may exist.
      const recoveryComplete = rebuilt && errors === 0
        && processedRows === rows.length && rows.length < limit;
      if (recoveryComplete && dbMaxZpk != null) {
        latestZpk = dbMaxZpk;
      }

      let nextLastZpk = lastZpk;
      if (!rebuilt && latestZpk != null) {
        nextLastZpk = latestZpk;
      } else if (recoveryComplete && dbMaxZpk != null) {
        nextLastZpk = dbMaxZpk;
      }
      const nextRecovery = rebuilt && !recoveryComplete
        ? {
            recovery_message_date_floor: recoveryMessageDateFloor,
            recovery_after_message_date: recoveryAfterMessageDate,
            recovery_after_zpk: recoveryAfterZpk,
          }
        : {};
      const recoveryKeys = [
        "recovery_message_date_floor",
        "recovery_after_message_date",
        "recovery_after_zpk",
      ];
      const recoveryTupleChanged = recoveryKeys.some((key) =>
        Object.prototype.hasOwnProperty.call(cursor, key)
          !== Object.prototype.hasOwnProperty.call(nextRecovery, key)
        || cursor[key] !== nextRecovery[key]
      );
      // Store adoption alone is state maintenance, not capture progress.
      const cursorAdvanced = processedRows > 0
        && (nextLastZpk !== lastZpk || recoveryTupleChanged);

      // Poison-row STT backoff: remember the row this poll failed to process
      // so the next poll does not re-transcribe the rows at/after it; clear
      // it once a clean poll leaves last_zpk at or past it. Voice-only state.
      let nextVoiceBackoff = prevVoiceBackoff;
      if (this.voice.enabled) {
        const failedZpk = rowProcessingFailed ? Number(rows[processedRows]?.zpk) : NaN;
        if (Number.isInteger(failedZpk)) {
          nextVoiceBackoff = failedZpk;
        } else if (!rowProcessingFailed && nextVoiceBackoff != null
                   && nextLastZpk >= nextVoiceBackoff) {
          nextVoiceBackoff = null;
        }
      }
      const voiceBackoffChanged = nextVoiceBackoff !== prevVoiceBackoff;
      const withVoiceBackoff = (state) => {
        if (nextVoiceBackoff != null) state.voice_backoff_zpk = nextVoiceBackoff;
        else delete state.voice_backoff_zpk;
        return state;
      };

      // Persist on a rebuild (to adopt the new store identity even if 0 rows
      // appended) OR whenever the cursor advanced. Spread ...cursor first so
      // name_label_map and every other prior field survive intact.
      if (rebuilt || latestZpk != null) {
        const ts = this._serverTs();
        const nextState = {
          ...cursor,
          store_uuid:
            dbUuid != null && (!rebuilt || recoveryComplete)
              ? dbUuid
              : cursor.store_uuid,
          last_message_date:
            latestMsgDate != null ? latestMsgDate : lastMsgDate,
          last_appended_ts:
            appended > 0 ? ts : cursor.last_appended_ts,
        };
        if (cursorAdvanced) {
          Object.assign(nextState, {
            last_cursor_advance_ts: ts,
          });
        }
        if (nextLastZpk !== lastZpk) {
          nextState.last_zpk = nextLastZpk;
        }
        if (Object.keys(nextRecovery).length > 0) {
          Object.assign(nextState, nextRecovery);
        } else {
          delete nextState.recovery_message_date_floor;
          delete nextState.recovery_after_message_date;
          delete nextState.recovery_after_zpk;
        }
        // Voice fields are merged onto a FRESH cursor read (a concurrent
        // backfillVoice may have written since `cursor` was read), never
        // carried from the stale spread above. Voice keys only.
        const freshVoice = (await this.readCursor()) || {};
        if (vs.changed) {
          Object.assign(nextState, voiceStateFields(mergeVoiceState(freshVoice, vs)));
        } else {
          for (const k of VOICE_STATE_KEYS) {
            if (Object.prototype.hasOwnProperty.call(freshVoice, k)) nextState[k] = freshVoice[k];
            else delete nextState[k];
          }
        }
        if (voiceBackoffChanged) withVoiceBackoff(nextState);
        await this.writeCursor(nextState);
      } else if (vs.changed || voiceBackoffChanged) {
        // Voice-only change (e.g. a late-path-only tick): merge the voice keys
        // alone. No cursor, append or advance timestamp is touched here.
        const merged = { ...((await this.readCursor()) || {}) };
        if (vs.changed) Object.assign(merged, voiceStateFields(mergeVoiceState(merged, vs)));
        await this.writeCursor(withVoiceBackoff(merged));
      }
      if (rowProcessingFailed) {
        // Error telemetry must never turn a row-local failure into a poll throw.
        try { await this.tagError("chat_db_row_processing_failed"); } catch {}
      }
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }

    return { appended, errors, latest_zpk: latestZpk };
  }

  // Build a ledger row from a raw ZWAMESSAGE join row. ConnectorBase stamps
  // source_policy via the sourcePolicyForRow closure; semantic fields remain
  // additive when a classifier has direct evidence for them.
  _buildLedgerRow(dbRow, pushByJid) {
    const classified = classifyRow({
      is_from_me: dbRow.is_from_me,
      session_type: dbRow.session_type,
    });

    const messageType = Number.isInteger(dbRow.message_type)
      ? dbRow.message_type
      : (dbRow.message_type != null ? Number(dbRow.message_type) : 0);
    const groupEventType = Number.isInteger(dbRow.group_event_type)
      ? dbRow.group_event_type
      : (dbRow.group_event_type != null ? Number(dbRow.group_event_type) : 0);
    const sessionType = Number.isInteger(dbRow.session_type)
      ? dbRow.session_type
      : (dbRow.session_type != null ? Number(dbRow.session_type) : null);
    const text = typeof dbRow.text === "string" && dbRow.text.length > 0
      ? dbRow.text : null;
    const mediaLocalPath = typeof dbRow.media_local_path === "string"
      && dbRow.media_local_path !== ""
      ? dbRow.media_local_path : null;
    const mediaUrl = typeof dbRow.media_url === "string"
      && dbRow.media_url !== ""
      ? dbRow.media_url : null;
    const mediaTitle = typeof dbRow.media_title === "string"
      && dbRow.media_title !== ""
      ? dbRow.media_title : null;
    const hasMedia = mediaLocalPath != null;
    // wa-voice-stt: ZMOVIEDURATION seconds, finite number or null.
    // Stamped only when finite, so non-media rows keep their pre-STT shape.
    const mediaDurationRaw = dbRow.media_duration != null ? Number(dbRow.media_duration) : NaN;

    // F-T2-WHATSAPP-F6 — surface ZSTARRED=1 as a top-level boolean so the
    // Stage-0 module + the downstream salience tier can read it without
    // re-querying the DB. Any non-1 value (NULL/0) → false.
    const starred = dbRow.starred === 1 || dbRow.starred === true;

    // Derive an identifier-body marker from observable row shape. Keep the
    // legacy marker as an alias for Stage-0 consumers that still read it.
    const identifierBodyPlaceholder =
      isWhatsAppIdentifierBodyPlaceholder({
        message_type: messageType,
        text,
      });
    const lowSignalMessageType = identifierBodyPlaceholder;

    // FORWARD NAME CAPTURE (WU-whatsapp-name-recovery). Stamp the human-readable
    // thread label at connector time so NEW rows carry it FORWARD — the
    // conversation-index / salience layers no longer need to re-query
    // ChatStorage for these rows. Resolution mirrors the recovery module:
    //   1. ZWACHATSESSION.ZPARTNERNAME (group subject for @g.us; contact name
    //      for 1:1) when it is a real name (not a formatted phone string).
    //   2. ZWAPROFILEPUSHNAME[session_jid] fallback for phone-only sessions.
    //   3. otherwise null (downstream falls back to the session_jid).
    // session_partner_name preserves the RAW ZPARTNERNAME verbatim (forensic);
    // session_label is the RESOLVED human label (null when only a phone string).
    // These are PII and live only in the local derived ledger.
    const sessionJid = typeof dbRow.session_jid === "string" ? dbRow.session_jid : null;
    const partnerNameRaw =
      typeof dbRow.session_partner_name === "string" && dbRow.session_partner_name.length > 0
        ? dbRow.session_partner_name
        : null;
    let sessionLabel = null;
    if (partnerNameRaw != null && isResolvedName(partnerNameRaw)) {
      sessionLabel = partnerNameRaw.replace(/\s+/g, " ").trim();
    } else if (sessionJid != null && pushByJid instanceof Map) {
      const push = pushByJid.get(sessionJid);
      if (typeof push === "string" && isResolvedName(push)) {
        sessionLabel = push.replace(/\s+/g, " ").trim();
      }
    }

    // WU-wa-sender-names — resolve WHO sent this message, FORWARD-stamped onto
    // the source row so recall can surface the sender without re-opening the DB.
    //   group inbound : sender_jid = ZMEMBERJID,
    //                   sender_name = ZCONTACTNAME || ZFIRSTNAME || pushname
    //   1:1 inbound   : sender_jid = from_jid, sender_name = session_label
    //   outbound (me) : sender_jid = "user", sender_name = "user"
    // resolveSenderForRow is the SAME pure resolver the derived backfill index
    // uses, so the forward + backward sender descriptors never drift. The
    // session_label resolved above is passed through for the 1:1 inbound name.
    const { sender_jid: senderJid, sender_name: senderName } = resolveSenderForRow(
      {
        is_from_me: dbRow.is_from_me,
        from_jid: typeof dbRow.from_jid === "string" ? dbRow.from_jid : null,
        session_type: sessionType,
        session_label: sessionLabel,
        member_contact_name:
          typeof dbRow.member_contact_name === "string" ? dbRow.member_contact_name : null,
        member_first_name:
          typeof dbRow.member_first_name === "string" ? dbRow.member_first_name : null,
        member_jid: typeof dbRow.member_jid === "string" ? dbRow.member_jid : null,
      },
      { pushByJid: pushByJid instanceof Map ? pushByJid : undefined },
    );

    const rawContent = {
      text,
      from_jid: typeof dbRow.from_jid === "string" ? dbRow.from_jid : null,
      to_jid: typeof dbRow.to_jid === "string" ? dbRow.to_jid : null,
      session_jid: sessionJid,
      session_partner_name: partnerNameRaw,
      session_label: sessionLabel,
      // WU-wa-sender-names: the resolved sender of THIS message. sender_jid is
      // the member jid for groups / the partner jid for 1:1 / "user" for
      // outbound; sender_name is the human display name (null when unresolved).
      sender_jid: senderJid,
      sender_name: senderName,
      is_from_me: dbRow.is_from_me === 1 || dbRow.is_from_me === true ? 1 : 0,
      message_type: messageType,
      group_event_type: groupEventType,
      session_type: sessionType,
      message_date_coredata: dbRow.message_date != null
        ? Number(dbRow.message_date) : null,
      has_media: hasMedia,
      media_local_path: mediaLocalPath,
      media_url: mediaUrl,
      media_title: mediaTitle,
      ...(Number.isFinite(mediaDurationRaw) ? { media_duration_s: mediaDurationRaw } : {}),
      starred,
      low_signal_message_type: lowSignalMessageType,
      identifier_body_placeholder: identifierBodyPlaceholder,
    };
    // Prefer the relational parent when present; otherwise attempt the narrow,
    // fail-soft contextInfo extraction. Two keys, deliberately: `reply_to` is
    // the CANONICAL cross-source
    // attribution key telegram already emits and recall already surfaces
    // (rather than minting a fourth per-source spelling beside telegram
    // reply_to / imessage in_reply_to / thread_originator_guid), and
    // `parent_stanza_id` is the source-native forensic alias, retained so
    // the canonical-block name and any existing forensic reader keep
    // working. Non-empty-string test mirrors classifyRow's own check, so an
    // empty ZSTANZAID is absent rather than present-and-falsy — no key is
    // ever written as null/undefined.
    const relationalParent = typeof dbRow.parent_stanza_id === "string"
      && dbRow.parent_stanza_id !== ""
      ? dbRow.parent_stanza_id
      : null;
    const metadataParent = relationalParent == null
      ? extractQuotedStanzaId(dbRow.media_metadata)
      : null;
    const replyTo = relationalParent || metadataParent;
    if (replyTo != null) {
      rawContent.reply_to = replyTo;
      rawContent.parent_stanza_id = replyTo;
    }

    // parties[]: outbound → ["user", to_jid]; inbound → [sender, "user"].
    // WU-wa-sender-names: the inbound party is now the RESOLVED sender_jid
    // (the group MEMBER jid for a @g.us message, not the group jid), falling
    // back to from_jid when the sender could not be resolved (1:1 / no member
    // join). This is the fact-surface recall reads for "who said it".
    const inboundParty = senderJid != null && senderJid !== SELF_PARTY
      ? senderJid
      : rawContent.from_jid;
    const parties = rawContent.is_from_me
      ? [SELF_PARTY, rawContent.to_jid].filter((p) => p != null)
      : [inboundParty, SELF_PARTY].filter((p) => p != null);

    // ts comes from ZMESSAGEDATE so the salience layer sees authoring time,
    // not ingest time. Fall back to server time if the date is unparseable.
    const messageTs = coreDataSecondsToIso(dbRow.message_date) || this._serverTs();

    // source_msg_id is ZSTANZAID — WhatsApp's XMPP-style stable stanza id.
    // Fallback to "zpk:<n>" only if stanza id is somehow missing (defensive;
    // real ChatStorage.sqlite always populates ZSTANZAID).
    const sourceMsgId = typeof dbRow.stanza_id === "string"
      && dbRow.stanza_id !== ""
      ? dbRow.stanza_id
      : `zpk:${dbRow.zpk}`;

    const row = {
      ts: messageTs,
      source_msg_id: sourceMsgId,
      parties,
      raw_content: rawContent,
      attachments: hasMedia
        ? [{ kind: "whatsapp_media", local_path: mediaLocalPath, title: mediaTitle }]
        : [],
    };
    if (classified.kind) row.kind = classified.kind;
    if (classified.derived_from) row.derived_from = classified.derived_from;
    return row;
  }

  // runOnce — single poll loop. Returns aggregated stats.
  async runOnce(opts = {}) {
    const result = await this.pollOnce(opts);
    return { appended: result.appended, errors: result.errors };
  }

  // runForever — never resolves. Polls every configured interval.
  async runForever(opts = {}) {
    const interval = opts.intervalMs || defaultPollIntervalMs();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await this.pollOnce(opts);
      } catch (err) {
        try { await this.tagError("poll_unexpected_throw"); } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  // backfillVoice — enrich voice rows ALREADY in the source ledger with "#stt"
  // enrichment rows. Streams the ledger line by line; only lines carrying the
  // exact `"message_type":3,` token are parsed, and the parsed value must be
  // the integer 3 (so 32/34 never qualify). Returns counts only:
  //   {candidates, transcribed, skipped: {reason: count}}
  // candidates = distinct voice parent rows; transcribed + sum(skipped) ==
  // candidates. Transcript text is never returned, logged or stored in state.
  async backfillVoice({ ledgerPath } = {}) {
    const { streamLedgerLinesWithOffset } = await import("../synthesis/_ledger-stream.js");
    const src = ledgerPath || this.sourceLedgerPath;
    const cursor = (await this.readCursor()) || {};
    const vs = readVoiceState(cursor);
    const done = new Set(vs.done);
    const sttParents = new Set();
    const parents = new Map();
    streamLedgerLinesWithOffset(src, (line) => {
      const maybeStt = line.includes('#stt"');
      if (!maybeStt && !line.includes('"message_type":3,')) return;
      let row;
      try { row = JSON.parse(line); } catch { return; }
      if (!row || typeof row.source_msg_id !== "string" || row.source_msg_id === "") return;
      if (row.source != null && row.source !== SOURCE) return;
      if (row.source_msg_id.endsWith("#stt")) {
        sttParents.add(row.source_msg_id.slice(0, -4));
        return;
      }
      if (!row.raw_content || row.raw_content.message_type !== 3) return;
      if (!parents.has(row.source_msg_id)) parents.set(row.source_msg_id, row);
    });

    const skipped = {};
    const skip = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };
    let transcribed = 0;
    const queue = [];
    for (const [sid, row] of parents) {
      const rc = row.raw_content;
      // A transcript already in the ledger (a "#stt" row or the row's own
      // text) is reported as such; voice_done then only names rows marked done
      // with neither, so it can never mask a missing transcript.
      if (sttParents.has(sid)) { skip("stt_exists"); continue; }
      if (typeof rc.text === "string" && rc.text.trim() !== "") { skip("has_text"); continue; }
      if (done.has(sid)) { skip("voice_done"); continue; }
      const policyConsent = row.source_policy && typeof row.source_policy.consent_basis === "string"
        ? row.source_policy.consent_basis
        : classifyRow(rc).consent_basis;
      if (!isVoiceCandidate(rc, policyConsent, { allowedConsent: this.voice.consent })) {
        skip("not_eligible");
        continue;
      }
      queue.push({
        parent: { ts: row.ts, source_msg_id: sid, parties: row.parties, raw_content: rc },
        consent: policyConsent,
        job: { id: sid, rawContent: rc, durationS: rc.media_duration_s, consentBasis: policyConsent },
      });
    }

    const settle = (sid) => {
      vs.pending = vs.pending.filter((e) => e.stanza !== sid);
      if (!vs.done.includes(sid)) vs.done.push(sid);
      markVoiceChanged(vs);
    };
    while (queue.length > 0) {
      // Chunk by count and by known duration so batch_cap is the exception;
      // a batch_cap job goes back to the queue (the first job of a chunk
      // always fits, so this terminates).
      const chunk = [];
      let audio = 0;
      while (queue.length > 0 && chunk.length < VOICE_BACKFILL_BATCH_MAX) {
        const d = Number(queue[0].job.durationS);
        const est = Number.isFinite(d) && d > 0 ? d : 0;
        if (chunk.length > 0 && audio + est > MAX_BATCH_AUDIO_S) break;
        audio += est;
        chunk.push(queue.shift());
      }
      let results;
      let batch = null;
      if (this._voicePaused()) {
        results = chunk.map(() => ({ ok: false, reason: "paused" }));
      } else {
        ({ results, batch } = await this._runVoiceBatch(chunk.map((c) => c.job)));
      }
      const rev0 = vs.rev;
      for (let k = 0; k < chunk.length; k += 1) {
        const c = chunk[k];
        const r = results ? results[k] : null;
        if (r && r.ok) {
          let enrichment;
          try {
            enrichment = buildEnrichmentRow(c.parent, r, {
              consentBasis: c.consent,
              allowedConsent: this.voice.consent,
            });
          } catch {
            skip("consent_mismatch");
            continue;
          }
          let res;
          try {
            res = await this.appendLedgerRow(enrichment);
          } catch {
            skip("append_failed");
            continue;
          }
          settle(c.job.id);
          if (res && res.appended) transcribed += 1;
          else skip("stt_exists");
        } else {
          const reason = r && r.reason ? r.reason : "stt_error";
          if (reason === "batch_cap" && chunk.length > 1) { queue.push(c); continue; }
          skip(reason);
        }
      }
      this._voiceCommitBatch(vs, batch, rev0, results);
    }

    if (vs.changed) {
      // Same voice-only merge as pollOnce: no cursor or advance timestamps;
      // per-stanza merge onto the fresh cursor so a poll that wrote while
      // this backfill ran loses nothing.
      const fresh = (await this.readCursor()) || {};
      await this.writeCursor({
        ...fresh,
        ...voiceStateFields(mergeVoiceState(fresh, vs)),
      });
    }
    return { candidates: parents.size, transcribed, skipped };
  }
}

// ---------------------------------------------------------------------------
// CLI shim — launchd entry point + operator probes
// ---------------------------------------------------------------------------

const isMain = import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const mode = process.argv[2];
  if (mode === "--check") {
    // F-T2-WHATSAPP-F10 — actually open ChatStorage.sqlite read-only and
    // probe ZWAMESSAGE with SELECT 1. This catches Full Disk Access denial
    // and wrong-path mis-config at startup rather than silently months
    // later when nothing has been ingested. The probe never writes.
    //
    // Failure modes are surfaced as "check_failed: <code>\n" on stdout so
    // launchd / health-check tooling can grep without parsing stderr.
    (async () => {
      const path = defaultChatStoragePath();
      if (!existsSync(path)) {
        process.stdout.write("check_failed: chat_db_absent\n");
        process.exit(1);
      }
      let DatabaseSync;
      try {
        ({ DatabaseSync } = await import("node:sqlite"));
      } catch {
        process.stdout.write("check_failed: sqlite_module_unavailable\n");
        process.exit(1);
      }
      let db;
      try {
        db = new DatabaseSync(path, { readOnly: true });
      } catch (err) {
        const code = (err && (err.code || err.errno)) || "chat_db_open_failed";
        process.stdout.write(`check_failed: ${code}\n`);
        process.exit(1);
      }
      try {
        db.prepare("SELECT 1 FROM ZWAMESSAGE LIMIT 1").get();
      } catch (err) {
        const code =
          (err && (err.code || err.errno)) || "chat_db_query_run_failed";
        try { db.close(); } catch { /* ignore */ }
        process.stdout.write(`check_failed: ${code}\n`);
        process.exit(1);
      }
      try { db.close(); } catch { /* ignore */ }
      process.stdout.write("ok\n");
      process.exit(0);
    })();
  } else if (mode === "--backfill-voice") {
    // Prints ONLY the JSON count summary. Errors surface as a stable code on
    // stderr (no row content). Env overrides exist for operator dry runs and
    // hermetic tests: WHATSAPP_VOICE_MEDIA_ROOT, WHATSAPP_VOICE_PAUSE_FLAG,
    // WHATSAPP_STT_PYTHON, WHATSAPP_STT_SCRIPT, WHATSAPP_VOICE_TMP_DIR.
    const env = process.env;
    // One flag for both: the worker (GAMEPAUSE_FLAG) and the connector's
    // paused relabel read the same path. Order: WHATSAPP_VOICE_PAUSE_FLAG,
    // then GAMEPAUSE_FLAG, then no pause check (defaultPauseFlag() is null
    // when GAMEPAUSE_FLAG is unset or empty).
    const flagPath = env.WHATSAPP_VOICE_PAUSE_FLAG || defaultPauseFlag();
    const runnerOpts = { flagPath };
    if (env.WHATSAPP_STT_PYTHON) runnerOpts.venvPython = env.WHATSAPP_STT_PYTHON;
    if (env.WHATSAPP_STT_SCRIPT) runnerOpts.scriptPath = env.WHATSAPP_STT_SCRIPT;
    const c = new WhatsAppConnector({
      voice: {
        enabled: true,
        runner: defaultPythonRunner(runnerOpts),
        mediaRoot: env.WHATSAPP_VOICE_MEDIA_ROOT,
        flagPath,
        tmpDir: env.WHATSAPP_VOICE_TMP_DIR,
      },
    });
    c.backfillVoice().then((summary) => {
      process.stdout.write(JSON.stringify(summary) + "\n");
      process.exit(0);
    }).catch((err) => {
      const code = (err && (err.code || err.name)) || "backfill_voice_failed";
      process.stderr.write(`backfill_voice_failed: ${code}\n`);
      process.exit(1);
    });
  } else if (mode === "--once") {
    const c = new WhatsAppConnector({});
    c.runOnce().then((r) => {
      process.stdout.write(JSON.stringify(r) + "\n");
      process.exit(0);
    }).catch((err) => {
      process.stderr.write(`runOnce error: ${err?.stack || err}\n`);
      process.exit(1);
    });
  } else {
    const c = new WhatsAppConnector({});
    c.runForever().catch((err) => {
      process.stderr.write(`runForever error: ${err?.stack || err}\n`);
      process.exit(1);
    });
  }
}
