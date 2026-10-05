#!/usr/bin/env node
// verify-mail-body-coverage.mjs — g3 (mail body resolution).
//
// WHY THIS EXISTS
// ---------------
// The sibling gate (verify-mail-reply-linkage.mjs) states its own ceiling up
// front: "body_resolved is true on ~2.55% of real mail rows". That figure has
// been read, repeatedly, as "the mail connector cannot resolve bodies", and a
// by-year table of the deficit reinforced the reading by pinning it on message
// AGE. Both readings are wrong, and this gate is what falsifies them.
//
// The deficit lives on the ledger's APPEND-ORDER axis, not the calendar axis.
// A contiguous PREFIX of the append-only mail ledger was written by the
// pre-b7b1d04 resolver, which looked for an .emlx basename that never exists
// on disk; every one of those rows is frozen at body_resolved=false and the
// cursor-advancing connector can never revisit them. Everything appended after
// that boundary resolves at ~81%.
//
// WHAT IT PRINTS (four distinct numbers, NEVER collapsed into one)
//   rows_total                 every row in the ledger
//   resolved_total             rows with body_resolved===true (+ the corpus
//                              rate — the ~2.6% figure, printed WITH its cause
//                              attached, never on its own)
//   frozen_prefix_rows         rows appended before the first resolved row
//   live_suffix_resolved_rate  what the connector does today
//
// plus the boundary itself (boundary_index / boundary_source_msg_id /
// boundary_ts) so a reviewer can independently confirm the claim: no
// body_resolved=true row exists anywhere before the reported boundary line.
//
// AND THE FALSIFIER. `frozen_prefix_dominates` is false when the suffix
// contains an unresolved run as long as the prefix — i.e. when the pattern is
// interleaved and the "boundary" is an artifact rather than a regime change.
// A gate that could only ever confirm its own story would not be a gate.
//
// NO LEDGER SLURPING. mail.jsonl is 387MB and ERR_STRING_TOO_LONG on a growing
// ledger is a RECORDED LIVE DEFECT CLASS in this repo. The measurement streams
// inside lib/connectors/mail-body-coverage.js and the file is NEVER allocated
// as one string. readFileSync on this ledger is forbidden here as much as in
// shipped code.
//
// COUNTING CAVEAT, PRINTED RATHER THAN ASSUMED. Reading this ledger with
// node:readline silently UNDERCOUNTS it: readline also breaks on U+2028 /
// U+2029, which JSON.stringify does not escape, so a row carrying one in its
// subject or body is torn into two unparseable fragments and vanishes with no
// error (measured: 104 rows, 77 of them resolved). The module splits on "\n"
// only, and this gate prints lines_total / lines_skipped so any future torn
// write shows up as a number instead of a quiet deficit.
//
// STRICTLY READ-ONLY. This file contains no write call of any kind: no cursor,
// no tmp file, no log, no daemon signal. It opens exactly one path for reading
// and prints to stdout.
//
// PII / LOG DISCIPLINE. Counts, rates, one local Apple-Mail rowid and one
// timestamp. No RFC message-id, no address, no subject, no mailbox path and no
// body text is ever printed — including in the refusal payload.
//
// USAGE
//   node mcp/scripts/verify-mail-body-coverage.mjs [--ledger=PATH]
//
//   --ledger=PATH  default: sourceLedgerPath("mail") (lib/config.js). Fixture
//                  injection point; the module is otherwise hermetic.
//   --help         this text (exit 2 — exit 0 means "measured").
//
// EXIT CODES
//   0  measured — the stream completed over the whole file.
//   2  refuse   — bad arguments, --help, or an unreadable/missing ledger.
//                 Nothing measurable, so no numbers are printed as if they
//                 were: every count stays null rather than degrading to 0.
//
// Output: exactly ONE line of JSON on stdout in EVERY case, including
// refusals, so a refusal is as auditable as a measurement.

import { measureMailBodyCoverage } from "../lib/connectors/mail-body-coverage.js";

function emit(payload, code) {
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(code);
}

async function main() {
  const args = process.argv.slice(2);
  let ledger = null;
  for (const a of args) {
    if (a === "--help" || a === "-h") {
      emit({ verdict: "refuse", reason: "help" }, 2);
    } else if (a.startsWith("--ledger=")) {
      ledger = a.slice("--ledger=".length);
    } else {
      emit({ verdict: "refuse", reason: "bad_argument" }, 2);
    }
  }

  const m = await measureMailBodyCoverage(ledger ? { ledgerPath: ledger } : {});
  if (!m.ok) {
    emit({ verdict: "refuse", reason: m.reason || "unmeasurable" }, 2);
  }

  emit(
    {
      verdict: "measured",
      measured_at: m.measured_at,

      // ---- the four numbers, kept apart on purpose -------------------------
      // 1. the whole corpus
      rows_total: m.rows_total,
      // 2. how many of it resolved, and the headline rate — printed WITH the
      //    two numbers below, which are what explain it. Never alone.
      resolved_total: m.resolved_total,
      corpus_resolved_rate: m.corpus_resolved_rate,
      // 3. the frozen prefix: rows the fixed resolver can never revisit
      frozen_prefix_rows: m.frozen_prefix_rows,
      // 4. what the connector actually does today
      live_suffix_rows: m.live_suffix_rows,
      live_suffix_resolved: m.live_suffix_resolved,
      live_suffix_resolved_rate: m.live_suffix_resolved_rate,

      // ---- the append-order finding, stated so it can be checked -----------
      // boundary_index is a ROW ordinal; boundary_line is the 1-indexed FILE
      // line. They differ by lines_skipped, and both are printed so a reviewer
      // greps the right line instead of one 27 places off.
      boundary_index: m.boundary_index,
      boundary_line: m.boundary_line,
      lines_total: m.lines_total,
      lines_skipped: m.lines_skipped,
      boundary_source_msg_id: m.boundary_source_msg_id,
      boundary_ts: m.boundary_ts,
      suffix_max_unresolved_run: m.suffix_max_unresolved_run,
      frozen_prefix_dominates: m.frozen_prefix_dominates,
      finding:
        m.frozen_prefix_dominates === true
          ? "append_order_frozen_prefix: the deficit is a contiguous prefix of the append-only ledger written by the pre-fix resolver, NOT a function of message age; no body_resolved=true row exists before boundary_index"
          : "not_prefix_shaped: resolution is interleaved across the ledger, so the deficit must NOT be described as a frozen prefix",
    },
    0
  );
}

main().catch((err) => {
  emit(
    {
      verdict: "refuse",
      reason: "unexpected",
      error_kind: err && err.code ? String(err.code) : "unknown",
    },
    2
  );
});
