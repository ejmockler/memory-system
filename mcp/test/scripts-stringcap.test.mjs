// scripts-stringcap.test.mjs — WU-scripts-stringcap regression suite.
//
// DEFECT CLASS
// ------------
// `readFileSync(path, "utf8")` throws ERR_STRING_TOO_LONG once a file passes
// Node's max string length (`require('buffer').constants.MAX_STRING_LENGTH`,
// 536,870,888 bytes on this build). Measured on the live tree:
//
//   ledgers/memory.jsonl        3,056,314,513 B  (5.69x over cap)
//   storage/sources/mail.jsonl    349,643,964 B  (0.651x — under, and growing)
//   ledgers/recall.jsonl           20,900,441 B  (0.0389x — under, TODAY)
//
// The operator scripts under test all read one of those three with
// readFileSync. Some crash loudly; the two goldset builders are worse — they
// swallow the throw in a bare `catch` and return an EMPTY set, so a
// crossed-cap recall.jsonl silently yields an empty goldset.
//
// FIX PRIMITIVE: streamLedgerLines (mcp/lib/synthesis/_ledger-stream.js:128).
//
// HERMETIC: every fixture is built under mkdtempSync; every spawn passes an
// explicit --ledger=<fixture>; every import is called with an explicit path.
// verify-cascade-correctness.mjs (:66-68) and backfill-seed-row-marker.mjs
// (:102-104) both DEFAULT to a hardcoded live absolute path, so a forgotten
// argument would read the live 3 GB ledger. Nothing here touches ledgers/,
// indices/, or storage/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants as bufferConstants } from "node:buffer";

import { streamLedgerLines } from "../lib/synthesis/_ledger-stream.js";

const MAX_STRING_LENGTH = bufferConstants.MAX_STRING_LENGTH;

const CHECKOUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPTS_DIR = join(CHECKOUT_ROOT, "mcp", "scripts");
const NODE_BIN = process.execPath;

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-scripts-stringcap-"));

// Apparent size of every over-cap fixture. 600 MB > MAX_STRING_LENGTH
// (536,870,888) with headroom, while costing ~8 KiB of real disk because the
// span between the head write and the tail write is a sparse hole.
const APPARENT_BYTES = 600_000_000;

// ---------------------------------------------------------------------------
// Sparse over-cap fixture builder.
//
// The LEADING "\n" on the tail write is load-bearing. ftruncateSync leaves a
// 600 MB run of NUL bytes with no newline in it; without the leading newline
// the tail rows are appended to that run and the whole thing is ONE over-long
// line, which streamLedgerLines abandons at maxLineBytes. You then get
// {totalLines:1, parsedLines:1, skipped:1} and only the head row — a vacuous
// fixture that would let a broken fix look green. With the leading newline:
// {totalLines:2, parsedLines:2, skipped:1}. The skipped:1 IS the NUL run and
// is expected and correct.
// ---------------------------------------------------------------------------
function makeOverCapLedger(dir, name, headRows, tailRows) {
  const p = join(dir, name);
  const fd = openSync(p, "w");
  writeSync(fd, headRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  ftruncateSync(fd, APPARENT_BYTES);
  writeSync(
    fd,
    "\n" + tailRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    APPARENT_BYTES,
  );
  closeSync(fd);
  return p;
}

// ---------------------------------------------------------------------------
// Row shapes.
// ---------------------------------------------------------------------------
function factWithSourceRef(id, source, sourceMsgId) {
  return {
    id,
    kind: "fact",
    content: `fact ${id}`,
    source_refs: [
      {
        source,
        source_msg_id: sourceMsgId,
        via: "original",
        corroboration_event_id: null,
        consent_basis: "first_party",
      },
    ],
    derived_from: [],
    provenance: { agent_id: "test", conversation_id: `conv_${id}` },
    created_at: "2026-06-04T00:00:00Z",
  };
}

function factWithSalience(id, score) {
  return {
    id,
    kind: "fact",
    content: `salient fact ${id}`,
    source_refs: [],
    derived_from: [],
    provenance: { agent_id: "test", conversation_id: `conv_${id}` },
    features: {
      salience: {
        score,
        components: {
          recency: 0.5,
          authorship: 0.5,
          content_mass: 0.5,
          source_prior: 0.5,
          structural: 0.5,
          novelty: 0.5,
        },
      },
    },
    created_at: "2026-06-04T00:00:00Z",
  };
}

function unitVec() {
  const v = new Array(768).fill(0);
  v[0] = 1.0;
  return v;
}

// Post-WIPE_THRESHOLD production row carrying a valid 768d unit vector.
function embeddedProdRow(id) {
  return {
    id,
    kind: "fact",
    content: `production fact ${id}`,
    source_refs: [],
    derived_from: [],
    provenance: { agent_id: "test", conversation_id: `conv_${id}` },
    features: { embedding_mrl_768: unitVec() },
    created_at: "2026-06-04T00:00:00Z",
  };
}

// Post-WIPE_THRESHOLD production row with NO inline embedding — the live
// corpus shape (108,734 / 108,737 non-smoke rows; vectors live in the
// sidecar indices/qwen3-embedding-8b-fp16/vectors.jsonl at 4096 dims).
function unembeddedProdRow(id) {
  return {
    id,
    kind: "fact",
    content: `production fact ${id} with no inline vector`,
    source_refs: [],
    derived_from: [],
    provenance: { agent_id: "test", conversation_id: `conv_${id}` },
    created_at: "2026-06-04T00:00:00Z",
  };
}

// A recall-ledger row with >=6 surfaced items (readCandidateEvents' floor).
function recallRow(id, memoryIds) {
  return {
    id,
    kind: "recall",
    ts: "2026-06-04T00:00:00Z",
    surfaced: memoryIds.map((memory_id, i) => ({
      memory_id,
      position: i,
      score: 1 - i * 0.01,
    })),
  };
}

function sixIds(prefix) {
  return [0, 1, 2, 3, 4, 5].map((i) => `${prefix}_${i}`);
}

// ---------------------------------------------------------------------------
// T0 — the fixture itself. If this suite's fixture is vacuous, nothing below
// proves anything, so this runs first and asserts hard.
// ---------------------------------------------------------------------------
test("T0 sparse fixture is over-cap, cheap on disk, and NON-VACUOUS", () => {
  const head = factWithSourceRef("mem_head", "imessage", "imsg-head");
  const tail = factWithSourceRef("mem_tail", "imessage", "imsg-tail");
  const p = makeOverCapLedger(TMP_ROOT, "t0-fixture.jsonl", [head], [tail]);

  const st = statSync(p);

  // (a) apparent size really exceeds Node's string cap.
  assert.ok(
    st.size > MAX_STRING_LENGTH,
    `fixture apparent size ${st.size} must exceed MAX_STRING_LENGTH ${MAX_STRING_LENGTH}`,
  );

  // (b) real disk cost is a few KiB — the file is sparse. st.blocks is in
  // 512-byte units, so 64 blocks == 32 KiB is a generous ceiling.
  assert.ok(
    st.blocks <= 64,
    `fixture must be sparse: got ${st.blocks} 512B-blocks (${st.blocks * 512} B) on disk`,
  );

  // (c) readFileSync on it really does throw the defect we are fixing.
  assert.throws(
    () => readFileSync(p, "utf8"),
    (e) => e && e.code === "ERR_STRING_TOO_LONG",
    "readFileSync(fixture, 'utf8') must throw ERR_STRING_TOO_LONG",
  );

  // (d) NON-VACUITY: streaming must yield BOTH the head and the tail row.
  // This is the missing-leading-"\n" trap. skipped:1 is the NUL run.
  const seen = [];
  const counts = streamLedgerLines(p, (row) => seen.push(row.id));
  assert.deepEqual(
    seen,
    ["mem_head", "mem_tail"],
    "fixture must surface BOTH head and tail ids (leading \\n on the tail write)",
  );
  assert.equal(counts.totalLines, 2, "totalLines");
  assert.equal(counts.parsedLines, 2, "parsedLines");
  assert.equal(counts.skipped, 1, "skipped:1 == the 600MB NUL run, expected");
  assert.equal(counts.readError, null, "clean EOF");
});

// ---------------------------------------------------------------------------
// T1 — replay-stage0.mjs: loadPromotedSourceIds / loadSourceMsgIdToMemoryId.
// ---------------------------------------------------------------------------
test("T1 replay-stage0 loadPromotedSourceIds streams an over-cap ledger", async () => {
  const { loadPromotedSourceIds } = await import(
    "../scripts/replay-stage0.mjs"
  );
  const p = makeOverCapLedger(
    TMP_ROOT,
    "t1-promoted.jsonl",
    [factWithSourceRef("mem_head", "imessage", "imsg-head")],
    [factWithSourceRef("mem_tail", "git-log", "git-tail")],
  );

  const promoted = loadPromotedSourceIds(p);
  assert.ok(promoted instanceof Map, "returns a Map");
  assert.deepEqual(
    [...(promoted.get("imessage") || [])],
    ["imsg-head"],
    "head row's source_msg_id",
  );
  assert.deepEqual(
    [...(promoted.get("git-log") || [])],
    ["git-tail"],
    "tail row's source_msg_id (proves the whole file was streamed)",
  );
});

test("T1b replay-stage0 loadSourceMsgIdToMemoryId streams an over-cap ledger", async () => {
  const { loadSourceMsgIdToMemoryId } = await import(
    "../scripts/replay-stage0.mjs"
  );
  const p = makeOverCapLedger(
    TMP_ROOT,
    "t1b-sid2mid.jsonl",
    [factWithSourceRef("mem_head", "imessage", "imsg-head")],
    [factWithSourceRef("mem_tail", "git-log", "git-tail")],
  );

  const m = loadSourceMsgIdToMemoryId(p);
  assert.equal(m.get("imessage").get("imsg-head"), "mem_head");
  assert.equal(
    m.get("git-log").get("git-tail"),
    "mem_tail",
    "tail row resolved (proves the whole file was streamed)",
  );
});

test("T1c replay-stage0 helpers raise loudly on an UNREADABLE (not missing) ledger", async () => {
  const { loadPromotedSourceIds, loadSourceMsgIdToMemoryId } = await import(
    "../scripts/replay-stage0.mjs"
  );
  // A path whose parent component is a FILE, not a directory -> ENOTDIR.
  // existsSync() returns false here, which is exactly the conflation B1c3
  // (_ledger-stream.js:118-127) says must not silently become "empty ledger".
  const notDir = join(TMP_ROOT, "t1c-plain-file.jsonl");
  const fd = openSync(notDir, "w");
  writeSync(fd, "{}\n");
  closeSync(fd);
  const bogus = join(notDir, "nested", "memory.jsonl");

  assert.equal(existsSync(bogus), false, "existsSync lies about this path");
  assert.throws(
    () => loadPromotedSourceIds(bogus),
    /replay-stage0/,
    "unreadable ledger must throw, not return an empty Map",
  );
  assert.throws(
    () => loadSourceMsgIdToMemoryId(bogus),
    /replay-stage0/,
    "unreadable ledger must throw, not return an empty Map",
  );

  // ENOENT keeps the historical missing-ledger -> empty contract.
  const missing = join(TMP_ROOT, "t1c-absent.jsonl");
  const empty = loadPromotedSourceIds(missing);
  assert.ok(empty instanceof Map, "missing ledger still yields a Map");
  assert.equal(empty.get("imessage").size, 0, "missing ledger -> empty sets");
});

// ---------------------------------------------------------------------------
// T2 — replay-salience.mjs: readLedgerFacts.
// ---------------------------------------------------------------------------
test("T2 replay-salience readLedgerFacts streams an over-cap ledger", async () => {
  const { readLedgerFacts } = await import("../scripts/replay-salience.mjs");
  const p = makeOverCapLedger(
    TMP_ROOT,
    "t2-salience.jsonl",
    [factWithSalience("mem_head", 0.4)],
    [factWithSalience("mem_tail", 0.6)],
  );

  const facts = readLedgerFacts(p);
  assert.ok(Array.isArray(facts), "returns an Array (caller at :280 sorts it)");
  assert.deepEqual(
    facts.map((f) => f.id),
    ["mem_head", "mem_tail"],
    "both salience-carrying facts returned",
  );
  assert.equal(facts[0].features.salience.score, 0.4, "row shape preserved");
});

test("T2b replay-salience readLedgerFacts preserves the exact filter", async () => {
  const { readLedgerFacts } = await import("../scripts/replay-salience.mjs");
  const rows = [
    factWithSalience("mem_keep", 0.5),
    { ...factWithSalience("mem_wrongkind", 0.5), kind: "policy" },
    { ...factWithSalience("mem_nosal", 0.5), features: {} },
    { ...factWithSalience("mem_salnotobj", 0.5), features: { salience: 7 } },
    { ...factWithSalience("", 0.5) },
  ];
  const p = makeOverCapLedger(
    TMP_ROOT,
    "t2b-filter.jsonl",
    rows,
    [factWithSalience("mem_tailkeep", 0.9)],
  );

  const facts = readLedgerFacts(p);
  assert.deepEqual(
    facts.map((f) => f.id),
    ["mem_keep", "mem_tailkeep"],
    "kind!=fact / non-object salience / empty id are all still dropped",
  );
});

test("T2c replay-salience readLedgerFacts raises on an unreadable ledger", async () => {
  const { readLedgerFacts } = await import("../scripts/replay-salience.mjs");
  const notDir = join(TMP_ROOT, "t2c-plain-file.jsonl");
  const fd = openSync(notDir, "w");
  writeSync(fd, "{}\n");
  closeSync(fd);
  const bogus = join(notDir, "nested", "memory.jsonl");

  assert.throws(
    () => readLedgerFacts(bogus),
    /replay-salience/,
    "unreadable ledger must throw, not return []",
  );
  assert.deepEqual(
    readLedgerFacts(join(TMP_ROOT, "t2c-absent.jsonl")),
    [],
    "missing ledger still yields []",
  );
});

// ---------------------------------------------------------------------------
// T3 — verify-cascade-correctness.mjs.
// ---------------------------------------------------------------------------
function runVerify(ledgerPath, extraArgs = []) {
  const res = spawnSync(
    NODE_BIN,
    [join(SCRIPTS_DIR, "verify-cascade-correctness.mjs"), `--ledger=${ledgerPath}`, ...extraArgs],
    { encoding: "utf8" },
  );
  let summary = null;
  try {
    summary = JSON.parse(res.stdout);
  } catch {
    /* leave null */
  }
  return { code: res.status, summary, stderr: res.stderr, stdout: res.stdout };
}

test("T3 verify-cascade survives an over-cap ledger and emits parseable JSON", () => {
  const p = makeOverCapLedger(
    TMP_ROOT,
    "t3-verify.jsonl",
    [embeddedProdRow("mem_head")],
    [embeddedProdRow("mem_tail")],
  );

  const { code, summary, stderr, stdout } = runVerify(p);
  assert.equal(code, 0, `expected exit 0; stderr=${stderr} stdout=${stdout}`);
  assert.ok(summary, "stdout must be parseable JSON");
  assert.equal(summary.verdict, "PASS");
  assert.equal(summary.total_rows, 2, "both head and tail counted");
  assert.equal(summary.production_rows, 2);
  assert.equal(summary.sampled, 2);
  assert.equal(summary.with_embedding, 2);
});

// The read path must survive the live corpus SHAPE — every non-smoke row
// lacking an inline vector (108,734 of 108,737) — not just the all-embedded
// case in T3. This asserts the STREAMING contract ONLY: the script walked an
// over-cap file readFileSync cannot hold and counted every row.
//
// It deliberately asserts NEITHER the verdict string NOR the exit code. On this
// corpus the script says FAIL/exit 1, a PRE-EXISTING wart (HEAD behaves
// identically) that this node neither introduced nor repaired. Verdict
// semantics are owned by node s8-cascade-verdict-shapes; pinning them here
// would force s8 to edit this file to change the thing it owns.
test("T3-uncap verify-cascade streams an all-unembedded over-cap corpus", () => {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(unembeddedProdRow(`mem_prod_${i}`));
  const p = makeOverCapLedger(
    TMP_ROOT,
    "t3-uncap-noinline.jsonl",
    rows,
    [unembeddedProdRow("mem_tail")],
  );

  const { summary, stderr, stdout } = runVerify(p);
  assert.ok(summary, `stdout must be parseable JSON; stderr=${stderr} stdout=${stdout}`);
  assert.equal(summary.total_rows, 6, "head and tail both streamed past the NUL run");
  assert.equal(summary.production_rows, 6);
  assert.equal(summary.sampled, 6);
});

test("T3c verify-cascade streams the genuinely MIXED case past the NUL run", () => {
  const p = makeOverCapLedger(
    TMP_ROOT,
    "t3c-mixed.jsonl",
    [embeddedProdRow("mem_ok_1"), unembeddedProdRow("mem_bad_1")],
    [embeddedProdRow("mem_ok_2")],
  );
  // Verdict expectation flipped on the authority of KILLS.md "s7 — TWO
  // GATE-FAILS, ONE CAUSE": absence of an inline vector is not corruption, and
  // verdict semantics moved to s8-cascade-verdict-shapes. The counts below are
  // this test's real mandate — they prove head AND tail streamed past the NUL.
  const { code, summary, stderr } = runVerify(p);
  assert.equal(code, 0, `mixed coverage is not a failure; stderr=${stderr}`);
  assert.ok(summary, "parseable JSON");
  assert.equal(summary.verdict, "PARTIAL_INLINE_COVERAGE", "some inline, some sidecar-only");
  assert.equal(summary.with_embedding, 2);
  assert.equal(summary.without_embedding, 1);
});

test("T3d verify-cascade still exits 2 on a genuinely missing ledger", () => {
  const { code } = runVerify(join(TMP_ROOT, "t3d-absent.jsonl"));
  assert.equal(code, 2, "missing ledger keeps exit 2");
});

// ---------------------------------------------------------------------------
// T4 — backfill-seed-row-marker.mjs MUST REFUSE.
//
// This script is NOT repaired. Its readFileSync at :67 is the only interlock
// standing between the live ledger and ~1.41M legitimate production rows being
// permanently branded provenance.is_seed_row=true (a field
// verify-cascade-correctness.mjs:66 reads at dispatch as "throwaway smoke,
// exclude"). Measured on the live ledger: WOULD_MARK 1,410,113 / already
// marked 0, all matching solely via created_at < WIPE_THRESHOLD.
// ---------------------------------------------------------------------------
function runBackfill(ledgerPath, extraArgs = []) {
  const res = spawnSync(
    NODE_BIN,
    [join(SCRIPTS_DIR, "backfill-seed-row-marker.mjs"), `--ledger=${ledgerPath}`, ...extraArgs],
    { encoding: "utf8" },
  );
  let summary = null;
  try {
    summary = JSON.parse(res.stdout);
  } catch {
    /* leave null */
  }
  return { code: res.status, summary, stderr: res.stderr, stdout: res.stdout };
}

test("T4 backfill-seed-row-marker REFUSES an over-cap ledger with exit 4", () => {
  const p = makeOverCapLedger(
    TMP_ROOT,
    "t4-refuse.jsonl",
    [factWithSourceRef("mem_head", "imessage", "imsg-head")],
    [factWithSourceRef("mem_tail", "imessage", "imsg-tail")],
  );
  const before = statSync(p);

  const { code, stderr } = runBackfill(p);
  assert.equal(code, 4, `over-cap ledger must exit 4 (refusal); stderr=${stderr}`);
  assert.match(stderr, /string cap/i, "message must name the string cap");
  assert.match(stderr, /1,?410,?113|1\.41M/, "message must state the measured match count");
  assert.match(stderr, /WIPE_THRESHOLD/, "message must name the causal heuristic");
  assert.match(stderr, /--i-understand-this-rewrites-the-live-ledger/, "message must name the bypass");

  const after = statSync(p);
  assert.equal(after.size, before.size, "refusal must not have rewritten the ledger");
  assert.equal(
    existsSync(`${p}.tmp.r29p5-backfill.` + process.pid),
    false,
    "no tmp rewrite file",
  );
});

test("T4b backfill --dry-run is ALWAYS allowed and counts over-cap without readFileSync", () => {
  // 3 rows match the legacy heuristic (created_at < WIPE_THRESHOLD), 1 does not.
  const old1 = { ...factWithSourceRef("mem_old1", "imessage", "a"), created_at: "2023-01-07T00:00:00Z" };
  const old2 = { ...factWithSourceRef("mem_old2", "imessage", "b"), created_at: "2025-09-18T00:00:00Z" };
  const newish = { ...factWithSourceRef("mem_new", "imessage", "c"), created_at: "2026-07-01T00:00:00Z" };
  const oldTail = { ...factWithSourceRef("mem_old3", "imessage", "d"), created_at: "2024-02-02T00:00:00Z" };

  const p = makeOverCapLedger(TMP_ROOT, "t4b-dryrun.jsonl", [old1, old2, newish], [oldTail]);
  const before = statSync(p);

  const { code, summary, stderr } = runBackfill(p, ["--dry-run"]);
  assert.equal(code, 0, `dry-run must survive over-cap; stderr=${stderr}`);
  assert.ok(summary, "dry-run emits parseable JSON");
  assert.equal(summary.dry_run, true);
  assert.equal(summary.updated, 3, "3 rows match created_at < WIPE_THRESHOLD");
  assert.equal(summary.non_matching, 1, "the post-threshold row does not match");
  assert.equal(summary.total_lines, 4, "head+tail both streamed");

  const after = statSync(p);
  assert.equal(after.size, before.size, "dry-run never writes");
});

test("T4c backfill under-cap path is unchanged (guard does not fire)", () => {
  const rows = [
    { ...factWithSourceRef("mem_old", "imessage", "a"), created_at: "2023-01-07T00:00:00Z" },
    { ...factWithSourceRef("mem_new", "imessage", "b"), created_at: "2026-07-01T00:00:00Z" },
  ];
  const p = join(TMP_ROOT, "t4c-small.jsonl");
  const fd = openSync(p, "w");
  writeSync(fd, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  closeSync(fd);

  const { code, summary } = runBackfill(p, ["--dry-run"]);
  assert.equal(code, 0, "small ledger dry-run exits 0");
  assert.equal(summary.updated, 1);
  assert.equal(summary.non_matching, 1);
});

// ---------------------------------------------------------------------------
// T5 — the two goldset builders (landmines, not live breakage).
// ---------------------------------------------------------------------------
test("T5 build-ranking readCandidateEvents streams an over-cap recall ledger", async () => {
  const { readCandidateEvents } = await import(
    "../scripts/build-ranking-eval-goldset.mjs"
  );
  const p = makeOverCapLedger(
    TMP_ROOT,
    "t5-recall-ranking.jsonl",
    [recallRow("rec_head", sixIds("mem_head"))],
    [recallRow("rec_tail", sixIds("mem_tail"))],
  );

  const { events, needed } = readCandidateEvents(p);
  assert.deepEqual(
    events.map((e) => e.id),
    ["rec_head", "rec_tail"],
    "both recall events mined (return shape { events, needed } preserved)",
  );
  assert.equal(needed.size, 12, "all 12 surfaced memory ids collected");
  assert.ok(needed.has("mem_head_0") && needed.has("mem_tail_5"));
});

test("T5b build-contextual mineRecallTouchedIds streams an over-cap recall ledger", async () => {
  const { mineRecallTouchedIds } = await import(
    "../scripts/build-contextual-eval-goldset.mjs"
  );
  const p = makeOverCapLedger(
    TMP_ROOT,
    "t5b-recall-contextual.jsonl",
    [recallRow("rec_head", sixIds("mem_head"))],
    [recallRow("rec_tail", sixIds("mem_tail"))],
  );

  const ids = mineRecallTouchedIds(p);
  assert.ok(ids instanceof Set, "returns a Set<memory_id>");
  assert.equal(ids.size, 12);
  assert.ok(ids.has("mem_head_0") && ids.has("mem_tail_5"));
});

test("T5c importing build-contextual-eval-goldset has NO side effects", async () => {
  // Before the main guard landed, importing this module ran main() and
  // writeFileSync'd into ledgers/contextual-eval-goldset.jsonl.
  const GOLDSET_OUT = join(CHECKOUT_ROOT, "ledgers", "contextual-eval-goldset.jsonl");
  const before = existsSync(GOLDSET_OUT) ? statSync(GOLDSET_OUT) : null;

  const mod = await import("../scripts/build-contextual-eval-goldset.mjs");
  assert.equal(typeof mod.mineRecallTouchedIds, "function", "module exports the miner");

  const after = existsSync(GOLDSET_OUT) ? statSync(GOLDSET_OUT) : null;
  if (before === null) {
    assert.equal(after, null, "import must not CREATE the goldset file");
  } else {
    assert.equal(after.mtimeMs, before.mtimeMs, "import must not rewrite the goldset file");
    assert.equal(after.size, before.size, "import must not resize the goldset file");
  }

  const src = readFileSync(
    join(SCRIPTS_DIR, "build-contextual-eval-goldset.mjs"),
    "utf8",
  );
  // The guard idiom in the checkout's script: INVOKED_DIRECTLY compares the
  // real path of argv[1] with this module's own path, and main() runs only
  // under it.
  assert.match(
    src,
    /realpathSync\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\);[\s\S]{0,80}\}\)\(\);\nif \(INVOKED_DIRECTLY\) \{\n  main\(\)/,
    "main guard must be present",
  );
});

// ---------------------------------------------------------------------------
// T6 — static honesty guards over the six changed scripts.
// ---------------------------------------------------------------------------
const CHANGED_SCRIPTS = Object.freeze([
  "replay-stage0.mjs",
  "replay-salience.mjs",
  "verify-cascade-correctness.mjs",
  "backfill-seed-row-marker.mjs",
  "build-contextual-eval-goldset.mjs",
  "build-ranking-eval-goldset.mjs",
]);

function readScript(name) {
  return readFileSync(join(SCRIPTS_DIR, name), "utf8");
}

test("T6 no changed call site raises maxLineBytes", () => {
  // Raising maxLineBytes above the string cap makes streamLedgerLines throw
  // `RangeError: Invalid string length` at _ledger-stream.js:198
  // (`pending += text.slice(cursor)`), punching a hole in its never-throws
  // contract. Live max line is 1,039,374 chars = 12.4% of the 8 MiB default,
  // so the default is correct and load-bearing.
  for (const name of CHANGED_SCRIPTS) {
    const src = readScript(name);
    assert.equal(
      /maxLineBytes/.test(src),
      false,
      `${name} must not pass a maxLineBytes option — the 8 MiB default is load-bearing`,
    );
  }
});

// Every readFileSync(<ledger-ish>, "utf8") that is allowed to survive in the
// six changed scripts, pinned EXACTLY. This is an allowlist, not a filter: any
// NEW ledger read — or any change to one of these — fails the assertion. Each
// entry needs a reason.
const ALLOWED_LEDGER_READS = Object.freeze({
  // The one deliberately-unrepaired site. Its readFileSync IS the interlock
  // (see T4): repairing it would remove the last thing standing between ~1.41M
  // legitimate production rows and a permanent is_seed_row=true branding.
  // Guarded by the statSync/MAX_STRING_LENGTH refusal above it — see T6c.
  "backfill-seed-row-marker.mjs": ['readFileSync(ledgerPath, "utf8")'],
  // RESIDUAL, OUT OF SCOPE (declared): atomicAppendJsonl() re-reads the SIDECAR
  // it is appending to (storage/salience-sidecars/retroactive-drop-*.jsonl),
  // NOT a ledger. It is the site this WU's remit names as
  // `replay-stage0.mjs:194` and explicitly excludes from repair. It is a
  // smaller landmine of the same class — the sidecar grows one line per
  // retroactive drop — and is reported as a residual rather than fixed here.
  "replay-stage0.mjs": ['readFileSync(path, "utf8")'],
});

test("T6b the only surviving ledger-ish readFileSync sites are the pinned allowlist", () => {
  const LEDGER_ISH = /readFileSync\(\s*(ledgerPath|sourceRecallPath|recallPath|RECALL_LEDGER|MEMORY_LEDGER|path)\b[^)]*\)/g;
  for (const name of CHANGED_SCRIPTS) {
    const src = readScript(name);
    const hits = [...src.matchAll(LEDGER_ISH)].map((m) => m[0]);
    assert.deepEqual(
      hits,
      ALLOWED_LEDGER_READS[name] || [],
      `${name}: surviving ledger-ish readFileSync sites must match the pinned allowlist exactly`,
    );
  }
});

test("T6b2 the replay-stage0 residual is the SIDECAR append read, not a ledger read", () => {
  // Pins WHY the T6b allowlist entry is tolerable: the surviving call sits
  // inside atomicAppendJsonl (sidecar re-read), and the three LEDGER-path
  // helpers are all streamed. If someone reintroduces a ledger readFileSync
  // under the generic name `path`, this fails.
  const src = readScript("replay-stage0.mjs");
  const idx = src.indexOf('readFileSync(path, "utf8")');
  assert.ok(idx > -1, "the declared residual is still present");
  const fnStart = src.lastIndexOf("function ", idx);
  assert.match(
    src.slice(fnStart, idx),
    /function atomicAppendJsonl\(/,
    "the surviving readFileSync must live in atomicAppendJsonl (sidecar append)",
  );
  for (const helper of [
    "export function loadPromotedSourceIds",
    "export function loadSourceMsgIdToMemoryId",
    "function readJsonl",
  ]) {
    const hStart = src.indexOf(helper);
    assert.ok(hStart > -1, `${helper} still exists`);
    const body = src.slice(hStart, src.indexOf("\n}", hStart));
    assert.match(body, /streamLedgerLines\(/, `${helper} must stream`);
    assert.equal(
      /readFileSync/.test(body),
      false,
      `${helper} must not readFileSync`,
    );
  }
});

test("T6c backfill's preserved readFileSync is still behind the size guard", () => {
  const src = readScript("backfill-seed-row-marker.mjs");
  const guardIdx = src.indexOf("MAX_STRING_LENGTH");
  const readIdx = src.indexOf('readFileSync(ledgerPath, "utf8")');
  assert.ok(guardIdx > -1, "size guard references MAX_STRING_LENGTH");
  assert.ok(readIdx > -1, "the deliberate readFileSync is still present");
  assert.ok(
    guardIdx < readIdx,
    "the MAX_STRING_LENGTH guard MUST precede the readFileSync it protects",
  );
  assert.match(src, /statSync\(ledgerPath\)/, "guard stats the ledger");
  assert.match(
    src,
    /--i-understand-this-rewrites-the-live-ledger/,
    "the explicit opt-in flag is the only bypass",
  );
  assert.match(src, /process\.exit\(4\)/, "refusal uses the new exit code 4");
  // The site must be commented as a deliberate, allowlisted exception (s1's
  // scripts-tier guard requires the commented entry).
  const before = src.slice(Math.max(0, readIdx - 800), readIdx);
  assert.match(
    before,
    /DELIBERATE|deliberately|allowlist/i,
    "the preserved site must carry an inline allowlist comment",
  );
});

test("T6d the four changed streaming scripts import streamLedgerLines", () => {
  for (const name of CHANGED_SCRIPTS) {
    if (name === "backfill-seed-row-marker.mjs") continue;
    const src = readScript(name);
    assert.match(
      src,
      /import \{ streamLedgerLines \} from "\.\.\/lib\/synthesis\/_ledger-stream\.js";/,
      `${name} must import the fix primitive`,
    );
  }
  // The backfill imports it too, but ONLY for the dry-run counting path.
  assert.match(
    readScript("backfill-seed-row-marker.mjs"),
    /streamLedgerLines/,
    "backfill uses the primitive for its always-allowed dry-run",
  );
});
