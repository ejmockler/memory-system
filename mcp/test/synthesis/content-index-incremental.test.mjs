// content-index-incremental.test.mjs — W1: S1-checkpoint-based incremental
// content-index reducer.
//
// Gates (all hermetic — fixtures in a private tmpdir, NEVER the real ledger):
//   T1 delta-only parse: full rebuild on N rows, then K appended rows fold
//      with stats.rows_parsed === K (injected parse counter, not wall time).
//   T2 equivalence: incremental serialized entries deepEqual a fresh full
//      rebuild of the same ledger.
//   T3 torn final line: never indexed, never certified (checkpoint eof
//      excludes torn bytes); folded exactly once after the "\n" lands.
//   T4 prefix rewrite -> full rebuild (fixture < 64KiB so the single witness
//      block deterministically covers the whole prefix — see
//      ledger-checkpoint.js sampleBlockIndices: block 0 is always sampled).
//      W1b: the mutation is a same-length edit of the NORMALIZED content
//      ('number 0' -> 'humber 0'), so the deep-equal-vs-fresh-rebuild gate is
//      falsifiable — a stale cached index keeps the old hash key and fails.
//   T5 certify-race pin: a row appended after the new checkpoint is pinned
//      (via opts.__afterPinForTest) is neither indexed nor certified — the
//      structural kill of the old stat-after-stream race.
//   T6 no-op fast path: zero appends -> cache-hit-exact, zero rows parsed,
//      cache file not rewritten.
//   T7 legacy v1 cache -> one full rebuild then v2; truncated ledger ->
//      full rebuild; missing-ledger cold start round-trips without throwing.
//      W1b (T7c): the SECOND missing-ledger load must be an exact cache hit
//      that does not rewrite the cache file (bytes + mtimeMs stable).
//   T8 checkpoint-discontinuity seam (W1b): an atomic ledger replacement
//      (write tmp + rename, same-or-larger newline-terminated content)
//      injected via opts.__beforeCaptureForTest — between the cached-
//      checkpoint validation and the new-checkpoint pin — must full-rebuild
//      (reason 'checkpoint-discontinuity'), NEVER fold the new file's delta
//      over the old file's cached entries (hybrid index).
//   T9 rebuild fold-error hygiene (W1b): a ledger truncated after the
//      rebuild's checkpoint pin (opts.__afterPinForTest) must return ZERO
//      entries and certify nothing — partially-folded entries retained under
//      emptyCheckpoint would be re-certified forever by the next incremental
//      load (applyRow never overwrites).
//   T10 persist-failure resilience (W1b): an unwritable cachePath must not
//      discard the built in-memory index — one stderr warn line, complete
//      index returned, no tmp debris, direct persistContentIndex still
//      throws.
//   T11 persist tmp hygiene (W1b): a failed rename must unlink its tmp file
//      (a sustained cache-dir fault must not leak one full-cache-sized tmp
//      per 15s tick).
//   T7d unreadable-but-present ledger (S1c): with a warm NON-EMPTY cache and
//      the ledger chmod 0o000, consecutive loads serve the CACHED populated
//      index read-only (mode 'cache-stale-capture-failed'), never rewrite
//      the cache file (bytes + mtimeMs stable), never clobber it with an
//      empty index; once readable again the next load converges.
//   T12 witness-cap re-baseline (S1c): sustained small persisted appends
//      drive the cached witness to MAX_WITNESS_ENTRIES (128); the
//      cap-crossing load must stay stats.mode 'incremental' (reason
//      'witness-rebaselined'), never a spurious full rebuild.
//   T13 batch-append re-baseline (S1c): a single multi-MB multi-block append
//      right after a fresh rebuild whose combined witness would overflow the
//      cap must also stay incremental.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic root BEFORE any dynamic import (pattern from
// content-dedup-gate.test.mjs — content-index takes explicit paths, but the
// env pins keep any transitive import away from the real tree).
const TMP = mkdtempSync(join(tmpdir(), "content-index-incremental-"));
const LEDGERS = join(TMP, "ledgers");
const STORAGE = join(TMP, "storage");
const POLICY = join(TMP, "policy");
for (const d of [LEDGERS, STORAGE, POLICY]) mkdirSync(d, { recursive: true });
process.env.MEMORY_ROOT = TMP;
process.env.LEDGERS_BASE_DIR = LEDGERS;
process.env.STORAGE_BASE_DIR = STORAGE;
process.env.POLICY_BASE_DIR = POLICY;
process.on("exit", () => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

const ci = await import("../../lib/synthesis/content-index.js");

let caseN = 0;
/** Per-test fixture dir: a fresh ledger + cache path pair, fully isolated. */
function fixture() {
  const dir = join(TMP, `case-${caseN++}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    ledger: join(dir, "memory.jsonl"),
    cache: join(dir, "content-index.cache.json"),
    cache2: join(dir, "content-index.fresh.cache.json"),
  };
}

function fact(id, content) {
  return {
    id,
    kind: "fact",
    content,
    source: "git-log",
    created_at: "2026-06-01T00:00:00Z",
    features: {},
  };
}
function lines(rows) {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}
function writeLedger(path, rows) {
  writeFileSync(path, lines(rows), { mode: 0o600 });
}
function appendRows(path, rows) {
  appendFileSync(path, lines(rows));
}
function serializedEntries(index) {
  const out = {};
  for (const [k, v] of index.byContentHash) out[k] = v;
  return out;
}
function makeRows(n, prefix) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(fact(`mem_${prefix}_${i}`, `${prefix} unique content number ${i}`));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// T1 — delta-only parse gate
// ---------------------------------------------------------------------------

test("T1: full rebuild parses N; a K-row append parses exactly K (incremental)", async () => {
  const { ledger, cache } = fixture();
  writeLedger(ledger, makeRows(200, "base"));

  const first = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.equal(first.stats.mode, "full-rebuild");
  assert.equal(first.stats.rows_parsed, 200);
  assert.ok(first.byContentHash instanceof Map);
  assert.equal(first.byContentHash.size, 200);

  appendRows(ledger, makeRows(7, "delta"));

  const second = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.equal(second.stats.mode, "incremental");
  assert.equal(second.stats.rows_parsed, 7);
  // Old content still resolves; new content resolves.
  assert.equal(ci.lookupCanonical(second, "base unique content number 0"), "mem_base_0");
  assert.equal(ci.lookupCanonical(second, "base unique content number 199"), "mem_base_199");
  assert.equal(ci.lookupCanonical(second, "delta unique content number 3"), "mem_delta_3");
  assert.equal(second.byContentHash.size, 207);
});

// ---------------------------------------------------------------------------
// T2 — equivalence gate: incremental == fresh full rebuild
// ---------------------------------------------------------------------------

test("T2: incremental index deep-equals a fresh full rebuild of the same ledger", async () => {
  const { ledger, cache, cache2 } = fixture();
  writeLedger(ledger, makeRows(50, "base"));
  await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });

  // Appends include a duplicate of existing content (EARLIEST must win) and
  // fresh content.
  appendRows(ledger, [
    fact("mem_dup_late", "base unique content number 5"),
    ...makeRows(4, "delta"),
  ]);
  const incremental = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.equal(incremental.stats.mode, "incremental");

  const fresh = await ci.rebuildContentIndex({ ledgerPath: ledger, cachePath: cache2 });
  assert.deepEqual(serializedEntries(incremental), serializedEntries(fresh));
  // EARLIEST-wins survived the incremental fold.
  assert.equal(ci.lookupCanonical(incremental, "base unique content number 5"), "mem_base_5");
});

// ---------------------------------------------------------------------------
// T3 — torn final line: never indexed, never certified, replayed exactly once
// ---------------------------------------------------------------------------

test("T3: torn tail excluded from index + checkpoint; folded once after completion", async () => {
  const { ledger, cache } = fixture();
  writeLedger(ledger, makeRows(10, "base"));
  await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });

  const tornRow = fact("mem_torn", "torn tail content");
  appendRows(ledger, makeRows(3, "delta"));
  appendFileSync(ledger, JSON.stringify(tornRow)); // NO trailing "\n" — torn

  const mid = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.equal(mid.stats.mode, "incremental");
  assert.equal(mid.stats.rows_parsed, 3);
  assert.equal(ci.lookupCanonical(mid, "torn tail content"), null);

  // The persisted checkpoint must NOT certify the torn bytes.
  const persisted = JSON.parse(readFileSync(cache, "utf8"));
  const size = statSync(ledger).size;
  const tornBytes = Buffer.byteLength(JSON.stringify(tornRow), "utf8");
  assert.ok(persisted.checkpoint, "cache payload carries a checkpoint");
  assert.equal(persisted.checkpoint.eof, size - tornBytes);

  // Complete the torn row: exactly one row folds on the next load — once,
  // never lost, never doubled.
  appendFileSync(ledger, "\n");
  const after = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.equal(after.stats.mode, "incremental");
  assert.equal(after.stats.rows_parsed, 1);
  assert.equal(ci.lookupCanonical(after, "torn tail content"), "mem_torn");

  // And it is not re-applied on the load after that.
  const again = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.equal(again.stats.rows_parsed, 0);
  assert.equal(ci.lookupCanonical(again, "torn tail content"), "mem_torn");
});

// ---------------------------------------------------------------------------
// T4 — rewrite of the certified prefix -> full rebuild
// ---------------------------------------------------------------------------

test("T4: in-place prefix rewrite -> full-rebuild mode, index equals fresh rebuild", async () => {
  const { ledger, cache, cache2 } = fixture();
  // Fixture must stay < 64KiB: ledger-checkpoint samples block 0 ALWAYS, so a
  // single-block file makes witness coverage of the whole prefix
  // deterministic (an interior-only rewrite of a multi-block file may hit an
  // un-sampled block — documented limitation of the sampled witness).
  writeLedger(ledger, makeRows(20, "base"));
  assert.ok(statSync(ledger).size < 64 * 1024, "fixture must be a single witness block");
  await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });

  // Same-length in-place edit of the first row's content that SURVIVES
  // normalization ('number 0' -> 'humber 0') — size unchanged, bytes AND
  // normalized content drifted. Same length defeats any size-only
  // fingerprint; changing the normalized content makes the deep-equal below
  // falsifiable (a case-only edit is erased by normalizeContent's lowercase,
  // so a stale cached index would deep-equal a fresh rebuild vacuously).
  const raw = readFileSync(ledger, "utf8");
  assert.ok(raw.includes("base unique content number 0"));
  const mutated = raw.replace("base unique content number 0", "base unique content humber 0");
  assert.equal(Buffer.byteLength(mutated), Buffer.byteLength(raw));
  assert.notEqual(
    ci.normalizeContent("base unique content number 0"),
    ci.normalizeContent("base unique content humber 0"),
    "mutation must change the NORMALIZED content",
  );
  writeFileSync(ledger, mutated);

  const reloaded = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.equal(reloaded.stats.mode, "full-rebuild");
  const fresh = await ci.rebuildContentIndex({ ledgerPath: ledger, cachePath: cache2 });
  assert.deepEqual(serializedEntries(reloaded), serializedEntries(fresh));
  // The mutation changed the normalized content: the OLD hash key must be
  // absent and the NEW one present. A stale cached index fails both.
  assert.equal(ci.lookupCanonical(reloaded, "base unique content number 0"), null);
  assert.equal(ci.lookupCanonical(reloaded, "base unique content humber 0"), "mem_base_0");
});

// ---------------------------------------------------------------------------
// T5 — certify-race pin: append AFTER pin, BEFORE delta read
// ---------------------------------------------------------------------------

test("T5: row appended after checkpoint pin is neither indexed nor certified", async () => {
  const { ledger, cache } = fixture();
  writeLedger(ledger, makeRows(10, "base"));
  await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });

  // One legit appended row (so the load takes the incremental path), then the
  // raced row lands after the new checkpoint is pinned but before the delta
  // read — the exact window of the old stat-after-stream race.
  appendRows(ledger, [fact("mem_legit", "legit appended content")]);
  let hookFired = 0;
  const raced = await ci.loadOrRebuildContentIndex({
    ledgerPath: ledger,
    cachePath: cache,
    __afterPinForTest: () => {
      hookFired += 1;
      appendRows(ledger, [fact("mem_raced", "raced mid-call content")]);
    },
  });
  assert.equal(hookFired, 1);
  assert.equal(raced.stats.mode, "incremental");
  assert.equal(raced.stats.rows_parsed, 1); // the legit row only
  assert.equal(ci.lookupCanonical(raced, "legit appended content"), "mem_legit");
  // Raced row NOT in the returned index...
  assert.equal(ci.lookupCanonical(raced, "raced mid-call content"), null);

  // ...and NOT certified: the next load parses exactly the raced row.
  const next = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.equal(next.stats.mode, "incremental");
  assert.equal(next.stats.rows_parsed, 1);
  assert.equal(ci.lookupCanonical(next, "raced mid-call content"), "mem_raced");
});

// ---------------------------------------------------------------------------
// T6 — no-op fast path: zero appends, zero parses, no cache rewrite
// ---------------------------------------------------------------------------

test("T6: zero appends -> cache-hit-exact, 0 rows parsed, cache file untouched", async () => {
  const { ledger, cache } = fixture();
  writeLedger(ledger, makeRows(30, "base"));
  await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });

  const bytesBefore = readFileSync(cache);
  const statBefore = statSync(cache);

  const reloaded = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.equal(reloaded.stats.mode, "cache-hit-exact");
  assert.equal(reloaded.stats.rows_parsed, 0);
  assert.ok(reloaded.byContentHash instanceof Map);
  assert.equal(reloaded.byContentHash.size, 30);
  assert.equal(ci.lookupCanonical(reloaded, "base unique content number 12"), "mem_base_12");

  const bytesAfter = readFileSync(cache);
  const statAfter = statSync(cache);
  assert.ok(bytesBefore.equals(bytesAfter), "cache bytes unchanged");
  assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, "cache mtime unchanged");
});

// ---------------------------------------------------------------------------
// T7 — legacy v1 cache migration, truncated ledger, missing-ledger cold start
// ---------------------------------------------------------------------------

test("T7a: legacy v1 cache (mtime+size, no checkpoint) -> one full rebuild, then v2", async () => {
  const { ledger, cache } = fixture();
  writeLedger(ledger, makeRows(15, "base"));
  const st = statSync(ledger);
  // A faithful legacy v1 payload: exact mtime+size match, no checkpoint —
  // the OLD code would accept this as a cache hit.
  writeFileSync(
    cache,
    JSON.stringify({
      schema_version: "v1",
      content_index_version: "v1",
      ledger_mtime_ms: st.mtimeMs,
      ledger_size_bytes: st.size,
      entries: { "c:deadbeef": "mem_stale_should_be_discarded" },
      built_at: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );

  const migrated = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.equal(migrated.stats.mode, "full-rebuild");
  assert.equal(migrated.byContentHash.size, 15);
  assert.equal(migrated.byContentHash.has("c:deadbeef"), false);

  const persisted = JSON.parse(readFileSync(cache, "utf8"));
  assert.equal(persisted.schema_version, "v2");
  assert.equal(persisted.content_index_version, "v1"); // module version pinned
  assert.ok(persisted.checkpoint && typeof persisted.checkpoint.eof === "number");
  // entries stays a plain {hash -> fact_id string} object — the
  // reembed-local-4096.mjs raw-read contract.
  for (const v of Object.values(persisted.entries)) assert.equal(typeof v, "string");

  const after = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.equal(after.stats.mode, "cache-hit-exact");
});

test("T7b: truncated (shrunk) ledger -> full rebuild matching the truncated file", async () => {
  const { ledger, cache, cache2 } = fixture();
  writeLedger(ledger, makeRows(20, "base"));
  await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });

  writeLedger(ledger, makeRows(5, "base")); // shrink: 20 rows -> 5 rows
  const reloaded = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.equal(reloaded.stats.mode, "full-rebuild");
  assert.equal(reloaded.byContentHash.size, 5);
  const fresh = await ci.rebuildContentIndex({ ledgerPath: ledger, cachePath: cache2 });
  assert.deepEqual(serializedEntries(reloaded), serializedEntries(fresh));
});

test("T7c: missing-ledger cold start returns an empty index without throwing", async () => {
  const { ledger, cache } = fixture(); // ledger never written
  const cold = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.ok(cold.byContentHash instanceof Map);
  assert.equal(cold.byContentHash.size, 0);
  assert.equal(cold.stats.rows_parsed, 0);

  // W1b: the first cold load persisted the empty v2 cache (origin cursor,
  // eof 0). A SECOND cold load must be an exact cache hit that does NOT
  // rewrite the cache file — a 15s missing-ledger tick must not churn a
  // cache file forever (bytes + mtimeMs stable; T6's technique).
  const bytesBefore = readFileSync(cache);
  const statBefore = statSync(cache);
  await new Promise((resolve) => setTimeout(resolve, 5)); // make mtime churn detectable
  const cold2 = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.ok(cold2.byContentHash instanceof Map);
  assert.equal(cold2.byContentHash.size, 0);
  assert.equal(cold2.stats.mode, "cache-hit-exact");
  assert.equal(cold2.stats.rows_parsed, 0);
  const bytesAfter = readFileSync(cache);
  const statAfter = statSync(cache);
  assert.ok(bytesBefore.equals(bytesAfter), "cache bytes unchanged across cold ticks");
  assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, "cache mtimeMs unchanged across cold ticks");

  // The ledger then appears: the next load must index it (no stale empty hit).
  writeLedger(ledger, makeRows(3, "base"));
  const warm = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.equal(warm.byContentHash.size, 3);
  assert.equal(warm.stats.rows_parsed, 3);
  assert.equal(ci.lookupCanonical(warm, "base unique content number 2"), "mem_base_2");
});

test("T7d: unreadable-but-present ledger serves the cached index read-only, never churns or clobbers the cache", async () => {
  const { ledger, cache } = fixture();
  writeLedger(ledger, makeRows(25, "base"));
  await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });

  const bytesBefore = readFileSync(cache);
  const statBefore = statSync(cache);
  chmodSync(ledger, 0o000); // present but unreadable (EACCES)
  try {
    // RED-FIRST RECORD (pre-S1c, 2026-07-14, scratchpad copy): BOTH loads
    // took fullRebuild('capture-failed'), rebuilt an EMPTY index over the
    // unreadable ledger, and persistOrWarn rewrote the cache each call
    // (fresh built_at -> bytes+mtimeMs churn every 15s tick) — the
    // previously valid 25-entry cache was clobbered to 0 entries on disk.
    await new Promise((resolve) => setTimeout(resolve, 5)); // make churn detectable
    const t1 = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
    const t2 = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
    for (const [label, idx] of [["first", t1], ["second", t2]]) {
      assert.equal(idx.stats.mode, "cache-stale-capture-failed", `${label} faulted load`);
      assert.equal(idx.stats.rows_parsed, 0);
      assert.equal(idx.byContentHash.size, 25, `${label} load must serve the CACHED entries, never empty`);
      assert.equal(ci.lookupCanonical(idx, "base unique content number 7"), "mem_base_7");
    }
    const bytesAfter = readFileSync(cache);
    const statAfter = statSync(cache);
    assert.ok(bytesBefore.equals(bytesAfter), "cache bytes unchanged across faulted ticks");
    assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, "cache mtimeMs unchanged across faulted ticks");
  } finally {
    chmodSync(ledger, 0o600);
  }

  // Recovery: the ledger is readable again — the next load re-enters the
  // normal capture path and indexes new rows correctly (no stale serving).
  appendRows(ledger, makeRows(2, "delta"));
  const recovered = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.equal(recovered.stats.mode, "incremental");
  assert.equal(recovered.byContentHash.size, 27);
  assert.equal(ci.lookupCanonical(recovered, "delta unique content number 1"), "mem_delta_1");
  const fresh = await ci.rebuildContentIndex({ ledgerPath: ledger });
  assert.deepEqual(serializedEntries(recovered), serializedEntries(fresh));
});

// ---------------------------------------------------------------------------
// T8 — checkpoint-discontinuity seam: atomic replacement between the cached-
// checkpoint validation and the new-checkpoint pin must NEVER yield a hybrid
// (old cached entries + new file's delta) index.
// ---------------------------------------------------------------------------

test("T8: atomic ledger replacement before pin -> full rebuild, never a hybrid index", async () => {
  const { ledger, cache, cache2 } = fixture();
  writeLedger(ledger, makeRows(20, "base"));
  await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  const oldSize = statSync(ledger).size;

  // Same-or-larger, newline-terminated, entirely different content — an
  // atomic write-tmp + rename replacement, injected in the exact window
  // between cache validation and captureCheckpoint.
  const swapRows = makeRows(25, "swap");
  let hookFired = 0;
  const reloaded = await ci.loadOrRebuildContentIndex({
    ledgerPath: ledger,
    cachePath: cache,
    __beforeCaptureForTest: () => {
      hookFired += 1;
      const tmp = `${ledger}.swap-tmp`;
      writeFileSync(tmp, lines(swapRows), { mode: 0o600 });
      assert.ok(statSync(tmp).size >= oldSize, "replacement must be same-or-larger");
      renameSync(tmp, ledger);
    },
  });
  assert.equal(hookFired, 1);
  assert.equal(reloaded.stats.mode, "full-rebuild");
  assert.equal(reloaded.stats.reason, "checkpoint-discontinuity");
  // Deep-equal to a fresh rebuild of the NEW file: all 25 swap rows, zero
  // old-file entries.
  const fresh = await ci.rebuildContentIndex({ ledgerPath: ledger, cachePath: cache2 });
  assert.deepEqual(serializedEntries(reloaded), serializedEntries(fresh));
  assert.equal(reloaded.byContentHash.size, 25);
  assert.equal(ci.lookupCanonical(reloaded, "base unique content number 3"), null);
  assert.equal(ci.lookupCanonical(reloaded, "swap unique content number 3"), "mem_swap_3");
});

// ---------------------------------------------------------------------------
// T9 — rebuild fold-error hygiene: truncation between the rebuild's pin and
// its fold must retain NOTHING (zero entries, emptyCheckpoint certified).
// ---------------------------------------------------------------------------

test("T9: ledger truncated after rebuild pin -> zero entries, nothing certified", async () => {
  const { ledger, cache, cache2 } = fixture();
  writeLedger(ledger, makeRows(30, "base"));
  let hookFired = 0;
  const rebuilt = await ci.rebuildContentIndex({
    ledgerPath: ledger,
    cachePath: cache,
    __afterPinForTest: () => {
      hookFired += 1;
      // Shrink well below the pinned eof: the fold hits EOF early
      // ("truncated") after having partially folded the surviving rows.
      writeLedger(ledger, makeRows(4, "shrunk"));
    },
  });
  assert.equal(hookFired, 1);
  assert.equal(
    rebuilt.byContentHash.size,
    0,
    "no partially-folded entries may survive a failed fold",
  );
  assert.equal(rebuilt.checkpoint.eof, 0, "a failed fold certifies NOTHING");
  assert.deepEqual(rebuilt.checkpoint.witness, []);

  // The next load must converge on a fresh rebuild of the FINAL file — no
  // stale canonical ids from the pre-truncation file.
  const next = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  const fresh = await ci.rebuildContentIndex({ ledgerPath: ledger, cachePath: cache2 });
  assert.deepEqual(serializedEntries(next), serializedEntries(fresh));
  assert.equal(next.byContentHash.size, 4);
  assert.equal(ci.lookupCanonical(next, "base unique content number 0"), null);
  assert.equal(ci.lookupCanonical(next, "shrunk unique content number 0"), "mem_shrunk_0");
});

// ---------------------------------------------------------------------------
// T10 — persist-failure resilience: an unwritable cachePath must not discard
// the built in-memory index (one stderr warn, index served, no debris).
// ---------------------------------------------------------------------------

test("T10: cache persist failure serves the complete in-memory index with one stderr warn", async () => {
  const { ledger, dir } = fixture();
  writeLedger(ledger, makeRows(12, "base"));
  const roDir = join(dir, "ro-cache-dir");
  mkdirSync(roDir);
  const cachePath = join(roDir, "content-index.cache.json");
  chmodSync(roDir, 0o500); // read+exec only: any write inside must fail

  const captured = [];
  const origWrite = process.stderr.write;
  process.stderr.write = (chunk, encoding, cb) => {
    captured.push(String(chunk));
    if (typeof encoding === "function") encoding();
    else if (typeof cb === "function") cb();
    return true;
  };
  let index;
  try {
    index = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath });
  } finally {
    process.stderr.write = origWrite;
    chmodSync(roDir, 0o700);
  }

  // The built index is complete and correct despite the persist failure.
  assert.ok(index.byContentHash instanceof Map);
  assert.equal(index.byContentHash.size, 12);
  assert.equal(ci.lookupCanonical(index, "base unique content number 7"), "mem_base_7");
  // Exactly one stderr line, and it is the persist-failed warn.
  assert.equal(captured.length, 1, `expected exactly one stderr line, got: ${JSON.stringify(captured)}`);
  assert.ok(captured[0].includes("[content-index] cache persist failed"));
  // No tmp debris in the target dir.
  assert.deepEqual(readdirSync(roDir).filter((f) => f.includes(".tmp-")), []);

  // Direct persistContentIndex keeps its v1 throwing contract.
  chmodSync(roDir, 0o500);
  try {
    await assert.rejects(() => ci.persistContentIndex(index, cachePath));
  } finally {
    chmodSync(roDir, 0o700);
  }
});

// ---------------------------------------------------------------------------
// T11 — persist tmp hygiene: a failed rename must unlink its tmp file (no
// full-cache-sized debris per failed attempt).
// ---------------------------------------------------------------------------

test("T11: a failed persist leaves no .tmp-* debris behind", async () => {
  const { ledger, dir } = fixture();
  writeLedger(ledger, makeRows(3, "base"));
  const index = await ci.rebuildContentIndex({ ledgerPath: ledger });

  // cachePath is an existing DIRECTORY: the tmp writeFile succeeds (the
  // parent dir is writable) but the rename onto a directory fails — exactly
  // the failure shape that used to leak one tmp file per attempt.
  const dirTarget = join(dir, "cache-as-dir");
  mkdirSync(dirTarget);
  await assert.rejects(() => ci.persistContentIndex(index, dirTarget));
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.includes(".tmp-")),
    [],
    "failed persist must unlink its tmp file",
  );
});

// ---------------------------------------------------------------------------
// T12 — witness-cap re-baseline under sustained small appends (S1c)
//
// Each small persisted append stacks one witness entry (same-off short-final-
// block extension), so the cached witness reaches MAX_WITNESS_ENTRIES (128)
// within ~128 gaining ticks; captureCheckpoint then resamples fresh WITH the
// prefix verified in-capture. That cap-crossing load must fold the delta
// incrementally under the re-baselined witness — never a full re-stream.
//
// RED-FIRST RECORD (pre-S1c, 2026-07-14, scratchpad copy): at append tick
// 127 the load reported mode 'full-rebuild' reason 'checkpoint-discontinuity'
// (and the freshly persisted witness reset to 1 entry — i.e. a full multi-GB
// re-stream roughly every ~63-127 gaining ticks in production). Quantified
// 2026-07-14 on a scratchpad COPY of the real 2.11GiB ledger (fresh witness
// 65 entries -> cap crossed at append tick 64): cold full rebuild 6.1s vs
// cap-crossing load incremental/'witness-rebaselined' at 66ms (93x).
// ---------------------------------------------------------------------------

test("T12: witness at the 128-entry cap + one more persisted append stays incremental ('witness-rebaselined')", async () => {
  const { ledger, cache, cache2 } = fixture();
  writeLedger(ledger, makeRows(1, "seed"));
  const first = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.equal(first.stats.mode, "full-rebuild");

  let rebaselines = 0;
  for (let i = 0; i < 140; i++) {
    appendRows(ledger, [fact(`mem_t12_${i}`, `t12 unique content number ${i}`)]);
    const idx = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
    assert.equal(
      idx.stats.mode,
      "incremental",
      `append tick ${i}: a legitimate append must never full-rebuild (got ${idx.stats.mode}` +
        `${idx.stats.reason ? `/${idx.stats.reason}` : ""})`,
    );
    assert.equal(idx.stats.rows_parsed, 1, `append tick ${i}: delta fold parses exactly 1 row`);
    if (idx.stats.reason === "witness-rebaselined") rebaselines += 1;
  }
  assert.ok(rebaselines >= 1, "140 gaining ticks must cross the 128-entry witness cap at least once");

  // The re-baselined cache is persisted (compacted witness) and equivalent
  // to a fresh full rebuild of the same ledger.
  const persisted = JSON.parse(readFileSync(cache, "utf8"));
  assert.ok(
    persisted.checkpoint.witness.length < 128,
    "the compacted witness must have landed on disk",
  );
  const final = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  const fresh = await ci.rebuildContentIndex({ ledgerPath: ledger, cachePath: cache2 });
  assert.deepEqual(serializedEntries(final), serializedEntries(fresh));
  assert.equal(final.byContentHash.size, 141);
});

// ---------------------------------------------------------------------------
// T13 — batch-append re-baseline (S1c): one multi-MB multi-block append whose
// combined witness would overflow the cap, immediately after a fresh rebuild.
//
// Geometry (frozen by BLOCK_BYTES=64KiB, TARGET_SAMPLES=64, cap 128): a base
// of 128 blocks yields the maximal 65-entry fresh witness (stride 2 -> 64
// samples + off-grid final block); a single 127-block (~8.3MB) append then
// samples 64 new blocks -> 65 + 64 = 129 > 128 -> in-capture resample. (An
// append of STRICTLY more than 128 blocks lowers the sample stride and fits
// under the cap again — the overflow window is real but bounded, so the
// fixture pins the widest overflowing batch.)
//
// RED-FIRST RECORD (pre-S1c, 2026-07-14, scratchpad copy): this load
// reported mode 'full-rebuild' reason 'checkpoint-discontinuity' — one batch
// append away from a full multi-GB re-stream.
// ---------------------------------------------------------------------------

test("T13: single multi-MB batch append overflowing the witness cap right after a fresh rebuild stays incremental", async () => {
  const { ledger, cache, cache2 } = fixture();
  const BLOCK = 64 * 1024;
  const pad = "x".repeat(4000);
  // Base: newline-terminated size just past 127 blocks -> nBlocks = 128.
  let base = "";
  let rowN = 0;
  while (base.length <= 127 * BLOCK) {
    base += JSON.stringify(fact(`mem_b_${rowN}`, `t13 base ${rowN} ${pad}`)) + "\n";
    rowN += 1;
  }
  writeFileSync(ledger, base, { mode: 0o600 });
  const first = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.equal(first.stats.mode, "full-rebuild");
  const baseWitness = JSON.parse(readFileSync(cache, "utf8")).checkpoint.witness.length;
  assert.equal(baseWitness, 65, "geometry guard: fresh witness must be at its 65-entry maximum");

  // One batch append landing mid block 253: 127 appended blocks, 64 new
  // witness samples, combined 129 > 128 -> the in-capture overflow resample.
  const target = 253 * BLOCK + 8192;
  let batch = "";
  let batchRows = 0;
  while (base.length + batch.length < target) {
    batch += JSON.stringify(fact(`mem_d_${batchRows}`, `t13 delta ${batchRows} ${pad}`)) + "\n";
    batchRows += 1;
  }
  appendFileSync(ledger, batch); // ONE multi-block append (> 8 MB)
  assert.ok(batch.length > 8 * 1000 * 1000, "batch must be a multi-MB append");

  const second = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.equal(second.stats.mode, "incremental", "cap-overflowing batch append must stay incremental");
  assert.equal(
    second.stats.reason,
    "witness-rebaselined",
    "the overflow must actually have fired (geometry honesty: no vacuous pass)",
  );
  assert.equal(second.stats.rows_parsed, batchRows);

  // Equivalence: the re-baselined fold matches a fresh full rebuild.
  const fresh = await ci.rebuildContentIndex({ ledgerPath: ledger, cachePath: cache2 });
  assert.deepEqual(serializedEntries(second), serializedEntries(fresh));
  assert.equal(ci.lookupCanonical(second, `t13 delta 0 ${pad}`), "mem_d_0");
});

// ---------------------------------------------------------------------------
// API-compat spot checks (additive fields only; names/values pinned elsewhere
// by content-dedup-gate.test.mjs, which must stay green unmodified)
// ---------------------------------------------------------------------------

test("compat: return shape keeps byContentHash/fp/built_at; version pins hold", async () => {
  const { ledger, cache } = fixture();
  writeLedger(ledger, makeRows(2, "base"));
  const index = await ci.loadOrRebuildContentIndex({ ledgerPath: ledger, cachePath: cache });
  assert.ok(index.byContentHash instanceof Map);
  assert.ok(index.fp && typeof index.fp.ledger_mtime_ms === "number");
  assert.ok(index.fp && typeof index.fp.ledger_size_bytes === "number");
  assert.equal(typeof index.built_at, "string");
  assert.ok(index.checkpoint && typeof index.checkpoint.eof === "number");
  assert.ok(index.stats && typeof index.stats.mode === "string");
  assert.equal(ci.CONTENT_INDEX_VERSION, "v1");
  assert.ok(Object.isFrozen(ci.CONTENT_INDEX_CAPS));
  assert.equal(ci.CONTENT_INDEX_CAPS.SCHEMA_VERSION, "v2");
});
