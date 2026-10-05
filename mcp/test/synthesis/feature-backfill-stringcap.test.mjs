// feature-backfill-stringcap.test.mjs — s3-feature-backfill-bounded.
//
// GUARDS TWO DEFECTS AT ONCE, both of which are fatal on the production
// ledger and neither of which the pre-existing feature-backfill.test.mjs
// can see (its fixtures are a few dozen rows):
//
//   1. STRING CAP. The engine used to slurp the whole ledger into one JS
//      string in two places. memory.jsonl is 3,054,950,767 bytes; Node's
//      max string length on this machine is 536,870,888. The whole-file
//      read therefore threw ERR_STRING_TOO_LONG into a bare `catch` that
//      returned empty maps — the engine silently saw a ZERO-ROW ledger and
//      every fact looked "already covered". Test (a)/(b) below are a
//      structural scanner for that pattern, because the failure cannot be
//      reproduced in a hermetic test: allocating a >512 MB string to prove
//      it is exactly the thing that cannot be done (same reasoning as
//      mcp/test/recall/ledger-streaming-recall.test.mjs:23-35).
//
//   2. UNBOUNDED RETENTION — the trap that a naive streaming swap walks
//      into. The old loader retained EVERY fact row in a Map. 1,515,956 of
//      1,518,834 production rows are kind:"fact", measured at 2,769 bytes
//      of heap per retained row => ~4.20 GB against Node's default 4,288 MB
//      heap limit. The only production caller (scripts/run-feature-backfill.mjs)
//      sets no --max-old-space-size, so streaming without bounding converts
//      a loud 917 ms throw into a fatal OOM. Test (c) pins the bound.
//
//   3. READ-FAILURE CONFLATION. A bare `catch { return empty }` cannot tell
//      "ledger is empty" from "ledger could not be read". The second case
//      must NEVER reach the emit loop: a truncated backfill map makes
//      already-covered facts look bare, needsBackfill returns true, and the
//      byte-compare has no existing overlay to compare against — the run
//      would append DUPLICATE policy rows to the production ledger. Tests
//      (d)/(e) pin the non-conflation and the fail-closed posture.
//
// HERMETIC: every fixture lives under mkdtempSync(join(tmpdir(), ...)).
// No production ledger is read, no absolute repo path is hard-coded (the
// engine source is resolved via fileURLToPath(import.meta.url)), no ambient
// env var is read or set, and nothing >512 MB is ever allocated.
//
// Run: node --test test/synthesis/feature-backfill-stringcap.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import {
  runBackfill,
  readBackfillEventsFromLedger,
  FEATURE_BACKFILL_KIND,
  BACKFILL_CAPS,
  __internal,
} from "../../lib/synthesis/feature-backfill.js";
import { ENTITY_EXTRACTOR_VERSION } from "../../lib/synthesis/entity-extractor.js";
import { TIME_ANCHOR_RESOLVER_VERSION } from "../../lib/synthesis/time-anchor-resolver.js";
import { MODEL_VERSION as VALENCE_SCORER_VERSION } from "../../lib/synthesis/valence-scorer.js";
import { EPISODICITY_VERSION } from "../../lib/synthesis/episodicity-scorer.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ENGINE_SRC_PATH = join(
  __dirname,
  "..",
  "..",
  "lib",
  "synthesis",
  "feature-backfill.js",
);

/** The whole-file-read pattern this node exists to eliminate. Kept as a
 *  single shared constant so test (b) exercises the EXACT regex test (a)
 *  relies on — a scanner nobody has proven can fail is worthless. */
const WHOLE_FILE_READ_RE = /readFileSync\s*\(\s*ledgerPath/;

function freshDir(tag) {
  return mkdtempSync(join(tmpdir(), `fb-stringcap-${tag}-`));
}

function writeLedger(rows, tag = "ledger") {
  const dir = freshDir(tag);
  const path = join(dir, "memory.jsonl");
  writeFileSync(path, rows.map((r) => JSON.stringify(r) + "\n").join(""), {
    mode: 0o600,
  });
  return { dir, path };
}

/** A legacy "bare" fact: features carry embedding + salience only, no
 *  entities[] slot, so needsBackfill() returns true. Mirrors the shape
 *  used by feature-backfill.test.mjs's bareFact(). */
function bareFact(i) {
  const id = `mem_SC${i.toString().padStart(5, "0")}`;
  return {
    id,
    kind: "fact",
    content: `Email contact${i}@example.com about workshop item ${i}`,
    source_refs: [
      {
        source: "chat-claude-code",
        source_msg_id: `chat-claude-code:msg:${id}`,
        via: "original",
        corroboration_event_id: null,
      },
    ],
    derived_from: [],
    provenance: {
      agent_id: "test-fixture",
      conversation_id: "conv_legacy",
      confidence: "medium",
      is_seed_row: true,
    },
    created_at: "2026-03-15T10:00:00Z",
    features: {
      embedding: new Array(8).fill(0.1),
      salience: { score: 0.6, weights_hash: "legacy" },
    },
  };
}

/** A CURRENT-version backfill policy row for factId — needsBackfill()'s
 *  early-exit sees all four extractor versions matching and returns false,
 *  so the collector must skip this fact. */
function freshBackfillRow(factId, version, ts, rowId) {
  return {
    id: rowId,
    ts,
    kind: "policy",
    policy_kind: FEATURE_BACKFILL_KIND,
    schema_version: "v1",
    target_fact_id: factId,
    features_overlay: { entities: [] },
    backfill_version: version,
    extractor_versions: {
      entity_extractor: ENTITY_EXTRACTOR_VERSION,
      time_anchor_extractor: TIME_ANCHOR_RESOLVER_VERSION,
      valence_scorer: VALENCE_SCORER_VERSION,
      episodicity_scorer: EPISODICITY_VERSION,
    },
  };
}

// ---------------------------------------------------------------------------
// (a) STRUCTURAL — the engine must not read the whole ledger into a string.
// ---------------------------------------------------------------------------

test("(a) structural: engine never reads the whole ledger into one string", () => {
  const src = readFileSync(ENGINE_SRC_PATH, "utf8");
  assert.equal(
    WHOLE_FILE_READ_RE.test(src),
    false,
    "feature-backfill.js must not contain a whole-file read of ledgerPath — " +
      "on the 3.05 GB production ledger that throws ERR_STRING_TOO_LONG into " +
      "a bare catch and the engine silently sees a zero-row ledger",
  );
  assert.ok(
    src.includes("streamLedgerLines"),
    "feature-backfill.js must read the ledger via the streamLedgerLines " +
      "primitive from _ledger-stream.js",
  );
});

// ---------------------------------------------------------------------------
// (b) POSITIVE CONTROL — prove the scanner in (a) can actually fail.
// ---------------------------------------------------------------------------

test("(b) positive control: the structural regex matches a synthetic violation", () => {
  const violation = '  raw = readFileSync(ledgerPath, "utf8");';
  assert.equal(
    WHOLE_FILE_READ_RE.test(violation),
    true,
    "the scanner regex must match the exact pattern it is meant to forbid — " +
      "without this control test (a) could pass vacuously forever",
  );
  // And it must not fire on the streaming replacement.
  assert.equal(
    WHOLE_FILE_READ_RE.test("  const counts = streamLedgerLines(ledgerPath, onRow);"),
    false,
    "the scanner must not false-positive on the streaming call",
  );
});

// ---------------------------------------------------------------------------
// (c) BOUNDED RETENTION — the OOM guard.
// ---------------------------------------------------------------------------

test("(c) bounded retention: 5,000 bare facts yield BATCH_SIZE candidates, not 5,000", () => {
  const FACT_COUNT = 5000;
  const rows = [];
  for (let i = 0; i < FACT_COUNT; i++) rows.push(bareFact(i));
  // Two of the facts are already covered by a CURRENT-version backfill.
  const coveredA = rows[0].id;
  const coveredB = rows[1].id;
  rows.push(freshBackfillRow(coveredA, 1, "2026-01-01T00:00:00Z", "mem_bfa001"));
  rows.push(freshBackfillRow(coveredB, 1, "2026-01-01T00:00:01Z", "mem_bfb001"));
  const { path: ledger } = writeLedger(rows, "bounded");

  // Pass 1 retains ONLY policy rows — 2 of 5,002 lines.
  const mapPass = __internal.loadLatestBackfillMap(ledger);
  assert.equal(mapPass.readError, null, "clean read of a healthy fixture");
  assert.equal(
    mapPass.latestBackfillByFactId.size,
    2,
    "pass 1 retains only feature_backfill policy rows (2), never fact rows",
  );

  // Pass 2 retains AT MOST BATCH_SIZE fact rows.
  const collected = __internal.collectBackfillCandidates(ledger, {
    latestBackfillByFactId: mapPass.latestBackfillByFactId,
  });
  assert.equal(collected.readError, null, "clean read on the candidate pass");
  assert.notEqual(
    collected.candidates.length,
    FACT_COUNT,
    "the collector must NOT retain every fact row — at 2,769 bytes/row the " +
      "production fact set is ~4.20 GB against a 4,288 MB heap limit",
  );
  assert.equal(
    collected.candidates.length,
    BACKFILL_CAPS.BATCH_SIZE,
    `collector caps retention at BATCH_SIZE (${BACKFILL_CAPS.BATCH_SIZE})`,
  );
  // The two already-covered facts are inspected but not collected; the
  // collector then stops the moment the cap is reached, so facts_inspected
  // matches the old break-based semantics exactly.
  assert.equal(
    collected.factsInspected,
    BACKFILL_CAPS.BATCH_SIZE + 2,
    "inspection stops at the cap (2 covered facts skipped, 50 collected)",
  );
  assert.equal(
    collected.candidates[0].factId,
    rows[2].id,
    "collection is in ledger order, starting after the two covered facts",
  );
  for (const c of collected.candidates) {
    assert.equal(typeof c.factId, "string");
    assert.equal(c.factRow.kind, "fact");
    assert.equal(c.existing, null, "uncovered facts carry no existing backfill");
  }

  // An explicit lower limit is honoured too (the cap is a parameter, not a
  // coincidence of the fixture size).
  const small = __internal.collectBackfillCandidates(ledger, {
    latestBackfillByFactId: mapPass.latestBackfillByFactId,
    limit: 7,
  });
  assert.equal(small.candidates.length, 7, "explicit limit honoured");

  // The back-compat shim must be bounded as well — it is the last place a
  // caller could still materialize the whole fact set.
  const shim = __internal.streamLedgerState(ledger);
  assert.ok(
    shim.factRowsById.size <= BACKFILL_CAPS.BATCH_SIZE,
    `__internal.streamLedgerState must retain at most BATCH_SIZE fact rows, ` +
      `got ${shim.factRowsById.size}`,
  );
  assert.equal(
    shim.latestBackfillByFactId.size,
    2,
    "shim still surfaces the latest-backfill map (its only real consumer)",
  );
});

// ---------------------------------------------------------------------------
// (d) READ FAILURE IS NOT EMPTY.
// ---------------------------------------------------------------------------

test("(d) a path that exists but cannot be read yields a non-null read-error signal", () => {
  const dir = freshDir("eisdir");
  const notAFile = join(dir, "memory.jsonl");
  mkdirSync(notAFile); // exists, but reading it yields EISDIR — not ENOENT.

  const mapPass = __internal.loadLatestBackfillMap(notAFile);
  assert.notEqual(
    mapPass.readError,
    null,
    "an unreadable ledger must surface a read error, not masquerade as empty",
  );
  assert.equal(mapPass.latestBackfillByFactId.size, 0);

  const collected = __internal.collectBackfillCandidates(notAFile, {
    latestBackfillByFactId: new Map(),
  });
  assert.notEqual(
    collected.readError,
    null,
    "the candidate pass must surface its read error too",
  );
  assert.equal(collected.candidates.length, 0);

  // The operator audit helper degrades to [] but must not throw.
  const events = readBackfillEventsFromLedger(notAFile);
  assert.ok(Array.isArray(events), "audit helper still returns an Array");
  assert.equal(events.length, 0);
});

test("(d) a genuinely missing ledger yields a NULL read-error signal and empty results", () => {
  const missing = join(
    tmpdir(),
    `fb-stringcap-missing-${randomBytes(8).toString("hex")}`,
    "does",
    "not",
    "exist.jsonl",
  );
  const mapPass = __internal.loadLatestBackfillMap(missing);
  assert.equal(
    mapPass.readError,
    null,
    "ENOENT keeps the cold-start contract: missing ledger === empty ledger",
  );
  assert.equal(mapPass.latestBackfillByFactId.size, 0);

  const collected = __internal.collectBackfillCandidates(missing, {
    latestBackfillByFactId: new Map(),
  });
  assert.equal(collected.readError, null, "missing ledger is not a read error");
  assert.equal(collected.candidates.length, 0);
  assert.equal(collected.factsInspected, 0);
});

// ---------------------------------------------------------------------------
// (e) FAIL-CLOSED — a truncated backfill map must never reach the emit loop.
// ---------------------------------------------------------------------------

test("(e) fail-closed: pass-1 read error counts an error, emits nothing, writes nothing", async () => {
  const dir = freshDir("failclosed");
  const notAFile = join(dir, "memory.jsonl");
  mkdirSync(notAFile);

  const result = await runBackfill({ ledgerPath: notAFile });
  assert.ok(result.errors >= 1, "the read failure is counted, not swallowed");
  assert.equal(
    result.backfill_events_emitted,
    0,
    "a partial latest-backfill map must NEVER reach the emit loop — every " +
      "covered fact would look bare and the run would append duplicate rows",
  );
  assert.equal(result.facts_inspected, 0, "the candidate pass never ran");
  assert.equal(result.skipped_noop, 0);
  assert.equal(result.dry_run, false);
  assert.deepEqual(
    readdirSync(notAFile),
    [],
    "nothing was written through the unreadable ledger path",
  );

  // Missing ledger, by contrast, is a clean no-op with ZERO errors.
  const missing = join(dir, "absent.jsonl");
  const clean = await runBackfill({ ledgerPath: missing });
  assert.equal(clean.errors, 0, "ENOENT is not an error");
  assert.equal(clean.facts_inspected, 0);
  assert.equal(clean.backfill_events_emitted, 0);
});

test("(e) fail-closed: an unreadable EXISTING ledger file is left byte-identical", async () => {
  const { dir, path: ledger } = writeLedger(
    [bareFact(1), bareFact(2), bareFact(3)],
    "unreadable",
  );
  const sizeBefore = statSync(ledger).size;
  chmodSync(ledger, 0o000);

  // Running as root would defeat the permission gate; probe rather than
  // assume, so this test is a real assertion on a normal dev/CI account and
  // an honest skip on a privileged one.
  let readable = true;
  try {
    closeSync(openSync(ledger, "r"));
  } catch {
    readable = false;
  }

  if (!readable) {
    const result = await runBackfill({ ledgerPath: ledger });
    assert.ok(result.errors >= 1, "EACCES is counted as an error");
    assert.equal(result.backfill_events_emitted, 0, "no emits off a failed read");
    assert.equal(
      statSync(ledger).size,
      sizeBefore,
      "the ledger is byte-length identical — a failed read causes NO writes",
    );
  }

  chmodSync(ledger, 0o600);
  assert.equal(statSync(ledger).size, sizeBefore, "fixture unchanged");
  assert.ok(readdirSync(dir).length >= 1, "fixture dir intact");
});

// ---------------------------------------------------------------------------
// (f) END-TO-END BOUNDEDNESS — runBackfill over a 5,000-fact ledger.
// ---------------------------------------------------------------------------

test("(f) runBackfill over 5,000 bare facts stays inside BATCH_SIZE (dry run, no writes)", async () => {
  const rows = [];
  for (let i = 0; i < 5000; i++) rows.push(bareFact(i));
  const { path: ledger } = writeLedger(rows, "e2e");
  const sizeBefore = statSync(ledger).size;

  const result = await runBackfill({ ledgerPath: ledger, dryRun: true });
  assert.equal(result.dry_run, true);
  assert.equal(result.errors, 0, "healthy ledger, no read errors");
  assert.equal(
    result.facts_inspected,
    BACKFILL_CAPS.BATCH_SIZE,
    "inspection is bounded by the batch cap, not by the ledger size",
  );
  assert.ok(
    result.backfill_events_emitted <= BACKFILL_CAPS.BATCH_SIZE,
    `emission bounded by BATCH_SIZE, got ${result.backfill_events_emitted}`,
  );
  assert.equal(
    statSync(ledger).size,
    sizeBefore,
    "dry run writes nothing",
  );
  assert.deepEqual(
    readBackfillEventsFromLedger(ledger),
    [],
    "no backfill rows on disk after a dry run",
  );
});
