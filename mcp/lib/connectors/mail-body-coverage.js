// mail-body-coverage.js — g3 (mail body resolution). READ-ONLY measurement.
//
// WHY THIS EXISTS
// ---------------
// A whole-ledger body-resolution rate conflates rows written by two resolver
// regimes. The earlier resolver hunted for a basename that was not present on
// disk, so append order — rather than message date — is the axis that separates
// historical output from the current resolver's output.
//
// A by-year table cannot see this, because ledger APPEND ORDER is the axis,
// not message date. This module measures on the append-order axis.
//
// RUNTIME-CENSUS: run mcp/scripts/verify-mail-body-coverage.mjs to produce a
// dated report. Keep its output with the investigation; do not copy results
// into source comments.
//
// WHAT IT REPORTS (distinct fields; callers keep them distinct)
//   rows_total                 every row in the ledger.
//   resolved_total             rows with raw_content.body_resolved === true.
//   corpus_resolved_rate       whole-ledger resolution rate.
//   frozen_prefix_rows         rows appended BEFORE the first body_resolved
//                              row. By construction this prefix contains zero
//                              resolved rows. This is the defect's true size.
//   live_suffix_resolved_rate  resolution rate over the suffix from that first
//                              resolved row to EOF. Use this field to describe
//                              the current resolver and predict the next poll.
// plus boundary_source_msg_id / boundary_ts — the exact row where the regime
// changes, so a reviewer can independently confirm no body_resolved row exists
// before it.
//
// HONESTY ABOUT THE BOUNDARY. "Frozen prefix" is a CLAIM about shape, and one
// stray early resolved row would make a clean-looking boundary out of a
// scattered pattern. So the measurement also carries
// `suffix_max_unresolved_run` (the longest consecutive unresolved run inside
// the suffix) and `frozen_prefix_dominates` (prefix longer than that run).
// When the pattern is interleaved rather than prefix-shaped, that flag is
// false and the caller must not tell a frozen-prefix story.
//
// NO LEDGER SLURPING. ERR_STRING_TOO_LONG on a growing ledger is a recorded
// defect class in this repo. The full measurement
// streams with createReadStream and splits on "\n" itself (see _streamLines
// for why NOT node:readline — it can undercount this ledger); the
// health-side probe reads ONE fixed-size positioned block from BOF. The file
// is NEVER allocated as one string. readFileSync on this ledger is forbidden
// here as much as in shipped code.
//
// STRICTLY READ-ONLY. No write of any kind: no cursor, no tmp file, no log, no
// daemon signal. `body_resolved` is READ, never redefined — it means exactly
// `extracted != null` (lib/connectors/mail.js:723), already tightened once
// from the lying `bodyPath != null`, and this module must not loosen it.
//
// PII / LOG DISCIPLINE. Counts, rates, one local Apple-Mail rowid and one
// timestamp. No RFC message-id, no address, no subject, no mailbox path and no
// body text is read into the return value or any error path.
//
// HERMETICITY. Paths resolve via lib/config.js sourceLedgerPath("mail"), and
// opts.ledgerPath / opts.now allow full fixture injection, so tests run under
// mkdtempSync and never touch the operator's real ledger or ~/Library/Mail.
//
// RESIDUALS THIS MODULE DELIBERATELY DOES NOT FIX — named here so they travel
// with the code and are never mistaken for one another:
//
//   (1) THE LIVE-WINDOW MISS. Some live-suffix rows remain unresolved. Test
//       duplicate-mailbox-copy hypotheses separately; do not fold this defect
//       into the frozen-prefix explanation.
//
//   (2) THE FROZEN PREFIX IS NOT REPAIRED. The remedy is a SUPERVISED
//       re-ingest of the prefix rowids back through the fixed resolver. That
//       writes to storage/, which is out of scope for a read-only measurement
//       node. It is named here, not built, not scheduled — and it is NOT a
//       mass re-download: the .emlx files are already on disk, which is
//       precisely why the prefix is repairable at all.

import { createReadStream, closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

import { sourceLedgerPath } from "../config.js";

// One positioned read from BOF for the health-side probe. Small on purpose:
// health must never full-scan a source ledger, and the only question the probe
// asks is "is the HEAD of this ledger bodyless?", which the first block
// answers.
export const DEFAULT_HEAD_PROBE_BYTES = 256 * 1024;

// Hard upper bound on any caller-supplied head-probe size, mirroring
// MAX_BLOCK_SIZE in lib/ingest/source-effective-empty-rate.js: without it a
// finite-but-huge opts.headBytes would Buffer.alloc an arbitrary slice of a
// 387MB ledger and void the bounded-read invariant.
export const MAX_HEAD_PROBE_BYTES = 8 * 1024 * 1024;

function _rate(num, den) {
  return den > 0 ? Number((num / den).toFixed(6)) : null;
}

function _resolvedFlag(row) {
  const rc = row && row.raw_content;
  return !!(rc && typeof rc === "object" && rc.body_resolved === true);
}

function _resolveLedgerPath(opts) {
  return typeof opts.ledgerPath === "string" && opts.ledgerPath.length > 0
    ? opts.ledgerPath
    : sourceLedgerPath("mail");
}

// Same skip discipline as every other streaming reader here: a malformed or
// non-object line is skipped, never fatal, and counted nowhere.
function _parseRow(line) {
  if (!line) return null;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed;
}

// _streamLines — yield JSONL records split on "\n" ONLY.
//
// DO NOT "simplify" this back to node:readline. Measured against the real
// mail ledger: readline can report a different record count from splitting on
// the JSONL newline delimiter. The cause is that
// node:readline also breaks on U+2028 LINE SEPARATOR and U+2029 PARAGRAPH
// SEPARATOR, which `JSON.stringify` does NOT escape — so any mail row whose
// subject or body text carries one is torn into fragments, BOTH fragments fail
// JSON.parse, and the row vanishes from the count with no error anywhere.
//
// For a gate whose entire product is four counts, a silent undercount is the
// worst available failure. Splitting on "\n" is also simply what JSONL means.
// (The same idiom is live in scripts/verify-mail-reply-linkage.mjs and
// lib/messaging/contact-spine.js; both undercount for the same reason. Named
// here — those files are outside this node's remit and are not touched.)
//
// Memory high-water mark is one stream chunk plus one carried partial line,
// never the file: the ledger is never allocated as one string.
async function* _streamLines(path) {
  const stream = createReadStream(path, { encoding: "utf8" });
  let carry = "";
  for await (const chunk of stream) {
    const text = carry + chunk;
    let start = 0;
    for (;;) {
      const idx = text.indexOf("\n", start);
      if (idx === -1) break;
      yield text.slice(start, idx);
      start = idx + 1;
    }
    carry = text.slice(start);
  }
  if (carry.length > 0) yield carry; // unterminated final line
}

// measureMailBodyCoverage — stream the whole mail ledger once and return the
// four never-collapsed numbers plus the append-order boundary.
//
// Returns:
//   {
//     ok: boolean,                       false => nothing measurable; every
//                                        count stays null rather than 0, so a
//                                        failed scan can never be read as a
//                                        measured zero.
//     reason: string | null,             set only when ok===false
//     measured_at: string,               ISO, from opts.now or the clock
//     ledger_present: boolean,
//     lines_total: number|null,          physical "\n"-delimited lines
//     lines_skipped: number|null,        lines that were empty or unparseable
//     boundary_line: number|null,        1-indexed FILE LINE of the boundary,
//                                        so a reviewer greps the right line
//                                        even when lines_skipped > 0
//     rows_total: number|null,
//     resolved_total: number|null,
//     corpus_resolved_rate: number|null, whole-ledger rate — never alone
//     frozen_prefix_rows: number|null,   rows before the first resolved row
//     boundary_index: number|null,       0-based ordinal of that row
//     boundary_source_msg_id: string|null,
//     boundary_ts: string|null,
//     live_suffix_rows: number|null,
//     live_suffix_resolved: number|null,
//     live_suffix_resolved_rate: number|null,
//     suffix_max_unresolved_run: number|null,
//     frozen_prefix_dominates: boolean|null,
//   }
export async function measureMailBodyCoverage(opts = {}) {
  const nowMs =
    opts.now instanceof Date
      ? opts.now.getTime()
      : typeof opts.now === "number"
        ? opts.now
        : Date.now();
  const path = _resolveLedgerPath(opts);

  const base = {
    ok: false,
    reason: null,
    measured_at: new Date(nowMs).toISOString(),
    ledger_present: existsSync(path),
    lines_total: null,
    lines_skipped: null,
    boundary_line: null,
    rows_total: null,
    resolved_total: null,
    corpus_resolved_rate: null,
    frozen_prefix_rows: null,
    boundary_index: null,
    boundary_source_msg_id: null,
    boundary_ts: null,
    live_suffix_rows: null,
    live_suffix_resolved: null,
    live_suffix_resolved_rate: null,
    suffix_max_unresolved_run: null,
    frozen_prefix_dominates: null,
  };

  if (!base.ledger_present) {
    base.reason = "ledger_missing";
    return base;
  }

  let linesTotal = 0;
  let linesSkipped = 0;
  let boundaryLine = null;
  let rowsTotal = 0;
  let resolvedTotal = 0;
  let boundaryIndex = null;
  let boundarySourceMsgId = null;
  let boundaryTs = null;
  let suffixRows = 0;
  let suffixResolved = 0;
  let currentUnresolvedRun = 0;
  let maxUnresolvedRun = 0;

  try {
    for await (const line of _streamLines(path)) {
      linesTotal += 1;
      const row = _parseRow(line);
      if (!row) {
        // Empty or unparseable. Counted, never silently absorbed: a growing
        // lines_skipped is the operator's only warning that rows are being
        // dropped from these four numbers.
        linesSkipped += 1;
        continue;
      }
      const ordinal = rowsTotal;
      rowsTotal += 1;
      const resolved = _resolvedFlag(row);
      if (resolved) resolvedTotal += 1;

      if (boundaryIndex === null) {
        if (!resolved) continue; // still inside the frozen prefix
        boundaryIndex = ordinal;
        // 1-indexed FILE LINE, which is what a reviewer greps for. It equals
        // boundary_index + 1 only when nothing was skipped before it; the two
        // are reported separately so the offset can never hide.
        boundaryLine = linesTotal;
        boundarySourceMsgId =
          typeof row.source_msg_id === "string" ? row.source_msg_id : null;
        boundaryTs = typeof row.ts === "string" ? row.ts : null;
      }

      // From the boundary row (inclusive) onward: this is the live suffix.
      suffixRows += 1;
      if (resolved) {
        suffixResolved += 1;
        currentUnresolvedRun = 0;
      } else {
        currentUnresolvedRun += 1;
        if (currentUnresolvedRun > maxUnresolvedRun) maxUnresolvedRun = currentUnresolvedRun;
      }
    }
  } catch (err) {
    base.reason = `ledger_unreadable:${err && err.code ? String(err.code) : "unknown"}`;
    return base;
  }

  base.ok = true;
  base.lines_total = linesTotal;
  base.lines_skipped = linesSkipped;
  base.boundary_line = boundaryLine;
  base.rows_total = rowsTotal;
  base.resolved_total = resolvedTotal;
  base.corpus_resolved_rate = _rate(resolvedTotal, rowsTotal);
  // No resolved row anywhere: the whole ledger is the frozen prefix and there
  // is no live suffix to rate. Reporting a rate over zero suffix rows would be
  // a confident zero; null is the honest answer.
  base.frozen_prefix_rows = boundaryIndex === null ? rowsTotal : boundaryIndex;
  base.boundary_index = boundaryIndex;
  base.boundary_source_msg_id = boundarySourceMsgId;
  base.boundary_ts = boundaryTs;
  base.live_suffix_rows = suffixRows;
  base.live_suffix_resolved = suffixResolved;
  base.live_suffix_resolved_rate = _rate(suffixResolved, suffixRows);
  base.suffix_max_unresolved_run = maxUnresolvedRun;
  // The falsifier for the frozen-prefix story: if the suffix itself contains
  // an unresolved run as long as the prefix, the pattern is interleaved and
  // the "boundary" is an artifact of one early resolved row.
  base.frozen_prefix_dominates =
    boundaryIndex === null ? null : base.frozen_prefix_rows > maxUnresolvedRun;
  return base;
}

function _normalizeHeadBytes(v) {
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_HEAD_PROBE_BYTES;
  return Math.min(MAX_HEAD_PROBE_BYTES, Math.max(1, Math.floor(v)));
}

// probeMailLedgerHead — ONE bounded positioned read from BOF.
//
// This is the ONLY part of this module health is allowed to call. The rolling
// backward-from-EOF window in lib/ingest/source-effective-empty-rate.js is
// structurally incapable of seeing the frozen prefix — it never reaches BOF —
// so without a head probe the operator sees a healthy live rate and no trace
// of the ~279k envelope-only rows sitting behind it.
//
// fd discipline mirrors computeEffectiveEmptyRate: statSync -> openSync ->
// positioned readSync -> closeSync in finally. The trailing partial line of
// the block is dropped unless the block reached EOF.
//
// Returns { ok, reason, bytes_read, rows_sampled, resolved_in_head,
//           head_bodyless } — head_bodyless is true ONLY when rows were
// actually sampled and none of them resolved.
export function probeMailLedgerHead(opts = {}) {
  const path = _resolveLedgerPath(opts);
  const headBytes = _normalizeHeadBytes(opts.headBytes);

  const out = {
    ok: false,
    reason: null,
    bytes_read: 0,
    rows_sampled: 0,
    resolved_in_head: 0,
    head_bodyless: false,
  };

  if (!existsSync(path)) {
    out.reason = "ledger_missing";
    return out;
  }

  let fd = -1;
  try {
    const st = statSync(path);
    if (st.size === 0) {
      out.reason = "ledger_empty";
      return out;
    }
    const readSize = Math.min(headBytes, st.size);
    fd = openSync(path, "r");
    const buf = Buffer.alloc(readSize);
    let read = 0;
    while (read < readSize) {
      const chunk = readSync(fd, buf, read, readSize - read, read);
      if (chunk === 0) break;
      read += chunk;
    }
    out.bytes_read = read;
    const text = buf.slice(0, read).toString("utf8");
    const lines = text.split("\n");
    // The final element is a partial line unless the block consumed the whole
    // file (and even then it is "" for a newline-terminated ledger).
    if (read < st.size) lines.pop();
    for (const line of lines) {
      const row = _parseRow(line);
      if (!row) continue;
      out.rows_sampled += 1;
      if (_resolvedFlag(row)) out.resolved_in_head += 1;
    }
  } catch (err) {
    out.reason = `read_error:${err && err.code ? err.code : "unknown"}`;
    return out;
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {}
    }
  }

  out.ok = true;
  out.head_bodyless = out.rows_sampled > 0 && out.resolved_in_head === 0;
  return out;
}

// buildMailBodyCoverageHealthNotes — pure formatter, extracted so health.js
// stays a try/catch and the string is hermetically testable.
//
// It emits AT MOST ONE note, and only when BOTH halves of the finding hold:
// the ledger HEAD is bodyless, and the live tail window is resolving (the
// mail snapshot from computeEffectiveEmptyRatesForSources is computable and
// shows non-empty rows). Either half alone is not the frozen-prefix finding:
// a bodyless head with a bodyless tail is a live outage, and health already
// has the source_effective_empty_rate_degraded note for that.
//
// Counts and rates only. No id, address, subject, mailbox path or body text.
export function buildMailBodyCoverageHealthNotes(headProbe, mailEmptyRateSnapshot) {
  const notes = [];
  if (!headProbe || headProbe.ok !== true || headProbe.head_bodyless !== true) return notes;
  const snap = mailEmptyRateSnapshot;
  if (!snap || typeof snap !== "object") return notes;
  if (!Number.isFinite(snap.rows_in_window) || snap.rows_in_window <= 0) return notes;
  const emptyRate = snap.effective_empty_rate;
  if (typeof emptyRate !== "number") return notes;
  const tailResolvedPct = Math.round((1 - emptyRate) * 1000) / 10;
  if (tailResolvedPct <= 0) return notes; // tail is not resolving; not this finding
  notes.push(
    `mail_body_frozen_prefix: head rows body_resolved=false ` +
      `(0/${headProbe.rows_sampled} sampled from BOF); live window resolving ` +
      `${tailResolvedPct}% (${snap.rows_in_window} rows) — historical mail is ` +
      `envelope-only and not recoverable by the cursor-advancing connector`
  );
  return notes;
}
