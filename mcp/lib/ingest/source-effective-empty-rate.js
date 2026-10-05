// F-NEW-W2-CHAT-CC-HEALTH-PROBE — per-source effective_empty_rate health probe.
//
// Surfaces the "99.75%-empty bug class" that the Wave-2 audit found in
// chat-claude-code (832/834 rows had empty user_text + assistant_text). The
// probe scans storage/sources/<source>.jsonl BACKWARD from EOF over the last
// 7 days and computes:
//
//   effective_empty_rate = (rows where extracted content is empty) /
//                          (rows in window)
//
// status='degraded' when the rate exceeds DEFAULT_EMPTY_RATE_THRESHOLD (0.5)
// per the node spec. The probe is read-only and bounded: it reads fixed-size
// blocks from EOF backward (positioned readSync; never readFileSync of the
// whole ledger) and stops at the first row older than the window cutoff, at
// BOF, or at DEFAULT_MAX_SCAN_BYTES — whichever comes first. When the byte
// budget truncates the scan before the window is covered, the snapshot says
// so honestly: `partial: true` plus `window_covered_h` (the hours actually
// covered) so callers never present a truncated window as a full 7 days.
// Memory high-water mark is one block + one carried line, never the file.
//
// Per-source "empty" definition:
//   For sources with raw_content.user_text + raw_content.assistant_text
//   (chat-claude-code, codex-cli): row is empty when BOTH fields are
//   missing or whitespace-only.
//   For sources with raw_content.text (imessage, whatsapp, telegram,
//   slack): row is empty when text is missing or whitespace-only.
//   For all other sources: the probe returns null (not computable) so the
//   surface does not lie about sources whose "empty" is ill-defined.
//
// HERMETICITY: every path is sourced via lib/config.js STORAGE_DIR helper so
// MEMORY_ROOT / STORAGE_BASE_DIR env overrides work for hermetic tests, and
// opts.ledgerPath / opts.now / opts.blockSize / opts.maxScanBytes allow full
// fixture injection.

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import { STORAGE_DIR } from "../config.js";

// Default threshold per F-NEW-W2-CHAT-CC-HEALTH-PROBE node:
// "Status='degraded' if > 0.5". Exported so callers can override (tests).
export const DEFAULT_EMPTY_RATE_THRESHOLD = 0.5;

// 7-day rolling window per node predicate.
export const DEFAULT_WINDOW_DAYS = 7;

// Backward-scan block granularity. One block (+ the carried partial line) is
// the memory high-water mark of the scan.
const BLOCK_SIZE = 1 * 1024 * 1024;

// Hard upper bound on any caller-supplied blockSize. Without it a finite but
// huge opts.blockSize (e.g. 2**40) lets `Math.min(blockSize, offset)` grow to
// the whole file and Buffer.alloc a multi-GB ledger in one shot — violating
// the one-block memory invariant. Exported for tests.
export const MAX_BLOCK_SIZE = 64 * 1024 * 1024;

// Hard byte budget for one probe call. ~2x what the live codex-cli ledger
// needs for a true 7-day window today, so a healthy ledger never truncates;
// a pathological one stops here and reports partial:true instead of stalling.
export const DEFAULT_MAX_SCAN_BYTES = 48 * 1024 * 1024;

// B2 (memory-roots) — To/Cc recipient tally for the operator alias-candidate
// note. It rides the mail scan below on the rows processLine already parses:
// zero extra bytes, blocks, or fs opens; bytes_scanned is identical with and
// without it. See lib/identity/alias-candidates.js. (ESM imports hoist; this
// one sits below the scan constants so their line numbers — pinned by the B2
// acceptance check `sed -n '45p;49p;60p'` — stay byte-identical to HEAD.)
import { createAliasCandidateTally } from "../identity/alias-candidates.js";

// Per-source emptiness predicate. Returns true if the row's payload has no
// recoverable content. null means "not computable for this source" — the
// probe surfaces empty_count=null when no per-source predicate exists.
const EMPTINESS_PREDICATES = Object.freeze({
  "chat-claude-code": (rc) => _isEmptyText(rc.user_text) && _isEmptyText(rc.assistant_text),
  "codex-cli": (rc) => _isEmptyText(rc.user_text) && _isEmptyText(rc.assistant_text),
  imessage: (rc) => _isEmptyText(rc.text),
  whatsapp: (rc) => _isEmptyText(rc.text),
  telegram: (rc) => _isEmptyText(rc.text),
  slack: (rc) => _isEmptyText(rc.text),
  // g3: mail carries raw_content.text like the messaging sources — null when
  // .emlx body resolution failed, a string when it succeeded — so it takes the
  // same predicate. It had NO predicate before, which meant
  // computeEffectiveEmptyRatesForSources skipped mail entirely and health said
  // nothing whatsoever about mail content. This is the ONE channel that
  // surfaces the LIVE resolution rate (~19% empty over the rolling window)
  // without touching the closed health envelope: it goes out as a
  // health_notes[] string, never as a new top-level key.
  //
  // What this predicate structurally CANNOT see: the frozen prefix. The scan
  // runs backward from EOF and stops at the window cutoff, so the ~279k
  // envelope-only rows at the head of the ledger are never reached. That
  // signal comes from probeMailLedgerHead in
  // lib/connectors/mail-body-coverage.js instead — one bounded read from BOF.
  mail: (rc) => _isEmptyText(rc.text),
});

function _isEmptyText(v) {
  if (v == null) return true;
  if (typeof v !== "string") return false;
  return v.trim().length === 0;
}

function _sourceLedgerPath(source) {
  return join(STORAGE_DIR, "sources", `${source}.jsonl`);
}

// _normalizeBlockSize — clamp a caller-supplied blockSize to a safe integer
// in [1, MAX_BLOCK_SIZE]. Invalid values (absent, non-finite, non-positive)
// fall back to the default BLOCK_SIZE — preserving the original "invalid →
// default" behavior. Positive fractionals clamp UP to 1 (never down to 0:
// a 0 blockSize makes readSize 0 so `offset` never decreases — an infinite
// synchronous loop no in-process timer can interrupt). Exported for tests.
export function _normalizeBlockSize(v) {
  if (!Number.isFinite(v) || v <= 0) return BLOCK_SIZE;
  return Math.min(MAX_BLOCK_SIZE, Math.max(1, Math.floor(v)));
}

// _normalizeMaxScanBytes — same shape for the byte budget: invalid → default,
// positive → integer >= 1. No upper cap: the budget only bounds work downward.
// Exported for tests.
export function _normalizeMaxScanBytes(v) {
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_MAX_SCAN_BYTES;
  return Math.max(1, Math.floor(v));
}

// computeEffectiveEmptyRate — scan a source ledger backward from EOF and
// return the per-source health snapshot. Pure function of disk state +
// clock; safe to call from any read-only context.
//
// Returns:
//   {
//     source: string,
//     window_days: number,
//     rows_in_window: number,
//     empty_in_window: number | null,
//     effective_empty_rate: number | null,
//     status: "ok" | "degraded" | "unknown",
//     note: string | null,
//     window_covered_h: number | null,  // hours actually covered by the scan,
//                                       // 1-decimal, capped at window_days*24
//                                       // when the cutoff was reached; null
//                                       // when no finite-ts row was seen
//     partial: boolean,                 // true ONLY when the byte budget
//                                       // stopped the scan before cutoff/BOF
//     bytes_scanned: number,            // total ledger bytes actually read
//   }
//
// status="unknown" when the source has no emptiness predicate OR the ledger
// is missing OR there are zero rows in the window. status="degraded" when
// effective_empty_rate > threshold.
export function computeEffectiveEmptyRate(source, opts = {}) {
  const now =
    opts.now instanceof Date
      ? opts.now.getTime()
      : typeof opts.now === "number"
        ? opts.now
        : Date.now();
  const windowDays =
    Number.isFinite(opts.windowDays) && opts.windowDays > 0
      ? opts.windowDays
      : DEFAULT_WINDOW_DAYS;
  const threshold =
    Number.isFinite(opts.threshold) && opts.threshold > 0 && opts.threshold <= 1
      ? opts.threshold
      : DEFAULT_EMPTY_RATE_THRESHOLD;
  const blockSize = _normalizeBlockSize(opts.blockSize);
  const maxScanBytes = _normalizeMaxScanBytes(opts.maxScanBytes);
  const cutoffMs = now - windowDays * 24 * 60 * 60 * 1000;

  const predicate = EMPTINESS_PREDICATES[source];
  const path =
    typeof opts.ledgerPath === "string" && opts.ledgerPath.length > 0
      ? opts.ledgerPath
      : _sourceLedgerPath(source);

  const base = {
    source,
    window_days: windowDays,
    rows_in_window: 0,
    empty_in_window: predicate ? 0 : null,
    effective_empty_rate: null,
    status: "unknown",
    note: null,
    window_covered_h: null,
    partial: false,
    bytes_scanned: 0,
  };

  // B2 — mail only. The snapshot ALWAYS carries `alias_candidates` for mail
  // (an array; [] until the scan summarizes, and [] on every early return
  // below) and NEVER for another source. The tally is built inside its own
  // try/catch so a construction failure — like every observe() and the
  // final summarize() — can never void the emptiness metric.
  let tally = null;
  if (source === "mail") {
    base.alias_candidates = [];
    try {
      tally = (opts.aliasTally || createAliasCandidateTally)();
      if (!tally || typeof tally.observe !== "function" || typeof tally.summarize !== "function") {
        tally = null;
      }
    } catch {
      tally = null;
    }
  }

  if (!predicate) {
    base.note = "no emptiness predicate for source";
    return base;
  }
  if (!existsSync(path)) {
    base.note = "source ledger missing";
    return base;
  }

  let rowsInWindow = 0;
  let emptyInWindow = 0;
  let oldestFiniteTs = null;
  let bytesScanned = 0;
  let cutoffReached = false;
  let stoppedForBudget = false;

  // Parse one complete line. Torn/garbage lines fail JSON.parse and are
  // skipped (existing discipline). A row older than the cutoff marks the
  // scan for stopping but does not abort the current block: the block's
  // remaining (newer, in-window) rows still get counted.
  const processLine = (line) => {
    if (line === "") return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    // Non-object rows (null, number, boolean, string, array) follow the SAME
    // skip discipline as unparseable lines: skipped, counted nowhere, never
    // reaching the scan-wide catch. Without this, a literal `null` line
    // throws TypeError at `parsed.ts` and voids the ENTIRE probe.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const ts = typeof parsed.ts === "string" ? Date.parse(parsed.ts) : NaN;
    if (!Number.isFinite(ts)) return;
    if (oldestFiniteTs === null || ts < oldestFiniteTs) oldestFiniteTs = ts;
    if (ts < cutoffMs) {
      cutoffReached = true;
      return;
    }
    rowsInWindow += 1;
    // B2 — recipient tally on the already-parsed in-window row; isolated
    // try/catch so a malformed header never reaches the scan-wide catch.
    if (tally) {
      try {
        tally.observe(parsed);
      } catch {}
    }
    const rc = parsed.raw_content;
    if (rc && typeof rc === "object" && predicate(rc)) {
      emptyInWindow += 1;
    }
  };

  let fd = -1;
  try {
    const st = statSync(path);
    if (st.size === 0) {
      base.note = "source ledger empty";
      return base;
    }
    fd = openSync(path, "r");

    // Backward block reader (fd discipline mirrors daemons/watermark.js
    // readLedgerTailTs: statSync -> openSync -> positioned readSync loop ->
    // closeSync in finally). Within each block, bytes BEFORE the first "\n"
    // are the tail of a line whose start lives in an earlier block; they are
    // held as `carry` and re-joined when that earlier block is read. Only
    // complete lines (plus the trailing unterminated last line of the EOF
    // block) are parsed.
    let carry = "";
    let offset = st.size;
    while (offset > 0 && !cutoffReached) {
      const readSize = Math.min(blockSize, offset);
      if (bytesScanned + readSize > maxScanBytes) {
        // Budget stop: reading this block would exceed the byte budget and
        // neither the cutoff nor BOF has been reached — the window is only
        // partially covered.
        stoppedForBudget = true;
        break;
      }
      const start = offset - readSize;
      const buf = Buffer.alloc(readSize);
      let read = 0;
      while (read < readSize) {
        const chunk = readSync(fd, buf, read, readSize - read, start + read);
        if (chunk === 0) break;
        read += chunk;
      }
      bytesScanned += read;
      offset = start;
      const text = buf.slice(0, read).toString("utf8") + carry;
      let body;
      if (offset > 0) {
        const idx = text.indexOf("\n");
        if (idx === -1) {
          // No newline in this block: the whole block is the middle of one
          // long line — keep accumulating it as carry.
          carry = text;
          continue;
        }
        carry = text.slice(0, idx);
        body = text.slice(idx + 1);
      } else {
        // BOF: everything is complete; nothing left to carry.
        carry = "";
        body = text;
      }
      // Lines run in file order (oldest-first) within the block, so the ts
      // ordering of the append-only ledger makes the cutoff check sound.
      for (const line of body.split("\n")) processLine(line);
    }
  } catch (err) {
    base.note = `read_error: ${err && err.code ? err.code : "unknown"}`;
    base.bytes_scanned = bytesScanned;
    return base;
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {}
    }
  }

  base.bytes_scanned = bytesScanned;
  base.partial = stoppedForBudget;
  if (source === "mail") {
    base.alias_candidates = tally ? _safeSummarize(tally) : [];
  }
  if (oldestFiniteTs !== null) {
    let coveredH = (now - oldestFiniteTs) / 3_600_000;
    const capH = windowDays * 24;
    if (cutoffReached && coveredH > capH) coveredH = capH;
    base.window_covered_h = Math.round(coveredH * 10) / 10;
  }
  base.rows_in_window = rowsInWindow;
  base.empty_in_window = emptyInWindow;
  if (rowsInWindow === 0) {
    base.note = "zero rows in window";
    return base;
  }
  const rate = emptyInWindow / rowsInWindow;
  base.effective_empty_rate = rate;
  base.status = rate > threshold ? "degraded" : "ok";
  return base;
}

// _safeSummarize — the tally's summarize() behind the same never-throw
// discipline as observe(): a throw or a non-array yields [] and the
// emptiness metric already computed above is untouched.
function _safeSummarize(tally) {
  try {
    const out = tally.summarize();
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

// computeEffectiveEmptyRatesForSources — convenience wrapper that loops the
// known sources (those with an emptiness predicate). The dispatcher's
// memory_connectors_list and memory_health surfaces both call this so a
// single tail-read pass surfaces every per-source signal. opts (now,
// ledgerPath, blockSize, maxScanBytes, ...) are forwarded verbatim.
export function computeEffectiveEmptyRatesForSources(opts = {}) {
  const sources =
    Array.isArray(opts.sources) && opts.sources.length > 0
      ? opts.sources
      : Object.keys(EMPTINESS_PREDICATES);
  const out = {};
  for (const src of sources) {
    out[src] = computeEffectiveEmptyRate(src, opts);
  }
  return out;
}

// Exported for tests + reuse by callers that want to inspect the per-source
// emptiness predicate without computing the full probe.
export function hasEmptinessPredicate(source) {
  return Object.prototype.hasOwnProperty.call(EMPTINESS_PREDICATES, source);
}

// buildEmptyRateHealthNotes — pure formatter for the health-note strings the
// memory_health surface emits from a snapshotsBySource map (the shape
// computeEffectiveEmptyRatesForSources returns). Extracted from
// lib/tools/health.js so it is hermetically testable; for numeric
// window_covered_h the output is byte-identical to the strings health.js
// assembled inline. The one behavior change: window_covered_h can be null on
// a partial scan that saw no finite-ts row (e.g. a tiny byte budget), and
// interpolating that verbatim rendered "covered nullh of 168h" — the
// coveredLabel guard renders "unknown" instead.
export function buildEmptyRateHealthNotes(snapshotsBySource) {
  const notes = [];
  if (!snapshotsBySource || typeof snapshotsBySource !== "object") return notes;
  for (const [src, snapshot] of Object.entries(snapshotsBySource)) {
    if (!snapshot) continue;
    const coveredLabel =
      typeof snapshot.window_covered_h === "number"
        ? `${snapshot.window_covered_h}h`
        : "unknown";
    if (snapshot.status === "degraded") {
      const rate = snapshot.effective_empty_rate;
      const ratePct =
        typeof rate === "number"
          ? Math.round(rate * 1000) / 10
          : "unknown";
      // Honest window label: when the byte budget truncated the scan the
      // note states the hours actually covered instead of claiming the
      // full window_days.
      const windowLabel =
        snapshot.partial === true
          ? `over last ${coveredLabel} (PARTIAL, budget-truncated)`
          : `over last ${snapshot.window_days}d`;
      notes.push(
        `source_effective_empty_rate_degraded: ${src} ${ratePct}% empty ${windowLabel} (${snapshot.empty_in_window}/${snapshot.rows_in_window} rows)`
      );
    }
    // Any budget-truncated snapshot (degraded or not) is surfaced so the
    // operator never silently accepts a metric over a truncated window.
    // Notes are the only channel: the health payload key set is closed
    // (health-real-data.test.mjs asserts the exact AUTHORITATIVE_FIELDS).
    if (snapshot.partial === true) {
      notes.push(
        `source_effective_empty_rate_partial: ${src} scan covered ${coveredLabel} of ${snapshot.window_days * 24}h (bytes_scanned=${snapshot.bytes_scanned})`
      );
    }
  }
  return notes;
}
