#!/usr/bin/env node
// verify-mail-reply-linkage.mjs — g2 (mail thread headers).
//
// WHY THIS EXISTS
// ---------------
// g2 makes the mail connector surface "in-reply-to" and "references" on
// raw_content.headers. Landing a field is not the same as landing a USABLE
// field: a reply pointer is only worth anything if the message it points AT is
// also in the ledger. That is a join, and a join either closes or it does not.
// This gate measures the closure rate against the real ledger and reports it as
// three separate numbers, so "we now capture reply linkage" cannot be sold as
// "we can now reconstruct threads" without the evidence being visible.
//
// WHAT IT REPORTS (three distinct numbers, never collapsed into one)
//   present   rows whose raw_content.headers carries the "in-reply-to" KEY at
//             all. Pre-g2 rows do not have the key; post-g2 rows always do.
//             This is the deployment-coverage number.
//   non_null  of those, how many carry an actual value. A null is the honest
//             answer for a message that is not a reply, and for every row whose
//             body never resolved.
//   resolved  of the non-null ones, how many name a Message-ID that is ALSO
//             present somewhere in this ledger. This is the only number that
//             says whether the linkage is USABLE.
//
// THE CEILING THIS WILL EXPOSE, STATED UP FRONT
// ---------------------------------------------
// Every header here is gated behind body resolution, and body_resolved is true
// on ~2.55% of real mail rows. So `non_null` is bounded far below `present` for
// reasons that have nothing to do with this change, and `resolved` is bounded
// below that again because a parent that was never body-resolved has no
// message-id in the ledger to match. Measured at source ahead of the change:
// 7/164 In-Reply-To values resolved (4.3%). The misses are dominated by parents
// that were never body-resolved, NOT by parents predating the capture window.
// If this script prints a low resolution rate, that is the finding, not a bug.
//
// NO LEDGER SLURPING. mail.jsonl is 382MB and ERR_STRING_TOO_LONG on a growing
// ledger is a RECORDED LIVE DEFECT CLASS in this repo. Both passes stream with
// createReadStream + readline — the same idiom readReplyHistoryContacts uses in
// lib/messaging/contact-spine.js — and the file is NEVER allocated as one
// string. readFileSync on the ledger is forbidden here as much as in shipped
// code.
//
// MAILBOX-COPY FAN-OUT IS NOT A DUPLICATE. One Gmail send appears as up to 3
// ledger rows sharing one Message-ID (measured max fan-out 3). Pass 1 therefore
// builds a SET of ids, not a count of rows, and a parent matching several rows
// is one resolution, not several — and never a duplicate-ingest defect.
//
// STRICTLY READ-ONLY. This file contains no write call of any kind: no cursor,
// no tmp file, no log, no daemon signal. It opens exactly one path for reading
// and prints to stdout.
//
// PII / LOG DISCIPLINE. Counts and rates only. No message-id, no address, no
// subject and no body text is ever printed — including in the refusal payload.
//
// USAGE
//   node mcp/scripts/verify-mail-reply-linkage.mjs
//     [--ledger=PATH] [--tail=N] [--ids-ledger=PATH ...]
//
//   --ledger=PATH      default: sourceLedgerPath("mail") (lib/config.js). The
//                      file the three numbers are COUNTED over.
//   --tail=N           restrict pass 2's counting to the last N rows, to
//                      measure the post-change window rather than the whole
//                      history. The message-id SET is still built from the
//                      WHOLE file — a parent may well predate the tail, and
//                      scoping the set to the tail would manufacture misses.
//   --ids-ledger=PATH  repeatable. An ADDITIONAL ledger streamed in pass 1
//                      ONLY, to widen the Message-ID set. Exists because a
//                      parent can sit in a ledger the measured window does not
//                      cover — scoring a child against a set that could not
//                      contain its parent understates closure and would be a
//                      manufactured miss, not a measurement.
//   --help             this text (exit 2 — exit 0 means "measured").
//
// EXIT CODES
//   0  measured — both passes completed over the whole file.
//   2  refuse   — bad arguments, --help, or an unreadable ledger. Nothing
//                 measurable, so no numbers are printed as if they were.
//
// Output: exactly ONE line of JSON on stdout in EVERY case, including
// refusals, so a refusal is as auditable as a measurement.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { sourceLedgerPath } from "../lib/config.js";

function emit(payload, code) {
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(code);
}

// Parse the RFC 5322 msg-id tokens out of a header value. Same shape as
// _messageIds in lib/messaging/adapters/mail.js — deliberately restated rather
// than imported, because this gate must measure the LEDGER BYTES as they are,
// not whatever the adapter would make of them.
function messageIds(value) {
  if (typeof value !== "string") return [];
  const ids = value.match(/<[^<>]+>/g);
  return ids ? ids.map((s) => s.trim()) : [];
}

async function* streamRows(path) {
  const rl = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a malformed line is skipped, never fatal
    }
    yield row;
  }
}

function headersOf(row) {
  const rc = row && row.raw_content;
  const h = rc && rc.headers;
  return h && typeof h === "object" ? h : null;
}

async function main() {
  const args = process.argv.slice(2);
  let ledger = null;
  let tail = null;
  const idsLedgers = [];
  for (const a of args) {
    if (a === "--help" || a === "-h") {
      emit({ verdict: "refuse", reason: "help" }, 2);
    } else if (a.startsWith("--ledger=")) {
      ledger = a.slice("--ledger=".length);
    } else if (a.startsWith("--ids-ledger=")) {
      idsLedgers.push(a.slice("--ids-ledger=".length));
    } else if (a.startsWith("--tail=")) {
      tail = Number.parseInt(a.slice("--tail=".length), 10);
      if (!Number.isFinite(tail) || tail <= 0) {
        emit({ verdict: "refuse", reason: "bad_tail" }, 2);
      }
    } else {
      emit({ verdict: "refuse", reason: "bad_argument" }, 2);
    }
  }
  const path = ledger || sourceLedgerPath("mail");

  // ---------------------------------------------------------------------
  // PASS 1 — build the Message-ID SET over the WHOLE file, and count rows so
  // the tail window of pass 2 can be positioned. Streamed; never slurped.
  // ---------------------------------------------------------------------
  const messageIdSet = new Set();
  let totalRows = 0;
  let bodyResolvedRows = 0;
  try {
    for await (const row of streamRows(path)) {
      totalRows += 1;
      const rc = row && row.raw_content;
      if (rc && rc.body_resolved === true) bodyResolvedRows += 1;
      const h = headersOf(row);
      if (!h) continue;
      // Fan-out: several rows may carry the SAME id. A Set is the point.
      for (const id of messageIds(h["message-id"])) messageIdSet.add(id);
    }
  } catch (err) {
    emit({
      verdict: "refuse",
      reason: "ledger_unreadable",
      pass: 1,
      error_kind: err && err.code ? String(err.code) : "unknown",
    }, 2);
  }

  // Widen the id set with any --ids-ledger files. Streamed, same as pass 1, and
  // counted only into the SET — these rows never enter the three numbers. An
  // unreadable one is a refusal: a widening the operator explicitly asked for
  // and silently did not get would turn a miss into a fabricated finding.
  const idsOnlyRows = [];
  for (const extra of idsLedgers) {
    let seen = 0;
    try {
      for await (const row of streamRows(extra)) {
        seen += 1;
        const h = headersOf(row);
        if (!h) continue;
        for (const id of messageIds(h["message-id"])) messageIdSet.add(id);
      }
    } catch (err) {
      emit({
        verdict: "refuse",
        reason: "ids_ledger_unreadable",
        error_kind: err && err.code ? String(err.code) : "unknown",
      }, 2);
    }
    idsOnlyRows.push(seen);
  }

  const windowStart = tail == null ? 0 : Math.max(0, totalRows - tail);

  // ---------------------------------------------------------------------
  // PASS 2 — count the three numbers over the window. Streamed again rather
  // than held in memory from pass 1, because holding 288k parsed rows is the
  // slurp this gate exists to avoid.
  // ---------------------------------------------------------------------
  let scanned = 0;
  let windowRows = 0;
  let windowBodyResolved = 0;
  let irtKeyPresent = 0;
  let irtNonNull = 0;
  let irtResolved = 0;
  let refsKeyPresent = 0;
  let refsNonNull = 0;
  let refsAnyAncestorResolved = 0;
  let refsRootResolved = 0;
  let refsParentResolved = 0;
  try {
    for await (const row of streamRows(path)) {
      const ordinal = scanned;
      scanned += 1;
      if (ordinal < windowStart) continue;
      windowRows += 1;
      const rc = row && row.raw_content;
      if (rc && rc.body_resolved === true) windowBodyResolved += 1;
      const h = headersOf(row);
      if (!h) continue;

      if ("in-reply-to" in h) irtKeyPresent += 1;
      const irtIds = messageIds(h["in-reply-to"]);
      if (irtIds.length > 0) {
        irtNonNull += 1;
        // In-Reply-To names ONE parent; take the first token.
        if (messageIdSet.has(irtIds[0])) irtResolved += 1;
      }

      if ("references" in h) refsKeyPresent += 1;
      const refIds = messageIds(h["references"]);
      if (refIds.length > 0) {
        refsNonNull += 1;
        if (refIds.some((id) => messageIdSet.has(id))) refsAnyAncestorResolved += 1;
        // The two ends the adapter actually reads: refs[0] is the thread ROOT
        // (_threadId) and refs[last] is the immediate PARENT (_replyToId).
        if (messageIdSet.has(refIds[0])) refsRootResolved += 1;
        if (messageIdSet.has(refIds[refIds.length - 1])) refsParentResolved += 1;
      }
    }
  } catch (err) {
    emit({
      verdict: "refuse",
      reason: "ledger_unreadable",
      pass: 2,
      error_kind: err && err.code ? String(err.code) : "unknown",
    }, 2);
  }

  const rate = (num, den) => (den > 0 ? Number((num / den).toFixed(6)) : null);

  emit({
    verdict: "measured",
    ledger_rows_total: totalRows,
    body_resolved_total: bodyResolvedRows,
    body_resolved_rate: rate(bodyResolvedRows, totalRows),
    distinct_message_ids: messageIdSet.size,
    ids_ledgers: idsLedgers.length === 0 ? null : { count: idsLedgers.length, rows: idsOnlyRows },
    window: {
      tail: tail,
      start_ordinal: windowStart,
      rows: windowRows,
      body_resolved: windowBodyResolved,
    },
    in_reply_to: {
      key_present: irtKeyPresent,
      non_null: irtNonNull,
      resolved: irtResolved,
      // The headline: of the pointers we HAVE, how many point at something we
      // also have. This is the only number that says the linkage is usable.
      resolution_rate: rate(irtResolved, irtNonNull),
      non_null_rate_of_body_resolved: rate(irtNonNull, windowBodyResolved),
      key_present_rate: rate(irtKeyPresent, windowRows),
    },
    references: {
      key_present: refsKeyPresent,
      non_null: refsNonNull,
      resolved_any_ancestor: refsAnyAncestorResolved,
      resolved_root: refsRootResolved,
      resolved_parent: refsParentResolved,
      resolution_rate: rate(refsAnyAncestorResolved, refsNonNull),
      non_null_rate_of_body_resolved: rate(refsNonNull, windowBodyResolved),
      key_present_rate: rate(refsKeyPresent, windowRows),
    },
  }, 0);
}

main().catch((err) => {
  emit({
    verdict: "refuse",
    reason: "unexpected",
    error_kind: err && err.code ? String(err.code) : "unknown",
  }, 2);
});
