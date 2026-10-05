// hard-gates-incremental-scan.test.mjs — WU-iter3-incrementalize-remaining-scans
// regression gate.
//
// AUTHORITATIVE problem statement (iter-3 audit):
//   loadDerivationExciseSet + loadTransitiveOrphanMap each drove the shared,
//   UNCACHED _scanLedger full-ledger streamLedgerLines pass on EVERY warm query
//   (~4.7s each). iter-3 routes the per-row streaming projection through the
//   iter-2 appendAwareLedgerProjection helper (one shared namespace) so the
//   common daemon-append case tail-merges ONLY the appended bytes.
//
// CORRECTNESS PARAMOUNT — these scans GATE recall (orphan excise, derivation
//   exclude). An incremental cache that diverges from a full rebuild corrupts
//   gating. This test proves the tail-merge is BYTE-IDENTICAL to a full rebuild:
//
//   (a) COLD build == full rebuild over the same file (per loader + raw scan).
//   (b) After appending N rows, the tail-merged struct == a FRESH full rebuild
//       over the WHOLE file (structural identity) — for the raw _scanLedger
//       struct AND for both downstream loaders.
//   (c) FILE REPLACED / SHRUNK -> full rebuild (no stale incremental).
//   (d) TORN FINAL LINE tolerance: a half-written trailing row (no "\n") is NOT
//       applied; re-read exactly once when its "\n" lands; never double-applied.
//   (e) RECALL GATING still correct: an orphan-excised candidate is still
//       excised over the tail-merged graph; a derivation-excluded fact is still
//       excluded; a connector_revoke whose source row appears AFTER the revoke
//       (resolved per-call against the tail-merged memoryIdsBySource) is excised.
//
// HERMETICITY: mkdtempSync root + per-case fresh ledger path; the loaders take
//   an explicit ledger_path so no env override is needed for the projection
//   path. We snapshot the production ledger pre/post and assert byte-identical —
//   we NEVER touch the live ledger.
//
// Run: node test/recall/hard-gates-incremental-scan.test.mjs

import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The checkout this suite runs from. Its default (un-overridden) ledgers,
// policy and indices are what the byte-identity guards below watch; the
// suite itself works under a temp MEMORY_ROOT.
const CHECKOUT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// ---------------------------------------------------------------------------
// Production-path snapshot BEFORE any work (hermeticity invariant).
// ---------------------------------------------------------------------------
const PROD_MEMORY_JSONL = join(CHECKOUT_ROOT, "ledgers", "memory.jsonl");
function snap(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}
const PROD_BEFORE = snap(PROD_MEMORY_JSONL);

const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-hg-incr-scan-"));
process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ---------------------------------------------------------------------------
// Imports. The loaders take an explicit ledger_path; the projection cache is
// reset via _resetTransitiveOrphanCaches (which now also clears the append-aware
// projection partition). The raw _scanLedger is exported for structural
// identity assertions.
// ---------------------------------------------------------------------------
const hgMod = await import("../../lib/recall/hard-gates.js");
const {
  _scanLedger,
  _resetTransitiveOrphanCaches,
  loadDerivationExciseSet,
  loadTransitiveOrphanMap,
  loadDerivationGraph,
  applyHardGates,
} = hgMod;

// ---------------------------------------------------------------------------
// Fixture helpers.
// ---------------------------------------------------------------------------
const TS = "2026-06-01T00:00:00.000Z";
let counter = 0;
function freshLedgerPath() {
  counter += 1;
  return join(TMP_ROOT, `ledger-${counter}.jsonl`);
}

function factRow(id, extra = {}) {
  return { id, kind: "fact", ts: TS, created_at: TS, ...extra };
}
function reconRow(id, derivedFrom) {
  return {
    id,
    kind: "reconstructed",
    ts: TS,
    created_at: TS,
    derived_from: derivedFrom,
  };
}
function exciseRow(id, targets, extra = {}) {
  return {
    id,
    kind: "policy",
    policy_kind: "excise",
    ts: TS,
    targets,
    ...extra,
  };
}
function rescindRow(id, targetPolicyIds) {
  return {
    id,
    kind: "policy",
    policy_kind: "rescind",
    ts: TS,
    targets: targetPolicyIds,
  };
}
function connectorRevokeRow(id, source) {
  return {
    id,
    kind: "policy",
    policy_kind: "connector_revoke",
    ts: TS,
    target_source: source,
  };
}
function sourcedFactRow(id, source) {
  return factRow(id, { source_refs: [{ source }] });
}

function writeRows(path, rows) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", {
    mode: 0o600,
  });
}
function appendRows(path, rows) {
  appendFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", {
    mode: 0o600,
  });
}
// Force mtime forward so a coarse-granularity FS does not mask the bump and the
// grow branch fires (st.mtimeMs >= cached.mtimeMs).
function bumpMtimeForward(path) {
  const future = new Date(Date.now() + 5000);
  utimesSync(path, future, future);
}

// Canonicalize the append-mergeable maps of a _scanLedger struct into a plain
// object so two scans can be compared structurally (Map/Set are not deepEqual-
// friendly by content). Excludes per-call-resolved fields where ordering is
// not load-bearing; we sort everything for determinism.
function adjToObj(adj) {
  const out = {};
  for (const [k, v] of adj) out[k] = Array.from(v).sort();
  return out;
}
function setToArr(s) {
  return Array.from(s).sort();
}
function bySourceToObj(map) {
  const out = {};
  for (const [k, v] of map) out[k] = Array.from(v).sort();
  return out;
}
function exciseRowsToObj(rows) {
  // Project each row to its content-bearing fields, then sort by a stable key.
  return rows
    .map((r) => ({
      policy_event_id: r.policy_event_id ?? null,
      connector_revoke: r.connector_revoke === true,
      retroactive_drop: r.retroactive_drop === true,
      target_source: r.target_source ?? null,
      targets: Array.isArray(r.targets) ? r.targets.slice().sort() : [],
      silent: r.silent === true,
      derivation_policy: r.derivation_policy ?? null,
      active_inline: r.active_inline !== false,
    }))
    .sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
}
function scanToObj(scan) {
  return {
    reverseAdj: adjToObj(scan.reverseAdj),
    rescindedPolicyIds: setToArr(scan.rescindedPolicyIds),
    revokedSources: setToArr(scan.revokedSources),
    memoryIdsBySource: bySourceToObj(scan.memoryIdsBySource),
    salienceFacts: Array.from(scan.salienceFacts.keys()).sort(),
    exciseRows: exciseRowsToObj(scan.exciseRows),
  };
}
function orphanMapToObj(m) {
  const out = {};
  for (const [k, v] of m) {
    out[k] = {
      distance_to_nearest_excised: v.distance_to_nearest_excised,
      transitive_orphan: v.transitive_orphan,
      rescued_by_corroboration: v.rescued_by_corroboration,
    };
  }
  return out;
}

// ===========================================================================
// T1 — RAW SCAN: cold build == full rebuild (same file, fresh cache each time).
// ===========================================================================
test("T1: cold _scanLedger == full rebuild over the same file", () => {
  _resetTransitiveOrphanCaches();
  const path = freshLedgerPath();
  writeRows(path, [
    factRow("f1"),
    factRow("f2"),
    reconRow("r1", ["f1"]),
    exciseRow("ex1", ["f1"], { derivation_policy: "drop" }),
  ]);
  const cold = _scanLedger(path);
  // Fresh full rebuild (cleared cache) over the WHOLE file.
  _resetTransitiveOrphanCaches();
  const full = _scanLedger(path);
  assert.deepEqual(
    scanToObj(cold),
    scanToObj(full),
    "cold scan struct == fresh full rebuild struct",
  );
  assert.deepEqual(
    scanToObj(cold).reverseAdj,
    { f1: ["r1"] },
    "reverseAdj captured the derivation edge",
  );
  assert.equal(
    scanToObj(cold).exciseRows.length,
    1,
    "exactly one excise row captured",
  );
});

// ===========================================================================
// T2 — RAW SCAN: append N rows -> tail-merge == fresh full rebuild (structural
// identity across the prefix/tail split).
// ===========================================================================
test("T2: tail-merged _scanLedger == fresh full rebuild after appends", () => {
  _resetTransitiveOrphanCaches();
  const path = freshLedgerPath();
  writeRows(path, [factRow("f1"), reconRow("r1", ["f1"])]);
  const warm1 = _scanLedger(path); // primes the projection cache
  assert.deepEqual(adjToObj(warm1.reverseAdj), { f1: ["r1"] }, "cold edge");

  // Daemon appends more derivation rows + an excise + a rescind targeting it.
  appendRows(path, [
    reconRow("r2", ["r1"]),
    reconRow("r3", ["f1"]),
    exciseRow("ex_late", ["f1"], { derivation_policy: "drop" }),
    rescindRow("resc1", ["ex_late"]),
  ]);
  bumpMtimeForward(path);
  const merged = _scanLedger(path); // tail-merge branch

  // Fresh full rebuild over the WHOLE file (cleared cache).
  _resetTransitiveOrphanCaches();
  const freshFull = _scanLedger(path);

  assert.deepEqual(
    scanToObj(merged),
    scanToObj(freshFull),
    "tail-merged scan is structurally identical to a fresh full rebuild",
  );
  assert.deepEqual(
    adjToObj(merged.reverseAdj),
    { f1: ["r1", "r3"], r1: ["r2"] },
    "tail-merge folded the appended derivation edges",
  );
  assert.deepEqual(
    setToArr(merged.rescindedPolicyIds),
    ["ex_late"],
    "tail-merge folded the appended rescind",
  );
});

// ===========================================================================
// T3 — RAW SCAN: file SHRINK / mtime-regression -> full rebuild (no stale data).
// ===========================================================================
test("T3: shrink + mtime-regression force a clean rebuild (no stale rows)", () => {
  _resetTransitiveOrphanCaches();
  const path = freshLedgerPath();
  writeRows(path, [factRow("f1"), reconRow("r1", ["f1"]), reconRow("r2", ["r1"])]);
  const s1 = _scanLedger(path);
  assert.deepEqual(adjToObj(s1.reverseAdj), { f1: ["r1"], r1: ["r2"] });

  // SHRINK: replace with a smaller, different file (truncation / rotation).
  writeRows(path, [factRow("z"), reconRow("rz", ["z"])]);
  bumpMtimeForward(path);
  const s2 = _scanLedger(path);
  assert.deepEqual(
    adjToObj(s2.reverseAdj),
    { z: ["rz"] },
    "shrink rebuilt from byte 0; NO stale f1/r1/r2 carried over",
  );

  // MTIME REGRESSION: larger file but mtime moves backward.
  writeRows(path, [
    factRow("p"),
    reconRow("rp", ["p"]),
    reconRow("rp2", ["rp"]),
    factRow("q"),
  ]);
  const past = new Date(Date.now() - 60_000);
  utimesSync(path, past, past);
  const s3 = _scanLedger(path);
  assert.deepEqual(
    adjToObj(s3.reverseAdj),
    { p: ["rp"], rp: ["rp2"] },
    "mtime regression rebuilt from byte 0; no stale z/rz",
  );
});

// ===========================================================================
// T4 — RAW SCAN: TORN FINAL LINE tolerance. A half-written trailing row (no
// "\n") is NOT applied; applied EXACTLY once when its "\n" lands.
// ===========================================================================
test("T4: torn final line not applied, then applied exactly once on completion", () => {
  _resetTransitiveOrphanCaches();
  const path = freshLedgerPath();
  writeRows(path, [factRow("f1"), reconRow("r1", ["f1"])]); // newline-terminated
  const s1 = _scanLedger(path);
  assert.deepEqual(adjToObj(s1.reverseAdj), { f1: ["r1"] }, "cold edge");

  // Append a TORN derivation row: JSON WITHOUT a terminating newline.
  appendFileSync(path, JSON.stringify(reconRow("r2", ["r1"])), { mode: 0o600 });
  bumpMtimeForward(path);
  const s2 = _scanLedger(path);
  assert.deepEqual(
    adjToObj(s2.reverseAdj),
    { f1: ["r1"] },
    "torn trailing row r2 is NOT applied (no r1->r2 edge yet)",
  );

  // Daemon finishes the row: append the trailing "\n".
  appendFileSync(path, "\n", { mode: 0o600 });
  bumpMtimeForward(path);
  const s3 = _scanLedger(path);
  assert.deepEqual(
    adjToObj(s3.reverseAdj),
    { f1: ["r1"], r1: ["r2"] },
    "completed row r2 applied exactly once (edge appears, not doubled)",
  );
  // A Set.add is idempotent, so the strongest double-apply guard is the FULL
  // rebuild structural-identity check.
  _resetTransitiveOrphanCaches();
  const freshFull = _scanLedger(path);
  assert.deepEqual(
    scanToObj(s3),
    scanToObj(freshFull),
    "post-torn-completion scan == fresh full rebuild (no double-apply drift)",
  );
});

// ===========================================================================
// T5 — GATING (derivation exclude): a derivation-excluded fact stays excluded
// after a tail-merge; loadDerivationExciseSet tail-merge == fresh full rebuild.
// ===========================================================================
test("T5: derivation-excised fact stays in excise set across a tail-merge", async () => {
  _resetTransitiveOrphanCaches();
  const path = freshLedgerPath();
  writeRows(path, [
    factRow("keep_1"),
    factRow("drop_1"),
    exciseRow("ex_drop1", ["drop_1"], { derivation_policy: "drop" }),
  ]);
  const set1 = await loadDerivationExciseSet({ ledger_path: path });
  assert.ok(set1.has("drop_1"), "cold: drop_1 excised");
  assert.ok(!set1.has("keep_1"), "cold: keep_1 not excised");

  // Append a second excise; reset the orphan/result caches (mtime-keyed) so the
  // loader re-runs, but the SCAN goes through the tail-merge.
  appendRows(path, [
    factRow("drop_2"),
    exciseRow("ex_drop2", ["drop_2"], { derivation_policy: "drop" }),
  ]);
  bumpMtimeForward(path);
  const set2 = await loadDerivationExciseSet({ ledger_path: path });
  assert.ok(set2.has("drop_1"), "tail-merge: original drop_1 STILL excised (gate intact)");
  assert.ok(set2.has("drop_2"), "tail-merge: appended drop_2 now excised");

  // (e) A derivation-excluded fact is still excluded by applyHardGates: a
  // candidate deriving from an excised ancestor is dampened to ORPHAN.
  const candidate = {
    memory_id: "child_of_drop1",
    derived_from: ["drop_1"],
    embedding_3072: null,
  };
  const gated = applyHardGates([candidate], {
    derivation_excise_set: set2,
    embedding_model_version: "gemini-embedding-001",
  });
  assert.ok(
    gated[0].derivation_status < 1.0,
    "candidate deriving from excised drop_1 is dampened (derivation exclude gate fires)",
  );

  // Fresh full rebuild over the whole file (cleared cache) — identical set.
  _resetTransitiveOrphanCaches();
  const freshFull = await loadDerivationExciseSet({ ledger_path: path });
  assert.deepEqual(
    setToArr(set2),
    setToArr(freshFull),
    "tail-merged excise set == fresh full rebuild excise set",
  );
});

// ===========================================================================
// T6 — GATING (orphan excise): a transitive-orphan candidate is still excised
// over the tail-merged graph; the appended grandchild is reached by the BFS.
// ===========================================================================
test("T6: transitive-orphan candidate still excised over the tail-merged graph", async () => {
  _resetTransitiveOrphanCaches();
  const path = freshLedgerPath();
  // root excised; child derives from it.
  writeRows(path, [
    factRow("root"),
    reconRow("child", ["root"]),
    exciseRow("ex_root", ["root"], { derivation_policy: "drop" }),
  ]);
  const map1 = await loadTransitiveOrphanMap({ ledger_path: path });
  assert.ok(map1.get("child")?.transitive_orphan === true, "cold: child is orphan");

  // Daemon appends a grandchild via tail-merge.
  appendRows(path, [reconRow("grandchild", ["child"])]);
  bumpMtimeForward(path);
  const map2 = await loadTransitiveOrphanMap({ ledger_path: path });
  assert.ok(
    map2.get("child")?.transitive_orphan === true,
    "tail-merge: original child STILL orphaned",
  );
  assert.ok(
    map2.get("grandchild")?.transitive_orphan === true,
    "tail-merge: appended grandchild reached by BFS (gate still fires)",
  );
  assert.equal(
    map2.get("grandchild").distance_to_nearest_excised,
    2,
    "grandchild at distance 2 (root->child->grandchild)",
  );

  // Fresh full rebuild — structurally identical orphan map.
  _resetTransitiveOrphanCaches();
  const freshFull = await loadTransitiveOrphanMap({ ledger_path: path });
  assert.deepEqual(
    orphanMapToObj(map2),
    orphanMapToObj(freshFull),
    "tail-merged orphan map == fresh full rebuild orphan map",
  );

  // The candidate is dampened by applyHardGates over the tail-merged map.
  const gated = applyHardGates(
    [{ memory_id: "grandchild", embedding_3072: null }],
    {
      transitive_orphan_map: map2,
      embedding_model_version: "gemini-embedding-001",
    },
  );
  assert.ok(
    gated[0].derivation_status < 1.0,
    "grandchild orphan is dampened by applyHardGates (orphan excise gate fires)",
  );
});

// ===========================================================================
// T7 — GATING (connector_revoke source-appears-AFTER-revoke): the per-call
// resolution re-derives targets against the TAIL-MERGED memoryIdsBySource, so a
// memory row appended for a revoked source AFTER the revoke is still excised.
// This is the case the cached-struct-mutation hazard would have broken.
// ===========================================================================
test("T7: connector_revoke resolves source rows appended AFTER the revoke", async () => {
  _resetTransitiveOrphanCaches();
  const path = freshLedgerPath();
  // Revoke source 'imessage' BEFORE any imessage memory exists.
  writeRows(path, [
    factRow("unrelated"),
    connectorRevokeRow("revoke_im", "imessage"),
  ]);
  const set1 = await loadDerivationExciseSet({ ledger_path: path });
  assert.equal(
    set1.size,
    0,
    "cold: revoke has no targets yet (no imessage memory rows)",
  );

  // Daemon appends an imessage-sourced memory AFTER the revoke.
  appendRows(path, [sourcedFactRow("im_late", "imessage")]);
  bumpMtimeForward(path);
  const set2 = await loadDerivationExciseSet({ ledger_path: path });
  assert.ok(
    set2.has("im_late"),
    "tail-merge: late imessage row resolved into the revoke excise set",
  );

  // Append a SECOND imessage row — the per-call resolution must pick BOTH up
  // (proving the cached marker stayed unresolved, never frozen at one target).
  appendRows(path, [sourcedFactRow("im_later", "imessage")]);
  bumpMtimeForward(path);
  const set3 = await loadDerivationExciseSet({ ledger_path: path });
  assert.ok(set3.has("im_late"), "still excises the first late row");
  assert.ok(set3.has("im_later"), "also excises the second late row (re-resolved)");

  // Fresh full rebuild — identical excise set (no stale single-target freeze).
  _resetTransitiveOrphanCaches();
  const freshFull = await loadDerivationExciseSet({ ledger_path: path });
  assert.deepEqual(
    setToArr(set3),
    setToArr(freshFull),
    "tail-merged connector_revoke excise set == fresh full rebuild",
  );
});

// ===========================================================================
// T8 — loadDerivationGraph (hard-gates) shares _scanLedger: cold == tail-merge
// fresh full rebuild adjacency. (Not on the recall warm path per the audit, but
// it consumes the same shared scan so it must remain correct.)
// ===========================================================================
test("T8: loadDerivationGraph reverseAdj tail-merge == fresh full rebuild", async () => {
  _resetTransitiveOrphanCaches();
  const path = freshLedgerPath();
  writeRows(path, [factRow("a"), reconRow("ra", ["a"])]);
  const g1 = await loadDerivationGraph({ ledger_path: path });
  assert.deepEqual(adjToObj(g1), { a: ["ra"] }, "cold reverseAdj");

  appendRows(path, [reconRow("ra2", ["a"]), reconRow("rb", ["ra"])]);
  bumpMtimeForward(path);
  const g2 = await loadDerivationGraph({ ledger_path: path });

  _resetTransitiveOrphanCaches();
  const freshFull = await loadDerivationGraph({ ledger_path: path });
  assert.deepEqual(
    adjToObj(g2),
    adjToObj(freshFull),
    "tail-merged reverseAdj == fresh full rebuild reverseAdj",
  );
  assert.deepEqual(
    adjToObj(g2),
    { a: ["ra", "ra2"], ra: ["rb"] },
    "tail-merge folded the appended edges",
  );
});

// ===========================================================================
// T9 — HERMETICITY: the live production ledger was never touched.
// ===========================================================================
test("T9: production ledger untouched (hermeticity)", () => {
  assert.equal(
    snap(PROD_MEMORY_JSONL),
    PROD_BEFORE,
    "live memory.jsonl unchanged",
  );
});
