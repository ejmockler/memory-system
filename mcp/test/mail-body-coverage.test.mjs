// mail-body-coverage.test.mjs — g3 gate for the mail body-resolution
// measurement (lib/connectors/mail-body-coverage.js).
//
// WHAT IS BEING GATED. The claim this node makes is not "mail resolves badly"
// — it is a claim about SHAPE: the ~2.6% corpus figure is a frozen PREFIX of
// the append-only ledger, and the live suffix resolves far better. That claim
// is only worth anything if the measurement can also REFUSE to make it. So the
// suite pins four cases, each with a demonstrated failure mode:
//
//   (a) prefix-shaped ledger — the boundary index, the frozen-prefix count and
//       the suffix rate are reported SEPARATELY and correctly, and the corpus
//       rate is never substituted for the suffix rate. Fails iff the four
//       numbers get collapsed or the boundary drifts off the first resolved
//       row.
//   (b) all-resolved ledger — frozen_prefix_rows === 0 and NO frozen-prefix
//       health note. Fails iff the note fires on a healthy ledger.
//   (c) interleaved ledger — the module reports frozen_prefix_dominates=false
//       rather than dressing a scattered pattern as a clean boundary. This is
//       the falsifiability proof: a gate that could only ever confirm its own
//       story is not a gate.
//   (d) mail emptiness predicate — hasEmptinessPredicate('mail') is true and
//       the existing bounded backward scan computes a real rate for it. Fails
//       iff the predicate is dropped and health goes silent on mail again.
//
// HERMETIC. Every fixture is written under mkdtempSync and injected via
// opts.ledgerPath / opts.now. MEMORY_ROOT + STORAGE_BASE_DIR are pinned to the
// scratch BEFORE any import touches config.js, so a bug that ignored
// ledgerPath would read an EMPTY scratch ledger and fail the assertions —
// never the operator's real 387MB mail.jsonl or ~/Library/Mail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Hermetic env MUST be set before any import touches config.js ----------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-mail-body-coverage-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
mkdirSync(join(process.env.STORAGE_BASE_DIR, "sources"), {
  recursive: true,
  mode: 0o700,
});
process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort scratch cleanup */
  }
});

const {
  measureMailBodyCoverage,
  probeMailLedgerHead,
  buildMailBodyCoverageHealthNotes,
  MAX_HEAD_PROBE_BYTES,
} = await import("../lib/connectors/mail-body-coverage.js");
const { computeEffectiveEmptyRate, hasEmptinessPredicate } = await import(
  "../lib/ingest/source-effective-empty-rate.js"
);
const { runtimeCensusConvention } = await import(
  "../scripts/audit-source-claims.mjs"
);

const NOW = Date.parse("2026-08-28T12:00:00.000Z");

test("marked mail-coverage census comment names a producer and embeds no result", () => {
  const source = new URL("../lib/connectors/mail-body-coverage.js", import.meta.url);
  const audit = runtimeCensusConvention(
    readFileSync(source, "utf8"),
    "lib/connectors/mail-body-coverage.js",
  );
  assert.ok(audit.paragraphs.length > 0, "expected a RUNTIME-CENSUS convention marker");
  assert.deepEqual(audit.violations, [], JSON.stringify(audit.violations, null, 2));
});

// Production-shaped mail row: raw_content.text is null exactly when body
// resolution failed, and body_resolved mirrors it (mail.js:723
// `body_resolved: extracted != null`). The fixture keeps those two in the
// same relationship the connector guarantees; decoupling them here would let
// the suite pass against a module that read the wrong field.
function row(rowid, resolved, tsMs) {
  return JSON.stringify({
    id: `m${rowid}`,
    ts: new Date(tsMs).toISOString(),
    source: "mail",
    source_msg_id: `rowid:${rowid}`,
    raw_content: {
      text: resolved ? "body bytes" : null,
      subject: "s",
      headers: {},
      body_resolved: resolved,
    },
  });
}

// Write a ledger from a resolution PATTERN (array of booleans, file order).
// Timestamps march forward one minute per row and end just before `now`, so
// the whole fixture sits inside the backward scan's 7-day window.
function writeLedger(name, pattern) {
  const path = join(TMP_ROOT, `${name}.jsonl`);
  const startMs = NOW - pattern.length * 60_000;
  const lines = pattern.map((resolved, i) =>
    row(1000 + i, resolved, startMs + i * 60_000)
  );
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
  return path;
}

const rep = (v, n) => Array.from({ length: n }, () => v);

// ---------------------------------------------------------------------------
// (a) prefix-shaped ledger: 40 bodyless rows, then a suffix that resolves at
//     80% (32 of 40) — deliberately imperfect, because the real live suffix is
//     81% and a suite built on a 100% suffix would not notice a module that
//     confused "suffix" with "resolved rows".
// ---------------------------------------------------------------------------
test("(a) prefix-shaped ledger reports four numbers separately, not collapsed", async () => {
  // suffix pattern: resolved, then repeating [4x resolved, 1x unresolved]
  const suffix = [true];
  for (let i = 0; i < 39; i += 1) suffix.push(i % 5 !== 4);
  const pattern = [...rep(false, 40), ...suffix];
  const path = writeLedger("prefix-shaped", pattern);

  const m = await measureMailBodyCoverage({ ledgerPath: path, now: NOW });
  assert.equal(m.ok, true);
  assert.equal(m.reason, null);

  const expectedResolved = suffix.filter(Boolean).length;
  assert.equal(m.rows_total, 80);
  assert.equal(m.resolved_total, expectedResolved);

  // The frozen prefix is its own number and is NOT the corpus deficit.
  assert.equal(m.frozen_prefix_rows, 40);
  assert.equal(m.boundary_index, 40);
  assert.equal(m.boundary_source_msg_id, "rowid:1040");
  assert.ok(typeof m.boundary_ts === "string" && m.boundary_ts.endsWith("Z"));

  // The live suffix runs from the boundary row INCLUSIVE to EOF.
  assert.equal(m.live_suffix_rows, 40);
  assert.equal(m.live_suffix_resolved, expectedResolved);
  assert.equal(m.live_suffix_resolved_rate, Number((expectedResolved / 40).toFixed(6)));

  // The whole point: the corpus rate and the suffix rate are DIFFERENT numbers
  // and both survive to the caller. Collapsing them is the defect this gate
  // exists to catch.
  assert.equal(m.corpus_resolved_rate, Number((expectedResolved / 80).toFixed(6)));
  assert.ok(m.live_suffix_resolved_rate > m.corpus_resolved_rate * 1.9);

  // Prefix-shaped: the longest unresolved run inside the suffix (1) is far
  // shorter than the prefix (40).
  assert.equal(m.suffix_max_unresolved_run, 1);
  assert.equal(m.frozen_prefix_dominates, true);

  // Independent confirmation of the boundary claim, done the way a reviewer
  // would: no resolved row may exist at any ordinal below boundary_index.
  assert.equal(
    pattern.slice(0, m.boundary_index).some(Boolean),
    false,
    "a body_resolved=true row exists before the reported boundary"
  );
});

// ---------------------------------------------------------------------------
// (b) all-resolved ledger: no frozen prefix, and no note.
// ---------------------------------------------------------------------------
test("(b) all-resolved ledger has frozen_prefix_rows=0 and emits no frozen-prefix note", async () => {
  const path = writeLedger("all-resolved", rep(true, 30));

  const m = await measureMailBodyCoverage({ ledgerPath: path, now: NOW });
  assert.equal(m.ok, true);
  assert.equal(m.rows_total, 30);
  assert.equal(m.resolved_total, 30);
  assert.equal(m.frozen_prefix_rows, 0);
  assert.equal(m.boundary_index, 0);
  assert.equal(m.live_suffix_rows, 30);
  assert.equal(m.live_suffix_resolved_rate, 1);
  assert.equal(m.suffix_max_unresolved_run, 0);
  // 0 > 0 is false: an all-resolved ledger has no frozen-prefix story either.
  assert.equal(m.frozen_prefix_dominates, false);

  const head = probeMailLedgerHead({ ledgerPath: path });
  assert.equal(head.ok, true);
  assert.ok(head.rows_sampled > 0);
  assert.equal(head.resolved_in_head, 30);
  assert.equal(head.head_bodyless, false);

  const snapshot = computeEffectiveEmptyRate("mail", { ledgerPath: path, now: NOW });
  assert.equal(snapshot.status, "ok");
  assert.deepEqual(buildMailBodyCoverageHealthNotes(head, snapshot), []);
});

// ---------------------------------------------------------------------------
// (c) interleaved ledger: the falsifier. One early resolved row makes a
//     boundary LOOK clean; the module must refuse to call it a frozen prefix.
// ---------------------------------------------------------------------------
test("(c) interleaved ledger is reported honestly, not as a clean boundary", async () => {
  const pattern = [...rep(false, 5), true, ...rep(false, 50), ...rep(true, 5)];
  const path = writeLedger("interleaved", pattern);

  const m = await measureMailBodyCoverage({ ledgerPath: path, now: NOW });
  assert.equal(m.ok, true);
  assert.equal(m.rows_total, 61);
  assert.equal(m.resolved_total, 6);

  // The naive boundary is real and is reported as such...
  assert.equal(m.frozen_prefix_rows, 5);
  assert.equal(m.boundary_index, 5);
  assert.equal(m.boundary_source_msg_id, "rowid:1005");

  // ...but the suffix hides a 50-row unresolved run, longer than the prefix.
  assert.equal(m.suffix_max_unresolved_run, 50);
  assert.equal(
    m.frozen_prefix_dominates,
    false,
    "a scattered pattern must NOT be reported as a frozen prefix"
  );

  // Contrast proof: the same module DOES claim prefix shape when the shape is
  // really there. Without this, `frozen_prefix_dominates` could be hardwired
  // false and case (c) would still pass.
  const shaped = await measureMailBodyCoverage({
    ledgerPath: writeLedger("interleaved-contrast", [...rep(false, 60), ...rep(true, 20)]),
    now: NOW,
  });
  assert.equal(shaped.frozen_prefix_dominates, true);
});

// ---------------------------------------------------------------------------
// (d) the mail emptiness predicate — the one channel that puts the LIVE rate
//     into health without touching the closed envelope.
// ---------------------------------------------------------------------------
test("(d) mail has an emptiness predicate and the bounded backward scan rates it", () => {
  assert.equal(
    hasEmptinessPredicate("mail"),
    true,
    "without a mail predicate, computeEffectiveEmptyRatesForSources skips mail and health says nothing about mail content at all"
  );

  // 20 rows, 15 bodyless -> 75% empty, over the degraded threshold (0.5).
  const path = writeLedger("empty-rate", [...rep(false, 15), ...rep(true, 5)]);
  const snapshot = computeEffectiveEmptyRate("mail", { ledgerPath: path, now: NOW });
  assert.equal(snapshot.source, "mail");
  assert.equal(snapshot.rows_in_window, 20);
  assert.equal(snapshot.empty_in_window, 15);
  assert.equal(snapshot.effective_empty_rate, 0.75);
  assert.equal(snapshot.status, "degraded");
  assert.equal(snapshot.partial, false);

  // And the frozen-prefix note DOES fire when the head is bodyless while the
  // tail resolves — the shape of the real ledger. headBytes is scaled down to
  // the fixture: on the live 387MB ledger the default 256KB window samples
  // ~235 rows and lands entirely inside a 279k-row prefix, but on an 80-row
  // fixture it would swallow the resolving suffix too and (correctly) report
  // the head as not bodyless.
  const livePath = writeLedger("frozen-prefix-note", [...rep(false, 40), ...rep(true, 40)]);
  const head = probeMailLedgerHead({ ledgerPath: livePath, headBytes: 4096 });
  assert.equal(head.head_bodyless, true);
  const liveSnapshot = computeEffectiveEmptyRate("mail", {
    ledgerPath: livePath,
    now: NOW,
  });
  const notes = buildMailBodyCoverageHealthNotes(head, liveSnapshot);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^mail_body_frozen_prefix: /);
  assert.match(notes[0], /envelope-only/);
  // PII / log discipline: counts and rates only.
  assert.doesNotMatch(notes[0], /@|Subject|\.emlx|mailbox/i);
});

// ---------------------------------------------------------------------------
// Bounds + degradation discipline. These are the invariants health depends on:
// the probe must never read the whole ledger, and an unmeasurable scan must
// report null counts rather than a confident zero.
// ---------------------------------------------------------------------------
test("head probe is bounded and never full-reads the ledger", () => {
  const path = writeLedger("bounded", rep(false, 400));
  const head = probeMailLedgerHead({ ledgerPath: path, headBytes: 2048 });
  assert.equal(head.ok, true);
  assert.equal(head.bytes_read, 2048);
  assert.ok(head.rows_sampled > 0 && head.rows_sampled < 400);
  assert.equal(head.head_bodyless, true);

  // A hostile blockSize cannot escalate into a whole-file allocation.
  const clamped = probeMailLedgerHead({ ledgerPath: path, headBytes: 2 ** 40 });
  assert.ok(clamped.bytes_read <= MAX_HEAD_PROBE_BYTES);
});

test("a missing ledger yields nulls and a refusal, never measured zeros", async () => {
  const missing = join(TMP_ROOT, "does-not-exist.jsonl");

  const m = await measureMailBodyCoverage({ ledgerPath: missing, now: NOW });
  assert.equal(m.ok, false);
  assert.equal(m.reason, "ledger_missing");
  assert.equal(m.rows_total, null);
  assert.equal(m.resolved_total, null);
  assert.equal(m.frozen_prefix_rows, null);
  assert.equal(m.live_suffix_resolved_rate, null);

  const head = probeMailLedgerHead({ ledgerPath: missing });
  assert.equal(head.ok, false);
  assert.equal(head.head_bodyless, false);
  assert.deepEqual(buildMailBodyCoverageHealthNotes(head, null), []);
});

test("malformed and non-object lines are skipped, never fatal", async () => {
  const path = join(TMP_ROOT, "malformed.jsonl");
  writeFileSync(
    path,
    [
      row(1, false, NOW - 3 * 60_000),
      "{ not json",
      "null",
      "[1,2,3]",
      row(2, true, NOW - 2 * 60_000),
      row(3, true, NOW - 60_000),
    ].join("\n") + "\n",
    { mode: 0o600 }
  );

  const m = await measureMailBodyCoverage({ ledgerPath: path, now: NOW });
  assert.equal(m.ok, true);
  assert.equal(m.rows_total, 3);
  assert.equal(m.resolved_total, 2);
  assert.equal(m.frozen_prefix_rows, 1);
  assert.equal(m.boundary_source_msg_id, "rowid:2");
});

// ---------------------------------------------------------------------------
// The undercount pin. node:readline breaks on U+2028 / U+2029, which
// JSON.stringify does NOT escape, so a mail row carrying one in its subject or
// body is torn into two unparseable fragments and disappears from the counts
// with no error anywhere. Measured on the real ledger: 104 rows lost, 77 of
// them resolved, and the boundary ordinal displaced 27 places off its file
// line. For a gate whose whole product is four counts, that is the worst
// available failure mode — so it gets a pin. This suite goes red if anyone
// "simplifies" _streamLines back to createInterface().
// ---------------------------------------------------------------------------
test("rows containing U+2028 are counted, not silently torn away", async () => {
  const path = join(TMP_ROOT, "u2028.jsonl");
  const withSep = (rowid, resolved, tsMs) =>
    JSON.stringify({
      id: `m${rowid}`,
      ts: new Date(tsMs).toISOString(),
      source: "mail",
      source_msg_id: `rowid:${rowid}`,
      raw_content: {
        // U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR, written as
        // \u escapes so no editor can silently normalize the fixture away.
        // JSON.stringify emits them UNESCAPED into the ledger byte stream —
        // that is exactly what the connector does, and exactly the defect.
        text: resolved ? "before\u2028after\u2029end" : null,
        subject: "sub\u2028ject",
        headers: {},
        body_resolved: resolved,
      },
    });
  writeFileSync(
    path,
    [
      withSep(1, false, NOW - 4 * 60_000),
      withSep(2, false, NOW - 3 * 60_000),
      withSep(3, true, NOW - 2 * 60_000),
      withSep(4, true, NOW - 60_000),
    ].join("\n") + "\n",
    { mode: 0o600 }
  );

  const m = await measureMailBodyCoverage({ ledgerPath: path, now: NOW });
  assert.equal(m.ok, true);
  assert.equal(m.rows_total, 4, "U+2028-bearing rows were dropped from the count");
  assert.equal(m.lines_total, 4);
  assert.equal(m.lines_skipped, 0, "a torn fragment would show up here");
  assert.equal(m.resolved_total, 2);
  assert.equal(m.frozen_prefix_rows, 2);
  assert.equal(m.boundary_source_msg_id, "rowid:3");
  // boundary_line is the 1-indexed FILE line a reviewer greps for.
  assert.equal(m.boundary_line, 3);
  assert.equal(m.boundary_line, m.boundary_index + m.lines_skipped + 1);

  // The head probe splits the same way and must agree.
  const head = probeMailLedgerHead({ ledgerPath: path });
  assert.equal(head.rows_sampled, 4);
  assert.equal(head.resolved_in_head, 2);
});

test("boundary_line accounts for skipped lines so a reviewer greps the right line", async () => {
  const path = join(TMP_ROOT, "boundary-line-offset.jsonl");
  writeFileSync(
    path,
    [
      row(1, false, NOW - 5 * 60_000),
      "{ torn fragment",
      "",
      row(2, true, NOW - 3 * 60_000),
    ].join("\n") + "\n",
    { mode: 0o600 }
  );
  const m = await measureMailBodyCoverage({ ledgerPath: path, now: NOW });
  assert.equal(m.lines_total, 4);
  assert.equal(m.lines_skipped, 2);
  assert.equal(m.rows_total, 2);
  assert.equal(m.boundary_index, 1);
  // The row ordinal is 1 but the row lives on file line 4. Reporting only the
  // ordinal would send a reviewer to the wrong line.
  assert.equal(m.boundary_line, 4);
});

test("a ledger with no resolved row anywhere reports a null suffix rate, not 0", async () => {
  const path = writeLedger("never-resolved", rep(false, 12));
  const m = await measureMailBodyCoverage({ ledgerPath: path, now: NOW });
  assert.equal(m.ok, true);
  assert.equal(m.rows_total, 12);
  assert.equal(m.resolved_total, 0);
  assert.equal(m.frozen_prefix_rows, 12);
  assert.equal(m.boundary_index, null);
  assert.equal(m.boundary_source_msg_id, null);
  assert.equal(m.live_suffix_rows, 0);
  // Zero suffix rows: a rate would be manufactured. null is the honest answer.
  assert.equal(m.live_suffix_resolved_rate, null);
  assert.equal(m.frozen_prefix_dominates, null);
});
