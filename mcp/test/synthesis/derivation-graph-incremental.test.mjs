// derivation-graph-incremental.test.mjs — Q4 (memperf): S1-checkpoint-based
// incremental derivation-graph cold seed. Modeled on
// content-index-incremental.test.mjs.
//
// WHAT Q4 CHANGED (the defects these gates pin):
//   - The cold-start disk-cache seed accepted the cache only on EXACT ledger
//     mtime equality — defeated by the appending daemon on every fresh
//     process, forcing a full multi-GB stream (~3.4s) PLUS a 45.7 MB
//     persistGraphCache write AWAITED INLINE on the recall path.
//   - Now: the persisted payload embeds a serialized S1 checkpoint; a fresh
//     process verifies the cached prefix FAIL-CLOSED (captureCheckpoint
//     {prev} → S1c flags), folds ONLY the appended delta rows through the
//     SAME applyRow reducer, and the persist is scheduled best-effort OFF the
//     critical path (never on an exact-eof hit).
//
// Gates (all hermetic — fixtures in a private tmpdir, NEVER the real ledger):
//   T1 delta-only fold: full rebuild on N rows, then a K-row append cold-seeds
//      with mode 'incremental' and rows_folded === K (observable via the
//      __peekColdSeedStatsForTests hook, not wall time).
//   T2 equivalence (incl. duplicate ids): incremental cold seed deep-equals a
//      fresh full rebuild of the same ledger on canonicalized adjacency +
//      kindOf.
//   T3 torn final line: never folded, never certified (persisted checkpoint
//      eof excludes the torn bytes); folded after the "\n" lands and the
//      result still deep-equals a full rebuild (never doubled).
//   T4 prefix rewrite -> full rebuild (fixture < 64KiB so witness block 0
//      deterministically covers the whole prefix); same-length edit of a
//      derived_from id so a stale cached graph keeps the OLD edge and the
//      deep-equal gate is falsifiable.
//   T5 off-critical-path persist + exact-eof no-write: the cold rebuild
//      returns BEFORE the cache file exists (persist is scheduled, not
//      awaited); an exact-eof cold hit rewrites nothing (bytes + mtime
//      stable).
//   T6 legacy v1 payload (monolithic JSON): never reinterpreted — one full
//      rebuild migrates it to the v2 sectioned-binary payload (R2/WI1),
//      which then serves exact hits + incremental folds.
//
// RED-RUN RECORD (2026-07-15, this workspace): with the S1c soundness gate
// deliberately bypassed in _coldSeedDerivationGraph (accept any non-null
// captureCheckpoint result), T4 failed exactly as designed — the stale cached
// graph kept the pre-rewrite edge (mode 'incremental' instead of
// 'full-rebuild', deep-equal vs fresh rebuild mismatched on f_000/f_zzz).
// With `rows_folded` forced to 0 reporting, T1 failed. Gates are falsifiable.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic root BEFORE any dynamic import (standing C-NEW-2 pattern; the
// module takes explicit paths, but the env pins keep any transitive import
// away from the real tree).
const TMP = mkdtempSync(join(tmpdir(), "derivation-graph-incremental-"));
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

const dg = await import("../../lib/synthesis/derivation-graph.js");
const {
  loadOrRebuildDerivationGraph,
  rebuildDerivationGraph,
  _resetDerivationGraphCache,
  _awaitPendingGraphCachePersists,
  __peekColdSeedStatsForTests,
} = dg;

let caseN = 0;
/** Per-test fixture dir: a fresh ledger + cache path pair, fully isolated. */
function fixture() {
  const dir = join(TMP, `case-${caseN++}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    ledger: join(dir, "memory.jsonl"),
    cache: join(dir, "derivation-graph.cache.json"),
  };
}

function factRow(id) {
  return { id, kind: "fact", ts: "2026-06-01T00:00:00Z" };
}
function reconRow(id, derivedFrom) {
  return { id, kind: "reconstructed", ts: "2026-06-01T00:00:01Z", derived_from: derivedFrom };
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

// R2/WI1: the persisted cache is the v2 SECTIONED BINARY (small JSON header
// line + string-table/Uint32 sections). Tests inspect the header by parsing
// the first line only — never JSON.parse of the whole (binary) file.
function readCacheHeader(path) {
  const buf = readFileSync(path);
  const nl = buf.indexOf(0x0a);
  if (nl <= 0) return null; // legacy v1 monolith or empty
  return JSON.parse(buf.toString("utf8", 0, nl));
}

// Canonicalize the graph for structural comparison (Map/Set insertion order is
// not load-bearing; consumers do lookups and iterations only).
function adjToObj(adj) {
  const out = {};
  for (const [k, v] of adj) out[k] = Array.from(v).sort();
  return out;
}
function kindOfToObj(kindOf) {
  const out = {};
  for (const [k, v] of kindOf) out[k] = v;
  return out;
}
function graphToObj(g) {
  return {
    forwardAdj: adjToObj(g.forwardAdj),
    reverseAdj: adjToObj(g.reverseAdj),
    kindOf: kindOfToObj(g.kindOf),
  };
}

// Fresh-process simulation: drop the module-scope append-aware projection
// cache so the next load takes the COLD branch (disk-cache seed).
function simulateFreshProcess() {
  _resetDerivationGraphCache();
}

function makeBaseRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const id = `f_${String(i).padStart(3, "0")}`;
    rows.push(factRow(id));
    rows.push(reconRow(`r_${String(i).padStart(3, "0")}`, [id]));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// T1 — delta-only fold gate
// ---------------------------------------------------------------------------

test("T1: full rebuild folds N; a K-row append cold-seeds incremental folding exactly K", async () => {
  const { ledger, cache } = fixture();
  const base = makeBaseRows(50); // 100 rows
  writeLedger(ledger, base);

  simulateFreshProcess();
  const first = await loadOrRebuildDerivationGraph({ ledgerPath: ledger, cachePath: cache });
  assert.equal(__peekColdSeedStatsForTests().mode, "full-rebuild");
  assert.equal(__peekColdSeedStatsForTests().rows_folded, 100);
  assert.ok(first.forwardAdj instanceof Map);
  await _awaitPendingGraphCachePersists();
  assert.ok(existsSync(cache), "full rebuild persisted the cache");

  appendRows(ledger, [
    reconRow("r_delta_a", ["f_000"]),
    reconRow("r_delta_b", ["r_delta_a"]),
    factRow("f_delta_c"),
  ]);

  simulateFreshProcess();
  const second = await loadOrRebuildDerivationGraph({ ledgerPath: ledger, cachePath: cache });
  const stats = __peekColdSeedStatsForTests();
  assert.equal(stats.mode, "incremental", "cold seed took the cache+delta path");
  assert.equal(stats.rows_folded, 3, "exactly the 3 appended rows folded");
  // Old edges still present; new edges folded.
  assert.ok(second.reverseAdj.get("f_000").has("r_000"), "prefix edge intact");
  assert.ok(second.reverseAdj.get("f_000").has("r_delta_a"), "delta edge folded");
  assert.ok(second.forwardAdj.get("r_delta_b").has("r_delta_a"), "chained delta edge folded");
  assert.equal(second.kindOf.get("f_delta_c"), "fact", "delta kindOf folded");
});

// ---------------------------------------------------------------------------
// T2 — equivalence gate (incl. duplicate ids): incremental == fresh full scan
// ---------------------------------------------------------------------------

test("T2: cold cache + delta deep-equals a fresh full rebuild, duplicate ids included", async () => {
  const { ledger, cache } = fixture();
  writeLedger(ledger, makeBaseRows(20));
  simulateFreshProcess();
  await loadOrRebuildDerivationGraph({ ledgerPath: ledger, cachePath: cache });
  await _awaitPendingGraphCachePersists();

  // Delta includes a DUPLICATE id for an existing reconstructed row carrying
  // an ADDITIONAL parent (the full scan unions both rows' edges — Set.add),
  // plus a kind flip for one id (kindOf is last-write-wins).
  appendRows(ledger, [
    reconRow("r_000", ["f_001"]), // duplicate id, new parent edge
    { id: "f_002", kind: "policy", targets: ["f_000"], ts: "2026-06-01T00:00:02Z" }, // dup id, kind flip + policy edge
    reconRow("r_new", ["f_003"]),
  ]);

  simulateFreshProcess();
  const incremental = await loadOrRebuildDerivationGraph({ ledgerPath: ledger, cachePath: cache });
  assert.equal(__peekColdSeedStatsForTests().mode, "incremental");

  const fresh = await rebuildDerivationGraph({ ledgerPath: ledger });
  assert.deepEqual(graphToObj(incremental), graphToObj(fresh),
    "incremental cold seed deep-equals fresh full rebuild");
  // Duplicate-id semantics survived: r_000 has BOTH parents.
  assert.deepEqual(Array.from(incremental.forwardAdj.get("r_000")).sort(), ["f_000", "f_001"]);
  // kindOf last-write-wins across the prefix/delta split.
  assert.equal(incremental.kindOf.get("f_002"), "policy");
});

// ---------------------------------------------------------------------------
// T3 — torn final line: never folded, never certified, folded once completed
// ---------------------------------------------------------------------------

test("T3: torn tail excluded from graph + persisted checkpoint; folds once after completion", async () => {
  const { ledger, cache } = fixture();
  writeLedger(ledger, makeBaseRows(10));
  const tornRow = reconRow("r_torn", ["f_000"]);
  appendFileSync(ledger, JSON.stringify(tornRow)); // NO trailing "\n" — torn

  // Fresh full rebuild over a ledger WITH a torn tail: the pinned checkpoint
  // must exclude the torn bytes and the row must not appear in the graph.
  simulateFreshProcess();
  const mid = await loadOrRebuildDerivationGraph({ ledgerPath: ledger, cachePath: cache });
  assert.equal(__peekColdSeedStatsForTests().mode, "full-rebuild");
  assert.equal(mid.forwardAdj.has("r_torn"), false, "torn row not folded");
  await _awaitPendingGraphCachePersists();
  const persisted = readCacheHeader(cache);
  const tornBytes = Buffer.byteLength(JSON.stringify(tornRow), "utf8");
  assert.ok(persisted.checkpoint, "payload carries a checkpoint");
  assert.equal(
    persisted.checkpoint.eof,
    statSync(ledger).size - tornBytes,
    "persisted checkpoint does NOT certify the torn bytes",
  );

  // Complete the torn row: the next cold seed folds exactly that one row.
  appendFileSync(ledger, "\n");
  simulateFreshProcess();
  const after = await loadOrRebuildDerivationGraph({ ledgerPath: ledger, cachePath: cache });
  const stats = __peekColdSeedStatsForTests();
  assert.equal(stats.mode, "incremental");
  assert.equal(stats.rows_folded, 1, "exactly the completed torn row folds");
  assert.ok(after.forwardAdj.get("r_torn").has("f_000"), "completed row folded");

  // Never doubled: equivalence with a fresh full rebuild.
  const fresh = await rebuildDerivationGraph({ ledgerPath: ledger });
  assert.deepEqual(graphToObj(after), graphToObj(fresh));
});

// ---------------------------------------------------------------------------
// T7 — FIX CYCLE 2 (reviewer's torn-tail seam): a row torn at COLD-SEED time
// must be applied by the WARM grow of the SAME process once its "\n" lands.
// The defect: the checkpoint cold seed folds to cp.eof but the projection
// layer recorded safeOffset = raw st.size, so the torn bytes [cp.eof, st.size)
// were never re-read — the completed row was permanently lost in-process.
// RED-RUN RECORD (2026-07-16, this workspace): before the fullRebuild
// {struct, resumeOffset} out-channel landed, the warm-grow assertion below
// FAILED exactly as the reviewer predicted (r_torn_warm edge missing after
// completion; deep-equal vs fresh rebuild mismatched).
// ---------------------------------------------------------------------------

test("T7: torn tail at cold-seed time is folded by the SAME process's warm grow after completion", async () => {
  const { ledger, cache } = fixture();
  writeLedger(ledger, makeBaseRows(10));
  simulateFreshProcess();
  await loadOrRebuildDerivationGraph({ ledgerPath: ledger, cachePath: cache });
  await _awaitPendingGraphCachePersists();

  // The torn row lands BEFORE a fresh process cold-seeds from the disk cache.
  const tornRow = reconRow("r_torn_warm", ["f_000"]);
  appendFileSync(ledger, JSON.stringify(tornRow)); // NO trailing "\n" — torn

  simulateFreshProcess();
  const seeded = await loadOrRebuildDerivationGraph({ ledgerPath: ledger, cachePath: cache });
  // The pinned checkpoint excludes the torn bytes -> zero delta -> exact hit.
  assert.equal(__peekColdSeedStatsForTests().mode, "cache-hit-exact");
  assert.equal(seeded.forwardAdj.has("r_torn_warm"), false, "torn row not folded at seed time");

  // The daemon completes the row. SAME process, NO reset: the warm grow must
  // resume at the checkpoint eof (not the raw pre-completion size) and apply
  // the completed row exactly once.
  appendFileSync(ledger, "\n");
  const warm = await loadOrRebuildDerivationGraph({ ledgerPath: ledger, cachePath: cache });
  assert.ok(
    warm.forwardAdj.get("r_torn_warm")?.has("f_000"),
    "completed torn row applied by the warm grow (resume offset = checkpoint eof, never raw size)",
  );
  const fresh = await rebuildDerivationGraph({ ledgerPath: ledger });
  assert.deepEqual(graphToObj(warm), graphToObj(fresh), "warm-grown graph == fresh full rebuild");
});

// ---------------------------------------------------------------------------
// T8 — R2/WI3 (stat-before-pin seam): the projection helper stats the ledger
// BEFORE invoking fullRebuild, but a checkpoint-seeded rebuild pins its
// coverage AFTER — a daemon append landing in between makes resumeOffset
// legitimately exceed the stale pre-rebuild st.size. The old cold branch
// clamped safeOffset = min(resumeOffset, st.size), so the next grow merge
// resumed BELOW the seed's coverage and RE-FOLDED the seed-covered row — a
// double-apply for non-idempotent reducers (hard-gates exciseRows is an
// array push).
// RED-RUN RECORD (2026-07-16, scratchpad r2-red, OUTSIDE the live tree): on
// the pre-fix module this exact test failed with folded == ["c","d"] (the
// seed-covered "c" re-folded by the grow merge) instead of ["d"].
// ---------------------------------------------------------------------------

test("T8: fullRebuild coverage past the pre-rebuild stat is never re-folded by the grow merge", async () => {
  const proj = await import("../../lib/synthesis/append-aware-ledger-projection.js");
  const { dir } = fixture();
  const ledger = join(dir, "race-ledger.jsonl");
  const row = (id) => JSON.stringify(factRow(id)) + "\n";
  writeFileSync(ledger, row("a") + row("b"), { mode: 0o600 });

  proj._resetAppendAwareProjectionCache();
  // NON-IDEMPOTENT reducer: an array push, mirroring hard-gates exciseRows.
  const folded = [];
  const opts = {
    ledgerPath: ledger,
    namespace: "t8-stat-before-pin",
    makeEmpty: () => [],
    applyParsedRow: (s, r) => {
      s.push(r.id);
      folded.push(r.id);
    },
    // Simulate the daemon append landing between the helper's statSync and
    // the seed's checkpoint pin: the rebuild itself appends "c", then reports
    // coverage = the post-append (newline-terminated) size, exactly like a
    // checkpoint pinned after the append.
    fullRebuild: () => {
      appendFileSync(ledger, row("c"), { mode: 0o600 });
      return { struct: ["a", "b", "c"], resumeOffset: statSync(ledger).size };
    },
  };

  const s1 = proj.appendAwareLedgerProjection(opts);
  assert.deepEqual(s1, ["a", "b", "c"], "cold seed handed back the full struct");
  assert.deepEqual(folded, [], "seed rows folded by the seed, not the helper");

  // Next daemon append, then the warm grow merge.
  appendFileSync(ledger, row("d"), { mode: 0o600 });
  const s2 = proj.appendAwareLedgerProjection(opts);
  assert.deepEqual(
    folded,
    ["d"],
    "grow merge folds ONLY the new row — the seed-covered row never re-folds",
  );
  assert.deepEqual(s2, ["a", "b", "c", "d"], "seed-folded row appears exactly once");

  // Genuine-shrink guard: a rebuild claiming coverage past the CURRENT file
  // (post-rebuild) is a discontinuity — the struct is served but never cached
  // (the next call must full-rebuild, not grow off unsound coverage).
  proj._resetAppendAwareProjectionCache();
  const shrinkLedger = join(dir, "shrink-ledger.jsonl");
  writeFileSync(shrinkLedger, row("x"), { mode: 0o600 });
  const s3 = proj.appendAwareLedgerProjection({
    ledgerPath: shrinkLedger,
    namespace: "t8-shrink",
    makeEmpty: () => [],
    applyParsedRow: (s, r) => s.push(r.id),
    fullRebuild: () => ({
      struct: ["x", "ghost"],
      resumeOffset: statSync(shrinkLedger).size + 1024, // claims bytes that do not exist
    }),
  });
  assert.deepEqual(s3, ["x", "ghost"], "struct still served on the shrink race");
  assert.equal(
    proj._peekAppendAwareProjection("t8-shrink", shrinkLedger),
    null,
    "coverage past the post-rebuild size is never cached (fail closed)",
  );
});

// ---------------------------------------------------------------------------
// T4 — prefix rewrite -> full rebuild (fail-closed), falsifiable deep-equal
// ---------------------------------------------------------------------------

test("T4: in-place prefix rewrite -> full rebuild; stale cache would keep the old edge", async () => {
  const { ledger, cache } = fixture();
  writeLedger(ledger, makeBaseRows(20));
  assert.ok(statSync(ledger).size < 64 * 1024, "fixture must be a single witness block");
  simulateFreshProcess();
  await loadOrRebuildDerivationGraph({ ledgerPath: ledger, cachePath: cache });
  await _awaitPendingGraphCachePersists();

  // Same-length in-place edit of a derived_from target: 'f_000' -> 'f_zzz'.
  // Size unchanged (defeats any size-only fingerprint); the edge SET changes,
  // so a stale cached graph fails the deep-equal below (falsifiable gate).
  const raw = readFileSync(ledger, "utf8");
  assert.ok(raw.includes('"derived_from":["f_000"]'));
  const mutated = raw.replace('"derived_from":["f_000"]', '"derived_from":["f_zzz"]');
  assert.equal(Buffer.byteLength(mutated), Buffer.byteLength(raw), "same-length mutation");
  writeFileSync(ledger, mutated);

  simulateFreshProcess();
  const reloaded = await loadOrRebuildDerivationGraph({ ledgerPath: ledger, cachePath: cache });
  assert.equal(
    __peekColdSeedStatsForTests().mode,
    "full-rebuild",
    "prefix drift must fail closed into a full rebuild",
  );
  const fresh = await rebuildDerivationGraph({ ledgerPath: ledger });
  assert.deepEqual(graphToObj(reloaded), graphToObj(fresh));
  assert.equal(reloaded.reverseAdj.has("f_000"), false, "old edge gone");
  assert.ok(reloaded.reverseAdj.get("f_zzz").has("r_000"), "new edge present");
});

// ---------------------------------------------------------------------------
// T5 — persist is off the critical path; exact-eof hit writes nothing
// ---------------------------------------------------------------------------

test("T5: cold rebuild returns before the cache write lands; exact-eof hit rewrites nothing", async () => {
  const { ledger, cache } = fixture();
  writeLedger(ledger, makeBaseRows(15));

  simulateFreshProcess();
  await loadOrRebuildDerivationGraph({ ledgerPath: ledger, cachePath: cache });
  // The load resolved but the persist was SCHEDULED, not awaited: the cache
  // file must not exist yet (the old code awaited a 45.7 MB synchronous write
  // right here, on the recall path).
  assert.equal(existsSync(cache), false, "persist has not run inside the load call");
  await _awaitPendingGraphCachePersists();
  assert.ok(existsSync(cache), "scheduled persist landed after the load returned");

  const bytesBefore = readFileSync(cache);
  const statBefore = statSync(cache);
  await new Promise((resolve) => setTimeout(resolve, 5)); // make churn detectable

  simulateFreshProcess();
  const hit = await loadOrRebuildDerivationGraph({ ledgerPath: ledger, cachePath: cache });
  assert.equal(__peekColdSeedStatsForTests().mode, "cache-hit-exact");
  assert.ok(hit.forwardAdj instanceof Map);
  await _awaitPendingGraphCachePersists(); // nothing should be pending
  const bytesAfter = readFileSync(cache);
  const statAfter = statSync(cache);
  assert.ok(bytesBefore.equals(bytesAfter), "exact-eof hit: cache bytes unchanged");
  assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, "exact-eof hit: cache mtime unchanged");
});

// ---------------------------------------------------------------------------
// T6 — legacy v1 payload (monolithic JSON, with OR without a checkpoint):
// never reinterpreted — one full rebuild migrates it to the v2 sectioned
// binary, which then serves exact hits + incremental folds (R2/WI1).
// ---------------------------------------------------------------------------

test("T6: legacy v1 payload migrates via full rebuild to a v2 binary payload", async () => {
  const { ledger, cache } = fixture();
  writeLedger(ledger, [factRow("f1"), reconRow("r1", ["f1"])]);
  const st = statSync(ledger);
  // A faithful v1 payload: exact mtime, correct maps, no checkpoint — under
  // the v1 scheme this seeded 'cache-hit-legacy'. v2 never reinterprets it
  // (a v1 monolith has no "\n" byte anywhere, so the header parse fails
  // closed) and migrates by full rebuild.
  writeFileSync(
    cache,
    JSON.stringify({
      schema_version: "v1",
      ledger_mtime_ms: st.mtimeMs,
      forwardAdj: { r1: ["f1"] },
      reverseAdj: { f1: ["r1"] },
      kindOf: { f1: "fact", r1: "reconstructed" },
      built_at: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );

  simulateFreshProcess();
  const migrated = await loadOrRebuildDerivationGraph({ ledgerPath: ledger, cachePath: cache });
  assert.equal(
    __peekColdSeedStatsForTests().mode,
    "full-rebuild",
    "legacy v1 payload is never served — one full rebuild migrates it",
  );
  assert.ok(migrated.reverseAdj.get("f1").has("r1"));
  await _awaitPendingGraphCachePersists();
  const persisted = readCacheHeader(cache);
  assert.equal(persisted.schema_version, "v2", "migrated payload is v2");
  assert.ok(
    persisted.checkpoint && typeof persisted.checkpoint.eof === "number",
    "migrated payload carries the checkpoint",
  );

  // The migrated v2 cache serves an exact hit with zero writes...
  simulateFreshProcess();
  await loadOrRebuildDerivationGraph({ ledgerPath: ledger, cachePath: cache });
  assert.equal(__peekColdSeedStatsForTests().mode, "cache-hit-exact");

  // ...and incremental folds thereafter.
  appendRows(ledger, [reconRow("r2", ["r1"])]);
  simulateFreshProcess();
  const inc = await loadOrRebuildDerivationGraph({ ledgerPath: ledger, cachePath: cache });
  assert.equal(__peekColdSeedStatsForTests().mode, "incremental");
  assert.equal(__peekColdSeedStatsForTests().rows_folded, 1);
  assert.ok(inc.reverseAdj.get("r1").has("r2"));
  const fresh = await rebuildDerivationGraph({ ledgerPath: ledger });
  assert.deepEqual(graphToObj(inc), graphToObj(fresh));
});
