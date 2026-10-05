// entity-index-witness-cache.test.mjs — C1: witness-checkpoint validation of
// the entity-index cold-start cache (ENTITY_INDEX_CHECKPOINT_CACHE, default
// OFF).
//
// WHAT IS UNDER TEST
//   entity-index.js used to accept its 33.7 MB cold-start cache ONLY when
//   `parsed.ledger_mtime_ms === statSync(ledger).mtimeMs`. On an append-only
//   ledger that equality is the wrong axis: the mtime moves on every daemon
//   append while the prefix bytes do not. Measured on the live system, the
//   cache recorded 1782135041389.2107 against a ledger mtime of
//   1785870328096.9207 — 43.23 days apart — so EVERY cold process discarded a
//   perfectly valid cache and re-streamed 2,897,071,538 bytes.
//   C1 rebases that decision (behind the flag) onto the S1 checkpoint
//   primitive in lib/synthesis/ledger-checkpoint.js.
//
// HERMETIC: every case builds its own ledger + cache under a mkdtemp root.
// The live ledger and the live storage/entity-index.cache.json are NEVER
// read, written, or stat'd — the
// `load()` helper hard-asserts that both paths sit under TMP_ROOT.
//
// CASE MAP (each is an independent process-cold case: _resetEntityIndexCache()
// drops the module-scope append-aware projection, and the flag is set/deleted
// per case because entity-index reads it at CALL time):
//   (a) DIFFERENTIAL — one fixture, two flag states, asserted in the SAME run:
//       a ledger whose mtime differs from the cached ledger_mtime_ms REBUILDS
//       with the flag unset and SEEDS FROM CACHE with the flag set. This is
//       the red/green of C1 and stays a permanent regression guard.
//   (b) COVERAGE — after a stale-mtime cache HIT over a GROWN ledger, the
//       appended tail rows are in the index; and a row TORN at seed time is
//       folded exactly once when its "\n" lands. Reverting the resumeOffset
//       wiring (the seed reports checkpoint.eof, not the raw file size) turns
//       the torn-row leg RED — the projection would resume mid-row and drop it
//       permanently (append-aware-ledger-projection.js:319-325).
//   (c) CONTINUITY — a witness-cap overflow (captureCheckpoint resamples and
//       marks prefixVerified) must NOT be read as a discontinuity. Reading it
//       the other way forced a full rebuild every ~63 updates in both W1/H1
//       consumers.
//   (d) DISCONTINUITY — rewritten prefix bytes never seed; full rebuild, and
//       the cache FILE survives.
//   (e) FALLBACK MATRIX — missing / corrupt-JSON / undeserializable-checkpoint
//       / legacy-no-checkpoint caches each rebuild (and legacy self-migrates by
//       stamping a checkpoint); the cache file is never deleted.
//   (f) FAIL-STATIC — a present-but-unreadable ledger serves the cached index
//       read-only and does NOT rewrite the cache (a null capture must never
//       clobber a populated cache with an empty one).
//   (g) FLAG OFF — today's behavior exactly: mtime equality still decides, an
//       unknown `checkpoint` key is ignored, and the persisted payload is
//       byte-identical to the pre-C1 shape (no `checkpoint` key, same four
//       fields in the same order).
//
// Observability trick used throughout: after a cache is built, a POISON bucket
// that exists ONLY in the cache file (never in the ledger) is injected. Its
// presence after a load proves the index was SEEDED FROM CACHE; its absence
// proves a full rebuild from ledger bytes. No production stats hook needed.
//
// Run: cd mcp && node test/entity-index-witness-cache.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadOrRebuildIndex,
  lookupByEntity,
  _resetEntityIndexCache,
} from "../lib/synthesis/entity-index.js";

// ---------------------------------------------------------------------------
// Hermetic fixtures
// ---------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "c1-entity-witness-cache-"));

after(() => {
  delete process.env.ENTITY_INDEX_CHECKPOINT_CACHE;
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const FLAG = "ENTITY_INDEX_CHECKPOINT_CACHE";
const POISON_ID = "person:c1:cache_only_probe";
const POISON_MEMORY_ID = "mem-cache-only-never-in-ledger";

/** Flag ON / OFF. Read at CALL time by entity-index, so a single process can
 *  exercise both — that is exactly what case (a) needs. */
function flagOn() {
  process.env[FLAG] = "1";
}
function flagOff() {
  delete process.env[FLAG];
}

let wsSeq = 0;
function newWorkspace(name) {
  const ws = join(TMP_ROOT, `${String(++wsSeq).padStart(2, "0")}-${name}`);
  mkdirSync(ws, { recursive: true, mode: 0o700 });
  return {
    ws,
    ledgerPath: join(ws, "memory.jsonl"),
    cachePath: join(ws, "entity-index.cache.json"),
  };
}

/** One ledger row (JSONL line, newline-terminated) stamping `canonicalIds`. */
function rowLine(id, canonicalIds) {
  return (
    JSON.stringify({
      id,
      kind: "fact",
      ts: "2026-06-18T00:00:00Z",
      content: `content for ${id}`,
      features: {
        entities: canonicalIds.map((cid) => ({
          kind: "person",
          canonical_id: cid,
          surface: cid,
        })),
      },
    }) + "\n"
  );
}

function writeLedger(ledgerPath, lines) {
  writeFileSync(ledgerPath, lines.join(""), { mode: 0o600 });
}

function appendLedger(ledgerPath, text) {
  appendFileSync(ledgerPath, text);
}

/** Force an exact ledger mtime (ms since epoch) — mtime divergence is the
 *  whole point of C1, so it is set explicitly rather than hoped for. */
function setLedgerMtime(ledgerPath, ms) {
  const d = new Date(ms);
  utimesSync(ledgerPath, d, d);
}

function readCache(cachePath) {
  return JSON.parse(readFileSync(cachePath, "utf8"));
}

function writeCache(cachePath, obj) {
  writeFileSync(cachePath, JSON.stringify(obj), { mode: 0o600 });
}

/** loadOrRebuildIndex with a hermeticity assertion on every call. */
async function load({ ledgerPath, cachePath }) {
  assert.ok(
    ledgerPath.startsWith(TMP_ROOT) && cachePath.startsWith(TMP_ROOT),
    "HERMETICITY: a case tried to load outside the temp root",
  );
  return loadOrRebuildIndex({ ledgerPath, cachePath });
}

/**
 * Build a ledger + a checkpoint-stamped cache for it, then inject the
 * cache-only POISON bucket. Leaves the module-scope projection cold and the
 * flag ON; callers set the flag they actually want to test.
 */
async function buildCheckpointedCache(w, rows) {
  writeLedger(w.ledgerPath, rows);
  flagOn();
  _resetEntityIndexCache();
  await load(w);
  const cached = readCache(w.cachePath);
  assert.equal(cached.schema_version, "v1", "fixture: schema stays v1 (additive checkpoint)");
  assert.ok(
    cached.checkpoint && typeof cached.checkpoint === "object",
    "fixture: the flag-ON persist must stamp a checkpoint",
  );
  cached.entries[POISON_ID] = [POISON_MEMORY_ID];
  writeCache(w.cachePath, cached);
  _resetEntityIndexCache();
  return cached;
}

function assertSeededFromCache(idx, msg) {
  assert.deepEqual(
    lookupByEntity(idx, POISON_ID),
    [POISON_MEMORY_ID],
    `${msg} (the cache-only bucket is missing → the index was rebuilt from ledger bytes)`,
  );
}

function assertFullRebuild(idx, msg) {
  assert.deepEqual(
    lookupByEntity(idx, POISON_ID),
    [],
    `${msg} (the cache-only bucket survived → the cache was seeded, not rebuilt)`,
  );
}

// Fixed, distinctly-stale mtimes. Far from "now", so a cached ledger_mtime_ms
// can never coincidentally equal them.
const MTIME_STALE = 1700000000000; // 2023-11-14T22:13:20Z
const MTIME_SEED = 1700000600000;
const MTIME_AFTER_TORN_ROW_COMPLETED = MTIME_SEED + 5000;

// ---------------------------------------------------------------------------
// (a) DIFFERENTIAL — stale mtime: flag OFF rebuilds, flag ON seeds from cache
// ---------------------------------------------------------------------------

test("(a) stale-mtime cache: REBUILDS with the flag off, SEEDS FROM CACHE with the flag on (same run)", async () => {
  // Two identical fixtures: the flag-ON leg rewrites its cache, so sharing one
  // workspace would let the legs contaminate each other.
  const makeFixture = async (name) => {
    const w = newWorkspace(name);
    await buildCheckpointedCache(w, [
      rowLine("mem-1", ["person:c1:alice"]),
      rowLine("mem-2", ["person:c1:bob"]),
    ]);
    // Append (append-only: the prefix bytes are untouched) and force a ledger
    // mtime that cannot equal the one recorded in the cache.
    appendLedger(w.ledgerPath, rowLine("mem-3", ["person:c1:carol"]));
    setLedgerMtime(w.ledgerPath, MTIME_STALE);
    const cached = readCache(w.cachePath);
    assert.notEqual(
      cached.ledger_mtime_ms,
      statSync(w.ledgerPath).mtimeMs,
      "fixture: the cached ledger_mtime_ms must be STALE for this case to mean anything",
    );
    return w;
  };

  const offFixture = await makeFixture("a-flag-off");
  const onFixture = await makeFixture("a-flag-on");

  // --- flag OFF: today's behavior — mtime inequality forces a full rebuild.
  flagOff();
  _resetEntityIndexCache();
  const idxOff = await load(offFixture);
  assertFullRebuild(idxOff, "flag OFF must full-rebuild on an mtime mismatch");
  assert.deepEqual(
    lookupByEntity(idxOff, "person:c1:carol"),
    ["mem-3"],
    "flag OFF: the rebuilt index still reflects ledger truth",
  );

  // --- flag ON: the prefix is intact, so the cache is valid regardless of mtime.
  flagOn();
  _resetEntityIndexCache();
  const idxOn = await load(onFixture);
  assertSeededFromCache(idxOn, "flag ON must seed from the cache despite the stale mtime");
  assert.deepEqual(
    lookupByEntity(idxOn, "person:c1:alice"),
    ["mem-1"],
    "flag ON: cached buckets survive the seed",
  );
  assert.deepEqual(
    lookupByEntity(idxOn, "person:c1:carol"),
    ["mem-3"],
    "flag ON: the appended row is folded on top of the cached prefix",
  );
});

// ---------------------------------------------------------------------------
// (b) COVERAGE — the seed reports EXACT byte coverage (checkpoint.eof)
// ---------------------------------------------------------------------------

test("(b) stale-mtime cache HIT over a grown ledger indexes the appended tail, and a row torn at seed time folds once completed", async () => {
  const w = newWorkspace("b-coverage");
  await buildCheckpointedCache(w, [rowLine("mem-1", ["person:c1:alice"])]);

  // Grow: two terminated tail rows + a TORN partial row (no trailing "\n"),
  // exactly the daemon-mid-append shape the projection must survive.
  appendLedger(w.ledgerPath, rowLine("mem-2", ["person:c1:bob"]));
  appendLedger(w.ledgerPath, rowLine("mem-3", ["person:c1:carol"]));
  const tornRow = rowLine("mem-4", ["person:c1:dave"]);
  const tornHead = tornRow.slice(0, tornRow.length - 12);
  const tornRest = tornRow.slice(tornRow.length - 12);
  assert.ok(!tornHead.includes("\n"), "fixture: the torn head must not be newline-terminated");
  appendLedger(w.ledgerPath, tornHead);
  setLedgerMtime(w.ledgerPath, MTIME_SEED);

  flagOn();
  _resetEntityIndexCache();
  const first = await load(w);
  assertSeededFromCache(first, "grown ledger with an intact prefix must still seed from cache");
  assert.deepEqual(
    lookupByEntity(first, "person:c1:bob"),
    ["mem-2"],
    "APPENDED tail row must be in the index after a cache hit",
  );
  assert.deepEqual(
    lookupByEntity(first, "person:c1:carol"),
    ["mem-3"],
    "APPENDED tail row must be in the index after a cache hit",
  );
  assert.deepEqual(
    lookupByEntity(first, "person:c1:dave"),
    [],
    "a TORN row is never indexed or certified (it sits beyond the pinned eof)",
  );

  // The torn row's newline lands. The next (warm) load resumes from the seed's
  // reported coverage — the pinned checkpoint eof, NOT the raw file size.
  appendLedger(w.ledgerPath, tornRest);
  setLedgerMtime(w.ledgerPath, MTIME_AFTER_TORN_ROW_COMPLETED);
  const second = await load(w); // deliberately NO reset: exercise the grow branch
  assert.deepEqual(
    lookupByEntity(second, "person:c1:dave"),
    ["mem-4"],
    "the completed row was skipped — the seed reported the raw file size instead of checkpoint.eof, so the tail merge resumed MID-ROW",
  );
  assert.deepEqual(
    lookupByEntity(second, "person:c1:bob"),
    ["mem-2"],
    "the grow merge must not double-apply or drop already-folded rows",
  );
});

// ---------------------------------------------------------------------------
// (c) CONTINUITY — prefixVerified (witness-cap overflow) is NOT a rebuild
// ---------------------------------------------------------------------------

test("(c) witness-cap overflow (prefixVerified resample) is continuity, not a discontinuity — no ~63-update rebuild storm", async () => {
  const w = newWorkspace("c-prefix-verified");
  await buildCheckpointedCache(w, [rowLine("mem-0", ["person:c1:seed"])]);

  flagOn();
  // Each capture({prev}) appends one witness entry; past MAX_WITNESS_ENTRIES
  // (128) captureCheckpoint falls back to a FRESH downsampled resample and
  // marks it prefixVerified. Watch the persisted witness length collapse: that
  // collapse IS the overflow, and the run must survive it without ever losing
  // the cache-only bucket (which only a full rebuild could remove).
  let maxWitness = 0;
  let overflowSeen = false;
  let overflowIteration = -1;
  for (let i = 1; i <= 200; i++) {
    appendLedger(w.ledgerPath, rowLine(`mem-${i}`, [`person:c1:iter_${i}`]));
    _resetEntityIndexCache();
    const idx = await load(w);
    assertSeededFromCache(
      idx,
      `iteration ${i}: a full rebuild fired under sustained appends (rebuild storm)`,
    );
    const cached = readCache(w.cachePath);
    const witnessLen = cached.checkpoint.witness.length;
    if (witnessLen < maxWitness) {
      overflowSeen = true;
      overflowIteration = i;
    }
    maxWitness = Math.max(maxWitness, witnessLen);
    if (overflowSeen && i >= overflowIteration + 3) break; // survive a few more ticks past it
  }
  assert.ok(
    overflowSeen,
    `the fixture never forced a witness-cap overflow (max witness entries seen: ${maxWitness}) — this gate would have passed vacuously`,
  );

  // And the ledger tail is still fully indexed after the re-baseline.
  _resetEntityIndexCache();
  const finalIdx = await load(w);
  assert.deepEqual(
    lookupByEntity(finalIdx, `person:c1:iter_${overflowIteration}`),
    [`mem-${overflowIteration}`],
    "rows folded across the witness re-baseline must survive",
  );
});

// ---------------------------------------------------------------------------
// (d) DISCONTINUITY — rewritten prefix bytes must never seed
// ---------------------------------------------------------------------------

test("(d) rewritten prefix bytes do NOT seed: full rebuild, and the cache file is preserved", async () => {
  const w = newWorkspace("d-prefix-drift");
  await buildCheckpointedCache(w, [
    rowLine("mem-1", ["person:c1:alice"]),
    rowLine("mem-2", ["person:c1:bob"]),
  ]);

  // In-place rewrite that GROWS the file and bumps the mtime — size+mtime look
  // like an append, but the prefix bytes changed. Only the witness catches it.
  writeLedger(w.ledgerPath, [
    rowLine("mem-1x", ["person:c1:alice_rewritten"]),
    rowLine("mem-2", ["person:c1:bob"]),
    rowLine("mem-3", ["person:c1:carol"]),
  ]);

  flagOn();
  _resetEntityIndexCache();
  const idx = await load(w);
  assertFullRebuild(idx, "a drifted prefix must fail closed into a full rebuild");
  assert.deepEqual(
    lookupByEntity(idx, "person:c1:alice_rewritten"),
    ["mem-1x"],
    "the rebuild reflects the rewritten ledger truth",
  );
  assert.deepEqual(
    lookupByEntity(idx, "person:c1:alice"),
    [],
    "the pre-rewrite bucket must not survive a discontinuity",
  );
  assert.equal(
    existsSync(w.cachePath),
    true,
    "the cache file must never be deleted — a stale cache is handled by rebuilding, not by unlinking",
  );
  assert.ok(
    readCache(w.cachePath).checkpoint,
    "the rebuild re-stamps a checkpoint so the NEXT cold start can seed",
  );
});

// ---------------------------------------------------------------------------
// (e) FALLBACK MATRIX — missing / corrupt / undeserializable / legacy caches
// ---------------------------------------------------------------------------

test("(e) missing, corrupt, undeserializable-checkpoint and legacy caches all rebuild; the cache file always survives", async () => {
  flagOn();

  // --- no cache at all.
  {
    const w = newWorkspace("e-no-cache");
    writeLedger(w.ledgerPath, [rowLine("mem-1", ["person:c1:alice"])]);
    _resetEntityIndexCache();
    const idx = await load(w);
    assert.deepEqual(lookupByEntity(idx, "person:c1:alice"), ["mem-1"], "no-cache: rebuild from ledger");
    assert.equal(existsSync(w.cachePath), true, "no-cache: a fresh cache is written");
    assert.ok(readCache(w.cachePath).checkpoint, "no-cache: the fresh cache carries a checkpoint");
  }

  // --- corrupt JSON.
  {
    const w = newWorkspace("e-corrupt");
    await buildCheckpointedCache(w, [rowLine("mem-1", ["person:c1:alice"])]);
    writeFileSync(w.cachePath, "this is not valid json {{{", { mode: 0o600 });
    _resetEntityIndexCache();
    const idx = await load(w);
    assertFullRebuild(idx, "corrupt JSON must rebuild");
    assert.deepEqual(lookupByEntity(idx, "person:c1:alice"), ["mem-1"], "corrupt: ledger truth");
    assert.equal(existsSync(w.cachePath), true, "corrupt: the cache file still exists");
  }

  // --- present but undeserializable checkpoint.
  {
    const w = newWorkspace("e-bad-checkpoint");
    await buildCheckpointedCache(w, [rowLine("mem-1", ["person:c1:alice"])]);
    const cached = readCache(w.cachePath);
    cached.checkpoint = { v: 9, algo: "md5", size: -1, witness: "nope" };
    writeCache(w.cachePath, cached);
    _resetEntityIndexCache();
    const idx = await load(w);
    assertFullRebuild(idx, "an undeserializable checkpoint must rebuild");
    assert.equal(existsSync(w.cachePath), true, "bad-checkpoint: the cache file still exists");
    assert.ok(
      readCache(w.cachePath).checkpoint,
      "bad-checkpoint: the rebuild re-stamps a valid checkpoint",
    );
  }

  // --- legacy v1 payload with NO checkpoint key: exactly one rebuild migrates it.
  {
    const w = newWorkspace("e-legacy-v1");
    await buildCheckpointedCache(w, [rowLine("mem-1", ["person:c1:alice"])]);
    const cached = readCache(w.cachePath);
    delete cached.checkpoint;
    writeCache(w.cachePath, cached);
    _resetEntityIndexCache();
    const migrated = await load(w);
    assertFullRebuild(migrated, "a legacy checkpoint-less payload must rebuild once");
    assert.ok(
      readCache(w.cachePath).checkpoint,
      "legacy: the migrating rebuild stamps a checkpoint",
    );

    // The very next cold start now seeds from the migrated cache even though
    // the ledger mtime has been forced stale.
    const reCached = readCache(w.cachePath);
    reCached.entries[POISON_ID] = [POISON_MEMORY_ID];
    writeCache(w.cachePath, reCached);
    setLedgerMtime(w.ledgerPath, MTIME_STALE);
    _resetEntityIndexCache();
    const seeded = await load(w);
    assertSeededFromCache(seeded, "legacy: the migrated cache seeds the next cold start");
  }
});

// ---------------------------------------------------------------------------
// (f) FAIL-STATIC — present-but-unreadable ledger serves the cache read-only
// ---------------------------------------------------------------------------

test("(f) a present-but-unreadable ledger serves the cached index read-only and does not rewrite the cache", async (t) => {
  if (process.getuid && process.getuid() === 0) {
    assert.fail("cannot run as root: chmod 000 is a no-op, this gate would not gate");
  }
  const w = newWorkspace("f-fail-static");
  await buildCheckpointedCache(w, [
    rowLine("mem-1", ["person:c1:alice"]),
    rowLine("mem-2", ["person:c1:bob"]),
  ]);
  const cacheBefore = readFileSync(w.cachePath, "utf8");

  flagOn();
  _resetEntityIndexCache();
  chmodSync(w.ledgerPath, 0o000);
  try {
    const idx = await load(w);
    assertSeededFromCache(idx, "an unreadable ledger must serve the CACHED index (fail-static)");
    assert.deepEqual(
      lookupByEntity(idx, "person:c1:alice"),
      ["mem-1"],
      "fail-static: cached buckets are served intact",
    );
    assert.equal(
      readFileSync(w.cachePath, "utf8"),
      cacheBefore,
      "fail-static: a null capture must NEVER rewrite (let alone empty) a populated cache",
    );
  } finally {
    chmodSync(w.ledgerPath, 0o600);
    _resetEntityIndexCache();
  }

  // Self-heal: the next readable tick re-enters the normal path.
  const healed = await load(w);
  assert.deepEqual(
    lookupByEntity(healed, "person:c1:bob"),
    ["mem-2"],
    "fail-static: the projection recovers once the ledger is readable again",
  );
  void t;
});

// ---------------------------------------------------------------------------
// (g) FLAG OFF — byte-identical to the pre-C1 tree
// ---------------------------------------------------------------------------

test("(g) with the flag unset: mtime equality still decides, a checkpoint key is ignored, and the persisted payload is unchanged", async () => {
  // --- persisted payload shape.
  {
    const w = newWorkspace("g-payload");
    writeLedger(w.ledgerPath, [rowLine("mem-1", ["person:c1:alice"])]);
    flagOff();
    _resetEntityIndexCache();
    await load(w);
    const raw = readFileSync(w.cachePath, "utf8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(
      Object.keys(parsed),
      ["schema_version", "ledger_mtime_ms", "entries", "built_at"],
      "flag OFF: the persisted payload must keep exactly the pre-C1 fields in the pre-C1 order",
    );
    assert.equal(parsed.schema_version, "v1", "flag OFF: schema stays v1");
    assert.equal(
      parsed.ledger_mtime_ms,
      statSync(w.ledgerPath).mtimeMs,
      "flag OFF: ledger_mtime_ms is still the live validity key",
    );
    assert.equal(raw.includes('"checkpoint"'), false, "flag OFF: no checkpoint key is written");
  }

  // --- an mtime-MATCHING cache is still an accepted hit (unchanged behavior),
  //     and an unknown `checkpoint` key on it is simply ignored.
  {
    const w = newWorkspace("g-mtime-hit");
    await buildCheckpointedCache(w, [rowLine("mem-1", ["person:c1:alice"])]);
    const cached = readCache(w.cachePath);
    assert.ok(cached.checkpoint, "fixture: the cache carries a checkpoint key");
    // Re-stamp the cached mtime to the ledger's CURRENT mtime so the flag-OFF
    // equality holds.
    cached.ledger_mtime_ms = statSync(w.ledgerPath).mtimeMs;
    writeCache(w.cachePath, cached);

    flagOff();
    _resetEntityIndexCache();
    const idx = await load(w);
    assertSeededFromCache(
      idx,
      "flag OFF: an mtime-matching cache is still a hit, and the extra checkpoint key is ignored",
    );
  }

  // --- a ledger that GREW keeps the historical rebuild-on-mtime-change path.
  {
    const w = newWorkspace("g-mtime-miss");
    await buildCheckpointedCache(w, [rowLine("mem-1", ["person:c1:alice"])]);
    appendLedger(w.ledgerPath, rowLine("mem-2", ["person:c1:bob"]));
    setLedgerMtime(w.ledgerPath, MTIME_STALE);

    flagOff();
    _resetEntityIndexCache();
    const idx = await load(w);
    assertFullRebuild(idx, "flag OFF: an mtime mismatch still rebuilds");
    assert.deepEqual(lookupByEntity(idx, "person:c1:bob"), ["mem-2"], "flag OFF: ledger truth");
    const parsed = readCache(w.cachePath);
    assert.equal(
      Object.prototype.hasOwnProperty.call(parsed, "checkpoint"),
      false,
      "flag OFF: the rewritten cache drops back to the pre-C1 payload shape",
    );
  }

  flagOff();
});
