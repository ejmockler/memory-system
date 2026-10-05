// incremental-agg-equivalence.test.mjs — VERIFY node (LOAD-BEARING gate).
//
// Proves the load-bearing invariant of the incremental-aggregation arc:
//   with the CAPS flag OFF (full-ledger rescan, byte-for-byte baseline) and
//   with it ON (offset-checkpointed incremental fold) the watermark daemon's
//   thread + project aggregators emit the IDENTICAL SET of reconstructed rows
//   (and reconcile.* policy rows) over the SAME synthetic ledger states.
//
// This is an intentional-diff + flag gate (design.md §D-5): flag-OFF == the
// pre-arc reconstructed set; flag-ON == the same normalized identity set with a
// fraction of the I/O + heap. A TRUTHFUL failure (flag-ON != flag-OFF at some
// step) is a CRITICAL finding — the per-step assertions localize the diverging
// step so it is never papered over.
//
// Equivalence key (design.md §D-5.1) — id/ts stripped (volatile per run):
//   reconstructed → { idempotency_key, content, derived_from.sort(),
//                     contradicts.sort(), resolution }
//   reconcile.*   → { policy_kind, scope, targets.sort(), payload }
//
// Methodology (design.md §D-5.2): the checkpoint dir is STORAGE_BASE_DIR-derived
// and the incremental state map is keyed by ledgerPath, so OFF and ON run
// IN-PROCESS over two sibling ledgers with the flag toggled via the explicit
// `incremental` arg (design.md §D-4.2). Every fixture drives BOTH aggregators,
// OFF and ON, over the SAME ledger states, and asserts the two sig sets are
// deep-equal AFTER each run so divergence is caught at its origin.
//
// Fixtures (design.md §D-5.2 + VERIFY.md STEP 2):
//   (a) cold / baseline (+ pre-arc non-empty baseline guard)
//   (b) window EVICTION — a fact ages OUT on a zero-append re-run
//   (c) backfilled OLD-ts row at the physical tail (the ROOT-CAUSE case)
//   (d) excise policy landing AFTER a derived child (orphan / parent-reject)
//   (e) zero-append no-op (S5 idempotent re-fire)
//   (f) COLD RESTART across a persisted checkpoint WITH a future-ts row
//   (g) torn tail — un-terminated line folded exactly once when completed
//   (h) checkpoint self-heal — truncate below the persisted offset → rebuild
//   (i) reconciliation SUBSTITUTE — contradicts[]/resolution + reconcile.substitute
//       policy row are NON-EMPTY in the key (proves the byId-order / narrow
//       reverseAdj machinery of §D-2.5)
//   (j) THREAD cold restart + future-ts row — the symmetric twin of (f) for the
//       THREAD aggregator (24h window / UTC-day bucket / imessage chat key). Guards
//       thread-aggregator.js buildTransientEmitMap's `factMs <= nowEpoch` emit-time
//       ceiling: a once-future-ts fact must be EXCLUDED at emit while future and
//       INCLUDED once `now` advances past it, IDENTICALLY on both paths — across a
//       cold restart (reset state, keep checkpoint) and a subsequent warm tick.
//   (k) PROJECT inode-change self-heal — a warm flag-ON project ledger REPLACED
//       under a NEW inode (renameSync a fresh file over the path) at size >= the
//       working offset, so the orthogonal offset>size shrink-heal CANNOT fire and
//       the inode path is isolated. The new ledger carries a DIFFERENT bucket whose
//       facts sit BELOW the old offset — a naive warm fold reading only [offset,EOF)
//       would MISS them and diverge. Guards project-aggregator.js's
//       `state.ino !== ledgerIno` warm self-heal disjunct (mirrors thread-aggregator):
//       the warm tick must cold-rescan the whole new ledger and emit the IDENTICAL
//       set as the flag-OFF full rescan. Without the disjunct this fixture diverges.
//
// Hermetic discipline: env vars set BEFORE any dynamic import touches config.js
// (mirrors distill-emit-reconstructed.test.mjs / parent-index.test.mjs), so all
// state lands under TMP_ROOT and the default (production) root is
// untouched. NEVER readFileSync a ledger for sig extraction — streamLedgerLines
// only (the real ledger is 1.968 GB, past Node's string cap).
//
// Run: node --test test/synthesis/incremental-agg-equivalence.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// -----------------------------------------------------------------------------
// Hermetic env — MUST precede any dynamic import that reads config.js at load.
// -----------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "memsys-agg-equiv-"));
process.env.MEMORY_ROOT = TMP_ROOT;
process.env.POLICY_BASE_DIR = join(TMP_ROOT, "policy");
process.env.STORAGE_BASE_DIR = join(TMP_ROOT, "storage");
process.env.LEDGERS_BASE_DIR = join(TMP_ROOT, "ledgers");
process.env.HOOKS_BASE_DIR = join(TMP_ROOT, "hooks");
process.env.DAEMONS_BASE_DIR = join(TMP_ROOT, "daemons");
// Do NOT set MEMORY_INCREMENTAL_AGGREGATION_ENABLED — the flag stays default
// OFF at module-load, and every fixture toggles the path via the explicit
// `incremental` arg (design.md §D-4.2). This also lets us assert the
// flag-default-OFF regression guard directly.
delete process.env.MEMORY_INCREMENTAL_AGGREGATION_ENABLED;

for (const d of [
  process.env.POLICY_BASE_DIR,
  process.env.STORAGE_BASE_DIR,
  process.env.LEDGERS_BASE_DIR,
  process.env.HOOKS_BASE_DIR,
  process.env.DAEMONS_BASE_DIR,
  join(process.env.STORAGE_BASE_DIR, "sources"),
  join(process.env.STORAGE_BASE_DIR, "aggregator-state"),
]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}

process.on("exit", () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {}
});

// -----------------------------------------------------------------------------
// Dynamic imports — bound into TMP_ROOT.
// -----------------------------------------------------------------------------
const threadMod = await import("../../lib/synthesis/thread-aggregator.js");
const { aggregateThreads, THREAD_AGGREGATOR_CAPS } = threadMod;
const threadInternal = threadMod.__internal;

const projectMod = await import("../../lib/synthesis/project-aggregator.js");
const { aggregateProjects, PROJECT_AGGREGATOR_CAPS } = projectMod;
const projectInternal = projectMod.__internal;

const emitterMod = await import("../../lib/synthesis/reconstruction-emitter.js");
const { emitReconstruction, RECONSTRUCT_TOKEN_TYPE } = emitterMod;

const { streamLedgerLines } = await import(
  "../../lib/synthesis/_ledger-stream.js"
);
const { writeCheckpoint, readCheckpointRecord } = await import(
  "../../lib/synthesis/_agg-checkpoint.js"
);
const { _resetParentIndexCache } = await import(
  "../../lib/synthesis/_parent-index.js"
);
const { initSigningKey, loadSigningKey, mintToken } = await import(
  "../../lib/daemon-token.js"
);
const { canonicalJsonSha256Hex } = await import("../../lib/validation.js");

function ensureSigningKey() {
  try {
    return initSigningKey().key;
  } catch (e) {
    if (e && e.code === "EEXIST") return loadSigningKey().key;
    throw e;
  }
}
const SIGNING_KEY = ensureSigningKey();

// -----------------------------------------------------------------------------
// Fixture + harness helpers
// -----------------------------------------------------------------------------

let _seq = 0;
// A fixture gets a fresh, isolated pair of sibling ledgers (off + on) plus a
// pair of aggregator-state checkpoint dirs, all under TMP_ROOT.
function freshPair(name) {
  const dir = mkdtempSync(join(process.env.LEDGERS_BASE_DIR, `${name}-${_seq++}-`));
  const cpDir = join(dir, "aggregator-state");
  mkdirSync(cpDir, { recursive: true, mode: 0o700 });
  // Reset the module-level incremental state + PIDX cache so the ON ledger
  // starts genuinely cold (design.md §D-3.4 cold start), independent of any
  // prior fixture. (Distinct ledgerPaths already keep state separate; this is
  // belt-and-suspenders + the mechanism fixture (f) uses to simulate a restart.)
  threadInternal.resetIncrementalStateForTest();
  projectInternal.resetIncrementalStateForTest();
  _resetParentIndexCache();
  return {
    off: join(dir, "off.jsonl"),
    on: join(dir, "on.jsonl"),
    threadCp: join(cpDir, "thread.json"),
    projectCp: join(cpDir, "project.json"),
  };
}

// Append rows to BOTH ledgers byte-identically (JSON + "\n").
function appendBoth(pair, rows) {
  const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  appendFileSync(pair.off, text, { mode: 0o600 });
  appendFileSync(pair.on, text, { mode: 0o600 });
}

// Append RAW bytes to BOTH ledgers (torn-tail fixture needs sub-line control).
function appendRawBoth(pair, text) {
  appendFileSync(pair.off, text, { mode: 0o600 });
  appendFileSync(pair.on, text, { mode: 0o600 });
}

// Rewrite BOTH ledgers to an identical smaller content (self-heal fixture).
function rewriteBoth(pair, rows) {
  const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(pair.off, text, { mode: 0o600 });
  writeFileSync(pair.on, text, { mode: 0o600 });
}

// Replace BOTH ledgers under a NEW inode. writeFileSync truncates the file in
// place (SAME inode); renaming a freshly-written sibling file OVER the ledger
// path installs a new inode — the exact event the aggregators' inode-change
// self-heal must detect (compaction / restore-from-backup / out-of-band swap).
// `text` is written verbatim so the caller controls the exact byte layout (used
// by fixture (k) to place facts BELOW the old offset + pad size >= the offset).
function renameOverBoth(pair, text) {
  for (const p of [pair.off, pair.on]) {
    const tmp = join(p, "..", `.rewrite-${_seq++}.tmp`);
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, p);
  }
}

// Production-shaped promoted-fact rows (mirrors thread/project aggregator test
// fixtures): top-level ts + a raw_content identity envelope + source_refs with
// consent_basis so the emitter's consent walk admits the daemon emit.
function imFact(id, chatId, tsIso, content) {
  return {
    id,
    kind: "fact",
    source: "imessage",
    content,
    ts: tsIso,
    raw_content: { chat_identifier: chatId },
    source_refs: [
      { source: "imessage", source_msg_id: `imsg_${id}`, via: "original", consent_basis: "first_party" },
    ],
    derived_from: [],
    provenance: { agent_id: "test-fixture", conversation_id: null, confidence: "high" },
  };
}
function gitFact(id, repo, email, tsIso, content) {
  return {
    id,
    kind: "fact",
    source: "git-log",
    content,
    ts: tsIso,
    raw_content: { repo_path: repo, author_email: email },
    source_refs: [
      { source: "git-log", source_msg_id: `git_${id}`, via: "original", consent_basis: "first_party" },
    ],
    derived_from: [],
    provenance: { agent_id: "test-fixture", conversation_id: null, confidence: "high" },
  };
}
function ghFact(id, repo, login, tsIso, content) {
  return {
    id,
    kind: "fact",
    source: "github-events",
    content,
    ts: tsIso,
    raw_content: { repo, actor_login: login },
    source_refs: [
      { source: "github-events", source_msg_id: `gh_${id}`, via: "original", consent_basis: "first_party" },
    ],
    derived_from: [],
    provenance: { agent_id: "test-fixture", conversation_id: null, confidence: "high" },
  };
}
function excisePolicy(id, targetId, tsIso) {
  return { id, ts: tsIso, kind: "policy", policy_kind: "excise", targets: [targetId] };
}

// A deterministic ulid factory — one per aggregation call. For the aggregation
// fixtures the emitted row's OWN id is stripped from the sig key and never
// referenced, so any monotone factory suffices; the reconciliation fixture uses
// lockstep factories (fresh per path) so cross-referenced ids match OFF vs ON.
function ulidFactory(prefix = "u") {
  let n = 0;
  return () => `${prefix}${String(n++).padStart(4, "0")}`;
}

const THREAD_SINCE = THREAD_AGGREGATOR_CAPS.TIME_WINDOW_MS; // 24h
const PROJECT_SINCE = PROJECT_AGGREGATOR_CAPS.TIME_WINDOW_MS; // 7d

async function runThread(ledgerPath, { now, incremental, checkpointPath } = {}) {
  return aggregateThreads({
    ledgerPath,
    sinceMs: THREAD_SINCE,
    now,
    emitterCtx: { now: () => now, ulid: ulidFactory("t") },
    incremental,
    checkpointPath,
  });
}
async function runProject(ledgerPath, { now, incremental, checkpointPath } = {}) {
  return aggregateProjects({
    ledgerPath,
    sinceMs: PROJECT_SINCE,
    now,
    emitterCtx: { now: () => now, ulid: ulidFactory("p") },
    incremental,
    checkpointPath,
  });
}

// Run thread+project on the OFF ledger (flag-OFF) and on the ON ledger (flag-ON)
// at the same `now`, returning the four envelopes.
async function stepBoth(pair, now) {
  const offThread = await runThread(pair.off, { now, incremental: false });
  const offProject = await runProject(pair.off, { now, incremental: false });
  const onThread = await runThread(pair.on, { now, incremental: true, checkpointPath: pair.threadCp });
  const onProject = await runProject(pair.on, { now, incremental: true, checkpointPath: pair.projectCp });
  return { offThread, offProject, onThread, onProject };
}

// -----------------------------------------------------------------------------
// Sig-set extraction — stream ONLY (never readFileSync a ledger).
// -----------------------------------------------------------------------------
function sigSet(ledgerPath) {
  const set = new Set();
  streamLedgerLines(ledgerPath, (row) => {
    if (row == null || typeof row !== "object") return;
    if (row.kind === "reconstructed") {
      set.add(
        JSON.stringify({
          t: "rec",
          idempotency_key: row.idempotency_key ?? null,
          content: row.content ?? null,
          derived_from: Array.isArray(row.derived_from) ? [...row.derived_from].sort() : [],
          contradicts: Array.isArray(row.contradicts) ? [...row.contradicts].sort() : [],
          resolution: row.resolution ?? null,
        }),
      );
    } else if (
      row.kind === "policy" &&
      typeof row.policy_kind === "string" &&
      row.policy_kind.startsWith("reconcile.")
    ) {
      set.add(
        JSON.stringify({
          t: "pol",
          policy_kind: row.policy_kind,
          scope: row.scope ?? null,
          targets: Array.isArray(row.targets) ? [...row.targets].sort() : [],
          payload: row.payload ?? null,
        }),
      );
    }
  });
  return set;
}

function sortedArr(set) {
  return [...set].sort();
}

// Assert flag-ON sig set deep-equals flag-OFF, and (non-vacuity) flag-OFF > 0.
// Returns the OFF set for further inspection.
function assertEquivalent(pair, label, { requireNonEmpty = true } = {}) {
  const off = sigSet(pair.off);
  const on = sigSet(pair.on);
  const offArr = sortedArr(off);
  const onArr = sortedArr(on);
  assert.deepEqual(
    onArr,
    offArr,
    `${label}: flag-ON reconstructed/reconcile sig set diverges from flag-OFF\n  OFF-only: ${JSON.stringify(
      offArr.filter((x) => !on.has(x)),
    )}\n  ON-only: ${JSON.stringify(onArr.filter((x) => !off.has(x)))}`,
  );
  if (requireNonEmpty) {
    assert.ok(off.size > 0, `${label}: flag-OFF sig set is empty (vacuous equality)`);
  }
  return off;
}

// -----------------------------------------------------------------------------
// FLAG-DEFAULT-OFF regression guard (design.md §D-4 / STEP 1).
// -----------------------------------------------------------------------------
test("flag default is OFF: resolveIncremental(undefined) === false on both aggregators", () => {
  assert.equal(threadInternal.resolveIncremental(undefined), false, "thread flag default OFF");
  assert.equal(projectInternal.resolveIncremental(undefined), false, "project flag default OFF");
  // Explicit arg wins (design.md §D-4.2).
  assert.equal(threadInternal.resolveIncremental(true), true);
  assert.equal(projectInternal.resolveIncremental(false), false);
});

// =============================================================================
// (a) COLD / BASELINE — 3 imessage + 3 git-log + 2 github-events at T0.
//     thread: chatA-day, /r-a@b-day ; project: /r-email:a@b-week, o/r-login:u-week.
//     Also captures the pre-arc baseline (non-empty) — flag-default regression.
// =============================================================================
test("(a) cold/baseline: flag-ON == flag-OFF; pre-arc set non-empty", async () => {
  const pair = freshPair("a-cold");
  const T0 = "2026-06-17T18:00:00.000Z";
  appendBoth(pair, [
    imFact("a_im1", "chatA", "2026-06-17T10:00:00.000Z", "imessage one: planning the weekend coast trip"),
    imFact("a_im2", "chatA", "2026-06-17T10:05:00.000Z", "imessage two: confirming the saturday departure time"),
    imFact("a_im3", "chatA", "2026-06-17T10:10:00.000Z", "imessage three: booking the beach house for two nights"),
    gitFact("a_g1", "/r", "a@b", "2026-06-17T10:00:00.000Z", "commit one: refactor the ingest normalizer path"),
    gitFact("a_g2", "/r", "a@b", "2026-06-17T10:05:00.000Z", "commit two: add streaming ledger offset reader"),
    gitFact("a_g3", "/r", "a@b", "2026-06-17T10:10:00.000Z", "commit three: fix torn-tail resume offset bug"),
    ghFact("a_gh1", "o/r", "u", "2026-06-17T10:00:00.000Z", "github event one: opened pull request 42 for review"),
    ghFact("a_gh2", "o/r", "u", "2026-06-17T10:05:00.000Z", "github event two: merged pull request 42 into main"),
  ]);

  const env = await stepBoth(pair, T0);
  const off = assertEquivalent(pair, "(a) cold/baseline");

  // Concretely: 2 thread recs (chatA-day, /r-a@b-day) + 2 project recs
  // (/r-email:a@b-week, o/r-login:u-week) = 4 distinct reconstructed rows.
  assert.equal(off.size, 4, "(a) baseline emits exactly 4 reconstructed rows");
  assert.equal(env.offThread.reconstructed_emitted, 2, "(a) OFF thread emitted 2");
  assert.equal(env.onThread.reconstructed_emitted, 2, "(a) ON thread emitted 2");
  assert.equal(env.offProject.reconstructed_emitted, 2, "(a) OFF project emitted 2");
  assert.equal(env.onProject.reconstructed_emitted, 2, "(a) ON project emitted 2");

  // Cold ON run reads the whole (tiny) ledger once (design.md §D-1.5).
  assert.ok(env.onThread.bytes_scanned > 0, "(a) cold ON thread scanned bytes");
  assert.ok(env.onProject.bytes_scanned > 0, "(a) cold ON project scanned bytes");
});

// =============================================================================
// (b) WINDOW EVICTION — a fact ages OUT of the 24h thread window on a
//     ZERO-append re-run. Per-fact eviction must drop it and NOT re-emit.
// =============================================================================
test("(b) window eviction on zero-append re-run: per-fact evict, no stale re-emit", async () => {
  const pair = freshPair("b-evict");
  appendBoth(pair, [
    imFact("b_im1", "chatB", "2026-06-17T10:00:00.000Z", "eviction chat one: discussing the quarterly roadmap"),
    imFact("b_im2", "chatB", "2026-06-17T10:05:00.000Z", "eviction chat two: aligning on the launch checklist"),
    imFact("b_im3", "chatB", "2026-06-17T10:10:00.000Z", "eviction chat three: assigning the remaining action items"),
  ]);

  // Run 1 — all in window → thread emit for chatB-day.
  const r1 = await stepBoth(pair, "2026-06-17T18:00:00.000Z");
  const off1 = assertEquivalent(pair, "(b) run1");
  assert.equal(off1.size, 1, "(b) run1 emits exactly 1 thread rec");
  assert.equal(r1.offThread.reconstructed_emitted, 1);
  assert.equal(r1.onThread.reconstructed_emitted, 1);

  // Run 2 — advance now +26h past the facts (all factMs < minTs), ZERO append.
  // Full-rescan finds 0 in-window facts → no bucket. Incremental must PER-FACT
  // evict the aged facts, delete the now-empty bucket, and NOT re-emit.
  const r2 = await stepBoth(pair, "2026-06-19T12:00:00.000Z");
  const off2 = assertEquivalent(pair, "(b) run2 eviction");
  assert.equal(off2.size, 1, "(b) run2 set unchanged (old rec persists, nothing new)");
  assert.equal(r2.offThread.reconstructed_emitted, 0, "(b) OFF emits nothing new after eviction");
  assert.equal(r2.onThread.reconstructed_emitted, 0, "(b) ON emits nothing new after eviction");

  // The ON incremental state must have PER-FACT evicted the aged bucket.
  const st = threadInternal.getIncrementalStateForTest(pair.on);
  assert.ok(st, "(b) ON thread state present");
  assert.equal(st.buckets.size, 0, "(b) ON thread state emptied by per-fact eviction");
});

// =============================================================================
// (c) BACKFILLED OLD-ts ROW AT THE PHYSICAL TAIL — the ROOT-CAUSE case.
//     The fold must key on the row's OWN ts (never assume append==ts order):
//     thread drops it (< minTs); project folds it into the OLD week bucket.
//     Also carries the cost micro-assert: warm delta ≪ cold full scan.
// =============================================================================
test("(c) backfilled old-ts row at tail: fold on row-ts, project re-emits; warm delta ≪ cold", async () => {
  const pair = freshPair("c-backfill");
  appendBoth(pair, [
    gitFact("c_g1", "/r", "a@b", "2026-06-17T10:00:00.000Z", "backfill commit one: land the checkpoint primitive"),
    gitFact("c_g2", "/r", "a@b", "2026-06-17T10:05:00.000Z", "backfill commit two: wire the incremental fold branch"),
    gitFact("c_g3", "/r", "a@b", "2026-06-17T10:10:00.000Z", "backfill commit three: add per-fact eviction on run"),
  ]);

  // Run 1 (cold) at now=T0 — thread + project both emit for /r-a@b.
  const r1 = await stepBoth(pair, "2026-06-17T18:00:00.000Z");
  const off1 = assertEquivalent(pair, "(c) run1");
  assert.equal(off1.size, 2, "(c) run1 emits 1 thread + 1 project rec");
  const coldThreadBytes = r1.onThread.bytes_scanned;
  const coldProjectBytes = r1.onProject.bytes_scanned;
  assert.ok(coldThreadBytes > 0 && coldProjectBytes > 0, "(c) cold scans read the ledger");

  // Run 2 (warm) at now=T0+2h — append a git-log fact with an OLD ts one day
  // earlier at the PHYSICAL TAIL. now=2026-06-17T20:00 → thread minTs=06-16T20:00,
  // so the old row (06-16T09:00) is < minTs → thread DROPS it (bucket unchanged →
  // no new thread rec). Project 7d window keeps it; same ISO week (W25) → the old
  // week bucket grows to 4 facts → project RE-EMITS with new content.
  appendBoth(pair, [
    gitFact("c_gold", "/r", "a@b", "2026-06-16T09:00:00.000Z", "backfilled OLD commit: retroactive audit of the prior day"),
  ]);
  const r2 = await stepBoth(pair, "2026-06-17T20:00:00.000Z");
  const off2 = assertEquivalent(pair, "(c) run2 backfill-old-ts");
  assert.equal(off2.size, 3, "(c) run2 adds exactly 1 project rec (thread drops the old row)");
  assert.equal(r2.offThread.reconstructed_emitted, 0, "(c) OFF thread drops the old-ts row");
  assert.equal(r2.onThread.reconstructed_emitted, 0, "(c) ON thread drops the old-ts row");
  assert.equal(r2.offProject.reconstructed_emitted, 1, "(c) OFF project re-emits with the old row folded");
  assert.equal(r2.onProject.reconstructed_emitted, 1, "(c) ON project re-emits with the old row folded");

  // COST PROOF (design.md §D-5.4 in-fixture): the warm run reads ONLY the newly
  // appended bytes — strictly fewer than the cold full scan. Flag-OFF surfaces
  // no such metric, so this is the flag-ON-only "fewer whole-ledger scans" proof.
  assert.ok(
    r2.onProject.bytes_scanned < coldProjectBytes,
    `(c) warm project delta (${r2.onProject.bytes_scanned}B) < cold full scan (${coldProjectBytes}B)`,
  );
  assert.ok(
    r2.onProject.bytes_scanned < statSync(pair.on).size,
    "(c) warm project delta ≪ whole-ledger size",
  );
});

// =============================================================================
// (d) EXCISE policy landing AFTER a derived child — parent-reject equivalence.
//     Run 1 emits recs; run 2 appends an active excise of a parent fact; the
//     re-emit attempt is rejected PARENT_EXCISED on BOTH paths (consumer ii,
//     §D-2.2) — no new rec, errors match, sig sets stay equal.
// =============================================================================
test("(d) excise-after-derive: both paths reject the re-emit identically", async () => {
  const pair = freshPair("d-excise");
  appendBoth(pair, [
    gitFact("d_g1", "/r", "a@b", "2026-06-17T10:00:00.000Z", "excise commit one: introduce the parent index module"),
    gitFact("d_g2", "/r", "a@b", "2026-06-17T10:05:00.000Z", "excise commit two: fold reverse-adjacency edges"),
    gitFact("d_g3", "/r", "a@b", "2026-06-17T10:10:00.000Z", "excise commit three: seed excise set from policy rows"),
  ]);
  const T = "2026-06-17T18:00:00.000Z";

  // Run 1 — thread + project emit for /r-a@b (deriving from d_g1,d_g2,d_g3).
  const r1 = await stepBoth(pair, T);
  const off1 = assertEquivalent(pair, "(d) run1");
  assert.equal(off1.size, 2, "(d) run1 emits 1 thread + 1 project rec");

  // Run 2 — append an ACTIVE excise policy targeting d_g1 (a parent), then
  // re-run. The re-emit now hits an excised parent → PARENT_EXCISED reject.
  appendBoth(pair, [excisePolicy("d_pex", "d_g1", T)]);
  const r2 = await stepBoth(pair, T);
  const off2 = assertEquivalent(pair, "(d) run2 excise");
  assert.equal(off2.size, 2, "(d) run2 emits nothing new (parent excised)");
  assert.equal(r2.offThread.reconstructed_emitted, 0, "(d) OFF thread no new emit");
  assert.equal(r2.onThread.reconstructed_emitted, 0, "(d) ON thread no new emit");
  // Parent-excised reject is counted as an aggregator error on BOTH paths.
  assert.equal(r2.offThread.errors, r2.onThread.errors, "(d) thread errors match OFF vs ON");
  assert.equal(r2.offProject.errors, r2.onProject.errors, "(d) project errors match OFF vs ON");
  assert.ok(r2.offThread.errors > 0, "(d) OFF thread saw the PARENT_EXCISED reject");
  assert.ok(r2.onThread.errors > 0, "(d) ON thread saw the PARENT_EXCISED reject");
});

// =============================================================================
// (e) ZERO-APPEND NO-OP — a re-run at the SAME now with no new rows is a pure
//     S5 idempotent re-fire on both paths (rejected_idempotent, nothing new).
// =============================================================================
test("(e) zero-append re-run is a no-op on both paths", async () => {
  const pair = freshPair("e-noop");
  appendBoth(pair, [
    imFact("e_im1", "chatE", "2026-06-17T10:00:00.000Z", "noop chat one: reviewing the incremental design doc"),
    imFact("e_im2", "chatE", "2026-06-17T10:05:00.000Z", "noop chat two: sanity-checking the window semantics"),
    imFact("e_im3", "chatE", "2026-06-17T10:10:00.000Z", "noop chat three: agreeing the checkpoint file layout"),
    gitFact("e_g1", "/r2", "c@d", "2026-06-17T10:00:00.000Z", "noop commit one: draft the equivalence test harness"),
    gitFact("e_g2", "/r2", "c@d", "2026-06-17T10:05:00.000Z", "noop commit two: register the new suites in run-all"),
  ]);
  const T = "2026-06-17T18:00:00.000Z";

  const r1 = await stepBoth(pair, T);
  const off1 = assertEquivalent(pair, "(e) run1");
  assert.equal(off1.size, 2, "(e) run1 emits 1 thread + 1 project rec");

  // Re-run at the SAME now with ZERO new appends — nothing new on either path.
  const r2 = await stepBoth(pair, T);
  const off2 = assertEquivalent(pair, "(e) run2 no-op");
  assert.deepEqual(sortedArr(off2), sortedArr(off1), "(e) sig set unchanged across the no-op re-run");
  assert.equal(r2.offThread.reconstructed_emitted, 0, "(e) OFF thread idempotent");
  assert.equal(r2.onThread.reconstructed_emitted, 0, "(e) ON thread idempotent");
  assert.equal(r2.offProject.reconstructed_emitted, 0, "(e) OFF project idempotent");
  assert.equal(r2.onProject.reconstructed_emitted, 0, "(e) ON project idempotent");
});

// =============================================================================
// (f) COLD RESTART across a persisted checkpoint WITH a future-ts row.
//     Proves the ONE-SIDED cold bootstrap (design.md §D-3.4 future-ts hole):
//     a fact whose ts is in the FUTURE at the first run must survive a restart
//     in state and enter the emit once `now` advances past it — exactly as a
//     full-rescan at that later `now` does. A two-sided bootstrap would have
//     permanently dropped it (the direct guard for that gap). Also proves the
//     persisted offset (near EOF) is NEVER used to skip the window on restart.
// =============================================================================
test("(f) cold restart + future-ts row: one-sided bootstrap retains it; offset ignored for window", async () => {
  const pair = freshPair("f-coldrestart");
  // g1,g2 in-window now; g_fut has a FUTURE ts (2026-06-19) relative to run1's
  // now (2026-06-17T12:00). All three are the SAME repo/author/ISO-week (W25).
  appendBoth(pair, [
    gitFact("f_g1", "/r", "a@b", "2026-06-17T10:00:00.000Z", "coldrestart commit one: persist the aggregator checkpoint"),
    gitFact("f_g2", "/r", "a@b", "2026-06-17T10:05:00.000Z", "coldrestart commit two: read resume offset on cold start"),
    gitFact("f_gfut", "/r", "a@b", "2026-06-19T10:00:00.000Z", "coldrestart FUTURE commit: dated ahead by clock skew / backfill"),
  ]);
  // The physical EOF AFTER the three fact appends but BEFORE any emit. The
  // incremental fold offset advances only to the pre-emit EOF (design.md §X-2),
  // so this is the value the checkpoint records — and it sits PAST g1,g2,g_fut,
  // so g1,g2 are BELOW it (the near-EOF offset the restart must NOT trust to
  // skip the window).
  const factsSize = statSync(pair.on).size;

  // --- Run 1 (cold ON) at now=T0=06-17T12:00 — g_fut is future → dropped at
  //     emit; project emits P1 from {g1,g2}. Persist the checkpoint (WIRE role).
  const r1 = await stepBoth(pair, "2026-06-17T12:00:00.000Z");
  const off1 = assertEquivalent(pair, "(f) run1");
  assert.equal(off1.size, 1, "(f) run1 emits exactly 1 project rec (g_fut excluded, thread below MIN)");
  // The returned checkpoint offset is the PRE-EMIT EOF = factsSize, PAST g1,g2.
  assert.equal(r1.onProject.checkpoint_offset, factsSize, "(f) project checkpoint offset = pre-emit EOF (past g1,g2,g_fut)");
  assert.ok(r1.onProject.checkpoint_offset > 0, "(f) checkpoint offset is non-trivial (near EOF)");
  // Persist the ON checkpoints at their returned safe-resume offsets,
  // fingerprinted to the ON ledger — simulating WIRE's emit-before-persist.
  const onStat = statSync(pair.on);
  assert.equal(
    writeCheckpoint(pair.projectCp, r1.onProject.checkpoint_offset, {
      aggregator: "project",
      ino: onStat.ino,
      ledgerSize: onStat.size,
    }),
    true,
    "(f) project checkpoint persisted",
  );
  writeCheckpoint(pair.threadCp, r1.onThread.checkpoint_offset, {
    aggregator: "thread",
    ino: onStat.ino,
    ledgerSize: onStat.size,
  });
  const cpRec = readCheckpointRecord(pair.projectCp);
  assert.ok(cpRec && Number(cpRec.last_offset) === factsSize, "(f) persisted checkpoint offset sits past g1,g2 (near EOF)");

  // --- RESTART: drop the in-process state but KEEP the checkpoint on disk. The
  //     next ON run is a cold bootstrap whose resume_offset is near EOF.
  threadInternal.resetIncrementalStateForTest();
  projectInternal.resetIncrementalStateForTest();
  _resetParentIndexCache();

  // --- Run 2 (cold bootstrap after restart) at now=T0+1h=06-18T12:00 — STILL
  //     before g_fut (06-19). The one-sided bootstrap must retain g_fut in
  //     state even though it is future; emit still excludes it (ceiling). No new
  //     rec. resume_offset reflects the near-EOF checkpoint (offset NOT used to
  //     skip the window — g1,g2 below it are rescanned).
  const r2 = await stepBoth(pair, "2026-06-18T12:00:00.000Z");
  const off2 = assertEquivalent(pair, "(f) run2 cold-bootstrap");
  assert.equal(off2.size, 1, "(f) run2 emits nothing new (g_fut still future)");
  assert.ok(
    r2.onProject.resume_offset === factsSize,
    `(f) cold bootstrap read the near-EOF persisted offset (${r2.onProject.resume_offset}, past g1,g2) but rescanned the window anyway`,
  );
  // The one-sided bootstrap RETAINED the future-ts fact in state across restart.
  const st2 = projectInternal.getIncrementalStateForTest(pair.on);
  assert.ok(st2 && st2.buckets.size === 1, "(f) project state rebuilt with the W25 bucket");
  const bucket = [...st2.buckets.values()][0];
  assert.ok(bucket.facts.has("f_gfut"), "(f) ONE-SIDED bootstrap retained the future-ts fact across restart");
  assert.equal(bucket.facts.size, 3, "(f) state holds g1,g2,g_fut (future-ts included)");

  // --- Run 3 (warm, NO restart) at now=06-20T12:00 — past g_fut. Warm fold
  //     reads nothing new; g_fut (retained one-sided) now enters the window →
  //     project re-emits P2 with 3 facts. A two-sided bootstrap at run 2 would
  //     have dropped g_fut → this warm run would emit NOTHING → divergence.
  const r3 = await stepBoth(pair, "2026-06-20T12:00:00.000Z");
  const off3 = assertEquivalent(pair, "(f) run3 future-ts enters window");
  assert.equal(off3.size, 2, "(f) run3 adds the 3-fact project rec (future-ts folded)");
  assert.equal(r3.offProject.reconstructed_emitted, 1, "(f) OFF project emits the future-ts-included rec");
  assert.equal(r3.onProject.reconstructed_emitted, 1, "(f) ON project emits the future-ts-included rec");
});

// =============================================================================
// (g) TORN TAIL — an un-terminated mid-append line must NOT advance the fold
//     offset and must be folded EXACTLY ONCE when its "\n" lands, so that once
//     the ledger is TERMINATED again flag-ON == flag-OFF.
//
//     SCOPE NOTE (real asymmetry, deliberately isolated): the flag-OFF path
//     scans via streamLedgerLines, which — unlike the incremental fold's
//     streamLedgerLinesWithOffset (terminated===true only) — INCLUDES a final
//     line that is valid JSON but missing its "\n". So during the brief window a
//     complete-but-unterminated line sits at physical EOF, the two paths DO
//     differ (OFF reads it, the fold defers it), and running the OFF aggregator
//     then would append its emit directly onto the un-terminated bytes and
//     corrupt the row. The arc guarantees equivalence at TERMINATED ledger
//     states (the steady state the daemon actually re-reads); this fixture
//     therefore observes the fold's deferral in isolation while the tail is
//     torn (ON only) and asserts full OFF==ON equivalence once it completes.
// =============================================================================
test("(g) torn tail: fold defers the incomplete line, folds it exactly once, OFF==ON once terminated", async () => {
  const pair = freshPair("g-torn");
  // Warm state first (clean cold run over 2 project facts) — TERMINATED ledger.
  appendBoth(pair, [
    gitFact("g_g1", "/r", "a@b", "2026-06-17T10:00:00.000Z", "torn commit one: baseline before the mid-append tear"),
    gitFact("g_g2", "/r", "a@b", "2026-06-17T10:05:00.000Z", "torn commit two: second baseline row for the bucket"),
  ]);
  const T = "2026-06-17T18:00:00.000Z";
  await stepBoth(pair, T);
  const off1 = assertEquivalent(pair, "(g) run1 terminated");
  assert.equal(off1.size, 1, "(g) run1 emits 1 project rec (2 facts)");

  // The physical EOF right BEFORE the torn append == where the torn line starts.
  const tornLineStart = statSync(pair.on).size;

  // Append a TORN third fact — valid JSON WITHOUT the trailing "\n" (daemon
  // caught mid-append). Run ONLY the ON fold here: it must DEFER the torn line
  // (terminated===false) — NOT fold it and NOT advance the offset INTO it. (The
  // fold DOES advance past any earlier terminated non-fact lines — e.g. the P1
  // recon appended by run1's emit — which is correct, design.md §X-2.)
  const g3 = gitFact("g_g3", "/r", "a@b", "2026-06-17T10:10:00.000Z", "torn commit three: the line that lands half-written first");
  appendRawBoth(pair, JSON.stringify(g3)); // NO newline — torn
  const onTornProject = await runProject(pair.on, { now: T, incremental: true, checkpointPath: pair.projectCp });
  assert.equal(onTornProject.reconstructed_emitted, 0, "(g) ON project defers the torn line (no new emit)");
  const stTorn = projectInternal.getIncrementalStateForTest(pair.on);
  const bucketTorn = [...stTorn.buckets.values()][0];
  assert.equal(bucketTorn.facts.size, 2, "(g) torn line NOT folded (bucket still 2 facts)");
  assert.ok(!bucketTorn.facts.has("g_g3"), "(g) g_g3 absent from state while torn");
  assert.equal(stTorn.offset, tornLineStart, "(g) fold offset stops AT the torn line start (never advances into it)");

  // Complete the torn line ("\n") AND append a fourth fact → TERMINATED again.
  // Now run BOTH paths over the terminated ledger: g_g3 folds EXACTLY ONCE, and
  // OFF (full rescan) == ON (warm fold [offset, EOF)).
  const g4 = gitFact("g_g4", "/r", "a@b", "2026-06-17T10:15:00.000Z", "torn commit four: appended after the tear is completed");
  appendRawBoth(pair, "\n" + JSON.stringify(g4) + "\n");
  const r3 = await stepBoth(pair, T);
  const off3 = assertEquivalent(pair, "(g) run3 terminated after completion");
  // P1 (2-fact project) + a 4-fact project rec + a 4-fact thread rec (the git
  // bucket now clears MIN_FACTS_PER_THREAD=3) = 3 distinct sig rows.
  assert.equal(off3.size, 3, "(g) completion re-emits 4-fact project + 4-fact thread");
  assert.equal(r3.offProject.reconstructed_emitted, 1, "(g) OFF project re-emits once");
  assert.equal(r3.onProject.reconstructed_emitted, 1, "(g) ON project re-emits once");
  assert.equal(r3.offThread.reconstructed_emitted, 1, "(g) OFF thread emits the now-4-fact bucket");
  assert.equal(r3.onThread.reconstructed_emitted, 1, "(g) ON thread emits the now-4-fact bucket");
  // g_g3 folded exactly once → bucket holds exactly 4 distinct facts.
  const st = projectInternal.getIncrementalStateForTest(pair.on);
  const bucket = [...st.buckets.values()][0];
  assert.equal(bucket.facts.size, 4, "(g) g_g3 folded exactly once (4 distinct facts, no double-count)");
});

// =============================================================================
// (h) CHECKPOINT SELF-HEAL — truncate+rewrite BOTH ledgers SMALLER than the ON
//     path's working offset (offset > size). The incremental path must detect
//     offset>size, reset to 0, and re-fold from scratch == full-rescan.
// =============================================================================
test("(h) self-heal on shrink: offset>size resets to 0 and re-folds == full rescan", async () => {
  const pair = freshPair("h-selfheal");
  appendBoth(pair, [
    imFact("h_im1", "chatH", "2026-06-17T10:00:00.000Z", "selfheal chat one: original larger ledger content row"),
    imFact("h_im2", "chatH", "2026-06-17T10:05:00.000Z", "selfheal chat two: second original row before the shrink"),
    imFact("h_im3", "chatH", "2026-06-17T10:10:00.000Z", "selfheal chat three: third original row before the shrink"),
    gitFact("h_g1", "/r3", "e@f", "2026-06-17T10:00:00.000Z", "selfheal commit one: original project row before shrink"),
    gitFact("h_g2", "/r3", "e@f", "2026-06-17T10:05:00.000Z", "selfheal commit two: original project row two before shrink"),
  ]);
  const T = "2026-06-17T18:00:00.000Z";
  const r1 = await stepBoth(pair, T);
  const off1 = assertEquivalent(pair, "(h) run1");
  assert.equal(off1.size, 2, "(h) run1 emits 1 thread + 1 project rec");
  const onOffset1 = threadInternal.getIncrementalStateForTest(pair.on).offset;
  assert.ok(onOffset1 > 0, "(h) ON thread advanced its offset on the cold run");

  // Truncate + REWRITE both ledgers to a SMALLER, DIFFERENT content whose size
  // is below the ON path's working offset → offset > size self-heal trip.
  rewriteBoth(pair, [
    imFact("h_new1", "chatH2", "2026-06-17T11:00:00.000Z", "rebuilt chat one: smaller compacted ledger after rewrite"),
    imFact("h_new2", "chatH2", "2026-06-17T11:05:00.000Z", "rebuilt chat two: second row of the smaller compacted ledger"),
    imFact("h_new3", "chatH2", "2026-06-17T11:10:00.000Z", "rebuilt chat three: third row of the smaller compacted ledger"),
  ]);
  const newSize = statSync(pair.on).size;
  assert.ok(newSize < onOffset1, "(h) rewritten ledger is smaller than the persisted working offset");

  const r2 = await stepBoth(pair, T);
  const off2 = assertEquivalent(pair, "(h) run2 self-heal");
  // The old recs remain physically on the OFF/ON ledgers? No — the rewrite
  // REPLACED the file, so only the rebuilt content + its fresh emits remain.
  // Both paths must produce the SAME rebuilt set: 1 thread rec for chatH2.
  assert.equal(off2.size, 1, "(h) rebuilt ledger yields exactly the fresh thread rec");
  assert.equal(r2.offThread.reconstructed_emitted, 1, "(h) OFF re-emits over the rebuilt ledger");
  assert.equal(r2.onThread.reconstructed_emitted, 1, "(h) ON re-emits over the rebuilt ledger");
  // Self-heal: the ON offset was reset to 0 then re-advanced to the new size.
  const onOffset2 = threadInternal.getIncrementalStateForTest(pair.on).offset;
  assert.equal(onOffset2, newSize, "(h) ON offset self-healed: reset to 0 then re-advanced to the new EOF");
});

// =============================================================================
// (i) RECONCILIATION SUBSTITUTE — the ONLY deterministic route to NON-EMPTY
//     contradicts[]/resolution + a reconcile.substitute policy row is the
//     agent-mode intra-conversation refinement (daemon reconstructions carry no
//     valence/embedding and a null conversation_id, so they cannot fire the
//     sibling/parent/cosine tests). This drives the emitter's flag-OFF vs
//     flag-ON path (ctx.useParentIndex) over the SAME seeded ledger and asserts
//     the §D-5.1 FULL key (incl. contradicts/resolution/reconcile.*) is equal —
//     the byId-order + narrow-reverseAdj machinery of §D-2.5.
// =============================================================================
test("(i) reconciliation substitute: contradicts/resolution/reconcile.* equal flag-OFF vs flag-ON", async () => {
  const pair = freshPair("i-substitute");
  const TS = "2026-06-17T00:00:00.000Z";
  const seed = [
    // Parent fact with first-party consent so the emit is admitted.
    {
      id: "i_fact_p",
      ts: TS,
      kind: "fact",
      content: "shared parent fact for the intra-conversation refinement",
      source: "imessage",
      source_refs: [{ source: "imessage", source_msg_id: "imsg_p", via: "original", consent_basis: "first_party" }],
      derived_from: [],
    },
    // Earlier, lower-confidence reconstructed sibling in conversation conv-sub.
    {
      id: "i_rec_sib",
      ts: TS,
      kind: "reconstructed",
      derived_from: ["i_fact_p"],
      content: "earlier lower-confidence reconstruction of the same topic",
      scope: "cross_session",
      idempotency_key: "i-seed-sib-key",
      provenance: { agent_id: "claude-code:conv-sub", conversation_id: "conv-sub", confidence: 0.6 },
    },
  ];
  const seedText = seed.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(pair.off, seedText, { mode: 0o600 });
  writeFileSync(pair.on, seedText, { mode: 0o600 });

  const content = "Refined higher-confidence reconstruction that supersedes the earlier sibling.";
  const parents = ["i_fact_p"];
  const conversation_id = "conv-sub";
  const scope = "cross_session";
  function mintAgentToken() {
    const bindingObject = {
      content_hash: createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex"),
      parent_set_hash: canonicalJsonSha256Hex([...parents].sort()),
      conversation_id,
      scope,
    };
    return mintToken(canonicalJsonSha256Hex(bindingObject), RECONSTRUCT_TOKEN_TYPE, SIGNING_KEY, {}).token;
  }
  const baseInput = { mode: "agent", content, parents, scope, conversation_id, confidence: 0.95 };
  // Lockstep ulid factories (fresh per path, same seed) so the new rec id — which
  // is REFERENCED by contradicts/targets/payload — is identical OFF vs ON.
  const now = () => "2026-07-01T00:00:00.000Z";

  const resOff = await emitReconstruction(
    { ...baseInput, token: mintAgentToken() },
    { ledgerPath: pair.off, now, ulid: ulidFactory("rec") },
  );
  const resOn = await emitReconstruction(
    { ...baseInput, token: mintAgentToken() },
    { ledgerPath: pair.on, useParentIndex: true, now, ulid: ulidFactory("rec") },
  );

  assert.equal(resOff.ok, true, "(i) flag-OFF substitute emit succeeded");
  assert.equal(resOn.ok, true, "(i) flag-ON substitute emit succeeded");
  assert.equal(resOff.resolution, "substitute", "(i) resolution is substitute (non-empty)");
  assert.deepEqual(resOff.contradicts, ["i_rec_sib"], "(i) contradicts is non-empty (the sibling)");
  assert.deepEqual(resOn.resolution, resOff.resolution, "(i) resolution equal OFF vs ON");
  assert.deepEqual(resOn.contradicts, resOff.contradicts, "(i) contradicts equal OFF vs ON");

  // The FULL §D-5.1 key (reconstructed with contradicts/resolution + the
  // reconcile.substitute policy row) is deep-equal across the two paths.
  const off = assertEquivalent(pair, "(i) substitute full-key");
  // Sanity: the set actually contains a reconcile.substitute policy row and a
  // reconstructed row whose resolution is substitute (non-vacuous key coverage).
  const arr = sortedArr(off);
  assert.ok(
    arr.some((s) => s.includes('"policy_kind":"reconcile.substitute"')),
    "(i) sig set contains the reconcile.substitute policy row",
  );
  assert.ok(
    arr.some((s) => s.includes('"resolution":"substitute"')),
    "(i) sig set contains a reconstructed row stamped resolution=substitute",
  );
  assert.ok(
    arr.some((s) => s.includes('"contradicts":["i_rec_sib"]')),
    "(i) sig set contains the non-empty contradicts stamp",
  );
});

// =============================================================================
// (j) THREAD COLD RESTART + future-ts row — the symmetric twin of (f) for the
//     THREAD aggregator (24h window / UTC-day bucket / imessage chat thread key).
//
//     Proves the ONE-SIDED cold bootstrap AND the emit-time ceiling on the THREAD
//     side. thread-aggregator.js buildTransientEmitMap keeps only facts with
//     `factMs >= minTs && factMs <= nowEpoch` (design.md §D-3.3); the upper bound
//     drops a future-ts fact THIS run exactly as the flag-OFF full-rescan's
//     two-sided streamLedgerRowsInTimeWindow ceiling does. Fixture (f) exercises
//     this ceiling for the PROJECT aggregator; without (j), mutating/removing the
//     THREAD `<= nowEpoch` bound leaves the whole suite GREEN — a real thread-side
//     divergence (flag-ON emitting a future-ts fact the flag-OFF rescan withholds)
//     would ship uncaught.
//
//     im1,im2,im3 are in-window at run 1 (chatFT, UTC day 2026-06-17); im_fut has
//     a FUTURE ts (20:00) relative to run 1's now (12:00). All four share the SAME
//     chat + UTC-day bucket. thread MIN=3, so the 3 in-window facts emit T1 while
//     im_fut is withheld at the ceiling. After a RESTART (drop in-process state,
//     KEEP the persisted checkpoint) the one-sided bootstrap must RETAIN im_fut in
//     state (a two-sided bootstrap would drop it forever — it sits before the
//     near-EOF checkpoint offset). Finally, as `now` advances PAST im_fut, a WARM
//     tick folds it into the window and both paths re-emit T2 with 4 facts.
// =============================================================================
test("(j) thread cold restart + future-ts row: emit ceiling + one-sided bootstrap equal flag-OFF vs flag-ON", async () => {
  const pair = freshPair("j-thread-coldrestart");
  // im1,im2,im3 in-window at run 1's now; im_fut dated ahead (20:00) — all in the
  // SAME imessage chat (chatFT) and SAME UTC day (2026-06-17) → one day bucket.
  appendBoth(pair, [
    imFact("j_im1", "chatFT", "2026-06-17T10:00:00.000Z", "thread coldrestart one: kicking off the sprint retro thread"),
    imFact("j_im2", "chatFT", "2026-06-17T10:05:00.000Z", "thread coldrestart two: capturing the action items agreed"),
    imFact("j_im3", "chatFT", "2026-06-17T10:10:00.000Z", "thread coldrestart three: confirming owners for each item"),
    imFact("j_imfut", "chatFT", "2026-06-17T20:00:00.000Z", "thread coldrestart FUTURE msg: dated ahead by clock skew / backfill"),
  ]);
  // Physical EOF AFTER the four fact appends but BEFORE any emit. The cold-start
  // fold offset advances only to the pre-emit EOF (design.md §X-2), so this is the
  // checkpoint value — and it sits PAST all four facts (near EOF), the offset the
  // restart must NOT trust to skip the window.
  const factsSize = statSync(pair.on).size;

  // --- Run 1 (cold ON) at now=T0=06-17T12:00 — im_fut(20:00) is FUTURE → withheld
  //     at the emit ceiling; the 3 in-window facts clear MIN=3 → thread emits T1.
  const r1 = await stepBoth(pair, "2026-06-17T12:00:00.000Z");
  const off1 = assertEquivalent(pair, "(j) run1");
  assert.equal(off1.size, 1, "(j) run1 emits exactly 1 thread rec (im_fut withheld by ceiling)");
  assert.equal(r1.offThread.reconstructed_emitted, 1, "(j) OFF thread emits the 3-fact rec");
  assert.equal(r1.onThread.reconstructed_emitted, 1, "(j) ON thread emits the 3-fact rec");
  // The returned checkpoint offset is the PRE-EMIT EOF = factsSize, PAST all facts.
  assert.equal(r1.onThread.checkpoint_offset, factsSize, "(j) thread checkpoint offset = pre-emit EOF (past im1..im_fut)");
  assert.ok(r1.onThread.checkpoint_offset > 0, "(j) checkpoint offset is non-trivial (near EOF)");

  // Persist the ON thread checkpoint at its returned safe-resume offset,
  // fingerprinted to the ON ledger — simulating WIRE's emit-before-persist.
  const onStat = statSync(pair.on);
  assert.equal(
    writeCheckpoint(pair.threadCp, r1.onThread.checkpoint_offset, {
      aggregator: "thread",
      ino: onStat.ino,
      ledgerSize: onStat.size,
    }),
    true,
    "(j) thread checkpoint persisted",
  );
  const cpRec = readCheckpointRecord(pair.threadCp);
  assert.ok(cpRec && Number(cpRec.last_offset) === factsSize, "(j) persisted checkpoint offset sits past the facts (near EOF)");

  // --- RESTART: drop the in-process state but KEEP the checkpoint on disk. The
  //     next ON run is a cold bootstrap whose resume_offset is near EOF.
  threadInternal.resetIncrementalStateForTest();
  projectInternal.resetIncrementalStateForTest();
  _resetParentIndexCache();

  // --- Run 2 (cold bootstrap after restart) at now=T0+6h=06-17T18:00 — STILL
  //     before im_fut(20:00). The one-sided bootstrap must retain im_fut in state
  //     even though it is future; the emit ceiling still excludes it → the 3-fact
  //     content re-derives to T1's key → S5 idempotent, no new rec. resume_offset
  //     reflects the near-EOF checkpoint (offset NOT used to skip the window).
  const r2 = await stepBoth(pair, "2026-06-17T18:00:00.000Z");
  const off2 = assertEquivalent(pair, "(j) run2 cold-bootstrap");
  assert.equal(off2.size, 1, "(j) run2 emits nothing new (im_fut still future; 3-fact rec idempotent)");
  assert.equal(r2.onThread.reconstructed_emitted, 0, "(j) ON thread idempotent after restart");
  assert.equal(r2.offThread.reconstructed_emitted, 0, "(j) OFF thread idempotent");
  assert.ok(
    r2.onThread.resume_offset === factsSize,
    `(j) cold bootstrap read the near-EOF persisted offset (${r2.onThread.resume_offset}, past the facts) but rescanned the window anyway`,
  );
  // The one-sided bootstrap RETAINED the future-ts fact in state across restart.
  const st2 = threadInternal.getIncrementalStateForTest(pair.on);
  assert.ok(st2 && st2.buckets.size === 1, "(j) thread state rebuilt with the single chatFT day bucket");
  const bucket = [...st2.buckets.values()][0];
  assert.ok(bucket.facts.has("j_imfut"), "(j) ONE-SIDED bootstrap retained the future-ts fact across restart");
  assert.equal(bucket.facts.size, 4, "(j) state holds im1,im2,im3,im_fut (future-ts included)");

  // --- Run 3 (warm, NO restart) at now=06-17T21:00 — PAST im_fut(20:00). The warm
  //     fold reads nothing new; im_fut (retained one-sided) now clears the emit
  //     ceiling → both paths re-emit T2 with 4 facts. Removing the THREAD ceiling
  //     (`<= nowEpoch`) would have made flag-ON emit the 4-fact rec at run 1/run 2
  //     (im_fut still future) while flag-OFF's two-sided rescan withheld it →
  //     divergence caught at its origin.
  const r3 = await stepBoth(pair, "2026-06-17T21:00:00.000Z");
  const off3 = assertEquivalent(pair, "(j) run3 future-ts enters window");
  assert.equal(off3.size, 2, "(j) run3 adds the 4-fact thread rec (future-ts folded)");
  assert.equal(r3.offThread.reconstructed_emitted, 1, "(j) OFF thread emits the future-ts-included rec");
  assert.equal(r3.onThread.reconstructed_emitted, 1, "(j) ON thread emits the future-ts-included rec");
});

// =============================================================================
// (k) PROJECT INODE-CHANGE SELF-HEAL — a warm flag-ON project state whose ledger
//     is REPLACED under a NEW inode (renameSync a freshly-written file over the
//     path) at a size >= the working offset, so the ORTHOGONAL offset>size
//     shrink-heal (fixture (h)) does NOT fire — the inode path is isolated.
//
//     The replacement ledger carries a DIFFERENT project bucket (/rK2) whose facts
//     sit BELOW the old working offset, followed by an inert padding row that
//     pushes the new size to >= that offset. A naive warm fold reading only
//     [state.offset, EOF) would land entirely in the padding, MISS the /rK2 facts,
//     and keep the STALE /rK bucket in state → flag-ON diverges from the flag-OFF
//     full rescan (which sees only /rK2). The warm tick must instead detect the
//     inode change (state.ino !== ledgerIno), drop the stale state, cold-rescan the
//     whole new ledger, and emit the IDENTICAL reconstructed set as flag-OFF.
//
//     This is the PROJECT twin of thread-aggregator.js's inode self-heal. The final
//     review probe-proved that WITHOUT the project guard's `state.ino !== ledgerIno`
//     disjunct a non-shrinking new-inode rewrite makes flag-ON project diverge from
//     flag-OFF; this fixture locks that guard in.
// =============================================================================
test("(k) project inode-change self-heal: new-inode rewrite at size>=offset cold-rescans == full rescan", async () => {
  const pair = freshPair("k-inode");
  const T = "2026-06-17T18:00:00.000Z";
  // Initial ledger — 2 git facts for /rK (author ka@kb), same ISO week, in window.
  // 2 >= MIN_FACTS_PER_PROJECT so project emits; 2 < MIN_FACTS_PER_THREAD (3) so
  // thread stays silent → the sig set is exactly one project rec.
  appendBoth(pair, [
    gitFact("k_g1", "/rK", "ka@kb", "2026-06-17T10:00:00.000Z", "inode commit one: original bucket before the inode-changing rewrite"),
    gitFact("k_g2", "/rK", "ka@kb", "2026-06-17T10:05:00.000Z", "inode commit two: second original-bucket row before the rewrite"),
  ]);

  // Run 1 (cold ON) — folds /rK, emits P1. Run 2 (warm, zero-append) — advances the
  // fold offset PAST run 1's emitted rec rows to the full physical EOF and leaves
  // the state genuinely WARM (offset advanced, /rK bucket resident, inode tracked).
  const r1 = await stepBoth(pair, T);
  const off1 = assertEquivalent(pair, "(k) run1 cold");
  assert.equal(off1.size, 1, "(k) run1 emits exactly 1 project rec for /rK");
  assert.equal(r1.onProject.reconstructed_emitted, 1, "(k) ON project emits P1");

  const r2 = await stepBoth(pair, T);
  assertEquivalent(pair, "(k) run2 warm no-op");
  assert.equal(r2.onProject.reconstructed_emitted, 0, "(k) warm re-run is idempotent (offset advances, no new emit)");

  const stWarm = projectInternal.getIncrementalStateForTest(pair.on);
  assert.ok(stWarm, "(k) ON project state resident after the warm tick");
  const workingOffset = stWarm.offset;
  const warmIno = stWarm.ino;
  assert.ok(workingOffset > 0, "(k) warm working offset advanced");
  assert.ok(warmIno != null, "(k) warm state tracked the ledger inode");
  assert.ok(
    [...stWarm.buckets.keys()].some((bk) => bk.includes("/rK") && !bk.includes("/rK2")),
    "(k) warm state holds the original /rK bucket",
  );

  // Build the REPLACEMENT ledger. The 2 /rK2 facts sit at the TOP (below the old
  // working offset); an inert padding row (kind!=fact → skipped by every aggregator
  // and by sigSet) fills the tail so the new size is >= the working offset.
  const newFacts = [
    gitFact("k_n1", "/rK2", "kc@kd", "2026-06-17T11:00:00.000Z", "inode rewrite commit one: NEW bucket below the old working offset"),
    gitFact("k_n2", "/rK2", "kc@kd", "2026-06-17T11:05:00.000Z", "inode rewrite commit two: second NEW-bucket row below the old offset"),
  ];
  const factsText = newFacts.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const factsByteLen = Buffer.byteLength(factsText, "utf8");
  assert.ok(
    factsByteLen <= workingOffset,
    `(k) the NEW facts (${factsByteLen}B) sit BELOW the old working offset (${workingOffset}B) so a naive warm fold [offset,EOF) misses them`,
  );
  // Size the padding so the total new ledger is >= the working offset → the
  // offset>size shrink-heal CANNOT fire, isolating the inode path.
  const padBase = JSON.stringify({ id: "k_pad", kind: "padding", ts: T, blob: "" });
  const padBaseBytes = Buffer.byteLength(padBase + "\n", "utf8");
  const padBlobLen = Math.max(0, workingOffset - factsByteLen - padBaseBytes) + 64;
  const padRow = { id: "k_pad", kind: "padding", ts: T, blob: "p".repeat(padBlobLen) };
  const newText = factsText + JSON.stringify(padRow) + "\n";

  renameOverBoth(pair, newText);
  const newStat = statSync(pair.on);
  const newSize = newStat.size;
  const newIno = newStat.ino;
  assert.ok(newSize >= workingOffset, "(k) new ledger size >= working offset (offset>size shrink-heal cannot fire)");
  assert.notEqual(newIno, warmIno, "(k) rename installed a NEW inode over the ledger path");

  // Refresh the emitter's parent index (design.md §D-2.6) at the ledger-identity
  // change — same discipline freshPair/(f)/(j) apply. _parent-index.js keys its
  // cache on ledger SIZE + mtime (self-heals on shrink / mtime-regression), NOT on
  // inode, so a non-shrinking new-inode rewrite would leave it stale and reject the
  // /rK2 emit on parent-lookup for reasons ORTHOGONAL to the aggregator's state
  // guard. Resetting it here does NOT touch the project aggregator's in-process
  // window state (still warm) — the inode-change self-heal under test is genuinely
  // exercised; this only removes the unrelated PIDX confound so the assertion
  // localizes to the project-aggregator guard.
  _resetParentIndexCache();

  // Warm flag-ON tick over the new-inode ledger. The inode-change disjunct must
  // drop the stale state and cold-rescan the whole new ledger → emit P2 for /rK2,
  // IDENTICAL to the flag-OFF full rescan. Without the disjunct: no self-heal → the
  // warm fold reads only padding, keeps the stale /rK bucket, never folds /rK2 →
  // flag-ON lacks the /rK2 rec that flag-OFF emits → divergence caught HERE.
  const r3 = await stepBoth(pair, T);
  const off3 = assertEquivalent(pair, "(k) run3 inode self-heal");
  assert.equal(off3.size, 1, "(k) new ledger yields exactly the /rK2 project rec");
  assert.equal(r3.offProject.reconstructed_emitted, 1, "(k) OFF project re-emits over the new ledger");
  assert.equal(r3.onProject.reconstructed_emitted, 1, "(k) ON project self-healed and re-emitted");
  // The sole rec derives from the NEW facts (k_n1,k_n2), NOT the stale /rK facts.
  const arr3 = sortedArr(off3);
  assert.ok(
    arr3.some((s) => s.includes("k_n1") && s.includes("k_n2")),
    "(k) the emitted rec derives from the NEW /rK2 facts (k_n1,k_n2)",
  );
  assert.ok(
    !arr3.some((s) => s.includes("k_g1")),
    "(k) no stale rec deriving from the original /rK facts (k_g1)",
  );

  // Self-heal proof on the ON state: inode change → cold rescan of the whole new
  // ledger. Offset re-anchored to the new size; inode refreshed; only /rK2 resident.
  const stHealed = projectInternal.getIncrementalStateForTest(pair.on);
  assert.ok(stHealed, "(k) ON project state present after self-heal");
  assert.equal(stHealed.offset, newSize, "(k) offset re-anchored to the new EOF (cold rescan)");
  assert.equal(stHealed.ino, newIno, "(k) tracked inode refreshed to the new inode");
  assert.equal(r3.onProject.bytes_scanned, newSize, "(k) cold rescan read the whole new ledger");
  assert.ok(
    [...stHealed.buckets.keys()].some((bk) => bk.includes("/rK2")),
    "(k) healed state folded the NEW /rK2 bucket",
  );
  assert.ok(
    ![...stHealed.buckets.keys()].some((bk) => bk.includes("/rK") && !bk.includes("/rK2")),
    "(k) stale /rK bucket dropped by the self-heal reset",
  );
});
