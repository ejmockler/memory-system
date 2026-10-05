// telegram.js — R38 Phase 2c Telegram source-tier connector.
//
// Tails the Python helper's staging file (default
// <MEMORY_ROOT>/storage/tmp/telegram-staging.jsonl) using a UTF-16 code-unit cursor, normalises each event into the canonical
// source-row shape, runs Stage-0 hard-drops, and appends to
// storage/sources/telegram.jsonl via the shared ConnectorBase.
//
// CURSOR UNITS — WARNING: state.json's staging_offset indexes the utf8-DECODED
// JavaScript string (readFileSync(this.stagingFile, "utf8") in pollOnce), i.e.
// UTF-16 code units — NOT bytes. Byte arithmetic on it (dd/truncate/seek at
// that offset) is INVALID and will corrupt the tail position: measured on the
// real staging file 2026-07-10, 5,612,615 bytes vs 5,580,471 code units — a
// 32,144-unit divergence — while the live staging_offset equalled the
// code-unit length exactly.
//
// Architecture
// ------------
// The Python helper at mcp/lib/connectors/telegram/telegram_tail.py owns the
// MTProto subscription (Telethon). It writes one JSONL line per event to the
// staging file. This Node module is policy-agnostic over the wire format
// and only cares about the documented per-event JSON shape. Decoupling
// MTProto from Node lets future Telegram API churn land entirely on the
// Telethon side.
//
// Per-row dedup is source_msg_id-based via the base class's bounded tail
// read. source_msg_id is deterministic:
//     source_msg_id = sha256("tg:" + peer_id + ":" + message_id)
// truncated to 32 hex chars (matches the chat-* shape we already use). Net
// effect: a replay of the staging file emits zero new rows on disk.
//
// Per-kind consent_basis (Phase A § Schema per source):
//   user        -> first_party     (1:1 DM; treat both directions as op-owned)
//   group       -> first_party     (outgoing) | third_party_inferred (others)
//   supergroup  -> first_party     (outgoing) | third_party_inferred (others)
//   channel     -> public_observation
//
// HERMETICITY: TELEGRAM_STAGING_FILE env var (default
// <MEMORY_ROOT>/storage/tmp/telegram-staging.jsonl) is the single override point. Tests override + mkdtempSync. Production
// <MEMORY_ROOT>/storage/sources/telegram.jsonl is never written
// by tests because MEMORY_ROOT redirects to TEST_ROOT.
//
// KEY_LEAKAGE_ZERO: the session string lives in the Python helper's env
// only; this module never touches it. Per-row tagError uses enumerated kind
// codes (parse_error, append_error, staging_read_error); no operator dialog
// text reaches stderr.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { ConnectorBase } from "./index.js";
import { MEMORY_ROOT } from "../config.js";
import { CAPS } from "../validation.js";
import { serverTs } from "../envelope.js";
import { stage0 as telegramStage0 } from "../ingest/stage0/telegram.js";

const SOURCE = "telegram";

// Staging file the Python helper writes to. Operator-overridable for tests.
// The default sits under the data root (git-ignored storage/), because the
// file holds message text. It is built from MEMORY_ROOT, not STORAGE_DIR, so
// STORAGE_BASE_DIR cannot make this reader diverge from the writers
// (telegram_tail.py, daemons/telegram-tail-run.sh), which know MEMORY_ROOT only.
export function defaultStagingFile() {
  const env = process.env.TELEGRAM_STAGING_FILE;
  if (typeof env === "string" && env !== "") return env;
  return join(MEMORY_ROOT, "storage", "tmp", "telegram-staging.jsonl");
}

// Per-poll bound on lines processed. A long-running session can backfill
// thousands of stored messages on first attach; we chunk them so the cursor
// advances incrementally.
const POLL_LINE_HARD_CAP = 2000;

// =============================================================================
// Consent classifier
// =============================================================================

// classifyConsent: encode the Phase A consent table. Pure function over the
// per-event peer_type + is_outgoing pair.
export function classifyConsent({ peer_type, is_outgoing, is_self }) {
  if (peer_type === "channel") {
    // Broadcast channels are public-observation regardless of who posted.
    return "public_observation";
  }
  if (peer_type === "user") {
    // 1:1 DM: operator is one of the two parties; treat both directions as
    // first_party for the operator's own view (same discipline as imessage
    // is_from_me=1 + the post-R20 brutalist C1 ratification for two-party DMs).
    return "first_party";
  }
  // group / supergroup
  if (is_outgoing || is_self) return "first_party";
  return "third_party_inferred";
}

// =============================================================================
// TelegramConnector
// =============================================================================

export class TelegramConnector extends ConnectorBase {
  constructor(opts = {}) {
    const {
      stagingFile,
      now,
      sourceLedgerPath,
      cursorPath,
    } = opts;

    function sourcePolicyForRow(row) {
      // The per-row consent_basis was already resolved at row-build time and
      // stamped onto raw_content._consent_basis as a hint to the classifier
      // closure. We honour it verbatim; the row.kind/parties shape downstream
      // never reads this transient field.
      const hint = row && row.raw_content && row.raw_content._consent_basis;
      const cb = typeof hint === "string" && hint !== "" ? hint : "first_party";
      return {
        deletion_semantics: "full_excise",
        consent_basis: cb,
      };
    }

    super({
      source: SOURCE,
      sourceLedgerPath,
      cursorPath,
      sourcePolicyForRow,
    });

    this.stagingFile = stagingFile || defaultStagingFile();
    this._now = typeof now === "function" ? now : serverTs;
  }

  // ---------------------------------------------------------------------------
  // pollOnce — read new UTF-16 code units from the staging file + normalise + append.
  // ---------------------------------------------------------------------------

  async pollOnce() {
    const state = (await this.readCursor()) || {};
    const startOffset = Number.isInteger(state.staging_offset) && state.staging_offset >= 0
      ? state.staging_offset
      : 0;

    if (!existsSync(this.stagingFile)) {
      // Staging file absent is expected before the Python helper first
      // writes. Not an error — record a poll and return.
      const nowTs = this._now();
      await this.writeCursor({
        ...state,
        staging_offset: startOffset,
        last_polled_ts: nowTs,
        error_count: Number.isInteger(state.error_count) ? state.error_count : 0,
      });
      return { appended: 0, errors: 0, sessions: 0 };
    }

    let raw = "";
    try {
      raw = readFileSync(this.stagingFile, "utf8");
    } catch (err) {
      await this.tagError(err && err.code ? err.code : "staging_read_error");
      return { appended: 0, errors: 1, sessions: 0 };
    }

    // Defensive: if the file was truncated/rotated (it SHRANK below our
    // persisted watermark), the UTF-16 code unit at startOffset no longer
    // addresses the same logical position, so fall back to code unit 0 and
    // re-tail.
    //
    // CRITICAL (N12 re-append fix): the guard MUST be `startOffset > raw.length`,
    // NOT `startOffset < raw.length`. With the old `<` form, the steady-state
    // case where the cursor is fully caught up (startOffset === raw.length —
    // exactly what a healthy daemon persists after consuming every line)
    // failed the `<` test and silently reset offset to 0, re-reading the ENTIRE
    // staging file on every subsequent poll. The bounded source_msg_id dedup
    // (CAPS.CONNECTOR_DEDUP_TAIL_LINES tail-read) only covers the last N rows,
    // so on a multi-thousand-row ledger the head rows fell out of the window
    // and were RE-APPENDED as duplicates. A replay of an unchanged staging
    // file MUST append zero new rows; that invariant is what n12-*.test.mjs
    // proves. Equality (===) stays at startOffset so the partial-line tail and
    // the already-consumed tail are both correctly no-ops.
    let offset = startOffset > raw.length ? 0 : startOffset;

    let appendedCount = 0;
    let errorCount = 0;
    let lastAppendedTs = state.last_appended_ts || null;
    let lastAppendedId = state.last_appended_id || null;
    let linesProcessed = 0;

    let cursor = offset;
    while (cursor < raw.length && linesProcessed < POLL_LINE_HARD_CAP) {
      const nl = raw.indexOf("\n", cursor);
      if (nl === -1) {
        // Partial line at the tail — leave it for the next poll once newline lands.
        break;
      }
      const line = raw.slice(cursor, nl);
      const lineEnd = nl + 1;
      cursor = lineEnd;
      linesProcessed += 1;
      if (line === "") continue;

      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        errorCount += 1;
        await this.tagError("parse_error");
        offset = lineEnd; // skip the bad line
        continue;
      }
      if (!evt || typeof evt !== "object") {
        offset = lineEnd;
        continue;
      }

      const row = buildRow(evt);
      if (row == null) {
        offset = lineEnd;
        continue;
      }

      // Stage-0 hard drops. We probe BEFORE the expensive append so a DROP
      // short-circuits checksum + atomic-append.
      const probeEvent = {
        source: SOURCE,
        raw_content: row.raw_content,
      };
      const verdict = telegramStage0(probeEvent);
      if (verdict && verdict.decision === "DROP") {
        offset = lineEnd; // skip dropped event but advance cursor
        continue;
      }

      try {
        const res = await this.appendLedgerRow(row);
        if (res.appended) {
          appendedCount += 1;
          lastAppendedTs = this._now();
          lastAppendedId = res.id;
        }
        offset = lineEnd;
      } catch (err) {
        errorCount += 1;
        await this.tagError(err && err.code ? err.code : "append_error");
        // Do NOT advance offset on append failure — retry next tick.
        break;
      }
    }

    const nowTs = this._now();
    // B1 (task-hypergraph) fix: bump last_cursor_advance_ts ONLY when the
    // cursor genuinely advanced this poll (append OR skip-past progress, i.e.
    // offset moved off startOffset). The prior unconditional `nowTs` stamped
    // an advance on EVERY 30s poll even when nothing moved, which refreshed
    // the timestamp forever and defeated the connector-base staleness
    // classifier (index.js metadataFromState / _healthFromState compare
    // last_cursor_advance_ts against CONNECTOR_HEALTH_STALE_SECONDS) — telegram
    // could never go `stale`. last_polled_ts stays unconditional (it means
    // "we ran"); last_appended_ts (above) only moves on a real append.
    const cursorAdvanced = offset !== startOffset;
    const carriedAdvanceTs =
      typeof state.last_cursor_advance_ts === "string" ? state.last_cursor_advance_ts : null;
    const nextState = {
      ...state,
      staging_offset: offset,
      last_polled_ts: nowTs,
      last_appended_ts: lastAppendedTs,
      last_appended_id: lastAppendedId,
      last_cursor_advance_ts: cursorAdvanced ? nowTs : carriedAdvanceTs,
      error_count: Number.isInteger(state.error_count) ? state.error_count : 0,
    };
    const reloaded = (await this.readCursor()) || {};
    if (Number.isInteger(reloaded.error_count) && reloaded.error_count >= nextState.error_count) {
      nextState.error_count = reloaded.error_count;
      nextState.last_error_kind = reloaded.last_error_kind;
      nextState.last_error_ts = reloaded.last_error_ts;
    }
    await this.writeCursor(nextState);
    return { appended: appendedCount, errors: errorCount, sessions: 1 };
  }
}

// =============================================================================
// Helpers (module-private)
// =============================================================================

// computeSourceMsgId: sha256("tg:" + peer_id + ":" + message_id + ":" + edit_seq),
// truncated to 32 hex chars. Deterministic across re-runs of the same staging
// input.
//
// F-NEW-W3-TELEGRAM-F11-INCOMPLETE: edit_seq is folded into the preimage
// so MessageEdited events emit a distinct source_msg_id from the original
// NewMessage row. Pre-W3 the preimage was sha256("tg:"+peer_id+":"+message_id),
// which silently collided across edits — Telethon's MessageEdited fires
// after every edit, and the base-class source_msg_id dedup would skip
// every edit as a duplicate of the original. The edit_seq=0 default for
// NewMessage rows preserves backwards-compat for the on-disk ledger: the
// original sha256(...:0) hash differs from the pre-W3 sha256(...) hash,
// but any historical row stays addressable via its original id and the
// base class's tail-read still dedups correctly because the original
// row's source_msg_id is whatever was already on disk. New emissions
// after the W3 ship use the edit_seq-suffixed shape consistently.
export function computeSourceMsgId(peer_id, message_id, edit_seq) {
  const seqPart = Number.isFinite(edit_seq) ? String(edit_seq) : "0";
  const pre = `tg:${peer_id}:${message_id}:${seqPart}`;
  return "tg_" + createHash("sha256").update(pre).digest("hex").slice(0, 32);
}

// buildRow: normalise a Python-helper event into the canonical source-row
// shape. Returns null for events that lack a stable identity (peer_id or
// message_id missing) — the cursor still advances so we don't loop.
export function buildRow(evt) {
  const peer_id = typeof evt.peer_id === "number" || typeof evt.peer_id === "string"
    ? evt.peer_id
    : null;
  const message_id = typeof evt.message_id === "number" || typeof evt.message_id === "string"
    ? evt.message_id
    : null;
  if (peer_id == null || message_id == null) return null;

  const peer_type = typeof evt.peer_type === "string" ? evt.peer_type : "user";
  const text = typeof evt.text === "string" ? evt.text : "";
  const is_outgoing = !!evt.is_outgoing;
  const is_self = !!evt.is_self;

  const consent_basis = classifyConsent({ peer_type, is_outgoing, is_self });

  const senderName = typeof evt.sender_name === "string" ? evt.sender_name : null;
  const peerName = typeof evt.peer_name === "string" ? evt.peer_name : null;
  const parties = [];
  if (senderName) parties.push(senderName);
  if (peerName && peerName !== senderName) parties.push(peerName);

  // F-NEW-W3-TELEGRAM-F11-INCOMPLETE: edit awareness. The Python
  // telegram_tail.py emits is_edit + edit_seq on every record (0 for
  // NewMessage, >0 for MessageEdited). We stamp them on raw_content so
  // Stage-0 can give edits a salience floor (edits often refine content
  // rather than introducing noise) AND we fold edit_seq into
  // source_msg_id so each edit is a distinct ledger row instead of
  // colliding with the original via the bare sha256(peer_id||message_id)
  // shape.
  const isEdit = evt.is_edit === true;
  const editSeq =
    typeof evt.edit_seq === "number" && Number.isFinite(evt.edit_seq)
      ? evt.edit_seq
      : 0;
  const raw_content = {
    peer_type,
    peer_id,
    peer_name: peerName,
    message_id,
    sender_id: evt.sender_id ?? null,
    sender_name: senderName,
    is_outgoing,
    is_self,
    text,
    media_type: typeof evt.media_type === "string" ? evt.media_type : null,
    fwd_from: evt.fwd_from && typeof evt.fwd_from === "object" ? evt.fwd_from : null,
    reply_to: evt.reply_to ?? null,
    ttl_seconds: typeof evt.ttl_seconds === "number" ? evt.ttl_seconds : null,
    // F-NEW-W3-TELEGRAM-F11-INCOMPLETE — edit metadata. is_edit drives a
    // Stage-0 salience floor; edit_seq is the per-edit monotonic counter
    // used inside source_msg_id to keep edits as distinct rows.
    is_edit: isEdit,
    edit_seq: editSeq,
    // Internal hint consumed by sourcePolicyForRow; never embedded in the
    // checksum body because we strip it before stamping... no — it IS in the
    // checksum body because the row is canonicalised whole. That's fine: the
    // consent hint is a deterministic function of the other raw_content
    // fields so it never causes checksum drift on a replay.
    _consent_basis: consent_basis,
  };

  return {
    source_msg_id: computeSourceMsgId(peer_id, message_id, editSeq),
    ts: typeof evt.ts === "string" ? evt.ts : undefined,
    parties,
    raw_content,
    content: text,
  };
}

// =============================================================================
// CLI / daemon entry points
// =============================================================================

export async function runOnce(opts = {}) {
  const c = new TelegramConnector(opts);
  return c.pollOnce();
}

export async function runForever(opts = {}) {
  const intervalSec = Number.isInteger(opts.intervalSec) && opts.intervalSec > 0
    ? opts.intervalSec
    : 30;
  const c = new TelegramConnector(opts);
  for (;;) {
    try { await c.pollOnce(); }
    catch { /* tagError already invoked */ }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

export async function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--check")) {
    const c = new TelegramConnector();
    const h = c.reportHealth();
    process.stdout.write(JSON.stringify(h) + "\n");
    return 0;
  }
  if (args.includes("--once")) {
    const res = await runOnce();
    process.stdout.write(JSON.stringify(res) + "\n");
    return 0;
  }
  await runForever();
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`telegram fatal: ${err && err.stack ? err.stack : String(err)}\n`);
      process.exit(1);
    },
  );
}

// Test-only exports.
export const _internals = {
  classifyConsent,
  computeSourceMsgId,
  buildRow,
};

// Suppress unused-cap lint for CAPS — retained as the seam for an operator
// override of POLL_LINE_HARD_CAP via CAPS in a future round.
void CAPS;
void statSync;
