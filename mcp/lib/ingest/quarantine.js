// Quarantine layer for Stage-0 DROP'd rows.
//
// F-INFRA-QUARANTINE: every Stage-0 DROP becomes recoverable. Stage-0 modules
// MUST call quarantineRow() instead of irreversibly dropping a row. The row,
// the originating rule, and the timestamp are appended to a per-source daily
// JSONL at:
//
//     storage/quarantine/<source>/<YYYY-MM-DD>.jsonl
//
// Restoration re-emits the row to the source-ledger with restoration
// metadata stamped on top so downstream dedup knows the row is a recovery
// not a fresh ingest.
//
// RETENTION IS NOT WIRED UP — measured, not assumed. This header used to
// claim "recoverable for 30 days" and "A 30-day retention purge runs daily".
// Both were false. purgeExpiredQuarantine (defined below, currently :573) IS
// implemented and exported and DOES enforce a 30-day window when called — but
// nothing calls it. When this note was written, a repo-wide grep for the
// identifier returned four hits and ALL FOUR were inside this file (the
// export-list line above, the section banner, the definition, and the
// trailing lint note); the only references added since are the tests named at
// the bottom of this note. There is no production caller, no scheduler, no
// launchd/cron job. So today:
//
//   * quarantine retention is UNBOUNDED — nothing ever deletes a daily file;
//   * entries are recoverable INDEFINITELY, not for 30 days;
//   * the store grows monotonically for the lifetime of the install, and the
//     watermark daemon's default-off F-G1-WM-ERROR-ADVANCE flag adds a second
//     writer into it (daemons/watermark.js:2320-2334).
//
// OPERATOR ACTION REQUIRED (deliberately NOT performed here): schedule
// purgeExpiredQuarantine from the existing daily job surface. Wiring it into
// an ingestion daemon's tick instead was considered and rejected — a live
// daemon must not unlinkSync files as a tick side effect, and the scheduling
// decision belongs to the operator. The current no-reaper behavior is pinned
// by mcp/test/daemons/watermark-append-failure.test.mjs T6 (what the purge
// does when called) and T7 (that a watermark tick writes into quarantine and
// never reaps it), so wiring a purge anywhere goes red first and forces a
// deliberate decision.
//
// Public exports:
//   quarantineRow(row, reason, opts?)         — write a quarantine entry,
//                                                also call recordDrop()
//                                                telemetry so counters stay
//                                                accurate.
//   restoreFromQuarantine(source_msg_id, opts?) — locate the most recent
//                                                quarantine entry for the
//                                                given source_msg_id and
//                                                re-emit the row to the
//                                                source-ledger with
//                                                restoration metadata.
//   purgeExpiredQuarantine(opts?)             — delete daily files older
//                                                than 30 days. NOT CALLED BY
//                                                ANYTHING IN PRODUCTION; see
//                                                the retention note above.
//   listQuarantine({ source?, sinceDays?,
//                    limit? } = {})            — operator-facing audit read.
//   recordDrop(source, reason)                — increments an in-process
//                                                counter so callers that
//                                                bypass policy events still
//                                                have an accurate signal.
//
// Counters: an in-process Map keyed by (source, reason). Read via
// getDropCounters(). The counters survive only for the lifetime of the
// process; the durable signal is policy-events + the quarantine files.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";

import { STORAGE_DIR, sourceLedgerPath } from "../config.js";
import { canonicalJson } from "../validation.js";

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

// 30-day retention window — operator's restore SLO per F-INFRA-QUARANTINE
// expected_impact. Tuneable via env QUARANTINE_RETENTION_DAYS for tests.
const RETENTION_DAYS_DEFAULT = 30;
function retentionDays() {
  const env = process.env.QUARANTINE_RETENTION_DAYS;
  const n = env ? Number(env) : RETENTION_DAYS_DEFAULT;
  return Number.isFinite(n) && n > 0 ? n : RETENTION_DAYS_DEFAULT;
}

// Per-source daily file mode. 0o600 mirrors policy/storage conventions —
// quarantined rows can contain raw_content for OTP-pattern REDACT_DROP
// callers, so restrict to the owner.
const QUARANTINE_FILE_MODE = 0o600;
const QUARANTINE_DIR_MODE = 0o700;

// ----------------------------------------------------------------------------
// F-NEW-W2-CODEX-QUARANTINE-CHECKSUM-ID — quarantine-entry integrity stamping
// ----------------------------------------------------------------------------
//
// Stage-0 quarantine callers (e.g. codex-cli scaffold DROPs) hand quarantineRow
// a probe-shaped event that lacks `id` and `checksum` — those are stamped by
// ConnectorBase.appendLedgerRow at write-time, and the DROP path short-circuits
// before appendLedgerRow ever runs. Without backfilling id + checksum, the
// quarantine entry can only be located via source_msg_id and restoreFromQuarantine
// has no integrity signal to verify the recovered payload against.
//
// Per the node's "either (a) or (b)" choice, we pick (b): quarantineRow stamps
// the id and checksum on the row when missing. This keeps the connector hot
// path unchanged AND every other Stage-0 caller benefits without duplicating
// the stamping logic.
//
// id format: "ulid_" + 20-char alphanumeric uppercase. Mirrors the
// ConnectorBase.generateLedgerRowId convention so downstream readers cannot
// distinguish a quarantine-stamped row from a connector-stamped row by id
// shape alone (they only differ by whether `restoration` is present after
// the restore round-trip).
//
// checksum: blake2b512 truncated to 16 hex chars over canonical_json of the
// row WITHOUT the checksum field. Matches the chat-claude-code stop hook +
// ConnectorBase.appendLedgerRow discipline so restoreFromQuarantine can use
// the same verification scheme regardless of whether the row originated as
// a Stage-0 probe drop or a connector ledger append.
function _generateLedgerRowId() {
  return (
    "ulid_" +
    randomBytes(15)
      .toString("base64url")
      .replace(/[^A-Z0-9]/gi, "")
      .toUpperCase()
      .slice(0, 20)
  );
}
function _blake2b512TruncTo16Hex(bytes) {
  return createHash("blake2b512").update(bytes).digest().subarray(0, 16).toString("hex");
}
function _stampQuarantineIntegrity(row, source, ts) {
  // Build the stamped row in a STABLE field order matching the
  // ConnectorBase.appendLedgerRow output so a restored row round-trips
  // through the same canonicalJson preimage as a connector-emitted row.
  //
  // We preserve every caller-supplied key (parties, raw_content, attachments,
  // source_policy, kind, derived_from, ...) verbatim. If `id` is absent we
  // generate one; if `checksum` is absent we compute it over the stamped row
  // WITHOUT the checksum field, matching the connector discipline.
  const rowId =
    typeof row.id === "string" && row.id.length > 0
      ? row.id
      : _generateLedgerRowId();
  // Build a copy with stable known-field order; keep any other keys.
  const knownFields = new Set([
    "id",
    "ts",
    "source",
    "source_msg_id",
    "parties",
    "raw_content",
    "attachments",
    "source_policy",
    "checksum",
  ]);
  const rowWithoutChecksum = {
    id: rowId,
    ts: typeof row.ts === "string" && row.ts.length > 0 ? row.ts : ts,
    source,
    source_msg_id:
      typeof row.source_msg_id === "string" ? row.source_msg_id : null,
    parties: Array.isArray(row.parties) ? row.parties : [],
    raw_content: row.raw_content != null ? row.raw_content : {},
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    source_policy:
      row.source_policy != null && typeof row.source_policy === "object"
        ? row.source_policy
        : {},
  };
  for (const key of Object.keys(row)) {
    if (knownFields.has(key)) continue;
    rowWithoutChecksum[key] = row[key];
  }
  const checksum =
    typeof row.checksum === "string" && row.checksum.length > 0
      ? row.checksum
      : _blake2b512TruncTo16Hex(
          Buffer.from(canonicalJson(rowWithoutChecksum), "utf8")
        );
  return { ...rowWithoutChecksum, checksum };
}

// ----------------------------------------------------------------------------
// Path helpers
// ----------------------------------------------------------------------------

// Quarantine root. Env override mirrors the STORAGE_DIR discipline in
// config.js so hermetic tests can pin it independently from STORAGE_DIR.
function quarantineRoot() {
  return process.env.QUARANTINE_BASE_DIR || join(STORAGE_DIR, "quarantine");
}

function quarantineSourceDir(source) {
  return join(quarantineRoot(), source);
}

function dayTag(now) {
  // ISO YYYY-MM-DD in UTC. Daily file boundaries align with policy-events
  // rotation cadence at month granularity; here we use UTC so a single
  // 30-day purge window doesn't drift on DST boundaries.
  const d = now instanceof Date ? now : new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function quarantineDailyPath(source, now) {
  return join(quarantineSourceDir(source), `${dayTag(now)}.jsonl`);
}

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: QUARANTINE_DIR_MODE });
  }
}

// ----------------------------------------------------------------------------
// In-process drop telemetry
// ----------------------------------------------------------------------------
//
// Counters are intentionally simple: a Map keyed by `${source}\x00${reason}`.
// Stage-0 modules (and any caller that quarantines a row) call recordDrop().
// The counter is read by reportDropCounters() (e.g. for operator dashboards
// or test assertions). Persistent telemetry remains policy-events.

const DROP_COUNTERS = new Map();

export function recordDrop(source, reason) {
  const s = typeof source === "string" && source.length > 0 ? source : "_unknown";
  const r = typeof reason === "string" && reason.length > 0 ? reason : "unspecified";
  const key = `${s}\x00${r}`;
  DROP_COUNTERS.set(key, (DROP_COUNTERS.get(key) || 0) + 1);
}

export function getDropCounters() {
  // Return a fresh array of {source, reason, count} — never expose the
  // internal Map.
  const out = [];
  for (const [key, count] of DROP_COUNTERS.entries()) {
    const [source, reason] = key.split("\x00");
    out.push({ source, reason, count });
  }
  return out;
}

export function _resetDropCountersForTest() {
  DROP_COUNTERS.clear();
}

// ----------------------------------------------------------------------------
// quarantineRow
// ----------------------------------------------------------------------------
//
// row: the full source-ledger row (id, ts, source, source_msg_id, parties,
//      raw_content, attachments, source_policy, checksum, ...).
// reason: short kebab/snake-case reason string from the Stage-0 rule
//      (e.g. "merge_only", "bot_commit", "otp_pattern").
// opts:
//   - rule_id: string — optional originating Stage-0 rule_id. Defaults to
//     the value of reason when not supplied (Stage-0 modules currently
//     return a single string under .reason).
//   - now: Date | number — test clock injection.
//   - source: string — override the row.source field (e.g. when the caller
//     resolved the source out-of-band).
//
// Returns: { path, dropped_at, source, source_msg_id }.

export function quarantineRow(row, reason, opts = {}) {
  if (row == null || typeof row !== "object") {
    throw new TypeError("quarantineRow: row must be an object");
  }
  const source =
    typeof opts.source === "string" && opts.source.length > 0
      ? opts.source
      : typeof row.source === "string" && row.source.length > 0
        ? row.source
        : null;
  if (!source) {
    throw new TypeError("quarantineRow: row.source is required");
  }
  const reasonStr =
    typeof reason === "string" && reason.length > 0 ? reason : "unspecified";
  const ruleId =
    typeof opts.rule_id === "string" && opts.rule_id.length > 0
      ? opts.rule_id
      : reasonStr;

  const nowMs =
    opts.now instanceof Date
      ? opts.now.getTime()
      : typeof opts.now === "number"
        ? opts.now
        : Date.now();
  const droppedAt = new Date(nowMs).toISOString();

  // F-NEW-W2-CODEX-QUARANTINE-CHECKSUM-ID — stamp id + checksum on the row
  // before persisting so restoreFromQuarantine() has a deterministic id to
  // surface and an integrity signal to verify against. Stage-0 callers
  // hand us probe-shaped events that lack these fields (the ConnectorBase
  // stamping path is short-circuited by the DROP decision). The stamping
  // helper preserves any caller-supplied id / checksum verbatim, so a
  // restore of an already-stamped row is idempotent.
  const stampedRow = _stampQuarantineIntegrity(row, source, droppedAt);

  const entry = {
    dropped_at: droppedAt,
    source,
    source_msg_id:
      typeof stampedRow.source_msg_id === "string" ? stampedRow.source_msg_id : null,
    // F-NEW-W2-CODEX-QUARANTINE-CHECKSUM-ID — surface the stamped id +
    // checksum at the entry level so listQuarantine + restoreFromQuarantine
    // can locate / verify the row without re-parsing the nested `row` body.
    id: stampedRow.id,
    checksum: stampedRow.checksum,
    reason: reasonStr,
    rule_id: ruleId,
    row: stampedRow,
  };

  const dir = quarantineSourceDir(source);
  ensureDir(dir);
  const path = quarantineDailyPath(source, nowMs);
  const line = JSON.stringify(entry) + "\n";

  // Use a short open/write/fsync/close cycle. Multiple Stage-0 modules
  // could call this concurrently; per-line atomicity is provided by the
  // single writev() inside writeSync(string < PIPE_BUF). Lines stay under
  // a few KB so this is safe in practice for the daemon workloads.
  const fd = openSync(path, "a", QUARANTINE_FILE_MODE);
  try {
    const buf = Buffer.from(line, "utf8");
    let written = 0;
    while (written < buf.length) {
      written += writeSync(fd, buf, written, buf.length - written);
    }
    try {
      fsyncSync(fd);
    } catch {
      /* best-effort durability — quarantine is recoverable, not load-bearing */
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }

  // Telemetry: even though the row is recoverable, the drop counter
  // semantically still fired. Callers that read getDropCounters() see the
  // same numbers they would have if quarantine didn't exist.
  recordDrop(source, reasonStr);

  return {
    path,
    dropped_at: droppedAt,
    source,
    source_msg_id: entry.source_msg_id,
    // F-NEW-W2-CODEX-QUARANTINE-CHECKSUM-ID — surface the stamped id +
    // checksum so callers can audit-log the quarantine entry's identity
    // without re-reading the daily file.
    id: entry.id,
    checksum: entry.checksum,
  };
}

// ----------------------------------------------------------------------------
// restoreFromQuarantine
// ----------------------------------------------------------------------------
//
// Locate the most recent quarantine entry for source_msg_id and re-emit
// the row to its source-ledger with restoration metadata stamped onto it.
// "Most recent first" search order: newest daily file first; if multiple
// entries match in the same file, the LAST line wins (multiple drops of
// the same id over time always restore the latest snapshot).
//
// opts:
//   - source: string — restrict search to one source dir (recommended; the
//     scan is O(daily files * lines) per source). Optional — without it
//     every source dir is scanned.
//   - now: Date | number — test clock injection.
//   - ledgerPath: string — override target ledger path (for tests).
//   - skipLedgerWrite: boolean — return the restored row without writing
//     to the source-ledger (operator-side dry-run).
//
// Returns: { restored: true, source, source_msg_id, ledger_path, row }
//          | { restored: false, reason: "not_found" }.

export function restoreFromQuarantine(sourceMsgId, opts = {}) {
  if (typeof sourceMsgId !== "string" || sourceMsgId.length === 0) {
    throw new TypeError("restoreFromQuarantine: source_msg_id must be a non-empty string");
  }
  const root = quarantineRoot();
  if (!existsSync(root)) {
    return { restored: false, reason: "not_found" };
  }

  let sources;
  if (typeof opts.source === "string" && opts.source.length > 0) {
    sources = [opts.source];
  } else {
    try {
      sources = readdirSync(root).filter((name) => {
        try {
          return statSync(join(root, name)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      sources = [];
    }
  }

  // Search newest-first by sorting daily files descending. Daily files are
  // YYYY-MM-DD.jsonl so a descending lexicographic sort is also a date sort.
  let found = null;
  for (const src of sources) {
    const dir = join(root, src);
    if (!existsSync(dir)) continue;
    let files;
    try {
      files = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    files.sort().reverse();
    for (const f of files) {
      const path = join(dir, f);
      let raw;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      if (raw === "") continue;
      const lines = raw.split("\n");
      // Iterate in reverse — latest drop of a duplicated source_msg_id wins.
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line === "") continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed && parsed.source_msg_id === sourceMsgId) {
          found = { entry: parsed, path, source: src };
          break;
        }
      }
      if (found) break;
    }
    if (found) break;
  }

  if (!found) return { restored: false, reason: "not_found" };

  const nowMs =
    opts.now instanceof Date
      ? opts.now.getTime()
      : typeof opts.now === "number"
        ? opts.now
        : Date.now();
  const restoredAt = new Date(nowMs).toISOString();

  const { entry } = found;
  const originalRow = (entry.row && typeof entry.row === "object") ? entry.row : {};

  // F-NEW-W2-CODEX-QUARANTINE-CHECKSUM-ID — verify checksum integrity on
  // restore. The row was stamped at quarantineRow time over its preimage
  // (canonical_json of the row WITHOUT checksum). We re-compute over the
  // same preimage shape and compare. A mismatch is non-fatal — we still
  // return the row (operator can choose to keep or discard) — but we
  // surface the verification result so the restore tool can warn.
  const storedChecksum =
    typeof originalRow.checksum === "string" ? originalRow.checksum : null;
  let checksumVerified = null;
  if (storedChecksum) {
    try {
      const { checksum: _drop, ...rowWithoutChecksum } = originalRow;
      void _drop;
      const recomputed = _blake2b512TruncTo16Hex(
        Buffer.from(canonicalJson(rowWithoutChecksum), "utf8")
      );
      checksumVerified = recomputed === storedChecksum;
    } catch {
      checksumVerified = false;
    }
  }

  // Stamp restoration metadata onto the row so downstream dedup knows
  // this is a recovery, not a fresh ingest. The metadata lives in a
  // dedicated `restoration` field — readers that don't know about it
  // see the same row they would have seen pre-drop. checksum_verified is
  // surfaced inside restoration so operator audit can distinguish a
  // successful integrity check from "no checksum to verify against".
  const restoredRow = {
    ...originalRow,
    restoration: {
      restored: true,
      restored_at: restoredAt,
      original_drop_reason: entry.reason || null,
      original_drop_rule: entry.rule_id || entry.reason || null,
      original_dropped_at: entry.dropped_at || null,
      checksum_verified: checksumVerified,
    },
  };

  if (opts.skipLedgerWrite) {
    return {
      restored: true,
      source: found.source,
      source_msg_id: sourceMsgId,
      ledger_path: null,
      row: restoredRow,
      checksum_verified: checksumVerified,
    };
  }

  const ledgerPath =
    typeof opts.ledgerPath === "string" && opts.ledgerPath.length > 0
      ? opts.ledgerPath
      : sourceLedgerPath(found.source);
  ensureDir(dirname(ledgerPath));
  const line = JSON.stringify(restoredRow) + "\n";
  // append-only — same discipline as the connector base class. We don't
  // re-compute the checksum: the row carries its original checksum and
  // the restoration field is metadata stamped post-hoc by the operator,
  // not part of the canonical ingest payload.
  appendFileSync(ledgerPath, line, { mode: 0o600 });

  return {
    restored: true,
    source: found.source,
    source_msg_id: sourceMsgId,
    ledger_path: ledgerPath,
    row: restoredRow,
    checksum_verified: checksumVerified,
  };
}

// ----------------------------------------------------------------------------
// purgeExpiredQuarantine
// ----------------------------------------------------------------------------
//
// Delete per-source daily files whose YYYY-MM-DD tag is older than
// retentionDays(). Designed to be called by a daily cron / scheduled task.
// Idempotent and safe to call on an empty quarantine root.
//
// opts:
//   - now: Date | number — test clock injection.
//   - retentionDays: number — override the default 30-day window.
//
// Returns: { deleted: [paths], retained: number }.

export function purgeExpiredQuarantine(opts = {}) {
  const root = quarantineRoot();
  const deleted = [];
  let retained = 0;
  if (!existsSync(root)) {
    return { deleted, retained };
  }
  const nowMs =
    opts.now instanceof Date
      ? opts.now.getTime()
      : typeof opts.now === "number"
        ? opts.now
        : Date.now();
  const windowDays =
    Number.isFinite(opts.retentionDays) && opts.retentionDays > 0
      ? opts.retentionDays
      : retentionDays();
  const cutoffMs = nowMs - windowDays * 24 * 60 * 60 * 1000;

  let sources;
  try {
    sources = readdirSync(root);
  } catch {
    return { deleted, retained };
  }
  for (const src of sources) {
    const dir = join(root, src);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      // Parse YYYY-MM-DD from filename. Reject non-matching names
      // (defensive: a stray operator file in the dir isn't a quarantine
      // entry and shouldn't be deleted by the daily purge).
      const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(f);
      if (!m) {
        retained += 1;
        continue;
      }
      const fileDayMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      // A file's "age" is measured from its day boundary (start of day UTC).
      // Add one day to push the threshold to end-of-day so a file dated
      // exactly 30 days ago is not deleted mid-day; the purge fires when the
      // entire 30-day window has elapsed.
      const fileExpiresMs = fileDayMs + windowDays * 24 * 60 * 60 * 1000;
      if (fileExpiresMs < nowMs) {
        const path = join(dir, f);
        try {
          unlinkSync(path);
          deleted.push(path);
        } catch {
          retained += 1;
        }
      } else {
        retained += 1;
      }
    }
  }
  // Silence unused-cutoff lint — cutoffMs is computed for parity with the
  // retention spec, the actual per-file comparison uses fileExpiresMs above.
  void cutoffMs;
  return { deleted, retained };
}

// ----------------------------------------------------------------------------
// listQuarantine
// ----------------------------------------------------------------------------
//
// Operator-facing audit read. Returns the most recent quarantine entries
// across one or all sources.
//
// opts:
//   - source: string — restrict to a single source.
//   - sinceDays: number — only entries dropped within the last N days.
//   - limit: number — cap the returned entries (default 50, hard cap 500).
//   - now: Date | number — test clock injection.
//
// Each returned entry has shape:
//   {
//     dropped_at, source, source_msg_id, reason, rule_id,
//     row_summary: { id, ts, source_msg_id }    // never raw_content
//   }
// Raw row content is intentionally NOT returned by the list API — call
// restoreFromQuarantine(..., { skipLedgerWrite: true }) for a single row's
// content. This keeps the audit surface free of OTP/PII residue.

const LIST_HARD_CAP = 500;
const LIST_DEFAULT_LIMIT = 50;

export function listQuarantine(opts = {}) {
  const root = quarantineRoot();
  const out = [];
  if (!existsSync(root)) return out;

  const nowMs =
    opts.now instanceof Date
      ? opts.now.getTime()
      : typeof opts.now === "number"
        ? opts.now
        : Date.now();
  const sinceDays =
    Number.isFinite(opts.sinceDays) && opts.sinceDays > 0
      ? opts.sinceDays
      : null;
  const sinceMs = sinceDays != null ? nowMs - sinceDays * 24 * 60 * 60 * 1000 : null;

  const limit = Math.min(
    LIST_HARD_CAP,
    Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : LIST_DEFAULT_LIMIT,
  );

  let sources;
  if (typeof opts.source === "string" && opts.source.length > 0) {
    sources = [opts.source];
  } else {
    try {
      sources = readdirSync(root).filter((name) => {
        try {
          return statSync(join(root, name)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      sources = [];
    }
  }

  // Walk newest day first per source. Stop once `limit` entries are
  // accumulated. Entries are returned in newest-first order.
  for (const src of sources) {
    const dir = join(root, src);
    if (!existsSync(dir)) continue;
    let files;
    try {
      files = readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
    } catch {
      continue;
    }
    files.sort().reverse();
    for (const f of files) {
      if (out.length >= limit) break;
      const path = join(dir, f);
      let raw;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      if (raw === "") continue;
      const lines = raw.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (out.length >= limit) break;
        const line = lines[i];
        if (line === "") continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object") continue;
        if (sinceMs != null) {
          const t = Date.parse(parsed.dropped_at || "");
          if (!Number.isFinite(t) || t < sinceMs) continue;
        }
        const row = parsed.row && typeof parsed.row === "object" ? parsed.row : {};
        out.push({
          dropped_at: parsed.dropped_at || null,
          source: parsed.source || src,
          source_msg_id: parsed.source_msg_id || null,
          reason: parsed.reason || null,
          rule_id: parsed.rule_id || parsed.reason || null,
          row_summary: {
            id: typeof row.id === "string" ? row.id : null,
            ts: typeof row.ts === "string" ? row.ts : null,
            source_msg_id:
              typeof row.source_msg_id === "string" ? row.source_msg_id : null,
          },
        });
      }
    }
    if (out.length >= limit) break;
  }

  return out;
}

// ----------------------------------------------------------------------------
// Test helpers
// ----------------------------------------------------------------------------

export function _quarantineRootForTest() {
  return quarantineRoot();
}

export function _quarantineDailyPathForTest(source, now) {
  return quarantineDailyPath(source, now);
}

// Avoid an unused-import lint on renameSync / writeFileSync — both are
// kept available for future single-writer fsync-and-rename swaps in
// purgeExpiredQuarantine if a stricter durability discipline is needed.
void renameSync;
void writeFileSync;
