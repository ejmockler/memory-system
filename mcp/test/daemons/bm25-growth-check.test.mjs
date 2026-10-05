// bm25-growth-check.test.mjs — W2 (memperf): BM25 growth check without the
// full ledger stream.
//
// Equivalence suite for countFactRowsCheckpointed (lib/recall/bm25-rebuild.js):
// an S1-checkpoint row-count delta that must return the SAME fact_count as the
// untouched full-stream oracle countFactRowsStreamed, on every scenario:
// fresh / append / torn tail / in-place prefix rewrite / rotation / corrupt
// sidecar / missing ledger — plus decision equivalence through
// maybeRunBm25Rebuild (exact action strings at thresholds straddling the true
// delta) and a differential proof (T6) that the incremental path never
// re-streams the prefix.
//
// Discipline (copied from test/bm25-rebuild.test.mjs):
//   - mkdtempSync rooted in tmpdir; overwrite MEMORY_ROOT + POLICY_BASE_DIR
//     + STORAGE_BASE_DIR + LEDGERS_BASE_DIR BEFORE any dynamic import.
//   - ad-hoc test()/pass()/fail() helpers + node:assert/strict.
//   - process.on("exit") cleanup; process.exitCode = failures ? 1 : 0.
//   - Fixture ledgers only — the real memory.jsonl is never touched. Every
//     count call is wrapped in a sha256 immutability check: the check must
//     NEVER mutate the ledger it counts.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Hermeticity: stake tmp dirs + overwrite env BEFORE any dynamic import.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-bm25-growth-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");

mkdirSync(process.env.POLICY_BASE_DIR, { recursive: true, mode: 0o700 });
mkdirSync(process.env.STORAGE_BASE_DIR, { recursive: true, mode: 0o700 });
mkdirSync(process.env.LEDGERS_BASE_DIR, { recursive: true, mode: 0o700 });
mkdirSync(join(MEMORY_ROOT, "indices"), { recursive: true, mode: 0o700 });

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// Dynamic import AFTER env override.
const {
  countFactRowsStreamed, // the untouched full-stream ORACLE
  countFactRowsCheckpointed, // the implementation under test
  maybeRunBm25Rebuild,
  readRebuildState,
} = await import("../../lib/recall/bm25-rebuild.js");
const { deserializeCheckpoint } = await import(
  "../../lib/synthesis/ledger-checkpoint.js"
);
const { CAPS } = await import("../../lib/validation.js");

// ---------------------------------------------------------------------------
// Test framework: ad-hoc test() matching bm25-rebuild.test.mjs.
// ---------------------------------------------------------------------------
let failures = 0;
let passes = 0;

function pass(label) {
  passes++;
  console.log(`  pass: ${label}`);
}
function fail(label, err) {
  failures++;
  console.log(`  FAIL: ${label}`);
  if (err) {
    console.log(`        ${err && err.stack ? err.stack : err}`);
  }
}
async function test(label, fn) {
  console.log(`test: ${label}`);
  try {
    await fn();
  } catch (err) {
    fail(label, err);
  }
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
const MODEL_VERSION = CAPS.GEMINI_EMBEDDING_MODEL_DEFAULT;
const LEDGER_PATH = join(MEMORY_ROOT, "ledgers", "memory.jsonl");
const SIDECAR_PATH = join(MEMORY_ROOT, "storage", "bm25-growth-check.json");
const REBUILD_STATE_PATH = join(
  MEMORY_ROOT,
  "storage",
  "bm25-rebuild-state.json",
);
const BM25_DIR = join(MEMORY_ROOT, "indices", MODEL_VERSION);

function makeFactRow(id, content) {
  return {
    id,
    kind: "fact",
    content,
    source: "test",
    source_refs: [],
    derived_from: [],
    provenance: {},
    features: { entities: [], embedding_model_version: MODEL_VERSION },
    created_at: "2026-07-01T00:00:00Z",
    checksum: "deadbeef",
  };
}

function writeLedger(rows, extraLines = []) {
  const lines = rows.map((r) => JSON.stringify(r));
  for (const e of extraLines) lines.push(e);
  writeFileSync(LEDGER_PATH, lines.join("\n") + "\n", "utf8");
}

function appendRaw(text) {
  writeFileSync(LEDGER_PATH, readFileSync(LEDGER_PATH, "utf8") + text, "utf8");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readSidecar() {
  return JSON.parse(readFileSync(SIDECAR_PATH, "utf8"));
}

function resetWorld() {
  for (const p of [LEDGER_PATH, SIDECAR_PATH, REBUILD_STATE_PATH]) {
    try {
      rmSync(p, { force: true });
    } catch {
      // ignore
    }
  }
  try {
    rmSync(BM25_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// countAndCheckImmutable — invariant harness: the growth check must NEVER
// mutate the ledger it counts. sha256 before/after every call.
function countAndCheckImmutable(label) {
  const before = existsSync(LEDGER_PATH) ? sha256File(LEDGER_PATH) : null;
  const res = countFactRowsCheckpointed(LEDGER_PATH);
  const after = existsSync(LEDGER_PATH) ? sha256File(LEDGER_PATH) : null;
  assert.equal(after, before, `${label}: ledger sha256 unchanged by check`);
  return res;
}

// oracle — the untouched full-stream count (equivalence baseline).
function oracle() {
  return countFactRowsStreamed(LEDGER_PATH);
}

// expectedDecision — reference re-implementation of the PRE-CHANGE decision
// logic in maybeRunBm25Rebuild (:511-543), driven by the ORACLE count. Used
// by T7 to assert bit-for-bit decision equivalence.
function expectedDecision(threshold) {
  const state = readRebuildState();
  const lastSize =
    state && typeof state.last_rebuild_ledger_size === "number"
      ? state.last_rebuild_ledger_size
      : 0;
  const lastCount =
    state && typeof state.last_rebuild_fact_count === "number"
      ? state.last_rebuild_fact_count
      : null;
  const currentSize = existsSync(LEDGER_PATH)
    ? readFileSync(LEDGER_PATH).length
    : 0;
  if (state != null && currentSize <= lastSize) {
    return { action: "skipped_no_growth", delta: 0 };
  }
  const { fact_count } = oracle();
  const delta = lastCount == null ? fact_count : fact_count - lastCount;
  if (state != null && delta < threshold) {
    return { action: "skipped_below_threshold", delta };
  }
  return { action: "rebuilt", delta };
}

// ---------------------------------------------------------------------------
// T1 — fresh (no sidecar): full count, sidecar created.
// ---------------------------------------------------------------------------
await test("T1 fresh ledger, no sidecar: full mode + sidecar seeded", () => {
  resetWorld();
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push(makeFactRow(`mem_t1_${i}`, `t1 seed alpha content ${i}`));
  }
  // Two non-eligible-but-valid-JSON rows: excluded by the predicate.
  writeLedger(rows, [
    JSON.stringify({ kind: "policy", policy_kind: "ping" }),
    JSON.stringify({ id: "mem_t1_nocontent", kind: "fact" }),
  ]);

  assert.equal(existsSync(SIDECAR_PATH), false, "no sidecar before T1");
  const want = oracle();
  const got = countAndCheckImmutable("T1");
  assert.equal(got.mode, "full", "fresh check runs in full mode");
  assert.equal(got.full_reason, "no-sidecar", "full_reason = no-sidecar");
  assert.equal(got.fact_count, want.fact_count, "fact_count == oracle");
  assert.equal(got.ledger_size, want.ledger_size, "ledger_size == oracle");

  assert.equal(existsSync(SIDECAR_PATH), true, "sidecar created");
  const sc = readSidecar();
  assert.equal(sc.v, 1, "sidecar v == 1");
  assert.equal(sc.ledger_path, LEDGER_PATH, "sidecar pins the ledger path");
  assert.equal(sc.fact_count, want.fact_count, "persisted count == oracle");
  assert.ok(
    deserializeCheckpoint(sc.checkpoint) !== null,
    "sidecar checkpoint deserializes",
  );
  assert.ok(typeof sc.updated_at === "string", "updated_at present");
  pass("T1 fresh/full OK");
});

// ---------------------------------------------------------------------------
// T2 — mixed append: incremental count matches oracle, sidecar advances.
// ---------------------------------------------------------------------------
await test("T2 mixed append: incremental mode, count == oracle", () => {
  const scBefore = readSidecar();
  const appended = [];
  for (let i = 0; i < 5; i++) {
    appended.push(JSON.stringify(makeFactRow(`mem_t2_${i}`, `t2 grow ${i}`)));
  }
  appended.push(JSON.stringify({ id: "mem_t2_nocontent", kind: "fact" })); // ineligible
  appended.push("{not valid json"); // malformed
  appended.push(""); // blank line
  appended.push(JSON.stringify(makeFactRow("mem_t2_last", "t2 last")));
  appendRaw(appended.join("\n") + "\n");

  const want = oracle();
  const got = countAndCheckImmutable("T2");
  assert.equal(got.mode, "incremental", "append path is incremental");
  assert.equal(got.fact_count, want.fact_count, "fact_count == oracle");
  assert.equal(got.ledger_size, want.ledger_size, "ledger_size == oracle");
  assert.ok(got.appended_lines > 0, "delta lines were read");
  assert.ok(got.appended_bytes > 0, "delta bytes were read");

  const scAfter = readSidecar();
  assert.ok(
    scAfter.checkpoint.eof > scBefore.checkpoint.eof,
    "sidecar checkpoint advanced",
  );
  assert.equal(scAfter.fact_count, want.fact_count, "persisted count advanced");
  pass("T2 incremental append OK");
});

// ---------------------------------------------------------------------------
// T3 — torn tail: counted in the RETURNED value (oracle parity), excluded
// from the PERSISTED sidecar count; then counted exactly once on completion.
// ---------------------------------------------------------------------------
await test("T3 torn tail: returned-only, then once-and-only-once", () => {
  const persistedBefore = readSidecar().fact_count;
  // Torn append: a fully valid eligible row, but NO trailing newline.
  appendRaw(JSON.stringify(makeFactRow("mem_t3_torn", "t3 torn tail row")));

  const want1 = oracle(); // streamLedgerLines parses the torn line: +1
  const got1 = countAndCheckImmutable("T3a");
  assert.equal(got1.mode, "incremental", "torn tail keeps incremental mode");
  assert.equal(
    got1.fact_count,
    want1.fact_count,
    "returned count includes the torn row (oracle parity)",
  );
  assert.equal(
    want1.fact_count,
    persistedBefore + 1,
    "sanity: oracle counted the torn row",
  );
  const scTorn = readSidecar();
  assert.equal(
    scTorn.fact_count,
    persistedBefore,
    "persisted count EXCLUDES the torn row ([0, eof) only)",
  );

  // Complete the torn row and append one more eligible row.
  appendRaw("\n" + JSON.stringify(makeFactRow("mem_t3_after", "t3 after")) + "\n");
  const want2 = oracle();
  const got2 = countAndCheckImmutable("T3b");
  assert.equal(got2.mode, "incremental", "post-completion still incremental");
  assert.equal(
    got2.fact_count,
    want2.fact_count,
    "completed torn row counted exactly once (== oracle)",
  );
  assert.equal(
    want2.fact_count,
    persistedBefore + 2,
    "sanity: torn row + new row = +2, no double count",
  );
  assert.equal(
    readSidecar().fact_count,
    want2.fact_count,
    "persisted count caught up after tail completion",
  );
  pass("T3 torn tail OK");
});

// ---------------------------------------------------------------------------
// T4 — in-place prefix rewrite (size preserved): full recount, prefix-drift.
// ---------------------------------------------------------------------------
await test("T4 in-place prefix rewrite: full mode, prefix-drift", () => {
  const raw = readFileSync(LEDGER_PATH, "utf8");
  assert.ok(raw.includes("t1 seed alpha"), "fixture sanity: rewrite target");
  // Same-length substitution early in the file — size unchanged, bytes drift.
  const rewritten = raw.replace("t1 seed alpha", "t1 SEED ALPHA");
  assert.equal(rewritten.length, raw.length, "rewrite preserves size");
  writeFileSync(LEDGER_PATH, rewritten, "utf8");

  const want = oracle();
  const got = countAndCheckImmutable("T4");
  assert.equal(got.mode, "full", "prefix rewrite forces full recount");
  assert.equal(got.full_reason, "prefix-drift", "full_reason = prefix-drift");
  assert.equal(got.fact_count, want.fact_count, "fact_count == oracle");
  assert.equal(
    readSidecar().fact_count,
    want.fact_count,
    "sidecar re-seeded after drift",
  );
  pass("T4 rewrite detection OK");
});

// ---------------------------------------------------------------------------
// T5 — rotation / shrink: full recount.
// ---------------------------------------------------------------------------
await test("T5 rotation (replace with fewer rows): full mode", () => {
  const rows = [];
  for (let i = 0; i < 8; i++) {
    rows.push(makeFactRow(`mem_t5_${i}`, `t5 rotated ${i}`));
  }
  writeLedger(rows); // wholesale replacement, smaller file

  const want = oracle();
  const got = countAndCheckImmutable("T5");
  assert.equal(got.mode, "full", "rotation forces full recount");
  assert.ok(
    got.full_reason === "shrunk" || got.full_reason === "prefix-drift",
    `full_reason is shrunk|prefix-drift (got ${got.full_reason})`,
  );
  assert.equal(got.fact_count, want.fact_count, "fact_count == oracle");
  assert.equal(want.fact_count, 8, "sanity: rotated ledger has 8 facts");
  assert.equal(readSidecar().fact_count, 8, "sidecar re-seeded to truth");
  pass("T5 rotation OK");
});

// ---------------------------------------------------------------------------
// T6 — differential no-restream proof: a tampered sidecar count is carried
// verbatim through the incremental path (prefix NOT re-streamed), and truth
// returns once the sidecar is deleted.
// ---------------------------------------------------------------------------
await test("T6 differential proof: incremental path never re-streams prefix", () => {
  const sc = readSidecar();
  const tampered = sc.fact_count + 1000;
  sc.fact_count = tampered; // checkpoint left INTACT
  writeFileSync(SIDECAR_PATH, JSON.stringify(sc), "utf8");

  const K = 4;
  const lines = [];
  for (let i = 0; i < K; i++) {
    lines.push(JSON.stringify(makeFactRow(`mem_t6_${i}`, `t6 delta ${i}`)));
  }
  appendRaw(lines.join("\n") + "\n");

  const got = countAndCheckImmutable("T6a");
  assert.equal(got.mode, "incremental", "tampered-but-valid sidecar → incremental");
  assert.equal(
    got.fact_count,
    tampered + K,
    "returned count == tampered + K: prefix provably NOT re-streamed",
  );
  assert.notEqual(
    got.fact_count,
    oracle().fact_count,
    "sanity: tampered result differs from truth (the differential)",
  );

  // Delete the sidecar → full recount → truth returns.
  rmSync(SIDECAR_PATH, { force: true });
  const want = oracle();
  const got2 = countAndCheckImmutable("T6b");
  assert.equal(got2.mode, "full", "missing sidecar → full recount");
  assert.equal(got2.fact_count, want.fact_count, "truth restored (== oracle)");
  pass("T6 differential proof OK");
});

// ---------------------------------------------------------------------------
// T7 — decision equivalence through maybeRunBm25Rebuild: exact action
// strings at thresholds straddling the oracle delta, across append,
// rewrite, and rotation states.
// ---------------------------------------------------------------------------
await test("T7 decision equivalence across append/rewrite/rotation", () => {
  resetWorld();
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push(makeFactRow(`mem_t7_${i}`, `t7 base row content ${i}`));
  }
  writeLedger(rows);

  // 7a: first run (no state) rebuilds regardless of threshold.
  let exp = expectedDecision(1000);
  let res = maybeRunBm25Rebuild({ modelVersion: MODEL_VERSION, threshold: 1000 });
  assert.equal(exp.action, "rebuilt", "sanity: reference says rebuilt");
  assert.equal(res.action, exp.action, "7a first-run action equivalent");
  assert.equal(res.current_fact_count, 10, "7a count == oracle count");
  assert.ok(readRebuildState() != null, "7a state persisted (:566-571)");
  assert.equal(readRebuildState().last_rebuild_fact_count, 10);

  // 7b: no growth → skipped_no_growth (no count performed).
  exp = expectedDecision(5);
  res = maybeRunBm25Rebuild({ modelVersion: MODEL_VERSION, threshold: 5 });
  assert.equal(exp.action, "skipped_no_growth", "sanity: reference no-growth");
  assert.equal(res.action, exp.action, "7b no-growth action equivalent");

  // 7c: append 6 eligible rows → oracle delta 6; straddle with 7 and 6.
  const more = [];
  for (let i = 0; i < 6; i++) {
    more.push(JSON.stringify(makeFactRow(`mem_t7_app_${i}`, `t7 append ${i}`)));
  }
  appendRaw(more.join("\n") + "\n");
  exp = expectedDecision(7);
  res = maybeRunBm25Rebuild({ modelVersion: MODEL_VERSION, threshold: 7 });
  assert.equal(exp.action, "skipped_below_threshold", "sanity: 6 < 7 skips");
  assert.equal(res.action, exp.action, "7c above-delta threshold equivalent");
  assert.equal(res.delta, exp.delta, "7c delta == oracle delta (6)");
  exp = expectedDecision(6);
  res = maybeRunBm25Rebuild({ modelVersion: MODEL_VERSION, threshold: 6 });
  assert.equal(exp.action, "rebuilt", "sanity: 6 >= 6 rebuilds");
  assert.equal(res.action, exp.action, "7c below-delta threshold equivalent");
  assert.equal(readRebuildState().last_rebuild_fact_count, 16, "7c state");

  // 7d: in-place prefix rewrite that also GROWS the file (rewrite + append
  // 3 rows) → old code full-counts; new code must detect drift and recount.
  const raw = readFileSync(LEDGER_PATH, "utf8");
  writeFileSync(
    LEDGER_PATH,
    raw.replace("t7 base row", "t7 BASE ROW"),
    "utf8",
  );
  const grow = [];
  for (let i = 0; i < 3; i++) {
    grow.push(JSON.stringify(makeFactRow(`mem_t7_rw_${i}`, `t7 rw ${i}`)));
  }
  appendRaw(grow.join("\n") + "\n");
  exp = expectedDecision(4);
  res = maybeRunBm25Rebuild({ modelVersion: MODEL_VERSION, threshold: 4 });
  assert.equal(exp.action, "skipped_below_threshold", "sanity: 3 < 4 skips");
  assert.equal(res.action, exp.action, "7d rewrite skip equivalent");
  assert.equal(res.delta, exp.delta, "7d delta == oracle delta (3)");
  exp = expectedDecision(3);
  res = maybeRunBm25Rebuild({ modelVersion: MODEL_VERSION, threshold: 3 });
  assert.equal(exp.action, "rebuilt", "sanity: 3 >= 3 rebuilds");
  assert.equal(res.action, exp.action, "7d rewrite rebuild equivalent");
  assert.equal(readRebuildState().last_rebuild_fact_count, 19, "7d state");

  // 7e: rotation — replace wholesale with MORE rows (file larger than the
  // last-rebuild size so the pre-check passes). Oracle: 25 facts, delta 6.
  const rotated = [];
  for (let i = 0; i < 25; i++) {
    rotated.push(
      makeFactRow(
        `mem_t7_rot_${i}`,
        `t7 rotated replacement content with padding to grow the file ${i}`,
      ),
    );
  }
  writeLedger(rotated);
  exp = expectedDecision(7);
  res = maybeRunBm25Rebuild({ modelVersion: MODEL_VERSION, threshold: 7 });
  assert.equal(exp.action, "skipped_below_threshold", "sanity: 6 < 7 skips");
  assert.equal(res.action, exp.action, "7e rotation skip equivalent");
  assert.equal(res.delta, exp.delta, "7e delta == oracle delta (6)");
  exp = expectedDecision(6);
  res = maybeRunBm25Rebuild({ modelVersion: MODEL_VERSION, threshold: 6 });
  assert.equal(exp.action, "rebuilt", "sanity: 6 >= 6 rebuilds");
  assert.equal(res.action, exp.action, "7e rotation rebuild equivalent");
  assert.equal(readRebuildState().last_rebuild_fact_count, 25, "7e state");
  pass("T7 decision equivalence OK");
});

// ---------------------------------------------------------------------------
// T8 — corrupt sidecar JSON / ledger_path mismatch: treated as absent.
// ---------------------------------------------------------------------------
await test("T8 corrupt sidecar + ledger_path mismatch: full, no throw", () => {
  resetWorld();
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push(makeFactRow(`mem_t8_${i}`, `t8 content ${i}`));
  }
  writeLedger(rows);
  countAndCheckImmutable("T8-seed"); // seed a valid sidecar

  // Corrupt JSON.
  writeFileSync(SIDECAR_PATH, "{{definitely not json", "utf8");
  let want = oracle();
  let got = countAndCheckImmutable("T8a");
  assert.equal(got.mode, "full", "corrupt sidecar → full recount");
  assert.equal(got.fact_count, want.fact_count, "count == oracle");

  // Valid JSON, wrong ledger_path.
  const sc = readSidecar();
  sc.ledger_path = join(MEMORY_ROOT, "ledgers", "some-other.jsonl");
  writeFileSync(SIDECAR_PATH, JSON.stringify(sc), "utf8");
  want = oracle();
  got = countAndCheckImmutable("T8b");
  assert.equal(got.mode, "full", "ledger_path mismatch → full recount");
  assert.equal(got.full_reason, "no-sidecar", "mismatch treated as absent");
  assert.equal(got.fact_count, want.fact_count, "count == oracle");
  pass("T8 defensive sidecar handling OK");
});

// ---------------------------------------------------------------------------
// T9 — missing ledger: zeros, no sidecar write, no throw.
// ---------------------------------------------------------------------------
await test("T9 missing ledger: zeros, no sidecar write", () => {
  resetWorld();
  assert.equal(existsSync(LEDGER_PATH), false, "no ledger");
  assert.equal(existsSync(SIDECAR_PATH), false, "no sidecar");

  const want = oracle(); // countFactRowsStreamed on a missing file: zeros
  const got = countFactRowsCheckpointed(LEDGER_PATH);
  assert.equal(got.ledger_size, 0, "ledger_size == 0");
  assert.equal(got.fact_count, 0, "fact_count == 0");
  assert.equal(got.fact_count, want.fact_count, "matches oracle zeros");
  assert.equal(got.ledger_size, want.ledger_size, "matches oracle zeros");
  assert.equal(got.mode, "unavailable", "mode == unavailable");
  assert.equal(
    existsSync(SIDECAR_PATH),
    false,
    "missing ledger does NOT create a sidecar",
  );
  pass("T9 missing ledger OK");
});

// ---------------------------------------------------------------------------
// T10 — W2b fail-closed full recount: a readAppended error on the FULL path
// must NOT persist a partial fact_count under a valid checkpoint (which would
// permanently poison every subsequent incremental count); the existing
// sidecar is left byte-identical and the condition is surfaced as
// mode "unavailable" + full_reason "full-recount-error:<readAppended error>".
// ---------------------------------------------------------------------------
await test("T10 full-recount read error: fail-closed, sidecar untouched", () => {
  resetWorld();

  // The fixture must span MULTIPLE 64KiB readAppended chunks: the
  // deterministic error lever below truncates the ledger from inside the
  // per-line JSON.parse of chunk 1, so the NEXT positioned chunk read hits
  // EOF before to.eof and readAppended fails with the exact error string
  // "truncated" (ledger-checkpoint.js readAppended taxonomy).
  const SENTINEL = "w2b-truncate-sentinel";
  const N = 900;
  const rows = [];
  for (let i = 0; i < N; i++) {
    rows.push(
      makeFactRow(
        `mem_t10_${i}`,
        `t10 fail closed padding ${"x".repeat(120)} row ${i}`,
      ),
    );
  }
  // Sentinel row early in the file — parsed inside the FIRST 64KiB chunk.
  rows[10] = makeFactRow("mem_t10_sentinel", `t10 ${SENTINEL} row`);
  writeLedger(rows);
  assert.ok(
    readFileSync(LEDGER_PATH).length > 2 * 64 * 1024,
    "fixture sanity: ledger spans more than two 64KiB chunks",
  );

  // Seed a valid sidecar covering the whole ledger.
  const seeded = countAndCheckImmutable("T10-seed");
  assert.equal(seeded.fact_count, N, "seed count == N");
  const sidecarSeeded = readFileSync(SIDECAR_PATH, "utf8");
  assert.equal(JSON.parse(sidecarSeeded).fact_count, N, "sidecar seeded == N");

  // Force mode=full: same-length rewrite in block 0 (always witnessed), so
  // verifyPrefix fails with prefix-drift and the FULL recount runs.
  const raw = readFileSync(LEDGER_PATH, "utf8");
  const drifted = raw.replace("t10 fail closed", "t10 FAIL CLOSED");
  assert.equal(drifted.length, raw.length, "rewrite preserves size");
  writeFileSync(LEDGER_PATH, drifted, "utf8");

  // Deterministic mid-recount failure: the full path parses each delivered
  // line via JSON.parse. Hook it so parsing the sentinel row truncates the
  // ledger ON DISK (same inode — writeFileSync O_TRUNCs in place, and
  // readAppended's open fd sees it) after chunk 1 is already in memory but
  // BEFORE chunk 2 is read: the chunk-2 readSync returns 0 bytes and
  // readAppended fails closed with "truncated", holding a partial count
  // (only chunk 1's ~200 rows of 900).
  const origParse = JSON.parse;
  let fired = false;
  let got;
  try {
    JSON.parse = function (text, ...args) {
      if (!fired && typeof text === "string" && text.includes(SENTINEL)) {
        fired = true;
        writeFileSync(LEDGER_PATH, "{}\n", "utf8"); // shrink below chunk 1
      }
      return origParse.call(JSON, text, ...args);
    };
    got = countFactRowsCheckpointed(LEDGER_PATH);
  } finally {
    JSON.parse = origParse;
  }
  assert.equal(fired, true, "sentinel hook fired mid-recount");

  // Fail-closed return: the uncertified count is NOT reported as truth.
  assert.equal(
    got.mode,
    "unavailable",
    "uncertified full recount → mode unavailable",
  );
  assert.equal(
    got.full_reason,
    "full-recount-error:truncated",
    "readAppended error surfaced in full_reason",
  );
  assert.equal(got.fact_count, 0, "fact_count zeroed (never partial)");
  assert.equal(got.appended_lines, 0, "appended_lines zeroed");
  assert.equal(got.appended_bytes, 0, "appended_bytes zeroed");

  // THE defect gate: the persisted sidecar was NOT updated to the partial
  // value — byte-identical to the seeded one, so the next check re-decides
  // from real on-disk state instead of a poisoned baseline.
  assert.equal(
    readFileSync(SIDECAR_PATH, "utf8"),
    sidecarSeeded,
    "sidecar untouched by the failed recount",
  );

  // Recovery: restore a real ledger; the (stale) sidecar fails verifyPrefix
  // and a clean full recount restores truth and re-seeds the sidecar.
  const recovered = [];
  for (let i = 0; i < 12; i++) {
    recovered.push(makeFactRow(`mem_t10_rec_${i}`, `t10 recovered ${i}`));
  }
  writeLedger(recovered);
  const want = oracle();
  const after = countAndCheckImmutable("T10-recover");
  assert.equal(after.fact_count, want.fact_count, "truth restored (== oracle)");
  assert.equal(
    readSidecar().fact_count,
    want.fact_count,
    "sidecar re-seeded to truth on the next check",
  );
  pass("T10 fail-closed full recount OK");
});

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log(`\n${passes} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
