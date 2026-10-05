// catchup-projection.test.mjs — WORKUNIT C1 gate. The checkpointed catch-up
// envelope projection (mcp/lib/messaging/envelope-projection.js) + its wiring
// inside loadSourcesFromLedgers (catchup.js).
//
// What C1 must prove, on FIXTURES (temp roots via opts.root, the n11d pattern —
// the real ledgers are never opened here):
//   (a) append-delta fold == full recompute, BYTE-identically, across the
//       memory tier, the disk tier, and multiple query windows;
//   (b) a torn (no trailing "\n") tail is handled: parity with the full stream
//       while torn, exactly-once once the newline lands, never stored;
//   (c) a ledger rewrite / truncation defeats the checkpoint => full re-stream;
//   (d) a corrupt/garbled projection file => full re-stream (fail-closed), then
//       self-heals via the post-serve rebuild;
//   (e) the stored ring bound (LEDGER_RETAIN_CEILING) is respected across
//       repeated delta folds, and an unprovable window falls back;
//   (f) a source read failure still surfaces VISIBLY (per-source []), never a
//       silent stale-projection serve;
//   (g) ZERO platform tokens in envelope-projection.js (the frozen
//       L2to5_SOURCES list covers catchup.js but NOT the new module — it is
//       passed explicitly), plus the reader stays read-only on source ledgers
//       and the projection write is atomic (no tmp litter) with mode 0600.
//
// Hermetic: node:test + node:assert/strict, mkdtempSync temp roots, no network,
// no live DB, no dispatch import. Every scheduled background persist is awaited
// before temp roots are removed.

import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  loadSourcesFromLedgers,
  buildAdapterRegistry,
} from "../../lib/messaging/catchup.js";

// The retain primitive comes from the LEAF that owns it, not from catchup.js
// (f5-catchup-seam broke the catchup <-> envelope-projection import cycle by
// moving these two bindings down into an import-free module).
import {
  makeLedgerRetainFold,
  LEDGER_RETAIN_CEILING,
} from "../../lib/messaging/ledger-retain.js";

import {
  PROJECTION_SCHEMA_VERSION,
  projectionFilePath,
  rebuildProjectionForSource,
  _awaitPendingProjectionPersists,
  _clearProjectionMemoryCacheForTests,
  _peekProjectionDiagnosticsForTests,
  _peekProjectionMemEntryForTests,
} from "../../lib/messaging/envelope-projection.js";

import { grepPlatformTokens } from "../../lib/messaging/n10-invariant-eval.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENVELOPE_PROJECTION_SRC = path.resolve(
  __dirname,
  "../../lib/messaging/envelope-projection.js",
);
const CATCHUP_SRC = path.resolve(__dirname, "../../lib/messaging/catchup.js");

// Pinned clock so the since-window math is deterministic across runs.
const NOW = Date.parse("2026-07-01T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A single-source fixture registry keyed on an arbitrary slug (identity mapper;
// the loader only reads `ledgerPath` off it — n11d T9 pattern).
function fixtureRegistry(slug) {
  return buildAdapterRegistry([{ PLATFORM: slug, _toEnvelope: (r) => r }]);
}

function makeRoot(tag) {
  const root = mkdtempSync(path.join(tmpdir(), `c1-proj-${tag}-`));
  mkdirSync(path.join(root, "storage", "sources"), { recursive: true });
  return root;
}

function ledgerPathOf(root, slug) {
  return path.join(root, "storage", "sources", `${slug}.jsonl`);
}

function row(i, tsMs) {
  return { ts: new Date(tsMs).toISOString(), n: i, id: `r${i}` };
}

function writeRows(p, rows, { append = false } = {}) {
  const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  if (append) appendFileSync(p, text);
  else writeFileSync(p, text);
}

function sha256(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

// Byte-diff of the full rows JSON for one source (the C1 equivalence unit).
function rowsJson(sources, slug) {
  return JSON.stringify(sources[slug]);
}

async function cleanupRoot(root) {
  await _awaitPendingProjectionPersists();
  rmSync(root, { recursive: true, force: true });
}

// ===========================================================================
// (a) append-delta fold == full recompute, byte-identically, mem + disk tiers.
// ===========================================================================

test("T1: projection serve (memory + disk tier, with append delta) is byte-identical to the full stream across query windows", async () => {
  const slug = "src_alpha";
  const REG = fixtureRegistry(slug);
  const root = makeRoot("t1");
  const lp = ledgerPathOf(root, slug);
  _clearProjectionMemoryCacheForTests();
  try {
    // 100 OLD rows (10 days back) + 200 recent rows — so a since-window prunes.
    const initial = [];
    for (let i = 0; i < 100; i += 1) initial.push(row(i, NOW - 10 * DAY + i * 1000));
    for (let i = 100; i < 300; i += 1) initial.push(row(i, NOW - (300 - i) * HOUR));
    writeRows(lp, initial);

    // Call 1: no projection yet -> full stream + post-serve rebuild.
    const first = loadSourcesFromLedgers(REG, { root, now: NOW });
    assert.equal(first[slug].length, 300, "full stream served all 300 rows");
    assert.equal(
      _peekProjectionDiagnosticsForTests().serves[slug].reason,
      "no-projection",
      "first call fell back for the honest reason",
    );
    await _awaitPendingProjectionPersists();
    const pf = projectionFilePath(root, slug);
    assert.ok(statSync(pf).isFile(), "post-serve rebuild persisted a projection file");
    assert.equal(statSync(pf).mode & 0o777, 0o600, "projection file is mode 0600");

    // Append a 50-row delta.
    const delta = [];
    for (let i = 300; i < 350; i += 1) delta.push(row(i, NOW - (350 - i) * 60 * 1000));
    writeRows(lp, delta, { append: true });

    const combos = [{}, { since_ms: DAY, limit: 5 }, { limit: 400 }];
    for (const combo of combos) {
      const full = loadSourcesFromLedgers(REG, { root, now: NOW, projection: false, ...combo });
      const mem = loadSourcesFromLedgers(REG, { root, now: NOW, ...combo });
      assert.equal(
        rowsJson(mem, slug),
        rowsJson(full, slug),
        `memory-tier projection output byte-identical (${JSON.stringify(combo)})`,
      );
      assert.equal(
        _peekProjectionDiagnosticsForTests().serves[slug].mode,
        "projection",
        `memory tier actually served from the projection (${JSON.stringify(combo)})`,
      );
      _clearProjectionMemoryCacheForTests();
      const disk = loadSourcesFromLedgers(REG, { root, now: NOW, ...combo });
      const diag = _peekProjectionDiagnosticsForTests().serves[slug];
      assert.equal(
        rowsJson(disk, slug),
        rowsJson(full, slug),
        `disk-tier projection output byte-identical (${JSON.stringify(combo)})`,
      );
      assert.equal(diag.mode, "projection", "disk tier served from the projection");
      assert.equal(diag.cache, "disk", "disk tier read the persisted file");
      assert.equal(diag.delta_rows, 50, "disk tier folded exactly the 50-row append delta");
    }
  } finally {
    await cleanupRoot(root);
  }
});

// ===========================================================================
// (b) torn tail: parity while torn, exactly-once after termination, not stored.
// ===========================================================================

test("T2: a torn (unterminated) tail row keeps parity with the full stream and lands exactly once", async () => {
  const slug = "src_torn";
  const REG = fixtureRegistry(slug);
  const root = makeRoot("t2");
  const lp = ledgerPathOf(root, slug);
  _clearProjectionMemoryCacheForTests();
  try {
    const initial = [];
    for (let i = 0; i < 40; i += 1) initial.push(row(i, NOW - (40 - i) * HOUR));
    writeRows(lp, initial);
    loadSourcesFromLedgers(REG, { root, now: NOW });
    await _awaitPendingProjectionPersists();

    // Torn append: a complete JSON row with NO trailing newline.
    const tornRow = row(999, NOW - 1000);
    appendFileSync(lp, JSON.stringify(tornRow));

    const full = loadSourcesFromLedgers(REG, { root, now: NOW, projection: false });
    const proj = loadSourcesFromLedgers(REG, { root, now: NOW });
    assert.equal(rowsJson(proj, slug), rowsJson(full, slug), "torn-tail output byte-identical");
    assert.equal(proj[slug].at(-1).n, 999, "the torn-but-parseable row IS served (legacy parity)");
    assert.equal(
      _peekProjectionDiagnosticsForTests().serves[slug].mode,
      "projection",
      "the torn tail did not defeat the projection serve",
    );
    const mem = _peekProjectionMemEntryForTests(lp);
    assert.equal(mem.row_count, 40, "the torn row is NOT folded into the stored tail");

    // Terminate the torn row and append one more; the torn row must appear
    // exactly once (replayed via the delta, not duplicated by the parity read).
    appendFileSync(lp, "\n");
    writeRows(lp, [row(1000, NOW - 500)], { append: true });
    const full2 = loadSourcesFromLedgers(REG, { root, now: NOW, projection: false });
    const proj2 = loadSourcesFromLedgers(REG, { root, now: NOW });
    assert.equal(rowsJson(proj2, slug), rowsJson(full2, slug), "post-termination byte-identical");
    assert.equal(
      proj2[slug].filter((r) => r.n === 999).length,
      1,
      "the completed row appears exactly once",
    );
    assert.equal(proj2[slug].at(-1).n, 1000, "the row appended after the torn one is served");
  } finally {
    await cleanupRoot(root);
  }
});

// ===========================================================================
// (c) rewrite / truncation => checkpoint defeated => full re-stream.
// ===========================================================================

test("T3: a ledger rewrite or truncation defeats the checkpoint and forces a full re-stream", async () => {
  const slug = "src_rewrite";
  const REG = fixtureRegistry(slug);
  const root = makeRoot("t3");
  const lp = ledgerPathOf(root, slug);
  _clearProjectionMemoryCacheForTests();
  try {
    const initial = [];
    for (let i = 0; i < 60; i += 1) initial.push(row(i, NOW - (60 - i) * HOUR));
    writeRows(lp, initial);
    loadSourcesFromLedgers(REG, { root, now: NOW });
    await _awaitPendingProjectionPersists();
    // Warm serve to seed the memory tier.
    loadSourcesFromLedgers(REG, { root, now: NOW });
    assert.equal(_peekProjectionDiagnosticsForTests().serves[slug].mode, "projection");

    // REWRITE: same row count, different first row content (block-0 witness).
    const rewritten = initial.map((r, i) => (i === 0 ? { ...r, id: "REWRITTEN" } : r));
    writeRows(lp, rewritten);
    const full = loadSourcesFromLedgers(REG, { root, now: NOW, projection: false });
    const served = loadSourcesFromLedgers(REG, { root, now: NOW });
    const diag = _peekProjectionDiagnosticsForTests().serves[slug];
    assert.equal(diag.mode, "full-stream", "rewrite => projection refused");
    assert.equal(diag.reason, "checkpoint-unverified", "rewrite detected by the prefix witness");
    assert.equal(rowsJson(served, slug), rowsJson(full, slug), "fallback output == full stream");
    assert.equal(served[slug][0].id, "REWRITTEN", "the REWRITTEN bytes are what got served");

    // TRUNCATION: shrink the file below the (self-healed) checkpoint eof.
    await _awaitPendingProjectionPersists(); // let the post-fallback rebuild land
    loadSourcesFromLedgers(REG, { root, now: NOW }); // re-warm on the rewritten file
    assert.equal(_peekProjectionDiagnosticsForTests().serves[slug].mode, "projection");
    writeRows(lp, rewritten.slice(0, 10));
    const full3 = loadSourcesFromLedgers(REG, { root, now: NOW, projection: false });
    const served3 = loadSourcesFromLedgers(REG, { root, now: NOW });
    assert.equal(
      _peekProjectionDiagnosticsForTests().serves[slug].reason,
      "checkpoint-unverified",
      "truncation defeats the checkpoint",
    );
    assert.equal(rowsJson(served3, slug), rowsJson(full3, slug), "truncation fallback == full stream");
    assert.equal(served3[slug].length, 10, "the truncated content is what got served");
  } finally {
    await cleanupRoot(root);
  }
});

// ===========================================================================
// (d) corrupt/garbled projection file => full re-stream, then self-heal.
// ===========================================================================

test("T4: every corrupt-projection variant fails closed to the full stream, then self-heals", async () => {
  const slug = "src_corrupt";
  const REG = fixtureRegistry(slug);
  const root = makeRoot("t4");
  const lp = ledgerPathOf(root, slug);
  _clearProjectionMemoryCacheForTests();
  try {
    const initial = [];
    for (let i = 0; i < 30; i += 1) initial.push(row(i, NOW - (30 - i) * HOUR));
    writeRows(lp, initial);
    loadSourcesFromLedgers(REG, { root, now: NOW });
    await _awaitPendingProjectionPersists();
    const pf = projectionFilePath(root, slug);
    const healthy = readFileSync(pf, "utf8");
    const healthyParsed = JSON.parse(healthy);

    const corruptions = [
      ["garbled bytes", "{\"schema_version\":1, THIS IS NOT JSON"],
      [
        "wrong schema_version",
        JSON.stringify({ ...healthyParsed, schema_version: PROJECTION_SCHEMA_VERSION + 1 }),
      ],
      ["invalid checkpoint", JSON.stringify({ ...healthyParsed, checkpoint: { v: 1 } })],
      [
        "non-object row smuggled into the tail",
        JSON.stringify({ ...healthyParsed, rows: [...healthyParsed.rows, "not-a-row"] }),
      ],
    ];
    const full = loadSourcesFromLedgers(REG, { root, now: NOW, projection: false });
    for (const [label, bytes] of corruptions) {
      writeFileSync(pf, bytes);
      _clearProjectionMemoryCacheForTests();
      const served = loadSourcesFromLedgers(REG, { root, now: NOW });
      const diag = _peekProjectionDiagnosticsForTests().serves[slug];
      assert.equal(diag.mode, "full-stream", `${label} => full re-stream`);
      assert.equal(diag.reason, "no-projection", `${label} => the file was discarded`);
      assert.equal(rowsJson(served, slug), rowsJson(full, slug), `${label} => output intact`);
      await _awaitPendingProjectionPersists(); // the post-fallback rebuild self-heals
    }
    _clearProjectionMemoryCacheForTests();
    loadSourcesFromLedgers(REG, { root, now: NOW });
    assert.equal(
      _peekProjectionDiagnosticsForTests().serves[slug].mode,
      "projection",
      "after the rebuild the projection serves again (self-heal)",
    );
  } finally {
    await cleanupRoot(root);
  }
});

// ===========================================================================
// (e) ring bound respected across repeated delta folds; unprovable window
//     falls back.
// ===========================================================================

test("T5: the stored tail stays bounded by LEDGER_RETAIN_CEILING across repeated delta folds", async () => {
  const slug = "src_ring";
  const REG = fixtureRegistry(slug);
  const root = makeRoot("t5");
  const lp = ledgerPathOf(root, slug);
  _clearProjectionMemoryCacheForTests();
  try {
    const n0 = LEDGER_RETAIN_CEILING + 100;
    const rows0 = [];
    for (let i = 0; i < n0; i += 1) rows0.push(row(i, NOW - (n0 + 500 - i) * 1000));
    writeRows(lp, rows0);
    loadSourcesFromLedgers(REG, { root, now: NOW });
    await _awaitPendingProjectionPersists();
    let mem = _peekProjectionMemEntryForTests(lp);
    assert.equal(mem.row_count, LEDGER_RETAIN_CEILING, "rebuild bounded the stored tail");
    assert.equal(mem.tail_complete, false, "an evicting tail is honestly marked incomplete");

    // Two successive delta folds; the bound must hold after each.
    let appended = n0;
    for (const batch of [300, 200]) {
      const d = [];
      for (let i = 0; i < batch; i += 1) {
        d.push(row(appended + i, NOW - (500 - (appended + i - n0)) * 1000));
      }
      appended += batch;
      writeRows(lp, d, { append: true });
      const full = loadSourcesFromLedgers(REG, { root, now: NOW, projection: false });
      const served = loadSourcesFromLedgers(REG, { root, now: NOW });
      assert.equal(
        _peekProjectionDiagnosticsForTests().serves[slug].mode,
        "projection",
        "delta fold served from the projection",
      );
      assert.equal(rowsJson(served, slug), rowsJson(full, slug), "delta fold byte-identical");
      mem = _peekProjectionMemEntryForTests(lp);
      assert.equal(
        mem.row_count,
        LEDGER_RETAIN_CEILING,
        `stored tail still exactly at the ceiling after +${batch}`,
      );
    }

    // Unprovable window: an evicted (incomplete) tail + a since-window passing
    // fewer rows than the retain cap => the projection must REFUSE and the
    // full stream must serve (fail-closed, still byte-identical by definition).
    const sinceMs = 100 * 1000; // ~100 passing rows << retainCap (2000)
    const fullW = loadSourcesFromLedgers(REG, { root, now: NOW, projection: false, since_ms: sinceMs });
    const servedW = loadSourcesFromLedgers(REG, { root, now: NOW, since_ms: sinceMs });
    const diag = _peekProjectionDiagnosticsForTests().serves[slug];
    assert.equal(diag.mode, "full-stream", "unprovable window => full stream");
    assert.equal(diag.reason, "window-insufficient", "for the honest reason");
    assert.equal(rowsJson(servedW, slug), rowsJson(fullW, slug), "fallback output intact");
  } finally {
    await cleanupRoot(root);
  }
});

// ===========================================================================
// (f) source failure stays VISIBLE — never a silent stale-projection serve.
// ===========================================================================

test("T6: an unreadable ledger surfaces as [] even when a valid projection exists; healthy sources are unaffected", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("chmod-based unreadability is not enforceable as root");
    return;
  }
  const good = "src_good";
  const bad = "src_bad";
  const REG = buildAdapterRegistry([
    { PLATFORM: good, _toEnvelope: (r) => r },
    { PLATFORM: bad, _toEnvelope: (r) => r },
  ]);
  const root = makeRoot("t6");
  const lpGood = ledgerPathOf(root, good);
  const lpBad = ledgerPathOf(root, bad);
  _clearProjectionMemoryCacheForTests();
  try {
    writeRows(lpGood, [row(1, NOW - HOUR)]);
    writeRows(lpBad, [row(2, NOW - HOUR)]);
    loadSourcesFromLedgers(REG, { root, now: NOW });
    await _awaitPendingProjectionPersists();

    chmodSync(lpBad, 0o000);
    const served = loadSourcesFromLedgers(REG, { root, now: NOW });
    assert.deepEqual(served[bad], [], "unreadable ledger -> [] (VISIBLE failure, not stale rows)");
    const diags = _peekProjectionDiagnosticsForTests().serves;
    assert.equal(
      diags[bad].mode,
      "full-stream",
      "the projection refused to serve over an unreadable ledger",
    );
    assert.equal(served[good].length, 1, "the healthy source still serves");
    assert.equal(diags[good].mode, "projection", "…and serves from its projection");
  } finally {
    try {
      chmodSync(lpBad, 0o600);
    } catch {
      // already gone
    }
    await cleanupRoot(root);
  }
});

// ===========================================================================
// (g) invariants: zero platform tokens, source ledgers read-only, atomic
//     persist, and the shared fold really is shared.
// ===========================================================================

test("T7: envelope-projection.js carries ZERO platform tokens (explicit sources arg — the frozen L2-5 list does not cover it)", () => {
  const proj = grepPlatformTokens([ENVELOPE_PROJECTION_SRC]);
  assert.equal(
    proj.count,
    0,
    `envelope-projection.js must be token-free; offending: ${JSON.stringify(proj.matches)}`,
  );
  const catchup = grepPlatformTokens([CATCHUP_SRC]);
  assert.equal(
    catchup.count,
    0,
    `catchup.js must stay token-free after C1; offending: ${JSON.stringify(catchup.matches)}`,
  );
});

test("T8: projection-path reads leave the source ledger byte-identical; the persist is atomic (no tmp litter) and 0600", async () => {
  const slug = "src_ro";
  const REG = fixtureRegistry(slug);
  const root = makeRoot("t8");
  const lp = ledgerPathOf(root, slug);
  _clearProjectionMemoryCacheForTests();
  try {
    const rows0 = [];
    for (let i = 0; i < 25; i += 1) rows0.push(row(i, NOW - (25 - i) * HOUR));
    writeRows(lp, rows0);
    loadSourcesFromLedgers(REG, { root, now: NOW });
    await _awaitPendingProjectionPersists();
    writeRows(lp, [row(25, NOW - 1000)], { append: true });
    const before = sha256(lp);
    loadSourcesFromLedgers(REG, { root, now: NOW }); // projection + delta serve
    loadSourcesFromLedgers(REG, { root, now: NOW, since_ms: DAY, limit: 3 });
    await _awaitPendingProjectionPersists();
    assert.equal(sha256(lp), before, "source ledger bytes untouched by projection serves");

    const projDir = path.dirname(projectionFilePath(root, slug));
    const litter = readdirSync(projDir).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(litter, [], "no tmp files left behind (atomic rename)");
    assert.equal(
      statSync(projectionFilePath(root, slug)).mode & 0o777,
      0o600,
      "projection file mode 0600",
    );
  } finally {
    await cleanupRoot(root);
  }
});

test("T9: rebuildProjectionForSource is the same fold — a direct rebuild then serve equals the full stream", async () => {
  const slug = "src_direct";
  const REG = fixtureRegistry(slug);
  const root = makeRoot("t9");
  const lp = ledgerPathOf(root, slug);
  _clearProjectionMemoryCacheForTests();
  try {
    const rows0 = [];
    for (let i = 0; i < 55; i += 1) rows0.push(row(i, NOW - (55 - i) * HOUR));
    writeRows(lp, rows0);
    const r = rebuildProjectionForSource({ root, sourceKey: slug, ledgerAbsPath: lp });
    assert.equal(r.ok, true, `direct rebuild persisted (reason=${r.reason})`);
    const full = loadSourcesFromLedgers(REG, { root, now: NOW, projection: false });
    const served = loadSourcesFromLedgers(REG, { root, now: NOW });
    assert.equal(_peekProjectionDiagnosticsForTests().serves[slug].mode, "projection");
    assert.equal(rowsJson(served, slug), rowsJson(full, slug), "prebuilt projection byte-identical");
    // Sanity that the exported fold behaves as the ring the reader documents.
    const fold = makeLedgerRetainFold(null, 3);
    for (let i = 0; i < 5; i += 1) fold.push({ n: i });
    assert.deepEqual(
      fold.rows().map((x) => x.n),
      [2, 3, 4],
      "the extracted fold retains the most-recent cap rows in order",
    );
    assert.equal(fold.wrapped(), true, "fold reports eviction");
  } finally {
    await cleanupRoot(root);
  }
});
