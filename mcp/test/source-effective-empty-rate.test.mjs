// source-effective-empty-rate.test.mjs — L2 (memperf): backward block reader.
//
// Hermetic regression for computeEffectiveEmptyRate's EOF-backward block
// scan. Authoritative spec: memperf node L2 — replace the whole-file
// readFileSync + fixed-8MiB tail with a bounded backward reader that stops
// at the window cutoff, BOF, or a byte budget, and reports partial:true +
// window_covered_h when the budget truncates the window.
//
// Owner contract under test:
//   - Exact in-window counting: rows_in_window / empty_in_window /
//     effective_empty_rate over exactly the in-window rows encountered.
//   - partial=true ONLY on a budget stop before cutoff/BOF; false on
//     cutoff-reached and BOF stops.
//   - window_covered_h = (now - oldest finite ts seen)/3.6e6, 1-decimal,
//     capped at window_days*24 when the cutoff was reached, null when no
//     finite-ts row was seen.
//   - bytes_scanned <= maxScanBytes; a truncated scan reads strictly fewer
//     bytes than the file holds (no silent full read).
//   - Torn final line (no trailing newline) is skipped, never crashes.
//   - status/note contracts for missing-ledger / no-predicate / empty-file /
//     zero-rows are unchanged.
//
// Hermetic discipline: MEMORY_ROOT / STORAGE_BASE_DIR point at a mkdtemp
// root BEFORE the module import, and every ledger path is injected via
// opts.ledgerPath with a fixed opts.now — no test reads real storage.
//
// Run: node mcp/test/source-effective-empty-rate.test.mjs
// Exits 0 on pass, 1 on any failure.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Hermetic root — bind BEFORE the first dynamic import of the module (its
// config.js reads env at import time). Fixtures also live under this root.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "empty-rate-"));
const MEMORY_ROOT = join(TMP_ROOT, "memory-system");
const STORAGE_DIR = join(MEMORY_ROOT, "storage");
mkdirSync(join(STORAGE_DIR, "sources"), { recursive: true, mode: 0o700 });
process.env.MEMORY_ROOT = MEMORY_ROOT;
process.env.STORAGE_BASE_DIR = STORAGE_DIR;
// Operator identity comes from the synthetic fixture, never from a host
// config file. MUST precede the first import: the identity module reads its
// config once, at load.
process.env.MEMORY_OPERATOR_IDENTITY_FILE = fileURLToPath(
  new URL("./fixtures/operator-identity.synthetic.json", import.meta.url),
);

process.on("exit", () => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});

const {
  buildEmptyRateHealthNotes,
  computeEffectiveEmptyRate,
  computeEffectiveEmptyRatesForSources,
  DEFAULT_MAX_SCAN_BYTES,
  DEFAULT_WINDOW_DAYS,
  MAX_BLOCK_SIZE,
  _normalizeBlockSize,
  _normalizeMaxScanBytes,
} = await import("../lib/ingest/source-effective-empty-rate.js");

for (const [name, value] of Object.entries({
  buildEmptyRateHealthNotes,
  computeEffectiveEmptyRate,
  computeEffectiveEmptyRatesForSources,
  DEFAULT_MAX_SCAN_BYTES,
  DEFAULT_WINDOW_DAYS,
  MAX_BLOCK_SIZE,
  _normalizeBlockSize,
  _normalizeMaxScanBytes,
})) {
  if (value === undefined) {
    console.log(`FATAL: source-effective-empty-rate.js must export ${name}.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Test harness — assert-with-label, matches sibling tests.
// ---------------------------------------------------------------------------
let failures = 0;
let passes = 0;
let assertions = 0;

function pass(label) {
  passes++;
  console.log(`  PASS: ${label}`);
}
function fail(label, err) {
  failures++;
  console.log(`  FAIL: ${label}`);
  if (err) console.log(`        ${err && err.stack ? err.stack : err}`);
}
function assertEq(actual, expected, label) {
  assertions++;
  if (actual !== expected) {
    throw new Error(`assertEq(${label}): expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}
function assertTrue(cond, label) {
  assertions++;
  if (!cond) throw new Error(`assertTrue(${label}): expected truthy, got ${JSON.stringify(cond)}`);
}
async function test(label, fn) {
  console.log(`test: ${label}`);
  try {
    await fn();
    pass(label);
  } catch (err) {
    fail(label, err);
  }
}

// ---------------------------------------------------------------------------
// Fixture builders. Rows use the codex-cli emptiness predicate shape:
// empty when BOTH raw_content.user_text and raw_content.assistant_text are
// missing/whitespace-only.
// ---------------------------------------------------------------------------
const NOW = Date.parse("2026-07-12T00:00:00.000Z");
const HOUR = 3_600_000;
const WINDOW_H = DEFAULT_WINDOW_DAYS * 24; // 168

function isoHoursAgo(h) {
  return new Date(NOW - h * HOUR).toISOString();
}
function rowLine(hoursAgo, empty) {
  return JSON.stringify({
    ts: isoHoursAgo(hoursAgo),
    raw_content: empty
      ? { user_text: "", assistant_text: "   " }
      : { user_text: "hello there", assistant_text: "general kenobi, a bold reply" },
  });
}
let fixtureN = 0;
function writeFixture(content) {
  const p = join(TMP_ROOT, `fixture-${fixtureN++}.jsonl`);
  writeFileSync(p, content, { mode: 0o600 });
  return p;
}
function probe(ledgerPath, extraOpts = {}) {
  return computeEffectiveEmptyRate("codex-cli", { ledgerPath, now: NOW, ...extraOpts });
}

// ---------------------------------------------------------------------------
// T-a: window fully covered — 10 in-window rows (4 empty, 6 non-empty) plus
// 5 rows older than the 7d cutoff. Exact counts; older rows excluded;
// cutoff-reached stop => partial=false and window_covered_h capped at 168.
// ---------------------------------------------------------------------------
await test("T-a: fully covered window counts exactly the 10 in-window rows", () => {
  const lines = [
    // 5 rows OLDER than the 168h cutoff (must be excluded from the counts).
    rowLine(190, true),
    rowLine(185, false),
    rowLine(180, true),
    rowLine(175, false),
    rowLine(172, true),
    // 10 in-window rows: empties at hours 160, 100, 40, 10 => 4 empty, 6 not.
    rowLine(160, true),
    rowLine(140, false),
    rowLine(120, false),
    rowLine(100, true),
    rowLine(80, false),
    rowLine(60, false),
    rowLine(40, true),
    rowLine(20, false),
    rowLine(10, true),
    rowLine(1, false),
  ];
  const p = writeFixture(lines.join("\n") + "\n");
  const snap = probe(p);
  assertEq(snap.rows_in_window, 10, "rows_in_window");
  assertEq(snap.empty_in_window, 4, "empty_in_window");
  assertEq(snap.effective_empty_rate, 0.4, "effective_empty_rate");
  assertEq(snap.status, "ok", "status (0.4 <= 0.5 threshold)");
  assertEq(snap.partial, false, "partial=false on cutoff-reached stop");
  assertEq(snap.window_covered_h, WINDOW_H, "window_covered_h capped at window_days*24");
  assertEq(snap.window_days, DEFAULT_WINDOW_DAYS, "window_days label");
  assertEq(snap.bytes_scanned, statSync(p).size, "bytes_scanned == whole small file");
});

// ---------------------------------------------------------------------------
// T-b: window partially covered — 60 EMPTY rows (older, in-window) followed
// by 60 NON-EMPTY rows (newer, in-window). The byte budget is set to half
// the byte-length of the non-empty run, so a correct backward scan can only
// ever see non-empty rows => truncated rate is exactly 0, while the full-
// window rate is 0.5. A silent full read fails the rate assertion.
// ---------------------------------------------------------------------------
await test("T-b: budget-truncated scan reports partial=true and the truncated rate", () => {
  const emptyRun = [];
  for (let h = 100; h > 70; h -= 0.5) emptyRun.push(rowLine(h, true)); // 60 rows
  const nonEmptyRun = [];
  for (let h = 60; h > 30; h -= 0.5) nonEmptyRun.push(rowLine(h, false)); // 60 rows
  const p = writeFixture([...emptyRun, ...nonEmptyRun].join("\n") + "\n");

  const nonEmptyBytes = Buffer.byteLength(nonEmptyRun.join("\n") + "\n", "utf8");
  const maxScanBytes = Math.floor(nonEmptyBytes / 2);
  const blockSize = 512;

  const snap = probe(p, { blockSize, maxScanBytes });
  assertEq(snap.partial, true, "partial=true on budget stop");
  assertEq(snap.empty_in_window, 0, "no empty row reachable within budget");
  assertEq(snap.effective_empty_rate, 0, "truncated rate is exactly 0");
  assertTrue(snap.rows_in_window > 0, "some in-window rows were scanned");
  assertTrue(snap.rows_in_window < 120, "not all rows were scanned");
  assertTrue(snap.bytes_scanned <= maxScanBytes, "bytes_scanned <= maxScanBytes");
  assertTrue(snap.bytes_scanned < statSync(p).size, "bytes_scanned < file size (no full read)");
  assertTrue(
    typeof snap.window_covered_h === "number" && snap.window_covered_h > 0 && snap.window_covered_h < WINDOW_H,
    "0 < window_covered_h < window_days*24",
  );

  // Cross-check: the SAME fixture under the default budget is fully covered
  // (BOF stop) and yields the divergent full-window rate 0.5 with
  // partial=false — proving the truncated rate above was not a full read.
  const full = probe(p);
  assertEq(full.partial, false, "partial=false on BOF stop");
  assertEq(full.rows_in_window, 120, "full scan sees all 120 rows");
  assertEq(full.empty_in_window, 60, "full scan sees the 60 empty rows");
  assertEq(full.effective_empty_rate, 0.5, "full-window rate");
  assertEq(full.window_covered_h, 100, "window_covered_h = oldest row age (uncapped, < 168)");
  assertTrue(snap.effective_empty_rate !== full.effective_empty_rate, "truncated rate != full rate");
});

// ---------------------------------------------------------------------------
// T-c: empty (0-byte) file — status unknown with the existing note contract.
// ---------------------------------------------------------------------------
await test("T-c: 0-byte ledger keeps the 'source ledger empty' contract", () => {
  const p = writeFixture("");
  const snap = probe(p);
  assertEq(snap.status, "unknown", "status");
  assertEq(snap.note, "source ledger empty", "note");
  assertEq(snap.rows_in_window, 0, "rows_in_window");
  assertEq(snap.partial, false, "partial");
  assertEq(snap.bytes_scanned, 0, "bytes_scanned");
  assertEq(snap.window_covered_h, null, "window_covered_h null (no rows seen)");
});

// ---------------------------------------------------------------------------
// T-d: file smaller than one default block — exact counts, BOF stop.
// Oldest row is exactly 48h old => window_covered_h === 48 (uncapped).
// ---------------------------------------------------------------------------
await test("T-d: sub-block file yields exact counts with partial=false", () => {
  const p = writeFixture(
    [rowLine(48, true), rowLine(24, false), rowLine(2, false)].join("\n") + "\n",
  );
  const snap = probe(p); // default blockSize (1MiB) >> file size
  assertEq(snap.rows_in_window, 3, "rows_in_window");
  assertEq(snap.empty_in_window, 1, "empty_in_window");
  assertEq(snap.effective_empty_rate, 1 / 3, "effective_empty_rate");
  assertEq(snap.status, "ok", "status");
  assertEq(snap.partial, false, "partial=false on BOF stop");
  assertEq(snap.window_covered_h, 48, "window_covered_h = age of oldest row");
});

// ---------------------------------------------------------------------------
// T-e: torn final line — a truncated JSON fragment with NO trailing newline
// after 4 valid rows. The fragment is skipped; the 4 valid rows are counted
// exactly; no crash.
// ---------------------------------------------------------------------------
await test("T-e: torn final line is skipped, valid rows counted exactly", () => {
  const valid = [rowLine(20, true), rowLine(15, false), rowLine(10, true), rowLine(5, false)];
  const p = writeFixture(valid.join("\n") + "\n" + '{"ts":"2026-07-11T2');
  const snap = probe(p);
  assertEq(snap.rows_in_window, 4, "rows_in_window (fragment skipped)");
  assertEq(snap.empty_in_window, 2, "empty_in_window");
  assertEq(snap.effective_empty_rate, 0.5, "effective_empty_rate");
  assertEq(snap.status, "ok", "status (0.5 not > 0.5)");
  assertEq(snap.partial, false, "partial");
});

// ---------------------------------------------------------------------------
// T-f: caller honesty at the lib level — a budget-truncated DEGRADED
// snapshot carries partial:true plus a numeric window_covered_h (the fields
// health.js formats into its PARTIAL notes). Newest rows are all empty so
// the truncated scan sees rate 1.0 > 0.5 => degraded. Also proves the
// computeEffectiveEmptyRatesForSources wrapper forwards opts verbatim.
// ---------------------------------------------------------------------------
await test("T-f: partial degraded snapshot carries partial:true + numeric window_covered_h", () => {
  const olderNonEmpty = [];
  for (let h = 60; h > 40; h -= 0.5) olderNonEmpty.push(rowLine(h, false)); // 40 rows
  const newestEmpty = [];
  for (let h = 10; h > 0; h -= 0.25) newestEmpty.push(rowLine(h, true)); // 40 rows
  const p = writeFixture([...olderNonEmpty, ...newestEmpty].join("\n") + "\n");

  const emptyBytes = Buffer.byteLength(newestEmpty.join("\n") + "\n", "utf8");
  const opts = { ledgerPath: p, now: NOW, blockSize: 256, maxScanBytes: Math.floor(emptyBytes / 2) };

  const out = computeEffectiveEmptyRatesForSources({ sources: ["codex-cli"], ...opts });
  const snap = out["codex-cli"];
  assertTrue(snap != null, "wrapper returned the codex-cli snapshot");
  assertEq(snap.status, "degraded", "status degraded (all scanned rows empty)");
  assertEq(snap.effective_empty_rate, 1, "rate exactly 1.0 over scanned rows");
  assertEq(snap.partial, true, "partial=true (wrapper forwarded blockSize/maxScanBytes)");
  assertTrue(
    typeof snap.window_covered_h === "number" && snap.window_covered_h > 0,
    "window_covered_h is a positive number",
  );
  assertTrue(snap.bytes_scanned <= opts.maxScanBytes, "bytes_scanned within budget");
});

// ---------------------------------------------------------------------------
// T-g: unchanged status/note contracts — missing ledger and no-predicate.
// ---------------------------------------------------------------------------
await test("T-g: missing-ledger and no-predicate contracts unchanged", () => {
  const missing = probe(join(TMP_ROOT, "does-not-exist.jsonl"));
  assertEq(missing.status, "unknown", "missing: status");
  assertEq(missing.note, "source ledger missing", "missing: note");

  const noPred = computeEffectiveEmptyRate("git-log", { now: NOW });
  assertEq(noPred.status, "unknown", "no-predicate: status");
  assertEq(noPred.note, "no emptiness predicate for source", "no-predicate: note");
  assertEq(noPred.empty_in_window, null, "no-predicate: empty_in_window null");
});

// ---------------------------------------------------------------------------
// T-h (L2b defect 1): a fractional blockSize in (0,1) must NOT hang the scan.
// An in-process timer cannot interrupt a synchronous loop, so the probe runs
// in a SIGKILL-armed child process. Pre-fix the child never returns and the
// watchdog kills it (signal "SIGKILL", status null); post-fix it exits 0 with
// exact counts.
// ---------------------------------------------------------------------------
const LIB_URL = new URL("../lib/ingest/source-effective-empty-rate.js", import.meta.url).href;

await test("T-h: fractional blockSize must terminate with exact counts", () => {
  const fixture = writeFixture([rowLine(10, true), rowLine(5, false)].join("\n") + "\n");
  const runnerPath = join(TMP_ROOT, "hang-runner.mjs");
  const runnerSrc = [
    `process.env.MEMORY_ROOT = ${JSON.stringify(MEMORY_ROOT)};`,
    `process.env.STORAGE_BASE_DIR = ${JSON.stringify(STORAGE_DIR)};`,
    `const { computeEffectiveEmptyRate } = await import(${JSON.stringify(LIB_URL)});`,
    `const snap = computeEffectiveEmptyRate("codex-cli", {`,
    `  ledgerPath: process.argv[2],`,
    `  now: ${NOW},`,
    `  blockSize: Number(process.argv[3]),`,
    `});`,
    `process.stdout.write(JSON.stringify(snap));`,
    ``,
  ].join("\n");
  writeFileSync(runnerPath, runnerSrc, { mode: 0o600 });

  for (const blockSize of [0.5, 0.999]) {
    const res = spawnSync(process.execPath, [runnerPath, fixture, String(blockSize)], {
      timeout: 8000,
      killSignal: "SIGKILL",
      encoding: "utf8",
    });
    assertEq(res.signal, null, `blockSize=${blockSize}: child not killed by watchdog`);
    assertEq(res.status, 0, `blockSize=${blockSize}: child exited 0`);
    const snap = JSON.parse(res.stdout);
    assertEq(snap.rows_in_window, 2, `blockSize=${blockSize}: rows_in_window`);
    assertEq(snap.empty_in_window, 1, `blockSize=${blockSize}: empty_in_window`);
  }
});

// ---------------------------------------------------------------------------
// T-i (L2b defect 2): ledger lines whose JSON parses to a NON-OBJECT (null,
// number, boolean, string, array) must be skipped per-line — same discipline
// as unparseable lines — never detonate the scan-wide catch. Pre-fix the
// literal `null` line throws TypeError at `parsed.ts` and voids the whole
// probe to status:"unknown", note:"read_error: unknown", rows_in_window:0.
// ---------------------------------------------------------------------------
await test("T-i: non-object rows are contained, valid rows counted exactly", () => {
  const lines = [rowLine(10, true), "null", "5", "true", '"str"', "[1,2]", rowLine(5, false)];
  const p = writeFixture(lines.join("\n") + "\n");
  const snap = probe(p);
  assertEq(snap.rows_in_window, 2, "rows_in_window (non-objects skipped)");
  assertEq(snap.empty_in_window, 1, "empty_in_window");
  assertEq(snap.effective_empty_rate, 0.5, "effective_empty_rate");
  assertEq(snap.status, "ok", "status");
  assertEq(snap.note, null, "note stays null (no read_error)");
});

// ---------------------------------------------------------------------------
// Clamp unit asserts (L2b defect 1, mutant pins): the pure normalizers keep
// blockSize in [1, MAX_BLOCK_SIZE] and maxScanBytes >= 1, with invalid
// (absent / non-finite / non-positive) values falling back to the defaults.
// These kill a clamp-removal mutant that T-h alone might survive on a small
// fixture (e.g. dropping the MAX_BLOCK_SIZE cap only detonates on a huge
// ledger via a whole-file Buffer.alloc).
// ---------------------------------------------------------------------------
await test("clamp: _normalizeBlockSize/_normalizeMaxScanBytes pin the safe ranges", () => {
  const DEFAULT_BLOCK_SIZE = 1 * 1024 * 1024;
  assertEq(_normalizeBlockSize(0.5), 1, "_normalizeBlockSize(0.5) clamps UP to 1");
  assertEq(_normalizeBlockSize(2 ** 40), MAX_BLOCK_SIZE, "_normalizeBlockSize(2**40) capped at MAX_BLOCK_SIZE");
  assertEq(_normalizeBlockSize(undefined), DEFAULT_BLOCK_SIZE, "_normalizeBlockSize(undefined) -> default");
  assertEq(_normalizeBlockSize(-3), DEFAULT_BLOCK_SIZE, "_normalizeBlockSize(-3) -> default");
  assertEq(MAX_BLOCK_SIZE, 64 * 1024 * 1024, "MAX_BLOCK_SIZE is 64MiB");
  assertEq(_normalizeMaxScanBytes(0.5), 1, "_normalizeMaxScanBytes(0.5) clamps UP to 1");
  assertEq(_normalizeMaxScanBytes(undefined), DEFAULT_MAX_SCAN_BYTES, "_normalizeMaxScanBytes(undefined) -> default");
});

// ---------------------------------------------------------------------------
// T-j (L2b defect 3, mutant test): carry reassembly across block boundaries
// must be EXACT. One fixture: 60 in-window rows (every 3rd empty => 20
// empty) plus one extra in-window NON-empty row whose serialized length
// exceeds 3x the small 97-byte block size (multi-block carry accumulation).
// The SAME fixture is probed at blockSize 1 (every line straddles many
// boundaries), blockSize 97 (prime, smaller than every row => every block
// boundary lands mid-row), and default blockSize (single-block ground
// truth). Any mutant that tears a straddling line (both halves fail
// JSON.parse) or drops the carry changes the counts and fails. Pure ASCII
// only — multi-byte-UTF-8-across-boundary decode is a separate seam.
// ---------------------------------------------------------------------------
await test("T-j: carry reassembly is exact across block boundaries", () => {
  const SMALL_BLOCK = 97;
  const lines = [];
  for (let i = 0; i < 60; i++) {
    lines.push(rowLine(60 - i, i % 3 === 0)); // hours 60..1; 20 empty
  }
  const longRow = JSON.stringify({
    ts: isoHoursAgo(30.5),
    raw_content: {
      user_text: "long-non-empty " + "x".repeat(400), // pure ASCII pad
      assistant_text: "a bold reply",
    },
  });
  assertTrue(
    Buffer.byteLength(longRow, "utf8") > 3 * SMALL_BLOCK,
    "long row spans more than 3 small blocks",
  );
  lines.splice(30, 0, longRow); // 61 rows total, 20 empty
  const p = writeFixture(lines.join("\n") + "\n");

  const snaps = [
    probe(p, { blockSize: 1 }),
    probe(p, { blockSize: SMALL_BLOCK }),
    probe(p), // default blockSize: single-block read, ground truth
  ];
  for (const [i, snap] of snaps.entries()) {
    const label = ["blockSize=1", `blockSize=${SMALL_BLOCK}`, "blockSize=default"][i];
    assertEq(snap.rows_in_window, 61, `${label}: rows_in_window`);
    assertEq(snap.empty_in_window, 20, `${label}: empty_in_window`);
    assertEq(snap.effective_empty_rate, 20 / 61, `${label}: effective_empty_rate`);
    assertEq(snap.partial, false, `${label}: partial`);
    assertEq(snap.window_covered_h, snaps[2].window_covered_h, `${label}: window_covered_h identical`);
  }
});

// ---------------------------------------------------------------------------
// T-k (L2b defect 4): buildEmptyRateHealthNotes guards window_covered_h.
// (a) End-to-end: maxScanBytes:1 (post-clamp legal) with the default
//     blockSize stops before ANY read => snapshot {partial:true,
//     bytes_scanned:0, window_covered_h:null}; the partial note must render
//     "covered unknown of 168h" — never the substring "null".
// (b) Numeric pin: for numeric window_covered_h the strings are
//     byte-identical to the format health.js previously assembled inline.
// ---------------------------------------------------------------------------
await test("T-k: health notes render 'unknown' for null coverage, numeric strings pinned", () => {
  // (a) end-to-end null-coverage partial snapshot.
  const p = writeFixture([rowLine(10, true), rowLine(5, false)].join("\n") + "\n");
  const snap = probe(p, { maxScanBytes: 1 });
  assertEq(snap.partial, true, "partial=true (budget stop before any read)");
  assertEq(snap.bytes_scanned, 0, "bytes_scanned=0");
  assertEq(snap.window_covered_h, null, "window_covered_h null (no row seen)");
  const notes = buildEmptyRateHealthNotes({ "codex-cli": snap });
  assertTrue(
    notes.some((n) => n.includes("covered unknown of 168h")),
    "partial note renders 'covered unknown of 168h'",
  );
  for (const n of notes) {
    assertTrue(!n.includes("null"), `no note contains 'null': ${n}`);
  }

  // (b) numeric pin — full strings byte-identical to prior health.js output.
  const crafted = {
    status: "degraded",
    effective_empty_rate: 1,
    partial: true,
    window_covered_h: 9.5,
    window_days: 7,
    empty_in_window: 40,
    rows_in_window: 40,
    bytes_scanned: 1234,
  };
  const pinned = buildEmptyRateHealthNotes({ "codex-cli": crafted });
  assertEq(pinned.length, 2, "degraded+partial snapshot yields exactly 2 notes");
  assertEq(
    pinned[0],
    "source_effective_empty_rate_degraded: codex-cli 100% empty over last 9.5h (PARTIAL, budget-truncated) (40/40 rows)",
    "degraded note pinned byte-identical",
  );
  assertEq(
    pinned[1],
    "source_effective_empty_rate_partial: codex-cli scan covered 9.5h of 168h (bytes_scanned=1234)",
    "partial note pinned byte-identical",
  );
});

// ---------------------------------------------------------------------------
// T-l/T-m (h7): content-field classification follows adapter declarations.
// The adapter barrel is the source registry; the predicate manifest must read
// each adapter's own CONTENT_FIELD_SPEC instead of copying platform membership
// or field names. A source with no declaration remains explicitly unmeasurable.
// ---------------------------------------------------------------------------
const { isContentFree } = await import("../lib/predicates/content-free.js");
const { getContentFieldSpec } = await import(
  "../lib/predicates/content-fields-manifest.js"
);
const { ADAPTER_MODULES } = await import(
  "../lib/messaging/adapters/registry.js"
);

await test("T-l: a planted undeclared source stays unmeasurable and fail-open", () => {
  const verdict = isContentFree(
    { raw_content: { text: "", content: "" } },
    "planted-undeclared-source",
  );
  assertEq(verdict.drop, false, "undeclared source is not scored as content-free");
  assertEq(verdict.reason, null, "undeclared source has no drop reason");
  assertEq(
    verdict.triggers.join(","),
    "unregistered_source",
    "undeclared source lands in the explicit unmeasurable bucket",
  );
});

await test("T-m: every adapter source is classified from its own declaration", () => {
  for (const adapter of ADAPTER_MODULES) {
    const source = adapter && adapter.PLATFORM;
    assertTrue(
      adapter && Object.hasOwn(adapter, "CONTENT_FIELD_SPEC"),
      `${source || "adapter-without-platform"}: adapter owns CONTENT_FIELD_SPEC`,
    );
    assertTrue(
      Object.isFrozen(adapter.CONTENT_FIELD_SPEC),
      `${source}: CONTENT_FIELD_SPEC is frozen`,
    );

    const resolved = getContentFieldSpec(source);
    assertTrue(resolved !== null, `${source}: declaration is registered`);
    assertTrue(
      resolved.fields === adapter.CONTENT_FIELD_SPEC.fields,
      `${source}: manifest reuses the adapter fields array by identity`,
    );
    assertTrue(
      resolved.metadata === adapter.CONTENT_FIELD_SPEC.metadata,
      `${source}: manifest reuses the adapter metadata array by identity`,
    );

    const emptyRawContent = Object.fromEntries(
      resolved.fields.map((field) => [field, ""]),
    );
    const emptyRow = {
      raw_content: emptyRawContent,
      ...Object.fromEntries(resolved.metadata.map((field) => [field, 0])),
    };
    assertEq(
      isContentFree(emptyRow, source).drop,
      true,
      `${source}: declared empty fields are scored content-free`,
    );

    const populatedRow = {
      raw_content: { ...emptyRawContent, [resolved.fields[0]]: "payload" },
    };
    assertEq(
      isContentFree(populatedRow, source).drop,
      false,
      `${source}: declared content rescues the row`,
    );
  }
});

// ---------------------------------------------------------------------------
// B2 (memory-roots) — operator alias-candidate tally riding the mail scan.
// Contract under test (lib/identity/alias-candidates.js + the mail hook in
// computeEffectiveEmptyRate):
//   - mail snapshots ALWAYS carry alias_candidates (array); other sources never;
//   - the tally adds no I/O: bytes_scanned equals the fixture size and is
//     identical when opts.aliasTally is a no-op factory;
//   - account_dominant / name_token keys, thresholds from CAPS;
//   - registered addresses are never candidates;
//   - malformed rows never void the emptiness metric;
//   - note formatter string is exact; [] on null.
// ---------------------------------------------------------------------------
const {
  buildAliasCandidateHealthNotes,
  createAliasCandidateTally,
  deriveNameTokens,
} = await import("../lib/identity/alias-candidates.js");
const { getOperatorIdentities } = await import("../lib/identity/operator-identity.js");

for (const [name, value] of Object.entries({
  buildAliasCandidateHealthNotes,
  createAliasCandidateTally,
  deriveNameTokens,
})) {
  if (value === undefined) {
    console.log(`FATAL: alias-candidates.js must export ${name}.`);
    process.exit(1);
  }
}

const B2_NOW = Date.parse("2026-08-11T12:00:00.000Z");
const B2_ACCT_A = "00000000-TEST-0000-0000-000000000001"; // registered mailbox
const B2_ACCT_B = "00000000-TEST-0000-0000-000000000002"; // unregistered mailbox
let b2Seq = 0;

// One mail row of the connector's landed shape (raw_content.headers.from/to/
// cc, unsubscribe_type, list_id_hash, mailbox_url). Each row is 1h younger
// than the previous so the append-only ts ordering the scan relies on holds;
// the first row sits 99h before B2_NOW, well inside the 168h window (a
// fixture that starts a seq at -400 lands every row outside it). `from` and
// `folder` (B6) are optional: no From: header unless given, INBOX unless
// given.
function b2Row({ to, cc, from, account, folder, unsubscribe_type = 0, listId = null, text = "body" }) {
  b2Seq += 1;
  const rc = { text, unsubscribe_type, list_id_hash: listId, headers: {} };
  if (typeof from === "string") rc.headers.from = from;
  if (typeof to === "string") rc.headers.to = to;
  if (typeof cc === "string") rc.headers.cc = cc;
  if (account) rc.mailbox_url = `imap://${account}/${folder || "INBOX"}`;
  return JSON.stringify({ ts: new Date(B2_NOW - (100 - b2Seq) * HOUR).toISOString(), raw_content: rc });
}
function b2Rows(n, spec) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(b2Row(spec));
  return out;
}
function b2Fixture(name, lines) {
  const p = join(STORAGE_DIR, "sources", name);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}
const B2_NOOP_TALLY = () => ({ observe() {}, summarize() { return []; } });

// T-a fixture: account A is the registered alex@example.com mailbox (10
// rows); account B receives 8 rows for alice@example.test (6 direct + 2 list)
// and 1 row for alex@example.com, so alice's share of B is 8/9 = 0.889.
function b2FixtureTa() {
  b2Seq = 0;
  return b2Fixture("mail-b2-ta.jsonl", [
    ...b2Rows(10, { to: "Alex Example <alex@example.com>", account: B2_ACCT_A }),
    ...b2Rows(6, { to: "alice@example.test", account: B2_ACCT_B }),
    ...b2Rows(2, { to: "alice@example.test", account: B2_ACCT_B, unsubscribe_type: 7 }),
    b2Row({ to: "alex@example.com", account: B2_ACCT_B }),
  ]);
}

await test("T-a: an unregistered address dominating one account -> account_dominant; tally adds no bytes", () => {
  const path = b2FixtureTa();
  const withTally = computeEffectiveEmptyRate("mail", { ledgerPath: path, now: B2_NOW });
  assertTrue(Array.isArray(withTally.alias_candidates), "mail snapshot carries alias_candidates array");
  assertEq(withTally.alias_candidates.length, 1, "exactly one candidate");
  const c = withTally.alias_candidates[0];
  assertEq(c.address, "alice@example.test", "candidate address");
  assertEq(c.reason, "account_dominant", "reason");
  assertEq(c.direct_rows, 6, "direct_rows counts only non-list rows");
  assertEq(c.total_rows, 8, "total_rows counts every row the address is on");
  assertEq(c.account_share, 0.889, "account_share = 8/9 rounded to 3 dp");
  assertEq(Object.keys(c).sort().join(","), "account_share,address,direct_rows,reason,total_rows", "candidate key set");
  assertEq(withTally.bytes_scanned, statSync(path).size, "bytes_scanned equals the fixture size (single scan)");
  assertEq(withTally.rows_in_window, 19, "rows_in_window");
  assertEq(withTally.partial, false, "not partial");

  const noop = computeEffectiveEmptyRate("mail", { ledgerPath: path, now: B2_NOW, aliasTally: B2_NOOP_TALLY });
  assertEq(noop.bytes_scanned, withTally.bytes_scanned, "bytes_scanned identical with a no-op tally");
  assertEq(noop.rows_in_window, withTally.rows_in_window, "rows_in_window identical with a no-op tally");
  assertEq(noop.empty_in_window, withTally.empty_in_window, "empty_in_window identical with a no-op tally");
  assertEq(JSON.stringify(noop.alias_candidates), "[]", "no-op tally yields []");

  // Injected registry (the live-check seam): registering alice silences her.
  const injected = computeEffectiveEmptyRate("mail", {
    ledgerPath: path,
    now: B2_NOW,
    aliasTally: () => createAliasCandidateTally({ registeredEmails: ["alex@example.com", "alice@example.test"] }),
  });
  assertEq(JSON.stringify(injected.alias_candidates), "[]", "a registered address is never a candidate (injected registry)");
  assertEq(injected.bytes_scanned, withTally.bytes_scanned, "bytes_scanned identical with an injected registry");
});

// T-b/T-c fixture: the registered mailbox (20 rows) plus alex@example.test
// with `direct` direct rows and 4 list rows (unsubscribe_type: 7) in the SAME
// account, so its share (7/27 = 0.259) is below min_account_share and only the
// name-token key can elect it. "alex" is a token of the registered EMAILS
// local-parts (deriveNameTokens over the configured registry).
function b2FixtureAlex(name, direct) {
  b2Seq = 0;
  return b2Fixture(name, [
    ...b2Rows(20, { to: "alex@example.com", account: B2_ACCT_A }),
    ...b2Rows(direct, { to: "Alex Example <alex@example.test>", account: B2_ACCT_A }),
    ...b2Rows(4, { to: "alex@example.test", account: B2_ACCT_A, unsubscribe_type: 7 }),
  ]);
}

await test("T-b: a low-volume address carrying an operator name token with 3 direct rows -> name_token", () => {
  // Which input pins which bound:
  //   "sam2sample" pins the split on non-alpha (a digit separates two tokens);
  //   "j.sample"   pins a minimum length of at least 2 (the one-letter prefix
  //                is dropped) and no more: it cannot tell 2 from 3;
  //   "sample4ab"  pins the minimum at exactly 3: its two-letter tail "ab"
  //                would join the set if the bound were lowered to 2.
  const tokens = deriveNameTokens(["alex@example.com", "alex.example@example.org", "ops@example.org", "alex@devbox.example.com", "sam2sample@example.org", "j.sample@example.org", "sample4ab@example.org"]);
  assertEq([...tokens].sort().join(","), "alex,example,ops,sam,sample", "deriveNameTokens: alpha tokens >= 3 chars of the local-parts");
  // The configured (synthetic) registry also carries ops@example.org -> token
  // "ops" (pins the {alex, example, ops} token set T-o relies on).
  assertTrue(deriveNameTokens(getOperatorIdentities().emails).has("ops"), "configured registry tokens include 'ops' (ops@example.org)");
  const path = b2FixtureAlex("mail-b2-tb.jsonl", 3);
  const snap = computeEffectiveEmptyRate("mail", { ledgerPath: path, now: B2_NOW });
  assertEq(snap.alias_candidates.length, 1, "one candidate");
  const c = snap.alias_candidates[0];
  assertEq(c.address, "alex@example.test", "address");
  assertEq(c.reason, "name_token", "reason is name_token (share 0.259 < 0.5)");
  assertEq(c.direct_rows, 3, "direct_rows === 3 — the 4 list rows are excluded");
  assertEq(c.total_rows, 7, "total_rows === 7");
  assertEq(c.account_share, 0.259, "account_share = 7/27");
  assertEq(snap.bytes_scanned, statSync(path).size, "single scan");
});

await test("T-c: the same address with only 2 direct rows is not a candidate", () => {
  const path = b2FixtureAlex("mail-b2-tc.jsonl", 2);
  const snap = computeEffectiveEmptyRate("mail", { ledgerPath: path, now: B2_NOW });
  assertEq(JSON.stringify(snap.alias_candidates), "[]", "below min_direct_rows -> absent");
  assertEq(snap.rows_in_window, 26, "rows still counted");
});

await test("T-d: a registered address dominating its account is never a candidate", () => {
  b2Seq = 0;
  const path = b2Fixture("mail-b2-td.jsonl", [
    ...b2Rows(12, { to: "alex@example.com", account: B2_ACCT_A }),
    ...b2Rows(3, { to: "alex@example.com", cc: "alex.example@example.org", account: B2_ACCT_A }),
  ]);
  const snap = computeEffectiveEmptyRate("mail", { ledgerPath: path, now: B2_NOW });
  assertEq(JSON.stringify(snap.alias_candidates), "[]", "registered addresses are silent under the real registry");
  assertEq(snap.rows_in_window, 15, "rows_in_window");
});

await test("T-e: rows with headers:{} / raw_content:null / non-string To never throw and leave the emptiness counts unchanged", () => {
  b2Seq = 0;
  const lines = [
    ...b2Rows(6, { to: "alice@example.test", account: B2_ACCT_B }),
    JSON.stringify({ ts: new Date(B2_NOW - 10 * HOUR).toISOString(), raw_content: { text: "x", headers: {} } }),
    JSON.stringify({ ts: new Date(B2_NOW - 9 * HOUR).toISOString(), raw_content: null }),
    JSON.stringify({ ts: new Date(B2_NOW - 8 * HOUR).toISOString(), raw_content: { text: "", headers: { to: 12345, cc: ["not", "a", "string"] } } }),
    JSON.stringify({ ts: new Date(B2_NOW - 7 * HOUR).toISOString(), raw_content: { text: "   ", headers: "not-an-object", mailbox_url: 42 } }),
  ];
  const path = b2Fixture("mail-b2-te.jsonl", lines);
  // Pre-change expectation, by hand: 10 finite-ts rows in window; empty when
  // raw_content is an object whose text is missing/blank -> the "" and "   "
  // rows (2). raw_content:null is not an object, so it is neither empty nor a throw.
  const snap = computeEffectiveEmptyRate("mail", { ledgerPath: path, now: B2_NOW });
  assertEq(snap.rows_in_window, 10, "rows_in_window unchanged (10)");
  assertEq(snap.empty_in_window, 2, "empty_in_window unchanged (2)");
  assertEq(snap.status, "ok", "status ok (0.2 <= 0.5)");
  assertEq(snap.alias_candidates.length, 1, "the well-formed rows still elect alice");
  assertEq(snap.alias_candidates[0].address, "alice@example.test", "candidate");
  const noop = computeEffectiveEmptyRate("mail", { ledgerPath: path, now: B2_NOW, aliasTally: B2_NOOP_TALLY });
  assertEq(noop.rows_in_window, 10, "no-op tally: rows_in_window");
  assertEq(noop.empty_in_window, 2, "no-op tally: empty_in_window");
  assertEq(noop.bytes_scanned, snap.bytes_scanned, "no-op tally: bytes_scanned identical");
  // A throwing tally factory / observe / summarize must not void the metric either.
  const throwing = computeEffectiveEmptyRate("mail", {
    ledgerPath: path,
    now: B2_NOW,
    aliasTally: () => ({ observe() { throw new Error("boom"); }, summarize() { throw new Error("boom"); } }),
  });
  assertEq(throwing.rows_in_window, 10, "throwing tally: rows_in_window");
  assertEq(throwing.empty_in_window, 2, "throwing tally: empty_in_window");
  assertEq(JSON.stringify(throwing.alias_candidates), "[]", "throwing summarize -> []");
  const throwingFactory = computeEffectiveEmptyRate("mail", {
    ledgerPath: path,
    now: B2_NOW,
    aliasTally: () => { throw new Error("no tally"); },
  });
  assertEq(throwingFactory.rows_in_window, 10, "throwing factory: rows_in_window");
  assertEq(JSON.stringify(throwingFactory.alias_candidates), "[]", "throwing factory -> []");
});

await test("T-f: non-mail sources carry no alias_candidates key; mail carries it on every branch", () => {
  b2Seq = 0;
  const im = b2Fixture("imessage-b2-tf.jsonl", [
    JSON.stringify({ ts: new Date(B2_NOW - 5 * HOUR).toISOString(), raw_content: { text: "hi" } }),
    JSON.stringify({ ts: new Date(B2_NOW - 4 * HOUR).toISOString(), raw_content: { text: "" } }),
  ]);
  const imSnap = computeEffectiveEmptyRate("imessage", { ledgerPath: im, now: B2_NOW });
  assertEq(imSnap.rows_in_window, 2, "imessage rows counted");
  assertTrue(!Object.hasOwn(imSnap, "alias_candidates"), "imessage snapshot has no alias_candidates key");
  const codex = computeEffectiveEmptyRate("codex-cli", { ledgerPath: join(STORAGE_DIR, "sources", "nope.jsonl"), now: B2_NOW });
  assertTrue(!Object.hasOwn(codex, "alias_candidates"), "codex-cli (missing ledger) has no alias_candidates key");
  const missing = computeEffectiveEmptyRate("mail", { ledgerPath: join(STORAGE_DIR, "sources", "nope-mail.jsonl"), now: B2_NOW });
  assertEq(missing.note, "source ledger missing", "missing-ledger branch");
  assertEq(JSON.stringify(missing.alias_candidates), "[]", "mail missing-ledger branch carries []");
  const empty = b2Fixture("mail-b2-tf-empty.jsonl", []);
  writeFileSync(empty, "");
  const emptySnap = computeEffectiveEmptyRate("mail", { ledgerPath: empty, now: B2_NOW });
  assertEq(emptySnap.note, "source ledger empty", "empty-ledger branch");
  assertEq(JSON.stringify(emptySnap.alias_candidates), "[]", "mail empty-ledger branch carries []");
  b2Seq = -400; // every row older than the 7d window
  const stale = b2Fixture("mail-b2-tf-stale.jsonl", b2Rows(3, { to: "alice@example.test", account: B2_ACCT_B }));
  const staleSnap = computeEffectiveEmptyRate("mail", { ledgerPath: stale, now: B2_NOW });
  assertEq(staleSnap.note, "zero rows in window", "zero-rows branch");
  assertEq(JSON.stringify(staleSnap.alias_candidates), "[]", "mail zero-rows branch carries [] (out-of-window rows are never observed)");
});

await test("T-g: buildAliasCandidateHealthNotes string format is exact; [] on null/absent", () => {
  assertEq(JSON.stringify(buildAliasCandidateHealthNotes(null)), "[]", "null -> []");
  assertEq(JSON.stringify(buildAliasCandidateHealthNotes(undefined)), "[]", "undefined -> []");
  assertEq(JSON.stringify(buildAliasCandidateHealthNotes({})), "[]", "no alias_candidates -> []");
  assertEq(JSON.stringify(buildAliasCandidateHealthNotes({ window_days: 7, alias_candidates: null })), "[]", "null alias_candidates -> []");
  assertEq(JSON.stringify(buildAliasCandidateHealthNotes({ window_days: 7, alias_candidates: [] })), "[]", "empty list -> []");
  const notes = buildAliasCandidateHealthNotes({
    window_days: 7,
    alias_candidates: [
      { address: "alice@example.test", direct_rows: 6, total_rows: 8, account_share: 0.889, reason: "account_dominant" },
      { address: "alex@example.test", direct_rows: 3, total_rows: 7, account_share: 0.259, reason: "name_token" },
      { address: "alex@both.test", direct_rows: 4, total_rows: 4, account_share: 0.75, reason: "both" },
    ],
  });
  assertEq(notes.length, 3, "one note per candidate");
  assertEq(notes[0], "operator_alias_candidate: alice@example.test (6 direct non-list mails in 7d, account_dominant, share=0.889)", "account_dominant carries share");
  assertEq(notes[1], "operator_alias_candidate: alex@example.test (3 direct non-list mails in 7d, name_token)", "name_token carries no share");
  assertEq(notes[2], "operator_alias_candidate: alex@both.test (4 direct non-list mails in 7d, both, share=0.750)", "both carries share at 3 dp fixed (0.75 -> 0.750)");
  // One fixed format, share=D.DDD — the same regex health-read-failures T9/T10 pin.
  const re = /^operator_alias_candidate: \S+ \(\d+ direct non-list mails in 7d, (account_dominant|name_token|both)(, share=[01]\.\d{3})?\)$/;
  for (const n of notes) assertTrue(re.test(n), `note matches the acceptance regex: ${n}`);
  const full = buildAliasCandidateHealthNotes({
    window_days: 7,
    alias_candidates: [{ address: "n@example.test", direct_rows: 1, total_rows: 104, account_share: 1, reason: "account_dominant" }],
  });
  assertEq(full[0], "operator_alias_candidate: n@example.test (1 direct non-list mails in 7d, account_dominant, share=1.000)", "a 104/104 account renders share=1.000 (never share=1)");
  for (const n of full) assertTrue(re.test(n), `share=1.000 note matches the acceptance regex: ${n}`);
  const nonFinite = buildAliasCandidateHealthNotes({
    window_days: 7,
    alias_candidates: [{ address: "n@example.test", direct_rows: 1, total_rows: 1, account_share: NaN, reason: "account_dominant" }],
  });
  assertEq(nonFinite[0], "operator_alias_candidate: n@example.test (1 direct non-list mails in 7d, account_dominant)", "a non-finite share renders no suffix");
  // End-to-end: the T-a snapshot formats to the same string the health surface emits.
  const snap = computeEffectiveEmptyRate("mail", { ledgerPath: b2FixtureTa(), now: B2_NOW });
  assertEq(
    JSON.stringify(buildAliasCandidateHealthNotes(snap)),
    JSON.stringify(["operator_alias_candidate: alice@example.test (6 direct non-list mails in 7d, account_dominant, share=0.889)"]),
    "T-a snapshot renders the exact note"
  );
});

// B5: the name_token key elects only SOLE-recipient direct rows (the address
// is in To:, every other To: address is registered, no Cc:) with a nonzero
// account share. Before the guard, a third party merely Cc'd on 5 of the
// operator's mails whose local-part shared the "alex" token was elected as
// name_token with direct_rows=5 — a PII leak of a non-operator address into
// health_notes[].
await test("T-n: a third-party Cc address sharing a name token is never a name_token candidate; sole-To with a registered co-recipient still is; zero account share is not", () => {
  b2Seq = 0;
  const cc = b2Fixture("mail-b2-th-cc.jsonl", [
    ...b2Rows(20, { to: "alex@example.com", account: B2_ACCT_A }),
    ...b2Rows(5, { to: "someone@northwestern.test", cc: "alex.smith@thirdparty-corp.test", account: B2_ACCT_A }),
  ]);
  const ccSnap = computeEffectiveEmptyRate("mail", { ledgerPath: cc, now: B2_NOW });
  assertEq(ccSnap.rows_in_window, 25, "rows_in_window");
  assertEq(JSON.stringify(ccSnap.alias_candidates), "[]", "Cc-only alex.smith (token hit, 5 direct rows) is NOT elected");
  assertTrue(
    !ccSnap.alias_candidates.some((c) => c.address === "alex.smith@thirdparty-corp.test" && c.reason === "name_token" && c.direct_rows === 5),
    "the pre-guard regression shape (alex.smith name_token direct_rows=5) is gone"
  );
  assertEq(ccSnap.bytes_scanned, statSync(cc).size, "single scan");

  // Companion positive: a registered co-recipient in To: (the operator's
  // self-forward To: alias + alex@example.com) still counts as sole.
  b2Seq = 0;
  const self = b2Fixture("mail-b2-th-self.jsonl", [
    ...b2Rows(20, { to: "alex@example.com", account: B2_ACCT_A }),
    ...b2Rows(3, { to: "Alex <alex@example.test>, alex@example.com", account: B2_ACCT_A }),
  ]);
  const selfSnap = computeEffectiveEmptyRate("mail", { ledgerPath: self, now: B2_NOW });
  assertEq(selfSnap.alias_candidates.length, 1, "registered co-recipient: one candidate");
  assertEq(selfSnap.alias_candidates[0].address, "alex@example.test", "registered co-recipient: alex@example.test elected");
  assertEq(selfSnap.alias_candidates[0].reason, "name_token", "registered co-recipient: reason name_token");
  assertEq(selfSnap.alias_candidates[0].direct_rows, 3, "registered co-recipient: direct_rows 3");
  assertEq(Object.keys(selfSnap.alias_candidates[0]).sort().join(","), "account_share,address,direct_rows,reason,total_rows", "candidate key set unchanged (sole_direct_rows is internal)");

  // Companion negative: sole-To rows with NO mailbox_url have zero account
  // share, so the name_token key does not fire.
  b2Seq = 0;
  const noAcct = b2Fixture("mail-b2-th-noacct.jsonl", [
    ...b2Rows(20, { to: "alex@example.com", account: B2_ACCT_A }),
    ...b2Rows(3, { to: "alex@example.test" }),
  ]);
  const noAcctSnap = computeEffectiveEmptyRate("mail", { ledgerPath: noAcct, now: B2_NOW });
  assertEq(noAcctSnap.rows_in_window, 23, "no-account rows still counted");
  assertEq(JSON.stringify(noAcctSnap.alias_candidates), "[]", "zero account share -> not elected");
});

// B6: the name_token key counts only INBOUND sole-direct rows. The B5 guard
// left a hole for the operator's OWN outbound mail — a row From: alex@example.com
// To: <third party> with no Cc: is sole-To for the third party, so 3 such
// mails to an address sharing a name token ("ops" is a registered token)
// would name the third party in health_notes[]. Same for Drafts (To: is
// whoever the operator was writing to) and for Rule-0 junk folders (the
// operator classified the row away; listDropReason covers rules 1-4 only,
// so those rows are still "direct"). The exclusion keys on From: and the
// folder, not on the row shape: the mirror (From: a third party To: an
// alias) still elects.
await test("T-o: outbound (From: registered), Drafts and junk-folder sole rows never elect name_token; the inbound mirror still does", () => {
  // (a) 20 rows To: alex@example.com + 3 outbound rows From: alex@example.com To: a third
  // party carrying the "ops" token, same account, no Cc -> [].
  b2Seq = 0;
  const outbound = b2Fixture("mail-b2-to-outbound.jsonl", [
    ...b2Rows(20, { to: "alex@example.com", account: B2_ACCT_A }),
    ...b2Rows(3, { from: "Alex Example <alex@example.com>", to: "ops@acme-thirdparty.test", account: B2_ACCT_A }),
  ]);
  const outSnap = computeEffectiveEmptyRate("mail", { ledgerPath: outbound, now: B2_NOW });
  assertEq(outSnap.rows_in_window, 23, "outbound: rows_in_window");
  assertEq(JSON.stringify(outSnap.alias_candidates), "[]", "outbound: third party To: on operator-sent mail is NOT elected");
  assertEq(outSnap.bytes_scanned, statSync(outbound).size, "outbound: single scan");

  // (b) the mirror: 3 rows From: the third party To: alex@example.test ->
  // exactly one name_token candidate (proves the exclusion keys on From:).
  b2Seq = 0;
  const inbound = b2Fixture("mail-b2-to-inbound.jsonl", [
    ...b2Rows(20, { to: "alex@example.com", account: B2_ACCT_A }),
    ...b2Rows(3, { from: "ops@acme-thirdparty.test", to: "alex@example.test", account: B2_ACCT_A }),
  ]);
  const inSnap = computeEffectiveEmptyRate("mail", { ledgerPath: inbound, now: B2_NOW });
  assertEq(inSnap.alias_candidates.length, 1, "inbound mirror: one candidate");
  assertEq(inSnap.alias_candidates[0].address, "alex@example.test", "inbound mirror: alex@example.test elected");
  assertEq(inSnap.alias_candidates[0].reason, "name_token", "inbound mirror: reason name_token");
  assertEq(inSnap.alias_candidates[0].direct_rows, 3, "inbound mirror: direct_rows 3");
  assertEq(Object.keys(inSnap.alias_candidates[0]).sort().join(","), "account_share,address,direct_rows,reason,total_rows", "inbound mirror: candidate key set unchanged");
  assertTrue(!inSnap.alias_candidates.some((c) => c.address === "ops@acme-thirdparty.test"), "inbound mirror: the From: third party is never a candidate");
  assertEq(inSnap.bytes_scanned, statSync(inbound).size, "inbound mirror: single scan");

  // (c) sole inbound rows in Drafts and Spam folders (3 + 3, direct under
  // listDropReason) -> []; the same 3 sole INBOX rows would elect (b).
  b2Seq = 0;
  const folders = b2Fixture("mail-b2-to-folders.jsonl", [
    ...b2Rows(20, { to: "alex@example.com", account: B2_ACCT_A }),
    ...b2Rows(3, { to: "alex@example.test", account: B2_ACCT_A, folder: "%5BGmail%5D/Drafts" }),
    ...b2Rows(3, { to: "alex@example.test", account: B2_ACCT_A, folder: "%5BGmail%5D/Spam" }),
  ]);
  const folderSnap = computeEffectiveEmptyRate("mail", { ledgerPath: folders, now: B2_NOW });
  assertEq(folderSnap.rows_in_window, 26, "folders: rows_in_window");
  assertEq(JSON.stringify(folderSnap.alias_candidates), "[]", "folders: Drafts + Spam sole rows are NOT elected");
  assertEq(folderSnap.bytes_scanned, statSync(folders).size, "folders: single scan");
});

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log("");
console.log(
  `source-effective-empty-rate.test.mjs: ${passes} passed, ${failures} failed, ${assertions} assertions`,
);
if (failures > 0) {
  process.exit(1);
}
process.exit(0);
