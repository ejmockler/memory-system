// bm25-coverage-probe.test.mjs — B1 (memory-recall hypergraph).
//
// Pins lib/recall/bm25-coverage-probe.js: the read-only measurement of how
// much of the eligible ledger the active BM25 index actually holds, plus the
// single threshold home (`assertCoverageFloor`) that B2/B3/B4 bind to.
//
// ARMS
//   (a)  2 distinct doc ids over 5 eligible ledger LINES is coverage_pct 40 —
//        a PERCENT, not the 0.4 fraction the synthesis-side coverage probe's
//        pct() helper returns. assertCoverageFloor(r,50) THROWS and
//        assertCoverageFloor(r,10) RETURNS, shown as distinct assertions.
//   (b)  five eligible lines two of which share ONE id still report
//        eligible_rows === 5 while indexed_docs === 4 — the id-vs-line
//        asymmetry the result object stamps, demonstrated rather than asserted.
//   (c)  absence is LOUD on both sides: missing ledger, missing index, a
//        ledger with zero eligible rows, and a missing path argument each
//        throw a named error. Nothing anywhere returns NaN or Infinity.
//   (d)  a TRUNCATED bm25.json loads PARTIALLY without throwing (the loader
//        skips torn lines silently) — the reduced indexed_docs is visible in
//        the result via index_integrity, so the loader's silent degradation is
//        falsifiable instead of merely documented. The same fixture reports
//        `manifest-verified` BEFORE truncation, so that assertion can fail.
//   (e)  index_integrity's other read-only verdicts: no-manifest,
//        member-not-declared, size-verified under {verifyIndexDigest:false}.
//   (f)  model_version is DERIVED from the index dir and cross-checked against
//        CAPS.ACTIVE_EMBED_MODEL_VERSION, never hard-coded.
//   (g)  storage/bm25-growth-check.json is a READ-ONLY denominator witness.
//   (h)  the A3 ledger snapshot is a DRIFT witness only — it can never become
//        the denominator (its predicate is id-bearing lines, BM25's also
//        requires non-empty content).
//   (i)  the fs-interception canary self-test: the write detector is shown to
//        FIRE on a deliberate write, so the "no protected write" assertion at
//        the end of this file is a gate that can fail.
//   live LIVE arm over indices/qwen3-embedding-8b-fp16/bm25.json +
//        ledgers/memory.jsonl. Env-opt-in (MEMSYS_PROBE_LIVE_BM25=1) and
//        DEFAULT-SKIPPED, following the A3 precedent, so this suite never
//        pulls the 2.9 GB ledger under `npm test`. It PRINTS the triple and
//        the witnesses and asserts ONLY well-formedness — never a colour.
//        The measured baseline lives in nodes/B1.md, not in an assertion:
//        a threshold here would fail the day the B-track FIXES the index.
//
// HERMETICITY: every fixture lives under mkdtempSync with MEMORY_ROOT and the
// per-dir overrides staked BEFORE any dynamic import. Two independent proofs
// that production is untouched:
//   1. fs.openSync (and every path-taking mutator) is wrapped at the top of
//      this file; any WRITE-intent call naming ledgers/, indices/ or storage/
//      is recorded and asserted empty at the end. Arm (i) proves that detector
//      fires.
//   2. ledgers/memory.jsonl, ledgers/memory.jsonl.offsets,
//      storage/bm25-growth-check.json and EVERY file in
//      indices/qwen3-embedding-8b-fp16/ are stat-snapshotted before any work
//      and asserted identical (size, mtime, ino) at the end. STATED BOUND:
//      that tree has live writers (the ledger is append-only with running
//      daemons; the active index republishes by generation), so a pure APPEND
//      or a republish under indices/ while proof 1 recorded ZERO write-intent
//      calls is attributed and PRINTED rather than failed — otherwise the arm
//      would go red for someone else's append. A SHRINK or a vanish is failed
//      unconditionally: that is the truncation the invariant actually forbids,
//      and no daemon here produces it.
//
// Run: cd mcp && node test/bm25-coverage-probe.test.mjs
//      cd mcp && MEMSYS_PROBE_LIVE_BM25=1 node test/bm25-coverage-probe.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const PROBE_SRC = join(dirname(THIS_FILE), "..", "lib", "recall", "bm25-coverage-probe.js");

// ---------------------------------------------------------------------------
// Hermeticity: stake tmp dirs + overwrite env BEFORE any dynamic import.
// (House preamble, mirroring test/bm25-rebuild.test.mjs:37-46.)
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-bm25-coverage-"));
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

// ---------------------------------------------------------------------------
// PROOF 1 — fs call interception, installed BEFORE the dynamic imports so the
// probe's own bindings pick it up (node:module's syncBuiltinESMExports pushes
// the patch into the already-materialised builtin ESM namespace).
//
// PROTECTED_TREES is mutable so arm (i) can self-test the detector against a
// tmp path and prove it FIRES — a write detector that has never fired is not
// evidence of anything.
// ---------------------------------------------------------------------------
// The production data root is lib/config.js's DEFAULT root: the checkout that
// contains mcp/ (two levels above this file). Derived, never spelled, so the
// detector protects whatever install this suite is running from.
const PROD_ROOT = join(dirname(THIS_FILE), "..", "..");
const PROTECTED_TREES = [
  join(PROD_ROOT, "ledgers"),
  join(PROD_ROOT, "indices"),
  join(PROD_ROOT, "storage"),
];
/** @type {{op:string,path:string}[]} */
const PROTECTED_WRITES = [];
/** @type {{op:string,path:string}[]} */
const PROTECTED_READS = [];

function isProtected(p) {
  if (typeof p !== "string") return false;
  return PROTECTED_TREES.some((root) => p === root || p.startsWith(root + "/"));
}

// Write intent = the ACCESS MODE is not O_RDONLY, or a creating / truncating /
// appending bit is set. A numeric flag must be MASKED, not compared for
// equality: this tree's own hardened reader opens with
// `O_RDONLY | O_NOFOLLOW` (index-manifest.js:84 READ_FLAGS, used by
// sha256File :104 — which this probe calls on the live bm25.json). An
// equality test flags that read-only open as a WRITE, which is how the first
// live run of this suite went red against a probe that had written nothing.
// A detector that cries wolf is as useless as one that never fires; arm (i)
// pins both directions, including this exact flag pair.
const O_ACCMODE = fs.constants.O_RDONLY | fs.constants.O_WRONLY | fs.constants.O_RDWR;
const O_MUTATING = fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
function isWriteIntent(flags) {
  if (flags == null) return false; // openSync default is "r"
  if (typeof flags === "number") {
    if ((flags & O_ACCMODE) !== fs.constants.O_RDONLY) return true;
    return (flags & O_MUTATING) !== 0;
  }
  if (typeof flags === "string") return flags !== "r" && flags !== "rs";
  return true;
}

const _realOpenSync = fs.openSync;
fs.openSync = function patchedOpenSync(...args) {
  const p = typeof args[0] === "string" ? args[0] : String(args[0]);
  if (isProtected(p)) {
    (isWriteIntent(args.length > 1 ? args[1] : undefined)
      ? PROTECTED_WRITES
      : PROTECTED_READS
    ).push({ op: "openSync", path: p });
  }
  return _realOpenSync.apply(this, args);
};

for (const op of [
  "writeFileSync",
  "appendFileSync",
  "renameSync",
  "unlinkSync",
  "rmSync",
  "rmdirSync",
  "mkdirSync",
  "copyFileSync",
  "truncateSync",
  "chmodSync",
  "utimesSync",
  "createWriteStream",
]) {
  const real = fs[op];
  if (typeof real !== "function") continue;
  fs[op] = function patchedMutator(...args) {
    for (const a of args.slice(0, 2)) {
      if (isProtected(a)) PROTECTED_WRITES.push({ op, path: a });
    }
    return real.apply(this, args);
  };
}
// readFileSync / createReadStream never open the 2.9 GB ledger in this tree,
// but they are counted so the "never opened" canary states a complete bound
// rather than an openSync-shaped one.
for (const op of ["readFileSync", "createReadStream"]) {
  const real = fs[op];
  if (typeof real !== "function") continue;
  fs[op] = function patchedReader(...args) {
    if (isProtected(args[0])) PROTECTED_READS.push({ op, path: args[0] });
    return real.apply(this, args);
  };
}
syncBuiltinESMExports();

// ---------------------------------------------------------------------------
// PROOF 2 — production stat snapshot BEFORE any work (A3 precedent,
// test/ledger-snapshot-pin.test.mjs:126-142).
// ---------------------------------------------------------------------------
const LIVE_INDEX_DIR = join(PROD_ROOT, "indices", "qwen3-embedding-8b-fp16");
function prodWatchList() {
  const files = [
    join(PROD_ROOT, "ledgers", "memory.jsonl"),
    join(PROD_ROOT, "ledgers", "memory.jsonl.offsets"),
    join(PROD_ROOT, "storage", "bm25-growth-check.json"),
    LIVE_INDEX_DIR,
  ];
  try {
    for (const f of readdirSync(LIVE_INDEX_DIR).sort()) files.push(join(LIVE_INDEX_DIR, f));
  } catch {
    // absent index dir is itself a watched state ("missing" below)
  }
  return files;
}
function statOf(p) {
  try {
    const s = statSync(p);
    return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino };
  } catch {
    return null;
  }
}
function snapKey(d) {
  return d == null ? "missing" : `${d.mtimeMs}:${d.size}:${d.ino}`;
}
function snap(p) {
  return snapKey(statOf(p));
}
const PROD_PATHS = prodWatchList();
const PROD_BEFORE = PROD_PATHS.map(statOf);

// ---------------------------------------------------------------------------
// LIVE arm gate. The production paths a PROBE CALL may receive are constructed
// ONLY here, and ONLY under the opt-in env var — so a default run cannot even
// name the ledger, let alone read it.
// ---------------------------------------------------------------------------
const LIVE_ENV = "MEMSYS_PROBE_LIVE_BM25";
function liveEnabled() {
  return process.env[LIVE_ENV] === "1";
}
function livePaths() {
  if (!liveEnabled()) {
    throw new Error(`livePaths() is unreachable unless ${LIVE_ENV}=1`);
  }
  return {
    index: join(LIVE_INDEX_DIR, "bm25.json"),
    ledger: join(PROD_ROOT, "ledgers", "memory.jsonl"),
    growth: join(PROD_ROOT, "storage", "bm25-growth-check.json"),
    snapshot: join(PROD_ROOT, "ledgers", "snapshots", "latest.json"),
  };
}
function liveMaterialPresent() {
  return existsSync(join(LIVE_INDEX_DIR, "bm25.json")) &&
    existsSync(join(PROD_ROOT, "ledgers", "memory.jsonl"));
}

// ---------------------------------------------------------------------------
// Dynamic imports AFTER the env override and the fs patch.
// ---------------------------------------------------------------------------
const {
  assertCoverageFloor,
  Bm25CoverageProbeError,
  DENOMINATOR_UNIT,
  NUMERATOR_UNIT,
  probeBm25Coverage,
} = await import("../lib/recall/bm25-coverage-probe.js");
const { rebuildBm25IndexFromLedger } = await import("../lib/recall/bm25-rebuild.js");
const { ACTIVE_EMBED_MODEL_VERSION } = await import("../lib/validation.js");

// ---------------------------------------------------------------------------
// Fixture helpers — the index is built by the REAL v2 writer via
// rebuildBm25IndexFromLedger, so these fixtures exercise the on-disk format
// the production loader parses, not a hand-rolled imitation of it.
// ---------------------------------------------------------------------------
let seq = 0;
function ledgerFile(name, rows) {
  const p = join(TMP_ROOT, `${name}-${seq++}.jsonl`);
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  return p;
}
function factRows(ids, contentPrefix = "alpha beta gamma") {
  return ids.map((id, i) => ({
    id,
    kind: "fact",
    content: `${contentPrefix} ${id} row${i}`,
    ts: `2026-08-0${(i % 9) + 1}T00:00:00.000Z`,
  }));
}
/** Build a real bm25.json under MEMORY_ROOT/indices/<modelVersion>/. */
function buildIndex(modelVersion, rows) {
  const src = ledgerFile(`idx-src-${modelVersion}`, rows);
  const res = rebuildBm25IndexFromLedger({
    ledgerPath: src,
    modelVersion,
    contextualPrefix: false,
  });
  assert.equal(res.wrote_index, true, "fixture index must actually be written");
  return { bm25Path: res.bm25_path, dir: dirname(res.bm25_path), rebuild: res };
}
/** Well-formedness every successful probe result must satisfy. */
function assertWellFormed(r) {
  assert.ok(Number.isInteger(r.indexed_docs) && r.indexed_docs >= 0, "indexed_docs");
  assert.ok(Number.isInteger(r.eligible_rows) && r.eligible_rows > 0, "eligible_rows");
  assert.ok(Number.isFinite(r.coverage_pct), "coverage_pct must be finite (never NaN/Infinity)");
  assert.ok(!Number.isNaN(r.coverage_pct), "coverage_pct must not be NaN");
  assert.ok(r.coverage_pct >= 0, "coverage_pct must be non-negative");
  assert.equal(r.numerator_unit, NUMERATOR_UNIT);
  assert.equal(r.denominator_unit, DENOMINATOR_UNIT);
  assert.equal(r.coverage_pct_unit, "percent");
  assert.equal(typeof r.units_bound, "string");
  assert.equal(r.active_model_version, ACTIVE_EMBED_MODEL_VERSION);
}

// ===========================================================================
// (a) PERCENT units, and the one threshold home.
// ===========================================================================
test("(a) 2 doc ids over 5 eligible lines is coverage_pct 40 — a PERCENT", () => {
  const { bm25Path } = buildIndex("probe-model-a", factRows(["a1", "a2"]));
  const ledger = ledgerFile("cov-a", factRows(["a1", "a2", "a3", "a4", "a5"]));

  const r = probeBm25Coverage({ indexPath: bm25Path, ledgerPath: ledger });
  assertWellFormed(r);

  assert.equal(r.indexed_docs, 2, "numerator = DISTINCT doc ids in the index");
  assert.equal(r.eligible_rows, 5, "denominator = eligible LINES on the ledger");
  assert.equal(r.coverage_pct, 40, "40 means 40 PERCENT");
  assert.notEqual(r.coverage_pct, 0.4, "coverage_pct is NOT the fraction 0.4");
  assert.equal(r.model_version, "probe-model-a", "derived from basename(dirname(indexPath))");
  assert.equal(r.indexed_docs_exceeds_eligible_rows, false);
});

test("(a2) assertCoverageFloor is the ONLY threshold home — it throws below, returns above", () => {
  const { bm25Path } = buildIndex("probe-model-a2", factRows(["b1", "b2"]));
  const ledger = ledgerFile("cov-a2", factRows(["b1", "b2", "b3", "b4", "b5"]));
  const r = probeBm25Coverage({ indexPath: bm25Path, ledgerPath: ledger });
  assert.equal(r.coverage_pct, 40);

  // Below the floor: throws, and the message is self-diagnosing.
  assert.throws(
    () => assertCoverageFloor(r, 50),
    (e) => {
      assert.ok(e instanceof Bm25CoverageProbeError, "named error type");
      assert.equal(e.code, "bm25_coverage_below_floor");
      assert.match(e.message, /40% is below the 50% floor/);
      assert.match(e.message, /2 distinct doc ids indexed/);
      assert.match(e.message, /5 eligible ledger lines/);
      assert.match(e.message, /probe-model-a2/, "model_version is in the message");
      return true;
    },
  );

  // Above the floor: returns (the same object), no throw.
  assert.equal(assertCoverageFloor(r, 10), r);
});

// ===========================================================================
// (b) LINES, not distinct ids.
// ===========================================================================
test("(b) eligible_rows counts LINES — two rows sharing one id still make 5", () => {
  const rows = factRows(["c1", "c2", "c3", "c4"]);
  // A fifth LINE re-using c1's id: 5 eligible lines, 4 distinct ids.
  rows.push({ id: "c1", kind: "fact", content: "alpha beta gamma c1 duplicate-line", ts: rows[0].ts });
  const ledger = ledgerFile("cov-b", rows);

  // Build the index FROM the same ledger so the asymmetry is the only source
  // of the gap: the rebuilder keys by id (4 docs), the counter counts lines (5).
  const { bm25Path } = buildIndex("probe-model-b", rows);
  const r = probeBm25Coverage({ indexPath: bm25Path, ledgerPath: ledger });
  assertWellFormed(r);

  assert.equal(r.eligible_rows, 5, "5 eligible LINES, even though two share an id");
  assert.equal(r.indexed_docs, 4, "4 DISTINCT doc ids");
  assert.equal(r.coverage_pct, 80, "the id-vs-line asymmetry DEPRESSES coverage, never inflates it");
  assert.equal(r.ledger_total_lines, 5);
  assert.match(r.units_bound, /NOT distinct ids/);
});

// ===========================================================================
// (c) Absence is LOUD — nothing degrades to zero, NaN or Infinity.
// ===========================================================================
test("(c1) a missing ledger THROWS — never 'zero eligible rows'", () => {
  const { bm25Path } = buildIndex("probe-model-c1", factRows(["d1", "d2"]));
  assert.throws(
    () => probeBm25Coverage({ indexPath: bm25Path, ledgerPath: join(TMP_ROOT, "no-such.jsonl") }),
    (e) => {
      assert.equal(e.code, "probe_ledger_unreadable");
      assert.equal(e.details.errno, "ENOENT");
      return true;
    },
  );
});

test("(c2) a missing index THROWS — never 'zero indexed docs'", () => {
  const ledger = ledgerFile("cov-c2", factRows(["e1", "e2"]));
  assert.throws(
    () => probeBm25Coverage({ indexPath: join(TMP_ROOT, "nope", "bm25.json"), ledgerPath: ledger }),
    (e) => {
      assert.equal(e.code, "probe_index_unreadable");
      assert.equal(e.details.errno, "ENOENT");
      return true;
    },
  );
});

test("(c3) a ledger with ZERO eligible rows THROWS rather than reporting NaN or Infinity", () => {
  const { bm25Path } = buildIndex("probe-model-c3", factRows(["f1", "f2"]));
  // Present, non-empty, parseable — and eligible for nothing: no id, or an
  // empty content. This is exactly the shape the streaming counter reports as
  // a bare 0 with no error surface at all.
  const ledger = ledgerFile("cov-c3", [
    { kind: "fact", content: "no id here" },
    { id: "g1", kind: "fact", content: "" },
    { id: "", kind: "fact", content: "empty id" },
  ]);
  assert.ok(statSync(ledger).size > 0, "the fixture ledger is genuinely non-empty");

  let thrown = null;
  try {
    probeBm25Coverage({ indexPath: bm25Path, ledgerPath: ledger });
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown != null, "zero eligible rows must not return a result at all");
  assert.equal(thrown.code, "probe_ledger_no_eligible_rows");
  assert.match(thrown.message, /Refusing to report coverage against an empty denominator/);
  assert.equal(thrown.details.total_lines, 3, "the loud error still reports what it DID see");
});

test("(c4) a missing path argument THROWS — the probe has no ambient default", () => {
  const { bm25Path } = buildIndex("probe-model-c4", factRows(["h1"]));
  const ledger = ledgerFile("cov-c4", factRows(["h1", "h2"]));
  for (const args of [{ indexPath: bm25Path }, { ledgerPath: ledger }, {}, undefined]) {
    assert.throws(
      () => probeBm25Coverage(args),
      (e) => e.code === "probe_bad_arguments",
      `probeBm25Coverage(${JSON.stringify(args)}) must refuse, not fall back to a default path`,
    );
  }
});

// ===========================================================================
// (d) The loader's silent partial load, made VISIBLE.
// ===========================================================================
test("(d) a TRUNCATED bm25.json loads partially without throwing, and the result says so", () => {
  const rows = factRows(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"]);
  const { bm25Path, dir } = buildIndex("probe-model-d", rows);
  const ledger = ledgerFile("cov-d", rows);

  // The rebuild publishes a REAL index-manifest.json through the production
  // generation protocol (bm25-rebuild.js:411 publishGeneration), so the
  // `manifest-verified` verdict below is reached against a manifest this test
  // never wrote — and the post-truncation assertion is therefore not a
  // tautology.
  assert.ok(existsSync(join(dir, "index-manifest.json")), "the rebuild publishes a manifest");

  const intact = probeBm25Coverage({ indexPath: bm25Path, ledgerPath: ledger });
  assertWellFormed(intact);
  assert.equal(intact.indexed_docs, 10);
  assert.equal(intact.coverage_pct, 100);
  assert.equal(intact.index_integrity, "manifest-verified", "the green verdict is reachable");
  assert.equal(intact.index_moved_during_load, false);

  // Cut mid-way through the ["L", docId, len] block: the header survives (so
  // the loader does not throw) but only some doc-length entries do.
  const cut = truncateAtMiddleDocLenLine(bm25Path);
  assert.ok(cut.docLenLines >= 4, "fixture must have enough L lines to cut between");

  const torn = probeBm25Coverage({ indexPath: bm25Path, ledgerPath: ledger });
  assertWellFormed(torn);
  assert.ok(
    torn.indexed_docs < intact.indexed_docs,
    `a truncated index must report FEWER docs (${torn.indexed_docs} vs ${intact.indexed_docs})`,
  );
  assert.ok(torn.indexed_docs > 0, "and this fixture keeps some — partial, not empty");
  assert.notEqual(
    torn.index_integrity,
    "manifest-verified",
    "the partial load must be VISIBLE in the result, not hidden",
  );
  assert.equal(torn.index_integrity, "size-mismatch");
  assert.match(torn.index_integrity_detail, /manifest declares size \d+, on-disk size is \d+/);
});

// ===========================================================================
// (e) The other read-only integrity verdicts.
// ===========================================================================
test("(e) index_integrity: no-manifest / member-not-declared / sha-mismatch / size-verified", () => {
  const rows = factRows(["m1", "m2", "m3", "m4"]);
  const { bm25Path, dir } = buildIndex("probe-model-e", rows);
  const ledger = ledgerFile("cov-e", rows);
  const manifestPath = join(dir, "index-manifest.json");
  const published = JSON.parse(readFileSync(manifestPath, "utf8"));

  // Default: the real published manifest verifies.
  const verified = probeBm25Coverage({ indexPath: bm25Path, ledgerPath: ledger });
  assert.equal(verified.index_integrity, "manifest-verified");
  assert.equal(verified.index_digest_verified, true);

  // A sibling dir holding the same bytes with NO manifest at all.
  const bareDir = join(TMP_ROOT, "bare-model");
  mkdirSync(bareDir, { recursive: true, mode: 0o700 });
  const barePath = join(bareDir, "bm25.json");
  writeFileSync(barePath, readFileSync(bm25Path), { mode: 0o600 });
  const bare = probeBm25Coverage({ indexPath: barePath, ledgerPath: ledger });
  assert.equal(bare.index_integrity, "no-manifest");
  assert.equal(bare.index_integrity_detail, null);
  assert.equal(bare.model_version, "bare-model", "model_version follows the dir, not the manifest");

  // A manifest that declares a DIFFERENT file as members.bm25.
  const undeclaredManifest = JSON.parse(JSON.stringify(published));
  undeclaredManifest.members.bm25.file = "bm25.gen-0.json";
  writeFileSync(manifestPath, JSON.stringify(undeclaredManifest), { mode: 0o600 });
  const undeclared = probeBm25Coverage({ indexPath: bm25Path, ledgerPath: ledger });
  assert.equal(undeclared.index_integrity, "member-not-declared");

  // Same size, different bytes — only the digest can catch this.
  writeFileSync(manifestPath, JSON.stringify(published), { mode: 0o600 });
  const sizeBefore = statSync(bm25Path).size;
  flipOneByteInPlace(bm25Path);
  assert.equal(statSync(bm25Path).size, sizeBefore, "the flip must preserve length");
  const shaBad = probeBm25Coverage({ indexPath: bm25Path, ledgerPath: ledger });
  assert.equal(shaBad.index_integrity, "sha-mismatch");
  assert.match(shaBad.index_integrity_detail, /manifest declares sha256 [0-9a-f]{64}/);

  // The digest opt-out sees the same corrupt file as merely size-verified —
  // the cost/coverage trade the flag buys, stated rather than assumed.
  const skipped = probeBm25Coverage({
    indexPath: bm25Path,
    ledgerPath: ledger,
    verifyIndexDigest: false,
  });
  assert.equal(skipped.index_integrity, "size-verified");
  assert.equal(skipped.index_digest_verified, false);
  assert.match(skipped.index_integrity_detail, /verifyIndexDigest/);
});

// ===========================================================================
// (f) model_version derivation + CAPS cross-check.
// ===========================================================================
test("(f) model_version is derived from the index dir and cross-checked against CAPS", () => {
  const rows = factRows(["n1", "n2"]);
  const ledger = ledgerFile("cov-f", rows);

  const other = buildIndex("some-other-model-v9", rows);
  const rOther = probeBm25Coverage({ indexPath: other.bm25Path, ledgerPath: ledger });
  assert.equal(rOther.model_version, "some-other-model-v9");
  assert.equal(rOther.is_active_model, false);
  assert.equal(rOther.active_model_version, ACTIVE_EMBED_MODEL_VERSION);

  // Same code, an index dir NAMED like the active model (inside the tmp root).
  const active = buildIndex(ACTIVE_EMBED_MODEL_VERSION, rows);
  const rActive = probeBm25Coverage({ indexPath: active.bm25Path, ledgerPath: ledger });
  assert.equal(rActive.model_version, ACTIVE_EMBED_MODEL_VERSION);
  assert.equal(rActive.is_active_model, true);
  assert.equal(basename(dirname(active.bm25Path)), rActive.model_version);
});

// ===========================================================================
// (g) The daemon's persisted denominator witness, read-only.
// ===========================================================================
test("(g) the growth-check sidecar is a READ-ONLY denominator witness", () => {
  const rows = factRows(["p1", "p2", "p3", "p4", "p5"]);
  const { bm25Path } = buildIndex("probe-model-g", factRows(["p1", "p2"]));
  const ledger = ledgerFile("cov-g", rows);
  const ledgerSize = statSync(ledger).size;

  const sidecar = join(TMP_ROOT, "bm25-growth-check.json");
  writeFileSync(
    sidecar,
    JSON.stringify({ v: 1, ledger_path: ledger, fact_count: 4, checkpoint: { eof: 10 } }),
    { mode: 0o600 },
  );
  const sidecarBefore = snap(sidecar);

  const r = probeBm25Coverage({
    indexPath: bm25Path,
    ledgerPath: ledger,
    growthCheckPath: sidecar,
  });
  assertWellFormed(r);
  assert.equal(r.eligible_rows, 5, "the witness NEVER replaces the measurement");
  assert.equal(r.eligible_rows_witness, 4);
  assert.equal(r.witness_delta, 1);
  assert.equal(r.witness_stale_bytes, ledgerSize - 10);
  assert.equal(r.witness_error, null);
  assert.equal(snap(sidecar), sidecarBefore, "the sidecar must not be rewritten");

  // A missing / malformed sidecar is non-fatal and stated.
  const missing = probeBm25Coverage({
    indexPath: bm25Path,
    ledgerPath: ledger,
    growthCheckPath: join(TMP_ROOT, "no-sidecar.json"),
  });
  assert.equal(missing.eligible_rows, 5);
  assert.equal(missing.eligible_rows_witness, null);
  assert.equal(missing.witness_delta, null);
  assert.ok(typeof missing.witness_error === "string" && missing.witness_error.length > 0);
});

// ===========================================================================
// (h) The A3 snapshot is a DRIFT witness only.
// ===========================================================================
test("(h) the A3 snapshot is a DRIFT witness — it never becomes the denominator", () => {
  const rows = factRows(["q1", "q2", "q3", "q4", "q5"]);
  const { bm25Path } = buildIndex("probe-model-h", factRows(["q1", "q2"]));
  const ledger = ledgerFile("cov-h", rows);
  const ledgerSize = statSync(ledger).size;

  // A snapshot whose predicate (id-bearing lines) counts MORE rows than BM25
  // eligibility (id AND content). Substituting it would inflate the
  // denominator with a different predicate — it must not move a thing.
  const r = probeBm25Coverage({
    indexPath: bm25Path,
    ledgerPath: ledger,
    snapshot: { eof: ledgerSize - 1, line_count: 99, id_row_count: 98 },
  });
  assertWellFormed(r);
  assert.equal(r.eligible_rows, 5, "eligible_rows stays the MEASURED value");
  assert.equal(r.coverage_pct, 40);
  assert.equal(r.snapshot_eof, ledgerSize - 1);
  assert.equal(r.snapshot_line_count, 99);
  assert.equal(r.snapshot_id_row_count, 98);
  assert.equal(r.ledger_grew_since_snapshot, true);

  // A snapshot supplied as a PATH behaves identically.
  const snapPath = join(TMP_ROOT, "latest-h.json");
  writeFileSync(snapPath, JSON.stringify({ eof: ledgerSize, line_count: 5, id_row_count: 5 }), {
    mode: 0o600,
  });
  const r2 = probeBm25Coverage({ indexPath: bm25Path, ledgerPath: ledger, snapshot: snapPath });
  assert.equal(r2.eligible_rows, 5);
  assert.equal(r2.snapshot_eof, ledgerSize);
  assert.equal(r2.ledger_grew_since_snapshot, false);

  // No snapshot at all: null stamps, never a silent substitution.
  const r3 = probeBm25Coverage({ indexPath: bm25Path, ledgerPath: ledger });
  assert.equal(r3.snapshot_eof, null);
  assert.equal(r3.snapshot_line_count, null);
  assert.equal(r3.ledger_grew_since_snapshot, null);
});

// ===========================================================================
// (i) The hermeticity detector must be able to FAIL.
// ===========================================================================
test("(i) canary self-test: the protected-write detector actually fires", () => {
  const sentinelRoot = join(TMP_ROOT, "sentinel-tree");
  mkdirSync(sentinelRoot, { recursive: true, mode: 0o700 });
  const before = PROTECTED_WRITES.length;

  PROTECTED_TREES.push(sentinelRoot);
  try {
    // A write and a write-intent open, both under the temporarily-protected
    // tree. If the interception were dead, these would go unrecorded and this
    // suite's final hermeticity assertion would be worthless.
    writeFileSync(join(sentinelRoot, "w.txt"), "x");
    const fd = openSync(join(sentinelRoot, "o.txt"), "w");
    closeSync(fd);
    // A read-only open must NOT be recorded as a write.
    const rfd = openSync(join(sentinelRoot, "w.txt"), "r");
    closeSync(rfd);
  } finally {
    PROTECTED_TREES.pop();
  }

  const fired = PROTECTED_WRITES.splice(before);
  assert.equal(fired.length, 2, `expected writeFileSync + write-open to fire, got ${JSON.stringify(fired)}`);
  assert.deepEqual(fired.map((f) => f.op).sort(), ["openSync", "writeFileSync"]);
  assert.equal(PROTECTED_WRITES.length, before, "self-test cleaned up after itself");

  // The READ side of the same detector, proven and then cleaned up: the
  // read-only open above landed in PROTECTED_READS, not PROTECTED_WRITES.
  const sentinelReads = PROTECTED_READS.filter((h) => h.path.startsWith(sentinelRoot));
  assert.equal(sentinelReads.length, 1, "the read-only open must be recorded as a READ");
  for (let i = PROTECTED_READS.length - 1; i >= 0; i -= 1) {
    if (PROTECTED_READS[i].path.startsWith(sentinelRoot)) PROTECTED_READS.splice(i, 1);
  }

  // And the read/write classifier itself, in BOTH directions — a detector that
  // over-fires is as worthless as one that never fires.
  assert.equal(isWriteIntent(undefined), false);
  assert.equal(isWriteIntent("r"), false);
  assert.equal(isWriteIntent("rs"), false);
  assert.equal(isWriteIntent("w"), true);
  assert.equal(isWriteIntent("a"), true);
  assert.equal(isWriteIntent("r+"), true);
  assert.equal(isWriteIntent(fs.constants.O_RDONLY), false);
  // THE ONE THAT BIT: this tree's hardened reader (index-manifest.js:84
  // READ_FLAGS) opens with O_RDONLY | O_NOFOLLOW, and sha256File(:104) uses it
  // on the live bm25.json every time this probe verifies the manifest digest.
  // It is a READ. An equality-against-O_RDONLY test called it a write and
  // failed the first live run.
  assert.equal(
    isWriteIntent(fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW),
    false,
    "O_RDONLY|O_NOFOLLOW is a hardened READ (index-manifest.js:84), not a write",
  );
  assert.equal(isWriteIntent(fs.constants.O_WRONLY | fs.constants.O_CREAT), true);
  assert.equal(isWriteIntent(fs.constants.O_RDWR), true);
  // O_RDONLY with a creating/truncating bit is still write intent.
  assert.equal(isWriteIntent(fs.constants.O_RDONLY | fs.constants.O_CREAT), true);
  assert.equal(isWriteIntent(fs.constants.O_RDONLY | fs.constants.O_TRUNC), true);
});

// ===========================================================================
// CANARY — a default run cannot reach the production ledger.
// ===========================================================================
test("canary: with the env unset, the production ledger is unreachable and unopened", () => {
  // 1. The gate lives inside livePaths itself — production paths cannot be
  //    CONSTRUCTED by this suite without the env var, let alone read.
  assert.match(livePaths.toString(), /liveEnabled\(\)/);
  assert.match(livePaths.toString(), /throw new Error/);

  if (!liveEnabled()) {
    // 2. It genuinely throws in a default run...
    assert.throws(() => livePaths(), /unreachable unless MEMSYS_PROBE_LIVE_BM25=1/);
    // 3. ...and the interception log — proven live by arm (i) — records ZERO
    //    reads of any file under ledgers/, indices/ or storage/. This is the
    //    canary: it is evidence, not an appeal to the runtime behaving.
    const reads = PROTECTED_READS.filter((h) => isProtected(h.path));
    assert.deepEqual(
      reads,
      [],
      `the default run must never open the production ledger or index; recorded ${JSON.stringify(
        reads,
      )}`,
    );
  }

  // 4. The probe cannot resolve an ambient production path even if a caller
  //    forgets one — there is no ledger-path or root fallback inside it.
  const src = readFileSync(PROBE_SRC, "utf8");
  for (const forbidden of ["memoryLedgerPath", "../config.js", "MEMORY_ROOT"]) {
    assert.ok(
      !src.includes(forbidden),
      `bm25-coverage-probe.js must not reference ${forbidden} — paths are caller args`,
    );
  }
  // 5. And it must not reach the write-capable neighbours (read-only invariant).
  for (const forbidden of [
    "index-cache",
    "checksumMemberFile",
    "recordVerifiedDigest",
    "countFactRowsCheckpointed",
  ]) {
    assert.ok(!src.includes(forbidden), `bm25-coverage-probe.js must not reference ${forbidden}`);
  }
});

// ===========================================================================
// LIVE arm — env-opt-in, DEFAULT-SKIPPED. Prints the triple; asserts only
// well-formedness. NO threshold: this gate must not fail the day B2/B3/B4 fix
// the index.
// ===========================================================================
test(
  `live: probe the active BM25 index read-only (opt-in: ${LIVE_ENV}=1)`,
  { skip: !liveEnabled() || !liveMaterialPresent() },
  () => {
    const p = livePaths();
    const t0 = Date.now();
    const r = probeBm25Coverage({
      indexPath: p.index,
      ledgerPath: p.ledger,
      growthCheckPath: existsSync(p.growth) ? p.growth : null,
      snapshot: existsSync(p.snapshot) ? p.snapshot : null,
    });
    const ms = Date.now() - t0;

    assertWellFormed(r);
    // The ONLY bound asserted against live data is a UNITS bound, not a colour:
    // doc ids are derived FROM eligible rows on an append-only ledger, so a
    // reading above 100% is not a bad grade, it is an impossible measurement
    // (the probe deliberately does not clamp it away — it surfaces it). This
    // cannot fail the day the B-track fixes the index: a complete index lands
    // AT 100, not past it.
    assert.ok(
      !(r.coverage_pct > 100),
      `coverage_pct ${r.coverage_pct} exceeds 100% — ${r.indexed_docs} indexed doc ids vs ` +
        `${r.eligible_rows} eligible ledger lines is not a coverage figure, it is a disagreement`,
    );
    assert.equal(r.model_version, ACTIVE_EMBED_MODEL_VERSION);
    assert.equal(r.is_active_model, true);
    assert.equal(typeof r.index_integrity, "string");
    assert.equal(typeof r.index_stat_identity, "string");
    assert.equal(typeof r.ledger_stat_identity, "string");

    console.log(
      `  live: model_version=${r.model_version} indexed_docs=${r.indexed_docs} ` +
        `eligible_rows=${r.eligible_rows} coverage_pct=${r.coverage_pct} ` +
        `eligible_rows_witness=${r.eligible_rows_witness} witness_delta=${r.witness_delta} ` +
        `witness_stale_bytes=${r.witness_stale_bytes} index_integrity=${r.index_integrity} ` +
        `index_moved_during_load=${r.index_moved_during_load} ledger_size=${r.ledger_size} ` +
        `index_size=${r.index_size} ${ms}ms`,
    );
  },
);

// ===========================================================================
// HERMETICITY — two independent proofs, in order of strength.
// ===========================================================================
test("hermeticity: this suite issued no write-intent fs call under ledgers/, indices/ or storage/", () => {
  assert.deepEqual(
    PROTECTED_WRITES,
    [],
    `the probe must be strictly read-only; recorded: ${JSON.stringify(PROTECTED_WRITES)}`,
  );
});

test("hermeticity: production ledger, offsets sidecar, growth sidecar and the live index dir are stat-identical", () => {
  const after = PROD_PATHS.map(statOf);
  const moved = [];
  for (let i = 0; i < PROD_PATHS.length; i += 1) {
    if (snapKey(after[i]) !== snapKey(PROD_BEFORE[i])) {
      moved.push({ path: PROD_PATHS[i], before: PROD_BEFORE[i], after: after[i] });
    }
  }

  // (1) The one movement NO daemon on this tree is allowed to produce: a
  //     watched file that SHRANK or VANISHED. That is truncation / compaction —
  //     the forbidden mutation — and it fails whoever caused it. This assertion
  //     has no escape hatch.
  const destroyed = moved.filter(
    (m) => m.before != null && (m.after == null || m.after.size < m.before.size),
  );
  assert.deepEqual(
    destroyed.map((m) => `${m.path} ${snapKey(m.before)} -> ${snapKey(m.after)}`),
    [],
    "a watched production file SHRANK or VANISHED across this run — that is truncation, " +
      "which no read-only probe and no live daemon on this tree may cause",
  );

  // (2) Exact identity is the expectation, and it is asserted. The ONLY
  //     movement tolerated is one this process demonstrably did not make:
  //     an APPEND (same ino, size grew) or an index-generation REPUBLISH
  //     (under indices/ only, where publishGeneration renames a new member
  //     over the old one) while the fs write-interception log — proven live by
  //     arm (i) — recorded ZERO write-intent calls under ledgers/, indices/ or
  //     storage/. STATED BOUND: on a tree with running daemons (the ledger is
  //     append-only with live writers and the active index republishes —
  //     generation 64, index-wal.jsonl advancing), stat alone cannot attribute
  //     an append. The interception log is the process-local authority; this
  //     check is its backstop, and it keeps its teeth exactly where a daemon
  //     cannot supply an innocent explanation.
  const inIndices = (p) => p === join(PROD_ROOT, "indices") || p.startsWith(join(PROD_ROOT, "indices") + "/");
  const unexplained = moved.filter((m) => {
    if (PROTECTED_WRITES.length > 0) return true; // this process wrote: nothing is innocent
    if (m.before == null || m.after == null) return true; // appeared / vanished
    if (m.after.ino === m.before.ino && m.after.size >= m.before.size) return false; // append
    return !inIndices(m.path); // a republish is expected under indices/, nowhere else
  });
  assert.deepEqual(
    unexplained.map((m) => `${m.path} ${snapKey(m.before)} -> ${snapKey(m.after)}`),
    [],
    `stat identity moved in a way this process cannot be exonerated for; the write-interception ` +
      `log recorded ${PROTECTED_WRITES.length} write-intent call(s)`,
  );

  console.log(
    moved.length === 0
      ? `  hermeticity: ${PROD_PATHS.length} watched production paths stat-identical (size, mtime, ino) across this run`
      : `  hermeticity: ${moved.length}/${PROD_PATHS.length} watched path(s) moved by an EXTERNAL writer ` +
        `while this process recorded 0 write-intent fs calls: ${moved
          .map((m) => `${basename(m.path)} ${snapKey(m.before)} -> ${snapKey(m.after)}`)
          .join(", ")}`,
  );
});

// ---------------------------------------------------------------------------
// helpers used above
// ---------------------------------------------------------------------------
/**
 * Flip one byte in the middle of a file WITHOUT changing its length — the only
 * corruption a size check cannot see, and therefore the one the manifest
 * digest exists to catch.
 */
function flipOneByteInPlace(path) {
  const buf = readFileSync(path);
  const at = Math.floor(buf.length / 2);
  buf[at] = buf[at] === 0x41 ? 0x42 : 0x41; // 'A' <-> 'B'
  writeFileSync(path, buf, { mode: 0o600 });
  return at;
}

/**
 * Truncate a v2 bm25.json part-way through its ["L", docId, len] block: the
 * header line survives (so the loader does not throw) but only some doc-length
 * entries do. Returns {cut, docLenLines}.
 */
function truncateAtMiddleDocLenLine(path) {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const lOffsets = [];
  let off = 0;
  for (const line of lines) {
    if (line.startsWith('["L"')) lOffsets.push(off);
    off += Buffer.byteLength(line, "utf8") + 1;
  }
  const cut = lOffsets[Math.floor(lOffsets.length / 2)];
  const fd = openSync(path, "r+");
  try {
    ftruncateSync(fd, cut);
  } finally {
    closeSync(fd);
  }
  return { cut, docLenLines: lOffsets.length };
}
