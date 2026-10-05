// lexical-coverage-gate.test.mjs — l4 (legacy-purge hypergraph).
//
// Pins mcp/scripts/verify-lexical-coverage-gate.mjs: the read-only, executable
// form of the "may the legacy Gemini index be deleted?" ruling. The gate probes
// the lexical coverage of one model's bm25.json against the ledger and turns the
// single threshold home `assertCoverageFloor` (lib/recall/bm25-coverage-probe.js)
// into an exit code.
//
// WHY A CHILD PROCESS, NEVER AN IMPORT
//   The gate is a self-executing CLI: it ends in a top-level `await main()` and
//   sets process.exitCode. Importing it would run it inside this test process
//   and its exit code — the entire contract under test — would be unobservable.
//   Every arm therefore drives it with spawnSync.
//
// ARMS
//   (a) an index built from the SAME 10-row fixture ledger, floor 99
//       -> exit 0, verdict "permit", coverage_pct === 100. A PERCENT: 100, not
//          the 1.0 fraction mcp/lib/synthesis/coverage-probe.js's pct() returns.
//   (b) an index built from 1 of those 10 rows, floor 99
//       -> exit 3, verdict "refuse", coverage_pct === 10, error_code
//          "bm25_coverage_below_floor", and the FULL measured envelope still
//          printed. A refusal that printed nothing would be unauditable.
//   (c) --index at a path that does not exist
//       -> exit 2, verdict "refuse". Absence is never a permit.
//   (d) numerator_unit === "distinct_doc_ids" and denominator_unit ===
//       "eligible_lines" on EVERY envelope, measured or not — asserted by
//       assertEnvelopeContract, which every arm calls.
//   (e) --min-coverage-pct=abc -> exit 2 and NOTHING measured: the envelope
//       carries no indexed_docs key at all.
//   (f) --help and an unknown flag -> exit 2. Exit 0 is reserved for "measured
//       and cleared the floor"; no other path may reach it.
//   (g) default resolution: with no path arguments at all the gate resolves its
//       model version from ACTIVE_EMBED_MODEL_VERSION and its index/ledger from
//       MEMORY_ROOT / memoryLedgerPath(). Both are staked at TMP_ROOT here, so
//       this arm proves the retarget works purely by env — and is itself the
//       reason no arm can reach production.
//
// HERMETICITY
//   MEMORY_ROOT / POLICY_BASE_DIR / STORAGE_BASE_DIR / LEDGERS_BASE_DIR are all
//   staked under a mkdtempSync TMP_ROOT BEFORE the first `await import`, and the
//   same four are passed explicitly into every child's env. Fixture indices are
//   built by the REAL v2 writer (rebuildBm25IndexFromLedger), never hand-rolled,
//   so they exercise the on-disk format the production loader parses. No path
//   under the live install's {ledgers,indices,storage} is named anywhere
//   in this file, and every fixture is tens of rows.
//
// Run: cd mcp && node --test test/lexical-coverage-gate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Env staked BEFORE the first dynamic import, so lib/config.js resolves every
// base directory under TMP_ROOT the moment it is first evaluated.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memory-system-lexical-coverage-gate-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.POLICY_BASE_DIR = join(MEMORY_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(MEMORY_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(MEMORY_ROOT, "ledgers");
delete process.env.MEMORY_BM25_MODEL_NEUTRAL;
delete process.env.MEMORY_BM25_REBUILD_TARGET_ACTIVE;
delete process.env.MEMORY_BM25_REBUILD_OBJECT_ENTITIES;

for (const dir of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  join(MEMORY_ROOT, "indices"),
]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort fixture cleanup
  }
});

const { rebuildBm25IndexFromLedger } = await import("../lib/recall/bm25-rebuild.js");
const { ACTIVE_EMBED_MODEL_VERSION } = await import("../lib/validation.js");
const { NUMERATOR_UNIT, DENOMINATOR_UNIT } = await import(
  "../lib/recall/bm25-coverage-probe.js"
);

const GATE = fileURLToPath(
  new URL("../scripts/verify-lexical-coverage-gate.mjs", import.meta.url),
);

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
let seq = 0;

/** Rows the BM25 eligibility predicate accepts: non-empty id AND content. */
function factRows(ids) {
  return ids.map((id, i) => ({
    id,
    kind: "fact",
    content: `alpha beta gamma ${id} row${i}`,
    ts: `2026-08-0${(i % 9) + 1}T00:00:00.000Z`,
  }));
}

function ledgerFile(name, rows) {
  const p = join(TMP_ROOT, `${name}-${seq++}.jsonl`);
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  return p;
}

/**
 * Build a real v2 bm25.json under MEMORY_ROOT/indices/<modelVersion>/ from
 * `rows`, via the production writer. Returns its path.
 */
function buildIndex(modelVersion, rows) {
  const src = ledgerFile(`idx-src-${modelVersion}`, rows);
  const res = rebuildBm25IndexFromLedger({
    ledgerPath: src,
    modelVersion,
    contextualPrefix: false,
  });
  assert.equal(res.wrote_index, true, "fixture index must actually be written");
  return res.bm25_path;
}

/** Drive the gate as a CHILD PROCESS. Never import it — see header. */
function runGate(args) {
  const res = spawnSync(process.execPath, [GATE, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      MEMORY_ROOT,
      POLICY_BASE_DIR: process.env.POLICY_BASE_DIR,
      STORAGE_BASE_DIR: process.env.STORAGE_BASE_DIR,
      LEDGERS_BASE_DIR: process.env.LEDGERS_BASE_DIR,
    },
  });
  return res;
}

/**
 * Parse the gate's stdout. The contract is exactly ONE line of JSON, so a
 * second line (a stray console.log) fails here rather than being tolerated.
 */
function envelopeOf(res) {
  const lines = String(res.stdout).split("\n").filter((l) => l.trim().length > 0);
  assert.equal(
    lines.length,
    1,
    `gate must emit exactly ONE line of JSON on stdout; got ${lines.length}:\n` +
      `--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
  );
  return JSON.parse(lines[0]);
}

/**
 * (d) The units contract, asserted on EVERY envelope — including the two
 * refusals. These three are constants of the probe module, not measurements,
 * so an un-measured envelope carries them too.
 */
function assertEnvelopeContract(env, res) {
  assert.equal(env.numerator_unit, NUMERATOR_UNIT, "numerator_unit");
  assert.equal(env.numerator_unit, "distinct_doc_ids", "numerator_unit literal");
  assert.equal(env.denominator_unit, DENOMINATOR_UNIT, "denominator_unit");
  assert.equal(env.denominator_unit, "eligible_lines", "denominator_unit literal");
  assert.equal(env.coverage_pct_unit, "percent", "coverage_pct_unit");
  assert.ok(
    env.verdict === "permit" || env.verdict === "refuse",
    `verdict must be permit|refuse, got ${JSON.stringify(env.verdict)}`,
  );
  // Exit 0 is reserved for a completed measurement that cleared the floor.
  if (res.status === 0) {
    assert.equal(env.verdict, "permit", "exit 0 must carry verdict permit");
    assert.equal(env.measured, true, "exit 0 must carry a completed measurement");
    assert.ok(Number.isFinite(env.coverage_pct), "exit 0 must carry a finite coverage_pct");
  } else {
    assert.equal(env.verdict, "refuse", "every non-zero exit must carry verdict refuse");
  }
}

/** Fields a MEASURED envelope must carry (the spec's minimum key set). */
function assertMeasuredEnvelope(env) {
  assert.equal(env.measured, true, "measured");
  for (const k of [
    "model_version",
    "index_path",
    "ledger_path",
    "indexed_docs",
    "eligible_rows",
    "coverage_pct",
    "min_coverage_pct",
    "index_integrity",
    "index_digest_verified",
    "probed_at",
    "ledger_stat_identity",
  ]) {
    assert.ok(Object.hasOwn(env, k), `measured envelope must carry ${k}`);
    assert.notEqual(env[k], undefined, `measured envelope ${k} must not be undefined`);
  }
  assert.ok(Number.isInteger(env.indexed_docs), "indexed_docs integer");
  assert.ok(Number.isInteger(env.eligible_rows) && env.eligible_rows > 0, "eligible_rows");
  assert.ok(Number.isFinite(env.coverage_pct), "coverage_pct finite");
  assert.equal(typeof env.probed_at, "string");
  assert.equal(typeof env.ledger_stat_identity, "string");
}

// ===========================================================================
// (a) full coverage -> exit 0, permit, coverage_pct === 100 (a PERCENT).
// ===========================================================================
test("(a) an index holding every eligible row permits at floor 99, coverage_pct 100", () => {
  const rows = factRows(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10"]);
  const indexPath = buildIndex("gate-fixture-full", rows);
  const ledger = ledgerFile("gate-cov-full", rows);

  const res = runGate([
    "--model-version=gate-fixture-full",
    `--index=${indexPath}`,
    `--ledger=${ledger}`,
    "--min-coverage-pct=99",
  ]);
  const env = envelopeOf(res);
  assertEnvelopeContract(env, res);
  assertMeasuredEnvelope(env);

  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr:\n${res.stderr}`);
  assert.equal(env.verdict, "permit");
  assert.equal(env.error_code, null, "a permit carries no error code");
  assert.equal(env.indexed_docs, 10);
  assert.equal(env.eligible_rows, 10);
  // 100 the PERCENT, never 1 the fraction.
  assert.equal(env.coverage_pct, 100);
  assert.equal(env.min_coverage_pct, 99);
  assert.equal(env.model_version, "gate-fixture-full");
});

// ===========================================================================
// (b) 1 of 10 -> exit 3, refuse, coverage_pct === 10, envelope still printed.
// ===========================================================================
test("(b) an index holding 1 of 10 rows refuses at floor 99 with exit 3 and a full envelope", () => {
  const all = factRows(["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9", "b10"]);
  const indexPath = buildIndex("gate-fixture-thin", [all[0]]);
  const ledger = ledgerFile("gate-cov-thin", all);

  const res = runGate([
    "--model-version=gate-fixture-thin",
    `--index=${indexPath}`,
    `--ledger=${ledger}`,
    "--min-coverage-pct=99",
  ]);
  const env = envelopeOf(res);
  assertEnvelopeContract(env, res);
  // The refusal is still a COMPLETED measurement: the envelope is auditable.
  assertMeasuredEnvelope(env);

  assert.equal(res.status, 3, `expected exit 3, got ${res.status}; stderr:\n${res.stderr}`);
  assert.equal(env.verdict, "refuse");
  assert.equal(env.error_code, "bm25_coverage_below_floor");
  assert.equal(env.indexed_docs, 1);
  assert.equal(env.eligible_rows, 10);
  assert.equal(env.coverage_pct, 10);
  assert.equal(env.min_coverage_pct, 99);
});

// ===========================================================================
// (c) a missing index is a REFUSE, never a permit.
// ===========================================================================
test("(c) a missing --index path exits 2 with verdict refuse — absence is not a permit", () => {
  const ledger = ledgerFile("gate-cov-absent", factRows(["c1", "c2", "c3"]));
  const missing = join(TMP_ROOT, "no-such-index-dir", "bm25.json");

  const res = runGate([
    "--model-version=gate-fixture-absent",
    `--index=${missing}`,
    `--ledger=${ledger}`,
    "--min-coverage-pct=99",
  ]);
  const env = envelopeOf(res);
  assertEnvelopeContract(env, res);

  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr:\n${res.stderr}`);
  assert.equal(env.verdict, "refuse");
  assert.equal(env.error_code, "probe_index_unreadable");
  assert.equal(env.measured, false, "an unmeasurable index measured nothing");
  assert.equal(
    Object.hasOwn(env, "indexed_docs"),
    false,
    "an unmeasured envelope must not fabricate indexed_docs",
  );
});

// ===========================================================================
// (c2) an eligible-row-free ledger is a REFUSE too (empty denominator).
// ===========================================================================
test("(c2) a ledger with zero eligible rows exits 2 with verdict refuse", () => {
  const rows = factRows(["d1", "d2", "d3"]);
  const indexPath = buildIndex("gate-fixture-empty-denom", rows);
  // Same shape, but every content is empty -> ineligible for BM25.
  const barren = join(TMP_ROOT, `gate-barren-${seq++}.jsonl`);
  writeFileSync(
    barren,
    rows.map((r) => JSON.stringify({ ...r, content: "" })).join("\n") + "\n",
    { mode: 0o600 },
  );

  const res = runGate([
    "--model-version=gate-fixture-empty-denom",
    `--index=${indexPath}`,
    `--ledger=${barren}`,
    "--min-coverage-pct=99",
  ]);
  const env = envelopeOf(res);
  assertEnvelopeContract(env, res);

  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr:\n${res.stderr}`);
  assert.equal(env.verdict, "refuse");
  assert.equal(env.error_code, "probe_ledger_no_eligible_rows");
  assert.equal(env.measured, false);
});

// ===========================================================================
// (e) a bogus floor measures NOTHING.
// ===========================================================================
test("(e) --min-coverage-pct=abc exits 2 and measures nothing", () => {
  const rows = factRows(["e1", "e2", "e3"]);
  const indexPath = buildIndex("gate-fixture-badfloor", rows);
  const ledger = ledgerFile("gate-cov-badfloor", rows);

  const res = runGate([
    "--model-version=gate-fixture-badfloor",
    `--index=${indexPath}`,
    `--ledger=${ledger}`,
    "--min-coverage-pct=abc",
  ]);
  const env = envelopeOf(res);
  assertEnvelopeContract(env, res);

  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr:\n${res.stderr}`);
  assert.equal(env.verdict, "refuse");
  assert.equal(env.error_code, "gate_bad_arguments");
  assert.equal(env.measured, false, "argument parsing precedes any probe");
  assert.equal(
    Object.hasOwn(env, "indexed_docs"),
    false,
    "nothing was measured, so no indexed_docs may appear",
  );
  assert.equal(env.min_coverage_pct, null, "an unparseable floor is null, never coerced");
});

// ===========================================================================
// (f) no path reaches exit 0 without measuring — --help and unknown flags.
// ===========================================================================
test("(f) --help exits 2 (exit 0 is reserved for a cleared measurement)", () => {
  const res = runGate(["--help"]);
  const env = envelopeOf(res);
  assertEnvelopeContract(env, res);
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}`);
  assert.equal(env.verdict, "refuse");
  assert.equal(env.measured, false);
  assert.ok(String(res.stderr).includes("--min-coverage-pct"), "usage goes to stderr");
});

test("(f2) an unknown flag exits 2 without probing", () => {
  const res = runGate(["--not-a-real-flag=1"]);
  const env = envelopeOf(res);
  assertEnvelopeContract(env, res);
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}`);
  assert.equal(env.verdict, "refuse");
  assert.equal(env.error_code, "gate_bad_arguments");
  assert.equal(env.measured, false);
  assert.equal(Object.hasOwn(env, "indexed_docs"), false);
});

// ===========================================================================
// (g) defaults resolve from ACTIVE_EMBED_MODEL_VERSION + MEMORY_ROOT +
//     memoryLedgerPath() — so the whole gate retargets by env alone.
// ===========================================================================
test("(g) with no arguments the gate resolves model/index/ledger from env", () => {
  const rows = factRows(["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9", "g10"]);
  // The DEFAULT ledger path under the fixture root: LEDGERS_BASE_DIR/memory.jsonl.
  const defaultLedger = join(process.env.LEDGERS_BASE_DIR, "memory.jsonl");
  writeFileSync(defaultLedger, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", {
    mode: 0o600,
  });
  // The DEFAULT index path: MEMORY_ROOT/indices/<ACTIVE_EMBED_MODEL_VERSION>/bm25.json.
  const built = rebuildBm25IndexFromLedger({
    ledgerPath: defaultLedger,
    modelVersion: ACTIVE_EMBED_MODEL_VERSION,
    contextualPrefix: false,
  });
  assert.equal(built.wrote_index, true);

  const res = runGate([]);
  const env = envelopeOf(res);
  assertEnvelopeContract(env, res);
  assertMeasuredEnvelope(env);

  assert.equal(env.model_version, ACTIVE_EMBED_MODEL_VERSION, "default model version");
  assert.equal(
    env.index_path,
    join(MEMORY_ROOT, "indices", ACTIVE_EMBED_MODEL_VERSION, "bm25.json"),
    "default index resolves through MEMORY_ROOT",
  );
  assert.equal(env.ledger_path, defaultLedger, "default ledger resolves through memoryLedgerPath()");
  assert.ok(
    env.index_path.startsWith(TMP_ROOT),
    "the fixture retarget must hold: no production path may be probed",
  );
  assert.ok(env.ledger_path.startsWith(TMP_ROOT), "ledger retarget must hold");
  // Default floor is 99 and this fixture covers everything.
  assert.equal(env.min_coverage_pct, 99, "default --min-coverage-pct");
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr:\n${res.stderr}`);
  assert.equal(env.verdict, "permit");
  assert.equal(env.coverage_pct, 100);
});
